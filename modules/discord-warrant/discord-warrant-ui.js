/**
 * Discord Warrant Parser — UI
 * Renders parsed Discord Data Package sections in the case-detail tab.
 * Sections: Account Overview, Messages, Servers, IP Activity, Devices, Activity Timeline, Billing
 */

class DiscordWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
        this._mediaCache = {};
        this._activeChannelId = null;
        this._msgPage = 0;
        this._msgPageSize = 100;
        this._msgQuery = '';
        this._channelQuery = '';
        this._threadCache = null;
        this._threadCacheKey = null;
        // Returns are UTC.  Default to showing them that way.
        this._tz = 'utc';
        this._eventTypeFilter = 'all';
        this._activityPage = 0;
        this._activityPageSize = 100;
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
            <div class="dwp-layout">
                <div class="dwp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderFlagToolbar()}
                    ${this._renderNav()}
                </div>
                <div class="dwp-content" id="dwp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="dwp-evidence-bar"></div>
        `;
        this._loadLazyImages();
    }

    // ─── Flag-to-Evidence toolbar (sidebar) ────────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        const enabled = total > 0;
        return `
            <div class="dwp-flag-toolbar">
                <button class="dwp-flag-header-btn"
                        title="Flagged item count — click to clear all flags">
                    🚩 Flags
                    <span class="dwp-flag-count-pill" id="dwp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="dwp-flag-toolbar-spacer"></div>
                <button class="dwp-push-btn" id="dwp-push-btn"
                        ${enabled ? '' : 'disabled'}
                        onclick="window.discordWarrantUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('dwp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('dwp-push-btn');
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

        const btn = document.getElementById('dwp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                // Clear flags after a successful push (mirrors Datapilot UX)
                this.module.clearFlags();
                this._refreshFlagToolbar();
                const content = document.getElementById('dwp-content-area');
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

    _toast(msg, type) {
        try {
            if (typeof window.showToast === 'function') { window.showToast(msg, type || 'info'); return; }
        } catch (_) {}
        console.log(`[DiscordWarrant ${type || 'info'}] ${msg}`);
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        // Re-render the current section to update flag-button state on the visible row
        const content = document.getElementById('dwp-content-area');
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
        return `<button class="dwp-flag-btn ${on ? 'on' : ''}"
                        title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                        onclick="event.stopPropagation(); window.discordWarrantUI._onFlagClick('${section}', '${safeKey}')">
                  🚩${label ? '<span style="margin-left:2px">' + label + '</span>' : ''}
                </button>`;
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('dwp-evidence-bar');
        if (!bar) return;
        if (!files || files.length === 0) { bar.innerHTML = ''; return; }
        bar.innerHTML = `
            <div class="dwp-evidence-bar">
                <div class="dwp-evidence-label">
                    <span style="margin-right:6px">💬</span>
                    Detected Discord Warrant Files:
                </div>
                ${files.map(f => `
                    <button class="dwp-evidence-file ${f.alreadyImported ? 'imported' : ''}"
                            onclick="window.discordWarrantUI.handleEvidenceClick('${this._escJs(f.path)}', '${this._escJs(f.name)}', ${f.isFolder ? 'true' : 'false'})"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="dwp-evidence-icon">${f.alreadyImported ? '✅' : (f.isFolder ? '📁' : '📦')}</span>
                        <span class="dwp-evidence-name">${this._esc(f.name)}</span>
                        ${f.size ? `<span class="dwp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>` : ''}
                    </button>
                `).join('')}
            </div>
        `;
    }

    async handleEvidenceClick(filePath, fileName, isFolder) {
        try {
            this._showLoading('Importing Discord Data Package… (large packages may take a minute)');
            const record = await this.module.importWarrant(filePath, fileName, isFolder);
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountUsername || fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    async handleFilePicker() {
        try {
            this._showLoading('Importing Discord Data Package…');
            const record = await this.module.importFromPicker();
            if (!record) { this.render(); return; }
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountUsername || record.fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    switchSection(section) {
        this.activeSection = section;
        this._activeChannelId = null;
        this._msgPage = 0;
        this._activityPage = 0;
        const content = document.getElementById('dwp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            this._loadLazyImages(content);
        }
        document.querySelectorAll('.dwp-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.section === section);
        });
    }

    switchImport(idx) {
        this.activeImportIdx = idx;
        this.activeSection = 'overview';
        this._activeChannelId = null;
        this.render();
    }

    deleteCurrentImport() {
        const imp = this.currentImport;
        if (!imp) return;
        if (!confirm(`Delete Discord import "${imp.fileName}"?`)) return;
        this.module.deleteImport(imp.id);
        this.activeImportIdx = 0;
        this.activeSection = 'overview';
        this.render();
    }

    // ─── Empty State ────────────────────────────────────────────────────

    _renderEmptyState() {
        return `
            <div class="dwp-empty">
                <div class="dwp-empty-icon">💬</div>
                <h3>Discord Warrant Parser</h3>
                <p>
                    Parse Discord Data Package warrant returns. Discord serves warrant returns as
                    Data Packages — the same format as a user's "Request All My Data" export.
                </p>
                <p class="dwp-empty-hint">
                    Place the warrant return ZIP (or unzipped folder) in this case's
                    <code>Evidence/</code> or <code>Warrants/Production/</code> directory and it will
                    be auto-detected. Or import manually:
                </p>
                <button class="dwp-btn-primary" onclick="window.discordWarrantUI.handleFilePicker()">
                    📦 Import Discord Warrant
                </button>
            </div>
        `;
    }

    // ─── Sidebar ────────────────────────────────────────────────────────

    _renderImportSelector() {
        if (this.module.imports.length <= 1) return '';
        return `
            <div class="dwp-import-selector">
                <label class="dwp-label">Import:</label>
                <select onchange="window.discordWarrantUI.switchImport(parseInt(this.value))" class="dwp-select">
                    ${this.module.imports.map((imp, i) => `
                        <option value="${i}" ${i === this.activeImportIdx ? 'selected' : ''}>
                            ${this._esc(imp.accountUsername || imp.fileName)}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;
    }

    _renderNav() {
        const imp = this.currentImport;
        if (!imp || !imp.data) return '';
        const d = imp.data;

        const sections = [
            { id: 'overview',  label: 'Account Overview', icon: '👤', show: true },
            { id: 'messages',  label: 'Messages',         icon: '💬', count: d.stats?.messageCount || 0, show: (d.channels || []).length > 0 },
            { id: 'servers',   label: 'Servers / Guilds', icon: '🏛️', count: (d.servers || []).length, show: (d.servers || []).length > 0 },
            { id: 'ip',        label: 'IP Activity',      icon: '🌐', count: (d.ipActivity || []).length, show: (d.ipActivity || []).length > 0 },
            { id: 'devices',   label: 'Devices',          icon: '📱', count: (d.devices || []).length, show: (d.devices || []).length > 0 },
            { id: 'activity',  label: 'Activity Events',  icon: '📊', count: d.activity?.totalEventCount || 0, show: (d.activity?.totalEventCount || 0) > 0 },
            { id: 'billing',   label: 'Billing & DSAR',   icon: '💳', show: true }
        ];

        return `
            <nav class="dwp-nav">
                ${sections.filter(s => s.show).map(s => `
                    <button class="dwp-nav-item ${s.id === this.activeSection ? 'active' : ''}"
                            data-section="${s.id}"
                            onclick="window.discordWarrantUI.switchSection('${s.id}')">
                        <span class="dwp-nav-icon">${s.icon}</span>
                        <span class="dwp-nav-label">${s.label}</span>
                        ${s.count ? `<span class="dwp-nav-count">${s.count.toLocaleString()}</span>` : ''}
                    </button>
                `).join('')}
            </nav>
            <div class="dwp-nav-actions">
                <button class="dwp-btn-sm" onclick="window.discordWarrantUI.handleFilePicker()">+ Import</button>
                <button class="dwp-btn-sm danger" onclick="window.discordWarrantUI.deleteCurrentImport()">🗑️ Delete</button>
            </div>
        `;
    }

    // ─── Section Dispatcher ─────────────────────────────────────────────

    _renderSection() {
        const imp = this.currentImport;
        if (!imp || !imp.data) return '<div class="dwp-empty-section">No data.</div>';
        switch (this.activeSection) {
            case 'overview':  return this._renderOverview(imp.data);
            case 'messages':  return this._renderMessages(imp.data);
            case 'servers':   return this._renderServers(imp.data);
            case 'ip':        return this._renderIp(imp.data);
            case 'devices':   return this._renderDevices(imp.data);
            case 'activity':  return this._renderActivity(imp.data);
            case 'billing':   return this._renderBilling(imp.data);
            default: return '<div class="dwp-empty-section">Section not found.</div>';
        }
    }

    // ─── Overview ───────────────────────────────────────────────────────

    _renderOverview(d) {
        const sub = d.subscriber || {};
        const stats = d.stats || {};
        const avatarHtml = d.avatarFile?.diskPath
            ? `<img class="dwp-lazy-img dwp-avatar" data-disk-path="${this._esc(d.avatarFile.diskPath)}" alt="Avatar">`
            : `<div class="dwp-avatar-placeholder">${(sub.username || '?').slice(0, 1).toUpperCase()}</div>`;

        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">👤 Account Overview</h2>
                ${this._renderDiagnostics(d)}

                <div class="dwp-overview-grid">
                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Subscriber</h3>
                        <div class="dwp-subscriber-row">
                            ${avatarHtml}
                            <div class="dwp-subscriber-meta">
                                <div class="dwp-subscriber-name">${this._esc(sub.global_name || sub.username || 'Unknown')}</div>
                                <div class="dwp-subscriber-handle">@${this._esc(sub.username || '?')}${sub.discriminator ? '#' + this._esc(sub.discriminator) : ''}</div>
                                <div class="dwp-subscriber-id">User ID: <code>${this._esc(sub.id || 'N/A')}</code></div>
                            </div>
                        </div>
                        <div class="dwp-kv-list">
                            ${this._kv('Email', sub.email)}
                            ${this._kv('Phone', sub.phone)}
                            ${this._kv('Last Known IP', sub.ip)}
                            ${this._kv('Verified', sub.verified ? 'Yes' : 'No')}
                            ${this._kv('Has Mobile', sub.has_mobile ? 'Yes' : 'No')}
                            ${this._kv('Premium Until', sub.premium_until || 'Never')}
                            ${this._kv('Avatar Hash', sub.avatar_hash, true)}
                            ${sub.flags && sub.flags.length ? this._kv('Account Flags', sub.flags.join(', ')) : ''}
                        </div>
                    </div>

                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Statistics</h3>
                        <div class="dwp-stats-grid">
                            ${this._stat('Messages', stats.messageCount)}
                            ${this._stat('Channels', stats.channelCount)}
                            ${this._stat('Servers', stats.serverCount)}
                            ${this._stat('Sessions', stats.sessionCount)}
                            ${this._stat('Unique IPs', stats.ipCount)}
                            ${this._stat('Devices', stats.deviceCount)}
                            ${this._stat('Activity Events', stats.eventCount)}
                            ${this._stat('Media Files', stats.mediaCount)}
                        </div>
                    </div>
                </div>

                <div class="dwp-card dwp-mt">
                    <h3 class="dwp-card-title">Active Sessions <span class="dwp-pill">${(sub.sessions || []).length}</span></h3>
                    ${(sub.sessions || []).length === 0
                        ? '<div class="dwp-empty-section">No session data.</div>'
                        : `<table class="dwp-table">
                            <thead><tr>
                                <th>IP</th><th>OS</th><th>Platform</th>
                                <th>Created</th><th>Last Used</th><th>Expires</th>
                                <th>MFA</th><th>Token</th>
                            </tr></thead>
                            <tbody>
                                ${sub.sessions.map(s => `
                                    <tr>
                                        <td><code>${this._esc(s.ip || '—')}</code></td>
                                        <td>${this._esc(s.os || '—')}</td>
                                        <td>${this._esc(s.platform || '—')}</td>
                                        <td>${this._fmtDate(s.creation_time)}</td>
                                        <td>${this._fmtDate(s.last_used)}</td>
                                        <td>${this._fmtDate(s.expiration_time)}</td>
                                        <td>${s.is_mfa ? '✅' : '—'}</td>
                                        <td><code class="dwp-trunc">${this._esc(s.binding_token || '—')}</code></td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>`}
                </div>

                ${(sub.connections || []).length ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">External Connections <span class="dwp-pill">${sub.connections.length}</span></h3>
                        <table class="dwp-table">
                            <thead><tr><th>Type</th><th>ID</th><th>Name</th><th>Verified</th><th>Friend Sync</th><th>Revoked</th></tr></thead>
                            <tbody>
                                ${sub.connections.map(c => `
                                    <tr>
                                        <td>${this._esc(c.type || '—')}</td>
                                        <td><code>${this._esc(c.id || '—')}</code></td>
                                        <td>${this._esc(c.name || '—')}</td>
                                        <td>${c.verified ? '✅' : '—'}</td>
                                        <td>${c.friend_sync ? '✅' : '—'}</td>
                                        <td>${c.revoked ? '🚫' : '—'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                ` : ''}

                ${d.recentAvatarFiles && d.recentAvatarFiles.length ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">Avatar History <span class="dwp-pill">${d.recentAvatarFiles.length}</span></h3>
                        <div class="dwp-avatar-history">
                            ${d.recentAvatarFiles.map(av => `
                                <img class="dwp-lazy-img dwp-avatar-thumb"
                                     data-disk-path="${this._esc(av.diskPath)}"
                                     alt="Recent avatar"
                                     title="${this._esc(av.original)}">
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Messages ───────────────────────────────────────────────────────

    _renderMessages(d) {
        const all = (d.channels || []).slice();

        if (this._activeChannelId) {
            const ch = all.find(c => c.channelId === this._activeChannelId);
            if (ch) return this._renderChannelDetail(ch, d);
        }

        const q = (this._channelQuery || '').trim().toLowerCase();
        const channels = (q
            ? all.filter(c =>
                String(c.channelName || '').toLowerCase().includes(q) ||
                String(c.guildName || '').toLowerCase().includes(q) ||
                String(c.channelId || '').includes(q) ||
                (c.participants || []).some(p => String(p.username || '').toLowerCase().includes(q)))
            : all
        ).sort((a, b) => b.messageCount - a.messageCount);

        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">💬 Messages</h2>
                <p class="dwp-section-sub">${all.length} channel${all.length === 1 ? '' : 's'} · ${(d.stats?.messageCount || 0).toLocaleString()} message${d.stats?.messageCount === 1 ? '' : 's'}${q ? ` · showing ${channels.length} match${channels.length === 1 ? '' : 'es'}` : ''}</p>

                <div class="dwp-chan-search">
                    <input type="search" id="dwp-chan-q" class="dwp-input" placeholder="Filter channels by name, server, participant or ID…"
                           value="${this._esc(this._channelQuery || '')}"
                           oninput="window.discordWarrantUI._onChannelQuery(this.value)">
                </div>

                <div class="dwp-channel-list">
                    ${channels.length === 0 ? '<div class="dwp-empty-section">No channels match that filter.</div>' : channels.map(ch => {
                        const label = ch.channelName || ch.indexLabel || ch.channelId;
                        const people = (ch.participants || []).filter(p => !p.isSubscriber)
                            .slice(0, 3).map(p => p.username || p.id).filter(Boolean);
                        const range = (ch.firstMessage || ch.lastMessage)
                            ? `${this._fmtDay(ch.firstMessage)} – ${this._fmtDay(ch.lastMessage)}` : '';
                        return `
                        <button class="dwp-channel-row" onclick="window.discordWarrantUI._openChannel('${this._escJs(ch.channelId)}')">
                            <div class="dwp-channel-icon">${this._channelIcon(ch.channelType)}</div>
                            <div class="dwp-channel-info">
                                <div class="dwp-channel-name">${this._esc(label)}</div>
                                ${ch.guildName ? `<div class="dwp-channel-guild">in ${this._esc(ch.guildName)}</div>`
                                              : (people.length && people.join(', ') !== label
                                                    ? `<div class="dwp-channel-guild">${this._esc(people.join(', '))}</div>` : '')}
                                <div class="dwp-channel-id">
                                    <code>${this._esc(ch.channelId)}</code>
                                    ${ch.channelType ? `<span class="dwp-chip">${this._esc(ch.channelType)}</span>` : ''}
                                    ${ch.bucket && ch.bucket !== 'dms' && ch.bucket !== 'servers' ? `<span class="dwp-chip warn">${this._esc(ch.bucket)}</span>` : ''}
                                    ${range ? `<span class="dwp-chan-range">${this._esc(range)}</span>` : ''}
                                </div>
                            </div>
                            <div class="dwp-channel-count">${ch.messageCount.toLocaleString()}</div>
                        </button>
                    `;}).join('')}
                </div>
            </div>
        `;
    }

    _onChannelQuery(v) {
        this._channelQuery = v;
        const content = document.getElementById('dwp-content-area');
        if (!content) return;
        content.innerHTML = this._renderSection();
        const box = document.getElementById('dwp-chan-q');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }

    _openChannel(channelId) {
        this._activeChannelId = channelId;
        this._msgQuery = '';
        this._threadCacheKey = null;
        // A thread reads like a conversation, so open at the END — the most
        // recent traffic — the way any chat client does.
        this._msgPage = Number.MAX_SAFE_INTEGER;
        this._repaintThread('bottom');
    }

    _backToChannels() {
        this._activeChannelId = null;
        this._threadCacheKey = null;
        const content = document.getElementById('dwp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            if (typeof this._loadLazyImages === 'function') this._loadLazyImages(content);
        }
    }

    // ─── Conversation thread ────────────────────────────────────────────

    /**
     * Chronologically-ordered (and optionally filtered) message list for a
     * channel.  Returns arrive in file order, which is NOT guaranteed to be
     * chronological, and one channel in the reference return holds 205k rows —
     * so the sorted/filtered list is memoised per (channel, query).
     */
    _threadMessages(ch) {
        const key = `${ch.channelId}|${this._msgQuery || ''}`;
        if (this._threadCacheKey === key && this._threadCache) return this._threadCache;

        let list = (ch.messages || []).slice();
        list.sort((a, b) => {
            const at = a.timestamp || '', bt = b.timestamp || '';
            if (at !== bt) return at < bt ? -1 : 1;
            const ai = String(a.id || ''), bi = String(b.id || '');
            return ai === bi ? 0 : (ai.length !== bi.length ? ai.length - bi.length : (ai < bi ? -1 : 1));
        });

        const q = (this._msgQuery || '').trim().toLowerCase();
        if (q) {
            list = list.filter(m =>
                String(m.contents || '').toLowerCase().includes(q) ||
                String(m.username || '').toLowerCase().includes(q) ||
                String(m.id || '').includes(q) ||
                String(m.authorId || '').includes(q));
        }

        this._threadCacheKey = key;
        this._threadCache = list;
        return list;
    }

    _onMsgQuery(v) {
        this._msgQuery = v;
        this._threadCacheKey = null;
        this._msgPage = 0;
        this._repaintThread(null);
        const box = document.getElementById('dwp-msg-q');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }

    _gotoPage(n) {
        this._msgPage = n;
        this._repaintThread('top');
    }

    /**
     * Repaint the thread and place the viewport sensibly.  `.dwp-chat` is not
     * itself a scroll container — the section scrolls — so scrolling has to be
     * driven from `#dwp-content-area`.
     */
    _repaintThread(where) {
        const content = document.getElementById('dwp-content-area');
        if (!content) return;
        content.innerHTML = this._renderSection();
        if (typeof this._loadLazyImages === 'function') this._loadLazyImages(content);
        if (where === 'bottom') content.scrollTop = content.scrollHeight;
        else if (where === 'top') content.scrollTop = 0;
    }

    _renderChannelDetail(ch, d) {
        const msgs = this._threadMessages(ch);
        const total = msgs.length;
        const pageCount = Math.max(1, Math.ceil(total / this._msgPageSize));
        const page = Math.min(Math.max(0, this._msgPage), pageCount - 1);
        this._msgPage = page;

        const start = page * this._msgPageSize;
        const end = Math.min(start + this._msgPageSize, total);
        const slice = msgs.slice(start, end);

        const sub = (d && d.subscriber) || {};
        const selfLabel = sub.username || sub.global_name || 'Account holder';
        const people = (ch.participants || []).filter(p => !p.isSubscriber);

        return `
            <div class="dwp-section dwp-thread-section">
                <button class="dwp-back-btn" onclick="window.discordWarrantUI._backToChannels()">← Back to channels</button>

                <div class="dwp-thread-head">
                    <div class="dwp-thread-title">
                        <span class="dwp-thread-icon">${this._channelIcon(ch.channelType)}</span>
                        <span>${this._esc(ch.channelName || ch.channelId)}</span>
                    </div>
                    <div class="dwp-thread-meta">
                        ${ch.guildName ? `<span class="dwp-chip">${this._esc(ch.guildName)}</span>` : ''}
                        ${ch.channelType ? `<span class="dwp-chip">${this._esc(ch.channelType)}</span>` : ''}
                        <span class="dwp-chip mono">${this._esc(ch.channelId)}</span>
                        <span>${(ch.messageCount || 0).toLocaleString()} messages</span>
                        ${ch.firstMessage ? `<span>${this._esc(this._fmtDay(ch.firstMessage))} – ${this._esc(this._fmtDay(ch.lastMessage))}</span>` : ''}
                    </div>
                    ${people.length ? `<div class="dwp-thread-people">
                        ${people.slice(0, 12).map(p => `<span class="dwp-person" style="--dwp-av:${this._authorHue(p.username || p.id)}">
                            <span class="dwp-person-dot"></span>${this._esc(p.username || p.id)}<span class="dwp-person-n">${(p.count || 0).toLocaleString()}</span>
                        </span>`).join('')}
                        ${people.length > 12 ? `<span class="dwp-person">+${people.length - 12} more</span>` : ''}
                    </div>` : ''}
                </div>

                <div class="dwp-thread-toolbar">
                    <input type="search" id="dwp-msg-q" class="dwp-input" placeholder="Search this conversation…"
                           value="${this._esc(this._msgQuery || '')}"
                           oninput="window.discordWarrantUI._onMsgQuery(this.value)">
                    ${this._msgQuery ? `<span class="dwp-thread-hits">${total.toLocaleString()} match${total === 1 ? '' : 'es'}</span>` : ''}
                    <button class="dwp-btn-sm dwp-tz-btn" onclick="window.discordWarrantUI._toggleTz()"
                            title="Discord states return timestamps in UTC. Switch the transcript between UTC and this machine's local time.">
                        🕓 ${this._tz === 'local' ? 'Local time' : 'UTC'}
                    </button>
                </div>

                <div class="dwp-chat" id="dwp-chat-scroll">
                    ${slice.length === 0
                        ? `<div class="dwp-empty-section">${this._msgQuery ? 'No messages match that search.' : 'No messages in this channel.'}</div>`
                        : this._renderBubbles(slice, selfLabel)}
                </div>

                ${pageCount > 1 ? `
                    <div class="dwp-pager">
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._gotoPage(0)" ${page === 0 ? 'disabled' : ''} title="Oldest">⏮</button>
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._gotoPage(${page - 1})" ${page === 0 ? 'disabled' : ''}>← Older</button>
                        <span>${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</span>
                        <input class="dwp-page-input" type="number" min="1" max="${pageCount}" value="${page + 1}"
                               onchange="window.discordWarrantUI._gotoPage(Math.max(0, Math.min(${pageCount - 1}, (parseInt(this.value,10)||1) - 1)))">
                        <span class="dwp-muted">/ ${pageCount.toLocaleString()}</span>
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._gotoPage(${page + 1})" ${page >= pageCount - 1 ? 'disabled' : ''}>Newer →</button>
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._gotoPage(${pageCount - 1})" ${page >= pageCount - 1 ? 'disabled' : ''} title="Newest">⏭</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Render a page of messages as a chat transcript.
     *
     * Grouping rules mirror a real chat client: consecutive messages from the
     * same author inside 5 minutes collapse into one block, and a date divider
     * is emitted whenever the calendar day changes.  `direction` is set by the
     * LE-return parser (which knows the author of every row); a Discord data
     * package has no per-row author — every message in it belongs to the
     * account holder — so an absent direction is treated as outgoing.
     */
    _renderBubbles(slice, selfLabel) {
        const GROUP_MS = 5 * 60 * 1000;
        let out = '';
        let prevDay = null;
        let prevKey = null;
        let prevTime = 0;

        for (const m of slice) {
            const outgoing = (m.direction || 'outgoing') === 'outgoing';
            const author = m.username || (outgoing ? selfLabel : (m.authorId || 'Unknown'));
            const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
            const day = m.timestamp ? this._fmtDay(m.timestamp) : 'Undated';

            if (day !== prevDay) {
                out += `<div class="dwp-chat-day"><span>${this._esc(day)}</span></div>`;
                prevDay = day;
                prevKey = null;
            }

            const key = `${outgoing ? 'S' : 'R'}|${author}`;
            const grouped = key === prevKey && !isNaN(t) && !isNaN(prevTime) && (t - prevTime) < GROUP_MS;
            prevKey = key;
            prevTime = isNaN(t) ? prevTime : t;

            const flagged = this.module.isFlagged('messages', m.id);
            const hasText = String(m.contents || '').trim() !== '';
            const media = Array.isArray(m.media) ? m.media : [];

            out += `
                <div class="dwp-bubble-row ${outgoing ? 'out' : 'in'}${grouped ? ' grouped' : ''}${flagged ? ' flagged' : ''}"
                     style="--dwp-av:${this._authorHue(author)}">
                    <div class="dwp-bubble-avatar" title="${this._esc(author)}">${grouped ? '' : this._esc(this._initials(author))}</div>
                    <div class="dwp-bubble-col">
                        ${grouped ? '' : `
                            <div class="dwp-bubble-who">
                                <span class="dwp-bubble-author">${this._esc(author)}</span>
                                ${outgoing ? '<span class="dwp-bubble-self">account holder</span>' : ''}
                                <span class="dwp-bubble-time">${this._esc(this._fmtTime(m.timestamp))}</span>
                            </div>`}
                        <div class="dwp-bubble">
                            ${hasText
                                ? `<div class="dwp-bubble-text">${this._highlight(m.contents)}</div>`
                                : (media.length || m.attachments ? '' : '<div class="dwp-bubble-text dwp-muted"><em>(no text)</em></div>')}
                            ${media.length ? `<div class="dwp-bubble-media">${this._renderLocalMedia(media)}</div>` : ''}
                            ${m.attachments ? `<div class="dwp-bubble-attach">${this._renderAttachments(m.attachments)}</div>` : ''}
                            <div class="dwp-bubble-foot">
                                <span class="dwp-bubble-stamp" title="${this._esc(m.timestamp || m.rawTimestamp || '')}">${this._esc(this._fmtTime(m.timestamp))}</span>
                                ${m.id ? `<code class="dwp-bubble-id">${this._esc(String(m.id))}</code>` : ''}
                                <span class="dwp-bubble-flag">${this._flagBtn('messages', m.id)}</span>
                            </div>
                        </div>
                    </div>
                </div>`;
        }
        return out;
    }

    /** Attachments extracted to disk from the return, rendered from the case folder. */
    _renderLocalMedia(media) {
        return media.map(rec => {
            const name = rec.fileName || (rec.original || '').split('/').pop() || 'attachment';
            const mime = String(rec.mimeType || '');
            const kb = rec.size ? `${(rec.size / 1024).toFixed(0)} KB` : '';
            if (mime.startsWith('image/')) {
                return `<div class="dwp-att dwp-att-img">
                    <img class="dwp-lazy-img" data-disk-path="${this._esc(rec.diskPath)}" alt="${this._esc(name)}">
                    <div class="dwp-att-caption">🖼️ ${this._esc(name)} <span class="dwp-muted">${this._esc(kb)}</span></div>
                </div>`;
            }
            const icon = mime.startsWith('video/') ? '🎬' : mime.startsWith('audio/') ? '🔊' : '📎';
            return `<div class="dwp-att dwp-att-file">
                ${icon} <span class="dwp-att-name">${this._esc(name)}</span>
                <span class="dwp-muted">${this._esc(kb)}</span>
                <span class="dwp-att-local" title="Extracted from the return to the case Evidence folder">on disk</span>
            </div>`;
        }).join('');
    }

    /** Escape, linkify, preserve newlines, and mark the active search term. */
    _highlight(text) {
        const s = String(text || '');
        let html = this._esc(s).replace(/\n/g, '<br>');
        const q = (this._msgQuery || '').trim();
        if (q) {
            const rx = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            html = html.replace(rx, '<mark class="dwp-hl">$1</mark>');
        }
        return html;
    }

    _initials(name) {
        const s = String(name || '?').replace(/#\d+$/, '').trim();
        if (!s) return '?';
        return s.slice(0, 2).toUpperCase();
    }

    /** Stable per-author hue so the same person keeps the same colour. */
    _authorHue(name) {
        const s = String(name || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return `hsl(${h % 360} 62% 58%)`;
    }

    _fmtDay(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return String(ts);
            const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
            if (this._tz !== 'local') opts.timeZone = 'UTC';
            return d.toLocaleDateString(undefined, opts);
        } catch (_) { return String(ts); }
    }

    _fmtTime(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return String(ts);
            const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
            if (this._tz !== 'local') opts.timeZone = 'UTC';
            return d.toLocaleTimeString(undefined, opts) + (this._tz !== 'local' ? 'Z' : '');
        } catch (_) { return String(ts); }
    }

    /**
     * Discord states every timestamp in a return as UTC.  Rendering them in
     * the examiner's local zone without saying so has burned people in court,
     * so UTC is the default and the toggle is explicit.
     */
    _toggleTz() {
        this._tz = this._tz === 'local' ? 'utc' : 'local';
        this._repaintThread(null);
    }

    _channelIcon(type) {
        const t = (type || '').toUpperCase();
        if (t.includes('DM')) return '💬';
        if (t.includes('GROUP')) return '👥';
        if (t.includes('VOICE')) return '🔊';
        if (t.includes('GUILD')) return '#';
        return '💬';
    }

    _linkify(txt) {
        const s = String(txt || '');
        // Discord attachments are space-separated CDN URLs
        return s.split(/\s+/).filter(Boolean).map(u =>
            /^https?:\/\//i.test(u)
                ? `<a href="${this._esc(u)}" target="_blank" rel="noopener">${this._esc(u)}</a>`
                : this._esc(u)
        ).join(' ');
    }

    // Detect media kind from a URL (ignores query string)
    _attachmentKind(url) {
        const path = String(url).split('?')[0].toLowerCase();
        const m = path.match(/\.([a-z0-9]+)$/);
        const ext = m ? m[1] : '';
        if (['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return 'image';
        if (['mp4','webm','mov','m4v','mkv','avi'].includes(ext)) return 'video';
        if (['mp3','wav','ogg','m4a','aac','flac','opus'].includes(ext)) return 'audio';
        return 'link';
    }

    // Render Discord attachments inline with graceful fallback to a link
    _renderAttachments(txt) {
        const s = String(txt || '');
        const urls = s.split(/\s+/).filter(Boolean).filter(u => /^https?:\/\//i.test(u));
        if (!urls.length) return '📎 ' + this._linkify(txt);

        return urls.map(u => {
            const kind = this._attachmentKind(u);
            const safe = this._esc(u);
            const fname = (u.split('?')[0].split('/').pop()) || u;
            const fnameSafe = this._esc(fname);

            if (kind === 'image') {
                return `
                    <div class="dwp-att dwp-att-img">
                        <a href="${safe}" target="_blank" rel="noopener" title="${safe}">
                            <img src="${safe}" alt="${fnameSafe}" loading="lazy"
                                 onerror="this.parentNode.parentNode.classList.add('dwp-att-failed')" />
                        </a>
                        <div class="dwp-att-caption">📎 <a href="${safe}" target="_blank" rel="noopener">${fnameSafe}</a></div>
                    </div>
                `;
            }
            if (kind === 'video') {
                return `
                    <div class="dwp-att dwp-att-video">
                        <video controls preload="metadata" src="${safe}"
                               onerror="this.parentNode.classList.add('dwp-att-failed')"></video>
                        <div class="dwp-att-caption">🎬 <a href="${safe}" target="_blank" rel="noopener">${fnameSafe}</a></div>
                    </div>
                `;
            }
            if (kind === 'audio') {
                return `
                    <div class="dwp-att dwp-att-audio">
                        <audio controls preload="metadata" src="${safe}"
                               onerror="this.parentNode.classList.add('dwp-att-failed')"></audio>
                        <div class="dwp-att-caption">🔊 <a href="${safe}" target="_blank" rel="noopener">${fnameSafe}</a></div>
                    </div>
                `;
            }
            return `
                <div class="dwp-att dwp-att-link">
                    📎 <a href="${safe}" target="_blank" rel="noopener">${fnameSafe}</a>
                </div>
            `;
        }).join('');
    }

    // ─── Servers ────────────────────────────────────────────────────────

    _renderServers(d) {
        const servers = d.servers || [];
        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">🏛️ Servers / Guilds</h2>
                <p class="dwp-section-sub">${servers.length} server${servers.length === 1 ? '' : 's'}</p>

                ${servers.map(s => {
                    const flagged = this.module.isFlagged('servers', s.id);
                    return `
                    <div class="dwp-card dwp-mt" style="${flagged ? 'border:1px solid #fbbf24;box-shadow:0 0 0 2px rgba(245,158,11,.15);' : ''}">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
                            <h3 class="dwp-card-title" style="margin:0">${this._esc(s.name)}</h3>
                            ${this._flagBtn('servers', s.id)}
                        </div>
                        <div class="dwp-kv-list">
                            ${this._kv('Server ID', s.id)}
                            ${this._kv('Audit Log Entries', s.auditLog.length)}
                        </div>
                        ${s.auditLog.length === 0 ? '' : `
                            <details class="dwp-mt">
                                <summary>View audit log (${s.auditLog.length})</summary>
                                <pre class="dwp-pre">${this._esc(JSON.stringify(s.auditLog, null, 2))}</pre>
                            </details>
                        `}
                    </div>
                `;}).join('') || '<div class="dwp-empty-section">No server data.</div>'}
            </div>
        `;
    }

    // ─── IP Activity ────────────────────────────────────────────────────

    _renderIp(d) {
        const ips = d.ipActivity || [];
        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">🌐 IP Activity</h2>
                <p class="dwp-section-sub">${ips.length} unique IP${ips.length === 1 ? '' : 's'} across sessions and activity events</p>

                <table class="dwp-table">
                    <thead><tr>
                        <th>IP</th><th>Hits</th><th>Locations</th><th>ISP</th>
                        <th>OS</th><th>Browser</th><th>First Seen</th><th>Last Seen</th>
                        <th>Sources</th><th>ARIN</th><th>Flag</th>
                    </tr></thead>
                    <tbody>
                        ${ips.map(r => {
                            const flagged = this.module.isFlagged('ips', r.ip);
                            return `
                            <tr class="${flagged ? 'dwp-row-flagged' : ''}">
                                <td><code>${this._esc(r.ip)}</code></td>
                                <td>${r.count.toLocaleString()}</td>
                                <td>${r.locations.map(l => this._esc(l)).join('<br>')}</td>
                                <td>${r.isps.map(l => this._esc(l)).join(', ')}</td>
                                <td>${r.oses.map(l => this._esc(l)).join('<br>')}</td>
                                <td>${r.browsers.map(l => this._esc(l)).join(', ')}</td>
                                <td>${this._fmtDate(r.firstSeen)}</td>
                                <td>${this._fmtDate(r.lastSeen)}</td>
                                <td>${r.sources.slice(0, 6).map(s => `<span class="dwp-tag">${this._esc(s)}</span>`).join('')}${r.sources.length > 6 ? '…' : ''}</td>
                                <td>
                                    <button class="dwp-arin-btn" onclick="dwpArinLookup(this, '${this._esc(r.ip)}')" title="ARIN WHOIS Lookup">🌐 ARIN</button>
                                    <span class="dwp-arin-result"></span>
                                </td>
                                <td>${this._flagBtn('ips', r.ip)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ─── Devices ────────────────────────────────────────────────────────

    _renderDevices(d) {
        const devices = d.devices || [];
        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">📱 Devices</h2>
                <p class="dwp-section-sub">${devices.length} device fingerprint${devices.length === 1 ? '' : 's'}</p>

                <table class="dwp-table">
                    <thead><tr>
                        <th>Device Vendor ID</th><th>Device</th><th>OS</th><th>Browser</th>
                        <th>Client Version</th><th>Hits</th><th>IPs</th>
                        <th>First Seen</th><th>Last Seen</th><th>Flag</th>
                    </tr></thead>
                    <tbody>
                        ${devices.map(r => {
                            const k = r.device_vendor_id || r.key || '';
                            const flagged = this.module.isFlagged('devices', k);
                            return `
                            <tr class="${flagged ? 'dwp-row-flagged' : ''}">
                                <td><code class="dwp-trunc">${this._esc(k || '—')}</code></td>
                                <td>${this._esc(r.device || '—')}</td>
                                <td>${this._esc(r.os || '—')}${r.os_version ? ' ' + this._esc(r.os_version) : ''}</td>
                                <td>${this._esc(r.browser || '—')}</td>
                                <td><code>${this._esc(r.client_version || '—')}</code></td>
                                <td>${r.count.toLocaleString()}</td>
                                <td>${r.ips.map(ip => `<code>${this._esc(ip)}</code>`).join('<br>')}</td>
                                <td>${this._fmtDate(r.firstSeen)}</td>
                                <td>${this._fmtDate(r.lastSeen)}</td>
                                <td>${this._flagBtn('devices', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>

                ${devices.some(r => r.browser_user_agent) ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">User Agents</h3>
                        <ul class="dwp-ua-list">
                            ${[...new Set(devices.map(r => r.browser_user_agent).filter(Boolean))].map(ua => `
                                <li><code>${this._esc(ua)}</code></li>
                            `).join('')}
                        </ul>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Activity Events ────────────────────────────────────────────────

    _renderActivity(d) {
        const a = d.activity || {};
        const all = [
            ...(a.sessionStarts || []),
            ...(a.sessionEnds || []),
            ...(a.appOpens || []),
            ...(a.logins || []),
            ...(a.registers || []),
            ...(a.otherImportant || [])
        ];

        // Filter
        const filter = this._eventTypeFilter || 'all';
        const filtered = filter === 'all' ? all : all.filter(r => r.event_type === filter);
        filtered.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));

        const total = filtered.length;
        const start = this._activityPage * this._activityPageSize;
        const end = Math.min(start + this._activityPageSize, total);
        const slice = filtered.slice(start, end);

        // Distinct event types in dataset
        const eventTypes = [...new Set(all.map(r => r.event_type))].sort();

        // Top counts
        const topCounts = Object.entries(a.eventCounts || {})
            .sort((x, y) => y[1] - x[1])
            .slice(0, 20);

        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">📊 Activity Events</h2>
                <p class="dwp-section-sub">${(a.totalEventCount || 0).toLocaleString()} total events across analytics, tns, reporting, modeling</p>

                <div class="dwp-card">
                    <h3 class="dwp-card-title">Top Event Types</h3>
                    <table class="dwp-table dwp-table-compact">
                        <thead><tr><th>Category / Event Type</th><th>Count</th></tr></thead>
                        <tbody>
                            ${topCounts.map(([k, v]) => `<tr><td><code>${this._esc(k)}</code></td><td>${v.toLocaleString()}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="dwp-toolbar dwp-mt">
                    <label>Filter event type:
                        <select onchange="window.discordWarrantUI._setEventFilter(this.value)" class="dwp-select">
                            <option value="all" ${filter === 'all' ? 'selected' : ''}>All (${all.length.toLocaleString()})</option>
                            ${eventTypes.map(t => `<option value="${this._esc(t)}" ${filter === t ? 'selected' : ''}>${this._esc(t)}</option>`).join('')}
                        </select>
                    </label>
                </div>

                <table class="dwp-table dwp-mt">
                    <thead><tr>
                        <th>Time</th><th>Event</th><th>Category</th><th>IP</th>
                        <th>Location</th><th>Device / Browser</th><th>OS</th><th>Session</th><th>Flag</th>
                    </tr></thead>
                    <tbody>
                        ${slice.map(r => {
                            const k = window.WarrantFlagsKey.activity(r);
                            const flagged = this.module.isFlagged('activity', k);
                            return `
                            <tr class="${flagged ? 'dwp-row-flagged' : ''}">
                                <td>${this._fmtDate(r.timestamp)}</td>
                                <td><span class="dwp-tag dwp-tag-${this._eventClass(r.event_type)}">${this._esc(r.event_type)}</span></td>
                                <td>${this._esc(r.category)}</td>
                                <td><code>${this._esc(r.ip || '—')}</code></td>
                                <td>${[r.city, r.region_code, r.country_code].filter(Boolean).map(s => this._esc(s)).join(', ')}</td>
                                <td>${this._esc(r.device || r.browser || '—')}${r.client_version ? ' · v' + this._esc(r.client_version) : ''}</td>
                                <td>${this._esc(r.os || '—')}${r.os_version ? ' ' + this._esc(r.os_version) : ''}</td>
                                <td><code class="dwp-trunc">${this._esc(r.session || '—')}</code></td>
                                <td>${this._flagBtn('activity', k)}</td>
                            </tr>
                        `;}).join('')}
                    </tbody>
                </table>

                ${total > this._activityPageSize ? `
                    <div class="dwp-pager">
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._activityPage--; document.getElementById('dwp-content-area').innerHTML = window.discordWarrantUI._renderSection();" ${this._activityPage > 0 ? '' : 'disabled'}>← Prev</button>
                        <span>${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</span>
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._activityPage++; document.getElementById('dwp-content-area').innerHTML = window.discordWarrantUI._renderSection();" ${end < total ? '' : 'disabled'}>Next →</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    _setEventFilter(v) {
        this._eventTypeFilter = v;
        this._activityPage = 0;
        const content = document.getElementById('dwp-content-area');
        if (content) {
            content.innerHTML = this._renderSection();
            if (typeof this._loadLazyImages === 'function') this._loadLazyImages(content);
        }
    }

    _eventClass(type) {
        if (!type) return 'default';
        if (type.startsWith('session_start')) return 'success';
        if (type.startsWith('session_end')) return 'muted';
        if (type.startsWith('login')) return 'info';
        if (type.startsWith('register')) return 'warning';
        if (type === 'app_opened') return 'info';
        return 'default';
    }

    // ─── Billing & DSAR ─────────────────────────────────────────────────

    _renderBilling(d) {
        const b = d.billing || {};
        const dsar = d.dsar || [];
        const promo = d.promotions || {};
        const store = d.store || {};
        const vc = d.virtualCurrency || {};

        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">💳 Billing & Account Records</h2>

                <div class="dwp-overview-grid">
                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Payments <span class="dwp-pill">${b.payments.length}</span></h3>
                        ${b.payments.length === 0 ? '<div class="dwp-empty-section">No payment records.</div>'
                            : `<pre class="dwp-pre">${this._esc(JSON.stringify(b.payments, null, 2))}</pre>`}
                    </div>

                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Payment Sources <span class="dwp-pill">${b.paymentSources.length}</span></h3>
                        ${b.paymentSources.length === 0 ? '<div class="dwp-empty-section">No payment sources.</div>'
                            : `<pre class="dwp-pre">${this._esc(JSON.stringify(b.paymentSources, null, 2))}</pre>`}
                    </div>

                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Entitlements <span class="dwp-pill">${b.entitlements.length}</span></h3>
                        ${b.entitlements.length === 0 ? '<div class="dwp-empty-section">No entitlements.</div>'
                            : `<pre class="dwp-pre">${this._esc(JSON.stringify(b.entitlements, null, 2))}</pre>`}
                    </div>

                    <div class="dwp-card">
                        <h3 class="dwp-card-title">Billing Profile</h3>
                        ${b.billingProfile.length === 0 ? '<div class="dwp-empty-section">No billing profile.</div>'
                            : `<pre class="dwp-pre">${this._esc(JSON.stringify(b.billingProfile, null, 2))}</pre>`}
                    </div>
                </div>

                <div class="dwp-card dwp-mt">
                    <h3 class="dwp-card-title">Data Subject Access Requests <span class="dwp-pill">${dsar.length}</span></h3>
                    ${dsar.length === 0 ? '<div class="dwp-empty-section">No DSAR records.</div>'
                        : `<table class="dwp-table">
                            <thead><tr><th>Request ID</th><th>User ID</th><th>Email</th><th>Created At</th></tr></thead>
                            <tbody>
                                ${dsar.map(r => `
                                    <tr>
                                        <td><code>${this._esc(r.id)}</code></td>
                                        <td><code>${this._esc(r.user_id)}</code></td>
                                        <td>${this._esc(r.email)}</td>
                                        <td>${this._fmtDate(r.created_at)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>`}
                </div>

                ${(promo.quests.length || promo.drops.length) ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">Promotions</h3>
                        <div class="dwp-kv-list">
                            ${this._kv('Quest Reward Codes', promo.quests.length)}
                            ${this._kv('Drop Reward Codes', promo.drops.length)}
                        </div>
                    </div>
                ` : ''}

                ${(store.wishlist.length) ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">Store Wishlist <span class="dwp-pill">${store.wishlist.length}</span></h3>
                        <pre class="dwp-pre">${this._esc(JSON.stringify(store.wishlist, null, 2))}</pre>
                    </div>
                ` : ''}

                ${(vc.accounts.length || vc.transactions.length) ? `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">Virtual Currency</h3>
                        <div class="dwp-kv-list">
                            ${this._kv('Coin Accounts', vc.accounts.length)}
                            ${this._kv('Coin Transactions', vc.transactions.length)}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _kv(label, value, code = false) {
        if (value === null || value === undefined || value === '') return '';
        const v = code ? `<code>${this._esc(value)}</code>` : this._esc(value);
        return `<div class="dwp-kv"><span class="dwp-kv-key">${this._esc(label)}</span><span class="dwp-kv-val">${v}</span></div>`;
    }

    _stat(label, value) {
        return `
            <div class="dwp-stat">
                <div class="dwp-stat-value">${(value || 0).toLocaleString()}</div>
                <div class="dwp-stat-label">${this._esc(label)}</div>
            </div>
        `;
    }

    /**
     * Import diagnostics banner.
     *
     * Both Discord parsers are built to degrade rather than throw — a missing
     * or renamed section yields [] instead of an error.  That is the right
     * behaviour for a forensic tool, but without this banner it means a package
     * we only half-understood imports "successfully" and quietly shows nothing.
     * Always tell the analyst which format we matched and what we skipped.
     */
    _renderDiagnostics(d) {
        const diag = d.diagnostics || {};
        const warnings = Array.isArray(diag.warnings) ? diag.warnings : [];
        const label = d.formatLabel || 'Discord Data Package';
        const root = d.detectedRoot && d.detectedRoot !== '(archive root)'
            ? ` · nested under <code>${this._esc(d.detectedRoot)}</code>` : '';

        const unmatched = diag.unmatchedCount || 0;
        const unmatchedHtml = unmatched
            ? `<details class="dwp-diag-details">
                   <summary>${unmatched.toLocaleString()} file${unmatched === 1 ? '' : 's'} in this package were not recognized</summary>
                   <ul class="dwp-diag-list">
                       ${(diag.unmatchedFiles || []).map(f => `<li><code>${this._esc(f)}</code></li>`).join('')}
                   </ul>
                   ${unmatched > (diag.unmatchedFiles || []).length
                       ? `<div class="dwp-diag-more">…and ${(unmatched - (diag.unmatchedFiles || []).length).toLocaleString()} more.</div>` : ''}
               </details>`
            : '';

        const warnHtml = warnings.length
            ? `<ul class="dwp-diag-list dwp-diag-warn">
                   ${warnings.map(w => `<li>${this._esc(w)}</li>`).join('')}
               </ul>`
            : '';

        const tone = warnings.length ? 'dwp-diag-alert' : 'dwp-diag-ok';
        return `
            <div class="dwp-diag ${tone}">
                <div class="dwp-diag-head">
                    <span class="dwp-diag-badge">${this._esc(label)}</span>
                    <span class="dwp-diag-meta">
                        ${diag.filesSeen ? `${diag.filesSeen.toLocaleString()} files read` : ''}${root}
                    </span>
                </div>
                ${warnHtml}
                ${unmatchedHtml}
            </div>
        `;
    }

    _fmtDate(ts) {
        if (!ts) return '—';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return this._esc(ts);
            return d.toLocaleString();
        } catch (_) { return this._esc(ts); }
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
            <div class="dwp-loading">
                <div class="dwp-spinner"></div>
                <p>${this._esc(text)}</p>
            </div>
        `;
    }

    _toast(msg, type) {
        if (typeof viperToast === 'function') viperToast(msg, type);
        else console.log(`[${type}] ${msg}`);
    }

    async _loadLazyImages(container) {
        const root = container || document;
        const imgs = root.querySelectorAll('.dwp-lazy-img[data-disk-path]');
        for (const img of imgs) {
            const diskPath = img.dataset.diskPath;
            if (!diskPath) continue;
            if (this._mediaCache[diskPath]) {
                img.src = this._mediaCache[diskPath];
                img.classList.remove('dwp-lazy-img');
                continue;
            }
            try {
                const result = await this.module.readMedia(diskPath);
                if (result) {
                    const dataUrl = `data:${result.mimeType};base64,${result.data}`;
                    this._mediaCache[diskPath] = dataUrl;
                    img.src = dataUrl;
                    img.classList.remove('dwp-lazy-img');
                }
            } catch (e) { /* ignore */ }
        }
    }
}

window.DiscordWarrantUI = DiscordWarrantUI;

// Global ARIN lookup for Discord Warrant IP addresses (in-app, via electronAPI.arinLookup)
async function dwpArinLookup(btn, ip) {
    if (!ip || !window.electronAPI?.arinLookup) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⏳';
    try {
        const result = await window.electronAPI.arinLookup(ip);
        const span = btn.nextElementSibling && btn.nextElementSibling.classList?.contains('dwp-arin-result')
            ? btn.nextElementSibling
            : null;
        if (result && result.success) {
            const info = [];
            if (result.provider || result.organization) info.push(result.provider || result.organization);
            if (result.network) info.push(result.network);
            if (result.netRange) info.push(result.netRange);
            if (span) {
                span.className = 'dwp-arin-result dwp-arin-success';
                span.textContent = info.join(' · ');
                span.title = info.join('\n');
            }
            btn.textContent = '✓ ARIN';
            btn.classList.add('dwp-arin-done');
        } else {
            btn.textContent = '✗ ARIN';
            btn.title = (result && result.error) || 'Lookup failed';
            btn.classList.add('dwp-arin-fail');
        }
    } catch (e) {
        btn.textContent = '✗ ARIN';
        btn.title = e.message;
        btn.classList.add('dwp-arin-fail');
    }
    btn.disabled = false;
}
window.dwpArinLookup = dwpArinLookup;
