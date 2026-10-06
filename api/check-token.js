export default async function handler(req, res) {
    const { tokenAddress } = req.query;
    
    if (!tokenAddress) {
        return res.status(400).json({ error: 'Token address required' });
    }
    
    try {
        console.log(`[DEBUG] Fetching token: ${tokenAddress}`);
        
        const tokenUrl = `https://api.solscan.io/api/token/meta?tokenAddress=${tokenAddress}`;
        const holdersUrl = `https://api.solscan.io/api/token/holders?tokenAddress=${tokenAddress}&offset=0&limit=100`;
        
        console.log(`[DEBUG] Token URL: ${tokenUrl}`);
        console.log(`[DEBUG] Holders URL: ${holdersUrl}`);
        
        const [tokenResponse, holdersResponse] = await Promise.all([
            fetch(tokenUrl),
            fetch(holdersUrl)
        ]);
        
        console.log(`[DEBUG] Token response status: ${tokenResponse.status}`);
        console.log(`[DEBUG] Holders response status: ${holdersResponse.status}`);
        
        const tokenData = await tokenResponse.json();
        const holdersData = await holdersResponse.json();
        
        console.log(`[DEBUG] Token data:`, JSON.stringify(tokenData));
        console.log(`[DEBUG] Holders data:`, JSON.stringify(holdersData));
        
        if (!tokenData.success || !holdersData.success) {
            return res.status(400).json({ 
                error: 'Invalid token',
                tokenSuccess: tokenData.success,
                holdersSuccess: holdersData.success
            });
        }
        
        return res.status(200).json({ tokenData, holdersData });
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        console.error(`[ERROR] ${error.stack}`);
        return res.status(500).json({ 
            error: error.message,
            stack: error.stack
        });
    }
}
