/*
 * case-stores.js — the authoritative store registry.
 *
 * Run: node modules\_shared\__tests__\case-stores.test.js
 * (pure module, no native deps)
 *
 * WHY THIS EXISTS
 *
 * This table replaced SEVEN hand-written copies of the same list of
 * localStorage keys: the .vcase exporter, the .vcase importer, the backup
 * collector in settings.html, the delete-case cleanup, the case-number
 * rename, and case-snapshot.js's two lists. Every one of them had drifted,
 * and each kind of drift loses data in a different, silent way:
 *
 *   - missing from the EXPORT  -> the data does not reach the other officer
 *   - missing from the SNAPSHOT -> a localStorage wipe loses it forever
 *   - missing from the BACKUP  -> the .vbak restores an incomplete case
 *   - missing from the DELETE  -> orphaned keys accumulate under a dead id
 *   - missing from the RENAME  -> the case forks into a duplicate on reload
 *
 * None of those announce themselves. The officer finds out months later.
 *
 * So this file does two jobs. It pins the registry's own behaviour, and it
 * PINS THE HISTORICAL LISTS LITERALLY: every key that any of the seven
 * copies used to carry is written out below, and the registry must still
 * contain it. That is what stops a future tidy-up from quietly dropping a
 * store that used to be protected.
 */
const fs = require('fs');
const path = require('path');
const CS = require(path.join(__dirname, '..', 'case-stores.js'));

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

/* ====================================================================== *
 * the module loads the way the renderer needs it to
 * ====================================================================== */
console.log('\n[the module loads]');

ok('module.exports carries the API', typeof CS.keys2 === 'function');
ok('the global is assigned too, not just module.exports',
    globalThis.CaseStores === CS);
ok('  — which is the UMD trap: `module` is defined in the renderer, so a '
    + 'wrapper that picks ONE branch leaves window.CaseStores undefined',
    typeof module === 'object' && !!module.exports);

/* ====================================================================== *
 * the table is well formed
 * ====================================================================== */
console.log('\n[the table is well formed]');

const keys = CS.STORES.map(s => s.key);
ok('no duplicate keys', keys.length === new Set(keys).size,
    keys.filter((k, i) => keys.indexOf(k) !== i));

const PATTERNS = [1, 2];
const SHAPES = ['array', 'wrapped', 'object', 'map'];
const MERGES = ['list', 'replace', 'skip', 'mirror', 'map'];

let badPattern = [], badShape = [], badMerge = [], noLabel = [];
CS.STORES.forEach(s => {
    if (PATTERNS.indexOf(s.pattern) < 0) badPattern.push(s.key);
    if (SHAPES.indexOf(s.shape) < 0) badShape.push(s.key);
    if (MERGES.indexOf(s.merge) < 0) badMerge.push(s.key);
    if (!s.label || !String(s.label).trim()) noLabel.push(s.key);
});
ok('every store declares a known pattern', badPattern.length === 0, badPattern);
ok('every store declares a known shape', badShape.length === 0, badShape);
ok('every store declares a known merge mode', badMerge.length === 0, badMerge);
ok('every store has a human label for the merge summary',
    noLabel.length === 0, noLabel);

const wrappedNoList = CS.STORES.filter(s => s.shape === 'wrapped' && !s.list).map(s => s.key);
ok('every wrapped store names the property holding its array',
    wrappedNoList.length === 0, wrappedNoList);

const listNoIdentity = CS.STORES.filter(s => s.merge === 'list' && typeof s.identity !== 'function').map(s => s.key);
ok('every list-merged store has an identity function — without one the '
    + '"only add what is new" mode cannot tell new from duplicate',
    listNoIdentity.length === 0, listNoIdentity);

const badMirror = CS.STORES.filter(s => s.merge === 'mirror' && !CS.byKey(s.mirrorOf)).map(s => s.key);
ok('every mirror points at a store that exists', badMirror.length === 0, badMirror);

const badRemap = CS.STORES.filter(s => s.remapWith && !CS.byKey(s.remapWith)).map(s => s.key);
ok('every remapWith points at a store that exists', badRemap.length === 0, badRemap);

const remapTargetsNotReid = CS.STORES
    .filter(s => s.remapWith && !(CS.byKey(s.remapWith) || {}).reid).map(s => s.key);
ok('a store that follows another store\'s id remap follows one that is '
    + 'actually re-ided — otherwise the remap is a no-op and the link breaks',
    remapTargetsNotReid.length === 0, remapTargetsNotReid);

/* ====================================================================== *
 * THE HISTORICAL LISTS — nothing that was protected may be dropped
 * ====================================================================== */
console.log('\n[nothing that was previously protected has been dropped]');

// Copied verbatim out of git history. Do not "tidy" these.
const WAS_EXPORTED_P2 = [
    'suspects', 'victims', 'victimBusinesses', 'cargo',
    'witnesses', 'involvedPersons', 'recoveredVehicles', 'missingpersons',
    'areacanvas', 'fieldwork', 'fieldworkForms', 'prosecution', 'narcotics', 'firearms',
    'money', 'opsplan', 'rmsImports', 'oversightImport',
    'canvasForms', 'cyberTips', 'timelineEvents', 'consentSearches',
    'googleWarrant', 'metaWarrant', 'kikWarrant', 'snapchatWarrant', 'xWarrant',
    'discordWarrant', 'datapilot', 'caseMetrics', 'cellebriteImport', 'connectionBoard'
];
const WAS_EXPORTED_P1 = [
    'viperCaseNotes', 'viperCaseReports', 'viperCaseEvidence',
    'viperCaseWarrants', 'viperCaseSuspects', 'viperCaseVictims',
    'viperCaseWitnesses', 'viperCaseVehicles', 'viperCaseFirearms',
    'viperCaseNarcotics', 'viperCaseMoney', 'viperCaseMissingPersons',
    'viperCaseCanvas', 'viperCaseProsecution', 'viperTraceImports',
    'viperCaseForensicDevices'
];
const WAS_SNAPSHOTTED_P2 = [
    'suspects', 'victims', 'victimBusinesses', 'cargo',
    'witnesses', 'involvedPersons', 'recoveredVehicles', 'missingpersons',
    'areacanvas', 'fieldwork', 'fieldworkForms', 'prosecution', 'narcotics', 'firearms',
    'money', 'opsplan', 'rmsImports', 'oversightImport',
    'canvasForms', 'cyberTips', 'timelineEvents', 'consentSearches',
    'googleWarrant', 'metaWarrant', 'kikWarrant', 'caseMetrics',
    'connectionBoard', 'flock'
];
const WAS_RENAMED = [
    'viperCaseNotes', 'viperCaseReports', 'viperCaseEvidence',
    'viperCaseWarrants', 'viperCaseSuspects', 'viperCaseVictims',
    'viperCaseWitnesses', 'viperCaseVehicles', 'viperCaseFirearms',
    'viperCaseNarcotics', 'viperCaseMoney', 'viperCaseMissingPersons',
    'viperCaseCanvas', 'viperCaseProsecution', 'viperTraceImports',
    'viperCaseForensicDevices', 'viperCaseOPSPlans',
    'viperCaseActivityTimers', 'viperTranscripts', 'viperOpenEvidence'
];

const k2 = CS.keys2(), k1 = CS.keys1(), cnk = CS.caseNumberKeyed();
const missing = (want, have) => want.filter(k => have.indexOf(k) < 0);

ok('every key the exporter carried is still exported',
    missing(WAS_EXPORTED_P2, k2).length === 0, missing(WAS_EXPORTED_P2, k2));
ok('every shared key the exporter carried is still exported',
    missing(WAS_EXPORTED_P1, k1).length === 0, missing(WAS_EXPORTED_P1, k1));
ok('every key the snapshot tracked is still snapshotted',
    missing(WAS_SNAPSHOTTED_P2, k2).length === 0, missing(WAS_SNAPSHOTTED_P2, k2));
ok('every key a rename moved is still moved',
    missing(WAS_RENAMED, cnk).length === 0, missing(WAS_RENAMED, cnk));

/* ====================================================================== *
 * THE DRIFT THE REGISTRY WAS BUILT TO FIX
 * ====================================================================== */
console.log('\n[the measured drift is closed]');

// Each of these was missing from at least one list and is the reason the
// registry exists. They are asserted by name so the fix cannot regress.
ok('warrant drafts travel in an export — they were in NO list at all, and '
    + 'warrants are the user\'s own first example of a supplemental '
    + 'detective\'s contribution',
    k2.indexOf('warrantAuthor') >= 0);
ok('warrant drafts are snapshotted', CS.prefixes2().indexOf('warrantAuthor_') >= 0);
ok('case probable cause travels', k2.indexOf('casePcNarrative') >= 0);
ok('Flock ALPR travels — it was snapshotted but never exported',
    k2.indexOf('flock') >= 0);
ok('Cellebrite is snapshotted — it was exported but never snapshotted',
    k2.indexOf('cellebriteImport') >= 0);
ok('DataPilot is snapshotted', k2.indexOf('datapilot') >= 0);
ok('Discord returns are snapshotted', k2.indexOf('discordWarrant') >= 0);
ok('Snapchat returns are snapshotted', k2.indexOf('snapchatWarrant') >= 0);
ok('X returns are snapshotted', k2.indexOf('xWarrant') >= 0);
ok('forensic devices are snapshotted', k1.indexOf('viperCaseForensicDevices') >= 0);
ok('interview transcripts travel — measured live, and in no list',
    k1.indexOf('viperTranscripts') >= 0);

/* ====================================================================== *
 * transient stores
 * ====================================================================== */
console.log('\n[host-local state never leaves this machine]');

ok('which evidence pane was open is NOT exported',
    k1.indexOf('viperOpenEvidence') < 0);
ok('the nag-timer setting is NOT exported',
    k1.indexOf('viperCaseActivityTimers') < 0);
ok('but a rename still moves the open-evidence pointer — a rename moves '
    + 'everything under the old number or the leftovers resurrect as a '
    + 'duplicate case',
    cnk.indexOf('viperOpenEvidence') >= 0);
ok('and a rename moves the nag timer',
    cnk.indexOf('viperCaseActivityTimers') >= 0);
ok('no transient store is mergeable',
    CS.mergeable().every(s => !s.transient));
ok('caseNumberKeyed is a superset of keys1',
    k1.every(k => cnk.indexOf(k) >= 0));

/* ====================================================================== *
 * key shapes
 * ====================================================================== */
console.log('\n[key shapes]');

ok('every pattern-2 prefix is its key plus one underscore',
    CS.prefixes2().join(',') === k2.map(k => k + '_').join(','));
ok('no pattern-2 key already ends in an underscore',
    k2.every(k => !/_$/.test(k)));
ok('pattern-1 and pattern-2 names never collide',
    k1.every(k => k2.indexOf(k) < 0));
ok('legacy mirrors are all pattern 1 — pattern 2 is the modern layout and '
    + 'has no dead stores in it',
    CS.STORES.filter(s => s.legacy).every(s => s.pattern === 1));
ok('no legacy mirror is a merge target — merging into a store nothing '
    + 'writes would be invisible to the officer',
    CS.STORES.filter(s => s.legacy).every(s => s.merge === 'skip'));

/* ====================================================================== *
 * IDENTITY — the load-bearing behaviour
 * ====================================================================== */
console.log('\n[identity sees through how two officers type]');

const idOf = (k, r) => CS.identityFor(k, r);

ok('the same person typed two ways is one person',
    idOf('suspects', { name: '  SMITH,  John ', dob: '1990-02-03' })
    === idOf('suspects', { name: 'smith, john', dob: '02/03/1990' }));
ok('  — and that identity is not empty',
    idOf('suspects', { name: 'Smith, John', dob: '1990-02-03' }) !== '');
ok('a different DOB is a different person',
    idOf('suspects', { name: 'Smith, John', dob: '1990-02-03' })
    !== idOf('suspects', { name: 'Smith, John', dob: '1991-02-03' }));
ok('a person with no name and no DOB has NO identity, so the merge falls '
    + 'back to content hashing rather than collapsing them together',
    idOf('suspects', { notes: 'x' }) === '');
ok('a name with no DOB still has an identity',
    idOf('suspects', { name: 'Smith, John' }) !== '');
ok('identityFor on an unknown key returns empty, never throws',
    idOf('nope', { name: 'x' }) === '');
ok('identityFor on null returns empty', idOf('suspects', null) === '');

ok('a VIN alone identifies a vehicle',
    idOf('recoveredVehicles', { vin: '1HGBH41JXMN109186' }) !== '');
ok('the same plate in two states is two vehicles — plates repeat across '
    + 'state lines',
    idOf('recoveredVehicles', { plate: 'ABC123', plateState: 'TX' })
    !== idOf('recoveredVehicles', { plate: 'ABC123', plateState: 'OK' }));
ok('plate casing does not matter',
    idOf('recoveredVehicles', { plate: 'abc123', plateState: 'tx' })
    === idOf('recoveredVehicles', { plate: 'ABC123', plateState: 'TX' }));
ok('  — and that identity is not empty, which would make the comparison '
    + 'above pass for the wrong reason',
    idOf('recoveredVehicles', { plate: 'abc123', plateState: 'tx' }) !== '');

ok('evidence is identified by its tag, which IS the on-disk folder name',
    idOf('viperCaseEvidence', { tag: 'E-001', description: 'phone' })
    === idOf('viperCaseEvidence', { tag: ' e-001 ', description: 'Phone' }));
ok('two different evidence tags are two items',
    idOf('viperCaseEvidence', { tag: 'E-001' })
    !== idOf('viperCaseEvidence', { tag: 'E-002' }));

ok('firearms are identified by serial',
    idOf('firearms', { serialNumber: 'X1', make: 'Glock', model: '19' }) !== '');
ok('the warrant-return family shares one identity builder',
    idOf('googleWarrant', { fileName: 'a.zip', importedAt: '2026-01-01' })
    === idOf('metaWarrant', { fileName: 'a.zip', importedAt: '2026-01-01' }));

/* date normalisation, used by every person identity */
ok('an ISO date normalises to YYYYMMDD', CS._date('1990-02-03') === '19900203');
ok('a US date normalises the same way', CS._date('2/3/1990') === '19900203');
ok('a zero-padded US date normalises the same way', CS._date('02/03/1990') === '19900203');
ok('an empty date is empty, not a bogus identity', CS._date('') === '');
ok('a null date is empty', CS._date(null) === '');
ok('an ISO datetime keeps only the date part', CS._date('1990-02-03T11:22:33Z') === '19900203');

ok('whitespace collapses', CS._norm('  A   B  ') === 'a b');
ok('norm is case-insensitive', CS._norm('ABC') === CS._norm('abc'));
ok('norm tolerates null', CS._norm(null) === '');
ok('digits strips punctuation', CS._digits('(817) 555-0133') === '8175550133');

/* ====================================================================== *
 * envelopes
 * ====================================================================== */
console.log('\n[store envelopes]');

const arrStore = CS.byKey('suspects');
const wrapStore = CS.byKey('googleWarrant');

ok('listOf reads a plain array', JSON.stringify(CS.listOf(arrStore, [1, 2])) === '[1,2]');
ok('listOf on a non-array returns empty rather than throwing',
    JSON.stringify(CS.listOf(arrStore, { a: 1 })) === '[]');
ok('listOf reads inside a wrapped envelope',
    JSON.stringify(CS.listOf(wrapStore, { imports: [1, 2] })) === '[1,2]');
ok('listOf on a wrapped store with no list yet returns empty',
    JSON.stringify(CS.listOf(wrapStore, {})) === '[]');
ok('listOf tolerates null', JSON.stringify(CS.listOf(wrapStore, null)) === '[]');

ok('withList round trips a plain array',
    JSON.stringify(CS.withList(arrStore, [1], [1, 2])) === '[1,2]');
ok('withList preserves the sibling fields of a wrapped envelope — those '
    + 'hold the import metadata the tab renders',
    JSON.stringify(CS.withList(wrapStore, { imports: [1], other: 9 }, [1, 2]))
    === '{"imports":[1,2],"other":9}');
ok('withList does not mutate the original envelope', (() => {
    const orig = { imports: [1], other: 9 };
    CS.withList(wrapStore, orig, [7]);
    return orig.imports.length === 1;
})());

/* ====================================================================== *
 * file-carrying stores
 * ====================================================================== */
console.log('\n[stores that reference files on disk]');

const dirs = CS.fileDirs();
['Evidence', 'Warrants', 'Canvas Media', 'Field Work Media', 'Consent Forms']
    .forEach(d => ok('the export knows about cases/<n>/' + d, dirs.indexOf(d) >= 0));
ok('fileDirs has no duplicates', dirs.length === new Set(dirs).size);

/* ====================================================================== *
 * NO CALLER KEEPS ITS OWN COPY
 * ====================================================================== *
 * The whole point. If one of these files starts carrying a literal list
 * again, the drift starts again — so the test reads the real files.
 */
console.log('\n[no caller keeps its own copy of the list]');

const CONSUMERS = [
    'case-detail-with-analytics.html',
    'index.html',
    'settings.html',
    'case-snapshot.js'
];

// A literal array of store keys is recognisable by two of these quoted
// names sitting adjacent. The tells are chosen to be specific to the
// STORE lists: `'suspects', 'victims'` alone is not one, because the four
// person-ROLE tabs are a legitimate domain list that happens to start the
// same way.
const TELLS = [
    /'viperCaseNotes'\s*,\s*'viperCaseReports'/,
    /'viperCaseWitnesses'\s*,\s*'viperCaseVehicles'/,
    /'victims'\s*,\s*'victimBusinesses'/,
    /'victims_'\s*,\s*'victimBusinesses_'/,
    /'googleWarrant'\s*,\s*'metaWarrant'/,
    /'googleWarrant_'\s*,\s*'metaWarrant_'/
];

CONSUMERS.forEach(f => {
    let src;
    try { src = read(f); }
    catch (e) { ok(f + ' is readable', false, String(e.message)); return; }
    const hit = TELLS.filter(re => re.test(src));
    ok(f + ' holds no hand-written store list', hit.length === 0,
        hit.map(String));
});

CONSUMERS.forEach(f => {
    let src;
    try { src = read(f); } catch (e) { return; }
    ok(f + ' reads the registry instead', /CaseStores\s*\./.test(src));
});

// Load order: case-stores.js must come before case-snapshot.js, or the
// snapshot disables itself. Matched on the real <script> tags — the
// prose "BEFORE case-snapshot.js" in a nearby comment is not a load.
['case-detail-with-analytics.html', 'index.html', 'settings.html'].forEach(f => {
    const src = read(f);
    const a = src.indexOf('<script src="modules/_shared/case-stores.js">');
    const b = src.indexOf('<script src="case-snapshot.js">');
    ok(f + ' loads case-stores.js', a >= 0);
    ok(f + ' loads case-snapshot.js', b >= 0);
    ok(f + ' loads the registry BEFORE the snapshot', a >= 0 && b >= 0 && a < b,
        { caseStores: a, snapshot: b });
});

// And the snapshot must refuse to run rather than silently track nothing.
const snapSrc = read('case-snapshot.js');
ok('case-snapshot.js fails loudly when the registry is absent, rather than '
    + 'quietly snapshotting an empty key list',
    /if\s*\(\s*!window\.CaseStores\s*\)/.test(snapSrc)
    && /console\.error/.test(snapSrc));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
