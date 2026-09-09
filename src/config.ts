import 'dotenv/config';

export type Mode = 'paper' | 'live';

/**
 * Jupiter's legacy endpoints (quote-api.jup.ag / lite-api.jup.ag) were
 * decommissioned. Any configured value pointing at them is silently upgraded
 * to the current Swap API V2 base URL so a stale .env can never break the bot.
 */
const CURRENT_JUPITER_BASE = 'https://api.jup.ag/swap/v2';
const DEPRECATED_JUPITER_HOSTS = ['quote-api.jup.ag', 'lite-api.jup.ag'];

function normalizeJupiterUrl(value: string | undefined): string {
  if (!value) return CURRENT_JUPITER_BASE;
  if (DEPRECATED_JUPITER_HOSTS.some((h) => value.includes(h))) {
    console.warn(
      `[config] Deprecated Jupiter URL "${value}" -> using "${CURRENT_JUPITER_BASE}"`
    );
    return CURRENT_JUPITER_BASE;
  }
  return value;
}

export interface GridConfig {
  baseAsset: string; // 'SOL'
  quoteAsset: string; // 'USDC'
  baseMint: string;
  quoteMint: string;
  lowerPrice: number; // grid lower bound in USDC (legacy; adaptive grid ignores)
  upperPrice: number; // grid upper bound in USDC (legacy; adaptive grid ignores)
  numLevels: number; // number of buy/sell levels
  usdcPerGrid: number; // USDC allocated per (base) buy level
  enabled: boolean;
  /** Minutes of on-chain history used to size the band ("looks backwards"). */
  historyHours: number;
  /** Minutes between re-anchors (how fast the grid follows a trending market). */
  reanchorMinutes: number;
  /** Anti-churn (Feature 2): minimum distance (fraction of a step) price must
   *  move from a fill before we re-arm the opposite side. Prevents double-fee
   *  whipsaws on micro-oscillations. */
  deadzoneSteps: number;
  /** Min consecutive polls the drifted price must persist before re-anchoring
   *  (confirms a real move vs. a single glitchy print that would otherwise
   *  re-center the band on a bogus price). */
  reanchorConfirmPolls?: number;
  /** Compounding (Feature 3): reinvest realized PnL by scaling grid notional.
   *  1.0 means a PnL equal to the capital cap doubles per-level size. */
  compoundPct: number;
  /** Volatility-scaled sizing (Feature 5): OVERSIZE in calm tape (levels likelier
   *  to fill), UNDERSIZE in violent tape (avoid catching a falling knife). */
  volSizingEnabled: boolean;
  /** VWAP skew (Feature 4): weight capital toward levels BELOW VWAP (buy dips)
   *  and away from levels ABOVE VWAP (don't over-buy strength). */
  vwapSkewEnabled: boolean;
  skewStrength: number;
}

export interface DcaConfig {
  baseAsset: string;
  quoteAsset: string;
  baseMint: string;
  quoteMint: string;
  intervalMinutes: number;
  usdcAmountPerBuy: number;
  dipPctBelowVwap: number; // trigger only when price dips below VWAP by this %
  enabled: boolean;
  // Trailing take-profit leg: ring-fence profit on accumulated DCA position.
  takeProfitPct: number; // trigger only once price is this % above avg cost
  trailingPct: number; // give back this % from the peak before selling a slice
  takeProfitSlicePct: number; // fraction of held SOL to bank per take-profit fill
  /** Min interval between take-profit slice sells (minutes). Prevents a rapid
   *  re-drain when price oscillates around the trail-back level right after a
   *  sell resets the trailing peak. */
  tpCooldownMinutes: number;
  /** Fee-aware minimum buy notional (USD). A DCA buy pays a near-constant
   *  network/priority fee per swap, so a micro-buy (e.g. a tiny value-average
   *  increment) spends more on fees than it banks. Never fire a buy below this
   *  notional — bump it up (subject to cap) instead. */
  minBuyUsd?: number;
  // Value averaging (Feature 1): follow a target SOL position path instead of a
  // fixed $ amount — buy MORE when you're behind (cheap), buy LESS when ahead.
  vaEnabled: boolean;
  vaTargetSol: number; // terminal target position in SOL
  vaHorizonBuys: number; // number of buys over which to reach the target
}

export interface RiskConfig {
  maxUsdcPosition: number; // hard cap on USDC deployed to bots (enforced on every buy)
  hardStopPct: number; // e.g. -0.15 = stop out if cumulative PnL drops 15% of maxUsdcPosition (REALIZED only)
  /** Unrealized draw-down guard: pause if the OPEN position is underwater by
   *  this fraction of maxUsdcPosition. A falling market can bleed unrealized
   *  PnL far past the realized hard-stop before anything closes — this switch
   *  halts deployment once the open basket sinks too deep instead of averaging
   *  a falling knife. Fires independently of the realized hard-stop. */
  unrealizedHardStopPct: number; // e.g. -0.20 = pause when open PnL <= -20% of maxUsdcPosition
  maxSlippageBps: number; // Jupiter slippage in basis points
  maxStalePricePolls: number; // safety: skip acting after N consecutive failed price fetches
  /**
   * Single-poll sanity gate for the price oracle. A freshly-fetched price that
   * differs from the previously-committed price by MORE than this fraction is
   * treated as an anomaly (a bad/glitched quote — e.g. the ~$5.97 print on a
   * ~$107 SOL) and is NOT committed to the stream. This prevents a 30-50x
   * single-poll "flash" from triggering crossed-fill SELLs or a DCA trailing
   * sell against a fabricated price. A genuine market move will pass across
   * multiple successive polls. e.g. 0.15 = reject >15% single-poll jump.
   */
  maxSingleJumpPct: number;

  /** AUTO CIRCUIT-BREAKER (#9): if ALL price/quote sources fail for
   *  maxStalePricePolls consecutive polls, auto-arm the live kill-switch
   *  (hard-halt the swap path) instead of limping on stale data. 1 = on, 0 = off. */
  autoCircuitBreaker: boolean;
}

/**
 * A graduated meme (e.g. CYB via pump.fun). Designed as a self-contained slot
 * so more memes can be added later by appending to MEME_SLOTS. Each slot owns
 * its own real GeckoTerminal OHLCV feed, capital cap, and thin-liquidity logic.
 */
export interface MemeSlotConfig {
  id: string; // 'cyb'
  baseAsset: string; // 'CYB'
  quoteAsset: string; // 'USDC'
  baseMint: string; // CYB mint
  quoteMint: string; // USDC mint
  pool: string; // GeckoTerminal pool id (solana_<addr>)
  /** Direct PumpSwap pool address. When set, this meme slot swaps DIRECTLY
   *  against PumpSwap (pAMMBay6o…) instead of Jupiter — required for thin
   *  graduated pump.fun pools Jupiter no longer routes. Quote must be SOL. */
  pumpPool?: string;
  enabled: boolean;
  maxUsdcPosition: number; // ring-fenced capital cap for this meme
  maxSlippageBps: number; // hard slippage ceiling (thick can't absorb)
  usdcPerBuy: number; // notional per buy slice
  minIntervalMinutes: number; // min time between buys (slow, thin)
  targetDepositPct: number; // target USDC reservation of cap per tranche
  historyHours: number; // real history window for band sizing
  admissionMinVolumeUsd: number; // refuse to deploy until real 24h volume >= this
  admissionMinLiquidityUsd: number; // refuse if real pool liquidity < this
  /** Staggered take-profit ladder: each rung banks `slicePct` when price runs
   *  `targetPct` (fraction above avg cost) AND price is at/near its local peak
   *  (trailing give-back). Later rungs lock gains progressively on a meme run
   *  instead of giving everything back waiting for one trailing stop. */
  tpRungs: { targetPct: number; slicePct: number }[];
  /** Per-slot loss ceiling (USD). If this slot's REALIZED PnL breaches -maxLossUsd,
   *  the slot stops accumulating (defensive halt) while the trailing take-profit
   *  still unwinds any remaining size. 0 = disabled. Ring-fences risk so a
   *  single meme rug can't drain the rest of the wallet. */
  maxLossUsd: number;
  /** Dead-book exit (fraction, 0 = disabled): if the pool's REAL liquidity drops
   *  below (peakLiquidity * (1 - liquidityDecayExitPct)) since we started holding,
   *  treat it as exit-liquidity withdrawal / rug signal — halt accumulation and
   *  defensively sell out the remaining position at market. */
  liquidityDecayExitPct: number;
}

export interface StrategyConfig {
  grid: GridConfig;
  dca: DcaConfig;
  memes: MemeSlotConfig[];
}

export interface AppConfig {
  mode: Mode;
  rpcUrl: string;
  jupiterApiUrl: string;
  pollIntervalMs: number;
  refreshIntervalMs: number; // dashboard price refresh
  walletKeyPath: string; // paper/live keypair file
  strategies: StrategyConfig;
  risk: RiskConfig;
  /** BirdEye API key (needed for real on-chain OHLCV candles → VWAP for meme
   *  tokens like CYB). Free key from pro.birdeye.so. GeckoTerminal only serves
   *  liquidity/24h-volume as a keyless fallback — we do NOT need its key, and
   *  we do NOT use CoinGecko for meme data at all. */
  birdeyeApiKey?: string;
}

const envNumber = (key: string, fallback: number, min?: number, max?: number): number => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // Some bounds enforce plausibility so a typo'd negative/clamped value can
  // never silently produce a dangerous config (e.g. negative slippage).
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
};

const envBool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
};

export function loadConfig(): AppConfig {
  return {
    mode: (process.env.TRADE_MODE as Mode) || 'paper',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: normalizeJupiterUrl(process.env.JUPITER_API_URL),
    pollIntervalMs: envNumber('POLL_INTERVAL_MS', 30000),
    refreshIntervalMs: envNumber('REFRESH_INTERVAL_MS', 5000),
    walletKeyPath: process.env.WALLET_KEY_PATH || './wallet.key',
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || undefined,
    strategies: {
      grid: {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseMint: 'So11111111111111111111111111111111111111112',
        quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        lowerPrice: envNumber('GRID_LOWER', 120),
        upperPrice: envNumber('GRID_UPPER', 180),
        numLevels: envNumber('GRID_LEVELS', 8, 2, 100),
        usdcPerGrid: envNumber('GRID_USDC_PER_LEVEL', 20, 1, 1e6),
        enabled: envBool('GRID_ENABLED', true),
        historyHours: envNumber('GRID_HISTORY_HOURS', 48, 1, 2160),
        reanchorMinutes: envNumber('GRID_REANCHOR_MIN', 240, 1, 1440),
        deadzoneSteps: envNumber('GRID_DEADZONE_STEPS', 2, 0, 10),
        reanchorConfirmPolls: envNumber('GRID_REANCHOR_CONFIRM_POLLS', 3, 1, 100),
        compoundPct: envNumber('GRID_COMPOUND_PCT', 0, 0, 10),
        volSizingEnabled: envBool('GRID_VOL_SIZING', true),
        vwapSkewEnabled: envBool('GRID_VWAP_SKEW', true),
        skewStrength: envNumber('GRID_SKEW_STRENGTH', 0.35, 0, 10),
      },
      dca: {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseMint: 'So11111111111111111111111111111111111111112',
        quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        intervalMinutes: envNumber('DCA_INTERVAL_MIN', 120, 1, 1440),
        usdcAmountPerBuy: envNumber('DCA_USDC_PER_BUY', 25, 1, 1e6),
        dipPctBelowVwap: envNumber('DCA_DIP_PCT', 3, 0.01, 100),
        enabled: envBool('DCA_ENABLED', true),
        takeProfitPct: envNumber('DCA_TP_PCT', 1.0, 0, 100),
        trailingPct: envNumber('DCA_TRAILING_PCT', 4, 0, 99),
        takeProfitSlicePct: envNumber('DCA_TP_SLICE_PCT', 50, 1, 100),
        tpCooldownMinutes: envNumber('DCA_TP_COOLDOWN_MIN', 30, 0, 10080),
        vaEnabled: envBool('DCA_VA_ENABLED', true),
        vaTargetSol: envNumber('DCA_VA_TARGET_SOL', 5, 0.1, 1e6),
        vaHorizonBuys: envNumber('DCA_VA_HORIZON_BUYS', 12, 1, 100000),
        minBuyUsd: envNumber('DCA_MIN_BUY_USD', 15, 1, 1e6),
      },
      memes: [
        {
          // CYB — graduated meme via pump.fun, thin but real liquidity.
          id: 'cyb',
          baseAsset: 'CYB',
          quoteAsset: 'USDC',
          baseMint: 'J2hyZSVokSTuy3bG85A5xfs3umCeGtqZZEdKtGTTpump',
          quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          pool: 'solana_CHVehKRbncDPDr1od9EYA1vp635wwFdZgXdzEXXT6v96',
          // Direct PumpSwap execution (Jupiter no longer routes this pool).
          pumpPool: 'CHVehKRbncDPDr1od9EYA1vp635wwFdZgXdzEXXT6v96',
          enabled: envBool('CYB_ENABLED', true),
          maxUsdcPosition: envNumber('CYB_MAX_USDC', 200),
          maxSlippageBps: envNumber('CYB_SLIPPAGE_BPS', 500, 0, 2000),
          usdcPerBuy: envNumber('CYB_USDC_PER_BUY', 10, 1, 1000),
          minIntervalMinutes: envNumber('CYB_MIN_INTERVAL_MIN', 5, 1, 1440),
          targetDepositPct: envNumber('CYB_TARGET_DEPOSIT_PCT', 0.6, 0.01, 1),
          historyHours: envNumber('CYB_HISTORY_HOURS', 72, 1, 2160),
          admissionMinVolumeUsd: envNumber('CYB_MIN_VOL_USD', 100, 0, 1e9),
          admissionMinLiquidityUsd: envNumber('CYB_MIN_LIQ_USD', 1000, 0, 1e9),
          maxLossUsd: envNumber('CYB_MAX_LOSS_USD', 60, 0, 1e9),
          liquidityDecayExitPct: envNumber('CYB_LIQ_DECAY_EXIT_PCT', 0.5, 0, 0.95),
          // Staggered ladder: bank 40% at +50%, 30% more at +100%, rest trails.
          tpRungs: [
            { targetPct: 0.5, slicePct: 0.4 },
            { targetPct: 1.0, slicePct: 0.3 },
          ],
        },
      ],
    },
    risk: {
      maxUsdcPosition: envNumber('RISK_MAX_USDC', 400, 1, 1e9),
      hardStopPct: envNumber('RISK_HARD_STOP_PCT', 0.25, 0, 0.99),
      unrealizedHardStopPct: envNumber('RISK_UNREALIZED_STOP_PCT', 0.20, 0, 0.99),
      maxSlippageBps: envNumber('RISK_SLIPPAGE_BPS', 100, 0, 2000),
      maxStalePricePolls: envNumber('RISK_MAX_STALE_POLLS', 5, 1, 1000),
      autoCircuitBreaker: envBool('RISK_AUTO_CIRCUIT_BREAKER', true),
      maxSingleJumpPct: envNumber('RISK_MAX_SINGLE_JUMP_PCT', 0.05, 0.02, 1),
    },
  };
}
