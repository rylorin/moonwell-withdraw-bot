import { ethers } from "ethers";
import {
  Config,
  DEFAULT_GAS_TIERS,
  DEFAULT_PRIVATE_KEY_PLACEHOLDER,
  DEFAULT_WSS_PLACEHOLDER,
  GasTier,
  USDC_DECIMALS,
} from "./config";

function fmt(raw: bigint): string {
  return ethers.formatUnits(raw, USDC_DECIMALS);
}

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
    `  WSS watchdog    : silence ${config.wssStallMs / 1000} s | check ${config.wssCheckMs / 1000} s | backoff ${config.wssBackoffBaseMs / 1000}→${config.wssBackoffMaxMs / 1000} s`,
  );
  log.log(
    `  WSS reconnex    : ${config.wssOnStall}${config.wssOnStall === "reconnect" ? ` (max ${config.wssMaxReconnects} tentatives)` : " (arrêt immédiat)"}`,
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

function createBalanceWiring(runner: {
  state: { txInFlight: boolean; knownBalanceRaw: bigint };
}) {
  return (raw: bigint) => {
    if (!runner.state.txInFlight) runner.state.knownBalanceRaw = raw;
  };
}

export {
  fmt,
  maskUrl,
  parseAmount,
  checkPlaceholders,
  logStartupParameters,
  getGasForChunk,
  withTimeout,
  getTxStatus,
  createBalanceWiring,
};
