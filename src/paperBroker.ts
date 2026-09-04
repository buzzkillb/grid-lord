import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';
import { PriceOracle } from './price.js';
import type { Order, Trade, Position } from './types.js';
import type { Broker } from './broker.js';

/**
 * Simulates a broker for paper mode. Fills limit orders when price crosses
 * their level, applies realistic on-chain fees, and maintains positions with
 * realized PnL accounting. No real funds are moved.
 */
export class PaperBroker implements Broker {
  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private priceOracle: PriceOracle
  ) {}

  /** Estimated round-trip fee for a trade (tip + priority + router), in USD. */
  private feeUsd(quoteQty: number): number {
    // Conservative on-chain fee for a swap of this size, in USD.
    const fixed = 0.002; // priority + jito tip in SOL ~ $0.16-0.4; use conservative USD
    return fixed + quoteQty * 0.001; // 0.1% routing/slippage buffer
  }

  /**
   * Minimum grid step (in price units) that still clears a full round trip
   * (buy a level, sell it back) after network + routing fees. Levels spaced any
   * tighter than this would bleed money to fees on every captured wave.
   */
  minProfitStepUsd(price: number): number {
    const levelNotional = this.levelValueUsd();
    const levelQty = levelNotional / price;
    const roundTripFee = 2 * this.feeUsd(levelNotional);
    // profit per round trip = step * qty ; require > roundTripFee
    if (levelQty <= 0) return 0;
    return (roundTripFee / levelQty) * 1.2; // 20% margin so we actually profit
  }

  /** Notional USD allocated to one grid level (mirrors gridStrategy.levelUsd). */
  private levelValueUsd(): number {
    const perLevel = this.cfg.strategies.grid.usdcPerGrid || 20;
    return perLevel;
  }

  /**
   * Place a limit order in paper mode. If the price already satisfies the
   * trigger, it fills immediately; otherwise it sits OPEN until checked.
   */
  placeLimitOrder(order: Order): void {
    const price = this.priceOracle.current;
    if (order.side === 'BUY' && price <= order.price) {
      this.fillOrder(order, price);
    } else if (order.side === 'SELL' && price >= order.price) {
      this.fillOrder(order, price);
    } else {
      this.store.upsertOrder(order); // stays open
    }
  }

  /** Execute a market order immediately at current price (used by DCA). */
  marketBuy(order: Order): void {
    this.fillOrder(order, this.priceOracle.current);
  }

  /** Execute a market SELL immediately at current price (used by DCA take-profit). */
  marketSell(order: Order): void {
    this.fillOrder(order, this.priceOracle.current);
  }

  /**
   * Called on each price tick. Fills any OPEN orders whose trigger is crossed.
   */
  onPriceChange(): void {
    const price = this.priceOracle.current;
    for (const order of this.store.orders) {
      if (order.status !== 'OPEN') continue;
      if (order.side === 'BUY' && price <= order.price) {
        this.fillOrder(order, order.price);
      } else if (order.side === 'SELL' && price >= order.price) {
        this.fillOrder(order, order.price);
      }
    }
  }

  private fillOrder(order: Order, fillPrice: number): void {
    const fee = this.feeUsd(order.quoteQty);
    const receivedBase = order.baseQty;

    // BALANCE GUARD (correctness): never let a BUY fill below the required
    // quote + fee. If we can't afford it here (shouldn't happen because the
    // grid/DCA cap deployments, but belt-and-suspenders), keep it OPEN.
    if (order.side === 'BUY') {
      const cost = order.quoteQty + fee;
      if (this.store.account.balances.USDC < cost) {
        console.warn(
          `[broker] skipping BUY ${order.price.toFixed(2)}: need ${cost.toFixed(2)} USDC, have ${this.store.account.balances.USDC.toFixed(2)}`
        );
        return; // leave order OPEN; it may become affordable or get cancelled on re-anchor
      }
    } else {
      // SELL BALANCE GUARD (M3): never let a SELL reduce the held SOL below 0.
      // Grid + DCA share the SOL/USDC position, so a stale or racing order could
      // otherwise drive SOL negative and corrupt PnL. Refuse the fill instead.
      if (this.store.account.balances.SOL < receivedBase - 1e-12) {
        console.warn(
          `[broker] skipping SELL ${order.price.toFixed(2)}: need ${receivedBase.toFixed(4)} ` +
            `SOL, have ${this.store.account.balances.SOL.toFixed(4)}`
        );
        return; // leave order OPEN
      }
    }

    const spentQuote = order.quoteQty;

    // RING-FENCED SUB-BOOK (H3): grid and dca fills also update that strategy's
    // own ledger so per-strategy decisions read per-strategy capital. Meme
    // slots keep their existing dedicated ring-fenced state (applyMemeFill /
    // meme.ts paper path) — untouched here.
    const isSubBooked = order.strategyId === 'grid' || order.strategyId === 'dca';
    const book = isSubBooked ? this.store.subBook(order.strategyId as 'grid' | 'dca') : undefined;

    // Update balances & position
    if (order.side === 'BUY') {
      // cost = quoteQty + fee
      const cost = spentQuote + fee;
      const pos = this.ensurePosition();
      const newBase = pos.baseQty + receivedBase;
      const newCost = pos.baseQty * pos.avgCostPerBase + cost;
      pos.baseQty = newBase;
      pos.avgCostPerBase = newCost / newBase;
      pos.quoteQty = pos.quoteQty - spentQuote - fee;
      this.store.account.balances.USDC -= spentQuote + fee;
      this.store.account.balances.SOL += receivedBase;
      this.store.account.openQty += receivedBase;
      if (book) {
        const bBase = book.baseQty + receivedBase;
        const bCost = book.baseQty * book.avgCostPerBase + cost;
        book.baseQty = bBase;
        book.avgCostPerBase = bCost / bBase;
        book.feesPaidUsd += fee;
      }
    } else {
      // Realized PnL = (fillPrice - avgCost) * baseQty
      const pos = this.ensurePosition();
      const realized = (fillPrice - pos.avgCostPerBase) * receivedBase - fee;
      const beforeQty = pos.baseQty;
      pos.baseQty -= receivedBase;
      // Remaining cost basis shrinks PROPORTIONALLY to the shares sold, so the
      // average cost of the remaining position is preserved across a partial
      // sell. (Both an add-proceeds and a subtract-fee approach here corrupt
      // avgCostPerBase.) Only USD cash receives the fill proceeds, fees once.
      if (beforeQty > 0 && pos.baseQty > 0) {
        pos.quoteQty *= pos.baseQty / beforeQty;
      } else {
        pos.quoteQty = 0;
      }
      this.store.account.balances.SOL -= receivedBase;
      this.store.account.balances.USDC += fillPrice * receivedBase - fee;
      this.store.account.openQty -= receivedBase;
      this.store.account.realizedPnlUsd += realized;
      if (book) {
        const bRealized = (fillPrice - book.avgCostPerBase) * receivedBase - fee;
        book.baseQty = Math.max(0, book.baseQty - receivedBase);
        // Average cost is INVARIANT on a partial sell (same rule as the
        // aggregate position): the strategy keeps its remaining lots at the
        // same per-unit basis; only the quantity shrinks.
        book.realizedPnlUsd += bRealized;
        book.feesPaidUsd += fee;
      }

      const trade = this.makeTrade(order, 'SELL', fillPrice, receivedBase, fee, realized);
      this.store.recordTrade(trade);
    }

    if (order.side === 'BUY') {
      const trade = this.makeTrade(order, 'BUY', fillPrice, receivedBase, fee);
      this.store.recordTrade(trade);
    }

    this.store.upsertPosition(this.ensurePosition());

    // Mark order filled
    order.status = 'FILLED';
    order.filledAt = Date.now();
    order.fillPrice = fillPrice;
    this.store.upsertOrder(order);
  }

  private ensurePosition(): Position {
    const g = this.cfg.strategies.grid;
    let pos = this.store.getPosition(g.baseAsset, g.quoteAsset);
    if (!pos) {
      pos = {
        baseAsset: g.baseAsset,
        quoteAsset: g.quoteAsset,
        baseQty: 0,
        quoteQty: this.store.account.balances.USDC,
        avgCostPerBase: 0,
      };
      this.store.upsertPosition(pos);
    }
    return pos;
  }

  private makeTrade(
    order: Order,
    direction: 'BUY' | 'SELL',
    price: number,
    baseQty: number,
    feeUsd: number,
    realizedPnlUsd?: number
  ): Trade {
    return {
      id: this.store.newOrderId(),
      orderId: order.id,
      strategyId: order.strategyId,
      direction,
      price,
      baseQty,
      quoteQty: price * baseQty,
      feeUsd,
      realizedPnlUsd,
      ts: Date.now(),
      mode: 'paper',
    };
  }
}
