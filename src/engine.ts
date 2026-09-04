import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';
import { PriceOracle } from './price.js';
import { PaperBroker } from './paperBroker.js';
import { LiveBroker } from './liveBroker.js';
import { GridStrategy } from './gridStrategy.js';
import { DcaStrategy } from './dcaStrategy.js';

import { MemeStrategy } from './meme.js';
import { WalletSizer } from './sizer.js';
import { JupiterExec, killLiveExecution, liveExecutionKilled, dryRunEnabled } from './jupiter.js';
import { notify } from './notify.js';
import type { Keypair } from '@solana/web3.js';

const sizerRecheckMin = (): number => {
  const v = Number(process.env.WALLET_RECHECK_MIN || 30);
  return Number.isFinite(v) && v >= 1 ? v : 30;
};

/**
 * Orchestrates price feed, strategies, and broker. Runs a poll loop that:
 *  1. Fetches price
 *  2. Fills any crossing limit orders
 *  3. Runs strategies (grid replenish + DCA)
 *  4. Applies the hard stop / risk checks
 *  5. Emits a snapshot for the dashboard
 */
export class StrategyEngine {
  private broker: PaperBroker | LiveBroker;
  private grid!: GridStrategy;
  private dca: DcaStrategy;
  private timer?: ReturnType<typeof setInterval>;
  private resizeTimer?: ReturnType<typeof setInterval>;
  private persistTimer?: ReturnType<typeof setInterval>;
  private lastResizeReport = '';
  private gridHandled = new Set<string>();
  private stalePolls = 0;
  private memes: MemeStrategy[] = [];
  private signer?: Keypair;
  private sizer?: WalletSizer;
  /** True while a tick is still in flight. Guards against overlapping ticks if
   *  the async work (Jupiter quote + live balance sync) ever outlives the poll
   *  interval — a second tick would otherwise re-scan orders/risk mid-update
   *  and could double-send or double-count a fill. */
  private ticking = false;

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private priceOracle: PriceOracle,
    signer?: Keypair
  ) {
    if (cfg.mode === 'live') {
      if (!signer) throw new Error('Live mode requires a keypair signer');
      this.broker = new LiveBroker(cfg, store, priceOracle, signer);
      console.log(`   Execution: LIVE (Jupiter swaps on real wallet, dry-run ${dryRunEnabled() ? 'ON — orders will NOT send' : 'OFF — REAL FUNDS'})`);
      this.signer = signer;
      if (WalletSizer.enabled(cfg)) {
        // Dedicated sizer instance (does not replace the startup report in bot.ts).
        this.sizer = new WalletSizer(cfg, new JupiterExec(cfg));
      }
    } else {
      this.broker = new PaperBroker(cfg, store, priceOracle);
    }
    this.grid = new GridStrategy(cfg, store, this.broker, priceOracle);
    this.dca = new DcaStrategy(cfg, store, this.broker, priceOracle);
    // Self-contained meme strategies (one per config slot) — they own their own
    // real GeckoTerminal feed and ring-fenced budget. No SOL-path coupling here.
    // In LIVE mode they route their fills through the LiveBroker so the meme
    // slot actually trades the real token on-chain (H2) — never simulates.
    this.memes = cfg.strategies.memes
      .filter((m) => m.enabled)
      .map(
        (slot) =>
          new MemeStrategy(cfg, store, slot, cfg.mode === 'live' ? this.broker : undefined)
      );
  }

  start(): void {
    if (this.store.price > 0 && !this.grid.isInitialized()) {
      this.grid.initialize();
    }
    for (const m of this.memes) m.start();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollIntervalMs);
    this.timer.unref?.();

    // PROFIT / DEPOSIT RE-SIZING: periodically re-read the real wallet and
    // re-derive budgets so realized profits and stage-added funds are swept
    // into sizing automatically, without a restart.
    if (this.sizer && this.signer) {
      const mins = sizerRecheckMin();
      this.resizeTimer = setInterval(() => void this.resizeNow(), mins * 60_000);
      this.resizeTimer.unref?.();
      console.log(`   Wallet re-sizing: every ${mins} min (auto-sweeps profits/deposits)`);
    }

    // CRASH RECOVERY (#7): persist runtime state periodically so a restart
    // reconciles positions/pnl/trailing signals instead of resetting them.
    this.persistTimer = setInterval(() => {
      if (!this.store.paused) this.store.persistNow();
    }, 30_000);
    this.persistTimer.unref?.();
  }

  /** Re-derive budgets from the current real wallet balance. */
  private async resizeNow(): Promise<void> {
    if (!this.sizer || !this.signer) return;
    try {
      // HYSTERESIS: only rewrite budgets when equity actually moved (deposit,
      // withdrawal, or accumulated PnL) — not on ordinary SOL price wobble.
      // Price drift under the threshold would otherwise churn the grid ladder.
      const w = await this.sizer.applyWithHysteresis(this.signer);
      if (!w) return;
      const line =
        `[re-size] equity ${w.totalUsd.toFixed(0)} | ` +
        `grid ${this.cfg.strategies.grid.usdcPerGrid}/lvl | ` +
        `DCA ~${this.cfg.strategies.dca.usdcAmountPerBuy.toFixed(2)}/buy ` +
        `(target ${this.cfg.strategies.dca.vaTargetSol.toFixed(2)} SOL) | ` +
        `CYB ${this.cfg.strategies.memes[0]?.maxUsdcPosition}`;
      // Only log when something changed to avoid a periodic-print wall.
      if (line !== this.lastResizeReport) {
        console.log(line);
        this.lastResizeReport = line;
      }
    } catch (e) {
      console.warn(`[re-size] could not refresh wallet sizing: ${(e as Error).message}`);
    }
  }

  async tick(): Promise<void> {
    // NON-RE-ENTRANT: if the previous tick's async work (Jupiter quote + live
    // balance sync) hasn't finished, skip this poll rather than overlapping.
    // Overlapping ticks on a bright executor would double-scan orders/risk and
    // could double-send a swap or double-credit a fill.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.priceOracle.fetchNow();
      this.store.price = this.priceOracle.current;

    // LIVE: keep the risk/accounting layer in sync with real on-chain balances
    // so the hard stop, unrealized draw-down guard, PnL and equity curve all
    // reflect actual wallet state (C1) — never a stale persisted zero.
    if (this.cfg.mode === 'live' && this.broker instanceof LiveBroker) {
      await this.broker.syncBalances();
      await this.broker.syncPosition(this.store.price);
    }

    // STALE-PRICE SAFETY: if the source went down and we can't refresh, stop
    // acting on a frozen price rather than trading on stale data.
    //
    // The circuit-breaker keys off the PRIMARY execution venue (Jupiter), not
    // the CoinGecko fallback, so a live run hard-halts when the venue it
    // actually trades on goes stale even while a fallback price page keeps a
    // number on screen (M2).
    if (!this.priceOracle.currentGeneratingFresh || !this.priceOracle.jupiterFresh) {
      this.stalePolls = (this.stalePolls ?? 0) + 1;
      if (this.stalePolls >= this.cfg.risk.maxStalePricePolls) {
        console.warn(
          `[risk] price source (jupiter execution venue) stale for ${this.stalePolls} polls; holding (not trading on stale price)`
        );
        // AUTO CIRCUIT-BREAKER (#9): the actual execution venue is down for the
        // full stale window — hard-halt the swap path in live mode instead of
        // risking a stale-decision swap when data returns unexpectedly.
        if (this.cfg.risk.autoCircuitBreaker && this.cfg.mode === 'live' && !liveExecutionKilled()) {
          killLiveExecution();
          notify('critical', '🚨 AUTO CIRCUIT-BREAKER: Jupiter execution venue stale — live swap path halted. Check feeds before re-arming.');
        }
        this.store.snapshot(this.cfg);
        return;
      }
    } else {
      this.stalePolls = 0;
    }

    // Initialize grid once we have a price
    if (!this.grid.isInitialized() && this.store.price > 0) {
      this.grid.initialize();
    } else if (this.grid.isInitialized()) {
      // Adaptive: re-center the grid around the live market as it drifts.
      this.grid.checkReanchor();
    }

    // Fill crossing limit orders
    this.broker.onPriceChange();

    // Handle replenishment for any newly filled grid orders
    for (const order of this.store.orders) {
      if (order.status === 'FILLED' && !this.gridHandled.has(order.id)) {
        this.grid.onFill(order);
        this.gridHandled.add(order.id);
      }
    }
    // BOUND THE HANDLED-SET (was an unbounded leak): once an order is trimmed
    // out of the capped `orders` array it can never be processed again, so its
    // id must drop out of `gridHandled` too. Rebuild the set from the current
    // orders whenever it grows past a cap so a long-lived daemon never
    // accumulates thousands of stale ids in memory.
    if (this.gridHandled.size > 1024) {
      const live = new Set(this.store.orders.map((o) => o.id));
      for (const id of this.gridHandled) if (!live.has(id)) this.gridHandled.delete(id);
    }

    // Feature 2 (deadzone): promote any pending re-arms whose deadzone cleared.
    this.grid.processPendingArms();

    // Self-healing: re-arm any grid level that lost its resting order (e.g. a
    // re-anchor rebuild ran while the trend filter suppressed a side, or a
    // deadzone re-arm was dropped when its guard blocked it). Runs every poll
    // so the bot recovers from glitched/stale arm state without a restart.
    this.grid.sweepArms();

    // Run DCA
    this.dca.tick();

    // Risk: hard stop
    this.applyHardStop();

    // Emit snapshot (with rolling market context for the dashboard)
    this.store.snapshot(this.cfg, this.marketContext());
    } finally {
      // Always clear the re-entrancy lock, even on the early-return stale path
      // or if anything above threw.
      this.ticking = false;
    }
  }

  /** Build the market-context object the dashboard uses (VWAP + 24h range). */
  private marketContext(): { vwap: number; high24h: number; low24h: number } {
    return {
      vwap: this.priceOracle.vwap,
      high24h: this.priceOracle.recentHigh(24 * 60),
      low24h: this.priceOracle.recentLow(24 * 60),
    };
  }

  private applyHardStop(): void {
    if (this.store.paused) return;
    const maxUsdc = this.cfg.risk.maxUsdcPosition;
    if (maxUsdc <= 0) return;

    // (1) REALIZED hard-stop: cumulative banked losses breach the cap.
    const realized = this.store.account.realizedPnlUsd;
    if (realized <= -maxUsdc * this.cfg.risk.hardStopPct) {
      this.store.paused = true;
      this.store.pauseReason = `realized loss ${realized.toFixed(2)} <= -${(
        maxUsdc * this.cfg.risk.hardStopPct
      ).toFixed(2)}`;
      console.warn(
        `[risk] HARD STOP triggered: realized PnL ${realized.toFixed(2)} ` +
          `<= -${(maxUsdc * this.cfg.risk.hardStopPct).toFixed(2)}. Strategy paused.`
      );
      notify('critical', `🚨 HARD STOP: realized PnL ${realized.toFixed(2)}. Bot paused. Take action.`);
      return;
    }

    // (2) UNREALIZED draw-down guard: the OPEN SOL basket is underwater by more
    // than the unrealized threshold. A falling market can bleed unrealized PnL
    // far beyond the realized stop before anything closes; halting new
    // deployment here stops us averaging into a falling knife. (Meme slots are
    // ring-fenced and handled inside their own strategy.)
    const unrealPct = this.cfg.risk.unrealizedHardStopPct;
    if (unrealPct > 0) {
      const unreal = this.store.unrealizedPnlUsd();
      if (unreal <= -maxUsdc * unrealPct) {
        this.store.paused = true;
        this.store.pauseReason = `unrealized loss ${unreal.toFixed(2)} <= -${(
          maxUsdc * unrealPct
        ).toFixed(2)}`;
        console.warn(
          `[risk] UNREALIZED draw-down: open PnL ${unreal.toFixed(2)} ` +
            `<= -${(maxUsdc * unrealPct).toFixed(2)}. New deployment paused ` +
            `(open book too underwater); sell/take-profit legs still active.`
        );
        notify('critical', `🌊 UNREALIZED draw-down: open PnL ${unreal.toFixed(2)}. New deployment paused.`);
        return;
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.resizeTimer) clearInterval(this.resizeTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    // Persist a final copy of recoverable state on graceful shutdown.
    this.store.persistNow();
  }
}
