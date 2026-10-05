/**
 * Task due-date handling — regression tests.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An officer created a reminder for a class on 10/19/2026. The task LIST
 * showed "Oct 18, 2026 at 08:30". The CALENDAR showed Monday, October 19.
 * Two views of one task, two different days.
 *
 * Root cause: a task's due date is stored as a bare 'YYYY-MM-DD' string from
 * an <input type="date">. ECMAScript parses a date-ONLY ISO string as UTC
 * midnight, so new Date('2026-10-19') is 2026-10-19T00:00Z — which in any
 * timezone behind UTC is the evening of the 18th. The calendar was already
 * building its date from the split parts and so was always right.
 *
 * This bug is INVISIBLE in UTC and anywhere ahead of it. A developer in
 * London or Tokyo would never see it. That is exactly why it needs a test
 * that pins behaviour across timezones rather than one that runs in whatever
 * zone the build machine happens to sit in.
 *
 * The functions under test are LIFTED out of index.html rather than copied,
 * so this cannot pass against a stale duplicate of the real code.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\tasks\__tests__\task-dates.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const INDEX_HTML = path.join(__dirname, '..', '..', '..', 'index.html');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log('  FAIL  ' + label + (detail ? '  [' + detail + ']' : ''));
}

// ── Lift the shipping implementations out of index.html ──────────────
// Brace-matching from the `function <name>(` anchor. index.html is CRLF on
// disk; normalise first or multi-line anchors silently miss.
const SRC = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

function liftFunction(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('could not find function ' + name + ' in index.html');
    let i = SRC.indexOf('{', start);
    let depth = 0;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    return SRC.slice(start, i + 1);
}

const LIFTED = ['_taskDateLocal', 'formatDate', 'isOverdue'].map(liftFunction).join('\n\n');

console.log('\n== the functions are still in index.html and still lift cleanly ==');
check('_taskDateLocal was found', /function _taskDateLocal\s*\(/.test(LIFTED));
check('formatDate was found', /function formatDate\s*\(/.test(LIFTED));
check('isOverdue was found', /function isOverdue\s*\(/.test(LIFTED));
check('formatDate routes through the local-midnight helper',
    /function formatDate[\s\S]*?_taskDateLocal\(dateStr\)/.test(LIFTED));
check('isOverdue routes through the local-midnight helper',
    /function isOverdue[\s\S]*?_taskDateLocal\(dateStr\)/.test(LIFTED));
// The whole bug was this construction. If it ever comes back, say so loudly.
// Scoped to the two FORMATTERS on purpose: _taskDateLocal itself keeps a
// deliberate `new Date(dateStr)` fallback for input that is not a bare
// YYYY-MM-DD (a full ISO timestamp pushed in from elsewhere), and that one
// is correct — a timestamp carries its own offset.
const FORMATTERS = liftFunction('formatDate') + '\n\n' + liftFunction('isOverdue');
check('no bare new Date(dateStr) survives in either formatter',
    !/new Date\(dateStr\)/.test(FORMATTERS),
    'new Date(<date-only string>) parses as UTC and shifts the day');
check('the only bare new Date(dateStr) left is the helper fallback',
    (liftFunction('_taskDateLocal').match(/new Date\(dateStr\)/g) || []).length === 1);

function loadIn(tz) {
    const env = vm.createContext({ console });
    env.globalThis = env;
    vm.runInContext(LIFTED + ';Object.assign(globalThis,{_taskDateLocal,formatDate,isOverdue});', env);
    return env;
}

// ── The reported case ────────────────────────────────────────────────
// Run the lifted code under a real TZ by shelling out, because a vm context
// inherits the host process timezone and cannot be re-pointed in-process.
const TZS = ['America/Chicago', 'America/Los_Angeles', 'America/New_York',
    'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Asia/Tokyo'];

function runUnderTz(tz, body) {
    const tmp = path.join(require('os').tmpdir(), 'viper-task-date-probe.js');
    fs.writeFileSync(tmp, LIFTED + '\n' + body, 'utf8');
    const out = execFileSync(process.execPath, [tmp], {
        env: Object.assign({}, process.env, { TZ: tz, ELECTRON_RUN_AS_NODE: '1' }),
        encoding: 'utf8',
    });
    fs.unlinkSync(tmp);
    return JSON.parse(out.trim().split('\n').pop());
}

console.log('\n== the 10/19 reminder reads as the 19th in every timezone ==');
// The literal task from the bug report: Cybertips Day 1, 10/19/2026, 08:30.
const PROBE = `
const task = { date: '2026-10-19', time: '08:30', timeUTC: false };
const [y, m, d] = task.date.split('-').map(Number);
console.log(JSON.stringify({
    list: formatDate(task.date, task.time, task.timeUTC),
    // Exactly what _openCalendarDayModal() builds for its heading.
    calendar: new Date(y, m - 1, d).toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric' }),
    dayOfMonth: _taskDateLocal(task.date).getDate(),
    month: _taskDateLocal(task.date).getMonth() + 1,
    year: _taskDateLocal(task.date).getFullYear(),
}));`;

for (const tz of TZS) {
    const r = runUnderTz(tz, PROBE);
    check(tz + ': list view says Oct 19',
        r.list === 'Oct 19, 2026 at 08:30', r.list);
    check(tz + ': calendar view says October 19',
        r.calendar === 'Monday, October 19', r.calendar);
    // The real contract: the two views agree. A date that is wrong in BOTH
    // would still be a bug, so the absolute assertions above matter too.
    check(tz + ': the two views agree on the day',
        r.list.indexOf('Oct 19') === 0 && /October 19$/.test(r.calendar),
        r.list + ' vs ' + r.calendar);
    check(tz + ': the parsed date is literally 2026-10-19',
        r.year === 2026 && r.month === 10 && r.dayOfMonth === 19,
        r.year + '-' + r.month + '-' + r.dayOfMonth);
}

console.log('\n== overdue is judged against the right day ==');
const OVERDUE_PROBE = `
const out = {};
// A date far in the future is never overdue, with or without a time.
out.futureNoTime  = isOverdue('2099-01-15', '', false);
out.futureWithTime = isOverdue('2099-01-15', '08:30', false);
// A date far in the past always is.
out.pastNoTime    = isOverdue('2001-01-15', '', false);
out.pastWithTime  = isOverdue('2001-01-15', '08:30', false);
// TODAY with no time is NOT overdue — "sometime today" has not expired
// until the day has. The old code set 23:59:59 on a UTC-parsed date, which
// behind UTC landed on YESTERDAY 23:59:59 and marked it overdue all day.
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
out.todayNoTime = isOverdue(today, '', false);
// Tomorrow, likewise, must never be overdue.
const t = new Date(now.getTime() + 86400000);
const tomorrow = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
out.tomorrowNoTime = isOverdue(tomorrow, '', false);
out.tomorrowWithTime = isOverdue(tomorrow, '00:01', false);
// Garbage in must not throw or claim overdue.
out.emptyDate = isOverdue('', '08:30', false);
out.junkDate  = isOverdue('not a date', '', false);
console.log(JSON.stringify(out));`;

for (const tz of TZS) {
    const r = runUnderTz(tz, OVERDUE_PROBE);
    check(tz + ': a 2099 task is not overdue', r.futureNoTime === false);
    check(tz + ': a 2099 task with a time is not overdue', r.futureWithTime === false);
    check(tz + ': a 2001 task is overdue', r.pastNoTime === true);
    check(tz + ': a 2001 task with a time is overdue', r.pastWithTime === true);
    check(tz + ": today with no time is NOT overdue", r.todayNoTime === false);
    check(tz + ': tomorrow is not overdue', r.tomorrowNoTime === false);
    check(tz + ': tomorrow 00:01 is not overdue', r.tomorrowWithTime === false);
    check(tz + ': an empty date is not overdue', r.emptyDate === false);
    check(tz + ': an unparseable date is not overdue', r.junkDate === false);
}

console.log('\n== a UTC-flagged time is compared as UTC ==');
// The officer can tick "UTC" next to the time — typically for a return
// deadline quoted by a provider. Reading that as a local time would move the
// overdue line by the size of the UTC offset.
const UTC_PROBE = `
const now = new Date();
// Build an instant ~2 hours in the future, expressed as a UTC wall time.
const soon = new Date(now.getTime() + 2 * 3600 * 1000);
const pad = n => String(n).padStart(2, '0');
const dUtc = soon.getUTCFullYear() + '-' + pad(soon.getUTCMonth() + 1) + '-' + pad(soon.getUTCDate());
const tUtc = pad(soon.getUTCHours()) + ':' + pad(soon.getUTCMinutes());
// And one ~2 hours in the past.
const past = new Date(now.getTime() - 2 * 3600 * 1000);
const dPast = past.getUTCFullYear() + '-' + pad(past.getUTCMonth() + 1) + '-' + pad(past.getUTCDate());
const tPast = pad(past.getUTCHours()) + ':' + pad(past.getUTCMinutes());
console.log(JSON.stringify({
    futureUtc: isOverdue(dUtc, tUtc, true),
    pastUtc: isOverdue(dPast, tPast, true),
}));`;

for (const tz of TZS) {
    const r = runUnderTz(tz, UTC_PROBE);
    check(tz + ': a UTC deadline 2h out is not overdue', r.futureUtc === false);
    check(tz + ': a UTC deadline 2h ago is overdue', r.pastUtc === true);
}

console.log('\n== formatDate degrades rather than printing garbage ==');
const FMT_PROBE = `
console.log(JSON.stringify({
    empty: formatDate('', '', false),
    nullish: formatDate(null, null, false),
    junk: formatDate('not a date', '', false),
    noTime: formatDate('2026-10-19', '', false),
    utcFlag: formatDate('2026-10-19', '08:30', true),
    // An ISO timestamp (some tasks are pushed in from other modules) must
    // still read as its own calendar day, not shift.
    isoStamp: formatDate('2026-10-19T14:00:00', '', false),
}));`;
{
    const r = runUnderTz('America/Chicago', FMT_PROBE);
    check('an empty date renders as empty, not "Invalid Date"', r.empty === '', r.empty);
    check('a null date renders as empty', r.nullish === '', r.nullish);
    check('an unparseable date renders as empty', r.junk === '', r.junk);
    check('a date with no time omits the "at" clause',
        r.noTime === 'Oct 19, 2026', r.noTime);
    check('the UTC flag is shown next to the time',
        r.utcFlag === 'Oct 19, 2026 at 08:30 UTC', r.utcFlag);
    check('a full ISO timestamp keeps its own calendar day',
        r.isoStamp === 'Oct 19, 2026', r.isoStamp);
}

console.log('\n== editing a task is wired up in index.html ==');
// These are cheap structural pins. The edit flow lives in inline handlers, so
// the thing most likely to break it is a rename that misses one call site.
check('openEditTaskModal is defined once',
    (SRC.match(/function openEditTaskModal\s*\(/g) || []).length === 1);
check('the list view offers an edit button',
    /onclick="openEditTaskModal\(\$\{task\.id\}\)"/.test(SRC));
check('the calendar day modal offers one too',
    (SRC.match(/openEditTaskModal\(\$\{task\.id\}\)/g) || []).length === 2);
check('the modal heading is addressable', /id="taskModalTitle"/.test(SRC));
check('the submit button is addressable', /id="taskSubmitBtn"/.test(SRC));
check('editingTaskId is declared exactly once',
    (SRC.match(/let editingTaskId\b/g) || []).length === 1);
check('the submit handler branches on edit mode',
    /if \(editingTaskId !== null\)/.test(SRC));
check('closing the modal clears edit mode so the next Add is not an overwrite',
    /function closeAddTaskModal\(\)[\s\S]{0,600}?editingTaskId = null;/.test(SRC));
check('opening Add clears edit mode too',
    /function openAddTaskModal\(\)[\s\S]{0,200}?editingTaskId = null;/.test(SRC));
// An edit must not resurrect a completed task or reorder it.
check('an edit preserves completion state',
    !/Object\.assign\(task, fields\)[\s\S]{0,400}?task\.completed =/.test(SRC));
check('an edit stamps updatedAt', /task\.updatedAt = new Date\(\)\.toISOString\(\);/.test(SRC));
check('a task pointing at an unknown case keeps the pointer',
    /\(not in list\)/.test(SRC));

console.log('\n== officer free text is escaped before it hits innerHTML ==');
check('_taskEsc is defined once',
    (SRC.match(/function _taskEsc\s*\(/g) || []).length === 1);
check('the list view escapes the title', /\$\{_taskEsc\(task\.title\)\}/.test(SRC));
check('the list view escapes the notes', /\$\{_taskEsc\(task\.notes\)\}/.test(SRC));
check('the list view escapes the file name', /\$\{_taskEsc\(task\.fileName\)\}/.test(SRC));
{
    const env = loadIn();
    vm.runInContext(
        'globalThis._taskEsc = ' + liftFunction('_taskEsc').replace(/^function _taskEsc/, 'function') + ';',
        env);
    const esc = env._taskEsc;
    check('angle brackets are neutralised',
        esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', esc('<b>'));
    check('ampersands are escaped first', esc('a & b') === 'a &amp; b', esc('a & b'));
    check('quotes are escaped', esc('he said "hi"') === 'he said &quot;hi&quot;', esc('"'));
    check('null becomes empty string', esc(null) === '', JSON.stringify(esc(null)));
    check('undefined becomes empty string', esc(undefined) === '', JSON.stringify(esc(undefined)));
}

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : 'FAILURES') +
    '  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
