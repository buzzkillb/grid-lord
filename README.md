# grid-lord

A local Solana trading bot that buys and sells SOL/USDC using a grid plus a
dollar-cost-averaging (DCA) strategy. It runs on your machine, pulls live
on-chain prices, shows what it is doing on a local dashboard, and by default
trades on paper (simulated) money so you can prove the strategy works before
you let it touch real funds.

Live execution is built in and it does work, but it is deliberately locked
behind a few switches. See [Live trading](LIVE.md) before you ever turn it on.

Licensed under the MIT License. See [LICENSE](LICENSE).

## What it does

The bot runs a loop that reads the price and decides whether to place orders.
There are two strategies:

- **Grid.** It lays a ladder of buy and sell orders around the current price,
  denser near the middle and wider toward the edges. When a buy fills it
  re-arms a sell one step up, and vice versa, so it harvests small moves while
  keeping one order per level. The band is sized from recent on-chain price
  history and from volatility, and it re-centers itself as the price drifts.
- **DCA.** It buys on a regular interval, or early if price dips below the
  rolling VWAP. It also runs a trailing take-profit: once price climbs a set
  percentage above the average cost, it tracks the peak and sells a slice when
  price gives back a set percentage from that peak. This keeps the DCA book
  from giving all its gain back.

Because every swap carries a real network and routing fee, the grid levels are
never spaced tighter than what a full round trip needs to clear fees, and the
DCA refuses to fire a buy so small that the fee would eat the whole gain. A
sell is never opened below the average cost of the lots it was bought from.

There are also safety rails: a hard stop on realized losses, a pause on new
buying if the open position gets too far underwater, a cap on total deployed
capital, and a price sanity gate that rejects a single bad quote so a glitch
cannot trigger a fake fill or re-center the grid on a bogus price.

## Requirements

- Node.js 18 or newer
- Local npm and network access to the public Solana RPC and Jupiter API

## How pricing works

The price feed uses Jupiter's public Swap API for SOL/USDC. The same quote that
drives the strategy signals is what execution would use, so the price you see
is the price you would get. CoinGecko is used as a fallback if Jupiter is
unreachable. No API key is needed for the SOL book.

The only key in the whole project is a free BirdEye API key, used only for
on-chain OHLCV data for the meme-coin slot. It is read from an environment
variable and is never committed.

## Setup

```bash
npm install
npm run build        # compiles the TypeScript
npm run paper        # starts the bot in paper mode
```

Then open the dashboard at http://localhost:3000. You should see the live SOL
price and, as the grid fills, orders and trades appear with timestamps.

To check Jupiter is reachable:

```bash
npm run quote
```

## Configuration

Copy `.env.example` to `.env` and adjust. The bot runs in paper mode with no
other setup and no key. Live mode additionally needs a wallet key file (see
[Live trading](LIVE.md)).

Key settings:

| Setting | Default | What it does |
|---|---|---|
| `TRADE_MODE` | `paper` | `paper` (simulated) or `live` (real swaps) |
| `SOLANA_RPC_URL` | mainnet-beta | Solana RPC endpoint |
| `JUPITER_API_URL` | `api.jup.ag/swap/v2` | Jupiter Swap API base |
| `GRID_LEVELS` | `8` | Number of grid levels |
| `GRID_USDC_PER_LEVEL` | `20` | USDC per grid level |
| `GRID_REANCHOR_MIN` | `240` | Min minutes between re-anchors |
| `GRID_REANCHOR_CONFIRM_POLLS` | `3` | Consecutive polls a drift must persist before re-anchoring |
| `GRID_HISTORY_HOURS` | `48` | Hours of history used to size the band |
| `DCA_INTERVAL_MIN` | `120` | Minutes between DCA buys |
| `DCA_USDC_PER_BUY` | `25` | USDC per DCA buy |
| `DCA_TP_PCT` | `1.0` | Take-profit arms once price is this % above avg cost |
| `DCA_TP_SLICE_PCT` | `50` | % of held SOL banked per take-profit sell |
| `DCA_MIN_BUY_USD` | `15` | Never buy below this notional (fee-aware floor) |
| `RISK_MAX_USDC` | `400` | Hard cap on deployed grid + DCA capital |
| `RISK_HARD_STOP_PCT` | `0.25` | Pause if realized PnL drops this % of the cap |
| `RISK_MAX_SINGLE_JUMP_PCT` | `0.05` | Reject a single-poll price move larger than this fraction |
| `PORT` | `3000` | Dashboard port |

The `.env` and `wallet.key` files are git-ignored. Only `.env.example` is
tracked, and it carries no real key. A stale Jupiter URL in a config file is
detected and upgraded automatically, so an old `.env` will not break the bot.

## Live trading

Paper is the default and is the safe way to start. To move real funds, three
things all have to be present: `TRADE_MODE=live`, a real `wallet.key` in the
repo directory, and `LIVE_ARM=1` on the command line when you start it.

Without `LIVE_ARM`, live mode runs in dry-run: it builds and validates the
swaps but never sends them.

```bash
LIVE_ARM=1 npm run paper
```

The full go-live procedure, including how to fund the wallet (USDC for buys,
native SOL for fees) and a description of every runtime safety gate, is in
[LIVE.md](LIVE.md).

## Scripts

- `npm run build` - compile TypeScript to the `dist/` folder
- `npm run paper` - run the bot (paper by default; add `LIVE_ARM=1` for real)
- `npm run quote` - print a live SOL-to-USDC quote from Jupiter
- `npm run check` - typecheck without emitting
- `npm test` - run the unit/integration tests
- `npm run test:live` - run the env-gated on-chain transaction tests

## Repository layout

- `src/` - all source: strategies, engine, broker, price oracle, store, server
- `test/` - unit and integration tests
- `public/` - the dashboard HTML
- `scripts/` - smoke-test helpers
- `.botstate/` - runtime state and event logs (git-ignored)

## Tests

The test suite covers the important invariants: asset conservation, the grid
never deploying past its capital cap, the one-order-per-level rule, the
take-profit sell never closing below the cost basis, the price sanity gate, and
the re-anchor confirmation log. Run it with `npm test`.

```bash
npm install
npm test
```

If you changed any TypeScript, run `npm run build` before `npm run paper` or
before running tests against the compiled output.
