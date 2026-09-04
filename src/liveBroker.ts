import type { AppConfig } from './config.js';
import type { StateStore } from './store.js';
import { PriceOracle } from './price.js';
import type { Broker } from './broker.js';
import type { Order, Position } from './types.js';
import { JupiterExec, assertLiveAllowed, dryRunEnabled } from './jupiter.js';
import { buildPumpSwap } from './pumpSwap.js';
import { Keypair } from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * LIVE broker: executes real Jupiter swaps on the user's wallet.
 *
 * Every trade flow passes `assertLiveAllowed()` (TRADE_MODE=live + kill-switch
 * off + dry-run off) before anything touches the network. Fills are recorded
 * into the SAME store.account / positions that the risk layer and dashboard
 * read, so the hard stop, unrealized draw-down guard, PnL and equity curve all
 * see real live balances (C1). Orders are marked IN-FLIGHT before the async
 * send and skipped by the scan, so a slow confirmation can never double-send
 * the same resting order on consecutive polls (C2).
 *
 * This is constructed ONLY when mode === 'live'. In paper mode the engine uses
 * PaperBroker and never even constructs this class.
 */
export class LiveBroker implements Broker {
  private jup: JupiterExec;
  /** order ids currently awaiting on-chain confirmation (in-flight guard). */
  private inFlight = new Set<string>();

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private priceOracle: PriceOracle,
    private signer: Keypair
  ) {
    this.jup = new JupiterExec(cfg);
  }

  /**
   * FEE-FLOOR STEP (profit protection, parity with PaperBroker).
   *
   * Previously returned 0, which meant the live grid could arm levels spaced
   * tighter than the round-trip fee: every captured "profit" wave could cost
   * more in network + routing fees than it made. Paper mode already enforced
   * the fee floor (round-trip fee / level qty × 1.2 margin) — live now uses
   * the same math with the live fee model (0.002 fixed + 0.1% routing).
   *
   * Example at $105 SOL, $32/level: round-trip ≈ $0.068 → min step ≈ $0.24
   * (vs a $1.5–3 step the band produces — the floor only binds on tight bands).
   */
  minProfitStepUsd(price: number): number {
    const levelNotional = this.cfg.strategies.grid.usdcPerGrid || 20;
    const levelQty = levelNotional / price;
    if (!(levelQty > 0) || !(price > 0)) return 0;
    const roundTripFee = 2 * this.estimateFeeUsd(levelNotional);
    return (roundTripFee / levelQty) * 1.2; // 20% margin so we actually profit
  }

  placeLimitOrder(order: Order): void {
    // A live "limit" order is a market swap executed at the crossing price.
    order.mode = 'live';
    if (order.side === 'BUY' && this.priceOracle.current <= order.price) {
      this.executeSwap(order, 'BUY');
    } else if (order.side === 'SELL' && this.priceOracle.current >= order.price) {
      this.executeSwap(order, 'SELL');
    } else {
      this.store.upsertOrder(order); // not crossing — hold resting
    }
  }

  marketBuy(order: Order): void {
    order.mode = 'live';
    this.executeSwap(order, 'BUY');
  }

  marketSell(order: Order): void {
    order.mode = 'live';
    this.executeSwap(order, 'SELL');
  }

  onPriceChange(): void {
    const price = this.priceOracle.current;
    for (const order of this.store.orders) {
      // SKIP in-flight ORDERS — they've already been submitted and are awaiting
      // confirmation. Without this, a slow RPC could double-send the same swap
      // on the next poll (C2).
      if (order.status !== 'OPEN' || this.inFlight.has(order.id)) continue;
      const crossed =
        (order.side === 'BUY' && price <= order.price) ||
        (order.side === 'SELL' && price >= order.price);
      if (crossed) {
        order.mode = 'live';
        this.executeSwap(order, order.side);
      }
    }
  }

  /**
   * Re-read real on-chain balances and write them into store.account so the
   * risk layer, PnL, deployment cap and equity curve reflect actual wallet
   * state (C1). Called by the engine each poll in live mode.
   */
  async syncBalances(): Promise<void> {
    const a = this.store.account;
    try {
      a.balances.SOL = await this.jup.nativeSolBalance(this.signer.publicKey);
      a.balances.USDC = await this.jup.tokenBalance(this.signer.publicKey, USDC_MINT);
      if (process.env.DEBUG_BALANCES === '1') {
        console.log(
          `[live] balances: ${a.balances.SOL.toFixed(4)} native SOL ` +
          `(${(await this.jup.tokenBalance(this.signer.publicKey, SOL_MINT)).toFixed(4)} wSOL SPL) ` +
          `| ${a.balances.USDC.toFixed(2)} USDC`
        );
      }
    } catch (e) {
      console.warn(`[live] balance sync failed: ${(e as Error).message}`);
    }
  }

  /**
   * Reconcile the SOL/USDC position from a single real on-chain balance read +
   * the running realized PnL. Solves C1 holistically (not just balances) by
   * keeping the dashboard position roughly in line with reality each poll.
   */
  async syncPosition(price: number): Promise<void> {
    // Use the same in-flight balance read as syncBalances (may be slightly out
    // of date between confirms — acceptable for unrealized display purposes).
    const a = this.store.account;
    let pos = this.store.getPosition('SOL', 'USDC');
    if (!pos) {
      pos = {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseQty: 0,
        quoteQty: 0,
        avgCostPerBase: 0,
      };
      this.store.upsertPosition(pos);
    }
    // baseQty mirrors the on-chain SOL balance + running realized PnL estimate.
    pos.baseQty = a.balances.SOL;
    pos.quoteQty = a.balances.USDC;
    a.openQty = a.balances.SOL;
    pos.avgCostPerBase = pos.avgCostPerBase > 0 ? pos.avgCostPerBase : (price > 0 ? price : 0);
  }

  /** Which side's input is the base (SOL) mint for a given strategy. */
  private baseAndQuoteMints(order: Order): { baseMint: string; quoteMint: string } {
    if (order.strategyId === 'dca' || order.strategyId === 'grid') {
      return { baseMint: SOL_MINT, quoteMint: USDC_MINT };
    }
    const ms = this.cfg.strategies.memes.find((m) => m.id === order.strategyId);
    if (ms) return { baseMint: ms.baseMint, quoteMint: ms.quoteMint };
    return { baseMint: SOL_MINT, quoteMint: USDC_MINT };
  }

  private async executeSwap(order: Order, side: 'BUY' | 'SELL'): Promise<void> {
    // Guard: never send unless live is explicitly armed.
    try {
      assertLiveAllowed(this.cfg);
    } catch (e) {
      console.warn(`[live] block: ${(e as Error).message}`); // dry-run / kill-switch
      return;
    }

    // IN-FLIGHT GUARD (C2): mark before the async send so a slow confirm can't
    // double-send. If we're already handling this order id, bail.
    if (this.inFlight.has(order.id)) return;
    this.inFlight.add(order.id);

    try {
      let inputMint: string;
      let outputMint: string;
      let inAmount: number;
      let slippageBps: number;
      const { baseMint, quoteMint } = this.baseAndQuoteMints(order);

      if (order.strategyId === 'dca' || order.strategyId === 'grid') {
        inputMint = side === 'BUY' ? quoteMint : baseMint;
        outputMint = side === 'BUY' ? baseMint : quoteMint;
        slippageBps = this.cfg.risk.maxSlippageBps;
        if (side === 'BUY') {
          inAmount = order.quoteQty; // USDC -> SOL
        } else {
          // SELL SOL -> USDC: input is in SOL (base), NOT USD. (Fix: was
          // order.baseQty * price, which over-sized ~price-fold.)
          inAmount = order.baseQty;
        }
      } else {
        inputMint = side === 'BUY' ? quoteMint : baseMint;
        outputMint = side === 'BUY' ? baseMint : quoteMint;
        slippageBps = this.cfg.strategies.memes.find((m) => m.id === order.strategyId)
          ?.maxSlippageBps ?? this.cfg.risk.maxSlippageBps;
        if (side === 'BUY') {
          inAmount = order.quoteQty; // USDC -> meme
        } else {
          inAmount = order.baseQty; // meme (base) -> USDC
        }
      }

      if (!(inAmount > 0)) {
        console.warn(`[live] ${order.strategyId} ${side}: non-positive input, skipping`);
        this.inFlight.delete(order.id); // release lock — order may retry later
        return;
      }

      // H1 — PRE-SEND INPUT-BALANCE GUARD: verify the wallet actually holds the
      // input asset before building/sending. Without this, a SELL sized off a
      // stale ledger (e.g. after a manual withdrawal, or a ledger/SOL drift the
      // poll hasn't reconciled yet) submits a swap Jupiter will happily quote
      // but the chain rejects — and worse, a grid SELL of ledger SOL the wallet
      // no longer holds can strand the ladder with phantom inventory.
      // Reads the real balance straight from RPC (authoritative, not the store
      // copy) with a small safety margin so fee/solana-wrap needs don't strand
      // the tx. On failure the order stays OPEN for the next poll.
      // NATIVE SOL: SOL input must read native lamports (wSOL auto-unwraps
      // after every swap, so the SPL wSOL account reads 0 and every grid
      // SELL would be stuck "balance too low" forever — the 103.95 sell was
      // correctly crossed at 104.04 but blocked here by exactly this bug).
      const inputBalance = await (inputMint === SOL_MINT
        ? this.jup.nativeSolBalance(this.signer.publicKey)
        : this.jup.tokenBalance(this.signer.publicKey, inputMint)
      ).catch(() => 0);
      const safetyMargin =
        inputMint === SOL_MINT ? 0.01 : inputMint === USDC_MINT ? 0.1 : 0;
      const available = inputBalance - safetyMargin;
      if (inAmount > available) {
        console.warn(
          `[live] ${order.strategyId} ${side}: input balance too low — ` +
            `need ${inAmount.toPrecision(6)} ${inputMint.slice(0, 6)}…, ` +
            `wallet holds ${inputBalance.toPrecision(6)} ` +
            `(usable ${available.toPrecision(6)} after safety margin). Holding order open.`
        );
        // Reduce to what we can actually sell rather than failing forever on
        // an over-sized order — but only shrink, never top up.
        if (available <= 0) {
          // Nothing usable at all: release the lock and keep the order OPEN
          // until balances catch up (a withdrawal or a poll reconcile).
          this.inFlight.delete(order.id);
          return;
        }
        inAmount = available;
      }

      console.log(
        `[live] executing ${side} ${order.kind} ${inAmount.toPrecision(4)} ${side === 'BUY' ? 'quote' : 'base'} ` +
          `on ${baseMint.slice(0, 6)}… (slippage ${slippageBps}bps, dryrun=${dryRunEnabled()})`
      );

      // --- ROUTE SELECTION: direct PumpSwap vs Jupiter aggregator ---
      // Meme slots with a `pumpPool` swap DIRECTLY against PumpSwap (Jupiter
      // no longer routes thin graduated pools — CYB returned "Route not found"
      // in both directions). Grid/DCA and meme slots without a pump pool keep
      // the Jupiter path.
      const memeSlot = this.cfg.strategies.memes.find((m) => m.id === order.strategyId);
      const usePump = !!memeSlot?.pumpPool;
      const solPrice = this.priceOracle.current;

      // Sanity gate reference: meme slots compare against the meme's OWN live
      // price (the SOL/USDC oracle is meaningless for a meme token), plus a
      // USD/SOL consistency check since the direct path converts notional.
      let sanityRef = this.priceOracle.current; // SOL/USDC for grid/dca
      let sanityLabel = 'SOL';
      if (usePump && memeSlot) {
        const ms = this.store.strategies.memes[memeSlot.id];
        if (!ms || ms.price <= 0) {
          console.warn(
            `[live] ${order.strategyId} ${side}: no live meme price yet — holding order open`
          );
          this.inFlight.delete(order.id);
          return;
        }
        sanityRef = ms.price;
        sanityLabel = memeSlot.baseAsset;
      }

      let built = usePump && memeSlot
        ? await buildPumpSwap(this.cfg, this.jup.conn, this.signer, {
            pool: memeSlot.pumpPool as string,
            side,
            // BUY: `amount` is the USDC notional (order.quoteQty).
            // SELL: `amount` is the base qty (order.baseQty).
            amount: inAmount,
            solPriceUsd: solPrice,
            slippageBps,
          })
        : await this.jup.buildSwap(
            { inputMint, outputMint, inAmount, side, slippageBps },
            this.signer
          );

      // Pump sells pay out NATIVE SOL (wSOL unwrapped). Normalize the expected
      // proceeds to the slot's USDC quote so the sanity gate, fillPrice, and
      // the slot ledger all stay USDC-denominated like every other book.
      if (usePump && side === 'SELL') {
        built = { ...built, expectedOutAmount: built.expectedOutAmount * solPrice };
      }

      // H2 — QUOTE SANITY GATE: the implied execution price from the built tx
      // must be within RISK_MAX_QUOTE_DEVIATION_PCT (default 3%) of the live
      // reference price (SOL oracle for grid/dca; the meme slot's own live
      // price for pump memes). A quote far off the reference means a stale
      // oracle, a broken route, or a manipulated/illiquid pool — all reasons
      // NOT to fire real money. The order stays OPEN and retries next poll.
      const impliedPrice =
        side === 'BUY' ? inAmount / built.expectedOutAmount : built.expectedOutAmount / inAmount;
      const ref = sanityRef;
      const maxDevPct = (() => {
        const v = Number(process.env.RISK_MAX_QUOTE_DEVIATION_PCT);
        return Number.isFinite(v) && v > 0 && v <= 50 ? v : 3;
      })();
      if (ref > 0 && Math.abs(impliedPrice - ref) / ref > maxDevPct / 100) {
        console.warn(
          `[live] ${order.strategyId} ${side}: QUOTE SANITY REJECT — implied ` +
            `${impliedPrice.toExponential(4)} vs ${sanityLabel} ref ${ref.toExponential(4)} ` +
            `(${(((impliedPrice - ref) / ref) * 100).toFixed(2)}% off, cap ${maxDevPct}%). ` +
            `Holding order open; not sending.`
        );
        this.inFlight.delete(order.id);
        return;
      }

      // submitBuilt sends + confirms + verifies; re-asserts assertLiveAllowed at the send boundary.
      const res = await this.jup.submitBuilt(built, this.signer);
      if (res.ok && res.txid) {
        // For a BUY: input USDC in, got `expectedOutAmount` base out.
        // For a SELL: input base in, got USDC out; base sold = order.baseQty.
        const baseQtySold = side === 'SELL' ? inAmount : built.expectedOutAmount;
        const quoteReceived = side === 'BUY' ? inAmount : built.expectedOutAmount;
        const fillPrice =
          side === 'BUY' ? inAmount / built.expectedOutAmount : built.expectedOutAmount / inAmount;

        // REAL FEE: prefer the actual on-chain SOL fee read from the confirmed
        // transaction (submitBuilt). The fee is burned in native SOL regardless
        // of which token was swapped, so we convert SOL->USD at the current SOL
        // price. Falls back to the conservative model if the RPC fee parse
        // failed (best-effort reconciliation, never a crash).
        const feeUsd =
          typeof res.feeSol === 'number'
            ? res.feeSol * this.priceOracle.current
            : this.estimateFeeUsd(quoteReceived);

        // Fill the position/realized PnL. The chosen fill function returns the
        // realized PnL it banked (undefined for a BUY), so the trade record and
        // the ledger can never disagree — one computation, one source of truth.
        let realizedPnlUsd: number | undefined;
        if (order.strategyId === 'grid' || order.strategyId === 'dca') {
          realizedPnlUsd = this.applyLiveFill(order, side, baseQtySold, quoteReceived, fillPrice, feeUsd);
        } else {
          // Meme slot: update its ring-fenced state from the live fill.
          realizedPnlUsd = this.applyMemeFill(order, side, baseQtySold, quoteReceived, fillPrice, feeUsd);
        }

        order.status = 'FILLED';
        order.filledAt = Date.now();
        order.fillPrice = fillPrice;
        order.note = `live ${res.txid}${typeof res.feeSol === 'number' ? ` fee ${res.feeSol.toFixed(6)} SOL` : ''}`;
        this.store.upsertOrder(order);
        this.store.recordTrade({
          id: this.store.newOrderId(),
          orderId: order.id,
          strategyId: order.strategyId,
          direction: side,
          price: fillPrice,
          // baseQty is the BASE-asset quantity transacted (SOL or meme).
          baseQty: baseQtySold,
          quoteQty: quoteReceived,
          // Real fee (SOL->USD). recordTrade adds this to account.feesPaidUsd
          // centrally, so it is never double-booked by the fill functions.
          feeUsd,
          realizedPnlUsd: side === 'SELL' ? realizedPnlUsd : undefined,
          ts: Date.now(),
          mode: 'live',
        });
        console.log(`   [live] filled ${order.id} tx ${res.txid}`);
      } else {
        // Submit failed — keep the order OPEN so it can retry next poll.
        this.inFlight.delete(order.id);
        if (res.error) console.warn(`[live] ${order.strategyId} ${side} rejected: ${res.error}`);
      }
    } catch (e) {
      // Build/submit threw (e.g. dry-run, RPC). Release the lock so it can
      // retry; do NOT mark FILLED.
      this.inFlight.delete(order.id);
      console.warn(`[live] ${order.strategyId} ${side} failed: ${(e as Error).message}`);
    }
    // A FILLED order keeps its in-flight marker permanently (a filled order
    // must never re-send); every other path above released it for retry.
    if (order.status !== 'FILLED') this.inFlight.delete(order.id);
  }

  private estimateFeeUsd(quoteQty: number): number {
    const fixed = 0.002; // conservative priority/jito tip
    return fixed + quoteQty * 0.001;
  }

  /** Update the SOL/USDC store position + realized PnL on a live fill. Returns
   *  the realized PnL banked on a SELL (undefined for a BUY) so the trade record
   *  and this ledger share one number. Fees are NOT booked here — store.recordTrade
   *  adds trade.feeUsd to account.feesPaidUsd centrally, so a fill's fee is counted
   *  exactly once. */
  private applyLiveFill(
    order: Order,
    side: 'BUY' | 'SELL',
    baseQty: number,
    quoteQty: number,
    fillPrice: number,
    feeUsd: number
  ): number | undefined {
    let pos = this.store.getPosition('SOL', 'USDC');
    if (!pos) {
      pos = {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseQty: 0,
        quoteQty: this.store.account.balances.USDC,
        avgCostPerBase: 0,
      };
      this.store.upsertPosition(pos);
    }
    // RING-FENCED SUB-BOOK (H3): keep grid/dca live fills on the strategy's own
    // ledger too, mirroring the paper path exactly.
    const book =
      order.strategyId === 'grid' || order.strategyId === 'dca'
        ? this.store.subBook(order.strategyId as 'grid' | 'dca')
        : undefined;
    if (side === 'BUY') {
      const cost = quoteQty;
      const newBase = pos.baseQty + baseQty;
      const newCost = pos.baseQty * pos.avgCostPerBase + cost;
      pos.baseQty = newBase;
      pos.avgCostPerBase = newCost / newBase;
      pos.quoteQty -= quoteQty;
      this.store.account.openQty = pos.baseQty;
      this.store.upsertPosition(pos);
      if (book) {
        const bBase = book.baseQty + baseQty;
        const bCost = book.baseQty * book.avgCostPerBase + cost;
        book.baseQty = bBase;
        book.avgCostPerBase = bCost / bBase;
        book.feesPaidUsd += feeUsd;
      }
      return undefined;
    }

    const realized = (fillPrice - pos.avgCostPerBase) * baseQty - feeUsd;
    const beforeQty = pos.baseQty;
    pos.baseQty = Math.max(0, pos.baseQty - baseQty);
    // Remaining basis shrinks proportionally to shares sold so avgCostPerBase
    // is preserved across partial sells (proceeds + realized PnL flow to cash;
    // fee is booked once via recordTrade).
    if (beforeQty > 0 && pos.baseQty > 0) {
      pos.quoteQty *= pos.baseQty / beforeQty;
    } else {
      pos.quoteQty = 0;
    }
    this.store.account.realizedPnlUsd += realized;
    this.store.account.openQty = pos.baseQty;
    this.store.upsertPosition(pos);
    if (book) {
      const bRealized = (fillPrice - book.avgCostPerBase) * baseQty - feeUsd;
      book.baseQty = Math.max(0, book.baseQty - baseQty);
      // Average cost is INVARIANT on a partial sell; only qty shrinks.
      book.realizedPnlUsd += bRealized;
      book.feesPaidUsd += feeUsd;
    }
    return realized;
  }

  /** Update a meme slot's ring-fenced state on a live fill. */
  private applyMemeFill(
    order: Order,
    side: 'BUY' | 'SELL',
    baseQty: number,
    quoteQty: number,
    fillPrice: number,
    feeUsd: number
  ): number | undefined {
    const s = this.store.strategies.memes[order.strategyId];
    if (!s) return undefined;
    if (side === 'BUY') {
      const newBase = s.baseQty + baseQty;
      const newCost = s.baseQty * s.avgCostPerBase + quoteQty;
      s.baseQty = newBase;
      s.avgCostPerBase = newCost / newBase;
      s.deployedUsd = s.baseQty > 0 ? s.baseQty * s.avgCostPerBase : 0;
      s.buys = (s.buys ?? 0) + 1;
      // Book the fee on this slot's own ring-fenced ledger too (independent of
      // the central account.feesPaidUsd that recordTrade mantains) so the slot
      // matches its paper-mode accounting.
      s.feesPaidUsd = (s.feesPaidUsd ?? 0) + feeUsd;
      return undefined;
    }

    const realized = (fillPrice - s.avgCostPerBase) * baseQty - feeUsd;
    const beforeQty = s.baseQty;
    s.baseQty = Math.max(0, s.baseQty - baseQty);
    // Keep average cost stable on partial sell: shrink deployed basis
    // proportionally (proceeds/PnL flow to the ring-fenced USDC; fee is booked
    // once, centrally, via store.recordTrade AND once on the slot ledger).
    if (beforeQty > 0 && s.baseQty > 0) {
      s.deployedUsd *= s.baseQty / beforeQty;
    } else {
      s.deployedUsd = 0;
    }
    s.realizedPnlUsd += realized;
    s.feesPaidUsd = (s.feesPaidUsd ?? 0) + feeUsd;
    if (order.strategyId === 'cyb') {
      const pos = this.store.getPosition('CYB', 'USDC');
      const update = pos ?? { baseAsset: 'CYB', quoteAsset: 'USDC', baseQty: 0, quoteQty: 0, avgCostPerBase: 0 };
      update.baseQty = s.baseQty;
      update.quoteQty = s.deployedUsd;
      update.avgCostPerBase = s.avgCostPerBase;
      this.store.upsertPosition(update as Position);
    }
    return realized;
  }
}
