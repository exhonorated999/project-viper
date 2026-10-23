/**
 * Evidence tab file viewer (main side) — modules/_shared/evidence-view.js,
 * plus the electron-main / preload wiring and the renderer's paging block
 * LIFTED from case-detail-with-analytics.html (// ── evidence-fv ──).
 *
 * Why: an officer filed a 5,993-file folder as Evidence. VIPER read every
 * file into the window (number[] over IPC + a Blob each) before showing
 * anything, then drew every photo full size — the window ran out of memory
 * while he scrolled, and files that failed fell back to blocked file:/// URLs
 * (the "some JPGs don't display").
 *
 * Run: node modules\_shared\__tests__\evidence-view.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..', '..');
const EV = require('../evidence-view');
const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const CD = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
async function ok(label, fn) {
    try { await fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + (e && e.message)); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-evview-'));
const put = (name, bytes) => { const p = path.join(TMP, name); fs.writeFileSync(p, bytes); return p; };
const JPEG_OK = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100, 7), Buffer.from([0xFF, 0xD9])]);
const JPEG_CUT = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100, 7)]);
const MAGIC = Buffer.from('VIPENC');
// Fake Field Security vault: "encrypts" by prefixing the magic.
function vault(unlocked) {
    return {
        isUnlocked: () => unlocked,
        isEncryptedBuffer: (b) => b.length >= 6 && b.subarray(0, 6).equals(MAGIC),
        decryptBuffer: (b) => b.subarray(6),
    };
}
// Fake nativeImage: decodes our synthetic JPEGs only.
function fakeNativeImage(log) {
    return {
        createFromBuffer(buf) {
            const good = buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 1] === 0xD9;
            const W = buf.length > 1000 ? 4000 : 3000, H = buf.length > 1000 ? 6000 : 2000;
            return {
                isEmpty: () => !good,
                getSize: () => ({ width: W, height: H }),
                resize(o) { log.push(o); return { toJPEG: (q) => Buffer.from('thumb-q' + q) }; },
                toJPEG: (q) => Buffer.from('full-q' + q),
            };
        },
    };
}

(async () => {
    console.log('evidence-view — sniff');
    await ok('real JPEG', () => assert.strictEqual(EV.sniff(JPEG_OK), 'jpeg'));
    await ok('JPEG with no end marker = cut off (partial download)', () => assert.strictEqual(EV.sniff(JPEG_CUT), 'jpeg-truncated'));
    await ok('JPEG with zero padding after FF D9 still whole', () => assert.strictEqual(EV.sniff(Buffer.concat([JPEG_OK, Buffer.alloc(50)])), 'jpeg'));
    await ok('all zero bytes = blank (unfinished torrent piece)', () => assert.strictEqual(EV.sniff(Buffer.alloc(5000)), 'zeros'));
    await ok('empty', () => assert.strictEqual(EV.sniff(Buffer.alloc(0)), 'empty'));
    await ok('HEIC renamed .jpg', () => assert.strictEqual(EV.sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20, 1)])), 'heic'));
    await ok('MP4 renamed .jpg', () => assert.strictEqual(EV.sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20, 1)])), 'mp4'));
    await ok('PNG / GIF / WebP / PDF / ZIP / TIFF', () => {
        assert.strictEqual(EV.sniff(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(10, 1)])), 'png');
        assert.strictEqual(EV.sniff(Buffer.from('GIF89a......')), 'gif');
        assert.strictEqual(EV.sniff(Buffer.from('RIFF\x01\x02\x03\x04WEBPVP8 ', 'latin1')), 'webp');
        assert.strictEqual(EV.sniff(Buffer.from('%PDF-1.7 ...')), 'pdf');
        assert.strictEqual(EV.sniff(Buffer.from('PK\x03\x04....', 'latin1')), 'zip');
        assert.strictEqual(EV.sniff(Buffer.from([0x49, 0x49, 0x2A, 0, 8, 0, 0, 0])), 'tiff');
    });
    await ok('random bytes = unknown', () => assert.strictEqual(EV.sniff(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), 'unknown'));

    console.log('evidence-view — checkPath');
    const jpg = put('a photo #1 %20.jpg', JPEG_OK);
    await ok('absolute path with #, % and spaces accepted', () => assert.ok(EV.checkPath(fs, jpg)));
    await ok('relative path refused', () => assert.strictEqual(EV.checkPath(fs, 'a.jpg'), null));
    await ok('non-preview extension refused (.exe / .txt)', () => {
        assert.strictEqual(EV.checkPath(fs, put('x.exe', 'MZ')), null);
        assert.strictEqual(EV.checkPath(fs, put('x.txt', 'hi')), null);
    });
    await ok('folder named .jpg refused', () => { const d = path.join(TMP, 'dir.jpg'); fs.mkdirSync(d); assert.strictEqual(EV.checkPath(fs, d), null); });
    await ok('missing file / NUL / non-string refused', () => {
        assert.strictEqual(EV.checkPath(fs, path.join(TMP, 'nope.jpg')), null);
        assert.strictEqual(EV.checkPath(fs, jpg + '\0.jpg'), null);
        assert.strictEqual(EV.checkPath(fs, { path: jpg }), null);
    });

    console.log('evidence-view — mediaUrl');
    const issued = [];
    const mk = (sec, nativeLog) => EV.createEvidenceView({
        fs, security: sec, nativeImage: fakeNativeImage(nativeLog || []),
        issueToken: (p) => { issued.push(p); return 'tok' + issued.length; },
    });
    await ok('plain image streams via viper-media (no bytes copied)', async () => {
        const r = await mk(vault(false)).mediaUrl({ filePath: jpg });
        assert.strictEqual(r.success, true); assert.ok(/^viper-media:\/\/m\/tok\d+$/.test(r.url), r.url);
        assert.strictEqual(r.bytes, undefined);
        assert.strictEqual(issued[issued.length - 1], path.resolve(jpg));
    });
    await ok('PDF / HTML come back as bytes (Blob preview, as before)', async () => {
        const r = await mk(null).mediaUrl({ filePath: put('r.pdf', '%PDF-1.4 x') });
        assert.strictEqual(r.success, true); assert.ok(Buffer.isBuffer(r.bytes)); assert.strictEqual(r.bytes.toString(), '%PDF-1.4 x');
        const h = await mk(null).mediaUrl({ filePath: put('p.html', '<p>x</p>') });
        assert.ok(h.bytes && h.bytes.toString() === '<p>x</p>');
    });
    const encJpg = put('enc.jpg', Buffer.concat([MAGIC, JPEG_OK]));
    await ok('encrypted + locked → locked, never the ciphertext', async () => {
        const r = await mk(vault(false)).mediaUrl({ filePath: encJpg });
        assert.strictEqual(r.success, false); assert.strictEqual(r.locked, true);
        assert.strictEqual(r.url, undefined); assert.strictEqual(r.bytes, undefined);
    });
    await ok('encrypted + unlocked → decrypted bytes (no plaintext temp file, no token)', async () => {
        const before = issued.length;
        const r = await mk(vault(true)).mediaUrl({ filePath: encJpg });
        assert.strictEqual(r.success, true); assert.ok(r.bytes.equals(JPEG_OK));
        assert.strictEqual(issued.length, before);
    });
    await ok('over 500 MB as bytes → tooLarge (stat faked)', async () => {
        const big = put('big.pdf', '%PDF');
        const fakeFs = Object.assign({}, fs, { statSync: (p) => { const s = fs.statSync(p); return { isFile: () => s.isFile(), size: 600 * 1024 * 1024 }; } });
        const v = EV.createEvidenceView({ fs: fakeFs, security: null, nativeImage: fakeNativeImage([]), issueToken: () => 't' });
        const r = await v.mediaUrl({ filePath: big });
        assert.strictEqual(r.success, false); assert.strictEqual(r.tooLarge, true);
    });
    await ok('refused path → plain error', async () => {
        const r = await mk(null).mediaUrl({ filePath: put('evil.bat', 'x') });
        assert.strictEqual(r.success, false); assert.ok(r.error);
    });

    console.log('evidence-view — thumb');
    await ok('landscape photo resized by width to 320, JPEG q72 data URL', async () => {
        const log = [];
        const r = await mk(null, log).thumb({ filePath: jpg });
        assert.strictEqual(r.success, true); assert.deepStrictEqual(log, [{ width: 320, quality: 'good' }]);
        assert.strictEqual(r.dataUrl, 'data:image/jpeg;base64,' + Buffer.from('thumb-q72').toString('base64'));
        assert.strictEqual(r.width, 3000); assert.strictEqual(r.height, 2000);
    });
    await ok('portrait photo resized by height; size clamped to 64..512', async () => {
        const log = [];
        const tall = put('tall.jpg', Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(2000, 3), Buffer.from([0xFF, 0xD9])]));
        await mk(null, log).thumb({ filePath: tall, size: 9999 });
        await mk(null, log).thumb({ filePath: tall, size: 1 });
        assert.deepStrictEqual(log, [{ height: 512, quality: 'good' }, { height: 64, quality: 'good' }]);
    });
    await ok('cut-off JPEG → undecodable + sniff jpeg-truncated', async () => {
        const r = await mk(null).thumb({ filePath: put('cut.jpg', JPEG_CUT) });
        assert.strictEqual(r.success, false); assert.strictEqual(r.reason, 'undecodable'); assert.strictEqual(r.sniff, 'jpeg-truncated');
    });
    await ok('blank (zero-filled) .jpg → sniff zeros', async () => {
        const r = await mk(null).thumb({ filePath: put('zero.jpg', Buffer.alloc(9000)) });
        assert.strictEqual(r.sniff, 'zeros');
    });
    await ok('0-byte .jpg → empty without reading', async () => {
        const r = await mk(null).thumb({ filePath: put('nil.jpg', Buffer.alloc(0)) });
        assert.strictEqual(r.reason, 'undecodable'); assert.strictEqual(r.sniff, 'empty');
    });
    await ok('encrypted thumb: locked → reason locked; unlocked → decoded', async () => {
        const a = await mk(vault(false)).thumb({ filePath: encJpg });
        assert.strictEqual(a.reason, 'locked');
        const b = await mk(vault(true)).thumb({ filePath: encJpg });
        assert.strictEqual(b.success, true);
    });
    await ok('video is not thumbnailed here', async () => {
        const r = await mk(null).thumb({ filePath: put('v.mp4', 'x') });
        assert.strictEqual(r.reason, 'not-image');
    });

    console.log('evidence-view — partial-download note (blank tail)');
    // BitTorrent pre-allocates: a picture with its last pieces missing ends in zeros.
    const PARTIAL = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(6000, 7), Buffer.alloc(8192)]);
    await ok('blankTail: zeros yes; whole JPEG / JPEG + trailer / tiny no', () => {
        assert.strictEqual(EV.blankTail(Buffer.alloc(4096)), true);
        assert.strictEqual(EV.blankTail(JPEG_OK), false);
        assert.strictEqual(EV.blankTail(Buffer.concat([Buffer.alloc(4000), Buffer.from('MotionPhoto_Data')])), false);
        assert.strictEqual(EV.blankTail(Buffer.alloc(10)), false);
        assert.strictEqual(EV.blankTail(null), false);
    });
    await ok('streamed photo with a blank tail → note blank-tail; whole photo → no note', async () => {
        const r = await mk(null).mediaUrl({ filePath: put('partial.jpg', PARTIAL) });
        assert.strictEqual(r.success, true); assert.ok(r.url); assert.strictEqual(r.note, 'blank-tail');
        const w = await mk(null).mediaUrl({ filePath: jpg });
        assert.strictEqual(w.note, undefined);
    });
    await ok('encrypted photo with a blank tail → note on the decrypted bytes', async () => {
        const r = await mk(vault(true)).mediaUrl({ filePath: put('encp.jpg', Buffer.concat([MAGIC, PARTIAL])) });
        assert.ok(r.bytes); assert.strictEqual(r.note, 'blank-tail');
    });
    await ok('a PDF ending in zeros gets no photo note', async () => {
        const r = await mk(null).mediaUrl({ filePath: put('z.pdf', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(8192)])) });
        assert.strictEqual(r.note, undefined);
    });
    await ok('thumb of a decodable partial photo carries the note', async () => {
        const lenient = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), resize: () => ({ toJPEG: () => Buffer.from('t') }), toJPEG: () => Buffer.from('t') }) };
        const v = EV.createEvidenceView({ fs, security: null, nativeImage: lenient, issueToken: () => 't' });
        const r = await v.thumb({ filePath: put('partial2.jpg', PARTIAL) });
        assert.strictEqual(r.success, true); assert.strictEqual(r.note, 'blank-tail');
        const w = await v.thumb({ filePath: jpg });
        assert.strictEqual(w.note, undefined);
    });

    console.log('electron-main / preload wiring');
    const rh = MAIN.slice(MAIN.indexOf("ipcMain.handle('read-evidence-file'"), MAIN.indexOf("ipcMain.handle('evidence-zip-list'"));
    await ok('read-evidence-file no longer builds a number[] (Array.from)', () => {
        assert.ok(rh.length > 100); assert.ok(!/Array\.from/.test(rh), 'Array.from still in read-evidence-file');
    });
    await ok('evidence-media-url + evidence-thumb registered and exposed', () => {
        assert.ok(/ipcMain\.handle\('evidence-media-url', \(event, args\) => _evidenceView\.mediaUrl\(args\)\)/.test(MAIN));
        assert.ok(/ipcMain\.handle\('evidence-thumb', \(event, args\) => _evidenceView\.thumb\(args\)\)/.test(MAIN));
        assert.ok(/evidenceMediaUrl: \(args\) => ipcRenderer\.invoke\('evidence-media-url', args\)/.test(PRELOAD));
        assert.ok(/evidenceThumb: \(args\) => ipcRenderer\.invoke\('evidence-thumb', args\)/.test(PRELOAD));
    });
    await ok('media tokens reuse by path in O(1) (reverse map)', () => {
        const a = MAIN.indexOf('function _datapilotIssueMediaToken(');
        const src = MAIN.slice(MAIN.indexOf('const datapilotMediaTokens = new Map();'), MAIN.indexOf('\n}\n', a) + 2);
        const sb = { crypto: require('crypto'), Date };
        vm.createContext(sb);
        vm.runInContext(src + '\nthis.issue=_datapilotIssueMediaToken;this.T=datapilotMediaTokens;', sb);
        const t1 = sb.issue('C:\\a.jpg'), t2 = sb.issue('C:\\a.jpg'), t3 = sb.issue('C:\\b.jpg');
        assert.strictEqual(t1, t2); assert.notStrictEqual(t1, t3); assert.strictEqual(sb.T.size, 2);
        sb.T.get(t1).expiresAt = 0;                        // expired → new token
        assert.notStrictEqual(sb.issue('C:\\a.jpg'), t1);
    });

    console.log('case-detail — no more read-everything-up-front');
    const vi = CD.slice(CD.indexOf('async function viewEvidenceInline('), CD.indexOf('async function openCellebriteExtractionInTab('));
    await ok('viewEvidenceInline does not read files or build file:/// URLs', () => {
        assert.ok(vi.length > 500);
        assert.ok(!/readEvidenceFile/.test(vi), 'still reads every file');
        assert.ok(!/file:\/\/\//.test(vi), 'still falls back to file:///');
        assert.ok(/_evFvTeardown\(\);/.test(vi) && /_evFvStart\(evidence\);/.test(vi) && /_evFvAfterRender\(\);/.test(vi));
    });
    const card = CD.slice(CD.indexOf('function _evFileCard('), CD.indexOf('// ─── Warrant Author (Multi-Business ESP Warrants)'));
    await ok('file cards never use a saved displayUrl / file path as src', () => {
        assert.ok(card.length > 500);
        assert.ok(!/displayUrl/.test(card) && !/fileUrl/.test(card));
        assert.ok(!/\$\{_S\}=/.test(card), 'card has a direct src= again');
    });

    // ── Renderer block, lifted ──
    const a = CD.indexOf('// ── evidence-fv (start) ──'), b = CD.indexOf('// ── evidence-fv (end) ──');
    const block = CD.slice(a, b);
    const sb = {
        _S: 'src', console,
        _evEsc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        formatFileSize: (n) => (n || 0) + ' B',
        _evZipIsCsam: (e) => !!(e && e.csamSensitive),
        _evFileCard: (ev, f, i) => '<CARD ' + i + '>',
        document: { getElementById: () => null },
    };
    vm.createContext(sb);
    vm.runInContext(block + '\nthis.X={_evFvPlan,_evFvKind,_evFvDirectUrl,_evFvStart,_evFvBodyHtml,_evFvToolbarHtml,_evFvPageCount,_evFvExplain,_evFvShort,_evFvSlotHtml,_evFvMediaHtml,get fv(){return _evFv;}};', sb);
    const X = sb.X;
    const folder = (n, ext) => Array.from({ length: n }, (_, i) => ({ name: 'IMG_' + i + '.' + (typeof ext === 'function' ? ext(i) : ext), path: 'D:\\Ev\\IMG_' + i, size: 1000 }));

    console.log('case-detail — paging (lifted evidence-fv block)');
    await ok('5,993 images → grid by default, 25 pages of 240 tiles', () => {
        X._evFvStart({ files: folder(5993, 'jpg') });
        assert.strictEqual(X.fv.mode, 'grid'); assert.strictEqual(X._evFvPageCount(), 25);
        const html = X._evFvBodyHtml();
        assert.strictEqual((html.match(/class="ev-fv-tile /g) || []).length, 240);
        assert.ok(/files 1–240 of 5,993/.test(html), 'pager range');
        assert.strictEqual((html.match(/data-ev-kind="thumb"/g) || []).length, 240);
        assert.ok(!/ src=/.test(html), 'tiles must not carry a src until on screen');
    });
    await ok('last page holds the remainder (5993 − 24×240 = 233)', () => {
        X.fv.page = 24;
        assert.strictEqual((X._evFvBodyHtml().match(/class="ev-fv-tile /g) || []).length, 233);
    });
    await ok('99 images → full-size list, 50 cards a page, 2 pages', () => {
        X._evFvStart({ files: folder(99, 'png') });
        assert.strictEqual(X.fv.mode, 'list'); assert.strictEqual(X._evFvPageCount(), 2);
        assert.strictEqual((X._evFvBodyHtml().match(/<CARD /g) || []).length, 50);
    });
    await ok('100 images → grid (threshold)', () => { X._evFvStart({ files: folder(100, 'jpg') }); assert.strictEqual(X.fv.mode, 'grid'); });
    await ok('small item (3 files): no toolbar, no pager — looks as it always did', () => {
        X._evFvStart({ files: folder(3, 'jpg') });
        assert.strictEqual(X._evFvToolbarHtml(), '');
        assert.ok(!/Page 1/.test(X._evFvBodyHtml()));
    });
    await ok('mixed folder: images AND videos get thumbnails (video frames via ffmpeg)', () => {
        X._evFvStart({ files: folder(300, (i) => i % 3 === 0 ? 'mp4' : 'jpg') });
        const html = X._evFvBodyHtml();
        assert.strictEqual((html.match(/data-ev-kind="thumb"/g) || []).length, 240);
        assert.strictEqual((html.match(/data-ev-kind="icon"/g) || []).length, 0);
        assert.ok(/100 videos/.test(X._evFvToolbarHtml()));
    });
    await ok('CSAM-sensitive evidence: thumbnails blurred, toolbar says so', () => {
        X._evFvStart({ files: folder(150, 'jpg'), csamSensitive: true });
        assert.strictEqual(X.fv.blur, true); assert.ok(/thumbnails blurred/.test(X._evFvToolbarHtml()));
    });
    await ok('kind: .ogg is video (as the old card treated it); .JPG case-insensitive', () => {
        assert.strictEqual(X._evFvKind({ name: 'a.ogg' }), 'video');
        assert.strictEqual(X._evFvKind({ name: 'A.JPG' }), 'image');
        assert.strictEqual(X._evFvKind({ name: 'a.docx' }), 'other');
    });
    await ok('direct URL only for http(s)/data — stale blob: and file paths go through main', () => {
        assert.strictEqual(X._evFvDirectUrl({ url: 'https://x/y.jpg' }), 'https://x/y.jpg');
        assert.strictEqual(X._evFvDirectUrl({ path: 'data:image/png;base64,AA' }), 'data:image/png;base64,AA');
        assert.strictEqual(X._evFvDirectUrl({ displayUrl: 'blob:abc', path: 'C:\\a.jpg' }), '');
        assert.strictEqual(X._evFvDirectUrl({ url: 'file:///C:/a.jpg' }), '');
    });
    await ok('local file → empty slot, no src (loads when on screen)', () => {
        const h = X._evFvSlotHtml('image', '', { name: 'a.jpg', path: 'C:\\a.jpg' }, 7);
        assert.ok(/class="ev-fv-media" data-ev-i="7" data-ev-kind="image"/.test(h)); assert.ok(!/src=/.test(h));
    });
    await ok('media markup: lazy decode, error hook, no guessed type= on <source>', () => {
        const img = X._evFvMediaHtml('image', 'viper-media://m/abc', { name: 'x".jpg' });
        assert.ok(/decoding="async"/.test(img) && /onerror="_evFvImgError\(this\)"/.test(img) && /alt="x&quot;\.jpg"/.test(img));
        const vid = X._evFvMediaHtml('video', 'viper-media://m/abc', { name: 'v.mov', type: 'video/quicktime' });
        assert.ok(/<source src="viper-media:\/\/m\/abc" onerror="_evFvVideoFail\(this\)">/.test(vid) && !/type=/.test(vid), vid);
    });
    await ok('explanations: blank / cut-off / HEIC / locked in plain English', () => {
        assert.ok(/never finished/.test(X._evFvExplain({ sniff: 'zeros' }, 'jpg')));
        assert.ok(/partial or interrupted download/.test(X._evFvExplain({ sniff: 'jpeg-truncated' }, 'jpg')));
        assert.ok(/HEIC/.test(X._evFvExplain({ sniff: 'heic' }, 'jpg')));
        assert.ok(/Field Security/.test(X._evFvExplain({ locked: true }, 'jpg')));
        assert.strictEqual(X._evFvShort({ sniff: 'jpeg-truncated' }), 'Cut-off JPEG');
        assert.strictEqual(X._evFvShort({ reason: 'error' }), 'No preview');
    });

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
