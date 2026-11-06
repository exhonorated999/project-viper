/**
 * ViperAutoBackup — renderer side of the automatic weekly backup.
 *
 * Main (modules/backup/auto-backup-main.js) decides whether a backup is due
 * and writes it. This side only collects localStorage (which main can't
 * read) and passes it over, then shows a short toast.
 *
 * Loaded on index.html, case-detail-with-analytics.html and settings.html,
 * after case-stores.js. A check runs START_DELAY after a page loads (so it
 * never slows down startup) and every CHECK_EVERY while the page stays open.
 * Several pages asking at once is fine: main runs one backup at a time and
 * re-checks "due" itself.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperAutoBackup = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const START_DELAY = 45 * 1000;
    const CHECK_EVERY = 30 * 60 * 1000;

    /**
     * Keys outside the "viper…" / case-store families that still hold case
     * work: an RMS import waiting for its case page, and the activity logs
     * of the trace-search and general-logs tools.
     */
    const EXTRA_PREFIXES = Object.freeze(['pendingRmsImport_', 'traceSearchAuditLog', 'genlogsActivityLog']);

    /** Same key selection as Settings › Create Backup. */
    function collect(storage, prefixes2) {
        const out = {};
        const pre = (Array.isArray(prefixes2) ? prefixes2 : []).concat(EXTRA_PREFIXES);
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key == null) continue;
            if (key.startsWith('viper') || pre.some(p => key.startsWith(p))) {
                out[key] = storage.getItem(key);
            }
        }
        return out;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function fmtSize(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        const u = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
        return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
    }

    /** "today", "yesterday", "3 days ago", "in 5 days". */
    function relDays(iso, now) {
        const t = Date.parse(iso);
        if (isNaN(t)) return '';
        const day = 24 * 60 * 60 * 1000;
        const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
        const d1 = new Date(t); d1.setHours(0, 0, 0, 0);
        const diff = Math.round((d1 - d0) / day);
        if (diff === 0) return 'today';
        if (diff === -1) return 'yesterday';
        if (diff === 1) return 'tomorrow';
        return diff < 0 ? (-diff) + ' days ago' : 'in ' + diff + ' days';
    }

    /** One status line for Settings. */
    function statusText(st, now) {
        if (!st) return '';
        if (!st.enabled) return 'Automatic backup is off.';
        const parts = [];
        if (st.running) parts.push('Backing up now…');
        if (st.lastAutoAt) {
            parts.push('Last automatic backup: ' + new Date(st.lastAutoAt).toLocaleString() + ' (' + relDays(st.lastAutoAt, now) + ')');
        } else if (!st.running) {
            parts.push('No automatic backup yet — the first one runs within a minute while VIPER is open.');
        }
        if (st.nextDueAt && !st.running) {
            const due = Date.parse(st.nextDueAt);
            parts.push(due <= now ? 'Next: due now' : 'Next: ' + new Date(due).toLocaleDateString() + ' (' + relDays(st.nextDueAt, now) + ')');
        }
        return parts.join(' · ');
    }

    /** Status line for the secondary backup folder. */
    function secondaryText(st, now) {
        if (!st || !st.secondaryEnabled || !st.secondaryFolder) return '';
        if (st.lastSecondaryError) return 'Last copy failed: ' + st.lastSecondaryError;
        const parts = [];
        if (st.secondaryFolderExists === false) parts.push('Folder not reachable right now — backups still go to the Backup Destination.');
        if (st.lastSecondaryAt) {
            parts.push('Last copy: ' + new Date(st.lastSecondaryAt).toLocaleString() + ' (' + relDays(st.lastSecondaryAt, now) + ')');
        } else {
            parts.push('No copy yet — the next backup (manual or automatic) is saved here too.');
        }
        return parts.join(' · ');
    }

    function toast(msg, type, ms) {
        const w = typeof window !== 'undefined' ? window : {};
        if (typeof w.viperToast === 'function') return w.viperToast(esc(msg), type, ms);
        if (typeof w.showNotification === 'function') return w.showNotification(msg, type);
        if (typeof w.showToast === 'function') return w.showToast(msg, type);
    }

    let busy = false;

    async function check(opts) {
        opts = opts || {};
        const w = window;
        const api = w.electronAPI;
        if (busy || !api || typeof api.autoBackupGet !== 'function') return { skipped: 'unavailable' };
        // Without the store registry a backup would silently miss per-case data.
        if (!w.CaseStores || typeof w.CaseStores.prefixes2 !== 'function') return { skipped: 'no-registry' };
        busy = true;
        try {
            const st = await api.autoBackupGet();
            if (!opts.force && (!st || !st.due || st.running)) return { skipped: 'not-due' };
            const data = JSON.stringify(collect(w.localStorage, w.CaseStores.prefixes2()));
            if (!opts.quiet) toast('Weekly backup started — you can keep working.', 'info', 3000);
            const r = await api.autoBackupRun({ data, force: !!opts.force });
            if (r && r.ok) {
                try { w.localStorage.setItem('viperLastBackupDate', new Date().toISOString()); } catch (_) {}
                if (!opts.quiet) {
                    toast('Weekly backup saved — ' + r.cases + ' case' + (r.cases === 1 ? '' : 's') +
                        (r.skipped ? ' (' + r.skipped + ' file' + (r.skipped === 1 ? '' : 's') + ' could not be read)' : '') +
                        (r.secondary && !r.secondary.error && !r.primaryError ? ', copied to the secondary folder' : '') + '.', 'success', 5000);
                }
                // Saved, but one of the two places failed: say which.
                if (r.warning) {
                    toast('Backup saved, but not everywhere: ' + r.warning + ' (Settings › Backup & Restore)', 'warning', 10000);
                }
            } else if (r && r.error) {
                // Once per page session per message; main retries in 6 hours.
                const k = 'viperAutoBackupWarned';
                let seen = '';
                try { seen = w.sessionStorage.getItem(k) || ''; } catch (_) {}
                if (seen !== r.error) {
                    toast('Automatic backup did not run: ' + r.error + ' (Settings › Backup & Restore)', 'warning', 9000);
                    try { w.sessionStorage.setItem(k, r.error); } catch (_) {}
                }
            }
            try { w.dispatchEvent(new CustomEvent('viper-auto-backup', { detail: r })); } catch (_) {}
            return r;
        } catch (e) {
            console.warn('[auto-backup]', e);
            return { ok: false, error: (e && e.message) || String(e) };
        } finally {
            busy = false;
        }
    }

    function boot() {
        if (typeof window === 'undefined' || window.__viperAutoBackupBooted) return;
        window.__viperAutoBackupBooted = true;
        setTimeout(() => { check(); }, START_DELAY);
        setInterval(() => { check(); }, CHECK_EVERY);
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();

    return { collect, check, boot, statusText, secondaryText, relDays, fmtSize, esc, EXTRA_PREFIXES, START_DELAY, CHECK_EVERY };
});
