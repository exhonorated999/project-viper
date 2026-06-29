/**
 * X / Twitter Warrant — Main Module (renderer process)
 * Coordinates between UI, IPC handlers, and localStorage persistence.
 * Mirrors the Snapchat/Kik warrant module pattern (flagging + evidence push +
 * custom HTML report via the shared WarrantFlags mixin).
 */

class XWarrantModule {
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
        this.ui = new XWarrantUI(containerId, this);
        window.xWarrantUI = this.ui;
        this.ui.render();
        this.scanForWarrants().catch(err => console.warn('X warrant scan error:', err));
        return this;
    }

    loadData() {
        try {
            const raw = localStorage.getItem(`xWarrant_${this.caseId}`);
            if (raw) this.imports = (JSON.parse(raw).imports) || [];
        } catch (e) {
            console.error('Error loading X warrant data:', e);
            this.imports = [];
        }
    }

    saveData() {
        localStorage.setItem(`xWarrant_${this.caseId}`, JSON.stringify({ imports: this.imports }));
    }

    async scanForWarrants() {
        if (!window.electronAPI?.xWarrantScan) return;
        try {
            const result = await window.electronAPI.xWarrantScan({ caseNumber: this.caseNumber, caseId: this.caseId });
            if (result.success && result.files.length > 0) {
                const importedPaths = this.imports.map(i => i.filePath);
                this.evidenceFiles = result.files.map(f => ({ ...f, alreadyImported: importedPaths.includes(f.path) }));
            } else {
                this.evidenceFiles = [];
            }
            if (this.ui) this.ui.renderEvidenceBar(this.evidenceFiles);
        } catch (err) {
            console.error('Error scanning for X warrants:', err);
            this.evidenceFiles = [];
        }
    }

    /** Import an X warrant ZIP or unzipped folder. */
    async importWarrant(filePath, fileName, isFolder) {
        if (!window.electronAPI?.xWarrantImport) throw new Error('X Warrant IPC handler not available');
        const result = await window.electronAPI.xWarrantImport({ filePath, caseNumber: this.caseNumber, isFolder: !!isFolder });
        if (!result.success) throw new Error(result.error || 'Import failed');
        const data = result.data;

        const importRecord = {
            id: this._generateId(),
            fileName: fileName || filePath.split(/[\\/]/).pop(),
            filePath,
            isFolder: !!isFolder,
            importedAt: new Date().toISOString(),
            accountUsername: data.accountUsername || null,
            accountUserId: data.accountUserId || null,
            accountEmail: data.accountEmail || null,
            accountDisplayName: data.accountDisplayName || null,
            caseNumber: data.caseNumber || null,
            stats: data.stats || {},
            threads: data.threads || [],
            tweets: data.tweets || [],
            records: data.records || [],
            users: data.users || [],
            mediaFiles: data.mediaFiles || {},
            readmeText: data.readmeText || null,
        };

        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) this.imports[existingIdx] = importRecord;
        else this.imports.push(importRecord);

        this.saveData();
        await this.scanForWarrants();
        return importRecord;
    }

    async importFromPicker() {
        if (!window.electronAPI?.xWarrantPickFile) throw new Error('File picker not available');
        const result = await window.electronAPI.xWarrantPickFile();
        if (!result || !result.path) return null;
        const fileName = result.path.split(/[\\/]/).pop();
        return this.importWarrant(result.path, fileName, !!result.isFolder);
    }

    deleteImport(importId) {
        this.imports = this.imports.filter(i => i.id !== importId);
        this.saveData();
    }

    async readMedia(diskPath) {
        if (!window.electronAPI?.xWarrantReadMedia) return null;
        try {
            const result = await window.electronAPI.xWarrantReadMedia({ filePath: diskPath });
            if (result.success) return { data: result.data, mimeType: result.mimeType };
        } catch (e) { /* ignore */ }
        return null;
    }

    getItemCount() { return this.imports.length; }
    _generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }

    // ── Flag-to-Evidence (shared WarrantFlags mixin) ────────────────────

    getActiveImport() {
        const ui = this.ui;
        if (ui && typeof ui.activeImportIdx === 'number') return this.imports[ui.activeImportIdx] || null;
        return this.imports[0] || null;
    }
    toggleFlag(section, key) { return WarrantFlags.toggle(this.getActiveImport(), section, key, () => this.saveData()); }
    isFlagged(section, key) { return WarrantFlags.isFlagged(this.getActiveImport(), section, key); }
    flagCount() { return WarrantFlags.count(this.getActiveImport()); }
    flagCountFor(section) { return WarrantFlags.countSection(this.getActiveImport(), section); }
    clearFlags() { WarrantFlags.clear(this.getActiveImport()); this.saveData(); }

    _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const out = { threads: [], tweets: [], records: [], users: [] };

        // Threads — flatten all messages, match by composite key.
        const msgKeys = new Set((f.threads || []).map(String));
        if (msgKeys.size) {
            for (const th of (imp.threads || [])) {
                for (const m of th.messages) {
                    const k = window.WarrantFlagsKey.xMessage(m, th);
                    if (!msgKeys.has(k)) continue;
                    out.threads.push({
                        key: k,
                        timestamp: m.created_at || '',
                        conversation: th.conversation_id || '',
                        type: th.is_group ? 'Group' : 'DM',
                        sender: m.sender_id || '',
                        recipient: m.recipient_id || '',
                        text: m.text || '',
                        deleted: m.deleted ? 'Yes' : ''
                    });
                }
            }
            out.threads.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
        }

        // Tweets
        const twKeys = new Set((f.tweets || []).map(String));
        if (twKeys.size) {
            for (const t of (imp.tweets || [])) {
                const k = window.WarrantFlagsKey.xTweet(t);
                if (!twKeys.has(k)) continue;
                out.tweets.push({
                    key: k, timestamp: t.created_at || '', tweetId: t.tweet_id || '',
                    text: t.full_text || '', lang: t.lang || '', favorites: t.favorite_count, retweets: t.retweet_count,
                    deleted: t.deleted ? 'Yes' : ''
                });
            }
            out.tweets.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
        }

        // Records — key includes stem + row index/content
        const recKeys = new Set((f.records || []).map(String));
        if (recKeys.size) {
            for (const rec of (imp.records || [])) {
                rec.rows.forEach((row, idx) => {
                    const k = window.WarrantFlagsKey.xRecord(rec, row, idx);
                    if (!recKeys.has(k)) return;
                    out.records.push({ key: k, recordType: rec.label, category: rec.category, summary: this._rowSummary(rec, row) });
                });
            }
        }

        // Users
        const userKeys = new Set((f.users || []).map(String));
        if (userKeys.size) {
            for (const u of (imp.users || [])) {
                const k = window.WarrantFlagsKey.xUser(u);
                if (!userKeys.has(k)) continue;
                out.users.push({ key: k, userId: u.user_id || '', handle: u.handle || '', displayName: u.display_name || '', source: u.source || '' });
            }
        }

        return out;
    }

    _rowSummary(rec, row) {
        return (rec.headers || []).slice(0, 4).map(h => `${h}: ${row[h] || ''}`).filter(Boolean).join(' · ');
    }

    _buildSubjectInfo(imp) {
        return {
            'Username / Handle': imp.accountUsername || '',
            'User ID':           imp.accountUserId || '',
            'Display Name':      imp.accountDisplayName || '',
            'Email':             imp.accountEmail || '',
            'Source File':       imp.fileName || ''
        };
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'threads', title: 'Messages', icon: '💬', renderHint: 'messages',
                columns: [
                    { label: 'Time', field: 'timestamp', type: 'date' },
                    { label: 'Type', field: 'type' },
                    { label: 'Conversation', field: 'conversation', type: 'mono' },
                    { label: 'Sender', field: 'sender', type: 'mono' },
                    { label: 'Recipient', field: 'recipient', type: 'mono' },
                    { label: 'Text', field: 'text', type: 'longtext' },
                    { label: 'Deleted', field: 'deleted' }
                ],
                items: resolved.threads, emptyText: 'No messages flagged.'
            },
            {
                id: 'tweets', title: 'Tweets', icon: '🐦', renderHint: 'table',
                columns: [
                    { label: 'Time', field: 'timestamp', type: 'date' },
                    { label: 'Tweet ID', field: 'tweetId', type: 'mono' },
                    { label: 'Text', field: 'text', type: 'longtext' },
                    { label: 'Lang', field: 'lang' },
                    { label: 'Likes', field: 'favorites' },
                    { label: 'RTs', field: 'retweets' },
                    { label: 'Deleted', field: 'deleted' }
                ],
                items: resolved.tweets, emptyText: 'No tweets flagged.'
            },
            {
                id: 'records', title: 'Records', icon: '📋', renderHint: 'table',
                columns: [
                    { label: 'Record Type', field: 'recordType' },
                    { label: 'Category', field: 'category' },
                    { label: 'Detail', field: 'summary', type: 'longtext' }
                ],
                items: resolved.records, emptyText: 'No records flagged.'
            },
            {
                id: 'users', title: 'Users', icon: '👤', renderHint: 'table',
                columns: [
                    { label: 'User ID', field: 'userId', type: 'mono' },
                    { label: 'Handle', field: 'handle' },
                    { label: 'Display Name', field: 'displayName' },
                    { label: 'Source', field: 'source' }
                ],
                items: resolved.users, emptyText: 'No users flagged.'
            }
        ];
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber: this.caseNumber,
            caseId: this.caseId,
            moduleSlug: 'x',
            moduleLabel: 'X / Twitter Warrant',
            moduleFolder: 'XWarrant',
            bundlePrefix: 'XW',
            evidenceKind: 'warrant-x',
            iconEmoji: '𝕏',
            getActiveImport: () => this.getActiveImport(),
            resolveFlags: (imp) => this._resolveFlagged(imp),
            getSubjectInfo: (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for X warrant data (used by both module + UI)
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.xMessage = function (m, th) {
    return [(th && th.conversation_id) || '', m.message_id || '', m.created_at || '', (m.text || '').slice(0, 60)].join('|');
};
window.WarrantFlagsKey.xTweet = function (t) {
    return [t.tweet_id || '', t.created_at || '', (t.full_text || '').slice(0, 60)].join('|');
};
window.WarrantFlagsKey.xRecord = function (rec, row, idx) {
    return [rec.stem || '', String(idx), Object.values(row || {}).slice(0, 3).map(v => String(v || '')).join('~')].join('|');
};
window.WarrantFlagsKey.xUser = function (u) {
    return [u.user_id || '', u.handle || ''].join('|');
};

window.XWarrantModule = XWarrantModule;
