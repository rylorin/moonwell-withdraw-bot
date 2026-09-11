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

  const config = loadConfig({
    WITHDRAW_AMOUNT: String(overrides.targetUsd ?? 500),
    MIN_CHUNK: String(overrides.minChunkUsdc ?? 5),
    TX_TIMEOUT_MS: String(overrides.txTimeoutMs ?? 60),
  });

  const runner = createChunkRunner({
    mUsdc,
    mUsdcRead,
    provider,
    config,
    initialRemainingRaw: parse(overrides.targetUsd ?? 500),
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
  });
  assert.equal(c.wssUrl, "wss://alchemy.example/v2/abc");
  assert.equal(c.readRpcUrl, "https://rpc.example");
  assert.equal(c.privateKey, "0x1234");
  assert.equal(c.mUsdcAddress, "0xabcd");
  assert.equal(c.totalTarget, 70000.5);
  assert.equal(c.minChunkUsdc, 2);
  assert.equal(c.txTimeoutMs, 5000);
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

// ---------------------------------------------------------------------------
// createChunkRunner — happy paths
// ---------------------------------------------------------------------------

test("runner: a successful chunk decrements remainingRaw and frees the guard", async () => {
  const d = makeDeps({ targetUsd: 500, cash: 100 });
  await d.runner.attemptChunk();

  assert.equal(d.calls.redeem, 1);
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
