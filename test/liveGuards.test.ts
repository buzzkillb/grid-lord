// ---------------------------------------------------------------------------
// LIVE BROKER SEND-BOUNDARY GUARDS — the last line before real money moves
// ---------------------------------------------------------------------------
// These test executeSwap's pre-send defenses with a stubbed JupiterExec and a
// dry-run-safe config (assertLiveAllowed is bypassed via dry-run env because
// executeSwap → buildSwap is stubbed; the real gates are covered elsewhere).
//   H1: input-balance guard — SELL/BUY sized beyond what the wallet actually
//       holds must NOT be sent; over-sized SELL shrinks to the held amount,
//       and a zero-balance wallet never sends at all (lock released).
//   H2: quote-sanity gate — a build whose implied price deviates from the live
//       oracle beyond RISK_MAX_QUOTE_DEVIATION_PCT must NOT be sent, and the
//       in-flight lock must be released so the order stays retryable.
//   Lock hygiene: every early return path releases the in-flight guard, else
//   the order would strand forever un-retryable.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PriceOracle } from '../src/price.js';
import { LiveBroker } from '../src/liveBroker.js';
import type { JupiterExec } from '../src/jupiter.js';
import { setDryRun, resetLiveGuards } from '../src/jupiter.js';
import { Keypair } from '@solana/web3.js';
import type { Order } from '../src/types.js';

process.env.NODE_ENV = 'test';
process.env.TRADE_MODE = 'live';
// Legacy tests below assumed a 0.01 SOL sell margin. Keep the reserve small for
// those; the dedicated SOL-reserve test sets a real reserve explicitly.
process.env.SOL_FEE_RESERVE_SOL = '0.01';
// submitBuilt is fully stubbed below (no network), so dry-run must be OFF —
// with it on, assertLiveAllowed throws at the top of executeSwap and none of
// the guards under test would be reached. Restore defaults when done.
setDryRun(false);

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 1000, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: false,
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

function cfg(): AppConfig {
  return {
    mode: 'live', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

interface StubState {
  balances: { SOL: number; USDC: number };
  /** buildSwap implied price (out per in, human) the stub will return. */
  impliedOutPerIn: number;
  builds: number;
  submits: number;
}

function stubJup(state: StubState): JupiterExec {
  return {
    nativeSolBalance: async () => state.balances.SOL,
    tokenBalance: async (_o: unknown, mint: string) =>
      mint === SOL ? state.balances.SOL : mint === USDC ? state.balances.USDC : 0,
    buildSwap: async (p: { inAmount: number }, _s: unknown) => {
      state.builds++;
      return {
        tx: {} as never,
        inputMint: '',
        outputMint: '',
        // impliedPrice = out/in; stub returns out = inAmount * impliedOutPerIn
        expectedOutAmount: p.inAmount * state.impliedOutPerIn,
      };
    },
    submitBuilt: async () => {
      state.submits++;
      return { ok: true, txid: 'stub', outAmount: 0 };
    },
  } as unknown as JupiterExec;
}

function rig(stub: StubState) {
  const c = cfg();
  const store = new StateStore(c);
  const oracle = new PriceOracle(c);
  oracle.__setPrice(100, true);
  const signer = Keypair.generate();
  const broker = new LiveBroker(c, store, oracle, signer);
  // Inject stub without re-running the constructor's real JupiterExec.
  (broker as unknown as { jup: JupiterExec }).jup = stubJup(stub);
  return { c, store, oracle, broker };
}

function sellOrder(qty: number): Order {
  return {
    id: 'test-sell', kind: 'DCA_SELL', side: 'SELL', price: 100,
    baseQty: qty, quoteQty: 0, status: 'OPEN', createdAt: Date.now(),
    mode: 'live', strategyId: 'dca', note: 'test',
  };
}

test('H1: SELL larger than wallet SOL shrinks to held amount (minus margin), does not fail', async () => {
  const stub: StubState = { balances: { SOL: 0.5, USDC: 500 }, impliedOutPerIn: 100, builds: 0, submits: 0 };
  const { broker } = rig(stub);
  const order = sellOrder(2.0); // ledger thinks 2 SOL, wallet has 0.5

  await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
    .executeSwap(order, 'SELL');

  assert.equal(stub.builds, 1, 'swap was still built');
  assert.equal(stub.submits, 1, 'swap submitted (dry-run stub) with the shrunk amount');
  // The over-sized order was shrunk to available balance and FILLED at that
  // size — verify the fill used the shrunk qty, not the ledger's phantom 2 SOL.
  assert.equal(order.status, 'FILLED', 'shrunk fill completed');
  const t = (broker as unknown as { store: StateStore }).store.trades.at(-1);
  assert.ok(t, 'trade recorded');
  assert.ok(Math.abs(t!.baseQty - 0.49) < 1e-9, `fill qty=${t!.baseQty} (expected 0.49 = 0.5 - margin)`);
  // A FILLED order intentionally KEEPS its in-flight marker forever (never
  // re-send a filled order); assert the permanent-marker invariant instead.
  assert.equal(
    (broker as unknown as { inFlight: Set<string> }).inFlight.has(order.id),
    true, 'filled order keeps its in-flight marker (anti-resend)'
  );
});

test('H1: zero-balance SELL sends nothing and releases the lock for retry', async () => {
  const stub: StubState = { balances: { SOL: 0, USDC: 500 }, impliedOutPerIn: 100, builds: 0, submits: 0 };
  const { broker } = rig(stub);
  const order = sellOrder(1.0);

  await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
    .executeSwap(order, 'SELL');

  assert.equal(stub.builds, 0, 'nothing built with zero balance');
  assert.equal(stub.submits, 0, 'nothing sent');
  assert.equal(
    (broker as unknown as { inFlight: Set<string> }).inFlight.has(order.id),
    false, 'lock released — order must stay retryable'
  );
  assert.equal(order.status, 'OPEN', 'order left OPEN');
});

test('SOL fee reserve: SOL is never sold below the standing fee buffer', async () => {
  // Set a real reserve: keep ≥0.3 native SOL for fees. Wallet holds 0.8 SOL, so
  // available to sell = 0.8 - 0.3 = 0.5; the sell must use 0.5 and leave 0.3.
  process.env.SOL_FEE_RESERVE_SOL = '0.3';
  try {
    const stub: StubState = { balances: { SOL: 0.8, USDC: 500 }, impliedOutPerIn: 100, builds: 0, submits: 0 };
    const { broker } = rig(stub);
    const order = sellOrder(2.0); // wants to sell 2 SOL, but must keep the reserve

    await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
      .executeSwap(order, 'SELL');

    assert.equal(stub.builds, 1, 'swap built with the reserved amount');
    assert.equal(stub.submits, 1, 'swap submitted');
    assert.equal(order.status, 'FILLED');
    const t = (broker as unknown as { store: StateStore }).store.trades.at(-1);
    assert.ok(t, 'trade recorded');
    // Filled exactly the amount above the reserve (0.8 - 0.3 = 0.5), NOT the
    // phantom 2 SOL, and NOT the whole 0.8 (that would eat the fee buffer).
    assert.ok(Math.abs(t!.baseQty - 0.5) < 1e-9, `fill qty=${t!.baseQty} (expected 0.5 = 0.8 - 0.3 reserve)`);
  } finally {
    process.env.SOL_FEE_RESERVE_SOL = '0.01';
  }
});

test('H2: quote deviating >3% from oracle is rejected, nothing sent, lock released', async () => {
  const stub: StubState = { balances: { SOL: 1, USDC: 500 }, impliedOutPerIn: 91, builds: 0, submits: 0 };
  const { broker, oracle } = rig(stub); // oracle at $100, quote implies $91 (-9%)

  const order = sellOrder(0.5);
  await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
    .executeSwap(order, 'SELL');

  assert.equal(stub.builds, 1, 'build happened (quote obtained)');
  assert.equal(stub.submits, 0, 'NOT submitted — quote failed sanity vs oracle');
  assert.equal(
    (broker as unknown as { inFlight: Set<string> }).inFlight.has(order.id),
    false, 'lock released for retry'
  );
  assert.equal(order.status, 'OPEN', 'order stays OPEN');
  // Sanity: same rig passes when the quote is within tolerance.
  stub.impliedOutPerIn = 100.5;
  await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
    .executeSwap(order, 'SELL');
  assert.equal(stub.submits, 1, 'in-tolerance quote submits fine');
  assert.ok(oracle.current > 0);
});

test('H2: BUY path equally gated (implied price far above oracle rejected)', async () => {
  const stub: StubState = { balances: { SOL: 1, USDC: 500 }, impliedOutPerIn: 0.009, builds: 0, submits: 0 };
  const { broker } = rig(stub);
  // BUY $50 USDC -> SOL. impliedPrice = in/out = 1/0.009 = $111 per SOL vs $100
  // oracle => +11% deviation => reject.
  const order: Order = {
    id: 'test-buy', kind: 'DCA_BUY', side: 'BUY', price: 100,
    baseQty: 0, quoteQty: 50, status: 'OPEN', createdAt: Date.now(),
    mode: 'live', strategyId: 'dca', note: 'test',
  };
  await (broker as unknown as { executeSwap(o: Order, s: 'BUY' | 'SELL'): Promise<void> })
    .executeSwap(order, 'BUY');
  assert.equal(stub.builds, 1);
  assert.equal(stub.submits, 0, 'bad BUY quote must not be sent');
  assert.equal(
    (broker as unknown as { inFlight: Set<string> }).inFlight.has(order.id),
    false, 'lock released'
  );
});

test('cleanup: restore live-guard defaults for other suites', () => {
  resetLiveGuards(); // DRY_RUN=true, KILL_SWITCH=false
});

test('fee-floor step: live grid never spaces levels below round-trip fee + margin', () => {
  const { broker, c } = rig({ balances: { SOL: 1, USDC: 500 }, impliedOutPerIn: 100, builds: 0, submits: 0 });
  c.strategies.grid.usdcPerGrid = 32;

  const step = broker.minProfitStepUsd(105);
  // Mirror the documented formula: (2 * fee(levelNotional)) / levelQty * 1.2
  // fee(32) = 0.002 + 32*0.001 = 0.034 -> round trip 0.068 -> qty 32/105
  const expected = ((2 * (0.002 + 32 * 0.001)) / (32 / 105)) * 1.2;
  assert.ok(Math.abs(step - expected) < 1e-9, `step=${step} expected=${expected}`);
  assert.ok(step > 0, 'floor must be positive (was hardcoded 0 — fee-losing waves)');

  // Degenerate inputs degrade to 0 (never NaN/Infinity into buildLadder).
  assert.equal(broker.minProfitStepUsd(0), 0);
  assert.ok(Number.isFinite(broker.minProfitStepUsd(-5)));

  // Tighter notional -> higher floor per $ (fixed fee amortizes worse), and the
  // floor scales so each level's round trip always clears fees + 20%.
  c.strategies.grid.usdcPerGrid = 8;
  const stepSmall = broker.minProfitStepUsd(105);
  assert.ok(stepSmall > step, 'smaller levels need proportionally wider steps');
});
