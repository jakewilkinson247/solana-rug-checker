// Simulated positions: buys at the live curve price when a coin passes the
// filters, then exits on take-profit, stop-loss, timeout or graduation.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rpc } from '../lib/solana.mjs';
import { decodeBondingCurve, quoteBuy, quoteSell } from './pumpfun.js';

export class PaperTrader {
    constructor(cfg, logDir) {
        this.cfg = cfg;
        this.positions = new Map();
        this.closed = [];
        mkdirSync(logDir, { recursive: true });
        this.logFile = join(logDir, 'trades.jsonl');
        this.timer = setInterval(() => this.poll().catch(e => console.error(`[paper] poll failed: ${e.message}`)), cfg.pollMs);
    }

    get full() { return this.positions.size >= this.cfg.maxOpen; }

    log(entry) { appendFileSync(this.logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }

    open(launch, curve) {
        const tokens = quoteBuy(curve, this.cfg.buySol, this.cfg.feeBps);
        if (tokens <= 0n) return;
        const pos = { mint: launch.mint, symbol: launch.symbol, bondingCurve: launch.bondingCurve, tokens, costSol: this.cfg.buySol, openedAt: Date.now() };
        this.positions.set(launch.mint, pos);
        this.log({ event: 'open', mint: pos.mint, symbol: pos.symbol, costSol: pos.costSol, tokens: pos.tokens.toString() });
        console.log(`[paper] BUY ${pos.symbol} ${pos.mint} for ${pos.costSol} SOL`);
    }

    async poll() {
        if (!this.positions.size) return;
        const list = [...this.positions.values()];
        const infos = await rpc('getMultipleAccounts', [list.map(p => p.bondingCurve), { encoding: 'base64' }]);
        list.forEach((pos, i) => {
            const data = infos.value[i]?.data?.[0];
            if (!data) return;
            const curve = decodeBondingCurve(data);
            // A graduated curve can't be sold into here; value the bag at the last curve price.
            const value = quoteSell(curve, pos.tokens, this.cfg.feeBps);
            const pnlPct = (value / pos.costSol - 1) * 100;
            let reason = null;
            if (curve.complete) reason = 'graduated';
            else if (pnlPct >= this.cfg.takeProfitPct) reason = 'take-profit';
            else if (pnlPct <= -this.cfg.stopLossPct) reason = 'stop-loss';
            else if (Date.now() - pos.openedAt >= this.cfg.maxHoldMs) reason = 'timeout';
            if (reason) this.close(pos, value, reason);
        });
    }

    close(pos, valueSol, reason) {
        this.positions.delete(pos.mint);
        const pnlSol = valueSol - pos.costSol;
        this.closed.push(pnlSol);
        this.log({ event: 'close', mint: pos.mint, symbol: pos.symbol, reason, valueSol, pnlSol, heldSec: Math.round((Date.now() - pos.openedAt) / 1000) });
        console.log(`[paper] SELL ${pos.symbol} (${reason}) ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`);
    }

    summary() {
        const wins = this.closed.filter(p => p > 0).length;
        const total = this.closed.reduce((s, p) => s + p, 0);
        return `${this.closed.length} closed (${wins} wins), ${this.positions.size} open, net ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`;
    }

    stop() { clearInterval(this.timer); }
}
