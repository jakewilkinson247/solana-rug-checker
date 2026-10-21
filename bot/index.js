// Watches pump.fun and PumpSwap for new coins, runs each through the rug/sniper
// filters after a short delay, then (in retest mode) watches the ones that pass
// for a run -> pullback -> bounce off support with healthy volume, and paper-trades it.
// Coins that graduate from the bonding curve keep being tracked on their PumpSwap pool.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { PUMP_PROGRAM, parseLogs, curvePrice } from './pumpfun.js';
import { PUMPSWAP_PROGRAM, isSolQuote, parseSwapLogs } from './pumpswap.js';
import { gatherMetrics, evaluate, prefilter } from './filters.js';
import { analyze } from './strategy.js';
import { PaperTrader } from './paper.js';

const MAX_TRADES_PER_COIN = 20_000;

mkdirSync(config.logDir, { recursive: true });
const decisionsFile = join(config.logDir, 'decisions.jsonl');
const trader = new PaperTrader(config.paper, config.logDir);

// Every coin being checked or watched, with its trades since launch (from the log stream).
const coins = new Map();
// PumpSwap pool -> { mint, decimals } for coins we track; swap events only name the pool.
const pools = new Map();
// Symbol -> launch times, for spotting the same name launched over and over.
const launchesByName = new Map();
const queue = [];
let running = 0;
const stats = { seen: 0, passed: 0, rejected: 0, dropped: 0, errors: 0, watching: 0, entries: 0, died: 0, expired: 0, graduated: 0 };

// Quiet by default: only watches, entries and paper trades. VERBOSE=true shows every coin.
const debug = config.verbose ? console.log : () => {};
const logDecision = entry => appendFileSync(decisionsFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
const tracked = mint => coins.has(mint) || trader.positions.has(mint);
const lastPrice = coin => coin.trades[coin.trades.length - 1]?.price;

function onLaunch(launch) {
    stats.seen++;
    if (queue.length >= config.maxQueue) { stats.dropped++; return; }
    coins.set(launch.mint, { launch, trades: [], state: 'checking', watchUntil: 0 });
    if (!launch.pool) {
        const name = launch.symbol.trim().toLowerCase();
        launchesByName.set(name, [...(launchesByName.get(name) || []), Date.now()]);
    }
    const detail = launch.pool ? 'new PumpSwap pool' : `dev buy ${(Number(launch.devBuyRaw) / 1e13).toFixed(1)}%`;
    debug(`[new] ${launch.symbol} ${launch.mint} (${detail})`);
    setTimeout(() => { queue.push(launch); drain(); }, config.checkDelayMs);
}

function onTrade(mint, trade, venue) {
    trader.onPrice(mint, trade.price, venue);
    const coin = coins.get(mint);
    if (coin && coin.trades.length < MAX_TRADES_PER_COIN) coin.trades.push(trade);
}

// A pump.fun coin's PumpSwap pool: either a coin we already track graduating, or a new candidate.
function onPool(p, signature, slot) {
    if (!isSolQuote(p.quoteMint) || !p.baseMint.endsWith('pump')) return;
    pools.set(p.pool, { mint: p.baseMint, decimals: p.baseDecimals });
    const coin = coins.get(p.baseMint);
    if (coin) {
        stats.graduated++;
        coin.launch.pool = p.pool;
        debug(`[graduated] ${coin.launch.symbol} moved to PumpSwap, still tracking`);
    } else if (trader.positions.has(p.baseMint)) {
        stats.graduated++;
    } else if (config.watchPumpSwapPools) {
        onLaunch({
            mint: p.baseMint, pool: p.pool, user: p.coinCreator || p.creator,
            symbol: `${p.baseMint.slice(0, 6)}…`, uri: null, signature, slot,
            timestamp: Math.floor(Date.now() / 1000), devBuyRaw: 0n
        });
    } else {
        pools.delete(p.pool);
    }
}

function drain() {
    while (running < config.maxConcurrentChecks && queue.length) {
        const launch = queue.shift();
        running++;
        check(launch).finally(() => { running--; drain(); });
    }
}

function sameNameCount(launch) {
    if (launch.pool) return 0; // pool candidates have no symbol from the log stream
    const since = Date.now() - config.filters.copycatMinutes * 60_000;
    return (launchesByName.get(launch.symbol.trim().toLowerCase()) || []).filter(t => t >= since).length;
}

async function check(launch) {
    const coin = coins.get(launch.mint);
    const pre = prefilter(coin.trades, launch, sameNameCount(launch), config.filters);
    if (!pre.pass) {
        stats.rejected++;
        coins.delete(launch.mint);
        logDecision({ stage: 'prefilter', mint: launch.mint, symbol: launch.symbol, pass: false, reasons: pre.reasons });
        debug(`[reject] ${launch.symbol}: ${pre.reasons.join('; ')}`);
        return;
    }
    try {
        const metrics = await gatherMetrics(launch, config.filters);
        const { pass, reasons } = evaluate(metrics, config.filters);
        logDecision({ stage: 'filters', mint: launch.mint, symbol: launch.symbol, pass, reasons, metrics: { ...metrics, curve: undefined } });
        if (!pass) {
            stats.rejected++;
            coins.delete(launch.mint);
            debug(`[reject] ${launch.symbol}: ${reasons.join('; ')}`);
            return;
        }
        stats.passed++;
        if (config.entryMode === 'immediate') {
            coins.delete(launch.mint);
            console.log(`[PASS] ${launch.symbol} ${launch.mint}`);
            if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, { curve: metrics.curve, price: lastPrice(coin), venue: metrics.venue });
            return;
        }
        coin.state = 'watching';
        coin.watchUntil = Date.now() + config.entry.watchMinutes * 60_000;
        console.log(`[watch] ${launch.symbol} ${launch.mint} passed filters, waiting for a retest`);
    } catch (e) {
        stats.errors++;
        coins.delete(launch.mint);
        debug(`[error] ${launch.symbol}: ${e.message}`);
    }
}

// Re-run the cheap safety checks right before entering: the dev or a whale may have dumped since.
async function enter(coin, signal) {
    const { launch } = coin;
    try {
        const metrics = await gatherMetrics(launch, { ...config.filters, clusterCheck: false, requireSocials: false });
        const { pass, reasons } = evaluate(metrics, config.filters);
        logDecision({ stage: 'entry', mint: launch.mint, symbol: launch.symbol, venue: metrics.venue, pass, reasons, signal });
        if (!pass) { debug(`[skip] ${launch.symbol} retest signal but filters now fail: ${reasons.join('; ')}`); return; }
        stats.entries++;
        console.log(`[ENTRY] ${launch.symbol} ${launch.mint} on ${metrics.venue}: run ${signal.metrics.runPct.toFixed(0)}%, pulled back ${signal.metrics.pullbackPct.toFixed(0)}%, bounced ${signal.metrics.bouncePct.toFixed(0)}% on ${signal.metrics.bounceVol.toFixed(1)} SOL`);
        if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, { curve: metrics.curve, price: lastPrice(coin), venue: metrics.venue });
    } catch (e) {
        stats.errors++;
        debug(`[error] ${launch.symbol} entry: ${e.message}`);
    }
}

function evaluateWatchlist() {
    const now = Date.now();
    for (const [mint, coin] of coins) {
        if (coin.state !== 'watching') continue;
        const signal = analyze(coin.trades, config.entry, now / 1000);
        if (signal.state === 'buy') {
            coins.delete(mint);
            enter(coin, signal);
        } else if (signal.state === 'dead') {
            stats.died++;
            coins.delete(mint);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [signal.reason], metrics: signal.metrics });
            debug(`[drop] ${coin.launch.symbol}: ${signal.reason}`);
        } else if (now >= coin.watchUntil) {
            stats.expired++;
            coins.delete(mint);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [`no entry within ${config.entry.watchMinutes} min (last: ${signal.reason})`] });
        }
    }
    stats.watching = [...coins.values()].filter(c => c.state === 'watching').length;
}

// A transaction that touches both programs (e.g. a graduation) arrives once per subscription.
const recentSignatures = new Set();

function onMessage(data) {
    const value = data.params?.result?.value;
    if (!value || value.err || recentSignatures.has(value.signature)) return;
    recentSignatures.add(value.signature);
    if (recentSignatures.size > 20_000) recentSignatures.delete(recentSignatures.values().next().value);
    const slot = data.params.result.context.slot;

    const { creates, trades } = parseLogs(value.logs);
    for (const c of creates) {
        if (c.quoteMint && !isSolQuote(c.quoteMint)) continue; // prices assume SOL-quoted coins
        const devBuy = trades.find(t => t.mint === c.mint && t.isBuy && t.user === c.user);
        onLaunch({
            ...c, signature: value.signature, slot,
            timestamp: Math.floor(Date.now() / 1000), devBuyRaw: devBuy?.tokenAmount ?? 0n
        });
    }
    for (const t of trades) {
        if (!tracked(t.mint)) continue;
        onTrade(t.mint, { time: t.timestamp, price: curvePrice(t), sol: Number(t.solAmount) / 1e9, isBuy: t.isBuy, user: t.user }, 'curve');
    }

    if (!config.watchPumpSwap) return;
    const { pools: created, swaps } = parseSwapLogs(value.logs);
    for (const p of created) onPool(p, value.signature, slot);
    for (const s of swaps) {
        const pool = pools.get(s.pool);
        if (!pool || s.baseAmount === 0n) continue;
        const sol = Number(s.quoteAmount) / 1e9;
        const price = sol / (Number(s.baseAmount) / 10 ** pool.decimals);
        onTrade(pool.mint, { time: s.timestamp, price, sol, isBuy: s.isBuy, user: s.user }, 'pumpswap');
    }
}

function connect(attempt = 0) {
    const ws = new WebSocket(config.wsUrl);
    ws.onopen = () => {
        attempt = 0;
        const programs = config.watchPumpSwap ? [PUMP_PROGRAM, PUMPSWAP_PROGRAM] : [PUMP_PROGRAM];
        console.log(`[ws] connected, watching ${config.watchPumpSwap ? 'pump.fun + PumpSwap' : 'pump.fun'}`);
        programs.forEach((program, i) => ws.send(JSON.stringify({
            jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: 'confirmed' }]
        })));
    };
    ws.onmessage = msg => onMessage(JSON.parse(msg.data));
    ws.onclose = () => {
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        console.error(`[ws] disconnected, reconnecting in ${wait / 1000}s`);
        setTimeout(() => connect(attempt + 1), wait);
    };
    ws.onerror = e => console.error(`[ws] error: ${e.message || 'connection failed'}`);
}

if (config.entryMode === 'retest') setInterval(evaluateWatchlist, config.entry.evalMs);
setInterval(() => {
    for (const [pool, { mint }] of pools) if (!tracked(mint)) pools.delete(pool);
    const since = Date.now() - config.filters.copycatMinutes * 60_000;
    for (const [name, times] of launchesByName) {
        const recent = times.filter(t => t >= since);
        if (recent.length) launchesByName.set(name, recent); else launchesByName.delete(name);
    }
}, 10_000);

setInterval(() => console.log(
    `[stats] seen ${stats.seen}, passed ${stats.passed}, rejected ${stats.rejected}, dropped ${stats.dropped}, errors ${stats.errors}` +
    (config.entryMode === 'retest' ? ` | watching ${stats.watching}, entries ${stats.entries}, died ${stats.died}, expired ${stats.expired}` : '') +
    (config.watchPumpSwap ? ` | graduated ${stats.graduated}` : '') +
    ` | ${trader.summary()}`
), config.verbose ? 60_000 : 600_000);

process.on('SIGINT', () => {
    trader.stop();
    console.log(`\n[done] ${trader.summary()}`);
    process.exit(0);
});

console.log(`Entry mode: ${config.entryMode}. Paper trading ${config.paper.buySol} SOL per entry. Logs in ${config.logDir}`);
connect();
