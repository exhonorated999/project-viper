/**
 * SQLite store test — replaces JSON shards for returns that exceed
 * V8's ~512 MB string cap on a single channel.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\discord-warrant\__tests__\warrant-db.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dwDb = require('../discord-warrant-db');
const dwStore = require('../discord-warrant-store');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (n, a, b) => ok(n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`),
                           JSON.stringify(a) === JSON.stringify(b));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-db-'));
const BASE = path.join(ROOT, 'case', 'Evidence', 'DiscordWarrant');
fs.mkdirSync(BASE, { recursive: true });

function makeMsg(ord, overrides = {}) {
    const id = String(900000000000000000n + BigInt(ord));
    const ts = new Date(Date.UTC(2026, 0, 1) + ord * 41000).toISOString();
    return {
        id,
        timestamp: ts,
        rawTimestamp: ts,
        contents: `message ${ord}`,
        attachments: '',
        authorId: ord % 2 === 0 ? '7001' : '7002',
        username: ord % 2 === 0 ? 'subject#0' : 'corr#0',
        direction: ord % 2 === 0 ? 'outgoing' : 'incoming',
        ...overrides
    };
}

(async () => {
    // ── 1. Round-trip: three channels of varying sizes ─────────────────
    console.log('\n=== 1. Round-trip three channels ===');
    const w1 = new dwDb.MessageWriter(BASE, 'store-a');
    const ch1 = 'ch-100', ch2 = 'ch-200', ch3 = 'ch-300';

    w1.beginChannel(ch1);
    for (let i = 0; i < 5; i++) w1.write(makeMsg(i, { contents: `ch1-msg-${i}` }));
    const e1 = w1.endChannel();
    eq('ch1 count', e1.count, 5);
    ok('ch1 sortedAsc', e1.sortedAsc);

    w1.beginChannel(ch2);
    for (let i = 0; i < 500; i++) w1.write(makeMsg(i, { contents: `ch2-msg-${i}` }));
    const e2 = w1.endChannel();
    eq('ch2 count', e2.count, 500);

    w1.beginChannel(ch3);
    for (let i = 0; i < 3; i++) w1.write(makeMsg(i, { contents: `ch3-msg-${i}` }));
    const e3 = w1.endChannel();
    eq('ch3 count', e3.count, 3);

    const fin1 = w1.finish({ source: 'test' });
    ok('finish returns messageCount', fin1.messageCount === 508);
    ok('finish returns channelCount', fin1.channelCount === 3);
    ok('db file exists', fs.existsSync(dwDb.dbPath(BASE, 'store-a')));
    console.log(`     db size: ${mb(fin1.dbBytes)}`);

    const info1 = dwDb.storeInfo(BASE, 'store-a');
    ok('storeInfo complete', info1.complete);
    eq('storeInfo version', info1.version, '1');
    eq('storeInfo messageCount', info1.messageCount, 508);
    eq('storeInfo channelCount', info1.channelCount, 3);

    // ── 2. readPage slicing and ordering ───────────────────────────────
    console.log('\n=== 2. readPage slicing ===');
    const p0 = dwDb.readPage(BASE, 'store-a', ch2, 0, 10);
    eq('page 0 length', p0.messages.length, 10);
    eq('page 0 total', p0.total, 500);
    eq('page 0 offset', p0.offset, 0);
    eq('page 0 limit', p0.limit, 10);
    eq('first message contents', p0.messages[0].contents, 'ch2-msg-0');
    eq('last message contents', p0.messages[9].contents, 'ch2-msg-9');

    const p1 = dwDb.readPage(BASE, 'store-a', ch2, 495, 10);
    eq('page near end length', p1.messages.length, 5);
    eq('page near end first', p1.messages[0].contents, 'ch2-msg-495');

    const pOver = dwDb.readPage(BASE, 'store-a', ch2, 600, 10);
    eq('over-offset empty', pOver.messages.length, 0);
    eq('over-offset total', pOver.total, 500);

    const pNeg = dwDb.readPage(BASE, 'store-a', ch2, -5, 10);
    eq('negative offset empty', pNeg.messages.length, 0);

    // ── 3. Media round-trip ────────────────────────────────────────────
    console.log('\n=== 3. Media round-trip ===');
    const wMedia = new dwDb.MessageWriter(BASE, 'store-media');
    wMedia.beginChannel('media-ch');
    wMedia.write(makeMsg(0, { media: [{ diskPath: '/a.png', size: 1234, mimeType: 'image/png', fileName: 'a.png', attachmentId: 'att1' }] }));
    wMedia.write(makeMsg(1)); // no media
    wMedia.write(makeMsg(2, { media: [] })); // empty array — should still be absent
    wMedia.endChannel();
    wMedia.finish({});

    const pm = dwDb.readPage(BASE, 'store-media', 'media-ch', 0, 10);
    ok('msg0 has media', Array.isArray(pm.messages[0].media) && pm.messages[0].media.length === 1);
    ok('msg1 has no media key', !('media' in pm.messages[1]));
    ok('msg2 has no media key (empty array stored as absent)', !('media' in pm.messages[2]));

    // ── 4. Unsorted channel ──────────────────────────────────────────────
    console.log('\n=== 4. Unsorted channel ===');
    const wUn = new dwDb.MessageWriter(BASE, 'store-unsorted');
    wUn.beginChannel('unsorted-ch');
    const tsBase = Date.UTC(2026, 0, 1);
    wUn.write(makeMsg(0, { timestamp: new Date(tsBase + 2000).toISOString() }));
    wUn.write(makeMsg(1, { timestamp: new Date(tsBase + 1000).toISOString() }));
    wUn.write(makeMsg(2, { timestamp: new Date(tsBase + 3000).toISOString() }));
    wUn.endChannel();
    wUn.finish({});

    const ci = dwDb.channelInfo(BASE, 'store-unsorted', 'unsorted-ch');
    ok('unsorted channelInfo sortedAsc is false', ci && ci.sortedAsc === false);

    const pu = dwDb.readPage(BASE, 'store-unsorted', 'unsorted-ch', 0, 10);
    eq('unsorted readPage chronological first', pu.messages[0].timestamp, new Date(tsBase + 1000).toISOString());
    eq('unsorted readPage chronological second', pu.messages[1].timestamp, new Date(tsBase + 2000).toISOString());
    eq('unsorted readPage chronological third', pu.messages[2].timestamp, new Date(tsBase + 3000).toISOString());

    // ── 5. searchChannel ───────────────────────────────────────────────
    console.log('\n=== 5. searchChannel ===');
    const wSearch = new dwDb.MessageWriter(BASE, 'store-search');
    wSearch.beginChannel('search-ch');
    for (let i = 0; i < 1000; i++) {
        wSearch.write(makeMsg(i, { contents: `needle-${i % 10 === 0 ? 'TARGET' : 'other'}-${i}` }));
    }
    wSearch.endChannel();
    wSearch.finish({});

    const sr = dwDb.searchChannel(BASE, 'store-search', 'search-ch', 'TARGET', 50);
    ok('search finds matches', sr.matches.length > 0);
    ok('search matches contain needle', sr.matches.every(m => m.contents.includes('TARGET')));
    ok('search truncated true (100 matches > cap 50)', sr.truncated);
    eq('search scanned', sr.scanned, 1000);

    const srCap = dwDb.searchChannel(BASE, 'store-search', 'search-ch', 'needle', 5);
    ok('search cap respected', srCap.matches.length === 5);
    ok('search truncated true', srCap.truncated);

    // Verify ord -> readPage round-trip
    const firstMatch = srCap.matches[0];
    const containingPage = dwDb.readPage(BASE, 'store-search', 'search-ch', firstMatch.ord, 1);
    eq('ord points to containing page', containingPage.messages[0].id, firstMatch.id);

    // ── 6. Missing / incomplete DB safety ─────────────────────────────────
    console.log('\n=== 6. Missing / incomplete DB safety ===');
    const missingPage = dwDb.readPage(BASE, 'store-missing', 'x', 0, 10);
    ok('missing db readPage empty', missingPage.messages.length === 0);
    ok('missing db readPage total 0', missingPage.total === 0);

    const missingSearch = dwDb.searchChannel(BASE, 'store-missing', 'x', 'q', 10);
    ok('missing db search empty', missingSearch.matches.length === 0);

    const missingFind = dwDb.findMessage(BASE, 'store-missing', 'x', '1');
    ok('missing db findMessage null', missingFind === null);

    // Incomplete: begin but never finish
    const wInc = new dwDb.MessageWriter(BASE, 'store-incomplete');
    wInc.beginChannel('inc');
    wInc.write(makeMsg(0));
    wInc.endChannel();
    // do NOT call finish — db exists but complete !== '1'
    wInc.db.close();
    wInc.db = null;

    const incPage = dwDb.readPage(BASE, 'store-incomplete', 'inc', 0, 10);
    ok('incomplete db readPage empty', incPage.messages.length === 0);
    ok('incomplete db readPage total 0', incPage.total === 0);

    const incInfo = dwDb.storeInfo(BASE, 'store-incomplete');
    ok('incomplete db storeInfo exists', incInfo.exists);
    ok('incomplete db storeInfo not complete', !incInfo.complete);

    // ── 7. abort() cleanup ─────────────────────────────────────────────
    console.log('\n=== 7. abort() cleanup ===');
    const wAbort = new dwDb.MessageWriter(BASE, 'store-abort');
    wAbort.beginChannel('a');
    wAbort.write(makeMsg(0));
    wAbort.endChannel();
    wAbort.abort();

    const dirAbort = path.join(BASE, 'store', 'store-abort');
    ok('abort removes db', !fs.existsSync(path.join(dirAbort, 'messages.db')));
    ok('abort removes wal', !fs.existsSync(path.join(dirAbort, 'messages.db-wal')));
    ok('abort removes shm', !fs.existsSync(path.join(dirAbort, 'messages.db-shm')));

    // ── 8. One bad row does not abort import ───────────────────────────
    console.log('\n=== 8. Bad-row resilience ===');
    const wBad = new dwDb.MessageWriter(BASE, 'store-bad');
    wBad.beginChannel('bad-ch');
    wBad.write(makeMsg(0));
    // Pass something pathological: a circular reference in media so JSON.stringify throws
    const badMsg = makeMsg(1);
    badMsg.media = [{ fileName: 'a.png' }];
    badMsg.media[0].self = badMsg.media[0]; // circular
    wBad.write(badMsg);
    wBad.write(makeMsg(2));
    wBad.endChannel();
    const finBad = wBad.finish({});
    ok('bad-row import completes', finBad.messageCount >= 2);
    ok('bad row recorded in errors', wBad.errors.length >= 1);
    ok('errors capped', wBad.errors.length <= 50);

    // ── 9. deleteStore after read (Windows lock) ───────────────────────
    console.log('\n=== 9. deleteStore after read ===');
    const wDel = new dwDb.MessageWriter(BASE, 'store-del');
    wDel.beginChannel('del-ch');
    wDel.write(makeMsg(0));
    wDel.endChannel();
    wDel.finish({});

    // Force a read to open the cached handle
    const _ = dwDb.readPage(BASE, 'store-del', 'del-ch', 0, 10);
    ok('pre-delete read works', _.messages.length === 1);

    const delOk = dwDb.deleteStore(BASE, 'store-del');
    ok('deleteStore succeeds immediately after read', delOk);
    ok('deleteStore removed db', !fs.existsSync(dwDb.dbPath(BASE, 'store-del')));

    // ── 10. migrateLegacyShards ────────────────────────────────────────
    console.log('\n=== 10. migrateLegacyShards ===');
    const LEGACY = path.join(BASE, 'store', 'legacystore');
    fs.mkdirSync(LEGACY, { recursive: true });
    const legacyMsgs = [
        makeMsg(0, { contents: 'legacy-0' }),
        makeMsg(1, { contents: 'legacy-1' })
    ];
    fs.writeFileSync(path.join(LEGACY, 'ch-oldchannel.json'), JSON.stringify(legacyMsgs));
    fs.writeFileSync(path.join(LEGACY, 'imports.json'), JSON.stringify({ imports: [] }));

    const mig1 = dwDb.migrateLegacyShards(BASE, 'legacystore');
    ok('migrate returns migrated true', mig1.migrated);
    eq('migrate channels', mig1.channels, 1);
    eq('migrate messages', mig1.messages, 2);

    const migPage = dwDb.readPage(BASE, 'legacystore', 'oldchannel', 0, 10);
    eq('migrated data readable', migPage.messages.length, 2);
    eq('migrated content preserved', migPage.messages[0].contents, 'legacy-0');
    ok('legacy json files removed', !fs.existsSync(path.join(LEGACY, 'ch-oldchannel.json')));
    ok('imports.json left alone', fs.existsSync(path.join(LEGACY, 'imports.json')));

    // Idempotency: second call does nothing
    const mig2 = dwDb.migrateLegacyShards(BASE, 'legacystore');
    ok('second migrate is idempotent', !mig2.migrated);

    // Leave legacy files in place if DB already exists
    const LEGACY2 = path.join(BASE, 'store', 'legacystore2');
    fs.mkdirSync(LEGACY2, { recursive: true });
    fs.writeFileSync(path.join(LEGACY2, 'ch-keep.json'), JSON.stringify([makeMsg(0)]));
    // Pre-create the DB
    const wPre = new dwDb.MessageWriter(BASE, 'legacystore2');
    wPre.beginChannel('x'); wPre.write(makeMsg(0)); wPre.endChannel(); wPre.finish({});
    const mig3 = dwDb.migrateLegacyShards(BASE, 'legacystore2');
    ok('migrate skips when db exists', !mig3.migrated);
    ok('legacy files kept when db exists', fs.existsSync(path.join(LEGACY2, 'ch-keep.json')));

    // ── 11. Scale: 1.2 M messages in one channel ───────────────────────
    console.log('\n=== 11. Scale: 1.2 M messages in one channel ===');
    const SCALE_KEY = 'scale-store';
    const SCALE_CH = 'scale-ch';
    const SCALE_COUNT = 1_200_000;

    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore;
    const heapCheckInterval = setInterval(() => {
        const h = process.memoryUsage().heapUsed;
        if (h > peakHeap) peakHeap = h;
    }, 100);

    const t0 = Date.now();
    const wScale = new dwDb.MessageWriter(BASE, SCALE_KEY);
    wScale.beginChannel(SCALE_CH);
    for (let i = 0; i < SCALE_COUNT; i++) {
        wScale.write(makeMsg(i, {
            contents: `scale-msg-${i}`,
            timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
        }));
    }
    wScale.endChannel();
    const finScale = wScale.finish({ source: 'scale-test' });
    const importMs = Date.now() - t0;
    clearInterval(heapCheckInterval);

    console.log(`     import time: ${(importMs / 1000).toFixed(2)} s`);
    console.log(`     db size: ${mb(finScale.dbBytes)}`);
    console.log(`     peak heap: ${mb(peakHeap)}`);

    eq('scale messageCount', finScale.messageCount, SCALE_COUNT);
    eq('scale channelCount', finScale.channelCount, 1);
    ok('scale import under 60 s', importMs < 60000);
    ok('scale peak heap under 300 MB', peakHeap < 300 * 1048576);

    const tRead = Date.now();
    const lastPage = dwDb.readPage(BASE, SCALE_KEY, SCALE_CH, 1_199_950, 50);
    const readMs = Date.now() - tRead;
    console.log(`     last-page read latency: ${readMs} ms`);

    eq('lastPage length', lastPage.messages.length, 50);
    eq('lastPage first id', lastPage.messages[0].id, String(900000000000000000n + 1199950n));
    eq('lastPage last id', lastPage.messages[49].id, String(900000000000000000n + 1199999n));
    ok('last-page read under 1 s', readMs < 1000);

    // Verify search still works at scale
    const tSearch = Date.now();
    const scaleSearch = dwDb.searchChannel(BASE, SCALE_KEY, SCALE_CH, 'scale-msg-1199999', 10);
    const searchMs = Date.now() - tSearch;
    console.log(`     search latency: ${searchMs} ms`);
    ok('scale search finds exact match', scaleSearch.matches.length === 1);
    eq('scale search ord', scaleSearch.matches[0].ord, 1199999);

    // ── Cleanup ──────────────────────────────────────────────────────────
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS THREW: ' + e.stack); process.exit(1); });
