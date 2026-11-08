/* BrainSim charts: ink-on-graph-paper line charts with touch scrubbing, plus sparklines. */
(function (root) {
  'use strict';
  var C = {
    sheet: '#FCFDFE', minor: '#E6EEF4', major: '#C6D5E1', ink: '#1C2A43', pencil: '#5F6C7B',
    blue: '#2152A3', red: '#C0392F', hatch: 'rgba(192,57,47,0.10)', zero: '#8D98A5'
  };
  var FONT = "'LM Sans', Roboto, sans-serif";

  function niceStep(range, count) {
    var raw = range / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  function line(container, opt) {
    container.innerHTML = '';
    var cv = document.createElement('canvas');
    var tip = document.createElement('div');
    tip.className = 'chart-tip hidden';
    container.appendChild(cv);
    container.appendChild(tip);
    var dpr = Math.max(1, Math.min(3, root.devicePixelRatio || 1));
    var W = container.clientWidth || 340, Hh = container.clientHeight || 230;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    var labels = opt.labels, n = labels.length, series = opt.series;
    var padL = 10, padR = 54, padT = 16, padB = 26;
    var pw = W - padL - padR, ph = Hh - padT - padB;
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
      for (var k = 0; k < s.values.length; k++) { var v = s.values[k]; if (v === v && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    });
    if (opt.zero !== false) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!(hi > lo)) { hi = (lo === lo && isFinite(lo) ? lo : 0) + 1; lo = hi - 2; }
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var fmt = opt.yFmt || String;
    ctx.font = '12px ' + FONT;
    var maxLab = 0;
    for (var tv = lo; tv <= hi + step * 0.001; tv += step) maxLab = Math.max(maxLab, ctx.measureText(fmt(Math.abs(tv) < step * 1e-6 ? 0 : tv)).width);
    padR = Math.ceil(maxLab) + 12;
    pw = W - padL - padR;
    function X(i) { return padL + (n > 1 ? i / (n - 1) : 0.5) * pw; }
    function Y(v) { return padT + (1 - (v - lo) / (hi - lo)) * ph; }

    var base = document.createElement('canvas');
    base.width = cv.width; base.height = cv.height;
    var b = base.getContext('2d');
    b.scale(dpr, dpr);
    // paper + minor grid
    b.fillStyle = C.sheet; b.fillRect(0, 0, W, Hh);
    b.strokeStyle = C.minor; b.lineWidth = 1;
    b.beginPath();
    for (var gx = 0.5; gx < W; gx += 12) { b.moveTo(gx, 0); b.lineTo(gx, Hh); }
    for (var gy = 0.5; gy < Hh; gy += 12) { b.moveTo(0, gy); b.lineTo(W, gy); }
    b.stroke();
    // test-period hatch
    if (opt.shadeFrom !== null && opt.shadeFrom !== undefined && opt.shadeFrom < n - 1) {
      var sx = X(opt.shadeFrom);
      b.save();
      b.beginPath(); b.rect(sx, padT, padL + pw - sx, ph); b.clip();
      b.fillStyle = C.hatch; b.fillRect(sx, padT, padL + pw - sx, ph);
      b.strokeStyle = 'rgba(192,57,47,0.22)';
      b.beginPath();
      for (var hx = sx - ph; hx < padL + pw; hx += 8) { b.moveTo(hx, padT + ph); b.lineTo(hx + ph, padT); }
      b.stroke();
      b.restore();
      b.fillStyle = C.red; b.font = '12px ' + FONT; b.textAlign = 'left';
      var lab = opt.shadeLabel || 'Test period', room = padL + pw - sx - 8;
      if (b.measureText(lab).width > room) lab = 'Test';
      if (b.measureText(lab).width <= room) b.fillText(lab, sx + 4, padT + 12);
    }
    // y ticks (major grid)
    b.font = '12px ' + FONT; b.fillStyle = C.pencil; b.textAlign = 'left'; b.textBaseline = 'middle';
    for (var v = lo; v <= hi + step * 0.001; v += step) {
      var yy = Math.round(Y(v)) + 0.5;
      b.strokeStyle = Math.abs(v) < step * 1e-6 ? C.zero : C.major;
      b.lineWidth = Math.abs(v) < step * 1e-6 ? 1.2 : 1;
      b.beginPath(); b.moveTo(padL, yy); b.lineTo(padL + pw, yy); b.stroke();
      b.fillText(fmt(Math.abs(v) < step * 1e-6 ? 0 : v), padL + pw + 6, yy);
    }
    // x ticks: first trading day of each year (or month for short spans)
    b.textAlign = 'center'; b.textBaseline = 'alphabetic';
    var byYear = n > 300, lastKey = null, lastX = -1e9;
    for (var i = 0; i < n; i++) {
      var key = byYear ? labels[i].slice(0, 4) : labels[i].slice(0, 7);
      if (key !== lastKey) {
        if (lastKey !== null) {
          var xx = Math.round(X(i)) + 0.5;
          b.strokeStyle = C.major; b.lineWidth = 1;
          b.beginPath(); b.moveTo(xx, padT); b.lineTo(xx, padT + ph); b.stroke();
          if (xx - lastX > 34 && xx < padL + pw - 10) {
            b.fillStyle = C.pencil;
            b.fillText(byYear ? key : key.slice(5) + '/' + key.slice(2, 4), xx, Hh - 8);
            lastX = xx;
          }
        }
        lastKey = key;
      }
    }
    // series
    series.forEach(function (s) {
      b.strokeStyle = s.color || C.blue; b.lineWidth = s.width || 1.8; b.lineJoin = 'round'; b.lineCap = 'round';
      if (s.dash) b.setLineDash(s.dash); else b.setLineDash([]);
      b.beginPath();
      var pen = false;
      for (var k = 0; k < s.values.length; k++) {
        var val = s.values[k];
        if (!(val === val) || !isFinite(val)) { pen = false; continue; }
        var px = X(k), py = Y(val);
        if (!pen) { b.moveTo(px, py); pen = true; } else b.lineTo(px, py);
      }
      b.stroke();
    });
    b.setLineDash([]);
    ctx.drawImage(base, 0, 0, W, Hh);

    // scrubbing
    var hideTimer = null;
    function show(clientX) {
      var r = cv.getBoundingClientRect();
      var x = clientX - r.left;
      var i = Math.round((x - padL) / pw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      ctx.clearRect(0, 0, W, Hh);
      ctx.drawImage(base, 0, 0, W, Hh);
      var cx = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + ph); ctx.stroke();
      ctx.setLineDash([]);
      var rows = [];
      series.forEach(function (s) {
        var val = s.values[i];
        if (val === val && isFinite(val)) {
          ctx.fillStyle = C.sheet; ctx.strokeStyle = s.color || C.blue; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, Y(val), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        rows.push((series.length > 1 ? s.name + ' ' : '') + '<b>' + (val === val ? (opt.tipFmt || opt.yFmt || String)(val) : '–') + '</b>');
      });
      tip.innerHTML = (opt.xFmt ? opt.xFmt(labels[i]) : labels[i]) + '<br>' + rows.join('<br>');
      tip.classList.remove('hidden');
      var tw = tip.offsetWidth;
      tip.style.left = (cx + 12 + tw > W ? cx - 12 - tw : cx + 12) + 'px';
    }
    function hide() {
      tip.classList.add('hidden');
      ctx.clearRect(0, 0, W, Hh);
      ctx.drawImage(base, 0, 0, W, Hh);
    }
    cv.addEventListener('pointerdown', function (e) { clearTimeout(hideTimer); show(e.clientX); });
    cv.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) { clearTimeout(hideTimer); show(e.clientX); } });
    cv.addEventListener('pointerup', function () { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 1600); });
    cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });
    cv.addEventListener('pointercancel', function () { hideTimer = setTimeout(hide, 600); });
  }

  function spark(cv, values, color) {
    var dpr = Math.max(1, Math.min(3, root.devicePixelRatio || 1));
    var W = cv.clientWidth || 84, Hh = cv.clientHeight || 44;
    cv.width = W * dpr; cv.height = Hh * dpr;
    var c = cv.getContext('2d');
    c.scale(dpr, dpr);
    var lo = 0, hi = 0, k;
    for (k = 0; k < values.length; k++) { if (values[k] < lo) lo = values[k]; if (values[k] > hi) hi = values[k]; }
    if (hi === lo) hi = lo + 1;
    var n = values.length;
    function X(i) { return 2 + i / Math.max(1, n - 1) * (W - 4); }
    function Y(v) { return 3 + (1 - (v - lo) / (hi - lo)) * (Hh - 6); }
    c.strokeStyle = C.major; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, Math.round(Y(0)) + 0.5); c.lineTo(W, Math.round(Y(0)) + 0.5); c.stroke();
    c.strokeStyle = color || C.blue; c.lineWidth = 1.5; c.lineJoin = 'round';
    c.beginPath();
    var stride = Math.max(1, Math.floor(n / (W * 1.5)));
    for (k = 0; k < n; k += stride) { if (k === 0) c.moveTo(X(k), Y(values[k])); else c.lineTo(X(k), Y(values[k])); }
    c.lineTo(X(n - 1), Y(values[n - 1]));
    c.stroke();
  }

  root.BrainChart = { line: line, spark: spark, colors: C };
})(typeof window !== 'undefined' ? window : this);
