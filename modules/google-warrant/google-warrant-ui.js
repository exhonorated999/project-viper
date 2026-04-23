/**
 * Google Warrant Parser — UI
 * Renders all parsed data sections in the case-detail tab
 */

class GoogleWarrantUI {
    constructor(containerId, module) {
        this.containerId = containerId;
        this.module = module;
        this.activeSection = 'overview';
        this.activeImportIdx = 0;
    }

    get container() {
        return document.getElementById(this.containerId);
    }

    get currentImport() {
        return this.module.imports[this.activeImportIdx] || null;
    }

    // ─── Main Render ────────────────────────────────────────────────────

    render() {
        if (!this.container) return;

        if (this.module.imports.length === 0) {
            this.container.innerHTML = this._renderEmptyState();
            return;
        }

        this.container.innerHTML = `
            <div class="gwp-layout">
                <div class="gwp-sidebar">
                    ${this._renderImportSelector()}
                    ${this._renderNav()}
                </div>
                <div class="gwp-content" id="gwp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="gwp-evidence-bar"></div>
        `;
    }

    renderEvidenceBar(files) {
        const bar = document.getElementById('gwp-evidence-bar');
        if (!bar) return;
        if (!files || files.length === 0) {
            bar.innerHTML = '';
            return;
        }

        bar.innerHTML = `
            <div class="gwp-evidence-bar">
                <div class="gwp-evidence-label">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    Detected Google Warrant Files:
                </div>
                ${files.map(f => `
                    <button class="gwp-evidence-file ${f.alreadyImported ? 'imported' : ''}" 
                            onclick="window.googleWarrantUI.handleEvidenceClick('${f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${f.name.replace(/'/g, "\\'")}')"
                            title="${f.alreadyImported ? 'Already imported — click to re-import' : 'Click to import'}">
                        <span class="gwp-evidence-icon">${f.alreadyImported ? '✅' : '📦'}</span>
                        <span class="gwp-evidence-name">${f.name}</span>
                        <span class="gwp-evidence-size">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
                    </button>
                `).join('')}
            </div>
        `;
    }

    async handleEvidenceClick(filePath, fileName) {
        try {
            this._showLoading('Importing Google warrant data...');
            const record = await this.module.importWarrant(filePath, fileName);
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountEmail || fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    async handleFilePicker() {
        try {
            this._showLoading('Importing Google warrant data...');
            const record = await this.module.importFromPicker();
            if (!record) { this.render(); return; } // Cancelled
            this.activeImportIdx = this.module.imports.findIndex(i => i.id === record.id);
            this.activeSection = 'overview';
            this.render();
            this._toast(`Imported: ${record.accountEmail || record.fileName}`, 'success');
        } catch (err) {
            this._toast('Import failed: ' + err.message, 'error');
            this.render();
        }
    }

    switchSection(section) {
        this.activeSection = section;
        const content = document.getElementById('gwp-content-area');
        if (content) content.innerHTML = this._renderSection();

        // Update nav active states
        document.querySelectorAll('.gwp-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.section === section);
        });
    }

    switchImport(idx) {
        this.activeImportIdx = idx;
        this.activeSection = 'overview';
        this.render();
    }

    deleteImport(importId) {
        if (!confirm('Delete this imported warrant data?')) return;
        this.module.deleteImport(importId);
        this.activeImportIdx = 0;
        this.render();
    }

    // ─── Empty State ────────────────────────────────────────────────────

    _renderEmptyState() {
        return `
            <div class="gwp-empty">
                <div class="gwp-empty-icon">📋</div>
                <h3>Google Warrant Parser</h3>
                <p>Import a Google warrant return (ZIP) to parse and view account data, emails, location history, device info, and more.</p>
                <div class="gwp-empty-actions">
                    <button onclick="window.googleWarrantUI.handleFilePicker()" class="gwp-btn-primary">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                        </svg>
                        Import Google Warrant ZIP
                    </button>
                </div>
                <div class="gwp-empty-hint">
                    Place ZIP files in the case Evidence or Warrants/Production folder for auto-detection.
                </div>
                <div id="gwp-evidence-bar"></div>
            </div>
        `;
    }

    _showLoading(msg) {
        if (this.container) {
            this.container.innerHTML = `
                <div class="gwp-loading">
                    <div class="gwp-spinner"></div>
                    <p>${msg || 'Processing...'}</p>
                    <p class="gwp-loading-sub">This may take a moment for large archives</p>
                </div>
            `;
        }
    }

    // ─── Import Selector ────────────────────────────────────────────────

    _renderImportSelector() {
        if (this.module.imports.length <= 1) {
            const imp = this.currentImport;
            return `
                <div class="gwp-import-header">
                    <div class="gwp-import-account">
                        <span class="gwp-google-icon">G</span>
                        <div>
                            <div class="gwp-import-email">${imp?.accountEmail || 'Unknown'}</div>
                            <div class="gwp-import-meta">ID: ${imp?.accountId || '—'}</div>
                        </div>
                    </div>
                    <div class="gwp-import-actions">
                        <button onclick="window.googleWarrantUI.handleFilePicker()" class="gwp-btn-sm" title="Import another">+</button>
                    </div>
                </div>
            `;
        }

        return `
            <div class="gwp-import-tabs">
                ${this.module.imports.map((imp, idx) => `
                    <button class="gwp-import-tab ${idx === this.activeImportIdx ? 'active' : ''}"
                            onclick="window.googleWarrantUI.switchImport(${idx})">
                        <span class="gwp-google-icon-sm">G</span>
                        <span class="gwp-tab-email">${imp.accountEmail || imp.fileName}</span>
                    </button>
                `).join('')}
                <button onclick="window.googleWarrantUI.handleFilePicker()" class="gwp-import-tab gwp-add-tab" title="Import another">+</button>
            </div>
        `;
    }

    // ─── Navigation ─────────────────────────────────────────────────────

    _renderNav() {
        const imp = this.currentImport;
        if (!imp) return '';

        const sections = [
            { id: 'overview', label: 'Account Overview', icon: '👤', show: true },
            { id: 'email', label: 'Email', icon: '📧', count: imp.emails?.length, show: imp.emails?.length > 0 },
            { id: 'location', label: 'Location', icon: '📍', count: imp.locationRecords?.length + (imp.semanticLocations?.length || 0), show: imp.locationRecords?.length > 0 || imp.semanticLocations?.length > 0 },
            { id: 'communications', label: 'Communications', icon: '💬', show: imp.chatMessages?.length > 0 || imp.hangoutsInfo },
            { id: 'devices', label: 'Devices & Apps', icon: '📱', count: imp.devices?.length, show: imp.devices?.length > 0 || imp.installs?.length > 0 },
            { id: 'payments', label: 'Payments', icon: '💳', show: imp.googlePay?.instruments?.length > 0 || imp.googlePay?.transactions?.length > 0 },
            { id: 'files', label: 'Files', icon: '📁', show: imp.driveFiles?.length > 0 },
            { id: 'timeline', label: 'Timeline', icon: '🕐', show: true }
        ];

        return `
            <nav class="gwp-nav">
                ${sections.filter(s => s.show).map(s => `
                    <button class="gwp-nav-item ${s.id === this.activeSection ? 'active' : ''}"
                            data-section="${s.id}"
                            onclick="window.googleWarrantUI.switchSection('${s.id}')">
                        <span class="gwp-nav-icon">${s.icon}</span>
                        <span class="gwp-nav-label">${s.label}</span>
                        ${s.count ? `<span class="gwp-nav-badge">${s.count}</span>` : ''}
                    </button>
                `).join('')}
            </nav>
            <div class="gwp-nav-footer">
                <button onclick="window.googleWarrantUI.handleFilePicker()" class="gwp-btn-outline gwp-btn-full">
                    Import Another ZIP
                </button>
                <button onclick="window.googleWarrantUI.deleteImport('${imp.id}')" class="gwp-btn-danger-sm gwp-btn-full">
                    Remove Import
                </button>
            </div>
        `;
    }

    // ─── Section Router ─────────────────────────────────────────────────

    _renderSection() {
        const imp = this.currentImport;
        if (!imp) return '<div class="gwp-empty-section">No data loaded</div>';

        switch (this.activeSection) {
            case 'overview': return this._renderOverview(imp);
            case 'email': return this._renderEmail(imp);
            case 'location': return this._renderLocation(imp);
            case 'communications': return this._renderCommunications(imp);
            case 'devices': return this._renderDevices(imp);
            case 'payments': return this._renderPayments(imp);
            case 'files': return this._renderFiles(imp);
            case 'timeline': return this._renderTimeline(imp);
            default: return '<div class="gwp-empty-section">Unknown section</div>';
        }
    }

    // ─── Account Overview ───────────────────────────────────────────────

    _renderOverview(imp) {
        const sub = imp.subscriber || {};
        const cats = imp.categories || [];
        const noCats = imp.noRecordCategories || [];

        return `
            <div class="gwp-section-scroll">
                <!-- Subscriber Card -->
                <div class="gwp-card gwp-card-highlight">
                    <div class="gwp-card-header">
                        <h3><span class="gwp-google-icon">G</span> Google Account</h3>
                        <span class="gwp-badge ${sub.status === 'Enabled' ? 'gwp-badge-green' : 'gwp-badge-red'}">${sub.status || 'Unknown'}</span>
                    </div>
                    <div class="gwp-profile-grid">
                        <div class="gwp-profile-main">
                            <div class="gwp-field"><label>Name</label><span>${sub.name || '—'}</span></div>
                            <div class="gwp-field"><label>Email</label><span class="gwp-mono">${sub.email || imp.accountEmail || '—'}</span></div>
                            <div class="gwp-field"><label>Account ID</label><span class="gwp-mono">${sub.accountId || imp.accountId || '—'}</span></div>
                            <div class="gwp-field"><label>Birthday</label><span>${sub.birthday || '—'}</span></div>
                            <div class="gwp-field"><label>Created</label><span>${sub.createdOn || '—'}</span></div>
                            <div class="gwp-field"><label>TOS IP</label><span class="gwp-mono">${sub.tosIp || '—'}</span></div>
                        </div>
                        <div class="gwp-profile-side">
                            <div class="gwp-field"><label>Services</label><span>${sub.services || '—'}</span></div>
                            <div class="gwp-field"><label>Last Login</label><span>${sub.lastLogins?.[0] || '—'}</span></div>
                            <div class="gwp-field"><label>Last Updated</label><span>${sub.lastUpdated || '—'}</span></div>
                        </div>
                    </div>
                </div>

                <!-- Recovery & Phone Info -->
                <div class="gwp-grid-2">
                    <div class="gwp-card">
                        <h4 class="gwp-card-title">Account Recovery</h4>
                        <div class="gwp-field"><label>Contact Email</label><span class="gwp-mono">${sub.recovery?.contactEmail || '—'}</span></div>
                        <div class="gwp-field"><label>Recovery Email</label><span class="gwp-mono">${sub.recovery?.recoveryEmail || '—'}</span></div>
                        <div class="gwp-field"><label>Recovery SMS</label><span>${sub.recovery?.recoverySms || '—'}</span></div>
                    </div>
                    <div class="gwp-card">
                        <h4 class="gwp-card-title">Phone Numbers</h4>
                        <div class="gwp-field"><label>User Phone</label><span>${sub.phoneNumbers?.user || 'None on file'}</span></div>
                        <div class="gwp-field"><label>2-Step Verification</label><span>${sub.phoneNumbers?.twoStep || 'None on file'}</span></div>
                    </div>
                </div>

                <!-- Import Summary -->
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Warrant Return Summary</h4>
                    <div class="gwp-field"><label>File</label><span>${imp.fileName}</span></div>
                    <div class="gwp-field"><label>Imported</label><span>${new Date(imp.importedAt).toLocaleString()}</span></div>
                    <div class="gwp-field"><label>Date Range</label><span>${imp.dateRange?.start || 'Not specified'} — ${imp.dateRange?.end || 'Not specified'}</span></div>
                    <div class="gwp-categories">
                        <label>Data Categories (${cats.length} with data, ${noCats.length} empty):</label>
                        <div class="gwp-category-tags">
                            ${cats.map(c => `<span class="gwp-tag gwp-tag-green">${c}</span>`).join('')}
                            ${noCats.map(c => `<span class="gwp-tag gwp-tag-gray">${c} (empty)</span>`).join('')}
                        </div>
                    </div>
                </div>

                <!-- IP Activity Table -->
                ${imp.ipActivity && imp.ipActivity.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">IP Activity Log (${imp.ipActivity.length} entries)</h4>
                    <div class="gwp-table-wrap">
                        <table class="gwp-table">
                            <thead>
                                <tr>
                                    <th>Timestamp</th>
                                    <th>IP Address</th>
                                    <th>Activity</th>
                                    <th>Android ID</th>
                                    <th>User Agent</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${imp.ipActivity.map((ip, idx) => `
                                    <tr>
                                        <td class="gwp-mono gwp-nowrap">${ip.timestamp}</td>
                                        <td class="gwp-mono">
                                            ${ip.ip}
                                            <button class="gwp-arin-btn" onclick="gwpArinLookup(this, '${ip.ip}')" title="ARIN WHOIS Lookup">🌐</button>
                                            <span class="gwp-arin-result" id="gwp-arin-${imp.id}-${idx}"></span>
                                        </td>
                                        <td>${ip.activityType}</td>
                                        <td class="gwp-mono gwp-truncate" title="${ip.androidId || ''}">${ip.androidId || '—'}</td>
                                        <td class="gwp-truncate" title="${ip.userAgent || ''}">${ip.userAgent || '—'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- Change History -->
                ${imp.changeHistory && imp.changeHistory.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Account Change History (${imp.changeHistory.length} changes)</h4>
                    <div class="gwp-table-wrap">
                        <table class="gwp-table">
                            <thead>
                                <tr><th>Timestamp</th><th>IP</th><th>Change Type</th><th>Old Value</th><th>New Value</th></tr>
                            </thead>
                            <tbody>
                                ${imp.changeHistory.map((ch, idx) => `
                                    <tr>
                                        <td class="gwp-mono gwp-nowrap">${ch.timestamp}</td>
                                        <td class="gwp-mono">${ch.ip ? `${ch.ip} <button class="gwp-arin-btn" onclick="gwpArinLookup(this, '${ch.ip}')" title="ARIN WHOIS Lookup">🌐</button>` : '—'}</td>
                                        <td><span class="gwp-badge-change">${ch.changeType}</span></td>
                                        <td>${ch.oldValue || '—'}</td>
                                        <td>${ch.newValue || '—'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- Hangouts Info -->
                ${imp.hangoutsInfo ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Hangouts Profile</h4>
                    ${Object.entries(imp.hangoutsInfo).map(([k, v]) => `
                        <div class="gwp-field"><label>${k}</label><span>${v}</span></div>
                    `).join('')}
                </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Email Section ──────────────────────────────────────────────────

    _renderEmail(imp) {
        const emails = imp.emails || [];
        if (emails.length === 0) return '<div class="gwp-empty-section">No email data in this warrant return</div>';

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>📧 Email Messages (${emails.length})</h3>
                </div>
                <div class="gwp-email-list">
                    ${emails.map((em, idx) => `
                        <div class="gwp-email-item" onclick="window.googleWarrantUI.toggleEmailDetail(${idx})">
                            <div class="gwp-email-row">
                                <div class="gwp-email-from">${this._escHtml(em.from || 'Unknown')}</div>
                                <div class="gwp-email-date">${em.date ? new Date(em.date).toLocaleString() : '—'}</div>
                            </div>
                            <div class="gwp-email-subject">${this._escHtml(em.subject)}</div>
                            <div class="gwp-email-to">To: ${this._escHtml(em.to || '—')}</div>
                            ${em.labels ? `<div class="gwp-email-labels">${em.labels.split(',').map(l => `<span class="gwp-tag-sm">${l.trim()}</span>`).join('')}</div>` : ''}
                            <div class="gwp-email-detail" id="gwp-email-detail-${idx}" style="display:none;">
                                <div class="gwp-email-headers">
                                    ${em.cc ? `<div class="gwp-field-sm"><label>CC:</label><span>${this._escHtml(em.cc)}</span></div>` : ''}
                                    ${em.threadId ? `<div class="gwp-field-sm"><label>Thread ID:</label><span class="gwp-mono">${em.threadId}</span></div>` : ''}
                                    ${em.attachments?.length ? `<div class="gwp-field-sm"><label>Attachments:</label><span>${em.attachments.map(a => a.filename).join(', ')}</span></div>` : ''}
                                </div>
                                <div class="gwp-email-body">
                                    ${em.htmlBody
                                        ? `<iframe class="gwp-email-iframe" srcdoc="${this._escAttr(em.htmlBody)}" sandbox=""></iframe>`
                                        : `<pre class="gwp-email-text">${this._escHtml(em.textBody || '(empty)')}</pre>`
                                    }
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    toggleEmailDetail(idx) {
        const el = document.getElementById(`gwp-email-detail-${idx}`);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    // ─── Location Section ───────────────────────────────────────────────

    _renderLocation(imp) {
        const records = imp.locationRecords || [];
        const semantic = imp.semanticLocations || [];

        if (records.length === 0 && semantic.length === 0) {
            return '<div class="gwp-empty-section">No location data in this warrant return</div>';
        }

        const visits = semantic.filter(s => s.type === 'placeVisit');
        const segments = semantic.filter(s => s.type === 'activitySegment');

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>📍 Location History</h3>
                    <span class="gwp-section-count">${records.length} raw points, ${visits.length} places, ${segments.length} trips</span>
                </div>

                <!-- Map -->
                <div class="gwp-card">
                    <div id="gwp-location-map" class="gwp-map"></div>
                </div>

                <!-- Place Visits -->
                ${visits.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Place Visits (${visits.length})</h4>
                    <div class="gwp-table-wrap">
                        <table class="gwp-table">
                            <thead><tr><th>Name</th><th>Address</th><th>Start</th><th>End</th><th>Confidence</th></tr></thead>
                            <tbody>
                                ${visits.map(v => `
                                    <tr>
                                        <td>${v.name || '—'}</td>
                                        <td>${v.address || '—'}</td>
                                        <td class="gwp-mono gwp-nowrap">${v.startTime || '—'}</td>
                                        <td class="gwp-mono gwp-nowrap">${v.endTime || '—'}</td>
                                        <td>${v.confidence ? v.confidence + '%' : '—'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- Raw Records -->
                ${records.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Raw Location Records (${records.length})</h4>
                    <div class="gwp-table-wrap" style="max-height: 400px; overflow-y: auto;">
                        <table class="gwp-table">
                            <thead><tr><th>Timestamp</th><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Source</th></tr></thead>
                            <tbody>
                                ${records.slice(0, 500).map(r => `
                                    <tr>
                                        <td class="gwp-mono gwp-nowrap">${r.timestamp || '—'}</td>
                                        <td class="gwp-mono">${r.lat?.toFixed(6) || '—'}</td>
                                        <td class="gwp-mono">${r.lng?.toFixed(6) || '—'}</td>
                                        <td>${r.accuracy || '—'}</td>
                                        <td>${r.source || '—'}</td>
                                    </tr>
                                `).join('')}
                                ${records.length > 500 ? `<tr><td colspan="5" class="gwp-more">... ${records.length - 500} more records</td></tr>` : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    initLocationMap(imp) {
        const records = imp?.locationRecords || [];
        const semantic = imp?.semanticLocations || [];
        const mapEl = document.getElementById('gwp-location-map');
        if (!mapEl || typeof L === 'undefined') return;

        const points = records.filter(r => r.lat && r.lng).map(r => [r.lat, r.lng]);
        const visits = semantic.filter(s => s.type === 'placeVisit' && s.lat && s.lng);

        if (points.length === 0 && visits.length === 0) {
            mapEl.innerHTML = '<div class="gwp-empty-section">No coordinates to display</div>';
            return;
        }

        const map = L.map('gwp-location-map', { preferCanvas: true }).setView([0, 0], 2);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap, © CARTO',
            maxZoom: 19
        }).addTo(map);

        const allCoords = [];

        // Raw location points as circle markers
        if (points.length > 0) {
            const group = L.layerGroup();
            points.forEach(([lat, lng]) => {
                L.circleMarker([lat, lng], { radius: 3, color: '#00d9ff', fillColor: '#00d9ff', fillOpacity: 0.6, weight: 1 }).addTo(group);
                allCoords.push([lat, lng]);
            });
            group.addTo(map);
        }

        // Place visits as labeled markers
        visits.forEach(v => {
            L.marker([v.lat, v.lng]).addTo(map).bindPopup(`<b>${v.name || 'Unknown'}</b><br>${v.address || ''}<br>${v.startTime || ''}`);
            allCoords.push([v.lat, v.lng]);
        });

        if (allCoords.length > 0) {
            map.fitBounds(allCoords, { padding: [30, 30] });
        }
    }

    // ─── Communications ─────────────────────────────────────────────────

    _renderCommunications(imp) {
        const messages = imp.chatMessages || [];
        const hangouts = imp.hangoutsInfo;

        if (messages.length === 0 && !hangouts) {
            return '<div class="gwp-empty-section">No communications data in this warrant return</div>';
        }

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>💬 Communications</h3>
                </div>

                ${hangouts ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Hangouts User Info</h4>
                    ${Object.entries(hangouts).map(([k, v]) => `
                        <div class="gwp-field"><label>${k}</label><span>${v}</span></div>
                    `).join('')}
                </div>
                ` : ''}

                ${imp.chatUserInfo ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Google Chat User Info</h4>
                    <pre class="gwp-pre">${this._escHtml(typeof imp.chatUserInfo === 'string' ? imp.chatUserInfo : JSON.stringify(imp.chatUserInfo, null, 2))}</pre>
                </div>
                ` : ''}

                ${messages.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Chat Messages (${messages.length})</h4>
                    <div class="gwp-chat-list">
                        ${messages.map(msg => {
                            if (msg.type === 'html') {
                                return `<div class="gwp-chat-html">${msg.content}</div>`;
                            }
                            return `<pre class="gwp-pre">${this._escHtml(JSON.stringify(msg, null, 2))}</pre>`;
                        }).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Devices & Apps ─────────────────────────────────────────────────

    _renderDevices(imp) {
        const devices = imp.devices || [];
        const installs = imp.installs || [];
        const library = imp.library || [];
        const activity = imp.userActivity || [];

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>📱 Devices & Apps</h3>
                </div>

                <!-- Devices -->
                ${devices.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Registered Devices (${devices.length})</h4>
                    <div class="gwp-device-grid">
                        ${devices.map(d => `
                            <div class="gwp-device-card">
                                <div class="gwp-device-icon">📱</div>
                                <div class="gwp-device-info">
                                    <div class="gwp-device-model">${d.manufacturer || ''} ${d.model || 'Unknown Device'}</div>
                                    <div class="gwp-device-detail">${d.brand || ''} • ${d.carrier || 'No carrier'}</div>
                                    <div class="gwp-device-detail">Android SDK ${d.sdkVersion || '?'} • ${d.locale || ''}</div>
                                    <div class="gwp-device-detail gwp-mono" title="Android ID">${d.androidId || ''}</div>
                                    <div class="gwp-field-sm"><label>Registered</label><span>${d.registrationTime ? new Date(d.registrationTime).toLocaleString() : '—'}</span></div>
                                    <div class="gwp-field-sm"><label>Last Active</label><span>${d.lastActive ? new Date(d.lastActive).toLocaleString() : '—'}</span></div>
                                    ${d.buildFingerprint ? `<div class="gwp-device-fp gwp-mono">${d.buildFingerprint}</div>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                <!-- Installed Apps -->
                ${installs.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Installed Apps (${installs.length})</h4>
                    <div class="gwp-filter-bar">
                        <input type="text" id="gwp-app-search" placeholder="Search apps..." class="gwp-search-input" oninput="window.googleWarrantUI.filterApps()">
                        <label class="gwp-checkbox-label">
                            <input type="checkbox" id="gwp-hide-system" onchange="window.googleWarrantUI.filterApps()">
                            Hide system apps
                        </label>
                    </div>
                    <div class="gwp-table-wrap" style="max-height: 500px; overflow-y: auto;">
                        <table class="gwp-table" id="gwp-apps-table">
                            <thead>
                                <tr>
                                    <th>App Name</th>
                                    <th>Package</th>
                                    <th>Install Date</th>
                                    <th>Source</th>
                                    <th>System</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${installs.map(app => `
                                    <tr data-package="${this._escAttr(app.packageName || '')}" data-system="${app.isSystemApp}">
                                        <td>${this._escHtml(app.title || app.packageName || '—')}</td>
                                        <td class="gwp-mono gwp-truncate" title="${this._escAttr(app.packageName || '')}">${app.packageName || '—'}</td>
                                        <td class="gwp-mono gwp-nowrap">${app.installTime ? new Date(app.installTime).toLocaleString() : '—'}</td>
                                        <td><span class="gwp-tag-sm">${app.installSource || '—'}</span></td>
                                        <td>${app.isSystemApp ? '✓' : ''}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- Library -->
                ${library.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">App Library (${library.length})</h4>
                    <div class="gwp-table-wrap" style="max-height: 400px; overflow-y: auto;">
                        <table class="gwp-table">
                            <thead><tr><th>App</th><th>Package</th><th>Acquired</th></tr></thead>
                            <tbody>
                                ${library.map(app => `
                                    <tr>
                                        <td>${this._escHtml(app.title || '—')}</td>
                                        <td class="gwp-mono gwp-truncate">${app.packageName || '—'}</td>
                                        <td class="gwp-mono gwp-nowrap">${app.acquisitionTime ? new Date(app.acquisitionTime).toLocaleString() : '—'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- User Activity -->
                ${activity.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Play Store Activity (${activity.length} events)</h4>
                    <div class="gwp-activity-list">
                        ${activity.slice(0, 200).map(a => `
                            <div class="gwp-activity-item">
                                <div class="gwp-activity-action">${this._escHtml(a.action)}</div>
                                <div class="gwp-activity-time">${a.timestamp}</div>
                            </div>
                        `).join('')}
                        ${activity.length > 200 ? `<div class="gwp-more">... ${activity.length - 200} more events</div>` : ''}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    filterApps() {
        const search = (document.getElementById('gwp-app-search')?.value || '').toLowerCase();
        const hideSystem = document.getElementById('gwp-hide-system')?.checked || false;
        const rows = document.querySelectorAll('#gwp-apps-table tbody tr');
        rows.forEach(row => {
            const pkg = (row.dataset.package || '').toLowerCase();
            const text = row.textContent.toLowerCase();
            const isSystem = row.dataset.system === 'true';
            const matchSearch = !search || text.includes(search) || pkg.includes(search);
            const matchSystem = !hideSystem || !isSystem;
            row.style.display = (matchSearch && matchSystem) ? '' : 'none';
        });
    }

    // ─── Payments ───────────────────────────────────────────────────────

    _renderPayments(imp) {
        const pay = imp.googlePay || {};
        if (!pay.instruments?.length && !pay.transactions?.length && !pay.addresses?.length) {
            return '<div class="gwp-empty-section">No payment data in this warrant return</div>';
        }

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>💳 Google Pay</h3>
                </div>

                ${pay.instruments?.length ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Payment Methods (${pay.instruments.length})</h4>
                    <div class="gwp-device-grid">
                        ${pay.instruments.map(inst => `
                            <div class="gwp-device-card">
                                <div class="gwp-device-icon">💳</div>
                                <div class="gwp-device-info">
                                    ${Object.entries(inst).map(([k, v]) => `
                                        <div class="gwp-field-sm"><label>${k}</label><span>${v}</span></div>
                                    `).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                ${pay.transactions?.length ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Transactions (${pay.transactions.length})</h4>
                    <div class="gwp-table-wrap">
                        <table class="gwp-table">
                            <thead><tr>${Object.keys(pay.transactions[0]).map(k => `<th>${k}</th>`).join('')}</tr></thead>
                            <tbody>
                                ${pay.transactions.map(t => `
                                    <tr>${Object.values(t).map(v => `<td>${this._escHtml(String(v))}</td>`).join('')}</tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                ${pay.addresses?.length ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Billing/Shipping Addresses (${pay.addresses.length})</h4>
                    <div class="gwp-device-grid">
                        ${pay.addresses.map(addr => `
                            <div class="gwp-device-card">
                                <div class="gwp-device-icon">📫</div>
                                <div class="gwp-device-info">
                                    ${Object.entries(addr).map(([k, v]) => `
                                        <div class="gwp-field-sm"><label>${k}</label><span>${v}</span></div>
                                    `).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    // ─── Files ──────────────────────────────────────────────────────────

    _renderFiles(imp) {
        const files = imp.driveFiles || [];
        if (files.length === 0) return '<div class="gwp-empty-section">No Drive file data in this warrant return</div>';

        // Separate media files from metadata
        const mediaFiles = files.filter(f => f._isFile);
        const metadataItems = files.filter(f => !f._isFile);

        const images = mediaFiles.filter(f => f.mimeType?.startsWith('image/'));
        const videos = mediaFiles.filter(f => f.mimeType?.startsWith('video/'));
        const pdfs = mediaFiles.filter(f => f.mimeType === 'application/pdf');
        const audio = mediaFiles.filter(f => f.mimeType?.startsWith('audio/'));
        const otherFiles = mediaFiles.filter(f => !f.mimeType?.startsWith('image/') && !f.mimeType?.startsWith('video/') && !f.mimeType?.startsWith('audio/') && f.mimeType !== 'application/pdf');

        const formatSize = (s) => {
            if (!s) return '—';
            if (s < 1024) return s + ' B';
            if (s < 1048576) return (s / 1024).toFixed(1) + ' KB';
            return (s / 1048576).toFixed(1) + ' MB';
        };

        let html = `<div class="gwp-section-scroll">
            <div class="gwp-section-header">
                <h3>📁 Google Drive Contents (${files.length} items)</h3>
            </div>
            <div class="gwp-drive-stats">
                ${images.length ? `<span class="gwp-tag">🖼️ ${images.length} photos</span>` : ''}
                ${videos.length ? `<span class="gwp-tag">🎬 ${videos.length} videos</span>` : ''}
                ${pdfs.length ? `<span class="gwp-tag">📕 ${pdfs.length} PDFs</span>` : ''}
                ${audio.length ? `<span class="gwp-tag">🎵 ${audio.length} audio</span>` : ''}
                ${otherFiles.length ? `<span class="gwp-tag">📄 ${otherFiles.length} other</span>` : ''}
                ${metadataItems.length ? `<span class="gwp-tag">📋 ${metadataItems.length} metadata</span>` : ''}
            </div>`;

        // ── Photo Gallery ──
        if (images.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">🖼️ Photos (${images.length})</h4>
                <div class="gwp-gallery">
                    ${images.map((f, i) => `
                        <div class="gwp-gallery-item" onclick="gwpShowLightbox('${f.mimeType}', '${f.data.substring(0, 50)}...', ${i}, 'img')">
                            <img src="data:${f.mimeType};base64,${f.data}" alt="${this._escAttr(f.name)}" loading="lazy">
                            <div class="gwp-gallery-label">${this._escHtml(f.name)}<br><span>${formatSize(f.size)}</span></div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // ── Videos ──
        if (videos.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">🎬 Videos (${videos.length})</h4>
                <div class="gwp-media-list">
                    ${videos.map(f => `
                        <div class="gwp-media-item">
                            <video controls preload="metadata" class="gwp-video-player">
                                <source src="data:${f.mimeType};base64,${f.data}" type="${f.mimeType}">
                            </video>
                            <div class="gwp-media-label">${this._escHtml(f.name)} <span class="gwp-mono">(${formatSize(f.size)})</span></div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // ── PDFs ──
        if (pdfs.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">📕 PDF Documents (${pdfs.length})</h4>
                <div class="gwp-file-list">
                    ${pdfs.map((f, i) => `
                        <div class="gwp-file-item">
                            <div class="gwp-file-info">
                                <span class="gwp-file-icon">📕</span>
                                <span class="gwp-file-name">${this._escHtml(f.name)}</span>
                                <span class="gwp-mono gwp-file-size">${formatSize(f.size)}</span>
                            </div>
                            <div class="gwp-file-actions">
                                <button class="gwp-btn-sm" onclick="gwpViewPdf(${i})">View</button>
                                <button class="gwp-btn-sm gwp-btn-outline" onclick="gwpDownloadFile('${this._escAttr(f.name)}', '${f.mimeType}', ${i}, 'pdf')">Download</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div id="gwp-pdf-viewer" class="gwp-pdf-viewer hidden"></div>
            </div>`;
        }

        // ── Audio ──
        if (audio.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">🎵 Audio (${audio.length})</h4>
                <div class="gwp-media-list">
                    ${audio.map(f => `
                        <div class="gwp-media-item gwp-audio-item">
                            <span class="gwp-file-name">${this._escHtml(f.name)} <span class="gwp-mono">(${formatSize(f.size)})</span></span>
                            <audio controls preload="metadata">
                                <source src="data:${f.mimeType};base64,${f.data}" type="${f.mimeType}">
                            </audio>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // ── Other files ──
        if (otherFiles.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">📄 Other Files (${otherFiles.length})</h4>
                <div class="gwp-file-list">
                    ${otherFiles.map((f, i) => `
                        <div class="gwp-file-item">
                            <div class="gwp-file-info">
                                <span class="gwp-file-icon">📄</span>
                                <span class="gwp-file-name">${this._escHtml(f.name)}</span>
                                <span class="gwp-tag">${f.mimeType?.split('/').pop() || '?'}</span>
                                <span class="gwp-mono gwp-file-size">${formatSize(f.size)}</span>
                            </div>
                            <div class="gwp-file-actions">
                                <button class="gwp-btn-sm gwp-btn-outline" onclick="gwpDownloadFile('${this._escAttr(f.name)}', '${f.mimeType}', ${i}, 'other')">Download</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // ── Metadata entries ──
        if (metadataItems.length > 0) {
            const getFileName = (f) => f.name || f.title || f.fileName || f.originalFilename || 'Metadata';
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">📋 Drive Metadata (${metadataItems.length})</h4>
                ${metadataItems.map(f => `
                    <details class="gwp-drive-raw">
                        <summary class="gwp-drive-raw-summary">${this._escHtml(getFileName(f))}</summary>
                        <pre class="gwp-pre">${this._escHtml(JSON.stringify(f, null, 2))}</pre>
                    </details>
                `).join('')}
            </div>`;
        }

        html += '</div>';
        return html;
    }

    // ─── Timeline ───────────────────────────────────────────────────────

    _renderTimeline(imp) {
        // Collect all timestamped events across categories
        const events = [];

        // IP Activity
        (imp.ipActivity || []).forEach(ip => {
            if (ip.timestamp) events.push({ time: ip.timestamp, type: 'login', icon: '🔑', title: `Login from ${ip.ip}`, detail: `${ip.activityType} • ${ip.userAgent || ''}` });
        });

        // Change History
        (imp.changeHistory || []).forEach(ch => {
            if (ch.timestamp) events.push({ time: ch.timestamp, type: 'change', icon: '⚙️', title: ch.changeType, detail: `${ch.oldValue || ''} → ${ch.newValue || ''}` });
        });

        // Emails
        (imp.emails || []).forEach(em => {
            if (em.date) events.push({ time: em.date, type: 'email', icon: '📧', title: em.subject, detail: `From: ${em.from} → To: ${em.to}` });
        });

        // Location visits
        (imp.semanticLocations || []).filter(s => s.type === 'placeVisit' && s.startTime).forEach(v => {
            events.push({ time: v.startTime, type: 'location', icon: '📍', title: v.name || 'Place Visit', detail: v.address || '' });
        });

        // App installs
        (imp.installs || []).filter(a => a.installTime && !a.isSystemApp).forEach(app => {
            events.push({ time: app.installTime, type: 'app', icon: '📲', title: `Installed: ${app.title || app.packageName}`, detail: app.installSource || '' });
        });

        // User Activity
        (imp.userActivity || []).forEach(a => {
            if (a.timestamp) {
                // Parse Google's date format "Sep 18, 2022, 2:32:01 PM UTC"
                const d = new Date(a.timestamp);
                if (!isNaN(d)) {
                    events.push({ time: d.toISOString(), type: 'activity', icon: '📱', title: a.action, detail: '' });
                }
            }
        });

        // Sort by timestamp descending
        events.sort((a, b) => {
            const ta = new Date(a.time).getTime() || 0;
            const tb = new Date(b.time).getTime() || 0;
            return tb - ta;
        });

        if (events.length === 0) {
            return '<div class="gwp-empty-section">No timestamped events to display</div>';
        }

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>🕐 Unified Timeline (${events.length} events)</h3>
                    <div class="gwp-filter-bar">
                        <select id="gwp-timeline-filter" class="gwp-select" onchange="window.googleWarrantUI.filterTimeline()">
                            <option value="all">All Events</option>
                            <option value="login">Logins</option>
                            <option value="email">Emails</option>
                            <option value="location">Locations</option>
                            <option value="app">App Installs</option>
                            <option value="change">Account Changes</option>
                            <option value="activity">Play Store Activity</option>
                        </select>
                    </div>
                </div>
                <div class="gwp-timeline" id="gwp-timeline">
                    ${events.slice(0, 500).map(ev => `
                        <div class="gwp-timeline-item" data-type="${ev.type}">
                            <div class="gwp-timeline-dot">${ev.icon}</div>
                            <div class="gwp-timeline-content">
                                <div class="gwp-timeline-time">${this._formatTime(ev.time)}</div>
                                <div class="gwp-timeline-title">${this._escHtml(ev.title)}</div>
                                ${ev.detail ? `<div class="gwp-timeline-detail">${this._escHtml(ev.detail)}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                    ${events.length > 500 ? `<div class="gwp-more">... ${events.length - 500} more events</div>` : ''}
                </div>
            </div>
        `;
    }

    filterTimeline() {
        const filter = document.getElementById('gwp-timeline-filter')?.value || 'all';
        document.querySelectorAll('.gwp-timeline-item').forEach(el => {
            el.style.display = (filter === 'all' || el.dataset.type === filter) ? '' : 'none';
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    _escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escAttr(str) {
        return this._escHtml(str).replace(/'/g, '&#39;');
    }

    _formatTime(timeStr) {
        try {
            const d = new Date(timeStr);
            if (isNaN(d)) return timeStr;
            return d.toLocaleString();
        } catch (e) {
            return timeStr;
        }
    }

    _toast(msg, type) {
        if (typeof viperToast === 'function') {
            viperToast(msg, type);
        } else if (typeof showNotification === 'function') {
            showNotification(msg, type);
        }
    }
}

// Expose on window so initializeGoogleWarrant() can find it
window.GoogleWarrantUI = GoogleWarrantUI;

// Global ARIN lookup for Google Warrant IP addresses
async function gwpArinLookup(btn, ip) {
    if (!ip || !window.electronAPI?.arinLookup) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
        const result = await window.electronAPI.arinLookup(ip);
        if (result.success) {
            const info = [result.provider || result.organization];
            if (result.network) info.push(result.network);
            if (result.netRange) info.push(result.netRange);
            // Insert result next to button
            const span = btn.nextElementSibling || document.createElement('span');
            span.className = 'gwp-arin-result gwp-arin-success';
            span.textContent = info.join(' · ');
            span.title = info.join('\n');
            if (!btn.nextElementSibling) btn.parentNode.appendChild(span);
            btn.textContent = '✓';
            btn.classList.add('gwp-arin-done');
        } else {
            btn.textContent = '✗';
            btn.title = result.error || 'Lookup failed';
            btn.classList.add('gwp-arin-fail');
        }
    } catch (e) {
        btn.textContent = '✗';
        btn.title = e.message;
        btn.classList.add('gwp-arin-fail');
    }
    btn.disabled = false;
}
window.gwpArinLookup = gwpArinLookup;

// ── Drive file helpers (lightbox, PDF viewer, download) ──

// Store reference to current import's driveFiles for global helpers
window._gwpDriveFiles = null;

function gwpShowLightbox(mimeType, dataPreview, idx, category) {
    const imp = window.googleWarrantModule?.imports?.[0];
    if (!imp) return;
    const files = (imp.driveFiles || []).filter(f => f._isFile);
    const images = files.filter(f => f.mimeType?.startsWith('image/'));
    const file = images[idx];
    if (!file) return;

    // Remove existing lightbox
    document.getElementById('gwp-lightbox')?.remove();

    const lb = document.createElement('div');
    lb.id = 'gwp-lightbox';
    lb.className = 'gwp-lightbox';
    lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
    lb.innerHTML = `
        <div class="gwp-lightbox-content">
            <button class="gwp-lightbox-close" onclick="document.getElementById('gwp-lightbox').remove()">✕</button>
            <img src="data:${file.mimeType};base64,${file.data}" alt="${file.name}">
            <div class="gwp-lightbox-caption">${file.name}</div>
            <div class="gwp-lightbox-nav">
                ${idx > 0 ? `<button onclick="event.stopPropagation(); document.getElementById('gwp-lightbox').remove(); gwpShowLightbox('','',${idx - 1},'img')">◀ Prev</button>` : '<span></span>'}
                <span>${idx + 1} / ${images.length}</span>
                ${idx < images.length - 1 ? `<button onclick="event.stopPropagation(); document.getElementById('gwp-lightbox').remove(); gwpShowLightbox('','',${idx + 1},'img')">Next ▶</button>` : '<span></span>'}
            </div>
        </div>
    `;
    document.body.appendChild(lb);
}
window.gwpShowLightbox = gwpShowLightbox;

function gwpViewPdf(idx) {
    const imp = window.googleWarrantModule?.imports?.[0];
    if (!imp) return;
    const pdfs = (imp.driveFiles || []).filter(f => f._isFile && f.mimeType === 'application/pdf');
    const file = pdfs[idx];
    if (!file) return;

    const viewer = document.getElementById('gwp-pdf-viewer');
    if (!viewer) return;
    viewer.classList.remove('hidden');
    viewer.innerHTML = `
        <div class="gwp-pdf-header">
            <span>${file.name}</span>
            <button class="gwp-close-btn" onclick="document.getElementById('gwp-pdf-viewer').classList.add('hidden')">✕</button>
        </div>
        <iframe src="data:application/pdf;base64,${file.data}" class="gwp-pdf-iframe"></iframe>
    `;
}
window.gwpViewPdf = gwpViewPdf;

function gwpDownloadFile(name, mimeType, idx, category) {
    const imp = window.googleWarrantModule?.imports?.[0];
    if (!imp) return;
    let pool;
    if (category === 'pdf') pool = (imp.driveFiles || []).filter(f => f._isFile && f.mimeType === 'application/pdf');
    else pool = (imp.driveFiles || []).filter(f => f._isFile && !f.mimeType?.startsWith('image/') && !f.mimeType?.startsWith('video/') && !f.mimeType?.startsWith('audio/') && f.mimeType !== 'application/pdf');
    const file = pool[idx];
    if (!file) return;

    const a = document.createElement('a');
    a.href = `data:${file.mimeType};base64,${file.data}`;
    a.download = file.name;
    a.click();
}
window.gwpDownloadFile = gwpDownloadFile;
