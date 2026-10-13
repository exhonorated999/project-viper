/**
 * Cellebrite — Source Validation.
 *
 * Pins the contract between the import (cellebrite-main.js), the module's
 * citations (cellebrite-module.js) and the shared locator:
 *   - the fingerprint covers exactly the extracted files VIPER reads (never
 *     SQLite's -shm scratch file), plus a separate SHA-256 of the .ufdx/.ufd;
 *   - an edited database no longer matches it;
 *   - a flagged SMS / call / contact / account is found at its exact row
 *     (mmssms.db › sms › row N), both from the raw table rows and from the
 *     trimmed rows an evidence push uses;
 *   - MMS and Google Messages text (stored one part per row) is found by value;
 *   - media is not applicable (it is never extracted).
 *
 * The fingerprint function is LIFTED from electron-main.js, not copied.
 * Synthetic databases only — no real phone data.
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   node_modules\.bin\electron.cmd modules\cellebrite\__tests__\cellebrite-source.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const Sqlite = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const L = require(path.join(ROOT, 'modules', '_shared', 'source-locator'));
const CbMain = require(path.join(ROOT, 'modules', 'cellebrite', 'cellebrite-main'));

let passed = 0, failed = 0;
function ok(label, cond, extra) {
    if (cond) { passed++; console.log('  ok   ' + label); }
    else { failed++; console.log('  FAIL ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// ── lift the shipping fingerprint function ─────────────────────────────────
const em = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const fa = em.indexOf('async function _sourceFingerprint(spec)');
const fb = em.indexOf("ipcMain.handle('source-locate'", fa);
if (fa < 0 || fb < 0) throw new Error('could not find _sourceFingerprint in electron-main.js');
const fenv = {
    require: (p) => require(p.startsWith('./') ? path.join(ROOT, p) : p),
    security: null, console, Date,
};
vm.createContext(fenv);
vm.runInContext(em.slice(fa, fb) + '\n;globalThis.__fp = _sourceFingerprint;', fenv);
CbMain.setSourceFingerprint(fenv.__fp);

// ── load the renderer module class ─────────────────────────────────────────
const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console };
win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'cellebrite', 'cellebrite-module.js'), 'utf8'), win);

// ── synthetic extraction ───────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-cb-src-'));
const ex = path.join(work, 'extracted');
fs.mkdirSync(ex);

function mkdb(name, sql, rows) {
    const db = new Sqlite(path.join(ex, name));
    db.exec(sql);
    for (const [q, ...args] of rows) db.prepare(q).run(...args);
    db.close();
}
mkdb('contacts2.db',
    'CREATE TABLE raw_contacts (_id INTEGER PRIMARY KEY, display_name TEXT);' +
    'CREATE TABLE calls (_id INTEGER PRIMARY KEY, number TEXT, date INTEGER, duration INTEGER);', [
    ['INSERT INTO raw_contacts VALUES (1, ?)', 'Alice Anderson'],
    ['INSERT INTO raw_contacts VALUES (2, ?)', 'Alice Anderson'],          // same name, different row
    ['INSERT INTO calls VALUES (1, ?, ?, 30)', '+15551110001', 1780000000111],
    ['INSERT INTO calls VALUES (2, ?, ?, 45)', '+15551110001', 1780000000222], // same number, different row
]);
mkdb('mmssms.db',
    'CREATE TABLE sms (_id INTEGER PRIMARY KEY, address TEXT, body TEXT, date INTEGER);' +
    'CREATE TABLE pdu (_id INTEGER PRIMARY KEY, date INTEGER);' +
    'CREATE TABLE part (_id INTEGER PRIMARY KEY, mid INTEGER, text TEXT);' +
    'CREATE TABLE addr (_id INTEGER PRIMARY KEY, msg_id INTEGER, address TEXT);', [
    ['INSERT INTO sms VALUES (11, ?, ?, ?)', '+15552220002', 'see you at 7', 1780000001000],
    ['INSERT INTO sms VALUES (12, ?, ?, ?)', '+15552220002', 'see you at 7', 1780000002000],
    ['INSERT INTO pdu VALUES (7, 1780000003)'],
    ['INSERT INTO part VALUES (1, 7, ?)', 'Photo attached'],
    ['INSERT INTO addr VALUES (1, 7, ?)', '+15553330003'],
]);
mkdb('bugle_db',
    'CREATE TABLE messages (_id INTEGER PRIMARY KEY, received_timestamp INTEGER);' +
    'CREATE TABLE parts (_id INTEGER PRIMARY KEY, message_id INTEGER, text TEXT);', [
    ['INSERT INTO messages VALUES (5, 1780000004123)'],
    ['INSERT INTO parts VALUES (1, 5, ?)', 'Meet at the "usual" place'],
    ['INSERT INTO parts VALUES (2, 5, ?)', 'bring cash'],
]);
mkdb('accounts_ce.db', 'CREATE TABLE accounts (_id INTEGER PRIMARY KEY, name TEXT, type TEXT);', [
    ['INSERT INTO accounts VALUES (1, ?, ?)', 'user@example.com', 'com.google'],
]);
fs.writeFileSync(path.join(ex, 'WifiConfigStore.xml'),
    '<?xml version="1.0"?>\n<WifiConfigStoreData>\n<WifiConfiguration>\n<string name="SSID">&quot;HomeNet-5G&quot;</string>\n' +
    '<string name="BSSID">aa:bb:cc:dd:ee:01</string>\n</WifiConfiguration>\n</WifiConfigStoreData>\n');
fs.writeFileSync(path.join(ex, 'mmssms.db-shm'), Buffer.alloc(64, 1));   // scratch file — never fingerprinted
fs.writeFileSync(path.join(work, 'EvidenceCollection.ufdx'), '<ufdx/>');
fs.writeFileSync(path.join(work, 'Pixel.ufd'), '[General]\nModel=Pixel\n');

const extractedFiles = ['contacts2.db', 'mmssms.db', 'mmssms.db-shm', 'bugle_db', 'accounts_ce.db', 'WifiConfigStore.xml']
    .map(n => ({ kind: n, destPath: path.join(ex, n) }));

(async () => {
    console.log('\n[fingerprint at import]');
    const fp = CbMain._internals._cellebriteFingerprint;
    const si = await fp(ex, extractedFiles, [path.join(work, 'EvidenceCollection.ufdx'), path.join(work, 'Pixel.ufd'), null]);
    ok('a fingerprint is recorded', !!(si && si.sha256 && si.algorithm === 'SHA-256'), si);
    ok('it covers the 5 files VIPER reads', si && si.fileCount === 5, si && si.fileCount);
    ok('the -shm scratch file is not in it', si && si.hashOnly.indexOf('mmssms.db-shm') === -1, si && si.hashOnly);
    ok('paths are relative to the extracted folder', si && si.hashOnly.every(p => !path.isAbsolute(p) && !p.includes('\\')), si && si.hashOnly);
    ok('the .ufdx and .ufd are hashed separately',
        si && Array.isArray(si.indexFiles) && si.indexFiles.map(f => f.name).join(',') === 'EvidenceCollection.ufdx,Pixel.ufd' &&
        si.indexFiles.every(f => /^[0-9a-f]{64}$/.test(f.sha256)), si && si.indexFiles);
    ok('no fingerprint function → null, never a throw', await (async () => {
        CbMain.setSourceFingerprint(null);
        const r = await fp(ex, extractedFiles, []);
        CbMain.setSourceFingerprint(fenv.__fp);
        return r === null;
    })());

    const M = new win.CellebriteModule('c', 'n', 'x');
    const imp = { id: 'cb_1', deviceLabel: 'Pixel', extractedDir: ex, sourceIntegrity: si, flagged: {} };
    M.data.imports = [imp];
    M.activeImportId = imp.id;

    console.log('\n[source spec]');
    const spec = M._sourceSpec(imp);
    ok('spec points at the extracted folder', spec && spec.source.path === ex);
    ok('spec carries the hashed file list', spec && spec.source.hashOnly.join('|') === si.hashOnly.join('|'));
    ok('an import with no folder has no spec', M._sourceSpec({ id: 'old' }) === null);
    ok('today\'s hash matches the import fingerprint', L.compareIntegrity(si, await L.hashSource(spec.source, null)) === 'match');

    console.log('\n[citations — exact rows]');
    // Calls source as recorded in the parsed calls surface.
    M._parsedCache.set(imp.id, { calls: { source: 'contacts2.db', calls: [] } });
    const rowCases = [
        ['contacts', { id: '2', displayName: 'Alice Anderson', phones: [] }, 'raw_contacts', 2],
        ['contacts', { id: '2', displayName: 'Alice Anderson', phones: '' }, 'raw_contacts', 2],   // trimmed (push) shape
        ['calls', { id: '2', number: '+15551110001', timestamp: 1780000000222 }, 'calls', 2],
        ['sms', { id: 'sms-12', body: 'see you at 7', address: '+15552220002', timestamp: 1780000002000 }, 'sms', 12],
        ['accounts', { id: '1', name: 'user@example.com', type: 'com.google' }, 'accounts', 1],
    ];
    const batch = [];
    for (const [sec, it, table, rowid] of rowCases) {
        const q = M._citationFor(imp, sec, it);
        ok(`${sec} ${it.id}: carries a row pointer`, q.record && q.record.table === table && q.record.rowid === rowid, q.record);
        const r = await L.locate(spec.source, { values: q.values, memberHints: q.memberHints, record: q.record, maxHits: 3 }, null);
        const h = r.hits && r.hits[0];
        ok(`${sec} ${it.id}: found at ${table} › row ${rowid}, not a look-alike row`,
            r.found && r.primaryFound && h.table === table && Number(h.rowid) === rowid, h && [h.member, h.table, h.rowid]);
        batch.push({ id: sec + it.id + batch.length, values: q.values, memberHints: q.memberHints, record: q.record });
    }
    const cb = await L.citeBatch(spec.source, batch, null);
    ok('the evidence-push batch cites every row exactly',
        cb.ok && cb.results.every((r, i) => r.found && r.primaryFound && Number(r.rowid) === rowCases[i][3]), cb.results);
    ok('the citation labels name the value', M._citationFor(imp, 'sms', rowCases[3][1]).labels[0] === 'Message text');
    ok('a nameless contact is not cited by "(no name)"',
        M._citationFor(imp, 'contacts', { id: '9', displayName: '(no name)', phones: [{ number: '+15550000009' }] }).values[0] === '+15550000009');

    console.log('\n[citations — by value]');
    const valueCases = [
        ['rcs-bg-5', { id: 'rcs-bg-5', body: 'Meet at the "usual" place\nbring cash', address: '', timestamp: 1780000004123 }, 'parts'],
        ['mms-7', { id: 'mms-7', body: 'Photo attached', address: '+15553330003', timestamp: 1780000003000 }, 'part'],
    ];
    for (const [label, it, table] of valueCases) {
        const q = M._citationFor(imp, 'sms', it);
        ok(`${label}: no row pointer (text lives in a parts table)`, !q.record, q.record);
        const r = await L.locate(spec.source, { values: q.values, memberHints: q.memberHints, maxHits: 3 }, null);
        const h = r.hits && r.hits[0];
        ok(`${label}: its text is found in ${table}`, r.found && r.primaryFound && h.table === table, h && [h.member, h.table, h.rowid]);
    }
    ok('MMS time is cited in the seconds the database stores',
        M._citationFor(imp, 'sms', valueCases[1][1]).values.indexOf('1780000003') !== -1);
    const wq = M._citationFor(imp, 'wifi', { ssid: 'HomeNet-5G', bssid: 'aa:bb:cc:dd:ee:01' });
    const wr = await L.locate(spec.source, { values: wq.values, memberHints: wq.memberHints, maxHits: 3 }, null);
    ok('a Wi-Fi network is found in WifiConfigStore.xml', wr.found && wr.primaryFound && /WifiConfigStore\.xml$/.test(wr.hits[0].member), wr.hits && wr.hits[0]);
    ok('media is not applicable', M._citationFor(imp, 'media', { id: 'm1', filename: 'a.jpg' }).values.length === 0);

    console.log('\n[relocate]');
    let saved = 0; M.saveData = () => { saved++; };
    M.relocateSource('cb_1', 'D:\\moved\\extracted');
    ok('relocating records the new folder and saves', imp.sourcePath === 'D:\\moved\\extracted' && saved === 1 && M._sourceSpec(imp).source.path === 'D:\\moved\\extracted');
    delete imp.sourcePath;

    console.log('\n[tamper]');
    L._clearCaches();
    const dbFile = path.join(ex, 'mmssms.db');
    const buf = fs.readFileSync(dbFile); buf[buf.length - 1] ^= 0xff; fs.writeFileSync(dbFile, buf);
    ok('an edited database no longer matches', L.compareIntegrity(si, await L.hashSource(spec.source, null)) === 'mismatch');
    fs.writeFileSync(path.join(ex, 'mmssms.db-shm'), Buffer.alloc(64, 2));
    buf[buf.length - 1] ^= 0xff; fs.writeFileSync(dbFile, buf);
    L._clearCaches();
    ok('restoring it — with a rewritten -shm — matches again', L.compareIntegrity(si, await L.hashSource(spec.source, null)) === 'match');

    L._clearCaches();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
