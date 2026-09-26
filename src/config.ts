import "dotenv/config";

import { GasTier } from "./types";

interface Config {
  wssUrl: string;
  readRpcUrl: string;
  privateKey: string;
  mUsdcAddress: string;
  totalTarget: number | null;
  minChunkUsdc: number;
  usdcDecimals: number;
  gasTiers: GasTier[];
  txTimeoutMs: number;
  balanceMonitorIntervalMs: number;
  chunkCapSource: "fresh" | "monitor";
  wssStallMs: number;
  wssCheckMs: number;
  wssMaxReconnects: number;
  wssBackoffBaseMs: number;
  wssBackoffMaxMs: number;
  wssOnStall: "exit" | "reconnect";
  underlyingSymbol: string;
}

// ---------- CONFIG ----------
const USDC_DECIMALS = 6;

const DEFAULT_GAS_TIERS: GasTier[] = [
  { minUsdc: 100, priorityGwei: "0.3", maxFeeGwei: "0.6" },
  { minUsdc: 30, priorityGwei: "0.1", maxFeeGwei: "0.3" },
  { minUsdc: 0, priorityGwei: "0.02", maxFeeGwei: "0.1" },
];
const DEFAULT_MUSDC_ADDRESS = "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22";
const DEFAULT_READ_RPC_URL = "https://base.drpc.org";
const DEFAULT_WSS_PLACEHOLDER = "PASTE_YOUR_WSS_URL_HERE";
const DEFAULT_PRIVATE_KEY_PLACEHOLDER = "PASTE_YOUR_PRIVATE_KEY_HERE";

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    wssUrl: env.BASE_WSS_URL || DEFAULT_WSS_PLACEHOLDER,
    readRpcUrl: env.BASE_READ_RPC_URL || DEFAULT_READ_RPC_URL,
    privateKey: env.PRIVATE_KEY || DEFAULT_PRIVATE_KEY_PLACEHOLDER,
    mUsdcAddress: env.MUSDC_ADDRESS || DEFAULT_MUSDC_ADDRESS,
    totalTarget: env.WITHDRAW_AMOUNT ? parseFloat(env.WITHDRAW_AMOUNT) : null,
    minChunkUsdc: env.MIN_CHUNK ? parseFloat(env.MIN_CHUNK) : 5,
    usdcDecimals: USDC_DECIMALS,
    gasTiers: DEFAULT_GAS_TIERS,
    txTimeoutMs: Number(env.TX_TIMEOUT_MS) || 60_000,
    balanceMonitorIntervalMs:
      env.BALANCE_MONITOR_INTERVAL !== undefined
        ? Number(env.BALANCE_MONITOR_INTERVAL) || 0
        : 60_000,
    chunkCapSource: env.CHUNK_CAP_SOURCE === "fresh" ? "fresh" : "monitor",
    wssStallMs: env.WS_STALL_MS
      ? Math.max(1_000, Number(env.WS_STALL_MS) || 0)
      : 15_000,
    wssCheckMs: env.WS_CHECK_MS
      ? Math.max(1_000, Number(env.WS_CHECK_MS) || 0)
      : 5_000,
    wssMaxReconnects: env.WS_MAX_RECONNECTS
      ? Math.max(1, Number(env.WS_MAX_RECONNECTS) || 0)
      : 10,
    wssBackoffBaseMs: env.WS_BACKOFF_BASE_MS
      ? Math.max(1_000, Number(env.WS_BACKOFF_BASE_MS) || 0)
      : 5_000,
    wssBackoffMaxMs: env.WS_BACKOFF_MAX_MS
      ? Math.max(1_000, Number(env.WS_BACKOFF_MAX_MS) || 0)
      : 60_000,
    wssOnStall: env.WS_ON_STALL === "exit" ? "exit" : "reconnect",
    underlyingSymbol: env.UNDERLYING_SYMBOL || "USDC",
  };
}

export {
  Config,
  GasTier,
  loadConfig,
  USDC_DECIMALS,
  DEFAULT_PRIVATE_KEY_PLACEHOLDER,
  DEFAULT_WSS_PLACEHOLDER,
  DEFAULT_GAS_TIERS,
  DEFAULT_MUSDC_ADDRESS,
  DEFAULT_READ_RPC_URL,
};
