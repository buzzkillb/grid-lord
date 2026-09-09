import type { AppConfig } from './config.js';
import { JupiterExec } from './jupiter.js';
import { Keypair } from '@solana/web3.js';

export interface WalletSnapshot {
  sol: number; // native SOL balance
  usdc: number; // USDC token balance
  solUsd: number; // SOL price in USDC (live Jupiter quote)
  totalUsd: number; // total equity USD = usdc + sol*solUsd
  derived: {
    gridPerLevelUsd: number;
    dcaBudgetUsd: number;
    /** Per-buy USDC for the fixed-cadence DCA leg (budget / VA horizon). */
    dcaPerBuyUsd: number;
    cybCapUsd: number;
    hardStopRefUsd: number;
    reserveUsd: number;
  };
}

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const envNum = (k: string, f: number): number => {
  const v = process.env[k];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : f;
};

/**
 * Wallet-aware sizing. On live startup the bot reads the wallet's actual on-chain
 * SOL + USDC balances and derives every trading budget as a % of that real
 * equity — so sizes scale with the wallet instead of hardcoded caps. It mutates
 * the loaded config in place (grid per-level, DCA budget/target, CYB cap, and
 * the hard-stop reference) before the strategies build, then returns the
 * snapshot for a startup report.
 *
 * Config (env), all as % of total equity by default (match .env.example):
 *   WALLET_AUTO_SIZE  "1"|"0"     enable wallet-derived sizing (default ON in live)
 *   GRID_ALLOC_PCT    30          active SOL-grid notional
 *   DCA_ALLOC_PCT     50          total DCA deployment budget
 *   CYB_ALLOC_PCT     10          CYB ring-fence cap
 *   WALLET_RESERVE_PCT 10         idle buffer (kept out of active books)
 *   USDC_MIN_RESERVE  30          minimum USDC kept un-deployed (hard floor)
 */
export class WalletSizer {
  constructor(private cfg: AppConfig, private jup: JupiterExec) {}

  static enabled(cfg: AppConfig): boolean {
    if (cfg.mode !== 'live') return false;
    const v = process.env.WALLET_AUTO_SIZE;
    return v === undefined || v === '' ? true : v === '1' || v === 'true';
  }

  async snapshot(signer: Keypair): Promise<WalletSnapshot> {
    const g = this.cfg.strategies.grid;

    // Load config-driven percentages (defaults match .env.example; grid+dca+cyb
    // = 90%, reserve 10% -> deployment cap aligns with the allocation total).
    const gridPct = envNum('GRID_ALLOC_PCT', 30) / 100;
    const dcaPct = envNum('DCA_ALLOC_PCT', 50) / 100;
    const cybPct = envNum('CYB_ALLOC_PCT', 10) / 100;
    const reservePct = envNum('WALLET_RESERVE_PCT', 10) / 100;
    const usdcMinReserve = envNum('USDC_MIN_RESERVE', 30);

    // Native lamports, not the wSOL SPL account (see nativeSolBalance).
    const sol = await this.jup.nativeSolBalance(signer.publicKey);
    const usdc = await this.jup.tokenBalance(signer.publicKey, USDC);
    const solUsd = await this.jup
      .quote(SOL, USDC, 1, 'BUY', 100)
      .then((q) => q.outAmount)
      .catch(() => 0);
    const totalUsd = usdc + sol * solUsd;

    // Derive budgets from real equity.
    const gridBudget = (totalUsd * gridPct) / Math.max(1, g.numLevels);
    const dcaBudget = totalUsd * dcaPct;
    const cybCap = totalUsd * cybPct;
    const reserveUsd = Math.max(totalUsd * reservePct, usdcMinReserve);
    // Fixed-cadence DCA buy: spread the DCA budget across the VA horizon so a
    // full schedule deploys ~the budget regardless of wallet size.
    const dcaPerBuy = dcaBudget / Math.max(1, this.cfg.strategies.dca.vaHorizonBuys);

    return {
      sol,
      usdc,
      solUsd,
      totalUsd,
      derived: {
        gridPerLevelUsd: gridBudget,
        dcaBudgetUsd: dcaBudget,
        dcaPerBuyUsd: dcaPerBuy,
        cybCapUsd: cybCap,
        hardStopRefUsd: totalUsd - reserveUsd, // hard-stop reference = deployable equity
        reserveUsd,
      },
    };
  }

  /** Mutate the loaded config so strategies size off the real wallet. */
  async apply(signer: Keypair): Promise<WalletSnapshot> {
    const s = await this.snapshot(signer);
    this.applySnapshot(s);
    // Seed the hysteresis baseline so the first periodic re-check compares
    // against THIS equity, not "undefined" (which would force a re-apply).
    this.lastAppliedEquityUsd = s.totalUsd;
    return s;
  }

  private applySnapshot(s: WalletSnapshot): void {
    const g = this.cfg.strategies.grid;
    const d = this.cfg.strategies.dca;
    const m = this.cfg.strategies.memes[0];
    if (!m) throw new Error('No meme slots configured');

    g.usdcPerGrid = Math.max(5, Math.round(s.derived.gridPerLevelUsd));
    // DCA per-buy scales with the wallet (was left hardcoded — every other
    // book derived from equity except this one).
    d.usdcAmountPerBuy = Math.max(1, Math.round(s.derived.dcaPerBuyUsd * 100) / 100);
    d.vaTargetSol = s.solUsd > 0
      ? Math.max(0.5, (s.derived.dcaBudgetUsd) / s.solUsd / 2)
      : d.vaTargetSol;
    m.maxUsdcPosition = Math.max(5, Math.round(s.derived.cybCapUsd));
    this.cfg.risk.maxUsdcPosition = Math.max(
      5,
      Math.round(s.derived.hardStopRefUsd)
    );
  }

  /**
   * Hysteresis wrapper for PERIODIC re-sizing. Equity moves constantly with
   * SOL's price — rewriting budgets on every wobble churns the grid ladder
   * (re-sized orders, re-anchored bands) for no reason. Re-deriving budgets is
   * only meaningful when the WALLET actually changed: a deposit, a withdrawal,
   * or accumulated PnL. So re-apply only when equity moved more than
   * RESIZE_HYSTERESIS_PCT (default 5%) since the last applied snapshot;
   * returns null when skipped so the caller can stay quiet.
   */
  async applyWithHysteresis(signer: Keypair): Promise<WalletSnapshot | null> {
    const s = await this.snapshot(signer);
    const base = this.lastAppliedEquityUsd;
    if (base !== undefined && base > 0) {
      const move = Math.abs(s.totalUsd - base) / base;
      if (move < WalletSizer.RESIZE_HYSTERESIS_PCT) return null;
    }
    this.applySnapshot(s);
    this.lastAppliedEquityUsd = s.totalUsd;
    return s;
  }
  private lastAppliedEquityUsd?: number;
  private static readonly RESIZE_HYSTERESIS_PCT = (() => {
    const v = Number(process.env.WALLET_RESIZE_HYSTERESIS_PCT);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.05;
  })();
}
