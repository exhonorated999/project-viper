/* Customizable dashboard: data helpers (dash-data.js). Plain node. */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '..', 'dash-data.js'));
const WS = require(path.join(__dirname, '..', '..', 'warrant-status.js'));

let pass = 0, fail = 0;
function ok(label, cond) {
    if (cond) { pass++; console.log('PASS ' + label); }
    else { fail++; console.log('FAIL ' + label); }
}

const NOW = new Date(2026, 10, 13, 10, 0, 0); // 13 Nov 2026

// ── months ──
const m12 = D.monthList('12m', NOW);
ok('12m length', m12.length === 12);
ok('12m oldest first, ends this month', m12[0].key === '2025-12' && m12[11].key === '2026-11');
ok('6m', D.monthList('6m', NOW)[0].key === '2026-06');
ok('24m', D.monthList('24m', NOW).length === 24);
ok('ytd', D.monthList('ytd', NOW).length === 11 && D.monthList('ytd', NOW)[0].key === '2026-01');
ok('quarter (Oct-Nov)', D.monthList('quarter', NOW).map(m => m.key).join() === '2026-10,2026-11');
ok('all from first date', D.monthList('all', NOW, '2026-03-02').length === 9);
ok('all capped at 36', D.monthList('all', NOW, '2010-01-01').length === 36);
ok('all w/o first date -> 12', D.monthList('all', NOW).length === 12);
ok('all w/ future first date -> 1', D.monthList('all', NOW, '2027-05-01').length === 1);
ok('month overflow normalizes', D.monthInfo(2026, -1).key === '2025-12' && D.monthInfo(2026, 12).key === '2027-01');
ok('month bounds', D.monthInfo(2026, 1).end.getTime() === new Date(2026, 2, 1).getTime());
const rw = D.rangeWindow('ytd', NOW);
ok('rangeWindow ytd', rw.start.getTime() === new Date(2026, 0, 1).getTime() && rw.end.getTime() === new Date(2026, 11, 1).getTime());
ok('rangeWindow all null', D.rangeWindow('all', NOW) === null);
ok('rangeLabel fallback', D.rangeLabel('zz') === 'Last 12 months');
ok('parseDate ymd local', D.parseDate('2026-11-13').getHours() === 0 && D.parseDate('2026-11-13').getDate() === 13);
ok('parseDate junk', D.parseDate('nope') === null && D.parseDate('') === null);

// ── toNum ──
ok('toNum number', D.toNum(5, 'arrests') === 5);
ok('toNum null stays null', D.toNum(null, 'x') === null && D.toNum(undefined, 'x') === null);
ok('toNum money', D.toNum('$1,234.50', 'cargo_recovered') === 1234.5);
ok('toNum narcotics unit', D.toNum({ kg: '2.5', lbs: 5.5, pills: 10 }, 'narcotics_seized.kg') === 2.5);
ok('toNum narcotics sum', D.toNum({ kg: 1, lbs: 2, pills: 3 }, 'narcotics_seized') === 6);
ok('toNum NaN -> 0', D.toNum('abc', 'x') === 0 && D.toNum(NaN, 'x') === 0);

// ── sweep ──
let installed = [], restored = 0, computeN = 0;
const adapter = {
    install: w => installed.push(w.label),
    compute: () => { computeN++; },
    harvest: () => ({ arrests: installed.length, narcotics_seized: { kg: 1, pills: 2 } }),
    restore: () => { restored++; },
};
const months = D.monthList('6m', NOW);
const cache = D.sweepMonths(months, adapter, {});
ok('sweep fills each month', Object.keys(cache).length === 6 && computeN === 6);
ok('sweep restores once', restored === 1);
D.sweepMonths(months, adapter, cache);
ok('sweep skips cached months', computeN === 6 && restored === 1);
ok('seriesFor', JSON.stringify(D.seriesFor(cache, months, 'arrests')) === '[1,2,3,4,5,6]');
ok('seriesFor unit', D.seriesFor(cache, months, 'narcotics_seized.pills')[0] === 2);
ok('seriesFor missing -> null', D.seriesFor(cache, months, 'zzz')[0] === null && D.seriesFor({}, months, 'arrests')[0] === null);
let r2 = 0;
const boom = { install() {}, compute() { throw new Error('x'); }, harvest() { return {}; }, restore() { r2++; } };
let threw = false;
try { D.sweepMonths(months, boom, {}); } catch (_) { threw = true; }
ok('sweep restores on throw', threw && r2 === 1);
ok('sum ignores null', D.sum([1, null, 2, NaN]) === 3);

// ── distribution ──
const cases = [
    { id: 1, status: 'active', category: 'Fraud', primaryOffense: 'Theft', priority: 1, dateAssigned: '2026-11-01' },
    { id: 2, status: 'closed', category: 'fraud', offenseType: 'Theft', priority: '2', dateAssigned: '2026-10-01' },
    { id: 3, status: 'cust_x', category: '', priority: 9, createdAt: '2024-01-01T00:00:00Z' },
    { id: 4, status: 'active', caseRole: 'assist', category: 'Fraud', dateAssigned: '2026-11-02' },
    { id: 5, status: 'active', category: '<img src=x onerror=1>', priority: 3, dateAssigned: '2026-11-03' },
];
const st = D.distribution(cases, 'status', { customStatuses: [{ id: 'cust_x', label: 'On Hold' }] });
ok('status excludes assists', st.reduce((a, r) => a + r.count, 0) === 4);
ok('status labels + custom', st[0].label === 'Active' && st[0].count === 2 && st.some(r => r.label === 'On Hold'));
const cat = D.distribution(cases, 'category');
ok('category case-folds + Uncategorized', cat.find(r => r.key === 'fraud').count === 2 && cat.some(r => r.label === 'Uncategorized'));
ok('category label kept raw (renderer escapes)', cat.some(r => r.label === '<img src=x onerror=1>'));
ok('offense fallback', D.distribution(cases, 'offense').find(r => r.key === 'theft').count === 2);
const pr = D.distribution(cases, 'priority');
ok('priority order, none last', pr.map(r => r.key).join() === '1,2,3,none');
const role = D.distribution(cases, 'role');
ok('role counts assists', role.find(r => r.key === 'assist').count === 1 && role.find(r => r.key === 'lead').count === 4);
const win = D.distribution(cases, 'status', { window: D.rangeWindow('quarter', NOW) });
ok('window filter', win.reduce((a, r) => a + r.count, 0) === 3);
ok('unknown dim -> []', D.distribution(cases, 'zzz').length === 0);
const many = []; for (let i = 0; i < 20; i++) many.push({ id: i, category: 'C' + i });
const top = D.distribution(many, 'category', { top: 5 });
ok('top-N folds into Other', top.length === 5 && top[4].label === 'Other (16)' && top[4].count === 16);
ok('long labels clipped', D.distribution([{ category: 'x'.repeat(90) }], 'category')[0].label.length === 40);

// ── year over year ──
const ym = D.yoyMonths(NOW);
ok('yoy months Jan last year .. now', ym[0].key === '2025-01' && ym[ym.length - 1].key === '2026-11' && ym.length === 23);
const yc = {};
ym.forEach((mo, i) => { yc[mo.key] = { arrests: i + 1 }; });
const ys = D.yoySeries(yc, 'arrests', NOW);
ok('yoy prev full year', ys.prev.length === 12 && ys.prev[0] === 1 && ys.prev[11] === 12);
ok('yoy cur future null', ys.cur[10] === 23 && ys.cur[11] === null);
ok('yoy to-date sums', ys.prevToDate === 66 && ys.curToDate === 13 * 11 + 55);

// ── agenda ──
const tasks = [
    { id: 't1', title: 'Old', date: '2026-11-10', completed: false },
    { id: 't2', title: 'Done', date: '2026-11-14', completed: true },
    { id: 't3', title: 'Court', kind: 'court', date: '2026-11-14', time: '09:00', caseId: 'C-7' },
    { id: 't7', title: 'Orphan', date: '2026-11-15', caseId: 'GONE-1' },
    { id: 't4', title: 'Far', date: '2026-12-30' },
    { id: 't5', title: 'Today', date: '2026-11-13', time: '15:00', priority: 'high' },
    { id: 't6', title: 'Bad date', date: 'soon' },
];
const warrants = {
    'C-7': [
        { id: 'w1', type: 'search', dueDate: '2026-11-14' },
        { id: 'w2', type: 'search', returnReceived: true, dueDate: '2026-11-14' },
        { id: 'w3', type: 'prtt', returnReceived: true, expirationDate: '2026-11-16' },
        { id: 'w4', type: 'prtt', closedOut: true, expirationDate: '2026-11-16' },
    ],
    'C-404': 'junk',
};
const ag = D.agendaItems({ tasks, warrants, cases: [{ id: 7, caseNumber: 'C-7' }], days: 7, now: NOW, WarrantStatus: WS });
const kinds = ag.map(a => a.kind + ':' + a.id).join();
ok('agenda drops completed, far, bad dates', !/t2|t4|t6/.test(kinds));
ok('agenda overdue first', ag[0].id === 't1' && ag[0].overdue && ag[0].days === -3);
ok('agenda today', ag.some(a => a.id === 't5' && a.days === 0 && !a.overdue));
ok('agenda court before warrant same day', kinds.indexOf('court:t3') < kinds.indexOf('warrant:w1'));
ok('agenda task resolves case by NUMBER', (a => a.caseNumber === 'C-7' && a.caseId === 7)(ag.find(a => a.id === 't3')));
ok('agenda unknown case keeps number, no id', (a => a.caseNumber === 'GONE-1' && a.caseId === null)(ag.find(a => a.id === 't7')));
ok('agenda returned warrant skipped', !/w2/.test(kinds));
ok('agenda includes PRTT expiry (returned but not closed out)', /prtt:w3/.test(kinds));
ok('agenda skips closed-out PRTT', !/w4/.test(kinds));
const ag2 = D.agendaItems({ tasks, warrants, cases: [], days: 7, now: NOW, WarrantStatus: WS, include: { tasks: false, court: true, warrants: false } });
ok('agenda include filters', ag2.length === 1 && ag2[0].kind === 'court');
ok('agenda case id null when no case', ag.find(a => a.id === 't1').caseId === null);
ok('agenda without WarrantStatus skips warrants', D.agendaItems({ tasks: [], warrants, now: NOW }).length === 0);
ok('dayDiff', D.dayDiff(new Date(2026, 10, 14, 1), new Date(2026, 10, 13, 23)) === 1);

// ── recent / pinned ──
let rec = [];
rec = D.pushRecent(rec, 1); rec = D.pushRecent(rec, 2); rec = D.pushRecent(rec, '1');
ok('pushRecent moves to front, no dupes', rec.length === 2 && String(rec[0]) === '1');
let big = []; for (let i = 0; i < 30; i++) big = D.pushRecent(big, i);
ok('pushRecent capped', big.length === 15 && big[0] === 29);
let pin = D.togglePinned([], 5); pin = D.togglePinned(pin, 6); pin = D.togglePinned(pin, '5');
ok('togglePinned', pin.length === 1 && pin[0] === 6);
const cs = [{ id: 1, caseNumber: 'A' }, { id: 2, caseNumber: 'B' }, { id: 3, caseNumber: 'C' }];
const rl = D.recentLists({ recent: [3, 2, 99, 1], pinned: [2], cases: cs, mode: 'both', count: 8 });
ok('recentLists both: no repeat + drops unknown', rl.pinned.length === 1 && rl.recent.map(c => c.id).join() === '3,1');
ok('recentLists recent mode', D.recentLists({ recent: [2], pinned: [2], cases: cs, mode: 'recent' }).recent.length === 1);
ok('recentLists pinned mode', D.recentLists({ recent: [1], pinned: [2], cases: cs, mode: 'pinned' }).recent.length === 0);
ok('recentLists count', D.recentLists({ recent: [1, 2, 3], cases: cs, mode: 'recent', count: 2 }).recent.length === 2);
ok('recentLists junk input', D.recentLists({ recent: 'x', pinned: null, cases: null }).recent.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
