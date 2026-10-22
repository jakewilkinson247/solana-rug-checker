// Rolling trade history for coins the bot isn't tracking yet, so an older coin that
// suddenly gets busy can be picked up along with the run that made it busy.

// Volume and distinct traders in the last `windowMin` minutes.
export function windowStats(trades, now, windowMin) {
    const since = now - windowMin * 60;
    let vol = 0;
    const traders = new Set();
    for (let i = trades.length - 1; i >= 0 && trades[i].time >= since; i--) {
        vol += trades[i].sol;
        traders.add(trades[i].user);
    }
    return { vol, traders: traders.size };
}

export class ActivityTracker {
    constructor({ lookbackMin, maxPerKey = 5000 }) {
        this.lookbackSec = lookbackMin * 60;
        this.maxPerKey = maxPerKey;
        this.byKey = new Map();
    }

    add(key, trade) {
        let list = this.byKey.get(key);
        if (!list) this.byKey.set(key, list = []);
        list.push(trade);
        if (list.length > this.maxPerKey) list.shift();
    }

    // Keys whose recent activity clears the thresholds, busiest first.
    hot(now, { windowMin, minVolSol, minTraders }) {
        const out = [];
        for (const [key, trades] of this.byKey) {
            const s = windowStats(trades, now, windowMin);
            if (s.vol >= minVolSol && s.traders >= minTraders) out.push({ key, ...s });
        }
        return out.sort((a, b) => b.vol - a.vol);
    }

    take(key) {
        const trades = this.byKey.get(key) || [];
        this.byKey.delete(key);
        return trades;
    }

    prune(now) {
        const cutoff = now - this.lookbackSec;
        for (const [key, trades] of this.byKey) {
            const keep = trades.findIndex(t => t.time >= cutoff);
            if (keep === -1) this.byKey.delete(key);
            else if (keep > 0) trades.splice(0, keep);
        }
    }

    get size() { return this.byKey.size; }
}
