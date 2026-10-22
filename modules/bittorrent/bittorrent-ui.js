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
            this.selectedId = module.imports.length ? module.imports[module.imports.length - 1].id : null;
            this.progress = null; // { label, phase, pct, text }
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
            return `<button class="btt-item${sel}" data-act="select" data-id="${esc(i.id)}">
                <div class="btt-item-ip">${esc(i.ip || 'Unknown IP')}${i.port ? `<span class="btt-dim">:${esc(i.port)}</span>` : ''}${i.teredo ? ' <span class="btt-tag">Teredo</span>' : ''}</div>
                <div class="btt-item-when">${esc(i.startedAt || '—')} ${esc(gmt(i.gmtOffsetMin))}</div>
                <div class="btt-item-stats">${num(pieces)} piece${pieces === 1 ? '' : 's'} · ${num(s.connected)} of ${num(s.attempts)} connected${i.warnings ? ` · <span class="btt-warn">⚠ ${i.warnings}</span>` : ''}</div>
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
                return;
            }
            if (this.selectedId !== i.id) return;
            this.model = model;
            this.fileView = { q: '', status: '', page: 0 };
            const body = document.getElementById('btt-card-body');
            if (body) body.innerHTML = this._cardBodyHtml(i, model);
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
                this._section('Key events', this._eventsHtml(m)) +
                this._section('Possession', this._possessionHtml(m)) +
                this._section(`Sessions <span class="btt-dim">(${num((m.sessions || []).length)})</span>`, this._sessionsHtml(m)) +
                this._section(`Files <span class="btt-dim">(${num((m.files || []).length)})</span>`, `<div id="btt-files">${this._filesHtml()}</div>`) +
                this._section('Netstat corroboration', this._netstatHtml(m)) +
                this._section('Logs read', this._sourcesHtml(m));
        }

        _section(title, inner) {
            return `<div class="btt-sec"><div class="btt-sec-title">${title}</div>${inner}</div>`;
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
            return ((this.model && this.model.files) || []).filter(f => f &&
                (!v.status || (v.status === 'unknown' ? !f.status : f.status === v.status)) &&
                (!q || String(f.path || f.name || '').toLowerCase().includes(q) || String(f.sha1 || '').includes(q) || String(f.md5 || '').includes(q) || String(f.index) === q));
        }

        _filesHtml() {
            const v = this.fileView || (this.fileView = { q: '', status: '', page: 0 });
            const list = this._filteredFiles();
            const per = 100, pages = Math.max(1, Math.ceil(list.length / per));
            if (v.page >= pages) v.page = pages - 1;
            const rows = list.slice(v.page * per, v.page * per + per);
            const badge = (f) => f.status === 'complete' ? '<span class="btt-badge ok">complete</span>'
                : f.status === 'incomplete' ? `<span class="btt-badge part" title="${num(f.bytesWritten)} of ${num(f.size)} bytes">partial</span>`
                    : f.status === 'none' ? '<span class="btt-badge none">none</span>' : '<span class="btt-dim">—</span>';
            const opt = (val, label) => `<option value="${val}" ${v.status === val ? 'selected' : ''}>${label}</option>`;
            return `<div class="btt-files-bar">
                    <input id="btt-file-q" class="btt-input" placeholder="Search path, SHA-1, MD5 or #" value="${esc(v.q)}">
                    <select id="btt-file-status" class="btt-input">${opt('', 'All files')}${opt('complete', 'Complete')}${opt('incomplete', 'Partial')}${opt('none', 'None')}${opt('unknown', 'No result in log')}</select>
                    <span class="btt-dim">${num(list.length)} file${list.length === 1 ? '' : 's'}</span>
                    <span class="btt-pager">
                        <button class="btt-btn small" data-act="fpage" data-p="${v.page - 1}" ${v.page <= 0 ? 'disabled' : ''}>‹</button>
                        <span class="btt-dim">page ${v.page + 1} of ${pages}</span>
                        <button class="btt-btn small" data-act="fpage" data-p="${v.page + 1}" ${v.page >= pages - 1 ? 'disabled' : ''}>›</button>
                    </span>
                </div>
                <table class="btt-table btt-files"><thead><tr><th>#</th><th>Path in torrent</th><th>Size</th><th>Status</th><th>SHA-1</th><th>MD5</th></tr></thead><tbody>
                ${rows.map(f => `<tr><td>${f.index}</td><td class="btt-path">${esc(f.path || f.name || '')}</td><td class="btt-nowrap">${bytes(f.size)}</td><td>${badge(f)}</td>
                    <td class="btt-mono" title="${esc(f.sha1b32 ? 'Base32 ' + f.sha1b32 : '')}">${esc(f.sha1 || '')}</td><td class="btt-mono">${esc(f.md5 || '')}</td></tr>`).join('')}
                </tbody></table>`;
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

        async _onClick(e) {
            const b = e.target.closest('[data-act]');
            if (!b || !this.el.contains(b)) return;
            const act = b.getAttribute('data-act');
            if (act === 'import') return this.importFromPicker();
            if (act === 'find') return this.findInEvidence();
            if (act === 'cancel') { this.module.cancel(); this._setProgress(Object.assign({}, this.progress, { text: 'Cancelling…' })); return; }
            if (act === 'select') { this.selectedId = b.getAttribute('data-id'); this.render(); return; }
            if (act === 'remove') return this.removeImport(b.getAttribute('data-id'));
            if (act === 'arin') return this.arinLookup(b.getAttribute('data-id'));
            if (act === 'send') return this.sendToPeople(b.getAttribute('data-id'));
            if (act === 'grp') {
                const det = b.parentElement;
                const body = det && det.querySelector('.btt-grp-body');
                if (body && !body.dataset.filled) { body.innerHTML = this._groupBodyHtml(Number(b.getAttribute('data-g'))); body.dataset.filled = '1'; }
                return;
            }
            if (act === 'fpage') { this.fileView.page = Math.max(0, Number(b.getAttribute('data-p')) || 0); this._refreshFiles(); return; }
        }

        _refreshFiles(keepFocus) {
            const box = document.getElementById('btt-files');
            if (!box) return;
            const q = document.getElementById('btt-file-q');
            const pos = q ? q.selectionStart : null;
            box.innerHTML = this._filesHtml();
            if (keepFocus) {
                const n = document.getElementById('btt-file-q');
                if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); }
            }
        }

        _onInput(e) {
            if (!e.target || !this.fileView) return;
            if (e.target.id === 'btt-file-q') {
                this.fileView.q = e.target.value; this.fileView.page = 0;
                clearTimeout(this._qTimer);
                this._qTimer = setTimeout(() => this._refreshFiles(true), 200);
            } else if (e.target.id === 'btt-file-status') {
                this.fileView.status = e.target.value; this.fileView.page = 0; this._refreshFiles();
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
                outside ? 'Each ticked download (Logs and Download folders) is copied into this case under Evidence → BitTorrent, read, and added to the Evidence tab. Downloaded files are never shown here.'
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
            for (let k = 0; k < list.length; k++) {
                const d = list[k];
                const label = `${list.length > 1 ? `(${k + 1}/${list.length}) ` : ''}${d.ipFolder || d.caseFolder || 'Torrential Downpour download'}`;
                this._setProgress({ label, pct: 0, text: 'Starting…' });
                this._disableActions(true);
                try {
                    const r = await this.module.importDownload(d, { mode, onProgress: (p) => this._onProgress(label, p) });
                    if (r.replaced) updated++; else added++;
                    last = r.meta;
                } catch (err) {
                    if (err && err.cancelled) { this._toast('Import cancelled. Nothing was added.', 'info'); break; }
                    failed++;
                    this._toast(`Could not import ${esc(d.ipFolder || d.caseFolder || d.caseDir)}: ${esc(err && err.message || err)}`, 'error');
                }
            }
            this.progress = null;
            if (last) this.selectedId = last.id;
            this.render();
            if (added || updated) {
                const parts = [];
                if (added) parts.push(`${added} download${added > 1 ? 's' : ''} added`);
                if (updated) parts.push(`${updated} re-read`);
                this._toast(`BitTorrent: ${parts.join(', ')}${mode === 'copy' ? ' — copied into Evidence → BitTorrent' : ''}.`, 'success');
            }
            this.module.scanEvidence().catch(() => {});
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
            if (this.selectedId === id) this.selectedId = null;
            this.render();
        }

        destroy() {
            const el = this.el;
            if (el) el.onclick = null;
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = BitTorrentUI;
    root.BitTorrentUI = BitTorrentUI;
})(typeof window !== 'undefined' ? window : globalThis);
