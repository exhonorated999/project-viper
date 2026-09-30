/**
 * Optional times on the warrant dates.
 *
 * An officer can now record the time a warrant was signed, served, or its
 * court return filed. The time is optional everywhere; a warrant saved
 * before this existed, or saved without a time, must behave exactly as it
 * always did.
 *
 * The logic lives inline in case-detail-with-analytics.html, so this test
 * LIFTS the shipping helpers and the timeline bridge out of the page rather
 * than copying them. A copied block is the thing that drifts.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\__tests__\warrant-time.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', '..', 'case-detail-with-analytics.html');
// The page is CRLF on disk. Normalise so multi-line anchors do not silently
// miss.
const SRC = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

const SUPLINK = fs.readFileSync(
    path.join(__dirname, '..', 'supervisor-link', 'supervisor-link-ui.js'), 'utf8'
).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function eq(label, got, want) {
    check(label, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- lift

function lift(start, end, what) {
    const a = SRC.indexOf(start);
    const b = SRC.indexOf(end, a + 1);
    if (a < 0 || b < 0 || b <= a) {
        console.error('Could not locate ' + what + ' in the page. Anchors moved?');
        process.exit(1);
    }
    return SRC.slice(a, b);
}

const HELPERS = lift(
    'function _warrantTimeOk(hhmm) {',
    '/* Show or hide the warrant-only fields',
    'the warrant time helpers'
);

// The timeline's warrant arm, taken whole.
const TL_WARRANTS = lift(
    '// --- Warrants ---\n            const allWarrants',
    '// --- RMS Imports ---',
    'the timeline warrant bridge'
);

// A fake document good enough for _warrantReadTime, which is the only
// helper that touches the DOM.
const inputs = {};
const store = {};
const sandbox = {
    console, Date, Math, JSON, isNaN, parseInt, String, RegExp,
    document: { getElementById: (id) => (id in inputs ? inputs[id] : null) },
    // host state the timeline arm reads
    currentCase: { caseNumber: '25-77777', id: 'case-7' },
    // `_lsParse` is called as a bare identifier inside the lifted block, so
    // it must not depend on `this`.
    _lsParse: (key, fallback) => ((key in store) ? store[key] : fallback)
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

// Wrap the timeline arm so the test can drive it. `auto` and `now` are the
// two locals the real function supplies around it.
const TL_WRAPPED =
    'function _runTimelineWarrants() {\n' +
    '    const auto = [];\n' +
    '    const now = "2026-01-01T00:00:00.000Z";\n' +
    TL_WARRANTS +
    '\n    return auto;\n}\n';

vm.runInContext(HELPERS + '\n' + TL_WRAPPED, sandbox);

/** Local wall-clock readback of an ISO instant. */
function localParts(iso) {
    const d = new Date(iso);
    return { h: d.getHours(), m: d.getMinutes(), day: d.getDate(), mon: d.getMonth() + 1 };
}

// =====================================================================
section('what counts as a time');

eq('midnight is a time', sandbox._warrantTimeOk('00:00'), true);
eq('one minute to midnight is a time', sandbox._warrantTimeOk('23:59'), true);
eq('an empty string is not', sandbox._warrantTimeOk(''), false);
eq('null is not', sandbox._warrantTimeOk(null), false);
eq('undefined is not', sandbox._warrantTimeOk(undefined), false);
eq('a 24th hour is not', sandbox._warrantTimeOk('24:00'), false);
eq('a 60th minute is not', sandbox._warrantTimeOk('12:60'), false);
eq('an unpadded hour is not', sandbox._warrantTimeOk('7:30'), false);
eq('seconds are not accepted', sandbox._warrantTimeOk('07:30:00'), false);
eq('prose is not a time', sandbox._warrantTimeOk('morning'), false);
eq('surrounding space is tolerated', sandbox._warrantTimeOk('  07:30 '), true);

// =====================================================================
section('how a time reads on the card');

eq('midnight reads as 12 AM', sandbox._warrantTimeLabel('00:00'), '12:00 AM');
eq('noon reads as 12 PM', sandbox._warrantTimeLabel('12:00'), '12:00 PM');
eq('morning', sandbox._warrantTimeLabel('07:05'), '7:05 AM');
eq('afternoon', sandbox._warrantTimeLabel('13:05'), '1:05 PM');
eq('late evening', sandbox._warrantTimeLabel('23:59'), '11:59 PM');
eq('the 2:10 AM signing the feature was asked for', sandbox._warrantTimeLabel('02:10'), '2:10 AM');
eq('no time recorded renders nothing', sandbox._warrantTimeLabel(''), '');
eq('a legacy warrant with no field at all renders nothing', sandbox._warrantTimeLabel(undefined), '');
eq('a value that is not a time renders nothing', sandbox._warrantTimeLabel('7:30'), '');
check('display and storage agree on what a time is',
    ['00:00', '23:59', '7:30', '24:00', '', 'x'].every(
        v => (sandbox._warrantTimeLabel(v) !== '') === sandbox._warrantTimeOk(v)));

// =====================================================================
section('reading the form');

inputs.warrantTimeSigned = { value: '02:10' };
eq('a time beside a date is kept',
    sandbox._warrantReadTime('warrantTimeSigned', '2026-03-04'), '02:10');
eq('a time with NO date is dropped',
    sandbox._warrantReadTime('warrantTimeSigned', ''), '');
inputs.warrantTimeSigned = { value: '' };
eq('a blank time is blank', sandbox._warrantReadTime('warrantTimeSigned', '2026-03-04'), '');
inputs.warrantTimeSigned = { value: 'garbage' };
eq('an unparseable time is dropped, not stored',
    sandbox._warrantReadTime('warrantTimeSigned', '2026-03-04'), '');
eq('a missing input is not an error',
    sandbox._warrantReadTime('warrantTimeNotThere', '2026-03-04'), '');

// =====================================================================
section('the timeline instant');

eq('no date is no event', sandbox._warrantEventIso('', '09:00'), null);
eq('a nonsense date is no event', sandbox._warrantEventIso('not-a-date', '09:00'), null);

const midnight = localParts(sandbox._warrantEventIso('2026-03-04', ''));
eq('no time still lands at local midnight, as it always did', midnight.h, 0);
eq('...on the day entered, not the day before', midnight.day, 4);
eq('...in the month entered', midnight.mon, 3);

const signed = localParts(sandbox._warrantEventIso('2026-03-04', '02:10'));
eq('a recorded time lands on that hour', signed.h, 2);
eq('...and that minute', signed.m, 10);
eq('...still on the day entered', signed.day, 4);

const evening = localParts(sandbox._warrantEventIso('2026-03-04', '23:30'));
eq('a late-evening time does not roll into the next day', evening.day, 4);
eq('...and keeps its hour', evening.h, 23);

const junk = localParts(sandbox._warrantEventIso('2026-03-04', '99:99'));
eq('an impossible time falls back to midnight rather than throwing', junk.h, 0);

// =====================================================================
section('the timeline bridge, lifted from the page');

store['viperCaseWarrants'] = {
    '25-77777': [
        {
            id: 1, type: 'Search Warrant', issuedTo: 'Google', description: 'Account records',
            dateSigned: '2026-03-04', timeSigned: '02:10',
            dateServed: '2026-03-04', timeServed: '06:45',
            courtReturnDate: '2026-03-10', timeCourtReturn: '14:00'
        },
        {
            // A warrant saved before times existed.
            id: 2, type: 'Search Warrant', issuedTo: 'Meta', description: 'Legacy',
            dateSigned: '2026-03-04', dateServed: '', courtReturnDate: ''
        }
    ]
};
const ev = sandbox._runTimelineWarrants();
eq('four events from two warrants', ev.length, 4);

const bySrc = {};
ev.forEach(e => { bySrc[e.id] = e; });
check('the signed event exists', !!bySrc['tl_auto_warrant_signed_1']);
check('the served event exists', !!bySrc['tl_auto_warrant_served_1']);
check('the court-return event exists', !!bySrc['tl_auto_warrant_return_1']);
check('the legacy warrant still produces its signed event', !!bySrc['tl_auto_warrant_signed_2']);

eq('signed lands at 02:10', localParts(bySrc['tl_auto_warrant_signed_1'].timestamp).h, 2);
eq('served lands at 06:45 the same morning',
    localParts(bySrc['tl_auto_warrant_served_1'].timestamp).h, 6);
eq('...to the minute', localParts(bySrc['tl_auto_warrant_served_1'].timestamp).m, 45);
eq('the court return lands at 14:00',
    localParts(bySrc['tl_auto_warrant_return_1'].timestamp).h, 14);
eq('the legacy warrant still lands at midnight',
    localParts(bySrc['tl_auto_warrant_signed_2'].timestamp).h, 0);

check('signed sorts before served on the same day',
    new Date(bySrc['tl_auto_warrant_signed_1'].timestamp).getTime()
    < new Date(bySrc['tl_auto_warrant_served_1'].timestamp).getTime());
check('the legacy midnight signing sorts before the 02:10 one',
    new Date(bySrc['tl_auto_warrant_signed_2'].timestamp).getTime()
    < new Date(bySrc['tl_auto_warrant_signed_1'].timestamp).getTime());

check('the event shape is otherwise untouched — lane',
    bySrc['tl_auto_warrant_signed_1'].lane === 'investigation');
check('...category', bySrc['tl_auto_warrant_signed_1'].category === 'warrant');
check('...significance', bySrc['tl_auto_warrant_signed_1'].significance === 'major');
check('...sourceType', bySrc['tl_auto_warrant_signed_1'].sourceType === 'auto:warrant');
check('...and the court return is still supporting, not major',
    bySrc['tl_auto_warrant_return_1'].significance === 'supporting');

// A case with no warrants at all must not throw.
store['viperCaseWarrants'] = {};
eq('a case with no warrants yields no events', sandbox._runTimelineWarrants().length, 0);

// =====================================================================
section('the form, as it ships');

function has(re, label) { check(label, re.test(SRC)); }

has(/<input type="time" id="warrantTimeSigned"/, 'there is a time box beside Date Signed');
has(/<input type="time" id="warrantTimeServed"/, 'there is a time box beside Date Served');
has(/<input type="time" id="warrantTimeCourtReturn"/, 'there is a time box beside Court Return');
check('the production due date stays date-only — the overdue count is in whole days',
    !/id="warrantTimeDueDate"/.test(SRC));

check('none of the three time boxes is required',
    !/<input type="time" id="warrantTime[A-Za-z]+"[^>]*\srequired/.test(SRC));

check('each time box is labelled for a screen reader',
    (SRC.match(/<input type="time" id="warrantTime[A-Za-z]+" aria-label="/g) || []).length === 3);

check('the officer is told the time is optional',
    (SRC.match(/· time optional/g) || []).length === 3);

// Preservation requests: no judge, no signing, no court return — so no times
// for those either.
check('a preservation request clears the signing time with the signing date',
    /const timeSigned = isPres \? '' :/.test(SRC));
check('...and the court-return time with the court-return date',
    /const timeCourtReturn = isPres \? '' :/.test(SRC));
check('...but keeps the time it was sent to the provider',
    /const timeServed = _warrantReadTime\('warrantTimeServed', dateServed\);/.test(SRC));

check('a new warrant record carries all three time fields',
    /timeSigned: timeSigned,\s*\n\s*timeServed: timeServed,\s*\n\s*timeCourtReturn: timeCourtReturn,/.test(SRC));
check('an edited warrant writes all three back',
    /warrant\.timeSigned = timeSigned;\s*\n\s*warrant\.timeServed = timeServed;\s*\n\s*warrant\.timeCourtReturn = timeCourtReturn;/.test(SRC));

check('opening a blank form clears every time box',
    /warrantTimeSigned'\)\.value = '';/.test(SRC)
    && /warrantTimeServed'\)\.value = '';/.test(SRC)
    && /warrantTimeCourtReturn'\)\.value = '';/.test(SRC));
check('editing a warrant repopulates every time box',
    /warrantTimeSigned'\)\.value = warrant\.timeSigned \|\| '';/.test(SRC)
    && /warrantTimeServed'\)\.value = warrant\.timeServed \|\| '';/.test(SRC)
    && /warrantTimeCourtReturn'\)\.value = warrant\.timeCourtReturn \|\| '';/.test(SRC));

check('the served label is still swapped for a preservation request',
    /<span id="warrantDateServedLabel">Date Served<\/span>/.test(SRC)
    && /served\.textContent = isPres \? 'Date Sent to Provider' : 'Date Served';/.test(SRC));

// =====================================================================
section('the times reach the other two readers');

check('the case report prints the signing time when there is one',
    /_warrantTimeLabel\(w\.timeSigned\)/.test(SRC));
check('...and the serving time', /_warrantTimeLabel\(w\.timeServed\)/.test(SRC));
check('...and the court-return time', /_warrantTimeLabel\(w\.timeCourtReturn\)/.test(SRC));

check('the supervisor roll-up carries the signing time',
    /w\.dateSigned \+ _at\(w\.timeSigned\)/.test(SUPLINK));
check('...the serving time', /w\.dateServed \+ _at\(w\.timeServed\)/.test(SUPLINK));
check('...and the court-return time',
    /w\.courtReturnDate \+ _at\(w\.timeCourtReturn\)/.test(SUPLINK));
check('the supervisor roll-up still falls back to midnight',
    /'T00:00:00'\)/.test(SUPLINK));

// The bare 'YYYY-MM-DD' contract the rest of the module depends on.
check('the due date is never widened into a datetime',
    !/dueDate \+ 'T(?!00:00:00)/.test(SRC));

// =====================================================================
console.log('\n' + (fail === 0 ? 'OK' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
