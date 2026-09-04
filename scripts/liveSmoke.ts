// ---------------------------------------------------------------------------
// LIVE TX SMOKE TEST RIG — real txs through the bot's REAL execution path.
// Run with:  RUN_LIVE_TX_SMOKE=1 npx tsx scripts/liveSmoke.ts
//
// Tests, tiny amounts, bot's own code path (loadConfig -> loadWallet ->
// JupiterExec.buildSwap -> submitBuilt, gates fully armed):
//   1. SELL: 0.01 SOL -> USDC   (creates the USDC leg; exercises fee floor
//                               pre-check, quote sanity gate, submit path)
//   2. BUY:  ~1 USDC -> SOL     (exercises wSOL wrap/unwrap on the buy side)
//   3. Meme: ~1 USDC -> CYB, then sell all CYB back (bot's real meme mint
//            from config, real 5% slippage ceiling)
//   4. Ledger reconciliation: SPL/SOL balance deltas, txids for explorer
//
// Each tx is a single deliberate broadcast with on-chain confirmation polling.
// ---------------------------------------------------------------------------

import { loadConfig } from '../src/config.js';
import { loadKeypair, pubkeyString } from '../src/wallet.js';
import { JupiterExec } from '../src/jupiter.js';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// LIVE GATES — this script is the deliberate human go signal.
process.env.TRADE_MODE = 'live';
process.env.DRY_RUN = '0';

// The submit boundary reads the module-level DRY_RUN flag (bot.ts flips it at
// startup via setDryRun). We arm live sending deliberately here, mirroring
// bot.ts's live branch, and verify the flag took before touching funds.
import { setDryRun, dryRunEnabled } from '../src/jupiter.js';
setDryRun(false);
if (dryRunEnabled()) throw new Error('DRY_RUN flag did not clear — refusing to send');

const cfg = loadConfig();
const signer = loadKeypair(cfg);
const jup = new JupiterExec(cfg);
const conn = new Connection(cfg.rpcUrl, 'confirmed');

const log = (m: string) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${m}`);
const mintName = (m: string) => (m === SOL_MINT ? 'SOL' : m === USDC_MINT ? 'USDC' : m.slice(0, 4) + '…');

async function splBalance(owner: PublicKey, mint: string): Promise<number> {
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let total = 0;
  for (const a of r.value) {
    total += a.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  }
  return total;
}

async function balances(cybMint: string | null) {
  return {
    sol: (await conn.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL,
    usdc: await splBalance(signer.publicKey, USDC_MINT),
    cyb: cybMint ? await splBalance(signer.publicKey, cybMint) : 0,
  };
}

/** Build -> submit -> confirm one tiny swap. Returns txid. */
async function swapOnce(
  label: string,
  inputMint: string,
  outputMint: string,
  inAmount: number,
  slippageBps: number,
): Promise<string> {
  log(`${label}: building (${inAmount} ${mintName(inputMint)} -> ${mintName(outputMint)}) …`);
  const built = await jup.buildSwap(
    { inputMint, outputMint, inAmount, side: inputMint === USDC_MINT ? 'BUY' : 'SELL', slippageBps },
    signer,
  );
  log(`${label}: built ok, expected out ${built.expectedOutAmount.toFixed(6)} ${mintName(built.outputMint)}`);

  const res = await jup.submitBuilt(built, signer);
  if (!res.ok || !res.txid) throw new Error(`${label} FAILED: ${res.error ?? 'no txid'}`);
  log(`${label}: broadcast → ${res.txid}`);

  for (let i = 0; i < 30; i++) {
    const s = await conn.getSignatureStatuses([res.txid]);
    const st = s.value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
      if (st.err) throw new Error(`${label} tx ${res.txid} FAILED ON-CHAIN: ${JSON.stringify(st.err)}`);
      log(`${label}: confirmed ✅`);
      return res.txid;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: tx ${res.txid} not confirmed in 45s`);
}

// --- main ---
const cybSlot = cfg.strategies.memes.find((m) => m.id === 'cyb' && m.enabled);
const cybMint = cybSlot?.baseMint ?? null;

log(`wallet ${pubkeyString(signer)} | mode=${cfg.mode} DRY_RUN=0`);
const b0 = await balances(cybMint);
log(`start: SOL ${b0.sol.toFixed(6)} | USDC ${b0.usdc.toFixed(4)} | CYB ${b0.cyb.toFixed(2)}`);

// 1) SELL 0.01 SOL -> USDC (skipped on resume if the USDC leg already exists)
const usdcPre = await splBalance(signer.publicKey, USDC_MINT);
if (usdcPre >= 0.5) {
  log(`1/SELL: skipped — USDC leg already present (${usdcPre.toFixed(4)})`);
} else {
  const tx1 = await swapOnce('1/SELL', SOL_MINT, USDC_MINT, 0.01, 100);
  log(`1/SELL txid: ${tx1}`);
}

// 2) BUY ~1 USDC -> SOL
const usdcNow = await splBalance(signer.publicKey, USDC_MINT);
if (usdcNow < 0.5) throw new Error('no USDC after sell — aborting before BUY');
const tx2 = await swapOnce('2/BUY', USDC_MINT, SOL_MINT, Math.min(1, usdcNow), 100);
log(`2/BUY txid: ${tx2}`);

// 3) Meme smoke: ~1 USDC -> CYB, sell all back
if (!cybSlot) {
  log('3/MEME: skipped — no enabled cyb slot in config');
} else {
  const tx3 = await swapOnce('3/BUY-CYB', USDC_MINT, cybSlot.baseMint, 1, cybSlot.maxSlippageBps);
  log(`3/BUY-CYB txid: ${tx3}`);
  const cybBal = await splBalance(signer.publicKey, cybSlot.baseMint);
  if (cybBal > 0) {
    const tx4 = await swapOnce('3/SELL-CYB', cybSlot.baseMint, USDC_MINT, cybBal, cybSlot.maxSlippageBps);
    log(`3/SELL-CYB txid: ${tx4}`);
  } else {
    log('3/SELL-CYB: skipped — no CYB balance arrived');
  }
}

// 4) Reconciliation
const b1 = await balances(cybMint);
log(`end:   SOL ${b1.sol.toFixed(6)} | USDC ${b1.usdc.toFixed(4)} | CYB ${b1.cyb.toFixed(2)}`);
log(`deltas: SOL ${(b1.sol - b0.sol).toFixed(6)} | USDC ${(b1.usdc - b0.usdc).toFixed(4)} | CYB ${(b1.cyb - b0.cyb).toFixed(2)}`);
log('SMOKE COMPLETE — check the txids above on explorer.solana.com');
