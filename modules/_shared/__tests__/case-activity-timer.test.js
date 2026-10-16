/**
 * Case Activity Timer — field report: adding an Investigative Action to the
 * Case Timeline did not reset the case's inactivity alert.
 *
 * The dashboard alert (index.html updateWarrantAlerts) measures from
 * case.lastModified; timeline entries live in timelineEvents_<id>, outside
 * the case record, so saving one never moved that date.
 *
 * Both halves are LIFTED out of the shipping pages and run together:
 * case-detail's saveTimelineEvent → the stored viperCases → index.html's
 * updateWarrantAlerts drawing the alert card.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond) {
    if (cond) { passed++; console.log('  PASS  ' + label); }
    else { failed++; console.log('  FAIL  ' + label); }
}
function section(name) { console.log('\n[' + name + ']'); }

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const DETAIL = read('case-detail-with-analytics.html');
const INDEX = read('index.html');

function liftFunction(src, name, file) {
    const lines = src.split('\n');
    const re = new RegExp('^\\s*(async\\s+)?function ' + name + '\\s*\\(');
    const start = lines.findIndex(l => re.test(l));
    if (start < 0) throw new Error('could not find function ' + name + ' in ' + file);
    let depth = 0, opened = false;
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/\{/g) || []).length;
        depth -= (lines[i].match(/\}/g) || []).length;
        if (lines[i].indexOf('{') >= 0) opened = true;
        if (opened && depth <= 0) return lines.slice(start, i + 1).join('\n');
    }
    throw new Error('unbalanced braces lifting ' + name);
}

function makeStorage(seed) {
    const data = Object.assign({}, seed || {});
    return {
        _data: data,
        getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem(k, v) { data[k] = String(v); },
        removeItem(k) { delete data[k]; }
    };
}

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/* ── the dashboard half: index.html updateWarrantAlerts ───────────────── */
function dashboardAlerts(storage) {
    const els = { warrantAlertCount: { textContent: '' }, warrantAlertsList: { innerHTML: '' } };
    const sb = {
        localStorage: storage, JSON, Date, Math, Set, Object, Array, String, isNaN, console,
        document: { getElementById: (id) => els[id] || null },
        WarrantStatus: { isOverdue: () => false, daysOverdue: () => 0 },
        getExpiredOrdersList: () => [],
        caseTextEsc: (s) => String(s)
    };
    vm.createContext(sb);
    vm.runInContext(liftFunction(INDEX, 'updateWarrantAlerts', 'index.html') + '\nupdateWarrantAlerts();', sb);
    return { count: els.warrantAlertCount.textContent, html: els.warrantAlertsList.innerHTML };
}

/* ── the case half: case-detail saveTimelineEvent (+ its helpers) ─────── */
function caseDetail(storage, theCase, form) {
    const toasts = [];
    const field = (v) => ({ value: v, checked: v === true });
    const fields = {
        tl_date: field(form.date), tl_time: field(form.time || '10:30'), tl_utc: field(false),
        tl_title: field(form.title), tl_lane: field(form.lane || 'investigation'),
        tl_category: field(form.category || 'surveillance'), tl_entity: field(''), tl_desc: field(form.desc || '')
    };
    const sb = {
        localStorage: storage, JSON, Date, Math, Object, Array, String, isNaN, console,
        window: {},
        document: {
            getElementById: (id) => fields[id] || null,
            querySelector: () => ({ value: 'major' })
        },
        viperToast: (m) => toasts.push(m),
        renderTabContent: () => {},
        closeTimelineEventModal: () => {},
        saveCase: () => { throw new Error('a timeline save must not run a full case save'); }
    };
    sb._lsParse = (k, d) => { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
    vm.createContext(sb);
    const src = [
        'let currentCase = __case;',
        'let timelineEvents = [];',
        'let hasUnsavedChanges = true;',
        liftFunction(DETAIL, '_findCaseIndex', 'case-detail'),
        liftFunction(DETAIL, 'loadTimelineEvents', 'case-detail'),
        liftFunction(DETAIL, 'saveTimelineEvents', 'case-detail'),
        liftFunction(DETAIL, '_touchCaseActivity', 'case-detail'),
        liftFunction(DETAIL, 'saveTimelineEvent', 'case-detail'),
        'loadTimelineEvents();',
        'saveTimelineEvent({ preventDefault() {} }, __editId);',
        '__out = { currentCase, timelineEvents, hasUnsavedChanges };'
    ].join('\n');
    sb.__case = theCase;
    sb.__editId = form.editId || null;
    vm.runInContext(src, sb);
    return Object.assign({ toasts }, sb.__out);
}

/* ── fixtures ─────────────────────────────────────────────────────────── */
function seed() {
    const cases = [
        { id: 101, caseNumber: '2026-0101', status: 'active', createdAt: daysAgo(60), lastModified: daysAgo(20), title: 'Stale case' },
        { id: 102, caseNumber: '2026-0102', status: 'active', createdAt: daysAgo(60), lastModified: daysAgo(30), title: 'Other stale case' }
    ];
    return makeStorage({
        viperCases: JSON.stringify(cases),
        viperCaseActivityTimers: JSON.stringify({ '2026-0101': { enabled: true, days: 14 }, '2026-0102': { enabled: true, days: 14 } })
    });
}

section('before: both cases are stale');
{
    const st = seed();
    const a = dashboardAlerts(st);
    ok('2 alerts on the dashboard', a.count === '2 Active');
    ok('case 0101 shows 20d inactive', /Case 2026-0101[\s\S]*?20d inactive/.test(a.html));
}

section('adding an Investigative Action resets that case\'s timer');
{
    const st = seed();
    const otherBefore = JSON.parse(st.getItem('viperCases'))[1].lastModified;
    const inMemory = JSON.parse(st.getItem('viperCases'))[0];
    inMemory.title = 'UNSAVED EDIT';              // a pending edit in the open case
    const t0 = Date.now();
    const r = caseDetail(st, inMemory, { date: '2026-10-16', title: 'Surveillance of subject residence' });
    ok('no warning toast', r.toasts.length === 0);
    ok('event saved to the timeline store', JSON.parse(st.getItem('timelineEvents_101')).length === 1);
    const stored = JSON.parse(st.getItem('viperCases'));
    const lm = new Date(stored[0].lastModified).getTime();
    ok('stored case lastModified moved to now', lm >= t0 && lm <= Date.now());
    ok('in-memory case lastModified matches', r.currentCase.lastModified === stored[0].lastModified);
    ok('other case untouched', stored[1].lastModified === otherBefore);
    ok('pending edit NOT written behind the officer\'s back', stored[0].title === 'Stale case');
    ok('unsaved-changes flag left alone', r.hasUnsavedChanges === true);
    const a = dashboardAlerts(st);
    ok('dashboard: only the other case still alerts', a.count === '1 Active' && !/2026-0101/.test(a.html) && /2026-0102/.test(a.html));
}

section('editing an existing timeline entry also counts');
{
    const st = seed();
    st.setItem('timelineEvents_101', JSON.stringify([{ id: 'tl_x', timestamp: daysAgo(25), title: 'old', lane: 'investigation', sourceType: 'manual' }]));
    const c = JSON.parse(st.getItem('viperCases'))[0];
    caseDetail(st, c, { date: '2026-10-16', title: 'Interview — follow-up', editId: 'tl_x' });
    const ev = JSON.parse(st.getItem('timelineEvents_101'));
    ok('entry edited in place', ev.length === 1 && ev[0].title === 'Interview — follow-up');
    ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
}

section('a rejected entry (no title) does not count as activity');
{
    const st = seed();
    const c = JSON.parse(st.getItem('viperCases'))[0];
    const r = caseDetail(st, c, { date: '2026-10-16', title: '' });
    ok('warning shown', r.toasts.length === 1 && /required/i.test(r.toasts[0]));
    ok('case 0101 still alerts', /2026-0101/.test(dashboardAlerts(st).html));
}

section('case missing from the store: nothing is invented');
{
    const st = seed();
    const ghost = { id: 999, caseNumber: '2026-9999', status: 'active', lastModified: daysAgo(40) };
    caseDetail(st, ghost, { date: '2026-10-16', title: 'x' });
    const stored = JSON.parse(st.getItem('viperCases'));
    ok('no case added to viperCases', stored.length === 2);
}

/* ── Case Tasks (case-detail) ─────────────────────────────────────────── */
function caseTasksRun(storage, theCase, action) {
    const field = (v) => ({ value: v, checked: v === true });
    const fields = {
        task_id: field(action.editId || ''), task_description: field('Interview witness'),
        task_dueDate: field('2026-10-20'), task_dueTime: field(''), task_priority: field('medium'), task_notes: field('')
    };
    const sb = {
        localStorage: storage, JSON, Date, Math, Object, Array, String, isNaN, console,
        window: {},
        document: { getElementById: (id) => fields[id] || null },
        viperToast: () => {}, closeCaseTaskModal: () => {}, refreshCaseTasksList: () => {},
        _caseTaskUser: () => 'tester', _caseTaskStamp: () => '',
        saveCase: () => { throw new Error('a task save must not run a full case save'); }
    };
    sb._lsParse = (k, d) => { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
    vm.createContext(sb);
    const src = [
        'let currentCase = __case;',
        'let caseTasks = __tasks;',
        liftFunction(DETAIL, '_findCaseIndex', 'case-detail'),
        liftFunction(DETAIL, 'saveCaseTasks', 'case-detail'),
        liftFunction(DETAIL, '_touchCaseActivity', 'case-detail'),
        liftFunction(DETAIL, 'saveCaseTask', 'case-detail'),
        liftFunction(DETAIL, 'toggleCaseTaskComplete', 'case-detail'),
        action.toggle ? 'toggleCaseTaskComplete(__toggle);' : 'saveCaseTask({ preventDefault() {} });',
        '__out = { currentCase, caseTasks };'
    ].join('\n');
    sb.__case = theCase;
    sb.__tasks = action.tasks || [];
    sb.__toggle = action.toggle;
    vm.runInContext(src, sb);
    return sb.__out;
}

section('Case Tasks: adding a task resets the timer');
{
    const st = seed();
    const c = JSON.parse(st.getItem('viperCases'))[0];
    const otherBefore = JSON.parse(st.getItem('viperCases'))[1].lastModified;
    const r = caseTasksRun(st, c, {});
    ok('task stored', JSON.parse(st.getItem('viperTasks')).length === 1);
    ok('in-memory case touched', Date.now() - new Date(r.currentCase.lastModified).getTime() < 60000);
    ok('other case untouched', JSON.parse(st.getItem('viperCases'))[1].lastModified === otherBefore);
    ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
}

section('Case Tasks: completing a task resets the timer');
{
    const st = seed();
    const c = JSON.parse(st.getItem('viperCases'))[0];
    caseTasksRun(st, c, { toggle: 7, tasks: [{ id: 7, caseId: '2026-0101', title: 't', completed: false }] });
    ok('task completed', JSON.parse(st.getItem('viperTasks'))[0].completed === true);
    ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
}

section('Case Tasks: editing a task resets the timer');
{
    const st = seed();
    const c = JSON.parse(st.getItem('viperCases'))[0];
    caseTasksRun(st, c, { editId: '7', tasks: [{ id: 7, caseId: '2026-0101', title: 'old', completed: false }] });
    ok('task edited in place', JSON.parse(st.getItem('viperTasks')).length === 1 && JSON.parse(st.getItem('viperTasks'))[0].title === 'Interview witness');
    ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
}

/* ── Dashboard tasks (index.html) ─────────────────────────────────────── */
function dashboardToggle(storage, taskList, id) {
    const sb = {
        localStorage: storage, JSON, Date, Math, Object, Array, String, console,
        document: { getElementById: () => null },
        renderTasks: () => {}, currentTaskMode: 'list', calendarSelectedDay: null,
        updateWarrantAlerts: () => { sb.__alertsRefreshed = true; }
    };
    vm.createContext(sb);
    vm.runInContext([
        'let cases = JSON.parse(localStorage.getItem("viperCases")) || [];',
        'let tasks = __tasks;',
        liftFunction(INDEX, '_touchCaseActivityByNumber', 'index.html'),
        liftFunction(INDEX, 'toggleTaskComplete', 'index.html'),
        'toggleTaskComplete(__id);',
        '__out = { cases };'
    ].join('\n'), Object.assign(sb, { __tasks: taskList, __id: id }));
    return sb;
}

section('Dashboard: completing a case-linked task resets that case\'s timer');
{
    const st = seed();
    const otherBefore = JSON.parse(st.getItem('viperCases'))[1].lastModified;
    const sb = dashboardToggle(st, [{ id: 1, caseId: '2026-0101', completed: false }], 1);
    ok('in-memory dashboard case touched', Date.now() - new Date(sb.__out.cases[0].lastModified).getTime() < 60000);
    ok('dashboard alerts refreshed', sb.__alertsRefreshed === true);
    ok('other case untouched', JSON.parse(st.getItem('viperCases'))[1].lastModified === otherBefore);
    ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
}

section('Dashboard: a general task (no case) touches nothing');
{
    const st = seed();
    const before = st.getItem('viperCases');
    dashboardToggle(st, [{ id: 1, caseId: null, completed: false }], 1);
    ok('viperCases unchanged', st.getItem('viperCases') === before);
}

section('Dashboard: add/edit task form touches the linked case');
{
    const handler = INDEX.slice(INDEX.indexOf("getElementById('taskForm').addEventListener('submit'"));
    const body = handler.slice(0, handler.indexOf('// Check for overdue warrants'));
    ok('edit path touches task.caseId', /setItem\('viperTasks'[^\n]*\n\s*_touchCaseActivityByNumber\(task\.caseId\);/.test(body));
    ok('add path touches newTask.caseId', /setItem\('viperTasks'[^\n]*\n\s*_touchCaseActivityByNumber\(newTask\.caseId\);/.test(body));
}

/* ── Case Notes ───────────────────────────────────────────────────────── */
section('Case Notes: the note writer and the profile note editor touch the case');
{
    const commit = liftFunction(DETAIL, '_noteCommit', 'case-detail');
    ok('_noteCommit touches after a successful write',
        /if \(_persistCaseNotes\(\) === false\) \{\s*return \{ saved: false, reason: 'quota' \};\s*\}\s*\/\/[^\n]*\n\s*_touchCaseActivity\(\);/.test(commit));
    ok('_noteCommit does not touch before the write', commit.indexOf('_touchCaseActivity()') > commit.indexOf('_persistCaseNotes()'));
    ok('profile note editor touches after a successful write',
        /if \(_persistCaseNotes\(\) === false\) \{ caseNotes = before; return; \}\s*_touchCaseActivity\(\);/.test(DETAIL));
}

section('Case Notes pop-out: an edit saved from the pop-out touches the case');
{
    const MAIN = read('electron-main.js');
    const start = MAIN.indexOf('\nasync function _noteWriteToMain(');
    const end = MAIN.indexOf('\n}\n', start + 1);
    const writer = new Function('mainWindow', MAIN.slice(start + 1, end + 2) + '\nreturn _noteWriteToMain;');
    function popoutSave(storage, pageCase, html) {
        const page = {
            localStorage: storage, JSON, Date, Array, String, Object, console,
            document: { getElementById: () => null }
        };
        vm.createContext(page);
        vm.runInContext('let currentCase = __pc; let caseNotes = []; let cases = JSON.parse(localStorage.getItem("viperCases"));', Object.assign(page, { __pc: pageCase }));
        const win = { isDestroyed: () => false, webContents: { executeJavaScript: (js) => Promise.resolve(vm.runInContext(js, page)) } };
        return writer(win)('2026-0101', '5', html).then(r => ({ r, page }));
    }
    const mk = () => {
        const st = seed();
        st.setItem('viperCaseNotes', JSON.stringify({ '2026-0101': [{ id: 5, contentHtml: 'old', editHistory: [] }] }));
        return st;
    };
    const tests = [];
    {
        const st = mk();
        const otherBefore = JSON.parse(st.getItem('viperCases'))[1].lastModified;
        const pc = JSON.parse(st.getItem('viperCases'))[0];
        tests.push(popoutSave(st, pc, 'new text').then(({ r, page }) => {
            ok('pop-out save accepted', r === true);
            ok('stored case lastModified moved', Date.now() - new Date(JSON.parse(st.getItem('viperCases'))[0].lastModified).getTime() < 60000);
            ok('open case in memory touched', Date.now() - new Date(vm.runInContext('currentCase.lastModified', page)).getTime() < 60000);
            ok('dashboard in-memory cases touched', Date.now() - new Date(vm.runInContext('cases[0].lastModified', page)).getTime() < 60000);
            ok('other case untouched', JSON.parse(st.getItem('viperCases'))[1].lastModified === otherBefore);
            ok('dashboard: case 0101 no longer alerts', !/2026-0101/.test(dashboardAlerts(st).html));
        }));
    }
    {
        const st = mk();
        const before = st.getItem('viperCases');
        tests.push(popoutSave(st, null, 'old').then(() => {
            ok('unchanged pop-out text touches nothing', st.getItem('viperCases') === before);
        }));
    }
    Promise.all(tests).then(finish, (e) => { failed++; console.log('  FAIL  pop-out harness threw: ' + e.stack); finish(); });
}

function finish() {
    console.log(`\ncase-activity-timer: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
}
