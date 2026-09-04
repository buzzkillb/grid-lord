// ---------------------------------------------------------------------------
// DCA STRATEGY STATE MACHINE — the buy cadence + take-profit leg, end to end
// ---------------------------------------------------------------------------
// Covers the buy entry gates (interval due, dip-below-VWAP acceleration, cap
// shrink) and the TP leg transitions (arm → trail → slice-sell → cooldown →
// re-arm reset) driving through the REAL PaperBroker so every fill also
// exercises the H3 dca sub-book.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PaperBroker } from '../src/paperBroker.js';
import { PriceOracle } from '../src/price.js';
import { DcaStrategy } from '../src/dcaStrategy.js';

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
    enabled: false, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 2.0,
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
  // Deep-clone strategies/risk so a test mutating config (e.g. toggling VA,
  // setting minBuyUsd, squeezing the cap) can never leak into another test via
  // the shared module-level fixtures.
  return {
    mode: 'paper', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies: structuredClone(strategies), risk: structuredClone(risk),
  };
}

function rig(price = 100) {
  const c = cfg();
  const store = new StateStore(c);
  const oracle = new PriceOracle(c);
  oracle.__setPrice(price, true);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);
  return { c, store, oracle, broker, dca };
}

test('DCA min-buy guard: a sub-floor value-average buy is bumped up to the fee-aware minimum', () => {
  const c = cfg();
  // Force a tiny VA increment (well below minBuyUsd=15) so the guard must bump it.
  c.strategies.dca.vaEnabled = true;
  c.strategies.dca.vaTargetSol = 0.1; // tiny target
  c.strategies.dca.vaHorizonBuys = 12;
  c.strategies.dca.minBuyUsd = 15;
  const store = new StateStore(c);
  const oracle = new PriceOracle(c);
  oracle.__setPrice(100, true);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick();
  const pos = store.getPosition('SOL', 'USDC');
  assert.ok(pos, 'buy should fire');
  // Guard must bump the notional up to at least the fee-aware floor, not fire $1.
  assert.ok(pos.quoteQty >= 15 - 1e-9, `buy must be >= minBuyUsd 15, got ${pos.quoteQty}`);
});

test('DCA min-buy guard: defers instead of a fee-bleeding micro-buy when floor cannot fit cap', () => {
  const c = cfg();
  c.strategies.dca.vaEnabled = true;
  c.strategies.dca.vaTargetSol = 0.1;
  c.strategies.dca.vaHorizonBuys = 12;
  c.strategies.dca.minBuyUsd = 15;
  c.risk.maxUsdcPosition = 3; // cap below the fee-aware floor -> floor can't fit -> defer
  const store = new StateStore(c);
  const oracle = new PriceOracle(c);
  oracle.__setPrice(100, true);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick();
  assert.equal(store.getPosition('SOL', 'USDC'), undefined, 'should defer (no fee-bleeding micro-buy)');
});

test('DCA cadence: no buy before the interval elapses', () => {
  const { store, dca } = rig(100);
  store.strategies.dca.lastBuyAt = Date.now(); // just bought
  dca.tick();
  assert.equal(store.account.balances.USDC, 1000, 'no USDC spent before interval');
  assert.equal(store.getPosition('SOL', 'USDC'), undefined, 'no position opened');
});

test('DCA cadence: buys once the interval elapses', () => {
  const { store, dca } = rig(100);
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000; // interval is 60m
  dca.tick();
  const pos = store.getPosition('SOL', 'USDC');
  assert.ok(pos && pos.baseQty > 0.09, `expected a ~$10 buy, got ${pos?.baseQty}`);
  assert.ok(store.account.balances.USDC < 1000, 'USDC spent');
  // Sub-book ledgered the same qty (H3).
  assert.ok(Math.abs(store.strategies.dca.subBook!.baseQty - pos!.baseQty) < 1e-9);
});

test('DCA dip trigger: accelerates a buy on a dip below VWAP (interval/4 gate)', () => {
  const { store, oracle, dca } = rig(100);
  // Bought 16 minutes ago — not due for ~44 more minutes, but past interval/4 (15m).
  store.strategies.dca.lastBuyAt = Date.now() - 16 * 60_000;
  // Seed on-chain history at $104 so current $100 is ~3.85% below VWAP (>= 3% dip).
  const ts = Date.now() - 30 * 60_000;
  (oracle as unknown as { history: { ts: number; open: number; high: number; low: number; close: number; volumeUsd: number }[] }).history =
    [{ ts, open: 104, high: 104, low: 104, close: 104, volumeUsd: 1_000_000 }];
  oracle.__setPrice(100, true);
  dca.tick();
  const pos = store.getPosition('SOL', 'USDC');
  assert.ok(pos && pos.baseQty > 0.09, `dip must accelerate the buy, got ${pos?.baseQty ?? 'none'}`);
});

test('DCA dip trigger: does NOT fire when the dip is inside the interval/4 lock', () => {
  const { store, oracle, dca } = rig(100);
  store.strategies.dca.lastBuyAt = Date.now() - 5 * 60_000; // < interval/4 = 15m
  const ts = Date.now() - 30 * 60_000;
  (oracle as unknown as { history: { ts: number; open: number; high: number; low: number; close: number; volumeUsd: number }[] }).history =
    [{ ts, open: 104, high: 104, low: 104, close: 104, volumeUsd: 1_000_000 }];
  oracle.__setPrice(100, true);
  dca.tick();
  assert.equal(store.getPosition('SOL', 'USDC'), undefined, 'dip inside lockout must not buy');
});

test('DCA cap: shrinks the buy to fit the deployment ceiling', () => {
  const { c, store, dca } = rig(100);
  store.price = 100; // totalDeployedUsd marks the open position at this price
  c.risk.maxUsdcPosition = 15; // room for one $10 buy + fees, not two
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick(); // buys ~$10 (fee-inclusive cost kept under cap)
  const afterFirst = store.account.balances.USDC;
  assert.ok(afterFirst < 1000, 'first buy happened');

  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick(); // must shrink or skip — never breach the cap
  const spent = 1000 - store.account.balances.USDC;
  assert.ok(spent <= 15.2, `cap breached: spent ${spent.toFixed(2)} of ${c.risk.maxUsdcPosition}`);
});

test('DCA TP full arc: arm → trail → slice sell → cooldown → no re-drain → re-arm after reset', () => {
  const { store, oracle, dca } = rig(100);

  // Acquire SOL via the real broker (books the dca sub-book).
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick();
  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick();
  const qty0 = store.strategies.dca.subBook!.baseQty;
  assert.ok(qty0 > 0.19, `setup buys failed: ${qty0}`);

  const s = store.strategies.dca;
  const avg = s.subBook!.avgCostPerBase;

  // 1. Below arm threshold: nothing armed.
  oracle.__setPrice(avg * 1.05); store.price = avg * 1.05;
  dca.tick();
  assert.notEqual(s.tpArmed, true, 'must not arm below TP%');
  s.lastBuyAt = Date.now(); // freeze buys for the rest of the arc

  // 2. Price crosses avg*(1+8%): TP arms and peak starts tracking. (At the
  //    exact trigger the floor equals the arm level, so a same-tick slice sell
  //    is legal; arm strictly above the trigger to isolate the arm transition.)
  oracle.__setPrice(avg * 1.10); store.price = avg * 1.10;
  dca.tick();
  if (!s.tpArmed) {
    assert.equal(s.tpArmed, true, 'arms at avg*(1+tp)');
  }
  assert.ok(
    s.tpArmed || s.lastTpAt !== undefined,
    'armed (or armed+sold same tick at the floor)'
  );
  if (s.tpArmed) assert.ok(Math.abs(s.peakPrice! - avg * 1.10) < 1e-6, 'peak seeded at arm price');

  // 3. Higher peak tracked while armed.
  oracle.__setPrice(avg * 1.20); store.price = avg * 1.20;
  dca.tick();
  assert.ok(Math.abs(s.peakPrice! - avg * 1.20) < 1e-6, 'peak follows new highs');

  // 4. Trail back 2% from peak -> slice sell (cooldown is 30m but this is the
  //    first sell, so it fires), booking realized PnL on the dca book only.
  oracle.__setPrice(avg * 1.20 * 0.975); store.price = avg * 1.20 * 0.975;
  const pnlBefore = s.subBook!.realizedPnlUsd;
  const qtyBefore = s.subBook!.baseQty;
  dca.tick();
  assert.ok(s.subBook!.baseQty < qtyBefore, 'slice sold on trail-back');
  assert.ok(s.subBook!.realizedPnlUsd > pnlBefore, 'realized PnL booked');
  assert.equal(s.lastTpAt !== undefined, true, 'cooldown timestamp set');

  // 5. Immediate re-trail (price dips again): cooldown blocks a second sell.
  oracle.__setPrice(avg * 1.15); store.price = avg * 1.15;
  dca.tick();
  const qtyAfterCooldownStart = s.subBook!.baseQty;
  oracle.__setPrice(avg * 1.10); store.price = avg * 1.10;
  dca.tick();
  assert.equal(s.subBook!.baseQty, qtyAfterCooldownStart, 'cooldown blocks rapid re-drain');

  // 6. After the cooldown window: another profitable trail can fire again.
  s.lastTpAt = Date.now() - 31 * 60_000;
  // Re-arm on the way up first (position is still green vs avg cost).
  oracle.__setPrice(avg * 1.15); store.price = avg * 1.15;
  dca.tick();
  assert.equal(s.tpArmed, true, 're-arms while green after cooldown');
  const peak2 = s.peakPrice!;
  oracle.__setPrice(peak2 * 0.975); store.price = peak2 * 0.975;
  const qtyBefore2 = s.subBook!.baseQty;
  dca.tick();
  assert.ok(s.subBook!.baseQty < qtyBefore2, 'second slice after cooldown elapses');

  // 7. Conservation holds through the whole arc (H3).
  assert.equal(store.subBooksConserved(), true, 'sub-books conserved through TP arc');
});

test('DCA TP: sells at the profit floor, never below the dca sub-book basis', () => {
  const { c, store, oracle, dca } = rig(100);
  c.strategies.dca.tpCooldownMinutes = 0;
  c.strategies.dca.takeProfitPct = 0.6;   // arm/floor = +0.6%
  c.strategies.dca.trailingPct = 4;       // raw trail (96.6) < cost — the classic bug

  store.strategies.dca.lastBuyAt = Date.now() - 61 * 60_000;
  dca.tick(); // buy ~$10 -> dca book holds a real avg cost
  const avg = store.strategies.dca.subBook!.avgCostPerBase;

  const s = store.strategies.dca;
  oracle.__setPrice(avg * 1.006); store.price = avg * 1.006;
  dca.tick();
  assert.ok(
    s.tpArmed === true || s.lastTpAt !== undefined,
    'armed at +0.6% (or armed+sold same tick: price == profit floor)'
  );
  if (s.tpArmed) {
    oracle.__setPrice(avg * 1.006 * 1.001); store.price = avg * 1.006 * 1.001;
    dca.tick(); // tiny new peak
    // Drop below the floor: the OLD code (pre profit-floor) would wait for
    // avg*1.006*0.96 — a ~-3.4% loss. The floored code must sell HERE, green.
    oracle.__setPrice(avg * 1.004); store.price = avg * 1.004;
    dca.tick();
  }
  assert.ok(s.subBook!.realizedPnlUsd > 0, `TP must bank a gain, got ${s.subBook!.realizedPnlUsd}`);
  assert.ok(store.subBooksConserved(), 'conservation after floored TP sell');
});
