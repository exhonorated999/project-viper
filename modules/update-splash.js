/**
 * Update Splash — dashboard "update available" notification.
 *
 * On dashboard launch this module asks the main process to check GitHub for a
 * newer release (only when the machine is online). The main process runs the
 * existing electron-updater flow and broadcasts `update-status` events; when an
 * `available` event arrives we pop a dismissible card in the upper-right corner
 * of the dashboard summarising the version + release notes and pointing the
 * user at Settings → Software Updates to actually download & install.
 *
 * Include on the dashboard AFTER the app chrome:
 *   <script src="modules/update-splash.js"></script>
 *
 * Requires: window.electronAPI (preload) — degrades to a no-op without it.
 *
 * Colour follows the active skin via the --vp-* channel tokens (with classic
 * cyan/violet fallbacks) so it matches Classic / Supervisor / Cyber Obsidian.
 */
(function () {
  'use strict';

  var ACK_KEY = 'viperUpdateAckVersion';   // last version the user dismissed
  var LATEST = null;                         // { version, releaseNotes, releaseDate }
  var checkFired = false;

  function isAcked(v) {
    try { return localStorage.getItem(ACK_KEY) === String(v); } catch (_) { return false; }
  }
  function setAcked(v) {
    try { localStorage.setItem(ACK_KEY, String(v)); } catch (_) {}
  }

  /* ── Styles ───────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('vus-styles')) return;
    var s = document.createElement('style');
    s.id = 'vus-styles';
    s.textContent = [
      '#viperUpdateSplash{position:fixed;top:100px;right:24px;z-index:9990;width:372px;',
      'max-width:calc(100vw - 48px);transform:translateX(125%);opacity:0;pointer-events:none;',
      'transition:transform .38s cubic-bezier(.4,0,.2,1),opacity .38s;}',
      '#viperUpdateSplash.vus-show{transform:translateX(0);opacity:1;pointer-events:auto;}',
      '.vus-card{background:rgba(10,14,22,.97);backdrop-filter:blur(20px);',
      'border:1px solid rgba(var(--vp-cyan,0 217 255) / .35);border-radius:14px;overflow:hidden;',
      'box-shadow:0 14px 44px rgba(0,0,0,.55),0 0 26px rgba(var(--vp-cyan,0 217 255) / .16);}',
      '.vus-accent{height:3px;background:linear-gradient(90deg,rgb(var(--vp-cyan,0 217 255)),rgb(var(--vp-purple,138 43 226)));}',
      '.vus-body{padding:14px 15px 15px;}',
      '.vus-head{display:flex;align-items:flex-start;gap:11px;}',
      '.vus-icon{width:38px;height:38px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;',
      'background:rgba(var(--vp-cyan,0 217 255) / .14);border:1px solid rgba(var(--vp-cyan,0 217 255) / .30);color:rgb(var(--vp-cyan,0 217 255));',
      'animation:vusPulse 2.4s ease-in-out infinite;}',
      '@keyframes vusPulse{0%,100%{box-shadow:0 0 0 0 rgba(var(--vp-cyan,0 217 255) / .35)}50%{box-shadow:0 0 0 6px rgba(var(--vp-cyan,0 217 255) / 0)}}',
      '.vus-titles{flex:1;min-width:0;}',
      '.vus-title{font-size:13px;font-weight:700;color:#fff;letter-spacing:.02em;display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.vus-badge{font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;color:rgb(var(--vp-cyan,0 217 255));',
      'background:rgba(var(--vp-cyan,0 217 255) / .14);border:1px solid rgba(var(--vp-cyan,0 217 255) / .35);}',
      '.vus-sub{font-size:11px;color:#9ca3af;margin-top:2px;}',
      '.vus-x{flex-shrink:0;width:24px;height:24px;border-radius:7px;color:#6b7280;background:transparent;border:none;cursor:pointer;',
      'font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}',
      '.vus-x:hover{background:rgba(255,255,255,.08);color:#fff;}',
      '.vus-notes-label{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;margin:12px 0 5px;}',
      '.vus-notes{font-size:11.5px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;max-height:150px;overflow-y:auto;',
      'padding:9px 10px;border-radius:9px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);}',
      '.vus-notes::-webkit-scrollbar{width:6px}.vus-notes::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}',
      '.vus-rec{font-size:11px;color:#9ca3af;line-height:1.5;margin:11px 0 12px;}',
      '.vus-rec strong{color:rgb(var(--vp-cyan,0 217 255));font-weight:600;}',
      '.vus-actions{display:flex;gap:8px;}',
      '.vus-btn-primary{flex:1;padding:8px 12px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;',
      'color:rgb(var(--vp-cyan,0 217 255));background:rgba(var(--vp-cyan,0 217 255) / .18);border:1px solid rgba(var(--vp-cyan,0 217 255) / .45);}',
      '.vus-btn-primary:hover{background:rgba(var(--vp-cyan,0 217 255) / .30);}',
      '.vus-btn-ghost{padding:8px 14px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;',
      'color:#9ca3af;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);}',
      '.vus-btn-ghost:hover{background:rgba(255,255,255,.09);color:#e5e7eb;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ── DOM ──────────────────────────────────────────────────── */
  function ensureDom() {
    var el = document.getElementById('viperUpdateSplash');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'viperUpdateSplash';
    el.setAttribute('role', 'alert');
    el.innerHTML = [
      '<div class="vus-card">',
      '  <div class="vus-accent"></div>',
      '  <div class="vus-body">',
      '    <div class="vus-head">',
      '      <div class="vus-icon">',
      '        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v10m0 0l-4-4m4 4l4-4M5 20h14"/></svg>',
      '      </div>',
      '      <div class="vus-titles">',
      '        <div class="vus-title">Update Available <span id="vusVersion" class="vus-badge"></span></div>',
      '        <div class="vus-sub">A new version of V.I.P.E.R. is ready to install.</div>',
      '      </div>',
      '      <button class="vus-x" title="Dismiss" onclick="window._viperUpdateAck()">&times;</button>',
      '    </div>',
      '    <div id="vusNotesWrap">',
      '      <div class="vus-notes-label">What\u2019s new</div>',
      '      <div id="vusNotes" class="vus-notes"></div>',
      '    </div>',
      '    <div class="vus-rec">Open <strong>Settings \u2192 Software Updates</strong> and click <strong>Download Update</strong> to install it.</div>',
      '    <div class="vus-actions">',
      '      <button class="vus-btn-primary" onclick="window._viperUpdateOpenSettings()">Open Settings</button>',
      '      <button class="vus-btn-ghost" onclick="window._viperUpdateAck()">Got it</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);
    return el;
  }

  /* Normalise release notes (string OR electron-updater's array form) to
   * plain text, stripping any HTML the GitHub release body may contain. */
  function toPlainNotes(raw) {
    if (!raw) return '';
    if (Array.isArray(raw)) {
      raw = raw.map(function (n) {
        if (n && typeof n === 'object') return n.note || '';
        return typeof n === 'string' ? n : '';
      }).join('\n\n');
    }
    var tmp = document.createElement('div');
    tmp.innerHTML = String(raw);
    var txt = (tmp.textContent || tmp.innerText || '').replace(/\r/g, '');
    return txt.replace(/\n{3,}/g, '\n\n').trim();
  }

  function show(info) {
    var el = ensureDom();
    var vEl = el.querySelector('#vusVersion');
    if (vEl) vEl.textContent = 'v' + info.version;
    var notes = toPlainNotes(info.releaseNotes);
    var notesEl = el.querySelector('#vusNotes');
    if (notesEl) {
      if (notes) {
        if (notes.length > 460) notes = notes.slice(0, 460).replace(/\s+\S*$/, '') + '\u2026';
        notesEl.textContent = notes;
      } else {
        notesEl.textContent = 'This release includes the latest improvements and fixes.';
      }
    }
    // rAF so the initial transform is applied before we animate in
    requestAnimationFrame(function () { el.classList.add('vus-show'); });
  }

  function hide() {
    var el = document.getElementById('viperUpdateSplash');
    if (el) el.classList.remove('vus-show');
  }

  function acknowledge() {
    if (LATEST) setAcked(LATEST.version);
    hide();
  }

  function openSettings() {
    if (LATEST) setAcked(LATEST.version);
    try { window.location.href = 'settings.html'; } catch (_) {}
  }

  /* ── Launch-time check ────────────────────────────────────── */
  function triggerCheck() {
    if (checkFired) return;
    checkFired = true;
    try { if (navigator && navigator.onLine === false) return; } catch (_) {}
    if (window.electronAPI && typeof window.electronAPI.updateCheck === 'function') {
      // Small delay so the dashboard finishes its own load work first.
      setTimeout(function () {
        try { window.electronAPI.updateCheck(); } catch (_) {}
      }, 1500);
    }
  }

  function init() {
    injectStyles();
    if (window.electronAPI && typeof window.electronAPI.onUpdateStatus === 'function') {
      window.electronAPI.onUpdateStatus(function (data) {
        if (!data || data.status !== 'available' || !data.version) return;
        LATEST = { version: data.version, releaseNotes: data.releaseNotes, releaseDate: data.releaseDate };
        if (!isAcked(data.version)) show(LATEST);
      });
    }
    triggerCheck();
  }

  // Exposed for the card's inline handlers.
  window._viperUpdateAck = acknowledge;
  window._viperUpdateOpenSettings = openSettings;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
