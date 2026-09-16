/**
 * VIPER Storage Guard
 * -------------------
 * Protects against the "phantom reset": VIPER launching as if it were a
 * brand-new install because Chromium handed the renderer an EMPTY
 * localStorage.
 *
 * THE FAILURE (field report, Josh Berzanji):
 *   Officer launched VIPER and was asked to register from scratch; every
 *   case was gone. He restored a two-week-old backup. On the THIRD launch
 *   everything came back on its own. Nothing had ever been deleted - his
 *   userData/case files lived in OneDrive and had not finished syncing, so
 *   for two launches the localStorage LevelDB was unreadable.
 *
 * WHY THE APP BELIEVED IT:
 *   getLicenseStatus() decides registration with
 *       if (!localStorage.getItem('viper_registered_at')) -> unregistered
 *   An empty read and a new install are indistinguishable at that line.
 *
 * THE FIX:
 *   The main process keeps an install marker OUTSIDE userData (always on
 *   local disk, never in a cloud/redirected folder) plus a boot-time probe
 *   of the real storage. Together they separate:
 *       marker absent  + empty storage -> genuinely a new install
 *       marker present + empty storage -> STORAGE FAULT
 *
 * IMPORTANT - WHY WE DO NOT AUTO-WRITE DURING A FAULT:
 *   If the LevelDB failed to open, Chromium may have created a fresh empty
 *   one. Writing recovered values into it can diverge from the user's real
 *   data once it becomes available (and OneDrive would then produce
 *   conflict copies). For evidence-handling software the only safe move is
 *   to stop, tell the user, and let them retry. We block; we never guess.
 */
(function () {
    if (window.ViperStorageGuard) return;

    const REG_KEYS = [
        'registered_at', 'api_key', 'license_key', 'license_type',
        'expires_at', 'customer_name', 'contact_email', 'agency'
    ];
    const PREFIX = 'viper_';

    function hasLocalRegistration() {
        try { return !!localStorage.getItem(PREFIX + 'registered_at'); }
        catch (_) { return false; }
    }

    function localCaseCount() {
        try {
            const raw = localStorage.getItem('viperCases');
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.length : 0;
        } catch (_) { return 0; }
    }

    /**
     * Is localStorage actually persistent right now? A DB that failed to
     * open can still accept writes into a throwaway in-memory map, so a
     * plain setItem/getItem round-trip is not sufficient on its own - but
     * a FAILED round-trip is conclusive proof of trouble.
     */
    function probeWritable() {
        const k = '__viper_storage_probe__';
        try {
            localStorage.setItem(k, '1');
            const ok = localStorage.getItem(k) === '1';
            localStorage.removeItem(k);
            return ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * Decide what state we are in.
     * verdict: 'ok' | 'new-install' | 'storage-fault'
     */
    async function assess() {
        const out = {
            verdict: 'ok',
            reasons: [],
            health: null,
            writable: probeWritable(),
            hasLocalRegistration: hasLocalRegistration(),
            caseCount: localCaseCount(),
        };

        if (!window.electronAPI || !window.electronAPI.getStorageHealth) {
            // No IPC (browser preview / older preload) - fail open so we
            // never block the app on a missing capability.
            return out;
        }

        try {
            out.health = await window.electronAPI.getStorageHealth();
        } catch (e) {
            return out;
        }

        const h = out.health || {};

        if (out.hasLocalRegistration) {
            out.verdict = 'ok';
            return out;
        }

        // From here on: localStorage reports no registration.
        if (!h.hasInstallMarker) {
            out.verdict = 'new-install';
            out.reasons.push('No prior install recorded on this machine.');
            return out;
        }

        // Marker says this machine HAS been registered before, yet storage
        // is empty. That is the phantom reset.
        out.verdict = 'storage-fault';
        if (h.marker && h.marker.lastHealthyAt) {
            out.reasons.push('VIPER last confirmed your data on ' +
                new Date(h.marker.lastHealthyAt).toLocaleString() + '.');
        }
        if (h.marker && h.marker.lastKnownCaseCount) {
            out.reasons.push(h.marker.lastKnownCaseCount +
                ' case(s) were present at that time.');
        }
        if (h.userDataExistedAtBoot === false) {
            out.reasons.push('The app-data folder was missing at launch and had to be created.');
        } else if (h.localStorageExistedAtBoot === false) {
            out.reasons.push('The local database files were not present at launch.');
        }
        if (h.userDataCloudProvider) {
            out.reasons.push('App data is stored in ' + h.userDataCloudProvider +
                ', which may still be syncing.');
        }
        if (h.casesCloudProvider) {
            out.reasons.push('Case files are stored in ' + h.casesCloudProvider +
                ', which may still be syncing.');
        }
        if (!out.writable) {
            out.reasons.push('Local storage is not currently writable.');
        }
        return out;
    }

    /** Record that storage is healthy, mirroring registration to disk. */
    async function markHealthy() {
        if (!window.electronAPI || !window.electronAPI.updateInstallMarker) return false;
        if (!hasLocalRegistration()) return false;
        const registration = {};
        REG_KEYS.forEach(k => {
            const v = localStorage.getItem(PREFIX + k);
            if (v !== null && v !== undefined) registration[k] = v;
        });
        try {
            const r = await window.electronAPI.updateInstallMarker({
                registration,
                caseCount: localCaseCount(),
            });
            return !!(r && r.success);
        } catch (_) { return false; }
    }

    /**
     * Explicit, user-initiated restore of registration only (never case
     * data). Used by the "I understand - continue" path so an officer who
     * genuinely wiped their profile is not forced to re-register.
     */
    async function restoreRegistration() {
        if (!window.electronAPI || !window.electronAPI.getInstallMarkerRegistration) return false;
        try {
            const reg = await window.electronAPI.getInstallMarkerRegistration();
            if (!reg || !reg.registered_at) return false;
            Object.keys(reg).forEach(k => {
                if (REG_KEYS.indexOf(k) !== -1 && reg[k] != null) {
                    localStorage.setItem(PREFIX + k, String(reg[k]));
                }
            });
            return true;
        } catch (_) { return false; }
    }

    /** Forget this install (called when the user deliberately resets). */
    async function forget() {
        if (!window.electronAPI || !window.electronAPI.updateInstallMarker) return;
        try {
            await window.electronAPI.updateInstallMarker({ registration: null, caseCount: 0 });
        } catch (_) { /* non-fatal */ }
    }

    // ── Blocking UI ──────────────────────────────────────────────────
    function showFaultScreen(result) {
        const existing = document.getElementById('viperStorageFault');
        if (existing) return;

        const h = result.health || {};
        const el = document.createElement('div');
        el.id = 'viperStorageFault';
        el.setAttribute('role', 'alertdialog');
        el.style.cssText =
            'position:fixed;inset:0;z-index:2147483646;background:#0b0d12;' +
            'display:flex;align-items:center;justify-content:center;padding:24px;' +
            'font-family:system-ui,-apple-system,Segoe UI,sans-serif;overflow:auto;';

        const reasons = (result.reasons || [])
            .map(r => '<li style="margin:4px 0;">' + escapeHtml(r) + '</li>').join('');

        el.innerHTML =
            '<div style="max-width:640px;width:100%;background:#151922;border:1px solid #f59e0b;' +
            'border-radius:14px;padding:28px 30px;box-shadow:0 20px 60px rgba(0,0,0,.6);">' +
              '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
                '<div style="width:40px;height:40px;border-radius:10px;background:rgba(245,158,11,.15);' +
                'display:flex;align-items:center;justify-content:center;font-size:22px;">&#9888;</div>' +
                '<h1 style="margin:0;font-size:20px;color:#fff;font-weight:700;">' +
                  'VIPER can\u2019t reach your data' +
                '</h1>' +
              '</div>' +
              '<p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 14px;">' +
                'Your cases and registration are <strong>not lost</strong>. VIPER has been ' +
                'registered on this computer before, but your data files could not be read ' +
                'just now \u2014 so the app is pausing instead of starting over as a new install.' +
              '</p>' +
              (reasons ? '<ul style="color:#94a3b8;font-size:13px;margin:0 0 16px;padding-left:20px;">' +
                reasons + '</ul>' : '') +
              '<div style="background:#0f131b;border:1px solid #243049;border-radius:10px;' +
              'padding:12px 14px;margin-bottom:18px;">' +
                '<div style="color:#64748b;font-size:11px;text-transform:uppercase;' +
                'letter-spacing:.08em;margin-bottom:6px;">What to do</div>' +
                '<ol style="color:#cbd5e1;font-size:13px;line-height:1.7;margin:0;padding-left:18px;">' +
                  '<li>If your files are in OneDrive/Dropbox, let it finish syncing, then press Retry.</li>' +
                  '<li>If they are on a network or external drive, reconnect it, then press Retry.</li>' +
                  '<li><strong>Do not</strong> restore an old backup yet \u2014 it can overwrite newer work.</li>' +
                '</ol>' +
              '</div>' +
              '<div style="font-size:11px;color:#475569;margin-bottom:18px;word-break:break-all;">' +
                'App data: ' + escapeHtml(h.userDataPath || 'unknown') + '<br>' +
                'Case files: ' + escapeHtml(h.casesPath || 'unknown') +
              '</div>' +
              '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                '<button id="vsfRetry" style="flex:1;min-width:140px;background:#f59e0b;color:#0b0d12;' +
                'border:0;border-radius:9px;padding:11px 16px;font-weight:700;font-size:14px;' +
                'cursor:pointer;">Retry</button>' +
                '<button id="vsfFolder" style="background:#1e2634;color:#cbd5e1;border:1px solid #334155;' +
                'border-radius:9px;padding:11px 16px;font-size:14px;cursor:pointer;">Open data folder</button>' +
                '<button id="vsfContinue" style="background:transparent;color:#64748b;border:1px solid #334155;' +
                'border-radius:9px;padding:11px 16px;font-size:13px;cursor:pointer;">Continue anyway</button>' +
              '</div>' +
              '<div id="vsfNote" style="color:#64748b;font-size:11px;margin-top:12px;"></div>' +
            '</div>';

        document.body.appendChild(el);

        document.getElementById('vsfRetry').onclick = () => location.reload();

        document.getElementById('vsfFolder').onclick = () => {
            try {
                const target = h.userDataPath || h.casesPath;
                if (target && window.electronAPI && window.electronAPI.openPath) {
                    window.electronAPI.openPath(target);
                } else if (target && window.electronAPI && window.electronAPI.showItemInFolder) {
                    window.electronAPI.showItemInFolder(target);
                }
            } catch (_) { /* best effort */ }
        };

        document.getElementById('vsfContinue').onclick = async () => {
            const note = document.getElementById('vsfNote');
            note.textContent = 'Restoring your registration\u2026';
            const restored = await restoreRegistration();
            note.textContent = restored
                ? 'Registration restored. Reloading\u2026'
                : 'Continuing as a new install\u2026';
            setTimeout(() => location.reload(), 700);
        };
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Main entry. Returns the assessment so callers can decide whether to
     * run their own registration gate.
     *   - 'ok'            -> marker refreshed, safe to proceed
     *   - 'new-install'   -> caller shows the normal registration flow
     *   - 'storage-fault' -> guard has blocked the UI; caller must NOT
     *                        show a registration prompt
     */
    async function run() {
        let result;
        try {
            result = await assess();
        } catch (e) {
            console.error('[storage-guard] assessment failed:', e);
            return { verdict: 'ok', reasons: [], error: String(e) };
        }

        if (result.verdict === 'ok') {
            markHealthy();
        } else if (result.verdict === 'storage-fault') {
            console.error('[storage-guard] STORAGE FAULT —', result.reasons.join(' '));
            const show = () => showFaultScreen(result);
            if (document.body) show();
            else document.addEventListener('DOMContentLoaded', show, { once: true });
        }
        return result;
    }

    window.ViperStorageGuard = {
        run, assess, markHealthy, restoreRegistration, forget,
        probeWritable, hasLocalRegistration,
    };
})();
