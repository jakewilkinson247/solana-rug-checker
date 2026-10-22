import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, windowStats } from '../activity.js';
import { bondingCurveAddress, decodeBondingCurve } from '../pumpfun.js';
import { base58Encode } from '../../lib/solana.mjs';

const now = 1_700_000_000;
const trade = (secondsAgo, sol, user) => ({ time: now - secondsAgo, sol, user, price: 1, isBuy: true });

test('windowStats counts only trades inside the window', () => {
    const trades = [trade(900, 50, 'old'), trade(200, 3, 'a'), trade(100, 2, 'b'), trade(10, 1, 'a')];
    assert.deepEqual(windowStats(trades, now, 5), { vol: 6, traders: 2 });
});

test('ActivityTracker finds busy coins, busiest first, and prunes old history', () => {
    const t = new ActivityTracker({ lookbackMin: 60 });
    const cfg = { windowMin: 5, minVolSol: 15, minTraders: 20 };
    for (let i = 0; i < 25; i++) t.add('busy', trade(250 - i, 1, `w${i}`));
    for (let i = 0; i < 30; i++) t.add('busier', trade(200 - i, 2, `v${i}`));
    for (let i = 0; i < 30; i++) t.add('whale', trade(100, 5, 'one-wallet')); // volume but one trader
    for (let i = 0; i < 25; i++) t.add('stale', trade(3600 * 2, 1, `s${i}`)); // busy two hours ago

    assert.deepEqual(t.hot(now, cfg).map(h => h.key), ['busier', 'busy']);
    assert.equal(t.take('busy').length, 25);
    assert.equal(t.take('busy').length, 0);

    t.prune(now);
    assert.equal(t.size, 2); // stale history dropped
});

test('bondingCurveAddress matches @solana/web3.js findProgramAddressSync', () => {
    // Expected values computed with PublicKey.findProgramAddressSync for real pump.fun mints.
    assert.equal(bondingCurveAddress('GSx7DKi3tujLaCkgS29U83THUB5Xebddjg6QJ3Fnpump'), 'H8AUfsR7pNebWDESgP3zZMaoXvUabuREdCYRd4a7QijL');
    assert.equal(bondingCurveAddress('VyURXV4qARa6S6QbfKqw2mVeYDj46CgxdgrktW5pump'), 'FCEUpLjchjBYTbCVqVRPuBgtbJxfFwV2qjGiEsHyqxPC');
    assert.equal(bondingCurveAddress('3cbdDteWEStv2SA7rkdcn2y5ZU2qtwoh1DHg6puZpump'), 'Fb6BgfihGPFvqfLQsHwMWMWLyNM628GKwJdMG4Jpzaog');
});

test('decodeBondingCurve reads the creator when present', () => {
    const base = Buffer.concat([Buffer.alloc(8), Buffer.alloc(40), Buffer.from([0])]);
    assert.equal(decodeBondingCurve(base).creator, null);
    assert.equal(decodeBondingCurve(Buffer.concat([base, Buffer.alloc(32, 9)])).creator, base58Encode(Buffer.alloc(32, 9)));
});
