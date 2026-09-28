# Moonwell Withdraw Bot

A Node.js bot for withdrawing USDC from the Moonwell protocol on Base by splitting large withdrawals into chunks. Designed for large withdrawals that exceed the available liquidity in the pool in a single transaction.

![Version](https://img.shields.io/github/package-json/v/rylorin/moonwell-withdraw-bot)
![Quality Check](https://github.com/rylorin/moonwell-withdraw-bot/workflows/Quality%20Check/badge.svg?branch=master)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

> **Original Author**: weez2 – thank you so much for sharing the initial script.

## Features

- **Chunked withdrawal**: Automatically splits large withdrawals into multiple transactions based on available liquidity
- **Smart polling**: Checks available liquidity at every new block via `getCash()`
- **Gas tier management**: Automatically adjusts gas fees based on chunk size (EIP-1559 Priority)
- **RPC fallback**: Uses a public RPC for reads and falls back to Alchemy on error
- **Failure detection**: Captures `Failure` events from Compound-fork contracts even in case of EVM success
- **Atomicity guarantee**: Does not submit a new transaction while a previous one is in progress (`txInFlight`)
- **Balance re-sync**: The bot periodically re-reads the redeemable balance (monitor) and in full balance mode the target follows the current balance — an external deposit is withdrawn automatically, a manual withdrawal reduces the target
- **Configurable cap source**: `CHUNK_CAP_SOURCE=monitor` (last value from the monitor, default) or `fresh` (re-reads the balance every round)

## Prerequisites

- Node.js >= 18
- yarn install ethers
- A wallet with USDC on Base
- An Alchemy API key (WSS)

## Installation

```bash
yarn install
```

## Configuration

### Environment Variables (recommended)

| Variable                   | Description                                   | Default                 |
| -------------------------- | --------------------------------------------- | ----------------------- |
| `BASE_WSS_URL`             | Alchemy WebSocket URL for Base                | -                       |
| `PRIVATE_KEY`              | Wallet private key                            | -                       |
| `WITHDRAW_AMOUNT`          | Total amount to withdraw (USDC)               | Full balance            |
| `MIN_CHUNK`                | Minimum chunk amount                          | 5 USDC                  |
| `BASE_READ_RPC_URL`        | Public RPC for reads                          | `https://base.drpc.org` |
| `BALANCE_MONITOR_INTERVAL` | Redeemable balance re-read interval (seconds) | `60` (`0` = disabled)   |
| `CHUNK_CAP_SOURCE`         | Chunk cap source                              | `monitor` (or `fresh`)  |

### Execution Example

```bash
export BASE_WSS_URL="wss://base-mainnet.g.alchemy.com/v2/VOUS_KEY"
export PRIVATE_KEY="your_private_key"
export WITHDRAW_AMOUNT=70000
yarn start
```

> **Note**: The script automatically loads a `.env` file (via `dotenv`) if present. Copy [.env.example](.env.example) to `.env` and fill in the values.

### Gas Configuration

The gas tiers are configured in the file:

| Tier | Priority (gwei) | Max Fee (gwei) | Condition     |
| ---- | --------------- | -------------- | ------------- |
| 1    | 0.3             | 0.6            | Chunk >= $100 |
| 2    | 0.1             | 0.3            | Chunk >= $30  |
| 3    | 0.02            | 0.1            | Chunk < $30   |

## How It Works

1. The bot connects to the Base network via WebSocket
2. It reads the user's USDC redeemable balance
3. At every block, it checks the available liquidity in the mUSDC pool
4. It submits a `redeemUnderlying` transaction, capped to the smallest value between:
   - Total available liquidity (`getCash()`)
   - The remaining amount to withdraw
   - The known redeemable balance (last value from the monitor, or re-read every round according to `CHUNK_CAP_SOURCE`)
5. It repeats at every block until the target is reached: without `WITHDRAW_AMOUNT`, the target follows the current balance (external deposits are withdrawn automatically, a manual withdrawal reduces the target)

## Security

- **Never hardcode** the private key or WSS URL
- Use environment variables or a secrets manager
- Only run this script on a wallet that you control
- Always verify the contract address on BaseScan: `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22`

## Contract

- **mUSDC (Moonwell)**: `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` (Base)
- Interface ABI: `getCash()`, `balanceOfUnderlying()`, `redeemUnderlying()`

## Technical Notes

- The bot uses two providers: a public RPC for frequent reads and Alchemy WSS for block subscription and transaction submission
- If a read fails on the public RPC, the bot automatically falls back to Alchemy
- Soft failures (event `Failure`) are handled separately from EVM reverts
- The remaining balance is decremented only after on-chain confirmation of success
