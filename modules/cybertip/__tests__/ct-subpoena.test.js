'use strict';
// CyberTip "Subpoena list" — model, text, CSV, PDF HTML, wiring.
// All values are synthetic (documentation IP ranges, example names).
//
// Run: node modules\cybertip\__tests__\ct-subpoena.test.js

const fs = require('fs');
const path = require('path');
const P = require('../ct-subpoena.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const UI = fs.readFileSync(path.join(REPO, 'modules', 'cybertip', 'ct-subpoena-ui.js'), 'utf8');
const IPR_UI = fs.readFileSync(path.join(REPO, 'modules', 'cybertip', 'ct-ip-report-ui.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + label); } }
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '\n      got  ' + A + '\n      want ' + B));
}

const up = (filename, md5, ips) => ({ filename, md5, sourceIps: ips.map(([address, timestamp]) => ({ address, event: 'Upload', timestamp })) });

// Tip A (SYNTHETIC): 198.51.100.4 uploads 4 files at 3 distinct seconds and
// logs in twice (one on port 443); 203.0.113.7 logs in + checks in; a
// private address; an IPv6 upload with no zone on the time.
const TIP_A = {
    reportNumber: '900000555', esp: { name: 'Example Cloud' },
    uploadedFiles: [
        up('VID_secret_name_1.mp4', 'a'.repeat(32), [['198.51.100.4', '02-16-2026 01:30:55 UTC']]),
        up('VID_secret_name_2.mp4', 'b'.repeat(32), [['198.51.100.4', '02-16-2026 01:30:55 UTC']]),
        up('VID_secret_name_3.mp4', 'c'.repeat(32), [['198.51.100.4', '02-16-2026 01:25:03 UTC']]),
        up('VID_secret_name_4.mp4', 'd'.repeat(32), [['198.51.100.4', '11-05-2025 22:20:23 UTC'], ['2001:DB8::9', '2026-01-02 03:04:05']]),
    ],
    persons: [{ role: 'Suspect', name: 'Synthetic Person', ipAddresses: [
        { address: '198.51.100.4', type: 'Login', port: '443', timestamp: '05-11-2026 19:41:41 UTC' },
        { address: '198.51.100.4', type: 'Login', port: '', timestamp: '01-01-2026 00:00:01 UTC' },
        // same second as a file upload → already counted as that upload
        { address: '198.51.100.4', type: 'Upload', port: '', timestamp: '02-16-2026 01:25:03 UTC' },
        { address: '203.0.113.7', type: 'Login', port: '5222', timestamp: '01-03-2026 06:00:00 UTC' },
        { address: '203.0.113.7', type: 'Checkin', port: '', timestamp: '01-04-2026 06:00:00 UTC' },
        { address: '192.168.1.20', type: 'Login', port: '', timestamp: '01-04-2026 07:00:00 UTC' },
    ] }],
    arinResults: { '198.51.100.4': { provider: 'Example Cable Co', network: 'EXAMPLE-CPE-1', netRange: '198.51.100.0 - 198.51.100.255', country: 'US' } },
    ipGeoLookup: [{ address: '203.0.113.7', isp: 'Example Mobile', country: 'US' }]
};
// Tip B (SYNTHETIC): one more login from 198.51.100.4.
const TIP_B = {
    reportNumber: '900000666', esp: { name: 'Example Chat' },
    uploadedFiles: [],
    persons: [{ role: 'Recipient', ipAddresses: [{ address: '198.51.100.4', type: 'Sign-in', port: '', timestamp: '03-01-2026 12:00:00 UTC' }] }]
};

// ── 1. helpers ────────────────────────────────────────────────────────────
console.log('1. helpers');
ok(P.privateIp('192.168.1.20') && P.privateIp('10.0.0.1') && P.privateIp('172.20.1.1') && P.privateIp('100.64.0.1'), 'private v4 ranges');
ok(P.privateIp('fe80::1') && P.privateIp('fd12:3456::1') && P.privateIp('::1'), 'private v6 ranges');
ok(!P.privateIp('198.51.100.4') && !P.privateIp('172.32.0.1') && !P.privateIp('2001:db8::9'), 'public addresses');
eq(P.activityOf('other', 'Login').label, 'Login', 'Login');
eq(P.activityOf('other', 'Sign-in').kind, 'login', 'Sign-in counts as a login');
eq(P.activityOf('other', 'Checkin'), { kind: 'other', label: 'Checkin' }, 'other types keep the ESP word');
eq(P.activityOf('other', 'Unspecified').label, 'Activity (type not stated)', 'blank type');
eq(P.activityOf('upload', 'Upload').kind, 'upload', 'upload');

// ── 2. candidates ─────────────────────────────────────────────────────────
console.log('2. candidates');
const cands = P.candidates([TIP_A]);
eq(cands.map(c => c.address), ['198.51.100.4', '203.0.113.7', '2001:DB8::9', '192.168.1.20'], 'most used first, private last');
const c1 = cands[0];
eq([c1.uploads, c1.logins, c1.other, c1.total], [4, 2, 0, 6], 'counts for the busy IP (person upload at the same second not double-counted)');
eq(c1.provider, 'Example Cable Co', 'ARIN provider');
eq(cands[1].provider, 'Example Mobile', 'NCMEC/ESP lookup provider when no ARIN');
ok(cands[3].private, 'private flagged');

// ── 3. build ──────────────────────────────────────────────────────────────
console.log('3. build');
const m = P.build([TIP_A]);
eq(m.ips.map(g => g.address), ['198.51.100.4', '203.0.113.7', '2001:DB8::9'], 'default: every public IP, private left out');
const g = m.ips[0];
eq(g.rows.map(r => [r.n, r.date, r.time, r.zone, r.activity, r.port, r.count]), [
    [1, '11/05/2025', '22:20:23', 'UTC', 'Upload', '', 1],
    [2, '01/01/2026', '00:00:01', 'UTC', 'Login', '', 1],
    [3, '02/16/2026', '01:25:03', 'UTC', 'Upload', '', 1],
    [4, '02/16/2026', '01:30:55', 'UTC', 'Upload', '', 2],
    [5, '05/11/2026', '19:41:41', 'UTC', 'Login', '443', 1],
], 'oldest first; same-second uploads merged with a count');
eq([g.entries, g.rows.length, g.hasPort, g.merged], [6, 5, true, true], 'entries vs lines');
eq(g.counts, { upload: 4, login: 2, other: 0 }, 'counts');
eq([g.first.date, g.last.date], ['11/05/2025', '05/11/2026'], 'period');
eq([g.provider, g.netRange, g.network], ['Example Cable Co', '198.51.100.0 - 198.51.100.255', 'EXAMPLE-CPE-1'], 'provider details');
const json = JSON.stringify(m);
ok(!/secret_name|aaaaaaaa|Synthetic Person|Suspect/.test(json), 'no file names, hashes, names or roles anywhere in the model');

const unmerged = P.build([TIP_A], { addresses: ['198.51.100.4'], merge: false });
eq(unmerged.ips[0].rows.length, 6, 'merge off: one line per entry');
const onlyUp = P.build([TIP_A], { addresses: ['198.51.100.4'], kinds: { login: false } });
eq(onlyUp.ips[0].rows.map(r => r.activity), ['Upload', 'Upload', 'Upload'], 'kinds filter: uploads only');
eq(P.build([TIP_A], { addresses: ['203.0.113.7'], kinds: { login: false, other: false } }).ips.length, 0, 'IP with nothing left is dropped');
const priv = P.build([TIP_A], { addresses: ['192.168.1.20'] });
eq([priv.ips.length, priv.ips[0].private, P.providerText(priv.ips[0])], [1, true, 'Private address (not routable on the internet)'], 'a private IP can still be chosen explicitly');
const v6 = P.build([TIP_A], { addresses: ['2001:db8::9'] }).ips[0];
eq([v6.zones.length, v6.noZone, P.providerText(v6)], [0, 1, 'Provider not looked up'], 'IPv6: case-folded pick, no zone, no provider');
const g203 = P.build([TIP_A], { addresses: ['203.0.113.7'] }).ips[0];
eq(g203.rows.map(r => r.activity + '/' + r.port), ['Login/5222', 'Checkin/'], 'login + other');

const both = P.build([TIP_A, TIP_B], { addresses: ['198.51.100.4'] });
eq([both.ips[0].entries, both.ips[0].counts.login], [7, 3], 'two tips combined');
eq(both.ips[0].tips, ['900000555', '900000666'], 'tips per IP');
eq(both.tips, ['900000555', '900000666'], 'model tips');

// ── 4. text / CSV / file name ─────────────────────────────────────────────
console.log('4. text, CSV');
const one = P.build([TIP_A], { addresses: ['198.51.100.4'] });
const txt = P.text(one, { request: 'REQUEST LINE' });
const lines = txt.split('\r\n');
eq(lines.slice(0, 5), [
    'REQUEST LINE', '',
    'IP address: 198.51.100.4',
    'Provider: Example Cable Co (ARIN) · range 198.51.100.0 - 198.51.100.255',
    'Used 6 times: 4 uploads, 2 logins (5 distinct dates/times), 11/05/2025 22:20:23 UTC to 05/11/2026 19:41:41 UTC.',
], 'text header');
eq(lines[5], 'Dates and times used (UTC):', 'zone line');
eq(lines[6], '1. 11/05/2025 22:20:23 UTC  Upload', 'first row');
ok(lines.indexOf('4. 02/16/2026 01:30:55 UTC  Upload  (2 entries)') >= 0, 'merged row shows a count');
ok(lines.indexOf('5. 05/11/2026 19:41:41 UTC  Login  port 443') >= 0, 'port shown');
ok(!/secret_name/.test(txt), 'no file names in text');
const multiTxt = P.text(m, {});
ok(multiTxt.indexOf('----------------------------------------') > 0 && multiTxt.indexOf('IP address: 2001:DB8::9') > 0, 'several IPs separated');
ok(/Dates and times used \(time zone not stated in the report\)/.test(multiTxt), 'missing zone said plainly');

const csv = P.csv(one).split('\r\n');
eq(csv[0], 'IP address,Line,Date,Time,Time zone,Activity,Port,Entries,Provider', 'CSV header');
eq(csv[4], '198.51.100.4,4,02/16/2026,01:30:55,UTC,Upload,,2,Example Cable Co', 'CSV merged row');
eq(csv.length, 7, 'CSV rows + trailing newline');
const evil = P.build([{ reportNumber: '1', persons: [{ ipAddresses: [{ address: '198.51.100.8', type: '=HYPERLINK("x")', timestamp: '01-01-2026 01:01:01 UTC' }] }] }]);
ok(P.csv(evil).indexOf(`"'=HYPERLINK(""x"")"`) > 0, 'CSV formula injection neutralised');

eq(P.fileName(one, { caseNumber: 'C-1', day: '2026-11-02' }), 'IP-Subpoena-List_198-51-100-4_C-1_2026-11-02.pdf', 'file name, one IP');
eq(P.fileName(m, { caseNumber: 'C 1', day: '2026-11-02' }, 'csv'), 'IP-Subpoena-List_3-IPs_C_1_2026-11-02.csv', 'file name, several');

// ── 4b. activity labels off ───────────────────────────────────────────────
console.log('4b. activity labels off');
const noAct = P.build([TIP_A], { addresses: ['198.51.100.4'], showActivity: false });
const ga = noAct.ips[0];
eq([noAct.showActivity, ga.showActivity], [false, false], 'flag carried on model and IP');
ok(ga.rows.every(r => r.activity === '' && r.kind === ''), 'rows carry no activity');
eq(ga.entries, 6, 'entry count unchanged');
const naTxt = P.text(noAct, {}).split('\r\n');
eq(naTxt[2], 'Used 6 times (5 distinct dates/times), 11/05/2025 22:20:23 UTC to 05/11/2026 19:41:41 UTC.', 'no upload/login breakdown');
eq(naTxt[4], '1. 11/05/2025 22:20:23 UTC', 'row without activity word');
ok(naTxt.indexOf('5. 05/11/2026 19:41:41 UTC  port 443') >= 0 && naTxt.indexOf('4. 02/16/2026 01:30:55 UTC  (2 entries)') >= 0, 'port and count kept');
ok(!/Upload|Login|upload|login/.test(P.text(noAct, {})), 'text never says upload or login');
const naCsv = P.csv(noAct).split('\r\n');
eq(naCsv[0], 'IP address,Line,Date,Time,Time zone,Port,Entries,Provider', 'CSV without Activity column');
eq(naCsv[4], '198.51.100.4,4,02/16/2026,01:30:55,UTC,,2,Example Cable Co', 'CSV row without activity');
const naHtml = P.pdfHtml(noAct, { caseNumber: 'C-1', showCase: true });
ok(!/<th>Activity<\/th>/.test(naHtml) && !/Upload|Login|upload|login/.test(naHtml), 'PDF: no activity column or words');
ok(/"Entries" counts records at the same date and time\./.test(naHtml), 'PDF entries note without activity');
ok(/<th>Activity<\/th>/.test(P.pdfHtml(one, {})), 'default still has the Activity column');
// SYNTHETIC: a login and an upload in the same second merge into one line when labels are off.
const TIP_C = {
    reportNumber: '900000777', esp: { name: 'Example Cloud' },
    uploadedFiles: [up('x.jpg', 'e'.repeat(32), [['198.51.100.9', '04-01-2026 10:00:00 UTC']])],
    persons: [{ ipAddresses: [{ address: '198.51.100.9', type: 'Login', port: '', timestamp: '04-01-2026 10:00:00 UTC' }] }]
};
eq(P.build([TIP_C]).ips[0].rows.length, 2, 'labels on: upload and login at the same second stay separate');
const mc = P.build([TIP_C], { showActivity: false }).ips[0];
eq([mc.rows.length, mc.rows[0].count], [1, 2], 'labels off: same second merges into one line with a count');
eq(P.build([TIP_C], { showActivity: false, merge: false }).ips[0].rows.length, 2, 'labels off + merge off: one line per entry');
ok(/check\('showActivity'/.test(UI) && /showActivity: S\.showActivity/.test(UI) && /showActivity: o\.showActivity !== false/.test(UI), 'UI: option shown, saved, default on');

// ── 5. PDF HTML ───────────────────────────────────────────────────────────
console.log('5. PDF');
const html = P.pdfHtml(m, { caseNumber: 'C-1', showCase: true, showTips: false, onePerPage: true, request: 'Please <provide>', logo: 'data:image/png;base64,AAAA' });
ok(/IP Address Activity: Dates and Times of Use/.test(html), 'title');
ok(/Case C-1/.test(html), 'case number shown');
ok(!/900000555|Example Cloud/.test(html), 'CyberTip number and ESP hidden by default');
ok(/Please &lt;provide&gt;/.test(html), 'request line escaped');
eq((html.match(/class="sec pb"/g) || []).length, 2, 'each IP after the first starts a new page');
ok(!/secret_name|aaaaaaaa|Synthetic Person|Suspect/.test(html), 'no file names, hashes, names or roles in the PDF');
ok(/<th>Port<\/th>/.test(html) && /<th>Entries<\/th>/.test(html), 'port + entries columns when used');
ok(/Not stated in the report/.test(html), 'missing zone flagged');
const html2 = P.pdfHtml(m, { caseNumber: 'C-1', showCase: false, showTips: true, onePerPage: false });
ok(/900000555 \(Example Cloud\)/.test(html2) && !/Case C-1/.test(html2), 'options: tip/ESP on, case off');
ok(!/class="sec pb"/.test(html2), 'one-per-page off');

// ── 6. wiring ─────────────────────────────────────────────────────────────
console.log('6. wiring');
const iUi = DETAIL.indexOf('modules/cybertip/ct-ip-report-ui.js'), iM = DETAIL.indexOf('modules/cybertip/ct-subpoena.js'), iS = DETAIL.indexOf('modules/cybertip/ct-subpoena-ui.js');
ok(iUi > 0 && iM > iUi && iS > iM, 'scripts load after the IP report: model then UI');
ok(/typeof window !== 'undefined' && window\.CTSubpoenaUI\) \? window\.CTSubpoenaUI\.cardButton\(\)/.test(DETAIL), 'IP card button (guarded)');
ok(/window\.CTSubpoenaUI\) \? window\.CTSubpoenaUI\.barButton\(\)/.test(DETAIL), 'Identifiers bar button (guarded)');
ok(/data-ct-ip="\$\{escHtmlSafe\(g\.address\)\}"/.test(DETAIL), 'IP card carries data-ct-ip for openFor');
ok(/saveToEvidence: saveToEvidence/.test(IPR_UI) && /source \|\| 'cybertip_ip_report'/.test(IPR_UI), 'IP report UI shares saveToEvidence with a source');
ok(/'cybertip_subpoena_list'/.test(UI) && /z-index:99996/.test(UI) && /addEventListener\('keydown', onKey, true\)/.test(UI), 'UI: evidence source, overlay layer, Escape in capture');
const R = require('../ct-ip-report.js');
global.window = { CTSubpoenaUI: { panelButton: s => '[SUBP:' + s + ']' } };
ok(R.panelHtml(R.build([TIP_A], { scope: 'tip' })).indexOf('[SUBP:tip]') > 0, 'Uploads-by-IP panel shows the button');
delete global.window;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
