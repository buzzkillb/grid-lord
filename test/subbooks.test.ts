// ---------------------------------------------------------------------------
// H3 RING-FENCED SUB-BOOKS — grid and dca each own a slice of the SOL position
// ---------------------------------------------------------------------------
// Invariants under test:
//   1. Conservation: grid.subBook.baseQty + dca.subBook.baseQty === position.baseQty
//      after every fill path (paper broker grid/dca buys and sells).
//   2. Isolation: DCA take-profit acts ONLY on the dca book (grid lots never
//      arm DCA's TP, and a DCA slice sells dca-owned qty, not grid-owned).
//   3. Isolation: the grid cost-guard reads the GRID book's basis, so cheap
//      DCA lots can never let the grid arm a below-cost sell.
//   4. Ledger hygiene: per-strategy fees/PnL accumulate on the strategy's own
//      book while the central account ledger stays the single fee writer.
//   5. Persistence: sub-books survive a save/load round-trip.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PaperBroker } from '../src/paperBroker.js';
import { PriceOracle } from '../src/price.js';
import { DcaStrategy } from '../src/dcaStrategy.js';
import { GridStrategy } from '../src/gridStrategy.js';
import type { Order } from '../src/types.js';

process.env.NODE_ENV = 'test';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 10_000, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
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
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 0,
    vaEnabled: false, vaTargetSol: 5, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(mode: 'paper' | 'live' = 'paper'): AppConfig {
  return {
    mode, rpcUrl: 'https://api.mainnet-beta.solana.com', jupiterApiUrl: 'https://api.jup.ag/swap/v2',
    pollIntervalMs: 1000, refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

function newOracle(price = 100): PriceOracle {
  const o = new PriceOracle(cfg());
  o.__setPrice(price, true);
  return o;
}

function makeOrder(
  id: string, side: 'BUY' | 'SELL', qty: number, price: number, strategyId = 'dca'
): Order {
  return {
    id, kind: side === 'BUY' ? 'DCA_BUY' : 'DCA_SELL', side, price,
    baseQty: qty, quoteQty: qty * price, status: 'OPEN', createdAt: Date.now(),
    mode: 'paper', strategyId, note: 'test',
  };
}

test('H3 conservation: grid+dca sub-books sum exactly to the aggregate position', () => {
  const store = new StateStore(cfg());
  const broker = new PaperBroker(cfg(), store, newOracle(100));

  broker.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
  broker.marketBuy(makeOrder('d1', 'BUY', 0.5, 100, 'dca'));

  const pos = store.getPosition('SOL', 'USDC')!;
  const g = store.strategies.grid.subBook!;
  const d = store.strategies.dca.subBook!;
  assert.equal(store.subBooksConserved(), true, 'conservation invariant holds');
  assert.ok(Math.abs(g.baseQty - 1) < 1e-9, `grid book=${g.baseQty}`);
  assert.ok(Math.abs(d.baseQty - 0.5) < 1e-9, `dca book=${d.baseQty}`);
  assert.ok(Math.abs(g.baseQty + d.baseQty - pos.baseQty) < 1e-9);

  // A sell from one book shrinks only that book; conservation still holds.
  broker.marketSell(makeOrder('g2', 'SELL', 0.4, 110, 'grid'));
  assert.equal(store.subBooksConserved(), true, 'conservation after grid sell');
  assert.ok(Math.abs(store.strategies.grid.subBook!.baseQty - 0.6) < 1e-9);
  assert.ok(Math.abs(store.strategies.dca.subBook!.baseQty - 0.5) < 1e-9);
});

test('H3 isolation: grid lots never arm the DCA take-profit', () => {
  const store = new StateStore(cfg());
  const oracle = newOracle(100);
  const broker = new PaperBroker(cfg(), store, oracle);
  const dca = new DcaStrategy(cfg(), store, broker, oracle);

  // GRID buys 1 SOL @ 100. DCA has NOT bought anything.
  broker.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
  store.strategies.dca.lastBuyAt = Date.now(); // suppress the periodic buy leg

  // Price rips +50%: with commingled books the DCA TP would arm off grid's
  // cheap lots and sell grid capital. Must NOT happen.
  oracle.__setPrice(150);
  store.price = 150;
  dca.tick();
  const s = store.strategies.dca;
  assert.notEqual(s.tpArmed, true, 'DCA TP must not arm off grid lots');
  assert.ok(Math.abs(store.strategies.grid.subBook!.baseQty - 1) < 1e-9, 'grid book untouched');
});

test('H3 isolation: DCA take-profit sells only the DCA slice, grid lots untouched', () => {
  const c = cfg();
  c.strategies.dca.takeProfitPct = 8;
  c.strategies.dca.trailingPct = 2;
  c.strategies.dca.takeProfitSlicePct = 25; // slice = 25% of DCA book
  const store = new StateStore(c);
  const oracle = newOracle(100);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);

  broker.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
  broker.marketBuy(makeOrder('d1', 'BUY', 1, 100, 'dca'));
  store.strategies.dca.lastBuyAt = Date.now();

  // Rip to 110 (arms at +8% -> 108), then trail back below 110*0.98=107.8.
  oracle.__setPrice(110); store.price = 110;
  dca.tick();
  assert.equal(store.strategies.dca.tpArmed, true, 'DCA TP armed off its own book');
  oracle.__setPrice(107); store.price = 107;
  dca.tick();

  const d = store.strategies.dca.subBook!;
  const g = store.strategies.grid.subBook!;
  assert.ok(Math.abs(d.baseQty - 0.75) < 1e-6, `dca book after slice=${d.baseQty}`);
  assert.ok(Math.abs(g.baseQty - 1) < 1e-9, `grid book must be untouched, got ${g.baseQty}`);
  assert.ok(d.realizedPnlUsd > 0, `dca realized PnL=${d.realizedPnlUsd}`);
  assert.equal(store.subBooksConserved(), true, 'conservation after DCA TP sell');
  assert.ok(Math.abs(store.getPosition('SOL', 'USDC')!.baseQty - 1.75) < 1e-6);
});

test('H3 isolation: grid cost-guard uses the GRID basis, not the commingled average', () => {
  const store = new StateStore(cfg());
  const oracle = newOracle(100);
  const broker = new PaperBroker(cfg(), store, oracle);
  const grid = new GridStrategy(cfg(), store, oracle, broker);

  // Grid buys expensive lots @ 100; DCA buys cheap lots @ 60.
  broker.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
  broker.marketBuy(makeOrder('d1', 'BUY', 1, 60, 'dca'));

  const agg = store.getPosition('SOL', 'USDC')!;
  assert.ok(agg.avgCostPerBase < 90, `commingled avg=${agg.avgCostPerBase}`);

  const guard = (grid as unknown as { sellBelowCostWouldLose(p: number): boolean });
  // $80 is ABOVE the commingled average (~80) — old code would allow it —
  // but BELOW grid's own $100 basis, so the grid book must refuse.
  assert.equal(guard.sellBelowCostWouldLose(80), true, 'grid must not sell below ITS basis');
  // $110 is above grid's basis -> allowed.
  assert.equal(guard.sellBelowCostWouldLose(110), false, 'profitable grid sell allowed');
});

test('H3 ledger hygiene: per-strategy fees land on each own book, central fee ledger counts once', () => {
  const store = new StateStore(cfg());
  const broker = new PaperBroker(cfg(), store, newOracle(100));

  broker.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
  broker.marketBuy(makeOrder('d1', 'BUY', 1, 100, 'dca'));
  broker.marketSell(makeOrder('d2', 'SELL', 0.5, 110, 'dca'));

  const g = store.strategies.grid.subBook!;
  const d = store.strategies.dca.subBook!;
  assert.ok(g.feesPaidUsd > 0, 'grid book booked its buy fee');
  assert.ok(d.feesPaidUsd > g.feesPaidUsd, 'dca book booked buy + sell fees');

  // Central ledger: exactly the sum of the recorded trades' fees.
  const tradeFees = store.trades.reduce((s, t) => s + t.feeUsd, 0);
  assert.ok(
    Math.abs(tradeFees - store.account.feesPaidUsd) < 1e-6,
    `central fee ledger ${store.account.feesPaidUsd} vs trades ${tradeFees}`
  );
  assert.ok(
    Math.abs(g.feesPaidUsd + d.feesPaidUsd - tradeFees) < 1e-6,
    'sub-book fees reconcile to the same total (no double-count)'
  );
});

test('H3 persistence: sub-books survive a save/load round-trip', () => {
  process.env.STATE_PERSIST = '1';
  const paperFile = join(process.cwd(), '.botstate', 'state-paper.json');
  try {
    if (existsSync(paperFile)) rmSync(paperFile);

    const store1 = new StateStore(cfg('paper'));
    const broker1 = new PaperBroker(cfg('paper'), store1, newOracle(100));
    broker1.marketBuy(makeOrder('g1', 'BUY', 1, 100, 'grid'));
    broker1.marketBuy(makeOrder('d1', 'BUY', 0.5, 100, 'dca'));
    store1.persistNow();

    const store2 = new StateStore(cfg('paper'));
    const g2 = store2.strategies.grid.subBook;
    const d2 = store2.strategies.dca.subBook;
    assert.ok(g2, 'grid sub-book restored');
    assert.ok(d2, 'dca sub-book restored');
    assert.ok(Math.abs(g2!.baseQty - 1) < 1e-9, `grid book=${g2!.baseQty}`);
    assert.ok(Math.abs(d2!.baseQty - 0.5) < 1e-9, `dca book=${d2!.baseQty}`);
    assert.ok(g2!.avgCostPerBase > 100, 'grid basis (incl. fee) restored');
    assert.equal(store2.subBooksConserved(), true, 'conservation after restore');
  } finally {
    if (existsSync(paperFile)) rmSync(paperFile);
    process.env.STATE_PERSIST = '0';
  }
});
