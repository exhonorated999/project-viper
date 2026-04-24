/**
 * META Warrant Parser — UI
 * Renders all parsed data sections in the case-detail tab.
 * Mirrors the Google Warrant UI architecture.
 */

class MetaWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
        this._mediaCache = {}; // diskPath → data:url
    }

    get container() {
        return document.getElementById(this.containerId);
    }

    get currentImport() {
        return this.module.imports[this.activeImportIdx] || null;
    }

    /** Aggregate record for current import (merge records + preservation) */
    get primaryRecord() {
        const imp = this.currentImport;
        if (!imp || !imp.records) return null;
        return imp.records.find(r => r.source === 'records') || imp.records[0] || null;
    }

    get preservationRecord() {
        const imp = this.currentImport;
        if (!imp || !imp.records) return null;
        return imp.records.find(r => r.source !== 'records') || null;
    }

    // ─── Main Render ────────────────────────────────────────────────────

    render() {
        if (!this.container) return;

        if (this.module.imports.length === 0) {
            this.container.innerHTML = this._renderEmptyState();
            return;
        }

        this.container.innerHTML = `
            <div class="mwp-layout">
                <div class="mwp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderNav()}
                </div>
                <div class="mwp-content" id="mwp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="mwp-evidence-bar"></div>
        `;
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('mwp-evidence-bar');
        if (!bar) return;
        if (!files || files.length === 0) { bar.innerHTML = ''; return; }

        bar.innerHTML = `
            <div class="mwp-evidence-bar">
                <div class="mwp-evidence-label">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    Detected META Warrant Files:
                </div>
                ${files.map(f => `
                    <button class="mwp-evidence-file ${f.alreadyImported ? 'imported' : ''}"
                            onclick="window.metaWarrantUI.handleEvidenceClick('${this._escJs(f.path)}', '${this._escJs(f.name)}')"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="mwp-evidence-icon">${f.alreadyImported ? '✅' : '📦'}</span>
                        <span class="mwp-evidence-name">${this._esc(f.name)}</span>
                        <span class="mwp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
                    </button>
                `).join('')}
            </div>
        `;
    }

    async handleEvidenceClick(filePath, fileName) {
        try {
            this._showLoading('Importing META warrant data...');
            const record = await this.module.importWarrant(filePath, fileName);
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.service} — ${record.targetId || fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    async handleFilePicker() {
        try {
            this._showLoading('Importing META warrant data...');
            const record = await this.module.importFromPicker();
            if (!record) { this.render(); return; }
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.service} — ${record.targetId || record.fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    switchSection(section) {
        this.activeSection = section;
        const content = document.getElementById('mwp-content-area');
        if (content) content.innerHTML = this._renderSection();
        document.querySelectorAll('.mwp-nav-item').forEach(el => {
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
            <div class="mwp-import-selector">
                <label class="mwp-label">Import:</label>
                <select onchange="window.metaWarrantUI.switchImport(parseInt(this.value))" class="mwp-select">
                    ${this.module.imports.map((imp, i) => `
                        <option value="${i}" ${i === this.activeImportIdx ? 'selected' : ''}>
                            ${this._esc(imp.service)} — ${this._esc(imp.targetId || imp.fileName)}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;
    }

    _renderNav() {
        const rec = this.primaryRecord;
        if (!rec) return '';

        const totalMessages = rec.messages?.threads?.reduce((s, t) => s + (t.messages?.length || 0), 0) || 0;
        const totalPosts = (rec.statusUpdates?.length || 0) + (rec.wallposts?.length || 0) +
                           (rec.postsToOtherWalls?.length || 0) + (rec.shares?.length || 0);

        const sections = [
            { id: 'overview',       label: 'Account Overview',  icon: '👤', show: true },
            { id: 'ipActivity',     label: 'IP Activity',       icon: '🌐', count: rec.ipAddresses?.length, show: rec.ipAddresses?.length > 0 },
            { id: 'posts',          label: 'Posts & Activity',  icon: '📝', count: totalPosts, show: totalPosts > 0 },
            { id: 'photos',         label: 'Photos',            icon: '📷', count: rec.photos?.length, show: rec.photos?.length > 0 },
            { id: 'messages',       label: 'Messages',          icon: '💬', count: totalMessages, show: rec.messages?.threads?.length > 0 },
            { id: 'timeline',       label: 'Timeline',          icon: '🕐', show: true }
        ];

        return `
            <nav class="mwp-nav">
                ${sections.filter(s => s.show).map(s => `
                    <button class="mwp-nav-item ${s.id === this.activeSection ? 'active' : ''}"
                            data-section="${s.id}"
                            onclick="window.metaWarrantUI.switchSection('${s.id}')">
                        <span class="mwp-nav-icon">${s.icon}</span>
                        <span class="mwp-nav-label">${s.label}</span>
                        ${s.count ? `<span class="mwp-nav-count">${s.count}</span>` : ''}
                    </button>
                `).join('')}
            </nav>
            <div class="mwp-nav-actions">
                <button class="mwp-btn-sm" onclick="window.metaWarrantUI.handleFilePicker()">+ Import ZIP</button>
                <button class="mwp-btn-sm danger" onclick="window.metaWarrantUI.deleteCurrentImport()">🗑️ Delete</button>
            </div>
        `;
    }

    // ─── Section Router ─────────────────────────────────────────────────

    _renderSection() {
        const rec = this.primaryRecord;
        if (!rec) return '<div class="mwp-empty">No data available</div>';

        switch (this.activeSection) {
            case 'overview':   return this._renderOverview(rec);
            case 'ipActivity': return this._renderIpActivity(rec);
            case 'posts':      return this._renderPosts(rec);
            case 'photos':     return this._renderPhotos(rec);
            case 'messages':   return this._renderMessages(rec);
            case 'timeline':   return this._renderTimeline(rec);
            default:           return '<div class="mwp-empty">Unknown section</div>';
        }
    }

    // ─── Overview ───────────────────────────────────────────────────────

    _renderOverview(rec) {
        const imp = this.currentImport;
        const pres = this.preservationRecord;

        const totalMessages = rec.messages?.threads?.reduce((s, t) => s + (t.messages?.length || 0), 0) || 0;

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">
                    <span class="mwp-meta-logo">${rec.service === 'Instagram' ? '📸' : '📘'}</span>
                    ${this._esc(rec.service)} Account — ${this._esc(rec.targetId || 'Unknown')}
                </h2>

                <div class="mwp-card-grid">
                    <!-- Account Info -->
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">📋 Request Parameters</h3>
                        <div class="mwp-kv-list">
                            ${this._kvRow('Service', rec.service)}
                            ${this._kvRow('Target ID', rec.targetId)}
                            ${this._kvRow('Account ID', rec.accountId)}
                            ${this._kvRow('Date Range', rec.dateRange)}
                            ${this._kvRow('Generated', rec.generated)}
                            ${this._kvRow('Imported', imp?.importedAt ? new Date(imp.importedAt).toLocaleString() : null)}
                        </div>
                    </div>

                    <!-- Bio -->
                    ${rec.bio ? `
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">👤 Bio</h3>
                        <div class="mwp-kv-list">
                            ${this._kvRow('Text', rec.bio.text)}
                            ${this._kvRow('Created', rec.bio.creationTime)}
                        </div>
                    </div>
                    ` : ''}

                    <!-- About Me -->
                    ${rec.aboutMe ? `
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">ℹ️ About Me</h3>
                        <p class="mwp-text">${this._esc(rec.aboutMe)}</p>
                    </div>
                    ` : ''}

                    <!-- Registration IP -->
                    ${rec.registrationIp ? `
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">🔒 Registration IP</h3>
                        <p class="mwp-mono">${this._esc(rec.registrationIp)}</p>
                    </div>
                    ` : ''}

                    <!-- NCMEC Reports -->
                    ${rec.ncmecReports.length > 0 ? `
                    <div class="mwp-card mwp-card-alert">
                        <h3 class="mwp-card-title">⚠️ NCMEC Reports (${rec.ncmecReports.length})</h3>
                        ${rec.ncmecReports.map(r => `
                            <div class="mwp-ncmec-item">${this._esc(JSON.stringify(r))}</div>
                        `).join('')}
                    </div>
                    ` : ''}

                    <!-- Stats Summary -->
                    <div class="mwp-card mwp-card-full">
                        <h3 class="mwp-card-title">📊 Data Summary</h3>
                        <div class="mwp-stats-grid">
                            ${this._statBadge('IP Addresses', rec.ipAddresses?.length || 0, '🌐')}
                            ${this._statBadge('Status Updates', rec.statusUpdates?.length || 0, '📝')}
                            ${this._statBadge('Wallposts', rec.wallposts?.length || 0, '📌')}
                            ${this._statBadge('Shares', rec.shares?.length || 0, '🔗')}
                            ${this._statBadge('Photos', rec.photos?.length || 0, '📷')}
                            ${this._statBadge('Messages', totalMessages, '💬')}
                            ${this._statBadge('Threads', rec.messages?.threads?.length || 0, '🧵')}
                            ${this._statBadge('Wall Posts', rec.postsToOtherWalls?.length || 0, '📤')}
                        </div>
                    </div>

                    <!-- Preservation info -->
                    ${pres ? `
                    <div class="mwp-card mwp-card-full">
                        <h3 class="mwp-card-title">📁 Preservation Record</h3>
                        <div class="mwp-kv-list">
                            ${this._kvRow('Source', pres.source)}
                            ${this._kvRow('Generated', pres.generated)}
                            ${this._kvRow('Date Range', pres.dateRange)}
                            ${this._kvRow('Status Updates', pres.statusUpdates?.length || 0)}
                            ${this._kvRow('Photos', pres.photos?.length || 0)}
                            ${this._kvRow('Messages', pres.messages?.threads?.reduce((s, t) => s + (t.messages?.length || 0), 0) || 0)}
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    // ─── IP Activity ────────────────────────────────────────────────────

    _renderIpActivity(rec) {
        const ips = rec.ipAddresses || [];
        if (ips.length === 0) return '<div class="mwp-empty">No IP address records</div>';

        // Group by unique IP
        const ipMap = {};
        for (const entry of ips) {
            if (!entry.ip) continue;
            if (!ipMap[entry.ip]) ipMap[entry.ip] = [];
            ipMap[entry.ip].push(entry.time);
        }

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🌐 IP Activity (${ips.length} records)</h2>

                <div class="mwp-card">
                    <h3 class="mwp-card-title">Unique IPs (${Object.keys(ipMap).length})</h3>
                    <div class="mwp-ip-chips">
                        ${Object.entries(ipMap).map(([ip, times]) => `
                            <span class="mwp-ip-chip">${this._esc(ip)} <span class="mwp-ip-count">×${times.length}</span></span>
                        `).join('')}
                    </div>
                </div>

                <div class="mwp-card">
                    <h3 class="mwp-card-title">Activity Log</h3>
                    <table class="mwp-table">
                        <thead><tr><th>IP Address</th><th>Timestamp</th></tr></thead>
                        <tbody>
                            ${ips.map(entry => `
                                <tr>
                                    <td class="mwp-mono">${this._esc(entry.ip || '—')}</td>
                                    <td>${this._esc(entry.time || '—')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // ─── Posts & Activity ───────────────────────────────────────────────

    _renderPosts(rec) {
        const updates = rec.statusUpdates || [];
        const wallposts = rec.wallposts || [];
        const otherWall = rec.postsToOtherWalls || [];
        const shares = rec.shares || [];

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">📝 Posts & Activity</h2>

                ${updates.length > 0 ? `
                <div class="mwp-card">
                    <h3 class="mwp-card-title">Status Updates (${updates.length})</h3>
                    <div class="mwp-post-list">
                        ${updates.map(u => `
                            <div class="mwp-post-item">
                                <div class="mwp-post-meta">
                                    <span class="mwp-post-author">${this._esc(u.author || 'Unknown')}</span>
                                    <span class="mwp-post-time">${this._esc(u.posted || '')}</span>
                                    ${u.mobile === 'true' ? '<span class="mwp-tag">📱 Mobile</span>' : ''}
                                </div>
                                <div class="mwp-post-body">${this._esc(u.status || '(no text)')}</div>
                                ${u.lifeExperience ? `<div class="mwp-post-extra">Life Experience: ${this._esc(u.lifeExperience)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                ${wallposts.length > 0 ? `
                <div class="mwp-card">
                    <h3 class="mwp-card-title">Wallposts (${wallposts.length})</h3>
                    <div class="mwp-post-list">
                        ${wallposts.map(w => `
                            <div class="mwp-post-item">
                                <div class="mwp-post-meta">
                                    <span class="mwp-post-author">${this._esc(w.from || 'Unknown')} → ${this._esc(w.to || 'Unknown')}</span>
                                    <span class="mwp-post-time">${this._esc(w.time || '')}</span>
                                </div>
                                <div class="mwp-post-body">${this._esc(w.text || '(no text)')}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                ${otherWall.length > 0 ? `
                <div class="mwp-card">
                    <h3 class="mwp-card-title">Posts to Other Walls (${otherWall.length})</h3>
                    <div class="mwp-post-list">
                        ${otherWall.map(p => `
                            <div class="mwp-post-item">
                                <div class="mwp-post-meta">
                                    <span class="mwp-post-author">→ ${this._esc(p.timelineOwner || 'Unknown')}</span>
                                    <span class="mwp-post-time">${this._esc(p.time || '')}</span>
                                </div>
                                <div class="mwp-post-body">${this._esc(p.post || '(no text)')}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                ${shares.length > 0 ? `
                <div class="mwp-card">
                    <h3 class="mwp-card-title">Shares (${shares.length})</h3>
                    <div class="mwp-post-list">
                        ${shares.map(s => `
                            <div class="mwp-post-item">
                                <div class="mwp-post-meta">
                                    <span class="mwp-post-time">${this._esc(s.dateCreated || '')}</span>
                                </div>
                                ${s.title ? `<div class="mwp-post-title">${this._esc(s.title)}</div>` : ''}
                                <div class="mwp-post-body">${this._esc(s.text || s.summary || '(no text)')}</div>
                                ${s.url ? `<a class="mwp-link" href="${this._esc(s.url)}" target="_blank">${this._esc(s.url)}</a>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Photos ─────────────────────────────────────────────────────────

    _renderPhotos(rec) {
        const photos = rec.photos || [];
        if (photos.length === 0) return '<div class="mwp-empty">No photos</div>';

        // Group by album
        const albums = {};
        for (const p of photos) {
            const album = p.album || 'Other';
            if (!albums[album]) albums[album] = [];
            albums[album].push(p);
        }

        const imp = this.currentImport;
        const media = imp?.mediaFiles || {};

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">📷 Photos (${photos.length})</h2>
                ${Object.entries(albums).map(([albumName, albumPhotos]) => `
                    <div class="mwp-card">
                        <h3 class="mwp-card-title">📁 ${this._esc(albumName)} (${albumPhotos.length})</h3>
                        <div class="mwp-photo-grid">
                            ${albumPhotos.map(p => {
                                const fileName = p.imageFile ? p.imageFile.replace('linked_media/', '') : null;
                                const mediaInfo = fileName ? media[fileName] : null;
                                const imgSrc = mediaInfo?.diskPath
                                    ? `mwp-lazy-img" data-disk-path="${this._esc(mediaInfo.diskPath)}`
                                    : mediaInfo?.data
                                        ? `" src="data:${mediaInfo.mimeType};base64,${mediaInfo.data}`
                                        : null;

                                return `
                                    <div class="mwp-photo-card" onclick="window.metaWarrantUI.showPhotoDetail('${this._escJs(p.id || '')}')">
                                        ${imgSrc
                                            ? `<img class="${imgSrc}" alt="${this._esc(p.title || '')}" loading="lazy">`
                                            : '<div class="mwp-photo-placeholder">📷</div>'
                                        }
                                        <div class="mwp-photo-info">
                                            ${p.title ? `<div class="mwp-photo-title">${this._esc(p.title)}</div>` : ''}
                                            <div class="mwp-photo-meta">${this._esc(p.uploaded || '')}</div>
                                            ${p.uploadIp ? `<div class="mwp-photo-ip">${this._esc(p.uploadIp)}</div>` : ''}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    showPhotoDetail(photoId) {
        const rec = this.primaryRecord;
        if (!rec) return;
        const photo = rec.photos.find(p => p.id === photoId);
        if (!photo) return;

        const imp = this.currentImport;
        const media = imp?.mediaFiles || {};
        const fileName = photo.imageFile ? photo.imageFile.replace('linked_media/', '') : null;
        const mediaInfo = fileName ? media[fileName] : null;

        const modal = document.createElement('div');
        modal.className = 'mwp-lightbox';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.innerHTML = `
            <div class="mwp-lightbox-content">
                <button class="mwp-lightbox-close" onclick="this.closest('.mwp-lightbox').remove()">✕</button>
                ${mediaInfo?.diskPath
                    ? `<img class="mwp-lightbox-img mwp-lazy-img" data-disk-path="${this._esc(mediaInfo.diskPath)}">`
                    : mediaInfo?.data
                        ? `<img class="mwp-lightbox-img" src="data:${mediaInfo.mimeType};base64,${mediaInfo.data}">`
                        : '<div class="mwp-photo-placeholder" style="width:400px;height:300px;">📷 No image data</div>'
                }
                <div class="mwp-lightbox-details">
                    ${photo.title ? `<h3>${this._esc(photo.title)}</h3>` : ''}
                    <div class="mwp-kv-list">
                        ${this._kvRow('Album', photo.album)}
                        ${this._kvRow('ID', photo.id)}
                        ${this._kvRow('Uploaded', photo.uploaded)}
                        ${this._kvRow('Upload IP', photo.uploadIp)}
                        ${this._kvRow('Author', photo.author)}
                        ${this._kvRow('Tags', photo.tags)}
                        ${this._kvRow('Link', photo.link)}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this._loadLazyImages(modal);
    }

    // ─── Messages ───────────────────────────────────────────────────────

    _renderMessages(rec) {
        const threads = rec.messages?.threads || [];
        if (threads.length === 0) return '<div class="mwp-empty">No messages</div>';

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">💬 Messages (${threads.length} thread${threads.length !== 1 ? 's' : ''})</h2>
                ${threads.map((thread, ti) => {
                    const msgCount = thread.messages?.length || 0;
                    return `
                        <div class="mwp-card mwp-thread-card">
                            <div class="mwp-thread-header" onclick="this.closest('.mwp-thread-card').classList.toggle('expanded')">
                                <div class="mwp-thread-info">
                                    <span class="mwp-thread-id">Thread ${this._esc(thread.threadId || '?')}</span>
                                    <span class="mwp-thread-count">${msgCount} message${msgCount !== 1 ? 's' : ''}</span>
                                </div>
                                <div class="mwp-thread-participants">
                                    ${(thread.participants || []).map(p => `
                                        <span class="mwp-participant">${this._esc(p)}</span>
                                    `).join('')}
                                </div>
                                <svg class="mwp-thread-chevron w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                                </svg>
                            </div>
                            <div class="mwp-thread-messages">
                                ${(thread.messages || []).map(msg => this._renderMessage(msg)).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    _renderMessage(msg) {
        const imp = this.currentImport;
        const media = imp?.mediaFiles || {};

        return `
            <div class="mwp-message">
                <div class="mwp-msg-header">
                    <span class="mwp-msg-author">${this._esc(msg.author || 'Unknown')}</span>
                    <span class="mwp-msg-time">${this._esc(msg.sent || '')}</span>
                </div>
                <div class="mwp-msg-body">${this._esc(msg.body || '')}</div>
                ${(msg.attachments || []).map(att => {
                    const fileName = (att.images || [])[0]?.replace('linked_media/', '')
                                  || att.linkedMediaFile?.replace('linked_media/', '');
                    const mediaInfo = fileName ? media[fileName] : null;

                    return `
                        <div class="mwp-msg-attachment">
                            ${mediaInfo?.diskPath
                                ? `<img class="mwp-msg-img mwp-lazy-img" data-disk-path="${this._esc(mediaInfo.diskPath)}" loading="lazy">`
                                : mediaInfo?.data
                                    ? `<img class="mwp-msg-img" src="data:${mediaInfo.mimeType};base64,${mediaInfo.data}" loading="lazy">`
                                    : ''
                            }
                            <div class="mwp-att-meta">
                                ${att.type ? `<span class="mwp-tag">${this._esc(att.type)}</span>` : ''}
                                ${att.size ? `<span class="mwp-tag">${(parseInt(att.size) / 1024).toFixed(0)} KB</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // ─── Timeline ───────────────────────────────────────────────────────

    _renderTimeline(rec) {
        // Combine all timestamped events into a unified timeline
        const events = [];

        (rec.ipAddresses || []).forEach(ip => {
            if (ip.time) events.push({ time: ip.time, type: 'ip', icon: '🌐', desc: `IP: ${ip.ip}` });
        });
        (rec.statusUpdates || []).forEach(u => {
            if (u.posted) events.push({ time: u.posted, type: 'status', icon: '📝', desc: u.status || '(status update)', author: u.author });
        });
        (rec.wallposts || []).forEach(w => {
            if (w.time) events.push({ time: w.time, type: 'wallpost', icon: '📌', desc: w.text || '(wallpost)', author: w.from });
        });
        (rec.postsToOtherWalls || []).forEach(p => {
            if (p.time) events.push({ time: p.time, type: 'otherwall', icon: '📤', desc: p.post || '(wall post)', author: p.timelineOwner });
        });
        (rec.shares || []).forEach(s => {
            if (s.dateCreated) events.push({ time: s.dateCreated, type: 'share', icon: '🔗', desc: s.title || s.text || '(shared content)' });
        });
        (rec.photos || []).forEach(p => {
            if (p.uploaded) events.push({ time: p.uploaded, type: 'photo', icon: '📷', desc: p.title || `Photo ${p.id}`, extra: p.album });
        });
        (rec.messages?.threads || []).forEach(t => {
            (t.messages || []).forEach(m => {
                if (m.sent) events.push({ time: m.sent, type: 'message', icon: '💬', desc: m.body || '(message)', author: m.author, thread: t.threadId });
            });
        });
        if (rec.bio?.creationTime) {
            events.push({ time: rec.bio.creationTime, type: 'bio', icon: '👤', desc: `Bio: ${rec.bio.text || ''}` });
        }

        // Sort chronologically
        events.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        if (events.length === 0) return '<div class="mwp-empty">No timeline events</div>';

        return `
            <div class="mwp-section">
                <h2 class="mwp-section-title">🕐 Timeline (${events.length} events)</h2>
                <div class="mwp-timeline">
                    ${events.map(ev => `
                        <div class="mwp-timeline-event mwp-event-${ev.type}">
                            <div class="mwp-timeline-dot">${ev.icon}</div>
                            <div class="mwp-timeline-content">
                                <div class="mwp-timeline-time">${this._esc(ev.time)}</div>
                                <div class="mwp-timeline-desc">${this._esc(ev.desc)}</div>
                                ${ev.author ? `<div class="mwp-timeline-author">${this._esc(ev.author)}</div>` : ''}
                                ${ev.extra ? `<div class="mwp-timeline-extra">${this._esc(ev.extra)}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // ─── Empty State ────────────────────────────────────────────────────

    _renderEmptyState() {
        return `
            <div class="mwp-empty-state">
                <div class="mwp-empty-icon">📘</div>
                <h3 class="mwp-empty-title">META Warrant Parser</h3>
                <p class="mwp-empty-desc">Import META (Facebook / Instagram) warrant return ZIP files to parse account data, messages, photos, and IP activity.</p>
                <div class="mwp-empty-actions">
                    <button class="mwp-btn-primary" onclick="window.metaWarrantUI.handleFilePicker()">
                        📂 Select ZIP File
                    </button>
                </div>
                <p class="mwp-empty-hint">ZIP files placed in Evidence or Warrants/Production folders will be auto-detected.</p>
            </div>
            <div id="mwp-evidence-bar"></div>
        `;
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _kvRow(label, value) {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="mwp-kv-row"><span class="mwp-kv-label">${this._esc(label)}</span><span class="mwp-kv-value">${this._esc(String(value))}</span></div>`;
    }

    _statBadge(label, count, icon) {
        return `<div class="mwp-stat ${count > 0 ? 'has-data' : ''}"><span class="mwp-stat-icon">${icon}</span><span class="mwp-stat-count">${count}</span><span class="mwp-stat-label">${label}</span></div>`;
    }

    _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escJs(str) {
        return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    _showLoading(text) {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="mwp-loading">
                <div class="mwp-spinner"></div>
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
     * Load lazy images that have disk paths (read via IPC)
     */
    async _loadLazyImages(container) {
        const imgs = (container || document).querySelectorAll('.mwp-lazy-img[data-disk-path]');
        for (const img of imgs) {
            const diskPath = img.dataset.diskPath;
            if (!diskPath) continue;
            if (this._mediaCache[diskPath]) {
                img.src = this._mediaCache[diskPath];
                img.classList.remove('mwp-lazy-img');
                continue;
            }
            try {
                const result = await this.module.readMedia(diskPath);
                if (result) {
                    const dataUrl = `data:${result.mimeType};base64,${result.data}`;
                    this._mediaCache[diskPath] = dataUrl;
                    img.src = dataUrl;
                    img.classList.remove('mwp-lazy-img');
                }
            } catch (e) { /* ignore */ }
        }
    }
}
