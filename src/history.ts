// ---------------------------------------------------------------------------
// HISTORY ROLLUPS (SOL book only — memes/CYB excluded by design)
//
// Long-memory daily statistics for the dashboard History tab. The live trade
// ledger only holds ~5000 fills and the equity ring ~7 days, so year-scale
// views need a compact on-disk rollup: ONE JSON row per UTC day, appended
// forever. A year of rows is a few KB.
//
// Design rules:
//  - Measurement only. Nothing here feeds trading decisions.
//  - Deposits/withdrawals are external transfers, not trading profit. The bot
//    cannot detect them directly, but equity deltas that have no matching
//    realized PnL and no open-position change are almost always transfers.
//    Rather than guess, we persist raw components (equityEod, realized, fees,
//    fills, roundTrips) and let the UI compute profit honestly from realized
//    minus fees. Equity deltas across a deposit simply show in the equity line.
//  - Rows are recomputed for "today" from the live ledger each call and merged
//    into the file, so intraday updates stay current; past days are immutable.
//  - Crash-safe: the file is written atomically (tmp+rename) and any read/write
//    failure degrades to empty stats, never throws into the trading loop.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Trade } from './types.js';

const STATE_DIR = join(process.cwd(), '.botstate');
const HISTORY_FILE = join(STATE_DIR, 'history-sol.json');

/** One UTC day of SOL-book trading, aggregated from real fills. */
export interface DayRollup {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  /** Sum of SELL realizedPnlUsd for grid+dca fills (gross banked PnL). */
  realizedUsd: number;
  /** Sum of feeUsd for grid+dca fills (real network fees). */
  feesUsd: number;
  /** realized − fees. */
  netUsd: number;
  /** Total fills (buys+sells) across grid+dca. */
  fills: number;
  /** Completed round-trips: sells whose realizedPnl closed a basis, counted per sell with realizedPnlUsd defined. */
  roundTrips: number;
  /** Average winning sell (USD) in the day. */
  avgWinUsd: number;
  /** Average losing sell (USD, negative) in the day. */
  avgLossUsd: number;
  /** wins / total sells. */
  winRate: number;
  /** Total SELL fills with a realized outcome this day. */
  sells: number;
  /** Winning sells this day. */
  wins: number;
  /** Gross winning USD this day. */
  sumWins: number;
  /** Gross losing USD (negative) this day. */
  sumLosses: number;
  /** Σwins / |Σlosses| for the day; null when no losing sells (displayed as ∞). */
  profitFactor: number | null;
  /** Last equity sample of the day (USDC + SOL*price at day end). */
  equityEod: number | null;
  /** Last price of the day. */
  priceEod: number | null;
  /** First equity sample of the day (for the UI's day-over-day equity delta). */
  equityBod: number | null;
}

interface HistoryFile {
  version: 1;
  /** Keyed by UTC day string. Today's row is recomputed/merged live. */
  days: Record<string, DayRollup>;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyRow(day: string): DayRollup {
  return {
    day, realizedUsd: 0, feesUsd: 0, netUsd: 0, fills: 0, roundTrips: 0,
    avgWinUsd: 0, avgLossUsd: 0, winRate: 0, sells: 0, wins: 0, sumWins: 0, sumLosses: 0,
    profitFactor: null,
    equityEod: null, priceEod: null, equityBod: null,
  };
}

/** Aggregate a set of SOL-book trades (grid+dca only) into one day row. */
export function rollupDay(day: string, trades: Trade[]): DayRollup {
  const row = emptyRow(day);
  let wins = 0, losses = 0, sumWins = 0, sumLosses = 0, sells = 0;
  for (const t of trades) {
    // SOL book only: grid + dca. Meme/CYB fills are excluded here by design.
    if (t.strategyId !== 'grid' && t.strategyId !== 'dca') continue;
    if (utcDay(t.ts) !== day) continue;
    row.fills++;
    row.feesUsd += t.feeUsd || 0;
    if (t.direction === 'SELL') {
      sells++;
      const pnl = t.realizedPnlUsd ?? 0;
      row.realizedUsd += pnl;
      if (t.realizedPnlUsd !== undefined) row.roundTrips++;
      if (pnl > 0) { wins++; sumWins += pnl; }
      else if (pnl < 0) { losses++; sumLosses += pnl; }
    }
  }
  row.netUsd = row.realizedUsd - row.feesUsd;
  row.avgWinUsd = wins ? sumWins / wins : 0;
  row.avgLossUsd = losses ? sumLosses / losses : 0;
  row.sells = sells;
  row.wins = wins;
  row.sumWins = sumWins;
  row.sumLosses = sumLosses;
  row.winRate = sells ? wins / sells : 0;
  row.profitFactor = sumLosses < 0 ? sumWins / Math.abs(sumLosses) : (sumWins > 0 ? null : 0);
  return row;
}

/**
 * Daily history store: reads/merges/writes .botstate/history-sol.json.
 * Pass today's ledger + equity tail; returns all rows sorted by day.
 */
export class HistoryStore {
  private days: Record<string, DayRollup> = {};

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const raw = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) as HistoryFile;
        if (raw && raw.version === 1 && typeof raw.days === 'object') {
          this.days = raw.days;
        }
      }
    } catch {
      this.days = {}; // corrupt file -> start over; never crash trading
    }
  }

  private save(): void {
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      const payload: HistoryFile = { version: 1, days: this.days };
      const tmp = HISTORY_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, HISTORY_FILE); // atomic on POSIX
    } catch (e) {
      console.warn(`[history] write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Recompute today's row from the live ledger, merge equity endpoints from
   * the sampled curve, persist, and return every day sorted ascending.
   */
  update(
    trades: Trade[],
    equityHistory: { ts: number; equityUsd: number }[],
    lastPrice: number
  ): DayRollup[] {
    const today = utcDay(Date.now());
    const row = rollupDay(today, trades);
    // Equity endpoints from the 7-day ring when available (today's row only).
    const samples = equityHistory.filter((p) => utcDay(p.ts) === today);
    if (samples.length) {
      row.equityBod = samples[0].equityUsd;
      row.equityEod = samples[samples.length - 1].equityUsd;
      row.priceEod = lastPrice > 0 ? lastPrice : row.priceEod;
    }
    this.days[today] = row;
    this.save();
    return this.rows();
  }

  /** All stored rows, ascending by day. */
  rows(): DayRollup[] {
    return Object.values(this.days).sort((a, b) => a.day.localeCompare(b.day));
  }
}
