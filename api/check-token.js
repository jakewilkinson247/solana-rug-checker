// Uses Solana JSON-RPC directly (no API key needed). The old public
// api.solscan.io endpoints were shut down and now return 403/HTML.
// Set SOLANA_RPC_URL (e.g. a Helius/QuickNode URL) for higher rate limits.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

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

        const holders = accounts.map((a, i) => {
            const amount = parseFloat(a.uiAmountString);
            return {
                address: a.address,
                owner: owners.value[i]?.data?.parsed?.info?.owner || a.address,
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
