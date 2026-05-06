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
        const channels = (d.channels || []).slice().sort((a, b) => b.messageCount - a.messageCount);

        if (this._activeChannelId) {
            const ch = channels.find(c => c.channelId === this._activeChannelId);
            if (ch) return this._renderChannelDetail(ch);
        }

        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">💬 Messages</h2>
                <p class="dwp-section-sub">${channels.length} channel${channels.length === 1 ? '' : 's'} · ${(d.stats?.messageCount || 0).toLocaleString()} message${d.stats?.messageCount === 1 ? '' : 's'}</p>

                <div class="dwp-channel-list">
                    ${channels.map(ch => `
                        <button class="dwp-channel-row" onclick="window.discordWarrantUI._openChannel('${this._escJs(ch.channelId)}')">
                            <div class="dwp-channel-icon">${this._channelIcon(ch.channelType)}</div>
                            <div class="dwp-channel-info">
                                <div class="dwp-channel-name">${this._esc(ch.channelName || ch.indexLabel || ch.channelId)}</div>
                                ${ch.guildName ? `<div class="dwp-channel-guild">in ${this._esc(ch.guildName)}</div>` : ''}
                                <div class="dwp-channel-id"><code>${this._esc(ch.channelId)}</code> · ${this._esc(ch.channelType || '')}</div>
                            </div>
                            <div class="dwp-channel-count">${ch.messageCount.toLocaleString()}</div>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _openChannel(channelId) {
        this._activeChannelId = channelId;
        this._msgPage = 0;
        const content = document.getElementById('dwp-content-area');
        if (content) content.innerHTML = this._renderSection();
    }

    _backToChannels() {
        this._activeChannelId = null;
        const content = document.getElementById('dwp-content-area');
        if (content) content.innerHTML = this._renderSection();
    }

    _renderChannelDetail(ch) {
        const total = ch.messages.length;
        const start = this._msgPage * this._msgPageSize;
        const end = Math.min(start + this._msgPageSize, total);
        const slice = ch.messages.slice(start, end);
        const hasMore = end < total;
        const hasPrev = this._msgPage > 0;

        return `
            <div class="dwp-section">
                <button class="dwp-back-btn" onclick="window.discordWarrantUI._backToChannels()">← Back to channels</button>
                <h2 class="dwp-section-title">
                    ${this._channelIcon(ch.channelType)} ${this._esc(ch.channelName || ch.channelId)}
                </h2>
                <p class="dwp-section-sub">
                    ${ch.guildName ? `Server: <strong>${this._esc(ch.guildName)}</strong> · ` : ''}
                    Channel ID <code>${this._esc(ch.channelId)}</code> · ${total.toLocaleString()} messages
                </p>

                <div class="dwp-messages">
                    ${slice.length === 0 ? '<div class="dwp-empty-section">No messages.</div>' : slice.map(m => `
                        <div class="dwp-message">
                            <div class="dwp-message-header">
                                <span class="dwp-message-time">${this._fmtDate(m.timestamp)}</span>
                                <span class="dwp-message-id">ID: <code>${this._esc(String(m.id || ''))}</code></span>
                            </div>
                            <div class="dwp-message-body">${this._esc(m.contents || '').replace(/\n/g, '<br>') || '<em class="dwp-muted">(no text)</em>'}</div>
                            ${m.attachments ? `<div class="dwp-message-attach">📎 ${this._linkify(m.attachments)}</div>` : ''}
                        </div>
                    `).join('')}
                </div>

                ${total > this._msgPageSize ? `
                    <div class="dwp-pager">
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._msgPage--; document.getElementById('dwp-content-area').innerHTML = window.discordWarrantUI._renderSection();" ${hasPrev ? '' : 'disabled'}>← Prev</button>
                        <span>${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</span>
                        <button class="dwp-btn-sm" onclick="window.discordWarrantUI._msgPage++; document.getElementById('dwp-content-area').innerHTML = window.discordWarrantUI._renderSection();" ${hasMore ? '' : 'disabled'}>Next →</button>
                    </div>
                ` : ''}
            </div>
        `;
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

    // ─── Servers ────────────────────────────────────────────────────────

    _renderServers(d) {
        const servers = d.servers || [];
        return `
            <div class="dwp-section">
                <h2 class="dwp-section-title">🏛️ Servers / Guilds</h2>
                <p class="dwp-section-sub">${servers.length} server${servers.length === 1 ? '' : 's'}</p>

                ${servers.map(s => `
                    <div class="dwp-card dwp-mt">
                        <h3 class="dwp-card-title">${this._esc(s.name)}</h3>
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
                `).join('') || '<div class="dwp-empty-section">No server data.</div>'}
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
                        <th>Sources</th><th></th>
                    </tr></thead>
                    <tbody>
                        ${ips.map(r => `
                            <tr>
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
                            </tr>
                        `).join('')}
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
                        <th>First Seen</th><th>Last Seen</th>
                    </tr></thead>
                    <tbody>
                        ${devices.map(r => `
                            <tr>
                                <td><code class="dwp-trunc">${this._esc(r.device_vendor_id || r.key || '—')}</code></td>
                                <td>${this._esc(r.device || '—')}</td>
                                <td>${this._esc(r.os || '—')}${r.os_version ? ' ' + this._esc(r.os_version) : ''}</td>
                                <td>${this._esc(r.browser || '—')}</td>
                                <td><code>${this._esc(r.client_version || '—')}</code></td>
                                <td>${r.count.toLocaleString()}</td>
                                <td>${r.ips.map(ip => `<code>${this._esc(ip)}</code>`).join('<br>')}</td>
                                <td>${this._fmtDate(r.firstSeen)}</td>
                                <td>${this._fmtDate(r.lastSeen)}</td>
                            </tr>
                        `).join('')}
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
                        <th>Location</th><th>Device / Browser</th><th>OS</th><th>Session</th>
                    </tr></thead>
                    <tbody>
                        ${slice.map(r => `
                            <tr>
                                <td>${this._fmtDate(r.timestamp)}</td>
                                <td><span class="dwp-tag dwp-tag-${this._eventClass(r.event_type)}">${this._esc(r.event_type)}</span></td>
                                <td>${this._esc(r.category)}</td>
                                <td><code>${this._esc(r.ip || '—')}</code></td>
                                <td>${[r.city, r.region_code, r.country_code].filter(Boolean).map(s => this._esc(s)).join(', ')}</td>
                                <td>${this._esc(r.device || r.browser || '—')}${r.client_version ? ' · v' + this._esc(r.client_version) : ''}</td>
                                <td>${this._esc(r.os || '—')}${r.os_version ? ' ' + this._esc(r.os_version) : ''}</td>
                                <td><code class="dwp-trunc">${this._esc(r.session || '—')}</code></td>
                            </tr>
                        `).join('')}
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
        if (content) content.innerHTML = this._renderSection();
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
