/**
 * On-disk store for imported Meta (Facebook / Instagram) returns.
 * Main-process only (fs), no Electron import — runs headless in tests.
 *
 * ── Why ────────────────────────────────────────────────────────────────
 * The old module put the whole parse into localStorage (≈10 MB quota) and
 * every photo into memory as base64.  An Instagram return with 22 pages and
 * 788 media files (Scout submission #20) cannot fit either way.  Now:
 *
 *   <case>/Evidence/MetaWarrant/returns/<storeKey>/
 *       meta.json            light import record (also the recovery source)
 *       store/index.json     categories, threads (no messages), pages, params
 *       store/c<N>.json      items of category N         (paged on demand)
 *       store/t<N>.json      messages of thread N        (paged on demand)
 *       store/ips.json       every IP sighting
 *       store/timeline.json  every timed item / message
 *       store/media.json     ref -> stored file, size, real type
 *       store/mediause.json  ref -> where it is used
 *       linked_media/        the return's media (vault-encrypted when on)
 *
 * The renderer keeps only the light record and asks for one page at a time.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MI = require('./meta-interpret');

const STORE_VERSION = 1;
const MAX_LIMIT = 500;

function storeKeyFor(filePath) {
    return crypto.createHash('sha1').update(String(filePath || '').toLowerCase()).digest('hex').slice(0, 16);
}

function safeKey(key) {
    const k = String(key || '').replace(/[^A-Za-z0-9]/g, '');
    if (!k) throw new Error('Invalid store key');
    return k;
}

function returnsRoot(caseDir) {
    return path.join(caseDir, 'Evidence', 'MetaWarrant', 'returns');
}

function storeDir(caseDir, key) {
    return path.join(returnsRoot(caseDir), safeKey(key));
}

function writeJson(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Write a merged model (meta-merge finish()) into `dir/store`.
 * @returns {object} the index that was written
 */
function writeStore(dir, merged, extra) {
    const sdir = path.join(dir, 'store');
    fs.mkdirSync(sdir, { recursive: true });
    const categories = merged.categories.map((c, i) => Object.assign({}, c, { file: 'c' + i + '.json' }));
    categories.forEach((c) => {
        if (c.kind === 'items' || (merged.items[c.id] && merged.items[c.id].length)) writeJson(path.join(sdir, c.file), merged.items[c.id] || []);
        else delete c.file;
    });
    const threads = merged.threads.map((t, i) => {
        writeJson(path.join(sdir, 't' + i + '.json'), t.messages);
        const o = Object.assign({}, t, { file: 't' + i + '.json' });
        delete o.messages;
        return o;
    });
    writeJson(path.join(sdir, 'ips.json'), merged.ips);
    writeJson(path.join(sdir, 'timeline.json'), merged.timeline);
    writeJson(path.join(sdir, 'mediause.json'), merged.mediaUse || {});
    const totals = {
        pages: merged.pages.length,
        preservations: merged.pages.filter(p => p.kind === 'preservation').length,
        categories: categories.length,
        items: categories.reduce((n, c) => n + (c.items || 0), 0),
        threads: threads.length,
        messages: threads.reduce((n, t) => n + t.count, 0),
        ips: merged.ips.length,
        timeline: merged.timeline.length,
        mediaRefs: (merged.mediaRefs || []).length
    };
    const index = Object.assign({
        version: STORE_VERSION,
        service: merged.service,
        title: merged.title,
        params: merged.params,
        pages: merged.pages,
        categories,
        threads,
        totals
    }, extra || {});
    writeJson(path.join(sdir, 'index.json'), index);
    return index;
}

// ── Read side ──────────────────────────────────────────────────────────

const _cache = new Map();   // abs file -> { mtimeMs, size, data, search? }
const CACHE_MAX = 6;

function readJsonCached(file) {
    const st = fs.statSync(file);
    const hit = _cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        _cache.delete(file); _cache.set(file, hit);   // LRU bump
        return hit;
    }
    const entry = { mtimeMs: st.mtimeMs, size: st.size, data: JSON.parse(fs.readFileSync(file, 'utf8')), search: null };
    _cache.set(file, entry);
    while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    return entry;
}

function clearCache(prefix) {
    for (const k of Array.from(_cache.keys())) if (!prefix || k.startsWith(prefix)) _cache.delete(k);
}

function readIndex(dir) {
    const f = path.join(dir, 'store', 'index.json');
    if (!fs.existsSync(f)) return null;
    return readJsonCached(f).data;
}

function readMediaMap(dir) {
    const f = path.join(dir, 'store', 'media.json');
    if (!fs.existsSync(f)) return {};
    return readJsonCached(f).data || {};
}

function readMeta(dir) {
    const f = path.join(dir, 'meta.json');
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

function searchStrings(entry, toText) {
    if (!entry.search) entry.search = entry.data.map(x => toText(x).toLowerCase());
    return entry.search;
}

function itemText(it) { return (it.g || []).join('\n') + '\n' + MI.deepText(it.f); }
function msgText(m) { return MI.deepText(m.f); }
function rowText(r) { return [r.ip, r.t, r.c, r.f, r.s].filter(Boolean).join(' '); }

function clampPage(req) {
    const offset = Math.max(0, parseInt(req.offset, 10) || 0);
    let limit = parseInt(req.limit, 10) || 100;
    limit = Math.max(1, Math.min(MAX_LIMIT, limit));
    return { offset, limit };
}

function pageOf(list, req) {
    const { offset, limit } = clampPage(req);
    return { total: list.length, offset, limit, rows: list.slice(offset, offset + limit) };
}

/** Filter + sort a cached array without copying the cache itself. */
function filtered(entry, req, toText) {
    let idx = entry.data.map((_, i) => i);
    const q = String(req.q || '').trim().toLowerCase();
    if (q) {
        const s = searchStrings(entry, toText);
        idx = idx.filter(i => s[i].indexOf(q) >= 0);
    }
    if (typeof req.page === 'number') idx = idx.filter(i => (entry.data[i].src || []).indexOf(req.page) >= 0);
    if (req.onlyPres && typeof req.recordsPage === 'number') {
        idx = idx.filter(i => (entry.data[i].src || []).indexOf(req.recordsPage) < 0);
    }
    if (req.sort === 'time-desc' || req.sort === 'time-asc') {
        const dir = req.sort === 'time-desc' ? -1 : 1;
        const tk = (x) => x.t || x.sent || '';
        idx.sort((a, b) => {
            const ta = tk(entry.data[a]), tb = tk(entry.data[b]);
            if (!ta && !tb) return a - b;
            if (!ta) return 1;
            if (!tb) return -1;
            return ta === tb ? a - b : (ta < tb ? -dir : dir);
        });
    }
    return idx;
}

function recordsPageOf(index) {
    return (index.pages || []).findIndex(p => p.kind === 'records');
}

function snippet(text, q) {
    const s = String(text || '').replace(/\s+/g, ' ');
    const i = s.toLowerCase().indexOf(String(q).toLowerCase());
    if (i < 0) return s.slice(0, 140);
    const a = Math.max(0, i - 60);
    return (a > 0 ? '…' : '') + s.slice(a, i + q.length + 80) + (i + q.length + 80 < s.length ? '…' : '');
}

/**
 * One query entry point (keeps the IPC surface to a single channel).
 * kinds: items | thread | threads | ips | ipSummary | timeline | media | search | keys
 */
function query(dir, req) {
    req = req || {};
    const index = readIndex(dir);
    if (!index) throw new Error('This Meta return has no store on disk (re-import it).');
    const sdir = path.join(dir, 'store');
    const recordsPage = recordsPageOf(index);
    const r = Object.assign({ recordsPage }, req);

    switch (req.kind) {
        case 'items': {
            const cat = index.categories.find(c => c.id === req.cat);
            if (!cat || !cat.file) return { total: 0, offset: 0, limit: 0, rows: [] };
            const entry = readJsonCached(path.join(sdir, cat.file));
            const idx = filtered(entry, r, itemText);
            const p = pageOf(idx, r);
            p.rows = p.rows.map(i => entry.data[i]);
            return p;
        }
        case 'thread': {
            const th = index.threads.find(t => t.key === req.thread);
            if (!th) return { total: 0, offset: 0, limit: 0, rows: [] };
            const entry = readJsonCached(path.join(sdir, th.file));
            const idx = filtered(entry, r, msgText);
            const p = pageOf(idx, r);
            p.rows = p.rows.map(i => entry.data[i]);
            return p;
        }
        case 'threads': {
            const q = String(req.q || '').trim().toLowerCase();
            let list = index.threads;
            if (req.cat) list = list.filter(t => t.cat === req.cat);
            if (q) {
                list = list.filter(t => [t.threadId, t.name].concat(t.participants || [], t.past || []).join('\n').toLowerCase().indexOf(q) >= 0 ||
                    msgMatches(sdir, t, q));
            }
            return pageOf(list, r);
        }
        case 'ips':
        case 'timeline': {
            const entry = readJsonCached(path.join(sdir, req.kind + '.json'));
            const idx = filtered(entry, Object.assign({}, r, { sort: null, page: undefined, onlyPres: false }), rowText);
            const p = pageOf(idx, r);
            p.rows = p.rows.map(i => entry.data[i]);
            return p;
        }
        case 'ipSummary': {
            const entry = readJsonCached(path.join(sdir, 'ips.json'));
            const by = new Map();
            for (const s of entry.data) {
                let a = by.get(s.ip);
                if (!a) { a = { ip: s.ip, count: 0, first: '', last: '', cats: [] }; by.set(s.ip, a); }
                a.count++;
                if (s.t && (!a.first || s.t < a.first)) a.first = s.t;
                if (s.t && (!a.last || s.t > a.last)) a.last = s.t;
                if (a.cats.indexOf(s.c) < 0) a.cats.push(s.c);
            }
            const list = Array.from(by.values()).sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)));
            return pageOf(list, r);
        }
        case 'media': {
            const map = readMediaMap(dir);
            const useF = path.join(sdir, 'mediause.json');
            const usage = fs.existsSync(useF) ? readJsonCached(useF).data : {};
            const seenFiles = new Set();
            let list = Object.keys(map).filter(ref => {
                // case-variant aliases point at the same stored file — list it once
                const f = String(map[ref].file || ref).toLowerCase();
                if (seenFiles.has(f)) return false;
                seenFiles.add(f);
                return true;
            }).map(ref => Object.assign({ ref }, map[ref], { use: (usage[ref] || []).slice(0, 3), used: (usage[ref] || []).length }));
            if (req.mediaKind) list = list.filter(m => m.kind === req.mediaKind);
            if (req.q) { const q = String(req.q).toLowerCase(); list = list.filter(m => m.ref.toLowerCase().indexOf(q) >= 0); }
            list.sort((a, b) => {
                const ta = (a.use[0] && a.use[0].t) || '', tb = (b.use[0] && b.use[0].t) || '';
                return ta === tb ? a.ref.localeCompare(b.ref) : (ta < tb ? 1 : -1);
            });
            return pageOf(list, r);
        }
        case 'search': return search(dir, index, req);
        case 'keys': return byKeys(dir, index, req.keys || []);
        default: throw new Error('Unknown query kind: ' + req.kind);
    }
}

function msgMatches(sdir, th, q) {
    try {
        const entry = readJsonCached(path.join(sdir, th.file));
        return searchStrings(entry, msgText).some(s => s.indexOf(q) >= 0);
    } catch (_) { return false; }
}

function search(dir, index, req) {
    const q = String(req.q || '').trim();
    const limit = Math.min(MAX_LIMIT, parseInt(req.limit, 10) || 200);
    if (!q) return { total: 0, rows: [], truncated: false };
    const ql = q.toLowerCase();
    const sdir = path.join(dir, 'store');
    const rows = [];
    let total = 0;
    for (const c of index.categories) {
        if (!c.file) continue;
        const entry = readJsonCached(path.join(sdir, c.file));
        const s = searchStrings(entry, itemText);
        for (let i = 0; i < s.length; i++) {
            if (s[i].indexOf(ql) < 0) continue;
            total++;
            if (rows.length < limit) rows.push({ type: 'item', cat: c.id, catName: c.name, key: entry.data[i].key, t: entry.data[i].t || '', text: snippet(itemText(entry.data[i]), q) });
        }
    }
    for (const th of index.threads) {
        const entry = readJsonCached(path.join(sdir, th.file));
        const s = searchStrings(entry, msgText);
        for (let i = 0; i < s.length; i++) {
            if (s[i].indexOf(ql) < 0) continue;
            total++;
            const m = entry.data[i];
            if (rows.length < limit) rows.push({ type: 'message', thread: th.key, threadName: th.name || th.threadId, key: m.key, t: m.sent || '', author: m.author, text: snippet(msgText(m), q) });
        }
    }
    return { total, rows, truncated: total > rows.length };
}

/**
 * Resolve flag keys:  'c:<catId>:<itemKey>'  or  'm:<threadKey>:<msgKey>'.
 * Unknown keys come back in `missing` (never silently dropped).
 */
function byKeys(dir, index, keys) {
    const sdir = path.join(dir, 'store');
    const wantC = new Map(), wantM = new Map();
    const missing = [];
    for (const k of keys) {
        const m = /^([cm]):([^:]+):(.+)$/.exec(String(k));
        if (!m) { missing.push(k); continue; }
        const map = m[1] === 'c' ? wantC : wantM;
        if (!map.has(m[2])) map.set(m[2], new Set());
        map.get(m[2]).add(m[3]);
    }
    const items = [];
    for (const [catId, set] of wantC) {
        const c = index.categories.find(x => x.id === catId);
        if (!c || !c.file) { for (const k of set) missing.push('c:' + catId + ':' + k); continue; }
        const entry = readJsonCached(path.join(sdir, c.file));
        const found = new Set();
        for (const it of entry.data) if (set.has(it.key)) { items.push(Object.assign({ flagKey: 'c:' + catId + ':' + it.key, cat: catId, catName: c.name }, it)); found.add(it.key); }
        for (const k of set) if (!found.has(k)) missing.push('c:' + catId + ':' + k);
    }
    const messages = [];
    for (const [thKey, set] of wantM) {
        const th = index.threads.find(x => x.key === thKey);
        if (!th) { for (const k of set) missing.push('m:' + thKey + ':' + k); continue; }
        const entry = readJsonCached(path.join(sdir, th.file));
        const found = new Set();
        for (const m of entry.data) if (set.has(m.key)) {
            messages.push(Object.assign({ flagKey: 'm:' + thKey + ':' + m.key, thread: thKey, threadId: th.threadId, threadName: th.name, participants: th.participants }, m));
            found.add(m.key);
        }
        for (const k of set) if (!found.has(k)) missing.push('m:' + thKey + ':' + k);
    }
    return { items, messages, missing };
}

/** Absolute path of a stored media file, or null.  Never leaves the store's linked_media. */
function mediaPath(dir, ref) {
    const map = readMediaMap(dir);
    const e = map[ref];
    if (!e || !e.file) return null;
    const base = path.resolve(dir, 'linked_media');
    const p = path.resolve(base, e.file);
    if (p !== base && !p.startsWith(base + path.sep)) return null;
    return { path: p, entry: e };
}

function listStores(caseDir) {
    const root = returnsRoot(caseDir);
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const name of fs.readdirSync(root)) {
        if (!/^[A-Za-z0-9]+$/.test(name)) continue;   // skips .staging / .old leftovers
        const meta = readMeta(path.join(root, name));
        if (meta) out.push(Object.assign({}, meta, { storeKey: name }));
    }
    return out;
}

function deleteStore(caseDir, key) {
    const dir = storeDir(caseDir, key);
    clearCache(dir);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return true;
}

/**
 * Replace `finalDir` with `stagingDir` so a failed re-import never costs the
 * previous good copy.
 */
function swapIn(stagingDir, finalDir) {
    clearCache(finalDir);
    let old = null;
    if (fs.existsSync(finalDir)) {
        old = finalDir + '.old-' + Date.now().toString(36);
        fs.renameSync(finalDir, old);
    }
    try {
        fs.renameSync(stagingDir, finalDir);
    } catch (e) {
        if (old) { try { fs.renameSync(old, finalDir); } catch (_) {} }
        throw e;
    }
    if (old) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (_) {} }
}

/** Remove .staging-* / .old-* leftovers from an interrupted import. */
function sweepLeftovers(caseDir) {
    const root = returnsRoot(caseDir);
    if (!fs.existsSync(root)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(root)) {
        if (/\.(staging|old)-[a-z0-9]+$/i.test(name)) {
            try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); n++; } catch (_) {}
        }
    }
    return n;
}

module.exports = {
    STORE_VERSION, MAX_LIMIT,
    storeKeyFor, safeKey, returnsRoot, storeDir, writeJson, writeStore,
    readIndex, readMediaMap, readMeta, query, mediaPath, listStores, deleteStore,
    swapIn, sweepLeftovers, clearCache
};
