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
}

window.KikWarrantModule = KikWarrantModule;
