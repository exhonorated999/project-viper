/*
 * DMV printout dispatch — unit tests.
 *
 * Run: node modules\dmv\__tests__\dmv-dispatch.test.js
 *
 * WHY THIS EXISTS. The Texas reader is a module, but the decision to USE it
 * lives in the page, in parseDmvText().  A reader that works perfectly and
 * is never reached looks exactly like a reader that is broken.  This test
 * lifts the real dispatch out of case-detail-with-analytics.html — it does
 * not copy it — and drives it with a Texas printout, a California CAL-PHOTO
 * record and a Colorado DOR record, so that wiring Texas in cannot quietly
 * change what the other two states already do.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const TX = require(path.join(__dirname, '..', 'tx-dps-parser.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

// The page is CRLF on disk; normalise before matching any source anchor.
const PAGE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8')
    .replace(/\r\n/g, '\n');

function lift(startAnchor, endAnchor, what) {
    const a = PAGE.indexOf(startAnchor);
    if (a < 0) throw new Error('could not find the start of ' + what + ' in the page');
    const b = PAGE.indexOf(endAnchor, a);
    if (b < 0) throw new Error('could not find the end of ' + what + ' in the page');
    return PAGE.slice(a, b);
}

const DMV_BLOCK = lift('const DMV_COLOR_MAP = {', 'async function importDmvPrintout(', 'the DMV printout readers');

const sandbox = {
    console, Math, JSON, parseInt, parseFloat, String, RegExp, Object, Array, Date, isNaN,
    TxDpsParser: TX,
    showToast: function () {},
    _viewSuspectDocPopup: function () {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(DMV_BLOCK, sandbox);

const parseDmvText = sandbox.parseDmvText;
const detectDmvState = sandbox.detectDmvState;

ok('the page still defines parseDmvText', typeof parseDmvText === 'function');
ok('the page still defines detectDmvState', typeof detectDmvState === 'function');

/* ------------------------------------------------------------------ */
console.log('\n[a Texas printout reaches the Texas reader]');

const TXDOC = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'tx-dps-printout.synthetic.txt'), 'utf8');

const t = parseDmvText(TXDOC);
ok('the name comes back whole', t.name === 'MARGARET OLIVE FENWICK', t.name);
ok('the name is not three lines of the page run together', !/\n/.test(t.name), t.name);
ok('the license number is the number, not the word "Number"', t.dlNumber === '41238876', t.dlNumber);
ok('the date of birth is read', t.dob === '1982-04-17', t.dob);
ok('the street line is separated from the city line',
    t.address === '1600 WOODSIDE LN' && t.addressCityStateZip === 'CLEBURNE, TX 76033', t);
ok('height comes back in inches', t.height === '60', t.height);
ok('eye colour is tidied', t.eyeColor === 'Hazel', t.eyeColor);
ok('race is read', t.race === 'WHITE', t.race);
ok('the state is reported as Texas', detectDmvState(TXDOC) === 'TX', detectDmvState(TXDOC));
ok('enough was read for the host to offer the import', !!(t.name || t.dlNumber || t.dob));

/* ------------------------------------------------------------------ */
console.log('\n[California is untouched]');

const CAL = [
    'CAL-PHOTO',
    'IMAGE RECORD FOR:',
    'FENWICK MARGARET O',
    'D6074798',
    'EXPIRES: 10/10/2026CLASS: FSEX: F',
    'HAIR: BLKEYES: BRNHEIGHT: 504WEIGHT: 220',
    'DATE OF BIRTH: 10/10/1980',
    'ADDRESS: 918 S TEAKWOOD AVE, BLOOMINGTON, CA 92316'
].join('\n');

const c = parseDmvText(CAL);
ok('a CAL-PHOTO record still reads its name', c.name === 'Margaret O Fenwick', c.name);
ok('a CAL-PHOTO record still reads its license number', c.dlNumber === 'D6074798', c.dlNumber);
ok('a CAL-PHOTO record still reports California', c.dlState === 'CA', c.dlState);
ok('a CAL-PHOTO record still reads its date of birth', c.dob === '1980-10-10', c.dob);
ok('a CAL-PHOTO record still reads its height', c.height === '64', c.height);
ok('a CAL-PHOTO record still reads its hair colour', c.hairColor === 'Black', c.hairColor);
ok('a CAL-PHOTO record still reads its eye colour', c.eyeColor === 'Brown', c.eyeColor);
ok('a CAL-PHOTO record still splits its address',
    c.address === '918 S TEAKWOOD AVE' && c.addressCityStateZip === 'BLOOMINGTON, CA 92316', c);
ok('California is still detected as California', detectDmvState(CAL) === 'CA', detectDmvState(CAL));

/* ------------------------------------------------------------------ */
console.log('\n[Colorado is untouched]');

const CO = [
    'Colorado Department of Revenue',
    'CO__LICENSE_CATEGORY: R',
    'OLN: 123456789 (CO)',
    'DOB: 04/17/1982',
    'Sex: F',
    'Height: 504',
    'Weight: 140',
    'Hair: BRN',
    'Eye: HAZ',
    'MARGARET O FENWICK',
    '1600 WOODSIDE LN',
    'CLEBURNE, CO 80014'
].join('\n');

const co = parseDmvText(CO);
ok('a Colorado record still reads its license number', co.dlNumber === '123456789', co.dlNumber);
ok('a Colorado record still reads its issuing state', co.dlState === 'CO', co.dlState);
ok('a Colorado record still reads its date of birth', co.dob === '1982-04-17', co.dob);
ok('a Colorado record still reads its height', co.height === '64', co.height);
ok('a Colorado record still reads its hair colour', co.hairColor === 'Brown', co.hairColor);
ok('a Colorado record still reads its address', co.address === '1600 WOODSIDE LN', co.address);
ok('Colorado is still detected as Colorado', detectDmvState(CO) === 'CO', detectDmvState(CO));

/* ------------------------------------------------------------------ */
console.log('\n[the Texas check cannot swallow the other states]');

ok('Texas does not claim a CAL-PHOTO record', detectDmvState(CAL) !== 'TX');
ok('Texas does not claim a Colorado record', detectDmvState(CO) !== 'TX');
ok('an unrecognised printout still reports no state', detectDmvState('nothing useful here') === '');

/* ------------------------------------------------------------------ */
console.log('\n[the page survives the Texas module not loading]');

// A script tag can fail. When it does, Texas simply stops being recognised
// — every other printout must still import exactly as before.
const alt = {
    console, Math, JSON, parseInt, parseFloat, String, RegExp, Object, Array, Date, isNaN,
    showToast: function () {}, _viewSuspectDocPopup: function () {}
};
alt.window = alt;
alt.globalThis = alt;
vm.createContext(alt);
vm.runInContext(DMV_BLOCK, alt);

ok('detectDmvState does not throw without the Texas module',
    (function () { try { alt.detectDmvState(TXDOC); return true; } catch (e) { return false; } })());
ok('parseDmvText does not throw without the Texas module',
    (function () { try { alt.parseDmvText(TXDOC); return true; } catch (e) { return false; } })());
ok('California still works without the Texas module',
    alt.parseDmvText(CAL).dlNumber === 'D6074798');
ok('Colorado still works without the Texas module',
    alt.parseDmvText(CO).dlNumber === '123456789');

/* ------------------------------------------------------------------ */
console.log('\n[the page is wired to the module]');

const RAW = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8');
ok('the Texas reader is loaded by the page',
    RAW.indexOf('modules/dmv/tx-dps-parser.js') >= 0);
ok('the Texas reader is loaded synchronously, like the other parsers',
    /<script src="modules\/dmv\/tx-dps-parser\.js"><\/script>/.test(RAW));
ok('race is offered on the import preview',
    RAW.indexOf('fields.push(`<b>Race:</b> ${parsed.race}`)') >= 0);
ok('race is filled on all four person tabs',
    (RAW.match(/if \(parsed\.race && !\w+\.race\)/g) || []).length === 4,
    (RAW.match(/if \(parsed\.race && !\w+\.race\)/g) || []).length);
ok('race is carried onto a newly created person on all four tabs',
    (RAW.match(/race: parsed\.race \|\| ''/g) || []).length === 4,
    (RAW.match(/race: parsed\.race \|\| ''/g) || []).length);
ok('a state ID card is called out on all four tabs',
    (RAW.match(/parsed\.dlClass === 'ID'/g) || []).length === 4,
    (RAW.match(/parsed\.dlClass === 'ID'/g) || []).length);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
