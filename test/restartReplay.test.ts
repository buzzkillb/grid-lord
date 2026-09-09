// ---------------------------------------------------------------------------
// RESTART: PERSISTED FILLS MUST NOT BE REPLAYED
// ---------------------------------------------------------------------------
// StateStore.loadPersisted() restores the order book from .botstate, including
// historical FILLED orders. The engine's `gridHandled` set starts empty, so
// without seeding it every restored fill looks brand new on the first tick and
// is pushed through grid.onFill(), queuing pending re-arms keyed to the OLD
// fill price against the freshly rebuilt ladder. Those re-arms then fire as
// soon as price is one deadzone past the stale fill, placing orders nothing
// asked for. Fills that happen after the restart must still be handled.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PriceOracle } from '../src/price.js';
import { StrategyEngine } from '../src/engine.js';
import type { Order } from '../src/types.js';

process.env.NODE_ENV = 'test';
process.env.STATE_PERSIST = '0';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 1026, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.05,
};
const strategies: StrategyConfig = {
  grid: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    lowerPrice: 99, upperPrice: 115, numLevels: 8, usdcPerGrid: 32,
    enabled: true, historyHours: 48, reanchorMinutes: 240, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 2.0,
    reanchorConfirmPolls: 3,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 20, dipPctBelowVwap: 3, enabled: false,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 1, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(): AppConfig {
  return {
    mode: 'paper', rpcUrl: 'https://api.mainnet-beta.solana.com', jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

/** Oracle pinned to a price; fetchNow() is stubbed so no network is touched. */
function oracle(price: number): { o: PriceOracle; set: (p: number) => void } {
  const o = new PriceOracle(cfg());
  const set = (p: number) => (o as any).__setPrice(p, true);
  set(price);
  (o as any).fetchNow = async () => o.current;
  return { o, set };
}

test('restart: a persisted FILLED grid order is not replayed through grid.onFill', async () => {
  const c = cfg();
  const store = new StateStore(c);

  // What loadPersisted() would have restored: a grid buy that filled before
  // the restart, whose replacement sell was already placed back then.
  const stale: Order = {
    id: 'persisted-fill', kind: 'GRID_BUY', side: 'BUY', price: 99, baseQty: 0.3, quoteQty: 29.7,
    status: 'FILLED', createdAt: Date.now() - 60_000, filledAt: Date.now() - 30_000, fillPrice: 99,
    mode: 'paper', strategyId: 'grid',
  };
  store.orders.unshift(stale);

  const { o, set } = oracle(100);
  const engine = new StrategyEngine(c, store, o);
  const grid = (engine as any).grid;
  const seen: string[] = [];
  const realOnFill = grid.onFill.bind(grid);
  grid.onFill = (order: Order) => { seen.push(order.id); realOnFill(order); };

  await engine.tick();

  assert.ok(!seen.includes('persisted-fill'), 'persisted fill was replayed through grid.onFill');
  assert.equal(grid.pendingArms.length, 0, 'stale fill queued a pending re-arm');

  // A fill that happens AFTER the restart is still handled normally.
  const buy = store.orders.find((x) => x.status === 'OPEN' && x.kind === 'GRID_BUY');
  assert.ok(buy, 'grid did not arm any buy after initializing');
  set(buy.price - 0.01);
  await engine.tick();

  assert.equal(buy.status, 'FILLED');
  assert.ok(seen.includes(buy.id), 'live fill was not handed to grid.onFill');
  assert.equal(grid.pendingArms.length, 1, 'live fill did not queue its replacement re-arm');
});
