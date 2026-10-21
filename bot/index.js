// Watches pump.fun for new coins, runs each through the rug/sniper filters
// after a short delay, and paper-trades the ones that pass.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { PUMP_PROGRAM, parseLogs } from './pumpfun.js';
import { gatherMetrics, evaluate } from './filters.js';
import { PaperTrader } from './paper.js';

mkdirSync(config.logDir, { recursive: true });
const decisionsFile = join(config.logDir, 'decisions.jsonl');
const trader = new PaperTrader(config.paper, config.logDir);

const queue = [];
let running = 0;
const stats = { seen: 0, passed: 0, rejected: 0, dropped: 0, errors: 0 };

function onLaunch(launch) {
    stats.seen++;
    if (queue.length >= config.maxQueue) { stats.dropped++; return; }
    console.log(`[new] ${launch.symbol} ${launch.mint} (dev buy ${(Number(launch.devBuyRaw) / 1e13).toFixed(1)}%)`);
    setTimeout(() => { queue.push(launch); drain(); }, config.checkDelayMs);
}

function drain() {
    while (running < config.maxConcurrentChecks && queue.length) {
        const launch = queue.shift();
        running++;
        check(launch).finally(() => { running--; drain(); });
    }
}

async function check(launch) {
    try {
        const metrics = await gatherMetrics(launch, config.filters);
        const { pass, reasons } = evaluate(metrics, config.filters);
        appendFileSync(decisionsFile, JSON.stringify({
            time: new Date().toISOString(), mint: launch.mint, symbol: launch.symbol, pass, reasons,
            metrics: { ...metrics, curve: undefined }
        }) + '\n');
        if (!pass) {
            stats.rejected++;
            console.log(`[reject] ${launch.symbol}: ${reasons.join('; ')}`);
            return;
        }
        stats.passed++;
        console.log(`[PASS] ${launch.symbol} ${launch.mint}`);
        if (!trader.full && !trader.positions.has(launch.mint)) trader.open(launch, metrics.curve);
    } catch (e) {
        stats.errors++;
        console.error(`[error] ${launch.symbol}: ${e.message}`);
    }
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
        if (!value || value.err || !value.logs.some(l => l.includes('Instruction: Create'))) return;
        const { creates, trades } = parseLogs(value.logs);
        for (const c of creates) {
            const devBuy = trades.find(t => t.mint === c.mint && t.isBuy && t.user === c.user);
            onLaunch({
                ...c, signature: value.signature, slot: data.params.result.context.slot,
                timestamp: Math.floor(Date.now() / 1000), devBuyRaw: devBuy?.tokenAmount ?? 0n
            });
        }
    };
    ws.onclose = () => {
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        console.error(`[ws] disconnected, reconnecting in ${wait / 1000}s`);
        setTimeout(() => connect(attempt + 1), wait);
    };
    ws.onerror = e => console.error(`[ws] error: ${e.message || 'connection failed'}`);
}

setInterval(() => console.log(`[stats] seen ${stats.seen}, passed ${stats.passed}, rejected ${stats.rejected}, dropped ${stats.dropped}, errors ${stats.errors} | ${trader.summary()}`), 60_000);

process.on('SIGINT', () => {
    trader.stop();
    console.log(`\n[done] ${trader.summary()}`);
    process.exit(0);
});

console.log(`Paper trading ${config.paper.buySol} SOL per pass. Logs in ${config.logDir}`);
connect();
