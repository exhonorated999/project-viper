/*
 * VIPER Scout — structural sample builder — unit tests.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd ^
 *          modules\parser-submission\__tests__\sample-builder.test.js
 *
 * WHY THIS EXISTS
 *
 * This module is the thing an officer runs over a live case file in order
 * to send us something. The modal it sits behind promises, in writing:
 *
 *     "No case content, narratives, names, or attachments are uploaded."
 *
 * Before 5.3.1 that promise was false. Two real submissions from a Fort
 * Worth officer were measured and both shipped a real person's name and a
 * real home address, by two independent routes:
 *
 *   1. The redactor's name patterns needed either a comma ("JONES, MARK")
 *      or proper case ("Mark Jones"). Police and DMV printouts use
 *      neither, so "YASMINE MEADOW SALACH" went out verbatim. The street
 *      suffix list was Title Case only, so "1600 WOODSIDE LN" did too.
 *
 *   2. The headings / label_tokens / vertical_labels channels were emitted
 *      with no redaction at all, bypassing every other safeguard.
 *
 * Those are the assertions in the "privacy" sections. They are not
 * cosmetic: this data lands in a Postgres table on a public-internet host.
 *
 * The second half of the file pins the UTILITY side. A redactor that
 * replaced everything with <REDACTED> would pass every privacy test and be
 * useless for writing a parser, so the tokens carry the *shape* of what
 * they removed, real form labels are protected from the name passes, and
 * layout_hints measures the page/furniture/wrap facts that building the
 * Fort Worth reader required by hand.
 *
 * Every name and address in this file is invented. Nothing from either real
 * submission is reproduced here.
 */
const fs = require('fs');
const path = require('path');
const sb = require(path.join(__dirname, '..', 'sample-builder.js'));
const I = sb._internal;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const section = (t) => console.log('\n== ' + t + ' ==');

const R = (s, opts) => I._redactExcerpt(s, opts);

/* ------------------------------------------------------------------ *
 * privacy — ALL-CAPS names                                            *
 * ------------------------------------------------------------------ */
section('privacy: ALL-CAPS names, the 5.3.1 leak');

ok('a three-word ALL-CAPS name does not survive',
    R('YASMINE MEADOW SALACH').indexOf('SALACH') < 0, R('YASMINE MEADOW SALACH'));
ok('a two-word ALL-CAPS name does not survive',
    R('MARTINEZ XAVIEN').indexOf('MARTINEZ') < 0, R('MARTINEZ XAVIEN'));
ok('and it reports how many words it removed',
    R('YASMINE MEADOW SALACH') === '<NAME CAPS x3>', R('YASMINE MEADOW SALACH'));
ok('the old comma form still works',
    R('JONES, MARK ANDREW') === '<NAME LAST, FIRST>', R('JONES, MARK ANDREW'));
ok('proper case still works',
    R('Mark Andrew Jones').indexOf('Jones') < 0, R('Mark Andrew Jones'));
ok('proper case WITH a comma works — the roster column layout',
    R('Thornbury, Rowan') === '<NAME Last, First>', R('Thornbury, Rowan'));

section('privacy: addresses in any case');

ok('an ALL-CAPS street address does not survive',
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033').indexOf('WOODSIDE') < 0,
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033'));
ok('and it describes which parts were present',
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033') === '<ADDRESS street+city+state+zip>',
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033'));
ok('an apartment number is recognised as a unit, not kept',
    R('3226 LAS VEGAS TRL, Apt# 173, FORT WORTH') === '<ADDRESS street+unit+city>',
    R('3226 LAS VEGAS TRL, Apt# 173, FORT WORTH'));
ok('a bare street address with no city is still removed',
    R('3226 LAS VEGAS TRL') === '<ADDRESS street>', R('3226 LAS VEGAS TRL'));
ok('an abbreviated suffix is matched case-insensitively — the actual 5.3.1 bug',
    R('742 EVERGREEN TER').indexOf('EVERGREEN') < 0, R('742 EVERGREEN TER'));
ok('Title Case addresses, which already worked, still work',
    R('742 Evergreen Terrace').indexOf('Evergreen') < 0, R('742 Evergreen Terrace'));

section('privacy: the other identifiers');

ok('an email goes', R('officer@example.gov') === '<EMAIL>', R('officer@example.gov'));
ok('an SSN goes', R('123-45-6789') === '<SSN>', R('123-45-6789'));
ok('a parenthesised phone goes',
    R('(817) 555-0134') === '<PHONE (NNN) NNN-NNNN>', R('(817) 555-0134'));
ok('a dashed phone goes',
    R('817-555-0134') === '<PHONE NNN-NNN-NNNN>', R('817-555-0134'));
ok('a date of birth goes', R('04/17/1982').indexOf('1982') < 0, R('04/17/1982'));
ok('an ISO date goes', R('1982-04-17') === '<DATE YYYY-MM-DD>', R('1982-04-17'));
ok('a licence number goes', R('DL 12345678').indexOf('12345678') < 0, R('DL 12345678'));

/* ------------------------------------------------------------------ *
 * privacy — the heading channel                                       *
 * ------------------------------------------------------------------ */
section('privacy: headings and labels are redacted too, not shipped raw');

ok('the module exposes the label-protection rule so this is testable',
    typeof I._protectableLabels === 'function');

// A one-off mixed-case value must never become a protected phrase, because
// a protected phrase is passed through untouched.
const pOnce = I._protectableLabels([{ label: 'Thornbury Rowan', count: 1 }]);
ok('a label seen once is not trusted (vertical-label rule)', pOnce.size === 0, [...pOnce]);
const pCaps = I._protectableLabels([{ label: 'MARTINEZ XAVIEN', count: 9 }]);
ok('an ALL-CAPS entry is never trusted as a label however often it repeats',
    pCaps.size === 0, [...pCaps]);
const pComma = I._protectableLabels([{ label: 'Trl, Apt# 173, FORT', count: 4 }]);
ok('an entry with a comma is not a label — this is what protected a home address',
    pComma.size === 0, [...pComma]);
const pDigits = I._protectableLabels([{ label: 'Apt# 1731', count: 4 }]);
ok('an entry with a long digit run is not a label', pDigits.size === 0, [...pDigits]);
const pStreet = I._protectableLabels([{ label: 'Las Vegas Trl', count: 4 }]);
ok('an entry ending in a street type is not a label', pStreet.size === 0, [...pStreet]);

const pGood = I._protectableLabels([{ label: 'Hair Color', count: 6 }]);
ok('a repeated mixed-case label IS trusted', pGood.has('Hair Color'), [...pGood]);
const pOneColon = I._protectableLabels([{ label: 'Expiration Date', count: 1 }], null, { minCount: 1 });
ok('a colon-derived label is trusted on a single occurrence — a one-page DMV ' +
   'printout prints every label exactly once',
    pOneColon.has('Expiration Date'), [...pOneColon]);

/* ------------------------------------------------------------------ *
 * privacy — label context for one-word names                          *
 * ------------------------------------------------------------------ */
section('privacy: a lone surname, which has no distinguishing shape');

ok('the label-context pass is exposed', typeof I._redactNameContextLines === 'function');

// "Harlan" and "Location" are the same shape. Only the label above resolves it.
const stacked = I._redactNameContextLines(['Reporting Officer', 'Harlan 4471, D 2215', 'Printed At']);
ok('a stacked name value is masked by its label',
    stacked.lines[1].indexOf('Harlan') < 0, stacked.lines[1]);
ok('the label itself is left alone', stacked.lines[0] === 'Reporting Officer', stacked.lines[0]);
ok('an unrelated following label is left alone',
    stacked.lines[2] === 'Printed At', stacked.lines[2]);

const inline = I._redactNameContextLines(['Reporting Officer: Harlan 4471']);
ok('an inline name value is masked', inline.lines[0].indexOf('Harlan') < 0, inline.lines[0]);
ok('the inline label survives', /^Reporting Officer:/.test(inline.lines[0]), inline.lines[0]);

const indexed = I._redactNameContextLines(['Victim 1: Thornbury, Rowan']);
ok('an INDEXED role label is recognised ("Victim 1:", not just "Victim:")',
    indexed.lines[0].indexOf('Thornbury') < 0, indexed.lines[0]);

const notName = I._redactNameContextLines(['Hair Color', 'BROWN']);
ok('a label that is not a name label does not get its value masked',
    notName.lines[1] === 'BROWN', notName.lines[1]);
ok('and nothing was collected to scrub from it', notName.nameWords.size === 0,
    [...notName.nameWords]);

ok('the words it masked are reported back for a document-wide sweep',
    stacked.nameWords.has('Harlan'), [...stacked.nameWords]);

section('privacy: the same surname again, with no label near it');

const sweep = I._redactNameContextLines(['Victim: Thornbury, Rowan', 'spoke with Thornbury;']);
const sweptText = I._scrubKnownNameWords(sweep.lines.join('\n'), sweep.nameWords);
ok('a bare surname in prose is removed once a label elsewhere identified it',
    sweptText.indexOf('Thornbury') < 0, sweptText);
ok('the scrub is a no-op when nothing was identified',
    I._scrubKnownNameWords('spoke with Thornbury;', new Set()) === 'spoke with Thornbury;');
ok('two-letter tokens are never swept document-wide — too common to be safe',
    !I._redactNameContextLines(['Officer', 'D Harlan']).nameWords.has('D'),
    [...I._redactNameContextLines(['Officer', 'D Harlan']).nameWords]);

/* ------------------------------------------------------------------ *
 * utility — shape-preserving tokens                                   *
 * ------------------------------------------------------------------ */
section('utility: tokens keep the shape of what they removed');

ok('a four-digit year and a two-digit year are distinguishable',
    R('04/17/1982') !== R('04/17/82'), [R('04/17/1982'), R('04/17/82')]);
ok('a four-digit year reads MM/DD/YYYY',
    R('04/17/1982') === '<DATE MM/DD/YYYY>', R('04/17/1982'));
ok('a two-digit year reads MM/DD/YY — on a form that always prints four, ' +
   'this is how a parser author learns the line was cut by a column wrap',
    R('04/17/82') === '<DATE MM/DD/YY>', R('04/17/82'));
ok('single-digit month and day are reported as such',
    R('4/7/1982') === '<DATE M/D/YYYY>', R('4/7/1982'));
ok('the separator is preserved',
    R('04-17-1982') === '<DATE MM-DD-YYYY>', R('04-17-1982'));

ok('a ZIP and a licence number are distinguishable',
    R('76116') !== R('12345678'), [R('76116'), R('12345678')]);
ok('digit width is reported', R('12345678') === '<NUM:8>', R('12345678'));
ok('a five-digit ZIP reports its width', R('76116') === '<NUM:5>', R('76116'));
ok('short digit runs are left alone — a row index or an age is not identifying',
    R('Age 41') === 'Age 41', R('Age 41'));

ok('the phone token carries the printed punctuation',
    R('(817) 555-0134').indexOf('(NNN) NNN-NNNN') > 0, R('(817) 555-0134'));
ok('name tokens carry the word count',
    R('ABERNATHY CALLOWAY') === '<NAME CAPS x2>', R('ABERNATHY CALLOWAY'));
ok('address tokens carry the component list',
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033').indexOf('street+city+state+zip') > 0,
    R('1600 WOODSIDE LN, CLEBURNE, TX 76033'));

/* ------------------------------------------------------------------ *
 * utility — structural text survives                                  *
 * ------------------------------------------------------------------ */
section('utility: structural ALL-CAPS text is not treated as a name');

const keeps = [
    'FORT WORTH POLICE DEPARTMENT',
    'MURDER/CAPITAL MURDER/CRIMINAL NEGLIGENT HOMICIDE',
    'OFFICIAL STATE GOVERNMENT USE ONLY',
    'NO VISIBLE INJURY',
    'NOT APPLICABLE',
    'RESIDENCE/HOME',
    'AGGRAVATED ASSAULT WITH A DEADLY WEAPON',
    'DRIVER LICENSE RECORD',
];
for (const k of keeps) ok('kept verbatim: ' + JSON.stringify(k), R(k) === k, R(k));

ok('the keep-list is a keep-list, so an unknown all-caps pair is removed, ' +
   'not kept — the failure mode is over-redaction, never a leak',
    R('ZZYTHE QUORBAN') === '<NAME CAPS x2>', R('ZZYTHE QUORBAN'));
ok('a state name is not read as a surname and forename',
    R('Cleburne, Texas') === 'Cleburne, Texas', R('Cleburne, Texas'));

section('utility: an agency\'s own vocabulary, learned by repetition');

ok('the safe-word rule is exposed', typeof I._safeCapsWords === 'function');
const sw = I._safeCapsWords([{ heading: 'FORT WORTH POLICE DEPARTMENT', count: 11 }]);
ok('words from a heading printed on every page are trusted',
    sw.has('WORTH') && sw.has('FORT'), [...sw]);
const swRare = I._safeCapsWords([{ heading: 'ESTRADA FERNANDA YAMILET', count: 2 }]);
ok('words from a heading printed twice are NOT trusted — measured, every ' +
   'leaked name appeared once or twice and the agency header eleven times',
    swRare.size === 0, [...swRare]);
const swMixed = I._safeCapsWords([{ heading: 'Hair Color', count: 9 }]);
ok('a mixed-case heading is left to the label rule', swMixed.size === 0, [...swMixed]);

ok('"WORTH" alone survives once the agency header has been seen',
    R('City FORT WORTH', { safeWords: sw }) === 'City FORT WORTH',
    R('City FORT WORTH', { safeWords: sw }));
ok('but not without it — an unlearned word is still treated as a possible name',
    R('City FORT WORTH') !== 'City FORT WORTH', R('City FORT WORTH'));

/* ------------------------------------------------------------------ *
 * utility — label protection end to end                               *
 * ------------------------------------------------------------------ */
section('utility: protected labels survive the name passes');

const protect = new Set(['Hair Color', 'Reporting Officer', 'Expiration Date']);
ok('an unprotected two-word label looks exactly like a name and is removed',
    R('Hair Color') === '<NAME Caps x2>', R('Hair Color'));
ok('a protected label is passed through — 18 of 60 detected labels were ' +
   'being destroyed this way, which is what made the samples hard to read',
    R('Hair Color', { protect }) === 'Hair Color', R('Hair Color', { protect }));
ok('protection applies inside a longer line',
    R('Reporting Officer: Harlan', { protect }).indexOf('Reporting Officer') === 0,
    R('Reporting Officer: Harlan', { protect }));
ok('protecting the label does not protect its value',
    R('Reporting Officer: Harlan Smith', { protect }).indexOf('Harlan') < 0,
    R('Reporting Officer: Harlan Smith', { protect }));
ok('a protected label does not shield an address sitting next to it',
    R('Hair Color 1600 WOODSIDE LN', { protect }).indexOf('WOODSIDE') < 0,
    R('Hair Color 1600 WOODSIDE LN', { protect }));

/* ------------------------------------------------------------------ *
 * layout hints                                                        *
 * ------------------------------------------------------------------ */
section('layout hints: the measurements that writing a parser needs');

ok('layout hints are exposed', typeof I._layoutHints === 'function');

const FIXTURE = path.join(__dirname, '..', '..', 'rms', 'fixtures', 'fw-inform-incident.synthetic.txt');
ok('the Fort Worth layout fixture is available to measure against', fs.existsSync(FIXTURE));
const rawLines = fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n').split('\n');
const H = I._layoutHints(rawLines, {});

ok('page markers are found at all', H.page_markers_found === 4, H.page_markers_found);
ok('the marker is reported without its page numbers',
    H.page_marker_example === 'Page N of 4', H.page_marker_example);
ok('the declared page total is read', H.pages_declared === 4, H.pages_declared);
ok('per-page line counts are reported', Array.isArray(H.page_line_counts) &&
    H.page_line_counts.length === 5, H.page_line_counts);

// This is the orphan-header fact. The last chunk has no marker under it.
ok('content after the final page marker is counted separately — on this form ' +
   'that tail is the next page\'s header, and folding it into the footer ' +
   'comparison stops the footer ever being found',
    H.trailing_lines_after_last_marker === 25, H.trailing_lines_after_last_marker);

ok('the repeating footer is detected', H.repeating_footer_lines === 6, H.repeating_footer_lines);
ok('no repeating header is claimed, because the header arrives AFTER the ' +
   'page rule on this form',
    H.repeating_header_lines === 0, H.repeating_header_lines);
ok('the echoed footer array agrees with the count it reports',
    H.repeating_footer.length === H.repeating_footer_lines,
    [H.repeating_footer.length, H.repeating_footer_lines]);
ok('and the echoed footer does not carry the officer\'s name out with it',
    !H.repeating_footer.some(l => /Harlan/.test(l)), H.repeating_footer);

ok('the wrap measurement is reported', !!H.wrap && typeof H.wrap.ends_mid_token_ratio === 'number');
ok('mid-token endings dominate on this form', H.wrap.ends_mid_token_ratio > 0.5,
    H.wrap.ends_mid_token_ratio);
ok('so the rejoin rule it states is plain concatenation — reading a wrapped ' +
   'date of birth without this gives every person a 1919 birth year',
    /concatenation/.test(H.wrap.likely_rule), H.wrap.likely_rule);

ok('multi-label cells are counted', H.multi_label_cells > 0, H.multi_label_cells);
ok('and the officer-facing warning about 1:1 pairing is present',
    /wrong record/.test(H.multi_label_warning || ''), H.multi_label_warning);
ok('the layout family is named', /stacked/.test(H.layout_family || ''), H.layout_family);
ok('stacked lines outnumber inline ones, which is why that family was chosen',
    H.stacked_label_lines > H.inline_label_value_lines,
    [H.stacked_label_lines, H.inline_label_value_lines]);

section('layout hints: a page marker with no space after "Page"');

ok('"Page1 of 4" is matched — requiring whitespace there found zero markers ' +
   'on a document that prints one on every page',
    I._layoutHints(['x', 'Page1 of 4', 'y', 'Page2 of 4']).page_markers_found === 2,
    I._layoutHints(['x', 'Page1 of 4', 'y', 'Page2 of 4']).page_markers_found);
ok('"Page 1 of 4" is matched too',
    I._layoutHints(['x', 'Page 1 of 4', 'y', 'Page 2 of 4']).page_markers_found === 2);
ok('a document with no markers reports none, rather than throwing',
    I._layoutHints(['just', 'some', 'lines']).page_markers_found === 0);
ok('an empty document is handled', !!I._layoutHints([]));

/* ------------------------------------------------------------------ *
 * privacy — the 5.3.9 CyberTip / people-search leak shapes            *
 * ------------------------------------------------------------------ */
// A CyberTip submission (Oct 2026) shipped a real name, a real street and
// an SSN's last four.  Each shape below reproduces one route, with
// invented values.
section('privacy: a middle initial no longer breaks an ALL-CAPS name');

ok('"FIRST M LAST" is removed whole',
    R('DORIAN Q THACKERY') === '<NAME CAPS x3>', R('DORIAN Q THACKERY'));
ok('with a full stop on the initial too',
    R('DORIAN Q. THACKERY').indexOf('THACKERY') < 0, R('DORIAN Q. THACKERY'));
ok('a run of bare initials is left alone — it identifies nobody',
    R('N Y N') === 'N Y N', R('N Y N'));

section('privacy: one recognised word no longer protects the whole run');

ok('"DRIVERS LICENSE" is kept and the name after it is not',
    R('ID Type: DRIVERS LICENSE DORIAN Q THACKERY') ===
        'ID Type: DRIVERS LICENSE <NAME CAPS x3>',
    R('ID Type: DRIVERS LICENSE DORIAN Q THACKERY'));
ok('a name BEFORE a recognised word goes too',
    R('NYLE THACKERY POSSIBLE RELATIVE').indexOf('THACKERY') < 0,
    R('NYLE THACKERY POSSIBLE RELATIVE'));
ok('a name between two recognised words goes',
    R('SUBJECT NYLE THACKERY RESIDENCE') === 'SUBJECT <NAME CAPS x2> RESIDENCE',
    R('SUBJECT NYLE THACKERY RESIDENCE'));

section('privacy: values the text extractor glued together');

const glued = 'DORIAN QUILL THACKERY THACKERY111 W ELM AVE, MILLBROOK, CO';
ok('a surname glued to a house number no longer defeats the address pass',
    !/THACKERY|ELM|MILLBROOK|111/.test(R(glued)), R(glued));
ok('and the address is still reported as an address',
    R(glued).indexOf('<ADDRESS street+city+state>') >= 0, R(glued));
const gluedDates = '12/01/202312/31/2025XXX-XX-4235XX/XX/1980';
ok('two dates glued end to end are both recognised',
    R(gluedDates).indexOf('<DATE MM/DD/YYYY><DATE MM/DD/YYYY>') === 0, R(gluedDates));
ok('the last four of a masked SSN go, even glued to a date',
    R(gluedDates).indexOf('4235') < 0, R(gluedDates));
ok('and the token says it was a masked SSN',
    R(gluedDates).indexOf('<SSN XXX-XX-NNNN>') >= 0, R(gluedDates));
ok('the year of a masked DOB goes',
    R(gluedDates).indexOf('1980') < 0 && R(gluedDates).indexOf('<DATE XX/XX/YYYY>') >= 0,
    R(gluedDates));
ok('an SSN glued to letters on both sides goes',
    R('SSN123-45-6789DOB').indexOf('6789') < 0, R('SSN123-45-6789DOB'));

section('privacy: network identifiers and coordinates');

ok('an IPv4 address goes', R('IP: 203.0.113.45') === 'IP: <IPV4>', R('IP: 203.0.113.45'));
ok('an IPv4 glued to the next cell goes',
    R('203.0.113.45USCO').indexOf('203') < 0, R('203.0.113.45USCO'));
ok('an IPv6 address goes',
    R('IP Address: 2001:db8:85a3::8a2e:370:7334') === 'IP Address: <IPV6>',
    R('IP Address: 2001:db8:85a3::8a2e:370:7334'));
ok('a MAC address goes',
    R('MAC 00:1a:2b:3c:4d:5e') === 'MAC <MAC>', R('MAC 00:1a:2b:3c:4d:5e'));
ok('a latitude / longitude goes',
    R('Geo: 38.1234,-104.5678') === 'Geo: <GEO>,<GEO>', R('Geo: 38.1234,-104.5678'));
ok('a clock time is NOT mistaken for an IPv6 — it is form structure',
    R('Login 17:43:39 UTC') === 'Login 17:43:39 UTC', R('Login 17:43:39 UTC'));

section('privacy: a name word learned once is swept everywhere');

const learnedSet = new Set();
R('ID Type: DRIVERS LICENSE DORIAN Q THACKERY', { learnInto: learnedSet });
ok('the redactor reports the name words it removed',
    learnedSet.has('THACKERY') && learnedSet.has('DORIAN'), Array.from(learnedSet));
ok('recognised words and initials are never reported as name words',
    !learnedSet.has('DRIVERS') && !learnedSet.has('LICENSE') && !learnedSet.has('Q'),
    Array.from(learnedSet));
ok('a lone surname on another line is swept with the document\'s words',
    R('Relative: THACKERY', { capsNameWords: learnedSet }).indexOf('THACKERY') < 0,
    R('Relative: THACKERY', { capsNameWords: learnedSet }));
ok('...including when it is glued to a number',
    R('THACKERY111', { capsNameWords: learnedSet }).indexOf('THACKERY') < 0,
    R('THACKERY111', { capsNameWords: learnedSet }));
ok('a recognised word passed in by mistake is still not swept',
    R('POLICE REPORT', { capsNameWords: new Set(['POLICE']) }) === 'POLICE REPORT',
    R('POLICE REPORT', { capsNameWords: new Set(['POLICE']) }));

section('utility: tokens are never rewritten by a later pass');

ok('a name token is not re-read as a name',
    R('JONES, MARK') === '<NAME LAST, FIRST>', R('JONES, MARK'));
ok('a date token is not re-read as a name',
    R('DOB 04/17/1982') === 'DOB <DATE MM/DD/YYYY>', R('DOB 04/17/1982'));
ok('a phone token is not re-read as a name',
    R('PHONE 817-555-0134') === 'PHONE <PHONE NNN-NNN-NNNN>', R('PHONE 817-555-0134'));
ok('many tokens in one excerpt all restore (index past 9)',
    R(Array(14).fill('04/17/1982').join(' ')) === Array(14).fill('<DATE MM/DD/YYYY>').join(' '),
    R(Array(14).fill('04/17/1982').join(' ')));

section('utility: agency names and offence wording survive the split');

ok('an agency name before POLICE is kept',
    R('MILLBROOK POLICE DEPARTMENT') === 'MILLBROOK POLICE DEPARTMENT',
    R('MILLBROOK POLICE DEPARTMENT'));
ok('...and before SHERIFF\'S OFFICE',
    R("ALDER COUNTY SHERIFF'S OFFICE") === "ALDER COUNTY SHERIFF'S OFFICE",
    R("ALDER COUNTY SHERIFF'S OFFICE"));
ok('but a name directly before COUNTY is still removed',
    R('NYLE THACKERY COUNTY OF RESIDENCE').indexOf('THACKERY') < 0,
    R('NYLE THACKERY COUNTY OF RESIDENCE'));
ok('a function word does not split an offence into a "name"',
    R('POSSESSION OF CHILD PORNOGRAPHY WITH INTENT') .indexOf('WITH') >= 0,
    R('POSSESSION OF CHILD PORNOGRAPHY WITH INTENT'));

/* ------------------------------------------------------------------ *
 * the envelope                                                        *
 * ------------------------------------------------------------------ */
section('the envelope: schema and budgets');

ok('the full-document skeleton builder is exposed', typeof I._redactStructural === 'function');
const skel = I._redactStructural(rawLines.join('\n'), {});
ok('the skeleton is produced', typeof skel === 'string' && skel.length > 100, skel.length);
ok('it carries no invented name from the fixture',
    !/Thornbury|Abernathy|Calloway|FENWICK/i.test(skel));
ok('narratives are collapsed to a character count rather than shipped',
    /<NARRATIVE ~\d+ chars>/.test(skel));

ok('the schema version was raised again (5.3.9), so a reader can tell a ' +
   'submission made after the CyberTip fixes from one made before',
    I.SCHEMA_VERSION === 5, I.SCHEMA_VERSION);
ok('the skeleton budget was raised — the Fort Worth report was being cut off',
    I.PDF_SKELETON_MAX_CHARS === 48000, I.PDF_SKELETON_MAX_CHARS);
ok('the heading cap is above the 40 that came back exactly full, and so was ' +
   'silently truncated',
    I.PDF_TOP_HEADINGS > 40, I.PDF_TOP_HEADINGS);
ok('likewise the vertical-label cap, which came back exactly 60',
    I.PDF_TOP_VERTICAL_LABELS > 60, I.PDF_TOP_VERTICAL_LABELS);

/* ------------------------------------------------------------------ *
 * end to end — a whole PDF through the real inspector                 *
 * ------------------------------------------------------------------ */
// Everything above calls the redactor directly.  This runs a hand-built
// CyberTip-shaped PDF through inspectPdfTextAsync — the function the
// submit button actually calls — and searches the WHOLE result for every
// invented identifier, so a channel that bypasses the redactor is caught.
function buildPdf(lines) {
    const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
    let y = 760;
    const ops = ['BT', '/F1 10 Tf'];
    for (const l of lines) { ops.push('1 0 0 1 40 ' + y + ' Tm (' + esc(l) + ') Tj'); y -= 14; }
    ops.push('ET');
    const stream = ops.join('\n');
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
            '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    ];
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = Buffer.byteLength(out);
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
        offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
        'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(out, 'latin1');
}

(async () => {
    section('end to end: a CyberTip-shaped PDF through the real inspector');
    const lines = [
        'NCMEC CYBERTIPLINE REPORT 900000001',
        'Section A: Reported Information',
        'Name: DORIAN Q THACKERY',
        'ID Type: DRIVERS LICENSE DORIAN Q THACKERY',
        'Address: THACKERY111 W ELM AVE, MILLBROOK, CO 80000',
        'Phone: (303) 555-0187',
        'SSN: XXX-XX-4235 DOB: XX/XX/1980',
        'IP Address: 203.0.113.45 Login 17:43:39 UTC',
        'IP Address: 2001:db8:85a3::8a2e:370:7334',
        'Geo: 38.1234,-104.5678',
        'Possible Relative: NYLE THACKERY',
        'Email: dthackery@example.com',
    ];
    const buf = buildPdf(lines);
    let res = null, err = null;
    try { res = await I.inspectPdfTextAsync(buf, I.inspectPdf(buf)); } catch (e) { err = e; }
    ok('the inspector reads the hand-built PDF', !!res && res.text_extracted === true,
        err ? String(err) : res && { text_extracted: res.text_extracted, method: res.extraction_method });
    const blob = JSON.stringify(res || {});
    for (const pii of ['THACKERY', 'DORIAN', 'NYLE', 'ELM AVE', 'MILLBROOK', '0187', '4235',
                       '1980', '203.0.113', '2001:db8', '38.1234', '104.5678', 'dthackery']) {
        ok('no "' + pii + '" anywhere in the result', blob.indexOf(pii) < 0,
            blob.indexOf(pii) >= 0 ? blob.slice(Math.max(0, blob.indexOf(pii) - 60), blob.indexOf(pii) + 40) : undefined);
    }
    ok('the form structure survives — a parser author can still see the labels',
        blob.indexOf('ID Type') >= 0 && blob.indexOf('IP Address') >= 0, undefined);

    console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
