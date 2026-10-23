/*
 * Case Status Report — build math, render output, wizard helpers, wiring.
 *   node modules/case-status-report/__tests__/csr.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../csr-build.js');
const R = require('../csr-render.js');
const D = require('../csr-dashboard.js');
const { makeStore } = require('./csr-fixture');

let pass = 0, fail = 0;
function ok(label, cond) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    const good = JSON.stringify(actual) === JSON.stringify(expected);
    if (!good) console.log('  FAIL: ' + label + '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual));
    good ? pass++ : fail++;
}

const NOW = '2026-10-23T15:00:00';
function memStore(data) {
    return {
        data,
        getItem: k => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: k => { delete data[k]; }
    };
}
function smallStore(extra) {
    const cases = [
        { id: 'c1', caseNumber: '26-0001', dateAssigned: '2026-09-01', createdAt: '2026-09-01T08:00:00', lastModified: '2026-09-02T10:00:00', status: 'active', primaryOffense: 'PC 211 Robbery', caseRole: 'primary' },
        { id: 'c2', caseNumber: '26-0002', dateAssigned: '2026-10-20', createdAt: '2026-10-20T08:00:00', lastModified: '2026-10-20T10:00:00', status: 'active', primaryOffense: 'PC 459 Burglary' },
        { id: 'c3', caseNumber: '26-0003', dateAssigned: '2026-09-26', createdAt: '2026-09-26T08:00:00', lastModified: '2026-09-26T10:00:00', status: 'active', primaryOffense: 'PC 459 Burglary' },
        { id: 'c4', caseNumber: '26-0004', dateAssigned: null, createdAt: '2026-05-01T12:00:00', lastModified: '2026-05-01T12:00:00', status: 'active', primaryOffense: 'PC 487 Grand Theft' },
        { id: 'c5', caseNumber: '26-0005', dateAssigned: '2026-01-01', createdAt: '2026-01-01T08:00:00', status: 'active', caseRole: 'assist', primaryOffense: 'PC 211 Robbery' },
        { id: 'c6', caseNumber: '26-0006', dateAssigned: '2026-03-01', createdAt: '2026-03-01T08:00:00', status: 'closed', dateClosed: '2026-10-10', primaryOffense: 'PC 211 Robbery' },
        { id: 'c7', caseNumber: '26-0007', dateAssigned: '2026-08-01', createdAt: '2026-08-01T08:00:00', lastModified: '2026-08-01T10:00:00', status: 'pending-da', primaryOffense: 'PC 422 Criminal Threats' },
        { id: 'c8', caseNumber: '26-0008', dateAssigned: '2026-02-01', createdAt: '2026-02-01T08:00:00', status: 'cleared', dateClosed: '2026-01-01', primaryOffense: 'PC 211 Robbery' }
    ];
    const data = {
        viperCases: JSON.stringify(cases),
        viperCustomStatuses: JSON.stringify([
            { id: 'pending-da', label: 'Pending DA', color: '#f472b6', category: 'active' },
            { id: 'cleared', label: 'Cleared', color: '#60a5fa', category: 'cleared-arrest' }
        ]),
        viperCaseNotes: JSON.stringify({ '26-0001': [
            { id: 'n1', title: 'Victim interview', contentHtml: '<p>Spoke with the victim.</p>', createdAt: '2026-10-10T10:00:00' },
            { id: 'n2', title: 'Old note', contentHtml: '<p>Earlier.</p>', createdAt: '2026-08-01T10:00:00' }
        ] }),
        viperCaseWarrants: JSON.stringify({ '26-0001': [
            { id: 'w1', issuedTo: 'Google', type: 'Search Warrant', createdAt: '2026-09-05T10:00:00', dueDate: '2026-10-05', returnReceived: false }
        ] }),
        viperTasks: JSON.stringify([
            { id: 't1', caseId: '26-0001', title: 'Lab request', completed: true, completedAt: '2026-10-15T10:00:00', createdAt: '2026-10-01T10:00:00' },
            { id: 't2', caseId: '26-0001', title: 'Call DA', completed: false, date: '2026-10-20', createdAt: '2026-10-01T10:00:00' }
        ]),
        viper_customer_name: 'Det. Test Person',
        viper_agency: 'Test PD'
    };
    Object.assign(data, extra || {});
    return memStore(data);
}
function buildSmall(opts, store) {
    store = store || smallStore();
    return B.build({ getItem: store.getItem, now: NOW, opts: opts || {} });
}
const byNum = (m, n) => m.cases.find(c => c.caseNumber === n);

// ── build ──────────────────────────────────────────────────────────────
console.log('[build: which cases]');
{
    const m = buildSmall({ scope: 'overdue' });
    eq(m.cases.map(c => c.caseNumber), ['26-0004', '26-0007', '26-0001'], 'overdue scope: only past-threshold cases, most overdue first');
    eq(m.totals.openCases, 5, 'open = active + custom-active; closed, custom-closure and assists excluded');
    eq(m.totals.overThreshold, 3, 'three cases past 30 days');
    eq(m.totals.inReport, 3, 'inReport matches overdue scope');
    eq(m.totals.dueSoon, 1, 'one case due within 14 days');
    eq(m.options, { scope: 'overdue', thresholdDays: 30, includeAssist: false }, 'options echoed');

    const all = buildSmall({ scope: 'all' });
    eq(all.cases.length, 5, 'all scope: every open case');
    eq(byNum(all, '26-0002').tier.key, 'ontrack', '27 days left → on track');
    eq(byNum(all, '26-0003').tier.key, 'duesoon', '3 days left → due soon');
    eq(byNum(all, '26-0003').daysLeft, 3, 'daysLeft counted in calendar days');

    const withAssist = buildSmall({ scope: 'all', includeAssist: true });
    eq(withAssist.totals.openCases, 6, 'includeAssist adds the assist case');
    ok('assist flagged', byNum(withAssist, '26-0005').assist === true);

    const t60 = buildSmall({ scope: 'overdue', thresholdDays: 60 });
    eq(t60.cases.map(c => c.caseNumber), ['26-0004', '26-0007'], '60-day threshold drops the 52-day case');
    eq(t60.options.thresholdDays, 60, 'threshold option used');
}

console.log('[build: dates and tiers]');
{
    const m = buildSmall({ scope: 'all' });
    const c1 = byNum(m, '26-0001');
    eq([c1.ageDays, c1.dueDate, c1.daysOverdue, c1.tier.key], [52, '2026-10-01', 22, 'overdue'], 'c1 age / due / overdue / tier');
    const c4 = byNum(m, '26-0004');
    eq([c4.assignedEstimated, c4.assignedDate, c4.ageDays, c4.tier.key], [true, '2026-05-01', 175, 'critical'], 'no assignment date → creation date, flagged estimated');
    eq(byNum(m, '26-0007').tier.key, 'serious', '53 days over → serious');
    eq(byNum(m, '26-0007').status.label, 'Pending DA', 'custom status label');
    eq(m.totals.missingAssignDate, 1, 'missing assignment date counted');
}

console.log('[build: period activity]');
{
    const m = buildSmall({ scope: 'all' });
    eq(m.period, { start: '2026-09-24', end: '2026-10-23', days: 30, label: '09/24/2026 – 10/23/2026' }, 'default period: last 30 days with no history');
    const c1 = byNum(m, '26-0001');
    eq(c1.period.notes, 1, 'only the in-period note counts');
    eq(c1.period.tasksCompleted, 1, 'completed task counted');
    eq(c1.period.tasksAdded, 2, 'tasks added tracked');
    eq(c1.period.total, 2, 'tasks added are not "actions"');
    eq(c1.tasks.overdueCount, 1, 'open task past its date is overdue');
    eq(c1.warrantCounts.open, 1, 'unreturned warrant is open');
    ok('draft summarises the period', /^Since 09\/24\/2026: 1 note added, 1 task completed\.$/.test(c1.draft));
    const c3 = byNum(m, '26-0003');
    ok('idle case draft says so', /^No activity recorded in VIPER since 09\/24\/2026\./.test(c3.draft));
    eq(m.totals.closedThisPeriod, 1, 'closed in period counted once (old custom closure excluded)');
    eq(c1.lastActivity.label, 'Task completed: Lab request', 'last activity is the latest event');
    eq(c1.lastActivity.daysAgo, 8, 'last activity days ago');

    const narrow = buildSmall({ scope: 'all', periodStart: '2026-10-12', periodEnd: '2026-10-23' });
    eq(byNum(narrow, '26-0001').period.notes, 0, 'custom period excludes the earlier note');
    eq(byNum(narrow, '26-0001').period.tasksCompleted, 1, 'custom period keeps the later task');
    const swapped = buildSmall({ scope: 'all', periodStart: '2026-10-23', periodEnd: '2026-10-12' });
    eq(swapped.period.start, '2026-10-12', 'reversed dates are swapped');
}

console.log('[build: history]');
{
    const store = smallStore();
    const m = buildSmall({ scope: 'overdue' }, store);
    const updates = { cases: { '26-0001': { update: 'Waiting on Google.', nextSteps: 'Review return.', blockers: ['warrant', 'bogus'], targetDate: '2026-12-01' } }, statement: 'All good.' };
    const entry = B.historyEntry(m, updates);
    eq(entry.caseNumbers, ['26-0004', '26-0007', '26-0001'], 'history keeps the case list');
    eq(Object.keys(entry.caseUpdates), ['26-0001'], 'only cases with something written are stored');
    eq(entry.caseUpdates['26-0001'].blockers, ['warrant'], 'unknown blockers dropped');
    eq(entry.totals.overThreshold, 3, 'totals stored for the trend');
    ok('saved', B.saveHistory(entry, store).ok);
    eq(B.loadHistory(store.getItem).length, 1, 'history has one entry');

    const later = B.build({ getItem: store.getItem, now: '2026-11-20T10:00:00', opts: { scope: 'overdue' } });
    eq(byNum(later, '26-0001').previous.update, 'Waiting on Google.', 'next report sees the previous update');
    eq(later.period.start, '2026-10-24', 'next period starts the day after the last report');
    eq(later.charts.trend.length, 2, 'trend has the last report + now');
    eq(later.historyCount, 1, 'historyCount');

    for (let i = 0; i < 30; i++) B.saveHistory(Object.assign({}, entry, { id: 'x' + i }), store);
    eq(B.loadHistory(store.getItem).length, B.HISTORY_MAX, 'history capped');
    eq(B.saveHistory(entry, null).ok, false, 'no storage → error, no throw');

    eq(B.sanitizeUpdate({ update: 'a', blockers: ['da', 'x'], targetDate: '12/01/2026' }),
        { update: 'a', nextSteps: '', blockers: ['da'], targetDate: '' }, 'sanitizeUpdate');
    eq(B.thresholdFrom(k => (k === 'viperCsrThresholdDays' ? '45' : null)), 45, 'threshold from settings');
    eq(B.thresholdFrom(k => (k === 'viperCsrThresholdDays' ? '17' : null)), 30, 'odd threshold falls back to 30');
    eq(B.defaultPeriod(() => null, NOW), { start: '2026-09-24', end: '2026-10-23' }, 'defaultPeriod without history');
    const sameDay = memStore({ viperCaseStatusReports: JSON.stringify([{ generatedAt: '2026-10-23T09:00:00' }]) });
    eq(B.defaultPeriod(sameDay.getItem, NOW).start, '2026-09-24', 'report already run today → last 30 days again');
}

console.log('[build: empty / bad input]');
{
    const m = B.build({ getItem: () => null, now: NOW, opts: {} });
    eq([m.cases.length, m.totals.openCases, m.totals.workedPct], [0, 0, 0], 'no data → empty model');
    const bad = B.build({ getItem: k => (k === 'viperCases' ? '{not json' : null), now: NOW });
    eq(bad.cases.length, 0, 'corrupt JSON tolerated');
    const ident = B.identityFrom(smallStore().getItem);
    eq([ident.name, ident.agency], ['Det. Test Person', 'Test PD'], 'identity');
}

console.log('[build: fixture]');
{
    const store = makeStore({ cases: 45, now: NOW, history: true });
    const m = B.build({ getItem: store.getItem, now: store.now, opts: { scope: 'overdue' } });
    ok('fixture has overdue cases', m.cases.length > 10);
    ok('every case in overdue scope is overdue', m.cases.every(c => c.overdue && c.daysOverdue > 0));
    ok('sorted by days overdue', m.cases.every((c, i, a) => i === 0 || a[i - 1].daysOverdue >= c.daysOverdue));
    eq(m.charts.tiers.reduce((a, t) => a + t.count, 0), m.cases.length, 'tier counts add up');
    eq(m.charts.ageBuckets.reduce((a, t) => a + t.count, 0), m.cases.length, 'age buckets add up');
    ok('highlights written', m.highlights.length > 0 && m.highlights.length <= 6);
    ok('weekly series has 12 weeks', m.cases.every(c => c.weekly.length === 12));
    ok('milestones sorted', m.cases.every(c => c.milestones.every((x, i, a) => i === 0 || a[i - 1].date <= x.date)));
    ok('no internal fields leak', m.cases.every(c => !('_events' in c)));
}

// ── render ─────────────────────────────────────────────────────────────
function pageCount(html) { return (html.match(/<section class="page/g) || []).length; }
console.log('[render]');
{
    const store = makeStore({ cases: 45, now: NOW, history: true });
    const m = B.build({ getItem: store.getItem, now: store.now, opts: { scope: 'overdue' } });
    const html = R.render(m, { cases: {}, statement: '' }, { theme: 'dark', includeNotes: true });
    const n = pageCount(html);
    ok('starts with a doctype', html.indexOf('<!DOCTYPE html>') === 0);
    ok('dark body', html.indexOf('<body class="dark">') !== -1);
    // cover + summary + analytics + overview pages + one per case + statement
    const tablePages = Math.ceil(m.cases.length / 20);
    eq(n, 3 + tablePages + m.cases.length + 1, 'page count');
    const pad2 = x => (x < 10 ? '0' : '') + x;
    ok('footer page numbers agree', html.indexOf('Page ' + pad2(n) + ' of ' + pad2(n)) !== -1);
    ok('every case gets a spotlight', m.cases.every(c => html.indexOf('Case Spotlight · ' + c.caseNumber) !== -1));
    ok('notes shown', html.indexOf('Recent case notes') !== -1);

    const noNotes = R.render(m, {}, { theme: 'light', includeNotes: false });
    ok('light body', noNotes.indexOf('<body class="light">') !== -1);
    ok('notes hidden when off', noNotes.indexOf('Recent case notes') === -1 && noNotes.indexOf('Activity this period') !== -1);

    const first = m.cases[0].caseNumber;
    const long = 'Lorem ipsum dolor sit amet. '.repeat(60);
    const withLong = R.render(m, { cases: { [first]: { update: long, nextSteps: 'x', blockers: ['lab'] } } }, {});
    eq(pageCount(withLong), n + 1, 'long update adds one continuation page');
    ok('continuation marked', withLong.indexOf('Full update continues on the next page.') !== -1 && withLong.indexOf('· continued') !== -1);
    ok('blocker label drawn', withLong.indexOf('Awaiting lab / forensics') !== -1);

    const evil = JSON.parse(JSON.stringify(m));
    evil.cases[0].offense = '<script>alert(1)</script>';
    evil.identity.name = '<img src=x onerror=alert(1)>';
    const safe = R.render(evil, { cases: { [first]: { update: '<b>bold</b>\nline2' } }, statement: '"quoted" & <tag>' }, {});
    ok('offense escaped', safe.indexOf('<script>alert(1)</script>') === -1 && safe.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
    ok('identity escaped', safe.indexOf('<img src=x') === -1);
    ok('update escaped, newlines kept', safe.indexOf('&lt;b&gt;bold&lt;/b&gt;<br>line2') !== -1);
    ok('statement escaped', safe.indexOf('&quot;quoted&quot; &amp; &lt;tag&gt;') !== -1);

    const logo = R.render(m, {}, { logoUrl: 'file:///C:/x/csr-logo.png', badgeUrl: 'data:image/png;base64,AAAA' });
    ok('logo and badge used', logo.indexOf('file:///C:/x/csr-logo.png') !== -1 && logo.indexOf('data:image/png;base64,AAAA') !== -1);

    const empty = B.build({ getItem: () => null, now: NOW, opts: {} });
    const eh = R.render(empty, {}, {});
    ok('empty report renders', pageCount(eh) >= 3);
    ok('empty report skips analytics', eh.indexOf('Caseload Analytics') === -1);
    ok('empty report has no spotlights', eh.indexOf('Case Spotlight') === -1);
    ok('statement page always present', eh.indexOf('Statement & Review') !== -1 || eh.indexOf('Statement &amp; Review') !== -1);
}

// ── wizard helpers ─────────────────────────────────────────────────────
console.log('[dashboard helpers]');
{
    const store = smallStore({ viperCaseStatusReports: JSON.stringify([{
        generatedAt: '2026-10-01T09:00:00',
        caseUpdates: {
            '26-0001': { update: 'Old update', nextSteps: 'Carry me', blockers: ['warrant'], targetDate: '2026-12-01' },
            '26-0007': { update: 'Old', nextSteps: '', blockers: [], targetDate: '2026-10-01' }
        }
    }]) });
    const m = buildSmall({ scope: 'overdue' }, store);
    const init = D.initialUpdates(m, {}, NOW);
    eq(init.cases['26-0001'], { update: '', nextSteps: 'Carry me', blockers: ['warrant'], targetDate: '2026-12-01' }, 'next steps / blockers / future target carry over; update starts blank');
    eq(init.cases['26-0007'].targetDate, '', 'past target date not carried');
    eq(init.statement, '', 'statement blank');

    const draft = { cases: { '26-0001': { update: 'Drafted', nextSteps: 'n', blockers: ['da'], targetDate: '' } }, statement: 'S' };
    const fromDraft = D.initialUpdates(m, draft, NOW);
    eq(fromDraft.cases['26-0001'], { update: 'Drafted', nextSteps: 'n', blockers: ['da'], targetDate: '' }, 'draft wins');
    eq(fromDraft.statement, 'S', 'draft statement restored');

    const fin = D.finalUpdates(m, fromDraft, true);
    eq(fin.cases['26-0001'].update, 'Drafted', 'written update kept');
    eq(fin.cases['26-0004'].update, byNum(m, '26-0004').draft, 'blank filled with activity summary');
    eq(D.finalUpdates(m, fromDraft, false).cases['26-0004'].update, '', 'summary fill can be turned off');

    eq(D.progress(m, fromDraft), { done: 1, total: 3 }, 'progress');
    eq(D.fileName(m, NOW), 'Case_Status_Report_Det_Test_Person_2026-10-23.pdf', 'file name');
    eq(D.fileName({ identity: {} }, NOW), 'Case_Status_Report_2026-10-23.pdf', 'file name without a name');
    eq(D.enabled(k => (k === 'viperCaseStatusReportEnabled' ? 'true' : null)), true, 'enabled');
    eq(D.enabled(() => null), false, 'off by default');
    eq(D.DRAFT_KEY.indexOf('viper'), 0, 'draft key is a viper* key (included in backups)');
    eq(B.HISTORY_KEY.indexOf('viper'), 0, 'history key is a viper* key (included in backups)');
}

// ── wiring ─────────────────────────────────────────────────────────────
console.log('[wiring]');
{
    const ROOT = path.join(__dirname, '..', '..', '..');
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const settings = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
    const at = s => index.indexOf(s);
    const ws = at('modules/warrant-status.js'), cb = at('modules/case-status-report/csr-build.js'),
        cr = at('modules/case-status-report/csr-render.js'), cd = at('modules/case-status-report/csr-dashboard.js');
    ok('scripts present', ws !== -1 && cb !== -1 && cr !== -1 && cd !== -1);
    ok('script order: warrant-status → build → render → dashboard', ws < cb && cb < cr && cr < cd);
    ok('dashboard panel hidden by default', /id="csrDashboardPanel" class="hidden/.test(index));
    ok('button opens the wizard', index.indexOf('CaseStatusReport.open()') !== -1);
    ok('panel sits under the IDS buttons', at('id="idsDashboardPanel"') < at('id="csrDashboardPanel"'));

    ok('settings toggle', settings.indexOf('id="csrToggleBtn"') !== -1 && settings.indexOf('onclick="toggleCsrEnabled()"') !== -1);
    ok('settings key', settings.indexOf("'viperCaseStatusReportEnabled'") !== -1);
    ok('threshold select', settings.indexOf('id="csrThresholdSelect"') !== -1 && settings.indexOf("'viperCsrThresholdDays'") !== -1);
    ok('card follows the IDS card', settings.indexOf('id="idsToggleBtn"') < settings.indexOf('id="csrToggleBtn"'));
    ok('switch drawn on load', /refreshCsrUI\(\);\s*\}\s*catch/.test(settings));
    ok('threshold choices match build', [30, 45, 60, 90].every(n => settings.indexOf('<option value="' + n + '">') !== -1) &&
        JSON.stringify(B.THRESHOLD_CHOICES) === '[30,45,60,90]');

    ok('full-bleed print option', main.indexOf("options.marginType === 'none'") !== -1);
    ok('logo shipped', fs.existsSync(path.join(__dirname, '..', 'csr-logo.png')));
    const dash = fs.readFileSync(path.join(__dirname, '..', 'csr-dashboard.js'), 'utf8');
    ok('dashboard uses the shipped logo path', dash.indexOf("'modules/case-status-report/csr-logo.png'") !== -1);
    ok('prints with no margins', dash.indexOf("marginType: 'none'") !== -1);
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
