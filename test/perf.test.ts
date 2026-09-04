// ---------------------------------------------------------------------------
// PERFORMANCE TELEMETRY (B) — measurement-only 24h rolling stats
// ---------------------------------------------------------------------------
// Verifies computePerf book stats (realized, fees, net, win rate, profit
// factor, fills/hour) and band occupancy edges, derived purely from recorded
// trades + live level state. These numbers drive NO trading decisions — they
// are the evidence base for tuning after live data accumulates.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import type { Trade, Order } from '../src/types.js';

process.env.NODE_ENV = 'test';
process.env.STATE_PERSIST = '0';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 400, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.15,
};
const strategies: StrategyConfig = {
  grid: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    lowerPrice: 99, upperPrice: 115, numLevels: 8, usdcPerGrid: 10,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 2.0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 10, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 1, vaHorizonBuys: 30,
  },
  memes: [],
};
const cfg = (): AppConfig => ({
  mode: 'paper', rpcUrl: 'https://api.mainnet-beta.solana.com',
  jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
  refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
  birdeyeApiKey: 'test', strategies, risk,
});

function trade(p: Partial<Trade>): Trade {
  return {
    id: 't', orderId: 'o', strategyId: 'grid', direction: 'BUY',
    price: 105, baseQty: 0.1, quoteQty: 10.5, feeUsd: 0.01, ts: Date.now(),
    mode: 'paper', ...p,
  };
}

test('perf books: realized, fees, net, win rate, profit factor from real trades', () => {
  const store = new StateStore(cfg());
  store.recordTrade(trade({ strategyId: 'grid', direction: 'SELL', realizedPnlUsd: 0.30, feeUsd: 0.02 }));
  store.recordTrade(trade({ strategyId: 'grid', direction: 'SELL', realizedPnlUsd: -0.10, feeUsd: 0.02 }));
  store.recordTrade(trade({ strategyId: 'grid', direction: 'BUY', feeUsd: 0.01 })); // buys count as fills+fees only
  store.recordTrade(trade({ strategyId: 'dca', direction: 'SELL', realizedPnlUsd: 0.50, feeUsd: 0.03 }));

  const snap = store.snapshot(cfg());
  const grid = snap.perf.books.find((b) => b.strategyId === 'grid')!;
  const dca = snap.perf.books.find((b) => b.strategyId === 'dca')!;

  assert.ok(grid, 'grid book present');
  assert.ok(Math.abs(grid.realizedPnlUsd - 0.20) < 1e-9, `realized=${grid.realizedPnlUsd}`);
  assert.ok(Math.abs(grid.feesUsd - 0.05) < 1e-9, `fees=${grid.feesUsd}`);
  assert.ok(Math.abs(grid.netPnlUsd - 0.15) < 1e-9, `net=${grid.netPnlUsd}`);
  assert.equal(grid.fills, 3);
  assert.ok(grid.fillsPerHour > 0, 'fills/hour computed');
  assert.equal(grid.winRate, 0.5);
  assert.ok(Math.abs(grid.avgWinUsd - 0.30) < 1e-9);
  assert.ok(Math.abs(grid.avgLossUsd - -0.10) < 1e-9);
  assert.ok(Math.abs(grid.profitFactor - 3) < 1e-9, `pf=${grid.profitFactor}`); // 0.30/0.10

  assert.ok(Math.abs(dca.netPnlUsd - 0.47) < 1e-9);
  assert.equal(dca.profitFactor, Infinity, 'no losses -> PF ∞');

  // Sorted best-net first.
  assert.equal(snap.perf.books[0].strategyId, 'dca');

  // Multi-window: recent trades appear identically in 7d and all-time windows.
  assert.deepEqual(snap.perf.books7d, snap.perf.books);
  assert.deepEqual(snap.perf.booksAll, snap.perf.books);
});

test('perf band: accumulated occupancy + persisted counters', () => {
  const store = new StateStore(cfg());
  store.strategies.grid.levels = [100, 102, 104, 106].map((price) => ({
    price, buyOrderId: undefined, sellOrderId: undefined, baseQty: 0.1,
  }));

  store.price = 103;
  let snap = store.snapshot(cfg());
  assert.equal(snap.perf.band.lower, 100);
  assert.equal(snap.perf.band.upper, 106);
  assert.equal(snap.perf.band.insidePct, 1); // 1/1 samples inside

  store.price = 110; // outside
  snap = store.snapshot(cfg());
  assert.equal(snap.perf.band.insidePct, 0.5); // 1/2 accumulated
  assert.equal(snap.perf.band.samples, 2);

  store.price = 112; // outside again
  snap = store.snapshot(cfg());
  assert.ok(Math.abs(snap.perf.band.insidePct - 1 / 3) < 1e-9);
  assert.equal(snap.perf.band.samples, 3);

  // Empty ladder -> edges zero, but accumulated counters persist (history is
  // not erased just because the band is temporarily unarmed).
  store.strategies.grid.levels = [];
  snap = store.snapshot(cfg());
  assert.equal(snap.perf.band.lower, 0);
  assert.equal(snap.perf.band.samples, 3);

  // Counters survive a persist/restore round-trip.
  const payload = store['persistedPayload']();
  assert.equal(payload.bandSamples, 3);
  assert.equal(payload.bandInside, 1);
});

test('perf: 24h window excludes old trades; empty window yields empty books', () => {
  const store = new StateStore(cfg());
  store.recordTrade(trade({ strategyId: 'grid', ts: Date.now() - 25 * 3600_000 }));
  let snap = store.snapshot(cfg());
  assert.equal(snap.perf.books.length, 0, 'aged-out trades excluded');

  snap = store.snapshot(cfg());
  assert.deepEqual(snap.perf.books, []);
  assert.ok(Number.isFinite(snap.perf.band.lower));
});

test('perf orders are ignored (only trades matter) — order objects do not crash', () => {
  const store = new StateStore(cfg());
  const o: Order = {
    id: 'x', kind: 'GRID_BUY', side: 'BUY', price: 100, baseQty: 0.1,
    quoteQty: 10, status: 'OPEN', createdAt: Date.now(), mode: 'paper',
    strategyId: 'grid',
  };
  store.orders.push(o);
  const snap = store.snapshot(cfg());
  assert.deepEqual(snap.perf.books, []);
});
