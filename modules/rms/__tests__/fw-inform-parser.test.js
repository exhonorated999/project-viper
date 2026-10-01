/*
 * INFORM RMS — Fort Worth (TX) style incident report — unit tests.
 *
 * Run: node modules\rms\__tests__\fw-inform-parser.test.js
 * (pure module, no native deps)
 *
 * WHY THIS EXISTS
 *
 * The reader for this form was written against a redacted structural
 * sample rather than the report itself, so almost every rule in it is a
 * measurement that has to keep holding. Three of them would do real
 * damage if they quietly stopped working:
 *
 *   - the wrap rule. The form splits a date of birth across two lines as
 *     "04/17/19" and "82". Read the first line alone and every person in
 *     the report is born in 1919.
 *
 *   - the multi-label cell. Where a row of column headings is left empty
 *     the labels arrive back to back with one value at the end. Pair them
 *     off one-to-one and every field in the cell is attributed to the
 *     wrong heading.
 *
 *   - the furniture strip. The agency header arrives after its own page
 *     rule and the final page's header has no footer under it. Get the
 *     bookkeeping wrong and either the footer is never found or a page of
 *     letterhead is read as case data.
 *
 * The fixture is SYNTHETIC. The submitted sample carried a real officer's
 * name and a real address, so nothing from it is in this repository; the
 * fixture reproduces the layout with invented values and deliberately
 * includes every hard construct measured in the original.
 */
const fs = require('fs');
const path = require('path');
const FW = require(path.join(__dirname, '..', 'fw-inform-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fw-inform-incident.synthetic.txt');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const R = FW.parse(TEXT, 'fw-inform-incident.synthetic.txt');
const SPLIT = FW.splitPages(TEXT);

const personBy = (role, frag) => R.personsInvolved.filter(
    p => p.involvement === role && p.name.indexOf(frag) >= 0)[0] || null;

/* ====================================================================== *
 * recognising the report
 * ====================================================================== */
console.log('\n[recognising the report]');

ok('the Fort Worth report is recognised', FW.detect(TEXT) === true);
ok('empty input is not', FW.detect('') === false);
ok('null input is not', FW.detect(null) === false);
ok('a page rule on its own is not enough',
    FW.detect('Page1 of 4\nsome other report entirely') === false);
ok('the roster headings on their own are not enough',
    FW.detect('Invl NO\nNature of Call\nno page rule here') === false);
ok('an Arkansas NIBRS report is not claimed',
    FW.detect('ARKANSAS INCIDENT REPORT\nNAME: Last, First\nUCR CODE\nPage 1 of 9') === false);
ok('the page rule is required even with everything else',
    FW.detect(TEXT.replace(/^Page\d+ of 4$/gm, '')) === false);

/* ====================================================================== *
 * pages and furniture
 *
 * The header of page N arrives AFTER page N's rule line, and whatever
 * follows the LAST rule line is a header with no footer under it. Both
 * facts are load bearing.
 * ====================================================================== */
console.log('\n[pages and furniture]');

ok('every page is found', SPLIT.pages.length === 4, SPLIT.pages.length);
ok('the printed page count is read off the rule line', SPLIT.declaredPages === 4,
    SPLIT.declaredPages);
ok('a page rule was seen for each page', SPLIT.marks === 4, SPLIT.marks);
ok('the repeated header is measured, not guessed', SPLIT.header.length > 10,
    SPLIT.header.length);
ok('the repeated footer is found', SPLIT.footer.length > 2, SPLIT.footer.length);
ok('the header is the agency letterhead',
    SPLIT.header.join('|').indexOf('505 W FELIX ST') >= 0);
ok('the footer is the signature line',
    SPLIT.footer.join('|').indexOf('Printed At') >= 0);

const bodyText = SPLIT.pages.map(p => p.join('\n')).join('\n');
ok('the letterhead is stripped out of every page body',
    bodyText.indexOf('505 W FELIX ST') < 0);
ok('the phone number on the letterhead is stripped too',
    bodyText.indexOf('(817) 555-0100') < 0);
ok('the page rule itself never reaches the body',
    /Page\s*\d+\s*of\s*\d+/.test(bodyText) === false);
ok('the trailing orphan header is not kept as a fifth page',
    SPLIT.pages.length === SPLIT.declaredPages, SPLIT.pages.length);
ok('page 1 still holds the cover data', SPLIT.pages[0].join('\n').indexOf('Case Number') >= 0);
ok('the last page still holds its narrative',
    SPLIT.pages[3].join('\n').indexOf('Narrative') >= 0);

/* a one-page document must not lose its only page to furniture detection */
const ONEPAGE = 'Case Number\n2024-1\n\nInvl\nSUS\n\nName\nDOE JOHN\n\nPage1 of 1\n';
ok('a single-page report keeps its page', FW.splitPages(ONEPAGE).pages.length === 1,
    FW.splitPages(ONEPAGE).pages.length);
ok('a single-page report has no measurable header',
    FW.splitPages(ONEPAGE).header.length === 0);

/* ====================================================================== *
 * the wrap rule
 *
 * Concatenate verbatim: the text layer keeps the space where the line
 * broke at a word and keeps nothing where it broke mid-word.
 * ====================================================================== */
console.log('\n[the wrap rule]');

ok('a mid-word wrap is rejoined with nothing between',
    FW.joinWrapped(['20 ', 'RESIDENCE/HO', 'ME']) === '20 RESIDENCE/HOME',
    FW.joinWrapped(['20 ', 'RESIDENCE/HO', 'ME']));
ok('a word wrap keeps its space',
    FW.joinWrapped(['FELONY, ', '1ST DEGREE']) === 'FELONY, 1ST DEGREE');
ok('a five-line offence description comes back whole',
    FW.joinWrapped(['09A::09A ', 'MURDER & ', 'NON-', 'NEGLIGENT ', 'MANSLAUGHT', 'ER'])
    === '09A::09A MURDER & NON-NEGLIGENT MANSLAUGHTER');
ok('a code and its description rejoin', FW.joinWrapped(['S ', 'SINGLE']) === 'S SINGLE');
ok('a residency code rejoins mid-word',
    FW.joinWrapped(['R ', 'RESID', 'ENT']) === 'R RESIDENT');
ok('an unknown code rejoins mid-word',
    FW.joinWrapped(['U ', 'UNKNO', 'WN']) === 'U UNKNOWN');
ok('a split date of birth rejoins',
    FW.joinWrapped(['04/17/19', '82']) === '04/17/1982');
ok('a split SSN rejoins', FW.joinWrapped(['555889134', '0']) === '5558891340');
ok('an empty run joins to an empty string', FW.joinWrapped([]) === '');

/* ====================================================================== *
 * cells that hold more than one label
 * ====================================================================== */
console.log('\n[cells that hold more than one label]');

const weaponCell = FW.readCell(['#PR', 'MOE', 'ACT', 'Weapon/Force', '11']);
ok('a four-heading cell yields four pairs', weaponCell.length === 4, weaponCell.length);
ok('only the last heading in the cell takes the value',
    weaponCell[3].label === 'Weapon/Force' && weaponCell[3].value === '11',
    weaponCell[3]);
ok('the headings above it are blank, not duplicated',
    weaponCell[0].value === '' && weaponCell[1].value === '' && weaponCell[2].value === '');

const arrestedCell = FW.readCell(['Arrested', 'Written statement', 'N::NO']);
ok('Arrested is blank when the value belongs to Written statement',
    arrestedCell[0].label === 'Arrested' && arrestedCell[0].value === '');
ok('Written statement takes the value',
    arrestedCell[1].label === 'Written statement' && arrestedCell[1].value === 'N::NO');

const smtCell = FW.readCell(['SMT', 'Type SMT', 'Description', 'Location', 'NCICSMT', 'Active']);
ok('a cell of headings with no value at all yields them all', smtCell.length === 6,
    smtCell.length);
ok('and every one of them is blank',
    smtCell.every(c => c.value === ''));

const nameCell = FW.readCell(['Name', 'Estrada Fernando']);
ok('an ordinary label and value still pair up',
    nameCell.length === 1 && nameCell[0].value === 'Estrada Fernando', nameCell);

const wrappedValueCell = FW.readCell(['Alias', 'Rowan ', 'Thorn; ', 'Row ', 'Thornbury; ']);
ok('a wrapped value is never split into separate pairs',
    wrappedValueCell.length === 1, wrappedValueCell.length);
ok('and it rejoins correctly',
    wrappedValueCell[0].value === 'Rowan Thorn; Row Thornbury;',
    wrappedValueCell[0].value);

/* a label printed hard against its value with no space at all */
ok('a glued label is split off its value',
    JSON.stringify(FW.readCell(['Reportabletrue'])) ===
    JSON.stringify([{ label: 'Reportable', value: 'true' }]),
    FW.readCell(['Reportabletrue']));

/* ====================================================================== *
 * the unknown-heading guard
 *
 * The form prints headings this build has never been shown. Gluing one
 * onto the value above it corrupts the field; treating a wrapped value
 * fragment as a heading BLANKS the field. The trailing space is what
 * tells them apart.
 * ====================================================================== */
console.log('\n[the unknown-heading guard]');

ok('an unseen Title Case heading is recognised', FW.looksLikeHeading('Complexion') === true);
ok('a two-word heading is recognised', FW.looksLikeHeading('Skin Tone') === true);
ok('a trailing space means it is a wrapped value, not a heading',
    FW.looksLikeHeading('Angel ') === false);
ok('ALL CAPS is a value on this form, never a heading',
    FW.looksLikeHeading('MEDIUM') === false);
ok('anything with a digit is a value', FW.looksLikeHeading('Unit 4') === false);
ok('anything with punctuation is a value', FW.looksLikeHeading('Thornbury, Rowan') === false);
ok('a coded value is not a heading', FW.looksLikeHeading('No::No') === false);
ok('a sentence is not a heading',
    FW.looksLikeHeading('Officers were dispatched to the location') === false);
ok('an empty line is not a heading', FW.looksLikeHeading('') === false);

const unknownHeading = FW.readCell(['Build', 'Skin Tone', 'MEDIUM']);
ok('an unseen heading between a label and its value is honoured',
    unknownHeading.length === 2, unknownHeading.length);
ok('the known label above it is left blank rather than given the wrong value',
    unknownHeading[0].label === 'Build' && unknownHeading[0].value === '');
ok('and the unseen heading carries the value',
    unknownHeading[1].label === 'Skin Tone' && unknownHeading[1].value === 'MEDIUM');

const guarded = FW.readCell(['Division', 'Fort ', 'Worth or ', 'Unknown']);
ok('a wrapped value starting with a Title Case word is NOT taken as a heading',
    guarded.length === 1, guarded);
ok('and the value survives intact', guarded[0].value === 'Fort Worth or Unknown',
    guarded[0].value);

/* ====================================================================== *
 * coded values
 * ====================================================================== */
console.log('\n[coded values]');

ok('a code and description split apart',
    FW.splitCode('AQ::ACQUAINTANCE').code === 'AQ' &&
    FW.splitCode('AQ::ACQUAINTANCE').text === 'ACQUAINTANCE');
ok('a description that repeats its own code drops the repeat once',
    FW.splitCode('88::88 NONE (NO BIAS)').text === 'NONE (NO BIAS)',
    FW.splitCode('88::88 NONE (NO BIAS)').text);
ok('the raw string is kept', FW.splitCode('TX::TEXAS').raw === 'TX::TEXAS');
ok('a plain value passes through untouched',
    FW.splitCode('COMPLETED').text === 'COMPLETED' && FW.splitCode('COMPLETED').code === '');
ok('a code with no description falls back to the code',
    FW.splitCode('N::').text === 'N');
ok('several coded items become a readable list',
    FW.describeCoded('AQ::ACQUAINTANCE , ST::STRANGER') === 'ACQUAINTANCE, STRANGER',
    FW.describeCoded('AQ::ACQUAINTANCE , ST::STRANGER'));
ok('an uncoded value is returned as it was',
    FW.describeCoded('FULL BEARD') === 'FULL BEARD');

/* ====================================================================== *
 * addresses
 *
 * Only the filing code is dropped. Expanding "TX" out of "TX::TEXAS"
 * would mean carrying a table of every state, and guessing at a city
 * abbreviation would put a word in the address the report never said.
 * ====================================================================== */
console.log('\n[addresses]');

ok('the filing codes come off a full address',
    FW.readAddress('3226 LAS VEGAS TRL FW::FORT WORTH TX::TEXAS 76116::76116')
    === '3226 LAS VEGAS TRL FORT WORTH TEXAS 76116',
    FW.readAddress('3226 LAS VEGAS TRL FW::FORT WORTH TX::TEXAS 76116::76116'));
ok('no "::" is ever left behind',
    FW.readAddress('306 E SPRINGDALE LN GP::GRAND PRAIRIE TX::TEXAS 75052::75052')
        .indexOf('::') < 0);
ok('a plain address is untouched',
    FW.readAddress('1419 LAS VEGAS TRL') === '1419 LAS VEGAS TRL');
ok('an empty address stays empty', FW.readAddress('') === '');

/* ====================================================================== *
 * dates, times and heights
 * ====================================================================== */
console.log('\n[dates, times and heights]');

ok('a US date becomes ISO for the date input', FW.parseDate('09/25/2024') === '2024-09-25');
ok('a rejoined split date becomes ISO', FW.parseDate('04/17/1982') === '1982-04-17');
ok('an ISO date is left as it is', FW.parseDate('1986-06-30') === '1986-06-30');
ok('a date with a time on it still reads',
    FW.parseDate('09/25/2024 12:59:00 Wed') === '2024-09-25');
ok('a two-digit year is refused — on this form it means the line was cut in half',
    FW.parseDate('04/17/82') === '', FW.parseDate('04/17/82'));
ok('an impossible month is refused rather than guessed',
    FW.parseDate('13/40/2024') === '');
ok('text in a date field gives nothing back, not a wrong date',
    FW.parseDate('UNKNOWN') === '');
ok('the top half of a split date gives nothing back rather than a wrong year',
    FW.parseDate('04/17/19') === '', FW.parseDate('04/17/19'));

ok('a 24-hour clock is read', FW.parseTime('09/25/2024 12:59:00 Wed') === '12:59:00');
ok('a 12-hour clock keeps its meridiem', FW.parseTime('09/25/2024 1:03:15 PM') === '01:03:15 PM');
ok('a date with no clock gives no time', FW.parseTime('09/25/2024') === '');

ok('510 is read as five foot ten', FW.parseHeight('510') === '70');
ok('602 is read as six foot two', FW.parseHeight('602') === '74');
ok('505 is read as five foot five', FW.parseHeight('505') === '65');
ok('a quoted height is read', FW.parseHeight("5'10\"") === '70');
ok('a hyphenated height is read', FW.parseHeight('6-02') === '74');
ok('a plain inch count passes through', FW.parseHeight('70') === '70');
ok('text in the height field gives nothing', FW.parseHeight('MEDIUM') === '');

/* ====================================================================== *
 * the report header
 * ====================================================================== */
console.log('\n[the report header]');

ok('the case number is read', R.reportNumber === '2024-0092231', R.reportNumber);
ok('the report date is ISO', R.reportDate === '2024-09-25', R.reportDate);
ok('the agency is read off the letterhead',
    R.agencyName === 'FORT WORTH POLICE DEPARTMENT', R.agencyName);
ok('the location of occurrence is built from the address cells',
    R.location === '3226 LAS VEGAS TRL, FORT WORTH 76116', R.location);
ok('the beat is read', R.beat === 'L16', R.beat);
ok('the page count comes from the printed rule', R.pageCount === 4, R.pageCount);
ok('the format is tagged', R.rmsFormat === 'fw-inform', R.rmsFormat);
ok('the report type names the form', /INFORM/.test(R.reportType), R.reportType);
ok('the longer printed form of the nature of call wins',
    R.fw.natureOfCall === 'MURDER/CAPITAL MURDER/CRIMINAL NEGLIGENT HOMICIDE',
    R.fw.natureOfCall);
ok('the reporting officer is carried', R.fw.reportingOfficer === 'Harlan 4471, D 2215',
    R.fw.reportingOfficer);
ok('the printed-at stamp is carried', /09\/25\/2024/.test(R.fw.printedAt), R.fw.printedAt);
ok('the time of the offence is kept on fromDateTime',
    R.fromDateTime === '2024-09-25 12:59:00', R.fromDateTime);
ok('nothing from the report is thrown away', R.rawText.length === TEXT.length);
ok('the import raised no warnings', R.diagnostics.warnings.length === 0,
    R.diagnostics.warnings);

/* ====================================================================== *
 * offences
 * ====================================================================== */
console.log('\n[offences]');

ok('both offences are read', R.offenses.length === 2, R.offenses.length);

const o1 = R.offenses[0], o2 = R.offenses[1];
ok('the first statute is read', o1.statute === 'PC 19.02(c)', o1.statute);
ok('its description survives a five-line wrap',
    o1.description === 'MURDER & NON-NEGLIGENT MANSLAUGHTER', o1.description);
ok('its NIBRS code is split off the description', o1.ucrCode === '09A', o1.ucrCode);
ok('its degree is read', o1.degree === 'F1', o1.degree);
ok('its NCIC code is read', o1.ncic === '0901', o1.ncic);
ok('a felony is marked as one', o1.severity === 'FELONY', o1.severity);
ok('the premise survives a mid-word wrap', o1.premise === '20 RESIDENCE/HOME', o1.premise);
ok('attempted/complete is read', o1.attempted === 'COMPLETED', o1.attempted);
ok('the weapon is read', o1.weapon === '11 FIREARM', o1.weapon);
ok('the bias code is described', o1.bias === 'NONE (NO BIAS)', o1.bias);

ok('the second statute is read', o2.statute === 'PC 22.02(a)(2)', o2.statute);
ok('the second description is read', o2.description === 'AGGRAVATED ASSAULT', o2.description);
ok('the second NIBRS code is read', o2.ucrCode === '13A', o2.ucrCode);
ok('a second-degree felony is still a felony', o2.severity === 'FELONY', o2.severity);
ok('offences are numbered from one', o1.number === '1' && o2.number === '2');

/* The same offence is reprinted under every suspect. Three suspects
 * charged with one murder is ONE offence on the case. */
const dupPairs = FW.readPairs([
    'UCR/NIBRS Code', '09A::09A MURDER', '', 'Statute', 'PC 19.02(c)', '',
    'Photos', '', 'Comments', '', '',
    'UCR/NIBRS Code', '09A::09A MURDER', '', 'Statute', 'PC 19.02(c)', '',
    'Photos', '', 'Comments', ''
]);
ok('an offence printed twice is counted once', FW.readOffenses(dupPairs).length === 1,
    FW.readOffenses(dupPairs).length);

const noOffence = FW.readOffenses(FW.readPairs(['Name', 'DOE JOHN', '']));
ok('a page with no offence block yields no offences', noOffence.length === 0);

/* ====================================================================== *
 * people
 * ====================================================================== */
console.log('\n[people]');

ok('every person in the report is found', R.personsInvolved.length === 4,
    R.personsInvolved.length);
ok('both suspects are found',
    R.personsInvolved.filter(p => p.involvement === 'SUSPECT').length === 2);
ok('both victims are found',
    R.personsInvolved.filter(p => p.involvement === 'VICTIM').length === 2);
ok('nobody is imported without a name',
    R.personsInvolved.every(p => !!p.name));

const s1 = personBy('SUSPECT', 'FENWICK');
ok('the first suspect is found', !!s1);
ok('the name is carried exactly as printed', s1.name === 'FENWICK MARGARET OLIVE', s1.name);
ok('a date of birth split across two lines is read correctly',
    s1.dob === '1982-04-17', s1.dob);
ok('the age is read', s1.age === '42', s1.age);
ok('sex is spelled out from the detail block', s1.sex === 'FEMALE', s1.sex);
ok('race is spelled out from the detail block', s1.race === 'WHITE', s1.race);
ok('the height is converted to inches', s1.height === '70', s1.height);
ok('the weight is read', s1.weight === '160', s1.weight);
ok('hair colour is read', s1.hair === 'BROWN', s1.hair);
ok('eye colour is read', s1.eyes === 'HAZEL', s1.eyes);
ok('the address has its filing codes stripped',
    s1.address === '3226 LAS VEGAS TRL FORT WORTH TEXAS 76116', s1.address);
ok('the phone number is read', s1.phone === '(817) 555-0142', s1.phone);
ok('the email is read', s1.email === 'margaret.fenwick@example.com', s1.email);
ok('the driver licence number is split off its state', s1.dl === '41238876', s1.dl);
ok('the licence state is read', s1.dlState === 'TX', s1.dlState);
ok('marital status survives its wrap', s1.maritalStatus === 'S SINGLE', s1.maritalStatus);
ok('a relationship wrapped over four lines is read',
    s1.relationship === 'SIBLING (BROTHER OR SISTER)', s1.relationship);
ok('an unseen heading did not steal the Build field', s1.build === '', s1.build);
ok('Written statement, not Arrested, took the value in that cell',
    s1.arrested === '', s1.arrested);

const s2 = personBy('SUSPECT', 'ABERNATHY');
ok('the second suspect is found', !!s2);
ok('his split date of birth reads correctly', s2.dob === '1990-11-02', s2.dob);
ok('his height is converted', s2.height === '74', s2.height);
ok('a wrapped build is read', s2.build === 'AVERAGE BUILD', s2.build);
ok('facial hair is read', s2.facialHair === 'FULL BEARD', s2.facialHair);
ok('a wrapped SSN is rejoined', s2.ssn === '5558891340', s2.ssn);
ok('a wrapped SID is rejoined', s2.sid === 'TX19348052', s2.sid);
ok('the FBI number is read', s2.fbi === '27V245CPP', s2.fbi);
ok('his licence is read', s2.dl === '38812094' && s2.dlState === 'TX',
    { dl: s2.dl, st: s2.dlState });
ok('a wrapped ethnicity is read', s2.ethnicity === 'U UNKNOWN', s2.ethnicity);
ok('where Arrested has its own cell it takes the value', s2.arrested === 'NO', s2.arrested);
ok('his detail block was found on a later page', s2.sourcePage >= 3, s2.sourcePage);

const v1 = personBy('VICTIM', 'Thornbury');
ok('the first victim is found', !!v1);
ok('the detail block spelling of the name wins over the roster',
    v1.name === 'Thornbury, Rowan', v1.name);
ok('a wrapped alias list is read', v1.alias === 'Rowan Thorn; Row Thornbury;', v1.alias);
ok('the victim date of birth reads correctly', v1.dob === '1986-06-30', v1.dob);
ok('the victim height converts', v1.height === '65', v1.height);
ok('the means of attack is read', v1.meansOfAttack === 'Firearm', v1.meansOfAttack);
ok('a wrapped injury type is read', v1.typeOfInjury === 'APPARENT MINOR INJURY',
    v1.typeOfInjury);
ok('the victim type is read', v1.victimType === 'I', v1.victimType);
ok('the victim address is cleaned',
    v1.address === '1419 LAS VEGAS TRL FORT WORTH TEXAS 76116', v1.address);

const v2 = personBy('VICTIM', 'Calloway');
ok('a victim with no detail block is still imported from the roster', !!v2);
ok('and carries what the roster printed', v2.dob === '1997-02-09', v2.dob);
ok('the roster single-letter race is spelled out', v2.race === 'WHITE', v2.race);
ok('the roster single-letter sex is spelled out', v2.sex === 'FEMALE', v2.sex);
ok('and she is placed on the page the roster was on', v2.sourcePage === 2, v2.sourcePage);

/* the roster and the detail block are two printings of one person */
ok('a person listed in both places is not imported twice',
    R.personsInvolved.filter(p => p.name.indexOf('FENWICK') >= 0).length === 1);
ok('the nameless placeholder rows in the roster are not imported',
    R.personsInvolved.every(p => p.name !== 'I' && p.name !== 'SUS'));

/* ====================================================================== *
 * the narrative
 *
 * Printed twice — once in the front summary and once at the back, wrapped
 * to different widths. The officer should not read the same account
 * twice.
 * ====================================================================== */
console.log('\n[the narrative]');

ok('exactly one narrative survives the duplicate', R.narratives.length === 1,
    R.narratives.length);
ok('the narrative text is read', R.narratives[0].text.length > 200,
    R.narratives[0].text.length);
ok('the opening of the narrative is intact',
    R.narratives[0].text.indexOf('On 09/25/2024 at approximately 0059 hours') === 0,
    R.narratives[0].text.slice(0, 60));
ok('the body of the narrative is intact',
    R.narratives[0].text.indexOf('located one deceased male inside the front room') >= 0);
ok('the closing line is kept as its own paragraph',
    R.narratives[0].text.indexOf('\n\nSgt. Loughman #4532') > 0,
    R.narratives[0].text.slice(-40));
ok('no page furniture leaked into the narrative',
    R.narratives[0].text.indexOf('Printed At') < 0 &&
    R.narratives[0].text.indexOf('FELIX') < 0);
ok('the narrative is attributed to the reporting officer',
    R.narratives[0].officer === 'Harlan 4471, D 2215', R.narratives[0].officer);

/* ====================================================================== *
 * the shape the rest of VIPER expects
 *
 * The importer, the person tabs and the case overview all read this
 * object. Every one of these is a field another part of the app will
 * dereference without checking.
 * ====================================================================== */
console.log('\n[the shape the rest of VIPER expects]');

['id', 'fileName', 'importedAt', 'reportNumber', 'reportDate', 'reportType',
    'supplementNo', 'agencyName', 'location', 'offenses', 'personsInvolved',
    'provisionalPersons', 'vehicles', 'property', 'narratives', 'digital',
    'confidentialPersons', 'pageCount', 'rawText', 'diagnostics'
].forEach(k => ok('the report carries ' + k, Object.prototype.hasOwnProperty.call(R, k)));

ok('every array field really is an array',
    [R.offenses, R.personsInvolved, R.provisionalPersons, R.vehicles, R.property,
        R.narratives, R.digital, R.confidentialPersons].every(Array.isArray));
ok('narratives[].officer is a string, never null — the viewer prints it raw',
    R.narratives.every(n => typeof n.officer === 'string'));
ok('narratives[].text is a string', R.narratives.every(n => typeof n.text === 'string'));
ok('every person has an involvement string',
    R.personsInvolved.every(p => typeof p.involvement === 'string' && p.involvement));
ok('every date of birth is ISO, which is all <input type="date"> accepts',
    R.personsInvolved.every(p => !p.dob || /^\d{4}-\d{2}-\d{2}$/.test(p.dob)));
ok('every height is a plain inch count, which is what the form asks for',
    R.personsInvolved.every(p => !p.height || /^\d{2,3}$/.test(p.height)));
ok('no field was left as null or undefined',
    R.personsInvolved.every(p => Object.keys(p).every(k => p[k] !== null && p[k] !== undefined)));

/* the host router matches on these words — see routeRmsPersonsToTabs */
ok('suspects match the router pattern',
    R.personsInvolved.filter(p => /SUSPECT|ARRESTED|DEFENDANT/i.test(p.involvement)).length === 2);
ok('victims match the router pattern',
    R.personsInvolved.filter(p => /VICTIM/i.test(p.involvement) &&
        !/VICTIM'S|PARENT|GUARDIAN/i.test(p.involvement)).length === 2);
ok('the overview backfill has a location to write',
    typeof R.location === 'string' && R.location.length > 0);
ok('the overview backfill has an offence description to write',
    R.offenses.length > 0 && !!R.offenses[0].description);

/* ====================================================================== *
 * degenerate input
 * ====================================================================== */
console.log('\n[degenerate input]');

const empty = FW.parse('', 'empty.pdf');
ok('an empty document parses rather than throwing', !!empty);
ok('and reports that it found no offence',
    empty.diagnostics.warnings.some(w => /offence/i.test(w)));
ok('and reports that it found no narrative',
    empty.diagnostics.warnings.some(w => /narrative/i.test(w)));
ok('and still returns the arrays the UI iterates',
    Array.isArray(empty.personsInvolved) && Array.isArray(empty.offenses));

const headless = FW.parse('Page1 of 1\nNarrative\nSomething happened at the location today.\n',
    'x.pdf');
ok('a document with nothing but a narrative still returns it',
    headless.narratives.length === 1, headless.narratives.length);
ok('and does not invent a report number', headless.reportNumber === '',
    headless.reportNumber);

/* An unreadable person block is dropped, but the summary row near the
 * front of the report still names them — so the person survives the
 * import even when their own section could not be read. */
const nameless = FW.parse(TEXT.replace('SUSPECT 2: ABERNATHY COLE', 'SUSPECT 4:'), 'x.pdf');
ok('a block with no readable name is not imported as a person of its own',
    nameless.personsInvolved.length === 4, nameless.personsInvolved.length);
ok('the officer is told about it rather than it vanishing silently',
    nameless.diagnostics.warnings.some(w => /no readable name/i.test(w)),
    nameless.diagnostics.warnings);
const rescued = nameless.personsInvolved.filter(p => p.name.indexOf('ABERNATHY') >= 0)[0];
ok('the summary row still carries the person through', !!rescued);
ok('and it is the summary row that supplied them, not the unreadable block',
    !!rescued && rescued.sourcePage === 2, rescued && rescued.sourcePage);

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
