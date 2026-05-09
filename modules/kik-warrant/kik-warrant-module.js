/**
 * KIK Warrant Parser — Main Module
 * Coordinates between UI, IPC handlers, and localStorage persistence.
 * Runs in renderer process.
 */

class KikWarrantModule {
    constructor(caseId, caseNumber, caseName) {
        this.caseId = caseId;
        this.caseNumber = caseNumber || caseId;
        this.caseName = caseName || `Case ${caseId}`;
        this.imports = [];
        this.evidenceFiles = [];
        this.ui = null;
    }

    /**
     * Initialize the module
     */
    async init(containerId) {
        this.loadData();
        this.ui = new KikWarrantUI(containerId, this);
        window.kikWarrantUI = this.ui;
        this.ui.render();

        // Auto-scan for KIK warrant ZIPs (non-blocking)
        this.scanForWarrants().catch(err => console.warn('KIK warrant scan error:', err));
        return this;
    }

    /**
     * Load data from localStorage
     */
    loadData() {
        try {
            const raw = localStorage.getItem(`kikWarrant_${this.caseId}`);
            if (raw) {
                const data = JSON.parse(raw);
                this.imports = data.imports || [];
            }
        } catch (e) {
            console.error('Error loading KIK warrant data:', e);
            this.imports = [];
        }
    }

    /**
     * Save data to localStorage
     */
    saveData() {
        localStorage.setItem(`kikWarrant_${this.caseId}`, JSON.stringify({
            imports: this.imports
        }));
    }

    /**
     * Scan Evidence/ and Warrants/Production/ for KIK warrant ZIPs
     */
    async scanForWarrants() {
        if (!window.electronAPI?.kikWarrantScan) return;

        try {
            const result = await window.electronAPI.kikWarrantScan({
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
            console.error('Error scanning for KIK warrants:', err);
        }
    }

    /**
     * Import a KIK warrant ZIP
     */
    async importWarrant(filePath, fileName) {
        if (!window.electronAPI?.kikWarrantImport) {
            throw new Error('KIK warrant import not available');
        }

        const result = await window.electronAPI.kikWarrantImport({
            filePath,
            caseNumber: this.caseNumber
        });

        if (!result.success) {
            throw new Error(result.error || 'Import failed');
        }

        const data = result.data;

        const importRecord = {
            id: this._generateId(),
            fileName: fileName || filePath.split(/[\\/]/).pop(),
            filePath: filePath,
            importedAt: new Date().toISOString(),
            accountUsername: data.accountUsername || 'unknown',
            caseNumber: data.caseNumber || null,
            data: data
        };

        // Replace if same file, else add
        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) {
            this.imports[existingIdx] = importRecord;
        } else {
            this.imports.push(importRecord);
        }

        this.saveData();
        await this.scanForWarrants();
        return importRecord;
    }

    /**
     * Import via file picker
     */
    async importFromPicker() {
        if (!window.electronAPI?.kikWarrantPickFile) {
            throw new Error('File picker not available');
        }
        const filePath = await window.electronAPI.kikWarrantPickFile();
        if (!filePath) return null;
        const fileName = filePath.split(/[\\/]/).pop();
        return this.importWarrant(filePath, fileName);
    }

    /**
     * Delete an import by ID
     */
    deleteImport(importId) {
        this.imports = this.imports.filter(i => i.id !== importId);
        this.saveData();
    }

    getItemCount() {
        return this.imports.length;
    }

    /**
     * Read a media file from disk (for content files saved during import)
     */
    async readMedia(diskPath) {
        if (!window.electronAPI?.kikWarrantReadMedia) return null;
        try {
            const result = await window.electronAPI.kikWarrantReadMedia({ filePath: diskPath });
            if (result.success) return { data: result.data, mimeType: result.mimeType };
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * Get disk path for a media UUID
     */
    getMediaPath(uuid) {
        const imp = this.imports[0]; // current import
        if (!imp || !imp.data || !imp.data.contentFiles) return null;
        // Try exact match first, then match without extension
        const cf = imp.data.contentFiles;
        if (cf[uuid] && cf[uuid].diskPath) return cf[uuid].diskPath;
        // Try with common extensions
        for (const ext of ['.jpg', '.mp4', '.png', '.gif']) {
            if (cf[uuid + ext] && cf[uuid + ext].diskPath) return cf[uuid + ext].diskPath;
        }
        return null;
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
        return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this.saveData());
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
        this.saveData();
    }

    /**
     * Resolve flag keys → full data objects ready to write into the bundle.
     */
    _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const d = imp.data || {};
        const out = {
            sessions: [],
            friends: [],
            dms: [],
            groups: [],
            media: []
        };

        // Sessions — flag key = `${timestamp}|${ip}`
        const flaggedSessions = new Set((f.sessions || []).map(String));
        for (const b of (d.binds || [])) {
            const k = WarrantFlagsKey.session(b);
            if (!flaggedSessions.has(k)) continue;
            out.sessions.push({
                timestamp: b.timestamp,
                datetime: b.datetime || '',
                ip: b.ip || '',
                port: b.port || '',
                country: b.country || ''
            });
        }

        // Friends — flag key = `${timestamp}|${friend}`
        const flaggedFriends = new Set((f.friends || []).map(String));
        for (const fr of (d.friends || [])) {
            const k = WarrantFlagsKey.friend(fr);
            if (!flaggedFriends.has(k)) continue;
            out.friends.push({
                timestamp: fr.timestamp,
                datetime: fr.datetime || '',
                friend: fr.friend || ''
            });
        }

        // DMs — flag key = `${timestamp}|${sender}|${recipient}|${dir}`
        const flaggedDms = new Set((f.dms || []).map(String));
        const dmSources = [
            { arr: d.chatSent || [], dir: 'sent', type: 'text' },
            { arr: d.chatSentReceived || [], dir: 'recv', type: 'text' },
            { arr: d.chatPlatformSent || [], dir: 'sent', type: 'media' },
            { arr: d.chatPlatformSentReceived || [], dir: 'recv', type: 'media' }
        ];
        for (const src of dmSources) {
            for (const r of src.arr) {
                const k = WarrantFlagsKey.dm(r, src.dir);
                if (!flaggedDms.has(k)) continue;
                out.dms.push({
                    timestamp: r.timestamp,
                    datetime: r.datetime || '',
                    direction: src.dir,
                    type: src.type,
                    sender: r.sender || '',
                    recipient: r.recipient || '',
                    msgCount: r.msgCount || '',
                    mediaType: r.mediaType || '',
                    mediaUuid: r.mediaUuid || '',
                    ip: r.ip || ''
                });
            }
        }
        out.dms.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        // Groups — flag key = `${timestamp}|${sender}|${groupId}|${dir}`
        const flaggedGroups = new Set((f.groups || []).map(String));
        const grpSources = [
            { arr: d.groupSendMsg || [], dir: 'sent', type: 'text' },
            { arr: d.groupReceiveMsg || [], dir: 'recv', type: 'text' },
            { arr: d.groupSendMsgPlatform || [], dir: 'sent', type: 'media' },
            { arr: d.groupReceiveMsgPlatform || [], dir: 'recv', type: 'media' }
        ];
        for (const src of grpSources) {
            for (const r of src.arr) {
                const k = WarrantFlagsKey.group(r, src.dir);
                if (!flaggedGroups.has(k)) continue;
                out.groups.push({
                    timestamp: r.timestamp,
                    datetime: r.datetime || '',
                    direction: src.dir,
                    type: src.type,
                    sender: r.sender || '',
                    groupId: r.groupId || '',
                    recipient: r.recipient || '',
                    msgCount: r.msgCount || '',
                    mediaType: r.mediaType || '',
                    mediaUuid: r.mediaUuid || '',
                    ip: r.ip || ''
                });
            }
        }
        out.groups.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        // Media — flag key = `${timestamp}|${mediaUuid}|${dir}`
        const flaggedMedia = new Set((f.media || []).map(String));
        const mediaSources = [
            { arr: d.chatPlatformSent || [], dir: 'sent', context: 'DM' },
            { arr: d.chatPlatformSentReceived || [], dir: 'recv', context: 'DM' },
            { arr: d.groupSendMsgPlatform || [], dir: 'sent', contextFn: r => `Group: ${r.groupId}` },
            { arr: d.groupReceiveMsgPlatform || [], dir: 'recv', contextFn: r => `Group: ${r.groupId}` }
        ];
        for (const src of mediaSources) {
            for (const r of src.arr) {
                const k = WarrantFlagsKey.media(r, src.dir);
                if (!flaggedMedia.has(k)) continue;
                out.media.push({
                    timestamp: r.timestamp,
                    datetime: r.datetime || '',
                    direction: src.dir,
                    sender: r.sender || '',
                    recipient: r.recipient || '',
                    mediaType: r.mediaType || '',
                    mediaUuid: r.mediaUuid || '',
                    context: src.contextFn ? src.contextFn(r) : src.context,
                    ip: r.ip || ''
                });
            }
        }
        out.media.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        return out;
    }

    _buildSubjectInfo(imp) {
        const d = imp.data || {};
        return {
            'Username':    d.accountUsername || '',
            'KIK Case #':  d.caseNumber || '',
            'Source File': imp.fileName || ''
        };
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'sessions',
                title: 'Session Activity',
                icon: '🔌',
                renderHint: 'table',
                columns: [
                    { label: 'Date/Time', field: 'datetime' },
                    { label: 'IP',        field: 'ip',       type: 'mono' },
                    { label: 'Port',      field: 'port',     type: 'mono' },
                    { label: 'Country',   field: 'country' }
                ],
                items: resolved.sessions,
                emptyText: 'No sessions flagged.'
            },
            {
                id: 'friends',
                title: 'Friends & Contacts',
                icon: '👥',
                renderHint: 'table',
                columns: [
                    { label: 'Added Date', field: 'datetime' },
                    { label: 'Username',   field: 'friend' }
                ],
                items: resolved.friends,
                emptyText: 'No friends flagged.'
            },
            {
                id: 'dms',
                title: 'Direct Messages',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'Time',      field: 'datetime' },
                    { label: 'Direction',  field: 'direction' },
                    { label: 'Type',       field: 'type' },
                    { label: 'Sender',     field: 'sender' },
                    { label: 'Recipient',  field: 'recipient' },
                    { label: 'Msg Count',  field: 'msgCount' },
                    { label: 'Media Type', field: 'mediaType' },
                    { label: 'Media UUID', field: 'mediaUuid', type: 'mono' },
                    { label: 'IP',         field: 'ip', type: 'mono' }
                ],
                items: resolved.dms,
                emptyText: 'No DMs flagged.'
            },
            {
                id: 'groups',
                title: 'Group Messages',
                icon: '👥',
                renderHint: 'table',
                columns: [
                    { label: 'Time',      field: 'datetime' },
                    { label: 'Direction',  field: 'direction' },
                    { label: 'Type',       field: 'type' },
                    { label: 'Sender',     field: 'sender' },
                    { label: 'Group ID',   field: 'groupId', type: 'mono' },
                    { label: 'Recipient',  field: 'recipient' },
                    { label: 'Msg Count',  field: 'msgCount' },
                    { label: 'Media Type', field: 'mediaType' },
                    { label: 'Media UUID', field: 'mediaUuid', type: 'mono' },
                    { label: 'IP',         field: 'ip', type: 'mono' }
                ],
                items: resolved.groups,
                emptyText: 'No group messages flagged.'
            },
            {
                id: 'media',
                title: 'Media Activity',
                icon: '📎',
                renderHint: 'table',
                columns: [
                    { label: 'Time',      field: 'datetime' },
                    { label: 'Direction',  field: 'direction' },
                    { label: 'Sender',     field: 'sender' },
                    { label: 'Recipient',  field: 'recipient' },
                    { label: 'Type',       field: 'mediaType' },
                    { label: 'UUID',       field: 'mediaUuid', type: 'mono' },
                    { label: 'Context',    field: 'context' },
                    { label: 'IP',         field: 'ip', type: 'mono' }
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
            moduleSlug:    'kik',
            moduleLabel:   'KIK Warrant',
            moduleFolder:  'KikWarrant',
            bundlePrefix:  'KW',
            evidenceKind:  'warrant-kik',
            iconEmoji:     '💬',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for KIK warrant records
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.session = function (b) {
    return [b.timestamp || '', b.ip || ''].join('|');
};
window.WarrantFlagsKey.friend = function (f) {
    return [f.timestamp || '', f.friend || ''].join('|');
};
window.WarrantFlagsKey.dm = function (r, dir) {
    return [r.timestamp || '', r.sender || '', r.recipient || '', dir || ''].join('|');
};
window.WarrantFlagsKey.group = function (r, dir) {
    return [r.timestamp || '', r.sender || '', r.groupId || '', dir || ''].join('|');
};
window.WarrantFlagsKey.media = function (r, dir) {
    return [r.timestamp || '', r.mediaUuid || '', dir || ''].join('|');
};

window.KikWarrantModule = KikWarrantModule;
