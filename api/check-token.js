// Uses Solana JSON-RPC directly (no API key needed). The old public
// api.solscan.io endpoints were shut down and now return 403/HTML.
// Set SOLANA_RPC_URL (e.g. a Helius/QuickNode URL) for higher rate limits.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Programs whose accounts hold liquidity-pool or launchpad tokens.
const KNOWN_PROGRAMS = {
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium pool',
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium pool',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium pool',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca pool',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora pool',
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora pool',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun bonding curve',
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap pool'
};
// Pool authorities that hold vaults directly (no account data to inspect).
const KNOWN_ADDRESSES = {
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium pool'
};

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
    let n = 0n;
    for (const c of str) n = n * 58n + BigInt(BASE58.indexOf(c));
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const c of str) { if (c !== '1') break; bytes.unshift(0); }
    return bytes;
}

// ed25519 field math, used to tell real wallets (on-curve keys) from
// program-derived addresses (off-curve), which only a program can control.
const P = 2n ** 255n - 19n;
function modPow(b, e) {
    let r = 1n; b %= P;
    while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; }
    return r;
}
const D = (P - 121665n) * modPow(121666n, P - 2n) % P;

function isOnCurve(address) {
    const bytes = base58Decode(address);
    if (bytes.length !== 32) return false;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
    y &= (1n << 255n) - 1n;
    if (y >= P) return false;
    const y2 = y * y % P;
    const x2 = (y2 - 1n + P) % P * modPow((D * y2 + 1n) % P, P - 2n) % P;
    return x2 === 0n || modPow(x2, (P - 1n) / 2n) === 1n;
}

function classifyOwner(owner, ownerAccount) {
    if (KNOWN_ADDRESSES[owner]) return KNOWN_ADDRESSES[owner];
    if (ownerAccount && KNOWN_PROGRAMS[ownerAccount.owner]) return KNOWN_PROGRAMS[ownerAccount.owner];
    if (!isOnCurve(owner)) return 'Program-owned (pool/contract)';
    return null;
}

async function rpc(method, params, attempt = 0) {
    const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    // The public RPC rate-limits heavily (especially getTokenLargestAccounts); back off and retry.
    if (response.status === 429 && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        return rpc(method, params, attempt + 1);
    }
    if (response.status === 429) {
        throw new Error('Solana RPC is rate-limiting requests. Try again shortly, or set SOLANA_RPC_URL to a dedicated RPC (e.g. Helius free tier).');
    }
    if (!response.ok) {
        throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.error) {
        throw new Error(`RPC ${method}: ${data.error.message}`);
    }
    return data.result;
}

export default async function handler(req, res) {
    const { tokenAddress } = req.query;

    if (!tokenAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) {
        return res.status(400).json({ error: 'Valid token mint address required' });
    }

    try {
        const [mintInfo, supplyInfo] = await Promise.all([
            rpc('getAccountInfo', [tokenAddress, { encoding: 'jsonParsed' }]),
            rpc('getTokenSupply', [tokenAddress])
        ]);
        // Run separately: it is the most rate-limited call, so don't burst it alongside the others.
        const largest = await rpc('getTokenLargestAccounts', [tokenAddress]);

        const parsed = mintInfo?.value?.data?.parsed;
        if (!parsed || parsed.type !== 'mint') {
            return res.status(404).json({ error: 'Address is not a token mint' });
        }

        const supply = parseFloat(supplyInfo.value.uiAmountString);
        const accounts = largest.value || [];

        // Largest accounts are token accounts; resolve them to owner wallets.
        const owners = accounts.length
            ? await rpc('getMultipleAccounts', [accounts.map(a => a.address), { encoding: 'jsonParsed' }])
            : { value: [] };

        const ownerAddresses = accounts.map((a, i) => owners.value[i]?.data?.parsed?.info?.owner || a.address);

        // Look up each owner to see which program (if any) controls it.
        const ownerAccounts = ownerAddresses.length
            ? await rpc('getMultipleAccounts', [ownerAddresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])
            : { value: [] };

        const holders = accounts.map((a, i) => {
            const amount = parseFloat(a.uiAmountString);
            const owner = ownerAddresses[i];
            return {
                address: a.address,
                owner,
                label: classifyOwner(owner, ownerAccounts.value[i]),
                amount,
                percentage: supply > 0 ? (amount / supply) * 100 : 0
            };
        });

        return res.status(200).json({
            supply,
            decimals: parsed.info.decimals,
            mintAuthority: parsed.info.mintAuthority || null,
            freezeAuthority: parsed.info.freezeAuthority || null,
            holders
        });
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        return res.status(502).json({ error: error.message });
    }
}
