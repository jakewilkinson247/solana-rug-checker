import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../strategy.js';

const cfg = {
    minRunPct: 100, minPullbackPct: 25, maxPullbackPct: 65, retestTolerancePct: 10, supportBreakPct: 20,
    minBouncePct: 15, maxBouncePct: 50, minTotalVolSol: 30, minTraders: 40, maxWalletVolPct: 20,
    maxPullbackVolRatio: 0.8, minBounceVolSol: 5, minBounceBuyRatio: 1.3, minRecentVolSol: 1
};

// Linear price path from `from` to `to` over `n` trades spaced `dt` seconds apart.
function leg(start, n, dt, from, to, trade) {
    return Array.from({ length: n }, (_, i) => ({
        time: start + i * dt,
        price: from + (to - from) * (n === 1 ? 1 : i / (n - 1)),
        ...trade(i)
    }));
}

// Run 1 -> 3 on 60 x 1 SOL buys from 60 wallets over ~5 min (run VWAP ~1.82),
// quiet pullback to 1.85 on 15 x 0.5 SOL sells, then a bounce to ~2.3 on buys.
function retestSeries({ pullbackTo = 1.85, pullbackSol = 0.5, sameWallet = false } = {}) {
    const run = leg(0, 60, 5, 1, 3, i => ({ sol: 1, isBuy: true, user: sameWallet ? 'w' : `run${i}` }));
    const pullback = leg(305, 15, 10, 2.9, pullbackTo, i => ({ sol: pullbackSol, isBuy: false, user: `pb${i}` }));
    const bounce = leg(460, 12, 3, pullbackTo * 1.02, pullbackTo * 1.25, i => (i % 6 === 5
        ? { sol: 0.5, isBuy: false, user: `bs${i}` }
        : { sol: 1, isBuy: true, user: `bb${i}` }));
    return [...run, ...pullback, ...bounce];
}
const nowAfter = trades => trades[trades.length - 1].time + 1;

test('buys a run -> quiet pullback to support -> bounce on buy volume', () => {
    const trades = retestSeries();
    const r = analyze(trades, cfg, nowAfter(trades));
    assert.equal(r.state, 'buy', r.reason);
    assert.ok(Math.abs(r.metrics.support - 2 / Math.log(3)) < 0.05, `support ${r.metrics.support}`);
    assert.ok(r.metrics.pullbackPct > 35 && r.metrics.pullbackPct < 40);
    assert.ok(r.metrics.bounceBuyRatio > 1.3);
});

test('waits while the coin is still running or has not bounced', () => {
    const trades = retestSeries();
    assert.match(analyze(trades.slice(0, 20), cfg, 100).reason, /run \d+% < 100%/);
    assert.equal(analyze(trades.slice(0, 60), cfg, 300).reason, 'still running');
    const atLow = trades.slice(0, 75);
    assert.match(analyze(atLow, cfg, nowAfter(atLow)).reason, /bounce 0% < 15%/);
});

test('waits when the pullback has not reached support yet', () => {
    const trades = retestSeries({ pullbackTo: 2.2 });
    const r = analyze(trades, cfg, nowAfter(trades));
    assert.equal(r.state, 'wait');
    assert.equal(r.reason, 'pullback has not reached support');
});

test('drops a coin that breaks well below support', () => {
    const trades = retestSeries({ pullbackTo: 1.2 });
    const r = analyze(trades, cfg, nowAfter(trades));
    assert.equal(r.state, 'dead');
    assert.match(r.reason, /broke support/);
});

test('volume filters: heavy selling on the pullback and wash trading', () => {
    const heavy = retestSeries({ pullbackSol: 6 });
    const r1 = analyze(heavy, cfg, nowAfter(heavy));
    assert.equal(r1.state, 'wait');
    assert.match(r1.reason, /pullback volume too heavy/);

    const wash = retestSeries({ sameWallet: true });
    const r2 = analyze(wash, cfg, nowAfter(wash));
    assert.match(r2.reason, /one wallet is \d+% of volume/);
    assert.match(r2.reason, /traders < 40/);

    // Bounce happened minutes ago and nothing has traded since: dead volume.
    const trades = retestSeries();
    assert.match(analyze(trades, cfg, nowAfter(trades) + 300).reason, /last-minute volume/);
});
