/*
 * BrainSim engine — a WorldQuant BRAIN style "Fast Expression" alpha simulator.
 *
 *  - Tokenizer + recursive-descent parser (multi-statement, variables, named args, comments)
 *  - ~90 operators (arithmetic, logical, time-series, cross-sectional, group, transformational)
 *  - Simulation pipeline: universe -> pasteurize -> evaluate -> delay -> decay ->
 *    neutralize -> scale to book -> truncate -> PnL
 *  - Statistics: Sharpe, turnover, fitness, returns, drawdown, margin, long/short counts,
 *    yearly breakdown, IS/OS split and IS submission-style checks.
 *
 * Matrices are Float64Array of length T*N stored day-major: index = t*N + i.
 * Works in the browser (window.BrainEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrainEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BOOKSIZE = 20e6;
  var DAYS_PER_YEAR = 252;

  // ------------------------------------------------------------------ errors
  function ExprError(msg, line, col) {
    this.name = 'ExprError';
    this.message = msg;
    this.line = line || 0;
    this.col = col || 0;
  }
  ExprError.prototype = Object.create(Error.prototype);
  ExprError.prototype.constructor = ExprError;
  ExprError.prototype.toString = function () {
    return (this.line ? 'Line ' + this.line + ', col ' + this.col + ': ' : '') + this.message;
  };
  function err(msg, node) {
    throw new ExprError(msg, node && node.line, node && node.col);
  }

  // --------------------------------------------------------------- tokenizer
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
  function isIdChar(c) { return isIdStart(c) || isDigit(c); }

  function tokenize(src) {
    var toks = [], i = 0, line = 1, col = 1, n = src.length;
    function adv(k) { for (var q = 0; q < k; q++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } }
    while (i < n) {
      var ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { adv(1); continue; }
      if (ch === '#' || (ch === '/' && src[i + 1] === '/')) { while (i < n && src[i] !== '\n') adv(1); continue; }
      if (ch === '/' && src[i + 1] === '*') {
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv(1);
        adv(2);
        continue;
      }
      var l = line, c = col, j;
      if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] || ''))) {
        j = i;
        while (j < n && isDigit(src[j])) j++;
        if (src[j] === '.') { j++; while (j < n && isDigit(src[j])) j++; }
        if (src[j] === 'e' || src[j] === 'E') {
          var k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (isDigit(src[k] || '')) { j = k; while (j < n && isDigit(src[j])) j++; }
        }
        toks.push({ type: 'num', value: parseFloat(src.slice(i, j)), line: l, col: c });
        adv(j - i);
        continue;
      }
      if (isIdStart(ch)) {
        j = i;
        while (j < n && isIdChar(src[j])) j++;
        toks.push({ type: 'id', value: src.slice(i, j), line: l, col: c });
        adv(j - i);
        continue;
      }
      if (ch === '"' || ch === "'") {
        j = i + 1;
        while (j < n && src[j] !== ch && src[j] !== '\n') j++;
        if (src[j] !== ch) throw new ExprError('Unterminated string', l, c);
        toks.push({ type: 'str', value: src.slice(i + 1, j), line: l, col: c });
        adv(j - i + 1);
        continue;
      }
      var two = src.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
        toks.push({ type: 'op', value: two, line: l, col: c });
        adv(2);
        continue;
      }
      if ('+-*/^<>!?:(),=;'.indexOf(ch) >= 0) {
        toks.push({ type: 'op', value: ch, line: l, col: c });
        adv(1);
        continue;
      }
      throw new ExprError("Unexpected character '" + ch + "'", l, c);
    }
    toks.push({ type: 'eof', value: '', line: line, col: col });
    return toks;
  }

  // ------------------------------------------------------------------ parser
  function parse(src) {
    var toks = tokenize(src), p = 0;
    function peek(o) { return toks[p + (o || 0)]; }
    function next() { return toks[p++]; }
    function isOp(v, o) { var t = peek(o); return t.type === 'op' && t.value === v; }
    function expect(v) {
      var t = next();
      if (t.type !== 'op' || t.value !== v) {
        throw new ExprError("Expected '" + v + "' but found " + describe(t), t.line, t.col);
      }
      return t;
    }
    function describe(t) {
      if (t.type === 'eof') return 'end of expression';
      return "'" + t.value + "'";
    }
    function mk(t, node) { node.line = t.line; node.col = t.col; return node; }

    function program() {
      var stmts = [];
      while (peek().type !== 'eof') {
        if (isOp(';')) { next(); continue; }
        stmts.push(statement());
        if (peek().type !== 'eof') {
          if (!isOp(';')) {
            var t = peek();
            throw new ExprError('Unexpected ' + describe(t) + ' (missing operator or ";"?)', t.line, t.col);
          }
        }
      }
      if (!stmts.length) throw new ExprError('Expression is empty', 1, 1);
      return { stmts: stmts };
    }
    function statement() {
      var t = peek();
      if (t.type === 'id' && isOp('=', 1)) {
        next(); next();
        return mk(t, { t: 'assign', name: t.value, expr: expr() });
      }
      return expr();
    }
    function expr() { return ternary(); }
    function ternary() {
      var c = orExpr();
      if (isOp('?')) {
        var t = next();
        var a = expr();
        expect(':');
        var b = ternary();
        return mk(t, { t: 'tern', c: c, a: a, b: b });
      }
      return c;
    }
    function binLevel(sub, ops) {
      return function () {
        var a = sub();
        while (peek().type === 'op' && ops.indexOf(peek().value) >= 0) {
          var t = next();
          var b = sub();
          a = mk(t, { t: 'bin', op: t.value, a: a, b: b });
        }
        return a;
      };
    }
    var orExpr, andExpr, cmpExpr, addExpr, mulExpr;
    function unary() {
      if (isOp('-') || isOp('+') || isOp('!')) {
        var t = next();
        return mk(t, { t: 'un', op: t.value, a: unary() });
      }
      return power();
    }
    function power() {
      var a = primary();
      if (isOp('^')) {
        var t = next();
        var b = unary();
        return mk(t, { t: 'bin', op: '^', a: a, b: b });
      }
      return a;
    }
    mulExpr = binLevel(unary, ['*', '/']);
    addExpr = binLevel(mulExpr, ['+', '-']);
    cmpExpr = binLevel(addExpr, ['<', '<=', '>', '>=', '==', '!=']);
    andExpr = binLevel(cmpExpr, ['&&']);
    orExpr = binLevel(andExpr, ['||']);

    function primary() {
      var t = next();
      if (t.type === 'num') return mk(t, { t: 'num', v: t.value });
      if (t.type === 'str') return mk(t, { t: 'str', v: t.value });
      if (t.type === 'id') {
        if (isOp('(')) {
          next();
          var args = [], named = {}, namedOrder = [];
          if (!isOp(')')) {
            for (;;) {
              var a = peek();
              if (a.type === 'id' && isOp('=', 1)) {
                next(); next();
                if (named[a.value]) throw new ExprError("Duplicate argument '" + a.value + "'", a.line, a.col);
                named[a.value] = expr();
                namedOrder.push(a.value);
              } else {
                if (namedOrder.length) {
                  throw new ExprError('Positional argument after named argument', a.line, a.col);
                }
                args.push(expr());
              }
              if (isOp(',')) { next(); continue; }
              break;
            }
          }
          expect(')');
          return mk(t, { t: 'call', name: t.value, args: args, named: named });
        }
        return mk(t, { t: 'id', name: t.value });
      }
      if (t.type === 'op' && t.value === '(') {
        var e = expr();
        expect(')');
        return e;
      }
      throw new ExprError('Unexpected ' + describe(t), t.line, t.col);
    }
    return program();
  }

  // ------------------------------------------------------------ math helpers
  function invNorm(p) {
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var pl = 0.02425, q, r;
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - pl) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function driverFn(driver) {
    driver = String(driver || 'gaussian').toLowerCase();
    if (driver === 'uniform') return function (p) { return (p - 0.5) * 2; };
    if (driver === 'cauchy') return function (p) { return Math.tan(Math.PI * (p - 0.5)); };
    return invNorm;
  }
  function fin(v) { return (v === Infinity || v === -Infinity) ? NaN : v; }
  function sortNum(a, n) {
    var arr = Array.prototype.slice.call(a, 0, n);
    arr.sort(function (x, y) { return x - y; });
    return arr;
  }
  function median(a, n) {
    var s = sortNum(a, n);
    return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }

  // ----------------------------------------------------------------- kernel
  function makeKernel(T, N, nanOn) {
    var SIZE = T * N;
    var H = { T: T, N: N, SIZE: SIZE, nanOn: nanOn };

    function newM() { return new Float64Array(SIZE); }
    function nanM() { var m = new Float64Array(SIZE); m.fill(NaN); return m; }
    function isM(v) { return typeof v !== 'number'; }
    function asM(v) { if (isM(v)) return v; var m = newM(); m.fill(v); return m; }
    function win(d) {
      if (typeof d !== 'number' || d !== d) throw new ExprError('Lookback window must be a number');
      return Math.max(1, Math.round(d));
    }
    function map1(x, f) {
      if (!isM(x)) return f(x);
      var o = newM();
      for (var k = 0; k < SIZE; k++) o[k] = f(x[k]);
      return o;
    }
    function map2(x, y, f) {
      var xm = isM(x), ym = isM(y), o, k;
      if (!xm && !ym) return f(x, y);
      o = newM();
      if (xm && ym) for (k = 0; k < SIZE; k++) o[k] = f(x[k], y[k]);
      else if (xm) for (k = 0; k < SIZE; k++) o[k] = f(x[k], y);
      else for (k = 0; k < SIZE; k++) o[k] = f(x, y[k]);
      return o;
    }
    function map3(x, y, z, f) {
      if (!isM(x) && !isM(y) && !isM(z)) return f(x, y, z);
      var o = newM();
      var xm = isM(x), ym = isM(y), zm = isM(z);
      for (var k = 0; k < SIZE; k++) o[k] = f(xm ? x[k] : x, ym ? y[k] : y, zm ? z[k] : z);
      return o;
    }
    H.newM = newM; H.nanM = nanM; H.isM = isM; H.asM = asM; H.win = win;
    H.map1 = map1; H.map2 = map2; H.map3 = map3;

    // ---- time-series helpers ------------------------------------------
    // Naive window gather. fn(buf, d, nNaN) gets the window oldest->newest (NaNs allowed when nanOn).
    H.tsWin = function (x, d, fn) {
      x = asM(x); d = win(d);
      var o = nanM(), buf = new Float64Array(d);
      if (d > T) return o;
      for (var i = 0; i < N; i++) {
        for (var t = d - 1; t < T; t++) {
          var nn = 0, base = (t - d + 1) * N + i;
          for (var k = 0; k < d; k++) {
            var v = x[base + k * N];
            buf[k] = v;
            if (v !== v) nn++;
          }
          if (nn === d || (nn > 0 && !nanOn)) continue;
          o[t * N + i] = fn(buf, d, nn);
        }
      }
      return o;
    };
    // Running sum / mean / std with a per-stock shift for numerical stability.
    H.tsRun = function (x, d, kind) {
      x = asM(x); d = win(d);
      var o = nanM();
      for (var i = 0; i < N; i++) {
        var s = 0, s2 = 0, c = 0, nn = 0, shift = NaN;
        for (var t = 0; t < T; t++) {
          var v = x[t * N + i], u;
          if (v === v) {
            if (shift !== shift) shift = v;
            u = v - shift; s += u; s2 += u * u; c++;
          } else nn++;
          if (t >= d) {
            var w = x[(t - d) * N + i];
            if (w === w) { u = w - shift; s -= u; s2 -= u * u; c--; if (c === 0) { s = 0; s2 = 0; } } else nn--;
          }
          if (t >= d - 1 && c > 0 && (nanOn || nn === 0)) {
            if (kind === 0) o[t * N + i] = s + c * shift;
            else if (kind === 1) o[t * N + i] = s / c + shift;
            else if (c > 1) { var m = s / c; o[t * N + i] = Math.sqrt(Math.max(0, s2 / c - m * m)); }
          }
        }
      }
      return o;
    };
    // Pairwise window (valid pairs only).
    H.tsPair = function (x, y, d, fn, lag) {
      x = asM(x); y = asM(y); d = win(d); lag = Math.max(0, Math.round(lag || 0));
      var o = nanM(), bx = new Float64Array(d), by = new Float64Array(d);
      for (var i = 0; i < N; i++) {
        for (var t = d - 1 + lag; t < T; t++) {
          var n = 0, bad = false;
          for (var k = 0; k < d; k++) {
            var ty = t - d + 1 + k;
            var a = y[ty * N + i], b = x[(ty - lag) * N + i];
            if (a === a && b === b) { by[n] = a; bx[n] = b; n++; } else if (!nanOn) { bad = true; break; }
          }
          if (bad || n < 2) continue;
          o[t * N + i] = fn(bx, by, n, x[(t - lag) * N + i], y[t * N + i]);
        }
      }
      return o;
    };
    H.tsDelay = function (x, d) {
      if (!isM(x)) return x;
      d = Math.max(0, Math.round(d));
      var o = nanM();
      for (var k = d * N; k < SIZE; k++) o[k] = x[k - d * N];
      return o;
    };

    // ---- cross-sectional / group helpers -------------------------------
    // fn(vals, idx, n, out, base) operates on one subset (whole row or one group).
    H.csApply = function (x, fn, extra) {
      x = asM(x);
      var o = nanM(), vals = new Float64Array(N), idx = new Int32Array(N);
      for (var t = 0; t < T; t++) {
        var base = t * N, n = 0;
        for (var i = 0; i < N; i++) {
          var v = x[base + i];
          if (v === v) { vals[n] = v; idx[n] = i; n++; }
        }
        if (n > 0) fn(vals, idx, n, o, base, extra);
      }
      return o;
    };
    H.groupApply = function (x, g, fn, extra) {
      x = asM(x); g = asM(g);
      var o = nanM(), vals = new Float64Array(N), idx = new Int32Array(N), gid = new Float64Array(N);
      var order = new Array(N);
      for (var t = 0; t < T; t++) {
        var base = t * N, n = 0, i;
        for (i = 0; i < N; i++) {
          var v = x[base + i], gv = g[base + i];
          if (v === v && gv === gv) { order[n] = i; gid[i] = gv; n++; }
        }
        if (!n) continue;
        var ord = order.slice(0, n);
        ord.sort(function (a, b) { return gid[a] - gid[b] || a - b; });
        var s = 0;
        while (s < n) {
          var e = s, cur = gid[ord[s]];
          while (e + 1 < n && gid[ord[e + 1]] === cur) e++;
          var m = 0;
          for (var q = s; q <= e; q++) { vals[m] = x[base + ord[q]]; idx[m] = ord[q]; m++; }
          fn(vals, idx, m, o, base, extra);
          s = e + 1;
        }
      }
      return o;
    };

    // subset kernels
    H.sub = {
      rank: function (vals, idx, n, out, base) {
        if (n === 1) { out[base + idx[0]] = 0.5; return; }
        var ord = new Array(n), k;
        for (k = 0; k < n; k++) ord[k] = k;
        ord.sort(function (a, b) { return vals[a] - vals[b]; });
        k = 0;
        while (k < n) {
          var j = k;
          while (j + 1 < n && vals[ord[j + 1]] === vals[ord[k]]) j++;
          var r = (k + j) / 2 / (n - 1);
          for (var m = k; m <= j; m++) out[base + idx[ord[m]]] = r;
          k = j + 1;
        }
      },
      zscore: function (vals, idx, n, out, base) {
        var s = 0, s2 = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        var mu = s / n;
        for (k = 0; k < n; k++) { var dv = vals[k] - mu; s2 += dv * dv; }
        var sd = Math.sqrt(s2 / n);
        for (k = 0; k < n; k++) out[base + idx[k]] = sd > 0 ? (vals[k] - mu) / sd : 0;
      },
      demean: function (vals, idx, n, out, base) {
        var s = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        var mu = s / n;
        for (k = 0; k < n; k++) out[base + idx[k]] = vals[k] - mu;
      },
      mean: function (vals, idx, n, out, base) {
        var s = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        for (k = 0; k < n; k++) out[base + idx[k]] = s / n;
      },
      sum: function (vals, idx, n, out, base) {
        var s = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        for (k = 0; k < n; k++) out[base + idx[k]] = s;
      },
      max: function (vals, idx, n, out, base) {
        var s = -Infinity, k;
        for (k = 0; k < n; k++) if (vals[k] > s) s = vals[k];
        for (k = 0; k < n; k++) out[base + idx[k]] = s;
      },
      min: function (vals, idx, n, out, base) {
        var s = Infinity, k;
        for (k = 0; k < n; k++) if (vals[k] < s) s = vals[k];
        for (k = 0; k < n; k++) out[base + idx[k]] = s;
      },
      median: function (vals, idx, n, out, base) {
        var md = median(vals, n);
        for (var k = 0; k < n; k++) out[base + idx[k]] = md;
      },
      count: function (vals, idx, n, out, base) {
        for (var k = 0; k < n; k++) out[base + idx[k]] = n;
      },
      std: function (vals, idx, n, out, base) {
        var s = 0, s2 = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        var mu = s / n;
        for (k = 0; k < n; k++) { var dv = vals[k] - mu; s2 += dv * dv; }
        var sd = Math.sqrt(s2 / n);
        for (k = 0; k < n; k++) out[base + idx[k]] = sd;
      },
      minmax: function (vals, idx, n, out, base) {
        var lo = Infinity, hi = -Infinity, k;
        for (k = 0; k < n; k++) { if (vals[k] < lo) lo = vals[k]; if (vals[k] > hi) hi = vals[k]; }
        for (k = 0; k < n; k++) out[base + idx[k]] = hi > lo ? (vals[k] - lo) / (hi - lo) : 0.5;
      },
      scale: function (vals, idx, n, out, base, opt) {
        var k, sp = 0, sn = 0;
        for (k = 0; k < n; k++) { if (vals[k] > 0) sp += vals[k]; else sn -= vals[k]; }
        if (opt.split) {
          for (k = 0; k < n; k++) {
            var v = vals[k];
            out[base + idx[k]] = v > 0 ? (sp > 0 ? v / sp * opt.longscale : 0) : (sn > 0 ? v / sn * opt.shortscale : 0);
          }
        } else {
          var tot = sp + sn;
          for (k = 0; k < n; k++) out[base + idx[k]] = tot > 0 ? vals[k] / tot * opt.scale : 0;
        }
      },
      normalize: function (vals, idx, n, out, base, opt) {
        var s = 0, s2 = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        var mu = s / n;
        for (k = 0; k < n; k++) { var dv = vals[k] - mu; s2 += dv * dv; }
        var sd = Math.sqrt(s2 / n);
        for (k = 0; k < n; k++) {
          var v = vals[k] - mu;
          if (opt.useStd) v = sd > 0 ? v / sd : 0;
          if (opt.limit > 0) v = Math.max(-opt.limit, Math.min(opt.limit, v));
          out[base + idx[k]] = v;
        }
      },
      winsorize: function (vals, idx, n, out, base, opt) {
        var s = 0, s2 = 0, k;
        for (k = 0; k < n; k++) s += vals[k];
        var mu = s / n;
        for (k = 0; k < n; k++) { var dv = vals[k] - mu; s2 += dv * dv; }
        var sd = Math.sqrt(s2 / n), lo = mu - opt.std * sd, hi = mu + opt.std * sd;
        for (k = 0; k < n; k++) out[base + idx[k]] = Math.max(lo, Math.min(hi, vals[k]));
      },
      quantile: function (vals, idx, n, out, base, opt) {
        H.sub.rank(vals, idx, n, out, base);
        for (var k = 0; k < n; k++) {
          var r = out[base + idx[k]];
          var p = (r * (n - 1) + 1) / (n + 1);
          out[base + idx[k]] = opt.f(p) * opt.sigma;
        }
      }
    };
    return H;
  }

  // ---------------------------------------------------------------- operators
  // param kinds: m = matrix/scalar expression, n = constant number, s = string, b = boolean, g = group
  function P(name, kind, def) { return { n: name, k: kind, d: def }; }
  var OPS = {};
  function op(name, cat, sig, desc, params, fn, extra) {
    var o = { name: name, cat: cat, sig: sig, desc: desc, params: params, fn: fn };
    if (extra) for (var key in extra) o[key] = extra[key];
    OPS[name] = o;
  }

  // ---- Arithmetic
  var A = 'Arithmetic';
  op('abs', A, 'abs(x)', 'Absolute value of x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.abs); });
  op('add', A, 'add(x, y, ..., filter=false)', 'Sum of all inputs. With filter=true, NaN inputs are treated as 0.',
    [P('filter', 'b', false)], function (H, a) {
      var xs = a[0], filt = a[1], acc = xs[0];
      for (var q = 1; q < xs.length; q++) {
        acc = H.map2(acc, xs[q], filt ? function (x, y) { return (x === x ? x : 0) + (y === y ? y : 0); } : function (x, y) { return x + y; });
      }
      return acc;
    }, { variadic: 2 });
  op('subtract', A, 'subtract(x, y, filter=false)', 'x - y. With filter=true, NaN inputs are treated as 0.',
    [P('x', 'm'), P('y', 'm'), P('filter', 'b', false)], function (H, a) {
      return H.map2(a[0], a[1], a[2] ? function (x, y) { return (x === x ? x : 0) - (y === y ? y : 0); } : function (x, y) { return x - y; });
    });
  op('multiply', A, 'multiply(x, y, ..., filter=false)', 'Product of all inputs. With filter=true, NaN inputs are treated as 1.',
    [P('filter', 'b', false)], function (H, a) {
      var xs = a[0], filt = a[1], acc = xs[0];
      for (var q = 1; q < xs.length; q++) {
        acc = H.map2(acc, xs[q], filt ? function (x, y) { return (x === x ? x : 1) * (y === y ? y : 1); } : function (x, y) { return x * y; });
      }
      return acc;
    }, { variadic: 2 });
  op('divide', A, 'divide(x, y)', 'x / y (division by zero gives NaN).', [P('x', 'm'), P('y', 'm')],
    function (H, a) { return H.map2(a[0], a[1], function (x, y) { return y === 0 ? NaN : x / y; }); });
  op('inverse', A, 'inverse(x)', '1 / x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x === 0 ? NaN : 1 / x; }); });
  op('log', A, 'log(x)', 'Natural logarithm; NaN for x <= 0.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x > 0 ? Math.log(x) : NaN; }); });
  op('exp', A, 'exp(x)', 'Exponential e^x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return fin(Math.exp(x)); }); });
  op('sqrt', A, 'sqrt(x)', 'Square root; NaN for negative x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x >= 0 ? Math.sqrt(x) : NaN; }); });
  op('power', A, 'power(x, y)', 'x raised to the power y.', [P('x', 'm'), P('y', 'm')], function (H, a) { return H.map2(a[0], a[1], function (x, y) { return fin(Math.pow(x, y)); }); });
  op('signed_power', A, 'signed_power(x, y)', 'sign(x) * |x|^y — keeps the sign while reshaping the distribution.', [P('x', 'm'), P('y', 'm')],
    function (H, a) { return H.map2(a[0], a[1], function (x, y) { return fin((x > 0 ? 1 : x < 0 ? -1 : 0) * Math.pow(Math.abs(x), y)); }); });
  op('sign', A, 'sign(x)', '+1 if x > 0, -1 if x < 0, 0 if x = 0.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x !== x ? NaN : x > 0 ? 1 : x < 0 ? -1 : 0; }); });
  op('reverse', A, 'reverse(x)', '-x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return -x; }); });
  op('max', A, 'max(x, y, ...)', 'Element-wise maximum of the inputs.', [], function (H, a) {
    var xs = a[0], acc = xs[0];
    for (var q = 1; q < xs.length; q++) acc = H.map2(acc, xs[q], Math.max);
    return acc;
  }, { variadic: 2 });
  op('min', A, 'min(x, y, ...)', 'Element-wise minimum of the inputs.', [], function (H, a) {
    var xs = a[0], acc = xs[0];
    for (var q = 1; q < xs.length; q++) acc = H.map2(acc, xs[q], Math.min);
    return acc;
  }, { variadic: 2 });
  op('s_log_1p', A, 's_log_1p(x)', 'sign(x) * log(1 + |x|) — compresses outliers, keeps sign.', [P('x', 'm')],
    function (H, a) { return H.map1(a[0], function (x) { return (x > 0 ? 1 : x < 0 ? -1 : 0) * Math.log(1 + Math.abs(x)); }); });
  op('floor', A, 'floor(x)', 'Largest integer <= x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.floor); });
  op('ceiling', A, 'ceiling(x)', 'Smallest integer >= x.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.ceil); });
  op('round', A, 'round(x)', 'Round to the nearest integer.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.round); });
  op('round_down', A, 'round_down(x, f=1)', 'Round x down to the nearest multiple of f.', [P('x', 'm'), P('f', 'n', 1)],
    function (H, a) { var f = a[1] || 1; return H.map1(a[0], function (x) { return Math.floor(x / f) * f; }); });
  op('fraction', A, 'fraction(x)', 'Fractional part: sign(x) * (|x| - floor(|x|)).', [P('x', 'm')],
    function (H, a) { return H.map1(a[0], function (x) { var ax = Math.abs(x); return (x < 0 ? -1 : 1) * (ax - Math.floor(ax)); }); });
  op('tanh', A, 'tanh(x)', 'Hyperbolic tangent.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.tanh); });
  op('sigmoid', A, 'sigmoid(x)', '1 / (1 + exp(-x)).', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return 1 / (1 + Math.exp(-x)); }); });
  op('arc_tan', A, 'arc_tan(x)', 'Inverse tangent.', [P('x', 'm')], function (H, a) { return H.map1(a[0], Math.atan); });
  op('densify', A, 'densify(x)', 'Re-numbers group codes compactly (no-op here; groups of any value are supported).', [P('x', 'm')], function (H, a) { return a[0]; });
  op('is_nan', A, 'is_nan(x)', '1 if x is NaN, else 0.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x !== x ? 1 : 0; }); });
  op('to_nan', A, 'to_nan(x, value=0, reverse=false)', 'Replace x == value with NaN (reverse=true: replace x != value).',
    [P('x', 'm'), P('value', 'n', 0), P('reverse', 'b', false)],
    function (H, a) { var v = a[1], r = a[2]; return H.map1(a[0], function (x) { return (r ? x !== v : x === v) ? NaN : x; }); });
  op('nan_mask', A, 'nan_mask(x, y)', 'NaN where y < 0, otherwise x.', [P('x', 'm'), P('y', 'm')],
    function (H, a) { return H.map2(a[0], a[1], function (x, y) { return y < 0 || y !== y ? NaN : x; }); });
  op('purify', A, 'purify(x)', 'Replace +/-Infinity with NaN.', [P('x', 'm')], function (H, a) { return H.map1(a[0], fin); });

  // ---- Logical
  var L = 'Logical';
  op('if_else', L, 'if_else(cond, x, y)', 'x where cond is true (non-zero), otherwise y. Same as cond ? x : y.',
    [P('cond', 'm'), P('x', 'm'), P('y', 'm')], function (H, a) { return H.map3(a[0], a[1], a[2], function (c, x, y) { return c !== c ? NaN : c ? x : y; }); });
  op('and', L, 'and(x, y)', '1 if both x and y are true, else 0.', [P('x', 'm'), P('y', 'm')],
    function (H, a) { return H.map2(a[0], a[1], function (x, y) { return x !== x || y !== y ? NaN : (x && y ? 1 : 0); }); });
  op('or', L, 'or(x, y)', '1 if x or y is true, else 0.', [P('x', 'm'), P('y', 'm')],
    function (H, a) { return H.map2(a[0], a[1], function (x, y) { return x !== x || y !== y ? NaN : (x || y ? 1 : 0); }); });
  op('not', L, 'not(x)', '1 if x is false (0), else 0.', [P('x', 'm')], function (H, a) { return H.map1(a[0], function (x) { return x !== x ? NaN : x ? 0 : 1; }); });

  // ---- Time series
  var TS = 'Time Series';
  op('ts_delay', TS, 'ts_delay(x, d)', 'Value of x d days ago.', [P('x', 'm'), P('d', 'n')], function (H, a) { return H.tsDelay(a[0], a[1]); });
  op('ts_delta', TS, 'ts_delta(x, d)', 'x - ts_delay(x, d): change over d days.', [P('x', 'm'), P('d', 'n')],
    function (H, a) { return H.map2(a[0], H.tsDelay(a[0], a[1]), function (x, y) { return x - y; }); });
  op('ts_sum', TS, 'ts_sum(x, d)', 'Sum of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) { return H.tsRun(a[0], a[1], 0); });
  op('ts_mean', TS, 'ts_mean(x, d)', 'Average of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) { return H.tsRun(a[0], a[1], 1); });
  op('ts_std_dev', TS, 'ts_std_dev(x, d)', 'Standard deviation of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) { return H.tsRun(a[0], a[1], 2); });
  op('ts_zscore', TS, 'ts_zscore(x, d)', '(x - ts_mean(x, d)) / ts_std_dev(x, d).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    var m = H.tsRun(a[0], a[1], 1), s = H.tsRun(a[0], a[1], 2);
    return H.map3(a[0], m, s, function (x, mu, sd) { return sd > 0 ? (x - mu) / sd : NaN; });
  });
  op('ts_ir', TS, 'ts_ir(x, d)', 'Information ratio: ts_mean(x, d) / ts_std_dev(x, d).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    var m = H.tsRun(a[0], a[1], 1), s = H.tsRun(a[0], a[1], 2);
    return H.map2(m, s, function (mu, sd) { return sd > 0 ? mu / sd : NaN; });
  });
  op('ts_rank', TS, 'ts_rank(x, d, constant=0)', 'Rank of today\'s value among the past d days, in [0, 1], plus constant.',
    [P('x', 'm'), P('d', 'n'), P('constant', 'n', 0)], function (H, a) {
      var cst = a[2];
      return H.tsWin(a[0], a[1], function (b, d) {
        var cur = b[d - 1];
        if (cur !== cur) return NaN;
        var lt = 0, eq = 0, n = 0;
        for (var k = 0; k < d; k++) { var v = b[k]; if (v === v) { n++; if (v < cur) lt++; else if (v === cur) eq++; } }
        return (n > 1 ? (lt + 0.5 * (eq - 1)) / (n - 1) : 0.5) + cst;
      });
    });
  op('ts_min', TS, 'ts_min(x, d)', 'Minimum of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = Infinity; for (var k = 0; k < d; k++) if (b[k] < m) m = b[k]; return m; });
  });
  op('ts_max', TS, 'ts_max(x, d)', 'Maximum of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = -Infinity; for (var k = 0; k < d; k++) if (b[k] > m) m = b[k]; return m; });
  });
  op('ts_arg_max', TS, 'ts_arg_max(x, d)', 'Days since the maximum of the past d days (0 = today).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = -Infinity, p = 0; for (var k = 0; k < d; k++) if (b[k] >= m) { m = b[k]; p = k; } return d - 1 - p; });
  });
  op('ts_arg_min', TS, 'ts_arg_min(x, d)', 'Days since the minimum of the past d days (0 = today).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = Infinity, p = 0; for (var k = 0; k < d; k++) if (b[k] <= m) { m = b[k]; p = k; } return d - 1 - p; });
  });
  op('ts_max_diff', TS, 'ts_max_diff(x, d)', 'x - ts_max(x, d).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.map2(a[0], OPS.ts_max.fn(H, a), function (x, y) { return x - y; });
  });
  op('ts_min_diff', TS, 'ts_min_diff(x, d)', 'x - ts_min(x, d).', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.map2(a[0], OPS.ts_min.fn(H, a), function (x, y) { return x - y; });
  });
  op('ts_product', TS, 'ts_product(x, d)', 'Product of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var p = 1; for (var k = 0; k < d; k++) if (b[k] === b[k]) p *= b[k]; return fin(p); });
  });
  op('ts_corr', TS, 'ts_corr(x, y, d)', 'Pearson correlation of x and y over the past d days.', [P('x', 'm'), P('y', 'm'), P('d', 'n')], function (H, a) {
    return H.tsPair(a[0], a[1], a[2], function (bx, by, n) {
      var mx = 0, my = 0, k;
      for (k = 0; k < n; k++) { mx += bx[k]; my += by[k]; }
      mx /= n; my /= n;
      var sxx = 0, syy = 0, sxy = 0;
      for (k = 0; k < n; k++) { var dx = bx[k] - mx, dy = by[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      return sxx > 1e-300 && syy > 1e-300 ? sxy / Math.sqrt(sxx * syy) : NaN;
    });
  });
  op('ts_covariance', TS, 'ts_covariance(y, x, d)', 'Covariance of y and x over the past d days.', [P('y', 'm'), P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsPair(a[0], a[1], a[2], function (bx, by, n) {
      var mx = 0, my = 0, k, s = 0;
      for (k = 0; k < n; k++) { mx += bx[k]; my += by[k]; }
      mx /= n; my /= n;
      for (k = 0; k < n; k++) s += (bx[k] - mx) * (by[k] - my);
      return s / n;
    });
  });
  op('ts_regression', TS, 'ts_regression(y, x, d, lag=0, rettype=0)',
    'Rolling OLS of y on x (x lagged by lag). rettype: 0 residual, 1 intercept, 2 slope, 3 estimate, 4 SSE, 5 SST, 6 R², 7 MSE, 8 SE(slope), 9 SE(intercept).',
    [P('y', 'm'), P('x', 'm'), P('d', 'n'), P('lag', 'n', 0), P('rettype', 'n', 0)], function (H, a) {
      var rt = Math.round(a[4]);
      return H.tsPair(a[1], a[0], a[2], function (bx, by, n, xcur, ycur) {
        var mx = 0, my = 0, k;
        for (k = 0; k < n; k++) { mx += bx[k]; my += by[k]; }
        mx /= n; my /= n;
        var sxx = 0, sxy = 0, sst = 0;
        for (k = 0; k < n; k++) { var dx = bx[k] - mx, dy = by[k] - my; sxx += dx * dx; sxy += dx * dy; sst += dy * dy; }
        if (!(sxx > 1e-300)) return NaN;
        var beta = sxy / sxx, alpha = my - beta * mx, sse = 0;
        for (k = 0; k < n; k++) { var e = by[k] - alpha - beta * bx[k]; sse += e * e; }
        var mse = n > 2 ? sse / (n - 2) : NaN;
        switch (rt) {
          case 1: return alpha;
          case 2: return beta;
          case 3: return alpha + beta * xcur;
          case 4: return sse;
          case 5: return sst;
          case 6: return sst > 0 ? 1 - sse / sst : NaN;
          case 7: return mse;
          case 8: return Math.sqrt(mse / sxx);
          case 9: return Math.sqrt(mse * (1 / n + mx * mx / sxx));
          default: return ycur - (alpha + beta * xcur);
        }
      }, a[3]);
    });
  op('ts_decay_linear', TS, 'ts_decay_linear(x, d, dense=false)', 'Linearly weighted average of the past d days (today has weight d, oldest weight 1).',
    [P('x', 'm'), P('d', 'n'), P('dense', 'b', false)], function (H, a) {
      return H.tsWin(a[0], a[1], function (b, d) {
        var s = 0, w = 0;
        for (var k = 0; k < d; k++) if (b[k] === b[k]) { s += (k + 1) * b[k]; w += k + 1; }
        return w > 0 ? s / w : NaN;
      });
    });
  op('ts_decay_exp_window', TS, 'ts_decay_exp_window(x, d, factor=1.0)', 'Exponentially weighted average over d days: weight factor^age (age 0 = today).',
    [P('x', 'm'), P('d', 'n'), P('factor', 'n', 1)], function (H, a) {
      var f = a[2];
      return H.tsWin(a[0], a[1], function (b, d) {
        var s = 0, w = 0;
        for (var k = 0; k < d; k++) if (b[k] === b[k]) { var wt = Math.pow(f, d - 1 - k); s += wt * b[k]; w += wt; }
        return w > 0 ? s / w : NaN;
      });
    });
  op('ts_backfill', TS, 'ts_backfill(x, d, k=1)', 'Replace NaN with the most recent valid value within the past d days.',
    [P('x', 'm'), P('d', 'n'), P('k', 'n', 1)], function (H, a) {
      var x = H.asM(a[0]), d = H.win(a[1]), N = H.N, T = H.T, o = H.nanM();
      for (var i = 0; i < N; i++) {
        var lastT = -1e9, lastV = NaN;
        for (var t = 0; t < T; t++) {
          var v = x[t * N + i];
          if (v === v) { lastT = t; lastV = v; o[t * N + i] = v; } else if (t - lastT < d) o[t * N + i] = lastV;
        }
      }
      return o;
    });
  op('kth_element', TS, 'kth_element(x, d, k=1)', 'k-th most recent valid value within the past d days (k=1 backfills).',
    [P('x', 'm'), P('d', 'n'), P('k', 'n', 1)], function (H, a) {
      var kk = Math.max(1, Math.round(a[2]));
      var x = H.asM(a[0]), d = H.win(a[1]), N = H.N, T = H.T, o = H.nanM();
      for (var i = 0; i < N; i++) {
        for (var t = 0; t < T; t++) {
          var found = 0;
          for (var s = t; s >= 0 && s > t - d; s--) {
            var v = x[s * N + i];
            if (v === v && ++found === kk) { o[t * N + i] = v; break; }
          }
        }
      }
      return o;
    });
  op('ts_count_nans', TS, 'ts_count_nans(x, d)', 'Number of NaN values in the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    var x = H.asM(a[0]), d = H.win(a[1]), N = H.N, T = H.T, o = H.nanM();
    for (var i = 0; i < N; i++) {
      var c = 0;
      for (var t = 0; t < T; t++) {
        if (x[t * N + i] !== x[t * N + i]) c++;
        if (t >= d && x[(t - d) * N + i] !== x[(t - d) * N + i]) c--;
        if (t >= d - 1) o[t * N + i] = c;
      }
    }
    return o;
  });
  op('ts_scale', TS, 'ts_scale(x, d, constant=0)', '(x - ts_min(x, d)) / (ts_max(x, d) - ts_min(x, d)) + constant.',
    [P('x', 'm'), P('d', 'n'), P('constant', 'n', 0)], function (H, a) {
      var cst = a[2];
      return H.tsWin(a[0], a[1], function (b, d) {
        var cur = b[d - 1], lo = Infinity, hi = -Infinity;
        if (cur !== cur) return NaN;
        for (var k = 0; k < d; k++) { if (b[k] < lo) lo = b[k]; if (b[k] > hi) hi = b[k]; }
        return (hi > lo ? (cur - lo) / (hi - lo) : 0.5) + cst;
      });
    });
  op('ts_av_diff', TS, 'ts_av_diff(x, d)', 'x - ts_mean(x, d), ignoring NaN in the mean.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.map2(a[0], H.tsRun(a[0], a[1], 1), function (x, m) { return x - m; });
  });
  op('ts_median', TS, 'ts_median(x, d)', 'Median of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    var tmp = new Float64Array(Math.max(1, Math.round(a[1])));
    return H.tsWin(a[0], a[1], function (b, d) {
      var n = 0;
      for (var k = 0; k < d; k++) if (b[k] === b[k]) tmp[n++] = b[k];
      return median(tmp, n);
    });
  });
  function moments(b, d) {
    var n = 0, s = 0, k;
    for (k = 0; k < d; k++) if (b[k] === b[k]) { s += b[k]; n++; }
    var mu = s / n, m2 = 0, m3 = 0, m4 = 0;
    for (k = 0; k < d; k++) if (b[k] === b[k]) { var dv = b[k] - mu, d2 = dv * dv; m2 += d2; m3 += d2 * dv; m4 += d2 * d2; }
    return { n: n, m2: m2 / n, m3: m3 / n, m4: m4 / n };
  }
  op('ts_skewness', TS, 'ts_skewness(x, d)', 'Skewness of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = moments(b, d); return m.m2 > 0 ? m.m3 / Math.pow(m.m2, 1.5) : NaN; });
  });
  op('ts_kurtosis', TS, 'ts_kurtosis(x, d)', 'Excess kurtosis of x over the past d days.', [P('x', 'm'), P('d', 'n')], function (H, a) {
    return H.tsWin(a[0], a[1], function (b, d) { var m = moments(b, d); return m.m2 > 0 ? m.m4 / (m.m2 * m.m2) - 3 : NaN; });
  });
  op('ts_moment', TS, 'ts_moment(x, d, k=2)', 'k-th central moment of x over the past d days.', [P('x', 'm'), P('d', 'n'), P('k', 'n', 2)], function (H, a) {
    var kk = a[2];
    return H.tsWin(a[0], a[1], function (b, d) {
      var n = 0, s = 0, q;
      for (q = 0; q < d; q++) if (b[q] === b[q]) { s += b[q]; n++; }
      var mu = s / n, m = 0;
      for (q = 0; q < d; q++) if (b[q] === b[q]) m += Math.pow(b[q] - mu, kk);
      return m / n;
    });
  });
  op('ts_quantile', TS, 'ts_quantile(x, d, driver="gaussian")', 'ts_rank mapped through the inverse CDF of driver (gaussian, uniform, cauchy).',
    [P('x', 'm'), P('d', 'n'), P('driver', 's', 'gaussian')], function (H, a) {
      var f = driverFn(a[2]);
      return H.tsWin(a[0], a[1], function (b, d) {
        var cur = b[d - 1];
        if (cur !== cur) return NaN;
        var lt = 0, eq = 0, n = 0;
        for (var k = 0; k < d; k++) { var v = b[k]; if (v === v) { n++; if (v < cur) lt++; else if (v === cur) eq++; } }
        var r = n > 1 ? (lt + 0.5 * (eq - 1)) / (n - 1) : 0.5;
        return f((r * (n - 1) + 1) / (n + 1));
      });
    });
  op('ts_step', TS, 'ts_step(n)', 'Day counter: 1 on the first day, increasing by 1 each day.', [P('n', 'n', 1)], function (H) {
    var o = H.newM(), N = H.N;
    for (var k = 0; k < H.SIZE; k++) o[k] = Math.floor(k / N) + 1;
    return o;
  });
  op('days_from_last_change', TS, 'days_from_last_change(x)', 'Number of days since x last changed value.', [P('x', 'm')], function (H, a) {
    var x = H.asM(a[0]), N = H.N, T = H.T, o = H.nanM();
    for (var i = 0; i < N; i++) {
      var c = 0;
      for (var t = 0; t < T; t++) {
        if (t > 0 && x[t * N + i] === x[(t - 1) * N + i]) c++; else c = 0;
        o[t * N + i] = c;
      }
    }
    return o;
  });
  op('last_diff_value', TS, 'last_diff_value(x, d)', 'Most recent value within the past d days that differs from today\'s value.',
    [P('x', 'm'), P('d', 'n')], function (H, a) {
      var x = H.asM(a[0]), d = H.win(a[1]), N = H.N, T = H.T, o = H.nanM();
      for (var i = 0; i < N; i++) {
        for (var t = 1; t < T; t++) {
          var cur = x[t * N + i];
          for (var s = t - 1; s >= 0 && s > t - d; s--) {
            var v = x[s * N + i];
            if (v === v && v !== cur) { o[t * N + i] = v; break; }
          }
        }
      }
      return o;
    });

  // ---- Cross sectional
  var CS = 'Cross Sectional';
  op('rank', CS, 'rank(x, rate=2)', 'Cross-sectional rank across stocks each day, scaled to [0, 1]. Ties get the average rank.',
    [P('x', 'm'), P('rate', 'n', 2)], function (H, a) { return H.csApply(a[0], H.sub.rank); });
  op('zscore', CS, 'zscore(x)', 'Cross-sectional z-score: (x - mean) / std across stocks each day.', [P('x', 'm')],
    function (H, a) { return H.csApply(a[0], H.sub.zscore); });
  op('scale', CS, 'scale(x, scale=1, longscale=1, shortscale=1)',
    'Scale so that sum(|x|) = scale. Pass longscale/shortscale to scale the long and short sides separately.',
    [P('x', 'm'), P('scale', 'n', 1), P('longscale', 'n', 1), P('shortscale', 'n', 1)], function (H, a, named) {
      var split = !!(named && (named.longscale || named.shortscale));
      return H.csApply(a[0], H.sub.scale, { scale: a[1], longscale: a[2], shortscale: a[3], split: split });
    });
  op('normalize', CS, 'normalize(x, useStd=false, limit=0.0)', 'Subtract the cross-sectional mean; optionally divide by std and clip to ±limit.',
    [P('x', 'm'), P('useStd', 'b', false), P('limit', 'n', 0)],
    function (H, a) { return H.csApply(a[0], H.sub.normalize, { useStd: a[1], limit: a[2] }); });
  op('quantile', CS, 'quantile(x, driver=gaussian, sigma=1.0)', 'Rank, then map through the inverse CDF of driver (gaussian, uniform, cauchy), times sigma.',
    [P('x', 'm'), P('driver', 's', 'gaussian'), P('sigma', 'n', 1)],
    function (H, a) { return H.csApply(a[0], H.sub.quantile, { f: driverFn(a[1]), sigma: a[2] }); });
  op('winsorize', CS, 'winsorize(x, std=4)', 'Clip x to mean ± std standard deviations across stocks.', [P('x', 'm'), P('std', 'n', 4)],
    function (H, a) { return H.csApply(a[0], H.sub.winsorize, { std: a[1] }); });
  function csRegress(H, y, x, proj) {
    y = H.asM(y); x = H.asM(x);
    var N = H.N, T = H.T, o = H.nanM();
    for (var t = 0; t < T; t++) {
      var b = t * N, n = 0, mx = 0, my = 0, i;
      for (i = 0; i < N; i++) { var yv = y[b + i], xv = x[b + i]; if (yv === yv && xv === xv) { mx += xv; my += yv; n++; } }
      if (n < 2) continue;
      mx /= n; my /= n;
      var sxx = 0, sxy = 0;
      for (i = 0; i < N; i++) { var yy = y[b + i], xx = x[b + i]; if (yy === yy && xx === xx) { sxx += (xx - mx) * (xx - mx); sxy += (xx - mx) * (yy - my); } }
      var beta = sxx > 0 ? sxy / sxx : 0, alpha = my - beta * mx;
      for (i = 0; i < N; i++) {
        var y2 = y[b + i], x2 = x[b + i];
        if (y2 === y2 && x2 === x2) o[b + i] = proj ? alpha + beta * x2 : y2 - alpha - beta * x2;
      }
    }
    return o;
  }
  op('regression_neut', CS, 'regression_neut(y, x)', 'Residual of a cross-sectional regression of y on x (neutralizes y against x).',
    [P('y', 'm'), P('x', 'm')], function (H, a) { return csRegress(H, a[0], a[1], false); });
  op('regression_proj', CS, 'regression_proj(y, x)', 'Fitted value of a cross-sectional regression of y on x.',
    [P('y', 'm'), P('x', 'm')], function (H, a) { return csRegress(H, a[0], a[1], true); });
  op('vector_neut', CS, 'vector_neut(x, y)', 'x minus its projection onto y (no intercept), across stocks each day.', [P('x', 'm'), P('y', 'm')], function (H, a) {
    var x = H.asM(a[0]), y = H.asM(a[1]), N = H.N, T = H.T, o = H.nanM();
    for (var t = 0; t < T; t++) {
      var b = t * N, xy = 0, yy = 0, i;
      for (i = 0; i < N; i++) { var xv = x[b + i], yv = y[b + i]; if (xv === xv && yv === yv) { xy += xv * yv; yy += yv * yv; } }
      var k = yy > 0 ? xy / yy : 0;
      for (i = 0; i < N; i++) { var x2 = x[b + i], y2 = y[b + i]; if (x2 === x2 && y2 === y2) o[b + i] = x2 - k * y2; }
    }
    return o;
  });

  // ---- Group
  var G = 'Group';
  function gop(name, sig, desc, kernel, opts) {
    op(name, G, sig, desc, [P('x', 'm'), P('group', 'g')], function (H, a) { return H.groupApply(a[0], a[1], H.sub[kernel], opts); });
  }
  gop('group_neutralize', 'group_neutralize(x, group)', 'Subtract the group mean so each group (e.g. sector) nets to zero.', 'demean');
  gop('group_rank', 'group_rank(x, group)', 'Rank within each group, scaled to [0, 1].', 'rank');
  gop('group_zscore', 'group_zscore(x, group)', 'Z-score within each group.', 'zscore');
  gop('group_scale', 'group_scale(x, group)', 'Min-max scale within each group to [0, 1].', 'minmax');
  gop('group_sum', 'group_sum(x, group)', 'Sum of x within each group.', 'sum');
  gop('group_max', 'group_max(x, group)', 'Maximum of x within each group.', 'max');
  gop('group_min', 'group_min(x, group)', 'Minimum of x within each group.', 'min');
  gop('group_median', 'group_median(x, group)', 'Median of x within each group.', 'median');
  gop('group_count', 'group_count(x, group)', 'Number of valid values in each group.', 'count');
  gop('group_std_dev', 'group_std_dev(x, group)', 'Standard deviation of x within each group.', 'std');
  op('group_mean', G, 'group_mean(x, weight, group)', 'Weighted mean of x within each group. group_mean(x, group) uses equal weights.',
    [P('x', 'm'), P('weight', 'm'), P('group', 'g')], function (H, a) {
      var x = H.asM(a[0]), w = H.asM(a[1]), g = H.asM(a[2]);
      var N = H.N, T = H.T, o = H.nanM();
      for (var t = 0; t < T; t++) {
        var b = t * N, sums = new Map(), i;
        for (i = 0; i < N; i++) {
          var xv = x[b + i], wv = w[b + i], gv = g[b + i];
          if (xv === xv && wv === wv && gv === gv) {
            var e = sums.get(gv);
            if (!e) { e = [0, 0]; sums.set(gv, e); }
            e[0] += wv * xv; e[1] += wv;
          }
        }
        for (i = 0; i < N; i++) {
          var gg = g[b + i];
          if (gg === gg && x[b + i] === x[b + i]) { var s = sums.get(gg); if (s && s[1] !== 0) o[b + i] = s[0] / s[1]; }
        }
      }
      return o;
    }, { alt2: true });
  op('group_cartesian_product', G, 'group_cartesian_product(g1, g2)', 'Combine two groupings into one (every pair becomes its own group).',
    [P('g1', 'g'), P('g2', 'g')], function (H, a) { return H.map2(a[0], a[1], function (x, y) { return x !== x || y !== y ? NaN : x * 100003 + y; }); });
  op('bucket', G, 'bucket(x, range="0,1,0.1", buckets="", skipBegin=false, skipEnd=false, NaNGroup=false)',
    'Turn x into group codes. range="start,end,step" makes equal-width buckets; buckets="b1,b2,..." uses explicit boundaries. Typical: bucket(rank(cap), range="0,1,0.1").',
    [P('x', 'm'), P('range', 's', ''), P('buckets', 's', ''), P('skipBegin', 'b', false), P('skipEnd', 'b', false), P('skipBoth', 'b', false), P('NaNGroup', 'b', false)],
    function (H, a) {
      var bounds = [], k, sb = a[3] || a[5], se = a[4] || a[5], ng = a[6];
      if (a[2]) {
        bounds = String(a[2]).split(',').map(parseFloat).filter(function (v) { return v === v; }).sort(function (p, q) { return p - q; });
      } else {
        var r = String(a[1] || '0,1,0.1').split(',').map(parseFloat);
        if (r.length !== 3 || !(r[2] > 0) || !(r[1] > r[0])) throw new ExprError('bucket: range must be "start,end,step"');
        for (var v = r[0]; v <= r[1] + 1e-12; v += r[2]) bounds.push(v);
      }
      if (!bounds.length) throw new ExprError('bucket: no bucket boundaries given');
      var nb = bounds.length;
      return H.map1(a[0], function (x) {
        if (x !== x) return ng ? nb + 1 : NaN;
        if (x < bounds[0]) return sb ? NaN : 0;
        if (x >= bounds[nb - 1]) return se ? NaN : nb;
        for (k = 1; k < nb; k++) if (x < bounds[k]) return k;
        return nb;
      });
    });

  // ---- Transformational
  var TR = 'Transformational';
  op('trade_when', TR, 'trade_when(x, y, z)',
    'Event-driven trading: if z > 0 the position is closed (NaN); else if x > 0 take value y; otherwise hold yesterday\'s value. Use z = -1 to never exit.',
    [P('x', 'm'), P('y', 'm'), P('z', 'm')], function (H, a) {
      var x = a[0], y = a[1], z = a[2], N = H.N, T = H.T, o = H.nanM();
      var xm = H.isM(x), ym = H.isM(y), zm = H.isM(z);
      for (var i = 0; i < N; i++) {
        var prev = NaN;
        for (var t = 0; t < T; t++) {
          var k = t * N + i;
          var zv = zm ? z[k] : z, xv = xm ? x[k] : x;
          if (zv > 0) prev = NaN;
          else if (xv > 0) prev = ym ? y[k] : y;
          o[k] = prev;
        }
      }
      return o;
    });
  op('hump', TR, 'hump(x, hump=0.01)', 'Reduce turnover: only move each value toward x by at most hump × sum(|x|) per day, ignoring smaller changes.',
    [P('x', 'm'), P('hump', 'n', 0.01)], function (H, a) {
      var x = H.asM(a[0]), hp = a[1], N = H.N, T = H.T, o = H.nanM(), prev = new Float64Array(N).fill(NaN);
      for (var t = 0; t < T; t++) {
        var b = t * N, sa = 0, i;
        for (i = 0; i < N; i++) { var v = x[b + i]; if (v === v) sa += Math.abs(v); }
        var thr = hp * sa;
        for (i = 0; i < N; i++) {
          var cur = x[b + i], p = prev[i], out;
          if (cur !== cur) out = NaN;
          else if (p !== p) out = cur;
          else {
            var df = cur - p;
            out = Math.abs(df) > thr ? p + (df > 0 ? thr : -thr) : p;
          }
          o[b + i] = out; prev[i] = out;
        }
      }
      return o;
    });
  op('tail', TR, 'tail(x, lower=0, upper=0, newval=0)', 'Replace values strictly between lower and upper with newval.',
    [P('x', 'm'), P('lower', 'n', 0), P('upper', 'n', 0), P('newval', 'n', 0)],
    function (H, a) { var lo = a[1], hi = a[2], nv = a[3]; return H.map1(a[0], function (x) { return x > lo && x < hi ? nv : x; }); });
  op('left_tail', TR, 'left_tail(x, maximum=0)', 'NaN everything above maximum.', [P('x', 'm'), P('maximum', 'n', 0)],
    function (H, a) { var m = a[1]; return H.map1(a[0], function (x) { return x > m ? NaN : x; }); });
  op('right_tail', TR, 'right_tail(x, minimum=0)', 'NaN everything below minimum.', [P('x', 'm'), P('minimum', 'n', 0)],
    function (H, a) { var m = a[1]; return H.map1(a[0], function (x) { return x < m ? NaN : x; }); });
  op('pasteurize', TR, 'pasteurize(x)', 'Set values outside the simulation universe to NaN.', [P('x', 'm')],
    function (H, a) { var u = H.universe; return H.map2(a[0], u, function (x, m) { return m ? x : NaN; }); });

  // ----------------------------------------------------------- evaluation
  var CONSTANTS = { 'true': 1, 'false': 0, 'nan': NaN, 'NaN': NaN, 'pi': Math.PI };

  function levenshtein(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[m][n];
  }
  function suggest(name, candidates) {
    var best = null, bd = 1e9;
    candidates.forEach(function (c) { var dd = levenshtein(name, c); if (dd < bd) { bd = dd; best = c; } });
    return best && bd <= Math.max(2, Math.floor(name.length / 3)) ? " Did you mean '" + best + "'?" : '';
  }

  // Bind call arguments to an operator's parameter spec. Returns array of AST nodes / defaults.
  function bindArgs(spec, node) {
    var pos = node.args.slice(), named = node.named || {}, out = [], q;
    if (spec.variadic) {
      if (pos.length < spec.variadic) err(spec.name + ' needs at least ' + spec.variadic + ' inputs', node);
      out.push(pos);
      for (q = 0; q < spec.params.length; q++) {
        var pp = spec.params[q];
        out.push(named[pp.n] !== undefined ? named[pp.n] : { t: 'default', v: pp.d });
      }
      for (var nk in named) {
        if (!spec.params.some(function (x) { return x.n === nk; })) err(spec.name + " has no parameter '" + nk + "'", node);
      }
      return out;
    }
    if (spec.alt2 && pos.length === 2 && named.weight === undefined && named.group === undefined) {
      pos = [pos[0], { t: 'num', v: 1, line: node.line, col: node.col }, pos[1]];
    }
    if (pos.length > spec.params.length) {
      err(spec.name + ' takes at most ' + spec.params.length + ' arguments but got ' + pos.length + '. Usage: ' + spec.sig, node);
    }
    for (var key in named) {
      if (!spec.params.some(function (x) { return x.n === key; })) {
        err(spec.name + " has no parameter '" + key + "'. Usage: " + spec.sig, node);
      }
    }
    for (q = 0; q < spec.params.length; q++) {
      var p = spec.params[q];
      var a = q < pos.length ? pos[q] : named[p.n];
      if (q < pos.length && named[p.n] !== undefined) err(spec.name + ": parameter '" + p.n + "' given twice", node);
      if (a === undefined) {
        if (p.d === undefined) err(spec.name + " is missing argument '" + p.n + "'. Usage: " + spec.sig, node);
        a = { t: 'default', v: p.d };
      }
      out.push(a);
    }
    return out;
  }

  function constFold(node) {
    switch (node.t) {
      case 'num': return node.v;
      case 'default': return node.v;
      case 'un': { var v = constFold(node.a); if (v === undefined) return undefined; return node.op === '-' ? -v : node.op === '!' ? (v ? 0 : 1) : v; }
      case 'bin': {
        var a = constFold(node.a), b = constFold(node.b);
        if (a === undefined || b === undefined) return undefined;
        switch (node.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return a / b; case '^': return Math.pow(a, b);
          default: return undefined;
        }
      }
      case 'id': return CONSTANTS.hasOwnProperty(node.name) ? CONSTANTS[node.name] : undefined;
      default: return undefined;
    }
  }

  function argString(node) {
    if (node.t === 'str' || node.t === 'default') return node.v;
    if (node.t === 'id') return node.name;
    if (node.t === 'num') return String(node.v);
    return undefined;
  }
  function argBool(node) {
    if (node.t === 'default') return !!node.v;
    if (node.t === 'id') {
      if (node.name === 'true' || node.name === 'True') return true;
      if (node.name === 'false' || node.name === 'False') return false;
    }
    if (node.t === 'str') return node.v.toLowerCase() === 'true';
    var v = constFold(node);
    if (v === undefined) err('Expected true or false', node);
    return !!v;
  }

  /**
   * Static validation (no data needed). env = { fields: [...names], groups: [...names] }
   * Returns { ok, error, line, col, usedFields }
   */
  function validate(src, env) {
    var fields = (env && env.fields) || [], groups = (env && env.groups) || [];
    var used = {};
    try {
      var prog = parse(src);
      var vars = {};
      var walk = function (node) {
        switch (node.t) {
          case 'num': case 'str': case 'default': return;
          case 'id':
            if (vars[node.name] || CONSTANTS.hasOwnProperty(node.name)) return;
            if (fields.indexOf(node.name) >= 0 || groups.indexOf(node.name) >= 0) { used[node.name] = 1; return; }
            if (OPS[node.name]) err("'" + node.name + "' is an operator — call it like " + OPS[node.name].sig, node);
            err("Unknown data field or variable '" + node.name + "'." + suggest(node.name, fields.concat(groups, Object.keys(vars))), node);
            return;
          case 'un': walk(node.a); return;
          case 'bin': walk(node.a); walk(node.b); return;
          case 'tern': walk(node.c); walk(node.a); walk(node.b); return;
          case 'call': {
            var spec = OPS[node.name];
            if (!spec) {
              if (fields.indexOf(node.name) >= 0) err("'" + node.name + "' is a data field, not an operator", node);
              err("Unknown operator '" + node.name + "'." + suggest(node.name, Object.keys(OPS)), node);
            }
            var bound = bindArgs(spec, node);
            if (spec.variadic) {
              bound[0].forEach(walk);
              return;
            }
            spec.params.forEach(function (p, q) {
              var a = bound[q];
              if (a.t === 'default') return;
              if (p.k === 's') { if (argString(a) === undefined) err(spec.name + ": '" + p.n + "' must be a text value", a); return; }
              if (p.k === 'b') { argBool(a); return; }
              if (p.k === 'n') {
                if (constFold(a) === undefined) err(spec.name + ": '" + p.n + "' must be a constant number (e.g. 20)", a);
                return;
              }
              walk(a);
            });
            return;
          }
          default: return;
        }
      };
      prog.stmts.forEach(function (st) {
        if (st.t === 'assign') {
          if (OPS[st.name]) err("Cannot use operator name '" + st.name + "' as a variable", st);
          walk(st.expr);
          vars[st.name] = 1;
        } else walk(st);
      });
      return { ok: true, usedFields: Object.keys(used), statements: prog.stmts.length };
    } catch (e) {
      if (e instanceof ExprError) return { ok: false, error: e.message, line: e.line, col: e.col, usedFields: Object.keys(used) };
      throw e;
    }
  }

  function evaluateProgram(prog, ctx) {
    var H = makeKernel(ctx.T, ctx.N, ctx.nanOn);
    H.universe = ctx.universeMat;
    var env = Object.create(null);
    var steps = 0;

    function resolveId(node) {
      var nm = node.name;
      if (nm in env) return env[nm];
      if (CONSTANTS.hasOwnProperty(nm)) return CONSTANTS[nm];
      var f = ctx.field(nm);
      if (f) return f;
      var g = ctx.group(nm);
      if (g) return g;
      if (OPS[nm]) err("'" + nm + "' is an operator — call it like " + OPS[nm].sig, node);
      err("Unknown data field or variable '" + nm + "'." + suggest(nm, ctx.fieldNames.concat(ctx.groupNames, Object.keys(env))), node);
    }

    var BIN = {
      '+': function (x, y) { return x + y; },
      '-': function (x, y) { return x - y; },
      '*': function (x, y) { return x * y; },
      '/': function (x, y) { return y === 0 ? NaN : x / y; },
      '^': function (x, y) { return fin(Math.pow(x, y)); },
      '<': function (x, y) { return x !== x || y !== y ? NaN : x < y ? 1 : 0; },
      '<=': function (x, y) { return x !== x || y !== y ? NaN : x <= y ? 1 : 0; },
      '>': function (x, y) { return x !== x || y !== y ? NaN : x > y ? 1 : 0; },
      '>=': function (x, y) { return x !== x || y !== y ? NaN : x >= y ? 1 : 0; },
      '==': function (x, y) { return x !== x || y !== y ? NaN : x === y ? 1 : 0; },
      '!=': function (x, y) { return x !== x || y !== y ? NaN : x !== y ? 1 : 0; },
      '&&': function (x, y) { return x !== x || y !== y ? NaN : (x && y) ? 1 : 0; },
      '||': function (x, y) { return x !== x || y !== y ? NaN : (x || y) ? 1 : 0; }
    };

    function ev(node) {
      steps++;
      switch (node.t) {
        case 'num': return node.v;
        case 'default': return node.v;
        case 'str': err('Text values are only allowed as operator options', node); break;
        case 'id': return resolveId(node);
        case 'un': {
          var v = ev(node.a);
          if (node.op === '-') return H.map1(v, function (x) { return -x; });
          if (node.op === '!') return H.map1(v, function (x) { return x !== x ? NaN : x ? 0 : 1; });
          return v;
        }
        case 'bin': return H.map2(ev(node.a), ev(node.b), BIN[node.op]);
        case 'tern': return H.map3(ev(node.c), ev(node.a), ev(node.b), function (c, x, y) { return c !== c ? NaN : c ? x : y; });
        case 'call': return call(node);
      }
      err('Cannot evaluate expression', node);
    }

    function call(node) {
      var spec = OPS[node.name];
      if (!spec) err("Unknown operator '" + node.name + "'." + suggest(node.name, Object.keys(OPS)), node);
      var bound = bindArgs(spec, node);
      var vals = [];
      if (spec.variadic) {
        vals.push(bound[0].map(ev));
        spec.params.forEach(function (p, q) { vals.push(conv(spec, p, bound[q + 1])); });
      } else {
        spec.params.forEach(function (p, q) { vals.push(conv(spec, p, bound[q])); });
      }
      try {
        return spec.fn(H, vals, node.named);
      } catch (e) {
        if (e instanceof ExprError && !e.line) { e.message = node.name + ': ' + e.message; e.line = node.line; e.col = node.col; }
        throw e;
      }
    }

    function conv(spec, p, a) {
      if (a.t === 'default') return a.v;
      switch (p.k) {
        case 's': {
          var s = argString(a);
          if (s === undefined) err(spec.name + ": '" + p.n + "' must be a text value", a);
          return s;
        }
        case 'b': return argBool(a);
        case 'n': {
          var c = constFold(a);
          if (c === undefined) {
            var v = ev(a);
            if (typeof v !== 'number') err(spec.name + ": '" + p.n + "' must be a constant number (e.g. 20), not a data series", a);
            c = v;
          }
          return c;
        }
        case 'g': {
          if (a.t === 'id' && !(a.name in env)) {
            var g = ctx.group(a.name);
            if (g) return g;
          }
          return ev(a);
        }
        default: return ev(a);
      }
    }

    var last;
    prog.stmts.forEach(function (st) {
      if (st.t === 'assign') { env[st.name] = ev(st.expr); last = env[st.name]; } else last = ev(st);
    });
    return { value: last, steps: steps };
  }

  // ----------------------------------------------------------- universes
  function universeSize(name, N) {
    var m = /(\d+)/.exec(String(name));
    var k = m ? parseInt(m[1], 10) : N;
    return Math.min(k, N);
  }
  function listUniverses(ds) {
    var sizes = [3000, 2000, 1000, 500, 300, 200, 100, 50, 20];
    var out = [];
    if (sizes.indexOf(ds.N) < 0) out.push('TOP' + ds.N);
    sizes.forEach(function (s) { if (s <= ds.N && s >= Math.min(20, ds.N)) out.push('TOP' + s); });
    return out;
  }
  // Liquidity-ranked universe, re-constituted every 21 trading days.
  function getUniverse(ds, name) {
    ds._uni = ds._uni || {};
    if (ds._uni[name]) return ds._uni[name];
    var T = ds.T, N = ds.N, K = universeSize(name, N);
    var close = ds.fields.close, vol = ds.fields.volume;
    var dv = new Float64Array(T * N);
    var i, t;
    for (i = 0; i < N; i++) {
      var s = 0, c = 0;
      for (t = 0; t < T; t++) {
        var k = t * N + i, v = close[k] * vol[k];
        if (v === v) { s += v; c++; }
        if (t >= 20) { var k2 = (t - 20) * N + i, v2 = close[k2] * vol[k2]; if (v2 === v2) { s -= v2; c--; } }
        dv[k] = c > 0 ? s / c : NaN;
      }
    }
    var u = new Uint8Array(T * N), members = new Uint8Array(N);
    for (t = 0; t < T; t++) {
      if (t % 21 === 0) {
        var arr = [];
        for (i = 0; i < N; i++) { var d = dv[t * N + i]; if (d === d && d > 0) arr.push(i); }
        arr.sort(function (a, b) { return dv[t * N + b] - dv[t * N + a]; });
        members.fill(0);
        for (var q = 0; q < Math.min(K, arr.length); q++) members[arr[q]] = 1;
      }
      for (i = 0; i < N; i++) {
        var cv = close[t * N + i];
        u[t * N + i] = members[i] && cv === cv ? 1 : 0;
      }
    }
    ds._uni[name] = u;
    return u;
  }

  // ------------------------------------------------------------ simulation
  var DEFAULTS = {
    universe: null, delay: 1, decay: 0, neutralization: 'subindustry', truncation: 0.08,
    pasteurization: true, nanHandling: false, testPeriod: 0
  };

  function groupCodes(ds, mode) {
    var N = ds.N, codes = new Int32Array(N);
    mode = String(mode || 'none').toLowerCase();
    if (mode === 'none') return null;
    if (mode === 'market') return codes;
    var g = ds.groups[mode];
    if (!g) g = ds.groups.industry || ds.groups.sector;
    if (!g) return codes;
    for (var i = 0; i < N; i++) codes[i] = g.codes[i];
    return codes;
  }

  function buildPositions(ds, alpha, uni, S) {
    var T = ds.T, N = ds.N, close = ds.fields.close, ret = ds.fields.returns;
    var delay = S.delay | 0, decay = Math.max(0, S.decay | 0), trunc = +S.truncation || 0;
    var codes = groupCodes(ds, S.neutralization);
    var W = new Float64Array(T * N);
    var hist = [], x = new Float64Array(N);
    var pnl = new Float64Array(T), traded = new Float64Array(T), tvr = new Float64Array(T);
    var longC = new Float64Array(T), shortC = new Float64Array(T), gross = new Float64Array(T);
    var maxW = 0, i, t, k;
    var gsum = codes ? new Map() : null;
    for (t = 0; t < T; t++) {
      var st = t - delay;
      if (st < 0) continue;
      var sig = new Float64Array(N);
      for (i = 0; i < N; i++) {
        var v = alpha[st * N + i];
        var ok = uni[st * N + i] && close[t * N + i] === close[t * N + i];
        sig[i] = ok && v === v && v !== Infinity && v !== -Infinity ? v : NaN;
        if (!ok) sig[i] = NaN;
        x[i] = ok ? 1 : 0; // temp: membership flag
      }
      var cur;
      if (decay > 1) {
        hist.push(sig);
        if (hist.length > decay) hist.shift();
        cur = new Float64Array(N);
        var L = hist.length;
        for (i = 0; i < N; i++) {
          if (!x[i]) { cur[i] = NaN; continue; }
          var num = 0, den = 0;
          for (k = 0; k < L; k++) {
            var hv = hist[k][i];
            if (hv === hv) { var w = decay - (L - 1 - k); num += w * hv; den += w; }
          }
          cur[i] = den > 0 ? num / den : NaN;
        }
      } else cur = sig;
      // neutralize
      if (codes) {
        gsum.clear();
        for (i = 0; i < N; i++) {
          if (cur[i] === cur[i]) {
            var e = gsum.get(codes[i]);
            if (!e) { e = [0, 0]; gsum.set(codes[i], e); }
            e[0] += cur[i]; e[1]++;
          }
        }
        for (i = 0; i < N; i++) if (cur[i] === cur[i]) { var ge = gsum.get(codes[i]); cur[i] -= ge[0] / ge[1]; }
      }
      // scale to book
      var sa = 0;
      for (i = 0; i < N; i++) if (cur[i] === cur[i]) sa += Math.abs(cur[i]);
      if (!(sa > 1e-15)) continue;
      for (i = 0; i < N; i++) cur[i] = cur[i] === cur[i] ? cur[i] / sa : 0;
      // truncation
      if (trunc > 0 && trunc < 1) {
        for (var it = 0; it < 20; it++) {
          var clipped = false;
          sa = 0;
          for (i = 0; i < N; i++) {
            if (cur[i] > trunc) { cur[i] = trunc; clipped = true; } else if (cur[i] < -trunc) { cur[i] = -trunc; clipped = true; }
            sa += Math.abs(cur[i]);
          }
          if (!clipped || sa <= 0) break;
          for (i = 0; i < N; i++) cur[i] /= sa;
        }
        // final hard cap (only bites when there are too few names to honour the cap)
        for (i = 0; i < N; i++) { if (cur[i] > trunc) cur[i] = trunc; else if (cur[i] < -trunc) cur[i] = -trunc; }
      }
      var b = t * N, lc = 0, sc = 0, g = 0;
      for (i = 0; i < N; i++) {
        var wv = cur[i];
        W[b + i] = wv;
        if (wv > 0) lc++; else if (wv < 0) sc++;
        var aw = Math.abs(wv);
        g += aw;
        if (aw > maxW) maxW = aw;
      }
      longC[t] = lc; shortC[t] = sc; gross[t] = g;
    }
    // pnl & turnover
    for (t = 1; t < T; t++) {
      var bp = (t - 1) * N, bc = t * N, p = 0, tr = 0;
      for (i = 0; i < N; i++) {
        var w0 = W[bp + i];
        if (w0 !== 0) { var r = ret[bc + i]; if (r === r) p += w0 * r; }
        tr += Math.abs(W[bc + i] - w0);
      }
      pnl[t] = p * BOOKSIZE;
      traded[t] = tr * BOOKSIZE;
      tvr[t] = gross[t] > 0 ? tr / gross[t] : 0;
    }
    return { W: W, pnl: pnl, traded: traded, tvr: tvr, longC: longC, shortC: shortC, gross: gross, maxW: maxW };
  }

  function computeStats(pos, a, b) {
    var n = b - a + 1;
    if (n <= 1) return null;
    var s = 0, s2 = 0, tot = 0, tr = 0, tv = 0, lc = 0, sc = 0, t;
    var cum = 0, peak = 0, mdd = 0, active = 0;
    for (t = a; t <= b; t++) {
      var p = pos.pnl[t];
      s += p; s2 += p * p; tot += p; tr += pos.traded[t]; tv += pos.tvr[t];
      lc += pos.longC[t]; sc += pos.shortC[t];
      if (pos.gross[t] > 0) active++;
      cum += p;
      if (cum > peak) peak = cum;
      if (peak - cum > mdd) mdd = peak - cum;
    }
    var mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    var sharpe = sd > 0 ? mean / sd * Math.sqrt(DAYS_PER_YEAR) : 0;
    var returns = mean * DAYS_PER_YEAR / (BOOKSIZE / 2);
    var turnover = tv / n;
    var fitness = sharpe * Math.sqrt(Math.abs(returns) / Math.max(turnover, 0.125));
    return {
      sharpe: sharpe, returns: returns, turnover: turnover, fitness: fitness,
      drawdown: mdd / (BOOKSIZE / 2), margin: tr > 0 ? tot / tr : 0, pnl: tot,
      longCount: lc / n, shortCount: sc / n, days: n, activeDays: active
    };
  }

  function simulate(ds, src, settings) {
    var t0 = Date.now();
    var S = {};
    for (var key in DEFAULTS) S[key] = DEFAULTS[key];
    for (key in settings || {}) if (settings[key] !== undefined) S[key] = settings[key];
    if (!S.universe) S.universe = listUniverses(ds)[0];
    var prog = parse(src);
    var T = ds.T, N = ds.N, SIZE = T * N;
    var uni = getUniverse(ds, S.universe);
    var uniMat = new Float64Array(SIZE);
    for (var k = 0; k < SIZE; k++) uniMat[k] = uni[k];
    var fieldCache = {}, groupCache = {};
    var ctx = {
      T: T, N: N, nanOn: !!S.nanHandling, universeMat: uniMat,
      fieldNames: Object.keys(ds.fields), groupNames: Object.keys(ds.groups).concat(['market']),
      field: function (name) {
        if (!Object.prototype.hasOwnProperty.call(ds.fields, name)) return null;
        if (fieldCache[name]) return fieldCache[name];
        var srcF = ds.fields[name], m = new Float64Array(SIZE);
        if (S.pasteurization) { for (var q = 0; q < SIZE; q++) m[q] = uni[q] ? srcF[q] : NaN; }
        else m.set(srcF);
        fieldCache[name] = m;
        return m;
      },
      group: function (name) {
        if (groupCache[name]) return groupCache[name];
        var m = new Float64Array(SIZE);
        if (name === 'market') { /* zeros */ } else if (ds.groups[name]) {
          var codes = ds.groups[name].codes;
          for (var t = 0; t < T; t++) for (var i = 0; i < N; i++) m[t * N + i] = codes[i] < 0 ? NaN : codes[i];
        } else return null;
        if (S.pasteurization) for (var q = 0; q < SIZE; q++) if (!uni[q]) m[q] = NaN;
        groupCache[name] = m;
        return m;
      }
    };
    var tEval0 = Date.now();
    var res = evaluateProgram(prog, ctx);
    var alpha = res.value;
    if (typeof alpha === 'number') {
      throw new ExprError('The expression evaluates to a single constant (' + alpha + '). An alpha must give different values to different stocks — try rank(...) of a data field.');
    }
    var tEval = Date.now() - tEval0;

    var pos = buildPositions(ds, alpha, uni, S);
    var simStart = Math.max(ds.simStart || 0, (S.delay | 0) + 1);
    var simEnd = T - 1;
    var osDays = Math.round((+S.testPeriod || 0) * DAYS_PER_YEAR);
    var isEnd = osDays > 0 ? Math.max(simStart + 20, simEnd - osDays) : simEnd;
    var isStats = computeStats(pos, simStart, isEnd);
    var osStats = isEnd < simEnd ? computeStats(pos, isEnd + 1, simEnd) : null;

    // yearly
    var yearly = [], y0 = simStart;
    for (var t = simStart; t <= simEnd + 1; t++) {
      var yr = t <= simEnd ? ds.dates[t].slice(0, 4) : null;
      if (t > y0 && (t > simEnd || yr !== ds.dates[y0].slice(0, 4))) {
        var st = computeStats(pos, y0, t - 1);
        if (st) { st.year = ds.dates[y0].slice(0, 4); yearly.push(st); }
        y0 = t;
      }
    }

    // coverage: how many universe stocks got a position on average
    var uniCount = 0, uniDays = 0;
    for (t = simStart; t <= simEnd; t++) { var c = 0; for (var i = 0; i < N; i++) c += uni[t * N + i]; uniCount += c; uniDays++; }
    var avgUni = uniDays ? uniCount / uniDays : 0;

    // sub-universe test
    var unis = listUniverses(ds), K = universeSize(S.universe, N), subName = null;
    for (var q = 0; q < unis.length; q++) { var kq = universeSize(unis[q], N); if (kq < K && kq >= Math.min(K, 50) * 0.3) { subName = unis[q]; break; } }
    var subSharpe = null, subLimit = null;
    if (subName && isStats) {
      var subPos = buildPositions(ds, alpha, getUniverse(ds, subName), S);
      var ss = computeStats(subPos, simStart, isEnd);
      subSharpe = ss ? ss.sharpe : 0;
      subLimit = 0.75 * Math.sqrt(universeSize(subName, N) / K) * isStats.sharpe;
    }

    var d0 = (S.delay | 0) === 0;
    var checks = [];
    function chk(name, pass, value, limit, msg) { checks.push({ name: name, result: pass ? 'PASS' : 'FAIL', value: value, limit: limit, message: msg }); }
    if (isStats) {
      var shL = d0 ? 2.0 : 1.25, fiL = d0 ? 1.3 : 1.0;
      chk('LOW_SHARPE', isStats.sharpe >= shL, isStats.sharpe, shL, 'Sharpe of ' + isStats.sharpe.toFixed(2) + (isStats.sharpe >= shL ? ' is above' : ' is below') + ' cutoff of ' + shL);
      chk('LOW_FITNESS', isStats.fitness >= fiL, isStats.fitness, fiL, 'Fitness of ' + isStats.fitness.toFixed(2) + (isStats.fitness >= fiL ? ' is above' : ' is below') + ' cutoff of ' + fiL);
      chk('LOW_TURNOVER', isStats.turnover >= 0.01, isStats.turnover, 0.01, 'Turnover of ' + (isStats.turnover * 100).toFixed(2) + '%' + (isStats.turnover >= 0.01 ? ' is above' : ' is below') + ' cutoff of 1%');
      chk('HIGH_TURNOVER', isStats.turnover <= 0.7, isStats.turnover, 0.7, 'Turnover of ' + (isStats.turnover * 100).toFixed(2) + '%' + (isStats.turnover <= 0.7 ? ' is below' : ' is above') + ' cutoff of 70%');
      chk('CONCENTRATED_WEIGHT', pos.maxW <= 0.1 + 1e-9, pos.maxW, 0.1, 'Max weight in a single stock is ' + (pos.maxW * 100).toFixed(1) + '% of book' + (pos.maxW <= 0.1 + 1e-9 ? ' (limit 10%)' : ' — above the 10% limit'));
      if (subSharpe !== null) {
        chk('LOW_SUB_UNIVERSE_SHARPE', subSharpe >= subLimit, subSharpe, subLimit, 'Sub-universe (' + subName + ') Sharpe of ' + subSharpe.toFixed(2) + (subSharpe >= subLimit ? ' is above' : ' is below') + ' cutoff of ' + subLimit.toFixed(2));
      }
    }

    // output series over sim window
    var dates = [], pnlArr = [], tvrArr = [], lcArr = [], scArr = [];
    for (t = simStart; t <= simEnd; t++) {
      dates.push(ds.dates[t]);
      pnlArr.push(Math.round(pos.pnl[t]));
      tvrArr.push(+pos.tvr[t].toFixed(5));
      lcArr.push(pos.longC[t]);
      scArr.push(pos.shortC[t]);
    }
    // last-day top positions
    var lastT = simEnd, top = [];
    for (i = 0; i < N; i++) { var wv = pos.W[lastT * N + i]; if (wv !== 0) top.push([i, wv]); }
    top.sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); });
    top = top.slice(0, 12).map(function (e) { return { ticker: ds.tickers[e[0]], weight: e[1], sector: ds.groups.sector ? ds.groups.sector.names[ds.groups.sector.codes[e[0]]] : '' }; });

    return {
      expression: src, settings: S, dataset: { id: ds.id, name: ds.name, N: N, T: T },
      dates: dates, pnl: pnlArr, turnover: tvrArr, longCount: lcArr, shortCount: scArr,
      isEndIndex: isEnd - simStart,
      summary: isStats, os: osStats, yearly: yearly, checks: checks,
      maxWeight: pos.maxW, avgUniverse: avgUni, topPositions: top, subUniverse: subName, subSharpe: subSharpe,
      timing: { evalMs: tEval, totalMs: Date.now() - t0, steps: res.steps },
      booksize: BOOKSIZE, createdAt: new Date().toISOString()
    };
  }

  // ----------------------------------------------------------- utilities
  function correlation(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 20) return NaN;
    var oa = a.length - n, ob = b.length - n, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[oa + i]; mb += b[ob + i]; }
    ma /= n; mb /= n;
    var saa = 0, sbb = 0, sab = 0;
    for (i = 0; i < n; i++) { var x = a[oa + i] - ma, y = b[ob + i] - mb; saa += x * x; sbb += y * y; sab += x * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  }
  function rollingSharpe(pnl, w) {
    var out = [], s = 0, s2 = 0;
    for (var i = 0; i < pnl.length; i++) {
      s += pnl[i]; s2 += pnl[i] * pnl[i];
      if (i >= w) { s -= pnl[i - w]; s2 -= pnl[i - w] * pnl[i - w]; }
      if (i >= w - 1) {
        var m = s / w, sd = Math.sqrt(Math.max(0, s2 / w - m * m));
        out.push(sd > 0 ? m / sd * Math.sqrt(DAYS_PER_YEAR) : 0);
      } else out.push(NaN);
    }
    return out;
  }
  function operatorList() {
    return Object.keys(OPS).map(function (k) { var o = OPS[k]; return { name: o.name, cat: o.cat, sig: o.sig, desc: o.desc }; });
  }

  return {
    parse: parse, tokenize: tokenize, validate: validate, simulate: simulate,
    evaluateProgram: evaluateProgram, getUniverse: getUniverse, listUniverses: listUniverses,
    correlation: correlation, rollingSharpe: rollingSharpe, operatorList: operatorList,
    OPS: OPS, ExprError: ExprError, BOOKSIZE: BOOKSIZE, DEFAULTS: DEFAULTS
  };
});
