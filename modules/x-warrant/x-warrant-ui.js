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
            this.renderEvidenceBar(this.module.evidenceFiles);
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
        this.renderEvidenceBar(this.module.evidenceFiles);
        this._loadLazyImages();
    }

    _renderEmptyState() {
        return `
            <div class="xwp-empty-state">
                <div class="xwp-empty-icon">𝕏</div>
                <h3 class="xwp-empty-title">No X / Twitter warrant data imported</h3>
                <p class="xwp-empty-text">Add the X production (ZIP or unzipped folder) on the Evidence tab — copied or linked — then click Find in Evidence. Or import one directly. Password-protected ZIPs are supported.</p>
                <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                    <button class="xwp-btn-primary xwp-find-ev" onclick="window.xWarrantUI.findInEvidence()" style="background:transparent;border:1px solid rgba(168,85,247,.6);color:#c084fc;">🔍 Find in Evidence</button>
                    <button class="xwp-btn-primary" onclick="window.xWarrantUI.handleFilePicker()">Import X Production (ZIP or folder)</button>
                </div>
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
                            title="${this._esc(this._evidenceTitle(f))}">
                        <span class="xwp-evidence-icon">${f.alreadyImported ? '✅' : (f.encrypted ? '🔒' : (f.isFolder ? '📁' : '📦'))}</span>
                        <span class="xwp-evidence-name">${this._esc(f.name)}</span>
                        ${f.source === 'evidence-link' ? '<span class="xwp-evidence-size">linked</span>' : ''}
                        ${f.size ? `<span class="xwp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>` : ''}
                    </button>
                `).join('')}
            </div>
        `;
    }

    _evidenceTitle(f) {
        const parts = [f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'];
        if (f.encrypted) parts.push('password-protected — you will be asked for the password');
        if (f.nested) parts.push('production ZIP inside a delivery ZIP');
        if (f.source === 'evidence-link') parts.push('linked from the Evidence tab: ' + f.path);
        return parts.join(' · ');
    }

    /**
     * Ask for a ZIP password in an in-page dialog (Electron has no
     * window.prompt). Resolves the typed string, or null on Cancel. The value
     * is handed straight to the import call and never stored.
     */
    _askPassword(fileName, wasWrong) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'xwp-pw-overlay';
            wrap.setAttribute('style', 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;');
            wrap.innerHTML = `
                <div role="dialog" aria-modal="true" style="background:#1e2130;color:#e6e8ef;border:1px solid #3a3f55;border-radius:10px;padding:20px 22px;width:420px;max-width:92vw;box-shadow:0 10px 40px rgba(0,0,0,.5);font-size:14px;">
                    <div style="font-weight:600;font-size:16px;margin-bottom:6px;">🔒 Password-protected X production</div>
                    <div style="opacity:.85;margin-bottom:12px;word-break:break-all;">${this._esc(fileName || '')}</div>
                    ${wasWrong ? '<div class="xwp-pw-wrong" style="color:#ff8a8a;margin-bottom:8px;">That password did not open the ZIP. Try again.</div>' : ''}
                    <div style="opacity:.8;margin-bottom:6px;">Enter the password the provider sent with the production. VIPER does not save it.</div>
                    <input type="password" class="xwp-pw-input" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid #4a5070;background:#11131c;color:#fff;font-size:14px;">
                    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
                        <button type="button" class="xwp-btn-sm xwp-pw-cancel">Cancel</button>
                        <button type="button" class="xwp-btn-primary xwp-pw-ok">Open</button>
                    </div>
                </div>`;
            document.body.appendChild(wrap);
            const input = wrap.querySelector('.xwp-pw-input');
            const finish = (val) => {
                input.value = '';
                wrap.remove();
                resolve(val);
            };
            wrap.querySelector('.xwp-pw-ok').onclick = () => { if (input.value) finish(input.value); else input.focus(); };
            wrap.querySelector('.xwp-pw-cancel').onclick = () => finish(null);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && input.value) { e.preventDefault(); finish(input.value); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
            });
            setTimeout(() => input.focus(), 0);
        });
    }

    /** Import, asking for the ZIP password when the production needs one. */
    async _runImport(filePath, fileName, isFolder) {
        let password = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                this._showLoading('Importing X production… (large productions may take a minute)');
                return await this.module.importWarrant(filePath, fileName, isFolder, password);
            } catch (err) {
                const code = err && err.code;
                // Background process from before password support: it can
                // see the ZIP is locked but cannot use a password.
                if (!code && /entry encrypted/i.test(String(err && err.message))) {
                    const e2 = new Error('This ZIP is password-protected, but VIPER needs a full restart (close it completely and open it again) before it can ask for the password.');
                    e2.code = 'ZIP_NEEDS_RESTART';
                    throw e2;
                }
                if (code !== 'ZIP_PASSWORD_REQUIRED' && code !== 'ZIP_PASSWORD_WRONG') throw err;
                this.render();
                password = await this._askPassword(fileName, code === 'ZIP_PASSWORD_WRONG' && password != null);
                if (password == null) return null; // cancelled
            }
        }
        throw new Error('Too many wrong password attempts.');
    }

    /**
     * Find in Evidence (same workflow as the Cyber Tips tab): list every ZIP
     * and production folder on this case's Evidence tab, the officer ticks
     * which to import, each is imported in turn (asking for a ZIP password
     * when needed). Items that are not X productions are skipped and named.
     */
    async findInEvidence() {
        try { await this.module.scanForWarrants(); } catch (_) { /* list Evidence anyway */ }
        const cands = this.module.evidenceCandidates();
        if (!cands.length) {
            this._toast('There are no ZIPs or production folders in this case\'s Evidence. Add the X production on the Evidence tab first, or use Import.', 'info');
            return;
        }
        const anyLikely = cands.some(c => c.likely && !c.alreadyImported);
        const rows = cands.map((c, i) => {
            const tick = !c.alreadyImported && (c.likely || (!anyLikely && cands.length === 1));
            const notes = [c.evidenceTag || 'Evidence', c.isFolder ? 'folder' : 'ZIP'];
            if (c.linked) notes.push('linked — stays where it is');
            if (c.detected) notes.push('looks like an X production');
            if (c.encrypted) notes.push('🔒 password-protected');
            if (c.alreadyImported) notes.push('already on this tab');
            return `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;text-align:left">
                <input type="checkbox" class="xwp-ev-pick" data-i="${i}" ${tick ? 'checked' : ''} style="margin-top:3px">
                <span style="flex:1;min-width:0">
                    <span style="display:block;word-break:break-all">${c.isFolder ? '📁' : '📦'} ${this._esc(c.name)}</span>
                    <span style="display:block;font-size:11px;opacity:.65">${this._esc(notes.join(' · '))}</span>
                </span>
            </label>`;
        }).join('');
        const html = `<strong>X / Twitter productions in Evidence</strong><br>
            <span style="font-size:12px;opacity:.75">Tick the ZIPs or folders to import. Likely X productions are ticked for you. You will be asked for the password if a ZIP is protected. Anything that is not an X production is skipped.</span>
            <span style="display:block;max-height:320px;overflow-y:auto;margin-top:10px">${rows}</span>`;
        const ok = (typeof viperConfirm === 'function')
            ? await viperConfirm(html, { okText: 'Import selected' })
            : window.confirm('Import the X productions found in Evidence?');
        // viperConfirm removes its box shortly after resolving — read ticks now.
        const boxes = Array.from(document.querySelectorAll('.xwp-ev-pick'));
        const picked = boxes.length
            ? boxes.filter(cb => cb.checked).map(cb => cands[Number(cb.dataset ? cb.dataset.i : cb.getAttribute('data-i'))]).filter(Boolean)
            : cands.filter(c => c.likely && !c.alreadyImported);
        if (!ok) return;
        if (!picked.length) { this._toast('Nothing was ticked.', 'info'); return; }
        let last = null, added = 0, failed = 0;
        const notX = [];
        for (const c of picked) {
            try {
                const rec = await this._runImport(c.path, c.name, c.isFolder);
                if (rec) { added++; last = rec; }
            } catch (err) {
                if (err && err.code === 'NOT_X_PRODUCTION') notX.push(c.name);
                else { failed++; this._toast(`Could not import ${this._esc(c.name)}: ${this._esc(err && err.message || err)}`, 'error'); }
            }
        }
        if (last) {
            this.activeImportIdx = Math.max(0, this.module.imports.findIndex(i => i.id === last.id));
            this.activeSection = 'overview';
        }
        this.render();
        if (added) this._toast(`Imported ${added} X production${added > 1 ? 's' : ''}${last && last.accountUsername ? ' (@' + this._esc(last.accountUsername) + ')' : ''}`, 'success');
        if (notX.length) this._toast(`Not an X production, skipped: ${this._esc(notX.join(', '))}`, added || failed ? 'info' : 'error');
        return { added, failed, notX };
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

    /** "Show in original" — finds this record in the return as received. */
    _srcBtn(section, item, title, valueLabels) {
        const imp = this.currentImport;
        if (!imp || typeof window === 'undefined' || !window.SourceViewer || !this.module._citationFor) return '';
        const cit = this.module._citationFor(imp, section, item) || {};
        const vals = cit.values || [];
        if (!vals[0]) return '';
        const module = this.module;
        const impId = imp.id;
        const current = () => module.imports.find(i => i && i.id === impId) || imp;
        const spec0 = module._sourceSpec(imp);
        return window.SourceViewer.buttonHtml({
            title,
            values: vals,
            valueLabels: vals.map((_, i) => (valueLabels || [])[i] || (i === 0 ? title : 'related detail')),
            context: [['Return', imp.fileName || '']],
            // Read at click time so a relocated original is used everywhere.
            source: null,
            resolveSource: async () => {
                const sp = module._sourceSpec(current());
                return sp ? Object.assign({ label: String(sp.source.path).split(/[\\/]/).pop() }, sp.source) : null;
            },
            memberHints: cit.memberHints || [],
            expected: spec0 ? spec0.expected : null,
            onRelocate: async (picked, next) => {
                // Kept apart from filePath, which identifies the import.
                const cur = module.imports.find(i => i && i.id === impId);
                if (cur) { cur.sourcePath = next.path; module.saveData(); }
                return next;
            },
        }, { compact: true, label: '' });
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        this.rerenderSection();
    }

    // ─── Import handlers ────────────────────────────────────────────────

    async handleEvidenceClick(filePath, fileName, isFolder) {
        try {
            const record = await this._runImport(filePath, fileName, isFolder);
            if (!record) { this.render(); return; }
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountUsername || fileName}`, 'success');
        } catch (err) { this._toast('Import failed: ' + err.message, 'error'); this.render(); }
    }

    async handleFilePicker() {
        try {
            const picked = await this.module.pickProduction();
            if (!picked) { this.render(); return; }
            const record = await this._runImport(picked.path, picked.name, picked.isFolder);
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
        // Keep the search box focused while typing (it lives inside content).
        const kf = (typeof window !== 'undefined') ? window.VpKeepFocus : null;
        const snap = kf ? kf.capture(content) : null;
        content.innerHTML = this._renderSection();
        if (kf) kf.restore(content, snap);
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
                <button class="xwp-btn-sm xwp-find-ev" onclick="window.xWarrantUI.findInEvidence()">🔍 Find in Evidence</button>
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
                <input type="text" class="xwp-input" id="xwp-conv-filter" placeholder="Search conversations / participants"
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
                                    ${this._srcBtn('threads', { messageId: m.message_id, rawTime: m.created_at_raw, text: m.text, conversation: t.conversation_id, sender: m.sender_id, recipient: m.recipient_id }, m.message_id ? 'Message ID' : 'Message', m.message_id ? ['Message ID', 'Message text'] : null)}
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
                <input type="text" class="xwp-input" id="xwp-tweet-filter" placeholder="Search tweet text"
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
                                    ${this._srcBtn('tweets', { tweetId: t.tweet_id, text: t.full_text, rawTime: t.created_at_raw }, t.tweet_id ? 'Tweet ID' : 'Tweet', t.tweet_id ? ['Tweet ID', 'Tweet text'] : null)}
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
                                            return `<tr class="${flagged ? 'xwp-row-flagged' : ''}"><td style="white-space:nowrap">${this._srcBtn('records', { stem: rec.stem, row }, 'Record')}${this._flagBtn('records', key)}</td>${rec.headers.map(h => `<td>${this._esc(row[h] || '')}</td>`).join('')}</tr>`;
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
                        const isVid = /^video\//.test(info.mimeType || '') && info.diskPath;
                        return `<div class="xwp-media-cell">
                            ${isImg && info.diskPath ? `<img data-xwp-media="${this._escJs(info.diskPath)}" alt="${this._esc(fn)}" class="xwp-media-img">`
                                : isVid ? `<div class="xwp-media-video-thumb" data-vpt-src="${this._esc(info.diskPath)}" title="Play video" onclick="window.xWarrantUI.playVideo(this)"><span class="xwp-video-play-icon">▶</span><div class="xwp-media-placeholder vpt-hide">🎬</div></div>`
                                : `<div class="xwp-media-placeholder">${/^video\//.test(info.mimeType) ? '🎬' : '📄'}</div>`}
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
                                return `<tr class="${flagged ? 'xwp-row-flagged' : ''}"><td style="white-space:nowrap">${this._srcBtn('users', { userId: u.user_id, handle: u.handle, displayName: u.display_name }, 'User ID', ['User ID', 'Handle', 'Display name'])}${this._flagBtn('users', key)}</td><td class="xwp-mono">${this._esc(u.user_id)}</td><td>${this._esc(u.handle || '')}</td><td>${this._esc(u.display_name || '')}</td><td>${this._esc(u.source || '')}</td><td>${this._esc(String(u.confidence || ''))}</td></tr>`;
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
        const vt = (typeof window !== 'undefined') ? window.VpVideoThumbs : null;
        if (vt) vt.hydrate(scope, { getUrl: (diskPath) => this.module.mediaUrl(diskPath) });
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

    /** Media tab: swap a video tile for an inline player (streamed; blob fallback). */
    async playVideo(tile) {
        if (!tile || !tile.parentNode) return;
        const diskPath = tile.getAttribute('data-vpt-src');
        if (!diskPath) return;
        let src = await this.module.mediaUrl(diskPath);
        if (!src) {
            const res = await this.module.readMedia(diskPath);
            if (!res || !res.data) return;
            const bin = atob(res.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            src = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'video/mp4' }));
        }
        if (!tile.parentNode) return;
        const v = document.createElement('video');
        v.className = 'xwp-media-img';
        v.controls = true; v.autoplay = true; v.preload = 'metadata';
        v.src = src;
        tile.parentNode.replaceChild(v, tile);
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
