/**
 * Cellebrite — media source check (🔍 on a media card).
 *
 * Media is never extracted at import; VIPER reads each file straight out of
 * Cellebrite's FileSystem zip. This pins the check that reads a file back
 * and compares it with what the dump itself records:
 *   - the CRC-32 is the standard one, and works in chunks;
 *   - a good file matches size + CRC-32, with SHA-256 / MD5 of the real bytes;
 *   - a file whose bytes were altered inside the dump does NOT match;
 *   - a missing file / missing dump / changed-since-import record is reported
 *     as such, never as a match;
 *   - Android gallery thumbnails are labelled as thumbnails;
 *   - the .ufd's [SHA256] record is found, and the whole-dump check compares
 *     against it, saves the result, and catches a different dump;
 *   - the window says the right thing for each of those, and the 🔍 button
 *     opens the check rather than the picture.
 *
 * Synthetic dump only — no real phone data.
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   node_modules\.bin\electron.cmd modules\cellebrite\__tests__\cellebrite-media-verify.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));
const CbMain = require(path.join(ROOT, 'modules', 'cellebrite', 'cellebrite-main'));
const I = CbMain._internals;

let passed = 0, failed = 0;
function ok(label, cond, extra) {
    if (cond) { passed++; console.log('  ok   ' + label); }
    else { failed++; console.log('  FAIL ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the renderer class, for the window ─────────────────────────────────────
const win = { console, Date, Number, Math, JSON, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} } };
win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'cellebrite', 'cellebrite-ui.js'), 'utf8'), win);
const UI = new win.CellebriteUI({ caseNumber: 'T-1', isFlagged: () => false });

(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-cb-mv-'));
    const oldCwd = process.cwd();

    // A synthetic "FileSystem 01/Phone.zip" with a camera photo, a gallery
    // thumbnail and a STORED entry we can alter in place.
    const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(70000)]);
    const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
    const STORED = Buffer.from('VIPER-STORED-MARKER-' + 'x'.repeat(4000), 'latin1');
    const z = new JSZip();
    z.file('Dump/data/media/0/DCIM/Camera/IMG_0001.jpg', PHOTO, { compression: 'DEFLATE', date: new Date(2025, 6, 16, 9, 15, 0) });
    z.file('Dump/data/media/0/Pictures/.thumbnails/1000000079.jpg', THUMB, { compression: 'DEFLATE' });
    z.file('Dump/data/media/0/Download/note.txt', STORED, { compression: 'STORE' });
    const zipBuf = await z.generateAsync({ type: 'nodebuffer' });
    const fsDir = path.join(work, 'UFED Phone', 'FileSystem 01');
    fs.mkdirSync(fsDir, { recursive: true });
    const zipPath = path.join(fsDir, 'Phone.zip');
    fs.writeFileSync(zipPath, zipBuf);
    const ufdText = [
        '[General]', 'AcquisitionTool=UFED 4PC', 'Version=7.75.1.144', 'Date=21/10/2025 11:33:45 (-7)', 'MachineName=LAB-01', '',
        '[Dumps]', 'FileDump=Phone.zip', '',
        '[SHA256]', `Phone.zip=${sha(zipBuf).toUpperCase()}`, '',
    ].join('\r\n');
    fs.writeFileSync(path.join(fsDir, 'Phone.ufd'), ufdText);

    // The renderer never supplies a path — items come from media.json.
    const item = (name, extra) => Object.assign({
        id: 'm_' + path.basename(name), type: 'image', mime: 'image/jpeg', filename: path.basename(name),
        entryPath: name.replace(/^Dump\//, ''), rawEntryName: name, sourceZip: zipPath, size: 0, crc32: null, mtime: null,
    }, extra || {});
    const photo = item('Dump/data/media/0/DCIM/Camera/IMG_0001.jpg', { size: PHOTO.length, capturedAt: '2025-07-16T09:15:00Z', width: 4000, height: 3000 });
    const thumb = item('Dump/data/media/0/Pictures/.thumbnails/1000000079.jpg', { size: THUMB.length });
    const stored = item('Dump/data/media/0/Download/note.txt', { type: 'document', mime: 'text/plain', size: STORED.length });

    console.log('\n[crc-32]');
    ok('the standard check value: CRC-32("123456789") = 0xCBF43926', I._crc32(Buffer.from('123456789'), 0) === 0xCBF43926);
    ok('computed in two chunks gives the same answer', I._crc32(Buffer.from('56789'), I._crc32(Buffer.from('1234'), 0)) === 0xCBF43926);
    ok('an empty buffer is 0', I._crc32(Buffer.alloc(0), 0) === 0);

    console.log('\n[the .ufd record]');
    const ufd = I._ufdRecordFor(zipPath);
    ok('the .ufd naming this dump is found', ufd && ufd.ufdName === 'Phone.ufd', ufd);
    ok("its [SHA256] value is read (lower-cased)", ufd && ufd.sha256 === sha(zipBuf));
    ok('tool, version and date come from [General]', ufd && ufd.tool === 'UFED 4PC 7.75.1.144' && ufd.extractedAt === '21/10/2025 11:33:45 (-7)');
    const other = path.join(fsDir, 'Other.zip'); fs.writeFileSync(other, zipBuf);
    const ufdOther = I._ufdRecordFor(other);
    ok('a .ufd that names a DIFFERENT dump is not used', ufdOther === null, ufdOther);
    fs.unlinkSync(other);

    console.log('\n[a good file]');
    const rp = await I._checkMediaItem(photo);
    ok('size read back matches the dump', rp.checks && rp.checks.sizeMatch === true, rp.checks);
    ok('CRC-32 read back matches the dump', rp.checks && rp.checks.crcMatch === true);
    ok('the CRC-32 VIPER computed is the true one of the bytes', rp.read && rp.read.crc32 === I._crc32(PHOTO, 0));
    ok('SHA-256 is of the real file bytes', rp.read && rp.read.sha256 === sha(PHOTO));
    ok('MD5 is of the real file bytes', rp.read && rp.read.md5 === md5(PHOTO));
    ok('names the dump and its FileSystem folder', rp.sourceZipName === 'Phone.zip' && rp.sourceFolder === 'FileSystem 01');
    ok('carries the .ufd record', rp.ufd && rp.ufd.sha256 === sha(zipBuf));
    ok('a camera photo is not called a thumbnail', rp.thumbnail === false);
    ok('an import without a recorded CRC says so', rp.checks.importHadCrc === false && rp.checks.sameAsImport === true);
    ok('the file date in the dump is read', rp.container && new Date(rp.container.time).getFullYear() === 2025);

    console.log('\n[recorded at import]');
    const withCrc = Object.assign({}, photo, { crc32: I._crc32(PHOTO, 0) });
    const rc = await I._checkMediaItem(withCrc);
    ok('a matching recorded CRC: same as import', rc.checks.importHadCrc === true && rc.checks.sameAsImport === true);
    const staleRec = Object.assign({}, photo, { crc32: (I._crc32(PHOTO, 0) ^ 1) >>> 0 });
    const rs = await I._checkMediaItem(staleRec);
    ok('a different recorded CRC: NOT the same as import', rs.checks.sameAsImport === false && rs.checks.crcMatch === true);
    const staleSize = Object.assign({}, photo, { size: PHOTO.length + 1 });
    ok('a different recorded size: NOT the same as import', (await I._checkMediaItem(staleSize)).checks.sameAsImport === false);

    console.log('\n[thumbnail]');
    const rt = await I._checkMediaItem(thumb);
    ok('a .thumbnails/ file is labelled a thumbnail', rt.thumbnail === true);
    ok('…and still checks out', rt.checks.crcMatch && rt.checks.sizeMatch);

    console.log('\n[missing]');
    const rm = await I._checkMediaItem(Object.assign({}, photo, { rawEntryName: 'Dump/data/media/0/DCIM/Camera/GONE.jpg' }));
    ok('a file not in the dump: entryMissing, no read, no checks', rm.entryMissing === true && !rm.read && !rm.checks);
    const rz = await I._checkMediaItem(Object.assign({}, photo, { sourceZip: path.join(fsDir, 'Nope.zip') }));
    ok('a dump not on disk: zipMissing, no read', rz.zipMissing === true && !rz.read);

    console.log('\n[altered inside the dump]');
    const tampered = Buffer.from(zipBuf);
    const at = tampered.indexOf(Buffer.from('VIPER-STORED-MARKER-', 'latin1'));
    tampered[at + 30] ^= 0x01;
    const tzPath = path.join(fsDir, 'Tampered.zip');
    fs.writeFileSync(tzPath, tampered);
    const rx = await I._checkMediaItem(Object.assign({}, stored, { sourceZip: tzPath }));
    const caught = !!rx.readError || (rx.checks && rx.checks.crcMatch === false);
    ok('one changed byte is caught (never reported as a match)', caught && !(rx.checks && rx.checks.crcMatch), { readError: rx.readError, checks: rx.checks });
    const altered = Buffer.from(STORED); altered[30] ^= 0x01;
    ok('…the altered bytes are measured in full (size, SHA-256 of what the dump now holds)',
        rx.read && rx.read.size === STORED.length && rx.read.sha256 === sha(altered) && rx.read.crc32 !== rx.container.crc32, rx.read);
    ok('…and the zip library\'s own refusal is kept', /crc/i.test(rx.libraryRefused || ''));
    ok('…the window calls it a mismatch', UI._mvVerdict(Object.assign({ success: true }, rx)).label === 'Does NOT match the dump', UI._mvVerdict(Object.assign({ success: true }, rx)));
    const zmeta = await (async () => {
        const { openZip } = require(path.join(ROOT, 'modules', '_shared', 'zip-reader'));
        const rd = await openZip(zipPath, {}); const m = rd._zip.entry(photo.rawEntryName); rd.close(); return m;
    })();
    const rawBytes = await new Promise((res, rej) => { const parts = []; I._rawEntryStream(zipPath, zmeta).then(s => { s.on('data', b => parts.push(b)); s.on('end', () => res(Buffer.concat(parts))); s.on('error', rej); }, rej); });
    ok('the fallback reader inflates a compressed entry to the exact bytes', rawBytes.equals(PHOTO));
    const rgood = await I._checkMediaItem(stored);
    ok('the same entry in the untouched dump matches', rgood.checks && rgood.checks.crcMatch && rgood.read.sha256 === sha(STORED));

    console.log('\n[media.json lookup + whole-dump check, via the real IPC handlers]');
    process.chdir(work);
    const impDir = path.join('cases', 'T-1', 'Cellebrite', 'cb_1');
    fs.mkdirSync(path.join(impDir, 'parsed'), { recursive: true });
    fs.writeFileSync(path.join(impDir, 'parsed', 'media.json'), JSON.stringify({ items: [photo, Object.assign({}, stored, { id: 'm_t', sourceZip: tzPath })] }));
    const H = {};
    CbMain.registerIpc({ handle: (name, fn) => { H[name] = fn; } });
    ok('the three media-check handlers are registered', ['cellebrite-media-verify', 'cellebrite-dump-verify', 'cellebrite-media-save'].every(n => typeof H[n] === 'function'));
    const lk = I._loadMediaItem('T-1', 'cb_1', photo.id);
    ok('an item is found by id in media.json', lk.ok && lk.item.rawEntryName === photo.rawEntryName);
    ok('an unknown id is refused', I._loadMediaItem('T-1', 'cb_1', 'nope').ok === false);
    const v = await H['cellebrite-media-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id });
    ok('verify: success, matched, with a "none" dump check', v.success && v.checks.crcMatch && v.dumpCheck && v.dumpCheck.state === 'none', v.dumpCheck);
    const v0 = await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id });
    ok('polling without start does not start a check', v0.success && v0.check.state === 'none');
    const v1 = await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id, start: true });
    ok('start: a check is running (or already done)', v1.success && (v1.check.state === 'running' || v1.check.state === 'done'), v1.check);
    let chk = v1.check;
    for (let i = 0; i < 50 && chk.state === 'running'; i++) {
        await sleep(40);
        chk = (await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id })).check;
    }
    ok("the whole dump matches Cellebrite's SHA-256", chk.state === 'done' && chk.match === true && chk.sha256 === sha(zipBuf), chk);
    const saved = JSON.parse(fs.readFileSync(path.join(impDir, 'dump-check.json'), 'utf8'));
    const savedRec = Object.values(saved)[0];
    ok('the result is saved beside the import', savedRec && savedRec.state === 'done' && savedRec.match === true);
    const v2 = await H['cellebrite-media-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id });
    ok('the next verify reports the finished whole-dump check', v2.dumpCheck && v2.dumpCheck.state === 'done' && v2.dumpCheck.match === true);

    // A different dump under the right name: Cellebrite's SHA-256 no longer fits.
    const t1 = await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: 'm_t', start: true });
    let tc = t1.check;
    for (let i = 0; i < 50 && tc.state === 'running'; i++) {
        await sleep(40);
        tc = (await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: 'm_t' })).check;
    }
    ok('a dump with no .ufd record: SHA-256 computed, match is null (nothing to compare)', tc.state === 'done' && tc.match === null && tc.sha256 === sha(tampered), tc);
    fs.writeFileSync(path.join(fsDir, 'Tampered.ufd'), `[SHA256]\r\nTampered.zip=${sha(zipBuf).toUpperCase()}\r\n`);
    fs.utimesSync(tzPath, new Date(), new Date(Date.now() + 5000)); // new mtime → new key → fresh check
    const t2 = await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: 'm_t', start: true });
    let tc2 = t2.check;
    for (let i = 0; i < 50 && tc2.state === 'running'; i++) {
        await sleep(40);
        tc2 = (await H['cellebrite-dump-verify']({}, { caseNumber: 'T-1', importId: 'cb_1', mediaId: 'm_t' })).check;
    }
    ok("a changed dump does NOT match Cellebrite's SHA-256", tc2.state === 'done' && tc2.match === false, tc2);

    console.log('\n[previews share one open reader per dump]');
    // Opening a real 48 GB dump costs ~0.5 s (its whole directory is read);
    // one picture costs ~1 ms. Count the openings, don't time them.
    const ZR = require(path.join(ROOT, 'modules', '_shared', 'zip-reader'));
    const realOpen = ZR.openZip;
    let opens = 0, closes = 0;
    ZR.openZip = async (p, o) => { opens++; const r = await realOpen(p, o); const c = r.close.bind(r); r.close = () => { closes++; c(); }; return r; };
    const readQ = { caseNumber: 'T-1', importId: 'cb_1', mediaId: photo.id };
    try {
        I._closeDumpReaders();
        ok('the preview handler is registered', typeof H['cellebrite-media-read'] === 'function');
        const reads = await Promise.all([1, 2, 3, 4, 5].map(() => H['cellebrite-media-read']({}, readQ)));
        ok('five previews at once: the right bytes every time', reads.every(r => r.success && Buffer.from(r.buffer, 'base64').equals(PHOTO)), reads.map(r => r.error));
        ok('…from ONE opening of the dump', opens === 1, opens);
        const again = await H['cellebrite-media-read']({}, readQ);
        ok('a later preview reuses it — no re-open, nothing closed', again.success && opens === 1 && closes === 0, { opens, closes });
        const held = Array.from(I._dumpReaders.values());
        ok('it is held open with an idle timer, so the drive is let go afterwards', held.length === 1 && held[0].users === 0 && held[0].timer != null && I.DUMP_READER_IDLE_MS === 30000);
        fs.utimesSync(zipPath, new Date(), new Date(Date.now() + 9000));
        const after = await H['cellebrite-media-read']({}, readQ);
        await sleep(20);
        ok('a changed dump gets a fresh reader and the old one is closed', after.success && Buffer.from(after.buffer, 'base64').equals(PHOTO) && opens === 2 && closes === 1, { opens, closes });
        I._closeDumpReaders(); await sleep(20);
        ok('closing releases every held dump', I._dumpReaders.size === 0 && closes === 2, { size: I._dumpReaders.size, closes });
        const gone = await I._withDumpReader(path.join(fsDir, 'Nope.zip'), () => 1).then(() => 'resolved', () => 'rejected');
        ok('a dump that is not there is refused, and nothing is cached', gone === 'rejected' && I._dumpReaders.size === 0);
        const junk = path.join(work, 'junk.zip'); fs.writeFileSync(junk, 'not a zip at all');
        const bad = await I._withDumpReader(junk, () => 1).then(() => 'resolved', () => 'rejected');
        ok('an unreadable dump is refused, and the failure is not cached', bad === 'rejected' && I._dumpReaders.size === 0);
        let inside = null;
        await I._withDumpReader(zipPath, async (rdr) => { inside = Array.from(I._dumpReaders.values())[0]; I._closeDumpReaders(); await sleep(10); inside.closedEarly = closes; return rdr.getEntries().length; });
        await sleep(20);
        ok('a reader is never closed under a preview still reading from it', inside && inside.closedEarly === 2 && closes === 3, { early: inside && inside.closedEarly, closes });
    } finally { ZR.openZip = realOpen; I._closeDumpReaders(); }
    process.chdir(oldCwd);

    console.log('\n[the window]');
    const stOk = { item: photo, imp: { id: 'cb_1' }, busy: false, r: Object.assign({ success: true }, rp), dump: { state: 'none', total: zipBuf.length } };
    const hOk = UI._mediaVerifyHtml(stOk);
    ok('a match shows "Matches the dump"', /data-cb-mv-verdict="Matches the dump"/.test(hOk));
    ok('shows the SHA-256 and MD5 in full', hOk.includes(sha(PHOTO)) && hOk.includes(md5(PHOTO)));
    ok('shows the on-phone path and the dump it came from', hOk.includes('/data/media/0/DCIM/Camera/IMG_0001.jpg') && hOk.includes('FileSystem 01 › Phone.zip'));
    ok("shows Cellebrite's recorded SHA-256 and offers the whole-dump check", hOk.includes(sha(zipBuf)) && /data-cb-mv="dump"/.test(hOk));
    ok('offers Show in folder, Save an exact copy and Copy for report', ['reveal', 'save', 'report'].every(a => hOk.includes(`data-cb-mv="${a}"`)));
    ok('no thumbnail warning on a camera photo', !/thumbnail<\/b>/.test(hOk));
    const hTh = UI._mediaVerifyHtml(Object.assign({}, stOk, { item: thumb, r: Object.assign({ success: true }, rt) }));
    ok('a thumbnail carries the thumbnail warning', /<b>thumbnail<\/b>/.test(hTh));
    const hBusy = UI._mediaVerifyHtml(Object.assign({}, stOk, { busy: true, r: null }));
    ok('while checking: a spinner, no verdict, no actions', /Checking…/.test(hBusy) && !/data-cb-mv-verdict/.test(hBusy) && !/data-cb-mv="save"/.test(hBusy));
    const hMiss = UI._mediaVerifyHtml(Object.assign({}, stOk, { r: Object.assign({ success: true }, rz) }));
    ok('a missing dump says "Dump not found" and offers no save', /Dump not found/.test(hMiss) && !/data-cb-mv="save"/.test(hMiss));
    ok('an entry gone from the dump says "Not in the dump"', UI._mvVerdict(Object.assign({ success: true }, rm)).label === 'Not in the dump');
    ok('a changed-since-import record is a warning, not a tick', UI._mvVerdict(Object.assign({ success: true }, rs)).cls === 'sv-warn');
    ok('a locked vault says so', UI._mvVerdict({ success: false, locked: true }).label === 'Locked');
    const hRun = UI._mvDumpHtml(Object.assign({}, stOk, { dump: { state: 'running', done: 50, total: 200 } }));
    ok('a running whole-dump check shows its progress', /25%/.test(hRun) && /keeps running/.test(hRun));
    const hBad = UI._mvDumpHtml(Object.assign({}, stOk, { dump: { state: 'done', match: false, sha256: 'ab'.repeat(32) } }));
    ok('a whole-dump mismatch is shown as NOT matching', /does NOT match the SHA-256 Cellebrite recorded/.test(hBad));
    const hGood = UI._mvDumpHtml(Object.assign({}, stOk, { dump: { state: 'done', match: true, sha256: sha(zipBuf) } }));
    ok('a whole-dump match is shown as matching', /The whole dump matches/.test(hGood) && !/NOT/.test(hGood));
    const rep = UI._mvReportText(Object.assign({}, stOk, { dump: { state: 'done', match: true, sha256: sha(zipBuf) } }));
    ok('the report text carries file, location, SHA-256, MD5 and both verdicts',
        rep.includes('File: IMG_0001.jpg') && rep.includes('/data/media/0/DCIM/Camera/IMG_0001.jpg') && rep.includes(sha(PHOTO)) &&
        rep.includes(md5(PHOTO)) && /Matches the dump\./.test(rep) && /Whole dump: matches/.test(rep));
    const rep2 = UI._mvReportText(stOk);
    ok('…and says plainly when the whole dump was not checked', /Whole dump: not checked/.test(rep2));
    const esc = UI._mediaVerifyHtml(Object.assign({}, stOk, { item: Object.assign({}, photo, { filename: '<img src=x onerror=alert(1)>.jpg' }) }));
    ok('a hostile file name is escaped', !esc.includes('<img src=x') && esc.includes('&lt;img src=x'));

    console.log('\n[the card]');
    const card = UI._renderMediaCard(Object.assign({ ext: 'jpg', category: 'Images' }, photo));
    ok('every media card carries a 🔍 check button', /data-cb-media-verify="m_IMG_0001\.jpg"/.test(card));
    // Click delegation: 🔍 opens the check, a plain click opens the picture.
    const opened = [];
    UI._openMediaVerify = (id) => opened.push('verify:' + id);
    UI._openMediaModal = (id) => opened.push('view:' + id);
    let handler = null;
    const pane = { addEventListener: (t, fn) => { handler = fn; } };
    UI._wireMediaGridEvents(pane);
    const cardEl = { dataset: { cbMediaId: 'm1' } };
    const btnEl = { getAttribute: () => 'm1' };
    const target = (hit) => ({ closest: (sel) => hit[sel] || null });
    let stopped = false;
    handler({ target: target({ '[data-cb-media-verify]': btnEl, '.cb-media-card': cardEl }), stopPropagation: () => { stopped = true; } });
    handler({ target: target({ '.cb-media-card': cardEl }), stopPropagation() {} });
    ok('🔍 opens the check (not the picture), a card click opens the picture', opened.join(',') === 'verify:m1,view:m1' && stopped, opened);

    console.log('\n[loading feedback]');
    ok('idle: no notice', UI._mediaLoadStatusText(0, 0) === '' && UI._mediaLoadStatusText(4, 4) === '');
    ok('before the first preview arrives it says the dump is opening', /^Opening the phone dump/.test(UI._mediaLoadStatusText(6, 0)));
    ok('then it counts', UI._mediaLoadStatusText(6, 2) === 'Loading previews from the phone dump… 2 of 6');
    const mlSmall = UI._mediaModalLoadingHtml(photo);
    ok('preview window: a spinner and "Reading this file out of the phone dump"', /cb-media-spinner/.test(mlSmall) && /Reading this file out of the phone dump/.test(mlSmall) && !/large/.test(mlSmall));
    const mlBig = UI._mediaModalLoadingHtml(Object.assign({}, photo, { type: 'video', size: 300 * 1024 * 1024 }));
    ok('a large video names its size and says it can take a while', /Reading this video/.test(mlBig) && /large video \(300/.test(mlBig) && /little while/.test(mlBig), mlBig);

    const mkEl = () => { const cls = new Set(); return { innerHTML: '', className: '', setAttribute() {}, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } }; };
    win.document = { createElement: mkEl };
    win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
    win.atob = (b) => Buffer.from(b, 'base64').toString('latin1');
    win.Blob = function () {};
    const pending = [];
    win.electronAPI = { cellebriteMediaRead: () => new Promise((res) => pending.push(res)) };
    const kids = [];
    const gridHost = { querySelector: (sel) => (sel === '[data-cb-media-status]' ? kids[0] || null : null), appendChild: (e) => kids.push(e) };
    UI._mediaState = { host: gridHost, items: [photo, Object.assign({}, photo, { id: 'm_2' })], imp: { id: 'cb_1' }, blobUrls: new Map(), visibleIds: new Set() };
    const wA = { innerHTML: '' }, wB = { innerHTML: '' };
    const pA = UI._loadMediaThumb(photo.id, wA);
    const pB = UI._loadMediaThumb('m_2', wB);
    ok('while a preview loads, its card shows a spinner', /cb-media-spinner/.test(wA.innerHTML) && /cb-media-spinner/.test(wB.innerHTML));
    const pill = kids[0];
    ok('…and the notice says the dump is opening', kids.length === 1 && pill.classList.contains('cb-on') && /Opening the phone dump/.test(pill.innerHTML), pill && pill.innerHTML);
    pending[0]({ success: true, buffer: PHOTO.toString('base64'), mime: 'image/jpeg' });
    await pA;
    ok('when one arrives its picture replaces the spinner', /<img src="blob:x"/.test(wA.innerHTML));
    ok('…and the notice counts "1 of 2"', /1 of 2/.test(pill.innerHTML) && pill.classList.contains('cb-on'), pill.innerHTML);
    pending[1]({ success: false, error: 'boom' });
    await pB;
    ok('a failed preview says so and still counts as finished', /load failed/.test(wB.innerHTML));
    await sleep(450);
    ok('when everything has settled the notice goes away', !pill.classList.contains('cb-on') && pill.innerHTML === '');
    const wC = { innerHTML: '' };
    const pC = UI._loadMediaThumb(photo.id, wC);
    UI._destroyMediaGrid();
    pending[2]({ success: true, buffer: PHOTO.toString('base64'), mime: 'image/jpeg' });
    const late = await pC.then(() => 'ok', (e) => String(e));
    ok('leaving the tab mid-load is harmless — nothing is painted into a dead grid', late === 'ok' && !/<img/.test(wC.innerHTML), late);
    delete win.electronAPI;

    console.log('\n[flagged media → evidence report]');
    const mwin = { console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    mwin.window = mwin;
    vm.createContext(mwin);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'cellebrite', 'cellebrite-module.js'), 'utf8'), mwin);
    const results = { m_a: Object.assign({ success: true }, rp), m_b: Object.assign({ success: true }, rx), m_c: Object.assign({ success: true }, rt) };
    const asked = [];
    mwin.electronAPI = { cellebriteMediaVerify: async (q) => { asked.push(q); return results[q.mediaId] || { success: false, error: 'media id not found' }; } };
    const CM = new mwin.CellebriteModule('c1', 'T-1', 'x');
    const mimp = { id: 'cb_1', flagged: { media: ['m_a', 'm_b', 'm_c'] } };
    CM.loadSurface = async (id, surf) => surf === 'media' ? { items: [{ id: 'm_a', filename: 'a.jpg' }, { id: 'm_b', filename: 'b.txt' }, { id: 'm_c', filename: 'c.jpg' }, { id: 'm_z', filename: 'z.jpg' }] } : null;
    const res = await CM._resolveFlagged(mimp);
    const byId = Object.fromEntries(res.media.map(r => [r.id, r]));
    ok('only flagged files are checked, by case number + import + id', asked.length === 3 && asked.every(q => q.caseNumber === 'T-1' && q.importId === 'cb_1'), asked);
    ok('a good file carries its SHA-256 and "Matches the phone dump"', byId.m_a.sha256 === sha(PHOTO) && /^Matches the phone dump/.test(byId.m_a.dumpCheck) && byId.m_a.dumpCheck.includes('FileSystem 01\\Phone.zip'), byId.m_a);
    ok('an altered file says "Does NOT match the phone dump"', /^Does NOT match the phone dump/.test(byId.m_b.dumpCheck), byId.m_b);
    ok('a thumbnail is called out in the report', /Android thumbnail/.test(byId.m_c.dumpCheck));
    const cfg = CM._buildSectionConfigs(mimp, res).find(c => c.id === 'media');
    ok('the evidence report has SHA-256 and dump-check columns', cfg.columns.some(c => c.field === 'sha256') && cfg.columns.some(c => c.field === 'dumpCheck'));
    delete mwin.electronAPI;
    const res2 = await CM._resolveFlagged(mimp);
    ok('without the desktop API: "Not checked", never a false match', res2.media.every(r => r.dumpCheck === 'Not checked' && r.sha256 === ''));
    ok('a missing dump is "Not checked", not a match', mwin.CellebriteModule._dumpCheckText(Object.assign({ success: true }, rz)) === 'Not checked (the phone dump was not on disk)');

    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
