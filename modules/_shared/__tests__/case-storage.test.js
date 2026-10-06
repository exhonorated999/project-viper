/*
 * case-storage.test.js
 *
 * Covers the storage safety net that fixes three field-reported bugs:
 *
 *   "I have spent all day adding pictures to my notes and wont let me save.
 *    Says not enough space"
 *
 *   "I have been unable to upload a consent on the consent searches tab...
 *    It looks like it saves but when you leave the tab and come back its gone"
 *
 * Both were localStorage quota exhaustion caused by base64 binary, and in the
 * consent case the failure was invisible because the throw happened inside an
 * async submit handler that nobody awaited.
 *
 * The tests below pin the three behaviours that make that impossible to
 * repeat: a save reports its own failure, images leave storage for disk, and
 * the round trip is lossless.
 */
'use strict';

const path = require('path');
const CS = require(path.join(__dirname, '..', 'case-storage.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
}
function section(name) { console.log('\n== ' + name + ' =='); }

// A localStorage stand-in with a byte ceiling, so quota can actually be hit
// rather than mocked with a thrown stub. Mirrors the browser: the quota
// counts keys AND values, at two bytes per UTF-16 code unit.
function makeStore(limitBytes) {
    const map = new Map();
    const size = () => {
        let t = 0;
        for (const [k, v] of map) t += (k.length + v.length) * 2;
        return t;
    };
    return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        removeItem(k) { map.delete(k); },
        setItem(k, v) {
            const prev = map.get(k);
            map.set(k, String(v));
            if (size() > limitBytes) {
                if (prev === undefined) map.delete(k); else map.set(k, prev);
                const err = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
                err.name = 'QuotaExceededError';
                err.code = 22;
                throw err;
            }
        },
        _size: size
    };
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URL = 'data:image/png;base64,' + PNG_1PX;

// ---------------------------------------------------------------------------
section('the module loads under BOTH module systems');
// The UMD trap: `module` IS defined in VIPER's renderer, so a wrapper that
// picks one branch leaves window.VpCaseStorage undefined and every host guard
// silently never fires. Assert the global assignment actually happened.
ok('exports via CommonJS', typeof CS === 'object' && typeof CS.setItemSafe === 'function');
ok('also assigns the global', globalThis.VpCaseStorage === CS);

// ---------------------------------------------------------------------------
section('quota errors are recognised, whatever shape they arrive in');
const domEx = new Error('exceeded the quota.'); domEx.name = 'QuotaExceededError';
const ffEx = new Error('persistent storage'); ffEx.name = 'NS_ERROR_DOM_QUOTA_REACHED';
const codeEx = new Error('nope'); codeEx.code = 22;
ok('Chromium DOMException name', CS.isQuotaError(domEx) === true);
ok('Firefox name', CS.isQuotaError(ffEx) === true);
ok('legacy numeric code 22', CS.isQuotaError(codeEx) === true);
ok('message-only fallback', CS.isQuotaError(new Error('Storage is full')) === true);
ok('an unrelated TypeError is not a quota error', CS.isQuotaError(new TypeError('x is not a function')) === false);
ok('null is not a quota error', CS.isQuotaError(null) === false);
ok('a plain Error is not a quota error', CS.isQuotaError(new Error('disk on fire')) === false);

// ---------------------------------------------------------------------------
section('setItemSafe never throws and never lies');
const small = makeStore(2000);
const good = CS.setItemSafe('k', 'hello', { store: small, label: 'the test record' });
ok('a write that fits reports ok', good.ok === true);
ok('and is actually in the store', small.getItem('k') === 'hello');
ok('ok result is not flagged as quota', good.quota === false);

const tiny = makeStore(40);                     // 20 UTF-16 chars total
let threw = false;
let bad;
try {
    bad = CS.setItemSafe('consentSearches_42', JSON.stringify({ big: 'x'.repeat(500) }),
        { store: tiny, label: 'the consent search' });
} catch (e) { threw = true; }
ok('an over-quota write does NOT throw', threw === false);
ok('it reports failure', bad && bad.ok === false);
ok('it identifies the cause as quota', bad && bad.quota === true);
ok('nothing was written', tiny.getItem('consentSearches_42') === null);
// The old bug was a silent failure. The message is the fix, so pin that it
// actually names the thing that did not save and says so plainly.
ok('the message names the record', /the consent search/.test(bad.message), bad.message);
ok('the message states nothing was saved', /nothing was saved/i.test(bad.message), bad.message);
ok('the message tells the officer what to do', /close and reopen/i.test(bad.message), bad.message);

// A pre-existing key must survive a failed overwrite rather than being
// clobbered to a half state.
const keep = makeStore(200);
keep.setItem('notes', 'original');
const over = CS.setItemSafe('notes', 'y'.repeat(400), { store: keep, label: 'this note' });
ok('a failed overwrite leaves the old value intact', keep.getItem('notes') === 'original');
ok('and still reports the failure', over.ok === false && over.quota === true);

// A non-quota error must be reported as such, not mislabelled.
const hostile = { length: 0, key: () => null, getItem: () => null, setItem() { throw new TypeError('boom'); } };
const other = CS.setItemSafe('k', 'v', { store: hostile, label: 'a thing' });
ok('a non-quota failure is reported', other.ok === false);
ok('and is NOT mislabelled as quota', other.quota === false);
ok('and surfaces the underlying message', /boom/.test(other.message), other.message);

// ---------------------------------------------------------------------------
section('usage accounting');
const u = makeStore(1e9);
u.setItem('ab', 'cd');                           // (2 + 2) * 2 = 8 bytes
ok('counts keys and values at 2 bytes per char', CS.usageBytes(u) === 8, CS.usageBytes(u));
ok('formatBytes B', CS.formatBytes(512) === '512 B');
ok('formatBytes KB', CS.formatBytes(2048) === '2 KB');
ok('formatBytes MB', CS.formatBytes(5 * 1048576) === '5.0 MB');

// ---------------------------------------------------------------------------
section('data URL parsing');
const parts = CS.splitDataUrl(PNG_URL);
ok('mime is extracted', parts && parts.mime === 'image/png');
ok('base64 payload is extracted', parts && parts.base64 === PNG_1PX);
ok('a plain http src is not a data URL', CS.splitDataUrl('https://x/y.png') === null);
ok('a non-base64 data URL is rejected', CS.splitDataUrl('data:text/plain,hello') === null);
ok('whitespace inside base64 is tolerated', CS.splitDataUrl('data:image/png;base64,AA  BB\nCC=') !== null);
ok('isImageDataUrl is true for an image', CS.isImageDataUrl(PNG_URL) === true);
ok('isImageDataUrl is false for a PDF', CS.isImageDataUrl('data:application/pdf;base64,AAAA') === false);
ok('isImageDataUrl tolerates undefined', CS.isImageDataUrl(undefined) === false);

ok('extension for png', CS.extForMime('image/png') === '.png');
ok('extension for jpeg', CS.extForMime('image/jpeg') === '.jpg');
ok('unknown mime falls back to .bin', CS.extForMime('application/x-weird') === '.bin');
ok('mime recovered from a file name', CS.mimeForFileName('shot.JPG') === 'image/jpeg');
ok('unknown extension yields no mime', CS.mimeForFileName('notes.docx') === '');

// base64Bytes must match a real decode, because it is what the UI reports as
// the file size and what the quota maths is based on.
for (const n of [0, 1, 2, 3, 10, 255, 1024]) {
    const b = Buffer.alloc(n, 7).toString('base64');
    if (CS.base64Bytes(b) !== n) { failed++; console.log('  FAIL base64Bytes(' + n + ') = ' + CS.base64Bytes(b)); }
    else passed++;
}
ok('base64Bytes of empty string is 0', CS.base64Bytes('') === 0);
ok('base64Bytes of a non-string is 0', CS.base64Bytes(null) === 0);

// ---------------------------------------------------------------------------
section('attribute read/write on an img tag');
const tag = '<img src="data:image/png;base64,AAA" style="max-width:100%" alt="x">';
ok('reads a double-quoted attr', CS.readAttr(tag, 'src') === 'data:image/png;base64,AAA');
ok('reads another attr', CS.readAttr(tag, 'alt') === 'x');
ok('missing attr reads null', CS.readAttr(tag, 'title') === null);
ok("reads a single-quoted attr", CS.readAttr("<img src='a.png'>", 'src') === 'a.png');
ok('reads a hyphenated attr', CS.readAttr('<img data-vp-img="f.png">', 'data-vp-img') === 'f.png');

const rewritten = CS.writeAttr(tag, 'src', 'blank');
ok('overwrites an existing attr', CS.readAttr(rewritten, 'src') === 'blank');
ok('does not disturb siblings', CS.readAttr(rewritten, 'alt') === 'x');
ok('preserves inline style', /max-width:100%/.test(rewritten));
const added = CS.writeAttr(tag, 'data-vp-img', 'shot.png');
ok('adds a missing attr', CS.readAttr(added, 'data-vp-img') === 'shot.png');
ok('added attr keeps the tag well formed', /^<img /.test(added) && added.endsWith('>'));

// ---------------------------------------------------------------------------
section('finding images in note HTML');
const NOTE = '<p>Scene photos:</p>'
    + '<img src="' + PNG_URL + '" style="max-width:100%">'
    + '<p>and the plate</p>'
    + '<img src="' + PNG_URL + '">'
    + '<img src="https://example.test/remote.png">';
ok('finds both inline images', CS.inlineImages(NOTE).length === 2);
ok('ignores the remote image', CS.inlineImages(NOTE).every(i => i.src.startsWith('data:')));
ok('hasInlineImages is true', CS.hasInlineImages(NOTE) === true);
ok('hasInlineImages is false for plain prose', CS.hasInlineImages('<p>no pictures here</p>') === false);
ok('hasInlineImages is false for a remote-only note',
    CS.hasInlineImages('<img src="https://example.test/a.png">') === false);
ok('hasInlineImages tolerates null', CS.hasInlineImages(null) === false);

// ---------------------------------------------------------------------------
section('dehydrate: images leave localStorage for disk');
(async () => {
    const written = [];
    const saveOk = (f) => { written.push(f); return 'saved-' + written.length + '.png'; };

    const d = await CS.dehydrateHtml(NOTE, saveOk, { kind: 'notes', stem: 'note-image' });
    ok('both images were moved', d.moved === 2, d);
    ok('nothing failed', d.failed === 0);
    ok('two files were handed to the writer', written.length === 2);
    ok('the writer got raw base64, not a data URL', written[0].base64 === PNG_1PX);
    ok('the writer got the mime', written[0].mime === 'image/png');
    ok('the generated name carries the right extension', /\.png$/.test(written[0].fileName));
    ok('generated names are unique', written[0].fileName !== written[1].fileName);

    // The whole point: the stored HTML must no longer carry the bytes.
    ok('no data: image bytes remain in the stored HTML', CS.hasInlineImages(d.html) === false, d.html);
    ok('the base64 payload is gone', d.html.indexOf(PNG_1PX) === -1);
    ok('two disk references were left behind', CS.diskImages(d.html).length === 2);
    ok('the reference records the file name', CS.diskImages(d.html)[0].fileName === 'saved-1.png');
    ok('the reference records the folder kind', CS.diskImages(d.html)[0].kind === 'notes');
    ok('the placeholder src is the blank pixel', CS.readAttr(CS.diskImages(d.html)[0].tag, 'src') === CS.BLANK_PIXEL);
    ok('surrounding prose is untouched', d.html.indexOf('<p>Scene photos:</p>') === 0);
    ok('the remote image is left exactly as it was', d.html.indexOf('https://example.test/remote.png') !== -1);
    ok('inline styles survive the rewrite', /max-width:100%/.test(d.html));
    ok('it reports the bytes it freed', d.bytesFreed > PNG_URL.length);

    // ---------------------------------------------------------------------------
    section('dehydrate: a failed write keeps the image rather than losing it');
    const d2 = await CS.dehydrateHtml(NOTE, () => null, {});
    ok('nothing claimed as moved', d2.moved === 0);
    ok('the failures are counted', d2.failed === 2, d2);
    ok('the image is STILL INLINE, not dropped', CS.inlineImages(d2.html).length === 2);
    ok('the original bytes are intact', d2.html.indexOf(PNG_1PX) !== -1);

    const d3 = await CS.dehydrateHtml(NOTE, () => { throw new Error('disk full'); }, {});
    ok('a throwing writer does not reject the whole pass', d3.failed === 2);
    ok('and the images survive', CS.inlineImages(d3.html).length === 2);

    // A note with one good and one bad write must keep the bad one inline and
    // still bank the good one. Partial progress is the common real case.
    let call = 0;
    const flaky = () => (++call === 1 ? 'first.png' : null);
    const d4 = await CS.dehydrateHtml(NOTE, flaky, {});
    ok('the successful image moved', d4.moved === 1, d4);
    ok('the failed image stayed', d4.failed === 1);
    ok('exactly one disk reference', CS.diskImages(d4.html).length === 1);
    ok('exactly one image still inline', CS.inlineImages(d4.html).length === 1);

    // ---------------------------------------------------------------------------
    section('dehydrate is idempotent (this is what keeps autosave from thrashing)');
    // Notes autosave on a timer. If a second dehydrate of already-dehydrated
    // HTML produced different output, the "identical content" no-op guard in
    // _noteWriteToMain would never match and every tick would rewrite the note
    // and mint a duplicate file on disk.
    const again = await CS.dehydrateHtml(d.html, () => { throw new Error('must not be called'); }, {});
    ok('a second pass writes no new files', again.moved === 0 && again.failed === 0, again);
    ok('and the HTML is byte-identical', again.html === d.html);

    // Same, but for HTML that has been hydrated for display and is then
    // committed again — the fat src must be stripped back out.
    const hydrated = await CS.hydrateHtml(d.html, () => PNG_URL);
    ok('hydrate restored both images for display', CS.inlineImages(hydrated).length === 2);
    ok('hydrate kept the disk references', CS.diskImages(hydrated).length === 2);
    const recommit = await CS.dehydrateHtml(hydrated, () => { throw new Error('must not be called'); }, {});
    ok('re-committing hydrated HTML writes no new files', recommit.moved === 0 && recommit.failed === 0);
    ok('and strips the bytes back out', CS.hasInlineImages(recommit.html) === false);
    ok('returning to exactly the stored form', recommit.html === d.html);

    // ---------------------------------------------------------------------------
    section('hydrate: display gets the real bytes back');
    const asked = [];
    const h = await CS.hydrateHtml(d.html, (req) => { asked.push(req); return PNG_URL; });
    ok('both references were resolved', asked.length === 2);
    ok('the reader was asked for a file name', asked[0].fileName === 'saved-1.png');
    ok('the reader was told which folder', asked[0].kind === 'notes');
    ok('the images are renderable again', CS.inlineImages(h).length === 2);
    ok('the bytes are back', h.indexOf(PNG_1PX) !== -1);
    ok('prose is still intact', h.indexOf('<p>and the plate</p>') !== -1);

    const hMiss = await CS.hydrateHtml(d.html, () => null);
    ok('an unreadable file leaves the placeholder', CS.readAttr(CS.diskImages(hMiss)[0].tag, 'src') === CS.BLANK_PIXEL);
    ok('and KEEPS the reference so a later load can retry', CS.diskImages(hMiss).length === 2);
    const hThrow = await CS.hydrateHtml(d.html, () => { throw new Error('locked vault'); });
    ok('a throwing reader does not reject the pass', CS.diskImages(hThrow).length === 2);
    ok('a locked vault still renders the note text', hThrow.indexOf('<p>Scene photos:</p>') === 0);

    ok('hydrate is a no-op on HTML with no references',
        (await CS.hydrateHtml('<p>plain</p>', () => PNG_URL)) === '<p>plain</p>');
    ok('hydrate tolerates null', (await CS.hydrateHtml(null, () => PNG_URL)) === null);
    ok('dehydrate tolerates null', (await CS.dehydrateHtml(null, () => 'x', {})).html === null);
    ok('dehydrate tolerates image-free HTML',
        (await CS.dehydrateHtml('<p>hi</p>', () => 'x', {})).moved === 0);

    // ---------------------------------------------------------------------------
    section('order is preserved across the round trip');
    // Three distinguishable images: if dehydrate/hydrate ever mismatched the
    // tag order against the results array, photos would silently swap places
    // between notes. That would be a quiet evidence-integrity problem, so it
    // gets its own assertion rather than riding on the count checks above.
    const mk = (n) => 'data:image/png;base64,' + Buffer.from('IMAGE' + n).toString('base64');
    const multi = '<p>a</p><img src="' + mk(1) + '"><p>b</p><img src="' + mk(2) + '"><p>c</p><img src="' + mk(3) + '">';
    const names = [];
    const dOrder = await CS.dehydrateHtml(multi, (f) => {
        const nm = 'f' + (names.length + 1) + '.png';
        names.push({ nm, base64: f.base64 });
        return nm;
    }, {});
    ok('three images moved', dOrder.moved === 3);
    ok('file 1 holds image 1', Buffer.from(names[0].base64, 'base64').toString() === 'IMAGE1');
    ok('file 2 holds image 2', Buffer.from(names[1].base64, 'base64').toString() === 'IMAGE2');
    ok('file 3 holds image 3', Buffer.from(names[2].base64, 'base64').toString() === 'IMAGE3');
    const refs = CS.diskImages(dOrder.html).map(r => r.fileName);
    ok('references appear in document order', refs.join(',') === 'f1.png,f2.png,f3.png', refs);

    const store = new Map(names.map(n => [n.nm, 'data:image/png;base64,' + n.base64]));
    const hOrder = await CS.hydrateHtml(dOrder.html, (r) => store.get(r.fileName));
    const back = CS.inlineImages(hOrder).map(i => Buffer.from(CS.splitDataUrl(i.src).base64, 'base64').toString());
    ok('hydration restores them in the same order', back.join(',') === 'IMAGE1,IMAGE2,IMAGE3', back);
    ok('the prose markers are still interleaved correctly',
        hOrder.indexOf('<p>a</p>') < hOrder.indexOf('<p>b</p>')
        && hOrder.indexOf('<p>b</p>') < hOrder.indexOf('<p>c</p>'));

    // ---------------------------------------------------------------------------
    section('the quota maths actually improves');
    // Prove the fix with numbers, not vibes: a note holding three 300KB
    // screenshots must drop below the point where it can exhaust the quota.
    const bigB64 = Buffer.alloc(300 * 1024, 9).toString('base64');
    const bigNote = '<p>notes</p>'
        + ['a', 'b', 'c'].map(() => '<img src="data:image/png;base64,' + bigB64 + '">').join('');
    const beforeBytes = bigNote.length * 2;
    let i = 0;
    const dBig = await CS.dehydrateHtml(bigNote, () => 'big-' + (++i) + '.png', {});
    const afterBytes = dBig.html.length * 2;
    ok('the note was over 2MB in storage before', beforeBytes > 2 * 1048576, CS.formatBytes(beforeBytes));
    ok('and is under 4KB after', afterBytes < 4096, CS.formatBytes(afterBytes));
    ok('a 5MB quota could not hold the old note', beforeBytes > 5 * 1048576 / 3);
    ok('all three moved', dBig.moved === 3);

    // And the same notes now fit in a store that previously rejected them.
    // Three notes rather than two on purpose: two comes to ~4.8MB, which
    // squeaks under a 5MB quota and would make this assertion a coin flip.
    const fatPayload = JSON.stringify([
        { contentHtml: bigNote }, { contentHtml: bigNote }, { contentHtml: bigNote }
    ]);
    const realistic = makeStore(5 * 1048576);
    ok('three such notes exceed 5MB in storage', fatPayload.length * 2 > 5 * 1048576,
        CS.formatBytes(fatPayload.length * 2));
    const beforeWrite = CS.setItemSafe('viperCaseNotes', fatPayload, { store: realistic, label: 'these notes' });
    ok('so the old inline form cannot be saved at all', beforeWrite.ok === false && beforeWrite.quota === true);
    const leanPayload = JSON.stringify([
        { contentHtml: dBig.html }, { contentHtml: dBig.html }, { contentHtml: dBig.html }
    ]);
    const afterWrite = CS.setItemSafe('viperCaseNotes', leanPayload, { store: realistic, label: 'these notes' });
    ok('the dehydrated form saves cleanly', afterWrite.ok === true, afterWrite);
    ok('and is over 1000x smaller', fatPayload.length / leanPayload.length > 1000,
        Math.round(fatPayload.length / leanPayload.length));

    // ---------------------------------------------------------------------------
    section('bufferToBase64 survives a large file');
    // The old consent handler did btoa(String.fromCharCode(...new
    // Uint8Array(buf))), which spreads every byte as a function argument and
    // is a RangeError past ~100KB. A real consent form is a multi-MB scan.
    globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let j = 0; j < big.length; j++) big[j] = j & 0xff;
    let spreadThrew = false;
    try { String.fromCharCode.apply(null, big); } catch (e) { spreadThrew = true; }
    ok('the old spread approach really does blow up on 3MB', spreadThrew === true);
    let chunked = null, chunkThrew = null;
    try { chunked = CS.bufferToBase64(big); } catch (e) { chunkThrew = e.message; }
    ok('the chunked encoder does not', chunkThrew === null, chunkThrew);
    ok('and round-trips byte for byte', Buffer.from(chunked, 'base64').equals(Buffer.from(big)));
    ok('a zero-length buffer encodes to empty', CS.bufferToBase64(new Uint8Array(0)) === '');

    // ---------------------------------------------------------------------------
    section('shrinkImageDataUrl degrades safely off-browser');
    // No canvas in Node: it must hand the original back rather than lose it.
    ok('returns the input unchanged without a DOM', (await CS.shrinkImageDataUrl(PNG_URL)) === PNG_URL);
    ok('passes a non-image straight through',
        (await CS.shrinkImageDataUrl('data:application/pdf;base64,AAAA')) === 'data:application/pdf;base64,AAAA');
    ok('passes a plain URL straight through',
        (await CS.shrinkImageDataUrl('https://x/y.png')) === 'https://x/y.png');
    ok('tolerates null', (await CS.shrinkImageDataUrl(null)) === null);

    // ---------------------------------------------------------------------------
    section('blankHydrated — the synchronous half, for the close/quit flush');
    // The flush path cannot await anything, but it must not write hydrated
    // bytes back into storage either. blankHydrated strips exactly the
    // images that already live on disk, and nothing else.
    const bhSaved = {};
    const bhDry = await CS.dehydrateHtml(
        '<p>a</p><img src="' + PNG_URL + '"><p>b</p>',
        (f) => { bhSaved[f.fileName] = f.base64; return f.fileName; },
        { kind: 'notes', stem: 'note-image' });
    const bhWet = await CS.hydrateHtml(bhDry.html, (r) => 'data:image/png;base64,' + bhSaved[r.fileName]);

    ok('hydrated HTML really does carry bytes again', CS.hasInlineImages(bhWet) === true);
    const bhBlank = CS.blankHydrated(bhWet);
    ok('blankHydrated is synchronous (returns a string, not a promise)', typeof bhBlank === 'string');
    ok('it removes the bytes', CS.hasInlineImages(bhBlank) === false);
    ok('it keeps the disk reference', CS.diskImages(bhBlank).length === 1);
    ok('it matches what dehydrate produced', bhBlank === bhDry.html, bhBlank);
    ok('it leaves surrounding markup alone', /<p>a<\/p>/.test(bhBlank) && /<p>b<\/p>/.test(bhBlank));
    ok('it is idempotent', CS.blankHydrated(bhBlank) === bhBlank);

    // An image the officer just pasted has no reference yet, so blanking it
    // would throw the picture away. It must be left exactly as it is and
    // picked up by the next real (async) save instead.
    const bhFresh = bhWet.replace('<p>b</p>', '<p>b</p><img src="' + PNG_URL + '">');
    const bhMixed = CS.blankHydrated(bhFresh);
    ok('a brand new paste is NOT blanked', bhMixed.indexOf(PNG_URL) !== -1);
    ok('while the on-disk one still is', CS.inlineImages(bhMixed).length === 1);
    ok('HTML with no references is returned untouched',
        CS.blankHydrated('<p>hello</p>') === '<p>hello</p>');
    ok('tolerates a non-string', CS.blankHydrated(null) === null);

    console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
