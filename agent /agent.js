/**
 * CONTINUITY — Autonomous Diagnostic Trading Agent
 * Built for Bitget AI Base Camp Hackathon S1 — Trading Agent Track
 *
 * Core thesis:
 * Most trading bots act constantly to look "active." Continuity instead
 * runs a continuous diagnostic on the market — checking whether trend,
 * volatility, and sentiment signals agree with each other — and sizes
 * every paper trade according to how strongly those signals agree.
 *
 * Three states, every single cycle (it always logs something):
 *   DIAGNOSED      -> signals strongly agree -> full-size paper trade
 *   INCONCLUSIVE   -> signals partially agree -> reduced-size paper trade
 *   FAULT          -> signals contradict / extreme noise -> refuses to trade
 *
 * No real funds are ever used. This is a paper-trading simulation that
 * reads real public market data from Bitget.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---------- Configuration ----------

const CONFIG = {
  PAIRS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT'],
  PRODUCT_TYPE: 'usdt-futures', // Bitget public market data product type (lowercase per API spec)
  CHECK_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
  STARTING_BALANCE: 10000, // fake USDT, paper trading only — shared across all pairs
  LOG_FILE: path.join(__dirname, 'data', 'trades_log.csv'),
  STATE_FILE: path.join(__dirname, 'data', 'state.json'),
  PORT: process.env.PORT || 3000,
  // Position sizing tiers based on conviction score (0-100)
  FAULT_THRESHOLD: 30,      // below this -> refuse to trade
  DIAGNOSED_THRESHOLD: 70,  // above this -> full size
  MAX_POSITION_PCT: 0.25,   // max 25% of balance on a full-conviction trade, per pair per cycle
  PAIR_STAGGER_MS: 2000,    // small delay between pairs in a cycle to be polite to the API
};

// ---------- Data directory setup ----------

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(CONFIG.LOG_FILE)) {
  fs.writeFileSync(
    CONFIG.LOG_FILE,
    'timestamp,pair,state,conviction_score,direction,price,quantity,balance_change,balance_after,reason\n'
  );
}

function loadState() {
  if (fs.existsSync(CONFIG.STATE_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      // Migration: older single-pair state files won't have `pairs` — rebuild it.
      if (!loaded.pairs) {
        loaded.pairs = {};
        CONFIG.PAIRS.forEach((p) => {
          loaded.pairs[p] = { priceHistory: loaded.priceHistory || [], lastDecision: null };
        });
      }
      CONFIG.PAIRS.forEach((p) => {
        if (!loaded.pairs[p]) loaded.pairs[p] = { priceHistory: [], lastDecision: null };
      });
      return loaded;
    } catch (e) {
      console.error('State file corrupted, reinitializing.', e.message);
    }
  }
  const pairs = {};
  CONFIG.PAIRS.forEach((p) => {
    pairs[p] = { priceHistory: [], lastDecision: null };
  });
  return {
    balance: CONFIG.STARTING_BALANCE, // shared paper balance across all pairs
    pairs,
    cyclesRun: 0,
  };
}

function saveState(state) {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ---------- Bitget public market data ----------
// Public market endpoints do not require signed auth, but we attach the
// API key as a header where Bitget allows it for higher rate limits.
// Secret/passphrase are read from environment variables (Railway env vars)
// and are NEVER written to disk or logged.

const BITGET_BASE_URL = 'https://api.bitget.com';

async function fetchTicker(pair) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/ticker?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}`;
  const res = await fetch(url, {
    headers: process.env.BITGET_API_KEY
      ? { 'ACCESS-KEY': process.env.BITGET_API_KEY }
      : {},
  });
  if (!res.ok) throw new Error(`Ticker fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.code !== '00000' || !json.data || !json.data[0]) {
    throw new Error(`Unexpected ticker response: ${JSON.stringify(json)}`);
  }
  return json.data[0];
}

async function fetchCandles(pair, limit = 50) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/candles?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}&granularity=15m&limit=${limit}`;
  const res = await fetch(url, {
    headers: process.env.BITGET_API_KEY
      ? { 'ACCESS-KEY': process.env.BITGET_API_KEY }
      : {},
  });
  if (!res.ok) throw new Error(`Candle fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.code !== '00000' || !Array.isArray(json.data)) {
    throw new Error(`Unexpected candle response: ${JSON.stringify(json)}`);
  }
  // Bitget returns newest-first; each row: [ts, open, high, low, close, baseVol, quoteVol]
  return json.data.map((row) => parseFloat(row[4])).reverse(); // closes, oldest->newest
}

async function fetchLongShortRatio(pair) {
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/long-short?symbol=${pair}&productType=${CONFIG.PRODUCT_TYPE}&period=5m`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    if (json.code === '00000' && Array.isArray(json.data) && json.data[0]) {
      return parseFloat(json.data[0].longShortRatio);
    }
  } catch (e) {
    console.warn(`Long/short ratio unavailable for ${pair}, defaulting to neutral 1.0:`, e.message);
  }
  return 1.0; // neutral fallback — keeps the agent running even if this endpoint changes
}

// ---------- Diagnostic engine ----------
// Three independent "signals" are checked. Each contributes a -100..+100
// directional reading. How strongly they AGREE (not just their average)
// determines the conviction score.

function trendSignal(closes) {
  if (closes.length < 10) return { value: 0, label: 'insufficient data' };
  const recent = closes.slice(-10);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const pctChange = ((last - first) / first) * 100;
  // Normalize: a 2% move over 10 candles (~2.5h) is a strong trend for BTC
  const value = Math.max(-100, Math.min(100, (pctChange / 2) * 100));
  return { value, label: `${pctChange.toFixed(2)}% move over last 10 candles` };
}

function volatilitySignal(closes) {
  if (closes.length < 10) return { value: 0, label: 'insufficient data', raw: 0 };
  const recent = closes.slice(-10);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
  const stdDevPct = (Math.sqrt(variance) / mean) * 100;
  // High volatility doesn't have direction — it REDUCES confidence in trend/sentiment
  // We return it separately as a dampening factor, not a directional vote.
  return { value: stdDevPct, label: `${stdDevPct.toFixed(3)}% stdev` };
}

function sentimentSignal(fundingRate, longShortRatio) {
  // Funding rate: positive = longs paying shorts = market leaning long (can mean overheated)
  // Long/short ratio: >1 = more long positions open
  // We treat EXTREME positioning as a contrarian signal (crowd too one-sided),
  // and MILD positioning in the direction of trend as confirming.
  const fundingPct = fundingRate * 100;
  const extremeFunding = Math.abs(fundingPct) > 0.05; // >0.05% is elevated for perpetuals
  const skew = longShortRatio - 1; // >0 means long-skewed

  let value = skew * 50; // mild positioning, scaled
  let label = `funding ${fundingPct.toFixed(4)}%, L/S ratio ${longShortRatio.toFixed(2)}`;

  if (extremeFunding) {
    // Extreme funding flips this into a contrarian (fade) signal and flags it
    value = -Math.sign(fundingPct) * 60;
    label += ' — extreme funding, treated as contrarian/crowded';
  }
  return { value: Math.max(-100, Math.min(100, value)), label };
}

function runDiagnostic(closes, fundingRate, longShortRatio) {
  const trend = trendSignal(closes);
  const vol = volatilitySignal(closes);
  const sentiment = sentimentSignal(fundingRate, longShortRatio);

  // Agreement check: do trend and sentiment point the same direction?
  const bothNonZero = trend.value !== 0 && sentiment.value !== 0;
  const sameSign = bothNonZero && Math.sign(trend.value) === Math.sign(sentiment.value);
  const magnitude = (Math.abs(trend.value) + Math.abs(sentiment.value)) / 2;
  const agreementBonus = sameSign ? 25 : 0;

  // High volatility dampens conviction — noisy markets are harder to diagnose cleanly
  const volPenalty = Math.min(40, vol.value * 8);

  let convictionScore = Math.max(0, Math.min(100, magnitude + agreementBonus - volPenalty));

  // Direction is whichever directional signal has the larger magnitude
  const direction = Math.abs(trend.value) >= Math.abs(sentiment.value)
    ? (trend.value >= 0 ? 'long' : 'short')
    : (sentiment.value >= 0 ? 'long' : 'short');

  let stateLabel, reason;
  if (convictionScore < CONFIG.FAULT_THRESHOLD) {
    stateLabel = 'FAULT';
    reason = `Signals contradict or noise too high to diagnose cleanly. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Volatility: ${vol.label}. Refusing to trade — protecting capital over forcing a read.`;
  } else if (convictionScore < CONFIG.DIAGNOSED_THRESHOLD) {
    stateLabel = 'INCONCLUSIVE';
    reason = `Partial agreement between signals. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Taking a reduced position sized to uncertainty.`;
  } else {
    stateLabel = 'DIAGNOSED';
    reason = `Trend and sentiment signals agree with low noise. Trend: ${trend.label}. Sentiment: ${sentiment.label}. Taking a full-conviction position.`;
  }

  return {
    state: stateLabel,
    convictionScore: Math.round(convictionScore),
    direction,
    reason,
    detail: { trend, vol, sentiment },
  };
}

// ---------- Paper trading execution ----------

function sizePosition(convictionScore, balance, price) {
  // Linear scaling: 0 conviction (at fault threshold) -> 0 size,
  // 100 conviction -> MAX_POSITION_PCT of balance.
  const pct = (convictionScore / 100) * CONFIG.MAX_POSITION_PCT;
  const usdSize = balance * pct;
  const qty = usdSize / price;
  return { usdSize, qty };
}

function executeCycle(pair, diagnostic, currentPrice) {
  const timestamp = new Date().toISOString();
  let direction = 'none';
  let qty = 0;
  let balanceChange = 0;

  if (diagnostic.state !== 'FAULT') {
    const { usdSize, qty: sizedQty } = sizePosition(diagnostic.convictionScore, state.balance, currentPrice);
    direction = diagnostic.direction;
    qty = sizedQty;

    // Simulate an immediate paper "round trip" cost-free entry for logging
    // purposes — this agent logs intent/sizing per cycle rather than holding
    // open positions across cycles, keeping the log simple and auditable.
    // A small simulated slippage/fee is applied for realism.
    const feeRate = 0.0006; // 0.06%, typical taker fee
    balanceChange = -(usdSize * feeRate);
    state.balance += balanceChange;
  }

  const logRow = [
    timestamp,
    pair,
    diagnostic.state,
    diagnostic.convictionScore,
    direction,
    currentPrice.toFixed(2),
    qty.toFixed(6),
    balanceChange.toFixed(4),
    state.balance.toFixed(4),
    `"${diagnostic.reason.replace(/"/g, "'")}"`,
  ].join(',');

  fs.appendFileSync(CONFIG.LOG_FILE, logRow + '\n');

  state.pairs[pair].lastDecision = {
    timestamp,
    pair,
    state: diagnostic.state,
    convictionScore: diagnostic.convictionScore,
    direction,
    price: currentPrice,
    quantity: qty,
    balanceChange,
    balanceAfter: state.balance,
    reason: diagnostic.reason,
    detail: diagnostic.detail,
  };
  saveState(state);

  console.log(`[${timestamp}] ${pair} | ${diagnostic.state} | conviction ${diagnostic.convictionScore} | ${direction} | balance ${state.balance.toFixed(2)}`);
}

// ---------- Main loop ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnePair(pair) {
  try {
    const ticker = await fetchTicker(pair);
    const currentPrice = parseFloat(ticker.lastPr || ticker.last);
    const fundingRate = parseFloat(ticker.fundingRate || '0');

    const pairState = state.pairs[pair];
    pairState.priceHistory.push(currentPrice);
    if (pairState.priceHistory.length > 200) pairState.priceHistory.shift();

    let closes = pairState.priceHistory;
    if (closes.length < 15) {
      // Bootstrap with real candle history on first runs so we don't wait
      // hours to build up enough data per pair.
      try {
        const candles = await fetchCandles(pair, 50);
        closes = candles;
        pairState.priceHistory = candles;
      } catch (e) {
        console.warn(`Candle bootstrap failed for ${pair}, continuing with live ticks only:`, e.message);
      }
    }

    const longShortRatio = await fetchLongShortRatio(pair);

    const diagnostic = runDiagnostic(closes, fundingRate, longShortRatio);
    executeCycle(pair, diagnostic, currentPrice);
  } catch (err) {
    console.error(`Cycle failed for ${pair}:`, err.message);
    // Log the failure itself as a FAULT row so the log shows the agent
    // handling its own data problems gracefully rather than going silent.
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      CONFIG.LOG_FILE,
      `${timestamp},${pair},FAULT,0,none,0,0,0,${state.balance.toFixed(4)},"Data fetch error: ${err.message.replace(/"/g, "'")}"\n`
    );
  }
}

async function runCycle() {
  for (const pair of CONFIG.PAIRS) {
    await runOnePair(pair);
    await sleep(CONFIG.PAIR_STAGGER_MS);
  }
  state.cyclesRun += 1;
  saveState(state);
}

// ---------- Lightweight status API (for the dashboard) ----------

function readRecentLogRows(n = 50, pairFilter = null) {
  if (!fs.existsSync(CONFIG.LOG_FILE)) return [];
  const lines = fs.readFileSync(CONFIG.LOG_FILE, 'utf8').trim().split('\n');
  let rows = lines.slice(1).map((line) => {
    // naive CSV parse — good enough since only the reason field has commas, and it's quoted
    const match = line.match(/^([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),"(.*)"$/);
    if (!match) return null;
    const [, timestamp, pair, st, conviction, direction, price, qty, balChange, balAfter, reason] = match;
    return {
      timestamp, pair, state: st,
      convictionScore: Number(conviction), direction,
      price: Number(price), quantity: Number(qty),
      balanceChange: Number(balChange), balanceAfter: Number(balAfter),
      reason,
    };
  }).filter(Boolean);

  if (pairFilter) rows = rows.filter((r) => r.pair === pairFilter);
  return rows.slice(-n);
}

function buildStatusPayload() {
  const pairs = {};
  CONFIG.PAIRS.forEach((p) => {
    pairs[p] = state.pairs[p].lastDecision;
  });
  // Convenience: the single most recent decision across all pairs, for
  // quick-glance UI and for the chat explainer's "last trade" answers.
  let mostRecent = null;
  CONFIG.PAIRS.forEach((p) => {
    const d = state.pairs[p].lastDecision;
    if (d && (!mostRecent || new Date(d.timestamp) > new Date(mostRecent.timestamp))) {
      mostRecent = d;
    }
  });
  return {
    pairs: CONFIG.PAIRS,
    balance: state.balance,
    startingBalance: CONFIG.STARTING_BALANCE,
    cyclesRun: state.cyclesRun,
    lastDecisionByPair: pairs,
    lastDecision: mostRecent, // backward-compatible field, most recent across all pairs
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const { buildExplanation } = require('./explain');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (url.pathname === '/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let question = '';
      try {
        question = JSON.parse(body).question || '';
      } catch (e) {
        // ignore malformed body, fall through with empty question
      }
      const statusPayload = buildStatusPayload();
      const recentLog = readRecentLogRows(200);
      const answer = buildExplanation(question, statusPayload, recentLog);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ answer }));
    });
    return;
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(buildStatusPayload()));
  }

  if (url.pathname === '/log') {
    const n = parseInt(url.searchParams.get('n') || '100', 10);
    const pairFilter = url.searchParams.get('pair') || null;
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(readRecentLogRows(n, pairFilter)));
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders() });
    return res.end('ok');
  }

  res.writeHead(404, corsHeaders());
  res.end('Not found. Try /status or /log');
});

server.listen(CONFIG.PORT, () => {
  console.log(`Continuity status API listening on port ${CONFIG.PORT}`);
});

// ---------- Start the loop ----------

console.log('Continuity agent starting.');
console.log(`Pairs: ${CONFIG.PAIRS.join(', ')} | Interval: ${CONFIG.CHECK_INTERVAL_MS / 60000} min | Starting balance: $${CONFIG.STARTING_BALANCE}`);
runCycle();
setInterval(runCycle, CONFIG.CHECK_INTERVAL_MS);
