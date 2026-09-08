import { EventEmitter } from 'node:events';
import type { AppConfig } from './config.js';
import type { Candle } from './types.js';
import { JupiterExec } from './jupiter.js';

export interface PriceGateInput {
  p: number;             // candidate price from the source
  prev: number;          // last committed price (0 if none yet)
  maxSingleJumpPct: number;
  historyHigh?: number;  // max(existing history.high)
  historyLow?: number;   // min(existing history.low)
}

/**
 * Decide whether a freshly-fetched price is sane enough to commit to the
 * stream. Guards against a single bad/glitched quote (e.g.the ~$5.97 print on
 * a ~$107 SOL) that would otherwise trigger real grid crossed-fills + a DCA
 * trailing sell at a fabricated price.
 *
 * Returns true when the price should be ACCEPTED.
 */
export function pricePassesGate({
  p, prev, maxSingleJumpPct, historyHigh, historyLow,
}: PriceGateInput): boolean {
  if (!(p > 0)) return false;
  if (prev > 0 && Math.abs(p - prev) / prev > maxSingleJumpPct) return false;
  if (historyHigh !== undefined && historyLow !== undefined && historyLow > 0 && historyHigh > 0) {
    const cushion = (historyHigh - historyLow) * 0.5;
    if (p < historyLow - cushion || p > historyHigh + cushion) return false;
  }
  return true;
}

/**
 * Price oracle for SOL/USDC.
 *
 * PRIMARY source: Jupiter on-chain quote (same venue the bot executes swaps
 * on). This means the displayed price, the DCA/grid trigger signals, and the
 * actual expected fill price all come from the same on-chain route — no
 * divergence between what we see and what we trade.
 *
 * FALLBACK: CoinGecko USD price if the Jupiter fetch fails (keeps VWAP/price
 * flowing during a transient quote API blip, with a clear log.)
 *
 * HISTORY: seeded from GeckoTerminal's on-chain DEX OHLCV (SOL/USDC pool), so
 * the grid band sizes itself from REAL recent price action ($68–100 range, not
 * static numbers) and keeps refreshing through the day.
 */
export class PriceOracle extends EventEmitter {
  private price = 0;
  private candles: Candle[] = []; // live, minute-grain (from quote polling)
  private history: Candle[] = []; // on-chain DEX candles (GeckoTerminal OHLCV)
  private timer?: ReturnType<typeof setInterval>;
  private historyTimer?: ReturnType<typeof setInterval>;
  private jup: JupiterExec;
  /** True when the last poll actually produced a fresh price (not a retained/stale one). */
  private fresh = false;
  /** True when the last poll's PRIMARY source — Jupiter, the real execution
   *  venue — succeeded. A working CoinGecko fallback can keep `fresh` true even
   *  while Jupiter is down; the live circuit-breaker uses THIS so it trips when
   *  the venue we actually trade on goes stale, even if a fallback price exists. */
  private _jupiterFresh = false;
  // Fixed notional quote (in SOL) used to compute the near-mid on-chain price.
  // Small enough to keep price impact negligible, large enough to be a real route.
  private readonly oracleAmountSol = 1;

  constructor(private cfg: AppConfig) {
    super();
    this.jup = new JupiterExec(cfg);
  }

  get current(): number {
    return this.price;
  }

  /** True if the most recent fetch refreshed the price successfully. */
  get currentGeneratingFresh(): boolean {
    return this.fresh;
  }

  /** True if the most recent poll refreshed the PRIMARY execution venue (Jupiter). */
  get jupiterFresh(): boolean {
    return this._jupiterFresh;
  }

  /**
   * TEST ONLY: force a deterministic price without hitting a network (used by
   * unit tests to drive fill logic). Not part of the runtime path.
   */
  __setPrice(p: number, jupiterFresh: boolean = true): void {
    this.price = p;
    this.fresh = true;
    this._jupiterFresh = jupiterFresh;
    this.pushCandle(p);
  }

  /**
   * The price ~24 hours ago: the OPEN of the oldest candle still inside the
   * 24h window. Returns 0 when the bot hasn't been running long enough to
   * have 24h of samples (dashboard then shows '—' rather than a lie).
   */
  price24hAgo(): number {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const src = this.history.length ? this.history : this.candles;
    if (src.length === 0) return 0;
    // Only honest as a "24h ago" read when the series actually starts at or
    // before the 24h edge; the 30min slack tolerates the last refresh landing
    // slightly inside the window.
    if (src[0].ts > cutoff + 30 * 60_000) return 0;
    const inWindow = src.find((c) => c.ts >= cutoff);
    if (!inWindow) return 0;
    return inWindow.open > 0 ? inWindow.open : inWindow.close;
  }

  /**
   * Highest price seen over the last `minutes` of on-chain DEX history.
   * Falls back to live candles, then a cushion around the current price.
   */
  recentHigh(minutes = 1440): number {
    const from = Date.now() - minutes * 60_000;
    const recent = this.history.filter((c) => c.ts >= from);
    if (recent.length > 0) return Math.max(...recent.map((c) => c.high));
    const live = this.candles.slice(-Math.max(2, Math.ceil(minutes / 5)));
    if (live.length > 0) return Math.max(...live.map((c) => c.high));
    return this.price * 1.05;
  }

  /** Lowest price seen over the last `minutes` of on-chain DEX history. */
  recentLow(minutes = 1440): number {
    const from = Date.now() - minutes * 60_000;
    const recent = this.history.filter((c) => c.ts >= from);
    if (recent.length > 0) return Math.min(...recent.map((c) => c.low));
    const live = this.candles.slice(-Math.max(2, Math.ceil(minutes / 5)));
    if (live.length > 0) return Math.min(...live.map((c) => c.low));
    return this.price * 0.95;
  }

  /**
   * Rolling VWAP over recent closes. PREFERS the real on-chain GeckoTerminal
   * candles, which carry genuine volumeUsd from the pool (OHLCV row index 5).
   * Only if history is empty (no synthetic volume is ever invented) we fall
   * back to the unweighted mean of live polled closes so VWAP still has a
   * directional baseline without fabricating a number.
   */
  get vwap(): number {
    if (this.history.length > 0) {
      const n = Math.min(this.history.length, 60);
      const recent = this.history.slice(-n);
      const vol = recent.reduce((s, c) => s + c.volumeUsd, 0);
      if (vol > 0) {
        const sum = recent.reduce((s, c) => s + c.volumeUsd * c.close, 0);
        return sum / vol;
      }
    }
    if (this.candles.length === 0) return this.price;
    const n = Math.min(this.candles.length, 60);
    const recent = this.candles.slice(-n);
    return recent.reduce((s, c) => s + c.close, 0) / recent.length;
  }

  /**
   * Directional move over the last `candlesN` candles, as a fraction
   * (e.g. 0.05 = +5%). Used by the trend/regime filter to avoid arming
   * against strong momentum.
   */
  recentTrend(candlesN = 12): number {
    const n = Math.min(candlesN, this.candles.length);
    if (n < 2) return 0;
    const win = this.candles.slice(-n);
    const first = win[0].open;
    const last = win[win.length - 1].close;
    if (first <= 0) return 0;
    return (last - first) / first;
  }

  /**
   * VWAP slope: directional move of VWAP over the recent history, as a fraction
   * (e.g. -0.03 = VWAP drifting down 3% over the window). This is the regime
   * signal the grid uses to avoid arming asks into a sliding range (Feature 6).
   */
  vwapSlope(candlesN = 12): number {
    const src = this.history.length ? this.history : this.candles;
    const n = Math.min(candlesN, src.length);
    if (n < 2) return 0;
    const win = src.slice(-n);
    const first = win[0].close;
    const last = win[win.length - 1].close;
    if (first <= 0) return 0;
    return (last - first) / first;
  }

  /**
   * Recent realized volatility as a fraction of price (coefficient of
   * variation of closes over the last `candlesN` candles). Drives the
   * volatility-adaptive band: wider when choppy, tighter when calm.
   */
  recentVolatility(candlesN = 12): number {
    const n = Math.min(candlesN, this.candles.length);
    if (n < 2) return 0;
    const closes = this.candles.slice(-n).map((c) => c.close);
    const mean = closes.reduce((s, c) => s + c, 0) / closes.length;
    if (mean <= 0) return 0;
    const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / closes.length;
    return Math.sqrt(variance) / mean;
  }

  start(): void {
    void this.fetchNow();
    void this.refreshHistory();
    this.timer = setInterval(() => void this.fetchNow(), this.cfg.pollIntervalMs);
    this.timer.unref?.();
    // Refresh on-chain history every 30 min so the band tracks the day's action.
    this.historyTimer = setInterval(() => void this.refreshHistory(), 30 * 60_000);
    this.historyTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
  }

  /**
   * Seed the historical band from GeckoTerminal's on-chain SOL/USDC DEX OHLCV.
   * Free + keyless; returns real daily candles. Uses a large known SOL/USDC
   * pool by default (overridable via GEOKT_POOL).
   */
  async refreshHistory(): Promise<void> {
    const pool = process.env.GEOKT_POOL || '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
    try {
      // Daily candles for the longer-term range (covers $68–100), 24h-hourly for
      // finer recent detail. Merge, sort ascending, dedupe by bucket.
      const day = await this.fetchOhlcv(pool, 'day', 1, 30);
      const hour = await this.fetchOhlcv(pool, 'hour', 1, 48);
      const merged = new Map<number, Candle>();
      for (const c of [...day, ...hour]) merged.set(c.ts, c);
      const arr = [...merged.values()].sort((a, b) => a.ts - b.ts);
      if (arr.length > 0) {
        this.history = arr;
        this.emit('history', arr.length);
      }
    } catch (e) {
      this.emit('warn', `[price] geckoterminal history failed (${(e as Error).message})`);
    }
  }

  private async fetchOhlcv(pool: string, timeframe: 'day' | 'hour', aggregate: number, limit: number): Promise<Candle[]> {
    const url =
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${limit}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    // NOTE: GeckoTerminal OHLCV endpoints currently 404 without a paid key, so
    // this fetch typically fails and the caller falls back gracefully — we never
    // fabricate candles. We do not carry a Gecko key here (meme history uses
    // BirdEye).
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
    if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    };
    const list = json?.data?.attributes?.ohlcv_list ?? [];
    // OHLCV row: [ts, open, high, low, close, volume]
    return list.map((r) => ({
      ts: r[0] * 1000,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volumeUsd: r[5] ?? 0,
    }));
  }

  /**
   * Fetch and update the current on-chain price. Returns the latest price.
   * Order of preference:
   *   1. Jupiter on-chain SOL->USDC quote  (primary, matches execution venue)
   *   2. CoinGecko USD                    (fallback)
   */
  async fetchNow(): Promise<number> {
    const g = this.cfg.strategies.grid;
    let p = 0;
    let source = 'jupiter';

    try {
      const q = await this.jup.quote(
        g.baseMint,
        g.quoteMint,
        this.oracleAmountSol,
        'BUY'
      );
      // q.inAmount is SOL, q.outAmount is USDC -> price = USDC per SOL
      if (q.inAmount > 0) {
        p = q.outAmount / q.inAmount;
        // PRIMARY execution venue refreshed successfully.
        this._jupiterFresh = true;
      }
    } catch (e) {
      // Jupiter (the venue we actually trade on) is down/erroring. Mark the
      // execution venue as NOT fresh even though we may fall back to CoinGecko
      // for a displayed price — the live circuit-breaker keys off this.
      this._jupiterFresh = false;
      this.emit('warn', `[price] on-chain jupiter quote failed (${(e as Error).message}); trying CoinGecko fallback …`);
    }

    // Fallback to CoinGecko if Jupiter gave us nothing usable.
    if (!(p > 0)) {
      source = 'coingecko';
      try {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          { signal: AbortSignal.timeout(15000) }
        );
        if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
        const json = (await res.json()) as { solana?: { usd?: number } };
        p = json?.solana?.usd ?? 0;
      } catch (e) {
        this.fresh = false;
        this.emit('error', e);
        return this.price; // keep last known price
      }
    }

    if (p > 0) {
      // ----- SANITY GATE (protects every downstream strategy from a single
      // bad/glitched quote). The ~$5.97 print on a ~$107 SOL triggered real
      // grid crossed-fills + a DCA trailing sell at a fabricated price. Two
      // independent guards decide whether to commit this value:
      //   1) SINGLE-JUMP: >maxSingleJumpPct away from the last committed price
      //      in ONE poll is nearly always an anomaly. Reject.
      //   2) HISTORY CROSS-REF: way outside the traded 24h range is bogus. If
      //      we have real on-chain history, reject a print far outside it.
      // A genuine sharp move passes (it's within the last-committed gate and
      // re-confirms across subsequent polls) while a one-off flash is dropped
      // and the stream keeps the previous clean price.
      const prev = this.price;
      let hi: number | undefined;
      let lo: number | undefined;
      if (this.history.length > 0) {
        hi = Math.max(...this.history.map((c) => c.high));
        lo = Math.min(...this.history.map((c) => c.low));
      }
      const accepted = pricePassesGate({
        p, prev, maxSingleJumpPct: this.cfg.risk.maxSingleJumpPct,
        historyHigh: hi, historyLow: lo,
      });
      if (!accepted) {
        this.fresh = false;
        console.warn(
          `[price] rejected suspicious print ${p.toFixed(2)} from ${source} ` +
            `(last ${prev > 0 ? prev.toFixed(2) : 'n/a'}, jump ${prev > 0 ? ((p - prev) / prev * 100).toFixed(1) : 'n/a'}% > max ${(this.cfg.risk.maxSingleJumpPct * 100).toFixed(0)}%). Keeping prior price.`
        );
        this.emit('warn', `[price] rejected suspicious ${source} price ${p.toFixed(2)} (kept ${this.price.toFixed(2)})`);
        return this.price;
      }

      this.price = p;
      this.fresh = true;
      this.pushCandle(p);
      if (prev !== p) {
        this.emit('price', p, source);
      }
    } else {
      this.fresh = false;
      this.emit('warn', `[price] no on-chain source produced a price (last known: ${this.price}); using retained price.`);
    }
    return this.price;
  }

  private pushCandle(p: number): void {
    const minute = Math.floor(Date.now() / 60000);
    const last = this.candles[this.candles.length - 1];
    // Live polled candles carry NO synthetic volume — real volume lives in the
    // on-chain GeckoTerminal history (used for VWAP). volumeUsd stays 0 here.
    if (last && Math.floor(last.ts / 60000) === minute) {
      last.close = p;
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
    } else {
      this.candles.push({
        ts: Date.now(),
        open: p,
        high: p,
        low: p,
        close: p,
        volumeUsd: 0,
      });
    }
    if (this.candles.length > 5000) {
      this.candles = this.candles.slice(-5000);
    }
  }
}
