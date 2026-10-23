/*
 * Case Status Report — the dashboard button and the three-step wizard.
 *
 * Shown only while Settings → Case Status Report is on
 * (localStorage['viperCaseStatusReportEnabled'] === 'true').
 *
 *   1. Setup    — outstanding cases only (open longer than the threshold) or
 *                 every open case; the reporting period; dark or light PDF.
 *   2. Updates  — one entry per case: the investigator's update, next steps,
 *                 blockers and a target date, plus an overall statement.
 *                 Next steps / blockers / target carry over from the last
 *                 report. Typing autosaves to
 *                 localStorage['viperCaseStatusReportDraft'], so closing the
 *                 window mid-way loses nothing.
 *   3. Generate — CaseStatusReportRender.render() → save-html-as-pdf with
 *                 full-bleed pages. A saved report is added to the history
 *                 (viperCaseStatusReports) — that is what "since your last
 *                 report" and the trend chart read next time.
 *
 * The counting is all CaseStatusReportBuild.build(); the drawing is all
 * CaseStatusReportRender.render(). This file only collects input. Pure
 * helpers (initialUpdates, finalUpdates, progress, fileName) are exported
 * for the Node tests.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CaseStatusReport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var ENABLED_KEY = 'viperCaseStatusReportEnabled';
    var DRAFT_KEY = 'viperCaseStatusReportDraft';
    var MODAL_ID = 'csrWizardModal';
    var LOGO_PATH = 'modules/case-status-report/csr-logo.png';

    // wizard state
    var S = null;

    function B() {
        var m = root && root.CaseStatusReportBuild;
        if (!m && typeof require === 'function') { try { m = require('./csr-build.js'); } catch (_) { m = null; } }
        return m;
    }
    function R() {
        var m = root && root.CaseStatusReportRender;
        if (!m && typeof require === 'function') { try { m = require('./csr-render.js'); } catch (_) { m = null; } }
        return m;
    }
    function ls() { try { return root && root.localStorage; } catch (_) { return null; } }
    // Raw text — notes/evidence may hold photo refs VpCaseBlobs would load.
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
    function isoDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function us(isoStr) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoStr || ''));
        return m ? m[2] + '/' + m[3] + '/' + m[1] : '';
    }
    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

    function enabled(getItem) { return (getItem || defaultGet)(ENABLED_KEY) === 'true'; }

    function refresh() {
        var el = byId('csrDashboardPanel');
        if (el) el.classList.toggle('hidden', !enabled());
    }

    // ── pure helpers (tested) ───────────────────────────────────────────

    /**
     * Starting text for every case in the model. A saved draft wins; else
     * next steps / blockers carry over from the last report, and the target
     * date too while it is still ahead. The update itself starts blank —
     * the activity summary shows as the placeholder and is used if it is
     * left blank (finalUpdates).
     */
    function initialUpdates(model, draft, now) {
        draft = obj(draft);
        var dc = obj(draft.cases);
        var today = isoDay(now ? new Date(now) : new Date());
        var out = { cases: {}, statement: typeof draft.statement === 'string' ? draft.statement : '' };
        (model && model.cases || []).forEach(function (c) {
            var d = dc[c.caseNumber];
            if (d && typeof d === 'object') {
                out.cases[c.caseNumber] = {
                    update: String(d.update || ''), nextSteps: String(d.nextSteps || ''),
                    blockers: Array.isArray(d.blockers) ? d.blockers.slice() : [],
                    targetDate: String(d.targetDate || '')
                };
                return;
            }
            var p = c.previous || {};
            out.cases[c.caseNumber] = {
                update: '',
                nextSteps: String(p.nextSteps || ''),
                blockers: Array.isArray(p.blockers) ? p.blockers.slice() : [],
                targetDate: p.targetDate && p.targetDate >= today ? String(p.targetDate) : ''
            };
        });
        return out;
    }

    /** Updates as they go into the PDF: blanks optionally filled from the activity summary. */
    function finalUpdates(model, updates, useSummary) {
        var src = obj(obj(updates).cases);
        var out = { cases: {}, statement: String(obj(updates).statement || '').trim() };
        (model && model.cases || []).forEach(function (c) {
            var u = obj(src[c.caseNumber]);
            var text = String(u.update || '').trim();
            if (!text && useSummary && c.draft) text = c.draft;
            out.cases[c.caseNumber] = {
                update: text, nextSteps: String(u.nextSteps || '').trim(),
                blockers: Array.isArray(u.blockers) ? u.blockers.slice() : [],
                targetDate: String(u.targetDate || '')
            };
        });
        return out;
    }

    /** How many cases have a written update. */
    function progress(model, updates) {
        var src = obj(obj(updates).cases);
        var cases = (model && model.cases) || [];
        var done = cases.filter(function (c) { return String(obj(src[c.caseNumber]).update || '').trim(); }).length;
        return { done: done, total: cases.length };
    }

    function fileName(model, now) {
        var who = String((model && model.identity && model.identity.name) || '').trim()
            .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        var d = isoDay(now ? new Date(now) : new Date());
        return 'Case_Status_Report_' + (who ? who + '_' : '') + d + '.pdf';
    }

    // ── draft persistence ───────────────────────────────────────────────

    function loadDraft() { return obj(J(defaultGet, DRAFT_KEY, {})); }
    var _saveTimer = null;
    function saveDraftSoon() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(saveDraftNow, 400);
    }
    function saveDraftNow() {
        _saveTimer = null;
        if (!S || !S.updates) return;
        var s = ls(); if (!s) return;
        // Merge so cases outside this run (e.g. outstanding-only) keep their text.
        var prev = loadDraft();
        var cases = obj(prev.cases);
        Object.keys(S.updates.cases).forEach(function (k) { cases[k] = S.updates.cases[k]; });
        try { s.setItem(DRAFT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), cases: cases, statement: S.updates.statement || '' })); }
        catch (e) { try { console.warn('[CSR] draft not saved', e); } catch (_) {} }
    }
    function clearDraft() { var s = ls(); if (s) try { s.removeItem(DRAFT_KEY); } catch (_) {} }

    // ── modal shell (same look as the IDS windows) ──────────────────────

    var INPUT = 'px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-sm text-white focus:border-viper-purple outline-none';
    var BTN = 'px-4 py-2 rounded-lg text-sm font-medium bg-viper-purple/20 text-viper-purple border border-viper-purple/40 hover:bg-viper-purple/30 transition';
    var BTN_GHOST = 'px-4 py-2 rounded-lg text-sm font-medium text-gray-300 border border-gray-600 hover:bg-gray-700/50 transition';
    var BTN_GO = 'px-5 py-2 rounded-lg text-sm font-semibold bg-viper-cyan/20 text-viper-cyan border border-viper-cyan/50 hover:bg-viper-cyan/30 transition';

    function openShell(sub, inner, wide) {
        closeShell();
        var d = doc(); if (!d) return null;
        var wrap = d.createElement('div');
        wrap.id = MODAL_ID;
        wrap.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
        wrap.onclick = function (e) { if (e.target === wrap) close(); };
        wrap.innerHTML =
            '<div data-csr="card" class="glass-card rounded-xl p-6 w-full ' + (wide ? 'max-w-6xl' : 'max-w-3xl') + ' max-h-[92vh] overflow-y-auto" onclick="event.stopPropagation()">' +
              '<div class="flex justify-between items-start mb-5">' +
                '<div><h2 class="text-2xl font-bold text-viper-purple">Case Status Report</h2>' +
                '<p data-csr="sub" class="text-sm text-gray-400 mt-1">' + esc(sub) + '</p></div>' +
                '<div class="flex items-center gap-4">' + stepper(S ? S.step : 1) +
                '<button type="button" onclick="CaseStatusReport.close()" class="text-gray-400 hover:text-white" title="Close">' +
                  '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>' +
                '</button></div>' +
              '</div>' +
              '<div data-csr="body">' + inner + '</div>' +
            '</div>';
        d.body.appendChild(wrap);
        wrap.addEventListener('input', onField);
        wrap.addEventListener('change', onField);
        return wrap;
    }
    function closeShell() { var el = byId(MODAL_ID); if (el && el.parentNode) el.parentNode.removeChild(el); }
    function close() {
        if (S && S.busy) return; // the PDF is being written; the result screen follows
        if (S && S.updates) saveDraftNow();
        closeShell();
        S = null;
    }

    function stepper(step) {
        var names = ['Setup', 'Updates', 'Generate'];
        return '<div class="hidden md:flex items-center gap-2 text-xs">' + names.map(function (n, i) {
            var k = i + 1, on = k === step, done = k < step;
            return '<span class="flex items-center gap-1.5 ' + (on ? 'text-viper-cyan' : done ? 'text-viper-green' : 'text-gray-500') + '">' +
                '<span class="w-5 h-5 rounded-full flex items-center justify-center border ' +
                (on ? 'border-viper-cyan bg-viper-cyan/15' : done ? 'border-viper-green bg-viper-green/15' : 'border-gray-600') + '">' + (done ? '✓' : k) + '</span>' + n + '</span>' +
                (k < 3 ? '<span class="w-4 h-px bg-gray-600"></span>' : '');
        }).join('') + '</div>';
    }

    // ── step 1: setup ──────────────────────────────────────────────────

    function buildModel(scope) {
        var b = B();
        return b.build({
            getItem: defaultGet,
            opts: { scope: scope, thresholdDays: S.threshold, periodStart: S.periodStart, periodEnd: S.periodEnd, includeAssist: S.includeAssist }
        });
    }

    function open() {
        var b = B(), r = R();
        if (!b || !r) { toast('The Case Status Report files did not load.', 'error'); return; }
        var dp = b.defaultPeriod(defaultGet);
        var hist = b.loadHistory(defaultGet);
        S = {
            step: 1, scope: 'overdue', threshold: b.thresholdFrom(defaultGet),
            periodStart: dp.start, periodEnd: dp.end,
            theme: 'dark', includeNotes: true, includeAssist: false, useSummary: true,
            last: hist[0] || null, model: null, updates: null, sel: -1
        };
        showSetup();
    }

    function setupHtml() {
        var all = buildModel('all');
        var t = all.totals;
        function card(val, title, desc, count) {
            var on = S.scope === val;
            return '<label class="flex-1 cursor-pointer p-4 rounded-xl border transition ' +
                (on ? 'border-viper-cyan/60 bg-viper-cyan/10' : 'border-gray-700 bg-viper-dark/30 hover:border-gray-500') + '">' +
                '<input type="radio" name="csrScope" value="' + val + '" data-csr-opt="scope" class="hidden"' + (on ? ' checked' : '') + '>' +
                '<div class="flex items-baseline justify-between gap-3"><span class="font-semibold text-white">' + esc(title) + '</span>' +
                '<span class="text-3xl font-bold ' + (on ? 'text-viper-cyan' : 'text-gray-400') + '">' + count + '</span></div>' +
                '<p class="text-xs text-gray-400 mt-1">' + esc(desc) + '</p></label>';
        }
        var nLast = (S.last && S.last.caseNumbers || []).length;
        var last = S.last
            ? 'Last report: <span class="text-gray-200">' + esc(us(String(S.last.generatedAt).slice(0, 10))) + '</span>' +
              (nLast ? ' · ' + nLast + ' case' + (nLast === 1 ? '' : 's') : '') + '. The period starts the day after it.'
            : 'No earlier report on file — the period defaults to the last 30 days.';
        return '' +
        '<div class="flex flex-col md:flex-row gap-3">' +
            card('overdue', 'Outstanding cases', 'Open longer than ' + S.threshold + ' days since assignment (change the threshold in Settings).', t.overThreshold) +
            card('all', 'All open cases', 'Every open case, with on-track and due-soon cases flagged.', t.openCases) +
        '</div>' +
        (t.openCases === 0 ? '<p class="text-sm text-viper-orange mt-3">You have no open cases. The report will say so.</p>' : '') +
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">' +
            '<div class="p-4 rounded-xl border border-gray-700 bg-viper-dark/30">' +
                '<p class="text-xs uppercase tracking-wider text-gray-500 mb-2">Reporting period</p>' +
                '<div class="flex items-center gap-2">' +
                    '<input type="date" data-csr-opt="periodStart" value="' + esc(S.periodStart) + '" class="' + INPUT + ' flex-1">' +
                    '<span class="text-gray-500">to</span>' +
                    '<input type="date" data-csr-opt="periodEnd" value="' + esc(S.periodEnd) + '" class="' + INPUT + ' flex-1">' +
                '</div>' +
                '<p class="text-xs text-gray-400 mt-2">Activity between these dates is what each case page reports. ' + last + '</p>' +
            '</div>' +
            '<div class="p-4 rounded-xl border border-gray-700 bg-viper-dark/30">' +
                '<p class="text-xs uppercase tracking-wider text-gray-500 mb-2">Look</p>' +
                '<div class="flex gap-2">' +
                    themeBtn('dark', 'Dark — VIPER') + themeBtn('light', 'Light — print friendly') +
                '</div>' +
                '<div class="mt-3 space-y-2 text-sm text-gray-300">' +
                    check('includeNotes', 'Include recent case note excerpts', 'Off shows the activity log instead — use when notes are sensitive.') +
                    check('useSummary', 'Fill blank updates with VIPER\'s activity summary', 'e.g. "Since 09/24: 2 notes added, 1 warrant return received."') +
                    check('includeAssist', 'Include cases where I am assisting', 'Off matches the dashboard counts.') +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="flex justify-end gap-2 mt-6">' +
            '<button type="button" class="' + BTN_GHOST + '" onclick="CaseStatusReport.close()">Cancel</button>' +
            '<button type="button" class="' + BTN_GO + '" onclick="CaseStatusReport.toUpdates()">Next: status updates →</button>' +
        '</div>';
    }
    function themeBtn(v, label) {
        var on = S.theme === v;
        return '<button type="button" onclick="CaseStatusReport.setTheme(\'' + v + '\')" class="flex-1 px-3 py-2 rounded-lg text-sm border transition ' +
            (on ? 'border-viper-purple bg-viper-purple/20 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-400') + '">' +
            '<span class="inline-block w-5 h-3.5 rounded mr-2 align-middle" style="background:' + (v === 'dark' ? 'linear-gradient(135deg,#0a0e14 50%,#00d9ff 50%)' : 'linear-gradient(135deg,#f8fafc 50%,#0284c7 50%)') + ';box-shadow:0 0 0 1px rgba(148,163,184,.5)"></span>' + esc(label) + '</button>';
    }
    function check(key, label, hint) {
        return '<label class="flex items-start gap-2 cursor-pointer"><input type="checkbox" data-csr-opt="' + key + '" class="mt-1 accent-purple-500"' + (S[key] ? ' checked' : '') + '>' +
            '<span>' + esc(label) + '<span class="block text-xs text-gray-500">' + esc(hint) + '</span></span></label>';
    }

    function showSetup() {
        S.step = 1;
        openShell('Your open cases, what changed since the last report, and where each one stands.', setupHtml(), false);
    }
    function rerenderSetup() {
        var el = byId(MODAL_ID); if (!el) return;
        var body = el.querySelector('[data-csr="body"]');
        if (body) body.innerHTML = setupHtml();
    }
    function setTheme(v) { if (!S) return; S.theme = v === 'light' ? 'light' : 'dark'; rerenderSetup(); }

    // ── step 2: updates ────────────────────────────────────────────────

    function toUpdates() {
        if (!S) return;
        S.model = buildModel(S.scope);
        var fresh = initialUpdates(S.model, loadDraft());
        // Keep anything already typed in this session (Back → Next).
        if (S.updates) {
            Object.keys(fresh.cases).forEach(function (k) { if (S.updates.cases[k]) fresh.cases[k] = S.updates.cases[k]; });
            fresh.statement = S.updates.statement;
        }
        S.updates = fresh;
        S.step = 2;
        if (S.sel >= S.model.cases.length) S.sel = -1;
        if (!S.model.cases.length) S.sel = -1;
        else if (S.sel === -1 && !S.updates.statement) S.sel = 0;
        openShell(subFor2(), updatesHtml(), true);
    }
    function subFor2() {
        var n = S.model.cases.length;
        return n ? 'Write where each case stands. VIPER fills in the numbers — ' + n + ' case' + (n === 1 ? '' : 's') + ', period ' + S.model.period.label + '.'
                 : 'No cases match. You can still add a statement and generate the report.';
    }

    function tierDot(c) { return '<span class="inline-block w-2.5 h-2.5 rounded-full shrink-0" style="background:' + esc(c.tier.color) + '"></span>'; }
    function ageText(c) { return c.overdue ? '+' + c.daysOverdue + 'd over' : (c.daysLeft >= 0 ? c.daysLeft + 'd left' : c.ageDays + 'd'); }

    function listHtml() {
        var items = '<button type="button" data-csr-item="-1" onclick="CaseStatusReport.select(-1)" class="w-full text-left px-3 py-2 rounded-lg border transition ' +
            (S.sel === -1 ? 'border-viper-purple/60 bg-viper-purple/15' : 'border-transparent hover:bg-gray-700/40') + '">' +
            '<div class="flex items-center gap-2"><span class="text-viper-purple">✎</span><span class="text-sm font-medium text-white flex-1">Overall statement</span>' +
            '<span data-csr-mark="-1" class="text-viper-green text-xs">' + (String(S.updates.statement || '').trim() ? '✓' : '') + '</span></div>' +
            '<div class="text-xs text-gray-500 ml-5">Optional summary for your supervisor</div></button>';
        S.model.cases.forEach(function (c, i) {
            var on = S.sel === i;
            var has = String((S.updates.cases[c.caseNumber] || {}).update || '').trim();
            items += '<button type="button" data-csr-item="' + i + '" onclick="CaseStatusReport.select(' + i + ')" class="w-full text-left px-3 py-2 rounded-lg border transition ' +
                (on ? 'border-viper-cyan/60 bg-viper-cyan/10' : 'border-transparent hover:bg-gray-700/40') + '">' +
                '<div class="flex items-center gap-2">' + tierDot(c) +
                '<span class="text-sm font-semibold text-viper-cyan font-mono flex-1 truncate">' + esc(c.caseNumber) + '</span>' +
                '<span class="text-xs ' + (c.overdue ? 'text-red-400' : 'text-gray-400') + '">' + esc(ageText(c)) + '</span>' +
                '<span data-csr-mark="' + i + '" class="text-viper-green text-xs w-3 text-right">' + (has ? '✓' : '') + '</span></div>' +
                '<div class="text-xs text-gray-400 ml-[18px] truncate">' + esc(c.offense) + '</div></button>';
        });
        return items;
    }

    function progressHtml() {
        var p = progress(S.model, S.updates);
        var pct = p.total ? Math.round(100 * p.done / p.total) : 0;
        return '<div class="flex items-center gap-3"><div class="flex-1 h-1.5 rounded-full bg-gray-700 overflow-hidden"><div class="h-full bg-viper-green" style="width:' + pct + '%"></div></div>' +
            '<span class="text-xs text-gray-400 whitespace-nowrap">' + p.done + ' of ' + p.total + ' written</span></div>';
    }

    function statPill(label, val, cls) {
        return '<div class="px-3 py-2 rounded-lg bg-viper-dark/50 border border-gray-700 min-w-0"><div class="text-[10px] uppercase tracking-wider text-gray-500">' + esc(label) + '</div>' +
            '<div class="text-sm font-semibold ' + (cls || 'text-white') + ' truncate">' + val + '</div></div>';
    }

    function editorHtml() {
        if (S.sel === -1) {
            return '<div><h3 class="text-lg font-semibold text-white">Overall statement</h3>' +
                '<p class="text-xs text-gray-400 mb-3">Appears on the closing page above your certification. Caseload context, staffing, anything your supervisor should know.</p>' +
                '<textarea data-csr-f="statement" rows="12" maxlength="6000" class="' + INPUT + ' w-full leading-relaxed" placeholder="e.g. Three of the oldest cases are waiting on provider returns; I expect two to close after the DA meeting on 11/04.">' + esc(S.updates.statement || '') + '</textarea>' +
                navHtml() + '</div>';
        }
        var c = S.model.cases[S.sel];
        var u = S.updates.cases[c.caseNumber];
        var b = B();
        var la = c.lastActivity;
        var blk = b.BLOCKERS.map(function (x) {
            var on = u.blockers.indexOf(x.id) !== -1;
            return '<label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs cursor-pointer transition ' +
                (on ? 'border-viper-orange/60 bg-viper-orange/15 text-viper-orange' : 'border-gray-600 text-gray-400 hover:border-gray-400') + '">' +
                '<input type="checkbox" data-csr-blocker="' + esc(x.id) + '" class="hidden"' + (on ? ' checked' : '') + '>' + esc(x.label) + '</label>';
        }).join('');
        var prev = c.previous && c.previous.update
            ? '<div class="p-3 rounded-lg border border-gray-700 bg-viper-dark/30 text-xs text-gray-400 mt-2">' +
              '<div class="flex justify-between items-center mb-1"><span class="uppercase tracking-wider text-gray-500">Last report · ' + esc(us(String(c.previous.generatedAt).slice(0, 10))) + '</span>' +
              '<button type="button" class="text-viper-purple hover:underline" onclick="CaseStatusReport.useText(\'previous\')">Copy</button></div>' +
              '<div class="whitespace-pre-wrap max-h-24 overflow-y-auto">' + esc(c.previous.update) + '</div></div>'
            : '';
        return '' +
        '<div class="flex flex-wrap items-start justify-between gap-2">' +
            '<div class="min-w-0"><div class="flex items-center gap-2">' + tierDot(c) +
                '<h3 class="text-xl font-bold text-viper-cyan font-mono">' + esc(c.caseNumber) + '</h3>' +
                '<span class="text-xs px-2 py-0.5 rounded-full border" style="color:' + esc(c.tier.color) + ';border-color:' + esc(c.tier.color) + '66">' + esc(c.tier.label) + '</span></div>' +
                '<p class="text-sm text-gray-300 truncate">' + esc(c.offense) + ' · ' + esc(c.status.label) + '</p></div>' +
            '<span class="text-xs text-gray-500">Case ' + (S.sel + 1) + ' of ' + S.model.cases.length + '</span>' +
        '</div>' +
        '<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">' +
            statPill('Assigned', esc(us(c.assignedDate)) + (c.assignedEstimated ? ' <span class="text-gray-500 font-normal">(est.)</span>' : '')) +
            statPill('Age', c.ageDays + ' days', c.overdue ? 'text-red-400' : 'text-white') +
            statPill('This period', c.period.total + ' action' + (c.period.total === 1 ? '' : 's'), c.period.total ? 'text-viper-green' : 'text-viper-orange') +
            statPill('Last activity', la ? (la.daysAgo === 0 ? 'Today' : la.daysAgo + 'd ago') : 'None', la && la.daysAgo <= 30 ? 'text-white' : 'text-viper-orange') +
        '</div>' +
        '<div class="mt-4">' +
            '<div class="flex justify-between items-end mb-1"><label class="text-xs uppercase tracking-wider text-gray-400">Status update</label>' +
            '<button type="button" class="text-xs text-viper-purple hover:underline" onclick="CaseStatusReport.useText(\'summary\')">Insert activity summary</button></div>' +
            '<textarea data-csr-f="update" rows="6" maxlength="4000" class="' + INPUT + ' w-full leading-relaxed" placeholder="' + esc(c.draft) + '">' + esc(u.update) + '</textarea>' +
            (S.useSummary ? '<p class="text-[11px] text-gray-500 mt-1">Left blank, the placeholder text above is used.</p>' : '') +
            prev +
        '</div>' +
        '<div class="grid grid-cols-1 md:grid-cols-[1fr_170px] gap-3 mt-3">' +
            '<div><label class="text-xs uppercase tracking-wider text-gray-400">Next steps</label>' +
            '<textarea data-csr-f="nextSteps" rows="2" maxlength="2000" class="' + INPUT + ' w-full mt-1" placeholder="What happens next on this case">' + esc(u.nextSteps) + '</textarea></div>' +
            '<div><label class="text-xs uppercase tracking-wider text-gray-400">Target resolution</label>' +
            '<input type="date" data-csr-f="targetDate" value="' + esc(u.targetDate) + '" class="' + INPUT + ' w-full mt-1"></div>' +
        '</div>' +
        '<div class="mt-3"><label class="text-xs uppercase tracking-wider text-gray-400">Blockers</label>' +
            '<div data-csr="blockers" class="flex flex-wrap gap-1.5 mt-1.5">' + blk + '</div></div>' +
        navHtml();
    }

    function navHtml() {
        var n = S.model.cases.length;
        var prevDis = S.sel <= -1, nextDis = S.sel >= n - 1;
        return '<div class="flex justify-between mt-5 pt-4 border-t border-gray-700">' +
            '<button type="button" class="' + BTN_GHOST + (prevDis ? ' opacity-40 pointer-events-none' : '') + '" onclick="CaseStatusReport.select(' + (S.sel - 1) + ')">← Previous</button>' +
            '<button type="button" class="' + BTN + (nextDis ? ' opacity-40 pointer-events-none' : '') + '" onclick="CaseStatusReport.select(' + (S.sel + 1) + ')">Next case →</button>' +
            '</div>';
    }

    function updatesHtml() {
        return '' +
        '<div class="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-5">' +
            '<div class="flex flex-col min-h-0">' +
                '<div data-csr="progress" class="mb-2">' + progressHtml() + '</div>' +
                '<div data-csr="list" class="space-y-1 overflow-y-auto pr-1" style="max-height:56vh">' + listHtml() + '</div>' +
            '</div>' +
            '<div data-csr="editor" class="min-w-0 p-5 rounded-xl border border-gray-700 bg-viper-dark/20">' + editorHtml() + '</div>' +
        '</div>' +
        '<div class="flex flex-wrap items-center justify-between gap-2 mt-5">' +
            '<span class="text-xs text-gray-500">Saved as you type — you can close this and come back.</span>' +
            '<div class="flex gap-2">' +
                '<button type="button" class="' + BTN_GHOST + '" onclick="CaseStatusReport.back()">← Back</button>' +
                '<button type="button" class="' + BTN_GO + '" onclick="CaseStatusReport.generate()">Generate PDF</button>' +
            '</div>' +
        '</div>';
    }

    function part(name) { var el = byId(MODAL_ID); return el ? el.querySelector('[data-csr="' + name + '"]') : null; }

    function select(i) {
        if (!S || S.step !== 2) return;
        var n = S.model.cases.length;
        if (i < -1 || i >= n) return;
        S.sel = i;
        var ed = part('editor'); if (ed) ed.innerHTML = editorHtml();
        var list = part('list');
        if (list) {
            var top = list.scrollTop;
            list.innerHTML = listHtml();
            list.scrollTop = top;
            var item = list.querySelector('[data-csr-item="' + i + '"]');
            if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
        }
        var ta = ed && ed.querySelector('textarea');
        if (ta) try { ta.focus(); } catch (_) {}
    }

    function useText(which) {
        if (!S || S.sel < 0) return;
        var c = S.model.cases[S.sel];
        var u = S.updates.cases[c.caseNumber];
        var text = which === 'previous' ? (c.previous && c.previous.update) || '' : c.draft || '';
        u.update = u.update && u.update.trim() ? u.update.replace(/\s+$/, '') + '\n\n' + text : text;
        var ed = part('editor'); if (ed) ed.innerHTML = editorHtml();
        markChanged();
    }

    function markChanged() {
        var mark = byId(MODAL_ID) && byId(MODAL_ID).querySelector('[data-csr-mark="' + S.sel + '"]');
        if (mark) {
            var has = S.sel === -1 ? String(S.updates.statement || '').trim()
                : String((S.updates.cases[S.model.cases[S.sel].caseNumber] || {}).update || '').trim();
            mark.textContent = has ? '✓' : '';
        }
        var pg = part('progress'); if (pg) pg.innerHTML = progressHtml();
        saveDraftSoon();
    }

    // One delegated listener for every field in the window.
    function onField(e) {
        if (!S) return;
        var t = e.target; if (!t || !t.getAttribute) return;
        var opt = t.getAttribute('data-csr-opt');
        if (opt) {
            if (e.type !== 'change') return;
            if (opt === 'scope') { if (t.checked) { S.scope = t.value === 'all' ? 'all' : 'overdue'; rerenderSetup(); } return; }
            if (opt === 'periodStart' || opt === 'periodEnd') {
                if (/^\d{4}-\d{2}-\d{2}$/.test(t.value)) S[opt] = t.value;
                return;
            }
            S[opt] = !!t.checked;
            if (opt === 'includeAssist') rerenderSetup();
            return;
        }
        if (S.step !== 2) return;
        var f = t.getAttribute('data-csr-f');
        if (f === 'statement') { S.updates.statement = t.value; markChanged(); return; }
        if (S.sel < 0) return;
        var u = S.updates.cases[S.model.cases[S.sel].caseNumber];
        if (f === 'update' || f === 'nextSteps' || f === 'targetDate') { u[f] = t.value; markChanged(); return; }
        var bid = t.getAttribute('data-csr-blocker');
        if (bid && e.type === 'change') {
            var at = u.blockers.indexOf(bid);
            if (t.checked && at === -1) u.blockers.push(bid);
            if (!t.checked && at !== -1) u.blockers.splice(at, 1);
            var lab = t.parentNode;
            if (lab && lab.classList) {
                ['border-viper-orange/60', 'bg-viper-orange/15', 'text-viper-orange'].forEach(function (k) { lab.classList.toggle(k, t.checked); });
                ['border-gray-600', 'text-gray-400', 'hover:border-gray-400'].forEach(function (k) { lab.classList.toggle(k, !t.checked); });
            }
            markChanged();
        }
    }

    function back() {
        if (!S) return;
        saveDraftNow();
        showSetup();
    }

    // ── step 3: generate ───────────────────────────────────────────────

    function busyHtml(n) {
        return '<div class="py-16 flex flex-col items-center text-center">' +
            '<div class="w-12 h-12 rounded-full border-4 border-viper-cyan/20 border-t-viper-cyan animate-spin"></div>' +
            '<p class="text-white font-semibold mt-5">Building your report…</p>' +
            '<p class="text-sm text-gray-400 mt-1">' + n + ' case page' + (n === 1 ? '' : 's') + '. Choose where to save it when asked.</p></div>';
    }

    function doneHtml(res, model) {
        var p = String(res.path || '');
        var mb = res.bytesOut ? (res.bytesOut / 1048576).toFixed(1) + ' MB' : '';
        return '<div class="py-10 flex flex-col items-center text-center">' +
            '<div class="w-14 h-14 rounded-full bg-viper-green/15 border border-viper-green/50 flex items-center justify-center text-viper-green text-2xl">✓</div>' +
            '<p class="text-white text-lg font-semibold mt-4">Report saved</p>' +
            '<p class="text-sm text-gray-400 mt-1">' + model.cases.length + ' case' + (model.cases.length === 1 ? '' : 's') + ' · ' + esc(model.period.label) + (mb ? ' · ' + mb : '') + '</p>' +
            '<p class="text-xs text-gray-500 mt-2 break-all max-w-xl">' + esc(p) + '</p>' +
            '<p class="text-xs text-gray-500 mt-4 max-w-md">Your updates are saved with this report. Next time, the period starts the day after today and next steps carry over.</p>' +
            '<div class="flex gap-2 mt-6">' +
                (p ? '<button type="button" class="' + BTN_GO + '" onclick="CaseStatusReport.openSaved()">Open PDF</button>' +
                     '<button type="button" class="' + BTN + '" onclick="CaseStatusReport.showSaved()">Show in folder</button>' : '') +
                '<button type="button" class="' + BTN_GHOST + '" onclick="CaseStatusReport.close()">Close</button>' +
            '</div></div>';
    }

    function readBadge() {
        var api = root && root.electronAPI;
        if (!api || typeof api.readDeptBadge !== 'function') return Promise.resolve('');
        return Promise.resolve(api.readDeptBadge()).then(function (r) {
            return r && r.success && r.found && r.dataUrl ? r.dataUrl : '';
        }, function () { return ''; });
    }

    function logoUrl() {
        try { return new URL(LOGO_PATH, root.location.href).href; } catch (_) { return LOGO_PATH; }
    }
    // Embed the logo so the PDF's HTML needs nothing from the local server
    // (the app is served from http://localhost; the print window loads a
    // temp file). Falls back to the URL if fetch is unavailable.
    function logoData() {
        var url = logoUrl();
        if (typeof root.fetch !== 'function' || typeof root.FileReader !== 'function') return Promise.resolve(url);
        return root.fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(function (blob) {
            return new Promise(function (resolve) {
                var fr = new root.FileReader();
                fr.onload = function () { resolve(String(fr.result || url)); };
                fr.onerror = function () { resolve(url); };
                fr.readAsDataURL(blob);
            });
        }).catch(function () { return url; });
    }

    function generate() {
        if (!S || !S.model || S.busy) return;
        var api = root && root.electronAPI;
        if (!api || typeof api.saveHtmlAsPdf !== 'function') { toast('PDF export is only available in the desktop app.', 'error'); return; }
        saveDraftNow();
        var model = S.model;
        var updates = finalUpdates(model, S.updates, S.useSummary);
        S.busy = true;
        S.step = 3;
        openShell('Rendering ' + model.cases.length + ' case pages.', busyHtml(model.cases.length), false);
        Promise.all([readBadge(), logoData()]).then(function (imgs) {
            var html = R().render(model, updates, { theme: S.theme, includeNotes: S.includeNotes, logoUrl: imgs[1], badgeUrl: imgs[0] });
            return api.saveHtmlAsPdf({ html: html, defaultFileName: fileName(model), options: { marginType: 'none', settleMs: 600 } });
        }).then(function (res) {
            if (!S) return;
            S.busy = false;
            if (res && res.success) {
                var saved = B().saveHistory(B().historyEntry(model, updates), ls());
                if (!saved.ok) toast('Report saved, but it could not be added to your report history: ' + saved.error, 'warning');
                clearDraft();
                S.updates = null; // nothing left to autosave
                S.savedPath = res.path || '';
                openShell('Done.', doneHtml(res, model), false);
                toast('Case Status Report saved.', 'success');
                return;
            }
            S.step = 2;
            if (res && res.canceled) { openShell(subFor2(), updatesHtml(), true); return; }
            toast('Could not create the PDF: ' + ((res && res.error) || 'unknown error'), 'error');
            openShell(subFor2(), updatesHtml(), true);
        }).catch(function (e) {
            if (!S) return;
            S.busy = false; S.step = 2;
            try { console.error('[CSR] generate failed', e); } catch (_) {}
            toast('Could not create the PDF: ' + ((e && e.message) || e), 'error');
            openShell(subFor2(), updatesHtml(), true);
        });
    }

    function openSaved() {
        var api = root && root.electronAPI;
        if (S && S.savedPath && api && api.openFile) api.openFile(S.savedPath);
    }
    function showSaved() {
        var api = root && root.electronAPI;
        if (S && S.savedPath && api && api.showItemInFolder) api.showItemInFolder(S.savedPath);
    }

    // Settings lives on another page; pick up the switch when it changes.
    try {
        if (root && root.addEventListener) {
            root.addEventListener('storage', function (e) { if (e && e.key === ENABLED_KEY) refresh(); });
        }
    } catch (_) {}
    try {
        var _d0 = doc();
        if (_d0 && _d0.addEventListener) {
            if (_d0.readyState === 'loading') _d0.addEventListener('DOMContentLoaded', refresh);
            else refresh();
        }
    } catch (_) {}

    return {
        ENABLED_KEY: ENABLED_KEY,
        DRAFT_KEY: DRAFT_KEY,
        enabled: enabled,
        refresh: refresh,
        open: open,
        close: close,
        setTheme: setTheme,
        toUpdates: toUpdates,
        select: select,
        useText: useText,
        back: back,
        generate: generate,
        openSaved: openSaved,
        showSaved: showSaved,
        initialUpdates: initialUpdates,
        finalUpdates: finalUpdates,
        progress: progress,
        fileName: fileName
    };
}));
