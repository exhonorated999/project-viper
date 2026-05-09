/**
 * Aperture UI Module
 * Full-featured email analysis interface for VIPER
 * Features: evidence auto-scan, email list/detail, notes, IP lookup,
 *           attachment viewer, flagging, report generation
 */

class ApertureUI {
    constructor(containerId, apertureModule) {
        this.container = document.getElementById(containerId);
        this.module = apertureModule;
        this.selectedEmail = null;
        this.searchQuery = '';
        this.currentFilter = 'all';
        this.currentSource = 'all';
        this.showHeaders = false;
        this.notes = [];
        this.ipGeoInfo = null;
        this.lookingUpIp = false;
    }

    /* ═══════════════════════════════════════════════════
       MAIN RENDER
    ═══════════════════════════════════════════════════ */

    render() {
        if (!this.container) return;

        this.container.innerHTML = `
            <!-- Evidence Auto-Scan Bar -->
            <div id="aperture-evidence-bar"></div>

            <div class="aperture-container h-full flex flex-col" style="min-height:0">
                <!-- Header -->
                <div class="aperture-header bg-viper-card p-4 rounded-lg mb-4 flex items-center justify-between flex-shrink-0">
                    <div class="flex items-center space-x-3">
                        <div class="text-2xl font-bold bg-gradient-to-r from-viper-cyan to-viper-green bg-clip-text text-transparent">
                            APERTURE
                        </div>
                        <div class="text-gray-400 text-sm">Investigative Email Parser</div>
                    </div>
                    <div class="flex items-center space-x-2">
                        ${this._renderFlagToolbar()}
                        <button onclick="apertureUI.showReportDialog()"
                                class="px-3 py-2 rounded-lg text-sm bg-viper-card border border-viper-purple/50 text-viper-purple hover:bg-viper-purple/20 transition-colors flex items-center space-x-1"
                                title="Generate Report">
                            <span>📊</span><span>Report</span>
                        </button>
                        <button onclick="apertureUI.showImportDialog()" 
                                class="btn-viper-primary px-4 py-2 rounded-lg text-sm flex items-center space-x-2">
                            <span>📁</span><span>Import</span>
                        </button>
                        <button onclick="apertureUI.refreshAll()" 
                                class="btn-viper-secondary px-3 py-2 rounded-lg text-sm" title="Refresh">
                            🔄
                        </button>
                    </div>
                </div>

                <!-- Stats Bar -->
                <div id="aperture-stats" class="mb-4 flex-shrink-0">${this.renderStats()}</div>

                <!-- Main Content Area -->
                <div class="aperture-main flex-1 flex gap-4 overflow-hidden" style="min-height:0">
                    <!-- Email List Sidebar -->
                    <div class="aperture-sidebar bg-viper-card rounded-lg p-4 flex flex-col" style="width:380px; min-width:320px;">
                        <!-- Search and Filters -->
                        <div class="mb-3 space-y-2 flex-shrink-0">
                            <input type="text" id="aperture-search" placeholder="Search emails..."
                                   class="w-full px-3 py-2 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 focus:border-viper-cyan outline-none text-sm"
                                   oninput="apertureUI.handleSearch(this.value)">
                            <div class="flex gap-2">
                                <select id="aperture-source-filter" 
                                        class="w-1/2 px-2 py-1.5 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 outline-none text-xs appearance-auto"
                                        style="-webkit-appearance:menulist; background-color:#0d1117; color:#fff;"
                                        onchange="apertureUI.handleSourceFilter(this.value)">
                                    <option value="all">All Sources</option>
                                </select>
                                <select id="aperture-filter" 
                                        class="w-1/2 px-2 py-1.5 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 outline-none text-xs appearance-auto"
                                        style="-webkit-appearance:menulist; background-color:#0d1117; color:#fff;"
                                        onchange="apertureUI.handleFilter(this.value)">
                                    <option value="all">All Emails</option>
                                    <option value="flagged">🚩 Flagged</option>
                                    <option value="attachments">📎 With Attachments</option>
                                </select>
                            </div>
                        </div>
                        <!-- Email List -->
                        <div id="aperture-email-list" class="flex-1 overflow-y-auto space-y-1">
                            ${this.renderEmailList()}
                        </div>
                    </div>

                    <!-- Email Detail + Notes Pane -->
                    <div class="aperture-detail flex-1 flex gap-4 overflow-hidden" style="min-width:0">
                        <!-- Detail View -->
                        <div class="flex-1 bg-viper-card rounded-lg overflow-y-auto" style="min-width:0">
                            <div id="aperture-email-detail" class="p-6">
                                ${this.renderEmailDetail()}
                            </div>
                        </div>
                        <!-- Notes Sidebar (visible when email selected) -->
                        <div id="aperture-notes-panel" class="bg-viper-card rounded-lg flex flex-col overflow-hidden ${this.selectedEmail ? '' : 'hidden'}" style="width:280px; min-width:240px;">
                            <div id="aperture-notes-content">${this.renderNotesPanel()}</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Import Dialog -->
            <div id="aperture-import-dialog" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center z-50" onclick="if(event.target===this)apertureUI.hideImportDialog()">
                <div class="bg-viper-card rounded-xl p-6 max-w-md w-full mx-4 border border-viper-cyan/30">
                    <h3 class="text-xl font-bold mb-4 text-viper-cyan">Import Email Data</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-gray-400 mb-1">Source Name</label>
                            <input type="text" id="aperture-import-source" placeholder="e.g., Suspect Gmail, Warrant Return"
                                   class="w-full px-3 py-2 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 focus:border-viper-cyan outline-none">
                        </div>
                        <div>
                            <label class="block text-sm text-gray-400 mb-1">Select File</label>
                            <input type="file" id="aperture-import-file" accept=".mbox,.eml,.emlx,.msg"
                                   class="w-full px-3 py-2 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 text-sm">
                            <p class="text-xs text-gray-500 mt-1">Supports: .mbox, .eml, .emlx, .msg</p>
                        </div>
                        <div class="flex justify-end space-x-2 pt-2">
                            <button onclick="apertureUI.hideImportDialog()" class="btn-viper-secondary px-4 py-2 rounded-lg text-sm">Cancel</button>
                            <button onclick="apertureUI.handleImport()" class="btn-viper-primary px-4 py-2 rounded-lg text-sm">Import</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Report Dialog -->
            <div id="aperture-report-dialog" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center z-50" onclick="if(event.target===this)this.classList.add('hidden')">
                <div class="bg-viper-card rounded-xl p-6 max-w-sm w-full mx-4 border border-viper-purple/30">
                    <h3 class="text-xl font-bold mb-4 text-viper-purple">📊 Generate Report</h3>
                    <div class="space-y-4">
                        <label class="flex items-center space-x-3 cursor-pointer">
                            <input type="checkbox" id="aperture-report-flagged" checked class="w-4 h-4 accent-viper-purple">
                            <span class="text-gray-300">Flagged emails only</span>
                        </label>
                        <p class="text-xs text-gray-500">Report includes email headers, body content, IP analysis, and investigator notes.</p>
                        <div class="flex justify-end space-x-2 pt-2">
                            <button onclick="document.getElementById('aperture-report-dialog').classList.add('hidden')" class="btn-viper-secondary px-4 py-2 rounded-lg text-sm">Cancel</button>
                            <button onclick="apertureUI.handleGenerateReport()" class="px-4 py-2 rounded-lg text-sm bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold hover:shadow-lg transition-all">Generate</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Attachment Viewer Modal -->
            <div id="aperture-attachment-modal" class="hidden fixed inset-0 bg-black/80 flex items-center justify-center z-50" onclick="if(event.target===this)this.classList.add('hidden')">
                <div class="bg-viper-card rounded-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col border border-viper-purple/30">
                    <div class="flex items-center justify-between p-4 border-b border-viper-cyan/20 flex-shrink-0">
                        <h3 id="attachment-viewer-title" class="text-lg font-bold text-viper-purple">Attachment</h3>
                        <div class="flex items-center space-x-2">
                            <button id="attachment-open-external" onclick="apertureUI.openAttachmentExternal()" class="px-3 py-1 text-sm bg-viper-cyan/20 text-viper-cyan border border-viper-cyan/30 rounded hover:bg-viper-cyan/30 transition-colors">Open Externally</button>
                            <button onclick="document.getElementById('aperture-attachment-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl px-2">✕</button>
                        </div>
                    </div>
                    <div id="attachment-viewer-content" class="flex-1 overflow-auto p-4"></div>
                </div>
            </div>
        `;

        this.updateSourceFilter();
    }

    /* ═══════════════════════════════════════════════════
       EVIDENCE AUTO-SCAN BAR
    ═══════════════════════════════════════════════════ */

    renderEvidenceBar(files) {
        const bar = document.getElementById('aperture-evidence-bar');
        if (!bar) return;

        const unimported = files.filter(f => !f.alreadyImported);

        if (unimported.length === 0) {
            bar.innerHTML = '';
            return;
        }

        bar.innerHTML = `
            <div class="bg-gradient-to-r from-viper-cyan/10 to-viper-green/10 border border-viper-cyan/30 rounded-lg p-3 mb-4">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center space-x-2">
                        <span class="text-viper-cyan text-lg">📬</span>
                        <span class="text-viper-cyan font-semibold text-sm">Email files detected in evidence</span>
                        <span class="text-xs text-gray-400">(${unimported.length} file${unimported.length !== 1 ? 's' : ''})</span>
                    </div>
                    <button onclick="apertureUI.importAllEvidence()" class="btn-viper-primary px-3 py-1 rounded text-xs">Import All</button>
                </div>
                <div class="flex flex-wrap gap-2">
                    ${unimported.map((f, i) => `
                        <div class="flex items-center space-x-2 bg-viper-dark/60 rounded px-3 py-1.5 border border-viper-cyan/20">
                            <span class="text-xs font-mono text-gray-300 truncate" style="max-width:200px" title="${this.esc(f.path)}">${this.esc(f.name)}</span>
                            <span class="text-xs text-gray-500">${this.formatBytes(f.size)}</span>
                            <button onclick="apertureUI.importEvidenceFile(${i})" class="text-viper-green hover:text-white text-xs font-semibold">Import</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    async importEvidenceFile(index) {
        const files = this.module.evidenceFiles.filter(f => !f.alreadyImported);
        const file = files[index];
        if (!file) return;

        try {
            await this.module.importFile(file.path, file.name, file.name.replace(/\.[^.]+$/, ''));
            this.refreshAll();
        } catch (error) {
            alert('Import failed: ' + error.message);
        }
    }

    async importAllEvidence() {
        const files = this.module.evidenceFiles.filter(f => !f.alreadyImported);
        let imported = 0;
        for (const file of files) {
            try {
                await this.module.importFile(file.path, file.name, file.name.replace(/\.[^.]+$/, ''));
                imported++;
            } catch (e) {
                console.error('Failed to import', file.name, e);
            }
        }
        this.refreshAll();
        if (typeof showNotification === 'function') {
            showNotification(`Imported ${imported} of ${files.length} file(s)`, 'success');
        }
    }

    /* ═══════════════════════════════════════════════════
       STATS
    ═══════════════════════════════════════════════════ */

    renderStats() {
        const stats = this.module.getStatistics();
        return `
            <div class="grid grid-cols-4 gap-3">
                <div class="bg-viper-card p-3 rounded-lg border border-viper-cyan/10 hover:border-viper-cyan/30 transition-colors">
                    <div class="text-gray-400 text-xs mb-1">Total Emails</div>
                    <div class="text-2xl font-bold text-viper-cyan">${stats.totalEmails}</div>
                </div>
                <div class="bg-viper-card p-3 rounded-lg border border-viper-green/10 hover:border-viper-green/30 transition-colors">
                    <div class="text-gray-400 text-xs mb-1">Sources</div>
                    <div class="text-2xl font-bold text-viper-green">${stats.sourceCount}</div>
                </div>
                <div class="bg-viper-card p-3 rounded-lg border border-viper-orange/10 hover:border-viper-orange/30 transition-colors">
                    <div class="text-gray-400 text-xs mb-1">Flagged</div>
                    <div class="text-2xl font-bold text-viper-orange">${stats.flaggedEmails}</div>
                </div>
                <div class="bg-viper-card p-3 rounded-lg border border-viper-purple/10 hover:border-viper-purple/30 transition-colors">
                    <div class="text-gray-400 text-xs mb-1">Attachments</div>
                    <div class="text-2xl font-bold text-viper-purple">${stats.emailsWithAttachments}</div>
                </div>
            </div>
        `;
    }

    /* ═══════════════════════════════════════════════════
       EMAIL LIST
    ═══════════════════════════════════════════════════ */

    renderEmailList() {
        let emails = this.module.getFilteredEmails(this.searchQuery, this.currentFilter, this.currentSource);

        if (emails.length === 0) {
            return `
                <div class="text-center text-gray-400 py-10">
                    <div class="text-5xl mb-3">📭</div>
                    <div class="font-medium">No emails to display</div>
                    <div class="text-sm mt-1 text-gray-500">Import an .mbox or .eml file to get started</div>
                </div>
            `;
        }

        emails.sort((a, b) => new Date(b.date) - new Date(a.date));

        return emails.map(email => {
            const isSelected = this.selectedEmail && this.selectedEmail.id === email.id;
            const hasAttachments = email.attachments && email.attachments.length > 0;
            const date = new Date(email.date);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isWarrantFlagged = this.module.isFlagged('emails', email.id);

            return `
                <div class="email-item ${isSelected ? 'bg-viper-cyan/10 border-l-2 border-l-viper-cyan' : 'border-l-2 border-l-transparent hover:border-l-viper-cyan/30 hover:bg-viper-dark/50'} 
                            ${isWarrantFlagged ? 'awp-row-flagged' : ''}
                            rounded-r-lg p-2.5 cursor-pointer transition-all"
                     onclick="apertureUI.selectEmail('${email.id}')">
                    <div class="flex items-start justify-between gap-1">
                        <h4 class="text-sm font-medium ${isSelected ? 'text-white' : 'text-gray-300'} truncate flex-1">${this.esc(email.subject)}</h4>
                        <div class="flex items-center space-x-1 flex-shrink-0">
                            ${this._flagBtn('emails', email.id)}
                            ${email.flagged ? '<span class="text-sm">🚩</span>' : ''}
                            ${hasAttachments ? '<span class="text-xs text-viper-purple">📎</span>' : ''}
                        </div>
                    </div>
                    <div class="text-xs text-viper-cyan truncate mt-0.5">${this.esc(email.from)}</div>
                    <div class="text-xs text-gray-500 mt-0.5">${dateStr}</div>
                </div>
            `;
        }).join('');
    }

    /* ═══════════════════════════════════════════════════
       EMAIL DETAIL
    ═══════════════════════════════════════════════════ */

    renderEmailDetail() {
        if (!this.selectedEmail) {
            return `
                <div class="text-center text-gray-400 py-20">
                    <div class="text-6xl mb-4">📧</div>
                    <div class="text-xl font-medium">Select an email to view details</div>
                    <div class="text-sm text-gray-500 mt-2">Choose from the list on the left</div>
                </div>
            `;
        }

        const email = this.selectedEmail;
        const date = new Date(email.date);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

        return `
            <div class="email-detail">
                <!-- Subject + Flag -->
                <div class="flex items-start justify-between mb-4 gap-3">
                    <h2 class="text-xl font-bold text-white flex-1">${this.esc(email.subject)}</h2>
                    <div class="flex items-center space-x-2 flex-shrink-0">
                        ${this._flagBtn('emails', email.id, 'Flag')}
                        <button onclick="apertureUI.toggleFlag('${email.id}')"
                                class="px-3 py-1.5 text-sm rounded-lg transition-all ${
                                    email.flagged
                                        ? 'bg-orange-500/20 text-orange-400 border border-orange-500'
                                        : 'bg-viper-dark text-gray-400 border border-gray-600 hover:border-orange-500'
                                }">
                            ${email.flagged ? '🚩 Flagged' : '⚑ Flag'}
                        </button>
                    </div>
                </div>

                <!-- Meta -->
                <div class="space-y-1.5 text-sm mb-4">
                    <div class="flex"><span class="text-gray-500 w-16 font-medium">From:</span><span class="text-viper-cyan">${this.esc(email.from)}</span></div>
                    <div class="flex"><span class="text-gray-500 w-16 font-medium">To:</span><span class="text-white">${this.esc((email.to || []).join(', '))}</span></div>
                    ${email.cc && email.cc.length ? `<div class="flex"><span class="text-gray-500 w-16 font-medium">CC:</span><span class="text-gray-300">${this.esc(email.cc.join(', '))}</span></div>` : ''}
                    <div class="flex"><span class="text-gray-500 w-16 font-medium">Date:</span><span class="text-white">${dateStr}</span></div>
                </div>

                <!-- Headers toggle -->
                <button onclick="apertureUI.toggleHeaders()" class="text-xs text-viper-cyan hover:text-viper-green mb-3 inline-block">
                    ${this.showHeaders ? '▼ Hide Headers' : '▶ Show Full Headers'}
                </button>
                ${this.showHeaders && email.headers ? `
                <div class="mb-4 bg-viper-dark p-3 rounded-lg text-xs font-mono overflow-x-auto max-h-60 overflow-y-auto">
                    ${email.headers.map(h => `<div class="mb-0.5"><span class="text-viper-cyan">${this.esc(h.key)}:</span> <span class="text-gray-300">${this.esc(h.value)}</span></div>`).join('')}
                </div>` : ''}

                <!-- IP Analysis -->
                ${email.originating_ip ? this.renderIpSection(email.originating_ip) : ''}

                <!-- Attachments -->
                ${email.attachments && email.attachments.length > 0 ? this.renderAttachments(email) : ''}

                <!-- Email Body -->
                <div class="mt-4">
                    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Message Body</h3>
                    <div class="email-body bg-white rounded-lg overflow-hidden">
                        ${email.body_html
                            ? `<iframe id="email-body-frame" sandbox="allow-same-origin" srcdoc="${this.escAttr(this.processHtml(email.body_html, email.attachments))}" style="width:100%;border:none;min-height:400px;" onload="this.style.height=this.contentDocument.documentElement.scrollHeight+'px'"></iframe>`
                            : `<div class="p-4 bg-viper-dark text-gray-300 prose prose-invert max-w-none">${this.textToHtml(email.body_text)}</div>`
                        }
                    </div>
                </div>
            </div>
        `;
    }

    /* ═══════════════════════════════════════════════════
       IP ANALYSIS
    ═══════════════════════════════════════════════════ */

    renderIpSection(ipInfo) {
        return `
            <div class="mb-4 p-3 bg-gradient-to-br from-viper-dark to-viper-card rounded-lg border border-viper-cyan/30">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <div class="w-1.5 h-1.5 rounded-full bg-viper-cyan animate-pulse"></div>
                        <span class="text-gray-400 text-xs font-semibold uppercase tracking-wide">IP Analysis</span>
                    </div>
                    <div class="flex items-center space-x-2">
                        ${this._flagBtn('ips', ipInfo.ip_address)}
                        <button onclick="apertureUI.lookupIp('${ipInfo.ip_address}')"
                                class="px-2 py-1 text-xs bg-viper-cyan/20 text-viper-cyan border border-viper-cyan/50 rounded hover:bg-viper-cyan/30 transition-all ${this.lookingUpIp ? 'opacity-50' : ''}">
                            ${this.lookingUpIp ? '...' : '🌐 Lookup'}
                        </button>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-2">
                    <div>
                        <div class="text-xs text-gray-500">IP Address</div>
                        <div class="font-mono text-white text-sm">${ipInfo.ip_address}</div>
                    </div>
                    <div>
                        <div class="text-xs text-gray-500">Type</div>
                        <span class="text-xs px-2 py-0.5 rounded ${
                            ipInfo.classification === 'end_user_originating' || ipInfo.classification === 'public'
                                ? 'bg-orange-500/20 text-orange-400'
                                : 'bg-blue-500/20 text-blue-400'
                        }">${(ipInfo.classification || '').replace(/_/g, ' ')}</span>
                    </div>
                    <div>
                        <div class="text-xs text-gray-500">Confidence</div>
                        <div class="text-sm text-white">${Math.round((ipInfo.confidence || 0) * 100)}%</div>
                    </div>
                </div>
                ${this.ipGeoInfo ? this.renderGeoInfo(this.ipGeoInfo) : ''}
            </div>
        `;
    }

    renderGeoInfo(geo) {
        return `
            <div class="mt-3 pt-3 border-t border-viper-cyan/20 grid grid-cols-2 gap-2 text-xs">
                ${geo.city ? `<div><span class="text-gray-500">City:</span> <span class="text-white">${this.esc(geo.city)}</span></div>` : ''}
                ${geo.region ? `<div><span class="text-gray-500">Region:</span> <span class="text-white">${this.esc(geo.region)}</span></div>` : ''}
                ${geo.country ? `<div><span class="text-gray-500">Country:</span> <span class="text-white">${this.esc(geo.country)}</span></div>` : ''}
                ${geo.isp ? `<div><span class="text-gray-500">ISP:</span> <span class="text-white">${this.esc(geo.isp)}</span></div>` : ''}
                ${geo.org ? `<div><span class="text-gray-500">Org:</span> <span class="text-white">${this.esc(geo.org)}</span></div>` : ''}
                ${geo.timezone ? `<div><span class="text-gray-500">Timezone:</span> <span class="text-white">${this.esc(geo.timezone)}</span></div>` : ''}
                ${geo.latitude ? `<div><span class="text-gray-500">Coords:</span> <span class="text-white">${geo.latitude}, ${geo.longitude}</span></div>` : ''}
                ${geo.asn ? `<div><span class="text-gray-500">ASN:</span> <span class="text-white">${this.esc(geo.asn)}</span></div>` : ''}
            </div>
        `;
    }

    async lookupIp(ipAddress) {
        this.lookingUpIp = true;
        this.refreshDetailView();

        const geo = await this.module.lookupIp(ipAddress);
        this.ipGeoInfo = geo;
        this.lookingUpIp = false;
        this.refreshDetailView();
    }

    /* ═══════════════════════════════════════════════════
       ATTACHMENTS
    ═══════════════════════════════════════════════════ */

    renderAttachments(email) {
        return `
            <div class="mb-4">
                <h3 class="text-sm font-semibold text-viper-purple mb-2">📎 Attachments (${email.attachments.length})</h3>
                <div class="grid grid-cols-2 gap-2">
                    ${email.attachments.map((att, idx) => `
                        <div class="bg-viper-dark p-2.5 rounded-lg flex items-center justify-between border border-gray-700/50 hover:border-viper-purple/30 transition-colors">
                            <div class="flex-1 min-w-0 mr-2">
                                <div class="text-sm font-medium text-white truncate">${this.esc(att.filename)}</div>
                                <div class="text-xs text-gray-500">${this.formatBytes(att.size)} · ${att.mime_type || 'unknown'}</div>
                            </div>
                            <div class="flex space-x-1 flex-shrink-0">
                                ${this._flagBtn('attachments', `${email.id}::${idx}`)}
                                <button onclick="apertureUI.viewAttachment(${idx})" class="text-viper-cyan hover:text-white px-1" title="Preview">👁️</button>
                                <button onclick="apertureUI.openAttachmentExternal(${idx})" class="text-viper-green hover:text-white px-1" title="Open">📂</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    viewAttachment(index) {
        if (!this.selectedEmail || !this.selectedEmail.attachments[index]) return;
        const att = this.selectedEmail.attachments[index];

        document.getElementById('attachment-viewer-title').textContent = att.filename;
        this._currentAttachment = { index, emailId: this.selectedEmail.id, attachment: att };

        const content = document.getElementById('attachment-viewer-content');
        const mime = (att.mime_type || '').toLowerCase();
        const isImage = mime.startsWith('image/');
        const isText = mime.startsWith('text/') || mime === 'application/json';

        if (isImage && att.content) {
            content.innerHTML = `<img src="data:${att.mime_type};base64,${att.content}" class="max-w-full rounded" alt="${this.esc(att.filename)}">`;
        } else if (isText && att.content) {
            const text = atob(att.content);
            content.innerHTML = `<pre class="text-sm text-gray-300 whitespace-pre-wrap font-mono bg-viper-dark p-4 rounded-lg overflow-auto max-h-[70vh]">${this.esc(text)}</pre>`;
        } else {
            content.innerHTML = `
                <div class="text-center py-10">
                    <div class="text-5xl mb-3">📄</div>
                    <p class="text-gray-300 font-medium">${this.esc(att.filename)}</p>
                    <p class="text-gray-500 text-sm mt-1">${this.formatBytes(att.size)} · ${att.mime_type || 'Unknown type'}</p>
                    <p class="text-gray-500 text-xs mt-3">Preview not available for this file type.</p>
                    <button onclick="apertureUI.openAttachmentExternal()" class="mt-4 btn-viper-primary px-4 py-2 rounded-lg text-sm">Open Externally</button>
                </div>
            `;
        }

        document.getElementById('aperture-attachment-modal').classList.remove('hidden');
    }

    async openAttachmentExternal(index) {
        let att, emailId;
        if (typeof index === 'number' && this.selectedEmail) {
            att = this.selectedEmail.attachments[index];
            emailId = this.selectedEmail.id;
        } else if (this._currentAttachment) {
            att = this._currentAttachment.attachment;
            emailId = this._currentAttachment.emailId;
        }
        if (!att || !emailId) return;

        await this.module.openAttachment(emailId, att);
    }

    /* ═══════════════════════════════════════════════════
       NOTES PANEL
    ═══════════════════════════════════════════════════ */

    renderNotesPanel() {
        if (!this.selectedEmail) return '';

        return `
            <div class="p-3 border-b border-viper-cyan/20 flex-shrink-0">
                <h3 class="text-sm font-semibold text-viper-orange">📝 Notes</h3>
            </div>
            <div class="p-3 flex-shrink-0">
                <textarea id="aperture-note-input" rows="3" placeholder="Add investigator note..."
                    class="w-full px-3 py-2 bg-viper-dark text-white rounded-lg border border-viper-cyan/30 focus:border-viper-orange outline-none text-sm resize-none"></textarea>
                <button onclick="apertureUI.handleAddNote()" class="mt-1 w-full px-3 py-1.5 rounded-lg text-xs bg-viper-orange/20 text-viper-orange border border-viper-orange/30 hover:bg-viper-orange/30 transition-colors font-semibold">
                    Add Note
                </button>
            </div>
            <div id="aperture-notes-list" class="flex-1 overflow-y-auto p-3 space-y-2">
                ${this.notes.length === 0 ? '<p class="text-gray-500 text-xs text-center py-4">No notes yet</p>' :
                    this.notes.map(note => `
                        <div class="bg-viper-dark/80 rounded-lg p-2.5 border border-viper-orange/10 group">
                            <p class="text-sm text-gray-300">${this.esc(note.content)}</p>
                            <div class="flex items-center justify-between mt-1.5">
                                <span class="text-xs text-gray-500">${new Date(note.created_at).toLocaleString()}</span>
                                <button onclick="apertureUI.handleDeleteNote('${note.id}')" class="text-red-400 hover:text-red-300 text-xs opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                            </div>
                        </div>
                    `).join('')
                }
            </div>
        `;
    }

    async loadNotes() {
        if (!this.selectedEmail) {
            this.notes = [];
            return;
        }
        this.notes = await this.module.getNotes(this.selectedEmail.id);
    }

    async handleAddNote() {
        const input = document.getElementById('aperture-note-input');
        if (!input || !input.value.trim() || !this.selectedEmail) return;

        const note = await this.module.addNote(this.selectedEmail.id, input.value.trim());
        if (note) {
            this.notes.unshift(note);
            input.value = '';
            this.refreshNotesPanel();

            // Auto-flag email when a note is added
            if (!this.selectedEmail.flagged) {
                await this.module.toggleEmailFlag(this.selectedEmail.id);
                this.selectedEmail = this.module.getEmail(this.selectedEmail.id);
                this.refreshEmailList();
                this.refreshDetailView();
                this.refreshStats();
            }
        }
    }

    async handleDeleteNote(noteId) {
        if (!this.selectedEmail) return;
        await this.module.deleteNote(this.selectedEmail.id, noteId);
        this.notes = this.notes.filter(n => n.id !== noteId);
        this.refreshNotesPanel();
    }

    /* ═══════════════════════════════════════════════════
       REPORT GENERATION
    ═══════════════════════════════════════════════════ */

    showReportDialog() {
        document.getElementById('aperture-report-dialog').classList.remove('hidden');
    }

    async handleGenerateReport() {
        const flaggedOnly = document.getElementById('aperture-report-flagged').checked;
        document.getElementById('aperture-report-dialog').classList.add('hidden');

        const result = await this.module.generateReport(flaggedOnly);
        if (result.success) {
            if (typeof showNotification === 'function') {
                showNotification('Report generated and opened in browser', 'success');
            }
        } else {
            alert('Failed to generate report: ' + (result.error || 'Unknown error'));
        }
    }

    /* ═══════════════════════════════════════════════════
       IMPORT
    ═══════════════════════════════════════════════════ */

    showImportDialog() {
        document.getElementById('aperture-import-dialog').classList.remove('hidden');
    }

    hideImportDialog() {
        document.getElementById('aperture-import-dialog').classList.add('hidden');
        const src = document.getElementById('aperture-import-source');
        const file = document.getElementById('aperture-import-file');
        if (src) src.value = '';
        if (file) file.value = '';
    }

    async handleImport() {
        const sourceName = document.getElementById('aperture-import-source').value.trim();
        const fileInput = document.getElementById('aperture-import-file');

        if (!sourceName) { alert('Please enter a source name'); return; }
        if (!fileInput.files || !fileInput.files.length) { alert('Please select a file'); return; }

        const file = fileInput.files[0];
        try {
            await this.module.importFile(file.path, file.name, sourceName);
            this.hideImportDialog();
            this.refreshAll();
            if (typeof showNotification === 'function') {
                showNotification('Email data imported successfully', 'success');
            }
        } catch (error) {
            alert('Import failed: ' + error.message);
        }
    }

    /* ═══════════════════════════════════════════════════
       INTERACTIONS
    ═══════════════════════════════════════════════════ */

    async selectEmail(emailId) {
        this.selectedEmail = this.module.getEmail(emailId);
        this.showHeaders = false;
        this.ipGeoInfo = null;
        this.lookingUpIp = false;

        // Load notes for this email
        await this.loadNotes();

        // Show notes panel
        const panel = document.getElementById('aperture-notes-panel');
        if (panel) panel.classList.remove('hidden');

        this.refreshDetailView();
        this.refreshNotesPanel();
        this.refreshEmailList(); // Update selection highlight
    }

    async toggleFlag(emailId) {
        await this.module.toggleEmailFlag(emailId);
        this.selectedEmail = this.module.getEmail(emailId);
        this.refreshAll();
    }

    toggleHeaders() {
        this.showHeaders = !this.showHeaders;
        this.refreshDetailView();
    }

    handleSearch(query) {
        this.searchQuery = query;
        this.refreshEmailList();
    }

    handleFilter(filter) {
        this.currentFilter = filter;
        this.refreshEmailList();
    }

    handleSourceFilter(sourceId) {
        this.currentSource = sourceId;
        this.refreshEmailList();
    }

    /* ═══════════════════════════════════════════════════
       REFRESH METHODS
    ═══════════════════════════════════════════════════ */

    async refreshAll() {
        await this.module.loadEmails();
        await this.module.loadSources();
        await this.module.scanEvidence();

        if (this.selectedEmail) {
            this.selectedEmail = this.module.getEmail(this.selectedEmail.id);
            await this.loadNotes();
        }

        this.refreshStats();
        this.refreshEmailList();
        this.refreshDetailView();
        this.refreshNotesPanel();
        this.updateSourceFilter();
        this._refreshFlagToolbar();
    }

    refreshStats() {
        const el = document.getElementById('aperture-stats');
        if (el) el.innerHTML = this.renderStats();
    }

    refreshEmailList() {
        const el = document.getElementById('aperture-email-list');
        if (el) el.innerHTML = this.renderEmailList();
    }

    refreshDetailView() {
        const el = document.getElementById('aperture-email-detail');
        if (el) el.innerHTML = this.renderEmailDetail();
    }

    refreshNotesPanel() {
        const el = document.getElementById('aperture-notes-content');
        if (el) el.innerHTML = this.renderNotesPanel();
    }

    updateSourceFilter() {
        const select = document.getElementById('aperture-source-filter');
        if (select) {
            const sources = this.module.getSources();
            const opts = ['<option value="all">All Sources</option>'];
            sources.forEach(s => {
                opts.push(`<option value="${s.id}">${this.esc(s.name)} (${s.emailCount || 0})</option>`);
            });
            select.innerHTML = opts.join('');
        }
    }

    /* ═══════════════════════════════════════════════════
       UTILITIES
    ═══════════════════════════════════════════════════ */

    // ─── Flag-to-Evidence toolbar (header area) ────────────────────────

    _renderFlagToolbar() {
        const total = this.module.flagCount();
        const enabled = total > 0;
        return `
            <div class="awp-flag-toolbar">
                <button class="awp-flag-header-btn"
                        title="Flagged item count — click to clear all flags"
                        onclick="window.apertureUI._clearAllFlags()">
                    🚩 Flags
                    <span class="awp-flag-count-pill" id="awp-flag-count">${total.toLocaleString()}</span>
                </button>
                <div class="awp-flag-toolbar-spacer"></div>
                <button class="awp-push-btn" id="awp-push-btn"
                        ${enabled ? '' : 'disabled'}
                        onclick="window.apertureUI._pushFlagsToEvidence()"
                        title="Push flagged items to the case Evidence module">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        const total = this.module.flagCount();
        const pill = document.getElementById('awp-flag-count');
        if (pill) pill.textContent = total.toLocaleString();
        const btn = document.getElementById('awp-push-btn');
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

        const btn = document.getElementById('awp-push-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                this.module.clearFlags();
                this._refreshFlagToolbar();
                this.refreshAll();
            }
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '📥 Push to Evidence'; }
            this._refreshFlagToolbar();
        }
    }

    _clearAllFlags() {
        const total = this.module.flagCount();
        if (total === 0) return;
        if (!confirm(`Clear all ${total} flagged items?`)) return;
        this.module.clearFlags();
        this._refreshFlagToolbar();
        this.refreshAll();
    }

    _toast(msg, type) {
        try {
            if (typeof window.showToast === 'function') { window.showToast(msg, type || 'info'); return; }
        } catch (_) {}
        console.log(`[Aperture ${type || 'info'}] ${msg}`);
    }

    _onFlagClick(section, key) {
        this.module.toggleFlag(section, key);
        this._refreshFlagToolbar();
        // Re-render the current detail + list to update flag-button states
        this.refreshEmailList();
        this.refreshDetailView();
    }

    _flagBtn(section, key, label) {
        const on = this.module.isFlagged(section, key);
        const safeKey = String(key)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        return `<button class="awp-flag-btn ${on ? 'on' : ''}"
                        title="${on ? 'Unflag' : 'Flag for evidence bundle'}"
                        onclick="event.stopPropagation(); window.apertureUI._onFlagClick('${section}', '${safeKey}')">
                  🚩${label ? '<span style="margin-left:2px">' + label + '</span>' : ''}
                </button>`;
    }

    /* ═══════════════════════════════════════════════════
       UTILITIES
    ═══════════════════════════════════════════════════ */

    processHtml(html, attachments) {
        if (!html) return '';
        let processed = html;
        if (attachments) {
            attachments.forEach(att => {
                if (att.content_id && att.content) {
                    const dataUrl = `data:${att.mime_type};base64,${att.content}`;
                    const cid = att.content_id.replace(/[<>]/g, '');
                    processed = processed.replace(new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), dataUrl);
                }
            });
        }
        return processed;
    }

    esc(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escAttr(html) {
        if (!html) return '';
        return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    textToHtml(text) {
        if (!text) return '<span class="text-gray-500">No content</span>';
        return this.esc(text).replace(/\n/g, '<br>');
    }

    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

// Global reference for inline event handlers
// Use var (not let) so it becomes a window property accessible to inline onclick handlers
var apertureUI;
window.ApertureUI = ApertureUI;
