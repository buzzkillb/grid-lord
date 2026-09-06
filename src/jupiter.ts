import type { AppConfig } from './config.js';
import type { Side } from './types.js';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  TransactionInstruction,
  PACKET_DATA_SIZE,
} from '@solana/web3.js';

export interface ExecQuote {
  inAmount: number; // amount in (human units, e.g. SOL)
  outAmount: number; // amount out (human units, e.g. USDC)
  priceImpactPct: number;
  feeUsd: number;
  /** The raw Jupiter quote response, kept so the swap step can reuse it. */
  quoteResponse?: unknown;
}

export interface ExecResult {
  ok: boolean;
  txid?: string;
  outAmount?: number;
  /** Actual on-chain SOL fee paid for this tx (lamports / 1e9), read from the
   *  confirmed transaction's RPC metadata. Undefined if the parse failed, in
   *  which case callers fall back to their conservative fee model. */
  feeSol?: number;
  error?: string;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  inAmount: number; // human units of input
  side: Side;
  /** slippage in bps (the per-strategy cap, e.g. CYB uses 500 bps = 5%). */
  slippageBps: number;
}

/** A fully-signed versioned transaction ready to submit (the dry-run boundary). */
export interface BuiltSwap {
  tx: VersionedTransaction;
  inputMint: string;
  outputMint: string;
  expectedOutAmount: number;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const MINT_DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9, // SOL
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  J2hyZSVokSTuy3bG85A5xfs3umCeGtqZZEdKtGTTpump: 6, // CYB (pump.fun default 6)
};

/** Known base mints we trade (for source-truth validation / logging). */
function decimalsOf(mint: string): number {
  return MINT_DECIMALS[mint] ?? 6;
}

/** Native-SOL fee floor for live swaps (SOL). Clamped to a sane 0.001–1 SOL. */
function cfgFeeFloorSol(): number {
  const v = Number(process.env.WALLET_FEE_FLOOR_SOL);
  if (Number.isFinite(v) && v > 0) return Math.min(1, Math.max(0.001, v));
  return 0.05; // default: require ≥0.05 native SOL before any live send
}

/**
 * Native-SOL reserve the bot ALWAYS keeps for network/priority fees and never
 * sells below. The SOL/USDC strategies sell native SOL as their base inventory,
 * and with a tiny 0.01 SOL margin they historically sold themselves down to
 * ~0, leaving the wallet with no SOL to pay fees (the "native SOL too low for
 * fees" stall). Raising this margin to a real reserve means the bot keeps a
 * standing fee buffer and can keep buying/selling indefinitely without you
 * topping up from another wallet. Clamped to [0, 10] SOL.
 */
export function cfgSolReserveSol(): number {
  const v = Number(process.env.SOL_FEE_RESERVE_SOL);
  if (Number.isFinite(v) && v >= 0) return Math.min(10, v);
  return 0.1; // default: keep ≥0.1 native SOL (≈$10 at $106/SOL) for fees
}

/**
 * Jupiter execution layer (Swap API V2).
 *
 *  - `quote()`      -> GET /quote, used for pricing/slippage in both modes.
 *  - `buildSwap()`  -> GET /quote + POST /swap-instructions, composes a signed
 *                      versioned transaction (compute budget + setup + swap +
 *                      ALT entries) WITHOUT sending it. This is the dry-run
 *                      boundary — nothing touches the network until `submit()`.
 *  - `submitBuilt()`-> sends + confirms + verifies the on-chain balance change.
 *
 * Live sending is gated by `assertLiveAllowed()` (mode=live AND kill-switch
 * off AND dry-run off). Paper mode never routes here for execution — the
 * PaperBroker simulates fills and stays untouched.
 */
export class JupiterExec {
  /** Shared RPC connection (also used by the direct PumpSwap path). */
  readonly conn: Connection;

  /** Feature D cache: live fee-market level, refreshed at most every 60s. */
  private feeLevelCache: { level: 'low' | 'medium' | 'high'; at: number } | null = null;

  constructor(private cfg: AppConfig) {
    this.conn = new Connection(cfg.rpcUrl, 'confirmed');
  }

  private get base(): string {
    return this.cfg.jupiterApiUrl.replace(/\/$/, '');
  }

  /** Best-route quote for an exact input amount (human units). */
  async quote(
    inputMint: string,
    outputMint: string,
    amount: number,
    _side: Side,
    slippageBps?: number
  ): Promise<ExecQuote> {
    const inDecimals = decimalsOf(inputMint);
    const outDecimals = decimalsOf(outputMint);
    const rawAmount = Math.round(amount * 10 ** inDecimals);
    const bps = slippageBps ?? this.cfg.risk.maxSlippageBps;

    const url =
      `${this.base}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${rawAmount}&slippageBps=${bps}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`jupiter /quote HTTP ${res.status}`);
    const json = (await res.json()) as {
      inAmount?: string;
      outAmount?: string;
      priceImpactPct?: string;
      priceImpact?: number;
    };
    return {
      inAmount: Number(json.inAmount ?? '0') / 10 ** inDecimals,
      outAmount: Number(json.outAmount ?? '0') / 10 ** outDecimals,
      priceImpactPct: parseFloat(
        json.priceImpactPct ?? String(json.priceImpact ?? '0')
      ),
      feeUsd: 0, // real priority/Jito fees are on-chain; applied at execution
      quoteResponse: json,
    };
  }

  /**
   * Assemble and sign a versioned swap transaction without sending it.
   * This is the dry-run / confirmation boundary for live mode.
   */
  /**
   * Feature D — FEE-MARKET GUARD: pick the Jupiter priority level from the
   * LIVE Solana fee market instead of a hardcoded 'medium'. Congestion raises
   * our level so swaps don't land late at a worse price; a quiet market drops
   * to 'low' so we don't burn lamports on every grid wave. Cached 60s; any
   * RPC failure falls back to 'medium' (previous behavior).
   */
  private async priorityFeeLevel(): Promise<'low' | 'medium' | 'high'> {
    const now = Date.now();
    if (this.feeLevelCache && now - this.feeLevelCache.at < 60_000) {
      return this.feeLevelCache.level;
    }
    let level: 'low' | 'medium' | 'high' = 'medium';
    try {
      const fees = await this.conn.getRecentPrioritizationFees();
      if (fees.length > 0) {
        const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        level = median >= 50_000 ? 'high' : median <= 5_000 ? 'low' : 'medium';
      }
    } catch {
      level = 'medium';
    }
    this.feeLevelCache = { level, at: now };
    return level;
  }

  async buildSwap(p: SwapParams, signer: Keypair): Promise<BuiltSwap> {
    const inDecimals = decimalsOf(p.inputMint);
    const outDecimals = decimalsOf(p.outputMint);
    const rawAmount = Math.round(p.inAmount * 10 ** inDecimals);
    const slippageBps = p.slippageBps;

    // Build the swap for the given route mode. `direct` requests Jupiter's
    // direct (single-hop / lowest-leg) route, which is guaranteed to fit the
    // 1280-byte v0 packet, whereas the full multi-hop route — even though it
    // cites address-lookup tables — can overflow when the table set is empty
    // but the route still needs ~50 static keys. We prefer the full route for
    // best price, and fall back to the direct route when it won't fit.
    const build = async (direct: boolean): Promise<BuiltSwap> => {
      const quoteUrl =
        `${this.base}/quote?inputMint=${p.inputMint}&outputMint=${p.outputMint}` +
        `&amount=${rawAmount}&slippageBps=${slippageBps}` +
        (direct ? '&onlyDirectRoutes=true' : '');
      const qRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(15000) });
      if (!qRes.ok) throw new Error(`jupiter /quote HTTP ${qRes.status}`);
      const quote = (await qRes.json()) as Record<string, unknown> & {
        outAmount?: string;
      };
      const expectedOut = Number(quote.outAmount ?? '0') / 10 ** outDecimals;
      if (!(expectedOut > 0)) throw new Error('jupiter quote produced no output');

      // Feature D — priority level follows the live fee market (cached 60s):
      // don't overpay in a quiet market, don't underpay in congestion.
      const prio = await this.priorityFeeLevel();
      const swRes = await fetch(`${this.base}/swap-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taker: signer.publicKey.toBase58(),
          quoteResponse: quote,
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: prio },
          dynamicComputeUnitLimit: true,
          wrapAndUnwrapSol: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!swRes.ok) {
        const text = await swRes.text().catch(() => '');
        throw new Error(`jupiter /swap-instructions HTTP ${swRes.status}: ${text.slice(0, 160)}`);
      }
      const sw = (await swRes.json()) as {
        computeBudgetInstructions?: RawIx[];
        setupInstructions?: RawIx[];
        swapInstruction: RawIx;
        cleanupInstruction?: RawIx;
        /** Proposed transactions may also arrive split across other/tip ixs. */
        otherInstructions?: RawIx[];
        tipInstruction?: RawIx;
        /**
         * Ordered map of address-lookup-table pubkey -> its account addresses.
         * This is what compresses a multi-hop route down to fit the 1280-byte
         * v0 packet. (NOT `addressLookupTableAddresses` — that field does not
         * exist in the current swap-instructions response.)
         */
        addressesByLookupTableAddress?: Record<string, string[]>;
        blockhashWithMetadata?: { blockhash?: string };
      };
      if (!sw.swapInstruction) throw new Error('jupiter /swap-instructions returned no swap instruction');

      // Build `AddressLookupTableAccount`s from the inline per-LUT addresses the
      // API already returned (key = LUT pubkey, value = its account addresses).
      // This is the critical step that keeps a multi-hop route inside the packet
      // budget; reading a non-existent `addressLookupTableAddresses` field would
      // silently yield ZERO LUTs and overflow the transaction.
      const lookupTables = lookupTablesFromSwapResponse(
        sw.addressesByLookupTableAddress
      );

      const ix = (r: RawIx): TransactionInstruction => {
        const keys = (r.accounts ?? []).map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: !!a.isSigner,
          isWritable: !!a.isWritable,
        }));
        return new TransactionInstruction({
          programId: new PublicKey(r.programId),
          keys,
          data: Buffer.from(r.data, 'base64'),
        });
      };
      const instructions = [
        ...(sw.computeBudgetInstructions ?? []),
        ...(sw.setupInstructions ?? []),
        sw.swapInstruction,
        ...(sw.cleanupInstruction ? [sw.cleanupInstruction] : []),
      ].map(ix);

      const { blockhash } = await this.conn.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(lookupTables);

      // Sanity guard: estimate whether the versioned-v0 message fits the
      // 1280-byte Solana packet WITHOUT calling serialize() (which throws on an
      // oversized message). A route Jupiter returned without enough address
      // lookup table coverage can exceed the packet; we detect that by size
      // estimate and fall back to the direct route below.
      const staticAccountBytes = message.staticAccountKeys.length * 32;
      if (staticAccountBytes > PACKET_DATA_SIZE) {
        throw new Error(
          `swap transaction's ${message.staticAccountKeys.length} static account keys ` +
          `(~${staticAccountBytes} bytes) exceed Solana's ${PACKET_DATA_SIZE}-byte packet limit ` +
          `(route returned insufficient address lookup tables)`
        );
      }

      const tx = new VersionedTransaction(message);
      tx.sign([signer]);

      return {
        tx,
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        expectedOutAmount: expectedOut,
      };
    };

    // Try the full multi-hop route first (best price); if it would overflow the
    // packet, transparently fall back to the direct route so trading continues
    // rather than the swap failing outright.
    try {
      return await build(false);
    } catch (e) {
      const firstErr = (e as Error).message;
      if (/packet limit|overrun/.test(firstErr)) {
        try {
          return await build(true);
        } catch (e2) {
          throw new Error(
            `swap build failed (full route: ${firstErr}; direct route: ${(e2 as Error).message})`
          );
        }
      }
      throw e;
    }
  }

  /** Send a built transaction, confirm it, and verify the on-chain balance. */
  async submitBuilt(built: BuiltSwap, signer: Keypair): Promise<ExecResult> {
    // DEFENSE-IN-DEPTH (#2): re-assert the live gate AT the send boundary, not
    // just at the top of the calling strategy path. The auto circuit-breaker or
    // a manual kill can trip between buildSwap() and submit — this guarantees
    // we never transmit funds with live un-armed, in dry-run, or kill-switched,
    // even if a future caller routes here without its own gate.
    assertLiveAllowed(this.cfg);

    // NATIVE-SOL FEE FLOOR (#3): before sending, ensure the wallet holds enough
    // native SOL to pay the priority fee + base fees. A swap that costs real
    // fees (priority + base) will simply fail if lamports run dry — and worse,
    // leaves the wallet "armed but unable to pay". This cheap on-chain check
    // prevents blindly submitting into a gasless wallet.
    const lamports = await this.conn.getBalance(signer.publicKey).catch(() => 0);
    const minFeeLamports =
      Math.max(1e-9, Math.min(1, cfgFeeFloorSol())) * 1e9; // env floor, clamped sane
    if (lamports < minFeeLamports) {
      return {
        ok: false,
        error: `native SOL too low for fees: ${(lamports / 1e9).toFixed(4)} SOL < ` +
          `${(minFeeLamports / 1e9).toFixed(4)} floor`,
      };
    }

    const before = await this.tokenBalance(signer.publicKey, built.outputMint);
    const beforeSol = (await this.conn.getBalance(signer.publicKey)) / 1e9;

    // Modern confirmation strategy: blockhash + lastValidBlockHeight lets
    // confirmTransaction wait until the tx either confirms or the blockhash
    // expires — far more reliable than the legacy signature-only timeout.
    const { blockhash, lastValidBlockHeight } =
      await this.conn.getLatestBlockhash('confirmed');

    const sig = await this.conn.sendTransaction(built.tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    console.log(`   swap sent: ${sig}`);

    // Blockhash-based confirmation (recommended over TransactionSignature form).
    await this.conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    console.log(`   swap confirmed: ${sig}`);

    // Belt-and-suspenders: confirm the output token actually increased.
    await new Promise((r) => setTimeout(r, 1500));
    // Output verification: SPL mints are checked via token accounts; native-SOL
    // outputs (direct PumpSwap sells unwrap wSOL, leaving no SPL balance) are
    // checked via the wallet lamport delta instead.
    const got =
      built.outputMint === SOL_MINT
        ? (await this.conn.getBalance(signer.publicKey)) / 1e9 - beforeSol
        : (await this.tokenBalance(signer.publicKey, built.outputMint)) - before;
    if (got < built.expectedOutAmount * 0.99) {
      console.warn(
        `   [verify] output only changed by ${got.toFixed(6)} (expect ≈${built.expectedOutAmount.toFixed(6)}) — ` +
          `check https://solscan.io/tx/${sig}`
      );
    }

    // REAL FEE CAPTURE: read the actual on-chain SOL fee (base + priority) from
    // the confirmed transaction so accounting reflects what was really paid,
    // not just a model. We do NOT use Jito bundle tips, so `meta.fee` == the
    // total SOL the feepayer spent on this transaction.
    let feeSol: number | undefined;
    try {
      const parsed = await this.conn.getParsedTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const feeLamports = parsed?.meta?.fee;
      if (typeof feeLamports === 'number' && Number.isFinite(feeLamports)) {
        feeSol = feeLamports / 1e9;
      }
    } catch {
      /* best-effort; caller falls back to its fee model */
    }
    if (typeof feeSol === 'number') {
      console.log(`   [verify] on-chain fee ${feeSol.toFixed(6)} SOL for ${sig}`);
    }

    return { ok: true, txid: sig, outAmount: got, feeSol };
  }

  /** SPL token balance of a mint for an owner, in human units. */
  /**
   * Native SOL (wallet lamports). NOT the same as tokenBalance(SOL_MINT):
   * wSOL auto-unwraps after swaps, so the SOL a wallet actually owns lives in
   * system-account lamports, and the SPL wSOL account is usually empty.
   * Reading tokenBalance(SOL) silently zeroes the whole position.
   */
  async nativeSolBalance(owner: PublicKey): Promise<number> {
    const lamports = await this.conn.getBalance(owner);
    return lamports / 1e9;
  }

  async tokenBalance(owner: PublicKey, mint: string): Promise<number> {
    const resp = await this.conn.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(mint),
    });
    if (resp.value.length === 0) return 0;
    const parsed = resp.value[0].account.data.parsed.info;
    const raw = Number(parsed.tokenAmount.amount ?? '0');
    const decimals = Number(parsed.tokenAmount.decimals ?? decimalsOf(mint));
    return raw / 10 ** decimals;
  }
}

type RawIx = {
  programId: string;
  accounts: {
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  data: string;
};

/**
 * Build `AddressLookupTableAccount`s from the swap-instructions response's
 * `addressesByLookupTableAddress` map (LUT pubkey -> its account addresses).
 * This is what compresses a multi-hop route down to fit the 1280-byte v0
 * packet. Reading a non-existent `addressLookupTableAddresses` field instead
 * would silently yield ZERO LUTs and cause multi-hop routes to overflow.
 * Extracted as a pure helper so it is unit-testable without network.
 */
export function lookupTablesFromSwapResponse(
  addressesByLookupTableAddress?: Record<string, string[]>
): AddressLookupTableAccount[] {
  const out: AddressLookupTableAccount[] = [];
  for (const [addr, list] of Object.entries(addressesByLookupTableAddress ?? {})) {
    if (!Array.isArray(list) || list.length === 0) continue;
    out.push(
      new AddressLookupTableAccount({
        key: new PublicKey(addr),
        state: {
          deactivationSlot: BigInt(0),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: new PublicKey(addr),
          addresses: list.map((a) => new PublicKey(a)),
        },
      })
    );
  }
  return out;
}

/**
 * LIVE SAFETY GUARDS — a single choke-point every live execution path must
 * clear before touching the network. Dry-run is ON by default so even a
 * mis-configured dev run can only build/validate, never send funds.
 */
let KILL_SWITCH = false;
let DRY_RUN = true;

export function killLiveExecution(): void {
  KILL_SWITCH = true;
}
export function liveExecutionKilled(): boolean {
  return KILL_SWITCH;
}
export function setDryRun(v: boolean): void {
  DRY_RUN = v;
}
export function dryRunEnabled(): boolean {
  return DRY_RUN;
}
/** Test-only reset so tests can exercise the gate matrix in any order. */
export function resetLiveGuards(): void {
  KILL_SWITCH = false;
  DRY_RUN = true;
}

export function assertLiveAllowed(cfg: AppConfig): void {
  if (KILL_SWITCH) throw new Error('LIVE EXECUTION KILL-SWITCH IS ARMED');
  if (cfg.mode !== 'live') {
    throw new Error(
      'Refusing live swap: TRADE_MODE is not "live". Set TRADE_MODE=live to enable real execution.'
    );
  }
  if (DRY_RUN) {
    throw new Error(
      'DRY-RUN: swap built+validated but NOT submitted. DRY_RUN is on; disable it deliberately to send funds.'
    );
  }
}
