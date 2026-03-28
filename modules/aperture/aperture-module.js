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
}

// Make it globally accessible
window.ApertureModule = ApertureModule;
