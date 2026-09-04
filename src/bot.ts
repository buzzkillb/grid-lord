import { loadConfig } from './config.js';
import { StateStore } from './store.js';
import { PriceOracle } from './price.js';
import { StrategyEngine } from './engine.js';
import { DashboardServer } from './server.js';
import { loadKeypair, pubkeyString } from './wallet.js';
import { liveExecutionKilled, setDryRun, JupiterExec } from './jupiter.js';
import { WalletSizer } from './sizer.js';

const PORT = Number(process.env.PORT || 3000);

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`\ngrid-lord starting (mode: ${cfg.mode})`);
  console.log(`   RPC: ${cfg.rpcUrl}`);

  const keypair = loadKeypair(cfg);
  if (cfg.mode === 'paper') {
    console.log('   Wallet: PAPER (throwaway keypair, no real funds touched)');
  } else {
    console.log(`   Wallet: ${pubkeyString(keypair)}`);
    // LIVE SAFETY: even in live mode we stay dry-run unless LIVE_ARM=1 is
    // explicitly set. This is the user's deliberate go-live signal.
    if (process.env.LIVE_ARM === '1') {
      setDryRun(false);
      console.log('   ⚠️  LIVE_ARM detected — REAL FUNDS MAY BE SWAPPED. Proceed carefully.');
    } else {
      setDryRun(true);
      console.log(
        '   🔒 LIVE mode but DRY-RUN: swaps are built+validated but NOT sent.\n' +
        '      Set LIVE_ARM=1 to actually trade real funds (after confirming the wallet).'
      );
    }
    console.log(`   Kill-switch armed: ${liveExecutionKilled() ? 'YES (disabled)' : 'no'}`);

    // WALLET-AWARE SIZING: read real on-chain balances and derive budgets from
    // actual equity. Runs in live mode (dry or armed) so you see the numbers
    // before arming. Kept to the SOURCE of truth: real wallet, not hardcoded.
    if (WalletSizer.enabled(cfg)) {
      try {
        const jup = new JupiterExec(cfg);
        const sizer = new WalletSizer(cfg, jup);
        const w = await sizer.apply(keypair);
        console.log('   ── Wallet sizing (derived from real balances) ──');
        console.log(`     native SOL : ${w.sol.toFixed(4)}  (@ ${w.solUsd.toFixed(2)})`);
        console.log(`     USDC       : ${w.usdc.toFixed(2)}`);
        console.log(`     total equity: ${w.totalUsd.toFixed(2)}`);
        console.log(`     SOL grid    : ${cfg.strategies.grid.usdcPerGrid || 'auto'}/level base`);
        console.log(`     DCA budget  : ~${w.derived.dcaBudgetUsd.toFixed(0)} (target ${cfg.strategies.dca.vaTargetSol.toFixed(2)} SOL)`);
        const m0 = cfg.strategies.memes[0];
        if (m0) console.log(`     ${m0.id.toUpperCase()} cap    : ${cfg.strategies.memes[0].maxUsdcPosition}`);
        console.log(`     hard-stop ref: ${cfg.risk.maxUsdcPosition} (25% = -${(cfg.risk.maxUsdcPosition * 0.25).toFixed(0)})`);
        console.log('   ──────────────────────────────────────────────');
      } catch (e) {
        console.warn(
          `   [sizer] could not read wallet balances: ${(e as Error).message}. ` +
            `Falling back to configured (hardcoded) budgets.`
        );
      }
    }
  }

  const store = new StateStore(cfg);
  const priceOracle = new PriceOracle(cfg);
  const engine = new StrategyEngine(
    cfg,
    store,
    priceOracle,
    cfg.mode === 'live' ? keypair : undefined
  );

  priceOracle.on('error', (e) => {
    console.warn(`[price] error: ${(e as Error).message}`);
  });
  priceOracle.on('warn', (msg: string) => {
    console.warn(msg);
  });

  // Dashboard
  const dashboard = new DashboardServer({ cfg, store, port: PORT });
  dashboard.start(() => {
    console.log(`   Dashboard: http://localhost:${PORT}`);
  });

  // Kick off the engine (runs its own poll loop)
  engine.start();
  await priceOracle.fetchNow();

  const shutdown = () => {
    console.log('\nShutting down...');
    engine.stop();
    priceOracle.stop();
    dashboard.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Print a live line on each snapshot for terminal visibility.
  store.on('snapshot', (s) => {
    const { price, account } = s;
    console.log(
      `[${new Date(s.ts).toLocaleTimeString()}] SOL ${price.toFixed(2)} | ` +
        `PnL ${account.realizedPnlUsd.toFixed(2)} | ` +
        `open ${account.openQty.toFixed(4)} SOL | ` +
        `order ${s.orders.filter((o: { status: string }) => o.status === 'OPEN').length} | ` +
        (s.risk.paused ? 'PAUSED' : 'running')
    );
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
