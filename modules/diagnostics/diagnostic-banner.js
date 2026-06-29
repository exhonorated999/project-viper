/**
 * Diagnostic Banner
 * Injected into top of <body> on all VIPER pages.
 * Only renders when the app reports diagnostic mode = true.
 *
 * Why this exists:
 *   The "VIPER Diagnostic Edition" is a portable, unsigned build sent to
 *   users hitting multi-window launch or Defender flag issues. The banner
 *   is the only way for those users to trigger a launch-diagnostic bundle
 *   and email it back. It must be impossible to miss and must work even
 *   if a window opens behind/over other windows.
 */
(function () {
  'use strict';

  // Guard against double-injection (script may be included on multiple pages
  // that share a renderer process or get reloaded).
  if (window.__viperDiagnosticBannerInjected) return;
  window.__viperDiagnosticBannerInjected = true;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(async function init() {
    // Defensive: electronAPI may not be exposed if preload failed to load.
    const api = window.electronAPI;
    if (!api || typeof api.isDiagnosticMode !== 'function') return;

    let info;
    try {
      info = await api.isDiagnosticMode();
    } catch (err) {
      console.warn('[diagnostic-banner] isDiagnosticMode check failed:', err);
      return;
    }

    if (!info || info.diagnostic !== true) return;

    injectBanner(info);
  });

  function injectBanner(info) {
    // Mount point: a fixed bar at the very top of the viewport. We use a
    // dedicated container so we never disturb existing layout calculations.
    const bar = document.createElement('div');
    bar.id = 'viper-diagnostic-banner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Diagnostic Edition Controls');
    bar.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',           // max — must sit above everything
      'background:#7c2d12',           // amber-900-ish
      'color:#fff',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'font-size:13px',
      'padding:8px 14px',
      'display:flex',
      'align-items:center',
      'gap:12px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
      'border-bottom:1px solid #fbbf24'
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25';
    label.innerHTML = `
      <div style="font-weight:700;letter-spacing:0.04em">
        <span style="background:#fbbf24;color:#7c2d12;padding:1px 6px;border-radius:3px;margin-right:6px">DIAGNOSTIC</span>
        VIPER Diagnostic Edition — capturing launch behaviour
      </div>
      <div style="opacity:0.85;font-size:11px">
        Reason: <code style="background:rgba(0,0,0,0.25);padding:0 4px;border-radius:2px">${escapeHtml(String(info.reason || 'unknown'))}</code>
        &nbsp;·&nbsp; PID <code style="background:rgba(0,0,0,0.25);padding:0 4px;border-radius:2px">${escapeHtml(String(info.pid || ''))}</code>
        &nbsp;·&nbsp; Logs in <code style="background:rgba(0,0,0,0.25);padding:0 4px;border-radius:2px">${escapeHtml(String(info.outputDir || ''))}</code>
      </div>
    `;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Generate & Save Report';
    btn.style.cssText = [
      'background:#fbbf24',
      'color:#7c2d12',
      'border:0',
      'padding:8px 14px',
      'font-weight:700',
      'font-size:13px',
      'border-radius:4px',
      'cursor:pointer',
      'white-space:nowrap',
      'flex-shrink:0'
    ].join(';');

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;opacity:0.9;max-width:320px;text-align:right;flex-shrink:0';

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Generating…';
      status.textContent = '';

      try {
        const res = await window.electronAPI.generateDiagnosticReport();
        if (res && res.ok) {
          const sizeKb = res.size_bytes ? Math.round(res.size_bytes / 1024) : 0;
          status.innerHTML = `
            <div style="color:#bbf7d0;font-weight:700">✓ Saved (${sizeKb} KB, ${escapeHtml(String(res.fileCount || 0))} files)</div>
            <div style="font-size:10px;opacity:0.85;word-break:break-all">${escapeHtml(String(res.zipPath || ''))}</div>
          `;
          btn.textContent = 'Open Folder';
          btn.onclick = () => {
            try { window.electronAPI.showItemInFolder && window.electronAPI.showItemInFolder(res.zipPath); }
            catch (e) { console.warn(e); }
          };
        } else {
          status.innerHTML = `<div style="color:#fecaca;font-weight:700">✗ ${escapeHtml(String((res && res.error) || 'Unknown error'))}</div>`;
          btn.disabled = false;
          btn.textContent = original;
        }
      } catch (err) {
        console.error('[diagnostic-banner] report generation failed:', err);
        status.innerHTML = `<div style="color:#fecaca;font-weight:700">✗ ${escapeHtml(String(err && err.message || err))}</div>`;
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    bar.appendChild(label);
    bar.appendChild(status);
    bar.appendChild(btn);

    // Insert at very top of body so nothing can visually obscure it.
    if (document.body.firstChild) {
      document.body.insertBefore(bar, document.body.firstChild);
    } else {
      document.body.appendChild(bar);
    }

    // Push page content down so the banner doesn't overlap fixed headers.
    // Use a spacer div rather than mutating body padding (less likely to
    // break existing CSS that targets body padding).
    const spacer = document.createElement('div');
    spacer.id = 'viper-diagnostic-banner-spacer';
    spacer.style.cssText = `height:${bar.offsetHeight || 56}px;width:100%`;
    if (bar.nextSibling) {
      bar.parentNode.insertBefore(spacer, bar.nextSibling);
    } else {
      bar.parentNode.appendChild(spacer);
    }

    // Recalculate spacer on viewport resize (banner wraps differently).
    window.addEventListener('resize', () => {
      spacer.style.height = (bar.offsetHeight || 56) + 'px';
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
