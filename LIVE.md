# Live execution — how to enable (read fully before arming)

The bot now has a **real Jupiter Swap API V2 execution layer** (SOL/USDC + meme
pairs), layered with hard safety guards. **It is still in PAPER mode** — nothing
is live until you follow these exact steps.

## Funding split (IMPORTANT: the bot spends USDC, not SOL)

Every strategy BUYS with **USDC** (SOL grid & DCA buy SOL for USDC; CYB buys
CYB for USDC). Native SOL is only used for network/priority fees plus the grid's
SELL legs. So fund the wallet with **mostly USDC + a little native SOL**.

For a **15 SOL (~$1,640) wallet** at ~$109:
- **Convert ~13.5 SOL → ~$1,470 USDC** (working capital)
- **Keep ~1.5 – 2 SOL native** (fees + sell inventory)

## Wallet-aware sizing (auto budgets from real balances)

On live startup the bot reads your **actual on-chain SOL + USDC balances**, grabs
a live SOL price, and derives every budget as a **% of total equity** — no more
hardcoded caps. It prints a startup report, e.g. for a ~$1,640 wallet:

```
─ Wallet sizing (derived from real balances) ─
   native SOL : 1.5000  (@ $109.40)
   USDC       : 1477.00
   total equity: $1641.00
   SOL grid    : ~$31/level base
   DCA budget  : ~$574 (target ~2.6 SOL)
   CYB cap     : $164
   hard-stop ref: $985 (25% = -$246)
```

Tune the split with env vars (all % of total equity):
- `GRID_ALLOC_PCT` (default 15) — active SOL-grid notional
- `DCA_ALLOC_PCT` (default 35) — total DCA deployment budget
- `CYB_ALLOC_PCT` (default 10) — CYB ring-fence cap
- `WALLET_RESERVE_PCT` (default 40) — idle buffer kept out of active books
- `WALLET_AUTO_SIZE=0` — disable (use the old hardcoded caps)

**The wallet doesn't have to spend it all** — these are ceilings derived from
your equity; the strategies deploy gradually and only as their (real-data) entry
conditions trigger.

## The safety gates (ALL must pass to move real funds)

1. **`TRADE_MODE=live`** — the config mode must be `live`.
2. **A real `wallet.key` must exist** at `./wallet.key` (git-ignored) with your
   secret key, in either:
   - base58 secret key (standard `SOLANA_PRIVATE_KEY` format), or
   - a JSON array of 64 bytes.
   > **Never paste your private key in chat.** Put it in `wallet.key` yourself.
3. **`LIVE_ARM=1`** — even in live mode the bot stays **dry-run by default**:
   swaps are built + validated but **never sent**. Setting `LIVE_ARM=1` is your
   explicit go-live signal. Combined with the in-code kill-switch this means a
   misconfigured run cannot silently spend funds.

## Runtime risk protections (built in)

These fire automatically in **live** mode and need no action from you:

- **Realized hard-stop** — pauses the whole bot if cumulative realized PnL drops
  below `RISK_HARD_STOP_PCT` of the live position cap.
- **Unrealized draw-down guard** — pauses *new deployment* (but keeps selling)
  if the open SOL basket is underwater by more than `RISK_UNREALIZED_STOP_PCT`
  of the cap, so a falling market can't bleed past the realized stop before
  anything closes. Independent of the realized hard-stop.
- **Per-slot loss ceilings** — each meme slot halts accumulation once its
  realized loss breaches `CYB_MAX_LOSS_USD`, ring-fencing a rug so it can't
  drain the SOL book.
- **Dead-book / exit-liquidity exit** — if a meme's real pool liquidity decays
  past `CYB_LIQ_DECAY_EXIT_PCT` from its peak, the slot defensively sells out
  (rug / exit-liquidity signal).
- **Native-SOL fee floor** — every live send is gated on the wallet holding at
  least `WALLET_FEE_FLOOR_SOL` native SOL (network/priority fees + sell
  inventory), so it can never be "armed but unable to pay."
- **Auto circuit-breaker** — if all live price feeds stay stale for
  `RISK_MAX_STALE_POLLS`, the bot auto-arms the kill-switch (halts the swap
  path) and notifies, instead of limping on stale prices.
- **Periodic wallet re-sizing** — every `WALLET_RECHECK_MIN` min the engine
  re-reads real balances and re-derives budgets, auto-sweeping deposits/profits
  in without a restart.
- **State persistence** — runtime state (positions/orders/trades/trailing peaks)
  is written to `.botstate/state-<mode>.json` every 30s + on shutdown and
  reconciled on restart, so a crash can't reset signals or orphan orders. Live
  balances are always re-read from chain (never trust a stale persisted number).
- **Notifications** — events (TP banks, realized losses, hard stops) are always
  appended to `.botstate/events.log`; set `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID` to also get them pushed to a Telegram chat.

## Enable steps

```bash
# 1. Put your real key in the git-ignored file (base58 OR 64-byte JSON)
#    e.g.  printf 'YOUR_BASE58_SECRET' > wallet.key
#    or    echo '[1,2,3,...]' > wallet.key
chmod 600 wallet.key

# 2. Set mode to live in .env
#    TRADE_MODE=live

# 3. (Recommended) First run in live mode WITHOUT LIVE_ARM to dry-run:
npm run build
LIVE_ARM= node dist/bot.js
#    -> logs "LIVE mode but DRY-RUN: swaps built+validated, NOT sent"

# 4. Verify wallet pubkey + balances on-chain match what you expect,
#    then do a SMALL first trade with:
npm run build
LIVE_ARM=1 node dist/bot.js
```

## Kill-switch

`killLiveExecution()` arms a firm module-wide kill-switch; while active every
live path throws `LIVE EXECUTION KILL-SWITCH IS ARMED`. Any strategy fault,
unexpected PnL, **the auto circuit-breaker (all price feeds stale)**, or manual
`Ctrl-C` (SIGINT/SIGTERM) shuts the swap path down.

## Verification (moving ZERO funds)

`node dryrun-live.mjs` builds + signs real swap transactions for SOL→USDC and
USDC→CYB against prod with a **throwaway** keypair and **never submits**. Use it
to confirm the pipeline (quote + swap-instructions + tx assembly) is green
before ever arming.

## Notes
- Paper mode (`TRADE_MODE=paper`) never constructs the live broker — real funds
  can never be touched in paper.
- Live fills are verified on-chain (token balance delta) after confirmation.
- CYB stays ring-fenced at `CYB_MAX_USDC` with its 5% slippage ceiling.
