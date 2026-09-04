import type { Order } from './types.js';

/**
 * Execution broker interface. Both PaperBroker (simulated fills) and LiveBroker
 * (real Jupiter swaps) implement this so strategies are strategy-agnostic.
 *
 * In PAPER mode we always use PaperBroker — no real transactions are ever sent.
 * In LIVE mode the engine constructs a LiveBroker whose every trade passes the
 * kill-switch / dry-run / mode guards in jupiter.ts before touching the network.
 */
export interface Broker {
  placeLimitOrder(order: Order): void;
  marketBuy(order: Order): void;
  marketSell(order: Order): void;
  onPriceChange(): void;
  minProfitStepUsd(price: number): number;
}
