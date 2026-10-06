export default async function handler(req, res) {
    const { tokenAddress } = req.query;

    if (!tokenAddress) {
        return res.status(400).json({ error: 'Token address required' });
    }

    try {
        const [tokenResponse, holdersResponse] = await Promise.all([
            fetch(`https://api.solscan.io/api/token/meta?tokenAddress=${tokenAddress}`),
            fetch(`https://api.solscan.io/api/token/holders?tokenAddress=${tokenAddress}&offset=0&limit=100`)
        ]);

        const tokenData = await tokenResponse.json();
        const holdersData = await holdersResponse.json();

        if (!tokenData.success || !holdersData.success) {
            return res.status(400).json({ error: 'Invalid token' });
        }

        return res.status(200).json({ tokenData, holdersData });
    } catch (error) {
        return res.status(500).json({ error: 'API error' });
    }
}
