require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3001;

const POLYGON_KEY    = process.env.POLYGON_API_KEY;
const FMP_KEY        = process.env.FMP_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── CACHE ─────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.data;
  return null;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, ts: Date.now(), ttl: ttlMs });
}

// ── FETCH HELPERS ──────────────────────────────────────────────
async function polyFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`);
  if (!res.ok) throw new Error(`Polygon ${res.status}`);
  return res.json();
}
async function fmpFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://financialmodelingprep.com/api/v3${path}${sep}apikey=${FMP_KEY}`);
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  return res.json();
}

// ── ROUTES ─────────────────────────────────────────────────────

// GET /api/screener?tickers=AAPL,MSFT
app.get('/api/screener', async (req, res) => {
  const tickers = (req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 50);
  if (!tickers.length) return res.json([]);
  try {
    const results = await Promise.allSettled(tickers.map(t => fetchMergedStock(t)));
    const stocks = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    res.json(stocks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stock/:ticker
app.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const stock = await fetchMergedStock(ticker);
    if (!stock) return res.status(404).json({ error: 'Not found' });
    res.json(stock);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/history/:ticker
app.get('/api/history/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const to   = req.query.to   || today();
  const from = req.query.from || daysAgo(30);
  const cacheKey = `history-${ticker}-${from}-${to}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await polyFetch(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`);
    const prices = (data.results || []).map(r => ({
      date:  new Date(r.t).toISOString().split('T')[0],
      close: Math.round(r.c * 100) / 100,
    }));
    const result = { ticker, prices };
    setCache(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/search?q=apple
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const data = await polyFetch(`/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&market=stocks&limit=8`);
    res.json((data.results || []).map(r => ({ ticker: r.ticker, name: r.name, exchange: r.primary_exchange })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI ANALYSIS ROUTE (keeps Anthropic key safe on server) ─────
// POST /api/analyze
// Body: { ticker, name, sector, price, pe, eps, roe, divYield, beta,
//         revGrowth, debtEq, week52High, week52Low, volumeM,
//         momentum, timeframe, predBase, predBull, predBear,
//         predConf, sentiment }
app.post('/api/analyze', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const s = req.body;
  if (!s.ticker) return res.status(400).json({ error: 'ticker required' });

  const cacheKey = `ai-${s.ticker}-${s.timeframe}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const prompt = `You are an institutional equity analyst. Analyze ${s.ticker} (${s.name}).

Data: Sector: ${s.sector} | Price: $${s.price} | P/E: ${s.pe < 0 ? 'negative (loss-making)' : s.pe} | EPS: $${s.eps} | ROE: ${s.roe}% | Rev growth: ${s.revGrowth}% | Debt/Eq: ${s.debtEq}x | Div yield: ${s.divYield}% | Beta: ${s.beta} | 52W: $${s.week52Low}–$${s.week52High} | Volume: ${s.volumeM}M | Momentum: ${Math.round(s.momentum * 100)}/100
Model target (${s.timeframe}): $${s.predBase} (${(((s.predBase - s.price) / s.price) * 100).toFixed(1)}%) | Bull: $${s.predBull} | Bear: $${s.predBear} | Confidence: ${s.predConf}% | Sentiment: ${s.sentiment}

Respond ONLY with valid JSON, no markdown, no extra text:
{"paragraphs":["Business model and current market positioning (2-3 sentences)","Key strengths and risks from the specific metrics (2-3 sentences)","Outlook for the ${s.timeframe} timeframe with specific price drivers (2-3 sentences)"],"scores":{"value":<0-100>,"growth":<0-100>,"risk":<0-100, higher means more risky>,"income":<0-100>,"momentum":<0-100>},"verdict":"One bold definitive verdict sentence."}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic error');

    let text = (data.content || []).map(b => b.text || '').join('').trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    setCache(cacheKey, parsed, 60 * 60 * 1000); // cache 1 hour
    res.json(parsed);
  } catch (e) {
    console.error('AI analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── NEWS ROUTE ─────────────────────────────────────────────────
// GET /api/news/:ticker
// Returns: real news articles with sentiment for a stock
const NEWS_KEY = process.env.NEWS_API_KEY;

app.get('/api/news/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `news-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  if (!NEWS_KEY) return res.status(500).json({ error: 'NEWS_API_KEY not configured' });

  try {
    // Search for news about the ticker/company
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI error');

    const articles = (data.articles || []).slice(0, 4).map(a => {
      // Simple sentiment detection based on keywords in title/description
      const text = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
      const positiveWords = ['surge', 'soar', 'gain', 'rise', 'beat', 'record', 'growth', 'profit', 'up', 'high', 'strong', 'buy', 'upgrade', 'bullish', 'positive', 'boost', 'rally', 'jump'];
      const negativeWords = ['fall', 'drop', 'decline', 'miss', 'lose', 'low', 'weak', 'sell', 'downgrade', 'bearish', 'negative', 'crash', 'plunge', 'concern', 'risk', 'cut', 'warn', 'probe', 'fine', 'lawsuit'];
      const posScore = positiveWords.filter(w => text.includes(w)).length;
      const negScore = negativeWords.filter(w => text.includes(w)).length;
      const sentiment = posScore > negScore ? 'positive' : negScore > posScore ? 'negative' : 'neutral';

      // Format time ago
      const published = new Date(a.publishedAt);
      const now = new Date();
      const diffMs = now - published;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      let timeAgo;
      if (diffMins < 60) timeAgo = `${diffMins}m ago`;
      else if (diffHours < 24) timeAgo = `${diffHours}h ago`;
      else timeAgo = `${diffDays}d ago`;

      return {
        headline: a.title || '',
        summary:  a.description || '',
        source:   a.source?.name || 'Unknown',
        url:      a.url || '#',
        time:     timeAgo,
        sentiment,
      };
    });

    const result = { ticker, articles };
    setCache(cacheKey, result, 15 * 60 * 1000); // cache 15 minutes
    res.json(result);
  } catch (e) {
    console.error(`News error for ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    polygon:   POLYGON_KEY   ? 'configured' : 'missing',
    fmp:       FMP_KEY       ? 'configured' : 'missing',
    anthropic: ANTHROPIC_KEY ? 'configured' : 'missing',
    news:      NEWS_KEY      ? 'configured' : 'missing',
    cached:    cache.size,
    uptime:    Math.floor(process.uptime()) + 's',
  });
});

// ── STOCK DATA HELPERS ─────────────────────────────────────────
async function fetchMergedStock(ticker) {
  const [price, fundamentals] = await Promise.allSettled([fetchPrice(ticker), fetchFundamentals(ticker)]);
  const p = price.status === 'fulfilled' ? price.value : null;
  const f = fundamentals.status === 'fulfilled' ? fundamentals.value : {};
  if (!p) return null;
  return {
    ticker,
    name:       f.name       || ticker,
    sector:     normalizeSector(f.sector || ''),
    mcapVal:    f.mcapVal    || 0,
    price:      p.price,
    change:     p.change,
    volumeM:    p.volumeM,
    open:       p.open,
    high:       p.high,
    low:        p.low,
    pe:         f.pe         ?? -1,
    divYield:   f.divYield   ?? 0,
    eps:        f.eps        ?? 0,
    roe:        f.roe        ?? 0,
    debtEq:     f.debtEq     ?? 0,
    revGrowth:  f.revGrowth  ?? 0,
    beta:       f.beta       ?? 1,
    week52High: f.week52High || p.price * 1.1,
    week52Low:  f.week52Low  || p.price * 0.9,
    momentum:   calcMomentum(p.change, f.revGrowth, f.roe),
  };
}

async function fetchPrice(ticker) {
  const cacheKey = `price-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const data = await polyFetch(`/v2/aggs/ticker/${ticker}/prev?adjusted=true`);
  const r = data.results?.[0];
  if (!r) return null;
  const result = {
    price:   Math.round(r.c * 100) / 100,
    change:  Math.round(((r.c - r.o) / r.o) * 10000) / 100,
    volumeM: Math.round(r.v / 1e5) / 10,
    open:    Math.round(r.o * 100) / 100,
    high:    Math.round(r.h * 100) / 100,
    low:     Math.round(r.l * 100) / 100,
  };
  setCache(cacheKey, result, 5 * 60 * 1000);
  return result;
}

async function fetchFundamentals(ticker) {
  const cacheKey = `fundamentals-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const data = await fmpFetch(`/profile/${ticker}`);
  const r = data[0];
  if (!r) return {};
  const result = {
    name:       r.companyName,
    sector:     r.sector || '',
    mcapVal:    r.mktCap ? Math.round(r.mktCap / 1e9) : null,
    pe:         r.pe     ? Math.round(r.pe * 10) / 10 : -1,
    eps:        r.eps    ? Math.round(r.eps * 100) / 100 : 0,
    divYield:   r.lastDiv ? Math.round((r.lastDiv / r.price) * 4 * 1000) / 10 : 0,
    beta:       r.beta   ? Math.round(r.beta * 100) / 100 : 1,
    week52High: r['52WeekHigh'] || null,
    week52Low:  r['52WeekLow']  || null,
    roe: 0, debtEq: 0, revGrowth: 0,
  };
  try {
    const metrics = await fmpFetch(`/key-metrics-ttm/${ticker}`);
    const m = metrics[0];
    if (m) {
      result.roe    = m.roeTTM            ? Math.round(m.roeTTM * 1000) / 10            : 0;
      result.debtEq = m.debtToEquityTTM   ? Math.round(m.debtToEquityTTM * 100) / 100   : 0;
    }
  } catch (e) {}
  try {
    const income = await fmpFetch(`/income-statement/${ticker}?limit=2`);
    if (income.length >= 2) {
      const curr = income[0].revenue, prev = income[1].revenue;
      if (prev && prev !== 0) result.revGrowth = Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
    }
  } catch (e) {}
  setCache(cacheKey, result, 24 * 60 * 60 * 1000);
  return result;
}

function normalizeSector(sector) {
  const map = {
    'Technology': 'Technology', 'Consumer Cyclical': 'Consumer', 'Consumer Defensive': 'Consumer',
    'Healthcare': 'Healthcare', 'Financial Services': 'Financials', 'Financials': 'Financials',
    'Energy': 'Energy', 'Industrials': 'Industrials', 'Utilities': 'Utilities',
    'Basic Materials': 'Industrials', 'Communication Services': 'Technology', 'Real Estate': 'Financials',
  };
  return map[sector] || sector || 'Other';
}
function calcMomentum(changeToday, revGrowth, roe) {
  let score = 0.5;
  if (changeToday > 2)  score += 0.1;
  if (changeToday < -2) score -= 0.1;
  if (revGrowth > 20)   score += 0.15;
  if (revGrowth < -5)   score -= 0.15;
  if (roe > 25)         score += 0.1;
  if (roe < 0)          score -= 0.1;
  return Math.min(0.95, Math.max(0.05, Math.round(score * 100) / 100));
}
function today() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }

app.listen(PORT, () => {
  console.log(`\n🚀 ProScreen Server running on port ${PORT}`);
  console.log(`📊 Polygon:   ${POLYGON_KEY   ? '✅' : '❌ missing'}`);
  console.log(`📈 FMP:       ${FMP_KEY       ? '✅' : '❌ missing'}`);
  console.log(`🤖 Anthropic: ${ANTHROPIC_KEY ? '✅' : '❌ missing'}`);
});
