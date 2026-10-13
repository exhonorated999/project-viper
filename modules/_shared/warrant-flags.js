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
 *   • Source Validation (optional): when the module supplies
 *       getSourceSpec(imp)        → { source:{path,entry?,inZip?,extraPaths?}, expected? }
 *       getItemCitation(id, item, imp) → { values:[primary, ...corroborating], memberHints:[...] } | null
 *     every flagged item is searched for, word for word, in the original
 *     return and the report records where it was found (file › line/page)
 *     plus the original's SHA-256 and whether it still matches the
 *     fingerprint taken at import. A failure here never blocks the push.
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
                getSectionConfigs,
                getSourceSpec,
                getItemCitation
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

                // 5b. Source Validation — where each item sits in the original.
                const sv = await this._citeSections(imp, sectionConfigsForReport, sections, getSourceSpec, getItemCitation);

                const res = await global.electronAPI.warrantExportFlagsBundle({
                    caseNumber, bundleId,
                    moduleSlug, moduleLabel, moduleFolder, bundleLabel,
                    sourceFileName, subjectInfo,
                    sectionConfigs: sectionConfigsForReport,
                    sections,
                    generatedAt,
                    provenance: sv ? sv.provenance : null,
                    citations:  sv ? sv.citations : null
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
                        counts,
                        sourceValidation: sv ? {
                            integrity: sv.provenance.integrity,
                            sha256: sv.provenance.sha256 || null,
                            found: sv.summary.found,
                            related: sv.summary.related,
                            notFound: sv.summary.notFound,
                            notChecked: sv.summary.notChecked
                        } : null
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

        /**
         * Search the original return for every flagged item and hash it.
         * Returns null when the module has not opted in or the desktop API is
         * missing; otherwise { provenance, citations:{sectionId:[cite|null]}, summary }.
         * Never throws — validation must not be the reason a push fails.
         */
        async _citeSections(imp, configs, sections, getSourceSpec, getItemCitation) {
            const api = global.electronAPI;
            if (typeof getSourceSpec !== 'function' || typeof getItemCitation !== 'function') return null;
            if (!api || typeof api.sourceCiteBatch !== 'function' || typeof api.sourceHash !== 'function') return null;
            let spec;
            try { spec = getSourceSpec(imp); } catch (_) { spec = null; }
            if (!spec || !spec.source || !spec.source.path) return null;

            const provenance = {
                checkedAt: new Date().toISOString(),
                fileName: String(spec.source.path).split(/[\\/]/).pop(),
                path: spec.source.path,
                entry: spec.source.entry || '',
                integrity: 'unknown',
                recorded: spec.expected || null
            };
            const citations = {};
            const summary = { found: 0, related: 0, notFound: 0, notChecked: 0, notApplicable: 0 };

            this._toast('Checking flagged items against the original return…', 'info');

            // Integrity first: the officer needs to know the file is unchanged
            // before a line number in it means anything.
            try {
                const h = await api.sourceHash({ source: spec.source, expected: spec.expected || null });
                if (h && h.ok) {
                    provenance.scope = h.scope;
                    provenance.sha256 = h.contentSha256 || null;
                    if (h.container) { provenance.containerSha256 = h.container.sha256; provenance.size = h.container.size; provenance.encryptedAtRest = !!h.container.encryptedAtRest; }
                    if (h.member && h.member.sha256) { provenance.memberName = h.member.name; provenance.memberSha256 = h.member.sha256; }
                    if (h.folder) { provenance.fileCount = h.folder.fileCount; provenance.size = h.folder.totalBytes; provenance.manifestSha256 = h.folder.manifestSha256; }
                    provenance.integrity = spec.expected ? (h.status || 'unknown') : 'none';
                } else {
                    provenance.integrity = h && h.missing ? 'missing' : (h && h.locked ? 'locked' : 'unknown');
                    provenance.error = (h && h.error) || '';
                }
            } catch (e) { provenance.error = (e && e.message) || String(e); }

            const queries = [];
            for (const cfg of configs) {
                const items = sections[cfg.id] || [];
                citations[cfg.id] = items.map(() => null);
                items.forEach((item, i) => {
                    let q = null;
                    try { q = getItemCitation(cfg.id, item, imp); } catch (_) { q = null; }
                    const vals = q && Array.isArray(q.values) ? q.values.map(v => v == null ? '' : String(v).trim()) : [];
                    if (!vals.length || !vals.some(Boolean)) { citations[cfg.id][i] = { notApplicable: true }; summary.notApplicable++; return; }
                    queries.push({ id: cfg.id + '\u0001' + i, values: vals, memberHints: (q && q.memberHints) || [],
                                   record: (q && q.record) || undefined });
                });
            }

            if (queries.length && provenance.integrity !== 'missing') {
                let r = null;
                try { r = await api.sourceCiteBatch({ source: spec.source, items: queries }); }
                catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
                const byId = new Map(((r && r.results) || []).map(x => [x && x.id, x]));
                if (r && r.locked) provenance.citeNote = 'locked';
                else if (!r || !r.ok) provenance.citeNote = (r && r.error) || 'The original could not be searched.';
                for (const q of queries) {
                    const [sid, idx] = q.id.split('\u0001');
                    const x = byId.get(q.id);
                    let c;
                    if (!x || x.notChecked || !r || !r.ok) { c = { notChecked: true }; summary.notChecked++; }
                    else if (!x.found) { c = { found: false }; summary.notFound++; }
                    else {
                        c = { found: true, member: x.member, line: x.line || null, page: x.page || null,
                              matchKind: x.matchKind || 'exact', primaryFound: x.primaryFound !== false,
                              corroborated: x.corroborated || 0,
                              table: x.table || null, rowid: x.rowid != null ? x.rowid : null };
                        // The value itself was not found; only a related record was.
                        if (c.primaryFound) summary.found++; else summary.related++;
                    }
                    citations[sid][+idx] = c;
                }
            } else if (queries.length) {
                for (const q of queries) { const [sid, idx] = q.id.split('\u0001'); citations[sid][+idx] = { notChecked: true }; summary.notChecked++; }
            }
            provenance.summary = summary;
            return { provenance, citations, summary };
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
