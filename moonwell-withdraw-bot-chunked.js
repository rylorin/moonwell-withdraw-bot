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
 * - Contract address verified on BaseScan.
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
// Sonde réseau avant d'adopter un socket WSS fraîchement construit : si le
// DNS/socket ne répond pas (par ex. juste après un réveil de veille), on jette
// ce socket et on rejette → le watchdog planifie un retry backoffé.
const HEALTH_CHECK_MS = 5_000;

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
    // Periodic re-read of the redeemable balance (see createBalanceMonitor) so
    // external changes (deposits, partial withdrawals, interest accrual) stay
    // visible. Default 60 s; set to 0 to disable.
    balanceMonitorIntervalMs:
      env.BALANCE_MONITOR_INTERVAL !== undefined
        ? Number(env.BALANCE_MONITOR_INTERVAL) || 0
        : 60_000,
    // Where the per-round "available balance" cap for the redeem chunk comes from:
    //  - "monitor" (default): the value the balance monitor last read (up to one
    //    monitor interval old, then corrected by each confirmed chunk).
    //  - "fresh": a balanceOfUnderlying() staticCall performed on every round.
    chunkCapSource: env.CHUNK_CAP_SOURCE === "fresh" ? "fresh" : "monitor",
    // P3: watchdog WSS — détecte une connexion morte (plus aucun block reçu)
    // et tente une reconnexion au lieu de rester figé silencieusement.
    wssStallMs: env.WS_STALL_MS
      ? Math.max(1_000, Number(env.WS_STALL_MS) || 0)
      : 15_000, // Base émet un block toutes les ~2 s
    wssCheckMs: env.WS_CHECK_MS
      ? Math.max(1_000, Number(env.WS_CHECK_MS) || 0)
      : 5_000,
    wssMaxReconnects: env.WS_MAX_RECONNECTS
      ? Math.max(1, Number(env.WS_MAX_RECONNECTS) || 0)
      : 10, // budget de vie du process, puis process.exit(1)
    // Backoff exponentiel entre les tentatives de reconnexion (5 s, 10 s, 20 s…
    // plafonné à 60 s) : tolère un réseau éphémère — réveil de veille, DNS coupé.
    wssBackoffBaseMs: env.WS_BACKOFF_BASE_MS
      ? Math.max(1_000, Number(env.WS_BACKOFF_BASE_MS) || 0)
      : 5_000,
    wssBackoffMaxMs: env.WS_BACKOFF_MAX_MS
      ? Math.max(1_000, Number(env.WS_BACKOFF_MAX_MS) || 0)
      : 60_000,
    // "reconnect" (défaut) ou "exit" : arrêt immédiat sur stall/fermeture,
    // pour les déploiements pilotés par la politique de redémarrage Docker.
    wssOnStall: env.WS_ON_STALL === "exit" ? "exit" : "reconnect",
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
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
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
  log.log(`  USDC decimals   : ${config.usdcDecimals}`);
  log.log(`  WITHDRAW_AMOUNT : ${targetDesc}`);
  log.log(`  MIN_CHUNK       : ${config.minChunkUsdc}`);
  log.log(`  CHUNK_CAP_SOURCE: ${config.chunkCapSource}`);
  log.log(`  TX timeout      : ${config.txTimeoutMs / 1000} s`);
  log.log(
    `  Balance monitor : ${
      config.balanceMonitorIntervalMs > 0
        ? `toutes les ${config.balanceMonitorIntervalMs / 1000} s`
        : "désactivé"
    }`,
  );
  log.log(
    `  WSS watchdog     : silence ${config.wssStallMs / 1000} s | check ${
      config.wssCheckMs / 1000
    } s | backoff ${config.wssBackoffBaseMs / 1000}→${
      config.wssBackoffMaxMs / 1000
    } s`,
  );
  log.log(
    `  WSS reconnex     : ${config.wssOnStall}${
      config.wssOnStall === "reconnect"
        ? ` (max ${config.wssMaxReconnects} tentatives)`
        : " (arrêt immédiat)"
    }`,
  );
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
 * The chunk = min(available cash, remaining target, known balance). The last
 * cap (`balanceRaw`) is optional so callers without a balance source keep the
 * old behaviour; on-chain amounts are raw BigInts. Pure → unit-testable.
 */
function computeChunk(cash, remainingRaw, minChunkRaw, balanceRaw = null) {
  if (cash <= 0n) return { amount: 0n, belowMin: false };
  let chunk = cash < remainingRaw ? cash : remainingRaw;
  if (balanceRaw !== null && balanceRaw < chunk) chunk = balanceRaw;
  return { amount: chunk, belowMin: chunk < minChunkRaw };
}

/**
 * The heart of the bot: one attempt to redeem one chunk. Everything it talks
 * to (contracts, provider, logger, process.exit) is injected so unit tests can
 * drive it through mocked dependencies.
 *
 * State model (the re-sync design):
 *  - `targetRaw`      : null in full-balance mode, else the fixed target.
 *  - `processedRaw`   : sum of on-chain confirmed chunks (the "montant traité").
 *  - `knownBalanceRaw`: best-known redeemable balance — the chunk cap.
 *  - `remainingRaw`   : DERIVED, never mutated directly —
 *        fixed target   : targetRaw - processedRaw
 *        full balance   : knownBalanceRaw (so external deposits increase the
 *                         goal and manual withdrawals shrink it naturally).
 *
 * `remainingRaw` is exposed as a getter on `state` so tests (and the bot's
 * stop condition) always see the derived value.
 */
function createChunkRunner({
  mUsdc,
  mUsdcRead,
  provider,
  config,
  initialBalanceRaw,
  log = console,
  processExit = process.exit,
  readBalance, // async () => raw balance; required when cap source is "fresh"
}) {
  // P3: connexions actuelles — swappées par setConnection() lors d'une
  // reconnexion WSS. mUsdcRead (lecture seule) n'est jamais rebâti.
  let current = { mUsdc, mUsdcRead, provider };
  const setConnection = (next) => {
    if (next.mUsdc === current.mUsdc && next.provider === current.provider)
      return; // no-op si inchangé
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

  // Resolution of the chunk cap source. "monitor" (the default) needs the
  // periodic balance monitor to exist — if it is disabled there is no "last
  // monitored value", so we fall back to reading fresh each round.
  let capSource;
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

  const state = {
    stopped: false,
    txInFlight: false,
    processedRaw: 0n,
    knownBalanceRaw: initialBalanceRaw,
    capSource,
    get remainingRaw() {
      if (targetRaw === null) {
        return state.knownBalanceRaw < 0n ? 0n : state.knownBalanceRaw;
      }
      const rem = targetRaw - state.processedRaw;
      return rem < 0n ? 0n : rem;
    },
  };

  const done = async () => {
    log.log(
      targetRaw === null
        ? "Redeemable balance fully withdrawn. Done."
        : "Target fully withdrawn. Done.",
    );
    state.stopped = true;
    current.provider.removeAllListeners("block");
    await current.provider.destroy();
    processExit(0);
  };

  const attemptChunk = async () => {
    // P2: hold the guard IMMEDIATELY, before any `await`. attemptChunk is
    // async; between this check and setting txInFlight there must never be an
    // await — Base emits a new block every ~2 s, so two block events could
    // both pass the guard and both call redeemUnderlying() on the same nonce.
    if (state.stopped || state.txInFlight) return;
    state.txInFlight = true;

    try {
      const ts = new Date().toISOString();

      // 1) Balance usable as the chunk cap: a fresh staticCall, or the value
      //    the balance monitor last pushed (up to one monitor interval old).
      let balanceRaw = state.knownBalanceRaw;
      if (capSource === "fresh") {
        if (typeof readBalance !== "function") {
          throw new Error(
            "chunk cap source 'fresh' requires a readBalance() function",
          );
        }
        try {
          balanceRaw = await readBalance();
          state.knownBalanceRaw = balanceRaw;
        } catch (readErr) {
          log.warn(
            `  -> Fresh balance read failed (${readErr.message || readErr}); using known balance ${fmt(state.knownBalanceRaw)}.`,
          );
        }
      }

      // 2) Remaining is derived — stop as soon as it reaches 0, whatever the
      //    pool's cash says. This also covers a zero balance at startup (full
      //    mode) instead of looping forever on "Below MIN_CHUNK".
      if (state.remainingRaw <= 0n) {
        await done();
        return;
      }

      // 3) Liquidity on the market: free public RPC first, Alchemy fallback.
      let cash;
      try {
        cash = await current.mUsdcRead.getCash();
      } catch (readErr) {
        log.warn(
          `  -> Public RPC getCash() failed (${readErr.message || readErr}), falling back to Alchemy for this check.`,
        );
        cash = await current.mUsdc.getCash();
      }

      if (cash === 0n) {
        log.log(`[${ts}] No liquidity available. Waiting...`);
        return;
      }

      const { amount: chunk, belowMin } = computeChunk(
        cash,
        state.remainingRaw,
        minChunkRaw,
        balanceRaw,
      );

      log.log(
        `[${ts}] Liquidity: ${fmt(cash)} | Known balance: ${fmt(
          balanceRaw,
        )} | Remaining: ${fmt(state.remainingRaw)} | Chunk to attempt: ${fmt(
          chunk,
        )}`,
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

      const tx = await current.mUsdc.redeemUnderlying(chunk, {
        maxPriorityFeePerGas,
        maxFeePerGas,
      });
      log.log(`  -> Submitted: ${tx.hash}`);

      // P1: bounded wait. If after `txTimeoutMs` the receipt is still not in,
      // check what really happened on-chain instead of waiting forever. We
      // never touch processedRaw here — if the tx did mine in the end, the
      // next round's successful receipt handles the accounting (worst case: a
      // no-op retry on liquidity that has already shrunken).
      const waitRes = await withTimeout(tx.wait(), config.txTimeoutMs);
      let receipt;
      if (waitRes.timedOut) {
        const status = await getTxStatus(current.provider, tx.hash);
        if (status === "mined") {
          // It mined just past our deadline — process the receipt normally.
          receipt = await current.provider.getTransactionReceipt(tx.hash);
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
        return; // no accounting — nothing was actually redeemed
      }

      // 4) Only here — confirmed on-chain — do we track progress.
      log.log(`  -> Confirmed in block ${receipt.blockNumber}.`);
      state.processedRaw += chunk;
      state.knownBalanceRaw -= chunk;
      if (state.knownBalanceRaw < 0n) state.knownBalanceRaw = 0n;
      log.log(
        `  -> Processed so far: ${fmt(state.processedRaw)} | Remaining to withdraw: ${fmt(state.remainingRaw)} USDC\n`,
      );

      if (state.remainingRaw <= 0n) await done();
    } catch (err) {
      log.error("Error during chunk attempt:", err.message || err);
      // Keep going — transient RPC errors or reverts shouldn't kill the bot.
    } finally {
      state.txInFlight = false;
    }
  };

  return { attemptChunk, state, setConnection };
}

/**
 * Returns the `onBalanceRead` callback to hand to createBalanceMonitor so the
 * monitor's reads feed the runner's knownBalance — but only while no chunk is
 * in flight. A read landing mid-tx cannot know whether that tx already mined,
 * so using it would risk double-counting; instead the tx confirmation applies
 * the exact decrement, and the next idle read resyncs from on-chain truth.
 */
function createBalanceWiring(runner) {
  return (raw) => {
    if (!runner.state.txInFlight) runner.state.knownBalanceRaw = raw;
  };
}

/**
 * Periodically re-reads the redeemable balance (a single cheap staticCall on
 * the free read RPC) and logs it, highlighting changes that did not come from
 * this bot — extra deposits, manual partial withdrawals, interest accrual…
 *
 * It only LOGS (and, via the optional `onBalanceRead` callback, can feed the
 * runner's chunk-capping balance); it never submits transactions. Disabled
 * when intervalMs <= 0. `setTimer`/`clearTimer` are injectable so tests can
 * drive it without real timers. `read()` is the public read+log step (also
 * run by the timer).
 */
function createBalanceMonitor({
  mUsdcRead,
  walletAddress,
  intervalMs,
  log = console,
  initialRaw = null,
  onBalanceRead = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
  lpDecimals = null,
}) {
  let lastRaw = initialRaw;
  let failures = 0;
  let timer = null;

  const stop = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };

  const read = async () => {
    try {
      // .staticCall() forces eth_call — read-only, no signer needed.
      const raw = await mUsdcRead.balanceOfUnderlying.staticCall(walletAddress);
      failures = 0;

      // Best-effort : solde en LP tokens (mToken) affiché sur la même ligne.
      // Si le caller n'a pas fourni les décimales, elles sont résolues depuis
      // le contrat ; tout échec de lecture se dégrade en "n/a" sans bloquer.
      let lpBalance = "";
      try {
        let resolvedDecimals = lpDecimals;
        if (resolvedDecimals === null) {
          resolvedDecimals = await mUsdcRead.decimals.staticCall();
        }
        const lpRaw = await mUsdcRead.balanceOf.staticCall(walletAddress);
        lpBalance = ` | LP tokens: ${ethers.formatUnits(lpRaw, resolvedDecimals)}`;
      } catch {
        lpBalance = " | LP tokens: n/a";
      }

      const ts = new Date().toISOString();
      if (lastRaw !== null && raw !== lastRaw) {
        const delta = raw - lastRaw;
        const sign = delta > 0n ? "+" : "-";
        const abs = delta < 0n ? -delta : delta;
        log.log(
          `[${ts}] [balance] ${fmt(raw)} USDC${lpBalance} (${sign}${fmt(
            abs,
          )} USDC depuis la dernière lecture — changement externe)`,
        );
      } else {
        log.log(`[${ts}] [balance] ${fmt(raw)} USDC${lpBalance} (inchangé)`);
      }
      lastRaw = raw;
      onBalanceRead(raw);
    } catch (err) {
      failures++;
      const giveUp = failures >= 5;
      log.warn(
        `  -> balance read failed (${err.message || err})${
          giveUp ? " — moniteur de solde arrêté après erreurs répétées." : ""
        }`,
      );
      if (giveUp) stop();
    }
  };

  const start = () => {
    if (intervalMs > 0) {
      timer = setTimer(() => {
        read().catch(() => {});
      }, intervalMs);
    }
    return { stop };
  };

  return { start, read, stop };
}

/**
 * P3 — Gardien de la connexion WSS Alchemy.
 *
 * Détecte un socket mort via un heartbeat (plus aucun block reçu depuis
 * `silenceTimeoutMs`), signale immédiatement les événements "error" / "close"
 * (URL masquée — jamais la clé API) et, en mode "reconnect" (défaut), déclenche
 * `onReconnect()` — une fois par cycle de silence, pas à chaque tick — dans la
 * limite du budget `maxReconnects` avant un `processExit(1)` propre. Un échec
 * de reconnexion ne sort PAS en erreur : un retry est planifié après un délai
 * croissant (`backoffBaseMs` ×2 jusqu'à `backoffMaxMs`) — un réseau éphémère
 * (réveil de veille, DNS coupé) a ainsi le temps de revenir. Avec
 * `reconnect: false` (mode "exit" via WS_ON_STALL), tout stall ou close
 * provoque l'arrêt immédiat.
 *
 * Tous les timers, l'horloge et la sortie processus sont injectés → testable
 * sans vrai socket. `tick()` est alimenté par la souscription "block" interne
 * (et peut être appelé de l'extérieur, notamment par les tests).
 */
function createWssWatchdog({
  provider,
  url = "",
  log = console,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  scheduleRetry = (cb, ms) => setTimeout(cb, ms), // one-shot (backoff)
  cancelRetry = (t) => clearTimeout(t),
  maskUrlFn = maskUrl,
  silenceTimeoutMs = 15_000,
  checkIntervalMs = 5_000,
  maxReconnects = 5,
  reconnect = true,
  backoffBaseMs = 5_000, // premier délai après un échec
  backoffMaxMs = 60_000, // plafond du délai (backoff exponentiel)
  backoffFactor = 2, // 5 s → 10 s → 20 s → 40 s → 60 s (cap)
  onReconnect = null, // async () => void — rebâti et re-souscrit (main)
  shouldReconnect = () => true, // main injecte : !runner.state.txInFlight
  processExit = process.exit,
}) {
  const state = {
    socketDown: false, // close event, ou stall en cours
    stallActive: false, // une escalade par cycle de silence
    stallCount: 0, // cycles de silence depuis le dernier reset()
    reconnectCount: 0, // budget cumulé — JAMAIS remis à zéro par reset()
    backoffMs: backoffBaseMs, // délai courant entre deux tentatives
    retryTimer: null, // one-shot en attente après un échec de reconnexion
    lastBlockAt: now(),
  };
  let timer = null;
  let exited = false;
  let boundProvider = null;

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

  const fatal = (msg) => {
    if (exited) return; // ne jamais appeler process.exit deux fois
    exited = true;
    log.error(msg);
    stop();
    processExit(1);
  };

  const myErrorHandler = (err) => {
    const detail = err && (err.code || err.message || "inconnue");
    log.warn(
      `  -> Connexion WSS : erreur détectée (${detail}). Le heartbeat reste actif.`,
    );
  };
  const myCloseHandler = () => {
    state.socketDown = true;
    log.warn(
      `  -> Connexion WSS fermée par le serveur (${
        url ? maskUrlFn(url) : "URL non disponible"
      }). Les events block sont interrompus.`,
    );
    if (!reconnect)
      fatal("  -> WS_ON_STALL=exit — arrêt immédiat à la fermeture du WSS.");
  };

  const reset = () => {
    state.lastBlockAt = now();
    state.stallActive = false;
    state.stallCount = 0;
    state.socketDown = false; // on espère le nouveau socket
    state.backoffMs = backoffBaseMs; // un cycle sain reboote le backoff
    cancelRetryTimer(); // aucun retry one-shot en attente après un reset
    // reconnectCount volontairement conservé : budget de vie du process
  };

  const checkOnce = () => {
    const idleMs = now() - state.lastBlockAt;
    if (idleMs <= silenceTimeoutMs) {
      state.socketDown = false;
      state.stallActive = false;
      return;
    }
    state.socketDown = true;
    if (state.stallActive) return; // déjà escaladé / retry backoffé en cours
    state.stallActive = true;
    state.stallCount++;

    if (!reconnect)
      return fatal(
        `  -> Aucun block reçu depuis ${Math.round(idleMs / 1000)} s — WS_ON_STALL=exit, arrêt du bot.`,
      );
    attemptReconnect();
  };

  // Une tentative de reconnexion. Réussit → reset() ; échoue → un retry est
  // planifié après un délai croissant (backoff exponentiel) au lieu de sortir
  // en erreur — pensé pour un réseau éphémère (réveil de veille, Wi-Fi coupé,
  // DNS indisponible).
  const attemptReconnect = () => {
    const idleMs = now() - state.lastBlockAt;
    const secs = Math.round(idleMs / 1000);
    // Les blocks ont repris pendant l'attente : la reconnexion est obsolète.
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
      return reset(); // ré-arme → retente au cycle suivant
    }

    state.reconnectCount++;
    log.warn(
      `  -> Aucun block reçu depuis ${secs} s — tentative de reconnexion ${state.reconnectCount}/${maxReconnects}...`,
    );
    Promise.resolve()
      .then(() => onReconnect())
      .then(
        () => {
          // Succès : le backoff repart de sa base, l'état est nettoyé.
          state.backoffMs = backoffBaseMs;
          reset();
        },
        (err) => {
          log.error(
            `  -> Échec de la reconnexion: ${(err && err.message) || err}`,
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

  const unbind = () => {
    if (!boundProvider) return;
    boundProvider.off?.("block", myBlockHandler);
    boundProvider.off?.("error", myErrorHandler);
    boundProvider.websocket?.off?.("close", myCloseHandler);
    boundProvider = null;
  };
  const bind = (next) => {
    if (next === boundProvider) return; // inert
    unbind();
    boundProvider = next;
    next.on?.("block", myBlockHandler);
    next.on?.("error", myErrorHandler);
    next.websocket?.on?.("close", myCloseHandler);
  };
  const setProvider = (next) => bind(next); // utilisé par main() après rebuild

  bind(provider);
  timer = setTimer(checkOnce, checkIntervalMs); // heartbeat démarré à la création

  return { tick, reset, stop, setProvider, state };
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

  // P3: fabrique la triade provider/wallet/contrat sur le WSS Alchemy.
  function buildWss() {
    const p = new ethers.WebSocketProvider(config.wssUrl);
    // Filet anti-crash : la lib `ws` émet 'error' avec AUCUN listener si le DNS
    // est encore mort (réveil de veille) → Node tue le process. Ce listener est
    // posé avant toute souscription ; le health-check ci-dessous décidera de
    // garder ou de jeter ce socket. Windows de course : plus aucune.
    p.websocket?.on?.("error", (err) => {
      console.warn(
        `[wss] Connexion impossible (${maskUrl(config.wssUrl)}): ${
          err.code || err.message || err
        }`,
      );
    });
    const w = new ethers.Wallet(config.privateKey, p);
    const m = new ethers.Contract(config.mUsdcAddress, MTOKEN_ABI, w);
    return { provider: p, wallet: w, mUsdc: m };
  }
  // P3: souscrit le runner aux blocks. Rejoué après chaque reconnexion.
  const subscribe = (p) => {
    p.on("block", attemptChunk); // attemptChunk est résolu à l'APPEL, pas ici
  };

  let { provider, wallet, mUsdc } = buildWss();

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

  // Toujours informatif : solde en LP tokens (mToken) + décimales, affichés
  // sur la ligne de balance ci-dessous. Best-effort — la logique de retrait ne
  // dépend que du solde décomposable, donc une lecture LP en échec ne bloque
  // jamais le démarrage.
  let lpTokenDecimals = null;
  let lpBalanceDisplay = "";
  try {
    lpTokenDecimals = await mUsdcRead.decimals.staticCall();
    const lpBalanceRaw = await mUsdcRead.balanceOf.staticCall(wallet.address);
    lpBalanceDisplay = ` | LP tokens: ${ethers.formatUnits(
      lpBalanceRaw,
      lpTokenDecimals,
    )}`;
  } catch (lpErr) {
    console.log(
      `  (lecture du solde LP tokens impossible: ${lpErr.message || lpErr})`,
    );
  }

  const zeroBalanceHint =
    startingBalanceRaw === 0n
      ? "  <-- 0 renvoyé: vérifiez MUSDC_ADDRESS (contrat mUSDC) et le réseau du RPC/WSS. Si l'adresse est fausse, le solde paraît nul."
      : "";
  console.log(
    `Redeemable USDC balance: ${fmt(startingBalanceRaw)}${lpBalanceDisplay}${zeroBalanceHint}`,
  );

  const targetRaw =
    config.totalTarget !== null
      ? ethers.parseUnits(config.totalTarget.toString(), USDC_DECIMALS)
      : null;

  if (targetRaw !== null && targetRaw > startingBalanceRaw) {
    throw new Error(
      `Requested total (${config.totalTarget}) exceeds your redeemable balance (${fmt(
        startingBalanceRaw,
      )}).`,
    );
  }

  if (targetRaw !== null) {
    console.log(`Target total withdrawal: ${fmt(targetRaw)} USDC`);
  } else {
    console.log(
      "Mode solde complet — retirera la totalité du solde décomposable. Les",
    );
    console.log("dépôts externes (moniteur de balance) seront suivis aussi.");
  }
  console.log(
    "Will take up to 100% of available liquidity per chunk, capped at the known balance.",
  );
  console.log("Polling market liquidity...\n");

  const runner = createChunkRunner({
    mUsdc,
    mUsdcRead,
    provider,
    config,
    initialBalanceRaw: startingBalanceRaw,
    readBalance: () => mUsdcRead.balanceOfUnderlying.staticCall(wallet.address),
  });
  const { attemptChunk } = runner;

  // Balance monitor: re-reads the redeemable balance every
  // config.balanceMonitorIntervalMs, logs external changes and — while idle —
  // feeds the runner's knownBalance (the chunk cap). While a chunk is in
  // flight the read is only logged: the confirmation applies the exact
  // decrement, and the next idle read resyncs from on-chain truth.
  if (config.balanceMonitorIntervalMs > 0) {
    const monitor = createBalanceMonitor({
      mUsdcRead,
      walletAddress: wallet.address,
      intervalMs: config.balanceMonitorIntervalMs,
      initialRaw: startingBalanceRaw,
      onBalanceRead: createBalanceWiring(runner),
      lpTokenDecimals,
    });
    monitor.start();
    console.log(
      `Balance monitor ON — solde décomposable relu toutes les ${config.balanceMonitorIntervalMs / 1000} s (changements externes loggés et pris en compte par le plafond du chunk).\n`,
    );
  }

  // P3: watchdog WSS — heartbeat (plus aucun block depuis wssStallMs) + rebind.
  // La reconnexion est différée tant qu'une tx est en vol : le vieux socket
  // porte encore le wait/getTxStatus P1, le détruire casserait cette gestion.
  const reconnectHandler = async () => {
    try {
      await provider.destroy();
    } catch {
      /* socket déjà mort */
    }
    provider.removeAllListeners?.("block");
    const fresh = buildWss();
    // Health-check réseau : sonde getBlockNumber() avant d'adopter le socket.
    // Si le réseau est encore coupé (WSS indisponible), on détruit `fresh` et
    // on REJETTE — le watchdog planifie alors un retry backoffé au lieu de se
    // dire « réussi » sur un socket mort (cas du crash ENOTFOUND au réveil).
    let probe;
    try {
      probe = await withTimeout(
        fresh.provider.getBlockNumber(),
        HEALTH_CHECK_MS,
      );
      if (probe.timedOut) throw new Error("WSS health-check: time out");
    } catch (healthErr) {
      try {
        await fresh.provider.destroy();
      } catch {
        /* socket jamais ouvert */
      }
      throw new Error(
        `WSS indisponible (${healthErr.code || healthErr.message || healthErr})`,
      );
    }
    runner.setConnection({ mUsdc: fresh.mUsdc, provider: fresh.provider });
    subscribe(fresh.provider); // AVANT de reprendre les blocks
    provider = fresh.provider; // le `let` scope main est recâblé
    wallet = fresh.wallet;
    mUsdc = fresh.mUsdc;
    watchdog.setProvider(fresh.provider);
    watchdog.reset(); // ré-arme l'horloge du heartbeat
    console.log(
      `Reconnexion WSS établie (hauteur ${probe.value}) — surveillance des blocks relancée.\n`,
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

  console.log(
    "Subscribing to new blocks — will check liquidity on each one.\n",
  );
  subscribe(provider);
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
  createBalanceWiring,
  createBalanceMonitor,
  createWssWatchdog,
};
