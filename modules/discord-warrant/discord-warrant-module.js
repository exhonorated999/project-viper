/**
 * Discord Warrant Parser — Main Module (renderer)
 * Coordinates between UI, IPC handlers, and localStorage persistence.
 */

class DiscordWarrantModule {
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
        this.ui = new DiscordWarrantUI(containerId, this);
        window.discordWarrantUI = this.ui;
        this.ui.render();
        this.scanForWarrants().catch(err => console.warn('Discord warrant scan error:', err));
        return this;
    }

    loadData() {
        try {
            const raw = localStorage.getItem(`discordWarrant_${this.caseId}`);
            if (raw) {
                const data = JSON.parse(raw);
                this.imports = data.imports || [];
            }
        } catch (e) {
            console.error('Error loading Discord warrant data:', e);
            this.imports = [];
        }
    }

    saveData() {
        localStorage.setItem(`discordWarrant_${this.caseId}`, JSON.stringify({
            imports: this.imports
        }));
    }

    /**
     * Scan Evidence/ + Warrants/Production/ for Discord warrant ZIPs/folders.
     */
    async scanForWarrants() {
        if (!window.electronAPI?.discordWarrantScan) return;
        try {
            const result = await window.electronAPI.discordWarrantScan({
                caseNumber: this.caseNumber,
                caseId: this.caseId
            });
            console.log('[DiscordWarrant] scan result:', result);
            if (result.success && result.files.length > 0) {
                const importedPaths = this.imports.map(i => i.filePath);
                this.evidenceFiles = result.files.map(f => ({
                    ...f,
                    alreadyImported: importedPaths.includes(f.path)
                }));
            } else {
                this.evidenceFiles = [];
            }
            if (this.ui) this.ui.renderEvidenceBar(this.evidenceFiles);
        } catch (err) {
            console.error('Error scanning for Discord warrants:', err);
        }
    }

    /**
     * Import a Discord warrant by file or folder path.
     */
    async importWarrant(filePath, fileName, isFolder = false) {
        if (!window.electronAPI?.discordWarrantImport) {
            throw new Error('Discord import IPC not available');
        }

        const result = await window.electronAPI.discordWarrantImport({
            filePath,
            caseNumber: this.caseNumber,
            isFolder: !!isFolder
        });

        if (!result.success) {
            throw new Error(result.error || 'Failed to import Discord warrant');
        }

        const data = result.data || {};
        const importRecord = {
            id: this._generateId(),
            filePath,
            fileName: fileName || (filePath || '').split(/[\\/]/).pop(),
            isFolder: !!isFolder,
            importedAt: new Date().toISOString(),
            accountUsername: data.subscriber?.username || 'unknown',
            accountId: data.subscriber?.id || null,
            email: data.subscriber?.email || null,
            phone: data.subscriber?.phone || null,
            ip: data.subscriber?.ip || null,
            stats: data.stats || {},
            data
        };

        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) this.imports[existingIdx] = importRecord;
        else this.imports.push(importRecord);

        this.saveData();
        await this.scanForWarrants();
        return importRecord;
    }

    async importFromPicker() {
        if (!window.electronAPI?.discordWarrantPickFile) {
            throw new Error('File picker not available');
        }
        const picked = await window.electronAPI.discordWarrantPickFile();
        if (!picked) return null;
        const fileName = (picked.path || '').split(/[\\/]/).pop();
        return this.importWarrant(picked.path, fileName, picked.isFolder);
    }

    deleteImport(importId) {
        this.imports = this.imports.filter(i => i.id !== importId);
        this.saveData();
    }

    getItemCount() {
        return this.imports.length;
    }

    /**
     * Read a content file (avatar etc.) from the case Evidence/DiscordWarrant/ dir.
     * @param {string} diskPath — absolute path returned by parser in contentFiles map
     */
    async readMedia(diskPath) {
        if (!window.electronAPI?.discordWarrantReadMedia) return null;
        try {
            const result = await window.electronAPI.discordWarrantReadMedia({ filePath: diskPath });
            if (result.success) return { data: result.data, mimeType: result.mimeType };
        } catch (e) { /* ignore */ }
        return null;
    }

    _generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }
}

window.DiscordWarrantModule = DiscordWarrantModule;
