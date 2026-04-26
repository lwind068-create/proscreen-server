// ═══════════════════════════════════════════════════════════════════════
// ProScreen Data Server — Live Prices + Fundamentals
// Combines: Polygon.io (prices/volume) + Financial Modeling Prep (fundamentals)
//
// SETUP:
// 1. Add to your existing alert-server.js OR run this as a separate server
// 2. Add to .env:
//    POLYGON_API_KEY=your_polygon_key
//    FMP_API_KEY=your_fmp_key
// 3. npm install express cors node-fetch nodemailer twilio dotenv
// 4. node data-server.js
//
// FREE TIER LIMITS:
//   Polygon: 5 API calls/min, previous day prices (15-min delay on live)
//   FMP:     250 calls/day, full fundamentals on all stocks
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3001;

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const FMP_KEY     = process.env.FMP_API_KEY;

app.use(cors({ origin: '*' })); // Lock this down to your domain in production
app.use(express.json());

// ── CACHE (reduces API calls, respects free tier limits) ─────────────────────
const cache = new Map();
function getCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.data;
  return null;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, ts: Date.now(), ttl: ttlMs });
}

// ── FETCH HELPERS ─────────────────────────────────────────────────────────────
async function polyFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`);
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${await res.text()}`);
  return res.json();
}
async function fmpFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://financialmodelingprep.com/api/v3${path}${sep}apikey=${FMP_KEY}`);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/screener?tickers=AAPL,MSFT,NVDA
// Returns: merged live price + fundamental data for all tickers
// Cache: 5 minutes for prices, 24 hours for fundamentals
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/screener', async (req, res) => {
  const tickers = (req.query.tickers || '')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);

  if (!tickers.length) return res.json([]);

  try {
    // Fetch prices and fundamentals in parallel for all tickers
    const results = await Promise.allSettled(
      tickers.map(ticker => fetchMergedStock(ticker))
    );

    const stocks = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    res.json(stocks);
  } catch (e) {
    console.error('Screener error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/stock/:ticker
// Returns: full merged data for one stock
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const stock = await fetchMergedStock(ticker);
    if (!stock) return res.status(404).json({ error: 'Stock not found' });
    res.json(stock);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/history/:ticker?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns: daily closing prices for chart
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/history/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const to     = req.query.to   || today();
  const from   = req.query.from || daysAgo(30);
  const cacheKey = `history-${ticker}-${from}-${to}`;

  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await polyFetch(
      `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`
    );
    const prices = (data.results || []).map(r => ({
      date:  new Date(r.t).toISOString().split('T')[0],
      close: Math.round(r.c * 100) / 100,
      open:  Math.round(r.o * 100) / 100,
      high:  Math.round(r.h * 100) / 100,
      low:   Math.round(r.l * 100) / 100,
      vol:   r.v,
    }));
    const result = { ticker, prices };
    setCache(cacheKey, result, 60 * 60 * 1000); // cache 1 hour
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/search?q=apple
// Returns: ticker search results
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const data = await polyFetch(
      `/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&market=stocks&limit=8`
    );
    const results = (data.results || []).map(r => ({
      ticker:   r.ticker,
      name:     r.name,
      exchange: r.primary_exchange,
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/health
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    polygon: POLYGON_KEY ? 'configured' : 'missing',
    fmp:     FMP_KEY     ? 'configured' : 'missing',
    cached:  cache.size,
    uptime:  Math.floor(process.uptime()) + 's',
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CORE: fetchMergedStock — gets price from Polygon + fundamentals from FMP
// and merges them into the shape your screener expects
// ═══════════════════════════════════════════════════════════════════════
async function fetchMergedStock(ticker) {
  const [price, fundamentals] = await Promise.allSettled([
    fetchPrice(ticker),
    fetchFundamentals(ticker),
  ]);

  const p = price.status === 'fulfilled' ? price.value : null;
  const f = fundamentals.status === 'fulfilled' ? fundamentals.value : {};

  if (!p) return null; // skip if no price data

  return {
    ticker,
    name:        f.name        || ticker,
    sector:      normalizeSector(f.sector || ''),
    mcapVal:     f.mcapVal     || (p.price * (f.sharesOut || 1e9)) / 1e9,
    price:       p.price,
    change:      p.change,
    volumeM:     p.volumeM,
    open:        p.open,
    high:        p.high,
    low:         p.low,
    // Fundamentals (FMP)
    pe:          f.pe          ?? -1,
    divYield:    f.divYield    ?? 0,
    eps:         f.eps         ?? 0,
    roe:         f.roe         ?? 0,
    debtEq:      f.debtEq      ?? 0,
    revGrowth:   f.revGrowth   ?? 0,
    beta:        f.beta        ?? 1,
    week52High:  f.week52High  || p.price * 1.1,
    week52Low:   f.week52Low   || p.price * 0.9,
    momentum:    calcMomentum(p.change, f.revGrowth, f.roe),
  };
}

// ── Fetch price from Polygon ──────────────────────────────────────────────────
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

  setCache(cacheKey, result, 5 * 60 * 1000); // 5 min cache for prices
  return result;
}

// ── Fetch fundamentals from FMP ───────────────────────────────────────────────
async function fetchFundamentals(ticker) {
  const cacheKey = `fundamentals-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // FMP profile endpoint — gives us everything in one call
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
    sharesOut:  r.sharesOutstanding || null,
    // ROE and revenue growth need an extra call to financials endpoint
    roe:        0,
    debtEq:     0,
    revGrowth:  0,
  };

  // Optional: get ROE + debt/equity from key metrics (uses 1 more API call)
  try {
    const metrics = await fmpFetch(`/key-metrics-ttm/${ticker}`);
    const m = metrics[0];
    if (m) {
      result.roe     = m.roeTTM     ? Math.round(m.roeTTM * 1000) / 10     : 0;
      result.debtEq  = m.debtToEquityTTM ? Math.round(m.debtToEquityTTM * 100) / 100 : 0;
    }
  } catch (e) {
    console.log(`Key metrics unavailable for ${ticker}`);
  }

  // Optional: revenue growth from income statement
  try {
    const income = await fmpFetch(`/income-statement/${ticker}?limit=2`);
    if (income.length >= 2) {
      const curr = income[0].revenue, prev = income[1].revenue;
      if (prev && prev !== 0) {
        result.revGrowth = Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
      }
    }
  } catch (e) {
    console.log(`Income statement unavailable for ${ticker}`);
  }

  setCache(cacheKey, result, 24 * 60 * 60 * 1000); // 24 hour cache for fundamentals
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

// Normalize FMP sector names to match your screener's sector filter labels
function normalizeSector(sector) {
  const map = {
    'Technology':                   'Technology',
    'Consumer Cyclical':            'Consumer',
    'Consumer Defensive':           'Consumer',
    'Healthcare':                   'Healthcare',
    'Financial Services':           'Financials',
    'Financials':                   'Financials',
    'Energy':                       'Energy',
    'Industrials':                  'Industrials',
    'Utilities':                    'Utilities',
    'Basic Materials':              'Industrials',
    'Communication Services':       'Technology',
    'Real Estate':                  'Financials',
  };
  return map[sector] || sector || 'Other';
}

// Derive a 0–1 momentum score from available data
// (replace with actual 12-month price return when you have it)
function calcMomentum(changeToday, revGrowth, roe) {
  let score = 0.5;
  if (changeToday >  2) score += 0.1;
  if (changeToday < -2) score -= 0.1;
  if (revGrowth   > 20) score += 0.15;
  if (revGrowth   < -5) score -= 0.15;
  if (roe         > 25) score += 0.1;
  if (roe         < 0)  score -= 0.1;
  return Math.min(0.95, Math.max(0.05, Math.round(score * 100) / 100));
}

function today() {
  return new Date().toISOString().split('T')[0];
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

app.listen(PORT, () => {
  console.log(`\n🚀 ProScreen Data Server running on port ${PORT}`);
  console.log(`📊 Polygon API: ${POLYGON_KEY ? '✅' : '❌ missing POLYGON_API_KEY'}`);
  console.log(`📈 FMP API:     ${FMP_KEY     ? '✅' : '❌ missing FMP_API_KEY'}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET /api/screener?tickers=AAPL,MSFT,NVDA`);
  console.log(`  GET /api/stock/:ticker`);
  console.log(`  GET /api/history/:ticker?from=YYYY-MM-DD&to=YYYY-MM-DD`);
  console.log(`  GET /api/search?q=apple`);
  console.log(`  GET /api/health\n`);
});
