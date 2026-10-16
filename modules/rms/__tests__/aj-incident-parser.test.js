/*
 * Apache Junction PD (AZ) RMS reports — modules/rms/aj-incident-parser.js
 *
 * Three forms are covered, all printed by Microsoft Reporting Services
 * with an "INCIDENT NUMBER: … ORI #" block at the top of every page:
 * the Incident Report, the Narrative Supplement and the Forensic
 * Supplement.
 *
 * The real samples hold juveniles' names and case details, so nothing
 * from them is committed. The three fixtures reproduce the layout with
 * invented values and deliberately include every hard construct measured
 * in the originals:
 *   - empty labels printed glued together ("To AgeSex", "SSNOLNOLN State")
 *   - "#Error" printed as a value
 *   - an Other Person interrupted by an Organization block, continued on
 *     the next page; later Other Persons printed INSIDE the organization
 *     section
 *   - an organization with no name
 *   - a sentence that runs across a page break; a word hyphenated across
 *     a line
 *   - the supplement printing its whole narrative twice, wrapped differently
 *   - "ORDER INFORMATION" (a section-like heading) inside a forensic narrative
 *   - officer lines with badge and date run together
 */
const fs = require('fs');
const path = require('path');
const AJ = require(path.join(__dirname, '..', 'aj-incident-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

const FX = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
const IR_TEXT = FX('aj-incident-report.synthetic.txt');
const NS_TEXT = FX('aj-narrative-supplement.synthetic.txt');
const FS_TEXT = FX('aj-forensic-supplement.synthetic.txt');
const IR = AJ.parse(IR_TEXT, 'ir.pdf');
const NS = AJ.parse(NS_TEXT, 'ns.pdf');
const FSR = AJ.parse(FS_TEXT, 'fs.pdf');

const person = frag => IR.personsInvolved.filter(p => p.name.indexOf(frag) >= 0)[0];

/* ---------- detection ---------- */
console.log('\n[detect]');
ok('claims the Incident Report', AJ.detect(IR_TEXT));
ok('claims the Narrative Supplement', AJ.detect(NS_TEXT));
ok('claims the Forensic Supplement', AJ.detect(FS_TEXT));
ok('claims it with CRLF line endings too', AJ.detect(IR_TEXT.replace(/\r?\n/g, '\r\n')));
ok('rejects empty / null', !AJ.detect('') && !AJ.detect(null) && !AJ.detect(undefined));
ok('needs the ADMINISTRATIVE INFORMATION section, not just the page block',
    !AJ.detect('INCIDENT NUMBER:\n2601\nSOME AGENCY\nREPORT\nORI #\nXX0000000\nNARRATIVE\ntext\n'));
ok('needs the page block, not just ADMINISTRATIVE INFORMATION',
    !AJ.detect('ADMINISTRATIVE INFORMATION\nCase Status\nOPEN\n'));
ok('"INCIDENT NUMBER:" in running text is not the page block',
    !AJ.detect('The INCIDENT NUMBER: 2601 was given.\nORI #\nADMINISTRATIVE INFORMATION\n'));

// Every other RMS fixture VIPER ships must stay with its own reader.
const others = [
    path.join(__dirname, '..', 'fixtures', 'fw-inform-incident.synthetic.txt'),
].concat(fs.readdirSync(path.join(__dirname, 'fixtures')).map(f => path.join(__dirname, 'fixtures', f)));
others.forEach(f => {
    ok('does not claim ' + path.basename(f), !AJ.detect(fs.readFileSync(f, 'utf8')));
});

/* ---------- pages ---------- */
console.log('\n[pages]');
const SPLIT = AJ.splitPages(IR_TEXT);
ok('six page blocks found', SPLIT.headers === 6, SPLIT.headers);
ok('six pages counted, matching the footer', SPLIT.pages === 6 && SPLIT.declaredPages === 6,
    [SPLIT.pages, SPLIT.declaredPages]);
ok('leading blank lines do not open a phantom page', SPLIT.body[0].page === 1, SPLIT.body[0]);
ok('header gives the incident number', SPLIT.header.incidentNumber === '269990001', SPLIT.header);
ok('header gives the title and ORI', SPLIT.header.title === 'INCIDENT REPORT' && SPLIT.header.ori === 'AZ0999900');
const bodyText = SPLIT.body.map(b => b.text).join('\n');
ok('no page block survives in the body', bodyText.indexOf('INCIDENT NUMBER:') < 0 && bodyText.indexOf('ORI #') < 0);
ok('no page footer survives in the body', !/\dof\dPage/.test(bodyText));

/* ---------- glued labels ---------- */
console.log('\n[labels]');
const seg = s => JSON.stringify(AJ.segmentLabels(s));
ok('"To AgeSex" -> To Age / Sex', seg('To AgeSex') === JSON.stringify(['To Age', 'Sex']), seg('To AgeSex'));
ok('"SSNOLNOLN State" -> SSN / OLN / OLN State',
    seg('SSNOLNOLN State') === JSON.stringify(['SSN', 'OLN', 'OLN State']), seg('SSNOLNOLN State'));
ok('"EmailHome #Cell #" -> Email / Home # / Cell #',
    seg('EmailHome #Cell #') === JSON.stringify(['Email', 'Home #', 'Cell #']), seg('EmailHome #Cell #'));
ok('a value line is not a label line', AJ.segmentLabels('4410 W HARBOR LN') === null);
ok('a name that starts like a label is not a label line', AJ.segmentLabels('Sexton, Ray') === null);

/* ---------- report header ---------- */
console.log('\n[report]');
ok('report number', IR.reportNumber === '269990001', IR.reportNumber);
ok('report type in title case', IR.reportType === 'Incident Report', IR.reportType);
ok('an incident report is not a supplement', IR.supplementNo === '', IR.supplementNo);
ok('agency joined into one name', IR.agencyName === 'APACHE JUNCTION POLICE DEPARTMENT', IR.agencyName);
ok('report date from Report Date', IR.reportDate === '2026-03-14', IR.reportDate);
ok('incident start and end with times', IR.fromDateTime === '2026-03-14 18:40' && IR.toDateTime === '2026-03-14 20:15',
    [IR.fromDateTime, IR.toDateTime]);
ok('location of incident', IR.location === '4410 W HARBOR LN, AJ, AZ 85120', IR.location);
ok('page count', IR.pageCount === 6, IR.pageCount);
ok('format tag', IR.rmsFormat === 'aj-incident-report', IR.rmsFormat);
ok('incident description and case status kept', IR.aj.incidentDescription === 'THREATS' && IR.aj.caseStatus === 'PENDING', IR.aj);
ok('ORI kept', IR.aj.ori === 'AZ0999900');
ok('"#Error" never reaches the case', JSON.stringify(Object.assign({}, IR, { rawText: '' })).indexOf('#Error') < 0);

/* ---------- offences ---------- */
console.log('\n[offenses]');
ok('two offences', IR.offenses.length === 2, IR.offenses);
const o1 = IR.offenses[0] || {}, o2 = IR.offenses[1] || {};
ok('statute kept verbatim', o1.statute === '13-1202/703', o1.statute);
ok('statute description', o1.description === 'THREAT - INTIMIDATE', o1.description);
ok('M -> MISDEMEANOR', o1.severity === 'MISDEMEANOR', o1.severity);
ok('counts', o1.counts === '2', o1.counts);
ok('weapon "#Error" is blank', o1.weapon === '', o1.weapon);
ok('second offence is its own row', o2.statute === '13-1204A2' && o2.description === 'AGG ASSAULT - DEADLY WEAPON', o2);
ok('F -> FELONY', o2.severity === 'FELONY', o2.severity);
ok('attempted/completed read per offence', o1.attempted === 'COMPLETED' && o2.attempted === 'ATTEMPTED', [o1.attempted, o2.attempted]);

/* ---------- people ---------- */
console.log('\n[people]');
ok('five named people', IR.personsInvolved.length === 5, IR.personsInvolved.map(p => p.name));
const v = person('QUILLFEATHER') || {};
ok('victim name tidied ("QUILLFEATHER , MARGO")', v.name === 'QUILLFEATHER, MARGO', v.name);
ok('victim role', v.involvement === 'VICTIM', v.involvement);
ok('victim DOB as ISO', v.dob === '2012-05-09', v.dob);
ok('victim sex / race / ethnicity codes expanded',
    v.sex === 'FEMALE' && v.race === 'UNKNOWN' && v.ethnicity === 'NOT HISPANIC', [v.sex, v.race, v.ethnicity]);
ok('victim found on page 2', v.sourcePage === 2, v.sourcePage);
ok('victim blank address stays blank', !v.address, v.address);

const op1 = person('DRAVEN, OTIS') || {};
ok('Other Person #1 keeps the role printed on the form', op1.involvement === 'MISC. ASSOCIATED NAMES', op1.involvement);
ok('Other Person #1 continued after the organization block: DOB', op1.dob === '1988-11-02', op1.dob);
ok('... and licence state', op1.dlState === 'NM', op1.dlState);
ok('... and the organization did not take them', op1.involvement !== 'ORGANIZATION');
ok('Other Person #1 address and phone', op1.address === '4410 W HARBOR LN, 7, APACHE JUNCTION, AZ 85120' && op1.phone === '555-201-0144',
    [op1.address, op1.phone]);

const op2 = person('DRAVEN, LUCILLE') || {};
const op3 = person('CASEWORKER') || {};
ok('Other Person #2, printed inside the organization section, is still a person',
    op2.involvement === 'MISC. ASSOCIATED NAMES', op2.involvement);
ok('Other Person #3 keeps "PERSON REPORTING EVENT"', op3.involvement === 'PERSON REPORTING EVENT', op3.involvement);
ok('Other Person #2 fields are its own', op2.dob === '1990-04-21' && op2.phone === '555-201-0177' && op2.dlState === 'AZ',
    [op2.dob, op2.phone, op2.dlState]);
ok('no named person is labelled ORGANIZATION', IR.personsInvolved.every(p => !/ORGANIZATION/.test(p.involvement)),
    IR.personsInvolved.map(p => p.involvement));

const s = person('DRAVEN PELL') || {};
ok('suspect role', s.involvement === 'SUSPECT', s.involvement);
ok('suspect fields read across the page break',
    s.dob === '2010-07-30' && s.sex === 'MALE' && s.race === 'WHITE' && s.address === '4410 W HARBOR LN, 7, APACHE JUNCTION, AZ 85120',
    [s.dob, s.sex, s.race, s.address]);
ok('suspect resident status kept', /Resident status: RESIDENT/.test(s.detail || ''), s.detail);

ok('unnamed organization goes to Name Not Read', IR.provisionalPersons.length === 1, IR.provisionalPersons);
const org = IR.provisionalPersons[0] || {};
ok('... flagged as an organization victim', /VICTIM/.test(org.involvement) && /Organization/.test(org.detail || ''), org);
ok('... and the officer is told', IR.diagnostics.warnings.some(w => /Organization #1 has no name/.test(w)), IR.diagnostics.warnings);

// The same routing rules the RMS tab applies (routeRmsPersonsToTabs).
const tabOf = inv => /SUSPECT|ARRESTED|DEFENDANT/i.test(inv) ? 'suspects'
    : (/VICTIM/i.test(inv) && !/VICTIM'S|PARENT|GUARDIAN/i.test(inv)) ? 'victims'
        : /WITNESS/i.test(inv) ? 'witnesses' : 'involved';
const tabs = IR.personsInvolved.map(p => tabOf(p.involvement));
ok('routes 1 victim, 1 suspect, 3 involved persons',
    tabs.filter(t => t === 'victims').length === 1 && tabs.filter(t => t === 'suspects').length === 1 &&
    tabs.filter(t => t === 'involved').length === 3, tabs);

/* ---------- narrative ---------- */
console.log('\n[narrative]');
ok('one narrative', IR.narratives.length === 1);
const n = IR.narratives[0] || { text: '' };
ok('narrative officer is the REPORTING officer', n.officer === 'HOLLOWAY, DANA' && n.badge === '512', [n.officer, n.badge]);
ok('narrative dated by the report date when the officer line has none', n.date === '2026-03-14', n.date);
ok('narrative keeps its own heading lines', /^INITIAL REPORT\n\nOfficer: HOLLOWAY #512/.test(n.text), n.text.slice(0, 60));
ok('a sentence across the page break is rejoined',
    n.text.indexOf('until his mother arrived to collect him') >= 0, n.text.slice(500, 800));
ok('a word hyphenated across a line is rejoined', n.text.indexOf('a follow-up meeting') >= 0);
ok('wrapped lines are rejoined into paragraphs', n.text.indexOf('making threats toward family members') >= 0);
ok('paragraphs are kept apart', n.text.indexOf('report them.\n\nRena stated') >= 0);
ok('no page furniture inside the narrative', !/INCIDENT NUMBER|ORI #|AZ0999900|of6Page/.test(n.text));
ok('narrative stops at OFFICER INFORMATION', /uploaded into evidence\.$/.test(n.text) && n.text.indexOf('REPORTING') < 0);
ok('both officers kept', IR.aj.officers.length === 2 && IR.aj.officers[1].name === 'PRESCOTT, ALAN' && IR.aj.officers[1].role === 'APPROVING',
    IR.aj.officers);
ok('no warnings beyond the unnamed organization', IR.diagnostics.warnings.length === 1, IR.diagnostics.warnings);

/* ---------- narrative supplement ---------- */
console.log('\n[narrative supplement]');
ok('supplement type', NS.reportType === 'Narrative Supplement' && NS.rmsFormat === 'aj-narrative-supplement', [NS.reportType, NS.rmsFormat]);
ok('supplementNo set so the RMS tab judges it on its narrative', NS.supplementNo === 'Narrative Supplement', NS.supplementNo);
ok('same incident number as the report', NS.reportNumber === '269990001', NS.reportNumber);
ok('narrative printed twice is shown once', NS.diagnostics.narrativeRepeated === true);
const ns = (NS.narratives[0] || { text: '' }).text;
const count = (hay, needle) => hay.split(needle).length - 1;
ok('... a sentence from it appears exactly once', count(ns, 'does not have a cell phone') === 1, count(ns, 'does not have a cell phone'));
ok('... and the officer is told', NS.diagnostics.warnings.some(w => /printed twice/.test(w)), NS.diagnostics.warnings);
ok('badge and date run together are split ("16403/16/2026")',
    NS.narratives[0] && NS.narratives[0].officer === 'MARSH, TOBIAS' && NS.narratives[0].badge === '164' && NS.narratives[0].date === '2026-03-16',
    NS.narratives[0]);
ok('approving officer date read too', NS.aj.officers[1] && NS.aj.officers[1].badge === '330' && NS.aj.officers[1].date === '2026-03-17', NS.aj.officers[1]);
ok('report date falls back to the reporting officer date', NS.reportDate === '2026-03-16', NS.reportDate);
ok('case status taken from the narrative when the field is blank', NS.aj.caseStatus === 'Closed', NS.aj.caseStatus);
ok('no people and no "missing offence" warning on a supplement',
    NS.personsInvolved.length === 0 && !NS.diagnostics.warnings.some(w => /offen/i.test(w)), NS.diagnostics.warnings);
ok('a supplement has no incident dates', NS.fromDateTime === '' && NS.toDateTime === '');

/* ---------- forensic supplement ---------- */
console.log('\n[forensic supplement]');
ok('forensic type', FSR.rmsFormat === 'aj-forensic-supplement' && FSR.supplementNo === 'Forensic Supplement Report', [FSR.rmsFormat, FSR.supplementNo]);
ok('Reporting Date with a midnight time gives the date', FSR.reportDate === '2025-01-07', FSR.reportDate);
ok('one property item', FSR.property.length === 1, FSR.property);
const pr = FSR.property[0] || {};
ok('property type', pr.articleType === 'THUMB DRIVE', pr.articleType);
ok('evidence number', pr.evidenceNumber === '990412' && /Evidence # 990412/.test(pr.description), pr);
ok('location seized', pr.locationSeized === 'GOLD CANYON' && /Location seized: GOLD CANYON/.test(pr.description), pr);
ok('held as evidence', pr.holdReason === 'EVIDENCE');
const fsn = (FSR.narratives[0] || { text: '' }).text;
ok('"ORDER INFORMATION" inside the narrative does not end it',
    fsn.indexOf('ORDER INFORMATION') >= 0 && fsn.indexOf('write blocker') >= 0, fsn.slice(-200));
ok('forensic officer without a date', FSR.narratives[0] && FSR.narratives[0].badge === '164' && FSR.narratives[0].date === '2025-01-07',
    FSR.narratives[0]);
ok('case status from the admin block', FSR.aj.caseStatus === 'PENDING', FSR.aj.caseStatus);
ok('no warnings', FSR.diagnostics.warnings.length === 0, FSR.diagnostics.warnings);

/* ---------- helpers ---------- */
console.log('\n[helpers]');
const po = l => JSON.stringify(AJ.parseOfficerLine(l));
ok('officer line without a date', po('REPORTINGHOLLOWAY, DANA 512') ===
    JSON.stringify({ role: 'REPORTING', name: 'HOLLOWAY, DANA', badge: '512', date: '' }), po('REPORTINGHOLLOWAY, DANA 512'));
ok('officer line with a two-digit-month date', AJ.parseOfficerLine('APPROVINGROWE, EDITH 14611/02/2025').badge === '146' &&
    AJ.parseOfficerLine('APPROVINGROWE, EDITH 14611/02/2025').date === '2025-11-02', po('APPROVINGROWE, EDITH 14611/02/2025'));
ok('a line that is not an officer line', AJ.parseOfficerLine('Officer: HOLLOWAY #512') === null);
ok('parseTime keeps a real time', AJ.parseTime('03/14/2026 18:40') === '18:40');
ok('parseTime drops a printed midnight-with-seconds', AJ.parseTime('01/07/2025 00:00:00') === '');
ok('parseTime keeps 00:30', AJ.parseTime('01/07/2025 00:30') === '00:30');
ok('parseDate pads', AJ.parseDate('5/9/2012') === '2012-05-09');
const notRep = AJ.dedupeRepeated(['First line of the narrative goes here.', 'Second line of it is different.']);
ok('dedupe leaves a narrative printed once alone', notRep.repeated === false && notRep.lines.length === 2);
const rep = AJ.dedupeRepeated(['Alpha bravo charlie delta', 'echo foxtrot golf hotel.', 'Alpha bravo charlie', 'delta echo foxtrot golf hotel.']);
ok('dedupe ignores different wrapping', rep.repeated === true && rep.lines.length === 2, rep);
ok('reflow joins a hyphen break without a space', AJ.reflowNarrative([
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx well-',
    'known yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy']).indexOf('well-known') >= 0);

/* ---------- robustness ---------- */
console.log('\n[robustness]');
let threw = null;
let empty;
try { empty = AJ.parse('', 'empty.pdf'); } catch (e) { threw = e; }
ok('empty text does not throw', !threw, threw && threw.message);
ok('empty text gives empty arrays', empty && empty.personsInvolved.length === 0 && empty.narratives.length === 0 && empty.offenses.length === 0);
const crlf = AJ.parse(IR_TEXT.replace(/\r?\n/g, '\r\n'), 'crlf.pdf');
ok('CRLF input reads the same people', crlf.personsInvolved.length === 5 && crlf.offenses.length === 2);
ok('every report field the RMS tab reads is present',
    ['reportNumber', 'reportDate', 'reportType', 'supplementNo', 'agencyName', 'location', 'beat', 'fromDateTime', 'toDateTime']
        .every(k => typeof IR[k] === 'string') &&
    ['offenses', 'personsInvolved', 'provisionalPersons', 'vehicles', 'property', 'narratives', 'digital', 'confidentialPersons']
        .every(k => Array.isArray(IR[k])));
ok('every narrative officer is a string, never null',
    [IR, NS, FSR, empty].every(r => r.narratives.every(x => typeof x.officer === 'string')));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
