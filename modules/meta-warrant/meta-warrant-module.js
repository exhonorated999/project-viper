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
                const importedPaths = [];
                for (const i of this.imports) { if (i && i.filePath) importedPaths.push(i.filePath); if (i && i.sourcePath) importedPaths.push(i.sourcePath); }
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
    async importWarrant(filePath, fileName, opts) {
        opts = opts || {};
        if (!filePath) throw new Error('No return selected.');
        // Old-style records have no store key, so the only way this import can
        // replace one is by id or by path — check its flags before any work.
        const oldStyle = this.imports.find(i => MetaWarrantModule.isLegacy(i) &&
            ((opts.replaceId && i.id === opts.replaceId) || (!opts.replaceId && i.filePath === filePath)));
        const pending = oldStyle ? WarrantFlags.count(oldStyle) : 0;
        if (pending > 0) {
            throw new Error(`Push or clear your ${pending} flagged item${pending === 1 ? '' : 's'} first — they belong to the old viewer and cannot be carried over.`);
        }
        const result = await this._call('metaWarrantImport', {
            sourcePath: filePath,
            filePath,
            caseNumber: this.caseNumber
        });

        if (!result || !result.success) {
            throw new Error((result && result.error) || 'Import failed');
        }
        // An old main process (renderer reloaded, app not restarted) still
        // answers with the whole parse in result.data.
        if (!result.record) throw new Error(MetaWarrantModule.RESTART_MSG);

        const rec = result.record;
        // An explicit replaceId (re-import / upgrade of that record) wins over
        // a store-key or path match with some other record.
        const existing = (opts.replaceId && this.imports.find(i => i && i.id === opts.replaceId)) ||
            this.imports.find(i => i && (
                (rec.storeKey && i.storeKey === rec.storeKey) ||
                i.filePath === filePath));

        const importRecord = Object.assign({}, rec, {
            id: existing ? existing.id : this._generateId(),
            fileName: fileName || String(filePath).split(/[\\/]/).pop(),
            filePath: filePath,
            importedAt: new Date().toISOString(),
            // Flags survive a re-import (keys are content hashes, so an
            // unchanged item keeps its flag).  Old-style flags cannot carry over.
            flagged: (existing && !MetaWarrantModule.isLegacy(existing) && existing.flagged) || {},
            subject: MetaWarrantModule.subjectOf(rec)
        });

        const oldKey = existing && existing.storeKey;
        if (existing) this.imports[this.imports.indexOf(existing)] = importRecord;
        else this.imports.push(importRecord);
        this.saveData();
        this._dropCaches(rec.storeKey);
        if (oldKey && oldKey !== rec.storeKey) await this._deleteStoreIfUnused(oldKey);

        await this.scanForWarrants();
        return importRecord;
    }

    /** Imports made before the 2026 rebuild: whole parse in localStorage, no store. */
    static isLegacy(imp) {
        return !!imp && !imp.storeKey && Array.isArray(imp.records);
    }

    /** Identifiers Warrant Author offers as suggestions (reads imp.subject). */
    static subjectOf(rec) {
        const out = {};
        const id = String((rec && (rec.accountId || '')) || '').trim();
        const target = String((rec && rec.targetId) || '').trim();
        if (id) out.userId = id;
        if (target && target !== id) {
            // Bare digits are a Meta account ID; a phone number is written
            // with + or separators in the return's Target line.
            if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) out.email = target;
            else if (/^\d+$/.test(target)) { if (!out.userId) out.userId = target; }
            else if (/^\+?[\d\s().-]{7,}$/.test(target)) out.phone = target;
            else out.username = target;
        }
        return out;
    }

    /**
     * Rebuild an import (old-style or new) from its original return.
     * Old-style flags point into data the new viewer does not have, so they
     * must be pushed or cleared first — never silently thrown away.
     */
    async upgradeImport(importId, newPath) {
        const imp = this.imports.find(i => i && i.id === importId);
        if (!imp) throw new Error('That import no longer exists.');
        if (MetaWarrantModule.isLegacy(imp)) {
            const n = WarrantFlags.count(imp);
            if (n > 0) {
                throw new Error(`Push or clear your ${n} flagged item${n === 1 ? '' : 's'} first — they belong to the old viewer and cannot be carried over.`);
            }
        }
        const p = newPath || imp.sourcePath || imp.filePath;
        if (!p) throw new Error('The original return for this import is not recorded. Use Locate to pick it.');
        const name = (newPath ? String(newPath).split(/[\\/]/).pop() : imp.fileName) || String(p).split(/[\\/]/).pop();
        return this.importWarrant(p, name, { replaceId: importId });
    }

    /** File/folder picker.  Returns {path, isFolder} or null (accepts an old string reply). */
    async pickSource() {
        const fn = window.electronAPI && window.electronAPI.metaWarrantPickFile;
        if (typeof fn !== 'function') throw new Error('File picker not available');
        const r = await fn();
        if (!r) return null;
        if (typeof r === 'string') return { path: r, isFolder: false };
        return r.path ? { path: r.path, isFolder: !!r.isFolder } : null;
    }

    /**
     * Import via file picker
     */
    async importFromPicker() {
        const picked = await this.pickSource();
        if (!picked) return null;
        return this.importWarrant(picked.path, picked.path.split(/[\\/]/).pop());
    }

    /**
     * Delete an import by ID (and its on-disk store when nothing else uses it).
     */
    async deleteImport(importId) {
        const imp = this.imports.find(i => i && i.id === importId);
        this.imports = this.imports.filter(i => i && i.id !== importId);
        this.saveData();
        if (imp && imp.storeKey) {
            this._dropCaches(imp.storeKey);
            await this._deleteStoreIfUnused(imp.storeKey);
        }
    }

    async _deleteStoreIfUnused(storeKey) {
        if (!storeKey || this.imports.some(i => i && i.storeKey === storeKey)) return false;
        const fn = window.electronAPI && window.electronAPI.metaWarrantDeleteStore;
        if (typeof fn !== 'function') return false;
        try {
            const r = await fn({ caseNumber: this.caseNumber, storeKey });
            return !!(r && r.success);
        } catch (e) {
            console.warn('META store delete failed:', e);
            return false;
        }
    }

    // ─── Store access (new-style imports) ──────────────────────────────

    _call(name, payload) {
        const fn = window.electronAPI && window.electronAPI[name];
        if (typeof fn !== 'function') return Promise.reject(new Error(MetaWarrantModule.RESTART_MSG));
        return Promise.resolve(fn(payload)).catch(e => {
            if (/No handler registered/i.test(String(e && e.message))) throw new Error(MetaWarrantModule.RESTART_MSG);
            throw e;
        });
    }

    _dropCaches(storeKey) {
        if (!storeKey) { this._ovCache = new Map(); this._urlCache = new Map(); return; }
        if (this._ovCache) this._ovCache.delete(storeKey);
        if (this._urlCache) for (const k of Array.from(this._urlCache.keys())) if (k.indexOf(storeKey + '|') === 0) this._urlCache.delete(k);
    }

    /** {success, overview} | {success:false, missing?, error} — cached per store. */
    async overview(imp) {
        if (!imp || !imp.storeKey) return { success: false, error: 'No store' };
        this._ovCache = this._ovCache || new Map();
        if (this._ovCache.has(imp.storeKey)) return { success: true, overview: this._ovCache.get(imp.storeKey) };
        const r = await this._call('metaWarrantOverview', { caseNumber: this.caseNumber, storeKey: imp.storeKey });
        if (r && r.success && r.overview) this._ovCache.set(imp.storeKey, r.overview);
        return r || { success: false, error: 'No reply' };
    }

    async query(imp, req) {
        if (!imp || !imp.storeKey) return { success: false, error: 'No store', rows: [], total: 0 };
        return this._call('metaWarrantQuery', { caseNumber: this.caseNumber, storeKey: imp.storeKey, req });
    }

    /** viper-media:// URL for one media ref; tokens live 1 h, cached 50 min. */
    async mediaUrl(imp, ref) {
        if (!imp || !imp.storeKey || !ref) return { success: false, error: 'Media file not found' };
        this._urlCache = this._urlCache || new Map();
        const k = imp.storeKey + '|' + ref;
        const hit = this._urlCache.get(k);
        if (hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.r;
        const r = await this._call('metaWarrantMediaUrl', { caseNumber: this.caseNumber, storeKey: imp.storeKey, ref });
        if (r && r.success) this._urlCache.set(k, { at: Date.now(), r });
        return r || { success: false, error: 'No reply' };
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
    _resolveFlaggedLegacy(imp) {
        const f = imp.flagged || {};
        // Meta stores data in imp.records[]; primary record is the main one
        const rec = imp.records
            ? imp.records.find(r => r.source === 'records') || imp.records[0]
            : null;
        const out = {
            ipActivity: [],
            statusUpdates: [],
            wallposts: [],
            otherWallPosts: [],
            shares: [],
            photos: [],
            messages: []
        };

        if (!rec) return out;

        // IP Activity — flag key = ip string
        const flaggedIps = new Set((f.ipActivity || []).map(String));
        for (const entry of (rec.ipAddresses || [])) {
            if (!flaggedIps.has(String(entry.ip))) continue;
            out.ipActivity.push({
                ip: entry.ip || '',
                time: entry.time || ''
            });
        }

        // Status Updates — flag key = id or composite
        const flaggedStatus = new Set((f.statusUpdates || []).map(String));
        for (const u of (rec.statusUpdates || [])) {
            const k = u.id || window.WarrantFlagsKey.metaStatusUpdate(u);
            if (!flaggedStatus.has(String(k))) continue;
            out.statusUpdates.push({
                id: u.id || '',
                posted: u.posted || '',
                status: u.status || '',
                author: u.author || '',
                mobile: u.mobile || '',
                lifeExperience: u.lifeExperience || ''
            });
        }

        // Wallposts — flag key = id or composite
        const flaggedWall = new Set((f.wallposts || []).map(String));
        for (const w of (rec.wallposts || [])) {
            const k = w.id || window.WarrantFlagsKey.metaWallpost(w);
            if (!flaggedWall.has(String(k))) continue;
            out.wallposts.push({
                id: w.id || '',
                from: w.from || '',
                to: w.to || '',
                time: w.time || '',
                text: w.text || '',
                attachments: w.attachments || ''
            });
        }

        // Posts to Other Walls — flag key = id
        const flaggedOther = new Set((f.otherWallPosts || []).map(String));
        for (const p of (rec.postsToOtherWalls || [])) {
            if (!flaggedOther.has(String(p.id))) continue;
            out.otherWallPosts.push({
                id: p.id || '',
                post: p.post || '',
                time: p.time || '',
                timelineOwner: p.timelineOwner || ''
            });
        }

        // Shares — flag key = composite
        const flaggedShares = new Set((f.shares || []).map(String));
        for (const s of (rec.shares || [])) {
            const k = window.WarrantFlagsKey.metaShare(s);
            if (!flaggedShares.has(k)) continue;
            out.shares.push({
                dateCreated: s.dateCreated || '',
                title: s.title || '',
                text: s.text || '',
                summary: s.summary || '',
                url: s.url || ''
            });
        }

        // Photos — flag key = id or composite
        const flaggedPhotos = new Set((f.photos || []).map(String));
        for (const p of (rec.photos || [])) {
            const k = p.id || window.WarrantFlagsKey.metaPhoto(p);
            if (!flaggedPhotos.has(String(k))) continue;
            out.photos.push({
                id: p.id || '',
                album: p.album || p.albumName || '',
                title: p.title || '',
                uploaded: p.uploaded || '',
                uploadIp: p.uploadIp || '',
                author: p.author || '',
                link: p.link || ''
            });
        }

        // Messages — flag key = composite (threadId|author|sent)
        const flaggedMsgs = new Set((f.messages || []).map(String));
        for (const thread of (rec.messages?.threads || [])) {
            const threadId = thread.threadId || '?';
            for (const m of (thread.messages || [])) {
                const k = window.WarrantFlagsKey.metaMessage(threadId, m);
                if (!flaggedMsgs.has(k)) continue;
                out.messages.push({
                    threadId,
                    author: m.author || '',
                    sent: m.sent || '',
                    body: m.body || '',
                    participants: (thread.participants || []).join(', '),
                    attachments: (m.attachments || []).map(a => a.description || a.type || '').filter(Boolean).join('; ')
                });
            }
        }
        out.messages.sort((a, b) => (a.sent || '').localeCompare(b.sent || ''));

        return out;
    }

    /**
     * What to search the original for, per flagged item (Source Validation).
     * values[0] is the item itself; the rest only corroborate it.
     */
    _citationForLegacy(imp, sectionId, it) {
        const rec = imp && imp.records ? (imp.records.find(r => r.source === 'records') || imp.records[0]) : null;
        const hints = [((rec && rec.source) || 'records') + '.html'];
        const v = (...a) => ({ values: a, memberHints: hints });
        switch (sectionId) {
            case 'ipActivity':     return v(it.ip, it.time);
            case 'statusUpdates':  return v(it.status || it.posted, it.posted, it.author);
            case 'wallposts':      return v(it.text || it.time, it.time, it.from);
            case 'otherWallPosts': return v(it.post || it.time, it.time, it.timelineOwner);
            case 'shares':         return v(it.url || it.title || it.text, it.dateCreated);
            case 'photos':         return v(it.id || it.uploaded, it.uploaded, it.uploadIp);
            case 'messages':       return v(it.body || it.sent, it.sent, it.author);
            default:               return null;
        }
    }

    _buildSubjectInfoLegacy(imp) {
        const rec = imp.records
            ? imp.records.find(r => r.source === 'records') || imp.records[0]
            : null;
        return {
            'Service':        imp.service || rec?.service || '',
            'Target ID':      imp.targetId || rec?.targetId || '',
            'Account ID':     imp.accountId || rec?.accountId || '',
            'Date Range':     imp.dateRange || rec?.dateRange || '',
            'Generated':      imp.generated || rec?.generated || '',
            'Registration IP': rec?.registrationIp || '',
            'Source File':    imp.fileName || ''
        };
    }

    _buildSectionConfigsLegacy(imp, resolved) {
        return [
            {
                id: 'ipActivity',
                title: 'IP Activity',
                icon: '🌐',
                renderHint: 'table',
                columns: [
                    { label: 'IP',      field: 'ip',   type: 'mono' },
                    { label: 'Time',    field: 'time', type: 'date' }
                ],
                items: resolved.ipActivity,
                emptyText: 'No IP addresses flagged.'
            },
            {
                id: 'statusUpdates',
                title: 'Status Updates',
                icon: '📝',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',             field: 'id',             type: 'mono' },
                    { label: 'Posted',         field: 'posted',         type: 'date' },
                    { label: 'Status',         field: 'status',         type: 'longtext' },
                    { label: 'Author',         field: 'author' },
                    { label: 'Mobile',         field: 'mobile' },
                    { label: 'Life Experience', field: 'lifeExperience' }
                ],
                items: resolved.statusUpdates,
                emptyText: 'No status updates flagged.'
            },
            {
                id: 'wallposts',
                title: 'Wallposts',
                icon: '📌',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',    field: 'id',    type: 'mono' },
                    { label: 'From',  field: 'from' },
                    { label: 'To',    field: 'to' },
                    { label: 'Time',  field: 'time',  type: 'date' },
                    { label: 'Text',  field: 'text',  type: 'longtext' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.wallposts,
                emptyText: 'No wallposts flagged.'
            },
            {
                id: 'otherWallPosts',
                title: 'Posts to Other Walls',
                icon: '📤',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',             field: 'id',             type: 'mono' },
                    { label: 'Post',           field: 'post',           type: 'longtext' },
                    { label: 'Time',           field: 'time',           type: 'date' },
                    { label: 'Timeline Owner', field: 'timelineOwner' }
                ],
                items: resolved.otherWallPosts,
                emptyText: 'No posts to other walls flagged.'
            },
            {
                id: 'shares',
                title: 'Shares',
                icon: '🔗',
                renderHint: 'cards',
                columns: [
                    { label: 'Date Created', field: 'dateCreated', type: 'date' },
                    { label: 'Title',        field: 'title' },
                    { label: 'Text',         field: 'text',        type: 'longtext' },
                    { label: 'Summary',      field: 'summary',     type: 'longtext' },
                    { label: 'URL',          field: 'url',         type: 'mono' }
                ],
                items: resolved.shares,
                emptyText: 'No shares flagged.'
            },
            {
                id: 'photos',
                title: 'Photos',
                icon: '📷',
                renderHint: 'cards',
                columns: [
                    { label: 'ID',        field: 'id',        type: 'mono' },
                    { label: 'Album',     field: 'album' },
                    { label: 'Title',     field: 'title' },
                    { label: 'Uploaded',  field: 'uploaded',  type: 'date' },
                    { label: 'Upload IP', field: 'uploadIp',  type: 'mono' },
                    { label: 'Author',   field: 'author' },
                    { label: 'Link',     field: 'link',       type: 'mono' }
                ],
                items: resolved.photos,
                emptyText: 'No photos flagged.'
            },
            {
                id: 'messages',
                title: 'Messages',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'Thread ID',   field: 'threadId',     type: 'mono' },
                    { label: 'Author',      field: 'author' },
                    { label: 'Sent',        field: 'sent',         type: 'date' },
                    { label: 'Body',        field: 'body',         type: 'longtext' },
                    { label: 'Participants', field: 'participants' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.messages,
                emptyText: 'No messages flagged.'
            }
        ];
    }

    // ─── New-style flags (imports with an on-disk store) ───────────────
    // One section, 'meta', holding  c:<catId>:<itemKey>  and
    // m:<threadKey>:<msgKey>.  Keys are content hashes from the importer, so
    // they survive a re-import of the same return.

    static itemFlagKey(catId, itemKey) { return 'c:' + catId + ':' + itemKey; }
    static msgFlagKey(threadKey, msgKey) { return 'm:' + threadKey + ':' + msgKey; }

    /** Plain-text rendering of a Field tree (bundle "Details"). */
    static fieldsText(fields, depth) {
        const out = [];
        const walk = (fs, d) => {
            const pad = '  '.repeat(d);
            for (const f of (fs || [])) {
                const v = (f && f.v) || {};
                const t = (v.t || []).filter(l => String(l).trim() !== '');
                const head = f.k ? f.k + ':' : '';
                if (t.length) {
                    out.push(pad + (head ? head + ' ' : '') + t[0]);
                    for (const l of t.slice(1)) out.push(pad + (head ? '  ' : '') + l);
                } else if (head && ((v.r && v.r.length) || (v.m && v.m.length))) {
                    out.push(pad + head);
                }
                for (const rec of (v.r || [])) walk(rec, d + 1);
            }
        };
        walk(fields, depth || 0);
        return out.join('\n');
    }

    static _lines(fields) {
        const out = [];
        const walk = (fs) => {
            for (const f of (fs || [])) {
                const v = (f && f.v) || {};
                for (const l of (v.t || [])) out.push([String(f.k || '').toLowerCase(), String(l)]);
                for (const rec of (v.r || [])) walk(rec);
            }
        };
        walk(fields);
        return out;
    }

    /** The item itself, verbatim, as it appears in the return (for Source Validation). */
    static primaryValue(fields) {
        const MI = window.MetaInterpret;
        const ls = MetaWarrantModule._lines(fields);
        const isTimeOnly = (l) => !!(MI && MI.normTime(l)) && l.replace(MI.TIME_RE, '').replace(/\bUTC\b/i, '').trim() === '';
        const keys = ['body', 'text', 'caption', 'post', 'status', 'comment', 'title', 'message', 'content', 'description', 'name', 'query', 'search', 'url', 'link', 'value'];
        let hit = null;
        for (const want of keys) { hit = ls.find(([k, l]) => k === want && l.trim()); if (hit) break; }
        if (!hit) hit = ls.find(([, l]) => l.trim() && !isTimeOnly(l.trim()));
        if (hit) return hit[1].trim().slice(0, 200);
        const media = MI ? MI.deepMedia(fields) : [];
        if (media.length) return String(media[0].s).split('/').pop();
        return '';
    }

    /** The raw line holding an item's normalised time (what the return actually printed). */
    static rawTimeLine(fields, t) {
        const MI = window.MetaInterpret;
        if (!t || !MI) return '';
        const hit = MetaWarrantModule._lines(fields).find(([, l]) => MI.normTime(l) === t);
        return hit ? hit[1].trim() : '';
    }

    async _resolveFlaggedNew(imp) {
        const keys = ((imp.flagged && imp.flagged.meta) || []).slice();
        const out = { items: [], messages: [], missing: [], pages: [] };
        if (!keys.length) return out;
        const r = await this.query(imp, { kind: 'keys', keys });
        if (!r || !r.success) throw new Error((r && r.error) || 'Could not read the flagged items.');
        const ov = await this.overview(imp);
        out.pages = (ov && ov.success && ov.overview && ov.overview.pages) || [];
        out.items = r.items || [];
        out.messages = r.messages || [];
        out.missing = r.missing || [];
        out.items.sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')));
        out.messages.sort((a, b) => String(a.sent || '').localeCompare(String(b.sent || '')));
        return out;
    }

    _resolveFlagged(imp) {
        return MetaWarrantModule.isLegacy(imp) ? this._resolveFlaggedLegacy(imp) : this._resolveFlaggedNew(imp);
    }

    static pageLabel(p, i) {
        if (!p) return 'page ' + (i + 1);
        return String(p.name || '').split(/[\\/]/).pop() || ('page ' + (i + 1));
    }

    _buildSectionConfigsNew(imp, resolved) {
        const MI = window.MetaInterpret;
        const pages = resolved.pages || [];
        const cite = this._cite = new WeakMap();
        const foundOn = (src) => (src || []).map(i => {
            const p = pages[i];
            const kind = p && p.kind === 'records' ? 'records' : (p && p.kind === 'preservation' ? 'preservation' : '');
            return MetaWarrantModule.pageLabel(p, i) + (kind ? ' (' + kind + ')' : '');
        }).join(', ');
        const hintsOf = (src) => {
            const h = [];
            for (const i of (src || [])) { const b = MetaWarrantModule.pageLabel(pages[i], i); if (h.indexOf(b) < 0) h.push(b); }
            return h;
        };
        const mediaText = (fields) => (MI ? MI.deepMedia(fields) : []).map(m => m.s).join('\n');

        const configs = [];
        const byCat = new Map();
        for (const it of resolved.items) {
            if (!byCat.has(it.cat)) byCat.set(it.cat, { name: it.catName || it.cat, rows: [] });
            const row = {
                flagKey: it.flagKey,
                time: it.t || '',
                group: (it.g || []).join(' › '),
                details: MetaWarrantModule.fieldsText(it.f),
                media: mediaText(it.f),
                foundOn: foundOn(it.src)
            };
            cite.set(row, {
                values: [MetaWarrantModule.primaryValue(it.f), MetaWarrantModule.rawTimeLine(it.f, it.t)],
                memberHints: hintsOf(it.src)
            });
            byCat.get(it.cat).rows.push(row);
        }
        for (const [catId, c] of byCat) {
            configs.push({
                id: 'c_' + String(catId).replace(/[^A-Za-z0-9_]/g, '_'),
                title: c.name,
                icon: '📄',
                renderHint: 'cards',
                columns: [
                    { label: 'Time',     field: 'time',    type: 'date' },
                    { label: 'Group',    field: 'group' },
                    { label: 'Details',  field: 'details', type: 'longtext' },
                    { label: 'Media',    field: 'media',   type: 'mono' },
                    { label: 'Found on', field: 'foundOn' }
                ],
                items: c.rows,
                emptyText: 'Nothing flagged.'
            });
        }

        if (resolved.messages.length) {
            const rows = resolved.messages.map(m => {
                const row = {
                    flagKey: m.flagKey,
                    thread: m.threadName ? m.threadName + (m.threadId ? ' (' + m.threadId + ')' : '') : (m.threadId || ''),
                    participants: (m.participants || []).join(', '),
                    author: m.author || '',
                    sent: m.sent || '',
                    body: m.body || MetaWarrantModule.fieldsText(m.f),
                    media: mediaText(m.f),
                    foundOn: foundOn(m.src)
                };
                cite.set(row, {
                    values: [MetaWarrantModule.primaryValue(m.f) || m.body || '', MetaWarrantModule.rawTimeLine(m.f, m.sent), m.author || ''],
                    memberHints: hintsOf(m.src)
                });
                return row;
            });
            configs.push({
                id: 'messages',
                title: 'Messages',
                icon: '💬',
                // 'cards', not 'messages': the report's message renderer only
                // shows web attachments; these are files inside the return.
                renderHint: 'cards',
                columns: [
                    { label: 'Thread',       field: 'thread' },
                    { label: 'Participants', field: 'participants' },
                    { label: 'Author',       field: 'author' },
                    { label: 'Sent',         field: 'sent',    type: 'date' },
                    { label: 'Body',         field: 'body',    type: 'longtext' },
                    { label: 'Media',        field: 'media',   type: 'mono' },
                    { label: 'Found on',     field: 'foundOn' }
                ],
                items: rows,
                emptyText: 'No messages flagged.'
            });
        }

        if (resolved.missing.length) {
            configs.push({
                id: 'missing',
                title: 'Flagged items not found',
                icon: '⚠️',
                renderHint: 'table',
                columns: [
                    { label: 'Flag', field: 'key', type: 'mono' },
                    { label: 'Note', field: 'note' }
                ],
                items: resolved.missing.map(k => ({ key: k, note: 'Flagged earlier, but not in this import of the return (it was re-imported and the item changed or is gone).' })),
                emptyText: ''
            });
        }
        return configs;
    }

    _buildSectionConfigs(imp, resolved) {
        return MetaWarrantModule.isLegacy(imp) ? this._buildSectionConfigsLegacy(imp, resolved) : this._buildSectionConfigsNew(imp, resolved);
    }

    _citationFor(imp, sectionId, it) {
        if (MetaWarrantModule.isLegacy(imp)) return this._citationForLegacy(imp, sectionId, it);
        const c = this._cite && this._cite.get(it);
        if (!c || !c.values[0]) return null;
        return c;
    }

    _buildSubjectInfo(imp) {
        if (MetaWarrantModule.isLegacy(imp)) return this._buildSubjectInfoLegacy(imp);
        const pages = imp.pages || [];
        const pres = pages.filter(p => p.kind === 'preservation').length;
        const hasRec = pages.some(p => p.kind === 'records');
        const pageText = [hasRec ? 'Records' : '', pres ? pres + ' preservation' + (pres === 1 ? '' : 's') : '']
            .filter(Boolean).join(' + ') || (pages.length ? pages.length + ' page(s)' : '');
        return {
            'Service':      imp.service || '',
            'Target':       imp.targetId || '',
            'Account ID':   imp.accountId || '',
            'Account Type': imp.accountType || '',
            'Date Range':   imp.dateRange || '',
            'Generated':    imp.generated || '',
            'Pages':        pageText,
            'Source File':  imp.fileName || ''
        };
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'meta',
            moduleLabel:   'Meta Warrant',
            moduleFolder:  'MetaWarrant',
            bundlePrefix:  'MW',
            evidenceKind:  'warrant-meta',
            iconEmoji:     '📘',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            // Source Validation: cite each flagged item in the original return.
            getSourceSpec:     (imp) => {
                const p = imp.sourcePath || imp.filePath;
                return p ? { source: { path: p }, expected: imp.sourceIntegrity || null } : null;
            },
            getItemCitation:   (sectionId, item, imp) => this._citationFor(imp, sectionId, item),
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generators for Meta warrant items (used by both module + UI)
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.metaMessage = function (threadId, msg) {
    return [threadId || '', msg.author || '', msg.sent || ''].join('|');
};
window.WarrantFlagsKey.metaStatusUpdate = function (u) {
    return [u.posted || '', u.author || '', (u.status || '').substring(0, 40)].join('|');
};
window.WarrantFlagsKey.metaWallpost = function (w) {
    return [w.from || '', w.to || '', w.time || ''].join('|');
};
window.WarrantFlagsKey.metaShare = function (s) {
    return [s.dateCreated || '', s.title || '', (s.url || '').substring(0, 60)].join('|');
};
window.WarrantFlagsKey.metaPhoto = function (p) {
    return [p.album || p.albumName || '', p.uploaded || '', p.title || ''].join('|');
};

MetaWarrantModule.RESTART_MSG = 'VIPER needs a full restart to finish loading the Meta importer. Close VIPER completely and open it again.';
window.MetaWarrantModule = MetaWarrantModule;
