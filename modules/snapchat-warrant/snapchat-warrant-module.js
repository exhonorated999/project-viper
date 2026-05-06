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
}

window.SnapchatWarrantModule = SnapchatWarrantModule;
