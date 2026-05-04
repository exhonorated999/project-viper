/**
 * Datapilot UI — investigator-driven 4-view layout
 *
 *   Subject     who is this device + at-a-glance highlights
 *   Comms       messages + calls unified, threaded by contact
 *   Movement    GPS + photo-EXIF, time scrubber, event pins
 *   Artifacts   media + files + apps + deleted, faceted search
 *
 * Coach drawer overlays whichever view is active and uses
 * `ui.navigateTo(view, opts)` to drill back into records.
 */

class DatapilotUI {
    constructor(module) {
        this.module = module;
        this.activeView = 'subject';
        // Per-view state (preserved across re-renders within the session)
        this.commsState     = { activeContactKey: null, search: '', dirFilter: 'all', dayHourFilter: null, dateFilter: null };
        this.movementState  = { from: null, to: null, mode: 'both', eventPin: null, focusLat: null, focusLng: null };
        this.artifactsState = { search: '', type: null, source: null, hasGps: false, flaggedOnly: false };
        this.subjectState   = { contactSearch: '' };
        this._contactIndexCache = null;
        this._allArtifactsCache = null;
        this._lastImportId = null;
    }

    // ────────────────────────── public API ──────────────────────────

    setActiveView(view) {
        this.activeView = view;
        this.module.activeTab = view;
        this.module.render();
    }

    /**
     * Coach (and other panels) call this to jump to records.
     * Examples:
     *   navigateTo('comms', { contactKey })
     *   navigateTo('comms', { dayHour: { day:0..6, hour:0..23 } })
     *   navigateTo('comms', { date: 'YYYY-MM-DD' })
     *   navigateTo('movement', { from, to, lat, lng })
     *   navigateTo('artifacts', { type:'photo'|'video'|..., source:'present'|'deleted', hasGps:true, flaggedOnly:true })
     */
    navigateTo(view, opts = {}) {
        if (view === 'comms') {
            if (opts.contactKey != null) this.commsState.activeContactKey = String(opts.contactKey);
            if (opts.dayHour) this.commsState.dayHourFilter = opts.dayHour; else this.commsState.dayHourFilter = null;
            if (opts.date) this.commsState.dateFilter = opts.date; else this.commsState.dateFilter = null;
            if (opts.search != null) this.commsState.search = opts.search;
            if (opts.dirFilter) this.commsState.dirFilter = opts.dirFilter;
        } else if (view === 'movement') {
            if (opts.from) this.movementState.from = opts.from;
            if (opts.to) this.movementState.to = opts.to;
            if (opts.lat != null) this.movementState.focusLat = opts.lat;
            if (opts.lng != null) this.movementState.focusLng = opts.lng;
            if (opts.mode) this.movementState.mode = opts.mode;
        } else if (view === 'artifacts') {
            this.artifactsState = {
                search: opts.search || '',
                type: opts.type || null,
                source: opts.source || null,
                hasGps: !!opts.hasGps,
                flaggedOnly: !!opts.flaggedOnly,
            };
        }
        this.activeView = view;
        this.module.activeTab = view;
        // Close the coach drawer when navigating
        if (this.module.coach) this.module.coach.close();
        this.module.render();
    }

    // ────────────────────────── render entry ──────────────────────────

    render(rootEl) {
        if (!rootEl) return;
        const imp = this.module.getActiveImport();
        if (this._lastImportId !== (imp && imp.id)) {
            // Invalidate caches when import changes
            this._contactIndexCache = null;
            this._allArtifactsCache = null;
            this._lastImportId = imp && imp.id;
        }
        if (!imp) {
            rootEl.innerHTML = this._renderEmpty();
            this._wireEmpty(rootEl);
            return;
        }
        rootEl.innerHTML = `
            <div class="dp-shell">
                ${this._renderHeader(imp)}
                ${this._renderViewSwitcher()}
                <div class="dp-view-body" id="dp-view-body">
                    ${this._renderViewContent(imp)}
                </div>
            </div>
        `;
        this._wireHeader(rootEl);
        this._wireViewSwitcher(rootEl);
        this._wireView(rootEl, imp);
    }

    // ────────────────────────── empty ──────────────────────────

    _renderEmpty() {
        const folders = this.module.scannedFolders || [];
        const fmtBadge = (f) => {
            const v = (f === 'dpx') ? 'DPX' : 'CSV';
            const bg = (f === 'dpx') ? 'rgba(0,229,255,0.15)' : 'rgba(160,160,160,0.18)';
            const fg = (f === 'dpx') ? '#00e5ff' : '#bbb';
            return `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${bg};color:${fg};margin-left:8px;letter-spacing:0.5px;">${v}</span>`;
        };
        const srcBadge = (src, refOnly) => {
            const map = {
                disk:     { label: 'IN CASE',   bg: 'rgba(34,197,94,0.18)',  fg: '#86efac' },
                evidence: { label: refOnly ? 'EV · REF' : 'EVIDENCE', bg: refOnly ? 'rgba(234,179,8,0.18)' : 'rgba(168,85,247,0.18)', fg: refOnly ? '#fde68a' : '#d8b4fe' },
                imported: { label: 'IMPORTED', bg: 'rgba(0,229,255,0.12)', fg: '#7dd3fc' }
            };
            const m = map[src];
            if (!m) return '';
            return `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${m.bg};color:${m.fg};margin-left:6px;letter-spacing:0.5px;">${m.label}</span>`;
        };
        const list = folders.length ? `
            <div class="dp-scanned">
                <div class="dp-scanned-title">Found Datapilot extractions for this case:</div>
                ${folders.map((f, i) => {
                    const missing = !!f.missing;
                    // Always show Import — let the user try. If the path is truly
                    // dead the parser will fail with a clean error.
                    const btnLabel = missing ? 'Try Import' : 'Import';
                    const btnClass = missing ? 'dp-btn dp-btn-secondary' : 'dp-btn dp-btn-primary';
                    const btn = `<button class="${btnClass}" data-dp-import="${i}" title="${missing ? 'Path may not be reachable — click to try anyway' : 'Parse this Datapilot extraction'}">${btnLabel}</button>`;
                    const warnRow = missing
                        ? `<div style="font-size:11px;color:#fde68a;margin-top:4px;">⚠ Path may not be reachable — reconnect the drive if this is a USB extraction, then click Try Import.</div>`
                        : '';
                    return `
                    <div class="dp-scanned-row" style="${missing ? 'border-color:rgba(234,179,8,0.35);' : ''}">
                        <div>
                            <div class="dp-scanned-name">${this._esc(f.name)}${fmtBadge(f.format || 'csv')}${srcBadge(f.source, f.referenceOnly)}</div>
                            <div class="dp-scanned-path">${this._esc(f.path)}</div>
                            ${warnRow}
                        </div>
                        ${btn}
                    </div>
                `;
                }).join('')}
            </div>
        ` : '';
        return `
            <div class="dp-shell">
                <div class="dp-empty">
                    <div class="dp-empty-icon">📱</div>
                    <h3>Datapilot — Mobile Forensics</h3>
                    <p class="dp-empty-help">
                        Import a Datapilot export folder — supports both <strong>CSV</strong> (legacy) and <strong>DPX</strong> (Datapilot 10) formats.<br>
                        Calls, messages, contacts, GPS, photos, files, apps & deleted-data carving — all in one place.
                    </p>
                    <div class="dp-empty-actions">
                        <button class="dp-btn dp-btn-primary" id="dp-pick-folder">Pick Folder…</button>
                        <button class="dp-btn dp-btn-secondary" id="dp-rescan">Re-scan Evidence</button>
                    </div>
                    ${list}
                </div>
            </div>
        `;
    }

    _wireEmpty(root) {
        const pick = root.querySelector('#dp-pick-folder');
        if (pick) pick.onclick = () => this.module.pickFolder();
        const rescan = root.querySelector('#dp-rescan');
        if (rescan) rescan.onclick = () => this.module.autoScan();
        const folders = this.module.scannedFolders || [];
        root.querySelectorAll('[data-dp-import]').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.dpImport, 10);
                const f = folders[idx];
                if (f) this.module.importFolder(f.path, f.name);
            };
        });
    }

    // ────────────────────────── header ──────────────────────────

    _renderHeader(imp) {
        const imports = this.module.data.imports;
        const dev = imp.deviceInfo || {};
        const flagN = this.module.flagCount();
        return `
            <div class="dp-header">
                <div class="dp-header-left">
                    <select class="dp-import-switcher" id="dp-import-switcher">
                        ${imports.map(i => `<option value="${this._esc(i.id)}" ${i.id === imp.id ? 'selected' : ''}>${this._esc(i.fileName)} — ${this._esc((i.deviceInfo && i.deviceInfo.model) || 'device')}</option>`).join('')}
                    </select>
                    <div class="dp-device-chip">
                        <span class="dp-device-model">${this._esc(dev.model || dev.make || 'Unknown')}</span>
                        ${dev.phoneNumber ? `<span class="dp-chip-num">${this._esc(dev.phoneNumber)}</span>` : ''}
                        ${dev.carrier ? `<span class="dp-chip-carrier">${this._esc(dev.carrier)}</span>` : ''}
                    </div>
                </div>
                <div class="dp-header-right">
                    <button class="dp-btn dp-btn-coach" id="dp-coach-toggle">
                        💡 Coach
                    </button>
                    <button class="dp-btn dp-btn-secondary" id="dp-flags-btn">
                        🚩 Flags <span class="dp-flag-count">${flagN}</span>
                    </button>
                    <button class="dp-btn dp-btn-secondary" id="dp-pdf-btn">📄 PDF</button>
                    <button class="dp-btn dp-btn-primary" id="dp-add-import">+ Import</button>
                    <button class="dp-btn dp-btn-secondary" id="dp-rescan-import" title="Re-parse this folder (preserves flags)">🔄 Re-scan</button>
                    <button class="dp-btn dp-btn-danger" id="dp-delete-import" title="Remove this import">🗑</button>
                </div>
            </div>
        `;
    }

    _wireHeader(root) {
        const sw = root.querySelector('#dp-import-switcher');
        if (sw) sw.onchange = (e) => this.module.setActiveImport(e.target.value);
        const coach = root.querySelector('#dp-coach-toggle');
        if (coach) coach.onclick = () => { if (this.module.coach) this.module.coach.toggle(); };
        const flags = root.querySelector('#dp-flags-btn');
        if (flags) flags.onclick = () => this._openFlagsSummary();
        const pdf = root.querySelector('#dp-pdf-btn');
        if (pdf) pdf.onclick = () => this._generatePdf();
        const add = root.querySelector('#dp-add-import');
        if (add) add.onclick = () => this.module.pickFolder();
        const rescan = root.querySelector('#dp-rescan-import');
        if (rescan) rescan.onclick = () => this.module.rescanActiveImport();
        const del = root.querySelector('#dp-delete-import');
        if (del) del.onclick = () => this.module.deleteImport(this.module.activeImportId);
    }

    // ────────────────────────── view switcher ──────────────────────────

    _renderViewSwitcher() {
        const v = this.activeView;
        const tab = (id, icon, label) => `
            <button class="dp-vtab ${v === id ? 'active' : ''}" data-dp-view="${id}">
                <span class="dp-vtab-icon">${icon}</span>
                <span class="dp-vtab-label">${label}</span>
            </button>
        `;
        return `
            <div class="dp-vtabs">
                ${tab('subject',   '🪪', 'Subject')}
                ${tab('comms',     '💬', 'Comms')}
                ${tab('movement',  '🗺️', 'Movement')}
                ${tab('artifacts', '🗂️', 'Artifacts')}
            </div>
        `;
    }

    _wireViewSwitcher(root) {
        root.querySelectorAll('[data-dp-view]').forEach(btn => {
            btn.onclick = () => this.setActiveView(btn.dataset.dpView);
        });
    }

    // ────────────────────────── dispatch ──────────────────────────

    _renderViewContent(imp) {
        switch (this.activeView) {
            case 'subject':   return this._renderSubject(imp);
            case 'comms':     return this._renderComms(imp);
            case 'movement':  return this._renderMovement(imp);
            case 'artifacts': return this._renderArtifacts(imp);
            default:          return this._renderSubject(imp);
        }
    }

    _wireView(root, imp) {
        switch (this.activeView) {
            case 'subject':   this._wireSubject(root, imp); break;
            case 'comms':     this._wireComms(root, imp); break;
            case 'movement':  this._wireMovement(root, imp); break;
            case 'artifacts': this._wireArtifacts(root, imp); break;
        }
    }

    // ════════════════════════ SUBJECT VIEW ════════════════════════

    _renderSubject(imp) {
        const idx = this._buildContactIndex(imp);
        const topContacts = idx.contacts.slice(0, 10);
        const topPlaces = this._topGpsPlaces(imp).slice(0, 8);
        const keyApps = this._keyApps(imp);
        const sparkline = this._buildActivitySparkline(imp);
        const stats = imp.stats || {};
        const dev = imp.deviceInfo || {};
        const sum = imp.summary || {};

        return `
            <div class="dp-subject">
                <div class="dp-subject-grid">
                    <!-- LEFT COLUMN -->
                    <div class="dp-subject-left">
                        <div class="dp-card">
                            <div class="dp-card-title">Device & Owner</div>
                            <div class="dp-kv-grid">
                                ${this._kv('Make', dev.make)}
                                ${this._kv('Model', dev.model)}
                                ${this._kv('Phone Number', dev.phoneNumber)}
                                ${this._kv('Carrier', dev.carrier)}
                                ${this._kv('IMEI', dev.imei)}
                                ${this._kv('Serial', dev.serial)}
                                ${this._kv('OS', dev.osVersion)}
                                ${this._kv('Acquisition', sum.acquisitionDate || sum.created)}
                                ${this._kv('Examiner', sum.examiner)}
                                ${this._kv('Case Ref', sum.caseRef)}
                            </div>
                        </div>

                        <div class="dp-card">
                            <div class="dp-card-title">
                                Top Contacts <span class="dp-card-sub">${idx.contacts.length} total · click row to open conversation</span>
                            </div>
                            ${topContacts.length === 0 ? `<div class="dp-empty-inline">No communications recorded.</div>` : `
                                <table class="dp-table dp-table-clickable">
                                    <thead><tr><th></th><th>Contact</th><th>Number</th><th>Msgs</th><th>Calls</th><th>Last</th></tr></thead>
                                    <tbody>
                                        ${topContacts.map((c, i) => `
                                            <tr data-dp-contact="${this._esc(c.key)}">
                                                <td class="dp-row-num">${i + 1}</td>
                                                <td><strong>${this._esc(c.name || '(unknown)')}</strong></td>
                                                <td class="dp-mono">${this._esc(c.displayNumber)}</td>
                                                <td>${c.msgs.length}</td>
                                                <td>${c.calls.length}</td>
                                                <td class="dp-row-meta">${this._esc(c.lastDate || '—')}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            `}
                        </div>

                        <div class="dp-card">
                            <div class="dp-card-title">
                                Top Locations <span class="dp-card-sub">${topPlaces.length ? 'click to open on map' : 'no GPS data'}</span>
                            </div>
                            ${topPlaces.length === 0 ? `<div class="dp-empty-inline">No GPS-bearing media or location data found.</div>` : `
                                <table class="dp-table dp-table-clickable">
                                    <thead><tr><th></th><th>Coordinates</th><th>Photos</th><th>Date Range</th></tr></thead>
                                    <tbody>
                                        ${topPlaces.map((p, i) => `
                                            <tr data-dp-place="${p.lat.toFixed(5)},${p.lng.toFixed(5)}">
                                                <td class="dp-row-num">${i + 1}</td>
                                                <td class="dp-mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</td>
                                                <td>${p.count}</td>
                                                <td class="dp-row-meta">${this._esc(p.firstDate || '?')} → ${this._esc(p.lastDate || '?')}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            `}
                        </div>

                        <div class="dp-card">
                            <div class="dp-card-title">Key Apps <span class="dp-card-sub">grouped by investigative relevance</span></div>
                            ${this._renderKeyAppsBlock(keyApps)}
                        </div>
                    </div>

                    <!-- RIGHT COLUMN -->
                    <div class="dp-subject-right">
                        <div class="dp-card dp-card-anomaly">
                            <div class="dp-card-title">Anomaly Highlights</div>
                            ${this._renderAnomalyHighlights(imp)}
                        </div>

                        <div class="dp-card">
                            <div class="dp-card-title">Activity (last 90 days)</div>
                            ${sparkline}
                        </div>

                        <div class="dp-card">
                            <div class="dp-card-title">Volumes</div>
                            <div class="dp-stat-grid dp-stat-grid-tight">
                                ${this._statTile('Contacts',  stats.contacts,  'comms', { contactKey: null })}
                                ${this._statTile('Messages',  stats.messages,  'comms')}
                                ${this._statTile('Calls',     stats.calls,     'comms', { dirFilter: 'all' })}
                                ${this._statTile('Photos',    stats.photos,    'artifacts', { type: 'photo' })}
                                ${this._statTile('Videos',    stats.videos,    'artifacts', { type: 'video' })}
                                ${this._statTile('Files',     stats.files,     'artifacts', { type: 'file' })}
                                ${this._statTile('Apps',      stats.apps,      'artifacts', { type: 'app' })}
                                ${this._statTile('Deleted',   stats.deleted,   'artifacts', { source: 'deleted' })}
                            </div>
                        </div>

                        ${this._renderAllContactsCard(idx)}
                    </div>
                </div>
            </div>
        `;
    }

    _wireSubject(root) {
        root.querySelectorAll('[data-dp-contact]').forEach(tr => {
            tr.onclick = () => this.navigateTo('comms', { contactKey: tr.dataset.dpContact });
        });
        const csearch = root.querySelector('#dp-subject-contact-search');
        if (csearch) {
            let t;
            // Preserve focus + caret across re-renders so typing is fluid.
            const wasFocused = (root.ownerDocument && root.ownerDocument.activeElement && root.ownerDocument.activeElement.id === 'dp-subject-contact-search');
            if (this.subjectState.contactSearch) {
                csearch.value = this.subjectState.contactSearch;
            }
            csearch.oninput = (e) => {
                clearTimeout(t);
                this.subjectState.contactSearch = e.target.value;
                t = setTimeout(() => this.module.render(), 200);
            };
            if (wasFocused) {
                csearch.focus();
                const v = csearch.value;
                csearch.setSelectionRange(v.length, v.length);
            }
        }
        root.querySelectorAll('[data-dp-place]').forEach(tr => {
            tr.onclick = () => {
                const [lat, lng] = tr.dataset.dpPlace.split(',').map(Number);
                this.navigateTo('movement', { lat, lng });
            };
        });
        root.querySelectorAll('[data-dp-stat]').forEach(tile => {
            tile.onclick = () => {
                const view = tile.dataset.dpStat;
                const opts = JSON.parse(tile.dataset.dpStatOpts || '{}');
                this.navigateTo(view, opts);
            };
        });
        root.querySelectorAll('[data-dp-coach-panel]').forEach(b => {
            b.onclick = () => { if (this.module.coach) this.module.coach.openTo(b.dataset.dpCoachPanel); };
        });
    }

    _renderAllContactsCard(idx) {
        const all = idx.contacts || [];
        const search = (this.subjectState && this.subjectState.contactSearch) || '';
        const s = search.toLowerCase();
        const filtered = !s ? all : all.filter(c =>
            (c.name || '').toLowerCase().includes(s) ||
            (c.displayNumber || '').toLowerCase().includes(s) ||
            (c.phones || []).some(p => p.toLowerCase().includes(s))
        );
        // Cap rendered rows for perf — UFD exports can have thousands of contacts.
        const RENDER_CAP = 300;
        const shown = filtered.slice(0, RENDER_CAP);
        const overflow = filtered.length - shown.length;

        return `
            <div class="dp-card">
                <div class="dp-card-title">
                    All Contacts
                    <span class="dp-card-sub">${all.length} total · click to open conversation</span>
                </div>
                <input type="text"
                       class="dp-search dp-contact-search-input"
                       id="dp-subject-contact-search"
                       placeholder="Search by name or number"
                       value="${this._esc(search)}">
                <div class="dp-contact-search-meta">${filtered.length} match${filtered.length === 1 ? '' : 'es'}${overflow > 0 ? ` (showing first ${RENDER_CAP})` : ''}</div>
                <div class="dp-contact-list">
                    ${shown.length === 0
                        ? `<div class="dp-empty-inline">No contacts match.</div>`
                        : shown.map(c => {
                            const hasComms = (c.msgs && c.msgs.length) || (c.calls && c.calls.length);
                            return `
                                <div class="dp-contact-row${hasComms ? ' has-comms' : ''}" data-dp-contact="${this._esc(c.key)}">
                                    <div class="dp-contact-row-main">
                                        <div class="dp-contact-name">${this._esc(c.name || '(unknown)')}</div>
                                        <div class="dp-contact-num dp-mono">${this._esc(c.displayNumber || '(no number)')}</div>
                                    </div>
                                    <div class="dp-contact-meta">
                                        <span title="messages">💬 ${c.msgs.length}</span>
                                        <span title="calls">📞 ${c.calls.length}</span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                </div>
            </div>
        `;
    }

    _statTile(label, num, view, opts) {
        return `
            <div class="dp-stat dp-stat-clickable" data-dp-stat="${view}" data-dp-stat-opts='${JSON.stringify(opts || {})}'>
                <div class="dp-stat-num">${num != null ? this._formatNumber(num) : '0'}</div>
                <div class="dp-stat-label">${label}</div>
            </div>
        `;
    }

    _kv(label, value) {
        if (value == null || value === '') return `<div class="dp-kv-l">${this._esc(label)}</div><div class="dp-kv-v dp-kv-empty">—</div>`;
        return `<div class="dp-kv-l">${this._esc(label)}</div><div class="dp-kv-v">${this._esc(String(value))}</div>`;
    }

    _renderAnomalyHighlights(imp) {
        if (!this.module.coach) return `<div class="dp-empty-inline">Coach not loaded.</div>`;
        let alerts = [];
        try {
            alerts = this.module.coach.runAllRules(imp).filter(a => a.severity !== 'ok').slice(0, 3);
        } catch (e) { console.warn('coach rules failed', e); }
        if (alerts.length === 0) {
            return `
                <div class="dp-anomaly-good">No anomalies detected by automated rules.</div>
                <button class="dp-btn dp-btn-secondary" data-dp-coach-panel="anomalies" style="margin-top:8px">Open Coach Anomalies</button>
            `;
        }
        return `
            ${alerts.map(a => `
                <div class="dp-anomaly">
                    <div class="dp-anomaly-title">⚠ ${this._esc(a.title)}</div>
                    <div class="dp-anomaly-text">${this._esc(a.detail)}</div>
                    ${a.action ? `<button class="dp-btn dp-btn-link" data-dp-coach-panel="anomalies">View</button>` : ''}
                </div>
            `).join('')}
            <button class="dp-btn dp-btn-secondary" data-dp-coach-panel="anomalies" style="margin-top:8px">All Anomalies</button>
        `;
    }

    _topGpsPlaces(imp) {
        const pts = this._gpsPoints(imp);
        if (pts.length === 0) return [];
        // Greedy cluster: 0.5km radius
        const used = new Array(pts.length).fill(false);
        const clusters = [];
        for (let i = 0; i < pts.length; i++) {
            if (used[i]) continue;
            const c = { lat: pts[i].lat, lng: pts[i].lng, items: [pts[i]], firstDate: pts[i].dateIso, lastDate: pts[i].dateIso };
            used[i] = true;
            for (let j = i + 1; j < pts.length; j++) {
                if (used[j]) continue;
                if (this._haversineKm(c.lat, c.lng, pts[j].lat, pts[j].lng) <= 0.5) {
                    c.items.push(pts[j]);
                    used[j] = true;
                    if (pts[j].dateIso) {
                        if (!c.firstDate || pts[j].dateIso < c.firstDate) c.firstDate = pts[j].dateIso;
                        if (!c.lastDate || pts[j].dateIso > c.lastDate) c.lastDate = pts[j].dateIso;
                    }
                }
            }
            clusters.push(c);
        }
        return clusters
            .map(c => ({
                lat: c.items.reduce((a, p) => a + p.lat, 0) / c.items.length,
                lng: c.items.reduce((a, p) => a + p.lng, 0) / c.items.length,
                count: c.items.length,
                firstDate: c.firstDate ? c.firstDate.split('T')[0] : '',
                lastDate: c.lastDate ? c.lastDate.split('T')[0] : '',
            }))
            .sort((a, b) => b.count - a.count);
    }

    _gpsPoints(imp) {
        const pts = [];
        const exif = imp.photoExifByHash || {};
        for (const [hash, info] of Object.entries(exif)) {
            if (!info.gps || typeof info.gps.lat !== 'number' || typeof info.gps.lng !== 'number') continue;
            pts.push({
                lat: info.gps.lat, lng: info.gps.lng,
                exifHash: hash,
                dateIso: info.dateTimeIso || info.dateTime || ''
            });
        }
        return pts;
    }

    _keyApps(imp) {
        const apps = imp.apps || [];
        const groups = { 'Comms / Messaging': [], 'Browsers': [], 'Maps / Location': [], 'Privacy / Vault': [], 'Other notable': [] };
        const commsHints = ['whatsapp', 'signal', 'telegram', 'wickr', 'kik', 'snapchat', 'discord', 'messenger', 'imessage', 'session', 'threema', 'wire', 'viber', 'line', 'briar'];
        const browserHints = ['chrome', 'firefox', 'duckduckgo', 'tor', 'brave', 'opera', 'samsung internet', 'edge', 'safari'];
        const mapHints = ['maps', 'waze', 'navigation', 'gps', 'mapquest'];
        const privacyHints = ['vault', 'private', 'photo lock', 'calculator vault', 'hide', 'secure', 'incognito', 'kaspersky', 'nordvpn', 'expressvpn'];
        for (const a of apps) {
            const name = (a.displayName || a.appId || '').toLowerCase();
            if (commsHints.some(h => name.includes(h))) groups['Comms / Messaging'].push(a);
            else if (browserHints.some(h => name.includes(h))) groups['Browsers'].push(a);
            else if (mapHints.some(h => name.includes(h))) groups['Maps / Location'].push(a);
            else if (a.isPrivate || privacyHints.some(h => name.includes(h))) groups['Privacy / Vault'].push(a);
        }
        return groups;
    }

    _renderKeyAppsBlock(groups) {
        const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
        if (total === 0) {
            return `<div class="dp-empty-inline">No notable apps detected. <button class="dp-btn dp-btn-link" data-dp-stat="artifacts" data-dp-stat-opts='{"type":"app"}'>Browse all apps</button></div>`;
        }
        return Object.entries(groups).map(([label, apps]) => {
            if (!apps.length) return '';
            return `
                <div class="dp-keyapp-group">
                    <div class="dp-keyapp-label">${this._esc(label)} <span class="dp-card-sub">(${apps.length})</span></div>
                    <div class="dp-keyapp-list">
                        ${apps.slice(0, 8).map(a => `
                            <span class="dp-pill ${a.isPrivate ? 'dp-pill-warn' : ''}" title="${this._esc(a.appId)}">
                                ${this._esc(a.displayName || a.appId)}${a.version ? ` <span class="dp-card-sub">v${this._esc(a.version)}</span>` : ''}
                            </span>
                        `).join('')}
                        ${apps.length > 8 ? `<span class="dp-card-sub">+${apps.length - 8} more</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    _buildActivitySparkline(imp) {
        const msgs = imp.messages || [];
        const calls = imp.calls || [];
        if (msgs.length === 0 && calls.length === 0) return `<div class="dp-empty-inline">No dated activity.</div>`;
        // Bucket per day for last 90 days
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const start = new Date(today); start.setDate(start.getDate() - 89);
        const buckets = new Array(90).fill(0).map(() => ({ msgs: 0, calls: 0 }));
        for (const m of msgs) {
            if (!m.timestampIso) continue;
            const d = new Date(m.timestampIso);
            if (isNaN(d)) continue;
            const idx = Math.floor((d - start) / 86400000);
            if (idx >= 0 && idx < 90) buckets[idx].msgs++;
        }
        for (const c of calls) {
            const d = c.timestampIso ? new Date(c.timestampIso) : null;
            if (!d || isNaN(d)) continue;
            const idx = Math.floor((d - start) / 86400000);
            if (idx >= 0 && idx < 90) buckets[idx].calls++;
        }
        const max = Math.max(1, ...buckets.map(b => b.msgs + b.calls));
        const W = 380, H = 60, bw = W / 90;
        const bars = buckets.map((b, i) => {
            const total = b.msgs + b.calls;
            const h = (total / max) * (H - 4);
            return `<rect x="${(i * bw).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw - 0.5).toFixed(2)}" height="${h.toFixed(2)}" fill="${total ? '#22d3ee' : '#1f2937'}"></rect>`;
        }).join('');
        const totalAll = buckets.reduce((a, b) => a + b.msgs + b.calls, 0);
        return `
            <svg class="dp-spark" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">${bars}</svg>
            <div class="dp-spark-meta">${totalAll} events across the last 90 days · click <button class="dp-btn dp-btn-link" data-dp-coach-panel="heatmap">Heatmap</button> for day-hour breakdown</div>
        `;
    }

    // ════════════════════════ COMMS VIEW ════════════════════════

    _renderComms(imp) {
        const idx = this._buildContactIndex(imp);
        // The contact index includes contacts with no comms (so the Subject view
        // can browse them). For the Comms rail we only want contacts that
        // actually have messages or calls — investigators don't need to scroll
        // past hundreds of empty entries.
        const commsContacts = idx.contacts.filter(c => (c.msgs && c.msgs.length) || (c.calls && c.calls.length));
        // Default selection
        if (!this.commsState.activeContactKey && commsContacts.length) {
            this.commsState.activeContactKey = commsContacts[0].key;
        }
        // If the active contact has no comms (e.g., picked from Subject view's
        // All Contacts list), keep it but synthesize a bucket from idx.byKey.
        const active = idx.byKey[this.commsState.activeContactKey] || commsContacts[0] || null;
        const search = this.commsState.search || '';
        const filter = this.commsState.dirFilter || 'all';
        const dh = this.commsState.dayHourFilter;
        const dateFilter = this.commsState.dateFilter;

        // Filter contact list by search (only against the comms-only set)
        const railFiltered = commsContacts.filter(c => {
            if (!search) return true;
            const s = search.toLowerCase();
            return (c.name || '').toLowerCase().includes(s)
                || (c.displayNumber || '').toLowerCase().includes(s)
                || (c.phones || []).some(p => p.toLowerCase().includes(s));
        });

        return `
            <div class="dp-comms">
                <div class="dp-comms-rail">
                    <div class="dp-rail-search">
                        <input type="text" class="dp-search" id="dp-comms-search" placeholder="Search contacts/numbers" value="${this._esc(search)}">
                        <div class="dp-rail-count">${railFiltered.length} of ${commsContacts.length}</div>
                    </div>
                    <div class="dp-rail-list" id="dp-rail-list">
                        ${railFiltered.length === 0 ? `<div class="dp-empty-inline">No contacts match.</div>` : railFiltered.map(c => `
                            <div class="dp-rail-row ${active && active.key === c.key ? 'active' : ''}" data-dp-rail="${this._esc(c.key)}">
                                <div class="dp-rail-name">${this._esc(c.name || '(unknown)')}</div>
                                <div class="dp-rail-num">${this._esc(c.displayNumber)}</div>
                                <div class="dp-rail-meta">
                                    <span title="messages">💬 ${c.msgs.length}</span>
                                    <span title="calls">📞 ${c.calls.length}</span>
                                    ${c.lastDate ? `<span class="dp-rail-date">${this._esc(c.lastDate)}</span>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="dp-comms-thread">
                    ${active ? this._renderCommsThread(imp, active, idx, filter, dh, dateFilter) : `<div class="dp-empty-inline">Select a contact.</div>`}
                </div>
            </div>
        `;
    }

    _renderCommsThread(imp, active, idx, filter, dayHour, dateFilter) {
        // Build unified event list (msgs + calls) for active contact
        let events = [];
        for (const m of active.msgs) {
            events.push({
                kind: 'msg', uid: m.uid,
                dir: m.direction,
                date: m.timestampIso || m.timestamp,
                dateRaw: m.timestamp,
                text: m.text || '',
                meta: m.type
            });
        }
        for (const c of active.calls) {
            events.push({
                kind: 'call', uid: `call_${c.no}`,
                dir: c.direction || 'unknown',
                date: c.timestampIso || c.timestamp || '',
                dateRaw: c.timestamp || '',
                text: c.summary || c.deletedData || '(carved fragment)',
                meta: c.duration ? `${c.duration}s` : 'fragment'
            });
        }
        events.sort((a, b) => {
            const da = a.date ? new Date(a.date).getTime() : 0;
            const db = b.date ? new Date(b.date).getTime() : 0;
            return db - da;
        });

        // Apply direction filter
        if (filter === 'sent') events = events.filter(e => e.dir === 'outgoing');
        else if (filter === 'received') events = events.filter(e => e.dir === 'incoming');
        else if (filter === 'calls') events = events.filter(e => e.kind === 'call');

        // Apply day-hour bucket filter
        if (dayHour) {
            events = events.filter(e => {
                if (!e.date) return false;
                const d = new Date(e.date);
                return !isNaN(d) && d.getDay() === dayHour.day && d.getHours() === dayHour.hour;
            });
        }
        if (dateFilter) {
            events = events.filter(e => (e.date || '').startsWith(dateFilter));
        }

        // Group by date for separators
        const groups = [];
        let currentDate = null;
        for (const ev of events) {
            const dKey = (ev.date || '').split('T')[0] || 'Unknown';
            if (dKey !== currentDate) {
                groups.push({ date: dKey, items: [] });
                currentDate = dKey;
            }
            groups[groups.length - 1].items.push(ev);
        }

        const sentN = active.msgs.filter(m => m.direction === 'outgoing').length;
        const recvN = active.msgs.filter(m => m.direction === 'incoming').length;
        const totalEvents = active.msgs.length + active.calls.length;
        const filterActive = !!(dayHour || dateFilter || (filter && filter !== 'all'));
        const visibleEvents = events.length;
        const filterChip = (dayHour || dateFilter) ? `
            <div class="dp-filter-chip">
                Filter:
                ${dayHour ? `<strong>${this._dayName(dayHour.day)} ${String(dayHour.hour).padStart(2,'0')}:00</strong>` : ''}
                ${dateFilter ? `<strong>${this._esc(dateFilter)}</strong>` : ''}
                <button class="dp-chip-x" id="dp-clear-bucket" title="Clear filter">×</button>
            </div>
        ` : '';

        return `
            <div class="dp-thread-head">
                <div class="dp-thread-name">
                    <strong>${this._esc(active.name || '(unknown)')}</strong>
                    <span class="dp-mono">${this._esc(active.displayNumber)}</span>
                </div>
                <div class="dp-thread-stats">
                    <span>${sentN} sent</span>
                    <span>${recvN} received</span>
                    <span>${active.calls.length} calls</span>
                    ${filterActive && visibleEvents !== totalEvents
                        ? `<span class="dp-thread-filtered">showing ${visibleEvents} of ${totalEvents}</span>`
                        : ''}
                </div>
                <div class="dp-thread-filters">
                    <button class="dp-pill-btn ${filter === 'all' ? 'on' : ''}" data-dp-dirfilter="all">All</button>
                    <button class="dp-pill-btn ${filter === 'sent' ? 'on' : ''}" data-dp-dirfilter="sent">Sent</button>
                    <button class="dp-pill-btn ${filter === 'received' ? 'on' : ''}" data-dp-dirfilter="received">Received</button>
                    <button class="dp-pill-btn ${filter === 'calls' ? 'on' : ''}" data-dp-dirfilter="calls">Calls</button>
                </div>
                ${filterChip}
            </div>
            <div class="dp-thread-body" id="dp-thread-body">
                ${events.length === 0 ? `<div class="dp-empty-inline">No items match these filters.</div>` : groups.map(g => `
                    <div class="dp-date-sep">${this._esc(this._friendlyDate(g.date))}</div>
                    ${g.items.map(ev => this._renderThreadEvent(ev)).join('')}
                `).join('')}
            </div>
        `;
    }

    _renderThreadEvent(ev) {
        const time = ev.date ? this._timeOnly(ev.date) : '';
        const dirClass = ev.dir === 'outgoing' ? 'out' : (ev.dir === 'incoming' ? 'in' : 'unk');
        if (ev.kind === 'msg') {
            const flagged = this.module.isFlagged('messages', ev.uid);
            return `
                <div class="dp-msg dp-msg-${dirClass} ${flagged ? 'flagged' : ''}">
                    <div class="dp-msg-bubble">
                        <div class="dp-msg-text">${this._esc(ev.text) || '<em>(empty)</em>'}</div>
                        <div class="dp-msg-foot">
                            <span class="dp-msg-time">${this._esc(time)}</span>
                            ${ev.meta ? `<span class="dp-msg-meta">${this._esc(ev.meta)}</span>` : ''}
                            <button class="dp-flag-btn" data-dp-flag="messages" data-dp-key="${this._esc(ev.uid)}" title="Flag this message">${flagged ? '🚩' : '⚐'}</button>
                        </div>
                    </div>
                </div>
            `;
        }
        // call
        const icon = ev.dir === 'outgoing' ? '📤📞' : (ev.dir === 'incoming' ? '📥📞' : '📞');
        const flagged = this.module.isFlagged('calls', ev.uid.replace('call_', ''));
        return `
            <div class="dp-call-event dp-msg-${dirClass}">
                <div class="dp-call-icon">${icon}</div>
                <div class="dp-call-body">
                    <div class="dp-call-text">${this._esc(ev.text)}</div>
                    <div class="dp-call-foot">
                        <span class="dp-msg-time">${this._esc(time)}</span>
                        <span class="dp-msg-meta">${this._esc(ev.meta)}</span>
                        <button class="dp-flag-btn" data-dp-flag="calls" data-dp-key="${this._esc(ev.uid.replace('call_', ''))}">${flagged ? '🚩' : '⚐'}</button>
                    </div>
                </div>
            </div>
        `;
    }

    _wireComms(root) {
        const search = root.querySelector('#dp-comms-search');
        if (search) {
            let t;
            search.oninput = (e) => {
                clearTimeout(t);
                this.commsState.search = e.target.value;
                t = setTimeout(() => this.module.render(), 180);
            };
        }
        root.querySelectorAll('[data-dp-rail]').forEach(row => {
            row.onclick = () => {
                const newKey = row.dataset.dpRail;
                // Clicking a different contact: clear any sticky drilldown
                // filters from analytics (day-hour bucket, single-date) so the
                // full conversation is visible by default. Direction filter is
                // a deliberate user choice — leave it alone.
                if (newKey !== this.commsState.activeContactKey) {
                    this.commsState.dayHourFilter = null;
                    this.commsState.dateFilter = null;
                }
                this.commsState.activeContactKey = newKey;
                this.module.render();
            };
        });
        root.querySelectorAll('[data-dp-dirfilter]').forEach(btn => {
            btn.onclick = () => {
                this.commsState.dirFilter = btn.dataset.dpDirfilter;
                this.module.render();
            };
        });
        const clear = root.querySelector('#dp-clear-bucket');
        if (clear) clear.onclick = () => { this.commsState.dayHourFilter = null; this.commsState.dateFilter = null; this.module.render(); };
        this._wireFlagButtons(root);
    }

    /** Build per-contact index keyed by normalized phone or contact-id. */
    _buildContactIndex(imp) {
        if (this._contactIndexCache) return this._contactIndexCache;
        const contacts = imp.contacts || [];
        const messages = imp.messages || [];
        const calls = imp.calls || [];
        const phoneToContact = new Map();
        for (const c of contacts) {
            for (const p of (c.phones || [])) {
                const key = this._normalizePhone(p);
                if (key) phoneToContact.set(key, c);
            }
        }
        const buckets = new Map();
        const ensureBucket = (rawAddr) => {
            const key = this._normalizePhone(rawAddr) || (rawAddr || 'unknown').toLowerCase();
            if (!buckets.has(key)) {
                const c = phoneToContact.get(key);
                buckets.set(key, {
                    key,
                    name: c ? c.name : '',
                    phones: c ? c.phones : (rawAddr ? [rawAddr] : []),
                    displayNumber: rawAddr || (c && c.phones && c.phones[0]) || '',
                    msgs: [], calls: [], lastDateIso: '', lastDate: ''
                });
            }
            return buckets.get(key);
        };
        for (const m of messages) {
            const b = ensureBucket(m.address);
            b.msgs.push(m);
            const iso = m.timestampIso || '';
            if (iso && iso > b.lastDateIso) { b.lastDateIso = iso; b.lastDate = iso.split('T')[0]; }
        }
        for (const c of calls) {
            const addr = c.address || c.number || '';
            const b = ensureBucket(addr);
            b.calls.push(c);
            const iso = c.timestampIso || '';
            if (iso && iso > b.lastDateIso) { b.lastDateIso = iso; b.lastDate = iso.split('T')[0]; }
        }
        // Also include contacts with no comms (so investigator can browse)
        for (const c of contacts) {
            const phones = c.phones || [];
            if (!phones.length) {
                const key = `noscope_${c.no}`;
                if (!buckets.has(key)) {
                    buckets.set(key, { key, name: c.name, phones: [], displayNumber: '(no number)', msgs: [], calls: [], lastDateIso: '', lastDate: '' });
                }
                continue;
            }
            for (const p of phones) {
                ensureBucket(p);
            }
        }
        const out = Array.from(buckets.values()).sort((a, b) => {
            // Sort by recent activity, then by total volume
            if (a.lastDateIso && b.lastDateIso && a.lastDateIso !== b.lastDateIso) return b.lastDateIso.localeCompare(a.lastDateIso);
            if (a.lastDateIso && !b.lastDateIso) return -1;
            if (!a.lastDateIso && b.lastDateIso) return 1;
            return (b.msgs.length + b.calls.length) - (a.msgs.length + a.calls.length);
        });
        const byKey = {};
        for (const c of out) byKey[c.key] = c;
        this._contactIndexCache = { contacts: out, byKey };
        return this._contactIndexCache;
    }

    _normalizePhone(p) {
        if (!p) return '';
        const digits = String(p).replace(/[^\d+]/g, '');
        if (!digits) return '';
        // Strip leading + then take last 10 digits as the matching key
        const stripped = digits.replace(/\D/g, '');
        return stripped.length >= 10 ? stripped.slice(-10) : stripped;
    }

    // ════════════════════════ MOVEMENT VIEW ════════════════════════

    _renderMovement(imp) {
        const pts = this._gpsPoints(imp);
        const photos = (imp.media || []).filter(m => m.mediaType === 'photo' || m.mediaType === 'thumbnail');
        const datedPoints = pts.map(p => {
            const exif = imp.photoExifByHash[p.exifHash] || {};
            const photo = photos.find(ph => {
                if (!ph) return false;
                if ((ph.exifHash || '') === p.exifHash) return true;
                if (ph.sha256 && ph.sha256.toLowerCase() === p.exifHash) return true;
                if (ph.sha3 && ph.sha3.toLowerCase() === p.exifHash) return true;
                return false;
            });
            return {
                ...p,
                date: exif.dateTimeIso || exif.dateTime || '',
                dateMs: exif.dateTimeIso ? new Date(exif.dateTimeIso).getTime() : (exif.dateTime ? new Date(exif.dateTime).getTime() : 0),
                photo,
                exif
            };
        }).filter(p => p.dateMs > 0).sort((a, b) => a.dateMs - b.dateMs);

        if (datedPoints.length === 0 && pts.length === 0) {
            return `
                <div class="dp-movement-empty">
                    <div class="dp-empty-icon">🗺️</div>
                    <h3>No GPS data found in this export</h3>
                    <p class="dp-empty-help">No EXIF GPS coordinates were extracted from photos in this Datapilot folder.</p>
                </div>
            `;
        }

        const minMs = datedPoints.length ? datedPoints[0].dateMs : Date.now() - 7 * 86400000;
        const maxMs = datedPoints.length ? datedPoints[datedPoints.length - 1].dateMs : Date.now();
        if (this.movementState.from == null) this.movementState.from = minMs;
        if (this.movementState.to   == null) this.movementState.to   = maxMs;

        const inRange = datedPoints.filter(p => p.dateMs >= this.movementState.from && p.dateMs <= this.movementState.to);

        return `
            <div class="dp-movement">
                <div class="dp-movement-toolbar">
                    <div class="dp-toolbar-info">
                        <strong>${inRange.length}</strong> of ${datedPoints.length + Math.max(0, pts.length - datedPoints.length)} location points in selected range
                    </div>
                    <div class="dp-toolbar-actions">
                        <button class="dp-pill-btn ${this.movementState.mode === 'both' ? 'on' : ''}" data-dp-mode="both">GPS + Photos</button>
                        <button class="dp-pill-btn ${this.movementState.mode === 'gps' ? 'on' : ''}" data-dp-mode="gps">GPS only</button>
                        <button class="dp-pill-btn ${this.movementState.mode === 'photos' ? 'on' : ''}" data-dp-mode="photos">Photos only</button>
                        <button class="dp-btn dp-btn-secondary" id="dp-event-pin">📌 ${this.movementState.eventPin ? 'Clear pin' : 'Drop event pin'}</button>
                        <button class="dp-btn dp-btn-secondary" id="dp-mv-reset">Reset Range</button>
                    </div>
                </div>
                <div class="dp-mv-map" id="dp-mv-map"></div>
                <div class="dp-mv-scrubber">
                    <div class="dp-mv-scrubber-labels">
                        <span class="dp-mono">${this._formatRangeStamp(minMs)}</span>
                        <span class="dp-scrubber-current">${this._formatRangeStamp(this.movementState.from)} → ${this._formatRangeStamp(this.movementState.to)}</span>
                        <span class="dp-mono">${this._formatRangeStamp(maxMs)}</span>
                    </div>
                    <div class="dp-mv-track" id="dp-mv-track" data-min="${minMs}" data-max="${maxMs}">
                        <div class="dp-mv-fill"></div>
                        ${datedPoints.map(p => `<span class="dp-mv-tick" style="left:${(((p.dateMs - minMs) / Math.max(1, maxMs - minMs)) * 100).toFixed(2)}%"></span>`).join('')}
                        <div class="dp-mv-handle dp-mv-handle-from" data-dp-handle="from" style="left:${(((this.movementState.from - minMs) / Math.max(1, maxMs - minMs)) * 100).toFixed(2)}%"></div>
                        <div class="dp-mv-handle dp-mv-handle-to" data-dp-handle="to" style="left:${(((this.movementState.to - minMs) / Math.max(1, maxMs - minMs)) * 100).toFixed(2)}%"></div>
                    </div>
                </div>
                <div class="dp-mv-bottom">
                    <div class="dp-mv-strip" id="dp-mv-strip">
                        <div class="dp-card-title">Photos in range (${inRange.length})</div>
                        <div class="dp-mv-strip-list">
                            ${inRange.slice(0, 40).map(p => `
                                <div class="dp-mv-strip-card" data-dp-mv-photo="${p.exifHash}">
                                    <div class="dp-mv-strip-img" data-thumbnail-path="${this._esc(p.photo ? p.photo.previewPath || p.photo.fileSystemPath : '')}">
                                        <span class="dp-thumb-placeholder">🖼️</span>
                                    </div>
                                    <div class="dp-mv-strip-meta">
                                        <div class="dp-mv-strip-date">${this._esc(this._friendlyDate(p.date.split ? p.date.split('T')[0] : '')) }</div>
                                        <div class="dp-mono dp-truncate">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</div>
                                    </div>
                                </div>
                            `).join('')}
                            ${inRange.length === 0 ? `<div class="dp-empty-inline">No GPS-bearing photos in selected window.</div>` : ''}
                        </div>
                    </div>
                    <div class="dp-mv-clusters">
                        <div class="dp-card-title">Top Locations in Range</div>
                        ${this._renderClusterList(inRange)}
                    </div>
                </div>
            </div>
        `;
    }

    _renderClusterList(points) {
        if (points.length === 0) return `<div class="dp-empty-inline">No data in range.</div>`;
        const used = new Array(points.length).fill(false);
        const clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (used[i]) continue;
            const c = { lat: points[i].lat, lng: points[i].lng, items: [points[i]] };
            used[i] = true;
            for (let j = i + 1; j < points.length; j++) {
                if (used[j]) continue;
                if (this._haversineKm(c.lat, c.lng, points[j].lat, points[j].lng) <= 0.5) {
                    c.items.push(points[j]);
                    used[j] = true;
                }
            }
            clusters.push(c);
        }
        clusters.sort((a, b) => b.items.length - a.items.length);
        return clusters.slice(0, 8).map(c => {
            const lat = c.items.reduce((a, p) => a + p.lat, 0) / c.items.length;
            const lng = c.items.reduce((a, p) => a + p.lng, 0) / c.items.length;
            const dates = c.items.map(p => p.date).filter(Boolean).sort();
            return `
                <div class="dp-cluster-row" data-dp-cluster-lat="${lat.toFixed(6)}" data-dp-cluster-lng="${lng.toFixed(6)}">
                    <div class="dp-cluster-rank">${c.items.length}</div>
                    <div class="dp-cluster-info">
                        <div class="dp-mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
                        <div class="dp-card-sub">${dates[0] ? this._friendlyDate(dates[0].split('T')[0]) : '?'} → ${dates[dates.length - 1] ? this._friendlyDate(dates[dates.length - 1].split('T')[0]) : '?'}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    _wireMovement(root) {
        const imp = this.module.getActiveImport();
        if (!imp) return;

        // Mode pills
        root.querySelectorAll('[data-dp-mode]').forEach(b => {
            b.onclick = () => { this.movementState.mode = b.dataset.dpMode; this.module.render(); };
        });
        const reset = root.querySelector('#dp-mv-reset');
        if (reset) reset.onclick = () => { this.movementState.from = null; this.movementState.to = null; this.module.render(); };

        // Scrubber drag
        const track = root.querySelector('#dp-mv-track');
        if (track) {
            const minMs = Number(track.dataset.min); const maxMs = Number(track.dataset.max);
            let dragHandle = null;
            const onMove = (clientX) => {
                if (!dragHandle) return;
                const rect = track.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const ms = minMs + pct * (maxMs - minMs);
                if (dragHandle === 'from') {
                    this.movementState.from = Math.min(ms, this.movementState.to);
                } else {
                    this.movementState.to = Math.max(ms, this.movementState.from);
                }
                // Live update labels without re-render (smooth)
                const cur = root.querySelector('.dp-scrubber-current');
                if (cur) cur.textContent = `${this._formatRangeStamp(this.movementState.from)} → ${this._formatRangeStamp(this.movementState.to)}`;
                const fromH = root.querySelector('.dp-mv-handle-from');
                const toH = root.querySelector('.dp-mv-handle-to');
                if (fromH) fromH.style.left = `${(((this.movementState.from - minMs) / Math.max(1, maxMs - minMs)) * 100).toFixed(2)}%`;
                if (toH)   toH.style.left   = `${(((this.movementState.to   - minMs) / Math.max(1, maxMs - minMs)) * 100).toFixed(2)}%`;
            };
            const onUp = () => {
                if (dragHandle) {
                    dragHandle = null;
                    document.removeEventListener('mousemove', mm);
                    document.removeEventListener('mouseup', onUp);
                    this.module.render();
                }
            };
            const mm = (e) => onMove(e.clientX);
            track.querySelectorAll('[data-dp-handle]').forEach(h => {
                h.onmousedown = (e) => {
                    dragHandle = h.dataset.dpHandle;
                    e.preventDefault();
                    document.addEventListener('mousemove', mm);
                    document.addEventListener('mouseup', onUp);
                };
            });
        }

        // Event pin button
        const pinBtn = root.querySelector('#dp-event-pin');
        if (pinBtn) pinBtn.onclick = () => {
            if (this.movementState.eventPin) {
                this.movementState.eventPin = null;
                this.module.render();
                return;
            }
            const v = prompt('Drop event pin (lat, lng, label)\nExample: 34.0522, -118.2437, Crime Scene', '34.0, -118.0, Event');
            if (!v) return;
            const parts = v.split(',').map(s => s.trim());
            const lat = parseFloat(parts[0]); const lng = parseFloat(parts[1]); const label = parts.slice(2).join(',') || 'Event';
            if (isNaN(lat) || isNaN(lng)) { alert('Invalid coordinates'); return; }
            this.movementState.eventPin = { lat, lng, label };
            this.module.render();
        };

        // Cluster click → focus map
        root.querySelectorAll('[data-dp-cluster-lat]').forEach(r => {
            r.onclick = () => {
                const lat = parseFloat(r.dataset.dpClusterLat);
                const lng = parseFloat(r.dataset.dpClusterLng);
                this._mvMapInstance && this._mvMapInstance.setView([lat, lng], 16);
            };
        });

        // Photo strip click → lightbox
        root.querySelectorAll('[data-dp-mv-photo]').forEach(c => {
            c.onclick = () => {
                const hash = c.dataset.dpMvPhoto;
                const photo = (imp.media || []).find(m => {
                    if (!m) return false;
                    if (m.exifHash === hash) return true;
                    if (m.sha256 && m.sha256.toLowerCase() === hash) return true;
                    if (m.sha3 && m.sha3.toLowerCase() === hash) return true;
                    return false;
                });
                if (photo) this._openMediaLightbox(photo);
            };
        });

        // Build map
        this._buildMovementMap(root, imp);
        // Hydrate strip thumbs
        this._hydrateThumbnails(root);
    }

    _buildMovementMap(root, imp) {
        const mapEl = root.querySelector('#dp-mv-map');
        if (!mapEl || typeof L === 'undefined') return;
        const pts = this._gpsPoints(imp);
        const datedPoints = pts.map(p => {
            const exif = imp.photoExifByHash[p.exifHash] || {};
            return { ...p, dateMs: exif.dateTimeIso ? new Date(exif.dateTimeIso).getTime() : 0, exif };
        });
        const inRange = datedPoints.filter(p => p.dateMs === 0 || (p.dateMs >= this.movementState.from && p.dateMs <= this.movementState.to));
        if (inRange.length === 0) {
            mapEl.innerHTML = `<div class="dp-empty-inline">No points in selected range.</div>`;
            return;
        }
        // Cleanup previous instance
        if (this._mvMapInstance) {
            try { this._mvMapInstance.remove(); } catch (e) {}
            this._mvMapInstance = null;
        }
        mapEl.innerHTML = '';
        const map = L.map(mapEl, { zoomControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 19
        }).addTo(map);
        const bounds = [];
        const cluster = (typeof L.markerClusterGroup === 'function') ? L.markerClusterGroup() : null;
        for (const p of inRange) {
            // exifHash is the EXIF CSV's filename, which equals the file's SHA.
            // Some CSV exports populate `exifHash` on media rows; others don't,
            // even though the SHA is the same as sha256/sha3. Try all three.
            const photoMeta = imp.media.find(x => {
                if (!x) return false;
                if (x.exifHash && x.exifHash === p.exifHash) return true;
                if (x.sha256 && x.sha256.toLowerCase() === p.exifHash) return true;
                if (x.sha3 && x.sha3.toLowerCase() === p.exifHash) return true;
                return false;
            });
            const m = L.marker([p.lat, p.lng]);
            const dateLabel = p.exif.dateTimeIso ? this._friendlyDate(p.exif.dateTimeIso.split('T')[0]) + ' ' + this._timeOnly(p.exif.dateTimeIso) : '';
            const photoId = photoMeta ? (photoMeta.sha256 || `media_${photoMeta.no}`) : '';
            // Click-toggled popup with an actual "View Photo" button. Popups
            // (unlike tooltips) stay open until dismissed, so the user has
            // time to move the cursor to the button.
            const popupHtml = `
                <div style="min-width:220px;color:#e5e7eb">
                    <div style="font-weight:600;margin-bottom:4px">${this._esc(photoMeta ? photoMeta.fileName : 'GPS Point (no source file)')}</div>
                    <div style="font-family:monospace;font-size:10px;color:#94a3b8">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
                    ${dateLabel ? `<div style="font-size:10px;color:#94a3b8;margin-bottom:8px">${this._esc(dateLabel)}</div>` : '<div style="margin-bottom:8px"></div>'}
                    ${photoMeta
                        ? `<button data-dp-popup-photo="${this._esc(photoId)}" style="width:100%;background:#22d3ee;color:#001318;border:none;padding:6px 10px;border-radius:5px;font-weight:600;cursor:pointer;font-size:12px">📷 View Photo</button>`
                        : `<div style="font-size:11px;color:#fbbf24;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:4px;padding:6px;line-height:1.4">EXIF GPS without matching media file in this export.</div>`
                    }
                </div>
            `;
            m.bindPopup(popupHtml, { closeButton: true, autoClose: false, closeOnClick: false });
            // When the popup opens, wire the button (Leaflet swaps DOM each open).
            m.on('popupopen', (ev) => {
                const root = ev.popup.getElement();
                if (!root) return;
                const btn = root.querySelector(`[data-dp-popup-photo="${photoId}"]`);
                if (btn) btn.onclick = () => {
                    if (photoMeta) this._openMediaLightbox(photoMeta);
                };
            });
            if (cluster) cluster.addLayer(m); else m.addTo(map);
            bounds.push([p.lat, p.lng]);
        }
        if (cluster) map.addLayer(cluster);

        if (this.movementState.eventPin) {
            const ep = this.movementState.eventPin;
            const eventIcon = L.divIcon({
                html: `<div style="background:#ff4d6d;color:white;padding:6px 10px;border-radius:6px;border:2px solid white;font-weight:bold;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5)">📌 ${this._esc(ep.label)}</div>`,
                className: '',
                iconSize: null
            });
            L.marker([ep.lat, ep.lng], { icon: eventIcon, zIndexOffset: 1000 }).addTo(map);
            bounds.push([ep.lat, ep.lng]);
        }

        if (this.movementState.focusLat != null && this.movementState.focusLng != null) {
            map.setView([this.movementState.focusLat, this.movementState.focusLng], 15);
            this.movementState.focusLat = null;
            this.movementState.focusLng = null;
        } else if (bounds.length === 1) {
            map.setView(bounds[0], 15);
        } else if (bounds.length > 1) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }

        this._mvMapInstance = map;
        // Force resize after layout settles
        setTimeout(() => map.invalidateSize(), 100);
    }

    // ════════════════════════ ARTIFACTS VIEW ════════════════════════

    _renderArtifacts(imp) {
        const items = this._allArtifacts(imp);
        const counts = this._facetCounts(items);
        const filtered = this._applyArtifactFilters(items);

        return `
            <div class="dp-artifacts">
                <div class="dp-art-facets">
                    <div class="dp-art-search-box">
                        <input type="text" class="dp-search" id="dp-art-search" placeholder="Search filename, app id, hash" value="${this._esc(this.artifactsState.search)}">
                    </div>
                    <div class="dp-facet-group">
                        <div class="dp-facet-label">Type</div>
                        ${this._facetRow('All types', null, counts.total, !this.artifactsState.type, 'type')}
                        ${this._facetRow('🖼 Photos', 'photo', counts.photo, this.artifactsState.type === 'photo', 'type')}
                        ${this._facetRow('🎬 Videos', 'video', counts.video, this.artifactsState.type === 'video', 'type')}
                        ${this._facetRow('🔊 Audio', 'audio', counts.audio, this.artifactsState.type === 'audio', 'type')}
                        ${this._facetRow('📄 Documents', 'document', counts.document, this.artifactsState.type === 'document', 'type')}
                        ${this._facetRow('🗄 Databases', 'database', counts.database, this.artifactsState.type === 'database', 'type')}
                        ${this._facetRow('🗜 Compressed', 'compressed', counts.compressed, this.artifactsState.type === 'compressed', 'type')}
                        ${this._facetRow('📦 Apps', 'app', counts.app, this.artifactsState.type === 'app', 'type')}
                        ${this._facetRow('📁 Other Files', 'other', counts.other, this.artifactsState.type === 'other', 'type')}
                    </div>
                    <div class="dp-facet-group">
                        <div class="dp-facet-label">Source</div>
                        ${this._facetRow('Any source', null, counts.total, !this.artifactsState.source, 'source')}
                        ${this._facetRow('Present on device', 'present', counts.present, this.artifactsState.source === 'present', 'source')}
                        ${this._facetRow('Deleted / carved', 'deleted', counts.deleted, this.artifactsState.source === 'deleted', 'source')}
                    </div>
                    <div class="dp-facet-group">
                        <div class="dp-facet-label">Properties</div>
                        ${this._facetToggle('🌍 Has GPS', counts.hasGps, this.artifactsState.hasGps, 'hasGps')}
                        ${this._facetToggle('🚩 Flagged only', counts.flagged, this.artifactsState.flaggedOnly, 'flaggedOnly')}
                    </div>
                </div>
                <div class="dp-art-results" id="dp-art-results">
                    <div class="dp-art-result-head">
                        <strong>${filtered.length}</strong> ${filtered.length === 1 ? 'item' : 'items'}
                        <button class="dp-btn dp-btn-link" id="dp-art-clear">Clear filters</button>
                    </div>
                    <div class="dp-art-grid" id="dp-art-grid">
                        ${filtered.length === 0 ? `<div class="dp-empty-inline">No artifacts match these filters.</div>` :
                            filtered.slice(0, 300).map(it => this._renderArtifactCard(it)).join('')
                        }
                        ${filtered.length > 300 ? `<div class="dp-card-sub" style="grid-column:1/-1;text-align:center;padding:12px">Showing first 300 of ${filtered.length} — refine filters to narrow.</div>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    _allArtifacts(imp) {
        if (this._allArtifactsCache) return this._allArtifactsCache;
        const out = [];
        for (const m of (imp.media || [])) {
            const exif = m.exifHash ? imp.photoExifByHash[m.exifHash] : null;
            const hasGps = !!(exif && exif.gps && typeof exif.gps.lat === 'number');
            // Only photos / thumbnails get an inline preview path. Videos and audio
            // would require decoding the full media file as base64 (huge / slow),
            // so they show their type icon and play in the lightbox on Open.
            const inlinePreview = (m.mediaType === 'photo' || m.mediaType === 'thumbnail')
                ? (m.previewPath || m.fileSystemPath || '')
                : '';
            // For videos: pass the source path so we can lazily generate
            // first-frame thumbnails via canvas after the card mounts.
            const videoSrc = m.mediaType === 'video' ? (m.fileSystemPath || '') : '';
            out.push({
                kind: 'media',
                type: m.mediaType === 'thumbnail' ? 'photo' : m.mediaType,
                id: m.sha256 || `media_${m.no}`,
                flagSection: 'media',
                flagKey: m.sha256 || String(m.no),
                name: m.fileName,
                meta: m.lastModified || '',
                size: m.sizeBytes || 0,
                source: 'present',
                hasGps,
                lat: hasGps ? exif.gps.lat : null,
                lng: hasGps ? exif.gps.lng : null,
                thumbnail: inlinePreview,
                videoSrc,
                ref: m
            });
        }
        for (const f of (imp.files || [])) {
            const isDoc = /\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv)$/i.test(f.fileName);
            const type = f.kind === 'database' ? 'database' :
                         f.kind === 'compressed' ? 'compressed' :
                         f.kind === 'text' ? 'document' :
                         (isDoc ? 'document' : 'other');
            out.push({
                kind: 'file',
                type,
                id: f.sha256 || `file_${f.no}`,
                flagSection: 'files',
                flagKey: f.sha256 || String(f.no),
                name: f.fileName,
                meta: f.lastModified || '',
                size: f.sizeBytes || 0,
                source: 'present',
                hasGps: false,
                thumbnail: '',
                ref: f
            });
        }
        for (const a of (imp.apps || [])) {
            out.push({
                kind: 'app',
                type: 'app',
                id: a.appId || `app_${a.no}`,
                flagSection: 'apps',
                flagKey: String(a.no),
                name: a.displayName || a.appId,
                meta: a.appId,
                size: 0,
                source: 'present',
                isPrivate: a.isPrivate,
                version: a.version,
                hasGps: false,
                thumbnail: '',
                ref: a
            });
        }
        for (const d of (imp.deleted || [])) {
            out.push({
                kind: 'deleted',
                type: 'other',
                id: `del_${d.no}`,
                flagSection: 'files',
                flagKey: `deleted_${d.no}`,
                name: d.label || `Deleted record ${d.no}`,
                meta: d.info || '',
                size: 0,
                source: 'deleted',
                hasGps: false,
                thumbnail: '',
                ref: d
            });
        }
        this._allArtifactsCache = out;
        return out;
    }

    _facetCounts(items) {
        const c = { total: items.length, photo: 0, video: 0, audio: 0, document: 0, database: 0, compressed: 0, app: 0, other: 0, present: 0, deleted: 0, hasGps: 0, flagged: 0 };
        const imp = this.module.getActiveImport();
        const flagged = imp && imp.flagged ? imp.flagged : {};
        for (const it of items) {
            if (c[it.type] != null) c[it.type]++;
            else c.other++;
            if (it.source === 'deleted') c.deleted++; else c.present++;
            if (it.hasGps) c.hasGps++;
            const f = flagged[it.flagSection] || [];
            if (f.includes(it.flagKey)) c.flagged++;
        }
        return c;
    }

    _applyArtifactFilters(items) {
        const s = this.artifactsState;
        const q = (s.search || '').toLowerCase();
        const imp = this.module.getActiveImport();
        const flagged = imp && imp.flagged ? imp.flagged : {};
        return items.filter(it => {
            if (s.type && it.type !== s.type) return false;
            if (s.source && it.source !== s.source) return false;
            if (s.hasGps && !it.hasGps) return false;
            if (s.flaggedOnly) {
                const f = flagged[it.flagSection] || [];
                if (!f.includes(it.flagKey)) return false;
            }
            if (q) {
                const hay = `${it.name} ${it.meta || ''} ${it.id || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }

    _facetRow(label, value, count, active, group) {
        return `
            <div class="dp-facet-row ${active ? 'active' : ''}" data-dp-facet="${group}" data-dp-facet-value="${value == null ? '' : this._esc(value)}">
                <span>${label}</span><span class="dp-facet-count">${count || 0}</span>
            </div>
        `;
    }

    _facetToggle(label, count, active, key) {
        return `
            <div class="dp-facet-row ${active ? 'active' : ''}" data-dp-facet-toggle="${key}">
                <span>${label}</span><span class="dp-facet-count">${count || 0}</span>
            </div>
        `;
    }

    _renderArtifactCard(it) {
        const flagged = this.module.isFlagged(it.flagSection, it.flagKey);
        const icon = it.type === 'photo' ? '🖼' : it.type === 'video' ? '🎬' : it.type === 'audio' ? '🔊'
            : it.type === 'document' ? '📄' : it.type === 'database' ? '🗄' : it.type === 'compressed' ? '🗜'
            : it.type === 'app' ? '📦' : '📁';
        const isMedia = (it.kind === 'media' && (it.type === 'photo' || it.type === 'video'));
        const isVideoCard = isMedia && it.type === 'video';
        // Inline styles with !important — guarantees layout regardless of any
        // stale cached CSS file. Card has explicit min-height so the grid row
        // can never collapse to a thin strip, and is tall enough to actually
        // show the action buttons (flag / Open) below the 180px thumb.
        const cardStyle = `style="min-height:280px !important;display:flex !important;flex-direction:column !important${isMedia ? ';cursor:pointer' : ''}"`;
        const thumbStyle = 'style="height:180px !important;min-height:180px !important;width:100% !important;display:flex !important;align-items:center !important;justify-content:center !important;background:rgba(0,0,0,0.4);overflow:hidden;position:relative;flex:0 0 180px"';
        // Videos get a distinct "film card" look so they don't render blank.
        const videoPlaceholder = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;background:linear-gradient(135deg,#1e1b4b,#0f172a);color:#a78bfa">
                <div style="font-size:48px;line-height:1">🎬</div>
                <div style="margin-top:6px;width:42px;height:42px;border-radius:50%;background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.4);display:flex;align-items:center;justify-content:center;font-size:18px;color:#e9d5ff">▶</div>
                <div style="margin-top:8px;font-size:10px;color:#cbd5e1;font-weight:500;letter-spacing:0.5px">VIDEO</div>
            </div>
        `;
        return `
            <div class="dp-art-card ${flagged ? 'flagged' : ''}" ${cardStyle} data-dp-art-id="${this._esc(it.id)}" ${isMedia ? `data-dp-card-open="${this._esc(it.id)}"` : ''}>
                <div class="dp-art-thumb" ${thumbStyle} ${isMedia && it.thumbnail ? `data-thumbnail-path="${this._esc(it.thumbnail)}"` : ''} ${isVideoCard && it.videoSrc ? `data-dp-video-thumb-id="${this._esc(it.id)}" data-dp-video-thumb-path="${this._esc(it.videoSrc)}"` : ''}>
                    ${isVideoCard
                        ? videoPlaceholder
                        : (isMedia
                            ? `<span class="dp-thumb-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;color:#4b5563;background:linear-gradient(135deg,#1e293b,#0f172a)">${icon}</span>`
                            : `<div class="dp-art-icon">${icon}</div>`)}
                    ${it.source === 'deleted' ? `<span class="dp-art-badge">DELETED</span>` : ''}
                    ${it.hasGps ? `<span class="dp-art-badge dp-art-badge-gps">GPS</span>` : ''}
                </div>
                <div class="dp-art-card-body">
                    <div class="dp-art-name dp-truncate" title="${this._esc(it.name)}">${this._esc(it.name)}</div>
                    <div class="dp-art-meta">
                        ${it.size ? this._formatBytes(it.size) + ' · ' : ''}${it.meta ? this._esc(it.meta) : ''}
                        ${it.kind === 'app' && it.version ? `<span class="dp-card-sub">v${this._esc(it.version)}${it.isPrivate ? ' · private' : ''}</span>` : ''}
                    </div>
                    <div class="dp-art-actions">
                        <button class="dp-flag-btn" data-dp-flag="${it.flagSection}" data-dp-key="${this._esc(it.flagKey)}">${flagged ? '🚩' : '⚐'}</button>
                        ${isMedia ? `<button class="dp-btn dp-btn-link dp-art-open" data-dp-open="${this._esc(it.id)}">Open</button>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    _wireArtifacts(root) {
        const search = root.querySelector('#dp-art-search');
        if (search) {
            let t;
            search.oninput = (e) => {
                clearTimeout(t);
                this.artifactsState.search = e.target.value;
                t = setTimeout(() => this.module.render(), 200);
            };
        }
        root.querySelectorAll('[data-dp-facet]').forEach(r => {
            r.onclick = () => {
                const grp = r.dataset.dpFacet;
                const v = r.dataset.dpFacetValue || null;
                this.artifactsState[grp] = (v === '' ? null : v);
                this.module.render();
            };
        });
        root.querySelectorAll('[data-dp-facet-toggle]').forEach(r => {
            r.onclick = () => {
                const k = r.dataset.dpFacetToggle;
                this.artifactsState[k] = !this.artifactsState[k];
                this.module.render();
            };
        });
        const clear = root.querySelector('#dp-art-clear');
        if (clear) clear.onclick = () => {
            this.artifactsState = { search: '', type: null, source: null, hasGps: false, flaggedOnly: false };
            this.module.render();
        };
        // Open media — both the explicit "Open" button and clicking anywhere
        // on the media card (excluding the flag button) launch the lightbox.
        root.querySelectorAll('[data-dp-open]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const imp = this.module.getActiveImport();
                const id = b.dataset.dpOpen;
                const m = (imp.media || []).find(x => (x.sha256 || `media_${x.no}`) === id);
                if (m) this._openMediaLightbox(m);
            };
        });
        root.querySelectorAll('[data-dp-card-open]').forEach(card => {
            card.onclick = (e) => {
                // Ignore clicks on inner buttons (flag, Open) — those have own handlers
                if (e.target.closest('button')) return;
                e.stopPropagation();
                const imp = this.module.getActiveImport();
                const id = card.dataset.dpCardOpen;
                const m = (imp.media || []).find(x => (x.sha256 || `media_${x.no}`) === id);
                if (m) this._openMediaLightbox(m);
            };
        });
        this._wireFlagButtons(root);
        this._hydrateThumbnails(root);
        this._hydrateVideoThumbnails(root);
    }

    // ════════════════════════ THUMBNAIL HYDRATION (fixes prior bug) ════════════════════════

    /**
     * Direct concurrent-pull approach — avoids broken IntersectionObserver
     * with custom scroll containers. Caps at 120 thumbnails per render
     * to keep memory in check.
     */
    async _hydrateThumbnails(root) {
        const cards = Array.from(root.querySelectorAll('[data-thumbnail-path]'));
        if (!cards.length) return;
        const cap = Math.min(cards.length, 120);
        let i = 0;
        const next = async () => {
            while (i < cap) {
                const idx = i++;
                const card = cards[idx];
                const p = card.dataset.thumbnailPath;
                if (!p) continue;
                try {
                    const url = await this.module.readMedia(p);
                    if (url && card.isConnected) {
                        // Inline style guarantees the image fills its 180px
                        // parent thumb regardless of any stale cached CSS.
                        card.innerHTML = `<img src="${url}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
                    }
                } catch (e) { /* ignore individual failures */ }
            }
        };
        // 4-way concurrency
        await Promise.all([next(), next(), next(), next()]);
    }

    /**
     * Lazily generate first-frame thumbnails for video cards. Datapilot
     * exports do not include video thumbnails, so we decode the first
     * frame in the renderer using a hidden <video> + <canvas>. We use
     * an IntersectionObserver to only generate thumbs for cards near
     * the viewport, and cap concurrency to 2 (video decode is heavy).
     * Results are cached in `_videoThumbCache` (id → dataURL) so
     * re-renders / scrolling back don't regenerate.
     */
    _hydrateVideoThumbnails(root) {
        if (!this._videoThumbCache) this._videoThumbCache = new Map();
        const cards = Array.from(root.querySelectorAll('[data-dp-video-thumb-path]'));
        if (!cards.length) return;

        // Apply already-cached thumbs immediately
        for (const card of cards) {
            const id = card.dataset.dpVideoThumbId;
            const cached = this._videoThumbCache.get(id);
            if (cached) {
                card.innerHTML = `<img src="${cached}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
                card.dataset.dpVideoThumbDone = '1';
            }
        }

        // Concurrency-limited generator
        const queue = cards.filter(c => !c.dataset.dpVideoThumbDone);
        if (!queue.length) return;
        let active = 0;
        const MAX_ACTIVE = 2;

        const tryGenerate = async (card) => {
            const id = card.dataset.dpVideoThumbId;
            const relPath = card.dataset.dpVideoThumbPath;
            if (!id || !relPath || card.dataset.dpVideoThumbDone) return;
            card.dataset.dpVideoThumbDone = '1';
            try {
                const url = await this.module.getMediaUrl(relPath);
                if (!url || !card.isConnected) return;
                const dataUrl = await this._captureVideoFrame(url);
                if (!dataUrl) return;
                this._videoThumbCache.set(id, dataUrl);
                if (card.isConnected) {
                    card.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
                }
            } catch (e) {
                // Leave the placeholder in place on failure
            }
        };

        const pump = () => {
            while (active < MAX_ACTIVE && queue.length) {
                const card = queue.shift();
                if (!card.isConnected) continue;
                active++;
                tryGenerate(card).finally(() => { active--; pump(); });
            }
        };

        if (typeof IntersectionObserver !== 'undefined') {
            const io = new IntersectionObserver((entries) => {
                for (const ent of entries) {
                    if (!ent.isIntersecting) continue;
                    const card = ent.target;
                    io.unobserve(card);
                    // Move this card to front of queue (prioritize visible)
                    const idx = queue.indexOf(card);
                    if (idx >= 0) {
                        queue.splice(idx, 1);
                        queue.unshift(card);
                    }
                    pump();
                }
            }, { rootMargin: '600px 0px' });
            for (const c of queue) io.observe(c);
        } else {
            pump();
        }
    }

    /**
     * Decode the first frame of a video into a small JPEG dataURL.
     * Uses a detached <video> with `preload="metadata"` and seeks to
     * 0.1s — most codecs deliver the frame within ~200-500ms.
     */
    _captureVideoFrame(videoUrl) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.src = videoUrl;
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                try { video.removeAttribute('src'); video.load(); } catch (_) {}
                resolve(val);
            };
            const TIMEOUT = 8000;
            const timer = setTimeout(() => finish(null), TIMEOUT);

            video.onloadedmetadata = () => {
                // Seek to a small offset so the first frame isn't a black/initial buffer.
                try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); }
                catch (_) { /* some codecs don't allow seeking yet */ }
            };
            video.onseeked = () => {
                try {
                    const w = video.videoWidth, h = video.videoHeight;
                    if (!w || !h) { clearTimeout(timer); return finish(null); }
                    // Cap thumbnail size at 360px wide for memory / speed
                    const maxW = 360;
                    const scale = w > maxW ? maxW / w : 1;
                    const cw = Math.max(1, Math.floor(w * scale));
                    const ch = Math.max(1, Math.floor(h * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = cw; canvas.height = ch;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, cw, ch);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                    clearTimeout(timer);
                    finish(dataUrl);
                } catch (e) {
                    clearTimeout(timer);
                    finish(null);
                }
            };
            video.onerror = () => { clearTimeout(timer); finish(null); };
        });
    }

    _openMediaLightbox(item) {
        const path = item.previewPath || item.fileSystemPath;
        const isVideo = item.mediaType === 'video';
        const isAudio = item.mediaType === 'audio';
        const overlay = document.createElement('div');
        overlay.className = 'dp-lightbox';
        overlay.innerHTML = `
            <div class="dp-lightbox-inner">
                <button class="dp-lightbox-close">×</button>
                <div class="dp-lightbox-media" id="dp-lb-media"><div class="dp-card-sub">Loading…</div></div>
                <div class="dp-lightbox-caption">
                    <div><strong>${this._esc(item.fileName || '')}</strong></div>
                    <div class="dp-card-sub">${item.sizeStr || ''} · ${this._esc(item.lastModified || '')}</div>
                </div>
            </div>
        `;
        overlay.querySelector('.dp-lightbox-close').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        document.body.appendChild(overlay);

        const m = overlay.querySelector('#dp-lb-media');
        if (isVideo || isAudio) {
            // Stream from disk — base64 round-trip would crash on large videos.
            this.module.getMediaUrl(path).then(url => {
                if (!m) return;
                if (!url) { m.innerHTML = `<div class="dp-empty-inline">Could not load media file.</div>`; return; }
                m.innerHTML = isVideo
                    ? `<video controls autoplay src="${url}" style="max-width:90vw;max-height:80vh;background:#000"></video>`
                    : `<audio controls autoplay src="${url}" style="width:60vw"></audio>`;
            });
        } else {
            // Photos/thumbnails — base64 read is fine and simpler
            this.module.readMedia(path).then(url => {
                if (!m) return;
                if (!url) { m.innerHTML = `<div class="dp-empty-inline">Could not load media file.</div>`; return; }
                m.innerHTML = `<img src="${url}" style="max-width:90vw;max-height:80vh">`;
            });
        }
    }

    // ════════════════════════ FLAG / FLAGS SUMMARY ════════════════════════

    _wireFlagButtons(root) {
        root.querySelectorAll('[data-dp-flag]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const section = b.dataset.dpFlag;
                const key = b.dataset.dpKey;
                const nowFlagged = this.module.toggleFlag(section, key);
                b.textContent = nowFlagged ? '🚩' : '⚐';
                const card = b.closest('.dp-msg, .dp-art-card, .dp-call-event');
                if (card) card.classList.toggle('flagged', nowFlagged);
                // Update flag count in header
                const cnt = document.querySelector('.dp-flag-count');
                if (cnt) cnt.textContent = String(this.module.flagCount());
            };
        });
    }

    _openFlagsSummary() {
        const imp = this.module.getActiveImport();
        if (!imp) return;
        const total = this.module.flagCount();
        if (total === 0) {
            if (typeof showToast === 'function') showToast('No items flagged yet — click 🚩 on records to flag', 'info');
            return;
        }
        if (typeof viperConfirm === 'function') {
            viperConfirm(`Push ${total} flagged item${total === 1 ? '' : 's'} to the case Evidence module as a single bundle?`, { okText: 'Push to Evidence' })
                .then(ok => { if (ok) this.module.pushFlagsToEvidence(); });
        } else {
            if (confirm(`Push ${total} flagged item(s) to Evidence?`)) this.module.pushFlagsToEvidence();
        }
    }

    _generatePdf() {
        if (typeof DatapilotReport !== 'function') {
            if (typeof showToast === 'function') showToast('Report generator not loaded', 'error');
            return;
        }
        const imp = this.module.getActiveImport();
        if (!imp) return;
        try {
            const r = new DatapilotReport(this.module, imp);
            r.generate();
        } catch (e) {
            console.error(e);
            if (typeof showToast === 'function') showToast('PDF generation failed: ' + e.message, 'error');
        }
    }

    // ════════════════════════ HELPERS ════════════════════════

    _esc(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    _formatNumber(n) { return (Number(n) || 0).toLocaleString(); }

    _formatBytes(n) {
        if (!n) return '';
        const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = Number(n);
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
    }

    _formatRangeStamp(ms) {
        const d = new Date(ms);
        if (isNaN(d)) return '';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    _friendlyDate(s) {
        if (!s) return '';
        const d = new Date(s);
        if (isNaN(d)) return s;
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    _timeOnly(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    _dayName(d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] || ''; }

    _haversineKm(la1, lo1, la2, lo2) {
        const R = 6371;
        const toRad = x => x * Math.PI / 180;
        const dLa = toRad(la2 - la1);
        const dLo = toRad(lo2 - lo1);
        const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }
}

if (typeof window !== 'undefined') {
    window.DatapilotUI = DatapilotUI;
}
