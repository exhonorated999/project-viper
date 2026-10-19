/*
 * IDS Dashboard — the ICAC Activity Log and the monthly IDS Measures report.
 *
 * Two buttons under Generate Report on the main dashboard, shown only while
 * Settings → ICAC Task Force Reporting is on:
 *
 *   ICAC Activity Log    — things that happen outside any one case
 *                          (presentations, outreach, training, citizen
 *                          complaints, technical assists). Logged as they
 *                          happen, each with a date, so the month adds
 *                          itself up. Stored in localStorage
 *                          ['viperIdsActivities'] (a `viper*` key, so the
 *                          full backup already carries it).
 *   IDS Monthly Measures — pick a month, see every number with what makes
 *                          it up, download a PDF to key into IDS.
 *
 * Everything counted comes from IdsMeasures.build(); this file only gathers
 * the inputs and draws them. localStorage is a real window global, so unlike
 * the case page's `let` state it IS reachable from a module — but every
 * reader takes an injectable getItem so the tests can drive it in Node.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.IdsDashboard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var ACT_KEY = 'viperIdsActivities';
    var LOG_ID = 'idsActivityLogModal';
    var REPORT_ID = 'idsMeasuresModal';
    var NOTES_MAX = 200;

    var _period = null;      // the month the report modal is showing
    var _result = null;      // its last build() result

    function M() {
        var m = root && root.IdsMeasures;
        if (!m && typeof require === 'function') { try { m = require('./ids-measures.js'); } catch (_) { m = null; } }
        return m;
    }
    function ls() { try { return root && root.localStorage; } catch (_) { return null; } }
    // Raw stored text: the measures never need photos, and VpCaseBlobs'
    // getItem would read them back off disk for every case.
    function defaultGet(k) {
        var b = root && root.VpCaseBlobs;
        if (b && typeof b.getRaw === 'function') return b.getRaw(k);
        var s = ls(); return s ? s.getItem(k) : null;
    }
    function J(getItem, key, fb) {
        try {
            var raw = getItem(key);
            if (raw === null || raw === undefined || raw === '') return fb;
            var v = JSON.parse(raw);
            return (v === null || v === undefined) ? fb : v;
        } catch (_) { return fb; }
    }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function doc() { return root && root.document; }
    function byId(id) { var d = doc(); return d ? d.getElementById(id) : null; }
    function toast(msg, kind) {
        try {
            if (root.viperToast) return root.viperToast(msg, kind || 'info');
            if (root.showToast) return root.showToast(msg, kind || 'info');
        } catch (_) {}
    }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function todayIso(now) { var d = now ? new Date(now) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function kindInfo(k) {
        var list = M() ? M().ACTIVITY_KINDS : [];
        for (var i = 0; i < list.length; i++) if (list[i].value === k) return list[i];
        return null;
    }

    function enabled(getItem) { return (getItem || defaultGet)('viperIdsEnabled') === 'true'; }

    // ── Inputs for build() ──────────────────────────────────────────────

    function loadCases(getItem) {
        var all = J(getItem || defaultGet, 'viperCases', []);
        return Array.isArray(all) ? all.filter(function (c) { return c && typeof c === 'object'; }) : [];
    }

    /*
     * {[caseId]: {tips, suspects, warrants, devices, prosecution, icac}} from
     * where each module actually keeps it: per-case-id keys for the first
     * four, the shared case-NUMBER-keyed maps for warrants and devices.
     */
    function gatherStore(cases, getItem) {
        var get = getItem || defaultGet;
        var W = J(get, 'viperCaseWarrants', {}), D = J(get, 'viperCaseForensicDevices', {});
        if (!W || typeof W !== 'object') W = {};
        if (!D || typeof D !== 'object') D = {};
        var store = {};
        (cases || []).forEach(function (c) {
            if (!c || c.id === undefined || c.id === null) return;
            store[c.id] = {
                tips: J(get, 'cyberTips_' + c.id, []),
                suspects: J(get, 'suspects_' + c.id, []),
                prosecution: J(get, 'prosecution_' + c.id, {}),
                icac: J(get, 'icac_' + c.id, {}),
                warrants: Array.isArray(W[c.caseNumber]) ? W[c.caseNumber] : [],
                devices: Array.isArray(D[c.caseNumber]) ? D[c.caseNumber] : []
            };
        });
        return store;
    }

    function loadActivities(getItem) {
        var a = J(getItem || defaultGet, ACT_KEY, []);
        return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object'; }) : [];
    }

    function buildFor(period, getItem) {
        var m = M();
        if (!m) return null;
        var cases = loadCases(getItem);
        return m.build({ cases: cases, store: gatherStore(cases, getItem), activities: loadActivities(getItem), period: period });
    }

    // ── Activity entries ───────────────────────────────────────────────

    function _int(v) {
        var s = String(v === null || v === undefined ? '' : v).trim();
        if (!s) return null;
        if (!/^\d+$/.test(s)) return NaN;
        return parseInt(s, 10);
    }

    /*
     * Form values → a stored entry, or {error} in plain words.
     *   count  — blank means 1 (one presentation). Not stored for people-only kinds.
     *   people — required for people-only kinds (that IS the number IDS wants),
     *            optional for presentation/diversion, not stored for the rest.
     */
    function sanitizeActivity(raw, now) {
        raw = raw || {};
        var info = kindInfo(raw.kind);
        if (!info) return { error: 'Choose what kind of activity this was.' };
        var date = String(raw.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(M() && M().parseDate(date))) return { error: 'Enter the date it happened.' };
        var out = { id: String(raw.id || ('ida_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))), date: date, kind: info.value };
        var count = _int(raw.count), people = _int(raw.people);
        if (!info.peopleOnly) {
            if (count !== null && !(count >= 1)) return { error: 'How many should be a whole number of 1 or more.' };
            if (count !== null && count !== 1) out.count = count;
        }
        if (info.peopleOnly || info.people) {
            if (people !== null && !(people >= 0)) return { error: 'The number of people should be a whole number.' };
            if (info.peopleOnly && !(people >= 1)) return { error: 'Enter how many people.' };
            if (people !== null) out.people = people;
        }
        var notes = String(raw.notes || '').trim().slice(0, NOTES_MAX);
        if (notes) out.notes = notes;
        out.createdAt = new Date(now || Date.now()).toISOString();
        return { activity: out };
    }

    function saveActivities(list) {
        var s = ls();
        if (!s) return false;
        try { s.setItem(ACT_KEY, JSON.stringify(list)); return true; }
        catch (e) { try { console.error('[IDS] could not save the activity log', e); } catch (_) {} return false; }
    }

    // ── Dashboard panel ────────────────────────────────────────────────

    // Show/hide the two buttons. Called on load and whenever Settings flips.
    function refresh() {
        var el = byId('idsDashboardPanel');
        if (el) el.classList.toggle('hidden', !enabled());
    }

    // ── Shared modal shell ─────────────────────────────────────────────

    function openShell(id, title, sub, inner, wide) {
        closeShell(id);
        var d = doc(); if (!d) return null;
        var wrap = d.createElement('div');
        wrap.id = id;
        wrap.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
        wrap.setAttribute('data-ids', 'modal');
        wrap.onclick = function (e) { if (e.target === wrap) closeShell(id); };
        wrap.innerHTML =
            '<div class="glass-card rounded-xl p-6 w-full ' + (wide ? 'max-w-4xl' : 'max-w-3xl') + ' max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">' +
              '<div class="flex justify-between items-start mb-5">' +
                '<div><h2 class="text-2xl font-bold text-viper-purple">' + esc(title) + '</h2>' +
                (sub ? '<p class="text-sm text-gray-400 mt-1">' + esc(sub) + '</p>' : '') + '</div>' +
                '<button type="button" onclick="IdsDashboard.close(\'' + id + '\')" class="text-gray-400 hover:text-white" title="Close">' +
                  '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>' +
                '</button>' +
              '</div>' +
              '<div data-ids="body">' + inner + '</div>' +
            '</div>';
        d.body.appendChild(wrap);
        return wrap;
    }
    function closeShell(id) { var el = byId(id); if (el && el.parentNode) el.parentNode.removeChild(el); }
    function setBody(id, html) {
        var el = byId(id);
        if (!el) return;
        var body = el.querySelector('[data-ids="body"]');
        if (body) body.innerHTML = html;
    }

    var INPUT = 'px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-sm text-white focus:border-viper-purple outline-none';
    var BTN = 'px-4 py-2 rounded-lg text-sm font-medium bg-viper-purple/20 text-viper-purple border border-viper-purple/40 hover:bg-viper-purple/30 transition';

    // ── Activity Log ───────────────────────────────────────────────────

    function logHtml(list, now) {
        var m = M();
        var kinds = m ? m.ACTIVITY_KINDS : [];
        var groups = { 1: 'Prevention', 2: 'Complaints & referrals', 7: 'Training', 8: 'Technical assists' };
        var opts = '';
        [1, 2, 7, 8].forEach(function (sec) {
            var inSec = kinds.filter(function (k) { return k.section === sec; });
            if (!inSec.length) return;
            opts += '<optgroup label="' + esc(groups[sec]) + '">' + inSec.map(function (k) {
                return '<option value="' + esc(k.value) + '">' + esc(k.label) + '</option>';
            }).join('') + '</optgroup>';
        });

        var sorted = list.slice().sort(function (a, b) {
            return String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        });
        var rows = '', lastMonth = '';
        sorted.forEach(function (a) {
            var info = kindInfo(a.kind);
            var mk = String(a.date || '').slice(0, 7);
            if (mk !== lastMonth) {
                lastMonth = mk;
                var p = /^\d{4}-\d{2}$/.test(mk) && m ? m.monthPeriod(+mk.slice(0, 4), +mk.slice(5, 7)).label : 'No date';
                rows += '<div class="text-xs uppercase tracking-wide text-gray-500 mt-4 mb-1">' + esc(p) + '</div>';
            }
            var bits = [];
            if (info && !info.peopleOnly && a.count && a.count !== 1) bits.push(a.count + '×');
            if (a.people !== undefined && a.people !== null) bits.push(a.people + (a.people === 1 ? ' person' : ' people'));
            rows += '<div class="flex items-start gap-3 p-2 rounded-lg border border-gray-700 bg-viper-dark/30 text-sm" data-ids="activity">' +
                '<span class="text-gray-400 w-24 shrink-0">' + esc(m ? m.fmtDate(a.date) : a.date) + '</span>' +
                '<span class="flex-1 min-w-0"><span class="text-white">' + esc(info ? info.label : a.kind) + '</span>' +
                    (bits.length ? ' <span class="text-viper-purple font-semibold">' + esc(bits.join(' · ')) + '</span>' : '') +
                    (a.notes ? '<span class="block text-xs text-gray-400 mt-0.5 break-words">' + esc(a.notes) + '</span>' : '') +
                '</span>' +
                '<button type="button" class="text-gray-500 hover:text-red-400 text-xs px-1" title="Remove" onclick="IdsDashboard.removeActivity(\'' + esc(a.id) + '\')">✕</button>' +
            '</div>';
        });

        return '' +
        '<div class="p-4 rounded-lg border border-viper-purple/30 bg-viper-purple/5 mb-2">' +
          '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">' +
            '<label class="text-xs text-gray-400">Date<input type="date" id="idsActDate" value="' + esc(todayIso(now)) + '" class="' + INPUT + ' w-full mt-1"></label>' +
            '<label class="text-xs text-gray-400">What happened<select id="idsActKind" onchange="IdsDashboard.kindChanged()" class="' + INPUT + ' w-full mt-1">' + opts + '</select></label>' +
            '<label class="text-xs text-gray-400" id="idsActCountWrap">How many <span class="text-gray-500">(blank = 1)</span><input type="number" min="1" id="idsActCount" class="' + INPUT + ' w-full mt-1" placeholder="1"></label>' +
            '<label class="text-xs text-gray-400" id="idsActPeopleWrap"><span id="idsActPeopleLabel">Number of people</span><input type="number" min="0" id="idsActPeople" class="' + INPUT + ' w-full mt-1"></label>' +
            '<label class="text-xs text-gray-400 md:col-span-2">Note <span class="text-gray-500">(optional — e.g. which school, which course)</span><input type="text" id="idsActNotes" maxlength="' + NOTES_MAX + '" class="' + INPUT + ' w-full mt-1"></label>' +
          '</div>' +
          '<div class="flex justify-end mt-3"><button type="button" class="' + BTN + '" onclick="IdsDashboard.addActivity()">Add to log</button></div>' +
        '</div>' +
        '<div data-ids="log">' + (rows || '<p class="text-sm text-gray-500 italic mt-4">Nothing logged yet.</p>') + '</div>';
    }

    function openLog() {
        openShell(LOG_ID, 'ICAC Activity Log',
            'Log prevention, training and assist work as it happens. Case work (arrests, warrants, exams) is counted from the cases themselves.',
            logHtml(loadActivities()));
        kindChanged();
    }

    function kindChanged() {
        var info = kindInfo((byId('idsActKind') || {}).value);
        var cw = byId('idsActCountWrap'), pw = byId('idsActPeopleWrap'), pl = byId('idsActPeopleLabel');
        if (!info || !cw || !pw) return;
        cw.classList.toggle('hidden', !!info.peopleOnly);
        pw.classList.toggle('hidden', !(info.peopleOnly || info.people));
        if (pl) pl.textContent = info.peopleOnly ? 'How many people' : (info.people || 'Number of people') + ' (optional)';
    }

    function addActivity() {
        var r = sanitizeActivity({
            date: (byId('idsActDate') || {}).value,
            kind: (byId('idsActKind') || {}).value,
            count: (byId('idsActCount') || {}).value,
            people: (byId('idsActPeople') || {}).value,
            notes: (byId('idsActNotes') || {}).value
        });
        if (r.error) { toast(r.error, 'warning'); return false; }
        var list = loadActivities().concat([r.activity]);
        if (!saveActivities(list)) { toast('Could not save the activity — nothing was added.', 'error'); return false; }
        var keepKind = r.activity.kind, keepDate = r.activity.date;
        setBody(LOG_ID, logHtml(list));
        var k = byId('idsActKind'); if (k) k.value = keepKind;
        var d = byId('idsActDate'); if (d) d.value = keepDate;
        kindChanged();
        toast('Added to the ICAC Activity Log.', 'success');
        return true;
    }

    function removeActivity(id) {
        var list = loadActivities();
        var next = list.filter(function (a) { return String(a.id) !== String(id); });
        if (next.length === list.length) return false;
        if (root.confirm && !root.confirm('Remove this entry from the ICAC Activity Log?')) return false;
        if (!saveActivities(next)) { toast('Could not save — nothing was removed.', 'error'); return false; }
        setBody(LOG_ID, logHtml(next));
        kindChanged();
        return true;
    }

    // ── Monthly Measures ───────────────────────────────────────────────

    function reportHtml(result) {
        var m = M();
        if (!result) return '<p class="text-red-400">The IDS calculator did not load.</p>';
        var p = result.period;
        var monthVal = p.key;
        var head =
            '<div class="flex flex-wrap items-end gap-3 mb-4">' +
              '<label class="text-xs text-gray-400">Reporting month<input type="month" id="idsReportMonth" value="' + esc(monthVal) + '" onchange="IdsDashboard.setMonth(this.value)" class="' + INPUT + ' block mt-1"></label>' +
              '<span class="text-sm text-gray-400 pb-2">' + esc(result.icacCases.length) + ' ICAC case' + (result.icacCases.length === 1 ? '' : 's') + ' on file</span>' +
              '<button type="button" class="' + BTN + ' ml-auto" onclick="IdsDashboard.downloadPdf()" data-ids="pdf">Download PDF</button>' +
            '</div>';

        var warn = result.warnings.length
            ? '<div class="p-3 mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm text-amber-300">' +
                result.warnings.map(function (w) { return '<div>⚠ ' + esc(w) + '</div>'; }).join('') + '</div>'
            : '';

        var secs = result.sections.map(function (s) {
            var rows = s.rows.map(function (r) {
                var det = r.detail.length
                    ? '<details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300">What makes this up (' + r.detail.length + ')</summary>' +
                        '<div class="mt-1 space-y-0.5">' + r.detail.map(function (d) {
                            return '<div class="text-xs text-gray-400">' + (d.caseNumber ? '<span class="text-gray-300 font-mono">' + esc(d.caseNumber) + '</span> · ' : '') + esc(d.text) + '</div>';
                        }).join('') + '</div></details>'
                    : '';
                return '<div class="flex items-start gap-3 py-1.5 border-b border-gray-700/50" data-ids="row" data-key="' + esc(r.key) + '">' +
                    '<div class="flex-1 min-w-0 text-sm ' + (r.count ? 'text-gray-200' : 'text-gray-500') + '">' + esc(r.label) + det + '</div>' +
                    '<div class="w-16 text-right text-lg font-bold ' + (r.count ? 'text-viper-purple' : 'text-gray-600') + '">' + esc(r.count) + '</div>' +
                '</div>';
            }).join('');
            return '<div class="mb-5"><h3 class="text-sm font-bold uppercase tracking-wide text-viper-cyan mb-1">' + esc(s.title) + '</h3>' + rows + '</div>';
        }).join('');

        var nc = result.notCounted.length
            ? '<div class="mt-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">' +
                '<h3 class="text-sm font-bold text-amber-300 mb-1">Not counted — needs a look (' + result.notCounted.length + ')</h3>' +
                '<p class="text-xs text-gray-400 mb-2">These records exist but are missing something IDS needs. Fix them in the case and this report updates.</p>' +
                result.notCounted.map(function (n) {
                    return '<div class="text-xs text-gray-300 py-0.5">' + (n.caseNumber ? '<span class="font-mono text-gray-200">' + esc(n.caseNumber) + '</span> · ' : '') +
                        esc(n.text) + ' <span class="text-amber-400">— ' + esc(n.reason) + '</span></div>';
                }).join('') + '</div>'
            : '';

        return head + warn +
            '<p class="text-xs text-gray-500 mb-4">Counted from your case records and the ICAC Activity Log. Check each figure before entering it in IDS.</p>' +
            secs + nc;
    }

    function openMeasures() {
        var m = M();
        _period = m ? m.lastFullMonth() : null;
        _result = _period ? buildFor(_period) : null;
        openShell(REPORT_ID, 'IDS Monthly Measures', _period ? _period.label : '', reportHtml(_result), true);
    }

    function setMonth(value) {
        var m = M();
        var mm = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
        if (!m || !mm) return;
        _period = m.monthPeriod(+mm[1], +mm[2]);
        _result = buildFor(_period);
        setBody(REPORT_ID, reportHtml(_result));
        var el = byId(REPORT_ID);
        var sub = el && el.querySelector('p.text-sm.text-gray-400');
        if (sub) sub.textContent = _period.label;
    }

    function officerMeta(getItem) {
        var get = getItem || defaultGet;
        var ui = J(get, 'viperUserInfo', {}) || {};
        var prof = J(get, 'viperAgencyProfile', {}) || {};
        return {
            officer: get('viper_customer_name') || ui.officerName || prof.affiantName || '',
            badge: ui.badgeNumber || prof.affiantBadge || '',
            agency: get('viper_agency') || ui.agencyName || prof.agencyName || ''
        };
    }

    /*
     * jsPDF's built-in Helvetica only draws Latin-1. An em dash, a middot or
     * a curly quote typed into a case record comes out as garbage, so every
     * string bound for the PDF is folded to plain ASCII-ish text first.
     */
    function pdfText(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/[\u2012-\u2015]/g, '-').replace(/[\u00B7\u2022]/g, '-')
            .replace(/\u00D7/g, 'x').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
            .replace(/\u2026/g, '...').replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '');
    }

    function _cleanRows(rows) {
        return (rows || []).map(function (r) { return (r || []).map(pdfText); });
    }

    /*
     * The PDF. `jsPDF` is the constructor (window.jspdf.jsPDF); autoTable
     * must be registered on it. Returns the doc so the caller decides how
     * to save it (and the tests can inspect what was drawn).
     */
    function buildPdf(result, meta, jsPDF, now) {
        meta = meta || {};
        var d = new jsPDF();
        // Fold every string to what Helvetica can draw, at the one choke point.
        var rawText = d.text.bind(d);
        d.text = function (str, x, yy, opt) {
            return rawText(Array.isArray(str) ? str.map(pdfText) : pdfText(str), x, yy, opt);
        };
        var rawTable = d.autoTable.bind(d);
        d.autoTable = function (o) {
            var c = Object.assign({}, o);
            if (c.head) c.head = _cleanRows(c.head);
            if (c.body) c.body = _cleanRows(c.body);
            return rawTable(c);
        };
        var W = d.internal.pageSize.getWidth();
        var y = 18;
        d.setFont(undefined, 'bold'); d.setFontSize(16); d.setTextColor(20, 20, 20);
        d.text('ICAC Data System (IDS) — Monthly Measures', 14, y);
        y += 8;
        d.setFont(undefined, 'normal'); d.setFontSize(11);
        d.text('Reporting month: ' + result.period.label, 14, y); y += 6;
        d.setFontSize(9); d.setTextColor(90, 90, 90);
        if (meta.agency) { d.text('Agency: ' + meta.agency, 14, y); y += 5; }
        if (meta.officer) { d.text('Prepared by: ' + meta.officer + (meta.badge ? ' (Badge #' + meta.badge + ')' : ''), 14, y); y += 5; }
        d.text('Generated ' + new Date(now || Date.now()).toLocaleString() + ' by V.I.P.E.R. from ' + result.icacCases.length + ' ICAC case record(s) and the ICAC Activity Log.', 14, y); y += 5;
        d.text('Check each figure before entering it in IDS. The appendix lists what makes up every number.', 14, y); y += 6;

        var head = { fillColor: [88, 28, 135], textColor: 255, fontStyle: 'bold' };
        result.sections.forEach(function (s) {
            d.autoTable({
                startY: y,
                head: [[s.title, 'Count']],
                body: s.rows.map(function (r) { return [r.label, String(r.count)]; }),
                theme: 'grid',
                headStyles: head,
                styles: { fontSize: 9, cellPadding: 1.8 },
                columnStyles: { 1: { halign: 'right', cellWidth: 24, fontStyle: 'bold' } },
                margin: { left: 14, right: 14 }
            });
            y = d.lastAutoTable.finalY + 4;
        });

        if (result.warnings.length) {
            d.autoTable({
                startY: y, head: [['Warnings']], body: result.warnings.map(function (w) { return [w]; }),
                theme: 'grid', headStyles: { fillColor: [180, 120, 0], textColor: 255 }, styles: { fontSize: 8 },
                margin: { left: 14, right: 14 }
            });
            y = d.lastAutoTable.finalY + 4;
        }

        // Appendix — on its own page.
        d.addPage();
        d.setFont(undefined, 'bold'); d.setFontSize(13); d.setTextColor(20, 20, 20);
        d.text('Appendix — what makes up each number', 14, 18);
        var body = [];
        result.sections.forEach(function (s) {
            s.rows.forEach(function (r) {
                r.detail.forEach(function (x) { body.push([r.label, x.caseNumber || '-', x.text]); });
            });
        });
        d.autoTable({
            startY: 24,
            head: [['Measure', 'Case', 'Detail']],
            body: body.length ? body : [['Nothing was counted this month.', '', '']],
            theme: 'grid', headStyles: head, styles: { fontSize: 8, cellPadding: 1.5 },
            columnStyles: { 0: { cellWidth: 62 }, 1: { cellWidth: 30 } },
            margin: { left: 14, right: 14 }
        });
        y = d.lastAutoTable.finalY + 6;

        if (result.notCounted.length) {
            d.autoTable({
                startY: y,
                head: [['Not counted - case', 'Record', 'Why']],
                body: result.notCounted.map(function (n) { return [n.caseNumber || '-', n.text, n.reason]; }),
                theme: 'grid', headStyles: { fillColor: [180, 120, 0], textColor: 255 }, styles: { fontSize: 8, cellPadding: 1.5 },
                columnStyles: { 0: { cellWidth: 30 } },
                margin: { left: 14, right: 14 }
            });
        }

        // Page footer.
        var n = d.getNumberOfPages();
        for (var i = 1; i <= n; i++) {
            d.setPage(i);
            d.setFontSize(7); d.setTextColor(140, 140, 140);
            d.text('IDS Monthly Measures · ' + result.period.label + ' · page ' + i + ' of ' + n, W / 2, d.internal.pageSize.getHeight() - 8, { align: 'center' });
        }
        return d;
    }

    function pdfFileName(result) { return 'IDS_Measures_' + result.period.key + '.pdf'; }

    function downloadPdf() {
        if (!_result) { toast('Nothing to export yet.', 'warning'); return false; }
        var ctor = root.jspdf && root.jspdf.jsPDF;
        if (!ctor) { toast('The PDF library did not load.', 'error'); return false; }
        try {
            var d = buildPdf(_result, officerMeta(), ctor);
            d.save(pdfFileName(_result));
            return true;
        } catch (e) {
            try { console.error('[IDS] PDF failed', e); } catch (_) {}
            toast('Could not build the PDF: ' + ((e && e.message) || e), 'error');
            return false;
        }
    }

    // Settings lives on another page; pick up the switch when it changes.
    try {
        if (root && root.addEventListener) {
            root.addEventListener('storage', function (e) { if (e && e.key === 'viperIdsEnabled') refresh(); });
        }
    } catch (_) {}

    // Show the dashboard buttons on first paint if the switch is on. A no-op
    // on any page without #idsDashboardPanel.
    try {
        var _d0 = doc();
        if (_d0 && _d0.addEventListener) {
            if (_d0.readyState === 'loading') _d0.addEventListener('DOMContentLoaded', refresh);
            else refresh();
        }
    } catch (_) {}

    return {
        ACT_KEY: ACT_KEY,
        enabled: enabled,
        loadCases: loadCases,
        gatherStore: gatherStore,
        loadActivities: loadActivities,
        buildFor: buildFor,
        sanitizeActivity: sanitizeActivity,
        officerMeta: officerMeta,
        buildPdf: buildPdf,
        pdfFileName: pdfFileName,
        pdfText: pdfText,
        logHtml: logHtml,
        reportHtml: reportHtml,
        refresh: refresh,
        openLog: openLog,
        kindChanged: kindChanged,
        addActivity: addActivity,
        removeActivity: removeActivity,
        openMeasures: openMeasures,
        setMonth: setMonth,
        downloadPdf: downloadPdf,
        close: closeShell
    };
}));
