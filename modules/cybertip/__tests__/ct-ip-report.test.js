'use strict';
// CyberTip "Uploads by IP" report — model, panel, PDF HTML, wiring.
// All values are synthetic (documentation IP ranges, example.com).
//
// Run: node modules\cybertip\__tests__\ct-ip-report.test.js

const fs = require('fs');
const path = require('path');
const R = require('../ct-ip-report.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + label); } }
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '\n      got  ' + A + '\n      want ' + B));
}
function lift(header) {
    const s = DETAIL.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const open = DETAIL.indexOf('{', s + header.length - 1);
    let depth = 0;
    for (let i = open; i < DETAIL.length; i++) {
        const c = DETAIL[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return DETAIL.slice(s, i + 1); }
    }
    throw new Error('unbalanced: ' + header);
}

const file = (filename, md5, ips) => ({ filename, md5, categorization: '', sourceIps: ips.map(([address, timestamp]) => ({ address, event: 'Upload', timestamp })) });

// Tip A: one IP used 3 times on two dates, one IPv6 used once, one file with
// no IP, a person with logins (one on an upload IP) and a person-listed upload.
const TIP_A = {
    reportNumber: '900000101', esp: { name: 'Example Cloud' }, receivedDate: '01-30-2026',
    uploadedFiles: [
        file('IMG_0003.jpg', 'c'.repeat(32), [['198.51.100.4', '01-14-2026 09:10:00 UTC']]),
        file('IMG_0001.jpg', 'a'.repeat(32), [['198.51.100.4', '01-01-2026 23:59:59 UTC']]),
        file('IMG_0002.jpg', 'b'.repeat(32), [['198.51.100.4', '01-14-2026 08:00:00 UTC'], ['2001:DB8::1', '01-20-2026 12:00:00 UTC']]),
        file('VID_<x>.mp4', 'd'.repeat(32), []),
    ],
    persons: [
        { role: 'Suspect', ipAddresses: [
            { address: '203.0.113.7', type: 'Login', port: '443', timestamp: '01-05-2026 06:00:00 UTC' },
            { address: '203.0.113.7', type: 'Login', port: '443', timestamp: '01-03-2026 06:00:00 UTC' },
            { address: '203.0.113.7', type: 'Checkin', port: '', timestamp: '01-04-2026 06:00:00 UTC' },
            { address: '198.51.100.4', type: 'Login', port: '', timestamp: '01-02-2026 10:00:00 UTC' },
            // same second as a file upload → the same event, not a second upload
            { address: '198.51.100.4', type: 'Upload', port: '', timestamp: '01-14-2026 08:00:00 UTC' },
            // an upload with no file in the list
            { address: '192.0.2.50', type: 'Upload', port: '', timestamp: '2026-01-25 03:04:05 UTC' },
            { address: '192.0.2.99', type: '', port: '', timestamp: '' },
        ] }
    ],
    ipGeoLookup: [{ address: '198.51.100.4', country: 'US', region: 'NV', city: 'Sampletown', isp: 'Example Fiber', type: 'residential' }],
    arinResults: { '203.0.113.7': { provider: 'Example Mobile', country: 'US' } }
};

// Tip B: shares IMG_0001 upload (same IP, second, md5) with tip A, plus a new
// upload from 198.51.100.4 and a login from 2001:db8::1 (case folded).
const TIP_B = {
    reportNumber: '900000202', esp: { name: 'Example Chat' },
    uploadedFiles: [
        file('IMG_0001.jpg', 'a'.repeat(32), [['198.51.100.4', '01-01-2026 23:59:59 UTC']]),
        file('IMG_0009.jpg', 'e'.repeat(32), [['198.51.100.4', '02-02-2026 02:02:02 UTC']]),
    ],
    persons: [{ role: 'Recipient', ipAddresses: [{ address: '2001:db8::1', type: 'Login', port: '5222', timestamp: '02-01-2026 01:00:00 UTC' }] }]
};

// ── 1. helpers ────────────────────────────────────────────────────────────
console.log('1. helpers');
eq(R.tsKey('01-14-2026 08:00:00 UTC'), '20260114080000', 'tsKey MM-DD-YYYY');
eq(R.tsKey('2026-01-25 03:04:05 UTC'), '20260125030405', 'tsKey ISO-ish');
eq(R.tsKey('01-14-2026'), '20260114000000', 'tsKey date only');
eq(R.tsKey('nonsense'), '', 'tsKey blank for junk');
eq(R.fmtDate('20260114080000'), '01/14/2026', 'fmtDate');
eq(R.zoneOf('01-14-2026 08:00:00 UTC'), 'UTC', 'zone UTC');
eq(R.zoneOf('2026-01-14T08:00:00Z'), 'UTC', 'zone Z');
eq(R.zoneOf('01-14-2026 08:00:00 PDT'), 'PDT', 'zone PDT');
eq(R.zoneOf('01-14-2026 08:00:00'), '', 'no zone');

// ── 2. single tip ────────────────────────────────────────────────────────
console.log('2. single tip');
const A = R.build([TIP_A], { scope: 'tip' });
eq(A.scope, 'tip', 'scope');
eq(A.uploads.map(g => [g.address, g.count]), [['198.51.100.4', 3], ['2001:DB8::1', 1], ['192.0.2.50', 1]], 'upload IPs, most used first, ties by earliest upload');
const U1 = A.uploads[0];
eq(U1.events.map(e => [e.date, e.time, e.file]), [
    ['01/01/2026', '23:59:59', 'IMG_0001.jpg'],
    ['01/14/2026', '08:00:00', 'IMG_0002.jpg'],
    ['01/14/2026', '09:10:00', 'IMG_0003.jpg'],
], 'events oldest first with date, time, file');
eq(U1.dates, ['01/01/2026', '01/14/2026'], 'distinct upload dates');
eq(U1.fileCount, 3, 'file count');
eq(U1.events[0].md5, 'a'.repeat(32), 'md5 kept');
eq(U1.events[0].zone, 'UTC', 'zone kept');
eq([U1.first.date, U1.last.time], ['01/01/2026', '09:10:00'], 'first / last');
eq(U1.otherCount, 1, 'upload IP cross-ref to its login');
ok(U1.geo && U1.geo.isp === 'Example Fiber' && U1.geo.city === 'Sampletown', 'geo-lookup attached');
const U2 = A.uploads[2];
eq([U2.events[0].noFile, U2.events[0].file, U2.events[0].date, U2.fileCount], [true, '', '01/25/2026', 0], 'person-listed upload with no file is kept and flagged');
eq(A.noIpFiles, [{ file: 'VID_<x>.mp4', md5: 'd'.repeat(32), tip: '900000101' }], 'file without an upload IP listed separately');
eq(A.other.map(g => [g.address, g.count]), [['203.0.113.7', 3], ['198.51.100.4', 1], ['192.0.2.99', 1]], 'other IPs (undated last); upload-type person entry not counted as other');
const O1 = A.other[0];
eq(O1.types, [{ type: 'Login', count: 2 }, { type: 'Checkin', count: 1 }], 'types summary');
eq(O1.events.map(e => [e.date, e.type, e.port]), [['01/03/2026', 'Login', '443'], ['01/04/2026', 'Checkin', ''], ['01/05/2026', 'Login', '443']], 'other events oldest first');
eq(O1.geo && O1.geo.isp, 'Example Mobile', 'saved ARIN result used as ISP');
eq(A.other[2].types, [{ type: 'Unspecified', count: 1 }], 'blank type → Unspecified');
eq(A.other[2].events[0].date, '', 'undated entry kept');
eq(A.other[1].uploadCount, 3, 'login IP flagged as also an upload IP');
eq(A.totals, { tips: 1, files: 4, uploadIps: 3, uploads: 5, otherIps: 3, otherEvents: 5, noIpFiles: 1 }, 'totals');
eq(A.zones, ['UTC'], 'zones');

// ── 3. combined ──────────────────────────────────────────────────────────
console.log('3. combined');
const C = R.build([TIP_A, TIP_B], { scope: 'case' });
eq(C.scope, 'case', 'scope case');
const CU = C.uploads[0];
eq([CU.address, CU.count], ['198.51.100.4', 4], 'shared upload de-duplicated across tips (3 + 1 new)');
eq(CU.events[0].tips, ['900000101', '900000202'], 'shared upload lists both tips');
eq(CU.tips, ['900000101', '900000202'], 'group lists both tips');
eq(CU.dates, ['01/01/2026', '01/14/2026', '02/02/2026'], 'dates across tips');
const v6 = C.other.find(g => g.address.toLowerCase() === '2001:db8::1');
ok(v6 && v6.uploadCount === 1, 'IPv6 login matched to IPv6 upload (case folded)');
eq(C.tips.map(t => [t.reportNumber, t.files, t.uploads]), [['900000101', 4, 4], ['900000202', 2, 1]], 'per-tip rows');
eq(C.totals.files, 5, 'distinct files across tips (by md5)');
eq(R.build([{ uploadedFiles: [], persons: [] }]).tips[0].reportNumber, 'Tip 1', 'tip without a number gets a label');
eq(R.build([]).totals.uploadIps, 0, 'empty input');
eq(R.build(null).totals.tips, 0, 'null input');

// ── 4. panel HTML ────────────────────────────────────────────────────────
console.log('4. panel');
const PA = R.panelHtml(A);
ok(PA.includes('Uploads by IP'), 'panel title');
ok(PA.includes('used 3 times'), '"used N times" badge');
ok(PA.includes('<span class="text-gray-500">Uploads:</span> 01/01/2026, 01/14/2026'), 'upload dates line');
ok(PA.includes('Login and other IP activity'), 'second section');
ok(PA.indexOf('Upload IP addresses') < PA.indexOf('Login and other IP activity'), 'uploads before logins');
ok(PA.includes('VID_&lt;x&gt;.mp4') && !PA.includes('VID_<x>'), 'file names escaped');
ok(PA.includes("CTIpReportUI.save('tip', true)") && PA.includes("CTIpReportUI.save('tip', false)"), 'save buttons');
ok(PA.includes('color-scheme:dark'), 'dark search box');
ok(!PA.includes('>CT#</th>'), 'no CT# column for one tip');
ok(PA.includes('not tied to a file'), 'no-file upload explained');
ok(R.panelHtml(C).includes('>CT#</th>') && R.panelHtml(C).includes("CTIpReportUI.save('case', true)"), 'combined: CT# column + case save');
ok(R.panelHtml(R.build([{ reportNumber: '1', uploadedFiles: [], persons: [] }])).includes('No IP addresses were found'), 'empty panel message');
{
    const many = { reportNumber: '9', persons: [], uploadedFiles: [] };
    for (let i = 0; i < R.SCREEN_ROW_CAP + 20; i++) many.uploadedFiles.push(file('f' + i + '.jpg', String(i).padStart(32, '0'), [['198.51.100.9', '03-01-2026 00:00:' + String(i % 60).padStart(2, '0') + ' UTC']]));
    const big = R.build([many]);
    eq(big.uploads[0].count, R.SCREEN_ROW_CAP + 20, 'big tip: every upload counted');
    const ph = R.panelHtml(big);
    ok(ph.includes('Showing the first ' + R.SCREEN_ROW_CAP), 'big tip: on-screen table capped with note');
    ok(R.pdfHtml(big, {}).split('<tr>').length - 1 >= R.SCREEN_ROW_CAP + 20, 'big tip: PDF lists every row');
}

// ── 5. PDF HTML ──────────────────────────────────────────────────────────
console.log('5. pdf');
const meta = { caseNumber: '26-0042', caseTitle: 'Op <Test>', generated: '1/30/2026, 9:00 AM', day: '2026-01-30', logo: 'data:image/png;base64,AAAA' };
const HA = R.pdfHtml(A, meta);
ok(HA.startsWith('<!DOCTYPE html>') && HA.includes('<meta charset="utf-8">'), 'standalone document');
ok(HA.includes('CyberTip Uploads by IP Address'), 'title');
ok(HA.includes('CT# 900000101 \u00b7 Example Cloud'), 'subtitle names the tip');
ok(HA.includes('Op &lt;Test&gt;') && !HA.includes('Op <Test>'), 'meta escaped');
ok(HA.includes('src="data:image/png;base64,AAAA"'), 'embedded logo');
ok(HA.includes('IP: <span class="addr">198.51.100.4</span> <span class="cnt">(used 3 times)</span>'), 'IP heading with use count');
ok(HA.includes('<b>Uploads:</b> 01/01/2026, 01/14/2026'), 'uploads date list');
ok(HA.includes('Summary of upload IP addresses'), 'index table');
ok(HA.indexOf('1. Upload IP addresses') < HA.indexOf('2. Login and other IP activity'), 'section order');
ok(HA.includes('Uploaded files with no upload IP listed (1)'), 'no-IP files section');
ok(HA.includes('Login \u00d72, Checkin \u00d71'), 'type summary in PDF');
ok(HA.includes('As reported by the ESP (UTC)'), 'time zone note');
ok(!/readDeptBadge|dept-badge/i.test(HA), 'no agency badge');
ok(R.pdfHtml(C, meta).includes('<th>CT#</th>'), 'combined PDF has CT# column');
eq(R.fileName(A, meta), 'CyberTip-IP-Report_CT900000101_26-0042_2026-01-30.pdf', 'tip file name');
eq(R.fileName(C, meta), 'CyberTip-IP-Report_AllTips_26-0042_2026-01-30.pdf', 'case file name');

// ── 6. end-to-end with the real parser ───────────────────────────────────
console.log('6. parser → report');
{
    const parseCyberTip = new Function(lift('function parseCyberTip(text, fileName) {') + '\nreturn parseCyberTip;')();
    const TEXT = [
        'CyberTipline Report 900000444',
        'Section A: Reported Information',
        'Suspect 1',
        'Name: Jordan Example',
        'IP Address: 203.0.113.7 (Login)',
        '05-03-2026 06:00:00 UTC',
        'IP Address: 198.51.100.4 (Login)',
        '05-04-2026 07:00:00 UTC',
        'Uploaded File Information',
        'Number of uploaded files: 2',
        'Uploaded File Information',
        'Filename: VID_0001.mp4',
        'MD5: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'IP Address198.51.100.4Upload01-23-2026 16:56:15 UTC',
        'Uploaded File Information',
        'Filename: VID_0002.mp4',
        'MD5: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'IP Address198.51.100.4Upload01-26-2026 22:46:19 UTC',
        'Section B: Automated Information',
        'This concludes Section B',
        ''
    ].join('\n');
    const T = parseCyberTip(TEXT, 't.pdf');
    const rep = R.build([T]);
    eq(rep.uploads.map(g => [g.address, g.count, g.dates]), [['198.51.100.4', 2, ['01/23/2026', '01/26/2026']]], 'parsed tip → upload group');
    eq(rep.uploads[0].events.map(e => e.file), ['VID_0001.mp4', 'VID_0002.mp4'], 'parsed files in time order');
    eq(rep.other.map(g => g.address), ['203.0.113.7', '198.51.100.4'], 'parsed logins in the other section (tie → seen first)');
    eq(rep.uploads[0].otherCount, 1, 'parsed upload IP cross-referenced to its login');
}

// ── 7. wiring ────────────────────────────────────────────────────────────
console.log('7. wiring');
ok(/<script src="modules\/cybertip\/ct-ip-report\.js"><\/script>\s*<script src="modules\/cybertip\/ct-ip-report-ui\.js"><\/script>/.test(DETAIL), 'scripts loaded (model then UI)');
ok(DETAIL.includes("currentCyberTipView === 'ipAll'") && DETAIL.includes('CTIpReportUI.caseView()'), 'combined view routed');
ok(DETAIL.includes('CTIpReportUI.listButton()'), 'list-page button');
const detail = lift('function renderCyberTipDetail(idx) {');
ok(detail.includes('CTIpReportUI.tipPanel(t)'), 'per-tip panel in the detail view');
ok(detail.indexOf('CTIpReportUI.tipPanel(t)') > detail.indexOf('<!-- Identifiers -->') && detail.indexOf('CTIpReportUI.tipPanel(t)') < detail.indexOf('<!-- Persons Detail -->'), 'panel sits after Identifiers, before Persons');
const UI = fs.readFileSync(path.join(__dirname, '..', 'ct-ip-report-ui.js'), 'utf8');
ok(UI.includes('returnBase64: true') && UI.includes('saveEvidenceFile'), 'UI saves the PDF to Evidence');
ok(UI.includes("'viperCaseEvidence'"), 'UI registers the Evidence record');
ok(UI.includes('csr-logo.png') && !/readDeptBadge/.test(UI), 'VIPER logo only');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
