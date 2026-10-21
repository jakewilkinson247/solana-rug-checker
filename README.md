# solana-rug-checker
Solana token rug pull detector

## Sniper bot (filtered, paper trading)

`bot/` watches pump.fun for new coins, waits `CHECK_DELAY_MS`, runs each one
through rug/sniper filters, and **paper-trades** the ones that pass. No wallet
and no real SOL: it logs simulated buys and sells at the live bonding-curve
price, so you can tune the filters before risking anything.

```bash
cd bot
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY npm start
npm test
```

It needs a dedicated RPC with WebSocket support (Helius, QuickNode, etc.).
pump.fun gets thousands of launches a day and each check makes roughly 10–25
RPC calls, so the public endpoint will rate-limit it almost immediately.
`SOLANA_WS_URL` defaults to the RPC URL with `https` → `wss`.

### Filters

A coin is rejected if any of these trip (all thresholds are env vars):

| Check | Env var (default) |
|---|---|
| Dev's own buy in the create tx | `MAX_DEV_BUY_PCT` (5) |
| Dev already sold over half of it | `REJECT_IF_DEV_SOLD` (true) |
| Other txs in the launch slot or the next one (snipers/bundles) | `MAX_EARLY_BUYS` (3) |
| Largest single holder, excluding the bonding curve | `MAX_TOP_HOLDER_PCT` (10) |
| Top 10 holders combined | `MAX_TOP10_PCT` (30) |
| SOL already bought into the curve | `MIN_REAL_SOL` (0) |
| Twitter/Telegram/website in the metadata | `REQUIRE_SOCIALS` (false) |
| Fresh top holders sharing one funding wallet (bundled sub-wallets) | `MAX_SHARED_FUNDER` (2), `CLUSTER_HOLDERS` (8), `FRESH_WALLET_HOURS` (24), `CLUSTER_CHECK` (true) |
| Any holder funded by the dev, or by the dev's own funder | part of `CLUSTER_CHECK` |

### Paper trading

`PAPER_BUY_SOL` (0.1) per pass, up to `MAX_OPEN_POSITIONS` (5). Exits on
`TAKE_PROFIT_PCT` (100), `STOP_LOSS_PCT` (30), `MAX_HOLD_MINUTES` (30), or when
the coin graduates off the curve. Every decision goes to `bot/logs/decisions.jsonl`
(with the metrics, so you can see why coins failed) and every trade to
`bot/logs/trades.jsonl`. Ctrl+C prints the net result.

Entries are priced *after* the check delay, which is what a filtering bot would
actually get. A bot that buys in the launch slot gets a better price, but it
can't have checked holders or bundles yet.
