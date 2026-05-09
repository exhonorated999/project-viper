/**
 * Snapchat Warrant Parser — UI
 * Renders all parsed data sections in the case-detail tab.
 * Mirrors the Meta/Google/KIK Warrant UI architecture (sidebar + sections).
 */

class SnapchatWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
        this._mediaCache = {};         // diskPath → data:url
        this._convFilter = '';
        this._convPage = 0;
        this._convPageSize = 100;
        this._activeConversationId = null; // when set, show single thread view
        this._mediaPage = 0;
        this._mediaPageSize = 60;
        this._mediaFilterType = 'all'; // all|image|video
        this._geoMap = null;
    }

    get container() { return document.getElementById(this.containerId); }
    get currentImport() { return this.module.imports[this.activeImportIdx] || null; }

    // ─── Main Render ────────────────────────────────────────────────────

    render() {
        if (!this.container) return;

        if (this.module.imports.length === 0) {
            this.container.innerHTML = this._renderEmptyState();
            return;
        }

        this.container.innerHTML = `
            <div class="swp-layout">
                <div class="swp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderFlagToolbar()}
                    ${this._renderNav()}
                </div>
                <div class="swp-content" id="swp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="swp-evidence-bar"></div>
        `;
        this._loadLazyImages();
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('swp-evidence-bar');
        if (!bar) return;
        if (!files || files.length === 0) { bar.innerHTML = ''; return; }

        bar.innerHTML = `
            <div class="swp-evidence-bar">
                <div class="swp-evidence-label">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    Detected Snapchat Warrant Files:
                </div>
                ${files.map(f => `
                    <button class="swp-evidence-file ${f.alreadyImported ? 'imported' : ''}"
                            onclick="window.snapchatWarrantUI.handleEvidenceClick('${this._escJs(f.path)}', '${this._escJs(f.name)}', ${f.isFolder ? 'true' : 'false'})"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="swp-evidence-icon">${f.alreadyImported ? '✅' : (f.isFolder ? '📁' : '📦')}</span>
                        <span class="swp-evidence-name">${this._esc(f.name)}</span>
                        ${f.size ? `<span class="swp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>` : ''}
                    </button>
                `).join('')}
            </div>
        `;
    }

    // ─── Flag-to-Evidence toolbar (sidebar) ────────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        const enabled = total > 0;
        return `
            <div class="swp-flag-toolbar">
                <button class="swp-flag-header-btn"
                        title="Flagged item count — click to clear all flags">
                    🚩 Flags
                    <span class="swp-flag-count-pill" id="swp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="swp-flag-toolbar-spacer"></div>
                <button class="swp-push-btn" id="swp-push-btn"
                        ${enabled ? '' : 'disabled'}
                        onclick="window.snapchatWarrantUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('swp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('swp-push-btn');
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

        const btn = document.getElementById('swp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                this.module.clearFlags();
                this._refreshFlagToolbar();
                const content = document.getElementById('swp-content-area');
                if (content) {
                    content.innerHTML = this._renderSection();
                    if (typeof this._loadLazyImages === 'function') this._loadLazyImages(content);
                }
            }
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '📥 Push to Evidence'; }
            this._refreshFlagToolbar();
        }
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        const content = document.getElementById('swp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            if (typeof this._loadLazyImages === 'function') this._loadLazyImages(content);
        }
    }

    _flagBtn(section, key, label) {
        const on = this.module.isFlagged(section, key);
        const safeKey = String(key)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        return `<button class="swp-flag-btn ${on ? 'on' : ''}"
                        title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                        onclick="event.stopPropagation(); window.snapchatWarrantUI._onFlagClick('${section}', '${safeKey}')">
                  🚩${label ? '<span style="margin-left:2px">' + label + '</span>' : ''}
                </button>`;
    }

    async handleEvidenceClick(filePath, fileName, isFolder) {
        try {
            this._showLoading('Importing Snapchat warrant data... (large productions may take a minute)');
            const record = await this.module.importWarrant(filePath, fileName, isFolder);
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.targetUsername || fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    async handleFilePicker() {
        try {
            this._showLoading('Importing Snapchat warrant data... (large productions may take a minute)');
            const record = await this.module.importFromPicker();
            if (!record) { this.render(); return; }
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.targetUsername || record.fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    switchSection(section) {
        this.activeSection = section;
        this._activeConversationId = null;
        this._convPage = 0;
        this._mediaPage = 0;
        const content = document.getElementById('swp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            this._loadLazyImages(content);
            if (section === 'geo') this._initGeoMap();
        }
        document.querySelectorAll('.swp-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.section === section);
        });
    }

    switchImport(idx) {
        this.activeImportIdx = idx;
        this.activeSection = 'overview';
        this.render();
    }

    deleteCurrentImport() {
        const imp = this.currentImport;
        if (!imp) return;
        if (!confirm(`Delete import "${imp.fileName}"?`)) return;
        this.module.deleteImport(imp.id);
        this.activeImportIdx = 0;
        this.activeSection = 'overview';
        this.render();
    }

    // ─── Navigation ─────────────────────────────────────────────────────

    _renderImportSelector() {
        if (this.module.imports.length <= 1) return '';
        return `
            <div class="swp-import-selector">
                <label class="swp-label">Import:</label>
                <select onchange="window.snapchatWarrantUI.switchImport(parseInt(this.value))" class="swp-select">
                    ${this.module.imports.map((imp, i) => `
                        <option value="${i}" ${i === this.activeImportIdx ? 'selected' : ''}>
                            ${this._esc(imp.targetUsername || imp.fileName)}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;
    }

    _renderNav() {
        const imp = this.currentImport;
        if (!imp) return '';

        // Count distinct conversation_ids
        const convIds = new Set();
        for (const m of imp.conversations) {
            if (m.conversation_id) convIds.add(m.conversation_id);
        }

        const otherCsvCount = Object.keys(imp.otherCsvs || {}).length;

        const sections = [
            { id: 'overview',     label: 'Account Overview',  icon: '👤', show: true },
            { id: 'conversations', label: 'Conversations',    icon: '💬', count: convIds.size, show: imp.conversations.length > 0 },
            { id: 'media',        label: 'Media',             icon: '📷', count: Object.keys(imp.mediaFiles || {}).length, show: Object.keys(imp.mediaFiles || {}).length > 0 },
            { id: 'memories',     label: 'Memories',          icon: '⭐', count: imp.memories.length, show: imp.memories.length > 0 },
            { id: 'geo',          label: 'Geo Locations',     icon: '🗺️', count: imp.geoLocations.length, show: imp.geoLocations.length > 0 },
            { id: 'devices',      label: 'Device IDs',        icon: '📱', count: imp.deviceAdvertisingIds.length, show: imp.deviceAdvertisingIds.length > 0 },
            { id: 'logins',       label: 'Login History',     icon: '🌐', count: imp.loginHistory.length, show: imp.loginHistory.length > 0 },
            { id: 'friends',      label: 'Friends',           icon: '👥', count: imp.friends.length, show: imp.friends.length > 0 },
            { id: 'snapHistory',  label: 'Snap History',      icon: '👻', count: imp.snapHistory.length, show: imp.snapHistory.length > 0 },
            { id: 'other',        label: 'Other Data',        icon: '📋', count: otherCsvCount, show: otherCsvCount > 0 },
            { id: 'timeline',     label: 'Timeline',          icon: '🕐', show: imp.conversations.length > 0 || imp.geoLocations.length > 0 }
        ];

        return `
            <nav class="swp-nav">
                ${sections.filter(s => s.show).map(s => `
                    <button class="swp-nav-item ${s.id === this.activeSection ? 'active' : ''}"
                            data-section="${s.id}"
                            onclick="window.snapchatWarrantUI.switchSection('${s.id}')">
                        <span class="swp-nav-icon">${s.icon}</span>
                        <span class="swp-nav-label">${s.label}</span>
                        ${s.count ? `<span class="swp-nav-count">${s.count.toLocaleString()}</span>` : ''}
                    </button>
                `).join('')}
            </nav>
            <div class="swp-nav-actions">
                <button class="swp-btn-sm" onclick="window.snapchatWarrantUI.handleFilePicker()">+ Import</button>
                <button class="swp-btn-sm danger" onclick="window.snapchatWarrantUI.deleteCurrentImport()">🗑️ Delete</button>
            </div>
        `;
    }

    // ─── Section Router ─────────────────────────────────────────────────

    _renderSection() {
        const imp = this.currentImport;
        if (!imp) return '<div class="swp-empty">No data available</div>';

        switch (this.activeSection) {
            case 'overview':      return this._renderOverview(imp);
            case 'conversations': return this._renderConversations(imp);
            case 'media':         return this._renderMedia(imp);
            case 'memories':      return this._renderMemories(imp);
            case 'geo':           return this._renderGeo(imp);
            case 'devices':       return this._renderDevices(imp);
            case 'logins':        return this._renderLogins(imp);
            case 'friends':       return this._renderFriends(imp);
            case 'snapHistory':   return this._renderSnapHistory(imp);
            case 'other':         return this._renderOtherCsvs(imp);
            case 'timeline':      return this._renderTimeline(imp);
            default:              return '<div class="swp-empty">Unknown section</div>';
        }
    }

    // ─── Overview ───────────────────────────────────────────────────────

    _renderOverview(imp) {
        const sub = imp.subscriberInfo || {};
        const convCount = imp.conversations.length;
        const groupConv = imp.conversations.filter(c => c.is_one_on_one === 'false').length;
        const oneOnOne = convCount - groupConv;
        const snaps = imp.conversations.filter(c => c.message_type === 'SNAP').length;
        const chats = imp.conversations.filter(c => c.message_type === 'Chat' || c.message_type === 'CHAT').length;
        const mediaCount = Object.keys(imp.mediaFiles || {}).length;

        return `
            <div class="swp-section">
                <div class="swp-account-header">
                    <div class="swp-snap-logo">👻</div>
                    <div class="swp-account-info">
                        <h2 class="swp-account-username">${this._esc(imp.targetUsername || '(unknown)')}</h2>
                        <div class="swp-account-meta">
                            ${imp.email ? `<span>📧 ${this._esc(imp.email)}</span>` : ''}
                            ${imp.userId ? `<span class="swp-mono">🆔 ${this._esc(imp.userId)}</span>` : ''}
                        </div>
                        ${imp.dateRange ? `<div class="swp-date-range">📅 ${this._esc(imp.dateRange)}</div>` : ''}
                    </div>
                </div>

                <div class="swp-stats-grid">
                    ${this._statBadge('Conversations', convCount, '💬')}
                    ${this._statBadge('Snaps', snaps, '👻')}
                    ${this._statBadge('Chats', chats, '💭')}
                    ${this._statBadge('1-on-1', oneOnOne, '👥')}
                    ${this._statBadge('Group', groupConv, '👨‍👩‍👧')}
                    ${this._statBadge('Media Files', mediaCount, '📷')}
                    ${this._statBadge('Memories', imp.memories.length, '⭐')}
                    ${this._statBadge('Geo Pings', imp.geoLocations.length, '🗺️')}
                    ${this._statBadge('Device IDs', imp.deviceAdvertisingIds.length, '📱')}
                </div>

                ${imp.parts && imp.parts.length > 1 ? `
                    <div class="swp-card">
                        <h3 class="swp-card-title">📁 Production Parts (${imp.parts.length})</h3>
                        <table class="swp-table">
                            <thead><tr><th>Part Folder</th><th>Conversations</th><th>Geo</th><th>Memories</th></tr></thead>
                            <tbody>
                                ${imp.parts.map(p => `
                                    <tr>
                                        <td class="swp-mono">${this._esc(p.partFolder)}</td>
                                        <td>${(p.conversationCount || 0).toLocaleString()}</td>
                                        <td>${(p.geoCount || 0).toLocaleString()}</td>
                                        <td>${(p.memoryCount || 0).toLocaleString()}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                ` : ''}

                ${Object.keys(sub).length > 0 ? `
                    <div class="swp-card">
                        <h3 class="swp-card-title">📋 Subscriber Info</h3>
                        <div class="swp-kv-list">
                            ${Object.entries(sub).map(([k, v]) => this._kvRow(k, v)).join('')}
                        </div>
                    </div>
                ` : ''}

                <div class="swp-card">
                    <h3 class="swp-card-title">📂 Source</h3>
                    <div class="swp-kv-list">
                        ${this._kvRow('File', imp.fileName)}
                        ${this._kvRow('Type', imp.isFolder ? 'Unzipped Folder' : 'ZIP Archive')}
                        ${this._kvRow('Path', imp.filePath)}
                        ${this._kvRow('Imported', new Date(imp.importedAt).toLocaleString())}
                    </div>
                </div>
            </div>
        `;
    }

    // ─── Conversations ──────────────────────────────────────────────────

    _renderConversations(imp) {
        const all = imp.conversations || [];
        // Group by conversation_id
        const groups = new Map();
        for (const m of all) {
            const cid = m.conversation_id || '__unknown__';
            if (!groups.has(cid)) groups.set(cid, { conversation_id: cid, title: m.conversation_title || '', isOneOnOne: m.is_one_on_one === 'true', participants: new Set(), messages: [] });
            const g = groups.get(cid);
            g.messages.push(m);
            if (m.sender_username) g.participants.add(m.sender_username);
            if (m.recipient_username) g.participants.add(m.recipient_username);
            if (m.group_member_usernames) {
                for (const u of String(m.group_member_usernames).split(';')) {
                    if (u.trim()) g.participants.add(u.trim());
                }
            }
        }
        const groupList = Array.from(groups.values()).map(g => ({
            ...g,
            participants: Array.from(g.participants),
            count: g.messages.length,
            lastTime: g.messages.reduce((a, b) => Date.parse(b.timestamp || '') > Date.parse(a || '') ? (b.timestamp || a) : a, '')
        })).sort((a, b) => Date.parse(b.lastTime || '') - Date.parse(a.lastTime || ''));

        // Single-thread view
        if (this._activeConversationId) {
            const g = groupList.find(x => x.conversation_id === this._activeConversationId);
            if (g) return this._renderConversationThread(imp, g);
        }

        // Filter by participant
        const q = (this._convFilter || '').toLowerCase();
        const filtered = q
            ? groupList.filter(g => g.participants.some(p => (p || '').toLowerCase().includes(q)) || (g.title || '').toLowerCase().includes(q))
            : groupList;

        const total = filtered.length;
        const start = this._convPage * this._convPageSize;
        const pageGroups = filtered.slice(start, start + this._convPageSize);

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">💬 Conversations (${total.toLocaleString()})</h2>
                <div class="swp-toolbar">
                    <input type="text" placeholder="Filter by participant or title..." value="${this._esc(this._convFilter)}"
                        class="swp-input" oninput="window.snapchatWarrantUI._convFilter = this.value; window.snapchatWarrantUI._convPage = 0; window.snapchatWarrantUI.switchSection('conversations')">
                </div>
                <div class="swp-conv-list">
                    ${pageGroups.map(g => `
                        <div class="swp-conv-item" onclick="window.snapchatWarrantUI.openConversation('${this._escJs(g.conversation_id)}')">
                            <div class="swp-conv-icon">${g.isOneOnOne ? '👤' : '👥'}</div>
                            <div class="swp-conv-body">
                                <div class="swp-conv-top">
                                    <span class="swp-conv-title">${this._esc(g.title || g.participants.slice(0, 3).join(', ') || g.conversation_id)}</span>
                                    <span class="swp-conv-count">${g.count.toLocaleString()} msg</span>
                                </div>
                                <div class="swp-conv-participants">${g.participants.map(p => this._esc(p)).join(' · ')}</div>
                                <div class="swp-conv-last">${this._esc(g.lastTime || '')}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                ${this._renderPagination(total, this._convPage, this._convPageSize, 'conv')}
            </div>
        `;
    }

    _renderConversationThread(imp, g) {
        const sorted = [...g.messages].sort((a, b) => Date.parse(a.timestamp || '') - Date.parse(b.timestamp || ''));
        const media = imp.mediaFiles || {};
        const targetUser = imp.targetUsername || '';

        return `
            <div class="swp-section">
                <button class="swp-back-btn" onclick="window.snapchatWarrantUI.closeConversation()">← Back to Conversations</button>
                <h2 class="swp-section-title">${g.isOneOnOne ? '👤' : '👥'} ${this._esc(g.title || g.participants.join(', '))}</h2>
                <div class="swp-thread-meta">
                    <span class="swp-mono">${this._esc(g.conversation_id)}</span>
                    <span>${sorted.length.toLocaleString()} messages</span>
                    <span>${g.participants.length} participant(s)</span>
                </div>
                <div class="swp-thread-body">
                    ${sorted.map(m => this._renderMessage(m, media, targetUser)).join('')}
                </div>
            </div>
        `;
    }

    _renderMessage(m, media, targetUser) {
        const isFromTarget = m.sender_username === targetUser;
        const mediaFileName = m._mediaFile;
        const mediaInfo = mediaFileName ? media[mediaFileName] : null;
        const isVideo = mediaInfo?.mimeType?.startsWith('video/');

        const reactions = m.reactions ? this._formatReactions(m.reactions) : '';
        const flags = [];
        if (m.is_saved === 'true') flags.push('💾 Saved');
        if (m.screenshotted_by) flags.push('📸 Screenshotted');
        if (m.replayed_by) flags.push('↻ Replayed');
        if (m.screen_recorded_by) flags.push('🎥 Recorded');

        return `
            <div class="swp-message ${isFromTarget ? 'from-target' : 'from-other'} ${this.module.isFlagged('conversations', window.WarrantFlagsKey.snapchatMessage(m)) ? 'flagged' : ''}">
                <div class="swp-msg-header">
                    <span class="swp-msg-author">${this._esc(m.sender_username || '?')}</span>
                    ${m.recipient_username ? `<span class="swp-msg-arrow">→</span><span class="swp-msg-recipient">${this._esc(m.recipient_username)}</span>` : ''}
                    <span class="swp-msg-time">${this._esc(m.timestamp || '')}</span>
                    <span style="margin-left:auto">${this._flagBtn('conversations', window.WarrantFlagsKey.snapchatMessage(m))}</span>
                </div>
                <div class="swp-msg-meta">
                    <span class="swp-tag">${this._esc(m.content_type || m.message_type || '')}</span>
                    ${flags.map(f => `<span class="swp-tag-flag">${f}</span>`).join('')}
                </div>
                ${m.text ? `<div class="swp-msg-body">${this._esc(m.text)}</div>` : ''}
                ${mediaInfo ? `
                    <div class="swp-msg-attachment">
                        ${isVideo
                            ? `<video controls class="swp-msg-video swp-lazy-video" data-disk-path="${this._esc(mediaInfo.diskPath)}"></video>`
                            : `<img class="swp-msg-img swp-lazy-img" data-disk-path="${this._esc(mediaInfo.diskPath)}" loading="lazy">`}
                        <span class="swp-att-meta swp-mono">${this._esc(mediaFileName)}</span>
                    </div>
                ` : (m.media_id ? `<div class="swp-msg-media-missing">📎 Media referenced but file not found in production</div>` : '')}
                ${reactions ? `<div class="swp-msg-reactions">${reactions}</div>` : ''}
            </div>
        `;
    }

    _formatReactions(raw) {
        if (!raw) return '';
        const map = { 1: '❤️', 2: '😂', 3: '🔥', 4: '👍', 5: '😢', 6: '😮', 7: '👎' };
        // raw format: "{user_id}-{int};{user_id}-{int}"
        try {
            const items = String(raw).split(';').filter(Boolean);
            return items.map(item => {
                const m = item.match(/-([0-9]+)$/);
                const code = m ? parseInt(m[1], 10) : 0;
                return `<span class="swp-reaction">${map[code] || '·'}</span>`;
            }).join('');
        } catch (e) { return ''; }
    }

    openConversation(cid) {
        this._activeConversationId = cid;
        const content = document.getElementById('swp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            this._loadLazyImages(content);
        }
    }

    closeConversation() {
        this._activeConversationId = null;
        const content = document.getElementById('swp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            this._loadLazyImages(content);
        }
    }

    // ─── Media Gallery ──────────────────────────────────────────────────

    _renderMedia(imp) {
        const media = imp.mediaFiles || {};
        const all = Object.entries(media).map(([name, info]) => ({ name, ...info }));

        // Filter by type
        const filtered = all.filter(m => {
            if (this._mediaFilterType === 'image') return (m.mimeType || '').startsWith('image/');
            if (this._mediaFilterType === 'video') return (m.mimeType || '').startsWith('video/');
            return true;
        });
        // Sort by timestamp desc (timestamp comes from filename)
        filtered.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

        const total = filtered.length;
        const start = this._mediaPage * this._mediaPageSize;
        const pageItems = filtered.slice(start, start + this._mediaPageSize);

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">📷 Media (${total.toLocaleString()})</h2>
                <div class="swp-toolbar">
                    <div class="swp-filter-tabs">
                        ${['all', 'image', 'video'].map(t => `
                            <button class="swp-filter-tab ${this._mediaFilterType === t ? 'active' : ''}"
                                onclick="window.snapchatWarrantUI._mediaFilterType='${t}'; window.snapchatWarrantUI._mediaPage=0; window.snapchatWarrantUI.switchSection('media')">
                                ${t === 'all' ? 'All' : t === 'image' ? '🖼️ Images' : '🎬 Videos'}
                            </button>
                        `).join('')}
                    </div>
                </div>
                <div class="swp-media-grid">
                    ${pageItems.map(m => {
                        const isVideo = (m.mimeType || '').startsWith('video/');
                        return `
                            <div class="swp-media-card" onclick="window.snapchatWarrantUI.showMediaDetail('${this._escJs(m.name)}')">
                                ${isVideo
                                    ? `<div class="swp-media-video-thumb"><span class="swp-video-play-icon">▶</span><div class="swp-media-placeholder">🎬</div></div>`
                                    : `<img class="swp-media-thumb swp-lazy-img" data-disk-path="${this._esc(m.diskPath)}" loading="lazy">`}
                                <div class="swp-media-info">
                                    <div class="swp-media-time">${this._esc(this._formatSnapTimestamp(m.timestamp))}</div>
                                    <div class="swp-media-people">${this._esc(m.sender || '')} ${m.recipient ? '→ ' + this._esc(m.recipient) : ''}</div>
                                    ${m.savedFlag ? `<div class="swp-media-saved swp-tag-flag">${m.savedFlag === 'saved' ? '💾 saved' : '⏱ unsaved'}</div>` : ''}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                ${this._renderPagination(total, this._mediaPage, this._mediaPageSize, 'media')}
            </div>
        `;
    }

    showMediaDetail(fileName) {
        const imp = this.currentImport;
        if (!imp) return;
        const info = (imp.mediaFiles || {})[fileName];
        if (!info) return;
        const isVideo = (info.mimeType || '').startsWith('video/');

        const modal = document.createElement('div');
        modal.className = 'swp-lightbox';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.innerHTML = `
            <div class="swp-lightbox-content">
                <button class="swp-lightbox-close" onclick="this.closest('.swp-lightbox').remove()">✕</button>
                ${isVideo
                    ? `<video class="swp-lightbox-img swp-lazy-video" data-disk-path="${this._esc(info.diskPath)}" controls autoplay></video>`
                    : `<img class="swp-lightbox-img swp-lazy-img" data-disk-path="${this._esc(info.diskPath)}">`}
                <div class="swp-lightbox-details">
                    <h3 class="swp-mono">${this._esc(fileName)}</h3>
                    <div class="swp-kv-list">
                        ${this._kvRow('Sender', info.sender)}
                        ${this._kvRow('Recipient', info.recipient)}
                        ${this._kvRow('Captured', this._formatSnapTimestamp(info.timestamp))}
                        ${this._kvRow('Saved', info.savedFlag)}
                        ${this._kvRow('Type', info.mimeType)}
                        ${this._kvRow('Size', info.size ? `${(info.size / 1024 / 1024).toFixed(2)} MB` : null)}
                        ${this._kvRow('Part', info.partFolder)}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this._loadLazyImages(modal);
    }

    // ─── Memories ───────────────────────────────────────────────────────

    _renderMemories(imp) {
        const mems = imp.memories || [];
        if (mems.length === 0) return '<div class="swp-empty">No memories</div>';

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">⭐ Memory Snaps (${mems.length.toLocaleString()})</h2>
                <table class="swp-table">
                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            <th>Source</th>
                            <th>Lat / Lon</th>
                            <th>Duration</th>
                            <th>Encrypted</th>
                            <th>Media ID</th>
                            <th>Flag</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${mems.map(m => {
                            const k = window.WarrantFlagsKey.snapchatMemory(m);
                            return `
                            <tr class="${this.module.isFlagged('memories', k) ? 'swp-row-flagged' : ''}">
                                <td>${this._esc(m.timestamp || '')}</td>
                                <td><span class="swp-tag">${this._esc(m.source_type || '')}</span></td>
                                <td>${m.latitude && m.longitude ? `<span class="swp-mono">${this._esc(m.latitude)}, ${this._esc(m.longitude)}</span>` : ''}</td>
                                <td>${m.duration ? parseFloat(m.duration).toFixed(2) + 's' : ''}</td>
                                <td>${m.encrypted === 'true' ? '🔒' : ''}</td>
                                <td class="swp-mono">${this._esc((m.media_id || m.id || '').slice(0, 24))}</td>
                                <td>${this._flagBtn('memories', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Geo Map ────────────────────────────────────────────────────────

    _renderGeo(imp) {
        const geo = imp.geoLocations || [];
        if (geo.length === 0) return '<div class="swp-empty">No geo data</div>';

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">🗺️ Geo Locations (${geo.length.toLocaleString()})</h2>
                <div id="swp-geo-map" class="swp-geo-map"></div>
                <div class="swp-card">
                    <h3 class="swp-card-title">Recent Pings (latest 200)</h3>
                    <table class="swp-table">
                        <thead><tr><th>Timestamp</th><th>Latitude</th><th>Longitude</th><th>Accuracy (m)</th><th>Flag</th></tr></thead>
                        <tbody>
                            ${geo.slice(-200).reverse().map(g => {
                                const k = window.WarrantFlagsKey.snapchatGeo(g);
                                return `
                                <tr class="${this.module.isFlagged('geo', k) ? 'swp-row-flagged' : ''}">
                                    <td>${this._esc(g.timestamp || '')}</td>
                                    <td class="swp-mono">${g.latitude}</td>
                                    <td class="swp-mono">${g.longitude}</td>
                                    <td>${g.latitudeAccuracy != null ? '±' + g.latitudeAccuracy.toFixed(0) : ''}</td>
                                    <td>${this._flagBtn('geo', k)}</td>
                                </tr>
                            `;}).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    _initGeoMap() {
        const imp = this.currentImport;
        if (!imp || !imp.geoLocations || imp.geoLocations.length === 0) return;
        const mapEl = document.getElementById('swp-geo-map');
        if (!mapEl || typeof L === 'undefined') return;

        try {
            if (this._geoMap) { this._geoMap.remove(); this._geoMap = null; }

            const geo = imp.geoLocations;
            const first = geo[0];
            this._geoMap = L.map(mapEl).setView([first.latitude, first.longitude], 11);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 19
            }).addTo(this._geoMap);

            // Cap markers for performance
            const limit = Math.min(geo.length, 2000);
            const markerLayer = L.layerGroup();
            const bounds = [];
            const step = Math.max(1, Math.ceil(geo.length / limit));
            for (let i = 0; i < geo.length; i += step) {
                const g = geo[i];
                if (g.latitude == null || g.longitude == null) continue;
                const m = L.circleMarker([g.latitude, g.longitude], {
                    radius: 4, color: '#fffc00', weight: 1, fillColor: '#fffc00', fillOpacity: 0.6
                });
                m.bindPopup(`<strong>${this._esc(g.timestamp || '')}</strong><br>${g.latitude}, ${g.longitude}<br>±${g.latitudeAccuracy != null ? g.latitudeAccuracy.toFixed(0) + 'm' : '?'}`);
                markerLayer.addLayer(m);
                bounds.push([g.latitude, g.longitude]);
            }
            markerLayer.addTo(this._geoMap);
            if (bounds.length > 1) this._geoMap.fitBounds(bounds, { padding: [20, 20] });

            // Add a polyline to visualize movement
            if (bounds.length > 1) {
                L.polyline(bounds, { color: '#fffc00', weight: 1, opacity: 0.4 }).addTo(this._geoMap);
            }
        } catch (e) {
            console.error('Snapchat geo map init failed:', e);
        }
    }

    // ─── Devices ────────────────────────────────────────────────────────

    _renderDevices(imp) {
        const devs = imp.deviceAdvertisingIds || [];
        if (devs.length === 0) return '<div class="swp-empty">No device IDs</div>';

        // Pick stable headers from first row
        const sampleKeys = Object.keys(devs[0] || {});
        return `
            <div class="swp-section">
                <h2 class="swp-section-title">📱 Device Advertising IDs (${devs.length.toLocaleString()})</h2>
                <table class="swp-table">
                    <thead><tr>${sampleKeys.map(k => `<th>${this._esc(k)}</th>`).join('')}<th>Flag</th></tr></thead>
                    <tbody>
                        ${devs.map(d => {
                            const k = window.WarrantFlagsKey.snapchatDevice(d);
                            return `
                            <tr class="${this.module.isFlagged('devices', k) ? 'swp-row-flagged' : ''}">
                                ${sampleKeys.map(k2 => `<td class="${/id|device/i.test(k2) ? 'swp-mono' : ''}">${this._esc(d[k2] || '')}</td>`).join('')}
                                <td>${this._flagBtn('devices', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Logins ─────────────────────────────────────────────────────────

    _renderLogins(imp) {
        const logs = imp.loginHistory || [];
        if (logs.length === 0) return '<div class="swp-empty">No login history</div>';
        const cols = Object.keys(logs[0] || {});
        return `
            <div class="swp-section">
                <h2 class="swp-section-title">🌐 Login History (${logs.length.toLocaleString()})</h2>
                <table class="swp-table">
                    <thead><tr>${cols.map(c => `<th>${this._esc(c)}</th>`).join('')}<th>Flag</th></tr></thead>
                    <tbody>
                        ${logs.map(r => {
                            const k = window.WarrantFlagsKey.snapchatLogin(r);
                            return `
                            <tr class="${this.module.isFlagged('logins', k) ? 'swp-row-flagged' : ''}">
                                ${cols.map(c => {
                                    const v = r[c] || '';
                                    const isIp = /^ip$/i.test(c) || /ip_address/i.test(c);
                                    return `<td class="${isIp ? 'swp-mono' : ''}">${this._esc(v)}${isIp && v ? ` <button class="swp-arin-btn" onclick="swpArinLookup(this, '${this._escJs(v)}')" title="ARIN lookup">🔎</button>` : ''}</td>`;
                                }).join('')}
                                <td>${this._flagBtn('logins', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Friends ────────────────────────────────────────────────────────

    _renderFriends(imp) {
        const friends = imp.friends || [];
        if (friends.length === 0) return '<div class="swp-empty">No friends data</div>';
        const cols = Object.keys(friends[0] || {});
        return `
            <div class="swp-section">
                <h2 class="swp-section-title">👥 Friends (${friends.length.toLocaleString()})</h2>
                <table class="swp-table">
                    <thead><tr>${cols.map(c => `<th>${this._esc(c)}</th>`).join('')}<th>Flag</th></tr></thead>
                    <tbody>
                        ${friends.map(r => {
                            const k = window.WarrantFlagsKey.snapchatFriend(r);
                            return `
                            <tr class="${this.module.isFlagged('friends', k) ? 'swp-row-flagged' : ''}">
                                ${cols.map(c => `<td class="${/id|user_id/i.test(c) ? 'swp-mono' : ''}">${this._esc(r[c] || '')}</td>`).join('')}
                                <td>${this._flagBtn('friends', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Snap History ───────────────────────────────────────────────────

    _renderSnapHistory(imp) {
        const snaps = imp.snapHistory || [];
        if (snaps.length === 0) return '<div class="swp-empty">No snap history</div>';
        const cols = Object.keys(snaps[0] || {});
        return `
            <div class="swp-section">
                <h2 class="swp-section-title">👻 Snap History (${snaps.length.toLocaleString()})</h2>
                <table class="swp-table">
                    <thead><tr>${cols.map(c => `<th>${this._esc(c)}</th>`).join('')}<th>Flag</th></tr></thead>
                    <tbody>
                        ${snaps.map(r => {
                            const k = window.WarrantFlagsKey.snapchatSnap(r);
                            return `
                            <tr class="${this.module.isFlagged('snapHistory', k) ? 'swp-row-flagged' : ''}">
                                ${cols.map(c => `<td>${this._esc(r[c] || '')}</td>`).join('')}
                                <td>${this._flagBtn('snapHistory', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Other CSVs (generic fallback) ──────────────────────────────────

    _renderOtherCsvs(imp) {
        const others = imp.otherCsvs || {};
        const names = Object.keys(others);
        if (names.length === 0) return '<div class="swp-empty">No other data</div>';

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">📋 Other Data (${names.length} file${names.length !== 1 ? 's' : ''})</h2>
                ${names.map(name => {
                    const csv = others[name];
                    return `
                        <div class="swp-card">
                            <h3 class="swp-card-title">📄 ${this._esc(name)} <span class="swp-conv-count">${(csv.rows || []).length.toLocaleString()} rows</span></h3>
                            <div class="swp-table-wrapper">
                                <table class="swp-table">
                                    <thead><tr>${(csv.headers || []).map(h => `<th>${this._esc(h)}</th>`).join('')}</tr></thead>
                                    <tbody>
                                        ${(csv.rows || []).slice(0, 500).map(r => `<tr>${(csv.headers || []).map(h => `<td>${this._esc(r[h] || '')}</td>`).join('')}</tr>`).join('')}
                                    </tbody>
                                </table>
                                ${(csv.rows || []).length > 500 ? `<div class="swp-empty-hint">Showing first 500 of ${(csv.rows || []).length.toLocaleString()} rows.</div>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // ─── Timeline ───────────────────────────────────────────────────────

    _renderTimeline(imp) {
        const events = [];
        for (const m of imp.conversations) {
            if (m.timestamp) {
                events.push({
                    time: m.timestamp, type: 'message', icon: m.message_type === 'SNAP' ? '👻' : '💬',
                    desc: m.text || `${m.content_type || m.message_type || 'message'}`,
                    author: m.sender_username
                });
            }
        }
        for (const g of imp.geoLocations) {
            if (g.timestamp) {
                events.push({ time: g.timestamp, type: 'geo', icon: '🗺️', desc: `Geo: ${g.latitude}, ${g.longitude}` });
            }
        }
        for (const mm of imp.memories) {
            if (mm.timestamp) {
                events.push({ time: mm.timestamp, type: 'memory', icon: '⭐', desc: `Memory snap (${mm.duration || '?'}s)` });
            }
        }
        // Sort by parsed time
        events.sort((a, b) => Date.parse(a.time || '') - Date.parse(b.time || ''));

        // Cap rendering for performance
        const cap = 1000;
        const display = events.slice(-cap);

        if (display.length === 0) return '<div class="swp-empty">No timeline events</div>';

        return `
            <div class="swp-section">
                <h2 class="swp-section-title">🕐 Timeline (showing last ${display.length.toLocaleString()} of ${events.length.toLocaleString()})</h2>
                <div class="swp-timeline">
                    ${display.map(ev => `
                        <div class="swp-timeline-event swp-event-${ev.type}">
                            <div class="swp-timeline-dot">${ev.icon}</div>
                            <div class="swp-timeline-content">
                                <div class="swp-timeline-time">${this._esc(ev.time)}</div>
                                <div class="swp-timeline-desc">${this._esc((ev.desc || '').slice(0, 200))}</div>
                                ${ev.author ? `<div class="swp-timeline-author">${this._esc(ev.author)}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // ─── Pagination ─────────────────────────────────────────────────────

    _renderPagination(total, page, pageSize, kind) {
        if (total <= pageSize) return '';
        const totalPages = Math.ceil(total / pageSize);
        const stateField = kind === 'conv' ? '_convPage' : '_mediaPage';
        const prevDisabled = page <= 0;
        const nextDisabled = page >= totalPages - 1;
        return `
            <div class="swp-pagination">
                <button class="swp-btn-sm" ${prevDisabled ? 'disabled' : ''}
                    onclick="window.snapchatWarrantUI.${stateField} = Math.max(0, window.snapchatWarrantUI.${stateField} - 1); window.snapchatWarrantUI.switchSection(window.snapchatWarrantUI.activeSection)">← Prev</button>
                <span class="swp-page-label">Page ${page + 1} of ${totalPages}</span>
                <button class="swp-btn-sm" ${nextDisabled ? 'disabled' : ''}
                    onclick="window.snapchatWarrantUI.${stateField} = Math.min(${totalPages - 1}, window.snapchatWarrantUI.${stateField} + 1); window.snapchatWarrantUI.switchSection(window.snapchatWarrantUI.activeSection)">Next →</button>
            </div>
        `;
    }

    // ─── Empty State ────────────────────────────────────────────────────

    _renderEmptyState() {
        return `
            <div class="swp-empty-state">
                <div class="swp-empty-icon">👻</div>
                <h3 class="swp-empty-title">Snapchat Warrant Parser</h3>
                <p class="swp-empty-desc">Import Snapchat warrant return ZIP archives or unzipped folders to parse conversations, media, geo locations, memories, and account data.</p>
                <div class="swp-empty-actions">
                    <button class="swp-btn-primary" onclick="window.snapchatWarrantUI.handleFilePicker()">
                        📂 Select ZIP or Folder
                    </button>
                </div>
                <p class="swp-empty-hint">ZIP files or folders placed in <strong>Evidence/</strong> or <strong>Warrants/Production/</strong> are auto-detected.</p>
            </div>
            <div id="swp-evidence-bar"></div>
        `;
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _kvRow(label, value) {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="swp-kv-row"><span class="swp-kv-label">${this._esc(label)}</span><span class="swp-kv-value">${this._esc(String(value))}</span></div>`;
    }

    _statBadge(label, count, icon) {
        return `<div class="swp-stat ${count > 0 ? 'has-data' : ''}"><span class="swp-stat-icon">${icon}</span><span class="swp-stat-count">${(count || 0).toLocaleString()}</span><span class="swp-stat-label">${label}</span></div>`;
    }

    _formatSnapTimestamp(ts) {
        if (!ts) return '';
        // Filename format: "2022-08-01-20-57-47UTC"
        const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})UTC/);
        if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
        return ts;
    }

    _esc(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escJs(str) {
        return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    _showLoading(text) {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="swp-loading">
                <div class="swp-spinner"></div>
                <p>${this._esc(text)}</p>
            </div>
        `;
    }

    _toast(msg, type) {
        if (typeof viperToast === 'function') {
            viperToast(msg, type);
        } else {
            console.log(`[${type}] ${msg}`);
        }
    }

    /**
     * Lazy-load disk-path images & videos via IPC.
     */
    async _loadLazyImages(container) {
        const root = container || document;
        const imgs = root.querySelectorAll('.swp-lazy-img[data-disk-path]');
        for (const img of imgs) {
            const diskPath = img.dataset.diskPath;
            if (!diskPath) continue;
            if (this._mediaCache[diskPath]) {
                img.src = this._mediaCache[diskPath];
                img.classList.remove('swp-lazy-img');
                continue;
            }
            try {
                const result = await this.module.readMedia(diskPath);
                if (result) {
                    const dataUrl = `data:${result.mimeType};base64,${result.data}`;
                    this._mediaCache[diskPath] = dataUrl;
                    img.src = dataUrl;
                    img.classList.remove('swp-lazy-img');
                }
            } catch (e) { /* ignore */ }
        }
        const videos = root.querySelectorAll('.swp-lazy-video[data-disk-path]');
        for (const vid of videos) {
            const diskPath = vid.dataset.diskPath;
            if (!diskPath) continue;
            if (this._mediaCache[diskPath]) {
                vid.src = this._mediaCache[diskPath];
                vid.classList.remove('swp-lazy-video');
                continue;
            }
            try {
                const result = await this.module.readMedia(diskPath);
                if (result) {
                    const dataUrl = `data:${result.mimeType};base64,${result.data}`;
                    this._mediaCache[diskPath] = dataUrl;
                    vid.src = dataUrl;
                    vid.classList.remove('swp-lazy-video');
                }
            } catch (e) { /* ignore */ }
        }
    }
}

// Global ARIN lookup for Snapchat warrant IPs
async function swpArinLookup(btn, ip) {
    if (!ip || !window.electronAPI?.arinLookup) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
        const result = await window.electronAPI.arinLookup(ip);
        if (result.success) {
            const info = [result.provider || result.organization];
            if (result.network) info.push(result.network);
            if (result.netRange) info.push(result.netRange);
            const span = btn.nextElementSibling?.classList?.contains('swp-arin-result')
                ? btn.nextElementSibling
                : document.createElement('span');
            span.className = 'swp-arin-result swp-arin-success';
            span.textContent = info.join(' · ');
            span.title = info.join('\n');
            if (!btn.nextElementSibling?.classList?.contains('swp-arin-result')) btn.parentNode.appendChild(span);
            btn.textContent = '✓';
            btn.classList.add('swp-arin-done');
        } else {
            btn.textContent = '✗';
            btn.title = result.error || 'Lookup failed';
            btn.classList.add('swp-arin-fail');
        }
    } catch (e) {
        btn.textContent = '✗';
        btn.title = e.message;
        btn.classList.add('swp-arin-fail');
    }
    btn.disabled = false;
}
window.swpArinLookup = swpArinLookup;
