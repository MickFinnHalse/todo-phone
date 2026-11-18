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
    api: 'todo.api', key: 'todo.key', person: 'todo.person', vocab: 'todo.vocab', sort: 'todo.sort', hideWaiting: 'todo.hideWaiting',
    scope: 'todo.desk.scope', view: 'todo.desk.view', folded: 'todo.desk.folded',
    cache: function (p) { return 'todo.cache.' + p.toLowerCase(); }
  };
  var P_FALLBACK = ['P0', 'P1', 'P2', 'P3', 'P4', 'Y-Cadence'];
  var URGENCY_ORDER = ['Today', 'Tomorrow', 'Soon', 'Later'];
  var STALE_MS = 60 * 1000;   // refresh on return to the app if older than this
  var UNDO_MS = 3000;         // how long a ticked task waits before it's sent

  var SORT_FIELDS = [
    { key: 'p', label: 'Priority' }, { key: 'due', label: 'Due date' }, { key: 'urgency', label: 'Urgency' },
    { key: 'order', label: 'Order' }, { key: 'status', label: 'Status' }, { key: 'category', label: 'Category' },
    { key: 'project', label: 'Project' }, { key: 'subcategory', label: 'SubCategory' }, { key: 'person', label: 'Person' },
    { key: 'roi', label: 'ROI' }, { key: 'time', label: 'Time' }, { key: 'thing', label: 'Task text' }
  ];
  var PRESETS = [
    { label: 'Priority, then due date', specs: [{ key: 'p' }, { key: 'due' }] },
    { label: 'Due date, priority, order', specs: [{ key: 'due' }, { key: 'p' }, { key: 'order' }] },
    { label: 'Priority, order, due date', specs: [{ key: 'p' }, { key: 'order' }, { key: 'due' }] },
    { label: 'Urgency, priority, order', specs: [{ key: 'urgency' }, { key: 'p' }, { key: 'order' }] }
  ];

  var lastLoad = 0, loading = false, current = null, editing = null;
  var depChoice = [];         // the edit box's "Waits on" list: [{id, thing}]
  var pendingDone = {};       // id -> timer for ticked tasks still inside the undo window

  var $ = function (id) { return document.getElementById(id); };

  // ---------- setup link: #setup=<base64url of {"u": execUrl, "k": appKey}> ----------
  // Lenient on purpose: messaging apps sometimes add a trailing character, turn
  // the # into %23, or move the part into the query string.
  function applySetup(text) {
    var m = String(text || '').replace(/%23/gi, '#').replace(/%3D/gi, '=').match(/(?:^|[#?&\s])setup=([A-Za-z0-9_\-]{20,})/);
    if (!m) return null;
    try {
      var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      var cfg = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_\-]+\/exec$/.test(cfg.u) || !cfg.k) return false;
      localStorage.setItem(LS.api, cfg.u);
      localStorage.setItem(LS.key, cfg.k);
      return true;
    } catch (e) { return false; }
  }

  function readSetupLink() {
    if (!/setup(=|%3D)/i.test(location.href)) return;
    var ok = applySetup(location.href);
    history.replaceState(null, '', location.pathname); // drop the key from the address bar
    if (ok) notice('This device is set up.', false);
    else notice('That setup link didn\'t work. Ask the person who set this up to send it again.', true);
  }

  function pasteSetup() {
    var ok = applySetup($('setupPaste').value);
    $('setupPaste').value = '';
    if (!ok) { notice('That isn\'t a working setup link. Copy the whole link and paste it again.', true); return; }
    notice('This device is set up.', false);
    loadList();
  }

  // ---------- set up another phone: the same link the editor's phoneAppSetupLink gives ----------
  function setupLinkFromThisPhone() {
    var u = localStorage.getItem(LS.api), k = localStorage.getItem(LS.key);
    if (!u || !k) return '';
    var b64 = btoa(JSON.stringify({ u: u, k: k })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + location.pathname + '#setup=' + b64;
  }

  /** Draws the QR code on this phone (qrcode.js, MIT): the link never goes to another site. */
  function qrSvg(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  function openShareDialog() {
    var link = setupLinkFromThisPhone();
    if (!link) { toast('This device isn\'t set up, so it has no link to share.', true); return; }
    $('menuDialog').close();
    try { $('qrBox').innerHTML = qrSvg(link); } catch (e) { $('qrBox').textContent = 'Couldn\'t draw the code. Use Share link instead.'; }
    $('shareDialog').showModal();
  }

  function shareSetupLink() {
    var link = setupLinkFromThisPhone();
    if (navigator.share) {
      navigator.share({ title: 'To-do app setup', text: 'Open this link on your phone or computer to set up the To-do app:', url: link })
        .catch(function (e) { if (e && e.name !== 'AbortError') toast('Couldn\'t open sharing. Try again.', true); });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(function () { toast('Link copied. Paste it into a private message.', false); },
        function () { toast('Couldn\'t copy the link.', true); });
    } else {
      toast('This device can\'t share links from here. Use the QR code instead.', true);
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

  // Wide window (a laptop): the three-pane layout. Phones keep the card list.
  var wideQuery = window.matchMedia('(min-width: 1000px)');
  function isDesk() { return wideQuery.matches; }
  function deskScope() { try { return localStorage.getItem(LS.scope) === 'all' ? 'all' : 'me'; } catch (e) { return 'me'; } }
  /** The person whose list is loaded: blank = everyone (laptop "Everyone" only). */
  function listPerson() { return isDesk() && deskScope() === 'all' ? '' : me(); }
  function listKey() { return listPerson() || '*everyone'; }

  /** A write: sends it, renders the fresh list that comes back, reports the result. */
  function write(action, params, okText) {
    spin(true);
    return api(action, Object.assign({ me: me() }, params)).then(function (data) {
      deskSaving = {};   // saved: no row is waiting on the Sheet any more
      if (listPerson() === me()) { saveList(data.list); render(data.list, false); }
      else loadList();   // the reply is only my own tasks; fetch everyone's again
      var freed = (data.freed || '').replace(/ \([0-9a-z]{4,8}\)/g, '');   // ids mean nothing on a phone
      toast((okText || data.message) + (freed ? ' · ' + freed : ''), false);
      return data;
    }).catch(function (e) {
      toast(e.code === 'network'
        ? 'Couldn\'t reach the list. Check your connection, then refresh to see whether it saved.'
        : e.code === 'auth' ? 'This device\'s app key isn\'t accepted. Ask for a new setup link.'
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
    var desk = inList && isDesk();
    $('desk').hidden = !desk;
    $('main').hidden = desk;
    document.body.classList.toggle('desk', isDesk());
    $('addBtn').hidden = !inList || desk;
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
    if (key === 'time') {             // "h:mm" → minutes, so 10:00 sorts after 2:30
      var mins = function (s) { var m = String(s).match(/^(\d+):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : NaN; };
      var ta = mins(a), tb = mins(b);
      if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
    }
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
    localStorage.setItem(LS.cache(listKey()), JSON.stringify(data));
    lastLoad = Date.now();
  }

  /** Draw the list in whichever layout fits the window. */
  function render(data, fromCache) {
    current = data;
    if (isDesk()) renderDesk(data, fromCache); else renderList(data, fromCache);
  }

  function renderList(data, fromCache) {
    current = data;
    var person = me();
    var ul = $('tasks');
    ul.textContent = '';
    // Tasks waiting on another open task go after the ready ones (owner's choice, 17 Nov 2026).
    var all = sortTasks(data.tasks || []);
    var isWaiting = function (t) { return !!(t.waiting && t.waiting.length); };
    var hide = hideWaiting();
    // Sub-tasks sit indented under their parent when the parent is on this list.
    var byId = {}, kidsOf = {}, tops = [];
    all.forEach(function (t) { byId[t.id] = t; });
    all.forEach(function (t) {
      var pid = t.parentOf && t.parentOf.id;
      if (pid && pid !== t.id && byId[pid]) (kidsOf[pid] = kidsOf[pid] || []).push(t);
      else tops.push(t);
    });
    var items = [], seen = {};
    var walk = function (t, depth, section, hidden) {
      if (seen[t.id]) return;
      seen[t.id] = true;
      if (!hidden) items.push({ t: t, depth: depth, section: section });
      (kidsOf[t.id] || []).forEach(function (k) { walk(k, depth + 1, section, hidden); });
    };
    tops.filter(function (t) { return !isWaiting(t); }).forEach(function (t) { walk(t, 0, 'ready', false); });
    tops.filter(isWaiting).forEach(function (t) { walk(t, 0, 'waiting', hide); });
    all.forEach(function (t) { if (!seen[t.id]) walk(t, 0, 'ready', false); });   // safety net: never lose a task
    var waiting = all.filter(isWaiting);
    var tasks = items.map(function (x) { return x.t; });
    var overdue = all.filter(function (t) { return t.due && t.due < data.today; }).length;
    $('summary').textContent = all.length + ' open task' + (all.length === 1 ? '' : 's') +
      (waiting.length ? ' · ' + waiting.length + ' waiting' + (hide ? ' (hidden)' : '') : '') +
      (overdue ? ' · ' + overdue + ' overdue' : '') + ' · sorted by ' + sortLabel().toLowerCase() +
      (fromCache ? ' · saved copy from ' + new Date(data.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    if (!tasks.length) ul.appendChild(el('li', 'empty', all.length ? 'Everything on your list is waiting on another task.' : 'Nothing on your list. Tap + to add a task.'));

    var dividerDone = false;
    items.forEach(function (item) {
      var t = item.t;
      if (item.section === 'waiting' && !dividerDone) { ul.appendChild(el('li', 'divider', 'Waiting on another task')); dividerDone = true; }
      var li = el('li', 'task' + (isWaiting(t) ? ' waiting' : '') + (item.depth ? ' sub depth-' + Math.min(item.depth, 3) : ''));
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
      if (t.sub && t.sub.total) {
        var allDone = !t.sub.open.length;
        meta.appendChild(el('span', 'progress' + (allDone ? ' all' : ''), allDone ? (t.sub.total === 1 ? 'Sub-task done' : 'All ' + t.sub.total + ' sub-tasks done') : t.sub.done + ' of ' + t.sub.total + ' done'));
      }
      var due = dueLabel(t.due, data.today);
      if (due) meta.appendChild(el('span', 'due ' + due.cls, due.text));
      if (t.urgency) meta.appendChild(el('span', '', t.urgency));
      if (t.order !== '' && t.order !== undefined) meta.appendChild(el('span', '', 'Order ' + t.order));
      if (t.category) meta.appendChild(el('span', 'cat', t.category));
      if (t.project) meta.appendChild(el('span', '', t.project));
      if (t.subcategory) meta.appendChild(el('span', '', t.subcategory));
      if (t.time) meta.appendChild(el('span', '', t.time));
      if (t.roi) meta.appendChild(el('span', '', 'ROI ' + t.roi));
      if (t.person && t.person.toLowerCase() !== person.toLowerCase()) meta.appendChild(el('span', '', t.person));
      if (t.status && t.status !== 'A_Not started') meta.appendChild(el('span', '', t.status.replace(/^[A-Z]_/, '')));
      body.appendChild(meta);
      var names = function (list) { return list.map(function (x) { return x.thing; }).join(' · '); };
      if (isWaiting(t)) body.appendChild(el('div', 'dep waiting-on', 'Waiting on: ' + names(t.waiting)));
      if (t.blocking && t.blocking.length) body.appendChild(el('div', 'dep', 'Holding up: ' + names(t.blocking)));
      if (t.parentOf && !byId[t.parentOf.id]) body.appendChild(el('div', 'dep', 'Part of: ' + t.parentOf.thing + (t.parentOf.done ? ' (done)' : '')));
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
    var mode = '';
    var openKids = (t.sub && t.sub.open) ? t.sub.open.length : 0;
    if (openKids) {
      var s1 = openKids === 1 ? '' : 's';
      if (confirm('"' + short(t.thing) + '" still has ' + openKids + ' open sub-task' + s1 + '.\n\nOK: tick ' + (openKids === 1 ? 'it' : 'them') + ' too.\nCancel: other choices.')) mode = 'complete';
      else if (confirm('Tick only "' + short(t.thing) + '" and leave its sub-task' + s1 + ' open?')) mode = 'keep';
      else return;
    }
    li.classList.add('pending');
    pendingDone[t.id] = setTimeout(function () {
      li.classList.add('saving');
      var params = { id: t.id, expect: t.thing.slice(0, 40) };
      if (mode) params.subtasks = mode;
      write('complete', params, 'Done: ' + short(t.thing))
        .then(function () { delete pendingDone[t.id]; }, function () {
          delete pendingDone[t.id];              // failed: show it as open again
          if (current) render(current, false);
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

  function openTaskDialog(t, underParent) {
    if (!vocab()) {                  // dropdown lists not saved yet: fetch them first
      spin(true);
      loadVocab().then(function () { openTaskDialog(t, underParent); }, function () {
        toast('Couldn\'t load the dropdown lists. Check your connection and try again.', true);
      }).finally(function () { spin(false); });
      return;
    }
    editing = t || null;
    var v = vocab() || {};
    var people = (v.person || [me()]).filter(function (p) { return p !== '?'; });
    $('taskTitle').textContent = t ? 'Edit task' : underParent ? 'Add a sub-task to "' + short(underParent.thing) + '"' : 'Add a task';
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
    $('fOrder').value = t ? (t.order || '') : '';
    fillSelect($('fRoi'), v.roi || ['$', '$$', '$$$', 'Unknown'], t ? t.roi : '', t ? '—' : 'Default ($)');
    $('fTimeToRoi').value = t ? (t.time_to_roi || '') : '';
    $('fNotes').value = t ? (t.notes || '') : '';
    depChoice = t && t.dependsOn ? t.dependsOn.slice() : [];
    renderDeps();
    fillParent(t ? (t.parentOf ? t.parentOf.id : '') : (underParent ? underParent.id : ''), t);
    // A new sub-task starts with its parent's category, project, person and priority.
    if (underParent) {
      fillSelect($('fP'), priorities(), underParent.p || 'P1');
      fillSelect($('fCategory'), (v.category || []).filter(function (c) { return c !== 'UNSORTED'; }), underParent.category || '', 'Guess for me');
      fillSelect($('fProject'), (v.project || []).filter(function (c) { return c !== 'UNSORTED'; }), underParent.project || '', '—');
      if (underParent.person && underParent.person.indexOf(',') === -1) fillSelect($('fPerson'), people, underParent.person);
    }
    $('addSubBtn').hidden = !t;
    $('taskError').hidden = true;
    $('taskSave').disabled = false;
    var dlg = $('taskDialog');
    if (dlg.open) dlg.close();
    if (isDesk()) { dlg.classList.add('side'); document.body.classList.add('panel-open'); dlg.show(); markSelected(t ? t.id : ''); }
    else { dlg.classList.remove('side'); document.body.classList.remove('panel-open'); dlg.showModal(); }
    if (!t) $('fThing').focus();
  }

  // ---------- "Waits on": the tasks this one can't be done before ----------
  function renderDeps() {
    var ul = $('fDeps'), selfId = editing ? editing.id : '';
    ul.textContent = '';
    depChoice.forEach(function (d, i) {
      var li = el('li', 'chip');
      li.appendChild(el('span', '', d.thing));
      var x = el('button', '', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Stop waiting on: ' + d.thing);
      x.addEventListener('click', function () { depChoice.splice(i, 1); renderDeps(); });
      li.appendChild(x);
      ul.appendChild(li);
    });
    var sel = $('fDepAdd'), chosen = depChoice.map(function (d) { return d.id; });
    sel.textContent = '';
    var o0 = el('option', '', depChoice.length ? 'Add another…' : 'Nothing. Pick a task to wait on…'); o0.value = ''; sel.appendChild(o0);
    var open = ((current && current.open) || []).filter(function (o) { return o.id && o.id !== selfId && chosen.indexOf(o.id) === -1; })
      .sort(function (a, b) { return a.thing.localeCompare(b.thing, undefined, { sensitivity: 'base' }); });
    open.forEach(function (o) {
      var opt = el('option', '', short(o.thing) + (o.person && o.person.toLowerCase() !== me().toLowerCase() ? ' (' + o.person + ')' : ''));
      opt.value = o.id;
      sel.appendChild(opt);
    });
    sel.value = '';
  }
  function addDep() {
    var id = $('fDepAdd').value;
    if (!id) return;
    var o = ((current && current.open) || []).filter(function (x) { return x.id === id; })[0];
    if (o) depChoice.push({ id: o.id, thing: o.thing });
    renderDeps();
  }
  function depIds(list) { return (list || []).map(function (d) { return d.id; }).join(','); }

  // ---------- "Part of": this task's parent ----------
  function fillParent(value, t) {
    var sel = $('fParent'), selfId = t ? t.id : '';
    var open = (current && current.open) || [];
    // Not itself, and not one of its own sub-tasks (that would make a loop).
    var below = {}, grew = true;
    if (selfId) below[selfId] = true;
    while (grew) {
      grew = false;
      open.forEach(function (o) { if (o.parent && below[o.parent] && !below[o.id]) { below[o.id] = true; grew = true; } });
    }
    sel.textContent = '';
    var none = el('option', '', '— none —'); none.value = ''; sel.appendChild(none);
    if (t && t.parentOf && t.parentOf.done) {
      var gone = el('option', '', short(t.parentOf.thing) + ' (done)'); gone.value = t.parentOf.id; sel.appendChild(gone);
    }
    open.filter(function (o) { return o.id && !below[o.id]; })
      .sort(function (a, b) { return a.thing.localeCompare(b.thing, undefined, { sensitivity: 'base' }); })
      .forEach(function (o) {
        var opt = el('option', '', short(o.thing) + (o.person && o.person.toLowerCase() !== me().toLowerCase() ? ' (' + o.person + ')' : ''));
        opt.value = o.id;
        sel.appendChild(opt);
      });
    sel.value = value || '';
  }

  function taskFormValues() {
    return {
      thing: $('fThing').value.trim(), p: $('fP').value, due: $('fDue').value,
      urgency: $('fUrgency').value, person: $('fPerson').value, notes: $('fNotes').value.trim(),
      category: $('fCategory').value, project: $('fProject').value, subcategory: $('fSubcategory').value,
      status: $('fStatus').value, time: $('fTime').value.trim(), order: $('fOrder').value.trim(),
      roi: $('fRoi').value, time_to_roi: $('fTimeToRoi').value.trim()
    };
  }

  function saveTask(ev) {
    ev.preventDefault();
    var f = taskFormValues(), err = $('taskError');
    if (!f.thing) { err.textContent = 'Type the task first.'; err.hidden = false; return; }
    var params = {}, action, okText;
    if (!editing) {
      Object.keys(f).forEach(function (k) { if (f[k]) params[k] = f[k]; });
      if (depChoice.length) params.depends_on = depIds(depChoice);
      if ($('fParent').value) params.parent = $('fParent').value;
      action = 'add'; okText = 'Added: ' + short(f.thing);
    } else {
      var cleared = [];
      Object.keys(f).forEach(function (k) {
        var before = String(editing[k] || '').trim();
        if (f[k] === before) return;
        if (!f[k]) cleared.push(k); else params[k] = f[k];
      });
      if (cleared.length) {
        err.textContent = 'The app can\'t empty a field yet (' + cleared.join(', ') + '). Change it in the sheet, or pick a value.';
        err.hidden = false; return;
      }
      var clears = [];
      if (depIds(depChoice) !== depIds(editing.dependsOn)) {
        if (depChoice.length) params.depends_on = depIds(depChoice);
        else clears.push('depends_on');
      }
      var parentNow = $('fParent').value, parentBefore = editing.parentOf ? editing.parentOf.id : '';
      if (parentNow !== parentBefore) {
        if (parentNow) params.parent = parentNow;
        else clears.push('parent');
      }
      if (clears.length) params.clear = clears.join(',');
      if (!Object.keys(params).length) { $('taskDialog').close(); return; }
      params.id = editing.id;
      action = 'update'; okText = 'Saved: ' + short(f.thing);
    }
    if (isDesk() && action === 'update') {
      // Show the change straight away; the Sheet catches up in a second or two.
      Object.keys(f).forEach(function (k) { if (params[k] !== undefined) editing[k] = f[k]; });
      deskSaving[editing.id] = true;
      $('taskDialog').close();
      render(current, false);
      write(action, params, okText).catch(function () { deskSaving = {}; loadList(); });
      return;
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
    $('hideWaiting').checked = hideWaiting();
    $('sortDialog').showModal();
  }
  function hideWaiting() { try { return localStorage.getItem(LS.hideWaiting) === '1'; } catch (e) { return false; } }
  function applySort(specs) {
    localStorage.setItem(LS.sort, JSON.stringify(specs));
    $('sortDialog').close();
    if (current) render(current, false);
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
    var cached = localStorage.getItem(LS.cache(listKey()));
    if (cached && $('list').hidden && $('desk').hidden) { try { render(JSON.parse(cached), true); } catch (e) { /* ignore */ } }
    loadVocab().catch(function () { /* the list still works; dropdowns use the saved copy */ });
    if (loading) return;
    loading = true; spin(true);
    api('list', { person: listPerson() }).then(function (data) {
      saveList(data);
      notice('');
      render(data, false);
    }).catch(function (e) {
      if (e.code === 'setup') { show('setup'); return; }
      if (e.code === 'auth') { notice('This device\'s app key isn\'t accepted any more. Ask the person who set this up for a new setup link.', true); return; }
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
      notice(e.code === 'auth' ? 'This device\'s app key isn\'t accepted. Ask the person who set this up for a new setup link.' : 'Couldn\'t load the names. Check your connection and try again.', true);
    });
  }

  // ================= wide-window layout (laptop) =================
  // Views on the left, a sortable list in the middle (sub-tasks folded under
  // their parent, waiting tasks last), and the edit box docked on the right.
  var deskSaving = {};          // ids whose change is still on its way to the Sheet
  var COLS = [
    { key: 'thing', label: 'Task' }, { key: 'p', label: 'P' }, { key: 'due', label: 'Due' },
    { key: 'urgency', label: 'Urgency' }, { key: 'person', label: 'Person' }, { key: 'project', label: 'Project' },
    { key: 'category', label: 'Category' }, { key: 'status', label: 'Status' }
  ];
  function deskView() {
    try { var v = JSON.parse(localStorage.getItem(LS.view)); if (v && v.type) return v; } catch (e) { /* default */ }
    return { type: 'all' };
  }
  function setDeskView(v) { try { localStorage.setItem(LS.view, JSON.stringify(v)); } catch (e) { /* this visit only */ } if (current) render(current, false); }
  function folded() { try { return JSON.parse(localStorage.getItem(LS.folded)) || {}; } catch (e) { return {}; } }
  function setFolded(f) { try { localStorage.setItem(LS.folded, JSON.stringify(f)); } catch (e) { /* this visit only */ } }
  function isWaitingT(t) { return !!(t.waiting && t.waiting.length); }
  function hasOpenKids(t) { return !!(t.sub && t.sub.open && t.sub.open.length); }
  function splitList(v) { return String(v || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; }); }
  function addDays(ymd, n) { var d = parseYmd(ymd); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  function inView(t, v, today) {
    switch (v.type) {
      case 'ready': return !isWaitingT(t) && !hasOpenKids(t);
      case 'waiting': return isWaitingT(t);
      case 'soon': return !!t.due && t.due <= addDays(today, 7);
      case 'overdue': return !!t.due && t.due < today;
      case 'project': return splitList(t.project).indexOf(v.value) !== -1;
      case 'category': return t.category === v.value;
      case 'person': return splitList(t.person).indexOf(v.value) !== -1;
      default: return true;
    }
  }

  function renderViews(all, today) {
    var nav = $('views'), v = deskView();
    nav.textContent = '';
    var item = function (label, view, count) {
      var b = el('button', 'view' + (v.type === view.type && (v.value || '') === (view.value || '') ? ' on' : ''));
      b.type = 'button';
      b.appendChild(el('span', '', label));
      b.appendChild(el('span', 'count', String(count)));
      b.addEventListener('click', function () { setDeskView(view); });
      nav.appendChild(b);
    };
    var count = function (view) { return all.filter(function (t) { return inView(t, view, today); }).length; };
    [['Ready now', { type: 'ready' }], ['Waiting', { type: 'waiting' }], ['All open', { type: 'all' }],
      ['Due within a week', { type: 'soon' }], ['Overdue', { type: 'overdue' }]].forEach(function (x) { item(x[0], x[1], count(x[1])); });
    var group = function (title, type, values) {
      if (!values.length) return;
      nav.appendChild(el('h3', '', title));
      values.forEach(function (val) { var view = { type: type, value: val }; item(val, view, count(view)); });
    };
    var uniq = function (getter) {
      var seen = {}, out = [];
      all.forEach(function (t) { getter(t).forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } }); });
      return out.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
    };
    group('Projects', 'project', uniq(function (t) { return splitList(t.project); }));
    group('Categories', 'category', uniq(function (t) { return t.category ? [t.category] : []; }));
    if (deskScope() === 'all') group('People', 'person', uniq(function (t) { return splitList(t.person); }));
  }

  function renderHead() {
    var head = $('gridHead'), specs = sortSpecs(), first = specs[0] || {};
    head.textContent = '';
    var tr = el('tr');
    tr.appendChild(el('th', 'c-tick'));
    COLS.forEach(function (c) {
      var th = el('th', 'c-' + c.key);
      var b = el('button', 'sort-h', c.label + (first.key === c.key ? (first.desc ? ' ↓' : ' ↑') : ''));
      b.type = 'button';
      b.title = 'Sort by ' + c.label;
      b.addEventListener('click', function () {
        var desc = first.key === c.key ? !first.desc : false;
        var spec = { key: c.key }; if (desc) spec.desc = true;
        localStorage.setItem(LS.sort, JSON.stringify([spec].concat(specs.filter(function (s) { return s.key !== c.key; }).slice(0, 2))));
        if (current) render(current, false);
      });
      th.appendChild(b);
      tr.appendChild(th);
    });
    head.appendChild(tr);
  }

  function markSelected(id) {
    Array.prototype.forEach.call(document.querySelectorAll('#gridBody tr.row'), function (tr) {
      tr.classList.toggle('selected', !!id && tr.dataset.id === id);
    });
  }

  function renderDesk(data, fromCache) {
    current = data;
    var today = data.today, v = deskView();
    var q = ($('search').value || '').trim().toLowerCase();
    var all = sortTasks(data.tasks || []);
    var fold = folded();
    Array.prototype.forEach.call(document.querySelectorAll('.seg [data-scope]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-scope') === deskScope()));
    });
    renderViews(all, today);
    renderHead();

    var shown = all.filter(function (t) {
      if (!inView(t, v, today)) return false;
      if (!q) return true;
      return [t.thing, t.notes, t.project, t.category, t.person].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var hide = hideWaiting() && v.type !== 'waiting';
    var items = [];
    if (q) {
      shown.forEach(function (t) { items.push({ t: t, depth: 0, section: 'ready', kids: 0 }); });   // search: a flat list of matches
    } else {
      var byId = {}, kidsOf = {}, tops = [], seen = {};
      shown.forEach(function (t) { byId[t.id] = t; });
      shown.forEach(function (t) {
        var pid = t.parentOf && t.parentOf.id;
        if (pid && pid !== t.id && byId[pid]) (kidsOf[pid] = kidsOf[pid] || []).push(t); else tops.push(t);
      });
      var walk = function (t, depth, section, hidden) {
        if (seen[t.id]) return;
        seen[t.id] = true;
        var kids = kidsOf[t.id] || [];
        if (!hidden) items.push({ t: t, depth: depth, section: section, kids: kids.length });
        kids.forEach(function (k) { walk(k, depth + 1, section, hidden || !!fold[t.id]); });
      };
      var waitLast = v.type !== 'waiting';
      tops.filter(function (t) { return !waitLast || !isWaitingT(t); }).forEach(function (t) { walk(t, 0, 'ready', false); });
      if (waitLast) tops.filter(isWaitingT).forEach(function (t) { walk(t, 0, 'waiting', hide); });
      shown.forEach(function (t) { if (!seen[t.id]) walk(t, 0, 'ready', false); });
    }

    var waitingN = shown.filter(isWaitingT).length;
    var overdue = shown.filter(function (t) { return t.due && t.due < today; }).length;
    $('gridSummary').textContent = shown.length + ' task' + (shown.length === 1 ? '' : 's') +
      (waitingN ? ' · ' + waitingN + ' waiting' + (hide ? ' (hidden)' : '') : '') +
      (overdue ? ' · ' + overdue + ' overdue' : '') + (deskScope() === 'all' ? ' · everyone' : ' · ' + me()) +
      (fromCache ? ' · saved copy from ' + new Date(data.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

    var body = $('gridBody');
    body.textContent = '';
    if (!items.length) {
      var tr0 = el('tr'); var td0 = el('td', 'empty', q ? 'Nothing matches "' + q + '".' : 'Nothing in this view.');
      td0.colSpan = COLS.length + 1; tr0.appendChild(td0); body.appendChild(tr0);
    }
    var dividerDone = false;
    var editingId = $('taskDialog').open && editing ? editing.id : '';
    items.forEach(function (item) {
      var t = item.t;
      if (item.section === 'waiting' && !dividerDone) {
        var trd = el('tr', 'divider-row'); var tdd = el('td', '', 'Waiting on another task');
        tdd.colSpan = COLS.length + 1; trd.appendChild(tdd); body.appendChild(trd); dividerDone = true;
      }
      var tr = el('tr', 'row' + (isWaitingT(t) ? ' waiting' : '') + (pendingDone[t.id] ? ' pending' : '') +
        (deskSaving[t.id] ? ' saving-soft' : '') + (t.id === editingId ? ' selected' : ''));
      tr.dataset.id = t.id;

      var tdTick = el('td', 'c-tick');
      var tick = el('button', 'tick');
      tick.type = 'button';
      tick.setAttribute('aria-label', 'Mark done: ' + t.thing);
      var circle = el('span');
      circle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
      tick.appendChild(circle);
      tick.addEventListener('click', function (ev) { ev.stopPropagation(); toggleDone(t, tr); });
      tdTick.appendChild(tick);
      tr.appendChild(tdTick);

      var tdT = el('td', 'c-thing');
      var line = el('div', 'tline');
      line.style.paddingLeft = (item.depth * 22) + 'px';
      if (item.kids) {
        var tog = el('button', 'fold', fold[t.id] ? '▸' : '▾');
        tog.type = 'button';
        tog.setAttribute('aria-label', (fold[t.id] ? 'Show' : 'Hide') + ' sub-tasks of ' + t.thing);
        tog.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var f = folded(); if (f[t.id]) delete f[t.id]; else f[t.id] = true;
          setFolded(f); render(current, false);
        });
        line.appendChild(tog);
      } else if (item.depth) line.appendChild(el('span', 'fold-gap'));
      line.appendChild(el('span', 'tname', t.thing));
      if (t.sub && t.sub.total) {
        var allDone = !t.sub.open.length;
        line.appendChild(el('span', 'progress' + (allDone ? ' all' : ''), allDone ? 'All done' : t.sub.done + '/' + t.sub.total));
      }
      tdT.appendChild(line);
      var names = function (list) { return list.map(function (x) { return x.thing; }).join(' · '); };
      var sub = [];
      if (isWaitingT(t)) sub.push(el('span', 'waiting-on', 'Waiting on: ' + names(t.waiting)));
      if (t.blocking && t.blocking.length) sub.push(el('span', '', 'Holding up: ' + names(t.blocking)));
      if (t.parentOf && (q || !(items.some(function (x) { return x.t.id === t.parentOf.id; })))) sub.push(el('span', '', 'Part of: ' + t.parentOf.thing + (t.parentOf.done ? ' (done)' : '')));
      sub.push(el('span', 'undo-note', 'Marked done. Click the tick again to undo.'));   // shown only while ticked
      if (sub.length) {
        var dl = el('div', 'tsub'); dl.style.paddingLeft = (item.depth * 22 + 20) + 'px';
        sub.forEach(function (x) { dl.appendChild(x); });
        tdT.appendChild(dl);
      }
      tr.appendChild(tdT);

      var due = dueLabel(t.due, today);
      var cells = {
        p: t.p ? el('span', 'pill ' + t.p, t.p) : null,
        due: due ? el('span', 'due ' + due.cls, due.text) : null,
        urgency: t.urgency || '', person: t.person || '', project: t.project || '',
        category: t.category || '', status: t.status ? t.status.replace(/^[A-Z]_/, '') : ''
      };
      COLS.slice(1).forEach(function (c) {
        var td = el('td', 'c-' + c.key), val = cells[c.key];
        if (val && val.nodeType) td.appendChild(val); else td.textContent = val || '';
        tr.appendChild(td);
      });
      tr.addEventListener('click', function () { if (!pendingDone[t.id]) openTaskDialog(t); });
      body.appendChild(tr);
    });
    show('list');
  }

  // Laptop wiring
  $('search').addEventListener('input', function () { if (current) render(current, false); });
  Array.prototype.forEach.call(document.querySelectorAll('.seg [data-scope]'), function (b) {
    b.addEventListener('click', function () {
      try { localStorage.setItem(LS.scope, b.getAttribute('data-scope')); } catch (e) { /* this visit only */ }
      var v = deskView(); if (v.type === 'person') setDeskView({ type: 'all' });
      loadList();
    });
  });
  $('deskAdd').addEventListener('click', function () { openTaskDialog(null); });
  // When the panel closes (Save, Cancel, Escape), the list takes the full width again.
  // Watched on the "open" attribute itself: the dialog's close event did not fire reliably.
  new MutationObserver(function () {
    if (!$('taskDialog').open) { markSelected(''); document.body.classList.remove('panel-open'); }
  }).observe($('taskDialog'), { attributes: true, attributeFilter: ['open'] });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isDesk() && $('taskDialog').open && $('taskDialog').classList.contains('side')) $('taskDialog').close();
  });
  // Switching between a wide and a narrow window redraws the right layout.
  var onWidth = function () {
    if ($('taskDialog').open) $('taskDialog').close();
    if (current) { if (listPerson() !== (current.person || me())) loadList(); else render(current, false); }
  };
  if (wideQuery.addEventListener) wideQuery.addEventListener('change', onWidth); else wideQuery.addListener(onWidth);
  // Keep the laptop window fresh: reload every minute while it is in front and idle.
  setInterval(function () {
    if (isDesk() && document.visibilityState === 'visible' && !$('desk').hidden && !loading &&
      !Object.keys(pendingDone).length && !Object.keys(deskSaving).length && !$('taskDialog').open) loadList();
  }, 60 * 1000);

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
  $('hideWaiting').addEventListener('change', function () {
    try { localStorage.setItem(LS.hideWaiting, $('hideWaiting').checked ? '1' : '0'); } catch (e) { /* this visit only */ }
    if (current) render(current, false);
  });
  $('fDepAdd').addEventListener('change', addDep);
  $('addSubBtn').addEventListener('click', function () {
    var parent = editing;
    if (!parent) return;
    $('taskDialog').close();
    openTaskDialog(null, parent);
  });
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
  $('shareSetupBtn').addEventListener('click', openShareDialog);
  $('shareLinkBtn').addEventListener('click', shareSetupLink);
  $('setupForm').addEventListener('submit', function (ev) { ev.preventDefault(); pasteSetup(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('list').hidden && Date.now() - lastLoad > STALE_MS &&
      !Object.keys(pendingDone).length && !$('taskDialog').open) loadList();
  });

  readSetupLink();
  show('setup');
  if (localStorage.getItem(LS.api) && localStorage.getItem(LS.key)) loadList();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without it */ });
})();
