'use strict';
// Cyber Tips "Find in Evidence" + reading Field-Security-encrypted PDFs,
// and the export tab -> folder mapping.
//
// Everything here is LIFTED from the shipping files (electron-main.js and
// case-detail-with-analytics.html), never copied, so the test cannot drift
// from what the app actually runs.
//
// Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd modules\__tests__\cybertip-evidence.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '  (got ' + A + ', want ' + B + ')'));
}

// Lift a top-level `function name(...) { ... }` by brace matching.
function liftFunction(src, header) {
    const s = src.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const open = src.indexOf('{', s + header.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
    }
    throw new Error('unbalanced: ' + header);
}
function liftConst(src, header) {
    const s = src.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const e = src.indexOf('};', s);
    return src.slice(s, e + 2);
}

// ═════════════════════════════════════════════════════════════════════════
//  1. PDF IMPORT READS ENCRYPTED EVIDENCE COPIES
// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. _readPdfBytesForImport (electron-main.js)');

const readerSrc = liftFunction(MAIN, 'function _readPdfBytesForImport(filePath) {');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-ct-'));
const plainPath = path.join(TMP, 'CyberTip 123456789.pdf');
const encPath = path.join(TMP, 'CyberTip 987654321.pdf');
fs.writeFileSync(plainPath, Buffer.from('%PDF-1.7 plain'));
fs.writeFileSync(encPath, Buffer.concat([Buffer.from('VIPENC'), Buffer.from('%PDF-1.7 sealed')]));

const security = {
    unlocked: true,
    isUnlocked() { return this.unlocked; },
    decryptBuffer(b) { return b.slice(6); }      // the stub "decrypt"
};
const env = { fs, Buffer, Error, security };
vm.createContext(env);
vm.runInContext(readerSrc + '\n;globalThis.__read = _readPdfBytesForImport;', env);
const read = env.__read;

eq(read(plainPath).toString(), '%PDF-1.7 plain', 'an ordinary PDF is read untouched');
eq(read(encPath).toString(), '%PDF-1.7 sealed', 'an encrypted evidence copy is decrypted before parsing');

security.unlocked = false;
let threw = null;
try { read(encPath); } catch (e) { threw = e; }
ok(threw && threw.code === 'VIPER_LOCKED', 'a locked vault refuses with VIPER_LOCKED rather than handing garbage to the parser');
ok(threw && /Unlock VIPER/.test(threw.message), 'and the message tells the officer what to do');
eq(read(plainPath).toString(), '%PDF-1.7 plain', 'a locked vault does not block an unencrypted PDF');
security.unlocked = true;

env.security = null;
threw = null;
try { read(encPath); } catch (e) { threw = e; }
ok(threw && threw.code === 'VIPER_LOCKED', 'no security module at all is treated as locked, not as plaintext');
env.security = security;

// Every PDF entry point the Cyber Tips import can reach goes through it.
const extractBlock = MAIN.slice(MAIN.indexOf("ipcMain.handle('extract-pdf-text'"),
                                MAIN.indexOf('\n});', MAIN.indexOf("ipcMain.handle('extract-pdf-text'")));
ok(extractBlock.indexOf('_readPdfBytesForImport(filePath)') !== -1, 'extract-pdf-text reads through the decrypting reader');
ok(!/fs\.readFileSync\(filePath\)/.test(extractBlock), 'and no longer reads raw bytes itself');
ok((MAIN.match(/_readPdfBytesForImport\(filePath\)/g) || []).length >= 3,
   'the two OCR fallbacks read through it too');

// ═════════════════════════════════════════════════════════════════════════
//  2. WHICH EVIDENCE PDFs ARE OFFERED
// ═════════════════════════════════════════════════════════════════════════
console.log('\n2. _cyberTipEvidenceCandidates (case-detail)');

const candSrc = liftFunction(DETAIL, 'function _cyberTipEvidenceCandidates() {');
const denv = { Set, String, Array, caseEvidence: [] };
vm.createContext(denv);
vm.runInContext(candSrc + '\n;globalThis.__cands = _cyberTipEvidenceCandidates;', denv);
const cands = () => denv.__cands();

eq(cands(), [], 'no evidence -> nothing offered');
denv.caseEvidence = null;
eq(cands(), [], 'a missing evidence list does not throw');

denv.caseEvidence = [
    null,
    { tag: 'Bank Records', type: 'document', files: [
        { name: 'statement.pdf', path: 'C:/cases/26-1/Evidence/Bank Records/statement.pdf' },
        { name: 'photo.jpg', path: 'C:/cases/26-1/Evidence/Bank Records/photo.jpg' } ] },
    { tag: 'NCMEC Tip', type: 'ncmecCybertip', files: [
        { name: 'report.PDF', path: 'C:/cases/26-1/Evidence/NCMEC Tip/report.PDF' } ] },
    { tag: 'Misc', type: 'document', files: [
        { name: 'CyberTip 123456789.pdf', path: 'C:/cases/26-1/Evidence/Misc/CyberTip 123456789.pdf' },
        { name: 'CT#987654321.pdf', path: 'C:/cases/26-1/Evidence/Misc/CT#987654321.pdf' },
        null,
        { name: 'no path.pdf' },
        { path: 'C:/cases/26-1/Evidence/Misc/unnamed.pdf' } ] },
    // The same file filed twice must only be offered once.
    { tag: 'Misc dup', type: 'document', files: [
        { name: 'CyberTip 123456789.pdf', path: 'C:/cases/26-1/Evidence/Misc/CyberTip 123456789.pdf' } ] },
    { tag: 'Broken', files: 'not-an-array' }
];
const c = cands();
const names = c.map(x => x.name);
ok(names.indexOf('photo.jpg') === -1, 'a non-PDF is never offered');
ok(names.indexOf('no path.pdf') === -1, 'a record with no path is skipped');
eq(names.filter(n => n === 'CyberTip 123456789.pdf').length, 1, 'a file filed twice is offered once');
ok(names.indexOf('unnamed.pdf') !== -1, 'a file with no stored name falls back to the file name from its path');
ok(names.indexOf('report.PDF') !== -1, 'the .pdf match is case-insensitive');

const by = n => c.find(x => x.name === n);
ok(by('report.PDF').ncmec && by('report.PDF').looksLikeTip, 'an NCMEC CyberTip evidence item is flagged as a likely tip');
ok(by('CyberTip 123456789.pdf').looksLikeTip, '"CyberTip" in the name is a likely tip');
ok(by('CT#987654321.pdf').looksLikeTip, 'a CT# report number in the name is a likely tip');
ok(!by('statement.pdf').looksLikeTip, 'a bank statement is offered but not pre-ticked');
eq(by('report.PDF').evidenceTag, 'NCMEC Tip', 'each candidate remembers which evidence item it came from');

// Ordering: likely tips first, NCMEC items first among those, then by name.
eq(c[0].name, 'report.PDF', 'the NCMEC item is listed first');
const firstNonTip = c.findIndex(x => !x.looksLikeTip);
ok(firstNonTip > 0 && c.slice(firstNonTip).every(x => !x.looksLikeTip), 'every likely tip is listed before the rest');

// Renderer wiring.
ok(/onclick="findCyberTipsInEvidence\(\)"/.test(DETAIL), 'the Cyber Tips tab has a Find in Evidence button');
ok(/await _importCyberTipFiles\(filePaths\.map\(p => \(\{ path: p \}\)\)\)/.test(DETAIL),
   'the file browser and Find in Evidence share one import loop');
const findSrc = liftFunction(DETAIL, 'async function findCyberTipsInEvidence() {');
ok(findSrc.indexOf('extractPdfText') === -1, 'opening the picker reads nothing — the officer chooses what to open');
const pickAt = findSrc.indexOf(".ct-ev-pick')");
const okAt = findSrc.indexOf('if (!ok) return;');
ok(pickAt !== -1 && okAt !== -1 && pickAt < okAt,
   'the ticks are read straight after the dialog resolves, before its DOM is removed');

// ═════════════════════════════════════════════════════════════════════════
//  3. EXPORT: TICKED TABS -> ZIP FOLDERS
// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. _exportFoldersForTabs / _exportContentsLine (case-detail)');

const xenv = { Set, Array, Object };
vm.createContext(xenv);
vm.runInContext([
    liftConst(DETAIL, 'const EXPORT_TAB_FOLDERS = {'),
    liftConst(DETAIL, 'const EXPORT_FOLDER_LABELS = {'),
    liftFunction(DETAIL, 'function _exportFoldersForTabs(tabIds) {'),
    liftFunction(DETAIL, 'function _exportContentsLine(folders) {'),
    ';globalThis.__f = _exportFoldersForTabs; globalThis.__l = _exportContentsLine;'
].join('\n'), xenv);
const F = xenv.__f, L = xenv.__l;

eq(F(['overview', 'reports']), [], 'Overview + Reports -> no case folders at all');
eq(F(['overview', 'evidence']), ['evidence'], 'Evidence ticked -> the evidence folder');
eq(F(['areacanvas', 'fieldwork', 'warrants', 'notes']).slice().sort(),
   ['canvas', 'fieldwork', 'notes', 'warrants'], 'each file-owning tab maps to its own folder');
eq(F(['evidence', 'evidence']), ['evidence'], 'a tab listed twice is sent once');
eq(F(null), [], 'no tab list -> nothing, never "everything"');

ok(/PDF report only/.test(L([])), 'the toast says "PDF report only" when no folders went in');
ok(/evidence files/.test(L(['evidence'])) && !/warrant/.test(L(['evidence'])),
   'the toast names exactly what went in');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
