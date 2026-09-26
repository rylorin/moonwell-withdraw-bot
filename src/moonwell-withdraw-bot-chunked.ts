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

const HEALTH_CHECK_MS = 5_000;

function parseAmount(raw: unknown, decimals = USDC_DECIMALS): bigint {
  if (raw === undefined || raw === null || raw === "") {
    throw new Error("amount is empty");
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`amount must be a positive decimal number, got "${raw}"`);
  }
  const dot = s.indexOf(".");
  if (dot !== -1 && s.length - dot - 1 > decimals) {
    throw new Error(
      `amount has more than ${decimals} decimal places (got ${s.length - dot - 1}): "${raw}"`,
    );
  }
  const val = ethers.parseUnits(s, decimals);
  if (val <= 0n) {
    throw new Error(`amount must be > 0, got "${raw}"`);
  }
  return val;
}

function checkPlaceholders(config: Config): string[] {
  const errors: string[] = [];
  if (
    !config.privateKey ||
    config.privateKey === DEFAULT_PRIVATE_KEY_PLACEHOLDER
  ) {
    errors.push("PRIVATE_KEY");
  }
  if (!config.wssUrl || config.wssUrl === DEFAULT_WSS_PLACEHOLDER) {
    errors.push("BASE_WSS_URL");
  }
  return errors;
}

function fmt(raw: bigint): string {
  return ethers.formatUnits(raw, USDC_DECIMALS);
}

const MTOKEN_ABI = [
  "function getCash() view returns (uint256)",
  "function balanceOfUnderlying(address owner) returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "event Failure(uint256 errorCode, uint256 info, uint256 detail)",
];

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length > 0) parts[parts.length - 1] = "***";
    u.pathname = "/" + parts.join("/");
    return u.toString();
  } catch {
    return "(URL invalide)";
  }
}

function logStartupParameters(
  config: Config,
  { walletAddress }: { walletAddress: string },
  log: Console = console,
): void {
  const targetDesc =
    config.totalTarget !== null
      ? `${config.totalTarget} ${config.underlyingSymbol}`
      : "solde décomposable complet";
  const tierDesc = config.gasTiers
    .map(
      (t) =>
        `$${t.minUsdc}+ → prio ${t.priorityGwei} / max ${t.maxFeeGwei} gwei`,
    )
    .join(" | ");
  log.log("==================================================");
  const appVersion =
    process.env.npm_package_version ||
    (() => {
      try {
        return require("./package.json").version;
      } catch {
        return "N/A";
      }
    })();
  log.log(`Moonwell withdrawal bot v${appVersion} — configuration`);
  log.log("--------------------------------------------------");
  log.log(`  mUSDC contract  : ${config.mUsdcAddress}`);
  log.log(
    `    (vérifie sur https://basescan.org/address/${config.mUsdcAddress})`,
  );
  log.log(`  Wallet          : ${walletAddress}`);
  log.log(`  WSS endpoint    : ${maskUrl(config.wssUrl)}`);
  log.log(`  Read RPC        : ${config.readRpcUrl}`);
  log.log(`  ${config.underlyingSymbol} decimals : ${config.usdcDecimals}`);
  log.log(`  WITHDRAW_AMOUNT : ${targetDesc}`);
  log.log(`  MIN_CHUNK       : ${config.minChunkUsdc}`);
  log.log(`  CHUNK_CAP_SOURCE: ${config.chunkCapSource}`);
  log.log(`  TX timeout      : ${config.txTimeoutMs / 1000} s`);
  log.log(
    `  Balance monitor : ${config.balanceMonitorIntervalMs > 0 ? `toutes les ${config.balanceMonitorIntervalMs / 1000} s` : "désactivé"}`,
  );
  log.log(
    `  WSS watchdog     : silence ${config.wssStallMs / 1000} s | check ${config.wssCheckMs / 1000} s | backoff ${config.wssBackoffBaseMs / 1000}→${config.wssBackoffMaxMs / 1000} s`,
  );
  log.log(
    `  WSS reconnex     : ${config.wssOnStall}${config.wssOnStall === "reconnect" ? ` (max ${config.wssMaxReconnects} tentatives)` : " (arrêt immédiat)"}`,
  );
  log.log(`  Gas tiers       : ${tierDesc}`);
  log.log("==================================================\n");
}

function getGasForChunk(
  chunkUsdcFloat: number,
  tiers: GasTier[] = DEFAULT_GAS_TIERS,
): { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } {
  const tier =
    tiers.find((t) => chunkUsdcFloat >= t.minUsdc) ?? tiers[tiers.length - 1];
  return {
    maxPriorityFeePerGas: ethers.parseUnits(tier.priorityGwei, "gwei"),
    maxFeePerGas: ethers.parseUnits(tier.maxFeeGwei, "gwei"),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function getTxStatus(
  provider: ethers.Provider,
  hash: string,
): Promise<"pending" | "mined" | "dropped" | "unknown"> {
  try {
    const data = await provider.getTransaction(hash);
    if (!data) return "dropped";
    if (data.blockNumber) return "mined";
    return "pending";
  } catch {
    return "unknown";
  }
}

function computeChunk(
  cash: bigint,
  remainingRaw: bigint,
  minChunkRaw: bigint,
  balanceRaw: bigint | null = null,
): { amount: bigint; belowMin: boolean } {
  if (cash <= 0n) return { amount: 0n, belowMin: false };
  let chunk = cash < remainingRaw ? cash : remainingRaw;
  if (balanceRaw !== null && balanceRaw < chunk) chunk = balanceRaw;
  return { amount: chunk, belowMin: chunk < minChunkRaw };
}

interface ChunkRunnerDeps {
  mUsdc: ethers.Contract;
  mUsdcRead: ethers.Contract;
  provider: ethers.Provider;
  config: Config;
  initialBalanceRaw: bigint;
  log?: Console;
  processExit?: (code?: number) => void;
  readBalance: () => Promise<bigint>;
}
interface ChunkRunnerState {
  stopped: boolean;
  txInFlight: boolean;
  processedRaw: bigint;
  knownBalanceRaw: bigint;
  capSource: "fresh" | "monitor";
  get remainingRaw(): bigint;
}
interface ChunkRunner {
  attemptChunk: () => Promise<void>;
  state: ChunkRunnerState;
  setConnection: (next: {
    mUsdc: ethers.Contract;
    provider: ethers.Provider;
  }) => void;
}

function createChunkRunner({
  mUsdc,
  mUsdcRead,
  provider,
  config,
  initialBalanceRaw,
  log = console,
  processExit = process.exit,
  readBalance,
}: ChunkRunnerDeps): ChunkRunner {
  let current = { mUsdc, mUsdcRead, provider };
  const setConnection = (next: {
    mUsdc: ethers.Contract;
    provider: ethers.Provider;
  }) => {
    if (next.mUsdc === current.mUsdc && next.provider === current.provider)
      return;
    current = {
      mUsdc: next.mUsdc,
      provider: next.provider,
      mUsdcRead: current.mUsdcRead,
    };
  };
  const minChunkRaw = ethers.parseUnits(
    config.minChunkUsdc.toString(),
    config.usdcDecimals,
  );
  const targetRaw =
    config.totalTarget !== null
      ? ethers.parseUnits(config.totalTarget.toString(), config.usdcDecimals)
      : null;
  let capSource: "fresh" | "monitor";
  if (config.chunkCapSource === "fresh") {
    capSource = "fresh";
  } else if (config.balanceMonitorIntervalMs > 0) {
    capSource = "monitor";
  } else {
    log.warn(
      "  -> CHUNK_CAP_SOURCE=monitor but BALANCE_MONITOR_INTERVAL=0 (no monitor). Falling back to reading the balance fresh each round.",
    );
    capSource = "fresh";
  }
  const state: ChunkRunnerState = {
    stopped: false,
    txInFlight: false,
    processedRaw: 0n,
    knownBalanceRaw: initialBalanceRaw,
    capSource,
    get remainingRaw() {
      if (targetRaw === null)
        return state.knownBalanceRaw < 0n ? 0n : state.knownBalanceRaw;
      const rem = targetRaw - state.processedRaw;
      return rem < 0n ? 0n : rem;
    },
  };
  const done = async (message?: string) => {
    log.log(
      message ??
        (targetRaw === null
          ? "Redeemable balance fully withdrawn. Done."
          : "Target fully withdrawn. Done."),
    );
    state.stopped = true;
    current.provider.removeAllListeners("block");
    await current.provider.destroy();
    processExit(0);
  };
  const attemptChunk = async () => {
    if (state.stopped || state.txInFlight) return;
    state.txInFlight = true;
    try {
      // const ts = new Date().toISOString();
      let balanceRaw = state.knownBalanceRaw;
      if (capSource === "fresh") {
        if (typeof readBalance !== "function")
          throw new Error(
            "chunk cap source 'fresh' requires a readBalance() function",
          );
        try {
          balanceRaw = await readBalance();
          state.knownBalanceRaw = balanceRaw;
        } catch (readErr: unknown) {
          log.warn(
            `  -> Fresh balance read failed (${(readErr as Error).message || readErr}); using known balance ${fmt(state.knownBalanceRaw)}.`,
          );
        }
      }
      if (state.remainingRaw <= 0n) {
        await done();
        return;
      }
      if (state.remainingRaw > 0n && state.remainingRaw < minChunkRaw) {
        log.log(
          `  -> Remaining ${fmt(state.remainingRaw)} ${config.underlyingSymbol} is below the minimum chunk (${config.minChunkUsdc} ${config.underlyingSymbol}) — nothing left to withdraw. Done.`,
        );
        await done();
        return;
      }
      let cash: bigint;
      try {
        cash = await current.mUsdcRead.getCash();
      } catch (readErr: unknown) {
        log.warn(
          `  -> Public RPC getCash() failed (${(readErr as Error).message || readErr}), falling back to Alchemy for this check.`,
        );
        cash = await current.mUsdc.getCash();
      }
      if (cash === 0n) {
        log.log(`No liquidity available. Waiting...`);
        return;
      }
      const { amount: chunk, belowMin } = computeChunk(
        cash,
        state.remainingRaw,
        minChunkRaw,
        balanceRaw,
      );
      log.log(
        `Liquidity: ${fmt(cash)} | Known balance: ${fmt(balanceRaw)} | Remaining: ${fmt(state.remainingRaw)} | Chunk to attempt: ${fmt(chunk)}`,
      );
      if (chunk <= 0n) {
        log.log("  -> Nothing to withdraw this round.");
        return;
      }
      if (belowMin) {
        log.log(
          `  -> Below MIN_CHUNK (${config.minChunkUsdc}), skipping this round.`,
        );
        return;
      }
      log.log("  -> Submitting redeemUnderlying tx...");
      const chunkUsdcFloat = parseFloat(fmt(chunk));
      const { maxPriorityFeePerGas, maxFeePerGas } = getGasForChunk(
        chunkUsdcFloat,
        config.gasTiers,
      );
      log.log(
        `  -> Gas tier for $${chunkUsdcFloat.toFixed(2)} chunk: priority=${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} gwei, max=${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`,
      );
      const tx = await current.mUsdc.redeemUnderlying(chunk, {
        maxPriorityFeePerGas,
        maxFeePerGas,
      });
      log.log(`  -> Submitted: ${tx.hash}`);
      const waitRes = await withTimeout<ethers.TransactionReceipt>(
        tx.wait(),
        config.txTimeoutMs,
      );
      let receipt: ethers.TransactionReceipt | null;
      if (waitRes.timedOut) {
        const status = await getTxStatus(current.provider, tx.hash);
        if (status === "mined") {
          receipt = await current.provider.getTransactionReceipt(tx.hash);
        } else {
          log.warn(
            `  -> Tx ${tx.hash} still ${status} after ${config.txTimeoutMs / 1000}s — not mined. Giving up this round; nothing was decremented. Will retry next block.`,
          );
          return;
        }
      } else {
        receipt = waitRes.value ?? null;
      }
      if (!receipt) {
        log.error("  -> No receipt for tx — giving up this round.");
        return;
      }
      if (receipt.status !== 1) {
        log.error("  -> Transaction FAILED/reverted. Will retry next block.");
        return;
      }
      const failureEvent = receipt.logs
        .map((entry) => {
          try {
            return current.mUsdc.interface.parseLog(entry);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "Failure");
      if (failureEvent) {
        log.error(
          `  -> Redeem soft-failed on-chain (Failure event: error=${failureEvent.args.errorCode}, info=${failureEvent.args.info}). No funds were transferred. Will retry next block.`,
        );
        return;
      }
      log.log(`  -> Confirmed in block ${receipt.blockNumber}.`);
      state.processedRaw += chunk;
      state.knownBalanceRaw -= chunk;
      if (state.knownBalanceRaw < 0n) state.knownBalanceRaw = 0n;
      log.log(
        `  -> Processed so far: ${fmt(state.processedRaw)} | Remaining to withdraw: ${fmt(state.remainingRaw)} USDC\n`,
      );
      if (state.remainingRaw <= 0n) await done();
    } catch (err: unknown) {
      log.error("Error during chunk attempt:", (err as Error).message || err);
    } finally {
      state.txInFlight = false;
    }
  };
  return { attemptChunk, state, setConnection };
}

function createBalanceWiring(runner: {
  state: { txInFlight: boolean; knownBalanceRaw: bigint };
}) {
  return (raw: bigint) => {
    if (!runner.state.txInFlight) runner.state.knownBalanceRaw = raw;
  };
}

interface BalanceMonitorDeps {
  config: Config;
  mUsdcRead: ethers.Contract;
  walletAddress: string;
  intervalMs: number;
  log?: Console;
  initialRaw?: bigint | null;
  onBalanceRead: (raw: bigint) => void;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
  lpDecimals?: number | null;
}
interface BalanceMonitor {
  start: () => { stop: () => void };
  read: () => Promise<void>;
  stop: () => void;
}

function createBalanceMonitor({
  config,
  mUsdcRead,
  walletAddress,
  intervalMs,
  log = console,
  initialRaw = null,
  onBalanceRead = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
  lpDecimals = null,
}: BalanceMonitorDeps): BalanceMonitor {
  let lastRaw: bigint | null = initialRaw;
  let failures = 0;
  let timer: NodeJS.Timeout | null = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const read = async () => {
    try {
      const raw = await mUsdcRead.balanceOfUnderlying.staticCall(walletAddress);
      failures = 0;
      let lpBalance = "";
      try {
        let resolvedDecimals = lpDecimals;
        if (resolvedDecimals === null)
          resolvedDecimals = await mUsdcRead.decimals.staticCall();
        const lpRaw = await mUsdcRead.balanceOf.staticCall(walletAddress);
        lpBalance = `| LP tokens: ${ethers.formatUnits(lpRaw, resolvedDecimals || USDC_DECIMALS)}`;
      } catch {
        lpBalance = "| LP tokens: n/a";
      }
      // const ts = new Date().toISOString();
      if (lastRaw !== null && raw !== lastRaw) {
        const delta = raw - lastRaw;
        const sign = delta > 0n ? "+" : "-";
        const abs = delta < 0n ? -delta : delta;
        log.log(
          `[balance] ${fmt(raw)} ${config.underlyingSymbol} ${lpBalance} (${sign}${fmt(abs)} ${config.underlyingSymbol} depuis la dernière lecture — changement externe)`,
        );
      } else {
        log.log(
          `[balance] ${fmt(raw)} ${config.underlyingSymbol} ${lpBalance} (inchangé)`,
        );
      }
      lastRaw = raw;
      onBalanceRead(raw);
    } catch (err: unknown) {
      failures++;
      const giveUp = failures >= 5;
      log.warn(
        `  -> balance read failed (${(err as Error).message || err})${giveUp ? " — moniteur de solde arrêté après erreurs répétées." : ""}`,
      );
      if (giveUp) stop();
    }
  };
  const start = () => {
    if (intervalMs > 0)
      timer = setTimer(() => {
        read().catch(() => {});
      }, intervalMs);
    return { stop };
  };
  return { start, read, stop };
}

interface WssWatchdogDeps {
  provider: ethers.Provider;
  url?: string;
  log?: Console;
  now?: () => number;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
  scheduleRetry?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancelRetry?: (t: NodeJS.Timeout) => void;
  maskUrlFn?: (url: string) => string;
  silenceTimeoutMs?: number;
  checkIntervalMs?: number;
  maxReconnects?: number;
  reconnect?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  backoffFactor?: number;
  onReconnect?: (() => Promise<void>) | undefined;
  shouldReconnect?: () => boolean;
  processExit?: (code?: number) => void;
}
interface WssWatchdogState {
  socketDown: boolean;
  stallActive: boolean;
  stallCount: number;
  reconnectCount: number;
  backoffMs: number;
  retryTimer: NodeJS.Timeout | null;
  lastBlockAt: number;
}
interface WssWatchdog {
  tick: () => void;
  reset: () => void;
  stop: () => void;
  setProvider: (provider: ethers.Provider) => void;
  state: WssWatchdogState;
}

function createWssWatchdog({
  provider,
  url = "",
  log = console,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  scheduleRetry = (cb, ms) => setTimeout(cb, ms),
  cancelRetry = (t) => clearTimeout(t),
  maskUrlFn = maskUrl,
  silenceTimeoutMs = 15_000,
  checkIntervalMs = 5_000,
  maxReconnects = 5,
  reconnect = true,
  backoffBaseMs = 5_000,
  backoffMaxMs = 60_000,
  backoffFactor = 2,
  onReconnect = undefined,
  shouldReconnect = () => true,
  processExit = process.exit,
}: WssWatchdogDeps): WssWatchdog {
  const state: WssWatchdogState = {
    socketDown: false,
    stallActive: false,
    stallCount: 0,
    reconnectCount: 0,
    backoffMs: backoffBaseMs,
    retryTimer: null,
    lastBlockAt: now(),
  };
  let timer: NodeJS.Timeout | null = null;
  let exited = false;
  let boundProvider: ethers.Provider | null = null;
  const cancelRetryTimer = () => {
    if (state.retryTimer !== null) {
      cancelRetry(state.retryTimer);
      state.retryTimer = null;
    }
  };
  const tick = () => {
    state.lastBlockAt = now();
    state.socketDown = false;
  };
  const myBlockHandler = () => tick();
  const stop = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    cancelRetryTimer();
    unbind();
  };
  const fatal = (msg: string) => {
    if (exited) return;
    exited = true;
    log.error(msg);
    stop();
    processExit(1);
  };
  const myErrorHandler = (err: unknown) => {
    const detail =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string | number }).code
        : err && typeof err === "object" && "message" in err
          ? (err as { message?: string }).message
          : "inconnue";
    log.warn(
      `  -> Connexion WSS : erreur détectée (${detail}). Le heartbeat reste actif.`,
    );
  };
  const myCloseHandler = () => {
    state.socketDown = true;
    log.warn(
      `  -> Connexion WSS fermée par le serveur (${url ? maskUrlFn(url) : "URL non disponible"}). Les events block sont interrompus.`,
    );
    if (reconnect)
      log.log(
        "  -> [reconnect] Le heartbeat va déclencher une reconnexion au prochain cycle.",
      );
    if (!reconnect)
      fatal("  -> WS_ON_STALL=exit — arrêt immédiat à la fermeture du WSS.");
  };
  const reset = () => {
    state.lastBlockAt = now();
    state.stallActive = false;
    state.stallCount = 0;
    state.socketDown = false;
    state.backoffMs = backoffBaseMs;
    cancelRetryTimer();
  };
  const checkOnce = () => {
    const idleMs = now() - state.lastBlockAt;
    if (idleMs <= silenceTimeoutMs) {
      state.socketDown = false;
      state.stallActive = false;
      return;
    }
    state.socketDown = true;
    if (state.stallActive) return;
    state.stallActive = true;
    state.stallCount++;
    if (!reconnect)
      return fatal(
        `  -> Aucun block reçu depuis ${Math.round(idleMs / 1000)} s — WS_ON_STALL=exit, arrêt du bot.`,
      );
    attemptReconnect();
  };
  const attemptReconnect = () => {
    const idleMs = now() - state.lastBlockAt;
    const secs = Math.round(idleMs / 1000);
    if (idleMs <= silenceTimeoutMs) {
      state.socketDown = false;
      state.stallActive = false;
      state.backoffMs = backoffBaseMs;
      return;
    }
    if (
      typeof onReconnect !== "function" ||
      maxReconnects <= 0 ||
      state.reconnectCount >= maxReconnects
    )
      return fatal(
        `  -> Budget de reconnexions épuisé (max ${maxReconnects}) après ${secs} s sans block. Arrêt du bot.`,
      );
    if (!shouldReconnect()) {
      log.warn(
        `  -> Aucun block depuis ${secs} s — une transaction est en cours, reconnexion différée (budget non consommé).`,
      );
      return reset();
    }
    state.reconnectCount++;
    log.warn(
      `  -> Aucun block reçu depuis ${secs} s — tentative de reconnexion ${state.reconnectCount}/${maxReconnects} (${maskUrlFn(url)})...`,
    );
    Promise.resolve()
      .then(() => onReconnect())
      .then(
        () => {
          state.backoffMs = backoffBaseMs;
          reset();
        },
        (err: unknown) => {
          log.error(
            `  -> Échec de la reconnexion: ${(err && (err as Error).message) || err}`,
          );
          if (state.reconnectCount >= maxReconnects)
            return fatal(
              `  -> Budget de reconnexions épuisé (max ${maxReconnects}) après ${secs} s sans block. Arrêt du bot.`,
            );
          const delay = state.backoffMs;
          state.backoffMs = Math.min(
            state.backoffMs * backoffFactor,
            backoffMaxMs,
          );
          log.warn(
            `  -> Nouvelle tentative dans ${Math.round(delay / 1000)} s (backoff exponentiel).`,
          );
          cancelRetryTimer();
          state.retryTimer = scheduleRetry(() => {
            state.retryTimer = null;
            attemptReconnect();
          }, delay);
        },
      );
  };
  const safeWs = (p: ethers.Provider | null): any => {
    try {
      return (p as any).websocket || null;
    } catch {
      return null;
    }
  };
  const unbind = () => {
    if (!boundProvider) return;
    (boundProvider as any).off?.("block", myBlockHandler);
    (boundProvider as any).off?.("error", myErrorHandler);
    (safeWs(boundProvider) as any)?.off?.("close", myCloseHandler);
    boundProvider = null;
  };
  const bind = (next: ethers.Provider) => {
    if (next === boundProvider) return;
    unbind();
    boundProvider = next;
    (next as any).on?.("block", myBlockHandler);
    (next as any).on?.("error", myErrorHandler);
    safeWs(next)?.on?.("close", myCloseHandler);
  };
  const setProvider = (next: ethers.Provider) => bind(next);
  bind(provider);
  timer = setTimer(checkOnce, checkIntervalMs);
  return { tick, reset, stop, setProvider, state };
}

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
    `Redeemable USDC balance: ${fmt(startingBalanceRaw)}${lpBalanceDisplay}${zeroBalanceHint}`,
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
    logger.log(`Target total withdrawal: ${fmt(targetRaw)} USDC`);
  else {
    logger.log(
      "Mode solde complet — retirera la totalité du solde décomposable. Les",
    );
    logger.log("dépôts externes (moniteur de balance) seront suivis aussi.");
  }
  logger.log(
    "Will take up to 100% of available liquidity per chunk, capped at the known balance.",
  );
  logger.log("Polling market liquidity...\n");
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
  logger.log("Subscribing to new blocks — will check liquidity on each one.\n");
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
