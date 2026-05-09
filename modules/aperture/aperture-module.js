/**
 * Aperture Main Module
 * Coordinates between UI, data management, and parsing
 * Uses Electron IPC to communicate with the main process
 */

class ApertureModule {
    constructor(caseId, caseNumber, caseName) {
        this.caseId = caseId;
        this.caseNumber = caseNumber || caseId;
        this.caseName = caseName || `Case ${caseId}`;
        this.emails = [];
        this.sources = [];
        this.evidenceFiles = [];
        this.ui = null;
    }

    /**
     * Initialize the module
     */
    async init(containerId) {
        await this.loadEmails();
        await this.loadSources();
        this._loadFlagged();
        
        this.ui = new ApertureUI(containerId, this);
        // Expose globally immediately so inline onclick handlers work
        // Must assign to both: var apertureUI (for inline handlers) and window (for safety)
        apertureUI = this.ui;
        window.apertureUI = this.ui;
        this.ui.render();
        
        // Auto-scan evidence for email files (non-blocking)
        this.scanEvidence().catch(err => console.warn('Evidence scan error:', err));
        
        return this;
    }

    /**
     * Load emails from storage via IPC
     */
    async loadEmails() {
        try {
            const result = await window.electronAPI.apertureLoadEmails(this.caseId);
            if (result.success) {
                this.emails = result.emails;
            } else {
                console.error('Failed to load emails:', result.error);
                this.emails = [];
            }
        } catch (error) {
            console.error('Error loading emails:', error);
            this.emails = [];
        }
    }

    /**
     * Load sources from storage via IPC
     */
    async loadSources() {
        try {
            const result = await window.electronAPI.apertureLoadSources(this.caseId);
            if (result.success) {
                this.sources = result.sources;
            } else {
                console.error('Failed to load sources:', result.error);
                this.sources = [];
            }
        } catch (error) {
            console.error('Error loading sources:', error);
            this.sources = [];
        }
    }

    /**
     * Scan evidence directories for email files
     */
    async scanEvidence() {
        try {
            const result = await window.electronAPI.apertureScanEvidence({
                caseNumber: this.caseNumber,
                caseId: this.caseId
            });
            if (result.success && result.files.length > 0) {
                this.evidenceFiles = result.files;
                if (this.ui) {
                    this.ui.renderEvidenceBar(result.files);
                }
            } else {
                this.evidenceFiles = [];
                if (this.ui) {
                    this.ui.renderEvidenceBar([]);
                }
            }
        } catch (error) {
            console.error('Error scanning evidence:', error);
            this.evidenceFiles = [];
        }
    }

    /**
     * Import a file (mbox, eml, emlx, msg) from evidence or file picker
     */
    async importFile(filePath, fileName, sourceName) {
        try {
            const ext = fileName.split('.').pop().toLowerCase();
            let result;

            if (ext === 'mbox') {
                result = await window.electronAPI.apertureImportMbox({
                    caseId: this.caseId,
                    filePath: filePath,
                    sourceName: sourceName || fileName,
                    fileName: fileName
                });
            } else {
                result = await window.electronAPI.apertureImportEmailFile({
                    caseId: this.caseId,
                    filePath: filePath,
                    sourceName: sourceName || fileName,
                    fileName: fileName
                });
            }

            if (result.success) {
                await this.loadEmails();
                await this.loadSources();
                await this.scanEvidence();
                return result;
            } else {
                throw new Error(result.error || 'Import failed');
            }
        } catch (error) {
            console.error('Error importing file:', error);
            throw error;
        }
    }

    /**
     * Get filtered emails
     */
    getFilteredEmails(searchQuery = '', filter = 'all', sourceId = 'all') {
        let filtered = [...this.emails];

        if (sourceId !== 'all') {
            filtered = filtered.filter(email => email.sourceId === sourceId);
        }

        if (filter === 'flagged') {
            filtered = filtered.filter(email => email.flagged);
        } else if (filter === 'attachments') {
            filtered = filtered.filter(email => email.attachments && email.attachments.length > 0);
        }

        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(email => {
                return (
                    (email.subject && email.subject.toLowerCase().includes(query)) ||
                    (email.from && email.from.toLowerCase().includes(query)) ||
                    (email.body_text && email.body_text.toLowerCase().includes(query)) ||
                    (email.to && email.to.some(addr => addr.toLowerCase().includes(query)))
                );
            });
        }

        return filtered;
    }

    getEmail(emailId) {
        return this.emails.find(e => e.id === emailId);
    }

    getSources() {
        return this.sources;
    }

    /**
     * Toggle email flag
     */
    async toggleEmailFlag(emailId) {
        const email = this.getEmail(emailId);
        if (email) {
            email.flagged = !email.flagged;
            try {
                await window.electronAPI.apertureUpdateEmail({
                    caseId: this.caseId,
                    emailId: emailId,
                    updates: { flagged: email.flagged }
                });
            } catch (error) {
                console.error('Error updating email flag:', error);
                email.flagged = !email.flagged; // revert
            }
        }
    }

    /**
     * Notes CRUD
     */
    async getNotes(emailId) {
        try {
            const result = await window.electronAPI.apertureGetNotes({
                caseId: this.caseId,
                emailId: emailId
            });
            return result.success ? result.notes : [];
        } catch (error) {
            console.error('Error loading notes:', error);
            return [];
        }
    }

    async addNote(emailId, content) {
        try {
            const result = await window.electronAPI.apertureAddNote({
                caseId: this.caseId,
                emailId: emailId,
                content: content
            });
            return result.success ? result.note : null;
        } catch (error) {
            console.error('Error adding note:', error);
            return null;
        }
    }

    async deleteNote(emailId, noteId) {
        try {
            await window.electronAPI.apertureDeleteNote({
                caseId: this.caseId,
                emailId: emailId,
                noteId: noteId
            });
        } catch (error) {
            console.error('Error deleting note:', error);
        }
    }

    /**
     * IP Geolocation lookup
     */
    async lookupIp(ipAddress) {
        try {
            const result = await window.electronAPI.apertureLookupIp({ ipAddress });
            return result.success ? result.geo : null;
        } catch (error) {
            console.error('IP lookup error:', error);
            return null;
        }
    }

    /**
     * Open attachment externally
     */
    async openAttachment(emailId, attachment) {
        try {
            const result = await window.electronAPI.apertureOpenAttachment({
                caseId: this.caseId,
                emailId: emailId,
                attachment: attachment
            });
            return result.success;
        } catch (error) {
            console.error('Error opening attachment:', error);
            return false;
        }
    }

    /**
     * Generate report
     */
    async generateReport(flaggedOnly = true) {
        try {
            const outputDir = `./cases/${this.caseId}/aperture`;
            const result = await window.electronAPI.apertureGenerateReport({
                caseId: this.caseId,
                caseName: this.caseName,
                flaggedOnly: flaggedOnly,
                outputDir: outputDir
            });
            return result;
        } catch (error) {
            console.error('Error generating report:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Statistics
     */
    getStatistics() {
        return {
            totalEmails: this.emails.length,
            sourceCount: this.sources.length,
            flaggedEmails: this.emails.filter(e => e.flagged).length,
            emailsWithAttachments: this.emails.filter(e => e.attachments && e.attachments.length > 0).length
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // Flag-to-Evidence (uses shared WarrantFlags mixin)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Aperture is a single-dataset module (no imports[] array).
     * We fabricate a virtual "active import" object that carries
     * the flagged map and enough context for the WarrantFlags mixin.
     */
    getActiveImport() {
        if (!this._virtualImport) {
            this._virtualImport = {
                flagged: this._flagged || { emails: [], ips: [], attachments: [] },
                data: { emails: this.emails, sources: this.sources },
                fileName: 'Aperture Session'
            };
        }
        // Keep data refs fresh
        this._virtualImport.data.emails = this.emails;
        this._virtualImport.data.sources = this.sources;
        this._virtualImport.flagged = this._flagged || { emails: [], ips: [], attachments: [] };
        return this._virtualImport;
    }

    _ensureFlagged() {
        if (!this._flagged) {
            this._flagged = { emails: [], ips: [], attachments: [] };
        }
        return this._flagged;
    }

    _saveFlagged() {
        try {
            localStorage.setItem(`apertureFlags_${this.caseId}`, JSON.stringify(this._flagged));
        } catch (e) {
            console.error('Error saving aperture flags:', e);
        }
    }

    _loadFlagged() {
        try {
            const raw = localStorage.getItem(`apertureFlags_${this.caseId}`);
            this._flagged = raw ? JSON.parse(raw) : { emails: [], ips: [], attachments: [] };
        } catch (e) {
            this._flagged = { emails: [], ips: [], attachments: [] };
        }
    }

    toggleFlag(section, key) {
        this._ensureFlagged();
        return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this._saveFlagged());
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
    getAllFlags() {
        return WarrantFlags.all(this.getActiveImport());
    }
    clearFlags() {
        WarrantFlags.clear(this.getActiveImport());
        this._saveFlagged();
    }

    /**
     * Resolve flag keys → full data objects ready to write into the bundle.
     */
    _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const emails = imp.data.emails || [];
        const out = {
            emails: [],
            ips: [],
            attachments: []
        };

        // Emails — flag key = email.id
        const flaggedEmailIds = new Set((f.emails || []).map(String));
        for (const e of emails) {
            if (!flaggedEmailIds.has(String(e.id))) continue;
            out.emails.push({
                id: e.id,
                subject: e.subject || '(No Subject)',
                from: e.from || '',
                to: (e.to || []).join(', '),
                cc: (e.cc || []).join(', '),
                date: e.date || '',
                bodyPreview: ((e.body_text || '').substring(0, 300) + ((e.body_text || '').length > 300 ? '…' : '')).trim(),
                hasAttachments: !!(e.attachments && e.attachments.length),
                attachmentCount: e.attachments ? e.attachments.length : 0,
                originatingIp: e.originating_ip ? e.originating_ip.ip_address : '',
                sourceName: e.sourceName || ''
            });
        }
        out.emails.sort((a, b) => (Date.parse(a.date || '') || 0) - (Date.parse(b.date || '') || 0));

        // IPs — flag key = ip address string
        const flaggedIps = new Set((f.ips || []).map(String));
        if (flaggedIps.size > 0) {
            // Aggregate IP data from emails
            const ipMap = {};
            for (const e of emails) {
                if (!e.originating_ip) continue;
                const ip = String(e.originating_ip.ip_address);
                if (!flaggedIps.has(ip)) continue;
                if (!ipMap[ip]) {
                    ipMap[ip] = {
                        ip: ip,
                        classification: e.originating_ip.classification || '',
                        confidence: e.originating_ip.confidence || 0,
                        emailCount: 0,
                        subjects: [],
                        dates: []
                    };
                }
                ipMap[ip].emailCount++;
                if (e.subject) ipMap[ip].subjects.push(e.subject);
                if (e.date) ipMap[ip].dates.push(e.date);
            }
            out.ips = Object.values(ipMap);
            // Sort by email count descending
            out.ips.sort((a, b) => b.emailCount - a.emailCount);
        }

        // Attachments — flag key = `${emailId}::${index}`
        const flaggedAttKeys = new Set((f.attachments || []).map(String));
        if (flaggedAttKeys.size > 0) {
            for (const e of emails) {
                if (!e.attachments) continue;
                for (let i = 0; i < e.attachments.length; i++) {
                    const k = `${e.id}::${i}`;
                    if (!flaggedAttKeys.has(k)) continue;
                    const att = e.attachments[i];
                    out.attachments.push({
                        emailId: e.id,
                        emailSubject: e.subject || '(No Subject)',
                        emailFrom: e.from || '',
                        emailDate: e.date || '',
                        filename: att.filename || 'unknown',
                        mimeType: att.mime_type || 'unknown',
                        size: att.size || 0,
                        index: i
                    });
                }
            }
        }

        return out;
    }

    _buildSubjectInfo(imp) {
        const emails = imp.data.emails || [];
        const sources = imp.data.sources || [];
        const dateRange = this._getDateRange(emails);
        return {
            'Total Emails':   String(emails.length),
            'Sources':        sources.map(s => s.name).join(', ') || 'N/A',
            'Date Range':     dateRange,
            'Source File':    imp.fileName || 'Aperture Session'
        };
    }

    _getDateRange(emails) {
        if (!emails.length) return 'N/A';
        const dates = emails.map(e => Date.parse(e.date)).filter(d => !isNaN(d));
        if (!dates.length) return 'N/A';
        const earliest = new Date(Math.min(...dates));
        const latest = new Date(Math.max(...dates));
        return `${earliest.toLocaleDateString()} — ${latest.toLocaleDateString()}`;
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'emails',
                title: 'Emails',
                icon: '📧',
                renderHint: 'cards',
                columns: [
                    { label: 'Subject',        field: 'subject' },
                    { label: 'From',           field: 'from' },
                    { label: 'To',             field: 'to' },
                    { label: 'CC',             field: 'cc' },
                    { label: 'Date',           field: 'date',          type: 'date' },
                    { label: 'Originating IP', field: 'originatingIp', type: 'mono' },
                    { label: 'Source',         field: 'sourceName' },
                    { label: 'Attachments',    field: 'attachmentCount' },
                    { label: 'Email ID',       field: 'id',             type: 'mono' },
                    { label: 'Body Preview',   field: 'bodyPreview',   type: 'longtext' }
                ],
                items: resolved.emails,
                emptyText: 'No emails flagged.'
            },
            {
                id: 'ips',
                title: 'IP Addresses',
                icon: '🌐',
                renderHint: 'table',
                columns: [
                    { label: 'IP',             field: 'ip',             type: 'mono' },
                    { label: 'Classification', field: 'classification' },
                    { label: 'Confidence',     field: 'confidence' },
                    { label: 'Email Count',    field: 'emailCount' },
                    { label: 'Email Subjects', field: 'subjects',       type: 'longtext' }
                ],
                items: resolved.ips,
                emptyText: 'No IPs flagged.'
            },
            {
                id: 'attachments',
                title: 'Attachments',
                icon: '📎',
                renderHint: 'cards',
                columns: [
                    { label: 'Filename',      field: 'filename' },
                    { label: 'MIME Type',     field: 'mimeType',       type: 'mono' },
                    { label: 'Size',          field: 'size' },
                    { label: 'From Email',    field: 'emailFrom' },
                    { label: 'Email Subject', field: 'emailSubject' },
                    { label: 'Email Date',    field: 'emailDate',      type: 'date' }
                ],
                items: resolved.attachments,
                emptyText: 'No attachments flagged.'
            }
        ];
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'aperture',
            moduleLabel:   'Aperture',
            moduleFolder:  'Aperture',
            bundlePrefix:  'AP',
            evidenceKind:  'warrant-aperture',
            iconEmoji:     '👁️',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || 'Aperture Session',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Make it globally accessible
window.ApertureModule = ApertureModule;
