import { loadConfig } from './config.js';
import { JupiterExec } from './jupiter.js';

/**
 * Live quote test: hits Jupiter's public API (no key, no CEX) and prints the
 * best on-chain route for swapping SOL -> USDC. This verifies the execution
 * pipeline end-to-end before we ever touch real funds.
 *
 * Run: npm run quote
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const jup = new JupiterExec(cfg);
  const g = cfg.strategies.grid;

  // Swap a small, fixed notional of SOL -> USDC. 0.1 SOL (~$10) is enough to
  // get a realistic route + price impact without moving the market.
  const solAmount = 0.1;
  console.log(`Fetching live Jupiter quote: ${solAmount} SOL -> USDC …\n`);

  try {
    const quote = await jup.quote(g.baseMint, g.quoteMint, solAmount, 'BUY');
    const impliedPrice = quote.inAmount > 0 ? quote.outAmount / quote.inAmount : 0;
    console.log('✅ Live route found (on-chain, no key, free Jupiter API):');
    console.log(`   In      : ${quote.inAmount.toFixed(6)} SOL`);
    console.log(`   Out     : ${quote.outAmount.toFixed(2)} USDC`);
    console.log(`   Rate    : 1 SOL ≈ ${impliedPrice.toFixed(2)} USDC`);
    console.log(`   Impact  : ${quote.priceImpactPct.toFixed(4)}%`);
  } catch (e) {
    console.error('❌ Quote failed — check RPC / network connectivity:');
    console.error(`   ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

main();
