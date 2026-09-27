import { ethers } from "ethers";
import { Config, USDC_DECIMALS } from "./config";
import { fmt } from "./utils";

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

export { BalanceMonitor, createBalanceMonitor };
