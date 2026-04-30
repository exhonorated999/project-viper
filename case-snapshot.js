// case-snapshot.js — Automatic per-case localStorage snapshot to disk
// =====================================================================
// Goal: even if Chromium localStorage is wiped (renderer crash, profile
// corruption, OS-level reset), every case's module data survives on disk
// in cases/{caseNumber}/.case-snapshot.json and is auto-recovered on the
// next launch.
//
// How it works:
//   1. We wrap localStorage.setItem / removeItem. Whenever a tracked key
//      is written, we schedule a debounced snapshot (~800ms) for the
//      affected case.
//   2. A snapshot is the same JSON shape as a .vcase export, but written
//      to a fixed per-case file (encrypted if Field Security is on).
//   3. On dashboard load, we list snapshots on disk and back-fill any
//      module data missing from localStorage. We never overwrite live
//      values — recovery is strictly additive.
//   4. delete-case-folder already wipes cases/{caseNumber}/ recursively,
//      so the snapshot is removed when a case is deleted. Deleted cases
//      are NOT auto-resurrected on next load.
// =====================================================================

(function () {
    if (typeof window === 'undefined') return;
    if (window.viperSnapshot) return; // already installed (script loaded twice)

    // ── Tracked storage keys (mirrors .vcase export schema) ──────────
    const PATTERN1_KEYS = [
        'viperCaseNotes', 'viperCaseReports', 'viperCaseEvidence',
        'viperCaseWarrants', 'viperCaseSuspects', 'viperCaseVictims',
        'viperCaseWitnesses', 'viperCaseVehicles', 'viperCaseFirearms',
        'viperCaseNarcotics', 'viperCaseMoney', 'viperCaseMissingPersons',
        'viperCaseCanvas', 'viperCaseProsecution', 'viperTraceImports'
    ];
    const PATTERN2_PREFIXES = [
        'suspects_', 'victims_', 'victimBusinesses_', 'cargo_',
        'witnesses_', 'involvedPersons_', 'recoveredVehicles_', 'missingpersons_',
        'areacanvas_', 'prosecution_', 'narcotics_', 'firearms_',
        'money_', 'opsplan_', 'rmsImports_', 'oversightImport_',
        'canvasForms_', 'cyberTips_', 'timelineEvents_', 'consentSearches_',
        'googleWarrant_', 'metaWarrant_', 'kikWarrant_', 'caseMetrics_'
    ];
    const PATTERN1_SET = new Set(PATTERN1_KEYS);
    const TASK_KEY = 'viperTasks';
    const CASES_KEY = 'viperCases';
    const DEBOUNCE_MS = 800;

    // ── State ────────────────────────────────────────────────────────
    const pendingTimers = Object.create(null); // caseId → timeout
    let allCasesTimer = null;
    let suspendDepth = 0; // when > 0, do not schedule (used during recovery)

    // Bind originals BEFORE wrapping so recovery can bypass the proxy
    const _origSetItem = localStorage.setItem.bind(localStorage);
    const _origRemoveItem = localStorage.removeItem.bind(localStorage);

    // ── Helpers ──────────────────────────────────────────────────────
    function getCases() {
        try {
            const raw = localStorage.getItem(CASES_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    }

    function findCase({ id, number }) {
        const cases = getCases();
        if (id != null) {
            const found = cases.find(c => String(c.id) === String(id));
            if (found) return found;
        }
        if (number) return cases.find(c => c.caseNumber === number) || null;
        return null;
    }

    function buildSnapshot(caseRecord) {
        const caseId = caseRecord.id;
        const caseNum = caseRecord.caseNumber;

        // Pattern 2 — per-case keys keyed by case.id
        const moduleData = {};
        PATTERN2_PREFIXES.forEach(prefix => {
            const raw = localStorage.getItem(prefix + caseId);
            if (raw == null) return;
            try { moduleData[prefix.slice(0, -1)] = JSON.parse(raw); }
            catch (e) { moduleData[prefix.slice(0, -1)] = raw; }
        });

        // Pattern 1 — shared objects keyed by caseNumber
        const sharedData = {};
        PATTERN1_KEYS.forEach(key => {
            try {
                const all = JSON.parse(localStorage.getItem(key) || '{}');
                if (all && Object.prototype.hasOwnProperty.call(all, caseNum)) {
                    sharedData[key] = all[caseNum];
                }
            } catch (e) { /* skip malformed */ }
        });

        // Tasks for this case
        let tasks = [];
        try {
            const allTasks = JSON.parse(localStorage.getItem(TASK_KEY) || '[]');
            if (Array.isArray(allTasks)) tasks = allTasks.filter(t => t && t.caseId === caseNum);
        } catch (e) { /* ignore */ }

        return {
            _viperExport: true,
            _version: '1.0',
            _snapshot: true,
            _savedAt: new Date().toISOString(),
            _exportedBy: localStorage.getItem('viper_customer_name') || 'Unknown',
            caseMetadata: { ...caseRecord },
            moduleData,
            sharedData,
            tasks
        };
    }

    async function snapshotCase(caseRecord) {
        if (!caseRecord || !caseRecord.caseNumber) return false;
        if (!window.electronAPI || !window.electronAPI.saveCaseSnapshot) return false;
        try {
            // Make sure the case folder exists on disk before writing the snapshot
            if (window.electronAPI.createCaseFolder) {
                try { await window.electronAPI.createCaseFolder(caseRecord.caseNumber); }
                catch (_) { /* non-fatal */ }
            }
            const pkg = buildSnapshot(caseRecord);
            await window.electronAPI.saveCaseSnapshot({
                caseNumber: caseRecord.caseNumber,
                data: JSON.stringify(pkg)
            });
            return true;
        } catch (err) {
            console.warn('[snapshot] failed for', caseRecord.caseNumber, err);
            return false;
        }
    }

    function scheduleFor(caseRecord) {
        if (suspendDepth > 0) return;
        if (!caseRecord || !caseRecord.id) return;
        const id = String(caseRecord.id);
        if (pendingTimers[id]) clearTimeout(pendingTimers[id]);
        pendingTimers[id] = setTimeout(() => {
            delete pendingTimers[id];
            const fresh = findCase({ id });
            if (fresh) snapshotCase(fresh);
        }, DEBOUNCE_MS);
    }

    function scheduleAll() {
        if (suspendDepth > 0) return;
        if (allCasesTimer) clearTimeout(allCasesTimer);
        allCasesTimer = setTimeout(() => {
            allCasesTimer = null;
            const cases = getCases();
            cases.forEach(c => snapshotCase(c));
        }, DEBOUNCE_MS);
    }

    function scheduleFromKey(key) {
        if (typeof key !== 'string' || !key) return;

        // Pattern 2: extract caseId from key suffix
        for (const prefix of PATTERN2_PREFIXES) {
            if (key.startsWith(prefix)) {
                const id = key.slice(prefix.length);
                if (!id) return;
                const c = findCase({ id });
                if (c) scheduleFor(c);
                return;
            }
        }

        // Pattern 1, tasks, or the cases array itself: snapshot everything (debounced)
        if (PATTERN1_SET.has(key) || key === TASK_KEY || key === CASES_KEY) {
            scheduleAll();
        }
    }

    // ── Wrap localStorage.setItem / removeItem ───────────────────────
    localStorage.setItem = function (key, value) {
        _origSetItem(key, value);
        try { scheduleFromKey(key); } catch (_) { /* swallow */ }
    };
    localStorage.removeItem = function (key) {
        _origRemoveItem(key);
        try { scheduleFromKey(key); } catch (_) { /* swallow */ }
    };

    // ── Recovery — back-fill missing data from disk ──────────────────
    async function recover(opts) {
        opts = opts || {};
        const result = { restoredCases: 0, restoredModules: 0, scanned: 0, error: null };
        if (!window.electronAPI || !window.electronAPI.listCaseSnapshots) {
            result.error = 'IPC unavailable';
            return result;
        }

        let snapshots;
        try { snapshots = await window.electronAPI.listCaseSnapshots(); }
        catch (err) { result.error = err.message || String(err); return result; }

        if (!Array.isArray(snapshots) || !snapshots.length) return result;
        result.scanned = snapshots.length;

        // Suspend autosave while we restore so we don't snapshot mid-restore
        suspendDepth += 1;
        try {
            const cases = getCases();

            for (const entry of snapshots) {
                try {
                    const raw = await window.electronAPI.loadCaseSnapshot(entry.caseNumber);
                    if (!raw) continue;
                    const pkg = JSON.parse(raw);
                    if (!pkg || !pkg.caseMetadata) continue;
                    const meta = pkg.caseMetadata;
                    if (!meta.caseNumber) continue;

                    let existing = cases.find(c => c.caseNumber === meta.caseNumber);
                    let caseId;
                    let didCreateCase = false;

                    if (!existing) {
                        // Case is missing from localStorage — restore the case record itself.
                        // Re-use the original id when possible, but ensure no collision with
                        // any other case that may have been created since.
                        let proposedId = meta.id || (Date.now() + Math.floor(Math.random() * 1000));
                        let guard = 0;
                        while (cases.some(c => String(c.id) === String(proposedId)) && guard < 50) {
                            proposedId = Date.now() + Math.floor(Math.random() * 100000) + guard;
                            guard += 1;
                        }
                        caseId = proposedId;
                        const restored = { ...meta, id: caseId };
                        cases.push(restored);
                        didCreateCase = true;
                        result.restoredCases += 1;
                    } else {
                        caseId = existing.id;
                    }

                    // Pattern 2 — only fill keys that are missing/empty (never overwrite)
                    if (pkg.moduleData) {
                        for (const [base, val] of Object.entries(pkg.moduleData)) {
                            const fullKey = base + '_' + caseId;
                            const cur = localStorage.getItem(fullKey);
                            if (cur == null || cur === 'null' || cur === '[]' || cur === '{}') {
                                _origSetItem(fullKey, JSON.stringify(val));
                                result.restoredModules += 1;
                            }
                        }
                    }

                    // Pattern 1 — only fill missing case-number entries within shared stores
                    if (pkg.sharedData) {
                        for (const [storeKey, val] of Object.entries(pkg.sharedData)) {
                            let store = {};
                            try { store = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; }
                            catch (e) { store = {}; }
                            if (!Object.prototype.hasOwnProperty.call(store, meta.caseNumber)) {
                                store[meta.caseNumber] = val;
                                _origSetItem(storeKey, JSON.stringify(store));
                                result.restoredModules += 1;
                            }
                        }
                    }

                    // Tasks — only restore if there are no tasks for this case currently
                    if (Array.isArray(pkg.tasks) && pkg.tasks.length) {
                        let allTasks = [];
                        try { allTasks = JSON.parse(localStorage.getItem(TASK_KEY) || '[]'); }
                        catch (e) { allTasks = []; }
                        if (!Array.isArray(allTasks)) allTasks = [];
                        const hasAny = allTasks.some(t => t && t.caseId === meta.caseNumber);
                        if (!hasAny) {
                            allTasks.push(...pkg.tasks);
                            _origSetItem(TASK_KEY, JSON.stringify(allTasks));
                            result.restoredModules += 1;
                        }
                    }

                    if (didCreateCase) {
                        _origSetItem(CASES_KEY, JSON.stringify(cases));
                    }
                } catch (err) {
                    console.warn('[snapshot] recover failed for', entry && entry.caseNumber, err);
                }
            }
        } finally {
            suspendDepth -= 1;
        }

        return result;
    }

    async function snapshotAllNow() {
        const cases = getCases();
        let ok = 0;
        for (const c of cases) {
            try { if (await snapshotCase(c)) ok += 1; }
            catch (e) { /* ignore */ }
        }
        return { total: cases.length, ok };
    }

    async function flushPending() {
        const ids = Object.keys(pendingTimers);
        for (const id of ids) {
            clearTimeout(pendingTimers[id]);
            delete pendingTimers[id];
            const fresh = findCase({ id });
            if (fresh) await snapshotCase(fresh);
        }
        if (allCasesTimer) {
            clearTimeout(allCasesTimer);
            allCasesTimer = null;
            const cases = getCases();
            for (const c of cases) await snapshotCase(c);
        }
    }

    // Best-effort flush before the window unloads
    window.addEventListener('beforeunload', () => {
        // Synchronous IPC isn't available; we fire the saves and don't await.
        // Most pending writes are debounced ≤800ms, so by the time the user
        // closes a tab/window, the disk is already current.
        try {
            const ids = Object.keys(pendingTimers);
            for (const id of ids) {
                clearTimeout(pendingTimers[id]);
                const fresh = findCase({ id });
                if (fresh) snapshotCase(fresh); // fire-and-forget
            }
            if (allCasesTimer) {
                clearTimeout(allCasesTimer);
                allCasesTimer = null;
                const cases = getCases();
                cases.forEach(c => snapshotCase(c));
            }
        } catch (_) { /* swallow */ }
    });

    // ── Public API ───────────────────────────────────────────────────
    window.viperSnapshot = {
        scheduleFor,
        scheduleAll,
        snapshotCase,
        snapshotAllNow,
        recover,
        buildSnapshot,
        flushPending,
        // Internals (exposed for diagnostic use)
        _origSetItem,
        _origRemoveItem,
        PATTERN1_KEYS,
        PATTERN2_PREFIXES
    };

    // Tag the window so other scripts can detect we're active
    try { window.__viperSnapshotInstalled = true; } catch (_) {}

    if (window.console && console.log) {
        console.log('[snapshot] case-snapshot autosave installed');
    }
})();
