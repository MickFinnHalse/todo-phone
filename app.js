/*
 * To-do phone app (PHONE-APP-PLAN.md, Option B).
 * Phase 1: personal view. Phase 2: add, mark done, edit, clear done, sort.
 *
 * Talks to the Apps Script web app's JSON API (doGet ?api=...). Neither the
 * script URL nor the app key is in this public code: each phone gets both once
 * from a setup link (#setup=...) and keeps them in localStorage. The URL
 * fragment is never sent to any server.
 *
 * Every write goes through the server's own handlers (the same ones Claude's
 * tools use) and returns the fresh list. Sorting happens on this phone only:
 * it never reorders the Sheet, so nobody else's order changes.
 */
(function () {
  'use strict';

  var LS = {
    api: 'todo.api', key: 'todo.key', person: 'todo.person', vocab: 'todo.vocab', sort: 'todo.sort',
    cache: function (p) { return 'todo.cache.' + p.toLowerCase(); }
  };
  var P_FALLBACK = ['P0', 'P1', 'P2', 'P3', 'P4', 'Y-Cadence'];
  var URGENCY_ORDER = ['Today', 'Tomorrow', 'Soon', 'Later'];
  var STALE_MS = 60 * 1000;   // refresh on return to the app if older than this
  var UNDO_MS = 3000;         // how long a ticked task waits before it's sent

  var SORT_FIELDS = [
    { key: 'p', label: 'Priority' }, { key: 'due', label: 'Due date' }, { key: 'urgency', label: 'Urgency' },
    { key: 'order', label: 'Order' }, { key: 'status', label: 'Status' }, { key: 'category', label: 'Category' },
    { key: 'project', label: 'Project' }, { key: 'person', label: 'Person' }, { key: 'thing', label: 'Task text' }
  ];
  var PRESETS = [
    { label: 'Priority, then due date', specs: [{ key: 'p' }, { key: 'due' }] },
    { label: 'Due date, priority, order', specs: [{ key: 'due' }, { key: 'p' }, { key: 'order' }] },
    { label: 'Priority, order, due date', specs: [{ key: 'p' }, { key: 'order' }, { key: 'due' }] },
    { label: 'Urgency, priority, order', specs: [{ key: 'urgency' }, { key: 'p' }, { key: 'order' }] }
  ];

  var lastLoad = 0, loading = false, current = null, editing = null;
  var pendingDone = {};       // id -> timer for ticked tasks still inside the undo window

  var $ = function (id) { return document.getElementById(id); };

  // ---------- setup link: #setup=<base64url of {"u": execUrl, "k": appKey}> ----------
  function readSetupLink() {
    var m = location.hash.match(/^#setup=([A-Za-z0-9_\-]+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search); // drop the key from the address bar
    try {
      var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      var cfg = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_\-]+\/exec$/.test(cfg.u) || !cfg.k) throw new Error('bad link');
      localStorage.setItem(LS.api, cfg.u);
      localStorage.setItem(LS.key, cfg.k);
      notice('This phone is set up.', false);
    } catch (e) {
      notice('That setup link didn\'t work. Ask the person who set this up to send it again.', true);
    }
  }

  // ---------- API ----------
  function api(action, params) {
    var url = localStorage.getItem(LS.api), key = localStorage.getItem(LS.key);
    if (!url || !key) return Promise.reject(Object.assign(new Error('Not set up'), { code: 'setup' }));
    var q = new URLSearchParams(Object.assign({ api: action, k: key }, params || {}));
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 45000);
    return fetch(url + '?' + q.toString(), { signal: ctl.signal, credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { code: j.code });
        return j.data;
      }, function (e) { clearTimeout(timer); throw Object.assign(e, { code: e.code || 'network' }); });
  }

  function me() { return localStorage.getItem(LS.person) || ''; }

  /** A write: sends it, renders the fresh list that comes back, reports the result. */
  function write(action, params, okText) {
    spin(true);
    return api(action, Object.assign({ me: me() }, params)).then(function (data) {
      saveList(data.list);
      renderList(data.list, false);
      toast(okText || data.message, false);
      return data;
    }).catch(function (e) {
      toast(e.code === 'network'
        ? 'Couldn\'t reach the list. Check your connection, then refresh to see whether it saved.'
        : e.code === 'auth' ? 'This phone\'s app key isn\'t accepted. Ask for a new setup link.'
          : e.message, true);
      throw e;
    }).finally(function () { spin(false); });
  }

  // ---------- small UI helpers ----------
  function notice(text, isError) {
    var n = $('notice');
    if (!text) { n.hidden = true; return; }
    n.textContent = text;
    n.className = 'notice' + (isError ? ' error' : '');
    n.hidden = false;
  }
  var toastTimer = null;
  function toast(text, isError) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 7000 : 3500);
  }
  function show(id) {
    ['setup', 'picker', 'list'].forEach(function (s) { $(s).hidden = (s !== id); });
    var inList = id === 'list';
    $('addBtn').hidden = !inList;
    $('sortBtn').hidden = !inList;
    $('menuBtn').hidden = !inList;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function spin(on) { $('refresh').classList.toggle('spin', on); }
  function short(s) { s = String(s); return s.length > 40 ? s.slice(0, 38) + '…' : s; }

  // ---------- vocabulary (the sheet's own dropdown values) ----------
  function vocab() { try { return JSON.parse(localStorage.getItem(LS.vocab)) || null; } catch (e) { return null; } }
  function loadVocab() {
    return api('vocab').then(function (v) { localStorage.setItem(LS.vocab, JSON.stringify(v)); return v; });
  }
  function priorities() {
    var v = vocab();
    var list = (v && v.p && v.p.length) ? v.p : P_FALLBACK;
    return list.filter(function (p) { return p !== 'Z-Done'; });
  }

  // ---------- dates ----------
  function parseYmd(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dueLabel(due, today) {
    if (!due) return null;
    var days = Math.round((parseYmd(due) - parseYmd(today)) / 86400000);
    var nice = parseYmd(due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (days < 0) return { text: 'Overdue · ' + nice, cls: 'overdue' };
    if (days === 0) return { text: 'Today', cls: 'today' };
    if (days === 1) return { text: 'Tomorrow', cls: '' };
    return { text: nice, cls: '' };
  }

  // ---------- sort (this phone only) ----------
  function sortSpecs() {
    try { var s = JSON.parse(localStorage.getItem(LS.sort)); if (s && s.length) return s; } catch (e) { /* default */ }
    return PRESETS[0].specs;
  }
  function compareField(key, a, b) {
    var ab = (a === '' || a === undefined || a === null), bb = (b === '' || b === undefined || b === null);
    if (ab && bb) return 0;
    if (ab) return 1;                 // blanks always last, whichever direction
    if (bb) return -1;
    if (key === 'p') {
      var order = priorities(), ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia === -1) ia = 99; if (ib === -1) ib = 99;
      return ia - ib;
    }
    if (key === 'urgency') {
      var ua = URGENCY_ORDER.indexOf(a), ub = URGENCY_ORDER.indexOf(b);
      if (ua === -1) ua = 99; if (ub === -1) ub = 99;
      if (ua !== ub) return ua - ub;
    }
    if (key === 'order' && !isNaN(+a) && !isNaN(+b)) return +a - +b;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }
  function sortTasks(tasks) {
    var specs = sortSpecs();
    return tasks.map(function (t, i) { return { t: t, i: i }; }).sort(function (x, y) {
      for (var s = 0; s < specs.length; s++) {
        var k = specs[s].key;
        var av = x.t[k], bv = y.t[k];
        var c = compareField(k, av, bv);
        var blank = (av === '' || bv === '');
        if (specs[s].desc && !blank) c = -c;
        if (c) return c;
      }
      return x.i - y.i;               // otherwise keep the sheet's order
    }).map(function (z) { return z.t; });
  }
  function sortLabel() {
    var specs = JSON.stringify(sortSpecs());
    for (var i = 0; i < PRESETS.length; i++) if (JSON.stringify(PRESETS[i].specs) === specs) return PRESETS[i].label;
    return sortSpecs().map(function (s) {
      var f = SORT_FIELDS.filter(function (x) { return x.key === s.key; })[0];
      return (f ? f.label : s.key) + (s.desc ? ' ↓' : '');
    }).join(', ');
  }

  // ---------- render ----------
  function saveList(data) {
    data.at = Date.now();
    current = data;
    localStorage.setItem(LS.cache(me()), JSON.stringify(data));
    lastLoad = Date.now();
  }

  function renderList(data, fromCache) {
    current = data;
    var person = me();
    var ul = $('tasks');
    ul.textContent = '';
    var tasks = sortTasks(data.tasks || []);
    var overdue = tasks.filter(function (t) { return t.due && t.due < data.today; }).length;
    $('summary').textContent = tasks.length + ' open task' + (tasks.length === 1 ? '' : 's') +
      (overdue ? ' · ' + overdue + ' overdue' : '') + ' · sorted by ' + sortLabel().toLowerCase() +
      (fromCache ? ' · saved copy from ' + new Date(data.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    if (!tasks.length) ul.appendChild(el('li', 'empty', 'Nothing on your list. Tap + to add a task.'));

    tasks.forEach(function (t) {
      var li = el('li', 'task');
      li.dataset.id = t.id;
      if (pendingDone[t.id]) li.classList.add('pending');

      var tick = el('button', 'tick');
      tick.type = 'button';
      tick.setAttribute('aria-label', 'Mark done: ' + t.thing);
      var circle = el('span');
      circle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
      tick.appendChild(circle);
      tick.addEventListener('click', function () { toggleDone(t, li); });
      li.appendChild(tick);

      var body = el('div', 'body');
      body.setAttribute('role', 'button');
      body.tabIndex = 0;
      body.appendChild(el('div', 'thing', t.thing));
      var meta = el('div', 'meta');
      if (t.p) meta.appendChild(el('span', 'pill ' + t.p, t.p));
      var due = dueLabel(t.due, data.today);
      if (due) meta.appendChild(el('span', 'due ' + due.cls, due.text));
      if (t.urgency) meta.appendChild(el('span', '', t.urgency));
      if (t.category) meta.appendChild(el('span', 'cat', t.category));
      if (t.project) meta.appendChild(el('span', '', t.project));
      if (t.subcategory) meta.appendChild(el('span', '', t.subcategory));
      if (t.time) meta.appendChild(el('span', '', t.time));
      if (t.person && t.person.toLowerCase() !== person.toLowerCase()) meta.appendChild(el('span', '', t.person));
      if (t.status && t.status !== 'A_Not started') meta.appendChild(el('span', '', t.status.replace(/^[A-Z]_/, '')));
      body.appendChild(meta);
      if (t.notes) body.appendChild(el('div', 'notes', t.notes));
      body.appendChild(el('div', 'undo', 'Marked done. Tap the tick again to undo.'));
      body.addEventListener('click', function () { if (!pendingDone[t.id]) openTaskDialog(t); });
      li.appendChild(body);
      ul.appendChild(li);
    });
    show('list');
  }

  // ---------- mark done (with a short undo window) ----------
  function toggleDone(t, li) {
    if (pendingDone[t.id]) {                       // undo
      clearTimeout(pendingDone[t.id]);
      delete pendingDone[t.id];
      li.classList.remove('pending');
      return;
    }
    li.classList.add('pending');
    pendingDone[t.id] = setTimeout(function () {
      li.classList.add('saving');
      write('complete', { id: t.id, expect: t.thing.slice(0, 40) }, 'Done: ' + short(t.thing))
        .then(function () { delete pendingDone[t.id]; }, function () {
          delete pendingDone[t.id];              // failed: show it as open again
          if (current) renderList(current, false);
        });
    }, UNDO_MS);
  }

  // ---------- add / edit ----------
  function fillSelect(sel, values, value, blankLabel) {
    sel.textContent = '';
    if (blankLabel !== undefined) { var o = el('option', '', blankLabel); o.value = ''; sel.appendChild(o); }
    var list = values.slice();
    if (value && list.indexOf(value) === -1) list.unshift(value);  // keep an unusual current value visible
    list.forEach(function (v) { var o = el('option', '', v); o.value = v; sel.appendChild(o); });
    sel.value = value || '';
  }

  function openTaskDialog(t) {
    if (!vocab()) {                  // dropdown lists not saved yet: fetch them first
      spin(true);
      loadVocab().then(function () { openTaskDialog(t); }, function () {
        toast('Couldn\'t load the dropdown lists. Check your connection and try again.', true);
      }).finally(function () { spin(false); });
      return;
    }
    editing = t || null;
    var v = vocab() || {};
    var people = (v.person || [me()]).filter(function (p) { return p !== '?'; });
    $('taskTitle').textContent = t ? 'Edit task' : 'Add a task';
    $('fThing').value = t ? t.thing : '';
    fillSelect($('fP'), priorities(), t ? t.p : 'P1');
    $('fDue').value = t ? (t.due || '') : (current && current.today) || '';
    fillSelect($('fUrgency'), v.urgency || URGENCY_ORDER, t ? t.urgency : '', '—');
    // A phone writes one person per task; a shared task (two names) keeps its value unless changed.
    fillSelect($('fPerson'), people, t ? t.person : me());
    // New tasks may leave Category blank: the server then guesses it from your history.
    fillSelect($('fCategory'), (v.category || []).filter(function (c) { return c !== 'UNSORTED'; }), t ? t.category : '', t ? '—' : 'Guess for me');
    fillSelect($('fProject'), (v.project || []).filter(function (c) { return c !== 'UNSORTED'; }), t ? t.project : '', '—');
    fillSelect($('fSubcategory'), v.subcategory || [], t ? t.subcategory : '', '—');
    fillSelect($('fStatus'), v.status || [], t ? t.status : '', '—');
    $('fTime').value = t ? (t.time || '') : '';
    $('fNotes').value = t ? (t.notes || '') : '';
    $('taskError').hidden = true;
    $('taskSave').disabled = false;
    $('taskDialog').showModal();
    if (!t) $('fThing').focus();
  }

  function taskFormValues() {
    return {
      thing: $('fThing').value.trim(), p: $('fP').value, due: $('fDue').value,
      urgency: $('fUrgency').value, person: $('fPerson').value, notes: $('fNotes').value.trim(),
      category: $('fCategory').value, project: $('fProject').value, subcategory: $('fSubcategory').value,
      status: $('fStatus').value, time: $('fTime').value.trim()
    };
  }

  function saveTask(ev) {
    ev.preventDefault();
    var f = taskFormValues(), err = $('taskError');
    if (!f.thing) { err.textContent = 'Type the task first.'; err.hidden = false; return; }
    var params = {}, action, okText;
    if (!editing) {
      Object.keys(f).forEach(function (k) { if (f[k]) params[k] = f[k]; });
      action = 'add'; okText = 'Added: ' + short(f.thing);
    } else {
      var cleared = [];
      Object.keys(f).forEach(function (k) {
        var before = String(editing[k] || '').trim();
        if (f[k] === before) return;
        if (!f[k]) cleared.push(k); else params[k] = f[k];
      });
      if (cleared.length) {
        err.textContent = 'The phone can\'t empty a field yet (' + cleared.join(', ') + '). Change it in the sheet, or pick a value.';
        err.hidden = false; return;
      }
      if (!Object.keys(params).length) { $('taskDialog').close(); return; }
      params.id = editing.id;
      action = 'update'; okText = 'Saved: ' + short(f.thing);
    }
    $('taskSave').disabled = true;
    write(action, params, okText).then(function () { $('taskDialog').close(); })
      .catch(function (e) { err.textContent = e.code === 'network' ? 'Couldn\'t reach the list. Nothing may have been saved; refresh to check.' : e.message; err.hidden = false; })
      .finally(function () { $('taskSave').disabled = false; });
  }

  // ---------- sort dialog ----------
  function openSortDialog() {
    var box = $('presets'), now = JSON.stringify(sortSpecs());
    box.textContent = '';
    PRESETS.forEach(function (p) {
      var b = el('button', '', p.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(JSON.stringify(p.specs) === now));
      b.addEventListener('click', function () { applySort(p.specs); });
      box.appendChild(b);
    });
    var custom = $('custom'), specs = sortSpecs();
    custom.textContent = '';
    for (var i = 0; i < 3; i++) {
      var row = el('div', 'row');
      var f = el('select'); f.id = 'cf' + i;
      var o0 = el('option', '', i === 0 ? 'Pick a field' : '(none)'); o0.value = ''; f.appendChild(o0);
      SORT_FIELDS.forEach(function (sf) { var o = el('option', '', sf.label); o.value = sf.key; f.appendChild(o); });
      f.value = specs[i] ? specs[i].key : '';
      var d = el('select'); d.id = 'cd' + i;
      [['', 'Ascending'], ['desc', 'Descending']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; d.appendChild(o); });
      d.value = specs[i] && specs[i].desc ? 'desc' : '';
      row.appendChild(f); row.appendChild(d);
      custom.appendChild(row);
    }
    $('sortDialog').showModal();
  }
  function applySort(specs) {
    localStorage.setItem(LS.sort, JSON.stringify(specs));
    $('sortDialog').close();
    if (current) renderList(current, false);
  }
  function applyCustomSort(ev) {
    ev.preventDefault();
    var specs = [];
    for (var i = 0; i < 3; i++) {
      var k = $('cf' + i).value;
      if (k && !specs.some(function (s) { return s.key === k; })) {
        var s = { key: k };
        if ($('cd' + i).value === 'desc') s.desc = true;
        specs.push(s);
      }
    }
    if (!specs.length) { toast('Pick at least one field to sort by.', true); return; }
    applySort(specs);
  }

  // ---------- clear done ----------
  function clearDone() {
    if (!confirm('Move every task marked Z-Done in the sheet to the Done tab?')) return;
    $('menuDialog').close();
    write('clearDone', {}).catch(function () { /* toast already shown */ });
  }

  // ---------- flows ----------
  function loadList() {
    var person = me();
    if (!person) return showPicker();
    $('who').textContent = person;
    var cached = localStorage.getItem(LS.cache(person));
    if (cached && $('list').hidden) { try { renderList(JSON.parse(cached), true); } catch (e) { /* ignore */ } }
    loadVocab().catch(function () { /* the list still works; dropdowns use the saved copy */ });
    if (loading) return;
    loading = true; spin(true);
    api('list', { person: person }).then(function (data) {
      saveList(data);
      notice('');
      renderList(data, false);
    }).catch(function (e) {
      if (e.code === 'setup') { show('setup'); return; }
      if (e.code === 'auth') { notice('This phone\'s app key isn\'t accepted any more. Ask the person who set this up for a new setup link.', true); return; }
      notice(e.code === 'network'
        ? (cached ? 'No connection. Showing the last saved list; changes need a connection.' : 'No connection. Try again when you have signal.')
        : e.message, true);
    }).then(function () { loading = false; spin(false); });
  }

  function showPicker() {
    var currentPerson = me();
    $('who').textContent = currentPerson || 'Pick';
    show('picker');
    var box = $('people');
    box.textContent = 'Loading…';
    loadVocab().then(function (v) {
      box.textContent = '';
      v.person.filter(function (p) { return p !== '?'; }).forEach(function (p) {
        var b = el('button', '', p);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(p === currentPerson));
        b.addEventListener('click', function () {
          localStorage.setItem(LS.person, p);
          $('list').hidden = true;
          loadList();
        });
        box.appendChild(b);
      });
    }).catch(function (e) {
      if (e.code === 'setup') { show('setup'); return; }
      box.textContent = '';
      notice(e.code === 'auth' ? 'This phone\'s app key isn\'t accepted. Ask the person who set this up for a new setup link.' : 'Couldn\'t load the names. Check your connection and try again.', true);
    });
  }

  // ---------- wire up ----------
  $('who').addEventListener('click', showPicker);
  $('refresh').addEventListener('click', function () {
    if (!$('picker').hidden && !me()) { showPicker(); return; }
    loadList();
  });
  $('addBtn').addEventListener('click', function () { openTaskDialog(null); });
  $('taskForm').addEventListener('submit', saveTask);
  $('taskCancel').addEventListener('click', function () { $('taskDialog').close(); });
  $('sortBtn').addEventListener('click', openSortDialog);
  $('sortForm').addEventListener('submit', applyCustomSort);
  $('sortCancel').addEventListener('click', function () { $('sortDialog').close(); });
  $('menuBtn').addEventListener('click', function () { markTheme(); $('menuDialog').showModal(); });

  // ---------- appearance: follow the phone, or force light/dark on this phone ----------
  function currentTheme() { try { return localStorage.getItem('todo.theme') || 'auto'; } catch (e) { return 'auto'; } }
  function markTheme() {
    var now = currentTheme();
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-choice]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-choice') === now));
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-choice]'), function (b) {
    b.addEventListener('click', function () {
      var choice = b.getAttribute('data-theme-choice');
      try { if (choice === 'auto') localStorage.removeItem('todo.theme'); else localStorage.setItem('todo.theme', choice); } catch (e) { /* still applies for this visit */ }
      if (choice === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', choice);
      markTheme();
    });
  });
  $('clearDoneBtn').addEventListener('click', clearDone);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('list').hidden && Date.now() - lastLoad > STALE_MS &&
      !Object.keys(pendingDone).length && !$('taskDialog').open) loadList();
  });

  readSetupLink();
  show('setup');
  if (localStorage.getItem(LS.api) && localStorage.getItem(LS.key)) loadList();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without it */ });
})();
