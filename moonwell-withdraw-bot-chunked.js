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
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ---------- CONFIG ----------
// Use a wss:// URL here (e.g. wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY).
// >>> PASTE YOUR NEW ALCHEMY WSS URL BELOW (replace the placeholder) <<<
const WSS_URL = process.env.BASE_WSS_URL || "PASTE_YOUR_WSS_URL_HERE";

// Free public RPC used only for the high-frequency getCash() read calls,
// to keep that volume off the paid Alchemy connection. No signup needed.
const READ_RPC_URL = process.env.BASE_READ_RPC_URL || "https://base.drpc.org";

// >>> PASTE YOUR NEW PRIVATE KEY BELOW (replace the placeholder) <<<
const PRIVATE_KEY = process.env.PRIVATE_KEY || "PASTE_YOUR_PRIVATE_KEY_HERE";
const MUSDC_ADDRESS = "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22"; // Moonwell mUSDC on Base
const USDC_DECIMALS = 6;

// Total amount you want withdrawn in the end (human units, e.g. 70000)
const TOTAL_TARGET = process.env.WITHDRAW_AMOUNT
  ? parseFloat(process.env.WITHDRAW_AMOUNT)
  : null; // if null, withdraws your FULL redeemable balance

// Don't bother submitting a tx for tiny dust amounts of liquidity.
const MIN_CHUNK_USDC = process.env.MIN_CHUNK_USDC
  ? parseFloat(process.env.MIN_CHUNK_USDC)
  : 5;

// Gas settings, tiered by the USDC amount of the chunk being attempted.
// Larger chunks are worth paying more to win inclusion; small/dust chunks
// aren't worth overpaying gas for. Add more tiers if you want finer control.
const GAS_TIERS = [
  // { minUsdc: <threshold>, priorityGwei: <tip>, maxFeeGwei: <ceiling> }
  { minUsdc: 100, priorityGwei: "0.3", maxFeeGwei: "0.6" }, // $100+ chunks
  { minUsdc: 30, priorityGwei: "0.1", maxFeeGwei: "0.3" }, // $30+ chunks
  { minUsdc: 0, priorityGwei: "0.02", maxFeeGwei: "0.1" }, // below $30
];

function getGasForChunk(chunkUsdcFloat) {
  const tier =
    GAS_TIERS.find((t) => chunkUsdcFloat >= t.minUsdc) ??
    GAS_TIERS[GAS_TIERS.length - 1];
  return {
    maxPriorityFeePerGas: ethers.parseUnits(tier.priorityGwei, "gwei"),
    maxFeePerGas: ethers.parseUnits(tier.maxFeeGwei, "gwei"),
  };
}

// ---------- ABI (minimal Compound-style mToken interface) ----------
const MTOKEN_ABI = [
  "function getCash() view returns (uint256)",
  "function balanceOfUnderlying(address owner) returns (uint256)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "event Failure(uint256 errorCode, uint256 info, uint256 detail)",
];

function fmt(raw) {
  return ethers.formatUnits(raw, USDC_DECIMALS);
}

async function main() {
  if (!PRIVATE_KEY || PRIVATE_KEY === "PASTE_YOUR_PRIVATE_KEY_HERE") {
    throw new Error(
      "Edit the PRIVATE_KEY placeholder near the top of this file with your new key."
    );
  }
  if (!WSS_URL || WSS_URL === "PASTE_YOUR_WSS_URL_HERE") {
    throw new Error(
      "Edit the WSS_URL placeholder near the top of this file with your new Alchemy wss:// URL."
    );
  }

  const provider = new ethers.WebSocketProvider(WSS_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const mUsdc = new ethers.Contract(MUSDC_ADDRESS, MTOKEN_ABI, wallet);

  // Separate read-only provider for the high-frequency getCash() checks —
  // keeps that load off the paid Alchemy connection. Block subscription and
  // transaction submission still go through the Alchemy WSS provider above.
  const readProvider = new ethers.JsonRpcProvider(READ_RPC_URL);
  const mUsdcRead = new ethers.Contract(MUSDC_ADDRESS, MTOKEN_ABI, readProvider);

  console.log(`Wallet: ${wallet.address}`);

  const startingBalanceRaw = await mUsdc.balanceOfUnderlying.staticCall(
    wallet.address
  );
  console.log(`Redeemable USDC balance: ${fmt(startingBalanceRaw)}`);

  let remainingRaw =
    TOTAL_TARGET !== null
      ? ethers.parseUnits(TOTAL_TARGET.toString(), USDC_DECIMALS)
      : startingBalanceRaw;

  if (remainingRaw > startingBalanceRaw) {
    throw new Error(
      `Requested total (${TOTAL_TARGET}) exceeds your redeemable balance (${fmt(
        startingBalanceRaw
      )}).`
    );
  }

  console.log(`Target total withdrawal: ${fmt(remainingRaw)} USDC`);
  console.log("Will take up to 100% of available liquidity per chunk.");
  console.log("Polling market liquidity...\n");

  const minChunkRaw = ethers.parseUnits(MIN_CHUNK_USDC.toString(), USDC_DECIMALS);

  let stopped = false;
  let txInFlight = false; // guard: never submit a new chunk while one is pending

  const attemptChunk = async () => {
    if (stopped || txInFlight) return;

    try {
      // Try the free public RPC first; if it errors (rate limit, flaky
      // node, etc.) fall back to the Alchemy connection for this check
      // rather than skipping the round entirely.
      let cash;
      try {
        cash = await mUsdcRead.getCash();
      } catch (readErr) {
        console.warn(
          `  -> Public RPC getCash() failed (${readErr.message || readErr}), falling back to Alchemy for this check.`
        );
        cash = await mUsdc.getCash();
      }
      const ts = new Date().toISOString();

      if (cash === 0n) {
        console.log(`[${ts}] No liquidity available. Waiting...`);
        return;
      }

      // Take the smaller of: (all available cash) or (what's left to withdraw)
      let chunk = cash < remainingRaw ? cash : remainingRaw;

      console.log(
        `[${ts}] Available liquidity: ${fmt(cash)} | Remaining target: ${fmt(
          remainingRaw
        )} | Chunk to attempt: ${fmt(chunk)}`
      );

      if (chunk < minChunkRaw) {
        console.log(
          `  -> Below MIN_CHUNK_USDC (${MIN_CHUNK_USDC}), skipping this round.`
        );
        return;
      }

      console.log("  -> Submitting redeemUnderlying tx...");
      txInFlight = true;

      // Pick gas fee tier based on the size of this specific chunk.
      const chunkUsdcFloat = parseFloat(fmt(chunk));
      const { maxPriorityFeePerGas, maxFeePerGas } = getGasForChunk(
        chunkUsdcFloat
      );
      console.log(
        `  -> Gas tier for $${chunkUsdcFloat.toFixed(2)} chunk: priority=${ethers.formatUnits(
          maxPriorityFeePerGas,
          "gwei"
        )} gwei, max=${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`
      );

      const tx = await mUsdc.redeemUnderlying(chunk, {
        maxPriorityFeePerGas,
        maxFeePerGas,
      });
      console.log(`  -> Submitted: ${tx.hash}`);
      const receipt = await tx.wait();

      if (receipt.status !== 1) {
        console.error("  -> Transaction FAILED/reverted. Will retry next block.");
        return;
      }

      // Compound-fork contracts can report success at the EVM level while
      // still failing internally (e.g. cash disappeared between our check
      // and execution) — that shows up as a Failure event in the logs
      // instead of a revert. Check for it explicitly; receipt.status alone
      // is not sufficient here.
      const failureEvent = receipt.logs
        .map((log) => {
          try {
            return mUsdc.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "Failure");

      if (failureEvent) {
        console.error(
          `  -> Redeem soft-failed on-chain (Failure event: error=${failureEvent.args.errorCode}, info=${failureEvent.args.info}). No funds were transferred. Will retry next block.`
        );
        return; // do NOT decrement remainingRaw — nothing was actually redeemed
      }

      console.log(`  -> Confirmed in block ${receipt.blockNumber}.`);
      remainingRaw -= chunk;
      console.log(`  -> Remaining to withdraw: ${fmt(remainingRaw)} USDC\n`);

      if (remainingRaw <= 0n) {
        console.log("Target fully withdrawn. Done.");
        stopped = true;
        provider.removeAllListeners("block");
        await provider.destroy();
        process.exit(0);
      }
    } catch (err) {
      console.error("Error during chunk attempt:", err.message || err);
      // Keep going — transient RPC errors or reverts shouldn't kill the bot.
    } finally {
      txInFlight = false;
    }
  };

  console.log("Subscribing to new blocks — will check liquidity on each one.\n");
  provider.on("block", attemptChunk);
  attemptChunk(); // run immediately on start, don't wait for the first block
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
