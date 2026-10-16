/**
 * Unit tests: meta-merge.js (pages -> one deduplicated return) and
 * meta-warrant-store.js (on-disk store, paging, flag keys, safety).
 * Run: node modules\meta-warrant\__tests__\meta-merge-store.test.js
 */
'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MetaMerger, hashOf, pageKind, preservationNo, sortPageNames, resolveRef, rewriteMedia } = require('../meta-merge');
const Store = require('../meta-warrant-store');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function deq(a, b, name) { const ja = JSON.stringify(a), jb = JSON.stringify(b); ok(ja === jb, name + ` (got ${ja}, want ${jb})`); }
function throws(fn, re, name) { try { fn(); ok(false, name + ' (did not throw)'); } catch (e) { ok(re.test(String(e && e.message)), name + ' (' + (e && e.message) + ')'); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-meta-ms-'));

// Tiny tree builders (the shapes meta-html-tree.js produces).
const F = (k, t) => ({ k, v: { t: [].concat(t) } });
const FM = (k, s, kind) => ({ k, v: { m: [{ k: kind || 'image', s }] } });
const cat = (id, recs, name) => ({ id, name: name || id, def: [], notes: [], v: { r: recs } });
const empty = (id) => cat(id, [[F(id, 'No responsive records located')]]);
const login = (ip, t) => [F('IP Address', ip), F('Time', t)];
const params = (gen) => cat('request_parameters', [[F('Service', 'Instagram'), F('Target', '111'), F('Generated', gen)]]);
const msg = (a, t, b, extra) => [F('Author', a), F('Sent', t), F('Body', b)].concat(extra || []);
const thread = (id, msgs, parts) => [{ k: 'Thread', v: { t: ['(' + id + ')'], r: [[F('Current Participants', parts || ['a', 'b'])]].concat(msgs) } }];
const pg = (cats, title) => ({ title: title || 'Instagram Legal Request', service: 'Instagram', layout: 'property', categories: cats });

// ── 1. Helpers ────────────────────────────────────────────────────────
{
    const a = { f: [F('Url', 'https://scontent-iad3-1.cdninstagram.com/v/t51/123_n.jpg?oh=AAA&oe=1')] };
    const b = { f: [F('Url', 'https://scontent-lax3-2.cdninstagram.com/v/t51/123_n.jpg?oh=BBB&oe=2')] };
    const c = { f: [F('Url', 'https://scontent-iad3-1.cdninstagram.com/v/t51/999_n.jpg?oh=AAA&oe=1')] };
    eq(hashOf(a), hashOf(b), 'identity: CDN edge host + signature ignored');
    ok(hashOf(a) !== hashOf(c), 'identity: a different media path is a different item');
    ok(hashOf({ f: [F('Body', 'hi')] }) !== hashOf({ f: [F('Body', 'hi ')] }), 'identity: text is exact');
    eq(hashOf({ f: [F('Body', 'see http://x.com/a?b=1')] }), hashOf({ f: [F('Body', 'see http://x.com/a?b=1')] }), 'identity: stable');
    eq(hashOf(a).length, 16, 'identity: 16 hex chars');
}
{
    eq(pageKind('x/records.html'), 'records', 'pageKind records');
    eq(pageKind('Preservation-3.HTML'), 'preservation', 'pageKind preservation');
    eq(pageKind('index.html'), 'page', 'pageKind other');
    eq(preservationNo('preservation_12.html'), 12, 'preservationNo');
    eq(preservationNo('records.html'), null, 'preservationNo none');
    deq(sortPageNames(['zz.html', 'preservation-10.html', 'preservation-2.html', 'records.html', 'aa.html']),
        ['records.html', 'preservation-2.html', 'preservation-10.html', 'aa.html', 'zz.html'], 'sortPageNames: records, preservations numeric, rest by name');
}
{
    eq(resolveRef('linked_media/a.jpg', ''), 'linked_media/a.jpg', 'resolveRef plain');
    eq(resolveRef('./linked_media/a.jpg', 'Return 1'), 'Return 1/linked_media/a.jpg', 'resolveRef relative to the page folder');
    eq(resolveRef('../linked_media/a.jpg', 'Return 1/pages'), 'Return 1/linked_media/a.jpg', 'resolveRef ..');
    eq(resolveRef('linked_media\\b%20c.jpg?x=1#y', ''), 'linked_media/b c.jpg', 'resolveRef backslash, decode, query stripped');
    eq(resolveRef('../../../../etc/passwd', 'a'), 'etc/passwd', 'resolveRef cannot climb above the return root');
    eq(resolveRef('https://cdn/x.jpg', ''), null, 'resolveRef http is not in the return');
    eq(resolveRef('data:image/png;base64,xx', ''), null, 'resolveRef data: is not in the return');
    eq(resolveRef('linked_media/%E0%A4%A.jpg', ''), 'linked_media/%E0%A4%A.jpg', 'resolveRef bad escape kept raw');
    const fields = [FM('Image', 'linked_media/x.jpg'), { k: 'Group', v: { r: [[FM('Video', 'linked_media/y.mp4', 'video')]] } }];
    const seen = [];
    rewriteMedia(fields, 'Ret', (r, k) => seen.push(k + ':' + r));
    deq(seen, ['image:Ret/linked_media/x.jpg', 'video:Ret/linked_media/y.mp4'], 'rewriteMedia walks nested records');
    eq(fields[0].v.m[0].s, 'Ret/linked_media/x.jpg', 'rewriteMedia rewrites in place');
}

// ── 2. Merging pages ──────────────────────────────────────────────────
function mergeFixture(order) {
    const pages = {
        'records.html': pg([
            params('2026-06-01 00:00:00 UTC'),
            cat('ip_addresses', [login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('2.2.2.2', '2026-01-02 00:00:00 UTC')]),
            empty('ncmec_reports'),
            cat('photos', [[F('Id', 'p1'), FM('Image', 'linked_media/p1.jpg'), F('Taken', '2026-01-05 00:00:00 UTC'), F('Url', 'https://edge-a.cdn/p1.jpg?oh=1')]]),
            cat('unified_messages', [thread('T1', [msg('a', '2026-01-01 10:00:00 UTC', 'hi'), msg('a', '2026-01-01 10:00:00 UTC', 'hi')])].concat([[F('Note', 'loose record')]]))
        ]),
        'preservation-1.html': pg([
            params('2026-06-02 00:00:00 UTC'),
            // same duplicate pair again (still two), plus one only here
            cat('ip_addresses', [login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('3.3.3.3', '2026-01-03 00:00:00 UTC')]),
            cat('ncmec_reports', [[F('Report', 'R-1'), F('Time', '2026-01-04 00:00:00 UTC')]]),
            cat('photos', [[F('Id', 'p1'), FM('Image', 'linked_media/p1.jpg'), F('Taken', '2026-01-05 00:00:00 UTC'), F('Url', 'https://edge-b.cdn/p1.jpg?oh=2')]]),
            cat('unified_messages', [thread('T1', [msg('a', '2026-01-01 10:00:00 UTC', 'hi'), msg('b', '2026-01-01 10:02:00 UTC', 'pres only', [FM('Image', 'linked_media/m.jpg')])], ['b', 'c'])]),
            empty('brand_new_category')
        ]),
        'preservation-2.html': pg([
            cat('ip_addresses', [login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('1.1.1.1', '2026-01-01 00:00:00 UTC'), login('1.1.1.1', '2026-01-01 00:00:00 UTC')])
        ])
    };
    const m = new MetaMerger();
    for (const n of order) m.addPage(n, JSON.parse(JSON.stringify(pages[n])));
    return m.finish();
}
{
    const r = mergeFixture(['records.html', 'preservation-1.html', 'preservation-2.html']);
    const C = {}; for (const c of r.categories) C[c.id] = c;
    eq(r.pages.length, 3, 'merge: 3 pages');
    deq(r.pages.map(p => p.kind), ['records', 'preservation', 'preservation'], 'merge: page kinds');
    // occurrence-aware identity
    eq(C.ip_addresses.count, 5, 'merge: 1.1.1.1 x3 (max on any page) + 2.2.2.2 + 3.3.3.3');
    const ipItems = r.items.ip_addresses;
    deq(ipItems.filter(i => i.f[0].v.t[0] === '1.1.1.1').map(i => i.src), [[0, 1, 2], [0, 1, 2], [2]], 'merge: duplicate logins keep distinct keys, third copy only on page 2');
    eq(new Set(ipItems.map(i => i.key)).size, 5, 'merge: keys unique');
    ok(ipItems.every(i => /^[0-9a-f]{16}\.\d+$/.test(i.key)), 'merge: key format <hash>.<n>');
    eq(C.ip_addresses.onlyPres, 2, 'merge: 3.3.3.3 and the third 1.1.1.1 are preservation-only');
    deq(C.ip_addresses.emptyOn, [], 'merge: ip never empty');
    // placeholders
    eq(C.ncmec_reports.count, 1, 'merge: placeholder is not an item, real report is');
    deq(C.ncmec_reports.emptyOn, [0], 'merge: ncmec empty on records only');
    eq(C.ncmec_reports.onlyPres, 1, 'merge: report only in a preservation');
    eq(C.brand_new_category.count, 0, 'merge: unknown empty category kept, 0 items');
    deq(C.brand_new_category.emptyOn, [1], 'merge: unknown category emptyOn');
    deq(C.brand_new_category.pages, [1], 'merge: unknown category pages');
    // per-page params are not "preservation-only evidence"
    eq(C.request_parameters.perPage, true, 'merge: request_parameters perPage');
    eq(C.request_parameters.onlyPres, 0, 'merge: request_parameters never onlyPres');
    eq(r.params.generated, '2026-06-01 00:00:00 UTC', 'merge: params from the records page');
    // photos dedupe across CDN edges
    eq(C.photos.count, 1, 'merge: same photo on two edges -> one item');
    deq(r.items.photos[0].src, [0, 1], 'merge: photo on both pages');
    ok(/edge-a/.test(JSON.stringify(r.items.photos[0].f)), 'merge: stored item keeps the first full URL');
    eq(C.photos.media, 1, 'merge: photo media counted once');
    // threads
    eq(r.threads.length, 1, 'merge: one thread across pages');
    const th = r.threads[0];
    eq(th.count, 3, 'merge: hi x2 (identical, both kept) + pres-only message');
    eq(th.onlyPres, 1, 'merge: one preservation-only message');
    deq(th.participants, ['a', 'b', 'c'], 'merge: participants unioned');
    deq(th.src, [0, 1], 'merge: thread pages');
    eq(th.media, 1, 'merge: thread media');
    eq(th.first, '2026-01-01 10:00:00', 'merge: thread first');
    eq(th.last, '2026-01-01 10:02:00', 'merge: thread last');
    eq(C.unified_messages.kind, 'threads', 'merge: messages category kind');
    eq(C.unified_messages.threads, 1, 'merge: category thread count');
    eq(C.unified_messages.items, 1, 'merge: non-thread record beside threads kept as an item');
    eq(C.unified_messages.count, 4, 'merge: category count = items + messages');
    // ips / timeline / media refs
    eq(r.ips.length, 5, 'merge: one IP sighting per IP item');
    eq(r.ips[0].t, '2026-01-03 00:00:00', 'merge: ips newest first');
    ok(r.timeline.some(x => x.th && /a: hi/.test(x.s)), 'merge: timeline message summary with author');
    deq(r.mediaRefs.map(x => x.ref).sort(), ['linked_media/m.jpg', 'linked_media/p1.jpg'], 'merge: media refs');
    eq(r.mediaUse['linked_media/m.jpg'][0].th, th.key, 'merge: media use points at the thread');
    eq(r.service, 'Instagram', 'merge: service');
}
{
    // Page order must not change identity or keys (preservation first).
    const a = mergeFixture(['records.html', 'preservation-1.html', 'preservation-2.html']);
    const b = mergeFixture(['preservation-1.html', 'records.html', 'preservation-2.html']);
    deq(a.items.ip_addresses.map(i => i.key).sort(), b.items.ip_addresses.map(i => i.key).sort(), 'merge: keys independent of page order');
    eq(b.params.generated, '2026-06-01 00:00:00 UTC', 'merge: records params win even when a preservation came first');
    deq(a.threads.map(t => t.key), b.threads.map(t => t.key), 'merge: thread key independent of page order');
}
{
    // A thread without an id is keyed by its participants.
    const p = (parts) => pg([cat('m', [[{ k: 'Thread', v: { t: [''], r: [[F('Participants', parts)], msg('a', '2026-01-01 00:00:00', 'x')] } }]])]);
    const m = new MetaMerger();
    m.addPage('records.html', p(['a', 'b']));
    m.addPage('preservation-1.html', p(['a', 'b']));
    m.addPage('preservation-2.html', p(['a', 'z']));
    eq(m.finish().threads.length, 2, 'merge: id-less threads split by participants');
}
{
    // mediaRefs: a later <img> upgrades a ref first seen as a plain link.
    const m = new MetaMerger();
    m.addPage('records.html', pg([cat('x', [[F('Id', '1'), FM('File', 'linked_media/a.jpg', 'file')]])]));
    m.addPage('preservation-1.html', pg([cat('x', [[F('Id', '1'), FM('File', 'linked_media/a.jpg', 'image')]])]));
    eq(m.finish().mediaRefs[0].kind, 'image', 'merge: media kind upgraded from file');
}
{
    // No records page at all: nothing is "preservation-only".
    const m = new MetaMerger();
    m.addPage('preservation-1.html', pg([cat('ip_addresses', [login('9.9.9.9', '2026-01-01 00:00:00')])]));
    eq(m.finish().categories[0].onlyPres, 0, 'merge: no records page -> onlyPres 0');
}

// ── 3. Store ──────────────────────────────────────────────────────────
const caseDir = path.join(tmp, 'case');
const key = 'abc123';
const dir = Store.storeDir(caseDir, key);
{
    const r = mergeFixture(['records.html', 'preservation-1.html', 'preservation-2.html']);
    fs.mkdirSync(path.join(dir, 'linked_media'), { recursive: true });
    const idx = Store.writeStore(dir, r, { extra: 1 });
    fs.writeFileSync(path.join(dir, 'linked_media', 'p1.jpg'), 'img');
    Store.writeJson(path.join(dir, 'store', 'media.json'), {
        'linked_media/p1.jpg': { file: 'p1.jpg', size: 3, kind: 'image', mime: 'image/jpeg' },
        'linked_media/P1.JPG': { file: 'p1.jpg', size: 3, kind: 'image', mime: 'image/jpeg' },
        'linked_media/evil.jpg': { file: '..\\..\\..\\evil.txt', kind: 'image' },
        'linked_media/evil2.jpg': { file: '../store/index.json', kind: 'image' }
    });
    Store.writeJson(path.join(dir, 'meta.json'), { fileName: 'ret.zip' });
    eq(idx.extra, 1, 'store: extra fields merged into index');
    eq(idx.totals.pages, 3, 'store: totals pages');
    eq(idx.totals.preservations, 2, 'store: totals preservations');
    eq(idx.totals.threads, 1, 'store: totals threads');
    eq(idx.totals.messages, 3, 'store: totals messages');
    eq(idx.totals.items, r.categories.reduce((n, c) => n + c.items, 0), 'store: totals items');
    ok(!('messages' in idx.threads[0]), 'store: index threads carry no messages');
    ok(fs.existsSync(path.join(dir, 'store', idx.threads[0].file)), 'store: thread file written');
    const um = idx.categories.find(c => c.id === 'unified_messages');
    ok(!!um.file, 'store: threads category with loose records gets an item file');
    ok(fs.readdirSync(path.join(dir, 'store')).every(n => !/\.tmp$/.test(n)), 'store: no .tmp left behind');
    eq(Store.readIndex(dir).version, Store.STORE_VERSION, 'store: index readable');
}
{
    const q = (o) => Store.query(dir, o);
    const all = q({ kind: 'items', cat: 'ip_addresses' });
    eq(all.total, 5, 'query items: total');
    eq(q({ kind: 'items', cat: 'ip_addresses', offset: 3, limit: 1 }).rows.length, 1, 'query items: paging');
    eq(q({ kind: 'items', cat: 'ip_addresses', offset: 3, limit: 1 }).rows[0].key, all.rows[3].key, 'query items: offset honoured');
    eq(q({ kind: 'items', cat: 'ip_addresses', limit: 99999 }).limit, Store.MAX_LIMIT, 'query items: limit clamped');
    eq(q({ kind: 'items', cat: 'ip_addresses', limit: 'x', offset: -5 }).offset, 0, 'query items: bad offset -> 0');
    eq(q({ kind: 'items', cat: 'ip_addresses', limit: 'x' }).limit, 100, 'query items: bad limit -> 100');
    eq(q({ kind: 'items', cat: 'ip_addresses', onlyPres: true }).total, 2, 'query items: only-in-preservation');
    eq(q({ kind: 'items', cat: 'ip_addresses', page: 2 }).total, 3, 'query items: page filter');
    eq(q({ kind: 'items', cat: 'ip_addresses', q: '3.3.3' }).total, 1, 'query items: text filter');
    deq(q({ kind: 'items', cat: 'ip_addresses', sort: 'time-asc' }).rows.map(x => x.t), ['2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-02 00:00:00', '2026-01-03 00:00:00'], 'query items: time-asc');
    eq(q({ kind: 'items', cat: 'ip_addresses', sort: 'time-desc' }).rows[0].t, '2026-01-03 00:00:00', 'query items: time-desc');
    eq(q({ kind: 'items', cat: 'nope' }).total, 0, 'query items: unknown category -> empty');
    const th = Store.readIndex(dir).threads[0];
    eq(q({ kind: 'thread', thread: th.key }).total, 3, 'query thread: messages');
    eq(q({ kind: 'thread', thread: th.key, onlyPres: true }).total, 1, 'query thread: only-in-preservation');
    eq(q({ kind: 'threads', q: 'pres only' }).total, 1, 'query threads: matches message text');
    eq(q({ kind: 'threads', q: 'zzz' }).total, 0, 'query threads: no match');
    eq(q({ kind: 'ips' }).total, 5, 'query ips');
    eq(q({ kind: 'ips', q: '2.2.2.2' }).total, 1, 'query ips: filter');
    const sum = q({ kind: 'ipSummary' }).rows;
    eq(sum[0].ip, '1.1.1.1', 'ipSummary: busiest first');
    eq(sum[0].count, 3, 'ipSummary: count');
    ok(q({ kind: 'timeline' }).total > 0, 'query timeline');
    const media = q({ kind: 'media' });
    eq(media.rows.filter(m => m.file === 'p1.jpg').length, 1, 'query media: case aliases listed once');
    const s = q({ kind: 'search', q: 'PRES ONLY' });
    eq(s.total, 1, 'search: case-insensitive, finds the message');
    eq(s.rows[0].type, 'message', 'search: row type');
    const s2 = q({ kind: 'search', q: '1.1.1.1', limit: 2 });
    eq(s2.rows.length, 2, 'search: limit');
    ok(s2.truncated && s2.total === 3, 'search: truncated flag + true total');
    eq(q({ kind: 'search', q: '  ' }).total, 0, 'search: blank -> nothing');
    const ipKey = all.rows[0].key;
    const msgKey = q({ kind: 'thread', thread: th.key }).rows[0].key;
    const k = q({ kind: 'keys', keys: ['c:ip_addresses:' + ipKey, 'm:' + th.key + ':' + msgKey, 'c:ip_addresses:deadbeef.1', 'm:nothread:x.1', 'garbage', 'c:nocat:x.1'] });
    eq(k.items.length, 1, 'keys: item resolved');
    eq(k.items[0].flagKey, 'c:ip_addresses:' + ipKey, 'keys: flagKey echoed');
    eq(k.messages.length, 1, 'keys: message resolved');
    eq(k.messages[0].threadId, 'T1', 'keys: message carries its thread');
    deq(k.missing.sort(), ['c:ip_addresses:deadbeef.1', 'c:nocat:x.1', 'garbage', 'm:nothread:x.1'], 'keys: unknown keys reported, never dropped');
    throws(() => q({ kind: 'bogus' }), /Unknown query kind/, 'query: unknown kind');
    throws(() => Store.query(path.join(tmp, 'nowhere'), { kind: 'items' }), /no store on disk/, 'query: missing store');
}
{
    const mp = Store.mediaPath(dir, 'linked_media/p1.jpg');
    eq(mp && mp.path, path.join(dir, 'linked_media', 'p1.jpg'), 'mediaPath: resolves');
    eq(mp && mp.entry.kind, 'image', 'mediaPath: entry');
    eq(Store.mediaPath(dir, 'linked_media/evil.jpg'), null, 'mediaPath: backslash climb refused');
    eq(Store.mediaPath(dir, 'linked_media/evil2.jpg'), null, 'mediaPath: ../store refused');
    eq(Store.mediaPath(dir, 'linked_media/none.jpg'), null, 'mediaPath: unknown ref');
}
{
    throws(() => Store.safeKey('../..'), /Invalid store key/, 'safeKey: traversal-only key refused');
    eq(Store.safeKey('ab/../cd'), 'abcd', 'safeKey: strips separators');
    eq(Store.storeKeyFor('C:\\X\\Ret.zip'), Store.storeKeyFor('c:\\x\\ret.zip'), 'storeKeyFor: case-insensitive path');
    eq(path.dirname(Store.storeDir(caseDir, 'a.b')), Store.returnsRoot(caseDir), 'storeDir stays in returns root');
}
{
    // listStores / sweepLeftovers / swapIn / deleteStore
    const root = Store.returnsRoot(caseDir);
    fs.mkdirSync(path.join(root, key + '.staging-1a2b'), { recursive: true });
    fs.mkdirSync(path.join(root, key + '.old-zz9'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nometa'), { recursive: true });
    const list = Store.listStores(caseDir);
    deq(list.map(x => x.storeKey), [key], 'listStores: only folders with meta.json, no leftovers');
    eq(list[0].fileName, 'ret.zip', 'listStores: meta fields');
    eq(Store.sweepLeftovers(caseDir), 2, 'sweepLeftovers: removes staging + old');
    ok(fs.existsSync(dir) && fs.existsSync(path.join(root, 'nometa')), 'sweepLeftovers: leaves real folders alone');

    // swapIn: new copy replaces old, cache is not stale
    Store.readIndex(dir);   // warm the cache
    const staging = path.join(root, key + '.staging-new');
    fs.mkdirSync(path.join(staging, 'store'), { recursive: true });
    Store.writeJson(path.join(staging, 'store', 'index.json'), { version: 1, marker: 'NEW', categories: [], threads: [], pages: [] });
    Store.swapIn(staging, dir);
    eq(Store.readIndex(dir).marker, 'NEW', 'swapIn: new index served (cache cleared)');
    ok(!fs.existsSync(staging), 'swapIn: staging moved');
    deq(fs.readdirSync(root).filter(n => /\.old-/.test(n)), [], 'swapIn: old copy removed');

    // swapIn failure: staging missing -> old copy restored
    let threw = false;
    try { Store.swapIn(path.join(root, key + '.staging-missing'), dir); } catch (_) { threw = true; }
    ok(threw, 'swapIn: failure surfaces');
    eq(Store.readIndex(dir) && Store.readIndex(dir).marker, 'NEW', 'swapIn: failed swap keeps the previous copy');

    ok(Store.deleteStore(caseDir, key) && !fs.existsSync(dir), 'deleteStore removes the folder');
    eq(Store.readIndex(dir), null, 'deleteStore: index gone (no stale cache)');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(`\nmeta-merge-store: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
