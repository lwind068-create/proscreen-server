require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3001;

const POLYGON_KEY    = process.env.POLYGON_API_KEY;
const FMP_KEY        = process.env.FMP_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const NEWS_KEY       = process.env.NEWS_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json());

const cache = new Map();
function getCache(key) { const hit = cache.get(key); if (hit && Date.now() - hit.ts < hit.ttl) return hit.data; return null; }
function setCache(key, data, ttlMs) { cache.set(key, { data, ts: Date.now(), ttl: ttlMs }); }
function today() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }
async function polyFetch(path) { const sep = path.includes('?') ? '&' : '?'; const res = await fetch(`https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`); if (!res.ok) throw new Error(`Polygon ${res.status}`); return res.json(); }

app.get('/api/health', (req, res) => { res.json({ status: 'ok', polygon: POLYGON_KEY ? 'configured' : 'missing', fmp: FMP_KEY ? 'configured' : 'missing', anthropic: ANTHROPIC_KEY ? 'configured' : 'missing', news: NEWS_KEY ? 'configured' : 'missing', cached: cache.size, uptime: Math.floor(process.uptime()) + 's' }); });

app.get('/api/screener', async (req, res) => { const tickers = (req.query.tickers || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 50); if (!tickers.length) return res.json([]); try { const results = await Promise.allSettled(tickers.map(t => fetchMergedStock(t))); res.json(results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/stock/:ticker', async (req, res) => { const ticker = req.params.ticker.toUpperCase(); try { const stock = await fetchMergedStock(ticker); if (!stock) return res.status(404).json({ error: 'Not found' }); res.json(stock); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/history/:ticker', async (req, res) => { const ticker = req.params.ticker.toUpperCase(); const to = req.query.to || today(); const from = req.query.from || daysAgo(30); const cacheKey = `history-${ticker}-${from}-${to}`; const cached = getCache(cacheKey); if (cached) return res.json(cached); try { const data = await polyFetch(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`); const prices = (data.results || []).map(r => ({ date: new Date(r.t).toISOString().split('T')[0], close: Math.round(r.c * 100) / 100 })); const result = { ticker, prices }; setCache(cacheKey, result, 60 * 60 * 1000); res.json(result); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/search', async (req, res) => { const q = (req.query.q || '').trim(); if (!q) return res.json([]); try { const data = await polyFetch(`/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&market=stocks&limit=8`); res.json((data.results || []).map(r => ({ ticker: r.ticker, name: r.name, exchange: r.primary_exchange }))); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/news/:ticker', async (req, res) => { const ticker = req.params.ticker.toUpperCase(); const cacheKey = `news-${ticker}`; const cached = getCache(cacheKey); if (cached) return res.json(cached); if (!NEWS_KEY) return res.status(500).json({ error: 'NEWS_API_KEY not configured' }); try { const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_KEY}`; const response = await fetch(url); const data = await response.json(); if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI error'); const pos = ['surge','soar','gain','rise','beat','record','growth','profit','strong','buy','upgrade','bullish','boost','rally','jump']; const neg = ['fall','drop','decline','miss','lose','weak','sell','downgrade','bearish','crash','plunge','concern','risk','cut','warn','probe','fine','lawsuit']; const articles = (data.articles || []).slice(0, 4).map(a => { const text = ((a.title || '') + ' ' + (a.description || '')).toLowerCase(); const ps = pos.filter(w => text.includes(w)).length; const ns = neg.filter(w => text.includes(w)).length; const sentiment = ps > ns ? 'positive' : ns > ps ? 'negative' : 'neutral'; const published = new Date(a.publishedAt); const diffMs = Date.now() - published; const diffMins = Math.floor(diffMs / 60000); const diffHours = Math.floor(diffMins / 60); const diffDays = Math.floor(diffHours / 24); const timeAgo = diffMins < 60 ? `${diffMins}m ago` : diffHours < 24 ? `${diffHours}h ago` : `${diffDays}d ago`; return { headline: a.title || '', summary: a.description || '', source: a.source && a.source.name ? a.source.name : 'Unknown', url: a.url || '#', time: timeAgo, sentiment }; }); const result = { ticker, articles }; setCache(cacheKey, result, 15 * 60 * 1000); res.json(result); } catch (e) { console.error(`News error for ${ticker}:`, e.message); res.status(500).json({ error: e.message }); } });

app.post('/api/analyze', async (req, res) => { if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); const s = req.body; if (!s.ticker) return res.status(400).json({ error: 'ticker required' }); const cacheKey = `ai-${s.ticker}-${s.timeframe}`; const cached = getCache(cacheKey); if (cached) return res.json(cached); const prompt = `You are an institutional equity analyst. Analyze ${s.ticker} (${s.name}).\nData: Sector: ${s.sector} | Price: $${s.price} | P/E: ${s.pe < 0 ? 'negative' : s.pe} | EPS: $${s.eps} | ROE: ${s.roe}% | Rev growth: ${s.revGrowth}% | Debt/Eq: ${s.debtEq}x | Div: ${s.divYield}% | Beta: ${s.beta} | 52W: $${s.week52Low}–$${s.week52High} | Vol: ${s.volumeM}M | Momentum: ${Math.round(s.momentum * 100)}/100\nTarget (${s.timeframe}): $${s.predBase} (${(((s.predBase - s.price) / s.price) * 100).toFixed(1)}%) | Bull: $${s.predBull} | Bear: $${s.predBear} | Confidence: ${s.predConf}% | Sentiment: ${s.sentiment}\nRespond ONLY with valid JSON no markdown:\n{"paragraphs":["Business model and positioning (2-3 sentences)","Key strengths and risks from metrics (2-3 sentences)","Outlook for ${s.timeframe} (2-3 sentences)"],"scores":{"value":<0-100>,"growth":<0-100>,"risk":<0-100>,"income":<0-100>,"momentum":<0-100>},"verdict":"One bold verdict sentence."}`; try { const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Anthropic error'); let text = (data.content || []).map(b => b.text || '').join('').trim().replace(/```json|```/g, '').trim(); const parsed = JSON.parse(text); setCache(cacheKey, parsed, 60 * 60 * 1000); res.json(parsed); } catch (e) { console.error('AI analysis error:', e.message); res.status(500).json({ error: e.message }); } });

// GET /api/earnings/:ticker — next earnings date from FMP
app.get('/api/earnings/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `earnings-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const res2 = await fetch(`https://financialmodelingprep.com/stable/earnings-surprises?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`);
    const data = await res2.json();
    const arr = Array.isArray(data) ? data : [];
    // Also get upcoming earnings
    const today2 = today();
    const future = new Date(); future.setDate(future.getDate() + 90);
    const res3 = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${today2}&to=${future.toISOString().split('T')[0]}&apikey=${FMP_KEY}`);
    const cal = await res3.json();
    const upcoming = Array.isArray(cal) ? cal.filter(e => e.symbol === ticker) : [];
    const result = {
      ticker,
      upcoming: upcoming.slice(0,3).map(e => ({ date: e.date, eps_est: e.epsEstimated, rev_est: e.revenueEstimated })),
      history: arr.slice(0,4).map(e => ({ date: e.date, actual: e.actualEarningResult, estimate: e.estimatedEarning, surprise: e.surprisePercent }))
    };
    setCache(cacheKey, result, 6 * 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    console.error(`Earnings error for ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/targets/:ticker — analyst price targets from FMP
app.get('/api/targets/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `targets-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const res2 = await fetch(`https://financialmodelingprep.com/stable/price-target-summary?symbol=${ticker}&apikey=${FMP_KEY}`);
    const data = await res2.json();
    const r = Array.isArray(data) ? data[0] : data;
    const result = {
      ticker,
      consensus:  r && r.targetConsensus  ? Math.round(r.targetConsensus * 100) / 100  : null,
      high:       r && r.targetHigh       ? Math.round(r.targetHigh * 100) / 100        : null,
      low:        r && r.targetLow        ? Math.round(r.targetLow * 100) / 100         : null,
      median:     r && r.targetMedian     ? Math.round(r.targetMedian * 100) / 100      : null,
      analysts:   r && r.lastMonthCount   ? r.lastMonthCount                            : null,
    };
    setCache(cacheKey, result, 6 * 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    console.error(`Targets error for ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sector-performance — sector heatmap data from FMP
app.get('/api/sector-performance', async (req, res) => {
  const cacheKey = 'sector-perf';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const res2 = await fetch(`https://financialmodelingprep.com/stable/sector-performance?apikey=${FMP_KEY}`);
    const data = await res2.json();
    const arr = Array.isArray(data) ? data : [];
    setCache(cacheKey, arr, 30 * 60 * 1000);
    res.json(arr);
  } catch (e) {
    console.error('Sector performance error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function fetchMergedStock(ticker) { const [pr, fr] = await Promise.allSettled([fetchPrice(ticker), fetchFundamentals(ticker)]); const p = pr.status === 'fulfilled' ? pr.value : null; const f = fr.status === 'fulfilled' ? fr.value : {}; if (!p) return null; return { ticker, name: f.name || ticker, sector: normalizeSector(f.sector || ''), mcapVal: f.mcapVal || 0, price: p.price, change: p.change, volumeM: p.volumeM, open: p.open, high: p.high, low: p.low, pe: f.pe != null ? f.pe : -1, divYield: f.divYield || 0, eps: f.eps || 0, profitMargin: f.profitMargin || 0, roe: f.roe || 0, debtEq: f.debtEq || 0, revGrowth: f.revGrowth || 0, beta: f.beta || 1, week52High: f.week52High || p.price * 1.1, week52Low: f.week52Low || p.price * 0.9, momentum: calcMomentum(p.change, f.revGrowth || 0, f.profitMargin || 0) }; }

async function fetchPrice(ticker) { const cacheKey = `price-${ticker}`; const cached = getCache(cacheKey); if (cached) return cached; const data = await polyFetch(`/v2/aggs/ticker/${ticker}/prev?adjusted=true`); const r = data.results && data.results[0]; if (!r) return null; const result = { price: Math.round(r.c * 100) / 100, change: Math.round(((r.c - r.o) / r.o) * 10000) / 100, volumeM: Math.round(r.v / 1e5) / 10, open: Math.round(r.o * 100) / 100, high: Math.round(r.h * 100) / 100, low: Math.round(r.l * 100) / 100 }; setCache(cacheKey, result, 5 * 60 * 1000); return result; }

async function fetchFundamentals(ticker) {
  const cacheKey = `fundamentals-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const result = { roe: 0, debtEq: 0, revGrowth: 0 };
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${FMP_KEY}`);
    const data = await res.json();
    const r = Array.isArray(data) ? data[0] : data;
    if (r && r.companyName) {
      let week52High = null, week52Low = null;
      if (r.range && typeof r.range === 'string') {
        const parts = r.range.split('-');
        if (parts.length >= 2) { week52Low = parseFloat(parts[0]); week52High = parseFloat(parts[parts.length - 1]); }
      }
      result.name = r.companyName;
      result.sector = r.sector || r.industry || '';
      result.mcapVal = r.marketCap ? Math.round(r.marketCap / 1e9) : 0;
      result.pe = r.pe ? Math.round(r.pe * 10) / 10 : -1;
      result.eps = r.eps ? Math.round(r.eps * 100) / 100 : 0;
      result.beta = r.beta ? Math.round(r.beta * 100) / 100 : 1;
      result.week52High = week52High;
      result.week52Low = week52Low;
      result.divYield = r.lastDividend && r.price ? Math.round((r.lastDividend * 4 / r.price) * 100 * 10) / 10 : 0;
    }
  } catch (e) { console.log(`Profile failed for ${ticker}: ${e.message}`); }
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${ticker}&apikey=${FMP_KEY}`);
    const data = await res.json();
    const m = Array.isArray(data) ? data[0] : data;
    if (m) {
      const de = m.debtToEquityTTM ?? m.debtEquityRatioTTM ?? m.debtToEquity ?? null;
      if (de != null) result.debtEq = Math.round(de * 100) / 100;
    }
  } catch (e) { console.log(`Key metrics failed for ${ticker}: ${e.message}`); }
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/ratios-ttm?symbol=${ticker}&apikey=${FMP_KEY}`);
    const data = await res.json();
    const r = Array.isArray(data) ? data[0] : data;
    if (r) {
      if (r.priceToEarningsRatioTTM && r.priceToEarningsRatioTTM > 0) result.pe = Math.round(r.priceToEarningsRatioTTM * 10) / 10;
      if (r.netIncomePerShareTTM) result.eps = Math.round(r.netIncomePerShareTTM * 100) / 100;
      if (r.debtToEquityRatioTTM) result.debtEq = Math.round(r.debtToEquityRatioTTM * 100) / 100;
      if (r.dividendYieldTTM) result.divYield = Math.round(r.dividendYieldTTM * 10000) / 100;
      if (r.netProfitMarginTTM) result.profitMargin = Math.round(r.netProfitMarginTTM * 1000) / 10;
      // ROE = Net Income Per Share / Shareholders Equity Per Share * 100
      // FMP doesn't have a direct ROE field — calculate it from available data
      if (r.netIncomePerShareTTM && r.shareholdersEquityPerShareTTM && r.shareholdersEquityPerShareTTM !== 0) {
        result.roe = Math.round((r.netIncomePerShareTTM / r.shareholdersEquityPerShareTTM) * 1000) / 10;
      }
    }
  } catch (e) { console.log(`Ratios failed for ${ticker}: ${e.message}`); }
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/income-statement?symbol=${ticker}&limit=2&apikey=${FMP_KEY}`);
    const income = await res.json();
    const arr = Array.isArray(income) ? income : [];
    if (arr.length >= 2 && arr[1].revenue) { const curr = arr[0].revenue, prev = arr[1].revenue; result.revGrowth = Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10; }
  } catch (e) { console.log(`Income failed for ${ticker}: ${e.message}`); }
  setCache(cacheKey, result, 24 * 60 * 60 * 1000);
  return result;
}

function normalizeSector(sector) { const map = { 'Technology': 'Technology', 'Consumer Cyclical': 'Consumer', 'Consumer Defensive': 'Consumer', 'Consumer Electronics': 'Technology', 'Healthcare': 'Healthcare', 'Financial Services': 'Financials', 'Financials': 'Financials', 'Energy': 'Energy', 'Industrials': 'Industrials', 'Utilities': 'Utilities', 'Basic Materials': 'Industrials', 'Communication Services': 'Technology', 'Real Estate': 'Financials' }; return map[sector] || sector || 'Other'; }
function calcMomentum(c, r, roe) { let s = 0.5; if (c > 2) s += 0.1; if (c < -2) s -= 0.1; if (r > 20) s += 0.15; if (r < -5) s -= 0.15; if (roe > 25) s += 0.1; if (roe < 0) s -= 0.1; return Math.min(0.95, Math.max(0.05, Math.round(s * 100) / 100)); }

app.listen(PORT, () => { console.log(`\n🚀 ProScreen Server on port ${PORT}`); console.log(`📊 Polygon: ${POLYGON_KEY ? '✅' : '❌'}`); console.log(`📈 FMP: ${FMP_KEY ? '✅' : '❌'}`); console.log(`🤖 Anthropic: ${ANTHROPIC_KEY ? '✅' : '❌'}`); console.log(`📰 News: ${NEWS_KEY ? '✅' : '❌'}`); });

// ── EARNINGS CALENDAR ──────────────────────────────────────────
// GET /api/earnings/:ticker
app.get('/api/earnings/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `earnings-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const res2 = await fetch(`https://financialmodelingprep.com/stable/earnings-surprises?symbol=${ticker}&limit=4&apikey=${FMP_KEY}`);
    const data = await res2.json();
    const arr = Array.isArray(data) ? data : [];
    // Also get upcoming earnings estimate
    const res3 = await fetch(`https://financialmodelingprep.com/stable/earning_calendar?symbol=${ticker}&apikey=${FMP_KEY}`);
    const upcoming = await res3.json();
    const upArr = Array.isArray(upcoming) ? upcoming : [];
    const result = {
      ticker,
      upcoming: upArr.slice(0,3).map(e => ({
        date: e.date,
        epsEstimate: e.epsEstimated || null,
        revenueEstimate: e.revenueEstimated || null,
        fiscal: e.fiscalDateEnding || null,
      })),
      history: arr.slice(0,4).map(e => ({
        date: e.date,
        epsActual: e.actualEarningResult || null,
        epsEstimate: e.estimatedEarning || null,
        surprise: e.actualEarningResult && e.estimatedEarning
          ? Math.round(((e.actualEarningResult - e.estimatedEarning) / Math.abs(e.estimatedEarning)) * 1000) / 10
          : null,
      })),
    };
    setCache(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch(e) {
    console.error(`Earnings error for ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ANALYST PRICE TARGETS ──────────────────────────────────────
// GET /api/targets/:ticker
app.get('/api/targets/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `targets-${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const res2 = await fetch(`https://financialmodelingprep.com/stable/price-target-consensus?symbol=${ticker}&apikey=${FMP_KEY}`);
    const data = await res2.json();
    const r = Array.isArray(data) ? data[0] : data;
    const res3 = await fetch(`https://financialmodelingprep.com/stable/price-target?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`);
    const recent = await res3.json();
    const recentArr = Array.isArray(recent) ? recent : [];
    const result = {
      ticker,
      consensus: {
        targetHigh:    r && r.targetHigh    ? Math.round(r.targetHigh * 100) / 100    : null,
        targetLow:     r && r.targetLow     ? Math.round(r.targetLow * 100) / 100     : null,
        targetMean:    r && r.targetMean    ? Math.round(r.targetMean * 100) / 100    : null,
        targetMedian:  r && r.targetMedian  ? Math.round(r.targetMedian * 100) / 100  : null,
      },
      recent: recentArr.slice(0,5).map(t => ({
        analyst:    t.analystName || t.analystCompany || 'Analyst',
        firm:       t.analystCompany || '',
        target:     t.priceTarget ? Math.round(t.priceTarget * 100) / 100 : null,
        action:     t.action || null,
        date:       t.publishedDate ? t.publishedDate.split('T')[0] : t.date || null,
      })),
    };
    setCache(cacheKey, result, 6 * 60 * 60 * 1000);
    res.json(result);
  } catch(e) {
    console.error(`Targets error for ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI CHAT ROUTE ──────────────────────────────────────────────
// POST /api/chat
// Body: { messages: [{role, content}], system: string }
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { messages, system } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

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
        max_tokens: 1024,
        system: system || 'You are ProScreen AI, an expert financial analyst assistant.',
        messages: messages.slice(-10), // last 10 messages to manage context
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic error');
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    res.json({ response: text });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Email alerts via Resend
app.post('/api/alert-email', async (req, res) => {
  const { to, ticker, condition, price } = req.body;
  if (!to || !ticker) return res.status(400).json({ error: 'Missing fields' });
  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ProScreen Alerts <onboarding@resend.dev>',
        to: [to],
        subject: `🔔 Alert Triggered: ${ticker}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
          <h2 style="color:#e8b84b;">🔔 ProScreen Alert Triggered</h2>
          <p>Your alert for <strong>${ticker}</strong> has triggered.</p>
          <div style="background:#f7f6f3;border-radius:8px;padding:16px;margin:16px 0;">
            <div style="font-size:22px;font-weight:600;">${ticker}</div>
            <div style="color:#666;margin:4px 0;">${condition}</div>
            <div style="font-size:28px;font-weight:700;color:#e8b84b;">$${price}</div>
          </div>
          <p style="color:#999;font-size:11px;">ProScreen Professional · Automated alert. Not financial advice.</p>
        </div>`
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });
    res.json({ success: true });
  } catch(e) {
    console.error('Alert email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
