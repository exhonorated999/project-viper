/*
 * modules/rms/rms-shapes.js — unit tests
 * -------------------------------------
 * The format-independent primitives, in isolation.
 *
 * These functions decide, on their own, whether a token is a licence number
 * or a ZIP code, whether a line is an officer's prose or a ruled grid that
 * defeated OCR, and which PDF page a person was printed on. Two RMS readers
 * now share them, so a change here moves both — that is exactly why they are
 * tested apart from either reader.
 *
 * Inputs below are drawn from the OCR damage the reference scans actually
 * produced (values redacted), or are hand-built to isolate one rule.
 *
 * Run: node modules\rms\__tests__\rms-shapes.test.js
 */
'use strict';

const path = require('path');
const S = require(path.join(__dirname, '..', 'rms-shapes.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* ================================================================
 * 1. Line hygiene
 * ================================================================ */
console.log('\n[line hygiene]');

eq('lines() normalises CRLF and CR', S.lines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
eq('lines() of nothing is one empty line', S.lines(null), ['']);

eq('strip() removes the vertical-band gutter noise',
    S.strip('= ABERNATHY (JV1), GRAYSON'), 'ABERNATHY (JV1), GRAYSON');
eq('strip() removes a leading glyph pair',
    S.strip('&) 08/13/2026   1545'), '08/13/2026 1545');
eq('strip() never eats an opening parenthesis — it can start a phone number',
    S.strip('  (501) 459-8925 '), '(501) 459-8925');
eq('strip() collapses internal runs of whitespace',
    S.strip('HOLLOWAY   (JV2),    MARISOL'), 'HOLLOWAY (JV2), MARISOL');

eq('clean() collapses and trims but keeps punctuation',
    S.clean('  NAME:   Last,  First  '), 'NAME: Last, First');

eq('fmtPhone() normalises a packed number', S.fmtPhone('(501)459-8925'), '(501) 459-8925');
eq('fmtPhone() reads a dotted number', S.fmtPhone('x 501.459.8925 x'), '(501) 459-8925');
eq('fmtPhone() finds nothing in prose', S.fmtPhone('no number on this row'), '');
eq('a bare ten-digit run is NOT claimed as a phone number', S.fmtPhone('5014598925'), '');

ok('isPageBreak() matches the printed banner', S.isPageBreak('INCIDENT REPORT'));
ok('...with surrounding OCR punctuation', S.isPageBreak('-- CONTINUATION PAGE --'));
ok('...but not a row that merely starts with it',
    !S.isPageBreak('INCIDENT REPORT NUMBER 26-0417295'));

eq('findLine() returns the first match in range',
    S.findLine(['a', 'NARRATIVE', 'b', 'NARRATIVE'], /NARRATIVE/, 0, 4), 1);
eq('findLine() respects the lower bound',
    S.findLine(['a', 'NARRATIVE', 'b', 'NARRATIVE'], /NARRATIVE/, 2, 4), 3);
eq('findLine() returns -1 on a miss', S.findLine(['a', 'b'], /NARRATIVE/), -1);

/* ================================================================
 * 2. Prose detection
 * ================================================================ */
console.log('\n[prose]');

ok('an officer\'s sentence is prose',
    S.isProse('On Thursday, August 13, 2026 at approximately 1545 hours, I was dispatched.'));
ok('a row of form labels is not prose',
    !S.isProse('SEX AGE RACE ETHNIC DOB SSN SOC NO UNK MALE FEMALE WHITE BLACK'));
ok('a checkbox row is not prose',
    !S.isProse('[J (U)Unk [AGE: ___ [RACE [J (U) Unk. [J (B) Black [J (W) White'));
ok('a short line is not prose', !S.isProse('Yes, that is correct.'));

ok('a two-word closing line IS a narrative fragment', S.isNarrativeFragment('with it.'));
ok('form furniture is not a fragment', !S.isNarrativeFragment('PAGE #'));
ok('a stray wrapped word is not a fragment', !S.isNarrativeFragment('Marchetti'));
ok('OCR debris is not a fragment', !S.isNarrativeFragment('DEEZ =='));
ok('an unfinished three-word line is not a fragment', !S.isNarrativeFragment('and then she'));

ok('OCR wreckage is not a readable body',
    !S.bodyIsReadable(['EE', '-\u2014', 'A PTA', 'Ce \u2014\u2014']));
ok('two good lines among the damage IS readable',
    S.bodyIsReadable(['EE', 'She stated she had left for work at 0700 hours.',
        'I made contact with her in the driveway.', 'Ce \u2014\u2014']));
ok('a terse officer with one good line in a three-line body is readable',
    S.bodyIsReadable(['I made contact with the reporting party in the driveway.']));
ok('one good line among twenty is the failure signature, not a terse officer',
    !S.bodyIsReadable(['I made contact with the reporting party in the driveway.',
        'EE', '-\u2014', 'A PTA', 'Ce', 'EE', 'aoe']));

eq('junkRatio() counts rows carrying no readable word',
    S.junkRatio(['one two three four', 'EE', '--', 'Ce']), 0.75);
eq('junkRatio() of clean prose is zero',
    S.junkRatio(['She stated she had left for work', 'and returned at noon']), 0);
eq('junkRatio() of nothing is zero', S.junkRatio([]), 0);

eq('paragraphize() breaks between two sentences',
    S.paragraphize(['He arrived at 0900 hours.', 'She was not home.']),
    'He arrived at 0900 hours.\n\nShe was not home.');
eq('paragraphize() does NOT break after a title',
    S.paragraphize(['I then spoke with Ms.', 'Barber at the front door.']),
    'I then spoke with Ms.\nBarber at the front door.');
eq('paragraphize() does not break mid-sentence',
    S.paragraphize(['He walked up to the', 'door and knocked twice.']),
    'He walked up to the\ndoor and knocked twice.');
eq('paragraphize() preserves the printed line break verbatim',
    S.paragraphize(['Line one ends here.', 'and line two is lower case.']),
    'Line one ends here.\nand line two is lower case.');

/* ================================================================
 * 3. Names
 * ================================================================ */
console.log('\n[names]');

ok('a surname is a name token', S.isNameToken('ABERNATHY'));
ok('a juvenile alias is a name token', S.isNameToken('(JV2)'));
/* A SINGLE parenthesised letter is a checkbox option code, not an alias.
 * On a digital print of the Arkansas form the sex column sits right beside
 * the name with nothing between them, and "JUAREZ, STACY ANN  (F) Female"
 * imported as the name "JUAREZ, STACY ANN (F)". */
ok('a lone parenthesised letter is NOT a name token', !S.isNameToken('(F)'));
ok('...nor is the race column', !S.isNameToken('(W)'));
eq('so the sex column never joins the name',
    S.extractName('JUAREZ, STACY ANN  (F) Female  (00) Unknown  (W) White'),
    'JUAREZ, STACY ANN');
ok('a form label is never a name token', !S.isNameToken('VICTIM'));
ok('a two-letter checkbox glyph is never a name token', !S.isNameToken('Bl'));
ok('...nor is OJ', !S.isNameToken('OJ'));
ok('an initial WITH a full stop is a name token', S.isNameToken('J.'));
ok('a bare capital on its own is not', !S.isNameToken('J'));
ok('a lower-case token is not a name token', !S.isNameToken('mcdonald'));

ok('a bare capital after a given name is a middle initial', S.isMiddleInitial('Z', undefined));
ok('...but not when an option code follows it', !S.isMiddleInitial('I', '(0)'));
ok('a whole word is not a middle initial', !S.isMiddleInitial('Zed', 'x'));

eq('extractName() reads a name out of checkbox wreckage',
    S.extractName('VANDERLINDE (JV3), EMMETT \u00a35 (F) Female OJ 0) Unknown'),
    'VANDERLINDE (JV3), EMMETT');
eq('extractName() stops at the date printed beside the name',
    S.extractName('HOLLOWAY (JV2), MARISOL 08/31/2011'),
    'HOLLOWAY (JV2), MARISOL');
eq('extractName() keeps an unpunctuated middle initial',
    S.extractName('WINN, WESTON Z'), 'WINN, WESTON Z');
eq('an address is not a person', S.extractName('148 RODEN MILL RD, Conway, AR 72032'), null);
eq('a line with no comma yields no name', S.extractName('NARRATIVE CONTINUED'), null);

eq('aliasOf() lifts the juvenile token', S.aliasOf('HOLLOWAY (JV2), MARISOL'), 'JV2');
eq('aliasOf() of a plain name is empty', S.aliasOf('Halvorsen, Dana Rae'), '');

/* ================================================================
 * 4. Address
 * ================================================================ */
console.log('\n[address]');

eq('the sequence column is stripped off a packed address row',
    S.stripLeadingColumnDigit('1 164 S COKER RD, Vilonia, AR 72173'),
    '164 S COKER RD, Vilonia, AR 72173');
eq('"1 Main St" is a real address and survives untouched',
    S.stripLeadingColumnDigit('1 Main St'), '1 Main St');

eq('scanAddress() finds the resident address',
    S.scanAddress(['NAME: HOLLOWAY (JV2), MARISOL',
        '912 THISTLEDOWN LN, Bellefonte, AR 72611'], 0, 2),
    '912 THISTLEDOWN LN, Bellefonte, AR 72611');
eq('scanAddress() skips where the ARREST happened',
    S.scanAddress(['ARREST LOCATION',
        '100 JAIL RD, Conway, AR 72032',
        '',
        '912 THISTLEDOWN LN, Bellefonte, AR 72611'], 0, 4),
    '912 THISTLEDOWN LN, Bellefonte, AR 72611');
eq('scanAddress() returns nothing rather than a guess',
    S.scanAddress(['NAME: Halvorsen, Dana Rae', 'DOB 11/04/1992'], 0, 2), '');

/* ================================================================
 * 5. Identity shapes — the 5.2.4 core
 * ================================================================ */
console.log('\n[identity shapes]');

eq('identityTokens() folds a bracketed phone into ONE token',
    S.identityTokens('(501) 472-5938 AR 12345'), ['(501)472-5938', 'AR', '12345']);
eq('identityTokens() of a blank row is empty', S.identityTokens('   '), []);

ok('a seven-digit licence number is licence-shaped', S.looksLikeDlNumber('9902336'));
ok('an alphanumeric licence number is licence-shaped', S.looksLikeDlNumber('WDL4471820'));
ok('a ZIP code is not a licence number', !S.looksLikeDlNumber('72032'));
ok('a ZIP+4 is not a licence number', !S.looksLikeDlNumber('72032-1180'));
ok('an SSN is not a licence number', !S.looksLikeDlNumber('432-11-9087'));
ok('an incident number is not a licence number', !S.looksLikeDlNumber('26-0905538'));
ok('a phone number is not a licence number', !S.looksLikeDlNumber('(501)459-8925'));
ok('a date of birth is not a licence number', !S.looksLikeDlNumber('08/13/2026'));
ok('letters alone are not a licence number', !S.looksLikeDlNumber('ARKANSAS'));
ok('four characters are too few', !S.looksLikeDlNumber('1234'));

eq('stateTokenAt() finds a standalone state code',
    S.stateTokenAt(['9902336', 'AR', '09/11/1996']), 1);
eq('a two-letter token carrying a digit is not a state',
    S.stateTokenAt(['A1', 'TX2']), -1);
eq('stateTokenAt() returns -1 when no state is printed',
    S.stateTokenAt(['9902336', '09/11/1996']), -1);

(function identityRow() {
    const p = { ssn: '', dl: '', dlState: '', phone: '', employmentPhone: '' };
    S.harvestIdentityRow([
        "SOC. SEC. NO. DRIVER'S LICENSE DR. LI. STATE DATE OF BIRTH",
        '=',
        '432-11-9087 9902336 AR 09/11/1996'
    ], 0, 3, p);
    eq('harvestIdentityRow() reads the SSN', p.ssn, '432-11-9087');
    eq('...the licence number immediately LEFT of the state code', p.dl, '9902336');
    eq('...and the state code itself', p.dlState, 'AR');
})();

(function identityRowNoLicence() {
    const p = { ssn: '', dl: '', dlState: '', phone: '', employmentPhone: '' };
    S.harvestIdentityRow([
        "SOC. SEC. NO. DRIVER'S LICENSE DR. LI. STATE DATE OF BIRTH",
        '432-11-9087 09/11/1996'
    ], 0, 2, p);
    eq('a blank licence cell yields no licence', p.dl, '');
    eq('...and no jurisdiction is invented for it', p.dlState, '');
})();

(function twoPhones() {
    const p = { ssn: '', dl: '', dlState: '', phone: '', employmentPhone: '' };
    S.harvestIdentityRow(['RESIDENT PHONE EMPLOYMENT PHONE',
        '(501) 459-8925 (501) 555-0143'], 0, 2, p);
    eq('the first printed number is the resident phone', p.phone, '(501) 459-8925');
    eq('the second is the employment phone', p.employmentPhone, '(501) 555-0143');
})();

(function onePhone() {
    const p = { ssn: '', dl: '', dlState: '', phone: '', employmentPhone: '' };
    S.harvestIdentityRow(['RESIDENT PHONE EMPLOYMENT PHONE',
        '(501) 459-8925'], 0, 2, p);
    eq('one number under two labels is the resident phone', p.phone, '(501) 459-8925');
    eq('...and an employer phone is NOT claimed from it', p.employmentPhone, '');
})();

/* ================================================================
 * 6. Pages
 * ================================================================ */
console.log('\n[pages]');

(function authoritative() {
    // The exact contract: extract-pdf-text builds its flat text as
    // pages.join('\n') + '\n'.
    const pageTexts = ['alpha\nbravo', 'charlie'];
    const lines = S.lines(pageTexts.join('\n') + '\n');
    const r = S.pagesFromTexts(lines, pageTexts);
    ok('a reconciling page array is accepted', !!r);
    eq('...and gives one page per PDF page', r.pages.length, 2);
    eq('...numbered from one', r.pages.map(p => p.index), [1, 2]);
    eq('...with the real line bounds', r.bounds, [[0, 2], [2, 3]]);
    eq('...flagged authoritative', r.authoritative, true);
    eq('...page one holds page one\'s lines', r.pages[0].lines, ['alpha', 'bravo']);
})();

(function mismatch() {
    const lines = S.lines('alpha\nbravo\ncharlie\n');
    ok('a page array whose TEXT differs is rejected outright',
        S.pagesFromTexts(lines, ['alpha\nbravo', 'zulu']) === null);
    ok('a SHORT page array is rejected rather than truncated',
        S.pagesFromTexts(lines, ['alpha\nbravo']) === null);
    ok('a LONG page array is rejected too',
        S.pagesFromTexts(lines, ['alpha\nbravo', 'charlie', 'delta']) === null);
})();

(function banners() {
    const lines = ['line one', 'line two', 'line three', 'line four', 'line five',
        'line six', 'CONTINUATION PAGE', 'tail one', 'tail two'];
    const r = S.pagesFromBanners(lines, S.isPageBreak);
    eq('the printed banner splits the pages', r.pages.length, 2);
    eq('...and page two knows it is a continuation', r.pages[1].isContinuation, true);
    eq('...inference is never flagged authoritative', r.authoritative, false);
})();

(function bannerStub() {
    // Page 1's title usually dies inside the grid; when it DOES survive as a
    // standalone line it must not become a phantom page of its own.
    const r = S.pagesFromBanners(['INCIDENT REPORT', 'body one', 'body two',
        'CONTINUATION PAGE', 'tail one'], S.isPageBreak);
    eq('a surviving page-1 title is folded forward, not counted', r.pages.length, 1);
})();

(function dispatch() {
    const pageTexts = ['alpha\nbravo', 'charlie'];
    const lines = S.lines(pageTexts.join('\n') + '\n');
    const good = S.splitPages(lines, pageTexts, S.isPageBreak);
    eq('splitPages() prefers the real page array', good.authoritative, true);
    eq('...and says nothing when it reconciles', good.warning, '');

    const bad = S.splitPages(lines, ['alpha\nbravo', 'zulu'], S.isPageBreak);
    eq('a page array that will not reconcile falls back to the banners',
        bad.authoritative, false);
    ok('...and the officer is TOLD page numbers may be off',
        /off by a page/.test(bad.warning), bad.warning);

    const none = S.splitPages(lines, null, S.isPageBreak);
    eq('with no page array at all, the banners are used silently',
        [none.authoritative, none.warning], [false, '']);
})();

/* ================================================================
 * Location of occurrence
 * ================================================================
 * Westminster PD asked for the "Incident Location" on page 1 of their
 * Initial Incident Report to land in the case instead of being retyped.
 * This reader is shared by both import entry points — the create-case form
 * in index.html and the RMS tab's parseRmsReport wrapper — so the same PDF
 * produces the same address either way.
 *
 * The addresses below are taken from the extracts in sample-data/, which
 * are the real reference documents' text layers.
 */
console.log('\n[location of occurrence]');

(function normalise() {
    // The address is carried VERBATIM. Only the damage the PDF text layer
    // does to a table cell is repaired.
    eq('column gaps inside a cell collapse',
        S.normalizeLocation('7421 BEACH CT  Westminster, CO  80031'),
        '7421 BEACH CT Westminster, CO 80031');
    eq('a space before a comma is closed up',
        S.normalizeLocation('17005 UPLAND AV , FONTANA, CA 92335'),
        '17005 UPLAND AV, FONTANA, CA 92335');
    eq('a missing space after a comma is opened up',
        S.normalizeLocation('9 ELM ST,Aurora,CO 80010'),
        '9 ELM ST, Aurora, CO 80010');
    eq('a semicolon separator is spaced the same way',
        S.normalizeLocation('1600 S CONRAD AVE;COVINGTON VA 24426'),
        '1600 S CONRAD AVE; COVINGTON VA 24426');
    eq('non-breaking space is whitespace too',
        S.normalizeLocation('9 ELM\u00a0ST'), '9 ELM ST');
    eq('nothing in, nothing out', S.normalizeLocation(null), '');
    eq('the street name itself is never touched',
        S.normalizeLocation('  SANTA ANA AV & ELM AV , FON, CA 92337  '),
        'SANTA ANA AV & ELM AV, FON, CA 92337');
})();

(function shapes() {
    ok('a street address is address-shaped',
        S.looksLikeAddressValue('1600 S CONRAD AVE; COVINGTON VA 24426'));
    ok('so is an intersection',
        S.looksLikeAddressValue('SANTA ANA AV & ELM AV , FON, CA 92337'));
    ok('so is a block reference',
        S.looksLikeAddressValue('700 BLOCK OF W 92ND AVE'));
    ok('a bare NIBRS location code is NOT an address',
        !S.looksLikeAddressValue('25'), '25');
    ok('nor is a place name with no number, under the ambiguous label',
        !S.looksLikeAddressValue('FORT YOUNG'), 'FORT YOUNG');
    ok('nor is an empty value', !S.looksLikeAddressValue(''));
})();

(function labelled() {
    const r = S.findLocation('Event Information\nOccurred From\n11/18/2023\n' +
        'Incident Location\n7421 BEACH CT  Westminster, CO  80031\nBeat\n');
    eq('Westminster: the Incident Location cell is read',
        r.value, '7421 BEACH CT Westminster, CO 80031');
    eq('...under the label it was printed with', r.label, 'Incident Location');
    eq('...and a specific label is believed outright', r.confidence, 'labelled');

    const va = S.findLocation('OFFENSE\nLocation Address\n1600 S CONRAD AVE; COVINGTON VA 24426\n');
    eq('Virginia: Location Address is read',
        va.value, '1600 S CONRAD AVE; COVINGTON VA 24426');
    eq('...as a labelled read', va.confidence, 'labelled');

    const ar = S.findLocation('OFFENSE #1\nADDRESS OF OFFENSE\n9 ELM ST, Conway, AR 72032\n');
    eq('Arkansas: ADDRESS OF OFFENSE is the location of occurrence',
        ar.value, '9 ELM ST, Conway, AR 72032');

    eq('the same label works inline',
        S.findLocation('Incident Location: 123 MAIN ST, DENVER, CO 80202\n').value,
        '123 MAIN ST, DENVER, CO 80202');

    eq('a blank line between label and value is stepped over',
        S.findLocation('Incident Location\n\n7421 BEACH CT  Westminster, CO  80031\n').value,
        '7421 BEACH CT Westminster, CO 80031');

    // A location of occurrence is not always an address, and under a label
    // that says so outright we take the officer at their word.
    eq('free text under a specific label is accepted as written',
        S.findLocation('Location of Occurrence\nBehind the Safeway on 72nd\n').value,
        'Behind the Safeway on 72nd');

    eq('Location of Offense spells either way',
        S.findLocation('Location of Offence\n9 ELM ST, Aurora, CO 80010\n').value,
        '9 ELM ST, Aurora, CO 80010');
})();

(function inferred() {
    // The Fontana-style INFORM report labels it with a bare "Location".
    const f = S.findLocation('Event Information\nLocation\n17005 UPLAND AV , FONTANA, CA 92335\nBeat\n5\n');
    eq('a bare Location that holds an address is read',
        f.value, '17005 UPLAND AV, FONTANA, CA 92335');
    eq('...but only ever as an inferred read', f.confidence, 'inferred');

    eq('an intersection under the bare label still reads',
        S.findLocation('Location\nSANTA ANA AV & ELM AV , FON, CA 92337\n').value,
        'SANTA ANA AV & ELM AV, FON, CA 92337');
})();

(function theFalsePositive() {
    /* The single reason the bare label needs a shape check at all.
     * sample-data/_field_incident.txt carries, inside the OFFENSE block:
     *     Location
     *     25
     *     Location Name
     *     FORT YOUNG
     * "25" is a NIBRS location CODE. Importing it as the place the offence
     * happened would put a number in the officer's Location field and look
     * like the import had mangled the report. */
    const bad = 'OFFENSE\nLocation\n25\nLocation Name\nFORT YOUNG\nDescription\nASSAULT\n';
    eq('a NIBRS location code is not imported as a location',
        S.findLocation(bad).value, '');
    eq('"Location Name" is a different fact and is never read',
        S.findLocation('Location Name\nFORT YOUNG\n').value, '');
    eq('nor is Location Code', S.findLocation('Location Code\n25\n').value, '');
    eq('nor is Location Type', S.findLocation('Location Type\nResidence\n').value, '');
})();

(function precedence() {
    // A Westminster bundle can carry an Adult Arrest Report whose arrest
    // location is a jail, not the scene.
    eq('an arrest location is never mistaken for the scene',
        S.findLocation('Arrest Location\n55 JAIL RD, Denver, CO 80202\n').value, '');
    eq('nor a booking location',
        S.findLocation('Booking Location\n55 JAIL RD, Denver, CO 80202\n').value, '');
    eq('nor a cell tower location',
        S.findLocation('Cell Tower Location\n9 ELM ST, Aurora, CO 80010\n').value, '');

    const both = 'Location\n17005 UPLAND AV, FONTANA, CA 92335\n' +
        'Incident Location\n9 ELM ST, Aurora, CO 80010\n';
    eq('a specific label later in the document beats an earlier bare one',
        S.findLocation(both).value, '9 ELM ST, Aurora, CO 80010');
    eq('...and reports itself as the labelled read',
        S.findLocation(both).confidence, 'labelled');

    const firstWins = 'Incident Location\n9 ELM ST, Aurora, CO 80010\n' +
        'Incident Location\n123 MAIN ST, DENVER, CO 80202\n';
    eq('between two identical labels the first one wins',
        S.findLocation(firstWins).value, '9 ELM ST, Aurora, CO 80010');
})();

(function emptyHanded() {
    // Reading nothing is a valid answer. The field is left blank for the
    // officer rather than filled with the next line off the form.
    eq('a label with the next form label under it reads nothing',
        S.findLocation('Incident Location\nOffense(s)\nSUSPECT\n').value, '');
    eq('a label with a page footer under it reads nothing',
        S.findLocation('Incident Location\nPage 1 of 3\n').value, '');
    eq('a label at the very end of the document reads nothing',
        S.findLocation('Beat\n5\nIncident Location\n').value, '');
    eq('a report with no location label at all reads nothing',
        S.findLocation('Narrative\nOn the above date I responded.\n').value, '');
    eq('empty text reads nothing', S.findLocation('').value, '');
    eq('null reads nothing', S.findLocation(null).value, '');
    eq('...and the empty answer carries no confidence claim',
        S.findLocation(null).confidence, '');
})();

/* ================================================================ */
console.log('\n' + (fail ? 'FAILED' : 'OK') + ' \u2014 ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
