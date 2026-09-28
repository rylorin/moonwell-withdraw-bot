# Testing STOP_AFTER_COMPLETION functionality

## Overview
This document explains how to test the new STOP_AFTER_COMPLETION configuration option.

## How it works
- When `stopAfterCompletion=true` (default in target mode): Bot exits after completing withdrawals
- When `stopAfterCompletion=false` (default in balance mode): Bot continues monitoring for new deposits

## Test Scenarios

### 1. Target Mode with explicit WITHDRAW_AMOUNT
```bash
# Should stop after completion (default behavior)
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." WITHDRAW_AMOUNT=100 node dist/moonwell-withdraw-bot-chunked.js

# Should NOT stop after completion (override default)
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." WITHDRAW_AMOUNT=100 STOP_AFTER_COMPLETION=false node dist/moonwell-withdraw-bot-chunked.js
```

### 2. Balance Mode (no WITHDRAW_AMOUNT)
```bash
# Should NOT stop after completion (default behavior)
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." node dist/moonwell-withdraw-bot-chunked.js

# Should stop after completion (override default)
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." STOP_AFTER_COMPLETION=true node dist/moonwell-withdraw-bot-chunked.js
```

## Verification
When the bot stops:
- You'll see "Done." message in logs
- Process exits with code 0
- Background jobs are stopped
- Network connections are destroyed

When the bot continues:
- You'll see "Continuing to monitor for new deposits" message
- Bot keeps listening for new blocks
- Process remains active