/*
 * IDS Measures — monthly ICAC Data System counts.
 *
 * Run: node modules\ids-measures\__tests__\ids-measures.test.js
 * (pure module, no native deps)
 *
 * WHY THIS EXISTS
 *
 * These numbers go to the federal government under the officer's name. A
 * wrong count here is not a cosmetic bug — it is a misstatement on a grant
 * report. So every rule the builder applies is pinned:
 *
 *   - only ICAC cases count, and an officer's explicit untick beats a
 *     CyberTip;
 *   - assists are left out of "investigations opened" but their work
 *     product (warrants, exams, arrests) counts;
 *   - month edges are the officer's LOCAL month — a 'YYYY-MM-DD' on the 1st
 *     must not fall into the previous month;
 *   - anything the builder cannot place is REPORTED, never guessed.
 */
const path = require('path');
const I = require(path.join(__dirname, '..', 'ids-measures.js'));

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
function count(res, key) { return rowOf(res, key).count; }

const SEP = I.monthPeriod(2026, 9); // September 2026

// ── [dates] ─────────────────────────────────────────────────────────────
console.log('[dates]');
{
    // A date that does not exist must not roll into another month.
    eq(I.parseDate('2026-02-31'), null, 'an impossible ISO date is refused, not rolled to March');
    eq(I.parseDate('02/30/2026'), null, 'an impossible US date is refused');
    eq(I.parseDate('2028-02-29').getDate(), 29, 'a real leap day still parses');
    const d = I.parseDate('2026-09-01');
    eq([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 8, 1, 0], 'a date-only string is LOCAL midnight');
    ok('the 1st of the month is inside that month', I.inPeriod('2026-09-01', SEP));
    ok('the 30th is inside', I.inPeriod('2026-09-30', SEP));
    ok('the 1st of the next month is outside (half-open window)', !I.inPeriod('2026-10-01', SEP));
    ok('the last day of the previous month is outside', !I.inPeriod('2026-08-31', SEP));

    const ncmec = I.parseDate('09-15-2026 13:21:05 UTC');
    eq(ncmec && ncmec.toISOString(), '2026-09-15T13:21:05.000Z', 'NCMEC "MM-DD-YYYY HH:MM:SS UTC" is read as that UTC instant');
    const slash = I.parseDate('09/15/2026');
    eq(slash && [slash.getMonth(), slash.getDate()], [8, 15], 'MM/DD/YYYY reads');
    eq(I.parseDate('2026-09-15T10:00:00.000Z').toISOString(), '2026-09-15T10:00:00.000Z', 'ISO timestamps pass through');
    eq(I.parseDate(''), null, 'empty → null');
    eq(I.parseDate(null), null, 'null → null');
    eq(I.parseDate('Sept'), null, 'junk the JS Date parser would accept is refused');
    eq(I.parseDate('3'), null, 'a bare digit is not a date');
    eq(I.parseDate('13/45/2026'), null, 'an impossible month/day is refused');
    eq(I.fmtDate('2026-09-04'), '09/04/2026', 'fmtDate is MM/DD/YYYY');
}

// ── [periods] ───────────────────────────────────────────────────────────
console.log('[periods]');
{
    const p = I.lastFullMonth(new Date(2026, 9, 13));
    eq([p.year, p.month, p.label, p.key], [2026, 9, 'September 2026', '2026-09'], 'mid-October → last full month is September');
    const j = I.lastFullMonth(new Date(2027, 0, 2));
    eq([j.year, j.month], [2026, 12], 'early January → December of the previous year');
    let threw = false; try { I.monthPeriod(2026, 13); } catch (_) { threw = true; }
    ok('month 13 is rejected', threw);
}

// ── [GB parsing] ────────────────────────────────────────────────────────
console.log('[GB parsing]');
{
    eq(I.parseGb('256 GB'), 256, '256 GB');
    eq(I.parseGb('256GB'), 256, '256GB with no space');
    eq(I.parseGb('1 TB'), 1000, '1 TB = 1000 GB (decimal, as drives are sold)');
    eq(I.parseGb('1.5 TB SSD'), 1500, '1.5 TB SSD');
    eq(I.parseGb('512 MB'), 0.512, '512 MB');
    eq(I.parseGb('64gb'), 64, 'lower case');
    eq(I.parseGb('2 TiB'), 2000, 'TiB reads as TB');
    eq(I.parseGb('1,000 GB'), 1000, 'thousands separator');
    eq(I.parseGb('256'), null, 'a bare number has no unit — not guessed');
    eq(I.parseGb('unknown'), null, 'text → null');
    eq(I.parseGb(''), null, 'blank → null');
    eq(I.parseGb('0 GB'), null, 'zero is not a size');
}

// ── [which cases are ICAC] ──────────────────────────────────────────────
console.log('[which cases are ICAC]');
{
    ok('explicit true', I.isIcacCase({ icac: true }, []));
    ok('explicit false beats a typed CyberTip number', !I.isIcacCase({ icac: false, cybertipNumber: '123' }, []));
    ok('explicit false beats an imported tip', !I.isIcacCase({ icac: false }, [{ reportNumber: '1' }]));
    ok('no choice + typed CyberTip → ICAC', I.isIcacCase({ cybertipNumber: '987654' }, []));
    ok('no choice + imported tip → ICAC', I.isIcacCase({}, [{ reportNumber: '1' }]));
    ok('no choice + a whitespace-only tip number → not ICAC', !I.isIcacCase({ cybertipNumber: '   ' }, []));
    ok('no choice, no tip → not ICAC', !I.isIcacCase({}, []));
    ok('null case → not ICAC', !I.isIcacCase(null, []));
    ok('null rows inside the tip list are ignored', !I.isIcacCase({}, [null]));
}

// ── [CyberTip referrals] ────────────────────────────────────────────────
console.log('[CyberTip referrals]');
{
    const tips = I.caseTips({ cybertipNumber: '111', createdAt: '2026-09-02T12:00:00' }, [
        { reportNumber: '111', ncmecMadeAvailable: '09-05-2026 10:00:00 UTC', importedAt: '2026-09-20T12:00:00Z', receivedDate: '08-01-2026 10:00:00 UTC' },
        { reportNumber: '111', importedAt: '2026-09-21T12:00:00Z' },
        { reportNumber: '222', importedAt: '2026-09-22T12:00:00Z', receivedDate: '07-01-2026 10:00:00 UTC' },
        { reportNumber: '', receivedDate: '09-10-2026 10:00:00 UTC' }
    ]);
    eq(tips.length, 3, 'a typed number that matches an imported tip is ONE referral, and duplicate imports collapse');
    eq(tips[0].date.toISOString(), '2026-09-05T10:00:00.000Z', 'dated by "made available to law enforcement" first');
    eq(tips[1].date.toISOString(), '2026-09-22T12:00:00.000Z', 'then by the import date — NOT the platform report date');
    eq(tips[2].date.toISOString(), '2026-09-10T10:00:00.000Z', 'the NCMEC received stamp is the last resort');
    const typedOnly = I.caseTips({ cybertipNumber: '333', dateAssigned: '2026-09-03' }, []);
    eq(typedOnly.length, 1, 'a typed number with no import still counts once');
    eq(I.fmtDate(typedOnly[0].date), '09/03/2026', '…dated by the day the case was assigned');
}

// ── A month of realistic data ───────────────────────────────────────────
const cases = [
    null, // corrupt row — must be tolerated
    { id: 1, caseNumber: 'ICAC-1', cybertipNumber: '5001', dateAssigned: '2026-09-02', createdAt: '2026-09-02T09:00:00' },
    { id: 2, caseNumber: 'ICAC-2', icac: true, createdAt: '2026-09-10T09:00:00' },
    { id: 3, caseNumber: 'BURG-3', createdAt: '2026-09-04T09:00:00' },                     // not ICAC
    { id: 4, caseNumber: 'UNTICK-4', icac: false, cybertipNumber: '5004', createdAt: '2026-09-05T09:00:00' }, // tip, but unticked
    { id: 5, caseNumber: 'ASSIST-5', icac: true, caseRole: 'assist', createdAt: '2026-09-06T09:00:00' },
    { id: 6, caseNumber: 'OLD-6', icac: true, createdAt: '2026-06-01T09:00:00' },            // opened before the month
    { id: 7, caseNumber: 'NOTYPE-7', icac: true, createdAt: '2026-09-12T09:00:00' }           // ICAC, no tip, no type
];
const everything = {
    suspects: [
        { name: 'A', arrested: true, arrestDate: '2026-09-15', handsOnOffender: true },
        { name: 'B', arrested: true, arrestDate: '2026-09-16' },
        { name: 'C', arrested: true, arrestDate: '2026-10-01', handsOnOffender: true },       // next month
        { name: 'D', arrested: true },                                                       // no date
        { name: 'E', arrested: false, arrestDate: '2026-09-15' },                            // not arrested
        null
    ],
    warrants: [
        { type: 'search', dateSigned: '2026-09-03', issuedTo: 'Google' },
        { type: 'search', dateSigned: '2026-09-04', courtLevel: 'federal', issuedTo: 'Meta' },
        { type: 'subpoena', dateSigned: '2026-09-05' },
        { type: 'court-order', createdAt: '2026-09-06T10:00:00', courtLevel: 'federal' },   // no signed date → createdAt
        { type: 'preservation', dateSigned: '2026-09-07' },                                  // not an IDS warrant
        { type: 'arrest', dateSigned: '2026-09-07' },                                        // not an IDS warrant
        { type: 'search', dateSigned: '2026-08-31' },                                        // previous month
        { type: 'search' }                                                                   // no date at all
    ],
    devices: [
        { deviceCategory: 'phone', acquisitionDate: '2026-09-08', storageSize: '128 GB', onScene: true, makeModel: 'iPhone 14' },
        { deviceCategory: 'tablet', acquisitionDate: '2026-09-09', storageSize: '64GB' },
        { deviceCategory: 'computer', acquisitionDate: '2026-09-10', storageSize: '1 TB' },
        { deviceCategory: 'drive', createdAt: '2026-09-11T10:00:00', storageSize: '2 TB' },  // dated by createdAt
        { deviceCategory: 'gps', acquisitionDate: '2026-09-12', storageSize: '8 GB' },       // no IDS bucket
        { deviceCategory: 'phone', acquisitionDate: '2026-09-13', storageSize: 'unknown' },  // unreadable size
        { deviceCategory: 'phone', acquisitionDate: '2026-09-14' },                          // no size
        { deviceCategory: 'computer', acquisitionDate: '2026-10-02', storageSize: '500 GB' } // next month
    ],
    prosecution: {
        submissions: [
            { venue: 'state', submittedDate: '2026-09-17', acceptedDate: '2026-09-25' },
            { venue: 'federal', submittedDate: '2026-08-20', acceptedDate: '2026-09-05' },   // submitted last month, accepted this one
            { venue: 'federal', submittedDate: '2026-09-18' },
            { venue: 'state' }                                                               // no date
        ]
    },
    icac: {
        investigationType: 'proactive',
        referrals: [
            { date: '2026-09-19', venue: 'state', agency: 'Tarrant Co SO' },
            { date: '2026-09-20', venue: 'federal', agency: 'HSI' },
            { date: '2026-08-20', venue: 'federal', agency: 'FBI' },
            { venue: 'state', agency: 'No Date PD' }
        ],
        evidenceNeededDate: '2026-09-21',
        cvipSubmittedDate: '2026-09-22',
        victims: [
            { date: '2026-09-23', kind: 'rescued', count: 2 },
            { date: '2026-09-23', kind: 'identified-images', count: 3 },
            { date: '2026-09-24', kind: 'identified-no-images' },                            // count defaults to 1
            { date: '2026-10-01', kind: 'rescued', count: 5 },                               // next month
            { kind: 'rescued', count: 4 }                                                    // no date
        ]
    }
};
const store = {
    1: { tips: [{ reportNumber: '5001', importedAt: '2026-09-02T10:00:00' }] },   // reactive by default
    2: everything,                                                                // proactive
    3: everything,                                                                // NOT ICAC — must contribute nothing
    4: everything,                                                                // unticked — must contribute nothing
    // The assist is MARKED reactive, so the only thing keeping it out of
    // "investigations opened" is the assist rule itself.
    5: { icac: { investigationType: 'reactive' },
         warrants: [{ type: 'search', dateSigned: '2026-09-09' }],
         suspects: [{ name: 'F', arrested: true, arrestDate: '2026-09-09' }],
         devices: [{ deviceCategory: 'phone', acquisitionDate: '2026-09-09', storageSize: '256 GB' }] },
    6: { warrants: [{ type: 'search', dateSigned: '2026-09-29' }] },             // old case, new warrant
    7: {}
};
const activities = [
    { kind: 'presentation', date: '2026-09-03', count: 2, people: 150 },
    { kind: 'presentation', date: '2026-09-04', people: 40 },                    // count defaults to 1
    { kind: 'presentation', date: '2026-10-01', count: 9, people: 900 },         // next month
    { kind: 'diversion', date: '2026-09-05', count: 1, people: 12 },
    { kind: 'public-event', date: '2026-09-06' },
    { kind: 'outreach', date: '2026-09-07', count: 3 },
    { kind: 'citizen-complaint', date: '2026-09-08', count: 2 },
    { kind: 'referral-received', date: '2026-09-09', count: 4 },
    { kind: 'training-conducted', date: '2026-09-10' },
    { kind: 'sent-tf', date: '2026-09-11', people: 2 },
    { kind: 'sent-ttaa', date: '2026-09-11', people: 1 },
    { kind: 'sent-other', date: '2026-09-11' },                                  // people missing → reported
    { kind: 'trained-le', date: '2026-09-12', people: 30 },
    { kind: 'trained-prosecutor', date: '2026-09-12', people: 5 },
    { kind: 'trained-other', date: '2026-09-12', people: 7 },
    { kind: 'technical-assist', date: '2026-09-13', count: 6 },
    { kind: 'bogus', date: '2026-09-13', count: 99 },                            // unknown kind ignored
    { kind: 'technical-assist', count: 50 },                                     // no date ignored
    null
];
const res = I.build({ cases, store, activities, period: SEP });

// ── [section order] ─────────────────────────────────────────────────────
console.log('[section order]');
eq(res.sections.map(s => s.title), ['1. Prevention', '2. Complaints', '3. Case Information', '4. Victims',
    '5. Court Actions', '6. Digital Forensics', '7. Training', '8. Technical Assists'], 'the eight IDS sections, in IDS order');
eq(res.period.label, 'September 2026', 'the period travels with the result');
eq(res.icacCases.map(c => c.caseNumber), ['ICAC-1', 'ICAC-2', 'ASSIST-5', 'OLD-6', 'NOTYPE-7'],
    'ICAC set: tip-by-default, ticked, assist, old, untyped — NOT the burglary, NOT the untick');

// ── [prevention / complaints] ───────────────────────────────────────────
console.log('[prevention / complaints]');
eq(count(res, 'presentations'), 3, 'presentations: 2 + 1 (count defaults to 1); next month excluded');
eq(count(res, 'presentationAttendees'), 190, 'attendees: 150 + 40');
eq(count(res, 'diversion'), 1, 'diversion');
eq(count(res, 'diversionParticipants'), 12, 'diversion participants');
eq(count(res, 'publicEvents'), 1, 'public events');
eq(count(res, 'outreach'), 3, 'outreach');
eq(count(res, 'citizenComplaints'), 2, 'citizen complaints');
eq(count(res, 'referralsReceived'), 5, 'referrals received: 1 CyberTip on ICAC-1 + 4 logged — the unticked case\'s tip is NOT counted');
ok('the CyberTip referral names its report number', rowOf(res, 'referralsReceived').detail.some(d => d.caseNumber === 'ICAC-1' && /#5001/.test(d.text)));
{
    const acts = [{ id: 'x1', date: '2026-09-10', kind: 'presentation', count: 3, people: 120, notes: 'Lincoln MS' },
                  { id: 'x2', date: '2026-09-11', kind: 'trained-le', people: 1 }];
    const r2 = I.build({ cases: [], store: {}, activities: acts, period: SEP });
    eq(rowOf(r2, 'presentations').detail.map(d => d.text), ['3 — 09/10/2026 — Lincoln MS'], 'activity detail leads with the count');
    eq(rowOf(r2, 'presentationAttendees').detail.map(d => d.text), ['120 people — 09/10/2026 — Lincoln MS'], '…and with the people');
    eq(rowOf(r2, 'trainedLe').detail.map(d => d.text), ['1 person — 09/11/2026'], 'singular person');
}

// ── [case information] ──────────────────────────────────────────────────
console.log('[case information]');
eq(count(res, 'invReactive'), 1, 'reactive: ICAC-1 (a CyberTip case with no type set defaults to reactive)');
eq(count(res, 'invProactive'), 1, 'proactive: ICAC-2');
ok('the assist is NOT an investigation opened, even though it is marked reactive', !rowOf(res, 'invReactive').detail.concat(rowOf(res, 'invProactive').detail).some(d => d.caseNumber === 'ASSIST-5'));
ok('…and is not nagged about its type either', !res.notCounted.some(n => n.caseNumber === 'ASSIST-5'));
ok('a case opened before the month is not counted as opened', !rowOf(res, 'invProactive').detail.some(d => d.caseNumber === 'OLD-6'));
ok('an ICAC case with no type and no tip is REPORTED, not guessed',
    res.notCounted.some(n => n.caseNumber === 'NOTYPE-7' && /reactive or proactive/.test(n.reason)));
ok('…and raises a warning', res.warnings.some(w => /NOTYPE-7/.test(w)));
eq(count(res, 'arrests'), 3, 'arrests: A + B on ICAC-2, plus F on the ASSIST (work product counts)');
eq(count(res, 'arrestsHandsOn'), 1, 'hands-on: A only (C is next month)');
ok('an arrest with no date is reported', res.notCounted.some(n => n.caseNumber === 'ICAC-2' && /Arrest of D/.test(n.text) && /no date/.test(n.reason)));
eq(count(res, 'refMadeState'), 1, 'referrals made — state');
eq(count(res, 'refMadeFederal'), 1, 'referrals made — federal (August excluded)');
ok('an undated referral is reported', res.notCounted.some(n => /No Date PD/.test(n.text)));
eq(count(res, 'evidenceNeeded'), 1, 'evidence needed');
eq(count(res, 'cvip'), 1, 'CVIP');

// ── [victims] ───────────────────────────────────────────────────────────
console.log('[victims]');
eq(count(res, 'vicRescued'), 2, 'rescued: 2 (next-month 5 excluded, undated 4 reported)');
eq(count(res, 'vicIdImages'), 3, 'identified with images');
eq(count(res, 'vicIdNoImages'), 1, 'identified without images — blank count means one');
ok('undated victim entry reported', res.notCounted.some(n => /4 victim/.test(n.text)));

// ── [court actions] ─────────────────────────────────────────────────────
console.log('[court actions]');
eq(count(res, 'prosSubState'), 1, 'submitted — state');
eq(count(res, 'prosSubFederal'), 1, 'submitted — federal (the August one is not this month)');
eq(count(res, 'prosAccState'), 1, 'accepted — state');
eq(count(res, 'prosAccFederal'), 1, 'accepted — federal: accepted THIS month though submitted last month');
ok('a submission with no date is reported', res.notCounted.some(n => /Prosecution submission/.test(n.text)));
eq(count(res, 'swState'), 3, 'search warrants — state: Google + the assist\'s + the old case\'s new warrant');
eq(count(res, 'swFederal'), 1, 'search warrants — federal: Meta');
eq(count(res, 'subpoenaState'), 1, 'subpoenas/orders — state');
eq(count(res, 'subpoenaFederal'), 1, 'subpoenas/orders — federal, dated by createdAt when unsigned');
ok('preservation letters and arrest warrants never appear',
    !rowOf(res, 'swState').detail.concat(rowOf(res, 'subpoenaState').detail).some(d => /preserv|arrest/i.test(d.text)));
ok('an undated search warrant is reported', res.notCounted.some(n => /Search warrant/.test(n.text) && /signed date/.test(n.reason)));

// ── [digital forensics] ─────────────────────────────────────────────────
console.log('[digital forensics]');
eq(count(res, 'onScene'), 1, 'on-scene');
eq(count(res, 'examMobile'), 5, 'mobile: 3 phones + 1 tablet on ICAC-2, 1 phone on the assist');
eq(count(res, 'examComputer'), 1, 'computers (October one excluded)');
eq(count(res, 'examStorage'), 1, 'other storage: the drive, dated by createdAt');
eq(count(res, 'gbExamined'), 3456, 'GB: 128 + 64 + 1000 + 2000 + 8 (gps still examined) + 256 (assist)');
ok('GPS has no IDS bucket and says so', res.notCounted.some(n => /no IDS category/.test(n.reason) && /gps/.test(n.reason)));
ok('an unreadable size is reported with the text typed', res.notCounted.some(n => /"unknown"/.test(n.reason)));
ok('a missing size is reported', res.notCounted.some(n => /no storage size/.test(n.reason)));

// ── [training / assists] ────────────────────────────────────────────────
console.log('[training / assists]');
eq(count(res, 'trainingConducted'), 1, 'training conducted');
eq(count(res, 'sentTf'), 2, 'sent to TF training');
eq(count(res, 'sentTtaa'), 1, 'sent to T&TA');
eq(count(res, 'sentOther'), 0, 'sent other: no people entered → 0');
ok('…and that entry is reported', res.notCounted.some(n => /Sent to other training/.test(n.text) && /people/.test(n.reason)));
eq(count(res, 'trainedLe'), 30, 'LE trained');
eq(count(res, 'trainedProsecutor'), 5, 'prosecutors trained');
eq(count(res, 'trainedOther'), 7, 'other professionals trained');
eq(count(res, 'technicalAssists'), 6, 'technical assists (undated and unknown kinds ignored)');

// ── [isolation] ─────────────────────────────────────────────────────────
console.log('[isolation]');
{
    // The non-ICAC and unticked cases hold the full fixture. If either leaked,
    // every work-product count above would be tripled. Pin it directly too.
    const all = res.sections.flatMap(s => s.rows).flatMap(r => r.detail);
    ok('nothing from the burglary case leaks in', !all.some(d => d.caseNumber === 'BURG-3'));
    ok('nothing from the unticked CyberTip case leaks in', !all.some(d => d.caseNumber === 'UNTICK-4'));
    ok('nor into notCounted', !res.notCounted.some(n => n.caseNumber === 'BURG-3' || n.caseNumber === 'UNTICK-4'));
}

// ── [empty / degenerate input] ──────────────────────────────────────────
console.log('[empty / degenerate input]');
{
    const e = I.build({ period: SEP });
    eq(e.sections.flatMap(s => s.rows).every(r => r.count === 0), true, 'no input → every row zero');
    eq(e.notCounted.length, 0, 'no input → nothing reported');
    const odd = I.build({ cases: 'nope', store: null, activities: {}, period: SEP });
    eq(odd.icacCases.length, 0, 'non-array inputs are tolerated');
    const def = I.build({});
    ok('no period → defaults to the last full month', def.period && def.period.start < new Date() && def.period.end <= new Date(new Date().getFullYear(), new Date().getMonth(), 1, 0, 0, 1));
    const neg = I.build({ cases: [{ id: 9, icac: true }], store: { 9: { icac: { victims: [{ date: '2026-09-02', kind: 'rescued', count: -3 }] } } }, period: SEP });
    eq(count(neg, 'vicRescued'), 1, 'a negative victim count is treated as unentered (one), never subtracted');
}

// ── [UMD] ───────────────────────────────────────────────────────────────
console.log('[UMD]');
{
    // VIPER's renderer defines `module`. A wrapper that only assigns
    // module.exports would leave window.IdsMeasures undefined in the app.
    const vm = require('vm');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ids-measures.js'), 'utf8');
    const sandbox = { module: { exports: {} } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(src, sandbox);
    ok('assigns module.exports', typeof sandbox.module.exports.build === 'function');
    ok('AND the global, even when `module` exists', sandbox.IdsMeasures && typeof sandbox.IdsMeasures.build === 'function');
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
