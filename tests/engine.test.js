// Unit + smoke tests for the BrainSim engine. Run: node tests/engine.test.js
const path = require('path');
const assert = require('assert');
const E = require(path.join(__dirname, '../app/src/main/assets/www/engine.js'));
const D = require(path.join(__dirname, '../app/src/main/assets/www/data.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e); }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps || (a !== a && b !== b);

// ---------- tiny hand-made dataset: T=6 days, N=4 stocks
function tiny() {
  const T = 6, N = 4;
  const c = [10, 20, 30, 40, 11, 19, 33, 38, 12, 18, 36, 36, 13, 17, 39, 34, 14, 16, 42, 32, 15, 15, 45, 30];
  const raw = { close: Float64Array.from(c), volume: Float64Array.from(c.map((x, k) => 1000 + k)) };
  const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
  return D.buildDataset({ id: 'tiny', dates, tickers: ['A', 'B', 'C', 'D'], raw, groups: { sector: ['X', 'X', 'Y', 'Y'] }, simStart: 1 });
}
function evalExpr(ds, src, nanOn) {
  const T = ds.T, N = ds.N;
  const ctx = {
    T, N, nanOn: !!nanOn, universeMat: new Float64Array(T * N).fill(1),
    fieldNames: Object.keys(ds.fields), groupNames: ['sector', 'market'],
    field: (n) => ds.fields[n] ? Float64Array.from(ds.fields[n]) : null,
    group: (n) => {
      if (n === 'market') return new Float64Array(T * N);
      if (!ds.groups[n]) return null;
      const m = new Float64Array(T * N);
      for (let t = 0; t < T; t++) for (let i = 0; i < N; i++) m[t * N + i] = ds.groups[n].codes[i];
      return m;
    }
  };
  return E.evaluateProgram(E.parse(src), ctx).value;
}
const ds0 = tiny();
const row = (m, t) => Array.from(m.slice(t * 4, t * 4 + 4));

test('parse precedence', () => {
  const v = evalExpr(ds0, '1 + 2 * 3 ^ 2 - -4');
  assert.strictEqual(v, 1 + 18 + 4);
});
test('ternary + comparison', () => {
  assert.strictEqual(evalExpr(ds0, '3 > 2 ? 10 : 20'), 10);
  assert.strictEqual(evalExpr(ds0, '3 > 2 && 1 > 5 ? 10 : 20'), 20);
});
test('multi-statement + comments', () => {
  assert.strictEqual(evalExpr(ds0, 'a = 2; # comment\n b = a * 3; // another\n /* block */ a + b'), 8);
});
test('rank with ties', () => {
  const m = evalExpr(ds0, 'rank(close)');
  assert.deepStrictEqual(row(m, 0), [0, 1 / 3, 2 / 3, 1]);
  const t2 = row(m, 2); // 12,18,36,36
  assert.deepStrictEqual(t2, [0, 1 / 3, 5 / 6, 5 / 6]);
});
test('ts_delta / ts_delay', () => {
  const m = evalExpr(ds0, 'ts_delta(close, 2)');
  assert.ok(row(m, 1).every((x) => x !== x));
  assert.deepStrictEqual(row(m, 2), [2, -2, 6, -4]);
});
test('ts_mean / ts_sum / ts_std_dev', () => {
  const m = evalExpr(ds0, 'ts_mean(close, 3)');
  assert.ok(close(m[2 * 4 + 0], 11));
  const s = evalExpr(ds0, 'ts_sum(close, 3)');
  assert.ok(close(s[5 * 4 + 2], 39 + 42 + 45));
  const sd = evalExpr(ds0, 'ts_std_dev(close, 3)');
  assert.ok(close(sd[2 * 4 + 0], Math.sqrt(2 / 3), 1e-9));
});
test('ts_rank / ts_arg_max / ts_min', () => {
  const r = evalExpr(ds0, 'ts_rank(close, 3)');
  assert.ok(close(r[2 * 4 + 0], 1)); // increasing → today is the max
  assert.ok(close(r[2 * 4 + 1], 0)); // decreasing → today is the min
  const am = evalExpr(ds0, 'ts_arg_max(close, 3)');
  assert.strictEqual(am[2 * 4 + 1], 2);
  assert.strictEqual(am[2 * 4 + 0], 0);
  const mn = evalExpr(ds0, 'ts_min(close, 3)');
  assert.strictEqual(mn[5 * 4 + 3], 30);
});
test('ts_corr perfect correlation', () => {
  const m = evalExpr(ds0, 'ts_corr(close, close * 2 + 1, 4)');
  assert.ok(close(m[4 * 4 + 0], 1, 1e-12));
  const n = evalExpr(ds0, 'ts_corr(close, -close, 4)');
  assert.ok(close(n[4 * 4 + 2], -1, 1e-12));
});
test('ts_regression slope', () => {
  const m = evalExpr(ds0, 'ts_regression(close * 3 + 5, close, 4, rettype=2)');
  assert.ok(close(m[5 * 4 + 0], 3, 1e-9));
  const res = evalExpr(ds0, 'ts_regression(close * 3 + 5, close, 4)');
  assert.ok(close(res[5 * 4 + 1], 0, 1e-9));
});
test('ts_decay_linear', () => {
  const m = evalExpr(ds0, 'ts_decay_linear(close, 3)');
  assert.ok(close(m[2 * 4 + 0], (10 * 1 + 11 * 2 + 12 * 3) / 6));
});
test('group_neutralize sums to zero per group', () => {
  const m = evalExpr(ds0, 'group_neutralize(close, sector)');
  const r = row(m, 0);
  assert.ok(close(r[0] + r[1], 0) && close(r[2] + r[3], 0));
});
test('group_rank / group_mean', () => {
  const g = evalExpr(ds0, 'group_rank(close, sector)');
  assert.deepStrictEqual(row(g, 0), [0, 1, 0, 1]);
  const gm = evalExpr(ds0, 'group_mean(close, sector)');
  assert.deepStrictEqual(row(gm, 0), [15, 15, 35, 35]);
  const gw = evalExpr(ds0, 'group_mean(close, close, sector)');
  assert.ok(close(gw[0], (100 + 400) / 30));
});
test('zscore / scale / normalize', () => {
  const z = row(evalExpr(ds0, 'zscore(close)'), 0);
  assert.ok(close(z.reduce((a, b) => a + b, 0), 0, 1e-12));
  const s = row(evalExpr(ds0, 'scale(close - 25)'), 0);
  assert.ok(close(s.reduce((a, b) => a + Math.abs(b), 0), 1, 1e-12));
  const ls = row(evalExpr(ds0, 'scale(close - 25, longscale=2, shortscale=1)'), 0);
  assert.ok(close(ls[2] + ls[3], 2) && close(ls[0] + ls[1], -1));
});
test('trade_when holds and exits', () => {
  const m = evalExpr(ds0, 'trade_when(ts_step(1) == 2, close, ts_step(1) == 5)');
  assert.ok(row(m, 0).every((x) => x !== x));
  assert.deepStrictEqual(row(m, 1), [11, 19, 33, 38]);
  assert.deepStrictEqual(row(m, 3), [11, 19, 33, 38]);
  assert.ok(row(m, 4).every((x) => x !== x));
});
test('bucket', () => {
  const b = row(evalExpr(ds0, 'bucket(rank(close), range="0,1,0.5")'), 0);
  assert.deepStrictEqual(b, [1, 1, 2, 3]);
});
test('if_else / max / min / signed_power', () => {
  assert.deepStrictEqual(row(evalExpr(ds0, 'if_else(close > 25, 1, -1)'), 0), [-1, -1, 1, 1]);
  assert.deepStrictEqual(row(evalExpr(ds0, 'max(close, 25, 15)'), 0), [25, 25, 30, 40]);
  assert.deepStrictEqual(row(evalExpr(ds0, 'signed_power(close - 25, 2)'), 0), [-225, -25, 25, 225]);
});
test('NaN handling on/off in ts_mean', () => {
  const src = 'ts_mean(to_nan(close, value=11), 2)';
  const off = evalExpr(ds0, src, false), on = evalExpr(ds0, src, true);
  assert.ok(off[1 * 4 + 0] !== off[1 * 4 + 0]);
  assert.strictEqual(on[1 * 4 + 0], 10);
});

// ---------- validation / errors
const env = { fields: ['close', 'open', 'volume', 'returns'], groups: ['sector', 'industry', 'subindustry', 'market'] };
test('validate ok', () => assert.ok(E.validate('rank(-ts_delta(close, 5))', env).ok));
test('validate unknown field suggests', () => {
  const r = E.validate('rank(clsoe)', env);
  assert.ok(!r.ok && /Did you mean 'close'/.test(r.error), r.error);
});
test('validate unknown operator suggests', () => {
  const r = E.validate('ts_maen(close, 5)', env);
  assert.ok(!r.ok && /ts_mean/.test(r.error), r.error);
});
test('validate arg errors', () => {
  assert.ok(!E.validate('ts_mean(close)', env).ok);
  assert.ok(!E.validate('ts_mean(close, volume)', env).ok);
  assert.ok(!E.validate('rank(close, foo=1)', env).ok);
});
test('validate syntax error position', () => {
  const r = E.validate('rank(close\n + )', env);
  assert.ok(!r.ok && r.line === 2, JSON.stringify(r));
});
test('validate named string args', () => {
  assert.ok(E.validate('quantile(close, driver=gaussian, sigma=0.5)', env).ok);
  assert.ok(E.validate("bucket(rank(close), range='0,1,0.1')", env).ok);
  assert.ok(E.validate('group_neutralize(bucket(rank(volume), range="0,1,0.25"), sector)', env).ok);
});

// ---------- every operator runs on the synthetic market
const ds = D.generateSynthetic({ stocks: 120, years: 2, seed: 7 });
const sample = {
  m: 'close', n: '10', s: '"gaussian"', b: 'false', g: 'industry'
};
test('all operators execute', () => {
  const errors = [];
  for (const name of Object.keys(E.OPS)) {
    const spec = E.OPS[name];
    let args;
    if (spec.variadic) args = ['close', 'open'];
    else args = spec.params.filter((p) => p.d === undefined).map((p) => sample[p.k]);
    if (name === 'bucket') args = ['rank(close)', 'range="0,1,0.2"'];
    if (name === 'ts_regression') args = ['returns', 'ts_delay(returns,1)', '20'];
    const src = `${name}(${args.join(', ')})`;
    const v = E.validate(src, { fields: Object.keys(ds.fields), groups: ['sector', 'industry', 'subindustry', 'market'] });
    if (!v.ok) { errors.push(src + ' -> ' + v.error); continue; }
    try {
      const r = E.simulate(ds, src.startsWith('ts_step') ? 'rank(ts_step(1)) * rank(close)' : src, { universe: 'TOP100' });
      if (!r.summary) errors.push(src + ' -> no summary');
    } catch (e) { errors.push(src + ' -> ' + e); }
  }
  assert.deepStrictEqual(errors, []);
});
test('simulate result shape + checks', () => {
  const r = E.simulate(ds, 'rank(-ts_sum(returns, 5))', { universe: 'TOP100', testPeriod: 0.5 });
  assert.ok(r.summary && r.os, 'IS + OS stats');
  assert.strictEqual(r.pnl.length, r.dates.length);
  assert.ok(r.yearly.length >= 2);
  assert.ok(r.checks.find((c) => c.name === 'LOW_SHARPE'));
  assert.ok(r.maxWeight <= 0.08 + 1e-9, 'truncation honoured: ' + r.maxWeight);
  assert.ok(Math.abs(r.longCount[10] - r.shortCount[10]) < 20);
});
test('constant alpha rejected', () => {
  assert.throws(() => E.simulate(ds, '1 + 2', {}), /constant/);
});
test('neutralization none is allowed to be net long', () => {
  const r = E.simulate(ds, 'rank(close)', { neutralization: 'none', universe: 'TOP100' });
  assert.ok(r.summary.shortCount === 0 && r.summary.longCount > 50);
});
test('serialize roundtrip', () => {
  const s = D.serialize(ds), back = D.deserialize(s);
  assert.strictEqual(back.T, ds.T); assert.strictEqual(back.N, ds.N);
  const a = E.simulate(ds, 'rank(-returns)', { universe: 'TOP100' }), b = E.simulate(back, 'rank(-returns)', { universe: 'TOP100' });
  assert.ok(Math.abs(a.summary.sharpe - b.summary.sharpe) < 1e-9);
});
test('CSV import', () => {
  const lines = ['date,ticker,open,high,low,close,volume,sector,my_signal'];
  const sub = ds.tickers.slice(0, 12);
  for (let t = 0; t < 200; t++) sub.forEach((tk, i) => {
    const k = t * ds.N + i, c = ds.fields.close[k];
    if (c === c) lines.push([ds.dates[t], tk, ds.fields.open[k], ds.fields.high[k], ds.fields.low[k], c, ds.fields.volume[k], i % 3 ? 'Tech' : 'Energy', Math.sin(t + i)].join(','));
  });
  const d2 = D.parseCsvDataset(lines.join('\n'), 'test');
  const expectN = new Set(lines.slice(1).map((l) => l.split(',')[1])).size;
  assert.strictEqual(d2.N, expectN); assert.strictEqual(d2.T, 200);
  assert.ok(d2.fields.my_signal && d2.groups.sector.names.length === 2);
  const r = E.simulate(d2, 'rank(my_signal)', {});
  assert.ok(r.summary);
});
test('Yahoo + Stooq parsers', () => {
  const y = JSON.stringify({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [1700000000, 1700086400], indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [2, 4], volume: [10, 20] }], adjclose: [{ adjclose: [1, 2] }] } }] } });
  const p = D.parseYahoo(y);
  assert.deepStrictEqual(p.close, [1, 2]); assert.deepStrictEqual(p.open, [0.5, 1]);
  const s = D.parseStooq('Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,0.5,1.5,100\n2024-01-03,1.5,2,1,1.8,200\n');
  assert.deepStrictEqual(s.close, [1.5, 1.8]);
});


test('dataset from downloaded series (real-data path)', () => {
  const series = {}, meta = [];
  const base = ds.tickers.slice(0, 15);
  base.forEach((tk, i) => {
    const s = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
    for (let t = 0; t < ds.T; t++) {
      const k = t * ds.N + i, c = ds.fields.close[k];
      if (c !== c || (i === 3 && t % 50 === 0)) continue; // ragged: missing days for one ticker
      s.dates.push(ds.dates[t]); s.open.push(ds.fields.open[k]); s.high.push(ds.fields.high[k]); s.low.push(ds.fields.low[k]); s.close.push(c); s.volume.push(ds.fields.volume[k]);
    }
    series[tk] = s; meta.push([tk, i % 2 ? 'Energy' : 'Information Technology', i % 3 ? 'Oil' : 'Software']);
  });
  meta.push(['MISSING', 'Utilities', 'Electric']);
  const d2 = D.datasetFromSeries(series, meta, { years: 1 });
  assert.ok(d2.N >= 13 && d2.N <= 15, 'N=' + d2.N);
  assert.strictEqual(d2.T, Math.min(ds.T, 504));
  assert.strictEqual(d2.groups.sector.names.length, 2);
  const r = E.simulate(d2, 'group_neutralize(-ts_sum(returns, 5), industry)', {});
  assert.ok(r.summary && r.dates.length === d2.T - d2.simStart);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
