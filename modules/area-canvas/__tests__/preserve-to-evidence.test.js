/**
 * preserve-to-evidence.test.js — plain node, no Electron needed.
 *
 *   node modules/area-canvas/__tests__/preserve-to-evidence.test.js
 *
 * Covers the "preserve canvass media for court" path, which spans three
 * files:
 *
 *   1. canvas-media.js  — the gallery's selection controls and which items
 *      preserveSelected() is willing to hand over.
 *   2. electron-main.js — the IPC that actually copies bytes out of
 *      "Canvas Media" and into "Evidence".
 *   3. connection-board.js — reading canvass media by NAME rather than by
 *      path, so a canvass pin can show what was captured at that door.
 *
 * The electron-main and connection-board sections LIFT the shipping code out
 * of the source file and run it here. A copied block is the thing that
 * drifts; a lifted one fails the moment the real handler changes shape.
 *
 * The thing being protected: a canvass entry is a record of what an officer
 * was shown at a door. Preserving something off it must COPY, never move —
 * otherwise filing evidence quietly rewrites the record it came from.
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

// ═════════════════════════════════════════════════════════════════════════
//  1. THE GALLERY'S SELECTION CONTROLS  (canvas-media.js)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. Gallery selection controls');

const CM_SRC = fs.readFileSync(path.join(__dirname, '..', 'canvas-media.js'), 'utf8');

// Checkboxes the fake document will report as ticked.
let CHECKED = [];

function loadCanvasMedia() {
    const noop = () => {};
    const mkEl = () => ({
        style: {}, className: '', textContent: '', innerHTML: '', children: [],
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        appendChild: noop, addEventListener: noop, setAttribute: noop,
        getAttribute: () => null, querySelectorAll: () => [], remove: noop
    });
    const document = {
        getElementById: () => mkEl(),
        createElement: () => mkEl(),
        // preserveSelected() scopes its query by entry index, so the stub
        // honours the prefix rather than returning everything.
        querySelectorAll: (sel) => {
            const m = /data-cm-pick\^="([^"]+)"/.exec(sel);
            const prefix = m ? m[1] : '';
            return CHECKED
                .filter(v => String(v).indexOf(prefix) === 0)
                .map(v => ({ getAttribute: () => v }));
        },
        body: { insertAdjacentHTML: noop, appendChild: noop }
    };
    const sandbox = {
        document, console,
        navigator: { mediaDevices: null },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
        Map, Set, Promise, Date, Math, JSON, Number, String, Array, Object,
        Blob: function (parts, o) { this.type = (o && o.type) || ''; this.size = 1; },
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        setInterval: () => 0, clearInterval: noop,
        MediaRecorder: undefined, electronAPI: undefined
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CM_SRC, sandbox);
    return sandbox.CanvasMedia;
}

const entry = {
    address: '1420 Main St',
    media: [
        { fileName: 'a.jpg', kind: 'image', mime: 'image/jpeg', bytes: 1000, discoverable: true },
        { fileName: 'b.mp4', kind: 'video', mime: 'video/mp4', bytes: 2000, durationSec: 12, discoverable: true },
        { fileName: 'c.m4a', kind: 'audio', mime: 'audio/mp4', bytes: 3000, durationSec: 30, discoverable: false }
    ]
};

// -- No host hook -> no preserve controls at all. A button that cannot do
//    anything is worse than no button.
const cmBare = loadCanvasMedia();
cmBare.configure({ getEntries: () => [entry], getCaseNumber: () => '25-001' });
const bareHtml = cmBare.galleryHtml(entry, 0);
ok(bareHtml.indexOf('cm-preserve-bar') === -1, 'no preserve bar when the host cannot file evidence');
ok(bareHtml.indexOf('data-cm-pick') === -1, 'no tick boxes when the host cannot file evidence');
ok(bareHtml.indexOf('cm-disc') !== -1, 'the Discovery Status chip is still there');

// -- With the hook wired, the controls appear.
let handed = null;
const cm = loadCanvasMedia();
cm.configure({
    getEntries: () => [entry],
    getCaseNumber: () => '25-001',
    persist: () => {},
    rerender: () => {},
    toast: () => {},
    preserveToEvidence: (i, items) => { handed = { i, items }; }
});
const html = cm.galleryHtml(entry, 0);
ok(html.indexOf('cm-preserve-bar') !== -1, 'preserve bar renders when the host can file evidence');
eq((html.match(/data-cm-pick/g) || []).length, 3, 'one tick box per item');
ok(html.indexOf('data-cm-pick="0:0"') !== -1, 'tick boxes are scoped by entry index');
ok(html.indexOf('copy, not a move') !== -1, 'the bar says plainly that this copies');

// -- An already-preserved item states where it went instead of offering a
//    tick. The tick is spent; the photo is not.
const preservedEntry = JSON.parse(JSON.stringify(entry));
preservedEntry.media[0].evidenceTag = 'Canvass 1420 Main St';
const html2 = cm.galleryHtml(preservedEntry, 0);
ok(html2.indexOf('cm-preserved') !== -1, 'a preserved item renders the In Evidence badge');
eq((html2.match(/data-cm-pick/g) || []).length, 2, 'a preserved item no longer offers a tick');
ok(html2.indexOf('preserved in the Evidence module') !== -1, 'the gallery says how many are preserved');
ok(html2.indexOf('Canvass 1420 Main St') !== -1, 'the badge names the evidence tag');

// -- Every item preserved -> nothing left to offer, so the bar goes away.
const allDone = JSON.parse(JSON.stringify(entry));
allDone.media.forEach(m => { m.evidenceTag = 'T'; });
ok(cm.galleryHtml(allDone, 0).indexOf('cm-preserve-bar') === -1,
   'the bar disappears once everything is preserved');

// -- preserveSelected hands over exactly what was ticked.
console.log('\n2. preserveSelected');
CHECKED = ['0:0', '0:2'];
handed = null;
cm.preserveSelected(0);
ok(handed !== null, 'the host hook was called');
eq(handed.items.length, 2, 'two ticked items handed over');
eq(handed.items[0].fileName, 'a.jpg', 'first ticked item');
eq(handed.items[1].fileName, 'c.m4a', 'second ticked item');
eq(handed.i, 0, 'the entry index rides along');

// -- Nothing ticked -> the host is never called, and the officer is told.
CHECKED = [];
handed = null;
let toasted = '';
cm.configure({ toast: (m) => { toasted = m; } });
cm.preserveSelected(0);
ok(handed === null, 'nothing ticked means the host is not called');
ok(/Tick the photos/.test(toasted), 'the officer is told to tick something first');

// -- A tick for an item that is ALREADY preserved is ignored, even if a
//    stale DOM still shows it. Filing the same photo twice is a discovery
//    problem, not a cosmetic one.
cm.configure({ toast: () => {}, preserveToEvidence: (i, items) => { handed = { i, items }; } });
const stale = JSON.parse(JSON.stringify(entry));
stale.media[0].evidenceTag = 'already';
cm.configure({ getEntries: () => [stale] });
CHECKED = ['0:0', '0:1'];
handed = null;
cm.preserveSelected(0);
eq(handed.items.length, 1, 'the already-preserved tick is dropped');
eq(handed.items[0].fileName, 'b.mp4', 'only the un-preserved item is handed over');

// -- Ticks belonging to a different entry never leak in.
cm.configure({ getEntries: () => [entry, { media: [] }] });
CHECKED = ['1:0', '0:1'];
handed = null;
cm.preserveSelected(0);
eq(handed.items.length, 1, 'only this entry\'s ticks count');
eq(handed.items[0].fileName, 'b.mp4', 'the other entry\'s tick is ignored');

// ═════════════════════════════════════════════════════════════════════════
//  3. THE COPY ITSELF  (lifted out of electron-main.js)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. canvas-media-to-evidence (lifted from electron-main.js)');

const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const START = "ipcMain.handle('canvas-media-to-evidence'";
const s0 = MAIN.indexOf(START);
ok(s0 !== -1, 'the canvas-media-to-evidence handler is still in electron-main.js');
const s1 = MAIN.indexOf("\n});", s0);
const BLOCK = MAIN.slice(s0, s1 + 4);
ok(BLOCK.indexOf("flag: 'wx'") !== -1,
   'the copy claims its name with an exclusive-create write');
ok(BLOCK.indexOf('security.encryptBuffer') !== -1,
   'the Evidence copy is re-encrypted under current Field Security');
ok(BLOCK.indexOf('unlock Field Security') !== -1,
   'a locked vault refuses rather than copying ciphertext into Evidence');
ok(MAIN.indexOf('A COPY, not a move.') !== -1,
   'the handler documents that it copies rather than moves');

// Run the lifted handler against a real temp case folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-preserve-'));
const CASE = '25-001';
const CANVAS_MEDIA_DIR = 'Canvas Media';
fs.mkdirSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR), { recursive: true });
fs.writeFileSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR, 'door.jpg'), Buffer.from('PHOTO-BYTES'));
fs.writeFileSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR, 'clip.mp4'), Buffer.from('VIDEO-BYTES'));

// Field Security stub: a 6-byte VIPENC header, same shape the real one uses.
const HDR = Buffer.from('VIPENC');
const securityStub = {
    enabled: false, unlocked: true,
    isEnabled() { return this.enabled; },
    isUnlocked() { return this.unlocked; },
    isEncryptedBuffer(b) { return b.length >= 6 && b.slice(0, 6).equals(HDR); },
    encryptBuffer(b) { return Buffer.concat([HDR, b]); },
    decryptBuffer(b) { return b.slice(6); }
};

let HANDLERS = {};
const env = {
    ipcMain: { handle: (name, fn) => { HANDLERS[name] = fn; } },
    path, fs, console,
    casesDir: TMP,
    CANVAS_MEDIA_DIR,
    security: securityStub,
    _safeCaseNumber: (n) => {
        const s = String(n || '').trim();
        return /^[A-Za-z0-9._-]+$/.test(s) ? s : '';
    },
    _sanitizeAttachmentName: (n) => {
        const s = path.basename(String(n || '')).replace(/[^A-Za-z0-9 ._()-]/g, '_').trim();
        return s && s !== '.' && s !== '..' ? s : '';
    },
    Buffer, String, Array, Object, Error, Promise
};
env.globalThis = env;
vm.createContext(env);
vm.runInContext(BLOCK, env);
const copy = HANDLERS['canvas-media-to-evidence'];
ok(typeof copy === 'function', 'the lifted handler registered');

(async () => {
    // -- Plain copy, security off.
    let r = await copy(null, { caseNumber: CASE, evidenceTag: 'Canvass Main St', fileNames: ['door.jpg', 'clip.mp4'] });
    eq(r.success, true, 'copy succeeds');
    eq(r.files.length, 2, 'both files copied');
    eq(r.failed.length, 0, 'nothing failed');

    const evDir = path.join(TMP, CASE, 'Evidence', 'Canvass Main St');
    ok(fs.existsSync(path.join(evDir, 'door.jpg')), 'the photo landed in Evidence');
    eq(fs.readFileSync(path.join(evDir, 'door.jpg')).toString(), 'PHOTO-BYTES', 'bytes are intact');
    eq(r.files[0].size, 'PHOTO-BYTES'.length, 'the reported size is the plaintext size');
    ok(path.isAbsolute(r.files[0].path), 'an absolute path comes back for the evidence record');

    // -- THE POINT: the canvass copy is still there. This is a copy.
    ok(fs.existsSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR, 'door.jpg')),
       'the canvass entry keeps its copy — preserving evidence never rewrites the canvass record');
    eq(fs.readFileSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR, 'door.jpg')).toString(), 'PHOTO-BYTES',
       'and the canvass copy is untouched');

    // -- Preserving the same file again does not overwrite the first copy.
    r = await copy(null, { caseNumber: CASE, evidenceTag: 'Canvass Main St', fileNames: ['door.jpg'] });
    eq(r.files[0].name, 'door (1).jpg', 'a name collision suffixes instead of overwriting');
    ok(fs.existsSync(path.join(evDir, 'door (1).jpg')), 'the suffixed file exists');
    eq(fs.readFileSync(path.join(evDir, 'door.jpg')).toString(), 'PHOTO-BYTES',
       'the first copy survived the second preserve');

    // -- A missing file is reported per-file and does not sink the batch.
    r = await copy(null, { caseNumber: CASE, evidenceTag: 'Partial', fileNames: ['door.jpg', 'ghost.jpg'] });
    eq(r.success, true, 'a missing file does not fail the whole request');
    eq(r.files.length, 1, 'the file that exists is still copied');
    eq(r.failed.length, 1, 'the missing one is reported');
    eq(r.failed[0].fileName, 'ghost.jpg', 'by name');
    ok(/not found/i.test(r.failed[0].error), 'with a reason the officer can act on');

    // -- Bad input is refused rather than guessed at.
    eq((await copy(null, { caseNumber: '', evidenceTag: 'T', fileNames: ['a'] })).success, false, 'no case number is refused');
    eq((await copy(null, { caseNumber: CASE, evidenceTag: '', fileNames: ['a'] })).success, false, 'no evidence tag is refused');
    eq((await copy(null, { caseNumber: CASE, evidenceTag: 'T', fileNames: [] })).success, false, 'an empty selection is refused');

    // -- A traversal attempt in the tag cannot escape the Evidence folder.
    r = await copy(null, { caseNumber: CASE, evidenceTag: '../../escape', fileNames: ['door.jpg'] });
    ok(!fs.existsSync(path.join(TMP, 'escape')), 'the tag cannot climb out of the case folder');

    // -- Security ON and unlocked: the canvass file is ciphertext, the
    //    Evidence copy is ciphertext, and the plaintext never hits disk.
    securityStub.enabled = true;
    fs.writeFileSync(path.join(TMP, CASE, CANVAS_MEDIA_DIR, 'sealed.jpg'),
                     securityStub.encryptBuffer(Buffer.from('SEALED-BYTES')));
    r = await copy(null, { caseNumber: CASE, evidenceTag: 'Sealed', fileNames: ['sealed.jpg'] });
    eq(r.files.length, 1, 'an encrypted canvass file copies when the vault is unlocked');
    const sealedOut = fs.readFileSync(path.join(TMP, CASE, 'Evidence', 'Sealed', 'sealed.jpg'));
    ok(securityStub.isEncryptedBuffer(sealedOut), 'the Evidence copy is encrypted at rest');
    eq(securityStub.decryptBuffer(sealedOut).toString(), 'SEALED-BYTES', 'and decrypts to the original');
    eq(r.files[0].size, 'SEALED-BYTES'.length, 'the reported size is the plaintext size, not the ciphertext size');

    // -- An unencrypted file copied while security is ON gets encrypted, so
    //    the copy obeys the CURRENT policy rather than inheriting the old one.
    r = await copy(null, { caseNumber: CASE, evidenceTag: 'Upgraded', fileNames: ['clip.mp4'] });
    const upgraded = fs.readFileSync(path.join(TMP, CASE, 'Evidence', 'Upgraded', 'clip.mp4'));
    ok(securityStub.isEncryptedBuffer(upgraded), 'a plain canvass file is encrypted on the way into Evidence');

    // -- Security ON and LOCKED: refuse. Copying ciphertext we cannot read
    //    into Evidence would produce an evidence file nobody can open.
    securityStub.unlocked = false;
    r = await copy(null, { caseNumber: CASE, evidenceTag: 'Locked', fileNames: ['sealed.jpg'] });
    eq(r.files.length, 0, 'nothing is copied while the vault is locked');
    eq(r.failed.length, 1, 'the locked file is reported');
    ok(/unlock Field Security/i.test(r.failed[0].error), 'and says how to fix it');
    ok(!fs.existsSync(path.join(TMP, CASE, 'Evidence', 'Locked', 'sealed.jpg')),
       'no unreadable file is left behind in Evidence');
    securityStub.unlocked = true;
    securityStub.enabled = false;

    // ═════════════════════════════════════════════════════════════════════
    //  4. CANVASS MEDIA ON THE CONNECTION BOARD  (connection-board.js)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n4. Canvass media on the Connection Board');

    const CB = fs.readFileSync(path.join(REPO, 'modules', 'connection-board', 'connection-board.js'), 'utf8')
        .replace(/\r\n/g, '\n');

    ok(CB.indexOf('function canvasEntryMedia(') !== -1, 'canvasEntryMedia exists');
    ok(CB.indexOf('function _readPinMediaBytes(') !== -1, 'the shared media reader exists');
    ok(CB.indexOf("if (m && m.canvasFile)") !== -1, 'the reader dispatches on canvasFile');
    ok(CB.indexOf('api.canvasReadMedia({') !== -1,
       'canvass media is read by NAME through its own IPC, which handles decryption');

    // The media host used to be gated on evidence pins only; a canvass pin
    // carrying photos would have shown none.
    ok(CB.indexOf("(pin.type === 'evidence' && pin.data && pin.data.media") === -1,
       'the card no longer gates media on the evidence type');
    ok(CB.indexOf("var mediaList = (pin.data && pin.data.media && pin.data.media.length)") !== -1,
       'any pin carrying media renders it');
    ok(CB.indexOf("if (p.type === 'evidence' && p.data && p.data.media") === -1,
       'the standalone export no longer gates media on the evidence type either');

    // addFromCaseData used to save through a possibly-stale caseId.
    const afcd = CB.slice(CB.indexOf('function addFromCaseData('), CB.indexOf("// ============================================================\n  //  DRAWER SHELL"));
    ok(afcd.indexOf('caseId = currentCase.id;') !== -1 && afcd.indexOf('loadBoard();') !== -1,
       'addFromCaseData re-reads the board when the drawer is closed, so pins land in the right case');
    ok(afcd.indexOf('if (drawerOpen) { renderCurrentView(); renderLocPanel(); }') !== -1,
       'it only repaints when there is a drawer to repaint');

    // The canvass branch carries the door's media and honours a hand-set GPS.
    const canvasBranch = afcd.slice(afcd.indexOf("else if (type === 'canvas')"), afcd.indexOf("else if (type === 'evidence')"));
    ok(canvasBranch.indexOf('canvasEntryMedia(c, cnum)') !== -1, 'canvass pins carry the door\'s media');
    ok(canvasBranch.indexOf('cPin.data.media = cMedia;') !== -1,
       'media is refreshed on re-sync, not only seeded on create');
    ok(canvasBranch.indexOf('c.manualLat') !== -1, 'a hand-set GPS pin is used instead of geocoding');
    ok(canvasBranch.indexOf('!cPin._posManual') !== -1, 'a hand-dragged pin is never moved by a re-sync');
    ok(canvasBranch.indexOf("sourceTab: 'areacanvas'") !== -1, 'the card can jump back to the canvass tab');

    // Run canvasEntryMedia for real.
    const cbEnv = { window: {}, console, Array, String, Object };
    cbEnv.globalThis = cbEnv;
    vm.createContext(cbEnv);
    const lifted = CB.slice(CB.indexOf('function _mediaKind('), CB.indexOf('function _readPinMediaBytes(')) +
        '\n;Object.assign(globalThis, { canvasEntryMedia: canvasEntryMedia });';
    // _mimeFromExt lives above the slice — lift it too.
    const mimeFn = CB.slice(CB.indexOf('function _mimeFromExt('), CB.indexOf('function _mediaKind('));
    vm.runInContext(mimeFn + lifted, cbEnv);

    const cem = cbEnv.canvasEntryMedia;
    const got = cem({ media: [
        { fileName: 'a.jpg', kind: 'image', mime: 'image/jpeg' },
        { fileName: 'b.mp4', kind: 'video', mime: 'video/mp4', evidenceTag: 'T' },
        { fileName: 'no-name-file' },                       // no kind, no mime
        null,
        { kind: 'image' }                                   // no file name
    ] }, '25-001');
    eq(got.length, 2, 'only items with a name and a resolvable kind are offered');
    eq(got[0].canvasFile, 'a.jpg', 'the descriptor carries the file NAME, not a path');
    eq(got[0].caseNumber, '25-001', 'and the case number needed to find it');
    ok(got[0].path === undefined, 'canvass media has no path — that is the whole point');
    eq(got[1].preserved, true, 'an item already in Evidence is flagged as such');
    eq(got[0].preserved, false, 'one that is not, is not');
    eq(cem(null, '25-001').length, 0, 'a null entry yields nothing');
    eq(cem({}, '25-001').length, 0, 'an entry with no media yields nothing');

    // ── Done ─────────────────────────────────────────────────────────────
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') +
                ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
    console.error('TEST CRASHED:', err);
    process.exit(1);
});
