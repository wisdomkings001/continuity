# Continuity

An autonomous diagnostic trading agent built for the **Bitget AI Base Camp Hackathon S1 — Trading Agent track**.

Paper trading only. No real funds are used at any point.

## The idea

Most trading bots act constantly so they look "active." Continuity does the opposite: it runs a continuous diagnostic on the market and only commits size when its signals genuinely agree with each other. When they don't, it says so and refuses to trade rather than force a guess.

The agent tracks **nine pairs independently**: BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, and LINK (all vs USDT). Each pair gets its own diagnostic every cycle — a strong signal on one coin and a refusal on another, in the same 15-minute sweep, is expected and is the point: conviction is judged per-market, not as one blanket mood for "crypto" as a whole. All nine pairs share a single paper balance, so the agent is effectively running one book across a small portfolio.

Every cycle (every 15 minutes), the agent checks three independent signals on each pair:

- **Trend** — recent price momentum
- **Volatility** — how noisy the last few candles have been
- **Sentiment** — funding rate and long/short positioning ratio (extreme positioning is treated as a contrarian warning, not a confirming one)

It scores how strongly these signals agree on a 0–100 **conviction score** per pair, and that score directly decides what happens to that pair this cycle:

| Conviction | State | Action |
|---|---|---|
| 0–29 | `FAULT` | Refuses to trade this pair. Logs why. |
| 30–69 | `INCONCLUSIVE` | Takes a reduced-size paper position on this pair. |
| 70–100 | `DIAGNOSED` | Takes a full-size paper position on this pair. |

Every single cycle writes one row per pair to the log — including the cycles where it does nothing for that pair. That's intentional: a trading agent's risk discipline shows up as much in what it refuses to do as in what it trades.

## Why this approach

Forcing a trade on contradictory or noisy data is one of the most common ways automated systems lose money. Sizing conviction-proportionally (rather than all-or-nothing) means the agent is always making a quantified decision, not just flipping a switch — and it gives a transparent, auditable number behind every action it logs.

## Project structure

```
continuity/
├── agent/              # the trading agent itself
│   ├── agent.js         # main loop: fetches data, runs diagnostic, logs, serves status API
│   ├── explain.js       # read-only "ask the agent" explainer logic
│   ├── package.json
│   ├── railway.json     # Railway deployment config
│   └── data/            # generated at runtime — trades_log.csv and state.json (not committed)
└── dashboard/
    └── index.html       # single-file live dashboard (no build step, just open it)
```

## Running it yourself

### Requirements
- Node.js 18 or newer (uses the built-in `fetch` API)
- A Bitget account (the agent only uses public market data; an API key is optional and only used for higher rate limits — no trading permission is needed or used)

### Setup

```bash
cd agent
npm install      # no dependencies beyond Node's built-ins, this is just a formality
node agent.js
```

The agent starts immediately: it sweeps all nine pairs on startup (with a short pause between each, so it doesn't hammer the API), then repeats the full sweep every 15 minutes. It also starts a small HTTP server (default port 3000) with three read-only endpoints:

- `GET /status` — shared paper balance, cycle count, and the latest decision for every pair
- `GET /log?n=100` — the last *n* log rows across all pairs as JSON; add `&pair=ETHUSDT` to filter to one pair
- `POST /ask` — body `{"question": "..."}`, returns a plain-language explanation grounded in the agent's real state (used by the dashboard's chat panel) — mention a coin by name (e.g. "why didn't you trade SOL") to get a pair-specific answer, or ask generally for an answer across all nine

### Configuration

All configuration lives at the top of `agent.js` in the `CONFIG` object — the list of trading pairs, check interval, starting paper balance, and the conviction thresholds that define the three states. Add or remove pairs by editing the `PAIRS` array; any symbol Bitget lists as a USDT-margined perpetual will work. No environment variables are required to run it; if you set `BITGET_API_KEY` as an environment variable, it's attached to market data requests for higher rate limits, but the agent works without it.

### Viewing the dashboard

Open `dashboard/index.html` directly in a browser (no server needed — it's a static file). On first load it will ask for the agent's URL (e.g. your Railway deployment URL, or `http://localhost:3000` if running locally). Paste it in once and it's remembered for next time.

## Deploying to Railway (how this was actually run for the hackathon)

1. Push this repo to GitHub.
2. Create a new Railway project from the repo, root directory set to `agent/`.
3. Railway auto-detects `railway.json` and runs `node agent.js`.
4. No environment variables are required. If you want to attach a Bitget API key for higher rate limits, add `BITGET_API_KEY` in Railway's environment variables panel — never commit it to the repo.
5. Once deployed, copy the public Railway URL into the dashboard on first load.

The agent runs continuously on Railway, appending to its log every cycle. The log and state files live in `agent/data/`, which is excluded from git — the live log used for hackathon judging is published separately as `trades_log.csv` (see submission materials).

## What's built vs. what's not

**Built:**
- Full diagnostic engine with three independent signals and conviction scoring, run independently across nine pairs every cycle
- Paper trading execution with realistic taker-fee simulation, sharing one balance across all pairs
- Persistent CSV log with every field the hackathon submission requires (timestamp, pair, direction, price, quantity, balance change)
- Graceful handling of API failures per pair (logged as a `FAULT` row for that pair rather than crashing the whole sweep or going silent)
- Live status/log API and a single-file dashboard: an overview grid of all nine pairs at a glance, drill-down detail per pair with a real-time conviction chart, and a read-only "ask the agent" explainer that understands which coin you're asking about

**Not built / next steps:**
- The agent currently evaluates each cycle independently per pair rather than holding and managing an open position across multiple cycles — a natural next step is to track open paper positions per pair and close them based on a stop-loss/take-profit rule, rather than logging size-per-cycle.
- The nine pairs are currently fixed at startup; a natural extension is letting the agent itself propose adding or dropping a pair based on data quality or liquidity.
- The sentiment signal currently uses funding rate and long/short ratio only — on-chain whale flow or news sentiment would be a natural addition if more data sources were integrated.

## Tools used

- Bitget public market data API (`/api/v2/mix/market/ticker`, `/candles`, `/long-short`) for live price, funding rate, and positioning data, called once per pair per cycle across nine pairs.
- No paid AI model calls are used in the trading logic itself — the diagnostic is fully rule-based and deterministic, which keeps every decision auditable and reproducible by judges.

---

Built by Wisdom — TechCraft & Coding By Wisdom — for Bitget AI Base Camp Hackathon S1.
