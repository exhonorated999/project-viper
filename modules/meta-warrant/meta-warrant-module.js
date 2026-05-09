/**
 * META Warrant Parser — Main Module
 * Coordinates between UI, IPC handlers, and localStorage persistence.
 * Runs in renderer process.
 */

class MetaWarrantModule {
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
        this.ui = new MetaWarrantUI(containerId, this);
        window.metaWarrantUI = this.ui;
        this.ui.render();

        // Auto-scan for META warrant ZIPs (non-blocking)
        this.scanForWarrants().catch(err => console.warn('META warrant scan error:', err));
        return this;
    }

    /**
     * Load data from localStorage
     */
    loadData() {
        try {
            const raw = localStorage.getItem(`metaWarrant_${this.caseId}`);
            if (raw) {
                const data = JSON.parse(raw);
                this.imports = data.imports || [];
            }
        } catch (e) {
            console.error('Error loading META warrant data:', e);
            this.imports = [];
        }
    }

    /**
     * Save data to localStorage
     */
    saveData() {
        localStorage.setItem(`metaWarrant_${this.caseId}`, JSON.stringify({
            imports: this.imports
        }));
    }

    /**
     * Scan Evidence/ and Warrants/Production/ for META warrant ZIPs
     */
    async scanForWarrants() {
        if (!window.electronAPI?.metaWarrantScan) return;

        try {
            const result = await window.electronAPI.metaWarrantScan({
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
            console.error('Error scanning for META warrants:', err);
            this.evidenceFiles = [];
        }
    }

    /**
     * Import a META warrant ZIP file
     */
    async importWarrant(filePath, fileName) {
        if (!window.electronAPI?.metaWarrantImport) {
            throw new Error('META Warrant IPC handler not available');
        }

        const result = await window.electronAPI.metaWarrantImport({
            filePath,
            caseNumber: this.caseNumber
        });

        if (!result.success) {
            throw new Error(result.error || 'Import failed');
        }

        // Build import record from parsed data
        const data = result.data;
        const primaryRecord = data.records.find(r => r.source === 'records') || data.records[0];

        const importRecord = {
            id: this._generateId(),
            fileName: fileName || filePath.split(/[\\/]/).pop(),
            filePath: filePath,
            importedAt: new Date().toISOString(),
            service: primaryRecord?.service || 'Facebook',
            targetId: primaryRecord?.targetId || null,
            accountId: primaryRecord?.accountId || null,
            dateRange: primaryRecord?.dateRange || null,
            generated: primaryRecord?.generated || null,
            records: data.records,
            mediaFiles: data.mediaFiles
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
        if (!window.electronAPI?.metaWarrantPickFile) {
            throw new Error('File picker not available');
        }
        const filePath = await window.electronAPI.metaWarrantPickFile();
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

    /**
     * Read a media file from disk (for images saved during import)
     */
    async readMedia(diskPath) {
        if (!window.electronAPI?.metaWarrantReadMedia) return null;
        try {
            const result = await window.electronAPI.metaWarrantReadMedia({ filePath: diskPath });
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

    // ─── Flag-to-Evidence (uses shared WarrantFlags mixin) ─────────────
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
        // Meta stores data in imp.records[]; primary record is the main one
        const rec = imp.records
            ? imp.records.find(r => r.source === 'records') || imp.records[0]
            : null;
        const out = {
            ipActivity: [],
            statusUpdates: [],
            wallposts: [],
            otherWallPosts: [],
            shares: [],
            photos: [],
            messages: []
        };

        if (!rec) return out;

        // IP Activity — flag key = ip string
        const flaggedIps = new Set((f.ipActivity || []).map(String));
        for (const entry of (rec.ipAddresses || [])) {
            if (!flaggedIps.has(String(entry.ip))) continue;
            out.ipActivity.push({
                ip: entry.ip || '',
                time: entry.time || ''
            });
        }

        // Status Updates — flag key = id or composite
        const flaggedStatus = new Set((f.statusUpdates || []).map(String));
        for (const u of (rec.statusUpdates || [])) {
            const k = u.id || window.WarrantFlagsKey.metaStatusUpdate(u);
            if (!flaggedStatus.has(String(k))) continue;
            out.statusUpdates.push({
                id: u.id || '',
                posted: u.posted || '',
                status: u.status || '',
                author: u.author || '',
                mobile: u.mobile || '',
                lifeExperience: u.lifeExperience || ''
            });
        }

        // Wallposts — flag key = id or composite
        const flaggedWall = new Set((f.wallposts || []).map(String));
        for (const w of (rec.wallposts || [])) {
            const k = w.id || window.WarrantFlagsKey.metaWallpost(w);
            if (!flaggedWall.has(String(k))) continue;
            out.wallposts.push({
                id: w.id || '',
                from: w.from || '',
                to: w.to || '',
                time: w.time || '',
                text: w.text || '',
                attachments: w.attachments || ''
            });
        }

        // Posts to Other Walls — flag key = id
        const flaggedOther = new Set((f.otherWallPosts || []).map(String));
        for (const p of (rec.postsToOtherWalls || [])) {
            if (!flaggedOther.has(String(p.id))) continue;
            out.otherWallPosts.push({
                id: p.id || '',
                post: p.post || '',
                time: p.time || '',
                timelineOwner: p.timelineOwner || ''
            });
        }

        // Shares — flag key = composite
        const flaggedShares = new Set((f.shares || []).map(String));
        for (const s of (rec.shares || [])) {
            const k = window.WarrantFlagsKey.metaShare(s);
            if (!flaggedShares.has(k)) continue;
            out.shares.push({
                dateCreated: s.dateCreated || '',
                title: s.title || '',
                text: s.text || '',
                summary: s.summary || '',
                url: s.url || ''
            });
        }

        // Photos — flag key = id or composite
        const flaggedPhotos = new Set((f.photos || []).map(String));
        for (const p of (rec.photos || [])) {
            const k = p.id || window.WarrantFlagsKey.metaPhoto(p);
            if (!flaggedPhotos.has(String(k))) continue;
            out.photos.push({
                id: p.id || '',
                album: p.album || p.albumName || '',
                title: p.title || '',
                uploaded: p.uploaded || '',
                uploadIp: p.uploadIp || '',
                author: p.author || '',
                link: p.link || ''
            });
        }

        // Messages — flag key = composite (threadId|author|sent)
        const flaggedMsgs = new Set((f.messages || []).map(String));
        for (const thread of (rec.messages?.threads || [])) {
            const threadId = thread.threadId || '?';
            for (const m of (thread.messages || [])) {
                const k = window.WarrantFlagsKey.metaMessage(threadId, m);
                if (!flaggedMsgs.has(k)) continue;
                out.messages.push({
                    threadId,
                    author: m.author || '',
                    sent: m.sent || '',
                    body: m.body || '',
                    participants: (thread.participants || []).join(', '),
                    attachments: (m.attachments || []).map(a => a.description || a.type || '').filter(Boolean).join('; ')
                });
            }
        }
        out.messages.sort((a, b) => (a.sent || '').localeCompare(b.sent || ''));

        return out;
    }

    _buildSubjectInfo(imp) {
        const rec = imp.records
            ? imp.records.find(r => r.source === 'records') || imp.records[0]
            : null;
        return {
            'Service':        imp.service || rec?.service || '',
            'Target ID':      imp.targetId || rec?.targetId || '',
            'Account ID':     imp.accountId || rec?.accountId || '',
            'Date Range':     imp.dateRange || rec?.dateRange || '',
            'Generated':      imp.generated || rec?.generated || '',
            'Registration IP': rec?.registrationIp || '',
            'Source File':    imp.fileName || ''
        };
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'ipActivity',
                title: 'IP Activity',
                icon: '🌐',
                renderHint: 'table',
                columns: [
                    { label: 'IP',      field: 'ip',   type: 'mono' },
                    { label: 'Time',    field: 'time', type: 'date' }
                ],
                items: resolved.ipActivity,
                emptyText: 'No IP addresses flagged.'
            },
            {
                id: 'statusUpdates',
                title: 'Status Updates',
                icon: '📝',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',             field: 'id',             type: 'mono' },
                    { label: 'Posted',         field: 'posted',         type: 'date' },
                    { label: 'Status',         field: 'status',         type: 'longtext' },
                    { label: 'Author',         field: 'author' },
                    { label: 'Mobile',         field: 'mobile' },
                    { label: 'Life Experience', field: 'lifeExperience' }
                ],
                items: resolved.statusUpdates,
                emptyText: 'No status updates flagged.'
            },
            {
                id: 'wallposts',
                title: 'Wallposts',
                icon: '📌',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',    field: 'id',    type: 'mono' },
                    { label: 'From',  field: 'from' },
                    { label: 'To',    field: 'to' },
                    { label: 'Time',  field: 'time',  type: 'date' },
                    { label: 'Text',  field: 'text',  type: 'longtext' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.wallposts,
                emptyText: 'No wallposts flagged.'
            },
            {
                id: 'otherWallPosts',
                title: 'Posts to Other Walls',
                icon: '📤',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',             field: 'id',             type: 'mono' },
                    { label: 'Post',           field: 'post',           type: 'longtext' },
                    { label: 'Time',           field: 'time',           type: 'date' },
                    { label: 'Timeline Owner', field: 'timelineOwner' }
                ],
                items: resolved.otherWallPosts,
                emptyText: 'No posts to other walls flagged.'
            },
            {
                id: 'shares',
                title: 'Shares',
                icon: '🔗',
                renderHint: 'cards',
                columns: [
                    { label: 'Date Created', field: 'dateCreated', type: 'date' },
                    { label: 'Title',        field: 'title' },
                    { label: 'Text',         field: 'text',        type: 'longtext' },
                    { label: 'Summary',      field: 'summary',     type: 'longtext' },
                    { label: 'URL',          field: 'url',         type: 'mono' }
                ],
                items: resolved.shares,
                emptyText: 'No shares flagged.'
            },
            {
                id: 'photos',
                title: 'Photos',
                icon: '📷',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',        field: 'id',        type: 'mono' },
                    { label: 'Album',     field: 'album' },
                    { label: 'Title',     field: 'title' },
                    { label: 'Uploaded',  field: 'uploaded',  type: 'date' },
                    { label: 'Upload IP', field: 'uploadIp',  type: 'mono' },
                    { label: 'Author',   field: 'author' },
                    { label: 'Link',     field: 'link',       type: 'mono' }
                ],
                items: resolved.photos,
                emptyText: 'No photos flagged.'
            },
            {
                id: 'messages',
                title: 'Messages',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'Thread ID',   field: 'threadId',     type: 'mono' },
                    { label: 'Author',      field: 'author' },
                    { label: 'Sent',        field: 'sent',         type: 'date' },
                    { label: 'Body',        field: 'body',         type: 'longtext' },
                    { label: 'Participants', field: 'participants' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.messages,
                emptyText: 'No messages flagged.'
            }
        ];
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'meta',
            moduleLabel:   'Meta Warrant',
            moduleFolder:  'MetaWarrant',
            bundlePrefix:  'MW',
            evidenceKind:  'warrant-meta',
            iconEmoji:     '📘',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for Meta warrant items (used by both module + UI)
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.metaMessage = function (threadId, msg) {
    return [threadId || '', msg.author || '', msg.sent || ''].join('|');
};
window.WarrantFlagsKey.metaStatusUpdate = function (u) {
    return [u.posted || '', u.author || '', (u.status || '').substring(0, 40)].join('|');
};
window.WarrantFlagsKey.metaWallpost = function (w) {
    return [w.from || '', w.to || '', w.time || ''].join('|');
};
window.WarrantFlagsKey.metaShare = function (s) {
    return [s.dateCreated || '', s.title || '', (s.url || '').substring(0, 60)].join('|');
};
window.WarrantFlagsKey.metaPhoto = function (p) {
    return [p.album || p.albumName || '', p.uploaded || '', p.title || ''].join('|');
};

window.MetaWarrantModule = MetaWarrantModule;
