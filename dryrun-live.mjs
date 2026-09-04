import { loadConfig } from './dist/config.js';
import { JupiterExec } from './dist/jupiter.js';
import { Keypair } from '@solana/web3.js';

const cfg = loadConfig();
// Throwaway keypair — NOT the trading wallet. Used only to build (not send).
const signer = Keypair.generate();
const jup = new JupiterExec(cfg);

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CYB = 'J2hyZSVokSTuy3bG85A5xfs3umCeGtqZZEdKtGTTpump';

async function step(label, fn) {
  try {
    const r = await fn();
    console.log('\n[OK] ' + label + ':\n   ' + JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('\n[FAIL] ' + label + ': ' + e.message);
    process.exitCode = 1;
  }
}

await step('quote SOL→USDC ($20)', async () => {
  const q = await jup.quote(SOL, USDC, 20, 'BUY', 100);
  return { inUsdc: q.inAmount, outSol: q.outAmount, impactPct: q.priceImpactPct };
});

await step('quote USDC→CYB ($10, 5% slip)', async () => {
  const q = await jup.quote(USDC, CYB, 10, 'BUY', 500);
  return { inUsd: q.inAmount, outCyb: q.outAmount.toPrecision(6), impactPct: q.priceImpactPct };
});

await step('BUILD + SIGN SOL→USDC swap (dry, not sent)', async () => {
  const built = await jup.buildSwap(
    { inputMint: SOL, outputMint: USDC, inAmount: 0.001, side: 'BUY', slippageBps: 100 },
    signer
  );
  const ser = built.tx.serialize();
  return {
    expectedOutUsdc: built.expectedOutAmount.toFixed(4),
    signatures: built.tx.signatures.length,
    serializedBytes: ser.length,
  };
});

console.log('\n--- done. exitCode=' + (process.exitCode ?? 0) + ' (0 = pipeline valid) ---');
