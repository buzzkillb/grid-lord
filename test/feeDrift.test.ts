// ---------------------------------------------------------------------------
// SUB-BOOK / CHAIN DRIFT RECONCILIATION
// ---------------------------------------------------------------------------
// Native-SOL network fees (and shrink-to-available sells) consume more SOL on
// chain than the strategy books record, so sum(grid+dca sub-book qty) drifts
// ABOVE the real balance and the dashboard shows phantom SOL. The store must
// reconcile the books down to the chain position (attributing the gap to fees)
// so the H3 conservation invariant holds against on-chain truth.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';

process.env.NODE_ENV = 'test';
process.env.STATE_PERSIST = '0';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 5000, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.05,
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
    intervalMinutes: 60, usdcAmountPerBuy: 20, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 1, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(): AppConfig {
  return {
    mode: 'live', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies: structuredClone(strategies), risk: structuredClone(risk),
  };
}

function seededStore(chainSol: number, gridQty: number, dcaQty: number): StateStore {
  const store = new StateStore(cfg());
  store.account.balances.SOL = chainSol;
  store.upsertPosition({
    baseAsset: 'SOL', quoteAsset: 'USDC', baseQty: chainSol, quoteQty: 0, avgCostPerBase: 100,
  } as any);
  store.strategies.grid.subBook = store.subBook('grid');
  store.strategies.dca.subBook = store.subBook('dca');
  store.strategies.grid.subBook.baseQty = gridQty;
  store.strategies.dca.subBook.baseQty = dcaQty;
  return store;
}

test('reconcile trims books to the on-chain balance and books the gap as fees', () => {
  // Chain has 1.0 SOL but books claim grid 0 + dca 1.215 -> 0.215 phantom.
  const store = seededStore(1.0, 0, 1.215);
  const price = 104;
  const trim = store.reconcileSubBooksToPosition(price);
  assert.ok(Math.abs(trim - 0.215) < 1e-9, `trim ${trim} expected 0.215`);
  assert.ok(store.subBooksConserved(), 'books must equal chain position after reconcile');
  assert.ok(
    Math.abs(store.strategies.dca.subBook.feesPaidUsd - 0.215 * price) < 1e-6,
    'phantom SOL must be attributed to fees at the current price'
  );
});

test('reconcile splits the trim proportionally across both books', () => {
  // Books: grid 2 + dca 2, chain 3 -> 1 SOL phantom, split 50/50.
  const store = seededStore(3.0, 2.0, 2.0);
  const trim = store.reconcileSubBooksToPosition(100);
  assert.ok(Math.abs(trim - 1) < 1e-9);
  assert.ok(Math.abs(store.strategies.grid.subBook.baseQty - 1.5) < 1e-9, 'grid trimmed by its share');
  assert.ok(Math.abs(store.strategies.dca.subBook.baseQty - 1.5) < 1e-9, 'dca trimmed by its share');
  assert.ok(store.subBooksConserved());
});

test('reconcile is a no-op when books already match the chain (or understate it)', () => {
  const ok = seededStore(1.0, 0.4, 0.6);
  assert.equal(ok.reconcileSubBooksToPosition(100), 0, 'exact match -> no trim');
  assert.ok(ok.subBooksConserved());

  const under = seededStore(2.0, 1.0, 0.5); // books 1.5 < chain 2.0
  assert.equal(under.reconcileSubBooksToPosition(100), 0, 'must never mint SOL back into books');
});

test('reconcile does nothing without a valid price', () => {
  const store = seededStore(1.0, 0, 1.215);
  assert.equal(store.reconcileSubBooksToPosition(0), 0);
  assert.equal(store.strategies.dca.subBook.baseQty, 1.215, 'untouched without price');
});
