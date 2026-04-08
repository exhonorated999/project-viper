/**
 * VIPER UI — Custom toast notifications & confirm dialogs
 * Replaces native alert()/confirm() to avoid Electron focus bugs.
 */

(function () {
  /* ── Inject toast container + confirm backdrop CSS ─────── */
  const style = document.createElement('style');
  style.textContent = `
    #viper-toast-container {
      position: fixed; top: 16px; right: 16px; z-index: 99999;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none; max-width: 420px;
    }
    .viper-toast {
      pointer-events: auto;
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 16px; border-radius: 10px;
      font-size: 13px; line-height: 1.45; color: #fff;
      backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      animation: vt-slide-in .25s ease-out;
      transition: opacity .2s, transform .2s;
    }
    .viper-toast.vt-exit { opacity: 0; transform: translateX(30px); }
    .viper-toast.vt-info    { background: rgba(0,217,255,0.12); border-color: rgba(0,217,255,0.25); }
    .viper-toast.vt-success { background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.25); }
    .viper-toast.vt-warning { background: rgba(255,167,38,0.12); border-color: rgba(255,167,38,0.25); }
    .viper-toast.vt-error   { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.25); }
    .vt-icon { flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; }
    .vt-info .vt-icon    { color: #00d9ff; }
    .vt-success .vt-icon { color: #22c55e; }
    .vt-warning .vt-icon { color: #ffa726; }
    .vt-error .vt-icon   { color: #ef4444; }
    .vt-body { flex: 1; }
    .vt-close {
      flex-shrink: 0; background: none; border: none; color: rgba(255,255,255,0.4);
      cursor: pointer; padding: 2px; margin: -2px -4px 0 0; font-size: 16px; line-height: 1;
    }
    .vt-close:hover { color: #fff; }
    @keyframes vt-slide-in { from { opacity: 0; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }

    /* Confirm dialog */
    .viper-confirm-backdrop {
      position: fixed; inset: 0; z-index: 99998;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      animation: vc-fade-in .15s ease-out;
    }
    .viper-confirm-box {
      background: #1a2332; border: 1px solid rgba(0,217,255,0.2);
      border-radius: 12px; padding: 24px; max-width: 440px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      animation: vc-scale-in .2s ease-out;
    }
    .viper-confirm-box p { color: #e2e8f0; font-size: 14px; line-height: 1.5; margin-bottom: 20px; }
    .viper-confirm-btns { display: flex; justify-content: flex-end; gap: 10px; }
    .viper-confirm-btns button {
      padding: 8px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
      cursor: pointer; border: 1px solid; transition: all .15s;
    }
    .vc-cancel {
      background: rgba(107,114,128,0.15); border-color: rgba(107,114,128,0.4); color: #9ca3af;
    }
    .vc-cancel:hover { background: rgba(107,114,128,0.25); color: #d1d5db; }
    .vc-ok {
      background: rgba(0,217,255,0.15); border-color: rgba(0,217,255,0.4); color: #00d9ff;
    }
    .vc-ok:hover { background: rgba(0,217,255,0.25); }
    .vc-danger {
      background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.4); color: #ef4444;
    }
    .vc-danger:hover { background: rgba(239,68,68,0.25); }
    @keyframes vc-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes vc-scale-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
  `;
  document.head.appendChild(style);

  /* ── Toast container ─────────────────────────────────────── */
  let container;
  function ensureContainer() {
    if (!container || !container.parentNode) {
      container = document.createElement('div');
      container.id = 'viper-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  const icons = {
    info:    '<svg class="vt-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    success: '<svg class="vt-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    warning: '<svg class="vt-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
    error:   '<svg class="vt-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
  };

  /**
   * viperToast(message, type?, duration?)
   *  type: 'info' | 'success' | 'warning' | 'error'  (default: 'info')
   *  duration: ms (default: 4000, 0 = persistent)
   */
  window.viperToast = function (message, type, duration) {
    type = type || 'info';
    if (duration === undefined) duration = 4000;
    const c = ensureContainer();
    const el = document.createElement('div');
    el.className = 'viper-toast vt-' + type;
    el.innerHTML = `${icons[type] || icons.info}<div class="vt-body">${message}</div><button class="vt-close">&times;</button>`;
    el.querySelector('.vt-close').onclick = () => dismiss(el);
    c.appendChild(el);
    if (duration > 0) setTimeout(() => dismiss(el), duration);
    function dismiss(t) {
      t.classList.add('vt-exit');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }
  };

  /**
   * viperConfirm(message, opts?) → Promise<boolean>
   *  opts.danger: boolean — use red confirm button
   *  opts.okText: string (default: 'Confirm')
   *  opts.cancelText: string (default: 'Cancel')
   */
  window.viperConfirm = function (message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'viper-confirm-backdrop';
      const btnClass = opts.danger ? 'vc-danger' : 'vc-ok';
      backdrop.innerHTML = `
        <div class="viper-confirm-box">
          <p>${message}</p>
          <div class="viper-confirm-btns">
            <button class="vc-cancel">${opts.cancelText || 'Cancel'}</button>
            <button class="${btnClass}">${opts.okText || 'Confirm'}</button>
          </div>
        </div>`;
      const [cancelBtn, okBtn] = backdrop.querySelectorAll('button');
      function close(val) {
        backdrop.style.opacity = '0';
        setTimeout(() => { if (backdrop.parentNode) backdrop.remove(); }, 150);
        resolve(val);
      }
      cancelBtn.onclick = () => close(false);
      okBtn.onclick = () => close(true);
      backdrop.onclick = (e) => { if (e.target === backdrop) close(false); };
      document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', handler); close(false); }
        if (e.key === 'Enter')  { document.removeEventListener('keydown', handler); close(true); }
      });
      document.body.appendChild(backdrop);
      okBtn.focus();
    });
  };
})();
