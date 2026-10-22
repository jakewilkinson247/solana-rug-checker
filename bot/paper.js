// Simulated positions: buys when a coin gives an entry signal, then exits on
// take-profit, stop-loss or timeout. Prices come from the live trade stream
// (bonding curve or PumpSwap), so a coin that graduates keeps being tracked.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { quoteBuy, TOKEN_DECIMALS } from './pumpfun.js';

export class PaperTrader {
    constructor(cfg, logDir, { onClose = () => {} } = {}) {
        this.cfg = cfg;
        this.onClose = onClose;
        this.positions = new Map();
        this.closed = [];
        mkdirSync(logDir, { recursive: true });
        this.logFile = join(logDir, 'trades.jsonl');
        this.timer = setInterval(() => this.checkExits(), cfg.pollMs);
    }

    get full() { return this.positions.size >= this.cfg.maxOpen; }

    log(entry) { appendFileSync(this.logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }

    // On the bonding curve the fill includes price impact; on PumpSwap (deep enough
    // for a small size) it is the last trade price less the fee.
    open(launch, { curve, price, venue }) {
        let tokens;
        if (curve && !curve.complete) tokens = Number(quoteBuy(curve, this.cfg.buySol, this.cfg.feeBps)) / 10 ** TOKEN_DECIMALS;
        else if (price > 0) tokens = this.cfg.buySol * (1 - this.cfg.feeBps / 10_000) / price;
        if (!tokens) return;
        const pos = { mint: launch.mint, symbol: launch.symbol, venue, tokens, costSol: this.cfg.buySol, lastPrice: price, openedAt: Date.now() };
        this.positions.set(launch.mint, pos);
        this.log({ event: 'open', mint: pos.mint, symbol: pos.symbol, venue, costSol: pos.costSol, tokens, price });
        console.log(`[paper] BUY ${pos.symbol} ${pos.mint} on ${venue} for ${pos.costSol} SOL`);
    }

    onPrice(mint, price, venue) {
        const pos = this.positions.get(mint);
        if (!pos) return;
        pos.lastPrice = price;
        pos.venue = venue;
    }

    value(pos) { return pos.tokens * (pos.lastPrice || 0) * (1 - this.cfg.feeBps / 10_000); }

    checkExits() {
        for (const pos of [...this.positions.values()]) {
            const value = this.value(pos);
            const pnlPct = (value / pos.costSol - 1) * 100;
            let reason = null;
            if (pos.lastPrice && pnlPct >= this.cfg.takeProfitPct) reason = 'take-profit';
            else if (pos.lastPrice && pnlPct <= -this.cfg.stopLossPct) reason = 'stop-loss';
            else if (Date.now() - pos.openedAt >= this.cfg.maxHoldMs) reason = 'timeout';
            if (reason) this.close(pos, value, reason);
        }
    }

    close(pos, valueSol, reason) {
        this.positions.delete(pos.mint);
        const pnlSol = valueSol - pos.costSol;
        this.closed.push(pnlSol);
        this.log({ event: 'close', mint: pos.mint, symbol: pos.symbol, venue: pos.venue, reason, valueSol, pnlSol, heldSec: Math.round((Date.now() - pos.openedAt) / 1000) });
        console.log(`[paper] SELL ${pos.symbol} (${reason}) ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`);
        this.onClose({ ...pos, reason, valueSol, pnlSol });
    }

    summary() {
        const wins = this.closed.filter(p => p > 0).length;
        const total = this.closed.reduce((s, p) => s + p, 0);
        return `${this.closed.length} closed (${wins} wins), ${this.positions.size} open, net ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`;
    }

    stop() { clearInterval(this.timer); }
}
