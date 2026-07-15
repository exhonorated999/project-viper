/**
 * UC Chat Operations — renderer workspace (vanilla-JS IIFE).
 *
 * Faithful port of ICAC PULSE's React components under
 * src/renderer/components/uc/ (ChatTray, PersonaEditor, AddChatModal,
 * LinkCaseModal, ChatPhotoPanel, PersonaPhotos, UcAlertHost) to VIPER's
 * no-bundler, multi-page HTML stack. Self-injects a FAB (next to the
 * Resource Hub magnifying glass) + a full-height workspace drawer + modals
 * + an alert-toast host on every page that includes this script.
 *
 * Requires: window.electronAPI (preload uc* methods). Cases are read from
 * localStorage['viperCases'] (VIPER's case store) — there is no case IPC.
 *
 * Gating: shown unless localStorage['ucChatEnabled'] === 'false'
 * (opt-out via Settings — Phase 6 wires the toggle UI).
 */
(function () {
  'use strict';

  const API = () => window.electronAPI;
  const ENABLED_KEY = 'ucChatEnabled';

  function enabled() {
    return localStorage.getItem(ENABLED_KEY) !== 'false';
  }

  /* ── Platform catalog (mirrors AddChatModal.PLATFORMS) ────── */
  const PLATFORMS = [
    { id: 'discord',   label: 'Discord',    defaultUrl: 'https://discord.com/app' },
    { id: 'telegram',  label: 'Telegram',   defaultUrl: 'https://web.telegram.org/a/' },
    { id: 'instagram', label: 'Instagram',  defaultUrl: 'https://www.instagram.com/direct/inbox/' },
    { id: 'whatsapp',  label: 'WhatsApp',   defaultUrl: 'https://web.whatsapp.com/' },
    { id: 'snapchat',  label: 'Snapchat',   defaultUrl: 'https://web.snapchat.com/' },
    { id: 'messenger', label: 'Messenger',  defaultUrl: 'https://www.messenger.com/' },
    { id: 'meetme',    label: 'MeetMe',     defaultUrl: 'https://app.meetme.com/get-started/email/login' },
    { id: 'sniffies',  label: 'Sniffies',   defaultUrl: 'https://sniffies.com/' },
    { id: 'custom',    label: 'Custom URL', defaultUrl: '' },
  ];

  /* ── Module state ─────────────────────────────────────────── */
  let S = {
    open: false,
    expanded: false,
    discreet: false,
    personas: [],
    activePersonaId: null,
    chats: [],
    activeChatId: null,
    bannerErr: '',
    capturing: null,        // 'pdf' | 'html' | null
    linkedCase: null,       // resolved case object for active chat
    switcherOpen: false,
  };
  const bvCreated = new Set();
  let bvSuspended = false;  // true while any modal is open
  let rafId = null;
  let alertUnsub = null;

  /* ── Small helpers ────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
    return new Date(iso).toLocaleDateString();
  }
  function loadCases() {
    try { return JSON.parse(localStorage.getItem('viperCases') || '[]') || []; }
    catch (_) { return []; }
  }
  function caseByNumber(num) {
    if (num == null) return null;
    return loadCases().find(c => String(c.caseNumber) === String(num)) || null;
  }

  /* ── CSS ──────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('uc-ops-styles')) return;
    const s = document.createElement('style');
    s.id = 'uc-ops-styles';
    s.textContent = `
      @keyframes ucToastIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes ucFabPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(124,58,237,0.4); } 50% { box-shadow: 0 0 0 6px rgba(124,58,237,0); } }
      #ucChatFab:hover { transform: scale(1.1); box-shadow: 0 0 32px rgba(124,58,237,0.55), 0 0 12px rgba(124,58,237,0.3); }
      #ucChatDrawer * { box-sizing: border-box; }
      #ucChatDrawer .uc-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      #ucChatDrawer .uc-scroll::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.4); border-radius: 4px; }
      #ucChatDrawer .uc-scroll::-webkit-scrollbar-track { background: transparent; }
      .uc-btn { padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid transparent; background: rgba(255,255,255,0.06); color: #d1d5db; transition: background .15s; }
      .uc-btn:hover { background: rgba(255,255,255,0.12); }
      .uc-input { width: 100%; padding: 6px 8px; border-radius: 6px; font-size: 13px; color: #fff; outline: none; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
      .uc-input:focus { border-color: rgba(124,58,237,0.6); }
      .uc-modal-backdrop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); }
      .uc-modal { background: #0F1525; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; }
    `;
    document.head.appendChild(s);
  }

  /* ── DOM skeleton (FAB + drawer + alert host) ─────────────── */
  function injectDOM() {
    if (document.getElementById('ucChatFab')) return;

    // FAB — purple chat bubble, sits left of the Resource Hub FAB (right:24)
    const fab = document.createElement('button');
    fab.id = 'ucChatFab';
    fab.className = 'fixed z-[9998] w-12 h-12 rounded-xl flex items-center justify-center';
    fab.style.cssText = 'bottom:24px;right:84px;display:none;background:rgba(124,58,237,0.15);border:1.5px solid rgba(124,58,237,0.6);color:#a78bfa;backdrop-filter:blur(8px);transition:transform .2s, box-shadow .2s;';
    fab.title = 'UC Chat Operations';
    fab.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
      </svg>
      <span id="ucFabBadge" class="absolute -top-1.5 -right-1.5 rounded-full font-bold flex items-center justify-center border-2"
            style="width:18px;height:18px;font-size:10px;background:#ef4444;color:#fff;border-color:#0B1120;display:none;">0</span>`;
    fab.onclick = toggleTray;
    document.body.appendChild(fab);

    // Drawer
    const drawer = document.createElement('div');
    drawer.id = 'ucChatDrawer';
    drawer.className = 'fixed z-[9997] flex flex-col';
    drawer.style.cssText = 'top:0;right:0;bottom:0;left:100vw;background:#0B1120;overflow:hidden;transition:left .22s ease;';
    document.body.appendChild(drawer);

    // Alert host
    const host = document.createElement('div');
    host.id = 'ucAlertHost';
    host.className = 'fixed z-[9999] flex flex-col gap-2';
    host.style.cssText = 'bottom:96px;right:24px;pointer-events:none;';
    document.body.appendChild(host);
  }

  /* ── Data loaders ─────────────────────────────────────────── */
  async function refreshPersonas() {
    try {
      const list = await API().ucPersonaList();
      S.personas = list || [];
      if (S.personas.length && (S.activePersonaId == null || !S.personas.find(p => p.id === S.activePersonaId))) {
        S.activePersonaId = S.personas[0].id;
      }
    } catch (_) { S.personas = []; }
  }
  async function refreshChats() {
    try {
      S.chats = S.activePersonaId != null
        ? (await API().ucChatList({ personaId: S.activePersonaId })) || []
        : [];
      if (!(S.activeChatId != null && S.chats.find(c => c.id === S.activeChatId))) S.activeChatId = null;
    } catch (_) { S.chats = []; }
  }
  async function resolveLinkedCase() {
    const chat = activeChat();
    S.linkedCase = chat && chat.primary_case_id ? caseByNumber(chat.primary_case_id) : null;
  }

  function activeChat() { return S.chats.find(c => c.id === S.activeChatId) || null; }
  function activePersona() {
    const c = activeChat();
    return S.personas.find(p => p.id === (c ? c.persona_id : S.activePersonaId)) || null;
  }

  /* ── Render ───────────────────────────────────────────────── */
  function updateFab() {
    const fab = document.getElementById('ucChatFab');
    if (!fab) return;
    fab.style.display = enabled() ? 'flex' : 'none';
    const totalUnread = S.chats.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const badge = document.getElementById('ucFabBadge');
    if (badge) {
      if (totalUnread > 0) { badge.style.display = 'flex'; badge.textContent = totalUnread > 9 ? '9+' : String(totalUnread); }
      else badge.style.display = 'none';
    }
  }

  // Right edge (px) of the app's left navigation sidebar, so the drawer stops at the menu.
  function sidebarRightEdge() {
    try {
      const candidates = document.querySelectorAll('.w-64.glass-card, aside, [data-viper-sidebar]');
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.left <= 4 && r.width > 40 && r.width < window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5) {
          return Math.round(r.right);
        }
      }
    } catch (_) {}
    return 0;
  }

  async function renderAll() {
    updateFab();
    const drawer = document.getElementById('ucChatDrawer');
    if (!drawer) return;
    if (!S.open) {
      drawer.style.left = '100vw';
      drawer.style.borderLeft = 'none';
      drawer.innerHTML = '';
      return;
    }
    drawer.style.left = S.expanded ? '0px' : (sidebarRightEdge() + 'px');
    drawer.style.borderLeft = '1px solid rgba(124,58,237,0.3)';

    const persona = activePersona();
    const chat = activeChat();

    drawer.innerHTML = `
      <!-- Header -->
      <div class="flex items-center gap-3 px-4 py-2" style="background:rgba(124,58,237,0.08);border-bottom:1px solid rgba(255,255,255,0.06);">
        <span class="text-sm font-semibold" style="color:#c4b5fd;">UC Chat Operations</span>
        <div id="ucPersonaSwitcher" class="relative"></div>
        <button class="uc-btn" id="ucNewPersonaBtn">+ Persona</button>
        ${persona ? `<button class="uc-btn" id="ucEditPersonaBtn" style="color:#9ca3af;">Edit</button>` : ''}
        <div class="flex-1"></div>
        <button class="uc-btn" id="ucDiscreetBtn" title="Hide alert content from on-screen toasts"
                style="${S.discreet ? 'background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.5);' : ''}">
          ${S.discreet ? '🔒 Discreet ON' : 'Discreet'}
        </button>
        <button class="uc-btn" id="ucExpandBtn">${S.expanded ? '⤡ Shrink' : '⤢ Expand'}</button>
        <button class="uc-btn" id="ucCloseBtn">✕ Close</button>
      </div>
      ${S.bannerErr ? `<div class="px-4 py-1.5 text-xs" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(S.bannerErr)}
        <button id="ucBannerClose" class="ml-2 opacity-60 hover:opacity-100">✕</button></div>` : ''}

      <!-- Body -->
      <div class="flex-1 flex min-h-0">
        <!-- Left: chat dock -->
        <div class="w-64 flex flex-col" style="border-right:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);">
          <div class="px-3 py-2 flex items-center justify-between" style="border-bottom:1px solid rgba(255,255,255,0.06);">
            <span class="text-xs uppercase tracking-wide text-gray-500">Active Chats</span>
            <button id="ucAddChatBtn" class="px-2 py-0.5 rounded text-xs font-medium" style="background:#7c3aed;color:#fff;">+ Chat</button>
          </div>
          <div class="flex-1 overflow-y-auto uc-scroll" id="ucChatDock">${renderChatDock()}</div>
        </div>

        <!-- Center: BV mount + toolbar -->
        <div class="flex-1 flex flex-col min-w-0">
          ${renderLinkedBanner()}
          <div class="px-3 py-1.5 flex items-center gap-2" style="border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);">
            ${chat ? `
              <div class="text-sm text-white">${esc(chat.suspect_handle || '(no handle)')}</div>
              <span class="text-xs text-gray-500">on ${esc(chat.platform)}</span>
              <span class="text-xs text-gray-500">·</span>
              <span class="text-xs text-gray-500">as ${esc(chat.persona_name || '')}</span>
              <div class="flex-1"></div>
              <button class="uc-btn" id="ucReloadBtn">↩ Reload</button>
              <button class="uc-btn" id="ucLinkCaseBtn">🔗 Link Case</button>
              <button class="uc-btn" id="ucPdfBtn">${S.capturing === 'pdf' ? '…' : '📄 PDF'}</button>
              <button class="uc-btn" id="ucHtmlBtn">${S.capturing === 'html' ? '…' : '🗎 HTML'}</button>
              <button class="uc-btn" id="ucArchiveBtn">🗄 Archive</button>
            ` : `<span class="text-sm text-gray-500">Select a chat from the dock — or create one with + Chat.</span>`}
          </div>
          <div id="ucBvMount" class="flex-1 relative" style="background:#000;">
            ${!chat ? `<div class="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">No active chat. Pick one from the dock.</div>` : ''}
          </div>
        </div>

        <!-- Right: cheat sheet + photos -->
        ${persona ? `
        <div class="w-72 flex flex-col" style="border-left:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);">
          <div class="px-3 py-2" style="border-bottom:1px solid rgba(255,255,255,0.06);">
            <span class="text-xs uppercase tracking-wide text-gray-500">Persona Cheat Sheet</span>
          </div>
          <div class="flex-1 overflow-y-auto uc-scroll p-3 space-y-3 text-sm">
            ${cheatRow('Name', persona.display_name)}
            ${cheatRow('Displayed Age', persona.displayed_age ?? '—')}
            ${cheatRow('Gender', persona.gender || '—')}
            ${cheatRow('Hometown', persona.hometown || '—')}
            ${cheatRow('Bio', persona.bio || '—', true)}
            ${cheatRow('Backstory', persona.backstory || '—', true)}
            ${persona.notes ? `<div class="mt-3 p-2 rounded text-xs" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:#fcd34d;">
              <div class="text-[10px] uppercase mb-1 opacity-70">Officer Notes</div>${esc(persona.notes)}</div>` : ''}
          </div>
          <div id="ucPhotoPanel" style="border-top:1px solid rgba(255,255,255,0.06);"></div>
        </div>` : ''}
      </div>
    `;

    // Wire header
    byId('ucNewPersonaBtn', b => b.onclick = () => openPersonaEditor(null));
    byId('ucEditPersonaBtn', b => b.onclick = () => openPersonaEditor(activePersona()));
    byId('ucDiscreetBtn', b => b.onclick = toggleDiscreet);
    byId('ucExpandBtn', b => b.onclick = () => { S.expanded = !S.expanded; renderAll(); });
    byId('ucCloseBtn', b => b.onclick = () => { S.open = false; stopRaf(); renderAll(); });
    byId('ucBannerClose', b => b.onclick = () => { S.bannerErr = ''; renderAll(); });
    byId('ucAddChatBtn', b => b.onclick = openAddChat);
    byId('ucReloadBtn', b => b.onclick = onReload);
    byId('ucLinkCaseBtn', b => b.onclick = openLinkCase);
    byId('ucChangeCaseBtn', b => b.onclick = openLinkCase);
    byId('ucPdfBtn', b => b.onclick = () => onCapture('pdf'));
    byId('ucHtmlBtn', b => b.onclick = () => onCapture('html'));
    byId('ucArchiveBtn', b => b.onclick = onArchiveActive);

    renderPersonaSwitcher();
    wireChatDock();
    if (persona) renderPhotoPanel(persona.id, S.activeChatId);
  }

  function cheatRow(label, value, multiline) {
    return `<div>
      <div class="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">${esc(label)}</div>
      <div class="${multiline ? 'text-xs text-gray-200 whitespace-pre-wrap' : 'text-sm text-gray-200'}">${esc(value)}</div>
    </div>`;
  }

  function renderLinkedBanner() {
    const chat = activeChat();
    if (!chat || !S.linkedCase) return '';
    const lc = S.linkedCase;
    return `<div class="px-3 py-1.5 flex items-center gap-2 text-xs" style="background:rgba(34,197,94,0.10);border-bottom:1px solid rgba(34,197,94,0.25);color:#bbf7d0;">
      <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
      <span class="font-semibold tracking-wide">Case #${esc(lc.caseNumber)}</span>
      ${lc.synopsis ? `<span class="opacity-60">·</span><span class="truncate" style="color:#dcfce7;">${esc(lc.synopsis)}</span>` : ''}
      ${lc.status ? `<span class="opacity-60">·</span><span class="uppercase opacity-80">${esc(lc.status)}</span>` : ''}
      <div class="flex-1"></div>
      <button id="ucChangeCaseBtn" class="px-2 py-0.5 rounded text-[10px] font-medium" style="background:rgba(34,197,94,0.18);color:#86efac;border:1px solid rgba(34,197,94,0.35);" title="Change linked case">Change</button>
    </div>`;
  }

  function renderChatDock() {
    if (!S.chats.length) {
      return `<div class="p-4 text-xs text-gray-500 text-center">No active chats. Click <span style="color:#a78bfa;">+ Chat</span> to start one.</div>`;
    }
    return S.chats.map(c => {
      const active = c.id === S.activeChatId;
      return `<button data-chat-id="${c.id}" class="uc-dock-item w-full px-3 py-2 text-left flex items-start gap-2"
        style="background:${active ? 'rgba(124,58,237,0.15)' : 'transparent'};border-left:${active ? '3px solid #a78bfa' : '3px solid transparent'};">
        <div class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold uppercase shrink-0" style="background:rgba(124,58,237,0.3);color:#c4b5fd;">${esc((c.persona_name || '?').slice(0,2))}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-gray-500 uppercase">${esc(c.platform)}</span>
            ${c.unread_count > 0 ? `<span class="rounded-full px-1.5 text-[10px] font-bold" style="background:#ef4444;color:#fff;min-width:16px;text-align:center;">${c.unread_count > 9 ? '9+' : c.unread_count}</span>` : ''}
            ${c.primary_case_id ? `<span class="text-[10px] px-1 rounded" style="background:rgba(34,197,94,0.15);color:#86efac;">Case #${esc(c.primary_case_id)}</span>` : ''}
          </div>
          <div class="text-sm text-white truncate">${esc(c.suspect_handle || c.suspect_display_name || '(no handle)')}</div>
          <div class="text-[11px] text-gray-500 truncate">${esc(c.persona_name || '')}</div>
        </div>
      </button>`;
    }).join('');
  }
  function wireChatDock() {
    const dock = document.getElementById('ucChatDock');
    if (!dock) return;
    dock.querySelectorAll('.uc-dock-item').forEach(el => {
      el.onclick = () => switchToChat(parseInt(el.getAttribute('data-chat-id'), 10));
    });
  }

  /* ── Persona switcher (custom dropdown) ───────────────────── */
  function renderPersonaSwitcher() {
    const wrap = document.getElementById('ucPersonaSwitcher');
    if (!wrap) return;
    const active = S.personas.find(p => p.id === S.activePersonaId) || null;
    const label = active ? active.display_name : (S.personas.length === 0 ? '(no personas)' : 'Select persona');
    wrap.innerHTML = `
      <button type="button" id="ucSwitcherBtn" class="px-2 py-1 rounded text-xs text-white outline-none flex items-center gap-1.5 min-w-[110px]" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);">
        <span class="flex-1 text-left truncate">${esc(label)}</span>
        <svg class="w-3 h-3 transition-transform ${S.switcherOpen ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
      </button>
      ${S.switcherOpen ? `<div class="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-md shadow-xl overflow-hidden" style="background:#1B1C20;border:1px solid rgba(124,58,237,0.4);box-shadow:0 8px 24px rgba(0,0,0,0.6);">
        ${S.personas.length === 0 ? `<div class="px-3 py-2 text-xs text-gray-500 italic">No personas yet</div>` : `<ul class="max-h-64 overflow-y-auto uc-scroll py-1">${S.personas.map(p => {
          const isA = p.id === S.activePersonaId;
          return `<li><button type="button" data-persona-id="${p.id}" class="uc-switch-item w-full text-left px-3 py-1.5 text-xs flex items-center gap-2" style="background:${isA ? 'rgba(124,58,237,0.20)' : 'transparent'};color:${isA ? '#c4b5fd' : '#e5e7eb'};">
            ${isA ? '<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ''}
            <span class="${isA ? '' : 'ml-5'}">${esc(p.display_name)}</span></button></li>`;
        }).join('')}</ul>`}
      </div>` : ''}`;
    byId('ucSwitcherBtn', b => b.onclick = (e) => { e.stopPropagation(); S.switcherOpen = !S.switcherOpen; renderPersonaSwitcher(); });
    wrap.querySelectorAll('.uc-switch-item').forEach(el => {
      el.onclick = async () => {
        S.activePersonaId = parseInt(el.getAttribute('data-persona-id'), 10);
        S.switcherOpen = false;
        await refreshChats();
        await resolveLinkedCase();
        renderAll();
      };
    });
  }

  /* ── Right-rail photo panel (ChatPhotoPanel) ──────────────── */
  let photoPanelOpen = true;
  async function renderPhotoPanel(personaId, chatId) {
    const host = document.getElementById('ucPhotoPanel');
    if (!host || !personaId) return;
    let photos = [];
    try { photos = (await API().ucPhotoList(personaId, false)) || []; } catch (_) {}
    const usedInChat = new Set();
    if (chatId) {
      await Promise.all(photos.map(async p => {
        try { const uses = await API().ucPhotoUses(p.id); if ((uses || []).some(u => u.chat_id === chatId)) usedInChat.add(p.id); } catch (_) {}
      }));
    }
    host.innerHTML = `
      <button id="ucPhotoPanelToggle" class="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-white/5">
        <span class="text-xs uppercase tracking-wide text-gray-500">Persona Photos ${photos.length ? `<span class="text-gray-600">(${photos.length})</span>` : ''}</span>
        <span class="text-xs text-gray-500">${photoPanelOpen ? '▾' : '▸'}</span>
      </button>
      ${photoPanelOpen ? `<div class="px-3 pb-3">
        ${photos.length === 0 ? `<div class="text-[11px] text-gray-600 italic text-center py-3">No photos. Add photos from the persona editor.</div>`
        : `<div class="grid grid-cols-3 gap-1.5">${photos.map(p => {
            const usedHere = usedInChat.has(p.id);
            const usedElsewhere = (p.use_count || 0) > 0 && !usedHere;
            const title = !chatId ? 'Open a chat to copy photos' : (usedHere ? 'Already sent in this chat — copy again' : `Click to copy${p.caption ? ' — ' + p.caption : ''}`);
            return `<button data-photo-id="${p.id}" class="uc-copy-photo relative rounded overflow-hidden group" ${chatId ? '' : 'disabled'} title="${esc(title)}"
              style="background:#000;border:${usedHere ? '1px solid rgba(34,197,94,0.6)' : '1px solid rgba(255,255,255,0.08)'};${chatId ? '' : 'opacity:.6;cursor:default;'}">
              <div class="aspect-square w-full">${p.src_url ? `<img src="${esc(p.src_url)}" alt="${esc(p.caption || '')}" class="w-full h-full object-cover" draggable="false">` : `<div class="w-full h-full flex items-center justify-center text-[9px] text-gray-700">—</div>`}</div>
              ${usedHere ? `<div class="absolute top-0.5 left-0.5 px-1 py-0.5 rounded text-[9px] font-bold" style="background:rgba(34,197,94,0.9);color:#fff;">SENT</div>` : ''}
              ${usedElsewhere ? `<div class="absolute top-0.5 left-0.5 px-1 py-0.5 rounded text-[9px]" style="background:rgba(245,158,11,0.85);color:#fff;" title="last used ${relTime(p.last_used_at)} ago">${p.use_count}×</div>` : ''}
              <div class="absolute inset-0 flex items-end opacity-0 group-hover:opacity-100 transition" style="background:linear-gradient(to top, rgba(0,0,0,0.85), transparent 60%);"><span class="text-[10px] text-white px-1.5 py-1 font-medium">📋 Copy</span></div>
            </button>`;
          }).join('')}</div>
          ${!chatId ? `<div class="mt-2 text-[10px] text-gray-600 italic">Open a chat to enable copy (every copy is logged for evidence).</div>` : ''}`}
      </div>` : ''}`;
    byId('ucPhotoPanelToggle', b => b.onclick = () => { photoPanelOpen = !photoPanelOpen; renderPhotoPanel(personaId, chatId); });
    host.querySelectorAll('.uc-copy-photo').forEach(el => {
      el.onclick = async () => {
        if (!chatId) { toast('Open a chat first — every copy is recorded for the evidence trail.', 'warning'); return; }
        const id = parseInt(el.getAttribute('data-photo-id'), 10);
        try {
          await API().ucPhotoCopyToClipboard(id, chatId);
          toast('📋 Copied — paste into chat now', 'success');
          renderPhotoPanel(personaId, chatId);
        } catch (e) { toast('Copy failed: ' + (e && e.message || e), 'error'); }
      };
    });
  }

  /* ── BV positioning ───────────────────────────────────────── */
  function positionActiveBV() {
    if (!S.activeChatId) return;
    const el = document.getElementById('ucBvMount');
    if (!el || !API()) return;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    // viper-prefs.js applies CSS `zoom` on <body> for font scaling. In
    // Chromium, getBoundingClientRect returns layout-pixel (pre-zoom)
    // coordinates while BrowserView.setBounds expects the window's CSS
    // pixels (the post-zoom space the user sees). Multiply by the live body
    // zoom so the embedded platform view fills the pane at any font scale.
    let z = 1;
    try {
      const cz = parseFloat(getComputedStyle(document.body).zoom);
      if (cz && !Number.isNaN(cz) && cz > 0) z = cz;
    } catch (_) { /* ignore */ }
    API().ucChatBvSetBounds(S.activeChatId, {
      x: Math.round(r.x * z),
      y: Math.round(r.y * z),
      width: Math.round(r.width * z),
      height: Math.round(r.height * z),
    });
    API().ucChatBvSetVisible(S.activeChatId, true);
  }
  function shouldShowBV() { return S.open && !!S.activeChatId && !bvSuspended; }
  function startRaf() {
    stopRaf();
    if (!shouldShowBV()) return;
    const tick = () => { if (!shouldShowBV()) { rafId = null; return; } positionActiveBV(); rafId = requestAnimationFrame(tick); };
    tick();
  }
  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (S.activeChatId && API()) { try { API().ucChatBvSetVisible(S.activeChatId, false); } catch (_) {} }
  }
  function syncBV() { if (shouldShowBV()) startRaf(); else stopRaf(); }

  /* ── Switch active chat ───────────────────────────────────── */
  async function switchToChat(chatId) {
    const chat = S.chats.find(c => c.id === chatId);
    if (!chat) return;
    if (S.activeChatId && S.activeChatId !== chatId) { try { API().ucChatBvSetVisible(S.activeChatId, false); } catch (_) {} }
    S.activeChatId = chatId;
    if (!bvCreated.has(chatId)) {
      bvCreated.add(chatId);
      try { await API().ucChatBvCreate(chatId, chat.persona_id, chat.platform_url || ''); }
      catch (e) { S.bannerErr = `Failed to open chat: ${e && e.message || e}`; }
    }
    try { await API().ucChatMarkRead(chatId); } catch (_) {}
    await refreshChats();
    await resolveLinkedCase();
    await renderAll();
    syncBV();
  }

  /* ── Toolbar actions ──────────────────────────────────────── */
  function toggleTray() {
    S.open = !S.open;
    if (S.open) {
      window.dispatchEvent(new CustomEvent('pulse:tray-open', { detail: { tray: 'uc-chat' } }));
      Promise.resolve().then(async () => { await refreshPersonas(); await refreshChats(); await resolveLinkedCase(); await renderAll(); syncBV(); });
    } else { stopRaf(); renderAll(); }
  }
  async function toggleDiscreet() {
    try { S.discreet = await API().ucDiscreetModeSet(!S.discreet); } catch (_) {}
    renderAll();
  }
  function onReload() { if (S.activeChatId) API().ucChatBvReload(S.activeChatId); }
  async function onCapture(kind) {
    S.bannerErr = '';
    if (!S.activeChatId) { S.bannerErr = 'No active chat — open one first.'; renderAll(); return; }
    S.capturing = kind; renderAll();
    try {
      const fn = kind === 'pdf' ? API().ucChatCapturePdf : API().ucChatCaptureHtml;
      if (typeof fn !== 'function') { S.bannerErr = `${kind.toUpperCase()} capture not available yet.`; }
      else {
        const res = await fn(S.activeChatId);
        if (!res || !res.success) S.bannerErr = (res && res.error) || `${kind.toUpperCase()} capture failed`;
        else toast(`${kind.toUpperCase()} captured to evidence`, 'success');
      }
    } catch (e) { S.bannerErr = e && e.message || String(e); }
    finally { S.capturing = null; renderAll(); }
  }
  async function onArchiveActive() {
    if (!S.activeChatId) return;
    const ok = typeof window.viperConfirm === 'function'
      ? await window.viperConfirm('Archive this chat? (preserves history & evidence trail; can be unarchived later)')
      : confirm('Archive this chat?');
    if (!ok) return;
    try {
      await API().ucChatArchive(S.activeChatId);
      API().ucChatBvDestroy(S.activeChatId);
      bvCreated.delete(S.activeChatId);
      S.activeChatId = null;
      await refreshChats(); await resolveLinkedCase(); await renderAll(); syncBV();
    } catch (e) { S.bannerErr = e && e.message || String(e); renderAll(); }
  }

  /* ── Modal helpers ────────────────────────────────────────── */
  function openModal(node) {
    bvSuspended = true; syncBV();
    document.body.appendChild(node);
    setTimeout(() => { try { node.focus(); } catch (_) {} }, 0);
  }
  function closeModal(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    bvSuspended = false; syncBV();
  }

  /* ── PersonaEditor modal ──────────────────────────────────── */
  function openPersonaEditor(persona) {
    const isNew = !(persona && persona.id);
    const f = Object.assign({ display_name: '', real_age: null, displayed_age: null, gender: '', hometown: '', bio: '', backstory: '', notes: '' }, persona || {});
    const back = document.createElement('div');
    back.className = 'uc-modal-backdrop';
    back.tabIndex = -1;
    back.onclick = (e) => { if (e.target === back) closeModal(back); };
    back.innerHTML = `
      <div class="uc-modal p-6 w-[560px] max-w-[95vw] max-h-[90vh] overflow-y-auto uc-scroll" onclick="event.stopPropagation()">
        <h2 class="text-lg font-semibold mb-4 text-white">${isNew ? 'New UC Persona' : 'Edit Persona: ' + esc(persona.display_name)}</h2>
        <div id="ucPeErr"></div>
        <div class="space-y-3">
          <label class="block"><span class="text-xs text-gray-400 mb-1 block">Display Name *</span><input id="pe_display_name" class="uc-input" value="${esc(f.display_name)}"></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Real Age (officer)</span><input id="pe_real_age" type="number" class="uc-input" value="${f.real_age ?? ''}"></label>
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Displayed Age (persona)</span><input id="pe_displayed_age" type="number" class="uc-input" value="${f.displayed_age ?? ''}"></label>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Gender</span><input id="pe_gender" class="uc-input" value="${esc(f.gender)}"></label>
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Hometown</span><input id="pe_hometown" class="uc-input" value="${esc(f.hometown)}"></label>
          </div>
          <label class="block"><span class="text-xs text-gray-400 mb-1 block">Bio (short)</span><input id="pe_bio" class="uc-input" value="${esc(f.bio)}"></label>
          <label class="block"><span class="text-xs text-gray-400 mb-1 block">Backstory (used as cheat-sheet)</span><textarea id="pe_backstory" class="uc-input resize-y" rows="4">${esc(f.backstory)}</textarea></label>
          <label class="block"><span class="text-xs text-gray-400 mb-1 block">Officer Notes (private)</span><textarea id="pe_notes" class="uc-input resize-y" rows="2">${esc(f.notes)}</textarea></label>
          ${isNew ? `<div class="text-xs text-gray-500 italic px-1 py-2 rounded" style="background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.06);">Save the persona first to add a photo library.</div>` : `<div id="ucPePhotos"></div>`}
        </div>
        <div class="flex justify-end gap-2 mt-5">
          <button class="uc-btn" id="ucPeCancel">Cancel</button>
          <button class="px-3 py-1.5 rounded text-sm font-medium" style="background:#7c3aed;color:#fff;" id="ucPeSave">${isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>`;
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(back); });
    openModal(back);
    if (!isNew) renderPersonaPhotosSection(persona.id, back.querySelector('#ucPePhotos'));

    const err = (m) => { const d = back.querySelector('#ucPeErr'); d.innerHTML = m ? `<div class="mb-3 p-2 rounded text-sm" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(m)}</div>` : ''; };
    back.querySelector('#ucPeCancel').onclick = () => closeModal(back);
    back.querySelector('#ucPeSave').onclick = async () => {
      const val = (id) => back.querySelector('#' + id).value;
      const num = (id) => { const v = val(id); return v ? parseInt(v, 10) : null; };
      const form = {
        display_name: val('pe_display_name').trim(),
        real_age: num('pe_real_age'), displayed_age: num('pe_displayed_age'),
        gender: val('pe_gender'), hometown: val('pe_hometown'),
        bio: val('pe_bio'), backstory: val('pe_backstory'), notes: val('pe_notes'),
      };
      if (!form.display_name) { err('Display name is required.'); return; }
      try {
        if (isNew) await API().ucPersonaCreate(form);
        else await API().ucPersonaUpdate(persona.id, form);
        await refreshPersonas(); await renderAll();
        closeModal(back);
      } catch (e) { err(e && e.message || String(e)); }
    };
  }

  /* ── PersonaPhotos section (inside editor) ────────────────── */
  async function renderPersonaPhotosSection(personaId, host) {
    if (!host) return;
    let photos = [];
    try { photos = (await API().ucPhotoList(personaId, false)) || []; } catch (_) {}
    host.innerHTML = `
      <div class="mt-2">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-gray-400">Photos ${photos.length ? `<span class="text-gray-500">(${photos.length})</span>` : ''}</span>
          <button id="ucPpAdd" class="px-2 py-1 rounded text-xs font-medium" style="background:rgba(124,58,237,0.2);color:#c4b5fd;border:1px solid rgba(124,58,237,0.35);">+ Add Photos</button>
        </div>
        <div id="ucPpErr"></div>
        <div id="ucPpProgress"></div>
        ${photos.length === 0 ? `<div class="text-xs text-gray-500 py-4 text-center rounded" style="background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.08);">No photos yet. Click <strong>+ Add Photos</strong> to import images for this persona.<br><span class="text-[10px] text-gray-600">EXIF metadata is stripped on import.</span></div>`
        : `<div class="grid grid-cols-3 gap-2">${photos.map(p => `
          <div class="rounded overflow-hidden relative group" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);">
            <div class="relative aspect-square overflow-hidden" style="background:#000;">
              ${p.src_url ? `<img src="${esc(p.src_url)}" alt="${esc(p.caption || '')}" class="w-full h-full object-cover" draggable="false">` : `<div class="w-full h-full flex items-center justify-center text-[10px] text-gray-600">no preview</div>`}
              ${(p.use_count || 0) > 0 ? `<div class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px]" style="background:rgba(34,197,94,0.85);color:#fff;">used ${p.use_count}×</div>` : ''}
              <button data-archive="${p.id}" class="uc-pp-archive absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 transition" style="background:rgba(239,68,68,0.85);color:#fff;" title="Archive photo">×</button>
            </div>
            <div class="px-1.5 py-1">
              <button data-caption="${p.id}" class="uc-pp-caption w-full text-left text-[11px] text-gray-400 hover:text-white truncate" title="${esc(p.caption || 'click to add caption')}">${p.caption ? esc(p.caption) : '<span class="text-gray-600 italic">add caption…</span>'}</button>
              ${p.last_used_at ? `<div class="text-[10px] text-gray-600 truncate">${p.last_used_chat_id ? `→ Chat #${p.last_used_chat_id} · ` : ''}${relTime(p.last_used_at)} ago</div>` : ''}
            </div>
          </div>`).join('')}</div>`}
      </div>`;
    const errBox = host.querySelector('#ucPpErr');
    const setErr = (m) => { errBox.innerHTML = m ? `<div class="mb-2 p-2 rounded text-xs" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(m)}</div>` : ''; };
    host.querySelector('#ucPpAdd').onclick = async () => {
      setErr('');
      const prog = host.querySelector('#ucPpProgress');
      try {
        const picked = await API().ucPhotoPickFiles();
        if (!picked || !picked.length) return;
        let done = 0; const failures = [];
        for (const file of picked) {
          prog.innerHTML = `<div class="mb-2 p-2 rounded" style="background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.3);"><div class="text-xs" style="color:#c4b5fd;">Importing ${done + 1} of ${picked.length}… <span class="text-gray-500">${esc(file.name)}</span></div></div>`;
          try { await API().ucPhotoAdd(personaId, file.path); }
          catch (e) { failures.push(file.name); }
          done++;
          window.dispatchEvent(new CustomEvent('pulse:persona-photos-changed', { detail: { personaId } }));
        }
        prog.innerHTML = '';
        if (failures.length) setErr(`${failures.length} file(s) failed: ${failures.join(', ')}`);
        await renderPersonaPhotosSection(personaId, host);
      } catch (e) { setErr(e && e.message || String(e)); }
    };
    host.querySelectorAll('.uc-pp-archive').forEach(el => {
      el.onclick = async () => {
        const ok = typeof window.viperConfirm === 'function'
          ? await window.viperConfirm('Remove this photo from the persona library? (It will be archived — evidence trail preserved.)')
          : confirm('Archive this photo?');
        if (!ok) return;
        try { await API().ucPhotoArchive(parseInt(el.getAttribute('data-archive'), 10)); window.dispatchEvent(new CustomEvent('pulse:persona-photos-changed', { detail: { personaId } })); await renderPersonaPhotosSection(personaId, host); }
        catch (e) { setErr(e && e.message || String(e)); }
      };
    });
    host.querySelectorAll('.uc-pp-caption').forEach(el => {
      el.onclick = async () => {
        const id = parseInt(el.getAttribute('data-caption'), 10);
        const p = photos.find(x => x.id === id);
        const next = prompt('Caption:', (p && p.caption) || '');
        if (next === null) return;
        try { await API().ucPhotoUpdate(id, { caption: next }); window.dispatchEvent(new CustomEvent('pulse:persona-photos-changed', { detail: { personaId } })); await renderPersonaPhotosSection(personaId, host); }
        catch (e) { setErr(e && e.message || String(e)); }
      };
    });
  }

  /* ── AddChatModal ─────────────────────────────────────────── */
  function openAddChat() {
    let personaId = S.activePersonaId ?? (S.personas[0] && S.personas[0].id) ?? null;
    let platform = 'discord';
    let url = PLATFORMS[0].defaultUrl;
    const back = document.createElement('div');
    back.className = 'uc-modal-backdrop';
    back.tabIndex = -1;
    back.onclick = (e) => { if (e.target === back) closeModal(back); };
    const render = () => {
      back.innerHTML = `
        <div class="uc-modal p-6 w-[520px] max-w-[95vw]" onclick="event.stopPropagation()">
          <h2 class="text-lg font-semibold mb-4 text-white">New UC Chat</h2>
          <div id="ucAcErr"></div>
          <div class="space-y-3">
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Persona</span>
              <select id="ac_persona" class="uc-input">
                ${S.personas.length === 0 ? '<option value="">(no personas — create one first)</option>' : ''}
                ${S.personas.map(p => `<option value="${p.id}" ${p.id === personaId ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
              </select></label>
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Platform</span>
              <div class="grid grid-cols-4 gap-2">${PLATFORMS.map(p => `<button data-plat="${p.id}" class="uc-plat px-2 py-2 rounded text-xs" style="background:${platform === p.id ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.04)'};border:${platform === p.id ? '1px solid rgba(124,58,237,0.6)' : '1px solid rgba(255,255,255,0.08)'};color:${platform === p.id ? '#c4b5fd' : '#9ca3af'};">${esc(p.label)}</button>`).join('')}</div></label>
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">URL</span><input id="ac_url" class="uc-input" value="${esc(url)}" placeholder="https://..."></label>
            <div class="grid grid-cols-2 gap-3">
              <label class="block"><span class="text-xs text-gray-400 mb-1 block">Suspect Handle</span><input id="ac_handle" class="uc-input" placeholder="@predator123"></label>
              <label class="block"><span class="text-xs text-gray-400 mb-1 block">Display Name</span><input id="ac_display" class="uc-input"></label>
            </div>
            <label class="block"><span class="text-xs text-gray-400 mb-1 block">Notes</span><textarea id="ac_notes" class="uc-input resize-y" rows="2"></textarea></label>
          </div>
          <div class="flex justify-end gap-2 mt-5">
            <button class="uc-btn" id="ucAcCancel">Cancel</button>
            <button class="px-3 py-1.5 rounded text-sm font-medium" style="background:#7c3aed;color:#fff;" id="ucAcCreate">Create Chat</button>
          </div>
        </div>`;
      back.querySelector('#ac_persona').onchange = (e) => { personaId = parseInt(e.target.value, 10) || null; };
      back.querySelectorAll('.uc-plat').forEach(el => el.onclick = () => {
        platform = el.getAttribute('data-plat');
        const p = PLATFORMS.find(x => x.id === platform);
        url = p && p.id !== 'custom' ? p.defaultUrl : '';
        // preserve current field values before re-render
        const cur = { handle: back.querySelector('#ac_handle').value, display: back.querySelector('#ac_display').value, notes: back.querySelector('#ac_notes').value };
        render();
        back.querySelector('#ac_handle').value = cur.handle;
        back.querySelector('#ac_display').value = cur.display;
        back.querySelector('#ac_notes').value = cur.notes;
      });
      back.querySelector('#ucAcCancel').onclick = () => closeModal(back);
      back.querySelector('#ucAcCreate').onclick = create;
    };
    const setErr = (m) => { const d = back.querySelector('#ucAcErr'); if (d) d.innerHTML = m ? `<div class="mb-3 p-2 rounded text-sm" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(m)}</div>` : ''; };
    const create = async () => {
      url = back.querySelector('#ac_url').value;
      if (!personaId) { setErr('Pick a persona first (create one if you have none).'); return; }
      if (platform === 'custom' && !url.trim()) { setErr('Enter a URL for custom platform.'); return; }
      try {
        const chat = await API().ucChatCreate({
          persona_id: personaId, platform, platform_url: url || null,
          suspect_handle: back.querySelector('#ac_handle').value || null,
          suspect_display_name: back.querySelector('#ac_display').value || null,
          notes: back.querySelector('#ac_notes').value || null,
        });
        closeModal(back);
        await refreshChats(); await renderAll();
        if (chat && chat.id) switchToChat(chat.id);
      } catch (e) { setErr(e && e.message || String(e)); }
    };
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(back); });
    render();
    openModal(back);
  }

  /* ── LinkCaseModal (VIPER cases from localStorage) ────────── */
  function openLinkCase() {
    if (!S.activeChatId) return;
    const chatId = S.activeChatId;
    let links = [];
    let showCreate = false;
    const back = document.createElement('div');
    back.className = 'uc-modal-backdrop';
    back.tabIndex = -1;
    back.onclick = (e) => { if (e.target === back) closeModal(back); };

    const isLinked = (num) => links.find(l => String(l.case_id) === String(num));
    const isPrimary = (num) => { const l = isLinked(num); return l && l.role === 'primary'; };

    const render = () => {
      const cases = loadCases();
      back.innerHTML = `
        <div class="uc-modal p-6 w-[640px] max-w-[95vw] max-h-[80vh] flex flex-col" onclick="event.stopPropagation()">
          <h2 class="text-lg font-semibold mb-1 text-white">Link Cases to Chat</h2>
          <p class="text-xs text-gray-400 mb-3">The <span style="color:#a78bfa;">primary</span> case is the default target for 1-button evidence saves. A chat can have one primary and any number of secondary case tags.</p>
          <div id="ucLcErr"></div>
          <div class="mb-3">
            ${!showCreate ? `<button id="ucLcNewToggle" class="px-3 py-1.5 rounded text-xs font-medium" style="background:rgba(34,197,94,0.15);color:#86efac;border:1px solid rgba(34,197,94,0.3);">+ New Chat Case</button>`
            : `<div class="p-2.5 rounded flex items-center gap-2" style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.25);">
                <span class="text-xs text-gray-300 whitespace-nowrap">Case #</span>
                <input id="ucLcNewNum" class="uc-input flex-1" placeholder="e.g. 26-7240">
                <button id="ucLcCreate" class="px-3 py-1 rounded text-xs font-medium" style="background:#22c55e;color:#062712;">Create & Link</button>
              </div>`}
          </div>
          <div class="flex-1 overflow-y-auto uc-scroll" style="min-height:0;">
            ${cases.length === 0 ? `<div class="text-xs text-gray-500 italic text-center py-6">No cases yet. Use “+ New Chat Case” to create one.</div>`
            : cases.map(c => {
              const linked = isLinked(c.caseNumber); const primary = isPrimary(c.caseNumber);
              return `<div class="flex items-center justify-between p-2 rounded mb-1.5" style="background:${linked ? 'rgba(124,58,237,0.08)' : 'rgba(255,255,255,0.03)'};border:${linked ? '1px solid rgba(124,58,237,0.3)' : '1px solid rgba(255,255,255,0.06)'};">
                <div class="text-sm"><div class="text-white font-medium">${esc(c.caseNumber || ('Case ' + c.id))}</div><div class="text-xs text-gray-400">${esc(c.synopsis || '')}</div></div>
                <div class="flex gap-1">
                  ${!linked ? `<button data-link="${esc(c.caseNumber)}" data-role="primary" class="uc-lc-link px-2 py-1 rounded text-xs" style="background:#7c3aed;color:#fff;">Primary</button>
                    <button data-link="${esc(c.caseNumber)}" data-role="secondary" class="uc-lc-link px-2 py-1 rounded text-xs" style="background:rgba(255,255,255,0.06);color:#d1d5db;">Secondary</button>` : ''}
                  ${linked && !primary ? `<button data-link="${esc(c.caseNumber)}" data-role="primary" class="uc-lc-link px-2 py-1 rounded text-xs" style="background:rgba(124,58,237,0.4);color:#fff;">Make Primary</button>` : ''}
                  ${linked ? `<span class="px-2 py-1 rounded text-xs" style="background:${primary ? '#7c3aed' : 'rgba(255,255,255,0.06)'};color:${primary ? '#fff' : '#9ca3af'};">${primary ? '★ Primary' : 'Secondary'}</span>
                    <button data-unlink="${esc(c.caseNumber)}" class="uc-lc-unlink px-2 py-1 rounded text-xs" style="background:rgba(239,68,68,0.15);color:#fca5a5;">Unlink</button>` : ''}
                </div>
              </div>`;
            }).join('')}
          </div>
          <div class="flex justify-end mt-4"><button id="ucLcDone" class="px-3 py-1.5 rounded text-sm" style="background:#7c3aed;color:#fff;">Done</button></div>
        </div>`;
      const setErr = (m) => { const d = back.querySelector('#ucLcErr'); if (d) d.innerHTML = m ? `<div class="mb-3 p-2 rounded text-sm" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(m)}</div>` : ''; };
      byIn(back, '#ucLcNewToggle', b => b.onclick = () => { showCreate = true; render(); setTimeout(() => { const i = back.querySelector('#ucLcNewNum'); if (i) i.focus(); }, 0); });
      byIn(back, '#ucLcDone', b => b.onclick = async () => { closeModal(back); await refreshChats(); await resolveLinkedCase(); await renderAll(); });
      byIn(back, '#ucLcCreate', b => b.onclick = createAndLink);
      byIn(back, '#ucLcNewNum', i => i.onkeydown = (e) => { if (e.key === 'Enter') createAndLink(); if (e.key === 'Escape') { showCreate = false; render(); } });
      back.querySelectorAll('.uc-lc-link').forEach(el => el.onclick = async () => {
        try { links = await API().ucChatLinkCase(chatId, el.getAttribute('data-link'), el.getAttribute('data-role')); render(); }
        catch (e) { setErr(e && e.message || String(e)); }
      });
      back.querySelectorAll('.uc-lc-unlink').forEach(el => el.onclick = async () => {
        try { links = await API().ucChatUnlinkCase(chatId, el.getAttribute('data-unlink')); render(); }
        catch (e) { setErr(e && e.message || String(e)); }
      });
    };
    const createAndLink = async () => {
      const input = back.querySelector('#ucLcNewNum');
      const num = (input && input.value || '').trim();
      const setErr = (m) => { const d = back.querySelector('#ucLcErr'); if (d) d.innerHTML = m ? `<div class="mb-3 p-2 rounded text-sm" style="background:rgba(239,68,68,0.15);color:#fca5a5;">${esc(m)}</div>` : ''; };
      if (!num) { setErr('Case number is required'); return; }
      const cases = loadCases();
      if (!cases.find(c => String(c.caseNumber) === num)) {
        const newCase = {
          id: Date.now(), caseNumber: num, synopsis: '', status: 'active', priority: 0,
          modules: ['suspect', 'warrants', 'report'], tabOrder: ['overview', 'suspect', 'warrants', 'report'],
          createdAt: new Date().toISOString(),
          createdBy: localStorage.getItem('viper_customer_name') || 'Officer',
          lastModified: new Date().toISOString(),
        };
        cases.push(newCase);
        localStorage.setItem('viperCases', JSON.stringify(cases));
        try { if (API() && API().createCaseFolder) API().createCaseFolder(num); } catch (_) {}
      }
      const hasPrimary = links.some(l => l.role === 'primary');
      try {
        links = await API().ucChatLinkCase(chatId, num, hasPrimary ? 'secondary' : 'primary');
        showCreate = false; render();
      } catch (e) { setErr(e && e.message || String(e)); }
    };

    (async () => {
      try { links = (await API().ucChatCaseLinks(chatId)) || []; } catch (_) { links = []; }
      render();
      openModal(back);
    })();
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(back); });
  }

  /* ── Alert host (toasts) ──────────────────────────────────── */
  function pushToast(payload) {
    const host = document.getElementById('ucAlertHost');
    if (!host) return;
    const chatId = payload && payload.chatId;
    const kind = payload && payload.kind;
    const generic = kind === 'activity' || kind === 'title';
    const title = generic ? 'UC Chat' : (payload.title || 'New message');
    const body = generic ? 'New activity' : (payload.body || '');
    const node = document.createElement('div');
    node.className = 'px-3 py-2 rounded-lg cursor-pointer';
    node.style.cssText = 'background:rgba(15,21,37,0.96);border:1px solid rgba(124,58,237,0.55);box-shadow:0 4px 24px rgba(0,0,0,0.4), 0 0 12px rgba(124,58,237,0.2);max-width:340px;pointer-events:auto;animation:ucToastIn .2s ease;';
    node.innerHTML = `<div class="flex items-start gap-2"><span class="text-base">💬</span>
      <div class="flex-1 min-w-0"><div class="text-sm font-medium text-white truncate">${esc(title)}</div>
      ${body ? `<div class="text-xs text-gray-400 line-clamp-2">${esc(body)}</div>` : ''}
      <div class="text-[10px] text-gray-500 mt-1">Chat #${esc(chatId)} · click to open</div></div>
      <button class="uc-toast-x text-gray-500 hover:text-gray-300 text-xs">✕</button></div>`;
    const remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    node.onclick = () => { openToChat(chatId); remove(); };
    node.querySelector('.uc-toast-x').onclick = (e) => { e.stopPropagation(); remove(); };
    host.insertBefore(node, host.firstChild);
    while (host.children.length > 5) host.removeChild(host.lastChild);
    setTimeout(remove, 6000);
  }
  async function openToChat(chatId) {
    if (!chatId) return;
    if (!S.open) { S.open = true; window.dispatchEvent(new CustomEvent('pulse:tray-open', { detail: { tray: 'uc-chat' } })); await refreshPersonas(); }
    // make sure the chat's persona is active so refreshChats includes it
    try {
      const chat = await API().ucChatGet(chatId);
      if (chat && chat.persona_id) S.activePersonaId = chat.persona_id;
    } catch (_) {}
    await refreshChats(); await renderAll();
    switchToChat(chatId);
  }

  /* ── Utility DOM wiring ───────────────────────────────────── */
  function byId(id, fn) { const el = document.getElementById(id); if (el) fn(el); }
  function byIn(root, sel, fn) { const el = root.querySelector(sel); if (el) fn(el); }
  function toast(msg, type) {
    if (typeof window.viperToast === 'function') { try { window.viperToast(msg, type); return; } catch (_) {} }
    console.log('[uc-chat]', type || 'info', msg);
  }

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
    if (!window.electronAPI) return; // desktop-only feature
    injectStyles();
    injectDOM();
    updateFab();

    // Mutex with Resource Hub: if it opens, close our tray.
    window.addEventListener('pulse:tray-open', (ev) => {
      if (ev && ev.detail && ev.detail.tray !== 'uc-chat' && S.open) { S.open = false; stopRaf(); renderAll(); }
    });
    // Toast → open chat
    window.addEventListener('pulse:uc-open-chat', (ev) => { const id = ev && ev.detail && ev.detail.chatId; if (id) openToChat(id); });
    // Photo library changed → refresh right-rail panel
    window.addEventListener('pulse:persona-photos-changed', () => { const p = activePersona(); if (S.open && p) renderPhotoPanel(p.id, S.activeChatId); });
    // A full-window modal owned by another module (e.g. the Resource Hub
    // download-routing modal used by evidence capture) needs our native BV
    // hidden — otherwise it renders above the modal and blocks it. Suspend
    // and resume our BrowserView on these global signals.
    window.addEventListener('pulse:bv-suspend', () => { bvSuspended = true; syncBV(); });
    window.addEventListener('pulse:bv-resume', () => { bvSuspended = false; syncBV(); });
    // Keep drawer edge + BV aligned on resize
    window.addEventListener('resize', () => {
      if (S.open) {
        const drawer = document.getElementById('ucChatDrawer');
        if (drawer) drawer.style.left = S.expanded ? '0px' : (sidebarRightEdge() + 'px');
      }
      if (shouldShowBV()) positionActiveBV();
    });
    // Settings toggle → show/hide FAB live (same page + other windows)
    function applyEnabledState() {
      updateFab();
      if (!enabled() && S.open) { S.open = false; stopRaf(); renderAll(); }
    }
    window.addEventListener('uc-chat-enabled-changed', applyEnabledState);
    window.addEventListener('storage', (e) => { if (e && e.key === ENABLED_KEY) applyEnabledState(); });
    // Clear orphaned BVs from a prior page/session
    try { API().ucChatBvHideAll(); } catch (_) {}

    // Alert subscription + prime unread badge
    try { API().ucDiscreetModeGet().then(v => { S.discreet = !!v; }).catch(() => {}); } catch (_) {}
    try { alertUnsub = API().ucOnAlert((payload) => { pushToast(payload); primeUnread(); }); } catch (_) {}
    primeUnread();

    window.addEventListener('beforeunload', () => { try { API().ucChatBvHideAll(); } catch (_) {} if (alertUnsub) try { alertUnsub(); } catch (_) {} });
  }

  // Pull unread counts for the FAB badge without opening the tray.
  async function primeUnread() {
    try {
      await refreshPersonas();
      // Sum unread across all personas' chats for a global badge.
      const all = [];
      for (const p of S.personas) {
        try { const list = await API().ucChatList({ personaId: p.id }); all.push(...(list || [])); } catch (_) {}
      }
      if (!S.open) S.chats = all;
      updateFab();
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
