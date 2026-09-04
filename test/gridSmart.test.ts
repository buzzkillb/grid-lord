// ---------------------------------------------------------------------------
// SMART-ALGO FEATURES (A/C/D) — anchor-weighted ladder, vol-adaptive deadzone,
// fee-market priority level
// ---------------------------------------------------------------------------
//   A: ladder gaps GROW with distance from the anchor (denser where fills
//      happen), every gap >= fee-floor step, K=0 reproduces an even ladder.
//   C: deadzone shrinks in calm tape, grows in chop, clamped [0.6, 1.8]×.
//   D: priority level follows the live fee market (median-based), cached 60s,
//      RPC failure falls back to 'medium'.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PriceOracle } from '../src/price.js';
import { GridStrategy } from '../src/gridStrategy.js';
import { PaperBroker } from '../src/paperBroker.js';
import { JupiterExec } from '../src/jupiter.js';

process.env.NODE_ENV = 'test';
process.env.STATE_PERSIST = '0';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 1026, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.15,
};
const strategies: StrategyConfig = {
  grid: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    lowerPrice: 99, upperPrice: 115, numLevels: 8, usdcPerGrid: 32,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 2.0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 20, dipPctBelowVwap: 3, enabled: true,
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

/** Inject a synthetic candle set so recentVolatility() returns a known CV. */
function setCandles(oracle: PriceOracle, vol: number, price = 105): void {
  const halfSpread = price * vol;
  const candles = Array.from({ length: 14 }, (_, i) => ({
    ts: Date.now() - (13 - i) * 60_000,
    open: i % 2 === 0 ? price - halfSpread : price + halfSpread,
    high: price + halfSpread,
    low: price - halfSpread,
    close: i % 2 === 0 ? price + halfSpread : price - halfSpread,
    volume: 0,
  }));
  (oracle as unknown as { candles: typeof candles }).candles = candles;
}

function rig(price = 105): { store: StateStore; oracle: PriceOracle; grid: GridStrategy; broker: PaperBroker } {
  const c = cfg();
  const store = new StateStore(c);
  store.price = price; // initialize() reads the store, not the oracle
  const oracle = new PriceOracle(c);
  oracle.__setPrice(price, true);
  setCandles(oracle, 0.005, price);
  const broker = new PaperBroker(c, store, oracle);
  const grid = new GridStrategy(c, store, broker, oracle);
  return { store, oracle, grid, broker };
}

test('A: weighted ladder is denser near the anchor, gaps >= fee floor', () => {
  delete process.env.GRID_LADDER_WEIGHT_K;
  const { store, grid, broker } = rig(105);
  grid.initialize();

  const prices = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
  assert.ok(prices.length >= 7, `ladder built (${prices.length} levels)`);

  // Gap structure: V-shape around the anchor — gaps SHRINK toward the anchor
  // from below, then GROW above it (denser where fills actually happen).
  const gaps: number[] = [];
  for (let i = 1; i < prices.length; i++) gaps.push(+(prices[i] - prices[i - 1]).toFixed(6));
  const mid = Math.floor(gaps.length / 2);
  for (let i = 1; i <= mid; i++) {
    assert.ok(gaps[i] <= gaps[i - 1] + 1e-6,
      `below-anchor gaps must shrink toward anchor: ${gaps.join(', ')}`);
  }
  for (let i = mid + 1; i < gaps.length; i++) {
    assert.ok(gaps[i] >= gaps[i - 1] - 1e-6,
      `above-anchor gaps must grow away from anchor: ${gaps.join(', ')}`);
  }
  // Inner (tightest, adjacent-to-anchor) gap must clear the fee floor.
  const minStep = broker.minProfitStepUsd(105);
  const inner = Math.min(...gaps);
  assert.ok(inner >= minStep - 1e-6, `inner gap ${inner} < fee floor ${minStep}`);
  // Weighted band is denser near the anchor than even spacing:
  // inner gap < average gap.
  const avg = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  assert.ok(inner < avg * 0.95, `inner ${inner} should be tighter than avg ${avg.toFixed(3)}`);
});

test('A: K=0 reproduces the even ladder', () => {
  process.env.GRID_LADDER_WEIGHT_K = '0';
  try {
    const { store, grid } = rig(105);
    grid.initialize();
    const prices = store.strategies.grid.levels.map((l) => l.price).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < prices.length; i++) gaps.push(+(prices[i] - prices[i - 1]).toFixed(6));
    const spread = Math.max(...gaps) - Math.min(...gaps);
    assert.ok(spread < 0.01, `K=0 must be even, spread=${spread}`);
  } finally {
    delete process.env.GRID_LADDER_WEIGHT_K;
  }
});

test('C: deadzone adapts to volatility and clamps', () => {
  const { oracle, grid } = rig(105);
  grid.initialize();
  const base = (grid as unknown as { step: number }).step * 0.5; // × deadzoneSteps

  setCandles(oracle, 0.005); // calm: factor 0.6 + (0.005/0.05)*1.2 = 0.72
  const calm = grid.deadzoneDistance();
  setCandles(oracle, 0.06); // choppy: clamped 1.8
  const chop = grid.deadzoneDistance();
  assert.ok(chop > calm, `choppy ${chop} must exceed calm ${calm}`);

  // Clamp bounds: factor stays within [0.6, 1.8] × step × deadzoneSteps.
  setCandles(oracle, 0.0001);
  const low = grid.deadzoneDistance();
  assert.ok(low >= base * 0.6 - 1e-9 && low <= base * 0.7 + 1e-9,
    `near-zero vol pins the lower clamp: ${low} vs base ${base}`);
  setCandles(oracle, 0.5);
  const high = grid.deadzoneDistance();
  assert.ok(Math.abs(high - base * 1.8) < base * 0.02,
    `extreme vol pins the upper clamp: ${high} vs ${base * 1.8}`);
});

test('D: fee level maps medians to low/medium/high and caches 60s', async () => {
  const jup = new JupiterExec(cfg());
  let calls = 0;
  (jup as unknown as { conn: unknown }).conn = {
    getRecentPrioritizationFees: async () => {
      calls++;
      return [{ prioritizationFee: 2_000 }, { prioritizationFee: 3_000 }, { prioritizationFee: 4_000 }];
    },
  };
  const internal = jup as unknown as {
    priorityFeeLevel(): Promise<'low' | 'medium' | 'high'>;
    feeLevelCache: { level: string; at: number } | null;
  };

  assert.equal(await internal.priorityFeeLevel(), 'low', 'median 3000 <= 5000 -> low');
  assert.equal(await internal.priorityFeeLevel(), 'low', 'second call within 60s cached');
  assert.equal(calls, 1, 'RPC hit exactly once thanks to cache');

  // High congestion.
  (jup as unknown as { conn: unknown }).conn = {
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 120_000 }],
  };
  internal.feeLevelCache = null;
  assert.equal(await internal.priorityFeeLevel(), 'high', 'median 120k >= 50k -> high');

  // RPC failure -> medium fallback.
  (jup as unknown as { conn: unknown }).conn = {
    getRecentPrioritizationFees: async () => { throw new Error('rpc down'); },
  };
  internal.feeLevelCache = null;
  assert.equal(await internal.priorityFeeLevel(), 'medium', 'failure falls back to medium');
});
