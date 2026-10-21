// Watches pump.fun for new coins, runs each through the rug/sniper filters
// after a short delay, then (in retest mode) watches the ones that pass for a
// run -> pullback -> bounce off support with healthy volume, and paper-trades it.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { PUMP_PROGRAM, parseLogs, curvePrice } from './pumpfun.js';
import { gatherMetrics, evaluate } from './filters.js';
import { analyze } from './strategy.js';
import { PaperTrader } from './paper.js';

const MAX_TRADES_PER_COIN = 20_000;

mkdirSync(config.logDir, { recursive: true });
const decisionsFile = join(config.logDir, 'decisions.jsonl');
const trader = new PaperTrader(config.paper, config.logDir);

// Every coin being checked or watched, with its trades since launch (from the log stream).
const coins = new Map();
const queue = [];
let running = 0;
const stats = { seen: 0, passed: 0, rejected: 0, dropped: 0, errors: 0, watching: 0, entries: 0, died: 0, expired: 0 };

const logDecision = entry => appendFileSync(decisionsFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');

function onLaunch(launch) {
    stats.seen++;
    if (queue.length >= config.maxQueue) { stats.dropped++; return; }
    coins.set(launch.mint, { launch, trades: [], state: 'checking', watchUntil: 0 });
    console.log(`[new] ${launch.symbol} ${launch.mint} (dev buy ${(Number(launch.devBuyRaw) / 1e13).toFixed(1)}%)`);
    setTimeout(() => { queue.push(launch); drain(); }, config.checkDelayMs);
}

function onTrade(t) {
    const coin = coins.get(t.mint);
    if (!coin || coin.trades.length >= MAX_TRADES_PER_COIN) return;
    coin.trades.push({
        time: t.timestamp,
        price: curvePrice(t),
        sol: Number(t.solAmount) / 1e9,
        isBuy: t.isBuy,
        user: t.user
    });
}

function drain() {
    while (running < config.maxConcurrentChecks && queue.length) {
        const launch = queue.shift();
        running++;
        check(launch).finally(() => { running--; drain(); });
    }
}

async function check(launch) {
    const coin = coins.get(launch.mint);
    try {
        const metrics = await gatherMetrics(launch, config.filters);
        const { pass, reasons } = evaluate(metrics, config.filters);
        logDecision({ stage: 'filters', mint: launch.mint, symbol: launch.symbol, pass, reasons, metrics: { ...metrics, curve: undefined } });
        if (!pass) {
            stats.rejected++;
            coins.delete(launch.mint);
            console.log(`[reject] ${launch.symbol}: ${reasons.join('; ')}`);
            return;
        }
        stats.passed++;
        if (config.entryMode === 'immediate') {
            coins.delete(launch.mint);
            console.log(`[PASS] ${launch.symbol} ${launch.mint}`);
            if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, metrics.curve);
            return;
        }
        coin.state = 'watching';
        coin.watchUntil = Date.now() + config.entry.watchMinutes * 60_000;
        console.log(`[watch] ${launch.symbol} ${launch.mint} passed filters, waiting for a retest`);
    } catch (e) {
        stats.errors++;
        coins.delete(launch.mint);
        console.error(`[error] ${launch.symbol}: ${e.message}`);
    }
}

// Re-run the cheap safety checks right before entering: the dev or a whale may have dumped since.
async function enter(coin, signal) {
    const { launch } = coin;
    try {
        const metrics = await gatherMetrics(launch, { ...config.filters, clusterCheck: false, requireSocials: false });
        const { pass, reasons } = evaluate(metrics, config.filters);
        logDecision({ stage: 'entry', mint: launch.mint, symbol: launch.symbol, pass, reasons, signal });
        if (!pass) { console.log(`[skip] ${launch.symbol} retest signal but filters now fail: ${reasons.join('; ')}`); return; }
        stats.entries++;
        console.log(`[ENTRY] ${launch.symbol} ${launch.mint}: run ${signal.metrics.runPct.toFixed(0)}%, pulled back ${signal.metrics.pullbackPct.toFixed(0)}%, bounced ${signal.metrics.bouncePct.toFixed(0)}% on ${signal.metrics.bounceVol.toFixed(1)} SOL`);
        if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, metrics.curve);
    } catch (e) {
        stats.errors++;
        console.error(`[error] ${launch.symbol} entry: ${e.message}`);
    }
}

function evaluateWatchlist() {
    const now = Date.now();
    for (const [mint, coin] of coins) {
        if (coin.state !== 'watching') continue;
        const signal = analyze(coin.trades, config.entry, now / 1000);
        coin.lastReason = signal.reason;
        if (signal.state === 'buy') {
            coins.delete(mint);
            enter(coin, signal);
        } else if (signal.state === 'dead') {
            stats.died++;
            coins.delete(mint);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [signal.reason], metrics: signal.metrics });
            console.log(`[drop] ${coin.launch.symbol}: ${signal.reason}`);
        } else if (now >= coin.watchUntil) {
            stats.expired++;
            coins.delete(mint);
            logDecision({ stage: 'watch', mint, symbol: coin.launch.symbol, pass: false, reasons: [`no entry within ${config.entry.watchMinutes} min (last: ${signal.reason})`] });
        }
    }
    stats.watching = [...coins.values()].filter(c => c.state === 'watching').length;
}

function connect(attempt = 0) {
    const ws = new WebSocket(config.wsUrl);
    ws.onopen = () => {
        attempt = 0;
        console.log(`[ws] connected, watching pump.fun launches`);
        ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
            params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }]
        }));
    };
    ws.onmessage = msg => {
        const data = JSON.parse(msg.data);
        const value = data.params?.result?.value;
        if (!value || value.err) return;
        const { creates, trades } = parseLogs(value.logs);
        for (const c of creates) {
            const devBuy = trades.find(t => t.mint === c.mint && t.isBuy && t.user === c.user);
            onLaunch({
                ...c, signature: value.signature, slot: data.params.result.context.slot,
                timestamp: Math.floor(Date.now() / 1000), devBuyRaw: devBuy?.tokenAmount ?? 0n
            });
        }
        for (const t of trades) onTrade(t);
    };
    ws.onclose = () => {
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        console.error(`[ws] disconnected, reconnecting in ${wait / 1000}s`);
        setTimeout(() => connect(attempt + 1), wait);
    };
    ws.onerror = e => console.error(`[ws] error: ${e.message || 'connection failed'}`);
}

if (config.entryMode === 'retest') setInterval(evaluateWatchlist, config.entry.evalMs);

setInterval(() => console.log(
    `[stats] seen ${stats.seen}, passed ${stats.passed}, rejected ${stats.rejected}, dropped ${stats.dropped}, errors ${stats.errors}` +
    (config.entryMode === 'retest' ? ` | watching ${stats.watching}, entries ${stats.entries}, died ${stats.died}, expired ${stats.expired}` : '') +
    ` | ${trader.summary()}`
), 60_000);

process.on('SIGINT', () => {
    trader.stop();
    console.log(`\n[done] ${trader.summary()}`);
    process.exit(0);
});

console.log(`Entry mode: ${config.entryMode}. Paper trading ${config.paper.buySol} SOL per entry. Logs in ${config.logDir}`);
connect();
