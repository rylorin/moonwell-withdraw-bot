#!/usr/bin/env node
/**
 * Moonwell (Base) USDC withdrawal bot — CHUNKED VERSION (TypeScript)
 * Converted from JS to TS with strict types, interfaces, and injected dependencies.
 */
import { ethers } from "ethers";
import "dotenv/config";
import {
  Config,
  DEFAULT_GAS_TIERS,
  DEFAULT_MUSDC_ADDRESS,
  DEFAULT_PRIVATE_KEY_PLACEHOLDER,
  DEFAULT_READ_RPC_URL,
  DEFAULT_WSS_PLACEHOLDER,
  loadConfig,
  USDC_DECIMALS,
} from "./config";
import { GasTier } from "./types";
import { createLogger, logger } from "./logger";
import {
  checkPlaceholders,
  createBalanceWiring,
  fmt,
  getGasForChunk,
  getTxStatus,
  logStartupParameters,
  maskUrl,
  parseAmount,
  withTimeout,
} from "./utils";
import { BalanceMonitor, createBalanceMonitor } from "./balanceMonitor";
import { createWssWatchdog } from "./watchdog";
import { createChunkRunner, computeChunk } from "./chunkRunner";

const HEALTH_CHECK_MS = 5_000;

const MTOKEN_ABI = [
  "function getCash() view returns (uint256)",
  "function balanceOfUnderlying(address owner) returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "event Failure(uint256 errorCode, uint256 info, uint256 detail)",
];

interface ShutdownHandlerDeps {
  log?: Console;
  processExit?: (code?: number) => void;
  stops: (() => void)[];
  destroyers: (() => Promise<void>)[];
  registerSignals?: boolean;
  signalOn?: (sig: NodeJS.Signals, fn: () => void) => void;
}
function createShutdownHandler({
  log = console,
  processExit = process.exit,
  stops = [],
  destroyers = [],
  registerSignals = true,
  signalOn = (sig, fn) => process.on(sig, fn),
}: ShutdownHandlerDeps) {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    try {
      log.log("⏹️  Stopping background jobs...");
      for (const s of stops) {
        try {
          s();
        } catch {}
      }
      log.log("🔌 Closing network connections...");
      for (const d of destroyers) {
        await (typeof d === "function" ? d() : d);
      }
      log.log("✅ Graceful shutdown complete");
      processExit(0);
    } catch (err) {
      log.error("❌ Error during shutdown:", err);
      processExit(1);
    }
  };
  if (registerSignals) {
    signalOn("SIGINT", () => shutdown("SIGINT"));
    signalOn("SIGTERM", () => shutdown("SIGTERM"));
  }
  return shutdown;
}

// ---------- Entry point ----------

async function main() {
  const config = loadConfig(process.env);
  const missing = checkPlaceholders(config);
  if (missing.length > 0) {
    throw new Error(
      `Config manquante: ${missing.join(", ")}. Définissez-les dans votre environnement ou le fichier .env.`,
    );
  }
  function buildWss() {
    const p = new ethers.WebSocketProvider(config.wssUrl);
    let pws = null;
    try {
      pws = (p as any).websocket;
    } catch {
      pws = null;
    }
    (pws as any)?.on?.("error", (err: unknown) => {
      console.warn(
        `[wss] Connexion impossible (${maskUrl(config.wssUrl)}): ${err instanceof Error ? err.message : err}`,
      );
    });
    const w = new ethers.Wallet(config.privateKey, p);
    const m = new ethers.Contract(config.mUsdcAddress, MTOKEN_ABI, w);
    return { provider: p, wallet: w, mUsdc: m };
  }
  const subscribe = (p: ethers.Provider) => {
    p.on("block", attemptChunk);
  };
  let { provider, wallet, mUsdc } = buildWss();
  const readProvider = new ethers.JsonRpcProvider(config.readRpcUrl);
  (readProvider as any).on?.("error", (err: unknown) => {
    console.warn(
      `[readRpc] Read RPC error (${(err as Error).message || err}) — getCash() will fall back to the WSS provider.`,
    );
  });
  const mUsdcRead = new ethers.Contract(
    config.mUsdcAddress,
    MTOKEN_ABI,
    readProvider,
  );
  logStartupParameters(config, { walletAddress: wallet.address });
  const startingBalanceRaw = await mUsdc.balanceOfUnderlying.staticCall(
    wallet.address,
  );
  let lpTokenDecimals: number | undefined;
  let lpBalanceDisplay = "";
  try {
    lpTokenDecimals = await mUsdcRead.decimals.staticCall();
    const lpBalanceRaw = await mUsdcRead.balanceOf.staticCall(wallet.address);
    lpBalanceDisplay = ` | LP tokens: ${ethers.formatUnits(lpBalanceRaw, lpTokenDecimals)}`;
  } catch (lpErr: unknown) {
    logger.log(
      `  (lecture du solde LP tokens impossible: ${(lpErr as Error).message || lpErr})`,
    );
  }
  const zeroBalanceHint =
    startingBalanceRaw === 0n
      ? "  <-- 0 renvoyé: vérifiez MUSDC_ADDRESS (contrat mUSDC) et le réseau du RPC/WSS. Si l'adresse est fausse, le solde paraît nul."
      : "";
  logger.log(
    `Redeemable ${config.underlyingSymbol} balance: ${fmt(startingBalanceRaw)}${lpBalanceDisplay}${zeroBalanceHint}`,
  );
  const targetRaw =
    config.totalTarget !== null
      ? ethers.parseUnits(config.totalTarget.toString(), USDC_DECIMALS)
      : null;
  if (targetRaw !== null && targetRaw > startingBalanceRaw) {
    throw new Error(
      `Requested total (${config.totalTarget}) exceeds your redeemable balance (${fmt(startingBalanceRaw)}).`,
    );
  }
  if (targetRaw !== null)
    logger.log(
      `Target total withdrawal: ${fmt(targetRaw)} ${config.underlyingSymbol}`,
    );
  else {
    logger.log(
      "Mode solde complet — retirera la totalité du solde décomposable. Les dépôts externes (moniteur de balance) seront suivis aussi.",
    );
  }
  logger.log(
    "Will take up to 100% of available liquidity per chunk, capped at the known balance.",
  );
  logger.log("Polling market liquidity...");
  const runner = createChunkRunner({
    mUsdc,
    mUsdcRead,
    provider,
    config,
    initialBalanceRaw: startingBalanceRaw,
    readBalance: () => mUsdcRead.balanceOfUnderlying.staticCall(wallet.address),
    log: logger,
  });
  const { attemptChunk } = runner;
  let monitor: BalanceMonitor | null = null;
  if (config.balanceMonitorIntervalMs > 0) {
    monitor = createBalanceMonitor({
      config,
      mUsdcRead,
      walletAddress: wallet.address,
      intervalMs: config.balanceMonitorIntervalMs,
      initialRaw: startingBalanceRaw,
      onBalanceRead: createBalanceWiring(runner),
      lpDecimals: lpTokenDecimals,
      log: logger,
    });
    monitor.start();
    console.log(
      `Balance monitor ON — solde décomposable relu toutes les ${config.balanceMonitorIntervalMs / 1000} s (changements externes loggés et pris en compte par le plafond du chunk).\n`,
    );
  }
  const reconnectHandler = async () => {
    try {
      await provider.destroy();
    } catch {
      /* socket déjà mort */
    }
    (provider as any).removeAllListeners?.("block");
    const fresh = buildWss();
    let probe: { timedOut: boolean; value?: number };
    try {
      probe = await withTimeout(
        fresh.provider.getBlockNumber(),
        HEALTH_CHECK_MS,
      );
      if (probe.timedOut) throw new Error("WSS health-check: time out");
    } catch (healthErr: unknown) {
      try {
        await fresh.provider.destroy();
      } catch {
        /* socket jamais ouvert */
      }
      throw new Error(
        `WSS indisponible (${(healthErr as Error).message || healthErr})`,
      );
    }
    runner.setConnection({ mUsdc: fresh.mUsdc, provider: fresh.provider });
    subscribe(fresh.provider);
    provider = fresh.provider;
    wallet = fresh.wallet;
    mUsdc = fresh.mUsdc;
    watchdog.setProvider(fresh.provider);
    watchdog.reset();
    logger.log(
      `Reconnexion WSS établie à la tentative ${watchdog.state.reconnectCount}/${config.wssMaxReconnects} (hauteur ${probe.value}) — surveillance des blocks relancée.\n`,
    );
  };
  const watchdog = createWssWatchdog({
    provider,
    url: config.wssUrl,
    silenceTimeoutMs: config.wssStallMs,
    checkIntervalMs: config.wssCheckMs,
    maxReconnects: config.wssMaxReconnects,
    reconnect: config.wssOnStall !== "exit",
    backoffBaseMs: config.wssBackoffBaseMs,
    backoffMaxMs: config.wssBackoffMaxMs,
    onReconnect: reconnectHandler,
    shouldReconnect: () => !runner.state.txInFlight,
  });
  logger.log("Subscribing to new blocks — will check liquidity on each one.");
  subscribe(provider);
  attemptChunk();
  createShutdownHandler({
    stops: [...(monitor ? [monitor.stop] : []), watchdog.stop],
    destroyers: [
      async () => {
        try {
          await provider.destroy();
        } catch {}
      },
      async () => {
        try {
          await readProvider.destroy();
        } catch {}
      },
    ],
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_GAS_TIERS,
  DEFAULT_MUSDC_ADDRESS,
  DEFAULT_READ_RPC_URL,
  MTOKEN_ABI,
  USDC_DECIMALS,
  loadConfig,
  checkPlaceholders,
  maskUrl,
  logStartupParameters,
  fmt,
  getGasForChunk,
  withTimeout,
  getTxStatus,
  computeChunk,
  createChunkRunner,
  createBalanceWiring,
  createBalanceMonitor,
  createWssWatchdog,
  createShutdownHandler,
  parseAmount,
  createLogger,
};
