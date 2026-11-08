// Runs a set of textbook alphas on the synthetic market and prints BRAIN-style stats.
// Usage: node tests/calibrate.js [stocks] [years] [seed]
const path = require('path');
const E = require(path.join(__dirname, '../app/src/main/assets/www/engine.js'));
const D = require(path.join(__dirname, '../app/src/main/assets/www/data.js'));

const N = +process.argv[2] || 500, Y = +process.argv[3] || 5, seed = +process.argv[4] || 42;
let t0 = Date.now();
const ds = D.generateSynthetic({ stocks: N, years: Y, seed });
console.log(`generated ${ds.N} x ${ds.T} in ${Date.now() - t0} ms; universes: ${E.listUniverses(ds).join(', ')}`);

const alphas = [
  ['rank(-returns)', {}],
  ['-ts_delta(close, 5)', {}],
  ['group_neutralize(-ts_sum(returns, 5), subindustry)', {}],
  ['rank(-ts_sum(returns, 5))', { decay: 4 }],
  ['rank(-ts_sum(returns, 5))', { delay: 0 }],
  ['rank(vwap - close)', {}],
  ['rank(-(close - open) / (high - low + 0.001))', {}],
  ['-ts_corr(rank(close), rank(volume), 10)', {}],
  ['rank(ts_delay(ts_sum(returns, 230), 21))', { neutralization: 'sector' }],
  ['rank(eps / close)', { neutralization: 'sector' }],
  ['rank(operating_income / assets)', { neutralization: 'sector' }],
  ['-rank(ts_std_dev(returns, 60))', {}],
  ['a = -ts_sum(returns, 3); b = volume / adv20; rank(a) * (1.5 - rank(b))', {}],
  ['trade_when(volume > adv20, -returns, -1)', {}],
  ['r = rank(-ts_sum(returns, 5)); v = rank(eps/close); m = rank(ts_delay(ts_sum(returns, 230), 21)); group_neutralize(r + 0.5*v + 0.5*m, sector)', { decay: 3 }],
  ['sign(ts_delta(volume, 1)) * (-1 * ts_delta(close, 1))', {}],
  ['power(high * low, 0.5) - vwap', {}],
  ['(close - open) / ((high - low) + 0.001)', {}],
  ['rank(close)', { neutralization: 'none' }],
];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('expression', 62), 'sharpe  tvr%   fit   ret%   dd%  margin(bps) long short  ms');
for (const [ex, st] of alphas) {
  try {
    const r = E.simulate(ds, ex, Object.assign({ decay: 0 }, st));
    const s = r.summary;
    console.log(pad((ex.length > 58 ? ex.slice(0, 57) + '…' : ex) + (Object.keys(st).length ? ' ' + JSON.stringify(st).replace(/"/g, '') : ''), 62),
      s.sharpe.toFixed(2).padStart(6), (s.turnover * 100).toFixed(1).padStart(6), s.fitness.toFixed(2).padStart(5),
      (s.returns * 100).toFixed(1).padStart(6), (s.drawdown * 100).toFixed(1).padStart(6), (s.margin * 1e4).toFixed(2).padStart(8),
      s.longCount.toFixed(0).padStart(6), s.shortCount.toFixed(0).padStart(5), String(r.timing.totalMs).padStart(5));
  } catch (e) {
    console.log(pad(ex, 62), 'ERROR', e.toString());
  }
}
