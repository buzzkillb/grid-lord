import type { GridConfig, DcaConfig, MemeSlotConfig } from './config.js';

export type Side = 'BUY' | 'SELL';

/** One strategy book's rolling performance row (dashboard telemetry). */
export interface PerfBook {
  strategyId: string;
  /** Banked PnL in the window (sum of SELL realizedPnlUsd, gross). */
  realizedPnlUsd: number;
  /** Total fees paid in the window. */
  feesUsd: number;
  /** Net = realized − fees. */
  netPnlUsd: number;
  /** Completed fills in the window. */
  fills: number;
  /** Fills per hour (window-normalized). */
  fillsPerHour: number;
  /** Average banked profit per profitable SELL, USD. */
  avgWinUsd: number;
  /** Average banked loss per losing SELL, USD (negative). */
  avgLossUsd: number;
  /** Win rate on SELLs in the window (0..1). */
  winRate: number;
  /** Profit factor: Σ wins / |Σ losses| (Infinity when no losses). */
  profitFactor: number;
}

export type OrderKind = 'GRID_BUY' | 'GRID_SELL' | 'DCA_BUY' | 'DCA_SELL';

export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Order {
  id: string;
  kind: OrderKind;
  side: Side;
  /** limit price in USDC (per SOL) */
  price: number;
  /** amount of base asset (SOL) for this order */
  baseQty: number;
  /** amount of quote asset (USDC) reserved */
  quoteQty: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  /** paper vs live */
  mode: 'paper' | 'live';
  strategyId: string;
  note?: string;
}

export type TradeDirection = 'BUY' | 'SELL';

export interface Trade {
  id: string;
  orderId: string;
  strategyId: string;
  direction: TradeDirection;
  /** execution price in USDC per SOL */
  price: number;
  baseQty: number;
  quoteQty: number;
  feeUsd: number; // simulated/estimated fee
  realizedPnlUsd?: number; // for SELLs that close a cost basis
  ts: number;
  mode: 'paper' | 'live';
}

export interface Position {
  baseAsset: string;
  quoteAsset: string;
  baseQty: number; // SOL held
  quoteQty: number; // USDC held
  avgCostPerBase: number; // average cost basis per SOL
}

export interface AccountState {
  mode: 'paper' | 'live';
  balances: {
    SOL: number;
    USDC: number;
  };
  positions: Record<string, Position>; // key: `${base}/${quote}`
  vwap?: number; // rolling VWAP for DCA dip trigger
  realizedPnlUsd: number;
  /** Cumulative fees paid across ALL trades (not just the visible snapshot). */
  feesPaidUsd: number;
  openQty: number; // SOL currently held by bots
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface GridState {
  levels: GridLevelState[];
  enabled: boolean;
  /** RING-FENCED SUB-BOOK (H3): grid's own slice of the SOL position.
   *  The grid cost-guard (sellBelowCostWouldLose) reads THIS basis, not the
   *  aggregate commingled position, so a cheap DCA lot can never let the grid
   *  arm a below-cost sell against grid-owned lots. */
  subBook?: StrategySubBook;
}

export interface GridLevelState {
  /** price of this level in USDC */
  price: number;
  /** outstanding buy order id (null if none) */
  buyOrderId?: string;
  /** outstanding sell order id (null if none) */
  sellOrderId?: string;
  baseQty: number;
}

export interface DcaState {
  enabled: boolean;
  lastBuyAt?: number;
  /** Highest price seen since the last take-profit reset (trailing peak). */
  peakPrice?: number;
  /** True after price first crosses avgCost*(1+tp) — countdown to a trail-out. */
  tpArmed?: boolean;
  lastTpAt?: number;
  /** Number of DCA buys completed (drives the value-averaging target path). */
  buys?: number;
  /** RING-FENCED SUB-BOOK (H3): DCA's own slice of the SOL position.
   *  baseQty/avgCost here are maintained by the broker on every DCA fill so
   *  DCA take-profit logic can act on DCA capital only, independent of grid. */
  subBook?: StrategySubBook;
}

/**
 * Per-strategy ring-fenced ledger of the shared SOL/USDC position (H3).
 * Invariant maintained by every fill path: the sum of all sub-book baseQty
 * must equal the aggregate SOL/USDC position baseQty, and each strategy's
 * PnL/cost decisions (grid cost-guard, DCA take-profit) read its OWN book,
 * never the commingled aggregate.
 */
export interface StrategySubBook {
  baseQty: number;
  avgCostPerBase: number;
  /** Cumulative realized PnL booked by THIS strategy's sells (USD). */
  realizedPnlUsd: number;
  /** Cumulative fees paid by THIS strategy's fills (USD). */
  feesPaidUsd: number;
}

/**
 * Runtime state for one graduated-meme slot (CYB, and future memes). Fully
 * ring-fenced from the SOL book. All stats surface REAL on-chain data.
 */
export interface MemeState {
  id: string;
  enabled: boolean;
  /** Real current price in USDC (0 until data arrives; never invented). */
  price: number;
  /** Real volume-weighted average price from on-chain OHLCV volume. */
  vwap: number;
  high24h: number;
  low24h: number;
  vol24hUsd: number;
  liquidityUsd: number;
  /** Held base qty of this meme. */
  baseQty: number;
  avgCostPerBase: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  /** USDC committed = held base at average cost. */
  deployedUsd: number;
  buys: number;
  /** Real 24h volume / liquidity admission gate. */
  admitted: boolean;
  admissionReason: string;
  lastBuyAt?: number;
  tpArmed?: boolean;
  peakPrice?: number;
  lastTpAt?: number;
  /** Ring-fenced loss stop: true once this slot's REALIZED PnL breached its
   *  per-slot loss ceiling — accumulation halted, trailing TP still unwinds. */
  lossStopped?: boolean;
  /** Highest real pool liquidity seen since we started holding (dead-book base). */
  peakLiquidityUsd?: number;
  /** True once real liquidity decayed past the exit threshold — defensive exit done. */
  deadBookExited?: boolean;
  /** Index of the next take-profit rung to fire (0 = first rung). */
  tpRungIndex?: number;
}

export interface StrategyRuntimeState {
  grid: GridState;
  dca: DcaState;
  memes: Record<string, MemeState>;
}

export interface Snapshot {
  ts: number;
  mode: 'paper' | 'live';
  price: number;
  account: AccountState;
  orders: Order[];
  trades: Trade[];
  strategies: StrategyRuntimeState;
  config: {
    grid: GridConfig;
    dca: DcaConfig;
    memes: MemeSlotConfig[];
  };
  /**
   * PERFORMANCE TELEMETRY (measurement-only). `books` is the 24h rolling
   * window; `books7d` / `booksAll` cover 7 days and all-time so a week of
   * live data can actually be analyzed, not just yesterday's slice.
   */
  perf: {
    books: PerfBook[];
    books7d: PerfBook[];
    booksAll: PerfBook[];
    /** Grid band occupancy: share of sampled polls inside [lower, upper]. */
    band: {
      lower: number;
      upper: number;
      /** 0..1 share of the last N equity samples inside the band. */
      insidePct: number;
      /** Number of samples the estimate is based on. */
      samples: number;
    };
  };
  /** Rolling market context surfaced to the dashboard. */
  market: {
    vwap: number;
    high24h: number;
    low24h: number;
  };
  risk: {
    maxUsdcPosition: number;
    /** USDC currently committed to resting buys + held SOL at cost. */
    deployedUsd: number;
    hardStopPct: number;
    /** Realized losses that trigger a full pause. */
    unrealizedHardStopPct: number;
    /** Current unrealized PnL on the open SOL basket (USD, negative = underwater). */
    unrealizedPnlUsd: number;
    maxSlippageBps: number;
    paused: boolean;
    /** Non-empty when a risk rule has paused the bot (realized/unrealized/other). */
    pauseReason?: string;
  };
  /** Rolling equity curve (ts + equity USD) for the dashboard chart. */
  equityHistory: { ts: number; equityUsd: number }[];
}
