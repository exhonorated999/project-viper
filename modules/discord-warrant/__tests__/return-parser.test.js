/* Throwaway test harness for discord-return-parser.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DiscordReturnParser, parseCsv } = require('../discord-return-parser');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

console.log('\n=== 1. CSV reader ===');
eq('simple', parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('quoted comma', parseCsv('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']]);
eq('embedded newline', parseCsv('a,b\n"line1\nline2",2'), [['a', 'b'], ['line1\nline2', '2']]);
eq('escaped quote', parseCsv('a\n"he said ""hi"""'), [['a'], ['he said "hi"']]);
eq('BOM stripped', parseCsv('\uFEFFa,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('CRLF', parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
eq('trailing newline no phantom row', parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);

console.log('\n=== 2. Timestamps ===');
const N = DiscordReturnParser.normalizeTs;
eq('unix seconds', N('1704461531'), '2024-01-05T13:32:11.000Z');
eq('unix millis', N('1704461531000'), '2024-01-05T13:32:11.000Z');
eq('iso Z', N('2024-01-05T13:32:11Z'), '2024-01-05T13:32:11.000Z');
eq('iso offset', N('2024-01-05T08:32:11-05:00'), '2024-01-05T13:32:11.000Z');
eq('naive treated UTC', N('2024-01-05 13:32:11'), '2024-01-05T13:32:11.000Z');
eq('trailing UTC word', N('2024-01-05 13:32:11 UTC'), '2024-01-05T13:32:11.000Z');
eq('empty', N(''), null);
eq('garbage', N('not a date'), null);
ok('snowflake via normalizeTs', N('1192823593642000000') !== null);
eq('snowflake exact', DiscordReturnParser.snowflakeToIso('175928847299117063'), '2016-04-30T11:18:25.796Z');

console.log('\n=== 3. Column mapping ===');
const M = DiscordReturnParser.mapMessageColumns;
eq('7-col positional (unknown header)', M(['a', 'b', 'c', 'd', 'e', 'f', 'g']).source, 'positional-7col');
eq('compact positional', M(['a', 'b', 'c', 'd']).source, 'positional-compact');
const hdr = M(['Channel ID', 'Message ID', 'Author ID', 'Timestamp', 'Username', 'Contents', 'Attachments']);
eq('header recognized', hdr.source, 'header');
eq('header maps contents', hdr.map.contents, 5);
const shuffled = M(['Timestamp', 'Contents', 'Username', 'Message ID', 'Author ID', 'Channel ID', 'Attachments']);
eq('reordered header respected', shuffled.map.contents, 1);
eq('reordered header timestamp', shuffled.map.timestamp, 0);

console.log('\n=== 4. Detection ===');
const RETURN_FILES = [
    'messages/dms/111.csv',
    'messages/servers/222.csv',
    'servers/999.json',
    'relationships_555.csv',
    'attachments/abc123/pic.jpg'
];
const DDP_FILES = [
    'README.txt', 'Account/user.json', 'Messages/index.json',
    'Messages/c111/messages.json', 'Activity/analytics/events-1.json'
];
ok('flat return detected', DiscordReturnParser.detect(RETURN_FILES).match);
eq('flat root empty', DiscordReturnParser.detect(RETURN_FILES).root, '');
const nested = RETURN_FILES.map(f => 'CaseA/' + f);
ok('nested 1 detected', DiscordReturnParser.detect(nested).match);
eq('nested 1 root', DiscordReturnParser.detect(nested).root, 'CaseA/');
const nested2 = RETURN_FILES.map(f => 'CaseA/req-778899/' + f);
eq('nested 2 root', DiscordReturnParser.detect(nested2).root, 'CaseA/req-778899/');
ok('DDP NOT detected as return', !DiscordReturnParser.detect(DDP_FILES).match);
ok('backslash paths detected', DiscordReturnParser.detect(RETURN_FILES.map(f => f.replace(/\//g, '\\'))).match);
ok('UPPERCASE dirs detected', DiscordReturnParser.detect(RETURN_FILES.map(f => f.toUpperCase())).match);
ok('messages-only insufficient alone', !DiscordReturnParser.detect(['messages/foo/1.csv']).match);
ok('messages+servers sufficient', DiscordReturnParser.detect(['messages/dms/1.csv', 'servers/9.json']).match);

console.log('\n=== 5. Full parse ===');
const files = {
    'req-1/messages/dms/111.csv':
        'Channel ID,Message ID,Author ID,Timestamp,Username,Contents,Attachments\n' +
        '111,900000000000000001,7001,1704461531,badguy,"hello, there",\n' +
        '111,900000000000000002,7002,2024-01-05T14:00:00Z,victim,"multi\nline text",' +
        '"https://cdn.discordapp.com/attachments/111/abc123/pic.jpg"\n',
    'req-1/messages/servers/222.csv':
        'Channel ID,Message ID,Author ID,Timestamp,Username,Contents,Attachments\n' +
        '222,900000000000000003,7001,1704465131,badguy,server msg,\n',
    'req-1/messages/unknown/333.csv':
        // No header — positional fallback must kick in AND keep row 1
        '333,900000000000000004,7003,1704468731,ghost,orphan message,\n',
    'req-1/messages/dms/444.csv':
        // 7 cols but an unrecognized header — must fall back positionally and
        // still discard row 1, because row 1 is clearly not data.
        'Col A,Col B,Col C,Col D,Col E,Col F,Col G\n' +
        '444,900000000000000005,7004,1704472331,newguy,hi there,\n',
    'req-1/servers/999.json': JSON.stringify({ id: '999', name: 'Bad Server', description: 'd', owner_id: '7001', channels: [{ id: '222' }] }),
    'req-1/relationships_7001.csv': 'User ID,Username,Relationship\n7002,victim,friend\n7003,ghost,blocked\n',
    'req-1/subscriber_info.csv': 'Username,Email,Phone,Registration Date,ID\nbadguy,bad@example.com,+15550001111,1600000000,7001\n',
    'req-1/attachments/abc123/pic.jpg': Buffer.from('JPEGDATA'),
    'req-1/notes_from_discord.txt': 'unrelated file'
};
const entryNames = Object.keys(files);
const readText = (n) => (Buffer.isBuffer(files[n]) ? null : files[n]);
const readBinary = (n) => (Buffer.isBuffer(files[n]) ? files[n] : Buffer.from(String(files[n]), 'utf8'));

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drtest-'));

(async () => {
    const p = new DiscordReturnParser();
    const r = await p.parse({ entryNames, readText, readBinary, options: { extractDir } });

    eq('format', r.format, 'le-return');
    eq('root detected', r.detectedRoot, 'req-1/');
    eq('channel count', r.stats.channelCount, 4);
    eq('message count', r.stats.messageCount, 5);
    eq('server count', r.stats.serverCount, 1);
    eq('relationship count', r.stats.relationshipCount, 2);

    const dm = r.channels.find(c => c._sourceFile === 'messages/dms/111.csv');
    eq('dm channel id', dm.id, '111');
    eq('dm type', dm.type, 'DM');
    eq('quoted comma preserved', dm.messages[0].contents, 'hello, there');
    eq('unix ts normalized', dm.messages[0].timestamp, '2024-01-05T13:32:11.000Z');
    eq('multiline preserved', dm.messages[1].contents, 'multi\nline text');
    eq('iso ts normalized', dm.messages[1].timestamp, '2024-01-05T14:00:00.000Z');
    eq('author id', dm.messages[0].authorId, '7001');
    eq('username', dm.messages[0].username, 'badguy');

    const unk = r.channels.find(c => c._sourceFile === 'messages/unknown/333.csv');
    eq('headerless used positional', unk._columnSource, 'positional-7col');
    eq('headerless kept its only row', unk.messageCount, 1);
    eq('headerless row 1 not eaten', unk.messages[0].username, 'ghost');

    eq('server name', r.servers[0].name, 'Bad Server');
    eq('server owner', r.servers[0].ownerId, '7001');

    eq('subscriber username', r.subscriber.username, 'badguy');
    eq('subscriber email', r.subscriber.email, 'bad@example.com');
    eq('subscriber phone', r.subscriber.phone, '+15550001111');
    eq('subscriber id', r.subscriber.id, '7001');
    eq('registration normalized', r.subscriber.registrationDate, '2020-09-13T12:26:40.000Z');
    eq('relationships attached', r.subscriber.relationships.length, 2);

    eq('media extracted', r.stats.mediaCount, 1);
    eq('media linked to message', r.stats.mediaLinked, 1);
    ok('linked media has diskPath', !!(dm.messages[1].media && dm.messages[1].media[0].diskPath));
    ok('extracted file on disk', fs.existsSync(dm.messages[1].media[0].diskPath));
    eq('mime detected', dm.messages[1].media[0].mimeType, 'image/jpeg');

    eq('unmatched surfaced', r.diagnostics.unmatchedFiles, ['req-1/notes_from_discord.txt']);
    ok('warns about headerless file',
        r.diagnostics.warnings.some(w => /333\.csv/.test(w) && /positional/.test(w)));

    const bogusHdr = r.channels.find(c => c._sourceFile === 'messages/dms/444.csv');
    eq('unrecognized header discarded', bogusHdr.messageCount, 1);
    eq('unrecognized header kept real row', bogusHdr.messages[0].username, 'newguy');
    ok('warns it discarded a header row',
        r.diagnostics.warnings.some(w => /444\.csv/.test(w) && /discarded/.test(w)));

    console.log('\n=== 6. Degenerate inputs ===');
    const empty = await p.parse({ entryNames: [], readText: () => null, readBinary: () => null, options: {} });
    eq('empty input no crash', empty.stats.messageCount, 0);
    ok('empty input warns loudly',
        empty.diagnostics.warnings.some(w => /No messages, servers, or relationships/.test(w)));

    const noExtract = await p.parse({ entryNames, readText, readBinary, options: {} });
    ok('warns when attachments present but no extractDir',
        noExtract.diagnostics.warnings.some(w => /no extract directory/i.test(w)));

    const badJson = await p.parse({
        entryNames: ['messages/dms/1.csv', 'servers/9.json'],
        readText: (n) => (n.endsWith('.json') ? '{not json' : 'Channel ID,Message ID,Author ID,Timestamp,Username,Contents,Attachments\n1,2,3,1704461531,u,hi,\n'),
        readBinary: () => null, options: {}
    });
    ok('bad JSON warns not throws', badJson.diagnostics.warnings.some(w => /not valid JSON/.test(w)));
    eq('bad JSON still parsed messages', badJson.stats.messageCount, 1);

    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})();
