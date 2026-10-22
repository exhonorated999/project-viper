/**
 * META Warrant Parser — viewer (2026 rebuild).
 *
 * New imports live in an on-disk store (meta-warrant-store.js) and are read
 * one page at a time over IPC: every category Meta sent, message threads,
 * photos / videos / voice notes, IP sightings, a timeline and full-text
 * search, with records and preservation pages merged (each item shows which
 * pages it was on).
 *
 * Imports made by older versions (whole parse in localStorage) are drawn by
 * MetaWarrantLegacyUI exactly as before, under a "Re-import" banner.  The old
 * viewer's inline onclicks call window.metaWarrantUI.<name>(); the methods of
 * the same name here forward to it when the current import is old-style.
 *
 * Everything this file draws is wired through ONE delegated click/change/
 * keydown listener on the container (data-mw="action"), not inline handlers.
 */

class MetaWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeImportIdx = 0;
        this.activeSection = 'overview';
        this.legacy = null;
        this.ov = null;            // overview of the current (new-style) import
        this.ovError = null;
        this.v = this._freshView();
        this._evidenceFiles = [];
        this._io = null;
        this._busy = false;
        this._renderSeq = 0;
        this._contentSeq = 0;
    }

    static get PAGE() { return 50; }

    get container() { return document.getElementById(this.containerId); }
    get currentImport() { return this.module.imports[this.activeImportIdx] || null; }
    _isLegacy(imp) { return MetaWarrantModule.isLegacy(imp === undefined ? this.currentImport : imp); }

    _freshView() {
        return { q: '', offset: 0, sort: 'time-desc', onlyPres: false, page: '', thread: null, mediaKind: '', ip: null };
    }

    // ─── Legacy forwarding (old viewer's inline onclicks) ──────────────

    _legacyUI() {
        if (!this.legacy) this.legacy = new MetaWarrantLegacyUI(this.containerId, this.module);
        this.legacy.activeImportIdx = this.activeImportIdx;
        return this.legacy;
    }
    _clearAllFlags() { return this._isLegacy() ? this._legacyUI()._clearAllFlags() : this._clearFlagsNew(); }
    _pushFlagsToEvidence() { return this._isLegacy() ? this._legacyUI()._pushFlagsToEvidence() : this._pushNew(); }
    _onFlagClick(section, key) { return this._isLegacy() ? this._legacyUI()._onFlagClick(section, key) : this._toggleFlag(key); }
    showPhotoDetail(id) { if (this._isLegacy()) return this._legacyUI().showPhotoDetail(id); }
    switchSection(section) {
        if (this._isLegacy()) return this._legacyUI().switchSection(section);
        this.activeSection = section;
        this.v = this._freshView();
        this._markNav();
        return this._renderContent();
    }
    _loadLazyImages(container) {
        if (this._isLegacy()) return this._legacyUI()._loadLazyImages(container);
        this._hydrateMedia(container);
    }

    // ─── Render ────────────────────────────────────────────────────────

    render() {
        const el = this.container;
        if (!el) return;
        this._bind(el);
        this._disconnectIO();
        if (this.activeImportIdx >= this.module.imports.length) this.activeImportIdx = 0;
        const imp = this.currentImport;

        if (!imp) {
            el.innerHTML = this._renderEmptyState();
            this.renderEvidenceBar(this._evidenceFiles);
            return;
        }

        if (this._isLegacy(imp)) {
            this._legacyUI().render();
            el.insertAdjacentHTML('afterbegin', this._upgradeBanner(imp));
            this.renderEvidenceBar(this._evidenceFiles);
            return;
        }

        const seq = ++this._renderSeq;
        this.ov = null;
        this.ovError = null;
        el.innerHTML = `
            <div class="mwp-layout">
                <div class="mwp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderFlagToolbar()}
                    <nav class="mwp-nav" id="mwp-nav"><div class="mwp-muted">Loading…</div></nav>
                    ${this._renderNavActions()}
                </div>
                <div class="mwp-content" id="mwp-content-area"><div class="mwp-loading"><div class="mwp-spinner"></div><p>Opening return…</p></div></div>
            </div>
            <div id="mwp-evidence-bar"></div>`;
        this.renderEvidenceBar(this._evidenceFiles);

        return this.module.overview(imp).then(r => {
            if (seq !== this._renderSeq) return;
            if (r && r.success) this.ov = r.overview;
            else this.ovError = r || { error: 'Could not open this return.' };
        }).catch(e => {
            if (seq !== this._renderSeq) return;
            this.ovError = { error: e.message || String(e) };
        }).then(() => {
            if (seq !== this._renderSeq) return;
            const nav = document.getElementById('mwp-nav');
            if (nav) nav.innerHTML = this._renderNavItems();
            return this._renderContent();
        });
    }

    _bind(el) {
        el._mwUI = this;
        if (el._mwBound) return;
        el._mwBound = true;
        el.addEventListener('click', (e) => el._mwUI && el._mwUI._onClick(e));
        el.addEventListener('change', (e) => el._mwUI && el._mwUI._onChange(e));
        el.addEventListener('keydown', (e) => el._mwUI && el._mwUI._onKey(e));
        // Media load errors do not bubble — catch them on the way down.  A file
        // the viewer cannot decode must say so, not vanish as a 0×0 image.
        el.addEventListener('error', (e) => el._mwUI && el._mwUI._onMediaError(e), true);
    }

    _onMediaError(e) {
        const t = e && e.target;
        if (!t || !t.classList || !t.closest) return;
        if (!(t.classList.contains('mwp-media-img') || t.classList.contains('mwp-media-video') || t.classList.contains('mwp-media-audio'))) return;
        const slot = t.closest('.mwp-media');
        if (!slot || slot.dataset.failed) return;
        slot.dataset.failed = '1';
        slot.classList.add('mwp-media-missing');
        const ref = slot.dataset.ref || '';
        slot.innerHTML = `<span class="mwp-media-ph" title="${this._attr(ref + ' — the file may be damaged or in a format VIPER cannot show. It is still in the return.')}">⚠️ Cannot display this file (damaged or unsupported format)</span>`;
    }

    _sections() {
        const ov = this.ov;
        if (!ov) return [{ id: 'overview', label: 'Overview', icon: '👤' }];
        const t = ov.totals || {};
        const out = [
            { id: 'overview', label: 'Overview', icon: '👤' },
            { id: 'search', label: 'Search', icon: '🔎' }
        ];
        if (ov.threadCount) out.push({ id: 'messages', label: 'Messages', icon: '💬', count: t.messages || 0 });
        if (ov.media && ov.media.files) out.push({ id: 'media', label: 'Media', icon: '🖼️', count: ov.media.files });
        if (t.ips) out.push({ id: 'ips', label: 'IP Activity', icon: '🌐', count: t.ips });
        if (t.timeline) out.push({ id: 'timeline', label: 'Timeline', icon: '🕐', count: t.timeline });
        const cats = (ov.categories || []).filter(c => (c.items || 0) > 0);
        if (cats.length) out.push({ heading: 'Categories' });
        for (const c of cats) out.push({ id: 'cat:' + c.id, label: c.name || c.id, icon: c.onlyPres ? '🟠' : '·', count: c.items, title: c.onlyPres ? c.onlyPres + ' only in preservation pages' : '' });
        return out;
    }

    _renderNavItems() {
        return this._sections().map(s => s.heading
            ? `<div class="mwp-nav-heading">${this._esc(s.heading)}</div>`
            : `<button class="mwp-nav-item ${s.id === this.activeSection ? 'active' : ''}" data-mw="nav" data-section="${this._attr(s.id)}" title="${this._attr(s.title || s.label)}">
                    <span class="mwp-nav-icon">${s.icon}</span>
                    <span class="mwp-nav-label">${this._esc(s.label)}</span>
                    ${s.count ? `<span class="mwp-nav-count">${Number(s.count).toLocaleString()}</span>` : ''}
               </button>`).join('');
    }

    _markNav() {
        const el = this.container;
        if (!el) return;
        el.querySelectorAll('.mwp-nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === this.activeSection));
    }

    _renderNavActions() {
        return `
            <div class="mwp-nav-actions">
                <button class="mwp-btn-sm" data-mw="pick">+ Import ZIP / Folder</button>
                <button class="mwp-btn-sm" data-mw="upgrade" title="Read the original return again">↻ Re-import</button>
                <button class="mwp-btn-sm danger" data-mw="delete">🗑️ Delete</button>
            </div>`;
    }

    _renderImportSelector() {
        if (this.module.imports.length <= 1) return '';
        return `
            <div class="mwp-import-selector">
                <label class="mwp-label">Import:</label>
                <select class="mwp-select" data-mw="import-select">
                    ${this.module.imports.map((imp, i) => `
                        <option value="${i}" ${i === this.activeImportIdx ? 'selected' : ''}>
                            ${this._esc(imp.service || 'Meta')} — ${this._esc(imp.targetId || imp.fileName)}${this._isLegacy(imp) ? ' (old)' : ''}
                        </option>`).join('')}
                </select>
            </div>`;
    }

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        return `
            <div class="mwp-flag-toolbar">
                <button class="mwp-flag-header-btn" data-mw="flags-clear" title="Flagged item count — click to clear all flags">
                    🚩 Flags <span class="mwp-flag-count-pill" id="mwp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="mwp-flag-toolbar-spacer"></div>
                <button class="mwp-push-btn" id="mwp-push-btn" data-mw="flags-push" ${total ? '' : 'disabled'} title="Push flagged items to the case Evidence module">📥 Push to Evidence</button>
            </div>`;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('mwp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('mwp-push-btn');
        if (btn) btn.disabled = total === 0;
    }

    _upgradeBanner(imp) {
        const n = WarrantFlags.count(imp);
        return `
            <div class="mwp-upgrade-banner">
                <div class="mwp-upgrade-text">
                    <b>This return was imported by an older version of VIPER.</b>
                    Re-import it to see every category Meta sent, videos, voice notes and preservation pages.
                    ${n ? `<br><span class="mwp-warn">You have ${n} flagged item${n === 1 ? '' : 's'} here — push or clear them first; old flags cannot be carried over.</span>` : ''}
                </div>
                <div class="mwp-upgrade-actions">
                    <button class="mwp-btn-sm" data-mw="upgrade">↻ Re-import</button>
                    <button class="mwp-btn-sm" data-mw="locate">📂 Locate original…</button>
                </div>
            </div>`;
    }

    _renderEmptyState() {
        return `
            <div class="mwp-empty-state">
                <div class="mwp-empty-icon">📘</div>
                <h3 class="mwp-empty-title">META Warrant Parser</h3>
                <p class="mwp-empty-desc">Import a Meta (Facebook / Instagram) warrant return — the ZIP as received, or the extracted folder. Every category, message thread, photo, video and voice note is kept, and preservation pages are merged with the records page.</p>
                <div class="mwp-empty-actions">
                    <button class="mwp-btn-primary" data-mw="pick">📂 Select ZIP or Folder</button>
                </div>
                <p class="mwp-empty-hint">ZIP files placed in Evidence or Warrants/Production folders are detected automatically.</p>
            </div>
            <div id="mwp-evidence-bar"></div>`;
    }

    renderEvidenceBar(files) {
        this._evidenceFiles = files || [];
        const bar = document.getElementById('mwp-evidence-bar');
        if (!bar) return;
        if (!this._evidenceFiles.length) { bar.innerHTML = ''; return; }
        bar.innerHTML = `
            <div class="mwp-evidence-bar">
                <div class="mwp-evidence-label">Detected META Warrant Files:</div>
                ${this._evidenceFiles.map(f => `
                    <button class="mwp-evidence-file ${f.alreadyImported ? 'imported' : ''}" data-mw="evimport" data-path="${this._attr(f.path)}" data-name="${this._attr(f.name)}"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="mwp-evidence-icon">${f.alreadyImported ? '✅' : '📦'}</span>
                        <span class="mwp-evidence-name">${this._esc(f.name)}</span>
                        <span class="mwp-evidence-size">${((f.size || 0) / 1024 / 1024).toFixed(1)} MB</span>
                    </button>`).join('')}
            </div>`;
    }

    // ─── Content router ───────────────────────────────────────────────

    async _renderContent() {
        const area = document.getElementById('mwp-content-area');
        if (!area) return;
        this._disconnectIO();
        const seq = ++this._contentSeq;
        const imp = this.currentImport;
        let html;
        try {
            if (this.ovError) html = this._renderOpenError(this.ovError);
            else if (!this.ov) html = '<div class="mwp-loading"><div class="mwp-spinner"></div><p>Opening return…</p></div>';
            else {
                const s = this.activeSection;
                if (s === 'overview') html = this._renderOverview();
                else {
                    area.innerHTML = '<div class="mwp-loading"><div class="mwp-spinner"></div><p>Loading…</p></div>';
                    if (s === 'search') html = await this._renderSearch(imp);
                    else if (s === 'messages') html = await this._renderMessages(imp);
                    else if (s === 'media') html = await this._renderMedia(imp);
                    else if (s === 'ips') html = await this._renderIps(imp);
                    else if (s === 'timeline') html = await this._renderTimeline(imp);
                    else if (s.indexOf('cat:') === 0) html = await this._renderCategory(imp, s.slice(4));
                    else html = '<div class="mwp-empty">Unknown section</div>';
                }
            }
        } catch (e) {
            html = `<div class="mwp-card mwp-card-alert">${this._esc(e.message || String(e))}</div>`;
        }
        if (seq !== this._contentSeq) return;
        area.innerHTML = html;
        this._hydrateMedia(area);
        const focus = area.querySelector('[data-autofocus]');
        if (focus && this.v._refocus) { focus.focus(); try { focus.setSelectionRange(focus.value.length, focus.value.length); } catch (_) {} this.v._refocus = false; }
    }

    _renderOpenError(err) {
        return `
            <div class="mwp-card mwp-card-alert">
                <h3 class="mwp-card-title">This return could not be opened</h3>
                <p>${this._esc(err.error || 'Unknown error')}</p>
                <div class="mwp-row-gap">
                    <button class="mwp-btn-sm" data-mw="upgrade">↻ Re-import</button>
                    <button class="mwp-btn-sm" data-mw="locate">📂 Locate original…</button>
                </div>
            </div>`;
    }

    // ─── Overview ─────────────────────────────────────────────────────

    _renderOverview() {
        const ov = this.ov, imp = this.currentImport;
        const p = ov.params || {};
        const t = ov.totals || {};
        const media = ov.media || {};
        const cats = ov.categories || [];
        const onlyPres = cats.reduce((s, c) => s + (c.perPage ? 0 : (c.onlyPres || 0)), 0);
        const empty = cats.filter(c => !(c.count > 0));
        const known = new Set(['service', 'target', 'account identifier', 'account id', 'account type', 'generated', 'date range']);
        const extra = Object.keys(p.all || {}).filter(k => !known.has(k.toLowerCase()));

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title"><span class="mwp-meta-logo">📘</span> ${this._esc(p.service || ov.service || 'Meta')} Return</h2>
                ${onlyPres ? `<div class="mwp-card mwp-card-alert"><b>${onlyPres.toLocaleString()} item${onlyPres === 1 ? '' : 's'} appear only in preservation pages</b> — they are not in the records page. Look for the 🟠 categories and the “only in preservation” badge.</div>` : ''}
                ${media.missing ? `<div class="mwp-card mwp-card-alert"><b>${media.missing} media file${media.missing === 1 ? ' is' : 's are'} referenced but not in the return.</b>
                    <details><summary>Show</summary><div class="mwp-mono mwp-small">${(media.missingRefs || []).map(r => this._esc(r)).join('<br>')}${media.missing > (media.missingRefs || []).length ? '<br>…' : ''}</div></details></div>` : ''}
                <div class="mwp-card-grid">
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">Request Parameters</h3>
                        <div class="mwp-kv-list">
                            ${this._kvRow('Service', p.service || ov.service)}
                            ${this._kvRow('Target', p.target)}
                            ${this._kvRow('Account ID', p.accountId)}
                            ${this._kvRow('Account Type', p.accountType)}
                            ${this._kvRow('Generated', p.generated)}
                            ${this._kvRow('Date Range', p.dateRange)}
                            ${extra.map(k => this._kvRow(k, p.all[k])).join('')}
                        </div>
                    </div>
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">Return Pages</h3>
                        <table class="mwp-table">
                            <thead><tr><th></th><th>Page</th><th>Kind</th><th>Items</th></tr></thead>
                            <tbody>${(ov.pages || []).map((pg, i) => `
                                <tr><td>${this._pageBadge(i)}</td><td class="mwp-mono">${this._esc(pg.name)}</td><td>${this._esc(pg.kind)}</td><td>${Number(pg.items || 0).toLocaleString()}</td></tr>`).join('')}
                            </tbody>
                        </table>
                        ${(ov.skippedPages || []).length ? `<p class="mwp-warn mwp-small">Not read: ${(ov.skippedPages || []).map(s => this._esc(s.name || s)).join(', ')}</p>` : ''}
                        <div class="mwp-kv-list mwp-top-gap">
                            ${this._kvRow('Source', imp.fileName)}
                            ${this._kvRow('Imported', imp.importedAt ? new Date(imp.importedAt).toLocaleString() : '')}
                        </div>
                    </div>
                </div>
                <div class="mwp-stats-grid">
                    ${this._statBadge('Categories', t.categories || cats.length, '🗂️')}
                    ${this._statBadge('Items', t.items || 0, '📄')}
                    ${this._statBadge('Threads', t.threads || ov.threadCount || 0, '💬')}
                    ${this._statBadge('Messages', t.messages || 0, '✉️')}
                    ${this._statBadge('Media files', media.files || 0, '🖼️')}
                    ${this._statBadge('IP sightings', t.ips || 0, '🌐')}
                    ${this._statBadge('Timeline events', t.timeline || 0, '🕐')}
                </div>
                ${media.encrypted ? '<p class="mwp-muted mwp-small">🔒 Media from this return is stored encrypted in the case folder; it is decrypted only while you view it.</p>' : ''}
                <div class="mwp-card">
                    <h3 class="mwp-card-title">Categories</h3>
                    <table class="mwp-table">
                        <thead><tr><th>Category</th><th>Records</th><th>Only in preservation</th><th>Media</th><th>Pages</th></tr></thead>
                        <tbody>${cats.filter(c => c.count > 0).map(c => `
                            <tr class="mwp-row-click" data-mw="nav" data-section="${this._attr(c.items ? 'cat:' + c.id : 'messages')}">
                                <td>${this._esc(c.name || c.id)}</td>
                                <td>${Number(c.count).toLocaleString()}${c.threads ? ` <span class="mwp-muted">(${c.threads} threads)</span>` : ''}</td>
                                <td>${c.perPage ? '<span class="mwp-muted">per page</span>' : (c.onlyPres ? `<span class="mwp-badge mwp-badge-only">${c.onlyPres}</span>` : '—')}</td>
                                <td>${c.media || '—'}</td>
                                <td>${(c.pages || []).map(i => this._pageBadge(i)).join('')}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    ${empty.length ? `
                    <details class="mwp-top-gap"><summary>${empty.length} categor${empty.length === 1 ? 'y' : 'ies'} with no records</summary>
                        <div class="mwp-empty-cats">${empty.map(c => `
                            <div class="mwp-empty-cat"><b>${this._esc(c.name || c.id)}</b>${(c.def || []).length ? `<div class="mwp-muted mwp-small">${this._esc(c.def.join(' '))}</div>` : ''}</div>`).join('')}
                        </div>
                    </details>` : ''}
                </div>
            </div>`;
    }

    // ─── Category items ───────────────────────────────────────────────

    async _renderCategory(imp, catId) {
        const cat = (this.ov.categories || []).find(c => c.id === catId);
        if (!cat) return '<div class="mwp-empty">Category not found</div>';
        const v = this.v;
        const req = { kind: 'items', cat: catId, q: v.q, sort: v.sort, offset: v.offset, limit: MetaWarrantUI.PAGE, onlyPres: !!v.onlyPres };
        if (v.page !== '') req.page = Number(v.page);
        const r = await this._q(imp, req);
        const rp = this._recordsPage();
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">${this._esc(cat.name || cat.id)} <span class="mwp-muted mwp-small">${Number(cat.items || 0).toLocaleString()}</span></h2>
                ${this._renderDef(cat)}
                <div class="mwp-controls">
                    ${this._searchBox('Search this category…')}
                    <select class="mwp-select" data-mw="sort">
                        <option value="time-desc" ${v.sort === 'time-desc' ? 'selected' : ''}>Newest first</option>
                        <option value="time-asc" ${v.sort === 'time-asc' ? 'selected' : ''}>Oldest first</option>
                        <option value="" ${!v.sort ? 'selected' : ''}>As in the return</option>
                    </select>
                    ${(cat.pages || []).length > 1 ? `<select class="mwp-select" data-mw="pagefilter">
                        <option value="">All pages</option>
                        ${cat.pages.map(i => `<option value="${i}" ${String(v.page) === String(i) ? 'selected' : ''}>${this._esc(this._pageName(i))}</option>`).join('')}
                    </select>` : ''}
                    ${rp >= 0 && cat.onlyPres ? `<label class="mwp-check"><input type="checkbox" data-mw="onlypres" ${v.onlyPres ? 'checked' : ''}> Only in preservation (${cat.onlyPres})</label>` : ''}
                </div>
                ${this._countLine(r)}
                <div class="mwp-item-list">
                    ${(r.rows || []).map(it => this._renderItem(catId, it)).join('') || '<div class="mwp-empty">No matching records</div>'}
                </div>
                ${this._pager(r)}
            </div>`;
    }

    _renderDef(cat) {
        const def = (cat.def || []).join(' ');
        const notes = (cat.notes || []).join(' ');
        if (!def && !notes) return '';
        return `<details class="mwp-def"><summary>What Meta says this category is</summary>
                    ${def ? `<p>${this._esc(def)}</p>` : ''}${notes ? `<p class="mwp-muted">${this._esc(notes)}</p>` : ''}</details>`;
    }

    _renderItem(catId, it) {
        const key = MetaWarrantModule.itemFlagKey(catId, it.key);
        const on = this.module.isFlagged('meta', key);
        const title = (window.MetaInterpret ? window.MetaInterpret.summary(it.f, 140) : '') || '(no text)';
        return `
            <div class="mwp-item ${on ? 'mwp-flagged' : ''}" data-flag-row="${this._attr(key)}">
                <div class="mwp-item-head">
                    <span class="mwp-item-time">${this._esc(it.t || '')}</span>
                    ${(it.g || []).length ? `<span class="mwp-tag">${this._esc(it.g.join(' › '))}</span>` : ''}
                    <span class="mwp-item-title">${this._esc(title)}</span>
                    <span class="mwp-item-badges">${this._srcBadges(it.src)}</span>
                    ${this._srcBtnFor(it.f, it.t, it.src, 'Record')}
                    ${this._flagBtn(key, on)}
                </div>
                ${this._renderFields(it.f)}
            </div>`;
    }

    // ─── Messages ─────────────────────────────────────────────────────

    async _renderMessages(imp) {
        return this.v.thread ? this._renderThread(imp, this.v.thread) : this._renderThreadList(imp);
    }

    async _renderThreadList(imp) {
        const v = this.v;
        const r = await this._q(imp, { kind: 'threads', q: v.q, offset: v.offset, limit: MetaWarrantUI.PAGE });
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">💬 Messages <span class="mwp-muted mwp-small">${Number(this.ov.threadCount || 0).toLocaleString()} threads</span></h2>
                <div class="mwp-controls">${this._searchBox('Search names, participants or message text…')}</div>
                ${this._countLine(r)}
                <div class="mwp-thread-list">
                    ${(r.rows || []).map(t => `
                        <div class="mwp-card mwp-thread-card mwp-row-click" data-mw="thread" data-thread="${this._attr(t.key)}">
                            <div class="mwp-thread-header">
                                <div class="mwp-thread-info">
                                    <span class="mwp-thread-id">${this._esc(t.name || t.threadId || 'Thread')}</span>
                                    ${t.name && t.threadId ? `<span class="mwp-muted mwp-small mwp-mono">${this._esc(t.threadId)}</span>` : ''}
                                    <span class="mwp-thread-count">${t.count} message${t.count === 1 ? '' : 's'}</span>
                                    ${t.media ? `<span class="mwp-tag">${t.media} media</span>` : ''}
                                    ${t.onlyPres ? `<span class="mwp-badge mwp-badge-only" title="Messages only in preservation pages">${t.onlyPres} only in preservation</span>` : ''}
                                    ${this._srcBadges(t.src, true)}
                                </div>
                                <span class="mwp-muted mwp-small">${this._esc(t.first || '')}${t.last && t.last !== t.first ? ' → ' + this._esc(t.last) : ''}</span>
                            </div>
                            <div class="mwp-thread-participants">${(t.participants || []).map(p => `<span class="mwp-participant">${this._esc(p)}</span>`).join('')}</div>
                        </div>`).join('') || '<div class="mwp-empty">No matching threads</div>'}
                </div>
                ${this._pager(r)}
            </div>`;
    }

    async _renderThread(imp, threadKey) {
        const v = this.v;
        const list = await this._q(imp, { kind: 'threads', q: '', offset: 0, limit: 500 });
        let th = (list.rows || []).find(t => t.key === threadKey);
        if (!th && list.total > 500) {
            for (let off = 500; off < list.total && !th; off += 500) {
                const more = await this._q(imp, { kind: 'threads', q: '', offset: off, limit: 500 });
                th = (more.rows || []).find(t => t.key === threadKey);
            }
        }
        const r = await this._q(imp, { kind: 'thread', thread: threadKey, q: v.q, offset: v.offset, limit: 100 });
        return `
            <div class="mwp-section">
                <div><button class="mwp-btn-sm" data-mw="thread-back">← All threads</button></div>
                <h2 class="mwp-section-title">💬 ${this._esc((th && (th.name || th.threadId)) || 'Thread')}</h2>
                ${th ? `<div class="mwp-card">
                    <div class="mwp-kv-list">
                        ${this._kvRow('Thread ID', th.threadId)}
                        ${this._kvRow('Participants', (th.participants || []).join(', '))}
                        ${this._kvRow('Past participants', (th.past || []).join(', '))}
                        ${this._kvRow('Messages', th.count)}
                    </div>
                    ${(th.header || []).length ? `<details class="mwp-top-gap"><summary>Thread details</summary>${this._renderFields(th.header)}</details>` : ''}
                </div>` : ''}
                <div class="mwp-controls">${this._searchBox('Search this thread…')}</div>
                ${this._countLine(r)}
                <div class="mwp-msg-list">
                    ${(r.rows || []).map(m => this._renderMessage(threadKey, m)).join('') || '<div class="mwp-empty">No matching messages</div>'}
                </div>
                ${this._pager(r)}
            </div>`;
    }

    _renderMessage(threadKey, m) {
        const key = MetaWarrantModule.msgFlagKey(threadKey, m.key);
        const on = this.module.isFlagged('meta', key);
        const rest = (m.f || []).filter(f => !/^(author|sender|from|sent|time|timestamp|date|body|text|message|content)$/i.test(f.k || ''));
        return `
            <div class="mwp-message ${on ? 'mwp-flagged' : ''}" data-flag-row="${this._attr(key)}">
                <div class="mwp-msg-header">
                    <span class="mwp-msg-author">${this._esc(m.author || '—')}</span>
                    <span class="mwp-msg-time">${this._esc(m.sent || '')}</span>
                    <span class="mwp-item-badges">${this._srcBadges(m.src)}</span>
                    ${this._srcBtnFor(m.f, m.sent, m.src, 'Message', m.author)}
                    ${this._flagBtn(key, on)}
                </div>
                ${m.body ? `<div class="mwp-msg-body">${this._esc(m.body).replace(/\n/g, '<br>')}</div>` : ''}
                ${rest.length ? this._renderFields(rest) : ''}
            </div>`;
    }

    // ─── Media ────────────────────────────────────────────────────────

    async _renderMedia(imp) {
        const v = this.v;
        const r = await this._q(imp, { kind: 'media', mediaKind: v.mediaKind, q: v.q, offset: v.offset, limit: 60 });
        const kinds = [['', 'All'], ['image', 'Photos'], ['video', 'Videos'], ['audio', 'Audio / voice'], ['file', 'Other files']];
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🖼️ Media</h2>
                <div class="mwp-controls">
                    <select class="mwp-select" data-mw="mediakind">${kinds.map(([k, l]) => `<option value="${k}" ${v.mediaKind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
                    ${this._searchBox('File name…')}
                </div>
                ${this._countLine(r)}
                <div class="mwp-media-grid">
                    ${(r.rows || []).map(m => `
                        <div class="mwp-media-tile">
                            ${this._mediaSlot(m.ref, m.kind, true)}
                            <div class="mwp-media-cap">
                                <span class="mwp-mono mwp-small" title="${this._attr(m.ref)}">${this._esc(String(m.orig || m.ref).split('/').pop())}</span>
                                ${m.sniffed ? '<span class="mwp-tag" title="The file extension did not match its contents">relabelled</span>' : ''}
                                <span class="mwp-muted mwp-small">${this._fmtSize(m.size)}${m.used ? ' · used ' + m.used + '×' : ' · not referenced'}</span>
                                ${(m.use || []).slice(0, 1).map(u => `<button class="mwp-link-btn" data-mw="openkey" data-key="${this._attr(u.th ? MetaWarrantModule.msgFlagKey(u.th, u.k) : MetaWarrantModule.itemFlagKey(u.c, u.k))}">${this._esc(u.t || 'open')} · ${this._esc(u.th ? 'message' : this._catName(u.c))}</button>`).join('')}
                            </div>
                        </div>`).join('') || '<div class="mwp-empty">No media</div>'}
                </div>
                ${this._pager(r)}
            </div>`;
    }

    // ─── IPs ──────────────────────────────────────────────────────────

    async _renderIps(imp) {
        const v = this.v;
        if (v.ip) {
            const r = await this._q(imp, { kind: 'ips', q: v.ip, offset: 0, limit: 500 });
            const rows = (r.rows || []).filter(s => s.ip === v.ip);
            return `
                <div class="mwp-section">
                    <div><button class="mwp-btn-sm" data-mw="ip-back">← All IP addresses</button></div>
                    <h2 class="mwp-section-title">🌐 <span class="mwp-mono">${this._esc(v.ip)}</span>
                        <button class="mwp-arin-btn" data-mw="arin" data-ip="${this._attr(v.ip)}" title="ARIN WHOIS Lookup">🌐</button></h2>
                    <table class="mwp-table">
                        <thead><tr><th>Time</th><th>Category</th><th>Field</th><th></th><th>Flag</th></tr></thead>
                        <tbody>${rows.map(s => {
                            const key = MetaWarrantModule.itemFlagKey(s.c, s.k);
                            const on = this.module.isFlagged('meta', key);
                            return `<tr class="${on ? 'mwp-row-flagged' : ''}" data-flag-row="${this._attr(key)}">
                                <td>${this._esc(s.t || '—')}</td><td>${this._esc(this._catName(s.c))}</td><td>${this._esc(s.f || '')}</td>
                                <td><button class="mwp-link-btn" data-mw="openkey" data-key="${this._attr(key)}">Open record</button></td>
                                <td>${this._flagBtn(key, on)}</td></tr>`;
                        }).join('')}</tbody>
                    </table>
                    ${r.total > 500 ? '<p class="mwp-muted mwp-small">Showing the first 500 sightings.</p>' : ''}
                </div>`;
        }
        const r = await this._q(imp, { kind: 'ipSummary', offset: v.offset, limit: 100 });
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🌐 IP Activity <span class="mwp-muted mwp-small">${Number((this.ov.totals || {}).ips || 0).toLocaleString()} sightings</span></h2>
                ${this._countLine(r, 'addresses')}
                <table class="mwp-table">
                    <thead><tr><th>IP Address</th><th>ARIN</th><th>Seen</th><th>First</th><th>Last</th><th>Categories</th></tr></thead>
                    <tbody>${(r.rows || []).map(a => `
                        <tr class="mwp-row-click" data-mw="ip" data-ip="${this._attr(a.ip)}">
                            <td class="mwp-mono">${this._esc(a.ip)}</td>
                            <td><button class="mwp-arin-btn" data-mw="arin" data-ip="${this._attr(a.ip)}" title="ARIN WHOIS Lookup">🌐</button></td>
                            <td>${a.count}</td><td>${this._esc(a.first || '—')}</td><td>${this._esc(a.last || '—')}</td>
                            <td class="mwp-small">${(a.cats || []).map(c => this._esc(this._catName(c))).join(', ')}</td>
                        </tr>`).join('')}</tbody>
                </table>
                ${this._pager(r)}
            </div>`;
    }

    // ─── Timeline / Search ────────────────────────────────────────────

    _eventStyle(e) {
        if (e && e.th) return { cls: 'message', icon: '💬' };
        const c = String((e && e.c) || '').toLowerCase();
        if (/ip_address|registration_ip|login|logout|session/.test(c)) return { cls: 'ip', icon: '🌐' };
        if (/photo|video|picture|media|stor(y|ies)|reel/.test(c)) return { cls: 'photo', icon: '🖼️' };
        if (/post|comment|wall|status/.test(c)) return { cls: 'wallpost', icon: '📝' };
        if (/share|like|follow|friend/.test(c)) return { cls: 'share', icon: '👥' };
        return { cls: 'status', icon: '•' };
    }

    async _renderTimeline(imp) {
        const v = this.v;
        const r = await this._q(imp, { kind: 'timeline', q: v.q, offset: v.offset, limit: 100 });
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🕐 Timeline</h2>
                <div class="mwp-controls">${this._searchBox('Filter events…')}</div>
                ${this._countLine(r, 'events')}
                <div class="mwp-timeline">
                    ${(r.rows || []).map(e => {
                        const key = e.th ? MetaWarrantModule.msgFlagKey(e.th, e.k) : MetaWarrantModule.itemFlagKey(e.c, e.k);
                        const ev = this._eventStyle(e);
                        return `<div class="mwp-timeline-event mwp-event-${ev.cls} mwp-row-click" data-mw="openkey" data-key="${this._attr(key)}">
                            <div class="mwp-timeline-dot">${ev.icon}</div>
                            <div class="mwp-timeline-content">
                                <span class="mwp-timeline-time">${this._esc(e.t)}</span>
                                <span class="mwp-tag">${this._esc(e.th ? 'Message' : this._catName(e.c))}</span>
                                <span class="mwp-timeline-desc">${this._esc(e.s || '')}</span>
                            </div></div>`;
                    }).join('') || '<div class="mwp-empty">No events</div>'}
                </div>
                ${this._pager(r)}
            </div>`;
    }

    async _renderSearch(imp) {
        const v = this.v;
        const r = v.q ? await this._q(imp, { kind: 'search', q: v.q, limit: 200 }) : null;
        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🔎 Search the whole return</h2>
                <div class="mwp-controls">${this._searchBox('Words, names, numbers, IP addresses… then Enter')}</div>
                ${r ? `<div class="mwp-muted mwp-small">${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.truncated ? ' — showing the first ' + r.rows.length : ''}</div>
                <div class="mwp-search-results">
                    ${(r.rows || []).map(x => {
                        const key = x.type === 'message' ? MetaWarrantModule.msgFlagKey(x.thread, x.key) : MetaWarrantModule.itemFlagKey(x.cat, x.key);
                        return `<div class="mwp-search-hit mwp-row-click" data-mw="openkey" data-key="${this._attr(key)}">
                            <div><span class="mwp-tag">${x.type === 'message' ? '💬 ' + this._esc(x.threadName || 'Message') : this._esc(x.catName || x.cat)}</span>
                                 <span class="mwp-muted mwp-small">${this._esc(x.t || '')}${x.author ? ' · ' + this._esc(x.author) : ''}</span></div>
                            <div class="mwp-snippet">${this._highlight(x.text, v.q)}</div></div>`;
                    }).join('') || '<div class="mwp-empty">Nothing found</div>'}
                </div>` : '<p class="mwp-muted">Searches every category and every message of this return.</p>'}
            </div>`;
    }

    // ─── One record in a popup (search / timeline / media / IP links) ──

    async _openKey(flagKey) {
        const imp = this.currentImport;
        let r;
        try { r = await this._q(imp, { kind: 'keys', keys: [flagKey] }); }
        catch (e) { this._toast(e.message, 'error'); return; }
        const it = (r.items || [])[0], m = (r.messages || [])[0];
        let body = '';
        if (it) body = `<h3 class="mwp-card-title">${this._esc(it.catName || it.cat)}</h3>${this._renderItem(it.cat, it)}`;
        else if (m) body = `<h3 class="mwp-card-title">💬 ${this._esc(m.threadName || m.threadId || 'Message')}</h3>
                            <div class="mwp-muted mwp-small">${this._esc((m.participants || []).join(', '))}</div>
                            ${this._renderMessage(m.thread, m)}
                            <button class="mwp-btn-sm mwp-top-gap" data-mw="goto-thread" data-thread="${this._attr(m.thread)}">Open the whole thread</button>`;
        else body = '<div class="mwp-empty">This record is not in the current import.</div>';
        this._showModal(body);
    }

    _showModal(html) {
        this._closeModal();
        const el = this.container;
        if (!el) return;
        const wrap = document.createElement('div');
        wrap.className = 'mwp-lightbox mwp-modal';
        wrap.id = 'mwp-modal';
        wrap.innerHTML = `<div class="mwp-lightbox-content mwp-modal-content">
                <button class="mwp-lightbox-close" data-mw="modal-close" title="Close">✕</button>
                ${html}</div>`;
        el.appendChild(wrap);
        this._hydrateMedia(wrap, true);
    }

    _closeModal() {
        const m = document.getElementById('mwp-modal');
        if (m && m.parentNode) m.parentNode.removeChild(m);
    }

    // ─── Field tree + media ───────────────────────────────────────────

    _renderFields(fields, depth) {
        depth = depth || 0;
        if (!fields || !fields.length) return '';
        if (depth > 8) return '<div class="mwp-muted mwp-small">…</div>';
        return `<div class="mwp-ftree">${fields.map(f => {
            const v = (f && f.v) || {};
            const t = (v.t || []).filter(l => String(l).trim() !== '');
            const media = (v.m || []).map(m => this._mediaSlot(m.s, m.k)).join('');
            const recs = (v.r || []).map(rec => `<div class="mwp-frec">${this._renderFields(rec, depth + 1)}</div>`).join('');
            if (!t.length && !media && !recs) return '';
            return `<div class="mwp-f">${f.k ? `<span class="mwp-fk">${this._esc(f.k)}</span>` : ''}<span class="mwp-fv">${t.map(l => this._esc(l)).join('<br>')}${media}${recs}</span></div>`;
        }).join('')}</div>`;
    }

    _mediaSlot(ref, kind, tile) {
        const s = String(ref || '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
            // Not part of the return (web link) — shown, never fetched.
            return `<span class="mwp-mono mwp-small mwp-ext" title="Link in the return (not downloaded)">🔗 ${this._esc(s)}</span>`;
        }
        return `<div class="mwp-media ${tile ? 'mwp-media-big' : ''}" data-ref="${this._attr(s)}" data-kind="${this._attr(kind || 'file')}"><span class="mwp-media-ph">${this._kindIcon(kind)} ${this._esc(s.split('/').pop())}</span></div>`;
    }

    _kindIcon(k) { return k === 'video' ? '🎬' : k === 'audio' ? '🎙️' : k === 'image' ? '🖼️' : '📎'; }

    _disconnectIO() { if (this._io) { try { this._io.disconnect(); } catch (_) {} this._io = null; } }

    _hydrateMedia(root, now) {
        if (!root || !root.querySelectorAll) return;
        const slots = Array.from(root.querySelectorAll('.mwp-media[data-ref]:not([data-done])'));
        if (!slots.length) return;
        const IO = typeof window !== 'undefined' && window.IntersectionObserver;
        if (!IO || now) { slots.slice(0, 200).forEach(s => this._loadSlot(s)); return; }
        if (!this._io) {
            this._io = new IO((entries) => {
                for (const e of entries) if (e.isIntersecting) { this._io && this._io.unobserve(e.target); this._loadSlot(e.target); }
            }, { rootMargin: '300px' });
        }
        slots.forEach(s => this._io.observe(s));
    }

    async _loadSlot(slot) {
        if (slot.dataset.done) return;
        slot.dataset.done = '1';
        const imp = this.currentImport;
        const ref = slot.dataset.ref;
        let r;
        try { r = await this.module.mediaUrl(imp, ref); } catch (e) { r = { success: false, error: e.message }; }
        if (!r || !r.success) {
            slot.classList.add(r && r.locked ? 'mwp-media-locked' : 'mwp-media-missing');
            slot.innerHTML = r && r.locked
                ? '<span class="mwp-media-ph">🔒 Unlock VIPER to view this media</span>'
                : `<span class="mwp-media-ph" title="${this._attr(ref)}">⚠️ Not in the return: ${this._esc(String(ref).split('/').pop())}</span>`;
            return;
        }
        const kind = r.kind && r.kind !== 'file' ? r.kind : slot.dataset.kind;
        const url = this._attr(r.fileUrl);
        const cap = `<div class="mwp-media-name mwp-small mwp-muted">${this._esc(r.name || '')}${r.sniffed ? ' · relabelled (contents did not match the extension)' : ''}</div>`;
        if (kind === 'image') slot.innerHTML = `<img class="mwp-media-img" src="${url}" alt="" data-mw="zoom" data-ref="${this._attr(ref)}" loading="lazy">`;
        else if (kind === 'video') {
            slot.innerHTML = `<video class="mwp-media-video" src="${url}" controls preload="metadata"></video>${cap}`;
            this._videoPoster(slot, (imp && imp.storeKey ? imp.storeKey : '') + '|' + ref);
        }
        else if (kind === 'audio') slot.innerHTML = `<audio class="mwp-media-audio" src="${url}" controls preload="metadata"></audio>${cap}`;
        else slot.innerHTML = `<span class="mwp-media-ph">📎 ${this._esc(r.name || ref)} · ${this._fmtSize(r.size)}</span>`;
    }

    /**
     * Give a stored video a real poster frame. preload="metadata" alone paints
     * nothing for many files, so tiles looked empty. Decoded once per
     * storeKey|ref by the shared VpVideoThumbs (2 at a time, cached).
     */
    _videoPoster(slot, key) {
        const vt = (typeof window !== 'undefined') ? window.VpVideoThumbs : null;
        const v = slot && slot.querySelector && slot.querySelector('video.mwp-media-video');
        if (!vt || !v || !key) return;
        v.setAttribute('data-vpt-src', key);
        vt.hydrate(slot, {
            selector: 'video[data-vpt-src]',
            getUrl: (k, el) => el.getAttribute('src'),
            apply: (el, dataUrl) => { if (!el.getAttribute('poster')) el.setAttribute('poster', dataUrl); }
        });
    }

    // ─── Badges, source buttons, flags ───────────────────────────────

    _recordsPage() { return ((this.ov && this.ov.pages) || []).findIndex(p => p.kind === 'records'); }
    _pageName(i) { const p = ((this.ov && this.ov.pages) || [])[i]; return p ? p.name : 'page ' + (i + 1); }
    _catName(id) { const c = ((this.ov && this.ov.categories) || []).find(x => x.id === id); return c ? (c.name || c.id) : (id || ''); }

    _pageBadge(i) {
        const pages = (this.ov && this.ov.pages) || [];
        const p = pages[i];
        let label = '#' + (i + 1), cls = '';
        if (p && p.kind === 'records') { label = 'R'; cls = 'mwp-badge-rec'; }
        else if (p && p.kind === 'preservation') {
            label = 'P' + (pages.slice(0, i + 1).filter(x => x.kind === 'preservation').length);
            cls = 'mwp-badge-pres';
        }
        return `<span class="mwp-badge ${cls}" title="${this._attr(p ? p.name : '')}">${label}</span>`;
    }

    _srcBadges(src, noOnly) {
        src = src || [];
        const rp = this._recordsPage();
        const only = !noOnly && rp >= 0 && src.indexOf(rp) < 0;
        return src.map(i => this._pageBadge(i)).join('') + (only ? '<span class="mwp-badge mwp-badge-only" title="Not in the records page">only in preservation</span>' : '');
    }

    _srcBtnFor(fields, t, src, title, extra) {
        const imp = this.currentImport;
        if (!imp || !window.SourceViewer) return '';
        const primary = MetaWarrantModule.primaryValue(fields);
        if (!primary) return '';
        const hints = [];
        for (const i of (src || [])) { const b = MetaWarrantModule.pageLabel(((this.ov && this.ov.pages) || [])[i], i); if (hints.indexOf(b) < 0) hints.push(b); }
        const module = this.module, impId = imp.id;
        const current = () => module.imports.find(i => i && i.id === impId) || imp;
        const values = [primary], labels = [title];
        const tl = MetaWarrantModule.rawTimeLine(fields, t);
        if (tl) { values.push(tl); labels.push('Time'); }
        if (extra) { values.push(String(extra)); labels.push('related detail'); }
        return window.SourceViewer.buttonHtml({
            title, values, valueLabels: labels,
            context: [['Return', imp.fileName || '']],
            source: null,
            resolveSource: async () => {
                const p = current().sourcePath || current().filePath;
                return p ? { path: p, label: String(p).split(/[\\/]/).pop() } : null;
            },
            memberHints: hints,
            expected: imp.sourceIntegrity || null,
            onRelocate: async (picked, next) => {
                const cur = module.imports.find(i => i && i.id === impId);
                if (cur) { cur.sourcePath = next.path; module.saveData(); }
                return next;
            }
        }, { compact: true, label: '' });
    }

    _flagBtn(key, on) {
        return `<button class="mwp-flag-btn ${on ? 'on' : ''}" data-mw="flag" data-key="${this._attr(key)}" title="${on ? 'Unflag' : 'Flag for evidence bundle'}">🚩</button>`;
    }

    _toggleFlag(key) {
        const on = this.module.toggleFlag('meta', key);
        const el = this.container;
        if (el) {
            el.querySelectorAll('.mwp-flag-btn[data-key]').forEach(b => {
                if (b.dataset.key !== key) return;
                b.classList.toggle('on', on);
                b.title = on ? 'Unflag' : 'Flag for evidence bundle';
            });
            el.querySelectorAll('[data-flag-row]').forEach(r => {
                if (r.dataset.flagRow !== key) return;
                r.classList.toggle(r.tagName === 'TR' ? 'mwp-row-flagged' : 'mwp-flagged', on);
            });
        }
        this._refreshFlagToolbar();
        return on;
    }

    async _clearFlagsNew() {
        const total = this.module.flagCount();
        if (!total) return;
        if (!(await this._confirm(`Clear all ${total} flag(s)?`, 'Clear', true))) return;
        this.module.clearFlags();
        this._refreshFlagToolbar();
        return this._renderContent();
    }

    async _pushNew() {
        const total = this.module.flagCount();
        if (!total) { this._toast('No items flagged yet. Click 🚩 on items first.', 'info'); return; }
        if (!(await this._confirm(`Push ${total} flagged item${total === 1 ? '' : 's'} to the case Evidence module as a single bundle?`, 'Push', false))) return;
        const btn = document.getElementById('mwp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) { this.module.clearFlags(); await this._renderContent(); }
        } finally {
            if (btn) btn.innerHTML = '📥 Push to Evidence';
            this._refreshFlagToolbar();
        }
    }

    // ─── Import / re-import / delete ─────────────────────────────────

    async _runImport(label, fn) {
        if (this._busy) { this._toast('An import is already running.', 'info'); return null; }
        this._busy = true;
        const el = this.container;
        if (el) el.innerHTML = `<div class="mwp-loading mwp-progress"><div class="mwp-spinner"></div>
                <p id="mwp-progress-label">${this._esc(label)}</p>
                <div class="mwp-progress-bar"><div id="mwp-progress-fill" style="width:0%"></div></div>
                <p class="mwp-muted mwp-small">Large Instagram returns can take a few minutes. You can keep working in other tabs.</p></div>`;
        let off = () => {};
        const api = window.electronAPI;
        if (api && typeof api.onMetaWarrantImportProgress === 'function') {
            off = api.onMetaWarrantImportProgress((p) => {
                if (!p || String(p.caseNumber) !== String(this.module.caseNumber)) return;
                this._showProgress(p);
            });
        }
        try {
            const rec = await fn();
            if (rec) {
                this.activeImportIdx = Math.max(0, this.module.imports.findIndex(i => i.id === rec.id));
                this.activeSection = 'overview';
                this.v = this._freshView();
                this._toast(`Imported: ${rec.service || 'Meta'} — ${rec.targetId || rec.fileName}`, 'success');
            }
            return rec;
        } catch (err) {
            this._toast('Import failed: ' + (err.message || err), 'error');
            return null;
        } finally {
            try { off(); } catch (_) {}
            this._busy = false;
            this.render();
        }
    }

    _showProgress(p) {
        const labels = { pages: 'Reading pages', merge: 'Merging records and preservations', media: 'Copying media', store: 'Saving', done: 'Done' };
        const l = document.getElementById('mwp-progress-label');
        const f = document.getElementById('mwp-progress-fill');
        const n = p.total ? ` ${Number(p.done || 0).toLocaleString()} of ${Number(p.total).toLocaleString()}` : '';
        if (l) l.textContent = (labels[p.phase] || p.label || 'Working') + n + (p.label && labels[p.phase] && p.phase === 'pages' ? ' — ' + p.label : '');
        if (f) f.style.width = (p.total ? Math.min(100, Math.round(100 * (p.done || 0) / p.total)) : 0) + '%';
    }

    handleEvidenceClick(filePath, fileName) {
        return this._runImport('Importing Meta return…', () => this.module.importWarrant(filePath, fileName));
    }

    async handleFilePicker() {
        let picked;
        try { picked = await this.module.pickSource(); } catch (e) { this._toast(e.message, 'error'); return null; }
        if (!picked) return null;
        return this._runImport('Importing Meta return…', () => this.module.importWarrant(picked.path, picked.path.split(/[\\/]/).pop()));
    }

    async upgradeCurrent(locate) {
        const imp = this.currentImport;
        if (!imp) return null;
        if (this._isLegacy(imp)) {
            const n = WarrantFlags.count(imp);
            if (n) { this._toast(`Push or clear your ${n} flagged item${n === 1 ? '' : 's'} first — old flags cannot be carried over.`, 'error'); return null; }
        }
        let p = null;
        if (locate) {
            let picked;
            try { picked = await this.module.pickSource(); } catch (e) { this._toast(e.message, 'error'); return null; }
            if (!picked) return null;
            p = picked.path;
        }
        return this._runImport('Re-importing Meta return…', () => this.module.upgradeImport(imp.id, p)).then(rec => {
            if (!rec && !locate && !this._lastUpgradeHint) {
                this._lastUpgradeHint = true;
                this._toast('If the original ZIP has moved, use “Locate original…”.', 'info');
            }
            return rec;
        });
    }

    switchImport(idx) {
        this.activeImportIdx = Number(idx) || 0;
        this.activeSection = 'overview';
        this.v = this._freshView();
        return this.render();
    }

    async deleteCurrentImport() {
        const imp = this.currentImport;
        if (!imp) return;
        if (!(await this._confirm(`Delete import "${imp.fileName}"? The original return is not touched.`, 'Delete', true))) return;
        await this.module.deleteImport(imp.id);
        this.activeImportIdx = 0;
        this.activeSection = 'overview';
        this.v = this._freshView();
        return this.render();
    }

    // ─── Events ──────────────────────────────────────────────────────

    _onClick(e) {
        const t = e.target && e.target.closest ? e.target.closest('[data-mw]') : null;
        if (!t || !this.container || !this.container.contains(t)) {
            if (e.target && e.target.id === 'mwp-modal') this._closeModal();
            return;
        }
        if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'button')) return;
        const a = t.dataset.mw;
        const d = t.dataset;
        switch (a) {
            case 'nav': this._closeModal(); return this.switchSection(d.section);
            case 'flag': e.stopPropagation(); return this._toggleFlag(d.key);
            case 'flags-clear': return this._clearAllFlags();
            case 'flags-push': return this._pushFlagsToEvidence();
            case 'pick': return this.handleFilePicker();
            case 'evimport': return this.handleEvidenceClick(d.path, d.name);
            case 'upgrade': return this.upgradeCurrent(false);
            case 'locate': return this.upgradeCurrent(true);
            case 'delete': return this.deleteCurrentImport();
            case 'page': this.v.offset = Number(d.offset) || 0; return this._renderContent().then(() => this._scrollTop());
            case 'search-go': return this._applySearch(t);
            case 'thread': this.v = Object.assign(this._freshView(), { thread: d.thread }); return this._renderContent().then(() => this._scrollTop());
            case 'thread-back': this.v = this._freshView(); return this._renderContent();
            case 'goto-thread': this._closeModal(); this.activeSection = 'messages'; this._markNav(); this.v = Object.assign(this._freshView(), { thread: d.thread }); return this._renderContent();
            case 'ip': this.v = Object.assign(this._freshView(), { ip: d.ip }); return this._renderContent();
            case 'ip-back': this.v = this._freshView(); return this._renderContent();
            case 'arin': e.stopPropagation(); if (typeof window.mwpArinLookup === 'function') window.mwpArinLookup(t, d.ip); return;
            case 'openkey': return this._openKey(d.key);
            case 'modal-close': return this._closeModal();
            case 'zoom': return this._showModal(`<img class="mwp-lightbox-img" src="${this._attr(t.getAttribute('src'))}" alt=""><div class="mwp-mono mwp-small mwp-top-gap">${this._esc(d.ref)}</div>`);
            default: return;
        }
    }

    _onChange(e) {
        const t = e.target;
        const a = t && t.dataset && t.dataset.mw;
        if (!a) return;
        if (a === 'import-select') return this.switchImport(parseInt(t.value, 10));
        if (a === 'sort') { this.v.sort = t.value; this.v.offset = 0; return this._renderContent(); }
        if (a === 'pagefilter') { this.v.page = t.value; this.v.offset = 0; return this._renderContent(); }
        if (a === 'onlypres') { this.v.onlyPres = !!t.checked; this.v.offset = 0; return this._renderContent(); }
        if (a === 'mediakind') { this.v.mediaKind = t.value; this.v.offset = 0; return this._renderContent(); }
    }

    _onKey(e) {
        if (e.key === 'Escape') { this._closeModal(); return; }
        if (e.key !== 'Enter') return;
        const t = e.target;
        if (t && t.dataset && t.dataset.mw === 'q') { e.preventDefault(); this._applySearch(t); }
    }

    _applySearch(from) {
        const box = from && from.dataset.mw === 'q' ? from : (this.container && this.container.querySelector('input[data-mw="q"]'));
        this.v.q = box ? String(box.value || '').trim() : '';
        this.v.offset = 0;
        this.v._refocus = true;
        return this._renderContent();
    }

    _scrollTop() { const a = document.getElementById('mwp-content-area'); if (a) a.scrollTop = 0; }

    // ─── Small helpers ───────────────────────────────────────────────

    async _q(imp, req) {
        const r = await this.module.query(imp, req);
        if (!r || !r.success) throw new Error((r && r.error) || 'Could not read this return.');
        return r;
    }

    _searchBox(ph) {
        return `<input class="mwp-input" type="search" data-mw="q" data-autofocus value="${this._attr(this.v.q)}" placeholder="${this._attr(ph)}">
                <button class="mwp-btn-sm" data-mw="search-go">Search</button>`;
    }

    _countLine(r, noun) {
        if (!r || !r.total) return '';
        const a = (r.offset || 0) + 1, b = Math.min(r.total, (r.offset || 0) + (r.rows || []).length);
        return `<div class="mwp-muted mwp-small">${a.toLocaleString()}–${b.toLocaleString()} of ${r.total.toLocaleString()} ${noun || ''}${this.v.q ? ` matching “${this._esc(this.v.q)}”` : ''}</div>`;
    }

    _pager(r) {
        if (!r || !r.total || !r.limit || r.total <= r.limit) return '';
        const off = r.offset || 0, lim = r.limit;
        const last = Math.floor((r.total - 1) / lim) * lim;
        const btn = (o, l, dis) => `<button class="mwp-btn-sm" data-mw="page" data-offset="${o}" ${dis ? 'disabled' : ''}>${l}</button>`;
        return `<div class="mwp-pager">
            ${btn(0, '« First', off === 0)}${btn(Math.max(0, off - lim), '‹ Prev', off === 0)}
            <span class="mwp-muted mwp-small">Page ${Math.floor(off / lim) + 1} of ${Math.floor(last / lim) + 1}</span>
            ${btn(off + lim, 'Next ›', off + lim >= r.total)}${btn(last, 'Last »', off >= last)}</div>`;
    }

    _highlight(text, q) {
        const s = String(text || '');
        const i = q ? s.toLowerCase().indexOf(String(q).toLowerCase()) : -1;
        if (i < 0) return this._esc(s);
        return this._esc(s.slice(0, i)) + '<mark>' + this._esc(s.slice(i, i + q.length)) + '</mark>' + this._esc(s.slice(i + q.length));
    }

    _fmtSize(n) {
        n = Number(n) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    _kvRow(label, value) {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="mwp-kv-row"><span class="mwp-kv-label">${this._esc(label)}</span><span class="mwp-kv-value">${this._esc(String(value))}</span></div>`;
    }

    _statBadge(label, count, icon) {
        return `<div class="mwp-stat ${count > 0 ? 'has-data' : ''}"><span class="mwp-stat-icon">${icon}</span><span class="mwp-stat-count">${Number(count || 0).toLocaleString()}</span><span class="mwp-stat-label">${label}</span></div>`;
    }

    _esc(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    _attr(str) { return this._esc(str).replace(/'/g, '&#39;'); }

    async _confirm(msg, okText, danger) {
        if (typeof viperConfirm === 'function') return viperConfirm(msg, { okText, danger: !!danger });
        return confirm(msg);
    }

    _toast(msg, type) {
        if (typeof viperToast === 'function') viperToast(msg, type);
        else if (typeof window.showToast === 'function') window.showToast(msg, type);
        else console.log(`[${type}] ${msg}`);
    }
}

window.MetaWarrantUI = MetaWarrantUI;
