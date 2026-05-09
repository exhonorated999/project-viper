/**
 * KIK Warrant Parser — UI
 * Renders all parsed data sections in the case-detail tab.
 * Mirrors META/Google Warrant UI architecture.
 */

class KikWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
        this._expandedContacts = new Set();
        this._expandedGroups = new Set();
        this._timelineLimit = 200;
        this._contactFilter = '';
        this._friendFilter = '';
        this._mediaFilter = '';
        this._timelineFilter = 'all';
        this._mediaCache = {};
    }

    get container() { return document.getElementById(this.containerId); }
    get currentImport() { return this.module.imports[this.activeImportIdx] || null; }
    get data() { return this.currentImport?.data || null; }
    get stats() { return this.data?.stats || null; }

    // ─── Main Render ────────────────────────────────────────────────────

    render() {
        if (!this.container) return;
        if (this.module.imports.length === 0) {
            this.container.innerHTML = this._renderEmptyState();
            return;
        }
        this.container.innerHTML = `
            <div class="kkp-layout">
                <div class="kkp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderFlagToolbar()}
                    <div class="kkp-nav" id="kkp-nav"></div>
                    <div class="kkp-nav-actions">
                        <button onclick="window.kikWarrantUI.handleFilePicker()" class="kkp-btn-sm" title="Import another">+ Import</button>
                        <button onclick="window.kikWarrantUI.deleteImport('${this.currentImport?.id}')" class="kkp-btn-sm danger">🗑 Delete</button>
                    </div>
                </div>
                <div class="kkp-content" id="kkp-content"></div>
            </div>
        `;
        this._renderNav();
        this._renderSection();
    }

    _renderImportSelector() {
        const imports = this.module.imports;
        if (imports.length <= 1) return '';
        return `
            <div class="kkp-import-tabs">
                ${imports.map((imp, idx) => `
                    <button class="kkp-import-tab ${idx === this.activeImportIdx ? 'active' : ''}"
                        onclick="window.kikWarrantUI.switchImport(${idx})">
                        ${imp.accountUsername || imp.fileName}
                    </button>
                `).join('')}
                <button onclick="window.kikWarrantUI.handleFilePicker()" class="kkp-import-tab kkp-add-tab" title="Import another">+</button>
            </div>
        `;
    }

    // ─── Flag-to-Evidence toolbar (sidebar) ────────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        const enabled = total > 0;
        return `
            <div class="kwp-flag-toolbar">
                <button class="kwp-flag-header-btn"
                        title="Flagged item count — click to clear all flags"
                        onclick="window.kikWarrantUI._clearAllFlags()">
                    🚩 Flags
                    <span class="kwp-flag-count-pill" id="kwp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="kwp-flag-toolbar-spacer"></div>
                <button class="kwp-push-btn" id="kwp-push-btn"
                        ${enabled ? '' : 'disabled'}
                        onclick="window.kikWarrantUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('kwp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('kwp-push-btn');
        if (btn) btn.disabled = (total === 0);
    }

    async _pushFlagsToEvidence() {
        const total = this.module.flagCount();
        if (total === 0) {
            this._toast('No items flagged yet. Click 🚩 on items first.', 'info');
            return;
        }
        const ok = (typeof viperConfirm === 'function')
            ? await viperConfirm(`Push ${total} flagged item${total === 1 ? '' : 's'} to the case Evidence module as a single bundle?`,
                                  { okText: 'Push', danger: false })
            : confirm(`Push ${total} flagged item(s) to Evidence as a single bundle?`);
        if (!ok) return;

        const btn = document.getElementById('kwp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                this.module.clearFlags();
                this._refreshFlagToolbar();
                this._renderSection();
            }
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '📥 Push to Evidence'; }
            this._refreshFlagToolbar();
        }
    }

    _clearAllFlags() {
        const total = this.module.flagCount();
        if (total === 0) return;
        this.module.clearFlags();
        this._refreshFlagToolbar();
        this._renderSection();
    }

    _toast(msg, type) {
        try {
            if (typeof window.showToast === 'function') { window.showToast(msg, type || 'info'); return; }
        } catch (_) {}
        console.log(`[KikWarrant ${type || 'info'}] ${msg}`);
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        this._renderSection();
    }

    _flagBtn(section, key, label) {
        const on = this.module.isFlagged(section, key);
        const safeKey = String(key)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        return `<button class="kwp-flag-btn ${on ? 'on' : ''}"
                        title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                        onclick="event.stopPropagation(); window.kikWarrantUI._onFlagClick('${section}', '${safeKey}')">
                  🚩${label ? '<span style="margin-left:2px">' + label + '</span>' : ''}
                </button>`;
    }

    _renderNav() {
        const nav = document.getElementById('kkp-nav');
        if (!nav) return;

        const s = this.stats;
        const sections = [
            { id: 'overview', icon: '📋', label: 'Account Overview', count: null },
            { id: 'sessions', icon: '🔌', label: 'Session Activity', count: s?.counts?.binds || 0 },
            { id: 'friends', icon: '👥', label: 'Friends & Contacts', count: s?.uniqueFriends || 0 },
            { id: 'dms', icon: '💬', label: 'Direct Messages', count: (s?.counts?.dmTextSent || 0) + (s?.counts?.dmTextReceived || 0) },
            { id: 'groups', icon: '👥', label: 'Group Messages', count: s?.uniqueGroups || 0 },
            { id: 'media', icon: '📎', label: 'Media Activity', count: (s?.counts?.dmMediaSent || 0) + (s?.counts?.dmMediaReceived || 0) + (s?.counts?.groupMediaSent || 0) + (s?.counts?.groupMediaReceived || 0) },
            { id: 'timeline', icon: '📅', label: 'Timeline', count: s?.totalRecords || 0 }
        ];

        nav.innerHTML = sections.map(sec => `
            <button class="kkp-nav-item ${sec.id === this.activeSection ? 'active' : ''}"
                onclick="window.kikWarrantUI.switchSection('${sec.id}')">
                <span class="kkp-nav-icon">${sec.icon}</span>
                <span class="kkp-nav-label">${sec.label}</span>
                ${sec.count !== null ? `<span class="kkp-nav-count">${sec.count}</span>` : ''}
            </button>
        `).join('');
    }

    _renderSection() {
        const content = document.getElementById('kkp-content');
        if (!content) return;

        switch (this.activeSection) {
            case 'overview': content.innerHTML = this._renderOverview(); break;
            case 'sessions': content.innerHTML = this._renderSessions(); break;
            case 'friends': content.innerHTML = this._renderFriends(); break;
            case 'dms': content.innerHTML = this._renderDMs(); break;
            case 'groups': content.innerHTML = this._renderGroups(); break;
            case 'media': content.innerHTML = this._renderMedia(); break;
            case 'timeline': content.innerHTML = this._renderTimeline(); break;
            default: content.innerHTML = this._renderOverview();
        }
    }

    // ─── Empty State ────────────────────────────────────────────────────

    _renderEmptyState() {
        return `
            <div class="kkp-empty">
                <div class="kkp-empty-icon">💬</div>
                <div class="kkp-empty-title">KIK Warrant Parser</div>
                <div class="kkp-empty-desc">
                    Import a KIK Messenger warrant return ZIP to analyze messaging activity,
                    contacts, sessions, and group conversations.
                </div>
                <button onclick="window.kikWarrantUI.handleFilePicker()" class="kkp-btn-primary">
                    📁 Import KIK Warrant ZIP
                </button>
                <div id="kkp-evidence-bar" style="margin-top: 16px; width: 100%;"></div>
            </div>
        `;
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('kkp-evidence-bar');
        if (!bar || !files || files.length === 0) return;
        bar.innerHTML = `
            <div class="kkp-evidence-bar">
                <span class="kkp-evidence-bar-label">Found KIK ZIPs:</span>
                ${files.map(f => `
                    <span class="kkp-evidence-file ${f.alreadyImported ? 'imported' : ''}"
                        onclick="window.kikWarrantUI.importEvidence('${f.path.replace(/\\/g, '\\\\')}', '${f.name}')"
                        title="${f.alreadyImported ? 'Already imported' : 'Click to import'}">
                        ${f.name}
                    </span>
                `).join('')}
            </div>
        `;
    }

    // ─── Overview Section ───────────────────────────────────────────────

    _renderOverview() {
        const d = this.data;
        const s = this.stats;
        const imp = this.currentImport;
        if (!d || !s) return '<div class="kkp-section"><p style="color:#6b7280">No data loaded</p></div>';

        const hasContentFiles = d.contentFiles && Object.keys(d.contentFiles).length > 0;
        const hasDiskPaths = hasContentFiles && Object.values(d.contentFiles).some(f => f.diskPath);
        const mediaWarning = hasContentFiles && !hasDiskPaths
            ? `<div class="kkp-card" style="border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.05);">
                <div class="kkp-card-title" style="color: #fbbf24;">⚠️ Media Files Not Extracted</div>
                <p style="color:#d1d5db; font-size:0.87em; margin-bottom:8px;">This import was created before media extraction support. Delete this import and re-import the ZIP to extract ${Object.keys(d.contentFiles).length} media files.</p>
                <button onclick="window.kikWarrantUI.deleteAndReimport()" class="kkp-btn-outline" style="border-color:rgba(245,158,11,0.3); color:#fbbf24;">🔄 Delete &amp; Re-import</button>
            </div>`
            : '';

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">💬 Account Overview</div>
                ${mediaWarning}

                <div class="kkp-card-grid">
                    <div class="kkp-card">
                        <div class="kkp-card-title">Account Information</div>
                        <div class="kkp-kv-list">
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Username</span><span class="kkp-kv-value" style="color: #4ade80; font-weight: 600;">${d.accountUsername}</span></div>
                            ${d.caseNumber ? `<div class="kkp-kv-row"><span class="kkp-kv-label">KIK Case #</span><span class="kkp-kv-value">${d.caseNumber}</span></div>` : ''}
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Date Range</span><span class="kkp-kv-value">${this._formatDateRange(s.dateRange)}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Imported</span><span class="kkp-kv-value">${imp.importedAt ? new Date(imp.importedAt).toLocaleString() : 'Unknown'}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Source File</span><span class="kkp-kv-value">${imp.fileName || 'Unknown'}</span></div>
                        </div>
                    </div>

                    <div class="kkp-card">
                        <div class="kkp-card-title">Summary</div>
                        <div class="kkp-kv-list">
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Total Records</span><span class="kkp-kv-value" style="font-weight:700; color:#f3f4f6">${s.totalRecords.toLocaleString()}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Friends Added</span><span class="kkp-kv-value">${s.uniqueFriends}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">DM Contacts</span><span class="kkp-kv-value">${s.uniqueContacts}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Groups</span><span class="kkp-kv-value">${s.uniqueGroups}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Unique IPs</span><span class="kkp-kv-value">${s.uniqueIps}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Media Files</span><span class="kkp-kv-value">${s.counts.contentFiles || 0}</span></div>
                            <div class="kkp-kv-row"><span class="kkp-kv-label">Blocked Users</span><span class="kkp-kv-value">${s.counts.blocked}</span></div>
                        </div>
                    </div>
                </div>

                <div class="kkp-card kkp-card-full">
                    <div class="kkp-card-title">Activity Breakdown</div>
                    <div class="kkp-stats-grid">
                        ${this._statBox('🔌', s.counts.binds, 'Sessions')}
                        ${this._statBox('👤', s.uniqueFriends, 'Friends')}
                        ${this._statBox('📤', s.counts.dmTextSent, 'DM Sent')}
                        ${this._statBox('📥', s.counts.dmTextReceived, 'DM Received')}
                        ${this._statBox('🖼️', s.counts.dmMediaSent, 'Media Sent')}
                        ${this._statBox('📨', s.counts.dmMediaReceived, 'Media Recv')}
                        ${this._statBox('📤', s.counts.groupTextSent, 'Grp Sent')}
                        ${this._statBox('📥', s.counts.groupTextReceived, 'Grp Recv')}
                        ${this._statBox('🖼️', s.counts.groupMediaSent, 'Grp Media↑')}
                        ${this._statBox('📨', s.counts.groupMediaReceived, 'Grp Media↓')}
                    </div>
                </div>
            </div>
        `;
    }

    _statBox(icon, count, label) {
        return `
            <div class="kkp-stat ${count > 0 ? 'has-data' : ''}">
                <div class="kkp-stat-icon">${icon}</div>
                <div class="kkp-stat-count">${(count || 0).toLocaleString()}</div>
                <div class="kkp-stat-label">${label}</div>
            </div>
        `;
    }

    // ─── Sessions Section ───────────────────────────────────────────────

    _renderSessions() {
        const d = this.data;
        if (!d) return '';
        const binds = d.binds || [];

        // Unique IPs with counts
        const ipCounts = {};
        for (const b of binds) {
            if (b.ip) ipCounts[b.ip] = (ipCounts[b.ip] || 0) + 1;
        }

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">🔌 Session Activity</div>

                <div class="kkp-card">
                    <div class="kkp-card-title">IP Addresses (${Object.keys(ipCounts).length})</div>
                    <div class="kkp-ip-chips">
                        ${Object.entries(ipCounts).map(([ip, count]) => `
                            <span class="kkp-ip-chip">
                                ${ip}<span class="kkp-ip-count">×${count}</span>
                                <button class="kkp-arin-btn" onclick="kkpArinLookup(this, '${ip}')" title="ARIN Lookup">🔍</button>
                                ${this._flagBtn('sessions', ip)}
                            </span>
                        `).join('')}
                    </div>
                </div>

                <div class="kkp-card kkp-card-full">
                    <div class="kkp-card-title">Session Log (${binds.length} entries)</div>
                    <div class="kkp-table-wrap">
                        <table class="kkp-table">
                            <thead><tr>
                                <th>Date/Time</th>
                                <th>IP Address</th>
                                <th>Port</th>
                                <th>Country</th>
                                <th>Flag</th>
                            </tr></thead>
                            <tbody>
                                ${binds.map(b => {
                                    const k = window.WarrantFlagsKey.session(b);
                                    const flagged = this.module.isFlagged('sessions', k);
                                    return `
                                    <tr class="${flagged ? 'kwp-row-flagged' : ''}">
                                        <td>${b.datetime}</td>
                                        <td class="kkp-mono">${b.ip}</td>
                                        <td class="kkp-mono">${b.port}</td>
                                        <td>${b.country || '—'}</td>
                                        <td>${this._flagBtn('sessions', k)}</td>
                                    </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    // ─── Friends Section ────────────────────────────────────────────────

    _renderFriends() {
        const d = this.data;
        if (!d) return '';
        let friends = d.friends || [];

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">👥 Friends & Contacts (${friends.length})</div>

                <div class="kkp-search-bar">
                    <input type="text" class="kkp-search-input" placeholder="Search friends..."
                        id="kkp-friend-search" value="${this._friendFilter}"
                        oninput="window.kikWarrantUI.filterFriends(this.value)">
                </div>

                <div class="kkp-card kkp-card-full">
                    <div class="kkp-table-wrap">
                        <table class="kkp-table">
                            <thead><tr>
                                <th>Username</th>
                                <th>Added Date</th>
                                <th>Flag</th>
                            </tr></thead>
                            <tbody id="kkp-friends-tbody">
                                ${this._renderFriendsRows(friends)}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    _renderFriendsRows(friends) {
        if (this._friendFilter) {
            const q = this._friendFilter.toLowerCase();
            friends = friends.filter(f => f.friend.toLowerCase().includes(q));
        }
        return friends.map(f => {
            const k = window.WarrantFlagsKey.friend(f);
            const flagged = this.module.isFlagged('friends', k);
            return `
            <tr class="${flagged ? 'kwp-row-flagged' : ''}">
                <td style="color: #4ade80; font-weight: 500;">${f.friend}</td>
                <td>${f.datetime}</td>
                <td>${this._flagBtn('friends', k)}</td>
            </tr>
        `;
        }).join('') || '<tr><td colspan="3" style="text-align:center; color:#6b7280">No friends found</td></tr>';
    }

    filterFriends(value) {
        this._friendFilter = value;
        const tbody = document.getElementById('kkp-friends-tbody');
        if (tbody) tbody.innerHTML = this._renderFriendsRows(this.data?.friends || []);
    }

    // ─── Direct Messages Section ────────────────────────────────────────

    _renderDMs() {
        const d = this.data;
        if (!d) return '';

        // Merge all 4 DM files into per-contact conversations
        const conversations = this._buildDMConversations(d);
        const contacts = Object.entries(conversations)
            .sort((a, b) => b[1].total - a[1].total);

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">💬 Direct Messages (${contacts.length} contacts)</div>

                <div class="kkp-search-bar">
                    <input type="text" class="kkp-search-input" placeholder="Search contacts..."
                        id="kkp-dm-search" value="${this._contactFilter}"
                        oninput="window.kikWarrantUI.filterContacts(this.value)">
                </div>

                <div class="kkp-contact-list" id="kkp-dm-list">
                    ${this._renderContactList(contacts)}
                </div>
            </div>
        `;
    }

    _buildDMConversations(d) {
        const convos = {};
        const ensure = (username) => {
            if (!convos[username]) convos[username] = { sentText: 0, recvText: 0, sentMedia: 0, recvMedia: 0, total: 0, events: [] };
        };

        for (const r of (d.chatSent || [])) {
            ensure(r.recipient);
            convos[r.recipient].sentText += r.msgCount;
            convos[r.recipient].total += r.msgCount;
            convos[r.recipient].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'sent', type: 'text', count: r.msgCount, ip: r.ip, _raw: r });
        }
        for (const r of (d.chatSentReceived || [])) {
            ensure(r.sender);
            convos[r.sender].recvText += r.msgCount;
            convos[r.sender].total += r.msgCount;
            convos[r.sender].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'recv', type: 'text', count: r.msgCount, _raw: r });
        }
        for (const r of (d.chatPlatformSent || [])) {
            ensure(r.recipient);
            convos[r.recipient].sentMedia++;
            convos[r.recipient].total++;
            convos[r.recipient].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'sent', type: 'media', mediaType: r.mediaType, uuid: r.mediaUuid, ip: r.ip, _raw: r });
        }
        for (const r of (d.chatPlatformSentReceived || [])) {
            ensure(r.sender);
            convos[r.sender].recvMedia++;
            convos[r.sender].total++;
            convos[r.sender].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'recv', type: 'media', mediaType: r.mediaType, uuid: r.mediaUuid, _raw: r });
        }

        // Sort events within each conversation
        for (const c of Object.values(convos)) {
            c.events.sort((a, b) => a.ts - b.ts);
        }
        return convos;
    }

    _renderContactList(contacts) {
        let filtered = contacts;
        if (this._contactFilter) {
            const q = this._contactFilter.toLowerCase();
            filtered = contacts.filter(([name]) => name.toLowerCase().includes(q));
        }

        if (filtered.length === 0) {
            return '<div style="text-align:center; color:#6b7280; padding:20px">No contacts found</div>';
        }

        return filtered.map(([username, convo]) => {
            const expanded = this._expandedContacts.has(username);
            const initial = username.charAt(0).toUpperCase();
            return `
                <div>
                    <div class="kkp-contact-item ${expanded ? 'expanded' : ''}"
                        onclick="window.kikWarrantUI.toggleContact('${username}')">
                        <div class="kkp-contact-avatar">${initial}</div>
                        <div class="kkp-contact-info">
                            <div class="kkp-contact-name">${username}</div>
                            <div class="kkp-contact-meta">${convo.events.length} interactions · ${convo.events[0]?.dt || ''} — ${convo.events[convo.events.length - 1]?.dt || ''}</div>
                        </div>
                        <div class="kkp-contact-badges">
                            ${convo.sentText ? `<span class="kkp-badge kkp-badge-sent">↑${convo.sentText}</span>` : ''}
                            ${convo.recvText ? `<span class="kkp-badge kkp-badge-recv">↓${convo.recvText}</span>` : ''}
                            ${(convo.sentMedia + convo.recvMedia) ? `<span class="kkp-badge kkp-badge-media">📎${convo.sentMedia + convo.recvMedia}</span>` : ''}
                        </div>
                    </div>
                    ${expanded ? this._renderConversationDetail(convo) : ''}
                </div>
            `;
        }).join('');
    }

    _renderConversationDetail(convo) {
        const events = convo.events.slice(0, 500); // limit for performance
        return `
            <div class="kkp-conversation">
                ${events.map(e => {
                    const dirIcon = e.dir === 'sent' ? '↑' : '↓';
                    const dirClass = e.dir === 'sent' ? 'sent' : 'recv';
                    const k = window.WarrantFlagsKey.dm(e._raw || e, e.dir);
                    const flagged = this.module.isFlagged('dms', k);
                    let body = '';
                    if (e.type === 'text') {
                        body = `${e.count} text message${e.count > 1 ? 's' : ''}${e.ip && e.ip !== 'REDACTED' ? ` <span style="color:#6b7280">(${e.ip})</span>` : ''}`;
                    } else {
                        const hasMedia = this._hasMediaFile(e.uuid);
                        const mediaId = e.uuid ? e.uuid.replace(/[^a-zA-Z0-9-]/g, '') : '';
                        body = `<span class="media-tag">[${e.mediaType || 'Media'}]</span> `;
                        if (hasMedia) {
                            body += `<span class="kkp-media-thumb" id="kkp-thumb-${mediaId}" data-uuid="${e.uuid}" style="cursor:pointer" onclick="window.kikWarrantUI.loadMediaThumb('${e.uuid}', 'kkp-thumb-${mediaId}')">📷 Click to load</span>`;
                        } else {
                            body += e.uuid ? `<span style="color:#6b7280; font-size:0.8em">${e.uuid.substring(0, 8)}…</span>` : '';
                        }
                    }
                    return `
                        <div class="kkp-msg ${flagged ? 'kwp-msg-flagged' : ''}">
                            <span class="kkp-msg-time">${e.dt}</span>
                            <span class="kkp-msg-dir ${dirClass}">${dirIcon}</span>
                            <span class="kkp-msg-body">${body}</span>
                            <span style="margin-left:auto; flex-shrink:0">${this._flagBtn('dms', k)}</span>
                        </div>
                    `;
                }).join('')}
                ${convo.events.length > 500 ? `<div style="text-align:center; color:#6b7280; padding:8px; font-size:0.8em">Showing first 500 of ${convo.events.length} events</div>` : ''}
            </div>
        `;
    }

    filterContacts(value) {
        this._contactFilter = value;
        const list = document.getElementById('kkp-dm-list');
        if (!list) return;
        const conversations = this._buildDMConversations(this.data);
        const contacts = Object.entries(conversations).sort((a, b) => b[1].total - a[1].total);
        list.innerHTML = this._renderContactList(contacts);
    }

    toggleContact(username) {
        if (this._expandedContacts.has(username)) {
            this._expandedContacts.delete(username);
        } else {
            this._expandedContacts.add(username);
        }
        this.filterContacts(this._contactFilter); // re-render
    }

    // ─── Groups Section ─────────────────────────────────────────────────

    _renderGroups() {
        const d = this.data;
        if (!d) return '';

        const groups = this._buildGroupConversations(d);
        const groupList = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">👥 Group Messages (${groupList.length} groups)</div>

                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${groupList.map(([gid, group]) => this._renderGroupCard(gid, group)).join('')}
                </div>
            </div>
        `;
    }

    _buildGroupConversations(d) {
        const groups = {};
        const ensure = (gid) => {
            if (!groups[gid]) groups[gid] = { participants: new Set(), sentText: 0, recvText: 0, sentMedia: 0, recvMedia: 0, total: 0, events: [] };
        };

        for (const r of (d.groupSendMsg || [])) {
            ensure(r.groupId);
            groups[r.groupId].participants.add(r.sender);
            groups[r.groupId].participants.add(r.recipient);
            groups[r.groupId].sentText += r.msgCount;
            groups[r.groupId].total += r.msgCount;
            groups[r.groupId].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'sent', type: 'text', sender: r.sender, recipient: r.recipient, count: r.msgCount, ip: r.ip, _raw: r });
        }
        for (const r of (d.groupReceiveMsg || [])) {
            ensure(r.groupId);
            groups[r.groupId].participants.add(r.sender);
            groups[r.groupId].participants.add(r.recipient);
            groups[r.groupId].recvText += r.msgCount;
            groups[r.groupId].total += r.msgCount;
            groups[r.groupId].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'recv', type: 'text', sender: r.sender, recipient: r.recipient, count: r.msgCount, _raw: r });
        }
        for (const r of (d.groupSendMsgPlatform || [])) {
            ensure(r.groupId);
            groups[r.groupId].participants.add(r.sender);
            groups[r.groupId].participants.add(r.recipient);
            groups[r.groupId].sentMedia++;
            groups[r.groupId].total++;
            groups[r.groupId].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'sent', type: 'media', sender: r.sender, recipient: r.recipient, mediaType: r.mediaType, uuid: r.mediaUuid, ip: r.ip, _raw: r });
        }
        for (const r of (d.groupReceiveMsgPlatform || [])) {
            ensure(r.groupId);
            groups[r.groupId].participants.add(r.sender);
            groups[r.groupId].participants.add(r.recipient);
            groups[r.groupId].recvMedia++;
            groups[r.groupId].total++;
            groups[r.groupId].events.push({ ts: r.timestamp, dt: r.datetime, dir: 'recv', type: 'media', sender: r.sender, recipient: r.recipient, mediaType: r.mediaType, uuid: r.mediaUuid, _raw: r });
        }

        for (const g of Object.values(groups)) {
            g.events.sort((a, b) => a.ts - b.ts);
        }
        return groups;
    }

    _renderGroupCard(gid, group) {
        const expanded = this._expandedGroups.has(gid);
        const participants = Array.from(group.participants);
        const dateRange = group.events.length > 0
            ? `${group.events[0].dt} — ${group.events[group.events.length - 1].dt}`
            : '';

        return `
            <div>
                <div class="kkp-group-header ${expanded ? 'expanded' : ''}"
                    onclick="window.kikWarrantUI.toggleGroup('${gid}')">
                    <div class="kkp-group-icon">👥</div>
                    <div class="kkp-group-info">
                        <div class="kkp-group-name">${gid}</div>
                        <div class="kkp-group-meta">${participants.length} participants · ${group.total.toLocaleString()} messages · ${dateRange}</div>
                    </div>
                    <div class="kkp-contact-badges">
                        <span class="kkp-badge kkp-badge-sent">↑${group.sentText + group.sentMedia}</span>
                        <span class="kkp-badge kkp-badge-recv">↓${group.recvText + group.recvMedia}</span>
                    </div>
                </div>
                ${expanded ? `
                    <div style="margin-top: 8px; padding: 0 12px;">
                        <div class="kkp-card-title">Participants</div>
                        <div class="kkp-participant-list" style="margin-bottom: 12px;">
                            ${participants.map(p => `<span class="kkp-participant-chip" style="${p === this.data?.accountUsername ? 'color:#4ade80; border: 1px solid rgba(34,197,94,0.3);' : ''}">${p}</span>`).join('')}
                        </div>
                        ${this._renderGroupConversation(group)}
                    </div>
                ` : ''}
            </div>
        `;
    }

    _renderGroupConversation(group) {
        const events = group.events.slice(0, 500);
        return `
            <div class="kkp-conversation">
                ${events.map(e => {
                    const isTarget = e.sender === this.data?.accountUsername;
                    const dirClass = e.dir === 'sent' ? 'sent' : 'recv';
                    const dirIcon = e.dir === 'sent' ? '↑' : '↓';
                    const k = window.WarrantFlagsKey.group(e._raw || e, e.dir);
                    const flagged = this.module.isFlagged('groups', k);
                    let body = '';
                    if (e.type === 'text') {
                        body = `<strong style="color:${isTarget ? '#4ade80' : '#c084fc'}">${e.sender}</strong> → ${e.recipient}: ${e.count} msg${e.count > 1 ? 's' : ''}`;
                    } else {
                        const hasMedia = this._hasMediaFile(e.uuid);
                        const mediaId = e.uuid ? e.uuid.replace(/[^a-zA-Z0-9-]/g, '') : '';
                        body = `<strong style="color:${isTarget ? '#4ade80' : '#c084fc'}">${e.sender}</strong> → ${e.recipient}: <span class="media-tag">[${e.mediaType || 'Media'}]</span> `;
                        if (hasMedia) {
                            body += `<span class="kkp-media-thumb" id="kkp-gthumb-${mediaId}" data-uuid="${e.uuid}" style="cursor:pointer" onclick="window.kikWarrantUI.loadMediaThumb('${e.uuid}', 'kkp-gthumb-${mediaId}')">📷 Click to load</span>`;
                        }
                    }
                    return `
                        <div class="kkp-msg ${flagged ? 'kwp-msg-flagged' : ''}">
                            <span class="kkp-msg-time">${e.dt}</span>
                            <span class="kkp-msg-dir ${dirClass}">${dirIcon}</span>
                            <span class="kkp-msg-body">${body}</span>
                            <span style="margin-left:auto; flex-shrink:0">${this._flagBtn('groups', k)}</span>
                        </div>
                    `;
                }).join('')}
                ${group.events.length > 500 ? `<div style="text-align:center; color:#6b7280; padding:8px; font-size:0.8em">Showing first 500 of ${group.events.length} events</div>` : ''}
            </div>
        `;
    }

    toggleGroup(gid) {
        if (this._expandedGroups.has(gid)) {
            this._expandedGroups.delete(gid);
        } else {
            this._expandedGroups.add(gid);
        }
        this._renderSection();
    }

    // ─── Media Section ──────────────────────────────────────────────────

    _renderMedia() {
        const d = this.data;
        if (!d) return '';

        // Aggregate all platform files
        const media = [];
        for (const r of (d.chatPlatformSent || [])) {
            media.push({ ts: r.timestamp, dt: r.datetime, sender: r.sender, recipient: r.recipient, dir: 'sent', context: 'DM', mediaType: r.mediaType, uuid: r.mediaUuid, ip: r.ip, _raw: r });
        }
        for (const r of (d.chatPlatformSentReceived || [])) {
            media.push({ ts: r.timestamp, dt: r.datetime, sender: r.sender, recipient: r.recipient, dir: 'recv', context: 'DM', mediaType: r.mediaType, uuid: r.mediaUuid, _raw: r });
        }
        for (const r of (d.groupSendMsgPlatform || [])) {
            media.push({ ts: r.timestamp, dt: r.datetime, sender: r.sender, recipient: r.recipient, dir: 'sent', context: `Group: ${r.groupId}`, mediaType: r.mediaType, uuid: r.mediaUuid, ip: r.ip, _raw: r });
        }
        for (const r of (d.groupReceiveMsgPlatform || [])) {
            media.push({ ts: r.timestamp, dt: r.datetime, sender: r.sender, recipient: r.recipient, dir: 'recv', context: `Group: ${r.groupId}`, mediaType: r.mediaType, uuid: r.mediaUuid, _raw: r });
        }
        media.sort((a, b) => a.ts - b.ts);

        let filtered = media;
        if (this._mediaFilter) {
            const q = this._mediaFilter.toLowerCase();
            filtered = media.filter(m => m.sender.toLowerCase().includes(q) || m.recipient.toLowerCase().includes(q) || m.uuid.toLowerCase().includes(q));
        }

        const shown = filtered.slice(0, 500);

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">📎 Media Activity (${media.length} total)</div>

                <div class="kkp-search-bar">
                    <input type="text" class="kkp-search-input" placeholder="Filter by contact or UUID..."
                        id="kkp-media-search" value="${this._mediaFilter}"
                        oninput="window.kikWarrantUI.filterMedia(this.value)">
                </div>

                <div class="kkp-card kkp-card-full">
                    <div class="kkp-table-wrap">
                        <table class="kkp-table">
                            <thead><tr>
                                <th>Date/Time</th>
                                <th>Direction</th>
                                <th>Sender</th>
                                <th>Recipient</th>
                                <th>Type</th>
                                <th>Preview</th>
                                <th>Context</th>
                                <th>Flag</th>
                            </tr></thead>
                            <tbody id="kkp-media-tbody">
                                ${shown.map((m, i) => {
                                    const hasFile = this._hasMediaFile(m.uuid);
                                    const thumbId = `kkp-mtbl-${i}`;
                                    const k = window.WarrantFlagsKey.media(m._raw || m, m.dir);
                                    const flagged = this.module.isFlagged('media', k);
                                    return `
                                    <tr class="${flagged ? 'kwp-row-flagged' : ''}">
                                        <td>${m.dt}</td>
                                        <td><span class="kkp-badge ${m.dir === 'sent' ? 'kkp-badge-sent' : 'kkp-badge-recv'}">${m.dir === 'sent' ? '↑ Sent' : '↓ Recv'}</span></td>
                                        <td style="${m.sender === d.accountUsername ? 'color:#4ade80;font-weight:500' : ''}">${m.sender}</td>
                                        <td>${m.recipient}</td>
                                        <td>${m.mediaType}</td>
                                        <td>${hasFile ? `<span id="${thumbId}" style="cursor:pointer" onclick="window.kikWarrantUI.loadMediaThumb('${m.uuid}', '${thumbId}')">📷 Load</span>` : `<span class="kkp-mono" title="${m.uuid}">${m.uuid ? m.uuid.substring(0, 12) + '…' : '—'}</span>`}</td>
                                        <td>${m.context}</td>
                                        <td>${this._flagBtn('media', k)}</td>
                                    </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${filtered.length > 500 ? `<div class="kkp-show-more"><span style="color:#6b7280; font-size:0.8em">Showing ${shown.length} of ${filtered.length}</span></div>` : ''}
                </div>
            </div>
        `;
    }

    filterMedia(value) {
        this._mediaFilter = value;
        this._renderSection(); // full re-render for media section
    }

    // ─── Timeline Section ───────────────────────────────────────────────

    _renderTimeline() {
        const d = this.data;
        if (!d) return '';

        // Build unified timeline
        const events = this._buildTimeline(d);
        let filtered = events;
        if (this._timelineFilter !== 'all') {
            filtered = events.filter(e => e.category === this._timelineFilter);
        }

        const shown = filtered.slice(0, this._timelineLimit);

        return `
            <div class="kkp-section">
                <div class="kkp-section-title">📅 Timeline (${events.length} events)</div>

                <div class="kkp-search-bar">
                    <select class="kkp-select" id="kkp-timeline-filter" onchange="window.kikWarrantUI.filterTimeline(this.value)">
                        <option value="all" ${this._timelineFilter === 'all' ? 'selected' : ''}>All Activity (${events.length})</option>
                        <option value="bind" ${this._timelineFilter === 'bind' ? 'selected' : ''}>Sessions (${events.filter(e => e.category === 'bind').length})</option>
                        <option value="friend" ${this._timelineFilter === 'friend' ? 'selected' : ''}>Friends (${events.filter(e => e.category === 'friend').length})</option>
                        <option value="dm" ${this._timelineFilter === 'dm' ? 'selected' : ''}>Direct Messages (${events.filter(e => e.category === 'dm').length})</option>
                        <option value="group" ${this._timelineFilter === 'group' ? 'selected' : ''}>Group Messages (${events.filter(e => e.category === 'group').length})</option>
                        <option value="media" ${this._timelineFilter === 'media' ? 'selected' : ''}>Media (${events.filter(e => e.category === 'media').length})</option>
                    </select>
                </div>

                <div class="kkp-timeline" id="kkp-timeline-list">
                    ${shown.map(e => `
                        <div class="kkp-timeline-item">
                            <span class="kkp-timeline-time">${e.dt}</span>
                            <span class="kkp-timeline-dot ${e.category}"></span>
                            <span class="kkp-timeline-body">
                                <span class="kkp-timeline-type ${e.category}">${e.typeLabel}</span>
                                ${e.description}
                            </span>
                            <span style="margin-left:auto; flex-shrink:0">${this._flagBtn(e.flagSection, e.flagKey)}</span>
                        </div>
                    `).join('')}
                </div>

                ${filtered.length > shown.length ? `
                    <div class="kkp-show-more">
                        <button onclick="window.kikWarrantUI.showMoreTimeline()">
                            Show more (${shown.length} of ${filtered.length})
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    _buildTimeline(d) {
        const events = [];

        for (const b of (d.binds || [])) {
            events.push({ ts: b.timestamp, dt: b.datetime, category: 'bind', typeLabel: 'SESSION',
                description: `Login from <span class="kkp-mono">${b.ip}</span> (${b.country || '?'})`,
                flagSection: 'sessions', flagKey: WarrantFlagsKey.session(b) });
        }
        for (const f of (d.friends || [])) {
            events.push({ ts: f.timestamp, dt: f.datetime, category: 'friend', typeLabel: 'FRIEND',
                description: `Added <strong>${f.friend}</strong>`,
                flagSection: 'friends', flagKey: WarrantFlagsKey.friend(f) });
        }
        for (const r of (d.chatSent || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'dm', typeLabel: 'DM',
                description: `Sent ${r.msgCount} msg${r.msgCount > 1 ? 's' : ''} to <strong>${r.recipient}</strong>`,
                flagSection: 'dms', flagKey: WarrantFlagsKey.dm(r, 'sent') });
        }
        for (const r of (d.chatSentReceived || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'dm', typeLabel: 'DM',
                description: `Received ${r.msgCount} msg${r.msgCount > 1 ? 's' : ''} from <strong>${r.sender}</strong>`,
                flagSection: 'dms', flagKey: WarrantFlagsKey.dm(r, 'recv') });
        }
        for (const r of (d.chatPlatformSent || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'media', typeLabel: 'MEDIA',
                description: `Sent ${r.mediaType || 'media'} to <strong>${r.recipient}</strong>`,
                flagSection: 'media', flagKey: WarrantFlagsKey.media(r, 'sent') });
        }
        for (const r of (d.chatPlatformSentReceived || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'media', typeLabel: 'MEDIA',
                description: `Received ${r.mediaType || 'media'} from <strong>${r.sender}</strong>`,
                flagSection: 'media', flagKey: WarrantFlagsKey.media(r, 'recv') });
        }
        for (const r of (d.groupSendMsg || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'group', typeLabel: 'GROUP',
                description: `Sent ${r.msgCount} msg${r.msgCount > 1 ? 's' : ''} to <strong>${r.recipient}</strong> in ${r.groupId}`,
                flagSection: 'groups', flagKey: WarrantFlagsKey.group(r, 'sent') });
        }
        for (const r of (d.groupReceiveMsg || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'group', typeLabel: 'GROUP',
                description: `<strong>${r.sender}</strong> sent ${r.msgCount} msg${r.msgCount > 1 ? 's' : ''} in ${r.groupId}`,
                flagSection: 'groups', flagKey: WarrantFlagsKey.group(r, 'recv') });
        }
        for (const r of (d.groupSendMsgPlatform || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'media', typeLabel: 'MEDIA',
                description: `Sent ${r.mediaType || 'media'} to <strong>${r.recipient}</strong> in group ${r.groupId}`,
                flagSection: 'media', flagKey: WarrantFlagsKey.media(r, 'sent') });
        }
        for (const r of (d.groupReceiveMsgPlatform || [])) {
            events.push({ ts: r.timestamp, dt: r.datetime, category: 'media', typeLabel: 'MEDIA',
                description: `<strong>${r.sender}</strong> sent ${r.mediaType || 'media'} in group ${r.groupId}`,
                flagSection: 'media', flagKey: WarrantFlagsKey.media(r, 'recv') });
        }

        events.sort((a, b) => a.ts - b.ts);
        return events;
    }

    filterTimeline(value) {
        this._timelineFilter = value;
        this._timelineLimit = 200;
        this._renderSection();
    }

    showMoreTimeline() {
        this._timelineLimit += 200;
        this._renderSection();
    }

    // ─── Actions ────────────────────────────────────────────────────────

    switchSection(sectionId) {
        this.activeSection = sectionId;
        this._renderNav();
        this._renderSection();
    }

    switchImport(idx) {
        this.activeImportIdx = idx;
        this._expandedContacts.clear();
        this._expandedGroups.clear();
        this.render();
    }

    async handleFilePicker() {
        try {
            const result = await this.module.importFromPicker();
            if (result) {
                this.activeImportIdx = this.module.imports.length - 1;
                this.render();
                if (typeof viperToast === 'function') viperToast('KIK warrant imported successfully', 'success');
            }
        } catch (err) {
            console.error('KIK import error:', err);
            if (typeof viperToast === 'function') viperToast('Import failed: ' + err.message, 'error');
        }
    }

    async importEvidence(filePath, fileName) {
        try {
            const result = await this.module.importWarrant(filePath, fileName);
            if (result) {
                this.activeImportIdx = this.module.imports.length - 1;
                this.render();
                if (typeof viperToast === 'function') viperToast('KIK warrant imported', 'success');
            }
        } catch (err) {
            console.error('KIK import error:', err);
            if (typeof viperToast === 'function') viperToast('Import failed: ' + err.message, 'error');
        }
    }

    deleteImport(importId) {
        if (!importId) return;
        this.module.deleteImport(importId);
        this.activeImportIdx = Math.max(0, this.activeImportIdx - 1);
        this._expandedContacts.clear();
        this._expandedGroups.clear();
        this.render();
    }

    async deleteAndReimport() {
        const imp = this.currentImport;
        if (!imp) return;
        const filePath = imp.filePath;
        const fileName = imp.fileName;
        // Delete old import
        this.module.deleteImport(imp.id);
        // Re-import from same path
        try {
            const result = await this.module.importWarrant(filePath, fileName);
            if (result) {
                this.activeImportIdx = this.module.imports.length - 1;
                this.render();
                if (typeof viperToast === 'function') viperToast('KIK warrant re-imported with media extraction', 'success');
            }
        } catch (err) {
            console.error('Re-import error:', err);
            if (typeof viperToast === 'function') viperToast('Re-import failed: ' + err.message, 'error');
            this.render();
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _formatDateRange(range) {
        if (!range || !range.start) return 'Unknown';
        const start = new Date(range.start).toLocaleDateString();
        const end = range.end ? new Date(range.end).toLocaleDateString() : '?';
        return `${start} — ${end}`;
    }

    /** Check if a media UUID has a content file on disk */
    _hasMediaFile(uuid) {
        if (!uuid || !this.data?.contentFiles) return false;
        const cf = this.data.contentFiles;
        if (cf[uuid] && cf[uuid].diskPath) return true;
        for (const ext of ['.jpg', '.mp4', '.png', '.gif']) {
            if (cf[uuid + ext] && cf[uuid + ext].diskPath) return true;
        }
        return false;
    }

    /** Get content file info for a UUID */
    _getContentFile(uuid) {
        if (!uuid || !this.data?.contentFiles) return null;
        const cf = this.data.contentFiles;
        if (cf[uuid]) return cf[uuid];
        for (const ext of ['.jpg', '.mp4', '.png', '.gif']) {
            if (cf[uuid + ext]) return cf[uuid + ext];
        }
        return null;
    }

    /** Lazy-load a media thumbnail */
    async loadMediaThumb(uuid, elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;

        const file = this._getContentFile(uuid);
        if (!file || !file.diskPath) {
            el.textContent = '❌ No file';
            return;
        }

        // Check cache
        if (this._mediaCache[uuid]) {
            el.outerHTML = this._mediaCache[uuid];
            return;
        }

        el.textContent = '⏳ Loading...';

        try {
            const result = await this.module.readMedia(file.diskPath);
            if (!result) {
                el.textContent = '❌ Read failed';
                return;
            }

            const dataUrl = `data:${result.mimeType};base64,${result.data}`;
            let html = '';
            if (result.mimeType.startsWith('image/')) {
                html = `<img src="${dataUrl}" style="max-width:300px; max-height:200px; border-radius:6px; margin-top:4px; cursor:pointer;" onclick="window.kikWarrantUI.showFullMedia('${uuid}')">`;
            } else if (result.mimeType.startsWith('video/')) {
                html = `<video src="${dataUrl}" controls style="max-width:300px; max-height:200px; border-radius:6px; margin-top:4px;"></video>`;
            } else {
                html = `<a href="${dataUrl}" download="${uuid}" style="color:#4ade80">📎 Download</a>`;
            }

            this._mediaCache[uuid] = html;
            el.outerHTML = html;
        } catch (e) {
            el.textContent = '❌ Error';
            console.error('Media load error:', e);
        }
    }

    /** Show full-size media in a modal */
    showFullMedia(uuid) {
        const file = this._getContentFile(uuid);
        if (!file) return;

        const cached = this._mediaCache[uuid];
        if (!cached) return;

        // Extract src from cached HTML
        const srcMatch = cached.match(/src="([^"]+)"/);
        if (!srcMatch) return;

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:pointer;';
        modal.onclick = () => modal.remove();

        if (file.mimeType?.startsWith('video/')) {
            modal.innerHTML = `<video src="${srcMatch[1]}" controls autoplay style="max-width:90vw;max-height:90vh;border-radius:8px;" onclick="event.stopPropagation()"></video>`;
        } else {
            modal.innerHTML = `<img src="${srcMatch[1]}" style="max-width:90vw;max-height:90vh;border-radius:8px;">`;
        }
        document.body.appendChild(modal);
    }
}

// Expose on window
window.KikWarrantUI = KikWarrantUI;

// Global ARIN lookup for KIK Warrant IP addresses
async function kkpArinLookup(btn, ip) {
    if (!ip || !window.electronAPI?.arinLookup) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
        const result = await window.electronAPI.arinLookup(ip);
        if (result.success) {
            const info = [result.provider || result.organization];
            if (result.network) info.push(result.network);
            if (result.netRange) info.push(result.netRange);
            const span = btn.nextElementSibling || document.createElement('span');
            span.className = 'kkp-arin-result';
            span.textContent = info.join(' · ');
            span.title = info.join('\n');
            if (!btn.nextElementSibling) btn.parentNode.appendChild(span);
            btn.textContent = '✓';
            btn.style.color = '#4ade80';
        } else {
            btn.textContent = '✗';
            btn.title = result.error || 'Lookup failed';
            btn.style.color = '#f87171';
        }
    } catch (e) {
        btn.textContent = '✗';
        btn.title = e.message;
        btn.style.color = '#f87171';
    }
    btn.disabled = false;
}
window.kkpArinLookup = kkpArinLookup;
