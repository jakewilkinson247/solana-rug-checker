// Decoding for PumpSwap (pump.fun's AMM) logs and pool accounts. Layouts come
// from the pump_amm IDL shipped in @pump-fun/pump-swap-sdk.
import { createHash } from 'node:crypto';
import { base58Encode } from '../lib/solana.mjs';

export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const discriminator = name => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const CREATE_POOL_EVENT = discriminator('CreatePoolEvent');
const BUY_EVENT = discriminator('BuyEvent');
const SELL_EVENT = discriminator('SellEvent');

// Offsets are relative to the end of the 8-byte discriminator.
const key = (buf, at) => base58Encode(buf.subarray(8 + at, 8 + at + 32));
const u64 = (buf, at) => buf.readBigUInt64LE(8 + at);

function decodeCreatePool(buf) {
    return {
        timestamp: Number(buf.readBigInt64LE(8)),
        creator: key(buf, 10),
        baseMint: key(buf, 42),
        quoteMint: key(buf, 74),
        baseDecimals: buf[8 + 106],
        quoteDecimals: buf[8 + 107],
        pool: key(buf, 165),
        // Original pump.fun dev for migrated coins; absent from the oldest layout.
        coinCreator: buf.length >= 8 + 325 ? key(buf, 293) : null
    };
}

// Buy and sell events share the same leading layout: base amount at 8, quote amount at 56,
// pool at 112, user at 144.
function decodeSwap(buf, isBuy) {
    return {
        timestamp: Number(buf.readBigInt64LE(8)),
        baseAmount: u64(buf, 8),
        quoteAmount: u64(buf, 56),
        pool: key(buf, 112),
        user: key(buf, 144),
        isBuy
    };
}

// Returns { pools: [...], swaps: [...] } found in a transaction's log lines.
export function parseSwapLogs(logs) {
    const out = { pools: [], swaps: [] };
    for (const line of logs || []) {
        if (!line.startsWith('Program data: ')) continue;
        const buf = Buffer.from(line.slice(14), 'base64');
        if (buf.length < 8) continue;
        const disc = buf.subarray(0, 8);
        try {
            if (disc.equals(CREATE_POOL_EVENT)) out.pools.push(decodeCreatePool(buf));
            else if (disc.equals(BUY_EVENT)) out.swaps.push(decodeSwap(buf, true));
            else if (disc.equals(SELL_EVENT)) out.swaps.push(decodeSwap(buf, false));
        } catch { /* truncated or foreign event; ignore */ }
    }
    return out;
}

// Pool account: discriminator, bump (u8), index (u16), creator, base mint, quote mint,
// LP mint, base vault, quote vault.
export function decodePool(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    const at = o => base58Encode(buf.subarray(o, o + 32));
    return { baseMint: at(43), quoteMint: at(75), baseVault: at(139), quoteVault: at(171) };
}
