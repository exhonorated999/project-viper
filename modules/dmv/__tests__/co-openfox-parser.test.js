/*
 * co-openfox-parser — unit tests.
 *
 * Run: node modules\dmv\__tests__\co-openfox-parser.test.js
 *
 * The fixture is SYNTHETIC. It was laid out line for line from a redacted
 * VIPER Scout submission (Westminster PD, two one-page Open Fox returns);
 * every value in it is invented.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const FOX = require(path.join(__dirname, '..', 'co-openfox-parser.js'));
const TX = require(path.join(__dirname, '..', 'tx-dps-parser.js'));
const VEH = require(path.join(__dirname, '..', 'co-vehicle-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

const fx = (n) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8');
// core.autocrlf is on in this repo, so a checkout may hand the fixture back
// with CRLF. Normalise it here; CRLF reading is asserted separately below.
const DOC = fx('co-openfox-dl.synthetic.txt').replace(/\r\n/g, '\n');

/* ------------------------------------------------------------------ */
console.log('\n[the fixture is what it claims to be]');
ok('the fixture keeps the single-space spacer lines the real page has',
    (DOC.match(/\n \n/g) || []).length >= 12, (DOC.match(/\n \n/g) || []).length);

/* ------------------------------------------------------------------ */
console.log('\n[detection]');
ok('an Open Fox driver return is recognised', FOX.detect(DOC) === true);
ok('it is still recognised with Windows line endings', FOX.detect(DOC.replace(/\n/g, '\r\n')) === true);
ok('it is recognised from the DOR trailer even without the ORI line',
    FOX.detect(DOC.replace(/Source ORI:CODMV0000/, '')) === true);
ok('it is recognised from the field labels even without the TypeStatusClass header',
    FOX.detect(DOC.replace('TypeStatusClass', '')) === true);
ok('empty text is not recognised', FOX.detect('') === false);
ok('null is not recognised', FOX.detect(null) === false);
ok('a page with the driver labels but no sign of the Colorado DOR is not claimed',
    FOX.detect('Number\n \n12345\nDOB\n \n01011980\nTypeStatusClass\nDriver LicenseVALID') === false);
ok('a DOR response that is not a driver record is not claimed',
    FOX.detect('Source ORI:CODMV0000\nSummary:QV: LIC=ABC123\nMake\n \nFORD\nOUT: W13W 4 AT 10:28 13OCT26') === false);
ok('the Texas reader does not claim it', TX.detect(DOC) === false);
ok('the Colorado vehicle reader does not claim it', VEH.detect(DOC) === false);

/* ------------------------------------------------------------------ */
console.log('\n[reading the record]');
const r = FOX.parse(DOC);
ok('format is tagged', r.format === 'co-openfox', r.format);
ok('the name is read verbatim', r.name === 'MARGARET OLIVE FENWICK', r.name);
ok('the street line is read (unit kept)', r.address === '1600 WOODSIDE LN APT 4', r.address);
ok('the city line is read with its ZIP+4', r.addressCityStateZip === 'WESTMINSTER, CO 80031-1234', r.addressCityStateZip);
ok('the license number is the number, not the page heading', r.dlNumber === '99-123-4567', r.dlNumber);
ok('the issuing state is Colorado', r.dlState === 'CO', r.dlState);
ok('sex is read', r.sex === 'F', r.sex);
ok('the date of birth comes from the RECORD, not from the query line', r.dob === '1982-04-17', r.dob);
ok('the query date of birth is not used', r.dob !== '1970-01-01');
ok('height 5\' 09" comes back as 69 inches', r.height === '69', r.height);
ok('weight drops the "lbs"', r.weight === '180', r.weight);
ok('eye colour is read from its own label', r.eyeColor === 'Hazel', r.eyeColor);
ok('hair colour is read from its own label', r.hairColor === 'Brown', r.hairColor);
ok('expiry is read', r.dlExpires === '2029-04-17', r.dlExpires);
ok('issue date is read', r.dlIssued === '2021-03-02', r.dlIssued);
ok('SSN is read', r.ssn === '000-12-3456', r.ssn);
ok('donor flag is read', r.donor === 'YES', r.donor);
ok('disability flag is read', r.disability === 'NO', r.disability);
ok('license type is split off the run-together line', r.dlType === 'Regular Driver License', r.dlType);
ok('license status is split off the run-together line', r.dlStatus === 'VALID', r.dlStatus);
ok('a driver license is not called an ID card', r.dlClass !== 'ID', r.dlClass);
ok('race is present and blank (the page does not print it)', r.race === '');
ok('enough is read for the host to offer the import', !!(r.name && r.dlNumber && r.dob));
ok('Windows line endings read the same',
    JSON.stringify(FOX.parse(DOC.replace(/\n/g, '\r\n'))) === JSON.stringify(r));

const KEYS = ['name', 'dob', 'dlNumber', 'dlState', 'dlClass', 'dlExpires', 'sex', 'race', 'height',
    'weight', 'hairColor', 'eyeColor', 'address', 'addressCityStateZip', 'ssn'];
const empty = FOX.parse('');
ok('every host field is present on an empty parse', KEYS.every(k => typeof empty[k] === 'string'),
    KEYS.filter(k => typeof empty[k] !== 'string'));
ok('an empty parse reads nothing', KEYS.every(k => empty[k] === ''));
ok('null does not throw', (function () { try { FOX.parse(null); return true; } catch (e) { return false; } })());

/* ------------------------------------------------------------------ */
console.log('\n[layout variations]');

// The eye and hair labels were redacted in the sample, so their exact
// wording is unknown. Short forms must read too, and the order of the two
// must not matter.
const SWAPPED = DOC.replace('Eye Color\n \nHAZ\nHair Color\n \nBRO', 'Hair\n \nBLK\nEyes\n \nBLU');
const s = FOX.parse(SWAPPED);
ok('"Hair" / "Eyes" short labels are read, in either order',
    s.hairColor === 'Black' && s.eyeColor === 'Blue', [s.hairColor, s.eyeColor]);

const UNKNOWN_COLOR = FOX.parse(DOC.replace('\nHAZ\n', '\nZZQ\n'));
ok('an unrecognised colour code is passed through rather than guessed', UNKNOWN_COLOR.eyeColor === 'ZZQ', UNKNOWN_COLOR.eyeColor);

const BLANK_SSN = FOX.parse(DOC.replace('SSN\n \n000-12-3456\n', 'SSN\n \n'));
ok('a blank field does not adopt the next label as its value', BLANK_SSN.ssn === '', BLANK_SSN.ssn);
ok('...and the next field still reads', BLANK_SSN.disability === 'NO', BLANK_SSN.disability);

const UNKNOWN_LABEL = FOX.parse(DOC.replace('Issued\n \n03022021\n', 'Issued\n \nCard Type\n \nDUPLICATE\n'));
ok('a label this reader does not know cannot become the previous field\'s value',
    UNKNOWN_LABEL.dlIssued === '', UNKNOWN_LABEL.dlIssued);

const NO_SPACER = FOX.parse(DOC.replace(/\n \n/g, '\n'));
ok('the record reads without the spacer lines', NO_SPACER.dlNumber === '99-123-4567' && NO_SPACER.dob === '1982-04-17' && NO_SPACER.name === 'MARGARET OLIVE FENWICK',
    [NO_SPACER.dlNumber, NO_SPACER.dob, NO_SPACER.name]);

const NO_HEADER = FOX.parse(DOC.replace('Name and Mailing Address\n', ''));
ok('the name block is found without its "Name and …" header',
    NO_HEADER.name === 'MARGARET OLIVE FENWICK' && NO_HEADER.address === '1600 WOODSIDE LN APT 4'
    && NO_HEADER.addressCityStateZip === 'WESTMINSTER, CO 80031-1234', NO_HEADER);

const TWO_STREET = FOX.parse(DOC.replace('1600 WOODSIDE LN APT 4\n', '1600 WOODSIDE LN\nAPT 4\n'));
ok('a second street line is kept, joined with a comma', TWO_STREET.address === '1600 WOODSIDE LN, APT 4', TWO_STREET.address);

const NO_ZIP4 = FOX.parse(DOC.replace('80031-1234', '80031'));
ok('a five-digit ZIP reads', NO_ZIP4.addressCityStateZip === 'WESTMINSTER, CO 80031', NO_ZIP4.addressCityStateZip);

const ID_CARD = FOX.parse(DOC.replace('Regular Driver LicenseVALID', 'Identification CardVALID'));
ok('an identification card is flagged as ID so the host can say so', ID_CARD.dlClass === 'ID', ID_CARD.dlClass);

const SUSP = FOX.parse(DOC.replace('Regular Driver LicenseVALID', 'Regular Driver LicenseSUSPENDED'));
ok('a suspended status is read', SUSP.dlStatus === 'SUSPENDED', SUSP.dlStatus);
ok('"NOT VALID" is not read as "VALID"',
    FOX.parseTypeStatus('Regular Driver LicenseNOT VALID').status === 'NOT VALID');
ok('"INVALID" is not read as "VALID"',
    FOX.parseTypeStatus('Regular Driver LicenseINVALID').status === 'INVALID');
ok('a class code after the status is kept',
    FOX.parseTypeStatus('Regular Driver LicenseVALIDR').cls === 'R');
ok('a type line with no status word keeps the whole line as the type',
    FOX.parseTypeStatus('Regular Driver License').type === 'Regular Driver License'
    && FOX.parseTypeStatus('Regular Driver License').status === '');

const TRAILER_ONLY = FOX.parse(DOC.replace(/TypeStatusClass\nRegular Driver LicenseVALID\n/, 'TypeStatusClass\n'));
ok('a missing type line does not adopt the DOR trailer', TRAILER_ONLY.dlType === '' && TRAILER_ONLY.dlStatus === '',
    [TRAILER_ONLY.dlType, TRAILER_ONLY.dlStatus]);

/* ------------------------------------------------------------------ */
console.log('\n[dates]');
ok('MMDDYYYY', FOX.parseDate('04171982') === '1982-04-17');
ok('YYYYMMDD', FOX.parseDate('19820417') === '1982-04-17');
ok('MM/DD/YYYY', FOX.parseDate('04/17/1982') === '1982-04-17');
ok('ISO passes through', FOX.parseDate('1982-04-17') === '1982-04-17');
ok('a two-digit year is refused', FOX.parseDate('04/17/82') === '');
ok('month 13 is refused', FOX.parseDate('13171982') === '');
ok('garbage is refused', FOX.parseDate('NONE') === '');

/* ------------------------------------------------------------------ */
console.log('\n[height and weight]');
ok('5\' 09"', FOX.parseHeight('5\' 09"') === '69');
ok('5\'09', FOX.parseHeight('5\'09') === '69');
ok('6\' 00"', FOX.parseHeight('6\' 00"') === '72');
ok('curly quotes', FOX.parseHeight('5\u2019 09\u201D') === '69');
ok('509 run together', FOX.parseHeight('509') === '69');
ok('5\' 14" is refused', FOX.parseHeight('5\' 14"') === '');
ok('"180 lbs"', FOX.parseWeight('180 lbs') === '180');
ok('"95 LBS"', FOX.parseWeight('95 LBS') === '95');
ok('"180"', FOX.parseWeight('180') === '180');
ok('"heavy" is refused', FOX.parseWeight('heavy') === '');

/* ------------------------------------------------------------------ */
console.log('\n[the module loads in a page]');
// `module` is defined in VIPER's renderer. The global must be set anyway.
const src = fs.readFileSync(path.join(__dirname, '..', 'co-openfox-parser.js'), 'utf8');
const sb = { module: { exports: {} } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb);
ok('the global is set even when `module` exists', sb.CoOpenFoxParser && typeof sb.CoOpenFoxParser.parse === 'function');
ok('module.exports is set too', typeof sb.module.exports.detect === 'function');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
