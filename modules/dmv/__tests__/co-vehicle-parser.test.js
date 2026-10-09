/*
 * co-vehicle-parser — unit tests.
 *
 * Run: node modules\dmv\__tests__\co-vehicle-parser.test.js
 *
 * WHY THIS EXISTS. The Colorado vehicle printout prints the REGISTRATION
 * and the TITLE record side by side, so the same label lands twice on one
 * line. A financed vehicle is titled to the lender, which means a reader
 * that confuses the two columns hands the officer a finance company where
 * the driver should be. The column assertions below are the point of this
 * file; everything else is supporting work.
 *
 * Both fixtures are SYNTHETIC. They keep the exact line-for-line layout
 * measured on two real submissions — including the browser print
 * furniture, the use-only disclaimer, the empty NAME2/NAME3 labels and the
 * fact that the vehicle description arrives as ONE line on one page and as
 * TWO on the other — but every name, plate, VIN and address is made up.
 */
const path = require('path');
const fs = require('fs');
const CO = require(path.join(__dirname, '..', 'co-vehicle-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

const fx = (n) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8');
const MERGED = fx('co-vehicle-registration.synthetic.txt');
const SPLIT = fx('co-vehicle-registration-split.synthetic.txt');

/* ================================================================== */
console.log('\n[recognising the printout]');

ok('the Colorado vehicle printout is recognised', CO.detect(MERGED) === true);
ok('the second layout is recognised too', CO.detect(SPLIT) === true);
ok('empty text is not recognised', CO.detect('') === false);
ok('null is not recognised', CO.detect(null) === false);
ok('a number is not recognised', CO.detect(12345) === false);

// A Colorado DRIVER record comes off the same records window. It must not
// be mistaken for a vehicle record, because the vehicle reader would find
// nothing and the officer would be told the page was unreadable.
const CO_DRIVER = [
    'Colorado Department of Revenue',
    'CO__LICENSE_CATEGORY: R',
    'OLN: 12-345-6789 (CO)',
    'DOB: 04/17/1982',
    'NAME: EXAMPLEZ RORY DALE'
].join('\n');
ok('a Colorado driver record is not mistaken for a vehicle record', CO.detect(CO_DRIVER) === false);

const TX_DL = [
    'DL Number:', '12345678', 'Name:', 'SAMPLE PERSON',
    'Texas Department of Public Safety'
].join('\n');
ok('a Texas driver record is not mistaken for a Colorado vehicle record', CO.detect(TX_DL) === false);

// The header/footer can be cropped off a page an officer re-prints, and
// the disclaimer block is sometimes unreadable. The two real identifying
// lines are enough on their own.
ok('a page cropped to the record alone is still recognised',
    CO.detect('COLORADO VEHICLE REGISTRATION\nVIN: 1ZZAA11A11Z000001') === true);
ok('"RESPONSE FROM DMV" alone is not enough without a plate query',
    CO.detect('RESPONSE FROM DMV\nsomething else entirely') === false);
ok('"RESPONSE FROM DMV" plus a plate query is enough',
    CO.detect('RESPONSE FROM DMV\nQUERY ON: LIC/ZZZ9001.') === true);

/* ================================================================== */
console.log('\n[the two columns — the whole point of this reader]');

const a = CO.parse(MERGED);
const b = CO.parse(SPLIT);

ok('the registered owner is read from the LEFT column',
    b.registeredOwner.name === 'EXAMPLEZ RORY DALE', b.registeredOwner.name);
ok('the titled owner is read from the RIGHT column',
    b.titleOwner.name === 'PLACEHOLDER LENDING LLC', b.titleOwner.name);
ok('the registered owner address is the left one',
    b.registeredOwner.address === '190 FICTITIOUS AVE TESTVILLE CO 80001', b.registeredOwner.address);
ok('the titled owner address is the right one',
    b.titleOwner.address === 'PO BOX 400 TESTVILLE CO 80002', b.titleOwner.address);
ok('the registered owner CIS is the left one',
    b.registeredOwner.cis === 'EXAMPLEZ, RORY 22222', b.registeredOwner.cis);
ok('the titled owner CIS is the right one',
    b.titleOwner.cis === 'PLACEHOLDER, LENDING 33333', b.titleOwner.cis);

// THE BUG THIS PINS. The query header ends "Requested By: TESTER, PAT
// Name:" — a bare NAME label with no value. Counted as a column it shifts
// the registered owner into the title slot and drops the lender off the
// end. The reader cuts the header off before counting.
ok('the empty NAME label in the query header is not counted as a column',
    b.registeredOwner.name !== '' && b.titleOwner.name !== 'EXAMPLEZ RORY DALE');

ok('a vehicle owned outright reads the same name in both columns',
    a.registeredOwner.name === 'SAMPLEFORD QUINCY ARDEN' &&
    a.titleOwner.name === 'SAMPLEFORD QUINCY ARDEN');
ok('a split title raises a warning the officer can see',
    b.warnings.some(w => /titled to someone other than the registered owner/i.test(w)), b.warnings);
ok('a vehicle owned outright raises no such warning',
    !a.warnings.some(w => /titled to someone other/i.test(w)), a.warnings);

ok('the empty NAME2 fields come back empty, not as the label',
    a.registeredOwner.name2 === '' && a.titleOwner.name2 === '');
ok('the empty NAME3 fields come back empty, not as the label',
    a.registeredOwner.name3 === '' && a.titleOwner.name3 === '');

/* ================================================================== */
console.log('\n[the vehicle itself]');

ok('the plate is read', a.plate === 'ZZZ9001', a.plate);
ok('the plate state is read', a.plateState === 'CO', a.plateState);
ok('the plate type is read whole', a.plateType === 'Green and White', a.plateType);
ok('the VIN is read', a.vin === '1ZZAA11A11Z000001', a.vin);
ok('the VIN is 17 characters', a.vin.length === 17);
ok('the title number is read', a.title === '999000111', a.title);
ok('the county is read', a.county === 'Adams', a.county);
ok('the registration status is read', a.registrationStatus === 'Active', a.registrationStatus);
ok('an expired registration is read as expired', b.registrationStatus === 'Expired', b.registrationStatus);
ok('the tab number is read', a.tab === '1234567890', a.tab);

// TITLE STATUS and its date share one printed value.
ok('the title status is separated from its date', a.titleStatus === 'Active', a.titleStatus);
ok('the title date is pulled out of the status value', a.titleDate === '03/14/2019', a.titleDate);
ok('the second page title date is pulled out too', b.titleDate === '06/02/2013', b.titleDate);

ok('"TITLE STATUS" is not read as the title number',
    a.title === '999000111' && a.title !== 'Active 03/14/2019');

/* ================================================================== */
console.log('\n[the description — one printed line or two]');

// On the first page MAKE/MODEL/COLOR/STYLE/YEAR/FUEL came back as ONE
// physical line; on the second as TWO. Nothing is indexed by line number.
ok('make is read from the merged line', a.make === 'JEEP', a.make);
ok('model is read from the merged line', a.model === 'GRAND CHEROKEE', a.model);
ok('a two-word model is kept whole', a.model.indexOf(' ') > 0);
ok('colour is read from the merged line', a.color === 'GRN', a.color);
ok('style is read from the merged line', a.style === 'SPORT UTILITY', a.style);
ok('year is read from the merged line', a.year === '2005', a.year);
ok('fuel is read from the merged line', a.fuel === 'Gasoline', a.fuel);

ok('make is read when the description splits over two lines', b.make === 'DODGE', b.make);
ok('model is read when the description splits', b.model === 'RAM', b.model);
ok('colour is read when the description splits', b.color === 'RED', b.color);
ok('style is read off the second line', b.style === 'PICKUP', b.style);
ok('year is read off the second line', b.year === '2012', b.year);
ok('fuel is read off the second line', b.fuel === 'Gasoline', b.fuel);

ok('"STYLE:" is not misread as "TYPE:"', a.plateType === 'Green and White' && a.style === 'SPORT UTILITY');

ok('makeModel is joined for the forms that only have one box',
    a.makeModel === 'JEEP GRAND CHEROKEE', a.makeModel);
ok('makeModel joins on the second page too', b.makeModel === 'DODGE RAM', b.makeModel);

ok('a colour code is expanded for reading', a.colorLabel === 'Green', a.colorLabel);
ok('the raw colour code is still kept', a.color === 'GRN');
ok('a colour that is already a word is left alone', b.colorLabel === 'Red', b.colorLabel);

/* ================================================================== */
console.log('\n[the expiry, which is not a date]');

ok('the expiry is kept exactly as printed', a.expiration === '2027-09', a.expiration);
ok('the expiry is also offered month-first', a.expirationDisplay === '09/2027', a.expirationDisplay);
ok('a single-digit month is padded',
    CO.parse('COLORADO VEHICLE REGISTRATION\nEXPIRATION: 2027-3').expirationDisplay === '03/2027');
ok('a month-first expiry is accepted as printed',
    CO.parse('COLORADO VEHICLE REGISTRATION\nEXPIRATION: 9-2027').expirationDisplay === '09/2027');
ok('an unrecognisable expiry is passed through rather than invented',
    CO.parse('COLORADO VEHICLE REGISTRATION\nEXPIRATION: SEE FILE').expirationDisplay === 'SEE FILE');

/* ================================================================== */
console.log('\n[the query header]');

ok('the plate that was run is captured', a.query.queryFields === 'ZZZ9001', a.query.queryFields);
ok('the query target is captured without its trailing full stop',
    a.query.queriedOn === 'LIC/ZZZ9001', a.query.queriedOn);
ok('who ran it is captured', a.query.requestedBy === 'TESTER, PAT', a.query.requestedBy);
ok('the operator is captured', a.query.operator === 'TESTER, PAT', a.query.operator);
ok('the response time is captured', a.query.responseDateTime === '10/08/2026 - 14:39', a.query.responseDateTime);
ok('the request time is captured', a.query.requestDateTime === '10/08/2026 - 14:39', a.query.requestDateTime);
ok('"Requested By" does not swallow the empty Name label after it',
    a.query.requestedBy.indexOf('Name') === -1, a.query.requestedBy);

/* ================================================================== */
console.log('\n[furniture that must never reach a field]');

ok('the browser print header is not read as a field',
    JSON.stringify(a).indexOf('about:blank') === -1);
ok('the use-only disclaimer is not read as a field',
    JSON.stringify(a).indexOf('CRIMINAL JUSTICE PURPOSES') === -1);
ok('the end-of-message marker is not read as a field',
    JSON.stringify(a).indexOf('END OF MESSAGE') === -1);
ok('"STATE OF COLORADO" is not read as the plate state',
    a.plateState === 'CO' && a.plateState.length === 2);

/* ================================================================== */
console.log('\n[reading a single line of labels]');

const pairs = CO.scanPairs('MAKE : DODGE MODEL: RAM COLOR: RED');
ok('three labels are found on one line', pairs.length === 3, pairs);
ok('the first label is MAKE', pairs[0].label === 'MAKE' && pairs[0].value === 'DODGE', pairs[0]);
ok('the second label is MODEL', pairs[1].label === 'MODEL' && pairs[1].value === 'RAM', pairs[1]);
ok('the last value runs to the end of the line',
    pairs[2].label === 'COLOR' && pairs[2].value === 'RED', pairs[2]);
ok('a space before the colon is tolerated', pairs[0].value === 'DODGE');

const dup = CO.scanPairs('NAME: ONE PERSON NAME: TWO COMPANY');
ok('a repeated label is returned twice, in print order',
    dup.length === 2 && dup[0].value === 'ONE PERSON' && dup[1].value === 'TWO COMPANY', dup);

const blanks = CO.scanPairs('NAME2 : NAME2 :');
ok('two empty labels are returned as two empty values',
    blanks.length === 2 && blanks[0].value === '' && blanks[1].value === '', blanks);

ok('a line with no labels yields nothing', CO.scanPairs('STATE OF COLORADO').length === 0);
ok('the column heading line yields nothing', CO.scanPairs('REGISTRATION TITLE').length === 0);
ok('"TITLE STATUS" wins over "TITLE" at the same position',
    CO.scanPairs('TITLE STATUS: Active')[0].label === 'TITLE STATUS');
ok('"NAME2" wins over "NAME" at the same position',
    CO.scanPairs('NAME2: X')[0].label === 'NAME2');
ok('a label inside a word is not matched', CO.scanPairs('SURNAME_OF: X').length === 0 ||
    CO.scanPairs('SURNAME_OF: X')[0].label !== 'NAME');

/* ================================================================== */
console.log('\n[refusing to guess]');

const empty = CO.parse('');
ok('empty text returns a shaped object rather than throwing', empty && empty.format === 'co-vehicle');
ok('empty text is marked unrecognised', empty.recognized === false);
ok('empty text says why', empty.warnings.length > 0, empty.warnings);
ok('empty text has no plate', empty.plate === '');
ok('empty text has no VIN', empty.vin === '');

const nothing = CO.parse(null);
ok('null returns a shaped object', nothing && nothing.format === 'co-vehicle');
ok('null is marked unrecognised', nothing.recognized === false);

const noVehicle = CO.parse('COLORADO VEHICLE REGISTRATION\nCOUNTY: Adams');
ok('a page with only a county warns that nothing identifying was read',
    noVehicle.warnings.some(w => /Neither a plate nor a VIN/i.test(w)), noVehicle.warnings);
ok('hasVehicle is false for a page with only a county', CO.hasVehicle(noVehicle) === false);
ok('hasVehicle is true for a real page', CO.hasVehicle(a) === true);
ok('hasVehicle is false for null', CO.hasVehicle(null) === false);
ok('hasVehicle is true when only a VIN was read',
    CO.hasVehicle(CO.parse('COLORADO VEHICLE REGISTRATION\nVIN: 1ZZAA11A11Z000001')) === true);

// A VIN read off a scanned page is still worth showing the officer, who
// can see the page. It is returned WITH a warning, never silently fixed.
const shortVin = CO.parse('COLORADO VEHICLE REGISTRATION\nVIN: 1ZZAA11A11Z00001');
ok('a short VIN is still returned', shortVin.vin === '1ZZAA11A11Z00001', shortVin.vin);
ok('a short VIN is flagged', shortVin.warnings.some(w => /instead of 17/.test(w)), shortVin.warnings);
const longVin = CO.parse('COLORADO VEHICLE REGISTRATION\nVIN: 3C6JID6ATXCG276875');
ok('an over-long VIN is flagged', longVin.warnings.some(w => /instead of 17/.test(w)), longVin.warnings);
ok('a VIN containing I, O or Q is flagged as a likely misread',
    longVin.warnings.some(w => /I, O or Q/.test(w)), longVin.warnings);
ok('a clean VIN raises no VIN warning',
    !a.warnings.some(w => /VIN/.test(w)), a.warnings);

ok('spaces inside a VIN are removed',
    CO.parse('COLORADO VEHICLE REGISTRATION\nVIN: 1ZZAA11A 11Z000001').vin === '1ZZAA11A11Z000001');
ok('a lower-case VIN is upper-cased',
    CO.parse('COLORADO VEHICLE REGISTRATION\nVIN: 1zzaa11a11z000001').vin === '1ZZAA11A11Z000001');
ok('punctuation in a plate is removed',
    CO.parse('COLORADO VEHICLE REGISTRATION\nLICENSE: ZZZ-9001').plate === 'ZZZ9001');

// When the LICENSE line is unreadable, the plate the officer typed into
// the query is still on the page and is still the plate that was run.
const noLicenseLine = CO.parse([
    '10/8/25, 2:39 PM about:blank',
    'Query Fields: ZZZ9003',
    'RESPONSE FROM DMV',
    'QUERY ON: LIC/ZZZ9003.',
    'COLORADO VEHICLE REGISTRATION',
    'VIN: 1ZZAA11A11Z000001'
].join('\n'));
ok('the queried plate is used when the LICENSE line could not be read',
    noLicenseLine.plate === 'ZZZ9003', noLicenseLine.plate);
ok('the plate state defaults to CO only when a plate was found',
    noLicenseLine.plateState === 'CO' && empty.plateState === '');

/* ================================================================== */
console.log('\n[names are kept exactly as the state printed them]');

ok('the surname-first name is not rearranged',
    b.registeredOwner.name === 'EXAMPLEZ RORY DALE');
ok('a company name is not title-cased',
    b.titleOwner.name === 'PLACEHOLDER LENDING LLC');
ok('no comma is invented in a name that has none',
    b.registeredOwner.name.indexOf(',') === -1);

/* ================================================================== */
console.log('\n[line endings]');

ok('a CRLF page parses identically to an LF page',
    JSON.stringify(CO.parse(MERGED.replace(/\n/g, '\r\n'))) === JSON.stringify(a));

/* ================================================================== */
console.log('\n[the module loads the way the renderer needs it to]');

ok('detect is exported', typeof CO.detect === 'function');
ok('parse is exported', typeof CO.parse === 'function');
ok('hasVehicle is exported', typeof CO.hasVehicle === 'function');
ok('the label list is exported for the host to check against', Array.isArray(CO.LABELS) && CO.LABELS.length > 20);
ok('TITLE STATUS is listed before TITLE, or the longer label never matches',
    CO.LABELS.indexOf('TITLE STATUS') < CO.LABELS.indexOf('TITLE'));
ok('NAME2 is listed before NAME', CO.LABELS.indexOf('NAME2') < CO.LABELS.indexOf('NAME'));
ok('REQUEST DATE/TIME is listed before REQUEST',
    CO.LABELS.indexOf('REQUEST DATE/TIME') < CO.LABELS.indexOf('REQUEST'));

// THE UMD TRAP. A single-branch wrapper takes the CommonJS arm and leaves
// the global undefined in the renderer, and every host guard then silently
// never fires. This module assigns to both.
ok('the module also assigns itself to the global object',
    typeof globalThis.CoVehicleParser === 'object' && globalThis.CoVehicleParser !== null);
ok('the global and the require() export are the same object',
    globalThis.CoVehicleParser === CO);

/* ================================================================== */
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
