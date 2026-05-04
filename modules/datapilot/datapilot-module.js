/**
 * Datapilot Module — Renderer (orchestrator class)
 *
 * Pattern: same as KikWarrantModule, GoogleWarrantModule.
 * Storage key: `datapilot_${caseId}`  →  { imports: [ DatapilotImport, ... ] }
 *
 * Each DatapilotImport contains the full parsed CSV data plus metadata:
 *   { id, fileName, folderPath, importedAt, deviceInfo, summary, contacts,
 *     messages, calls, calendar, apps, media, files, deleted, appDataIndex,
 *     photoExifByHash, stats, flagged: { contacts:[], messages:[], media:[], ... } }
 */

class DatapilotModule {
    constructor(caseId, caseNumber, caseName) {
        this.caseId = String(caseId);
        this.caseNumber = String(caseNumber);
        this.caseName = caseName || caseNumber;
        this.containerId = null;
        this.data = { imports: [] };
        this.activeImportId = null;
        this.activeTab = 'overview';
        this.ui = null;
        this.coach = null;
    }

    async init(containerId) {
        this.containerId = containerId;
        this.loadData();

        // Lazy-construct UI + analytics
        if (typeof DatapilotUI === 'function') {
            this.ui = new DatapilotUI(this);
        }
        if (typeof DatapilotCoach === 'function') {
            this.coach = new DatapilotCoach(this);
        }

        this.render();

        // Auto-scan if we have no imports yet
        if (!this.data.imports || this.data.imports.length === 0) {
            this.autoScan().catch(err => console.warn('Auto-scan failed:', err));
        }
    }

    loadData() {
        try {
            const raw = localStorage.getItem(`datapilot_${this.caseId}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                this.data = parsed && typeof parsed === 'object' ? parsed : { imports: [] };
                if (!Array.isArray(this.data.imports)) this.data.imports = [];
            }
        } catch (e) {
            console.error('Datapilot loadData error:', e);
            this.data = { imports: [] };
        }
        if (!this.activeImportId && this.data.imports.length) {
            this.activeImportId = this.data.imports[0].id;
        }
    }

    saveData() {
        try {
            localStorage.setItem(`datapilot_${this.caseId}`, JSON.stringify(this.data));
        } catch (e) {
            console.error('Datapilot saveData error:', e);
            if (typeof showToast === 'function') {
                showToast('Failed to save Datapilot data: ' + e.message, 'error');
            }
        }
    }

    getActiveImport() {
        if (!this.activeImportId) return null;
        return this.data.imports.find(i => i.id === this.activeImportId) || null;
    }

    setActiveImport(id) {
        this.activeImportId = id;
        this.activeTab = 'overview';
        this.render();
    }

    setActiveTab(tab) {
        this.activeTab = tab;
        this.render();
    }

    // ─── Scan / Pick / Import ───────────────────────────────────────────

    /**
     * Find Datapilot extractions across THREE sources, merged + deduped:
     *   1. On-disk scan of the case folder (cases/{caseNumber}/Evidence/...)
     *   2. Reference-only entries stored in `viperCaseEvidence` localStorage
     *      (these point at folders OUTSIDE the case dir — typically still on
     *      a USB drive or the analyst's working folder).
     *   3. Already-imported entries in this module's own `data.imports`
     *      (so the user can re-locate one if the renderer state was wiped).
     *
     * Each candidate is { name, path, parent, format, source }.
     * `source` is one of 'disk' | 'evidence' | 'imported' for badge labeling.
     * Paths that no longer exist (USB unplugged, folder moved) are tagged
     * `missing: true` so the UI can render a warning instead of letting the
     * user click an unimportable row.
     */
    async autoScan() {
        if (!window.electronAPI || !window.electronAPI.datapilotScan) return;
        const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const seen = new Map(); // normPath -> candidate
        const addCandidate = (cand) => {
            if (!cand || !cand.path) return;
            const key = norm(cand.path);
            if (!seen.has(key)) { seen.set(key, cand); return; }
            // Prefer disk-source over others if same path appears twice
            const prev = seen.get(key);
            const rank = { disk: 3, evidence: 2, imported: 1 };
            if ((rank[cand.source] || 0) > (rank[prev.source] || 0)) seen.set(key, cand);
        };

        // 1) On-disk scan
        try {
            const res = await window.electronAPI.datapilotScan({ caseNumber: this.caseNumber });
            if (res && res.success && Array.isArray(res.folders)) {
                for (const f of res.folders) {
                    addCandidate({
                        name: f.name,
                        path: f.path,
                        parent: f.parent,
                        format: f.format || 'csv',
                        source: 'disk'
                    });
                }
            }
        } catch (e) { console.warn('autoScan disk:', e); }

        // 2) Evidence module references (works even if folder is on a USB drive)
        try {
            const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
            const list = Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
            for (const ev of list) {
                if (ev && ev.type === 'datapilot' && ev.datapilot && ev.datapilot.folderPath) {
                    const dp = ev.datapilot;
                    const p = dp.folderPath;
                    addCandidate({
                        name: ev.tag || dp.folderName || (p.split(/[\\/]/).pop() || 'Datapilot'),
                        path: p,
                        parent: p.replace(/[\\/][^\\/]+$/, ''),
                        format: dp.format || 'csv',
                        source: 'evidence',
                        referenceOnly: !!dp.referenceOnly,
                        evidenceTag: ev.tag,
                        evidenceId: ev.id
                    });
                }
            }
        } catch (e) { console.warn('autoScan evidence:', e); }

        // 3) Existing imports (re-locate after data wipe)
        try {
            for (const imp of (this.data.imports || [])) {
                if (imp && imp.folderPath) {
                    addCandidate({
                        name: imp.fileName || (imp.folderPath.split(/[\\/]/).pop() || 'Datapilot'),
                        path: imp.folderPath,
                        parent: imp.folderPath.replace(/[\\/][^\\/]+$/, ''),
                        format: imp.format || 'csv',
                        source: 'imported'
                    });
                }
            }
        } catch (_) {}

        // Verify each path is currently reachable (USB may be unplugged).
        // Use the lightweight exists-check, not the full tree-walk.
        const candidates = Array.from(seen.values());
        if (window.electronAPI && window.electronAPI.datapilotFolderExists) {
            await Promise.all(candidates.map(async c => {
                try {
                    const r = await window.electronAPI.datapilotFolderExists({ folderPath: c.path });
                    if (!r || !r.success) return; // inconclusive — leave as not-missing
                    c.missing = !r.exists;
                    c.isDatapilot = !!r.isDatapilot;
                } catch (_) { /* leave missing flag alone */ }
            }));
        }

        if (candidates.length) {
            this._renderScanResult(candidates);
        }
    }

    async pickFolder() {
        if (!window.electronAPI || !window.electronAPI.datapilotPickFolder) {
            this._showError('Datapilot module requires the desktop app');
            return;
        }
        try {
            const res = await window.electronAPI.datapilotPickFolder();
            if (!res) return; // canceled
            if (!res.success) {
                this._showError(res.error || 'Could not select folder');
                return;
            }
            // Multiple Datapilot exports found below the picked folder — let the user choose.
            if (res.multipleFound && Array.isArray(res.candidates) && res.candidates.length) {
                const pick = await this._promptDatapilotCandidate(res.candidates);
                if (!pick) return; // canceled
                await this.importFolder(pick.path, pick.name);
                return;
            }
            await this.importFolder(res.path, res.name);
        } catch (e) {
            this._showError(e.message);
        }
    }

    /**
     * Show a small modal letting the user pick which Datapilot export to import
     * when the picker found multiple candidates beneath their selected folder.
     * Returns the chosen candidate ({path, name, format}) or null on cancel.
     */
    _promptDatapilotCandidate(candidates) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'modal active';
            overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999;';
            const fmtBadge = (f) => {
                const cls = f === 'dpx' ? 'dp-badge-dpx' : 'dp-badge-csv';
                return `<span class="dp-badge ${cls}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:${f==='dpx'?'rgba(0,229,255,0.15)':'rgba(160,160,160,0.15)'};color:${f==='dpx'?'#00e5ff':'#aaa'};margin-left:8px;text-transform:uppercase;font-weight:700;">${f}</span>`;
            };
            const rows = candidates.map((c, i) => `
                <div class="dp-cand-row" data-idx="${i}" style="padding:12px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;margin-bottom:8px;cursor:pointer;background:rgba(255,255,255,0.02);">
                    <div style="font-weight:600;color:#fff;">${this._esc(c.name)}${fmtBadge(c.format)}</div>
                    <div style="font-size:11px;color:#888;margin-top:4px;font-family:monospace;word-break:break-all;">${this._esc(c.parent || '')}</div>
                </div>
            `).join('');
            overlay.innerHTML = `
                <div class="modal-content" style="max-width:640px;width:90%;background:#1B1C20;border:1px solid rgba(0,229,255,0.2);">
                    <div class="modal-header" style="padding:16px;border-bottom:1px solid rgba(255,255,255,0.08);">
                        <h3 style="margin:0;color:#00e5ff;">Multiple Datapilot Exports Found</h3>
                    </div>
                    <div class="modal-body" style="padding:16px;max-height:60vh;overflow-y:auto;">
                        <p style="color:#aaa;margin:0 0 12px 0;font-size:13px;">Select which export to import:</p>
                        ${rows}
                    </div>
                    <div class="modal-footer" style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.08);text-align:right;">
                        <button class="btn btn-secondary" data-action="cancel">Cancel</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const cleanup = (val) => { try { overlay.remove(); } catch (_) {} resolve(val); };
            overlay.querySelectorAll('.dp-cand-row').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.idx, 10);
                    cleanup(candidates[idx]);
                });
            });
            overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        });
    }

    async importFolder(folderPath, displayName) {
        this._showProgress(`Parsing ${displayName || 'Datapilot folder'}…`);
        try {
            const res = await window.electronAPI.datapilotImport({ folderPath });
            if (!res || !res.success) {
                this._showError((res && res.error) || 'Import failed');
                return;
            }
            const data = res.data;
            const id = `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const imp = {
                id,
                fileName: displayName || folderPath.split(/[\\/]/).pop(),
                folderPath,
                format: data.format || 'csv',
                importedAt: new Date().toISOString(),
                deviceInfo: data.deviceInfo,
                summary: data.summary,
                contacts: data.contacts,
                messages: data.messages,
                chats: data.chats || [],          // DPX-only — empty for CSV
                calls: data.calls,
                calendar: data.calendar,
                apps: data.apps,
                media: data.media,
                files: data.files,
                deleted: data.deleted,
                appDataIndex: data.appDataIndex,
                photoExifByHash: data.photoExifByHash,
                stats: data.stats,
                dpxPaths: data.dpxPaths || null,  // DPX-only
                flagged: { contacts: [], messages: [], calls: [], calendar: [], apps: [], media: [], files: [] },
            };
            this.data.imports.push(imp);
            this.activeImportId = id;
            this.activeTab = 'overview';
            this.saveData();
            if (typeof showToast === 'function') {
                const fmtLabel = (data.format || 'csv').toUpperCase();
                showToast(`Imported Datapilot ${fmtLabel} — ${data.stats.contacts} contacts, ${data.stats.messages} messages, ${data.stats.photos + data.stats.videos} media`, 'success');
            }
            this.render();
        } catch (e) {
            this._showError(e.message);
        }
    }

    /**
     * Re-parse the same folder for the active import in-place.  Preserves
     * the import's id, flags, and any user state — only the parsed data
     * arrays are replaced.  Useful when the parser ships fixes (e.g. new
     * CSV sources) and the user doesn't want to lose their flags.
     */
    async rescanActiveImport() {
        const imp = this.getActiveImport();
        if (!imp) return;
        if (!imp.folderPath) {
            if (typeof showToast === 'function') showToast('No folder path stored on this import — re-import manually', 'error');
            return;
        }
        this._showProgress(`Re-scanning ${imp.fileName}…`);
        try {
            const res = await window.electronAPI.datapilotImport({ folderPath: imp.folderPath });
            if (!res || !res.success) {
                this._showError((res && res.error) || 'Re-scan failed');
                return;
            }
            const data = res.data;
            // Preserve id, fileName, importedAt, flags. Replace parsed arrays.
            imp.deviceInfo = data.deviceInfo;
            imp.summary = data.summary;
            imp.contacts = data.contacts;
            imp.messages = data.messages;
            imp.calls = data.calls;
            imp.calendar = data.calendar;
            imp.apps = data.apps;
            imp.media = data.media;
            imp.files = data.files;
            imp.deleted = data.deleted;
            imp.appDataIndex = data.appDataIndex;
            imp.photoExifByHash = data.photoExifByHash;
            imp.stats = data.stats;
            imp.lastRescanAt = new Date().toISOString();
            // Drop stale flag keys that no longer exist after re-parse
            if (imp.flagged) {
                const liveSha = new Set();
                for (const m of (imp.media || [])) {
                    if (m.sha256) liveSha.add(m.sha256);
                    if (m.sha3) liveSha.add(m.sha3);
                }
                if (Array.isArray(imp.flagged.media)) {
                    imp.flagged.media = imp.flagged.media.filter(k => liveSha.has(k) || /^[0-9]+$/.test(k));
                }
            }
            this.saveData();
            // Re-scan keeps the same id, so render()'s id-change cache buster
            // won't fire — invalidate UI caches manually so new media items
            // appear in Artifacts and Comms views.
            if (this.ui) {
                this.ui._allArtifactsCache = null;
                this.ui._contactIndexCache = null;
                if (this.ui._videoThumbCache) this.ui._videoThumbCache.clear();
            }
            if (typeof showToast === 'function') {
                showToast(`Re-scanned — ${data.stats.contacts} contacts, ${data.stats.messages} messages, ${data.stats.photos + data.stats.videos} media`, 'success');
            }
            this.render();
        } catch (e) {
            this._showError(e.message);
        }
    }

    async deleteImport(importId) {
        if (typeof viperConfirm === 'function') {
            const ok = await viperConfirm('Remove this Datapilot import from the case?', { danger: true, okText: 'Remove' });
            if (!ok) return;
        } else if (!confirm('Remove this Datapilot import?')) return;
        this.data.imports = this.data.imports.filter(i => i.id !== importId);
        if (this.activeImportId === importId) {
            this.activeImportId = this.data.imports.length ? this.data.imports[0].id : null;
        }
        this.saveData();
        this.render();
    }

    // ─── Flag-as-evidence ───────────────────────────────────────────────

    /**
     * Toggle a flag on a record within an import.
     * Section is the data array name (contacts|messages|media|...)
     * Key is a stable identifier (uid for messages, sha256 for media, no for contacts).
     */
    toggleFlag(section, key) {
        const imp = this.getActiveImport();
        if (!imp) return false;
        if (!imp.flagged) imp.flagged = {};
        if (!imp.flagged[section]) imp.flagged[section] = [];
        const idx = imp.flagged[section].indexOf(key);
        if (idx >= 0) {
            imp.flagged[section].splice(idx, 1);
        } else {
            imp.flagged[section].push(key);
        }
        this.saveData();
        return idx < 0; // returns true if newly flagged
    }

    isFlagged(section, key) {
        const imp = this.getActiveImport();
        if (!imp || !imp.flagged || !imp.flagged[section]) return false;
        return imp.flagged[section].includes(key);
    }

    flagCount() {
        const imp = this.getActiveImport();
        if (!imp || !imp.flagged) return 0;
        let n = 0;
        for (const k of Object.keys(imp.flagged)) n += (imp.flagged[k] || []).length;
        return n;
    }

    /**
     * Push all flagged items into the case Evidence module as a self-contained
     * bundle. Writes original media + thumbnails + structured report.json +
     * DA-ready report.html into cases/<caseNumber>/Evidence/Datapilot/<bundleId>/
     * so the case can be exported to a DA without VIPER access.
     */
    async pushFlagsToEvidence() {
        const imp = this.getActiveImport();
        if (!imp) return;
        const total = this.flagCount();
        if (total === 0) {
            if (typeof showToast === 'function') showToast('No items flagged yet', 'info');
            return;
        }
        if (!window.electronAPI || !window.electronAPI.datapilotExportFlagsBundle) {
            this._showError('Bundle export requires the desktop app');
            return;
        }
        try {
            this._showProgress(`Building flag bundle (${total} item${total === 1 ? '' : 's'})…`);

            // 1. Resolve flagged keys → full data objects (needed by IPC)
            const resolved = this._resolveFlagged(imp);

            // 2. Generate thumbnails for flagged media in renderer (canvas).
            //    Saves the main process from needing sharp/ffmpeg.
            const thumbsByKey = await this._generateThumbnailsForFlaggedMedia(resolved.media);

            // 3. Identify the next DP-NNN label
            const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
            const list = all[this.caseNumber] || [];
            const dpCount = list.filter(e => e && e.metadata && e.metadata.kind === 'datapilot').length + 1;
            const dpLabel = 'DP-' + String(dpCount).padStart(3, '0');
            const bundleId = `dp_${Date.now()}`;
            const generatedAt = new Date().toISOString();

            // 4. IPC: copy media, write thumbs, report.json + report.html
            this._showProgress(`Writing bundle to case folder…`);
            const res = await window.electronAPI.datapilotExportFlagsBundle({
                caseNumber: this.caseNumber,
                bundleId,
                dpLabel,
                folderPath:  imp.folderPath,
                fileName:    imp.fileName,
                deviceInfo:  imp.deviceInfo || {},
                summary:     imp.summary || {},
                resolved,
                thumbsByKey,
                generatedAt
            });

            if (!res || !res.success) {
                this._showError('Failed to build bundle: ' + (res && res.error ? res.error : 'unknown'));
                return;
            }

            // 5. Build the Evidence record. Files include the report.html
            //    plus all copied media originals so they appear in DA Export.
            const reportHtmlEntry = {
                name: 'report.html',
                path: res.reportHtmlPath,
                size: 0,    // unknown — not critical
                type: 'text/html'
            };
            const ev = {
                id: Date.now(),
                tag: `Datapilot Report — ${imp.fileName} (${dpLabel})`,
                type: 'digital',
                description: `${total} flagged item${total === 1 ? '' : 's'} from Datapilot import. ` +
                             `Bundle includes ${resolved.messages.length} message(s), ` +
                             `${resolved.calls.length} call(s), ` +
                             `${resolved.media.length} media file(s), ` +
                             `${resolved.contacts.length} contact(s).`,
                fileCount: (res.mediaFiles || []).length + 1,
                totalSize: res.totalSize || 0,
                files: [reportHtmlEntry, ...(res.mediaFiles || [])],
                source: 'Datapilot Module',
                collectedDate: generatedAt.split('T')[0],
                createdAt: generatedAt,
                dateAdded: generatedAt,
                metadata: {
                    kind: 'datapilot',
                    bundleId,
                    bundlePath: res.bundlePath,
                    reportJsonPath: res.reportJsonPath,
                    reportHtmlPath: res.reportHtmlPath,
                    dpLabel,
                    fileName: imp.fileName,
                    deviceInfo: imp.deviceInfo || {},
                    flagCount: total,
                    counts: {
                        messages: resolved.messages.length,
                        calls:    resolved.calls.length,
                        contacts: resolved.contacts.length,
                        media:    resolved.media.length
                    }
                }
            };
            list.push(ev);
            all[this.caseNumber] = list;
            localStorage.setItem('viperCaseEvidence', JSON.stringify(all));

            // Refresh in-memory caseEvidence + re-render Evidence tab if visible.
            try {
                if (typeof window !== 'undefined' && typeof window.refreshCaseEvidenceFromStorage === 'function') {
                    window.refreshCaseEvidenceFromStorage();
                }
            } catch (_) { /* non-fatal */ }

            if (typeof showToast === 'function') {
                showToast(`Pushed ${total} flagged item(s) to Evidence as ${dpLabel}`, 'success');
            }
        } catch (e) {
            this._showError('Failed to push to evidence: ' + e.message);
        }
    }

    /**
     * Resolve flag keys into full data objects ready to write to disk.
     * Returns { messages, calls, contacts, media } with all the fields the
     * report viewer/HTML need.
     */
    _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const out = { messages: [], calls: [], contacts: [], media: [] };
        const contactByPhone = new Map();
        for (const c of (imp.contacts || [])) {
            for (const p of (c.phones || [])) {
                const key = String(p).replace(/[^\d+]/g, '').replace(/^\+/, '');
                const last10 = key.slice(-10);
                if (last10) contactByPhone.set(last10, c);
            }
        }
        const lookupContactName = (addr) => {
            if (!addr) return '';
            const last10 = String(addr).replace(/[^\d+]/g, '').replace(/^\+/, '').slice(-10);
            const c = contactByPhone.get(last10);
            return c ? c.name : '';
        };

        // Messages
        for (const k of (f.messages || [])) {
            const m = (imp.messages || []).find(x => x.uid === k);
            if (!m) continue;
            out.messages.push({
                uid: m.uid,
                timestamp: m.timestamp,
                timestampIso: m.timestampIso,
                type: m.type,
                direction: m.direction,
                address: m.address,
                contactName: lookupContactName(m.address),
                text: m.text || ''
            });
        }
        // Sort messages by timestamp ascending (chronological reads better)
        out.messages.sort((a, b) => {
            const da = a.timestampIso ? new Date(a.timestampIso).getTime() : 0;
            const db = b.timestampIso ? new Date(b.timestampIso).getTime() : 0;
            return da - db;
        });

        // Calls
        for (const k of (f.calls || [])) {
            const c = (imp.calls || []).find(x => String(x.no) === String(k));
            if (!c) continue;
            out.calls.push({
                no: c.no,
                direction: c.direction || '',
                address: c.address || c.number || '',
                contactName: lookupContactName(c.address || c.number || ''),
                timestamp: c.timestamp || '',
                timestampIso: c.timestampIso || '',
                duration: c.duration || '',
                summary: c.summary || c.deletedData || ''
            });
        }

        // Contacts
        for (const k of (f.contacts || [])) {
            const c = (imp.contacts || []).find(x => String(x.no) === String(k));
            if (!c) continue;
            out.contacts.push({
                no: c.no,
                name: c.name || '',
                phones: c.phones || [],
                emails: c.emails || [],
                notes: c.notes || '',
                organizations: c.organizations || ''
            });
        }

        // Media — enrich with EXIF GPS + relative path needed by the IPC
        const exifIdx = imp.photoExifByHash || {};
        for (const k of (f.media || [])) {
            // Flag key is sha256 (preferred) or String(no)
            let m = (imp.media || []).find(x => x.sha256 === k);
            if (!m) m = (imp.media || []).find(x => String(x.no) === String(k));
            if (!m) continue;
            const exif = m.exifHash ? exifIdx[m.exifHash] : null;
            const gps = exif && exif.gps;
            out.media.push({
                sha:   (m.sha256 || m.sha3 || '').toLowerCase(),
                sha256: m.sha256 || '',
                sha3:  m.sha3 || '',
                no:    m.no,
                fileName:     m.fileName || '',
                relativePath: m.fileSystemPath || '',  // arg to datapilot-read-media
                previewPath:  m.previewPath || '',
                mediaType:    m.mediaType,
                lastModified: m.lastModified || '',
                sizeBytes:    m.sizeBytes || 0,
                lat: gps && typeof gps.lat === 'number' ? gps.lat : null,
                lng: gps && typeof gps.lng === 'number' ? gps.lng : null
            });
        }

        return out;
    }

    /**
     * Generate JPEG thumbnails (~360px wide) for a list of flagged media
     * items via canvas. Returns { [sha]: 'data:image/jpeg;base64,...' }.
     * Skips audio. Uses a small concurrency cap so a 100-flag bundle doesn't
     * stall the renderer.
     */
    async _generateThumbnailsForFlaggedMedia(mediaList) {
        const out = {};
        const ui = this.ui;
        const items = (mediaList || []).filter(m => m && m.relativePath && m.mediaType !== 'audio');
        if (!items.length || !ui) return out;

        const CONCURRENCY = 3;
        let idx = 0;

        const worker = async () => {
            while (idx < items.length) {
                const my = idx++;
                const m = items[my];
                try {
                    // Prefer cached video thumb (already generated for the artifacts grid)
                    if (m.mediaType === 'video' && ui._videoThumbCache && ui._videoThumbCache.has(m.sha)) {
                        out[m.sha] = ui._videoThumbCache.get(m.sha);
                        continue;
                    }
                    // Get a viper-media:// URL we can load into <img>/<video>
                    const relPath = m.previewPath || m.relativePath;
                    const r = await window.electronAPI.datapilotGetMediaUrl({
                        folderPath: this.getActiveImport().folderPath,
                        relativePath: relPath
                    });
                    if (!r || !r.success || !r.fileUrl) continue;

                    let dataUrl = null;
                    if (m.mediaType === 'video') {
                        dataUrl = await ui._captureVideoFrame(r.fileUrl);
                    } else {
                        // photo / thumbnail / unknown — load into <img>, downscale
                        dataUrl = await this._captureImageThumb(r.fileUrl);
                    }
                    if (dataUrl) out[m.sha] = dataUrl;
                } catch (_) { /* skip — non-fatal */ }
                // Progress nudge every ~5 items so the toast doesn't go silent
                if (my % 5 === 0) {
                    this._showProgress(`Building thumbnails (${my + 1}/${items.length})…`);
                }
            }
        };

        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
        await Promise.all(workers);
        return out;
    }

    /**
     * Load an image URL into a hidden <img>, downscale to ≤320px wide on a
     * canvas, return a JPEG dataURL. Used for photo thumbnails when pushing
     * a flag bundle (the artifact grid uses the original image element so
     * it doesn't need a separate thumb cache).
     */
    _captureImageThumb(url) {
        return new Promise((resolve) => {
            const img = new Image();
            let settled = false;
            const finish = (val) => { if (settled) return; settled = true; resolve(val); };
            const TIMEOUT = 8000;
            const timer = setTimeout(() => finish(null), TIMEOUT);
            img.onload = () => {
                try {
                    const w = img.naturalWidth, h = img.naturalHeight;
                    if (!w || !h) { clearTimeout(timer); return finish(null); }
                    const maxW = 320;
                    const scale = w > maxW ? maxW / w : 1;
                    const cw = Math.max(1, Math.floor(w * scale));
                    const ch = Math.max(1, Math.floor(h * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = cw; canvas.height = ch;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, cw, ch);
                    clearTimeout(timer);
                    finish(canvas.toDataURL('image/jpeg', 0.75));
                } catch (_) {
                    clearTimeout(timer);
                    finish(null);
                }
            };
            img.onerror = () => { clearTimeout(timer); finish(null); };
            img.src = url;
        });
    }

    _buildFlagsSummary(imp) {
        const lines = [`Datapilot Import: ${imp.fileName}`,
                       `Device: ${imp.deviceInfo ? `${imp.deviceInfo.make} ${imp.deviceInfo.model} (${imp.deviceInfo.phoneNumber || 'no number'})` : 'Unknown'}`,
                       `Imported: ${imp.importedAt}`,
                       ''];
        const f = imp.flagged || {};
        if (f.contacts && f.contacts.length) {
            lines.push(`# Flagged Contacts (${f.contacts.length})`);
            for (const k of f.contacts) {
                const c = imp.contacts.find(x => String(x.no) === String(k));
                if (c) lines.push(` • ${c.name || '(no name)'} — ${(c.phones || []).join(', ')}`);
            }
            lines.push('');
        }
        if (f.messages && f.messages.length) {
            lines.push(`# Flagged Messages (${f.messages.length})`);
            for (const k of f.messages) {
                const m = imp.messages.find(x => x.uid === k);
                if (m) lines.push(` • [${m.timestamp}] ${m.direction.toUpperCase()} ${m.address}: ${(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
            }
            lines.push('');
        }
        if (f.media && f.media.length) {
            lines.push(`# Flagged Media (${f.media.length})`);
            for (const k of f.media) {
                const med = imp.media.find(x => x.sha256 === k);
                if (med) lines.push(` • ${med.fileName} (${med.mediaType}, ${med.lastModified || 'unknown'})`);
            }
            lines.push('');
        }
        if (f.calls && f.calls.length) {
            lines.push(`# Flagged Calls (${f.calls.length})`);
            for (const k of f.calls) {
                const c = imp.calls.find(x => String(x.no) === String(k));
                if (c) lines.push(` • Row #${c.no}: ${c.deletedData}`);
            }
        }
        return lines.join('\n');
    }

    // ─── Read media (from Datapilot folder on disk) ─────────────────────

    async readMedia(relativePath) {
        const imp = this.getActiveImport();
        if (!imp || !relativePath) return null;
        try {
            const res = await window.electronAPI.datapilotReadMedia({
                folderPath: imp.folderPath,
                relativePath
            });
            if (res && res.success) {
                return `data:${res.mimeType};base64,${res.data}`;
            }
            return null;
        } catch (e) {
            console.warn('readMedia error:', e);
            return null;
        }
    }

    /**
     * Return a streamable file:// URL — for videos/audio/large files.
     * Avoids the base64 round-trip used by readMedia(). Decrypts to temp
     * when Field Security is on.
     */
    async getMediaUrl(relativePath) {
        const imp = this.getActiveImport();
        if (!imp || !relativePath) return null;
        try {
            const res = await window.electronAPI.datapilotGetMediaUrl({
                folderPath: imp.folderPath,
                relativePath
            });
            if (res && res.success) return res.fileUrl;
            return null;
        } catch (e) {
            console.warn('getMediaUrl error:', e);
            return null;
        }
    }

    // ─── Render ─────────────────────────────────────────────────────────

    render() {
        const root = document.getElementById(this.containerId);
        if (!root) return;
        if (!this.ui) {
            root.innerHTML = '<div class="text-red-400 p-6">Datapilot UI failed to load</div>';
            return;
        }
        this.ui.render(root);
        // Render coach drawer overlay
        if (this.coach) this.coach.render(root);
    }

    _renderScanResult(folders) {
        const usable = folders.filter(f => !f.missing).length;
        const missing = folders.length - usable;
        if (typeof showToast === 'function') {
            const msg = missing > 0
                ? `Found ${folders.length} Datapilot extraction${folders.length === 1 ? '' : 's'} (${missing} unreachable — check USB / paths)`
                : `Found ${folders.length} Datapilot extraction${folders.length === 1 ? '' : 's'} for this case`;
            showToast(msg, missing > 0 ? 'warning' : 'info');
        }
        this.scannedFolders = folders;
        this.render();
    }

    _showError(msg) {
        if (typeof showToast === 'function') showToast(msg, 'error');
        else console.error('Datapilot:', msg);
    }

    _showProgress(msg) {
        if (typeof showToast === 'function') showToast(msg, 'info');
    }

    _esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

// Expose globally for case-detail-with-analytics.html
if (typeof window !== 'undefined') {
    window.DatapilotModule = DatapilotModule;
}
