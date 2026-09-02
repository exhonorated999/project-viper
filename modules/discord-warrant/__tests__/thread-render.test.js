/**
 * Thread-rendering smoke test.
 *
 * The 5.1.6 bug was NOT a parse failure — 541,831 messages were read
 * correctly — it was a contract mismatch: the return parser emitted
 * id/name/type while discord-warrant-ui.js reads channelId/channelName/
 * channelType.  Every channel row therefore rendered with a blank name and
 * `_openChannel('')` never matched a channel, so no thread ever opened.
 *
 * This test drives the REAL UI class against the REAL parser output with no
 * DOM, because every render method here is a pure string builder.  It asserts
 * the things a screenshot would have caught:
 *   - the channel row carries a name and a clickable, non-empty id
 *   - opening that id actually resolves to a thread
 *   - the thread renders chat bubbles, both directions, with day dividers
 *
 * Run:  set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *       modules\discord-warrant\__tests__\thread-render.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { DiscordReturnParser } = require('../discord-return-parser');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (n, a, b) => ok(n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`),
                           JSON.stringify(a) === JSON.stringify(b));
const has = (n, hay, needle) => ok(n + (String(hay).includes(needle) ? '' : ` -> missing ${JSON.stringify(needle)}`),
                                   String(hay).includes(needle));

// ── Load the UI class without a browser ────────────────────────────────
// discord-warrant-ui.js is a classic script that ends in `window.X = X`.
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'discord-warrant-ui.js'), 'utf8');
const sandbox = { window: {}, document: { getElementById: () => null, querySelectorAll: () => [] }, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(uiSrc, sandbox, { filename: 'discord-warrant-ui.js' });
const DiscordWarrantUI = sandbox.window.DiscordWarrantUI;
ok('UI class loaded', typeof DiscordWarrantUI === 'function');

// ── Fixture: a small but structurally real LE return ───────────────────
const files = {
    'session/info.txt': [
        'User ID: 7001',
        'Username: badguy#0',
        'Email: bad@example.com',
        'Registration date (UTC): 2020-09-13 12:26:40',
        '2024-01-05 13:32:11 8.8.8.8'
    ].join('\n'),
    'servers/999.json': JSON.stringify({ id: '999', name: 'Bad Server', channels: { '222': 'general' } }),
    'messages/dms/111.csv':
        '111,900000000000000001,7001,2024-01-05T13:32:11+00:00,badguy#0,"hello, there",,\n' +
        '111,900000000000000002,7002,2024-01-05T13:33:00+00:00,victim#0,"who is this?",,\n' +
        '111,900000000000000003,7002,2024-01-08T09:00:00+00:00,victim#0,"next day message",,\n',
    'messages/servers/222.csv':
        '222,900000000000000004,7003,2024-01-06T10:00:00+00:00,thirdparty#0,server msg,,\n'
};
const entryNames = Object.keys(files);

(async () => {
    const data = await new DiscordReturnParser().parse({
        entryNames,
        readText: (n) => files[n],
        readBinary: () => null,
        options: {}
    });

    const flags = new Set();
    const fakeModule = {
        imports: [{ id: 'i1', fileName: 'return.zip', accountUsername: 'badguy#0', data }],
        isFlagged: (s, k) => flags.has(s + '|' + k),
        flagCount: () => flags.size
    };

    const ui = new DiscordWarrantUI('x', fakeModule);
    ui.activeSection = 'messages';

    console.log('\n=== 1. Channel list ===');
    const list = ui._renderMessages(data);
    has('renders a channel row', list, 'dwp-channel-row');
    has('server channel named from guild map', list, '#general');
    has('shows the guild', list, 'Bad Server');
    has('DM named from the correspondent', list, 'victim#0');
    ok('no blank _openChannel call', !list.includes("_openChannel('')"));
    ok('channel id present in markup', list.includes('111') && list.includes('222'));

    console.log('\n=== 2. Opening a thread ===');
    const dm = data.channels.find(c => c._sourceFile === 'messages/dms/111.csv');
    ok('channel exposes channelId', !!dm.channelId);
    ui._activeChannelId = dm.channelId;
    // This is the lookup that silently failed in 5.1.6.
    ok('active id resolves to a channel',
        !!(data.channels || []).find(c => c.channelId === ui._activeChannelId));

    const thread = ui._renderMessages(data);
    has('renders the chat container', thread, 'dwp-chat');
    has('renders bubbles', thread, 'dwp-bubble');
    has('message text present', thread, 'hello, there');
    has('correspondent text present', thread, 'who is this?');

    console.log('\n=== 3. Bubble semantics ===');
    has('subscriber bubble aligns right', thread, 'dwp-bubble-row out');
    has('correspondent bubble aligns left', thread, 'dwp-bubble-row in');
    has('account holder is labelled', thread, 'account holder');
    has('author name rendered', thread, 'victim#0');
    has('message id kept for evidence', thread, '900000000000000001');
    has('flag button present', thread, 'dwp-flag-btn');

    const days = (thread.match(/dwp-chat-day/g) || []).length;
    eq('one day divider per calendar day', days, 2);

    console.log('\n=== 4. Grouping ===');
    // Msgs 2 and 3 are the same author but 3 days apart — must NOT group.
    const grouped = (thread.match(/dwp-bubble-row in grouped/g) || []).length;
    eq('no false grouping across days', grouped, 0);

    console.log('\n=== 5. Search within a thread ===');
    ui._msgQuery = 'next day';
    ui._threadCacheKey = null;
    const filtered = ui._renderMessages(data);
    // The matched term is wrapped in <mark>, so the raw text is split.
    has('search hit rendered', filtered, 'next day</mark> message');
    ok('non-matching message filtered out', !filtered.includes('who is this?'));
    has('search term highlighted', filtered, 'dwp-hl');

    console.log('\n=== 6. Data-package messages still render ===');
    // A data package has no per-row author; direction is absent and every
    // message belongs to the account holder.
    const ddpish = {
        channels: [{
            channelId: 'c1', channelName: 'Direct Message with someone', channelType: 'DM',
            guildName: null, messageCount: 1,
            messages: [{ id: '5', timestamp: '2024-02-02T10:00:00Z', contents: 'legacy shape', attachments: '' }]
        }],
        subscriber: { username: 'owner' },
        stats: { messageCount: 1 }
    };
    const ui2 = new DiscordWarrantUI('x', fakeModule);
    ui2._activeChannelId = 'c1';
    const legacy = ui2._renderMessages(ddpish);
    has('legacy message rendered', legacy, 'legacy shape');
    has('legacy treated as account holder', legacy, 'dwp-bubble-row out');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
