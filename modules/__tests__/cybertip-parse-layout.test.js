'use strict';
// CyberTips tab — parseCyberTip() must read BOTH text layouts a CyberTipline
// PDF can come out of the PDF reader in:
//
//   1. "one line"  — "IP Address: 203.0.113.50 (Login)" (pdf-parse; most tips)
//   2. "stacked"   — "IP Address:" / "2600:…:e50a (Login)" / timestamp on
//                    separate lines (MuPDF fallback; a 129-page Google tip
//                    with ~230 login IPs, VIPER Scout submission #22, Oct
//                    2026). Before the fix every IP came back blank, the
//                    Suspect's name/DOB/phone/emails were empty, all 211
//                    uploaded files were dropped and the ESP name read
//                    "Point of Contact for Law Enforcement:".
//
// parseCyberTip and the detail renderer are LIFTED from
// case-detail-with-analytics.html, never copied. Every value is synthetic
// (documentation IP ranges, example.com, made-up hashes).
//
// Run: node modules\__tests__\cybertip-parse-layout.test.js

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '  (got ' + A + ', want ' + B + ')'));
}
function liftFunction(src, header) {
    const s = src.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const open = src.indexOf('{', s + header.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
    }
    throw new Error('unbalanced: ' + header);
}

const parseCyberTip = new Function(liftFunction(DETAIL, 'function parseCyberTip(text, fileName) {') + '\nreturn parseCyberTip;')();

// ── Fixture 1: stacked layout (shape taken from submission #22) ───────────
const FOOT = (n) => `\nCyberTipline Report 900000222 | ${n}\n\nThis Report is provided solely for informational purposes pursuant to NCMEC's nonprofit mission.\n\nPlease treat all information in this Report as confidential.\n\n`;
const TS = (k) => `05-${String(1 + (k % 28)).padStart(2, '0')}-2026 06:${String(k % 60).padStart(2, '0')}:41 UTC`;

const SUSPECT_IPS = [];   // what the parser should return, in order
function stackedIpBlock(k) {
    let ipText, addr;
    if (k === 5) {                       // IPv6 wrapped mid-address onto a second line
        addr = '2001:db8:a4d6:dc76:5c1e:2b0f:9a20:e50a';
        ipText = '2001:db8:a4d6:\ndc76:5c1e:2b0f:9a20:e50a (Login)';
    } else if (k === 8) {                // type tag on its own line
        addr = '2001:db8::8e14';
        ipText = '2001:db8::8e14\n(Login)';
    } else if (k % 3 === 0) {
        addr = `203.0.113.${10 + k}`;
        ipText = addr + ' (Login)';
    } else {
        addr = `2001:db8:a4d6:${(0x1000 + k).toString(16)}:5c1e:2b0f:9a20:${(0xe000 + k).toString(16)}`;
        ipText = addr + ' (Login)';
    }
    SUSPECT_IPS.push({ address: addr, type: 'Login', port: '', timestamp: TS(k) });
    // k === 11: a blank line between the address and its timestamp
    return `IP Address:\n${ipText}\n${k === 11 ? '\n' : ''}${TS(k)}\n`;
}
const ipBlocks = [];
for (let k = 0; k < 24; k++) {
    ipBlocks.push(stackedIpBlock(k));
    if (k === 12) ipBlocks.push(FOOT(3));
}
SUSPECT_IPS.push({ address: '198.51.100.77', type: 'Checkin', port: '', timestamp: '2026-05-01 06:54:05' });

const MD5S = ['0a1b2c3d4e5f60718293a4b5c6d7e8f9', '1b2c3d4e5f60718293a4b5c6d7e8f90a', '2c3d4e5f60718293a4b5c6d7e8f90a1b', '3d4e5f60718293a4b5c6d7e8f90a1b2c'];
function fileHead(k, name) {
    return `Uploaded File Information\n\nFilename:\nGoogle-CT-RPT-900000222-${'e6'.repeat(12)}${k}-\n${name}\n\nMD5:\n${MD5S[k]}\n\n` +
        `Original Filename Associated with File:\n${name}\n\nDid Reporting ESP view entire contents of uploaded file?\nYes\n\n` +
        `Did Reporting ESP view the EXIF of uploaded file?\n(Information Not Provided by Company)\n\n` +
        `Were entire contents of uploaded file publicly available?\nNo\n\nImage Categorization by ESP:\nB1\n`;
}
const STACKED =
    ` \n\nThe following is a brief overview of information contained in this CyberTipline report:\n\nTotal Uploaded Files: 4\n\nCyberTipline Report 900000222\n\nPriority Level: E\n(Report submitted by a registered Electronic Service Provider)\n\nReceived by NCMEC on 05-10-2026 16:58:00 UTC\n\n` +
    `Contents\n\nSection A: Reported Information\n1\n\nReporting Electronic Service Provider (ESP)\n1\nIncident Information\n2\nSuspect\n2\nUploaded File Information\n18–97\n` + FOOT('i') +
    `Section A: Reported Information\n\n \n\nThe following information was submitted to the CyberTipline by the Reporting ESP.\n\nReporting Electronic Service Provider (ESP)\n\n` +
    `Submitter:\nPoint of Contact for Law Enforcement:\n\nGoogle\nCustodian of Records\n\nBusiness Address:\n1600 Amphitheatre Parkway\nMountain View, CA 94043 United States\n\nCompany Information\n\nSynthetic company text.\n` + FOOT(1) +
    `Incident Information\n\nPrimary Incident Type:\nChild Pornography (possession, manufacture, and distribution)\n\nIncident Time:\n05-09-2026 00:17:03 UTC\n\n` +
    `Description of Incident Time:\nThe incident date refers to the approximate date and time Google became aware of the\nreported material.\n\n` +
    `Suspect\n\nName:\nJordan Example\n\nMobile Phone:\n+15555550123 (Verified 05-01-2026 02:22:52 UTC)\n\nDate of Birth:\n01-02-1990\n\n` +
    `Email Address:\njordan@example.com (Verified)\n\nEmail Address:\njordan.alt@example.com\n\n` +
    ipBlocks.join('\n') +
    `\nDevice ID (IMEI):\n356938035643809\n05-01-2026 06:54:05 UTC\n\nDevice ID (SERIAL):\nSYNTHSERIAL0001\n05-01-2026 06:54:05 UTC\n` + FOOT(17) +
    `Source Information:\n \n\nAdditional Information:\nDevice Information:\nAndroid ID: 1234567890123456789\nModel: T767W\nManufacturer: TCL\nCarrier: TCL\nCheckin IP: 198.51.100.77\n` +
    `Checkin Time: 2026-05-01 06:54:05\nPrevious Checkin Time: 2026-05-01 05:05:39\nHardware Information:\nHardware: Synth_Board\nHardware Type: IMEI\nHardware ID: 356938035643809\n\n` +
    `Additional Information Submitted by the Reporting ESP\n\nGoogle became aware of the reported content which was stored in its infrastructure\n\n` +
    `Uploaded File Information\n\nNumber of uploaded files:\n4\n\n` +
    // file 0: stacked Source Information table on the same page
    fileHead(0, 'VID_20260501_120000.mp4') + `(See Section B for further explanation)\n\nType\nValue\nEvent\nDate/Time\n\nIP Address\n2001:db8:a4d6:9000:5c1e:2b0f:9a20:1abc\nUpload\n05-01-2026 22:46:19 UTC\n\n` +
    // file 1: page break mid-file; the "Source Information:" labels land after the footer
    fileHead(1, 'IMG_20260502_120000_073.jpg') + FOOT(18) + `Source Information:\n \n\nSource Information:\n \n\n(See Section B for further explanation)\n\nType\nValue\nEvent\nDate/Time\n\nIP Address\n203.0.113.9\nUpload\n05-02-2026 23:40:50 UTC\n\n` +
    // file 2: the row on one line
    fileHead(2, 'VID_20260503_120000.mp4') + `\nIP Address 198.51.100.20 Upload 05-03-2026 01:02:03 UTC\n\n` +
    // file 3: IPv6 wrapped inside the table cell
    fileHead(3, 'VID_20260504_120000_514.mp4') + `\nType\nValue\nEvent\nDate/Time\n\nIP Address\n2001:db8:a4d6:9000:\n5c1e:2b0f:9a20:4abc\nUpload\n05-04-2026 23:58:22 UTC\n\n` +
    `Section B: Automated Information\n\nThis concludes Section B\n`;

// ── Fixture 2: one-line layout (classic pdf-parse output) ─────────────────
const ONELINE = [
    'CyberTipline Report 900000333',
    'Priority Level: 2',
    'Received by NCMEC on 04-01-2026 10:00:00 UTC',
    'Section A: Reported Information',
    'The following information was submitted to the CyberTipline by the Reporting ESP.',
    'Reporting Electronic Service Provider (ESP)',
    'Submitter: Point of Contact for Law Enforcement:',
    'Meta Platforms, Inc.',
    'Law Enforcement Response Team',
    'Business Address:',
    '1 Example Way',
    'Menlo Park, CA 94025 United States',
    'https://records.example.com/',
    'Incident Information',
    'Incident Type: Child Pornography (possession, manufacture, and distribution)',
    'Incident Time: 03-30-2026 12:00:00 UTC',
    'Suspect',
    'Name: Casey Sample',
    'Mobile Phone: 15555550199 (Verified)',
    'Email Address: casey@example.com (Verified)',
    'Screen/User Name: casey_s',
    'ESP User ID: 100000000001',
    'IP Address: 203.0.113.50 (Login)',
    'Port: 443',
    '03-29-2026 11:00:00 UTC',
    'IP Address: 2001:db8::50 (Upload)',
    '03-29-2026 11:05:00 UTC',
    'Additional Information: Account created 2020',
    'Uploaded File Information',
    'Number of uploaded files: 2',
    'Uploaded File Information',
    'Filename: photo_001.jpg',
    'MD5: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'Did Reporting ESP view entire contents of uploaded file? Yes',
    'Were entire contents of uploaded file publicly available? No',
    'Uploaded File Information',
    'Filename: photo_002.jpg',
    'MD5: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'Section B: Automated Information',
    'This concludes Section B',
    ''
].join('\n');

// ── 1. Stacked layout ─────────────────────────────────────────────────────
console.log('1. stacked layout (Google, MuPDF text)');
const S = parseCyberTip(STACKED, 'stacked.pdf');
eq(S.reportNumber, '900000222', 'report number');
eq(S.priorityLevel, 'E (Report submitted by a registered Electronic Service Provider)', 'priority');
eq(S.receivedDate, '05-10-2026 16:58:00 UTC', 'received');
eq(S.esp.name, 'Google', 'ESP name is not the "Point of Contact" label');
eq(S.esp.poc, 'Custodian of Records', 'ESP point of contact');
eq(S.incidentType, 'Child Pornography (possession, manufacture, and distribution)', 'incident type');
eq(S.incidentTime, '05-09-2026 00:17:03 UTC', 'incident time');
eq(S.persons.length, 1, 'exactly one person (the TOC "Suspect" line is not a person)');
const SP = S.persons[0] || { ipAddresses: [], deviceIds: [], emails: [], phones: [] };
eq(SP.role, 'Suspect', 'role');
eq(SP.name, 'Jordan Example', 'name (blank line after "Suspect")');
eq(SP.dob, '01-02-1990', 'DOB');
eq(SP.phones, ['+15555550123 (Verified 05-01-2026 02:22:52 UTC)'], 'phone');
eq(SP.emails, ['jordan@example.com (Verified)', 'jordan.alt@example.com'], 'emails');
eq(SP.ipAddresses.length, 25, '24 login IPs + 1 checkin IP');
eq(SP.ipAddresses.filter(x => !x.address).length, 0, 'no blank IP rows');
eq(SP.ipAddresses.filter(x => x.type === 'Login' && x.timestamp).length, 24, 'every login IP has its timestamp');
eq(SP.ipAddresses, SUSPECT_IPS, 'IP list exact (wrapped IPv6, own-line "(Login)", page footer, blank before timestamp)');
eq(SP.deviceIds, [
    { type: 'IMEI', value: '356938035643809', timestamp: '05-01-2026 06:54:05 UTC' },
    { type: 'SERIAL', value: 'SYNTHSERIAL0001', timestamp: '05-01-2026 06:54:05 UTC' }
], 'device IDs');
ok(/Checkin IP: 198\.51\.100\.77/.test(SP.additionalInfo), 'device information kept in Additional Information');
ok(!/Uploaded File Information|VID_2026|Google became aware/.test(SP.additionalInfo), 'Additional Information stops before the ESP comment / file list');

eq(S.uploadedFiles.length, 4, 'all 4 uploaded files kept');
eq(S.uploadedFiles.map(f => f.md5), MD5S, 'MD5s (value on the next line)');
eq(S.uploadedFiles.map(f => f.filename), [
    `Google-CT-RPT-900000222-${'e6'.repeat(12)}0-VID_20260501_120000.mp4`,
    `Google-CT-RPT-900000222-${'e6'.repeat(12)}1-IMG_20260502_120000_073.jpg`,
    `Google-CT-RPT-900000222-${'e6'.repeat(12)}2-VID_20260503_120000.mp4`,
    `Google-CT-RPT-900000222-${'e6'.repeat(12)}3-VID_20260504_120000_514.mp4`
], 'wrapped file names');
eq(S.uploadedFiles.map(f => f.viewedByESP), ['Yes', 'Yes', 'Yes', 'Yes'], 'ESP viewed');
eq(S.uploadedFiles.map(f => f.publicly), ['No', 'No', 'No', 'No'], 'publicly available');
eq(S.uploadedFiles.map(f => f.espCategorization), ['B1', 'B1', 'B1', 'B1'], 'ESP categorization');
eq(S.uploadedFiles.map(f => f.sourceIps), [
    [{ address: '2001:db8:a4d6:9000:5c1e:2b0f:9a20:1abc', event: 'Upload', timestamp: '05-01-2026 22:46:19 UTC' }],
    [{ address: '203.0.113.9', event: 'Upload', timestamp: '05-02-2026 23:40:50 UTC' }],
    [{ address: '198.51.100.20', event: 'Upload', timestamp: '05-03-2026 01:02:03 UTC' }],
    [{ address: '2001:db8:a4d6:9000:5c1e:2b0f:9a20:4abc', event: 'Upload', timestamp: '05-04-2026 23:58:22 UTC' }]
], 'upload IP per file (stacked table, after a page break, one line, wrapped IPv6)');

// ── 2. One-line layout (must keep working exactly as before) ──────────────
console.log('2. one-line layout (pdf-parse text)');
const O = parseCyberTip(ONELINE, 'oneline.pdf');
eq(O.reportNumber, '900000333', 'report number');
eq(O.esp.name, 'Meta Platforms, Inc.', 'ESP name');
eq(O.esp.poc, 'Law Enforcement Response Team', 'ESP point of contact');
eq(O.esp.url, 'https://records.example.com/', 'ESP url');
eq(O.incidentType, 'Child Pornography (possession, manufacture, and distribution)', 'incident type');
eq(O.persons.length, 1, 'one person');
const OP = O.persons[0] || { ipAddresses: [] };
eq(OP.name, 'Casey Sample', 'name');
eq(OP.phones, ['15555550199 (Verified)'], 'phone');
eq(OP.emails, ['casey@example.com (Verified)'], 'email');
eq(OP.screenNames, ['casey_s'], 'screen name');
eq(OP.userIds, ['100000000001'], 'user id');
eq(OP.ipAddresses, [
    { address: '203.0.113.50', type: 'Login', port: '443', timestamp: '03-29-2026 11:00:00 UTC' },
    { address: '2001:db8::50', type: 'Upload', port: '', timestamp: '03-29-2026 11:05:00 UTC' }
], 'IPs with port + timestamps');
eq(OP.deviceIds, [], 'no device IDs');
eq(OP.additionalInfo, 'Account created 2020', 'Additional Information does not swallow the file list');
eq(O.uploadedFiles.map(f => [f.filename, f.md5, f.viewedByESP, f.publicly]), [
    ['photo_001.jpg', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Yes', 'No'],
    ['photo_002.jpg', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '', '']
], 'uploaded files');
eq(O.uploadedFiles.map(f => f.sourceIps), [[], []], 'no upload IPs invented');

// ── 3. Detail view shows the new identifiers ──────────────────────────────
console.log('3. CyberTips detail view');
{
    const src = [
        liftFunction(DETAIL, 'function escHtmlSafe(s) {'),
        liftFunction(DETAIL, 'function ctRegisterSend(items) {'),
        liftFunction(DETAIL, 'function renderCyberTipDetail(idx) {'),
        'return renderCyberTipDetail;'
    ].join('\n');
    const render = new Function('getCyberTips', '_ctSrcBtn', '__ctSendRegistry', 'currentCase',
        'let __reg = __ctSendRegistry;\n' + src.replace(/__ctSendRegistry/g, '__reg'))(
        () => [S], () => '', [], { id: 'c1', caseNumber: 'T-1' });
    const html = render(0);
    ok(html.includes('2001:db8:a4d6:dc76:5c1e:2b0f:9a20:e50a'), 'wrapped IPv6 shown as one address');
    ok(html.includes('Jordan Example'), 'suspect name shown');
    ok(html.includes('IMEI: 356938035643809') && html.includes('SERIAL: SYNTHSERIAL0001'), 'device ID cards');
    ok(html.includes('NCMEC Files (4)'), 'files section counts 4');
    ok(html.includes('Upload IP: <span class="text-gray-300 font-mono">203.0.113.9</span>'), 'upload IP on the file card');
    ok(/Uploaded Files - Upload · 1 file/.test(html), 'upload IP identifier card');
    ok(html.includes('ESP category: <span class="text-gray-300">B1</span>'), 'ESP category on the file card');
    const loginCards = (html.match(/Suspect - Login/g) || []).length;
    eq(loginCards, 24, 'one card per login IP');
}

// ── 4. Send To: a device ID becomes a note, not a fake username ───────────
console.log('4. Send To wiring');
{
    const fn = liftFunction(DETAIL, 'function ctSendToConfirm() {');
    ok(/k === 'deviceid'[^\n]*appendNote\(/.test(fn), 'deviceid → appendNote');
    const daStart = DETAIL.indexOf("case 'cyberTips': {\n                    const ctData = _lsParse(".replace(/\n/g, DETAIL.includes('\r\n') ? '\r\n' : '\n'));
    ok(daStart > 0, 'DA report cyberTips case found');
    const da = DETAIL.slice(daStart, DETAIL.indexOf("case 'oversightImport': {", daStart));
    ok(/fieldBold\('Device IDs'/.test(da) && /fieldBold\('Upload IPs'/.test(da), 'DA report lists device IDs and upload IPs');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
