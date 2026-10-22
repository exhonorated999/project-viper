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
                    ${this._renderFlagToolbar()}
                    ${this._renderNav()}
                </div>
                <div class="gwp-content" id="gwp-content-area">
                    ${this._renderSection()}
                </div>
            </div>
            <div id="gwp-evidence-bar"></div>
        `;
        this._afterSectionRender();
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
            const notice = this.module._mergeNotice;
            if (notice && notice.targetId === record.id) {
                this._toast(`Merged into existing import for ${notice.accountEmail} — ${notice.partsCount} part(s) total`, 'success');
            } else {
                const photoCount = (record.photos && record.photos.filter(p => p.isMedia).length) || 0;
                this._toast(`Imported: ${record.accountEmail || fileName}${photoCount ? ` · ${photoCount} media file(s) extracted` : ''}`, 'success');
            }
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
            const notice = this.module._mergeNotice;
            if (notice && notice.targetId === record.id) {
                this._toast(`Merged into existing import for ${notice.accountEmail} — ${notice.partsCount} part(s) total`, 'success');
            } else {
                const photoCount = (record.photos && record.photos.filter(p => p.isMedia).length) || 0;
                this._toast(`Imported: ${record.accountEmail || record.fileName}${photoCount ? ` · ${photoCount} media file(s) extracted` : ''}`, 'success');
            }
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
        this._afterSectionRender();
    }

    /** Things that need the section's DOM in place (the location map). */
    _afterSectionRender() {
        if (this.activeSection === 'location') {
            const imp = this.currentImport;
            setTimeout(() => { if (this.activeSection === 'location' && this.currentImport === imp) this.initLocationMap(imp); }, 0);
        }
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

        // Count rawSections (catch-all) entries — sidebar tab shows if non-zero
        const rawSectionCount = imp.rawSections
            ? Object.values(imp.rawSections).reduce((sum, b) => sum + (b.html?.length || 0) + (b.csv?.length || 0) + (b.json?.length || 0) + (b.other?.length || 0), 0)
            : 0;
        const rawCatCount = imp.rawSections ? Object.keys(imp.rawSections).length : 0;

        // Extra category counts
        const myActivityCount = imp.myActivity?.length || 0;
        const contactsCount = imp.contacts?.length || 0;
        const calendarsCount = imp.calendars?.length || 0;
        const tasksCount = imp.tasks?.length || 0;
        const meetCount = imp.meetHistory?.length || 0;
        const linkedCount = imp.linkedByPhone?.length || 0;
        const aggCount = imp.aggregatedActivity?.length || 0;
        const photosCount = imp.photos?.filter(p => p.isMedia !== false).length || 0;

        const sections = [
            { id: 'overview', label: 'Account Overview', icon: '👤', show: true },
            { id: 'email', label: 'Email', icon: '📧', count: this.module.emailTotal(imp), show: this.module.emailTotal(imp) > 0 },
            { id: 'location', label: 'Location', icon: '📍', count: this.module.locationTotal(imp) + (imp.semanticLocations?.length || 0), show: this.module.locationTotal(imp) > 0 || imp.semanticLocations?.length > 0 },
            { id: 'communications', label: 'Communications', icon: '💬', show: imp.chatMessages?.length > 0 || imp.hangoutsInfo },
            { id: 'activity', label: 'Activity', icon: '⚡', count: myActivityCount + aggCount, show: (myActivityCount + aggCount) > 0 },
            { id: 'devices', label: 'Devices & Apps', icon: '📱', count: imp.devices?.length, show: imp.devices?.length > 0 || imp.installs?.length > 0 },
            { id: 'contacts', label: 'Contacts', icon: '👥', count: contactsCount, show: contactsCount > 0 },
            { id: 'calendar', label: 'Calendar', icon: '📅', count: calendarsCount, show: calendarsCount > 0 || imp.calendarSettings },
            { id: 'tasks', label: 'Tasks', icon: '✅', count: tasksCount, show: tasksCount > 0 },
            { id: 'meet', label: 'Meet History', icon: '🎥', count: meetCount, show: meetCount > 0 },
            { id: 'linked', label: 'Linked Accounts', icon: '🔗', count: linkedCount, show: linkedCount > 0 },
            { id: 'payments', label: 'Payments', icon: '💳', show: imp.googlePay?.instruments?.length > 0 || imp.googlePay?.transactions?.length > 0 || imp.googlePay?.customerInfo },
            { id: 'photos', label: 'Photos & Media', icon: '🖼️', count: photosCount, show: photosCount > 0 },
            { id: 'files', label: 'Files', icon: '📁', show: imp.driveFiles?.length > 0 },
            { id: 'other', label: 'Other Data', icon: '📦', count: rawCatCount, show: rawSectionCount > 0 },
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
                        ${s.count ? `<span class="gwp-nav-badge">${typeof s.count === 'number' ? s.count.toLocaleString() : s.count}</span>` : ''}
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
            case 'activity': return this._renderActivity(imp);
            case 'devices': return this._renderDevices(imp);
            case 'contacts': return this._renderContacts(imp);
            case 'calendar': return this._renderCalendar(imp);
            case 'tasks': return this._renderTasks(imp);
            case 'meet': return this._renderMeet(imp);
            case 'linked': return this._renderLinked(imp);
            case 'payments': return this._renderPayments(imp);
            case 'photos': return this._renderPhotos(imp);
            case 'files': return this._renderFiles(imp);
            case 'other': return this._renderOther(imp);
            case 'timeline': return this._renderTimeline(imp);
            default: return '<div class="gwp-empty-section">Unknown section</div>';
        }
    }

    // ─── Flag-to-Evidence toolbar (sidebar) ────────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        const enabled = total > 0;
        return `
            <div class="gwp-flag-toolbar">
                <button class="gwp-flag-header-btn"
                        title="Flagged item count — click to clear all flags"
                        onclick="window.googleWarrantUI.module.clearFlags(); window.googleWarrantUI._refreshFlagToolbar(); const c=document.getElementById('gwp-content-area'); if(c) c.innerHTML=window.googleWarrantUI._renderSection();">
                    🚩 Flags
                    <span class="gwp-flag-count-pill" id="gwp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="gwp-flag-toolbar-spacer"></div>
                <button class="gwp-push-btn" id="gwp-push-btn"
                        ${enabled ? '' : 'disabled'}
                        onclick="window.googleWarrantUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('gwp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('gwp-push-btn');
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

        const btn = document.getElementById('gwp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                this.module.clearFlags();
                this._refreshFlagToolbar();
                const content = document.getElementById('gwp-content-area');
                if (content) content.innerHTML = this._renderSection();
            }
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '📥 Push to Evidence'; }
            this._refreshFlagToolbar();
        }
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        const imp = this.currentImport;
        if (section === 'emails' && imp && this.module.hasStore(imp)) {
            if (this.module.isFlagged('emails', key)) {
                const row = (this._em && this._em.rows || []).find(r => String(r.id) === String(key));
                if (row) this.module.cacheFlaggedEmail(imp, row);
            } else if (imp.flaggedEmailCache && imp.flaggedEmailCache[String(key)]) {
                delete imp.flaggedEmailCache[String(key)];
                this.module.saveData();
            }
        }
        this._refreshFlagToolbar();
        // Re-render the current section to update flag-button state on the visible row
        this._refreshContent();
    }

    /**
     * 🔍 Source button: open the original return at this record. What is
     * searched for comes from the module's _citationFor, so this button and
     * the Flag → Evidence report always look for the same thing.
     */
    _srcBtn(section, item, title, valueLabels) {
        const imp = this.currentImport;
        if (!imp || typeof window === 'undefined' || !window.SourceViewer || !this.module._citationFor) return '';
        const cit = this.module._citationFor(imp, section, item) || {};
        const vals = [], vLabels = [];
        (cit.values || []).forEach((v, i) => {
            const sv = v == null ? '' : String(v).trim();
            if (i === 0 || sv) { vals.push(sv); vLabels.push((valueLabels || [])[i] || (i === 0 ? title : 'related detail')); }
        });
        if (!vals[0]) return '';
        const module = this.module;
        const impId = imp.id;
        const current = () => module.imports.find(i => i && i.id === impId) || imp;
        const spec0 = module._sourceSpec(imp);
        return window.SourceViewer.buttonHtml({
            title,
            values: vals,
            valueLabels: vLabels,
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

    _flagBtn(section, key, label) {
        const on = this.module.isFlagged(section, key);
        const safeKey = String(key)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        return `<button class="gwp-flag-btn ${on ? 'on' : ''}"
                        title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                        onclick="event.stopPropagation(); window.googleWarrantUI._onFlagClick('${section}', '${safeKey}')">
                  🚩${label ? '<span style="margin-left:2px">' + label + '</span>' : ''}
                </button>`;
    }

    // ─── Account Overview ───────────────────────────────────────────────

    _renderParserReport(imp) {
        const d = imp._diagnostics;
        if (!d) return '';
        const innerCount = d.innerZipsFound || 0;
        const bundlesOpened = d.masterBundlesOpened || 0;
        const accounted = (d.processed || 0) + (d.noRecords || 0) + (d.skippedPattern || 0) + ((d.errors && d.errors.length) || 0);
        const hasErrors = (d.errors && d.errors.length) > 0;
        const hasPatternSkip = (d.skippedPattern || 0) > 0;
        // Note: bundle contents add to innerZipsFound; accounted should match within reason after dedup
        const healthy = !hasErrors && !hasPatternSkip;
        const color = healthy ? '#10b981' : (hasErrors ? '#ef4444' : '#f59e0b');
        const label = healthy ? 'OK' : (hasErrors ? 'ISSUES' : 'WARNINGS');
        const errorList = hasErrors
            ? d.errors.map(e => `<div style="margin-top:4px;color:#fca5a5;font-family:monospace;font-size:11px;">⚠ ${e.category} (${e.sizeMB} MB${e.source ? ', src=' + e.source : ''}): ${(e.error || '').replace(/</g,'&lt;')}</div>`).join('')
            : '';
        const patternSkipped = hasPatternSkip
            ? `<div style="margin-top:4px;color:#fcd34d;font-size:12px;">⚠ ${d.skippedPattern} inner zip(s) skipped because filename didn't match the Google warrant pattern. If this number is non-zero, the warrant return may use a non-standard layout — please share the file with the developer.</div>`
            : '';
        const bundleNote = bundlesOpened > 0
            ? `<span style="font-size:12px;color:#94a3b8;">(${bundlesOpened} master bundle${bundlesOpened > 1 ? 's' : ''} expanded)</span>`
            : '';
        return `
            <div class="gwp-field" style="align-items:flex-start;">
                <label>Parser Report</label>
                <div style="flex:1;">
                    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                        <span style="background:${color};color:#000;padding:2px 8px;border-radius:10px;font-weight:600;font-size:11px;">${label}</span>
                        <span style="font-size:12px;color:#cbd5e1;">${innerCount} inner zip(s) found</span>
                        ${bundleNote}
                        <span style="font-size:12px;color:#94a3b8;">→ ${d.processed} with records, ${d.noRecords} empty, ${d.skippedPattern} non-standard, ${(d.errors && d.errors.length) || 0} errors</span>
                    </div>
                    ${patternSkipped}
                    ${errorList}
                </div>
            </div>`;
    }

    /** Large returns: say what was not kept in full and where it was saved. */
    _renderLargeReturnNotice(imp) {
        const trunc = Object.entries(imp.truncated || {}).filter(([, n]) => n > 0);
        const over = Array.isArray(imp.oversizeFiles) ? imp.oversizeFiles : [];
        if (!trunc.length && !over.length) return '';
        const label = (k) => String(k).replace(/^googlePay\./, 'Google Pay ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
        const mb = (n) => ((n || 0) / 1048576).toFixed(0) + ' MB';
        return `
            <div class="gwp-card" style="border-left:3px solid #f59e0b;">
                <h4 class="gwp-card-title">⚠ Large return — some data is not shown in full</h4>
                ${trunc.length ? `
                <div class="gwp-more" style="text-align:left;">To keep VIPER responsive, these sections show only part of their data here. The rest is saved in this case's folder under Evidence\\google-warrant\\_store.</div>
                <ul style="margin:6px 0 10px 18px;">
                    ${trunc.map(([k, n]) => `<li>${this._escape(label(k))}: ${Number(n).toLocaleString()} not shown</li>`).join('')}
                </ul>` : ''}
                ${over.length ? `
                <div class="gwp-more" style="text-align:left;">These files were too large to read inside VIPER. They were copied to the case folder so you can open them in another program.</div>
                <div class="gwp-file-list">
                    ${over.map((f, i) => `
                        <div class="gwp-file-item">
                            <div class="gwp-file-info">
                                <span class="gwp-file-icon">📄</span>
                                <span class="gwp-file-name">${this._escape(f.name || '')}</span>
                                <span class="gwp-tag">${this._escape(f.category || '')}</span>
                                <span class="gwp-mono gwp-file-size">${mb(f.size)}</span>
                            </div>
                            <div class="gwp-file-actions">${f.relPath
                                ? `<button class="gwp-btn-sm gwp-btn-outline" onclick="window.googleWarrantUI.openOversizeFile(${i})">Show in folder</button>`
                                : '<span class="gwp-tag">not saved (no case folder)</span>'}</div>
                        </div>`).join('')}
                </div>` : ''}
            </div>`;
    }

    async openOversizeFile(i) {
        const f = ((this.currentImport && this.currentImport.oversizeFiles) || [])[i];
        if (!f || !f.relPath) return;
        const res = await this.module.openMedia(f.relPath, true);
        if (!res || !res.success) this._toast('Could not open folder: ' + ((res && res.error) || 'unknown error'), 'error');
    }

    _renderOverview(imp) {
        const sub = imp.subscriber || {};
        const cats = imp.categories || [];
        const noCats = imp.noRecordCategories || [];

        return `
            <div class="gwp-section-scroll">
                ${this._renderLargeReturnNotice(imp)}
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
                    ${this._renderParserReport(imp)}
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
                                    <th>Flag</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${imp.ipActivity.map((ip, idx) => {
                                    const fk = window.WarrantFlagsKey.googleIpActivity(ip);
                                    const flagged = this.module.isFlagged('ipActivity', fk);
                                    return `
                                    <tr class="${flagged ? 'gwp-row-flagged' : ''}">
                                        <td class="gwp-mono gwp-nowrap">${ip.timestamp}</td>
                                        <td class="gwp-mono">
                                            ${ip.ip}
                                            <button class="gwp-arin-btn" onclick="gwpArinLookup(this, '${ip.ip}')" title="ARIN WHOIS Lookup">🌐</button>
                                            <span class="gwp-arin-result" id="gwp-arin-${imp.id}-${idx}"></span>
                                        </td>
                                        <td>${ip.activityType}</td>
                                        <td class="gwp-mono gwp-truncate" title="${ip.androidId || ''}">${ip.androidId || '—'}</td>
                                        <td class="gwp-truncate" title="${ip.userAgent || ''}">${ip.userAgent || '—'}</td>
                                        <td class="gwp-nowrap">${this._srcBtn('ipActivity', ip, 'IP address', ['IP address', 'Timestamp', 'Activity'])}${this._flagBtn('ipActivity', fk)}</td>
                                    </tr>`;
                                }).join('')}
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
                                <tr><th>Timestamp</th><th>IP</th><th>Change Type</th><th>Old Value</th><th>New Value</th><th>Flag</th></tr>
                            </thead>
                            <tbody>
                                ${imp.changeHistory.map((ch, idx) => {
                                    const fk = window.WarrantFlagsKey.googleChangeHistory(ch);
                                    const flagged = this.module.isFlagged('changeHistory', fk);
                                    return `
                                    <tr class="${flagged ? 'gwp-row-flagged' : ''}">
                                        <td class="gwp-mono gwp-nowrap">${ch.timestamp}</td>
                                        <td class="gwp-mono">${ch.ip ? `${ch.ip} <button class="gwp-arin-btn" onclick="gwpArinLookup(this, '${ch.ip}')" title="ARIN WHOIS Lookup">🌐</button>` : '—'}</td>
                                        <td><span class="gwp-badge-change">${ch.changeType}</span></td>
                                        <td>${ch.oldValue || '—'}</td>
                                        <td>${ch.newValue || '—'}</td>
                                        <td class="gwp-nowrap">${this._srcBtn('changeHistory', ch, 'Account change', ['Timestamp', 'IP address', 'Change type'])}${this._flagBtn('changeHistory', fk)}</td>
                                    </tr>`;
                                }).join('')}
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
        if (this.module.hasStore && this.module.hasStore(imp)) return this._renderStoreEmail(imp);
        const emails = imp.emails || [];
        if (emails.length === 0) return '<div class="gwp-empty-section">No email data in this warrant return</div>';
        return `<div class="gwp-section-scroll">${this._renderEmailInline(emails, `📧 Email Messages (${emails.length})`)}</div>`;
    }

    _renderEmailInline(emails, title) {
        return `
                <div class="gwp-section-header">
                    <h3>${title}</h3>
                </div>
                <div class="gwp-email-list">
                    ${emails.map((em, idx) => {
                        const flagged = this.module.isFlagged('emails', em.id);
                        return `
                        <div class="gwp-email-item ${flagged ? 'gwp-flagged' : ''}" onclick="window.googleWarrantUI.toggleEmailDetail(${idx})">
                            <div class="gwp-email-row">
                                <div class="gwp-email-from">${this._escHtml(em.from || 'Unknown')}</div>
                                <div class="gwp-email-date">${em.date ? new Date(em.date).toLocaleString() : '—'}</div>
                                <span style="margin-left:auto;white-space:nowrap">${this._srcBtn('emails', em, 'Email', ['Message-ID', 'From', 'Subject'])}${this._flagBtn('emails', em.id)}</span>
                            </div>
                            <div class="gwp-email-subject">${this._escHtml(em.subject)}</div>
                            <div class="gwp-email-to">To: ${this._escHtml(em.to || '—')}</div>
                            ${em.labels ? `<div class="gwp-email-labels">${em.labels.split(',').map(l => `<span class="gwp-tag-sm">${this._escHtml(l.trim())}</span>`).join('')}</div>` : ''}
                            <div class="gwp-email-detail" id="gwp-email-detail-${idx}" style="display:none;">
                                <div class="gwp-email-headers">
                                    ${em.cc ? `<div class="gwp-field-sm"><label>CC:</label><span>${this._escHtml(em.cc)}</span></div>` : ''}
                                    ${em.threadId ? `<div class="gwp-field-sm"><label>Thread ID:</label><span class="gwp-mono">${this._escHtml(em.threadId)}</span></div>` : ''}
                                    ${em.attachments?.length ? `<div class="gwp-field-sm"><label>Attachments:</label><span>${this._escHtml(em.attachments.map(a => a.filename).join(', '))}</span></div>` : ''}
                                </div>
                                <div class="gwp-email-body">
                                    ${em.htmlBody
                                        ? `<iframe class="gwp-email-iframe" srcdoc="${this._escAttr(em.htmlBody)}" sandbox=""></iframe>`
                                        : `<pre class="gwp-email-text">${this._escHtml(em.textBody || '(empty)')}</pre>`
                                    }
                                </div>
                            </div>
                        </div>
                    `;}).join('')}
                </div>`;
    }

    toggleEmailDetail(idx) {
        const el = document.getElementById(`gwp-email-detail-${idx}`);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    // ── Large returns: e-mails paged from the SQLite store ──

    _emailState(imp) {
        if (!this._em || this._em.impId !== imp.id || this._em.keysSig !== imp.store.keys.join('|')) {
            this._em = { impId: imp.id, keysSig: imp.store.keys.join('|'), q: '', offset: 0, limit: 50, total: null, rows: [], loading: false, error: null, stale: true };
        }
        return this._em;
    }

    async _loadEmails() {
        const imp = this.currentImport;
        if (!imp || !this.module.hasStore(imp)) return;
        const st = this._emailState(imp);
        if (st.loading) return;
        st.loading = true; st.stale = false; st.error = null;
        const want = { q: st.q, offset: st.offset };
        try {
            const res = await this.module.emailsPage(imp, { offset: st.offset, limit: st.limit, q: st.q });
            if (this._em !== st) return;
            if (res && res.success) { st.rows = res.rows || []; st.total = res.total || 0; }
            else { st.rows = []; st.total = 0; st.error = (res && res.error) || 'Could not read e-mails'; }
        } catch (e) {
            if (this._em === st) { st.rows = []; st.total = 0; st.error = e.message || String(e); }
        } finally {
            st.loading = false;
        }
        // The user may have paged/searched while this was in flight.
        if (st.q !== want.q || st.offset !== want.offset) { st.stale = true; return this._loadEmails(); }
        if (this.activeSection === 'email' && this.currentImport === imp) this._refreshContent();
    }

    _refreshContent() {
        const content = document.getElementById('gwp-content-area');
        if (content) {
            // Keep the email search box focused after Enter / async reload.
            const kf = (typeof window !== 'undefined') ? window.VpKeepFocus : null;
            const snap = kf ? kf.capture(content) : null;
            content.innerHTML = this._renderSection();
            if (kf) kf.restore(content, snap);
        }
        this._afterSectionRender();
    }

    emailSearch() {
        const st = this._em; if (!st) return;
        const el = document.getElementById('gwp-email-q');
        st.q = el ? el.value.trim() : '';
        st.offset = 0; st.stale = true;
        this._refreshContent();
    }

    emailPage(delta) {
        const st = this._em; if (!st || st.total == null) return;
        const next = st.offset + delta * st.limit;
        if (next < 0 || next >= st.total) return;
        st.offset = next; st.stale = true;
        this._refreshContent();
    }

    _renderStoreEmail(imp) {
        const st = this._emailState(imp);
        if (st.stale && !st.loading) setTimeout(() => this._loadEmails(), 0);
        const all = this.module.emailTotal(imp);
        const legacy = imp.legacyEmails || [];
        const shownFrom = st.total ? st.offset + 1 : 0;
        const shownTo = st.offset + st.rows.length;
        const fmt = (n) => Number(n || 0).toLocaleString();
        const nav = `
                <button class="gwp-btn-sm gwp-btn-outline" ${st.offset <= 0 ? 'disabled' : ''} onclick="window.googleWarrantUI.emailPage(-1)">◀ Prev</button>
                <span style="font-size:12px;color:#94a3b8;white-space:nowrap;">${st.loading || st.total == null ? 'Loading…' : `${fmt(shownFrom)}–${fmt(shownTo)} of ${fmt(st.total)}${st.q ? ' matching' : ''}`}</span>
                <button class="gwp-btn-sm gwp-btn-outline" ${st.total == null || shownTo >= st.total ? 'disabled' : ''} onclick="window.googleWarrantUI.emailPage(1)">Next ▶</button>`;
        const pager = `
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;">
                <input id="gwp-email-q" class="gwp-input" type="search" placeholder="Search subject, sender, recipient, body…" value="${this._escAttr(st.q)}"
                       style="flex:1;min-width:220px;padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;"
                       onkeydown="if(event.key==='Enter'){window.googleWarrantUI.emailSearch();}">
                <button class="gwp-btn-sm" onclick="window.googleWarrantUI.emailSearch()">Search</button>
                ${nav}
            </div>`;
        const rows = st.rows.map((em, i) => {
            const flagged = this.module.isFlagged('emails', em.id);
            return `
                <div class="gwp-email-item ${flagged ? 'gwp-flagged' : ''}" onclick="window.googleWarrantUI.toggleStoreEmail(${i})">
                    <div class="gwp-email-row">
                        <div class="gwp-email-from">${this._escHtml(em.from || 'Unknown')}</div>
                        <div class="gwp-email-date">${em.date ? new Date(em.date).toLocaleString() : '—'}</div>
                        <span style="margin-left:auto;white-space:nowrap">${em.attachments && em.attachments.length ? `<span title="${this._escAttr(em.attachments.map(a => a.filename).join(', '))}">📎${em.attachments.length}</span> ` : ''}${this._srcBtn('emails', em, 'Email', ['Message-ID', 'From', 'Subject'])}${this._flagBtn('emails', em.id)}</span>
                    </div>
                    <div class="gwp-email-subject">${this._escHtml(em.subject || '(no subject)')}</div>
                    <div class="gwp-email-to">To: ${this._escHtml(em.to || '—')}</div>
                    ${em.labels ? `<div class="gwp-email-labels">${String(em.labels).split(',').map(l => `<span class="gwp-tag-sm">${this._escHtml(l.trim())}</span>`).join('')}</div>` : ''}
                    <div class="gwp-email-snippet" style="font-size:12px;color:#94a3b8;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._escHtml((em.snippet || '').replace(/\s+/g, ' ').slice(0, 200))}</div>
                    <div class="gwp-email-detail" id="gwp-email-sdetail-${i}" style="display:none;" onclick="event.stopPropagation()"></div>
                </div>`;
        }).join('');
        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>📧 Email Messages (${fmt(all)})</h3>
                    ${imp.store.emailDuplicates ? `<span class="gwp-section-count">${fmt(imp.store.emailDuplicates)} duplicate copies skipped</span>` : ''}
                </div>
                ${pager}
                ${st.error ? `<div class="gwp-empty-section" style="color:#fca5a5">Could not read e-mails: ${this._escHtml(st.error)}</div>` : ''}
                ${!st.loading && st.total === 0 && !st.error ? `<div class="gwp-empty-section">${st.q ? 'No e-mails match this search.' : 'No e-mails in the store.'}</div>` : ''}
                <div class="gwp-email-list">${rows}</div>
                ${st.rows.length > 10 ? `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin:8px 0;">${nav}</div>` : ''}
                ${legacy.length ? `<div class="gwp-card" style="margin-top:16px">${this._renderEmailInline(legacy, `📧 From an earlier import (${fmt(legacy.length)})`)}</div>` : ''}
            </div>`;
    }

    async toggleStoreEmail(i) {
        const el = document.getElementById(`gwp-email-sdetail-${i}`);
        const st = this._em;
        const row = st && st.rows[i];
        if (!el || !row) return;
        if (el.style.display !== 'none') { el.style.display = 'none'; return; }
        el.style.display = 'block';
        if (el.dataset.loaded === '1') return;
        el.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:8px">Loading message…</div>';
        const em = await this.module.getEmail(row.key, row.seq);
        if (!em) { el.innerHTML = '<div style="color:#fca5a5;font-size:12px;padding:8px">Could not load this message.</div>'; return; }
        el.dataset.loaded = '1';
        const size = em.rawSize ? ` · ${(em.rawSize / 1048576).toFixed(1)} MB` : '';
        el.innerHTML = `
            <div class="gwp-email-headers">
                ${em.cc ? `<div class="gwp-field-sm"><label>CC:</label><span>${this._escHtml(em.cc)}</span></div>` : ''}
                ${em.id ? `<div class="gwp-field-sm"><label>Message-ID:</label><span class="gwp-mono">${this._escHtml(em.id)}</span></div>` : ''}
                ${em.threadId ? `<div class="gwp-field-sm"><label>Thread ID:</label><span class="gwp-mono">${this._escHtml(em.threadId)}</span></div>` : ''}
                ${em.attachments?.length ? `<div class="gwp-field-sm"><label>Attachments:</label><span>${this._escHtml(em.attachments.map(a => `${a.filename || '(unnamed)'}${a.size ? ' (' + Math.round(a.size / 1024) + ' KB)' : ''}`).join(', '))}</span></div>` : ''}
                ${em.truncated ? `<div class="gwp-field-sm" style="color:#fbbf24"><label>Note:</label><span>This message is very large${size}; only the first 64 MB was read. The full message is in the original return.</span></div>` : ''}
            </div>
            <div class="gwp-email-body">
                ${em.htmlBody
                    ? `<iframe class="gwp-email-iframe" srcdoc="${this._escAttr(em.htmlBody)}" sandbox=""></iframe>`
                    : `<pre class="gwp-email-text">${this._escHtml(em.textBody || '(empty)')}</pre>`}
            </div>`;
    }

    // ─── Location Section ───────────────────────────────────────────────

    _renderLocation(imp) {
        const storeMode = this.module.hasStore(imp);
        const records = storeMode ? [] : (imp.locationRecords || []);
        const legacy = storeMode ? (imp.legacyLocationRecords || []) : [];
        const rawTotal = this.module.locationTotal(imp);
        const semantic = imp.semanticLocations || [];

        if (rawTotal === 0 && semantic.length === 0) {
            return '<div class="gwp-empty-section">No location data in this warrant return</div>';
        }

        const visits = semantic.filter(s => s.type === 'placeVisit');
        const segments = semantic.filter(s => s.type === 'activitySegment');

        return `
            <div class="gwp-section-scroll">
                <div class="gwp-section-header">
                    <h3>📍 Location History</h3>
                    <span class="gwp-section-count">${rawTotal.toLocaleString()} raw points, ${visits.length} places, ${segments.length} trips</span>
                </div>

                <!-- Map -->
                <div class="gwp-card">
                    <div id="gwp-location-map" class="gwp-map"></div>
                    <div id="gwp-map-note" class="gwp-more" style="text-align:left;"></div>
                </div>

                <!-- Place Visits -->
                ${visits.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Place Visits (${visits.length})</h4>
                    <div class="gwp-table-wrap">
                        <table class="gwp-table">
                            <thead><tr><th>Name</th><th>Address</th><th>Start</th><th>End</th><th>Confidence</th><th>Flag</th></tr></thead>
                            <tbody>
                                ${visits.map(v => {
                                    const fk = window.WarrantFlagsKey.googleLocationVisit(v);
                                    const flagged = this.module.isFlagged('locationVisits', fk);
                                    return `
                                    <tr class="${flagged ? 'gwp-row-flagged' : ''}">
                                        <td>${this._escape(v.name || '—')}</td>
                                        <td>${this._escape(v.address || '—')}</td>
                                        <td class="gwp-mono gwp-nowrap">${v.startTime || '—'}</td>
                                        <td class="gwp-mono gwp-nowrap">${v.endTime || '—'}</td>
                                        <td>${v.confidence ? v.confidence + '%' : '—'}</td>
                                        <td class="gwp-nowrap">${this._srcBtn('locationVisits', v, 'Place visit', [v.placeId ? 'Place ID' : 'Place name', 'Address', 'Start time'])}${this._flagBtn('locationVisits', fk)}</td>
                                    </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}

                <!-- Raw Records -->
                ${records.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Raw Location Records (${records.length})</h4>
                    ${this._locTableHtml(records.slice(0, 500))}
                    ${records.length > 500 ? `<div class="gwp-more">... ${records.length - 500} more records</div>` : ''}
                </div>
                ` : ''}

                ${storeMode && (imp.store.locationCount || 0) > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Raw Location Records (${(imp.store.locationCount || 0).toLocaleString()})</h4>
                    <div id="gwp-loc-table">${this._renderStoreLocTable(imp)}</div>
                </div>` : ''}

                ${legacy.length > 0 ? `
                <div class="gwp-card">
                    <h4 class="gwp-card-title">Raw Location Records — from an earlier import (${legacy.length.toLocaleString()})</h4>
                    ${this._locTableHtml(legacy.slice(0, 500))}
                    ${legacy.length > 500 ? `<div class="gwp-more">... ${(legacy.length - 500).toLocaleString()} more records</div>` : ''}
                </div>` : ''}
            </div>
        `;
    }

    // ── Large returns: location points paged / sampled from the SQLite store ──

    _locTableHtml(rows) {
        const num = (v) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(6) : '—';
        return `
            <div class="gwp-table-wrap" style="max-height: 400px; overflow-y: auto;">
                <table class="gwp-table">
                    <thead><tr><th>Timestamp</th><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Source</th></tr></thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr>
                                <td class="gwp-mono gwp-nowrap">${this._escape(r.timestamp || '—')}</td>
                                <td class="gwp-mono">${num(r.lat)}</td>
                                <td class="gwp-mono">${num(r.lng)}</td>
                                <td>${this._escape(r.accuracy != null && r.accuracy !== '' ? r.accuracy : '—')}</td>
                                <td>${this._escape(r.source || '—')}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    _locState(imp) {
        const sig = imp.store.keys.join('|');
        if (!this._loc || this._loc.impId !== imp.id || this._loc.keysSig !== sig) {
            this._loc = { impId: imp.id, keysSig: sig, offset: 0, limit: 500, total: null, rows: [], loading: false, error: null, stale: true };
        }
        return this._loc;
    }

    _renderStoreLocTable(imp) {
        const st = this._locState(imp);
        if (st.stale && !st.loading) setTimeout(() => this._loadLocations(), 0);
        if (st.error) return `<div class="gwp-empty-section">Could not read location records: ${this._escape(st.error)}</div>`;
        if (st.total == null) return '<div class="gwp-more">Loading location records…</div>';
        const a = st.total ? st.offset + 1 : 0;
        const b = Math.min(st.offset + st.rows.length, st.total);
        const nav = `
            <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
                <button class="gwp-btn gwp-btn-sm" onclick="window.googleWarrantUI.locPage(-1)" ${st.offset <= 0 || st.loading ? 'disabled' : ''}>◀ Prev</button>
                <span class="gwp-section-count">${a.toLocaleString()}–${b.toLocaleString()} of ${st.total.toLocaleString()}${st.loading ? ' (loading…)' : ''}</span>
                <button class="gwp-btn gwp-btn-sm" onclick="window.googleWarrantUI.locPage(1)" ${st.offset + st.limit >= st.total || st.loading ? 'disabled' : ''}>Next ▶</button>
            </div>`;
        return nav + this._locTableHtml(st.rows);
    }

    async _loadLocations() {
        const imp = this.currentImport;
        if (!imp || !this.module.hasStore(imp)) return;
        const st = this._locState(imp);
        if (st.loading) return;
        st.loading = true; st.stale = false; st.error = null;
        const want = st.offset;
        try {
            const res = await this.module.locationsPage(imp, { offset: st.offset, limit: st.limit });
            if (this._loc !== st) return;
            if (res && res.success) { st.rows = res.rows || []; st.total = res.total || 0; }
            else { st.rows = []; st.total = 0; st.error = (res && res.error) || 'Could not read location records'; }
        } catch (e) {
            if (this._loc === st) { st.rows = []; st.total = 0; st.error = e.message || String(e); }
        } finally {
            st.loading = false;
        }
        if (st.offset !== want) { st.stale = true; return this._loadLocations(); }
        this._refreshLocTable(imp);
    }

    _refreshLocTable(imp) {
        if (this.activeSection !== 'location' || this.currentImport !== imp) return;
        const el = document.getElementById('gwp-loc-table');
        if (el) el.innerHTML = this._renderStoreLocTable(imp);
    }

    locPage(delta) {
        const st = this._loc; if (!st || st.total == null) return;
        const next = st.offset + delta * st.limit;
        if (next < 0 || next >= st.total) return;
        st.offset = next; st.stale = true;
        this._refreshLocTable(this.currentImport);
    }

    /** Map points for a store-backed import: an evenly spaced sample (≤ 20,000). */
    _mapSample(imp) {
        const sig = imp.store.keys.join('|');
        const s = this._locSample;
        if (s && s.impId === imp.id && s.keysSig === sig) return s;
        const fresh = { impId: imp.id, keysSig: sig, rows: null, total: 0, sampled: false, error: null };
        this._locSample = fresh;
        this.module.locationsPage(imp, { sample: 20000 }).then((res) => {
            if (this._locSample !== fresh) return;
            if (res && res.success) { fresh.rows = res.rows || []; fresh.total = res.total || 0; fresh.sampled = (res.step || 1) > 1; }
            else { fresh.rows = []; fresh.error = (res && res.error) || 'Could not read location points'; }
        }).catch((e) => {
            if (this._locSample === fresh) { fresh.rows = []; fresh.error = e.message || String(e); }
        }).then(() => {
            if (this._locSample === fresh && this.activeSection === 'location' && this.currentImport === imp) this.initLocationMap(imp);
        });
        return fresh;
    }

    initLocationMap(imp) {
        const semantic = imp?.semanticLocations || [];
        const mapEl = document.getElementById('gwp-location-map');
        if (!mapEl || typeof L === 'undefined') return;
        const noteEl = document.getElementById('gwp-map-note');
        const note = (t) => { if (noteEl) noteEl.textContent = t; };

        let records = imp?.locationRecords || [];
        if (this.module.hasStore(imp)) {
            const s = this._mapSample(imp);
            if (s.rows === null) { note('Loading map points…'); return; }
            records = s.rows.concat(imp.legacyLocationRecords || []);
            if (s.error) note('Map points could not be read: ' + s.error);
            else if (s.sampled) note(`Map shows ${s.rows.length.toLocaleString()} evenly spaced points out of ${s.total.toLocaleString()}. Every point is listed in the table below.`);
            else note('');
        }

        const points = records.filter(r => r.lat && r.lng).map(r => [r.lat, r.lng]);
        const visits = semantic.filter(s => s.type === 'placeVisit' && s.lat && s.lng);

        if (this._leafletMap) { try { this._leafletMap.remove(); } catch (_) {} this._leafletMap = null; }
        if (points.length === 0 && visits.length === 0) {
            mapEl.innerHTML = '<div class="gwp-empty-section">No coordinates to display</div>';
            return;
        }
        if (mapEl._leaflet_id) return; // already drawn into this element

        const map = L.map('gwp-location-map', { preferCanvas: true }).setView([0, 0], 2);
        this._leafletMap = map;
        // CARTO watermarks keyless tiles with "API KEY REQUIRED"; the key lives
        // in modules/_shared/basemap.js. Keyless fallback = degraded, not broken.
        const tileUrl = (window.VIPER_BASEMAP && window.VIPER_BASEMAP.dark) ||
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
        L.tileLayer(tileUrl, {
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
            L.marker([v.lat, v.lng]).addTo(map).bindPopup(`<b>${this._escape(v.name || 'Unknown')}</b><br>${this._escape(v.address || '')}<br>${this._escape(v.startTime || '')}`);
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
                        ${messages.map((msg, idx) => {
                            const flagged = this.module.isFlagged('chatMessages', String(idx));
                            if (msg.type === 'html') {
                                return `<div class="gwp-chat-html ${flagged ? 'gwp-flagged' : ''}" style="display:flex;align-items:flex-start;gap:8px"><div style="flex:1">${msg.content}</div>${this._flagBtn('chatMessages', String(idx))}</div>`;
                            }
                            return `<div class="${flagged ? 'gwp-flagged' : ''}" style="display:flex;align-items:flex-start;gap:8px"><pre class="gwp-pre" style="flex:1">${this._escHtml(JSON.stringify(msg, null, 2))}</pre>${this._flagBtn('chatMessages', String(idx))}</div>`;
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
                        ${devices.map(d => {
                            const flagged = this.module.isFlagged('devices', d.androidId || '');
                            return `
                            <div class="gwp-device-card ${flagged ? 'gwp-flagged' : ''}">
                                <div class="gwp-device-icon">📱</div>
                                <div class="gwp-device-info">
                                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
                                        <div class="gwp-device-model">${d.manufacturer || ''} ${d.model || 'Unknown Device'}</div>
                                        <span style="white-space:nowrap">${this._srcBtn('devices', d, 'Android ID', ['Android ID', 'Model'])}${this._flagBtn('devices', d.androidId || '')}</span>
                                    </div>
                                    <div class="gwp-device-detail">${d.brand || ''} • ${d.carrier || 'No carrier'}</div>
                                    <div class="gwp-device-detail">Android SDK ${d.sdkVersion || '?'} • ${d.locale || ''}</div>
                                    <div class="gwp-device-detail gwp-mono" title="Android ID">${d.androidId || ''}</div>
                                    <div class="gwp-field-sm"><label>Registered</label><span>${d.registrationTime ? new Date(d.registrationTime).toLocaleString() : '—'}</span></div>
                                    <div class="gwp-field-sm"><label>Last Active</label><span>${d.lastActive ? new Date(d.lastActive).toLocaleString() : '—'}</span></div>
                                    ${d.buildFingerprint ? `<div class="gwp-device-fp gwp-mono">${d.buildFingerprint}</div>` : ''}
                                </div>
                            </div>
                        `;}).join('')}
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
                            <thead><tr>${Object.keys(pay.transactions[0]).map(k => `<th>${k}</th>`).join('')}<th>Flag</th></tr></thead>
                            <tbody>
                                ${pay.transactions.map(t => {
                                    const fk = window.WarrantFlagsKey.googlePayment(t);
                                    const flagged = this.module.isFlagged('payments', fk);
                                    return `
                                    <tr class="${flagged ? 'gwp-row-flagged' : ''}">
                                        ${Object.values(t).map(v => `<td>${this._escHtml(String(v))}</td>`).join('')}
                                        <td class="gwp-nowrap">${this._srcBtn('payments', t, 'Transaction')}${this._flagBtn('payments', fk)}</td>
                                    </tr>`;
                                }).join('')}
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

        // Drive files are written to the case folder (relPath) and loaded on
        // demand. Records from older VIPER versions still carry base64 `data`.
        const esc = (s) => this._escape(s == null ? '' : s);
        const missing = (f) => !f.relPath && !f.data;
        const missingNote = '<span class="gwp-tag" title="This file could not be saved to the case folder during import">not saved</span>';
        const fileBtns = (f, cat, i) => f.relPath ? `
                                ${GoogleWarrantUI.OPENABLE_RE.test(f.name || f.relPath) ? `<button class="gwp-btn-sm" onclick="window.googleWarrantUI.openDriveFile('${cat}', ${i}, false)">Open</button>` : ''}
                                <button class="gwp-btn-sm gwp-btn-outline" onclick="window.googleWarrantUI.openDriveFile('${cat}', ${i}, true)">Show in folder</button>`
            : f.data ? (cat === 'pdf'
                ? `<button class="gwp-btn-sm" onclick="gwpViewPdf(${i})">View</button>
                   <button class="gwp-btn-sm gwp-btn-outline" onclick="gwpDownloadFile('', '', ${i}, 'pdf')">Download</button>`
                : `<button class="gwp-btn-sm gwp-btn-outline" onclick="gwpDownloadFile('', '', ${i}, 'other')">Download</button>`)
            : missingNote;

        // ── Photo Gallery ──
        if (images.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">🖼️ Photos (${images.length})</h4>
                <div class="gwp-gallery" id="gwp-drive-gallery">
                    ${images.map((f, i) => `
                        <div class="gwp-gallery-item" onclick="window.googleWarrantUI.openDriveImage(${i})">
                            ${f.relPath
                                ? `<div class="gwp-photo-thumb" data-rel="${(f.size || 0) <= 25 * 1048576 ? esc(f.relPath) : ''}" data-video="0"><div class="gwp-photo-loading">${(f.size || 0) <= 25 * 1048576 ? '…' : '🖼️'}</div></div>`
                                : f.data
                                    ? `<img src="data:${esc(f.mimeType)};base64,${f.data}" alt="${this._escAttr(f.name)}" loading="lazy">`
                                    : `<div class="gwp-photo-thumb"><div class="gwp-photo-loading">⚠</div></div>`}
                            <div class="gwp-gallery-label">${this._escHtml(f.name)}<br><span>${formatSize(f.size)}</span>${missing(f) ? ' ' + missingNote : ''}</div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
            setTimeout(() => this._hydratePhotoThumbs(null, '#gwp-drive-gallery .gwp-photo-thumb'), 50);
        }

        // ── Videos ──
        if (videos.length > 0) {
            html += `
            <div class="gwp-card">
                <h4 class="gwp-card-title">🎬 Videos (${videos.length})</h4>
                <div class="gwp-media-list">
                    ${videos.map((f, i) => `
                        <div class="gwp-media-item">
                            ${f.relPath
                                ? `<button class="gwp-btn-sm" onclick="window.googleWarrantUI.openDriveVideo(${i})">▶ Play</button>
                                   <button class="gwp-btn-sm gwp-btn-outline" onclick="window.googleWarrantUI.openDriveFile('video', ${i}, true)">Show in folder</button>`
                                : f.data
                                    ? `<video controls preload="metadata" class="gwp-video-player"><source src="data:${esc(f.mimeType)};base64,${f.data}" type="${esc(f.mimeType)}"></video>`
                                    : missingNote}
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
                            <div class="gwp-file-actions">${fileBtns(f, 'pdf', i)}</div>
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
                    ${audio.map((f, i) => `
                        <div class="gwp-media-item gwp-audio-item">
                            <span class="gwp-file-name">${this._escHtml(f.name)} <span class="gwp-mono">(${formatSize(f.size)})</span></span>
                            ${f.relPath
                                ? `<span id="gwp-drive-audio-${i}"><button class="gwp-btn-sm" onclick="window.googleWarrantUI.playDriveAudio(${i})">▶ Play</button></span>
                                   <button class="gwp-btn-sm gwp-btn-outline" onclick="window.googleWarrantUI.openDriveFile('audio', ${i}, true)">Show in folder</button>`
                                : f.data
                                    ? `<audio controls preload="metadata"><source src="data:${esc(f.mimeType)};base64,${f.data}" type="${esc(f.mimeType)}"></audio>`
                                    : missingNote}
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
                                <span class="gwp-tag">${esc(f.mimeType?.split('/').pop() || '?')}</span>
                                <span class="gwp-mono gwp-file-size">${formatSize(f.size)}</span>
                            </div>
                            <div class="gwp-file-actions">${fileBtns(f, 'other', i)}</div>
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

    // ─── Activity (MyActivity + Aggregated) ────────────────────────────

    _renderActivity(imp) {
        const myAct = imp.myActivity || [];
        const agg = imp.aggregatedActivity || [];
        if (!myAct.length && !agg.length) return '<div class="gwp-empty-section">No activity records.</div>';

        let html = '';
        if (myAct.length) {
            html += `<div class="gwp-section-header"><h2>My Activity</h2><span class="gwp-count-badge">${myAct.length.toLocaleString()}</span></div>`;
            html += this._renderRowsTable(myAct.slice(0, 500));
            if (myAct.length > 500) html += `<div class="gwp-note">Showing first 500 of ${myAct.length.toLocaleString()} records.</div>`;
        }
        if (agg.length) {
            html += `<div class="gwp-section-header"><h2>Aggregated Activities</h2><span class="gwp-count-badge">${agg.length.toLocaleString()}</span></div>`;
            html += this._renderRowsTable(agg.slice(0, 500));
            if (agg.length > 500) html += `<div class="gwp-note">Showing first 500 of ${agg.length.toLocaleString()} records.</div>`;
        }
        return html;
    }

    // ─── Contacts ──────────────────────────────────────────────────────

    _renderContacts(imp) {
        const rows = imp.contacts || [];
        if (!rows.length) return '<div class="gwp-empty-section">No contacts.</div>';
        return `<div class="gwp-section-header"><h2>Contacts</h2><span class="gwp-count-badge">${rows.length.toLocaleString()}</span></div>${this._renderRowsTable(rows.slice(0, 1000))}${rows.length > 1000 ? `<div class="gwp-note">Showing first 1000 of ${rows.length.toLocaleString()}.</div>` : ''}`;
    }

    // ─── Calendar ──────────────────────────────────────────────────────

    _renderCalendar(imp) {
        const rows = imp.calendars || [];
        const settings = imp.calendarSettings;
        if (!rows.length && !settings) return '<div class="gwp-empty-section">No calendar data.</div>';
        let html = '';
        if (rows.length) {
            html += `<div class="gwp-section-header"><h2>Calendar Events</h2><span class="gwp-count-badge">${rows.length.toLocaleString()}</span></div>`;
            // Separate raw .ics files from structured rows
            const ics = rows.filter(r => r._ics);
            const structured = rows.filter(r => !r._ics);
            if (structured.length) html += this._renderRowsTable(structured.slice(0, 500));
            if (ics.length) {
                html += `<div class="gwp-section-subheader">iCalendar Files (${ics.length})</div>`;
                for (const f of ics) {
                    html += `<div class="gwp-raw-file"><div class="gwp-raw-name">${this._escape(f.name)}</div><pre class="gwp-raw-content">${this._escape((f.content || '').slice(0, 20000))}</pre></div>`;
                }
            }
        }
        if (settings) {
            html += `<div class="gwp-section-header"><h2>Calendar Settings</h2></div>`;
            html += this._renderRawBucket(settings);
        }
        return html;
    }

    // ─── Tasks ─────────────────────────────────────────────────────────

    _renderTasks(imp) {
        const rows = imp.tasks || [];
        if (!rows.length) return '<div class="gwp-empty-section">No tasks.</div>';
        return `<div class="gwp-section-header"><h2>Tasks</h2><span class="gwp-count-badge">${rows.length.toLocaleString()}</span></div>${this._renderRowsTable(rows.slice(0, 1000))}`;
    }

    // ─── Meet History ──────────────────────────────────────────────────

    _renderMeet(imp) {
        const rows = imp.meetHistory || [];
        if (!rows.length) return '<div class="gwp-empty-section">No meeting history.</div>';
        return `<div class="gwp-section-header"><h2>Google Meet History</h2><span class="gwp-count-badge">${rows.length.toLocaleString()}</span></div>${this._renderRowsTable(rows.slice(0, 1000))}`;
    }

    // ─── Linked Accounts ───────────────────────────────────────────────

    _renderLinked(imp) {
        const rows = imp.linkedByPhone || [];
        if (!rows.length) return '<div class="gwp-empty-section">No linked-account data.</div>';
        return `<div class="gwp-section-header"><h2>Accounts Linked by Phone / Cookies</h2><span class="gwp-count-badge">${rows.length.toLocaleString()}</span></div>${this._renderRowsTable(rows.slice(0, 1000))}`;
    }

    // ─── Photos & Media (GooglePhotos.PhotoResourceLegal etc.) ─────────

    _renderPhotos(imp) {
        const all = imp.photos || [];
        // Split media vs companion metadata so the gallery doesn't show JSON tiles
        const media = all.filter(p => p && p.isMedia && !p.stub);
        const stubs = all.filter(p => p && p.stub);  // imported without mediaRoot
        const metaFiles = all.filter(p => p && !p.isMedia && !p.stub);

        if (!media.length && !stubs.length && !metaFiles.length) {
            return '<div class="gwp-empty-section">No photos or media files in this warrant return.</div>';
        }

        // Bundle breakdown — show user that data came from N master parts
        const bundleBreakdown = {};
        for (const p of media) {
            const b = p.bundle || 'unknown';
            bundleBreakdown[b] = (bundleBreakdown[b] || 0) + 1;
        }
        const bundleList = Object.entries(bundleBreakdown).map(([b, n]) => `${this._escape(b)} (${n})`).join(' · ');

        // Group by category for filter chips
        const byCategory = {};
        for (const p of media) {
            const c = p.category || 'GooglePhotos.PhotoResourceLegal';
            (byCategory[c] = byCategory[c] || []).push(p);
        }
        const categories = Object.keys(byCategory).sort();

        const totalBytes = media.reduce((s, p) => s + (p.size || 0), 0);
        const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);

        let html = `<div class="gwp-section-header">
            <h2>Photos & Media</h2>
            <span class="gwp-count-badge">${media.length}</span>
        </div>`;

        html += `<div class="gwp-photos-summary">
            <div><strong>${media.length}</strong> media file${media.length === 1 ? '' : 's'} · <strong>${totalMB}</strong> MB total</div>`;
        if (bundleList) html += `<div class="gwp-photos-meta">From: ${bundleList}</div>`;
        if (metaFiles.length) html += `<div class="gwp-photos-meta">+${metaFiles.length} companion metadata file${metaFiles.length === 1 ? '' : 's'} (JSON / HTML)</div>`;
        if (stubs.length) {
            html += `<div class="gwp-photos-meta" style="color:#fbbf24">⚠️ ${stubs.length} file(s) detected but not extracted — re-import with a case loaded so VIPER can write media to disk.</div>`;
        }
        html += `</div>`;

        if (categories.length > 1) {
            html += `<div class="gwp-photos-filters">
                <button class="gwp-photos-filter active" data-filter="all">All (${media.length})</button>`;
            for (const c of categories) {
                html += `<button class="gwp-photos-filter" data-filter="${this._escape(c)}">${this._escape(c)} (${byCategory[c].length})</button>`;
            }
            html += `</div>`;
        }

        html += `<div class="gwp-photos-grid" id="gwp-photos-grid">`;
        for (let i = 0; i < media.length; i++) {
            const p = media[i];
            const isVideo = p.mimeType && p.mimeType.startsWith('video/');
            const taken = p.takenAt ? new Date(p.takenAt).toLocaleString() : '';
            html += `<div class="gwp-photo-tile" data-category="${this._escape(p.category || '')}" data-idx="${i}" data-rel="${this._escape(p.relPath || '')}" onclick="window.googleWarrantUI.openPhotoLightbox(${i})">
                <div class="gwp-photo-thumb" data-rel="${this._escape(p.relPath || '')}" data-video="${isVideo ? '1' : '0'}">
                    ${isVideo ? '<div class="gwp-photo-video-badge">▶</div>' : ''}
                    <div class="gwp-photo-loading">${isVideo ? '🎬' : '…'}</div>
                </div>
                <div class="gwp-photo-caption">
                    <div class="gwp-photo-name" title="${this._escape(p.filename)}">${this._escape(p.filename)}</div>
                    <div class="gwp-photo-meta">${(p.size/1024).toFixed(0)} KB${taken ? ' · ' + this._escape(taken) : ''}</div>
                </div>
            </div>`;
        }
        html += `</div>`;

        // Hydrate thumbs after render — defer so the DOM is in place
        setTimeout(() => this._hydratePhotoThumbs(media), 50);
        // Wire filter chips
        setTimeout(() => this._wirePhotoFilters(), 60);

        // Stash photo array on the UI instance so the lightbox can resolve by idx
        this._currentPhotos = media;

        return html;
    }

    /**
     * Lazy-load thumbnails — fetches base64 from main, swaps into <img>.
     * Uses IntersectionObserver so off-screen tiles don't get hammered.
     */
    _hydratePhotoThumbs(media, selector) {
        const tiles = document.querySelectorAll(selector || '#gwp-photos-grid .gwp-photo-thumb');
        if (!tiles.length || !this.module) return;
        const mod = this.module;

        // Video tiles: the bytes can't go in an <img>. Decode a frame instead
        // (shared VpVideoThumbs, streamed viper-media:// URL).
        const vt = window.VpVideoThumbs;
        const vidRoots = new Set();
        tiles.forEach(t => {
            if (t.getAttribute('data-video') !== '1') return;
            t.dataset.loaded = '1';
            const rel = t.getAttribute('data-rel');
            if (rel && vt) { t.setAttribute('data-vpt-src', rel); if (t.parentNode) vidRoots.add(t.parentNode.parentNode || t.parentNode); }
        });
        if (vt) {
            const apply = (tile, dataUrl) => {
                tile.querySelector('.gwp-photo-loading')?.remove();
                let img = tile.querySelector('img');
                if (!img) { img = document.createElement('img'); img.alt = ''; tile.appendChild(img); }
                img.src = dataUrl;
            };
            vidRoots.forEach(r => vt.hydrate(r, { getUrl: (rel) => mod.getMediaUrl(rel), apply }));
        }

        const load = async (tile) => {
            const rel = tile.getAttribute('data-rel');
            if (!rel || tile.dataset.loaded === '1') return;
            tile.dataset.loaded = '1';
            try {
                const url = await mod.readMedia(rel);
                if (url) {
                    const img = document.createElement('img');
                    img.src = url;
                    img.loading = 'lazy';
                    img.alt = '';
                    tile.querySelector('.gwp-photo-loading')?.remove();
                    tile.appendChild(img);
                } else {
                    const loading = tile.querySelector('.gwp-photo-loading');
                    if (loading) loading.textContent = '⚠';
                }
            } catch (_) {
                const loading = tile.querySelector('.gwp-photo-loading');
                if (loading) loading.textContent = '⚠';
            }
        };

        if ('IntersectionObserver' in window) {
            const io = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) { load(e.target); io.unobserve(e.target); }
                }
            }, { rootMargin: '300px' });
            tiles.forEach(t => io.observe(t));
        } else {
            tiles.forEach(load);
        }
    }

    _wirePhotoFilters() {
        const btns = document.querySelectorAll('.gwp-photos-filter');
        btns.forEach(b => b.addEventListener('click', () => {
            btns.forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            const want = b.getAttribute('data-filter');
            document.querySelectorAll('.gwp-photo-tile').forEach(tile => {
                const cat = tile.getAttribute('data-category');
                tile.style.display = (want === 'all' || cat === want) ? '' : 'none';
            });
        }));
    }

    /**
     * Lightbox — full-res photo or video playback via viper-media:// URL.
     */
    async openPhotoLightbox(idx) {
        const list = this._currentPhotos || [];
        const p = list[idx];
        if (!p) return;
        const isVideo = p.mimeType && p.mimeType.startsWith('video/');

        // Build overlay
        let overlay = document.getElementById('gwp-photo-lightbox');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'gwp-photo-lightbox';
        overlay.className = 'gwp-lightbox';
        overlay.innerHTML = `
            <button class="gwp-lightbox-close" title="Close (Esc)">×</button>
            <button class="gwp-lightbox-prev" title="Previous (←)">‹</button>
            <button class="gwp-lightbox-next" title="Next (→)">›</button>
            <div class="gwp-lightbox-stage"><div class="gwp-lightbox-loading">Loading…</div></div>
            <div class="gwp-lightbox-caption">
                <div class="gwp-lightbox-name">${this._escape(p.filename)}</div>
                <div class="gwp-lightbox-meta">${(p.size/1024/1024).toFixed(2)} MB${p.takenAt ? ' · ' + this._escape(new Date(p.takenAt).toLocaleString()) : ''}${p.bundle ? ' · ' + this._escape(p.bundle) : ''}</div>
            </div>
        `;
        document.body.appendChild(overlay);

        const stage = overlay.querySelector('.gwp-lightbox-stage');
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const goto = (delta) => this.openPhotoLightbox((idx + delta + list.length) % list.length);
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowLeft') goto(-1);
            else if (e.key === 'ArrowRight') goto(1);
        };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('.gwp-lightbox-close').onclick = close;
        overlay.querySelector('.gwp-lightbox-prev').onclick = () => goto(-1);
        overlay.querySelector('.gwp-lightbox-next').onclick = () => goto(1);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        try {
            const url = await this.module.getMediaUrl(p.relPath);
            if (!url) throw new Error('No media URL');
            stage.innerHTML = isVideo
                ? `<video src="${url}" controls autoplay style="max-width:90vw;max-height:80vh"></video>`
                : `<img src="${url}" alt="" style="max-width:90vw;max-height:80vh">`;
        } catch (err) {
            stage.innerHTML = `<div class="gwp-lightbox-error">Failed to load: ${this._escape(err.message || String(err))}</div>`;
        }
    }

    // ─── Drive files (Files section) — opened from the case folder ─────

    _driveLists(imp) {
        const files = ((imp && imp.driveFiles) || []).filter(f => f && f._isFile);
        const isPdf = (f) => f.mimeType === 'application/pdf';
        const kind = (f, p) => !!(f.mimeType && f.mimeType.startsWith(p));
        return {
            image: files.filter(f => kind(f, 'image/')),
            video: files.filter(f => kind(f, 'video/')),
            audio: files.filter(f => kind(f, 'audio/')),
            pdf: files.filter(isPdf),
            other: files.filter(f => !kind(f, 'image/') && !kind(f, 'video/') && !kind(f, 'audio/') && !isPdf(f)),
        };
    }

    _driveAsPhotos(list) {
        return list.map(f => ({ filename: f.name || '', relPath: f.relPath || '', mimeType: f.mimeType || '', size: f.size || 0 }));
    }

    openDriveImage(i) {
        const list = this._driveLists(this.currentImport).image;
        const f = list[i];
        if (!f) return;
        if (!f.relPath) { if (f.data && typeof window.gwpShowLightbox === 'function') window.gwpShowLightbox('', '', i, 'img'); return; }
        this._currentPhotos = this._driveAsPhotos(list);
        this.openPhotoLightbox(i);
    }

    openDriveVideo(i) {
        const list = this._driveLists(this.currentImport).video;
        if (!list[i] || !list[i].relPath) return;
        this._currentPhotos = this._driveAsPhotos(list);
        this.openPhotoLightbox(i);
    }

    async playDriveAudio(i) {
        const f = this._driveLists(this.currentImport).audio[i];
        const slot = document.getElementById(`gwp-drive-audio-${i}`);
        if (!f || !f.relPath || !slot) return;
        slot.textContent = 'Loading…';
        const url = await this.module.getMediaUrl(f.relPath);
        if (!url) { slot.textContent = 'Could not open this file'; return; }
        slot.innerHTML = `<audio controls autoplay src="${this._escape(url)}"></audio>`;
    }

    async openDriveFile(cat, i, reveal) {
        const f = (this._driveLists(this.currentImport)[cat] || [])[i];
        if (!f || !f.relPath) return;
        const res = await this.module.openMedia(f.relPath, !!reveal);
        if (!res || !res.success) this._toast('Could not open file: ' + ((res && res.error) || 'unknown error'), 'error');
    }

    // ─── Other Data (catch-all for unknown categories) ─────────────────

    _renderOther(imp) {
        const sections = imp.rawSections || {};
        const cats = Object.keys(sections).sort();
        if (!cats.length) return '<div class="gwp-empty-section">No additional data.</div>';

        let html = `<div class="gwp-section-header"><h2>Other Data Categories</h2><span class="gwp-count-badge">${cats.length}</span></div>
            <div class="gwp-note">These categories were present in the warrant return but do not have a dedicated viewer yet. Raw content is shown below for review and evidence export.</div>`;

        for (const cat of cats) {
            const bucket = sections[cat];
            const total = (bucket.html?.length || 0) + (bucket.csv?.length || 0) + (bucket.json?.length || 0) + (bucket.other?.length || 0);
            html += `<details class="gwp-raw-cat" open><summary><strong>${this._escape(cat)}</strong> · ${total} file${total === 1 ? '' : 's'}</summary>`;
            html += this._renderRawBucket(bucket);
            html += `</details>`;
        }
        return html;
    }

    // ─── Helpers: generic row table & raw bucket ───────────────────────

    _renderRowsTable(rows) {
        if (!rows || !rows.length) return '<div class="gwp-empty-section">No rows.</div>';
        // Collect union of keys, drop noisy internal ones
        const keys = [];
        const seen = new Set();
        for (const r of rows.slice(0, 200)) {
            if (!r || typeof r !== 'object') continue;
            for (const k of Object.keys(r)) {
                if (k.startsWith('_')) continue;
                if (!seen.has(k)) { seen.add(k); keys.push(k); }
            }
        }
        if (!keys.length) {
            // Rows aren't tabular — dump as JSON
            return `<pre class="gwp-raw-content">${this._escape(JSON.stringify(rows.slice(0, 50), null, 2))}</pre>`;
        }
        let html = '<div class="gwp-table-wrap"><table class="gwp-table"><thead><tr>';
        for (const k of keys) html += `<th>${this._escape(k)}</th>`;
        html += '</tr></thead><tbody>';
        for (const r of rows) {
            html += '<tr>';
            for (const k of keys) {
                let v = r ? r[k] : '';
                if (v == null) v = '';
                if (typeof v === 'object') { try { v = JSON.stringify(v); } catch (_) { v = String(v); } }
                v = String(v);
                if (v.length > 500) v = v.slice(0, 500) + '…';
                html += `<td>${this._escape(v)}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }

    _renderRawBucket(bucket) {
        if (!bucket) return '';
        let html = '';
        if (bucket.html?.length) {
            for (const f of bucket.html) {
                html += `<div class="gwp-raw-file"><div class="gwp-raw-name">📄 ${this._escape(f.name)}</div>`;
                if (f.tables?.length) {
                    html += this._renderRowsTable(f.tables);
                } else if (f.text) {
                    html += `<pre class="gwp-raw-content">${this._escape(f.text)}</pre>`;
                }
                html += `</div>`;
            }
        }
        if (bucket.csv?.length) {
            for (const f of bucket.csv) {
                html += `<div class="gwp-raw-file"><div class="gwp-raw-name">📊 ${this._escape(f.name)}</div>${this._renderRowsTable(f.rows || [])}</div>`;
            }
        }
        if (bucket.json?.length) {
            for (const f of bucket.json) {
                html += `<div class="gwp-raw-file"><div class="gwp-raw-name">{ } ${this._escape(f.name)}</div><pre class="gwp-raw-content">${this._escape(JSON.stringify(f.data, null, 2).slice(0, 50000))}</pre></div>`;
            }
        }
        if (bucket.other?.length) {
            for (const f of bucket.other) {
                html += `<div class="gwp-raw-file"><div class="gwp-raw-name">📎 ${this._escape(f.name)} (${this._escape(f.ext)})</div>${f.text ? `<pre class="gwp-raw-content">${this._escape(f.text.slice(0, 20000))}</pre>` : '<div class="gwp-note">Binary file — not displayed.</div>'}</div>`;
            }
        }
        return html;
    }

    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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

        // Emails (large returns: the inline preview plus any earlier inline import)
        const tlEmails = (imp.emails || []).concat(this.module.hasStore(imp) ? (imp.legacyEmails || []) : []);
        this._tlEmailCount = tlEmails.length;
        tlEmails.forEach(em => {
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
                ${this.module.hasStore(imp) ? `<div class="gwp-more" style="text-align:left;">This is a large return: the timeline includes only ${(this._tlEmailCount || 0).toLocaleString()} of ${this.module.emailTotal(imp).toLocaleString()} e-mails. Use the Email section to search all of them.</div>` : ''}
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
// Types the Files section offers to "Open" — mirrors OPENABLE_EXT in
// google-warrant-store.js (main refuses anything else).
GoogleWarrantUI.OPENABLE_RE = /\.(jpg|jpeg|png|gif|bmp|webp|heic|tif|tiff|mp4|mov|avi|mkv|webm|3gp|m4v|wmv|mp3|wav|m4a|aac|ogg|flac|wma|pdf|txt|csv|rtf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|json|xml|log)$/i;
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

// Records from older VIPER versions carry base64 `data`; newer ones are opened
// from the case folder by GoogleWarrantUI.openDrive*.
function _gwpCurrentImport() {
    return window.googleWarrantUI?.currentImport || window.googleWarrantModule?.imports?.[0] || null;
}
function _gwpEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gwpShowLightbox(mimeType, dataPreview, idx, category) {
    const imp = _gwpCurrentImport();
    if (!imp) return;
    const files = (imp.driveFiles || []).filter(f => f._isFile);
    const images = files.filter(f => f.mimeType?.startsWith('image/'));
    const file = images[idx];
    if (!file || !file.data) return;

    // Remove existing lightbox
    document.getElementById('gwp-lightbox')?.remove();

    const lb = document.createElement('div');
    lb.id = 'gwp-lightbox';
    lb.className = 'gwp-lightbox';
    lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
    lb.innerHTML = `
        <div class="gwp-lightbox-content">
            <button class="gwp-lightbox-close" onclick="document.getElementById('gwp-lightbox').remove()">✕</button>
            <img src="data:${_gwpEsc(file.mimeType)};base64,${file.data}" alt="${_gwpEsc(file.name)}">
            <div class="gwp-lightbox-caption">${_gwpEsc(file.name)}</div>
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
    const imp = _gwpCurrentImport();
    if (!imp) return;
    const pdfs = (imp.driveFiles || []).filter(f => f._isFile && f.mimeType === 'application/pdf');
    const file = pdfs[idx];
    if (!file || !file.data) return;

    const viewer = document.getElementById('gwp-pdf-viewer');
    if (!viewer) return;
    viewer.classList.remove('hidden');
    viewer.innerHTML = `
        <div class="gwp-pdf-header">
            <span>${_gwpEsc(file.name)}</span>
            <button class="gwp-close-btn" onclick="document.getElementById('gwp-pdf-viewer').classList.add('hidden')">✕</button>
        </div>
        <iframe src="data:application/pdf;base64,${file.data}" class="gwp-pdf-iframe"></iframe>
    `;
}
window.gwpViewPdf = gwpViewPdf;

function gwpDownloadFile(name, mimeType, idx, category) {
    const imp = _gwpCurrentImport();
    if (!imp) return;
    let pool;
    if (category === 'pdf') pool = (imp.driveFiles || []).filter(f => f._isFile && f.mimeType === 'application/pdf');
    else pool = (imp.driveFiles || []).filter(f => f._isFile && !f.mimeType?.startsWith('image/') && !f.mimeType?.startsWith('video/') && !f.mimeType?.startsWith('audio/') && f.mimeType !== 'application/pdf');
    const file = pool[idx];
    if (!file || !file.data) return;

    const a = document.createElement('a');
    a.href = `data:${file.mimeType};base64,${file.data}`;
    a.download = file.name;
    a.click();
}
window.gwpDownloadFile = gwpDownloadFile;
