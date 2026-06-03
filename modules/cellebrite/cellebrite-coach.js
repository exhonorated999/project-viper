/**
 * Cellebrite Insights Coach — left-side drawer with analytic panels that
 * drill BACK into the main views (Subject / Comms / Artifacts / per-surface
 * tabs) via module.setActiveSubTab() + ui._search filter persistence.
 *
 * Mirrors Datapilot's coach UX (modules/datapilot/datapilot-analytics.js)
 * but adapted to Cellebrite's data model where parsed surfaces live in
 * lazy-loaded JSON (contacts/calls/sms/media) rather than inline on imp.
 *
 * Panels (v1):
 *   dashboard   counts + top contacts + quick-jumps
 *   heatmap     7×24 day-hour heatmap from SMS timestamps
 *   prime       top contacts ranked by msg+call volume
 *   geo         GPS clusters from media items carrying lat/lon
 *   anomalies   stub — TODO surface app-install bursts, deletion patterns
 *
 * Not yet ported (Cellebrite has no source data):
 *   links / graph (would need comm-volume graph layout — low value v1)
 *   photo / EXIF (Cellebrite media indexer doesn't parse EXIF yet)
 */

class CellebriteCoach {
    constructor(module) {
        this.module = module;
        this.isOpen = false;
        this.activePanel = 'dashboard';
        // surfaces loaded lazily and cached per-import:
        //   { importId: { contacts, sms, calls, media } }
        this._cache = new Map();
        this._loading = false;
        this._loadOpen();
    }

    // ─── public ────────────────────────────────────────────────

    toggle() {
        this.isOpen = !this.isOpen;
        this._saveOpen();
        if (this.isOpen) this._ensureLoaded();
        this._rerender();
    }
    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this._saveOpen();
        this._rerender();
    }
    openTo(panelId) {
        this.isOpen = true;
        this.activePanel = panelId || 'dashboard';
        this._saveOpen();
        this._ensureLoaded();
        this._rerender();
    }

    // ─── persistence ───────────────────────────────────────────

    _loadOpen() {
        try {
            const raw = localStorage.getItem(`cellebriteCoach_${this.module.caseId}`);
            if (raw) {
                const o = JSON.parse(raw);
                this.isOpen = !!o.isOpen;
                this.activePanel = o.activePanel || 'dashboard';
            }
        } catch (_) {}
    }
    _saveOpen() {
        try {
            localStorage.setItem(`cellebriteCoach_${this.module.caseId}`, JSON.stringify({
                isOpen: this.isOpen,
                activePanel: this.activePanel,
            }));
        } catch (_) {}
    }

    // ─── lazy data load ────────────────────────────────────────

    async _ensureLoaded() {
        const imp = this.module.getActiveImport();
        if (!imp) return;
        if (this._cache.has(imp.id)) return;
        if (this._loading) return;
        this._loading = true;
        try {
            const [contacts, sms, calls, media, apps] = await Promise.all([
                this.module.loadSurface(imp.id, 'contacts').catch(() => null),
                this.module.loadSurface(imp.id, 'sms').catch(() => null),
                this.module.loadSurface(imp.id, 'calls').catch(() => null),
                this.module.loadSurface(imp.id, 'media').catch(() => null),
                this.module.loadSurface(imp.id, 'apps').catch(() => null),
            ]);
            this._cache.set(imp.id, { contacts, sms, calls, media, apps });
        } finally {
            this._loading = false;
            this._rerender();
        }
    }

    _rerender() {
        // Re-render only the drawer overlay — leave the pane untouched so
        // long-running observer / VirtualList state survives Coach toggles.
        const root = document.querySelector('.cellebrite-shell');
        if (root) this.render(root);
    }

    // ─── render ────────────────────────────────────────────────

    render(rootEl) {
        if (!rootEl) return;
        // Tear down any prior Leaflet map before the drawer node is removed.
        this._destroyGeoMap();
        const prior = rootEl.querySelector('.cb-coach');
        if (prior) prior.remove();
        if (!this.isOpen) return;
        const imp = this.module.getActiveImport();
        if (!imp) return;

        const drawer = document.createElement('div');
        drawer.className = 'cb-coach';
        drawer.innerHTML = `
            <div class="cb-coach-header">
                <strong>💡 Insights Coach</strong>
                <button class="cb-coach-close" id="cellebriteCoachClose" title="Close">×</button>
            </div>
            <div class="cb-coach-rail">
                ${this._tabBtn('dashboard', '📊', 'Dashboard')}
                ${this._tabBtn('heatmap',   '🔥', 'Heatmap')}
                ${this._tabBtn('prime',     '⭐', 'Prime')}
                ${this._tabBtn('geo',       '🌍', 'Geo')}
                ${this._tabBtn('anomalies', '⚠️', 'Anomalies')}
            </div>
            <div class="cb-coach-body" id="cellebriteCoachBody">
                ${this._loading && !this._cache.has(imp.id)
                    ? `<div class="cb-coach-loading">Loading analytics…</div>`
                    : this._renderPanel(imp)}
            </div>
        `;
        rootEl.appendChild(drawer);

        drawer.querySelector('#cellebriteCoachClose').addEventListener('click', () => this.close());
        drawer.querySelectorAll('[data-cb-coach-tab]').forEach(b => {
            b.addEventListener('click', () => {
                this.activePanel = b.dataset.cbCoachTab;
                this._saveOpen();
                this._rerender();
            });
        });
        this._wireActions(drawer);

        // Mount Leaflet map for Geo panel after the drawer is in the DOM.
        if (this.activePanel === 'geo') {
            this._mountGeoMap(drawer, imp);
        }
    }

    _tabBtn(id, icon, label) {
        return `
            <button class="cb-coach-rail-btn ${this.activePanel === id ? 'active' : ''}"
                    data-cb-coach-tab="${id}">
                <span>${icon}</span><span>${label}</span>
            </button>
        `;
    }

    _renderPanel(imp) {
        switch (this.activePanel) {
            case 'dashboard': return this._renderDashboard(imp);
            case 'heatmap':   return this._renderHeatmap(imp);
            case 'prime':     return this._renderPrime(imp);
            case 'geo':       return this._renderGeo(imp);
            case 'anomalies': return this._renderAnomalies(imp);
            default:          return this._renderDashboard(imp);
        }
    }

    /** Wire all data-cb-coach-action elements. */
    _wireActions(drawer) {
        drawer.querySelectorAll('[data-cb-coach-action]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const a = el.dataset.cbCoachAction;
                let payload = {};
                if (el.dataset.cbCoachPayload) {
                    try { payload = JSON.parse(el.dataset.cbCoachPayload); } catch (_) {}
                }
                if (a === 'panel') {
                    this.activePanel = payload.panel;
                    this._saveOpen();
                    this._rerender();
                } else if (a === 'jump') {
                    this._jumpTo(payload.tab, payload.search);
                }
            });
        });
    }

    /** Switch to a sub-tab and apply a search filter (e.g. phone number). */
    _jumpTo(tab, search) {
        if (!tab) return;
        const ui = this.module.ui;
        if (ui && ui._search && typeof search === 'string') {
            ui._search[tab] = search;
        }
        this.module.setActiveSubTab(tab);
    }

    _panelBtn(label, panel) {
        const payload = this._esc(JSON.stringify({ panel }));
        return `<button class="cb-coach-link"
                        data-cb-coach-action="panel"
                        data-cb-coach-payload='${payload}'>${label}</button>`;
    }

    _jumpBtn(label, tab, search) {
        const payload = this._esc(JSON.stringify({ tab, search: search || '' }));
        return `<button class="cb-coach-link"
                        data-cb-coach-action="jump"
                        data-cb-coach-payload='${payload}'>${label}</button>`;
    }

    // ─── panels ────────────────────────────────────────────────

    _renderDashboard(imp) {
        const bucket = this._cache.get(imp.id) || {};
        const contacts = (bucket.contacts && Array.isArray(bucket.contacts.contacts)) ? bucket.contacts.contacts : [];
        const sms = (bucket.sms && Array.isArray(bucket.sms.messages)) ? bucket.sms.messages : [];
        const calls = (bucket.calls && Array.isArray(bucket.calls.calls)) ? bucket.calls.calls : [];
        const media = (bucket.media && Array.isArray(bucket.media.items)) ? bucket.media.items : [];

        const photos = media.filter(m => m.type === 'image').length;
        const gpsCount = media.filter(m => m.gps).length;
        const span = this._messageSpan(sms);
        const top = this._addressCounts(sms, calls).slice(0, 3);
        const anomalies = this._computeAnomalies(imp);
        const anomCount = anomalies.length;
        const anomColor = anomCount === 0 ? '#10b981' : (anomCount >= 3 ? '#ef4444' : '#f59e0b');

        return `
            <div class="cb-coach-panel">
                <div class="cb-coach-row">
                    <div class="cb-coach-num">${contacts.length}</div>
                    <div class="cb-coach-label">Contacts</div>
                </div>
                <div class="cb-coach-row">
                    <div class="cb-coach-num">${sms.length}</div>
                    <div class="cb-coach-label">Messages over ${span.days || 0} days</div>
                </div>
                <div class="cb-coach-row">
                    <div class="cb-coach-num">${photos}</div>
                    <div class="cb-coach-label">Photos</div>
                </div>
                <div class="cb-coach-row">
                    <div class="cb-coach-num">${gpsCount}</div>
                    <div class="cb-coach-label">GPS-bearing items</div>
                </div>
                <div class="cb-coach-row cb-coach-row-warn">
                    <div class="cb-coach-num" style="color:${anomColor}">${anomCount}</div>
                    <div class="cb-coach-label">Active anomalies — ${this._panelBtn('open', 'anomalies')}</div>
                </div>

                <div class="cb-coach-section">
                    <div class="cb-coach-section-title">Top contacts</div>
                    ${top.length === 0
                        ? `<div class="cb-coach-empty">No messages parsed yet.</div>`
                        : top.map(c => `
                            <div class="cb-coach-row cb-coach-row-clickable"
                                 data-cb-coach-action="jump"
                                 data-cb-coach-payload='${this._esc(JSON.stringify({ tab: 'sms', search: c.address }))}'>
                                <div class="cb-coach-mono">${this._esc(c.address)}</div>
                                <div class="cb-coach-num cb-coach-num-sm">${c.count}</div>
                            </div>
                        `).join('')}
                    ${top.length ? `<div style="margin-top:6px">${this._panelBtn('See all in Prime panel →', 'prime')}</div>` : ''}
                </div>

                <div class="cb-coach-section">
                    <div class="cb-coach-section-title">Quick jump</div>
                    <div class="cb-coach-quickjumps">
                        ${this._panelBtn('Open Heatmap', 'heatmap')}
                        ${this._panelBtn('See Geo Clusters', 'geo')}
                        ${this._panelBtn('See Anomalies', 'anomalies')}
                    </div>
                </div>
            </div>
        `;
    }

    _renderHeatmap(imp) {
        const bucket = this._cache.get(imp.id) || {};
        const sms = (bucket.sms && Array.isArray(bucket.sms.messages)) ? bucket.sms.messages : [];
        if (!sms.length) {
            return `<div class="cb-coach-panel"><div class="cb-coach-empty">No SMS messages parsed — heatmap unavailable.</div></div>`;
        }
        const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
        let max = 0;
        for (const m of sms) {
            const ts = m.timestamp || m.timestampMs || m.dateMs || m.date;
            const d = ts ? new Date(typeof ts === 'number' ? ts : Date.parse(ts)) : null;
            if (!d || isNaN(d)) continue;
            const day = d.getDay();
            const hour = d.getHours();
            grid[day][hour]++;
            if (grid[day][hour] > max) max = grid[day][hour];
        }
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const cell = (val, day, hour) => {
            const intensity = max ? val / max : 0;
            const color = val === 0 ? 'transparent' : `rgba(34,211,238,${0.18 + intensity * 0.82})`;
            return `<td class="cb-heat-cell ${val > 0 ? 'cb-heat-clickable' : ''}"
                style="background:${color}"
                title="${days[day]} ${String(hour).padStart(2, '0')}:00 — ${val} msgs">${val || ''}</td>`;
        };
        return `
            <div class="cb-coach-panel">
                <div class="cb-coach-section-title">Communications heatmap (day × hour)</div>
                <div class="cb-coach-help">Brightness = volume. Peak: <strong>${max}</strong> msgs in one cell.</div>
                <div style="overflow-x:auto">
                    <table class="cb-heat-table">
                        <thead>
                            <tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th class="cb-heat-h">${h}</th>`).join('')}</tr>
                        </thead>
                        <tbody>
                            ${days.map((d, i) => `<tr><td class="cb-heat-label">${d}</td>${grid[i].map((v, h) => cell(v, i, h)).join('')}</tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    _renderPrime(imp) {
        const bucket = this._cache.get(imp.id) || {};
        const sms = (bucket.sms && Array.isArray(bucket.sms.messages)) ? bucket.sms.messages : [];
        const calls = (bucket.calls && Array.isArray(bucket.calls.calls)) ? bucket.calls.calls : [];
        const counts = this._addressCounts(sms, calls).slice(0, 12);
        if (!counts.length) {
            return `<div class="cb-coach-panel"><div class="cb-coach-empty">No comms parsed — nothing to rank.</div></div>`;
        }
        const max = counts[0].count;
        return `
            <div class="cb-coach-panel">
                <div class="cb-coach-section-title">Prime contacts (top ${counts.length})</div>
                <div class="cb-coach-help">Click a row → open Messages filtered to that number.</div>
                ${counts.map(c => {
                    const pct = (c.count / max) * 100;
                    return `
                        <div class="cb-bar-row cb-coach-row-clickable"
                             data-cb-coach-action="jump"
                             data-cb-coach-payload='${this._esc(JSON.stringify({ tab: 'sms', search: c.address }))}'>
                            <div class="cb-bar-label cb-coach-mono">${this._esc(c.address)}</div>
                            <div class="cb-bar"><div class="cb-bar-fill" style="width:${pct}%"></div></div>
                            <div class="cb-bar-num">${c.count}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    _renderGeo(imp) {
        const bucket = this._cache.get(imp.id) || {};
        const media = (bucket.media && Array.isArray(bucket.media.items)) ? bucket.media.items : [];
        const points = [];
        for (const m of media) {
            if (!m.gps) continue;
            // Coerce — UFDR can serialize as either number or numeric string.
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            points.push({ lat, lng, ref: m });
        }
        if (!points.length) {
            return `<div class="cb-coach-panel"><div class="cb-coach-empty">No GPS-bearing media in this bundle.</div></div>`;
        }
        const clusters = this._clusterPoints(points, 0.5);
        return `
            <div class="cb-coach-panel">
                <div class="cb-coach-section-title">${points.length} GPS-tagged item${points.length === 1 ? '' : 's'} · ${clusters.length} cluster${clusters.length === 1 ? '' : 's'}</div>
                <div id="cellebriteCoachGeoMap"
                     style="height: 260px; width: 100%; border-radius: 8px; background: #0a0e14; border: 1px solid rgba(139,92,246,0.35); margin-bottom: 10px;">
                </div>
                <div class="cb-coach-help">Click a dot for details · click a row below to open Media tab.</div>
                ${clusters.slice(0, 12).map((c, i) => `
                    <div class="cb-coach-row cb-coach-row-clickable"
                         data-cb-coach-action="jump"
                         data-cb-coach-payload='${this._esc(JSON.stringify({ tab: 'media', search: '' }))}'
                         title="${c.items.length} item${c.items.length === 1 ? '' : 's'} near ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}">
                        <div>
                            <div class="cb-coach-mono">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
                            <div class="cb-coach-sub">${c.items.length} item${c.items.length === 1 ? '' : 's'}</div>
                        </div>
                        <div class="cb-coach-num cb-coach-num-sm">#${i + 1}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    _renderAnomalies(imp) {
        const findings = this._computeAnomalies(imp);
        if (!findings.length) {
            return `
                <div class="cb-coach-panel">
                    <div class="cb-coach-section-title">Automated anomaly rules</div>
                    <div class="cb-coach-empty" style="color:#10b981">
                        ✓ No anomalies detected across 5 rules.<br><br>
                        <span style="color:#9ca3af">Rules evaluated:</span><br>
                        • Private/encrypted comm apps<br>
                        • Communications burst (3× rolling avg)<br>
                        • Night-owl activity (00:00–04:59)<br>
                        • New-contact burst (≥5/day first-seen)<br>
                        • Geo outlier (&gt;100 km from main cluster)
                    </div>
                </div>
            `;
        }
        const sevColor = { high: '#ef4444', med: '#f59e0b', low: '#06b6d4' };
        return `
            <div class="cb-coach-panel">
                <div class="cb-coach-section-title">Anomaly findings (${findings.length})</div>
                <div class="cb-coach-help">Heuristic flags — review evidence before drawing conclusions.</div>
                ${findings.map(f => {
                    const payload = f.action ? this._esc(JSON.stringify(f.action)) : '';
                    const clickable = f.action ? 'cb-coach-row-clickable' : '';
                    const actionAttr = f.action ? `data-cb-coach-action="jump" data-cb-coach-payload='${payload}'` : '';
                    return `
                        <div class="cb-coach-row cb-coach-row-warn ${clickable}"
                             style="border-left-color:${sevColor[f.severity] || '#06b6d4'}"
                             ${actionAttr}>
                            <div style="flex:1">
                                <div style="font-weight:600;color:${sevColor[f.severity] || '#06b6d4'};margin-bottom:2px">
                                    ${this._severityIcon(f.severity)} ${this._esc(f.title)}
                                </div>
                                <div class="cb-coach-sub">${this._esc(f.summary)}</div>
                                ${f.detail ? `<div class="cb-coach-mono" style="margin-top:4px;font-size:11px;color:#9ca3af">${this._esc(f.detail)}</div>` : ''}
                            </div>
                            ${f.action ? `<div class="cb-coach-num cb-coach-num-sm" style="color:${sevColor[f.severity]}">→</div>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    _severityIcon(sev) {
        return sev === 'high' ? '🔴' : sev === 'med' ? '🟠' : '🔵';
    }

    /**
     * Run all 5 anomaly rules over the cached surfaces for this import.
     * Each finding: { id, severity:'high'|'med'|'low', title, summary, detail?, action? }
     * action shape: { tab, search } — fed to jump dispatcher.
     */
    _computeAnomalies(imp) {
        const bucket = this._cache.get(imp.id);
        if (!bucket) return [];
        const sms = (bucket.sms && Array.isArray(bucket.sms.messages)) ? bucket.sms.messages : [];
        const calls = (bucket.calls && Array.isArray(bucket.calls.calls)) ? bucket.calls.calls : [];
        const media = (bucket.media && Array.isArray(bucket.media.items)) ? bucket.media.items : [];
        const apps = (bucket.apps && Array.isArray(bucket.apps.apps)) ? bucket.apps.apps : [];

        const out = [];

        // ─── Rule 1 — Private / encrypted comm apps installed ───
        // Known privacy-focused messengers commonly associated with OPSEC behavior.
        const PRIVATE_APPS = [
            { match: /signal/i,                       name: 'Signal' },
            { match: /telegram/i,                     name: 'Telegram' },
            { match: /wickr/i,                        name: 'Wickr' },
            { match: /threema/i,                      name: 'Threema' },
            { match: /session/i,                      name: 'Session' },
            { match: /\bwire\b/i,                     name: 'Wire' },
            { match: /confide/i,                      name: 'Confide' },
            { match: /\bbriar\b/i,                    name: 'Briar' },
            { match: /silence/i,                      name: 'Silence' },
            { match: /element|matrix/i,               name: 'Element / Matrix' },
            { match: /protonmail|proton\.me/i,        name: 'ProtonMail' },
            { match: /tutanota/i,                     name: 'Tutanota' },
            { match: /dust\.app|cyberdust/i,          name: 'Dust' },
            { match: /silentcircle/i,                 name: 'Silent Circle' },
            { match: /\bnordvpn|expressvpn|protonvpn|mullvad|surfshark|ivpn/i, name: 'VPN client' },
            { match: /\btor\b|orbot|torbrowser/i,     name: 'Tor / Orbot' },
        ];
        const found = [];
        for (const a of apps) {
            const hay = `${a.displayName || ''} ${a.packageName || ''}`;
            for (const p of PRIVATE_APPS) {
                if (p.match.test(hay)) {
                    found.push({ name: p.name, displayName: a.displayName || a.packageName });
                    break;
                }
            }
        }
        if (found.length > 0) {
            // dedup by family name
            const seen = new Set();
            const uniq = [];
            for (const f of found) { if (!seen.has(f.name)) { seen.add(f.name); uniq.push(f); } }
            out.push({
                id: 'private-apps',
                severity: uniq.length >= 3 ? 'high' : 'med',
                title: `${uniq.length} privacy/encrypted app${uniq.length === 1 ? '' : 's'} installed`,
                summary: `Detected: ${uniq.slice(0, 5).map(u => u.name).join(', ')}${uniq.length > 5 ? `, +${uniq.length - 5} more` : ''}`,
                detail: uniq.map(u => u.displayName).slice(0, 8).join(' · '),
                action: { tab: 'apps', search: uniq[0].displayName || '' },
            });
        }

        // ─── Rule 2 — Communications burst (daily) ───
        // Days where msg count > max(10, 3 × rolling 14-day average).
        if (sms.length >= 30) {
            const byDay = new Map(); // 'YYYY-MM-DD' → count
            for (const m of sms) {
                const ts = m.timestamp || m.timestampMs || m.dateMs || m.date;
                const d = ts ? new Date(typeof ts === 'number' ? ts : Date.parse(ts)) : null;
                if (!d || isNaN(d)) continue;
                const k = d.toISOString().slice(0, 10);
                byDay.set(k, (byDay.get(k) || 0) + 1);
            }
            const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
            const bursts = [];
            for (let i = 0; i < days.length; i++) {
                const winStart = Math.max(0, i - 14);
                const winEnd = i;
                let sum = 0, n = 0;
                for (let j = winStart; j < winEnd; j++) { sum += days[j][1]; n++; }
                const avg = n > 0 ? sum / n : 0;
                const today = days[i][1];
                const threshold = Math.max(10, avg * 3);
                if (n >= 5 && today >= threshold) {
                    bursts.push({ day: days[i][0], count: today, avg: Math.round(avg * 10) / 10 });
                }
            }
            if (bursts.length > 0) {
                const top = bursts.sort((a, b) => b.count - a.count)[0];
                out.push({
                    id: 'comms-burst',
                    severity: bursts.length >= 3 ? 'high' : 'med',
                    title: `${bursts.length} communication burst${bursts.length === 1 ? '' : 's'}`,
                    summary: `Peak: ${top.count} msgs on ${top.day} (rolling avg ${top.avg})`,
                    detail: bursts.slice(0, 4).map(b => `${b.day}: ${b.count} (avg ${b.avg})`).join(' · '),
                    action: { tab: 'sms', search: '' },
                });
            }
        }

        // ─── Rule 3 — Night-owl activity (00:00–04:59) ───
        if (sms.length >= 50) {
            let night = 0, total = 0;
            for (const m of sms) {
                const ts = m.timestamp || m.timestampMs || m.dateMs || m.date;
                const d = ts ? new Date(typeof ts === 'number' ? ts : Date.parse(ts)) : null;
                if (!d || isNaN(d)) continue;
                total++;
                const h = d.getHours();
                if (h >= 0 && h < 5) night++;
            }
            const pct = total ? (night / total) * 100 : 0;
            if (pct >= 25) {
                out.push({
                    id: 'night-owl',
                    severity: pct >= 40 ? 'high' : 'med',
                    title: `Night-owl activity: ${pct.toFixed(1)}%`,
                    summary: `${night} of ${total} messages sent between 00:00–04:59`,
                    detail: `Heatmap shows concentrated late-night traffic — review for sleep-disruption / clandestine pattern.`,
                    action: { tab: 'sms', search: '' },
                });
            }
        }

        // ─── Rule 4 — New-contact burst (≥5 unique first-seen in 24h) ───
        if (sms.length >= 30) {
            const firstSeen = new Map(); // normalized address → earliest timestamp
            for (const m of sms) {
                const ts = m.timestamp || m.timestampMs || m.dateMs || m.date;
                const t = ts ? (typeof ts === 'number' ? ts : Date.parse(ts)) : NaN;
                if (!isFinite(t)) continue;
                const k = this._normPhone(m.address || m.from || m.to || '');
                if (!k) continue;
                if (!firstSeen.has(k) || firstSeen.get(k) > t) firstSeen.set(k, t);
            }
            const byDay = new Map();
            for (const [, t] of firstSeen) {
                const k = new Date(t).toISOString().slice(0, 10);
                byDay.set(k, (byDay.get(k) || 0) + 1);
            }
            const burstDays = Array.from(byDay.entries())
                .filter(([, n]) => n >= 5)
                .sort((a, b) => b[1] - a[1]);
            if (burstDays.length > 0) {
                const top = burstDays[0];
                out.push({
                    id: 'new-contact-burst',
                    severity: top[1] >= 10 ? 'high' : 'med',
                    title: `New-contact burst: ${burstDays.length} day${burstDays.length === 1 ? '' : 's'}`,
                    summary: `Peak: ${top[1]} new contacts first-seen on ${top[0]}`,
                    detail: burstDays.slice(0, 4).map(([d, n]) => `${d}: ${n}`).join(' · '),
                    action: { tab: 'sms', search: '' },
                });
            }
        }

        // ─── Rule 5 — Geo outlier (>100 km from main cluster) ───
        const gpsPoints = [];
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            gpsPoints.push({ lat, lng, ref: m });
        }
        if (gpsPoints.length >= 5) {
            const clusters = this._clusterPoints(gpsPoints, 0.5);
            if (clusters.length >= 2) {
                const main = clusters[0];
                // find farthest cluster centroid from main
                let far = null, farDist = 0;
                for (let i = 1; i < clusters.length; i++) {
                    const c = clusters[i];
                    const km = this._haversineKm(main.lat, main.lng, c.lat, c.lng);
                    if (km > farDist) { farDist = km; far = c; }
                }
                if (far && farDist >= 100) {
                    out.push({
                        id: 'geo-outlier',
                        severity: farDist >= 500 ? 'high' : 'med',
                        title: `Geo outlier: ${Math.round(farDist)} km from main cluster`,
                        summary: `${far.items.length} GPS-tagged item${far.items.length === 1 ? '' : 's'} far from primary location`,
                        detail: `Main: ${main.lat.toFixed(2)}, ${main.lng.toFixed(2)} (${main.items.length} items) · Outlier: ${far.lat.toFixed(2)}, ${far.lng.toFixed(2)}`,
                        action: { tab: 'media', search: '' },
                    });
                }
            }
        }

        return out;
    }

    /** Great-circle distance in kilometers between two lat/lng. */
    _haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
                * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // ─── analytics helpers ─────────────────────────────────────

    /**
     * Aggregate message + call counts by normalized address.
     * Returns sorted desc by count.
     */
    _addressCounts(sms, calls) {
        const by = new Map();
        const add = (addr, n) => {
            const k = this._normPhone(addr);
            if (!k) return;
            const prev = by.get(k) || { address: addr, count: 0 };
            prev.count += n;
            // Prefer the most "human" address rendering (longer wins ties).
            if ((addr || '').length > (prev.address || '').length) prev.address = addr;
            by.set(k, prev);
        };
        for (const m of (sms || [])) {
            const a = m.address || m.from || m.to;
            if (a) add(String(a), 1);
        }
        for (const c of (calls || [])) {
            const a = c.address || c.number || c.contact;
            if (a) add(String(a), 1);
        }
        return Array.from(by.values()).sort((a, b) => b.count - a.count);
    }

    _normPhone(s) {
        if (!s) return '';
        const digits = String(s).replace(/\D/g, '');
        if (digits.length >= 10) return digits.slice(-10);
        return digits || String(s).toLowerCase();
    }

    /** Earliest → latest span across timestamps in messages array. */
    _messageSpan(messages) {
        let lo = Infinity, hi = -Infinity;
        for (const m of (messages || [])) {
            const ts = m.timestamp || m.timestampMs || m.dateMs || m.date;
            const t = ts ? (typeof ts === 'number' ? ts : Date.parse(ts)) : NaN;
            if (!isFinite(t)) continue;
            if (t < lo) lo = t;
            if (t > hi) hi = t;
        }
        if (!isFinite(lo) || !isFinite(hi)) return { days: 0 };
        const days = Math.max(1, Math.round((hi - lo) / (1000 * 60 * 60 * 24)));
        return { days };
    }

    /** Simple distance-based clustering — 0.5 deg ≈ 55km. Good enough for top-N. */
    _clusterPoints(points, eps) {
        const used = new Array(points.length).fill(false);
        const clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (used[i]) continue;
            const cluster = { lat: points[i].lat, lng: points[i].lng, items: [points[i].ref] };
            used[i] = true;
            for (let j = i + 1; j < points.length; j++) {
                if (used[j]) continue;
                const dLat = Math.abs(points[j].lat - cluster.lat);
                const dLng = Math.abs(points[j].lng - cluster.lng);
                if (dLat < eps && dLng < eps) {
                    cluster.items.push(points[j].ref);
                    used[j] = true;
                }
            }
            clusters.push(cluster);
        }
        clusters.sort((a, b) => b.items.length - a.items.length);
        return clusters;
    }

    /**
     * Mount an interactive Leaflet map inside the Coach drawer's Geo panel.
     * Reuses the same icon/color conventions as the Movement pane map.
     */
    _mountGeoMap(drawer, imp) {
        const host = drawer.querySelector('#cellebriteCoachGeoMap');
        if (!host) return;
        if (typeof L === 'undefined' || typeof L.map !== 'function') {
            host.innerHTML = '<div style="padding:12px;color:#fbbf24;font-size:12px">Leaflet not loaded — map unavailable.</div>';
            return;
        }
        const bucket = this._cache.get(imp.id) || {};
        const media = (bucket.media && Array.isArray(bucket.media.items)) ? bucket.media.items : [];
        const pts = [];
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            pts.push({ lat, lng, ref: m });
        }
        if (!pts.length) return;

        const map = L.map(host, {
            zoomControl: true,
            attributionControl: false,
            preferCanvas: false,
        }).setView([pts[0].lat, pts[0].lng], 10);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap',
        }).addTo(map);

        const group = (typeof L.markerClusterGroup === 'function')
            ? L.markerClusterGroup({
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                maxClusterRadius: 40,
            })
            : L.layerGroup();

        for (const p of pts) {
            const m = p.ref;
            const dot = L.circleMarker([p.lat, p.lng], {
                radius: 6,
                color: '#a78bfa',
                weight: 2,
                fillColor: '#8b5cf6',
                fillOpacity: 0.7,
            });
            const cap = m.capturedAt || m.createdAt || m.modifiedAt;
            const when = cap ? new Date(typeof cap === 'number' ? cap : Date.parse(cap)).toLocaleString() : '—';
            const safeName = this._esc(m.filename || '(unnamed)');
            const osmUrl = `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lng.toFixed(5)}#map=17/${p.lat.toFixed(5)}/${p.lng.toFixed(5)}`;
            dot.bindPopup(`
                <div style="min-width:200px;color:#e5e7eb">
                    <div style="font-weight:600;margin-bottom:4px;word-break:break-all">${safeName}</div>
                    <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">📅 ${this._esc(when)}</div>
                    <div style="font-family:monospace;font-size:10px;color:#9ca3af;margin-bottom:6px">
                        ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
                    </div>
                    <a href="${osmUrl}" target="_blank" rel="noopener"
                       style="font-size:11px;color:#a78bfa;text-decoration:none">↗ Open in OSM</a>
                </div>
            `, { closeButton: true, autoPan: true });
            dot.on('click', () => dot.openPopup());
            dot.on('mouseover', () => { try { dot.setStyle({ radius: 8 }); } catch (_) {} });
            dot.on('mouseout',  () => { try { dot.setStyle({ radius: 6 }); } catch (_) {} });
            group.addLayer(dot);
        }

        map.addLayer(group);

        try {
            const bounds = group.getBounds && group.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                if (pts.length === 1) map.setView([pts[0].lat, pts[0].lng], 13);
                else map.fitBounds(bounds.pad(0.15));
            }
        } catch (_) {}

        this._geoMap = map;
        setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 80);
    }

    _destroyGeoMap() {
        if (this._geoMap) {
            try { this._geoMap.remove(); } catch (_) {}
            this._geoMap = null;
        }
    }

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

if (typeof window !== 'undefined') {
    window.CellebriteCoach = CellebriteCoach;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CellebriteCoach;
}
