/* Discrub HTML export → DiscordHtmlExportParser (synthetic data only).
 * Markup mirrors Discrub's exportService.generateHTMLPageParts / exportDiscordShell. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const DiscordWarrantParser = require('../discord-warrant-parser');
const { DiscordHtmlExportParser, snowflakeToIso } = require('../discord-html-export-parser');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const P = DiscordWarrantParser.DiscordWarrantParser || DiscordWarrantParser;

const EPOCH = 1420070400000;
const sf = (iso) => (BigInt(Date.parse(iso) - EPOCH) << 22n).toString();

// ── Synthetic markup builders ───────────────────────────────────────────
const users = {
    '7001': { username: 'suspect', displayName: 'Sus' },
    '7002': { username: 'alice' },
    '7003': { username: 'bob' }
};
function msgFull({ id, uid, text, extra = '', reply = '', stamp = 'Jan 5, 2024 13:32' }) {
    return `<div class="date-divider" id="date-x"><span class="date-divider-text">Friday</span></div>
          <div class="message" id="msg-${id}" data-message-id="${id}">
            <div class="message-left">
              <img src="avatars/${uid}/abc.png" alt="${users[uid].username}" class="avatar" data-action="show-user" data-user-id="${uid}" style="cursor:pointer">
            </div>
            <div class="message-content">
              ${reply}
              <div class="message-header">
                <span class="author" data-action="show-user" data-user-id="${uid}" style="cursor:pointer">${users[uid].username}</span>
                <span class="timestamp">${stamp}</span>
              </div>
              <div class="message-text">${text}</div>
              ${extra}
            </div>
          </div>`;
}
function msgGrouped({ id, text, extra = '' }) {
    return `<div class="message message-grouped" id="msg-${id}" data-message-id="${id}">
            <div class="message-left"><span class="grouped-timestamp">13:33</span></div>
            <div class="message-content"><div class="message-text">${text}</div>${extra}</div>
          </div>`;
}
const attCard = (href, name) => `<div class="attachments">
   <div class="attachment-card">
     <img class="attachment-preview attachment-preview-img" src="${href}" alt="${name}" loading="lazy" data-action="open-lightbox" data-img-index="0" style="cursor:pointer">
     <div class="attachment-info">
       <div class="attachment-header"><span class="attachment-icon"><svg><path d="M0"/></svg></span>
         <a href="${href}" ${/^https?:/.test(href) ? 'target="_blank" rel="noopener noreferrer"' : ''} class="attachment-name">
           ${name}
         </a></div>
       <div class="attachment-meta"><span class="attachment-size">9 B</span><span class="attachment-badge local">Local</span></div>
     </div>
   </div></div>`;
function page({ title, rows, n, total, base, usersOnPage }) {
    const data = { page: { current: n, total, baseFilename: base }, users: usersOnPage, threads: {}, reactions: {} };
    return `
<!DOCTYPE html>
<html lang="en" class="export-theme-dark"><head><meta charset="UTF-8"><title>${title}${total > 1 ? ` - Page ${n} of ${total}` : ''}</title>
<style>.message{display:flex}</style></head>
<body>
  <div class="header" role="banner">
    <h1>#${title}</h1>
    <div class="meta">${rows.length} messages <span style="float: right;">Exported Jan 9, 2024</span></div>
    <div class="search-bar"><input class="search-input" id="search-input" type="text" /><select id="theme-select"><option>Dark</option></select></div>
  </div>
  <main class="container" role="main">
    ${rows.join('\n')}
  </main>
  <nav class="bottom-nav" role="navigation"><a class="nav-btn" href="${base}-page-${n + 1}.html">Next →</a></nav>
  <footer>Discrub</footer>
  <script type="application/json" id="export-data">${JSON.stringify(data)}</script>
  <script>(function(){ var x = "<id>"; })();</script>
</body></html>`;
}
function shell({ serverName, channels, isDM, guildId }) {
    const items = channels.map(c => isDM
        ? `<div class="channel-item dm-item" data-channel-id="${c.id}"><div class="dm-avatar-placeholder">${c.name[0].toUpperCase()}</div><span class="channel-name">${c.name}</span></div>`
        : `<div class="channel-item" data-channel-id="${c.id}" data-filename="${c.filename}"><span class="channel-hash">#</span><span class="channel-name">${c.name}</span></div>`).join('');
    const icon = guildId ? `<img src="https://cdn.discordapp.com/icons/${guildId}/iconhash.png" alt="${serverName}" class="server-icon-img">` : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${serverName} · Bulk Export</title><style></style></head>
<body><div class="discord-shell"><div class="server-sidebar"><div class="server-icon">${icon}</div></div>
<div class="channel-sidebar"><div class="channel-list">${items}</div></div>
<div class="shell-main"><iframe id="channel-frame" src="${channels[0].filename}" class="shell-iframe"></iframe></div></div>
<script>
(function() {
  'use strict';
  var channels = ${JSON.stringify(channels.map(c => ({ id: c.id, name: c.name, filename: c.filename })))};
  var isBulk = true;
})();
</script></body></html>`;
}
const README = '<html><head><title>README</title></head><body><h1>Discrub Export</h1><p class="meta">Format: HTML (Discord layout) · Generated by <a href="https://github.com/prathercc/discrub">Discrub</a></p><ul><li><code>avatars/</code>: user avatars</li><li><code>media/</code>: downloaded media</li></ul></body></html>';

// ── IDs / times ────────────────────────────────────────────────────────
const T = {
    a1: sf('2024-01-05T13:32:11.000Z'), a2: sf('2024-01-05T13:33:00.000Z'), a3: sf('2024-01-05T13:34:30.000Z'),
    a4: sf('2024-01-06T09:00:00.000Z'), a5: sf('2024-01-06T09:05:00.000Z'), sys: sf('2024-01-06T10:00:00.000Z'),
    b1: sf('2024-02-01T20:00:00.000Z'), b2: sf('2024-02-01T20:01:00.000Z')
};
const DM_ALICE = '880000000000000001', DM_BOB = '880000000000000002';

// alice/ — two pages, NEWEST FIRST (Discrub's default sort), page overlap duplicate
const alicePage1 = page({
    title: 'alice', n: 1, total: 2, base: 'alice', usersOnPage: { '7001': users['7001'], '7002': users['7002'] },
    rows: [
        `<div class="system-message" data-message-id="${T.sys}" data-system-kind="pin"><span class="system-message-icon"></span><span class="system-message-text"><strong>alice</strong> pinned a message. <span class="system-message-timestamp">1/6/24, 10:00 AM</span></span></div>`,
        msgFull({ id: T.a5, uid: '7001', text: 'see you &amp; bring the <strong>stuff</strong><br>at 5', extra: `<div class="reactions"><span class="reaction" data-message-id="${T.a5}"><img class="emoji" alt="👍" src="emojis/x.png"><span class="reaction-count">2</span></span></div>`,
            reply: `<div class="reply-bar" data-action="jump-to-reply" data-target-id="${T.a4}"><span class="reply-avatar-small"></span><span class="reply-author">alice</span><span class="reply-content">where?</span></div>` }),
        msgFull({ id: T.a4, uid: '7002', text: 'where? <span class="edited-indicator" title="Edited Jan 6">(edited)</span>' })
    ]
});
const alicePage2 = page({
    title: 'alice', n: 2, total: 2, base: 'alice', usersOnPage: { '7001': users['7001'], '7002': users['7002'] },
    rows: [
        msgFull({ id: T.a4, uid: '7002', text: 'where? <span class="edited-indicator" title="Edited Jan 6">(edited)</span>' }), // overlap duplicate
        msgFull({ id: T.a3, uid: '7002', text: '(no content)', extra: attCard('media/attachments/2_1704461670000_3.jpg', 'IMG_0042.jpg') + attCard('https://cdn.discordapp.com/attachments/880000000000000001/111/notes.pdf', 'notes.pdf') }),
        msgFull({ id: T.a1, uid: '7001', text: 'hello <span class="mention">@alice</span>' }),
        msgGrouped({ id: T.a2, text: 'link: <a href="https://example.com/x">https://example.com/x</a>',
            extra: `<div class="embeds"><div class="embed"><a class="embed-title" href="https://example.com/x">Example Domain</a><div class="embed-description">An example page</div><img class="embed-thumbnail" src="media/embed-thumbnails/1_1704461580000_2.png"></div></div>` })
    ]
});
const bobPage1 = page({
    title: 'bob', n: 1, total: 1, base: 'bob', usersOnPage: { '7001': users['7001'], '7003': users['7003'] },
    rows: [
        msgFull({ id: T.b1, uid: '7003', text: 'yo' }),
        msgFull({ id: T.b2, uid: '7001', text: 'later', extra: `<div class="forward-block" data-message-snapshot="true"><div class="forward-header"><span class="forward-label">Forwarded</span></div><div class="forward-content">original words</div><div class="forward-attachments"><a class="forward-attachment" href="media/attachments/5_1706817660000_9.mp4">clip.mp4</a></div></div>` })
    ]
});

function buildDmZip(prefix) {
    const z = new AdmZip();
    const add = (n, s) => z.addFile(prefix + n, Buffer.from(s));
    add('README.html', README);
    add('shell.html', shell({ serverName: 'Direct Messages', isDM: true, channels: [
        { id: DM_ALICE, name: 'alice', filename: 'alice/alice-page-1.html' },
        { id: DM_BOB, name: 'bob', filename: 'bob/bob-page-1.html' }
    ] }));
    add('alice/alice-page-1.html', alicePage1);
    add('alice/alice-page-2.html', alicePage2);
    add('alice/media/attachments/2_1704461670000_3.jpg', 'JPEGBYTES');
    add('alice/media/embed-thumbnails/1_1704461580000_2.png', 'PNGBYTES');
    add('alice/avatars/7001/abc.png', 'AV');
    add('alice/avatars/7002/abc.png', 'AV');
    add('bob/bob-page-1.html', bobPage1);
    add('bob/media/attachments/5_1706817660000_9.mp4', 'MP4BYTES');
    add('bob/avatars/7003/abc.png', 'AV');
    add('stray.bin', 'x');
    return z;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwhtml-'));

(async () => {
    console.log('\n=== Detection ===');
    const dmZip = buildDmZip('Export-Case-7/');
    const dmPath = path.join(tmp, 'discrub-dms.zip');
    dmZip.writeZip(dmPath);
    const names = dmZip.getEntries().map(e => e.entryName);
    const det = DiscordHtmlExportParser.detect(names);
    ok('detect matches', det.match);
    eq('root under wrapper', det.root, 'Export-Case-7/');
    eq('two conversation folders', det.channels.map(c => c.folder), ['Export-Case-7/alice/', 'Export-Case-7/bob/']);
    eq('pages sorted', det.channels[0].pages.map(p => p.n), [1, 2]);
    ok('LE detector does not claim it', !require('../discord-return-parser').DiscordReturnParser.detect(names).match);
    ok('not detected: random html site', !DiscordHtmlExportParser.detect(['site/index.html', 'site/about.html', 'site/img/a.png']).match);
    ok('not detected: page name differs, no assets', !DiscordHtmlExportParser.detect(['docs/manual-page-1.html']).match);
    ok('detected: older _page_ naming with assets', DiscordHtmlExportParser.detect(['x/chan_page_1.html', 'x/media/attachments/a.jpg']).match);
    ok('dispatcher: zip detected', await P.isDiscordWarrantZip(dmPath));
    ok('dispatcher: buffer detected', P.isDiscordWarrantZip(fs.readFileSync(dmPath)));

    console.log('\n=== Parse (zip, inline) ===');
    const extractDir = path.join(tmp, 'extract');
    const r = await new P().parseZip(dmPath, { extractDir });
    eq('format', r.format, 'html-export');
    eq('label', r.formatLabel, 'Discord HTML Export (Discrub)');
    eq('channels', r.stats.channelCount, 2);
    eq('messages (duplicate dropped, system kept)', r.stats.messageCount, 8);
    eq('subscriber inferred', [r.subscriber.id, r.subscriber.username, r.subscriber.inferred], ['7001', 'suspect', true]);
    eq('subscriber display name', r.subscriber.globalName, 'Sus');
    ok('warning: not Discord-authenticated', r.diagnostics.warnings.some(w => /not by Discord/.test(w)));
    ok('warning: account holder inferred', r.diagnostics.warnings.some(w => /Account holder inferred as suspect/.test(w)));

    const alice = r.channels.find(c => c.channelName === 'alice');
    const bob = r.channels.find(c => c.channelName === 'bob');
    ok('alice channel found', !!alice);
    eq('channel id from shell', [alice.channelId, bob.channelId], [DM_ALICE, DM_BOB]);
    eq('channel type', alice.channelType, 'DM');
    eq('recipients', alice.recipients, [{ id: '7002', username: 'alice' }]);
    const am = alice.messages;
    eq('oldest first by snowflake', am.map(m => m.id), [T.a1, T.a2, T.a3, T.a4, T.a5, T.sys]);
    eq('timestamp from snowflake', am[0].timestamp, '2024-01-05T13:32:11.000Z');
    eq('raw display timestamp kept', am[0].rawTimestamp, 'Jan 5, 2024 13:32');
    eq('mention text', am[0].contents, 'hello @alice');
    eq('grouped inherits author', [am[1].authorId, am[1].username, am[1].direction], ['7001', 'suspect', 'outgoing']);
    ok('embed text appended', /\[Embed\] Example Domain/.test(am[1].contents), am[1].contents);
    eq('embed thumbnail linked', am[1].media && am[1].media.map(x => x.kind), ['embed']);
    eq('(no content) placeholder dropped', am[2].contents, '');
    eq('attachment linked w/ original name', am[2].media && am[2].media.map(x => [x.fileName, x.mimeType]), [['IMG_0042.jpg', 'image/jpeg']]);
    ok('attachment extracted to disk', fs.existsSync(am[2].media[0].diskPath) && fs.readFileSync(am[2].media[0].diskPath, 'utf8') === 'JPEGBYTES');
    eq('external attachment URL kept', am[2].attachments, 'https://cdn.discordapp.com/attachments/880000000000000001/111/notes.pdf');
    eq('incoming direction', am[2].direction, 'incoming');
    eq('edited marker', am[3].contents, 'where? (edited)');
    ok('reply line', /^↪ Reply to alice: "where\?" \(message \d+\)\n/.test(am[4].contents), am[4].contents);
    ok('entities decoded + <br> newline', /see you & bring the stuff\nat 5/.test(am[4].contents), am[4].contents);
    ok('reactions', /\[Reactions\] 👍 2/.test(am[4].contents), am[4].contents);
    ok('system message', /^\[System\] alice pinned a message\.$/.test(am[5].contents), am[5].contents);
    eq('system message is not a participant', alice.participants.map(p => p.username).sort(), ['alice', 'suspect']);
    const bm = bob.messages;
    ok('forwarded content', /\[Forwarded message\]\noriginal words/.test(bm[1].contents), bm[1].contents);
    eq('forwarded attachment linked', bm[1].media && bm[1].media.map(x => [x.fileName, x.mimeType]), [['clip.mp4', 'video/mp4']]);
    eq('media extracted', r.stats.mediaCount, 3);
    eq('media linked', r.stats.mediaLinked, 3);
    eq('unmatched = only the stray file', r.diagnostics.unmatchedFiles, ['Export-Case-7/stray.bin']);
    eq('first/last message', [alice.firstMessage, alice.lastMessage], ['2024-01-05T13:32:11.000Z', '2024-01-06T10:00:00.000Z']);

    console.log('\n=== Streaming sink (lazy) ===');
    const sinkLog = [];
    const sink = { beginChannel: (id) => sinkLog.push(['b', id]), write: (m) => sinkLog.push(['w', m.id]), endChannel: () => sinkLog.push(['e']) };
    const lz = await new P().parseZip(dmPath, { extractDir, messageSink: sink, inlineBudget: 3 });
    ok('lazy once over budget', lz._lazy === true);
    ok('no inline rows when lazy', lz.channels.every(c => c.messages.length === 0));
    eq('all rows streamed', sinkLog.filter(x => x[0] === 'w').length, 8);
    eq('channel framing', sinkLog.filter(x => x[0] !== 'w').map(x => x.join(':')), [`b:${DM_ALICE}`, 'e', `b:${DM_BOB}`, 'e']);

    console.log('\n=== Server export with a thread (no shell → folder ids) ===');
    const g = new AdmZip();
    const gid = '990000000000000777';
    const th = sf('2024-03-01T12:00:00.000Z');
    g.addFile('README.html', Buffer.from(README));
    g.addFile('shell.html', Buffer.from(shell({ serverName: 'Test Guild', isDM: false, guildId: gid, channels: [{ id: '990000000000000101', name: 'general', filename: 'general/general-page-1.html' }] })));
    g.addFile('general/general-page-1.html', Buffer.from(page({ title: 'general', n: 1, total: 1, base: 'general', usersOnPage: users, rows: [
        msgFull({ id: sf('2024-03-01T11:00:00.000Z'), uid: '7002', text: 'plan thread', extra: '<div class="thread-banner"><a href="threads/plans_990000000000000555.html" class="thread-banner-link"><span class="thread-banner-text">plans</span></a></div>' }),
        msgFull({ id: sf('2024-03-01T11:01:00.000Z'), uid: '7003', text: 'ok' }),
        msgFull({ id: sf('2024-03-01T11:02:00.000Z'), uid: '7001', text: 'k' })
    ] })));
    g.addFile('general/threads/plans_990000000000000555.html', Buffer.from(page({ title: 'plans', n: 1, total: 1, base: 'general', usersOnPage: users, rows: [
        msgFull({ id: th, uid: '7002', text: 'pic', extra: attCard('../media/attachments/0_1709294400000_1.png', 'map.png') })
    ] })));
    g.addFile('general/media/attachments/0_1709294400000_1.png', Buffer.from('PNG'));
    const gPath = path.join(tmp, 'guild.zip');
    g.writeZip(gPath);
    const gr = await new P().parseZip(gPath, { extractDir: path.join(tmp, 'gx') });
    eq('guild channels', gr.channels.map(c => [c.channelId, c.channelName, c.channelType]),
        [['990000000000000101', '#general', 'GUILD_TEXT'], ['990000000000000555', '🧵 plans', 'GUILD_THREAD']]);
    eq('guild name/id from shell', [gr.channels[0].guildName, gr.channels[0].guildId], ['Test Guild', gid]);
    eq('server list', gr.servers.map(s => [s.id, s.name, s.channelCount, s.threadCount]), [[gid, 'Test Guild', 1, 1]]);
    ok('thread banner noted', /\[Thread started\] plans/.test(gr.channels[0].messages[0].contents));
    eq('thread ../media resolved', gr.channels[1].messages[0].media && gr.channels[1].messages[0].media[0].fileName, 'map.png');
    ok('single conversation: holder unknown → warn', gr.diagnostics.warnings.some(w => /could not be determined/.test(w)));
    ok('unknown holder → all incoming', gr.channels[0].messages.every(m => m.direction === 'incoming'));

    console.log('\n=== Folder parse ===');
    const folder = path.join(tmp, 'unzipped');
    new AdmZip(dmPath).extractAllTo(folder, true);
    const exportRoot = path.join(folder, 'Export-Case-7');
    ok('export root folder detected', P.isDiscordWarrantFolder(exportRoot));
    ok('parent of export root NOT detected', !P.isDiscordWarrantFolder(folder));
    ok('conversation folder detected', P.isDiscordWarrantFolder(path.join(exportRoot, 'alice')));
    const f = await new P().parseFolder(exportRoot, { extractDir: path.join(tmp, 'fx') });
    eq('folder routed', f.format, 'html-export');
    eq('folder messages', f.stats.messageCount, 8);
    eq('folder channel ids', f.channels.map(c => c.channelId), [DM_ALICE, DM_BOB]);
    const one = await new P().parseFolder(path.join(exportRoot, 'alice'), { extractDir: path.join(tmp, 'fx1') });
    eq('single folder routed', one.format, 'html-export');
    eq('single folder: one channel, 6 msgs', [one.stats.channelCount, one.stats.messageCount], [1, 6]);
    eq('single folder: synthetic id + name', [one.channels[0].channelId, one.channels[0].channelName], ['discrub:alice', 'alice']);
    eq('single folder: holder from DM-name rule', one.subscriber.id, '7001');
    eq('single folder: media linked', one.stats.mediaLinked, 2);

    console.log('\n=== Helpers ===');
    eq('snowflakeToIso', snowflakeToIso(T.b1), '2024-02-01T20:00:00.000Z');
    eq('snowflakeToIso rejects junk', snowflakeToIso('unknown'), null);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
