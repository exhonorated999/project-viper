/*
 * modules/rms/__tests__/generic-extractor.test.js
 *
 * The format-agnostic RMS reader.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * The first is REACH: a report from an agency nobody has written a parser for
 * should still give an officer the names, the dates of birth, the addresses,
 * the licences and the narrative that are plainly printed on it.
 *
 * The second is RESTRAINT: everything this module produces is unverified. A
 * form label harvested as somebody's job, a checkbox legend harvested as an
 * offense, or two people collapsed into one card, all end up in front of a
 * court. So most of the assertions below are about what the reader REFUSES to
 * say. A blank field is an honest answer; a wrong one is not.
 *
 * Plain node: node modules\rms\__tests__\generic-extractor.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'rms-shapes.js'));
const G = require(path.join(__dirname, '..', 'generic-extractor.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else {
        fail++;
        console.log('  FAIL  ' + name);
        if (extra !== undefined) console.log('        ' + JSON.stringify(extra));
    }
}
function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), { got: got, want: want });
}
function section(t) { console.log('\n[' + t + ']'); }

const FIX = path.join(__dirname, 'fixtures');
function fixture(f) { return fs.readFileSync(path.join(FIX, f), 'utf8'); }

/* The module's own page split, reproduced so segmentation can be driven
 * directly without going through parse(). */
function pagesOf(text) {
    return S.splitPages(S.lines(text), null, S.isPageBreak).pages;
}
function segsOf(text) {
    const pages = pagesOf(text);
    return G._segment(pages, G._index(pages));
}
function byRole(segs) {
    return segs.filter(s => s.kind === 'person').map(s => s.role);
}

/* ================================================================ */
section('identity and the safety contract');

eq('the format id is stable', G.FORMAT, 'generic');
ok('the format label says it is a generic read', /generic/i.test(G.FORMAT_LABEL));
ok('the banner tells the officer nothing was filed',
   /Nothing below has been filed/i.test(G.GENERIC_BANNER));
ok('...and tells them to check it against the document',
   /against the document/i.test(G.GENERIC_BANNER));

/* routeRmsPersonsToTabs() matches /SUSPECT|ARRESTED|DEFENDANT/i. A person
 * labelled only "ARRESTEE" or "OFFENDER" is invisible to it. */
eq('an arrestee carries the router keyword', G.ROLE.ARRESTEE, 'SUSPECT (ARRESTEE/OFFENDER)');
ok('...so the router would classify it', /SUSPECT|ARRESTED|DEFENDANT/i.test(G.ROLE.ARRESTEE));
ok('every role is a non-empty string',
   Object.keys(G.ROLE).every(k => typeof G.ROLE[k] === 'string' && G.ROLE[k].length > 0));

/* ================================================================ */
section('shape matchers — dates, licences, plates');

eq('a slashed date', G._matchDate('DOB 11/04/1992'), '11/04/1992');
eq('a two-digit year', G._matchDate('06-18-88'), '06-18-88');
eq('an ISO date', G._matchDate('2026-04-02'), '2026-04-02');
eq('a month-abbreviation date', G._matchDate('14MAR2019'), '14MAR2019');
eq('no date is no answer', G._matchDate('RESIDENT ADDRESS'), '');

/* The licence number is the token immediately LEFT of the state code. */
eq('a licence beside its state', G._matchDl('9284471 AR'), '9284471');
eq('...and the state is not taken as the number', G._matchDl('WDL4471820 WA'), 'WDL4471820');
eq('a ZIP is never a licence number', G._matchDl('CONWAY AR 72032'), '');
eq('a ZIP+4 is never a licence number', G._matchDl('CONWAY AR 72032-1180'), '');
eq('a date is never a licence number', G._matchDl('DL 11/04/1992'), '');

eq('a plate', G._matchPlate('LICENSE PLATE BKR4429'), 'BKR4429');
eq('a bare year is not a plate', G._matchPlate('YEAR 2003'), '');
eq('a ZIP is not a plate', G._matchPlate('NORTHGATE WA 98133'), '');
eq('a VIN is not a plate', G._matchPlate('1HGCM82633A004352'), '');
eq('a VIN', G._matchVin('VIN 1HGCM82633A004352'), '1HGCM82633A004352');

eq('a height in feet and inches', G._matchHeight("5'11\""), '5\'11"');
eq('a height as three digits', G._matchHeight('HGT 602'), '6\'2"');
eq('an impossible inch count is refused', G._matchHeight('HGT 599'), '');

eq('a case number', G._matchCaseNo('CASE NUMBER 26-0043117'), '26-0043117');
eq('a ZIP is not a case number', G._matchCaseNo('98133'), '');
eq('a bare year is not a case number', G._matchCaseNo('2026'), '');

eq('a statute', G._matchStatute('5-14-103a(1) Rape'), '5-14-103a(1)');
eq('a date is not a statute', G._matchStatute('4-2-2026'), '');

/* A typed word is a reading; a checkbox glyph is a guess. */
const SEXW = ['MALE', 'FEMALE', 'M', 'F', 'UNKNOWN'];
eq('a typed sex is read', G._matchWord('FEMALE', SEXW), 'FEMALE');
eq('a legend offering every option is refused',
   G._matchWord('(M) Male (F) Female (U) Unknown', SEXW), '');
eq('a lone letter is a checkbox, not a word', G._matchWord('M', SEXW), '');

/* ================================================================ */
section('junk gates — is this a value or the form talking?');

ok('a row of labels scores two or more', G._isLabelRow('Hair Color Eye Color Height Weight'));
ok('a value row does not', !G._isLabelRow('Halvorsen, Dana Rae'));
ok('a single label is not yet a label row', !G._isLabelRow('Occupation'));
ok('...but it does score one', G._labelRowScore('Occupation') === 1);

ok('bracket glyphs are a checkbox legend', G._isCheckboxLegend('[J (W)White [] (B)Black'));
ok('an instruction to the clerk is a legend', G._isCheckboxLegend('LOCATION CODE (Enter 1)'));
ok('two option codes are a legend', G._isCheckboxLegend('(01) Air/Bus (16) Home'));
ok('a plain offense name is not a legend', !G._isCheckboxLegend('TERRORISTIC THREATENING - 1ST'));

ok('a dispatch log row is recognised',
   G._isLogRow('dbrabham - Brabham, Dixie 19:48 20:07 FCSO-Delta'));
ok('...including one with a single timestamp',
   G._isLogRow('estell - Stell, Emily 15:40 FCSO-Beta'));
ok('a narrative sentence is not a log row',
   !G._isLogRow('I made contact with the reporting party in the driveway.'));

ok('a run of repeated glyphs is not a name', G._nameLooksLikeJunk('HHHHHHHHHE'));
ok('a checkbox glyph is not a name', G._nameLooksLikeJunk('[J Smith'));
ok('a column of empty boxes is not a name', G._nameLooksLikeJunk('OOoOOoOoOgogoQg'));
ok('all-initials is not a name', G._nameLooksLikeJunk('DR. LL.'));
ok('a real name survives', !G._nameLooksLikeJunk('Halvorsen, Dana Rae'));
ok('...and so does McDonald', !G._nameLooksLikeJunk('McDonald, Ian'));

/* _safeName's loose gates only apply on the weakest-evidence paths. */
eq('a label-vouched name passes', G._safeName('NAME: Ockerman, Trey Lamont',
   S.extractName('NAME: Ockerman, Trey Lamont')), 'Ockerman, Trey Lamont');
eq('an address is never a person, unvouched',
   G._safeName('3 SERRAMONTE CENTER, DALY CITY CA 94015',
               'SERRAMONTE CENTER, DALY', true), '');
eq('a sentence is never a person, unvouched',
   G._safeName('...at 508 Richmond Drive, Apt. 5, Millbrae, and at her mother\'s apartment',
               'Richmond Drive, Apt.', true), '');
eq('a label row is never a person', G._safeName('Hair Color Eye Color', 'Hair Color', false), '');

eq('a capitalised run reads as a loose name', G._nameLoose('Dana Rae Halvorsen'), 'Dana Rae Halvorsen');
eq('an address row does not', G._nameLoose('418 Larkspur Way, Northgate, WA 98133'), '');
eq('a phone row does not', G._nameLoose('Contact (206) 555-0174'), '');
eq('an SSN row does not', G._nameLoose('SSN 412-88-9301'), '');

/* ================================================================ */
section('value windows');

/* On a left-packed OCR row the neighbour's label is the only boundary there
 * is. Without this cut the Arkansas victim's occupation came back as the
 * column ruling of the phone cell. */
eq('a value is cut at the next label',
   G._cutAtNextLabel(' 04/02/2026 REPORT DATE 04/03/2026').trim(), '04/02/2026');
eq('a value with no neighbour is left whole',
   G._cutAtNextLabel(' Dental Hygienist').trim(), 'Dental Hygienist');

const WLINES = ['DATE OF BIRTH', '11/04/1992', '', 'RESIDENT ADDRESS'];
const W = G._window(WLINES, 0, 'DATE OF BIRTH'.length, 2);
eq('the label cell itself is empty on a vertical form', W.first, '');
eq('the window reaches the row beneath', W.lines[1], '11/04/1992');
ok('blank rows are skipped, not counted', W.lines.indexOf('') === 1 || W.lines[2] === 'RESIDENT ADDRESS');

/* ================================================================ */
section('segmentation — one heading, one human');

/* Westminster labels one defendant's cells "Defendant Information",
 * "Defendant Name" and "Defendant's Address". Three role hits, one man. */
const DEF = [
    'Defendant Information',
    'Defendant Name   Date Of Birth',
    'Rosecrans, Milo J   04/12/1984',
    "Defendant's Address   Phone",
    '77 Harlow St, Greenfield, MA 01301   (413) 555-0122'
].join('\n');
eq('repeated role labels on label rows are one person', byRole(segsOf(DEF)).length, 1);
eq('...and he is a suspect to the router', byRole(segsOf(DEF)), ['SUSPECT']);

/* But a role heading that is not a label row always opens. */
const WIT = [
    'Witness #1',
    'Name: Brennecke, Aloysius',
    'DOB: 02/27/1970',
    'Witness #2',
    'Name: Tolliver, Ruth Ann',
    'DOB: 09/03/1981'
].join('\n');
eq('numbered headings open a block each', byRole(segsOf(WIT)), ['WITNESS', 'WITNESS']);

/* A role word swallowed by a sentence is not a heading. Taking it as one
 * truncated an officer's narrative at that sentence. */
const PROSE = 'Rottman (Others involved). Ms. Barber and JV1 were both given statement forms.';
eq('a role word inside a sentence opens nothing',
   G._index(pagesOf(PROSE)).filter(h => h.cls === 'role').length, 0);
ok('a standalone heading still opens',
   G._index(pagesOf('Others Involved')).filter(h => h.cls === 'role').length >= 1);

/* A line that simply closes as a sentence is not a section heading either. */
eq('a sentence ending in a full stop is not a section',
   G._index(pagesOf('I then placed the rape kit into FCSO CID Evidence without further incident.'))
       .filter(h => h.cls === 'section').length, 0);

/* ================================================================ */
section('duplicate bands — merge only when the prints agree');

function band(o) {
    return Object.assign({
        involvement: 'SUSPECT (ARRESTEE/OFFENDER)', name: '', dob: '', dl: '', dlState: '',
        ssn: '', phone: '', address: '', sourcePage: 2, fieldSources: {}, confidence: 0
    }, o);
}

/* Two identifiers must AGREE before two bands are one person. One shared
 * identifier is not enough — forms print siblings with the same address and
 * the same surname. */
let m = G._mergeDuplicateBands([
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198', dl: 'WDL4471820', dlState: 'WA' }),
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198', ssn: '412-88-9301' })
]);
eq('two prints of one arrestee merge to one card', m.length, 1);
eq('the licence came from the first print', m[0].dl, 'WDL4471820');
eq('the SSN came from the second', m[0].ssn, '412-88-9301');

m = G._mergeDuplicateBands([
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198', dl: 'WDL4471820' }),
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198', ssn: '555-11-2222',
           dl: 'WDL9990000' })
]);
eq('a conflicting identifier proves two people', m.length, 2);

m = G._mergeDuplicateBands([
    band({ dob: '06/18/1988', dl: 'WDL4471820' }),
    band({ dob: '06/18/1988', dl: 'WDL4471820', sourcePage: 3 })
]);
eq('bands on different pages are never merged', m.length, 2);

m = G._mergeDuplicateBands([
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', dl: 'WDL4471820' }),
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', dl: 'WDL4471820',
           involvement: 'WITNESS' })
]);
eq('bands in different roles are never merged', m.length, 2);

eq('one shared identifier is not enough to merge', G._mergeDuplicateBands([
    band({ name: 'Ockerman, Trey', dob: '06/18/1988' }),
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', ssn: '412-88-9301' })
]).length, 2);

m = G._mergeDuplicateBands([
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198' }),
    band({ name: 'Ockerman, Trey', dob: '06/18/1988', phone: '(206) 555-0198', dlState: 'WA' })
]);
eq('a merge still yields one card', m.length, 1);
eq('a licence STATE with no licence NUMBER is dropped', m[0].dlState, '');

/* Confidence is provenance, not truth. */
eq('a fully labelled person is 1', G._confidence({
    name: 'A, B', dob: '01/01/1990', fieldSources: { name: { label: 'NAME' }, dob: { label: 'DOB' } }
}), 1);
eq('an unlabelled field halves it', G._confidence({
    name: 'A, B', address: '1 X St', fieldSources: { name: { label: 'NAME' }, address: { label: '(unlabelled)' } }
}), 0.5);
eq('an empty person is 0', G._confidence({ fieldSources: {} }), 0);

/* ================================================================ */
section('viability — is this an RMS report at all?');

ok('a labelled form is viable', G.viable(fixture('generic-vertical-report.synthetic.txt')));
ok('a page of prose with a case number is viable',
   G.viable(fixture('ar-supplement-narrative.ocr.txt')));
ok('an invoice is not a police report',
   !G.viable('INVOICE 4471\nQty  Item  Unit  Amount\n2  Widget  4.00  8.00\nTotal 8.00'));
ok('an empty document is not viable', !G.viable(''));

const v = G._viability(fixture('ar-supplement-narrative.ocr.txt'));
ok('the supplement is carried by its narrative, not its labels', v.narrChars >= 200);

/* ================================================================ */
section('end to end — a vertical label/value form');

const VTEXT = fixture('generic-vertical-report.synthetic.txt');
const vq = G.quickScan(VTEXT);
const vr = G.parse(VTEXT, 'generic-vertical-report.pdf');

eq('the case number', vq.reportNumber, '26-0043117');
eq('the report date', vq.reportDate, '04/02/2026');
eq('the location of occurrence', vq.location, '418 Larkspur Way, Northgate, WA 98133');
eq('one of each role was counted', vq.roles, { VICTIM: 1, SUSPECT: 1, WITNESS: 1 });
eq('one vehicle carries data', vq.vehicleCount, 1);
ok('a narrative was found', vq.narrativeFound);

eq('three people came back', vr.reviewPersons.length, 3);

/* The trap this fixture exists for: the role is printed BELOW the name, so a
 * record opened at the role hit picks up the NEXT person's name and pairs it
 * with THIS person's date of birth. Every card must hold one human. */
const vp = vr.reviewPersons;
eq('the victim', [vp[0].name, vp[0].involvement, vp[0].dob],
   ['Halvorsen, Dana Rae', 'VICTIM', '11/04/1992']);
eq('the suspect', [vp[1].name, vp[1].involvement, vp[1].dob],
   ['Ockerman, Trey Lamont', 'SUSPECT', '06/18/1988']);
eq('the witness', [vp[2].name, vp[2].involvement, vp[2].dob],
   ['Brennecke, Aloysius', 'WITNESS', '02/27/1970']);

eq('the victim keeps her own phone', vp[0].phone, '(206) 555-0174');
eq('...her own licence', vp[0].dl, 'WDL4471820');
eq('...and its issuing state', vp[0].dlState, 'WA');
eq('the suspect\'s exact age is read from the row beneath the label', vp[1].age, '37');
eq('the witness has his own phone', vp[2].phone, '(206) 555-0198');

const vv = vr.reviewVehicles[0];
eq('the plate', vv.plate, 'BKR4429');
eq('the VIN', vv.vin, '1HGCM82633A004352');
eq('the year', vv.year, '2003');
eq('the colour is read from the row beneath its label', vv.color, 'Silver');

/* ACCEPTED LIMITS, asserted so they cannot change silently.
 *
 * Make, model and occupation are free text, and free text has no shape. The
 * row beneath a label is a value on one real report ("Occupation" over "TRUCK
 * DRIVER") and an unfilled label on another ("Occupation" over "Gang
 * Affiliation"), and nothing distinguishes them. Colours can be read downward
 * because a colour vocabulary IS a shape. The cost is these three blanks. */
eq('free text below a label is NOT claimed — make', vv.make, '');
eq('free text below a label is NOT claimed — model', vv.model, '');
eq('free text below a label is NOT claimed — occupation', vp[0].occupation, '');

ok('the narrative came back whole', vr.diagnostics.narrativeChars > 380);
ok('...and starts with the officer\'s own words',
   /^On April 2, 2026/.test(vr.narratives[0].text));
ok('...and keeps its second paragraph', /She stated she had left for work/.test(vr.narratives[0].text));

/* ================================================================ */
section('end to end — the Arkansas incident report, read generically');

const ATEXT = fixture('ar-incident-report.ocr.txt');
const aq = G.quickScan(ATEXT);
const ar = G.parse(ATEXT, 'ar-incident-report.pdf');

eq('the incident number', aq.reportNumber, '26-0417295');
eq('the incident date', aq.reportDate, '08/13/2026');
eq('the address of offense', aq.location, '912 THISTLEDOWN LN, Bellefonte, AR 72611');
eq('the primary offense', aq.primaryOffense, 'Rape');
eq('the page count', aq.pageCount, 5);
ok('the label sweep found plenty', aq.hits > 80);

eq('four people came back', ar.diagnostics.persons, 4);
eq('one of them could not be named', ar.diagnostics.unnamedPersons, 1);
eq('one offense', ar.offenses.length, 1);
eq('the statute', ar.offenses[0].statute, '5-14-103a(1)');
eq('the offense description', ar.offenses[0].description, 'Rape');
ok('the narrative came back', ar.diagnostics.narrativeChars > 1400);

/* Roles must survive as the router's vocabulary, not the form's. */
const roles = ar.reviewPersons.map(p => p.involvement);
ok('the arrestee carries the router keyword',
   roles.some(r => r === 'SUSPECT (ARRESTEE/OFFENDER)'), roles);
ok('a nameless person is disclosed to the officer',
   ar.diagnostics.warnings.some(w => /no readable name/i.test(w)), ar.diagnostics.warnings);

/* ================================================================ */
section('end to end — the Arkansas supplement');

const STEXT = fixture('ar-supplement-narrative.ocr.txt');
const sr = G.parse(STEXT, 'ar-supplement-narrative.pdf');

eq('the parent incident number', sr.reportNumber, '26-0512833');
eq('a supplement has no people', sr.reviewPersons.length, 0);
ok('...and that is said out loud',
   sr.diagnostics.warnings.some(w => /No person blocks were recognised/i.test(w)),
   sr.diagnostics.warnings);
ok('the narrative is the whole point of it', sr.diagnostics.narrativeChars > 400);
eq('no offenses are invented', sr.offenses.length, 0);

/* ================================================================ */
section('hard invariants — the safety model, on every read');

[['vertical form', vr], ['arkansas incident', ar], ['arkansas supplement', sr]].forEach(function (pair) {
    const tag = pair[0], r = pair[1];

    /* THE one that makes auto-filing impossible. routeRmsPersonsToTabs()
     * reads only personsInvolved. */
    eq(tag + ': personsInvolved is empty', r.personsInvolved, []);
    eq(tag + ': it is still an array', Array.isArray(r.personsInvolved), true);

    ok(tag + ': the generic banner rides along', r.genericBanner === G.GENERIC_BANNER);
    ok(tag + ': the format is declared', r.genericFormat === 'generic');

    /* The UI injects these without a null check. */
    ok(tag + ': every involvement is a non-null string',
       r.reviewPersons.every(p => typeof p.involvement === 'string' && p.involvement.length > 0));
    ok(tag + ': every narrative officer is a non-null string',
       r.narratives.every(n => typeof n.officer === 'string'));
    ok(tag + ': every narrative text is a non-null string',
       r.narratives.every(n => typeof n.text === 'string'));

    /* A blank name may be SHOWN, but it is flagged, and it is never routable. */
    ok(tag + ': a nameless person is flagged unverified',
       r.reviewPersons.every(p => p.name ? !p.nameUnverified : p.nameUnverified === true));
    ok(tag + ': no nameless person reached a routable list',
       r.personsInvolved.every(p => !!p.name));

    /* Severity is a legal conclusion, not a reading. */
    ok(tag + ': no offense severity was inferred',
       r.offenses.every(o => o.severity === ''));

    ok(tag + ': the raw text is kept for the officer to check against',
       typeof r.rawText === 'string' && r.rawText.length > 0);
});

/* ================================================================ */
console.log('\n' + (fail ? 'FAILED' : 'OK') + ' \u2014 ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
