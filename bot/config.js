// All settings come from environment variables so the filters can be tuned
// without code changes. See the "Sniper bot" section of the README.
const num = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);
const bool = (name, fallback) => (process.env[name] !== undefined ? ['1', 'true', 'yes'].includes(process.env[name].toLowerCase()) : fallback);

const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export const config = {
    rpcUrl,
    wsUrl: process.env.SOLANA_WS_URL || rpcUrl.replace(/^http/, 'ws'),

    // How long to let a coin trade before judging it; holders and snipers need time to show up.
    checkDelayMs: num('CHECK_DELAY_MS', 20_000),
    maxConcurrentChecks: num('MAX_CONCURRENT_CHECKS', 2),
    maxQueue: num('MAX_QUEUE', 20),

    filters: {
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

    paper: {
        buySol: num('PAPER_BUY_SOL', 0.1),
        feeBps: num('FEE_BPS', 100),
        takeProfitPct: num('TAKE_PROFIT_PCT', 100),
        stopLossPct: num('STOP_LOSS_PCT', 30),
        maxHoldMs: num('MAX_HOLD_MINUTES', 30) * 60_000,
        maxOpen: num('MAX_OPEN_POSITIONS', 5),
        pollMs: num('PRICE_POLL_MS', 5_000)
    },

    logDir: process.env.LOG_DIR || new URL('./logs/', import.meta.url).pathname
};
