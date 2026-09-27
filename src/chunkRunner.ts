import { ethers } from "ethers";
import { Config } from "./config";
import { fmt, getGasForChunk, getTxStatus, withTimeout } from "./utils";

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
        log.debug(`No liquidity available. Waiting...`);
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
        log.debug("  -> Nothing to withdraw this round.");
        return;
      }
      if (belowMin) {
        log.debug(
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

export { createChunkRunner, computeChunk };
