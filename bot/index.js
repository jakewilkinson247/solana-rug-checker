// Watches pump.fun and PumpSwap for new coins, runs each through the rug/sniper
// filters after a short delay, then (in retest mode) watches the ones that pass
// for a run -> pullback -> bounce off support with healthy volume, and paper-trades it.
// Coins that graduate from the bonding curve keep being tracked on their PumpSwap pool,
// and older coins that suddenly get busy are picked up as candidates too.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rpc } from '../lib/solana.mjs';
import { config } from './config.js';
import { PUMP_PROGRAM, parseLogs, curvePrice, bondingCurveAddress, decodeBondingCurve, TOKEN_DECIMALS } from './pumpfun.js';
import { PUMPSWAP_PROGRAM, isSolQuote, parseSwapLogs, decodePool } from './pumpswap.js';
import { ActivityTracker } from './activity.js';
import { createNotifier, coinLink } from './notify.js';
import { gatherMetrics, evaluate, prefilter } from './filters.js';
import { analyze } from './strategy.js';
import { PaperTrader } from './paper.js';

const MAX_TRADES_PER_COIN = 20_000;

mkdirSync(config.logDir, { recursive: true });
const decisionsFile = join(config.logDir, 'decisions.jsonl');
const notify = createNotifier({ ...config.notify, onError: e => console.error(`[notify] failed: ${e.message}`) });
const trader = new PaperTrader(config.paper, config.logDir, {
    onClose: p => notify({
        title: `${p.pnlSol >= 0 ? 'SELL (profit)' : 'SELL (loss)'}: ${p.symbol}`,
        message: `${p.reason}, ${p.pnlSol >= 0 ? '+' : ''}${p.pnlSol.toFixed(4)} SOL on ${p.costSol} SOL\n${p.mint}`,
        click: coinLink(p.mint), priority: 5, tags: [p.pnlSol >= 0 ? 'moneybag' : 'small_red_triangle_down']
    })
});

// Every coin being checked or watched, with its trades since launch (from the log stream).
const coins = new Map();
// PumpSwap pool -> { mint, decimals } for coins we track; swap events only name the pool.
const pools = new Map();
// Symbol -> launch times, for spotting the same name launched over and over.
const launchesByName = new Map();
// Recent trades of coins we aren't tracking, keyed by mint (bonding curve) or "pool:<address>"
// (PumpSwap, whose swap events only name the pool).
const activity = new ActivityTracker({ lookbackMin: config.existing.historyMin });
// Mint or activity key -> time until which it isn't picked up again.
const cooldown = new Map();
// PumpSwap pools that aren't SOL-paired pump.fun coins.
const ignoredPools = new Set();
const promoting = new Set();
const queue = [];
let running = 0;
const stats = { seen: 0, passed: 0, rejected: 0, dropped: 0, errors: 0, entries: 0, died: 0, expired: 0, graduated: 0, older: 0 };

// Quiet by default: only watches, entries and paper trades. VERBOSE=true shows every coin.
const debug = config.verbose ? console.log : () => {};
const logDecision = entry => appendFileSync(decisionsFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
const tracked = mint => coins.has(mint) || trader.positions.has(mint);
const cooling = key => (cooldown.get(key) || 0) > Date.now();
const rest = (...keys) => keys.forEach(k => k && cooldown.set(k, Date.now() + config.existing.cooldownMin * 60_000));

// Stop tracking a coin and don't pick it up again as an older coin for a while.
function release(launch) {
    coins.delete(launch.mint);
    rest(launch.mint, launch.pool && `pool:${launch.pool}`);
}
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
    if (launch.pool || launch.existing) return 0; // no symbol from the log stream
    const since = Date.now() - config.filters.copycatMinutes * 60_000;
    return (launchesByName.get(launch.symbol.trim().toLowerCase()) || []).filter(t => t >= since).length;
}

async function check(launch) {
    const coin = coins.get(launch.mint);
    const pre = prefilter(coin.trades, launch, sameNameCount(launch), config.filters);
    if (!pre.pass) {
        stats.rejected++;
        release(launch);
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
            release(launch);
            debug(`[reject] ${launch.symbol}: ${reasons.join('; ')}`);
            return;
        }
        stats.passed++;
        if (config.entryMode === 'immediate') {
            coins.delete(launch.mint);
            console.log(`[PASS] ${launch.symbol} ${launch.mint}\n        ${coinLink(launch.mint)}`);
            notify({ title: `ENTRY: ${launch.symbol}`, message: `Passed the safety checks\n${launch.mint}`, click: coinLink(launch.mint), priority: 5, tags: ['rotating_light'] });
            if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, { curve: metrics.curve, price: lastPrice(coin), venue: metrics.venue });
            return;
        }
        coin.state = 'watching';
        coin.watchUntil = Date.now() + config.entry.watchMinutes * 60_000;
        console.log(`[watch] ${launch.symbol} ${launch.mint} ${launch.existing ? '(older coin getting busy) ' : ''}passed filters, waiting for a retest`);
        if (config.notify.watch) notify({
            title: `Watching ${launch.symbol}${launch.existing ? ' (older coin)' : ''}`,
            message: `Passed the safety checks, waiting for a retest\n${launch.mint}`,
            click: coinLink(launch.mint), priority: 2, tags: ['eyes']
        });
    } catch (e) {
        stats.errors++;
        release(launch);
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
        if (!pass) { console.log(`[skip] ${launch.symbol} retest signal but filters now fail: ${reasons.join('; ')}`); return; }
        stats.entries++;
        const summary = `run ${signal.metrics.runPct.toFixed(0)}%, pulled back ${signal.metrics.pullbackPct.toFixed(0)}%, bounced ${signal.metrics.bouncePct.toFixed(0)}% on ${signal.metrics.bounceVol.toFixed(1)} SOL`;
        console.log(`[ENTRY] ${launch.symbol} ${launch.mint} on ${metrics.venue}: ${summary}\n        ${coinLink(launch.mint)}`);
        notify({ title: `ENTRY: ${launch.symbol}`, message: `${summary}\n${launch.mint}`, click: coinLink(launch.mint), priority: 5, tags: ['rotating_light'] });
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
            release(coin.launch);
            enter(coin, signal);
        } else if (signal.state === 'dead') {
            stats.died++;
            release(coin.launch);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [signal.reason], metrics: signal.metrics });
            console.log(`[drop] ${coin.launch.symbol}: ${signal.reason}`);
        } else if (now >= coin.watchUntil) {
            stats.expired++;
            release(coin.launch);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [`no entry within ${config.entry.watchMinutes} min (last: ${signal.reason})`] });
            console.log(`[expired] ${coin.launch.symbol}: no entry within ${config.entry.watchMinutes} min (last: ${signal.reason})`);
        }
    }
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
        const trade = { time: t.timestamp, price: curvePrice(t), sol: Number(t.solAmount) / 1e9, isBuy: t.isBuy, user: t.user };
        if (tracked(t.mint)) onTrade(t.mint, trade, 'curve');
        else if (config.existing.enabled && !cooling(t.mint)) activity.add(t.mint, trade);
    }

    if (!config.watchPumpSwap) return;
    const { pools: created, swaps } = parseSwapLogs(value.logs);
    for (const p of created) onPool(p, value.signature, slot);
    for (const s of swaps) {
        if (s.baseAmount === 0n) continue;
        const pool = pools.get(s.pool);
        const sol = Number(s.quoteAmount) / 1e9;
        // Unknown pools are assumed to be pump.fun coins (6 decimals) until looked up.
        const price = sol / (Number(s.baseAmount) / 10 ** (pool?.decimals ?? TOKEN_DECIMALS));
        const trade = { time: s.timestamp, price, sol, isBuy: s.isBuy, user: s.user };
        if (pool) onTrade(pool.mint, trade, 'pumpswap');
        else if (config.existing.enabled && !ignoredPools.has(s.pool) && !cooling(`pool:${s.pool}`)) activity.add(`pool:${s.pool}`, trade);
    }
}

// Older coins: look up a busy coin's addresses and send it through the normal checks,
// with the trade history that made it busy.
async function promote(key) {
    promoting.add(key);
    try {
        let found;
        if (key.startsWith('pool:')) {
            const pool = key.slice(5);
            const info = await rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
            const p = info?.value && decodePool(info.value.data[0]);
            if (!p || !isSolQuote(p.quoteMint) || !p.baseMint.endsWith('pump')) {
                ignoredPools.add(pool);
                activity.take(key);
                return;
            }
            found = { mint: p.baseMint, pool, user: p.coinCreator };
        } else {
            const bondingCurve = bondingCurveAddress(key);
            const info = await rpc('getAccountInfo', [bondingCurve, { encoding: 'base64' }]);
            const curve = info?.value && decodeBondingCurve(info.value.data[0]);
            // A finished curve trades on its pool now; the pool's own activity will pick it up.
            if (!curve || curve.complete) { activity.take(key); rest(key); return; }
            found = { mint: key, bondingCurve, user: curve.creator };
        }
        if (queue.length >= config.maxQueue) return; // keep the history and try again on a later scan
        if (tracked(found.mint) || cooling(found.mint)) { activity.take(key); rest(key); return; }
        if (found.pool) pools.set(found.pool, { mint: found.mint, decimals: TOKEN_DECIMALS });
        const launch = {
            ...found, symbol: `${found.mint.slice(0, 6)}…`, uri: null, signature: null, slot: null,
            timestamp: Math.floor(Date.now() / 1000), devBuyRaw: 0n, existing: true
        };
        stats.older++;
        coins.set(launch.mint, { launch, trades: activity.take(key), state: 'checking', watchUntil: 0 });
        debug(`[busy] ${launch.symbol} ${launch.mint} (older coin getting busy)`);
        queue.push(launch);
        drain();
    } catch (e) {
        stats.errors++;
        debug(`[error] looking up ${key}: ${e.message}`);
    } finally {
        promoting.delete(key);
    }
}

function scanActivity() {
    const now = Date.now() / 1000;
    activity.prune(now);
    for (const { key } of activity.hot(now, config.existing)) {
        if (queue.length + promoting.size >= config.maxQueue) break;
        if (!promoting.has(key) && !cooling(key) && !tracked(key)) promote(key);
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
if (config.existing.enabled) setInterval(scanActivity, config.existing.scanMs);
setInterval(() => {
    for (const [pool, { mint }] of pools) if (!tracked(mint)) pools.delete(pool);
    for (const [key, until] of cooldown) if (until <= Date.now()) cooldown.delete(key);
    const since = Date.now() - config.filters.copycatMinutes * 60_000;
    for (const [name, times] of launchesByName) {
        const recent = times.filter(t => t >= since);
        if (recent.length) launchesByName.set(name, recent); else launchesByName.delete(name);
    }
}, 10_000);

setInterval(() => console.log(
    `[stats] seen ${stats.seen}, passed ${stats.passed}, rejected ${stats.rejected}, dropped ${stats.dropped}, errors ${stats.errors}` +
    (config.entryMode === 'retest' ? ` | watching ${watchedCoins().length}, entries ${stats.entries}, died ${stats.died}, expired ${stats.expired}` : '') +
    (config.watchPumpSwap ? ` | graduated ${stats.graduated}` : '') +
    (config.existing.enabled ? ` | older coins picked up ${stats.older}` : '') +
    ` | ${trader.summary()}` +
    watchlistSummary()
), config.verbose ? 60_000 : 600_000);

// One line per watched coin with what it is still waiting for.
const watchedCoins = () => [...coins.values()].filter(c => c.state === 'watching');

function watchlistSummary() {
    const watched = watchedCoins();
    if (!watched.length) return '';
    return '\n' + watched.map(c => {
        const minsLeft = Math.max(0, Math.round((c.watchUntil - Date.now()) / 60_000));
        const { reason } = analyze(c.trades, config.entry, Date.now() / 1000);
        return `    watching ${c.launch.symbol} ${c.launch.mint} (${minsLeft} min left): ${reason}`;
    }).join('\n');
}

process.on('SIGINT', () => {
    trader.stop();
    console.log(`\n[done] ${trader.summary()}`);
    process.exit(0);
});

console.log(`Entry mode: ${config.entryMode}. Paper trading ${config.paper.buySol} SOL per entry. Logs in ${config.logDir}`);
console.log(config.notify.topic ? `Phone notifications on (ntfy topic "${config.notify.topic}")` : 'Phone notifications off (set NTFY_TOPIC to turn them on)');
connect();
