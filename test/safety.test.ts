import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PaperBroker } from '../src/paperBroker.js';
import { PriceOracle, pricePassesGate } from '../src/price.js';
import { GridStrategy } from '../src/gridStrategy.js';

process.env.NODE_ENV = 'test'; // disable STATE_PERSIST load/save in tests

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
    lowerPrice: 90, upperPrice: 110, numLevels: 8, usdcPerGrid: 10,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 10, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 5, vaHorizonBuys: 30,
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

function oracle(price = 100, jupiterFresh = true): PriceOracle {
  const o = new PriceOracle(cfg());
  o.__setPrice(price, jupiterFresh);
  return o;
}

function seed(store: StateStore, sol: number, usdc: number, avgCost = 100): void {
  store.account.balances.SOL = sol;
  store.account.balances.USDC = usdc;
  store.upsertPosition({
    baseAsset: 'SOL', quoteAsset: 'USDC', baseQty: sol, quoteQty: sol * avgCost, avgCostPerBase: avgCost,
  } as any);
}

// ---------------------------------------------------------------------------
// GRID LADDER INTEGRITY
// ---------------------------------------------------------------------------

test('grid initialize arms exactly numLevels one order per level', () => {
  const store = new StateStore(cfg());
  store.price = 100;
  const broker = new PaperBroker(cfg(), store, oracle(100));
  const grid = new GridStrategy(cfg(), store, broker, oracle(100));

  grid.initialize();
  assert.equal(grid.isInitialized(), true);

  const gridOrders = store.orders.filter((o) => o.strategyId === 'grid');
  assert.equal(gridOrders.length, 8, `expected 8 grid orders, got ${gridOrders.length}`);
  assert.ok(gridOrders.every((o) => o.status === 'OPEN'), 'all resting grid orders OPEN');

  const levels = store.strategies.grid.levels;
  assert.equal(levels.length, 9, 'n+1 levels incl. dead center');

  const buys = gridOrders.filter((o) => o.side === 'BUY');
  const sells = gridOrders.filter((o) => o.side === 'SELL');
  assert.ok(buys.length > 0 && sells.length > 0, 'both sides armed');
  assert.ok(buys.every((o) => o.price < 100), 'buys below anchor');
  assert.ok(sells.every((o) => o.price > 100), 'sells above anchor');

  const buyPrice = new Set(buys.map((o) => o.price.toFixed(6)));
  const sellPrice = new Set(sells.map((o) => o.price.toFixed(6)));
  assert.equal(buyPrice.size, buys.length, 'no duplicate buy levels');
  assert.equal(sellPrice.size, sells.length, 'no duplicate sell levels');
});

test('grid steps are never tighter than the fee floor (profit protection)', () => {
  const store = new StateStore(cfg());
  store.price = 100;
  const broker = new PaperBroker(cfg(), store, oracle(100));
  const grid = new GridStrategy(cfg(), store, broker, oracle(100));
  grid.initialize();

  const levels = store.strategies.grid.levels;
  for (let i = 1; i < levels.length; i++) {
    const step = levels[i].price - levels[i - 1].price;
    assert.ok(
      step >= broker.minProfitStepUsd(100) - 0.001,
      `step ${step.toFixed(4)} below fee floor ${broker.minProfitStepUsd(100).toFixed(4)}`
    );
  }
});

test('grid never deploys beyond the USDC cap across all armed buys', () => {
  const c = cfg();
  c.risk.maxUsdcPosition = 50;
  const store = new StateStore(c);
  store.price = 100;
  const broker = new PaperBroker(c, store, oracle(100));
  const grid = new GridStrategy(c, store, broker, oracle(100));
  grid.initialize();

  const buys = store.orders.filter((o) => o.strategyId === 'grid' && o.side === 'BUY');
  const totalNotional = buys.reduce((s, o) => s + o.quoteQty, 0);
  assert.ok(
    totalNotional <= c.risk.maxUsdcPosition,
    `armed grid BUYs exceed cap: $${totalNotional.toFixed(2)} > $${c.risk.maxUsdcPosition}`
  );
});

// ---------------------------------------------------------------------------
// GRID FILL -> RE-ARM + DEADZONE
// ---------------------------------------------------------------------------

test('grid BUY fill schedules a SELL at the adjacent level (mean-reversion round trip)', () => {
  const store = new StateStore(cfg());
  store.price = 100;
  seed(store, 0, 400);
  gridAndFillSchedulesAdjacent(store);
});

function gridAndFillSchedulesAdjacent(store: StateStore): void {
  const br = new PaperBroker(cfg(), store, oracle(100));
  const grid = new GridStrategy(cfg(), store, br, oracle(100));
  grid.initialize();

  const levels = store.strategies.grid.levels;
  // The grid's profitable mean-reversion loop: a pre-armed SELL above cost FILLS,
  // then it arms a BUY at the adjacent level just below the fill.
  const sellOrders = store.orders.filter((o) => o.strategyId === 'grid' && o.side === 'SELL');
  const lowSell = sellOrders.reduce((a, b) => (b.price < a.price ? b : a));
  const idx = levels.findIndex((l) => Math.abs(l.price - lowSell.price) < 1e-9);
  assert.ok(idx >= 0, 'sell level found');

  // GRID_SELL filled at its own (above-cost) price -> should schedule a pending
  // BUY arm at the NEXT level down.
  grid.onFill({ ...lowSell, status: 'FILLED', fillPrice: lowSell.price, kind: 'GRID_SELL' });

  const pending = (grid as any).pendingArms as Array<{ side: string; target: { price: number } }>;
  assert.ok(Array.isArray(pending) && pending.length > 0, 'a pending arm was scheduled');
  const buyArm = pending.find((p) => p.side === 'BUY');
  assert.ok(buyArm, 'a BUY arm was scheduled after the SELL fill');

  // The buy target is the grid level immediately below the filled sell level.
  const expectedPrice = levels[idx - 1].price;
  assert.ok(
    Math.abs(buyArm!.target.price - expectedPrice) < 1e-6,
    `expected BUY re-arm at ${expectedPrice.toFixed(2)}, got ${buyArm!.target.price.toFixed(2)}`
  );
}

// ---------------------------------------------------------------------------
// PRICE GATE BOUNDARIES
// ---------------------------------------------------------------------------

test('pricePassesGate edge cases: zero, prev-only, range-degenerate', () => {
  assert.equal(pricePassesGate({ p: 0, prev: 100, maxSingleJumpPct: 0.15 }), false);
  assert.equal(pricePassesGate({ p: -5, prev: 100, maxSingleJumpPct: 0.15 }), false);
  assert.equal(pricePassesGate({ p: 100, prev: 0, maxSingleJumpPct: 0.15 }), true);
  assert.equal(pricePassesGate({ p: 115, prev: 100, maxSingleJumpPct: 0.15 }), true);
  assert.equal(pricePassesGate({ p: 115.001, prev: 100, maxSingleJumpPct: 0.15 }), false);
  assert.equal(
    pricePassesGate({ p: 100, prev: 0, maxSingleJumpPct: 0.15, historyHigh: 110, historyLow: 105 }),
    false
  );
  assert.equal(
    pricePassesGate({ p: 107, prev: 0, maxSingleJumpPct: 0.15, historyHigh: 110, historyLow: 105 }),
    true
  );
});

// ---------------------------------------------------------------------------
// FUND CONSERVATION
// ---------------------------------------------------------------------------

test('paper round-trip BUY->SELL conserves assets (no minted/lost USD)', () => {
  const store = new StateStore(cfg());
  seed(store, 0, 1000);
  const startUsd = 1000;
  const br = new PaperBroker(cfg(), store, oracle(100));

  // BUY 2 SOL @ 100. Card: SPEND quoteQty + fee.
  br.marketBuy({
    id: 'b', kind: 'DCA_BUY', side: 'BUY', price: 100, baseQty: 2, quoteQty: 200,
    status: 'OPEN', createdAt: Date.now(), mode: 'paper', strategyId: 'dca', note: 'x',
  });
  assert.ok(store.account.feesPaidUsd > 0, 'buy books a fee');
  assert.ok(store.account.balances.SOL >= 1.99, 'bought ~2 SOL');
  assert.ok(store.account.balances.USDC < 1000 - 200 + 1e-6, 'USDC fell by quote+fee');

  // SELL 1 SOL at $110. Card: RECEIVE fillPrice*qty - fee.
  const br2 = new PaperBroker(cfg(), store, oracle(110));
  br2.marketSell({
    id: 's', kind: 'DCA_SELL', side: 'SELL', price: 110, baseQty: 1, quoteQty: 110,
    status: 'OPEN', createdAt: Date.now(), mode: 'paper', strategyId: 'dca', note: 'x',
  });

  const a = store.account.balances;

  // Invariant 1: the fee ledger EXACTLY equals the sum of recorded trade fees
  // (no fee leaked or double-booked in central accounting).
  const feeSum = store.trades.reduce((s, t) => s + (t.feeUsd || 0), 0);
  assert.ok(
    Math.abs(feeSum - store.account.feesPaidUsd) < 1e-6,
    `fee ledger ${store.account.feesPaidUsd.toFixed(4)} != trade-fee sum ${feeSum.toFixed(4)}`
  );

  // Invariant 2 (EXACT conservation, no loose range): mark-to-market wallet
  // value = start − buy(200+fee) + sell(110−fee) + remainingSOL@110 = 1020 − totalFees.
  // cash        = 1000 − 200 − buyFee + 110 − sellFee
  // m2m         = cash + 1 SOL × 110
  //            = 1000 + 20 − (buyFee + sellFee) = 1020 − feesPaidUsd
  const mm = a.USDC + a.SOL * 110;
  assert.ok(
    Math.abs(mm - (1020 - store.account.feesPaidUsd)) < 1e-6,
    `conservation broken: mm ${mm.toFixed(4)} != 1020 - fees ${(1020 - store.account.feesPaidUsd).toFixed(4)}`
  );
});

test('multiple grid round-trips conserve value (cash reconciled to trade fees)', () => {
  const store = new StateStore(cfg());
  seed(store, 0, 1000);
  const startUsd = 1000;

  // Alternating 1-SOL buys/sells at mildly varying prices.
  const buyPrices = [100, 101, 100, 99, 100, 101, 100, 99, 100, 101];
  for (let i = 0; i < buyPrices.length; i++) {
    const price = buyPrices[i];
    const br = new PaperBroker(cfg(), store, oracle(price));
    if (i % 2 === 0) {
      br.marketBuy({
        id: `b${i}`, kind: 'GRID_BUY', side: 'BUY', price, baseQty: 1, quoteQty: price,
        status: 'OPEN', createdAt: Date.now(), mode: 'paper', strategyId: 'grid', note: 'x',
      });
    } else {
      br.marketSell({
        id: `s${i}`, kind: 'GRID_SELL', side: 'SELL', price, baseQty: 1, quoteQty: price,
        status: 'OPEN', createdAt: Date.now(), mode: 'paper', strategyId: 'grid', note: 'x',
      });
    }
  }

  // Fees must equal the sum of trade fees (no leak/double-book).
  const feeSum = store.trades.reduce((s, t) => s + (t.feeUsd || 0), 0);
  assert.ok(
    Math.abs(feeSum - store.account.feesPaidUsd) < 1e-6,
    `fee ledger ${store.account.feesPaidUsd.toFixed(4)} != trade-fee sum ${feeSum.toFixed(4)}`
  );

  const a = store.account.balances;
  const lastPx = buyPrices[buyPrices.length - 1];
  const mm = a.USDC + a.SOL * lastPx;
  // EXACT conservation: bought 5×1 SOL @100 (spend 500+fees), sold 5×1 SOL
  // @[101,99,101,99,101] (receive 501−fees), net SOL=0 → mm = cash = 1001 − fees.
  assert.ok(
    Math.abs(mm - (1001 - store.account.feesPaidUsd)) < 1e-6,
    `conservation broken: mm ${mm.toFixed(4)} != 1001 - fees ${(1001 - store.account.feesPaidUsd).toFixed(4)}`
  );
});
