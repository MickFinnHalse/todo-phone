/*
 * To-do phone app (PHONE-APP-PLAN.md, Option B). Phase 1: read-only personal view.
 *
 * Talks to the Apps Script web app's JSON API (doGet ?api=...). Neither the
 * script URL nor the app key is in this public code: each phone gets both once
 * from a setup link (#setup=...) and keeps them in localStorage. The URL
 * fragment is never sent to any server.
 *
 * Filtering happens on the server, on rows read into memory. Nothing here can
 * touch the Sheet's own shared filter: picking a person only changes this phone.
 */
(function () {
  'use strict';

  var LS = {
    api: 'todo.api', key: 'todo.key', person: 'todo.person',
    cache: function (p) { return 'todo.cache.' + p.toLowerCase(); }
  };
  var P_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'Y-Cadence'];
  var STALE_MS = 60 * 1000;   // refresh on return to the app if older than this
  var lastLoad = 0;
  var loading = false;

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
    var timer = setTimeout(function () { ctl.abort(); }, 30000);
    return fetch(url + '?' + q.toString(), { signal: ctl.signal, credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { code: j.code });
        return j.data;
      }, function (e) { clearTimeout(timer); throw Object.assign(e, { code: e.code || 'network' }); });
  }

  // ---------- small UI helpers ----------
  function notice(text, isError) {
    var n = $('notice');
    if (!text) { n.hidden = true; return; }
    n.textContent = text;
    n.className = 'notice' + (isError ? ' error' : '');
    n.hidden = false;
  }
  function show(id) {
    ['setup', 'picker', 'list'].forEach(function (s) { $(s).hidden = (s !== id); });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function spin(on) { $('refresh').classList.toggle('spin', on); }

  // ---------- dates ----------
  function parseYmd(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dueLabel(due, today) {
    if (!due) return null;
    var days = Math.round((parseYmd(due) - parseYmd(today)) / 86400000);
    var d = parseYmd(due);
    var nice = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (days < 0) return { text: 'Overdue · ' + nice, cls: 'overdue' };
    if (days === 0) return { text: 'Today', cls: 'today' };
    if (days === 1) return { text: 'Tomorrow', cls: '' };
    return { text: nice, cls: '' };
  }

  // ---------- render ----------
  function sortTasks(tasks) {
    return tasks.map(function (t, i) { return { t: t, i: i }; }).sort(function (a, b) {
      var pa = P_ORDER.indexOf(a.t.p), pb = P_ORDER.indexOf(b.t.p);
      if (pa === -1) pa = 99; if (pb === -1) pb = 99;
      if (pa !== pb) return pa - pb;
      if (a.t.due !== b.t.due) { if (!a.t.due) return 1; if (!b.t.due) return -1; return a.t.due < b.t.due ? -1 : 1; }
      return a.i - b.i;
    }).map(function (x) { return x.t; });
  }

  function renderList(data, person, fromCache) {
    var ul = $('tasks');
    ul.textContent = '';
    var tasks = sortTasks(data.tasks || []);
    var overdue = tasks.filter(function (t) { return t.due && t.due < data.today; }).length;
    $('summary').textContent = tasks.length + ' open task' + (tasks.length === 1 ? '' : 's') +
      (overdue ? ' · ' + overdue + ' overdue' : '') +
      (fromCache ? ' · saved copy from ' + new Date(data.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    if (!tasks.length) {
      ul.appendChild(el('li', 'empty', 'Nothing on your list. Nice.'));
    }
    tasks.forEach(function (t) {
      var li = el('li', 'task');
      li.appendChild(el('div', 'thing', t.thing));
      var meta = el('div', 'meta');
      if (t.p) meta.appendChild(el('span', 'pill ' + t.p, t.p));
      var due = dueLabel(t.due, data.today);
      if (due) meta.appendChild(el('span', 'due ' + due.cls, due.text));
      if (t.urgency) meta.appendChild(el('span', '', t.urgency));
      if (t.project) meta.appendChild(el('span', '', t.project));
      else if (t.category) meta.appendChild(el('span', '', t.category));
      if (t.person && t.person.toLowerCase() !== person.toLowerCase()) meta.appendChild(el('span', '', t.person));
      if (t.status && t.status !== 'A_Not started') meta.appendChild(el('span', '', t.status.replace(/^[A-Z]_/, '')));
      li.appendChild(meta);
      if (t.notes) li.appendChild(el('div', 'notes', t.notes));
      ul.appendChild(li);
    });
    show('list');
  }

  // ---------- flows ----------
  function loadList() {
    var person = localStorage.getItem(LS.person);
    if (!person) return showPicker();
    $('who').textContent = person;
    var cached = localStorage.getItem(LS.cache(person));
    if (cached && $('list').hidden) { try { renderList(JSON.parse(cached), person, true); } catch (e) { /* ignore */ } }
    if (loading) return;
    loading = true; spin(true);
    api('list', { person: person }).then(function (data) {
      data.at = Date.now();
      localStorage.setItem(LS.cache(person), JSON.stringify(data));
      lastLoad = Date.now();
      notice('');
      renderList(data, person, false);
    }).catch(function (e) {
      if (e.code === 'setup') { show('setup'); return; }
      if (e.code === 'auth') { notice('This phone\'s app key isn\'t accepted any more. Ask the person who set this up for a new setup link.', true); return; }
      notice(e.code === 'network'
        ? (cached ? 'No connection. Showing the last saved list.' : 'No connection. Try again when you have signal.')
        : e.message, true);
    }).then(function () { loading = false; spin(false); });
  }

  function showPicker() {
    var current = localStorage.getItem(LS.person);
    $('who').textContent = current || 'Pick';
    show('picker');
    var box = $('people');
    box.textContent = 'Loading…';
    api('vocab').then(function (v) {
      box.textContent = '';
      v.person.filter(function (p) { return p !== '?'; }).forEach(function (p) {
        var b = el('button', '', p);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(p === current));
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
    if (!$('picker').hidden && localStorage.getItem(LS.person)) { loadList(); return; }
    if (!$('picker').hidden) { showPicker(); return; }
    loadList();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('list').hidden && Date.now() - lastLoad > STALE_MS) loadList();
  });

  readSetupLink();
  if (!localStorage.getItem(LS.api) || !localStorage.getItem(LS.key)) show('setup');
  else loadList();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without it */ });
})();
