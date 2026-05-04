/**
 * Datapilot Coach — left-side drawer with analytic panels that drill BACK
 * into the main views (Subject / Comms / Movement / Artifacts) via
 * module.ui.navigateTo(view, opts).
 *
 * Panels:
 *   dashboard   high-level overview + quick-jump tiles
 *   heatmap     7×24 day-hour heatmap (click cell → Comms filtered)
 *   graph       contact link graph (click node → Comms thread)
 *   prime       top contacts ranked (click → Comms thread)
 *   geo         GPS clusters (click → Movement focused)
 *   photo       camera/software fingerprints
 *   anomalies   5 automated rules with “View” actions
 */

class DatapilotCoach {
    constructor(module) {
        this.module = module;
        this.isOpen = false;
        this.activePanel = 'dashboard';
        // In-drawer detail mode. When set, the body renders the drilled-down
        // record list inside the drawer instead of the active panel.
        // Shape: { kind: 'comms-thread'|'comms-dayhour'|'comms-date'|'geo-cluster',
        //          payload: {...}, returnPanel: <prevActivePanel> }
        this.detailContext = null;
        this._loadOpen();
    }

    // ─── public ────────────────────────────────────────────────

    toggle() { this.isOpen = !this.isOpen; this._saveOpen(); this.module.render(); }
    close()  { if (!this.isOpen) return; this.isOpen = false; this.detailContext = null; this._saveOpen(); this.module.render(); }
    openTo(panelId) {
        this.isOpen = true;
        this.activePanel = panelId || 'dashboard';
        this.detailContext = null;
        this._saveOpen();
        this.module.render();
    }

    /** Open the in-drawer detail view for a drilled-down record set. */
    showDetail(kind, payload) {
        this.detailContext = { kind, payload: payload || {}, returnPanel: this.activePanel };
        this.module.render();
    }
    /** Return from a detail view back to the active panel. */
    closeDetail() {
        if (!this.detailContext) return;
        if (this.detailContext.returnPanel) this.activePanel = this.detailContext.returnPanel;
        this.detailContext = null;
        this.module.render();
    }

    /** Used by Subject view to surface anomaly highlights. */
    runAllRules(imp) {
        const rules = [
            { id: 'baselineOutlier', title: 'Communication baseline outlier', fn: () => this._ruleBaselineOutlier(imp) },
            { id: 'newContactBurst', title: 'New-contact burst (24h window)', fn: () => this._ruleNewContactBurst(imp) },
            { id: 'deletionBurst',   title: 'Deletion / data-wipe pattern',  fn: () => this._ruleDeletionBurst(imp) },
            { id: 'locationOutlier', title: 'Location outlier (>40km)',      fn: () => this._ruleLocationOutlier(imp) },
            { id: 'appInstallBurst', title: 'App install / private-app burst', fn: () => this._ruleAppInstallBurst(imp) },
        ];
        return rules.map(r => {
            const res = r.fn() || { alerts: [] };
            const alerts = res.alerts || [];
            if (alerts.length === 0) {
                return { id: r.id, severity: 'ok', title: r.title, detail: 'No anomaly detected.', action: null };
            }
            return { id: r.id, severity: 'warn', title: r.title, detail: alerts.slice(0, 2).join(' · '), alerts, action: 'open' };
        });
    }

    // ─── render ────────────────────────────────────────────────

    render(rootEl) {
        if (!rootEl) return;
        // Remove any prior drawer node
        const prior = rootEl.querySelector('.dp-coach');
        if (prior) prior.remove();
        if (!this.isOpen) return;
        const imp = this.module.getActiveImport();
        if (!imp) return;
        const drawer = document.createElement('div');
        drawer.className = 'dp-coach open';
        const inDetail = !!this.detailContext;
        drawer.innerHTML = `
            <div class="dp-coach-header">
                <strong>💡 Insights Coach</strong>
                <button class="dp-coach-close" id="dp-coach-close">×</button>
            </div>
            <div class="dp-coach-rail">
                ${this._tabBtn('dashboard', '📊', 'Dashboard')}
                ${this._tabBtn('heatmap',   '🔥', 'Heatmap')}
                ${this._tabBtn('graph',     '🕸',  'Links')}
                ${this._tabBtn('prime',     '⭐', 'Prime')}
                ${this._tabBtn('geo',       '🌍', 'Geo')}
                ${this._tabBtn('photo',     '📷', 'Photo')}
                ${this._tabBtn('anomalies', '⚠️', 'Anomalies')}
            </div>
            ${inDetail ? this._renderDetail(imp) : `
                <div class="dp-coach-body" id="dp-coach-body">
                    ${this._renderPanel(imp)}
                </div>
            `}
        `;
        rootEl.appendChild(drawer);

        drawer.querySelector('#dp-coach-close').onclick = () => this.close();
        drawer.querySelectorAll('[data-dp-coach-tab]').forEach(b => {
            b.onclick = () => {
                this.activePanel = b.dataset.dpCoachTab;
                this.detailContext = null;  // tab switch always exits detail mode
                this.module.render();
            };
        });
        const back = drawer.querySelector('#dp-coach-detail-back');
        if (back) back.onclick = () => this.closeDetail();
        this._wireActions(drawer);
    }

    _tabBtn(id, icon, label) {
        return `
            <button class="dp-coach-rail-btn ${this.activePanel === id ? 'active' : ''}" data-dp-coach-tab="${id}">
                <span>${icon}</span><span>${label}</span>
            </button>
        `;
    }

    _renderPanel(imp) {
        switch (this.activePanel) {
            case 'dashboard':  return this._renderDashboard(imp);
            case 'heatmap':    return this._renderHeatmap(imp);
            case 'graph':      return this._renderGraph(imp);
            case 'prime':      return this._renderPrime(imp);
            case 'geo':        return this._renderGeo(imp);
            case 'photo':      return this._renderPhoto(imp);
            case 'anomalies':  return this._renderAnomalies(imp);
            default:           return this._renderDashboard(imp);
        }
    }

    /** Wire all data-dp-coach-action elements to navigateTo, panel switches, or in-drawer detail. */
    _wireActions(drawer) {
        drawer.querySelectorAll('[data-dp-coach-action]').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const a = el.dataset.dpCoachAction;
                let payload = {};
                if (el.dataset.dpCoachPayload) {
                    try { payload = JSON.parse(el.dataset.dpCoachPayload); } catch (_) {}
                }
                if (a === 'navigate') {
                    this.module.ui.navigateTo(payload.view, payload.opts || {});
                } else if (a === 'panel') {
                    this.activePanel = payload.panel;
                    this.detailContext = null;
                    this.module.render();
                } else if (a === 'detail') {
                    this.showDetail(payload.kind, payload.payload || {});
                }
            };
        });
    }

    _coachBtn(label, view, opts) {
        return `<button class="dp-btn dp-btn-link" data-dp-coach-action="navigate" data-dp-coach-payload='${this._esc(JSON.stringify({ view, opts: opts || {} }))}'>${label}</button>`;
    }

    /** Build a "detail action" attribute pair — opens drilled-down records IN the drawer. */
    _detailAttr(kind, payload) {
        return `data-dp-coach-action="detail" data-dp-coach-payload='${this._esc(JSON.stringify({ kind, payload: payload || {} }))}'`;
    }

    /** Build an "open in main view" escape-hatch button for the detail header. */
    _openMainBtn(view, opts) {
        return `<button class="dp-coach-detail-expand" data-dp-coach-action="navigate" data-dp-coach-payload='${this._esc(JSON.stringify({ view, opts: opts || {} }))}' title="Open in main view">↗ Main view</button>`;
    }

    // ─── panels ────────────────────────────────────────────────

    _renderDashboard(imp) {
        const counts = this._addressCounts(imp);
        const top3 = counts.slice(0, 3);
        const points = this._gpsPoints(imp);
        const photoDates = this._photoDates(imp);
        const ph = imp.stats ? imp.stats.photos : 0;
        const span = this._messageSpan(imp);
        const anomalyHits = this.runAllRules(imp).filter(r => r.severity !== 'ok').length;

        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-row">
                    <div class="dp-stat-num">${imp.stats.contacts || 0}</div>
                    <div class="dp-stat-label">Contacts</div>
                </div>
                <div class="dp-coach-row">
                    <div class="dp-stat-num">${imp.stats.messages || 0}</div>
                    <div class="dp-stat-label">Messages over ${span.days || 0} days</div>
                </div>
                <div class="dp-coach-row">
                    <div class="dp-stat-num">${ph || 0}</div>
                    <div class="dp-stat-label">Photos${photoDates.length ? ` · ${photoDates.length} dated` : ''}</div>
                </div>
                <div class="dp-coach-row">
                    <div class="dp-stat-num">${points.length}</div>
                    <div class="dp-stat-label">GPS-bearing items</div>
                </div>
                <div class="dp-coach-row dp-coach-row-warn">
                    <div class="dp-stat-num">${anomalyHits}</div>
                    <div class="dp-stat-label">Active anomalies — ${this._coachBtn('open', null, null).replace('navigate', 'panel').replace('"opts":{}', '"panel":"anomalies"')}</div>
                </div>

                <div class="dp-coach-section">
                    <div class="dp-coach-section-title">Top contacts</div>
                    ${top3.length === 0 ? `<div class="dp-empty-inline">No messages yet.</div>` : top3.map(c => `
                        <div class="dp-coach-row dp-coach-row-clickable" ${this._detailAttr('comms-thread', { contactKey: this._normPhone(c.address), label: c.address })}>
                            <div class="dp-mono">${this._esc(c.address)}</div>
                            <div class="dp-stat-num dp-stat-num-sm">${c.count}</div>
                        </div>
                    `).join('')}
                    ${counts.length > 3 ? `<div style="margin-top:6px">${this._coachBtn('See all in Prime panel →', null, null).replace('navigate', 'panel').replace('"opts":{}', '"panel":"prime"')}</div>` : ''}
                </div>

                <div class="dp-coach-section">
                    <div class="dp-coach-section-title">Quick jump</div>
                    ${this._coachBtn('Open Heatmap', null, null).replace('navigate', 'panel').replace('"opts":{}', '"panel":"heatmap"')}
                    ${this._coachBtn('Open Link Graph', null, null).replace('navigate', 'panel').replace('"opts":{}', '"panel":"graph"')}
                    ${this._coachBtn('See Anomalies', null, null).replace('navigate', 'panel').replace('"opts":{}', '"panel":"anomalies"')}
                </div>
            </div>
        `;
    }

    _renderHeatmap(imp) {
        const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
        let max = 0;
        for (const m of imp.messages) {
            if (!m.timestampIso) continue;
            const d = new Date(m.timestampIso);
            if (isNaN(d)) continue;
            grid[d.getDay()][d.getHours()]++;
            if (grid[d.getDay()][d.getHours()] > max) max = grid[d.getDay()][d.getHours()];
        }
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const cell = (val, day, hour) => {
            const intensity = max ? val / max : 0;
            const color = val === 0 ? 'transparent' : `rgba(34,211,238,${0.18 + intensity * 0.82})`;
            return `<td class="dp-heat-cell ${val > 0 ? 'dp-heat-clickable' : ''}" 
                style="background:${color}" 
                title="${days[day]} ${String(hour).padStart(2, '0')}:00 — ${val} msgs"
                ${val > 0 ? this._detailAttr('comms-dayhour', { day, hour, dayLabel: days[day] }) : ''}>${val || ''}</td>`;
        };
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">Communications heatmap (day × hour)</div>
                <div class="dp-coach-help">Click any cell to open Comms filtered to that day-of-week + hour.</div>
                <table class="dp-heat-table">
                    <thead>
                        <tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th class="dp-heat-h">${h}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${days.map((d, i) => `<tr><td class="dp-heat-label">${d}</td>${grid[i].map((v, h) => cell(v, i, h)).join('')}</tr>`).join('')}
                    </tbody>
                </table>
                <div class="dp-coach-help">Peak: ${max} msgs in single day-hour cell</div>
            </div>
        `;
    }

    _renderGraph(imp) {
        const counts = this._addressCounts(imp).slice(0, 8);
        if (!counts.length) return `<div class="dp-empty-inline">No comms — graph empty.</div>`;
        const cx = 200, cy = 180, R = 130;
        const dev = imp.deviceInfo || {};
        const label = dev.phoneNumber || dev.model || 'Device';
        const nodes = counts.map((c, i) => {
            const a = (i / counts.length) * Math.PI * 2;
            return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, ...c };
        });
        const max = counts[0].count;
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">Top contact links</div>
                <div class="dp-coach-help">Edge thickness = comm volume. Click a node to open the conversation.</div>
                <svg width="100%" viewBox="0 0 400 360" style="background:rgba(0,0,0,0.2);border-radius:8px">
                    ${nodes.map(n => {
                        const w = 1 + (n.count / max) * 6;
                        return `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" stroke="rgba(34,211,238,0.5)" stroke-width="${w.toFixed(1)}" />`;
                    }).join('')}
                    <circle cx="${cx}" cy="${cy}" r="22" fill="#9333ea" stroke="white" stroke-width="2"/>
                    <text x="${cx}" y="${cy + 5}" fill="white" font-size="11" text-anchor="middle">${this._esc(label.length > 12 ? label.slice(0, 12) + '…' : label)}</text>
                    ${nodes.map((n, i) => {
                        const r = 8 + (n.count / max) * 12;
                        return `
                            <g class="dp-coach-graph-node" style="cursor:pointer"
                               ${this._detailAttr('comms-thread', { contactKey: this._normPhone(n.address), label: n.address })}>
                                <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="#22d3ee" stroke="white" stroke-width="1.5"/>
                                <text x="${n.x}" y="${n.y - r - 4}" fill="#e5e7eb" font-size="10" text-anchor="middle">${this._esc((n.address || '').slice(-7))}</text>
                                <text x="${n.x}" y="${n.y + 3}" fill="#0b1018" font-size="10" text-anchor="middle" font-weight="bold">${n.count}</text>
                            </g>
                        `;
                    }).join('')}
                </svg>
            </div>
        `;
    }

    _renderPrime(imp) {
        const counts = this._addressCounts(imp).slice(0, 12);
        if (!counts.length) return `<div class="dp-empty-inline">No messages — nothing to rank.</div>`;
        const max = counts[0].count;
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">Prime contacts (top 12)</div>
                <div class="dp-coach-help">Click a row to open the conversation thread.</div>
                ${counts.map(c => {
                    const pct = (c.count / max) * 100;
                    return `
                        <div class="dp-bar-row dp-coach-row-clickable" ${this._detailAttr('comms-thread', { contactKey: this._normPhone(c.address), label: c.address })}>
                            <div class="dp-bar-label dp-mono">${this._esc(c.address)}</div>
                            <div class="dp-bar"><div class="dp-bar-fill" style="width:${pct}%"></div></div>
                            <div class="dp-bar-num">${c.count}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    _renderGeo(imp) {
        const points = this._gpsPoints(imp);
        if (!points.length) return `<div class="dp-empty-inline">No GPS data found.</div>`;
        const clusters = this._clusterPoints(points, 0.5);
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">GPS clusters (${clusters.length} place${clusters.length === 1 ? '' : 's'})</div>
                <div class="dp-coach-help">Click a cluster to focus the map in Movement view.</div>
                ${clusters.slice(0, 12).map((c, i) => `
                    <div class="dp-coach-row dp-coach-row-clickable" ${this._detailAttr('geo-cluster', { lat: c.lat, lng: c.lng, items: c.items, idx: i + 1 })}>
                        <div>
                            <div class="dp-mono">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
                            <div class="dp-card-sub">${c.items.length} item${c.items.length === 1 ? '' : 's'}</div>
                        </div>
                        <div class="dp-stat-num dp-stat-num-sm">#${i + 1}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    _renderPhoto(imp) {
        const exif = imp.photoExifByHash || {};
        const cams = {}, sw = {};
        for (const info of Object.values(exif)) {
            if (info.camera) cams[info.camera] = (cams[info.camera] || 0) + 1;
            if (info.software) sw[info.software] = (sw[info.software] || 0) + 1;
        }
        const camsList = Object.entries(cams).sort((a, b) => b[1] - a[1]);
        const swList = Object.entries(sw).sort((a, b) => b[1] - a[1]);
        if (!camsList.length && !swList.length) return `<div class="dp-empty-inline">No EXIF camera/software metadata.</div>`;
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">Camera makes / models</div>
                ${camsList.length === 0 ? `<div class="dp-empty-inline">None.</div>` : camsList.map(([k, v]) => `
                    <div class="dp-coach-row"><div>${this._esc(k)}</div><div class="dp-stat-num dp-stat-num-sm">${v}</div></div>
                `).join('')}
                <div class="dp-coach-section-title" style="margin-top:14px">Software / processing</div>
                ${swList.length === 0 ? `<div class="dp-empty-inline">None.</div>` : swList.map(([k, v]) => `
                    <div class="dp-coach-row"><div>${this._esc(k)}</div><div class="dp-stat-num dp-stat-num-sm">${v}</div></div>
                `).join('')}
            </div>
        `;
    }

    _renderAnomalies(imp) {
        const rules = this.runAllRules(imp);
        return `
            <div class="dp-coach-panel">
                <div class="dp-coach-section-title">Automated anomaly checks</div>
                ${rules.map(r => {
                    if (r.severity === 'ok') {
                        return `<div class="dp-anomaly-good">✓ ${this._esc(r.title)}</div>`;
                    }
                    let drillBtn = '';
                    if (r.id === 'baselineOutlier') {
                        // Action to open Comms filtered to the worst day — fits in the drawer
                        const m = (r.alerts || []).join(' ').match(/^(\d{4}-\d{2}-\d{2}):/);
                        if (m) drillBtn = `<button class="dp-btn dp-btn-link" data-dp-coach-action="detail" data-dp-coach-payload='${this._esc(JSON.stringify({ kind: 'comms-date', payload: { date: m[1] } }))}'>View ${m[1]} comms</button>`;
                    } else if (r.id === 'newContactBurst') {
                        drillBtn = `<button class="dp-btn dp-btn-link" data-dp-coach-action="panel" data-dp-coach-payload='${this._esc(JSON.stringify({ panel: 'prime' }))}'>Prime contacts panel</button>`;
                    } else if (r.id === 'deletionBurst') {
                        drillBtn = `<button class="dp-btn dp-btn-link" data-dp-coach-action="navigate" data-dp-coach-payload='${this._esc(JSON.stringify({ view: 'artifacts', opts: { source: 'deleted' } }))}'>Open Deleted in Artifacts</button>`;
                    } else if (r.id === 'locationOutlier') {
                        drillBtn = `<button class="dp-btn dp-btn-link" data-dp-coach-action="navigate" data-dp-coach-payload='${this._esc(JSON.stringify({ view: 'movement', opts: {} }))}'>Open Movement</button>`;
                    } else if (r.id === 'appInstallBurst') {
                        drillBtn = `<button class="dp-btn dp-btn-link" data-dp-coach-action="navigate" data-dp-coach-payload='${this._esc(JSON.stringify({ view: 'artifacts', opts: { type: 'app' } }))}'>Open Apps</button>`;
                    }
                    return `
                        <div class="dp-anomaly">
                            <div class="dp-anomaly-title">⚠ ${this._esc(r.title)}</div>
                            ${(r.alerts || []).map(a => `<div class="dp-anomaly-text">${this._esc(a)}</div>`).join('')}
                            ${drillBtn}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // ─── In-drawer detail view ─────────────────────────────────
    /**
     * Render the drilled-down record set inside the drawer body itself.
     * Returns the HTML for both the sticky header and the scrollable body —
     * REPLACES <div class="dp-coach-body"> in render() when detailContext is set.
     */
    _renderDetail(imp) {
        const ctx = this.detailContext;
        const p = ctx.payload || {};
        let title = '';
        let mainViewBtn = '';
        let body = '';

        switch (ctx.kind) {
            case 'comms-thread': {
                title = `💬 ${this._esc(p.label || p.contactKey || '(unknown)')}`;
                mainViewBtn = this._openMainBtn('comms', { contactKey: p.contactKey });
                body = this._renderDetailCommsForContact(imp, p.contactKey);
                break;
            }
            case 'comms-dayhour': {
                const hh = String(p.hour).padStart(2, '0');
                title = `🔥 ${this._esc(p.dayLabel || '?')} ${hh}:00`;
                mainViewBtn = this._openMainBtn('comms', { dayHour: { day: p.day, hour: p.hour } });
                body = this._renderDetailCommsForDayHour(imp, p.day, p.hour);
                break;
            }
            case 'comms-date': {
                title = `📅 Comms on ${this._esc(p.date)}`;
                mainViewBtn = this._openMainBtn('comms', { date: p.date });
                body = this._renderDetailCommsForDate(imp, p.date);
                break;
            }
            case 'geo-cluster': {
                title = `🌍 Cluster #${p.idx || ''} <span class="dp-detail-sub">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>`;
                mainViewBtn = this._openMainBtn('movement', { lat: p.lat, lng: p.lng });
                body = this._renderDetailGeoCluster(imp, p);
                break;
            }
            default:
                title = 'Detail';
                body = `<div class="dp-detail-empty">Unknown detail kind: ${this._esc(ctx.kind)}</div>`;
        }

        return `
            <div class="dp-coach-detail-head">
                <button class="dp-coach-detail-back" id="dp-coach-detail-back" title="Back to ${this._esc(ctx.returnPanel || 'panel')}">← Back</button>
                <div class="dp-detail-title">${title}</div>
                ${mainViewBtn}
            </div>
            <div class="dp-coach-detail-body">
                ${body}
            </div>
        `;
    }

    _renderDetailCommsForContact(imp, contactKey) {
        const events = this._collectThreadEvents(imp).filter(e => this._normPhone(e.address) === contactKey);
        return this._renderDetailEventList(events, 'No messages or calls with this contact.');
    }

    _renderDetailCommsForDayHour(imp, day, hour) {
        const events = this._collectThreadEvents(imp).filter(e => {
            if (!e.date) return false;
            const d = new Date(e.date);
            if (isNaN(d)) return false;
            return d.getDay() === day && d.getHours() === hour;
        });
        return this._renderDetailEventList(events, 'No comms in this day-hour bucket.');
    }

    _renderDetailCommsForDate(imp, date) {
        const events = this._collectThreadEvents(imp).filter(e => (e.date || '').startsWith(date));
        return this._renderDetailEventList(events, `No comms on ${date}.`);
    }

    _renderDetailGeoCluster(imp, p) {
        const items = p.items || [];
        if (!items.length) return `<div class="dp-detail-empty">Cluster contains no items.</div>`;
        // Resolve photo metadata from each cluster point's lat/lng to a media file.
        const exif = imp.photoExifByHash || {};
        const mediaByHash = {};
        for (const m of (imp.media || [])) if (m.exifHash) mediaByHash[m.exifHash] = m;

        const enriched = items.map(pt => {
            // Find the exif entry whose gps matches this point (within tiny tolerance)
            for (const [hash, info] of Object.entries(exif)) {
                if (info.gps && Math.abs(info.gps.lat - pt.lat) < 1e-6 && Math.abs(info.gps.lng - pt.lng) < 1e-6) {
                    return { pt, hash, info, media: mediaByHash[hash] || null };
                }
            }
            return { pt, hash: null, info: null, media: null };
        });

        return `
            <div class="dp-detail-cluster-meta" style="color:#94a3b8;font-size:11px;margin-bottom:8px">
                ${items.length} item${items.length === 1 ? '' : 's'} in this cluster
            </div>
            ${enriched.map(({ pt, info, media }) => {
                const dateStr = info && info.dateTimeIso ? info.dateTimeIso.replace('T', ' ').slice(0, 19) : '';
                const cam = info && info.camera ? info.camera : '';
                return `
                    <div class="dp-detail-cluster-item">
                        <div style="flex:1;min-width:0">
                            <div style="font-weight:600;color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(media ? media.fileName : '(unmatched photo)')}</div>
                            <div class="dp-detail-coords">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</div>
                            ${dateStr ? `<div style="color:#94a3b8;font-size:10px">${this._esc(dateStr)}</div>` : ''}
                            ${cam ? `<div style="color:#6b7280;font-size:10px">${this._esc(cam)}</div>` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        `;
    }

    /** Collect unified msg+call events with normalized address for filtering. */
    _collectThreadEvents(imp) {
        const out = [];
        for (const m of (imp.messages || [])) {
            out.push({
                kind: 'msg',
                address: m.address || '',
                dir: m.direction || 'unknown',
                date: m.timestampIso || m.timestamp || '',
                text: m.text || '',
                meta: m.type || ''
            });
        }
        for (const c of (imp.calls || [])) {
            out.push({
                kind: 'call',
                address: c.address || c.number || '',
                dir: c.direction || 'unknown',
                date: c.timestampIso || c.timestamp || '',
                text: c.summary || c.deletedData || '(carved fragment)',
                meta: c.duration ? `${c.duration}s` : 'fragment'
            });
        }
        out.sort((a, b) => {
            const da = a.date ? new Date(a.date).getTime() : 0;
            const db = b.date ? new Date(b.date).getTime() : 0;
            return db - da;
        });
        return out;
    }

    _renderDetailEventList(events, emptyMsg) {
        if (!events.length) return `<div class="dp-detail-empty">${this._esc(emptyMsg)}</div>`;
        // Group by date for separators
        const groups = [];
        let currentDate = null;
        for (const ev of events) {
            const dKey = (ev.date || '').split('T')[0] || 'Unknown';
            if (dKey !== currentDate) { groups.push({ date: dKey, items: [] }); currentDate = dKey; }
            groups[groups.length - 1].items.push(ev);
        }
        return groups.map(g => `
            <div class="dp-detail-date-sep">${this._esc(g.date)}</div>
            ${g.items.map(ev => this._renderDetailEvent(ev)).join('')}
        `).join('');
    }

    _renderDetailEvent(ev) {
        const time = ev.date ? (ev.date.split('T')[1] || '').slice(0, 5) : '';
        const dirLabel = ev.dir === 'outgoing' ? '→ Sent' : (ev.dir === 'incoming' ? '← Recv' : '↔');
        const cls = ev.kind === 'call' ? 'call' : (ev.dir === 'outgoing' ? 'out' : (ev.dir === 'incoming' ? 'in' : ''));
        const icon = ev.kind === 'call' ? '📞 ' : '';
        return `
            <div class="dp-detail-msg ${cls}">
                <div class="dp-detail-meta">
                    <span>${this._esc(time)}</span>
                    <span>${this._esc(dirLabel)}</span>
                    ${ev.address ? `<span class="dp-mono">${this._esc(ev.address)}</span>` : ''}
                    ${ev.meta ? `<span>${this._esc(ev.meta)}</span>` : ''}
                </div>
                <div>${icon}${this._esc(ev.text) || '<em style="color:#6b7280">(empty)</em>'}</div>
            </div>
        `;
    }

    // ─── Anomaly engine ────────────────────────────────────────

    _ruleBaselineOutlier(imp) {
        const alerts = [];
        const byDay = {};
        for (const m of (imp.messages || [])) {
            if (!m.timestampIso) continue;
            const d = m.timestampIso.slice(0, 10);
            byDay[d] = (byDay[d] || 0) + 1;
        }
        const counts = Object.values(byDay);
        if (counts.length < 3) return { alerts };
        const mean = counts.reduce((s, x) => s + x, 0) / counts.length;
        const variance = counts.reduce((s, x) => s + (x - mean) ** 2, 0) / counts.length;
        const std = Math.sqrt(variance);
        const threshold = mean + 3 * std;
        for (const [day, c] of Object.entries(byDay)) {
            if (c > threshold && c > mean * 1.5) {
                alerts.push(`${day}: ${c} msgs (μ=${mean.toFixed(1)}, σ=${std.toFixed(1)})`);
            }
        }
        return { alerts };
    }

    _ruleNewContactBurst(imp) {
        const alerts = [];
        const msgs = (imp.messages || []).filter(m => m.timestampIso).sort((a, b) => a.timestampIso.localeCompare(b.timestampIso));
        if (msgs.length < 6) return { alerts };
        const seen = new Set(); const firstSeen = {};
        for (const m of msgs) {
            if (!seen.has(m.address)) { seen.add(m.address); firstSeen[m.address] = new Date(m.timestampIso).getTime(); }
        }
        const firsts = Object.values(firstSeen).sort((a, b) => a - b);
        const WIN = 24 * 3600 * 1000;
        for (let i = 0; i < firsts.length; i++) {
            let j = i;
            while (j < firsts.length && firsts[j] - firsts[i] <= WIN) j++;
            if (j - i > 5) { alerts.push(`${j - i} new contacts within 24h starting ${new Date(firsts[i]).toLocaleString()}`); i = j; }
        }
        return { alerts };
    }

    _ruleDeletionBurst(imp) {
        const alerts = [];
        const total = (imp.calls || []).length + (imp.calendar || []).length + (imp.deleted || []).length;
        if (total > 200) alerts.push(`${total} carved/deleted records (calls=${(imp.calls || []).length}, cal=${(imp.calendar || []).length}, sources=${(imp.deleted || []).length})`);
        if ((imp.deleted || []).length > 6) alerts.push(`${imp.deleted.length} deleted databases recovered — broader-than-typical wipe`);
        return { alerts };
    }

    _ruleLocationOutlier(imp) {
        const alerts = [];
        const points = this._gpsPoints(imp);
        if (points.length < 3) return { alerts };
        const cLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const cLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        for (const p of points) {
            const km = this._haversineKm(cLat, cLng, p.lat, p.lng);
            if (km > 40) alerts.push(`${p.lat.toFixed(3)},${p.lng.toFixed(3)} is ${km.toFixed(0)}km from cluster centroid`);
        }
        return { alerts };
    }

    _ruleAppInstallBurst(imp) {
        const alerts = [];
        const apps = imp.apps || [];
        if (!apps.length) return { alerts };
        const v10x = apps.filter(a => /^1\.0\./.test(a.version || '')).length;
        if (v10x > 20) alerts.push(`${v10x} apps have version 1.0.x — possible factory restore or fresh install`);
        const priv = apps.filter(a => a.isPrivate).length;
        if (priv > 5) alerts.push(`${priv} apps marked Private — review for sideloaded/hidden installs`);
        return { alerts };
    }

    // ─── helpers ────────────────────────────────────────────────

    _addressCounts(imp) {
        const c = {};
        for (const m of (imp.messages || [])) { const a = m.address || '?'; c[a] = (c[a] || 0) + 1; }
        return Object.entries(c).map(([address, count]) => ({ address, count })).sort((a, b) => b.count - a.count);
    }

    _gpsPoints(imp) {
        const out = [];
        const exif = imp.photoExifByHash || {};
        for (const info of Object.values(exif)) {
            if (info.gps && typeof info.gps.lat === 'number') out.push({ lat: info.gps.lat, lng: info.gps.lng });
        }
        return out;
    }

    _photoDates(imp) {
        const out = [];
        const exif = imp.photoExifByHash || {};
        for (const info of Object.values(exif)) {
            const d = info.dateTimeIso || info.dateTime;
            if (d) out.push(d);
        }
        return out;
    }

    _messageSpan(imp) {
        const msgs = (imp.messages || []).filter(m => m.timestampIso);
        if (msgs.length < 2) return { days: 0 };
        const sorted = msgs.map(m => new Date(m.timestampIso).getTime()).sort((a, b) => a - b);
        return { days: Math.round((sorted[sorted.length - 1] - sorted[0]) / 86400000) };
    }

    _clusterPoints(points, radiusKm) {
        const used = new Array(points.length).fill(false);
        const clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (used[i]) continue;
            const c = { lat: points[i].lat, lng: points[i].lng, items: [points[i]] };
            used[i] = true;
            for (let j = i + 1; j < points.length; j++) {
                if (used[j]) continue;
                if (this._haversineKm(c.lat, c.lng, points[j].lat, points[j].lng) <= radiusKm) {
                    c.items.push(points[j]);
                    used[j] = true;
                }
            }
            // recenter
            c.lat = c.items.reduce((s, p) => s + p.lat, 0) / c.items.length;
            c.lng = c.items.reduce((s, p) => s + p.lng, 0) / c.items.length;
            clusters.push(c);
        }
        return clusters.sort((a, b) => b.items.length - a.items.length);
    }

    _haversineKm(la1, lo1, la2, lo2) {
        const R = 6371;
        const toRad = x => x * Math.PI / 180;
        const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
        const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    _normPhone(p) {
        if (!p) return '';
        const digits = String(p).replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : digits;
    }

    _esc(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    _loadOpen() {
        try {
            const raw = localStorage.getItem(`datapilotCoach_${this.module.caseId}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                this.isOpen = !!parsed.isOpen;
                this.activePanel = parsed.activePanel || 'dashboard';
            }
        } catch (e) { /* ignore */ }
    }

    _saveOpen() {
        try {
            localStorage.setItem(`datapilotCoach_${this.module.caseId}`, JSON.stringify({ isOpen: this.isOpen, activePanel: this.activePanel }));
        } catch (e) { /* ignore */ }
    }
}

if (typeof window !== 'undefined') {
    window.DatapilotCoach = DatapilotCoach;
}
