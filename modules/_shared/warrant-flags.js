/**
 * Generic Warrant Flag-to-Evidence Mixin
 * ---------------------------------------------------------------
 * Shared infrastructure for the per-section flagging system used
 * by every warrant parser module (Discord, Google, Meta, KIK,
 * Snapchat, Aperture).
 *
 * USAGE — in your warrant module class:
 *
 *   class DiscordWarrantModule {
 *     // ... existing constructor / loadData / saveData ...
 *
 *     // Flag storage lives ON the active import record:
 *     //   imp.flagged = { messages:[], ips:[], devices:[], activity:[], servers:[] }
 *     // Keys are stable IDs from the source data (msg.id, ip string, etc.)
 *
 *     toggleFlag(section, key)   { return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this.saveData()); }
 *     isFlagged(section, key)    { return WarrantFlags.isFlagged(this.getActiveImport(), section, key); }
 *     flagCount()                { return WarrantFlags.count(this.getActiveImport()); }
 *     flagCountFor(section)      { return WarrantFlags.countSection(this.getActiveImport(), section); }
 *     getAllFlags()              { return WarrantFlags.all(this.getActiveImport()); }
 *     clearFlags()               { WarrantFlags.clear(this.getActiveImport()); this.saveData(); }
 *
 *     async pushFlagsToEvidence() {
 *       return WarrantFlags.pushToEvidence({
 *         caseNumber:    this.caseNumber,
 *         caseId:        this.caseId,
 *         moduleSlug:    'discord',
 *         moduleLabel:   'Discord Warrant',
 *         moduleFolder:  'DiscordWarrant',
 *         bundlePrefix:  'DW',
 *         evidenceKind:  'warrant-discord',
 *         iconEmoji:     '💬',
 *         getActiveImport: () => this.getActiveImport(),
 *         resolveFlags:    (imp) => this._resolveFlagged(imp),       // your own resolver
 *         getSubjectInfo: (imp) => ({...}),                          // {label:value} pairs
 *         getSourceFileName: (imp) => imp.fileName,
 *         getSectionConfigs: (imp, resolved) => [{ id, title, icon, columns, renderHint, items }, ...]
 *       });
 *     }
 *   }
 *
 * The mixin handles:
 *   • Per-import flag storage init
 *   • Counting (total + per-section)
 *   • Bundle-id generation (e.g. DW-001 numbered against existing
 *     evidence entries with same kind)
 *   • IPC call to warrant-export-flags-bundle
 *   • Insertion of the resulting Evidence record into viperCaseEvidence
 *   • Toast feedback
 */

(function (global) {
    'use strict';

    const WarrantFlags = {

        // ─── Storage helpers ───────────────────────────────────────────
        _ensure(imp) {
            if (!imp) return null;
            if (!imp.flagged || typeof imp.flagged !== 'object') imp.flagged = {};
            return imp.flagged;
        },

        toggle(imp, section, key, persist) {
            const f = this._ensure(imp);
            if (!f) return false;
            if (!Array.isArray(f[section])) f[section] = [];
            const skey = String(key);
            const idx = f[section].indexOf(skey);
            if (idx >= 0) f[section].splice(idx, 1);
            else f[section].push(skey);
            if (typeof persist === 'function') persist();
            return idx < 0; // true if newly flagged
        },

        isFlagged(imp, section, key) {
            if (!imp || !imp.flagged || !Array.isArray(imp.flagged[section])) return false;
            return imp.flagged[section].indexOf(String(key)) >= 0;
        },

        count(imp) {
            if (!imp || !imp.flagged) return 0;
            let n = 0;
            for (const k of Object.keys(imp.flagged)) {
                n += (imp.flagged[k] || []).length;
            }
            return n;
        },

        countSection(imp, section) {
            if (!imp || !imp.flagged || !Array.isArray(imp.flagged[section])) return 0;
            return imp.flagged[section].length;
        },

        all(imp) {
            if (!imp || !imp.flagged) return {};
            const out = {};
            for (const k of Object.keys(imp.flagged)) {
                out[k] = (imp.flagged[k] || []).slice();
            }
            return out;
        },

        clear(imp) {
            if (imp) imp.flagged = {};
        },

        // ─── Bundle ID generator ───────────────────────────────────────
        // Counts existing evidence entries with the same metadata.kind
        // and returns the next "{prefix}-NNN" label.
        nextBundleLabel(caseNumber, evidenceKind, prefix) {
            try {
                const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
                const list = all[caseNumber] || [];
                const n = list.filter(e =>
                    e && e.metadata && e.metadata.kind === evidenceKind
                ).length + 1;
                return `${prefix}-${String(n).padStart(3, '0')}`;
            } catch (_) {
                return `${prefix}-${String(Date.now()).slice(-3)}`;
            }
        },

        // ─── Push to Evidence (the main entrypoint) ────────────────────
        async pushToEvidence(opts) {
            const {
                caseNumber, caseId,
                moduleSlug, moduleLabel, moduleFolder, bundlePrefix,
                evidenceKind,    // viperCaseEvidence metadata.kind discriminator
                iconEmoji,       // for the Evidence card label
                getActiveImport,
                resolveFlags,
                getSubjectInfo,
                getSourceFileName,
                getSectionConfigs
            } = opts || {};

            const imp = (typeof getActiveImport === 'function') ? getActiveImport() : null;
            if (!imp) return { success: false, error: 'No active import.' };

            const total = this.count(imp);
            if (total === 0) {
                this._toast('No items flagged yet — click 🚩 on items first.', 'info');
                return { success: false, error: 'No flags' };
            }

            if (!global.electronAPI || !global.electronAPI.warrantExportFlagsBundle) {
                this._toast('Bundle export requires the desktop app', 'error');
                return { success: false, error: 'Desktop API missing' };
            }

            this._toast(`Building flag bundle (${total} item${total === 1 ? '' : 's'})…`, 'info');

            try {
                // 1. Resolve flag keys → full data objects
                const resolved = (typeof resolveFlags === 'function')
                    ? await resolveFlags(imp)
                    : {};

                // 2. Build section configs (per-module)
                const sectionConfigs = (typeof getSectionConfigs === 'function')
                    ? await getSectionConfigs(imp, resolved)
                    : [];

                // 3. Pull items out of section configs into a sections map
                const sections = {};
                const sectionConfigsForReport = sectionConfigs.map(cfg => {
                    const out = {
                        id: cfg.id,
                        title: cfg.title,
                        icon: cfg.icon || '',
                        columns: Array.isArray(cfg.columns) ? cfg.columns : [],
                        renderHint: cfg.renderHint || (cfg.columns && cfg.columns.length ? 'table' : 'pre'),
                        emptyText: cfg.emptyText || ''
                    };
                    sections[cfg.id] = Array.isArray(cfg.items) ? cfg.items : [];
                    return out;
                });

                // 4. Mint a bundle label/id
                const bundleLabel = this.nextBundleLabel(caseNumber, evidenceKind, bundlePrefix);
                const bundleId    = `${(bundlePrefix || 'WR').toLowerCase()}_${Date.now()}`;
                const generatedAt = new Date().toISOString();

                // 5. IPC: write report.json + report.html
                const subjectInfo = (typeof getSubjectInfo === 'function')
                    ? (getSubjectInfo(imp) || {})
                    : {};
                const sourceFileName = (typeof getSourceFileName === 'function')
                    ? (getSourceFileName(imp) || '')
                    : '';

                const res = await global.electronAPI.warrantExportFlagsBundle({
                    caseNumber, bundleId,
                    moduleSlug, moduleLabel, moduleFolder, bundleLabel,
                    sourceFileName, subjectInfo,
                    sectionConfigs: sectionConfigsForReport,
                    sections,
                    generatedAt
                });

                if (!res || !res.success) {
                    this._toast('Failed to build bundle: ' + (res && res.error ? res.error : 'unknown'), 'error');
                    return { success: false, error: res && res.error };
                }

                // 6. Build the Evidence record (mirrors Datapilot pattern)
                const reportHtmlEntry = {
                    name: 'report.html',
                    path: res.reportHtmlPath,
                    size: 0,
                    type: 'text/html'
                };

                const counts = res.counts || {};
                const countsSummary = sectionConfigsForReport
                    .filter(c => (counts[c.id] || 0) > 0)
                    .map(c => `${counts[c.id]} ${c.title.toLowerCase()}`)
                    .join(', ');

                const ev = {
                    id: Date.now(),
                    tag: `${moduleLabel} Report — ${sourceFileName || imp.fileName || 'import'} (${bundleLabel})`,
                    type: 'digital',
                    description: `${total} flagged item${total === 1 ? '' : 's'} from ${moduleLabel}.` +
                                 (countsSummary ? ` Bundle includes ${countsSummary}.` : ''),
                    fileCount: 1,
                    totalSize: 0,
                    files: [reportHtmlEntry],
                    source: `${moduleLabel} Module`,
                    collectedDate: generatedAt.split('T')[0],
                    createdAt: generatedAt,
                    dateAdded: generatedAt,
                    metadata: {
                        kind: evidenceKind,
                        moduleSlug,
                        moduleLabel,
                        moduleFolder,
                        iconEmoji: iconEmoji || '📄',
                        bundleId,
                        bundleLabel,
                        bundlePath:    res.bundlePath,
                        reportJsonPath: res.reportJsonPath,
                        reportHtmlPath: res.reportHtmlPath,
                        fileName: sourceFileName || imp.fileName || '',
                        subjectInfo,
                        flagCount: total,
                        counts
                    }
                };

                // 7. Persist into viperCaseEvidence
                const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
                if (!Array.isArray(all[caseNumber])) all[caseNumber] = [];
                all[caseNumber].push(ev);
                localStorage.setItem('viperCaseEvidence', JSON.stringify(all));

                // 8. Refresh in-memory caseEvidence + re-render Evidence tab if visible
                try {
                    if (typeof global.refreshCaseEvidenceFromStorage === 'function') {
                        global.refreshCaseEvidenceFromStorage();
                    }
                } catch (_) { /* non-fatal */ }

                this._toast(`Pushed ${total} flagged item(s) to Evidence as ${bundleLabel}`, 'success');
                return { success: true, bundleLabel, bundleId, evidence: ev };

            } catch (e) {
                console.error(`${moduleLabel} push to evidence failed:`, e);
                this._toast('Failed to push to evidence: ' + (e.message || e), 'error');
                return { success: false, error: e.message };
            }
        },

        // ─── Toast helper (uses showToast if available, falls back to alert) ──
        _toast(msg, type) {
            try {
                if (typeof global.showToast === 'function') {
                    global.showToast(msg, type || 'info');
                    return;
                }
            } catch (_) { /* ignore */ }
            console.log(`[WarrantFlags ${type || 'info'}] ${msg}`);
        }
    };

    global.WarrantFlags = WarrantFlags;
})(typeof window !== 'undefined' ? window : globalThis);
