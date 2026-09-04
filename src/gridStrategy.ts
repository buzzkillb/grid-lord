import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';
import type { Broker } from './broker.js';
import type { PriceOracle } from './price.js';
import type { Order } from './types.js';

/**
 * Grid strategy — ADAPTIVE + SMARTER (price-smart, volatility-aware, trend-aware,
 * fee-aware, cost-aware). Preserves the proven one-order-per-level safety model.
 *
 * NOTHING is hardcoded. The band is derived from recent on-chain price history
 * (the oracle's rolling high/low over GRID_HISTORY_HOURS), then WIDENED/TIGHTENED
 * by recent realized volatility (Feature 2). The ladder is STEP-BASED: every
 * level carries a single resting order at an even step, BUY below the anchor or
 * SELL above it.
 *
 * When a level's order fills, `onFill` re-arms the ADJACENT level at its step
 * price (BUY -> SELL above, SELL -> BUY below) so the grid stays evenly spaced.
 * Intelligence applied on every arm:
 *   Feature 1 — profit protection:
 *     * levels are never spaced tighter than the fee-floor step (we don't trade
 *       waves that can't clear network + routing fees),
 *     * a SELL is never re-armed below our average buy cost (we don't give back
 *       profit on a held position to chase a tight re-entry).
 *   Feature 3 — trend/regime filter: we don't arm asks into a strong downtrend
 *     or bids into a strong uptrend (don't fight momentum).
 *
 * It RE-ANCHORS around the live market on drift (bounded by GRID_REANCHOR_MIN).
 *
 * Safety: each level has AT MOST ONE resting order; BUY arms are gated by the
 * USDC budget cap (totalDeployedUsd + level cost <= RISK_MAX_USDC). This
 * structurally prevents double-fill phantom PnL AND over-deployment.
 */
export class GridStrategy {
  private initialized = false;
  private anchor = 0;
  private step = 0;
  private reanchorArmed = true;
  private lastReanchorAt = 0;
  /** Consecutive polls where price has drifted past the re-anchor threshold.
   *  A re-anchor is structural (cancels + rebuilds the whole ladder), so we
   *  require this to reach the configured confirm count before acting — a
   *  single glitchy print (e.g. a one-poll ~$94.6 on a ~$101 SOL) must not
   *  re-center the band on a bogus price. Reset whenever price returns to the
   *  center of the band. */
  private reanchorDriftStreak = 0;
  /** Feature 2 — re-arms waiting for price to clear the anti-churn deadzone. */
  private pendingArms: { side: 'BUY' | 'SELL'; refPrice: number; target: {
    buyOrderId?: string; sellOrderId?: string; price: number; baseQty: number;
  } }[] = [];
  /** Trend threshold (fraction) beyond which the regime filter suppresses arms. */
  private static TREND_LIMIT = 0.04; // 4% over the trend window
  /** VWAP-slope threshold (fraction) beyond which the grid avoids arming the
   *  extreme side (Feature 6). Slower, more robust regime read than the fast trend. */
  private static VWAP_SLOPE_LIMIT = 0.015; // VWAP sliding ±1.5% over the window

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private broker: Broker,
    private priceOracle: PriceOracle
  ) {}

  /**
   * Adaptive band: from recent on-chain high/low, then volatility-adaptive
   * (Feature 2). Recent volatility scales the pad: choppy tape -> wider band,
   * calm tape -> tighter band, so steps are coarse enough to profit and we
   * still cover the level count.
   */
  private bandFor(price: number, high: number, low: number): { lower: number; upper: number } {
    const range = Math.max(0, high - low);
    const basePad = price * 0.06;
    // Volatility factor: ~0.8x at calm (1% vol) .. ~2.5x at very choppy (5% vol).
    const volAnchor = Math.min(1, Math.max(0.15, this.priceOracle.recentVolatility() / 0.03));
    const volScale = 0.7 + 1.8 * volAnchor; // 0.7 .. 2.5
    const span = Math.max(range, basePad * 2, price * 0.12);
    const pad = basePad + span * 0.08 * volScale;
    return { lower: Math.max(1e-9, price - pad), upper: price + pad };
  }

  private levelCount(): number {
    return Math.max(2, this.cfg.strategies.grid.numLevels);
  }

  /**
   * Baseline USDC per grid level, after compounding (Feature 3) and
   * volatility sizing (Feature 5).
   *  - Feature 3 (compounding): reinvest realized PnL — per-level notional
   *    scales UP with cumulative realized PnL and DOWN if PnL is negative.
   *    GRID_COMPOUND_PCT=1 means a PnL equal to the whole capital cap doubles
   *    (or halves) per-level size. Bounded to [0.5x, 3x].
   *  - Feature 5 (vol sizing): OVERSIZE in calm tape (levels likelier to fill),
   *    UNDERSIZE in violent tape (avoid catching a falling knife). Bounded.
   */
  private levelUsd(): number {
    const g = this.cfg.strategies.grid;
    const base = g.usdcPerGrid || 20;
    const cap = this.cfg.risk.maxUsdcPosition;
    // Feature 3 — compounding on cumulative realized PnL.
    const pnl = this.store.account.realizedPnlUsd || 0;
    const comp = Math.min(3, Math.max(0.5, 1 + g.compoundPct * (pnl / cap)));
    // Feature 5 — volatility-scaled sizing (1.0 at 3% realized vol).
    let vol = 1;
    if (g.volSizingEnabled) {
      const v = this.priceOracle.recentVolatility();
      if (v > 0) vol = Math.min(1.5, Math.max(0.6, 0.03 / v));
    }
    return Math.max(5, base * comp * vol);
  }

  /**
   * Feature 4 — VWAP skew. Deploy MORE buy-notional on levels BELOW VWAP (buy
   * dips cheaper) and LESS on levels ABOVE VWAP (don't over-buy strength).
   * GRID_SKEW_STRENGTH controls the steepness of the tilt; result clamped to
   * [0.5x, 2x] of the base so a single level can never balloon past budget.
   */
  private sizeForLevel(price: number): number {
    const base = this.levelUsd();
    const g = this.cfg.strategies.grid;
    if (!g.vwapSkewEnabled) return base;
    const vwap = this.priceOracle.vwap;
    if (vwap <= 0) return base;
    const rel = (vwap - price) / vwap; // >0 below VWAP (buy cheaper)
    const factor = Math.exp(rel * g.skewStrength);
    return Math.max(base * 0.5, Math.min(base * 2, base * factor));
  }

  /** True if we have budget to deploy one more buy of this notional. */
  private canAffordBuy(notional: number): boolean {
    const deployed = this.store.totalDeployedUsd();
    return deployed + notional <= this.cfg.risk.maxUsdcPosition;
  }

  /**
   * Feature 3 + 6 — trend/VWAP-slope regime filter. Returns false when we
   * should NOT arm this side (don't fight strong momentum, and don't arm asks
   * into a VWAP sliding down / bids into a VWAP climbing strongly).
   */
  private trendBlocks(side: 'BUY' | 'SELL'): boolean {
    const trend = this.priceOracle.recentTrend();
    if (side === 'SELL' && trend <= -GridStrategy.TREND_LIMIT) return true; // strong downtrend -> no new asks
    if (side === 'BUY' && trend >= GridStrategy.TREND_LIMIT) return true; // strong uptrend -> no new bids

    // Feature 6 — VWAP slope. A falling VWAP means the center of gravity is
    // sliding down: arming an ask at the top of the band would catch a knife /
    // sell into a dieing range. Only block the extreme edge so normal scaling
    // still works; VWAP slope is a slower, more robust regime read than the
    // fast recentTrend above.
    const slope = this.priceOracle.vwapSlope();
    if (side === 'SELL' && slope <= -GridStrategy.VWAP_SLOPE_LIMIT) return true; // VWAP sliding down -> no new asks near top
    if (side === 'BUY' && slope >= GridStrategy.VWAP_SLOPE_LIMIT) return true; // VWAP climbing -> don't buy strength at top
    return false;
  }

  /**
   * Feature 1 — profit protection. A SELL that would realize a loss below our
   * average buy cost is not worth arming (we'd give back profit + fees). This
   * only guards against arming below cost; capturing existing gains stays open.
   *
   * H3: reads the GRID SUB-BOOK when it holds lots, so a cheap DCA lot in the
   * shared position can never let the grid arm a below-cost sell against
   * grid-owned capital. Falls back to the aggregate position for pre-H3 state.
   */
  private sellBelowCostWouldLose(orderPrice: number): boolean {
    // H3: read the GRID SUB-BOOK when it exists (authoritative once any grid or
    // dca fill has occurred), so a cheap DCA lot in the shared position can
    // never let the grid arm a below-cost sell against grid-owned capital.
    // A book with no grid lots (avgCost 0) imposes no floor — nothing to lose.
    const book = this.store.strategies.grid.subBook;
    if (book) {
      return book.avgCostPerBase > 0 && orderPrice <= book.avgCostPerBase;
    }
    const pos = this.store.getPosition(
      this.cfg.strategies.grid.baseAsset,
      this.cfg.strategies.grid.quoteAsset
    );
    if (!pos || pos.baseQty <= 0 || pos.avgCostPerBase <= 0) return false;
    // Gross proceeds at this price vs cost + round-trip fee headroom.
    return orderPrice <= pos.avgCostPerBase;
  }

  /**
   * True if a level already carries at least one LIVE (OPEN) resting order for
   * either side. Used to enforce the one-order-per-level invariant: we never
   * stack a second order on a level that is already armed (e.g. a pending
   * deadzone re-arm firing after the sweep already placed the order, or a
   * stale id that points at a CANCELLED/FILLED order which we may re-place).
   */
  private levelHasLiveOrder(level: { buyOrderId?: string; sellOrderId?: string }): boolean {
    for (const id of [level.buyOrderId, level.sellOrderId]) {
      if (!id) continue;
      const o = this.store.orders.find((x) => x.id === id && x.status === 'OPEN');
      if (o) return true;
    }
    return false;
  }

  /**
   * Self-healing periodic re-arm sweep (called every poll by the engine).
   *
   * The ladder can end up with an unarmed level for reasons OTHER than a fill:
   *  - a re-anchor rebuild ran while the trend filter was suppressing a side
   *    ("don't arm asks into a falling knife"), and
   *  - a pending deadzone re-arm that was blocked by a guard gets DROPPED and
   *    is never retried by onFill/processPendingArms, so it stays unarmed even
   *    after price recovers.
   *
   * In both cases the grid quietly holds a winner with no resting exit (the
   * exact orphaned-exit gap we kept working around by restarting). This sweep
   * re-arms any level that has NO live order, choosing the side by the level's
   * position relative to the anchor. The same guards still apply (budget for
   * BUY, trend filter on both, cost floor on SELL), so a level that is still
   * genuinely blocked is left alone and simply retried next poll — recovery is
   * automatic, no daemon restart required.
   */
  sweepArms(): void {
    if (!this.initialized) return;
    const anchor = this.anchor;
    if (anchor <= 0) return;
    const levels = this.store.strategies.grid.levels;
    for (const level of levels) {
      if (this.levelHasLiveOrder(level)) continue;
      const side: 'BUY' | 'SELL' | null =
        level.price < anchor ? 'BUY' : level.price > anchor ? 'SELL' : null;
      if (!side) continue;
      this.placeOne(level.price, side, level);
    }
  }

  /**
   * Arm a resting order on a grid level. Applies budget (BUY), trend filter,
   * cost protection (SELL), and the fee-floor step (both sides). A level that
   * is already live is skipped (one order per level).
   * @returns true if placed.
   */
  private placeOne(price: number, side: 'BUY' | 'SELL', level: {
    buyOrderId?: string;
    sellOrderId?: string;
    price: number;
    baseQty: number;
  }): boolean {
    if (this.levelHasLiveOrder(level)) return false;
    const notional = this.sizeForLevel(price);
    if (side === 'BUY' && !this.canAffordBuy(notional)) return false;
    if (this.trendBlocks(side)) return false;
    if (side === 'SELL' && this.sellBelowCostWouldLose(price)) return false;

    const qty = notional / price;
    const order: Order = {
      id: this.store.newOrderId(),
      kind: side === 'BUY' ? 'GRID_BUY' : 'GRID_SELL',
      side,
      price,
      baseQty: qty,
      quoteQty: price * qty,
      status: 'OPEN',
      createdAt: Date.now(),
      mode: 'paper',
      strategyId: 'grid',
    };
    if (side === 'BUY') level.buyOrderId = order.id;
    else level.sellOrderId = order.id;
    this.broker.placeLimitOrder(order);
    return true;
  }

  /** Build a fresh, evenly-spaced ladder around `anchor`. One order per level. */
  private build(anchor: number): void {
    const high = this.priceOracle.recentHigh(this.cfg.strategies.grid.historyHours * 60);
    const low = this.priceOracle.recentLow(this.cfg.strategies.grid.historyHours * 60);
    let { lower, upper } = this.bandFor(anchor, high, low);
    this.buildLadder(anchor, lower, upper);
  }

  /**
   * Build a ladder across [lo, hi] with ANCHOR-WEIGHTED spacing (Feature A).
   *
   * Price mean-reverts around the anchor, so gaps grow linearly with distance
   * from it: denser levels where fills actually happen (more waves harvested
   * per unit of band width), sparser outer levels still catch extremes. K
   * (GRID_LADDER_WEIGHT_K, default 0.12) controls the growth; K=0 reproduces
   * the old even ladder. Fee-floor safe: every gap >= minProfitStepUsd and the
   * band widens symmetrically when clamping needs more room than bandFor gave.
   */
  private buildLadder(anchor: number, lo: number, hi: number): void {
    const minStep = this.broker.minProfitStepUsd(anchor);
    const n = this.levelCount();
    const k = (() => {
      const v = Number(process.env.GRID_LADDER_WEIGHT_K);
      return Number.isFinite(v) && v >= 0 && v <= 3 ? v : 0.12;
    })();

    // M gaps per side from the anchor; arithmetic growth factor per rank.
    const M = Math.max(1, Math.floor(n / 2));
    const growth = 1 + ((M - 1) * k) / 2; // Σ_{r=1..M} (1 + (r-1)k) = M * growth
    let inner = (hi - lo) / (2 * M * growth);
    if (inner < minStep) {
      inner = minStep;
      const half = inner * M * growth;
      lo = anchor - half;
      hi = anchor + half;
    }

    // Level prices: anchor ± cumulative growing gaps.
    const below: number[] = [];
    const above: number[] = [];
    let d = 0;
    for (let r = 1; r <= M; r++) {
      d += inner * (1 + (r - 1) * k);
      below.push(anchor - d);
      above.push(anchor + d);
    }
    const prices: number[] = [...below.reverse(), anchor, ...above];

    for (const o of this.store.orders) {
      if (o.strategyId === 'grid' && o.status === 'OPEN') o.status = 'CANCELLED';
    }
    // DROP any pending deadzone re-arms — they reference levels from the OLD
    // ladder. Keeping them after a rebuild could re-arm a stale level price on
    // top of the new ladder (double-arm / orphaned order). They're re-derived
    // by onFill against the fresh ladder as it trades.
    this.pendingArms = [];
    this.store.strategies.grid.levels = [];
    this.step = inner; // inner gap = tightest spacing; deadzone bases off it
    this.anchor = anchor;

    let placed = 0;
    for (const price of prices) {
      if (price <= 0) continue;
      const level = {
        price,
        baseQty: this.sizeForLevel(price) / price,
        buyOrderId: undefined as string | undefined,
        sellOrderId: undefined as string | undefined,
      };
      this.store.strategies.grid.levels.push(level);
      const side: 'BUY' | 'SELL' | null = price < anchor ? 'BUY' : price > anchor ? 'SELL' : null;
      if (side && this.placeOne(price, side, level)) placed++;
    }

    console.log(
      `[grid] anchored ${anchor.toFixed(1)} | band ${lo.toFixed(1)}–${hi.toFixed(1)} ` +
        `(inner step ${inner.toFixed(2)}, minProfit ${minStep.toFixed(2)}, ` +
        `weighted K=${k}, ${n} levels, ${placed} armed, ` +
        `vol ${(this.priceOracle.recentVolatility() * 100).toFixed(1)}%)`
    );
    this.lastReanchorAt = Date.now();
  }

  initialize(): void {
    const price = this.store.price;
    if (price <= 0) return;
    this.build(price);
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Re-anchor the grid around the live market when price drifts enough that the
   * band is no longer centered on where we trade. Bounded by GRID_REANCHOR_MIN.
   */
  checkReanchor(): void {
    if (!this.initialized || !this.reanchorArmed) return;
    const price = this.store.price;
    if (price <= 0 || this.anchor <= 0 || this.step <= 0) return;

    const levels = this.store.strategies.grid.levels;
    if (levels.length === 0) return;
    const bandHigh = Math.max(...levels.map((l) => l.price));
    const bandLow = Math.min(...levels.map((l) => l.price));
    const bandHalf = (bandHigh - bandLow) / 2;
    if (bandHalf <= 0) return;

    const distFromCenter = Math.abs(price - this.anchor);
    const driftPct = distFromCenter / bandHalf;
    if (driftPct <= 0.5) {
      // Price returned to (or near) the center of the band — a settled market
      // again, so the drift streak never gets a stale free-pass. Reset it.
      this.reanchorDriftStreak = 0;
      return;
    }

    // A re-anchor is structural (cancels + rebuilds the whole ladder). Don't
    // trust a single drifted poll: a one-poll glitch (e.g. ~$94.6 on a ~$101
    // SOL) must NOT re-center the band on a bogus price. Increment a confinement
    // streak and only re-anchor once it reaches the configured confirm count.
    this.reanchorDriftStreak += 1;
    const confirmPolls = this.cfg.strategies.grid.reanchorConfirmPolls ?? 3;
    if (this.reanchorDriftStreak < confirmPolls) return;

    const now = Date.now();
    if (now - this.lastReanchorAt < this.cfg.strategies.grid.reanchorMinutes * 60_000) return;
    console.log(
      `[grid] drift ${this.anchor.toFixed(1)} -> ${price.toFixed(1)} ` +
        `(${(driftPct * 100).toFixed(0)}% of half-band, ${this.reanchorDriftStreak} confirm polls); re-anchoring`
    );
    this.reanchorArmed = false;
    this.build(price);
    this.reanchorDriftStreak = 0;
    setTimeout(() => { this.reanchorArmed = true; }, 3 * this.cfg.pollIntervalMs);
  }

  /**
   * A grid level filled. Re-arm the ADJACENT level at its step price so the
   * grid stays evenly spaced and keeps harvesting chop.
   *
   * Feature 2 — anti-churn deadzone: instead of re-arming the instant a fill
   * happens, we hold the replacement in a PENDING state until price has moved
   * GRID_DEADZONE_STEPS away from the fill. This stops micro-whipsaws from
   * incurring two fee round-trips for ~no net move (the classic small-grid
   * bleed). `processPendingArms` (called every poll) promotes a pending arm to
   * a live order once price clears the deadzone.
   */
  onFill(order: Order): void {
    const g = this.cfg.strategies.grid;
    if (!g.enabled) return;
    const price = order.fillPrice ?? order.price;
    const idx = this.findNearestLevelIndex(price);
    if (idx < 0) return;
    const levels = this.store.strategies.grid.levels;

    if (order.kind === 'GRID_BUY') {
      const target = levels[idx + 1];
      if (target) this.pendingArms.push({ side: 'SELL', refPrice: price, target });
    } else if (order.kind === 'GRID_SELL') {
      const target = levels[idx - 1];
      if (target) this.pendingArms.push({ side: 'BUY', refPrice: price, target });
    }
  }

  /**
   * Feature 2 — promote pending re-arms once price clears the anti-churn
   * deadzone (GRID_DEADZONE_STEPS × step from the ref fill price).
   */
  private processPendingArmsInternal(): void {
    if (this.pendingArms.length === 0) return;
    const g = this.cfg.strategies.grid;
    if (!g.enabled) return;
    const price = this.priceOracle.current;
    const deadzoneDist = this.deadzoneDistance();
    const stillPending: typeof this.pendingArms = [];
    for (const arm of this.pendingArms) {
      if (arm.side === 'SELL' && price >= arm.refPrice + deadzoneDist) {
        this.placeOne(arm.target.price, 'SELL', arm.target);
      } else if (arm.side === 'BUY' && price <= arm.refPrice - deadzoneDist) {
        this.placeOne(arm.target.price, 'BUY', arm.target);
      } else {
        stillPending.push(arm); // keep waiting off the fill
      }
    }
    this.pendingArms = stillPending;
  }

  private findNearestLevelIndex(price: number): number {
    const levels = this.store.strategies.grid.levels;
    if (levels.length === 0) return -1;
    let best = 0;
    for (let i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i].price - price) < Math.abs(levels[best].price - price)) best = i;
    }
    return best;
  }

  /** Public entry for the engine loop: promote any pending deadzone re-arms. */
  processPendingArms(): void {
    this.processPendingArmsInternal();
  }

  /**
   * Feature C — VOL-ADAPTIVE DEADZONE distance. The static step×deadzoneSteps
   * rule ignored tape conditions: calm markets re-armed too slowly (missed
   * waves), choppy markets too fast (double-fee whipsaw). Now the deadzone
   * shrinks in calm tape (trade sooner) and grows in chop (wait for a real
   * move): recentVolatility ~1% → ×0.84, ~5% → ×1.8, clamped [0.6, 1.8].
   */
  deadzoneDistance(): number {
    const vol = this.priceOracle.recentVolatility();
    const volFactor = Math.min(1.8, Math.max(0.6, 0.6 + (vol / 0.05) * 1.2));
    return this.step * this.cfg.strategies.grid.deadzoneSteps * volFactor;
  }
}
