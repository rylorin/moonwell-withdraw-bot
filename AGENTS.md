# AGENTS.md

Guide for AI agents and developers working on this project.

## Overview

A Node.js script that withdraws USDC from the Moonwell protocol on Base by splitting large withdrawals into chunks. No framework, no dependencies other than `ethers` v6.

## Project Structure

- **`src/moonwell-withdraw-bot-chunked.ts`** — Main program
- **`src/config.ts`** — Configuration and constants
- **`src/types.ts`** — Utility TypeScript types
- **`src/logger.ts`** — Structured logging system (console + file with daily rotation, 7 days retention)
- **`src/balanceMonitor.ts`** — Balance monitoring (reads disposable balance on the read RPC at configured intervals, logs external changes)
- **`src/chunkRunner.ts`** — Core withdrawal loop (`createChunkRunner`, `computeChunk`), exports `state.{stopped,txInFlight,processedRaw,knownBalanceRaw,remainingRaw}`
- **`src/watchdog.ts`** — WSS watchdog (heartbeat, stall detection, reconnection with backoff)
- **`src/utils.ts`** — Shared utilities (`fmt`, `getGasForChunk`, `withTimeout`, `getTxStatus`, `createBalanceWiring`, `parseAmount`, `checkPlaceholders`, `logStartupParameters`, `maskUrl`)
- **`tests/bot.test.js`** — Unit tests (`node --test`), 73 tests, mocks only (no network, no real transactions)
- **`README.md`** — User documentation

## Technical Stack

- **Node.js >= 22**
- **ethers v6** (`const { ethers } = require("ethers")`) — note: v6 syntax, not v5 (e.g. `ethers.parseUnits`, not `ethers.utils.parseUnits`)
- **Native BigInt** for on-chain amounts (raw units, 6 decimals for USDC)
- **Two providers**: a public RPC for reads (`JsonRpcProvider`), an Alchemy WSS for subscriptions and submissions (`WebSocketProvider`)
- **Package manager**: `yarn` (use instead of `npm`)

## Code Architecture

### Configuration (in src/config.ts)

All constants at the top: `wssUrl`, `privateKey`, `mUsdcAddress`, `usdcDecimals`, `totalTarget`, `minChunkUsdc`, `gasTiers`. Secrets read via `process.env` with placeholder fallbacks.

### Main logic (function `main` in src/moonwell-withdraw-bot-chunked.ts)

1. **Validation** — Checks secret placeholders are replaced and target does not exceed balance
2. **Initialization** — Creates wallet, contracts (signed + read-only)
3. **`attemptChunk()`** — The withdrawal loop, triggered on each new block

### Key Rules to Follow

- **`txInFlight` guard**: `attemptChunk` refuses to submit a new tx if one is already in flight. Do not remove this guard without understanding why (prevents nonce conflicts).
- **RPC fallback**: `getCash()` tries public RPC first, then Alchemy on error. Do not simplify to only Alchemy — this is a deliberate cost optimization.
- **`Failure` event verification**: for Compound-fork contracts, `receipt.status === 1` is not enough. Must scan logs for a `Failure` event; if found, **do not** count the chunk (do not increment `processedRaw` or decrement `knownBalanceRaw`).
- **Conditional accounting**: on-chain success only increments `processedRaw += chunk` (and decrements `knownBalanceRaw -= chunk`). Nothing is counted before confirmation.
- **Balance re-sync model**: `processedRaw` (amount processed) and `knownBalanceRaw` (known balance, single source of truth for chunk cap) are written at only two legitimate moments — on-chain confirmation and balance monitor read. `remainingRaw` is a derived **getter**: `targetRaw - processedRaw` in fixed-target mode, `knownBalanceRaw` in full-balance mode (no `WITHDRAW_AMOUNT`), so external deposits are auto-absorbed and a manual withdrawal reduces the target.
- **Anti-double-count guard**: a balance monitor read only overwrites `knownBalanceRaw` if `!txInFlight` — never while a tx is in flight (avoids counting the same withdrawal twice).
- **`CHUNK_CAP_SOURCE`**: `monitor` (last value read by the monitor, default) or `fresh` (re-read balance via the read RPC each round). Without a monitor (`BALANCE_MONITOR_INTERVAL=0`), the bot switches to `fresh` with a warning.
- **Gas tiers**: `getGasForChunk()` picks a tier based on chunk amount. Tiers are ordered largest-to-smallest amount (`GAS_TIERS.find`).
- **Stop**: when `remainingRaw <= 0n`, the bot removes listeners, destroys the provider, and calls `process.exit(0)`. With `stopAfterCompletion=false` it continues monitoring for new deposits instead.

## Conventions

- Raw amounts are `BigInt` (`n` suffix in comparisons: `remainingRaw <= 0n`, `cash === 0n`)
- `fmt(raw)` converts to human units via `ethers.formatUnits(raw, USDC_DECIMALS)`
- Log messages prefixed with `->` for indentation, timestamped `[ISO]` for loops
- Chunk errors are caught and logged, then loop continues (bot must not die on transient errors)

## Common Pitfalls

- **ethers v6 vs v5**: `ethers.WebSocketProvider`, `parseUnits`/`formatUnits`/`parseLog`/`staticCall` are v6 methods. Do not replace with v5 equivalents.
- **Decimals**: `USDC_DECIMALS = 6`. All amount conversions must use `parseUnits`/`formatUnits` with this constant.
- **Listener management**: `provider.removeAllListeners("block")` is called before `process.exit` — ensure any shutdown modification keeps it.
- **`STOP_AFTER_COMPLETION`**: controls whether the bot exits after finishing withdrawals. Default `true` in target mode (`WITHDRAW_AMOUNT` set), `false` in full-balance mode.

## Security

- Never hardcode a private key in code — always via `process.env`
- Never log secrets
- Contract addresses are fixed and verified on BaseScan

## Tests / Execution

Unit test suite via Node's native runner (`node:test`) — no network, no real transactions, providers and contracts mocked:

```bash
node --test        # or: yarn test
node --check moonwell-withdraw-bot-chunked.js   # syntax check
```

**Every change must pass the full test suite (`yarn test`) before being considered valid.**

Pure functions (`loadConfig`, `getGasForChunk`, `withTimeout`, `getTxStatus`, `computeChunk`) and the runner (`createChunkRunner`, with `state.{stopped,txInFlight,processedRaw,knownBalanceRaw,remainingRaw}`) are exported precisely for testability. The `createBalanceWiring` helper is also exported to wire the balance monitor to the runner. Tests cover fixes **P1**, **P2**, **P3** (WSS watchdog + reconnection) and the balance re-sync model: full-balance mode, reaction to external deposits/withdrawals, anti-double-count guard, monitor→fresh switching.

To run the bot:

```bash
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." node moonwell-withdraw-bot-chunked.js
```

Warning: the script submits real on-chain transactions. Only run in a controlled test context or deliberate production.

### Fixes Applied (09/09/2026)

- **P1** — `tx.wait()` wrapped in `withTimeout()` (`TX_TIMEOUT_MS`, default 60 s). On timeout, `getTxStatus()` gives real status: `pending`/`dropped` → warn + resume next block without decrementing; `mined` → receipt processed normally.
- **P2** — `txInFlight = true` set immediately after the guard, before any `await`, to prevent double-submission at the same nonce.
- **P3 (11/09/2026)** — `createWssWatchdog()` monitors the Alchemy WSS: heartbeat + silence threshold (`WS_STALL_MS`) detect a disconnect; `error`/`close` events are logged (URL masked via `maskUrl`, never a key), and reconnection rebuilds the provider (`buildWss`) then re-attaches the `block` subscription via `runner.setConnection`. Behavior driven by `WS_ON_STALL` (`reconnect` default / `exit`) with a `WS_MAX_RECONNECTS` budget; reconnection deferred while a tx is in flight. Since 12/09/2026: a reconnection failure (e.g. `getaddrinfo ENOTFOUND` after wake from sleep) no longer exits the process — attempts retry with exponential backoff (`WS_BACKOFF_BASE_MS` 5 s → cap `WS_BACKOFF_MAX_MS` 60 s), default budget is 10 (`WS_MAX_RECONNECTS`), and a health probe `getBlockNumber` (5 s timeout) verifies the fresh socket before adopting it.
- **Startup diagnostics** — `logStartupParameters()` shows mUSDC_ADDRESS (with BaseScan link), wallet, masked WSS, RPC, gas tiers, etc. A zero balance triggers an explicit hint ("check MUSDC_ADDRESS").
- **Balance monitoring** — `createBalanceMonitor()` re-reads the disposable balance on the read RPC every `BALANCE_MONITOR_INTERVAL` s (default 60 s, `0` to disable) and logs external changes (deposits, manual withdrawals, interest).
- **Balance re-sync (11/09/2026)** — the monitor now feeds the withdrawal logic via `createBalanceWiring()`: `remainingRaw` is a getter derived from `targetRaw - processedRaw` (fixed-target mode) or `knownBalanceRaw` (full-balance mode). External deposits are auto-absorbed, a manual withdrawal reduces the target. Anti-double-count guard: monitor read only overwrites `knownBalanceRaw` if `!txInFlight`. `CHUNK_CAP_SOURCE` (`monitor`/`fresh`) chooses the chunk cap source — without a monitor, auto-switches to `fresh` with a warning.
- **P4 & P6 (12/09/2026)** — `createShutdownHandler()`: clean shutdown (SIGINT/SIGTERM), stops background jobs (monitor, watchdog) + destroys WSS and read RPC providers, idempotent; `attemptChunk` stops cleanly when remainder falls below `MIN_CHUNK` (dust) instead of looping. 73 tests.
- **P3 hardening (12/09/2026)** — the `WebSocketProvider.websocket` getter in ethers v6 **throws** `Error("websocket closed")` once the socket is destroyed (it does not return `null`): optional chaining `?.` does not protect against a throwing getter. `unbind()`/`bind()`/`buildWss()` now access it via a `safeWs()` helper that catches the exception — no more unhandled crash when `fatal()` → `stop()` → `unbind()` traverses a dead provider: the bot exits cleanly via `process.exit(1)` (this was the cause of the crash after wake from sleep despite the backoff). Added regression tests: `watchdog: websocket getter that THROWS after close does not crash fatal() (regression)` and `watchdog: websocket getter that THROWS on bind → clean stop()/fatal()`. 73 tests.

### Documentation

**Documentation must be kept in sync with every change.** After any modification:

- Update `AGENTS.md` if code architecture, rules, or conventions changed
- Update `PLAN.md` if the plan evolves or a new phase is added
- Update `README.md` if user-facing behavior, configuration, or usage changes

### Version Bumping

New: the system now supports automatic version incrementing via commits. Conventional commits increment semantic versioning:

- `feat: ...` → bumps minor version (0.0.1 → 0.1.0)
- `fix: ...` → bumps patch version (0.0.1 → 0.0.2)
- `release: ...` → bumps patch version
- `BREAKING CHANGE:` → bumps major version (0.0.1 → 1.0.0)

Version bumping is triggered by the pre-commit hook and runs before the commit is created, ensuring the version bump is part of the commit.
