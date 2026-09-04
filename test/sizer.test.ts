// ---------------------------------------------------------------------------
// WALLET-AWARE SIZING — budgets derived from real equity, nothing hardcoded
// ---------------------------------------------------------------------------
// Verifies:
//   1. snapshot() derives every budget as a % of real wallet equity and the
//      apply() step mutates ALL books — grid per-level, DCA per-buy (was
//      hardcoded), DCA VA target, CYB ring-fence cap, hard-stop reference.
//   2. applyWithHysteresis(): ordinary price wobble (< threshold) does NOT
//      rewrite budgets; a real deposit (>= threshold) does. This is what makes
//      "adding more to the wallet later" rescale automatically.
//   3. Small-wallet floors: budgets never collapse below sane minimums.
// Uses a stubbed JupiterExec (balances + 1-SOL quote) — no network.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { WalletSizer } from '../src/sizer.js';
import type { JupiterExec } from '../src/jupiter.js';
import { Keypair } from '@solana/web3.js';

process.env.NODE_ENV = 'test';

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
    vaEnabled: true, vaTargetSol: 1, vaHorizonBuys: 30,
  },
  memes: [{
    id: 'cyb', enabled: true, maxUsdcPosition: 200, targetDepositPct: 50,
    takeProfitRungsPct: [20, 50, 100], trailFromFirstRungPct: 10,
    maxSlippageBps: 100, cooldownMinutes: 30, exitIlliquidBookPct: 95,
    minLiquidityUsd: 25_000, minVolume24hUsd: 50_000,
  } as never],
};

function cfg(): AppConfig {
  return {
    mode: 'live', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

/** Stub the WalletSizer calls: native SOL + tokenBalance + 1-SOL quote. */
function stubJup(balances: { sol: number; usdc: number; solUsd: number }): JupiterExec {
  return {
    nativeSolBalance: async () => balances.sol,
    tokenBalance: async (_o: unknown, mint: string) =>
      mint === SOL ? balances.sol : mint === USDC ? balances.usdc : 0,
    quote: async () => ({ outAmount: balances.solUsd }),
  } as unknown as JupiterExec;
}

const signer = Keypair.generate();

test('sizer derives all budgets from real equity and mutates every book', async () => {
  const c = cfg();
  // $1,500 USDC + 2 SOL @ $105 = $1,710 equity.
  const sizer = new WalletSizer(c, stubJup({ sol: 2, usdc: 1500, solUsd: 105 }));
  const w = await sizer.apply(signer);

  assert.ok(Math.abs(w.totalUsd - 1710) < 0.01, `equity=${w.totalUsd}`);

  // Grid: 15% of equity over 8 levels.
  assert.ok(Math.abs(c.strategies.grid.usdcPerGrid - Math.round(1710 * 0.15 / 8)) < 1,
    `grid/level=${c.strategies.grid.usdcPerGrid}`);
  // DCA per-buy: 35% budget spread over the 30-buy horizon (was hardcoded 10).
  const dcaPerBuy = 1710 * 0.35 / 30;
  assert.ok(Math.abs(c.strategies.dca.usdcAmountPerBuy - dcaPerBuy) < 0.02,
    `dca/buy=${c.strategies.dca.usdcAmountPerBuy} expected ~${dcaPerBuy.toFixed(2)}`);
  // DCA VA target = budget / SOL price / 2.
  assert.ok(Math.abs(c.strategies.dca.vaTargetSol - (1710 * 0.35) / 105 / 2) < 0.01,
    `vaTarget=${c.strategies.dca.vaTargetSol}`);
  // CYB cap: 10% of equity (was 200).
  assert.equal(c.strategies.memes[0].maxUsdcPosition, Math.round(171),
    `cyb cap=${c.strategies.memes[0].maxUsdcPosition}`);
  // Hard-stop reference: 60% deployable (40% reserve), NOT the raw .env 400.
  assert.equal(c.risk.maxUsdcPosition, Math.round(1710 * 0.6),
    `hard-stop ref=${c.risk.maxUsdcPosition}`);
});

test('hysteresis: price wobble does NOT rescale; a real deposit DOES', async () => {
  const c = cfg();
  const bal = { sol: 2, usdc: 1500, solUsd: 105 };
  const jup = stubJup(bal);
  const sizer = new WalletSizer(c, jup);
  await sizer.apply(signer); // startup sizing: baseline applied
  const gridAfterStart = c.strategies.grid.usdcPerGrid;
  const dcaAfterStart = c.strategies.dca.usdcAmountPerBuy;

  // SOL rallies 8% ($105 -> $113.40): equity +~1.4% (2 SOL of $1,710).
  // Under the 10% hysteresis threshold -> budgets must NOT be rewritten.
  bal.solUsd = 113.40;
  const wobbled = await sizer.applyWithHysteresis(signer);
  assert.equal(wobbled, null, 'price wobble under threshold must be skipped');
  assert.equal(c.strategies.grid.usdcPerGrid, gridAfterStart, 'grid unchanged');
  assert.equal(c.strategies.dca.usdcAmountPerBuy, dcaAfterStart, 'dca unchanged');

  // Deposit $600 USDC ($1,500 -> $2,100, +~35% equity): MUST rescale.
  bal.usdc = 2100;
  const deposited = await sizer.applyWithHysteresis(signer);
  assert.ok(deposited, 'deposit above threshold must re-apply');
  assert.ok(Math.abs(deposited!.totalUsd - (2100 + 2 * 113.40)) < 0.01);
  assert.ok(
    c.strategies.grid.usdcPerGrid > gridAfterStart,
    `grid rescaled up: ${gridAfterStart} -> ${c.strategies.grid.usdcPerGrid}`
  );
  assert.ok(
    c.strategies.dca.usdcAmountPerBuy > dcaAfterStart,
    `dca rescaled up: ${dcaAfterStart} -> ${c.strategies.dca.usdcAmountPerBuy}`
  );
  assert.equal(c.strategies.memes[0].maxUsdcPosition, Math.round((2100 + 2 * 113.4) * 0.1));
});

test('small-wallet floors: budgets never collapse below sane minimums', async () => {
  const c = cfg();
  // Tiny wallet: $50 USDC, no SOL, cheap SOL -> tiny derived budgets.
  const sizer = new WalletSizer(c, stubJup({ sol: 0, usdc: 50, solUsd: 50 }));
  await sizer.apply(signer);
  assert.ok(c.strategies.grid.usdcPerGrid >= 5, `grid floor, got ${c.strategies.grid.usdcPerGrid}`);
  assert.ok(c.strategies.dca.usdcAmountPerBuy >= 1, `dca floor, got ${c.strategies.dca.usdcAmountPerBuy}`);
  assert.ok(c.strategies.memes[0].maxUsdcPosition >= 5, 'cyb floor');
  assert.ok(c.risk.maxUsdcPosition >= 5, 'hard-stop ref floor');
});
