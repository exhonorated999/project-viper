/*
 * modules/case-status-report/csr-build.js
 *
 * Case Status Report — the numbers.
 *
 * Turns what VIPER already stores (cases, notes, evidence, warrants, tasks,
 * suspects, field work, the case report) into one model that the renderer
 * draws and the wizard edits. No DOM. Every read goes through an injected
 * getItem so the tests drive it in Node with a fake localStorage.
 *
 * WHAT "OPEN" MEANS
 *   The same rule the dashboard's Open Cases tile uses (index.html
 *   updateDashboardCaseData): a case is open unless its status is one of
 *   closed / closed-arrest / transferred / inactive, or a custom status whose
 *   category is anything other than 'active'. An unknown status (including
 *   the legacy 'Open') stays open — hiding a case from a status report is the
 *   worse failure.
 *
 * ASSIGNMENT DATE
 *   case.dateAssigned ('YYYY-MM-DD') when set. Otherwise createdAt, and the
 *   case is flagged so the report can say the date is estimated rather than
 *   state a wrong due date as fact.
 *
 * DUE / OVERDUE
 *   due = assigned + thresholdDays. Overdue when today is past due. Dates are
 *   handled as LOCAL calendar days ('YYYY-MM-DD' + 'T00:00:00'), the same
 *   reasoning as modules/warrant-status.js — bare ISO dates parse as UTC and
 *   would shift a day for everyone west of Greenwich.
 *
 * ASSISTS
 *   Excluded by default, the same as every dashboard stat (another
 *   detective's case is not on this officer's caseload). opts.includeAssist
 *   puts them back.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CaseStatusReportBuild = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DAY = 86400000;
    var HISTORY_KEY = 'viperCaseStatusReports';
    var HISTORY_MAX = 24;
    var DEFAULT_THRESHOLD = 30;
    var THRESHOLD_CHOICES = [30, 45, 60, 90];

    var BUILTIN_STATUS = {
        'active':        { label: 'Active',             color: '#10b981' },
        'closed':        { label: 'Closed',             color: '#60a5fa' },
        'closed-arrest': { label: 'Closed with Arrest', color: '#60a5fa' },
        'transferred':   { label: 'Transferred',        color: '#a78bfa' },
        'inactive':      { label: 'Inactive',           color: '#facc15' }
    };
    var BUILTIN_TERMINAL = ['closed', 'closed-arrest', 'transferred', 'inactive'];
    var BUILTIN_CLOSURE = ['closed', 'closed-arrest'];
    var CUSTOM_CLOSURE_CATS = ['closed', 'cleared-arrest', 'exceptionally-cleared', 'other'];

    var TIERS = [
        { key: 'ontrack',  label: 'On track',          color: '#10b981' },
        { key: 'duesoon',  label: 'Due within 7 days', color: '#facc15' },
        { key: 'overdue',  label: 'Overdue 1–30 days', color: '#fb923c' },
        { key: 'serious',  label: 'Overdue 31–90 days', color: '#f43f5e' },
        { key: 'critical', label: 'Overdue 90+ days',  color: '#e11d74' }
    ];
    var AGE_BUCKETS = [
        { label: '0–30',    min: 0,   max: 30 },
        { label: '31–60',   min: 31,  max: 60 },
        { label: '61–90',   min: 61,  max: 90 },
        { label: '91–180',  min: 91,  max: 180 },
        { label: '181–365', min: 181, max: 365 },
        { label: '365+',    min: 366, max: Infinity }
    ];
    var BLOCKERS = [
        { id: 'warrant',  label: 'Awaiting warrant return' },
        { id: 'lab',      label: 'Awaiting lab / forensics' },
        { id: 'da',       label: 'Awaiting DA review' },
        { id: 'victim',   label: 'Victim / witness unavailable' },
        { id: 'suspect',  label: 'Suspect outstanding' },
        { id: 'agency',   label: 'Awaiting outside agency' },
        { id: 'workload', label: 'Workload / priority cases' }
    ];
    var PRIORITY_LABELS = ['', 'Low', 'Medium', 'High'];
    var OFFENSE_COLORS = ['#22d3ee', '#a855f7', '#10b981', '#fb923c', '#f472b6', '#facc15', '#64748b'];

    // ── small helpers ────────────────────────────────────────────────────

    function J(getItem, key, fb) {
        try {
            var raw = getItem(key);
            if (raw === null || raw === undefined || raw === '') return fb;
            var v = JSON.parse(raw);
            return (v === null || v === undefined) ? fb : v;
        } catch (_) { return fb; }
    }
    function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; }
    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    function pad(n) { return (n < 10 ? '0' : '') + n; }

    /** Any stored date → Date (local midnight for bare YYYY-MM-DD), or null. */
    function parseDate(v) {
        if (v === null || v === undefined || v === '') return null;
        if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getTime());
        if (typeof v === 'number') { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn; }
        var s = String(v).trim();
        var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }
    function midnight(d) { var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; }
    function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    /** Whole calendar days from a to b (b later → positive). Rounded for DST. */
    function dayDiff(a, b) { return Math.round((midnight(b) - midnight(a)) / DAY); }
    function addDays(d, n) { var x = midnight(d); x.setDate(x.getDate() + n); return x; }
    function usDate(isoStr) {
        var d = parseDate(isoStr); if (!d) return '';
        return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
    }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
    function stripHtml(s) {
        return String(s || '')
            .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ').trim();
    }
    function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

    function median(nums) {
        if (!nums.length) return 0;
        var s = nums.slice().sort(function (a, b) { return a - b; });
        var m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    }

    // ── status ───────────────────────────────────────────────────────────

    function statusResolver(customStatuses) {
        var custom = {};
        arr(customStatuses).forEach(function (s) { if (s.id) custom[s.id] = s; });
        function info(id) {
            if (BUILTIN_STATUS[id]) return { id: id, label: BUILTIN_STATUS[id].label, color: BUILTIN_STATUS[id].color };
            if (custom[id]) return { id: id, label: custom[id].label || id, color: custom[id].color || '#9ca3af' };
            var fb = String(id || '').replace(/-/g, ' ').replace(/\b\w/g, function (l) { return l.toUpperCase(); }) || 'Unknown';
            return { id: id || '', label: fb, color: '#9ca3af' };
        }
        function isOpen(id) {
            if (BUILTIN_TERMINAL.indexOf(id) !== -1) return false;
            if (custom[id]) return (custom[id].category || 'other') === 'active';
            return true;
        }
        function isClosure(id) {
            if (BUILTIN_CLOSURE.indexOf(id) !== -1) return true;
            return !!(custom[id] && CUSTOM_CLOSURE_CATS.indexOf(custom[id].category) !== -1);
        }
        return { info: info, isOpen: isOpen, isClosure: isClosure };
    }

    function tierFor(overdueDays, daysLeft) {
        if (overdueDays > 90) return TIERS[4];
        if (overdueDays > 30) return TIERS[3];
        if (overdueDays > 0) return TIERS[2];
        if (daysLeft <= 7) return TIERS[1];
        return TIERS[0];
    }

    // ── per-case inputs ──────────────────────────────────────────────────

    /** Everything one case's activity is made of, read from where each module keeps it. */
    function gatherCase(c, shared, getItem) {
        var num = c.caseNumber;
        var tasks = shared.tasks.filter(function (t) {
            return t.caseId !== null && t.caseId !== undefined &&
                (String(t.caseId) === String(num) || String(t.caseId) === String(c.id));
        });
        var report = obj(shared.reports[num]);
        return {
            notes: arr(shared.notes[num]),
            evidence: arr(shared.evidence[num]),
            warrants: arr(shared.warrants[num]),
            tasks: tasks,
            suspects: arr(J(getItem, 'suspects_' + c.id, [])),
            fieldWork: arr(J(getItem, 'fieldwork_' + c.id, [])),
            reportSaved: report.lastSaved || null
        };
    }

    function warrantLabel(w) {
        var who = String(w.issuedTo || w.provider || w.company || '').trim();
        var type = String(w.type || '').trim();
        if (who && type) return who + ' (' + type + ')';
        return who || type || 'Warrant';
    }
    function noteTitle(n) {
        var t = typeof n.title === 'string' ? n.title.trim() : '';
        return t || clip(stripHtml(n.contentHtml || n.content || n.text || ''), 60) || 'Case note';
    }
    function suspectName(s) {
        var n = String(s.name || [s.firstName, s.lastName].filter(Boolean).join(' ') || '').trim();
        return n || 'Suspect';
    }

    /** Flat event list: [{at: Date, kind, label}] — everything the investigator did. */
    function eventsFor(c, g) {
        var ev = [];
        function push(v, kind, label) { var d = parseDate(v); if (d) ev.push({ at: d, kind: kind, label: label }); }
        g.notes.forEach(function (n) {
            push(n.createdAt, 'note', 'Note: ' + noteTitle(n));
            (Array.isArray(n.editHistory) ? n.editHistory : []).forEach(function (e) {
                push(typeof e === 'object' && e ? (e.at || e.date || e.editedAt) : e, 'noteEdit', 'Note edited: ' + noteTitle(n));
            });
        });
        g.evidence.forEach(function (e) {
            push(e.createdAt || e.dateCollected || e.date, 'evidence', 'Evidence: ' + (String(e.title || e.name || e.type || 'item').trim()));
        });
        g.warrants.forEach(function (w) {
            var lbl = warrantLabel(w);
            push(w.createdAt || w.dateIssued || w.issuedDate, 'warrant', 'Warrant issued: ' + lbl);
            if (w.returnReceived) push(w.returnReceivedAt || w.returnReceivedDate, 'return', 'Return received: ' + lbl);
            if (w.closedOut) push(w.closedOutAt || w.closedOutDate, 'closeout', 'Closed out: ' + lbl);
        });
        g.tasks.forEach(function (t) {
            push(t.createdAt, 'taskAdded', 'Task added: ' + String(t.title || 'task'));
            if (t.completed) push(t.completedAt, 'task', 'Task completed: ' + String(t.title || 'task'));
        });
        g.suspects.forEach(function (s) {
            push(s.createdAt, 'suspect', 'Suspect added: ' + suspectName(s));
            if (s.arrested) push(s.arrestDate || s.dateArrested, 'arrest', 'Arrest: ' + suspectName(s));
        });
        g.fieldWork.forEach(function (f) {
            push(f.occurredAt || f.timestamp, 'field', 'Field work: ' + String(f.presetLabel || 'entry'));
        });
        if (g.reportSaved) push(g.reportSaved, 'report', 'Case report updated');
        ev.sort(function (a, b) { return b.at - a.at; });
        return ev;
    }

    var PERIOD_KEYS = {
        note: 'notes', noteEdit: 'noteEdits', evidence: 'evidence', warrant: 'warrantsIssued',
        return: 'warrantReturns', closeout: 'warrantReturns', task: 'tasksCompleted', taskAdded: 'tasksAdded',
        suspect: 'suspectsAdded', arrest: 'arrests', field: 'fieldWork', report: 'reportUpdates'
    };
    function emptyPeriod() {
        return { notes: 0, noteEdits: 0, evidence: 0, warrantsIssued: 0, warrantReturns: 0, tasksCompleted: 0,
                 tasksAdded: 0, suspectsAdded: 0, arrests: 0, fieldWork: 0, reportUpdates: 0, total: 0 };
    }

    /** "Since 09/23/2026: 2 notes added, 1 warrant return (Google) …" */
    function draftFor(p, feed, sinceIso, lastActivity) {
        var bits = [];
        if (p.notes) bits.push(plural(p.notes, 'note') + ' added');
        if (p.noteEdits) bits.push(plural(p.noteEdits, 'note edit'));
        if (p.evidence) bits.push(plural(p.evidence, 'evidence item') + ' logged');
        if (p.warrantsIssued) bits.push(plural(p.warrantsIssued, 'warrant') + ' issued');
        if (p.warrantReturns) {
            var who = feed.filter(function (e) { return e.kind === 'return' || e.kind === 'closeout'; })
                .map(function (e) { return e.label.replace(/^(Return received|Closed out): /, '').replace(/ \(.*\)$/, ''); });
            bits.push(plural(p.warrantReturns, 'warrant return') + ' received' + (who.length ? ' (' + who.slice(0, 3).join(', ') + ')' : ''));
        }
        if (p.tasksCompleted) bits.push(plural(p.tasksCompleted, 'task') + ' completed');
        if (p.fieldWork) bits.push(plural(p.fieldWork, 'field work entry', 'field work entries'));
        if (p.suspectsAdded) bits.push(plural(p.suspectsAdded, 'suspect') + ' identified');
        if (p.arrests) bits.push(plural(p.arrests, 'arrest') + ' made');
        if (p.reportUpdates) bits.push('case report updated');
        var since = usDate(sinceIso);
        if (!bits.length) {
            return 'No activity recorded in VIPER since ' + since + '.' +
                (lastActivity ? ' Last activity ' + usDate(iso(parseDate(lastActivity.date))) + ' (' + plural(lastActivity.daysAgo, 'day') + ' ago).' : '');
        }
        var s = 'Since ' + since + ': ' + bits.join(', ') + '.';
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function weekBuckets(events, now, weeks) {
        var out = [];
        var end = addDays(now, 1);                  // exclusive, tomorrow 00:00
        for (var i = weeks - 1; i >= 0; i--) {
            var hi = addDays(end, -7 * i), lo = addDays(hi, -7);
            out.push({ weekStart: iso(lo), count: 0, _lo: lo, _hi: hi });
        }
        events.forEach(function (e) {
            if (e.kind === 'taskAdded') return;
            for (var k = 0; k < out.length; k++) if (e.at >= out[k]._lo && e.at < out[k]._hi) { out[k].count++; break; }
        });
        return out.map(function (b) { return { weekStart: b.weekStart, count: b.count }; });
    }

    // ── history ──────────────────────────────────────────────────────────

    function loadHistory(getItem) {
        return arr(J(getItem, HISTORY_KEY, [])).sort(function (a, b) {
            return String(b.generatedAt || '').localeCompare(String(a.generatedAt || ''));
        });
    }
    function previousUpdate(history, caseNumber) {
        for (var i = 0; i < history.length; i++) {
            var u = obj(history[i].caseUpdates)[caseNumber];
            if (u && (u.update || u.nextSteps || (u.blockers && u.blockers.length) || u.targetDate)) {
                return { update: u.update || '', nextSteps: u.nextSteps || '', blockers: Array.isArray(u.blockers) ? u.blockers.slice() : [],
                         targetDate: u.targetDate || '', generatedAt: history[i].generatedAt || '' };
            }
        }
        return null;
    }

    /** Default reporting period: day after the last report → today, else the last 30 days. */
    function defaultPeriod(getItem, now) {
        var today = midnight(now ? new Date(now) : new Date());
        var hist = loadHistory(getItem || function () { return null; });
        var last = hist.length ? parseDate(hist[0].generatedAt) : null;
        var start = last && last < today ? addDays(last, 1) : addDays(today, -29);
        if (last && dayDiff(last, today) === 0) start = addDays(today, -29);
        return { start: iso(start), end: iso(today) };
    }

    function thresholdFrom(getItem) {
        var n = parseInt((getItem && getItem('viperCsrThresholdDays')) || '', 10);
        return THRESHOLD_CHOICES.indexOf(n) !== -1 ? n : DEFAULT_THRESHOLD;
    }

    function identityFrom(getItem) {
        var ui = obj(J(getItem, 'viperUserInfo', {}));
        var ap = obj(J(getItem, 'viperAgencyProfile', {}));
        return {
            name: String(getItem('viper_customer_name') || ui.officerName || ui.name || ap.affiantName || '').trim(),
            rank: String(ap.affiantRank || ui.rank || '').trim(),
            badge: String(ui.badgeNumber || getItem('viper_badge') || ap.affiantBadge || '').trim(),
            agency: String(getItem('viper_agency') || ui.agencyName || ap.agencyName || '').trim()
        };
    }

    // ── build ────────────────────────────────────────────────────────────

    /**
     * opts: { scope: 'overdue'|'all', thresholdDays, periodStart, periodEnd, includeAssist }
     */
    function build(input) {
        input = input || {};
        var getItem = input.getItem || function () { return null; };
        var now = input.now ? new Date(input.now) : new Date();
        var today = midnight(now);
        var o = input.opts || {};
        var threshold = parseInt(o.thresholdDays, 10) > 0 ? parseInt(o.thresholdDays, 10) : thresholdFrom(getItem);
        var scope = o.scope === 'all' ? 'all' : 'overdue';
        var dp = defaultPeriod(getItem, now);
        var pStart = parseDate(o.periodStart) || parseDate(dp.start);
        var pEnd = parseDate(o.periodEnd) || today;
        if (pEnd < pStart) { var tmp = pStart; pStart = pEnd; pEnd = tmp; }
        pStart = midnight(pStart);
        var pEndExcl = addDays(pEnd, 1);
        function inPeriod(d) { return d && d >= pStart && d < pEndExcl; }

        var S = statusResolver(J(getItem, 'viperCustomStatuses', []));
        var allCases = arr(J(getItem, 'viperCases', []));
        var mine = allCases.filter(function (c) { return o.includeAssist || c.caseRole !== 'assist'; });
        var shared = {
            notes: obj(J(getItem, 'viperCaseNotes', {})),
            evidence: obj(J(getItem, 'viperCaseEvidence', {})),
            warrants: obj(J(getItem, 'viperCaseWarrants', {})),
            reports: obj(J(getItem, 'viperCaseReports', {})),
            tasks: arr(J(getItem, 'viperTasks', []))
        };
        var history = loadHistory(getItem);
        var WS = (typeof globalThis !== 'undefined' && globalThis.WarrantStatus) || null;
        if (!WS && typeof require === 'function') { try { WS = require('../warrant-status.js'); } catch (_) { WS = null; } }

        // Totals across ALL of the officer's cases (not just the report's).
        var closedThisPeriod = 0, arrestsThisPeriod = 0;
        mine.forEach(function (c) {
            if (!S.isOpen(c.status) && S.isClosure(c.status)) {
                var cd = parseDate(c.dateClosed ? String(c.dateClosed).slice(0, 10) : (c.closedAt || c.lastModified));
                if (inPeriod(cd)) closedThisPeriod++;
            }
            arr(J(getItem, 'suspects_' + c.id, [])).forEach(function (s) {
                if (s.arrested && inPeriod(parseDate(s.arrestDate || s.dateArrested))) arrestsThisPeriod++;
            });
        });

        var open = mine.filter(function (c) { return S.isOpen(c.status) && c.caseNumber; });
        var models = open.map(function (c) {
            var assignedRaw = parseDate(c.dateAssigned);
            var estimated = !assignedRaw;
            var assigned = midnight(assignedRaw || parseDate(c.createdAt) || today);
            var due = addDays(assigned, threshold);
            var age = Math.max(0, dayDiff(assigned, today));
            var delta = dayDiff(today, due);                 // + days left, − overdue
            var overdueDays = delta < 0 ? -delta : 0;
            var daysLeft = delta >= 0 ? delta : 0;

            var g = gatherCase(c, shared, getItem);
            var events = eventsFor(c, g).filter(function (e) { return e.at < addDays(today, 2); });
            var lastEv = events.filter(function (e) { return e.kind !== 'taskAdded'; })[0] || null;
            var lm = parseDate(c.lastModified);
            var lastActivity = null;
            if (lastEv) lastActivity = { date: lastEv.at, label: lastEv.label };
            if (lm && (!lastActivity || lm > lastActivity.date)) lastActivity = { date: lm, label: 'Case record updated' };
            var la = lastActivity ? { date: lastActivity.date.toISOString(), label: lastActivity.label,
                                      daysAgo: Math.max(0, dayDiff(lastActivity.date, today)) } : null;

            var p = emptyPeriod();
            var feed = [];
            events.forEach(function (e) {
                if (!inPeriod(e.at)) return;
                var k = PERIOD_KEYS[e.kind]; if (k) p[k]++;
                if (e.kind !== 'taskAdded') { p.total++; feed.push(e); }
            });

            // Warrants
            var wl = g.warrants.map(function (w) {
                var isOpenW = WS ? WS.isOpen(w) : !(w.returnReceived || w.closedOut);
                var od = WS ? WS.daysOverdue(w, today) : 0;
                var statusLabel = w.returnReceived ? 'Returned' : (w.closedOut ? 'Closed out' : (od > 0 ? 'Overdue ' + od + 'd' : 'Awaiting return'));
                var issued = parseDate(w.createdAt || w.dateIssued);
                return { label: warrantLabel(w), type: String(w.type || ''), issuedTo: String(w.issuedTo || ''),
                         ref: String(w.referenceNumber || ''), issued: issued ? iso(issued) : '',
                         dueDate: w.dueDate ? String(w.dueDate).slice(0, 10) : '', open: isOpenW,
                         overdue: od > 0, daysOverdue: od, statusLabel: statusLabel };
            }).sort(function (a, b) { return (b.open - a.open) || (b.daysOverdue - a.daysOverdue) || String(b.issued).localeCompare(String(a.issued)); });
            var wc = { total: wl.length, open: wl.filter(function (w) { return w.open; }).length,
                       overdue: wl.filter(function (w) { return w.overdue; }).length,
                       returned: wl.filter(function (w) { return !w.open; }).length };

            // Tasks
            var openTasks = g.tasks.filter(function (t) { return !t.completed; }).map(function (t) {
                var d = parseDate(t.date);
                return { title: String(t.title || 'Task'), date: t.date ? String(t.date).slice(0, 10) : '', overdue: !!(d && d < today) };
            }).sort(function (a, b) { return (b.overdue - a.overdue) || String(a.date || '9999').localeCompare(String(b.date || '9999')); });
            var doneTasks = g.tasks.filter(function (t) { return t.completed; }).map(function (t) {
                return { title: String(t.title || 'Task'), completedAt: t.completedAt || '' };
            }).sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });

            // Notes (latest first)
            var notes = g.notes.slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })
                .map(function (n) {
                    var d = parseDate(n.createdAt);
                    return { title: noteTitle(n), date: d ? iso(d) : '', excerpt: clip(stripHtml(n.contentHtml || n.content || n.text || ''), 260) };
                });

            // Milestones for the lifecycle strip
            var ms = [{ date: iso(assigned), label: estimated ? 'Opened' : 'Assigned', kind: 'assigned' }];
            function firstOf(kind) {
                var hit = null; events.forEach(function (e) { if (e.kind === kind && (!hit || e.at < hit.at)) hit = e; }); return hit;
            }
            var fw = firstOf('warrant'); if (fw) ms.push({ date: iso(fw.at), label: 'First warrant', kind: 'warrant' });
            var fr = firstOf('return'); if (fr) ms.push({ date: iso(fr.at), label: 'First return', kind: 'return' });
            var fs = firstOf('suspect'); if (fs) ms.push({ date: iso(fs.at), label: 'Suspect identified', kind: 'suspect' });
            var fa = firstOf('arrest'); if (fa) ms.push({ date: iso(fa.at), label: 'Arrest', kind: 'arrest' });
            if (g.reportSaved && parseDate(g.reportSaved)) ms.push({ date: iso(parseDate(g.reportSaved)), label: 'Report updated', kind: 'report' });
            ms.push({ date: iso(due), label: 'Due', kind: 'due' });
            ms.push({ date: iso(today), label: 'Today', kind: 'today' });
            ms.sort(function (a, b) { return a.date.localeCompare(b.date) || (a.kind === 'today' ? 1 : 0) - (b.kind === 'today' ? 1 : 0); });

            var susp = { total: g.suspects.length, arrested: g.suspects.filter(function (s) { return s.arrested; }).length };
            susp.outstanding = susp.total - susp.arrested;

            var pr = parseInt(c.priority, 10) || 0;
            var sinceIso = iso(pStart);
            return {
                id: c.id,
                caseNumber: String(c.caseNumber),
                offense: String(c.primaryOffense || c.offenseType || c.category || 'Offense not specified').trim(),
                offenseType: String(c.offenseType || '').trim(),
                category: String(c.category || '').trim(),
                synopsis: clip(stripHtml(c.synopsis || ''), 420),
                status: S.info(c.status),
                priority: pr, priorityLabel: PRIORITY_LABELS[pr] || '',
                icac: c.icac === true, assist: c.caseRole === 'assist',
                assignedDate: iso(assigned), assignedEstimated: estimated,
                dueDate: iso(due), ageDays: age, overdue: overdueDays > 0, daysOverdue: overdueDays, daysLeft: daysLeft,
                tier: tierFor(overdueDays, daysLeft),
                lastActivity: la,
                period: p,
                weekly: weekBuckets(events, today, 12).map(function (b) { return b.count; }),
                milestones: ms,
                warrants: wl, warrantCounts: wc,
                tasks: { open: openTasks, completed: doneTasks, openCount: openTasks.length,
                         overdueCount: openTasks.filter(function (t) { return t.overdue; }).length,
                         completedCount: doneTasks.length, completedInPeriod: p.tasksCompleted },
                notes: notes, noteCount: notes.length,
                evidenceCount: g.evidence.length,
                suspects: susp,
                activityFeed: feed.slice(0, 14).map(function (e) { return { date: e.at.toISOString(), kind: e.kind, label: e.label }; }),
                draft: draftFor(p, feed, sinceIso, la),
                previous: previousUpdate(history, String(c.caseNumber)),
                _events: events
            };
        });

        var inReport = models.filter(function (m) { return scope === 'all' || m.overdue; });
        inReport.sort(function (a, b) { return (b.daysOverdue - a.daysOverdue) || (b.ageDays - a.ageDays) || a.caseNumber.localeCompare(b.caseNumber); });

        // ── totals over the report's cases ──
        var ages = inReport.map(function (m) { return m.ageDays; });
        var worked = inReport.filter(function (m) { return m.period.total > 0; }).length;
        var t = {
            openCases: models.length,
            inReport: inReport.length,
            overThreshold: models.filter(function (m) { return m.overdue; }).length,
            dueSoon: models.filter(function (m) { return !m.overdue && m.daysLeft <= 14; }).length,
            avgAgeDays: ages.length ? Math.round(ages.reduce(function (a, b) { return a + b; }, 0) / ages.length) : 0,
            medianAgeDays: median(ages),
            oldest: inReport.length ? inReport.slice().sort(function (a, b) { return b.ageDays - a.ageDays; })
                .map(function (m) { return { caseNumber: m.caseNumber, ageDays: m.ageDays, offense: m.offense }; })[0] : null,
            workedThisPeriod: worked,
            workedPct: inReport.length ? Math.round(100 * worked / inReport.length) : 0,
            idleCount: inReport.length - worked,
            staleCount: inReport.filter(function (m) { return !m.lastActivity || m.lastActivity.daysAgo > 30; }).length,
            closedThisPeriod: closedThisPeriod,
            arrestsThisPeriod: arrestsThisPeriod,
            actionsThisPeriod: inReport.reduce(function (a, m) { return a + m.period.total; }, 0),
            warrantsOutstanding: inReport.reduce(function (a, m) { return a + m.warrantCounts.open; }, 0),
            warrantsOverdue: inReport.reduce(function (a, m) { return a + m.warrantCounts.overdue; }, 0),
            tasksOverdue: inReport.reduce(function (a, m) { return a + m.tasks.overdueCount; }, 0),
            missingAssignDate: inReport.filter(function (m) { return m.assignedEstimated; }).length,
            avgOverdueDays: (function () {
                var od = inReport.filter(function (m) { return m.overdue; }).map(function (m) { return m.daysOverdue; });
                return od.length ? Math.round(od.reduce(function (a, b) { return a + b; }, 0) / od.length) : 0;
            }())
        };

        // ── charts ──
        var statusMap = {};
        inReport.forEach(function (m) {
            var k = m.status.label;
            if (!statusMap[k]) statusMap[k] = { label: k, color: m.status.color, count: 0 };
            statusMap[k].count++;
        });
        var offMap = {};
        inReport.forEach(function (m) { offMap[m.offense] = (offMap[m.offense] || 0) + 1; });
        var offList = Object.keys(offMap).map(function (k) { return { label: k, count: offMap[k] }; })
            .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); });
        if (offList.length > 6) {
            var rest = offList.slice(5).reduce(function (a, x) { return a + x.count; }, 0);
            offList = offList.slice(0, 5).concat([{ label: 'Other', count: rest }]);
        }
        offList.forEach(function (x, i) { x.color = OFFENSE_COLORS[i % OFFENSE_COLORS.length]; });

        var allEvents = [];
        inReport.forEach(function (m) { allEvents = allEvents.concat(m._events); });

        var trend = history.slice(0, 5).reverse().map(function (h) {
            var tt = obj(h.totals);
            var d = parseDate(h.generatedAt);
            return { label: d ? pad(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) : '', overdue: tt.overThreshold || 0, open: tt.openCases || 0 };
        });
        trend.push({ label: 'Now', overdue: t.overThreshold, open: t.openCases, current: true });

        var charts = {
            status: Object.keys(statusMap).map(function (k) { return statusMap[k]; }).sort(function (a, b) { return b.count - a.count; }),
            offense: offList,
            ageBuckets: AGE_BUCKETS.map(function (b) {
                return { label: b.label, count: inReport.filter(function (m) { return m.ageDays >= b.min && m.ageDays <= b.max; }).length };
            }),
            tiers: TIERS.map(function (tr) {
                return { key: tr.key, label: tr.label, color: tr.color, count: inReport.filter(function (m) { return m.tier.key === tr.key; }).length };
            }),
            activityByWeek: weekBuckets(allEvents, today, 12),
            trend: trend
        };

        // ── highlights (plain sentences) ──
        var hl = [];
        if (inReport.length) {
            var od = inReport.filter(function (m) { return m.overdue; });
            if (od.length) {
                var odWorked = od.filter(function (m) { return m.period.total > 0; }).length;
                hl.push(odWorked + ' of ' + od.length + ' overdue cases had recorded activity this period.');
            }
            if (t.oldest) hl.push('Oldest open case: ' + t.oldest.caseNumber + ' (' + t.oldest.offense + '), ' + plural(t.oldest.ageDays, 'day') + ' since assignment.');
            if (t.dueSoon && scope === 'all') hl.push(plural(t.dueSoon, 'case') + ' will cross the ' + threshold + '-day mark within 14 days.');
            if (t.warrantsOutstanding) hl.push(plural(t.warrantsOutstanding, 'warrant') + ' awaiting return' + (t.warrantsOverdue ? ', ' + t.warrantsOverdue + ' past due from the provider' : '') + '.');
            if (t.closedThisPeriod) hl.push(plural(t.closedThisPeriod, 'case') + ' closed during the period.');
            if (t.arrestsThisPeriod) hl.push(plural(t.arrestsThisPeriod, 'arrest') + ' made during the period.');
            if (t.staleCount) hl.push(plural(t.staleCount, 'case') + ' with no recorded activity in over 30 days.');
            if (trend.length > 1) {
                var prev = trend[trend.length - 2];
                var diff = t.overThreshold - prev.overdue;
                if (diff !== 0) hl.push('Cases over ' + threshold + ' days ' + (diff < 0 ? 'down ' + (-diff) : 'up ' + diff) + ' since the last report (' + prev.overdue + ' → ' + t.overThreshold + ').');
            }
            if (t.missingAssignDate) hl.push(plural(t.missingAssignDate, 'case') + ' had no assignment date set; the case creation date was used.');
        }

        inReport.forEach(function (m) { delete m._events; });
        models.forEach(function (m) { delete m._events; });

        var periodDays = dayDiff(pStart, pEnd) + 1;
        return {
            generatedAt: now.toISOString(),
            asOf: iso(today),
            identity: identityFrom(getItem),
            options: { scope: scope, thresholdDays: threshold, includeAssist: !!o.includeAssist },
            period: { start: iso(pStart), end: iso(pEnd), days: periodDays,
                      label: usDate(iso(pStart)) + ' – ' + usDate(iso(pEnd)) },
            totals: t,
            charts: charts,
            highlights: hl.slice(0, 6),
            cases: inReport,
            historyCount: history.length
        };
    }

    // ── saving a finished report ─────────────────────────────────────────

    function sanitizeUpdate(u) {
        u = obj(u);
        var ids = BLOCKERS.map(function (b) { return b.id; });
        return {
            update: String(u.update || '').slice(0, 4000),
            nextSteps: String(u.nextSteps || '').slice(0, 2000),
            blockers: (Array.isArray(u.blockers) ? u.blockers : []).filter(function (b) { return ids.indexOf(b) !== -1; }),
            targetDate: /^\d{4}-\d{2}-\d{2}$/.test(String(u.targetDate || '')) ? String(u.targetDate) : ''
        };
    }

    /** The history entry for a generated report. Small: totals + what the investigator wrote. */
    function historyEntry(model, updates) {
        updates = obj(updates);
        var cu = {};
        var src = obj(updates.cases);
        (model.cases || []).forEach(function (m) {
            var s = sanitizeUpdate(src[m.caseNumber]);
            if (s.update || s.nextSteps || s.blockers.length || s.targetDate) cu[m.caseNumber] = s;
        });
        return {
            id: 'csr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            generatedAt: model.generatedAt,
            period: { start: model.period.start, end: model.period.end },
            scope: model.options.scope,
            thresholdDays: model.options.thresholdDays,
            totals: { openCases: model.totals.openCases, inReport: model.totals.inReport, overThreshold: model.totals.overThreshold,
                      workedPct: model.totals.workedPct, avgAgeDays: model.totals.avgAgeDays },
            caseNumbers: (model.cases || []).map(function (m) { return m.caseNumber; }),
            caseUpdates: cu,
            statement: String(updates.statement || '').slice(0, 6000)
        };
    }

    /** Prepend an entry to the stored history (capped). Returns {ok, error?}. */
    function saveHistory(entry, storage) {
        if (!storage) return { ok: false, error: 'No storage' };
        try {
            var list = loadHistory(function (k) { return storage.getItem(k); });
            list.unshift(entry);
            storage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
            return { ok: true };
        } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    }

    /** Blocker id → count across the updates being reported. */
    function blockerCounts(model, updates) {
        var src = obj(obj(updates).cases);
        return BLOCKERS.map(function (b) {
            var n = 0;
            (model.cases || []).forEach(function (m) {
                var u = src[m.caseNumber];
                if (u && Array.isArray(u.blockers) && u.blockers.indexOf(b.id) !== -1) n++;
            });
            return { id: b.id, label: b.label, count: n };
        });
    }

    return {
        HISTORY_KEY: HISTORY_KEY,
        HISTORY_MAX: HISTORY_MAX,
        DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
        THRESHOLD_CHOICES: THRESHOLD_CHOICES,
        TIERS: TIERS,
        BLOCKERS: BLOCKERS,
        AGE_BUCKETS: AGE_BUCKETS,
        build: build,
        defaultPeriod: defaultPeriod,
        thresholdFrom: thresholdFrom,
        identityFrom: identityFrom,
        loadHistory: loadHistory,
        historyEntry: historyEntry,
        saveHistory: saveHistory,
        sanitizeUpdate: sanitizeUpdate,
        blockerCounts: blockerCounts,
        statusResolver: statusResolver,
        parseDate: parseDate,
        usDate: usDate,
        stripHtml: stripHtml,
        _dayDiff: dayDiff
    };
}));
