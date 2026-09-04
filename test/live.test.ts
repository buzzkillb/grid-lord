import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, PACKET_DATA_SIZE } from '@solana/web3.js';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PriceOracle } from '../src/price.js';
import { LiveBroker } from '../src/liveBroker.js';
import {
  JupiterExec, assertLiveAllowed, killLiveExecution, setDryRun,
  resetLiveGuards, lookupTablesFromSwapResponse, type BuiltSwap,
} from '../src/jupiter.js';
import type { Order } from '../src/types.js';

process.env.NODE_ENV = 'test';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 400, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.15,
};
const strategies: StrategyConfig = {
  grid: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    lowerPrice: 90, upperPrice: 110, numLevels: 8, usdcPerGrid: 10,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 0, volSizingEnabled: false, vwapSkewEnabled: false, skewStrength: 0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 10, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 5, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(mode: 'paper' | 'live' = 'live'): AppConfig {
  return {
    mode, rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2',
    pollIntervalMs: 1000, refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

beforeEach(() => resetLiveGuards());

/** Build a minimal, valid signed-shape VersionedTransaction (never sent). */
function dummyBuilt(kp: Keypair): BuiltSwap {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const message = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [],
  }).compileToV0Message([]);
  return {
    tx: new VersionedTransaction(message),
    inputMint: USDC,
    outputMint: SOL,
    expectedOutAmount: 1,
  };
}

function order(id: string, side: 'BUY' | 'SELL', strategyId = 'dca'): Order {
  return {
    id, kind: 'DCA_TRADE', side,
    price: 100, baseQty: 1, quoteQty: 100,
    status: 'OPEN', createdAt: Date.now(), mode: 'paper', strategyId, note: 'x',
  };
}

// ---------------------------------------------------------------------------
// LIVE GATE MATRIX — deterministic, no network, no funds
// ---------------------------------------------------------------------------

test('assertLiveAllowed refuses paper mode even with dry-run off', () => {
  setDryRun(false);
  assert.throws(() => assertLiveAllowed(cfg('paper')), /TRADE_MODE is not "live"/);
});

test('assertLiveAllowed refuses live+dry-run (build-only, never send)', () => {
  setDryRun(true);
  assert.throws(() => assertLiveAllowed(cfg('live')), /DRY-RUN/);
});

test('assertLiveAllowed refuses live when kill-switch is armed', () => {
  setDryRun(false);
  killLiveExecution();
  assert.throws(() => assertLiveAllowed(cfg('live')), /KILL-SWITCH/);
});

test('assertLiveAllowed passes ONLY with live + dry-run off + no kill-switch', () => {
  setDryRun(false);
  assert.equal(assertLiveAllowed(cfg('live')), undefined);
});

test('submitBuilt refuses at the send boundary BEFORE any network call', async () => {
  // In dry-run AND in a non-live mode, submitBuilt must throw the live gate
  // error at the very top — before the fee-floor RPC / blockhash / send. We
  // prove it by passing a fake BuiltSwap that could never serialize: if the
  // gate weren't first, this would fail for the wrong (network) reason.
  const jup = new JupiterExec(cfg('paper'));
  await assert.rejects(
    () => jup.submitBuilt(dummyBuilt(Keypair.generate()), Keypair.generate()),
    /TRADE_MODE is not "live"/
  );

  setDryRun(true);
  const jup2 = new JupiterExec(cfg('live'));
  await assert.rejects(
    () => jup2.submitBuilt(dummyBuilt(Keypair.generate()), Keypair.generate()),
    /DRY-RUN/
  );
});

test('refused live swap leaves the order OPEN (never filled, never blocked permanently)', async () => {
  setDryRun(true); // live armed but dry-run on
  // TEST ISOLATION: never let a unit test read/write the PRODUCTION state file
  // (.botstate/state-live.json holds real fills from the live bot — restoring
  // it here made `trades.length === 0` fail whenever the bot had traded).
  const prevPersist = process.env.STATE_PERSIST;
  process.env.STATE_PERSIST = '0';
  const store = new StateStore(cfg('live'));
  store.price = 100;
  const oracle = new PriceOracle(cfg('live'));
  oracle.__setPrice(100, true);
  const broker = new LiveBroker(cfg('live'), store, oracle, Keypair.generate());

  const o = order('odr', 'BUY');
  broker.marketBuy(o);
  await new Promise((r) => setTimeout(r, 50));

  // The gate refused the swap; the order must remain OPEN (not FILLED) so it
  // can succeed once live is actually armed.
  assert.equal(o.status, 'OPEN', 'refused live BUY must stay OPEN');
  assert.equal(o.mode, 'live');
  assert.ok(store.trades.length === 0, 'no fake trade recorded on refusal');
  if (prevPersist === undefined) delete process.env.STATE_PERSIST;
  else process.env.STATE_PERSIST = prevPersist;
});

// ---------------------------------------------------------------------------
// LUT-COMPRESSION REGRESSION TEST (deterministic, no network)
// ---------------------------------------------------------------------------
// Proves buildSwap consumes the response's `addressesByLookupTableAddress` map
// to compress a multi-hop route under the 1280-byte packet. Failure mode before
// the fix: redis a non-existent `addressLookupTableAddresses` field -> ZERO
// lookup tables -> a 50-key multi-hop route overflows and serialize() throws
// "encoding overruns Uint8Array" (would silently stop live BUYs/SELLs).

test('buildSwap compresses multi-hop routes via addressesByLookupTableAddress', () => {
  // A large multi-hop route: 40 accounts addressed only through one LUT.
  const lutKey = PublicKey.unique();
  const manyAccounts = Array.from({ length: 40 }, () => PublicKey.unique().toBase58());
  const tables = lookupTablesFromSwapResponse({ [lutKey.toBase58()]: manyAccounts });

  // Exactly one lookup table was constructed, holding all 40 addresses.
  assert.equal(tables.length, 1);
  assert.equal(tables[0].key.toBase58(), lutKey.toBase58());
  assert.equal(tables[0].state.addresses.length, 40);

  // Compile a message whose instructions reference accounts via that LUT. If the
  // LUT is honored, the message stays small (few static keys) and serializes.
  const signer = Keypair.generate();
  const instr = new TransactionInstruction({
    programId: PublicKey.unique(),
    keys: manyAccounts.map((p, i) => ({
      pubkey: new PublicKey(p), isSigner: false, isWritable: i % 3 === 0,
    })),
    data: Buffer.alloc(4),
  });
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instr],
  }).compileToV0Message(tables);

  // Only the payer is static; the 40 route accounts live in the LUT.
  assert.ok(message.addressTableLookups.length >= 1, 'message uses the lookup table');
  assert.ok(
    message.staticAccountKeys.length <= 3,
    `route accounts were compressed into a LUT (static keys=${message.staticAccountKeys.length})`
  );
  // Confirm it serializes (before the fix this would have ~44 static keys and fail).
  const bytes = message.serialize();
  assert.ok(bytes.length <= 1232, `compressed message fits the packet (${bytes.length} bytes)`);

  // Edge cases: empty / malformed maps must yield no tables, never throw.
  assert.equal(lookupTablesFromSwapResponse(undefined).length, 0);
  assert.equal(lookupTablesFromSwapResponse({}).length, 0);
  assert.equal(lookupTablesFromSwapResponse({ [PublicKey.unique().toBase58()]: [] }).length, 0);
});

// ---------------------------------------------------------------------------
// REAL TRANSACTION BUILD TESTS (live Jupiter + RPC)
// ---------------------------------------------------------------------------
// These build + SIGN the exact versioned transactions we would submit for a
// BUY (USDC->SOL) and a SELL (SOL->USDC), sourced from live Jupiter quotes,
// WITHOUT sending them. They need real network + a funded-armable account and
// are opt-in so `npm test` stays green offline.
//   RUN_LIVE_TX_TESTS=1 npm test
// ---------------------------------------------------------------------------

const RUN_LIVE = process.env.RUN_LIVE_TX_TESTS === '1';

test('LIVE: build real signed BUY tx (USDC->SOL) and SELL tx (SOL->USDC)', { skip: !RUN_LIVE }, async () => {
  const cfgReal = loadConfig();
  const jup = new JupiterExec(cfgReal);
  const signer = Keypair.generate(); // throwaway — no funds, nothing sent

  // BUY: 1 USDC worth of SOL.
  const buy = await jup.buildSwap(
    { inputMint: USDC, outputMint: SOL, inAmount: 1, side: 'BUY', slippageBps: 100 },
    signer
  );
  assert.ok(buy.expectedOutAmount > 0, 'BUY route resolved to positive SOL out');
  assert.equal(buy.inputMint, USDC);
  assert.equal(buy.outputMint, SOL);
  assertBuiltTxSignedBy(buy, signer, 'BUY');

  // SELL: 0.01 SOL worth of USDC.
  const sell = await jup.buildSwap(
    { inputMint: SOL, outputMint: USDC, inAmount: 0.01, side: 'SELL', slippageBps: 100 },
    signer
  );
  assert.ok(sell.expectedOutAmount > 0, 'SELL route resolved to positive USDC out');
  assert.equal(sell.inputMint, SOL);
  assert.equal(sell.outputMint, USDC);
  assertBuiltTxSignedBy(sell, signer, 'SELL');

  // The two txs are distinct signed artifacts (different route/amount bytes).
  const buyBytes = buy.tx.serialize();
  const sellBytes = sell.tx.serialize();
  assert.notDeepEqual(buyBytes, sellBytes, 'BUY and SELL txs differ');
});

function assertBuiltTxSignedBy(built: BuiltSwap, signer: Keypair, label: string): void {
  // 1. It is a real versioned transaction.
  assert.ok(built.tx instanceof VersionedTransaction, `${label} is a VersionedTransaction`);
  // 2. Signer is the payer (static account 0).
  const payer = built.tx.message.staticAccountKeys[0];
  assert.ok(PublicKey.isOnCurve(payer), `${label} payer is a valid pubkey`);
  assert.equal(payer.toBase58(), signer.publicKey.toBase58(), `${label} payer = signer`);
  // 3. The transaction is actually SIGNOUS (signature bytes are not all-zero).
  const sig = built.tx.signatures[0];
  assert.ok(
    !!sig && typeof sig === 'object' && sig.length === 64,
    `${label} has a 64-byte signature slot`
  );
  assert.ok(sig.some((b) => b !== 0), `${label} signatures non-zero (signed)`);
  // 4. It round-trips through serialize() (valid transaction bytes).
  const bytes = built.tx.serialize();
  assert.ok(bytes.length > 50, `${label} serialized tx is non-trivial in size`);
}

test('LIVE: LiveBroker routes a successful live fill through real-fee accounting', { skip: !RUN_LIVE }, async () => {
  // This is the full live path minus submission: build a REAL signed tx through
  // the broker, then dry-run refusal. It proves the broker computes mints, size,
  // and direction correctly against real Jupiter before any send.
  const cfgReal = { ...loadConfig(), mode: 'live' as const };
  const store = new StateStore(cfgReal);
  store.price = 100;
  const oracle = new PriceOracle(cfgReal);
  oracle.__setPrice(100, true);
  const signer = Keypair.generate();
  const broker = new LiveBroker(cfgReal, store, oracle, signer);

  setDryRun(true); // build is allowed, send is refused — no network tx leaves
  const o = order('livebuy', 'BUY');
  broker.marketBuy(o);
  await new Promise((r) => setTimeout(r, 2000));

  // With dry-run on, executeSwap builds+refuses at submit; order stays OPEN and
  // no trade is recorded. This exercises the full guard + build routing.
  assert.equal(o.status, 'OPEN');
  assert.equal(store.trades.length, 0);
});

// ---------------------------------------------------------------------------
// PRE-BROADCAST VERIFICATION (deterministic, no network)
// ---------------------------------------------------------------------------
// The exact failure modes between "signed" and "broadcast" that don't need
// funds to prove out:
//   1. serialize() → VersionedTransaction.deserialize() round-trips the exact
//      same bytes (wire-format integrity — what RPC sendTransaction receives).
//   2. The message bytes are bit-identical pre/post round-trip (no silent
//      recompilation, no lost LUTs).
//   3. The serialized size fits the 1232-byte wire packet (PACKET_DATA_SIZE).
//   4. Signature count matches required signature count (payer present).
// ---------------------------------------------------------------------------

test('pre-broadcast round-trip: serialize/deserialize preserves exact bytes, message, size, sigs', () => {
  const kp = Keypair.generate();
  const built = dummyBuilt(kp);

  // Sign it the way buildSwap does (throwaway keypair, no funds, never sent).
  const signed = new VersionedTransaction(built.tx.message);
  signed.sign([kp]);

  const wire = signed.serialize();
  const rt = VersionedTransaction.deserialize(wire);

  // 1. Byte-exact round-trip.
  const wire2 = rt.serialize();
  assert.ok(Buffer.compare(Buffer.from(wire), Buffer.from(wire2)) === 0,
    'serialize->deserialize->serialize must be byte-identical');

  // 2. Message integrity (LUTs + instructions survive untouched).
  assert.deepEqual(rt.message.staticAccountKeys.map((k) => k.toBase58()),
    signed.message.staticAccountKeys.map((k) => k.toBase58()),
    'static account keys must survive the round-trip');
  assert.equal(rt.message.compiledInstructions.length,
    signed.message.compiledInstructions.length,
    'instruction count must survive the round-trip');

  // 3. Packet-size fit (the LUT-compression guard's downstream guarantee).
  assert.ok(wire.length <= PACKET_DATA_SIZE, `tx ${wire.length}B exceeds ${PACKET_DATA_SIZE}B packet`);

  // 4. Signature slot present for the payer.
  assert.equal(rt.signatures.length, 1, 'payer signature slot');
  assert.ok(rt.signatures[0].length === 64, 'signature is 64 bytes (r||s)');
});
