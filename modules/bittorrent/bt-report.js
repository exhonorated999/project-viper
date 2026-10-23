/**
 * BitTorrent tab — outputs (BT Phase 5).
 *   reportBlocks() Download Summary as plain blocks — rendered by reportHtml()
 *                  for the PDF and by modules/reports/blocks-docx.js (main)
 *                  for the editable Word report in the Reports tab.
 *   reportHtml()   Download Summary (HTML → PDF via save-html-as-pdf). Text only.
 *   hashCsv()      every torrent file with its hashes.
 *   pcParagraph()  facts paragraph for the case Probable Cause (Warrant Author).
 *
 * Defense-discovery rules (hard):
 *   - no images, video or thumbnails — downloaded media never leaves the case;
 *   - no undercover infrastructure: the investigator's public / LAN IP is
 *     never written (netstat is described without addresses);
 *   - no ICACCops data, no tool manual or training text.
 * File names ARE listed (officer's choice), but only for files the officer
 * picked, each with the officer's own description.
 *
 * Pure functions (no DOM, no IPC) so Node tests can run them.
 * UMD: `module` exists in VIPER's renderer, so assign both.
 */
(function (root) {
    'use strict';

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (n) => (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
    const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;
    function bytes(b) {
        if (b == null || isNaN(b)) return '—';
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(b);
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return (i ? v.toFixed(1) : v) + ' ' + u[i];
    }

    function parts(s) {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
        return m ? { y: +m[1], mo: +m[2], d: +m[3], h: m[4] != null ? +m[4] : null, mi: m[5] != null ? +m[5] : null, s: m[6] != null ? +m[6] : null } : null;
    }
    /** "2026-10-19 23:37:42" → "October 19, 2026" */
    function fmtDate(s) { const p = parts(s); return p ? `${MONTHS[p.mo - 1]} ${p.d}, ${p.y}` : ''; }
    /** → "11:37:42 PM" */
    function fmtTime(s) {
        const p = parts(s);
        if (!p || p.h == null) return '';
        const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
        return `${h12}:${String(p.mi).padStart(2, '0')}${p.s != null ? ':' + String(p.s).padStart(2, '0') : ''} ${p.h < 12 ? 'AM' : 'PM'}`;
    }
    function fmtDateTime(s) { const d = fmtDate(s), t = fmtTime(s); return d && t ? `${d} at ${t}` : (d || ''); }
    /** -420 → "UTC−07:00" */
    function utcLabel(min) {
        if (min == null || isNaN(min)) return '';
        const a = Math.abs(min);
        return `UTC${min < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    }
    /** Date object (this computer's clock) → "October 23, 2026 2:02 PM". */
    function localStamp(d, sep) {
        if (!(d instanceof Date) || isNaN(d)) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}${sep}${fmtTime(`2000-01-01 ${p(d.getHours())}:${p(d.getMinutes())}`)}`;
    }
    function utcOf(local, off, TM) { return (TM && TM.localToUtc && off != null) ? TM.localToUtc(local, off) : null; }

    function tmOf(ctx) { return (ctx && ctx.TM) || root.TdModel || null; }

    /** Report entries for this download, in index order: [{ index, description, file }] */
    function selectedFiles(imp, model) {
        const items = (imp && imp.report && imp.report.items) || {};
        const byIdx = new Map(((model && model.files) || []).filter(Boolean).map(f => [f.index, f]));
        return Object.keys(items).map(Number).filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
            .map(n => ({ index: n, description: String((items[n] && items[n].description) || '').trim(), file: byIdx.get(n) || null }))
            .filter(x => x.file);
    }
    function missingDescriptions(imp, model) { return selectedFiles(imp, model).filter(x => !x.description).length; }

    function verifyState(model, f) {
        const v = model && model.verify;
        if (!v || !f || !/^[0-9a-f]{40}$/i.test(String(f.sha1 || ''))) return '';
        if ((v.mismatched || []).includes(f.index)) return 'differs';
        if ((v.missing || []).includes(f.index)) return 'missing';
        if ((v.unreadable || []).includes(f.index)) return 'unreadable';
        return 'matches';
    }
    const VERIFY_TEXT = { matches: 'matches the TD log', differs: 'does NOT match the TD log', missing: 'not found in the Download folder', unreadable: 'could not be read' };
    const STATUS_TEXT = { complete: 'Downloaded in full', incomplete: 'Partly downloaded', none: 'Not downloaded' };

    /** One normalised fact sheet shared by the PDF and the PC paragraph. */
    function facts(imp, model, ctx) {
        imp = imp || {}; model = model || {}; ctx = ctx || {};
        const TM = tmOf(ctx);
        const s = model.summary || {};
        const d = model.download || {};
        const t = model.torrent || {};
        const c = model.closing || {};
        const r = model.remote || {};
        const sessions = model.sessions || [];
        const data = sessions.filter(x => (x.piecesDownloaded || 0) > 0);
        const clients = TM && TM.clientsSeen ? TM.clientsSeen(sessions).filter(x => x.handshakes > 0) : [];
        const main = clients[0] || null;
        const clientName = main ? `${main.name || main.tag || 'an unidentified program'}${main.version ? ' version ' + main.version : ''}` : '';
        const pieceCount = t.pieceCount || s.haveOf || null;
        const reported = c.acknowledged ? c.acknowledged.n : (s.maxHave != null ? s.maxHave : s.acknowledged);
        const f = s.files || {};
        const v = c.validation || null;
        const first = data[0] || null, last = data[data.length - 1] || null;
        const dataStart = first ? (first.handshakeAt || first.connectedAt || first.attemptAt) : null;
        const dataEnd = last ? (last.endedAt || null) : null;
        const ns = TM && TM.netstatSummary ? TM.netstatSummary(model) : null;
        return {
            ip: imp.ip || s.suspectIp || r.ip || '',
            port: imp.port || s.port || r.port || '',
            teredo: r.teredo || null,
            reportedIps: [r.reportedIPv4, r.reportedIPv6].filter(Boolean),
            location: imp.location || '',
            tool: imp.tool || (model.tool ? `${model.tool.name || 'Torrential Downpour'} ${model.tool.version || ''}`.trim() : 'Torrential Downpour'),
            infoHash: t.infoHash || imp.infoHash || '',
            torrentName: t.name || '',
            fileCount: t.fileCount, totalBytes: t.totalBytes, pieceCount, pieceSize: t.pieceSize,
            off: d.gmtOffsetMin != null ? d.gmtOffsetMin : imp.gmtOffsetMin,
            startedAt: d.startedAt || imp.startedAt || '', endedAt: d.endedAt || '',
            durationSec: s.durationSec,
            attempts: s.attempts || sessions.length, connected: s.connected || 0, handshakes: s.handshakes || 0,
            dataSessions: data.length, dataStart, dataEnd,
            dataSec: first && TM && TM.secondsBetween ? TM.secondsBetween(dataStart, dataEnd) : null,
            clients, clientName, clientTag: main ? main.tag : '',
            reported, reportedRef: c.acknowledged ? c.acknowledged.ref : null,
            piecesWritten: s.piecesWritten != null ? s.piecesWritten : s.piecesDownloaded,
            filesComplete: f.complete || 0, filesPartial: f.incomplete || 0, filesNone: f.none || 0, filesTotal: f.total || 0,
            filesReported: c.filesReported || null,
            validation: v, allValid: v ? !!v.allValid : null, validationRef: v ? v.ref : null,
            outcome: s.outcome || '', endReason: s.endReason || '', endRef: c.ref || null,
            acknowledgedAllNoData: !!s.acknowledgedAllNoData,
            netstat: ns,
            verify: model.verify || null,
            arin: imp.arin || null
        };
    }

    /** Section 1: the plain-English account. */
    function summaryParagraph(F) {
        const out = [];
        const where = `${F.ip || 'the suspect address'}${F.port ? ' port ' + F.port : ''}`;
        const when = F.startedAt ? `On ${fmtDateTime(F.startedAt)}${F.off != null ? ' (' + utcLabel(F.off) + ')' : ''}, ` : '';
        const hash = F.infoHash ? ` with info hash ${F.infoHash}` : '';
        if (F.connected > 0) {
            out.push(`${when}${when ? 'the' : 'The'} investigator's computer, running ${F.tool}, connected directly to a BitTorrent client at ${where} and requested the torrent${hash}.`);
            out.push(`Torrential Downpour downloads only from the one IP address it is pointed at, so every piece listed in this report came from that single source.`);
        } else {
            out.push(`${when}${when ? 'the' : 'The'} investigator's computer, running ${F.tool}, tried to connect to a BitTorrent client at ${where} for the torrent${hash}. None of the ${plural(F.attempts, 'connection attempt')} succeeded.`);
        }
        const of = F.pieceCount ? ` of ${num(F.pieceCount)}` : '';
        if (F.dataSessions === 1) {
            const len = F.dataSec != null ? ` lasting ${spellDuration(F.dataSec)}` : '';
            out.push(`In one session${len}, ${num(F.piecesWritten)}${of} pieces were downloaded.`);
        } else if (F.dataSessions > 1) {
            out.push(`Across ${num(F.dataSessions)} sessions, ${num(F.piecesWritten)}${of} pieces were downloaded.`);
        } else if (F.handshakes > 0) {
            out.push(F.reported != null
                ? `The suspect's client reported having ${num(F.reported)}${of} pieces, but no pieces were downloaded.`
                : 'No pieces were downloaded.');
        }
        if (F.piecesWritten > 0 && F.allValid === true) out.push('Each downloaded piece matched the SHA-1 hash in the torrent.');
        if (F.piecesWritten > 0 && F.allValid === false) out.push(`${plural(F.validation.failures ? F.validation.failures.length : 0, 'piece')} failed SHA-1 validation.`);
        if (F.piecesWritten > 0 && F.filesTotal) out.push(`${num(F.filesComplete)} of the torrent's ${num(F.filesTotal)} files were downloaded in full.`);
        const why = F.endReason || (F.outcome ? 'the download was ' + F.outcome : '');
        if (F.endedAt) out.push(`The download ended on ${fmtDateTime(F.endedAt)}${why ? ' (' + why.replace(/\.$/, '') + ')' : ''}.`);
        return out.join(' ');
    }

    function spellDuration(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
        const p = [];
        if (h) p.push(plural(h, 'hour'));
        if (m) p.push(plural(m, 'minute'));
        if (s || !p.length) p.push(plural(s, 'second'));
        return p.length > 1 ? p.slice(0, -1).join(', ') + ' and ' + p[p.length - 1] : p[0];
    }

    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    /** Affidavit style: one–ten spelled out, larger numbers as digits. */
    const word = (n) => (Number.isInteger(Number(n)) && n >= 0 && n <= 10) ? WORDS[n] : num(n);
    const countWords = (n, one, many) => `${word(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;
    /** "a, b and c" → "a, b, and c" (serial comma). */
    function listJoin(a) {
        if (a.length <= 1) return a[0] || '';
        if (a.length === 2) return `${a[0]} and ${a[1]}`;
        return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
    }
    /** Officer description → clause that follows `"name" (SHA-1: …), `. Lower-cases a
     *  generic lead word ("A video…" → "a video…") and ends it with a period. */
    function descClause(d) {
        let s = String(d || '').trim();
        if (!s) return '[description not entered].';
        s = s.replace(/^(A|An|The|This|Video|Image|Picture|Photo|Photograph|Still|File)\b/, m => m.toLowerCase());
        return /[.!?]["')\]]?$/.test(s) ? s : s + '.';
    }

    /**
     * Facts for the case Probable Cause. First person, affidavit style, one
     * paragraph per step (method → connection → download → files → conclusion).
     * Every sentence is driven by what the TD logs show; nothing is asserted
     * that the logs don't support (failed connections, no data, failed hashes).
     */
    function pcParagraph(imp, model, ctx) {
        const F = facts(imp, model, ctx);
        const ip = F.ip || 'the suspect address';
        const hash = F.infoHash || '(not recorded)';
        const tz = F.off != null ? ` (${utcLabel(F.off)})` : '';
        const got = F.piecesWritten > 0;
        const paras = [];

        // 1. The tool and how it is configured.
        const day = F.startedAt ? `On ${fmtDate(F.startedAt)}, ` : '';
        paras.push(`${day}I utilized a law enforcement BitTorrent investigative tool designed to download data exclusively from a single target Internet Protocol (IP) address. The software is configured so that all downloaded data originates only from the selected IP address and not from any other BitTorrent peer participating in the torrent swarm.`);

        // 2. The connection and what the remote device said about itself.
        const at = `a device utilizing IP address ${ip}${F.port ? ' on port ' + F.port : ''}`;
        const p2 = [];
        if (F.connected > 0) {
            p2.push(`Using this tool, I established a direct connection with ${at} that was advertising the BitTorrent torrent associated with info hash ${hash}.`);
            const bits = [];
            if (F.clientName) bits.push(`identified itself as running ${F.clientName}`);
            if (F.reported != null) bits.push(F.pieceCount
                ? `reported possessing ${num(F.reported)} of the torrent's ${num(F.pieceCount)} available pieces`
                : `reported possessing ${plural(F.reported, 'piece')} of the torrent`);
            if (bits.length) p2.push(`During the connection, the remote device ${bits.join(' and ')}.`);
        } else {
            p2.push(`Using this tool, I attempted to establish a direct connection with ${at} in connection with the BitTorrent torrent associated with info hash ${hash}. None of the ${plural(F.attempts, 'connection attempt')} succeeded.`);
        }
        paras.push(p2.join(' '));

        // 3. The download itself: exclusive source + piece verification.
        if (got) {
            const p3 = [];
            const span = F.dataStart && F.dataEnd
                ? (fmtDate(F.dataStart) === fmtDate(F.dataEnd)
                    ? `Between ${fmtTime(F.dataStart)} and ${fmtTime(F.dataEnd)}`
                    : `Between ${fmtDateTime(F.dataStart)} and ${fmtDateTime(F.dataEnd)}`) + `${tz}, `
                : '';
            const over = F.dataSessions > 1 ? `over ${countWords(F.dataSessions, 'separate connection')}, ` : '';
            p3.push(`${span}${over}I downloaded ${num(F.piecesWritten)} torrent ${Number(F.piecesWritten) === 1 ? 'piece' : 'pieces'} directly from the device at IP address ${ip}.`);
            p3.push('No portion of the downloaded data was obtained from any other device or peer on the BitTorrent network.');
            p3.push(`Because the investigative software was configured to download data only from the target IP address, the recovered files and file fragments were obtained exclusively from the device utilizing IP address ${ip}.`);
            if (F.allValid === true) {
                p3.push('Each downloaded piece was independently verified against its expected SHA-1 hash value and matched exactly, confirming the integrity of the data received from the target device.');
            } else if (F.allValid === false) {
                const bad = (F.validation && F.validation.failures) ? F.validation.failures.length : 0;
                p3.push(`Each downloaded piece was checked against its expected SHA-1 hash value; ${bad ? plural(bad, 'piece') + ' did not match' : 'not every piece matched'}.`);
            }
            paras.push(p3.join(' '));
        } else if (F.handshakes > 0) {
            paras.push(`No torrent pieces were downloaded from the device at IP address ${ip}.`);
        }

        // 4. Who the address belongs to (only when the officer ran the lookup).
        if (F.arin && (F.arin.provider || F.arin.org)) {
            paras.push(`A query of the American Registry for Internet Numbers (ARIN) showed that IP address ${F.arin.ip || ip} is registered to ${F.arin.provider || F.arin.org}.`);
        }

        // 5. What the pieces rebuilt, and the files the officer reviewed.
        const sel = got ? selectedFiles(imp, model) : [];
        if (got) {
            const made = [];
            if (F.filesComplete) made.push(countWords(F.filesComplete, 'complete file'));
            if (F.filesPartial) made.push(countWords(F.filesPartial, 'partial file'));
            if (made.length) paras.push(`The downloaded pieces reconstructed ${made.join(' and ')} contained within the torrent.`);
        }
        if (sel.length) {
            const others = sel.length < (F.filesComplete + F.filesPartial);
            paras.push(`I subsequently reviewed the recovered files and observed${others ? ', among others' : ' the following'}:`);
            sel.forEach(x => {
                const name = String(x.file.path || x.file.name || '').split(/[\\/]/).pop();
                paras.push(`"${name}"${x.file.sha1 ? ' (SHA-1: ' + x.file.sha1 + ')' : ''}, ${descClause(x.description)}`);
            });
        }

        // 6. Conclusion — only the grounds the logs actually support.
        if (got) {
            const grounds = [`the direct connection to IP address ${ip}`, 'the exclusive download of torrent pieces from that IP address'];
            if (F.allValid === true) grounds.push('the successful verification of those pieces through SHA-1 hash matching');
            if (sel.length) grounds.push('my review of the reconstructed files');
            paras.push(`Based on ${listJoin(grounds)}, I determined that the device associated with IP address ${ip} was actively offering and distributing files associated with the torrent identified by info hash ${hash}.`);
        } else if (F.connected > 0 && F.reported > 0) {
            paras.push(`Based on the direct connection to IP address ${ip} and the device's report that it possessed ${num(F.reported)}${F.pieceCount ? ' of the ' + num(F.pieceCount) : ''} pieces of the torrent, I determined that the device associated with IP address ${ip} was offering files associated with the torrent identified by info hash ${hash}.`);
        }

        return paras.join('\n\n');
    }

    // ── Download Summary (HTML for save-html-as-pdf) ─────────────────────
    const CSS = `
        @page { size: Letter; margin: 0.6in 0.6in 0.75in; }
        * { box-sizing: border-box; }
        body { font-family: "Segoe UI", Arial, "Noto Sans", sans-serif; color: #111; font-size: 10.5pt; line-height: 1.4; margin: 0; }
        h1 { font-size: 17pt; margin: 0 0 2px; }
        h2 { font-size: 12pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1.5px solid #333; page-break-after: avoid; }
        .sub { color: #444; font-size: 9.5pt; }
        .notice { margin: 10px 0 4px; padding: 6px 9px; border: 1px solid #999; background: #f4f4f4; font-size: 9.5pt; }
        p { margin: 6px 0; }
        table { width: 100%; border-collapse: collapse; margin: 4px 0; }
        th, td { text-align: left; vertical-align: top; padding: 3px 6px; border: 1px solid #bbb; font-size: 9.5pt; }
        th { background: #eee; }
        tr { page-break-inside: avoid; }
        table.kv td:first-child { width: 34%; color: #333; background: #fafafa; }
        .mono { font-family: Consolas, "Courier New", monospace; font-size: 8.8pt; word-break: break-all; }
        .ref { color: #555; font-size: 8.5pt; white-space: nowrap; }
        .file { border: 1px solid #999; padding: 6px 9px; margin: 8px 0; page-break-inside: avoid; }
        .file .fn { font-weight: 600; word-break: break-all; }
        .file .desc { margin-top: 5px; padding: 5px 7px; background: #f6f6f6; border-left: 3px solid #555; white-space: pre-wrap; }
        .warn { color: #8a1c1c; font-weight: 600; }
        ul { margin: 4px 0 4px 18px; padding: 0; }
    `;

    // ── Report blocks ────────────────────────────────────────────────────
    // ONE description of the Download Summary. reportHtml() renders it for
    // the PDF; modules/reports/blocks-docx.js (main) renders the same blocks
    // as an editable Word report — so the two always say the same thing.
    // Plain JSON (it crosses IPC). Text is NOT escaped here; each renderer does.
    //   run   : string | { t, s: 'mono'|'ref'|'warn'|'sub'|'i' } | { br: true }
    //   block : { k:'title', text } | { k:'sub', runs } | { k:'notice', text } | { k:'h2', text }
    //         | { k:'p', runs, style?: 'sub'|'warn' } | { k:'kv', rows:[{ label, runs }] }
    //         | { k:'table', head:[text], widths:[fraction], nowrap:[col], rows:[[runs]] }
    //         | { k:'file', title, lines:[{ style?, runs }], desc } | { k:'ul', items:[text] } | { k:'end', text }
    const mono = (t) => ({ t: String(t == null ? '' : t), s: 'mono' });
    const warnRun = (t) => ({ t: String(t), s: 'warn' });
    const refRuns = (x) => x ? [' ', { t: `[${x}]`, s: 'ref' }] : [];
    function kv(rows) {
        return { k: 'kv', rows: rows.filter(r => r && r[1] != null && r[1] !== '').map(r => ({ label: r[0], runs: Array.isArray(r[1]) ? r[1] : [String(r[1])] })) };
    }
    const whenText = (local, off, TM) => {
        if (!local) return '';
        const u = utcOf(local, off, TM);
        return `${fmtDateTime(local)}${off != null ? ' (' + utcLabel(off) + ')' : ''}${u ? ' / ' + u + ' UTC' : ''}`;
    };

    function reportBlocks(imp, model, ctx) {
        ctx = ctx || {};
        const TM = tmOf(ctx);
        const F = facts(imp, model, ctx);
        const gen = ctx.generatedAt ? new Date(ctx.generatedAt) : new Date();
        const genText = localStamp(gen, ' ');
        const officer = ctx.officer || {};
        const prep = [officer.who, officer.agencyName].filter(Boolean).join(', ');
        const pct = (n) => (F.pieceCount && n != null) ? ` (${(n / F.pieceCount * 100).toFixed(1)}%)` : '';
        const ofN = (n) => `${num(n)}${F.pieceCount ? ' of ' + num(F.pieceCount) : ''}${pct(n)}`;
        const B = [];

        B.push({ k: 'title', text: 'Download Summary — BitTorrent (Torrential Downpour)' },
            { k: 'sub', runs: [`Case ${ctx.caseNumber || ''}${ctx.caseName && ctx.caseName !== ctx.caseNumber ? ' · ' + ctx.caseName : ''}${prep ? ' · ' + prep : ''}`] },
            { k: 'sub', runs: [`Generated by V.I.P.E.R.${ctx.appVersion ? ' ' + ctx.appVersion : ''} on ${genText}`] },
            { k: 'notice', text: 'This report contains no images or video. Downloaded files are not included.' });

        B.push({ k: 'h2', text: 'Summary' }, { k: 'p', runs: [summaryParagraph(F, ctx)] });

        const client = !F.clientName ? ['Not identified (no handshake in these logs)']
            : [F.clientName].concat(F.clientTag ? [' (peer ID ', mono(F.clientTag), ')'] : [], [" — self-reported by the suspect's software"],
                F.clients.length > 1 ? [{ br: true }, warnRun(`${num(F.clients.length)} different BitTorrent programs answered from this address: ${F.clients.map(c => c.label).join('; ')}.`)] : []);
        B.push({ k: 'h2', text: 'Download details' }, kv([
            ['Suspect IP / port', `${F.ip}${F.port ? ' : ' + F.port : ''}`],
            F.teredo ? ['Teredo address', `${F.teredo.ipv6 || ''} → IPv4 ${F.teredo.ipv4 || ''}`] : null,
            F.reportedIps.length ? ['Suspect client reported its own IP as', F.reportedIps.join(', ')] : null,
            F.location ? ['Approximate location (from the Torrential Downpour folder name)', F.location] : null,
            ["Suspect's BitTorrent program", client],
            ['Torrential Downpour version', F.tool],
            ['Info hash', [mono(F.infoHash || '—')]],
            F.torrentName ? ['Torrent name', F.torrentName] : null,
            ['Contents', `${plural(F.fileCount, 'file')}${F.totalBytes ? ' · ' + bytes(F.totalBytes) : ''}${F.pieceCount ? ' · ' + plural(F.pieceCount, 'piece') : ''}${F.pieceSize ? ' of ' + bytes(F.pieceSize) : ''}`],
            ['Started', whenText(F.startedAt, F.off, TM)],
            ['Ended', whenText(F.endedAt, F.off, TM)],
            F.durationSec != null && TM && TM.formatDuration ? ['Length', TM.formatDuration(F.durationSec)] : null,
            ['Outcome', [[F.outcome, F.endReason].filter(Boolean).join(' — ') || '—'].concat(refRuns(F.endRef))]
        ]));

        if (F.arin && (F.arin.provider || F.arin.org)) {
            const a = F.arin;
            B.push({ k: 'h2', text: 'Internet provider (ARIN)' }, kv([
                ['Address looked up', a.ip || F.ip],
                ['Registered to', a.provider || a.org],
                a.org && a.org !== a.provider ? ['Organization', a.org] : null,
                a.netRange || a.network ? ['Network', [a.netRange, a.network && a.network !== a.netRange ? a.network : ''].filter(Boolean).join(' · ')] : null,
                a.country ? ['Country', a.country] : null,
                a.lookedUpAt && !isNaN(new Date(a.lookedUpAt)) ? ['Looked up', localStamp(new Date(a.lookedUpAt), ' at ')] : null
            ]), { k: 'p', style: 'sub', runs: ['ARIN WHOIS shows who an address block is registered to. The subscriber has to come from the provider.'] });
        }

        const fr = F.filesReported;
        const val = !F.validation ? 'No validation result in these logs'
            : F.allValid ? `All ${F.validation.count ? num(F.validation.count) + ' ' : ''}written pieces matched the expected SHA-1 hash`
                : `${plural(F.validation.failures ? F.validation.failures.length : 0, 'piece')} failed SHA-1 validation`;
        B.push({ k: 'h2', text: 'What the suspect had vs. what was downloaded' }, kv([
            ["Suspect's client reported having", [`${ofN(F.reported)} pieces`].concat(refRuns(F.reportedRef))],
            ['Downloaded from the suspect', `${ofN(F.piecesWritten)} pieces`],
            fr ? ['Files the suspect reported complete', [`${num(fr.n)} of ${num(fr.of)}`].concat(refRuns(fr.ref))] : null,
            ['Files downloaded', `${num(F.filesComplete)} in full · ${num(F.filesPartial)} partial · ${num(F.filesNone)} none (of ${num(F.filesTotal)})`],
            ['Piece validation', [val].concat(refRuns(F.validationRef))]
        ]));
        if (F.acknowledgedAllNoData) B.push({ k: 'p', style: 'warn', runs: ['The suspect reported having every piece, but no data was downloaded.'] });

        const ev = Array.isArray(ctx.events) ? ctx.events : [];
        B.push({ k: 'h2', text: 'Connection history' },
            { k: 'p', runs: [`${plural(F.attempts, 'connection attempt')}: ${num(F.connected)} connected, ${num(Math.max(0, F.attempts - F.connected))} got no answer; ${plural(F.handshakes, 'handshake')}; ${plural(F.dataSessions, 'session')} delivered data.`] });
        if (ev.length) {
            B.push({
                k: 'table', head: [`Local time${F.off != null ? ' (' + utcLabel(F.off) + ')' : ''}`, 'UTC', 'What the log shows', 'Source'],
                widths: [0.21, 0.21, 0.42, 0.16], nowrap: [0, 1],
                rows: ev.map(e => [[String(e.at || '')], [String(utcOf(e.at, F.off, TM) || '')], [String(e.text || '')], [{ t: String(e.ref || ''), s: 'ref' }]])
            });
        }

        const ns = F.netstat;
        if (ns && ns.blocks) {
            const firstLast = !ns.first ? ''
                : (!ns.last || fmtDateTime(ns.last) === fmtDateTime(ns.first)) ? `, at ${fmtDateTime(ns.first)}`
                    : `, the first at ${fmtDateTime(ns.first)} and the last at ${fmtDateTime(ns.last)}`;
            B.push({ k: 'h2', text: 'Netstat corroboration' },
                { k: 'p', runs: [`Torrential Downpour recorded ${plural(ns.blocks, 'netstat snapshot')} on the investigator's computer. ${num(ns.withRemote)} of them ${Number(ns.withRemote) === 1 ? 'shows' : 'show'} a connection to the suspect address ${F.ip}${F.port ? ':' + F.port : ''}${ns.established ? ` (${num(ns.established)} in the ESTABLISHED state)` : ''}${firstLast}.`] });
        }

        const v = F.verify;
        if (v && v.withHash) {
            const bad = (v.mismatched || []).length + (v.missing || []).length + (v.unreadable || []).length;
            const atText = v.at ? localStamp(new Date(v.at), ' at ') : '';
            B.push({ k: 'h2', text: 'Downloaded files integrity check (performed by VIPER)' }, {
                k: 'p', runs: [`${atText ? 'On ' + atText + ', ' : ''}VIPER recalculated the SHA-1 hash of each downloaded file in the Download folder. `, bad
                    ? warnRun(`${num(v.matched)} of ${num(v.withHash)} files match the hashes recorded in the Torrential Downpour log: ${num((v.mismatched || []).length)} differ, ${num((v.missing || []).length)} are missing and ${num((v.unreadable || []).length)} could not be read.`)
                    : `${v.withHash === 1 ? 'The file matches the hash' : v.withHash === 2 ? 'Both files match the hashes' : `All ${num(v.withHash)} files match the hashes`} recorded in the Torrential Downpour log. None differ and none are missing.`]
            });
        }

        const sel = selectedFiles(imp, model);
        B.push({ k: 'h2', text: 'Files reviewed by the investigator' });
        if (!sel.length) B.push({ k: 'p', style: 'sub', runs: ['No files were selected for this report.'] });
        else {
            B.push({ k: 'p', runs: [`${plural(sel.length, 'file')} selected by the investigator, with the investigator's description of each. The complete list of the torrent's ${num(F.filesTotal)} files and their hashes is in the separate hash list (CSV).`] });
            sel.forEach(x => {
                const f = x.file;
                const name = String(f.path || f.name || '');
                const base = name.split(/[\\/]/).pop();
                const vs = verifyState(model, f);
                const lines = [];
                if (name !== base) lines.push({ style: 'sub', runs: [`Path in torrent: ${name}`] });
                lines.push({ style: 'sub', runs: [`${bytes(f.size)} · ${STATUS_TEXT[f.status] || 'No result in log'}${f.status === 'incomplete' && f.bytesWritten != null ? ` (${num(f.bytesWritten)} of ${num(f.size)} bytes)` : ''}${vs ? ' · VIPER hash check: ' + VERIFY_TEXT[vs] : ''}`] });
                if (f.sha1) lines.push({ runs: [{ t: 'SHA-1', s: 'sub' }, ' ', mono(f.sha1)].concat(f.md5 ? [' ', { t: 'MD5', s: 'sub' }, ' ', mono(f.md5)] : []) });
                B.push({ k: 'file', title: `File #${f.index} — ${base}`, lines, desc: x.description || '' });
            });
        }

        B.push({ k: 'h2', text: 'Notes' }, { k: 'ul', items: [
            "All times are as recorded by Torrential Downpour on the investigator's computer.",
            "The program name and version are self-reported by the suspect's software and can be altered.",
            'Bracketed references (for example [summary.txt:1204]) give the Torrential Downpour log file and line each fact came from.',
            "This report was generated from the tool's log files. It contains no images, video, ICACCops data or training material."
        ] });

        B.push({ k: 'end', text: `— End of report — Case ${ctx.caseNumber || ''} · BitTorrent Download Summary · ${F.ip} · generated ${genText}` });
        return B;
    }

    // ── Blocks → HTML (for save-html-as-pdf) ─────────────────────────────
    const RUN_CLASS = { mono: 'mono', ref: 'ref', warn: 'warn', sub: 'sub' };
    function runsHtml(runs) {
        return (Array.isArray(runs) ? runs : [runs]).map(r => {
            if (r == null) return '';
            if (typeof r !== 'object') return esc(r);
            if (r.br) return '<br>';
            if (r.s === 'i') return `<i>${esc(r.t)}</i>`;
            return RUN_CLASS[r.s] ? `<span class="${RUN_CLASS[r.s]}">${esc(r.t)}</span>` : esc(r.t);
        }).join('');
    }
    function blockHtml(b) {
        switch (b && b.k) {
            case 'title': return `<h1>${esc(b.text)}</h1>`;
            case 'sub': return `<div class="sub">${runsHtml(b.runs)}</div>`;
            case 'notice': return `<div class="notice">${esc(b.text)}</div>`;
            case 'h2': return `<h2>${esc(b.text)}</h2>`;
            case 'p': return `<p${b.style ? ` class="${b.style === 'warn' ? 'warn' : 'sub'}"` : ''}>${runsHtml(b.runs)}</p>`;
            case 'kv': return `<table class="kv">${b.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${runsHtml(r.runs)}</td></tr>`).join('')}</table>`;
            case 'table': {
                const nw = new Set(b.nowrap || []);
                return `<table><thead><tr>${(b.head || []).map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>
            ${(b.rows || []).map(row => `<tr>${row.map((c, i) => `<td${nw.has(i) ? ' style="white-space:nowrap"' : ''}>${runsHtml(c)}</td>`).join('')}</tr>`).join('\n')}
            </tbody></table>`;
            }
            case 'file': return `<div class="file">
                    <div class="fn">${esc(b.title)}</div>
                    ${(b.lines || []).map(l => `<div${l.style === 'sub' ? ' class="sub"' : ''}>${runsHtml(l.runs)}</div>`).join('\n')}
                    <div class="desc">${b.desc ? esc(b.desc) : '<i>(No description entered.)</i>'}</div>
                </div>`;
            case 'ul': return `<ul>${(b.items || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
            case 'end': return `<p class="sub" style="margin-top:14px">${esc(b.text)}</p>`;
            default: return '';
        }
    }

    function reportHtml(imp, model, ctx) {
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BitTorrent Download Summary</title><style>${CSS}</style></head>
            <body>${reportBlocks(imp, model, ctx).map(blockHtml).join('\n')}</body></html>`;
    }

    /** Plain text for the per-page footer (save-html-as-pdf options.footerText, which adds "Page n of N"). */
    function footerText(imp, model, ctx) {
        ctx = ctx || {};
        const gen = ctx.generatedAt ? new Date(ctx.generatedAt) : new Date();
        return `Case ${ctx.caseNumber || ''} · BitTorrent Download Summary · ${(imp && imp.ip) || ''} · generated ${localStamp(gen, ' ')}`;
    }

    // ── Hash list CSV ────────────────────────────────────────────────────
    function csvCell(v) {
        let s = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;        // spreadsheet formula injection
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function hashCsv(imp, model) {
        const items = (imp && imp.report && imp.report.items) || {};
        const head = ['Index', 'File name', 'Path in torrent', 'Size (bytes)', 'Download status', 'Bytes downloaded', 'SHA-1', 'SHA-1 (Base32)', 'MD5', 'VIPER hash check', 'In report', 'Investigator description'];
        const rows = ((model && model.files) || []).filter(Boolean).slice().sort((a, b) => a.index - b.index).map(f => {
            const name = String(f.path || f.name || '');
            const it = items[f.index];
            return [f.index, name.split(/[\\/]/).pop(), name, f.size, STATUS_TEXT[f.status] || '', f.bytesWritten, f.sha1 || '', f.sha1b32 || '', f.md5 || '',
                VERIFY_TEXT[verifyState(model, f)] || '', it ? 'yes' : '', it ? String(it.description || '').trim() : ''];
        });
        return '\ufeff' + [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    }

    /** "BitTorrent Download Summary - 203.0.113.45 - 2026-10-19.pdf" (Windows-safe). */
    function fileName(imp, kind, model) {
        const ip = String((imp && imp.ip) || 'unknown').replace(/[:<>"|?*\\/]/g, '-');
        const day = String(((model && model.download && model.download.startedAt) || (imp && imp.startedAt) || '')).slice(0, 10) || 'undated';
        return kind === 'csv' ? `BitTorrent Hash List - ${ip} - ${day}.csv` : `BitTorrent Download Summary - ${ip} - ${day}.${kind === 'docx' ? 'docx' : 'pdf'}`;
    }

    const API = { facts, summaryParagraph, pcParagraph, reportBlocks, reportHtml, footerText, hashCsv, fileName, selectedFiles, missingDescriptions, verifyState, fmtDate, fmtTime, fmtDateTime, utcLabel, spellDuration, csvCell };
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    root.BtReport = API;
})(typeof window !== 'undefined' ? window : globalThis);
