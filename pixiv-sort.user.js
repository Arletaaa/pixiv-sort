// ==UserScript==
// @name         pixiv 收藏排序
// @namespace    dsh.pixiv.sort
// @version      1.0.2
// @description  pixiv 标签搜索页按收藏数/浏览量重排结果，支持 R-18/AI 筛选、阈值过滤、页码范围、一键保存原图
// @downloadURL  https://cdn.jsdelivr.net/gh/Arletaaa/pixiv-sort@main/pixiv-sort.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/Arletaaa/pixiv-sort@main/pixiv-sort.user.js
// @match        https://www.pixiv.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      i.pximg.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (document.getElementById('pxs-root')) return;

  /* ================= 配置 ================= */
  const CFG_KEY = 'pxs.cfg.v6';
  const COUNT_KEY = 'pxs.counts.v6';
  const LEGACY_COUNT_KEY = 'pxs.counts.v5';
  const COUNT_TTL = 7 * 864e5;   // 缓存有效期
  const COUNT_MAX = 5000;        // 缓存条数上限

  const DEF = {
    pageFrom: 1, pageTo: 1,
    interval: 500, pageSize: 24,
    sortKey: 'bookmark',        // 'bookmark' | 'view'
    minEnabled: false,
    minKey: 'bookmark',         // 'bookmark' | 'view'
    minValue: 0,
    filterR18: false,           // true → mode=safe
    filterAI: true,             // true → ai_type=1
    saveMode: 'download',       // 'download' | 'dir'
    saveDir: 'pixiv',
    askPath: false,
    template: '{title}_{id}',
  };

  function readJson(k, dflt) {
    try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? dflt : v; }
    catch (e) { return dflt; }
  }
  const cfg = Object.assign({}, DEF, readJson(CFG_KEY, {}));
  const persist = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} };

  // 老配置只有 pages（单值），迁移成 1..N
  if (cfg.pageFrom == null || cfg.pageTo == null) {
    const n = Math.min(50, Math.max(1, Number(cfg.pages) || 1));
    cfg.pageFrom = 1;
    cfg.pageTo = n;
  }

  // 缓存升级：v5 的 {c,t} → v6 的 {b,v,t}
  let counts = readJson(COUNT_KEY, null);
  if (!counts) {
    const old = readJson(LEGACY_COUNT_KEY, {});
    counts = {};
    for (const k of Object.keys(old)) {
      const v = old[k];
      if (v && typeof v.t === 'number') counts[k] = { b: Number(v.c) || 0, v: 0, t: v.t };
    }
  }
  const persistCounts = () => { try { localStorage.setItem(COUNT_KEY, JSON.stringify(counts)); } catch (e) {} };

  const state = { items: [], shown: [], page: 1, keyword: null, running: false, dirHandle: null };

  /* ================= 工具 ================= */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = n => Number(n || 0).toLocaleString('en-US');

  function toNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') { const n = parseInt(v.replace(/[^\d]/g, ''), 10); return isFinite(n) ? n : 0; }
    return 0;
  }
  function delay() {
    const base = Math.max(0, cfg.interval);
    if (!base) return 0;
    return Math.round(base * (0.6 + Math.random() * 0.8));
  }
  function rangeText() {
    const base = Math.max(0, cfg.interval);
    if (!base) return '无间隔';
    return Math.round(base * 0.6) + '–' + Math.round(base * 1.4) + ' ms';
  }
  function filterText() {
    return (cfg.filterR18 ? '屏蔽 R-18' : '含 R-18') + ' · ' + (cfg.filterAI ? '屏蔽 AI' : '含 AI');
  }
  function pageText() {
    return cfg.pageFrom === cfg.pageTo
      ? '第 ' + cfg.pageFrom + ' 页'
      : '第 ' + cfg.pageFrom + '–' + cfg.pageTo + ' 页';
  }
  const sortName = k => (k === 'view' ? '浏览量' : '收藏数');

  function currentKeyword() {
    const m = location.pathname.match(/^\/tags\/([^/]+)/);
    if (!m) return null;
    try { const k = decodeURIComponent(m[1]).trim(); return k || null; } catch (e) { return m[1]; }
  }

  /* ================= 缓存清理 ================= */
  function pruneCounts() {
    const now = Date.now();
    let removed = 0;
    for (const k of Object.keys(counts)) {
      const v = counts[k];
      if (!v || typeof v.t !== 'number' || now - v.t > COUNT_TTL) { delete counts[k]; removed++; }
    }
    const keys = Object.keys(counts);
    if (keys.length > COUNT_MAX) {
      keys.sort((a, b) => (counts[a].t || 0) - (counts[b].t || 0));
      for (const k of keys.slice(0, keys.length - COUNT_MAX)) { delete counts[k]; removed++; }
    }
    if (removed) persistCounts();
    return { removed, left: Object.keys(counts).length };
  }

  /* ================= 数据取值 ================= */
  function pickBookmark(it) {
    if (it && it.bookmarkCount !== undefined && it.bookmarkCount !== null) return toNum(it.bookmarkCount);
    if (it && it.bookmarkData && it.bookmarkData.count !== undefined) return toNum(it.bookmarkData.count);
    return 0;
  }
  function pickView(it) {
    if (it && it.viewCount !== undefined && it.viewCount !== null) return toNum(it.viewCount);
    return 0;
  }
  function dataOf(it) {
    return {
      b: it.__b !== undefined ? it.__b : pickBookmark(it),
      v: it.__v !== undefined ? it.__v : pickView(it),
    };
  }
  const metricOf = (it, key) => { const d = dataOf(it); return key === 'view' ? d.v : d.b; };
  const maxMetric = key => state.items.reduce((m, it) => Math.max(m, metricOf(it, key)), 0);

  /* ================= 排序 + 过滤 + 渲染 ================= */
  function rebuild() {
    const key = cfg.sortKey;
    const list = state.items.slice().sort((a, b) => metricOf(b, key) - metricOf(a, key));

    let out = list;
    const mk = cfg.minKey;
    const hasMetric = state.items.some(it => metricOf(it, mk) > 0);
    if (cfg.minEnabled && cfg.minValue > 0) {
      if (hasMetric) {
        out = list.filter(it => metricOf(it, mk) >= cfg.minValue);
      } else {
        log('阈值过滤已跳过：缺少「' + sortName(mk) + '」数据');
        setStatus('阈值过滤需要数据，请先点「补全数据」');
      }
    }

    state.shown = out;
    renderPage();

    if (!state.running && state.items.length && !out.length) {
      setStatus('阈值过滤后没有结果，降低阈值或关闭过滤');
    }
  }

  function summary() {
    const parts = ['按' + sortName(cfg.sortKey)];
    if (cfg.minEnabled && cfg.minValue > 0) parts.push(sortName(cfg.minKey) + ' ≥ ' + fmt(cfg.minValue));
    return parts.join(' · ');
  }

  function renderPage() {
    const per = cfg.pageSize;
    const pages = Math.max(1, Math.ceil(state.shown.length / per));
    state.page = clamp(state.page, 1, pages);
    const slice = state.shown.slice((state.page - 1) * per, state.page * per);

    const frag = document.createDocumentFragment();
    for (const it of slice) frag.appendChild(makeCard(it));
    el.grid.innerHTML = '';
    el.grid.appendChild(frag);
    el.grid.scrollTop = 0;

    el.info.textContent = state.shown.length
      ? state.page + ' / ' + pages + ' · ' + state.shown.length + '/' + state.items.length + ' 条'
      : '—';
    el.prev.disabled = state.page <= 1;
    el.next.disabled = state.page >= pages;
  }

  function makeCard(it) {
    const card = document.createElement('a');
    card.className = 'pxs-card';
    card.href = '/artworks/' + it.id;
    card.target = '_blank';
    card.rel = 'noopener';

    const thumb = document.createElement('div');
    thumb.className = 'pxs-thumb';

    const ph = document.createElement('span');
    ph.className = 'pxs-ph';
    ph.textContent = 'IMAGE';
    thumb.appendChild(ph);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = it.url || it.thumb || '';
    img.addEventListener('load', () => img.classList.add('pxs-ready'));
    img.addEventListener('error', () => img.remove());
    if (img.complete && img.naturalWidth) img.classList.add('pxs-ready');
    thumb.appendChild(img);

    const d = dataOf(it);
    const isView = cfg.sortKey === 'view';
    const score = document.createElement('span');
    score.className = 'pxs-score';
    score.innerHTML = '<i>' + (isView ? '👁' : '♥') + '</i>' + fmt(isView ? d.v : d.b);
    thumb.appendChild(score);

    if (it.pageCount > 1) {
      const multi = document.createElement('span');
      multi.className = 'pxs-multi';
      multi.textContent = it.pageCount + 'P';
      thumb.appendChild(multi);
    }

    const dl = document.createElement('button');
    dl.className = 'pxs-dl';
    dl.type = 'button';
    dl.textContent = '⬇ 原图';
    dl.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); startDownload(it, thumb, dl); });
    thumb.appendChild(dl);

    card.appendChild(thumb);

    const title = document.createElement('div');
    title.className = 'pxs-title';
    title.textContent = it.title || '(无标题)';
    title.title = it.title || '';
    card.appendChild(title);

    const user = document.createElement('div');
    user.className = 'pxs-user';
    user.textContent = it.userName || '';
    card.appendChild(user);

    return card;
  }

  /* ================= 样式 ================= */
  const CSS = `
  #pxs-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;
    --ink:#101216;--muted:#6b7280;--line:#e8eaef;--soft:#f6f7f9;--accent:#0f62fe;--danger:#d93025;
    font:13px/1.55 "Avenir Next","Segoe UI Variable Text","SF Pro Text",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    color:var(--ink);-webkit-font-smoothing:antialiased}
  #pxs-root *{box-sizing:border-box}
  #pxs-root button{font:inherit;cursor:pointer;color:inherit}
  #pxs-fab{pointer-events:auto;position:fixed;right:22px;bottom:22px;display:inline-flex;align-items:center;gap:9px;
    padding:11px 18px;background:#fff;border:1px solid var(--line);border-radius:999px;
    box-shadow:0 12px 32px -14px rgba(15,23,42,.3);letter-spacing:.02em;transition:.18s ease}
  #pxs-fab::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
  #pxs-fab:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px)}
  #pxs-panel{pointer-events:auto;position:fixed;right:22px;bottom:78px;width:min(1060px,92vw);height:min(78vh,720px);
    display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:18px;
    box-shadow:0 34px 80px -28px rgba(15,23,42,.38);overflow:hidden}
  #pxs-panel[hidden]{display:none}
  #pxs-head{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid var(--line)}
  .pxs-brand{font-size:11px;letter-spacing:.16em;color:var(--muted);white-space:nowrap}
  #pxs-kw{font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--soft);
    max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pxs-grow{flex:1}
  .pxs-btn{padding:7px 14px;border:1px solid var(--line);border-radius:9px;background:#fff;transition:.15s}
  .pxs-btn:hover{border-color:#c9ced8;background:#fbfbfc}
  .pxs-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;letter-spacing:.02em}
  .pxs-btn-primary:hover{background:#0a55da;border-color:#0a55da;color:#fff}
  .pxs-btn:disabled{opacity:.5;cursor:default}
  .pxs-btn-sm{padding:4px 10px;font-size:11px;border-radius:7px}
  #pxs-close{width:32px;height:32px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted)}
  #pxs-close:hover{background:var(--soft);color:var(--ink)}
  #pxs-controls{display:flex;align-items:center;gap:16px;padding:10px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;font-size:12px;color:var(--muted)}
  #pxs-controls label{display:inline-flex;align-items:center;gap:7px}
  .pxs-num{width:58px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:#fff;
    font:inherit;font-variant-numeric:tabular-nums;color:var(--ink);text-align:right}
  .pxs-num-wide{width:92px}
  .pxs-sel{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:#fff;font:inherit;color:var(--ink)}
  .pxs-num:focus,.pxs-sel:focus{outline:2px solid rgba(15,98,254,.18);border-color:var(--accent)}
  #pxs-jitter{color:#98a0ac;font-variant-numeric:tabular-nums}
  .pxs-sep{width:1px;height:18px;background:var(--line)}
  .pxs-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:var(--ink)}
  .pxs-check input{width:14px;height:14px;margin:0;accent-color:var(--accent)}
  .pxs-filters{display:inline-flex;align-items:center;gap:14px;padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:#fcfcfd}
  .pxs-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .pxs-seg button{padding:4px 14px;border:0;background:#fff;font-size:12px;color:var(--muted);transition:.15s}
  .pxs-seg button[data-on="1"]{background:var(--accent);color:#fff;font-weight:600}
  .pxs-seg button:not([data-on="1"]):hover{background:var(--soft);color:var(--ink)}
  #pxs-settings{display:none;flex-direction:column;gap:10px;padding:12px 18px;background:#fbfbfc;border-bottom:1px solid var(--line);max-height:280px;overflow:auto}
  #pxs-settings[data-open="1"]{display:flex}
  .pxs-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .pxs-row label{display:inline-flex;align-items:center;gap:6px}
  #pxs-settings input[type=text]{width:190px;padding:5px 9px;border:1px solid var(--line);border-radius:8px;font:inherit;color:var(--ink)}
  .pxs-hint{font-size:11px;color:#9aa1ad}
  .pxs-guide{border:1px solid var(--line);border-radius:9px;background:#fff;padding:0 12px}
  .pxs-guide summary{padding:8px 0;font-size:12px;color:var(--ink);cursor:pointer;letter-spacing:.02em}
  .pxs-guide ol{margin:0 0 10px 18px;padding:0;font-size:12px;color:var(--muted);line-height:1.8}
  .pxs-guide code{background:var(--soft);border-radius:4px;padding:1px 5px;font-size:11px}
  #pxs-dirbox{display:inline-flex;align-items:center;gap:8px}
  #pxs-dirname{font-variant-numeric:tabular-nums}
  .pxs-badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);background:#fff}
  .pxs-badge[data-state="ok"]{color:#0a7a45;border-color:#bfe6d1;background:#f1fbf5}
  .pxs-badge[data-state="warn"]{color:var(--danger);border-color:#f3c9c4;background:#fdf3f2}
  #pxs-statusbar{display:flex;align-items:center;gap:12px;padding:9px 18px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
  #pxs-status{font-variant-numeric:tabular-nums}
  #pxs-fill{padding:4px 11px;border:1px solid rgba(15,98,254,.4);border-radius:999px;background:#f2f6ff;color:var(--accent);font-size:11px}
  #pxs-fill:hover{background:#e8efff}
  #pxs-dl{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;padding:3px 10px;
    border:1px solid var(--line);border-radius:999px;background:#fff;cursor:pointer;transition:.15s}
  #pxs-dl:hover{color:var(--ink);border-color:#c9ced8}
  #pxs-dl[data-fail="1"]{color:var(--danger);border-color:#f3c9c4;background:#fdf3f2}
  #pxs-dl[data-busy="1"]::before{content:"●";margin-right:6px;color:var(--accent);animation:pxs-pulse 1s ease-in-out infinite}
  @keyframes pxs-pulse{0%,100%{opacity:.25}50%{opacity:1}}
  #pxs-grid{flex:1;overflow:auto;padding:16px 18px;display:grid;gap:16px;align-content:start;
    grid-template-columns:repeat(auto-fill,minmax(146px,1fr))}
  .pxs-card{display:block;text-decoration:none;color:inherit;transition:transform .18s ease}
  .pxs-card:hover{transform:translateY(-2px)}
  .pxs-thumb{position:relative;width:100%;padding-top:100%;border-radius:11px;overflow:hidden;background:var(--soft);border:1px solid var(--line)}
  .pxs-thumb img{position:absolute;left:0;top:0;width:100%!important;height:100%!important;object-fit:cover;
    display:block;opacity:0;transition:opacity .35s ease}
  .pxs-thumb img.pxs-ready{opacity:1}
  .pxs-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:11px;color:#b9bfca;letter-spacing:.08em}
  .pxs-score{position:absolute;left:8px;top:8px;display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;
    background:rgba(255,255,255,.94);font-size:11px;font-variant-numeric:tabular-nums;box-shadow:0 1px 4px rgba(15,23,42,.14)}
  .pxs-score i{font-style:normal;color:#e8456b}
  .pxs-multi{position:absolute;right:8px;top:8px;padding:2px 7px;border-radius:6px;background:rgba(16,18,22,.72);color:#fff;font-size:10px}
  .pxs-dl{position:absolute;right:8px;bottom:8px;padding:4px 10px;border:1px solid var(--line);border-radius:7px;background:#fff;
    font-size:11px;opacity:0;transition:.15s ease;box-shadow:0 2px 10px rgba(15,23,42,.16)}
  .pxs-card:hover .pxs-dl{opacity:1}
  .pxs-dl:hover{background:var(--accent);border-color:var(--accent);color:#fff}
  .pxs-title{padding:9px 2px 0;font-size:12px;font-weight:600;line-height:1.45;letter-spacing:.01em;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .pxs-user{padding:3px 2px 0;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pxs-picker{position:absolute;left:8px;right:8px;bottom:8px;padding:6px;border:1px solid var(--line);border-radius:8px;
    background:#fff;display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto;box-shadow:0 8px 24px -10px rgba(15,23,42,.3)}
  .pxs-picker button{padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;font-size:11px}
  .pxs-picker button:hover{border-color:var(--accent);color:var(--accent)}
  #pxs-foot{display:flex;align-items:center;justify-content:center;gap:16px;padding:10px 18px;border-top:1px solid var(--line)}
  .pxs-pg{width:30px;height:30px;border:1px solid var(--line);border-radius:8px;background:#fff;display:grid;place-items:center;color:var(--ink)}
  .pxs-pg:not(:disabled):hover{border-color:var(--accent);color:var(--accent)}
  .pxs-pg:disabled{opacity:.32;cursor:default}
  #pxs-pageinfo{min-width:150px;text-align:center;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  #pxs-logbox{border-top:1px solid var(--line);max-height:132px;overflow:auto;background:#fcfcfd}
  #pxs-logbox summary{padding:6px 18px;font-size:11px;color:#98a0ac;cursor:pointer;letter-spacing:.06em}
  #pxs-log{margin:0;padding:0 18px 10px;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#8b939f;white-space:pre-wrap}
  `;

  /* ================= DOM ================= */
  const root = document.createElement('div');
  root.id = 'pxs-root';
  root.innerHTML = '<style>' + CSS + '</style>' +
    '<button id="pxs-fab">收藏/浏览排序</button>' +
    '<section id="pxs-panel" hidden>' +
      '<header id="pxs-head">' +
        '<span class="pxs-brand">PIXIV · 收藏/浏览排序</span>' +
        '<span id="pxs-kw">—</span>' +
        '<span class="pxs-grow"></span>' +
        '<button id="pxs-run" class="pxs-btn pxs-btn-primary">开始抓取</button>' +
        '<button id="pxs-cfg" class="pxs-btn">设置</button>' +
        '<button id="pxs-close" title="关闭">✕</button>' +
      '</header>' +
      '<div id="pxs-controls">' +
        '<label>基础间隔 <input id="pxs-interval" class="pxs-num" type="number" min="0" step="50"> ms</label>' +
        '<span id="pxs-jitter">—</span>' +
        '<label>抓取范围 第 <input id="pxs-from" class="pxs-num" type="number" min="1" max="50"> 页 — 第 <input id="pxs-to" class="pxs-num" type="number" min="1" max="50"> 页</label>' +
        '<label>每页显示 <select id="pxs-size" class="pxs-sel"><option value="12">12</option><option value="24">24</option><option value="48">48</option></select></label>' +
        '<span class="pxs-sep"></span>' +
        '<span class="pxs-filters">' +
          '<label class="pxs-check"><input id="pxs-f-r18" type="checkbox"> 屏蔽 R-18</label>' +
          '<label class="pxs-check"><input id="pxs-f-ai" type="checkbox"> 屏蔽 AI 作品</label>' +
        '</span>' +
      '</div>' +
      '<div id="pxs-settings">' +
        '<details class="pxs-guide">' +
          '<summary>使用指引</summary>' +
          '<ol>' +
            '<li>在标签搜索页打开（如 <code>/tags/初音ミク/artworks</code>），点右下角「收藏排序」。</li>' +
            '<li>点「开始抓取」：按当前 R-18 / AI 筛选与页码范围取结果，页数越多等待越久。</li>' +
            '<li>「设置 → 排序依据」切换收藏数 / 浏览量，切换即时重排，不重新请求。</li>' +
            '<li>若角标全是 0，说明接口没返回数值：点状态栏右侧「补全数据」，逐条补一次（缓存 7 天）。</li>' +
            '<li>下载原图：鼠标悬停缩略图，点「⬇ 原图」；多页作品会先让你选 p0…pN。</li>' +
            '<li>要存到固定文件夹：设置 → 指定文件夹 → 选择文件夹（Chrome 重启后需点一次「重新授权」）。</li>' +
          '</ol>' +
        '</details>' +
        '<div class="pxs-row">' +
          '<span>排序依据</span>' +
          '<span class="pxs-seg">' +
            '<button id="pxs-sort-b" data-on="1" type="button">收藏数</button>' +
            '<button id="pxs-sort-v" data-on="0" type="button">浏览量</button>' +
          '</span>' +
          '<span class="pxs-hint">切换后立即重排，不重新抓取</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<label><input id="pxs-min-on" type="checkbox"> 只显示达到阈值</label>' +
          '<select id="pxs-min-key" class="pxs-sel">' +
            '<option value="bookmark">收藏数</option>' +
            '<option value="view">浏览量</option>' +
          '</select>' +
          '<span>≥</span>' +
          '<input id="pxs-min-val" class="pxs-num pxs-num-wide" type="number" min="0" step="100" value="0">' +
          '<span class="pxs-hint">数据缺失时不会误过滤，需先点「补全数据」</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<span>保存位置</span>' +
          '<label><input type="radio" name="pxs-sm" value="download"> Chrome 下载目录</label>' +
          '<label><input type="radio" name="pxs-sm" value="dir"> 指定文件夹（绝对路径）</label>' +
        '</div>' +
        '<div class="pxs-row"><div id="pxs-dirbox">' +
          '<button id="pxs-pick" class="pxs-btn pxs-btn-sm">选择文件夹…</button>' +
          '<button id="pxs-auth" class="pxs-btn pxs-btn-sm" hidden>重新授权</button>' +
          '<span id="pxs-dirname" class="pxs-hint">未选择</span>' +
          '<span id="pxs-dirbadge" class="pxs-badge" data-state="warn">未选择</span>' +
        '</div></div>' +
        '<div class="pxs-row" id="pxs-dlrow">' +
          '<label>子目录 <input id="pxs-dir" type="text" placeholder="pixiv"></label>' +
          '<label><input id="pxs-ask" type="checkbox"> 每次询问保存位置</label>' +
          '<span class="pxs-hint">仅「Chrome 下载目录」模式生效</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<label>文件名 <input id="pxs-tpl" type="text" placeholder="{title}_{id}"></label>' +
          '<span class="pxs-hint">可用占位：{title} {id} {page}</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<span>本地缓存</span>' +
          '<span id="pxs-cacheadv" class="pxs-hint">—</span>' +
          '<button id="pxs-clearcache" class="pxs-btn pxs-btn-sm">清除缓存</button>' +
          '<span class="pxs-hint">只存作品 ID 与数值，7 天过期</span>' +
        '</div>' +
      '</div>' +
      '<div id="pxs-statusbar"><span id="pxs-status">就绪</span><span class="pxs-grow"></span>' +
        '<span id="pxs-dl" hidden title="点击清零">已下载 0/0</span>' +
        '<button id="pxs-fill" hidden>补全数据</button></div>' +
      '<div id="pxs-grid"></div>' +
      '<footer id="pxs-foot">' +
        '<button id="pxs-prev" class="pxs-pg">‹</button>' +
        '<span id="pxs-pageinfo">—</span>' +
        '<button id="pxs-next" class="pxs-pg">›</button>' +
      '</footer>' +
      '<details id="pxs-logbox"><summary>日志</summary><pre id="pxs-log"></pre></details>' +
    '</section>';
  document.body.appendChild(root);

  const $ = id => root.querySelector('#' + id);
  const el = {
    fab: $('pxs-fab'), panel: $('pxs-panel'), kw: $('pxs-kw'), status: $('pxs-status'),
    grid: $('pxs-grid'), info: $('pxs-pageinfo'), prev: $('pxs-prev'), next: $('pxs-next'),
    log: $('pxs-log'), fill: $('pxs-fill'), jitter: $('pxs-jitter'),
  };

  function log(msg) {
    el.log.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
    if (el.log.textContent.length > 24000) el.log.textContent = el.log.textContent.slice(-18000);
    const box = $('pxs-logbox');
    box.scrollTop = box.scrollHeight;
  }
  const setStatus = t => { el.status.textContent = t; };

  /* ================= 下载计数 ================= */
  const dlStat = { done: 0, fail: 0, total: 0 };
  function renderDl() {
    const chip = $('pxs-dl');
    if (!chip) return;
    if (!dlStat.total) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.dataset.fail = dlStat.fail ? '1' : '0';
    chip.dataset.busy = (dlStat.done + dlStat.fail < dlStat.total) ? '1' : '0';
    chip.textContent = '已下载 ' + dlStat.done + '/' + dlStat.total + (dlStat.fail ? ' · 失败 ' + dlStat.fail : '');
  }

  const updateCacheAdv = () => { $('pxs-cacheadv').textContent = '已缓存 ' + Object.keys(counts).length + ' 条'; };

  /* ================= 网络 ================= */
  function csrfToken() {
    const m = document.querySelector('meta[name="csrf-token"]');
    return (m && m.content) || '';
  }
  async function getJson(url) {
    const headers = { Accept: 'application/json' };
    const tk = csrfToken();
    if (tk) headers['x-csrf-token'] = tk;
    const res = await fetch(url, { credentials: 'include', headers, cache: 'no-store' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON，通常是被重定向到登录/错误页 */ }
    return { status: res.status, json };
  }

  // 筛选是服务端参数：先清掉继承来的 mode / ai_type，再按开关重新写入
  function searchUrl(kw, p) {
    const qs = new URLSearchParams(location.search);
    qs.delete('p');
    qs.delete('mode');
    qs.delete('ai_type');
    qs.set('word', kw);
    qs.set('p', String(p));
    if (!qs.has('order')) qs.set('order', 'date_d');
    if (!qs.has('s_mode')) qs.set('s_mode', 's_tag');
    if (!qs.has('type')) qs.set('type', 'all');
    if (cfg.filterR18) qs.set('mode', 'safe');
    if (cfg.filterAI) qs.set('ai_type', '1');   // 1 = 非 AI 生成
    return '/ajax/search/artworks/' + encodeURIComponent(kw) + '?' + qs.toString();
  }

  async function fetchPage(kw, p) {
    let backoff = 1000, lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = performance.now();
      let r = null;
      try {
        r = await getJson(searchUrl(kw, p));
        log('p' + p + ' #' + attempt + ' → ' + r.status + ' · ' + Math.round(performance.now() - t0) + 'ms');
      } catch (e) {
        lastErr = e;
        log('p' + p + ' 网络错误：' + e.message);
      }
      if (r && r.status === 200 && r.json && !r.json.error) return r;
      if (r) {
        lastErr = new Error((r.status === 429 || r.status === 403)
          ? '第 ' + p + ' 页被限流（HTTP ' + r.status + '）'
          : '第 ' + p + ' 页 HTTP ' + r.status + (r.json && r.json.message ? '：' + r.json.message : ''));
      }
      if (attempt < 3) { log('重试 ' + attempt + '/3 · ' + backoff + 'ms 后'); await sleep(backoff); backoff *= 2; }
    }
    throw lastErr || new Error('第 ' + p + ' 页抓取失败');
  }

  /* ================= 抓取 ================= */
  async function run() {
    if (state.running) { setStatus('正在抓取中…'); return; }
    const kw = currentKeyword();
    if (!kw) { setStatus('当前不是标签搜索页（/tags/关键词）'); return; }

    readRange();
    cfg.interval = clamp(Number($('pxs-interval').value) || 0, 0, 60000);
    persist();
    el.jitter.textContent = '实际 ' + rangeText();

    state.running = true;
    state.keyword = kw;
    state.items = [];
    state.shown = [];
    state.page = 1;
    el.grid.innerHTML = '';
    el.fill.hidden = true;
    setStatus('开始抓取 · ' + pageText() + ' · ' + filterText());
    log('范围 ' + pageText() + '，筛选 mode=' + (cfg.filterR18 ? 'safe' : '(未设置)') + '，ai_type=' + (cfg.filterAI ? '1' : '(未设置)'));

    const t0 = performance.now();
    try {
      const map = new Map();
      let lastPage = Infinity, total = 0;
      for (let p = cfg.pageFrom; p <= cfg.pageTo && p <= lastPage; p++) {
        if (p > cfg.pageFrom) await sleep(delay());
        const r = await fetchPage(kw, p);
        const body = (r.json && r.json.body) || {};
        const im = body.illustManga || body.illust || body.manga || {};
        const list = im.data || [];
        total = im.total || total;
        lastPage = im.lastPage || lastPage;
        if (!list.length) { log('p' + p + ' 空页，提前结束'); break; }
        for (const it of list) if (!map.has(String(it.id))) map.set(String(it.id), it);
        setStatus('抓取中 ' + p + '/' + Math.min(cfg.pageTo, lastPage) + ' 页 · 已收 ' + map.size + ' 条');
      }

      state.items = [...map.values()];
      const first = state.items[0];
      if (first) log('字段自检：' + Object.keys(first).slice(0, 24).join(', '));

      const needB = maxMetric('bookmark') === 0;
      const needV = maxMetric('view') === 0;
      const activeNeed = (cfg.sortKey === 'view' ? needV : needB) || (cfg.minEnabled && (cfg.minKey === 'view' ? needV : needB));

      rebuild();

      if (state.items.length && activeNeed) {
        log('接口未提供排序所需的数值 → 需补全数据');
        el.fill.hidden = false;
        el.fill.textContent = '补全数据（' + state.items.length + ' 次请求）';
        setStatus('缺少数值，点右侧「补全数据」后才能精确排序/过滤');
      } else if (state.items.length) {
        const empty = state.shown.length === 0;
        setStatus('完成 · ' + state.shown.length + '/' + state.items.length + ' 条 · ' + summary()
          + (empty ? ' · 阈值过滤后为空' : '') + ' · ' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
      } else {
        setStatus('没有结果，检查关键词或筛选条件');
      }
    } catch (e) {
      setStatus('失败：' + e.message);
      log('中止：' + e.message);
    } finally {
      state.running = false;
    }
  }

  /* ================= 补全数据 ================= */
  async function fillData() {
    if (state.running) return;
    if (!state.items.length) return;
    const list = state.items.slice();
    const eta = Math.ceil(list.length * cfg.interval / 1000);
    if (!confirm('将逐个请求 ' + list.length + ' 个作品详情（一次拿到收藏数与浏览量），间隔随机在 ' + rangeText() + '。\n预计约 ' + eta + ' 秒，继续？')) return;

    state.running = true;
    el.fill.disabled = true;
    let done = 0, fail = 0;
    try {
      for (const it of list) {
        const id = String(it.id);
        const c = counts[id];
        if (c && Date.now() - c.t < COUNT_TTL) {
          it.__b = c.b || 0;
          it.__v = c.v || 0;
          done++;
          continue;
        }
        try {
          const r = await getJson('/ajax/illust/' + id + '?lang=zh');
          const body = r.json && r.json.body;
          it.__b = body ? pickBookmark(body) : 0;
          it.__v = body ? pickView(body) : 0;
          counts[id] = { b: it.__b, v: it.__v, t: Date.now() };
        } catch (e) { it.__b = 0; it.__v = 0; fail++; }
        done++;
        if (done % 20 === 0) persistCounts();
        setStatus('补全数据 ' + done + '/' + list.length + (fail ? ' · 失败 ' + fail : ''));
        await sleep(delay());
      }
      persistCounts();
      pruneCounts();
      updateCacheAdv();

      const okB = list.filter(it => it.__b > 0).length;
      const okV = list.filter(it => it.__v > 0).length;
      log('补全完成：收藏数 ' + okB + '/' + list.length + '，浏览量 ' + okV + '/' + list.length);

      state.page = 1;
      rebuild();
      el.fill.hidden = true;
      setStatus('已按' + sortName(cfg.sortKey) + '排序 · ' + state.shown.length + '/' + state.items.length + ' 条' + (fail ? '（' + fail + ' 个失败）' : ''));
    } catch (e) {
      setStatus('补全失败：' + e.message);
    } finally {
      state.running = false;
      el.fill.disabled = false;
    }
  }

  /* ================= 目录授权 ================= */
  const IDB_STORE = 'handles';
  const DIR_KEY = 'saveDirHandle';
  const IDB_NAME = 'pxs.fs.v7';
  const IDB_LEGACY = ['pxs.fs.v6', 'pxs.fs.v4'];

  function idb() {
    try { return indexedDB; } catch (e) { return unsafeWindow && unsafeWindow.indexedDB; }
  }
  function openDB(name) {
    return new Promise((resolve, reject) => {
      const rq = idb().open(name || IDB_NAME, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
    });
  }
  async function idbSet(k, v, name) {
    const db = await openDB(name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(k, name) {
    const db = await openDB(name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(k);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }

  const dirBadge = $('pxs-dirbadge');
  const dirName = $('pxs-dirname');
  function setDirBadge(s, handle) {
    dirBadge.dataset.state = s === 'ok' ? 'ok' : 'warn';
    dirBadge.textContent = s === 'ok' ? '已授权' : (s === 'none' ? '未选择' : '需重新授权');
    if (handle) dirName.textContent = handle.name || '(文件夹)';
    $('pxs-auth').hidden = !handle || s === 'ok';
    $('pxs-pick').textContent = handle ? '更换文件夹…' : '选择文件夹…';
  }

  async function pickDir() {
    const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const fn = (w && w.showDirectoryPicker) || window.showDirectoryPicker;
    if (typeof fn !== 'function') throw new Error('当前浏览器不支持目录授权（需 Chrome / Edge 86+）');
    const handle = await fn.call(w, { id: 'pxs-save-dir', mode: 'readwrite' });
    try { await idbSet(DIR_KEY, handle); } catch (e) { log('目录句柄保存失败：' + e.message); }
    return handle;
  }

  async function ensureDirPermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    const r = await handle.requestPermission(opts);
    return r === 'granted';
  }

  async function writeToDir(handle, name, blob) {
    const parts = String(name).split('/').filter(Boolean);
    const fname = parts.pop();
    let dir = handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  /* ================= 原图下载 ================= */
  let dlChain = Promise.resolve();
  function enqueue(fn) {
    dlChain = dlChain
      .then(() => sleep(800 + Math.random() * 800))
      .then(fn)
      .catch(e => log('下载出错：' + e.message));
    return dlChain;
  }

  function queueSave(url, name) {
    dlStat.total++;
    renderDl();
    return enqueue(async () => {
      try {
        await saveImage(url, name);
        dlStat.done++;
      } catch (e) {
        dlStat.fail++;
        throw e;
      } finally {
        renderDl();
      }
    });
  }

  function pageUrl(original, page) {
    return original.replace(/_p(\d+)(\.[a-z0-9]+)$/i, (m, n, ext) => '_p' + page + ext);
  }
  function fileName(it, url, page) {
    const m = url.match(/\.([a-z0-9]+)(?:\?.*)?$/i);
    const ext = m ? m[1] : 'jpg';
    let base = String(cfg.template || '{title}_{id}')
      .replace(/\{title\}/g, it.title || 'untitled')
      .replace(/\{id\}/g, it.id || '')
      .replace(/\{page\}/g, String(page));
    base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || String(it.id);
    return base + '_p' + page + '.' + ext;
  }

  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob',
        headers: { Referer: 'https://www.pixiv.net/' },
        onload: r => (r.status === 200 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('GM 网络错误')),
      });
    });
  }

  function anchorSave(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }

  function gmDownload(url, rel) {
    return new Promise((resolve, reject) => {
      GM_download({
        url: url, name: rel, saveAs: !!cfg.askPath,
        headers: { Referer: 'https://www.pixiv.net/' },
        onload: () => resolve(),
        onerror: () => reject(new Error('GM_download 失败')),
        ontimeout: () => reject(new Error('GM_download 超时')),
      });
    });
  }

  async function saveImage(url, name) {
    if (cfg.saveMode === 'dir') {
      if (!state.dirHandle) {
        log('未选择保存文件夹 → 本次回退到 Chrome 下载目录');
        setStatus('未选择保存文件夹（设置 → 选择文件夹）');
      } else {
        try {
          if (!(await ensureDirPermission(state.dirHandle))) throw new Error('目录未授权');
          const blob = await fetchBlob(url);
          await writeToDir(state.dirHandle, name, blob);
          log('已保存到文件夹：' + name);
          return;
        } catch (e) {
          log('写入文件夹失败：' + e.message + ' → 回退下载目录');
        }
      }
    }

    const dir = String(cfg.saveDir || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
    const rel = dir ? dir + '/' + name : name;
    try {
      await gmDownload(url, rel);
      log('已下载：' + rel);
      return;
    } catch (e) { /* 落到 blob 通道 */ }
    try {
      const blob = await fetchBlob(url);
      anchorSave(blob, name);
      log('已下载（blob 通道）：' + name);
    } catch (e) {
      log('下载失败：' + e.message + ' → 新标签页打开');
      window.open(url, '_blank');
    }
  }

  async function startDownload(it, thumb, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      log('查询原图地址 ' + it.id);
      const r = await getJson('/ajax/illust/' + it.id + '?lang=zh');
      const body = r.json && r.json.body;
      if (!body || !body.urls || !body.urls.original) {
        throw new Error(r.status === 404 ? '作品不存在或已删除' : '拿不到原图地址（可能受限）');
      }
      const pages = body.pageCount || it.pageCount || 1;
      if (pages > 1) {
        showPicker(it, body.urls.original, pages, thumb);
        btn.textContent = '⬇ 原图';
        return;
      }
      await queueSave(pageUrl(body.urls.original, 0), fileName(it, body.urls.original, 0));
      btn.textContent = '⬇ 原图';
    } catch (e) {
      log('下载失败：' + e.message);
      btn.textContent = '✕ 失败';
      setTimeout(() => { btn.textContent = '⬇ 原图'; }, 2500);
    } finally {
      btn.disabled = false;
    }
  }

  function showPicker(it, original, pages, thumb) {
    if (thumb.querySelector('.pxs-picker')) return;
    const box = document.createElement('div');
    box.className = 'pxs-picker';
    const n = Math.min(pages, 30);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'p' + i;
      b.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        box.remove();
        queueSave(pageUrl(original, i), fileName(it, original, i));
      });
      box.appendChild(b);
    }
    thumb.appendChild(box);
  }

  /* ================= 事件 ================= */
  function renderSortUI() {
    $('pxs-sort-b').dataset.on = cfg.sortKey === 'bookmark' ? '1' : '0';
    $('pxs-sort-v').dataset.on = cfg.sortKey === 'view' ? '1' : '0';
    $('pxs-min-key').value = cfg.minKey;
    $('pxs-min-on').checked = !!cfg.minEnabled;
    $('pxs-min-val').value = cfg.minValue;
  }

  function renderSaveMode() {
    const isDir = cfg.saveMode === 'dir';
    $('pxs-dirbox').style.opacity = isDir ? '1' : '.45';
    $('pxs-dirbox').style.pointerEvents = isDir ? 'auto' : 'none';
    $('pxs-dlrow').style.opacity = isDir ? '.45' : '1';
    $('pxs-dlrow').style.pointerEvents = isDir ? 'none' : 'auto';
    root.querySelectorAll('input[name="pxs-sm"]').forEach(r => { r.checked = r.value === cfg.saveMode; });
  }

  function readRange() {
    let a = clamp(Number($('pxs-from').value) || 1, 1, 50);
    let b = clamp(Number($('pxs-to').value) || a, 1, 50);
    if (b < a) { const t = a; a = b; b = t; }
    $('pxs-from').value = a;
    $('pxs-to').value = b;
    cfg.pageFrom = a;
    cfg.pageTo = b;
    persist();
  }

  $('pxs-interval').value = cfg.interval;
  $('pxs-from').value = cfg.pageFrom;
  $('pxs-to').value = cfg.pageTo;
  $('pxs-size').value = String(cfg.pageSize);
  $('pxs-dir').value = cfg.saveDir;
  $('pxs-ask').checked = !!cfg.askPath;
  $('pxs-tpl').value = cfg.template;
  $('pxs-f-r18').checked = !!cfg.filterR18;
  $('pxs-f-ai').checked = !!cfg.filterAI;
  el.jitter.textContent = '实际 ' + rangeText();
  renderSortUI();
  renderSaveMode();

  $('pxs-interval').addEventListener('change', e => {
    cfg.interval = clamp(Number(e.target.value) || 0, 0, 60000);
    persist();
    el.jitter.textContent = '实际 ' + rangeText();
  });
  $('pxs-from').addEventListener('change', readRange);
  $('pxs-to').addEventListener('change', readRange);
  $('pxs-size').addEventListener('change', e => { cfg.pageSize = Number(e.target.value) || 24; persist(); state.page = 1; renderPage(); });
  $('pxs-dir').addEventListener('change', e => { cfg.saveDir = e.target.value; persist(); });
  $('pxs-ask').addEventListener('change', e => { cfg.askPath = e.target.checked; persist(); });
  $('pxs-tpl').addEventListener('change', e => { cfg.template = e.target.value; persist(); });

  $('pxs-sort-b').addEventListener('click', () => {
    if (cfg.sortKey === 'bookmark') return;
    cfg.sortKey = 'bookmark';
    persist(); renderSortUI();
    if (state.items.length) { state.page = 1; rebuild(); setStatus('已改为按收藏数 · ' + state.shown.length + '/' + state.items.length + ' 条'); }
  });
  $('pxs-sort-v').addEventListener('click', () => {
    if (cfg.sortKey === 'view') return;
    cfg.sortKey = 'view';
    persist(); renderSortUI();
    if (!state.items.length) return;
    state.page = 1;
    rebuild();
    if (maxMetric('view') === 0) {
      el.fill.hidden = false;
      el.fill.textContent = '补全数据（' + state.items.length + ' 次请求）';
      setStatus('缺少浏览量数据，点「补全数据」后才能按浏览量排序');
    } else {
      setStatus('已改为按浏览量 · ' + state.shown.length + '/' + state.items.length + ' 条');
    }
  });

  $('pxs-min-on').addEventListener('change', e => {
    cfg.minEnabled = e.target.checked;
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });
  $('pxs-min-key').addEventListener('change', e => {
    cfg.minKey = e.target.value;
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });
  $('pxs-min-val').addEventListener('change', e => {
    cfg.minValue = Math.max(0, Number(e.target.value) || 0);
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });

  function onFilterChange() {
    cfg.filterR18 = $('pxs-f-r18').checked;
    cfg.filterAI = $('pxs-f-ai').checked;
    persist();
    log('筛选已改为：' + filterText() + '（需重新抓取生效）');
    if (state.items.length) setStatus('筛选已变更，点「开始抓取」重新获取');
  }
  $('pxs-f-r18').addEventListener('change', onFilterChange);
  $('pxs-f-ai').addEventListener('change', onFilterChange);

  root.querySelectorAll('input[name="pxs-sm"]').forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      cfg.saveMode = r.value;
      persist();
      renderSaveMode();
    });
  });

  $('pxs-pick').addEventListener('click', async () => {
    try {
      const handle = await pickDir();
      state.dirHandle = handle;
      cfg.saveMode = 'dir';
      persist();
      renderSaveMode();
      setDirBadge('ok', handle);
      log('已选择文件夹：' + (handle.name || '(未命名)'));
    } catch (e) {
      log('选择文件夹失败：' + e.message);
    }
  });

  $('pxs-auth').addEventListener('click', async () => {
    if (!state.dirHandle) return;
    try {
      const r = await state.dirHandle.requestPermission({ mode: 'readwrite' });
      setDirBadge(r === 'granted' ? 'ok' : 'prompt', state.dirHandle);
      log('重新授权：' + r);
    } catch (e) {
      log('授权失败：' + e.message);
    }
  });

  $('pxs-clearcache').addEventListener('click', () => {
    const n = Object.keys(counts).length;
    counts = {};
    persistCounts();
    updateCacheAdv();
    log('已清除缓存（' + n + ' 条）');
    setStatus('本地缓存已清除');
  });

  $('pxs-dl').addEventListener('click', () => {
    dlStat.done = dlStat.fail = dlStat.total = 0;
    renderDl();
  });

  $('pxs-cfg').addEventListener('click', () => {
    const s = $('pxs-settings');
    s.dataset.open = s.dataset.open === '1' ? '0' : '1';
  });
  $('pxs-run').addEventListener('click', run);
  el.fill.addEventListener('click', fillData);
  el.prev.addEventListener('click', () => { state.page--; renderPage(); });
  el.next.addEventListener('click', () => { state.page++; renderPage(); });

  function togglePanel(open) {
    el.panel.hidden = open === undefined ? !el.panel.hidden : !open;
    if (!el.panel.hidden) syncKeyword();
  }
  el.fab.addEventListener('click', () => togglePanel());
  $('pxs-close').addEventListener('click', () => togglePanel(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') el.panel.hidden = true; });

  function syncKeyword() {
    const kw = currentKeyword();
    el.kw.textContent = kw ? '「' + kw + '」' : '非搜索页';
    el.fab.style.display = kw ? '' : 'none';
    if (!kw && !el.panel.hidden) setStatus('当前不是 /tags/关键词 搜索页');
    return kw;
  }

  /* 恢复上次授权的文件夹（含旧版数据库迁移） */
  (async () => {
    try {
      let h = await idbGet(DIR_KEY);
      if (!h) {
        for (const legacy of IDB_LEGACY) {
          try {
            const old = await idbGet(DIR_KEY, legacy);
            if (old) { await idbSet(DIR_KEY, old); h = old; log('已沿用旧版文件夹授权'); break; }
          } catch (e) { /* 旧库不存在，跳过 */ }
        }
      }
      if (!h) { setDirBadge('none'); }
      else {
        state.dirHandle = h;
        const p = await h.queryPermission({ mode: 'readwrite' });
        setDirBadge(p === 'granted' ? 'ok' : 'prompt', h);
        log('已恢复文件夹授权（' + (h.name || '未命名') + '），状态：' + p);
      }
    } catch (e) {
      setDirBadge('none');
      log('恢复目录授权失败：' + e.message);
    }
    const pr = pruneCounts();
    updateCacheAdv();
    log('缓存检查：清理 ' + pr.removed + ' 条，剩余 ' + pr.left + ' 条');
  })();

  // SPA 路由切换：清数据、更新关键词
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const kw = syncKeyword();
    if (kw !== state.keyword) {
      state.items = [];
      state.shown = [];
      state.page = 1;
      el.grid.innerHTML = '';
      el.info.textContent = '—';
      el.fill.hidden = true;
      setStatus('关键词已切换，点「开始抓取」');
    }
  }, 700);

  syncKeyword();
  log('v1.0.2 已加载 · 关键词：' + (currentKeyword() || '(无)') + ' · ' + pageText() + ' · ' + filterText());
  log('首次使用：设置 → 使用指引；缺数值时点「补全数据」。');
})();
