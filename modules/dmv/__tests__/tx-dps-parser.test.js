/*
 * tx-dps-parser — unit tests.
 *
 * Run: node modules\dmv\__tests__\tx-dps-parser.test.js
 *
 * WHY THIS EXISTS. The general-purpose DMV reader did not just miss fields
 * on the Texas printout, it got them WRONG: it read the word "Number" out
 * of the label "DL Number:" as the license number, and it swallowed three
 * lines of the page into the name. A wrong name on a suspect record is
 * worse than a blank one, so this format gets its own reader and its own
 * tests.
 *
 * The fixture is SYNTHETIC. It keeps the exact line-for-line layout of a
 * real Texas DPS Image Manager printout — including the fields that print
 * blank, the one field that prints inline, and the boilerplate underneath
 * the record — but every value in it is made up.
 */
const path = require('path');
const fs = require('fs');
const TX = require(path.join(__dirname, '..', 'tx-dps-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

const FIXTURE = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'tx-dps-printout.synthetic.txt'), 'utf8');

/* ------------------------------------------------------------------ */
console.log('\n[recognising the printout]');

ok('the Texas printout is recognised', TX.detect(FIXTURE) === true);
ok('nothing is recognised in empty text', TX.detect('') === false);
ok('nothing is recognised in null', TX.detect(null) === false);

const CAL_PHOTO = [
    'CAL-PHOTO IMAGE RECORD FOR:',
    'AWAD RANIA T',
    'D6074798',
    'EXPIRES: 10/10/2026CLASS: FSEX: F',
    'DATE OF BIRTH: 10/10/1980'
].join('\n');
ok('a California CAL-PHOTO record is not mistaken for Texas', TX.detect(CAL_PHOTO) === false);

const COLORADO = [
    'Colorado Department of Revenue',
    'CO__LICENSE_CATEGORY: R',
    'OLN: 12-345-6789 (CO)',
    'DOB: 04/17/1982'
].join('\n');
ok('a Colorado DOR record is not mistaken for Texas', TX.detect(COLORADO) === false);

// A page whose browser footer was cropped off still has to be recognised,
// because the officer may well print or save only the record itself.
const NO_FOOTER = FIXTURE.split('OFFICIAL STATE GOVERNMENT')[0];
ok('a printout with the boilerplate cropped off is still recognised', TX.detect(NO_FOOTER) === true);
ok('the site URL alone is not enough without a record',
    TX.detect('https://www.texasonline.state.tx.us/tolapp/txdlimage/DPSImageManager') === false);

/* ------------------------------------------------------------------ */
console.log('\n[reading the record]');

const r = TX.parse(FIXTURE);

ok('the name is read', r.name === 'MARGARET OLIVE FENWICK', r.name);
ok('the name is left exactly as the state printed it',
    r.name === r.name.toUpperCase(), r.name);
ok('the license number is read', r.dlNumber === '41238876', r.dlNumber);
ok('the license number is not the word "Number"', !/number/i.test(r.dlNumber), r.dlNumber);
ok('the issuing state is Texas', r.dlState === 'TX', r.dlState);
ok('the date of birth is read', r.dob === '1982-04-17', r.dob);
ok('the address line is read', r.address === '1600 SAMPLEWOOD LN', r.address);
ok('the city, state and ZIP are read',
    r.addressCityStateZip === 'CLEBURNE, TX 76099', r.addressCityStateZip);
ok('sex is read', r.sex === 'F', r.sex);
ok('race is read', r.race === 'WHITE', r.race);
ok('ethnicity is read', r.ethnicity === 'NON-HISPANIC', r.ethnicity);
ok('height is converted to inches', r.height === '60', r.height);
ok('weight is read', r.weight === '140', r.weight);
ok('eye colour is read and tidied', r.eyeColor === 'Hazel', r.eyeColor);
ok('hair colour is read and tidied', r.hairColor === 'Brown', r.hairColor);
ok('the license class is read', r.dlClass === 'ID', r.dlClass);
ok('the expiry date is read from the one field printed inline',
    r.dlExpires === '2030-04-17', r.dlExpires);
ok('the photo date is read', r.imageDate === '2023-09-15', r.imageDate);
ok('the CDL flag is read', r.cdlFlag === 'N', r.cdlFlag);

/* ------------------------------------------------------------------ */
console.log('\n[fields the state left blank]');

// Photo, Restriction and Endorsement print as a label with nothing under
// it. The next thing on the page is the NEXT label, and reading that as a
// value is how a page like this usually goes wrong.
const f = TX.readFields(FIXTURE);
ok('a blank Photo field stays blank', !f['Photo'], f['Photo']);
ok('a blank Restriction field stays blank', !f['Restriction'], f['Restriction']);
ok('a blank Endorsement field stays blank', !f['Endorsement'], f['Endorsement']);
ok('the restriction does not pick up the next label', r.restriction === '', r.restriction);
ok('the endorsement does not pick up the boilerplate underneath it',
    r.endorsement === '', r.endorsement);
ok('no field picked up the state use-only warning',
    Object.keys(f).every(k => !/OFFICIAL STATE/i.test(f[k])), f);
ok('no field picked up the support link',
    Object.keys(f).every(k => !/technical support/i.test(f[k])), f);
ok('no field picked up the site URL',
    Object.keys(f).every(k => !/texasonline/i.test(f[k])), f);
ok('the version number underneath the record is not read as a field',
    Object.keys(f).every(k => f[k] !== '3.7.0'), f);
ok('the print timestamp is not read as a date of birth', r.dob !== '2026-09-29', r.dob);

/* ------------------------------------------------------------------ */
console.log('\n[a header above the record does not hide it]');

// The browser header and footer can land either side of the record
// depending on how the text was pulled out of the PDF. Putting the title
// line first must not throw the record away.
const HEADER_FIRST = '09/29/2026, 10:46 AM\nTXDPS Driver License Image Manager - Image Manager\n\n' + FIXTURE;
const rh = TX.parse(HEADER_FIRST);
ok('the record is still found with the title printed above it',
    rh.name === 'MARGARET OLIVE FENWICK', rh.name);
ok('the license number survives a header above the record',
    rh.dlNumber === '41238876', rh.dlNumber);
ok('the boilerplate below the record is still cut',
    rh.endorsement === '', rh.endorsement);

/* ------------------------------------------------------------------ */
console.log('\n[dates]');

// Texas prints dates as a bare run of digits, so the order has to be
// worked out. A month over 12 and a year under 1900 are both impossible,
// which is what makes the two readings tell themselves apart.
ok('an eight-digit date starting with the year reads year first',
    TX.parseDate('19820417') === '1982-04-17');
ok('an eight-digit date ending with the year reads month first',
    TX.parseDate('12311999') === '1999-12-31');
ok('a leap day is accepted', TX.parseDate('20240229') === '2024-02-29');
ok('a slashed date is read', TX.parseDate('04/17/1982') === '1982-04-17');
ok('a single-digit slashed date is read', TX.parseDate('4/7/1982') === '1982-04-07');
ok('a two-digit year in the past reads as 19xx', TX.parseDate('04/17/82') === '1982-04-17');
ok('a two-digit year that is recent reads as 20xx', TX.parseDate('04/17/10') === '2010-04-17');
ok('an ISO date passes through', TX.parseDate('1982-04-17') === '1982-04-17');
ok('a dotted date is read', TX.parseDate('04.17.1982') === '1982-04-17');
ok('an impossible month is refused', TX.parseDate('19821317') === '');
ok('an impossible day is refused', TX.parseDate('19820432') === '');
ok('a month over twelve in a slashed date is refused', TX.parseDate('13/01/1982') === '');
ok('a run of digits that is not a date is refused', TX.parseDate('41238876') === '');
ok('a short run of digits is refused', TX.parseDate('1982') === '');
ok('empty text gives no date', TX.parseDate('') === '');
ok('null gives no date', TX.parseDate(null) === '');
ok('a date is never half-read', ['', '1982-04-17'].indexOf(TX.parseDate('19820417')) >= 0);

/* ------------------------------------------------------------------ */
console.log('\n[height]');

ok('500 is five feet even', TX.parseHeight('500') === '60');
ok('511 is five eleven', TX.parseHeight('511') === '71');
ok('600 is six feet even', TX.parseHeight('600') === '72');
ok('402 is four foot two', TX.parseHeight('402') === '50');
ok('a feet-and-inches form is read', TX.parseHeight("5'11") === '71');
ok('a hyphenated feet-and-inches form is read', TX.parseHeight('5-09') === '69');
ok('a value with impossible inches is refused rather than guessed',
    TX.parseHeight('599') === '', TX.parseHeight('599'));
ok('a four-digit value is refused', TX.parseHeight('5110') === '');
ok('an empty height gives nothing', TX.parseHeight('') === '');
ok('a missing height gives nothing', TX.parseHeight(undefined) === '');

/* ------------------------------------------------------------------ */
console.log('\n[colours]');

ok('a spelled-out colour is tidied', TX.normalizeColor('HAZEL') === 'Hazel');
ok('BROWN is tidied', TX.normalizeColor('BROWN') === 'Brown');
ok('a three-letter code is still understood', TX.normalizeColor('BRN') === 'Brown');
ok('BLK is still understood', TX.normalizeColor('BLK') === 'Black');
ok('an unknown colour is passed through untouched rather than guessed',
    TX.normalizeColor('SALT AND PEPPER') === 'SALT AND PEPPER');
ok('an empty colour gives nothing', TX.normalizeColor('') === '');
ok('a missing colour gives nothing', TX.normalizeColor(undefined) === '');

/* ------------------------------------------------------------------ */
console.log('\n[addresses]');

const a1 = TX.splitAddress('1600 SAMPLEWOOD LN, CLEBURNE, TX 76099');
ok('a plain address splits at the city', a1.address === '1600 SAMPLEWOOD LN', a1);
ok('the city line carries state and ZIP', a1.addressCityStateZip === 'CLEBURNE, TX 76099', a1);

// An apartment number belongs on the street line, not in the city line.
const a2 = TX.splitAddress('2210 EXAMPLE MESA TRL, APT 17, FORT WORTH, TX 76199');
ok('an apartment number stays on the street line',
    a2.address === '2210 EXAMPLE MESA TRL, APT 17', a2);
ok('the city is still found behind the apartment number',
    a2.addressCityStateZip === 'FORT WORTH, TX 76199', a2);

const a3 = TX.splitAddress('1600 SAMPLEWOOD LN, CLEBURNE, TX 76099-1234');
ok('a ZIP+4 is handled', a3.addressCityStateZip === 'CLEBURNE, TX 76099-1234', a3);

const a4 = TX.splitAddress('PO BOX 12');
ok('an address with no city line is kept whole', a4.address === 'PO BOX 12', a4);
ok('an address with no city line reports no city', a4.addressCityStateZip === '', a4);

const a5 = TX.splitAddress('');
ok('an empty address gives nothing', a5.address === '' && a5.addressCityStateZip === '', a5);

/* ------------------------------------------------------------------ */
console.log('\n[the shape the host expects]');

// Every importer reads these keys off the result and fills only the blank
// fields on the person. A missing key and an empty one must behave the
// same, so every key is always present.
const SHAPE = ['name', 'dob', 'dlNumber', 'dlState', 'dlClass', 'dlExpires', 'imageDate',
    'sex', 'race', 'ethnicity', 'height', 'weight', 'hairColor', 'eyeColor',
    'address', 'addressCityStateZip', 'restriction', 'cdlFlag', 'endorsement'];
SHAPE.forEach(k => ok('the result always carries ' + k, Object.prototype.hasOwnProperty.call(r, k)));

const empty = TX.parse('');
ok('an empty page parses without throwing', !!empty);
SHAPE.forEach(k => ok('an empty page reports no ' + k, empty[k] === ''));
ok('an empty page reports no issuing state either', empty.dlState === '', empty.dlState);

const junk = TX.parse('this page is not a driver license record at all');
ok('an unrelated page yields no name', junk.name === '', junk.name);
ok('an unrelated page yields no license number', junk.dlNumber === '', junk.dlNumber);

/* ------------------------------------------------------------------ */
console.log('\n[enough was read to be worth offering]');

// The host refuses the import unless at least a name, a license number or
// a date of birth came back. That is the gate this fixture has to clear.
ok('the fixture clears the host gate', !!(r.name || r.dlNumber || r.dob));
ok('an empty page does not clear the host gate', !(empty.name || empty.dlNumber || empty.dob));

/* ------------------------------------------------------------------ */
console.log('\n[the newer "Search Results" page: label and value on one line]');

// The Image Retrieval "Search Results" page (v3.7 / v4.0) prints the value
// right after the label and two fields side by side on most rows. Before
// this was handled, "Sex:M" ended up inside the ethnicity and Height,
// Weight, Class, Expiration and Hair were lost.
const fx = n => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8');
const SR = fx('tx-dps-search-results.synthetic.txt');
ok('the Search Results page is recognised', TX.detect(SR) === true);
const s = TX.parse(SR);
ok('SR: license number', s.dlNumber === '90011223', s.dlNumber);
ok('SR: state is TX', s.dlState === 'TX', s.dlState);
ok('SR: name', s.name === 'ORLA BRIGID TANSEY', s.name);
ok('SR: month-first date of birth', s.dob === '1991-09-14', s.dob);
ok('SR: ethnicity does not swallow the sex field', s.ethnicity === 'NON-HISPANIC', s.ethnicity);
ok('SR: sex from the right-hand column', s.sex === 'F', s.sex);
ok('SR: height (507 = 5\'07")', s.height === '67', s.height);
ok('SR: weight from the right-hand column', s.weight === '132', s.weight);
ok('SR: eye colour', s.eyeColor === 'Green', s.eyeColor);
ok('SR: hair colour from the right-hand column', s.hairColor === 'Red', s.hairColor);
ok('SR: image date', s.imageDate === '2024-03-18', s.imageDate);
ok('SR: class', s.dlClass === 'C', s.dlClass);
ok('SR: expiration date', s.dlExpires === '2031-09-14', s.dlExpires);
ok('SR: restriction from the right-hand column', s.restriction === 'A', s.restriction);
ok('SR: CDL flag', s.cdlFlag === 'N', s.cdlFlag);
ok('SR: blank endorsement stays blank', s.endorsement === '', s.endorsement);
ok('SR: street line', s.address === '415 EXAMPLE RIDGE RD', s.address);
ok('SR: run-together ZIP+4 is split', s.addressCityStateZip === 'FORT WORTH, TX 76199-0042', s.addressCityStateZip);

const fr = TX.readFields('Expiration Date:05292030 Restriction:\nCDL Flag:N Endorsement:\n');
ok('a blank field sharing a row does not take the next row as its value', !fr['Restriction'], fr);
ok('the next row is still read', fr['CDL Flag'] === 'N', fr);
const fe = TX.readFields('Ethnicity: Sex: F\n');
ok('a blank left-hand field leaves the right-hand one intact', !fe['Ethnicity'] && fe['Sex'] === 'F', fe);
const fw = TX.readFields('Name: SAMPLE CLASSY PERSON\nRace: WHITE\n');
ok('a label word inside a value does not split it (no colon)', fw['Name'] === 'SAMPLE CLASSY PERSON', fw);

ok('a padded ZIP extension is dropped',
    TX.splitAddress('77 SAMPLE BROOK CIRCLE, KELLER, TX 761990000').addressCityStateZip === 'KELLER, TX 76199');
ok('a real ZIP extension is kept',
    TX.splitAddress('1 EXAMPLE ST, FORT WORTH, TX 761990042').addressCityStateZip === 'FORT WORTH, TX 76199-0042');

/* ------------------------------------------------------------------ */
console.log('\n[a page that could only be OCR\'d]');

// Saved with a font that has no text mapping, the page can only be OCR'd.
// Whole-page OCR drops the rows beside the photo and garbles "Sex: M";
// a second, column-mode (PSM 4) read keeps every row. The host merges them.
const OCR = fx('tx-dps-search-results-ocr.synthetic.txt');
const P4 = fx('tx-dps-search-results-psm4.synthetic.txt');
ok('the whole-page OCR read is recognised', TX.detect(OCR) === true);
ok('the column-mode OCR read is recognised', TX.detect(P4) === true);
const o = TX.parse(OCR);
ok('OCR: name read', o.name === 'ROWAN ELLIS QUARTERMAINE', o.name);
ok('OCR: ethnicity keeps only the word, not the OCR noise after it', o.ethnicity === 'UNKNOWN', o.ethnicity);
ok('OCR: the garbled sex row gives no sex', o.sex === '', o.sex);
ok('OCR: photo noise does not become a field', o.address === '77 SAMPLE BROOK CIRCLE', o.address);
const p = TX.parse(P4);
ok('PSM4: "Cc" is class C', p.dlClass === 'C', p.dlClass);
ok('PSM4: sex', p.sex === 'M', p.sex);
ok('PSM4: expiration date', p.dlExpires === '2029-12-02', p.dlExpires);
ok('PSM4: blank ethnicity stays blank', p.ethnicity === '', p.ethnicity);
const b = TX.parseBest([P4, OCR]);
ok('merged: class from the column read', b.dlClass === 'C', b.dlClass);
ok('merged: image date from the column read', b.imageDate === '2023-06-22', b.imageDate);
ok('merged: CDL flag from the column read', b.cdlFlag === 'N', b.cdlFlag);
ok('merged: ethnicity filled from the whole-page read', b.ethnicity === 'UNKNOWN', b.ethnicity);
ok('merged: height', b.height === '73', b.height);
ok('merged: license number + TX', b.dlNumber === '90044518' && b.dlState === 'TX', b);
ok('merged: padded ZIP dropped', b.addressCityStateZip === 'KELLER, TX 76199', b.addressCityStateZip);
ok('parseBest ignores reads that are not this page', TX.parseBest(['hello', CAL_PHOTO]) === null);
ok('parseBest with one read equals parse', JSON.stringify(TX.parseBest([SR])) === JSON.stringify(s));
ok('parseBest: the first read wins a conflict',
    TX.parseBest([SR.replace('Weight:132', 'Weight:140'), SR]).weight === '140');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
