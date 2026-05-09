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
        this.loadData();
        this.ui = new SnapchatWarrantUI(containerId, this);
        window.snapchatWarrantUI = this.ui;
        this.ui.render();

        // Auto-scan Evidence/ and Warrants/Production/ for Snapchat warrant files (non-blocking)
        this.scanForWarrants().catch(err => console.warn('Snapchat warrant scan error:', err));
        return this;
    }

    loadData() {
        try {
            const raw = localStorage.getItem(`snapchatWarrant_${this.caseId}`);
            if (raw) {
                const data = JSON.parse(raw);
                this.imports = data.imports || [];
            }
        } catch (e) {
            console.error('Error loading Snapchat warrant data:', e);
            this.imports = [];
        }
    }

    saveData() {
        localStorage.setItem(`snapchatWarrant_${this.caseId}`, JSON.stringify({
            imports: this.imports
        }));
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

        this.saveData();
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

    deleteImport(importId) {
        this.imports = this.imports.filter(i => i.id !== importId);
        this.saveData();
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
        const out = {
            conversations: [],
            logins: [],
            geo: [],
            devices: [],
            friends: [],
            snapHistory: [],
            memories: []
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

        return out;
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

window.SnapchatWarrantModule = SnapchatWarrantModule;
