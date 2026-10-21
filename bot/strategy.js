// Entry signal: run up -> pull back to support -> bounce, confirmed by volume.
// Pure function over the coin's trade history so it can be tested and tuned.
//
// trades: [{ time (unix s), price (SOL/token), sol (SOL), isBuy, user }] oldest first.
// Returns { state: 'wait' | 'dead' | 'buy', reason, metrics }.

const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const perMinute = (sol, from, to) => sol / (Math.max(to - from, 30) / 60);

function argExtreme(list, better) {
    let idx = 0;
    for (let i = 1; i < list.length; i++) if (better(list[i].price, list[idx].price)) idx = i;
    return idx;
}

export function analyze(trades, cfg, now) {
    if (trades.length < 2) return { state: 'wait', reason: 'not enough trades' };

    const launchPrice = trades[0].price;
    const peakIdx = argExtreme(trades, (a, b) => a > b);
    const peak = trades[peakIdx].price;
    const runPct = (peak / launchPrice - 1) * 100;
    if (runPct < cfg.minRunPct) return { state: 'wait', reason: `run ${runPct.toFixed(0)}% < ${cfg.minRunPct}%` };

    // Support = volume-weighted average price of the run: where the run's buyers got in.
    const run = trades.slice(0, peakIdx + 1);
    const support = sum(run, t => t.sol) / sum(run, t => t.sol / t.price);

    const after = trades.slice(peakIdx + 1);
    if (!after.length) return { state: 'wait', reason: 'still running' };
    const lowIdx = peakIdx + 1 + argExtreme(after, (a, b) => a < b);
    const low = trades[lowIdx].price;
    const price = trades[trades.length - 1].price;
    const pullbackPct = (1 - low / peak) * 100;
    const bouncePct = (price / low - 1) * 100;

    const metrics = { runPct, peak, support, low, price, pullbackPct, bouncePct };

    if (low < support * (1 - cfg.supportBreakPct / 100)) return { state: 'dead', reason: `broke support by more than ${cfg.supportBreakPct}%`, metrics };
    if (pullbackPct > cfg.maxPullbackPct) return { state: 'dead', reason: `pulled back ${pullbackPct.toFixed(0)}% (max ${cfg.maxPullbackPct}%)`, metrics };
    if (pullbackPct < cfg.minPullbackPct) return { state: 'wait', reason: `pullback ${pullbackPct.toFixed(0)}% < ${cfg.minPullbackPct}%`, metrics };
    if (low > support * (1 + cfg.retestTolerancePct / 100)) return { state: 'wait', reason: 'pullback has not reached support', metrics };
    if (bouncePct < cfg.minBouncePct) return { state: 'wait', reason: `bounce ${bouncePct.toFixed(0)}% < ${cfg.minBouncePct}%`, metrics };
    // Too far off the low and the entry is late; wait in case it dips again.
    if (bouncePct > cfg.maxBouncePct) return { state: 'wait', reason: `bounce ${bouncePct.toFixed(0)}% > ${cfg.maxBouncePct}%, entry would be late`, metrics };

    // Volume: enough real activity, a quiet pullback, and buyers stepping in on the bounce.
    const pullback = trades.slice(peakIdx + 1, lowIdx + 1);
    const bounce = trades.slice(lowIdx + 1);
    const byWallet = new Map();
    for (const t of trades) byWallet.set(t.user, (byWallet.get(t.user) || 0) + t.sol);
    const totalVol = sum(trades, t => t.sol);
    const bounceBuy = sum(bounce.filter(t => t.isBuy), t => t.sol);
    const bounceSell = sum(bounce.filter(t => !t.isBuy), t => t.sol);
    Object.assign(metrics, {
        totalVol,
        traders: byWallet.size,
        topWalletVolPct: Math.max(...byWallet.values()) / totalVol * 100,
        runVolPerMin: perMinute(sum(run, t => t.sol), trades[0].time, trades[peakIdx].time),
        pullbackVolPerMin: perMinute(sum(pullback, t => t.sol), trades[peakIdx].time, trades[lowIdx].time),
        bounceVol: bounceBuy + bounceSell,
        bounceBuyRatio: bounceSell > 0 ? bounceBuy / bounceSell : Infinity,
        recentVol: sum(trades.filter(t => t.time >= now - 60), t => t.sol)
    });

    const fails = [];
    if (metrics.totalVol < cfg.minTotalVolSol) fails.push(`volume ${metrics.totalVol.toFixed(1)} SOL < ${cfg.minTotalVolSol}`);
    if (metrics.traders < cfg.minTraders) fails.push(`${metrics.traders} traders < ${cfg.minTraders}`);
    if (metrics.topWalletVolPct > cfg.maxWalletVolPct) fails.push(`one wallet is ${metrics.topWalletVolPct.toFixed(0)}% of volume (wash trading?)`);
    if (metrics.pullbackVolPerMin > metrics.runVolPerMin * cfg.maxPullbackVolRatio) fails.push('pullback volume too heavy vs the run (sellers in control)');
    if (metrics.bounceVol < cfg.minBounceVolSol) fails.push(`bounce volume ${metrics.bounceVol.toFixed(1)} SOL < ${cfg.minBounceVolSol}`);
    if (metrics.bounceBuyRatio < cfg.minBounceBuyRatio) fails.push(`bounce buy/sell ${metrics.bounceBuyRatio.toFixed(2)} < ${cfg.minBounceBuyRatio}`);
    if (metrics.recentVol < cfg.minRecentVolSol) fails.push(`last-minute volume ${metrics.recentVol.toFixed(1)} SOL < ${cfg.minRecentVolSol}`);

    if (fails.length) return { state: 'wait', reason: fails.join('; '), metrics };
    return { state: 'buy', reason: 'retest bounce confirmed by volume', metrics };
}
