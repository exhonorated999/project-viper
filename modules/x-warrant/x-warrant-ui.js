/**
 * X / Twitter Warrant — UI (renderer)
 * Sidebar + sections, mirroring the Snapchat/Kik/Meta warrant UI architecture.
 * Sections: Overview · Threads · Tweets · Records · Media · Users.
 * Uses the .xwp- stylesheet (cloned from Snapchat for visual parity).
 */

class XWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
        this._mediaCache = {};
        this._activeConversationId = null;
        this._convFilter = '';
        this._tweetFilter = '';
        this._recordFilter = '';
    }

    get container() { return document.getElementById(this.containerId); }
    get currentImport() { return this.module.imports[this.activeImportIdx] || null; }

    // ─── Main render ────────────────────────────────────────────────────

    render() {
        if (!this.container) return;
        if (this.module.imports.length === 0) {
            this.container.innerHTML = this._renderEmptyState();
            return;
        }
        this.container.innerHTML = `
            <div class="xwp-layout">
                <div class="xwp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderFlagToolbar()}
                    ${this._renderNav()}
                </div>
                <div class="xwp-content" id="xwp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="xwp-evidence-bar"></div>
        `;
        this._loadLazyImages();
    }

    _renderEmptyState() {
        return `
            <div class="xwp-empty-state">
                <div class="xwp-empty-icon">𝕏</div>
                <h3 class="xwp-empty-title">No X / Twitter warrant data imported</h3>
                <p class="xwp-empty-text">Drop an X production ZIP or folder into the case Evidence/Warrants folder, or import one directly.</p>
                <button class="xwp-btn-primary" onclick="window.xWarrantUI.handleFilePicker()">Import X Production (ZIP or folder)</button>
                <div id="xwp-evidence-bar"></div>
            </div>
        `;
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('xwp-evidence-bar');
        if (!bar) return;
        if (!files || files.length === 0) { bar.innerHTML = ''; return; }
        bar.innerHTML = `
            <div class="xwp-evidence-bar">
                <div class="xwp-evidence-label">Detected X / Twitter Warrant Files:</div>
                ${files.map(f => `
                    <button class="xwp-evidence-file ${f.alreadyImported ? 'imported' : ''}"
                            onclick="window.xWarrantUI.handleEvidenceClick('${this._escJs(f.path)}', '${this._escJs(f.name)}', ${f.isFolder ? 'true' : 'false'})"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="xwp-evidence-icon">${f.alreadyImported ? '✅' : (f.isFolder ? '📁' : '📦')}</span>
                        <span class="xwp-evidence-name">${this._esc(f.name)}</span>
                        ${f.size ? `<span class="xwp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>` : ''}
                    </button>
                `).join('')}
            </div>
        `;
    }

    // ─── Flag toolbar ───────────────────────────────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        return `
            <div class="xwp-flag-toolbar">
                <button class="xwp-flag-header-btn" title="Flagged item count">
                    🚩 Flags <span class="xwp-flag-count-pill" id="xwp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="xwp-flag-toolbar-spacer"></div>
                <button class="xwp-push-btn" id="xwp-push-btn" ${total > 0 ? '' : 'disabled'}
                        onclick="window.xWarrantUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">📥 Push to Evidence</button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('xwp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('xwp-push-btn');
        if (btn) btn.disabled = (total === 0);
    }

    async _pushFlagsToEvidence() {
        const total = this.module.flagCount();
        if (total === 0) { this._toast('No items flagged yet. Click 🚩 on items first.', 'info'); return; }
        const ok = (typeof viperConfirm === 'function')
            ? await viperConfirm(`Push ${total} flagged item${total === 1 ? '' : 's'} to the case Evidence module as a single bundle?`, { okText: 'Push' })
            : confirm(`Push ${total} flagged item(s) to Evidence?`);
        if (!ok) return;
        const btn = document.getElementById('xwp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                this.module.clearFlags();
                this._refreshFlagToolbar();
                this.rerenderSection();
                this._toast(`Pushed ${total} item(s) to Evidence.`, 'success');
            } else {
                this._toast('Push failed: ' + ((res && res.error) || 'unknown'), 'error');
                if (btn) { btn.disabled = false; btn.textContent = '📥 Push to Evidence'; }
            }
        } catch (e) {
            this._toast('Push failed: ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '📥 Push to Evidence'; }
        }
    }

    _flagBtn(section, key) {
        const on = this.module.isFlagged(section, key);
        const safeKey = String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<button class="xwp-flag-btn ${on ? 'on' : ''}" title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                onclick="event.stopPropagation(); window.xWarrantUI._onFlagClick('${section}', '${safeKey}')">🚩</button>`;
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        this.rerenderSection();
    }

    // ─── Import handlers ────────────────────────────────────────────────

    async handleEvidenceClick(filePath, fileName, isFolder) {
        try {
            this._showLoading('Importing X production… (large productions may take a minute)');
            const record = await this.module.importWarrant(filePath, fileName, isFolder);
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountUsername || fileName}`, 'success');
        } catch (err) { this._toast('Import failed: ' + err.message, 'error'); this.render(); }
    }

    async handleFilePicker() {
        try {
            this._showLoading('Importing X production… (large productions may take a minute)');
            const record = await this.module.importFromPicker();
            if (!record) { this.render(); return; }
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountUsername || record.fileName}`, 'success');
        } catch (err) { this._toast('Import failed: ' + err.message, 'error'); this.render(); }
    }

    switchSection(section) {
        const change = section !== this.activeSection;
        this.activeSection = section;
        if (change) this._activeConversationId = null;
        const content = document.getElementById('xwp-content-area');
        if (content) { content.innerHTML = this._renderSection(); this._loadLazyImages(content); }
        document.querySelectorAll('.xwp-nav-item').forEach(el => el.classList.toggle('active', el.dataset.section === section));
    }

    rerenderSection() {
        const content = document.getElementById('xwp-content-area');
        if (!content) return;
        content.innerHTML = this._renderSection();
        this._loadLazyImages(content);
    }

    switchImport(idx) { this.activeImportIdx = idx; this.activeSection = 'overview'; this.render(); }

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
            <div class="xwp-import-selector">
                <label class="xwp-label">Import:</label>
                <select onchange="window.xWarrantUI.switchImport(parseInt(this.value))" class="xwp-select">
                    ${this.module.imports.map((imp, i) => `<option value="${i}" ${i === this.activeImportIdx ? 'selected' : ''}>${this._esc(imp.accountUsername || imp.fileName)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    _renderNav() {
        const imp = this.currentImport;
        if (!imp) return '';
        const recordRows = (imp.records || []).reduce((a, r) => a + r.rows.length, 0);
        const sections = [
            { id: 'overview', label: 'Account Overview', icon: '👤', show: true },
            { id: 'threads',  label: 'Threads',          icon: '💬', count: (imp.threads || []).length, show: (imp.threads || []).length > 0 },
            { id: 'tweets',   label: 'Tweets',           icon: '🐦', count: (imp.tweets || []).length, show: (imp.tweets || []).length > 0 },
            { id: 'records',  label: 'Records',          icon: '📋', count: recordRows, show: (imp.records || []).length > 0 },
            { id: 'media',    label: 'Media',            icon: '📷', count: Object.keys(imp.mediaFiles || {}).length, show: Object.keys(imp.mediaFiles || {}).length > 0 },
            { id: 'users',    label: 'Users',            icon: '🧑', count: (imp.users || []).length, show: (imp.users || []).length > 0 },
        ];
        return `
            <nav class="xwp-nav">
                ${sections.filter(s => s.show).map(s => `
                    <button class="xwp-nav-item ${s.id === this.activeSection ? 'active' : ''}" data-section="${s.id}"
                            onclick="window.xWarrantUI.switchSection('${s.id}')">
                        <span class="xwp-nav-icon">${s.icon}</span>
                        <span class="xwp-nav-label">${s.label}</span>
                        ${s.count ? `<span class="xwp-nav-count">${s.count.toLocaleString()}</span>` : ''}
                    </button>
                `).join('')}
            </nav>
            <div class="xwp-nav-actions">
                <button class="xwp-btn-sm" onclick="window.xWarrantUI.handleFilePicker()">+ Import</button>
                <button class="xwp-btn-sm danger" onclick="window.xWarrantUI.deleteCurrentImport()">🗑️ Delete</button>
            </div>
        `;
    }

    _renderSection() {
        const imp = this.currentImport;
        if (!imp) return '<div class="xwp-empty">No data available</div>';
        switch (this.activeSection) {
            case 'overview': return this._renderOverview(imp);
            case 'threads':  return this._activeConversationId ? this._renderThread(imp) : this._renderThreadList(imp);
            case 'tweets':   return this._renderTweets(imp);
            case 'records':  return this._renderRecords(imp);
            case 'media':    return this._renderMedia(imp);
            case 'users':    return this._renderUsers(imp);
            default:         return '<div class="xwp-empty">Unknown section</div>';
        }
    }

    // ─── Overview ───────────────────────────────────────────────────────

    _renderOverview(imp) {
        const s = imp.stats || {};
        const rows = [
            ['Username / Handle', imp.accountUsername],
            ['User ID', imp.accountUserId],
            ['Display Name', imp.accountDisplayName],
            ['Email', imp.accountEmail],
            ['Case Number', imp.caseNumber],
            ['Source File', imp.fileName],
            ['Imported', imp.importedAt ? new Date(imp.importedAt).toLocaleString() : ''],
        ].filter(r => r[1]);
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">👤 Account Overview</h2>
                <div class="xwp-card">
                    <table class="xwp-kv-table">
                        ${rows.map(r => `<tr><td class="xwp-kv-key">${this._esc(r[0])}</td><td class="xwp-kv-value">${this._esc(String(r[1]))}</td></tr>`).join('')}
                    </table>
                </div>
                <div class="xwp-stat-grid">
                    ${this._statBadge('Threads', s.threadCount || 0, '💬')}
                    ${this._statBadge('Messages', s.messageCount || 0, '✉️')}
                    ${this._statBadge('Tweets', s.tweetCount || 0, '🐦')}
                    ${this._statBadge('Record Types', s.recordTypeCount || 0, '📋')}
                    ${this._statBadge('Users', s.userCount || 0, '🧑')}
                    ${this._statBadge('Media', s.mediaCount || 0, '📷')}
                </div>
            </div>
        `;
    }

    _statBadge(label, value, icon) {
        return `<div class="xwp-stat-badge"><div class="xwp-stat-icon">${icon}</div><div class="xwp-stat-val">${Number(value).toLocaleString()}</div><div class="xwp-stat-label">${this._esc(label)}</div></div>`;
    }

    // ─── Threads ────────────────────────────────────────────────────────

    _renderThreadList(imp) {
        const threads = (imp.threads || []);
        const filter = (this._convFilter || '').toLowerCase();
        const filtered = filter ? threads.filter(t => (t.conversation_id || '').toLowerCase().includes(filter) || t.participants.some(p => String(p).toLowerCase().includes(filter))) : threads;
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">💬 Threads (${threads.length})</h2>
                <input type="text" class="xwp-input" placeholder="Search conversations / participants"
                    value="${this._esc(this._convFilter)}"
                    oninput="window.xWarrantUI._convFilter = this.value; window.xWarrantUI.rerenderSection()">
                <div class="xwp-conv-list">
                    ${filtered.length === 0 ? '<div class="xwp-empty">No conversations match.</div>' : filtered.map(t => `
                        <div class="xwp-conv-item" onclick="window.xWarrantUI.openConversation('${this._escJs(t.conversation_id)}')">
                            <div class="xwp-conv-title">${t.is_group ? '👥 Group' : '👤 DM'} · ${this._esc(t.conversation_id)} ${t.deleted ? '<span class="xwp-tag">deleted</span>' : ''}</div>
                            <div class="xwp-conv-meta">${t.message_count} messages · ${this._esc((t.participants || []).join(', '))}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    openConversation(id) { this._activeConversationId = id; this.rerenderSection(); }
    closeConversation() { this._activeConversationId = null; this.rerenderSection(); }

    _renderThread(imp) {
        const t = (imp.threads || []).find(x => x.conversation_id === this._activeConversationId);
        if (!t) { this._activeConversationId = null; return this._renderThreadList(imp); }
        const acct = imp.accountUserId;
        return `
            <div class="xwp-section">
                <button class="xwp-back-btn" onclick="window.xWarrantUI.closeConversation()">← Back to Threads</button>
                <h2 class="xwp-section-title">${t.is_group ? '👥 Group' : '👤 DM'} · ${this._esc(t.conversation_id)}</h2>
                <div class="xwp-thread">
                    ${t.messages.map(m => {
                        const key = window.WarrantFlagsKey.xMessage(m, t);
                        const fromTarget = acct && m.sender_id === acct;
                        const flagged = this.module.isFlagged('threads', key);
                        const media = (m.media || []).map(fn => this._mediaThumb(imp, fn)).join('');
                        return `
                            <div class="xwp-message ${fromTarget ? 'from-target' : 'from-other'} ${flagged ? 'flagged' : ''}">
                                <div class="xwp-msg-head">
                                    <span class="xwp-msg-sender">${this._esc(m.sender_id)}${fromTarget ? ' (account)' : ''}</span>
                                    <span class="xwp-msg-time">${this._esc(this._fmt(m.created_at))}</span>
                                    ${this._flagBtn('threads', key)}
                                </div>
                                ${m.text ? `<div class="xwp-msg-text">${this._esc(m.text)}</div>` : ''}
                                ${media ? `<div class="xwp-msg-media">${media}</div>` : ''}
                                ${(m.media_urls && m.media_urls.length) ? `<div class="xwp-msg-urls">${m.media_urls.map(u => `<a href="#" class="xwp-url">${this._esc(u)}</a>`).join('')}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // ─── Tweets ─────────────────────────────────────────────────────────

    _renderTweets(imp) {
        const tweets = imp.tweets || [];
        const filter = (this._tweetFilter || '').toLowerCase();
        const filtered = filter ? tweets.filter(t => (t.full_text || '').toLowerCase().includes(filter)) : tweets;
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">🐦 Tweets (${tweets.length})</h2>
                <input type="text" class="xwp-input" placeholder="Search tweet text"
                    value="${this._esc(this._tweetFilter)}"
                    oninput="window.xWarrantUI._tweetFilter = this.value; window.xWarrantUI.rerenderSection()">
                <div class="xwp-tweet-list">
                    ${filtered.slice(0, 1000).map(t => {
                        const key = window.WarrantFlagsKey.xTweet(t);
                        const flagged = this.module.isFlagged('tweets', key);
                        const media = (t.media || []).map(fn => this._mediaThumb(imp, fn)).join('');
                        return `
                            <div class="xwp-card xwp-tweet ${flagged ? 'flagged' : ''}">
                                <div class="xwp-msg-head">
                                    <span class="xwp-msg-time">${this._esc(this._fmt(t.created_at))} ${t.deleted ? '<span class="xwp-tag">deleted</span>' : ''} ${t.is_retweet ? '<span class="xwp-tag">RT</span>' : ''}</span>
                                    <span class="xwp-tweet-stats">❤ ${t.favorite_count || 0} · 🔁 ${t.retweet_count || 0}</span>
                                    ${this._flagBtn('tweets', key)}
                                </div>
                                <div class="xwp-msg-text">${this._esc(t.full_text)}</div>
                                ${media ? `<div class="xwp-msg-media">${media}</div>` : ''}
                                <div class="xwp-tweet-foot">${t.tweet_id ? 'ID ' + this._esc(t.tweet_id) : ''} ${t.lang ? '· ' + this._esc(t.lang) : ''} ${t.in_reply_to ? '· reply to ' + this._esc(String(t.in_reply_to)) : ''}</div>
                            </div>
                        `;
                    }).join('')}
                    ${filtered.length > 1000 ? `<div class="xwp-empty-hint">Showing first 1,000 of ${filtered.length.toLocaleString()} tweets.</div>` : ''}
                </div>
            </div>
        `;
    }

    // ─── Records (grouped by category) ──────────────────────────────────

    _renderRecords(imp) {
        const records = imp.records || [];
        if (!records.length) return '<div class="xwp-empty">No records.</div>';
        const cats = {};
        for (const r of records) (cats[r.category] = cats[r.category] || []).push(r);
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">📋 Records (${records.length} types)</h2>
                ${Object.keys(cats).sort().map(cat => `
                    <h3 class="xwp-cat-title">${this._esc(cat)}</h3>
                    ${cats[cat].map(rec => `
                        <div class="xwp-card">
                            <h4 class="xwp-card-title">${this._esc(rec.label)} <span class="xwp-conv-count">${rec.rows.length.toLocaleString()} rows</span></h4>
                            ${rec.description ? `<div class="xwp-rec-desc">${this._esc(rec.description)}</div>` : ''}
                            <div class="xwp-table-wrapper">
                                <table class="xwp-table">
                                    <thead><tr><th></th>${rec.headers.map(h => `<th>${this._esc(h)}</th>`).join('')}</tr></thead>
                                    <tbody>
                                        ${rec.rows.slice(0, 500).map((row, idx) => {
                                            const key = window.WarrantFlagsKey.xRecord(rec, row, idx);
                                            const flagged = this.module.isFlagged('records', key);
                                            return `<tr class="${flagged ? 'xwp-row-flagged' : ''}"><td>${this._flagBtn('records', key)}</td>${rec.headers.map(h => `<td>${this._esc(row[h] || '')}</td>`).join('')}</tr>`;
                                        }).join('')}
                                    </tbody>
                                </table>
                                ${rec.rows.length > 500 ? `<div class="xwp-empty-hint">Showing first 500 of ${rec.rows.length.toLocaleString()} rows.</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                `).join('')}
            </div>
        `;
    }

    // ─── Media ──────────────────────────────────────────────────────────

    _renderMedia(imp) {
        const names = Object.keys(imp.mediaFiles || {});
        if (!names.length) return '<div class="xwp-empty">No media files.</div>';
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">📷 Media (${names.length})</h2>
                <div class="xwp-media-grid">
                    ${names.slice(0, 300).map(fn => {
                        const info = imp.mediaFiles[fn] || {};
                        const isImg = /^image\//.test(info.mimeType || '');
                        return `<div class="xwp-media-cell">
                            ${isImg && info.diskPath ? `<img data-xwp-media="${this._escJs(info.diskPath)}" alt="${this._esc(fn)}" class="xwp-media-img">` : `<div class="xwp-media-placeholder">${/^video\//.test(info.mimeType) ? '🎬' : '📄'}</div>`}
                            <div class="xwp-media-name" title="${this._esc(fn)}">${this._esc(fn)}</div>
                        </div>`;
                    }).join('')}
                </div>
                ${names.length > 300 ? `<div class="xwp-empty-hint">Showing first 300 of ${names.length.toLocaleString()} media files.</div>` : ''}
            </div>
        `;
    }

    _mediaThumb(imp, fileName) {
        const info = (imp.mediaFiles || {})[fileName];
        if (!info) return '';
        if (/^image\//.test(info.mimeType || '') && info.diskPath) {
            return `<img data-xwp-media="${this._escJs(info.diskPath)}" alt="${this._esc(fileName)}" class="xwp-media-img-sm">`;
        }
        return `<span class="xwp-media-chip">${/^video\//.test(info.mimeType) ? '🎬' : '📎'} ${this._esc(fileName)}</span>`;
    }

    // ─── Users ──────────────────────────────────────────────────────────

    _renderUsers(imp) {
        const users = imp.users || [];
        if (!users.length) return '<div class="xwp-empty">No users.</div>';
        return `
            <div class="xwp-section">
                <h2 class="xwp-section-title">🧑 Users (${users.length})</h2>
                <div class="xwp-table-wrapper">
                    <table class="xwp-table">
                        <thead><tr><th></th><th>User ID</th><th>Handle</th><th>Display Name</th><th>Source</th><th>Confidence</th></tr></thead>
                        <tbody>
                            ${users.map(u => {
                                const key = window.WarrantFlagsKey.xUser(u);
                                const flagged = this.module.isFlagged('users', key);
                                return `<tr class="${flagged ? 'xwp-row-flagged' : ''}"><td>${this._flagBtn('users', key)}</td><td class="xwp-mono">${this._esc(u.user_id)}</td><td>${this._esc(u.handle || '')}</td><td>${this._esc(u.display_name || '')}</td><td>${this._esc(u.source || '')}</td><td>${this._esc(String(u.confidence || ''))}</td></tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // ─── Media lazy loading ─────────────────────────────────────────────

    async _loadLazyImages(root) {
        const scope = root || this.container;
        if (!scope) return;
        const imgs = scope.querySelectorAll('img[data-xwp-media]');
        for (const img of imgs) {
            const diskPath = img.getAttribute('data-xwp-media');
            if (!diskPath || img.src) continue;
            if (this._mediaCache[diskPath]) { img.src = this._mediaCache[diskPath]; continue; }
            try {
                const res = await this.module.readMedia(diskPath);
                if (res && res.data) {
                    const url = `data:${res.mimeType || 'image/jpeg'};base64,${res.data}`;
                    this._mediaCache[diskPath] = url;
                    img.src = url;
                }
            } catch (e) { /* ignore */ }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _fmt(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
    }
    _showLoading(msg) {
        if (!this.container) return;
        this.container.innerHTML = `<div class="xwp-loading"><div class="xwp-spinner"></div><div>${this._esc(msg)}</div></div>`;
    }
    _toast(msg, type) {
        if (typeof viperToast === 'function') { viperToast(msg, type); return; }
        console.log(`[X warrant ${type}] ${msg}`);
    }
    _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    _escJs(s) {
        return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }
}

window.XWarrantUI = XWarrantUI;
