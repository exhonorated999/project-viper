/**
 * Snapchat Warrant Parser — Main Module (renderer process)
 * Coordinates between UI, IPC handlers, and localStorage persistence.
 */

class SnapchatWarrantModule {
    constructor(caseId, caseNumber, caseName) {
        this.caseId = caseId;
        this.caseNumber = caseNumber || caseId;
        this.caseName = caseName || `Case ${caseId}`;
        this.imports = [];
        this.evidenceFiles = [];
        this.ui = null;
    }

    async init(containerId) {
        await this.loadData();
        this.ui = new SnapchatWarrantUI(containerId, this);
        window.snapchatWarrantUI = this.ui;
        this.ui.render();

        // Auto-scan Evidence/ and Warrants/Production/ for Snapchat warrant files (non-blocking)
        this.scanForWarrants().catch(err => console.warn('Snapchat warrant scan error:', err));
        return this;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Persistence — DISK-BACKED (see electron-main snapchat-warrant-*-data)
    //
    // A Snapchat production is far too big for localStorage (~8 MB+ vs a ~5 MB
    // quota). The full payload therefore lives in a per-case JSON file in
    // userData, and localStorage keeps only a slim metadata index for the
    // handful of synchronous readers (module badge counts, Warrant Author
    // subject harvesting). Before this, every save threw QuotaExceededError:
    // flags could not be set and the import disappeared the moment the user
    // left the tab, forcing a re-import.
    // ═══════════════════════════════════════════════════════════════════

    _lsKey() { return `snapchatWarrant_${this.caseId}`; }

    /** Metadata-only projection of an import — safe to keep in localStorage. */
    _slimImport(i) {
        return {
            id: i.id,
            fileName: i.fileName,
            filePath: i.filePath,
            isFolder: !!i.isFolder,
            importedAt: i.importedAt,
            targetUsername: i.targetUsername || null,
            email: i.email || null,
            userId: i.userId || null,
            dateRange: i.dateRange || null,
            stats: i.stats || {},
            parts: i.parts || [],
            // Warrant Author harvests subject identifiers from this.
            subscriberInfo: i.subscriberInfo || null,
            subject: {
                username: i.targetUsername || null,
                email: i.email || null,
                userId: i.userId || null
            },
            counts: {
                conversations: (i.conversations || []).length,
                geoLocations: (i.geoLocations || []).length,
                memories: (i.memories || []).length,
                media: Object.keys(i.mediaFiles || {}).length
            },
            _diskBacked: true
        };
    }

    _saveSlimIndex() {
        try {
            localStorage.setItem(this._lsKey(), JSON.stringify({
                imports: this.imports.map(i => this._slimImport(i)),
                _diskBacked: true
            }));
        } catch (e) {
            console.warn('Snapchat warrant: slim index write failed.', e && e.message);
        }
    }

    async loadData() {
        // 1. Preferred source: the on-disk store.
        try {
            if (window.electronAPI?.snapchatWarrantLoadData) {
                const res = await window.electronAPI.snapchatWarrantLoadData({ caseId: this.caseId });
                if (res && res.success && res.data) {
                    const parsed = JSON.parse(res.data);
                    this.imports = parsed.imports || [];
                    this._loadFlags();
                    this._saveSlimIndex();
                    return;
                }
            }
        } catch (e) {
            console.warn('Snapchat warrant: disk load failed, falling back to localStorage.', e && e.message);
        }

        // 2. Legacy / fallback: whatever is in localStorage. A pre-existing FULL
        //    blob (small production saved by an older build) is migrated to disk
        //    once and replaced by the slim index.
        try {
            const raw = localStorage.getItem(this._lsKey());
            if (raw) {
                const data = JSON.parse(raw);
                const isSlim = data._diskBacked === true;
                if (isSlim) {
                    // Slim records carry metadata only — the bulk payload lives on
                    // disk. If we got here the disk read failed or is unavailable,
                    // so show the import prompt rather than hollow 0-item sections.
                    console.warn('Snapchat warrant: disk store unavailable — slim index cannot be rendered.');
                    this.imports = [];
                } else {
                    this.imports = data.imports || [];
                    if (this.imports.length) {
                        // Legacy full blob from an older build — migrate to disk once.
                        await this._writeDisk();
                        this._saveSlimIndex();
                    }
                }
            } else {
                this.imports = [];
            }
        } catch (e) {
            console.error('Error loading Snapchat warrant data:', e);
            this.imports = [];
        }
        this._loadFlags();
    }

    /** Write the full payload to the on-disk store. */
    async _writeDisk() {
        if (!window.electronAPI?.snapchatWarrantSaveData) return false;
        try {
            const res = await window.electronAPI.snapchatWarrantSaveData({
                caseId: this.caseId,
                json: JSON.stringify({ imports: this.imports })
            });
            if (!res || !res.success) {
                console.warn('Snapchat warrant: disk save failed —', res && res.error);
                return false;
            }
            return true;
        } catch (e) {
            console.warn('Snapchat warrant: disk save threw —', e && e.message);
            return false;
        }
    }

    /**
     * Persist everything. Never throws: the slim index cannot realistically
     * exceed the quota, and the bulk payload goes to disk.
     */
    saveData() {
        this._saveSlimIndex();
        this._saveFlags();
        // Fire-and-forget the disk write; callers that need to await it can use
        // _writeDisk() directly (importWarrant does).
        return this._writeDisk();
    }

    // ─── Flag persistence (tiny, independent of the bulk data blob) ─────

    _flagsKey() { return `snapchatWarrantFlags_${this.caseId}`; }

    /**
     * Flags are keyed by the production's FILE PATH, not the import record id.
     * Import ids are regenerated on every re-import, and huge productions that
     * blow the localStorage quota are not cached at all — so they get re-imported
     * (and re-id'd) on the next launch. filePath is stable across all of that.
     */
    _flagIdentity(imp) {
        return String((imp && (imp.filePath || imp.id)) || '');
    }

    _saveFlags() {
        try {
            const map = {};
            for (const imp of this.imports) {
                const idk = this._flagIdentity(imp);
                if (idk && imp.flagged && Object.keys(imp.flagged).length) {
                    map[idk] = imp.flagged;
                }
            }
            localStorage.setItem(this._flagsKey(), JSON.stringify(map));
        } catch (e) {
            console.warn('Snapchat warrant: could not persist flags.', e && e.message);
        }
    }

    _loadFlags() {
        try {
            const raw = localStorage.getItem(this._flagsKey());
            if (!raw) return;
            const map = JSON.parse(raw) || {};
            for (const imp of this.imports) {
                if (!imp) continue;
                // Accept the legacy id-keyed entries too, so flags saved before
                // this change still reattach.
                const hit = map[this._flagIdentity(imp)] || map[imp.id];
                if (hit) imp.flagged = hit;
            }
        } catch (e) { /* ignore */ }
    }

    async scanForWarrants() {
        if (!window.electronAPI?.snapchatWarrantScan) return;

        try {
            const result = await window.electronAPI.snapchatWarrantScan({
                caseNumber: this.caseNumber,
                caseId: this.caseId
            });

            if (result.success && result.files.length > 0) {
                const importedPaths = this.imports.map(i => i.filePath);
                this.evidenceFiles = result.files.map(f => ({
                    ...f,
                    alreadyImported: importedPaths.includes(f.path)
                }));
            } else {
                this.evidenceFiles = [];
            }

            if (this.ui) {
                this.ui.renderEvidenceBar(this.evidenceFiles);
            }
        } catch (err) {
            console.error('Error scanning for Snapchat warrants:', err);
            this.evidenceFiles = [];
        }
    }

    /**
     * Import a Snapchat warrant ZIP or unzipped folder.
     * @param {string} filePath  Path to ZIP or folder
     * @param {string} fileName  Display name
     * @param {boolean} isFolder Whether the path is a directory
     */
    async importWarrant(filePath, fileName, isFolder) {
        if (!window.electronAPI?.snapchatWarrantImport) {
            throw new Error('Snapchat Warrant IPC handler not available');
        }

        const result = await window.electronAPI.snapchatWarrantImport({
            filePath,
            caseNumber: this.caseNumber,
            isFolder: !!isFolder
        });

        if (!result.success) {
            throw new Error(result.error || 'Import failed');
        }

        const data = result.data;

        const importRecord = {
            id: this._generateId(),
            fileName: fileName || filePath.split(/[\\/]/).pop(),
            filePath: filePath,
            isFolder: !!isFolder,
            importedAt: new Date().toISOString(),
            targetUsername: data.mergedHeader?.targetUsername || null,
            email: data.mergedHeader?.email || null,
            userId: data.mergedHeader?.userId || null,
            dateRange: data.mergedHeader?.dateRange || null,
            stats: data.stats || {},
            // Per-part summaries (no per-part data — merged below)
            parts: (data.parts || []).map(p => ({
                partFolder: p.partFolder,
                partNum: p.partNum,
                conversationCount: p.conversations.length,
                geoCount: p.geoLocations.length,
                memoryCount: p.memories.length
            })),
            // Merged data (deduplicated, sorted)
            conversations: data.conversations || [],
            geoLocations: data.geoLocations || [],
            memories: data.memories || [],
            deviceAdvertisingIds: data.deviceAdvertisingIds || [],
            subscriberInfo: data.subscriberInfo || null,
            loginHistory: data.loginHistory || [],
            friends: data.friends || [],
            snapHistory: data.snapHistory || [],
            otherCsvs: data.otherCsvs || {},
            mediaFiles: data.mediaFiles || {}
        };

        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) {
            this.imports[existingIdx] = importRecord;
        } else {
            this.imports.push(importRecord);
        }

        // Re-attach any flags previously saved for this production, keyed by
        // filePath so they survive re-imports and new import ids.
        this._loadFlags();

        this._saveSlimIndex();
        this._saveFlags();
        await this._writeDisk();
        await this.scanForWarrants();
        return importRecord;
    }

    async importFromPicker() {
        if (!window.electronAPI?.snapchatWarrantPickFile) {
            throw new Error('File picker not available');
        }
        const result = await window.electronAPI.snapchatWarrantPickFile();
        if (!result || !result.path) return null;
        const fileName = result.path.split(/[\\/]/).pop();
        return this.importWarrant(result.path, fileName, !!result.isFolder);
    }

    async deleteImport(importId) {
        this.imports = this.imports.filter(i => i.id !== importId);
        this._saveSlimIndex();
        this._saveFlags();
        if (this.imports.length === 0 && window.electronAPI?.snapchatWarrantDeleteData) {
            try { await window.electronAPI.snapchatWarrantDeleteData({ caseId: this.caseId }); } catch (_) {}
            return;
        }
        await this._writeDisk();
    }

    async readMedia(diskPath) {
        if (!window.electronAPI?.snapchatWarrantReadMedia) return null;
        try {
            const result = await window.electronAPI.snapchatWarrantReadMedia({ filePath: diskPath });
            if (result.success) return { data: result.data, mimeType: result.mimeType };
        } catch (e) { /* ignore */ }
        return null;
    }

    getItemCount() {
        return this.imports.length;
    }

    _generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Flag-to-Evidence (uses shared WarrantFlags mixin)
    // ═══════════════════════════════════════════════════════════════════

    getActiveImport() {
        const ui = this.ui;
        if (ui && typeof ui.activeImportIdx === 'number') {
            return this.imports[ui.activeImportIdx] || null;
        }
        return this.imports[0] || null;
    }

    toggleFlag(section, key) {
        // Persist through the tiny flags key only — the bulk blob write can
        // legitimately fail on huge productions and must not break flagging.
        return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this._saveFlags());
    }
    isFlagged(section, key) {
        return WarrantFlags.isFlagged(this.getActiveImport(), section, key);
    }
    flagCount() {
        return WarrantFlags.count(this.getActiveImport());
    }
    flagCountFor(section) {
        return WarrantFlags.countSection(this.getActiveImport(), section);
    }
    clearFlags() {
        WarrantFlags.clear(this.getActiveImport());
        this._saveFlags();
    }

    /**
     * Resolve flag keys → full data objects ready to write into the bundle.
     * Async because flagged media images are read off disk and inlined into the
     * report as data URIs (see _resolveFlaggedMedia).
     */
    async _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const out = {
            conversations: [],
            logins: [],
            geo: [],
            devices: [],
            friends: [],
            snapHistory: [],
            memories: [],
            media: []
        };

        // Conversations — flag key = message composite key via WarrantFlagsKey.snapchatMessage
        const flaggedMsgKeys = new Set((f.conversations || []).map(String));
        if (flaggedMsgKeys.size > 0) {
            for (const m of (imp.conversations || [])) {
                const k = window.WarrantFlagsKey.snapchatMessage(m);
                if (!flaggedMsgKeys.has(k)) continue;
                out.conversations.push({
                    key: k,
                    timestamp: m.timestamp || '',
                    sender: m.sender_username || '',
                    recipient: m.recipient_username || '',
                    conversationId: m.conversation_id || '',
                    conversationTitle: m.conversation_title || '',
                    messageType: m.message_type || m.content_type || '',
                    text: m.text || '',
                    mediaId: m.media_id || ''
                });
            }
            out.conversations.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
        }

        // Logins — flag key = composite via WarrantFlagsKey.snapchatLogin
        const flaggedLoginKeys = new Set((f.logins || []).map(String));
        for (const r of (imp.loginHistory || [])) {
            const k = window.WarrantFlagsKey.snapchatLogin(r);
            if (!flaggedLoginKeys.has(k)) continue;
            out.logins.push({
                key: k,
                ...r
            });
        }

        // Geo — flag key = composite via WarrantFlagsKey.snapchatGeo
        const flaggedGeoKeys = new Set((f.geo || []).map(String));
        for (const g of (imp.geoLocations || [])) {
            const k = window.WarrantFlagsKey.snapchatGeo(g);
            if (!flaggedGeoKeys.has(k)) continue;
            out.geo.push({
                key: k,
                timestamp: g.timestamp || '',
                latitude: g.latitude || '',
                longitude: g.longitude || '',
                accuracy: g.latitudeAccuracy || ''
            });
        }

        // Devices — flag key = composite via WarrantFlagsKey.snapchatDevice
        const flaggedDevKeys = new Set((f.devices || []).map(String));
        for (const d of (imp.deviceAdvertisingIds || [])) {
            const k = window.WarrantFlagsKey.snapchatDevice(d);
            if (!flaggedDevKeys.has(k)) continue;
            out.devices.push({
                key: k,
                ...d
            });
        }

        // Friends — flag key = composite via WarrantFlagsKey.snapchatFriend
        const flaggedFriendKeys = new Set((f.friends || []).map(String));
        for (const fr of (imp.friends || [])) {
            const k = window.WarrantFlagsKey.snapchatFriend(fr);
            if (!flaggedFriendKeys.has(k)) continue;
            out.friends.push({
                key: k,
                ...fr
            });
        }

        // Snap History — flag key = composite via WarrantFlagsKey.snapchatSnap
        const flaggedSnapKeys = new Set((f.snapHistory || []).map(String));
        for (const s of (imp.snapHistory || [])) {
            const k = window.WarrantFlagsKey.snapchatSnap(s);
            if (!flaggedSnapKeys.has(k)) continue;
            out.snapHistory.push({
                key: k,
                ...s
            });
        }

        // Memories — flag key = composite via WarrantFlagsKey.snapchatMemory
        const flaggedMemKeys = new Set((f.memories || []).map(String));
        for (const mm of (imp.memories || [])) {
            const k = window.WarrantFlagsKey.snapchatMemory(mm);
            if (!flaggedMemKeys.has(k)) continue;
            out.memories.push({
                key: k,
                timestamp: mm.timestamp || '',
                sourceType: mm.source_type || '',
                latitude: mm.latitude || '',
                longitude: mm.longitude || '',
                duration: mm.duration || '',
                encrypted: mm.encrypted || '',
                mediaId: (mm.media_id || mm.id || '').slice(0, 24)
            });
        }

        // Media — flag key = file name via WarrantFlagsKey.snapchatMedia
        out.media = await this._resolveFlaggedMedia(imp, f.media || []);

        return out;
    }

    /**
     * Build the flagged-media rows for the report. Images are read back through
     * the main process (which transparently decrypts VIPENC files) and inlined
     * as data URIs so report.html is self-contained — it renders correctly even
     * when case security is on and the bundle files themselves are encrypted.
     * Videos are never inlined; they are listed with their source path instead.
     */
    async _resolveFlaggedMedia(imp, flaggedKeys) {
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024;      // skip absurdly large single images
        const MAX_TOTAL_BYTES = 80 * 1024 * 1024;     // keep report.html openable
        const keys = new Set((flaggedKeys || []).map(String));
        if (keys.size === 0) return [];

        const files = imp.mediaFiles || {};
        const rows = [];
        // Deterministic order: newest first, matching the gallery.
        const names = Object.keys(files)
            .filter(n => keys.has(String(n)))
            .sort((a, b) => String((files[b] || {}).timestamp || '').localeCompare(String((files[a] || {}).timestamp || '')));

        let embedded = 0;
        for (const name of names) {
            const info = files[name] || {};
            const isImage = String(info.mimeType || '').startsWith('image/');
            const isVideo = String(info.mimeType || '').startsWith('video/');
            const row = {
                key: name,
                fileName: name,
                timestamp: info.timestamp || '',
                sender: info.sender || '',
                recipient: info.recipient || '',
                mimeType: info.mimeType || '',
                saved: info.savedFlag || '',
                size: info.size
                    ? (info.size >= 1048576
                        ? (info.size / 1048576).toFixed(2) + ' MB'
                        : Math.max(1, Math.round(info.size / 1024)) + ' KB')
                    : '',
                part: info.partFolder || '',
                sourcePath: info.diskPath || '',
                preview: '',
                note: ''
            };
            if (isImage && info.diskPath && (!info.size || info.size <= MAX_IMAGE_BYTES) && embedded < MAX_TOTAL_BYTES) {
                try {
                    const res = await this.readMedia(info.diskPath);
                    if (res && res.data) {
                        row.preview = 'data:' + (res.mimeType || info.mimeType || 'image/jpeg') + ';base64,' + res.data;
                        embedded += res.data.length;
                    } else {
                        row.note = 'Image could not be read from the production.';
                    }
                } catch (e) {
                    row.note = 'Image could not be read: ' + (e && e.message ? e.message : 'unknown error');
                }
            } else if (isVideo) {
                row.note = 'Video not embedded — open the source file from the production.';
            } else if (isImage) {
                row.note = 'Image too large to embed — see source file.';
            }
            rows.push(row);
        }
        return rows;
    }

    _buildSubjectInfo(imp) {
        const sub = imp.subscriberInfo || {};
        return {
            'Username':     imp.targetUsername || sub.username || sub['Username'] || '',
            'User ID':      imp.userId || sub.userId || sub['User ID'] || '',
            'Email':        imp.email || sub.email || sub['Email'] || '',
            'Date Range':   imp.dateRange || '',
            'Source File':  imp.fileName || ''
        };
    }

    _buildSectionConfigs(imp, resolved) {
        // Dynamic columns for login history (keys vary by production)
        const loginCols = resolved.logins.length > 0
            ? Object.keys(resolved.logins[0]).filter(k => k !== 'key').map(k => ({ label: k, field: k }))
            : [];

        // Dynamic columns for devices
        const devCols = resolved.devices.length > 0
            ? Object.keys(resolved.devices[0]).filter(k => k !== 'key').map(k => ({
                label: k,
                field: k,
                type: /id|device|advertising/i.test(k) ? 'mono' : undefined
            }))
            : [];

        // Dynamic columns for friends
        const friendCols = resolved.friends.length > 0
            ? Object.keys(resolved.friends[0]).filter(k => k !== 'key').map(k => ({
                label: k,
                field: k,
                type: /id|user_id/i.test(k) ? 'mono' : undefined
            }))
            : [];

        // Dynamic columns for snap history
        const snapCols = resolved.snapHistory.length > 0
            ? Object.keys(resolved.snapHistory[0]).filter(k => k !== 'key').map(k => ({ label: k, field: k }))
            : [];

        return [
            {
                id: 'conversations',
                title: 'Conversations',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'Time',            field: 'timestamp',       type: 'date' },
                    { label: 'Sender',          field: 'sender' },
                    { label: 'Recipient',       field: 'recipient' },
                    { label: 'Conversation',    field: 'conversationTitle' },
                    { label: 'Type',            field: 'messageType' },
                    { label: 'Text',            field: 'text',            type: 'longtext' },
                    { label: 'Media ID',        field: 'mediaId',         type: 'mono' }
                ],
                items: resolved.conversations,
                emptyText: 'No conversations flagged.'
            },
            {
                id: 'logins',
                title: 'Login History',
                icon: '🌐',
                renderHint: 'table',
                columns: loginCols,
                items: resolved.logins,
                emptyText: 'No logins flagged.'
            },
            {
                id: 'geo',
                title: 'Geo Locations',
                icon: '🗺️',
                renderHint: 'table',
                columns: [
                    { label: 'Timestamp', field: 'timestamp', type: 'date' },
                    { label: 'Latitude',  field: 'latitude',  type: 'mono' },
                    { label: 'Longitude', field: 'longitude', type: 'mono' },
                    { label: 'Accuracy',  field: 'accuracy' }
                ],
                items: resolved.geo,
                emptyText: 'No geo locations flagged.'
            },
            {
                id: 'devices',
                title: 'Device IDs',
                icon: '📱',
                renderHint: 'table',
                columns: devCols,
                items: resolved.devices,
                emptyText: 'No devices flagged.'
            },
            {
                id: 'friends',
                title: 'Friends',
                icon: '👥',
                renderHint: 'table',
                columns: friendCols,
                items: resolved.friends,
                emptyText: 'No friends flagged.'
            },
            {
                id: 'snapHistory',
                title: 'Snap History',
                icon: '👻',
                renderHint: 'table',
                columns: snapCols,
                items: resolved.snapHistory,
                emptyText: 'No snap history flagged.'
            },
            {
                id: 'memories',
                title: 'Memories',
                icon: '⭐',
                renderHint: 'table',
                columns: [
                    { label: 'Timestamp', field: 'timestamp',  type: 'date' },
                    { label: 'Source',    field: 'sourceType' },
                    { label: 'Latitude',  field: 'latitude',   type: 'mono' },
                    { label: 'Longitude', field: 'longitude',  type: 'mono' },
                    { label: 'Duration',  field: 'duration' },
                    { label: 'Encrypted', field: 'encrypted' },
                    { label: 'Media ID',  field: 'mediaId',    type: 'mono' }
                ],
                items: resolved.memories,
                emptyText: 'No memories flagged.'
            },
            {
                id: 'media',
                title: 'Media',
                icon: '📷',
                renderHint: 'gallery',
                columns: [
                    { label: 'Preview',   field: 'preview',   type: 'image' },
                    { label: 'File Name', field: 'fileName',  type: 'mono' },
                    { label: 'Captured',  field: 'timestamp', type: 'date' },
                    { label: 'Sender',    field: 'sender' },
                    { label: 'Recipient', field: 'recipient' },
                    { label: 'Type',      field: 'mimeType' },
                    { label: 'Saved',     field: 'saved' },
                    { label: 'Size',      field: 'size' },
                    { label: 'Part',      field: 'part' },
                    { label: 'Source',    field: 'sourcePath', type: 'mono' },
                    { label: 'Note',      field: 'note' }
                ],
                items: resolved.media,
                emptyText: 'No media flagged.'
            }
        ];
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'snapchat',
            moduleLabel:   'Snapchat Warrant',
            moduleFolder:  'SnapchatWarrant',
            bundlePrefix:  'SW',
            evidenceKind:  'warrant-snapchat',
            iconEmoji:     '👻',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for Snapchat warrant data (used by both module + UI)
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.snapchatMessage = function (m) {
    return [m.timestamp || '', m.sender_username || '', m.recipient_username || '', m.conversation_id || '', (m.text || '').slice(0, 60)].join('|');
};
window.WarrantFlagsKey.snapchatLogin = function (r) {
    // Login history columns vary; use all values joined as fallback
    const vals = Object.values(r).map(v => String(v || '')).join('|');
    return vals;
};
window.WarrantFlagsKey.snapchatGeo = function (g) {
    return [g.timestamp || '', String(g.latitude || ''), String(g.longitude || '')].join('|');
};
window.WarrantFlagsKey.snapchatDevice = function (d) {
    // Device rows have dynamic keys; join all values
    return Object.values(d).map(v => String(v || '')).join('|');
};
window.WarrantFlagsKey.snapchatFriend = function (fr) {
    return Object.values(fr).map(v => String(v || '')).join('|');
};
window.WarrantFlagsKey.snapchatSnap = function (s) {
    return Object.values(s).map(v => String(v || '')).join('|');
};
window.WarrantFlagsKey.snapchatMemory = function (mm) {
    return [mm.timestamp || '', mm.source_type || '', (mm.media_id || mm.id || '').slice(0, 24)].join('|');
};
// Media file names are unique within a production, so they make a stable key.
window.WarrantFlagsKey.snapchatMedia = function (m) {
    return String((m && (m.name || m.fileName)) || '');
};

window.SnapchatWarrantModule = SnapchatWarrantModule;
