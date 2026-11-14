/**
 * ViperCaseInserts — "From case" tables and exhibit photos for the report
 * editor (rich-editor.js). Pure string builders: the host page gathers the
 * case records and hands them over; nothing here reads storage or the DOM.
 *
 *   people(list, role, opts)    suspects / victims / witnesses / involved persons
 *   vehicles(list, opts)        recovered vehicles
 *   evidence(list, opts)        evidence items (text only — never media)
 *   timeline(list, opts)        case timeline events, oldest first
 *       → HTML table (header row, the editor's cell borders) + an empty
 *         paragraph after it, or '' when there is nothing to list. Columns
 *         that are empty in every row are left out.
 *
 *   photoSources(src)           pictures the officer may place in the report:
 *                               person / residence / vehicle / injury /
 *                               property photos and evidence image files.
 *                               CyberTip (NCMEC) and CSAM-flagged evidence is
 *                               NEVER offered (isRestrictedEvidence), nor files
 *                               released from case storage.
 *   nextExhibitNumber(html)     one more than the highest "Exhibit N" in the report
 *   exhibitLabel(n, caption)    "Exhibit 3 — rear door, pry marks"
 *   photoBlock({ src, n, caption, widthPct })
 *                               centered picture + italic caption line
 *
 * Every value is HTML-escaped. Styles match the editor's own tables
 * (rich-editor.js CELL_STYLE / TABLE_STYLE) so they print the same.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ViperCaseInserts = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CELL_STYLE = 'border:1px solid #888;padding:4px 6px;vertical-align:top;text-align:left';
    const TABLE_STYLE = 'width:100%;border-collapse:collapse;margin:6px 0';
    const IMG_SRC = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
    const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|bmp|heic|heif|tiff?)$/i;
    const DASH = '\u2014';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const str = (v) => (v == null ? '' : String(v)).trim();
    const join = (parts, sep) => parts.map(str).filter(Boolean).join(sep);

    // ── Dates ────────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0');
    function fmtDate(v) {
        const s = str(v);
        if (!s) return '';
        const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (ymd) return ymd[2] + '/' + ymd[3] + '/' + ymd[1];
        const d = new Date(s);
        if (isNaN(d.getTime())) return s;
        return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
    }
    function fmtDateTime(v) {
        const s = str(v);
        if (!s) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
        const d = new Date(s);
        if (isNaN(d.getTime())) return s;
        return fmtDate(s) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    const timeOf = (v) => { const t = new Date(str(v)).getTime(); return isNaN(t) ? Infinity : t; };

    // ── Table ────────────────────────────────────────────────────────────
    /** cols: [{ label, get(row) }] → table HTML ('' for no rows). */
    function table(cols, rows) {
        const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
        if (!list.length) return '';
        const data = list.map((r) => cols.map((c) => { try { return str(c.get(r)); } catch (_) { return ''; } }));
        const keep = cols.map((c, i) => !!c.always || data.some((d) => d[i]));
        const cell = (t, v) => '<' + t + ' style="' + CELL_STYLE + '">' + (v ? esc(v).replace(/\r?\n/g, '<br>') : '<br>') + '</' + t + '>';
        let h = '<table class="vre-table" style="' + TABLE_STYLE + '"><tbody><tr>';
        cols.forEach((c, i) => { if (keep[i]) h += cell('th', c.label); });
        h += '</tr>';
        data.forEach((d) => {
            h += '<tr>';
            d.forEach((v, i) => { if (keep[i]) h += cell('td', v); });
            h += '</tr>';
        });
        return h + '</tbody></table><p><br></p>';
    }

    // ── People ───────────────────────────────────────────────────────────
    function personName(p) {
        if (!p) return '';
        return str(p.name) || join([p.firstName, p.middleName, p.lastName], ' ');
    }
    function heightText(h) {
        const s = str(h);
        return /^\d{3}$/.test(s) ? s[0] + "'" + s.slice(1) + '"' : s;
    }
    function weightText(w) {
        const s = str(w);
        return s && /^\d+(?:\.\d+)?$/.test(s) ? s + ' lbs' : s;
    }
    function dlText(p) {
        const num = str(p.dlNumber || p.driverLicense || p.driversLicense);
        const st = str(p.dlState);
        return num && st ? num + ' (' + st + ')' : num || (st ? '(' + st + ')' : '');
    }
    const ROLE_LABEL = { suspects: 'Suspect', victims: 'Victim', witnesses: 'Witness', involvedPersons: 'Involved person' };

    function people(list, role, opts) {
        const o = opts || {};
        const date = typeof o.formatDate === 'function' ? o.formatDate : fmtDate;
        const dl = typeof o.dlDisplay === 'function' ? (p) => o.dlDisplay(p, '') : dlText;
        const cols = [
            { label: 'Name', always: true, get: (p) => personName(p) || 'Unknown' },
        ];
        if (role === 'involvedPersons') cols.push({ label: 'Role', get: (p) => join([p.role || p.rmsRole, p.relationship], '\n') });
        // Law-enforcement witnesses (lawEnforcement: true) — title / agency /
        // badge / agency phone. The column drops out when no row has any.
        if (role === 'witnesses') {
            cols.push({ label: 'Law enforcement', get: (p) => (p.lawEnforcement
                ? join([p.leTitle || 'Law enforcement', p.agency, str(p.badgeNumber) ? 'Badge #' + str(p.badgeNumber) : '', p.agencyPhone], '\n')
                : '') });
        }
        cols.push(
            { label: 'DOB', get: (p) => (p.dob ? date(p.dob) : '') },
            { label: 'Sex / Race', get: (p) => join([p.sex, p.race], ' / ') },
            { label: 'Height / Weight', get: (p) => join([heightText(p.height), weightText(p.weight)], ' / ') },
            { label: 'Hair / Eyes', get: (p) => join([p.hairColor || p.hair, p.eyeColor || p.eyes], ' / ') },
            { label: 'Address', get: (p) => join([p.address, p.addressCityStateZip], '\n') },
            { label: 'Phone', get: (p) => join([p.phone || p.phone1, p.phone2], '\n') },
            { label: 'Email', get: (p) => join([p.email, p.email2], '\n') },
            { label: "Driver's License", get: (p) => dl(p) }
        );
        if (role === 'suspects') {
            cols.push({ label: 'Arrested', get: (p) => (p.arrested ? join(['Yes', p.arrestDate ? date(p.arrestDate) : ''], ' ' + DASH + ' ') : '') });
        }
        if (role === 'witnesses') {
            cols.push({ label: 'Testifying to', get: (p) => (p.lawEnforcement ? p.testimony : '') });
        }
        return table(cols, list);
    }

    // ── Vehicles ─────────────────────────────────────────────────────────
    function vehicleTitle(v) {
        return join([v.year, v.makeModel || join([v.make, v.model], ' ')], ' ');
    }
    function vehicles(list, opts) {
        const o = opts || {};
        const date = typeof o.formatDate === 'function' ? o.formatDate : fmtDate;
        return table([
            { label: 'Vehicle', always: true, get: (v) => vehicleTitle(v) || 'Unknown' },
            { label: 'Color', get: (v) => v.color },
            { label: 'Plate', get: (v) => join([v.licensePlate || v.plateNumber || v.plate, v.plateState || v.state], ' ') },
            { label: 'VIN', get: (v) => v.vin },
            { label: 'Recovered', get: (v) => join([v.recoveryDate ? date(v.recoveryDate) : '', v.recoveryLocation || v.locationRecovered || v.location], '\n') },
            { label: 'Status', get: (v) => (Array.isArray(v.status) ? v.status.filter(Boolean).join(', ') : v.status) },
        ], list);
    }

    // ── Evidence (text only) ─────────────────────────────────────────────
    function humanize(t) {
        return str(t).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    }
    function evidence(list, opts) {
        const o = opts || {};
        const date = typeof o.formatDate === 'function' ? o.formatDate : fmtDate;
        const labels = o.typeLabels || {};
        return table([
            { label: 'Item', always: true, get: (e) => e.tag || 'Evidence item' },
            { label: 'Type', get: (e) => join([e.type ? (labels[e.type] || humanize(e.type)) : '', e.discoverable === false ? '(investigative only)' : ''], ' ') },
            { label: 'Description', get: (e) => e.description },
            { label: 'Location', get: (e) => e.location },
            { label: 'Collected', get: (e) => (e.collectionDate ? date(e.collectionDate) : e.createdAt ? date(e.createdAt) : '') },
            { label: 'Files', get: (e) => { const n = +e.fileCount || (Array.isArray(e.files) ? e.files.length : 0); return n ? String(n) : ''; } },
        ], list);
    }

    // ── Timeline ─────────────────────────────────────────────────────────
    function timeline(list, opts) {
        const o = opts || {};
        const when = typeof o.formatDateTime === 'function' ? o.formatDateTime : fmtDateTime;
        const rows = (Array.isArray(list) ? list : []).filter((e) => e && (e.title || e.description))
            .slice().sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));
        return table([
            { label: 'Date / Time', always: true, get: (e) => join([when(e.timestamp), e.endTimestamp ? 'to ' + when(e.endTimestamp) : ''], '\n') },
            { label: 'Event', always: true, get: (e) => e.title },
            { label: 'Details', get: (e) => e.description },
        ], rows);
    }

    // ── Exhibit photos ───────────────────────────────────────────────────
    function nextExhibitNumber(html) {
        const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
        let max = 0;
        const re = /\bExhibit\s+(\d{1,4})\b/gi;
        let m;
        while ((m = re.exec(text))) max = Math.max(max, +m[1]);
        return max + 1;
    }
    function exhibitLabel(n, caption) {
        const c = str(caption).replace(/\s+/g, ' ');
        const num = Math.max(0, parseInt(n, 10) || 0);
        if (!num) return c;
        return 'Exhibit ' + num + (c ? ' ' + DASH + ' ' + c : '');
    }
    function imgStyleCenter(pct) {
        const w = Math.max(5, Math.min(100, Math.round((+pct || 60) * 10) / 10));
        return 'width:' + w + '%;height:auto;max-width:100%;float:none;display:block;margin:8px auto';
    }
    /** → '' unless src is a data:image URL the editor keeps. */
    function photoBlock(p) {
        const o = p || {};
        const src = str(o.src).replace(/\s/g, '');
        if (!IMG_SRC.test(src)) return '';
        const label = exhibitLabel(o.n, o.caption);
        return '<img src="' + esc(src) + '" data-wrap="center"' + (label ? ' alt="' + esc(label.slice(0, 200)) + '"' : '')
            + ' style="' + imgStyleCenter(o.widthPct) + '">'
            + (label ? '<p style="text-align:center"><i>' + esc(label) + '</i></p>' : '');
    }

    /**
     * True for evidence whose media must never be offered for the report:
     * CSAM-flagged or NCMEC CyberTip items, and — to be safe — anything whose
     * type, tag, description or folder names a CyberTip / NCMEC / CSAM source.
     */
    const RESTRICTED_TEXT = /cyber\s*-?\s*tip|ncmec|csam|\bcsem\b/i;
    function isRestrictedEvidence(e) {
        if (!e || typeof e !== 'object') return true;
        if (e.csamSensitive || e.ncmec) return true;
        return [e.type, e.tag, e.description, e.folder, e.sourcePath].some((v) => RESTRICTED_TEXT.test(str(v)));
    }

    function firstLine(s, max) {
        const l = str(s).split(/\r?\n/)[0].trim();
        return l.length > max ? l.slice(0, max - 1).trimEnd() + '\u2026' : l;
    }
    const baseName = (p) => str(p).replace(/\\/g, '/').split('/').pop();

    /**
     * src: { suspects, victims, witnesses, involvedPersons, vehicles, evidence }
     * → [{ id, group, label, caption, src } | { id, group, label, caption, filePath, fileName }]
     */
    function photoSources(src) {
        const s = src || {};
        const out = [];
        const add = (o) => { out.push(Object.assign({ id: 'p' + out.length }, o)); };
        const okSrc = (v) => typeof v === 'string' && IMG_SRC.test(v.replace(/\s/g, ''));
        const urlOf = (v) => (v && typeof v === 'object' ? v.url || v.src || v.dataUrl : v);
        [['suspects', 'Suspects'], ['victims', 'Victims'], ['witnesses', 'Witnesses'], ['involvedPersons', 'Involved persons']].forEach(([role, group]) => {
            (Array.isArray(s[role]) ? s[role] : []).forEach((p) => {
                if (!p || typeof p !== 'object') return;
                const who = personName(p) || ROLE_LABEL[role];
                if (okSrc(p.photo)) add({ group, label: who, caption: ROLE_LABEL[role] + ' ' + who, src: p.photo });
                if (okSrc(p.residencePhoto)) add({ group, label: who + ' ' + DASH + ' residence', caption: 'Residence of ' + who + (p.address ? ', ' + str(p.address) : ''), src: p.residencePhoto });
                (Array.isArray(p.vehicles) ? p.vehicles : []).forEach((v) => {
                    if (!v || !okSrc(v.photo)) return;
                    const what = join([vehicleTitle(v), v.color, v.plateNumber || v.licensePlate], ', ') || 'vehicle';
                    add({ group, label: who + ' ' + DASH + ' vehicle', caption: 'Vehicle of ' + who + ': ' + what, src: v.photo });
                });
                [['injuryPhotos', 'injury'], ['propertyPhotos', 'property']].forEach(([k, kind]) => {
                    (Array.isArray(p[k]) ? p[k] : []).forEach((ph) => {
                        const u = urlOf(ph);
                        if (!okSrc(u)) return;
                        const d = ph && typeof ph === 'object' ? firstLine(ph.description, 80) : '';
                        add({ group, label: who + ' ' + DASH + ' ' + kind, caption: d || (kind === 'injury' ? 'Injury, ' : 'Property of ') + who, src: u });
                    });
                });
            });
        });
        (Array.isArray(s.vehicles) ? s.vehicles : []).forEach((v) => {
            if (!v || !okSrc(v.photo)) return;
            const what = join([vehicleTitle(v), v.color, v.licensePlate || v.plateNumber], ', ') || 'Recovered vehicle';
            add({ group: 'Recovered vehicles', label: what, caption: 'Recovered vehicle: ' + what, src: v.photo });
        });
        (Array.isArray(s.evidence) ? s.evidence : []).forEach((e) => {
            if (!e || typeof e !== 'object' || isRestrictedEvidence(e) || e.released) return;
            const files = (Array.isArray(e.files) ? e.files : []).filter((f) => f && f.path && IMAGE_FILE.test(str(f.name || f.path)));
            files.forEach((f) => {
                const name = baseName(f.name || f.path);
                const what = firstLine(e.description, 80) || str(e.tag) || name;
                add({
                    group: 'Evidence', label: join([e.tag, name], ' ' + DASH + ' '),
                    caption: files.length > 1 ? what + ' (' + name + ')' : what,
                    filePath: f.path, fileName: name, evidenceId: e.id,
                });
            });
        });
        return out;
    }

    return {
        CELL_STYLE, TABLE_STYLE, esc, fmtDate, fmtDateTime, table, personName, heightText, weightText,
        people, vehicles, evidence, timeline, nextExhibitNumber, exhibitLabel, photoBlock,
        photoSources, isRestrictedEvidence,
    };
});
