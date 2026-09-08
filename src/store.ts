import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type {
  AccountState,
  Order,
  Trade,
  StrategyRuntimeState,
  StrategySubBook,
  Snapshot,
  Position,
  PerfBook,
} from './types.js';
import { notify } from './notify.js';

const STATE_DIR = join(process.cwd(), '.botstate');

/** Downsample a time series to at most `max` points, keeping the last point. */
function decimate<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]!);
  const last = arr[arr.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export interface StoreEvents {
  order: (o: Order) => void;
  trade: (t: Trade) => void;
  snapshot: (s: Snapshot) => void;
}

export class StateStore extends EventEmitter {
  account: AccountState;
  orders: Order[] = [];
  trades: Trade[] = [];
  strategies: StrategyRuntimeState;
  price = 0;
  paused = false;
  pauseReason = '';
  /** Rolling equity-curve history (ts + equity USD) for the dashboard chart.
   *  Appended at most once per poll; ring-buffered to keep the payload small. */
  equityHistory: { ts: number; equityUsd: number }[] = [];
  /** 7 days of equity samples at the default 30s poll ≈ 20k points. */
  private maxEquityPoints = 20_160;
  private maxOrders = 2000;
  private maxTrades = 5000;
  /** Accumulated band-occupancy counters (persisted with state). */
  private bandSamples = 0;
  private bandInside = 0;
  /** Last real market context from the engine, so REST/plain snapshots also
   *  surface live VWAP + 24h range instead of falling back to zeros. */
  private lastMarket: { vwap: number; high24h: number; low24h: number };

  constructor(private cfg: AppConfig) {
    super();
    this.account = {
      mode: cfg.mode,
      balances: this.initialBalances(),
      positions: {},
      realizedPnlUsd: 0,
      feesPaidUsd: 0,
      openQty: 0,
      vwap: 0,
    };
    this.lastMarket = { vwap: 0, high24h: 0, low24h: 0 };
    this.strategies = {
      grid: {
        enabled: cfg.strategies.grid.enabled,
        levels: [],
      },
      dca: {
        enabled: cfg.strategies.dca.enabled,
        lastBuyAt: undefined,
      },
      memes: {},
    };
    // Seed ring-fenced meme slots so the dashboard/API always has a home for them.
    for (const m of cfg.strategies.memes) {
      this.strategies.memes[m.id] = {
        id: m.id,
        enabled: m.enabled,
        price: 0, vwap: 0, high24h: 0, low24h: 0,
        vol24hUsd: 0, liquidityUsd: 0,
        baseQty: 0, avgCostPerBase: 0,
        realizedPnlUsd: 0, feesPaidUsd: 0, deployedUsd: 0,
        buys: 0,
        admitted: false, admissionReason: 'pending',
      };
    }
    // CRASH RECOVERY: reconcile any previously-persisted runtime state (same
    // mode) so a restart keeps positions/pnl/trailing signals instead of resetting.
    this.loadPersisted();
  }

  private initialBalances(): { SOL: number; USDC: number } {
    // In paper mode we simulate a balance. We allocate a fixed notional of USDC.
    // Paper default: 1000 USDC + 5 SOL so grid/dca has room.
    if (this.cfg.mode === 'paper') {
      return { SOL: 5, USDC: 1000 };
    }
    // Live mode: balances are polled from chain + Jito; start at zero and overlay.
    return { SOL: 0, USDC: 0 };
  }

  upsertPosition(pos: Position): void {
    const key = `${pos.baseAsset}/${pos.quoteAsset}`;
    this.account.positions[key] = pos;
  }

  getPosition(base: string, quote: string): Position | undefined {
    return this.account.positions[`${base}/${quote}`];
  }

  /**
   * RING-FENCED SUB-BOOKS (H3): lazily create/return a strategy's own slice of
   * the shared SOL position. Grid and DCA each get an independent ledger for
   * qty/cost/PnL/fees; the aggregate Position remains the source of truth for
   * balances, and every fill path must keep sum(subBooks) === position.baseQty.
   */
  subBook(strategy: 'grid' | 'dca'): StrategySubBook {
    const book =
      strategy === 'grid' ? this.strategies.grid.subBook : this.strategies.dca.subBook;
    if (book) return book;
    const fresh: StrategySubBook = { baseQty: 0, avgCostPerBase: 0, realizedPnlUsd: 0, feesPaidUsd: 0 };
    if (strategy === 'grid') this.strategies.grid.subBook = fresh;
    else this.strategies.dca.subBook = fresh;
    return fresh;
  }

  /** Conservation invariant (H3): Σ sub-book qty === aggregate position qty. */
  subBooksConserved(): boolean {
    const pos = this.getPosition('SOL', 'USDC');
    const total =
      (this.strategies.grid.subBook?.baseQty ?? 0) +
      (this.strategies.dca.subBook?.baseQty ?? 0);
    return Math.abs(total - (pos ? pos.baseQty : 0)) < 1e-6;
  }

  /**
   * Reconcile the grid/dca sub-book quantities down to the real on-chain
   * position after a balance sync. Network/priority fees are paid from NATIVE
   * SOL, so every swap burns a hair more SOL than the strategy books record,
   * and the shrink-to-available path can also sell less than the book expected.
   * Over a session those tiny gaps accumulate: the books drift above the chain
   * balance (the dashboard's "held SOL" then overstates reality). This trims
   * the excess proportionally between the books and books it as fees — the
   * difference genuinely was fees — so sum(subBooks) === position.baseQty
   * again (the H3 conservation invariant holds against on-chain truth).
   * Returns the trimmed SOL (0 when already consistent). Never mints SOL back
   * if the books understate the chain balance; the next fill reconciles that.
   */
  reconcileSubBooksToPosition(priceUsd: number): number {
    const pos = this.getPosition('SOL', 'USDC');
    if (!pos || !(priceUsd > 0)) return 0;
    const g = this.strategies.grid.subBook;
    const d = this.strategies.dca.subBook;
    if (!g && !d) return 0;
    const gq = g?.baseQty ?? 0;
    const dq = d?.baseQty ?? 0;
    const total = gq + dq;
    const drift = total - pos.baseQty;
    if (drift <= 1e-9 || total <= 0) return 0;
    const trim = Math.min(drift, total);
    const feeUsd = trim * priceUsd;
    if (g && gq > 0) {
      const share = gq / total;
      g.baseQty -= trim * share;
      g.feesPaidUsd += feeUsd * share;
    }
    if (d && dq > 0) {
      const share = dq / total;
      d.baseQty -= trim * share;
      d.feesPaidUsd += feeUsd * share;
    }
    return trim;
  }

  upsertOrder(order: Order): void {
    const i = this.orders.findIndex((o) => o.id === order.id);
    if (i >= 0) {
      this.orders[i] = order;
    } else {
      this.orders.unshift(order);
    }
    if (this.orders.length > this.maxOrders) {
      this.orders = this.orders.slice(0, this.maxOrders);
    }
    this.emit('order', order);
  }

  recordTrade(trade: Trade): void {
    this.trades.unshift(trade);
    // Maintain a cumulative running fee total so the dashboard never loses fees
    // once trades age out of the visible snapshot window.
    if (trade.feeUsd) this.account.feesPaidUsd += trade.feeUsd;
    if (this.trades.length > this.maxTrades) {
      this.trades = this.trades.slice(0, this.maxTrades);
    }
    this.emit('trade', trade);

    // NOTIFICATIONS (#8): alert on meaningful, real events — realized profit
    // banks and realized losses — so a supervised wallet gets pinged without
    // watching the terminal. Marked quiet (log-only, no Telegram) so routine
    // fills don't spam; the dashboard + event log keep the full audit trail.
    if (typeof trade.realizedPnlUsd === 'number') {
      const dir = trade.direction;
      if (dir === 'SELL' && trade.realizedPnlUsd > 0) {
        notify('profit', `TP bank +${trade.realizedPnlUsd.toFixed(2)} (${trade.strategyId} @ ${trade.price.toFixed(4)})`, true);
      } else if (dir === 'SELL' && trade.realizedPnlUsd < 0) {
        notify('loss', `Realized -${Math.abs(trade.realizedPnlUsd).toFixed(2)} (${trade.strategyId} @ ${trade.price.toFixed(4)})`);
      }
    }
  }

  newOrderId(): string {
    return randomUUID();
  }

  /**
   * Total USDC currently committed to open grid buy orders + DCA basket value.
   * Used to enforce the RISK_MAX_USDC deployment cap on every new buy.
   */
  totalDeployedUsd(): number {
    let deployed = 0;
    // USDC reserved by resting grid BUY orders (fills when price drops to them).
    for (const o of this.orders) {
      if (o.status === 'OPEN' && o.side === 'BUY') deployed += o.quoteQty;
    }
    // Add the value of SOL currently held at current price (cost basis).
    const pos = this.account.positions['SOL/USDC'];
    if (pos && pos.baseQty > 0 && this.price > 0) {
      deployed += pos.baseQty * pos.avgCostPerBase;
    }
    return deployed;
  }

  /** Build and emit a full snapshot for the dashboard. */
  snapshot(
    cfg: AppConfig,
    market: { vwap: number; high24h: number; low24h: number } = { vwap: 0, high24h: 0, low24h: 0 }
  ): Snapshot {
    // Persist the latest real market context; when called without one (REST),
    // fall back to the most recent real values rather than zeros.
    if (market.vwap) this.lastMarket.vwap = market.vwap;
    if (market.high24h) this.lastMarket.high24h = market.high24h;
    if (market.low24h) this.lastMarket.low24h = market.low24h;
    market = { ...this.lastMarket };
    this.account.vwap = market.vwap || this.account.vwap;
    const s: Snapshot = {
      ts: Date.now(),
      mode: cfg.mode,
      price: this.price,
      account: this.account,
      orders: this.orders.slice(0, 200),
      trades: this.trades.slice(0, 200),
      strategies: this.strategies,
      config: {
        grid: cfg.strategies.grid,
        dca: cfg.strategies.dca,
        memes: cfg.strategies.memes,
      },
      market,
      risk: {
        maxUsdcPosition: cfg.risk.maxUsdcPosition,
        deployedUsd: this.totalDeployedUsd(),
        hardStopPct: cfg.risk.hardStopPct,
        unrealizedHardStopPct: cfg.risk.unrealizedHardStopPct,
        unrealizedPnlUsd: this.unrealizedPnlUsd(),
        maxSlippageBps: cfg.risk.maxSlippageBps,
        paused: this.paused,
        pauseReason: this.pauseReason,
      },
      perf: this.computePerf(cfg),
      // Chart payload: decimate the full 7-day ring to ~600 points so the
      // dashboard shows the whole week without a megabyte per update.
      equityHistory: decimate(this.equityHistory, 600),
    };
    // Sample one equity point per poll for the dashboard curve.
    this.sampleEquity();
    this.emit('snapshot', s);
    return s;
  }

  /**
   * Current UNREALIZED PnL on the open SOL basket: (current price - avg cost) *
   * held qty. Negative = the open position is underwater. Meme slots are NOT
   * included here — they're ring-fenced and tracked inside their own slot.
   */
  unrealizedPnlUsd(): number {
    const pos = this.account.positions['SOL/USDC'];
    if (!pos || pos.baseQty <= 0 || pos.avgCostPerBase <= 0 || this.price <= 0) return 0;
    return (this.price - pos.avgCostPerBase) * pos.baseQty;
  }

  /**
   * Record the current equity into the rolling curve (called once per poll).
   *
   * CORRECT DEFINITION — equity = value of everything the wallet holds:
   *   USDC cash + SOL held at current market price.
   *
   * Crucially we do NOT add realized/unrealized PnL here. Every buy spent USDC
   * to gain SOL (fees included) and every sell returned proceeds into USDC, so
   * the profit/loss is ALREADY embedded in the two balances. Adding realized +
   * unrealized on top would double-count the same P&L and make the curve drift
   * ever higher relative to true net worth as positions grow. (Prior versions
   * summed all four terms — the dashboard Net Worth vs Equity gap was this bug.)
   * Ring-buffered so the persisted/streamed payload stays small.
   */
  sampleEquity(): void {
    const now = Date.now();
    const last = this.equityHistory[this.equityHistory.length - 1];
    if (last && now - last.ts < 5000) return; // dedupe within a poll window
    const stable = this.account.balances.USDC ?? 0;
    const nativeSolUsd = (this.account.balances.SOL ?? 0) * this.price;
    this.equityHistory.push({ ts: now, equityUsd: stable + nativeSolUsd });
    if (this.equityHistory.length > this.maxEquityPoints) {
      this.equityHistory = this.equityHistory.slice(-this.maxEquityPoints);
    }
  }

  // ---------------------------------------------------------------------------
  // CRASH RECOVERY / STATE PERSISTENCE (#7)
  //
  // The engine holds all positions/orders/meme state in memory. A crash or
  // restart would otherwise reset peak/trailing/realized signals and orphan
  // resting orders. We persist a compact snapshot of recoverable state to
  // .botstate/state.json (mode-keyed) on a debounced interval and on shutdown,
  // then reconcile from it on the next launch. Live balances are NOT persisted —
  // they're always re-read from chain on startup so a stale file can never
  // fabricate a balance. Paper balances ARE restored (they're simulated).
  // ---------------------------------------------------------------------------

  private static enabled(): boolean {
    const v = process.env.STATE_PERSIST;
    if (v !== undefined) return v === '1' || v.toLowerCase() === 'true';
    // Allow tests to force it off via STATE_PERSIST=0 (set before construct).
    return process.env.NODE_ENV === 'test' ? false : true; // on by default otherwise
  }

  /** Name the state file per mode so paper and live never clobber each other. */
  private static fileFor(mode: string): string {
    return join(STATE_DIR, `state-${mode}.json`);
  }

  /** Restore persisted state into this fresh store (called once at construct). */
  loadPersisted(): void {
    if (!StateStore.enabled()) return;
    const file = StateStore.fileFor(this.cfg.mode);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        account?: AccountState;
        orders?: Order[];
        trades?: Trade[];
        strategies?: StrategyRuntimeState;
        paused?: boolean;
        pauseReason?: string;
        bandSamples?: number;
        bandInside?: number;
        equityHistory?: { ts: number; equityUsd: number }[];
      };
      // Only restore position/realized state from the same mode's file; balance
      // is refreshed from chain in live (never trust a stale persisted balance).
      if (raw.account) {
        if (this.cfg.mode === 'paper') {
          this.account = { ...this.account, ...raw.account };
        } else {
          // Live: keep balances at zero (re-read on chain) but restore positions
          // + running realized PnL / fees so the engine reconciles correctly.
          this.account.realizedPnlUsd = raw.account.realizedPnlUsd ?? 0;
          this.account.feesPaidUsd = raw.account.feesPaidUsd ?? 0;
          if (raw.account.positions) this.account.positions = raw.account.positions;
          this.account.openQty = raw.account.openQty ?? 0;
        }
      }
      if (Array.isArray(raw.orders)) this.orders = raw.orders;
      if (Array.isArray(raw.trades)) this.trades = raw.trades;
      if (typeof raw.bandSamples === 'number') this.bandSamples = raw.bandSamples;
      if (typeof raw.bandInside === 'number') this.bandInside = raw.bandInside;
      if (Array.isArray(raw.equityHistory)) {
        this.equityHistory = raw.equityHistory as { ts: number; equityUsd: number }[];
      }
      if (raw.strategies) {
        // Overlay persisted strategy state onto the freshly-seeded slots so we
        // keep any slots that exist now while restoring grid/dca/meme progre.
        if (raw.strategies.grid) {
          this.strategies.grid = { ...this.strategies.grid, ...raw.strategies.grid, enabled: this.strategies.grid.enabled };
        }
        if (raw.strategies.dca) {
          this.strategies.dca = { ...this.strategies.dca, ...raw.strategies.dca, enabled: this.strategies.dca.enabled };
        }
        for (const [id, m] of Object.entries(raw.strategies.memes ?? {})) {
          if (this.strategies.memes[id]) this.strategies.memes[id] = { ...this.strategies.memes[id], ...m };
        }
      }
      this.paused = !!raw.paused;
      this.pauseReason = raw.pauseReason ?? '';
      console.log(`[persist] restored runtime state from ${file}`);
    } catch (e) {
      console.warn(`[persist] could not restore state: ${(e as Error).message}`);
    }
  }

  /**
   * PERFORMANCE TELEMETRY (B): 24h rolling, measurement-only. Derived entirely
   * from real recorded trades and the live grid band; drives no trading
   * decisions. This is the evidence base for tuning step size / level count /
   * TP params from live data instead of guesses.
   */
  private computePerf(cfg: AppConfig): Snapshot['perf'] {
    void cfg; // band comes from live level state, not static config
    const booksFor = (windowMs: number): PerfBook[] => {
      const cutoff = windowMs === 0 ? 0 : Date.now() - windowMs;
      const recent = this.trades.filter((t) => t.ts >= cutoff);
      const byId = new Map<string, Trade[]>();
      for (const t of recent) {
        const arr = byId.get(t.strategyId) ?? [];
        arr.push(t);
        byId.set(t.strategyId, arr);
      }
      const books: PerfBook[] = [];
      for (const [strategyId, trades] of byId) {
        let realized = 0;
        let fees = 0;
        const wins: number[] = [];
        const losses: number[] = [];
        for (const t of trades) {
          fees += t.feeUsd || 0;
          if (t.direction === 'SELL' && typeof t.realizedPnlUsd === 'number') {
            realized += t.realizedPnlUsd;
            if (t.realizedPnlUsd > 0) wins.push(t.realizedPnlUsd);
            else if (t.realizedPnlUsd < 0) losses.push(t.realizedPnlUsd);
          }
        }
        const sumWins = wins.reduce((s, v) => s + v, 0);
        const sumLosses = losses.reduce((s, v) => s + v, 0);
        const sells = wins.length + losses.length;
        const earliest = trades.reduce((m, t) => Math.min(m, t.ts), Date.now());
        const spanH = Math.max(1 / 60, (Date.now() - earliest) / 3600_000);
        books.push({
          strategyId,
          realizedPnlUsd: realized,
          feesUsd: fees,
          netPnlUsd: realized - fees,
          fills: trades.length,
          fillsPerHour: trades.length / spanH,
          avgWinUsd: wins.length ? sumWins / wins.length : 0,
          avgLossUsd: losses.length ? sumLosses / losses.length : 0,
          winRate: sells ? wins.length / sells : 0,
          profitFactor: sumLosses < 0 ? sumWins / Math.abs(sumLosses) : sumWins > 0 ? Infinity : 0,
        });
      }
      books.sort((a, b) => b.netPnlUsd - a.netPnlUsd);
      return books;
    };

    // Band occupancy: is the CURRENT tape inside the armed ladder's price
    // edges? (min/max of live level prices). A dedicated multi-sample ring
    // buffer would refine this later; the snapshot updates every poll, so the
    // dashboard effectively gets the live reading.
    const levelPrices = this.strategies.grid.levels
      .map((l) => l.price)
      .filter((p) => p > 0);
    const hasBand = levelPrices.length >= 2 && this.price > 0;
    const lower = hasBand ? Math.min(...levelPrices) : 0;
    const upper = hasBand ? Math.max(...levelPrices) : 0;

    // ACCUMULATED occupancy (persisted): every snapshot tick with an armed
    // band contributes one in/out sample. This turns the "is price in band
    // right now" reading into a real % over days — the number that tells us
    // whether the band actually contains tape.
    if (hasBand) {
      this.bandSamples++;
      if (this.price >= lower && this.price <= upper) this.bandInside++;
    }

    return {
      books: booksFor(24 * 3600_000),
      books7d: booksFor(7 * 24 * 3600_000),
      booksAll: booksFor(0),
      band: {
        lower,
        upper,
        insidePct: this.bandSamples > 0 ? this.bandInside / this.bandSamples : 0,
        samples: this.bandSamples,
      },
    };
  }

  /** Serialize recoverable state to the mode-keyed file. */
  private persistedPayload(): Record<string, unknown> {
    return {
      account: this.account,
      orders: this.orders.slice(0, this.maxOrders),
      trades: this.trades.slice(0, this.maxTrades),
      strategies: this.strategies,
      paused: this.paused,
      pauseReason: this.pauseReason,
      bandSamples: this.bandSamples,
      bandInside: this.bandInside,
      equityHistory: this.equityHistory,
    };
  }

  /**
   * Persist current state synchronously. Called manually on a debounced
   * interval and on shutdown. Throwing is swallowed — persistence must never
   * crash the trading loop.
   */
  persistNow(): void {
    if (!StateStore.enabled()) return;
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      // SECURITY (audit M2): state files contain balances/PnL/orders — restrict
      // to owner-only so other local users on a shared machine can't read them.
      writeFileSync(StateStore.fileFor(this.cfg.mode), JSON.stringify(this.persistedPayload()), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (e) {
      console.warn(`[persist] write failed: ${(e as Error).message}`);
    }
  }
}
