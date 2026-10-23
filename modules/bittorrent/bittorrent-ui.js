/**
 * BitTorrent tab (Torrential Downpour) — UI shell.
 * Import list + import/parse progress + at-a-glance for the selected
 * download. The full download card (sessions, files, netstat) is built on
 * top of this in renderDetail().
 */
(function (root) {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (n) => (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString();
    const bytes = (b) => {
        if (b == null || isNaN(b)) return '—';
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(b);
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return (i ? v.toFixed(1) : v) + ' ' + u[i];
    };
    const gmt = (min) => {
        if (min == null) return '';
        const s = min < 0 ? '-' : '+', a = Math.abs(min);
        return `GMT${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    };

    class BitTorrentUI {
        constructor(containerId, module) {
            this.containerId = containerId;
            this.module = module;
            this.state = this._readState();
            if (!this.state.open || typeof this.state.open !== 'object') this.state.open = {};
            if (!this.state.views || typeof this.state.views !== 'object') this.state.views = {};
            const keep = this.state.selectedId && module.imports.some(x => x.id === this.state.selectedId) ? this.state.selectedId : null;
            this.selectedId = keep || (module.imports.length ? module.imports[module.imports.length - 1].id : null);
            this.progress = null; // { label, phase, pct, text }
            this._gridGen = 0;    // bumps on every grid redraw; stale thumbnail loads stop
            this.resume();
            if (!BitTorrentUI._scrollHooked && typeof root.addEventListener === 'function') {
                BitTorrentUI._scrollHooked = true;
                root.addEventListener('scroll', () => { const ui = root.bitTorrentUI; if (ui && ui._onScroll) ui._onScroll(); }, true);
            }
        }

        // ── Pick up where the officer left off (per case: selection, open sections, file filters, scroll) ──
        get _stateKey() { return `viperBtUi_${this.module && this.module.caseId}`; }
        _readState() { try { return JSON.parse(root.localStorage.getItem(this._stateKey)) || {}; } catch (_) { return {}; } }
        _writeState() {
            clearTimeout(this._stTimer);
            this._stTimer = setTimeout(() => {
                const ids = new Set((this.module.imports || []).map(x => x.id));
                Object.keys(this.state.views).forEach(k => { if (!ids.has(k)) delete this.state.views[k]; });
                try { root.localStorage.setItem(this._stateKey, JSON.stringify(this.state)); } catch (_) { /* quota — not critical */ }
            }, 150);
        }
        /** Called on construction and whenever the tab is shown again: restore the scroll once the card is drawn. */
        resume() { this._pendingScroll = typeof this.state.scroll === 'number' ? this.state.scroll : null; }
        _scroller() {
            let n = this.el && this.el.parentElement;
            while (n && n !== document.body) {
                const oy = root.getComputedStyle ? root.getComputedStyle(n).overflowY : '';
                if (/(auto|scroll)/.test(oy) && n.scrollHeight > n.clientHeight) return n;
                n = n.parentElement;
            }
            return document.scrollingElement || document.documentElement;
        }
        _onScroll() {
            const el = this.el;
            if (!el || !el.isConnected || !el.offsetParent || this._pendingScroll != null) return;
            const now = Date.now();
            if (now - (this._lastScrollSave || 0) < 250) { clearTimeout(this._scTimer); this._scTimer = setTimeout(() => this._onScroll(), 260); return; }
            this._lastScrollSave = now;
            const sc = this._scroller();
            if (sc) { this.state.scroll = Math.round(sc.scrollTop); this._writeState(); }
        }
        _applyScroll(final) {
            if (this._pendingScroll == null) return;
            const sc = this._scroller();
            if (sc) sc.scrollTop = this._pendingScroll;
            if (final) this._pendingScroll = null;
        }

        get el() { return document.getElementById(this.containerId); }

        _toast(msg, type) {
            if (typeof root.viperToast === 'function') root.viperToast(msg, type || 'info');
            else if (typeof root.showToast === 'function') root.showToast(msg, type || 'info');
            else console.log('[BitTorrent]', msg);
        }

        async _confirm(html, okText) {
            if (typeof root.viperConfirm === 'function') return root.viperConfirm(html, { okText: okText || 'OK' });
            return root.confirm(String(html).replace(/<[^>]+>/g, ''));
        }

        render() {
            const el = this.el;
            if (!el) return;
            const m = this.module;
            el.innerHTML = `
            <div class="btt-wrap">
                <div class="btt-head">
                    <div class="btt-title">
                        <span class="btt-title-icon">🧲</span>
                        <div>
                            <div class="btt-title-main">BitTorrent</div>
                            <div class="btt-title-sub">Torrential Downpour downloads for this case</div>
                        </div>
                    </div>
                    <div class="btt-actions">
                        <button class="btt-btn" data-act="find" ${m.job ? 'disabled' : ''} title="Torrential Downpour folders already on this case's Evidence tab">🔎 Find in Evidence</button>
                        <button class="btt-btn primary" data-act="import" ${m.job ? 'disabled' : ''} title="Pick a Torrential Downpour folder; it is copied into this case and added to Evidence">📂 Import TD folder</button>
                    </div>
                </div>
                <div id="btt-evidence-hint">${this._evidenceHintHtml()}</div>
                <div id="btt-progress">${this._progressHtml()}</div>
                ${m.imports.length ? `
                <div class="btt-body">
                    <div class="btt-list">${m.imports.map(i => this._listItemHtml(i)).join('')}</div>
                    <div class="btt-detail" id="btt-detail"></div>
                </div>` : this._emptyHtml()}
            </div>`;
            el.onclick = (e) => this._onClick(e);
            el.oninput = (e) => this._onInput(e);
            if (m.imports.length) this.renderDetail();
        }

        _emptyHtml() {
            return `<div class="btt-empty">
                <div class="btt-empty-icon">🧲</div>
                <div class="btt-empty-title">No Torrential Downpour downloads yet</div>
                <div class="btt-empty-text">Import the download folder Torrential Downpour created (the folder named after the suspect IP, or the dated download folder inside it).
                VIPER reads the Logs folder — summary.txt, details.txt, torrentinfo.txt and netstat.txt — and copies the download into this case's Evidence.
                If the folder is already on the Evidence tab, use <b>Find in Evidence</b>.</div>
            </div>`;
        }

        _evidenceHintHtml() {
            const pending = this.module.evidenceCandidates().filter(c => !c.alreadyImported);
            if (!pending.length || this.module.job) return '';
            return `<div class="btt-hint">📎 ${pending.length} Torrential Downpour download${pending.length > 1 ? 's' : ''} on the Evidence tab ${pending.length > 1 ? 'are' : 'is'} not on this tab yet.
                <button class="btt-link" data-act="find">Review</button></div>`;
        }

        renderEvidenceHint() {
            const h = document.getElementById('btt-evidence-hint');
            if (h) h.innerHTML = this._evidenceHintHtml();
        }

        _progressHtml() {
            const p = this.progress;
            if (!p) return '';
            return `<div class="btt-progress">
                <div class="btt-progress-row">
                    <span class="btt-progress-label">${esc(p.label)}</span>
                    <span class="btt-progress-text">${esc(p.text || '')}</span>
                    <button class="btt-btn small" data-act="cancel">Cancel</button>
                </div>
                <div class="btt-bar"><div class="btt-bar-fill" style="width:${Math.max(0, Math.min(100, p.pct || 0)).toFixed(1)}%"></div></div>
            </div>`;
        }

        _setProgress(p) {
            this.progress = p;
            const box = document.getElementById('btt-progress');
            if (box) box.innerHTML = this._progressHtml();
        }

        _onProgress(label, p) {
            if (!p) return;
            let pct = 0, text = '';
            if (p.phase === 'logs') {
                pct = p.bytesTotal ? (p.bytesDone / p.bytesTotal) * 100 : 0;
                text = `Reading ${p.file || 'logs'} — ${num(p.lines)} lines`;
            } else if (p.phase === 'copy') {
                pct = p.bytesTotal ? (p.bytesDone / p.bytesTotal) * 100 : (p.filesTotal ? p.filesDone / p.filesTotal * 100 : 0);
                text = `Copying into the case — ${num(p.filesDone)} of ${num(p.filesTotal)} files (${bytes(p.bytesDone)} of ${bytes(p.bytesTotal)})`;
            } else if (p.phase === 'save') {
                pct = 100; text = 'Saving…';
            } else return;
            this._setProgress({ label, phase: p.phase, pct, text });
        }

        _listItemHtml(i) {
            const s = i.summary || {};
            const sel = i.id === this.selectedId ? ' selected' : '';
            const pieces = s.piecesWritten != null ? s.piecesWritten : s.piecesDownloaded;
            const vf = i.verify;
            const vmark = !vf || !vf.withHash ? '' : (!vf.mismatched && !vf.missing && !vf.unreadable)
                ? ` · <span class="btt-ok" title="Files on disk match the TD hashes">✓ hashes</span>`
                : ` · <span class="btt-bad" title="Some files on disk do not match the TD hashes">⚠ hashes</span>`;
            return `<button class="btt-item${sel}" data-act="select" data-id="${esc(i.id)}">
                <div class="btt-item-ip">${esc(i.ip || 'Unknown IP')}${i.port ? `<span class="btt-dim">:${esc(i.port)}</span>` : ''}${i.teredo ? ' <span class="btt-tag">Teredo</span>' : ''}</div>
                <div class="btt-item-when">${esc(i.startedAt || '—')} ${esc(gmt(i.gmtOffsetMin))}</div>
                <div class="btt-item-stats">${num(pieces)} piece${pieces === 1 ? '' : 's'} · ${num(s.connected)} of ${num(s.attempts)} connected${i.warnings ? ` · <span class="btt-warn">⚠ ${i.warnings}</span>` : ''}${vmark}</div>
            </button>`;
        }

        _row(label, value) {
            return `<div class="btt-kv"><div class="btt-k">${esc(label)}</div><div class="btt-v">${value}</div></div>`;
        }

        async renderDetail() {
            const box = document.getElementById('btt-detail');
            const i = this.module.imports.find(x => x.id === this.selectedId) || this.module.imports[this.module.imports.length - 1];
            if (!box || !i) return;
            this.selectedId = i.id;
            this._rememberSelection();
            box.innerHTML = `
                <div class="btt-card">
                    <div id="btt-card-head">${this._cardHeadHtml(i)}</div>
                    <div id="btt-arin">${this._arinHtml(i)}</div>
                    <div id="btt-card-body"><span class="btt-dim">Loading parsed logs…</span></div>
                </div>`;
            let model;
            try {
                model = await this.module.loadModel(i.id);
            } catch (err) {
                const b = document.getElementById('btt-card-body');
                if (b) b.innerHTML = `<div class="btt-bad">${esc(err.message || err)}</div>`;
                this._pendingScroll = null;
                return;
            }
            if (this.selectedId !== i.id) return;
            this.model = model;
            const sv = this.state.views[i.id];
            this.fileView = { q: (sv && typeof sv.q === 'string') ? sv.q : '', status: (sv && typeof sv.status === 'string') ? sv.status : '', page: (sv && sv.page > 0) ? sv.page : 0 };
            this.media = null;
            const body = document.getElementById('btt-card-body');
            if (body) body.innerHTML = this._cardBodyHtml(i, model);
            this._applyScroll(false);
            await this._loadMedia(i.id);
            this._applyScroll(true);
        }

        _rememberSelection() {
            if (this.state.selectedId !== this.selectedId) { this.state.selectedId = this.selectedId; this._writeState(); }
        }

        _rememberFileView() {
            if (!this.selectedId || !this.fileView) return;
            const { q, status, page } = this.fileView;
            this.state.views[this.selectedId] = { q: String(q || '').slice(0, 200), status: status || '', page: page || 0 };
            this._writeState();
        }

        _cardHeadHtml(i) {
            return `<div class="btt-card-head">
                <div>
                    <div class="btt-card-ip">${esc(i.ip || 'Unknown IP')}${i.port ? `<span class="btt-dim">:${esc(i.port)}</span>` : ''}${i.teredo ? ' <span class="btt-tag">Teredo</span>' : ''}</div>
                    <div class="btt-dim">${esc(i.location || '')}</div>
                </div>
                <div class="btt-card-actions">
                    <button class="btt-btn small" data-act="arin" data-id="${esc(i.id)}" ${i.ip ? '' : 'disabled'} title="ARIN WHOIS: which provider holds this address">🌐 ${i.arin ? 'ARIN again' : 'ARIN lookup'}</button>
                    <button class="btt-btn small" data-act="send" data-id="${esc(i.id)}" ${i.ip ? '' : 'disabled'} title="Add this IP address to a Suspect, Victim or Other Individual on this case">👤 Send to Suspect</button>
                    <button class="btt-btn small" data-act="notes" data-id="${esc(i.id)}" title="Add the suspect IP, ARIN result and BitTorrent software details to Case Notes">📝 Send to Notes</button>
                    <button class="btt-btn small danger" data-act="remove" data-id="${esc(i.id)}" title="Remove from this tab. Evidence files are not deleted.">Remove</button>
                </div>
            </div>`;
        }

        _arinHtml(i) {
            const a = i && i.arin;
            if (!a) return '';
            const parts = [a.org && a.org !== a.provider ? a.org : '', a.netRange || a.network, a.country].filter(Boolean).map(esc);
            return `<div class="btt-arin"><span class="btt-arin-k">ARIN</span> <b>${esc(a.provider || a.org)}</b>${parts.length ? ' · ' + parts.join(' · ') : ''}
                <span class="btt-dim"> — ${esc(a.ip)} looked up ${esc(String(a.lookedUpAt || '').slice(0, 16).replace('T', ' '))}</span></div>`;
        }

        /** "2026-10-19 23:37:05 GMT-07:00" + UTC on hover. */
        _t(local, off) {
            if (!local) return '—';
            const TM = root.TdModel;
            const utc = TM && off != null ? TM.localToUtc(local, off) : null;
            return `<span title="${utc ? esc(utc + ' UTC') : ''}">${esc(local)}</span>`;
        }

        _cardBodyHtml(i, m) {
            const TM = root.TdModel || {};
            const s = m.summary || {};
            const d = m.download || {};
            const t = m.torrent || {};
            const r = m.remote || {};
            const off = d.gmtOffsetMin;
            const st = m.storage || i.storage || {};
            const storage = st.mode === 'copy' ? 'Copied into this case (Evidence → BitTorrent)'
                : st.mode === 'case' ? 'In this case\'s Evidence folder' : 'Linked — files stay where they are';
            const utc = (x) => (x && off != null && TM.localToUtc) ? `<div class="btt-dim">${esc(TM.localToUtc(x, off))} UTC</div>` : '';
            const ours = ((m.investigator && m.investigator.publicIps) || []).map(x => `${esc(x.ip)} <span class="btt-dim">(${num(x.sessions)})</span>`).join(', ');
            const reported = [r.reportedIPv4, r.reportedIPv6].filter(Boolean).map(esc).join(', ');
            const glance = `
                <div class="btt-grid">
                    ${this._row('Download started', `${this._t(d.startedAt, off)} <span class="btt-dim">${esc(gmt(off))}</span>${utc(d.startedAt)}`)}
                    ${this._row('Download ended', `${this._t(d.endedAt, off)} <span class="btt-dim">${esc(gmt(off))}</span>${utc(d.endedAt)}`)}
                    ${this._row('Length', esc(TM.formatDuration ? TM.formatDuration(s.durationSec) || '—' : '—'))}
                    ${this._row('Tool', esc(i.tool || '—'))}
                    ${this._row('Torrent', t.name ? esc(t.name) : '<span class="btt-dim">Name not recorded in these logs</span>')}
                    ${this._row('Info hash', `<code>${esc(t.infoHash || '—')}</code>`)}
                    ${this._row('Files in torrent', `${num(t.fileCount)}${t.totalBytes ? ' · ' + bytes(t.totalBytes) : ''}`)}
                    ${this._row('Pieces', `${num(t.pieceCount)}${t.pieceSize ? ' × ' + bytes(t.pieceSize) : ''}`)}
                    ${this._row('Client', esc((s.clients || []).map(c => c.label).join(', ') || '—'))}
                    ${r.teredo ? this._row('Teredo', `${esc(r.teredo.ipv6 || r.ip)} → <b>${esc(r.teredo.ipv4)}</b>`) : ''}
                    ${reported ? this._row('Suspect\'s client reported its IP as', reported) : ''}
                    ${ours ? this._row('Our public IP as seen by suspect', ours) : ''}
                    ${this._row('Connections', `${num(s.connected)} connected of ${num(s.attempts)} attempts · ${num(s.handshakes)} handshakes · ${num(s.sessionsWithData)} with data`)}
                    ${this._row('Download result', esc(s.outcome || '—'))}
                    ${this._row('Ended because', esc(s.endReason || '—'))}
                    ${this._row('Stored', esc(storage))}
                </div>`;
            return this._clientHtml(m) + glance +
                `<div class="btt-sec-all"><button class="btt-link" data-act="secall" data-open="1">Expand all</button> · <button class="btt-link" data-act="secall" data-open="0">Collapse all</button></div>` +
                this._section('events', 'Key events', this._eventsHtml(m)) +
                this._section('possession', 'Possession', this._possessionHtml(m)) +
                this._section('sessions', `Sessions <span class="btt-dim">(${num((m.sessions || []).length)})</span>`, this._sessionsHtml(m)) +
                this._section('files', `Files <span class="btt-dim">(${num((m.files || []).length)})</span>`, `<div id="btt-verify">${this._verifyHtml()}</div><div id="btt-files">${this._filesHtml()}</div>`) +
                this._section('report', 'Report', `<div id="btt-report">${this._reportHtml()}</div>`) +
                this._section('netstat', 'Netstat corroboration', this._netstatHtml(m)) +
                this._section('logs', 'Logs read', this._sourcesHtml(m));
        }

        /** Collapsible section; every one starts closed and remembers its state per case. */
        _section(key, title, inner) {
            const open = !!this.state.open[key];
            return `<details class="btt-sec" data-sec="${key}"${open ? ' open' : ''}>
                <summary class="btt-sec-title" data-act="sec" data-sec="${key}"><span class="btt-sec-name">${title}</span><span class="btt-sec-btn" aria-hidden="true"></span></summary>
                <div class="btt-sec-body">${inner}</div></details>`;
        }

        _onSectionToggle(key, det) {
            // The click fires before <details> flips, so read the state on the next tick.
            setTimeout(() => {
                if (!det.isConnected) return;
                if (det.open) this.state.open[key] = true; else delete this.state.open[key];
                this._writeState();
                if (key === 'files' && det.open && this._viewMode() === 'grid') this._hydrateGrid();
            }, 0);
        }

        _setAllSections(open) {
            const el = this.el;
            if (!el) return;
            el.querySelectorAll('details.btt-sec').forEach(d => {
                const k = d.getAttribute('data-sec');
                d.open = open;
                if (open) this.state.open[k] = true; else delete this.state.open[k];
            });
            this._writeState();
            if (open && this._viewMode() === 'grid') this._hydrateGrid();
        }

        /** Top-of-card callout: which BitTorrent program the suspect ran, and what that means for the warrant. */
        _clientHtml(m) {
            const TM = root.TdModel || {};
            if (!TM.clientsSeen) return '';
            const seen = TM.clientsSeen(m.sessions || []).filter(c => c.handshakes > 0);
            if (!seen.length) return `<div class="btt-client none"><div class="btt-client-k">Suspect's BitTorrent software</div>
                <div class="btt-dim">No handshake in these logs, so the suspect's program did not identify itself.</div></div>`;
            const hash = ((m.torrent || {}).infoHash || '').toLowerCase();
            const icons = { windows: '🪟', macos: '🍎', linux: '🐧', android: '🤖', ios: '📱', nas: '🗄️', any: '🧩' };
            const L = TM.PLATFORM_LABELS || {};
            const main = seen[0];
            const p = main.profile;
            const chips = p ? p.platforms.map(k => `<span class="btt-chip">${icons[k] || ''} ${esc(L[k] || k)}</span>`).join('') : '';
            const look = p && p.look.length ? `<div class="btt-client-sub">What to look for when serving the warrant</div>
                <ul class="btt-client-look">
                    <li>The program itself (installed apps / Program Files / Applications) — ${esc(main.name || 'this client')}${main.version ? ' version ' + esc(main.version) : ''}</li>
                    ${p.look.map(x => `<li>${esc(x).replace(/\{hash\}/g, hash ? `<code>${esc(hash)}</code>` : 'the info hash')}</li>`).join('')}
                </ul>` : '';
            const others = seen.slice(1);
            const multi = others.length ? `<div class="btt-client-warn">⚠ ${others.length + 1} different BitTorrent programs answered from this IP:
                ${others.map(c => `<b>${esc(c.label)}</b> <span class="btt-dim">(${num(c.handshakes)} handshake${c.handshakes === 1 ? '' : 's'}${c.dataSessions ? ', ' + num(c.dataSessions) + ' with data' : ''})</span>`).join(', ')}.
                ${others.some(c => c.code === main.code) ? 'The same program at a different version can mean it was updated during the download. ' : ''}Different programs can mean more than one device behind the same router.</div>` : '';
            return `<div class="btt-client">
                <div class="btt-client-top">
                    <div>
                        <div class="btt-client-k">Suspect's BitTorrent software</div>
                        <div class="btt-client-name">${esc(main.name || main.tag || 'Unknown client')}${main.version ? ` <span class="btt-client-ver">${esc(main.version)}</span>` : ''}</div>
                        <div class="btt-dim">${p ? esc(p.kind) : 'Not in VIPER\'s client list — search the peer ID prefix online.'}</div>
                    </div>
                    <div class="btt-client-proof">
                        Peer ID <code>${esc(main.tag || '—')}</code><br>
                        ${num(main.handshakes)} handshake${main.handshakes === 1 ? '' : 's'}${main.dataSessions ? ` · <b>${num(main.dataSessions)} with data</b>` : ''}${main.peerIds > 1 ? ` · <span title="Same program prefix each time; only the random tail of the peer ID changed between connections">${num(main.peerIds)} peer IDs (random tail changes per connection)</span>` : ''}<br>
                        ${main.firstAt ? 'First ' + this._t(main.firstAt, (m.download || {}).gmtOffsetMin) + ' ' : ''}${this._ref(main.firstRef)}
                    </div>
                </div>
                ${p ? `<div class="btt-client-row"><span class="btt-client-sub">Runs on</span> ${chips}</div>
                <div class="btt-client-row"><span class="btt-client-sub">Likely device</span> ${esc(p.device)}</div>` : ''}
                ${look}
                ${multi}
                <div class="btt-help">The program name and version come from the peer ID the suspect's software sent in the handshake. It is self-reported and can be faked, and default folders can be changed, so confirm on the device. "Runs on" lists the platforms the program is published for.</div>
            </div>`;
        }

        _ref(ref) { return ref ? `<span class="btt-ref" title="Log file : line">${esc(ref)}</span>` : ''; }

        /** The moments an officer quotes: start, first/last handshake, every data session, end. */
        keyEvents(m) {
            const TM = root.TdModel || {};
            const ss = m.sessions || [];
            const d = m.download || {};
            const c = m.closing || {};
            const ev = [];
            const cl = (x) => (TM.clientLabel ? TM.clientLabel(x) : '') || '';
            if (d.startedAt) ev.push({ at: d.startedAt, text: 'Download started', ref: d.ref });
            if (ss[0]) ev.push({ at: ss[0].attemptAt, text: `First connection attempt (session #${ss[0].n})`, ref: ss[0].ref });
            const hs = ss.filter(x => x.handshake);
            if (hs[0]) ev.push({ at: hs[0].handshakeAt || hs[0].connectedAt, text: `First handshake completed (session #${hs[0].n})${cl(hs[0]) ? ' — ' + cl(hs[0]) : ''}`, ref: hs[0].ref });
            const data = ss.filter(x => (x.piecesDownloaded || 0) > 0);
            data.slice(0, 25).forEach(x => {
                ev.push({ at: x.handshakeAt || x.connectedAt || x.attemptAt, text: `Handshake — session #${x.n} starts${cl(x) ? ' (' + cl(x) + ')' : ''}; suspect reported having ${x.have != null ? num(x.have) + ' of ' + num(x.haveOf) : 'an unknown number of'} pieces`, ref: x.ref, strong: true });
                ev.push({ at: x.endedAt, text: `Session #${x.n} ends — ${num(x.piecesDownloaded)} piece${x.piecesDownloaded === 1 ? '' : 's'} downloaded and written${x.endReason ? '. ' + x.endReason : ''}`, strong: true });
            });
            if (data.length > 25) ev.push({ at: data[25].attemptAt, text: `…${data.length - 25} more sessions moved data (see Sessions)` });
            const lastHs = hs[hs.length - 1];
            if (lastHs && lastHs !== hs[0]) ev.push({ at: lastHs.handshakeAt || lastHs.connectedAt, text: `Last handshake completed (session #${lastHs.n})`, ref: lastHs.ref });
            const last = ss[ss.length - 1];
            if (last && last.endedAt) ev.push({ at: last.endedAt, text: `Last session ended (#${last.n})${last.endReason ? ' — ' + last.endReason : (last.failReason ? ' — no answer: ' + last.failReason : '')}` });
            const why = (c.limits && c.limits[0]) || c.stopReason || (c.outcome ? 'The download was ' + c.outcome : '');
            if (d.endedAt) ev.push({ at: d.endedAt, text: `Download ended${why ? ' — ' + why : ''}`, ref: c.ref });
            return ev.filter(e => e.at).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        }

        _eventsHtml(m) {
            const off = (m.download || {}).gmtOffsetMin;
            const TM = root.TdModel || {};
            const ev = this.keyEvents(m);
            if (!ev.length) return '<div class="btt-dim">No timed events in these logs.</div>';
            return `<table class="btt-table btt-events"><thead><tr><th>Local time <span class="btt-dim">${esc(gmt(off))}</span></th><th>UTC</th><th>What the log shows</th><th>Source</th></tr></thead><tbody>
                ${ev.map(e => `<tr class="${e.strong ? 'btt-strong' : ''}"><td class="btt-nowrap">${esc(e.at)}</td><td class="btt-nowrap btt-dim">${esc(off != null && TM.localToUtc ? TM.localToUtc(e.at, off) || '' : '')}</td><td>${esc(e.text)}</td><td>${this._ref(e.ref)}</td></tr>`).join('')}
            </tbody></table>`;
        }

        _possessionHtml(m) {
            const s = m.summary || {};
            const c = m.closing || {};
            const t = m.torrent || {};
            const of = t.pieceCount || s.haveOf || null;
            const rep = c.acknowledged ? c.acknowledged.n : (s.maxHave != null ? s.maxHave : s.acknowledged);
            const got = s.piecesWritten;
            const pct = (n) => (of && n != null) ? Math.max(0, Math.min(100, n / of * 100)) : 0;
            const bar = (label, n, cls, note) => `<div class="btt-barrow"><div class="btt-barlabel">${label}</div>
                <div class="btt-bar big"><div class="btt-bar-fill ${cls}" style="width:${pct(n).toFixed(1)}%"></div></div>
                <div class="btt-barval">${num(n)}${of ? ' of ' + num(of) : ''}${of && n != null ? ` <span class="btt-dim">(${pct(n).toFixed(1)}%)</span>` : ''}${note ? ' ' + note : ''}</div></div>`;
            const f = s.files || {};
            const v = c.validation;
            const val = !v ? '<span class="btt-dim">No validation result in these logs.</span>'
                : v.allValid ? `<span class="btt-ok">✓ ${v.count ? 'All ' + num(v.count) + ' written pieces' : 'Every written piece'} matched the expected SHA-1 hash.</span> ${this._ref(v.ref)}`
                    : `<span class="btt-bad">✗ ${num(v.failures ? v.failures.length : 0)} piece(s) failed SHA-1 validation.</span> ${this._ref(v.ref)}`;
            return `${bar('Suspect reported having', rep, 'rep', c.acknowledged ? this._ref(c.acknowledged.ref) : '')}
                ${bar('Downloaded from suspect', got, 'got', '')}
                <div class="btt-grid">
                    ${this._row('Files fully downloaded', `${num(f.complete)} of ${num(f.total)}${f.incomplete ? ` · ${num(f.incomplete)} partial` : ''}${f.none ? ` · ${num(f.none)} none` : ''}${f.unknown ? ` · <span class="btt-dim">${num(f.unknown)} no result in log</span>` : ''}`)}
                    ${this._row('Files suspect reported complete', c.filesReported ? `${num(c.filesReported.n)} of ${num(c.filesReported.of)} ${this._ref(c.filesReported.ref)}` : '—')}
                    ${this._row('Piece validation', val)}
                    ${c.acknowledgedRanges ? this._row('Pieces acknowledged (all sessions)', `<span class="btt-ranges">${esc(this._clip(c.acknowledgedRanges, 400))}</span>`) : ''}
                    ${c.writtenRanges ? this._row('Pieces written', `<span class="btt-ranges">${esc(this._clip(c.writtenRanges, 400))}</span>`) : ''}
                    ${s.acknowledgedAllNoData ? this._row('Note', '<span class="btt-warn">The suspect reported having every piece but no data was downloaded.</span>') : ''}
                </div>`;
        }

        _clip(str, n) { str = String(str || ''); return str.length > n ? str.slice(0, n) + '…' : str; }

        _sessionEnd(x) {
            if (x.result === 'failed') return 'No answer' + (x.failReason ? ': ' + x.failReason : '');
            if (x.endReason) return x.endReason;
            if (x.piecesDownloaded != null) return 'Session completed';
            return '—';
        }

        _sessionsHtml(m) {
            const TM = root.TdModel || {};
            const groups = TM.groupSessions ? TM.groupSessions(m.sessions || []) : [];
            this._groups = groups;
            if (!groups.length) return '<div class="btt-dim">No sessions in these logs.</div>';
            return `<div class="btt-dim btt-help">Consecutive sessions that ended the same way are grouped. Sessions that moved data are always on their own line. Click a line for every session in it, with handshake and end times.</div>
                ${groups.map((g, k) => `<details class="btt-grp${g.hasData ? ' data' : ''}" data-g="${k}">
                    <summary data-act="grp" data-g="${k}">
                        <span class="btt-grp-n">${g.count > 1 ? `#${g.firstN}–#${g.lastN} <span class="btt-dim">(${num(g.count)})</span>` : `#${g.firstN}`}</span>
                        <span class="btt-grp-when">${esc(g.from || '—')} → ${esc(g.to || '—')}</span>
                        <span class="btt-grp-what">${g.hasData ? `<b>${num(g.piecesDownloaded)} pieces downloaded</b>` : esc(g.label)}</span>
                        <span class="btt-grp-have">${g.have != null ? `had ${num(g.have)} of ${num(g.haveOf)}` : ''}</span>
                    </summary>
                    <div class="btt-grp-body"></div>
                </details>`).join('')}`;
        }

        _groupBodyHtml(k) {
            const g = this._groups && this._groups[k];
            const m = this.model;
            if (!g || !m) return '';
            const TM = root.TdModel || {};
            const byN = new Map((m.sessions || []).map(x => [x.n, x]));
            const rows = g.sessions.slice(0, 500).map(n => byN.get(n)).filter(Boolean);
            const len = (x) => TM.secondsBetween && TM.formatDuration ? TM.formatDuration(TM.secondsBetween(x.handshakeAt || x.connectedAt || x.attemptAt, x.endedAt)) : '';
            return `<table class="btt-table btt-sessions"><thead><tr><th>#</th><th>Attempt</th><th>Connected</th><th>Handshake</th><th>Ended</th><th>Length</th><th>How it ended</th><th>Client</th><th>Enc.</th><th>Had</th><th>Pieces</th><th>Source</th></tr></thead><tbody>
                ${rows.map(x => `<tr class="${(x.piecesDownloaded || 0) > 0 ? 'btt-strong' : ''}">
                    <td>${x.n}</td><td class="btt-nowrap">${esc(x.attemptAt || '—')}</td><td class="btt-nowrap">${esc(x.connectedAt || '—')}</td>
                    <td class="btt-nowrap">${x.handshake ? esc(x.handshakeAt || x.connectedAt || '✓') : '—'}</td><td class="btt-nowrap">${esc(x.endedAt || '—')}</td>
                    <td class="btt-nowrap">${esc(len(x) || '')}</td><td>${esc(this._sessionEnd(x))}</td>
                    <td>${esc((TM.clientLabel && TM.clientLabel(x)) || '')}${x.peerId ? `<div class="btt-dim btt-mono" title="Peer id">${esc(x.peerId)}</div>` : ''}</td>
                    <td>${x.encrypted ? '🔒' : ''}</td><td class="btt-nowrap">${x.have != null ? `${num(x.have)}/${num(x.haveOf)}` : ''}</td>
                    <td>${x.piecesDownloaded != null ? num(x.piecesDownloaded) : ''}</td><td>${this._ref(x.ref)}</td></tr>`).join('')}
            </tbody></table>${g.sessions.length > 500 ? `<div class="btt-dim">First 500 of ${num(g.sessions.length)} shown.</div>` : ''}`;
        }

        _filteredFiles() {
            const v = this.fileView || { q: '', status: '' };
            const q = String(v.q || '').toLowerCase();
            const vs = this._verifySets();
            return ((this.model && this.model.files) || []).filter(f => f &&
                (!v.status || (v.status === 'unknown' ? !f.status
                    : v.status === 'problem' ? (vs.mism.has(f.index) || vs.miss.has(f.index) || vs.unr.has(f.index))
                        : v.status === 'media' ? this._fileState(f).kind !== 'other'
                            : v.status === 'report' ? this._inReport(f.index)
                            : f.status === v.status)) &&
                (!q || String(f.path || f.name || '').toLowerCase().includes(q) || String(f.sha1 || '').includes(q) || String(f.md5 || '').includes(q) || String(f.index) === q));
        }

        // ── Downloaded files: on disk, blur, thumbnails, viewer, hash check (BT Phase 4) ──
        _verifySets() {
            const v = this.model && this.model.verify;
            if (this._vsetsFor === v && this._vsets) return this._vsets;
            this._vsetsFor = v;
            this._vsets = { mism: new Set((v && v.mismatched) || []), miss: new Set((v && v.missing) || []), unr: new Set((v && v.unreadable) || []) };
            return this._vsets;
        }

        _fileState(f) {
            const name = String((f && (f.path || f.name)) || '');
            const kind = BitTorrentUI.kindOf(name);
            const od = this.media && this.media.onDisk;
            const onDisk = !!(od && f && Object.prototype.hasOwnProperty.call(od, f.index));
            const v = this.model && this.model.verify;
            const vs = this._verifySets();
            let verify = null;
            if (v && f) {
                if (vs.mism.has(f.index)) verify = 'mismatch';
                else if (vs.miss.has(f.index)) verify = 'missing';
                else if (vs.unr.has(f.index)) verify = 'unreadable';
                else if (f.sha1 && onDisk) verify = 'ok';
            }
            return { name, base: name.split(/[\\/]/).pop(), kind, onDisk, diskSize: onDisk ? od[f.index] : null, verify };
        }

        _blurOn() { try { return root.localStorage.getItem('viperBtBlur') !== '0'; } catch (_) { return true; } }
        _isBlurred(index) {
            return this._blurOn() && !BitTorrentUI.revealAll && !BitTorrentUI.revealed.has(this.selectedId + '|' + index);
        }
        _viewMode() { try { return root.localStorage.getItem('viperBtFilesView') === 'grid' ? 'grid' : 'table'; } catch (_) { return 'table'; } }

        _verifyHtml() {
            const md = this.media;
            const files = (this.model && this.model.files) || [];
            if (!md || md.loading) return '<div class="btt-verify btt-dim">Looking for the downloaded files…</div>';
            if (md.error) return `<div class="btt-verify btt-dim">${esc(md.error)}</div>`;
            if (!md.hasDownloadFolder) return '<div class="btt-verify btt-dim">These logs came without a Download folder, so there are no downloaded files to show or check.</div>';
            if (!md.folderFound) return '<div class="btt-verify btt-warn">The Download folder for this download can\'t be reached. It may be on a drive that isn\'t connected.</div>';
            const run = this.verifyRun && this.verifyRun.id === this.selectedId ? this.verifyRun : null;
            const found = `${num(md.matched)} of ${num(files.length)} torrent files are in the Download folder.`;
            if (run) {
                return `<div class="btt-verify"><div class="btt-progress-row"><span class="btt-progress-label">Checking SHA-1 hashes</span>
                    <span class="btt-progress-text">${esc(run.text || '')}</span><button class="btt-btn small" data-act="vcancel">Cancel</button></div>
                    <div class="btt-bar"><div class="btt-bar-fill" style="width:${Math.max(0, Math.min(100, run.pct || 0)).toFixed(1)}%"></div></div></div>`;
            }
            const v = this.model && this.model.verify;
            const busy = this.module.verifyJob ? 'disabled title="Another hash check is running"' : '';
            if (!v) {
                return `<div class="btt-verify">${found} <span class="btt-dim">Hashes not checked yet.</span>
                    <button class="btt-btn small" data-act="verify" ${busy}>#️⃣ Check SHA-1 hashes</button></div>`;
            }
            const when = esc(String(v.at || '').slice(0, 16).replace('T', ' '));
            const again = `<button class="btt-btn small" data-act="verify" ${busy}>Check again</button>`;
            if (!v.withHash) return `<div class="btt-verify">${found} <span class="btt-dim">The log has no SHA-1 values to compare.</span></div>`;
            const bad = v.mismatched.length + v.missing.length + v.unreadable.length;
            if (!bad) {
                return `<div class="btt-verify"><span class="btt-ok">✓ ${num(v.matched)} of ${num(v.withHash)} files on disk match the SHA-1 hashes in the TD log.</span>
                    <span class="btt-dim">${found} Checked ${when}.</span> ${again}</div>`;
            }
            const parts = [];
            if (v.mismatched.length) parts.push(`<b>${num(v.mismatched.length)}</b> different`);
            if (v.missing.length) parts.push(`<b>${num(v.missing.length)}</b> missing from the folder`);
            if (v.unreadable.length) parts.push(`<b>${num(v.unreadable.length)}</b> could not be read`);
            return `<div class="btt-verify"><span class="btt-bad">⚠ ${num(v.matched)} of ${num(v.withHash)} files match the TD hashes — ${parts.join(', ')}.</span>
                <button class="btt-link" data-act="vproblems">Show them</button> <span class="btt-dim">Checked ${when}.</span> ${again}</div>`;
        }

        _refreshVerify() {
            const box = document.getElementById('btt-verify');
            if (box) box.innerHTML = this._verifyHtml();
        }

        async _loadMedia(id) {
            this.media = { id, loading: true };
            this._refreshVerify();
            let r;
            try { r = await this.module.mediaList(id); } catch (err) { r = { success: false, error: err.message || String(err) }; }
            if (this.selectedId !== id) return;
            this.media = r && r.success
                ? { id, hasDownloadFolder: r.hasDownloadFolder, folderFound: r.folderFound, onDisk: r.onDisk || {}, matched: r.matched || 0 }
                : { id, error: (r && r.error) || 'Could not look for the downloaded files.' };
            if (r && r.success && r.verify && this.model) this.model.verify = r.verify;
            this._refreshVerify();
            this._refreshFiles();
        }

        _filesHtml() {
            const v = this.fileView || (this.fileView = { q: '', status: '', page: 0 });
            const list = this._filteredFiles();
            const grid = this._viewMode() === 'grid';
            const per = 100, pages = Math.max(1, Math.ceil(list.length / per));
            if (v.page >= pages) v.page = pages - 1;
            const rows = list.slice(v.page * per, v.page * per + per);
            const opt = (val, label) => `<option value="${val}" ${v.status === val ? 'selected' : ''}>${label}</option>`;
            const blur = this._blurOn();
            return `<div class="btt-files-bar">
                    <input id="btt-file-q" class="btt-input" placeholder="Search path, SHA-1, MD5 or #" value="${esc(v.q)}">
                    <select id="btt-file-status" class="btt-input">${opt('', 'All files')}${opt('media', 'Pictures and videos')}${opt('complete', 'Complete')}${opt('incomplete', 'Partial')}${opt('none', 'None')}${opt('unknown', 'No result in log')}${opt('problem', 'Hash problems')}${opt('report', 'In report')}</select>
                    <span class="btt-dim">${num(list.length)} file${list.length === 1 ? '' : 's'}</span>
                    <span class="btt-seg">
                        <button class="btt-btn small${grid ? '' : ' on'}" data-act="fview" data-v="table" title="Table">☰ Table</button>
                        <button class="btt-btn small${grid ? ' on' : ''}" data-act="fview" data-v="grid" title="Thumbnails">▦ Thumbnails</button>
                    </span>
                    ${grid ? `<label class="btt-blur-pref" title="Your setting: thumbnails start blurred. Click one to reveal it."><input type="checkbox" id="btt-blur-pref" ${blur ? 'checked' : ''}> Blur thumbnails</label>
                    ${blur ? `<button class="btt-btn small" data-act="revealall">${BitTorrentUI.revealAll ? '🙈 Blur all again' : '👁 Reveal all (this session)'}</button>` : ''}` : ''}
                    <span class="btt-pager">
                        <button class="btt-btn small" data-act="fpage" data-p="${v.page - 1}" ${v.page <= 0 ? 'disabled' : ''}>‹</button>
                        <span class="btt-dim">page ${v.page + 1} of ${pages}</span>
                        <button class="btt-btn small" data-act="fpage" data-p="${v.page + 1}" ${v.page >= pages - 1 ? 'disabled' : ''}>›</button>
                    </span>
                </div>
                ${grid ? this._gridHtml(rows) : this._tableHtml(rows)}`;
        }

        _statusBadge(f) {
            return f.status === 'complete' ? '<span class="btt-badge ok">complete</span>'
                : f.status === 'incomplete' ? `<span class="btt-badge part" title="${num(f.bytesWritten)} of ${num(f.size)} bytes">partial</span>`
                    : f.status === 'none' ? '<span class="btt-badge none">not downloaded</span>' : '<span class="btt-dim">—</span>';
        }

        _verifyBadge(st, f) {
            if (st.verify === 'mismatch') return '<span class="btt-badge bad" title="The file on disk does not match the SHA-1 in the TD log">✗ hash differs</span>';
            if (st.verify === 'missing') return '<span class="btt-badge bad" title="The log has a hash for this file but it is not in the Download folder">missing</span>';
            if (st.verify === 'unreadable') return '<span class="btt-badge bad">unreadable</span>';
            if (st.verify === 'ok') return '<span class="btt-badge ok" title="SHA-1 on disk matches the TD log">✓ hash</span>';
            if (this.media && this.media.onDisk && !st.onDisk && f.status && f.status !== 'none') return '<span class="btt-badge none" title="Not found in the Download folder">not on disk</span>';
            return '';
        }

        _tableHtml(rows) {
            return `<table class="btt-table btt-files"><thead><tr><th>#</th><th>Path in torrent</th><th>Size</th><th>Status</th><th>SHA-1</th><th>MD5</th><th>Report</th></tr></thead><tbody>
                ${rows.map(f => { const st = this._fileState(f); return `<tr><td>${f.index}</td><td class="btt-path">${esc(f.path || f.name || '')}</td><td class="btt-nowrap">${bytes(f.size)}</td><td>${this._statusBadge(f)} ${this._verifyBadge(st, f)}</td>
                    <td class="btt-mono" title="${esc(f.sha1b32 ? 'Base32 ' + f.sha1b32 : '')}">${esc(f.sha1 || '')}</td><td class="btt-mono">${esc(f.md5 || '')}</td><td class="btt-nowrap">${this._reportToggleHtml(f, st)}</td></tr>`; }).join('')}
                </tbody></table>`;
        }

        /** Only files that came from the suspect can go in the report. */
        _canReport(f, st) { return !!f && (f.status === 'complete' || f.status === 'incomplete' || (st || this._fileState(f)).onDisk); }

        _reportToggleHtml(f, st) {
            if (!this._canReport(f, st)) return '';
            const on = this._inReport(f.index);
            return `<button class="btt-btn small${on ? ' on' : ''}" data-act="rpt" data-i="${f.index}" title="${on ? 'In the Download Summary — click to take it out' : 'Add this file to the Download Summary with your description'}">${on ? '✓ In report' : '＋ Report'}</button>`;
        }

        _inReport(index) { return !!(this.module && this.module.isInReport && this.module.isInReport(this.selectedId, index)); }

        _setInReport(index, on) {
            this.module.setInReport(this.selectedId, index, on);
            this._refreshReport();
            this._refreshFiles();
            if (this._vw && this._vw.list[this._vw.at] === index) this._renderViewerReport(index);
        }

        _reportHtml() {
            const R = root.BtReport;
            const imp = this.module.imports.find(x => x.id === this.selectedId);
            const sel = R && imp ? R.selectedFiles(imp, this.model) : [];
            const missing = sel.filter(x => !x.description).length;
            const busy = this._outBusy ? 'disabled' : '';
            const rows = sel.map(x => {
                const f = x.file, st = this._fileState(f);
                const canView = st.onDisk && st.kind !== 'other';
                return `<div class="btt-rpt-item">
                    <div class="btt-rpt-head"><b>#${f.index}</b> <span class="btt-path">${esc(st.base)}</span> ${this._statusBadge(f)} ${this._verifyBadge(st, f)}
                        <span class="btt-rpt-acts">${canView ? `<button class="btt-btn small" data-act="rview" data-i="${f.index}">View</button>` : ''}
                        <button class="btt-btn small" data-act="rpt" data-i="${f.index}" title="Take this file out of the report">Remove</button></span></div>
                    <textarea class="btt-input btt-rpt-desc" data-rdesc="${f.index}" rows="2" placeholder="Describe what this ${st.kind === 'video' ? 'video' : st.kind === 'image' ? 'picture' : 'file'} shows, in your own words. This goes in the report.">${esc(x.description)}</textarea>
                </div>`;
            }).join('');
            return `<div class="btt-report-bar">
                    <button class="btt-btn" data-act="rpdf" ${busy} title="Text only: no images or video, no undercover IP addresses">📄 Download Summary PDF</button>
                    <button class="btt-btn" data-act="rdocx" ${busy} title="The same Download Summary as a Word document you can edit. Saved in the Reports tab.">📝 Word report (editable)</button>
                    <button class="btt-btn" data-act="rcsv" ${busy} title="Every file in the torrent with its SHA-1, Base32 and MD5">#️⃣ Hash list CSV</button>
                    <button class="btt-btn" data-act="rwa" ${busy} title="Add a facts paragraph to this case's Probable Cause in Warrant Author">⚖️ Send to Warrant Author</button>
                    ${this._outBusy && this._outLabel ? `<span class="btt-dim">${esc(this._outLabel)}</span>` : ''}
                </div>
                <div class="btt-help">The PDF and the Word report are text only. They never include pictures, video or the investigator's IP addresses. The PDF and the hash list are saved to the Evidence tab under “BitTorrent Reports”. The Word report is saved in the Reports tab (Microsoft Word), where you can open it again and keep editing — every save in Word goes back into the case.
                    Add files to the report with <b>＋ Report</b> on the Files list or in the viewer, then describe each one below.</div>
                ${sel.length ? `<div class="btt-sub">${num(sel.length)} file${sel.length === 1 ? '' : 's'} in the report${missing ? ` · <span class="btt-warn">${num(missing)} without a description</span>` : ''}</div>${rows}`
                    : '<div class="btt-dim">No files in the report yet.</div>'}`;
        }

        _refreshReport() {
            const box = document.getElementById('btt-report');
            if (!box) return;
            const a = document.activeElement;
            const keep = a && a.getAttribute && a.getAttribute('data-rdesc');
            const pos = keep != null ? a.selectionStart : null;
            box.innerHTML = this._reportHtml();
            if (keep != null) {
                const n = box.querySelector(`[data-rdesc="${Number(keep)}"]`);
                if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); }
            }
        }

        _saveDesc(index, text) {
            this.module.setReportDescription(this.selectedId, index, text);
            clearTimeout(this._descTimer);
            this._descTimer = setTimeout(() => {   // update the "without a description" count without stealing focus
                const R = root.BtReport;
                const imp = this.module.imports.find(x => x.id === this.selectedId);
                const sub = document.querySelector('#btt-report .btt-sub');
                if (!sub || !R || !imp) return;
                const sel = R.selectedFiles(imp, this.model);
                const missing = sel.filter(x => !x.description).length;
                sub.innerHTML = `${num(sel.length)} file${sel.length === 1 ? '' : 's'} in the report${missing ? ` · <span class="btt-warn">${num(missing)} without a description</span>` : ''}`;
            }, 250);
        }

        async exportPdf() {
            const id = this.selectedId;
            const imp = this.module.imports.find(x => x.id === id);
            if (!imp || !this.model || this._outBusy) return;
            if (!(await this._reportReady(imp, 'PDF'))) return;
            await this._runOutput('📄 Making PDF…', async () => {
                const r = await this.module.exportSummaryPdf(id, { events: this.keyEvents(this.model) });
                this._toast(`Download Summary saved to Evidence → BitTorrent Reports (${r.name})`, 'success');
            }, 'PDF');
        }

        /** Same warnings for the PDF and the Word report. */
        async _reportReady(imp, kind) {
            const sel = root.BtReport ? root.BtReport.selectedFiles(imp, this.model) : [];
            const missing = sel.filter(x => !x.description).length;
            const ok = kind === 'PDF' ? 'Make PDF' : 'Make Word report';
            if (!sel.length && !(await this._confirm(`<strong>No files are in the report.</strong><br>The Download Summary will have no “Files reviewed by the investigator” entries. Make it anyway?`, ok))) return false;
            if (missing && !(await this._confirm(`<strong>${num(missing)} of ${num(sel.length)} report files have no description.</strong><br>They will show “No description entered.” Make the ${kind === 'PDF' ? 'PDF' : 'Word report'} anyway?`, ok))) return false;
            return true;
        }

        /** The Download Summary as an editable Word report in the Reports tab, then open it in Word. */
        async exportDocx() {
            const id = this.selectedId;
            const imp = this.module.imports.find(x => x.id === id);
            if (!imp || !this.model || this._outBusy) return;
            if (!(await this._reportReady(imp, 'Word'))) return;
            await this._runOutput('📝 Making Word report…', async () => {
                const r = await this.module.exportSummaryDocx(id, { events: this.keyEvents(this.model) });
                this._toast(`Word report saved to the Reports tab (Microsoft Word) as “${r.fileName}”. Opening it in Word…`, 'success');
                const o = await this.module.openReportDoc(r.fileName);
                if (!o || !o.success) this._toast(`The Word report is saved in the Reports tab, but it could not be opened: ${(o && o.error) || 'unknown error'}`, 'error');
            }, 'Word report');
        }

        async exportCsv() {
            const id = this.selectedId;
            if (!this.model || this._outBusy) return;
            await this._runOutput('#️⃣ Saving…', async () => {
                const r = await this.module.exportHashCsv(id);
                this._toast(`Hash list saved to Evidence → BitTorrent Reports (${r.name})`, 'success');
            }, 'Hash list');
        }

        async sendToWarrantAuthor() {
            const id = this.selectedId;
            if (!this.model || this._outBusy) return;
            const text = await this.module.pcParagraph(id);
            if (!text) { this._toast('Nothing to send for this download.', 'error'); return; }
            const ok = await this._confirm(`<strong>Add this to the case Probable Cause?</strong><br><span style="font-size:12px;opacity:.75">Warrant Author uses the case Probable Cause in every warrant on this case. You can edit it there.</span>
                <div style="white-space:pre-wrap;text-align:left;max-height:320px;overflow-y:auto;margin-top:10px;padding:8px;border:1px solid rgba(127,127,127,.35);border-radius:6px;font-size:12.5px">${esc(text)}</div>`, 'Add to Probable Cause');
            if (!ok) return;
            try {
                const r = this.module.sendToWarrantAuthor(id, text);
                this._toast(r.already ? 'That paragraph is already in the case Probable Cause.' : 'Added to the case Probable Cause in Warrant Author.', r.already ? 'info' : 'success');
            } catch (err) { this._toast(err.message || String(err), 'error'); }
        }

        async _runOutput(label, fn, what) {
            this._outBusy = true;
            this._outLabel = label;
            this._refreshReport();
            try { await fn(); } catch (err) { this._toast(`${what} failed: ${err && err.message || err}`, 'error'); }
            this._outBusy = false;
            this._refreshReport();
        }

        _gridHtml(rows) {
            if (!rows.length) return '<div class="btt-dim">No files match.</div>';
            return `<div class="btt-tiles">${rows.map(f => this._tileHtml(f)).join('')}</div>`;
        }

        _tileHtml(f) {
            const st = this._fileState(f);
            const can = st.onDisk && st.kind !== 'other';
            const blurred = can && this._isBlurred(f.index);
            const icon = st.kind === 'image' ? '🖼️' : st.kind === 'video' ? '🎞️' : '📄';
            const ext = (/\.([^.\\/]+)$/.exec(st.base) || [])[1] || '';
            const ph = can ? icon : (f.status === 'none' ? '<span class="btt-tile-ph-t">not downloaded</span>' : st.onDisk ? icon : '<span class="btt-tile-ph-t">not on disk</span>');
            return `<div class="btt-tile${blurred ? ' blur' : ''}${can ? ' can' : ''}" data-act="tile" data-i="${f.index}" title="${esc(st.name)}">
                <div class="btt-thumb" data-th="${f.index}">${ph}</div>
                ${blurred ? '<div class="btt-tile-cover">Click to reveal</div>' : ''}
                <div class="btt-tile-badges">${st.kind === 'video' ? `<span class="btt-badge vid">▶ ${esc(ext.toUpperCase())}</span>` : ''}${f.status === 'incomplete' ? this._statusBadge(f) : ''}${this._verifyBadge(st, f)}${this._inReport(f.index) ? '<span class="btt-badge ok" title="In the Download Summary">📄 report</span>' : ''}</div>
                <div class="btt-tile-name"><span class="btt-dim">#${f.index}</span> ${esc(st.base)}</div>
            </div>`;
        }

        /** Fill the visible page's tiles: images by viper-media URL, videos by an ffmpeg frame. */
        async _hydrateGrid() {
            const gen = ++this._gridGen;
            const id = this.selectedId;
            const box = document.getElementById('btt-files');
            if (!box || !this.model) return;
            const sec = box.closest && box.closest('details.btt-sec');
            if (sec && !sec.open) return;   // collapsed: thumbnails load when Files is expanded
            const byIdx = new Map((this.model.files || []).filter(Boolean).map(f => [f.index, f]));
            const els = Array.from(box.querySelectorAll('.btt-thumb[data-th]'));
            const cache = BitTorrentUI.thumbCache;
            const todo = els.filter(el => { const f = byIdx.get(Number(el.getAttribute('data-th'))); const st = f && this._fileState(f); return st && st.onDisk && st.kind !== 'other'; });
            const one = async (el) => {
                if (gen !== this._gridGen) return;
                const idx = Number(el.getAttribute('data-th'));
                const f = byIdx.get(idx);
                const st = this._fileState(f);
                const k = this.module.caseNumber + '|' + id + '|' + idx;
                let hit = cache.get(k);
                if (hit && hit.exp && hit.exp < Date.now()) { cache.delete(k); hit = null; }
                let src = hit ? hit.v : undefined;
                if (src === undefined) {
                    try { src = st.kind === 'image' ? await this.module.mediaUrl(id, idx) : await this.module.videoThumb(id, idx); } catch (_) { src = null; }
                    if (src !== null && src !== undefined) {
                        cache.set(k, { v: src, exp: st.kind === 'image' ? Date.now() + 45 * 60 * 1000 : 0 });
                        if (cache.size > 1500) cache.delete(cache.keys().next().value);
                    }
                }
                if (gen !== this._gridGen || el.isConnected === false) return;
                if (src) {
                    const img = document.createElement('img');
                    img.alt = ''; img.decoding = 'async'; img.loading = 'lazy'; img.draggable = false;
                    img.onerror = () => { el.classList.add('bad'); };
                    img.src = src;
                    el.textContent = '';
                    el.appendChild(img);
                } else if (src === false) {
                    el.classList.add('bad');
                    el.title = 'VIPER could not read a picture from this file.';
                }
            };
            let next = 0;
            const worker = async () => { while (next < todo.length && gen === this._gridGen) { const el = todo[next++]; await one(el); } };
            await Promise.all([worker(), worker(), worker()]);
        }

        _reveal(index, on) {
            const k = this.selectedId + '|' + index;
            if (on) BitTorrentUI.revealed.add(k); else BitTorrentUI.revealed.delete(k);
            const tile = document.querySelector(`#btt-files .btt-tile[data-i="${Number(index)}"]`);
            if (tile) {
                tile.classList.toggle('blur', !on && this._isBlurred(index));
                const cover = tile.querySelector('.btt-tile-cover');
                if (on && cover) cover.remove();
                else if (!on && !cover && this._isBlurred(index)) tile.insertAdjacentHTML('beforeend', '<div class="btt-tile-cover">Click to reveal</div>');
            }
        }

        _onTile(index) {
            const f = ((this.model && this.model.files) || []).find(x => x && x.index === index);
            if (!f) return;
            const st = this._fileState(f);
            if (!st.onDisk) { this._toast(f.status === 'none' ? 'This file was not downloaded from the suspect.' : 'This file is not in the Download folder.', 'info'); return; }
            if (st.kind === 'other') { this._toast('VIPER shows pictures and videos here. Other files stay in the Download folder.', 'info'); return; }
            if (this._isBlurred(index)) { this._reveal(index, true); return; }
            this.openViewer(index);
        }

        // ── In-app viewer (never an outside program: no Windows thumbnail cache / recent files) ──
        openViewer(index) {
            const list = this._filteredFiles().filter(f => { const s = this._fileState(f); return s.onDisk && s.kind !== 'other'; }).map(f => f.index);
            this._vw = { id: this.selectedId, list: list.includes(index) ? list : [index], at: 0, gen: 0 };
            this._vw.at = this._vw.list.indexOf(index);
            let ov = document.getElementById('btt-viewer');
            if (!ov) {
                ov = document.createElement('div');
                ov.id = 'btt-viewer';
                ov.className = 'btt-viewer';
                ov.innerHTML = `<div class="btt-viewer-bar">
                        <div class="btt-viewer-info" id="btt-vw-info"></div>
                        <button class="btt-btn small" data-vw="blur" title="Blur this file again">🙈 Blur</button>
                        <button class="btt-btn small" data-vw="prev" title="Previous (←)">‹ Prev</button>
                        <button class="btt-btn small" data-vw="next" title="Next (→)">Next ›</button>
                        <button class="btt-btn small" data-vw="close" title="Close (Esc)">✕</button>
                    </div>
                    <div class="btt-viewer-stage" id="btt-vw-stage"></div>
                    <div class="btt-viewer-foot"><div id="btt-vw-foot"></div><div id="btt-vw-report" class="btt-vw-report"></div></div>`;
                ov.addEventListener('input', (e) => {
                    const t = e.target;
                    if (t && t.id === 'btt-vw-desc' && this._vw) {
                        const idx = this._vw.list[this._vw.at];
                        this._saveDesc(idx, t.value);
                        const twin = document.querySelector(`#btt-report [data-rdesc="${Number(idx)}"]`);
                        if (twin) twin.value = t.value;
                    }
                });
                ov.addEventListener('click', (e) => {
                    const b = e.target.closest('[data-vw]');
                    if (!b) { if (e.target === ov) this.closeViewer(); return; }
                    const a = b.getAttribute('data-vw');
                    if (a === 'close') this.closeViewer();
                    else if (a === 'prev') this._viewerStep(-1);
                    else if (a === 'next') this._viewerStep(1);
                    else if (a === 'blur') { const idx = this._vw.list[this._vw.at]; this._reveal(idx, false); this._showViewerItem(); }
                    else if (a === 'rpt') {
                        const idx = this._vw.list[this._vw.at];
                        this._setInReport(idx, !this._inReport(idx));
                        if (this._inReport(idx)) { const d = document.getElementById('btt-vw-desc'); if (d) d.focus(); }
                    }
                });
                document.body.appendChild(ov);
            }
            if (!this._vwKey) {
                this._vwKey = (e) => {
                    if (!document.getElementById('btt-viewer')) return;
                    if (e.key === 'Escape') { e.preventDefault(); this.closeViewer(); }
                    else if (e.key === 'ArrowLeft' && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) this._viewerStep(-1);
                    else if (e.key === 'ArrowRight' && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) this._viewerStep(1);
                };
                document.addEventListener('keydown', this._vwKey);
            }
            this._showViewerItem();
        }

        _viewerStep(d) {
            const vw = this._vw;
            if (!vw || vw.list.length < 2) return;
            vw.at = (vw.at + d + vw.list.length) % vw.list.length;
            this._showViewerItem();
        }

        _stopViewerMedia() {
            const stage = document.getElementById('btt-vw-stage');
            if (!stage) return;
            stage.querySelectorAll('video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* */ } });
            stage.textContent = '';
        }

        closeViewer() {
            this._stopViewerMedia();
            const ov = document.getElementById('btt-viewer');
            if (ov) ov.remove();
            if (this._vwKey) { document.removeEventListener('keydown', this._vwKey); this._vwKey = null; }
            this._vw = null;
        }

        _renderViewerReport(idx) {
            const box = document.getElementById('btt-vw-report');
            if (!box) return;
            const f = ((this.model && this.model.files) || []).find(x => x && x.index === idx);
            if (!f || !this._canReport(f)) { box.innerHTML = ''; return; }
            const on = this._inReport(idx);
            const it = this.module.reportItems(this.selectedId)[idx];
            box.innerHTML = `<button class="btt-btn small${on ? ' on' : ''}" data-vw="rpt" title="${on ? 'Take this file out of the Download Summary' : 'Add this file to the Download Summary'}">${on ? '✓ In report — remove' : '＋ Add to report'}</button>
                ${on ? `<textarea id="btt-vw-desc" class="btt-input btt-rpt-desc" rows="2" placeholder="Describe what this ${BitTorrentUI.kindOf(f.path || f.name) === 'video' ? 'video' : 'picture'} shows, in your own words. This goes in the report.">${esc((it && it.description) || '')}</textarea>` : ''}`;
        }

        async _showViewerItem() {
            const vw = this._vw;
            if (!vw) return;
            const gen = ++vw.gen;
            const idx = vw.list[vw.at];
            const f = ((this.model && this.model.files) || []).find(x => x && x.index === idx);
            if (!f) return;
            const st = this._fileState(f);
            const info = document.getElementById('btt-vw-info');
            const foot = document.getElementById('btt-vw-foot');
            if (info) info.innerHTML = `<b>#${f.index}</b> ${esc(st.base)} <span class="btt-dim">· ${bytes(st.diskSize != null ? st.diskSize : f.size)}${vw.list.length > 1 ? ` · ${vw.at + 1} of ${num(vw.list.length)}` : ''}</span> ${this._statusBadge(f)} ${this._verifyBadge(st, f)}`;
            if (foot) foot.innerHTML = `${f.status === 'incomplete' ? `<div class="btt-warn">Partial file — ${num(f.bytesWritten)} of ${num(f.size)} bytes were downloaded, so it may show only in part.</div>` : ''}
                <div><span class="btt-dim">Path in torrent</span> ${esc(st.name)}</div>
                ${f.sha1 ? `<div><span class="btt-dim">SHA-1</span> <span class="btt-mono">${esc(f.sha1)}</span>${f.md5 ? ` <span class="btt-dim">MD5</span> <span class="btt-mono">${esc(f.md5)}</span>` : ''}</div>` : ''}`;
            this._renderViewerReport(idx);
            this._stopViewerMedia();
            const stage = document.getElementById('btt-vw-stage');
            if (!stage) return;
            const blurred = this._isBlurred(idx);
            const wrap = document.createElement('div');
            wrap.className = 'btt-viewer-media' + (blurred ? ' blur' : '');
            // Capture phase: a click on a blurred file only reveals it (even on the video's Play button).
            wrap.addEventListener('click', (e) => {
                if (!wrap.classList.contains('blur')) return;
                e.stopPropagation(); e.preventDefault();
                wrap.classList.remove('blur');
                const c = wrap.querySelector('.btt-viewer-cover'); if (c) c.remove();
                this._reveal(idx, true);
                const v = wrap.querySelector('video'); if (v && v.paused) { try { v.play(); } catch (_) { /* */ } }
                const p = wrap.querySelector('.vplv-panel');
                if (p && !p._vplvBusy && root.VpLegacyVideo && root.VpLegacyVideo.start) root.VpLegacyVideo.start(p);
            }, true);
            if (blurred) { const c = document.createElement('div'); c.className = 'btt-viewer-cover'; c.textContent = 'Click to reveal'; wrap.appendChild(c); }
            stage.appendChild(wrap);
            const LV = root.VpLegacyVideo;
            if (st.kind === 'video') {
                const v = document.createElement('video');
                v.className = 'btt-viewer-video';
                v.controls = true;
                v.autoplay = !blurred;
                v.preload = 'metadata';
                v.setAttribute('data-vplv', JSON.stringify({ caseNumber: this.module.caseNumber, downloadId: vw.id, index: idx, name: st.base }));
                wrap.insertBefore(v, wrap.firstChild);
                if (LV && LV.isLegacyName && LV.isLegacyName(st.base)) {
                    LV.offer(v, { autoStart: !blurred, autoplay: true });   // FLV / AVI / WMV …: straight to a playback copy
                    return;
                }
                const url = await this.module.mediaUrl(vw.id, idx);
                if (gen !== vw.gen || !this._vw) return;
                if (url) v.src = url;            // a codec the window can't decode → legacy-video offers a copy on 'error'
                else wrap.insertAdjacentHTML('beforeend', '<div class="btt-bad">VIPER could not open this file.</div>');
                return;
            }
            const img = document.createElement('img');
            img.className = 'btt-viewer-img';
            img.alt = '';
            img.draggable = false;
            wrap.insertBefore(img, wrap.firstChild);
            const url = await this.module.mediaUrl(vw.id, idx);
            if (gen !== vw.gen || !this._vw) return;
            if (url) { img.onerror = () => { if (gen === vw.gen) wrap.insertAdjacentHTML('beforeend', '<div class="btt-bad">VIPER could not show this picture. The file may be partial or damaged.</div>'); }; img.src = url; }
            else wrap.insertAdjacentHTML('beforeend', '<div class="btt-bad">VIPER could not open this file.</div>');
        }

        async runVerify(id) {
            if (this.module.verifyJob) { this._toast('A hash check is already running.', 'info'); return null; }
            this.verifyRun = { id, pct: 0, text: 'Starting…' };
            this._refreshVerify();
            try {
                const res = await this.module.verifyFiles(id, {
                    onProgress: (p) => {
                        if (!p || p.phase !== 'verify' || !this.verifyRun) return;
                        this.verifyRun.pct = p.bytesTotal ? p.bytesDone / p.bytesTotal * 100 : (p.filesTotal ? p.filesDone / p.filesTotal * 100 : 0);
                        this.verifyRun.text = `${num(p.filesDone)} of ${num(p.filesTotal)} files (${bytes(p.bytesDone)} of ${bytes(p.bytesTotal)})`;
                        this._refreshVerify();
                    }
                });
                this.verifyRun = null;
                if (this.selectedId === id && this.model) { this.model.verify = res.verify; this._refreshVerify(); this._refreshFiles(); }
                else this._refreshVerify();
                const s = res.summary || {};
                const i = this.module.imports.find(x => x.id === id);
                const who = i && i.ip ? ` (${i.ip})` : '';
                if (!s.withHash) this._toast(`BitTorrent${who}: the log has no SHA-1 values to compare.`, 'info');
                else if (!s.mismatched && !s.missing && !s.unreadable) this._toast(`BitTorrent${who}: all ${num(s.matched)} files on disk match the TD hashes.`, 'success');
                else this._toast(`BitTorrent${who}: ${num(s.matched)} of ${num(s.withHash)} files match the TD hashes — ${num(s.mismatched)} different, ${num(s.missing)} missing.`, 'error');
                this._refreshListItem(id);
                return res;
            } catch (err) {
                this.verifyRun = null;
                this._refreshVerify();
                if (err && err.cancelled) this._toast('Hash check cancelled.', 'info');
                else this._toast(`Hash check failed: ${err && err.message || err}`, 'error');
                return null;
            }
        }

        async _autoVerify(ids) {
            for (const id of ids) {
                if (!this.module.imports.some(i => i.id === id)) continue;
                await this.runVerify(id);
            }
        }

        _refreshListItem(id) {
            const i = this.module.imports.find(x => x.id === id);
            const old = this.el && this.el.querySelector(`.btt-item[data-id="${String(id).replace(/["\\]/g, '')}"]`);
            if (i && old) old.outerHTML = this._listItemHtml(i);
        }

        _netstatHtml(m) {
            const TM = root.TdModel || {};
            const blocks = m.netstat || [];
            if (!blocks.length) return '<div class="btt-dim">No netstat.txt in these logs.</div>';
            const ns = TM.netstatSummary ? TM.netstatSummary(m) : { blocks: blocks.length, withRemote: 0, established: 0 };
            const hits = blocks.filter(b => (b.matches || []).length).slice(0, 100);
            return `<div>${num(ns.withRemote)} of ${num(ns.blocks)} netstat snapshots show a connection to the suspect${ns.established ? ` (${num(ns.established)} ESTABLISHED)` : ''}${ns.first ? `, first ${esc(ns.first)}, last ${esc(ns.last)}` : ''}.</div>
                ${hits.length ? `<table class="btt-table"><thead><tr><th>Snapshot</th><th>Proto</th><th>Local</th><th>Foreign</th><th>State</th><th>Source</th></tr></thead><tbody>
                ${hits.map(b => b.matches.map(x => `<tr><td class="btt-nowrap">${esc(b.at || b.atText || '')}</td><td>${esc(x.proto)}</td><td class="btt-mono">${esc(x.local)}</td><td class="btt-mono">${esc(x.foreign)}</td><td>${esc(x.state)}</td><td>${this._ref(String(b.ref || '').replace(/:\d+$/, '') + ':' + x.line)}</td></tr>`).join('')).join('')}
                </tbody></table>` : ''}`;
        }

        _sourcesHtml(m) {
            const warns = (m.warnings || []).map(w => `<li>${esc(w.text)}</li>`).join('');
            return `<table class="btt-table"><thead><tr><th>File</th><th>Role</th><th>Size</th><th>Lines</th></tr></thead><tbody>
                ${(m.sources || []).map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${bytes(x.bytes)}</td><td>${num(x.lines)}</td></tr>`).join('')}
                </tbody></table>
                ${warns ? `<div class="btt-sub">Checks</div><ul class="btt-warnings">${warns}</ul>` : '<div class="btt-ok btt-checks-ok">✓ No consistency problems found in the logs.</div>'}`;
        }

        async arinLookup(id) {
            const btn = this.el && this.el.querySelector('[data-act="arin"]');
            if (btn) { btn.disabled = true; btn.textContent = '🌐 Looking up…'; }
            try {
                const a = await this.module.lookupArin(id);
                this._toast(`ARIN: ${a.provider || a.org}`, 'success');
            } catch (err) {
                this._toast(`ARIN lookup failed: ${err.message || err}`, 'error');
            }
            const i = this.module.imports.find(x => x.id === id);
            const head = document.getElementById('btt-card-head');
            if (head && i) head.innerHTML = this._cardHeadHtml(i);
            const box = document.getElementById('btt-arin');
            if (box && i) box.innerHTML = this._arinHtml(i);
        }

        sendToPeople(id) {
            const items = this.module.sendItems(id);
            if (!items.length) { this._toast('This download has no suspect IP address.', 'error'); return; }
            if (typeof root.viperSendToPeople !== 'function') { this._toast('Send to Suspect is not available on this page.', 'error'); return; }
            root.viperSendToPeople(items, 'BitTorrent');
        }

        /** Case Notes text for the card header + the suspect-software callout (IP, location, ARIN, client, warrant pointers). */
        clientNoteHtml(i, m) {
            const TM = root.TdModel || {};
            m = m || {};
            const off = (m.download || {}).gmtOffsetMin != null ? (m.download || {}).gmtOffsetMin : i.gmtOffsetMin;
            const tz = off != null ? ' ' + gmt(off) : '';
            const br = (k, v) => v ? `<b>${esc(k)}:</b> ${v}<br>` : '';
            const t = m.torrent || {};
            const hash = String(t.infoHash || '').toLowerCase();
            const a = i.arin;
            const arin = a ? [esc(a.provider || a.org), a.org && a.org !== a.provider ? esc(a.org) : '', esc(a.netRange || a.network || ''), esc(a.country || '')].filter(Boolean).join(' · ')
                + ` (looked up ${esc(String(a.lookedUpAt || '').slice(0, 16).replace('T', ' '))})` : '';
            const started = (m.download || {}).startedAt || i.startedAt;
            let out = `<p><b>BitTorrent download — suspect IP and BitTorrent software</b> (Torrential Downpour logs, BitTorrent tab)</p><p>`
                + br('Suspect IP', `${esc(i.ip || 'Unknown')}${i.port ? ':' + esc(i.port) : ''}${i.teredo ? ' (Teredo)' : ''}`)
                + br('Location (Torrential Downpour)', esc(i.location || ''))
                + br('ARIN', arin)
                + br('Download started', started ? esc(started) + esc(tz) : '')
                + br('Torrent', t.name ? esc(t.name) + (hash ? ` — info hash ${esc(hash)}` : '') : (hash ? `info hash ${esc(hash)}` : ''))
                + '</p>';
            const seen = TM.clientsSeen ? TM.clientsSeen(m.sessions || []).filter(c => c.handshakes > 0) : [];
            if (!seen.length) return out + `<p><b>Suspect's BitTorrent software:</b> not identified — no handshake in these logs, so the suspect's program did not identify itself.</p>`;
            const main = seen[0];
            const p = main.profile;
            const L = TM.PLATFORM_LABELS || {};
            out += `<p><b>Suspect's BitTorrent software:</b> ${esc(main.name || main.tag || 'Unknown client')}${main.version ? ' ' + esc(main.version) : ''}`
                + ` — ${p ? esc(p.kind) : 'not in VIPER\'s client list (search the peer ID prefix online)'}<br>`
                + br('Peer ID', `${esc(main.tag || '—')} · ${num(main.handshakes)} handshake${main.handshakes === 1 ? '' : 's'}${main.dataSessions ? ` · ${num(main.dataSessions)} with data` : ''}`
                    + (main.firstAt ? ` · first ${esc(main.firstAt)}${esc(tz)}` : '') + (main.firstRef ? ` (${esc(main.firstRef)})` : ''))
                + (p ? br('Runs on', p.platforms.map(k => esc(L[k] || k)).join(', ')) + br('Likely device', esc(p.device)) : '')
                + '</p>';
            if (p && p.look.length) {
                out += `<p><b>What to look for when serving the warrant:</b></p><ul>`
                    + `<li>The program itself (installed apps / Program Files / Applications) — ${esc(main.name || 'this client')}${main.version ? ' version ' + esc(main.version) : ''}</li>`
                    + p.look.map(x => `<li>${esc(x).replace(/\{hash\}/g, hash ? esc(hash) : 'the info hash')}</li>`).join('') + '</ul>';
            }
            const others = seen.slice(1);
            if (others.length) {
                out += `<p><b>Note:</b> ${others.length + 1} different BitTorrent programs answered from this IP: `
                    + others.map(c => `${esc(c.label)} (${num(c.handshakes)} handshake${c.handshakes === 1 ? '' : 's'}${c.dataSessions ? ', ' + num(c.dataSessions) + ' with data' : ''})`).join(', ')
                    + '. Different programs can mean more than one device behind the same router.</p>';
            }
            return out + `<p><i>The program name and version come from the peer ID the suspect's software sent in the handshake. It is self-reported and can be faked, and default folders can be changed, so confirm on the device. "Runs on" lists the platforms the program is published for.</i></p>`;
        }

        async sendToNotes(id) {
            const i = this.module.imports.find(x => x.id === id);
            if (!i) return;
            if (typeof root.viperAddCaseNote !== 'function') { this._toast('Case Notes is not available on this page.', 'error'); return; }
            let m = this.selectedId === id && this.model ? this.model : null;
            if (!m) { try { m = await this.module.loadModel(id); } catch (_) { m = null; } }
            const r = root.viperAddCaseNote(this.clientNoteHtml(i, m), { source: 'BitTorrent' });
            if (r && r.saved) this._toast('Added to Case Notes: suspect IP and BitTorrent software.', 'success');
            else this._toast(r && r.reason === 'quota' ? 'Case Notes storage is full — the note was not saved.' : 'The note could not be saved.', 'error');
        }

        async _onClick(e) {
            const b = e.target.closest('[data-act]');
            if (!b || !this.el.contains(b)) return;
            const act = b.getAttribute('data-act');
            if (act === 'sec') { const det = b.closest('details.btt-sec'); if (det) this._onSectionToggle(b.getAttribute('data-sec'), det); return; }
            if (act === 'secall') { this._setAllSections(b.getAttribute('data-open') === '1'); return; }
            if (act === 'import') return this.importFromPicker();
            if (act === 'find') return this.findInEvidence();
            if (act === 'cancel') { this.module.cancel(); this._setProgress(Object.assign({}, this.progress, { text: 'Cancelling…' })); return; }
            if (act === 'select') { this.selectedId = b.getAttribute('data-id'); this.state.scroll = 0; this._rememberSelection(); this.render(); return; }
            if (act === 'remove') return this.removeImport(b.getAttribute('data-id'));
            if (act === 'arin') return this.arinLookup(b.getAttribute('data-id'));
            if (act === 'send') return this.sendToPeople(b.getAttribute('data-id'));
            if (act === 'notes') return this.sendToNotes(b.getAttribute('data-id'));
            if (act === 'grp') {
                const det = b.parentElement;
                const body = det && det.querySelector('.btt-grp-body');
                if (body && !body.dataset.filled) { body.innerHTML = this._groupBodyHtml(Number(b.getAttribute('data-g'))); body.dataset.filled = '1'; }
                return;
            }
            if (act === 'fpage') { this.fileView.page = Math.max(0, Number(b.getAttribute('data-p')) || 0); this._rememberFileView(); this._refreshFiles(); return; }
            if (act === 'fview') {
                try { root.localStorage.setItem('viperBtFilesView', b.getAttribute('data-v') === 'grid' ? 'grid' : 'table'); } catch (_) { /* */ }
                this._refreshFiles(); return;
            }
            if (act === 'tile') return this._onTile(Number(b.getAttribute('data-i')));
            if (act === 'revealall') { BitTorrentUI.revealAll = !BitTorrentUI.revealAll; if (!BitTorrentUI.revealAll) BitTorrentUI.revealed.clear(); this._refreshFiles(); return; }
            if (act === 'verify') return this.runVerify(this.selectedId);
            if (act === 'vcancel') { this.module.cancelVerify(); if (this.verifyRun) { this.verifyRun.text = 'Cancelling…'; this._refreshVerify(); } return; }
            if (act === 'vproblems') {
                this.fileView.status = 'problem'; this.fileView.page = 0; this._rememberFileView();
                const det = document.querySelector('details.btt-sec[data-sec="files"]');
                if (det && !det.open) { det.open = true; this.state.open.files = true; this._writeState(); }
                this._refreshFiles(); return;
            }
            if (act === 'rpt') { const n = Number(b.getAttribute('data-i')); this._setInReport(n, !this._inReport(n)); return; }
            if (act === 'rview') { this.openViewer(Number(b.getAttribute('data-i'))); return; }
            if (act === 'rpdf') return this.exportPdf();
            if (act === 'rdocx') return this.exportDocx();
            if (act === 'rcsv') return this.exportCsv();
            if (act === 'rwa') return this.sendToWarrantAuthor();
        }

        _refreshFiles(keepFocus) {
            const box = document.getElementById('btt-files');
            if (!box) return;
            const q = document.getElementById('btt-file-q');
            const pos = q ? q.selectionStart : null;
            box.innerHTML = this._filesHtml();
            if (this._viewMode() === 'grid') this._hydrateGrid();
            else this._gridGen = (this._gridGen || 0) + 1;
            if (keepFocus) {
                const n = document.getElementById('btt-file-q');
                if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); }
            }
        }

        _onInput(e) {
            if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-rdesc')) { this._saveDesc(Number(e.target.getAttribute('data-rdesc')), e.target.value); return; }
            if (!e.target || !this.fileView) return;
            if (e.target.id === 'btt-file-q') {
                this.fileView.q = e.target.value; this.fileView.page = 0; this._rememberFileView();
                clearTimeout(this._qTimer);
                this._qTimer = setTimeout(() => this._refreshFiles(true), 200);
            } else if (e.target.id === 'btt-file-status') {
                this.fileView.status = e.target.value; this.fileView.page = 0; this._rememberFileView(); this._refreshFiles();
            } else if (e.target.id === 'btt-blur-pref') {
                try { root.localStorage.setItem('viperBtBlur', e.target.checked ? '1' : '0'); } catch (_) { /* */ }
                this._refreshFiles();
            }
        }

        _pickHtml(title, intro, list, cls) {
            const rows = list.map((d, k) => {
                const notes = [];
                if (d.stamp) notes.push(d.stamp);
                notes.push(d.hasDetails ? 'details + summary logs' : 'summary log only');
                if (d.downloadDir) notes.push('Download folder');
                if (d.encrypted) notes.push('🔒 Field Security copy');
                if (d.source === 'evidence-link') notes.push('linked — stays where it is');
                if (d.alreadyImported) notes.push('already on this tab');
                return `<label class="btt-pick-row">
                    <input type="checkbox" class="${cls}" data-i="${k}" ${d.alreadyImported ? '' : 'checked'}>
                    <span><span class="btt-pick-name">${esc(d.ipFolder || '(no IP folder)')} / ${esc(d.caseFolder || d.caseDir.split(/[\\/]/).pop())}</span>
                    <span class="btt-pick-note">${esc(notes.join(' · '))} · logs ${bytes(d.logBytes)}</span></span>
                </label>`;
            }).join('');
            return `<strong>${esc(title)}</strong><br><span style="font-size:12px;opacity:.75">${intro}</span>
                <span style="display:block;max-height:320px;overflow-y:auto;margin-top:10px;text-align:left">${rows}</span>`;
        }

        _readTicks(cls, list) {
            const boxes = Array.from(document.querySelectorAll('.' + cls));
            if (!boxes.length) return list.filter(d => !d.alreadyImported);
            return boxes.filter(cb => cb.checked).map(cb => list[Number(cb.getAttribute('data-i'))]).filter(Boolean);
        }

        async importFromPicker() {
            if (this.module.job) return;
            let res;
            try { res = await this.module.pickSource(); } catch (err) { this._toast(err.message || String(err), 'error'); return; }
            if (!res) return;
            const list = res.downloads || [];
            if (!list.length) {
                this._toast('No Torrential Downpour logs were found in that folder. Pick the folder named after the suspect IP, or the dated download folder inside it.', 'error');
                return;
            }
            const outside = list.some(d => !d.inCase);
            const ok = await this._confirm(this._pickHtml(
                `Torrential Downpour download${list.length > 1 ? 's' : ''} found: ${list.length}`,
                outside ? 'Each ticked download (Logs and Download folders) is copied into this case under Evidence → BitTorrent, read, and added to the Evidence tab. Downloaded files can be reviewed on the Files list (thumbnails start blurred), and their SHA-1 hashes are checked against the log.'
                    : 'These are already inside this case; they are read where they are.',
                list, 'btt-pick'), 'Import selected');
            const picked = this._readTicks('btt-pick', list);
            if (!ok) return;
            if (!picked.length) { this._toast('Nothing was ticked.', 'info'); return; }
            await this._runImports(picked, 'copy');
        }

        async findInEvidence() {
            if (this.module.job) return;
            try { await this.module.scanEvidence(); } catch (_) { /* show what we have */ }
            const list = this.module.evidenceCandidates();
            if (!list.length) {
                this._toast('No Torrential Downpour folders were found on this case\'s Evidence tab. Add the folder on the Evidence tab first, or use Import TD folder.', 'info');
                return;
            }
            const ok = await this._confirm(this._pickHtml(
                'Torrential Downpour downloads in Evidence',
                'Tick the downloads to read. Nothing is copied — they are read where they are on the Evidence tab.',
                list, 'btt-ev-pick'), 'Read selected');
            const picked = this._readTicks('btt-ev-pick', list);
            if (!ok) return;
            if (!picked.length) { this._toast('Nothing was ticked.', 'info'); return; }
            await this._runImports(picked, 'inplace');
        }

        async _runImports(list, mode) {
            let added = 0, updated = 0, failed = 0, last = null;
            const toVerify = [];
            for (let k = 0; k < list.length; k++) {
                const d = list[k];
                const label = `${list.length > 1 ? `(${k + 1}/${list.length}) ` : ''}${d.ipFolder || d.caseFolder || 'Torrential Downpour download'}`;
                this._setProgress({ label, pct: 0, text: 'Starting…' });
                this._disableActions(true);
                try {
                    const r = await this.module.importDownload(d, { mode, onProgress: (p) => this._onProgress(label, p) });
                    if (r.replaced) updated++; else added++;
                    last = r.meta;
                    if (r.meta && r.meta.storage && r.meta.storage.hasDownload) toVerify.push(r.meta.id);
                } catch (err) {
                    if (err && err.cancelled) { this._toast('Import cancelled. Nothing was added.', 'info'); break; }
                    failed++;
                    this._toast(`Could not import ${esc(d.ipFolder || d.caseFolder || d.caseDir)}: ${esc(err && err.message || err)}`, 'error');
                }
            }
            this.progress = null;
            if (last) { this.selectedId = last.id; this.state.scroll = 0; this._rememberSelection(); }
            this.render();
            if (added || updated) {
                const parts = [];
                if (added) parts.push(`${added} download${added > 1 ? 's' : ''} added`);
                if (updated) parts.push(`${updated} re-read`);
                this._toast(`BitTorrent: ${parts.join(', ')}${mode === 'copy' ? ' — copied into Evidence → BitTorrent' : ''}.`, 'success');
            }
            this.module.scanEvidence().catch(() => {});
            // Background: re-hash the downloaded files against the log (plan §4 integrity check).
            if (toVerify.length) this._autoVerify(toVerify).catch(() => {});
            return { added, updated, failed };
        }

        _disableActions(on) {
            const el = this.el;
            if (!el) return;
            el.querySelectorAll('[data-act="import"],[data-act="find"]').forEach(b => { b.disabled = !!on; });
        }

        async removeImport(id) {
            const i = this.module.imports.find(x => x.id === id);
            if (!i) return;
            const copied = i.storage && i.storage.mode === 'copy';
            const ok = await this._confirm(`Remove the download from <b>${esc(i.ip || 'unknown IP')}</b> (${esc(i.startedAt || '')}) from the BitTorrent tab?<br>
                <span style="font-size:12px;opacity:.75">${copied ? 'The copy in Evidence → BitTorrent and its Evidence item are kept. ' : ''}Evidence files are not deleted; you can read it again with Find in Evidence.</span>`, 'Remove');
            if (!ok) return;
            await this.module.removeImport(id);
            if (this.selectedId === id) { this.selectedId = null; this.state.scroll = 0; }
            delete this.state.views[id];
            this._writeState();
            this.render();
        }

        destroy() {
            this.closeViewer();
            this._gridGen = (this._gridGen || 0) + 1;
            const el = this.el;
            if (el) el.onclick = null;
        }
    }

    // Session-wide (cleared when VIPER restarts): which files the officer revealed.
    BitTorrentUI.revealed = new Set();      // `${downloadId}|${index}`
    BitTorrentUI.revealAll = false;
    BitTorrentUI.thumbCache = new Map();    // `${case}|${id}|${index}` → { v: url|dataUrl|false, exp }
    const IMAGE_EXT = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'webp', 'avif', 'ico'];
    const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'flv', 'f4v', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob',
        '3gp', '3g2', 'ts', 'mts', 'm2ts', 'divx', 'rm', 'rmvb', 'ogm', 'dv', 'mxf'];
    BitTorrentUI.IMAGE_EXT = IMAGE_EXT;
    BitTorrentUI.VIDEO_EXT = VIDEO_EXT;
    BitTorrentUI.kindOf = (name) => {
        const m = /\.([^.\\/]+)$/.exec(String(name || ''));
        const e = m ? m[1].toLowerCase() : '';
        return IMAGE_EXT.includes(e) ? 'image' : VIDEO_EXT.includes(e) ? 'video' : 'other';
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = BitTorrentUI;
    root.BitTorrentUI = BitTorrentUI;
})(typeof window !== 'undefined' ? window : globalThis);
