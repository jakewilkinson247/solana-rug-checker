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

### Entry: retest of support, confirmed by volume

With `ENTRY_MODE=retest` (the default), coins that pass the filters go on a
watchlist instead of being bought. The bot builds each coin's trade history
from the same log stream (no extra RPC calls) and buys only on this pattern:

1. **Run:** the peak is at least `MIN_RUN_PCT` (100) above the first trade.
2. **Pullback:** price falls `MIN_PULLBACK_PCT`–`MAX_PULLBACK_PCT` (25–65%) off the peak.
3. **Retest:** the pullback low comes within `RETEST_TOLERANCE_PCT` (10) of
   *support*, the volume-weighted average price of the run (where the run's
   buyers got in). Falling more than `SUPPORT_BREAK_PCT` (20) below support drops the coin.
4. **Bounce:** price is `MIN_BOUNCE_PCT`–`MAX_BOUNCE_PCT` (15–50%) off the low.

And the volume has to back it up:

| Volume check | Env var (default) |
|---|---|
| Total volume since launch | `MIN_TOTAL_VOL_SOL` (30) |
| Distinct wallets trading | `MIN_TRADERS` (40) |
| No single wallet over this share of volume (wash trading) | `MAX_WALLET_VOL_PCT` (20) |
| Pullback volume/min vs run volume/min (quiet pullback, not a dump) | `MAX_PULLBACK_VOL_RATIO` (0.8) |
| Volume on the bounce | `MIN_BOUNCE_VOL_SOL` (5) |
| Buy/sell SOL ratio on the bounce | `MIN_BOUNCE_BUY_RATIO` (1.3) |
| Volume in the last 60s (still alive) | `MIN_RECENT_VOL_SOL` (1) |

Coins are watched for `WATCH_MINUTES` (60). Right before entering, the safety
filters run again in case the dev or a whale dumped in the meantime.
`ENTRY_MODE=immediate` skips the watchlist and buys as soon as a coin passes.

### Paper trading

`PAPER_BUY_SOL` (0.1) per entry, up to `MAX_OPEN_POSITIONS` (5). Exits on
`TAKE_PROFIT_PCT` (100), `STOP_LOSS_PCT` (30), `MAX_HOLD_MINUTES` (30), or when
the coin graduates off the curve. Every decision goes to `bot/logs/decisions.jsonl`
(with the metrics, so you can see why coins failed) and every trade to
`bot/logs/trades.jsonl`. Ctrl+C prints the net result.

Entries are priced *after* the check delay, which is what a filtering bot would
actually get. A bot that buys in the launch slot gets a better price, but it
can't have checked holders or bundles yet.
