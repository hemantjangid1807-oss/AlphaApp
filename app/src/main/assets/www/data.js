/*
 * BrainSim data layer.
 *  - generateSynthetic(): a realistic multi-factor equity market (sectors, industries,
 *    sub-industries, volatility clustering, fat tails, IPOs/delistings) with weak embedded
 *    anomalies (short-term reversal, momentum, value, quality, low-vol, volume effects)
 *    so classic alphas behave plausibly.
 *  - buildDataset(): turns raw OHLCV matrices into an engine dataset (returns, vwap, adv20, cap...).
 *  - Real data: parse Yahoo Finance chart JSON / Stooq CSV for a built-in US large-cap list.
 *  - CSV import (long format: date,ticker,open,high,low,close,volume[,sector,industry,...]).
 *  - (De)serialisation for caching datasets on the device.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrainData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FIELD_INFO = {
    open: ['Price', 'Daily open price'],
    high: ['Price', 'Daily high price'],
    low: ['Price', 'Daily low price'],
    close: ['Price', 'Daily close price'],
    volume: ['Volume', 'Daily traded volume (shares)'],
    vwap: ['Price', 'Daily volume-weighted average price'],
    returns: ['Price', 'Daily close-to-close return'],
    adv20: ['Volume', 'Average daily volume over the past 20 days (shares)'],
    cap: ['Fundamental', 'Market capitalisation (millions)'],
    sharesout: ['Fundamental', 'Shares outstanding (millions)'],
    assets: ['Fundamental', 'Total assets (millions, quarterly, reported with lag)'],
    liabilities: ['Fundamental', 'Total liabilities (millions, quarterly)'],
    sales: ['Fundamental', 'Trailing annual sales (millions, quarterly)'],
    operating_income: ['Fundamental', 'Trailing annual operating income (millions, quarterly)'],
    eps: ['Fundamental', 'Trailing annual earnings per share (quarterly)'],
    bookvalue_ps: ['Fundamental', 'Book value per share (quarterly)']
  };
  var GROUP_INFO = {
    sector: 'Sector classification (11 groups)',
    industry: 'Industry classification',
    subindustry: 'Sub-industry classification (finest)',
    market: 'Whole market as a single group'
  };

  // ---------------------------------------------------------------- RNG
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    function next() { // mulberry32
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var spare = null;
    function gauss() {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u, w, q;
      do { u = next() * 2 - 1; w = next() * 2 - 1; q = u * u + w * w; } while (q >= 1 || q === 0);
      var m = Math.sqrt(-2 * Math.log(q) / q);
      spare = w * m;
      return u * m;
    }
    return { next: next, gauss: gauss, int: function (n) { return Math.floor(next() * n); } };
  }

  function businessDays(endIso, count) {
    var d = new Date(endIso + 'T00:00:00Z'), out = [];
    while (out.length < count) {
      var wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
  }

  var SECTORS = [
    ['Information Technology', 0.19, ['Software', 'Semiconductors', 'Tech Hardware', 'IT Services']],
    ['Health Care', 0.13, ['Pharmaceuticals', 'Biotechnology', 'Medical Devices', 'Health Care Services']],
    ['Financials', 0.13, ['Banks', 'Insurance', 'Capital Markets', 'Consumer Finance']],
    ['Consumer Discretionary', 0.11, ['Specialty Retail', 'Automobiles', 'Hotels & Leisure', 'Apparel']],
    ['Industrials', 0.12, ['Aerospace & Defense', 'Machinery', 'Transportation', 'Building Products']],
    ['Communication Services', 0.07, ['Media', 'Telecom', 'Interactive Media']],
    ['Consumer Staples', 0.06, ['Food Products', 'Beverages', 'Household Products']],
    ['Energy', 0.05, ['Oil & Gas E&P', 'Energy Equipment', 'Refining']],
    ['Utilities', 0.04, ['Electric Utilities', 'Multi-Utilities']],
    ['Real Estate', 0.05, ['REITs', 'Real Estate Services']],
    ['Materials', 0.05, ['Chemicals', 'Metals & Mining', 'Containers']]
  ];

  // Anomaly strengths (daily). Tuned so textbook alphas land in a realistic Sharpe range.
  var CAL = {
    mktMu: 0.00035, mktVol: 0.0085,
    secVol: 0.0055, indVol: 0.0035, subVol: 0.0025,
    idioBase: 0.017,
    revB: 0.009, revLags: 8, revIntraday: 1.5, revOvernight: 0.5, revVolDamp: 0.6,
    momPhi: 0.996, momStat: 0.0004,
    valKappa: 0.00007, valueVol: 0.007,
    quality: 0.00005, lowVol: 0.00006
  };

  function makeTickers(N, R) {
    var seen = {}, out = [], L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', V = 'AEIOUY';
    while (out.length < N) {
      var len = R.next() < 0.55 ? 4 : 3, s = '';
      for (var k = 0; k < len; k++) s += (k === 1 && R.next() < 0.5) ? V[R.int(V.length)] : L[R.int(26)];
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    }
    return out;
  }

  /**
   * Generate a synthetic market. opts: { stocks=500, years=5, seed=42, endDate='2025-12-31' }
   * One extra warm-up year is generated before the simulation window.
   */
  function generateSynthetic(opts) {
    opts = opts || {};
    var N = Math.max(30, Math.min(2000, opts.stocks | 0 || 500));
    var years = Math.max(1, Math.min(12, opts.years || 5));
    var seed = (opts.seed === undefined ? 42 : opts.seed) | 0;
    var warm = 252, T = Math.round(years * 252) + warm;
    var R = rng(seed * 7919 + 17);
    var dates = businessDays(opts.endDate || '2025-12-31', T);
    var tickers = makeTickers(N, R);
    var C = CAL;

    // --- classification
    var secW = SECTORS.map(function (s) { return s[1]; }), secTot = secW.reduce(function (a, b) { return a + b; }, 0);
    var sectorOf = new Int32Array(N), indOf = new Int32Array(N), subOf = new Int32Array(N);
    var indNames = [], indSector = [], subNames = [], subInd = [];
    SECTORS.forEach(function (s, si) {
      s[2].forEach(function (ind) {
        var ii = indNames.length;
        indNames.push(ind); indSector.push(si);
        var nsub = 1 + R.int(3);
        for (var q = 0; q < nsub; q++) {
          subNames.push(nsub === 1 ? ind : ind + ' ' + 'ABC'[q]);
          subInd.push(ii);
        }
      });
    });
    var i, t, k;
    for (i = 0; i < N; i++) {
      var u = R.next() * secTot, si = 0;
      while (u > secW[si] && si < secW.length - 1) { u -= secW[si]; si++; }
      sectorOf[i] = si;
      var inds = []; for (k = 0; k < indNames.length; k++) if (indSector[k] === si) inds.push(k);
      indOf[i] = inds[R.int(inds.length)];
      var subs = []; for (k = 0; k < subNames.length; k++) if (subInd[k] === indOf[i]) subs.push(k);
      subOf[i] = subs[R.int(subs.length)];
    }

    // --- stock attributes
    var logCap0 = new Float64Array(N), price0 = new Float64Array(N), shares = new Float64Array(N);
    var beta = new Float64Array(N), sig = new Float64Array(N), vol0 = new Float64Array(N);
    var qual = new Float64Array(N), m0 = new Float64Array(N), lev = new Float64Array(N), assetTurn = new Float64Array(N);
    var startDay = new Int32Array(N), endDay = new Int32Array(N);
    var sigMean = 0;
    for (i = 0; i < N; i++) {
      logCap0[i] = Math.log(8e3) + 1.25 * R.gauss(); // millions
      price0[i] = Math.exp(3.8 + 0.75 * R.gauss());
      shares[i] = Math.exp(logCap0[i]) / price0[i]; // millions
      beta[i] = Math.max(0.3, Math.min(2.2, 1 + 0.3 * R.gauss()));
      sig[i] = C.idioBase * Math.pow(Math.exp(logCap0[i]) / 8e3, -0.1) * Math.exp(0.25 * R.gauss());
      sig[i] = Math.max(0.007, Math.min(0.06, sig[i]));
      sigMean += sig[i] / N;
      vol0[i] = shares[i] * 1e6 * Math.exp(Math.log(0.007) + 0.5 * R.gauss());
      qual[i] = R.gauss();
      m0[i] = 0.35 * R.gauss();
      lev[i] = 0.3 + 0.4 * R.next();
      assetTurn[i] = 0.4 + 1.1 * R.next();
      startDay[i] = R.next() < 0.08 ? R.int(Math.floor(T * 0.5)) : 0;
      endDay[i] = R.next() < 0.05 ? Math.floor(T * 0.5) + R.int(Math.floor(T * 0.5)) : T;
    }
    var sigSd = 0;
    for (i = 0; i < N; i++) sigSd += (sig[i] - sigMean) * (sig[i] - sigMean) / N;
    sigSd = Math.sqrt(sigSd) || 1;

    // --- output matrices
    var SZ = T * N;
    function F() { var a = new Float32Array(SZ); a.fill(NaN); return a; }
    var open = F(), high = F(), low = F(), close = F(), volume = F(), vwap = F(), returns = F(), sharesF = F();
    var assets = F(), liabilities = F(), sales = F(), opinc = F(), eps = F(), bvps = F();

    // --- state
    var prevClose = new Float64Array(N), mu = new Float64Array(N), mis = new Float64Array(N), vval = new Float64Array(N);
    var aVol = new Float64Array(N), shareDrift = new Float64Array(N);
    var L = C.revLags, shock = new Float64Array(N * L), wk = new Float64Array(L);
    for (k = 0; k < L; k++) wk[k] = 1 - k / L;
    for (i = 0; i < N; i++) {
      prevClose[i] = price0[i];
      mu[i] = C.momStat * R.gauss();
      mis[i] = m0[i];
      shareDrift[i] = -0.00004 + 0.00006 * R.gauss();
    }
    var nSec = SECTORS.length, nInd = indNames.length, nSub = subNames.length;
    var fSec = new Float64Array(nSec), fInd = new Float64Array(nInd), fSub = new Float64Array(nSub);
    var h = 0, momInnov = C.momStat * Math.sqrt(1 - C.momPhi * C.momPhi);
    var fund = { a: new Float64Array(N), s: new Float64Array(N), o: new Float64Array(N), ni: new Float64Array(N), l: new Float64Array(N) };
    var fundReady = new Uint8Array(N);

    for (t = 0; t < T; t++) {
      // volatility regime with occasional stress events
      h = 0.985 * h + 0.12 * R.gauss();
      if (R.next() < 1 / 900) h += 1.1;
      var vm = Math.max(0.55, Math.min(4, Math.exp(h)));
      var sq = Math.sqrt(vm);
      var mkt = C.mktMu + C.mktVol * vm * R.gauss();
      for (k = 0; k < nSec; k++) fSec[k] = C.secVol * sq * R.gauss();
      for (k = 0; k < nInd; k++) fInd[k] = C.indVol * sq * R.gauss();
      for (k = 0; k < nSub; k++) fSub[k] = C.subVol * sq * R.gauss();
      var ring = t % L;
      var isReport = t % 63 === 45;

      for (i = 0; i < N; i++) {
        var idx = t * N + i;
        if (t < startDay[i] || t >= endDay[i]) continue;
        var s = sig[i] * sq;
        var tail = R.next() < 0.03 ? 2.8 : 1;
        var eOn = s * 0.59 * R.gauss() * tail, eId = s * 0.81 * R.gauss() * tail;
        // reversal of past shocks
        var rev = 0;
        for (k = 0; k < L; k++) {
          var slot = (ring - 1 - k + L * 2) % L;
          rev += wk[k] * shock[i * L + slot];
        }
        var drift = -0.5 * s * s * (1 + 0.03 * 6.84) + mu[i] - C.valKappa * mis[i] + C.quality * qual[i] - C.lowVol * (sig[i] - sigMean) / sigSd - C.revB * rev;
        var sys = beta[i] * mkt + fSec[sectorOf[i]] + fInd[indOf[i]] + fSub[subOf[i]];
        var r = sys + eOn + eId + drift;
        var rOn = 0.4 * sys + eOn + 0.5 * drift;
        var pc = prevClose[i];
        var o = pc * Math.exp(rOn), c = pc * Math.exp(r);
        var rangeSd = 0.35 * s;
        var hi = Math.max(o, c) * Math.exp(Math.abs(rangeSd * R.gauss()));
        var lo = Math.min(o, c) * Math.exp(-Math.abs(rangeSd * R.gauss()));
        var vw = 0.33 * o + 0.37 * c + 0.15 * hi + 0.15 * lo + 0.1 * (hi - lo) * R.gauss();
        vw = Math.max(lo, Math.min(hi, vw));
        // volume: persistent abnormal component + reaction to big moves + market stress
        aVol[i] = 0.75 * aVol[i] + 0.3 * R.gauss();
        var vshock = aVol[i] + 0.55 * (Math.abs(eOn + eId) / s - 0.8) + 0.25 * (vm - 1);
        var v = vol0[i] * Math.exp(0.38 * vshock);
        // remember today's shock for future reversal (low-volume moves revert more)
        var damp = 1 - C.revVolDamp * Math.max(-1, Math.min(1, vshock));
        shock[i * L + ring] = (C.revIntraday * eId + C.revOvernight * eOn) * damp;
        // state updates
        mu[i] = C.momPhi * mu[i] + momInnov * R.gauss();
        var vnews = C.valueVol * R.gauss();
        vval[i] += vnews;
        mis[i] += eOn + eId + drift - vnews;
        shares[i] *= Math.exp(shareDrift[i]);

        open[idx] = o; high[idx] = hi; low[idx] = lo; close[idx] = c; vwap[idx] = vw;
        volume[idx] = Math.round(v);
        returns[idx] = t > startDay[i] ? c / pc - 1 : NaN;
        sharesF[idx] = shares[i];
        prevClose[i] = c;

        // quarterly fundamentals (reported 45 days after quarter end)
        if (isReport || !fundReady[i]) {
          var cap0 = Math.exp(logCap0[i]);
          var val = Math.exp(vval[i] - m0[i]);
          var A = cap0 * (0.8 + lev[i]) * val * Math.exp(0.05 * R.gauss());
          var Sl = A * assetTurn[i] * Math.exp(0.08 * R.gauss());
          var margin = Math.max(-0.1, 0.12 + 0.045 * qual[i] + 0.02 * R.gauss());
          var OI = cap0 * 0.075 * val * (1 + 0.35 * qual[i]) * Math.exp(0.1 * R.gauss());
          fund.a[i] = A; fund.s[i] = Sl; fund.o[i] = Math.max(OI, Sl * margin * 0.2);
          fund.ni[i] = fund.o[i] * 0.74; fund.l[i] = A * lev[i];
          fundReady[i] = 1;
        }
        assets[idx] = fund.a[i]; liabilities[idx] = fund.l[i]; sales[idx] = fund.s[i];
        opinc[idx] = fund.o[i]; eps[idx] = fund.ni[i] / shares[i];
        bvps[idx] = (fund.a[i] - fund.l[i]) / shares[i];
      }
    }

    var ds = buildDataset({
      id: 'syn-' + N + '-' + years + '-' + seed,
      name: 'Synthetic market, ' + N + ' stocks',
      source: 'synthetic',
      params: { stocks: N, years: years, seed: seed },
      dates: dates, tickers: tickers,
      raw: { open: open, high: high, low: low, close: close, volume: volume, vwap: vwap, returns: returns,
        sharesout: sharesF, assets: assets, liabilities: liabilities, sales: sales,
        operating_income: opinc, eps: eps, bookvalue_ps: bvps },
      groups: {
        sector: { codes: sectorOf, names: SECTORS.map(function (s) { return s[0]; }) },
        industry: { codes: indOf, names: indNames },
        subindustry: { codes: subOf, names: subNames }
      },
      simStart: warm
    });
    return ds;
  }

  /**
   * Build an engine dataset.
   * opts.raw: { close (required), open, high, low, volume, vwap, returns, sharesout, ...any extra numeric fields }
   * opts.groups: { name: {codes: Int32Array(N), names: []} } or { name: [label per stock] }
   */
  function buildDataset(opts) {
    var dates = opts.dates, tickers = opts.tickers, T = dates.length, N = tickers.length, SZ = T * N;
    var raw = opts.raw, fields = {}, i, t, k;
    if (!raw.close) throw new Error('Dataset needs a close price field');
    Object.keys(raw).forEach(function (name) { fields[name] = raw[name]; });
    var close = fields.close;
    function F() { var a = new Float32Array(SZ); a.fill(NaN); return a; }
    if (!fields.open) fields.open = close;
    if (!fields.high) fields.high = close;
    if (!fields.low) fields.low = close;
    if (!fields.volume) { fields.volume = F(); for (k = 0; k < SZ; k++) if (close[k] === close[k]) fields.volume[k] = 1e6; }
    if (!fields.returns) {
      var r = F();
      for (i = 0; i < N; i++) {
        var prev = NaN;
        for (t = 0; t < T; t++) {
          var c = close[t * N + i];
          if (c === c) { if (prev === prev && prev > 0) r[t * N + i] = c / prev - 1; prev = c; }
        }
      }
      fields.returns = r;
    }
    if (!fields.vwap) {
      var vw = F(), hi = fields.high, lo = fields.low;
      for (k = 0; k < SZ; k++) vw[k] = (hi[k] + lo[k] + close[k]) / 3;
      fields.vwap = vw;
    }
    // adv20
    var adv = F(), vol = fields.volume;
    for (i = 0; i < N; i++) {
      var s = 0, cnt = 0;
      for (t = 0; t < T; t++) {
        var v = vol[t * N + i];
        if (v === v) { s += v; cnt++; }
        if (t >= 20) { var v2 = vol[(t - 20) * N + i]; if (v2 === v2) { s -= v2; cnt--; } }
        if (cnt > 0 && close[t * N + i] === close[t * N + i]) adv[t * N + i] = s / cnt;
      }
    }
    fields.adv20 = adv;
    if (fields.sharesout && !fields.cap) {
      var cap = F(), sh = fields.sharesout;
      for (k = 0; k < SZ; k++) cap[k] = close[k] * sh[k];
      fields.cap = cap;
    }
    // groups
    var groups = {};
    Object.keys(opts.groups || {}).forEach(function (g) {
      var gv = opts.groups[g];
      if (Array.isArray(gv)) {
        var names = [], map = {}, codes = new Int32Array(N);
        for (i = 0; i < N; i++) {
          var lab = gv[i];
          if (lab === undefined || lab === null || lab === '') { codes[i] = -1; continue; }
          if (!(lab in map)) { map[lab] = names.length; names.push(lab); }
          codes[i] = map[lab];
        }
        groups[g] = { codes: codes, names: names };
      } else groups[g] = gv;
    });
    if (!groups.sector) groups.sector = { codes: new Int32Array(N), names: ['Unclassified'] };
    if (!groups.industry) groups.industry = groups.sector;
    if (!groups.subindustry) groups.subindustry = groups.industry;

    var fieldInfo = {};
    Object.keys(fields).forEach(function (f) {
      var fi = FIELD_INFO[f];
      fieldInfo[f] = fi ? { cat: fi[0], desc: fi[1] } : { cat: 'Custom', desc: 'Imported field' };
    });
    var simStart = opts.simStart !== undefined ? opts.simStart : Math.min(252, Math.floor(T * 0.2));
    return {
      id: opts.id || ('ds-' + Date.now()), name: opts.name || 'Dataset', source: opts.source || 'custom',
      params: opts.params || {}, T: T, N: N, dates: dates, tickers: tickers,
      fields: fields, groups: groups, fieldInfo: fieldInfo, simStart: simStart,
      startDate: dates[simStart], endDate: dates[T - 1], createdAt: opts.createdAt || new Date().toISOString()
    };
  }

  // ------------------------------------------------------- real data list
  // [ticker, sector, industry]
  var US_LARGE_CAPS = [
    ['AAPL', 'Information Technology', 'Tech Hardware'], ['MSFT', 'Information Technology', 'Software'],
    ['NVDA', 'Information Technology', 'Semiconductors'], ['AVGO', 'Information Technology', 'Semiconductors'],
    ['ORCL', 'Information Technology', 'Software'], ['CRM', 'Information Technology', 'Software'],
    ['ADBE', 'Information Technology', 'Software'], ['CSCO', 'Information Technology', 'Communications Equipment'],
    ['ACN', 'Information Technology', 'IT Services'], ['IBM', 'Information Technology', 'IT Services'],
    ['INTC', 'Information Technology', 'Semiconductors'], ['AMD', 'Information Technology', 'Semiconductors'],
    ['QCOM', 'Information Technology', 'Semiconductors'], ['TXN', 'Information Technology', 'Semiconductors'],
    ['AMAT', 'Information Technology', 'Semiconductor Equipment'], ['MU', 'Information Technology', 'Semiconductors'],
    ['INTU', 'Information Technology', 'Software'], ['NOW', 'Information Technology', 'Software'],
    ['LRCX', 'Information Technology', 'Semiconductor Equipment'], ['ADI', 'Information Technology', 'Semiconductors'],
    ['KLAC', 'Information Technology', 'Semiconductor Equipment'], ['HPQ', 'Information Technology', 'Tech Hardware'],
    ['GOOGL', 'Communication Services', 'Interactive Media'], ['META', 'Communication Services', 'Interactive Media'],
    ['NFLX', 'Communication Services', 'Entertainment'], ['DIS', 'Communication Services', 'Entertainment'],
    ['CMCSA', 'Communication Services', 'Media'], ['VZ', 'Communication Services', 'Telecom'],
    ['T', 'Communication Services', 'Telecom'], ['TMUS', 'Communication Services', 'Telecom'],
    ['AMZN', 'Consumer Discretionary', 'Broadline Retail'], ['TSLA', 'Consumer Discretionary', 'Automobiles'],
    ['HD', 'Consumer Discretionary', 'Specialty Retail'], ['MCD', 'Consumer Discretionary', 'Restaurants'],
    ['NKE', 'Consumer Discretionary', 'Apparel'], ['LOW', 'Consumer Discretionary', 'Specialty Retail'],
    ['SBUX', 'Consumer Discretionary', 'Restaurants'], ['TJX', 'Consumer Discretionary', 'Specialty Retail'],
    ['BKNG', 'Consumer Discretionary', 'Hotels & Travel'], ['GM', 'Consumer Discretionary', 'Automobiles'],
    ['F', 'Consumer Discretionary', 'Automobiles'], ['MAR', 'Consumer Discretionary', 'Hotels & Travel'],
    ['PG', 'Consumer Staples', 'Household Products'], ['KO', 'Consumer Staples', 'Beverages'],
    ['PEP', 'Consumer Staples', 'Beverages'], ['COST', 'Consumer Staples', 'Staples Retail'],
    ['WMT', 'Consumer Staples', 'Staples Retail'], ['PM', 'Consumer Staples', 'Tobacco'],
    ['MO', 'Consumer Staples', 'Tobacco'], ['MDLZ', 'Consumer Staples', 'Food Products'],
    ['CL', 'Consumer Staples', 'Household Products'], ['KMB', 'Consumer Staples', 'Household Products'],
    ['GIS', 'Consumer Staples', 'Food Products'], ['UNH', 'Health Care', 'Managed Health Care'],
    ['JNJ', 'Health Care', 'Pharmaceuticals'], ['LLY', 'Health Care', 'Pharmaceuticals'],
    ['ABBV', 'Health Care', 'Pharmaceuticals'], ['MRK', 'Health Care', 'Pharmaceuticals'],
    ['PFE', 'Health Care', 'Pharmaceuticals'], ['TMO', 'Health Care', 'Life Sciences Tools'],
    ['ABT', 'Health Care', 'Medical Devices'], ['DHR', 'Health Care', 'Life Sciences Tools'],
    ['BMY', 'Health Care', 'Pharmaceuticals'], ['AMGN', 'Health Care', 'Biotechnology'],
    ['GILD', 'Health Care', 'Biotechnology'], ['CVS', 'Health Care', 'Health Care Services'],
    ['MDT', 'Health Care', 'Medical Devices'], ['ISRG', 'Health Care', 'Medical Devices'],
    ['VRTX', 'Health Care', 'Biotechnology'], ['JPM', 'Financials', 'Banks'], ['BAC', 'Financials', 'Banks'],
    ['WFC', 'Financials', 'Banks'], ['C', 'Financials', 'Banks'], ['GS', 'Financials', 'Capital Markets'],
    ['MS', 'Financials', 'Capital Markets'], ['BLK', 'Financials', 'Capital Markets'],
    ['SCHW', 'Financials', 'Capital Markets'], ['AXP', 'Financials', 'Consumer Finance'],
    ['SPGI', 'Financials', 'Capital Markets'], ['CB', 'Financials', 'Insurance'], ['PGR', 'Financials', 'Insurance'],
    ['MMC', 'Financials', 'Insurance'], ['V', 'Financials', 'Payments'], ['MA', 'Financials', 'Payments'],
    ['USB', 'Financials', 'Banks'], ['CAT', 'Industrials', 'Machinery'], ['DE', 'Industrials', 'Machinery'],
    ['HON', 'Industrials', 'Industrial Conglomerates'], ['UPS', 'Industrials', 'Air Freight & Logistics'],
    ['GE', 'Industrials', 'Aerospace & Defense'], ['RTX', 'Industrials', 'Aerospace & Defense'],
    ['LMT', 'Industrials', 'Aerospace & Defense'], ['BA', 'Industrials', 'Aerospace & Defense'],
    ['UNP', 'Industrials', 'Ground Transportation'], ['MMM', 'Industrials', 'Industrial Conglomerates'],
    ['ETN', 'Industrials', 'Electrical Equipment'], ['ITW', 'Industrials', 'Machinery'],
    ['CSX', 'Industrials', 'Ground Transportation'], ['FDX', 'Industrials', 'Air Freight & Logistics'],
    ['XOM', 'Energy', 'Integrated Oil & Gas'], ['CVX', 'Energy', 'Integrated Oil & Gas'],
    ['COP', 'Energy', 'Oil & Gas E&P'], ['SLB', 'Energy', 'Energy Equipment'], ['EOG', 'Energy', 'Oil & Gas E&P'],
    ['PSX', 'Energy', 'Refining'], ['MPC', 'Energy', 'Refining'], ['OXY', 'Energy', 'Oil & Gas E&P'],
    ['NEE', 'Utilities', 'Electric Utilities'], ['DUK', 'Utilities', 'Electric Utilities'],
    ['SO', 'Utilities', 'Electric Utilities'], ['D', 'Utilities', 'Multi-Utilities'],
    ['AEP', 'Utilities', 'Electric Utilities'], ['EXC', 'Utilities', 'Electric Utilities'],
    ['PLD', 'Real Estate', 'Industrial REITs'], ['AMT', 'Real Estate', 'Specialized REITs'],
    ['EQIX', 'Real Estate', 'Specialized REITs'], ['SPG', 'Real Estate', 'Retail REITs'],
    ['O', 'Real Estate', 'Retail REITs'], ['PSA', 'Real Estate', 'Specialized REITs'],
    ['LIN', 'Materials', 'Chemicals'], ['SHW', 'Materials', 'Chemicals'], ['APD', 'Materials', 'Chemicals'],
    ['ECL', 'Materials', 'Chemicals'], ['NEM', 'Materials', 'Metals & Mining'], ['FCX', 'Materials', 'Metals & Mining'],
    ['NUE', 'Materials', 'Metals & Mining'], ['DD', 'Materials', 'Chemicals']
  ];

  function yahooUrl(ticker, years) {
    var p2 = Math.floor(Date.now() / 1000), p1 = p2 - Math.round((years + 1.1) * 365.25 * 86400);
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
      '?period1=' + p1 + '&period2=' + p2 + '&interval=1d&events=div%2Csplit&includeAdjustedClose=true';
  }
  function stooqUrl(ticker) {
    return 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(ticker.toLowerCase().replace('.', '-')) + '.us&i=d';
  }
  // -> { dates:[], open:[], high:[], low:[], close:[], volume:[] } (split/dividend adjusted)
  function parseYahoo(text) {
    var j = JSON.parse(text);
    var res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'No data');
    var q = res.indicators.quote[0], adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
    var out = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
    var off = (res.meta && res.meta.gmtoffset) || -14400;
    for (var k = 0; k < res.timestamp.length; k++) {
      var c = q.close[k];
      if (c === null || c === undefined) continue;
      var f = adj && adj[k] ? adj[k] / c : 1;
      out.dates.push(new Date((res.timestamp[k] + off) * 1000).toISOString().slice(0, 10));
      out.open.push((q.open[k] || c) * f); out.high.push((q.high[k] || c) * f);
      out.low.push((q.low[k] || c) * f); out.close.push(c * f);
      out.volume.push(q.volume[k] || 0);
    }
    return out;
  }
  function parseStooq(text) {
    var lines = text.trim().split(/\r?\n/);
    if (lines.length < 3 || !/^date/i.test(lines[0])) throw new Error('No data');
    var out = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
    for (var k = 1; k < lines.length; k++) {
      var p = lines[k].split(',');
      if (p.length < 5) continue;
      out.dates.push(p[0]); out.open.push(+p[1]); out.high.push(+p[2]); out.low.push(+p[3]); out.close.push(+p[4]);
      out.volume.push(p[5] ? +p[5] : 0);
    }
    return out;
  }

  /** series: { TICKER: parsedSeries }, meta: [[ticker, sector, industry]] */
  function datasetFromSeries(series, meta, opts) {
    opts = opts || {};
    var tickers = [], sectors = [], inds = [];
    meta.forEach(function (m) {
      if (series[m[0]] && series[m[0]].dates.length > 50) { tickers.push(m[0]); sectors.push(m[1]); inds.push(m[2] || m[1]); }
    });
    if (tickers.length < 5) throw new Error('Not enough tickers with data (' + tickers.length + ')');
    var dateSet = {};
    tickers.forEach(function (tk) { series[tk].dates.forEach(function (d) { dateSet[d] = (dateSet[d] || 0) + 1; }); });
    // keep dates where at least 30% of tickers traded (drops odd holiday prints)
    var dates = Object.keys(dateSet).filter(function (d) { return dateSet[d] >= tickers.length * 0.3; }).sort();
    if (opts.years) dates = dates.slice(-Math.round((opts.years + 1) * 252));
    var T = dates.length, N = tickers.length, SZ = T * N, pos = {};
    dates.forEach(function (d, ix) { pos[d] = ix; });
    function F() { var a = new Float32Array(SZ); a.fill(NaN); return a; }
    var raw = { open: F(), high: F(), low: F(), close: F(), volume: F() };
    tickers.forEach(function (tk, i) {
      var s = series[tk];
      for (var k = 0; k < s.dates.length; k++) {
        var t = pos[s.dates[k]];
        if (t === undefined || !(s.close[k] > 0)) continue;
        var ix = t * N + i;
        raw.open[ix] = s.open[k]; raw.high[ix] = s.high[k]; raw.low[ix] = s.low[k]; raw.close[ix] = s.close[k];
        raw.volume[ix] = s.volume[k];
      }
    });
    return buildDataset({
      id: opts.id || ('real-' + N + '-' + dates[T - 1]), name: opts.name || ('US large caps, ' + N + ' stocks'),
      source: opts.source || 'yahoo', dates: dates, tickers: tickers, raw: raw,
      groups: { sector: sectors, industry: inds, subindustry: inds },
      simStart: Math.min(252, Math.floor(T * 0.2))
    });
  }

  // --------------------------------------------------------------- CSV
  function splitCsvLine(line, sep) {
    if (line.indexOf('"') < 0) return line.split(sep);
    var out = [], cur = '', q = false;
    for (var k = 0; k < line.length; k++) {
      var ch = line[k];
      if (q) { if (ch === '"') { if (line[k + 1] === '"') { cur += '"'; k++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function normDate(s) {
    s = String(s).trim();
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
    if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    return null;
  }
  /**
   * Long-format CSV: one row per (date, ticker). Required: date, ticker|symbol, close.
   * Optional: open, high, low, volume, vwap, sharesout/cap, sector, industry, subindustry.
   * Every other numeric column becomes a data field you can use in expressions.
   */
  function parseCsvDataset(text, name) {
    var lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (lines.length < 10) throw new Error('CSV has too few rows');
    var sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : (lines[0].indexOf('\t') >= 0 && lines[0].indexOf(',') < 0 ? '\t' : ',');
    var head = splitCsvLine(lines[0], sep).map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'); });
    var di = head.indexOf('date'), ti = head.indexOf('ticker');
    if (ti < 0) ti = head.indexOf('symbol');
    if (di < 0 || ti < 0 || head.indexOf('close') < 0) throw new Error('CSV needs columns: date, ticker (or symbol), close');
    var groupCols = ['sector', 'industry', 'subindustry'];
    var numCols = head.filter(function (h, k) { return k !== di && k !== ti && groupCols.indexOf(h) < 0 && h; });
    var rows = [], dateSet = {}, tkSet = {}, tkOrder = [];
    var groupVals = {};
    for (var r = 1; r < lines.length; r++) {
      var p = splitCsvLine(lines[r], sep);
      var d = normDate(p[di]), tk = (p[ti] || '').trim();
      if (!d || !tk) continue;
      rows.push([d, tk, p]);
      dateSet[d] = 1;
      if (!(tk in tkSet)) { tkSet[tk] = tkOrder.length; tkOrder.push(tk); }
      groupCols.forEach(function (g) {
        var gi = head.indexOf(g);
        if (gi >= 0 && p[gi] && p[gi].trim()) { groupVals[g] = groupVals[g] || {}; groupVals[g][tk] = p[gi].trim(); }
      });
    }
    var dates = Object.keys(dateSet).sort(), T = dates.length, N = tkOrder.length, SZ = T * N;
    if (T < 30) throw new Error('CSV needs at least 30 dates (found ' + T + ')');
    if (N < 5) throw new Error('CSV needs at least 5 tickers (found ' + N + ')');
    var dpos = {};
    dates.forEach(function (d, k) { dpos[d] = k; });
    var raw = {};
    var colIdx = {};
    numCols.forEach(function (c) { raw[c] = new Float32Array(SZ); raw[c].fill(NaN); colIdx[c] = head.indexOf(c); });
    rows.forEach(function (row) {
      var ix = dpos[row[0]] * N + tkSet[row[1]], p = row[2];
      numCols.forEach(function (c) {
        var v = parseFloat(p[colIdx[c]]);
        if (v === v) raw[c][ix] = v;
      });
    });
    // drop columns that never had a number
    Object.keys(raw).forEach(function (c) {
      var any = false;
      for (var k = 0; k < SZ && !any; k++) if (raw[c][k] === raw[c][k]) any = true;
      if (!any) delete raw[c];
    });
    var groups = {};
    groupCols.forEach(function (g) {
      if (groupVals[g]) groups[g] = tkOrder.map(function (tk) { return groupVals[g][tk] || ''; });
    });
    return buildDataset({
      id: 'csv-' + N + '-' + T + '-' + dates[T - 1], name: name || ('CSV, ' + N + ' stocks'), source: 'csv',
      dates: dates, tickers: tkOrder, raw: raw, groups: groups
    });
  }

  // ------------------------------------------------- (de)serialisation
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function f32ToB64(arr) {
    var bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), out = [], chunk = '';
    for (var k = 0; k < bytes.length; k += 3) {
      var a = bytes[k], b = k + 1 < bytes.length ? bytes[k + 1] : 0, c = k + 2 < bytes.length ? bytes[k + 2] : 0;
      var n = (a << 16) | (b << 8) | c;
      chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (k + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (k + 2 < bytes.length ? B64[n & 63] : '=');
      if (chunk.length > 8192) { out.push(chunk); chunk = ''; }
    }
    out.push(chunk);
    return out.join('');
  }
  function b64ToF32(s) {
    var lookup = new Uint8Array(128);
    for (var k = 0; k < B64.length; k++) lookup[B64.charCodeAt(k)] = k;
    var pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    var len = s.length / 4 * 3 - pad, bytes = new Uint8Array(len), p = 0;
    for (k = 0; k < s.length; k += 4) {
      var n = (lookup[s.charCodeAt(k)] << 18) | (lookup[s.charCodeAt(k + 1)] << 12) | (lookup[s.charCodeAt(k + 2)] << 6) | lookup[s.charCodeAt(k + 3)];
      if (p < len) bytes[p++] = (n >> 16) & 255;
      if (p < len) bytes[p++] = (n >> 8) & 255;
      if (p < len) bytes[p++] = n & 255;
    }
    return new Float32Array(bytes.buffer);
  }
  var DERIVED = { adv20: 1, cap: 1 };
  function serialize(ds) {
    var fields = {};
    var skip = ds.source === 'yahoo' ? { adv20: 1, cap: 1, returns: 1, vwap: 1 } : DERIVED;
    Object.keys(ds.fields).forEach(function (f) {
      if (skip[f]) return;
      var a = ds.fields[f];
      if (!(a instanceof Float32Array)) a = Float32Array.from(a);
      fields[f] = f32ToB64(a);
    });
    var groups = {};
    Object.keys(ds.groups).forEach(function (g) { groups[g] = { codes: Array.from(ds.groups[g].codes), names: ds.groups[g].names }; });
    return JSON.stringify({ v: 1, id: ds.id, name: ds.name, source: ds.source, params: ds.params, dates: ds.dates, tickers: ds.tickers,
      fields: fields, groups: groups, simStart: ds.simStart, createdAt: ds.createdAt });
  }
  function deserialize(text) {
    var o = JSON.parse(text), raw = {};
    Object.keys(o.fields).forEach(function (f) { raw[f] = b64ToF32(o.fields[f]); });
    var groups = {};
    Object.keys(o.groups).forEach(function (g) { groups[g] = { codes: Int32Array.from(o.groups[g].codes), names: o.groups[g].names }; });
    return buildDataset({ id: o.id, name: o.name, source: o.source, params: o.params, dates: o.dates, tickers: o.tickers,
      raw: raw, groups: groups, simStart: o.simStart, createdAt: o.createdAt });
  }

  return {
    generateSynthetic: generateSynthetic, buildDataset: buildDataset, datasetFromSeries: datasetFromSeries,
    parseYahoo: parseYahoo, parseStooq: parseStooq, yahooUrl: yahooUrl, stooqUrl: stooqUrl,
    parseCsvDataset: parseCsvDataset, serialize: serialize, deserialize: deserialize,
    US_LARGE_CAPS: US_LARGE_CAPS, FIELD_INFO: FIELD_INFO, GROUP_INFO: GROUP_INFO, CAL: CAL
  };
});
