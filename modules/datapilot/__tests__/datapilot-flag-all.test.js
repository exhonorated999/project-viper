/*
 * datapilot-flag-all — "Flag All" on a DataPilot conversation.
 *
 * Run:
 *   set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd modules\datapilot\__tests__\datapilot-flag-all.test.js
 *
 * Users asked to flag an entire chat thread, not just one message at a time.
 * The button acts on exactly what the thread is showing (so Sent / Received /
 * Calls / a date filter narrows it), turns into "Unflag All" once everything
 * shown is flagged, and must never touch another conversation.
 *
 * Real threads reach ~17,000 messages (measured on the sample extractions),
 * so the flag lookup and the Evidence-push resolution are pinned for speed.
 * Every identifier below is invented.
 */
process.env.TZ = 'America/Denver';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const section = (s) => console.log('\n[' + s + ']');

const A = '+17205550101';
const B = '+17205550202';
const msg = (uid, dir, addr, iso, text) => ({ uid, direction: dir, address: addr, timestamp: iso.replace('T', ' ').slice(0, 19), timestampIso: iso, type: 'SMS', text });
const call = (no, dir, addr, iso) => ({ no, direction: dir, address: addr, timestamp: iso, timestampIso: iso, duration: '30' });

function makeImport() {
    return {
        id: 'imp-1', fileName: 'TEST-EXTRACTION', format: 'dpx', timeFixVersion: 1,
        deviceInfo: { make: 'Apple', model: 'iPhone', phoneNumber: '' },
        contacts: [],
        messages: [
            msg('a1', 'outgoing', A, '2026-10-13T15:00:00.000Z', 'a one'),
            msg('a2', 'incoming', A, '2026-10-13T15:05:00.000Z', 'a two'),
            msg('a3', 'outgoing', A, '2026-10-14T16:00:00.000Z', 'a three'),
            msg('a4', 'incoming', A, '2026-10-14T16:01:00.000Z', 'a four'),
            msg('a5', 'outgoing', A, '2026-10-14T16:02:00.000Z', 'a five'),
            msg('a6', 'incoming', A, '2026-10-14T16:03:00.000Z', 'a six'),
            msg('b1', 'incoming', B, '2026-10-14T17:00:00.000Z', 'b one'),
            msg('b2', 'outgoing', B, '2026-10-14T17:01:00.000Z', 'b two'),
        ],
        calls: [call(11, 'incoming', A, '2026-10-14T18:00:00.000Z'), call(12, 'outgoing', A, '2026-10-14T18:30:00.000Z'), call(13, 'incoming', B, '2026-10-14T19:00:00.000Z')],
        media: [],
        // a2 already flagged by hand — the partial state.
        flagged: { contacts: [], messages: ['a2'], calls: [], calendar: [], apps: [], media: [], files: [] },
    };
}

const saved = [];
const confirms = [];
const toasts = [];
let confirmAnswer = true;
const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    setTimeout, clearTimeout, Promise, JSON, Date, Intl, Math, Map, Set, WeakMap,
    viperConfirm: async (m, opts) => { confirms.push({ m, opts }); return confirmAnswer; },
    showToast: (m, kind) => { toasts.push(m); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.electronAPI = {
    datapilotLoadData: async () => ({ success: true, data: JSON.stringify({ imports: [makeImport()] }) }),
    datapilotSaveData: async ({ json }) => { saved.push(json); return { success: true }; },
};
vm.createContext(sandbox);
for (const f of ['datapilot-time.js', 'datapilot-analytics.js', 'datapilot-ui.js', 'datapilot-module.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const thread = (imp, addr) => ({
    name: 'Contact', displayNumber: addr,
    msgs: imp.messages.filter(m => m.address === addr),
    calls: imp.calls.filter(c => c.address === addr),
});
const btnOf = (html) => { const m = /<button[^>]*id="dp-flag-all"[^>]*>[^<]*<\/button>/.exec(html); return m ? m[0] : ''; };
const flagsOf = (imp, s) => (imp.flagged[s] || []).slice().sort();

(async () => {
    const mod = new sandbox.DatapilotModule('case-1', 'CN-1', 'Test');
    await mod.loadData();
    let renders = 0;
    mod.render = () => { renders++; };
    const ui = new sandbox.DatapilotUI(mod);
    const imp = mod.getActiveImport();
    ok('fixture: no save on load (already stamped, nothing to repair)', saved.length === 0, saved.length);

    section('the button, unfiltered');
    let html = ui._renderCommsThread(imp, thread(imp, A), {}, 'all', null, null);
    let btn = btnOf(html);
    ok('a Flag All button is in the conversation header', !!btn && html.indexOf('dp-thread-filters') < html.indexOf('id="dp-flag-all"'));
    ok('it sits before the All / Sent / Received / Calls pills', html.indexOf('id="dp-flag-all"') < html.indexOf('data-dp-dirfilter="all"'));
    ok('label counts every message AND call in the conversation (6 + 2)', /Flag All \(8\)/.test(btn), btn);
    ok('it will flag, not unflag', /data-dp-flagall="on"/.test(btn));
    ok('the tooltip says one is already flagged', /1 of 8 already flagged/.test(btn), btn);

    section('Flag All');
    await ui._flagAllInThread(true);
    ok('a thread under 100 items flags without a confirm', confirms.length === 0, confirms.length);
    ok('every message in the conversation is flagged', JSON.stringify(flagsOf(imp, 'messages')) === JSON.stringify(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']), flagsOf(imp, 'messages'));
    ok('every call in the conversation is flagged (as the same string keys a single click stores)', JSON.stringify(flagsOf(imp, 'calls')) === JSON.stringify(['11', '12']), flagsOf(imp, 'calls'));
    ok('the other conversation is untouched', !imp.flagged.messages.includes('b1') && !imp.flagged.messages.includes('b2') && !imp.flagged.calls.includes('13'));
    ok('the already-flagged message is not duplicated', imp.flagged.messages.filter(k => k === 'a2').length === 1);
    ok('one save for the whole batch', saved.length === 1, saved.length);
    ok('the save holds the flags', JSON.parse(saved[0]).imports[0].flagged.messages.length === 6);
    ok('the toast reports the 7 newly flagged', toasts[toasts.length - 1] === 'Flagged 7 items', toasts[toasts.length - 1]);
    ok('the view repaints', renders === 1, renders);
    ok('the Flags counter reflects it', mod.flagCount() === 8, mod.flagCount());

    html = ui._renderCommsThread(imp, thread(imp, A), {}, 'all', null, null);
    btn = btnOf(html);
    ok('once all are flagged it becomes Unflag All', /Unflag All \(8\)/.test(btn) && /data-dp-flagall="off"/.test(btn), btn);
    ok('every bubble and call in the thread shows the red flag', (html.match(/🚩/g) || []).length === 8, (html.match(/🚩/g) || []).length);

    section('a second Flag All changes nothing');
    const savesBefore = saved.length;
    ok('setFlags reports 0 changes for keys already flagged', mod.setFlags({ messages: ['a1', 'a3'] }, true) === 0);
    ok('…and does not rewrite the store', saved.length === savesBefore);

    section('a filter narrows it to what is shown');
    html = ui._renderCommsThread(imp, thread(imp, A), {}, 'sent', null, null);
    btn = btnOf(html);
    // VIPER's Sent filter shows outgoing CALLS too (dir === 'outgoing'), so the
    // shown set is the 3 sent texts + outgoing call 12.
    ok('with Sent on, the label is Unflag Shown (4) — 3 sent texts + the outgoing call', /Unflag Shown \(4\)/.test(btn), btn);
    confirmAnswer = false;
    await ui._flagAllInThread(false);
    ok('unflagging several asks first', confirms.length === 1 && /Remove the flag from 4 items shown/.test(confirms[0].m), confirms[0] && confirms[0].m);
    ok('declining changes nothing and saves nothing', flagsOf(imp, 'messages').length === 6 && saved.length === savesBefore);
    confirmAnswer = true;
    await ui._flagAllInThread(false);
    ok('confirming unflags ONLY the three sent messages', JSON.stringify(flagsOf(imp, 'messages')) === JSON.stringify(['a2', 'a4', 'a6']), flagsOf(imp, 'messages'));
    ok('…and the outgoing call that Sent shows; the incoming call stays flagged', JSON.stringify(flagsOf(imp, 'calls')) === JSON.stringify(['11']), flagsOf(imp, 'calls'));
    ok('the toast reports 4 removed', toasts[toasts.length - 1] === 'Removed 4 flags', toasts[toasts.length - 1]);
    mod.setFlags({ calls: [12] }, true);   // numeric key in, string key stored
    ok('setFlags stores a numeric call number as the string a click stores', JSON.stringify(flagsOf(imp, 'calls')) === JSON.stringify(['11', '12']), flagsOf(imp, 'calls'));

    html = ui._renderCommsThread(imp, thread(imp, A), {}, 'all', null, '2026-10-13');
    btn = btnOf(html);
    ok('a date filter scopes it to that day (2 messages on the 13th, local)', /Flag Shown \(2\)/.test(btn), btn);
    ok('…and says one of them is already flagged', /1 of 2 already flagged/.test(btn), btn);

    section('a single flag click keeps the label honest');
    html = ui._renderCommsThread(imp, thread(imp, A), {}, 'calls', null, null);
    ok('Calls filter: both calls flagged → Unflag Shown (2)', /Unflag Shown \(2\)/.test(btnOf(html)), btnOf(html));
    const fakeBtn = { dataset: { dpFlagall: 'off' }, outerHTML: btnOf(html) };
    const root = { querySelector: (s) => (s === '#dp-flag-all' ? fakeBtn : null) };
    ok('toggleFlag unflags one call', mod.toggleFlag('calls', '11') === false);
    ok('isFlagged sees it immediately (lookup cache invalidated)', mod.isFlagged('calls', '11') === false && mod.isFlagged('calls', '12') === true);
    ui._refreshFlagAllButton(root);
    ok('the button flips back to Flag Shown (2) without a full repaint', /Flag Shown \(2\)/.test(fakeBtn.outerHTML) && !/Unflag/.test(fakeBtn.outerHTML), fakeBtn.outerHTML);
    ok('toggleFlag re-flags it and isFlagged agrees', mod.toggleFlag('calls', '11') === true && mod.isFlagged('calls', '11') === true);

    section('nothing to flag');
    ok('an empty conversation shows no button', ui._flagAllButton([], false) === '');
    ok('a message with no record id is never flagged in bulk', ui._flagAllButton([{ kind: 'msg', uid: '' }], false) === '');

    section('Push to Evidence sees the whole conversation');
    mod.setFlags({ messages: ['a1', 'a3', 'a5'] }, true);
    const res = mod._resolveFlagged(imp);
    ok('all six messages resolve', res.messages.length === 6, res.messages.length);
    ok('…in time order', res.messages.map(m => m.uid).join(',') === 'a1,a2,a3,a4,a5,a6', res.messages.map(m => m.uid).join(','));
    ok('both calls resolve', res.calls.map(c => c.no).sort().join(',') === '11,12');

    section('a big thread asks before flagging');
    const big = { name: 'Big', displayNumber: '+17205550303', msgs: [], calls: [] };
    for (let i = 0; i < 150; i++) {
        const m = msg('big' + i, i % 2 ? 'incoming' : 'outgoing', big.displayNumber, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), 'x');
        imp.messages.push(m); big.msgs.push(m);
    }
    ui._renderCommsThread(imp, big, {}, 'all', null, null);
    const c0 = confirms.length, s0 = saved.length;
    confirmAnswer = false;
    await ui._flagAllInThread(true);
    ok('150 items → a confirm naming the count', confirms.length === c0 + 1 && /Flag 150 items in this conversation/.test(confirms[confirms.length - 1].m), confirms[confirms.length - 1].m);
    ok('the confirm says they all go into the next Push to Evidence', /next Push to Evidence/.test(confirms[confirms.length - 1].m));
    ok('declining flags none of them', !imp.flagged.messages.some(k => /^big/.test(k)) && saved.length === s0);
    confirmAnswer = true;
    await ui._flagAllInThread(true);
    ok('confirming flags all 150', imp.flagged.messages.filter(k => /^big/.test(k)).length === 150);

    section('speed at real-thread scale (17k-message threads measured)');
    const N = 30000;
    const huge = { id: 'imp-2', messages: [], calls: [], contacts: [], media: [], flagged: { messages: [] } };
    for (let i = 0; i < N; i++) {
        huge.messages.push(msg('h' + i, 'incoming', A, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), 't'));
        huge.flagged.messages.push('h' + i);
    }
    let t0 = Date.now();
    const r2 = mod._resolveFlagged(huge);
    const resolveMs = Date.now() - t0;
    ok(`resolving ${N} flagged messages for the Evidence push takes well under a second (${resolveMs} ms)`, r2.messages.length === N && resolveMs < 1000, resolveMs);
    mod.data.imports.push(huge);
    mod.activeImportId = 'imp-2';
    t0 = Date.now();
    let hits = 0;
    for (let i = 0; i < N; i++) if (mod.isFlagged('messages', 'h' + i)) hits++;
    const lookMs = Date.now() - t0;
    ok(`checking ${N} bubbles against ${N} flags is fast (${lookMs} ms)`, hits === N && lookMs < 500, lookMs);

    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw -> ' + (e && e.stack)); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed\n'); process.exit(1); });
