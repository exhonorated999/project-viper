/**
 * Scale-ingest test — the 2.36 GB / ~5.85M-message Discord return.
 *
 * The second reporting agency's return (VIPER Scout manifest 12) is 862 files
 * and 2,363,860,351 bytes, with ONE channel of roughly 2.4M messages in a
 * single 355 MB CSV.  5.1.7 sharded to JSON, but only after parsing the whole
 * return into memory — at 541,831 messages that was already 499 MB of heap.
 *
 * This test drives the REAL parser over a REAL on-disk fixture at a scale
 * that would have killed 5.1.7, with the real SQLite MessageWriter as the
 * sink, and asserts the two things that actually matter:
 *
 *   1. peak process memory stays flat — the whole point of streaming
 *   2. every row is still there, in order, readable a page at a time
 *
 * The fixture also nests the return under a wrapper directory, the way the
 * real one does (`<hexid>/messages/...`), so root-prefix detection is
 * exercised end to end rather than in isolation.
 *
 * Size is deliberately below the real return so this finishes in a couple of
 * minutes; the memory profile is what generalises, not the row count.
 * Override with DW_SCALE_ROWS.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\discord-warrant\__tests__\scale-ingest.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DiscordWarrantParser = require('../discord-warrant-parser');
const dwDb = require('../discord-warrant-db');
const dwStore = require('../discord-warrant-store');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (n, a, b) => ok(n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`),
                           JSON.stringify(a) === JSON.stringify(b));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ── Tunables ───────────────────────────────────────────────────────────
const BIG_ROWS = parseInt(process.env.DW_SCALE_ROWS || '1200000', 10);
const SMALL_CHANNELS = 11;
const SMALL_ROWS = 2000;
const TOTAL_ROWS = BIG_ROWS + SMALL_CHANNELS * SMALL_ROWS;

// Ceilings.  Measured, not guessed: 2,422,000 messages through the real
// parser costs ~127 MB of peak RSS delta and ~35 MB of peak V8 heap.  These
// are set at roughly 2.5x that, so they catch a regression back to
// "materialise the channel" without failing on GC or page-cache noise.
// (An earlier build set SQLite's page cache to 1 GB and measured 477 MB.)
const RSS_CEILING = 350 * 1048576;
const HEAP_CEILING = 150 * 1048576;
const IPC_CEILING = 2 * 1048576;

const NEEDLE = 'NEEDLEBRAVO';
const NEEDLE_ORD = Math.min(777777, BIG_ROWS - 3);

// ── Memory sampler ─────────────────────────────────────────────────────
let peakRss = 0, peakHeap = 0;
const sample = () => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
};
const baseline = process.memoryUsage().rss;

// ── Fixture ────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-scale-'));
// The real return wraps everything in one hex-named directory.
const WRAP = path.join(ROOT, 'return', 'a1b2c3d4e5f60718');
const CASEDIR = path.join(ROOT, 'case', 'Evidence', 'DiscordWarrant');
for (const d of ['messages/dms', 'messages/servers', 'servers', 'session']) {
    fs.mkdirSync(path.join(WRAP, d), { recursive: true });
}
fs.mkdirSync(CASEDIR, { recursive: true });

fs.writeFileSync(path.join(WRAP, 'session', 'file_1.txt'),
    ['User ID: 7001', 'Username: subject#0', 'Email: s@example.com',
     'Registration date (UTC): 2019-04-02 08:15:00'].join('\n'));
fs.writeFileSync(path.join(WRAP, 'servers', '900000000000000001.json'),
    JSON.stringify({
        id: '900000000000000001', name: 'Test Guild', owner_id: '7001',
        channels: { '800000000000000000': 'firehose' }, threads: {}
    }));

const BIG_CHAN = '800000000000000000';
const T0 = Date.UTC(2024, 0, 1) / 1000;

/** Write a headerless 8-column message CSV without ever holding it whole. */
function writeChannelCsv(file, chan, rows, needleAt) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        out.on('error', reject);
        out.on('close', resolve);
        let j = 0;
        const pump = () => {
            while (j < rows) {
                const self = j % 2 === 0;
                const body = (j === needleAt)
                    ? `planted ${NEEDLE} marker`
                    : `message body number ${j}`;
                const line = [
                    chan,
                    String(900000000000000000n + BigInt(j)),
                    self ? '7001' : '7002',
                    new Date((T0 + j * 7) * 1000).toISOString().replace('Z', '+00:00'),
                    self ? 'subject#0' : 'corr#0',
                    body,
                    '', ''
                ].join(',') + '\n';
                j++;
                if (!out.write(line)) { out.once('drain', pump); return; }
            }
            out.end();
        };
        pump();
    });
}

(async () => {
    console.log(`\nBuilding fixture: ${TOTAL_ROWS.toLocaleString()} messages across ${SMALL_CHANNELS + 1} channels…`);
    const genStart = Date.now();
    await writeChannelCsv(path.join(WRAP, 'messages', 'servers', BIG_CHAN + '.csv'),
                          BIG_CHAN, BIG_ROWS, NEEDLE_ORD);
    const smallIds = [];
    for (let c = 1; c <= SMALL_CHANNELS; c++) {
        const chan = String(800000000000000000n + BigInt(c));
        smallIds.push(chan);
        await writeChannelCsv(path.join(WRAP, 'messages', 'dms', chan + '.csv'),
                              chan, SMALL_ROWS, -1);
    }
    const bigBytes = fs.statSync(path.join(WRAP, 'messages', 'servers', BIG_CHAN + '.csv')).size;
    console.log(`  fixture built in ${((Date.now() - genStart) / 1000).toFixed(1)}s — biggest CSV ${mb(bigBytes)}`);

    // ── Parse with the SQLite sink, sampling memory throughout ─────────
    const storeKey = dwStore.storeKeyFor(path.join(ROOT, 'return'));
    const writer = new dwDb.MessageWriter(CASEDIR, storeKey);
    const timer = setInterval(sample, 25);
    sample();

    console.log('\nParsing…');
    const t0 = Date.now();
    const data = await new DiscordWarrantParser().parseFolder(
        path.join(ROOT, 'return'), { messageSink: writer });
    sample();
    const res = writer.finish({ source: 'scale-test' });
    sample();
    clearInterval(timer);
    const secs = (Date.now() - t0) / 1000;

    console.log(`  parsed + stored in ${secs.toFixed(1)}s (${Math.round(TOTAL_ROWS / secs).toLocaleString()} rows/s)`);
    console.log(`  db ${mb(res.dbBytes)}   peak rss ${mb(peakRss)} (baseline ${mb(baseline)}, delta ${mb(peakRss - baseline)})   peak heapUsed ${mb(peakHeap)}`);

    // ── 1. Memory stayed flat ──────────────────────────────────────────
    ok(`peak rss delta under ${mb(RSS_CEILING)} (was ${mb(peakRss - baseline)})`,
       (peakRss - baseline) < RSS_CEILING);
    ok(`peak heapUsed under ${mb(HEAP_CEILING)} (was ${mb(peakHeap)})`,
       peakHeap < HEAP_CEILING);

    // ── 2. Nothing heavy crosses the IPC boundary ──────────────────────
    const wire = JSON.stringify(data).length;
    console.log(`  IPC payload ${mb(wire)}`);
    ok(`IPC payload under ${mb(IPC_CEILING)} (was ${mb(wire)})`, wire < IPC_CEILING);
    ok('payload marked lazy', data._lazy === true);
    ok('every channel has empty inline messages',
       (data.channels || []).every(c => Array.isArray(c.messages) && c.messages.length === 0));
    ok('every channel marked sharded', (data.channels || []).every(c => c._sharded === true));

    // ── 3. The nested wrapper directory was seen ───────────────────────
    eq('channel count', (data.channels || []).length, SMALL_CHANNELS + 1);
    eq('total message count', data.stats && data.stats.messageCount, TOTAL_ROWS);
    const big = (data.channels || []).find(c => c.channelId === BIG_CHAN);
    ok('big channel found', !!big);
    eq('big channel count', big && big.messageCount, BIG_ROWS);
    eq('big channel named from the guild map', big && big.channelName, '#firehose');
    eq('subscriber read through the wrapper', data.subscriber && data.subscriber.username, 'subject#0');

    // ── 4. Store round-trips, a page at a time ─────────────────────────
    const info = dwDb.channelInfo(CASEDIR, storeKey, BIG_CHAN);
    ok('channelInfo present', !!info);
    eq('store count matches parse count', info && info.count, BIG_ROWS);
    ok('file order recognised as chronological', info && info.sortedAsc === true);

    const first = dwDb.readPage(CASEDIR, storeKey, BIG_CHAN, 0, 100);
    eq('first page size', first.messages.length, 100);
    eq('first page total', first.total, BIG_ROWS);
    eq('first row body', first.messages[0].contents, 'message body number 0');
    eq('first row author', first.messages[0].authorId, '7001');
    eq('second row is the correspondent', first.messages[1].authorId, '7002');

    const midOff = Math.floor(BIG_ROWS / 2);
    const mid = dwDb.readPage(CASEDIR, storeKey, BIG_CHAN, midOff, 50);
    eq('middle page first row', mid.messages[0].contents, `message body number ${midOff}`);
    eq('middle page last row', mid.messages[49].contents, `message body number ${midOff + 49}`);

    const lastOff = BIG_ROWS - 100;
    const tLast = Date.now();
    const last = dwDb.readPage(CASEDIR, storeKey, BIG_CHAN, lastOff, 100);
    const lastMs = Date.now() - tLast;
    eq('last page size', last.messages.length, 100);
    eq('last row body', last.messages[99].contents, `message body number ${BIG_ROWS - 1}`);
    ok(`last page is a seek not a scan (${lastMs}ms)`, lastMs < 250);

    const past = dwDb.readPage(CASEDIR, storeKey, BIG_CHAN, BIG_ROWS + 10, 100);
    eq('reading past the end is empty, not an error', past.messages.length, 0);

    // ── 5. Search runs against the store ───────────────────────────────
    const tS = Date.now();
    const hits = dwDb.searchChannel(CASEDIR, storeKey, BIG_CHAN, NEEDLE, 500);
    const searchMs = Date.now() - tS;
    console.log(`  search ${searchMs}ms`);
    eq('needle found exactly once', hits.matches.length, 1);
    eq('needle at the expected ordinal', hits.matches[0] && hits.matches[0].ord, NEEDLE_ORD);
    ok('search not truncated', hits.truncated === false);
    const jumpPage = Math.floor(NEEDLE_ORD / 100);
    const jump = dwDb.readPage(CASEDIR, storeKey, BIG_CHAN, jumpPage * 100, 100);
    ok('jump-to-page lands on the needle',
       jump.messages.some(m => String(m.contents).includes(NEEDLE)));

    // LIKE wildcards in evidence text are literal, not operators.
    const wild = dwDb.searchChannel(CASEDIR, storeKey, BIG_CHAN, '%', 10);
    eq('a bare % matches nothing', wild.matches.length, 0);

    // ── 6. Small channels still work the boring way ────────────────────
    const smallInfo = dwDb.channelInfo(CASEDIR, storeKey, smallIds[0]);
    eq('small channel count', smallInfo && smallInfo.count, SMALL_ROWS);
    const all = dwDb.readAll(CASEDIR, storeKey, smallIds[0]);
    eq('small channel reads whole', all.length, SMALL_ROWS);
    eq('small channel last row', all[SMALL_ROWS - 1].contents, `message body number ${SMALL_ROWS - 1}`);
    let threw = false;
    try { dwDb.readAll(CASEDIR, storeKey, BIG_CHAN); } catch (_) { threw = true; }
    ok('readAll refuses the big channel rather than exploding', threw);

    // ── 7. Peak memory did not creep during the read phase ─────────────
    sample();
    ok(`peak rss still under ceiling after all reads (${mb(peakRss - baseline)})`,
       (peakRss - baseline) < RSS_CEILING);

    // ── Cleanup ────────────────────────────────────────────────────────
    dwDb.deleteStore(CASEDIR, storeKey);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch(err => {
    console.error('HARNESS THREW:', err);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
});
