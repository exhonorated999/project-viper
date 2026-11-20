/**
 * Google Warrant — large returns split into many ZIPs (parser request #29).
 *
 *   node modules/google-warrant/__tests__/google-warrant-split.test.js
 *
 * Large returns arrive as dozens of per-product ZIPs, bundles inside
 * bundles, parts re-zipped under other names, and loose documents next to
 * them.  Every part must be found and parsed as ONE return.
 *
 * Fixtures are synthetic, built here with adm-zip (no real return data).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AdmZip = require('adm-zip');
const GoogleWarrantParser = require(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-parser.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-split-'));

const ACCT = 'suspect@example.com.518160276335';
const BANNER = '****All information contained alongside this file within the ZIP container is Confidential and Proprietary****\nGoogle LLC\n';
function summary(service, resource, extra) {
    return BANNER +
        'Originating Identifier: suspect@example.com [Google Account]\n' +
        'Resolved Identifier: 518160276335\n' +
        `Service: ${service}\nResource: ${resource}\n` +
        'Start of date range: 2024-01-01\nEnd of date range: 2024-06-30\n' + (extra || '');
}
function zipBuf(files) {
    const z = new AdmZip();
    for (const [name, data] of Object.entries(files)) z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'));
    return z.toBuffer();
}
function mbox(from, n) {
    const out = [];
    for (let i = from; i < from + n; i++) {
        out.push([
            'From 1712345678901234567@xxx Mon Jan 01 00:00:00 +0000 2024',
            `Message-ID: <split${i}@example.com>`,
            `Date: Mon, 01 Jan 2024 00:${String(i % 60).padStart(2, '0')}:00 +0000`,
            `From: Sender ${i} <sender${i}@example.com>`,
            'To: suspect@example.com',
            `Subject: Split message ${i}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            `Body ${i}`,
            ''
        ].join('\n'));
    }
    return out.join('\n');
}
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0]), Buffer.alloc(200, 7)]);
const INSTALLS_HDR = 'Doc Package Name,Doc Title,First Installation Time\n';
const ACCESS_CSV = 'Activity Time,IP Address,Activity Type,User Agent,Is Non Routable\n' +
    '2024-02-01 10:00:00 UTC,203.0.113.10,Login,Mozilla/5.0 Test,false\n' +
    '2024-02-02 11:00:00 UTC,198.51.100.7,Login,Mozilla/5.0 Test,false\n' +
    '2024-02-03 12:00:00 UTC,2001:db8::1,Logout,Android Test,false\n';
const IDENT_CSV = 'Timestamp,IP Address,Identifier Type,Identifier\n2024-03-01 09:00:00 UTC,192.0.2.44,Android ID,abc123\n';
const DEVICES_CSV = 'Brand Name,Marketing Name,Device Model,Device Last Activity Time\nAcme,Acme Phone 9,AP9-X,2024-04-01 08:00:00 UTC\n';

/** A large split return: per-product ZIPs with standard and anonymised names. */
function writeParts(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const p = (n) => path.join(dir, n);
    const files = {};
    const put = (name, buf) => { fs.writeFileSync(p(name), buf); files[name] = p(name); };
    // Mail split in two parts (standard names)
    put(`${ACCT}.Mail.MessageContent_001.zip`, zipBuf({ [`${ACCT}.Mail.MessageContent_001.ExportSummary.txt`]: summary('Gmail', 'Message Content'), 'Mail/All mail.mbox': mbox(1, 6) }));
    put(`${ACCT}.Mail.MessageContent_002.zip`, zipBuf({ [`${ACCT}.Mail.MessageContent_002.ExportSummary.txt`]: summary('Gmail', 'Message Content'), 'Mail/All mail.mbox': mbox(7, 4) }));
    // Play Store installs split in two parts — must accumulate
    put(`${ACCT}.GooglePlayStore.Installs_001.zip`, zipBuf({ 'ExportSummary.txt': summary('Google Play Store', 'Installs'), 'Installs.csv': INSTALLS_HDR + 'com.a,App A,2024-01-02\ncom.b,App B,2024-01-03\n' }));
    put(`${ACCT}.GooglePlayStore.Installs_002.zip`, zipBuf({ 'ExportSummary.txt': summary('Google Play Store', 'Installs'), 'Installs.csv': INSTALLS_HDR + 'com.c,App C,2024-01-04\n' }));
    // No records in part 1, data in part 2 → NOT "no records"
    put(`${ACCT}.GoogleChat.GroupInfo_001.NoRecords.zip`, zipBuf({ 'NoRecords.txt': 'none' }));
    put(`${ACCT}.GoogleChat.GroupInfo_002.zip`, zipBuf({ 'ExportSummary.txt': summary('Google Chat', 'Group Info'), 'group.json': '{"name":"Group A"}' }));
    // Anonymised names (file_N.zip) — category from the summary's content
    put('file_11.zip', zipBuf({ 'file_1.txt': summary('Access Log Activity', 'Activity'), 'file_2.csv': ACCESS_CSV }));
    put('file_12.zip', zipBuf({ 'file_1.txt': summary('Access Log Activity', 'Identifiers'), 'file_2.csv': IDENT_CSV }));
    put('file_13.zip', zipBuf({ 'file_1.txt': summary('Access Log Activity', 'Devices'), 'file_2.csv': DEVICES_CSV }));
    put('file_14.zip', zipBuf({ 'file_1.txt': summary('Hangouts', 'Content And Metadata', '\nThere are no responsive records.\n') }));
    put('file_15.zip', zipBuf({ 'file_1.txt': summary('Google Pay', 'Customer Information'), 'Google Pay/Customer Information/file_2.txt': 'Customer name: Test Person\nCountry: US\n' }));
    // My Activity: files the handler does not know (Gemini images, deletion markers)
    put('file_16.zip', zipBuf({
        'file_1.txt': summary('My Activity', 'My Activity'),
        'My Activity/Search/MyActivity.html': '<html><body><div class="outer-cell"><div class="content-cell mdl-typography--body-1">Searched for test<br>Jan 1, 2024</div></div></body></html>',
        'My Activity/Gemini Apps/image_1.gtraw': JPEG,
        'My Activity/Gemini Apps/Deletion Markers.csv': 'Deleted Time,Product\n2024-01-05,Gemini\n',
    }));
    // A CyberTip-style report ZIP: no summary, a txt and an image without extension
    put('file_17.zip', zipBuf({ 'Google-CT-RPT-0000001.txt': 'Synthetic CyberTip-style report\nIncident: test\n', 'file_3': JPEG }));
    // Loose report next to the parts
    put('report_summary.txt', 'Synthetic production summary for testing.\n');
    return files;
}

(async () => {
    const parser = new GoogleWarrantParser();
    const src = path.join(TMP, 'parts');
    const files = writeParts(src);
    const list = Object.values(files);

    // ═══ 1. All parts picked together (array input) ═══
    let r;
    {
        const mediaRoot = path.join(TMP, 'case1', 'Evidence', 'google-warrant');
        r = await parser.parseOuterZip(list, { mediaRoot, inputName: 'split-return' });
        ok(r.emails.length === 10, `e-mails from both Mail parts (got ${r.emails.length})`);
        ok(r.accountEmail === 'suspect@example.com' && r.accountId === '518160276335', 'account from standard names');
        ok(r.installs.length === 3, `Installs _001 + _002 accumulate (got ${r.installs.length})`);
        ok(r.categories.includes('GoogleChat.GroupInfo') && !r.noRecordCategories.includes('GoogleChat.GroupInfo'), 'category with data in one part is not "no records"');
        ok(r.chatGroupInfo.length === 1, 'chat group info parsed');
        ok(r.categories.includes('AccessLogActivity.Activity'), 'anonymised ZIP categorised by summary content: ' + r.categories.join(', '));
        const ips = r.accessLogActivity.map(a => a.ip);
        ok(ips.includes('203.0.113.10') && ips.includes('2001:db8::1'), 'access-log CSV rows parsed');
        const first = r.accessLogActivity.find(a => a.ip === '203.0.113.10');
        ok(first && first.timestamp === '2024-02-01 10:00:00 UTC' && first.activity === 'Login' && first.details === 'Mozilla/5.0 Test' && first['Is Non Routable'] === 'false', 'access-log columns mapped, extra columns kept');
        ok(ips.includes('192.0.2.44'), 'AccessLogActivity.Identifiers IP rows join the access log');
        const dev = r.devices.find(d => d.model === 'AP9-X');
        ok(dev && dev.manufacturer === 'Acme' && dev.lastActive === '2024-04-01 08:00:00 UTC', 'AccessLogActivity.Devices CSV (Brand / Model / Last Activity)');
        ok(r.noRecordCategories.includes('Hangouts.ContentAndMetadata') && !r.categories.includes('Hangouts.ContentAndMetadata'), 'no-records detected by content');
        const pay = r.rawSections['GooglePay.CustomerInformation'];
        ok(pay && pay.other.some(o => /Customer name: Test Person/.test(o.text || '')), 'Google Pay customer txt kept');
        const ma = r.rawSections['MyActivity.MyActivity'];
        ok(r.myActivity.some(a => /Searched for test/.test(a.action)), 'My Activity HTML still parsed');
        const img = ma && ma.other.find(o => o.name === 'image_1.gtraw');
        ok(img && img.relPath && img.mimeType === 'image/jpeg' && fs.readFileSync(path.join(mediaRoot, img.relPath)).equals(JPEG), 'unknown binary (.gtraw) copied to the case folder with sniffed type');
        ok(ma && ma.csv.some(c => c.name === 'Deletion Markers.csv' && c.rows.length === 1), 'unknown CSV kept in Other Data');
        const ctKey = Object.keys(r.rawSections).find(k => r.rawSections[k].other.some(o => /CyberTip-style/.test(o.text || '')));
        ok(ctKey, 'CyberTip-style report ZIP without a summary is kept: ' + Object.keys(r.rawSections).join(', '));
        const ctImg = ctKey && r.rawSections[ctKey].other.find(o => o.name === 'file_3');
        ok(ctImg && ctImg.relPath && ctImg.mimeType === 'image/jpeg', 'extension-less image kept with sniffed type');
        const docs = r.rawSections['Return Documents'];
        ok(docs && docs.other.some(o => o.name === 'report_summary.txt' && /production summary/.test(o.text)), 'loose txt next to the parts → Return Documents');
        ok(!r.rawSections['AccessLogActivity.Activity'] || !JSON.stringify(r.rawSections['AccessLogActivity.Activity']).includes('Originating Identifier'), 'export summary not duplicated into Other Data');
        ok(r.dateRange.start === '2024-01-01' && r.dateRange.end === '2024-06-30', 'date range from the summaries');
        ok(r._diagnostics.errors.length === 0, 'no parse errors: ' + JSON.stringify(r._diagnostics.errors.map(e => e.error)));
        ok(r._diagnostics.byContent >= 6, `parts classified by content (${r._diagnostics.byContent})`);
        ok(!JSON.stringify(r).includes('"data":"'), 'no base64 blobs');
    }

    // ═══ 2. One part picked + siblings passed as extraPaths = same result ═══
    {
        const firstPart = files[`${ACCT}.Mail.MessageContent_001.zip`];
        const r2 = await parser.parseOuterZip(firstPart, { extraPaths: list.filter(p => p !== firstPart), mediaRoot: path.join(TMP, 'case2') });
        ok(r2.emails.length === 10 && r2.installs.length === 3 && r2.accessLogActivity.length === r.accessLogActivity.length, 'extraPaths gives the same data as the array input');
        ok(r2.categories.slice().sort().join() === r.categories.slice().sort().join(), 'same categories');
    }

    // ═══ 3. Folder import of the same parts ═══
    {
        fs.writeFileSync(path.join(src, 'unrelated.zip'), zipBuf({ 'a.jpg': JPEG, 'list.csv': 'x\n1\n' }));
        const r3 = await parser.parseOuterZip(src, { mediaRoot: path.join(TMP, 'case3') });
        ok(r3.emails.length === 10 && r3.installs.length === 3 && r3.rawSections['Return Documents'], 'folder import finds every part + loose doc');
        ok(!r3.categories.some(c => /unrelated/i.test(c)) && r3.rawSections['Return Documents'].other.some(o => o.name === 'unrelated.zip' && /not imported/.test(o.note || '')), 'unrelated ZIP in the folder is listed, not parsed');
        fs.unlinkSync(path.join(src, 'unrelated.zip'));
    }

    // ═══ 4. A single per-product ZIP picked alone ═══
    {
        const r4 = await parser.parseOuterZip(files[`${ACCT}.GooglePlayStore.Installs_002.zip`], { mediaRoot: path.join(TMP, 'case4') });
        ok(r4.installs.length === 1 && r4.categories.join() === 'GooglePlayStore.Installs', 'single per-product ZIP parsed on its own');
        const r4b = await parser.parseOuterZip(files['file_11.zip'], { mediaRoot: path.join(TMP, 'case4b') });
        ok(r4b.accessLogActivity.length === 3 && r4b.accountEmail === 'suspect@example.com', 'single anonymised ZIP: category + account from its summary');
    }

    // ═══ 5. Bundles inside bundles, a non-standard container, duplicates ═══
    {
        const rd = (n) => fs.readFileSync(files[n]);
        const inner2 = zipBuf({ '777-20260101-2.zip': zipBuf({ [`${ACCT}.Mail.MessageContent_002.zip`]: rd(`${ACCT}.Mail.MessageContent_002.zip`), 'file_11.zip': rd('file_11.zip') }) });
        const bundle1 = zipBuf({
            [`${ACCT}.Mail.MessageContent_001.zip`]: rd(`${ACCT}.Mail.MessageContent_001.zip`),
            'nested-part.zip': inner2,                                 // not a standard name: a container by content
            'cover.pdf': '%PDF-1.4 fake',
        });
        const outer = new AdmZip();
        outer.addFile('777-20260101-1.zip', bundle1);
        outer.addFile(`${ACCT}.GooglePlayStore.Installs_001.zip`, rd(`${ACCT}.GooglePlayStore.Installs_001.zip`));
        outer.addFile('copy/' + `${ACCT}.GooglePlayStore.Installs_001.zip`, rd(`${ACCT}.GooglePlayStore.Installs_001.zip`)); // same part twice
        outer.addFile('Google-CT-RPT-0000002.txt', Buffer.from('Loose synthetic report inside the outer ZIP\n'));
        const outerPath = path.join(TMP, 'big-return.zip');
        outer.writeZip(outerPath);
        const r5 = await parser.parseOuterZip(outerPath, { mediaRoot: path.join(TMP, 'case5') });
        ok(r5.emails.length === 10, `mail parts found two bundle levels down (got ${r5.emails.length})`);
        ok(r5.accessLogActivity.length === 3, 'anonymised part inside nested bundles parsed');
        ok(r5.installs.length === 2 && r5._diagnostics.duplicates === 1, `duplicate part parsed once (installs ${r5.installs.length}, dupes ${r5._diagnostics.duplicates})`);
        ok(r5.bundleSources.includes('777-20260101-1') && r5.bundleSources.includes('777-20260101-2'), 'numbered bundles recorded: ' + r5.bundleSources.join(', '));
        ok(r5._diagnostics.containersOpened >= 4, `containers opened (${r5._diagnostics.containersOpened})`);
        ok(r5.coverLetter && r5.coverLetter.name === 'cover.pdf', 'cover pdf inside a bundle');
        ok(r5.rawSections['Return Documents'] && r5.rawSections['Return Documents'].other.some(o => /Loose synthetic report/.test(o.text || '')), 'loose txt inside the outer ZIP kept');
        ok(r5._diagnostics.errors.length === 0, 'no errors: ' + JSON.stringify(r5._diagnostics.errors.map(e => e.error)));
    }

    // ═══ 6. Nesting deeper than the limit is reported, not silently dropped ═══
    {
        let z = zipBuf({ [`${ACCT}.GooglePlayStore.Installs_002.zip`]: fs.readFileSync(files[`${ACCT}.GooglePlayStore.Installs_002.zip`]) });
        for (let i = 0; i < 6; i++) z = zipBuf({ [`level${i}.zip`]: z });
        const deep = path.join(TMP, 'deep.zip');
        fs.writeFileSync(deep, z);
        const r6 = await parser.parseOuterZip(deep, {});
        ok(r6._diagnostics.errors.some(e => /nested too deeply/.test(e.error)), 'too-deep nesting reported');
    }

    // ═══ 7. Detection ═══
    {
        ok(await GoogleWarrantParser.isGoogleWarrantZipAsync(files['file_11.zip']) === true, 'anonymised per-product ZIP detected by its summary');
        ok(await GoogleWarrantParser.isGoogleWarrantZipAsync(files[`${ACCT}.Mail.MessageContent_001.zip`]) === true, 'standard per-product ZIP detected');
        ok(await GoogleWarrantParser.isGoogleWarrantZipAsync(path.join(TMP, 'big-return.zip')) === true, 'outer ZIP of bundles detected');
        const other = path.join(TMP, 'other.zip');
        fs.writeFileSync(other, zipBuf({ 'readme.txt': 'Service: nothing to do with Google\n', 'a.csv': 'x,y\n1,2\n' }));
        ok(await GoogleWarrantParser.isGoogleWarrantZipAsync(other) === false, 'unrelated ZIP not detected');
        ok(GoogleWarrantParser.serviceFromName(`${ACCT}.GoogleMeet.UserSessions_001.Preserved.zip`).resource === 'UserSessions' && GoogleWarrantParser.serviceFromName('file_3.zip') === null, 'serviceFromName');
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(fail ? `✗ FAILED pass=${pass} fail=${fail}` : `✔ ALL TESTS PASSED pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
