'use strict';
// CyberTips tab — identifiers on a very large tip (129-page Google tip,
// Oct 2026). Before the fix:
//   * "Suspect 1" (a numbered person header) was not recognised, so the tip
//     came out with NO persons: no name, e-mail, phone or device ID, only the
//     upload IPs from the file list.
//   * every IP entry was its own card (640 cards for 115 addresses).
//   * nothing could be sent to a Suspect / Victim in one go.
//   * ARIN results vanished when the officer left the tab.
//   * pdf-parse output with the upload-IP cells run together
//     ("IP Address98.51.100.4Upload01-23-2026 …") lost the upload IP.
//
// Everything is LIFTED from case-detail-with-analytics.html, never copied.
// All values are synthetic (documentation IP ranges, example.com).
//
// Run: node modules\__tests__\cybertip-identifiers.test.js

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
function sliceBetween(a, b) {
    const s = DETAIL.indexOf(a), e = DETAIL.indexOf(b, s);
    if (s === -1 || e === -1) throw new Error('block not found: ' + a);
    return DETAIL.slice(s, e);
}

const parseCyberTip = new Function(lift('function parseCyberTip(text, fileName) {') + '\nreturn parseCyberTip;')();
const HELPERS = sliceBetween('// ── CyberTip identifiers: re-parse', '// CyberTip → People Modules: Send-To feature');

// One environment = the CyberTips tab code with a fake page around it.
function makeEnv(tips, opts = {}) {
    const store = { tips: JSON.parse(JSON.stringify(tips)), saves: 0, ls: opts.ls || {}, toasts: [], modalOpened: 0 };
    const els = {};
    const el = (id) => els[id] || (els[id] = { id, disabled: false, innerHTML: '', textContent: '', title: '', classList: { add() {}, remove() {} } });
    let checkboxes = [];
    const document = {
        getElementById: (id) => (opts.missing || []).includes(id) ? null : el(id),
        querySelectorAll: (sel) => sel === '.ct-sel' ? checkboxes : [],
    };
    const stubs = {
        getCyberTips: () => JSON.parse(JSON.stringify(store.tips)),
        saveCyberTips: (d) => { if (opts.saveThrows) throw new Error('QuotaExceededError'); store.saves++; store.tips = JSON.parse(JSON.stringify(d)); },
        _ctSrcBtn: () => '',
        showToast: (m, k) => store.toasts.push([k, m]),
        ctOpenSendToModal: () => { store.modalOpened++; },
        document,
        window: { electronAPI: { arinLookup: opts.arin || (async () => ({ success: false, error: 'none' })) } },
        parseCyberTip,
        currentCase: { id: 'c1', caseNumber: 'T-1' },
        _lsParse: (k, fb) => (k in store.ls ? JSON.parse(JSON.stringify(store.ls[k])) : fb),
        localStorage: { setItem: (k, v) => { store.ls[k] = JSON.parse(v); } },
        auditLog: () => {},
    };
    const names = Object.keys(stubs);
    const body = [
        lift('function escHtmlSafe(s) {'),
        'let __ctSendRegistry = [], __ctSendToPayload = null, currentCyberTipView = 0;',
        lift('function ctRegisterSend(items) {'),
        lift('function ctSendBtn(regIdx) {'),
        lift('function ctSendStorageKey(targetType) {'),
        lift('function ctSendToConfirm() {'),
        HELPERS,
        lift('function renderCyberTipDetail(idx) {'),
        `return {
            render: renderCyberTipDetail, groupIps: _ctGroupIps, upgrade: _ctUpgradeTips,
            arin: ctArinLookupGroup, toggle: ctToggleSelect, selectKind: ctSelectIdents,
            sendSelected: ctSendSelected, sendBtn: ctSendBtn, confirm: ctSendToConfirm,
            setView: (v) => { currentCyberTipView = v; },
            setPayload: (p) => { __ctSendToPayload = p; },
            state: () => ({ reg: __ctSendRegistry, payload: __ctSendToPayload, sel: __ctSelected, groups: __ctIpGroups }),
        };`
    ].join('\n');
    const api = new Function(...names, body)(...names.map(n => stubs[n]));
    api.store = store;
    api.els = els;
    api.render0 = (idx = 0) => {
        const html = api.render(idx);
        checkboxes = [...html.matchAll(/class="ct-sel[^"]*" data-ct-reg="(\d+)" data-ct-kind="([a-z]+)"/g)].map(m => {
            const attrs = { 'data-ct-reg': m[1], 'data-ct-kind': m[2] };
            return { checked: false, getAttribute: (n) => attrs[n] };
        });
        api.checkboxes = checkboxes;
        return html;
    };
    return api;
}

// ── Fixture: numbered persons, repeated IPs, glued upload row ─────────────
const TEXT = [
    'CyberTipline Report 900000444',
    'Priority Level: E',
    'Received by NCMEC on 05-10-2026 16:58:00 UTC',
    'Section A: Reported Information',
    'Reporting Electronic Service Provider (ESP)',
    'Submitter: Point of Contact for Law Enforcement:',
    'Google',
    'Custodian of Records',
    'Incident Information',
    'Incident Type: Child Pornography (possession, manufacture, and distribution)',
    'Incident Time: 05-09-2026 00:17:03 UTC',
    'Suspect 1',
    'Name: Jordan Example',
    'Mobile Phone: +15555550123 (Verified 05-01-2026 02:22:52 UTC)',
    'Date of Birth: 01-02-1990',
    'Email Address: jordan@example.com (Verified)',
    'Email Address: jordan.alt@example.com',
    'IP Address: 203.0.113.7 (Login)',
    '05-03-2026 06:00:00 UTC',
    'IP Address: 203.0.113.7 (Login)',
    '05-01-2026 06:00:00 UTC',
    'IP Address: 2001:DB8::AB (Login)',
    '05-02-2026 06:00:00 UTC',
    'IP Address: 203.0.113.7 (Login)',
    '05-02-2026 06:00:00 UTC',
    'IP Address: 2001:db8::ab (Login)',
    '04-30-2026 06:00:00 UTC',
    'Device ID (IMEI): 356938035643809',
    '05-01-2026 06:54:05 UTC',
    'Suspect 2',
    'Name: Riley Sample',
    'Email Address: riley@example.com',
    'Screen/User Name: riley_s',
    'IP Address: 198.51.100.4 (Login)',
    '05-04-2026 07:00:00 UTC',
    'Uploaded File Information',
    'Number of uploaded files: 2',
    'Uploaded File Information',
    'Filename: VID_0001.mp4',
    'MD5: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'TypeValueEventDate/Time',
    'IP Address198.51.100.4Upload01-23-2026 16:56:15 UTC',
    'Uploaded File Information',
    'Filename: VID_0002.mp4',
    'MD5: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'TypeValueEventDate/Time',
    'IP Address2001:db8:4ff0::1215Upload01-26-2026 22:46:19 UTC',
    'Section B: Automated Information',
    'This concludes Section B',
    ''
].join('\n');

// ── 1. Parser: numbered person headers + run-together upload row ─────────
console.log('1. parser');
const T = parseCyberTip(TEXT, 'big.pdf');
eq(T.persons.length, 2, 'two persons from "Suspect 1" / "Suspect 2"');
const P1 = T.persons[0] || { emails: [], phones: [], ipAddresses: [], deviceIds: [] };
const P2 = T.persons[1] || { emails: [], screenNames: [], ipAddresses: [] };
eq(P1.role, 'Suspect', 'role is "Suspect", not "Suspect 1"');
eq(P1.name, 'Jordan Example', 'name');
eq(P1.dob, '01-02-1990', 'DOB');
eq(P1.emails, ['jordan@example.com (Verified)', 'jordan.alt@example.com'], 'both e-mails');
eq(P1.phones.length, 1, 'phone');
eq(P1.ipAddresses.length, 5, 'five login entries');
eq((P1.deviceIds || []).map(d => d.value), ['356938035643809'], 'device ID');
eq(P2.name, 'Riley Sample', 'second person name (Suspect 2 starts a new person)');
eq(P2.emails, ['riley@example.com'], 'second person e-mail not merged into the first');
eq(P2.screenNames, ['riley_s'], 'second person username');
eq(T.uploadedFiles.map(f => f.sourceIps), [
    [{ address: '198.51.100.4', event: 'Upload', timestamp: '01-23-2026 16:56:15 UTC' }],
    [{ address: '2001:db8:4ff0::1215', event: 'Upload', timestamp: '01-26-2026 22:46:19 UTC' }]
], 'upload IP read from run-together cells (IPv4 and IPv6)');

// ── 2. IP grouping ───────────────────────────────────────────────────────
console.log('2. IP grouping');
{
    const env = makeEnv([T]);
    const G = env.groupIps(T);
    eq(G.map(g => [g.address, g.entries.length]), [
        ['203.0.113.7', 3], ['198.51.100.4', 2], ['2001:DB8::AB', 2], ['2001:db8:4ff0::1215', 1]
    ], 'one group per address (IPv6 case folded), most-seen first, ties by latest');
    eq(G[0].entries.map(e => e.timestamp), ['05-03-2026 06:00:00 UTC', '05-02-2026 06:00:00 UTC', '05-01-2026 06:00:00 UTC'], 'entries newest first');
    eq([G[0].first, G[0].last], ['05-01-2026 06:00:00 UTC', '05-03-2026 06:00:00 UTC'], 'first / last seen');
    eq(G[1].summary, [{ role: 'Suspect', event: 'Login', count: 1 }, { role: 'Uploaded Files', event: 'Upload', count: 1 }], 'summary mixes login and upload');
    eq(G[1].entries.find(e => e.role === 'Uploaded Files').file, 'VID_0001.mp4', 'upload entry keeps the file name');
    eq(G.reduce((n, g) => n + g.entries.length, 0), 8, 'no entry lost');
    const mixed = env.groupIps({ persons: [{ role: 'Suspect', ipAddresses: [
        { address: '192.0.2.1', type: 'Checkin', timestamp: '2026-05-05 01:00:00' },
        { address: '192.0.2.1', type: 'Login', timestamp: '05-04-2026 01:00:00 UTC' },
        { address: '192.0.2.1', type: 'Login', timestamp: '' }] }], uploadedFiles: [] });
    eq(mixed[0].entries.map(e => e.type || e.event), ['Checkin', 'Login', 'Login'], 'both date formats sort; undated last');
    eq(mixed[0].last, '2026-05-05 01:00:00', 'YYYY-MM-DD checkin time counts as latest');
}

// ── 3. Detail view: grouped cards, checkboxes, header ────────────────────
console.log('3. CyberTips detail view');
{
    const env = makeEnv([T]);
    const html = env.render0();
    eq((html.match(/data-ct-ip="/g) || []).length, 4, 'four IP cards for eight IP entries');
    ok(html.includes('Seen 3×'), 'count badge');
    ok(html.includes('Show all 3 entries'), 'expandable entry list');
    ok(html.includes('Show the entry'), 'single-entry wording');
    ok(html.includes('Suspect · Login ×3'), 'chip says how many logins');
    ok(html.includes('Uploaded Files · Upload 1 file'), 'chip for upload');
    ok(html.includes('4 different IP addresses across 8 entries'), 'header explains the grouping');
    const kinds = env.checkboxes.map(c => c.getAttribute('data-ct-kind'));
    eq(kinds.filter(k => k === 'ip').length, 4, 'one checkbox per IP card');
    ok(['name', 'email', 'phone', 'username', 'deviceid'].every(k => kinds.includes(k)), 'checkbox on every identifier kind');
    ok(/onclick="ctSelectIdents\('email'\)"/.test(html) && /onclick="ctSelectIdents\('ip'\)"/.test(html), 'quick-select buttons for present kinds');
    ok(!/onclick="ctSelectIdents\('userid'\)"/.test(html), 'no button for an absent kind');
    ok(html.includes('id="ctSendSelBtn"') && /id="ctSendSelBtn"[^>]*disabled/.test(html), '"Send selected" starts disabled');
    // Persons section: one IP per address in the whole-person Send To
    const reg = env.state().reg;
    const personItems = reg.find(items => items.length > 1 && items.some(i => i.key === 'name' && i.value === 'Jordan Example'));
    const ipItems = (personItems || []).filter(i => i.key === 'ip');
    eq(ipItems.map(i => [i.value, i.meta]), [['203.0.113.7', 'Login ×3'], ['2001:DB8::AB', 'Login ×2']], 'whole-person Send To lists each address once, with counts');
}

// ── 4. Escaping ──────────────────────────────────────────────────────────
console.log('4. escaping');
{
    const evil = JSON.parse(JSON.stringify(T));
    evil.persons[0].emails = ['<img src=x onerror=alert(1)>@example.com'];
    evil.persons[0].ipAddresses = [{ address: '203.0.113.9"><script>x</script>', type: '<b>Login</b>', timestamp: '<i>t</i>', port: '' }];
    const env = makeEnv([evil]);
    const html = env.render0();
    ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'), 'e-mail escaped');
    ok(!html.includes('<script>x</script>') && !html.includes('<b>Login</b>') && !html.includes('<i>t</i>'), 'IP, event and time escaped');
}

// ── 5. ARIN result stays on the tip ──────────────────────────────────────
console.log('5. ARIN persistence');
(async () => {
    {
        const calls = [];
        const env = makeEnv([T], { arin: async (ip) => { calls.push(ip); return { success: true, provider: 'Example ISP <b>', network: 'NET-EX', netRange: '203.0.113.0 - 203.0.113.255', org: 'Example Org', country: 'US' }; } });
        env.render0();
        await env.arin(0);
        eq(calls, ['203.0.113.7'], 'looked up the grouped address');
        const saved = (env.store.tips[0].arinResults || {})['203.0.113.7'] || {};
        eq([saved.provider, saved.netRange, saved.country], ['Example ISP <b>', '203.0.113.0 - 203.0.113.255', 'US'], 'saved on the tip');
        ok(typeof saved.lookedUpAt === 'string' && !isNaN(Date.parse(saved.lookedUpAt)), 'lookup time saved');
        ok(env.els.ctip_0_result.innerHTML.includes('Example ISP &lt;b&gt;'), 'result shown, escaped');
        ok(!env.els.ctip_0_arin.disabled, 'button re-enabled');
        const ipReg = env.state().reg.find(items => items.length === 1 && items[0].key === 'ip' && items[0].value === '203.0.113.7');
        eq(ipReg && ipReg[0].provider, 'Example ISP <b>', 'Send To now carries the ISP');
        // Leave the tab and come back: a fresh render reads the saved result.
        const env2 = makeEnv(env.store.tips);
        const html2 = env2.render0();
        ok(html2.includes('Example ISP &lt;b&gt;'), 'result still there after re-render');
        ok(html2.includes('Resolved'), 'button shows Resolved');
        const ipReg2 = env2.state().reg.find(items => items.length === 1 && items[0].key === 'ip' && items[0].value === '203.0.113.7');
        eq(ipReg2 && ipReg2[0].provider, 'Example ISP <b>', 'saved ISP goes into Send To');
    }
    {
        const env = makeEnv([T], { arin: async () => ({ success: false, error: 'No <x> results' }) });
        env.render0();
        await env.arin(1);
        eq(env.store.saves, 0, 'failed lookup is not saved');
        ok(env.els.ctip_1_result.innerHTML.includes('No &lt;x&gt; results'), 'error escaped');
    }
    {
        const env = makeEnv([T], { arin: async () => { throw new Error('offline'); } });
        env.render0();
        await env.arin(0);
        ok(env.els.ctip_0_result.innerHTML.includes('Lookup failed: offline') && !env.els.ctip_0_arin.disabled, 'thrown lookup handled');
    }
    {
        const env = makeEnv([T], { saveThrows: true, arin: async () => ({ success: true, provider: 'P' }) });
        env.render0();
        await env.arin(0);
        ok(env.els.ctip_0_result.innerHTML.includes('P'), 'storage full: result still shown');
        ok(env.store.toasts.some(([k, m]) => k === 'error' && /not saved/.test(m)), 'storage full: officer told');
    }
    {
        // Officer switched tips while the lookup ran: save goes to the right tip.
        const other = JSON.parse(JSON.stringify(T)); other.id = 'ct_other'; other.reportNumber = '900000555';
        const first = JSON.parse(JSON.stringify(T)); first.id = 'ct_first';
        let release;
        const env = makeEnv([first, other], { arin: () => new Promise(r => { release = () => r({ success: true, provider: 'Late ISP' }); }) });
        env.render0(0);
        const p = env.arin(0);
        env.store.tips = [other, first];   // order changed meanwhile
        release(); await p;
        const f = env.store.tips.find(t => t.id === 'ct_first'), o = env.store.tips.find(t => t.id === 'ct_other');
        ok(f.arinResults && f.arinResults['203.0.113.7'] && !o.arinResults, 'saved to the tip it was looked up on, matched by id');
    }

    // ── 6. Batch select → Send To ────────────────────────────────────────
    console.log('6. batch Send To');
    {
        const env = makeEnv([T], { ls: { suspects_c1: [{ name: 'Target', identifiers: [] }] } });
        env.render0();
        env.selectKind('email');
        eq(env.state().sel.size, 3, '"Emails" ticks the three e-mails');
        eq(env.els.ctSelCount.textContent, '3 selected', 'count shown');
        eq(env.els.ctSendSelBtn.disabled, false, 'button enabled');
        env.selectKind('ip');
        eq(env.state().sel.size, 7, '"IPs" adds the four IP cards');
        const firstIp = env.checkboxes.find(c => c.getAttribute('data-ct-kind') === 'ip');
        env.toggle(Number(firstIp.getAttribute('data-ct-reg')), false);
        eq(env.state().sel.size, 6, 'untick one');
        env.sendSelected();
        eq(env.store.modalOpened, 1, 'Send To window opened');
        const items = env.state().payload.items;
        eq(items.filter(i => i.key === 'email').map(i => i.value), ['jordan@example.com (Verified)', 'jordan.alt@example.com', 'riley@example.com'], 'all selected e-mails in the window');
        eq(items.filter(i => i.key === 'ip').length, 3, 'selected IPs in the window, unticked one left out');
        // Confirm into a Suspect
        env.state().payload.targetType = 'suspect';
        env.state().payload.targetIdx = 0;
        env.els.ctSendToModal = { querySelector: () => ({ checked: true }), remove() {} };
        env.confirm();
        const idents = env.store.ls.suspects_c1[0].identifiers;
        eq(idents.filter(i => i.type === 'email').length, 3, 'three e-mails added to the Suspect');
        eq(idents.filter(i => i.type === 'ip').length, 3, 'three IPs added to the Suspect');
        ok(idents.filter(i => i.type === 'ip').every(i => /×\d|Login|Upload/.test(i.note || '')), 'IP note says how often it was seen');
        env.selectKind('none');
        eq(env.state().sel.size, 0, '"None" clears');
        env.sendSelected();
        ok(env.store.toasts.some(([k]) => k === 'error'), 'nothing ticked → message, no window');
        eq(env.store.modalOpened, 1, 'window not opened again');
    }
    {
        // ISP from a saved ARIN lookup lands on the Suspect's IP identifier.
        const withArin = JSON.parse(JSON.stringify(T));
        withArin.arinResults = { '203.0.113.7': { provider: 'Example ISP', lookedUpAt: '2026-10-01T00:00:00Z' } };
        const env = makeEnv([withArin], { ls: { victims_c1: [{ name: 'V', identifiers: [] }] } });
        env.render0();
        const cb = env.checkboxes.find(c => c.getAttribute('data-ct-kind') === 'ip');
        env.toggle(Number(cb.getAttribute('data-ct-reg')), true);
        env.sendSelected();
        Object.assign(env.state().payload, { targetType: 'victim', targetIdx: 0 });
        env.els.ctSendToModal = { querySelector: () => ({ checked: true }), remove() {} };
        env.confirm();
        const ip = env.store.ls.victims_c1[0].identifiers.find(i => i.type === 'ip');
        eq(ip && [ip.value, ip.provider], ['203.0.113.7', 'Example ISP'], 'IP sent with its ISP');
    }
    {
        // The same address ticked twice (card + something else) is sent once.
        const env = makeEnv([T]);
        env.render0();
        env.selectKind('all');
        env.sendSelected();
        const vals = env.state().payload.items.map(i => i.key + '|' + String(i.value).toLowerCase());
        eq(vals.length, new Set(vals).size, 'no duplicate items in the window');
    }

    // ── 7. Tips imported before the fix are re-read ──────────────────────
    console.log('7. re-read of older tips');
    {
        const old = JSON.parse(JSON.stringify(T));
        old.persons = [];
        old.rawText = TEXT;
        const keep = JSON.parse(JSON.stringify(T));
        keep.id = 'ct_keep'; keep.rawText = TEXT; keep.persons = [{ role: 'Suspect', name: 'Already here', emails: [], phones: [], screenNames: [], userIds: [], ipAddresses: [], profileUrls: [], deviceIds: [] }];
        const plain = JSON.parse(JSON.stringify(T));
        plain.id = 'ct_plain'; plain.persons = []; plain.rawText = 'CyberTipline Report 1\nNo persons here\n';
        const env = makeEnv([old, keep, plain]);
        const tips = env.store.tips;
        const changed = env.upgrade(tips);
        ok(changed === true, 'reports a change');
        eq(tips[0].persons.length, 2, 'persons recovered from the stored text');
        eq(tips[0].persons[0].emails.length, 2, 'e-mails recovered');
        eq(tips[0]._personsFix, 1, 'marked so it is read only once');
        eq(tips[1].persons.map(p => p.name), ['Already here'], 'tip that already has persons untouched');
        eq(tips[2].persons.length, 0, 'tip without numbered headers untouched');
        eq(env.store.saves, 1, 'saved once');
        ok(env.upgrade(tips) === false && env.store.saves === 1, 'second pass does nothing');
        // through the real render path
        const env2 = makeEnv([old]);
        const html = env2.render0();
        ok(html.includes('jordan@example.com') && html.includes('Jordan Example'), 'detail view shows recovered identifiers');
        eq(env2.store.tips[0].persons.length, 2, 'recovered persons saved to storage');
    }

    // ── 9. Deconfliction: "Additional Report ID(s)" layout ───────────────
    console.log('9. deconfliction related reports');
    {
        const DC = [
            'Deconfliction',
            'NCMEC systems will perform automated queries on selected reported identifiers from Section A and provide a list of possibly related',
            'identifiers not listed below.',
            'This Report 900000444Additional Report ID(s)',
            'Suspect',
            'Email jordan@example.com900000777',
            'Email Address riley@example.com900000777, 900000888',
            'IP Address 203.0.113.712345678',
            'ESP User ID 123 No match results returned from system',
            'IP Address',
            '2001:db8:4ff0:',
            ':1215',
            '900000888',
            'CyberTipline Report 900000444 | 9',
            "This Report is provided solely for informational purposes pursuant to NCMEC's nonprofit mission.",
            'Please treat all information in this Report as confidential.',
            'IP Address',
            '198.51.100.',
            '4',
            '900000777',
            'Recipient',
            'IP Address 192.0.2.55900000999',
            ''
        ].join('\n');
        const TEXT_DC = TEXT.replace('This concludes Section B', DC + 'This concludes Section B');
        const R = parseCyberTip(TEXT_DC, 'dc.pdf');
        eq(R.deconfliction.map(d => [d.role, d.type, d.value, d.related || d.result]), [
            ['Suspect', 'Email', 'jordan@example.com', ['900000777']],
            ['Suspect', 'Email', 'riley@example.com', ['900000777', '900000888']],
            ['Suspect', 'IP Address', '203.0.113.7', ['12345678']],
            ['Suspect', 'ESP User ID', '123', 'No match results returned from system'],
            ['Suspect', 'IP Address', '2001:db8:4ff0::1215', ['900000888']],
            ['Suspect', 'IP Address', '198.51.100.4', ['900000777']],
            ['Recipient', 'IP Address', '192.0.2.55', ['900000999']],
        ], 'run-together report IDs split off; wrapped values joined; page footer skipped; old lines still read');
        eq(R.deconfliction[0].result, 'Also in CyberTip 900000777', 'result text');
        eq(R.persons.length, 2, 'persons unaffected');

        const env = makeEnv([R]);
        const html = env.render0();
        ok(html.includes('Possibly related CyberTips'), 'related-reports box');
        ok(/CT# 900000777<\/span><span class="text-gray-300">shares 3 identifiers/.test(html), 'most-shared report first with count');
        ok(html.indexOf('CT# 900000777</span>') < html.indexOf('CT# 900000888</span>'), 'sorted by shared count');
        const card = (addr) => { const i = html.indexOf(`data-ct-ip="${addr}"`); return html.slice(i, html.indexOf('Show ', i)); };
        ok(card('198.51.100.4').includes('Also in CT# 900000777'), 'IP card badge');
        ok(card('203.0.113.7').includes('Also in CT# 12345678'), 'IP card badge (8-digit report ID)');
        ok(!card('2001:DB8::AB').includes('Also in CT#'), 'no badge on an IP NCMEC did not match');
        const ri = html.indexOf('>riley@example.com<');
        ok(ri > 0 && html.slice(html.lastIndexOf('glass-card', ri), ri).includes('Also in CT# 900000777, 900000888'), 'e-mail card badge lists both reports');

        const evil = JSON.parse(JSON.stringify(R));
        evil.deconfliction.push({ role: '<i>r</i>', type: '<b>Email</b>', value: '<img src=x>', result: '<u>x</u>', related: ['<s>1</s>'] });
        const eh = makeEnv([evil]).render0();
        ok(!/<img src=x>|<b>Email<\/b>|<u>x<\/u>|<i>r<\/i>|<s>1<\/s>/.test(eh), 'deconfliction table and box escaped');

        // A tip imported earlier: persons fine, deconfliction empty → re-read once.
        const old = JSON.parse(JSON.stringify(R));
        old.deconfliction = []; old.rawText = TEXT_DC; old._personsFix = 1;
        const env2 = makeEnv([old]);
        const tips = env2.store.tips;
        ok(env2.upgrade(tips) === true, 'older tip re-read');
        eq(tips[0].deconfliction.length, 7, 'deconfliction recovered');
        eq(tips[0]._dcFix, 1, 'marked');
        eq(tips[0].persons.length, 2, 'persons kept');
        ok(env2.upgrade(tips) === false, 'only once');
    }

    // ── 8. Wiring that lives outside the lifted functions ────────────────
    console.log('8. static wiring');
    {
        const list = lift('function renderCyberTipTab() {');
        ok(/_ctUpgradeTips\(tips\)/.test(list), 'list view re-reads older tips');
        ok(/const totalIPs = _ctGroupIps\(t\)\.length/.test(list), 'list view counts distinct addresses');
        const detail = lift('function renderCyberTipDetail(idx) {');
        ok(/\$\{identifiersHeader\}/.test(detail), 'header with selection bar is in the page');
        ok(!/function ipCard\(/.test(DETAIL), 'old one-card-per-entry renderer gone');
    }

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('CRASH ' + (e && e.stack)); process.exit(1); });
