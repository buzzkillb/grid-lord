// ---------------------------------------------------------------------------
// RE-ANCHOR CONFIRMATION + SINGLE-JUMP SANITY GATE
// ---------------------------------------------------------------------------
// Two independent defenses against a single glitchy price print re-centering
// the grid band (a structural cancel+rebuild) or being committed to the stream:
//
//   1) GRID_REANCHOR_CONFIRM_POLLS — the grid only re-anchors after the drifted
//      price persists for N consecutive polls. A one-poll glitch (e.g. the
//      ~$94.6 print on a ~$101 SOL) must not move the band.
//   2) RISK_MAX_SINGLE_JUMP_PCT — the oracle rejects a single-poll jump that
//      exceeds the configurable fraction (now 0.05 = 5% by default), keeping
//      the prior price. A ~7% glitch is now caught here.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PriceOracle, pricePassesGate } from '../src/price.js';
import { GridStrategy } from '../src/gridStrategy.js';
import { PaperBroker } from '../src/paperBroker.js';

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
    enabled: true, historyHours: 48, reanchorMinutes: 1, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 2.0,
    reanchorConfirmPolls: 3,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 20, dipPctBelowVwap: 3, enabled: true,
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

function oracle(price = 100, jupiterFresh = true): { o: PriceOracle; set: (p: number) => void } {
  const o = new PriceOracle(cfg());
  (o as any).__setPrice(price, jupiterFresh);
  return {
    o,
    set: (p: number) => (o as any).__setPrice(p, true),
  };
}

// --- pricePassesGate: the tightened single-jump guard -----------------------

test('pricePassesGate rejects a ~7% glitch on a ~$101 SOL (the reported $94.6 print)', () => {
  // At the tightened 5% cap, the 101.5 -> 94.6 move (≈6.8%) is rejected.
  assert.equal(pricePassesGate({ p: 94.6, prev: 101.5, maxSingleJumpPct: 0.05 }), false);
});

test('pricePassesGate accepts a normal in-band tick at the 5% cap', () => {
  assert.equal(pricePassesGate({ p: 102.5, prev: 101.5, maxSingleJumpPct: 0.05 }), true);
  assert.equal(pricePassesGate({ p: 99.0, prev: 102.0, maxSingleJumpPct: 0.05 }), true);
});

test('pricePassesGate boundary: just under 5% is accepted, just over is rejected', () => {
  // 101.5 * 1.049 = 106.4735 (allowed, under the 5% cap).
  assert.equal(pricePassesGate({ p: 101.5 * 1.049, prev: 101.5, maxSingleJumpPct: 0.05 }), true);
  // A hair over 5% (avoid the inexact 1.05 float boundary) is rejected.
  const over = 101.5 * 1.0501;
  assert.equal(pricePassesGate({ p: over, prev: 101.5, maxSingleJumpPct: 0.05 }), false);
});

test('pricePassesGate with default 15% still allows the old behavior when configured', () => {
  assert.equal(pricePassesGate({ p: 94.6, prev: 101.5, maxSingleJumpPct: 0.15 }), true);
});

// --- grid re-anchor confirmation streak -------------------------------------

function seededGrid(anchorPrice: number): { store: StateStore; grid: GridStrategy } {
  const store = new StateStore(cfg());
  store.price = anchorPrice;
  // Ensure a real grid sub-book exists so sellBelowCostWouldLose has a basis
  // to read (a missing/falsy book would default price-floor logic to the
  // legacy aggregate path or a no-op). Seed it with a cost below all levels.
  store.strategies.grid.subBook = { baseQty: 1, avgCostPerBase: anchorPrice - 1, realizedPnlUsd: 0, feesPaidUsd: 0 };
  const brok = new PaperBroker(cfg(), store, oracle(anchorPrice).o);
  const grid = new GridStrategy(cfg(), store, brok, oracle(anchorPrice).o);
  grid.initialize();
  // `initialize()` -> build() stamps `lastReanchorAt = now`, so the re-anchor
  // cooldown (reanchorMinutes) would block any re-anchor within the test's
  // millisecond-scale polls. Push it back so only the confirm streak is
  // exercised (we test the cooldown separately).
  (grid as any).lastReanchorAt = 0;
  return { store, grid };
}

test('grid does NOT re-anchor on a single glitchy drifted poll', () => {
  const { store, grid } = seededGrid(100);
  const before = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  // Force a single far-off poll (the $94.6 print on a ~$101 anchor).
  store.price = 94.6;
  grid.checkReanchor();
  const after = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  assert.deepEqual(after, before, 'one drifted poll must NOT re-anchor');
});

test('grid re-anchors only after the confirm-polls streak is reached', () => {
  const { store, grid } = seededGrid(100);
  const before = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  // Poll 1 + 2 drifted -> still no re-anchor.
  store.price = 94.6;
  grid.checkReanchor();
  store.price = 94.6;
  grid.checkReanchor();
  let after = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  assert.deepEqual(after, before, '2 confirm polls must NOT re-anchor (needs 3)');

  // Poll 3 reaches the configured confirm count -> re-anchors.
  store.price = 94.6;
  grid.checkReanchor();
  after = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  assert.notDeepEqual(after, before, '3rd confirm poll must re-anchor');
  // New band should now be centered lower (anchor ~94.6).
  const newAnchor = (after[0] + after[after.length - 1]) / 2;
  assert.ok(Math.abs(newAnchor - 94.6) < 6, `expected anchor near 94.6, got ${newAnchor.toFixed(2)}`);
});

test('grid resets the drift streak when price returns toward center', () => {
  const { store, grid } = seededGrid(100);
  // Two drifted polls build up the streak.
  store.price = 94.6;
  grid.checkReanchor();
  grid.checkReanchor();
  // Price returns to center -> streak resets, so no re-anchor even though we
  // would otherwise be at the confirm threshold.
  store.price = 100;
  grid.checkReanchor();
  const before = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  store.price = 94.6;
  grid.checkReanchor();
  const after = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  assert.deepEqual(after, before, 'streak must reset on returning to center');
});

// --- self-healing periodic re-arm sweep -------------------------------------

test('sweepArms re-arms a grid level that lost its resting order (self-heal)', () => {
  const { store, grid } = seededGrid(100);
  // Simulate the orphaned-exit case: an above-anchor SELL level has NO live
  // order (e.g. its re-arm was dropped / trend-suppressed during a dip).
  const levels = store.strategies.grid.levels;
  const sellLevel = levels.find((l) => l.price > 100)!;
  sellLevel.sellOrderId = undefined;
  assert.equal(sellLevel.sellOrderId, undefined, 'precondition: no sell armed');

  grid.sweepArms();
  assert.ok(sellLevel.sellOrderId, 'sweep must re-arm the orphaned SELL level');

  // The newly placed order must be a real OPEN GRID_SELL resting order.
  const placed = store.orders.find((o) => o.id === sellLevel.sellOrderId);
  assert.ok(placed, 'swept order exists in the book');
  assert.equal(placed!.side, 'SELL');
  assert.equal(placed!.status, 'OPEN');
  assert.equal(placed!.price, sellLevel.price);
});

test('sweepArms does NOT stack a second order on an already-live level', () => {
  const { store, grid } = seededGrid(100);
  const levels = store.strategies.grid.levels;
  const sellLevel = levels.find((l) => l.price > 100)!;
  const beforeCount = store.orders.length;
  grid.sweepArms();
  assert.equal(store.orders.length, beforeCount, 'no new order on already-armed level');
  assert.ok(sellLevel.sellOrderId, 'existing order preserved');
});

test('sweepArms leaves a genuinely below-cost SELL unarmed but re-arms an above-cost one', () => {
  const { store, grid } = seededGrid(100);
  const levels = store.strategies.grid.levels;
  const sells = levels.filter((l) => l.price > 100).sort((a, b) => b.price - a.price);
  const highest = sells[0];
  const lowest = sells[sells.length - 1];

  // Blocked case: set grid average cost ABOVE a given sell level. That price
  // would realize a loss, so the cost floor must keep it unarmed — even though
  // the level is above the anchor and otherwise eligible.
  store.strategies.grid.subBook.avgCostPerBase = highest.price + 0.5;
  highest.sellOrderId = undefined;
  lowest.sellOrderId = undefined;
  grid.sweepArms();
  assert.equal(highest.sellOrderId, undefined, 'below-cost SELL stays unarmed');

  // Allowed case: set grid average cost WELL BELOW all sell levels, then orphan
  // a really profitable level (highest above cost). The sweep must re-arm it.
  store.strategies.grid.subBook.avgCostPerBase = 90;
  highest.sellOrderId = undefined;
  grid.sweepArms();
  assert.ok(highest.sellOrderId, 'above-cost profitable SELL is re-armed by the sweep');
  const placed = store.orders.find((o) => o.id === highest.sellOrderId);
  assert.equal(placed!.side, 'SELL');
  assert.equal(placed!.status, 'OPEN');
});
