import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base58Encode } from '../../lib/solana.mjs';
import { parseLogs, decodeBondingCurve, curvePrice, quoteBuy, quoteSell } from '../pumpfun.js';
import { evaluate, findClusters, prefilter } from '../filters.js';

const disc = name => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const key = n => Buffer.alloc(32, n);
const str = s => { const b = Buffer.from(s); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const dataLine = buf => `Program data: ${buf.toString('base64')}`;

// Initial pump.fun curve: 30 SOL / 1.073B tokens virtual, 793.1M tokens sellable.
const freshCurve = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n, complete: false };

test('parseLogs decodes create and dev-buy trade events', () => {
    const create = Buffer.concat([disc('CreateEvent'), str('Test'), str('TST'), str('https://x/meta.json'), key(1), key(2), key(3), key(4)]);
    const trade = Buffer.concat([disc('TradeEvent'), key(1), u64(1e9), u64(34_000_000_000_000n), Buffer.from([1]), key(3), u64(1700000000), u64(31e9), u64(1e15)]);
    const { creates, trades } = parseLogs(['Program log: Instruction: Create', dataLine(create), dataLine(trade), dataLine(Buffer.from('junkjunkjunk'))]);
    assert.equal(creates.length, 1);
    assert.deepEqual(
        { ...creates[0] },
        { name: 'Test', symbol: 'TST', uri: 'https://x/meta.json', mint: base58Encode(key(1)), bondingCurve: base58Encode(key(2)), user: base58Encode(key(3)), creator: base58Encode(key(4)) }
    );
    assert.equal(trades.length, 1);
    assert.equal(trades[0].isBuy, true);
    assert.equal(trades[0].tokenAmount, 34_000_000_000_000n);
    assert.equal(trades[0].user, creates[0].user);
});

test('decodeBondingCurve reads reserves and the complete flag', () => {
    const buf = Buffer.concat([Buffer.alloc(8), u64(5), u64(6), u64(7), u64(8), u64(9), Buffer.from([1])]);
    const c = decodeBondingCurve(buf.toString('base64'));
    assert.equal(c.virtualTokenReserves, 5n);
    assert.equal(c.virtualSolReserves, 6n);
    assert.equal(c.realSolReserves, 8n);
    assert.equal(c.complete, true);
});

test('curve quotes match constant-product math', () => {
    assert.ok(Math.abs(curvePrice(freshCurve) - 2.8e-8) < 1e-9);
    const tokens = quoteBuy(freshCurve, 1, 0);
    assert.equal(tokens, 34_612_903_225_807n); // ~3.46% of supply for the first SOL
    // Selling straight back with no fee returns the SOL (minus rounding) on the post-buy curve.
    const after = { ...freshCurve, virtualSolReserves: freshCurve.virtualSolReserves + 1_000_000_000n, virtualTokenReserves: freshCurve.virtualTokenReserves - tokens };
    assert.ok(Math.abs(quoteSell(after, tokens, 0) - 1) < 1e-6);
    assert.ok(quoteSell(after, tokens, 100) < 0.991);
});

test('findClusters groups fresh wallets by funder and links the dev', () => {
    const now = 1_700_000_000;
    const fundings = [
        { wallet: 'dev', funder: 'F', firstTime: now - 100 },
        { wallet: 'a', funder: 'B', firstTime: now - 60 },
        { wallet: 'b', funder: 'B', firstTime: now - 50 },
        { wallet: 'c', funder: 'B', firstTime: now - 40 },
        { wallet: 'd', funder: 'B', firstTime: now - 90 * 86400 }, // old wallet, not fresh
        { wallet: 'e', funder: 'dev', firstTime: now - 30 },
        { wallet: 'f', funder: null, established: true }
    ];
    const { largest, devLinked } = findClusters(fundings, 'dev', now, 24);
    assert.equal(largest.funder, 'B');
    assert.deepEqual(largest.wallets, ['a', 'b', 'c']);
    assert.deepEqual(devLinked, ['e']);
});

test('evaluate passes a clean launch and lists every failed rule', () => {
    const f = { maxDevBuyPct: 5, rejectIfDevSold: true, maxEarlyBuys: 3, maxTopHolderPct: 10, maxTop10Pct: 30, minRealSol: 1, requireSocials: true, maxSharedFunder: 2 };
    const clean = {
        venue: 'curve', liquidityFound: true, curve: freshCurve, realSol: 5, devBuyPct: 2, devSold: false, earlyBuys: 1, topHolderPct: 4, top10Pct: 20, socials: true,
        clusters: { largest: { funder: 'B', wallets: ['a'] }, devLinked: [] }
    };
    assert.deepEqual(evaluate(clean, f), { pass: true, reasons: [] });

    const bad = {
        ...clean, curve: { ...freshCurve, complete: true }, realSol: 0.2, devBuyPct: 12, devSold: true, earlyBuys: 9, topHolderPct: 15, top10Pct: 55, socials: false,
        clusters: { largest: { funder: 'B', wallets: ['a', 'b', 'c'] }, devLinked: ['e'] }
    };
    const { pass, reasons } = evaluate(bad, f);
    assert.equal(pass, false);
    assert.equal(reasons.length, 10);

    // Unknown early-buy count (too much activity to page back) doesn't fail on its own.
    assert.equal(evaluate({ ...clean, earlyBuys: null }, f).pass, true);
});

test('prefilter skips dead and copycat launches before any RPC calls', () => {
    const f = { minBuyers: 5, minBuySol: 1, maxSameName: 2, copycatMinutes: 30 };
    const launch = { user: 'dev', symbol: 'c/acc' };
    const buy = (user, sol) => ({ user, sol, isBuy: true });
    const active = [buy('dev', 2), ...['a', 'b', 'c', 'd', 'e'].map(u => buy(u, 0.3)), { user: 'a', sol: 0.2, isBuy: false }];

    assert.deepEqual(prefilter(active, launch, 1, f), { pass: true, reasons: [] });
    // Only the dev bought: the spam pattern from the c/acc launches.
    assert.deepEqual(prefilter([buy('dev', 2)], launch, 1, f).reasons, ['only 0 buyer(s) besides the dev (min 5)', 'only 0.00 SOL bought (min 1)']);
    // Five buyers but dust amounts.
    assert.match(prefilter(['a', 'b', 'c', 'd', 'e'].map(u => buy(u, 0.01)), launch, 1, f).reasons[0], /SOL bought/);
    assert.match(prefilter(active, launch, 3, f).reasons[0], /3 launches named "c\/acc" in 30 min/);
});
