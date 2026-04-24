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
}

window.MetaWarrantModule = MetaWarrantModule;
