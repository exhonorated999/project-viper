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
        // Disk store wins over localStorage: a real return is far too large
        // for the 5 MB quota, so localStorage only ever holds the light index.
        this.loadFromDisk().then(loaded => {
            if (loaded && this.ui) this.ui.render();
        }).catch(err => console.warn('Discord warrant disk load error:', err));
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

    /**
     * Pull the full parsed payload from cases/<num>/Evidence/DiscordWarrant/
     * imports.json.  Anything found there supersedes the localStorage copy —
     * that copy is stripped of message bodies whenever the payload is large.
     */
    async loadFromDisk() {
        if (!window.electronAPI?.discordWarrantLoadStore) return false;
        try {
            const res = await window.electronAPI.discordWarrantLoadStore({ caseNumber: this.caseNumber });
            if (res && res.success && res.payload && Array.isArray(res.payload.imports) && res.payload.imports.length) {
                this.imports = res.payload.imports;
                return true;
            }
        } catch (e) {
            console.warn('Discord warrant disk load failed:', e);
        }
        return false;
    }

    /**
     * Persist to BOTH stores.  Disk is authoritative and holds everything;
     * localStorage gets a stripped index so the tab badge, import list and
     * flag counts still work before the async disk read resolves — and so the
     * module degrades gracefully if the IPC is unavailable.
     *
     * Must never throw: it is called from flag toggles and from import, and a
     * storage failure has to degrade rather than take the tab down.
     */
    saveData() {
        if (window.electronAPI?.discordWarrantSaveStore) {
            window.electronAPI.discordWarrantSaveStore({
                caseNumber: this.caseNumber,
                payload: { imports: this.imports }
            }).catch(err => console.error('Discord warrant disk save failed:', err));
        }

        const key = `discordWarrant_${this.caseId}`;
        // Stringify can itself be the expensive step on a big return, so only
        // attempt the full write when the record is plausibly small.
        const looksSmall = this.imports.every(i =>
            !i.data || !i.data._lazy) &&
            this.imports.reduce((n, i) => n + ((i.stats && i.stats.messageCount) || 0), 0) < 20000;

        if (looksSmall) {
            try {
                const full = JSON.stringify({ imports: this.imports });
                if (full.length < 3_500_000) { localStorage.setItem(key, full); return; }
            } catch (_) { /* fall through to the stripped write */ }
        }
        try {
            localStorage.setItem(key, JSON.stringify({ imports: this.imports.map(i => this._stripImport(i)) }));
        } catch (e) {
            // Out of quota even stripped — disk is authoritative, so carry on.
            console.error('Discord warrant localStorage save failed even when stripped:', e);
            try { localStorage.removeItem(key); } catch (_) {}
        }
    }

    /** Import record minus the bulk message bodies — index only. */
    _stripImport(imp) {
        const d = imp.data || {};
        return {
            ...imp,
            _truncated: true,
            data: {
                ...d,
                channels: (d.channels || []).map(c => ({ ...c, messages: [] })),
                contentFiles: {},
                servers: (d.servers || []).map(s => ({ ...s, auditLog: [] }))
            }
        };
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
     *
     * Nothing here may throw on the happy-ish path.  A six-figure return that
     * parses fine but fails to persist must still be usable in the open tab,
     * so persistence problems are reported, not raised.
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

        this._chanCache = null;
        try {
            this.saveData();
        } catch (e) {
            console.error('Discord warrant save after import failed:', e);
            this._saveError = e.message || String(e);
        }
        try {
            await this.scanForWarrants();
        } catch (e) {
            console.warn('Discord warrant rescan after import failed:', e);
        }
        return importRecord;
    }

    /**
     * Messages for one channel.  Large returns are sharded to disk at import
     * time (see DW_LAZY_MESSAGE_THRESHOLD in electron-main.js) and the channel
     * arrives with `_sharded: true` and an empty `messages`.  Exactly ONE
     * channel is cached at a time — the reference return's biggest channel is
     * 205,547 messages, and holding several would put us right back where the
     * crash came from.
     */
    async loadChannelMessages(channelId) {
        const imp = this.getActiveImport();
        if (!imp || !imp.data) return [];
        const ch = (imp.data.channels || []).find(c => c.channelId === channelId);
        if (!ch) return [];

        if (Array.isArray(ch.messages) && ch.messages.length) return ch.messages;
        const storeKey = imp.data._storeKey;
        if (!ch._sharded || !storeKey || !window.electronAPI?.discordWarrantReadChannel) {
            return Array.isArray(ch.messages) ? ch.messages : [];
        }

        const cacheKey = `${storeKey}|${channelId}`;
        if (this._chanCache && this._chanCache.key === cacheKey) return this._chanCache.messages;

        const res = await window.electronAPI.discordWarrantReadChannel({
            caseNumber: this.caseNumber, storeKey, channelId
        });
        if (!res || !res.success) {
            throw new Error((res && res.error) || 'Could not read this conversation from the case store');
        }
        const messages = Array.isArray(res.messages) ? res.messages : [];
        this._chanCache = { key: cacheKey, messages };
        return messages;
    }

    /**
     * Past this many messages a channel is never loaded whole — the UI reads
     * one page at a time from the message store.  The 2.36 GB return has a
     * single channel of ~2.4M messages; materialising that in the renderer is
     * exactly the crash we are fixing.
     */
    static get PAGED_THRESHOLD() { return 25000; }

    /** True when this channel must be read page-by-page rather than whole. */
    isChannelPaged(ch) {
        if (!ch) return false;
        const imp = this.getActiveImport();
        const storeKey = imp && imp.data && imp.data._storeKey;
        if (!storeKey || !ch._sharded) return false;
        if (!window.electronAPI?.discordWarrantReadPage) return false;
        return (ch.messageCount || 0) > DiscordWarrantModule.PAGED_THRESHOLD;
    }

    /**
     * One window of a channel, straight from the message store.  Nothing is
     * cached: the point is that only `limit` rows exist in the renderer at
     * any moment.
     */
    async loadChannelPage(channelId, offset, limit) {
        const imp = this.getActiveImport();
        const storeKey = imp && imp.data && imp.data._storeKey;
        if (!storeKey || !window.electronAPI?.discordWarrantReadPage) {
            return { messages: [], total: 0, offset: 0, limit };
        }
        const res = await window.electronAPI.discordWarrantReadPage({
            caseNumber: this.caseNumber, storeKey, channelId,
            offset: Math.max(0, offset | 0), limit: Math.max(1, limit | 0)
        });
        if (!res || !res.success) {
            throw new Error((res && res.error) || 'Could not read this conversation from the case store');
        }
        return {
            messages: Array.isArray(res.messages) ? res.messages : [],
            total: res.total || 0, offset: res.offset || 0, limit: res.limit || limit
        };
    }

    /**
     * Search inside one channel.  Runs in the main process against the store
     * so a multi-million-row channel never crosses the IPC boundary; results
     * are capped and each match carries its `ord` for a jump-to-page.
     */
    async searchChannelMessages(channelId, query, cap) {
        const imp = this.getActiveImport();
        const storeKey = imp && imp.data && imp.data._storeKey;
        if (!storeKey || !window.electronAPI?.discordWarrantSearchChannel) {
            return { matches: [], truncated: false, scanned: 0 };
        }
        const res = await window.electronAPI.discordWarrantSearchChannel({
            caseNumber: this.caseNumber, storeKey, channelId, query, cap: cap || 500
        });
        if (!res || !res.success) {
            throw new Error((res && res.error) || 'Search failed');
        }
        return {
            matches: Array.isArray(res.matches) ? res.matches : [],
            truncated: !!res.truncated, scanned: res.scanned || 0
        };
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
        const gone = this.imports.find(i => i.id === importId);
        this.imports = this.imports.filter(i => i.id !== importId);
        this._chanCache = null;
        // Drop the on-disk shards too, or a deleted 384 MB return keeps its
        // message store forever.
        const storeKey = gone && gone.data && gone.data._storeKey;
        if (storeKey && window.electronAPI?.discordWarrantDeleteStore) {
            window.electronAPI.discordWarrantDeleteStore({ caseNumber: this.caseNumber, storeKey })
                .catch(err => console.warn('Discord warrant store cleanup failed:', err));
        }
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

    // ═══════════════════════════════════════════════════════════════════
    // Flag-to-Evidence (uses shared WarrantFlags mixin)
    // ═══════════════════════════════════════════════════════════════════

    getActiveImport() {
        // UI tracks the active index; mirror that here.
        const ui = this.ui;
        if (ui && typeof ui.activeImportIdx === 'number') {
            return this.imports[ui.activeImportIdx] || null;
        }
        return this.imports[0] || null;
    }

    toggleFlag(section, key, snapshot) {
        const imp = this.getActiveImport();
        const nowOn = WarrantFlags.toggle(imp, section, key, () => {});
        // Remember enough about the flagged item to build the evidence bundle
        // WITHOUT re-scanning the messages.  On a sharded return the bodies
        // are not in memory, and even when they are, walking 541,831 records
        // per push is pointless when the row was on screen at flag time.
        if (imp && snapshot && typeof snapshot === 'object') {
            if (!imp.flagSnapshots || typeof imp.flagSnapshots !== 'object') imp.flagSnapshots = {};
            if (!imp.flagSnapshots[section]) imp.flagSnapshots[section] = {};
            if (nowOn) imp.flagSnapshots[section][String(key)] = snapshot;
            else delete imp.flagSnapshots[section][String(key)];
        }
        this.saveData();
        return nowOn;
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
     * Mirrors Datapilot's _resolveFlagged shape.
     */
    _resolveFlagged(imp) {
        const f = imp.flagged || {};
        const d = imp.data || {};
        const out = {
            messages: [],
            servers: [],
            ips: [],
            devices: [],
            activity: []
        };

        // Messages — flag key = msg.id (Discord snowflake, globally unique)
        const flaggedMsgIds = new Set((f.messages || []).map(String));
        if (flaggedMsgIds.size > 0) {
            // Prefer the snapshot captured when the examiner clicked the flag.
            // A sharded return has no message bodies in memory at all, and
            // re-walking half a million records would be wasteful even if it
            // did.  Fall back to scanning for records flagged before 5.1.7.
            const snaps = (imp.flagSnapshots && imp.flagSnapshots.messages) || {};
            const resolved = new Set();
            for (const id of flaggedMsgIds) {
                const s = snaps[id];
                if (!s) continue;
                out.messages.push({
                    id: s.id != null ? s.id : id,
                    timestamp: s.timestamp || null,
                    channel: s.channel || '',
                    channelId: s.channelId || null,
                    contents: s.contents || '',
                    attachments: s.attachments || ''
                });
                resolved.add(String(id));
            }
            if (resolved.size < flaggedMsgIds.size) {
                for (const ch of (d.channels || [])) {
                    const channelLabel = ch.guildName ? `${ch.guildName} · ${ch.channelName || ch.channelId}` : (ch.channelName || ch.channelId);
                    for (const m of (ch.messages || [])) {
                        const mid = String(m.id);
                        if (!flaggedMsgIds.has(mid) || resolved.has(mid)) continue;
                        out.messages.push({
                            id: m.id,
                            timestamp: m.timestamp,
                            channel: channelLabel,
                            channelId: ch.channelId,
                            contents: m.contents || '',
                            attachments: m.attachments || ''
                        });
                        resolved.add(mid);
                    }
                }
            }
            out.messages.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
        }

        // Servers — flag key = server.id
        const flaggedServerIds = new Set((f.servers || []).map(String));
        for (const s of (d.servers || [])) {
            if (!flaggedServerIds.has(String(s.id))) continue;
            out.servers.push({
                id: s.id,
                name: s.name || '',
                auditLogCount: (s.auditLog || []).length,
                auditLog: s.auditLog || []
            });
        }

        // IPs — flag key = ip string
        const flaggedIps = new Set((f.ips || []).map(String));
        for (const r of (d.ipActivity || [])) {
            if (!flaggedIps.has(String(r.ip))) continue;
            out.ips.push({
                ip: r.ip,
                hits: r.count,
                locations: (r.locations || []).join('; '),
                isps: (r.isps || []).join(', '),
                browsers: (r.browsers || []).join(', '),
                oses: (r.oses || []).join(', '),
                firstSeen: r.firstSeen,
                lastSeen: r.lastSeen,
                sources: (r.sources || []).join(', ')
            });
        }

        // Devices — flag key = device_vendor_id || key
        const flaggedDevs = new Set((f.devices || []).map(String));
        for (const r of (d.devices || [])) {
            const k = r.device_vendor_id || r.key || '';
            if (!flaggedDevs.has(String(k))) continue;
            out.devices.push({
                deviceVendorId: r.device_vendor_id || r.key || '',
                device: r.device || '',
                os: [r.os, r.os_version].filter(Boolean).join(' '),
                browser: r.browser || '',
                clientVersion: r.client_version || '',
                hits: r.count,
                ips: (r.ips || []).join(', '),
                firstSeen: r.firstSeen,
                lastSeen: r.lastSeen,
                userAgent: r.browser_user_agent || ''
            });
        }

        // Activity — flag key = `${ts}|${event_type}|${ip}|${session}`
        const flaggedActivity = new Set((f.activity || []).map(String));
        const a = d.activity || {};
        const allEvents = [
            ...(a.sessionStarts || []),
            ...(a.sessionEnds || []),
            ...(a.appOpens || []),
            ...(a.logins || []),
            ...(a.registers || []),
            ...(a.otherImportant || [])
        ];
        for (const ev of allEvents) {
            const k = WarrantFlagsKey.activity(ev);
            if (!flaggedActivity.has(k)) continue;
            out.activity.push({
                timestamp: ev.timestamp,
                event_type: ev.event_type,
                category: ev.category,
                ip: ev.ip || '',
                location: [ev.city, ev.region_code, ev.country_code].filter(Boolean).join(', '),
                device: ev.device || ev.browser || '',
                os: [ev.os, ev.os_version].filter(Boolean).join(' '),
                clientVersion: ev.client_version || '',
                session: ev.session || ''
            });
        }
        out.activity.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));

        return out;
    }

    _buildSubjectInfo(imp) {
        const sub = (imp.data && imp.data.subscriber) || {};
        return {
            'Username':        sub.username || imp.accountUsername || '',
            'User ID':         sub.id || imp.accountId || '',
            'Email':           sub.email || imp.email || '',
            'Phone':           sub.phone || imp.phone || '',
            'Last Known IP':   sub.ip || imp.ip || '',
            'Account Created': sub.createdAt || sub.created_at || '',
            'Source File':     imp.fileName || ''
        };
    }

    _buildSectionConfigs(imp, resolved) {
        return [
            {
                id: 'messages',
                title: 'Messages',
                icon: '💬',
                renderHint: 'messages',
                columns: [
                    { label: 'ID',          field: 'id',          type: 'mono' },
                    { label: 'Time',        field: 'timestamp',   type: 'date' },
                    { label: 'Channel',     field: 'channel' },
                    { label: 'Body',        field: 'contents',    type: 'longtext' },
                    { label: 'Attachments', field: 'attachments' }
                ],
                items: resolved.messages,
                emptyText: 'No messages flagged.'
            },
            {
                id: 'servers',
                title: 'Servers / Guilds',
                icon: '🏛️',
                renderHint: 'cards',
                columns: [
                    { label: 'Server ID',   field: 'id',             type: 'mono' },
                    { label: 'Name',        field: 'name' },
                    { label: 'Audit Log Entries', field: 'auditLogCount' },
                    { label: 'Audit Log',   field: 'auditLog',       type: 'pre' }
                ],
                items: resolved.servers,
                emptyText: 'No servers flagged.'
            },
            {
                id: 'ips',
                title: 'IP Activity',
                icon: '🌐',
                renderHint: 'table',
                columns: [
                    { label: 'IP',          field: 'ip',          type: 'mono' },
                    { label: 'Hits',        field: 'hits' },
                    { label: 'Locations',   field: 'locations' },
                    { label: 'ISP',         field: 'isps' },
                    { label: 'Browsers',    field: 'browsers' },
                    { label: 'OS',          field: 'oses' },
                    { label: 'First Seen',  field: 'firstSeen',   type: 'date' },
                    { label: 'Last Seen',   field: 'lastSeen',    type: 'date' },
                    { label: 'Sources',     field: 'sources' }
                ],
                items: resolved.ips,
                emptyText: 'No IPs flagged.'
            },
            {
                id: 'devices',
                title: 'Devices',
                icon: '📱',
                renderHint: 'table',
                columns: [
                    { label: 'Device Vendor ID', field: 'deviceVendorId', type: 'mono' },
                    { label: 'Device',           field: 'device' },
                    { label: 'OS',               field: 'os' },
                    { label: 'Browser',          field: 'browser' },
                    { label: 'Client Version',   field: 'clientVersion',  type: 'mono' },
                    { label: 'Hits',             field: 'hits' },
                    { label: 'IPs',              field: 'ips',            type: 'mono' },
                    { label: 'First Seen',       field: 'firstSeen',      type: 'date' },
                    { label: 'Last Seen',        field: 'lastSeen',       type: 'date' },
                    { label: 'User Agent',       field: 'userAgent' }
                ],
                items: resolved.devices,
                emptyText: 'No devices flagged.'
            },
            {
                id: 'activity',
                title: 'Activity Events',
                icon: '📊',
                renderHint: 'table',
                columns: [
                    { label: 'Time',           field: 'timestamp',     type: 'date' },
                    { label: 'Event',          field: 'event_type' },
                    { label: 'Category',       field: 'category' },
                    { label: 'IP',             field: 'ip',            type: 'mono' },
                    { label: 'Location',       field: 'location' },
                    { label: 'Device/Browser', field: 'device' },
                    { label: 'OS',             field: 'os' },
                    { label: 'Client Version', field: 'clientVersion', type: 'mono' },
                    { label: 'Session',        field: 'session',       type: 'mono' }
                ],
                items: resolved.activity,
                emptyText: 'No activity events flagged.'
            }
        ];
    }

    async pushFlagsToEvidence() {
        return WarrantFlags.pushToEvidence({
            caseNumber:    this.caseNumber,
            caseId:        this.caseId,
            moduleSlug:    'discord',
            moduleLabel:   'Discord Warrant',
            moduleFolder:  'DiscordWarrant',
            bundlePrefix:  'DW',
            evidenceKind:  'warrant-discord',
            iconEmoji:     '💬',
            getActiveImport:   () => this.getActiveImport(),
            resolveFlags:      (imp) => this._resolveFlagged(imp),
            getSubjectInfo:    (imp) => this._buildSubjectInfo(imp),
            getSourceFileName: (imp) => imp.fileName || '',
            getSectionConfigs: (imp, resolved) => this._buildSectionConfigs(imp, resolved)
        });
    }
}

// Stable flag-key generator for activity events (used by both module + UI)
window.WarrantFlagsKey = window.WarrantFlagsKey || {};
window.WarrantFlagsKey.activity = function (ev) {
    return [ev.timestamp || '', ev.event_type || '', ev.ip || '', ev.session || ''].join('|');
};

window.DiscordWarrantModule = DiscordWarrantModule;
