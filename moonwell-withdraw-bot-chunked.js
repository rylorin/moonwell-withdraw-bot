#!/usr/bin/env node

/**
 * Moonwell (Base) USDC withdrawal bot — CHUNKED VERSION
 * -------------------------------------------------------
 * For large withdrawals that likely exceed the pool's available liquidity
 * in one shot. Repeatedly polls getCash() and redeems a safe fraction of
 * whatever liquidity is currently available, looping until your full
 * target amount has been withdrawn (or you stop it).
 *
 * Requires: node >= 18, ethers v6  ->  npm install ethers
 *
 * SECURITY NOTES (read before running):
 * - This script needs your PRIVATE KEY to sign transactions. Set it via
 *   an environment variable — never hardcode it in this file or share it.
 * - Only run this against a wallet you control, on a machine you trust.
 * - Contract address verified on BaseScan:
 *   https://basescan.org/address/0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22
 *
 * The module exports its pure logic (loadConfig, getGasForChunk, withTimeout,
 * createChunkRunner, ...) so it can be unit-tested; when executed directly it
 * runs the bot (see `if (require.main === module)` at the end).
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ---------- CONFIG ----------
const USDC_DECIMALS = 6;

// Fee tiers, ordered largest amount first. `GAS_TIERS.find` scans from the
// top, so a chunk amount >= threshold picks that tier.
const DEFAULT_GAS_TIERS = [
  // { minUsdc: <threshold>, priorityGwei: <tip>, maxFeeGwei: <ceiling> }
  { minUsdc: 100, priorityGwei: "0.3", maxFeeGwei: "0.6" }, // $100+ chunks
  { minUsdc: 30, priorityGwei: "0.1", maxFeeGwei: "0.3" }, // $30+ chunks
  { minUsdc: 0, priorityGwei: "0.02", maxFeeGwei: "0.1" }, // below $30
];
const DEFAULT_MUSDC_ADDRESS = "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22";
const DEFAULT_READ_RPC_URL = "https://base.drpc.org";
// Use a wss:// URL here (e.g. wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY).
const DEFAULT_WSS_PLACEHOLDER = "PASTE_YOUR_WSS_URL_HERE";
const DEFAULT_PRIVATE_KEY_PLACEHOLDER = "PASTE_YOUR_PRIVATE_KEY_HERE";

/**
 * Build the config object from an `env` map (defaults to process.env).
 * Pure — no network, no side effects → unit-testable.
 */
function loadConfig(env = process.env) {
  return {
    wssUrl: env.BASE_WSS_URL || DEFAULT_WSS_PLACEHOLDER,
    readRpcUrl: env.BASE_READ_RPC_URL || DEFAULT_READ_RPC_URL,
    privateKey: env.PRIVATE_KEY || DEFAULT_PRIVATE_KEY_PLACEHOLDER,
    mUsdcAddress: env.MUSDC_ADDRESS || DEFAULT_MUSDC_ADDRESS,
    // Human units (e.g. 70000); null → withdraw the full redeemable balance.
    totalTarget: env.WITHDRAW_AMOUNT ? parseFloat(env.WITHDRAW_AMOUNT) : null,
    minChunkUsdc: env.MIN_CHUNK ? parseFloat(env.MIN_CHUNK) : 5,
    usdcDecimals: USDC_DECIMALS,
    gasTiers: DEFAULT_GAS_TIERS,
    // P1: cap on how long we wait for a transaction to be mined before giving
    // up this round (see `withTimeout`).
    txTimeoutMs: Number(env.TX_TIMEOUT_MS) || 60_000,
  };
}

/**
 * Return the list of required settings still set to their placeholder value.
 */
function checkPlaceholders(config) {
  const errors = [];
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

function fmt(raw) {
  return ethers.formatUnits(raw, USDC_DECIMALS);
}

// ---------- ABI (minimal Compound-style mToken interface) ----------
const MTOKEN_ABI = [
  "function getCash() view returns (uint256)",
  "function balanceOfUnderlying(address owner) returns (uint256)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "event Failure(uint256 errorCode, uint256 info, uint256 detail)",
];

// ---------- Startup diagnostics ----------

/**
 * Hide the API key of a wss://http(s):// URL so we can log the endpoint
 * without leaking the secret. Only the last path segment is masked.
 */
function maskUrl(url) {
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

/**
 * Print every parameter that influences behaviour at startup. The mUSDC
 * address is shown prominently because a wrong value makes balance reads
 * return 0 / revert — exactly the "solde introuvable" symptom in production.
 */
function logStartupParameters(config, { walletAddress }, log = console) {
  const targetDesc =
    config.totalTarget !== null
      ? `${config.totalTarget} USDC`
      : "solde décomposable complet";
  const tierDesc = config.gasTiers
    .map(
      (t) =>
        `$${t.minUsdc}+ → prio ${t.priorityGwei} / max ${t.maxFeeGwei} gwei`,
    )
    .join(" | ");

  log.log("==================================================");
  log.log("Moonwell withdrawal bot — configuration");
  log.log("--------------------------------------------------");
  log.log(`  mUSDC contract  : ${config.mUsdcAddress}`);
  log.log(
    `    (vérifie sur https://basescan.org/address/${config.mUsdcAddress})`,
  );
  log.log(`  Wallet          : ${walletAddress}`);
  log.log(`  WSS endpoint    : ${maskUrl(config.wssUrl)}`);
  log.log(`  Read RPC        : ${config.readRpcUrl}`);
  log.log(`  USDC decimals   : ${config.usdcDecimals}`);
  log.log(`  WITHDRAW_AMOUNT : ${targetDesc}`);
  log.log(`  MIN_CHUNK       : ${config.minChunkUsdc}`);
  log.log(`  TX timeout      : ${config.txTimeoutMs / 1000} s`);
  log.log(`  Gas tiers       : ${tierDesc}`);
  log.log("==================================================\n");
}

// ---------- Pure helpers ----------

function getGasForChunk(chunkUsdcFloat, tiers = DEFAULT_GAS_TIERS) {
  const tier =
    tiers.find((t) => chunkUsdcFloat >= t.minUsdc) ?? tiers[tiers.length - 1];
  return {
    maxPriorityFeePerGas: ethers.parseUnits(tier.priorityGwei, "gwei"),
    maxFeePerGas: ethers.parseUnits(tier.maxFeeGwei, "gwei"),
  };
}

/**
 * P1: cap `tx.wait()` so a tx stuck pending (base fee > our max fee ceiling)
 * can never stall the whole bot (txInFlight stays true otherwise → every later
 * block is ignored). Resolves `{ timedOut: true }` after `ms` if the wrapped
 * promise has still not settled; otherwise `{ timedOut: false, value }`.
 * Rejections are propagated unchanged.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * P1: ask the provider for the real on-chain status of a tx after our wait
 * timed out. Returns "pending" (still in mempool), "mined" (a block was won
 * just after our deadline), "dropped" (gone from the mempool — replaced or
 * evicted) or "unknown" (provider error, we simply don't know).
 */
async function getTxStatus(provider, hash) {
  try {
    const data = await provider.getTransaction(hash);
    if (!data) return "dropped";
    if (data.blockNumber) return "mined";
    return "pending";
  } catch {
    return "unknown";
  }
}

/**
 * The chunk = min(available cash, remaining target). Returns `{ amount,
 * belowMin }` as raw BigInts. Pure → unit-testable.
 */
function computeChunk(cash, remainingRaw, minChunkRaw) {
  if (cash <= 0n) return { amount: 0n, belowMin: false };
  const chunk = cash < remainingRaw ? cash : remainingRaw;
  return { amount: chunk, belowMin: chunk < minChunkRaw };
}

/**
 * The heart of the bot: one attempt to redeem one chunk. Everything it talks
 * to (contracts, provider, logger, process.exit) is injected so unit tests can
 * drive it through mocked dependencies. `state` exposes the mutable loop state
 * (stopped / txInFlight / remainingRaw) for assertions.
 */
function createChunkRunner({
  mUsdc,
  mUsdcRead,
  provider,
  config,
  initialRemainingRaw,
  log = console,
  processExit = process.exit,
}) {
  const minChunkRaw = ethers.parseUnits(
    config.minChunkUsdc.toString(),
    config.usdcDecimals,
  );
  const state = {
    stopped: false,
    txInFlight: false,
    remainingRaw: initialRemainingRaw,
  };

  const attemptChunk = async () => {
    // P2: hold the guard IMMEDIATELY, before any `await`. attemptChunk is
    // async; between this check and the old `txInFlight = true` (after
    // getCash()) there were awaits, and Base emits a new block every ~2 s —
    // two block events could both pass the guard and both call
    // redeemUnderlying() on the same nonce, orphaning one tx forever.
    if (state.stopped || state.txInFlight) return;
    state.txInFlight = true;

    try {
      // Try the free public RPC first; if it errors (rate limit, flaky
      // node, etc.) fall back to the Alchemy connection for this check
      // rather than skipping the round entirely.
      let cash;
      try {
        cash = await mUsdcRead.getCash();
      } catch (readErr) {
        log.warn(
          `  -> Public RPC getCash() failed (${readErr.message || readErr}), falling back to Alchemy for this check.`,
        );
        cash = await mUsdc.getCash();
      }
      const ts = new Date().toISOString();

      if (cash === 0n) {
        log.log(`[${ts}] No liquidity available. Waiting...`);
        return;
      }

      const { amount: chunk, belowMin } = computeChunk(
        cash,
        state.remainingRaw,
        minChunkRaw,
      );

      log.log(
        `[${ts}] Available liquidity: ${fmt(cash)} | Remaining target: ${fmt(
          state.remainingRaw,
        )} | Chunk to attempt: ${fmt(chunk)}`,
      );

      if (belowMin) {
        log.log(
          `  -> Below MIN_CHUNK (${config.minChunkUsdc}), skipping this round.`,
        );
        return;
      }

      log.log("  -> Submitting redeemUnderlying tx...");

      // Pick gas fee tier based on the size of this specific chunk.
      const chunkUsdcFloat = parseFloat(fmt(chunk));
      const { maxPriorityFeePerGas, maxFeePerGas } = getGasForChunk(
        chunkUsdcFloat,
        config.gasTiers,
      );
      log.log(
        `  -> Gas tier for $${chunkUsdcFloat.toFixed(
          2,
        )} chunk: priority=${ethers.formatUnits(
          maxPriorityFeePerGas,
          "gwei",
        )} gwei, max=${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`,
      );

      const tx = await mUsdc.redeemUnderlying(chunk, {
        maxPriorityFeePerGas,
        maxFeePerGas,
      });
      log.log(`  -> Submitted: ${tx.hash}`);

      // P1: bounded wait. If after `txTimeoutMs` the receipt is still not in,
      // check what really happened on-chain instead of waiting forever. We
      // never decrement remainingRaw here — if the tx did mine in the end,
      // the next round's successful receipt handles the decrement (worst case:
      // a no-op retry on liquidity that has already shrunken).
      const waitRes = await withTimeout(tx.wait(), config.txTimeoutMs);
      let receipt;
      if (waitRes.timedOut) {
        const status = await getTxStatus(provider, tx.hash);
        if (status === "mined") {
          // It mined just past our deadline — process the receipt normally.
          receipt = await provider.getTransactionReceipt(tx.hash);
        } else {
          log.warn(
            `  -> Tx ${tx.hash} still ${status} after ${config.txTimeoutMs / 1000}s — not mined. Giving up this round; nothing was decremented. Will retry next block.`,
          );
          return;
        }
      } else {
        receipt = waitRes.value;
      }

      if (receipt.status !== 1) {
        log.error("  -> Transaction FAILED/reverted. Will retry next block.");
        return;
      }

      // Compound-fork contracts can report success at the EVM level while
      // still failing internally (e.g. cash disappeared between our check
      // and execution) — that shows up as a Failure event in the logs
      // instead of a revert. Check for it explicitly; receipt.status alone
      // is not sufficient here.
      const failureEvent = receipt.logs
        .map((entry) => {
          try {
            return mUsdc.interface.parseLog(entry);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "Failure");

      if (failureEvent) {
        log.error(
          `  -> Redeem soft-failed on-chain (Failure event: error=${failureEvent.args.errorCode}, info=${failureEvent.args.info}). No funds were transferred. Will retry next block.`,
        );
        return; // do NOT decrement remainingRaw — nothing was actually redeemed
      }

      log.log(`  -> Confirmed in block ${receipt.blockNumber}.`);
      state.remainingRaw -= chunk;
      log.log(`  -> Remaining to withdraw: ${fmt(state.remainingRaw)} USDC\n`);

      if (state.remainingRaw <= 0n) {
        log.log("Target fully withdrawn. Done.");
        state.stopped = true;
        provider.removeAllListeners("block");
        await provider.destroy();
        processExit(0);
      }
    } catch (err) {
      log.error("Error during chunk attempt:", err.message || err);
      // Keep going — transient RPC errors or reverts shouldn't kill the bot.
    } finally {
      state.txInFlight = false;
    }
  };

  return { attemptChunk, state };
}

// ---------- Entry point ----------

async function main() {
  const config = loadConfig(process.env);

  const missing = checkPlaceholders(config);
  if (missing.length > 0) {
    throw new Error(
      `Config manquante: ${missing.join(
        ", ",
      )}. Définissez-les dans votre environnement ou le fichier .env.`,
    );
  }

  const provider = new ethers.WebSocketProvider(config.wssUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const mUsdc = new ethers.Contract(config.mUsdcAddress, MTOKEN_ABI, wallet);

  // Separate read-only provider for the high-frequency getCash() checks —
  // keeps that load off the paid Alchemy connection. Block subscription and
  // transaction submission still go through the Alchemy WSS provider above.
  const readProvider = new ethers.JsonRpcProvider(config.readRpcUrl);
  const mUsdcRead = new ethers.Contract(
    config.mUsdcAddress,
    MTOKEN_ABI,
    readProvider,
  );

  // Startup diagnostics: print every parameter that drives the bot. In
  // production, a "balance not found" is almost always a wrong MUSDC_ADDRESS
  // (or the wrong network RPC) — these lines make it visible immediately.
  logStartupParameters(config, { walletAddress: wallet.address });

  const startingBalanceRaw = await mUsdc.balanceOfUnderlying.staticCall(
    wallet.address,
  );
  const zeroBalanceHint =
    startingBalanceRaw === 0n
      ? "  <-- 0 renvoyé: vérifiez MUSDC_ADDRESS (contrat mUSDC) et le réseau du RPC/WSS. Si l'adresse est fausse, le solde paraît nul."
      : "";
  console.log(
    `Redeemable USDC balance: ${fmt(startingBalanceRaw)}${zeroBalanceHint}`,
  );

  let remainingRaw =
    config.totalTarget !== null
      ? ethers.parseUnits(config.totalTarget.toString(), USDC_DECIMALS)
      : startingBalanceRaw;

  if (remainingRaw > startingBalanceRaw) {
    throw new Error(
      `Requested total (${config.totalTarget}) exceeds your redeemable balance (${fmt(
        startingBalanceRaw,
      )}).`,
    );
  }

  console.log(`Target total withdrawal: ${fmt(remainingRaw)} USDC`);
  console.log("Will take up to 100% of available liquidity per chunk.");
  console.log("Polling market liquidity...\n");

  const { attemptChunk } = createChunkRunner({
    mUsdc,
    mUsdcRead,
    provider,
    config,
    initialRemainingRaw: remainingRaw,
  });

  console.log(
    "Subscribing to new blocks — will check liquidity on each one.\n",
  );
  provider.on("block", attemptChunk);
  attemptChunk(); // run immediately on start, don't wait for the first block
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
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
};
