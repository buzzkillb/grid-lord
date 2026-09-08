// ---------------------------------------------------------------------------
// price24hAgo — the honest 24h window for the dashboard header
// ---------------------------------------------------------------------------
// The header used to divide the portfolio equity curve (first-ever sample,
// including pre-deposit history) by itself and label the result "(24h)" next
// to the SOL price, which read as a fake +214% when deposits landed. The
// oracle now exposes a real 24h-ago price, and it must return 0 (not a lie)
// when there isn't a full 24h of history yet.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { PriceOracle } from '../src/price.js';

process.env.NODE_ENV = 'test';
process.env.STATE_PERSIST = '0';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 10_000, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
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
    mode: 'paper', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

function oracleWithHistory(candles: { ts: number; open: number }[]): PriceOracle {
  const o = new PriceOracle(cfg());
  (o as any).history = candles.map((c) => ({
    ts: c.ts, open: c.open, high: c.open, low: c.open, close: c.open, volumeUsd: 1,
  }));
  return o;
}

test('price24hAgo returns the oldest candle open inside the 24h window', () => {
  const now = Date.now();
  const o = oracleWithHistory([
    { ts: now - 30 * 3600_000, open: 98 }, // spans the 24h edge (validates history depth)
    { ts: now - 23.9 * 3600_000, open: 100 }, // oldest sample inside the 24h window
    { ts: now - 2 * 3600_000, open: 104 },
    { ts: now - 3600_000, open: 105 },
  ]);
  assert.equal(o.price24hAgo(), 100);
});

test('price24hAgo returns 0 when history does not span the full window', () => {
  const now = Date.now();
  const o = oracleWithHistory([
    { ts: now - 3 * 3600_000, open: 104 }, // only 3h of data -> no honest 24h read
    { ts: now - 3600_000, open: 105 },
  ]);
  assert.equal(o.price24hAgo(), 0);
});

test('price24hAgo returns 0 with no history at all', () => {
  const o = oracleWithHistory([]);
  assert.equal(o.price24hAgo(), 0);
});
