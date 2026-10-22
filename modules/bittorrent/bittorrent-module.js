/**
 * BitTorrent tab (Torrential Downpour) — renderer module.
 * Keeps the small per-download records in localStorage (bittorrent_<caseId>)
 * and talks to modules/bittorrent/bt-main.js over IPC. The parsed model
 * itself lives on disk at cases/<n>/BitTorrent/<downloadId>.json.
 */
(function (root) {
    'use strict';

    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

    class BitTorrentModule {
        constructor(caseId, caseNumber, caseName) {
            this.caseId = String(caseId);
            this.caseNumber = String(caseNumber || caseId);
            this.caseName = caseName || `Case ${caseId}`;
            this.imports = [];
            this.evidenceDownloads = [];
            this.ui = null;
            this.job = null;          // { jobId, label }
            this._modelCache = null;  // { id, model }
        }

        get storageKey() { return `bittorrent_${this.caseId}`; }

        async init(containerId) {
            this.loadData();
            try { this.upgradeEvidenceType(); } catch (_) { /* non-fatal */ }
            if (root.BitTorrentUI) {
                this.ui = new root.BitTorrentUI(containerId, this);
                root.bitTorrentUI = this.ui;
                this.ui.render();
            }
            this.scanEvidence().catch(err => console.warn('BitTorrent evidence scan:', err));
            return this;
        }

        loadData() {
            try {
                const raw = localStorage.getItem(this.storageKey);
                const d = raw ? JSON.parse(raw) : null;
                this.imports = d && Array.isArray(d.imports) ? d.imports : [];
            } catch (e) {
                console.error('BitTorrent: stored list unreadable', e);
                this.imports = [];
            }
        }

        saveData() {
            localStorage.setItem(this.storageKey, JSON.stringify({ imports: this.imports }));
        }

        _api() { return (typeof window !== 'undefined' && window.electronAPI) || {}; }

        _evidenceList() {
            try {
                const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
                return Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
            } catch (_) { return []; }
        }

        /** Folders behind Evidence items added as links (files stay where they are). */
        _evidenceReferencePaths() {
            const out = [];
            for (const ev of this._evidenceList()) {
                if (!ev || ev.released || !(ev.referenceOnly || ev.storageMode === 'reference')) continue;
                if (ev.sourcePath) out.push(String(ev.sourcePath));
                for (const f of (Array.isArray(ev.files) ? ev.files : [])) {
                    if (f && f.path && /(^|[\\/])(details|summary)(_\d+)?\.txt$/i.test(String(f.path))) out.push(String(f.path));
                }
            }
            return Array.from(new Set(out)).slice(0, 200);
        }

        async scanEvidence() {
            const api = this._api();
            if (!api.btScan) return [];
            const res = await api.btScan({ caseNumber: this.caseNumber, extraPaths: this._evidenceReferencePaths() });
            this.evidenceDownloads = res && res.success ? res.downloads : [];
            if (this.ui && this.ui.renderEvidenceHint) this.ui.renderEvidenceHint();
            return this.evidenceDownloads;
        }

        /** Import record already covering this TD download folder, if any. */
        findImportFor(d) {
            const keys = [norm(d.caseDir), norm(d.logsDir)];
            return this.imports.find(i => {
                const s = i.storage || {};
                return keys.includes(norm(s.caseDir)) || keys.includes(norm(s.sourceCaseDir));
            }) || null;
        }

        evidenceCandidates() {
            return (this.evidenceDownloads || []).map(d => Object.assign({}, d, { alreadyImported: !!this.findImportFor(d) }));
        }

        async pickSource() {
            const api = this._api();
            if (!api.btPickSource) throw new Error('BitTorrent import needs the VIPER desktop app.');
            const res = await api.btPickSource();
            if (!res) return null;
            res.downloads = (res.downloads || []).map(d => Object.assign(d, { alreadyImported: !!this.findImportFor(d) }));
            return res;
        }

        /**
         * Parse one TD download; mode 'copy' also copies it into
         * Evidence/BitTorrent/<IP folder>/<download folder>/ and adds an
         * Evidence item. Downloads already inside the case are never copied.
         */
        async importDownload(d, opts) {
            opts = opts || {};
            const api = this._api();
            if (!api.btImport) throw new Error('BitTorrent import needs the VIPER desktop app.');
            const mode = opts.mode === 'copy' && !d.inCase ? 'copy' : 'inplace';
            const jobId = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            this.job = { jobId, label: d.ipFolder || d.caseFolder || d.caseDir };
            const off = api.onBtProgress ? api.onBtProgress((p) => {
                if (p && p.jobId === jobId && typeof opts.onProgress === 'function') opts.onProgress(p);
            }) : null;
            try {
                const res = await api.btImport({ jobId, caseNumber: this.caseNumber, sourceDir: d.caseDir, mode });
                if (!res || !res.success) {
                    const e = new Error((res && res.error) || 'Import failed.');
                    e.code = res && res.code; e.cancelled = !!(res && res.cancelled);
                    throw e;
                }
                const meta = res.meta;
                if (res.copied) meta.evidenceId = this.addEvidenceItem(meta, res.copied);
                const at = this.imports.findIndex(i => i.id === meta.id);
                const replaced = at >= 0;
                if (replaced) {
                    const prev = this.imports[at];
                    if (!meta.evidenceId && prev.evidenceId) meta.evidenceId = prev.evidenceId;
                    if (prev.arin && !meta.arin) meta.arin = prev.arin;
                    this.imports[at] = meta;
                } else {
                    this.imports.push(meta);
                }
                this.saveData();
                if (this._modelCache && this._modelCache.id === meta.id) this._modelCache = null;
                return { meta, replaced, copied: res.copied };
            } finally {
                if (off) off();
                this.job = null;
            }
        }

        async cancel() {
            const api = this._api();
            if (this.job && api.btCancel) await api.btCancel({ jobId: this.job.jobId });
        }

        /**
         * Evidence item for a download copied in from outside the case. Only
         * the log files are listed: the downloaded media stays in the copied
         * Download folder and is never part of an Evidence export.
         */
        addEvidenceItem(meta, copied) {
            let all = {};
            try { all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}'); } catch (_) { all = {}; }
            const list = Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
            const now = new Date().toISOString();
            const id = Date.now();
            const when = meta.startedAt ? String(meta.startedAt).slice(0, 16) : 'unknown date';
            const ev = {
                id,
                type: 'bittorrent',
                tag: 'BitTorrent',
                description: `Torrential Downpour download from ${meta.ip || 'unknown IP'}${meta.port ? ':' + meta.port : ''}, started ${when}` +
                    `${meta.torrentName ? ' — torrent "' + meta.torrentName + '"' : ''}. Logs copied into the case; ` +
                    `${copied.mediaFiles} downloaded file(s) kept in the case folder and not listed here.`,
                location: copied.dest,
                fileCount: copied.logFiles.length,
                totalSize: copied.logFiles.reduce((a, f) => a + (f.size || 0), 0),
                files: copied.logFiles.map(f => ({ name: f.name, path: f.path, size: f.size, type: 'text/plain' })),
                storageMode: 'copy',
                source: 'BitTorrent tab',
                collectedDate: now.split('T')[0],
                createdAt: now,
                dateAdded: now,
                metadata: { kind: 'bittorrent', downloadId: meta.id, folder: copied.dest, mediaFiles: copied.mediaFiles, infoHash: meta.infoHash || null }
            };
            list.push(ev);
            all[this.caseNumber] = list;
            localStorage.setItem('viperCaseEvidence', JSON.stringify(all));
            try { if (typeof window.refreshCaseEvidenceFromStorage === 'function') window.refreshCaseEvidenceFromStorage(); } catch (_) { /* non-fatal */ }
            try {
                if (typeof window.audit === 'function') window.audit('evidence_added', { case_number: this.caseNumber, case_id: this.caseId, evidence_id: id, type: 'bittorrent', tag: 'BitTorrent', storage_mode: 'copy' });
            } catch (_) { /* non-fatal */ }
            return id;
        }

        async loadModel(id) {
            if (this._modelCache && this._modelCache.id === id) return this._modelCache.model;
            const api = this._api();
            if (!api.btRead) throw new Error('Needs the VIPER desktop app.');
            const res = await api.btRead({ caseNumber: this.caseNumber, downloadId: id });
            if (!res || !res.success) { const e = new Error((res && res.error) || 'Could not read the parsed download.'); e.code = res && res.code; throw e; }
            this._modelCache = { id, model: res.model };
            return res.model;
        }

        /** Remove from this tab (parsed results only — Evidence files stay). */
        async removeImport(id) {
            const api = this._api();
            if (api.btDelete) await api.btDelete({ caseNumber: this.caseNumber, downloadId: id });
            this.imports = this.imports.filter(i => i.id !== id);
            if (this._modelCache && this._modelCache.id === id) this._modelCache = null;
            this.saveData();
        }

        itemCount() { return this.imports.length; }

        /** Items made by the first build were filed as generic Digital Evidence. */
        upgradeEvidenceType() {
            let all;
            try { all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}'); } catch (_) { return 0; }
            const list = Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
            let n = 0;
            list.forEach(ev => { if (ev && ev.metadata && ev.metadata.kind === 'bittorrent' && ev.type !== 'bittorrent') { ev.type = 'bittorrent'; n++; } });
            if (n) {
                localStorage.setItem('viperCaseEvidence', JSON.stringify(all));
                try { if (typeof window.refreshCaseEvidenceFromStorage === 'function') window.refreshCaseEvidenceFromStorage(); } catch (_) { /* non-fatal */ }
            }
            return n;
        }

        /** ARIN WHOIS for the suspect IP; the answer is kept on the download record. */
        async lookupArin(id) {
            const imp = this.imports.find(i => i.id === id);
            if (!imp || !imp.ip) throw new Error('This download has no suspect IP address.');
            const api = this._api();
            if (!api.arinLookup) throw new Error('ARIN lookup needs the VIPER desktop app.');
            const r = await api.arinLookup(imp.ip);
            if (!r || !r.success || !(r.provider || r.org)) throw new Error((r && r.error) || 'ARIN returned no result for this address.');
            imp.arin = { ip: imp.ip, provider: r.provider || '', org: r.org || '', network: r.network || '', netRange: r.netRange || '', country: r.country || '', lookedUpAt: new Date().toISOString() };
            this.saveData();
            return imp.arin;
        }

        /** Identifiers offered to the Suspect / Victim / Other Individual Send-To dialog. */
        sendItems(id) {
            const imp = this.imports.find(i => i.id === id);
            if (!imp || !imp.ip) return [];
            const when = imp.startedAt ? String(imp.startedAt).slice(0, 16) + (imp.gmtOffsetMin != null ? ' ' + gmtLabel(imp.gmtOffsetMin) : '') : '';
            const note = `BitTorrent (Torrential Downpour) download${when ? ' started ' + when : ''}${imp.port ? ', port ' + imp.port : ''}` +
                `${imp.infoHash ? ', info hash ' + imp.infoHash : ''}`;
            const items = [{ key: 'ip', label: 'IP Address', value: imp.ip, espName: 'BitTorrent', meta: note, provider: (imp.arin && imp.arin.provider) || '' }];
            const clients = (imp.summary && imp.summary.clients) || [];
            if (clients[0] && clients[0].label) {
                const TM = (typeof window !== 'undefined' && window.TdModel) || null;
                const tag = (/\((-[A-Za-z~]{2}[0-9A-Za-z]{4}-)\)/.exec(clients[0].label) || [])[1];
                const prof = TM && tag && TM.clientProfile ? TM.clientProfile(TM.decodeClient(tag).code) : null;
                const runs = prof ? ` (${prof.kind}; runs on ${prof.platforms.map(k => (TM.PLATFORM_LABELS || {})[k] || k).join(', ')})` : '';
                items.push({ key: 'note', label: 'Client', value: `BitTorrent client seen at ${imp.ip}: ${clients[0].label}${runs}` });
            }
            return items;
        }
    }

    function gmtLabel(min) {
        const s = min < 0 ? '-' : '+', a = Math.abs(min);
        return `GMT${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = BitTorrentModule;
    root.BitTorrentModule = BitTorrentModule;
})(typeof window !== 'undefined' ? window : globalThis);
