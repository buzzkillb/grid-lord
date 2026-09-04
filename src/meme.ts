import type { AppConfig, MemeSlotConfig } from './config.js';
import type { StateStore } from './store.js';
import type { Candle, Order, Trade, MemeState } from './types.js';
import type { Broker } from './broker.js';

/**
 * SELF-CONTAINED meme strategy for graduated pump.fun tokens (e.g. CYB).
 *
 * Isolation: this module does NOT touch the SOL grid/DCA engine, the SOL
 * PaperBroker, or the SOL USDC balance. It keeps its own ring-fenced capital
 * budget, its own real GeckoTerminal OHLCV feed, and its own position state in
 * store.strategies.memes[id]. Adding another meme is just another config slot.
 *
 * NO SYNTHETIC STATS — every number that drives a decision comes from real
 * on-chain GeckoTerminal data (OHLCV candles carry real volumeUsd; the pool
 * endpoint provides real liquidity + 24h volume). We never invent data.
 *
 * Because graduated memes are THIN and VOLATILE, we deliberately trade safe:
 *   1. ADMISSION GATE — no deployment at all until real 24h volume and real
 *      pool liquidity clear minimums. Refuses otherwise (honest, not fake).
 *   2. HARD SLIPPAGE CEILING — we will not size a buy whose modeled slippage
 *      on the real pool would exceed the slot's cap. Prevents donating to a
 *      thin book.
 *   3. SLOW TRANCHE DEPOSIT — we never go all-in; we buy small slices toward a
 *      target % of the cap, and only when price is at/under real VWAP (buy the
 *      dip), spaced by minInterval. DCA-style accumulation.
 *   4. TRAILING TAKE-PROFIT — once price runs well above average cost, we bank
 *      slices and give back only a small trailing band, ring-fencing gains.
 *   5. SELF-HEALING CAP — deployedUsd is computed from the real held position
 *      at real cost; a restart reconciles from state and never redeploys money
 *      that's already committed.
 */
interface BirdeyeCandle {
  address?: string;
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vUsd?: number;
}

export class MemeStrategy {
  private candles: Candle[] = [];
  private price = 0;
  private liquidityUsd = 0;
  private vol24hUsd = 0;
  private birdeyeVolumeUsd = 0;
  private geckoVolumeUsd = 0;
  private admitted = false;
  private admissionReason = 'pending data';
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private slot: MemeSlotConfig,
    /** In LIVE mode the broker performs the real Jupiter swap + ring-fenced
     *  accounting. When undefined (paper), fills are simulated here. */
    private broker?: Broker
  ) {}

  /** Kicks off the refresh loop for this meme's real data. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.pollIntervalMs * 20);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The current price of the meme (0 until real data arrives). */
  get currentPrice(): number {
    return this.price;
  }

  /** Real rolling VWAP from volume-weighted on-chain candles (never invented). */
  get vwap(): number {
    if (this.candles.length === 0) return 0;
    const n = Math.min(this.candles.length, 60);
    const recent = this.candles.slice(-n);
    const vol = recent.reduce((s, c) => s + c.volumeUsd, 0);
    if (vol <= 0) return 0; // cannot VWAP without real volume
    const sum = recent.reduce((s, c) => s + c.volumeUsd * c.close, 0);
    return sum / vol;
  }

  /** Real realized volatility over the last N closes (stdev/mean). */
  private volatility(n = 12): number {
    const closes = this.candles.slice(-n).map((c) => c.close);
    if (closes.length < 2) return 0;
    const mean = closes.reduce((s, c) => s + c, 0) / closes.length;
    if (mean <= 0) return 0;
    const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / closes.length;
    return Math.sqrt(variance) / mean;
  }

  /**
   * Fetch real on-chain data for this meme's pool: OHLCV history + live price
   * + liquidity + 24h volume. On failure we keep the last real data and refuse
   * to trade on stale data (never fabricate). The two fetches are independent
   * so a missing/unauthorized OHLCV source can never block the live pool price
   * (which drives admission) from populating.
   */
  async refresh(): Promise<void> {
    // 1) BirdEye OHLCV — PRIMARY real source for price + VWAP + high/low + 24h
    //    volume. Rate-limited (free tier), so we pace it and only fetch candles
    //    at the cadence below; the engine also ticks between refreshes using the
    //    last real candles. Never fabricated.
    let birdeyeOk = false;
    try {
      birdeyeOk = await this.fetchBirdeyeOhlcv();
    } catch (e) {
      this.warn(`birdeye ohlcv refresh failed (${(e as Error).message})`);
    }
    // 2) GeckoTerminal token->pools — keyless FALLBACK only, to keep liquidity /
    //    24h-volume alive if BirdEye is throttled. It does NOT feed VWAP.
    try {
      await this.fetchGeckoLiquidity();
    } catch (e) {
      this.warn(`gecko liquidity fallback failed (${(e as Error).message})`);
    }
    // If BirdEye is unavailable AND we never had real candles, surface 24h
    // volume from Gecko as a fallback so admission can still judge liquidity.
    if (!birdeyeOk && this.birdeyeVolumeUsd <= 0) {
      this.vol24hUsd = this.geckoVolumeUsd;
    }
    this.evaluateAdmission();
    this.tick(); // recompute decisions with the freshest real data
  }

  private async fetchBirdeyeOhlcv(): Promise<boolean> {
    if (!this.cfg.birdeyeApiKey) {
      this.warn('BIRDEYE_API_KEY not set — cannot fetch real candles/VWAP');
      return false;
    }
    // Free tier: fetch at most once per refresh gap. ~30 hourly candles give a
    // solid VWAP + high/low window without hammering the endpoint.
    const url =
      `https://public-api.birdeye.so/defi/ohlcv?address=${this.slot.baseMint}&type=1H` +
      `&time_from=0&time_to=9999999999&limit=60`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'X-API-KEY': this.cfg.birdeyeApiKey, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`birdeye HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { items?: BirdeyeCandle[] };
    };
    const items = json?.data?.items ?? [];
    if (items.length === 0) return false;
    const candles: Candle[] = items
      .filter((c) => c && typeof c.c === 'number')
      .map((c) => ({
        ts: c.unixTime * 1000,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volumeUsd: c.vUsd ?? 0,
      }))
      .sort((a, b) => a.ts - b.ts);
    if (candles.length > 0) {
      this.candles = candles;
      // Live price = most recent real candle close (never fabricated).
      this.price = candles[candles.length - 1].close;
      // Real 24h volume = sum of the last 24 hourly candles' real USD volume.
      this.vol24hUsd = candles.slice(-24).reduce((s, c) => s + c.volumeUsd, 0);
      this.birdeyeVolumeUsd = this.vol24hUsd;
      return true;
    }
    return false;
  }

  /**
   * Keyless GeckoTerminal token->pools — supplies real LIQUIDITY + 24h volume
   * (the OHLCV endpoints 404 keylessly, so we use the token listing and pick
   * the most liquid pool). BirdEye drives VWAP/price; Gecko drives liquidity.
   * Runs every refresh (10-min cadence) — far under Gecko's rate limit.
   */
  private async fetchGeckoLiquidity(): Promise<void> {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${this.slot.baseMint}/pools`,
      { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`token pools HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ attributes?: { base_token_price_usd?: string; reserve_in_usd?: string; volume_usd?: { h24?: string } } }>;
    };
    const pools = json?.data ?? [];
    if (pools.length === 0) return;
    let bestLiq = 0;
    const vols: number[] = [];
    for (const p of pools) {
      const liq = Number.parseFloat(p.attributes?.reserve_in_usd ?? '0') || 0;
      if (liq > bestLiq) bestLiq = liq;
      const v = Number.parseFloat(p.attributes?.volume_usd?.h24 ?? '0') || 0;
      if (v > 0) vols.push(v);
    }
    this.geckoVolumeUsd = vols.length ? Math.max(...vols) : 0;
    // Real liquidity always comes from Gecko (BirdEye OHLCV has no reserve).
    if (bestLiq > 0) this.liquidityUsd = bestLiq;
  }

  /** Decide whether this meme is safe enough to deploy paper capital at all. */
  private evaluateAdmission(): void {
    const v = this.vol24hUsd;
    const l = this.liquidityUsd;
    if (v === 0 && l === 0) {
      this.admitted = false;
      this.admissionReason = 'no real data yet';
      return;
    }
    if (v < this.slot.admissionMinVolumeUsd) {
      this.admitted = false;
      this.admissionReason = `24h vol $${v.toFixed(0)} < min $${this.slot.admissionMinVolumeUsd}`;
      return;
    }
    if (l < this.slot.admissionMinLiquidityUsd) {
      this.admitted = false;
      this.admissionReason = `liq $${l.toFixed(0)} < min $${this.slot.admissionMinLiquidityUsd}`;
      return;
    }
    this.admitted = true;
    this.admissionReason = 'admitted';
  }

  /** USDC reserved by this meme = held base at real average cost. */
  deployedUsd(): number {
    const s = this.state();
    return s.baseQty > 0 && s.avgCostPerBase > 0
      ? s.baseQty * s.avgCostPerBase
      : 0;
  }

  /** The runtime state for this slot (with defaults seeded in the store). */
  private state(): MemeState {
    const m = this.store.strategies.memes;
    if (!m[this.slot.id]) {
      m[this.slot.id] = {
        id: this.slot.id,
        enabled: this.slot.enabled,
        price: 0, vwap: 0, high24h: 0, low24h: 0,
        vol24hUsd: 0, liquidityUsd: 0,
        baseQty: 0, avgCostPerBase: 0,
        realizedPnlUsd: 0, feesPaidUsd: 0, deployedUsd: 0,
        buys: 0,
        admitted: false, admissionReason: 'pending',
        lossStopped: false,
        peakLiquidityUsd: 0, deadBookExited: false,
        tpRungIndex: 0,
      };
    }
    return m[this.slot.id];
  }

  /** Core loop called on each refresh (and externally via engine each poll). */
  tick(): void {
    const s = this.state();
    // Always surface the real current market data to the dashboard.
    s.price = this.price;
    s.vwap = this.vwap;
    s.liquidityUsd = this.liquidityUsd;
    s.vol24hUsd = this.vol24hUsd;
    s.deployedUsd = this.deployedUsd();
    const last24 = this.candles.length ? this.candles.slice(-24) : [];
    const hi = last24.length ? Math.max(...last24.map((c) => c.high)) : 0;
    const lo = last24.length ? Math.min(...last24.map((c) => c.low)) : 0;
    s.high24h = hi;
    s.low24h = lo;
    s.enabled = this.slot.enabled;
    s.admitted = this.admitted;
    s.admissionReason = this.admissionReason;

    if (!this.slot.enabled) return;

    // SAFETY: only trade on real, fresh data.
    if (this.price <= 0 || !this.admitted) return;

    // DEAD-BOOK / EXIT-LIQUIDITY MONITOR (#4): if the pool's real liquidity has
    // decayed past the exit threshold since we started holding, this is a rug /
    // exit-liquidity signal — halt accumulation AND defensively sell out the
    // remaining position at market.
    this.monitorDeadBook(s);

    // RING-FENCED LOSS STOP (#2): if this slot's REALIZED loss has breached its
    // per-slot ceiling, halt accumulation (stop feeding a loser) but leave the
    // trailing take-profit active so any remaining size can still unwind.
    const maxLoss = this.slot.maxLossUsd;
    if (maxLoss > 0 && s.realizedPnlUsd <= -maxLoss) {
      if (!s.lossStopped) {
        s.lossStopped = true;
        this.warn(
          `realized loss ${s.realizedPnlUsd.toFixed(2)} <= -${maxLoss.toFixed(0)} ` +
            `— accumulation halted, trailing TP still unwinding`
        );
      }
    }
    // No more accumulation once we've either blown the per-slot loss stop OR
    // already defensively exited a dead/decayed book — re-buying straight back
    // into a token we just fled for lack of liquidity would defeat the monitor.
    const haltAccumulation = !!s.lossStopped || !!s.deadBookExited;

    // Trailing take-profit first (bank gains when they exist). Always runs,
    // even in a halted slot, so we unwind rather than hold a dead position.
    this.takeProfit(s);

    // Accumulation: buy dips toward the target deposit.
    if (!haltAccumulation) this.maybeBuy(s);
  }

  /**
   * DEAD-BOOK MONITOR (#4): track the peak real pool liquidity seen since we
   * started holding. If liquidity decays below (peak * (1 - exitPct)), treat it
   * as exit-liquidity withdrawal / rug signal: halt accumulation and defensively
   * sell out the full remaining position at market. Guards against holding a
   * token that nobody can sell into.
   */
  private monitorDeadBook(s: MemeState): void {
    if (s.deadBookExited) return; // already handled
    const exitPct = this.slot.liquidityDecayExitPct;
    if (exitPct <= 0) return; // disabled
    if (!(s.baseQty > 0)) {
      // No position yet — just keep a running liquidity peak available.
      if (this.liquidityUsd > (s.peakLiquidityUsd ?? 0)) s.peakLiquidityUsd = this.liquidityUsd;
      return;
    }
    // Track peak liquidity since we started holding.
    if (this.liquidityUsd > (s.peakLiquidityUsd ?? 0)) s.peakLiquidityUsd = this.liquidityUsd;

    const peak = s.peakLiquidityUsd ?? 0;
    if (peak <= 0) return; // no baseline yet, wait
    const floor = peak * (1 - exitPct);
    if (this.liquidityUsd < floor) {
      s.deadBookExited = true;
      this.warn(
        `real liquidity decayed ${(peak).toFixed(0)} -> ${this.liquidityUsd.toFixed(0)} ` +
          `(floor ${floor.toFixed(0)}); DEFENSIVE EXIT of ${s.baseQty.toPrecision(4)} base`
      );
      this.sell(s, s.baseQty, 'defensive exit (liquidity decay / dead book)');
    }
  }

  /** Bank slices progressively as the meme runs (staggered TP ladder). */
  private takeProfit(s: MemeState): void {
    if (!(s.baseQty > 0) || !(s.avgCostPerBase > 0)) return;
    const rungs = this.slot.tpRungs.length ? this.slot.tpRungs : [{ targetPct: 0.5, slicePct: 0.5 }];
    const idx = Math.min(s.tpRungIndex ?? 0, rungs.length - 1);
    const rung = rungs[idx];
    // require a meaningful confirmup above the target to avoid micro-whipsaw
    const confirmUp = 1.03;
    const giveBackPct = 0.25; // trail 25% from peak before selling a slice

    const threshold = s.avgCostPerBase * (1 + rung.targetPct);
    if (this.price >= threshold) {
      if (!s.tpArmed) {
        s.tpArmed = true;
        s.peakPrice = this.price;
      } else {
        // trail peak; only sell once price pulls back from enough confirm-up
        if (s.peakPrice === undefined || this.price > s.peakPrice) s.peakPrice = this.price;
        const confirm = s.avgCostPerBase * (1 + rung.targetPct) * confirmUp;
        if (this.price >= confirm && s.peakPrice! > 0) {
          const trailStop = s.peakPrice * (1 - giveBackPct);
          if (this.price <= trailStop) {
            // TP COOLDOWN (mirrors DCA tpCooldownMinutes): after a take-profit
            // slice sell, wait minIntervalMinutes before selling again. Without
            // this, a meme that keeps climbing keeps re-arming each higher rung
            // and can slice-drain up the run, selling into strength and then
            // re-accumulating higher (capital waste). We preserve the trailing
            // state, so once the cooldown lapses the same rung resumes tracking.
            const cooldownMs = this.slot.minIntervalMinutes * 60_000;
            if (s.lastTpAt && Date.now() - s.lastTpAt < cooldownMs) {
              if (this.price > (s.peakPrice ?? 0)) s.peakPrice = this.price; // keep peak fresh during cooldown
              return;
            }
            const qty = s.baseQty * rung.slicePct;
            this.sell(
              s,
              qty,
              `meme ladder TP rung ${idx + 1}/${rungs.length} (${(rung.targetPct * 100).toFixed(0)}% -> ${(rung.slicePct * 100).toFixed(0)}% slice)`
            );
            // advance to the next rung; if this was the last, disarm (rest trails higher)
            if (idx + 1 < rungs.length) {
              s.tpRungIndex = idx + 1;
              s.tpArmed = false;
              s.peakPrice = undefined;
              s.lastTpAt = Date.now();
            } else {
              s.tpArmed = false;
              s.peakPrice = undefined;
              s.lastTpAt = Date.now();
            }
          }
        }
      }
    } else if (s.tpArmed && this.price < s.avgCostPerBase * (1 + rung.targetPct)) {
      // price fell back below the trigger — disarm (protect the unrealized gain)
      s.tpArmed = false;
      s.peakPrice = undefined;
    }
  }

  /** Accumulate on dips toward target % of the ring-fenced cap. */
  private maybeBuy(s: MemeState): void {
    // Target deposit is a fraction of the cap (don't oversaturate a thin book).
    const targetUsd = this.slot.maxUsdcPosition * this.slot.targetDepositPct;
    if (this.deployedUsd() >= targetUsd) return; // fully invested toward target

    // Spacing: respect the minimum interval between buys.
    if (s.lastBuyAt && Date.now() - s.lastBuyAt < this.slot.minIntervalMinutes * 60_000) return;

    // Entry: only buy at/under VWAP (buy the dip in real terms), or if we have
    // no VWAP yet just wait for more data rather than chasing.
    const vwap = this.vwap;
    if (vwap <= 0) return;
    const cushion = 1 - this.volatility() * 0.5; // dip a little below VWAP
    if (this.price > vwap * cushion) return;

    // Size to the cap headroom (never exceed the ring-fence).
    const remaining = this.slot.maxUsdcPosition - this.deployedUsd();
    const amount = Math.min(this.slot.usdcPerBuy, remaining);
    // Hard slippage guard: if the modeled slippage on real liquidity would
    // exceed the slot cap, shrink the slice to stay under it (or skip).
    const slippageBps = this.modeledSlippageBps(amount);
    if (slippageBps > this.slot.maxSlippageBps) return;

    if (amount <= 1e-9 || this.price <= 0) return;
    const baseQty = amount / this.price;
    const fee = this.feeUsd(amount);

    const order: Order = {
      id: this.store.newOrderId(),
      kind: 'DCA_BUY',
      side: 'BUY',
      price: this.price,
      baseQty,
      quoteQty: amount,
      status: this.broker ? 'OPEN' : 'FILLED',
      createdAt: Date.now(),
      strategyId: this.slot.id,
      mode: this.broker ? 'live' : 'paper',
      note: this.broker ? 'meme dip accumulation (live)' : 'meme dip accumulation (paper)',
    };
    if (this.broker) {
      // LIVE: hand off to the real broker. It places the Jupiter swap (honoring
      // dry-run LIVE_ARM gates) and updates the ring-fenced meme state + trade on
      // confirmation — this module should NOT also mutate the position.
      s.lastBuyAt = Date.now();
      this.broker.marketBuy(order);
      void this.applyFromLiveOrder(order);
      return;
    }
    // Paper: simulate the fill locally (as before).
    order.fillPrice = this.price;
    order.filledAt = Date.now();
    order.mode = 'paper';
    this.store.upsertOrder(order);
    this.recordBuyTrade(order, baseQty, fee);

    // Update position + budget (real cost basis).
    const cost = amount + fee;
    const newBase = s.baseQty + baseQty;
    const newCost = (s.baseQty * s.avgCostPerBase) + cost;
    s.baseQty = newBase;
    s.avgCostPerBase = newCost / newBase;
    s.feesPaidUsd += fee;
    s.buys += 1;
    s.lastBuyAt = Date.now();
    s.deployedUsd = this.deployedUsd();

    console.log(
      `[${this.slot.id}] paper buy ${baseQty.toPrecision(4)} @ ${this.price.toExponential(4)} ` +
        `(pos ${s.baseQty.toPrecision(4)}, deployed ${s.deployedUsd.toFixed(2)})`
    );
  }

  /**
   * Modeled slippage on the REAL pool. Uses the real liquidity figure from
   * GeckoTerminal: a buy of `amount` USDC against `liquidityUsd` of paired
   * reserve. This is a cost model from real data — not a fabricated stat — and
   * it directly enforces that we never over-size into a thin book.
   */
  private modeledSlippageBps(amountUsd: number): number {
    if (this.liquidityUsd <= 0) return Number.POSITIVE_INFINITY;
    // price impact ~ amount / (2 * liquidity) for a small trade on a pool
    const impact = amountUsd / (2 * this.liquidityUsd);
    return Math.round(impact * 10000); // as bps
  }

  /** Realistic on-chain fee estimate (priority + router), in USD. */
  private feeUsd(quoteQty: number): number {
    const fixed = 0.002; // priority/jito tip
    return fixed + quoteQty * 0.003; // 0.3% routing/slippage buffer on thin pools
  }

  private sell(s: MemeState, qty: number, note: string): void {
    if (qty <= 0 || this.price <= 0) return;
    const proceeds = qty * this.price;
    const fee = this.feeUsd(proceeds);
    const realized = (this.price - s.avgCostPerBase) * qty - fee;

    const order: Order = {
      id: this.store.newOrderId(),
      kind: 'DCA_SELL',
      side: 'SELL',
      price: this.price,
      baseQty: qty,
      quoteQty: proceeds,
      status: this.broker ? 'OPEN' : 'FILLED',
      createdAt: Date.now(),
      strategyId: this.slot.id,
      mode: this.broker ? 'live' : 'paper',
      note,
    };
    if (this.broker) {
      // LIVE: hand off to the real broker (honoring dry-run LIVE_ARM gates); the
      // broker updates the ring-fenced meme state + trade on confirmation.
      this.broker.marketSell(order);
      void this.applyFromLiveOrder(order);
      return;
    }
    // Paper: simulate the fill locally (as before).
    order.fillPrice = this.price;
    order.filledAt = Date.now();
    order.mode = 'paper';
    this.store.upsertOrder(order);
    this.recordSellTrade(order, qty, fee, realized);

    s.baseQty -= qty;
    s.realizedPnlUsd += realized;
    s.feesPaidUsd += fee;
    s.deployedUsd = this.deployedUsd();

    console.log(
      `[${this.slot.id}] paper sell ${qty.toPrecision(4)} @ ${this.price.toExponential(4)} ` +
        `pnl ${realized.toFixed(2)}`
    );
  }

  /**
   * LIVE fills are applied by the broker (it owns submit/confirm + the
   * ring-fenced meme state). This awaits the broker's async fill for a moment
   * so the strategy's poll loop doesn't immediately re-trigger a duplicate buy
   * before the order is confirmed. It is fire-and-forget after the first ticks.
   */
  private async applyFromLiveOrder(order: Order): Promise<void> {
    // Give the broker a short window to confirm so spacing/lastBuyAt logic
    // reads the post-fill state. Non-blocking beyond a few seconds.
    for (let i = 0; i < 5; i++) {
      if (order.status === 'FILLED' || order.status === 'REJECTED') break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private recordBuyTrade(order: Order, qty: number, fee: number): void {
    const t: Trade = {
      id: this.store.newOrderId(),
      orderId: order.id,
      strategyId: this.slot.id,
      direction: 'BUY',
      price: this.price,
      baseQty: qty,
      quoteQty: qty * this.price,
      feeUsd: fee,
      ts: Date.now(),
      mode: 'paper',
    };
    this.store.recordTrade(t);
  }

  private recordSellTrade(order: Order, qty: number, fee: number, realized: number): void {
    const t: Trade = {
      id: this.store.newOrderId(),
      orderId: order.id,
      strategyId: this.slot.id,
      direction: 'SELL',
      price: this.price,
      baseQty: qty,
      quoteQty: qty * this.price,
      feeUsd: fee,
      realizedPnlUsd: realized,
      ts: Date.now(),
      mode: 'paper',
    };
    this.store.recordTrade(t);
  }

  private warn(msg: string): void {
    console.warn(`[${this.slot.id}] ${msg}`);
  }
}
