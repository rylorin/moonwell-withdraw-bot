"use strict";

/**
 * Unit tests for moonwell-withdraw-bot-chunked.js
 * ------------------------------------------------
 * Run with:  node --test tests/     (or: yarn test)
 * Uses only the built-in node:test runner + mock providers → no network,
 * no real transactions, no ethers mocks library needed.
 *
 * Coverage highlights:
 *  - config loading / placeholder validation (helps spot the "solde introuvable"
 *    symptom caused by a wrong MUSDC_ADDRESS at runtime)
 *  - P1: bounded tx.wait() — a tx that never mines must NOT stall the bot
 *  - P2: the txInFlight guard is held before the first await — two concurrent
 *        attemptChunk() calls must submit exactly one tx
 *  - re-sync: the chunk is capped at the known balance; in full-balance mode
 *        remainingRaw derives from the balance, so external deposits are
 *        picked up and manual withdrawals shrink the goal naturally.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const bot = require("../moonwell-withdraw-bot-chunked");

const {
  loadConfig,
  checkPlaceholders,
  maskUrl,
  logStartupParameters,
  getGasForChunk,
  withTimeout,
  getTxStatus,
  computeChunk,
  createChunkRunner,
  createBalanceWiring,
  createBalanceMonitor,
  createWssWatchdog,
  DEFAULT_GAS_TIERS,
} = bot;

const parse = (v) => ethers.parseUnits(String(v), 6);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully mocked runner environment. Override any behaviour via
 * `overrides` — see each test for the supported keys:
 *  - targetUsd / minChunkUsdc / txTimeoutMs : config values
 *  - fullBalance     : omit WITHDRAW_AMOUNT → full-balance mode
 *  - initialBalanceUsd : the known balance (chunk cap) seed
 *  - chunkCapSource / balanceInterval : CHUNK_CAP_SOURCE / BALANCE_MONITOR_INTERVAL
 *  - readBalance / freshBalance : the 'fresh' cap-source reader
 *  - cash            : what getCash() returns (raw BigInt or human number)
 *  - failPublicGetCash : make the public RPC read throw (tests the fallback)
 *  - txWait          : what tx.wait() does (fn) — default resolves a receipt
 *  - getTransaction / getTransactionReceipt : provider mocks (P1 paths)
 *  - receipt         : the receipt processed after a successful wait
 */
function makeDeps(overrides = {}) {
  const logs = [];
  const warns = [];
  const errors = [];
  const log = {
    log: (msg) => logs.push(String(msg)),
    warn: (msg) => warns.push(String(msg)),
    error: (msg, extra) =>
      errors.push(String(msg) + (extra ? " " + extra : "")),
  };

  const calls = {
    redeem: 0,
    getCashPublic: 0,
    getCashAlchemy: 0,
    exit: 0,
    removedListeners: 0,
    destroyed: 0,
  };

  // `cash` may be given as a human number ("100" → 100 USDC) or as raw BigInt.
  // getCash() on-chain always returns raw units, so normalise to BigInt here —
  // the unit mismatch (e.g. 100 < 5_000_000) is a real trap.
  const cashValue =
    overrides.cash == null
      ? parse("100")
      : typeof overrides.cash === "bigint"
        ? overrides.cash
        : parse(String(overrides.cash));
  const receipt = overrides.receipt ?? {
    status: 1,
    blockNumber: 900,
    logs: [],
  };

  const mUsdcRead = {
    getCash: async () => {
      calls.getCashPublic++;
      if (overrides.failPublicGetCash) throw new Error("rate limit");
      return cashValue;
    },
  };

  const tx = {
    hash: "0xSENTINEL",
    wait: overrides.txWait ?? (async () => receipt),
  };

  const mUsdc = {
    interface: {
      parseLog: (entry) =>
        entry && entry.__failure
          ? { name: "Failure", args: { errorCode: 2n, info: 0n } }
          : entry
            ? { name: "Transfer", args: {} }
            : null,
    },
    getCash: async () => {
      calls.getCashAlchemy++;
      return cashValue;
    },
    redeemUnderlying: async () => {
      calls.redeem++;
      return tx;
    },
  };

  const provider = {
    getTransaction:
      overrides.getTransaction ?? (async () => ({ blockNumber: null })),
    getTransactionReceipt:
      overrides.getTransactionReceipt ?? (async () => receipt),
    removeAllListeners: () => {
      calls.removedListeners++;
    },
    destroy: async () => {
      calls.destroyed++;
    },
  };

  const processExit = () => {
    calls.exit++;
  };

  const env = {
    WITHDRAW_AMOUNT: overrides.fullBalance
      ? undefined
      : String(overrides.targetUsd ?? 500),
    MIN_CHUNK: String(overrides.minChunkUsdc ?? 5),
    TX_TIMEOUT_MS: String(overrides.txTimeoutMs ?? 60),
  };
  if (overrides.chunkCapSource) env.CHUNK_CAP_SOURCE = overrides.chunkCapSource;
  if (overrides.balanceInterval !== undefined)
    env.BALANCE_MONITOR_INTERVAL = String(overrides.balanceInterval);
  const config = loadConfig(env);

  // The "known balance" seeds the chunk cap; in full-balance mode (no target)
  // it is also the remaining amount, since remainingRaw ≡ knownBalanceRaw.
  const initialBalUsd = overrides.fullBalance
    ? overrides.initialBalanceUsd ?? 100
    : overrides.initialBalanceUsd ?? overrides.targetUsd ?? 500;
  const initialBalanceRaw = parse(String(initialBalUsd));

  const readBalance =
    overrides.readBalance ??
    (async () => parse(String(overrides.freshBalance ?? initialBalUsd)));

  const runner = createChunkRunner({
    mUsdc,
    mUsdcRead,
    provider,
    config,
    initialBalanceRaw,
    readBalance,
    log,
    processExit,
  });

  return {
    runner,
    calls,
    logs,
    warns,
    errors,
    log,
    mUsdc,
    mUsdcRead,
    provider,
    config,
  };
}

// ---------------------------------------------------------------------------
// Config & startup diagnostics
// ---------------------------------------------------------------------------

test("loadConfig applies its defaults", () => {
  const c = loadConfig({});
  assert.equal(c.wssUrl, "PASTE_YOUR_WSS_URL_HERE");
  assert.equal(c.readRpcUrl, "https://base.drpc.org");
  assert.equal(c.privateKey, "PASTE_YOUR_PRIVATE_KEY_HERE");
  assert.equal(c.mUsdcAddress, bot.DEFAULT_MUSDC_ADDRESS);
  assert.equal(c.totalTarget, null);
  assert.equal(c.minChunkUsdc, 5);
  assert.equal(c.txTimeoutMs, 60000);
  assert.equal(c.usdcDecimals, 6);
  assert.equal(c.gasTiers, DEFAULT_GAS_TIERS);
  assert.equal(c.balanceMonitorIntervalMs, 60000, "default: monitor every 60 s");
  assert.equal(c.chunkCapSource, "monitor");
});

test("loadConfig reads values from the env map", () => {
  const c = loadConfig({
    BASE_WSS_URL: "wss://alchemy.example/v2/abc",
    BASE_READ_RPC_URL: "https://rpc.example",
    PRIVATE_KEY: "0x1234",
    MUSDC_ADDRESS: "0xabcd",
    WITHDRAW_AMOUNT: "70000.5",
    MIN_CHUNK: "2",
    TX_TIMEOUT_MS: "5000",
    BALANCE_MONITOR_INTERVAL: "120",
    CHUNK_CAP_SOURCE: "fresh",
  });
  assert.equal(c.wssUrl, "wss://alchemy.example/v2/abc");
  assert.equal(c.readRpcUrl, "https://rpc.example");
  assert.equal(c.privateKey, "0x1234");
  assert.equal(c.mUsdcAddress, "0xabcd");
  assert.equal(c.totalTarget, 70000.5);
  assert.equal(c.minChunkUsdc, 2);
  assert.equal(c.txTimeoutMs, 5000);
  assert.equal(c.balanceMonitorIntervalMs, 120);
  assert.equal(c.chunkCapSource, "fresh");
});

test("loadConfig: balance monitor can be disabled with 0", () => {
  const c = loadConfig({ BALANCE_MONITOR_INTERVAL: "0" });
  assert.equal(c.balanceMonitorIntervalMs, 0);
});

test("loadConfig: an unknown CHUNK_CAP_SOURCE falls back to monitor", () => {
  const c = loadConfig({ CHUNK_CAP_SOURCE: "bogus" });
  assert.equal(c.chunkCapSource, "monitor");
});

test("checkPlaceholders flags missing secrets", () => {
  const errs = checkPlaceholders(loadConfig({}));
  assert.deepEqual(errs.sort(), ["BASE_WSS_URL", "PRIVATE_KEY"]);
});

test("checkPlaceholders accepts real values", () => {
  const c = loadConfig({
    PRIVATE_KEY: "0x1111",
    BASE_WSS_URL: "wss://alchemy.example/v2/abc",
  });
  assert.deepEqual(checkPlaceholders(c), []);
});

test("maskUrl hides the API key but keeps the host readable", () => {
  const m = maskUrl("wss://base-mainnet.g.alchemy.com/v2/SuperSecretKey123");
  assert.equal(m, "wss://base-mainnet.g.alchemy.com/v2/***");
  assert.ok(!m.includes("SuperSecretKey123"));
});

test("maskUrl leaves an URL without path untouched", () => {
  assert.equal(maskUrl("https://base.drpc.org"), "https://base.drpc.org/");
});

test("logStartupParameters prints the mUSDC address and key values", () => {
  const lines = [];
  logStartupParameters(
    loadConfig({ MUSDC_ADDRESS: "0xDEADBEEF", WITHDRAW_AMOUNT: "700" }),
    { walletAddress: "0xWallet" },
    { log: (m) => lines.push(String(m)) },
  );
  const all = lines.join("\n");
  assert.ok(all.includes("0xDEADBEEF"), "mUSDC address must be visible");
  assert.ok(all.includes("0xWallet"), "wallet address must be visible");
  assert.ok(all.includes("700 USDC"), "target must be shown");
  assert.ok(all.includes("MIN_CHUNK"));
  assert.ok(all.includes("CHUNK_CAP_SOURCE"));
});

// ---------------------------------------------------------------------------
// Gas tiers
// ---------------------------------------------------------------------------

test("getGasForChunk selects the correct tier per chunk size", () => {
  const big = getGasForChunk(500, DEFAULT_GAS_TIERS);
  assert.equal(ethers.formatUnits(big.maxPriorityFeePerGas, "gwei"), "0.3");
  assert.equal(ethers.formatUnits(big.maxFeePerGas, "gwei"), "0.6");

  const atHundred = getGasForChunk(100, DEFAULT_GAS_TIERS);
  assert.equal(
    ethers.formatUnits(atHundred.maxPriorityFeePerGas, "gwei"),
    "0.3",
  );

  const atThirty = getGasForChunk(30, DEFAULT_GAS_TIERS);
  assert.equal(
    ethers.formatUnits(atThirty.maxPriorityFeePerGas, "gwei"),
    "0.1",
  );
  assert.equal(ethers.formatUnits(atThirty.maxFeePerGas, "gwei"), "0.3");

  const dust = getGasForChunk(0.5, DEFAULT_GAS_TIERS);
  assert.equal(ethers.formatUnits(dust.maxPriorityFeePerGas, "gwei"), "0.02");
  assert.equal(ethers.formatUnits(dust.maxFeePerGas, "gwei"), "0.1");
});

test("getGasForChunk falls back to the cheapest tier on no match", () => {
  const t = getGasForChunk(-5, DEFAULT_GAS_TIERS);
  assert.equal(ethers.formatUnits(t.maxFeePerGas, "gwei"), "0.1");
});

// ---------------------------------------------------------------------------
// withTimeout (P1)
// ---------------------------------------------------------------------------

test("withTimeout resolves with the value when the promise settles first", async () => {
  const res = await withTimeout(Promise.resolve(42), 1000);
  assert.deepEqual(res, { timedOut: false, value: 42 });
});

test("withTimeout flags a timeout for a promise that never settles", async () => {
  const res = await withTimeout(new Promise(() => {}), 10);
  assert.deepEqual(res, { timedOut: true });
});

test("withTimeout propagates rejections unchanged", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("boom")), 1000),
    /boom/,
  );
});

// ---------------------------------------------------------------------------
// getTxStatus (P1)
// ---------------------------------------------------------------------------

test("getTxStatus: pending when no blockNumber yet", async () => {
  const provider = { getTransaction: async () => ({ blockNumber: null }) };
  assert.equal(await getTxStatus(provider, "0x1"), "pending");
});

test("getTxStatus: mined when a blockNumber is set", async () => {
  const provider = { getTransaction: async () => ({ blockNumber: 900 }) };
  assert.equal(await getTxStatus(provider, "0x1"), "mined");
});

test("getTxStatus: dropped when the node no longer knows the tx", async () => {
  const provider = { getTransaction: async () => null };
  assert.equal(await getTxStatus(provider, "0x1"), "dropped");
});

test("getTxStatus: unknown on provider error", async () => {
  const provider = {
    getTransaction: async () => {
      throw new Error("connection lost");
    },
  };
  assert.equal(await getTxStatus(provider, "0x1"), "unknown");
});

// ---------------------------------------------------------------------------
// computeChunk
// ---------------------------------------------------------------------------

test("computeChunk caps the chunk to the remaining target", () => {
  const r = computeChunk(parse("1000"), parse("300"), parse("5"));
  assert.equal(r.amount, parse("300"));
  assert.equal(r.belowMin, false);
});

test("computeChunk uses whatever cash is available when it is smaller", () => {
  const r = computeChunk(parse("2"), parse("300"), parse("5"));
  assert.equal(r.amount, parse("2"));
  assert.equal(r.belowMin, true);
});

test("computeChunk returns zero for zero cash", () => {
  const r = computeChunk(0n, parse("300"), parse("5"));
  assert.equal(r.amount, 0n);
  assert.equal(r.belowMin, false);
});

test("computeChunk caps the chunk at the known balance when it is smallest", () => {
  const r = computeChunk(parse("1000"), parse("300"), parse("5"), parse("50"));
  assert.equal(r.amount, parse("50"));
  assert.equal(r.belowMin, false);
});

test("computeChunk leaves the chunk alone when the balance cap is omitted", () => {
  const r = computeChunk(parse("1000"), parse("300"), parse("5"));
  assert.equal(r.amount, parse("300"));
});

// ---------------------------------------------------------------------------
// createChunkRunner — happy paths
// ---------------------------------------------------------------------------

test("runner: a successful chunk decrements remainingRaw and frees the guard", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 100 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
  assert.equal(d.runner.state.processedRaw, parse("100"));
  assert.equal(d.runner.state.knownBalanceRaw, parse("400"));
  assert.equal(d.runner.state.remainingRaw, parse("400"));
  assert.equal(d.runner.state.txInFlight, false);
  assert.equal(d.warns.length, 0);
  assert.equal(d.errors.length, 0);
});

test("runner: zero liquidity does not submit anything", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 0 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 0);
  assert.equal(d.runner.state.txInFlight, false);
});

test("runner: a chunk below MIN_CHUNK does not submit anything", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 1 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 0);
  assert.equal(d.runner.state.txInFlight, false);
});

test("runner: public RPC failure falls back to Alchemy", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 100, failPublicGetCash: true });
  await d.runner.attemptChunk();

  assert.equal(d.calls.getCashPublic, 1);
  assert.equal(d.calls.getCashAlchemy, 1);
  assert.equal(d.calls.redeem, 1);
  assert.equal(d.runner.state.remainingRaw, parse("400"));
  assert.ok(d.warns.some((w) => /falling back/.test(w)));
});

test("runner: a reverted receipt is logged and NOT decremented", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    receipt: { status: 0, blockNumber: 900, logs: [] },
  });
  await d.runner.attemptChunk();

  assert.equal(d.runner.state.remainingRaw, parse("500"));
  assert.equal(d.runner.state.txInFlight, false);
  assert.ok(d.errors.some((e) => /FAILED|reverted/.test(e)));
});

test("runner: a Compound Failure event means no decrement", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    receipt: { status: 1, blockNumber: 900, logs: [{ __failure: true }] },
  });
  await d.runner.attemptChunk();

  assert.equal(d.runner.state.remainingRaw, parse("500"));
  assert.equal(d.runner.state.txInFlight, false);
  assert.ok(d.errors.some((e) => /Failure/.test(e)));
});

test("runner: completing the target exits cleanly", async () => {
  const d = makeDeps({ targetUsd: 100, cash: 100 });
  await d.runner.attemptChunk();

  assert.equal(d.runner.state.processedRaw, parse("100"));
  assert.equal(d.runner.state.knownBalanceRaw, 0n);
  assert.equal(d.runner.state.remainingRaw, 0n);
  assert.equal(d.runner.state.stopped, true);
  assert.equal(d.calls.exit, 1);
  assert.equal(d.calls.removedListeners, 1);
  assert.equal(d.calls.destroyed, 1);
  assert.equal(d.runner.state.txInFlight, false);
});

// ---------------------------------------------------------------------------
// P2 — the txInFlight guard must be held before the first await
// ---------------------------------------------------------------------------

test("P2: two concurrent attemptChunk calls submit exactly one tx", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const d = makeDeps({ targetUsd: 500 });

  // Both providers block on the same gate so the two calls would overlap if
  // the guard were placed too late (as it was before the fix).
  d.mUsdcRead.getCash = () => gate.then(() => parse("100"));
  d.mUsdc.getCash = () => gate.then(() => parse("100"));

  const p1 = d.runner.attemptChunk();
  const p2 = d.runner.attemptChunk(); // fired while p1 is awaiting getCash
  release();
  await Promise.all([p1, p2]);

  assert.equal(d.calls.redeem, 1, "exactly one submission, no same-nonce race");
  assert.equal(d.runner.state.txInFlight, false);
  assert.equal(d.runner.state.remainingRaw, parse("400"));
});

// ---------------------------------------------------------------------------
// P1 — a transaction that never gets mined must not stall the bot
// ---------------------------------------------------------------------------

test("P1: tx pending forever → warn, free the guard, do NOT decrement, keep going", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    txTimeoutMs: 30,
    txWait: () => new Promise(() => {}), // never mines
    getTransaction: async () => ({ blockNumber: null }), // still pending
  });

  const t0 = Date.now();
  await d.runner.attemptChunk();
  assert.ok(Date.now() - t0 >= 25, "must really wait for the timeout");

  assert.equal(d.calls.redeem, 1);
  assert.equal(d.runner.state.txInFlight, false, "guard must be freed");
  assert.equal(
    d.runner.state.remainingRaw,
    parse("500"),
    "nothing decremented",
  );
  assert.equal(d.calls.exit, 0);
  assert.ok(
    d.warns.some((w) => /not mined/.test(w)),
    "must log a warning",
  );
});

test("P1: tx mined just after the timeout is still processed", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    txTimeoutMs: 30,
    txWait: () => new Promise(() => {}),
    getTransaction: async () => ({ blockNumber: 900 }), // mined right after
    getTransactionReceipt: async () => ({
      status: 1,
      blockNumber: 900,
      logs: [],
    }),
  });

  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
  assert.equal(
    d.runner.state.remainingRaw,
    parse("400"),
    "receipt processed normally",
  );
  assert.equal(d.runner.state.txInFlight, false);
});

test("P1: tx dropped from the mempool → warn, no decrement, guard freed", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    txTimeoutMs: 30,
    txWait: () => new Promise(() => {}),
    getTransaction: async () => null,
  });

  await d.runner.attemptChunk();

  assert.equal(d.runner.state.remainingRaw, parse("500"));
  assert.equal(d.runner.state.txInFlight, false);
  assert.equal(d.calls.exit, 0);
  assert.ok(
    d.warns.some((w) => /dropped/.test(w)),
    "must log a warning",
  );
});

test("P1: a second attempt after a timeout submits a new tx (bot recovered)", async () => {
  const pendingReject = { txWait: () => new Promise(() => {}) };
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    txTimeoutMs: 20,
    ...pendingReject,
    getTransaction: async () => ({ blockNumber: null }),
  });

  await d.runner.attemptChunk(); // times out → guard freed, nothing decremented
  assert.equal(d.runner.state.remainingRaw, parse("500"));

  // Next block: liquidity is still there → the bot should submit again.
  d.mUsdc.redeemUnderlying = async () => {
    d.calls.redeem++;
    return {
      hash: "0xSECOND",
      wait: async () => ({ status: 1, blockNumber: 901, logs: [] }),
    };
  };
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 2, "bot retries the next block");
  assert.equal(d.runner.state.remainingRaw, parse("400"));
  assert.equal(d.runner.state.txInFlight, false);
});

// ---------------------------------------------------------------------------
// Re-synchro solde → chunk (mode solde complet et cible fixe)
// ---------------------------------------------------------------------------

test("runner: full-balance mode — remainingRaw derives from the known balance", async () => {
  const d = makeDeps({ fullBalance: true, cash: 40 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
  assert.equal(d.runner.state.processedRaw, parse("40"));
  assert.equal(d.runner.state.knownBalanceRaw, parse("60"));
  assert.equal(
    d.runner.state.remainingRaw,
    parse("60"),
    "remaining ≡ known balance in full mode",
  );
  assert.equal(d.runner.state.stopped, false, "still 60 to go");
});

test("runner: full-balance mode stops when the balance reaches zero", async () => {
  const d = makeDeps({ fullBalance: true, cash: 100 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
  assert.equal(d.runner.state.processedRaw, parse("100"));
  assert.equal(d.runner.state.knownBalanceRaw, 0n);
  assert.equal(d.runner.state.remainingRaw, 0n);
  assert.equal(d.runner.state.stopped, true);
  assert.equal(d.calls.exit, 1);
});

test("runner: full-balance mode with a zero balance is done immediately", async () => {
  const d = makeDeps({ fullBalance: true, initialBalanceUsd: 0, cash: 100 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 0);
  assert.equal(d.runner.state.remainingRaw, 0n);
  assert.equal(d.runner.state.stopped, true);
  assert.equal(d.calls.exit, 1);
});

test("balance wiring: a monitor read updates knownBalance when idle but is ignored while a chunk is in flight", async () => {
  const d = makeDeps({ targetUsd: 500 });
  const wiring = createBalanceWiring(d.runner);

  wiring(parse("130")); // idle → external deposit picked up
  assert.equal(d.runner.state.knownBalanceRaw, parse("130"));

  d.runner.state.txInFlight = true;
  wiring(parse("999")); // in-flight → must NOT overwrite (can't know if our tx mined)
  assert.equal(d.runner.state.knownBalanceRaw, parse("130"));

  d.runner.state.txInFlight = false;
  await d.runner.attemptChunk(); // known 130, target 500, cash 100
  assert.equal(d.runner.state.processedRaw, parse("100"));
  assert.equal(d.runner.state.knownBalanceRaw, parse("30"));
});

test("runner: full-balance mode — an external deposit is withdrawn on later rounds", async () => {
  const d = makeDeps({ fullBalance: true, cash: 40 });
  await d.runner.attemptChunk();
  assert.equal(d.runner.state.remainingRaw, parse("60"));

  // External deposit of +50 while idle, pushed as the monitor would:
  createBalanceWiring(d.runner)(parse("110"));
  assert.equal(
    d.runner.state.remainingRaw,
    parse("110"),
    "full mode follows the balance",
  );

  d.mUsdcRead.getCash = async () => parse("100");
  d.mUsdc.getCash = async () => parse("100");
  await d.runner.attemptChunk();

  assert.equal(d.runner.state.processedRaw, parse("140")); // 40 + 100
  assert.equal(d.runner.state.knownBalanceRaw, parse("10"));
  assert.equal(d.runner.state.remainingRaw, parse("10"));
  assert.equal(d.runner.state.stopped, false);
});

test("runner: fixed target — external withdrawal drops the balance; chunk is capped at it and the bot keeps going", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 100 });
  // Monitor read while idle: the balance fell to 30 (manual withdrawal).
  createBalanceWiring(d.runner)(parse("30"));

  d.mUsdcRead.getCash = async () => parse("50");
  d.mUsdc.getCash = async () => parse("50");
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
  assert.equal(
    d.runner.state.processedRaw,
    parse("30"),
    "chunk capped at the balance",
  );
  assert.equal(d.runner.state.remainingRaw, parse("470"), "target − processed");
  assert.equal(d.runner.state.knownBalanceRaw, 0n);
  assert.equal(d.runner.state.stopped, false, "keeps trying — target not reached");
});

test("runner: CHUNK_CAP_SOURCE=fresh reads the balance every round and caps the chunk", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    chunkCapSource: "fresh",
    freshBalance: 80,
  });
  await d.runner.attemptChunk();

  assert.equal(d.runner.state.capSource, "fresh");
  assert.equal(d.runner.state.processedRaw, parse("80"));
  assert.equal(
    d.runner.state.knownBalanceRaw,
    0n,
    "fresh 80 fully redeemed in this round",
  );
  assert.equal(d.runner.state.remainingRaw, parse("420"));
});

test("runner: cap source 'monitor' with the monitor disabled falls back to fresh", async () => {
  const d = makeDeps({
    targetUsd: 500,
    cash: 100,
    chunkCapSource: "monitor",
    balanceInterval: 0,
  });
  assert.equal(d.runner.state.capSource, "fresh");
  assert.ok(
    d.warns.some((w) => /falling back to reading the balance fresh/i.test(w)),
    "must warn that it fell back",
  );
  // It still caps the chunk off a fresh read:
  await d.runner.attemptChunk();
  assert.equal(d.runner.state.processedRaw, parse("100"));
});

// ---------------------------------------------------------------------------
// createBalanceMonitor — periodic re-read of the redeemable balance
// ---------------------------------------------------------------------------

/** Build a monitor with captured logs. `failingRead: true` makes reads throw. */
function makeMonitor(overrides = {}) {
  const logs = [];
  const warns = [];
  const log = {
    log: (msg) => logs.push(String(msg)),
    warn: (msg) => warns.push(String(msg)),
    error: () => {},
  };
  const balanceOf = overrides.failingRead
    ? async () => {
        throw new Error("rpc down");
      }
    : async () => overrides.balance ?? parse("100");
  const mUsdcRead = {
    balanceOfUnderlying: { staticCall: balanceOf },
  };
  const monitor = createBalanceMonitor({
    mUsdcRead,
    walletAddress: "0xWallet",
    intervalMs: overrides.intervalMs ?? 60_000,
    initialRaw: overrides.initialRaw ?? parse("100"),
    log,
    onBalanceRead: overrides.onBalanceRead ?? (() => {}),
    lpDecimals: overrides.lpDecimals ?? null,
    setTimer: overrides.setTimer ?? (() => "TIMER"),
    clearTimer: overrides.clearTimer ?? (() => {}),
  });
  return { monitor, logs, warns, mUsdcRead };
}

test("balance monitor: unchanged balance logs a stable message", async () => {
  const { monitor, logs } = makeMonitor({ balance: parse("100") });
  await monitor.read();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("inchangé"));
  assert.ok(logs[0].includes("100"));
});

test("balance monitor: a balance increase is flagged as an external change", async () => {
  // baseline logged first (no delta), then the change
  const { monitor, logs, mUsdcRead } = makeMonitor({});
  mUsdcRead.balanceOfUnderlying.staticCall = async () => parse("120");
  await monitor.read();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("+20"));
  assert.ok(logs[0].includes("changement externe"));
});

test("balance monitor: a balance decrease is flagged with a minus sign", async () => {
  const { monitor, logs, mUsdcRead } = makeMonitor({
    initialRaw: parse("100"),
  });
  mUsdcRead.balanceOfUnderlying.staticCall = async () => parse("90");
  await monitor.read();
  assert.ok(logs[0].includes("-10"));
});

test("balance monitor: disabled when interval is 0 (no timer started)", () => {
  const { monitor } = makeMonitor({
    intervalMs: 0,
    setTimer: () => {
      throw new Error("setTimer must not be called when disabled");
    },
  });
  // must not throw
  monitor.start();
});

test("balance monitor: start() schedules reads on the injected timer", () => {
  let captured = null;
  let ms = -1;
  const { monitor } = makeMonitor({
    setTimer: (cb, delay) => {
      captured = cb;
      ms = delay;
      return "TMR";
    },
  });
  monitor.start();
  assert.equal(typeof captured, "function");
  assert.equal(ms, 60_000);
});

test("balance monitor: onBalanceRead receives each successful read", async () => {
  const seen = [];
  const { monitor } = makeMonitor({
    balance: parse("77"),
    onBalanceRead: (raw) => seen.push(raw),
  });
  await monitor.read();
  assert.deepEqual(seen, [parse("77")]);
});

test("balance monitor: repeated read failures warn and stop the monitor", async () => {
  let cleared = 0;
  const { monitor, warns } = makeMonitor({
    failingRead: true,
    clearTimer: () => {
      cleared++;
    },
  });
  monitor.start();
  for (let i = 0; i < 5; i++) await monitor.read();
  assert.equal(warns.length, 5);
  assert.ok(warns.some((w) => /arrêté/.test(w)), "monitor must announce it stops");
  assert.equal(cleared, 1, "timer must be cleared once when giving up");
});

test("balance monitor: LP-token balance appears on the balance line", async () => {
  const { monitor, logs, mUsdcRead } = makeMonitor({
    balance: parse("100"),
    lpDecimals: 6,
  });
  mUsdcRead.balanceOf = { staticCall: async () => parse("100") };
  await monitor.read();
  assert.ok(
    logs[0].includes("| LP tokens: 100.0"),
    "LP-token balance formatted with lpDecimals",
  );
});

test("balance monitor: a failing LP read degrades to n/a without killing the read", async () => {
  const { monitor, logs } = makeMonitor({ balance: parse("100"), lpDecimals: 6 });
  await monitor.read();
  assert.ok(logs[0].includes("| LP tokens: n/a"));
  assert.ok(logs[0].includes("USDC"), "underlying balance line still logged");
});

// ---------------------------------------------------------------------------
// createWssWatchdog — surveillance + reconnexion de la connexion WSS (P3)
// ---------------------------------------------------------------------------

/**
 * Build a watchdog with captured logs, an injectable clock, a mock provider
 * (with `.on/.off` and `.websocket`) and a mock process.exit. `step(ms)`
 * advances the fake clock, `fire()` triggers one heartbeat tick and lets the
 * onReconnect microtasks settle, `block()` signals a received block.
 */
function makeWatchdog(overrides = {}) {
  const logs = [];
  const warns = [];
  const errors = [];
  const log = {
    log: (m) => logs.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => errors.push(String(m)),
  };
  let fakeNow = overrides.now ?? 1_000_000;
  let hb = null;
  let checkDelay = -1;
  let cleared = 0;
  const setTimer = (cb, delay) => {
    hb = cb;
    checkDelay = delay;
    return "TMR";
  };
  const clearTimer = () => {
    cleared++;
  };
  const listeners = { block: [], error: [], close: [] };
  const provider = {
    on: (ev, cb) => (listeners[ev] = listeners[ev] || []).push(cb),
    off: (ev, cb) => {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter((f) => f !== cb);
    },
    websocket: {
      on: (ev, cb) => (listeners[ev] = listeners[ev] || []).push(cb),
      off: (ev, cb) => {
        if (!listeners[ev]) return;
        listeners[ev] = listeners[ev].filter((f) => f !== cb);
      },
    },
  };
  const exitCalls = [];
  const processExit = (code) => exitCalls.push(code);
  let reconnectCalls = 0;
  const wd = createWssWatchdog({
    provider,
    url: overrides.url ?? "wss://alchemy.example/v2/SuperSecretKey123",
    log,
    now: () => fakeNow,
    setTimer,
    clearTimer,
    maskUrlFn: maskUrl,
    silenceTimeoutMs: overrides.silenceTimeoutMs ?? 15_000,
    checkIntervalMs: overrides.checkIntervalMs ?? 5_000,
    maxReconnects: overrides.maxReconnects ?? 5,
    reconnect: overrides.reconnect ?? true,
    onReconnect:
      overrides.onReconnect ??
      (async () => {
        reconnectCalls++;
      }),
    shouldReconnect: overrides.shouldReconnect ?? (() => true),
    processExit,
  });
  return {
    wd,
    provider,
    listeners,
    logs,
    warns,
    errors,
    exitCalls,
    reconnectCalls: () => reconnectCalls,
    checkDelay,
    cleared: () => cleared,
    step: (ms) => {
      fakeNow += ms;
    },
    fire: async () => {
      hb();
      // Drainage complet des microtâches: reset() (chaînée après onReconnect)
      // doit être terminé avant le prochain heartbeat, comme en prod où les ticks
      // sont espacés de checkIntervalMs.
      await new Promise((resolve) => setImmediate(resolve));
    },
    block: () => wd.tick(),
  };
}

test("watchdog: provider error → warn immédiat sans fuite de clé", () => {
  const t = makeWatchdog({});
  t.listeners.error[0](new Error("ECONNRESET"));
  assert.equal(t.warns.length, 1);
  assert.ok(t.warns[0].includes("erreur détectée"));
  assert.ok(
    !t.warns[0].includes("SuperSecretKey123"),
    "la clé API ne doit jamais apparaître",
  );
  assert.equal(t.wd.state.socketDown, false, "le heartbeat reste l'autorité");
});

test("watchdog: websocket close → warn masqué + socketDown", () => {
  const t = makeWatchdog({});
  t.listeners.close[0]();
  assert.equal(t.warns.length, 1);
  assert.ok(t.warns[0].includes("v2/***"), "URL masquée");
  assert.ok(!t.warns[0].includes("SuperSecretKey123"));
  assert.equal(t.wd.state.socketDown, true);
});

test("watchdog: heartbeat détecte le stall et déclenche onReconnect une fois par cycle", async () => {
  const t = makeWatchdog({});
  assert.equal(t.checkDelay, 5_000, "heartbeat à checkIntervalMs");

  t.step(20_000); // silence au-delà de 15 s
  await t.fire();
  assert.equal(t.reconnectCalls(), 1, "onReconnect appelé une fois");
  assert.equal(t.wd.state.reconnectCount, 1);
  assert.ok(
    t.warns.some((w) => /tentative de reconnexion/.test(w)),
    "warn avant la tentative",
  );

  // reset() a ré-armé l'horloge : sans nouveau temps, pas de 2e appel
  await t.fire();
  assert.equal(t.reconnectCalls(), 1);

  // nouveau cycle de silence → 2e tentative
  t.step(20_000);
  await t.fire();
  assert.equal(t.reconnectCalls(), 2);
  assert.equal(t.wd.state.reconnectCount, 2);
});

test("watchdog: reset vide l'état de stall mais conserve le budget", async () => {
  const t = makeWatchdog({});
  t.step(20_000);
  await t.fire();
  assert.equal(t.wd.state.reconnectCount, 1);

  t.wd.reset();
  assert.equal(t.wd.state.stallActive, false);
  assert.equal(t.wd.state.stallCount, 0);
  assert.equal(t.wd.state.socketDown, false);
  assert.equal(t.wd.state.reconnectCount, 1, "budget conservé");
});

test("watchdog: budget maxReconnects épuisé → process.exit(1) une seule fois", async () => {
  const t = makeWatchdog({ maxReconnects: 3 });
  for (let i = 0; i < 4; i++) {
    t.step(20_000);
    await t.fire();
  }
  assert.equal(t.reconnectCalls(), 3, "3 tentatives avant l'abandon");
  assert.deepEqual(t.exitCalls, [1]);
  assert.equal(t.wd.state.reconnectCount, 3);

  // encore du silence → rien de plus (exited déjà posé)
  t.step(20_000);
  await t.fire();
  assert.equal(t.reconnectCalls(), 3);
  assert.equal(t.exitCalls.length, 1, "process.exit appelé une seule fois");
});

test("watchdog: WS_ON_STALL=exit → pas de reconnexion, process.exit(1) sur stall", async () => {
  const t = makeWatchdog({ reconnect: false });
  t.step(20_000);
  await t.fire();
  assert.deepEqual(t.exitCalls, [1]);
  assert.equal(t.reconnectCalls(), 0, "aucune tentative");
  assert.ok(t.errors[0].includes("WS_ON_STALL=exit"), "message explicite");
});

test("watchdog: mode exit → arrêt immédiat lors de la fermeture du socket", () => {
  const t = makeWatchdog({ reconnect: false });
  t.listeners.close[0]();
  assert.deepEqual(t.exitCalls, [1]);
  assert.equal(t.reconnectCalls(), 0);
});

test("watchdog: reconnexion différée (tx en vol) sans consommer le budget", async () => {
  let allow = false;
  const t = makeWatchdog({ shouldReconnect: () => allow });
  t.step(20_000);
  await t.fire();
  assert.equal(t.reconnectCalls(), 0, "différée tant que tx en vol");
  assert.equal(t.wd.state.reconnectCount, 0, "budget non consommé");
  assert.ok(t.warns.some((w) => /différée/.test(w)));
  assert.equal(t.exitCalls.length, 0);

  // la tx se pose, puis un nouveau cycle de silence relaie la reconnexion
  allow = true;
  t.step(20_000);
  await t.fire();
  assert.equal(t.reconnectCalls(), 1);
  assert.equal(t.wd.state.reconnectCount, 1);
});

test("watchdog: setProvider rebranche sur un nouveau provider sans crash", () => {
  const t = makeWatchdog({});
  const fresh = {
    on: (ev, cb) => (t.listeners[ev] = t.listeners[ev] || []).push(cb),
    off: (ev, cb) => {
      if (!t.listeners[ev]) return;
      t.listeners[ev] = t.listeners[ev].filter((f) => f !== cb);
    },
    websocket: {
      on: (ev, cb) => (t.listeners[ev] = t.listeners[ev] || []).push(cb),
      off: (ev, cb) => {
        if (!t.listeners[ev]) return;
        t.listeners[ev] = t.listeners[ev].filter((f) => f !== cb);
      },
    },
  };
  t.wd.setProvider(fresh);
  t.block(); // un block sur le provider frais relance le heartbeat
  assert.equal(t.wd.state.socketDown, false);
});

test("runner: setConnection swap la cible de soumission et le destroy", async () => {
  const d = makeDeps({ targetUsd: 100, cash: 100 });
  const mcalls = { redeem: 0, removeAll: 0, destroy: 0 };
  const receipt1 = { status: 1, blockNumber: 950, logs: [] };
  const m1 = {
    interface: { parseLog: () => null },
    getCash: async () => parse("100"),
    redeemUnderlying: async () => {
      mcalls.redeem++;
      return { hash: "0xNEW", wait: async () => receipt1 };
    },
  };
  const p1 = {
    getTransaction: async () => ({ blockNumber: 900 }),
    getTransactionReceipt: async () => receipt1,
    removeAllListeners: () => {
      mcalls.removeAll++;
    },
    destroy: async () => {
      mcalls.destroy++;
    },
  };

  d.runner.setConnection({ mUsdc: m1, provider: p1 });
  d.runner.setConnection({ mUsdc: m1, provider: p1 }); // idempotent
  await d.runner.attemptChunk();

  assert.equal(mcalls.redeem, 1, "soumission via le nouveau mUsdc");
  assert.equal(d.calls.redeem, 0, "l'ancien mUsdc n'est plus touché");
  assert.equal(d.calls.getCashPublic, 1, "mUsdcRead (lecture seule) inchangé");
  assert.equal(d.runner.state.remainingRaw, 0n);
  assert.equal(d.runner.state.stopped, true);
  assert.equal(d.calls.exit, 1);
  assert.equal(mcalls.destroy, 1, "done() détruit le nouveau provider");
  assert.equal(d.calls.destroyed, 0, "l'ancien provider n'est jamais détruit");
  assert.equal(mcalls.removeAll, 1);
});

test("loadConfig exposes the WSS watchdog knobs (defaults + env)", () => {
  const d = loadConfig({});
  assert.equal(d.wssStallMs, 15000);
  assert.equal(d.wssCheckMs, 5000);
  assert.equal(d.wssMaxReconnects, 5);
  assert.equal(d.wssOnStall, "reconnect");

  const e = loadConfig({
    WS_STALL_MS: "120000",
    WS_CHECK_MS: "30000",
    WS_MAX_RECONNECTS: "2",
    WS_ON_STALL: "exit",
  });
  assert.equal(e.wssStallMs, 120000);
  assert.equal(e.wssCheckMs, 30000);
  assert.equal(e.wssMaxReconnects, 2);
  assert.equal(e.wssOnStall, "exit");

  assert.equal(loadConfig({ WS_STALL_MS: "50" }).wssStallMs, 1000, "clamp min");
  assert.equal(
    loadConfig({ WS_MAX_RECONNECTS: "junk" }).wssMaxReconnects,
    1,
    "valeur invalide ≈ défaut sûr (NaN-safe)",
  );
});