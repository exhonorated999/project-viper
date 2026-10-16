/**
 * End-to-end: synthetic Instagram return (folder AND zip) -> importer ->
 * on-disk store -> queries, checked against the generator's ground truth.
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\electron\dist\electron.exe modules\meta-warrant\__tests__\meta-import-ig.test.js
 *      (plain `node` works too — nothing native is loaded)
 *
 * Why: the old Meta module knew 12 Facebook categories, kept everything in
 * localStorage (quota crash on a 22-page Instagram return) and ignored
 * <video>/<audio> and preservation pages.  Scout submission #20.
 */
'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const IG = require('./fixtures/ig-fixture');
const { importReturn, isMetaReturn } = require('../meta-warrant-importer');
const Store = require('../meta-warrant-store');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-meta-ig-'));

async function zipFolder(dir, zipPath, prefix) {
    const JSZip = require('jszip');
    const z = new JSZip();
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(abs, r); else z.file((prefix || '') + r, fs.readFileSync(abs));
        }
    };
    walk(dir, '');
    fs.writeFileSync(zipPath, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function checkStore(label, r, truth, opts) {
    const P = (opts && opts.prefix) || '';
    const idx = Store.readIndex(r.dir);
    ok(!!idx, label + ': index written');
    eq(idx.service, 'Instagram', label + ': service');
    eq(r.meta.targetId, truth.target, label + ': target id from request parameters');
    eq(idx.categories.length, truth.categories, label + ': every category kept (incl. unknown + empty)');
    const cat = (id) => idx.categories.find(c => c.id === id);
    ok(!!cat('ai_conversations'), label + ': unknown category ai_conversations kept');
    for (const id of Object.keys(truth.items)) {
        const c = cat(id);
        ok(!!c, label + ': category ' + id + ' present');
        if (!c) continue;
        eq(c.count, truth.items[id].count, label + ': ' + id + ' count = union of all pages');
        eq(c.onlyPres, truth.items[id].onlyPres, label + ': ' + id + ' only-in-preservation count');
    }
    for (const id of truth.emptyCategories.slice(0, 3)) {
        const c = cat(id);
        eq(c && c.count, 0, label + ': ' + id + ' "No responsive records" is not a record');
        eq(c && c.emptyOn.length, idx.pages.length, label + ': ' + id + ' empty on every page');
    }
    eq(idx.pages.length, 4, label + ': 4 pages');
    eq(idx.pages[0].name.split('/').pop(), 'records.html', label + ': records first');
    eq(idx.pages[3].name.split('/').pop(), 'preservation-3.html', label + ': preservations in order');

    // threads
    eq(idx.threads.length, 2, label + ': 2 threads');
    for (const th of idx.threads) {
        const want = truth.threads[th.threadId];
        ok(!!want, label + ': thread id parsed ' + th.threadId);
        if (!want) continue;
        eq(th.count, want.count, label + ': thread ' + th.threadId.slice(-1) + ' message count (dups kept, overlaps merged)');
        eq(th.onlyPres, want.onlyPres, label + ': thread ' + th.threadId.slice(-1) + ' only-in-preservation');
        eq(th.participants.length, 2, label + ': thread participants');
    }
    const t1 = idx.threads.find(t => /1$/.test(t.threadId));
    const msgs = Store.query(r.dir, { kind: 'thread', thread: t1.key, limit: 500 }).rows;
    ok(msgs.every((m, i) => i === 0 || String(msgs[i - 1].sent) <= String(m.sent)), label + ': messages oldest first');
    ok(msgs.every(m => /\(Instagram: \d+\)/.test(m.author)), label + ': every message has an author');
    const ok2 = msgs.filter(m => m.body === 'ok');
    eq(ok2.length, 2, label + ': two identical messages both kept');
    ok(ok2.length === 2 && ok2[0].key !== ok2[1].key, label + ': identical messages get distinct keys');
    const m6 = msgs.find(m => m.body === 'message body 6');
    ok(m6 && JSON.stringify(m6.f).indexOf('4400016') > 0 && JSON.stringify(m6.f).indexOf('4400006') > 0, label + ': message with two media rows stays one message');

    // media
    const mm = Store.readMediaMap(r.dir);
    const files = new Set(Object.values(mm).map(e => e.file.toLowerCase()));
    eq(files.size, truth.mediaFiles, label + ': every linked_media file copied (incl. unreferenced)');
    eq(r.meta.totals.missingMedia, truth.missingMedia, label + ': missing media counted');
    const voice = mm[P + 'linked_media/unified_message_4400004.txt'];
    ok(voice && /\.txt\.ogg$/.test(voice.file), label + ': .txt voice note renamed to .ogg (' + (voice && voice.file) + ')');
    eq(voice && voice.kind, 'audio', label + ': voice note kind audio');
    eq(voice && voice.mime, 'audio/ogg', label + ': voice note mime');
    const png = mm[P + 'linked_media/unified_message_4400001.jpg'];
    eq(png && png.mime, 'image/png', label + ': PNG named .jpg sniffed');
    const vid = mm[P + 'linked_media/videos_1900000.mp4'];
    eq(vid && vid.kind, 'video', label + ': mp4 is video');
    eq(vid && vid.file, 'videos_1900000.mp4', label + ': correctly named file not renamed');
    const mp3 = mm[P + 'linked_media/unified_message_4400005.mp3'];
    eq(mp3 && mp3.kind, 'audio', label + ': mp3 is audio');
    for (const ref of Object.keys(mm)) {
        const p = Store.mediaPath(r.dir, ref);
        if (!p || !fs.existsSync(p.path)) { ok(false, label + ': media file on disk ' + ref); break; }
    }
    const enc = Object.values(mm).every(e => e.enc === !!opts.vault);
    ok(enc, label + ': enc flag = vault state');
    if (opts.vault) {
        const p = Store.mediaPath(r.dir, P + 'linked_media/photos_1800000.jpg').path;
        eq(fs.readFileSync(p).slice(0, 4).toString(), 'VENC', label + ': media encrypted at rest');
    } else {
        const p = Store.mediaPath(r.dir, P + 'linked_media/unified_message_4400004.txt').path;
        eq(fs.readFileSync(p).slice(0, 4).toString(), 'OggS', label + ': media bytes copied verbatim');
    }

    // media query
    const mq = Store.query(r.dir, { kind: 'media', mediaKind: 'audio', limit: 50 });
    eq(mq.total, 2, label + ': media query by kind (audio)');
    const pics = Store.query(r.dir, { kind: 'media', mediaKind: 'image', limit: 50 });
    ok(pics.rows.some(m => m.used > 0) && pics.rows.some(m => m.used === 0), label + ': media usage (used + orphan)');

    // IPs
    eq(idx.totals.ips, truth.ipRows, label + ': IP sightings from IP-keyed rows');
    const ipsum = Store.query(r.dir, { kind: 'ipSummary', limit: 500 });
    ok(ipsum.rows.some(x => /^2600:1700:abcd:/.test(x.ip)), label + ': IPv6 sighting kept');
    ok(ipsum.rows.some(x => x.ip === '203.0.113.9'), label + ': registration IP sighting');

    // items paging / filters
    const lk = Store.query(r.dir, { kind: 'items', cat: 'likes', offset: 0, limit: 7, sort: 'time-desc' });
    eq(lk.rows.length, Math.min(7, truth.items.likes.count), label + ': items page size');
    eq(lk.total, truth.items.likes.count, label + ': items total');
    ok(lk.rows.every((x, i) => i === 0 || x.t <= lk.rows[i - 1].t), label + ': time-desc sort');
    const op = Store.query(r.dir, { kind: 'items', cat: 'likes', onlyPres: true, limit: 500 });
    eq(op.total, truth.items.likes.onlyPres, label + ': only-in-preservation filter');
    const pg = Store.query(r.dir, { kind: 'items', cat: 'likes', page: 0, limit: 500 });
    eq(pg.total, truth.items.likes.count - truth.items.likes.onlyPres, label + ': per-page filter (records page)');

    // search + keys round trip
    const s = Store.query(r.dir, { kind: 'search', q: 'prompt 1' });
    ok(s.rows.length >= 1 && s.rows[0].cat === 'ai_conversations', label + ': search finds the unknown category');
    const s2 = Store.query(r.dir, { kind: 'search', q: 'second thread 2' });
    ok(s2.rows.some(h => h.type === 'message'), label + ': search finds messages');
    const keys = [];
    if (s.rows[0]) keys.push('c:' + s.rows[0].cat + ':' + s.rows[0].key);
    const mh = s2.rows.find(h => h.type === 'message');
    if (mh) keys.push('m:' + mh.thread + ':' + mh.key);
    keys.push('c:likes:nope.1');
    const kq = Store.query(r.dir, { kind: 'keys', keys });
    eq(kq.items.length, 1, label + ': keys -> item');
    eq(kq.messages.length, 1, label + ': keys -> message');
    eq(kq.missing.length, 1, label + ': keys -> missing reported');
    return idx;
}

(async () => {
    const src = path.join(tmp, 'ig-return');
    const gen = IG.writeReturn(src, { preservations: 3 });
    const truth = gen.truth;
    const vault = {
        isUnlocked: () => true,
        encryptBuffer: (b) => Buffer.concat([Buffer.from('VENC'), b]),
        isEncryptedBuffer: (b) => b.slice(0, 4).toString() === 'VENC',
        decryptBuffer: (b) => b.slice(4)
    };

    // 1. folder, vault off
    eq(await isMetaReturn(src, null), true, 'isMetaReturn(folder)');
    const caseA = path.join(tmp, 'caseA');
    const phases = [];
    const rA = await importReturn({ sourcePath: src, caseDir: caseA, storeKey: Store.storeKeyFor(src), meta: { fileName: 'ig-return' }, onProgress: p => phases.push(p.phase) });
    checkStore('folder', rA, truth, { vault: false });
    ok(['pages', 'merge', 'media', 'store', 'done'].every(p => phases.indexOf(p) >= 0), 'progress phases reported');
    eq(phases[phases.length - 1], 'done', 'progress ends with done');

    // Re-import of the same source keeps the same flag keys (flags survive).
    const keysBefore = Store.query(rA.dir, { kind: 'items', cat: 'likes', limit: 500 }).rows.map(x => x.key).join();
    const rA2 = await importReturn({ sourcePath: src, caseDir: caseA, storeKey: Store.storeKeyFor(src), meta: {} });
    eq(rA2.dir, rA.dir, 're-import replaces the same store');
    eq(Store.query(rA2.dir, { kind: 'items', cat: 'likes', limit: 500 }).rows.map(x => x.key).join(), keysBefore, 're-import: item keys stable');
    eq(fs.readdirSync(Store.returnsRoot(caseA)).length, 1, 're-import leaves no staging/old folders');

    // 2. zip (pages inside a sub-folder, the way Meta names its archive), vault on
    const zipPath = path.join(tmp, 'ig-return.zip');
    await zipFolder(src, zipPath, 'Instagram Return 2026/');
    eq(await isMetaReturn(zipPath, null), true, 'isMetaReturn(zip)');
    const caseB = path.join(tmp, 'caseB');
    const rB = await importReturn({ sourcePath: zipPath, caseDir: caseB, storeKey: Store.storeKeyFor(zipPath), security: vault, meta: {} });
    const idxB = checkStore('zip+vault', rB, truth, { vault: true, prefix: 'Instagram Return 2026/' });
    ok(Object.keys(Store.readMediaMap(rB.dir)).every(k => k.indexOf('Instagram Return 2026/linked_media/') === 0), 'zip: refs resolved relative to the page folder');
    eq(idxB.pages.length, 4, 'zip: same pages');

    // 3. a failed import keeps the previous store intact
    const broken = path.join(tmp, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'records.html'), '<html><body>not a meta page</body></html>');
    let threw = null;
    try { await importReturn({ sourcePath: broken, caseDir: caseA, storeKey: Store.storeKeyFor(src), meta: {} }); } catch (e) { threw = e; }
    ok(threw && /No Meta pages/.test(threw.message), 'non-Meta folder rejected with a clear message');
    ok(!!Store.readIndex(rA.dir), 'failed import kept the previous store');
    eq(fs.readdirSync(Store.returnsRoot(caseA)).length, 1, 'failed import left no staging folder');
    eq(await isMetaReturn(broken, null), false, 'isMetaReturn(non-Meta folder) = false');

    // 4. wrap:'none' — records told apart only by the first key coming back
    const srcN = path.join(tmp, 'ig-nowrap');
    const genN = IG.writeReturn(srcN, { preservations: 1, wrap: 'none' });
    const rN = await importReturn({ sourcePath: srcN, caseDir: path.join(tmp, 'caseN'), storeKey: 'nowrap', meta: {} });
    const idxN = Store.readIndex(rN.dir);
    eq(idxN.categories.find(c => c.id === 'following').count, genN.truth.items.following.count, 'no wrapper divs: following records still split correctly');
    const fo = Store.query(rN.dir, { kind: 'items', cat: 'following', limit: 1 }).rows[0];
    eq(fo && fo.f.map(f => f.k).join('|'), 'Id|Username|Time', 'no wrapper divs: one record = Id, Username, Time');

    Store.clearCache();
})().catch(e => { fail++; console.log('  FAIL: threw ' + (e && e.stack || e)); }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nmeta-import-ig: ${pass} passed, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
});
