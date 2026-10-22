import { fileURLToPath } from 'node:url';

// All settings come from environment variables so the filters can be tuned
// without code changes. See the "Sniper bot" section of the README.
const num = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);
const bool = (name, fallback) => (process.env[name] !== undefined ? ['1', 'true', 'yes'].includes(process.env[name].toLowerCase()) : fallback);

const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export const config = {
    rpcUrl,
    wsUrl: process.env.SOLANA_WS_URL || rpcUrl.replace(/^http/, 'ws'),

    // Print every coin (new, rejected, dropped) instead of only watches, entries and trades.
    verbose: bool('VERBOSE', false),

    // PumpSwap: follow coins that graduate off the bonding curve onto their pool, and
    // (WATCH_PUMPSWAP_POOLS) treat new PumpSwap pools for pump.fun coins as candidates too.
    watchPumpSwap: bool('WATCH_PUMPSWAP', true),
    watchPumpSwapPools: bool('WATCH_PUMPSWAP_POOLS', true),

    // Older coins: keep a rolling trade history for every coin and pick up ones that
    // suddenly get busy, then run them through the same filters and retest logic.
    existing: {
        enabled: bool('WATCH_EXISTING', true),
        windowMin: num('HOT_WINDOW_MINUTES', 5),
        minVolSol: num('HOT_MIN_VOL_SOL', 15),       // SOL traded within the window...
        minTraders: num('HOT_MIN_TRADERS', 20),      // ...by at least this many wallets
        historyMin: num('HISTORY_MINUTES', 60),      // trade history kept per coin
        cooldownMin: num('COOLDOWN_MINUTES', 60),    // rest after a coin is rejected or dropped
        scanMs: num('HOT_SCAN_MS', 5_000)
    },

    // How long to let a coin trade before judging it; holders and snipers need time to show up.
    checkDelayMs: num('CHECK_DELAY_MS', 20_000),
    maxConcurrentChecks: num('MAX_CONCURRENT_CHECKS', 2),
    maxQueue: num('MAX_QUEUE', 20),

    filters: {
        // Checked from the trade stream before any RPC calls.
        minBuyers: num('MIN_BUYERS', 5),                  // distinct buyers besides the dev by check time
        minBuySol: num('MIN_BUY_SOL', 1),
        maxSameName: num('MAX_SAME_NAME', 2),             // launches with the same symbol...
        copycatMinutes: num('COPYCAT_MINUTES', 30),       // ...within this window
        maxDevBuyPct: num('MAX_DEV_BUY_PCT', 5),
        rejectIfDevSold: bool('REJECT_IF_DEV_SOLD', true),
        maxEarlyBuys: num('MAX_EARLY_BUYS', 3),          // other txs in the creation slot or the next
        maxTopHolderPct: num('MAX_TOP_HOLDER_PCT', 10),   // any single wallet, excluding the bonding curve
        maxTop10Pct: num('MAX_TOP10_PCT', 30),
        minRealSol: num('MIN_REAL_SOL', 0),               // SOL already bought into the curve
        requireSocials: bool('REQUIRE_SOCIALS', false),
        // Funding-cluster check: fresh top holders funded by one wallet are likely one bundler.
        clusterCheck: bool('CLUSTER_CHECK', true),
        clusterHolders: num('CLUSTER_HOLDERS', 8),
        maxSharedFunder: num('MAX_SHARED_FUNDER', 2),     // most fresh holders allowed per funder
        freshWalletHours: num('FRESH_WALLET_HOURS', 24)
    },

    // 'retest' watches coins that pass the filters and buys the bounce off support;
    // 'immediate' buys as soon as a coin passes.
    entryMode: process.env.ENTRY_MODE || 'retest',
    entry: {
        watchMinutes: num('WATCH_MINUTES', 60),
        evalMs: num('EVAL_MS', 2_000),
        minRunPct: num('MIN_RUN_PCT', 100),               // peak vs first trade price
        minPullbackPct: num('MIN_PULLBACK_PCT', 25),      // from the peak
        maxPullbackPct: num('MAX_PULLBACK_PCT', 65),
        retestTolerancePct: num('RETEST_TOLERANCE_PCT', 10), // low must come within this of support
        supportBreakPct: num('SUPPORT_BREAK_PCT', 20),    // this far below support = dead
        minBouncePct: num('MIN_BOUNCE_PCT', 15),          // off the retest low
        maxBouncePct: num('MAX_BOUNCE_PCT', 50),
        minTotalVolSol: num('MIN_TOTAL_VOL_SOL', 30),
        minTraders: num('MIN_TRADERS', 40),
        maxWalletVolPct: num('MAX_WALLET_VOL_PCT', 20),
        maxPullbackVolRatio: num('MAX_PULLBACK_VOL_RATIO', 0.8), // pullback vol/min vs run vol/min
        minBounceVolSol: num('MIN_BOUNCE_VOL_SOL', 5),
        minBounceBuyRatio: num('MIN_BOUNCE_BUY_RATIO', 1.3),
        minRecentVolSol: num('MIN_RECENT_VOL_SOL', 1)     // last 60s, so the coin is still alive
    },

    paper: {
        buySol: num('PAPER_BUY_SOL', 0.1),
        feeBps: num('FEE_BPS', 100),
        takeProfitPct: num('TAKE_PROFIT_PCT', 100),
        stopLossPct: num('STOP_LOSS_PCT', 30),
        maxHoldMs: num('MAX_HOLD_MINUTES', 30) * 60_000,
        maxOpen: num('MAX_OPEN_POSITIONS', 5),
        pollMs: num('EXIT_CHECK_MS', 2_000)
    },

    logDir: process.env.LOG_DIR || fileURLToPath(new URL('./logs/', import.meta.url))
};
