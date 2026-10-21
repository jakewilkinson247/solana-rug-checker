// Rug/sniper filters for a fresh pump.fun launch. gatherMetrics() does the RPC
// work; evaluate() is a pure function so the rules are easy to test and tune.
import { rpc, isOnCurve } from '../lib/solana.mjs';
import { decodeBondingCurve, TOTAL_SUPPLY_RAW } from './pumpfun.js';
import { decodePool } from './pumpswap.js';

const pct = raw => Number(raw) / Number(TOTAL_SUPPLY_RAW) * 100;

async function inBatches(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    return out;
}

async function fetchJson(url, timeoutMs = 4000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// Where a wallet's first SOL came from, and when. Wallets with 1000+ txs are
// treated as established (not fresh) without paging further back.
export async function walletFunding(wallet) {
    const sigs = await rpc('getSignaturesForAddress', [wallet, { limit: 1000 }]);
    if (!sigs.length || sigs.length === 1000) return { wallet, funder: null, firstTime: null, established: sigs.length === 1000 };
    const first = sigs[sigs.length - 1];
    const tx = await rpc('getTransaction', [first.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const instructions = [
        ...(tx?.transaction?.message?.instructions || []),
        ...(tx?.meta?.innerInstructions || []).flatMap(i => i.instructions)
    ];
    const transfer = instructions.find(ix => ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info.destination === wallet);
    const feePayer = tx?.transaction?.message?.accountKeys?.[0]?.pubkey;
    const funder = transfer?.parsed.info.source || (feePayer !== wallet ? feePayer : null) || null;
    return { wallet, funder, firstTime: first.blockTime ?? null, established: false };
}

// Groups fresh wallets by funder. Returns the largest group and whether the dev
// shares a funder with (or directly funded) any holder.
export function findClusters(fundings, dev, launchTime, freshHours) {
    const fresh = fundings.filter(f => f.funder && !f.established && f.firstTime != null && launchTime - f.firstTime < freshHours * 3600);
    const groups = new Map();
    for (const f of fresh) groups.set(f.funder, [...(groups.get(f.funder) || []), f.wallet]);
    let largest = { funder: null, wallets: [] };
    for (const [funder, wallets] of groups) if (wallets.length > largest.wallets.length) largest = { funder, wallets };

    const devFunder = fundings.find(f => f.wallet === dev)?.funder;
    const holders = fundings.filter(f => f.wallet !== dev);
    const devLinked = holders.filter(f => f.funder && (f.funder === dev || f.funder === devFunder)).map(f => f.wallet);
    return { largest, devLinked };
}

// SOL backing the coin: the bonding curve's real reserves, or the PumpSwap pool's SOL vault.
async function liquidity(launch) {
    if (launch.pool) {
        const info = await rpc('getAccountInfo', [launch.pool, { encoding: 'base64' }]);
        if (!info?.value) return { found: false, realSol: 0 };
        const { quoteVault } = decodePool(info.value.data[0]);
        const balance = await rpc('getTokenAccountBalance', [quoteVault]);
        return { found: true, realSol: Number(balance.value.uiAmountString) };
    }
    const info = await rpc('getAccountInfo', [launch.bondingCurve, { encoding: 'base64' }]);
    if (!info?.value) return { found: false, realSol: 0 };
    const curve = decodeBondingCurve(info.value.data[0]);
    return { found: true, curve, realSol: Number(curve.realSolReserves) / 1e9 };
}

export async function gatherMetrics(launch, f) {
    const [liq, largest, sigs, devAccounts] = await Promise.all([
        liquidity(launch),
        rpc('getTokenLargestAccounts', [launch.mint]),
        rpc('getSignaturesForAddress', [launch.mint, { limit: 1000 }]),
        rpc('getTokenAccountsByOwner', [launch.user, { mint: launch.mint }, { encoding: 'jsonParsed' }])
    ]);

    // Resolve token accounts to owner wallets and drop the curve's and pool's own accounts.
    const liquidityOwners = new Set([launch.bondingCurve, launch.pool].filter(Boolean));
    const accounts = largest.value || [];
    const owners = accounts.length
        ? await rpc('getMultipleAccounts', [accounts.map(a => a.address), { encoding: 'jsonParsed' }])
        : { value: [] };
    const holders = accounts
        .map((a, i) => ({ owner: owners.value[i]?.data?.parsed?.info?.owner || a.address, pct: pct(BigInt(a.amount)) }))
        .filter(h => !liquidityOwners.has(h.owner) && h.pct > 0);

    // Other transactions that landed in the creation slot or the next one: snipers / bundles.
    const oldest = sigs[sigs.length - 1];
    const earlyBuys = sigs.length === 1000 && oldest.slot > launch.slot + 1
        ? null // too much activity to see back to launch
        : sigs.filter(s => !s.err && s.signature !== launch.signature && s.slot <= launch.slot + 1).length;

    const devHeldRaw = devAccounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);

    let socials = null;
    if (f.requireSocials) {
        try {
            const meta = await fetchJson(launch.uri);
            socials = Boolean(meta.twitter || meta.telegram || meta.website);
        } catch { socials = false; }
    }

    let clusters = null;
    if (f.clusterCheck) {
        const wallets = [...new Set([launch.user, ...holders.map(h => h.owner).filter(isOnCurve).slice(0, f.clusterHolders)])];
        const fundings = await inBatches(wallets, 3, w => walletFunding(w).catch(() => ({ wallet: w, funder: null })));
        clusters = findClusters(fundings, launch.user, launch.timestamp, f.freshWalletHours);
    }

    return {
        venue: launch.pool ? 'pumpswap' : 'curve',
        liquidityFound: liq.found,
        curve: liq.curve || null,
        realSol: liq.realSol,
        devBuyPct: pct(launch.devBuyRaw),
        devHeldPct: pct(devHeldRaw),
        devSold: launch.devBuyRaw > 0n && devHeldRaw * 2n < launch.devBuyRaw,
        earlyBuys,
        topHolderPct: holders[0]?.pct ?? 0,
        top10Pct: holders.slice(0, 10).reduce((s, h) => s + h.pct, 0),
        socials,
        clusters
    };
}

// Cheap checks on the trades already seen in the log stream, run before any RPC calls so
// dead or spam launches don't use up RPC credits. sameName counts launches with this
// symbol in the copycat window (including this one).
export function prefilter(trades, launch, sameName, f) {
    const reasons = [];
    const buys = trades.filter(t => t.isBuy && t.user !== launch.user);
    const buyers = new Set(buys.map(t => t.user)).size;
    const buySol = buys.reduce((s, t) => s + t.sol, 0);
    if (buyers < f.minBuyers) reasons.push(`only ${buyers} buyer(s) besides the dev (min ${f.minBuyers})`);
    if (buySol < f.minBuySol) reasons.push(`only ${buySol.toFixed(2)} SOL bought (min ${f.minBuySol})`);
    if (sameName > f.maxSameName) reasons.push(`${sameName} launches named "${launch.symbol}" in ${f.copycatMinutes} min (spam/copycat)`);
    return { pass: reasons.length === 0, reasons };
}

export function evaluate(m, f) {
    const reasons = [];
    if (!m.liquidityFound) reasons.push(m.venue === 'pumpswap' ? 'PumpSwap pool not found' : 'bonding curve not found');
    else if (m.curve?.complete) reasons.push('curve complete but its PumpSwap pool has not been seen');
    if (m.devBuyPct > f.maxDevBuyPct) reasons.push(`dev bought ${m.devBuyPct.toFixed(1)}% at launch (max ${f.maxDevBuyPct}%)`);
    if (f.rejectIfDevSold && m.devSold) reasons.push('dev has already sold most of their bag');
    if (m.earlyBuys !== null && m.earlyBuys > f.maxEarlyBuys) reasons.push(`${m.earlyBuys} buys in the launch slot (max ${f.maxEarlyBuys})`);
    if (m.topHolderPct > f.maxTopHolderPct) reasons.push(`top holder has ${m.topHolderPct.toFixed(1)}% (max ${f.maxTopHolderPct}%)`);
    if (m.top10Pct > f.maxTop10Pct) reasons.push(`top 10 hold ${m.top10Pct.toFixed(1)}% (max ${f.maxTop10Pct}%)`);
    if (m.realSol < f.minRealSol) reasons.push(`only ${m.realSol.toFixed(2)} SOL in the curve (min ${f.minRealSol})`);
    if (f.requireSocials && !m.socials) reasons.push('no twitter/telegram/website in metadata');
    if (m.clusters) {
        const { largest, devLinked } = m.clusters;
        if (largest.wallets.length > f.maxSharedFunder) reasons.push(`${largest.wallets.length} fresh holders funded by ${largest.funder}`);
        if (devLinked.length) reasons.push(`${devLinked.length} holder(s) share funding with the dev`);
    }
    return { pass: reasons.length === 0, reasons };
}
