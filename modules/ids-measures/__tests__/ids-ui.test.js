/*
 * IDS — the case card, the dashboard (Activity Log + Measures report + PDF),
 * and the two host-page code paths the feature leans on.
 *
 * Run: node modules\ids-measures\__tests__\ids-ui.test.js
 *
 * WHY THIS EXISTS
 *
 *   - The card and the dashboard reach the page only through closures and
 *     localStorage. A wrong key name reads as "zero" with no error, and a
 *     zero on a federal grant report is a misstatement. So gatherStore is
 *     pinned key by key.
 *   - A failed save must never look like a saved one (the 5.3.4 lesson).
 *   - jsPDF's Helvetica cannot draw an em dash; every PDF string is folded.
 *   - The suspect form now records the arrest that IDS counts. Editing a
 *     suspect used to REPLACE the record and drop its Case Notes link
 *     (noteUid). Both are LIFTED from the shipping HTML, not copied, and the
 *     old replace-on-edit line is re-applied in a control to prove the test
 *     would have caught it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const I = require(path.join(__dirname, '..', 'ids-measures.js'));
const Card = require(path.join(__dirname, '..', 'ids-case-card.js'));
const Dash = require(path.join(__dirname, '..', 'ids-dashboard.js'));

let pass = 0, fail = 0;
function ok(label, cond) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    const good = JSON.stringify(actual) === JSON.stringify(expected);
    if (!good) console.log('  FAIL: ' + label + '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual));
    good ? pass++ : fail++;
}
function rowOf(res, key) {
    for (const s of res.sections) for (const r of s.rows) if (r.key === key) return r;
    throw new Error('no row ' + key);
}

// ── tiny DOM + storage stubs ────────────────────────────────────────────
function makeStorage(seed) {
    const m = Object.assign({}, seed || {});
    return {
        _m: m, failWrites: false,
        getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
        setItem(k, v) { if (this.failWrites) throw new Error('QuotaExceededError'); m[k] = String(v); },
        removeItem(k) { delete m[k]; }
    };
}
function makeEl(id) {
    const cls = new Set();
    return {
        id, value: '', innerHTML: '', textContent: '', parentNode: null, children: [],
        _outer: null,
        set outerHTML(v) { this._outer = v; },
        get outerHTML() { return this._outer; },
        classList: {
            toggle(c, on) { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
            contains(c) { return cls.has(c); }, add(c) { cls.add(c); }, remove(c) { cls.delete(c); }
        },
        setAttribute() {}, querySelector() { return null; },
        removeChild(ch) { this.children = this.children.filter(x => x !== ch); ch.parentNode = null; },
        appendChild(ch) { this.children.push(ch); ch.parentNode = this; }
    };
}
function makeDoc() {
    const els = {};
    const body = makeEl('body');
    return {
        els, body, readyState: 'complete',
        getElementById(id) {
            if (els[id]) return els[id];
            const hit = body.children.find(c => c.id === id);
            return hit || null;
        },
        createElement() { return makeEl(''); },
        addEventListener() {}
    };
}
const getter = (st) => (k) => st.getItem(k);

// ═════════════════════════════════════════════════════════════════════════
// [umd]
console.log('[umd]');
ok('IdsCaseCard lands on the global (module is defined in the renderer too)', globalThis.IdsCaseCard === Card);
ok('IdsDashboard lands on the global', globalThis.IdsDashboard === Dash);
ok('IdsMeasures lands on the global', globalThis.IdsMeasures === I);

// ═════════════════════════════════════════════════════════════════════════
// [card]
console.log('[card]');
function cardHost(o) {
    const h = {
        _case: o.case, _tips: o.tips || [], _data: o.data || {}, _flagOk: o.flagOk !== false, _saveOk: o.saveOk !== false,
        saves: [], flags: [], toasts: [],
        enabled: () => o.enabled !== false,
        getCase() { return this._case; },
        getTips() { return this._tips; },
        load() { return this._data; },
        save(d) { this.saves.push(d); if (!this._saveOk) return false; this._data = d; return true; },
        setCaseFlag(b) { this.flags.push(b); if (!this._flagOk) return false; this._case.icac = b; return true; },
        toast(m, k) { this.toasts.push([m, k]); }
    };
    return h;
}
{
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1' }, enabled: false });
    eq(Card.html(h), '', 'switch off → the card renders nothing at all');
}
{
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1' } });
    const out = Card.html(h);
    ok('switch on, no tip → the box shows', out.includes('data-ids="flag"'));
    ok('no tip → explains it is not ICAC unless ticked', out.includes('Not an ICAC case unless you tick it.'));
    ok('not ICAC → no detail fields', !out.includes('data-ids="type"'));
}
{
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1', cybertipNumber: '123456' } });
    const out = Card.html(h);
    ok('a CyberTip ticks it automatically', out.includes('Ticked automatically because this case has a CyberTip.'));
    ok('ICAC → detail fields shown', out.includes('data-ids="type"') && out.includes('data-ids="cvip"'));
    ok('no type yet + tip → told it counts as reactive', out.includes('Counted as reactive'));
}
{
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1', icac: false }, tips: [{ id: 't' }] });
    const out = Card.html(h);
    ok('an explicit untick beats a tip', out.includes('You unticked this') && !out.includes('data-ids="type"'));
}
{
    // toggleFlag: success repaints, failure does not.
    const doc = makeDoc(); globalThis.document = doc;
    const host = makeEl('icacCardHost'); doc.els.icacCardHost = host;
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1' } });
    Card.html(h);
    Card.toggleFlag();
    eq(h.flags, [true], 'toggle on an untagged, tipless case asks for icac=true');
    ok('success → repainted with the ICAC fields', String(host.outerHTML).includes('data-ids="type"'));
    host._outer = null;
    h._flagOk = false;
    Card.toggleFlag();
    eq(h.flags, [true, false], 'second toggle asks for icac=false');
    eq(host.outerHTML, null, 'a refused flag save does NOT repaint a state that was not stored');
    delete globalThis.document;
}
{
    const doc = makeDoc(); globalThis.document = doc;
    doc.els.icacCardHost = makeEl('icacCardHost');
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1', icac: true } });
    Card.html(h);
    Card.setField('investigationType', 'proactive');
    eq(h._data.investigationType, 'proactive', 'setField stores a valid type');
    Card.setField('investigationType', 'nonsense');
    ok('an unknown type clears it rather than storing junk', !('investigationType' in h._data));
    Card.setField('cvipSubmittedDate', '2026-09-14');
    eq(h._data.cvipSubmittedDate, '2026-09-14', 'a date is stored');
    Card.setField('cvipSubmittedDate', '09/14/2026');
    ok('anything but YYYY-MM-DD is refused (clears, never guesses)', !('cvipSubmittedDate' in h._data));
    const n = h.saves.length;
    Card.setField('somethingElse', 'x');
    eq(h.saves.length, n, 'setField ignores keys outside its three fields');

    // referrals
    doc.els.idsRefDate = Object.assign(makeEl('idsRefDate'), { value: '' });
    Card.addReferral();
    ok('referral with no date → warned, not saved', h.toasts.some(t => /date the case was referred/.test(t[0])) && h.saves.length === n);
    doc.els.idsRefDate.value = '2026-09-03';
    doc.els.idsRefVenue = Object.assign(makeEl('idsRefVenue'), { value: 'federal' });
    doc.els.idsRefAgency = Object.assign(makeEl('idsRefAgency'), { value: 'HSI '.repeat(30) });
    Card.addReferral();
    eq(h._data.referrals.length, 1, 'referral added');
    eq(h._data.referrals[0].venue, 'federal', 'venue kept');
    ok('agency capped at 80 chars', h._data.referrals[0].agency.length === 80);
    doc.els.idsRefVenue.value = 'galactic';
    Card.addReferral();
    eq(h._data.referrals[1].venue, 'state', 'an unknown venue falls back to state');
    Card.removeReferral(0);
    eq(h._data.referrals.map(r => r.venue), ['state'], 'removeReferral removes the right row');
    Card.removeReferral(9);
    eq(h._data.referrals.length, 1, 'an out-of-range remove is a no-op');

    // victims
    doc.els.idsVicDate = Object.assign(makeEl('idsVicDate'), { value: '2026-09-05' });
    doc.els.idsVicCount = Object.assign(makeEl('idsVicCount'), { value: '0' });
    doc.els.idsVicKind = Object.assign(makeEl('idsVicKind'), { value: 'rescued' });
    Card.addVictim();
    eq(h._data.victims, [{ date: '2026-09-05', kind: 'rescued', count: 1 }], 'a count below 1 becomes 1');
    doc.els.idsVicKind.value = 'made-up';
    const before = h.saves.length;
    Card.addVictim();
    eq(h.saves.length, before, 'an unknown victim kind is refused');
    Card.removeVictim(0);
    eq(h._data.victims, [], 'removeVictim');

    // save failure
    h._saveOk = false;
    doc.els.icacCardHost._outer = null;
    Card.setField('investigationType', 'reactive');
    ok('a failed save is announced', h.toasts.some(t => t[1] === 'error' && /nothing was changed/.test(t[0])));
    eq(doc.els.icacCardHost.outerHTML, null, 'a failed save does not repaint');
    ok('…and the stored record is untouched', h._data.investigationType === undefined);
    delete globalThis.document;
}
{
    const h = cardHost({ case: { id: 'c1', caseNumber: 'A-1', icac: true },
        data: { referrals: [{ date: '2026-09-01', venue: 'state', agency: '<img src=x onerror=alert(1)>' }] } });
    const out = Card.html(h);
    ok('agency text is escaped', !out.includes('<img src=x') && out.includes('&lt;img'));
}

// ═════════════════════════════════════════════════════════════════════════
// [gatherStore]
console.log('[gatherStore]');
{
    const st = makeStorage({
        viperCases: JSON.stringify([null, { id: 'c1', caseNumber: 'A-1' }, { id: 'c2', caseNumber: 'B-2' }, 'junk']),
        'cyberTips_c1': JSON.stringify([{ id: 't1' }]),
        'suspects_c1': JSON.stringify([{ name: 'X' }]),
        'prosecution_c1': JSON.stringify({ submissions: [{ venue: 'state' }] }),
        'icac_c1': JSON.stringify({ investigationType: 'reactive' }),
        viperCaseWarrants: JSON.stringify({ 'A-1': [{ id: 'w1' }], 'B-2': 'not-an-array' }),
        viperCaseForensicDevices: JSON.stringify({ 'A-1': [{ id: 'd1' }] }),
        'suspects_c2': '{corrupt'
    });
    const cases = Dash.loadCases(getter(st));
    eq(cases.map(c => c.id), ['c1', 'c2'], 'loadCases drops null and non-object rows');
    const s = Dash.gatherStore(cases, getter(st));
    eq(s.c1.tips, [{ id: 't1' }], 'tips from cyberTips_<caseId>');
    eq(s.c1.suspects, [{ name: 'X' }], 'suspects from suspects_<caseId>');
    eq(s.c1.prosecution.submissions.length, 1, 'prosecution from prosecution_<caseId>');
    eq(s.c1.icac, { investigationType: 'reactive' }, 'card data from icac_<caseId>');
    eq(s.c1.warrants, [{ id: 'w1' }], 'warrants from viperCaseWarrants[caseNumber]');
    eq(s.c1.devices, [{ id: 'd1' }], 'devices from viperCaseForensicDevices[caseNumber]');
    eq(s.c2.warrants, [], 'a non-array warrants entry reads as none');
    eq(s.c2.suspects, [], 'a corrupt JSON value reads as the fallback, not a throw');
    eq(Dash.loadActivities(getter(makeStorage({ viperIdsActivities: '[null,{"id":"a"},3]' }))), [{ id: 'a' }], 'activities: junk rows dropped');
    ok('enabled() reads the exact string "true"', Dash.enabled(getter(makeStorage({ viperIdsEnabled: 'true' }))) === true &&
        Dash.enabled(getter(makeStorage({ viperIdsEnabled: '1' }))) === false && Dash.enabled(getter(makeStorage({}))) === false);
}

// ═════════════════════════════════════════════════════════════════════════
// [sanitizeActivity]
console.log('[sanitizeActivity]');
{
    const NOW = Date.parse('2026-10-01T12:00:00Z');
    ok('unknown kind refused', /Choose what kind/.test(Dash.sanitizeActivity({ kind: 'party', date: '2026-09-01' }, NOW).error));
    ok('bad date refused', /Enter the date/.test(Dash.sanitizeActivity({ kind: 'presentation', date: '09/01/2026' }, NOW).error));
    ok('impossible date refused', /Enter the date/.test(Dash.sanitizeActivity({ kind: 'presentation', date: '2026-02-31' }, NOW).error));
    let a = Dash.sanitizeActivity({ kind: 'presentation', date: '2026-09-01', count: '', people: '' }, NOW).activity;
    ok('blank count → count not stored (means 1)', a && !('count' in a) && !('people' in a));
    a = Dash.sanitizeActivity({ kind: 'presentation', date: '2026-09-01', count: '1' }, NOW).activity;
    ok('count of 1 is not stored either', !('count' in a));
    a = Dash.sanitizeActivity({ kind: 'presentation', date: '2026-09-01', count: '3', people: '120' }, NOW).activity;
    eq([a.count, a.people], [3, 120], 'presentation keeps count and attendees');
    ok('a count of 0 is refused', /whole number of 1 or more/.test(Dash.sanitizeActivity({ kind: 'outreach', date: '2026-09-01', count: '0' }, NOW).error));
    ok('a fractional count is refused', !!Dash.sanitizeActivity({ kind: 'outreach', date: '2026-09-01', count: '2.5' }, NOW).error);
    ok('people-only kind with no people is refused', /how many people/.test(Dash.sanitizeActivity({ kind: 'trained-le', date: '2026-09-01' }, NOW).error));
    a = Dash.sanitizeActivity({ kind: 'trained-le', date: '2026-09-01', count: '9', people: '4' }, NOW).activity;
    ok('people-only kind stores people and ignores count', a.people === 4 && !('count' in a));
    a = Dash.sanitizeActivity({ kind: 'outreach', date: '2026-09-01', people: '50' }, NOW).activity;
    ok('count-only kind does not store people', !('people' in a));
    a = Dash.sanitizeActivity({ kind: 'outreach', date: '2026-09-01', notes: 'x'.repeat(500) }, NOW).activity;
    eq(a.notes.length, 200, 'notes capped at 200');
    ok('id minted with the ida_ prefix', /^ida_/.test(a.id));
    eq(a.createdAt, '2026-10-01T12:00:00.000Z', 'createdAt stamped from now');
}

// ═════════════════════════════════════════════════════════════════════════
// [activity log actions] — through real localStorage on the global
console.log('[activity log actions]');
{
    const st = makeStorage({ viperIdsEnabled: 'true' });
    const doc = makeDoc();
    const toasts = [];
    globalThis.localStorage = st; globalThis.document = doc;
    globalThis.viperToast = (m, k) => toasts.push([m, k]);
    Dash.openLog();
    const modal = doc.body.children.find(c => c.id === 'idsActivityLogModal');
    ok('openLog mounts the modal', !!modal && modal.innerHTML.includes('id="idsActKind"'));
    ok('the empty log says so', modal.innerHTML.includes('Nothing logged yet.'));
    // form values
    for (const [id, v] of [['idsActDate', '2026-09-10'], ['idsActKind', 'presentation'], ['idsActCount', '2'], ['idsActPeople', '80'], ['idsActNotes', 'Lincoln MS']]) {
        doc.els[id] = Object.assign(makeEl(id), { value: v });
    }
    ok('addActivity succeeds', Dash.addActivity() === true);
    const saved = JSON.parse(st.getItem('viperIdsActivities'));
    eq(saved.map(a => [a.kind, a.count, a.people, a.notes]), [['presentation', 2, 80, 'Lincoln MS']], 'stored under viperIdsActivities');
    ok('success toast', toasts.some(t => t[1] === 'success'));
    st.failWrites = true;
    ok('a failed write returns false', Dash.addActivity() === false);
    ok('…and says nothing was added', toasts.some(t => t[1] === 'error' && /nothing was added/.test(t[0])));
    eq(JSON.parse(st.getItem('viperIdsActivities')).length, 1, '…and nothing was');
    st.failWrites = false;
    globalThis.confirm = () => false;
    ok('remove cancelled at the confirm → nothing removed', Dash.removeActivity(saved[0].id) === false && JSON.parse(st.getItem('viperIdsActivities')).length === 1);
    globalThis.confirm = () => true;
    ok('remove confirmed', Dash.removeActivity(saved[0].id) === true && JSON.parse(st.getItem('viperIdsActivities')).length === 0);
    ok('removing an unknown id is a no-op', Dash.removeActivity('nope') === false);

    // refresh()
    const panel = makeEl('idsDashboardPanel'); panel.classList.add('hidden'); doc.els.idsDashboardPanel = panel;
    Dash.refresh();
    ok('refresh shows the panel when the switch is on', !panel.classList.contains('hidden'));
    st.setItem('viperIdsEnabled', 'false');
    Dash.refresh();
    ok('…and hides it when off', panel.classList.contains('hidden'));
    delete globalThis.localStorage; delete globalThis.document; delete globalThis.viperToast; delete globalThis.confirm;
}
{
    const html = Dash.logHtml([
        { id: 'a1', date: '2026-08-30', kind: 'presentation', count: 2, people: 1 },
        { id: 'a2', date: '2026-09-02', kind: 'trained-le', people: 6, notes: '<b>x</b>' }
    ], Date.parse('2026-09-15T12:00:00'));
    ok('log lists newest month first', html.indexOf('September 2026') < html.indexOf('August 2026') && html.indexOf('September 2026') > -1);
    ok('singular person', html.includes('1 person'));
    ok('notes escaped', html.includes('&lt;b&gt;x&lt;/b&gt;'));
    ok('the date field defaults to today', html.includes('value="2026-09-15"'));
}

// ═════════════════════════════════════════════════════════════════════════
// Shared fixture for build / report / PDF
const SEP = I.monthPeriod(2026, 9);
function fixtureStorage() {
    return makeStorage({
        viperIdsEnabled: 'true',
        viperCases: JSON.stringify([
            { id: 'c1', caseNumber: 'ICAC-26-001', cybertipNumber: '99887766', createdAt: '2026-09-04T10:00:00' },
            { id: 'c2', caseNumber: 'GEN-26-050', createdAt: '2026-09-04T10:00:00' }
        ]),
        'suspects_c1': JSON.stringify([{ name: 'Doe', arrested: true, arrestDate: '2026-09-20', handsOnOffender: true }]),
        'suspects_c2': JSON.stringify([{ name: 'Roe', arrested: true, arrestDate: '2026-09-21' }]),
        viperCaseWarrants: JSON.stringify({ 'ICAC-26-001': [{ id: 'w1', type: 'search', courtLevel: 'federal', signedDate: '2026-09-11', dateSigned: '2026-09-11' }] }),
        viperIdsActivities: JSON.stringify([{ id: 'a', date: '2026-09-10', kind: 'presentation', count: 2, people: 80 }])
    });
}

console.log('[buildFor]');
{
    const st = fixtureStorage();
    const res = Dash.buildFor(SEP, getter(st));
    eq(res.icacCases.length, 1, 'only the tip case is ICAC');
    eq(rowOf(res, 'arrests').count, 1, 'an arrest on a non-ICAC case is not counted');
    eq(rowOf(res, 'arrestsHandsOn').count, 1, 'hands-on offender counted');
    eq(rowOf(res, 'presentations').count, 2, 'activity log feeds presentations');
    eq(rowOf(res, 'presentationAttendees').count, 80, '…and attendees');
}

console.log('[reportHtml]');
{
    const res = Dash.buildFor(SEP, getter(fixtureStorage()));
    const html = Dash.reportHtml(res);
    ok('month picker carries the period key', html.includes('value="2026-09"'));
    ok('one ICAC case, singular', html.includes('1 ICAC case on file'));
    ok('rows carry their keys', html.includes('data-key="arrests"'));
    ok('detail disclosure present', html.includes('What makes this up'));
    ok('no result → plain message, no throw', /did not load/.test(Dash.reportHtml(null)));
}

// ═════════════════════════════════════════════════════════════════════════
// [pdfText]
console.log('[pdfText]');
eq(Dash.pdfText('A — B · C × D'), 'A - B - C x D', 'em dash, middot, times folded');
eq(Dash.pdfText('\u2018q\u2019 \u201Cqq\u201D wait\u2026'), "'q' \"qq\" wait...", 'curly quotes and ellipsis folded');
eq(Dash.pdfText('Café ✕ 😀'), 'Café  ', 'Latin-1 kept, anything else dropped');
eq(Dash.pdfText(null), '', 'null → empty');
eq(Dash.pdfText(7), '7', 'numbers stringified');

// ═════════════════════════════════════════════════════════════════════════
// [buildPdf] with a recording fake jsPDF
console.log('[buildPdf]');
function FakePdf() {
    this.texts = []; this.tables = []; this.pages = 1; this.page = 1;
    this.lastAutoTable = { finalY: 40 };
    this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
}
FakePdf.prototype.text = function (s) { this.texts.push(s); };
FakePdf.prototype.autoTable = function (o) { this.tables.push(o); this.lastAutoTable = { finalY: (o.startY || 0) + 10 }; };
FakePdf.prototype.setFont = function () {};
FakePdf.prototype.setFontSize = function () {};
FakePdf.prototype.setTextColor = function () {};
FakePdf.prototype.addPage = function () { this.pages++; this.page = this.pages; };
FakePdf.prototype.getNumberOfPages = function () { return this.pages; };
FakePdf.prototype.setPage = function (i) { this.page = i; };
{
    const st = fixtureStorage();
    const res = Dash.buildFor(SEP, getter(st));
    const meta = Dash.officerMeta(getter(makeStorage({
        viper_customer_name: 'Det. O\u2019Neil', viperAgencyProfile: JSON.stringify({ agencyName: 'Metro PD', affiantBadge: '4411' })
    })));
    eq(meta, { officer: 'Det. O\u2019Neil', badge: '4411', agency: 'Metro PD' }, 'officerMeta falls through to the agency profile');
    const d = Dash.buildPdf(res, meta, FakePdf, Date.parse('2026-10-02T09:00:00'));
    const all = d.texts.join('\n') + '\n' + JSON.stringify(d.tables.map(t => [t.head, t.body]));
    ok('title drawn', d.texts.some(t => t === 'ICAC Data System (IDS) - Monthly Measures'));
    ok('reporting month drawn', d.texts.includes('Reporting month: September 2026'));
    ok('officer name folded to ASCII apostrophe', d.texts.some(t => t.includes("Det. O'Neil") && t.includes('Badge #4411')));
    ok('agency drawn', d.texts.includes('Agency: Metro PD'));
    ok('NOTHING outside Latin-1 reaches the PDF', !/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/.test(all));
    eq(d.tables.length >= res.sections.length + 1, true, 'one table per section plus the appendix');
    const firstSec = d.tables[0];
    eq(firstSec.head[0][1], 'Count', 'section table has a Count column');
    ok('section counts are strings', firstSec.body.every(r => typeof r[1] === 'string'));
    const appx = d.tables.find(t => t.head[0][0] === 'Measure');
    ok('appendix table exists', !!appx);
    ok('appendix names the case behind the arrest', appx.body.some(r => r[1] === 'ICAC-26-001'));
    ok('appendix is on page 2', d.pages >= 2);
    ok('a footer per page', d.texts.filter(t => /^IDS Monthly Measures - September 2026 - page \d+ of \d+$/.test(t)).length === d.pages);
    eq(Dash.pdfFileName(res), 'IDS_Measures_2026-09.pdf', 'file name');
}
{
    // Empty month: the appendix says so instead of drawing an empty table.
    const res = Dash.buildFor(I.monthPeriod(2025, 1), getter(fixtureStorage()));
    const d = Dash.buildPdf(res, {}, FakePdf, 0);
    const appx = d.tables.find(t => t.head[0][0] === 'Measure');
    eq(appx.body, [['Nothing was counted this month.', '', '']], 'empty month → one explanatory appendix row');
    ok('no agency/officer lines when unknown', !d.texts.some(t => /^Agency:|^Prepared by:/.test(t)));
}
{
    // downloadPdf: no result yet / no library
    const toasts = [];
    globalThis.viperToast = (m, k) => toasts.push([m, k]);
    ok('downloadPdf before any report → false', Dash.downloadPdf() === false && toasts.some(t => /Nothing to export/.test(t[0])));
    delete globalThis.viperToast;
}

// ═════════════════════════════════════════════════════════════════════════
// Lifting helpers
function readCrlf(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); }
function sliceBraced(src, startIdx) {
    const open = src.indexOf('{', startIdx);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
    }
    throw new Error('unbalanced from ' + startIdx);
}
function liftFn(src, name) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing function ' + name);
    return sliceBraced(src, i);
}
function liftHandler(src, formId) {
    const anchor = "document.getElementById('" + formId + "').onsubmit = (e) => ";
    const i = src.indexOf(anchor);
    if (i < 0) throw new Error('missing handler ' + formId);
    return sliceBraced(src, i + anchor.length);
}

const CASE_HTML = readCrlf('case-detail-with-analytics.html');
const INDEX_HTML = readCrlf('index.html');

function makeFormData(fields) {
    return class FD {
        constructor() { this._f = fields; }
        get(k) { return Object.prototype.hasOwnProperty.call(this._f, k) ? this._f[k] : null; }
    };
}
function runSuspectSubmit(body, existing, fields, present) {
    const env = {
        FormData: makeFormData(fields),
        isEdit: true, editIndex: 0,
        suspect: existing[0], suspects: existing.slice(),
        collectSuspectIdentifiers: () => (existing[0].identifiers || []),
        saveSuspects() { env.saved = env.suspects.slice(); },
        modal: { remove() {} }, renderTabContent() {}
    };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext('var __h = (e) => ' + body + ';', env);
    env.__h({ preventDefault() {}, target: { elements: { namedItem: (n) => (present.indexOf(n) >= 0 ? {} : null) } } });
    return env;
}
function runVictimSubmit(body, existing, fields) {
    const env = {
        FormData: makeFormData(fields),
        isEdit: true, editIndex: 0,
        victim: existing[0], victims: existing.slice(),
        saveVictims() { env.saved = env.victims.slice(); },
        modal: { remove() {} }, renderTabContent() {}
    };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext('var __h = (e) => ' + body + ';', env);
    env.__h({ preventDefault() {}, target: { elements: { namedItem: () => null } } });
    return env;
}

// ═════════════════════════════════════════════════════════════════════════
// [edit keeps noteUid] — lifted from case-detail-with-analytics.html
console.log('[edit keeps noteUid]');
const SUSPECT_BODY = liftHandler(CASE_HTML, 'suspectForm');
const VICTIM_BODY = liftHandler(CASE_HTML, 'victimForm');
const OLD_SUSPECT_LINE = 'suspects[editIndex] = suspectData;';
const OLD_VICTIM_LINE = 'victims[editIndex] = victimData;';
const NEW_SUSPECT_LINE = 'suspects[editIndex] = Object.assign({}, suspects[editIndex], suspectData);';
const NEW_VICTIM_LINE = 'victims[editIndex] = Object.assign({}, victims[editIndex], victimData);';
ok('suspect handler carries the merge line', SUSPECT_BODY.includes(NEW_SUSPECT_LINE));
ok('victim handler carries the merge line', VICTIM_BODY.includes(NEW_VICTIM_LINE));
{
    const existing = [{ name: 'Doe', noteUid: 'pn_abc', osint: { hits: 3 }, firearms: [], vehicles: [], identifiers: [{ t: 'ip' }] }];
    const fields = { name: 'Doe, John', arrested: 'on', arrestDate: '2026-09-20' };
    const env = runSuspectSubmit(SUSPECT_BODY, existing, fields, []);
    const s = env.saved[0];
    eq(s.noteUid, 'pn_abc', 'suspect edit keeps its Case Notes link (noteUid)');
    eq(s.osint, { hits: 3 }, 'suspect edit keeps fields the form never shows');
    eq(s.name, 'Doe, John', 'suspect edit still applies the new values');
    eq([s.arrested, s.arrestDate], [true, '2026-09-20'], 'arrest + date recorded from the form');
    ok('IDS switch off → handsOnOffender left alone (absent element)', !('handsOnOffender' in s));

    const env2 = runSuspectSubmit(SUSPECT_BODY, [Object.assign({}, existing[0], { handsOnOffender: true, arrested: true, arrestDate: '2026-09-20' })],
        { name: 'Doe' }, ['handsOnOffender']);
    const s2 = env2.saved[0];
    eq([s2.arrested, s2.arrestDate, s2.handsOnOffender], [false, '', false], 'unticking arrest clears its date; a present hands-on box is honoured');
    const env3 = runSuspectSubmit(SUSPECT_BODY, [Object.assign({}, existing[0], { handsOnOffender: true })], { name: 'Doe' }, []);
    eq(env3.saved[0].handsOnOffender, true, 'switch off → an earlier hands-on answer survives the edit');

    // CONTROL: re-apply the old replace-on-edit line → the link is lost.
    const oldBody = SUSPECT_BODY.replace(NEW_SUSPECT_LINE, OLD_SUSPECT_LINE);
    ok('control: old line substituted', oldBody !== SUSPECT_BODY);
    const envOld = runSuspectSubmit(oldBody, existing, fields, []);
    eq(envOld.saved[0].noteUid, undefined, 'control: the OLD code drops noteUid — this test catches the bug');
}
{
    const existing = [{ name: 'Vic', noteUid: 'pn_v1', identifiers: [{ t: 'snap' }], injuryPhotos: [], propertyPhotos: [], vehicles: [] }];
    const env = runVictimSubmit(VICTIM_BODY, existing, { name: 'Vic A' });
    eq(env.saved[0].noteUid, 'pn_v1', 'victim edit keeps noteUid');
    eq(env.saved[0].identifiers, [{ t: 'snap' }], 'victim edit keeps identifiers (the form never shows them)');
    eq(env.saved[0].name, 'Vic A', 'victim edit applies the new name');
    const envOld = runVictimSubmit(VICTIM_BODY.replace(NEW_VICTIM_LINE, OLD_VICTIM_LINE), existing, { name: 'Vic A' });
    ok('control: the OLD victim code drops noteUid and identifiers', envOld.saved[0].noteUid === undefined && envOld.saved[0].identifiers === undefined);
}

// ═════════════════════════════════════════════════════════════════════════
// [arrest reaches the dashboard and IDS] — suspect form → localStorage →
// index.html's getMonthlyArrests / getTotalArrests AND IdsMeasures.
console.log('[arrest reaches the dashboard and IDS]');
{
    const fnNames = ['_isAssistCase', '_statCases', '_setMetricPeriod', '_inThisMonth', '_itemDate', 'getTotalArrests', 'getMonthlyArrests'];
    const lifted = 'var _metricPeriod = null;\n' + fnNames.map(n => liftFn(INDEX_HTML, n)).join('\n');
    // The suspect save, writing where the real saveSuspects writes.
    const existing = [{ name: 'Doe', noteUid: 'pn_abc', firearms: [], vehicles: [] }];
    const env = runSuspectSubmit(SUSPECT_BODY, existing, { name: 'Doe', arrested: 'on', arrestDate: '2026-09-01' }, []);
    const st = makeStorage({
        viperCases: JSON.stringify([{ id: 'c1', caseNumber: 'ICAC-26-001', cybertipNumber: '1', createdAt: '2026-06-01T10:00:00', status: 'open' }]),
        'suspects_c1': JSON.stringify(env.saved)
    });
    const denv = { localStorage: st, JSON, Date, Set, Math, String, isNaN };
    denv.globalThis = denv;
    vm.createContext(denv);
    vm.runInContext(lifted + '\n;Object.assign(globalThis, { _setMetricPeriod, getMonthlyArrests, getTotalArrests });', denv);
    denv._setMetricPeriod({ start: new Date(2026, 8, 1), end: new Date(2026, 9, 1), label: 'September 2026' });
    eq(denv.getMonthlyArrests(), 1, 'dashboard: an arrest dated the 1st lands in that month (local midnight)');
    denv._setMetricPeriod({ start: new Date(2026, 7, 1), end: new Date(2026, 8, 1), label: 'August 2026' });
    eq(denv.getMonthlyArrests(), 0, '…and not in the month before');
    eq(denv.getTotalArrests(), 1, 'dashboard: total arrests');
    const res = Dash.buildFor(SEP, getter(st));
    eq(rowOf(res, 'arrests').count, 1, 'IDS: the same arrest counts in September');
    eq(rowOf(Dash.buildFor(I.monthPeriod(2026, 8), getter(st)), 'arrests').count, 0, 'IDS: and not in August');
}

// ═════════════════════════════════════════════════════════════════════════
// [field names] — the builder reads what the case page's forms actually
// write. A rename on either side would read as a silent zero.
console.log('[field names]');
{
    const fx = CASE_HTML.slice(CASE_HTML.indexOf("acquisitionDate: v('fxAcqDate')") - 400, CASE_HTML.indexOf('if (onSceneEl) payload.onScene') + 60);
    for (const f of ["acquisitionDate: v('fxAcqDate')", "deviceCategory: v('fxCategory')", "makeModel: v('fxMakeModel')", "storageSize: v('fxStorage')", 'payload.onScene = !!onSceneEl.checked']) {
        ok('Devices form writes ' + f.split(':')[0].split(' =')[0], fx.includes(f));
    }
    const catBlock = CASE_HTML.slice(CASE_HTML.indexOf('const FORENSIC_CATEGORIES = ['), CASE_HTML.indexOf('const FORENSIC_EXTRACTIONS'));
    for (const v of ['phone', 'computer', 'tablet', 'drive']) ok('Devices category "' + v + '" exists on the form', catBlock.includes("value: '" + v + "'"));
    ok('Warrants form writes dateSigned', CASE_HTML.includes('dateSigned: dateSigned,'));
    ok('Warrants form writes courtLevel on edit and on create', CASE_HTML.includes('if (courtLevel !== undefined) warrant.courtLevel = courtLevel;') &&
        CASE_HTML.includes('if (courtLevel !== undefined) newWarrant.courtLevel = courtLevel;'));
    // And the builder buckets those form categories.
    const st = makeStorage({
        viperCases: JSON.stringify([{ id: 'c1', caseNumber: 'K-1', icac: true, createdAt: '2026-01-01T00:00:00' }]),
        viperCaseForensicDevices: JSON.stringify({ 'K-1': [
            { deviceCategory: 'phone', makeModel: 'iPhone 13', acquisitionDate: '2026-09-20', storageSize: '128 GB', onScene: true },
            { deviceCategory: 'computer', makeModel: 'Dell', acquisitionDate: '2026-09-21', storageSize: '1 TB' },
            { deviceCategory: 'drive', makeModel: 'WD', acquisitionDate: '2026-09-22', storageSize: '2 TB' },
            { deviceCategory: 'gps', makeModel: 'Garmin', acquisitionDate: '2026-09-23', storageSize: '8 GB' }
        ] })
    });
    const r = Dash.buildFor(SEP, getter(st));
    eq([rowOf(r, 'onScene').count, rowOf(r, 'examMobile').count, rowOf(r, 'examComputer').count, rowOf(r, 'examStorage').count],
        [1, 1, 1, 1], 'phone / computer / drive land in their IDS buckets; on-scene counted');
    ok('a GPS unit is reported as not counted, never guessed into a bucket', r.notCounted.some(n => /Garmin/.test(n.text) && /no IDS category/.test(n.reason)));
}

// ═════════════════════════════════════════════════════════════════════════
// [wiring] — the pages actually load and mount it
console.log('[wiring]');
ok('index.html loads ids-measures.js', INDEX_HTML.includes('<script src="modules/ids-measures/ids-measures.js"></script>'));
ok('index.html loads ids-dashboard.js', INDEX_HTML.includes('<script src="modules/ids-measures/ids-dashboard.js"></script>'));
ok('index.html has the hidden panel', INDEX_HTML.includes('<div id="idsDashboardPanel" class="hidden'));
ok('panel buttons call the module', INDEX_HTML.includes('onclick="IdsDashboard.openLog()"') && INDEX_HTML.includes('onclick="IdsDashboard.openMeasures()"'));
ok('case page loads ids-case-card.js', CASE_HTML.includes('<script src="modules/ids-measures/ids-case-card.js"></script>'));
ok('case page renders the card in the overview', CASE_HTML.includes('${renderIdsCaseCardInline()}'));
ok('case-stores carries the icac_ prefix (backups/snapshots)', /['"]icac['"]/.test(readCrlf('modules/_shared/case-stores.js')));

console.log('\n' + pass + ' passed · ' + fail + ' failed');
process.exit(fail ? 1 : 0);
