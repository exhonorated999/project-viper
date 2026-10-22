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
        try {
            localStorage.setItem(`googleWarrant_${this.caseId}`, JSON.stringify({
                imports: this.imports
            }));
            this.lastSaveError = null;
            return true;
        } catch (e) {
            // A failed save used to throw out of the import and lose the work silently.
            const quota = (e && (e.name === 'QuotaExceededError' || e.code === 22)) || /quota/i.test(String(e && e.message));
            const msg = quota
                ? 'Google Warrant data could not be saved: VIPER\'s storage for case data is full. The import is shown now but will not be there after VIPER restarts. Remove older imports you no longer need, then import again.'
                : 'Google Warrant data could not be saved: ' + ((e && e.message) || e);
            console.error('[google-warrant] saveData failed:', e);
            this.lastSaveError = msg;
            try { if (this.ui && this.ui._toast) this.ui._toast(msg, 'error'); } catch (_) {}
            return false;
        }
    }

    /** True when e-mails / location points live in the per-import SQLite store. */
    hasStore(imp) {
        return !!(imp && imp.store && Array.isArray(imp.store.keys) && imp.store.keys.length);
    }

    emailTotal(imp) {
        if (!imp) return 0;
        return this.hasStore(imp) ? (imp.store.emailCount || 0) + (imp.legacyEmails || []).length : (imp.emails || []).length;
    }

    locationTotal(imp) {
        if (!imp) return 0;
        return this.hasStore(imp) ? (imp.store.locationCount || 0) + (imp.legacyLocationRecords || []).length : (imp.locationRecords || []).length;
    }

    async emailsPage(imp, { offset = 0, limit = 50, q = '' } = {}) {
        if (!this.hasStore(imp) || !window.electronAPI?.googleWarrantEmailsPage) return { success: false, error: 'E-mail store not available' };
        return window.electronAPI.googleWarrantEmailsPage({ caseNumber: this.caseNumber, keys: imp.store.keys, offset, limit, q });
    }

    async getEmail(key, seq) {
        if (!window.electronAPI?.googleWarrantEmail) return null;
        const res = await window.electronAPI.googleWarrantEmail({ caseNumber: this.caseNumber, key, seq });
        return res && res.success ? res.email : null;
    }

    async locationsPage(imp, { offset = 0, limit = 500, sample = 0 } = {}) {
        if (!this.hasStore(imp) || !window.electronAPI?.googleWarrantLocations) return { success: false, error: 'Location store not available' };
        return window.electronAPI.googleWarrantLocations({ caseNumber: this.caseNumber, keys: imp.store.keys, offset, limit, sample });
    }

    /**
     * Store-backed e-mails are not in the import record, so a flagged one is
     * copied here (first 2,000 characters of the body) for Push to Evidence.
     */
    async cacheFlaggedEmail(imp, row) {
        if (!imp || !row || row.id == null) return;
        imp.flaggedEmailCache = imp.flaggedEmailCache || {};
        let full = null;
        try { if (row.key && row.seq != null) full = await this.getEmail(row.key, row.seq); } catch (_) {}
        const src = full || row;
        imp.flaggedEmailCache[String(row.id)] = {
            id: src.id, from: src.from || '', to: src.to || '', cc: src.cc || '', subject: src.subject || '',
            date: src.date || '', labels: src.labels || '', threadId: src.threadId || '',
            textBody: String(src.textBody || src.snippet || '').substring(0, 2000),
            attachments: src.attachments || [],
        };
        this.saveData();
    }

    async openMedia(relPath, reveal) {
        if (!window.electronAPI?.googleWarrantOpenMedia || !relPath) return { success: false, error: 'Not available' };
        return window.electronAPI.googleWarrantOpenMedia({ caseNumber: this.caseNumber, relPath, reveal: !!reveal });
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

        const result = await window.electronAPI.googleWarrantImport({ filePath, caseNumber: this.caseNumber });

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
            aggregatedActivity: result.data.aggregatedActivity || [],
            myActivity: result.data.myActivity || [],
            ipActivity: result.data.ipActivity,
            playStorePreferences: result.data.playStorePreferences,
            contacts: result.data.contacts || [],
            calendars: result.data.calendars || [],
            calendarSettings: result.data.calendarSettings || null,
            tasks: result.data.tasks || [],
            mailUserSettings: result.data.mailUserSettings || null,
            voiceSubscriber: result.data.voiceSubscriber || null,
            meetHistory: result.data.meetHistory || [],
            linkedByPhone: result.data.linkedByPhone || [],
            photos: result.data.photos || [],
            bundleSources: result.data.bundleSources || [],
            rawSections: result.data.rawSections || {},
            sourceFiles: [filePath], // tracks which physical files contributed
            // Source Validation: SHA-256 of the original taken at import.
            sourceIntegrity: result.data.sourceIntegrity || null,
            sourceIntegrityByPath: result.data.sourceIntegrity ? { [filePath]: result.data.sourceIntegrity } : {},
            // Large returns: e-mails + location points are in a SQLite store under
            // the case (emails/locationRecords above are just the first few).
            store: result.data.store ? Object.assign({}, result.data.store, {
                perKey: { [result.data.store.keys[0]]: {
                    emailCount: result.data.store.emailCount || 0,
                    emailDuplicates: result.data.store.emailDuplicates || 0,
                    locationCount: result.data.store.locationCount || 0,
                } }
            }) : null,
            truncated: result.data.truncated || null,
            oversizeFiles: result.data.oversizeFiles || [],
            _diagnostics: result.data._diagnostics
        };

        // ─── Auto-merge across multi-part master ZIPs ───────────────────
        // Google splits very large warrant returns into 10+ parts
        // (e.g. 30136296-20260514-1.zip, …-2.zip, …). Each part contains a
        // different slice of the per-service inner zips. We detect a
        // previously-imported record for the same account (+ overlapping
        // date range) and merge instead of creating a second card.
        const existingMergeIdx = this._findMergeTarget(importRecord);
        const sameFileIdx = this.imports.findIndex(i => i.filePath === filePath);

        if (sameFileIdx >= 0) {
            // Re-import of the exact same file — replace (current behaviour)
            this.imports[sameFileIdx] = importRecord;
            this._mergeNotice = null;
        } else if (existingMergeIdx >= 0) {
            // Merge into the existing import for this account
            const merged = this._mergeImports(this.imports[existingMergeIdx], importRecord);
            this.imports[existingMergeIdx] = merged;
            this._mergeNotice = {
                targetId: merged.id,
                accountEmail: merged.accountEmail,
                partsCount: merged.sourceFiles.length,
                bundleSources: merged.bundleSources
            };
        } else {
            this.imports.push(importRecord);
            this._mergeNotice = null;
        }

        this.saveData();

        // Refresh evidence bar
        await this.scanForWarrants();

        return existingMergeIdx >= 0 ? this.imports[existingMergeIdx] : importRecord;
    }

    /**
     * Find an existing import to auto-merge into. Match criteria (any):
     *   1. Same accountEmail AND same accountId AND not the same filePath
     *   2. Same accountEmail AND overlapping date range (within 30 days)
     * Returns index in this.imports, or -1.
     */
    _findMergeTarget(incoming) {
        if (!incoming.accountEmail && !incoming.accountId) return -1;
        for (let i = 0; i < this.imports.length; i++) {
            const ex = this.imports[i];
            if (!ex) continue;
            if (ex.filePath === incoming.filePath) continue; // same file → replace, not merge
            const sameEmail = ex.accountEmail && incoming.accountEmail && ex.accountEmail.toLowerCase() === incoming.accountEmail.toLowerCase();
            const sameAcctId = ex.accountId && incoming.accountId && String(ex.accountId) === String(incoming.accountId);
            if (sameEmail || sameAcctId) return i;
        }
        return -1;
    }

    /**
     * Deep-merge two import records. Dedupes arrays where it can identify
     * stable keys (msg id, photo relPath, ip+timestamp). Falls back to
     * concatenation for opaque arrays.
     */
    _mergeImports(base, incoming) {
        const merged = { ...base };
        // Concatenation helpers
        const concat = (a, b) => [...(a || []), ...(b || [])];
        const concatById = (a, b, idFn) => {
            const seen = new Set((a || []).map(idFn).filter(Boolean));
            const out = [...(a || [])];
            for (const item of (b || [])) {
                const id = idFn(item);
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                out.push(item);
            }
            return out;
        };

        merged.categories = Array.from(new Set([...(base.categories || []), ...(incoming.categories || [])]));
        merged.noRecordCategories = Array.from(new Set([...(base.noRecordCategories || []), ...(incoming.noRecordCategories || [])]));
        merged.bundleSources = Array.from(new Set([...(base.bundleSources || []), ...(incoming.bundleSources || [])]));
        merged.sourceFiles = Array.from(new Set([...(base.sourceFiles || []), ...(incoming.sourceFiles || [])]));
        // Each part keeps its own import fingerprint; the card's main file stays the first part.
        merged.sourceIntegrity = base.sourceIntegrity || null;
        merged.sourceIntegrityByPath = Object.assign({}, base.sourceIntegrityByPath || {}, incoming.sourceIntegrityByPath || {});

        // Subscriber / cover letter / change history: take incoming if base missing
        merged.subscriber = base.subscriber || incoming.subscriber;
        merged.coverLetter = base.coverLetter || incoming.coverLetter;
        merged.chatUserInfo = base.chatUserInfo || incoming.chatUserInfo;
        merged.hangoutsInfo = base.hangoutsInfo || incoming.hangoutsInfo;
        merged.calendarSettings = base.calendarSettings || incoming.calendarSettings;
        merged.mailUserSettings = base.mailUserSettings || incoming.mailUserSettings;
        merged.voiceSubscriber = base.voiceSubscriber || incoming.voiceSubscriber;
        merged.changeHistory = concat(base.changeHistory, incoming.changeHistory);

        // Date range — pick widest
        if (incoming.dateRange) {
            merged.dateRange = merged.dateRange || { start: null, end: null };
            if (incoming.dateRange.start && (!merged.dateRange.start || incoming.dateRange.start < merged.dateRange.start)) merged.dateRange.start = incoming.dateRange.start;
            if (incoming.dateRange.end && (!merged.dateRange.end || incoming.dateRange.end > merged.dateRange.end)) merged.dateRange.end = incoming.dateRange.end;
        }

        // Mail + Location
        const hasStore = (r) => this.hasStore(r);
        if (hasStore(base) || hasStore(incoming)) {
            // Counts are kept per store so re-importing a part replaces its numbers.
            const perKey = Object.assign({}, (base.store && base.store.perKey) || {}, (incoming.store && incoming.store.perKey) || {});
            const keys = Array.from(new Set([...((base.store && base.store.keys) || []), ...((incoming.store && incoming.store.keys) || [])]));
            const sum = (f) => keys.reduce((s, k) => s + ((perKey[k] && perKey[k][f]) || 0), 0);
            merged.store = { keys, perKey, emailCount: sum('emailCount'), emailDuplicates: sum('emailDuplicates'), locationCount: sum('locationCount') };
            // A part imported by an older VIPER has its e-mails inline: keep them apart from the previews.
            const legacy = (r) => hasStore(r)
                ? { emails: r.legacyEmails || [], locs: r.legacyLocationRecords || [] }
                : { emails: r.emails || [], locs: r.locationRecords || [] };
            const preview = (r) => hasStore(r) ? { emails: r.emails || [], locs: r.locationRecords || [] } : { emails: [], locs: [] };
            const lb = legacy(base), li = legacy(incoming);
            merged.legacyEmails = concatById(lb.emails, li.emails, e => (e && (e.messageId || e.id)) || null);
            merged.legacyLocationRecords = concat(lb.locs, li.locs);
            merged.emails = concatById(preview(base).emails, preview(incoming).emails, e => (e && (e.messageId || e.id)) || null);
            merged.locationRecords = concat(preview(base).locs, preview(incoming).locs);
            merged.flaggedEmailCache = Object.assign({}, base.flaggedEmailCache || {}, incoming.flaggedEmailCache || {});
        } else {
            merged.emails = concatById(base.emails, incoming.emails, e => (e && (e.messageId || e.id)) || null);
            merged.locationRecords = concat(base.locationRecords, incoming.locationRecords);
        }
        merged.emailMetadata = concat(base.emailMetadata, incoming.emailMetadata);
        merged.semanticLocations = concat(base.semanticLocations, incoming.semanticLocations);

        // What did not fit in the record
        if (base.truncated || incoming.truncated) {
            merged.truncated = Object.assign({}, base.truncated || {});
            for (const [k, n] of Object.entries(incoming.truncated || {})) merged.truncated[k] = (merged.truncated[k] || 0) + n;
        }
        merged.oversizeFiles = concat(base.oversizeFiles, incoming.oversizeFiles);

        // Devices / installs / library (dedupe by JSON when possible)
        merged.devices = concat(base.devices, incoming.devices);
        merged.installs = concat(base.installs, incoming.installs);
        merged.library = concat(base.library, incoming.library);
        merged.userActivity = concat(base.userActivity, incoming.userActivity);

        // Chat / Pay / Drive
        merged.chatMessages = concat(base.chatMessages, incoming.chatMessages);
        merged.chatGroupInfo = concat(base.chatGroupInfo, incoming.chatGroupInfo);
        merged.googlePay = {
            instruments:  concat(base.googlePay && base.googlePay.instruments,  incoming.googlePay && incoming.googlePay.instruments),
            transactions: concat(base.googlePay && base.googlePay.transactions, incoming.googlePay && incoming.googlePay.transactions),
            addresses:    concat(base.googlePay && base.googlePay.addresses,    incoming.googlePay && incoming.googlePay.addresses),
            customerInfo: (base.googlePay && base.googlePay.customerInfo) || (incoming.googlePay && incoming.googlePay.customerInfo)
        };
        merged.driveFiles = concat(base.driveFiles, incoming.driveFiles);

        // Access log / activity
        merged.accessLogActivity = concat(base.accessLogActivity, incoming.accessLogActivity);
        merged.aggregatedActivity = concat(base.aggregatedActivity, incoming.aggregatedActivity);
        merged.myActivity = concat(base.myActivity, incoming.myActivity);
        merged.ipActivity = concat(base.ipActivity, incoming.ipActivity);
        merged.playStorePreferences = concat(base.playStorePreferences, incoming.playStorePreferences);

        // Newer categories
        merged.contacts = concat(base.contacts, incoming.contacts);
        merged.calendars = concat(base.calendars, incoming.calendars);
        merged.tasks = concat(base.tasks, incoming.tasks);
        merged.meetHistory = concat(base.meetHistory, incoming.meetHistory);
        merged.linkedByPhone = concat(base.linkedByPhone, incoming.linkedByPhone);

        // Photos — dedupe by relPath (each master bundle writes into its own subdir)
        merged.photos = concatById(base.photos, incoming.photos, p => p && p.relPath);

        // Raw sections — merge bucket arrays per-category
        merged.rawSections = { ...(base.rawSections || {}) };
        for (const cat of Object.keys(incoming.rawSections || {})) {
            const a = merged.rawSections[cat] || { html: [], csv: [], json: [], other: [] };
            const b = incoming.rawSections[cat] || { html: [], csv: [], json: [], other: [] };
            merged.rawSections[cat] = {
                html:  concat(a.html, b.html),
                csv:   concat(a.csv, b.csv),
                json:  concat(a.json, b.json),
                other: concat(a.other, b.other)
            };
        }

        // Bookkeeping
        merged.importedAt = base.importedAt; // first-import timestamp wins
        merged.fileName = base.fileName + ` (+${(merged.sourceFiles.length - 1)} part${merged.sourceFiles.length > 2 ? 's' : ''})`;
        // Preserve flags from base; nothing in incoming yet.

        return merged;
    }

    // ─── Media accessors (for the gallery UI) ──────────────────────────

    /**
     * Read a photo as base64 — use for thumbnail rendering. Routes through the
     * Field-Security-aware IPC so encrypted media is transparently decrypted.
     */
    async readMedia(relPath) {
        if (!window.electronAPI?.googleWarrantReadMedia || !relPath) return null;
        try {
            const res = await window.electronAPI.googleWarrantReadMedia({ caseNumber: this.caseNumber, relPath });
            if (res && res.success) return `data:${res.mimeType};base64,${res.data}`;
            if (res && res.error && !this._readMediaErrLogged) {
                console.warn('[google-warrant] readMedia failure:', relPath, res.error);
                this._readMediaErrLogged = true;
            }
            return null;
        } catch (e) {
            console.warn('readMedia error:', e);
            return null;
        }
    }

    /**
     * Get a streamable viper-media:// URL for full-res view / video playback.
     */
    async getMediaUrl(relPath) {
        if (!window.electronAPI?.googleWarrantGetMediaUrl || !relPath) return null;
        try {
            const res = await window.electronAPI.googleWarrantGetMediaUrl({ caseNumber: this.caseNumber, relPath });
            if (res && res.success) return res.fileUrl;
            return null;
        } catch (e) {
            console.warn('getMediaUrl error:', e);
            return null;
        }
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
        const gone = this.imports.find(i => i && i.id === importId);
        this.imports = this.imports.filter(i => i.id !== importId);
        this.saveData();
        // Remove its e-mail / location store unless another import still uses it.
        if (this.hasStore(gone) && window.electronAPI?.googleWarrantStoreDelete) {
            const inUse = new Set();
            for (const i of this.imports) if (this.hasStore(i)) i.store.keys.forEach(k => inUse.add(k));
            const keys = gone.store.keys.filter(k => !inUse.has(k));
            if (keys.length) {
                window.electronAPI.googleWarrantStoreDelete({ caseNumber: this.caseNumber, keys })
                    .catch(e => console.warn('[google-warrant] store delete failed:', e));
            }
        }
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
        // Google import records keep their sections at the top level (there is
        // no .data). Reading imp.data here left every flagged item behind.
        const d = (imp && imp.data) || imp || {};
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
        const emailPool = [];
        const seenEmail = new Set();
        const cache = (imp && imp.flaggedEmailCache) || {};
        // Store-backed e-mails: the flagged copy (with body) wins over the short preview.
        for (const id of Object.keys(cache)) { emailPool.push(cache[id]); seenEmail.add(String(id)); }
        for (const em of [...(d.emails || []), ...(d.legacyEmails || [])]) {
            if (!em || seenEmail.has(String(em.id))) continue;
            seenEmail.add(String(em.id));
            emailPool.push(em);
        }
        for (const em of emailPool) {
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
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved),
            // Source Validation: find each flagged item in the original return.
            getSourceSpec:     (imp) => this._sourceSpec(imp),
            getItemCitation:   (sectionId, item, imp) => this._citationFor(imp, sectionId, item)
        });
    }

    /** The original return: the main file plus every other part merged into this card. */
    _sourceSpec(imp) {
        if (!imp) return null;
        const main = imp.sourcePath || imp.filePath;
        if (!main) return null;
        const extra = (imp.sourceFiles || []).filter(p => p && p !== main && p !== imp.filePath);
        const source = extra.length ? { path: main, extraPaths: extra } : { path: main };
        const byPath = imp.sourceIntegrityByPath || {};
        return { source, expected: imp.sourcePath ? (imp.sourceIntegrity || null) : (byPath[main] || imp.sourceIntegrity || null) };
    }

    /**
     * What to look for in the original, per flagged item. values[0] is the
     * thing being validated; the rest are details of the same record that
     * should sit beside it. Only values Google prints as-is are used —
     * email dates and coordinates are converted on import, so they are not.
     */
    _citationFor(imp, sectionId, it) {
        it = it || {};
        const v = (hints, ...a) => ({ values: a, memberHints: hints });
        switch (sectionId) {
            case 'ipActivity':     return v(['SubscriberInfo'], it.ip, it.timestamp, it.activityType);
            case 'changeHistory':  return v(['ChangeHistory', 'SubscriberInfo'], it.timestamp, it.ip, it.changeType);
            case 'emails':         return v(['.mbox'], it.id, it.from, it.subject);
            case 'locationVisits': return v(['Semantic', 'Location'], it.placeId || it.name, it.address, it.startTime);
            case 'devices':        return v(['Device'], it.androidId, it.model);
            case 'accessLog':      return v(['Access', 'Activity'], it.ip, it.timestamp, it.activity);
            case 'payments':       return v(['Pay'], ...Object.values(it).filter(x => x != null && String(x).trim()).slice(0, 4));
            default:               return { values: [] }; // chat content is re-encoded on import
        }
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
