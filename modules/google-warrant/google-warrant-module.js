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
}

// Expose on window so initializeGoogleWarrant() can find it
window.GoogleWarrantModule = GoogleWarrantModule;
