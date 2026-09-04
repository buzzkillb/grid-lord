import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PaperBroker } from '../src/paperBroker.js';
import { PriceOracle, pricePassesGate } from '../src/price.js';
import { DcaStrategy } from '../src/dcaStrategy.js';
import type { Order } from '../src/types.js';

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
    lowerPrice: 99, upperPrice: 115, numLevels: 8, usdcPerGrid: 10,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: true, vwapSkewEnabled: true, skewStrength: 2.0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 10, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 5, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(mode: 'paper' | 'live' = 'paper'): AppConfig {
  return {
    mode, rpcUrl: 'https://api.mainnet-beta.solana.com', jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

function newOracle(price = 100, jupiterFresh = true): PriceOracle {
  const o = new PriceOracle(cfg());
  o.__setPrice(price, jupiterFresh);
  return o;
}

function makeOrder(
  id: string, side: 'BUY' | 'SELL', qty: number, price: number
): Order {
  return {
    id, kind: side === 'BUY' ? 'DCA_BUY' : 'DCA_SELL', side, price,
    baseQty: qty, quoteQty: qty * price, status: 'OPEN', createdAt: Date.now(),
    mode: 'paper', strategyId: 'dca', note: 'test',
  };
}

test('PaperBroker BUY updates position, balances and cost basis', () => {
  const store = new StateStore(cfg());
  const broker = new PaperBroker(cfg(), store, newOracle(100));
  broker.marketBuy(makeOrder('b1', 'BUY', 0.5, 100));

  const pos = store.getPosition('SOL', 'USDC')!;
  assert.ok(pos.baseQty >= 0.4999, `baseQty=${pos.baseQty}`);
  assert.ok(pos.avgCostPerBase > 100, `avg cost must include fee (>100), got ${pos.avgCostPerBase}`);
  assert.ok(store.account.balances.USDC < 1000, 'USDC spent');
  assert.ok(store.account.balances.SOL > 5, 'SOL gained');
});

test('PaperBroker SELL records realized PnL and never drives SOL negative (M3)', () => {
  const store = new StateStore(cfg());
  const oracle = newOracle(100);
  const broker = new PaperBroker(cfg(), store, oracle);
  broker.marketBuy(makeOrder('b1', 'BUY', 1, 100)); // fills at oracle $100

  // Oversized SELL must be refused (SOL can never go negative).
  broker.marketSell(makeOrder('s1', 'SELL', 9999, 110));
  assert.ok(store.account.balances.SOL >= 0, `SOL balance negative? ${store.account.balances.SOL}`);

  // Real profitable SELL banks realized PnL (bump oracle so the fill is a win).
  const before = store.account.realizedPnlUsd;
  oracle.__setPrice(125);
  broker.marketSell(makeOrder('s2', 'SELL', 0.5, 125));
  assert.ok(store.account.realizedPnlUsd > before, 'realized PnL increased');
  assert.ok(store.account.balances.SOL >= 0, 'SOL still non-negative');
});

test('PaperBroker holds SOL cost basis after realistic sell slice (no negative openQty)', () => {
  const store = new StateStore(cfg());
  const broker = new PaperBroker(cfg(), store, newOracle(100));
  broker.marketBuy(makeOrder('b1', 'BUY', 2, 100));
  broker.marketSell(makeOrder('s1', 'SELL', 0.5, 110));
  const pos = store.getPosition('SOL', 'USDC')!;
  assert.ok(pos.baseQty > 1.4 && pos.baseQty < 1.6, `pos.baseQty=${pos.baseQty}`);
  assert.equal(store.account.openQty, pos.baseQty, 'openQty mirrors position');
});

test('PriceOracle flags Jupiter execution-venue freshness separately from fallback price (M2)', () => {
  const o = newOracle(100, false); // price fresh, but Jupiter (venue) down
  assert.equal(o.current, 100);
  assert.equal(o.currentGeneratingFresh, true);
  assert.equal(o.jupiterFresh, false, 'execution venue flagged stale even though a price is shown');
});

test('Live-mode store starts balance-less (balances always re-read from chain) (C1)', () => {
  const store = new StateStore(cfg('live'));
  assert.equal(store.account.balances.SOL, 0, 'live starts SOL=0 (read on chain)');
  assert.equal(store.account.balances.USDC, 0, 'live starts USDC=0 (read on chain)');
});

test('totalDeployedUsd counts resting grid BUYs and open position value', () => {
  const store = new StateStore(cfg());
  store.price = 100; // engine normally sets this; needed for position-value calc
  // One confirmed buy of 2 SOL @ $100 = $200 deployed.
  const broker = new PaperBroker(cfg(), store, newOracle(100));
  broker.marketBuy(makeOrder('b1', 'BUY', 2, 100));
  assert.ok(store.totalDeployedUsd() > 190, `deployed=${store.totalDeployedUsd()}`);
});

test('pricePassesGate rejects a single-poll glitch but accepts a genuine move (phantom $5.97 bug)', () => {
  // From SOL ~107, a ~$5.97 print (~ -94%) must be REJECTED.
  assert.equal(
    pricePassesGate({ p: 5.97, prev: 107, maxSingleJumpPct: 0.15 }), false,
    'giant single-poll crash must be rejected'
  );
  // A big single print far outside the 24h range is also rejected.
  assert.equal(
    pricePassesGate({ p: 5.97, prev: 107, maxSingleJumpPct: 0.15, historyHigh: 110, historyLow: 90 }),
    false, 'print far outside 24h range must be rejected'
  );
  // A normal poll-to-poll movement is accepted.
  assert.equal(
    pricePassesGate({ p: 107.5, prev: 107, maxSingleJumpPct: 0.15 }), true
  );
  // A legal-ish +10% move within a day is accepted.
  assert.equal(
    pricePassesGate({ p: 108, prev: 107, maxSingleJumpPct: 0.15, historyHigh: 109, historyLow: 104 }),
    true, 'moderate in-range move accepted'
  );
});

test('DCA buy is capped by the USDC deployment ceiling (no unbounded deployment)', () => {
  const c = cfg();
  // Tiny cap that the single DCA buy would blow through.
  c.risk.maxUsdcPosition = 5;
  const store = new StateStore(c);
  // No price movement needed; DCA executes as market at oracle price.
  const oracle = newOracle(100);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);
  // Force cadence so the next tick() buys.
  store.strategies.dca.lastBuyAt = Date.now() - 10 * 60_000;
  const beforeBal = store.account.balances.USDC;
  dca.tick();
  // The buy must be skipped/reduced so deployed stays under the $5 cap.
  assert.ok(
    store.account.balances.USDC >= beforeBal - 5.1,
    `DCA overshot the deployment cap: USDC dropped ${(beforeBal - store.account.balances.USDC).toFixed(2)}`
  );
});

test('DCA TP cooldown prevents rapid re-drain after a take-profit slice', () => {
  const c = cfg();
  c.strategies.dca.tpCooldownMinutes = 30; // 30-min cooldown enforced
  const store = new StateStore(c);
  const oracle = newOracle(100);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);

  // Seed a profitable position directly: 1 SOL @ $100 avg cost.
  const pos = {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseQty: 1, quoteQty: 100, avgCostPerBase: 100,
  };
  store.upsertPosition(pos as any);
  store.account.balances.SOL = 1;
  store.account.balances.USDC = 100;
  store.price = 100;

  // Mark a take-profit as having just fired: TP armed, peak 130, lastTp now.
  const s = store.strategies.dca;
  s.tpArmed = true;
  s.peakPrice = 130;
  s.lastTpAt = Date.now();

  // Price trails back below the trail level -> would normally sell again, but
  // the cooldown must block it (no new SELL order, position unchanged).
  store.price = 120; // trailBack = 130 * (1 - 2%) = 127.4, so 120 trails back
  oracle.__setPrice(120);
  dca.tick();
  assert.ok(store.account.balances.SOL >= 1 - 1e-9, `SOL sold during cooldown: ${store.account.balances.SOL}`);
});

test('DCA TP sells at the profit floor, never waiting down to a below-cost trail level', () => {
  // The live .env shape: arm at +0.6% (TP), trail back 4%. The raw trail-back
  // sell level (100.60 * 0.96 = 96.58) sits BELOW the $100 cost basis — so the
  // OLD code would "take profit" by selling at a loss. The fix floors the sell
  // trigger at the profit threshold (100.60), so the slice is triggered as soon
  // as price crosses back under it — while it is still profitable.
  const c = cfg();
  c.strategies.dca.tpCooldownMinutes = 0; // no cooldown hiding the effect
  c.strategies.dca.takeProfitPct = 0.6;   // arm / profit floor = +0.6% -> 100.60
  c.strategies.dca.trailingPct = 4;       // raw trail back would be 96.58 (a loss)
  c.strategies.dca.takeProfitSlicePct = 25;

  const store = new StateStore(c);
  const oracle = newOracle(100);
  const broker = new PaperBroker(c, store, oracle);
  const dca = new DcaStrategy(c, store, broker, oracle);

  // 1 SOL @ $100 avg cost. Mark a recent buy so the periodic buy leg never
  // fires in this test (it could otherwise mask the TP behavior).
  store.upsertPosition({
    baseAsset: 'SOL', quoteAsset: 'USDC', baseQty: 1, quoteQty: 100, avgCostPerBase: 100,
  } as any);
  store.account.balances.SOL = 1;
  store.account.balances.USDC = 1000;
  store.strategies.dca.lastBuyAt = Date.now();

  // Seed it armed at a +0.6% peak.
  const s = store.strategies.dca;
  s.tpArmed = true;
  s.peakPrice = 100.6; // profit floor = 100.60

  // Price drifts back to 100.50 — crossed the 100.60 floor while still well
  // above both the $100 cost and the old 96.58 trail level. The FIXED code must
  // trigger here and bank a profit. The OLD code would hold until 96.58 and
  // sell at a loss.
  store.price = 100.5;
  oracle.__setPrice(100.5);
  const solBefore = store.account.balances.SOL;
  const pnlBefore = store.account.realizedPnlUsd;
  dca.tick();

  // A slice must have been sold (we crossed the profit floor).
  assert.ok(
    store.account.balances.SOL < solBefore - 1e-6,
    `fixed code should sell at the profit floor; SOL unchanged (${store.account.balances.SOL})`
  );
  // ... and it must bank a non-negative (>= 0) realized result vs the $100 cost.
  assert.ok(
    store.account.realizedPnlUsd >= pnlBefore - 1e-6,
    `TP sold below cost: realized ${store.account.realizedPnlUsd.toFixed(4)} (was ${pnlBefore.toFixed(4)})`
  );
});


test('sampleEquity equals cash + SOL-at-market (no P&L double-count)', () => {
  const c = cfg();
  const store = new StateStore(c);
  // Simulate a profitable open position with realized PnL banked, then a price
  // jump — the classic case that used to double-count profit in the curve.
  store.account.balances.SOL = 1;
  store.account.balances.USDC = 100;
  store.account.realizedPnlUsd = 10; // gains banked from earlier sells
  store.account.positions['SOL/USDC'] = {
    baseAsset: 'SOL', quoteAsset: 'USDC',
    baseQty: 1, quoteQty: 90, avgCostPerBase: 100,
  } as any;
  store.price = 120;
  store.equityHistory = []; // clear seeded curve
  store.sampleEquity();

  // TRUE equity is simply what the wallet holds at market: 100 USDC + 1 SOL*120.
  const expected = 100 + 1 * 120; // = 220 (realized + unrealized NOT added)
  assert.equal(store.equityHistory.length, 1, 'one sample appended');
  const got = store.equityHistory[0].equityUsd;
  assert.ok(
    Math.abs(got - expected) < 1e-6,
    `equity ${got.toFixed(2)} should equal cash+SOL@mkt ${expected.toFixed(2)} (PnL is inside those balances)`
  );
  // Guard: the OLD buggy formula (adding realized=10 + unreal=20) would give 250.
  assert.ok(got < 230, `equity ${got.toFixed(2)} must NOT include double-counted PnL`);
});
