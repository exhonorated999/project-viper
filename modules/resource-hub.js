/**
 * Resource Hub — Unified Investigative Resources drawer
 * Self-contained: injects FAB + drawer DOM, manages BrowserView positioning,
 * Trace Network Search UI, FMCSA Carrier Lookup UI.
 *
 * Include on any page AFTER viper-ui.js and trace-search-api.js:
 *   <script src="modules/resource-hub.js"></script>
 *
 * Requires: window.electronAPI (preload), TraceSearch, viperToast
 */
(function () {
  'use strict';

  /* ── Resource definitions ─────────────────────────────────── */
  const RESOURCES = [
    { id: 'flock',    label: 'Flock Safety',        enabledKey: 'flockEnabled',        isBV: true },
    { id: 'tlo',      label: 'TLO / TransUnion',    enabledKey: 'tloEnabled',          isBV: true },
    { id: 'accurint', label: 'LexisNexis Accurint', enabledKey: 'accurintEnabled',     isBV: true },
    { id: 'trace',    label: 'TRACE Network',       enabledKey: 'traceSearch_enabled', isBV: false },
    { id: 'fmcsa',    label: 'FMCSA Carrier',       enabledKey: 'fmcsaEnabled',        isBV: false },
  ];

  let rhOpen = false;
  let rhExpanded = false;
  let rhActiveTab = null;

  function enabled() {
    return RESOURCES.filter(r => localStorage.getItem(r.enabledKey) === 'true');
  }

  /* ── Inject CSS ───────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('rh-styles')) return;
    const s = document.createElement('style');
    s.id = 'rh-styles';
    s.textContent = `
      #resourceHubFab{transition:transform .2s,box-shadow .2s;animation:rhGlow 3s ease-in-out infinite}
      #resourceHubFab:hover{transform:scale(1.05);box-shadow:0 0 28px rgba(236,72,153,.45),0 0 8px rgba(236,72,153,.25)}
      #resourceHubFab .fab-badge{animation:rhPulse 2s infinite}
      @keyframes rhPulse{0%,100%{opacity:1}50%{opacity:.6}}
      @keyframes rhGlow{0%,100%{box-shadow:0 0 12px rgba(236,72,153,.25),inset 0 0 8px rgba(236,72,153,.08)}50%{box-shadow:0 0 18px rgba(236,72,153,.35),inset 0 0 12px rgba(236,72,153,.12)}}
      #resourceHubDrawer{transition:transform .3s cubic-bezier(.4,0,.2,1)}
      #resourceHubDrawer.rh-open{transform:translateX(0)!important}
      .rh-tab{transition:all .15s;position:relative}
      .rh-tab::after{content:'';position:absolute;bottom:0;left:50%;width:0;height:2px;transition:all .2s;transform:translateX(-50%)}
      .rh-tab.rh-active{color:#fff}
      .rh-tab[data-res=flock].rh-active::after{width:100%;background:#2dd4bf}
      .rh-tab[data-res=tlo].rh-active::after{width:100%;background:#818cf8}
      .rh-tab[data-res=accurint].rh-active::after{width:100%;background:#60a5fa}
      .rh-tab[data-res=trace].rh-active::after{width:100%;background:#fbbf24}
      .rh-tab[data-res=fmcsa].rh-active::after{width:100%;background:#60a5fa}
      .rh-bv-placeholder{background:rgba(10,15,28,.5);border:1px dashed rgba(255,255,255,.08);border-radius:8px}
      .rh-result-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:14px;transition:border-color .15s}
      .rh-result-card:hover{border-color:rgba(255,255,255,.12)}
    `;
    document.head.appendChild(s);
  }

  /* ── Inject DOM ───────────────────────────────────────────── */
  function injectDOM() {
    if (document.getElementById('resourceHubFab')) return;

    // FAB
    const fab = document.createElement('button');
    fab.id = 'resourceHubFab';
    fab.className = 'fixed z-[9998] w-12 h-12 rounded-xl flex items-center justify-center text-pink-300';
    fab.style.cssText = 'bottom:24px;right:24px;display:none;background:rgba(236,72,153,.12);border:1px solid rgba(236,72,153,.30);backdrop-filter:blur(8px);';
    fab.title = 'Investigative Resources';
    fab.onclick = toggle;
    fab.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
      </svg>
      <span id="resourceHubBadge" class="fab-badge absolute -top-1.5 -right-1.5 rounded-full bg-pink-500 text-white font-bold flex items-center justify-center border-2 border-[#0a0e14]" style="display:none;width:18px;height:18px;font-size:10px;">0</span>`;
    document.body.appendChild(fab);

    // Drawer
    const drawer = document.createElement('div');
    drawer.id = 'resourceHubDrawer';
    drawer.className = 'fixed top-0 right-0 h-full z-[9999]';
    drawer.style.cssText = 'width:560px;transform:translateX(100%);';
    drawer.innerHTML = `
      <div class="h-full flex flex-col border-l border-cyan-500/20" style="background:rgba(10,14,22,.97);backdrop-filter:blur(24px);">
        <div class="flex items-center justify-between px-5 py-3 border-b border-white/5 flex-shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center border border-cyan-500/20">
              <svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            </div>
            <h3 class="text-sm font-bold text-white tracking-wide">INVESTIGATIVE RESOURCES</h3>
          </div>
          <div class="flex items-center gap-1">
            <button id="rhExpandBtn" class="p-2 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition" title="Expand" onclick="window._rhToggleExpand()">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
            </button>
            <button class="p-2 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition" title="Close" onclick="window._rhClose()">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div id="rhTabBar" class="flex border-b border-white/5 px-3 flex-shrink-0 gap-1 overflow-x-auto" style="min-height:42px;"></div>
        <div id="rhContent" class="flex-1 min-h-0 relative">
          <div id="rhPanel_flock" class="absolute inset-0 hidden">
            <div id="rhBV_flock" class="rh-bv-placeholder w-full h-full flex items-center justify-center"><p class="text-gray-600 text-xs">Loading Flock Safety…</p></div>
          </div>
          <div id="rhPanel_tlo" class="absolute inset-0 hidden">
            <div id="rhBV_tlo" class="rh-bv-placeholder w-full h-full flex items-center justify-center"><p class="text-gray-600 text-xs">Loading TLO / TransUnion…</p></div>
          </div>
          <div id="rhPanel_accurint" class="absolute inset-0 hidden">
            <div id="rhBV_accurint" class="rh-bv-placeholder w-full h-full flex items-center justify-center"><p class="text-gray-600 text-xs">Loading LexisNexis Accurint…</p></div>
          </div>
          <div id="rhPanel_trace" class="absolute inset-0 hidden overflow-y-auto">
            <div class="p-5 space-y-4">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center border border-amber-500/20">
                  <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                </div>
                <div>
                  <h4 class="text-sm font-bold text-white">TRACE Network</h4>
                  <p class="text-[10px] text-gray-500" id="rhTraceStatus">Not connected</p>
                </div>
              </div>
              <div class="space-y-3">
                <select id="rhTraceType" class="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs focus:border-amber-400/50 outline-none">
                  <option value="plate">License Plate</option>
                  <option value="name">Person Name</option>
                  <option value="mc">MC / MX Number</option>
                  <option value="dot">USDOT Number</option>
                  <option value="trailer">Trailer Plate</option>
                  <option value="dl">Driver License #</option>
                  <option value="serial">Serial Number</option>
                </select>
                <div class="flex gap-2">
                  <input id="rhTraceInput" type="text" placeholder="Enter search term…" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder-gray-500 focus:border-amber-400/50 outline-none" onkeydown="if(event.key==='Enter') window._rhTraceSearch()">
                  <input id="rhTraceState" type="text" placeholder="State" maxlength="2" class="w-16 px-2 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder-gray-500 focus:border-amber-400/50 outline-none uppercase" style="display:none;" onkeydown="if(event.key==='Enter') window._rhTraceSearch()">
                  <button onclick="window._rhTraceSearch()" class="px-4 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-medium border border-amber-500/20 transition flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>Search
                  </button>
                </div>
              </div>
              <div id="rhTraceResults" class="space-y-3"></div>
            </div>
          </div>
          <div id="rhPanel_fmcsa" class="absolute inset-0 hidden overflow-y-auto">
            <div class="p-5 space-y-4">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center border border-blue-500/20">
                  <svg class="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
                </div>
                <div>
                  <h4 class="text-sm font-bold text-white">FMCSA Carrier Lookup</h4>
                  <p class="text-[10px] text-gray-500">SAFER Database</p>
                </div>
              </div>
              <div class="space-y-3">
                <select id="rhFmcsaType" class="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs focus:border-blue-400/50 outline-none">
                  <option value="NAME">Company Name</option>
                  <option value="USDOT">USDOT Number</option>
                  <option value="MC_MX">MC/MX Number</option>
                </select>
                <div class="flex gap-2">
                  <input id="rhFmcsaInput" type="text" placeholder="Search carrier name, DOT#, or MC/MX#" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs placeholder-gray-500 focus:border-blue-400/50 outline-none" onkeydown="if(event.key==='Enter') window._rhFmcsaSearch()">
                  <button onclick="window._rhFmcsaSearch()" class="px-4 py-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-xs font-medium border border-blue-500/20 transition flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>Search
                  </button>
                </div>
              </div>
              <div id="rhFmcsaResults" class="space-y-3"></div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(drawer);
  }

  /* ── FAB visibility ───────────────────────────────────────── */
  function updateFab() {
    const active = enabled();
    const fab = document.getElementById('resourceHubFab');
    const badge = document.getElementById('resourceHubBadge');
    if (!fab) return;
    fab.style.display = active.length > 0 ? 'flex' : 'none';
    if (active.length > 1) {
      badge.style.display = 'flex';
      badge.textContent = active.length;
    } else {
      badge.style.display = 'none';
    }
  }

  /* ── Tab bar ──────────────────────────────────────────────── */
  function buildTabBar() {
    const bar = document.getElementById('rhTabBar');
    if (!bar) return;
    const active = enabled();
    bar.innerHTML = active.map(r =>
      `<button class="rh-tab px-4 py-2.5 text-xs font-semibold text-gray-500 hover:text-gray-300 whitespace-nowrap transition" data-res="${r.id}" onclick="window._rhSwitchTab('${r.id}')">${r.label}</button>`
    ).join('');
    if (!active.find(r => r.id === rhActiveTab) && active.length) rhActiveTab = active[0].id;
    highlightTab();
  }

  function highlightTab() {
    document.querySelectorAll('.rh-tab').forEach(t =>
      t.classList.toggle('rh-active', t.dataset.res === rhActiveTab)
    );
  }

  /* ── Panel switching ──────────────────────────────────────── */
  function showPanel(resId) {
    RESOURCES.forEach(r => {
      const p = document.getElementById('rhPanel_' + r.id);
      if (p) p.classList.add('hidden');
      if (r.isBV) hideBV(r.id);
    });
    const panel = document.getElementById('rhPanel_' + resId);
    if (panel) panel.classList.remove('hidden');
    const res = RESOURCES.find(r => r.id === resId);
    if (res && res.isBV && rhOpen) {
      requestAnimationFrame(() => positionBV(resId));
    }
    rhActiveTab = resId;
    highlightTab();
    if (resId === 'trace') updateTraceStatus();
  }

  /* ── BrowserView positioning ──────────────────────────────── */
  function positionBV(resId) {
    const el = document.getElementById('rhBV_' + resId);
    if (!el || !window.electronAPI) return;
    const r = el.getBoundingClientRect();
    const b = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    if (b.width < 10 || b.height < 10) return;
    if (resId === 'flock') { window.electronAPI.flockSetBounds(b); window.electronAPI.flockSetVisible(true); }
    if (resId === 'tlo')   { window.electronAPI.tloSetBounds(b);   window.electronAPI.tloSetVisible(true); }
    if (resId === 'accurint') { window.electronAPI.accurintSetBounds(b); window.electronAPI.accurintSetVisible(true); }
  }

  function hideBV(resId) {
    if (!window.electronAPI) return;
    if (resId === 'flock') window.electronAPI.flockSetVisible(false);
    if (resId === 'tlo')   window.electronAPI.tloSetVisible(false);
    if (resId === 'accurint') window.electronAPI.accurintSetVisible(false);
  }

  function hideAllBVs() { RESOURCES.filter(r => r.isBV).forEach(r => hideBV(r.id)); }

  /* ── Open / Close / Toggle ────────────────────────────────── */
  function toggle() { rhOpen ? close() : open(); }

  function open() {
    const active = enabled();
    if (!active.length) return;
    buildTabBar();
    if (!rhActiveTab || !active.find(r => r.id === rhActiveTab)) rhActiveTab = active[0].id;
    const drawer = document.getElementById('resourceHubDrawer');
    drawer.classList.add('rh-open');
    rhOpen = true;
    const res = RESOURCES.find(r => r.id === rhActiveTab);
    if (res && res.isBV) {
      RESOURCES.forEach(r => { const p = document.getElementById('rhPanel_' + r.id); if (p) p.classList.add('hidden'); });
      const panel = document.getElementById('rhPanel_' + rhActiveTab);
      if (panel) panel.classList.remove('hidden');
      highlightTab();
      setTimeout(() => { if (rhOpen) positionBV(rhActiveTab); }, 350);
    } else {
      showPanel(rhActiveTab);
    }
  }

  function close() {
    const drawer = document.getElementById('resourceHubDrawer');
    drawer.classList.remove('rh-open');
    hideAllBVs();
    rhOpen = false;
    if (rhExpanded) { rhExpanded = false; drawer.style.width = '560px'; }
  }

  function toggleExpand() {
    const drawer = document.getElementById('resourceHubDrawer');
    rhExpanded = !rhExpanded;
    drawer.style.width = rhExpanded ? 'calc(100vw - 256px)' : '560px';
    setTimeout(() => {
      const res = RESOURCES.find(r => r.id === rhActiveTab);
      if (res && res.isBV && rhOpen) positionBV(rhActiveTab);
    }, 320);
  }

  function switchTab(resId) {
    showPanel(resId);
    const res = RESOURCES.find(r => r.id === resId);
    if (res && res.isBV && rhOpen) setTimeout(() => positionBV(resId), 50);
  }

  /* ── Trace Network Search ─────────────────────────────────── */
  function updateTraceStatus() {
    const el = document.getElementById('rhTraceStatus');
    if (!el) return;
    if (typeof TraceSearch === 'undefined') { el.textContent = 'Module not loaded'; return; }
    const st = TraceSearch.connectionStatus();
    if (!st.enabled) el.textContent = 'Disabled — enable in Settings';
    else if (!st.registered) el.textContent = 'Not registered';
    else el.textContent = 'Connected — ' + st.agency;
  }

  async function traceSearch() {
    const type = document.getElementById('rhTraceType').value;
    const input = document.getElementById('rhTraceInput').value.trim();
    const state = document.getElementById('rhTraceState').value.trim().toUpperCase();
    const out = document.getElementById('rhTraceResults');
    if (!input) { viperToast('Enter a search term.', 'error'); return; }
    if (typeof TraceSearch === 'undefined' || !TraceSearch.isEnabled()) { viperToast('TRACE Network is not enabled. Turn it on in Settings.', 'warning'); return; }
    if (!TraceSearch.isRegistered()) { viperToast('Register with TRACE Network first in Settings.', 'warning'); return; }

    let tokens = [];
    try {
      switch (type) {
        case 'plate': { const k = state ? input.toUpperCase() + ':' + state : input.toUpperCase(); tokens = [{ token_hash: await TraceSearch.sha256(k), token_type: 'vehicle_plate', tier: 1, case_type: 'cargo' }]; break; }
        case 'name':  { const p = input.trim().split(/\s+/), f = p.join(' ').toUpperCase(); tokens = [{ token_hash: await TraceSearch.sha256(f), token_type: 'suspect_exact', tier: 1, case_type: 'cargo' }]; if (p.length >= 2) tokens.push({ token_hash: await TraceSearch.sha256(p[p.length - 1].toUpperCase()), token_type: 'suspect_desc', tier: 2, case_type: 'cargo' }); break; }
        case 'mc':      tokens = [{ token_hash: await TraceSearch.sha256(input.toUpperCase()), token_type: 'cargo_mc',      tier: 1, case_type: 'cargo' }]; break;
        case 'dot':     tokens = [{ token_hash: await TraceSearch.sha256(input.toUpperCase()), token_type: 'cargo_mc',      tier: 1, case_type: 'cargo' }]; break;
        case 'trailer': { const k = state ? input.toUpperCase() + ':' + state : input.toUpperCase(); tokens = [{ token_hash: await TraceSearch.sha256(k), token_type: 'cargo_trailer', tier: 1, case_type: 'cargo' }]; break; }
        case 'dl':      tokens = [{ token_hash: await TraceSearch.sha256(input.toUpperCase()), token_type: 'cargo_dl',      tier: 1, case_type: 'cargo' }]; break;
        case 'serial':  tokens = [{ token_hash: await TraceSearch.sha256(input.toUpperCase()), token_type: 'serial_number', tier: 1, case_type: 'cargo' }]; break;
      }
    } catch (e) { viperToast('Error hashing tokens.', 'error'); return; }

    out.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-gray-500"><svg class="w-7 h-7 animate-spin text-amber-400 mb-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg><p class="text-xs">Searching TRACE Network…</p></div>';

    try {
      const result = await TraceSearch.search(tokens, 'VIPER-SEARCH', 'Resource Hub search', 'manual');
      if (!result.match_count) {
        out.innerHTML = '<div class="flex flex-col items-center py-12 text-center"><svg class="w-10 h-10 text-gray-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/></svg><p class="text-sm text-gray-400 font-medium">No matches found</p><p class="text-xs text-gray-600 mt-1">' + tokens.length + ' token(s) searched</p></div>';
      } else {
        out.innerHTML = '<p class="text-xs text-amber-400/80 font-medium mb-3">' + result.match_count + ' match(es) across TRACE network</p>' +
          (result.matches || []).map(m => {
            const conf = m.confidence >= 80 ? 'bg-green-500/20 text-green-400 border-green-500/30' : m.confidence >= 50 ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' : 'bg-gray-500/20 text-gray-400 border-gray-500/30';
            return '<div class="rh-result-card mb-3"><div class="flex items-start justify-between mb-2"><h5 class="text-white text-sm font-bold">' + (m.store_name || 'Unknown Store') + '</h5><span class="px-2 py-0.5 rounded text-[10px] font-bold border ' + conf + '">' + m.confidence + '%</span></div>' +
              (m.case_ref ? '<p class="text-xs text-gray-400">Case: <span class="text-white">' + m.case_ref + '</span></p>' : '') +
              (m.city ? '<p class="text-xs text-gray-500 mt-1">' + m.city + (m.state ? ', ' + m.state : '') + '</p>' : '') +
              (m.matched_tokens ? '<p class="text-[10px] text-gray-600 mt-2">' + m.matched_tokens + ' token(s) matched</p>' : '') + '</div>';
          }).join('');
      }
    } catch (e) {
      out.innerHTML = '<div class="flex flex-col items-center py-12 text-center"><svg class="w-10 h-10 text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg><p class="text-sm text-red-400 font-medium">' + (e.message || 'Search failed') + '</p></div>';
    }
  }

  /* ── FMCSA Search ─────────────────────────────────────────── */
  async function fmcsaSearch() {
    const type = document.getElementById('rhFmcsaType').value;
    const input = document.getElementById('rhFmcsaInput').value.trim();
    const out = document.getElementById('rhFmcsaResults');
    if (!input) { viperToast('Enter a search term.', 'error'); return; }

    out.innerHTML = '<div class="flex flex-col items-center py-12 text-gray-500"><svg class="w-7 h-7 animate-spin text-blue-400 mb-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg><p class="text-xs">Searching FMCSA for "' + input + '"…</p></div>';

    try {
      const result = await window.electronAPI.fmcsaLookup({ type, query: input });
      if (!result.success) { fmcsaError(out, result.error); return; }
      fmcsaRender(out, result.carriers, input, result.isList);
    } catch (e) { fmcsaError(out, e.message || 'Lookup failed'); }
  }

  async function fmcsaLookupByDot(dot) {
    const out = document.getElementById('rhFmcsaResults');
    out.innerHTML = '<div class="flex flex-col items-center py-12 text-gray-500"><svg class="w-7 h-7 animate-spin text-blue-400 mb-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg><p class="text-xs">Loading DOT# ' + dot + '…</p></div>';
    try {
      const result = await window.electronAPI.fmcsaLookup({ type: 'USDOT', query: dot });
      if (result.success) fmcsaRender(out, result.carriers, dot);
      else fmcsaError(out, result.error);
    } catch (e) { fmcsaError(out, e.message); }
  }

  function fmcsaError(el, msg) {
    el.innerHTML = '<div class="flex flex-col items-center py-12 text-center"><svg class="w-10 h-10 text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg><p class="text-sm text-red-400 font-medium">' + msg + '</p></div>';
  }

  function fmcsaRender(el, carriers, term, isList) {
    if (!carriers || !carriers.length) { el.innerHTML = '<p class="text-gray-500 text-xs text-center py-8">No carriers found.</p>'; return; }
    if (isList) {
      el.innerHTML = '<p class="text-xs text-gray-500 mb-3">' + carriers.length + ' matches for "' + term + '"</p><div class="space-y-2">' +
        carriers.map(cr => '<button onclick="window._rhFmcsaDot(\'' + cr.dotNumber + '\')" class="w-full text-left rounded-lg p-3 border border-blue-500/15 hover:border-blue-500/30 transition" style="background:rgba(59,130,246,.04);"><p class="text-white font-semibold text-sm">' + (cr.legalName || 'Unknown') + '</p><p class="text-xs text-gray-500 font-mono">USDOT# ' + cr.dotNumber + '</p></button>').join('') + '</div>';
      return;
    }
    el.innerHTML = carriers.map(cr => {
      const sb = cr.outOfServiceDate && cr.outOfServiceDate !== 'None'
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40">OUT OF SERVICE</span>'
        : cr.status === 'ACTIVE'
          ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-green-500/20 text-green-400 border border-green-500/40">' + cr.status + '</span>'
          : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">' + (cr.status || 'UNKNOWN') + '</span>';
      let insp = '';
      if (cr.inspections) {
        const ins = cr.inspections.inspections, pct = cr.inspections.oosPercent;
        insp = '<div class="mt-3 pt-3 border-t border-white/5"><h5 class="text-[10px] font-bold text-blue-300 mb-2 uppercase tracking-wider">Inspections (24 Mo)</h5><div class="grid grid-cols-3 gap-2 text-xs"><div><span class="text-gray-500">Vehicle</span><p class="text-white">' + (ins?.[1] || '—') + ' <span class="text-gray-600">(' + (pct?.[1] || '—') + ' OOS)</span></p></div><div><span class="text-gray-500">Driver</span><p class="text-white">' + (ins?.[2] || '—') + ' <span class="text-gray-600">(' + (pct?.[2] || '—') + ' OOS)</span></p></div><div><span class="text-gray-500">Hazmat</span><p class="text-white">' + (ins?.[3] || '—') + '</p></div></div></div>';
      }
      let crash = '';
      if (cr.crashes && cr.crashes.data) {
        const d = cr.crashes.data;
        crash = '<div class="mt-3 pt-3 border-t border-white/5"><h5 class="text-[10px] font-bold text-blue-300 mb-2 uppercase tracking-wider">Crashes (24 Mo)</h5><div class="grid grid-cols-4 gap-2 text-xs"><div><span class="text-gray-500">Fatal</span><p class="' + (d[1] !== '0' ? 'text-red-400 font-bold' : 'text-white') + '">' + (d[1] || '0') + '</p></div><div><span class="text-gray-500">Injury</span><p class="text-white">' + (d[2] || '0') + '</p></div><div><span class="text-gray-500">Tow</span><p class="text-white">' + (d[3] || '0') + '</p></div><div><span class="text-gray-500">Total</span><p class="text-white font-bold">' + (d[4] || '0') + '</p></div></div></div>';
      }
      const cargo = cr.cargoCarried && cr.cargoCarried.length
        ? '<div class="mt-3 pt-3 border-t border-white/5"><h5 class="text-[10px] font-bold text-blue-300 mb-1 uppercase tracking-wider">Cargo Carried</h5><div class="flex flex-wrap gap-1">' + cr.cargoCarried.map(c => '<span class="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/15">' + c + '</span>').join('') + '</div></div>' : '';
      const ops = cr.operationClassification && cr.operationClassification.length
        ? '<div class="mt-3 pt-3 border-t border-white/5"><h5 class="text-[10px] font-bold text-blue-300 mb-1 uppercase tracking-wider">Operations</h5><div class="flex flex-wrap gap-1">' + cr.operationClassification.map(o => '<span class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/15">' + o + '</span>').join('') + '</div></div>' : '';
      return '<div class="rh-result-card"><div class="flex items-start justify-between mb-2"><div><h4 class="text-white font-bold text-sm">' + (cr.legalName || 'Unknown') + '</h4>' + (cr.dbaName ? '<p class="text-[10px] text-gray-500 mt-0.5">DBA: ' + cr.dbaName + '</p>' : '') + '</div>' + sb + '</div>' +
        (cr.opAuthority ? '<p class="text-[10px] mb-2"><span class="text-gray-500">Authority:</span> <span class="text-white">' + cr.opAuthority + '</span></p>' : '') +
        '<div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs"><div><span class="text-gray-500">USDOT#</span><p class="text-white font-mono font-bold">' + (cr.dotNumber || '—') + '</p></div><div><span class="text-gray-500">MC/MX#</span><p class="text-white font-mono">' + (cr.mcNumber || '—') + '</p></div><div><span class="text-gray-500">Power Units</span><p class="text-white">' + (cr.powerUnits || '—') + '</p></div><div><span class="text-gray-500">Drivers</span><p class="text-white">' + (cr.drivers || '—') + '</p></div><div><span class="text-gray-500">Phone</span><p class="text-white">' + (cr.phone || '—') + '</p></div><div><span class="text-gray-500">Entity</span><p class="text-white">' + (cr.entityType || '—') + '</p></div><div><span class="text-gray-500">Safety Rating</span><p class="text-white">' + (cr.safetyRating || 'None') + '</p></div><div><span class="text-gray-500">MCS-150</span><p class="text-white">' + (cr.mcsDate || '—') + '</p></div></div>' +
        (cr.address ? '<div class="mt-2 pt-2 border-t border-white/5"><p class="text-[10px] text-gray-500">Address</p><p class="text-xs text-white mt-0.5">' + cr.address + '</p></div>' : '') +
        insp + crash + cargo + ops +
        '<div class="mt-3 pt-2 border-t border-white/5"><button onclick="if(window.electronAPI&&window.electronAPI.openExternalUrl)window.electronAPI.openExternalUrl(\'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=' + cr.dotNumber + '\')" class="text-[10px] text-blue-400 hover:text-blue-300 underline transition">View on SAFER ↗</button></div></div>';
    }).join('');
  }

  /* ── Public API (on window for onclick handlers) ──────────── */
  window.toggleResourceHub   = toggle;
  window.openResourceHub     = open;
  window.closeResourceHub    = close;
  window._rhClose            = close;
  window._rhToggleExpand     = toggleExpand;
  window._rhSwitchTab        = switchTab;
  window._rhTraceSearch      = traceSearch;
  window._rhFmcsaSearch      = fmcsaSearch;
  window._rhFmcsaDot         = fmcsaLookupByDot;

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
    injectStyles();
    injectDOM();
    updateFab();

    // Trace type → show/hide state input
    const sel = document.getElementById('rhTraceType');
    if (sel) sel.addEventListener('change', function () {
      const st = document.getElementById('rhTraceState');
      if (st) st.style.display = (this.value === 'plate' || this.value === 'trailer') ? 'block' : 'none';
    });

    // Resize → reposition BV
    window.addEventListener('resize', () => {
      if (!rhOpen) return;
      const res = RESOURCES.find(r => r.id === rhActiveTab);
      if (res && res.isBV) positionBV(rhActiveTab);
    });

    // Settings changes → update FAB + tabs
    window.addEventListener('storage', (e) => {
      if (RESOURCES.some(r => r.enabledKey === e.key)) {
        updateFab();
        if (rhOpen) buildTabBar();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
