/**
 * Unit tests: meta-html-tree.js (HTML -> category tree) and
 * meta-interpret.js (tree -> items / threads / IPs / times).
 * Run: node modules\meta-warrant\__tests__\meta-tree.test.js
 *
 * Covers the record-splitting rules the markup never states, the layout
 * fallbacks that keep an unknown future export from importing as "empty",
 * and the real Facebook sample in sample-data/meta-sample.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../meta-html-tree');
const MI = require('../meta-interpret');
const IG = require('./fixtures/ig-fixture');
const { splitRecords, buildValue, collectParts, cleanText, titleCaseId } = T._internal;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function deq(a, b, name) { const ja = JSON.stringify(a), jb = JSON.stringify(b); ok(ja === jb, name + ` (got ${ja}, want ${jb})`); }

const row = IG.row;
const pane = (id, inner) => '<div id="property-' + id + '" class="content-pane">' + inner + '</div>';
const page = (title, panes, toc) => '<html><head><title>' + title + '</title></head><body>' +
    (toc ? '<div class="sticky_side_bar"><ul>' + toc + '</ul></div>' : '') + panes + '</body></html>';
const one = (html) => T.parsePage(page('Instagram Legal Request', pane('x', html))).categories[0];
const keys = (rec) => rec.map(f => f.k);
const recsOf = (cat) => (cat.v.r || []);

// ── 1. Record splitting ───────────────────────────────────────────────
{
    // Facebook: a <br> between rows ends a record; a key repeating INSIDE a
    // record (two "Linked Media File" rows) must not cut it.
    const c = one(row('X', row('Id', '1') + row('Media', 'a') + row('Media', 'b') + '<br>' + row('Id', '2') + row('Media', 'c')));
    const r = c.v.r ? c.v.r : [];
    eq(r.length, 2, 'br mode: two records');
    deq(r[0] && keys(r[0]), ['Id', 'Media', 'Media'], 'br mode: repeated key stays in its record');
    deq(r[1] && keys(r[1]), ['Id', 'Media'], 'br mode: second record');
}
{
    // ... even when the record's FIRST key repeats inside it (the first-key
    // rule alone would cut it in two — only the <br> tells the truth).
    const c = one(row('X', row('Name', 'a') + row('Time', '2026-01-01 00:00:00') + row('Name', 'alias') + '<br>' + row('Name', 'b') + row('Time', '2026-01-02 00:00:00')));
    deq(recsOf(c).map(keys), [['Name', 'Time', 'Name'], ['Name', 'Time']], 'br mode wins over the first-key rule');
}
{
    // No <br>: the first key coming back starts each record (IP, Time, IP, Time).
    const c = one(row('X', row('IP Address', '1.1.1.1') + row('Time', '2026-01-01 00:00:00 UTC') + row('IP Address', '2.2.2.2') + row('Time', '2026-01-02 00:00:00 UTC')));
    eq(recsOf(c).length, 2, 'first-key rule: two records');
    deq(recsOf(c).map(keys), [['IP Address', 'Time'], ['IP Address', 'Time']], 'first-key rule: shape');
}
{
    // ... and a different key repeating inside a record (two Share rows)
    // does NOT split while the first key also repeats.
    const c = one(row('X', row('Author', 'a') + row('Share', 's1') + row('Share', 's2') + row('Author', 'b') + row('Share', 's3')));
    deq(recsOf(c).map(keys), [['Author', 'Share', 'Share'], ['Author', 'Share']], 'first-key rule: inner repeat kept whole');
}
{
    // First key never repeats: fall back to "split at any repeated key".
    const c = one(row('X', row('Head', 'h') + row('A', '1') + row('B', '2') + row('A', '3') + row('B', '4')));
    deq(recsOf(c).map(keys), [['Head', 'A', 'B'], ['A', 'B']], 'repeat fallback: split at the repeated key');
}
{
    // Plain <div> wrappers with 2+ rows are records, even when keys differ.
    const g = (a, b) => '<div>' + row('Id', a) + row('Name', b) + '</div>';
    const c = one(row('X', g('1', 'a') + g('2', 'b') + g('3', 'c')));
    eq(recsOf(c).length, 3, 'wrapper groups: three records');
    eq(MI.fieldText(recsOf(c)[2][1]), 'c', 'wrapper groups: values intact');
}
{
    // Loose text inside a group is kept as an untitled field, never dropped.
    const c = one(row('X', '<div>loose words' + row('Id', '1') + row('Name', 'a') + '</div><div>' + row('Id', '2') + row('Name', 'b') + '</div>'));
    const r = recsOf(c);
    eq(r.length, 2, 'group loose text: still two records');
    eq(r[0][0].k, '', 'group loose text: untitled field first');
    deq(r[0][0].v.t, ['loose words'], 'group loose text: text kept');
}
{
    // Leading / trailing <br> are not separators between rows.
    const raw = [{ p: 'br' }, { p: 'row', f: { k: 'A', v: {} } }, { p: 'row', f: { k: 'B', v: {} } }, { p: 'br' }];
    deq(splitRecords(raw).map(keys), [['A', 'B']], 'edge br does not switch to separator mode');
    deq(splitRecords([]), [], 'empty stream -> no records');
}

// ── 2. Values: text, media, cleaning ──────────────────────────────────
{
    const c = one(row('X', row('Body', 'Hello&nbsp;  <b>bold</b> <span>world</span>') + row('Lines', '<div>one</div><div>two</div>')));
    const r = recsOf(c)[0];
    deq(r[0].v.t, ['Hello bold world'], 'inline elements join one line, nbsp collapsed');
    deq(r[1].v.t, ['one', 'two'], 'block children become separate lines');
}
{
    const c = one(row('X', row('Media',
        '<img src="linked_media/a.jpg">' +
        '<video controls><source src="linked_media/b.mp4" type="video/mp4"></video>' +
        '<audio controls><source src="linked_media/c.txt"></audio>' +
        '<a href="linked_media/d.pdf">d.pdf</a>' +
        '<img src="linked_media/a.jpg">') + row('Other', 'x')));
    const m = recsOf(c)[0][0].v.m || [];
    deq(m.map(x => x.k + ':' + x.s), ['image:linked_media/a.jpg', 'video:linked_media/b.mp4', 'audio:linked_media/c.txt', 'file:linked_media/d.pdf'],
        'media kinds from img / video>source / audio>source / linked <a>, deduped');
    deq(recsOf(c)[0][0].v.t, ['d.pdf'], 'link text is kept as text too');
}
{
    const c = one(row('X', row('Body', 'visible<script>bad()</script><style>.x{}</style><input value="q"><label>lab</label>') + row('Y', 'y')));
    deq(recsOf(c)[0][0].v.t, ['visible'], 'script/style/input/label never become text');
}
{
    eq(cleanText('  a\u00a0\tb \r\n c '), 'a b c', 'cleanText collapses whitespace + nbsp');
    eq(titleCaseId('unified_messages'), 'Unified Messages', 'titleCaseId');
    let deep = 'x';
    for (let i = 0; i < 400; i++) deep = '<div>' + deep + '</div>';
    let threw = false;
    try { one(row('Deep', deep) + row('After', 'z')); } catch (_) { threw = true; }
    ok(!threw, 'pathological nesting does not throw');
}

// ── 3. Categories: definitions, notes, single-row unwrap ──────────────
{
    const html = page('Instagram Legal Request',
        pane('emails', row('Emails Definition', 'Emails on the account.') + row('Emails', '<div>a@x.com</div><div>b@x.com</div>')) +
        pane('photos', row('Photos Definition', 'Photos.') + '<div class="div_table" style="display:table;"><div style="display:table-cell"><div>Disclaimer text</div></div></div>' +
            row('Photos', '<div>' + row('Id', '1') + row('Taken', '2026-01-01 10:00:00 UTC') + '</div>')),
        '<li><a property="emails" href="#property-emails">E-mail Addresses</a></li>');
    const p = T.parsePage(html);
    eq(p.layout, 'property', 'layout property');
    eq(p.service, 'Instagram', 'service from title');
    const em = p.categories[0];
    eq(em.name, 'E-mail Addresses', 'name from the sidebar TOC');
    deq(em.def, ['Emails on the account.'], 'definition row -> def');
    deq(em.v.t, ['a@x.com', 'b@x.com'], 'single row named like the category unwraps to its value');
    const ph = p.categories[1];
    eq(ph.name, 'Photos', 'name falls back to title-cased id');
    deq(ph.notes, ['Disclaimer text'], 'untitled text row -> notes');
    eq(MI.items(ph).length, 1, 'photos: one item');
    eq(MI.itemTime(MI.items(ph)[0].f), '2026-01-01 10:00:00', 'photos: item time');
    eq(T.parsePage(html, { onlyIds: ['photos'] }).categories.length, 1, 'onlyIds filters categories');
}
{
    const svc = (t) => T.parsePage('<html><head><title>' + t + '</title></head><body></body></html>').service;
    eq(svc('Facebook Legal Request'), 'Facebook', 'service Facebook');
    eq(svc('WhatsApp Legal Request'), 'WhatsApp', 'service WhatsApp');
    eq(svc('Threads Legal Request'), 'Threads', 'service Threads');
    eq(svc('Something Else'), 'Meta', 'service unknown title -> Meta');
    eq(svc(''), '', 'service no title -> empty');
}

// ── 4. Layout fallbacks (an unknown future export must not look empty) ─
{
    const html = page('Instagram Legal Request',
        '<section id="Sec-Logins">' + row('Logins', '<div>' + row('IP Address', '9.9.9.9') + row('Time', '2026-02-02 02:02:02 UTC') + '</div>') + '</section>' +
        '<section id="sec-empty"><p>nothing</p></section>',
        '<li><a href="#Sec-Logins">Login History</a></li><li><a href="#sec-empty">Empty</a></li>');
    const p = T.parsePage(html);
    eq(p.layout, 'toc', 'no property- ids -> TOC-linked sections');
    eq(p.categories.length, 1, 'toc: only sections holding rows count');
    eq(p.categories[0].id, 'sec_logins', 'toc: id sanitised + lowercased');
    eq(p.categories[0].name, 'Login History', 'toc: name from the link text');
    eq(MI.ipsInFields(MI.items(p.categories[0])[0].f)[0].ip, '9.9.9.9', 'toc: rows still parsed');
}
{
    const p = T.parsePage(page('Meta Platforms export', '<main>' + row('Account', '<div>' + row('Id', '42') + row('Name', 'n') + '</div>') + '</main>'));
    eq(p.layout, 'page', 'no sections at all -> whole page');
    eq(p.categories.length, 1, 'page: one catch-all category');
    eq(p.categories[0].id, 'page_records', 'page: id');
    ok(MI.deepText(MI.items(p.categories[0])[0].f).indexOf('42') >= 0, 'page: row data kept');
    eq(T.parsePage(page('x', '<p>just prose</p>')).layout, 'none', 'no rows anywhere -> layout none');
    eq(T.parsePage(page('x', '<p>just prose</p>')).categories.length, 0, 'no rows -> no categories');
}
{
    ok(T.looksLikeMetaPage('<title>Instagram Legal Request</title>'), 'detect: title');
    ok(T.looksLikeMetaPage('<div id="property-photos" class="content-pane"><div class="div_table">'), 'detect: property pane');
    ok(T.looksLikeMetaPage('<div class="div_table" style="display: table">... Instagram ...'), 'detect: div_table + display:table + brand');
    ok(!T.looksLikeMetaPage('<div class="div_table" style="display: table">generic</div>'), 'detect: div_table without brand is not Meta');
    ok(!T.looksLikeMetaPage('<html><title>Google Takeout</title></html>'), 'detect: other provider rejected');
}

// ── 5. Interpreter ────────────────────────────────────────────────────
{
    eq(MI.normTime('2024-01-09 22:38:28 UTC'), '2024-01-09 22:38:28', 'normTime full');
    eq(MI.normTime('2024-01-09T22:38'), '2024-01-09 22:38:00', 'normTime no seconds');
    eq(MI.normTime('January 9'), '', 'normTime no match');
    eq(MI.normTime(null), '', 'normTime null');
}
{
    const F = (k, t) => ({ k, v: { t: [t] } });
    ok(MI.isNoRecords([F('Ncmec Reports', 'No responsive records located')]), 'noRecords: Meta placeholder');
    ok(MI.isNoRecords([F('X', 'No records found.')]), 'noRecords: variant');
    ok(MI.isNoRecords([F('X', 'no data available')]), 'noRecords: variant 2');
    ok(MI.isNoRecords([]), 'noRecords: empty list');
    ok(!MI.isNoRecords([F('Two Factor', 'None')]), 'noRecords: "None" is evidence, kept');
    ok(!MI.isNoRecords([F('X', 'N/A')]), 'noRecords: "N/A" kept');
    ok(!MI.isNoRecords([F('X', 'No responsive records located'), F('Y', 'real value')]), 'noRecords: mixed is real');
    ok(!MI.isNoRecords([{ k: 'X', v: { t: ['No responsive records located'], m: [{ k: 'image', s: 'linked_media/a.jpg' }] } }]), 'noRecords: media makes it real');
    ok(!MI.isNoRecords([F('Body', 'there were no records found by me, lol')]), 'noRecords: sentence containing the phrase is real');
}
{
    // items(): loose media beside ONE record belongs to it; beside several it is its own item.
    const m = { k: 'image', s: 'linked_media/p.jpg' };
    const rec = (id) => [{ k: 'Id', v: { t: [id] } }];
    const a = MI.items({ name: 'Profile Picture', v: { m: [m], r: [rec('1')] } });
    eq(a.length, 1, 'items: loose media + one record -> one item');
    eq(a[0].f[0].k, '', 'items: merged as untitled field');
    eq(a[0].f[1].k, 'Id', 'items: record fields follow');
    const b = MI.items({ name: 'X', v: { m: [m], r: [rec('1'), rec('2')] } });
    eq(b.length, 3, 'items: loose media + two records -> three items');
    const c = MI.items({ name: 'Bio', v: { t: ['hello'] } });
    eq(c.length, 1, 'items: text-only category -> one item');
    eq(c[0].f[0].k, 'Bio', 'items: named after the category');
    eq(MI.items({ name: 'E', v: {} }).length, 0, 'items: empty -> none');
    // Album grouping: a record whose every field is a container is a grouping.
    const album = MI.items({ name: 'Photos', v: { r: [[{ k: 'Album: Timeline', v: { r: [rec('p1'), rec('p2')] } }]] } });
    eq(album.length, 2, 'items: group record flattens to its children');
    deq(album[0].g, ['Album: Timeline'], 'items: group label kept');
}
{
    const fields = [
        { k: 'Date Range', v: { t: ['2026-01-01 00:00:00 UTC to 2026-02-01 00:00:00 UTC'] } },
        { k: 'Birthday', v: { t: ['2000-05-05 00:00:00'] } },
        { k: 'Note', v: { t: ['2026-03-03 03:03:03'] } },
        { k: 'Created', v: { t: ['2026-04-04 04:04:04 UTC'] } }
    ];
    eq(MI.itemTime(fields), '2026-04-04 04:04:04', 'itemTime: time-ish key wins, ranges/birthdays skipped');
    eq(MI.itemTime(fields.slice(0, 3)), '2026-03-03 03:03:03', 'itemTime: fallback to any time value');
    eq(MI.itemTime(fields.slice(0, 2)), '', 'itemTime: only ranges/birthdays -> none');
}
{
    eq(MI.summary([{ k: 'Id', v: { t: ['7'] } }, { k: 'Caption', v: { t: ['look   at\nthis'] } }]), 'look at this', 'summary: preferred key');
    eq(MI.summary([{ k: 'Taken', v: { t: ['2026-01-01 00:00:00'] } }, { k: 'Album', v: { t: ['Trip'] } }]), 'Album: Trip', 'summary: first non-time field');
    eq(MI.summary([{ k: 'Image', v: { m: [{ k: 'image', s: 'a' }, { k: 'image', s: 'b' }] } }]), '2 media files', 'summary: media count');
    eq(MI.summary([{ k: 'Body', v: { t: ['x'.repeat(300)] } }], 50).length, 50, 'summary: truncated to max');
}
{
    eq(MI.extractIps('from 203.0.113.27 at').join(), '203.0.113.27', 'ips: v4');
    eq(MI.extractIps('2600:1700:ABCD:12::1').join(), '2600:1700:abcd:12::1', 'ips: v6 lowercased');
    eq(MI.extractIps('2024-01-09 22:38:28 UTC').length, 0, 'ips: a time is not an IPv6');
    eq(MI.extractIps('999.1.1.1').length, 0, 'ips: out-of-range octet rejected');
    eq(MI.extractIps('1.2.3.4 and 5.6.7.8').length, 2, 'ips: several');
    const f = [{ k: 'Logins', v: { r: [
        [{ k: 'IP Address', v: { t: ['10.0.0.1'] } }, { k: 'Time', v: { t: ['2026-01-01 01:00:00 UTC'] } }],
        [{ k: 'IP Address', v: { t: ['10.0.0.2'] } }]
    ] } }, { k: 'Created', v: { t: ['2026-05-05 05:05:05'] } }, { k: 'Description', v: { t: ['not an ip 10.0.0.9'] } }];
    const s = MI.ipsInFields(f);
    deq(s.map(x => x.ip + '@' + x.t), ['10.0.0.1@2026-01-01 01:00:00', '10.0.0.2@2026-05-05 05:05:05'], 'ipsInFields: own record time, else the item time; non-IP keys ignored');
}
{
    // Threads, Facebook style (Author rows) and a no-author variant.
    const msg = (a, t, b) => [{ k: 'Author', v: { t: [a] } }, { k: 'Sent', v: { t: [t] } }, { k: 'Body', v: { t: [b] } }];
    const cat = { id: 'unified_messages', name: 'Unified Messages', v: { r: [
        [{ k: 'Thread', v: { t: ['( 123 )'], r: [[{ k: 'Current Participants', v: { t: ['a (Instagram: 1)', '2026-01-01 00:00:00 UTC', 'b (Instagram: 2)'] } }], msg('a', '2026-01-01 10:00:00 UTC', 'hi'), msg('b', '2026-01-01 10:01:00 UTC', 'yo')] } }],
        [{ k: 'Thread', v: { t: ['(456)'], r: [[{ k: 'Name', v: { t: ['Group'] } }], [{ k: 'Time', v: { t: ['2026-02-02 00:00:00'] } }, { k: 'Text', v: { t: ['no author'] } }]] } }],
        [{ k: 'Note', v: { t: ['outside any thread'] } }]
    ] } };
    ok(MI.isThreadCategory(cat), 'threads: detected');
    const th = MI.threads(cat);
    eq(th.length, 2, 'threads: two');
    eq(th[0].threadId, '123', 'threads: id unwrapped from parentheses');
    deq(th[0].participants, ['a (Instagram: 1)', 'b (Instagram: 2)'], 'threads: time-only participant line dropped');
    deq(th[0].messages.map(m => m.author + '|' + m.sent + '|' + m.body), ['a|2026-01-01 10:00:00|hi', 'b|2026-01-01 10:01:00|yo'], 'threads: messages');
    eq(th[1].name, 'Group', 'threads: name from header');
    eq(th[1].messages.length, 1, 'threads: no author rows -> timed records are messages');
    eq(th[1].messages[0].body, 'no author', 'threads: body from Text');
    const rest = MI.nonThreadPart(cat);
    eq(rest.v.r.length, 1, 'nonThreadPart: keeps the non-thread record');
    eq(MI.items(rest)[0].f[0].k, 'Note', 'nonThreadPart: it becomes an item');
    ok(!MI.isThreadCategory({ v: { r: [[{ k: 'Thread', v: { t: ['plain text'] } }]] } }), 'threads: a "Thread" row without records is not a thread');
}

// ── 6. The real Facebook sample (sample-data/meta-sample) ─────────────
{
    const dir = path.join(__dirname, '..', '..', '..', 'sample-data', 'meta-sample');
    const p = T.parsePage(fs.readFileSync(path.join(dir, 'records.html'), 'utf8'));
    eq(p.service, 'Facebook', 'FB: service');
    eq(p.layout, 'property', 'FB: layout');
    eq(p.categories.length, 12, 'FB: 12 categories');
    eq(p.toc.length, 12, 'FB: 12 TOC entries');
    const byId = {}; for (const c of p.categories) byId[c.id] = c;
    const rp = MI.requestParams(byId.request_parameters);
    eq(rp.target, '100000000000001', 'FB: target');
    eq(rp.accountType, 'User', 'FB: account type');
    eq(MI.items(byId.ip_addresses).length, 3, 'FB: 3 IP records');
    deq(MI.items(byId.ip_addresses).map(i => MI.ipsInFields(i.f)[0].t), ['2024-01-09 22:38:28', '2024-01-09 22:37:42', '2024-01-09 22:37:24'], 'FB: IP times');
    eq(MI.items(byId.status_updates).length, 4, 'FB: 4 status updates');
    eq(MI.items(byId.photos).length, 2, 'FB: 2 photos');
    eq(MI.deepMedia(MI.items(byId.photos).map(i => i.f)).length, 2, 'FB: photo media');
    eq(byId.photos.def.length, 11, 'FB: photo definitions');
    ok(MI.isNoRecords(MI.items(byId.ncmec_reports)[0].f), 'FB: ncmec is the placeholder');
    const th = MI.threads(byId.unified_messages);
    eq(th.length, 1, 'FB: one thread');
    eq(th[0].threadId, '100000000000002', 'FB: thread id');
    eq(th[0].messages.length, 3, 'FB: 3 messages');
    eq(th[0].participants.length, 2, 'FB: 2 participants');
    eq(th[0].messages[0].body, 'You are now connected on Messenger', 'FB: first message body');
}

// ── 7. Parsed values must not pin the page source in memory ───────────
// A 22-page return held ~660 MB because each kept value was a V8 slice of
// its whole page.  Keep one small value from each of 8 large pages and
// check the heap did not grow by the pages' size.
{
    require('v8').setFlagsFromString('--expose-gc');
    const gc = require('vm').runInNewContext('gc');
    const filler = [];
    for (let i = 0; i < 12000; i++) filler.push(row('Filler ' + i, '<div>value number ' + i + ' with some padding text here</div>'));
    const big = (n) => page('Instagram Legal Request',
        pane('request_parameters', row('Target', '<div>target-account-' + n + '-xyz</div>')) + pane('filler', filler.join('')));
    const kept = [];
    const sizes = [];
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 8; n++) {
        let html = big(n);
        sizes.push(html.length);
        const p = T.parsePage(html);
        html = null;
        kept.push(MI.requestParams(p.categories[0]).target);
    }
    gc(); gc();
    const grew = process.memoryUsage().heapUsed - before;
    const total = sizes.reduce((a, b) => a + b, 0);
    eq(kept[7], 'target-account-7-xyz', 'detach: value kept');
    ok(total > 8 * 1024 * 1024, 'detach: pages are large (' + total + ' chars)');
    ok(grew < total / 4, 'detach: heap grew ' + (grew / 1048576).toFixed(1) + ' MB for ' + (total / 1048576).toFixed(1) + ' MB of pages');
}

console.log(`\nmeta-tree: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
