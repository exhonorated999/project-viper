/* Integration test: real ZIP -> DiscordWarrantParser dispatch -> return parser */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const DiscordWarrantParser = require('../discord-warrant-parser');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const P = DiscordWarrantParser.DiscordWarrantParser || DiscordWarrantParser;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwint-'));

// ── Build a realistic LE-return ZIP, nested inside a wrapper folder ──
const retZip = new AdmZip();
const HDR = 'Channel ID,Message ID,Author ID,Timestamp,Username,Contents,Attachments\n';
retZip.addFile('LEA-2026-114/messages/dms/8001.csv', Buffer.from(
    HDR +
    '8001,900000000000000001,7001,1704461531,suspect,"meet me at 5, bring it",\n' +
    '8001,900000000000000002,7002,1704461999,other,ok,"https://cdn.discordapp.com/attachments/8001/att77/photo.jpg"\n'
));
retZip.addFile('LEA-2026-114/messages/servers/8002.csv', Buffer.from(
    HDR + '8002,900000000000000003,7001,1704465131,suspect,server chatter,\n'
));
retZip.addFile('LEA-2026-114/servers/5150.json', Buffer.from(JSON.stringify({ id: '5150', name: 'Private Server', owner_id: '7001' })));
retZip.addFile('LEA-2026-114/relationships_7001.csv', Buffer.from('User ID,Username,Relationship\n7002,other,friend\n'));
retZip.addFile('LEA-2026-114/subscriber_info.csv', Buffer.from('Username,Email,Phone,ID\nsuspect,s@example.com,+15551230000,7001\n'));
retZip.addFile('LEA-2026-114/attachments/att77/photo.jpg', Buffer.from('JPEGBYTES'));
const retPath = path.join(tmp, 'return.zip');
retZip.writeZip(retPath);

// ── Build a Discord Data Package ZIP for the regression check ──
const ddpZip = new AdmZip();
ddpZip.addFile('README.txt', Buffer.from('Your Discord Data Package\nThanks for waiting.'));
ddpZip.addFile('Account/user.json', Buffer.from(JSON.stringify({ id: '7001', username: 'suspect', email: 's@example.com' })));
ddpZip.addFile('Messages/index.json', Buffer.from(JSON.stringify({ '8001': 'DM with other' })));
ddpZip.addFile('Messages/c8001/channel.json', Buffer.from(JSON.stringify({ id: '8001', type: 1 })));
ddpZip.addFile('Messages/c8001/messages.json', Buffer.from(JSON.stringify([
    { ID: '900000000000000001', Timestamp: '2024-01-05 13:32:11', Contents: 'hello', Attachments: '' }
])));
const ddpPath = path.join(tmp, 'ddp.zip');
ddpZip.writeZip(ddpPath);

(async () => {
    console.log('\n=== Detection routing ===');
    ok('LE return ZIP detected', await P.isDiscordWarrantZip(retPath));
    ok('Data Package ZIP still detected', await P.isDiscordWarrantZip(ddpPath));

    console.log('\n=== LE return parse via public entry point ===');
    const extractDir = path.join(tmp, 'extract');
    const r = await new P().parseZip(retPath, { extractDir });
    eq('routed to return parser', r.format, 'le-return');
    eq('wrapper folder stripped', r.detectedRoot, 'LEA-2026-114/');
    eq('channels', r.stats.channelCount, 2);
    eq('messages', r.stats.messageCount, 3);
    eq('servers', r.stats.serverCount, 1);
    eq('relationships', r.stats.relationshipCount, 1);
    eq('subscriber email', r.subscriber.email, 's@example.com');
    eq('media extracted', r.stats.mediaCount, 1);
    eq('media linked', r.stats.mediaLinked, 1);
    ok('has diagnostics', !!r.diagnostics && Array.isArray(r.diagnostics.warnings));

    console.log('\n=== Data Package regression ===');
    const d = await new P().parseZip(ddpPath, { extractDir });
    eq('routed to data-package parser', d.format, 'data-package');
    eq('ddp subscriber', d.subscriber && d.subscriber.username, 'suspect');
    eq('ddp channels', d.stats.channelCount, 1);
    eq('ddp messages', d.stats.messageCount, 1);
    ok('ddp diagnostics present', !!d.diagnostics);
    ok('ddp warns about empty activity',
        d.diagnostics.warnings.some(w => /Activity/.test(w)));

    console.log('\n=== Folder parse ===');
    const folder = path.join(tmp, 'unzipped');
    new AdmZip(retPath).extractAllTo(folder, true);
    ok('LE return folder detected', P.isDiscordWarrantFolder(path.join(folder, 'LEA-2026-114')));
    ok('LE return folder detected from parent', P.isDiscordWarrantFolder(folder));
    const f = await new P().parseFolder(folder, { extractDir });
    eq('folder routed correctly', f.format, 'le-return');
    eq('folder messages', f.stats.messageCount, 3);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
