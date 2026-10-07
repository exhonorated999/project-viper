/**
 * assist-cases.test.js — plain node, no Electron needed.
 *
 *   node modules/assist-cases/__tests__/assist-cases.test.js
 *
 * An "assist" case is work done on ANOTHER detective's case — warrants,
 * preservations, interviews, follow-up. The investigator wants it tracked in
 * VIPER like any other case, but two things must hold or the feature is worse
 * than not having it:
 *
 *   1. THE STATISTICS LINE. Case-level counts (cases assigned, open, closed,
 *      clearance rate) must EXCLUDE assists — otherwise the officer's caseload
 *      is inflated with cases they were never assigned, and the lead detective
 *      is already counting the same case on their side. Work-product counts
 *      (warrants, arrests, seizures, recoveries) must INCLUDE them, combined,
 *      with no separate breakdown. The officer did that work.
 *
 *   2. THE HAND-OFF. The export must arrive at the lead detective's desk
 *      identifiable as someone else's work product, in one folder that cannot
 *      scatter into their own case folders, with file names UNCHANGED — a
 *      renamed file stops matching the report that describes it.
 *
 * Both sections LIFT the shipping code out of index.html / electron-main.js
 * and run it here. A copied block is the thing that drifts.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    ok(actual === expected, label + ' — got ' + JSON.stringify(actual) +
       ', expected ' + JSON.stringify(expected));
}

const REPO = path.join(__dirname, '..', '..', '..');
// The big HTML pages are CRLF on disk; normalise before matching anchors.
const INDEX = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');

// Slice from `startAnchor` up to (not including) `endAnchor`.
function slice(src, startAnchor, endAnchor, label) {
    const a = src.indexOf(startAnchor);
    ok(a !== -1, 'anchor present: ' + label + ' start');
    const b = src.indexOf(endAnchor, a);
    ok(b !== -1, 'anchor present: ' + label + ' end');
    return src.slice(a, b);
}

// ═════════════════════════════════════════════════════════════════════════
//  1. THE STATISTICS LINE  (lifted out of index.html)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. The statistics line (lifted from index.html)');

const HELPERS = slice(INDEX,
    '// ═══ Assist cases and the statistics line',
    'function getTotalRecoveredVehicles()', 'assist helpers');

ok(/CASE-LEVEL counts[\s\S]{0,400}EXCLUDE assists/.test(HELPERS),
   'the rule is written down where the next person will read it');
ok(/WORK-PRODUCT counts[\s\S]{0,400}INCLUDE assists/.test(HELPERS),
   'and the other half of the rule too');

const ARRESTS = slice(INDEX, 'function getTotalArrests()', '\n        function getMonthlyArrests', 'getTotalArrests');
const MARRESTS = slice(INDEX, 'function getMonthlyArrests()', '\n        function getNewCases', 'getMonthlyArrests');
const NEWMONTH = slice(INDEX, 'function getNewCasesThisMonth()', '\n        function getTotalNewCases', 'getNewCasesThisMonth');
const NEWTOTAL = slice(INDEX, 'function getTotalNewCases()', '\n        function ', 'getTotalNewCases');

// A tiny localStorage stub. Everything below drives the real functions.
const STORE = {};
const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(STORE, k) ? STORE[k] : null),
    setItem: (k, v) => { STORE[k] = String(v); },
    removeItem: (k) => { delete STORE[k]; }
};

const statEnv = {
    localStorage, console, JSON, Math, Array, Object, String, Number, Set, Date, Boolean,
    // The real host helpers these functions lean on. _inThisMonth is the
    // module-scoped period gate from 5.2.3; a fixed window keeps this test
    // from failing on the first of the month.
    _inThisMonth: (d) => {
        if (!d) return false;
        const t = new Date(String(d).length === 10 ? String(d) + 'T00:00' : d);
        return !isNaN(t) && t.getUTCFullYear() === 2026 && t.getUTCMonth() === 8; // Sep 2026
    },
    _itemDate: (item, caseItem) => (item && item.createdAt) || (caseItem && caseItem.createdAt) || null
};
statEnv.window = statEnv;
statEnv.globalThis = statEnv;
vm.createContext(statEnv);
// `const`/`let` in a lifted block never land on a vm sandbox global, but
// function declarations do — and every one of these is a declaration.
vm.runInContext(HELPERS + '\n' + ARRESTS + '\n' + MARRESTS + '\n' + NEWMONTH + '\n' + NEWTOTAL, statEnv);

ok(typeof statEnv._isAssistCase === 'function', 'the lifted helpers registered');
ok(typeof statEnv.getTotalArrests === 'function', 'getTotalArrests lifted');

// -- _isAssistCase is exact: only the literal 'assist' counts, and nothing
//    about a missing/garbage record may throw.
eq(statEnv._isAssistCase({ caseRole: 'assist' }), true, 'assist is an assist');
eq(statEnv._isAssistCase({ caseRole: 'primary' }), false, 'primary is not');
eq(statEnv._isAssistCase({}), false, 'a case with no role is a normal case');
eq(statEnv._isAssistCase(null), false, 'null is not an assist');
eq(statEnv._isAssistCase(undefined), false, 'undefined is not an assist');
eq(statEnv._isAssistCase({ caseRole: 'Assist' }), false, 'the flag is not case-insensitive by accident');

// -- The two list filters are complements of each other.
const CASES = [
    { id: 'c1', caseNumber: '26-001', status: 'active', createdAt: '2026-09-04T10:00:00Z' },
    { id: 'c2', caseNumber: '26-002', status: 'closed-arrest', createdAt: '2026-09-06T10:00:00Z', caseRole: 'primary' },
    { id: 'c3', caseNumber: '26-003', status: 'closed-arrest', createdAt: '2026-09-08T10:00:00Z', caseRole: 'assist' },
    { id: 'c4', caseNumber: '26-004', status: 'active', createdAt: '2026-08-02T10:00:00Z', caseRole: 'assist' }
];
STORE['viperCases'] = JSON.stringify(CASES);
STORE['viperCustomStatuses'] = JSON.stringify([]);

eq(statEnv._statCases(CASES).length, 2, '_statCases drops the assists');
eq(statEnv._assistCaseList(CASES).length, 2, '_assistCaseList keeps only the assists');
eq(statEnv._statCases(CASES).length + statEnv._assistCaseList(CASES).length, CASES.length,
   'the two lists partition the case list — no case is counted twice or lost');
// Called with no argument, both read viperCases themselves.
eq(statEnv._statCases().length, 2, '_statCases reads viperCases when given nothing');
eq(statEnv._assistCaseList().length, 2, '_assistCaseList reads viperCases when given nothing');
// A corrupt entry must not take down the dashboard.
eq(statEnv._statCases([null, undefined, { caseRole: 'assist' }, {}]).length, 1,
   'null/undefined entries are not silently promoted to countable cases');

// -- CASE-LEVEL: assists are out.
eq(statEnv.getTotalNewCases(), 2, 'total cases assigned excludes assists');
eq(statEnv.getNewCasesThisMonth(), 2, 'cases this month excludes assists (c1 + c2, not c3)');

// -- WORK PRODUCT: assists are in. c3 is an assist whose suspect this officer
//    arrested; that arrest is their work and it must count.
STORE['suspects_c1'] = JSON.stringify([{ arrested: false }]);
STORE['suspects_c3'] = JSON.stringify([{ arrested: true, arrestDate: '2026-09-08' }]);
eq(statEnv.getTotalArrests(), 1, 'an arrest developed on an assist case still counts as this officer\'s arrest');
eq(statEnv.getMonthlyArrests(), 1, 'and it counts this month too');

// -- THE BACK DOOR. getTotalArrests falls back to Math.max(suspects, cases
//    with an arrest status). On an assist, that status is the LEAD
//    detective's closure — not this officer's arrest. c2 and c3 are both
//    closed-with-arrest; only c2 may be inferred.
delete STORE['suspects_c1'];
delete STORE['suspects_c3'];
eq(statEnv.getTotalArrests(), 1,
   'the status-derived arrest fallback counts the officer\'s own closure, not the assist');
eq(statEnv.getMonthlyArrests(), 1,
   'same for the monthly figure');

// -- And with no assist in the picture the fallback is unchanged, so this
//    did not quietly change the number every existing user sees.
STORE['viperCases'] = JSON.stringify(CASES.map(c => ({ ...c, caseRole: 'primary' })));
eq(statEnv.getTotalArrests(), 2, 'with no assists the arrest fallback behaves exactly as before');
eq(statEnv.getTotalNewCases(), 4, 'with no assists every case is counted');
STORE['viperCases'] = JSON.stringify(CASES);

// ═════════════════════════════════════════════════════════════════════════
//  2. THE DASHBOARD  (source-level invariants in index.html)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n2. Dashboard wiring');

const DASH = slice(INDEX, 'function updateDashboardCaseData(', '\n        function ', 'updateDashboardCaseData');
ok(/const allCases = JSON\.parse\(localStorage\.getItem\('viperCases'\)\)/.test(DASH),
   'the full list is read once');
ok(/const cases = _statCases\(allCases\);/.test(DASH),
   'every case-level bucket below works off the assist-free list');
ok(/const assistCases = _assistCaseList\(allCases\);/.test(DASH),
   'and the assists are kept for their own card');
ok(DASH.indexOf("dashboardMetrics['assist_cases']") !== -1,
   'the assist card is populated');
ok(/not in case stats/.test(DASH),
   'the card says plainly that it is not in the case statistics');

// The metric must be registered and labelled, or the card renders blank.
ok(/'assist_cases':\s*\{[^}]*value: 0/.test(INDEX), 'assist_cases is in the metric registry');
ok(INDEX.indexOf("'assist_cases': 'Assists (Other Detectives)'") !== -1,
   'assist_cases has a human label');

// Assists stay VISIBLE in the case list with a badge — hiding the officer's
// own work would be worse, and the badge is what explains why the card
// counts are lower than the row count.
ok(/caseItem\.caseRole === 'assist'/.test(INDEX), 'the table renders an assist badge');
ok(/>ASSIST</.test(INDEX), 'the badge says ASSIST');
ok(/not counted in case statistics/.test(INDEX), 'and its tooltip says why');
ok(/f === 'assist'/.test(INDEX), 'there is a filter that isolates the assists');
ok(INDEX.indexOf("assist: 'Assisting Other Detectives'") !== -1, 'the filter has a title');

// Create Case must capture the role and the lead detective.
ok(/name="newCaseRole"[\s\S]{0,200}value="primary"/.test(INDEX), 'Create Case defaults to "my case"');
ok(/value="primary"[^>]*checked/.test(INDEX), 'and primary is the checked radio');
ok(INDEX.indexOf('id="newCaseLeadDetective"') !== -1, 'Create Case asks who the lead detective is');
ok(INDEX.indexOf('id="newCaseLeadAgency"') !== -1, 'and which agency/unit');
ok(/caseRole: caseRole,/.test(INDEX), 'the new case record carries caseRole');
ok(/case_role: caseRole/.test(INDEX), 'and the audit trail records it');
// form.reset() restores the radio but not the panel it controls.
ok(/closeCreateCaseModal[\s\S]{0,400}ncSyncCaseRole\(\)/.test(INDEX),
   'closing the Create Case modal re-syncs the role panel');

// ═════════════════════════════════════════════════════════════════════════
//  3. CASE OVERVIEW  (source-level invariants in case-detail)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. Case Overview role editing');

ok(DETAIL.indexOf('id="editCaseLeadDetective"') !== -1, 'the Overview edit form can set the lead detective');
ok(DETAIL.indexOf('id="editCaseAssistFields"') !== -1, 'and has a panel that shows/hides with the role');
ok(/name="editCaseRole"/.test(DETAIL), 'the Overview edit form has the role radios');
ok(/currentCase\.caseRole = newCaseRole;/.test(DETAIL), 'saveOverviewEdit persists the role');
ok(/const roleChanged = \(currentCase\.caseRole === 'assist'\) !== \(newCaseRole === 'assist'\);/.test(DETAIL),
   'the role change is detected BEFORE the record is overwritten');
ok(/audit\('case_role_changed'/.test(DETAIL), 'a role change is audited');
// A missing control must mean "leave it alone", never "reset to primary" —
// saveOverviewEdit runs from other code paths too.
ok(/roleSel\s*\?[\s\S]{0,200}currentCase\.caseRole === 'assist' \? 'assist' : 'primary'/.test(DETAIL),
   'with no radio on the page the existing role is preserved, not reset');
ok(/id="caseAssistBadge"/.test(DETAIL), 'the case header has an assist badge');
ok(/asBadge\.classList\.remove\('hidden'\)/.test(DETAIL), 'and renderCaseHeader shows it');

// ═════════════════════════════════════════════════════════════════════════
//  4. THE HAND-OFF  (save-da-export, lifted out of electron-main.js)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n4. Assist Package export (lifted from electron-main.js)');

const START = "ipcMain.handle('save-da-export'";
const s0 = MAIN.indexOf(START);
ok(s0 !== -1, 'the save-da-export handler is still in electron-main.js');
const s1 = MAIN.indexOf('\n});', s0);
const BLOCK = MAIN.slice(s0, s1 + 4);

ok(BLOCK.indexOf('File names have been left exactly as they were created') !== -1,
   'the package tells the recipient that file names were not touched');
ok(BLOCK.indexOf('MANIFEST.csv') !== -1, 'a CSV manifest is written');
ok(/HASH_MAX_BYTES = 256 \* 1024 \* 1024/.test(BLOCK),
   'hashing is capped so a multi-GB evidence file cannot stall the export');
ok(BLOCK.indexOf('not hashed (over 256 MB)') !== -1,
   'and an unhashed file says so rather than showing a blank');

// Drive the real handler against a real temp case folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-assist-'));
const CASE = '26-003';
const CANVAS_MEDIA_DIR = 'Canvas Media';
const FIELD_WORK_MEDIA_DIR = 'Field Work Media';
const mk = (rel, body) => {
    const full = path.join(TMP, CASE, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(body));
};
mk(path.join('Evidence', 'Canvass Main St', 'door.jpg'), 'PHOTO-BYTES');
mk(path.join('Evidence', 'TLO Report', 'tlo.pdf'), 'TLO-BYTES');
mk(path.join('Warrants', 'sw-001.pdf'), 'WARRANT-BYTES');
mk(path.join('Notes', 'note-1.png'), 'NOTE-BYTES');
mk(path.join(CANVAS_MEDIA_DIR, 'canvass-01.jpg'), 'CANVASS-BYTES');
mk(path.join(FIELD_WORK_MEDIA_DIR, 'Field Work 2026-10-05 3200-Las-Vegas-Trl photo 1.jpg'), 'FIELDWORK-BYTES');
mk(path.join(FIELD_WORK_MEDIA_DIR, 'Field Work 2026-10-06 Interview signed-statement.pdf'), 'FW-HELD-BYTES');

const HDR = Buffer.from('VIPENC');
const securityStub = {
    unlocked: true,
    isEnabled() { return true; },
    isUnlocked() { return this.unlocked; },
    decryptBuffer(b) { return b.slice(6); }
};
// One encrypted file, so the manifest's "decrypted on export" note is exercised.
mk(path.join('Evidence', 'Canvass Main St', 'sealed.bin'), Buffer.concat([HDR, Buffer.from('SEALED-PLAINTEXT')]));

// A fake archiver that records what would have gone into the ZIP.
let ENTRIES = [];
function fakeArchiver() {
    const handlers = {};
    return {
        on: (ev, fn) => { handlers[ev] = fn; },
        pipe: () => {},
        append: (data, opts) => {
            ENTRIES.push({
                name: opts.name,
                body: Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
                streamed: false
            });
        },
        file: (full, opts) => {
            ENTRIES.push({ name: opts.name, body: fs.readFileSync(full), streamed: true });
        },
        pointer: () => 1234,
        finalize: () => { setImmediate(() => handlers.__close && handlers.__close()); return Promise.resolve(); },
        __handlers: handlers
    };
}

let HANDLERS = {};
let SAVE_PATH = path.join(TMP, 'out.zip');
const fsStub = Object.assign({}, fs, {
    createWriteStream: () => {
        const cbs = {};
        // The handler resolves on the output stream's 'close'. Fire it as soon
        // as finalize() has run so the promise settles.
        setTimeout(() => { if (cbs.close) cbs.close(); }, 30);
        return { on: (ev, fn) => { cbs[ev] = fn; }, destroy: () => {} };
    }
});

const env = {
    ipcMain: { handle: (name, fn) => { HANDLERS[name] = fn; } },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: SAVE_PATH }) },
    mainWindow: {},
    restoreFocus: () => {},
    require: (m) => (m === 'archiver' ? fakeArchiver : require(m)),
    path, fs: fsStub, console,
    casesDir: TMP,
    CANVAS_MEDIA_DIR,
    FIELD_WORK_MEDIA_DIR,
    security: securityStub,
    app: { getVersion: () => '9.9.9' },
    Buffer, String, Array, Object, Error, Promise, Set, Map, JSON, Date, Number, Math,
    setTimeout, setImmediate
};
env.globalThis = env;
vm.createContext(env);
vm.runInContext(BLOCK, env);
const exportZip = HANDLERS['save-da-export'];
ok(typeof exportZip === 'function', 'the lifted handler registered');

const PDF = Array.from(Buffer.from('%PDF-FAKE'));
const ASSIST = {
    officerName: 'J. Kowalski', officerRank: 'Detective', officerBadge: '#4417',
    agencyName: 'Springfield PD — Internet Crimes',
    who: 'Detective J. Kowalski #4417',
    leadDetective: 'Det. A. Ramirez #2210',
    leadAgency: 'Springfield PD — Crimes Against Persons',
    folderName: 'Assist Package - 26-003 - Detective J. Kowalski #4417 - 2026-09-30',
    dateStr: '2026-09-30'
};

(async () => {
    // ── A NORMAL DA EXPORT. Nothing about its shape may change. ──
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'x.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: []
    });
    const daNames = ENTRIES.map(e => e.name);
    ok(daNames.indexOf(CASE + '_DA_Report.pdf') !== -1, 'the DA export still puts the PDF at the root');
    ok(daNames.indexOf('EXPORT_MANIFEST.json') !== -1, 'the DA manifest is still at the root');
    ok(daNames.indexOf('MANIFEST.csv') === -1, 'a DA export gets no assist CSV');
    ok(daNames.indexOf('READ ME FIRST.txt') === -1, 'and no assist readme');
    ok(daNames.every(n => n.indexOf('Assist Package') === -1), 'and nothing is nested under an assist folder');
    ok(daNames.indexOf('Evidence/Canvass Main St/door.jpg') !== -1, 'evidence is at the top level as before');
    ok(daNames.indexOf('Warrants/sw-001.pdf') !== -1, 'warrants too');

    // ── THE ASSIST PACKAGE ──
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'y.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [],
        nonDiscoverableTags: ['TLO Report'],
        nonDiscoverableCanvasFiles: [],
        nonDiscoverableFieldWorkFiles: ['Field Work 2026-10-06 Interview signed-statement.pdf'],
        assist: ASSIST
    });
    const names = ENTRIES.map(e => e.name);
    const ROOT = ASSIST.folderName;

    // Every single entry is inside ONE folder. This is what stops the package
    // scattering over the lead detective's own Evidence/Warrants folders.
    ok(names.length > 0, 'the assist package has contents');
    ok(names.every(n => n.indexOf(ROOT + '/') === 0),
       'EVERY entry sits inside the one named root folder');
    ok(names.indexOf(ROOT + '/' + CASE + '_Assist_Package.pdf') !== -1,
       'the PDF is named an Assist Package, not a DA Report');
    ok(names.indexOf(ROOT + '/MANIFEST.csv') !== -1, 'MANIFEST.csv is at the package root');
    ok(names.indexOf(ROOT + '/READ ME FIRST.txt') !== -1, 'so is the plain-text note');
    ok(names.indexOf(ROOT + '/EXPORT_MANIFEST.json') !== -1, 'and the machine-readable record');

    // FILE NAMES ARE UNTOUCHED. This is the decision the user made
    // explicitly: tag via folder name, manifest and PDF stamp only.
    ok(names.indexOf(ROOT + '/Evidence/Canvass Main St/door.jpg') !== -1,
       'the evidence file keeps its original name and its original folder');
    ok(names.indexOf(ROOT + '/Warrants/sw-001.pdf') !== -1, 'the warrant keeps its name');
    ok(names.indexOf(ROOT + '/Notes/note-1.png') !== -1, 'the note attachment keeps its name');
    ok(names.indexOf(ROOT + '/' + CANVAS_MEDIA_DIR + '/canvass-01.jpg') !== -1,
       'canvass media keeps its name');

    // Field work is the assisting detective's own work product — the whole
    // reason the package exists — so it ships, and it keeps its name too.
    ok(names.indexOf(ROOT + '/' + FIELD_WORK_MEDIA_DIR + '/Field Work 2026-10-05 3200-Las-Vegas-Trl photo 1.jpg') !== -1,
       'field work media is in the package and keeps its name');
    // Not-Discoverable is withheld from a Field Work file by NAME, the same
    // way canvass media is — these folders are flat, not tag folders.
    ok(names.indexOf(ROOT + '/' + FIELD_WORK_MEDIA_DIR + '/Field Work 2026-10-06 Interview signed-statement.pdf') === -1,
       'a field work file marked Not Discoverable is withheld');
    ok(names.every(n => n.indexOf('Kowalski') === -1 || n === ROOT + '/MANIFEST.csv' || n.indexOf(ROOT) === 0),
       'the officer\'s name is never spliced into a file name');

    // Not-Discoverable still means withheld. An assist hand-off is not a
    // loophole around the exporting officer's discovery decision.
    ok(names.every(n => n.indexOf('TLO Report') === -1),
       'a Not-Discoverable evidence folder is withheld from the assist package too');

    // ── MANIFEST.csv ──
    const csv = ENTRIES.find(e => e.name === ROOT + '/MANIFEST.csv').body.toString('utf8');
    const rows = csv.trim().split('\r\n');
    ok(rows[0].indexOf('"SHA-256"') !== -1, 'the CSV has a SHA-256 column');
    ok(rows[0].indexOf('"Contributed By"') !== -1, 'and a Contributed By column');
    ok(rows[0].indexOf('"Parent Case Number"') !== -1, 'and the parent case number');
    ok(rows.length >= 6, 'every file got a row — got ' + (rows.length - 1) + ' data rows');
    ok(rows.every(r => r.indexOf('"') === 0), 'every field is quoted, so a comma in a file name cannot shift columns');
    ok(csv.indexOf('J. Kowalski') !== -1, 'the CSV names the contributing officer');
    ok(csv.indexOf('#4417') !== -1, 'and their badge');
    ok(csv.indexOf(CASE) !== -1, 'and the parent case number');

    // The hash must be the hash of what actually landed in the ZIP.
    const crypto = require('crypto');
    const doorRow = rows.find(r => r.indexOf('door.jpg') !== -1);
    ok(!!doorRow, 'the photo has a manifest row');
    eq((doorRow.match(/"([0-9a-f]{64})"/) || [])[1],
       crypto.createHash('sha256').update(Buffer.from('PHOTO-BYTES')).digest('hex'),
       'the manifest hash matches the bytes in the package');

    // An encrypted file is hashed AFTER decryption — that is what the
    // recipient receives, so hashing the ciphertext would be a lie.
    const sealedRow = rows.find(r => r.indexOf('sealed.bin') !== -1);
    ok(!!sealedRow, 'the encrypted file has a manifest row');
    eq((sealedRow.match(/"([0-9a-f]{64})"/) || [])[1],
       crypto.createHash('sha256').update(Buffer.from('SEALED-PLAINTEXT')).digest('hex'),
       'an encrypted file is hashed as the plaintext that ships, not as ciphertext');
    ok(sealedRow.indexOf('decrypted from VIPER Field Security') !== -1,
       'and the row says it was decrypted on export');

    // ── EXPORT_MANIFEST.json ──
    const jm = JSON.parse(ENTRIES.find(e => e.name === ROOT + '/EXPORT_MANIFEST.json').body.toString('utf8'));
    eq(jm.assist.role, 'assist', 'the JSON manifest declares the role');
    eq(jm.assist.parentCaseNumber, CASE, 'and the parent case number');
    eq(jm.assist.leadDetective, ASSIST.leadDetective, 'and who the lead detective is');
    eq(jm.assist.contributedBy, 'J. Kowalski', 'and who contributed');
    ok(jm.assist.note.indexOf('not a second case file') === -1
       || typeof jm.assist.note === 'string', 'the note is a string');
    ok(/preserved unchanged/.test(jm.assist.note), 'the note states that file names are preserved');
    // The DA export's own manifest must not grow an assist block.
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'z.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: []
    });
    const daJm = JSON.parse(ENTRIES.find(e => e.name === 'EXPORT_MANIFEST.json').body.toString('utf8'));
    eq(daJm.assist, undefined, 'a DA export manifest carries no assist block');

    // ── READ ME FIRST.txt ──
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'y.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [],
        assist: ASSIST
    });
    const readme = ENTRIES.find(e => e.name === ROOT + '/READ ME FIRST.txt').body.toString('utf8');
    ok(readme.indexOf('ASSIST PACKAGE') === 0, 'the readme leads with what it is');
    ok(readme.indexOf('Detective J. Kowalski') !== -1, 'names the contributor');
    ok(readme.indexOf(ASSIST.leadDetective) !== -1, 'names the lead detective');
    ok(/not a discovery package/.test(readme),
       'says plainly that this is not a discovery package');
    ok(/left exactly as they were created/.test(readme), 'explains why names were not changed');
    ok(readme.indexOf('MANIFEST.csv') !== -1, 'points at the manifest');

    // ── A FILES-ONLY assist export sends no PDF. It must not leave a 0-byte
    //    "report" in the package for the lead detective to fail to open.
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'f.zip', pdfBytes: [], caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [],
        assist: ASSIST
    });
    const fnames = ENTRIES.map(e => e.name);
    // Only the report PDF sits at the package root. Evidence and warrant
    // PDFs live under their module folders and are none of this check's
    // business — assert on the root, not on the extension.
    ok(fnames.filter(n => n.indexOf('/') === n.lastIndexOf('/') && /\.pdf$/i.test(n)).length === 0,
       'no report PDF is written when no PDF bytes were sent');
    ok(fnames.indexOf(ROOT + '/' + CASE + '_Assist_Package.pdf') === -1,
       'specifically: no empty Assist Package PDF');
    ok(fnames.indexOf(ROOT + '/MANIFEST.csv') !== -1, 'the manifest still ships');
    ok(/files only/.test(ENTRIES.find(e => e.name === ROOT + '/READ ME FIRST.txt').body.toString('utf8')),
       'and the readme says there is no written report');

    // ── A LOCKED VAULT skips encrypted files. They must not appear in the
    //    manifest either — a manifest row for a file that is not in the ZIP
    //    is worse than no row.
    securityStub.unlocked = false;
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'l.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [],
        assist: ASSIST
    });
    const lnames = ENTRIES.map(e => e.name);
    ok(lnames.every(n => n.indexOf('sealed.bin') === -1), 'a locked vault withholds the encrypted file');
    const lcsv = ENTRIES.find(e => e.name === ROOT + '/MANIFEST.csv').body.toString('utf8');
    ok(lcsv.indexOf('sealed.bin') === -1, 'and the manifest does not list a file that is not in the package');
    securityStub.unlocked = true;

    // ── A hostile folder name cannot escape the archive or break Windows.
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'h.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [],
        assist: Object.assign({}, ASSIST, { folderName: '../../etc: bad*name?\\here.' })
    });
    const hroot = ENTRIES[0].name.split('/')[0];
    ok(hroot.indexOf('..') === -1 || hroot.indexOf('/') === -1, 'no path separators survive in the root name');
    ok(!/[\\/:*?"<>|]/.test(hroot), 'no Windows-illegal characters survive');
    ok(!/[. ]$/.test(hroot), 'no trailing dot or space — Windows cannot create that directory');
    ok(ENTRIES.every(e => e.name.indexOf(hroot + '/') === 0), 'everything still sits under that one root');

    // ── An empty folder name still produces a usable root rather than a
    //    leading slash.
    ENTRIES = [];
    await exportZip(null, {
        fileName: 'e.zip', pdfBytes: PDF, caseNumber: CASE,
        excludeCsam: false, csamTags: [], nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [],
        assist: Object.assign({}, ASSIST, { folderName: '' })
    });
    ok(ENTRIES[0].name.indexOf('/') !== 0, 'no entry starts with a slash');
    ok(ENTRIES[0].name.indexOf('Assist Package - ' + CASE) === 0,
       'a blank folder name falls back to a named default');

    // ═════════════════════════════════════════════════════════════════════
    //  5. THE RENDERER SIDE OF THE EXPORT  (case-detail source invariants)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n5. Export UI and PDF stamp');

    ok(/function _assistPackageInfo\(\)/.test(DETAIL), '_assistPackageInfo exists');
    ok(/currentCase\.caseRole !== 'assist'\) return null;/.test(DETAIL),
       'it returns null on a normal case — which is what leaves the DA export untouched');
    ok(/viperAgencyProfile/.test(DETAIL),
       'the officer identity comes from the agency profile they already filled in');
    ok(/assist: _assist,/.test(DETAIL), 'the IPC payload carries it');
    ok(/Work product of/.test(DETAIL), 'every PDF page carries a work-product stamp');
    ok(/'ASSIST PACKAGE' : 'CASE REPORT'/.test(DETAIL), 'the cover page is retitled');
    ok(/Supplemental work provided to the lead detective/.test(DETAIL), 'with an honest subtitle');
    ok(/Assist Package saved to/.test(DETAIL), 'and the success toast says what was saved');
    ok(/_Assist_Package_/.test(DETAIL), 'the suggested file name says Assist Package');
    // The stamp must be inside addHeader, which runs on EVERY page — a stamp
    // only on page 1 is useless once a page is photocopied out.
    const hdr = slice(DETAIL, 'function addHeader() {', '\n            }', 'addHeader');
    ok(hdr.indexOf('Work product of') !== -1, 'the stamp lives in addHeader, so it lands on every page');
    ok(hdr.indexOf('Assist Package') !== -1, 'and the running header says Assist Package');

    // ── done ──
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') +
                ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('UNCAUGHT', e);
    process.exit(1);
});
