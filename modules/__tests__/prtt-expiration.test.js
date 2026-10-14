/**
 * PRTT (Pen Register / Trap & Trace) orders — the expiration alert.
 *
 * A PRTT order carries an expiration date. On that date the dashboard's
 * Warrant Alerts card and the bell list it, with an Acknowledge button that
 * hides it. An extended order (a new expiration date) alerts again on the
 * new date. The case page swaps the due-date field for the expiration date.
 *
 * The wiring lives inline in index.html and case-detail-with-analytics.html,
 * so this test LIFTS the shipping functions out of both pages rather than
 * copying them, and runs them against the real WarrantStatus module.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\__tests__\prtt-expiration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const DASH = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const CASE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const WarrantStatus = require(path.join(ROOT, 'modules', 'warrant-status.js'));

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function eq(label, got, want) {
    check(label, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n== ' + t + ' =='); }

function lift(src, start, end, what) {
    const a = src.indexOf(start);
    const b = src.indexOf(end, a + 1);
    if (a < 0 || b < 0 || b <= a) {
        console.error('Could not locate ' + what + '. Anchors moved?');
        process.exit(1);
    }
    return src.slice(a, b);
}

const D_ESC = lift(DASH, 'function caseTextEsc(s) {', 'function updateActiveInvestigationsTable(', 'caseTextEsc');
const D_CHECK = lift(DASH, 'function checkOverdueWarrants() {', '// ═══ Assist cases', 'checkOverdueWarrants');
const D_ALERTS = lift(DASH, 'function updateWarrantAlerts() {', '// Initialize everything when page loads', 'updateWarrantAlerts');
const D_BADGE = lift(DASH, 'function updateNotificationBadge() {', '// Keep the bell badge', 'updateNotificationBadge');
const D_LISTS = lift(DASH, 'function getOverdueWarrantsList() {', 'function closeBellDropdown() {', 'the expired-order list + acknowledge');

const C_PRED = lift(CASE, 'function _warrantIsPreservation(typeOrWarrant) {', '/* ------------------------------------------------------------------\n         * Optional times', 'the type predicates');
const C_TOGGLE = lift(CASE, 'function warrantTypeChanged() {', '/* Which cards are open.', 'warrantTypeChanged');
const C_CHIP = lift(CASE, 'function _warrantHeaderChip(w) {', 'function renderWarrantsTab() {', '_warrantHeaderChip');
const C_ACK = lift(CASE, 'function acknowledgeWarrantExpiration(warrantId) {', 'function uploadWarrantProduction(', 'acknowledgeWarrantExpiration');

// ------------------------------------------------------------ fixtures

function isoDay(offset) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function makeEl(id) {
    const cls = new Set();
    return {
        id, innerHTML: '', textContent: '', value: '', required: false,
        classList: {
            toggle(c, on) { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; },
            add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
        },
    };
}

function dashboard(store) {
    const els = { warrantAlertCount: makeEl('warrantAlertCount'), warrantAlertsList: makeEl('warrantAlertsList') };
    const badge = makeEl('badge');
    const toasts = [], audits = [];
    const ls = {
        data: Object.assign({}, store),
        getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
        setItem(k, v) { if (this.failWrites) throw new Error('QuotaExceededError'); this.data[k] = String(v); },
    };
    const sb = {
        WarrantStatus, JSON, Date, Math, Object, Array, String, Number, console,
        localStorage: ls,
        document: {
            getElementById: (id) => els[id] || null,
            querySelector: (s) => (s === '.notification-badge' ? badge : null),
        },
        viperToast: (msg, kind) => toasts.push({ msg, kind }),
        audit: (ev, data) => audits.push({ ev, data }),
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(D_ESC + D_CHECK + D_ALERTS + D_BADGE + D_LISTS, sb, { filename: 'index.html(lifted)' });
    return { sb, els, badge, toasts, audits, ls };
}

function prtt(id, exp, extra) {
    return Object.assign({ id, type: 'prtt', issuedTo: 'Verizon Wireless', expirationDate: exp,
        expirationAcknowledgedAt: null, expirationAcknowledgedFor: null }, extra || {});
}

function seed(warrantsByCase) {
    return {
        viperCaseWarrants: JSON.stringify(warrantsByCase),
        viperCases: JSON.stringify([{ id: 501, caseNumber: '26-1001' }, null, { id: 502, caseNumber: '26-1002' }]),
    };
}

// ------------------------------------------------------------ dashboard

section('dashboard: an order that expires today is on the alerts card');
{
    const d = dashboard(seed({ '26-1001': [prtt(11, isoDay(0))] }));
    d.sb.updateWarrantAlerts();
    const html = d.els.warrantAlertsList.innerHTML;
    eq('count reads 1 Active', d.els.warrantAlertCount.textContent, '1 Active');
    check('a PRTT card is rendered', html.includes('data-prtt-alert'));
    check('it says "expires today"', html.includes('expires today'));
    check('it names the provider', html.includes('PRTT order → Verizon Wireless'));
    check('it carries an Acknowledge button', html.includes('data-prtt-ack') && html.includes('>Acknowledge</button>'));
    check('the button stops the click opening the case', /data-prtt-ack onclick="event\.stopPropagation\(\); acknowledgePrttExpiration\(/.test(html));
    check('the card opens the right case', html.includes('openCaseDetail(501)'));
}

section('dashboard: future, unexpired and non-PRTT orders stay quiet');
{
    const d = dashboard(seed({
        '26-1001': [prtt(12, isoDay(1)), prtt(13, isoDay(30))],
        '26-1002': [{ id: 14, type: 'search', expirationDate: isoDay(-5), dueDate: isoDay(20) }],
    }));
    d.sb.updateWarrantAlerts();
    eq('nothing is alerting', d.els.warrantAlertCount.textContent, '0 Active');
    check('no PRTT card', !d.els.warrantAlertsList.innerHTML.includes('data-prtt-alert'));
    eq('expired list is empty', d.sb.getExpiredOrdersList().length, 0);
}

section('dashboard: lapsed orders are listed first, ahead of overdue warrants');
{
    const d = dashboard(seed({
        '26-1001': [{ id: 20, type: 'search', dueDate: isoDay(-3), issuedTo: 'Google LLC' }],
        '26-1002': [prtt(21, isoDay(-6), { issuedTo: 'T-Mobile' }), prtt(22, isoDay(0), { issuedTo: 'AT&T <Legal>' })],
    }));
    d.sb.updateWarrantAlerts();
    const html = d.els.warrantAlertsList.innerHTML;
    eq('three alerts', d.els.warrantAlertCount.textContent, '3 Active');
    const iToday = html.indexOf('expires today'), iOld = html.indexOf('6d expired'), iOver = html.indexOf('overdue');
    check('both PRTT cards come before the overdue warrant', iToday >= 0 && iOld >= 0 && iOver > iToday && iOver > iOld,
        [iToday, iOld, iOver].join(','));
    check('expiring today comes before the one that lapsed 6 days ago', iToday < iOld);
    check('provider names are escaped', html.includes('AT&amp;T &lt;Legal&gt;') && !html.includes('AT&T <Legal>'));
    const list = d.sb.getExpiredOrdersList();
    eq('list carries the case id', list[0].caseId, 502);
    eq('list days for today', list[0].days, 0);
    eq('list days for 6 days ago', list[1].days, 6);
}

section('dashboard: Acknowledge saves and hides the alert');
{
    const d = dashboard(seed({ '26-1001': [prtt(31, isoDay(-2)), prtt(32, isoDay(-1))] }));
    d.sb.updateWarrantAlerts();
    d.sb.updateNotificationBadge();
    eq('two alerts before', d.els.warrantAlertCount.textContent, '2 Active');
    eq('bell badge reads 2', d.badge.textContent, 2);

    d.sb.acknowledgePrttExpiration('26-1001', 31);
    const saved = JSON.parse(d.ls.data.viperCaseWarrants)['26-1001'];
    const w31 = saved.find(w => w.id === 31);
    check('acknowledged time was saved', typeof w31.expirationAcknowledgedAt === 'string' && w31.expirationAcknowledgedAt.length > 0);
    eq('acknowledgement is tied to the date it covered', w31.expirationAcknowledgedFor, isoDay(-2));
    eq('the expiration date itself is kept', w31.expirationDate, isoDay(-2));
    check('the other order is untouched', saved.find(w => w.id === 32).expirationAcknowledgedAt === null);
    eq('card count drops to 1', d.els.warrantAlertCount.textContent, '1 Active');
    eq('bell badge drops to 1', d.badge.textContent, 1);
    check('success toast', d.toasts.some(t => t.kind === 'success' && /acknowledged/i.test(t.msg)));
    check('audited', d.audits.some(a => a.ev === 'warrant_expiration_acknowledged' && a.data.warrant_id === 31 && a.data.from === 'dashboard'));

    d.sb.acknowledgePrttExpiration('26-1001', 32);
    eq('card empties', d.els.warrantAlertCount.textContent, '0 Active');
    check('"No active alerts"', d.els.warrantAlertsList.innerHTML.includes('No active alerts'));
    check('bell badge hidden', d.badge.classList.contains('hidden'));
}

section('dashboard: the onclick the card writes reaches the right order');
{
    // Run the exact call string the card renders, decoded the way a browser
    // decodes the attribute, so a quoting mistake cannot hide.
    const d = dashboard(seed({ '26-1001': [prtt(41, isoDay(0))] }));
    d.sb.updateWarrantAlerts();
    const m = d.els.warrantAlertsList.innerHTML.match(/data-prtt-ack onclick="event\.stopPropagation\(\); (acknowledgePrttExpiration\([^"]*\))"/);
    check('call string found', !!m);
    if (m) {
        vm.runInContext(m[1].replace(/&quot;/g, '"'), d.sb);
        eq('alert gone after running the rendered call', d.els.warrantAlertCount.textContent, '0 Active');
    }
}

section('dashboard: an extended order alerts again on its new date');
{
    const w = prtt(51, isoDay(-3));
    WarrantStatus.acknowledgeExpiration(w);
    const quiet = dashboard(seed({ '26-1001': [w] }));
    eq('acknowledged order is quiet', quiet.sb.getExpiredOrdersList().length, 0);

    const later = Object.assign({}, w, { expirationDate: isoDay(20) });
    const d1 = dashboard(seed({ '26-1001': [later] }));
    eq('extended to the future: still quiet', d1.sb.getExpiredOrdersList().length, 0);

    const lapsedAgain = Object.assign({}, w, { expirationDate: isoDay(0) });
    const d2 = dashboard(seed({ '26-1001': [lapsedAgain] }));
    eq('the new date arrives: it alerts again', d2.sb.getExpiredOrdersList().length, 1);
}

section('dashboard: closing an order out silences it; "return received" does not');
{
    const d = dashboard(seed({ '26-1001': [
        prtt(61, isoDay(-1), { closedOut: true }),
        prtt(62, isoDay(-1), { returnReceived: true }),
    ] }));
    const ids = d.sb.getExpiredOrdersList().map(i => i.warrant.id);
    check('closed-out order is hidden', !ids.includes(61));
    check('return-received order still alerts', ids.includes(62));
}

section('dashboard: a failed save is reported, never a false success');
{
    const d = dashboard(seed({ '26-1001': [prtt(71, isoDay(-1))] }));
    d.ls.failWrites = true;
    d.sb.acknowledgePrttExpiration('26-1001', 71);
    check('error toast', d.toasts.some(t => t.kind === 'error' && /could not save/i.test(t.msg)));
    check('no success toast', !d.toasts.some(t => t.kind === 'success'));
    check('nothing audited', d.audits.length === 0);
    d.ls.failWrites = false;
    eq('the order still alerts', d.sb.getExpiredOrdersList().length, 1);
}

section('dashboard: a missing order is reported, not silently ignored');
{
    const d = dashboard(seed({ '26-1001': [prtt(81, isoDay(-1))] }));
    d.sb.acknowledgePrttExpiration('26-9999', 81);
    check('error toast', d.toasts.some(t => t.kind === 'error' && /could not be found/i.test(t.msg)));
    d.sb.acknowledgePrttExpiration('26-1001', { id: 81 });
    check('wrong id type does not acknowledge', JSON.parse(d.ls.data.viperCaseWarrants)['26-1001'][0].expirationAcknowledgedAt === null);
}

section('dashboard: bad rows in storage do not break the card');
{
    const d = dashboard({
        viperCaseWarrants: JSON.stringify({ '26-1001': [null, prtt(91, isoDay(0))], '26-1002': null }),
        viperCases: JSON.stringify([null]),
    });
    let threw = null;
    try { d.sb.updateWarrantAlerts(); d.sb.updateNotificationBadge(); } catch (e) { threw = e; }
    check('the card and the bell badge survive null rows (viperCases can hold them)', !threw, threw && threw.message);
    eq('the good order still alerts', d.sb.getExpiredOrdersList().length, 1);
    eq('the badge counts it', d.badge.textContent, 1);
}

// ------------------------------------------------------------ case page

function casePage(warrants) {
    const ids = ['warrantType', 'warrantDateSignedField', 'warrantDueDateField', 'warrantExpirationField',
        'warrantCourtFieldsRow', 'warrantCourtLevelRow', 'warrantExpirationDate', 'warrantDatesRow',
        'warrantDateServedLabel', 'warrantFileLabel', 'warrantFileButtonText'];
    const els = {};
    ids.forEach(id => { els[id] = makeEl(id); });
    els.warrantExpirationField.classList.add('hidden');
    const calls = { saved: 0, rendered: [], toasts: [], audits: [] };
    const sb = {
        WarrantStatus, Date, JSON, console,
        document: { getElementById: (id) => els[id] || null },
        caseWarrants: warrants || [],
        currentCase: { id: 501, caseNumber: '26-1001' },
        saveWarrantsToStorage: () => { calls.saved++; },
        renderTabContent: (t) => calls.rendered.push(t),
        showToast: (m, k) => calls.toasts.push({ m, k }),
        audit: (ev, data) => calls.audits.push({ ev, data }),
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(C_PRED + C_TOGGLE + C_CHIP + C_ACK, sb, { filename: 'case-detail(lifted)' });
    return { sb, els, calls };
}

section('case page: the PRTT option is in the type dropdown');
{
    check('<option value="prtt"> present', /<option value="prtt">PRTT — Pen Register \/ Trap &amp; Trace<\/option>/.test(CASE));
    check('expiration input present', /<input type="date" id="warrantExpirationDate"/.test(CASE));
}

section('case page: choosing PRTT swaps Due Date for Order Expires');
{
    const p = casePage();
    p.els.warrantType.value = 'prtt';
    p.sb.warrantTypeChanged();
    check('expiration field shown', !p.els.warrantExpirationField.classList.contains('hidden'));
    check('due-date field hidden', p.els.warrantDueDateField.classList.contains('hidden'));
    check('expiration required while shown', p.els.warrantExpirationDate.required === true);
    check('date signed still shown (a judge signs a PRTT)', !p.els.warrantDateSignedField.classList.contains('hidden'));

    p.els.warrantType.value = 'search';
    p.sb.warrantTypeChanged();
    check('back to search: expiration hidden', p.els.warrantExpirationField.classList.contains('hidden'));
    check('back to search: due date shown', !p.els.warrantDueDateField.classList.contains('hidden'));
    check('back to search: not required (a hidden required input blocks the save)', p.els.warrantExpirationDate.required === false);
}

section('case page: header chip colours');
{
    const p = casePage();
    check('lapsed + unacknowledged: red', p.sb._warrantHeaderChip(prtt(1, isoDay(-1))).includes('text-red-300'));
    check('expires in 3 days: orange', p.sb._warrantHeaderChip(prtt(2, isoDay(3))).includes('text-viper-orange'));
    const far = p.sb._warrantHeaderChip(prtt(3, isoDay(40), { returnReceived: true }));
    check('far off, return received: gray, never green', far.includes('text-gray-300') && !far.includes('viper-green'));
    const acked = prtt(4, isoDay(-1)); WarrantStatus.acknowledgeExpiration(acked);
    check('acknowledged: no longer red', !p.sb._warrantHeaderChip(acked).includes('text-red-300'));
    check('chip wording comes from WarrantStatus', p.sb._warrantHeaderChip(prtt(5, isoDay(0))).includes('Expires today'));
}

section('case page: Acknowledge from the warrant card');
{
    const w = prtt(7, isoDay(-2));
    const p = casePage([w]);
    p.sb.acknowledgeWarrantExpiration(7);
    eq('acknowledged for the current date', w.expirationAcknowledgedFor, isoDay(-2));
    eq('saved once', p.calls.saved, 1);
    eq('tab repainted', p.calls.rendered[0], 'warrants');
    check('audited with the date', p.calls.audits[0] && p.calls.audits[0].data.expiration_date === isoDay(-2));
    check('alert gone', !WarrantStatus.needsExpirationAlert(w));

    const s = { id: 8, type: 'search', dueDate: isoDay(-2), expirationDate: isoDay(-2) };
    const p2 = casePage([s]);
    p2.sb.acknowledgeWarrantExpiration(8);
    eq('a search warrant cannot be "acknowledged" away', p2.calls.saved, 0);
    check('and nothing was written to it', !('expirationAcknowledgedAt' in s));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
