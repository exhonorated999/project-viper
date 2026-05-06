/**
 * VIPER Field Security UI — client-side lock button + idle lockout.
 * Include on every page: <script src="/modules/security-ui.js"></script>
 * Only activates when Field Security is enabled.
 */
(function () {
  const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
  let idleTimer = null;
  let securityActive = false;

  // ─── Lock action ────────────────────────────────────────────────
  async function lockApp(reason) {
    try {
      // Snapshot localStorage
      const data = JSON.stringify(Object.fromEntries(
        Object.keys(localStorage)
          .filter(k => k.startsWith('viper') || k.startsWith('Viper'))
          .map(k => [k, localStorage.getItem(k)])
      ));
      // Encrypt vault via main process
      await window.electronAPI.securitySaveVault(data);
      // Clear sensitive data from localStorage
      Object.keys(localStorage)
        .filter(k => k.startsWith('viper') || k.startsWith('Viper'))
        .forEach(k => localStorage.removeItem(k));
      // Lock and navigate to login
      await window.electronAPI.securityLock({ reason: reason || 'manual' });
    } catch (e) {
      console.error('Lock failed:', e);
    }
  }

  // ─── Idle detection ─────────────────────────────────────────────
  function resetIdleTimer() {
    if (!securityActive) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log('VIPER: Idle lockout triggered');
      lockApp('idle');
    }, IDLE_TIMEOUT_MS);
  }

  function startIdleWatcher() {
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(evt => document.addEventListener(evt, resetIdleTimer, { passive: true }));
    resetIdleTimer();
  }

  // ─── Inject lock button into sidebar ────────────────────────────
  function injectLockButton() {
    // Find the sidebar's user profile / bottom area
    const sidebar = document.querySelector('.w-64.glass-card');
    if (!sidebar) {
      // Fallback: floating button
      injectFloatingLockButton();
      return;
    }

    // Find the border-t div at the bottom (user profile area)
    const profileArea = sidebar.querySelector('.border-t');
    if (!profileArea) {
      injectFloatingLockButton();
      return;
    }

    // Insert lock button before theme toggle
    const lockDiv = document.createElement('div');
    lockDiv.className = 'mb-3';
    lockDiv.innerHTML = `
      <button onclick="window.__viperLockApp()"
        class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-amber-400/80 hover:text-amber-400 hover:bg-amber-400/10 border border-transparent hover:border-amber-400/20 transition-all text-sm"
        title="Lock application (encrypts case data)">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
        </svg>
        <span>Lock</span>
        <span class="ml-auto text-xs text-gray-600" id="viperIdleCountdown"></span>
      </button>
    `;
    profileArea.insertBefore(lockDiv, profileArea.firstChild);
  }

  function injectFloatingLockButton() {
    const btn = document.createElement('button');
    btn.onclick = lockApp;
    btn.title = 'Lock application';
    btn.className = 'fixed bottom-4 left-4 z-50 flex items-center gap-2 px-4 py-2 rounded-lg bg-viper-card border border-amber-400/30 text-amber-400 hover:bg-amber-400/10 transition-all text-sm shadow-lg';
    btn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
      <span>Lock</span>
    `;
    document.body.appendChild(btn);
  }

  // ─── Expose lock globally for onclick handlers ──────────────────
  window.__viperLockApp = lockApp;

  // ─── Init ───────────────────────────────────────────────────────
  async function init() {
    if (!window.electronAPI || !window.electronAPI.securityCheck) return;
    try {
      const state = await window.electronAPI.securityCheck();
      if (!state.enabled || !state.unlocked) return;
      securityActive = true;
      injectLockButton();
      startIdleWatcher();
    } catch (e) {
      // Security not available, silently skip
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
