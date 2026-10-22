/**
 * Google Warrant — very large returns (the "VIPER exits completely" report).
 *
 *   node modules/google-warrant/__tests__/google-warrant-large.test.js
 *
 * better-sqlite3 is built for Electron's ABI, so under plain node this file
 * re-runs itself with ELECTRON_RUN_AS_NODE=1.
 *
 * Fixtures are synthetic, built here with adm-zip.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ── run under Electron-as-Node when better-sqlite3 needs it ──
try {
    const D = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    new D(':memory:').close();
} catch (e) {
    if (!process.versions.electron) {
        const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
        const r = cp.spawnSync(exe, [__filename], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: 'inherit' });
        process.exit(r.status == null ? 2 : r.status);
    }
    throw e;
}

const AdmZip = require('adm-zip');
const GoogleWarrantParser = require(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-parser.js'));
const gwStore = require(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-store.js'));
const zipReaderMod = require(path.join(ROOT, 'modules', '_shared', 'zip-reader.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-large-'));

// ── fixture builders ──
const ACCT = 'suspect@example.com.518160276335';
function mboxMessage(i, opts = {}) {
    const eol = opts.crlf ? '\r\n' : '\n';
    const mm = String(i % 60).padStart(2, '0');
    const hh = String(Math.floor(i / 60) % 24).padStart(2, '0');
    const head = [
        `From 1712345678901234567@xxx Mon Jan 01 00:00:00 +0000 2024`,
        `X-GM-THRID: 17000000000${i}`,
        `X-Gmail-Labels: Inbox,Important`,
        opts.noId ? null : `Message-ID: <msg${i}@example.com>`,
        `Date: Mon, 01 Jan 2024 ${hh}:${mm}:00 +0000`,
        `From: Alice ${i} <alice${i}@example.com>`,
        `To: bob@example.com`,
        `Subject: ${opts.subject || 'Test message ' + i}`,
    ].filter(Boolean);
    let body;
    if (opts.html) {
        head.push('MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="BOUND"');
        body = ['', '--BOUND', 'Content-Type: text/plain; charset=utf-8', '', `plain ${i}`, '--BOUND', 'Content-Type: text/html; charset=utf-8', '', `<p>html <b>${i}</b></p>`, '--BOUND--', ''].join(eol);
    } else {
        head.push('Content-Type: text/plain; charset=utf-8');
        const filler = opts.bodyBytes ? 'x'.repeat(76) + eol : '';
        const reps = opts.bodyBytes ? Math.ceil(opts.bodyBytes / 78) : 0;
        body = eol + `Body of message ${i} with {braces} and "quotes".` + eol +
            `>From here on this line was escaped by the mbox writer.` + eol +
            `A line that mentions From somebody mid-line.` + eol + filler.repeat(reps) + `END ${i}` + eol;
    }
    return head.join(eol) + eol + body;
}
function buildMbox(n, opts = {}) {
    const parts = [];
    for (let i = 1; i <= n; i++) parts.push(mboxMessage(i, Object.assign({}, opts, { noId: i === 3 && !opts.allIds, html: i === 5 })));
    return Buffer.from(parts.join(opts.crlf ? '\r\n' : '\n'), 'utf-8');
}
function buildRecords(n) {
    const locs = [];
    for (let i = 0; i < n; i++) {
        locs.push({
            latitudeE7: 400000000 + i, longitudeE7: -1170000000 - i,
            accuracy: 10 + (i % 5), timestamp: new Date(Date.UTC(2024, 0, 1) + i * 60000).toISOString(),
            source: i % 2 ? 'WIFI' : 'GPS', deviceTag: 12345,
            activity: i % 3 === 0 ? [{ activity: [{ type: 'STILL', confidence: 90 }], timestamp: 'x' }] : undefined,
            note: i === 7 ? 'tricky } { [ ] \\" café 😀' : undefined,
        });
    }
    return Buffer.from(JSON.stringify({ locations: locs }, null, 1), 'utf-8');
}
function innerZip(files) {
    const z = new AdmZip();
    for (const [name, data] of Object.entries(files)) z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'));
    return z.toBuffer();
}
const SUMMARY = 'Originating Identifier: suspect@example.com [x]\nStart of date range: 2024-01-01\nEnd of date range: 2024-12-31\n';
const BILLING_TXT = '****All information contained alongside this file within the ZIP container is Confidential and Proprietary****\nGoogle LLC\nBilling name: Test Person\n';
const DRIVE_BIN = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

function writeFolderReturn(dir, { mboxN = 40, locN = 300, bigMboxBytes = 0 } = {}) {
    fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
    const mbox = bigMboxBytes ? buildMbox(Math.ceil(bigMboxBytes / 20000), { bodyBytes: 20000, allIds: true }) : buildMbox(mboxN);
    fs.writeFileSync(path.join(dir, `${ACCT}.Mail.MessageContent_001.zip`), innerZip({ 'ExportSummary.txt': SUMMARY, 'Mail/All mail.mbox': mbox }));
    fs.writeFileSync(path.join(dir, 'nested', `${ACCT}.LocationHistory.Records_001.zip`), innerZip({ 'ExportSummary.txt': SUMMARY, 'Location History/Records.json': buildRecords(locN) }));
    fs.writeFileSync(path.join(dir, 'nested', 'deeper', `${ACCT}.Drive.DriveFiles_001.zip`), innerZip({
        'ExportSummary.txt': SUMMARY,
        'Drive/My Folder/photo.png': DRIVE_BIN,
        'Drive/../../evil.bin': Buffer.from('nope'),
        'Drive/index.json': JSON.stringify({ title: 'photo.png' }),
    }));
    fs.writeFileSync(path.join(dir, `${ACCT}.GooglePay.BillingInformation_001.zip`), innerZip({ 'file_1.txt': BILLING_TXT, 'Google Pay/Billing Information/billing.txt': BILLING_TXT + 'line\n'.repeat(130) }));
    fs.writeFileSync(path.join(dir, 'cover letter.pdf'), '%PDF-1.4 fake');
    fs.writeFileSync(path.join(dir, 'notes.docx'), 'ignored');
    return mbox;
}

(async () => {
    const parser = new GoogleWarrantParser();

    // ═══ 1. streamJsonArray ═══
    {
        const doc = buildRecords(50).toString('utf-8');
        const whole = JSON.parse(doc).locations;
        for (const chunkSize of [1, 3, 7, 64, 100000]) {
            const bytes = Buffer.from(doc, 'utf-8');
            const chunks = [];
            for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
            const got = [];
            const st = await GoogleWarrantParser.streamJsonArray(Readable.from(chunks), 'locations', (o) => { got.push(o); });
            ok(st.found && got.length === 50 && JSON.stringify(got) === JSON.stringify(whole), `streamJsonArray chunk=${chunkSize} matches JSON.parse (${got.length})`);
        }
        const got2 = [];
        await GoogleWarrantParser.streamJsonArray(Readable.from([Buffer.from('[{"a":1},{"a":"]}"},{"b":[1,{"c":2}]}]')]), null, (o) => got2.push(o));
        ok(got2.length === 3 && got2[1].a === ']}' && got2[2].b[1].c === 2, 'root-array mode with brackets inside strings and nested arrays');
        const got3 = [];
        const st3 = await GoogleWarrantParser.streamJsonArray(Readable.from([Buffer.from('{"other":[{"x":1}],"meta":{"locations":[{"no":1}]},"locations":[{"yes":1}]}')]), 'locations', (o) => got3.push(o));
        ok(got3.length === 1 && got3[0].yes === 1 && st3.found, 'only the root-level key is streamed (nested same-named key ignored)');
        const st4 = await GoogleWarrantParser.streamJsonArray(Readable.from([Buffer.from('{"nothing":true}')]), 'locations', () => {});
        ok(!st4.found && st4.items === 0, 'missing key → found:false, no items');
        const got5 = [];
        const st5 = await GoogleWarrantParser.streamJsonArray(Readable.from([Buffer.from('{"locations":[{"a":1},{"big":"' + 'z'.repeat(5000) + '"},{"a":3}]}')]), 'locations', (o) => got5.push(o), { maxItemChars: 1000 });
        // single chunk: the size cap applies across chunks only, so test with small chunks too
        const big = Buffer.from('{"locations":[{"a":1},{"big":"' + 'z'.repeat(5000) + '"},{"a":3}]}');
        const ch = []; for (let i = 0; i < big.length; i += 100) ch.push(big.subarray(i, i + 100));
        const got6 = [];
        const st6 = await GoogleWarrantParser.streamJsonArray(Readable.from(ch), 'locations', (o) => got6.push(o), { maxItemChars: 1000 });
        ok(got5.length === 3 && st6.oversized === 1 && got6.length === 2 && got6[1].a === 3, 'oversized item is skipped and counted, stream continues');
    }

    // ═══ 2. parseMboxStream ═══
    {
        const mbox = buildMbox(12);
        const legacy = await parser.parseMbox(mbox);
        ok(legacy.length === 12, `parseMbox wrapper finds all 12 messages (got ${legacy.length})`);
        ok(legacy[0].id === '<msg1@example.com>' && legacy[0].subject === 'Test message 1' && legacy[0].labels === 'Inbox,Important', 'headers parsed');
        ok(/>From here on/.test(legacy[0].textBody) && /END 1/.test(legacy[0].textBody), 'escaped >From line stays inside the body (no false split)');
        ok(/^msg-\d+$/.test(legacy[2].id), 'message without Message-ID gets a generated id');
        ok(/<b>5<\/b>/.test(legacy[4].htmlBody) && /plain 5/.test(legacy[4].textBody), 'multipart html + text');
        for (const cs of [1, 2, 5, 6, 7, 13, 4096]) {
            const chunks = []; for (let i = 0; i < mbox.length; i += cs) chunks.push(mbox.subarray(i, i + cs));
            const got = [];
            await parser.parseMboxStream(Readable.from(chunks), (em) => { got.push(em); });
            ok(got.length === 12 && got.map(e => e.subject).join('|') === legacy.map(e => e.subject).join('|') && got[11].textBody === legacy[11].textBody,
                `stream chunk=${cs} gives the same 12 messages`);
        }
        const crlf = buildMbox(6, { crlf: true });
        const gotC = await parser.parseMbox(crlf);
        ok(gotC.length === 6 && gotC[5].subject === 'Test message 6', 'CRLF mbox');
        const noLeadingFrom = Buffer.from(mboxMessage(1).split('\n').slice(1).join('\n') + '\n' + mboxMessage(2));
        const gotN = await parser.parseMbox(noLeadingFrom);
        ok(gotN.length === 2 && gotN[0].subject === 'Test message 1', 'mbox without a leading From_ line');
        ok((await parser.parseMbox(Buffer.alloc(0))).length === 0 && (await parser.parseMbox(Buffer.from('From x\n\n'))).length === 0, 'empty / trivial mbox → 0');
        // per-message cap
        const { MBOX_MESSAGE_MAX } = GoogleWarrantParser.LIMITS;
        ok(MBOX_MESSAGE_MAX >= 16 * 1024 * 1024, 'per-message cap is generous');
    }

    // ═══ 3. Folder import: never reads the ZIPs into memory ═══
    let folderResult, writer, storeDir;
    {
        const dir = path.join(TMP, 'folder-return');
        fs.mkdirSync(dir);
        writeFolderReturn(dir);
        const mediaRoot = path.join(TMP, 'case1', 'Evidence', 'google-warrant');
        storeDir = path.join(mediaRoot, '_store');
        const key = gwStore.storeKeyFor(dir);
        writer = gwStore.openWriter(storeDir, key);

        // spies
        const readWhole = [];
        const realRFS = fs.readFileSync;
        fs.readFileSync = function (p, ...rest) { if (typeof p === 'string' && p.startsWith(dir) && /\.zip$/i.test(p)) readWhole.push(p); return realRFS.call(this, p, ...rest); };
        const ZR = zipReaderMod.ZipReader;
        const realEntryData = ZR.prototype._entryData;
        const wholeEntries = [];
        ZR.prototype._entryData = function (name) { wholeEntries.push(name); return realEntryData.call(this, name); };
        const marks = [];
        try {
            folderResult = await parser.parseOuterZip(dir, { mediaRoot, sink: writer.sink, storeDir, storeKey: key, onMark: (l, d) => marks.push([l, d]) });
        } finally {
            fs.readFileSync = realRFS;
            ZR.prototype._entryData = realEntryData;
        }
        writer.finish();
        gwStore.attachToResult(folderResult, writer);

        ok(readWhole.length === 0, `no inner ZIP read whole with fs.readFileSync (got ${readWhole.length})`);
        ok(!wholeEntries.some(n => /\.mbox$|Records\.json$/i.test(n)), `mbox / Records.json streamed, never read whole (whole reads: ${wholeEntries.join(', ')})`);
        ok(!wholeEntries.some(n => /photo\.png$/i.test(n)), 'Drive binary streamed to disk, never read whole');
        ok(folderResult.store && folderResult.store.emailCount === 40 && folderResult.store.locationCount === 300, `store counts 40 / 300 (got ${JSON.stringify(folderResult.store)})`);
        ok(folderResult.emails.length === 40 && folderResult.emails.every(e => e._preview && !e.htmlBody), 'inline e-mails are previews without html');
        ok(folderResult.locationRecords.length === 300, 'inline location preview');
        ok(folderResult.accountEmail === 'suspect@example.com' && folderResult.accountId === '518160276335', 'account parsed from folder file names (incl. nested sub-folders)');
        ok(folderResult.coverLetter && folderResult.coverLetter.name === 'cover letter.pdf', 'cover letter noticed in folder');
        ok(folderResult.categories.includes('LocationHistory.Records') && folderResult.categories.includes('Drive.DriveFiles'), 'nested sub-folder zips found');
        ok(marks.some(([l, d]) => l === 'google-warrant:category' && d.category === 'Mail.MessageContent'), 'crash-log breadcrumb per category');

        const files = folderResult.driveFiles.filter(f => f._isFile);
        const png = files.find(f => f.name === 'photo.png');
        ok(png && !('data' in png) && png.relPath && png.size === DRIVE_BIN.length, 'Drive file stored by relPath, no base64 data');
        ok(png && fs.readFileSync(path.join(mediaRoot, png.relPath)).equals(DRIVE_BIN), 'Drive file bytes on disk match');
        ok(png && /Drive\.DriveFiles\/Drive\/My Folder\/photo\.png$/.test(png.relPath), 'Drive sub-folders kept: ' + (png && png.relPath));
        const evil = files.find(f => f.name === 'evil.bin');
        ok(evil && evil.relPath && path.resolve(mediaRoot, evil.relPath).startsWith(path.resolve(mediaRoot)) && !/\.\./.test(evil.relPath), '"../" entry names cannot escape the media folder');
        ok(folderResult.driveFiles.some(f => f.title === 'photo.png'), 'Drive JSON metadata still parsed inline');

        const raw = folderResult.rawSections['GooglePay.BillingInformation'];
        ok(raw && raw.other.some(o => /Billing name: Test Person/.test(o.text)), 'Google Pay → Billing Information (submission #23 layout) captured to Other Data');
        ok(!JSON.stringify(folderResult).includes('"data":"'), 'no base64 blobs anywhere in the import record');
    }

    // ═══ 4. Store readers ═══
    {
        const key = folderResult.store.keys[0];
        const p1 = gwStore.readEmailPage(storeDir, { keys: [key], offset: 0, limit: 15 });
        const p3 = gwStore.readEmailPage(storeDir, { keys: [key], offset: 30, limit: 15 });
        ok(p1.total === 40 && p1.rows.length === 15 && p3.rows.length === 10, 'email paging 15/15/10');
        ok(p1.rows[0].date >= p1.rows[14].date, 'newest first');
        ok(p1.rows.every(r => r.key === key && r.seq && !('textBody' in r) && typeof r.snippet === 'string'), 'page rows are headers + snippet only');
        const s = gwStore.readEmailPage(storeDir, { keys: [key], q: 'Test message 17' });
        ok(s.total === 1 && s.rows[0].subject === 'Test message 17', 'search by subject');
        const s2 = gwStore.readEmailPage(storeDir, { keys: [key], q: 'END 37' });
        ok(s2.total === 1, 'search matches body text');
        const s3 = gwStore.readEmailPage(storeDir, { keys: [key], q: '100%_' });
        ok(s3.total === 0, 'LIKE wildcards in the query are literal');
        const full = gwStore.getEmail(storeDir, { key, seq: s.rows[0].seq });
        ok(full && /Body of message 17/.test(full.textBody) && full.id === '<msg17@example.com>', 'getEmail by seq returns full body');
        const byId = gwStore.getEmail(storeDir, { key, id: '<msg5@example.com>' });
        ok(byId && /<b>5<\/b>/.test(byId.htmlBody), 'getEmail by message id returns html');
        const l1 = gwStore.readLocations(storeDir, { keys: [key], offset: 290, limit: 50 });
        ok(l1.total === 300 && l1.rows.length === 10 && l1.rows[0].lat === (400000000 + 290) / 1e7, 'location paging');
        const ls = gwStore.readLocations(storeDir, { keys: [key], sample: 30 });
        ok(ls.sampled && ls.rows.length === 30 && ls.step === 10, `sampled map points (${ls.rows.length}, step ${ls.step})`);
        ok(Array.isArray(l1.rows.find(r => r.activity) ? l1.rows.find(r => r.activity).activity : []), 'activity round-trips as JSON');
        const st = gwStore.storeStats(storeDir, [key]);
        ok(st.emailCount === 40 && st.locationCount === 300, 'storeStats');

        // second store → multi-key paging
        const w2 = gwStore.openWriter(storeDir, 'second-abc');
        for (let i = 0; i < 7; i++) w2.sink.email({ id: 'b' + i, subject: 'B ' + i, date: '2023-01-0' + (i + 1), textBody: 'bee' });
        w2.finish();
        const m = gwStore.readEmailPage(storeDir, { keys: [key, 'second-abc'], offset: 35, limit: 10 });
        ok(m.total === 47 && m.rows.length === 10 && m.rows[4].key === key && m.rows[5].key === 'second-abc', 'paging spans two stores');
        // duplicate message ids are stored once
        const w3 = gwStore.openWriter(storeDir, 'dupes');
        w3.sink.email({ id: 'same', subject: 'one' }); w3.sink.email({ id: 'same', subject: 'two' });
        const sum3 = w3.finish();
        ok(sum3.emailCount === 1 && sum3.emailDuplicates === 1, 'duplicate Message-ID stored once');
        // abort → no file; incomplete store unreadable
        const w4 = gwStore.openWriter(storeDir, 'aborted');
        w4.sink.email({ id: 'x' });
        w4.abort();
        ok(!fs.existsSync(gwStore.dbFileFor(storeDir, 'aborted')), 'aborted import leaves no store file');
        const w5 = gwStore.openWriter(storeDir, 'halfway');
        for (let i = 0; i < 1500; i++) w5.sink.email({ id: 'h' + i });   // one batch flushed, not finished
        ok(gwStore.readEmailPage(storeDir, { keys: ['halfway'] }).total === 0, 'unfinished store is never read');
        w5.abort();
        // key validation
        let threw = false; try { gwStore.dbFileFor(storeDir, '..\\..\\evil'); } catch (_) { threw = true; }
        ok(threw && !gwStore.isValidKey('../x') && !gwStore.isValidKey('.hidden') && gwStore.isValidKey(key), 'store keys validated (no path traversal)');
        ok(gwStore.readEmailPage(storeDir, { keys: ['../../x', 'missing-key'] }).total === 0, 'bad / missing keys read as empty');
        ok(gwStore.storeKeyFor('C:\\A\\ret.zip') === gwStore.storeKeyFor('c:\\a\\RET.zip') && gwStore.storeKeyFor('C:\\A\\ret.zip') !== gwStore.storeKeyFor('C:\\B\\ret.zip'), 'storeKeyFor stable per path, distinct per folder');
        ok(gwStore.deleteStores(storeDir, ['second-abc', 'dupes', '../nope']) === 2 && !fs.existsSync(gwStore.dbFileFor(storeDir, 'second-abc')), 'deleteStores');
    }

    // ═══ 5. ZIP import (master bundle inside outer zip) gives the same data ═══
    {
        const dir = path.join(TMP, 'zip-src');
        fs.mkdirSync(dir);
        writeFolderReturn(dir);
        const bundle = new AdmZip();
        for (const f of [`${ACCT}.Mail.MessageContent_001.zip`, `nested/${ACCT}.LocationHistory.Records_001.zip`]) bundle.addFile(path.basename(f), fs.readFileSync(path.join(dir, f)));
        const outer = new AdmZip();
        outer.addFile('30136296-20260514-1.zip', bundle.toBuffer());
        const outerPath = path.join(TMP, '30136296-20260514.zip');
        outer.writeZip(outerPath);
        const mediaRoot = path.join(TMP, 'case2', 'Evidence', 'google-warrant');
        const sd = path.join(mediaRoot, '_store');
        const w = gwStore.openWriter(sd, gwStore.storeKeyFor(outerPath));
        const r = await parser.parseOuterZip(outerPath, { mediaRoot, sink: w.sink });
        w.finish(); gwStore.attachToResult(r, w);
        ok(r.store.emailCount === 40 && r.store.locationCount === 300 && r.bundleSources.includes('30136296-20260514-1'), 'zip-of-zips via master bundle → same counts');
        // no sink (no case folder) → capped inline, legacy shape
        const r2 = await parser.parseOuterZip(outerPath, {});
        ok(r2.emails.length === 40 && r2.locationRecords.length === 300 && !r2.store, 'without a store the data stays inline (legacy shape)');
        ok(r2.emails[4].htmlBody && /<b>5<\/b>/.test(r2.emails[4].htmlBody), 'inline e-mails keep html when no store');
    }

    // ═══ 6. Oversize file guard + result caps ═══
    {
        const dir = path.join(TMP, 'oversize');
        fs.mkdirSync(dir);
        const { MAX_INLINE_ENTRY, INLINE_ROW_CAP } = GoogleWarrantParser.LIMITS;
        const hugeHtml = Buffer.alloc(MAX_INLINE_ENTRY + 1024, 0x20);
        Buffer.from('<html><table><tr><th>a</th></tr>').copy(hugeHtml, 0);
        fs.writeFileSync(path.join(dir, `${ACCT}.MyActivity.MyActivity_001.zip`), innerZip({ 'ExportSummary.txt': SUMMARY, 'My Activity/MyActivity.html': hugeHtml }));
        const rows = ['Name,Value'];
        for (let i = 0; i < INLINE_ROW_CAP + 2500; i++) rows.push(`n${i},v${i}`);
        fs.writeFileSync(path.join(dir, `${ACCT}.GooglePlayStore.UserPreferences_001.zip`), innerZip({ 'prefs.csv': rows.join('\n') }));
        const mediaRoot = path.join(TMP, 'case3', 'Evidence', 'google-warrant');
        const sd = path.join(mediaRoot, '_store');
        const r = await parser.parseOuterZip(dir, { mediaRoot, storeDir: sd, storeKey: 'cap-test' });
        ok(Array.isArray(r.oversizeFiles) && r.oversizeFiles.length === 1 && r.oversizeFiles[0].category === 'MyActivity.MyActivity', 'oversize HTML not parsed, listed in oversizeFiles');
        const ov = r.oversizeFiles[0];
        ok(ov && ov.relPath && fs.statSync(path.join(mediaRoot, ov.relPath)).size === hugeHtml.length, 'oversize file copied out intact');
        ok(r.myActivity.length === 0, 'oversize file contributed no rows');
        ok(r.playStorePreferences.length === INLINE_ROW_CAP && r.truncated && r.truncated.playStorePreferences === 2500, 'array capped with truncation count');
        const nd = path.join(sd, 'cap-test.overflow', 'playStorePreferences.ndjson');
        const lines = fs.existsSync(nd) ? fs.readFileSync(nd, 'utf-8').trim().split('\n') : [];
        ok(lines.length === 2500 && JSON.parse(lines[0]).Name === 'n' + INLINE_ROW_CAP, 'overflow rows written to NDJSON (nothing lost)');
        // byte budget: many fat rows get halved until the record fits
        const fat = { myActivity: Array.from({ length: 9000 }, (_, i) => ({ i, t: 'y'.repeat(3000) })), categories: [], bundleSources: [], emails: [], locationRecords: [] };
        parser._capResult(fat, parser._ensureCtx({}));
        ok(JSON.stringify(fat).length <= GoogleWarrantParser.LIMITS.RESULT_CHAR_BUDGET * 1.05 && fat.truncated.myActivity > 0, `record shrunk under budget (${fat.myActivity.length} rows kept)`);
    }

    // ═══ 7. Memory: a big mbox is streamed (heap stays far below file size) ═══
    {
        const dir = path.join(TMP, 'big');
        fs.mkdirSync(dir);
        const BIG = 80 * 1024 * 1024;
        writeFolderReturn(dir, { bigMboxBytes: BIG });
        if (global.gc) global.gc();
        const base = process.memoryUsage().heapUsed;
        let peak = base;
        const timer = setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }, 5);
        let n = 0;
        const t0 = Date.now();
        await parser.parseOuterZip(dir, { sink: { email: (em) => { n++; const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }, location: () => {} } });
        clearInterval(timer);
        const growMB = (peak - base) / 1048576;
        ok(n === Math.ceil(BIG / 20000), `all ${n} big-mbox messages delivered`);
        ok(growMB < 60, `heap growth ${growMB.toFixed(1)} MB while streaming an 80 MB mbox (old code: > 160 MB)`);
        console.log(`  big mbox: ${n} msgs, peak heap +${growMB.toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }

    // ═══ 8. electron-main: folder branch no longer buffers ═══
    {
        const src = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf-8');
        const a = src.indexOf("ipcMain.handle('google-warrant-import'");
        const b = src.indexOf('function _gwReadableError', a);
        const block = a >= 0 && b > a ? src.slice(a, b) : '';
        ok(block.length > 0, 'found google-warrant-import handler');
        ok(!/readFileSync|toBuffer\(|new AdmZip/.test(block), 'import handler never reads files into memory or re-zips a folder');
        ok(/gwStore\.openWriter/.test(block) && /writer\.abort\(\)/.test(block) && /onMark:\s*_crashMark/.test(block), 'import handler writes the store, aborts on failure, leaves breadcrumbs');
        for (const ch of ['google-warrant-emails-page', 'google-warrant-email', 'google-warrant-locations', 'google-warrant-store-stats', 'google-warrant-store-delete', 'crash-log-info', 'crash-log-open-folder', 'crash-log-export', 'crash-log-clear']) {
            ok(src.includes(`ipcMain.handle('${ch}'`), 'main handles ' + ch);
        }
        const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf-8');
        for (const fn of ['googleWarrantEmailsPage', 'googleWarrantEmail:', 'googleWarrantLocations', 'googleWarrantStoreStats', 'googleWarrantStoreDelete', 'crashLogInfo', 'crashLogOpenFolder', 'crashLogExport', 'crashLogClear']) {
            ok(pre.includes(fn), 'preload exposes ' + fn);
        }
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${fail === 0 ? '✔ ALL TESTS PASSED' : '✖ FAILURES'} pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
