import { ethers } from "ethers";
import { maskUrl } from "./utils";

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

export { createWssWatchdog };
