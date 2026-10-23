/**
 * Removing notifications from the Dashboard bell.
 *
 * 1. Supervisor Link rows (CyberTip assignments, case assignments, review
 *    decisions): removal must survive the reconcile-on-paint that re-sends
 *    everything the node still holds, and a review decision must stay on
 *    the case record.
 * 2. Overdue-warrant notices (index.html): removal hides the notice only,
 *    is keyed on the due date, and the badge count follows.
 *
 * The shipping files are run / lifted as-is — nothing is copied.
 * Run: node modules\supervisor-link\__tests__\notification-remove.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function eq(label, got, want) {
    check(label, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- tiny DOM
function makeEl(tag) {
    const e = {
        tagName: String(tag).toUpperCase(), children: [], style: {}, attrs: {}, listeners: {},
        _html: '', firstElementChild: null, textContent: '', title: '', type: '',
        setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'style') this.style.cssText = v; },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(c) { this.children.push(c); if (!this.firstElementChild) this.firstElementChild = c; return c; },
        append(...cs) { cs.forEach((c) => this.appendChild(c)); },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        removeChild() {}, querySelector() { return null; },
        click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
    };
    Object.defineProperty(e, 'innerHTML', {
        get() { return this._html; },
        set(v) {
            this._html = String(v); this.children = []; this.firstElementChild = null;
            // Rows render their header line via innerHTML; model it as one child.
            if (this._html.trim()) this.appendChild(makeEl('div'));
        },
    });
    return e;
}
function findAll(node, pred, out = []) {
    for (const c of node.children || []) { if (pred(c)) out.push(c); findAll(c, pred, out); }
    return out;
}

function makeStorage(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _m: m,
    };
}

// ---------------------------------------------------------------- 1. Supervisor Link
const SUP = fs.readFileSync(path.join(__dirname, '..', 'supervisor-link-ui.js'), 'utf8');

function bootSupervisor(seed, node) {
    const ls = makeStorage(seed);
    let onEvent = null;
    const events = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: ls, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Array, Object, Set, Map,
        CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
        alert() {},
        document: { readyState: 'complete', createElement: makeEl, body: makeEl('body'), addEventListener() {} },
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => {};
    sandbox.dispatchEvent = (e) => { events.push(e.type); };
    sandbox.viperToast = () => {};
    const ok = (v) => Promise.resolve(v);
    sandbox.electronAPI = {
        supervisorLink: {
            listen: () => ok({ ok: true }),
            onEvent: (fn) => { onEvent = fn; },
            icacAssignments: () => ok({ ok: true, assignments: node.icac || [] }),
            caseAssignments: () => ok({ ok: true, assignments: node.cases || [] }),
            myDeliveries: () => ok({ ok: true, deliveries: node.deliveries || [] }),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(SUP, sandbox, { filename: 'supervisor-link-ui.js' });
    return { sb: sandbox, ls, events, fire: (evt) => onEvent && onEvent(evt) };
}
const J = (ls, k) => JSON.parse(ls.getItem(k) || 'null');

(async () => {
    const NODE = {
        icac: [
            { id: 'ct-1', cybertipNumber: '111', fromName: 'Sgt A', sentAt: '2026-10-01T00:00:00Z', status: 'acknowledged' },
            { id: 'ct-2', cybertipNumber: '222', fromName: 'Sgt A', sentAt: '2026-10-02T00:00:00Z', status: 'pending' },
        ],
        cases: [{ id: 'ca-1', caseNumber: '33-333333', fromName: 'Sgt A', sentAt: '2026-10-03T00:00:00Z', status: 'acknowledged' }],
        deliveries: [{ id: 'dl-1', dtype: 'caseReview', manifest: { caseNumber: '33-333333' },
            decision: { decision: 'approved', comments: 'Good work', by: 'Lt B', at: '2026-10-04T00:00:00Z' } }],
    };
    const CASES = JSON.stringify([{ id: 7, caseNumber: '33-333333' }]);

    section('first paint — everything arrives');
    let s = bootSupervisor({ viperCases: CASES }, NODE);
    await new Promise((r) => setTimeout(r, 10));
    const SL = s.sb.SupervisorLink;
    check('SupervisorLink exposes removeNotification', typeof SL.removeNotification === 'function');
    eq('two CyberTip assignments', J(s.ls, 'viperIcacAssignments').length, 2);
    eq('one case assignment', J(s.ls, 'viperCaseAssignments').length, 1);
    eq('one review decision', J(s.ls, 'viperSupervisorReviews').length, 1);

    section('remove one of each');
    check('remove CyberTip ct-1', SL.removeNotification('icac', 'ct-1') === true);
    check('remove case ca-1', SL.removeNotification('case', 'ca-1') === true);
    check('remove review dl-1', SL.removeNotification('review', 'dl-1') === true);
    eq('CyberTip list keeps only ct-2', J(s.ls, 'viperIcacAssignments').map((a) => a.id), ['ct-2']);
    eq('case list empty', J(s.ls, 'viperCaseAssignments'), []);
    eq('review list empty', J(s.ls, 'viperSupervisorReviews'), []);
    check('bell told to refresh', s.events.includes('supervisor-inbox-updated'));
    const counts = SL.getInboxCounts();
    eq('counts follow (cyberTotal)', counts.cyberTotal, 1);
    eq('counts follow (caseTotal / reviewTotal)', [counts.caseTotal, counts.reviewTotal], [0, 0]);
    check('unknown kind refused', SL.removeNotification('bogus', 'x') === false);
    check('empty id refused', SL.removeNotification('icac', '') === false);
    check('isNotificationRemoved reads back', SL.isNotificationRemoved('icac', 'ct-1') && !SL.isNotificationRemoved('icac', 'ct-2'));
    const rev = J(s.ls, 'viperCases')[0].supervisorReviews || [];
    eq('review decision still on the case record', rev.map((r) => r.deliveryId), ['dl-1']);

    section('live events for removed ids are ignored; new ids still arrive');
    s.fire({ kind: 'icac:assign:new', payload: { id: 'ct-1', cybertipNumber: '111' } });
    s.fire({ kind: 'icac:assign:new', payload: { id: 'ct-3', cybertipNumber: '333' } });
    s.fire({ kind: 'case:assign:new', payload: { id: 'ca-1', caseNumber: '33-333333' } });
    eq('ct-1 stays gone, ct-3 arrives', J(s.ls, 'viperIcacAssignments').map((a) => a.id).sort(), ['ct-2', 'ct-3']);
    eq('ca-1 stays gone', J(s.ls, 'viperCaseAssignments'), []);

    section('next app start — reconcile re-sends everything');
    const carried = {};
    for (const k of ['viperIcacAssignments', 'viperCaseAssignments', 'viperSupervisorReviews', 'viperRemovedNotifications', 'viperCases']) {
        carried[k] = s.ls.getItem(k);
    }
    s = bootSupervisor(carried, NODE);
    await new Promise((r) => setTimeout(r, 10));
    eq('removed CyberTip not re-added', J(s.ls, 'viperIcacAssignments').map((a) => a.id).sort(), ['ct-2', 'ct-3']);
    eq('removed case assignment not re-added', J(s.ls, 'viperCaseAssignments'), []);
    eq('removed review not re-added to the list', J(s.ls, 'viperSupervisorReviews'), []);
    eq('review still on the case', (J(s.ls, 'viperCases')[0].supervisorReviews || []).length, 1);

    section('trash buttons in the rendered rows');
    const SL2 = s.sb.SupervisorLink;
    const box = makeEl('div');
    SL2.renderInboxInto(box);
    let btns = findAll(box, (n) => n.attrs['data-notif-remove'] === 'icac');
    eq('one trash button per CyberTip row', btns.length, 2);
    // ct-3 is pending (live event) → first click only arms.
    const pendingBtn = btns[0];
    pendingBtn.click();
    eq('pending row: first click does not remove', J(s.ls, 'viperIcacAssignments').length, 2);
    check('pending row: button asks to confirm', /Remove\?/.test(pendingBtn.innerHTML));
    pendingBtn.click();
    eq('pending row: second click removes', J(s.ls, 'viperIcacAssignments').length, 1);

    // An acknowledged row removes on the first click.
    const list = J(s.ls, 'viperIcacAssignments');
    list[0].status = 'acknowledged';
    s.ls.setItem('viperIcacAssignments', JSON.stringify(list));
    const box2 = makeEl('div');
    SL2.renderInboxInto(box2);
    btns = findAll(box2, (n) => n.attrs['data-notif-remove'] === 'icac');
    btns[0].click();
    eq('acknowledged row: one click removes', J(s.ls, 'viperIcacAssignments'), []);

    s.ls.setItem('viperCaseAssignments', JSON.stringify([{ id: 'ca-9', caseNumber: '1', status: 'acknowledged' }]));
    const box3 = makeEl('div');
    SL2.renderCaseInboxInto(box3);
    eq('case rows get a trash button', findAll(box3, (n) => n.attrs['data-notif-remove'] === 'case').length, 1);
    s.ls.setItem('viperSupervisorReviews', JSON.stringify([{ deliveryId: 'dl-9', caseNumber: '1', decision: 'returned', seen: true }]));
    const box4 = makeEl('div');
    SL2.renderReviewInboxInto(box4);
    const rb = findAll(box4, (n) => n.attrs['data-notif-remove'] === 'review');
    eq('review rows get a trash button', rb.length, 1);
    rb[0].click();
    eq('read review removes on one click', J(s.ls, 'viperSupervisorReviews'), []);

    section('removed-id list is capped');
    for (let i = 0; i < 1100; i++) SL2.removeNotification('icac', 'bulk-' + i);
    eq('cap 1000', J(s.ls, 'viperRemovedNotifications').icac.length, 1000);

    // ------------------------------------------------------------ 2. index.html
    section('overdue-warrant notices (index.html)');
    const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    function lift(start, end) {
        const a = PAGE.indexOf(start), b = PAGE.indexOf(end, a + 1);
        if (a < 0 || b < 0) { console.error('anchor moved: ' + start); process.exit(1); }
        return PAGE.slice(a, b);
    }
    const BELL = lift('function _bellWarrantKey(', '// ── Expired PRTT orders');
    const CHECK = lift('function checkOverdueWarrants() {', '// ═══ Assist cases');
    const ls = makeStorage({
        viperCases: JSON.stringify([{ id: 1, caseNumber: '26-1' }]),
        viperCaseWarrants: JSON.stringify({
            '26-1': [
                { id: 'w1', type: 'search', dueDate: '2026-01-01', overdue: true },
                { id: 'w2', type: 'preservation', dueDate: '2026-02-01', overdue: true },
                { id: 'w3', type: 'search', dueDate: '2099-01-01', overdue: false },
            ],
        }),
    });
    let badge = 0, rerender = 0;
    const sb = {
        localStorage: ls, JSON, Set, Array, Object, String, console,
        WarrantStatus: { isOverdue: (w) => !!w.overdue },
        document: { getElementById: (id) => (id === 'bellDropdown' ? {} : null), createElement: makeEl },
        updateNotificationBadge: () => { badge++; },
        renderBellDropdown: () => { rerender++; },
        viperToast: () => {},
    };
    vm.createContext(sb);
    vm.runInContext(BELL + '\n' + CHECK, sb);
    eq('two overdue before removal', sb.getOverdueWarrantsList().length, 2);
    eq('badge count 2', sb.checkOverdueWarrants(), 2);
    const w1 = JSON.parse(ls.getItem('viperCaseWarrants'))['26-1'][0];
    sb.removeOverdueWarrantNotice('26-1', w1);
    eq('one overdue after removal', sb.getOverdueWarrantsList().map((x) => x.warrant.id), ['w2']);
    eq('badge count follows', sb.checkOverdueWarrants(), 1);
    check('badge + open dropdown refreshed', badge === 1 && rerender === 1);
    eq('warrant itself untouched', JSON.parse(ls.getItem('viperCaseWarrants'))['26-1'].length, 3);
    // Due date changed → overdue again → notice returns.
    const all = JSON.parse(ls.getItem('viperCaseWarrants'));
    all['26-1'][0].dueDate = '2026-03-01';
    ls.setItem('viperCaseWarrants', JSON.stringify(all));
    eq('new due date notifies again', sb.getOverdueWarrantsList().map((x) => x.warrant.id).sort(), ['w1', 'w2']);
    const btn = sb._bellRemoveBtn('t', () => { btn._hit = true; });
    btn.click();
    check('bell trash button fires its action', btn._hit === true);
    check('index.html: overdue rows get the trash button', /removeOverdueWarrantNotice\(item\.caseNumber, item\.warrant\)/.test(PAGE));
    check('index.html: PRTT rows get the trash button', /_bellRemoveBtn\(\s*'Remove from list \(acknowledges the expiration\)'/.test(PAGE));

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
