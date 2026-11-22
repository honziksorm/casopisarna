/* Časopisárna: polička s časopisy, listování (StPageFlip) a lupa. */
(() => {
  'use strict';

  // --- pomocné funkce
  const $ = (s, root = document) => root.querySelector(s);
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* soukromé okno */ }
    },
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
  const fmt = (n) => n.toLocaleString('cs-CZ');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'právě teď';
    if (s < 3600) return `před ${Math.round(s / 60)} min`;
    if (s < 86400) return `před ${Math.round(s / 3600)} h`;
    const d = Math.round(s / 86400);
    if (d === 1) return 'včera';
    if (d < 7) return `před ${d} dny`;
    return new Date(t).toLocaleDateString('cs-CZ');
  }

  const SPEEDS = { off: 1, fast: 380, normal: 750, slow: 1300 };
  const settings = Object.assign(
    { speed: 'normal', coverW: null, sort: 'asc', filter: 'all', magazine: 'all', themes: {} },
    store.get('excal.settings', {})
  );
  if (!(settings.speed in SPEEDS)) settings.speed = 'normal';
  const saveSettings = () => store.set('excal.settings', settings);

  // progress[id] = { page, max, t }
  const progress = store.get('excal.progress', {});
  function saveProgress(id, page, maxSeen) {
    const old = progress[id] || {};
    progress[id] = { page, max: Math.max(old.max || 0, maxSeen == null ? page : maxSeen), t: Date.now() };
    store.set('excal.progress', progress);
    sync.queue({ progress: { [id]: progress[id] } });
  }
  let bookmarks = store.get('excal.bookmarks', { t: 0, items: [] });
  function setLast(id) {
    const t = Date.now();
    store.set('excal.last', id);
    store.set('excal.lastT', t);
    sync.queue({ last: { id, t } });
  }

  // rozečtené stránky a záložky drží i čtečka (api/reader), aby platily na PC i tabletu
  const sync = {
    pending: {}, timer: 0, ok: false,
    queue(part) {
      if (part.progress) this.pending.progress = Object.assign(this.pending.progress || {}, part.progress);
      if (part.last) this.pending.last = part.last;
      if (part.bookmarks) this.pending.bookmarks = part.bookmarks;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 800);
    },
    flush() {
      if (!this.ok || !Object.keys(this.pending).length) return;
      const body = JSON.stringify(this.pending);
      this.pending = {};
      fetch('api/reader', { method: 'POST', headers: { 'X-Reader': '1', 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    },
  };
  const getReader = () => fetch('api/reader', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  function mergeReader(st) {
    if (!st) return false;
    let changed = false;
    const push = {};
    const sp = st.progress || {};
    for (const [id, e] of Object.entries(sp)) {
      if (!progress[id] || (e.t || 0) > (progress[id].t || 0)) { progress[id] = e; changed = true; }
    }
    for (const [id, e] of Object.entries(progress)) {
      if (!sp[id] || (e.t || 0) > (sp[id].t || 0)) (push.progress = push.progress || {})[id] = e;
    }
    if (st.last && st.last.id && (st.last.t || 0) > store.get('excal.lastT', 0)) {
      store.set('excal.last', st.last.id);
      store.set('excal.lastT', st.last.t);
      changed = true;
    } else if (store.get('excal.last', null)) {
      push.last = { id: store.get('excal.last', null), t: store.get('excal.lastT', 0) || 1 };
    }
    const sb = st.bookmarks || { t: 0, items: [] };
    if ((sb.t || 0) > (bookmarks.t || 0)) { bookmarks = sb; changed = true; } else if ((bookmarks.t || 0) > (sb.t || 0)) push.bookmarks = bookmarks;
    store.set('excal.progress', progress);
    store.set('excal.bookmarks', bookmarks);
    sync.ok = true;
    if (Object.keys(push).length) sync.queue(push);
    return changed;
  }
  function statusOf(issue) {
    const p = progress[issue.id];
    if (!p) return 'unread';
    if ((p.max || 0) >= issue.pages.length - 2) return 'done';
    if (p.page > 0 || (p.max || 0) > 0) return 'reading';
    return 'unread';
  }

  const el = {
    shelf: $('#shelf'), stats: $('#shelf-stats'), magTabs: $('#mag-tabs'), brandMark: $('#brand-mark'),
    tagline: $('#brand-tagline'), foot: $('#shelf-foot'), themeBtn: $('#btn-theme'), themePop: $('#theme-pop'), themeList: $('#theme-list'), hero: $('#hero'), toolbar: $('#shelf-toolbar'),
    filterSeg: $('#filter-seg'), chips: $('#year-chips'), search: $('#shelf-search'), sortBtn: $('#btn-sort'),
    size: $('#cover-size'), random: $('#btn-random'), sections: $('#sections'), empty: $('#shelf-empty'),
    welcome: $('#welcome'), libProgress: $('#lib-progress'), libBtn: $('#btn-library'), libPop: $('#lib-pop'),
    phoneBtn: $('#btn-phone'), phonePop: $('#phone-pop'),
    bookmarksEl: $('#bookmarks'), textHitsEl: $('#text-hits'), help: $('#help'), toast: $('#toast'),
    bmBtn: $('#btn-bookmark'), bmBtnBook: $('#btn-bookmark-book'),
    book: $('#book-view'), area: $('#book-area'), holder: $('#book-holder'), shadow: $('#book-shadow'),
    title: $('#book-title'), date: $('#book-date'), ind: $('#page-indicator'), slider: $('#page-slider'),
    navPrev: $('#nav-prev'), navNext: $('#nav-next'), nextIssue: $('#next-issue'), intro: $('#intro'),
    bzIn: $('#bz-in'), bzOut: $('#bz-out'), bzLabel: $('#bz-label'), zoomNote: $('#zoom-note'),
    settingsBtn: $('#btn-settings'), settingsPop: $('#settings-pop'), speedSeg: $('#speed-seg'),
    overview: $('#overview'), ovGrid: $('#overview-grid'),
    reader: $('#reader'), stage: $('#reader-stage'), sheet: $('#reader-sheet'), rpage: $('#reader-page'),
    rzoom: $('#reader-zoom'), rprev: $('#reader-prev'), rnext: $('#reader-next'), rloading: $('#reader-loading'),
    modeSeg: $('#mode-seg'), minimap: $('#minimap'), mmSheet: $('#mm-sheet'), mmView: $('#mm-view'), hint: $('#reader-hint'),
  };

  let manifest = null;
  const byId = new Map();
  const state = {
    issue: null, flip: null, current: 0, landscape: true, pageW: 0, pageH: 0,
    pageEls: [], flipState: 'read', useFull: false,
  };

  const imgUrl = (issue, page, kind) => {
    if (kind === 'full' && offline.away && offline.saved.has(issue.id)) kind = 'view'; // v telefonu je uložené to na listování
    if (kind === 'view' && page.nv) kind = 'full'; // malé skeny nemají view/
    return `data/issues/${encodeURIComponent(issue.id)}/${kind}/${page.f}.${kind === 'full' ? 'jpg' : 'webp'}`;
  };
  const BRAND = window.BRAND || { name: 'Časopisárna', wordmark: 'Časopisárna', themes: [] };
  const APP = BRAND.name;
  const magTitle = (id) => ((manifest && manifest.magazines || []).find((m) => m.id === id) || { title: id }).title;
  const shelfIssues = () => (settings.magazine === 'all' ? manifest.issues : manifest.issues.filter((i) => i.magazine === settings.magazine));
  const sameMagazine = (issue) => manifest.issues.filter((i) => i.magazine === issue.magazine);
  const coverUrl = (issue) => imgUrl(issue, issue.pages[0], 'thumb');

  const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

  // rok (případně odhad podle sousedů), sekce a text pro hledání
  function enrich(issues) {
    if (!manifest.magazines) manifest.magazines = [{ id: 'excalibur', title: 'Excalibur' }];
    issues.forEach((is) => {
      is.magazine = is.magazine || 'excalibur';
      if (is.year == null) {
        const m = /(\d{4})\s*$/.exec(is.date || '');
        is.year = m ? Number(m[1]) : null;
      }
      is.yearApprox = false;
      is.numbered = /^\d/.test(is.number);
      is.special = !is.numbered || /\+$/.test(is.number);
      is.tag = is.number;
      const dm = /^(\S+)\s+(\d{4})$/.exec(is.date || ''); // "leden 1995" -> 1/95 na štítek
      const mi = dm ? MONTHS.indexOf(dm[1].toLowerCase()) : -1;
      is.month = mi >= 0 ? `${mi + 1}/${dm[2].slice(2)}` : '';
      is.short = is.numbered ? `${magTitle(is.magazine)} ${is.number}` : is.title;
    });
    // chybějící rok dopočítat podle sousedních čísel téhož časopisu
    for (const mag of manifest.magazines) {
      const regular = issues.filter((is) => is.magazine === mag.id && is.numbered);
      let last = null;
      regular.forEach((is) => { if (is.year) last = is.year; else if (last) { is.year = last; is.yearApprox = true; } });
      let next = null;
      for (let i = regular.length - 1; i >= 0; i--) {
        const is = regular[i];
        if (is.year && !is.yearApprox) next = is.year;
        else if (!is.year && next) { is.year = next; is.yearApprox = true; }
      }
    }
    issues.forEach((is) => {
      is.section = !is.numbered ? 'Speciály' : is.year ? String(is.year) : 'Bez data';
      const kind = is.special ? 'special specialni priloha plus' : '';
      is.searchText = norm([is.title, is.date, is.year, is.number, magTitle(is.magazine), kind].join(' '));
      byId.set(is.id, is);
    });
  }

  // --- navigace (#hash)
  // ""                       -> polička
  // "#Excalibur_50"          -> listování
  // "#Excalibur_50/str/74"   -> čtení strany 74
  // "#Excalibur_50/dvo/74"   -> lupa na dvoustranu se stranou 74
  let lastHash = null;
  let prevHash = null;
  let pendingOpen = null;   // odkud se otevírá lupa
  let pendingFlight = null; // letící obálka z poličky

  const currentHash = () => decodeURIComponent(location.hash.replace(/^#/, ''));
  function parseHash() {
    const h = currentHash();
    if (!h) return { view: 'shelf' };
    const [id, kind, num] = h.split('/');
    if ((kind === 'str' || kind === 'dvo') && num) {
      return { view: 'reader', id, mode: kind === 'dvo' ? 'spread' : 'page', page: Math.max(0, (parseInt(num, 10) || 1) - 1) };
    }
    return { view: 'book', id };
  }
  const readerHash = (id, mode, idx) => `${id}/${mode === 'spread' ? 'dvo' : 'str'}/${idx + 1}`;

  function goUp() {
    const r = parseHash();
    const parent = r.view === 'reader' ? r.id : '';
    if (prevHash === parent) history.back();
    else location.hash = parent;
  }

  window.addEventListener('hashchange', () => {
    prevHash = lastHash;
    route();
  });

  function showView(name) {
    if (name !== 'shelf' && !el.shelf.hidden) shelf.scroll = el.shelf.scrollTop;
    el.shelf.hidden = name !== 'shelf';
    el.book.hidden = name !== 'book';
  }

  function route() {
    if (!manifest) return;
    lastHash = currentHash();
    const r = parseHash();
    closePopover();
    if (r.view === 'shelf') {
      const leaving = state.issue ? state.issue.id : null;
      closeReader(false);
      closeOverview();
      destroyBook();
      showView('shelf');
      refreshShelf();
      restoreShelf(leaving);
      document.title = APP;
      return;
    }
    const issue = byId.get(r.id);
    if (!issue || (state.issue !== issue && notHere(issue))) { location.replace('#'); return; }
    showView('book');
    if (!state.flip || state.issue !== issue) {
      // číslo se otevírá zavřené, odkaz do lupy otevře rovnou stránku
      const start = r.view === 'reader' ? r.page : 0;
      buildBook(issue, clamp(start, 0, issue.pages.length - 1));
      if (pendingFlight && pendingFlight.id === issue.id) runFlight(pendingFlight);
    }
    pendingFlight = null;
    if (r.view === 'reader') openReader(clamp(r.page, 0, issue.pages.length - 1), r.mode, pendingOpen);
    else closeReader(true);
    pendingOpen = null;
  }

  // --- polička
  const magIndex = (id) => Math.max(0, manifest.magazines.findIndex((m) => m.id === id)) % 6;

  const THEMES = [
    ...(BRAND.themes || []),
    { id: 'citarna', name: 'Čítárna', desc: 'Tmavý ořech pod lampou' },
    { id: 'den', name: 'Den', desc: 'Světlý dub a papír' },
    { id: 'pokojicek', name: 'Pokojíček', desc: 'Tapeta, borovice a lampička' },
    { id: 'mrizka', name: 'Mřížka', desc: 'Bez polic, s popisky' },
  ];

  function applyBrand() {
    document.title = APP;
    el.brandMark.textContent = '';
    if (BRAND.logo) {
      const box = document.createElement('div');
      box.className = 'brand-logo';
      const img = document.createElement('img');
      img.src = BRAND.logo;
      img.alt = BRAND.logoAlt || APP;
      box.appendChild(img);
      if (BRAND.wordmark) {
        const w = document.createElement('span');
        w.className = 'wordmark';
        w.textContent = BRAND.wordmark;
        box.appendChild(w);
      }
      el.brandMark.appendChild(box);
    } else {
      const w = document.createElement('span');
      w.className = 'wordmark';
      w.textContent = BRAND.wordmark || APP;
      el.brandMark.appendChild(w);
    }
    el.tagline.textContent = BRAND.tagline || '';
    el.foot.textContent = BRAND.credit || '';
  }

  // vzhled se pamatuje pro každou značku zvlášť
  const currentTheme = () => (settings.themes || {})[APP] || BRAND.theme || 'citarna';

  function applyTheme(id) {
    if (!THEMES.some((t) => t.id === id)) id = THEMES[0].id;
    settings.themes = Object.assign({}, settings.themes, { [APP]: id });
    el.shelf.dataset.theme = id;
    el.themeList.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('on', b.dataset.theme === id));
  }

  function renderThemes() {
    el.themeList.textContent = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'theme-opt';
      b.dataset.theme = t.id;
      b.innerHTML = `<span class="swatch swatch-${t.id}"></span><b></b><small></small>`;
      b.querySelector('b').textContent = t.name;
      b.querySelector('small').textContent = t.desc;
      b.addEventListener('click', () => {
        applyTheme(t.id);
        saveSettings();
        requestAnimationFrame(() => { updateChipSpy(); placeBookends(); });
      });
      el.themeList.appendChild(b);
    });
    applyTheme(currentTheme());
  }

  // vlastní vzhled ze souboru (ZIP s brand.js), jen na tomto počítači
  function brandAction(kind) {
    el.themePop.hidden = true;
    fetch('api/brand', { method: 'POST', headers: { 'X-Reader': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: kind === 'reset' }) })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) { toast(kind === 'reset' ? 'Původní vzhled je zpátky.' : `Vzhled ${res.name} je načtený.`); setTimeout(() => location.reload(), 900); }
        else if (!res.cancelled) toast(res.error || 'Vzhled se nepodařilo načíst.');
      })
      .catch(() => toast('Čtečka neodpovídá. Běží ještě její okno?'));
  }
  document.querySelectorAll('[data-brand]').forEach((b) => b.addEventListener('click', () => brandAction(b.dataset.brand)));

  el.themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.themePop.hidden) {
      renderThemes();
      const st = lib.status || {};
      document.getElementById('theme-brand').hidden = !st.can_pick;
      document.querySelector('[data-brand="reset"]').hidden = !st.custom_brand;
    }
    el.themePop.hidden = !el.themePop.hidden;
  });

  const shelf = { cells: new Map(), sectionEls: new Map(), chipEls: new Map(), scroll: 0, query: '' };

  function renderMagTabs() {
    const tabs = [...manifest.magazines.map((m) => ({ id: m.id, title: m.title })), { id: 'all', title: 'Vše' }];
    if (manifest.magazines.length < 2) { el.magTabs.hidden = true; return; }
    el.magTabs.textContent = '';
    tabs.forEach((t) => {
      const n = t.id === 'all' ? manifest.issues.length : manifest.issues.filter((i) => i.magazine === t.id).length;
      const b = document.createElement('button');
      b.className = 'mag-tab' + (t.id === settings.magazine ? ' on' : '') + (t.id === 'all' ? ' mag-all' : ` mag-c${magIndex(t.id)}`);
      b.innerHTML = '<span class="mag-dot"></span><span class="mag-name"></span><span class="mag-count"></span>';
      b.querySelector('.mag-name').textContent = t.title;
      b.querySelector('.mag-count').textContent = n;
      b.addEventListener('click', () => {
        if (settings.magazine === t.id) return;
        settings.magazine = t.id;
        saveSettings();
        el.search.value = '';
        shelf.query = '';
        buildShelf();
        el.shelf.scrollTo({ top: 0 });
      });
      el.magTabs.appendChild(b);
    });
  }

  function buildShelf() {
    if (settings.magazine !== 'all' && !manifest.magazines.some((m) => m.id === settings.magazine)) settings.magazine = 'all';
    renderMagTabs();
    const old = new Map(shelf.cells); // stávající obálky se jen přesunou, ať neproblikávají
    shelf.cells.clear();
    shelf.sectionEls.clear();
    shelf.chipEls.clear();
    const issues = shelfIssues();
    const years = issues.map((i) => i.year).filter(Boolean);
    const pages = issues.reduce((a, i) => a + i.pages.length, 0);
    el.stats.textContent = `${issues.length} ${plural(issues.length, 'číslo', 'čísla', 'čísel')}` +
      (years.length ? ` · ${Math.min(...years) === Math.max(...years) ? years[0] : `${Math.min(...years)}–${Math.max(...years)}`}` : '');
    el.stats.title = `${fmt(pages)} stran`;

    const groups = new Map();
    issues.forEach((is) => { if (!groups.has(is.section)) groups.set(is.section, []); groups.get(is.section).push(is); });
    const order = (k) => (k === 'Speciály' ? 1e6 : k === 'Bez data' ? 1e6 - 1 : Number(k));
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b));

    el.sections.textContent = '';
    el.chips.textContent = '';
    for (const key of keys) {
      const list = groups.get(key);
      const sec = document.createElement('section');
      sec.className = 'year-section';
      sec.dataset.key = key;
      sec.innerHTML = `<header class="year-head"><h2 class="year-title"></h2><span class="year-count"></span><span class="year-line"></span></header>
        <div class="bookcase"><div class="bookcase-grid"></div></div>`;
      sec.querySelector('.year-title').textContent = key;
      const grid = sec.querySelector('.bookcase-grid');
      list.forEach((is) => {
        const cell = old.get(is.id);
        if (cell) shelf.cells.set(is.id, cell);
        grid.appendChild(cell || createCell(is));
      });
      grid.appendChild(bookend(shelf.sectionEls.size));
      el.sections.appendChild(sec);
      shelf.sectionEls.set(key, sec);

      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = key === 'Speciály' ? '★ Speciály' : key;
      chip.addEventListener('click', () => {
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      el.chips.appendChild(chip);
      shelf.chipEls.set(key, chip);
    }
    applyCoverSize(settings.coverW || defaultCoverW());
    applySort();
    refreshShelf();
    renderBookmarks();
  }

  function createCell(issue) {
    const a = document.createElement('a');
    a.className = `issue mag-c${magIndex(issue.magazine)}` + (issue.special ? ' special' : '');
    a.href = '#' + issue.id;
    a.dataset.id = issue.id;
    const c = issue.pages[0];
    a.innerHTML = `<div class="issue-cover" style="aspect-ratio:${c.w}/${c.h}">
        <img alt="" loading="lazy" decoding="async">
        <span class="issue-info"><b></b><span></span><em></em></span>
        <span class="issue-bar"><i></i></span>
        <span class="issue-done" title="Přečteno"><svg><use href="#i-check"/></svg></span>
        <span class="issue-saved" title="Uloženo v telefonu"><svg><use href="#i-phone"/></svg></span>
      </div><span class="issue-tag"></span><span class="issue-cap"><b></b><span></span></span>`;
    const img = a.querySelector('img');
    img.addEventListener('load', () => img.classList.add('ok'));
    img.src = coverUrl(issue);
    const tag = a.querySelector('.issue-tag');
    tag.textContent = issue.tag;
    if (issue.month) {
      const m = document.createElement('small');
      m.textContent = issue.month;
      tag.appendChild(m);
    }
    a.querySelector('.issue-cap b').textContent = issue.title;
    a.setAttribute('aria-label', [issue.title, issue.date].filter(Boolean).join(', '));
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      openIssue(issue, a);
    });
    shelf.cells.set(issue.id, a);
    return a;
  }

  // zarážka na konci každého ročníku: dvě diskety, nebo CD z přílohy
  const DISKS = [['#1d3c8c', '#e8322a'], ['#202024', '#ffd23f'], ['#8c1d1d', '#f3e6c4'], ['#3a3d44', '#5fc8ff'], ['#1e5e3a', '#ffd23f']];
  const disk = ([body, label]) => `<svg viewBox="0 0 88 92"><rect width="88" height="92" rx="3" fill="${body}"/>` +
    '<path d="M80 0h8v8z" fill="rgba(0,0,0,.6)"/><rect x="24" width="44" height="30" fill="#c4c8cf"/>' +
    `<rect x="50" y="4" width="11" height="21" fill="${body}"/><rect x="9" y="40" width="70" height="48" rx="2" fill="#f1ede2"/>` +
    `<rect x="9" y="40" width="70" height="7" fill="${label}"/><path d="M16 62h50M16 72h40M16 81h46" stroke="#b9b2a0" stroke-width="1.5"/>` +
    '<rect x="3" y="83" width="6" height="6" fill="rgba(0,0,0,.6)"/></svg>';

  function bookend(n) {
    const b = document.createElement('div');
    b.className = 'bookend';
    b.setAttribute('aria-hidden', 'true');
    b.innerHTML = n % 2
      ? '<div class="bookend-cd"><i></i><b>CD-ROM</b></div>'
      : `<div class="bookend-disks">${disk(DISKS[(n / 2) % 5])}${disk(DISKS[(n / 2 + 2) % 5])}</div>`;
    return b;
  }

  // zarážka jen tam, kde v poslední řadě zbývá místo
  function placeBookends() {
    for (const sec of shelf.sectionEls.values()) {
      const grid = sec.querySelector('.bookcase-grid');
      const be = grid && grid.querySelector('.bookend');
      if (!be || sec.hidden) continue;
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const n = grid.querySelectorAll('.issue:not([hidden])').length;
      be.hidden = cols < 2 || n % cols === 0;
    }
  }

  function updateCell(issue) {
    const a = shelf.cells.get(issue.id);
    if (!a) return;
    const st = statusOf(issue);
    const p = progress[issue.id];
    const n = issue.pages.length;
    a.classList.toggle('is-reading', st === 'reading');
    a.classList.toggle('is-done', st === 'done');
    a.classList.toggle('is-last', store.get('excal.last', null) === issue.id);
    a.classList.toggle('is-saved', offline.saved.has(issue.id));
    a.classList.toggle('is-away', offline.away && !offline.saved.has(issue.id));
    a.querySelector('.issue-bar i').style.width = st === 'reading' ? `${Math.round(((p.page + 1) / n) * 100)}%` : '0';
    a.querySelector('.issue-info b').textContent = issue.date ? issue.date + (issue.yearApprox ? '?' : '') : issue.title;
    a.querySelector('.issue-info span').textContent = `${n} ${plural(n, 'strana', 'strany', 'stran')}`;
    a.querySelector('.issue-info em').textContent =
      st === 'reading' ? `rozečteno · str. ${p.page + 1}` : st === 'done' ? 'přečteno' : '';
    a.querySelector('.issue-cap span').textContent =
      st === 'reading' ? `str. ${p.page + 1} / ${n}` : issue.date || `${n} stran`;
  }

  function refreshShelf() {
    if (!manifest) return;
    const issues = shelfIssues();
    issues.forEach(updateCell);
    const counts = { all: 0, reading: 0, unread: 0, done: 0, bookmarks: bookmarkItems().length, saved: 0 };
    issues.forEach((is) => { counts.all++; counts[statusOf(is)]++; if (offline.saved.has(is.id)) counts.saved++; });
    if (settings.filter === 'bookmarks' && !counts.bookmarks) settings.filter = 'all';
    if (settings.filter === 'saved' && !counts.saved) settings.filter = 'all';
    el.filterSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.filter === settings.filter);
      b.querySelector('.count').textContent = counts[b.dataset.filter];
      if (b.dataset.filter === 'bookmarks') b.hidden = !counts.bookmarks;
      if (b.dataset.filter === 'saved') b.hidden = !counts.saved;
    });
    renderHero();
    applyFilter();
    renderBookmarks();
  }

  // rozečtené číslo v hlavičce, jinak tipy na klávesy
  function renderHero() {
    const reading = manifest.issues
      .filter((is) => statusOf(is) === 'reading' && (!offline.away || offline.saved.has(is.id)))
      .sort((a, b) => progress[b.id].t - progress[a.id].t);
    el.hero.textContent = '';
    if (!reading.length) {
      el.hero.innerHTML = `<div class="hero-tips"><span><kbd>/</kbd> hledat číslo</span><span><kbd>←</kbd><kbd>→</kbd> listovat</span><span><kbd>+</kbd> lupa</span><span><kbd>F</kbd> celá obrazovka</span></div>`;
      return;
    }
    const main = reading[0];
    const p = progress[main.id];
    const n = main.pages.length;
    const pct = Math.round(((p.page + 1) / n) * 100);
    const box = document.createElement('div');
    box.className = 'hero-main';
    box.innerHTML = `<a class="hero-cover" href="#${main.id}" title="Otevřít"><img alt=""></a>
      <div class="hero-text">
        <div class="eyebrow">Uložená pozice</div>
        <h2></h2>
        <div class="hero-meta"></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="hero-actions">
        <button class="btn btn-accent" type="button">Pokračovat<svg><use href="#i-next"/></svg></button>
      </div>`;
    box.querySelector('img').src = coverUrl(main);
    box.querySelector('h2').textContent = main.title;
    box.querySelector('.hero-meta').textContent = `str. ${p.page + 1} / ${n} · ${ago(p.t)}`;
    box.querySelector('.hero-cover').addEventListener('click', (e) => {
      e.preventDefault();
      openIssue(main, box.querySelector('.hero-cover'));
    });
    box.querySelector('.btn-accent').addEventListener('click', () => {
      openIssue(main, box.querySelector('.hero-cover'), { resume: true });
    });
    el.hero.appendChild(box);

    if (reading.length > 1) {
      const others = document.createElement('div');
      others.className = 'hero-others';
      others.innerHTML = '<div class="hero-others-list" style="display:flex;gap:8px"></div>';
      const list = others.querySelector('.hero-others-list');
      reading.slice(1, 4).forEach((is) => {
        const q = progress[is.id];
        const a = document.createElement('a');
        a.className = 'mini';
        a.href = '#' + is.id;
        a.title = `${is.title} – str. ${q.page + 1}`;
        a.innerHTML = `<img alt=""><div class="progress"><i style="width:${Math.round(((q.page + 1) / is.pages.length) * 100)}%"></i></div><span></span>`;
        a.querySelector('img').src = coverUrl(is);
        a.querySelector('span').textContent = is.number;
        a.addEventListener('click', (e) => { e.preventDefault(); openIssue(is, a); });
        list.appendChild(a);
      });
      el.hero.appendChild(others);
    }
  }

  function matches(issue) {
    const st = statusOf(issue);
    if (settings.filter === 'bookmarks') return false; // místo obálek se ukážou záložky
    if (settings.filter === 'saved') { if (!offline.saved.has(issue.id)) return false; }
    else if (settings.filter !== 'all' && st !== settings.filter) return false;
    const q = norm(shelf.query).trim();
    if (!q) return true;
    return q.split(/\s+/).every((tok) => {
      if (/^\d{4}$/.test(tok)) return String(issue.year) === tok;
      if (/^\d{1,3}\+?$/.test(tok)) return norm(issue.number).startsWith(tok);
      return issue.searchText.includes(tok);
    });
  }

  function applyFilter() {
    let shown = 0;
    for (const [key, sec] of shelf.sectionEls) {
      let n = 0;
      sec.querySelectorAll('.issue').forEach((a) => {
        const ok = matches(byId.get(a.dataset.id));
        a.hidden = !ok;
        if (ok) n++;
      });
      sec.hidden = n === 0;
      sec.querySelector('.year-count').textContent = `${n} ${plural(n, 'číslo', 'čísla', 'čísel')}`;
      const chip = shelf.chipEls.get(key);
      if (chip) chip.disabled = n === 0;
      shown += n;
    }
    const other = textHits.count > 0 || settings.filter === 'bookmarks'; // místo obálek jsou výsledky nebo záložky
    el.empty.hidden = shown > 0 || other;
    if (!shown && !other) {
      el.empty.innerHTML = '<b>Nic takového na poličce není</b>Zkus jiné číslo nebo zruš filtr.<br><button class="btn btn-ghost" type="button">Zobrazit vše</button>';
      el.empty.querySelector('button').addEventListener('click', () => {
        settings.filter = 'all'; saveSettings();
        el.search.value = ''; shelf.query = '';
        refreshShelf();
      });
    }
    requestAnimationFrame(() => { updateChipSpy(); placeBookends(); });
  }

  function applySort() {
    const desc = settings.sort === 'desc';
    const secs = [...shelf.sectionEls.values()];
    const chips = [...shelf.chipEls.values()];
    // Speciály vždy na konci
    const sp = (arr, isSec) => {
      const i = arr.findIndex((x) => (isSec ? x.dataset.key : x.textContent).includes('Speciály'));
      return i >= 0 ? arr.splice(i, 1) : [];
    };
    const secSp = sp(secs, true);
    const chipSp = sp(chips, false);
    (desc ? secs.reverse() : secs).concat(secSp).forEach((s) => {
      const grid = s.querySelector('.bookcase-grid');
      const cells = [...grid.querySelectorAll('.issue')];
      const magOrder = (is) => manifest.magazines.findIndex((m) => m.id === is.magazine);
      cells.sort((a, b) => {
        const ia = byId.get(a.dataset.id);
        const ib = byId.get(b.dataset.id);
        const d = magOrder(ia) - magOrder(ib) || ia.sort[0] - ib.sort[0] || ia.sort[1] - ib.sort[1];
        return desc ? -d : d;
      });
      cells.forEach((c) => grid.appendChild(c));
      const be = grid.querySelector('.bookend');
      if (be) grid.appendChild(be);
      el.sections.appendChild(s);
    });
    (desc ? chips.reverse() : chips).concat(chipSp).forEach((c) => el.chips.appendChild(c));
    el.sortBtn.innerHTML = `<svg><use href="#i-sort-${desc ? 'desc' : 'asc'}"/></svg>`;
    el.sortBtn.title = desc ? 'Řazení: od nejnovějších' : 'Řazení: od nejstarších';
  }

  function defaultCoverW() {
    const w = window.innerWidth;
    return w < 600 ? 96 : w < 1100 ? 132 : w < 1800 ? 150 : w < 2400 ? 172 : 196;
  }
  function applyCoverSize(w) {
    w = clamp(Math.round(w), 96, 240);
    document.documentElement.style.setProperty('--cover-w', w + 'px');
    el.size.value = String(w);
    placeBookends();
  }

  function updateChipSpy() {
    if (el.shelf.hidden) return;
    const tb = el.toolbar.getBoundingClientRect();
    document.documentElement.style.setProperty('--toolbar-h', Math.round(tb.height) + 'px');
    // aktivní rok = poslední sekce, která už je pod lištou
    let active = null;
    el.sections.querySelectorAll('.year-section:not([hidden])').forEach((sec) => {
      if (!active || sec.getBoundingClientRect().top <= tb.bottom + 60) active = sec.dataset.key;
    });
    for (const [key, chip] of shelf.chipEls) {
      const on = key === active;
      if (on && !chip.classList.contains('on')) {
        const cr = chip.getBoundingClientRect();
        const pr = el.chips.getBoundingClientRect();
        if (cr.left < pr.left + 20 || cr.right > pr.right - 20) {
          el.chips.scrollLeft += cr.left - pr.left - pr.width / 2 + cr.width / 2;
        }
      }
      chip.classList.toggle('on', on);
    }
  }
  let spyRaf = 0;
  el.shelf.addEventListener('scroll', () => {
    if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyRaf = 0; updateChipSpy(); });
  }, { passive: true });

  function restoreShelf(leavingId) {
    el.shelf.scrollTop = shelf.scroll;
    requestAnimationFrame(updateChipSpy);
    if (!leavingId) return;
    const cell = shelf.cells.get(leavingId);
    if (!cell || cell.hidden) return;
    const r = cell.getBoundingClientRect();
    const tb = el.toolbar.getBoundingClientRect();
    if (r.top < tb.bottom || r.bottom > window.innerHeight) cell.scrollIntoView({ block: 'center' });
    cell.classList.remove('pulse');
    void cell.offsetWidth;
    cell.classList.add('pulse');
    setTimeout(() => cell.classList.remove('pulse'), 1700);
  }

  let pendingResume = null; // Pokračovat z hlavičky: otevřít rovnou na rozečtené straně
  function openIssue(issue, fromEl, opts) {
    if (notHere(issue)) return;
    pendingResume = opts && opts.resume ? issue.id : null;
    const img = fromEl && fromEl.querySelector('img');
    if (img && img.complete && img.naturalWidth) {
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < window.innerHeight) {
        pendingFlight = { id: issue.id, rect: r, src: img.currentSrc || img.src };
      }
    }
    location.hash = issue.id;
  }

  // obálka přeletí z poličky na místo časopisu
  function runFlight(f) {
    const clone = new Image();
    clone.src = f.src;
    clone.className = 'flight';
    Object.assign(clone.style, { left: f.rect.left + 'px', top: f.rect.top + 'px', width: f.rect.width + 'px', height: f.rect.height + 'px' });
    document.body.appendChild(clone);
    el.holder.classList.add('arriving');
    let finished = false;
    el.intro.classList.remove('show');
    const finish = () => {
      if (finished) return;
      finished = true;
      el.holder.classList.remove('arriving');
      updateIntro();
      const fade = clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
      fade.onfinish = () => clone.remove();
      setTimeout(() => clone.remove(), 400);
    };
    setTimeout(finish, 1200); // v okně na pozadí animace nemusí doběhnout
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let t = null;
      if (state.flip && visiblePages(state.current)[0] === 0) t = state.pageEls[0].getBoundingClientRect();
      if (!t || !t.width) {
        const h = el.holder.getBoundingClientRect();
        t = { left: h.left + h.width / 2 - state.pageW / 2, top: h.top, width: state.pageW, height: state.pageH };
      }
      if (!t.width) { clone.remove(); el.holder.classList.remove('arriving'); return; }
      Object.assign(clone.style, { left: t.left + 'px', top: t.top + 'px', width: t.width + 'px', height: t.height + 'px' });
      const sx = f.rect.width / t.width;
      const sy = f.rect.height / t.height;
      const anim = clone.animate(
        [{ transform: `translate(${f.rect.left - t.left}px, ${f.rect.top - t.top}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
        { duration: 520, easing: 'cubic-bezier(.2,.75,.25,1)' }
      );
      anim.onfinish = finish;
    }));
  }

  // logo = hlavní stránka: polička od začátku, bez hledání a filtru
  el.brandMark.addEventListener('click', (e) => {
    e.preventDefault();
    el.themePop.hidden = el.libPop.hidden = el.phonePop.hidden = true;
    el.search.value = '';
    shelf.query = '';
    settings.filter = offline.away && offline.saved.size ? 'saved' : 'all';
    saveSettings();
    scheduleTextSearch();
    if (location.hash.length > 1) location.hash = '';
    else refreshShelf();
    el.shelf.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ovládání poličky
  el.filterSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    settings.filter = b.dataset.filter;
    saveSettings();
    refreshShelf();
  });
  el.search.addEventListener('input', () => {
    shelf.query = el.search.value;
    scheduleTextSearch();
    applyFilter();
    const top = Math.max(0, el.sections.offsetTop - el.toolbar.offsetHeight - 16);
    if (shelf.query && el.shelf.scrollTop > top) el.shelf.scrollTo({ top });
  });
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = norm(el.search.value).trim();
      const visible = shelfIssues().filter((is) => shelf.cells.get(is.id) && !shelf.cells.get(is.id).hidden);
      const exact = visible.find((is) => norm(is.number) === q) || visible[0];
      if (exact) openIssue(exact, shelf.cells.get(exact.id));
    } else if (e.key === 'Escape') {
      el.search.value = '';
      shelf.query = '';
      scheduleTextSearch();
      applyFilter();
      el.search.blur();
      e.stopPropagation();
    } else if (e.key === 'ArrowDown') {
      const first = el.sections.querySelector('.issue:not([hidden])');
      if (first) { first.focus(); e.preventDefault(); }
    }
  });
  el.sortBtn.addEventListener('click', () => {
    settings.sort = settings.sort === 'desc' ? 'asc' : 'desc';
    saveSettings();
    applySort();
    el.shelf.scrollTo({ top: 0 });
    requestAnimationFrame(updateChipSpy);
  });
  el.size.addEventListener('input', () => {
    settings.coverW = Number(el.size.value);
    applyCoverSize(settings.coverW);
    saveSettings();
  });
  el.random.addEventListener('click', () => {
    const visible = shelfIssues().filter((is) => shelf.cells.get(is.id) && !shelf.cells.get(is.id).hidden);
    const pool = visible.filter((is) => statusOf(is) === 'unread');
    const list = pool.length ? pool : visible.length ? visible : shelfIssues();
    const pick = list[Math.floor(Math.random() * list.length)];
    const cell = shelf.cells.get(pick.id);
    cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
    cell.classList.remove('pulse');
    void cell.offsetWidth;
    cell.classList.add('pulse');
    setTimeout(() => openIssue(pick, cell), 650);
  });
  // Ctrl + kolečko na poličce = velikost obálek
  el.shelf.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || pageZoomed()) return;
    e.preventDefault();
    settings.coverW = clamp((settings.coverW || defaultCoverW()) * Math.exp(-e.deltaY * 0.0025), 96, 240);
    applyCoverSize(settings.coverW);
    saveSettings();
  }, { passive: false });

  function moveShelfFocus(dir) {
    const cells = [...el.sections.querySelectorAll('.year-section:not([hidden]) .issue:not([hidden])')];
    if (!cells.length) return;
    const cur = document.activeElement && document.activeElement.closest && document.activeElement.closest('.issue');
    let target;
    if (!cur) target = cells[0];
    else {
      const i = cells.indexOf(cur);
      if (dir === 'left') target = cells[i - 1];
      else if (dir === 'right') target = cells[i + 1];
      else {
        const r = cur.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        let best = null;
        let bestScore = Infinity;
        cells.forEach((c) => {
          const q = c.getBoundingClientRect();
          const dy = q.top - r.top;
          if ((dir === 'down' && dy < 10) || (dir === 'up' && dy > -10)) return;
          const score = Math.abs(dy) * 4 + Math.abs(q.left + q.width / 2 - cx);
          if (score < bestScore) { bestScore = score; best = c; }
        });
        target = best;
      }
    }
    if (target) {
      target.focus({ preventScroll: true });
      const r = target.getBoundingClientRect();
      const tb = el.toolbar.getBoundingClientRect();
      if (r.top < tb.bottom + 10 || r.bottom > window.innerHeight - 10) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // --- listování
  function computeSize() {
    const aw = el.area.clientWidth;
    const ah = el.area.clientHeight;
    const narrow = aw < 700;
    const side = narrow ? 0 : 68;
    const pad = narrow ? 6 : 22;
    const availW = Math.max(100, aw - 2 * side - 2 * pad);
    const availH = Math.max(100, ah - 2 * pad);
    const aspect = state.issue.aspect || 0.694;
    const landscape = availW > availH; // na šířku dvoustrana, na výšku jedna strana
    let h = landscape ? Math.min(availH, availW / 2 / aspect) : Math.min(availH, availW / aspect);
    h = Math.max(120, Math.floor(h));
    const w = Math.floor(h * aspect);
    return { landscape, w, h };
  }

  function buildBook(issue, start) {
    destroyBook();
    state.issue = issue;
    setLast(issue.id);
    el.title.textContent = issue.title;
    el.date.textContent = issue.date || '';
    document.title = `${issue.title} – ${APP}`;
    el.slider.max = String(issue.pages.length - 1);
    el.nextIssue.hidden = true;

    const { landscape, w, h } = computeSize();
    state.landscape = landscape;
    state.pageW = w;
    state.pageH = h;
    state.useFull = needFull(h);
    sizeHolder();

    const root = document.createElement('div');
    root.className = 'flip-root';
    el.holder.appendChild(root);

    const n = issue.pages.length;
    state.pageEls = issue.pages.map((p, i) => {
      const d = document.createElement('div');
      d.className = 'page ' + (i === 0 ? 'page--cover' : i % 2 ? 'page--left' : 'page--right');
      if (i === n - 1 && i % 2 === 1) d.classList.add('page--back');
      if (p.w / p.h > 1) d.classList.add('page--wide'); // rozkládací plakát na místě jedné strany
      d.dataset.index = String(i);
      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.addEventListener('load', () => d.classList.add('loaded'));
      d.append(num, img);
      d._img = img;
      return d;
    });

    const flip = new St.PageFlip(root, {
      width: w,
      height: h,
      size: 'fixed',
      autoSize: true,
      showCover: true,
      usePortrait: true,
      drawShadow: true,
      maxShadowOpacity: 0.45,
      flippingTime: SPEEDS[settings.speed],
      mobileScrollSupport: false,
      disableFlipByClick: true, // klik doprostřed otevře lupu, otáčí se za roh
      showPageCorners: true,
      clickEventForward: true,
      useMouseEvents: true,
      swipeDistance: 30,
      startPage: start,
    });
    state.flip = flip;
    state.flipState = 'read';
    state.current = start;

    flip.on('flip', (e) => onPageChange(e.data));
    flip.on('init', () => onPageChange(flip.getCurrentPageIndex()));
    flip.on('changeState', (e) => {
      state.flipState = e.data;
      el.holder.dataset.flip = e.data; // kurzor: u rohu ruka na otočení, uprostřed lupa
      if (e.data === 'flipping' || e.data === 'user_fold') { preShift(); el.intro.classList.remove('show'); }
      if (e.data === 'read') { applyShift(true); updateIntro(); }
    });
    flip.on('changeOrientation', () => sizeHolder());

    loadAround(start);
    flip.loadFromHTML(state.pageEls);
    applyShift(false);
    renderIntro();

    if (pendingResume === issue.id) {
      pendingResume = null;
      const p = progress[issue.id];
      if (p && p.page > 0) setTimeout(() => { if (state.flip === flip) openAt(p.page); }, 650);
    }
  }

  // otevře časopis animací, případně pak skočí na rozečtenou dvoustranu
  let pendingJump = null;
  function openAt(page) {
    if (!state.flip) return;
    if (page <= 1 || settings.speed === 'off') {
      if (page <= 1) flipNext(); else goToPage(page);
      return;
    }
    pendingJump = page;
    state.flip.flipNext('bottom');
  }

  // karta vedle zavřeného časopisu (obálka nejdřív)
  function renderIntro() {
    const issue = state.issue;
    if (!issue) return;
    const n = issue.pages.length;
    const p = progress[issue.id];
    const resume = p && p.page > 0 ? p.page : 0;
    const list = sameMagazine(issue);
    const idx = list.indexOf(issue);
    const prev = list[idx - 1];
    const next = list[idx + 1];
    const kind = issue.numbered ? `Číslo ${issue.number}` : 'Speciál';
    const done = statusOf(issue) === 'done';
    const read = done || resume; // velké číslo: kolik je přečteno, u nového čísla počet stran
    el.intro.innerHTML = `
      <div class="intro-bar"></div>
      <div class="intro-in">
        <h2 class="intro-title"></h2>
        <div class="intro-sub"></div>
        <div class="intro-specs"></div>
        <div class="intro-score"><span>${read ? 'Přečteno' : 'Stran'}</span>
          <b>${read ? `${done ? 100 : Math.round(((resume + 1) / n) * 100)}<small>%</small>` : n}</b></div>
        <div class="intro-actions">
          ${resume
            ? `<button class="btn btn-accent" data-act="resume">Pokračovat na str. ${resume + 1}<svg><use href="#i-next"/></svg></button>
               <button class="btn btn-ghost" data-act="open">Od začátku</button>`
            : `<button class="btn btn-accent" data-act="open">Otevřít časopis<svg><use href="#i-next"/></svg></button>`}
          <span class="trip">${tripHtml(issue)}</span>
        </div>
        <div class="intro-hint">nebo klikni na obálku · <kbd>→</kbd></div>
        <nav class="intro-nav">
          ${prev ? `<button class="btn" data-go="${prev.id}"><svg><use href="#i-back"/></svg>${esc(prev.short)}</button>` : ''}
          ${next ? `<button class="btn" data-go="${next.id}" data-next>${esc(next.short)}<svg><use href="#i-next"/></svg></button>` : ''}
        </nav>
      </div>`;
    el.intro.querySelector('.intro-bar').textContent = kind;
    el.intro.querySelector('.intro-title').textContent = issue.title;
    el.intro.querySelector('.intro-sub').textContent = issue.date || '';
    el.intro.querySelector('.intro-specs').textContent = (read
      ? [`${n} ${plural(n, 'strana', 'strany', 'stran')}`, resume ? `rozečteno na str. ${resume + 1}` : '', p && p.t ? ago(p.t) : '']
      : ['Ještě neotevřené']).filter(Boolean).map((t) => t.replace(/ /g, ' ')).join(' · '); // zalomit jen mezi údaji
    updateIntro();
  }
  el.intro.addEventListener('click', (e) => {
    if (e.target.closest('[data-trip]')) {
      toast('Připravuju číslo na cestu, u tlustých čísel to chvíli trvá. Pak ho otevři v aplikaci na komiksy, třeba Librera.');
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-save')) return saveIssue(state.issue);
    if (b.hasAttribute('data-unsave')) return removeIssue(state.issue);
    if (b.hasAttribute('data-install')) return install();
    if (b.dataset.act === 'resume') { const p = progress[state.issue.id]; openAt(p ? p.page : 1); }
    else if (b.dataset.act === 'open') flipNext();
    else if (b.dataset.go) { const is = byId.get(b.dataset.go); if (is) location.replace('#' + is.id); }
  });

  // karta je vidět jen u zavřeného časopisu, vedle obálky nebo dole
  function updateIntro() {
    const show = !!state.flip && state.current === 0 && !R.open && state.flipState === 'read' &&
      !el.holder.classList.contains('arriving');
    if (!show) { el.intro.classList.remove('show'); return; }
    const area = el.area.getBoundingClientRect();
    const coverRight = area.width / 2 + state.pageW / 2;
    const room = area.width - coverRight - 60;
    const side = state.landscape && room >= 300;
    el.intro.classList.toggle('bottom', !side);
    if (side) {
      el.intro.style.left = coverRight + 40 + 'px';
      el.intro.style.top = '50%';
      el.intro.style.marginTop = -(el.intro.offsetHeight / 2) + 'px';
      el.intro.style.width = Math.min(340, room) + 'px';
    } else {
      el.intro.style.marginTop = '0';
      el.intro.style.width = '';
    }
    el.intro.classList.add('show');
  }

  function destroyBook() {
    const f = state.flip;
    if (f) {
      try { f.destroy(); } catch (e) {}
      // StPageFlip po destroy() nechá běžet svou rAF smyčku
      try { const r = f.getRender(); r.render = () => {}; r.drawFrame = () => {}; } catch (e) {}
    }
    el.holder.querySelectorAll('.flip-root').forEach((n) => n.remove());
    state.flip = null;
    state.pageEls = [];
    state.issue = null;
  }

  const needFull = (pageH) => pageH * (window.devicePixelRatio || 1) > 1750;

  function sizeHolder() {
    el.holder.style.width = (state.landscape ? 2 * state.pageW : state.pageW) + 'px';
    el.holder.style.height = state.pageH + 'px';
    el.holder.classList.toggle('is-landscape', state.landscape);
  }

  function relayout() {
    if (!state.flip || el.book.hidden) return;
    const { landscape, w, h } = computeSize();
    if (w === state.pageW && h === state.pageH && landscape === state.landscape) return;
    state.landscape = landscape;
    state.pageW = w;
    state.pageH = h;
    const s = state.flip.getSettings();
    s.width = w; s.height = h;
    s.minWidth = s.maxWidth = w;
    s.minHeight = s.maxHeight = h;
    const root = el.holder.querySelector('.flip-root');
    if (root) {
      root.style.minWidth = w + 'px';
      root.style.minHeight = h + 'px';
      root.style.maxWidth = 2 * w + 'px';
    }
    sizeHolder();
    state.flip.update();
    const wrapper = root && root.querySelector('.stf__wrapper');
    if (wrapper) wrapper.style.paddingBottom = (h / (landscape ? 2 * w : w)) * 100 + '%';
    const full = needFull(h);
    if (full !== state.useFull) {
      state.useFull = full;
      state.pageEls.forEach((d) => { d._img.removeAttribute('src'); d.classList.remove('loaded'); });
    }
    onPageChange(state.flip.getCurrentPageIndex());
    applyShift(false);
  }

  function visiblePages(i) {
    const n = state.issue.pages.length;
    if (!state.landscape) return [i];
    return spreadOf(i, n);
  }
  // dvoustrana se stranou i (obálka a zadní strana jsou samostatně)
  function spreadOf(i, n) {
    if (i <= 0) return [0];
    const left = i % 2 === 1 ? i : i - 1;
    if (left >= n - 1) return [n - 1];
    return [left, left + 1];
  }

  function onPageChange(i) {
    if (!state.issue) return;
    state.current = i;
    const issue = state.issue;
    const n = issue.pages.length;
    const vis = visiblePages(i);
    el.ind.textContent = (vis.length === 2 ? `${vis[0] + 1}–${vis[1] + 1}` : `${vis[0] + 1}`) + ` / ${n}`;
    el.slider.value = String(vis[0]);
    el.navPrev.disabled = vis[0] <= 0;
    el.navNext.disabled = vis[vis.length - 1] >= n - 1;
    // zavřená obálka nepřepisuje rozečtenou stránku
    if (vis[0] > 0) saveProgress(issue.id, vis[0], vis[vis.length - 1]);
    loadAround(i);
    if (state.flipState === 'read') applyShift(!R.open);
    schedulePrefetchFull(vis);
    updateNextIssue(vis);
    updateIntro();
    updateBookmarkBtn();
    if (i > 0 && !store.get('excal.help', false)) showHelp(true);
    if (pendingJump != null && i > 0) {
      const target = pendingJump;
      pendingJump = null;
      if (!visiblePages(i).includes(target)) setTimeout(() => goToPage(target), 40);
    }
  }

  function updateNextIssue(vis) {
    const issue = state.issue;
    const atEnd = vis[vis.length - 1] >= issue.pages.length - 1;
    const list = sameMagazine(issue);
    const next = list[list.indexOf(issue) + 1];
    if (!atEnd || !next) { el.nextIssue.hidden = true; return; }
    el.nextIssue.href = '#' + next.id;
    el.nextIssue.innerHTML = '<img alt=""><div><small>Další číslo</small><b></b></div><svg><use href="#i-next"/></svg>';
    el.nextIssue.querySelector('img').src = coverUrl(next);
    el.nextIssue.querySelector('b').textContent = next.title + (next.date ? ` · ${next.date}` : '');
    el.nextIssue.hidden = false;
  }
  el.nextIssue.addEventListener('click', (e) => {
    e.preventDefault();
    const id = el.nextIssue.getAttribute('href').slice(1);
    const next = byId.get(id);
    if (next) openIssue(next, el.nextIssue);
  });

  // přednačte okolní stránky; rozestahované, přes které se jen přeskočilo, zruší, vzdálené uvolní
  function loadAround(i) {
    const kind = state.useFull ? 'full' : 'view';
    const vis = visiblePages(i);
    const wanted = (j) => j - i >= -4 && j - i <= 7;
    const setSrc = (j, high) => {
      const d = state.pageEls[j];
      if (!d) return;
      const src = imgUrl(state.issue, state.issue.pages[j], kind);
      d._img.fetchPriority = high ? 'high' : 'low';
      if (d._img.getAttribute('src') !== src) d._img.src = src;
    };
    state.pageEls.forEach((d, j) => {
      if (wanted(j) || !d._img.hasAttribute('src')) return;
      if (!d._img.complete || Math.abs(j - i) > 24) {
        d._img.removeAttribute('src');
        d.classList.remove('loaded');
      }
    });
    vis.forEach((j) => setSrc(j, true));
    for (let k = 1; k <= 7; k++) {
      setSrc(i + vis.length - 1 + k, false);
      if (k <= 4) setSrc(i - k, false);
    }
  }

  let prefetchTimer = 0;
  const prefetched = new Set();
  function prefetch(url) {
    if (prefetched.has(url)) return;
    prefetched.add(url);
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
  }
  function schedulePrefetchFull(vis) {
    clearTimeout(prefetchTimer);
    const issue = state.issue;
    prefetchTimer = setTimeout(() => {
      if (state.issue !== issue) return;
      vis.forEach((i) => prefetch(imgUrl(issue, issue.pages[i], 'full')));
    }, 1200);
  }

  // zavřený časopis (obálka, zadní strana) posunout doprostřed
  function shiftFor(i) {
    if (!state.landscape || !state.issue) return 0;
    const n = state.issue.pages.length;
    if (i === 0) return -state.pageW / 2;
    if (i === n - 1 && i % 2 === 1) return state.pageW / 2;
    return 0;
  }
  function setShadow(mode) {
    const w = state.pageW;
    if (!state.landscape || mode === 'full') { el.shadow.style.left = '0px'; el.shadow.style.width = '100%'; }
    else if (mode === 'right') { el.shadow.style.left = w + 'px'; el.shadow.style.width = w + 'px'; }
    else { el.shadow.style.left = '0px'; el.shadow.style.width = w + 'px'; }
  }
  function applyShift(animated) {
    if (!state.issue) return;
    el.holder.classList.toggle('no-anim', !animated);
    const shift = shiftFor(state.current);
    el.holder.style.transform = `translateX(${shift}px)`;
    setShadow(shift < 0 ? 'right' : shift > 0 ? 'left' : 'full');
    if (!animated) requestAnimationFrame(() => el.holder.classList.remove('no-anim'));
  }
  function preShift() {
    if (shiftFor(state.current) !== 0) {
      el.holder.style.transform = 'translateX(0px)';
      setShadow('full');
    }
  }

  function flipNext() {
    if (!state.flip) return;
    const vis = visiblePages(state.current);
    if (vis[vis.length - 1] >= state.issue.pages.length - 1) return;
    if (settings.speed === 'off') state.flip.turnToNextPage();
    else state.flip.flipNext('bottom');
  }
  function flipPrev() {
    if (!state.flip) return;
    if (visiblePages(state.current)[0] <= 0) return;
    if (settings.speed === 'off') state.flip.turnToPrevPage();
    else state.flip.flipPrev('bottom');
  }
  // šipky a kolečko: stisk otočí list s animací, podržená klávesa přeskakuje rychle
  function step(dir, repeat) {
    if (repeat) { turn(dir); return; }
    if (dir > 0) flipNext(); else flipPrev();
  }
  // posun bez animace
  function turn(dir) {
    if (!state.flip || state.flipState === 'flipping' || state.flipState === 'user_fold') return;
    const vis = visiblePages(state.current);
    if (dir > 0 && vis[vis.length - 1] < state.issue.pages.length - 1) state.flip.turnToNextPage();
    if (dir < 0 && vis[0] > 0) state.flip.turnToPrevPage();
  }
  function goToPage(i) {
    if (!state.flip) return;
    state.flip.turnToPage(clamp(i, 0, state.issue.pages.length - 1));
  }

  // klik doprostřed stránky otevře lupu, rohy obsluhuje StPageFlip
  let downPos = null;
  el.holder.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; }, true);
  el.holder.addEventListener('click', (e) => {
    if (!state.flip || !downPos) return;
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
    if (state.flipState !== 'read') return;
    if (inCorner(e.clientX, e.clientY)) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const idx = Number(pageEl.dataset.index);
    if (idx === 0 && state.current === 0) { flipNext(); return; } // obálka: otevřít časopis
    pendingOpen = { fromBook: true };
    location.hash = readerHash(state.issue.id, 'page', idx);
  });

  // na kterou stranu se list otočí, podle toho kurzor ukazuje šipku dopředu nebo zpět
  el.holder.addEventListener('mousemove', (e) => {
    if (state.flipState === 'user_fold' || state.flipState === 'flipping') return;
    const r = el.holder.getBoundingClientRect();
    el.holder.dataset.side = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
  });

  function inCorner(cx, cy) {
    const r = el.holder.getBoundingClientRect();
    const d = Math.hypot(state.pageW, state.pageH) / 5; // stejná zóna jako v StPageFlip
    const x = cx - r.left;
    const y = cy - r.top;
    const nearX = state.landscape ? x < d || x > r.width - d : x > r.width - d;
    const nearY = y < d || y > r.height - d;
    return nearX && nearY;
  }

  // lupa z dvoustrany, začíná přesně na místě knihy
  function zoomFromBook(cx, cy, factor) {
    if (!state.flip || R.open) return;
    if (pendingOpen && pendingOpen.zoom) {
      pendingOpen.zoom.factor *= factor;
      pendingOpen.zoom.cx = cx;
      pendingOpen.zoom.cy = cy;
      return;
    }
    if (state.flipState !== 'read') return;
    const vis = visiblePages(state.current);
    pendingOpen = { fromBook: true, zoom: { cx, cy, factor } };
    location.hash = readerHash(state.issue.id, state.landscape ? 'spread' : 'page', vis[0]);
  }

  // dva prsty v listování: roztažení otevře lupu na tom místě a gesto v ní plynule pokračuje
  const bookPinch = { pts: new Map(), d0: 0, handed: false, multi: false };
  el.holder.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || R.open) return;
    bookPinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (bookPinch.pts.size === 2) {
      const [a, b] = [...bookPinch.pts.values()];
      bookPinch.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    }
  }, true);
  document.addEventListener('pointermove', (e) => {
    const p = bookPinch.pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (bookPinch.pts.size !== 2) return;
    const [a, b] = [...bookPinch.pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!bookPinch.handed) {
      if (d / bookPinch.d0 < 1.08 || !state.flip) return;
      bookPinch.handed = true;
      zoomFromBook((a.x + b.x) / 2, (a.y + b.y) / 2, d / bookPinch.d0);
    } else if (R.open && !R.pointers.size) {
      // lupa už je otevřená: prsty převezme ona
      stopMotion();
      R.anchor = null;
      for (const [id, q] of bookPinch.pts) {
        try { el.stage.setPointerCapture(id); } catch (err) { /* prst už je dole */ }
        R.pointers.set(id, { x: q.x, y: q.y });
      }
      R.pinch = { d: d || 1, s: R.cur.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ox: R.cur.x, oy: R.cur.y };
      R.drag = null;
      R.tgt = { ...R.cur };
      el.sheet.classList.add('moving');
      bookPinch.pts.clear();
    }
  }, true);
  const endBookPinch = (e) => {
    bookPinch.pts.delete(e.pointerId);
    if (!bookPinch.pts.size) bookPinch.handed = false;
  };
  document.addEventListener('pointerup', endBookPinch, true);
  document.addEventListener('pointercancel', endBookPinch, true);
  // druhý prst nesmí StPageFlip vzít jako tah za list
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((t) => el.holder.addEventListener(t, (e) => {
    if (e.touches.length > 1 && !bookPinch.multi) {
      bookPinch.multi = true;
      try { state.flip.ui.touchPoint = null; state.flip.userStop({ x: 0, y: 0 }, true); } catch (err) { /* jiná verze StPageFlip */ }
    }
    if (bookPinch.multi) e.stopPropagation();
    if (!e.touches.length) bookPinch.multi = false;
  }, { capture: true, passive: true }));

  // kolečko listuje, Ctrl + kolečko (štípnutí na touchpadu) otevře lupu
  let wheelAcc = 0;
  let wheelLock = 0;
  el.area.addEventListener('wheel', (e) => {
    if (!state.flip || (e.ctrlKey && pageZoomed())) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      if (e.deltaY < 0) zoomFromBook(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.006));
      return;
    }
    if (state.flipState !== 'read') return;
    const now = performance.now();
    if (now < wheelLock) { wheelLock = now + 180; return; } // jedno gesto = jedna stránka
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAcc += d * unit;
    if (Math.abs(wheelAcc) >= 60) {
      step(Math.sign(wheelAcc), false);
      wheelAcc = 0;
      wheelLock = now + 260;
    }
  }, { passive: false });

  el.navPrev.addEventListener('click', flipPrev);
  el.navNext.addEventListener('click', flipNext);
  $('#btn-shelf').addEventListener('click', goUp);
  // lupa tlačítkem nebo klávesou
  function zoomBookButton() {
    const vis = state.flip ? visiblePages(state.current) : [];
    const els = vis.map((i) => state.pageEls[i].getBoundingClientRect()).filter((r) => r.width > 0);
    if (!els.length) return;
    const left = Math.min(...els.map((r) => r.left));
    const right = Math.max(...els.map((r) => r.right));
    zoomFromBook((left + right) / 2, els[0].top + els[0].height * 0.3, 1.8);
  }
  el.bzIn.addEventListener('click', zoomBookButton);
  el.bzLabel.addEventListener('click', zoomBookButton);
  // tlačítko po kliknutí myší nedrží fokus, jinak by mezerník otáčel dvakrát
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });

  el.slider.addEventListener('input', () => {
    const v = Number(el.slider.value);
    el.ind.textContent = `${v + 1} / ${state.issue.pages.length}`;
  });
  el.slider.addEventListener('change', () => {
    goToPage(Number(el.slider.value));
    el.slider.blur();
  });

  // nastavení rychlosti
  function renderSpeed() {
    el.speedSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.speed === settings.speed));
  }
  el.speedSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    settings.speed = b.dataset.speed;
    saveSettings();
    if (state.flip) state.flip.getSettings().flippingTime = SPEEDS[settings.speed];
    renderSpeed();
  });
  el.settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.settingsPop.hidden = !el.settingsPop.hidden;
    renderSpeed();
  });
  function closePopover() { el.settingsPop.hidden = true; }
  document.addEventListener('pointerdown', (e) => {
    if (!el.settingsPop.hidden && !el.settingsPop.contains(e.target) && !el.settingsBtn.contains(e.target)) closePopover();
    if (!el.themePop.hidden && !el.themePop.contains(e.target) && !el.themeBtn.contains(e.target)) el.themePop.hidden = true;
    if (!el.libPop.hidden && !el.libPop.contains(e.target) && !el.libBtn.contains(e.target)) el.libPop.hidden = true;
    if (!el.phonePop.hidden && !el.phonePop.contains(e.target) && !el.phoneBtn.contains(e.target)) el.phonePop.hidden = true;
  });

  // přehled stran
  function openOverview() {
    if (!state.issue) return;
    const issue = state.issue;
    const n = issue.pages.length;
    const groups = [[0]];
    for (let i = 1; i < n; i += 2) groups.push(i + 1 < n ? [i, i + 1] : [i]);
    const vis = visiblePages(state.current);
    el.ovGrid.textContent = '';
    let currentEl = null;
    for (const g of groups) {
      const sp = document.createElement('div');
      sp.className = 'ov-spread';
      if (g.some((i) => vis.includes(i))) { sp.classList.add('current'); currentEl = sp; }
      for (const i of g) {
        const p = document.createElement('div');
        p.className = 'ov-page';
        p.innerHTML = '<img alt="" loading="lazy"><span></span>';
        p.querySelector('img').src = imgUrl(issue, issue.pages[i], 'thumb');
        if (issue.pages[i].w / issue.pages[i].h > 1) p.classList.add('wide');
        p.querySelector('span').textContent = String(i + 1);
        p.dataset.index = String(i);
        sp.appendChild(p);
      }
      sp.addEventListener('click', (e) => {
        const p = e.target.closest('.ov-page');
        closeOverview();
        goToPage(Number((p || sp.firstChild).dataset.index));
      });
      el.ovGrid.appendChild(sp);
    }
    el.overview.hidden = false;
    if (currentEl) currentEl.scrollIntoView({ block: 'center' });
  }
  function closeOverview() { el.overview.hidden = true; }
  $('#btn-overview').addEventListener('click', openOverview);
  $('#btn-overview-close').addEventListener('click', closeOverview);

  // --- lupa
  // vstupy mění cíl (tgt), tick() k němu plynule dojíždí (cur)
  const R = {
    open: false, mode: 'page', pages: [0], slots: [], W: 1, H: 1,
    cur: { x: 0, y: 0, s: 1 }, tgt: { x: 0, y: 0, s: 1 }, anchor: null,
    tau: 70, raf: 0, last: 0, onSettle: null,
    momentum: false, vel: { x: 0, y: 0 }, samples: [],
    pointers: new Map(), drag: null, pinch: null, token: 0,
    closeAcc: 0, closeT: 0, mm: 1, mmDrag: false,
  };
  const MARGIN = 14;
  const BAR_H = 52;
  // rozměry plochy v cache, ať tick() nesahá do layoutu
  const measureStage = () => { R.vw = el.stage.clientWidth; R.vh = el.stage.clientHeight; };
  const stageW = () => R.vw || el.stage.clientWidth;
  const stageH = () => R.vh || el.stage.clientHeight;
  const topInset = () => BAR_H + MARGIN;
  const fitPage = () => Math.min((stageW() - 2 * MARGIN) / R.W, (stageH() - topInset() - MARGIN) / R.H);
  const fitWidth = () => (stageW() - 2 * MARGIN) / R.W;
  // čtecí velikost: stránka asi 2x větší než v knize, dvoustrana na šířku okna
  const readScale = () => (R.mode === 'spread' ? Math.max(fitPage(), fitWidth()) : Math.min(fitWidth(), Math.max(fitPage(), fitPage() * 2)));
  const minScale = () => fitPage();
  const maxScale = () => 3;

  function clampXY(s, x, y) {
    const vw = stageW();
    const vh = stageH();
    const sw = R.W * s;
    const sh = R.H * s;
    const top = topInset();
    x = sw <= vw - 2 * MARGIN ? (vw - sw) / 2 : clamp(x, vw - MARGIN - sw, MARGIN);
    y = sh <= vh - top - MARGIN ? top + (vh - top - MARGIN - sh) / 2 : clamp(y, vh - MARGIN - sh, top);
    return [x, y];
  }

  function paint() {
    const c = R.cur;
    el.sheet.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.s})`;
    el.rzoom.textContent = Math.round((c.s / fitPage()) * 100) + ' %';
    updateMinimap();
  }

  function tick(now) {
    const dt = Math.min(50, now - R.last || 16);
    R.last = now;
    const c = R.cur;
    const t = R.tgt;
    if (R.momentum) {
      t.x += R.vel.x * dt;
      t.y += R.vel.y * dt;
      const [cx, cy] = clampXY(t.s, t.x, t.y);
      if (cx !== t.x) R.vel.x = 0;
      if (cy !== t.y) R.vel.y = 0;
      t.x = cx;
      t.y = cy;
      const decay = Math.exp(-dt / 325);
      R.vel.x *= decay;
      R.vel.y *= decay;
      if (Math.hypot(R.vel.x, R.vel.y) < 0.015) R.momentum = false;
      if (Math.abs(c.s - t.s) < 1e-4) { c.x = t.x; c.y = t.y; }
    }
    const a = 1 - Math.exp(-dt / R.tau);
    c.s += (t.s - c.s) * a;
    if (R.anchor) {
      const A = R.anchor;
      const k = A.s1 === A.s0 ? 1 : clamp((c.s - A.s0) / (A.s1 - A.s0), 0, 1);
      c.x = A.cx - A.px * c.s + A.corrX * k;
      c.y = A.cy - A.py * c.s + A.corrY * k;
    } else if (!R.momentum) {
      c.x += (t.x - c.x) * a;
      c.y += (t.y - c.y) * a;
    }
    const settled = !R.momentum && Math.abs(t.s - c.s) < t.s * 2e-4 && Math.abs(t.x - c.x) < 0.3 && Math.abs(t.y - c.y) < 0.3;
    if (settled) {
      c.x = t.x; c.y = t.y; c.s = t.s;
      R.anchor = null;
    }
    paint();
    if (settled) {
      R.raf = 0;
      el.sheet.classList.remove('moving'); // přerastrovat ostře v konečné velikosti
      const cb = R.onSettle;
      R.onSettle = null;
      if (cb) cb();
    } else {
      R.raf = requestAnimationFrame(tick);
    }
  }
  function kick() {
    el.sheet.classList.add('moving');
    if (!R.raf) {
      R.last = performance.now();
      R.raf = requestAnimationFrame(tick);
    }
  }
  function stopMotion() {
    if (R.raf) cancelAnimationFrame(R.raf);
    R.raf = 0;
    R.momentum = false;
    R.anchor = null;
  }
  function setNow(x, y, s) {
    stopMotion();
    R.cur = { x, y, s };
    R.tgt = { x, y, s };
    paint();
  }

  function zoomTo(ns, cx, cy, tau) {
    ns = clamp(ns, minScale(), maxScale());
    const c = R.cur;
    const px = (cx - c.x) / c.s;
    const py = (cy - c.y) / c.s;
    const xa = cx - px * ns;
    const ya = cy - py * ns;
    const [x1, y1] = clampXY(ns, xa, ya);
    R.tgt = { s: ns, x: x1, y: y1 };
    R.anchor = { cx, cy, px, py, s0: c.s, s1: ns, corrX: x1 - xa, corrY: y1 - ya };
    R.momentum = false;
    R.tau = tau || 70;
    kick();
  }
  function panTo(x, y, tau) {
    R.anchor = null;
    R.momentum = false;
    const [cx, cy] = clampXY(R.tgt.s, x, y);
    R.tgt.x = cx;
    R.tgt.y = cy;
    R.tau = tau || 70;
    kick();
  }
  const panBy = (dx, dy, tau) => panTo(R.tgt.x + dx, R.tgt.y + dy, tau);
  function setMode(fit) {
    const s = fit === 'page' ? fitPage() : fit === 'width' ? fitWidth() : readScale();
    R.anchor = null;
    R.momentum = false;
    const [x, y] = clampXY(s, MARGIN, topInset());
    R.tgt = { s, x, y };
    R.tau = 80;
    kick();
  }

  function pagesFor(idx, mode) {
    return mode === 'spread' ? spreadOf(idx, state.issue.pages.length) : [idx];
  }

  function setupSheet() {
    const issue = state.issue;
    const ps = R.pages.map((i) => issue.pages[i]);
    const H = Math.max(...ps.map((p) => p.h));
    let x = 0;
    R.slots = ps.map((p, k) => {
      const w = Math.round((p.w * H) / p.h);
      const slot = { idx: R.pages[k], x, w };
      x += w;
      return slot;
    });
    R.W = x;
    R.H = H;
    el.sheet.style.width = R.W + 'px';
    el.sheet.style.height = R.H + 'px';
    el.sheet.textContent = '';
    const token = ++R.token;
    let pending = 0;
    const spinner = setTimeout(() => { if (token === R.token && pending) el.rloading.hidden = false; }, 450);
    R.slots.forEach((slot, k) => {
      const d = document.createElement('div');
      d.className = 'sheet-page' + (R.slots.length === 2 ? (k === 0 ? ' left' : ' right') : '');
      Object.assign(d.style, { left: slot.x + 'px', width: slot.w + 'px', height: H + 'px' });
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = imgUrl(issue, issue.pages[slot.idx], 'view'); // bývá už v cache
      d.appendChild(img);
      el.sheet.appendChild(d);
      if (R.query) markHits(d, issue.id, slot);
      const fullSrc = imgUrl(issue, issue.pages[slot.idx], 'full');
      const full = new Image();
      full.decoding = 'async';
      full.src = fullSrc;
      pending++;
      const ready = full.decode ? full.decode() : new Promise((res, rej) => { full.onload = res; full.onerror = rej; });
      ready
        .then(() => { if (token === R.token) img.src = fullSrc; })
        .catch(() => {})
        .finally(() => {
          pending--;
          if (token !== R.token || pending) return;
          clearTimeout(spinner);
          el.rloading.hidden = true;
          const nextIdx = R.pages[R.pages.length - 1] + 1;
          if (nextIdx < issue.pages.length) prefetch(imgUrl(issue, issue.pages[nextIdx], 'full'));
        });
    });
    // minimapa
    const boxW = R.slots.length === 2 ? 190 : 120;
    const m = Math.min(boxW / R.W, 160 / R.H);
    R.mm = m;
    el.mmSheet.style.width = R.W * m + 'px';
    el.mmSheet.style.height = R.H * m + 'px';
    el.mmSheet.textContent = '';
    R.slots.forEach((slot) => {
      const im = document.createElement('img');
      im.alt = '';
      im.src = imgUrl(issue, issue.pages[slot.idx], 'thumb');
      Object.assign(im.style, { left: slot.x * m + 'px', width: slot.w * m + 'px' });
      el.mmSheet.appendChild(im);
    });
    // hlavička
    const n = issue.pages.length;
    const a = R.pages[0] + 1;
    const b = R.pages[R.pages.length - 1] + 1;
    el.rpage.textContent = (a === b ? `str. ${a}` : `str. ${a}–${b}`) + ` / ${n}`;
    el.rprev.disabled = R.pages[0] <= 0;
    el.rnext.disabled = R.pages[R.pages.length - 1] >= n - 1;
    el.modeSeg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', btn.dataset.mode === R.mode));
    document.title = `${issue.title}, ${el.rpage.textContent.split(' / ')[0]} – ${APP}`;
    updateBookmarkBtn();
  }

  // poloha listu v lupě, která odpovídá stránce v knize
  function bookTransform() {
    if (!state.flip) return null;
    for (const slot of R.slots) {
      const pe = state.pageEls[slot.idx];
      const r = pe && pe.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0 && pe.style.display !== 'none') {
        const s = r.height / R.H;
        return { x: r.left - slot.x * s, y: r.top, s };
      }
    }
    return null;
  }

  function openReader(idx, mode, opts) {
    const issue = state.issue;
    const first = !R.open;
    R.open = true;
    R.mode = mode === 'spread' ? 'spread' : 'page';
    R.pages = pagesFor(idx, R.mode);
    el.reader.hidden = false;
    el.intro.classList.remove('show');
    measureStage();
    setupSheet();

    const from = first && opts && opts.fromBook ? bookTransform() : null;
    if (from && opts.zoom) {
      // gesto lupy: začít na místě knihy a přiblížit kolem kurzoru
      setNow(from.x, from.y, from.s);
      requestAnimationFrame(() => {
        el.reader.classList.add('open');
        zoomTo(from.s * Math.max(1.15, opts.zoom.factor), opts.zoom.cx, opts.zoom.cy, 90);
      });
    } else if (from) {
      // klik na stránku: stránka vyjede z knihy
      setNow(from.x, from.y, from.s);
      requestAnimationFrame(() => {
        el.reader.classList.add('open');
        setMode('read');
        R.tau = 85;
      });
    } else {
      const s = first ? readScale() : clamp(R.tgt.s, minScale(), maxScale());
      const [x, y] = clampXY(s, MARGIN, topInset());
      setNow(x, y, s);
      requestAnimationFrame(() => el.reader.classList.add('open'));
    }
    if (first) showHint();
  }

  // další/předchozí stránka v lupě, přiblížení zůstává
  function readerGo(dir, atBottom) {
    if (!R.open) return;
    const n = state.issue.pages.length;
    let idx;
    if (dir > 0) idx = R.pages[R.pages.length - 1] + 1;
    else idx = R.pages[0] - 1;
    if (idx < 0 || idx >= n) return;
    R.pages = pagesFor(idx, R.mode);
    const h = readerHash(state.issue.id, R.mode, R.pages[0]);
    history.replaceState(null, '', '#' + h);
    lastHash = h;
    saveProgress(state.issue.id, R.pages[0], R.pages[R.pages.length - 1]);
    const s = R.tgt.s;
    setupSheet();
    const sNew = clamp(s, minScale(), maxScale());
    const [x, y] = clampXY(sNew, MARGIN, atBottom ? -1e9 : topInset());
    setNow(x, y, sNew);
    el.sheet.classList.remove('swap');
    void el.sheet.offsetWidth;
    el.sheet.classList.add('swap');
  }

  // přepnutí stránka/dvoustrana, stránka zůstane na místě
  function switchMode(mode) {
    if (!R.open || mode === R.mode) return;
    const c = R.cur;
    let anchorIdx;
    if (R.mode === 'spread') {
      const centerX = (stageW() / 2 - c.x) / c.s;
      const slot = R.slots.find((sl) => centerX >= sl.x && centerX < sl.x + sl.w) || R.slots[0];
      anchorIdx = slot.idx;
    } else {
      anchorIdx = R.pages[0];
    }
    const oldSlot = R.slots.find((sl) => sl.idx === anchorIdx);
    const screenX = c.x + oldSlot.x * c.s;
    R.mode = mode;
    R.pages = pagesFor(anchorIdx, mode);
    const h = readerHash(state.issue.id, mode, R.pages[0]);
    history.replaceState(null, '', '#' + h);
    lastHash = h;
    setupSheet();
    const newSlot = R.slots.find((sl) => sl.idx === anchorIdx) || R.slots[0];
    setNow(screenX - newSlot.x * c.s, c.y, c.s);
    const s = clamp(c.s, minScale(), maxScale());
    const [x, y] = clampXY(s, screenX - newSlot.x * s, c.y);
    R.tgt = { s, x, y };
    R.tau = 80;
    kick();
  }

  function hideReaderNow() {
    stopMotion();
    R.onSettle = null;
    el.reader.hidden = true;
    el.reader.classList.remove('open');
    el.sheet.textContent = '';
    updateIntro();
  }

  function closeReader(animate) {
    if (!R.open) {
      if (!animate && !el.reader.hidden) hideReaderNow(); // ještě dobíhá zavírání
      return;
    }
    R.open = false;
    R.token++;
    R.query = '';
    const first = R.pages[0];
    if (state.flip && !visiblePages(state.current).includes(first)) state.flip.turnToPage(first);
    el.reader.classList.remove('open');
    el.rloading.hidden = true;
    el.minimap.classList.remove('show');
    const done = () => { if (!R.open) hideReaderNow(); };
    if (!animate || !state.flip) { done(); return; }
    setTimeout(done, 900); // v okně na pozadí animace nemusí doběhnout
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (R.open) return;
      const t = bookTransform();
      if (!t) { done(); return; }
      R.anchor = null;
      R.momentum = false;
      R.tgt = { x: t.x, y: t.y, s: t.s };
      R.tau = 75;
      R.onSettle = done;
      kick();
    }));
  }

  function showHint() {
    const seen = store.get('excal.hints', 0);
    if (seen >= 3) return;
    store.set('excal.hints', seen + 1);
    el.hint.hidden = false;
    el.hint.classList.remove('fade');
    setTimeout(() => el.hint.classList.add('fade'), 4500);
    setTimeout(() => { el.hint.hidden = true; }, 5200);
  }

  // minimapa
  function updateMinimap() {
    if (!R.open) return;
    const c = R.cur;
    const vw = stageW();
    const vh = stageH();
    const big = R.W * c.s > vw - 2 * MARGIN + 2 || R.H * c.s > vh - topInset() - MARGIN + 2;
    el.minimap.classList.toggle('show', big);
    if (!big) return;
    const m = R.mm;
    const x0 = clamp(-c.x / c.s, 0, R.W);
    const x1 = clamp((vw - c.x) / c.s, 0, R.W);
    const y0 = clamp((BAR_H - c.y) / c.s, 0, R.H);
    const y1 = clamp((vh - c.y) / c.s, 0, R.H);
    Object.assign(el.mmView.style, {
      left: 6 + x0 * m + 'px', top: 6 + y0 * m + 'px',
      width: Math.max(4, (x1 - x0) * m) + 'px', height: Math.max(4, (y1 - y0) * m) + 'px',
    });
  }
  function minimapGo(e, tau) {
    const r = el.mmSheet.getBoundingClientRect();
    const px = clamp((e.clientX - r.left) / R.mm, 0, R.W);
    const py = clamp((e.clientY - r.top) / R.mm, 0, R.H);
    const s = R.tgt.s;
    panTo(stageW() / 2 - px * s, (BAR_H + stageH()) / 2 - py * s, tau);
  }
  el.minimap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    try { el.minimap.setPointerCapture(e.pointerId); } catch (err) { /* ukazatel už neexistuje */ }
    R.mmDrag = true;
    minimapGo(e, 90);
  });
  el.minimap.addEventListener('pointermove', (e) => { if (R.mmDrag) minimapGo(e, 45); });
  const mmUp = () => { R.mmDrag = false; };
  el.minimap.addEventListener('pointerup', mmUp);
  el.minimap.addEventListener('pointercancel', mmUp);
  el.minimap.addEventListener('wheel', (e) => e.stopPropagation());

  // ovládání v lupě
  $('#reader-close').addEventListener('click', goUp);
  el.rprev.addEventListener('click', () => readerGo(-1));
  el.rnext.addEventListener('click', () => readerGo(1));
  const centerZoom = (f) => zoomTo(R.tgt.s * f, stageW() / 2, (BAR_H + stageH()) / 2, 80);
  $('#zoom-in').addEventListener('click', () => centerZoom(1.3));
  $('#zoom-out').addEventListener('click', () => centerZoom(1 / 1.3));
  $('#zoom-fitw').addEventListener('click', () => setMode('width'));
  $('#zoom-fitp').addEventListener('click', () => setMode('page'));
  el.rzoom.addEventListener('click', () => setMode('page'));
  el.modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) switchMode(b.dataset.mode);
  });

  // tažení se setrvačností, štípnutí dvěma prsty
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { el.stage.setPointerCapture(e.pointerId); } catch (err) { /* ukazatel už neexistuje */ }
    R.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopMotion();
    R.tgt = { ...R.cur };
    el.sheet.classList.add('moving');
    if (R.pointers.size === 1) {
      R.drag = { x: e.clientX, y: e.clientY, ox: R.cur.x, oy: R.cur.y, moved: false, onSheet: el.sheet.contains(e.target) };
      R.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    } else if (R.pointers.size === 2) {
      const [a, b] = [...R.pointers.values()];
      R.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: R.cur.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ox: R.cur.x, oy: R.cur.y };
      R.drag = null;
    }
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!R.pointers.has(e.pointerId)) return;
    R.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (R.pinch && R.pointers.size >= 2) {
      const [a, b] = [...R.pointers.values()];
      const raw = (R.pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / R.pinch.d;
      const ns = clamp(raw, minScale() * 0.85, maxScale());
      const k = ns / R.pinch.s;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      R.pinch.raw = raw;
      R.cur = { s: ns, x: mx - (R.pinch.mx - R.pinch.ox) * k, y: my - (R.pinch.my - R.pinch.oy) * k };
      R.tgt = { ...R.cur };
      paint();
    } else if (R.drag) {
      const dx = e.clientX - R.drag.x;
      const dy = e.clientY - R.drag.y;
      if (!R.drag.moved && Math.hypot(dx, dy) > 4) {
        R.drag.moved = true;
        el.stage.classList.add('dragging');
      }
      if (R.drag.moved) {
        const [x, y] = clampXY(R.cur.s, R.drag.ox + dx, R.drag.oy + dy);
        R.cur.x = R.tgt.x = x;
        R.cur.y = R.tgt.y = y;
        paint();
        const now = performance.now();
        R.samples.push({ x: e.clientX, y: e.clientY, t: now });
        while (R.samples.length > 2 && now - R.samples[0].t > 90) R.samples.shift();
      }
    }
  });
  function endPointer(e) {
    if (!R.pointers.has(e.pointerId)) return;
    R.pointers.delete(e.pointerId);
    if (R.pinch && R.pointers.size < 2) {
      const raw = R.pinch.raw || R.pinch.s;
      R.pinch = null;
      if (raw < minScale() * 0.8) { goUp(); return; } // sevření pod celou stránku zavře lupu
      const s = clamp(R.cur.s, minScale(), maxScale());
      const [x, y] = clampXY(s, R.cur.x, R.cur.y);
      R.tgt = { s, x, y };
      kick();
    }
    if (R.pointers.size === 1) {
      const [p] = [...R.pointers.values()];
      R.drag = { x: p.x, y: p.y, ox: R.cur.x, oy: R.cur.y, moved: true, onSheet: true };
      R.samples = [{ x: p.x, y: p.y, t: performance.now() }];
      return;
    }
    if (R.pointers.size === 0) {
      const d = R.drag;
      R.drag = null;
      el.stage.classList.remove('dragging');
      if (!d) return;
      if (e.type === 'pointerup' && !d.moved && !d.onSheet) { goUp(); return; } // klik vedle stránky zavře lupu
      if (d.moved && R.samples.length >= 2) {
        const a = R.samples[0];
        const b = R.samples[R.samples.length - 1];
        const dt = Math.max(1, b.t - a.t);
        const vx = (b.x - a.x) / dt;
        const vy = (b.y - a.y) / dt;
        if (performance.now() - b.t < 60 && Math.hypot(vx, vy) > 0.25) {
          R.vel = { x: vx, y: vy };
          R.momentum = true;
          kick();
          return;
        }
      }
      el.sheet.classList.remove('moving');
    }
  }
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);

  // dvojklik: plné rozlišení v místě kliknutí, nebo zpět
  el.stage.addEventListener('dblclick', (e) => {
    if (R.tgt.s < 0.92) zoomTo(1, e.clientX, e.clientY, 85);
    else setMode('read');
  });

  // kolečko posouvá, Ctrl + kolečko zoomuje, oddálení pod celou stránku lupu zavře
  el.stage.addEventListener('wheel', (e) => {
    if (e.ctrlKey && pageZoomed()) return;
    e.preventDefault();
    if (!R.open) return;
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? stageH() : 1;
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * unit * 0.006);
      if (f < 1 && R.tgt.s <= minScale() * 1.001) {
        R.closeAcc += -Math.log(f);
        clearTimeout(R.closeT);
        R.closeT = setTimeout(() => { R.closeAcc = 0; }, 350);
        if (R.closeAcc > 0.45) { R.closeAcc = 0; goUp(); }
        return;
      }
      R.closeAcc = 0;
      zoomTo(R.tgt.s * f, e.clientX, e.clientY, 60);
      return;
    }
    const mouseLike = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
    const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
    panBy(-dx * (mouseLike ? 1.4 : 1), -dy * (mouseLike ? 1.4 : 1), mouseLike ? 90 : 35);
  }, { passive: false });

  // mezerník: o obrazovku dál, na konci stránky další
  function pageStep(dir) {
    const vh = stageH();
    const step = (vh - topInset()) * 0.85;
    const s = R.tgt.s;
    const minY = vh - MARGIN - R.H * s;
    const maxY = topInset();
    const tall = R.H * s > vh - topInset() - MARGIN + 1;
    if (dir > 0 && (!tall || R.tgt.y <= minY + 1)) { readerGo(1, false); return; }
    if (dir < 0 && (!tall || R.tgt.y >= maxY - 1)) { readerGo(-1, true); return; }
    panBy(0, -dir * step, 90);
  }

  // --- klávesnice, celá obrazovka, resize
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  document.querySelectorAll('[data-action="fullscreen"]').forEach((b) => b.addEventListener('click', toggleFullscreen));

  // Ctrl + kolečko nesmí zoomovat celou stránku. Když už je přiblížená gestem prohlížeče,
  // gesto se pustí dál, ať jde vrátit.
  const pageZoomed = () => (window.visualViewport ? window.visualViewport.scale : 1) > 1.01;
  window.addEventListener('wheel', (e) => { if (e.ctrlKey && !pageZoomed()) e.preventDefault(); }, { passive: false });
  function checkPageZoom() { el.zoomNote.hidden = !pageZoomed(); }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', checkPageZoom);
  checkPageZoom();

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // "Stiskni libovolnou klávesu" pod hotovým převodem opravdu platí
    if (lib.finished && !el.libProgress.hidden && !offerShortcut() && !/^(Shift|Tab|CapsLock)$/.test(e.key)) {
      lib.finished = null;
      setNote('');
    }
    const tag = e.target && e.target.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';
    if (inField && e.key !== 'Escape') return;
    const key = e.key;
    if ((key === 'f' || key === 'F') && !inField) { toggleFullscreen(); e.preventDefault(); return; }
    if (!manifest) return;
    const view = parseHash().view;
    if (!el.help.hidden) {
      if (key === 'Escape' || key === 'Enter' || key === ' ') { showHelp(false); e.preventDefault(); }
      return;
    }
    if (key === '?') { showHelp(true); e.preventDefault(); return; }
    if ((key === 'b' || key === 'B') && (R.open || view === 'book') && state.issue) { toggleBookmark(); e.preventDefault(); return; }

    if (R.open) {
      const vh = stageH();
      const cz = (f) => centerZoom(f);
      const map = {
        ArrowLeft: () => readerGo(-1),
        ArrowRight: () => readerGo(1),
        ArrowUp: () => panBy(0, 160, 90),
        ArrowDown: () => panBy(0, -160, 90),
        PageUp: () => pageStep(-1),
        PageDown: () => pageStep(1),
        ' ': () => pageStep(e.shiftKey ? -1 : 1),
        Home: () => panBy(0, 1e6, 100),
        End: () => panBy(0, -1e6, 100),
        '+': () => cz(1.3),
        '=': () => cz(1.3),
        '-': () => cz(1 / 1.3),
        '0': () => setMode('page'),
        '1': () => zoomTo(1, stageW() / 2, (BAR_H + vh) / 2, 85),
        w: () => setMode('width'),
        W: () => setMode('width'),
        d: () => switchMode(R.mode === 'page' ? 'spread' : 'page'),
        D: () => switchMode(R.mode === 'page' ? 'spread' : 'page'),
        Escape: goUp,
        Backspace: goUp,
      };
      if (map[key]) { map[key](); e.preventDefault(); }
      return;
    }

    if (!el.overview.hidden) {
      if (key === 'Escape' || key === 'g' || key === 'G') { closeOverview(); e.preventDefault(); }
      return;
    }

    if (view === 'book' && state.flip) {
      if (key === 'Escape' && !el.settingsPop.hidden) { closePopover(); e.preventDefault(); return; }
      const vis = visiblePages(state.current);
      const map = {
        ArrowLeft: () => step(-1, e.repeat),
        ArrowRight: () => step(1, e.repeat),
        PageUp: () => step(-1, e.repeat),
        PageDown: () => step(1, e.repeat),
        ' ': () => step(e.shiftKey ? -1 : 1, e.repeat),
        Home: () => goToPage(0),
        End: () => goToPage(state.issue.pages.length - 1),
        Enter: () => {
          if (state.current === 0) { flipNext(); return; }
          pendingOpen = { fromBook: true };
          location.hash = readerHash(state.issue.id, 'page', vis[0]);
        },
        z: zoomBookButton,
        Z: zoomBookButton,
        '+': zoomBookButton,
        '=': zoomBookButton,
        g: openOverview,
        G: openOverview,
        Escape: goUp,
        Backspace: goUp,
      };
      if (map[key]) { map[key](); e.preventDefault(); }
      return;
    }

    if (view === 'shelf') {
      if (inField) return;
      const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (dirs[key]) { moveShelfFocus(dirs[key]); e.preventDefault(); return; }
      if (key === '/') { el.search.focus(); el.search.select(); e.preventDefault(); return; }
      if (/^[0-9a-zA-ZáčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ+]$/.test(key)) { el.search.focus(); return; } // psaní rovnou hledá
      if (key === 'Escape' && (shelf.query || settings.filter !== 'all')) {
        el.search.value = '';
        shelf.query = '';
        settings.filter = 'all';
        saveSettings();
        scheduleTextSearch();
        refreshShelf();
      }
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (R.open) {
      measureStage();
      const [x, y] = clampXY(R.tgt.s, R.tgt.x, R.tgt.y);
      R.tgt.x = x; R.tgt.y = y;
      kick();
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { relayout(); updateChipSpy(); updateIntro(); placeBookends(); }, 150);
  });

  // --- záložky, hledání v textu, nápověda

  const bmIndex = (id, page) => bookmarks.items.findIndex((b) => b.id === id && b.page === page);

  function toast(text, ms = 2200) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    el.toast.classList.remove('fade');
    clearTimeout(toast.t1);
    clearTimeout(toast.t2);
    toast.t1 = setTimeout(() => el.toast.classList.add('fade'), ms);
    toast.t2 = setTimeout(() => { el.toast.hidden = true; }, ms + 500);
  }

  // stránka, ke které se záložka vztahuje: v lupě ta uprostřed obrazovky, v listování levá
  function bookmarkPage() {
    if (!state.issue) return null;
    if (R.open && R.slots && R.slots.length) {
      if (R.slots.length === 1) return R.slots[0].idx;
      const cx = (stageW() / 2 - R.cur.x) / R.cur.s;
      const s = R.slots.find((sl) => cx >= sl.x && cx < sl.x + sl.w);
      return (s || R.slots[0]).idx;
    }
    const vis = visiblePages(state.current);
    return vis[vis.length > 1 && vis[0] === 0 ? 1 : 0];
  }

  function updateBookmarkBtn() {
    const issue = state.issue;
    const pages = !issue ? [] : R.open && R.pages ? R.pages : visiblePages(state.current);
    const on = !!issue && pages.some((p) => bmIndex(issue.id, p) >= 0);
    [el.bmBtn, el.bmBtnBook].forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? 'Odebrat záložku (B)' : 'Založit tuhle stránku (B)';
    });
  }

  function toggleBookmark() {
    const issue = state.issue;
    if (!issue) return;
    const pages = R.open && R.pages ? R.pages : visiblePages(state.current);
    const marked = pages.filter((p) => bmIndex(issue.id, p) >= 0);
    if (marked.length) {
      bookmarks.items = bookmarks.items.filter((b) => !(b.id === issue.id && marked.includes(b.page)));
      toast('Záložka odebrána');
    } else {
      const page = bookmarkPage();
      bookmarks.items.push({ id: issue.id, page, t: Date.now() });
      toast(`Záložka na str. ${page + 1}. Najdeš ji na poličce v Záložkách.`);
    }
    bookmarks.t = Date.now();
    store.set('excal.bookmarks', bookmarks);
    sync.queue({ bookmarks });
    updateBookmarkBtn();
    refreshShelf();
  }

  const bookmarkItems = () => (manifest ? bookmarks.items.filter((b) => byId.has(b.id) && byId.get(b.id).pages[b.page]).sort((a, b) => b.t - a.t) : []);

  // záložky se ukážou místo obálek po volbě Záložky vedle Vše / Rozečtené
  function renderBookmarks() {
    const box = el.bookmarksEl;
    const items = bookmarkItems();
    box.hidden = settings.filter !== 'bookmarks' || !items.length;
    if (box.hidden) return;
    box.innerHTML = '<header class="year-head"><h2 class="year-title">Záložky</h2><span class="year-count"></span><span class="year-line"></span></header><div class="bm-row"></div>';
    box.querySelector('.year-count').textContent = `${items.length} ${plural(items.length, 'stránka', 'stránky', 'stránek')}`;
    const row = box.querySelector('.bm-row');
    for (const b of items) {
      const is = byId.get(b.id);
      const card = document.createElement('div');
      card.className = 'bm';
      card.tabIndex = 0;
      card.setAttribute('role', 'link');
      card.innerHTML = '<span class="bm-img"><img alt="" loading="lazy" decoding="async"></span><span class="bm-info"><b></b><span></span></span>' +
        '<button class="bm-del" type="button" title="Odebrat záložku" aria-label="Odebrat záložku"><svg><use href="#i-close"/></svg></button>';
      card.querySelector('img').src = imgUrl(is, is.pages[b.page], 'thumb');
      card.querySelector('b').textContent = is.title;
      card.querySelector('.bm-info span').textContent = `str. ${b.page + 1}`;
      const open = () => { location.hash = readerHash(is.id, 'page', b.page); };
      card.addEventListener('click', (e) => {
        if (e.target.closest('.bm-del')) {
          bookmarks.items = bookmarks.items.filter((x) => x !== b);
          bookmarks.t = Date.now();
          store.set('excal.bookmarks', bookmarks);
          sync.queue({ bookmarks });
          refreshShelf();
          return;
        }
        open();
      });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      row.appendChild(card);
    }
  }

  // hledání v textu časopisů (api/search), výsledky nad poličkou
  const textHits = { timer: 0, token: 0, count: 0 };

  function scheduleTextSearch() {
    clearTimeout(textHits.timer);
    const q = el.search.value.trim();
    renderBookmarks();
    if (q.length < 3 || /^\d+\+?$/.test(q) || !lib.status) { renderTextHits(null); return; }
    textHits.timer = setTimeout(() => runTextSearch(q), 350);
  }

  function runTextSearch(q) {
    const token = ++textHits.token;
    renderTextHits({ loading: true });
    fetch('api/search?q=' + encodeURIComponent(q))
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => { if (token === textHits.token) renderTextHits(res && res.hits ? Object.assign(res, { q }) : null); })
      .catch(() => { if (token === textHits.token) renderTextHits(null); });
  }

  function snippet(box, h) {
    let pos = 0;
    if (h.cut[0]) box.append('…');
    for (const [a, b] of h.marks) {
      if (a < pos) continue;
      box.append(h.text.slice(pos, a));
      const m = document.createElement('mark');
      m.textContent = h.text.slice(a, b);
      box.append(m);
      pos = b;
    }
    box.append(h.text.slice(pos));
    if (h.cut[1]) box.append('…');
  }

  function renderTextHits(data) {
    const box = el.textHitsEl;
    textHits.count = data && data.hits ? data.hits.length : 0;
    if (!data) { box.hidden = true; box.textContent = ''; applyFilter(); return; }
    box.hidden = false;
    const head = '<header class="year-head"><h2 class="year-title">V textu časopisů</h2><span class="year-count"></span><span class="year-line"></span></header>';
    if (data.loading) {
      if (!box.querySelector('.th-list')) { box.innerHTML = head; box.querySelector('.year-count').textContent = 'hledám…'; }
      return;
    }
    box.innerHTML = head + '<div class="th-list"></div>';
    const groups = new Map();
    for (const h of data.hits) {
      if (!byId.has(h.id)) continue;
      if (!groups.has(h.id)) groups.set(h.id, []);
      groups.get(h.id).push(h);
    }
    const n = data.hits.length;
    box.querySelector('.year-count').textContent = n
      ? `${n}${data.more ? '+' : ''} ${plural(n, 'strana', 'strany', 'stran')} · ${groups.size} ${plural(groups.size, 'číslo', 'čísla', 'čísel')}`
      : '';
    const list = box.querySelector('.th-list');
    if (!n) {
      const p = document.createElement('p');
      p.className = 'th-empty';
      p.textContent = data.searchable
        ? `„${data.q}“ jsem v textu nenašel. Hledám v ${data.searchable} ${plural(data.searchable, 'čísle', 'číslech', 'číslech')}, které mají ve skenech text.`
        : 'Tyhle skeny nemají textovou vrstvu, hledat jde jen číslo, rok a měsíc.';
      list.appendChild(p);
    }
    for (const [id, hits] of groups) {
      const is = byId.get(id);
      const g = document.createElement('div');
      g.className = `th-issue mag-c${magIndex(is.magazine)}`;
      g.innerHTML = '<div class="th-head"><img alt="" loading="lazy"><div><b></b><span></span></div></div><div class="th-rows"></div>';
      g.querySelector('img').src = coverUrl(is);
      g.querySelector('.th-head b').textContent = is.title;
      g.querySelector('.th-head span').textContent = [is.date, `${hits.length} ${plural(hits.length, 'strana', 'strany', 'stran')}`].filter(Boolean).join(' · ');
      const rows = g.querySelector('.th-rows');
      hits.forEach((h, k) => {
        const a = document.createElement('a');
        a.className = 'th-hit';
        a.href = '#' + readerHash(id, 'page', h.page);
        a.hidden = k >= 3;
        a.innerHTML = '<img alt="" loading="lazy"><span class="th-page"></span><span class="th-snip"></span>';
        a.querySelector('img').src = imgUrl(is, is.pages[h.page], 'thumb');
        a.querySelector('.th-page').textContent = `str. ${h.page + 1}`;
        snippet(a.querySelector('.th-snip'), h);
        a.addEventListener('click', (e) => {
          e.preventDefault();
          R.query = data.q;
          R.focusHit = true;
          pendingOpen = null;
          location.hash = readerHash(id, 'page', h.page);
        });
        rows.appendChild(a);
      });
      if (hits.length > 3) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'th-more';
        const rest = hits.length - 3;
        more.textContent = `a ${rest} ${plural(rest, 'další strana', 'další strany', 'dalších stran')}`;
        more.addEventListener('click', () => { rows.querySelectorAll('.th-hit[hidden]').forEach((x) => { x.hidden = false; }); more.remove(); });
        g.appendChild(more);
      }
      list.appendChild(g);
    }
    applyFilter();
  }

  // nalezená slova na stránce v lupě
  function markHits(pageBox, id, slot) {
    const token = R.token;
    fetch(`api/hits?id=${encodeURIComponent(id)}&page=${slot.idx}&q=${encodeURIComponent(R.query)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rects) => {
        if (token !== R.token || !Array.isArray(rects)) return;
        for (const [x, y, w, h] of rects) {
          const m = document.createElement('i');
          m.className = 'hit';
          Object.assign(m.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
          pageBox.appendChild(m);
        }
        // po otevření z hledání lupa sama najede na první nález
        if (R.focusHit && rects.length) {
          R.focusHit = false;
          setTimeout(() => { if (token === R.token && R.open) focusHit(slot, rects[0]); }, 500);
        }
      })
      .catch(() => {});
  }

  function focusHit(slot, [x, y, w, h]) {
    const s = Math.max(R.tgt.s, Math.min(readScale() * 1.2, maxScale()));
    const px = slot.x + (x + w / 2) * slot.w;
    const py = (y + h / 2) * R.H;
    const top = topInset();
    const [tx, ty] = clampXY(s, stageW() / 2 - px * s, top + (stageH() - top) / 2 - py * s);
    R.anchor = null;
    R.momentum = false;
    R.tgt = { s, x: tx, y: ty };
    R.tau = 110;
    kick();
  }

  // nápověda při prvním otevření časopisu (pak klávesa ? nebo odkaz v nastavení)
  function showHelp(on) {
    el.help.hidden = !on;
    if (!on) return;
    store.set('excal.help', true);
    el.help.classList.toggle('is-touch', matchMedia('(pointer: coarse)').matches);
    const btn = el.help.querySelector('[data-help-close]');
    if (btn) btn.focus();
  }
  el.help.addEventListener('click', (e) => { if (e.target === el.help || e.target.closest('[data-help-close]')) showHelp(false); });
  document.querySelectorAll('[data-help-open]').forEach((b) => b.addEventListener('click', () => { closePopover(); showHelp(true); }));
  el.bmBtn.addEventListener('click', toggleBookmark);
  el.bmBtnBook.addEventListener('click', toggleBookmark);

  // --- složky s časopisy a převod na pozadí (api/ v server.py)
  const lib = { status: null, running: false, done: -1, note: '', error: false, timer: 0, picked: false, finished: null };
  const getStatus = () => fetch('api/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const loadManifest = () => fetch('data/manifest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  function useManifest(m, animate) {
    const first = !manifest;
    const known = new Set(byId.keys());
    // známá čísla zůstanou stejné objekty, otevřený časopis se nepřestaví
    m.issues = m.issues.map((is) => (byId.has(is.id) ? Object.assign(byId.get(is.id), is) : is));
    manifest = m;
    enrich(manifest.issues);
    showWelcome(false);
    const top = el.shelf.scrollTop;
    buildShelf();
    if (first) route();
    else el.shelf.scrollTop = top;
    if (animate) dropIn(manifest.issues.filter((is) => !known.has(is.id)));
  }

  // nově převedená čísla doskočí na poličku, víc najednou jedno po druhém
  function dropIn(list) {
    list.forEach((is, i) => {
      const cell = shelf.cells.get(is.id);
      if (!cell) return;
      cell.style.setProperty('--delay', `${Math.min(i, 14) * 0.08}s`);
      cell.classList.add('arrive-wait');
      const img = cell.querySelector('img');
      // skočí až s načteným obrázkem, ne jako prázdný papír
      (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
        cell.classList.remove('arrive-wait');
        cell.classList.add('arrive');
      });
      const cover = cell.querySelector('.issue-cover');
      const done = (e) => {
        if (e.target !== cover) return;
        cell.classList.remove('arrive');
        cell.removeEventListener('animationend', done);
      };
      cell.addEventListener('animationend', done);
    });
  }

  function reloadManifest() {
    return loadManifest().then((m) => {
      if (m && m.issues && m.issues.length && (!manifest || m.generated !== manifest.generated)) useManifest(m, true);
    });
  }

  // prázdná polička: velké tlačítko pro výběr složky
  const FROM_FILE = location.protocol === 'file:';
  function showWelcome(on) {
    el.shelf.classList.toggle('is-welcome', on);
    el.welcome.hidden = !on || lib.running; // při převodu stačí panel průběhu
    if (!on) return;
    showView('shelf');
    document.title = APP;
    const st = lib.status;
    let html;
    if (FROM_FILE) {
      html = `<h2>Čtečku je potřeba spustit</h2>
        <p>Tahle stránka se otevřela přímo ze souboru, a tak nevidí tvoje časopisy. Zavři ji a ve složce s čtečkou dvakrát klikni na <b>Spustit čtečku</b>. Otevře se sama.</p>
        <p class="welcome-note">Kdyby čtečka už běžela, přepnu tě do ní sám.</p>`;
    } else if (st && st.can_pick) {
      html = `<h2>Polička je zatím prázdná</h2>
        <p>Vyber složku, kde máš stažené časopisy. Čtečka si je projde, připraví k listování a postaví je sem na poličku.</p>
        <button class="btn btn-accent btn-big" type="button" data-pick="folder"><svg><use href="#i-folder"/></svg>Vybrat složku s časopisy</button>
        <button class="link-btn" type="button" data-pick="files">nebo vyber jednotlivé stažené soubory</button>
        <p class="welcome-note">Stačí PDF, CBZ nebo ZIP, rozbalovat je nemusíš. Můžeš vybrat složku s jedním časopisem, nebo složku, kde má každý časopis svou podsložku. Původní soubory zůstanou, jak jsou.</p>`;
    } else if (st) {
      html = '<h2>Polička je zatím prázdná</h2><p>Složku s časopisy vyber na počítači, kde čtečka běží.</p>';
    } else {
      html = '<h2>Polička je zatím prázdná</h2><p>Převeď časopisy příkazem <code>python convert.py</code> a stránku obnov.</p>';
    }
    el.welcome.innerHTML = `<div class="welcome-card">${html}</div>`;
  }

  // panel průběhu: obálka čísla, které se právě převádí, regál hřbetů a odhad času
  const SPINES = 40;
  const fmtLeft = (s) => (s < 50 ? 'zbývá méně než minuta' : s < 3600 ? `zbývá asi ${Math.round(s / 60)} min`
    : `zbývá asi ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

  function panel() {
    let box = el.libProgress.querySelector('.conv');
    if (box) return box;
    el.libProgress.innerHTML = `<div class="conv">
        <div class="conv-title"></div>
        <div class="conv-crt"><div class="conv-cover"><img alt=""><span class="conv-scan"></span></div><i class="conv-led"></i></div>
        <div class="conv-body">
          <div class="conv-head"><b></b><span class="conv-pct"></span></div>
          <div class="conv-now"></div>
          <div class="conv-bar"><i></i></div>
          <div class="conv-meta"></div>
          <div class="conv-shelf"></div>
          <div class="conv-actions"></div>
        </div>
      </div>`;
    box = el.libProgress.querySelector('.conv');
    const img = box.querySelector('img');
    img.addEventListener('load', () => img.classList.add('ok'));
    return box;
  }

  function setSpines(box, total, done, current) {
    const shelfEl = box.querySelector('.conv-shelf');
    const n = Math.max(1, Math.min(total, SPINES));
    if (shelfEl.children.length !== n) {
      shelfEl.textContent = '';
      for (let i = 0; i < n; i++) {
        const s = document.createElement('i');
        s.style.height = `${58 + ((i * 37) % 11) * 4}%`; // hřbety různě vysoké jako na poličce
        shelfEl.appendChild(s);
      }
    }
    [...shelfEl.children].forEach((s, i) => {
      const from = Math.floor((i * total) / n);
      const to = Math.floor(((i + 1) * total) / n);
      s.classList.toggle('done', to <= done);
      s.classList.toggle('now', current && from <= done && done < to);
    });
  }

  function updatePanel(st, finished) {
    const box = panel();
    box.classList.toggle('is-done', !!finished);
    const total = st.total || 0;
    const frac = finished ? 1 : total ? Math.min(1, (st.done + (st.pages ? st.page / st.pages : 0)) / total) : 0;
    const added = total - (st.failed || []).length;
    box.querySelector('.conv-title').textContent = finished ? 'Hotovo' : `${APP} · příprava časopisů`;
    box.querySelector('.conv-head b').textContent = finished
      ? (added > 0 ? `Na poličce ${plural(added, 'přibylo', 'přibyla', 'přibylo')} ${added} ${plural(added, 'číslo', 'čísla', 'čísel')}` : 'Nic nového jsem nenašel')
      : st.current ? `Převádím ${st.current}` : total ? 'Připravuju časopisy' : 'Prohlížím složku s časopisy';
    box.querySelector('.conv-pct').textContent = total && !finished ? `${Math.floor(frac * 100)} %` : '';
    box.querySelector('.conv-bar i').style.width = `${Math.round(frac * 100)}%`;
    const img = box.querySelector('img');
    if (st.cover && img.dataset.src !== st.cover) {
      const pre = new Image(); // obálka se vymění, až je načtená
      pre.onload = () => { img.dataset.src = st.cover; img.src = st.cover; };
      pre.src = st.cover;
    }
    box.querySelector('.conv-now').textContent = finished ? ''
      : st.current ? (st.pages ? `strana ${st.page} z ${st.pages}` : '') : total ? '' : 'Hledám PDF, CBZ a ZIP…';
    box.querySelector('.conv-bar').hidden = !total;
    setSpines(box, total || 1, finished ? total : st.done || 0, !finished && total);
    const meta = [];
    if (finished) {
      meta.push('Příště najdu nová čísla sám.');
    } else if (total) {
      meta.push(`${st.done} z ${total} ${total === 1 ? 'čísla' : 'čísel'}`);
      const elapsed = (st.t || 0) - (st.started || 0);
      if (frac > 0.02 && elapsed > 6) meta.push(fmtLeft((elapsed * (1 - frac)) / frac));
      if (manifest) meta.push('hotová čísla už můžeš číst');
    }
    box.querySelector('.conv-meta').textContent = meta.join(' · ');
    const actions = box.querySelector('.conv-actions');
    actions.innerHTML = finished
      ? (offerShortcut() ? `<button class="btn btn-accent" type="button" data-shortcut><svg><use href="#i-desktop"/></svg>Přidat zástupce na plochu</button>
          <span class="conv-hint">Příště čtečku spustíš rovnou z plochy.</span>` : '<span class="conv-press">Stiskni libovolnou klávesu</span>') +
        '<button class="icon-btn conv-close" type="button" data-close aria-label="Zavřít"><svg><use href="#i-close"/></svg></button>'
      : '';
  }

  const offerShortcut = () => lib.status && lib.status.can_shortcut && !lib.status.shortcut && !store.get('excal.shortcut', false);

  function renderProgress() {
    const st = lib.status || {};
    const box = el.libProgress;
    const busy = lib.running && st.state === 'running' && st.total;
    const scanning = lib.running && !busy && (lib.picked || !manifest);
    box.classList.toggle('is-note', !busy && !scanning && !lib.finished && !!lib.note);
    if (busy) updatePanel(st, false);
    else if (scanning) updatePanel({}, false);
    else if (lib.finished) updatePanel(lib.finished, true);
    else if (lib.note) {
      box.innerHTML = `<div class="lib-text${lib.error ? ' is-error' : ''}"><span>${esc(lib.note)}</span></div>` +
        '<button class="icon-btn" type="button" data-close aria-label="Zavřít"><svg><use href="#i-close"/></svg></button>';
    }
    box.hidden = !(busy || scanning || lib.finished || lib.note);
  }

  function setNote(text, error) {
    lib.note = text || '';
    lib.error = !!error;
    if (lib.note) lib.finished = null;
    renderProgress();
  }

  function pollLibrary() {
    clearTimeout(lib.timer);
    getStatus().then((st) => {
      if (!st) return;
      lib.status = st;
      el.libBtn.hidden = el.phoneBtn.hidden = !st.can_pick;
      const was = lib.running;
      lib.running = st.running;
      if (st.running) {
        lib.note = '';
        if (st.done !== lib.done) { lib.done = st.done; reloadManifest(); }
        lib.timer = setTimeout(pollLibrary, 1000);
      } else if (was) {
        lib.done = -1;
        const failed = st.failed || [];
        if (failed.length) {
          setNote(`Nepodařilo se otevřít ${failed.length} ${plural(failed.length, 'soubor', 'soubory', 'souborů')}: ${failed.join(', ')}`, true);
        } else if (st.total || lib.picked) {
          lib.finished = st;
          if (!offerShortcut()) setTimeout(() => { if (lib.finished === st) { lib.finished = null; renderProgress(); } }, 6000);
        }
        lib.picked = false;
        reloadManifest();
      }
      if (!manifest && was !== lib.running) showWelcome(true);
      renderProgress();
    });
  }

  function pickLibrary(mode) {
    const btns = [el.libBtn, ...el.welcome.querySelectorAll('[data-pick]')];
    btns.forEach((b) => { b.disabled = true; });
    el.libPop.hidden = true;
    setNote(mode === 'files'
      ? 'Vyber soubory v okně, které se právě otevřelo (víc najednou s klávesou Ctrl). Kdyby nebylo vidět, je schované za prohlížečem.'
      : 'Vyber složku v okně, které se právě otevřelo. Kdyby nebylo vidět, je schované za prohlížečem.');
    fetch('api/library', { method: 'POST', headers: { 'X-Reader': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) {
          lib.note = '';
          lib.finished = null;
          lib.picked = true;
          lib.running = true;
          if (!manifest) showWelcome(true);
          renderProgress();
          pollLibrary();
        } else if (res.cancelled) setNote('');
        else setNote(res.error, true);
      })
      .catch(() => setNote('Čtečka neodpovídá. Běží ještě její okno?', true))
      .finally(() => btns.forEach((b) => { b.disabled = false; }));
  }

  function addShortcut(btn) {
    btn.disabled = true;
    fetch('api/shortcut', { method: 'POST', headers: { 'X-Reader': '1' } })
      .then((r) => r.json())
      .then((res) => {
        store.set('excal.shortcut', true);
        lib.finished = null;
        setNote(res.ok ? 'Hotovo, zástupce čtečky je na ploše.' : 'Zástupce na ploše se nepodařilo vytvořit.', !res.ok);
        if (res.ok) setTimeout(() => setNote(''), 5000);
      })
      .catch(() => setNote('Čtečka neodpovídá. Běží ještě její okno?', true));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { sync.flush(); return; }
    if (sync.ok) getReader().then((st) => { if (mergeReader(st) && manifest) { refreshShelf(); updateBookmarkBtn(); } });
  });
  window.addEventListener('pagehide', () => sync.flush());

  el.libBtn.addEventListener('click', () => { el.themePop.hidden = el.phonePop.hidden = true; el.libPop.hidden = !el.libPop.hidden; });

  // čtení v telefonu: zapne čtečku v domácí síti a ukáže adresu jako QR kód
  function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    return `<svg viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  el.phoneBtn.addEventListener('click', () => {
    el.themePop.hidden = el.libPop.hidden = true;
    el.phonePop.hidden = !el.phonePop.hidden;
    if (el.phonePop.hidden) return;
    const box = document.getElementById('phone-qr');
    const url = document.getElementById('phone-url');
    box.innerHTML = '';
    url.textContent = 'Zapínám čtečku v domácí síti…';
    fetch('api/lan', { method: 'POST', headers: { 'X-Reader': '1', 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) { url.textContent = res.error || 'Síť se nepodařilo zapnout.'; return; }
        box.innerHTML = qrSvg(res.url);
        url.textContent = res.url;
      })
      .catch(() => { url.textContent = 'Čtečka neodpovídá. Běží ještě její okno?'; });
  });
  el.libPop.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) pickLibrary(b.dataset.pick); });
  el.welcome.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) pickLibrary(b.dataset.pick); });
  el.libProgress.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-shortcut]');
    if (sc) return addShortcut(sc);
    if (e.target.closest('[data-close]')) {
      if (lib.finished && offerShortcut()) store.set('excal.shortcut', true); // nabídka plochy jen jednou
      lib.finished = null;
      setNote('');
    }
  });

  // --- offline: čtečka a vybraná čísla uložená v telefonu (sw.js), čte se z nich i bez sítě
  const PC = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && !store.get('excal.swtest', false);
  const offline = {
    phone: !PC && !FROM_FILE, // na počítači s čtečkou to nedává smysl
    can: false, // prohlížeč smí ukládat (zabezpečená adresa)
    away: false, // čtečka na počítači neodpovídá, čte se z telefonu
    saved: new Set(), queue: [], busy: null, sizes: new Map(),
  };
  offline.can = offline.phone && 'serviceWorker' in navigator && 'caches' in window && window.isSecureContext;
  const okUrl = (id) => `data/issues/${encodeURIComponent(id)}/.saved`;
  const standalone = () => matchMedia('(display-mode: standalone)').matches;
  let installEvt = null;
  const installBar = $('#install-bar');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; renderTrip(); renderInstall(); });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    store.set('excal.noinstall', true);
    renderInstall();
    renderTrip();
    toast('Hotovo, Časopisárna je na ploše. Čísla na cestu si ulož tlačítkem Uložit do telefonu u čísla.', 5000);
  });

  // pruh na poličce: nainstalovat, a když to Chrome ještě nedovolí, poradit proč
  function renderInstall() {
    installBar.hidden = !offline.phone || offline.away || standalone() || store.get('excal.noinstall', false);
  }
  $('#btn-install').addEventListener('click', async (e) => {
    if (!offline.can) return showSaveHelp(true);
    if (!installEvt) { // prohlížeč nabídku instalace pošle až chvíli po načtení
      e.currentTarget.disabled = true;
      for (let i = 0; i < 30 && !installEvt; i++) await new Promise((r) => setTimeout(r, 100));
      $('#btn-install').disabled = false;
    }
    if (installEvt) return install();
    toast('V menu prohlížeče ⋮ klepni na Přidat na plochu a pak na Instalovat.', 6000);
  });
  $('#btn-install-x').addEventListener('click', () => { store.set('excal.noinstall', true); renderInstall(); });

  async function loadSaved() {
    for (const k of await caches.keys()) {
      if (!k.startsWith('issue:')) continue;
      const id = k.slice(6);
      if (await (await caches.open(k)).match(okUrl(id))) offline.saved.add(id);
      else await caches.delete(k); // nedokončené uložení
    }
  }

  function tripHtml(issue) {
    if (!offline.phone) {
      const n = issue.pages.length;
      return `<a class="btn trip-btn" href="api/cbz?id=${encodeURIComponent(issue.id)}" download data-trip
        title="Stáhne číslo jako soubor CBZ, který přečteš v telefonu i bez internetu"><svg><use href="#i-download"/></svg>Na cestu<small>asi ${Math.max(1, Math.round(n * 0.42))} MB</small></a>`;
    }
    if (offline.saved.has(issue.id)) {
      return `<span class="trip-saved"><svg><use href="#i-check"/></svg>V telefonu</span>` +
        (installEvt && !standalone() ? '<button class="btn trip-btn" type="button" data-install><svg><use href="#i-phone"/></svg>Přidat na plochu</button>' : '') +
        '<button class="link-btn trip-del" type="button" data-unsave>smazat z telefonu</button>';
    }
    const b = offline.busy;
    if (b && b.id === issue.id) {
      return `<button class="btn trip-btn" type="button" disabled>Ukládám<small>${b.total ? Math.floor((b.done / b.total) * 100) : 0} %</small></button>`;
    }
    if (offline.queue.includes(issue.id)) return '<button class="btn trip-btn" type="button" disabled>Čeká na uložení</button>';
    if (offline.away) return '';
    const mb = offline.sizes.get(issue.id);
    if (mb == null && offline.can) fetchSize(issue);
    return `<button class="btn trip-btn" type="button" data-save title="Uloží číslo do telefonu, přečteš ho i bez internetu">` +
      `<svg><use href="#i-download"/></svg>Uložit do telefonu${mb ? `<small>${mb} MB</small>` : ''}</button>`;
  }
  function renderTrip() {
    const box = state.issue && el.intro.querySelector('.trip');
    if (box) box.innerHTML = tripHtml(state.issue);
  }
  function fetchSize(issue) {
    offline.sizes.set(issue.id, 0);
    fetch('api/size?id=' + encodeURIComponent(issue.id)).then((r) => r.json()).then((res) => {
      if (!(res.bytes > 0)) return;
      offline.sizes.set(issue.id, Math.max(1, Math.round(res.bytes / 1e6)));
      if (state.issue === issue) renderTrip();
    }).catch(() => {});
  }

  function notHere(issue) {
    if (!offline.away || offline.saved.has(issue.id)) return false;
    toast('Tohle číslo v telefonu uložené není. Ulož si ho doma, až poběží čtečka na počítači.', 3500);
    return true;
  }

  function saveIssue(issue) {
    if (!offline.can) { showSaveHelp(true); return; }
    if (offline.saved.has(issue.id) || offline.queue.includes(issue.id)) return;
    offline.queue.push(issue.id);
    renderTrip();
    if (!offline.busy) pumpSaves();
  }
  async function pumpSaves() {
    while (offline.queue.length) {
      const issue = byId.get(offline.queue[0]);
      offline.busy = { id: issue.id, done: 0, total: 0 };
      renderTrip();
      try {
        await storeIssue(issue);
        offline.saved.add(issue.id);
        toast(`${issue.title} je v telefonu. Přečteš ho i bez internetu` +
          (standalone() ? '.' : ', když si Časopisárnu nainstaluješ tlačítkem nahoře na poličce.'), 5000);
      } catch (e) {
        await caches.delete('issue:' + issue.id).catch(() => {});
        toast(`${issue.title} se nepodařilo uložit. ` +
          (e && e.name === 'QuotaExceededError' ? 'V telefonu už není místo.' : 'Zkus to znovu, až poběží čtečka na počítači.'), 4500);
      }
      offline.queue.shift();
      offline.busy = null;
      renderTrip();
      refreshShelf();
    }
  }
  async function storeIssue(issue) {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await saveShell();
    const urls = [];
    issue.pages.forEach((p) => urls.push(imgUrl(issue, p, 'view'), imgUrl(issue, p, 'thumb')));
    const cache = await caches.open('issue:' + issue.id);
    offline.busy.total = urls.length;
    await pool(urls, 4, async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await cache.put(u, r);
      offline.busy.done++;
      renderTrip();
    });
    await cache.put(okUrl(issue.id), new Response('1'));
  }
  async function pool(list, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) await fn(list[i++]); }));
  }

  // čtečka sama (stránka, skripty, styly, písma, ikony) a obálky všech čísel na poličku
  function shellUrls() {
    const urls = new Set(['./', 'manifest.webmanifest', 'data/manifest.json', 'app/icon-192.png', 'app/icon-512.png', 'app/icon-maskable.png']);
    document.querySelectorAll('script[src]').forEach((s) => urls.add(s.src));
    const walk = (sheets) => {
      for (const sh of sheets) {
        if (sh.href) urls.add(sh.href);
        let rules = [];
        try { rules = sh.cssRules; } catch (e) { /* cizí styl */ }
        for (const r of rules) {
          if (r.styleSheet) walk([r.styleSheet]);
          else if (r.type === CSSRule.FONT_FACE_RULE) {
            for (const m of r.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g)) urls.add(new URL(m[1], sh.href || location.href).href);
          }
        }
      }
    };
    walk(document.styleSheets);
    if (BRAND.logo) urls.add(BRAND.logo);
    return [...urls].map((u) => new URL(u, location.href).href).filter((u) => new URL(u).origin === location.origin);
  }
  async function saveShell() {
    const shellCache = await caches.open('shell');
    await pool(shellUrls(), 4, (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? shellCache.put(u, r) : null)).catch(() => {}));
    const covers = await caches.open('covers');
    const have = new Set((await covers.keys()).map((r) => r.url));
    const missing = manifest.issues.map((is) => new URL(coverUrl(is), location.href).href).filter((u) => !have.has(u));
    await pool(missing, 6, (u) => fetch(u).then((r) => (r.ok ? covers.put(u, r) : null)).catch(() => {}));
  }

  async function removeIssue(issue) {
    await caches.delete('issue:' + issue.id);
    offline.saved.delete(issue.id);
    renderTrip();
    refreshShelf();
    toast(`${issue.title} je smazaný z telefonu.`);
  }
  function install() {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.finally(() => { installEvt = null; renderTrip(); });
  }

  // Chrome ukládá jen na zabezpečené adrese: čtečce z domácí sítě se to povolí jednou v chrome://flags
  // jiný prohlížeč (Samsung Internet, QR kód z foťáku ho otevře sám) přepínač nemá: nejdřív otevřít v Chrome
  const saveHelp = $('#save-help');
  const IS_CHROME = /Chrome\/\d/.test(navigator.userAgent) &&
    !/SamsungBrowser|EdgA|Edg\/|OPR|YaBrowser|Firefox|DuckDuckGo|MiuiBrowser|HuaweiBrowser|UCBrowser|; wv\)/.test(navigator.userAgent);
  function showSaveHelp(on) {
    saveHelp.querySelectorAll('[data-copy="origin"] code, .save-origin').forEach((c) => { c.textContent = location.origin; });
    saveHelp.querySelector('[data-open-chrome]').href = `intent://${location.host}/#Intent;scheme=http;package=com.android.chrome;end`;
    saveHelp.classList.toggle('is-other', !IS_CHROME);
    saveHelp.hidden = !on;
  }
  function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', top: '0', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* nejde */ }
    ta.remove();
    return ok;
  }
  saveHelp.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) {
      const text = c.dataset.copy === 'flags' ? 'chrome://flags/#unsafely-treat-insecure-origin-as-secure' : location.origin;
      toast(copyText(text) ? 'Zkopírováno, teď to vlož.' : `Opiš si: ${text}`, 3000);
      return;
    }
    if (e.target === saveHelp || e.target.closest('[data-save-help-close]')) showSaveHelp(false);
  });

  // --- start
  applyBrand();
  applyTheme(currentTheme());
  if (FROM_FILE) {
    // otevřeno přímo ze souboru: když čtečka běží, přepnout do ní
    showWelcome(true);
    const ping = document.createElement('script');
    ping.onload = () => location.replace('http://127.0.0.1:8642/' + location.hash);
    ping.src = 'http://127.0.0.1:8642/app/brand/brand.js?ping=' + Date.now();
    document.head.appendChild(ping);
  } else {
    if (offline.can) navigator.serviceWorker.register('sw.js').catch(() => {});
    const saved = offline.can ? loadSaved().catch(() => {}) : null;
    Promise.all([loadManifest(), getStatus(), getReader(), saved]).then(([m, st, rd]) => {
      mergeReader(rd);
      lib.status = st;
      lib.running = !!(st && st.running);
      if (st) el.libBtn.hidden = el.phoneBtn.hidden = !st.can_pick;
      // manifest je, ale čtečka na počítači neodpovídá: čte se z telefonu
      offline.away = offline.can && !!m && !st;
      renderInstall();
      if (offline.away) {
        if (offline.saved.size) settings.filter = 'saved';
        toast(offline.saved.size ? 'Jsi bez spojení s počítačem, čteš čísla uložená v telefonu.'
          : 'Jsi bez spojení s počítačem a v telefonu zatím nic uloženého nemáš.', 4000);
      }
      if (m && m.issues && m.issues.length) useManifest(m);
      else showWelcome(true);
      renderProgress();
      if (lib.running) pollLibrary();
    });
  }
})();
