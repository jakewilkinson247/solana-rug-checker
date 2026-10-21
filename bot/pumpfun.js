// Decoding for pump.fun program logs and bonding-curve accounts, plus the
// curve's constant-product price math.
import { createHash } from 'node:crypto';
import { base58Encode } from '../lib/solana.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const TOKEN_DECIMALS = 6;
export const TOTAL_SUPPLY_RAW = 1_000_000_000n * 10n ** 6n;
const LAMPORTS = 1e9;

// Anchor events are logged as "Program data: <base64>", prefixed with
// sha256("event:<Name>")[0..8].
const discriminator = name => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const CREATE_EVENT = discriminator('CreateEvent');
const TRADE_EVENT = discriminator('TradeEvent');

class Reader {
    constructor(buf) { this.buf = buf; this.o = 8; }
    string() { const n = this.buf.readUInt32LE(this.o); this.o += 4; const s = this.buf.toString('utf8', this.o, this.o + n); this.o += n; return s; }
    pubkey() { const k = base58Encode(this.buf.subarray(this.o, this.o + 32)); this.o += 32; return k; }
    u64() { const v = this.buf.readBigUInt64LE(this.o); this.o += 8; return v; }
    i64() { const v = this.buf.readBigInt64LE(this.o); this.o += 8; return v; }
    bool() { return this.buf[this.o++] === 1; }
    has(n) { return this.o + n <= this.buf.length; }
}

function decodeCreate(r) {
    const e = { name: r.string(), symbol: r.string(), uri: r.string(), mint: r.pubkey(), bondingCurve: r.pubkey(), user: r.pubkey() };
    // Newer program versions also log the creator (who receives creator fees), then
    // timestamp, four reserve/supply u64s, token program and two flags before the quote mint.
    e.creator = r.has(32) ? r.pubkey() : e.user;
    if (r.has(8 * 5 + 32 + 2 + 32)) {
        r.o += 8 * 5 + 32 + 2;
        e.quoteMint = r.pubkey();
    }
    return e;
}

function decodeTrade(r) {
    return {
        mint: r.pubkey(), solAmount: r.u64(), tokenAmount: r.u64(), isBuy: r.bool(), user: r.pubkey(),
        timestamp: Number(r.i64()), virtualSolReserves: r.u64(), virtualTokenReserves: r.u64()
    };
}

// Returns { creates: [...], trades: [...] } found in a transaction's log lines.
export function parseLogs(logs) {
    const out = { creates: [], trades: [] };
    for (const line of logs || []) {
        if (!line.startsWith('Program data: ')) continue;
        const buf = Buffer.from(line.slice(14), 'base64');
        if (buf.length < 8) continue;
        const disc = buf.subarray(0, 8);
        try {
            if (disc.equals(CREATE_EVENT)) out.creates.push(decodeCreate(new Reader(buf)));
            else if (disc.equals(TRADE_EVENT)) out.trades.push(decodeTrade(new Reader(buf)));
        } catch { /* truncated or foreign event; ignore */ }
    }
    return out;
}

// Bonding curve account: 8-byte discriminator, five u64 reserves, `complete` flag.
export function decodeBondingCurve(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    return {
        virtualTokenReserves: buf.readBigUInt64LE(8),
        virtualSolReserves: buf.readBigUInt64LE(16),
        realTokenReserves: buf.readBigUInt64LE(24),
        realSolReserves: buf.readBigUInt64LE(32),
        tokenTotalSupply: buf.readBigUInt64LE(40),
        complete: buf[48] === 1
    };
}

// Price in SOL per whole token.
export function curvePrice(curve) {
    return (Number(curve.virtualSolReserves) / LAMPORTS) / (Number(curve.virtualTokenReserves) / 10 ** TOKEN_DECIMALS);
}

// Raw tokens received for `sol` SOL in, after the trading fee.
export function quoteBuy(curve, sol, feeBps) {
    const solIn = BigInt(Math.floor(sol * LAMPORTS * (1 - feeBps / 10_000)));
    const k = curve.virtualSolReserves * curve.virtualTokenReserves;
    const out = curve.virtualTokenReserves - k / (curve.virtualSolReserves + solIn);
    return out < curve.realTokenReserves ? out : curve.realTokenReserves;
}

// SOL received for selling `tokens` raw tokens, after the trading fee.
export function quoteSell(curve, tokens, feeBps) {
    const k = curve.virtualSolReserves * curve.virtualTokenReserves;
    const solOut = curve.virtualSolReserves - k / (curve.virtualTokenReserves + tokens);
    return Number(solOut) / LAMPORTS * (1 - feeBps / 10_000);
}
