/**
 * Google Warrant Parser — Main Module
 * Coordinates between UI, IPC handlers, and localStorage persistence
 * Runs in renderer process
 */

class GoogleWarrantModule {
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

        this.ui = new GoogleWarrantUI(containerId, this);
        window.googleWarrantUI = this.ui;
        this.ui.render();

        // Auto-scan for Google warrant ZIPs (non-blocking)
        this.scanForWarrants().catch(err => console.warn('Google warrant scan error:', err));

        return this;
    }

    /**
     * Load data from localStorage
     */
    loadData() {
        try {
            const raw = localStorage.getItem(`googleWarrant_${this.caseId}`);
            if (raw) {
                const data = JSON.parse(raw);
                this.imports = data.imports || [];
            }
        } catch (e) {
            console.error('Error loading google warrant data:', e);
            this.imports = [];
        }
    }

    /**
     * Save data to localStorage
     */
    saveData() {
        localStorage.setItem(`googleWarrant_${this.caseId}`, JSON.stringify({
            imports: this.imports
        }));
    }

    /**
     * Scan Evidence/ and Warrants/Production/ for Google warrant ZIPs
     */
    async scanForWarrants() {
        if (!window.electronAPI?.googleWarrantScan) return;

        try {
            const result = await window.electronAPI.googleWarrantScan({
                caseNumber: this.caseNumber,
                caseId: this.caseId
            });

            if (result.success && result.files.length > 0) {
                // Mark which files are already imported
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
            console.error('Error scanning for warrants:', err);
            this.evidenceFiles = [];
        }
    }

    /**
     * Import a Google warrant ZIP file
     * @param {string} filePath - path to the ZIP file
     * @param {string} fileName - display name
     */
    async importWarrant(filePath, fileName) {
        if (!window.electronAPI?.googleWarrantImport) {
            throw new Error('Google Warrant IPC handler not available');
        }

        const result = await window.electronAPI.googleWarrantImport({ filePath });

        if (!result.success) {
            throw new Error(result.error || 'Import failed');
        }

        // Build import record
        const importRecord = {
            id: this._generateId(),
            fileName: fileName || filePath.split(/[\\/]/).pop(),
            filePath: filePath,
            importedAt: new Date().toISOString(),
            accountEmail: result.data.accountEmail,
            accountId: result.data.accountId,
            dateRange: result.data.dateRange,
            categories: result.data.categories,
            noRecordCategories: result.data.noRecordCategories,
            coverLetter: result.data.coverLetter,
            subscriber: result.data.subscriber,
            changeHistory: result.data.changeHistory,
            emails: result.data.emails,
            emailMetadata: result.data.emailMetadata,
            locationRecords: result.data.locationRecords,
            semanticLocations: result.data.semanticLocations,
            devices: result.data.devices,
            installs: result.data.installs,
            library: result.data.library,
            userActivity: result.data.userActivity,
            chatMessages: result.data.chatMessages,
            chatUserInfo: result.data.chatUserInfo,
            chatGroupInfo: result.data.chatGroupInfo,
            hangoutsInfo: result.data.hangoutsInfo,
            googlePay: result.data.googlePay,
            driveFiles: result.data.driveFiles,
            accessLogActivity: result.data.accessLogActivity,
            ipActivity: result.data.ipActivity,
            playStorePreferences: result.data.playStorePreferences
        };

        // Replace if same file was imported before, else add
        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) {
            this.imports[existingIdx] = importRecord;
        } else {
            this.imports.push(importRecord);
        }

        this.saveData();

        // Refresh evidence bar
        await this.scanForWarrants();

        return importRecord;
    }

    /**
     * Import via file picker
     */
    async importFromPicker() {
        if (!window.electronAPI?.googleWarrantPickFile) {
            throw new Error('File picker not available');
        }

        const filePath = await window.electronAPI.googleWarrantPickFile();
        if (!filePath) return null; // User cancelled

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
     * Get statistics for tab item count
     */
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
        const d = imp.data || {};
        const out = {
            ipActivity: [],
            changeHistory: [],
            emails: [],
            locationVisits: [],
            devices: [],
            chatMessages: [],
            accessLog: [],
            payments: []
        };

        // IP Activity — flag key = composite (timestamp|ip|activityType)
        const flaggedIps = new Set((f.ipActivity || []).map(String));
        for (const r of (d.ipActivity || [])) {
            const k = WarrantFlagsKey.googleIpActivity(r);
            if (!flaggedIps.has(k)) continue;
            out.ipActivity.push({
                timestamp: r.timestamp || '',
                ip: r.ip || '',
                activityType: r.activityType || '',
                androidId: r.androidId || '',
                appleIdfv: r.appleIdfv || '',
                userAgent: r.userAgent || ''
            });
        }

        // Change History — flag key = composite (timestamp|ip|changeType)
        const flaggedChanges = new Set((f.changeHistory || []).map(String));
        for (const ch of (d.changeHistory || [])) {
            const k = WarrantFlagsKey.googleChangeHistory(ch);
            if (!flaggedChanges.has(k)) continue;
            out.changeHistory.push({
                timestamp: ch.timestamp || '',
                ip: ch.ip || '',
                changeType: ch.changeType || '',
                oldValue: ch.oldValue || '',
                newValue: ch.newValue || ''
            });
        }

        // Emails — flag key = email.id
        const flaggedEmailIds = new Set((f.emails || []).map(String));
        for (const em of (d.emails || [])) {
            if (!flaggedEmailIds.has(String(em.id))) continue;
            out.emails.push({
                id: em.id || '',
                from: em.from || '',
                to: em.to || '',
                cc: em.cc || '',
                subject: em.subject || '',
                date: em.date || '',
                labels: em.labels || '',
                textBody: (em.textBody || '').substring(0, 2000),
                attachments: (em.attachments || []).map(a => a.filename || a.contentType || '').join(', ')
            });
        }
        out.emails.sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));

        // Location Visits — flag key = composite (startTime|lat|lng)
        const flaggedLocs = new Set((f.locationVisits || []).map(String));
        const semanticLocs = d.semanticLocations || [];
        for (const v of semanticLocs) {
            if (v.type !== 'placeVisit') continue;
            const k = WarrantFlagsKey.googleLocationVisit(v);
            if (!flaggedLocs.has(k)) continue;
            out.locationVisits.push({
                name: v.name || '',
                address: v.address || '',
                placeId: v.placeId || '',
                lat: v.lat != null ? v.lat : '',
                lng: v.lng != null ? v.lng : '',
                startTime: v.startTime || '',
                endTime: v.endTime || '',
                confidence: v.confidence != null ? v.confidence : ''
            });
        }

        // Devices — flag key = androidId
        const flaggedDevIds = new Set((f.devices || []).map(String));
        for (const dvc of (d.devices || [])) {
            if (!flaggedDevIds.has(String(dvc.androidId || ''))) continue;
            out.devices.push({
                androidId: dvc.androidId || '',
                manufacturer: dvc.manufacturer || '',
                model: dvc.model || '',
                brand: dvc.brand || '',
                carrier: dvc.carrier || '',
                sdkVersion: dvc.sdkVersion || '',
                registrationTime: dvc.registrationTime || '',
                lastActive: dvc.lastActive || '',
                buildFingerprint: dvc.buildFingerprint || ''
            });
        }

        // Chat Messages — flag key = array index (no stable ID in Google chat data)
        const flaggedChatIdxs = new Set((f.chatMessages || []).map(String));
        const chatMsgs = d.chatMessages || [];
        chatMsgs.forEach((msg, idx) => {
            if (!flaggedChatIdxs.has(String(idx))) return;
            if (msg.type === 'html') {
                out.chatMessages.push({ index: idx, type: 'html', content: (msg.content || '').substring(0, 2000) });
            } else {
                out.chatMessages.push({ index: idx, type: 'json', content: JSON.stringify(msg).substring(0, 2000) });
            }
        });

        // Access Log Activity — flag key = composite (timestamp|ip|activity)
        const flaggedAccess = new Set((f.accessLog || []).map(String));
        for (const a of (d.accessLogActivity || [])) {
            const k = WarrantFlagsKey.googleAccessLog(a);
            if (!flaggedAccess.has(k)) continue;
            out.accessLog.push({
                timestamp: a.timestamp || '',
                activity: a.activity || '',
                ip: a.ip || '',
                details: a.details || ''
            });
        }

        // Payments (Google Pay transactions) — flag key = composite from CSV fields
        const flaggedPay = new Set((f.payments || []).map(String));
        const pay = d.googlePay || {};
        for (const t of (pay.transactions || [])) {
            const k = WarrantFlagsKey.googlePayment(t);
            if (!flaggedPay.has(k)) continue;
            out.payments.push({ ...t });
        }

        return out;
    }

    _buildSubjectInfo(imp) {
        const sub = imp.subscriber || {};
        return {
            'Account Email':   sub.email || imp.accountEmail || '',
            'Account ID':      sub.accountId || imp.accountId || '',
            'Name':            sub.name || '',
            'Created On':      sub.createdOn || '',
            'TOS IP':          sub.tosIp || '',
            'Status':          sub.status || '',
            'Recovery Email':  sub.recovery?.recoveryEmail || '',
            'Recovery SMS':    sub.recovery?.recoverySms || '',
            'Source File':     imp.fileName || ''
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
                    { label: 'Timestamp',   field: 'timestamp',    type: 'date' },
                    { label: 'IP',          field: 'ip',           type: 'mono' },
                    { label: 'Activity',    field: 'activityType' },
                    { label: 'Android ID',  field: 'androidId',    type: 'mono' },
                    { label: 'User Agent',  field: 'userAgent' }
                ],
                items: resolved.ipActivity,
                emptyText: 'No IP activity flagged.'
            },
            {
                id: 'changeHistory',
                title: 'Change History',
                icon: '⚙️',
                renderHint: 'table',
                columns: [
                    { label: 'Timestamp',  field: 'timestamp',  type: 'date' },
                    { label: 'IP',         field: 'ip',         type: 'mono' },
                    { label: 'Change Type', field: 'changeType' },
                    { label: 'Old Value',  field: 'oldValue' },
                    { label: 'New Value',  field: 'newValue' }
                ],
                items: resolved.changeHistory,
                emptyText: 'No change history flagged.'
            },
            {
                id: 'emails',
                title: 'Emails',
                icon: '📧',
                renderHint: 'messages',
                columns: [
                    { label: 'ID',          field: 'id',          type: 'mono' },
                    { label: 'Date',        field: 'date',        type: 'date' },
                    { label: 'From',        field: 'from' },
                    { label: 'To',          field: 'to' },
                    { label: 'Subject',     field: 'subject' },
                    { label: 'Body',        field: 'textBody',    type: 'longtext' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.emails,
                emptyText: 'No emails flagged.'
            },
            {
                id: 'locationVisits',
                title: 'Location Visits',
                icon: '📍',
                renderHint: 'table',
                columns: [
                    { label: 'Name',       field: 'name' },
                    { label: 'Address',    field: 'address' },
                    { label: 'Place ID',   field: 'placeId',    type: 'mono' },
                    { label: 'Lat',        field: 'lat',        type: 'mono' },
                    { label: 'Lng',        field: 'lng',        type: 'mono' },
                    { label: 'Start',      field: 'startTime',  type: 'date' },
                    { label: 'End',        field: 'endTime',    type: 'date' },
                    { label: 'Confidence', field: 'confidence' }
                ],
                items: resolved.locationVisits,
                emptyText: 'No location visits flagged.'
            },
            {
                id: 'devices',
                title: 'Devices',
                icon: '📱',
                renderHint: 'table',
                columns: [
                    { label: 'Android ID',       field: 'androidId',        type: 'mono' },
                    { label: 'Manufacturer',     field: 'manufacturer' },
                    { label: 'Model',            field: 'model' },
                    { label: 'Brand',            field: 'brand' },
                    { label: 'Carrier',          field: 'carrier' },
                    { label: 'SDK Version',      field: 'sdkVersion',       type: 'mono' },
                    { label: 'Registered',       field: 'registrationTime', type: 'date' },
                    { label: 'Last Active',      field: 'lastActive',       type: 'date' },
                    { label: 'Build Fingerprint', field: 'buildFingerprint', type: 'mono' }
                ],
                items: resolved.devices,
                emptyText: 'No devices flagged.'
            },
            {
                id: 'chatMessages',
                title: 'Chat Messages',
                icon: '💬',
                renderHint: 'pre',
                columns: [
                    { label: 'Index',   field: 'index',   type: 'mono' },
                    { label: 'Type',    field: 'type' },
                    { label: 'Content', field: 'content', type: 'longtext' }
                ],
                items: resolved.chatMessages,
                emptyText: 'No chat messages flagged.'
            },
            {
                id: 'accessLog',
                title: 'Access Log',
                icon: '📋',
                renderHint: 'table',
                columns: [
                    { label: 'Timestamp', field: 'timestamp', type: 'date' },
                    { label: 'Activity',  field: 'activity' },
                    { label: 'IP',        field: 'ip',        type: 'mono' },
                    { label: 'Details',   field: 'details' }
                ],
                items: resolved.accessLog,
                emptyText: 'No access log entries flagged.'
            },
            {
                id: 'payments',
                title: 'Google Pay Transactions',
                icon: '💳',
                renderHint: 'table',
                columns: Object.keys((resolved.payments && resolved.payments[0]) || {}).map(k => ({ label: k, field: k })),
                items: resolved.payments,
                emptyText: 'No payment transactions flagged.'
            }
        ].filter(sec => sec.items.length > 0 || sec.id === 'ipActivity');
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'google',
            moduleLabel:   'Google Warrant',
            moduleFolder:  'GoogleWarrant',
            bundlePrefix:  'GW',
            evidenceKind:  'warrant-google',
            iconEmoji:     '🔍',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for Google warrant sections
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.googleIpActivity = function (r) {
    return [r.timestamp || '', r.ip || '', r.activityType || ''].join('|');
};
window.WarrantFlagsKey.googleChangeHistory = function (ch) {
    return [ch.timestamp || '', ch.ip || '', ch.changeType || ''].join('|');
};
window.WarrantFlagsKey.googleLocationVisit = function (v) {
    return [v.startTime || '', v.lat || '', v.lng || ''].join('|');
};
window.WarrantFlagsKey.googleAccessLog = function (a) {
    return [a.timestamp || '', a.ip || '', a.activity || ''].join('|');
};
window.WarrantFlagsKey.googlePayment = function (t) {
    // Google Pay transactions are parsed from CSV — keys are dynamic.
    // Use a hash of all values as a stable key.
    const vals = Object.values(t || {}).join('|');
    return vals;
};

// Expose on window so initializeGoogleWarrant() can find it
window.GoogleWarrantModule = GoogleWarrantModule;
