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

    /**
     * Paths of Evidence items added as LINKS (reference-only: the files stay
     * on the drive/folder they came from, nothing is copied into the case
     * folder), so the main-process scan can look at them too.
     */
    _evidenceReferencePaths() {
        const out = [];
        try {
            const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
            const list = Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
            for (const ev of list) {
                if (!ev || !(ev.referenceOnly || ev.storageMode === 'reference')) continue;
                if (ev.sourcePath) out.push(String(ev.sourcePath));
                for (const f of (Array.isArray(ev.files) ? ev.files : [])) {
                    if (f && f.path && /\.zip$/i.test(String(f.path))) out.push(String(f.path));
                }
            }
        } catch (e) { console.warn('X warrant: evidence links unreadable', e); }
        return Array.from(new Set(out)).slice(0, 200);
    }

    /**
     * "Find in Evidence": every ZIP and every folder of .txt record files on
     * this case's Evidence tab (copied OR linked), whether or not the
     * background scan recognised it. Nothing is opened here — the officer
     * ticks what to import and the import itself says if it is not X.
     *   → [{ path, name, isFolder, evidenceTag, linked, detected, likely }]
     */
    evidenceCandidates() {
        const out = [];
        const seen = new Set();
        const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
        const add = (c) => {
            const k = String(c.path).replace(/[\\/]+$/, '').toLowerCase();
            if (!c.path || seen.has(k)) return;
            seen.add(k);
            out.push(c);
        };
        let list = [];
        try {
            const all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}');
            list = Array.isArray(all[this.caseNumber]) ? all[this.caseNumber] : [];
        } catch (e) { console.warn('X warrant: evidence list unreadable', e); }
        const xName = (n) => /twitter|(^|[^a-z])x[\s_-]?(corp|prod|return|warrant)|^\d{8,}([-_.]|$)/i.test(String(n));
        const xRecord = /(^|[\\/])\d+-(account|direct-messages|direct-messages-group|tweets|tweet-headers)\.txt$/i;
        for (const ev of list) {
            if (!ev || ev.released) continue;
            const evidenceTag = ev.tag || ev.title || ev.name || '';
            const linked = !!(ev.referenceOnly || ev.storageMode === 'reference');
            const files = (Array.isArray(ev.files) ? ev.files : []).filter(f => f && f.path);
            for (const f of files) {
                if (!/\.zip$/i.test(String(f.path))) continue;
                const name = f.name || base(f.path);
                add({ path: String(f.path), name, isFolder: false, evidenceTag, linked, likely: xName(name) || xName(evidenceTag) });
            }
            // Unzipped production → the folder holding its <account>-*.txt files.
            const recs = files.filter(f => xRecord.test(String(f.path)));
            if (recs.length) {
                const dir = recs.map(f => dirOf(f.path)).sort((a, b) => a.length - b.length)[0];
                add({ path: dir, name: base(dir), isFolder: true, evidenceTag, linked, likely: true });
            } else if (linked && ev.sourcePath && !/\.[a-z0-9]{1,5}$/i.test(String(ev.sourcePath))) {
                // A linked folder (files stay on the drive it came from).
                add({ path: String(ev.sourcePath), name: base(ev.sourcePath), isFolder: true, evidenceTag, linked, likely: xName(ev.sourcePath) || xName(evidenceTag) });
            }
        }
        // Productions the background scan found in the case folder.
        for (const f of (this.evidenceFiles || [])) {
            add({ path: f.path, name: f.name, isFolder: !!f.isFolder, evidenceTag: '', linked: f.source === 'evidence-link', likely: true });
        }
        const detected = new Set((this.evidenceFiles || []).map(f => String(f.path).replace(/[\\/]+$/, '').toLowerCase()));
        const imported = new Set(this.imports.map(i => String(i.filePath || '').toLowerCase()));
        for (const c of out) {
            const k = String(c.path).replace(/[\\/]+$/, '').toLowerCase();
            c.detected = detected.has(k);
            c.encrypted = !!((this.evidenceFiles || []).find(f => String(f.path).replace(/[\\/]+$/, '').toLowerCase() === k) || {}).encrypted;
            c.alreadyImported = imported.has(String(c.path).toLowerCase());
            if (c.detected) c.likely = true;
        }
        out.sort((a, b) => (b.likely - a.likely) || String(a.name).localeCompare(String(b.name)));
        return out;
    }

    async scanForWarrants() {
        if (!window.electronAPI?.xWarrantScan) return;
        try {
            const result = await window.electronAPI.xWarrantScan({ caseNumber: this.caseNumber, caseId: this.caseId, extraPaths: this._evidenceReferencePaths() });
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

    /** Import an X warrant ZIP or unzipped folder. `password` is used for this call only (never saved). */
    async importWarrant(filePath, fileName, isFolder, password) {
        if (!window.electronAPI?.xWarrantImport) throw new Error('X Warrant IPC handler not available');
        const result = await window.electronAPI.xWarrantImport({ filePath, caseNumber: this.caseNumber, isFolder: !!isFolder, password: password || null });
        if (!result.success) {
            const err = new Error(result.error || 'Import failed');
            err.code = result.code || null;
            throw err;
        }
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
            // Source Validation: SHA-256 of the original, taken at import.
            sourceIntegrity: data.sourceIntegrity || null,
        };

        const existingIdx = this.imports.findIndex(i => i.filePath === filePath);
        if (existingIdx >= 0) this.imports[existingIdx] = importRecord;
        else this.imports.push(importRecord);

        this.saveData();
        await this.scanForWarrants();
        return importRecord;
    }

    async importFromPicker() {
        const picked = await this.pickProduction();
        if (!picked) return null;
        return this.importWarrant(picked.path, picked.name, picked.isFolder);
    }

    /** Ask for a production ZIP/folder → { path, name, isFolder } or null. */
    async pickProduction() {
        if (!window.electronAPI?.xWarrantPickFile) throw new Error('File picker not available');
        const result = await window.electronAPI.xWarrantPickFile();
        if (!result || !result.path) return null;
        return { path: result.path, name: result.path.split(/[\\/]/).pop(), isFolder: !!result.isFolder };
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

    /** Streamable viper-media:// URL for an extracted file (null if unavailable). */
    async mediaUrl(diskPath) {
        if (!diskPath || !window.electronAPI?.warrantMediaUrl) return null;
        try {
            const r = await window.electronAPI.warrantMediaUrl({ filePath: diskPath });
            if (r && r.success && r.fileUrl) return r.fileUrl;
        } catch (e) { /* ignore — e.g. main not restarted yet */ }
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
                        deleted: m.deleted ? 'Yes' : '',
                        // Not shown — the record's own ID and the time exactly
                        // as X wrote it, used to find it in the original.
                        messageId: m.message_id || '',
                        rawTime: m.created_at_raw || ''
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
                    deleted: t.deleted ? 'Yes' : '',
                    rawTime: t.created_at_raw || ''
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
                    out.records.push({ key: k, recordType: rec.label, category: rec.category, summary: this._rowSummary(rec, row), stem: rec.stem || '' });
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
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved),
            // Source Validation: find each flagged item in the original return.
            getSourceSpec:     (imp) => this._sourceSpec(imp),
            getItemCitation:   (sectionId, item, imp) => this._citationFor(imp, sectionId, item)
        });
    }

    _sourceSpec(imp) {
        if (!imp) return null;
        const p = imp.sourcePath || imp.filePath;
        if (!p) return null;
        return { source: { path: p }, expected: imp.sourceIntegrity || null };
    }

    /**
     * What to look for in the original, per item. values[0] is the thing
     * being validated; the rest are details of the same record.
     *
     * X writes its data as JavaScript text, so a value containing a quote,
     * a backslash or a line break is stored in an escaped form and would
     * never match word for word. The record's own ID is always plain, so
     * messages and tweets are found by ID and the text is offered as a
     * detail that agrees when it is stored plainly. Dates VIPER shows are
     * converted; the time exactly as X wrote it is used instead.
     */
    _citationFor(imp, sectionId, it) {
        it = it || {};
        const plain = (v) => {
            if (v == null) return '';
            const s = String(v).trim();
            if (!s || /["\\\u0000-\u001f]/.test(s)) return '';
            return s;
        };
        const pack = (hints, primary, ...rest) => {
            const seen = new Set();
            const vals = [primary == null ? '' : String(primary).trim()];
            seen.add(vals[0]);
            for (const r of rest) {
                const s = plain(r);
                if (!s || seen.has(s)) continue;
                seen.add(s); vals.push(s);
            }
            return { values: vals, memberHints: hints };
        };
        switch (sectionId) {
            case 'threads':
                return it.messageId
                    ? pack(['direct-messages'], it.messageId, it.text, it.rawTime, it.conversation, it.sender, it.recipient)
                    : pack(['direct-messages'], plain(it.text) || plain(it.rawTime), it.rawTime, it.conversation, it.sender, it.recipient);
            case 'tweets':
                return it.tweetId
                    ? pack(['tweets'], it.tweetId, it.text, it.rawTime)
                    : pack(['tweets'], plain(it.text) || plain(it.rawTime), it.rawTime);
            case 'records': {
                let row = it.row || null;
                const rec = (imp && imp.records || []).find(r => r && r.stem === it.stem) || null;
                if (!row && rec && it.key) {
                    const rows = rec.rows || [];
                    for (let i = 0; i < rows.length; i++) {
                        if (window.WarrantFlagsKey.xRecord(rec, rows[i], i) === it.key) { row = rows[i]; break; }
                    }
                }
                if (!row) return { values: [] };
                const headers = (rec && rec.headers) || Object.keys(row);
                // Only cells VIPER shows exactly as stored: not Yes/No (true/
                // false in the file), not lists it joined, not "[3 items]".
                const cells = [];
                for (const h of headers) {
                    const s = plain(row[h]);
                    if (!s || s === 'Yes' || s === 'No' || s.includes('; ')) continue;
                    if (/^\[\d+ items?\]$|^\{\d+ fields?\}$/.test(s)) continue;
                    cells.push(s);
                }
                const lead = cells.find(c => c.length >= 4) || cells[0] || '';
                return pack(it.stem ? [it.stem] : [], lead, ...cells.filter(c => c !== lead).slice(0, 5));
            }
            case 'users':
                return pack([], plain(it.userId), it.handle, it.displayName);
            default:
                return { values: [] };
        }
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
