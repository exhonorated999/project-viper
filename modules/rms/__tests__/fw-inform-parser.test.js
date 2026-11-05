// Fort Worth PD INFORM RMS parser — offense, supplement, arrest, officer
// report, wanted-person sheet and the combined case packet.
// Every fixture is SYNTHETIC (invented names, numbers and addresses laid out
// the way the INFORM / SSRS text layer prints them).
'use strict';
const fs = require('fs');
const path = require('path');
const FW = require('../fw-inform-parser.js');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

const FX = path.join(__dirname, '..', 'fixtures');
const read = n => fs.readFileSync(path.join(FX, n), 'utf8');
const OFFENSE = read('fw-offense.synthetic.txt');
const SUPP = read('fw-supplement.synthetic.txt');
const ARREST = read('fw-arrest.synthetic.txt');
const OFFICER = read('fw-officer.synthetic.txt');
const WANTED = read('fw-wanted.synthetic.txt');
const LEGACY = read('fw-inform-incident.synthetic.txt');

const person = (r, code, n) => r.personsInvolved.find(p => p.involvementCode === code && (!n || p.number === n));

/* ---------------------------------------------------------------- */
section('detect');
ok('offense report detected', FW.detect(OFFENSE));
ok('supplement detected', FW.detect(SUPP));
ok('arrest report detected', FW.detect(ARREST));
ok('officer report detected', FW.detect(OFFICER));
ok('a stand-alone wanted person sheet is detected', FW.detect(WANTED));
ok('the older incident fixture is still detected', FW.detect(LEGACY));
ok('empty / null rejected', !FW.detect('') && !FW.detect(null) && !FW.detect(undefined));
ok('another agency is not claimed',
    !FW.detect('SAMPLE COUNTY SHERIFF\nReporting Officer\nX\nPrinted At\nY\nPage1 of 1\nMember#/Dept ID#\n'));
const others = fs.readdirSync(FX).filter(f => /^(aj|ar)-/.test(f));
others.forEach(f => ok('does not claim ' + f, !FW.detect(read(f))));
const nested = path.join(__dirname, 'fixtures');
if (fs.existsSync(nested)) fs.readdirSync(nested).forEach(f =>
    ok('does not claim ' + f, !FW.detect(fs.readFileSync(path.join(nested, f), 'utf8'))));

/* ---------------------------------------------------------------- */
section('helpers');
ok('wrapped value joins with nothing', FW.joinWrapped(['PC 19.02', '(b)']) === 'PC 19.02(b)');
ok('a trailing space is a real word break', FW.joinWrapped(['FELONY, 1ST ', 'DEGREE']) === 'FELONY, 1ST DEGREE');
ok('coded value keeps the description', FW.describeCoded('88::88 NONE (NO BIAS)') === '88 NONE (NO BIAS)');
ok('coded yes/no', FW.describeCoded('N::NO') === 'NO');
ok('coded address reads as an address',
    FW.readAddress('2210 EXAMPLE MESA TRL FW::FORT WORTH TX::TEXAS 76199::76199') === '2210 EXAMPLE MESA TRL, FORT WORTH TX 76199',
    FW.readAddress('2210 EXAMPLE MESA TRL FW::FORT WORTH TX::TEXAS 76199::76199'));
ok('dates are padded', FW.parseDate('3/14/1999') === '03/14/1999');
ok('a known label is recognised', FW.labelOn('Report No') === 'Report No');
ok('concatenated empty labels are a heading', FW.looksLikeHeading('AliasSex'));
ok('prose is not a heading', !FW.looksLikeHeading('Narrative prose that goes on'));

/* ---------------------------------------------------------------- */
section('offense report');
const off = FW.parseAll(OFFENSE, 'offense.pdf');
ok('one document', off.length === 1, off.length);
const O = off[0];
ok('kind offense', O.fw.kind === 'offense' && O.reportType === 'Offense Report', [O.fw.kind, O.reportType]);
ok('not marked as split', O.splitIndex === undefined && O.fw.packetPart === '', [O.splitIndex, O.fw.packetPart]);
ok('case number', O.reportNumber === '249990001', O.reportNumber);
ok('report date', O.reportDate === '06/16/2024', O.reportDate);
ok('location with city and zip', O.location === '4100 EXAMPLE RIDGE RD, FORT WORTH 76199', O.location);
ok('beat', O.beat === 'N99', O.beat);
ok('from date/time', O.fromDateTime === '06/14/2024 23:42', O.fromDateTime);
ok('CAD call, division, council district',
    O.fw.cadCallNo === '249990777' && O.fw.division === 'North Division' && O.fw.councilDistrict === '9', O.fw);
ok('nature of call', O.fw.natureOfCall === 'MURDER/CAPITAL MURDER/CRIMINAL NEGLIGENT HOMICIDE', O.fw.natureOfCall);
ok('officers on call', JSON.stringify(O.fw.officersOnCall) === JSON.stringify(['Thistlewood, Rhea #9001']), O.fw.officersOnCall);
ok('pdf pages 1-4', O.fw.pdfPages === '1-4' && O.pageCount === 4, [O.fw.pdfPages, O.pageCount]);
ok('no warnings', O.diagnostics.warnings.length === 0, O.diagnostics.warnings);
ok('format label', O.rmsFormat === 'fw-inform' && /Fort Worth/.test(O.rmsFormatLabel));

ok('two offenses (the repeated UCR block starts the second)', O.offenses.length === 2, O.offenses.length);
const o1 = O.offenses[0], o2 = O.offenses[1];
ok('offense 1 statute + description', o1.statute === 'PC 19.02(b)' && o1.description === 'Murder', o1);
ok('offense 1 codes', o1.ucrCode === '09A' && o1.degree === 'F1' && o1.ncic === '09990030', o1);
ok('offense 1 severity text joins its wrap', o1.severityText === 'FELONY, 1ST DEGREE', o1.severityText);
ok('offense 1 premise / weapon / bias decoded',
    o1.premise === '20 RESIDENCE/HOME' && o1.weapon === '11 FIREARM' && o1.bias === '88 NONE (NO BIAS)', o1);
ok('offense 1 completed, page 3', o1.attempted === 'COMPLETED' && o1.page === 3, [o1.attempted, o1.page]);
ok('offense 2 statute', o2.statute === 'PC 22.02(a)(2)' && o2.ucrCode === '13A' && o2.degree === 'F2', o2);
ok('offense 2 description', o2.description === 'Aggravated Assault bodily injury w/Deadly Weapon', o2.description);
ok('offense 2 weapon', o2.weapon === '12 HANDGUN', o2.weapon);

ok('four persons', O.personsInvolved.length === 4, O.personsInvolved.map(p => p.name));
const s1 = person(O, 'SUS', '1');
ok('suspect 1 name', s1 && s1.name === 'PELLHAM, DARIUS', s1 && s1.name);
ok('suspect 1 DOB / age', s1.dob === '03/14/1999' && s1.age === '25', [s1.dob, s1.age]);
ok('suspect 1 DL + state', s1.dl === '99887766' && s1.dlState === 'TX', [s1.dl, s1.dlState]);
ok('suspect 1 SID', s1.sid === 'TX90000001', s1.sid);
ok('suspect 1 SSN joined across its wrap', s1.ssn === '900-00-1234', s1.ssn);
ok('suspect 1 address', s1.address === '88 SAMPLE OAK LN, FORT WORTH TX 76199', s1.address);
ok('suspect 1 phone formatted', s1.phone === '817-555-0142', s1.phone);
ok('suspect 1 height', s1.height === '5\'11"', s1.height);
ok('suspect 1 arrested', s1.arrested === 'YES', s1.arrested);
ok('suspect 1 related offenses', /PC 19\.02\(b\) Murder/.test(s1.relatedOffenses), s1.relatedOffenses);
ok('suspect 1 rmsKey', s1.rmsKey === 'DARIUS PELLHAM|03/14/1999', s1.rmsKey);
ok('victim keys', O.personsInvolved.some(p => p.rmsKey === 'BENEDIKT OKAFOR|07/09/1980') &&
    O.personsInvolved.some(p => p.rmsKey === 'LINDQVIST MAREN|01/30/1992'), O.personsInvolved.map(p => p.rmsKey));
ok('second suspect key (sorted name words)',
    O.personsInvolved.some(p => p.rmsKey === 'ANN MARISOL PELLHAM|11/02/2001'), O.personsInvolved.map(p => p.rmsKey));

ok('one summary narrative', O.narratives.length === 1 && O.narratives[0].title === 'Summary Narrative', O.narratives.map(n => n.title));
ok('narrative approver read from the last line', O.narratives[0].approvedBy === 'Sgt. Q. Ambervale #9902', O.narratives[0].approvedBy);
ok('narrative page 2', O.narratives[0].page === 2, O.narratives[0].page);
ok('no "#Error" anywhere', JSON.stringify(O).indexOf('#Error') < 0);
ok('the parse() entry gives the same first document', FW.parse(OFFENSE, 'offense.pdf').reportNumber === '249990001');

/* ---------------------------------------------------------------- */
section('supplement');
const S = FW.parseAll(SUPP, 'supp.pdf');
ok('one document', S.length === 1, S.length);
const SP = S[0];
ok('kind supplement', SP.fw.kind === 'supplement' && SP.reportType === 'Supplement', [SP.fw.kind, SP.reportType]);
ok('supplement number', SP.supplementNo === '002', SP.supplementNo);
ok('case number', SP.reportNumber === '249990001', SP.reportNumber);
ok('report date', SP.reportDate === '06/20/2024', SP.reportDate);
ok('no location borrowed', SP.location === '', SP.location);
ok('roster persons', SP.personsInvolved.length === 2, SP.personsInvolved.map(p => p.name));
const sp1 = person(SP, 'SUS'), sp2 = person(SP, 'OTH');
ok('suspect key matches the offense report', sp1 && sp1.rmsKey === s1.rmsKey, sp1 && sp1.rmsKey);
ok('last roster DOB before the page break is kept', sp2 && sp2.dob === '11/02/2001', sp2 && sp2.dob);
ok('other person key matches the offense report', sp2 && sp2.rmsKey === 'ANN MARISOL PELLHAM|11/02/2001', sp2 && sp2.rmsKey);
ok('narrative carried past the page break is one narrative', SP.narratives.length === 1, SP.narratives.length);
const sn = SP.narratives[0];
ok('narrative has both parts', /assigned to follow up/.test(sn.text) && /doorbell footage/.test(sn.text) &&
    /pending a search warrant/.test(sn.text), sn.text.slice(0, 120));
ok('the roster DOB did not leak into the narrative', sn.text.indexOf('11/2/2001') < 0);
ok('carried narrative approver', sn.approvedBy === 'Sgt. Q. Ambervale #9902', sn.approvedBy);
ok('narrative officer + badge', sn.officer === 'Brackenridge, T L' && sn.badge === '9044', [sn.officer, sn.badge]);
ok('one vehicle', SP.vehicles.length === 1, SP.vehicles.length);
const v = SP.vehicles[0];
ok('vehicle plate / state', v.license === 'ZZQ4471' && v.state === 'TX', v);
ok('vehicle year / make / model', v.year === '2016' && v.make === 'Synthmotor' && v.model === 'Examplar', v);
ok('vehicle VIN', v.vin === '1SYNTH00000000042', v.vin);
ok('vehicle colours', v.colors === 'Black/Gray', v.colors);
ok('vehicle status', v.status === 'IMPOUNDED', v.status);
ok('vehicle tow notes', /Towed 06\/20\/2024 14:00 by SAMPLE TOWING - CAR CARRIER/.test(v.notes) && /bay 4/.test(v.notes), v.notes);
ok('vehicle page 3', v.page === 3, v.page);
ok('one gun', SP.property.length === 1, SP.property.length);
const g = SP.property[0];
ok('gun article type', g.articleType === 'FIREARMS', g.articleType);
ok('gun make / serial', g.make === 'SAMPLEARMS' && g.serial === 'SYN-000123', g);
ok('gun firearm type + caliber', g.firearmType === 'PISTOL, SEMI-AUTOMATIC' && g.caliber === '9', g);
ok('gun recovered date', /^06\/20\/2024/.test(g.dateRecovered), g.dateRecovered);
ok('gun description starts with the evidence tag', /^EVD1 - /.test(g.description), g.description);
ok('no warnings', SP.diagnostics.warnings.length === 0, SP.diagnostics.warnings);

/* ---------------------------------------------------------------- */
section('arrest report');
const A = FW.parseAll(ARREST, 'arrest.pdf');
ok('one document', A.length === 1, A.length);
const AR = A[0];
ok('kind arrest', AR.fw.kind === 'arrest', AR.fw.kind);
ok('report type carries the arrest number', AR.reportType === 'Arrest Report A9990001', AR.reportType);
ok('case number from the letterhead', AR.reportNumber === '249990001', AR.reportNumber);
ok('booking number', AR.fw.bookingNo === 'A9990001' && AR.fw.documentNo === 'A9990001', AR.fw);
ok('arrest date / type', AR.fw.arrestDate === '06/22/2024 08:45' && AR.fw.arrestType === 'W WARRANT', AR.fw);
ok('arrest location', AR.location === '900 SAMPLE CENTER DR, FORT WORTH 76199', AR.location);
ok('from = arrest time', AR.fromDateTime === '06/22/2024 08:45', AR.fromDateTime);
ok('one charge', AR.offenses.length === 1, AR.offenses.length);
const c = AR.offenses[0];
ok('charge kind / statute', c.kind === 'charge' && c.statute === 'PC 19.02(b)' && c.description === 'Murder', c);
ok('warrant number joined across its wrap', c.warrantNo === '2024FW999001', c.warrantNo);
ok('charge severity + degree', c.severityText === 'FELONY, 1ST DEGREE' && c.degree === 'F1', c);
ok('charge offense date', c.offenseDate === '06/14/2024', c.offenseDate);
ok('one arrestee', AR.personsInvolved.length === 1, AR.personsInvolved.length);
const ap = AR.personsInvolved[0];
ok('arrestee is a suspect (arrested)', ap.involvementCode === 'ARR' && /ARRESTED/.test(ap.involvement), ap.involvement);
ok('arrestee details from the Arrestee block', ap.address === '88 SAMPLE OAK LN, FORT WORTH TX 76199' &&
    ap.phone === '817-555-0142' && ap.dl === '99887766' && ap.dlState === 'TX', ap);
ok('arrestee height read as feet/inches', ap.height === '5\'11"', ap.height);
ok('arrestee ethnicity joins its wrap', ap.ethnicity === 'NOT HISPANIC/LATINO', ap.ethnicity);
ok('arrestee key matches the offense report', ap.rmsKey === s1.rmsKey, ap.rmsKey);
ok('narrative', AR.narratives.length === 1 && /listed warrant/.test(AR.narratives[0].text), AR.narratives);
ok('narrative officer from the footer', AR.narratives[0].officer === 'Quillfeather, M' && AR.narratives[0].badge === '9077', AR.narratives[0]);

/* ---------------------------------------------------------------- */
section('officer report + addendum with the same OE number');
const OE = FW.parseAll(OFFICER, 'officer.pdf');
ok('two documents', OE.length === 2, OE.length);
const E1 = OE[0], E2 = OE[1];
ok('both are officer reports', E1.fw.kind === 'officer' && E2.fw.kind === 'officer');
ok('same OE number', E1.fw.documentNo === 'OE9990042' && E2.fw.documentNo === 'OE9990042');
ok('report type names the OE number', E1.reportType === 'Officer Report OE9990042', E1.reportType);
ok('split index / packet part', E1.splitIndex === 0 && E2.splitIndex === 1 &&
    E1.fw.packetPart === '1 of 2' && E2.fw.packetPart === '2 of 2', [E1.splitIndex, E2.splitIndex, E1.fw.packetPart, E2.fw.packetPart]);
ok('pdf pages per document', E1.fw.pdfPages === '1-3' && E2.fw.pdfPages === '4-5', [E1.fw.pdfPages, E2.fw.pdfPages]);
ok('page counts per document', E1.pageCount === 3 && E2.pageCount === 2, [E1.pageCount, E2.pageCount]);
ok('each document keeps only its own text', E1.rawText.indexOf('Fennimore') < 0 && E2.rawText.indexOf('Vantree') < 0);
ok('nature of call', E1.fw.natureOfCall === 'Criminal Trespass Warning report (no offense)', E1.fw.natureOfCall);
ok('location', E1.location === '7700 SAMPLE MARKET AVE, FORT WORTH 76199', E1.location);
ok('officers on call joined across wraps', JSON.stringify(E1.fw.officersOnCall) === JSON.stringify(['Wexley, S #9120', 'Carraway, P #9121']), E1.fw.officersOnCall);
ok('two persons', E1.personsInvolved.length === 2, E1.personsInvolved.map(p => p.name));
const subj = person(E1, 'Subject'), rep = person(E1, 'REP');
ok('subject role', subj && subj.involvement === 'SUBJECT' && /CT warning/.test(subj.roleDescription), subj && subj.roleDescription);
ok('subject DOB joined across its wrap', subj.dob === '02/02/2004', subj.dob);
ok('subject address', subj.address === '12 EXAMPLE COURT, FORT WORTH TX 76199', subj.address);
ok('reporting party', rep && rep.involvement === 'REPORTING PARTY' && rep.phone === '817-555-0199', rep);
ok('reporting party employer', rep.placeOfEmployment === 'sample grocery', rep.placeOfEmployment);
ok('main narrative', E1.narratives.length === 1 && /criminal trespass warning/.test(E1.narratives[0].text), E1.narratives);
ok('addendum: the empty person block gives no person', E2.personsInvolved.length === 0, E2.personsInvolved);
ok('addendum: no provisional persons either', (E2.provisionalPersons || []).length === 0, E2.provisionalPersons);
ok('addendum: "#Error" never reaches the result', JSON.stringify(E2).replace(E2.rawText ? JSON.stringify(E2.rawText) : '', '').indexOf('#Error') < 0);
ok('addendum: own officer', E2.fw.reportingOfficer === 'Fennimore 9133, M A 9133', E2.fw.reportingOfficer);
ok('addendum: narrative + approver', E2.narratives.length === 1 && E2.narratives[0].approvedBy === 'Sgt Oakhurst', E2.narratives);
ok('addendum: case number from the letterhead', E2.reportNumber === '249990002', E2.reportNumber);
const viaParse = FW.parse(OFFICER, 'officer.pdf');
ok('parse() returns the first document with the list in splitReports',
    viaParse.fw.pdfPages === '1-3' && Array.isArray(viaParse.splitReports) && viaParse.splitReports.length === 2);

/* ---------------------------------------------------------------- */
section('wanted person data input');
const W = FW.parseAll(WANTED, 'wanted.pdf');
ok('one document', W.length === 1, W.length);
const WP = W[0];
ok('kind wanted', WP.fw.kind === 'wanted' && WP.reportType === 'Wanted Person Data Input', [WP.fw.kind, WP.reportType]);
ok('service number = case number', WP.reportNumber === '249990001', WP.reportNumber);
ok('report date', WP.reportDate === '06/21/2024', WP.reportDate);
ok('location of offense', WP.location === '4100 EXAMPLE RIDGE RD', WP.location);
ok('warrant number (OCA)', WP.fw.documentNo === '2024FW999001' && WP.fw.warrant.number === '2024FW999001', WP.fw.warrant);
ok('warrant entered at', WP.fw.warrant.enteredAt === '06/21/2024 16:05', WP.fw.warrant.enteredAt);
ok('warrant detective / status / codes', WP.fw.warrant.detective === 'Thistlewood' && WP.fw.warrant.status === 'Completed' &&
    WP.fw.warrant.ncicCode === '09990030' && WP.fw.warrant.degree === 'F1', WP.fw.warrant);
ok('section', WP.fw.division === 'North Division', WP.fw.division);
ok('one warrant offense', WP.offenses.length === 1 && WP.offenses[0].kind === 'warrant', WP.offenses);
ok('warrant offense statute', WP.offenses[0].statute === 'PC 19.02(b)' && WP.offenses[0].description === 'Murder', WP.offenses[0]);
ok('warrant offense severity', WP.offenses[0].severity === 'FELONY', WP.offenses[0].severity);
const wp = person(WP, 'SUS'), wc = person(WP, 'COM');
ok('wanted person', wp && wp.name === 'PELLHAM, DARIUS' && wp.dob === '03/14/1999' && wp.sex === 'MALE', wp);
ok('wanted person SSN', wp.ssn === '900-00-1234', wp.ssn);
ok('wanted person licence', wp.dl === '99887766' && wp.dlState === 'TX', [wp.dl, wp.dlState]);
ok('wanted person description', wp.eyes === 'GRN' && wp.hair === 'BRO' && wp.skinTone === 'MED', wp);
ok('wanted person address', wp.address === '88 SAMPLE OAK LN', wp.address);
ok('wanted person role names the warrant', /warrant 2024FW999001/.test(wp.roleDescription), wp.roleDescription);
ok('wanted person key matches the offense report', wp.rmsKey === s1.rmsKey, wp.rmsKey);
ok('complainant', wc && wc.name === 'Okafor, Benedikt', wc && wc.name);

/* ---------------------------------------------------------------- */
section('combined case packet');
const PACKET = ARREST + WANTED + OFFENSE + SUPP;
ok('packet detected', FW.detect(PACKET));
const PK = FW.parseAll(PACKET, 'packet.pdf');
ok('four documents', PK.length === 4, PK.length);
ok('kinds in order', JSON.stringify(PK.map(r => r.fw.kind)) === JSON.stringify(['arrest', 'wanted', 'offense', 'supplement']), PK.map(r => r.fw.kind));
ok('split indexes', JSON.stringify(PK.map(r => r.splitIndex)) === '[0,1,2,3]', PK.map(r => r.splitIndex));
ok('packet parts', JSON.stringify(PK.map(r => r.fw.packetPart)) === JSON.stringify(['1 of 4', '2 of 4', '3 of 4', '4 of 4']));
ok('pdf pages', JSON.stringify(PK.map(r => r.fw.pdfPages)) === JSON.stringify(['1-3', '4', '5-8', '9-11']), PK.map(r => r.fw.pdfPages));
ok('page counts', JSON.stringify(PK.map(r => r.pageCount)) === '[3,1,4,3]', PK.map(r => r.pageCount));
ok('all under one case number', PK.every(r => r.reportNumber === '249990001'), PK.map(r => r.reportNumber));
ok('packet documents parse like the single files',
    PK[0].offenses.length === 1 && PK[1].personsInvolved.length === 2 && PK[2].offenses.length === 2 &&
    PK[2].personsInvolved.length === 4 && PK[3].vehicles.length === 1 && PK[3].property.length === 1);
ok('no warnings in any document', PK.every(r => r.diagnostics.warnings.length === 0), PK.map(r => r.diagnostics.warnings));
ok('the suspect carries the same key in every document',
    PK.every(r => r.personsInvolved.some(p => p.rmsKey === 'DARIUS PELLHAM|03/14/1999')));
ok('each document keeps only its own text',
    PK[0].rawText.indexOf('REASON WANTED') < 0 && PK[3].rawText.indexOf('Booking No') < 0);
const first = FW.parse(PACKET, 'packet.pdf');
ok('parse() gives the first document + all four in splitReports',
    first.fw.kind === 'arrest' && first.splitReports && first.splitReports.length === 4);

/* ---------------------------------------------------------------- */
section('older incident fixture');
const L = FW.parseAll(LEGACY, 'legacy.pdf');
ok('one offense document', L.length === 1 && L[0].fw.kind === 'offense', L.map(r => r.fw.kind));
ok('location', L[0].location === '2210 EXAMPLE MESA TRL, FORT WORTH 76199', L[0].location);
ok('offenses / persons / narrative', L[0].offenses.length === 2 && L[0].personsInvolved.length === 4 && L[0].narratives.length === 1,
    [L[0].offenses.length, L[0].personsInvolved.length, L[0].narratives.length]);

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
