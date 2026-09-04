/**
 * DIRECT PUMP.SWAP EXECUTION PATH for meme slots.
 *
 * Jupiter no longer routes thin graduated pump.fun pools (e.g. CYB's pool
 * returns "Route not found" in both directions), so meme slots configured with
 * a `pumpPool` swap DIRECTLY against the PumpSwap AMM
 * (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) using the official
 * @pump-fun/pump-swap-sdk for instruction construction + AMM math.
 *
 * Design:
 *  - Builds the same swap instructions pump.fun's own frontend uses
 *    (buy: baseOut/maxQuoteIn, sell: baseIn/minQuoteOut), including wSOL
 *    wrap/unwrap, idempotent ATA creation, fee recipients, volume accumulators.
 *  - Returns a `BuiltSwap`, so `JupiterExec.submitBuilt()` remains the single
 *    send boundary: assertLiveAllowed re-checked, native-SOL fee floor,
 *    blockhash-based confirmation, real on-chain fee capture.
 *  - Meme slots trade against the wallet's native SOL (quote side of every
 *    PumpSwap pool). USDC notional ↔ SOL is converted at the live oracle SOL
 *    price, keeping the bot's USDC-denominated bookkeeping exact.
 *  - Slippage is enforced on-chain: buys cap `maxQuoteIn` (slippage-padded),
 *    sells floor `minQuoteOut` (slippage-floored) — the tx reverts rather than
 *    filling through a drained/manipulated pool.
 *  - Never sends: build + sign only. Sending is submitBuilt()'s job, gated.
 */

import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import type { Connection } from '@solana/web3.js';
import type { AppConfig } from './config.js';
import type { BuiltSwap } from './jupiter.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

export interface PumpSwapParams {
  /** PumpSwap pool address (base/quote mints are read from the pool itself). */
  pool: string;
  side: 'BUY' | 'SELL';
  /** BUY: USDC notional to spend (converted to SOL at `solPriceUsd`).
   *  SELL: base-token quantity to sell (human units). */
  amount: number;
  /** Live SOL/USDC price for notional conversion + ledger pricing. */
  solPriceUsd: number;
  /** Slippage ceiling in BPS (slot cap, e.g. 500 = 5%). */
  slippageBps: number;
}

/**
 * Build + sign a direct PumpSwap swap tx (NOT sent). Mirrors the JupiterExec
 * buildSwap contract so the broker can submit via the same submitBuilt() path.
 */
export async function buildPumpSwap(
  cfg: AppConfig,
  conn: Connection,
  signer: Keypair,
  p: PumpSwapParams
): Promise<BuiltSwap> {
  const online = new OnlinePumpAmmSdk(conn);
  const poolKey = new PublicKey(p.pool);

  // Full swap state: pool (mints, reserves, creator, coin creator), global
  // config, fee config, user token accounts. Throws if the pool is closed.
  const st = await online.swapSolanaState(poolKey, signer.publicKey);

  const baseMint = st.pool.baseMint;
  if (!st.pool.quoteMint.equals(new PublicKey(SOL_MINT))) {
    throw new Error(`pump pool ${p.pool} quote is not SOL — unsupported`);
  }
  const baseDecimals = st.baseMintAccount.decimals;
  // SDK slippage is a percentage (0.05 = 5%).
  const slippagePct = Math.max(0.01, Math.min(50, p.slippageBps / 100));

  const quoteArgs = {
    slippage: slippagePct,
    baseReserve: st.poolBaseAmount,
    quoteReserve: st.poolQuoteAmount,
    virtualQuoteReserves: st.pool.virtualQuoteReserves,
    globalConfig: st.globalConfig,
    baseMintAccount: st.baseMintAccount,
    baseMint,
    coinCreator: st.pool.coinCreator,
    creator: st.pool.creator,
    feeConfig: st.feeConfig,
  };

  let ixs;
  let expectedOutAmount: number;
  let inputMint: string;
  let outputMint: string;

  if (p.side === 'BUY') {
    if (!(p.solPriceUsd > 0)) throw new Error('pump BUY: no live SOL price');
    if (!(p.amount > 0)) throw new Error('pump BUY: non-positive amount');
    // USDC notional -> lamports of SOL to spend.
    const quoteLamports = new BN(
      Math.round((p.amount / p.solPriceUsd) * LAMPORTS).toString()
    );
    // Spend exactly `quote` SOL, receive `base` base tokens after fees;
    // `maxQuote` is the slippage-padded spend cap the program enforces.
    const q = buyQuoteInput({ quote: quoteLamports, ...quoteArgs });
    ixs = await PUMP_AMM_SDK.buyInstructions(st, q.base, q.maxQuote);
    expectedOutAmount = Number(q.base.toString()) / 10 ** baseDecimals;
    inputMint = SOL_MINT;
    outputMint = baseMint.toBase58();
  } else {
    if (!(p.amount > 0)) throw new Error('pump SELL: non-positive base amount');
    const baseRaw = new BN(
      Math.round(p.amount * 10 ** baseDecimals).toString()
    );
    // Sell exactly `base` tokens, receive `uiQuote` SOL after fees;
    // `minQuote` is the slippage-floored on-chain minimum.
    const q = sellBaseInput({ base: baseRaw, ...quoteArgs });
    ixs = await PUMP_AMM_SDK.sellInstructions(st, baseRaw, q.minQuote);
    expectedOutAmount = Number(q.uiQuote.toString()) / LAMPORTS;
    inputMint = baseMint.toBase58();
    outputMint = SOL_MINT;
  }

  if (!ixs.length) throw new Error('pump swap: no instructions built');
  if (!(expectedOutAmount > 0)) {
    throw new Error(`pump swap: quote math produced ${expectedOutAmount} out`);
  }

  // Priority fee via the same env knob the Jupiter path tunes.
  const cuPrice = Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? '200000');
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...ixs,
  ];

  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);

  return { tx, inputMint, outputMint, expectedOutAmount };
}
