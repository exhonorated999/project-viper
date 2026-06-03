/**
 * Cellebrite (Mobile Forensics) — Renderer orchestrator
 * ─────────────────────────────────────────────────────────────────────────
 * Pattern: mirrors DatapilotModule / DiscordWarrantModule.
 *
 * localStorage key: `cellebriteImport_${caseId}` → { imports: [ Import, ... ] }
 *
 * IMPORTANT — storage split:
 *   - localStorage holds the INDEX ONLY: { id, evidenceTag, deviceLabel,
 *     sourceMode, ufdxPath, bundleSize, createdAt, counts, flagged, status }.
 *   - Actual rows (contacts, sms, calls, ...) live on disk at
 *     cases/{caseNumber}/Cellebrite/{importId}/parsed/{surface}.json
 *     and are loaded lazily via electronAPI.cellebriteReadParsed.
 *
 * This is the only warrant module that breaks the "all data in localStorage"
 * convention — required because mmssms.db can yield 10MB+ JSON.
 */

class CellebriteModule {
    constructor(caseId, caseNumber, caseName) {
        this.caseId = String(caseId);
        this.caseNumber = String(caseNumber);
        this.caseName = caseName || caseNumber;
        this.containerId = null;
        this.data = { imports: [] };
        this.activeImportId = null;
        this.activeSubTab = 'device';
        this.ui = null;
        // Parsed-data cache: importId → { surface → data }
        this._parsedCache = new Map();
    }

    async init(containerId) {
        this.containerId = containerId;
        this.loadData();

        if (typeof CellebriteUI === 'function') {
            this.ui = new CellebriteUI(this);
        }
        if (typeof CellebriteCoach === 'function') {
            this.coach = new CellebriteCoach(this);
        }

        this.render();
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    loadData() {
        try {
            const raw = localStorage.getItem(`cellebriteImport_${this.caseId}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                this.data = parsed && typeof parsed === 'object' ? parsed : { imports: [] };
                if (!Array.isArray(this.data.imports)) this.data.imports = [];
            }
        } catch (e) {
            console.error('[Cellebrite] loadData error:', e);
            this.data = { imports: [] };
        }
        if (!this.activeImportId && this.data.imports.length) {
            this.activeImportId = this.data.imports[0].id;
        }
    }

    saveData() {
        try {
            localStorage.setItem(`cellebriteImport_${this.caseId}`, JSON.stringify(this.data));
        } catch (e) {
            console.error('[Cellebrite] saveData error:', e);
            if (typeof viperToast === 'function') {
                viperToast('Failed to save Cellebrite index: ' + e.message, 'error');
            }
        }
    }

    getActiveImport() {
        if (!this.activeImportId) return null;
        return this.data.imports.find(i => i.id === this.activeImportId) || null;
    }

    setActiveImport(id) {
        this.activeImportId = id;
        this.activeSubTab = 'device';
        this._parsedCache.delete(id); // force re-fetch on switch
        this.render();
    }

    setActiveSubTab(tab) {
        this.activeSubTab = tab;
        this.render();
    }

    // ─── Lazy parsed-data load (disk → memory) ───────────────────────────

    async loadSurface(importId, surface) {
        let bucket = this._parsedCache.get(importId);
        if (bucket && bucket[surface] !== undefined) return bucket[surface];

        if (!window.electronAPI || !window.electronAPI.cellebriteReadParsed) {
            return null;
        }
        const r = await window.electronAPI.cellebriteReadParsed({
            caseNumber: this.caseNumber,
            importId,
            surface
        });
        if (!r || !r.success) {
            // Surface locked-vault state — bubbles to the UI which renders
            // a "Field Security is locked" banner instead of an empty pane.
            if (r && r.locked) {
                this._lastLoadError = { locked: true, error: r.error || 'Field Security locked' };
                if (typeof viperToast === 'function') {
                    try { viperToast('Field Security is locked — unlock to view Cellebrite data', 'warning'); } catch (_) {}
                }
            } else if (r && r.error) {
                this._lastLoadError = { locked: false, error: r.error };
            }
            return null;
        }
        this._lastLoadError = null;

        if (!bucket) { bucket = {}; this._parsedCache.set(importId, bucket); }
        bucket[surface] = r.data;
        return r.data;
    }

    // ─── Pick / scan / import flow ───────────────────────────────────────

    async pickBundle() {
        if (!window.electronAPI || !window.electronAPI.cellebritePickBundle) {
            if (typeof viperToast === 'function') {
                viperToast('Electron IPC unavailable', 'error');
            }
            return null;
        }
        const r = await window.electronAPI.cellebritePickBundle();
        if (!r || !r.success) {
            if (r && !r.cancelled && r.error && typeof viperToast === 'function') {
                viperToast('Pick failed: ' + r.error, 'error');
            }
            return null;
        }
        return r; // { ufdxPath, parentDir, bundleSize }
    }

    async scanBundle(ufdxPath) {
        if (!window.electronAPI || !window.electronAPI.cellebriteScanBundle) return null;
        return window.electronAPI.cellebriteScanBundle({ ufdxPath });
    }

    /**
     * Full import orchestration. Caller must pass:
     *   picked          — return value of pickBundle()
     *   scan            — return value of scanBundle()
     *   sourceMode      — 'imported' | 'referenced'
     *   evidenceTag     — optional string label
     *   onProgress      — fn(payloadFromIPC)
     *
     * Returns the IPC import result (with importId, counts, error, cancelled).
     * On success, appends to localStorage index and triggers re-render.
     */
    async importBundle({ picked, scan, sourceMode = 'referenced', evidenceTag = null, onProgress = null }) {
        if (!window.electronAPI || !window.electronAPI.cellebriteImport) {
            if (typeof viperToast === 'function') viperToast('Electron IPC unavailable', 'error');
            return { success: false, error: 'no IPC' };
        }
        if (!picked || !picked.ufdxPath) {
            return { success: false, error: 'no bundle picked' };
        }

        // Listen for progress events for the lifetime of this import.
        let progressUnsub = null;
        if (onProgress && window.electronAPI.onCellebriteImportProgress) {
            progressUnsub = window.electronAPI.onCellebriteImportProgress((payload) => {
                try { onProgress(payload); } catch (_) {}
            });
        }

        try {
            const deviceLabel =
                (scan && scan.ufds && scan.ufds[0] && scan.ufds[0].parsed && scan.ufds[0].parsed.data && scan.ufds[0].parsed.data.model)
                || (scan && scan.ufdx && scan.ufdx.toolName)
                || 'Unknown device';

            const r = await window.electronAPI.cellebriteImport({
                ufdxPath: picked.ufdxPath,
                caseNumber: this.caseNumber,
                caseId: this.caseId,
                sourceMode,
                evidenceTag,
                deviceLabel,
            });
            if (r && r.success) {
                // Build the index entry.
                const entry = {
                    id: r.importId,
                    evidenceTag: evidenceTag || ('EVID-CELL-' + r.importId.slice(-6)),
                    deviceLabel,
                    sourceMode,
                    ufdxPath: r.manifest?.ufdxPath || picked.ufdxPath,
                    originalUfdxPath: picked.ufdxPath,
                    bundleSize: picked.bundleSize || 0,
                    createdAt: r.manifest?.createdAt || new Date().toISOString(),
                    counts: r.counts || {},
                    status: 'imported',
                    flagged: {},
                };
                this.data.imports.unshift(entry);
                this.activeImportId = entry.id;
                this.activeSubTab = 'device';
                this._parsedCache.delete(entry.id);
                this.saveData();
            }
            return r;
        } catch (e) {
            console.error('[Cellebrite] importBundle error:', e);
            return { success: false, error: e.message };
        } finally {
            try { if (typeof progressUnsub === 'function') progressUnsub(); } catch (_) {}
        }
    }

    async deleteImport(importId) {
        if (!importId) return false;
        if (window.electronAPI && window.electronAPI.cellebriteDeleteImport) {
            try {
                await window.electronAPI.cellebriteDeleteImport({
                    caseNumber: this.caseNumber,
                    importId,
                });
            } catch (_) {}
        }
        this.data.imports = this.data.imports.filter(i => i.id !== importId);
        if (this.activeImportId === importId) {
            this.activeImportId = this.data.imports.length ? this.data.imports[0].id : null;
        }
        this._parsedCache.delete(importId);
        this.saveData();
        this.render();
        return true;
    }

    async cancelActiveImport(importId) {
        if (!importId || !window.electronAPI || !window.electronAPI.cellebriteCancelImport) return false;
        try { await window.electronAPI.cellebriteCancelImport({ importId }); return true; } catch { return false; }
    }

    // ─── WarrantFlags integration (active in Phase 1.3) ─────────────────
    // Surface here so UI can call without checking module phase.
    toggleFlag(section, key) {
        if (typeof WarrantFlags === 'undefined') return false;
        return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this.saveData());
    }
    isFlagged(section, key) {
        if (typeof WarrantFlags === 'undefined') return false;
        return WarrantFlags.isFlagged(this.getActiveImport(), section, key);
    }
    flagCount() {
        if (typeof WarrantFlags === 'undefined') return 0;
        return WarrantFlags.count(this.getActiveImport());
    }
    flagCountFor(section) {
        if (typeof WarrantFlags === 'undefined') return 0;
        return WarrantFlags.countSection(this.getActiveImport(), section);
    }
    getAllFlags() {
        if (typeof WarrantFlags === 'undefined') return {};
        return WarrantFlags.all(this.getActiveImport());
    }
    clearFlags() {
        if (typeof WarrantFlags === 'undefined') return;
        WarrantFlags.clear(this.getActiveImport());
        this.saveData();
    }

    /**
     * Resolve flag keys → full data rows ready to write into the bundle.
     * Async because Cellebrite rows live on disk (lazy-loaded surface JSONs).
     * Also preloads `device` so `_buildSubjectInfo` (sync) sees the cached blob.
     */
    async _resolveFlagged(imp) {
        const f = (imp && imp.flagged) || {};
        const out = { contacts: [], calls: [], sms: [], accounts: [], wifi: [], media: [] };

        // Preload device for sync subject-info builder downstream.
        try { await this.loadSurface(imp.id, 'device'); } catch (_) {}

        if ((f.contacts || []).length) {
            const data = await this.loadSurface(imp.id, 'contacts');
            const set = new Set((f.contacts || []).map(String));
            for (const c of ((data && data.contacts) || [])) {
                if (!set.has(String(c.id))) continue;
                out.contacts.push({
                    id: c.id,
                    displayName: c.displayName || '',
                    phones: (c.phones || []).map(p => `${p.type ? p.type + ': ' : ''}${p.number || ''}`).join('; '),
                    emails: (c.emails || []).map(e => `${e.type ? e.type + ': ' : ''}${e.address || ''}`).join('; '),
                    accountType: c.accountType || '',
                    starred: !!c.starred,
                });
            }
        }

        if ((f.calls || []).length) {
            const data = await this.loadSurface(imp.id, 'calls');
            const set = new Set((f.calls || []).map(String));
            for (const c of ((data && data.calls) || [])) {
                if (!set.has(String(c.id))) continue;
                out.calls.push({
                    id: c.id,
                    number: c.number || '',
                    contactName: c.contactName || '',
                    direction: c.direction || '',
                    type: c.type || '',
                    duration: c.duration || 0,
                    timestamp: c.timestamp || 0,
                    simSlot: c.simSlot || '',
                });
            }
            out.calls.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        }

        if ((f.sms || []).length) {
            const data = await this.loadSurface(imp.id, 'sms');
            const set = new Set((f.sms || []).map(String));
            for (const m of ((data && data.messages) || [])) {
                if (!set.has(String(m.id))) continue;
                out.sms.push({
                    id: m.id,
                    threadId: m.threadId,
                    address: m.address || '',
                    contactName: m.contactName || '',
                    direction: m.direction || '',
                    kind: m.kind || 'sms',
                    timestamp: m.timestamp || 0,
                    body: m.body || m.subject || '',
                    attachmentCount: (m.attachments || []).length || 0,
                });
            }
            out.sms.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        }

        if ((f.accounts || []).length) {
            const data = await this.loadSurface(imp.id, 'accounts');
            const set = new Set((f.accounts || []).map(String));
            for (const a of ((data && data.accounts) || [])) {
                if (!set.has(String(a.id))) continue;
                out.accounts.push({
                    id: a.id,
                    name: a.name || '',
                    type: a.type || '',
                    previousName: a.previousName || '',
                    hasPassword: !!a.hasPassword,
                });
            }
        }

        if ((f.wifi || []).length) {
            const data = await this.loadSurface(imp.id, 'wifi');
            const set = new Set((f.wifi || []).map(String));
            const keyOf = (n) => `${n.ssid || ''}::${n.bssid || ''}`;
            for (const n of ((data && data.networks) || [])) {
                if (!set.has(keyOf(n))) continue;
                out.wifi.push({
                    ssid: n.ssid || '',
                    bssid: n.bssid || '',
                    security: n.security || '',
                    hidden: n.hidden,
                    creationTime: n.creationTime,
                    creatorName: n.creatorName || '',
                    preSharedKeyPresent: !!n.preSharedKeyPresent,
                });
            }
        }

        if ((f.media || []).length) {
            const data = await this.loadSurface(imp.id, 'media');
            const set = new Set((f.media || []).map(String));
            for (const m of ((data && data.items) || [])) {
                if (!set.has(String(m.id))) continue;
                out.media.push({
                    id: m.id,
                    filename: m.filename || '',
                    category: m.category || '',
                    type: m.type || '',
                    mime: m.mime || '',
                    size: m.size || 0,
                    capturedAt: m.capturedAt || '',
                    gps: m.gps ? `${m.gps.lat?.toFixed?.(5)}, ${m.gps.lon?.toFixed?.(5)}` : '',
                    entryPath: m.entryPath || '',
                });
            }
            out.media.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
        }

        return out;
    }

    _buildSubjectInfo(imp) {
        let dev = {}, ext = {};
        try {
            const bucket = this._parsedCache.get(imp.id);
            if (bucket && bucket.device) {
                dev = bucket.device.device || {};
                ext = bucket.device.extraction || {};
            }
        } catch (_) {}
        return {
            'Device':          [dev.make, dev.model].filter(Boolean).join(' ') || imp.deviceLabel || '',
            'Android':         dev.androidVersion || '',
            'Serial':          dev.serial || '',
            'IMEI':            (dev.imei || []).join(', '),
            'ICCID':           (dev.iccid || []).join(', '),
            'Examiner':        ext.examiner || '',
            'Case Number':     ext.caseNumber || '',
            'Extraction Date': ext.date || imp.createdAt || '',
            'Evidence Tag':    imp.evidenceTag || '',
            'Source File':     imp.ufdxPath || '',
        };
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'contacts',
                title: 'Contacts',
                icon: '👤',
                renderHint: 'table',
                columns: [
                    { label: 'Name',    field: 'displayName' },
                    { label: 'Phones',  field: 'phones',  type: 'mono' },
                    { label: 'Emails',  field: 'emails' },
                    { label: 'Account', field: 'accountType' },
                ],
                items: resolved.contacts,
                emptyText: 'No contacts flagged.',
            },
            {
                id: 'calls',
                title: 'Call Log',
                icon: '📞',
                renderHint: 'table',
                columns: [
                    { label: 'Number',   field: 'number',      type: 'mono' },
                    { label: 'Contact',  field: 'contactName' },
                    { label: 'Direction',field: 'direction' },
                    { label: 'Type',     field: 'type' },
                    { label: 'Duration', field: 'duration' },
                    { label: 'When',     field: 'timestamp',   type: 'date' },
                    { label: 'SIM',      field: 'simSlot' },
                ],
                items: resolved.calls,
                emptyText: 'No calls flagged.',
            },
            {
                id: 'sms',
                title: 'SMS / MMS',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'Kind',      field: 'kind' },
                    { label: 'Direction', field: 'direction' },
                    { label: 'Address',   field: 'address',     type: 'mono' },
                    { label: 'Contact',   field: 'contactName' },
                    { label: 'Body',      field: 'body',        type: 'longtext' },
                    { label: 'Attachments', field: 'attachmentCount' },
                    { label: 'When',      field: 'timestamp',   type: 'date' },
                ],
                items: resolved.sms,
                emptyText: 'No messages flagged.',
            },
            {
                id: 'accounts',
                title: 'Accounts',
                icon: '🔑',
                renderHint: 'table',
                columns: [
                    { label: 'Name',          field: 'name' },
                    { label: 'Type',          field: 'type',         type: 'mono' },
                    { label: 'Previous Name', field: 'previousName' },
                    { label: 'Credential',    field: 'hasPassword' },
                ],
                items: resolved.accounts,
                emptyText: 'No accounts flagged.',
            },
            {
                id: 'wifi',
                title: 'Wi-Fi Networks',
                icon: '📶',
                renderHint: 'table',
                columns: [
                    { label: 'SSID',     field: 'ssid' },
                    { label: 'BSSID',    field: 'bssid',        type: 'mono' },
                    { label: 'Security', field: 'security' },
                    { label: 'Hidden',   field: 'hidden' },
                    { label: 'Creator',  field: 'creatorName' },
                    { label: 'Created',  field: 'creationTime', type: 'date' },
                    { label: 'PSK Present', field: 'preSharedKeyPresent' },
                ],
                items: resolved.wifi,
                emptyText: 'No Wi-Fi networks flagged.',
            },
            {
                id: 'media',
                title: 'Media',
                icon: '🖼️',
                renderHint: 'table',
                columns: [
                    { label: 'Filename', field: 'filename' },
                    { label: 'Category', field: 'category' },
                    { label: 'Type',     field: 'type' },
                    { label: 'MIME',     field: 'mime',       type: 'mono' },
                    { label: 'Size',     field: 'size' },
                    { label: 'Captured', field: 'capturedAt', type: 'date' },
                    { label: 'GPS',      field: 'gps' },
                    { label: 'Path',     field: 'entryPath',  type: 'mono' },
                ],
                items: resolved.media,
                emptyText: 'No media flagged.',
            },
        ];
    }

    async pushFlagsToEvidence() {
        if (typeof WarrantFlags === 'undefined') {
            return { success: false, error: 'WarrantFlags shared module not loaded' };
        }
        return WarrantFlags.pushToEvidence({
            caseNumber:        this.caseNumber,
            caseId:            this.caseId,
            moduleSlug:        'cellebrite',
            moduleLabel:       'Cellebrite Extraction',
            moduleFolder:      'Cellebrite',
            bundlePrefix:      'CW',
            evidenceKind:      'warrant-cellebrite',
            iconEmoji:         '📱',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.ufdxPath || imp.deviceLabel || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved),
        });
    }

    // ─── Render delegation ──────────────────────────────────────────────

    render() {
        if (this.ui && typeof this.ui.render === 'function') {
            this.ui.render();
            return;
        }
        // Fallback when UI hasn't loaded
        const root = document.getElementById(this.containerId);
        if (root) {
            root.innerHTML = `
                <div class="glass-card p-6 rounded-xl">
                    <div class="text-center text-red-400">
                        <p class="text-lg font-semibold mb-2">Cellebrite UI Not Loaded</p>
                        <p class="text-sm text-gray-400">cellebrite-ui.js failed to load.</p>
                    </div>
                </div>
            `;
        }
    }
}

window.CellebriteModule = CellebriteModule;
