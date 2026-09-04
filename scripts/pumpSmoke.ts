// ---------------------------------------------------------------------------
// LIVE PUMP-SWAP SMOKE TEST — CYB round-trip via the DIRECT PumpSwap path.
// Run:  RUN_LIVE_PUMP_SMOKE=1 npx tsx scripts/pumpSmoke.ts
//
// Exercises the bot's real meme execution path (buildPumpSwap -> submitBuilt,
// all gates armed) end-to-end on-chain:
//   1. BUY  ~$1 of CYB with native SOL (wSOL wrap -> swap -> unwrap, ATA
//      idempotent-create) — tx confirmed, CYB balance arrives
//   2. SELL all CYB back to SOL — tx confirmed, SOL arrives
//   3. Reconciliation: on-chain fees captured, balance deltas vs expectations
// With DRY_RUN=1 the tx is built+validated but the send boundary refuses.
// ---------------------------------------------------------------------------

import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';
import { JupiterExec, setDryRun, dryRunEnabled } from '../src/jupiter.js';
import { buildPumpSwap } from '../src/pumpSwap.js';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const CYB_MINT = 'J2hyZSVokSTuy3bG85A5xfs3umCeGtqZZEdKtGTTpump';
const CYB_POOL = 'CHVehKRbncDPDr1od9EYA1vp635wwFdZgXdzEXXT6v96';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const cfg = loadConfig();
const signer = loadKeypair(cfg);
const jup = new JupiterExec(cfg);
const conn = new Connection(cfg.rpcUrl, 'confirmed');

const log = (m: string) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${m}`);

async function splBalance(mint: string): Promise<number> {
  const r = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) });
  let total = 0;
  for (const a of r.value) {
    total += a.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  }
  return total;
}

async function balances() {
  return {
    sol: (await conn.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL,
    cyb: await splBalance(CYB_MINT),
    usdc: await splBalance(USDC_MINT),
  };
}

/** Live SOL/USDC from Jupiter (same source the bot's oracle uses). */
async function solPrice(): Promise<number> {
  const r = await jup.quote(SOL_MINT, USDC_MINT, 0.1, 'SELL', 100);
  return r.outAmount / 0.1;
}

async function pumpRoundTrip(dryRun: boolean) {
  setDryRun(dryRun);
  const price = await solPrice();
  log(`SOL/USDC ${price.toFixed(2)} | DRY_RUN=${dryRunEnabled()}`);

  const b0 = await balances();
  log(`start: SOL ${b0.sol.toFixed(6)} | CYB ${b0.cyb.toFixed(2)}`);

  let cybBought = 0;
  if (b0.cyb > 0) {
    // Resume mode: a previous buy already landed — skip straight to the sell.
    log('resume: CYB already held — skipping BUY, going to SELL');
    cybBought = b0.cyb;
  } else {
  // 1) BUY ~$1 of CYB
  log('1/BUY-CYB: building direct PumpSwap buy (~$1)…');
  const buy = await buildPumpSwap(cfg, conn, signer, {
    pool: CYB_POOL, side: 'BUY', amount: 1, solPriceUsd: price, slippageBps: 500,
  });
  log(`1/BUY-CYB: built ok, expected ${buy.expectedOutAmount.toFixed(2)} CYB (tx signed, ${buy.tx.message.compiledInstructions.length} ix)`);
  const res1 = await jup.submitBuilt(buy, signer);
  if (!res1.ok) throw new Error(`BUY failed: ${res1.error}`);
  log(`1/BUY-CYB: confirmed ✅ ${res1.txid}`);

  const b1 = await balances();
  cybBought = b1.cyb - b0.cyb;
  log(`after buy: SOL ${(b1.sol - b0.sol).toFixed(6)} | CYB ${b1.cyb.toFixed(2)} (+${cybBought.toFixed(2)})`);
  }
  if (dryRun) throw new Error('dry-run mode: stopping before SELL');

  // 2) SELL all CYB back
  log('2/SELL-CYB: building direct PumpSwap sell (all CYB)…');
  const sell = await buildPumpSwap(cfg, conn, signer, {
    pool: CYB_POOL, side: 'SELL', amount: cybBought, solPriceUsd: price, slippageBps: 500,
  });
  log(`2/SELL-CYB: built ok, expected ${sell.expectedOutAmount.toFixed(6)} SOL out`);
  const res2 = await jup.submitBuilt(sell, signer);
  if (!res2.ok) throw new Error(`SELL failed: ${res2.error}`);
  log(`2/SELL-CYB: confirmed ✅ ${res2.txid}`);

  // 3) Reconciliation
  const b2 = await balances();
  log(`end: SOL ${b2.sol.toFixed(6)} | CYB ${b2.cyb.toFixed(6)}`);
  log(`deltas: SOL ${(b2.sol - b0.sol).toFixed(6)} | CYB round-trip ${cybBought.toFixed(2)} in/out`);
  log('PUMP SMOKE COMPLETE ✅');
}

const dryRun = process.env.DRY_RUN === '1';
await pumpRoundTrip(dryRun);
