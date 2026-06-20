/**
 * explain.js — the "ask Continuity" feature.
 *
 * This is intentionally READ-ONLY. It answers questions about the agent's
 * own state and reasoning (using its real log + last decision data), but
 * it has no mechanism to place, cancel, or alter trades. The autonomy of
 * the trading loop in agent.js is never touched by this endpoint — keeping
 * the agent's decisions genuinely its own, not user-directed.
 *
 * It uses simple rule-based answers grounded in real state data — no
 * external LLM call required, so the explanations are always accurate to
 * what the agent actually did (no hallucinated trades).
 *
 * status shape expected:
 * {
 *   pairs: ['BTCUSDT', 'ETHUSDT', ...],
 *   balance, startingBalance, cyclesRun,
 *   lastDecisionByPair: { BTCUSDT: {...}, ETHUSDT: {...}, ... },
 *   lastDecision: {...}  // most recent across all pairs
 * }
 */

function detectPairMention(question, knownPairs) {
  const q = question.toUpperCase();
  for (const pair of knownPairs) {
    const base = pair.replace('USDT', ''); // e.g. BTC, ETH, SOL
    if (q.includes(base)) return pair;
  }
  return null;
}

function describeDecision(d) {
  if (!d) return "I haven't completed a diagnostic cycle for that pair yet.";
  if (d.state === 'FAULT') {
    return `On ${d.pair}: FAULT, conviction ${d.convictionScore}/100. ${d.reason}`;
  }
  return `On ${d.pair}: ${d.direction.toUpperCase()} at $${Number(d.price).toFixed(2)}, size ${Number(d.quantity).toFixed(6)}. State: ${d.state}, conviction ${d.convictionScore}/100. Balance after: $${Number(d.balanceAfter).toFixed(2)}.`;
}

function buildExplanation(question, status, recentLog) {
  const q = question.toLowerCase();
  const knownPairs = status.pairs || [];
  const mentionedPair = detectPairMention(question, knownPairs);
  const last = mentionedPair ? status.lastDecisionByPair[mentionedPair] : status.lastDecision;

  if (!status.lastDecision && !mentionedPair) {
    return "I haven't completed a diagnostic cycle yet. Check back in a few minutes.";
  }

  if (q.includes('all') && (q.includes('pair') || q.includes('coin') || q.includes('overview') || q.includes('everything'))) {
    const lines = knownPairs.map((p) => {
      const d = status.lastDecisionByPair[p];
      if (!d) return `${p}: no data yet`;
      return `${p}: ${d.state} (${d.convictionScore}/100)${d.state !== 'FAULT' ? ', ' + d.direction.toUpperCase() : ''}`;
    });
    return `Current read across all ${knownPairs.length} pairs — ${lines.join(' | ')}`;
  }

  if (q.includes('why') && (q.includes('sit out') || q.includes('hold') || q.includes('not trad') || q.includes('refuse'))) {
    if (!last) return "I don't have a decision for that pair yet.";
    if (last.state === 'FAULT') {
      return `My last cycle on ${last.pair} came back FAULT. ${last.reason} I don't take a position when conviction is below 30/100 — forcing a trade on contradictory data is how most bots lose money.`;
    }
    if (last.state === 'INCONCLUSIVE') {
      return `I didn't fully sit out on ${last.pair} — I took a reduced position because conviction was ${last.convictionScore}/100, in the partial-agreement range. ${last.reason}`;
    }
    return `Actually, my last cycle on ${last.pair} was DIAGNOSED with conviction ${last.convictionScore}/100, so I did take a full-size position, not sit out.`;
  }

  if (q.includes('which') && (q.includes('coin') || q.includes('pair')) && (q.includes('best') || q.includes('strong') || q.includes('high'))) {
    let best = null;
    knownPairs.forEach((p) => {
      const d = status.lastDecisionByPair[p];
      if (d && (!best || d.convictionScore > best.convictionScore)) best = d;
    });
    if (!best) return "I don't have enough data across pairs yet to compare.";
    return `Right now ${best.pair} has the highest conviction at ${best.convictionScore}/100, state ${best.state}.`;
  }

  if (q.includes('conviction') || q.includes('confiden') || q.includes('score')) {
    if (!last) return "I don't have a conviction score for that pair yet.";
    return `My current conviction score on ${last.pair} is ${last.convictionScore}/100, classified as ${last.state}. ${last.reason}`;
  }

  if (q.includes('last trade') || q.includes('last decision') || q.includes('what did you do')) {
    if (!last) return "I haven't made a decision on that pair yet.";
    return describeDecision(last);
  }

  if (q.includes('balance') || q.includes('p&l') || q.includes('profit') || q.includes('pnl')) {
    const change = status.balance - status.startingBalance;
    const pct = (change / status.startingBalance) * 100;
    return `Current paper balance: $${status.balance.toFixed(2)}, starting from $${status.startingBalance.toFixed(2)}. That's a ${change >= 0 ? 'gain' : 'loss'} of $${Math.abs(change).toFixed(2)} (${pct.toFixed(2)}%) since I started, across ${status.cyclesRun} diagnostic cycles covering ${knownPairs.length} pairs.`;
  }

  if (q.includes('how many') && q.includes('trade')) {
    const relevant = mentionedPair ? recentLog.filter((r) => r.pair === mentionedPair) : recentLog;
    const traded = relevant.filter((r) => r.state !== 'FAULT').length;
    const refused = relevant.filter((r) => r.state === 'FAULT').length;
    const scope = mentionedPair ? `on ${mentionedPair}` : 'across all pairs';
    return `Out of my last ${relevant.length} cycles ${scope}, I acted on ${traded} and refused to trade on ${refused} due to low conviction.`;
  }

  if (q.includes('strategy') || q.includes('how do you') || q.includes('what are you')) {
    return `I run a diagnostic on three signals — price trend, volatility, and positioning sentiment — every cycle, across ${knownPairs.length} pairs (${knownPairs.join(', ')}). When they agree strongly on a pair, I take a full-size paper position on it. When they partially agree, I take a smaller one. When they contradict or noise is too high, I refuse to trade that pair and log why. I never override this with manual input — that's the whole point.`;
  }

  if (q.includes('can i') && (q.includes('tell you') || q.includes('control') || q.includes('force') || q.includes('override'))) {
    return `No — I don't take instructions on what to trade. I only report on my own diagnostic state. That separation is intentional: an agent that can be talked into a trade isn't really autonomous.`;
  }

  // Default fallback — still grounded in real data, not generic
  if (last) {
    return `My last cycle on ${last.pair}: ${last.state} at conviction ${last.convictionScore}/100. ${last.reason} Ask me about a specific coin, my conviction score, last trade, balance, or strategy for more detail.`;
  }
  return `Ask me about a specific coin (e.g. "why didn't you trade ETH"), my conviction scores, last trades, balance, or strategy.`;
}

module.exports = { buildExplanation };
