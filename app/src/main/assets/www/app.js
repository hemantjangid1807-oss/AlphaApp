/* BrainSim app: UI, persistence, native bridge glue. */
(function () {
  'use strict';
  var E = window.BrainEngine, D = window.BrainData, CH = window.BrainChart;
  var bridge = window.AndroidBridge || null;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nextFrame() { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 16); }); }); }
  function minus(s) { return String(s).replace(/^-/, '−'); }

  // ------------------------------------------------------------ formatting
  var F = {
    num: function (x, d) { return x === null || x === undefined || x !== x ? '–' : minus(x.toFixed(d === undefined ? 2 : d)); },
    pct: function (x, d) { return x === null || x === undefined || x !== x ? '–' : minus((x * 100).toFixed(d === undefined ? 2 : d)) + '%'; },
    money: function (x) {
      if (x !== x) return '–';
      var a = Math.abs(x), s = x < 0 ? '−$' : '$';
      if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
      if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
      if (a >= 1e3) return s + (a / 1e3).toFixed(0) + 'K';
      return s + a.toFixed(0);
    },
    axis: function (x) {
      var a = Math.abs(x), s = x < 0 ? '\u2212$' : '$';
      function t(v) { return (Math.round(v * 10) / 10).toString(); }
      if (a >= 1e6) return s + t(a / 1e6) + 'M';
      if (a >= 1e3) return s + t(a / 1e3) + 'K';
      return s + Math.round(a);
    },
    day: function (iso) {
      var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var p = String(iso).split('-');
      return p.length === 3 ? (+p[2]) + '\u00a0' + m[+p[1] - 1] + '\u00a0' + p[0] : iso;
    },
    bps: function (x) { return x !== x ? '–' : minus((x * 1e4).toFixed(2)) + '‱'; },
    date: function (iso) {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
  };

  // ---------------------------------------------------------- native glue
  var pending = {}, seq = 0;
  window.__brainNative = {
    onHttp: function (id, status, body) { var p = pending[id]; delete pending[id]; if (p) p({ status: status, body: body }); },
    onSaved: function (id, ok, msg) { var p = pending[id]; delete pending[id]; if (p) p({ ok: ok, msg: msg }); }
  };
  var Native = {
    http: function (url) {
      if (bridge && bridge.httpGet) {
        return new Promise(function (resolve) { var id = 'h' + (++seq); pending[id] = resolve; bridge.httpGet(id, url); });
      }
      return fetch(url).then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); });
    },
    save: function (filename, mime, text) {
      if (bridge && bridge.saveDocument) {
        return new Promise(function (resolve) { var id = 's' + (++seq); pending[id] = resolve; bridge.saveDocument(id, filename, mime, text); });
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      return Promise.resolve({ ok: true });
    },
    share: function (title, text) {
      if (bridge && bridge.shareText) { bridge.shareText(title, text); return; }
      if (navigator.share) { navigator.share({ title: title, text: text }).catch(function () {}); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Summary copied to clipboard'); });
    }
  };

  // -------------------------------------------------------------- storage
  var Store = {
    read: function (name) {
      try { if (bridge && bridge.readFile) { var s = bridge.readFile(name); return s ? s : null; } return localStorage.getItem('brainsim:' + name); } catch (e) { return null; }
    },
    write: function (name, text) {
      try { if (bridge && bridge.writeFile) return !!bridge.writeFile(name, text); localStorage.setItem('brainsim:' + name, text); return true; } catch (e) { return false; }
    },
    remove: function (name) {
      try { if (bridge && bridge.deleteFile) bridge.deleteFile(name); else localStorage.removeItem('brainsim:' + name); } catch (e) { /* ignore */ }
    },
    json: function (name, def) { var s = Store.read(name); if (!s) return def; try { return JSON.parse(s); } catch (e) { return def; } }
  };

  // ---------------------------------------------------------------- state
  var DEFAULT_SETTINGS = { universe: null, delay: 1, decay: 4, neutralization: 'subindustry', truncation: 0.08, pasteurization: true, nanHandling: false, testPeriod: 0 };
  var S = {
    ds: null,
    prefs: { settings: Object.assign({}, DEFAULT_SETTINGS), expr: 'rank(-ts_delta(close, 5))', ds: { source: 'synthetic', stocks: 500, years: 5, seed: 42 }, learnTab: 'ops', filter: 'all' },
    history: [],
    current: null,
    period: 'is',
    chartTab: 'pnl',
    tab: 'simulate',
    scroll: {},
    busy: false
  };
  var savePrefsT = null;
  function savePrefs() { clearTimeout(savePrefsT); savePrefsT = setTimeout(function () { Store.write('prefs.json', JSON.stringify(S.prefs)); }, 250); }
  function saveHistory() {
    var data = JSON.stringify(S.history);
    if (!Store.write('history.json', data)) {
      // storage full: drop oldest unsaved runs and retry
      var unsaved = S.history.filter(function (h) { return !h.starred; });
      if (unsaved.length) {
        var drop = unsaved.slice(Math.floor(unsaved.length / 2));
        S.history = S.history.filter(function (h) { return drop.indexOf(h) < 0; });
        Store.write('history.json', JSON.stringify(S.history));
      }
    }
  }

  // -------------------------------------------------------------- UI bits
  var toastT = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function overlay(msg, sub) {
    var o = $('#overlay');
    if (msg === false) { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');
    $('#overlayMsg').textContent = msg;
    $('#overlaySub').textContent = sub || '';
  }
  var sheetEl = null, scrimEl = null;
  function openSheet(html, onMount) {
    closeSheet(true);
    scrimEl = document.createElement('div'); scrimEl.className = 'scrim';
    sheetEl = document.createElement('div'); sheetEl.className = 'sheet'; sheetEl.setAttribute('role', 'dialog');
    sheetEl.innerHTML = '<div class="grab"></div>' + html;
    document.body.appendChild(scrimEl); document.body.appendChild(sheetEl);
    scrimEl.addEventListener('click', function () { closeSheet(); });
    requestAnimationFrame(function () { scrimEl.classList.add('show'); sheetEl.classList.add('show'); });
    if (onMount) onMount(sheetEl);
  }
  function closeSheet(instant) {
    if (!sheetEl) return false;
    var s = sheetEl, c = scrimEl;
    sheetEl = scrimEl = null;
    if (instant) { s.remove(); c.remove(); return true; }
    s.classList.remove('show'); c.classList.remove('show');
    setTimeout(function () { s.remove(); c.remove(); }, 230);
    return true;
  }
  var ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M3 20h18M4 16l5-6 4 3 7-9"/></svg>'
  };
  var MARK = {
    PASS: '<svg class="mark" viewBox="0 0 24 24"><path d="M5 12.8l4.4 4.4L19.5 7"/></svg>',
    FAIL: '<svg class="mark" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    PENDING: '<svg class="mark" viewBox="0 0 24 24"><path d="M6 12h12"/></svg>'
  };

  // ----------------------------------------------------------------- tabs
  function setTab(tab) {
    if (S.tab === tab) return;
    var main = $('#main');
    S.scroll[S.tab] = main.scrollTop;
    S.tab = tab;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + tab); });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    $('#simDock').classList.toggle('hidden', tab !== 'simulate');
    if (tab === 'results') renderResults();
    if (tab === 'alphas') renderAlphas();
    if (tab === 'data') renderData();
    if (tab === 'learn') renderLearn();
    main.scrollTop = S.scroll[tab] || 0;
  }
  window.handleBack = function () {
    if (closeSheet()) return true;
    if (S.tab !== 'simulate') { setTab('simulate'); return true; }
    return false;
  };

  // --------------------------------------------------------------- editor
  var ta, gutter, mirror, validateT = null, lastCaret = null;
  function setupEditor() {
    ta = $('#expr'); gutter = $('#gutter');
    mirror = document.createElement('div');
    mirror.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;word-break:break-word;font:400 15.5px/22px var(--mono);';
    document.body.appendChild(mirror);
    ta.value = S.prefs.expr || '';
    ta.addEventListener('input', onEditorInput);
    ['keyup', 'click', 'select', 'focus'].forEach(function (ev) { ta.addEventListener(ev, function () { lastCaret = [ta.selectionStart, ta.selectionEnd]; }); });
    window.addEventListener('resize', layoutEditor);
    $('#btnClear').addEventListener('click', function () { ta.value = ''; onEditorInput(); ta.focus(); });
    $('#btnExamples').addEventListener('click', showExamples);
    $('#btnSimulate').addEventListener('click', runSimulation);
    layoutEditor();
  }
  function layoutEditor() {
    ta.style.height = 'auto';
    ta.style.height = Math.max(154, ta.scrollHeight) + 'px';
    var w = ta.clientWidth - 22;
    if (w <= 0) return;
    mirror.style.width = w + 'px';
    var lines = ta.value.split('\n'), html = '';
    for (var i = 0; i < lines.length; i++) {
      mirror.textContent = lines[i] || ' ';
      html += '<div style="height:' + Math.max(22, mirror.offsetHeight) + 'px">' + (i + 1) + '</div>';
    }
    gutter.innerHTML = html;
  }
  function onEditorInput() {
    lastCaret = [ta.selectionStart, ta.selectionEnd];
    S.prefs.expr = ta.value;
    savePrefs();
    layoutEditor();
    clearTimeout(validateT);
    validateT = setTimeout(validateNow, 220);
  }
  function envForValidation() {
    if (!S.ds) return { fields: [], groups: [] };
    return { fields: Object.keys(S.ds.fields), groups: Object.keys(S.ds.groups).concat(['market']) };
  }
  function validateNow() {
    var st = $('#status');
    var src = ta.value.trim();
    if (!src) { st.className = 'status-line'; st.innerHTML = '<span class="muted">Write an expression, or pick one from the examples.</span>'; return null; }
    if (!S.ds) return null;
    var v = E.validate(src, envForValidation());
    if (v.ok) {
      st.className = 'status-line ok';
      st.innerHTML = '<span>Valid expression' + (v.usedFields.length ? ', uses ' + esc(v.usedFields.slice(0, 5).join(', ')) + (v.usedFields.length > 5 ? '…' : '') : '') + '</span>';
    } else {
      st.className = 'status-line bad';
      st.innerHTML = '<span>' + (v.line ? 'Line ' + v.line + ', column ' + v.col + ': ' : '') + esc(v.error) +
        (v.line ? ' <button type="button" id="btnShowErr">Show me</button>' : '') + '</span>';
      var b = $('#btnShowErr');
      if (b) b.addEventListener('click', function () { focusPos(v.line, v.col); });
    }
    return v;
  }
  function focusPos(line, col) {
    var lines = ta.value.split('\n'), idx = 0;
    for (var i = 0; i < line - 1 && i < lines.length; i++) idx += lines[i].length + 1;
    idx += Math.max(0, col - 1);
    ta.focus();
    var m = /^[A-Za-z_0-9.]+/.exec(ta.value.slice(idx));
    ta.setSelectionRange(idx, idx + (m ? m[0].length : 1));
  }
  function insertSnippet(text, isFunc) {
    var s = lastCaret ? lastCaret[0] : ta.value.length, e = lastCaret ? lastCaret[1] : ta.value.length;
    var sel = ta.value.slice(s, e), ins, caret;
    if (isFunc) { ins = text + '(' + sel + ')'; caret = s + ins.length - (sel ? 0 : 1); }
    else { ins = text; caret = s + ins.length; }
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.setSelectionRange(caret, caret);
    lastCaret = [caret, caret];
    onEditorInput();
  }
  var QUICK_OPS = ['rank', 'ts_delta', 'ts_mean', 'ts_sum', 'ts_std_dev', 'ts_rank', 'ts_corr', 'ts_delay', 'ts_decay_linear', 'zscore', 'group_neutralize', 'group_rank', 'abs', 'sign', 'log', 'if_else', 'trade_when', 'winsorize', 'scale'];
  function renderChips() {
    var c = $('#chips'), html = '';
    if (!S.ds) { c.innerHTML = ''; return; }
    var order = ['close', 'open', 'high', 'low', 'vwap', 'volume', 'returns', 'adv20', 'cap'];
    var fields = Object.keys(S.ds.fields).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    fields.forEach(function (f) { html += '<button type="button" class="chip" data-ins="' + esc(f) + '">' + esc(f) + '</button>'; });
    html += '<span class="chip-sep"></span>';
    ['subindustry', 'industry', 'sector', 'market'].forEach(function (g) { html += '<button type="button" class="chip grp" data-ins="' + g + '">' + g + '</button>'; });
    html += '<span class="chip-sep"></span>';
    QUICK_OPS.forEach(function (o) { html += '<button type="button" class="chip op" data-fn="' + o + '">' + o + '()</button>'; });
    c.innerHTML = html;
  }
  function bindChips() {
    var c = $('#chips');
    c.addEventListener('pointerdown', function (e) { if (e.target.closest('.chip') && document.activeElement === ta) e.preventDefault(); });
    c.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      if (b.dataset.fn) insertSnippet(b.dataset.fn, true); else insertSnippet(b.dataset.ins, false);
    });
  }

  // ------------------------------------------------------------- settings
  function renderSettings() {
    var st = S.prefs.settings, ds = S.ds, el = $('#settings');
    var unis = ds ? E.listUniverses(ds) : ['TOP500'];
    if (!st.universe || unis.indexOf(st.universe) < 0) st.universe = unis[0];
    var maxTest = ds ? Math.max(0, Math.floor((ds.T - ds.simStart) / 252) - 1) : 4;
    if (st.testPeriod > maxTest) st.testPeriod = maxTest;
    function opt(v, cur, label) { return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + (label || v) + '</option>'; }
    function seg(key, vals, labels) {
      return '<div class="seg" data-key="' + key + '">' + vals.map(function (v, i) {
        return '<button type="button" data-v="' + v + '" class="' + (String(st[key]) === String(v) ? 'on' : '') + '">' + labels[i] + '</button>';
      }).join('') + '</div>';
    }
    function step(key, min, max, inc, dec) {
      return '<div class="stepper" data-key="' + key + '" data-min="' + min + '" data-max="' + max + '" data-step="' + inc + '" data-dec="' + dec + '">' +
        '<button type="button" data-d="-1" aria-label="Decrease">−</button><input type="number" inputmode="decimal" value="' + Number(st[key]).toFixed(dec) + '" aria-label="' + key + '">' +
        '<button type="button" data-d="1" aria-label="Increase">+</button></div>';
    }
    el.innerHTML =
      row('Universe', 'Most liquid stocks by dollar volume', '<select class="select" data-key="universe">' + unis.map(function (u) { return opt(u, st.universe); }).join('') + '</select>') +
      row('Delay', 'Days between data and trade', seg('delay', [0, 1], ['0', '1'])) +
      row('Decay', 'Linear smoothing over n days', step('decay', 0, 60, 1, 0)) +
      row('Neutralization', 'Make each group net zero', '<select class="select" data-key="neutralization">' +
        [['none', 'None'], ['market', 'Market'], ['sector', 'Sector'], ['industry', 'Industry'], ['subindustry', 'Subindustry']].map(function (p) { return opt(p[0], st.neutralization, p[1]); }).join('') + '</select>') +
      row('Truncation', 'Max weight per stock', step('truncation', 0, 1, 0.01, 2)) +
      row('Pasteurization', 'Hide data outside the universe', seg('pasteurization', ['true', 'false'], ['On', 'Off'])) +
      row('NaN handling', 'Skip missing values in windows', seg('nanHandling', ['true', 'false'], ['On', 'Off'])) +
      row('Test period', 'Years held out at the end', step('testPeriod', 0, maxTest, 0.5, 1));
    $('#settingsNote').textContent = 'Book size $20M, long and short. The universe is re-ranked every 21 trading days.';
    function row(label, hint, ctrl) { return '<div class="set-row"><label>' + label + '<small>' + hint + '</small></label>' + ctrl + '</div>'; }
  }
  function bindSettings() {
    var el = $('#settings');
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.matches('select')) { S.prefs.settings[t.dataset.key] = t.value; savePrefs(); }
      if (t.matches('.stepper input')) clampStepper(t.closest('.stepper'), parseFloat(t.value));
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var segEl = b.closest('.seg');
      if (segEl) {
        var key = segEl.dataset.key, v = b.dataset.v;
        S.prefs.settings[key] = v === 'true' ? true : v === 'false' ? false : +v;
        $$('button', segEl).forEach(function (x) { x.classList.toggle('on', x === b); });
        savePrefs();
        return;
      }
      var stp = b.closest('.stepper');
      if (stp) clampStepper(stp, S.prefs.settings[stp.dataset.key] + (+b.dataset.d) * (+stp.dataset.step));
    });
  }
  function clampStepper(stp, v) {
    var key = stp.dataset.key, mn = +stp.dataset.min, mx = +stp.dataset.max, dec = +stp.dataset.dec;
    if (!(v === v)) v = S.prefs.settings[key];
    v = Math.max(mn, Math.min(mx, v));
    v = +v.toFixed(dec);
    S.prefs.settings[key] = v;
    $('input', stp).value = v.toFixed(dec);
    savePrefs();
  }

  // ------------------------------------------------------------- examples
  var EXAMPLES = [
    ['Five-day reversal', 'Stocks that fell over the past week tend to bounce back.', 'rank(-ts_delta(close, 5))'],
    ['Peer-relative reversal', 'Reversal measured against close peers in the same sub-industry.', 'group_neutralize(-ts_sum(returns, 5), subindustry)'],
    ['VWAP gap', 'Favour stocks that closed below their volume-weighted price.', 'rank(vwap - close)'],
    ['Price–volume divergence', 'Bet against moves where price and volume rise together.', '-ts_corr(rank(close), rank(volume), 10)'],
    ['Quiet-volume reversal', 'Reversal is stronger when the move came on light volume.', 'a = -ts_sum(returns, 3);\nb = volume / adv20;\nrank(a) * (1.5 - rank(b))'],
    ['Event-driven reversal', 'Trade only after an unusually heavy-volume day, hold otherwise.', 'trade_when(volume > adv20, -returns, -1)'],
    ['Earnings yield', 'Cheap stocks relative to earnings, ranked within each sector. Needs fundamentals.', 'group_rank(eps / close, sector)'],
    ['Profitability', 'Operating income per dollar of assets. Needs fundamentals.', 'rank(operating_income / assets)'],
    ['Twelve-minus-one momentum', 'Last year’s winners, skipping the most recent month.', 'rank(ts_delay(ts_sum(returns, 230), 21))'],
    ['Low volatility', 'Prefer the calmer stocks.', '-rank(ts_std_dev(returns, 60))'],
    ['Three-factor blend', 'Reversal, value and momentum combined. Needs fundamentals; try decay 3.', 'r = rank(-ts_sum(returns, 5));\nv = rank(eps / close);\nm = rank(ts_delay(ts_sum(returns, 230), 21));\ngroup_neutralize(r + 0.5 * v + 0.5 * m, sector)'],
    ['Alpha #12', 'From the paper “101 Formulaic Alphas” (Kakushadze, 2016).', 'sign(ts_delta(volume, 1)) * (-1 * ts_delta(close, 1))'],
    ['Alpha #41', 'From “101 Formulaic Alphas”: geometric mid-price against VWAP.', 'power(high * low, 0.5) - vwap'],
    ['Alpha #101', 'From “101 Formulaic Alphas”: intraday move scaled by range.', '(close - open) / ((high - low) + 0.001)']
  ];
  function showExamples() {
    var html = '<h3>Example alphas</h3>' + EXAMPLES.map(function (x, i) {
      return '<div class="ex-item" data-i="' + i + '" role="button" tabindex="0"><div class="t">' + esc(x[0]) + '</div><div class="d">' + esc(x[1]) + '</div><code>' + esc(x[2]) + '</code></div>';
    }).join('');
    openSheet(html, function (el) {
      el.addEventListener('click', function (e) {
        var it = e.target.closest('.ex-item');
        if (!it) return;
        ta.value = EXAMPLES[+it.dataset.i][2];
        onEditorInput();
        closeSheet();
        toast('Loaded “' + EXAMPLES[+it.dataset.i][0] + '”');
      });
    });
  }

  // ----------------------------------------------------------- simulation
  function runSimulation() {
    if (S.busy || !S.ds) return;
    var src = ta.value.trim();
    var v = validateNow();
    if (!src) { toast('Write an expression first'); return; }
    if (!v || !v.ok) { toast('Fix the expression before simulating'); return; }
    S.busy = true;
    ta.blur();
    var st = Object.assign({}, S.prefs.settings);
    overlay('Simulating', S.ds.N + ' stocks over ' + Math.round((S.ds.T - S.ds.simStart) / 252) + ' years, ' + st.universe + ', delay ' + st.delay);
    nextFrame().then(function () {
      var res;
      try {
        res = E.simulate(S.ds, src, st);
      } catch (e) {
        overlay(false); S.busy = false;
        var stEl = $('#status');
        stEl.className = 'status-line bad';
        stEl.innerHTML = '<span>' + (e.line ? 'Line ' + e.line + ', column ' + e.col + ': ' : '') + esc(e.message || String(e)) + '</span>';
        toast('Simulation stopped: ' + (e.message || e).toString().slice(0, 80));
        return;
      }
      var entry = toEntry(res);
      addSelfCorrelation(entry);
      S.history.unshift(entry);
      var unsaved = 0;
      S.history = S.history.filter(function (h) { if (h.starred) return true; unsaved++; return unsaved <= 60; });
      saveHistory();
      S.current = entry; S.period = 'is';
      overlay(false); S.busy = false;
      setTab('results');
      renderResults();
      $('#main').scrollTop = 0;
    });
  }
  function toEntry(r) {
    return {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      expression: r.expression, settings: r.settings, datasetId: r.dataset.id, datasetName: S.ds.name, source: S.ds.source,
      createdAt: r.createdAt, starred: false,
      summary: r.summary, os: r.os, yearly: r.yearly, checks: r.checks,
      maxWeight: r.maxWeight, avgUniverse: r.avgUniverse, topPositions: r.topPositions,
      subUniverse: r.subUniverse, subSharpe: r.subSharpe, isEndIndex: r.isEndIndex, timing: r.timing,
      dates: r.dates, pnl: r.pnl,
      turnover: r.turnover.map(function (x) { return Math.round(x * 1000) / 1000; }),
      longCount: r.longCount, shortCount: r.shortCount
    };
  }
  function addSelfCorrelation(entry) {
    entry.checks = entry.checks.filter(function (c) { return c.name !== 'SELF_CORRELATION'; });
    var saved = S.history.filter(function (h) { return h.starred && h.datasetId === entry.datasetId && h.id !== entry.id; });
    if (!saved.length) {
      entry.checks.push({ name: 'SELF_CORRELATION', result: 'PENDING', message: 'No saved alphas on this dataset to compare against yet' });
      return;
    }
    var idx = {};
    entry.dates.forEach(function (d, i) { idx[d] = i; });
    var best = null;
    saved.forEach(function (h) {
      var a = [], b = [];
      for (var k = 0; k < h.dates.length; k++) { var j = idx[h.dates[k]]; if (j !== undefined && j <= entry.isEndIndex) { a.push(entry.pnl[j]); b.push(h.pnl[k]); } }
      var c = E.correlation(a, b);
      if (c === c && (!best || c > best.c)) best = { c: c, h: h };
    });
    if (!best) { entry.checks.push({ name: 'SELF_CORRELATION', result: 'PENDING', message: 'Not enough overlapping days to compare' }); return; }
    var ok = best.c < 0.7 || entry.summary.sharpe >= 1.1 * best.h.summary.sharpe;
    entry.checks.push({
      name: 'SELF_CORRELATION', result: ok ? 'PASS' : 'FAIL', value: best.c, limit: 0.7,
      message: 'Highest PnL correlation with a saved alpha is ' + best.c.toFixed(2) + (best.c < 0.7 ? ' (limit 0.70)' : ok ? ', but Sharpe is at least 10% higher' : ' — above the 0.70 limit')
    });
  }

  // -------------------------------------------------------------- results
  var CHECK_TITLES = {
    LOW_SHARPE: 'Sharpe', LOW_FITNESS: 'Fitness', LOW_TURNOVER: 'Turnover floor', HIGH_TURNOVER: 'Turnover ceiling',
    CONCENTRATED_WEIGHT: 'Weight concentration', LOW_SUB_UNIVERSE_SHARPE: 'Sub-universe robustness', SELF_CORRELATION: 'Self-correlation'
  };
  function renderResults() {
    var el = $('#view-results'), r = S.current;
    if (!r) {
      el.innerHTML = '<div class="empty"><div class="glyph">α</div><p>No simulation yet. Write an expression and tap Simulate to see its backtest here.</p>' +
        '<button class="btn primary" type="button" id="goEdit">Open the editor</button></div>';
      $('#goEdit').addEventListener('click', function () { setTab('simulate'); });
      return;
    }
    var st = r.settings, isOs = S.period === 'os' && r.os, sm = isOs ? r.os : r.summary;
    var d0 = (st.delay | 0) === 0, shL = d0 ? 2 : 1.25, fiL = d0 ? 1.3 : 1;
    function cls(v, lim) { return v < 0 ? 'neg' : v >= lim ? 'pass' : 'pos'; }
    var failed = r.checks.filter(function (c) { return c.result === 'FAIL'; }).length;
    var html = '';
    html += '<div class="res-head"><pre class="res-expr" id="resExpr">' + esc(r.expression) + '</pre>' +
      '<div class="res-meta"><span>' + esc(st.universe) + '</span><span>delay ' + st.delay + '</span><span>decay ' + st.decay + '</span>' +
      '<span>' + esc(st.neutralization) + ' neutral</span><span>truncation ' + st.truncation + '</span>' +
      (st.pasteurization ? '' : '<span>pasteurization off</span>') + (st.nanHandling ? '<span>NaN handling on</span>' : '') + '</div>' +
      '<div class="res-meta">' + esc(r.datasetName) + ', ' + F.day(r.dates[0]) + ' to ' + F.day(r.dates[r.dates.length - 1]) + '</div></div>';
    if (r.os) {
      html += '<div class="period-switch"><div class="seg" id="periodSeg"><button type="button" data-p="is" class="' + (isOs ? '' : 'on') + '">In-sample</button>' +
        '<button type="button" data-p="os" class="' + (isOs ? 'on' : '') + '">Test period</button></div></div>';
    }
    html += '<div class="grade">' +
      '<div class="big"><div class="lbl">Sharpe</div><div class="val ' + cls(sm.sharpe, shL) + '">' + F.num(sm.sharpe) + '</div><div class="lim">cutoff ' + shL.toFixed(2) + '</div></div>' +
      '<div class="big"><div class="lbl">Fitness</div><div class="val ' + cls(sm.fitness, fiL) + '">' + F.num(sm.fitness) + '</div><div class="lim">cutoff ' + fiL.toFixed(2) + '</div></div>' +
      '<div class="small-stats">' +
      '<div><div class="lbl">Turnover</div><div class="val">' + F.pct(sm.turnover) + '</div></div>' +
      '<div><div class="lbl">Returns</div><div class="val' + (sm.returns < 0 ? ' neg' : '') + '">' + F.pct(sm.returns) + '</div></div>' +
      '<div><div class="lbl">Drawdown</div><div class="val">' + F.pct(sm.drawdown) + '</div></div>' +
      '<div><div class="lbl">Margin</div><div class="val' + (sm.margin < 0 ? ' neg' : '') + '">' + F.bps(sm.margin) + '</div></div>' +
      '</div></div>';
    html += '<div class="chart-wrap"><div class="chart-sheet" id="chart"></div><div class="chart-tabs" id="chartTabs">' +
      [['pnl', 'PnL'], ['sharpe', 'Rolling Sharpe'], ['tvr', 'Turnover'], ['cov', 'Positions']].map(function (t) {
        return '<button type="button" data-c="' + t[0] + '" class="' + (S.chartTab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div></div>';

    html += '<h3 class="sec">Submission checks<small>in-sample</small></h3><ul class="checks">' + r.checks.map(function (c) {
      var k = c.result === 'PASS' ? 'pass' : c.result === 'FAIL' ? 'fail' : 'pend';
      return '<li class="' + k + '">' + MARK[c.result] + '<div><div class="t">' + esc(c.message) + '</div><div class="code">' + esc(CHECK_TITLES[c.name] || c.name) + '</div></div></li>';
    }).join('') + '</ul>';
    html += '<p class="verdict ' + (failed ? 'bad' : 'good') + '">' + (failed ? 'Fails ' + failed + ' of ' + r.checks.length + ' checks.' : 'Passes every check that could be run.') + '</p>';

    html += '<h3 class="sec">Year by year</h3><div class="table-scroll"><table class="yearly"><thead><tr><th>Year</th><th>Sharpe</th><th>Turnover</th><th>Fitness</th><th>Returns</th><th>Drawdown</th><th>Margin</th><th>Long</th><th>Short</th></tr></thead><tbody>';
    r.yearly.forEach(function (y) { html += yRow(y.year, y, ''); });
    html += yRow('In-sample', r.summary, 'total');
    if (r.os) html += yRow('Test', r.os, 'total');
    html += '</tbody></table></div>';

    var longs = r.topPositions.filter(function (p) { return p.weight > 0; }).slice(0, 6);
    var shorts = r.topPositions.filter(function (p) { return p.weight < 0; }).slice(0, 6);
    html += '<h3 class="sec">Largest positions<small>on ' + F.day(r.dates[r.dates.length - 1]) + '</small></h3><div class="positions">' +
      '<div class="col"><h4>Long</h4>' + (longs.map(posRow).join('') || '<p class="note">None</p>') + '</div>' +
      '<div class="col"><h4>Short</h4>' + (shorts.map(posRow).join('') || '<p class="note">None</p>') + '</div></div>';

    html += '<div class="btn-row">' +
      '<button class="btn' + (r.starred ? '' : ' primary') + '" type="button" id="btnStar">' + ICON.star + (r.starred ? 'Saved' : 'Save to My alphas') + '</button>' +
      '<button class="btn" type="button" id="btnEdit">' + ICON.edit + 'Edit</button></div>' +
      '<div class="btn-row"><button class="btn" type="button" id="btnExport">' + ICON.download + 'Export CSV</button>' +
      '<button class="btn" type="button" id="btnShare">' + ICON.share + 'Share</button>' +
      '<button class="btn danger" type="button" id="btnDelete" aria-label="Delete this simulation">' + ICON.trash + '</button></div>';
    html += '<p class="note">Simulated in ' + (r.timing ? r.timing.totalMs : '?') + ' ms, ' + F.date(r.createdAt) + '. ' +
      (r.source === 'synthetic' ? 'Synthetic market: useful for learning and testing ideas, not a forecast of real returns.' : 'Gross of trading costs.') + '</p>';
    el.innerHTML = html;

    function yRow(label, y, cls2) {
      return '<tr class="' + cls2 + '"><td>' + label + '</td><td class="' + (y.sharpe < 0 ? 'neg' : '') + '">' + F.num(y.sharpe) + '</td><td>' + F.pct(y.turnover) +
        '</td><td class="' + (y.fitness < 0 ? 'neg' : '') + '">' + F.num(y.fitness) + '</td><td class="' + (y.returns < 0 ? 'neg' : '') + '">' + F.pct(y.returns) +
        '</td><td>' + F.pct(y.drawdown) + '</td><td class="' + (y.margin < 0 ? 'neg' : '') + '">' + F.bps(y.margin) + '</td><td>' + Math.round(y.longCount) + '</td><td>' + Math.round(y.shortCount) + '</td></tr>';
    }
    function posRow(p) { return '<div class="p"><span>' + esc(p.ticker) + '</span><span>' + F.pct(p.weight, 2) + '</span></div>'; }

    $('#resExpr').addEventListener('click', function () { this.classList.toggle('open'); });
    var ps = $('#periodSeg');
    if (ps) ps.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { S.period = b.dataset.p; renderResults(); } });
    $('#chartTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S.chartTab = b.dataset.c;
      $$('#chartTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      drawChart();
    });
    $('#btnStar').addEventListener('click', function () { toggleStar(r); renderResults(); });
    $('#btnEdit').addEventListener('click', function () { loadIntoEditor(r); });
    $('#btnExport').addEventListener('click', function () { exportCsv(r); });
    $('#btnShare').addEventListener('click', function () { Native.share('BrainSim alpha', summaryText(r)); });
    $('#btnDelete').addEventListener('click', function () { confirmDelete(r); });
    drawChart();
  }
  function drawChart() {
    var r = S.current, box = $('#chart');
    if (!r || !box) return;
    var shade = r.isEndIndex < r.dates.length - 1 ? r.isEndIndex + 1 : null;
    var C = CH.colors;
    if (S.chartTab === 'pnl') {
      var cum = [], c = 0;
      for (var i = 0; i < r.pnl.length; i++) { c += r.pnl[i]; cum.push(c); }
      CH.line(box, { labels: r.dates, xFmt: F.day, series: [{ name: 'PnL', values: cum, color: C.blue }], yFmt: F.axis, tipFmt: F.money, shadeFrom: shade });
    } else if (S.chartTab === 'sharpe') {
      CH.line(box, { labels: r.dates, xFmt: F.day, series: [{ name: 'Sharpe', values: E.rollingSharpe(r.pnl, 252), color: C.blue }], yFmt: function (v) { return F.num(v, 1); }, tipFmt: function (v) { return F.num(v, 2); }, shadeFrom: shade });
    } else if (S.chartTab === 'tvr') {
      var avg = [], s = 0;
      for (var k = 0; k < r.turnover.length; k++) { s += r.turnover[k]; if (k >= 20) s -= r.turnover[k - 20]; avg.push(k >= 19 ? s / 20 : NaN); }
      CH.line(box, { labels: r.dates, xFmt: F.day, series: [{ name: 'Daily', values: r.turnover, color: '#9FB3CC', width: 1 }, { name: '20-day avg', values: avg, color: C.blue }], yFmt: function (v) { return F.pct(v, 0); }, tipFmt: function (v) { return F.pct(v, 1); }, shadeFrom: shade });
    } else {
      CH.line(box, { labels: r.dates, xFmt: F.day, series: [{ name: 'Long', values: r.longCount, color: C.blue }, { name: 'Short', values: r.shortCount, color: C.red }], yFmt: function (v) { return String(Math.round(v)); }, shadeFrom: shade });
    }
  }
  function toggleStar(r) {
    r.starred = !r.starred;
    if (r.starred) addSelfCorrelation(r);
    saveHistory();
    toast(r.starred ? 'Saved to My alphas' : 'Removed from My alphas');
  }
  function loadIntoEditor(r) {
    ta.value = r.expression;
    var keep = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { if (r.settings[k] !== undefined) keep[k] = r.settings[k]; });
    S.prefs.settings = Object.assign({}, S.prefs.settings, keep);
    renderSettings();
    onEditorInput();
    setTab('simulate');
  }
  function confirmDelete(r) {
    openSheet('<h3>Delete this simulation?</h3><p class="note">' + esc(r.expression.slice(0, 120)) + '</p>' +
      '<button class="menu-item danger" type="button" id="cfDel">' + ICON.trash + 'Delete</button>' +
      '<button class="menu-item" type="button" id="cfCancel">Keep it</button>', function (el) {
      $('#cfDel', el).addEventListener('click', function () {
        S.history = S.history.filter(function (h) { return h.id !== r.id; });
        saveHistory();
        if (S.current && S.current.id === r.id) S.current = null;
        closeSheet();
        toast('Simulation deleted');
        if (S.tab === 'results') renderResults(); else renderAlphas();
      });
      $('#cfCancel', el).addEventListener('click', function () { closeSheet(); });
    });
  }
  function exportCsv(r) {
    var lines = ['date,pnl,cumulative_pnl,turnover,long_count,short_count,sample'], c = 0;
    for (var i = 0; i < r.dates.length; i++) {
      c += r.pnl[i];
      lines.push([r.dates[i], r.pnl[i], c, r.turnover[i], r.longCount[i], r.shortCount[i], i <= r.isEndIndex ? 'IS' : 'OS'].join(','));
    }
    var head = '# ' + r.expression.replace(/\n/g, ' ') + '\n# ' + JSON.stringify(r.settings) + '\n';
    Native.save('brainsim_' + r.id + '.csv', 'text/csv', head + lines.join('\n') + '\n').then(function (res) {
      if (res && res.ok) toast('CSV exported'); else if (res && res.msg) toast(res.msg);
    });
  }
  function summaryText(r) {
    var s = r.summary;
    return r.expression + '\n\n' + r.settings.universe + ', delay ' + r.settings.delay + ', decay ' + r.settings.decay + ', ' + r.settings.neutralization + ' neutral, truncation ' + r.settings.truncation +
      '\nSharpe ' + s.sharpe.toFixed(2) + ' | Fitness ' + s.fitness.toFixed(2) + ' | Turnover ' + (s.turnover * 100).toFixed(2) + '% | Returns ' + (s.returns * 100).toFixed(2) +
      '% | Drawdown ' + (s.drawdown * 100).toFixed(2) + '% | Margin ' + (s.margin * 1e4).toFixed(2) + ' bps' +
      '\n' + r.datasetName + ', ' + r.dates[0] + ' to ' + r.dates[r.dates.length - 1] + '\nSimulated with BrainSim';
  }

  // --------------------------------------------------------------- alphas
  function renderAlphas() {
    var el = $('#view-alphas'), f = S.prefs.filter || 'all';
    var passing = function (h) { return !h.checks.some(function (c) { return c.result === 'FAIL'; }); };
    var counts = { all: S.history.length, saved: S.history.filter(function (h) { return h.starred; }).length, passing: S.history.filter(passing).length };
    var list = S.history.filter(function (h) { return f === 'all' ? true : f === 'saved' ? h.starred : passing(h); });
    var html = '<h2 class="page">My alphas</h2><div class="filters">' +
      [['all', 'All runs'], ['saved', 'Saved'], ['passing', 'Passing checks']].map(function (x) {
        return '<button type="button" class="chip' + (f === x[0] ? ' on' : '') + '" data-f="' + x[0] + '">' + x[1] + ' ' + counts[x[0]] + '</button>';
      }).join('') + '</div>';
    if (!list.length) {
      html += '<div class="empty"><div class="glyph">∑</div><p>' + (f === 'saved' ? 'Alphas you save from the results page are kept here and used for the self-correlation check.' :
        f === 'passing' ? 'None of your runs pass every check yet. Try adding decay or a neutralization.' : 'Every simulation you run is listed here.') + '</p></div>';
    } else {
      html += '<ul class="alpha-list">' + list.map(function (h) {
        var s = h.summary, ok = passing(h);
        return '<li class="alpha-item" data-id="' + h.id + '" role="button" tabindex="0"><div class="ex">' + esc(h.expression) + '</div><canvas></canvas>' +
          '<div class="meta">' + (h.starred ? '<span class="star">★</span> ' : '') + esc(F.date(h.createdAt)) + ', ' + esc(h.settings.universe) + ', delay ' + h.settings.delay +
          '<span class="tag ' + (ok ? 'pass' : 'fail') + '">' + (ok ? 'passes' : 'fails') + '</span></div>' +
          '<div class="stats"><span>Sharpe<b class="' + (s.sharpe < 0 ? 'neg' : '') + '">' + F.num(s.sharpe) + '</b></span><span>Fitness<b class="' + (s.fitness < 0 ? 'neg' : '') + '">' + F.num(s.fitness) +
          '</b></span><span>Turnover<b>' + F.pct(s.turnover, 1) + '</b></span><span>Returns<b class="' + (s.returns < 0 ? 'neg' : '') + '">' + F.pct(s.returns, 1) + '</b></span></div></li>';
      }).join('') + '</ul>';
      if (f === 'all' && counts.all > counts.saved) html += '<div class="btn-row"><button type="button" class="btn danger" id="btnClearHist">' + ICON.trash + 'Clear unsaved runs</button></div>';
    }
    el.innerHTML = html;
    $$('.alpha-item', el).forEach(function (li) {
      var h = S.history.filter(function (x) { return x.id === li.dataset.id; })[0];
      var cum = [], c = 0;
      for (var i = 0; i < h.pnl.length; i++) { c += h.pnl[i]; cum.push(c); }
      CH.spark($('canvas', li), cum, c < 0 ? CH.colors.red : CH.colors.blue);
      li.addEventListener('click', function () { openAlphaMenu(h); });
    });
    $$('.filters .chip', el).forEach(function (b) { b.addEventListener('click', function () { S.prefs.filter = b.dataset.f; savePrefs(); renderAlphas(); }); });
    var ch = $('#btnClearHist');
    if (ch) ch.addEventListener('click', function () {
      S.history = S.history.filter(function (h) { return h.starred; });
      if (S.current && !S.current.starred) S.current = null;
      saveHistory(); renderAlphas(); toast('Unsaved runs cleared');
    });
  }
  function openAlphaMenu(h) {
    openSheet('<h3>Alpha</h3><p class="note" style="font-family:var(--mono);color:var(--ink)">' + esc(h.expression) + '</p>' +
      '<button class="menu-item" type="button" data-a="open">' + ICON.open + 'View results</button>' +
      '<button class="menu-item" type="button" data-a="edit">' + ICON.edit + 'Load into editor</button>' +
      '<button class="menu-item" type="button" data-a="star">' + ICON.star + (h.starred ? 'Remove from saved' : 'Save to My alphas') + '</button>' +
      '<button class="menu-item danger" type="button" data-a="del">' + ICON.trash + 'Delete</button>', function (el) {
      el.addEventListener('click', function (e) {
        var b = e.target.closest('.menu-item');
        if (!b) return;
        var a = b.dataset.a;
        closeSheet(true);
        if (a === 'open') { S.current = h; S.period = 'is'; setTab('results'); renderResults(); $('#main').scrollTop = 0; }
        if (a === 'edit') loadIntoEditor(h);
        if (a === 'star') { toggleStar(h); renderAlphas(); }
        if (a === 'del') confirmDelete(h);
      });
    });
  }

  // ----------------------------------------------------------------- data
  function dsLabel(ds) {
    var yrs = Math.round((ds.T - ds.simStart) / 252);
    return (ds.source === 'synthetic' ? 'Synthetic' : ds.source === 'csv' ? 'CSV' : 'US large caps') + ', ' + ds.N + ' stocks, ' + yrs + 'y';
  }
  function setDataset(ds) {
    S.ds = ds;
    $('#dsPillText').textContent = dsLabel(ds);
    $('#dsPill').classList.remove('busy');
    renderChips();
    renderSettings();
    validateNow();
    if (S.tab === 'data') renderData();
    if (S.tab === 'learn') renderLearn();
  }
  function renderData() {
    var el = $('#view-data'), ds = S.ds, p = S.prefs.ds || {};
    if (!ds) { el.innerHTML = ''; return; }
    var nFields = Object.keys(ds.fields).length;
    var html = '<h2 class="page">Market data</h2><div class="page-sheet ds-card"><div class="name">' + esc(ds.name) + '</div><dl>' +
      '<dt>Source</dt><dd>' + (ds.source === 'synthetic' ? 'Generated on this device (seed ' + esc(ds.params.seed) + ')' : ds.source === 'csv' ? 'Imported CSV file' : 'Yahoo Finance / Stooq download') + '</dd>' +
      '<dt>Simulation</dt><dd>' + F.day(ds.startDate) + ' to ' + F.day(ds.endDate) + '</dd>' +
      '<dt>Trading days</dt><dd>' + (ds.T - ds.simStart) + ' plus ' + ds.simStart + ' warm-up</dd>' +
      '<dt>Stocks</dt><dd>' + ds.N + ' in ' + ds.groups.sector.names.length + ' sectors</dd>' +
      '<dt>Universes</dt><dd>' + E.listUniverses(ds).join(', ') + '</dd>' +
      '<dt>Data fields</dt><dd>' + nFields + '</dd></dl>' +
      '<div class="field-list">' + Object.keys(ds.fields).map(function (f) { return '<span class="chip" style="font-size:13px">' + esc(f) + '</span>'; }).join('') + '</div></div>';

    var stocks = [100, 200, 300, 500, 800, 1000], years = [2, 3, 5, 8, 10];
    var curStocks = p.source === 'synthetic' ? p.stocks : 500, curYears = p.source === 'synthetic' ? p.years : 5, curSeed = p.source === 'synthetic' ? p.seed : 42;
    html += '<h3 class="sec">Change the market</h3>';
    html += '<div class="option"><h4>Synthetic market</h4><p>Works offline. A multi-factor market with sectors, industries, volatility regimes and weak real-world-style effects such as reversal, momentum and value. The same seed always gives the same market.</p>' +
      '<div class="row"><label class="field">Stocks<select class="select" id="synStocks">' + stocks.map(function (n) { return '<option' + (n === curStocks ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">Years<select class="select" id="synYears" style="min-width:84px">' + years.map(function (n) { return '<option' + (n === curYears ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">Seed<input class="text-input" id="synSeed" type="number" inputmode="numeric" value="' + curSeed + '"></label></div>' +
      '<div class="btn-row"><button class="btn primary" type="button" id="btnGen">Generate market</button></div></div>';
    html += '<div class="option"><h4>Real US large caps</h4><p>Daily adjusted prices for ' + D.US_LARGE_CAPS.length + ' large US stocks with their sectors, from Yahoo Finance with Stooq as a fallback. Needs an internet connection and takes about a minute. Fundamentals such as eps aren’t included.</p>' +
      '<div class="row"><label class="field">Years<select class="select" id="realYears" style="min-width:84px">' + [2, 3, 5, 8].map(function (n) { return '<option' + (n === 5 ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="progress hidden" id="dlProg"><div></div></div><p class="note hidden" id="dlNote"></p>' +
      '<div class="btn-row"><button class="btn" type="button" id="btnDl">' + ICON.download + 'Download prices</button></div></div>';
    html += '<div class="option"><h4>Import a CSV file</h4><p>One row per stock per day. Required columns are date, ticker and close. Optional: open, high, low, volume, vwap, sharesout, sector, industry, subindustry. Any other numeric column becomes a data field you can use in expressions.</p>' +
      '<pre class="sample">date,ticker,open,high,low,close,volume,sector\n2024-01-02,AAPL,187.15,188.44,183.89,185.64,82488700,Tech\n2024-01-02,XOM,100.13,101.68,99.89,100.85,20195800,Energy</pre>' +
      '<div class="btn-row"><button class="btn" type="button" id="btnCsv">Choose CSV file</button></div></div>';
    html += '<h3 class="sec">Storage</h3><p class="note">' + S.history.length + ' simulations stored, ' + S.history.filter(function (h) { return h.starred; }).length + ' saved.</p>' +
      '<div class="btn-row"><button class="btn danger" type="button" id="btnReset">' + ICON.trash + 'Erase all app data</button></div>';
    el.innerHTML = html;

    $('#btnGen').addEventListener('click', function () {
      var opts = { stocks: +$('#synStocks').value, years: +$('#synYears').value, seed: parseInt($('#synSeed').value, 10) || 0 };
      overlay('Generating the market', opts.stocks + ' stocks, ' + opts.years + ' years plus a warm-up year');
      nextFrame().then(function () {
        var ds2 = D.generateSynthetic(opts);
        S.prefs.ds = { source: 'synthetic', stocks: opts.stocks, years: opts.years, seed: opts.seed };
        Store.remove('dataset.json');
        savePrefs();
        setDataset(ds2);
        overlay(false);
        toast('New market ready: ' + dsLabel(ds2));
      });
    });
    $('#btnDl').addEventListener('click', function () { downloadReal(+$('#realYears').value); });
    $('#btnCsv').addEventListener('click', function () { $('#fileInput').value = ''; $('#fileInput').click(); });
    $('#btnReset').addEventListener('click', function () {
      openSheet('<h3>Erase all app data?</h3><p class="note">This deletes every simulation, saved alpha and downloaded dataset, and resets your settings.</p>' +
        '<button class="menu-item danger" type="button" id="cfReset">' + ICON.trash + 'Erase everything</button><button class="menu-item" type="button" id="cfKeep">Cancel</button>', function (sh) {
        $('#cfReset', sh).addEventListener('click', function () {
          ['prefs.json', 'history.json', 'dataset.json'].forEach(Store.remove);
          location.reload();
        });
        $('#cfKeep', sh).addEventListener('click', function () { closeSheet(); });
      });
    });
  }
  function useLoadedDataset(ds, source) {
    var txt = D.serialize(ds);
    var stored = Store.write('dataset.json', txt);
    S.prefs.ds = { source: source, id: ds.id };
    if (!stored) S.prefs.ds = { source: 'synthetic', stocks: 500, years: 5, seed: 42 };
    savePrefs();
    setDataset(ds);
    if (!stored) toast('Loaded, but too large to keep after the app closes');
  }
  function downloadReal(years) {
    var btn = $('#btnDl'), prog = $('#dlProg'), note = $('#dlNote');
    if (!bridge) {
      note.classList.remove('hidden');
      note.textContent = 'Downloading prices only works inside the Android app; web browsers block these requests.';
    }
    btn.disabled = true;
    prog.classList.remove('hidden'); note.classList.remove('hidden');
    $('#dsPill').classList.add('busy');
    var list = D.US_LARGE_CAPS.slice(), total = list.length, done = 0, failed = [], series = {};
    function step() {
      done++;
      $('div', prog).style.width = (done / total * 100).toFixed(1) + '%';
      note.textContent = 'Downloaded ' + (done - failed.length) + ' of ' + total + (failed.length ? ', ' + failed.length + ' failed' : '');
    }
    function getOne(m) {
      return Native.http(D.yahooUrl(m[0], years)).then(function (r) {
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        series[m[0]] = D.parseYahoo(r.body);
      }).catch(function () {
        return Native.http(D.stooqUrl(m[0])).then(function (r) {
          if (r.status !== 200) throw new Error('HTTP ' + r.status);
          series[m[0]] = D.parseStooq(r.body);
        });
      }).catch(function () { failed.push(m[0]); }).then(step);
    }
    function worker() { var m = list.shift(); return m ? getOne(m).then(worker) : Promise.resolve(); }
    Promise.all([worker(), worker(), worker(), worker()]).then(function () {
      btn.disabled = false;
      $('#dsPill').classList.remove('busy');
      var got = total - failed.length;
      if (got < 20) {
        note.textContent = 'Only ' + got + ' of ' + total + ' stocks downloaded. Check your internet connection and try again.';
        return;
      }
      try {
        var ds = D.datasetFromSeries(series, D.US_LARGE_CAPS, { years: years });
        useLoadedDataset(ds, 'yahoo');
        note.textContent = 'Loaded ' + ds.N + ' stocks, ' + ds.startDate + ' to ' + ds.endDate + (failed.length ? '. Missing: ' + failed.join(', ') : '');
        toast('Real market data ready');
        renderData();
      } catch (e) { note.textContent = 'Could not build the dataset: ' + e.message; }
    });
  }
  function bindFileInput() {
    $('#fileInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      overlay('Reading ' + f.name, Math.round(f.size / 1024) + ' KB');
      var rd = new FileReader();
      rd.onload = function () {
        nextFrame().then(function () {
          try {
            var ds = D.parseCsvDataset(String(rd.result), f.name.replace(/\.[^.]+$/, ''));
            useLoadedDataset(ds, 'csv');
            overlay(false);
            toast('Imported ' + ds.N + ' stocks over ' + ds.T + ' days');
            if (S.tab === 'data') renderData();
          } catch (e) { overlay(false); toast('Import failed: ' + e.message); }
        });
      };
      rd.onerror = function () { overlay(false); toast('Could not read that file'); };
      rd.readAsText(f);
    });
  }

  // ---------------------------------------------------------------- learn
  var HOW_IT_WORKS =
    '<div class="prose">' +
    '<h3>What happens when you tap Simulate</h3>' +
    '<p>Every trading day the expression produces one number per stock. The simulator turns those numbers into a long-short portfolio, holds it for a day, and records the profit or loss. In order:</p>' +
    '<ol><li>Pick the universe: the N most liquid stocks by 20-day dollar volume, re-ranked every 21 trading days.</li>' +
    '<li>With pasteurization on, data for stocks outside the universe is hidden from your expression.</li>' +
    '<li>Evaluate the expression for every day and stock.</li>' +
    '<li>Apply the delay: with delay 1, today’s portfolio uses values computed from yesterday’s data.</li>' +
    '<li>Apply decay: a linearly weighted average of the last n days of alpha values.</li>' +
    '<li>Neutralize: subtract the mean within each market, sector, industry or sub-industry so each group nets to zero.</li>' +
    '<li>Scale so the absolute weights add up to the $20M book, then cap each stock at the truncation limit.</li>' +
    '<li>Earn the next day’s returns on those weights. Repeat.</li></ol>' +
    '<h3>Metrics</h3>' +
    '<dl><dt>Sharpe</dt><dd>Average daily PnL divided by its standard deviation, annualised.</dd></dl>' +
    '<div class="formula">Sharpe = mean(PnL) / std(PnL) × √252</div>' +
    '<dl><dt>Turnover</dt><dd>Average share of the book traded each day: the sum of |w<sub>t</sub> − w<sub>t−1</sub>| over the sum of |w<sub>t</sub>|.</dd>' +
    '<dt>Returns</dt><dd>Annualised PnL divided by half the book size ($10M).</dd>' +
    '<dt>Drawdown</dt><dd>Largest peak-to-trough fall in cumulative PnL, as a share of half the book.</dd>' +
    '<dt>Margin</dt><dd>Total PnL per dollar traded, in basis points (‱). It shows how much room there is for trading costs.</dd>' +
    '<dt>Fitness</dt><dd>Rewards a high Sharpe earned with strong returns and low turnover.</dd></dl>' +
    '<div class="formula">Fitness = Sharpe × √( |Returns| / max(Turnover, 0.125) )</div>' +
    '<h3>Submission checks</h3>' +
    '<p>These mirror the in-sample tests an alpha has to pass on the BRAIN platform. Cutoffs are for delay 1, with delay 0 cutoffs in brackets.</p>' +
    '<dl><dt>Sharpe</dt><dd>At least 1.25 (2.0).</dd><dt>Fitness</dt><dd>At least 1.0 (1.3).</dd>' +
    '<dt>Turnover</dt><dd>Between 1% and 70%.</dd><dt>Weight concentration</dt><dd>No stock above 10% of the book on any day.</dd>' +
    '<dt>Sub-universe robustness</dt><dd>The alpha still works on the next smaller universe: its Sharpe there must exceed 0.75 × √(sub-universe size / universe size) × the main Sharpe.</dd>' +
    '<dt>Self-correlation</dt><dd>Daily PnL correlation with each alpha you have saved stays below 0.7, unless the new alpha’s Sharpe is at least 10% higher.</dd></dl>' +
    '<h3>How close is this to BRAIN?</h3>' +
    '<p>The expression language, settings, pipeline and metrics follow the BRAIN platform’s documented behaviour, and the operator names and arguments match. The data is the big difference: BRAIN uses thousands of real stocks and hundreds of datasets, while this app uses a synthetic market, a downloaded set of US large caps, or your own CSV. Treat results here as practice and idea screening, then confirm on the real platform. Thresholds and small details such as the sub-universe cutoff are approximations.</p>' +
    '<h3>About the synthetic market</h3>' +
    '<p>Returns come from a market factor with volatility regimes, sector, industry and sub-industry factors, and fat-tailed stock-specific noise. Small, persistent effects are built in: short-term reversal (stronger after low-volume moves and intraday moves), slow momentum, value relative to earnings, profitability and a low-volatility tilt. About 8% of stocks list partway through and 5% delist, so missing data is realistic. Fundamentals update quarterly, 45 days after quarter end.</p>' +
    '</div>';
  function renderLearn() {
    var el = $('#view-learn'), tab = S.prefs.learnTab || 'ops';
    var html = '<h2 class="page">Reference</h2><div class="learn-tabs" id="learnTabs">' +
      [['ops', 'Operators'], ['fields', 'Data fields'], ['how', 'How it works']].map(function (t) {
        return '<button type="button" data-t="' + t[0] + '" class="' + (tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div><div id="learnBody"></div>';
    el.innerHTML = html;
    $('#learnTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S.prefs.learnTab = b.dataset.t; savePrefs(); renderLearn();
    });
    var body = $('#learnBody');
    if (tab === 'how') { body.innerHTML = HOW_IT_WORKS; return; }
    if (tab === 'fields') {
      var ds = S.ds, h2 = '';
      if (ds) {
        var cats = {};
        Object.keys(ds.fields).forEach(function (f) { var c = ds.fieldInfo[f].cat; (cats[c] = cats[c] || []).push(f); });
        Object.keys(cats).forEach(function (c) {
          h2 += '<div class="op-group"><h3 class="sec">' + esc(c) + '</h3>' + cats[c].map(function (f) {
            return '<div class="op"><div class="sig">' + esc(f) + '</div><div class="desc">' + esc(ds.fieldInfo[f].desc) + '</div><button type="button" data-ins="' + esc(f) + '">Insert</button></div>';
          }).join('') + '</div>';
        });
        h2 += '<div class="op-group"><h3 class="sec">Groups</h3>' + ['sector', 'industry', 'subindustry', 'market'].map(function (g) {
          var n = g === 'market' ? 1 : ds.groups[g].names.length;
          return '<div class="op"><div class="sig">' + g + '</div><div class="desc">' + esc(D.GROUP_INFO[g]) + (g !== 'market' ? ', ' + n + ' groups in this dataset' : '') + '</div><button type="button" data-ins="' + g + '">Insert</button></div>';
        }).join('') + '</div>';
      }
      body.innerHTML = h2;
      bindInsert(body);
      return;
    }
    body.innerHTML = '<input class="search" id="opSearch" type="search" placeholder="Search ' + Object.keys(E.OPS).length + ' operators" autocomplete="off" autocapitalize="off"><div id="opList"></div>';
    var ops = E.operatorList();
    var catOrder = ['Arithmetic', 'Logical', 'Time Series', 'Cross Sectional', 'Group', 'Transformational'];
    function draw(q) {
      q = (q || '').toLowerCase();
      var out = '';
      catOrder.forEach(function (c) {
        var items = ops.filter(function (o) { return o.cat === c && (!q || o.name.indexOf(q) >= 0 || o.desc.toLowerCase().indexOf(q) >= 0); });
        if (!items.length) return;
        out += '<div class="op-group"><h3 class="sec">' + c + '<small>' + items.length + '</small></h3>' + items.map(function (o) {
          return '<div class="op"><div class="sig">' + esc(o.sig) + '</div><div class="desc">' + esc(o.desc) + '</div><button type="button" data-fn="' + o.name + '">Insert</button></div>';
        }).join('') + '</div>';
      });
      if (!q || 'operators + - * / ^ < > == != && || ! ?'.indexOf(q) >= 0) {
        out += '<div class="op-group"><h3 class="sec">Operator symbols</h3><div class="op"><div class="sig">+  −  *  /  ^</div><div class="desc">Arithmetic. ^ is power.</div></div>' +
          '<div class="op"><div class="sig">&lt;  &lt;=  &gt;  &gt;=  ==  !=</div><div class="desc">Comparisons give 1 (true) or 0 (false).</div></div>' +
          '<div class="op"><div class="sig">&amp;&amp;  ||  !  cond ? a : b</div><div class="desc">Logic and the conditional expression.</div></div>' +
          '<div class="op"><div class="sig">name = expression;</div><div class="desc">Store an intermediate result. The last line is the alpha.</div></div>' +
          '<div class="op"><div class="sig"># comment</div><div class="desc">Ignored until the end of the line; // and /* */ also work.</div></div></div>';
      }
      $('#opList').innerHTML = out || '<p class="note">No operator matches “' + esc(q) + '”.</p>';
    }
    draw('');
    $('#opSearch').addEventListener('input', function () { draw(this.value); });
    bindInsert(body);
  }
  function bindInsert(container) {
    container.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-fn],button[data-ins]');
      if (!b) return;
      if (!lastCaret) lastCaret = [ta.value.length, ta.value.length];
      if (b.dataset.fn) insertSnippet(b.dataset.fn, true); else insertSnippet(b.dataset.ins, false);
      setTab('simulate');
      toast('Inserted into the editor');
    });
  }

  // ----------------------------------------------------------------- boot
  function detectKeyboard() {
    var base = window.innerHeight;
    window.addEventListener('resize', function () {
      var h = window.innerHeight;
      if (h > base) base = h;
      document.body.classList.toggle('kb-open', h < base - 150);
      $('#tabbar').classList.toggle('hidden', h < base - 150);
      $('#simDock').style.bottom = h < base - 150 ? '0' : '';
    });
  }
  function boot() {
    overlay('Preparing the market', '');
    var prefs = Store.json('prefs.json', null);
    if (prefs) {
      S.prefs = Object.assign(S.prefs, prefs);
      S.prefs.settings = Object.assign({}, DEFAULT_SETTINGS, prefs.settings || {});
    }
    S.history = Store.json('history.json', []) || [];
    setupEditor();
    bindChips();
    bindSettings();
    bindFileInput();
    detectKeyboard();
    $$('#tabbar button').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });
    $('#dsPill').addEventListener('click', function () { setTab('data'); });
    $('#overlaySub').textContent = 'Building ' + (S.prefs.ds && S.prefs.ds.source === 'synthetic' ? S.prefs.ds.stocks + ' stocks over ' + S.prefs.ds.years + ' years' : 'your saved dataset');
    nextFrame().then(function () {
      var ds = null, p = S.prefs.ds || {};
      if (p.source && p.source !== 'synthetic') {
        var txt = Store.read('dataset.json');
        if (txt) { try { ds = D.deserialize(txt); } catch (e) { ds = null; } }
      }
      if (!ds) {
        var sp = p.source === 'synthetic' ? p : { stocks: 500, years: 5, seed: 42 };
        ds = D.generateSynthetic(sp);
        S.prefs.ds = { source: 'synthetic', stocks: sp.stocks, years: sp.years, seed: sp.seed };
      }
      setDataset(ds);
      S.current = S.history[0] || null;
      overlay(false);
      layoutEditor();
    });
  }
  window.addEventListener('error', function (e) { try { overlay(false); S.busy = false; toast('Something went wrong: ' + (e.message || 'unknown error')); } catch (x) { /* ignore */ } });
  document.addEventListener('DOMContentLoaded', boot);
})();
