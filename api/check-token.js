import { rpc, classifyOwner } from '../lib/solana.mjs';

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
