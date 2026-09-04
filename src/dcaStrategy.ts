import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';
import type { Broker } from './broker.js';
import { PriceOracle } from './price.js';
import type { Order } from './types.js';

/**
 * Dollar-cost averaging: buys a fixed USDC amount of SOL on an interval, but
 * only triggers early if price dips below the rolling VWAP by a threshold.
 * Reduces timing risk and smooths entry over time.
 *
 * Feature 4 — trailing take-profit leg: once price is DCA_TP_PCT above the
 * average cost, we track a trailing peak and sell a DCA_TP_SLICE_PCT slice of
 * the accumulated position when the price gives back DCA_TRAILING_PCT from that
 * peak. This ring-fences profit on the DCA book instead of riding winners all
 * the way back to breakeven.
 */
export class DcaStrategy {
  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private broker: Broker,
    private priceOracle: PriceOracle
  ) {}

  /** Check whether it's time to buy; execute a market buy if so. */
  tick(): void {
    const d = this.cfg.strategies.dca;
    if (!d.enabled) return;
    const now = Date.now();

    // Not enough price data yet
    if (this.priceOracle.current <= 0) return;

    const lastBuy = this.store.strategies.dca.lastBuyAt ?? 0;
    const intervalMs = d.intervalMinutes * 60_000;
    const due = now - lastBuy >= intervalMs;

    if (due) {
      this.executeBuy();
      return;
    }

    // Dip trigger: below VWAP by threshold, and enough time has passed since last
    const vwap = this.priceOracle.vwap;
    if (vwap > 0) {
      const dip = (this.priceOracle.current / vwap - 1) * 100;
      if (dip <= -Math.abs(d.dipPctBelowVwap) && now - lastBuy >= intervalMs / 4) {
        this.executeBuy();
        return;
      }
    }

    // Feature 4 — trailing take-profit leg (independent of the buy cadence).
    this.checkTakeProfit();
  }

  /**
   * Feature 4: sell a profitable slice when price trails back from its peak by
   * DCA_TRAILING_PCT, but only after price has first climbed DCA_TP_PCT above
   * average cost (so we never trail a position that isn't meaningfully green).
   */
  private checkTakeProfit(): void {
    const da = this.cfg.strategies.dca;
    if (!da.enabled) return;
    const price = this.priceOracle.current;

    // H3: DCA take-profit acts on the DCA SUB-BOOK (ring-fenced), not the
    // commingled aggregate. Grid buys must never arm DCA's trailing TP, and a
    // DCA slice sell never sells grid-owned lots. Once the sub-book regime is
    // active (any book exists), the dca book is authoritative even when EMPTY —
    // the aggregate fallback applies only to legacy state with no books at all.
    let heldQty = 0;
    let avgCost = 0;
    const book = this.store.strategies.dca.subBook;
    if (book || this.store.strategies.grid.subBook) {
      if (book) {
        heldQty = book.baseQty;
        avgCost = book.avgCostPerBase;
      }
    } else {
      const pos = this.store.getPosition(
        this.cfg.strategies.grid.baseAsset,
        this.cfg.strategies.grid.quoteAsset
      );
      if (!pos || pos.baseQty <= 0) return;
      heldQty = pos.baseQty;
      avgCost = pos.avgCostPerBase;
    }
    if (heldQty <= 0) return;
    if (avgCost <= 0) return;

    const s = this.store.strategies.dca;
    // Keep a running peak of the highest price we've seen.
    if (!s.peakPrice || price > s.peakPrice) s.peakPrice = price;

    const profitTrigger = avgCost * (1 + da.takeProfitPct / 100);
    if (!s.tpArmed && price >= profitTrigger) {
      s.tpArmed = true;
      s.peakPrice = price;
      console.log(`[dca] TP armed @ ${price.toFixed(2)} (avg ${avgCost.toFixed(2)})`);
    }

    if (!s.tpArmed) return;

    // COOLDOWN: after a take-profit slice sell, wait tpCooldownMinutes before
    // selling again. This stops rapid re-drain when price oscillates around the
    // trail-back level right after a sell resets the trailing peak — the peak
    // would otherwise instantly re-arm and bleed another slice on the next dip.
    if (da.tpCooldownMinutes > 0 && s.lastTpAt) {
      const sinceTp = Date.now() - s.lastTpAt;
      if (sinceTp < da.tpCooldownMinutes * 60_000) return;
    }

    const trailBack = s.peakPrice! * (1 - da.trailingPct / 100);
    // PROFIT FLOOR (correctness): the whole point of a take-profit is to bank
    // a gain. If the trailing distance (DCA_TRAILING_PCT) is larger than the
    // arm threshold (DCA_TP_PCT) — e.g. arm +0.6%, trail 4% — the raw trail-back
    // level can fall BELOW cost and we'd "take profit" by selling at a loss.
    // Clamp the sell level so it never goes under the original profit trigger:
    // we give back at most [trailing distance], but never more than the profit
    // we set out to capture. Confirmed: with TP 0.6% / trail 4%, the old math
    // sold at -3.4% vs cost; this floor sells at +0.6% instead.
    const sellAt = Math.max(trailBack, profitTrigger);
    if (price <= sellAt) {
      this.sellProfitableSlice(heldQty);
    }
  }

  /** Sell a configured slice of the held position (market order). */
  private sellProfitableSlice(heldQty: number): void {
    const da = this.cfg.strategies.dca;
    const price = this.priceOracle.current;
    const slice = Math.min(heldQty, (heldQty * da.takeProfitSlicePct) / 100);
    if (slice <= 0) return;

    const order: Order = {
      id: this.store.newOrderId(),
      kind: 'DCA_SELL',
      side: 'SELL',
      price,
      baseQty: slice,
      quoteQty: price * slice,
      status: 'OPEN',
      createdAt: Date.now(),
      mode: 'paper',
      strategyId: 'dca',
      note: 'dca trailing take-profit slice',
    };

    this.broker.marketSell(order);
    this.store.strategies.dca.lastTpAt = Date.now();
    // Reset the trailing state so the next run starts fresh after re-accumulation.
    delete this.store.strategies.dca.tpArmed;
    delete this.store.strategies.dca.peakPrice;
    console.log(
      `[dca] take-profit: sold ${slice.toFixed(4)} SOL @ $${price.toFixed(2)} (trail $${this.cfg.strategies.dca.trailingPct}%)`
    );
  }

  private executeBuy(): void {
    const d = this.cfg.strategies.dca;
    const price = this.priceOracle.current;

    // Feature 1 — value averaging. Follow a target SOL position path over the
    // horizon: buy MORE when you're behind (cheap entry), buy LESS when ahead.
    // Falls back to the fixed usdcAmountPerBuy when VA is disabled.
    let amount = d.usdcAmountPerBuy;
    if (d.vaEnabled) {
      const s = this.store.strategies.dca;
      const buys = (s.buys ?? 0) + 1; // this buy is the `buys+1`th
      const progress = Math.min(1, buys / Math.max(1, d.vaHorizonBuys));
      const targetQty = d.vaTargetSol * progress;
      const pos = this.store.getPosition(
        this.cfg.strategies.grid.baseAsset,
        this.cfg.strategies.grid.quoteAsset
      );
      const heldQty = pos && pos.baseQty > 0 ? pos.baseQty : 0;
      const desiredQty = Math.max(0, targetQty - heldQty);
      const desiredUsd = desiredQty * price;
      // Clamp VA size to [0.25x, 3x] of the fixed amount so one missed cycle
      // can't front-load the whole basket.
      const lo = d.usdcAmountPerBuy * 0.25;
      const hi = d.usdcAmountPerBuy * 3;
      amount = Math.max(lo, Math.min(hi, desiredUsd));
    }

    // DEPLOYMENT-CAP GUARD: never let DCA deploy USDC beyond RISK_MAX_USDC.
    // Grid arms are already gated per-level, but DCA period/dip/VA buys bypass
    // the grid cap check — a long bull/bear grind with recurring buys could
    // otherwise size past the agreed deployment ceiling. Compute the headroom
    // against totalDeployedUsd (resting grid buys + held SOL at cost) and the
    // live USDC balance, and shrink (or skip) a buy that would overshoot.
    const deployed = this.store.totalDeployedUsd();
    const capHeadroom = this.cfg.risk.maxUsdcPosition - deployed;
    const usdcAvailable = this.store.account.balances.USDC ?? 0;
    // Smallest of: cap headroom, available USDC (minus fee buffer), original size.
    const affordable = Math.min(amount, Math.max(0, capHeadroom), Math.max(0, usdcAvailable - amount * 0.001));
    if (affordable < d.usdcAmountPerBuy * 0.25) {
      console.warn(
        `[dca] buy skipped: deployed ${deployed.toFixed(2)} + would-buy ${amount.toFixed(2)} ` +
          `exceeds cap ${this.cfg.risk.maxUsdcPosition.toFixed(2)} (headroom ${capHeadroom.toFixed(2)})`
      );
      this.store.strategies.dca.lastBuyAt = Date.now(); // don't retry-fail every poll
      return;
    }
    // Shrink gracefully toward the headroom instead of skipping outright.
    amount = Math.min(amount, affordable, capHeadroom);
    if (amount <= 0) {
      this.store.strategies.dca.lastBuyAt = Date.now();
      return;
    }

    // FEE-AWARE MIN-BUY GUARD: a DCA buy pays a near-constant on-chain fee, so
    // a micro-buy (esp. a tiny value-average increment, or a headroom-shrunk
    // one) spends more on fees than the intended margin. Bump any sub-floor
    // notional up to the configured minimum (subject to cap) instead of firing
    // a fee-bleeding micro-order. If even the floor won't fit, defer.
    const minBuy = d.minBuyUsd ?? 0;
    if (minBuy > 0 && amount < minBuy) {
      const bumped = Math.min(minBuy, capHeadroom);
      if (bumped < Math.min(minBuy, d.usdcAmountPerBuy * 0.5)) {
        // Not enough room for a meaningful buy — defer rather than bleed fees.
        this.store.strategies.dca.lastBuyAt = Date.now();
        return;
      }
      amount = bumped;
    }

    const baseQty = amount / price;

    const order: Order = {
      id: this.store.newOrderId(),
      kind: 'DCA_BUY',
      side: 'BUY',
      price,
      baseQty,
      quoteQty: amount,
      status: 'OPEN',
      createdAt: Date.now(),
      mode: 'paper',
      strategyId: 'dca',
      note: d.vaEnabled ? 'dca value-average buy' : 'dca period/dip buy',
    };

    this.broker.marketBuy(order);
    this.store.strategies.dca.lastBuyAt = Date.now();
    this.store.strategies.dca.buys = (this.store.strategies.dca.buys ?? 0) + 1;
  }
}
