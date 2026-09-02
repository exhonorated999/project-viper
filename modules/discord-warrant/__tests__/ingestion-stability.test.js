/**
 * Ingestion stability test — the "App crashes when uploading Discord warrant"
 * bug report.
 *
 * Measured on the reference return (541,831 messages / 101 channels):
 *   parse            ~500 MB of main-process heap
 *   structuredClone  a second ~500 MB heap in the renderer
 *   JSON.stringify   a 134 MB string
 *   setItem          QuotaExceededError (cap ~5 MB)
 *
 * That whole sequence used to run on every import.  This test drives the real
 * parser, the real store, the real renderer module and the real UI class at a
 * scale that trips the lazy path, and asserts:
 *
 *   1. nothing over the IPC boundary carries message bodies
 *   2. what the renderer would put in localStorage stays small
 *   3. a channel still renders, via the shard, with only one channel resident
 *   4. flagging works with no bulk data in memory (evidence bundle path)
 *   5. re-import replaces shards instead of accumulating them
 *   6. a missing/corrupt shard degrades to a message, not a crash
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\discord-warrant\__tests__\ingestion-stability.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const DiscordWarrantParser = require('../discord-warrant-parser');
const dwStore = require('../discord-warrant-store');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (n, a, b) => ok(n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`),
                           JSON.stringify(a) === JSON.stringify(b));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ── Build a return big enough to cross LAZY_MESSAGE_THRESHOLD ──────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-stability-'));
const RETURN = path.join(ROOT, 'return');
const CASEDIR = path.join(ROOT, 'case', 'Evidence', 'DiscordWarrant');
for (const d of ['messages/dms', 'messages/servers', 'servers', 'session']) {
    fs.mkdirSync(path.join(RETURN, d), { recursive: true });
}
fs.mkdirSync(CASEDIR, { recursive: true });

const CHANNELS = 12;
const PER_CHANNEL = 3000;   // 36,000 total > 25,000 threshold
fs.writeFileSync(path.join(RETURN, 'session', 'info.txt'),
    ['User ID: 7001', 'Username: subject#0', 'Email: s@example.com',
     'Registration date (UTC): 2020-09-13 12:26:40'].join('\n'));
fs.writeFileSync(path.join(RETURN, 'servers', '900000000000000001.json'),
    JSON.stringify({ id: '900000000000000001', name: 'Test Guild', owner_id: '7001',
                     channels: { '800000000000000000': 'general' }, threads: {} }));

const chanIds = [];
for (let c = 0; c < CHANNELS; c++) {
    const chan = String(800000000000000000n + BigInt(c));
    chanIds.push(chan);
    const bucket = c === 0 ? 'servers' : 'dms';
    const lines = [];
    let t = Date.UTC(2026, 0, 1) / 1000;
    for (let j = 0; j < PER_CHANNEL; j++) {
        t += 41;
        const self = j % 2 === 0;
        lines.push([
            chan,
            String(900000000000000000n + BigInt(c * PER_CHANNEL + j)),
            self ? '7001' : '7002',
            new Date(t * 1000).toISOString().replace('Z', '+00:00'),
            self ? 'subject#0' : 'corr#0',
            `message body number ${j} in channel ${c}`,
            '', ''
        ].join(','));
    }
    fs.writeFileSync(path.join(RETURN, 'messages', bucket, chan + '.csv'), lines.join('\n') + '\n');
}

// ── Load the renderer classes with a stub environment ──────────────────
const MODROOT = path.join(__dirname, '..');
const flagsSrc = fs.readFileSync(path.join(MODROOT, '..', '_shared', 'warrant-flags.js'), 'utf8');
const modSrc = fs.readFileSync(path.join(MODROOT, 'discord-warrant-module.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(MODROOT, 'discord-warrant-ui.js'), 'utf8');

// A localStorage that behaves like Chromium's: a hard ~5 MB ceiling.
const LS_LIMIT = 5 * 1024 * 1024;
const lsData = new Map();
const localStorage = {
    getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
    setItem: (k, v) => {
        let total = String(v).length;
        for (const [kk, vv] of lsData) if (kk !== k) total += vv.length;
        if (total > LS_LIMIT) {
            const e = new Error('Failed to set the \'' + k + '\' property on \'Storage\': exceeded the quota.');
            e.name = 'QuotaExceededError';
            throw e;
        }
        lsData.set(k, String(v));
    },
    removeItem: (k) => lsData.delete(k)
};

const ipcCalls = { readChannel: 0, saveStore: 0, deleteStore: 0 };
const electronAPI = {
    discordWarrantSaveStore: async ({ payload }) => {
        ipcCalls.saveStore++;
        // Mirrors electron-main: the index is written whole to disk.
        return { success: true, bytes: dwStore.saveIndex(CASEDIR, payload).bytes };
    },
    discordWarrantLoadStore: async () => ({ success: true, payload: dwStore.loadIndex(CASEDIR) }),
    discordWarrantReadChannel: async ({ storeKey, channelId }) => {
        ipcCalls.readChannel++;
        try {
            const messages = dwStore.readChannel(CASEDIR, storeKey, channelId);
            if (messages === null) return { success: false, error: 'Channel not in case store', messages: [] };
            return { success: true, messages };
        } catch (e) { return { success: false, error: e.message, messages: [] }; }
    },
    discordWarrantDeleteStore: async ({ storeKey }) => {
        ipcCalls.deleteStore++;
        dwStore.deleteStore(CASEDIR, storeKey);
        return { success: true };
    },
    discordWarrantScan: async () => ({ success: true, files: [] }),
    discordWarrantImport: async () => ({ success: false, error: 'not used in this test' })
};

// In a real renderer `window === globalThis`, so make the sandbox behave the
// same way — otherwise `window.WarrantFlags = ...` inside warrant-flags.js
// lands somewhere the module's bare `WarrantFlags` reference cannot see it.
const sandbox = {
    console, localStorage, electronAPI,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, Date, JSON, Math, Object, Array, String, Number, Set, Map, Promise, Error
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(flagsSrc, sandbox, { filename: 'warrant-flags.js' });
vm.runInContext(modSrc, sandbox, { filename: 'discord-warrant-module.js' });
vm.runInContext(uiSrc, sandbox, { filename: 'discord-warrant-ui.js' });
const DiscordWarrantModule = sandbox.window.DiscordWarrantModule;
const DiscordWarrantUI = sandbox.window.DiscordWarrantUI;
ok('renderer classes loaded', typeof DiscordWarrantModule === 'function' && typeof DiscordWarrantUI === 'function');

(async () => {
    console.log('\n=== 1. Parse + shard (what electron-main does on import) ===');
    const data = await new DiscordWarrantParser().parseFolder(RETURN, {});
    eq('all messages parsed', data.stats.messageCount, CHANNELS * PER_CHANNEL);
    ok('crosses the lazy threshold', data.stats.messageCount > dwStore.LAZY_MESSAGE_THRESHOLD);

    const storeKey = dwStore.storeKeyFor(path.join(RETURN, 'x.zip'));
    const res = dwStore.shardChannels(data, CASEDIR, storeKey);
    eq('every channel sharded', res.written, CHANNELS);
    eq('no shard failures', res.failed, []);
    ok('payload marked lazy', data._lazy === true && data._storeKey === storeKey);

    // THE point of the exercise: what crosses IPC must be small.
    const ipcSize = JSON.stringify(data).length;
    console.log(`     index handed to the renderer: ${mb(ipcSize)}`);
    ok('no message bodies survive in the payload',
        (data.channels || []).every(c => Array.isArray(c.messages) && c.messages.length === 0));
    ok('channel counts preserved',
        (data.channels || []).every(c => c.messageCount === PER_CHANNEL));
    ok('index is under 1 MB', ipcSize < 1024 * 1024);

    console.log('\n=== 2. Renderer persistence stays inside quota ===');
    const mod = new DiscordWarrantModule('case-1', 'CASE-1', 'Test');
    mod.imports = [{
        id: 'imp1', filePath: path.join(RETURN, 'x.zip'), fileName: 'x.zip',
        importedAt: new Date().toISOString(),
        accountUsername: data.subscriber.username, stats: data.stats, data
    }];
    let threw = null;
    try { mod.saveData(); } catch (e) { threw = e; }
    ok('saveData does not throw', threw === null);
    const stored = localStorage.getItem('discordWarrant_case-1');
    ok('localStorage was written', !!stored);
    console.log(`     localStorage payload: ${mb((stored || '').length)}`);
    ok('localStorage payload under 3.5 MB', (stored || '').length < 3_500_000);
    await new Promise(r => setTimeout(r, 50));
    eq('index written to disk once', ipcCalls.saveStore, 1);
    ok('imports.json exists on disk', fs.existsSync(path.join(CASEDIR, 'imports.json')));

    console.log('\n=== 3. A sharded channel still renders ===');
    const ui = new DiscordWarrantUI('x', mod);
    ui.activeSection = 'messages';
    const list = ui._renderMessages(data);
    ok('channel list renders', list.includes('dwp-channel-row'));
    ok('counts shown despite empty message arrays', list.includes(PER_CHANNEL.toLocaleString()));

    await ui._openChannel(chanIds[0]);
    eq('one shard read', ipcCalls.readChannel, 1);
    eq('shard fully loaded', ui._activeMessages.length, PER_CHANNEL);
    ok('no thread error', !ui._threadError);
    const thread = ui._renderMessages(data);
    ok('bubbles rendered from the shard', thread.includes('dwp-bubble'));
    ok('shard content visible', thread.includes('message body number'));
    ok('opened at the newest page', ui._msgPage === Math.ceil(PER_CHANNEL / ui._msgPageSize) - 1);

    console.log('\n=== 4. Only one channel is resident at a time ===');
    await ui._openChannel(chanIds[1]);
    eq('second shard read', ipcCalls.readChannel, 2);
    eq('cache holds exactly one channel', mod._chanCache.key, `${storeKey}|${chanIds[1]}`);
    await ui._openChannel(chanIds[1]);
    eq('re-opening the same channel is served from cache', ipcCalls.readChannel, 2);

    console.log('\n=== 5. Flag -> evidence works with no bulk data in memory ===');
    ui._renderMessages(data);              // populates _flagPayloads for the page
    const visible = ui._threadMessages(data.channels.find(c => c.channelId === chanIds[1]));
    const target = visible[visible.length - 1];
    ui._onFlagClick('messages', target.id);
    ok('flag recorded', mod.isFlagged('messages', target.id));
    const imp = mod.getActiveImport();
    ok('snapshot captured at flag time',
        !!(imp.flagSnapshots && imp.flagSnapshots.messages && imp.flagSnapshots.messages[String(target.id)]));

    // Drop every cached body — this is the state after a reload.
    mod._chanCache = null;
    ui._activeMessages = null;
    const resolved = mod._resolveFlagged(imp);
    eq('flagged message resolved without message arrays', resolved.messages.length, 1);
    eq('resolved id matches', String(resolved.messages[0].id), String(target.id));
    ok('resolved contents present', !!resolved.messages[0].contents);
    ok('resolved channel labelled', !!resolved.messages[0].channelId);

    console.log('\n=== 6. Re-import replaces shards, delete removes them ===');
    const before = fs.readdirSync(dwStore.shardDir(CASEDIR, storeKey)).length;
    const data2 = await new DiscordWarrantParser().parseFolder(RETURN, {});
    dwStore.shardChannels(data2, CASEDIR, storeKey);
    const after = fs.readdirSync(dwStore.shardDir(CASEDIR, storeKey)).length;
    eq('shard count unchanged after re-import', after, before);
    ok('no .tmp files left behind',
        fs.readdirSync(dwStore.shardDir(CASEDIR, storeKey)).every(f => !f.endsWith('.tmp')));

    mod.deleteImport('imp1');
    await new Promise(r => setTimeout(r, 50));
    eq('store deletion requested', ipcCalls.deleteStore, 1);
    ok('shard directory removed', !fs.existsSync(dwStore.shardDir(CASEDIR, storeKey)));

    console.log('\n=== 7. A missing shard degrades, it does not crash ===');
    const mod2 = new DiscordWarrantModule('case-2', 'CASE-2', 'Test');
    const data3 = await new DiscordWarrantParser().parseFolder(RETURN, {});
    dwStore.shardChannels(data3, CASEDIR, 'deadbeefdeadbeef');
    mod2.imports = [{ id: 'imp2', stats: data3.stats, data: data3 }];
    const ui2 = new DiscordWarrantUI('x', mod2);
    ui2.activeSection = 'messages';
    fs.rmSync(path.join(dwStore.shardDir(CASEDIR, 'deadbeefdeadbeef'), dwStore.shardFileName(chanIds[2])));
    let crashed = false;
    try { await ui2._openChannel(chanIds[2]); } catch (e) { crashed = true; }
    ok('open of a missing shard does not throw', !crashed);
    ok('thread error surfaced to the examiner', !!ui2._threadError);
    const err = ui2._renderMessages(data3);
    ok('error rendered, not a blank pane', err.includes('could not be read'));

    console.log('\n=== 8. Path safety ===');
    eq('traversal in a channel id is neutralised',
        dwStore.shardFileName('../../../etc/passwd'), 'ch-.._.._.._etc_passwd.json');
    eq('empty channel id handled', dwStore.shardFileName(''), 'ch-unknown.json');
    eq('null channel id handled', dwStore.shardFileName(null), 'ch-unknown.json');

    console.log('\n=== 9. Small imports keep the old inline path ===');
    const SMALL = path.join(ROOT, 'small');
    fs.mkdirSync(path.join(SMALL, 'messages/dms'), { recursive: true });
    fs.mkdirSync(path.join(SMALL, 'servers'), { recursive: true });
    fs.writeFileSync(path.join(SMALL, 'servers', '1.json'), JSON.stringify({ id: '1', name: 'S', channels: {} }));
    fs.writeFileSync(path.join(SMALL, 'messages', 'dms', '5.csv'),
        '5,900000000000000001,7002,2026-01-01T00:00:00+00:00,corr#0,hi there,,\n');
    const small = await new DiscordWarrantParser().parseFolder(SMALL, {});
    ok('small import is not lazy', !small._lazy);
    ok('small import keeps messages inline', small.channels[0].messages.length === 1);
    const mod3 = new DiscordWarrantModule('case-3', 'CASE-3', 'T');
    mod3.imports = [{ id: 'i3', stats: small.stats, data: small }];
    mod3.saveData();
    const s3 = JSON.parse(localStorage.getItem('discordWarrant_case-3'));
    eq('small import stored whole in localStorage', s3.imports[0].data.channels[0].messages.length, 1);
    const ui3 = new DiscordWarrantUI('x', mod3);
    ui3.activeSection = 'messages';
    const readsBefore = ipcCalls.readChannel;
    await ui3._openChannel('5');
    eq('no IPC needed for an inline channel', ipcCalls.readChannel, readsBefore);
    ok('inline channel renders', ui3._renderMessages(small).includes('hi there'));

    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS THREW: ' + e.stack); process.exit(1); });
