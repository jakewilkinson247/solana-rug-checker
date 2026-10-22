import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58Encode, base58Decode } from '../../lib/solana.mjs';
import { parseSwapLogs, decodePool, isSolQuote, WSOL_MINT } from '../pumpswap.js';
import { PaperTrader } from '../paper.js';

const disc = name => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const key = n => Buffer.alloc(32, n);
const u = (bytes, v) => { const b = Buffer.alloc(bytes); bytes === 1 ? b.writeUInt8(v) : bytes === 2 ? b.writeUInt16LE(v) : b.writeBigUInt64LE(BigInt(v)); return b; };
const dataLine = buf => `Program data: ${buf.toString('base64')}`;
const wsol = Buffer.from(base58Decode(WSOL_MINT));

// Field order from the pump_amm IDL (@pump-fun/pump-swap-sdk).
function createPoolEvent() {
    return Buffer.concat([
        disc('CreatePoolEvent'), u(8, 1_700_000_000), u(2, 0), key(1) /* creator */, key(2) /* base mint */, wsol,
        u(1, 6), u(1, 9), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(1, 255),
        key(3) /* pool */, key(4), key(5), key(6), key(7) /* coin creator */, Buffer.from([0]), u(8, 0), Buffer.from([0, 0])
    ]);
}
function swapEvent(name, base, quote, user) {
    const amounts = [u(8, base), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(8, 0), u(8, quote)];
    return Buffer.concat([disc(name), u(8, 1_700_000_100), ...amounts, ...Array(6).fill(u(8, 0)), key(3) /* pool */, key(user), ...Array(5).fill(key(0)), u(8, 0)]);
}

test('parseSwapLogs decodes pool creation, buys and sells', () => {
    const { pools, swaps } = parseSwapLogs([
        'Program log: Instruction: CreatePool', dataLine(createPoolEvent()),
        dataLine(swapEvent('BuyEvent', 2_000_000_000, 500_000_000, 8)),
        dataLine(swapEvent('SellEvent', 1_000_000_000, 240_000_000, 9))
    ]);
    assert.deepEqual(pools[0], {
        timestamp: 1_700_000_000, creator: base58Encode(key(1)), baseMint: base58Encode(key(2)), quoteMint: WSOL_MINT,
        baseDecimals: 6, quoteDecimals: 9, pool: base58Encode(key(3)), coinCreator: base58Encode(key(7))
    });
    assert.equal(swaps.length, 2);
    assert.deepEqual(swaps[0], { timestamp: 1_700_000_100, baseAmount: 2_000_000_000n, quoteAmount: 500_000_000n, pool: base58Encode(key(3)), user: base58Encode(key(8)), isBuy: true });
    assert.equal(swaps[1].isBuy, false);
    assert.equal(swaps[1].quoteAmount, 240_000_000n);
});

test('decodePool reads mints, vaults and the coin creator at the IDL offsets', () => {
    const buf = Buffer.concat([Buffer.alloc(8), u(1, 255), u(2, 0), key(1), key(2), wsol, key(4), key(5), key(6), u(8, 0), key(7)]);
    assert.deepEqual(decodePool(buf.toString('base64')), {
        baseMint: base58Encode(key(2)), quoteMint: WSOL_MINT, baseVault: base58Encode(key(5)), quoteVault: base58Encode(key(6)),
        coinCreator: base58Encode(key(7))
    });
    // Older, shorter pool accounts have no coin creator.
    assert.equal(decodePool(buf.subarray(0, 211)).coinCreator, null);
});

test('paper positions keep pricing after a coin graduates to PumpSwap', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'paper-'));
    const trader = new PaperTrader({ buySol: 1, feeBps: 0, takeProfitPct: 100, stopLossPct: 30, maxHoldMs: 60_000, maxOpen: 5, pollMs: 60_000 }, logDir);
    try {
        trader.open({ mint: 'M', symbol: 'TST' }, { price: 0.001, venue: 'curve' });
        assert.equal(trader.positions.get('M').tokens, 1000);
        trader.onPrice('M', 0.0015, 'curve');
        trader.checkExits();
        assert.equal(trader.positions.size, 1);
        trader.onPrice('M', 0.0021, 'pumpswap');
        assert.equal(trader.positions.get('M').venue, 'pumpswap');
        trader.checkExits();
        assert.equal(trader.positions.size, 0);
        const close = readFileSync(join(logDir, 'trades.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).pop();
        assert.equal(close.reason, 'take-profit');
        assert.equal(close.venue, 'pumpswap');
        assert.ok(Math.abs(close.pnlSol - 1.1) < 1e-9);
    } finally {
        trader.stop();
    }
});

test('isSolQuote accepts every way pump.fun marks a SOL-quoted coin', () => {
    assert.ok(isSolQuote(base58Encode(Buffer.alloc(32)))); // default key: ordinary SOL coins
    assert.ok(isSolQuote(WSOL_MINT));
    assert.ok(isSolQuote('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP'));
    assert.ok(!isSolQuote('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')); // USDC
});
