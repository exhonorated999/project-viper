/**
 * Merge the pages of one Meta return (records.html + preservation-N.html)
 * into a single deduplicated model.  Main-process only (uses crypto).
 *
 * ── Rules ──────────────────────────────────────────────────────────────
 * - Pages are added one at a time so a caller can drop each parsed page
 *   before reading the next (a 22-page Instagram return is ~300 MB of HTML).
 * - An item's identity is its content: group labels + fields.  The same
 *   item on several pages is ONE item whose `src` lists every page it is on.
 * - Identity is occurrence-aware: if a page holds the same row twice, so
 *   does the merge (key `<hash>.1`, `<hash>.2`) — two identical logins are
 *   two logins, and the same pair on another page is still only two.
 * - Threads merge by (category, thread id); messages inside by content.
 * - Nothing is ever dropped: a category we have no special view for is
 *   still merged item-by-item and shown generically.
 */

'use strict';

const crypto = require('crypto');
const MI = require('./meta-interpret');

// Meta's CDN links are signed per export (`?...&oh=..&oe=..`) AND served from
// a different edge host each time (`interncache-nao` vs `interncache-ftw`),
// so the same message on records.html and preservation-3.html carries
// different URLs.  Identity keeps only the path; the stored item keeps the
// full URL.
function identityReplacer(k, v) {
    return (typeof v === 'string' && /^https?:\/\//i.test(v)) ? v.replace(/^https?:\/\/[^/?#]*/i, '').replace(/[?#].*$/, '') : v;
}

function hashOf(obj) {
    return crypto.createHash('sha1').update(JSON.stringify(obj, identityReplacer)).digest('hex').slice(0, 16);
}

function pageKind(name) {
    const b = String(name || '').split(/[\\/]/).pop();
    if (/^records\.html?$/i.test(b)) return 'records';
    if (/preservation/i.test(b)) return 'preservation';
    return 'page';
}

function preservationNo(name) {
    const m = /preservation[-_ ]?(\d+)/i.exec(String(name || ''));
    return m ? parseInt(m[1], 10) : null;
}

/** records first, then preservation-1..N numerically, then anything else by name. */
function sortPageNames(names) {
    return names.slice().sort((a, b) => {
        const ka = pageKind(a), kb = pageKind(b);
        const ra = ka === 'records' ? 0 : ka === 'preservation' ? 1 : 2;
        const rb = kb === 'records' ? 0 : kb === 'preservation' ? 1 : 2;
        if (ra !== rb) return ra - rb;
        if (ra === 1) return (preservationNo(a) || 0) - (preservationNo(b) || 0);
        return String(a).localeCompare(String(b));
    });
}

/** Resolve a media src relative to the page's folder inside the return. */
function resolveRef(src, pageDir) {
    let s = String(src || '').trim().replace(/\\/g, '/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;   // http:, data:, file: — not part of the return
    s = s.replace(/[?#].*$/, '');
    try { s = decodeURIComponent(s); } catch (_) { /* keep raw */ }
    const parts = (pageDir ? String(pageDir).replace(/\\/g, '/').split('/') : []).concat(s.split('/'));
    const out = [];
    for (const p of parts) {
        if (!p || p === '.') continue;
        if (p === '..') { out.pop(); continue; }
        out.push(p);
    }
    return out.join('/');
}

/** Rewrite every media src in a Field list to its return-relative ref (in place). */
function rewriteMedia(fields, pageDir, onRef) {
    const visitV = (v) => {
        if (!v) return;
        if (v.m) {
            for (const m of v.m) {
                const r = resolveRef(m.s, pageDir);
                if (r) { m.s = r; if (onRef) onRef(r, m.k); }
            }
        }
        for (const rec of (v.r || [])) for (const f of rec) visitV(f.v);
    };
    for (const f of (fields || [])) visitV(f.v);
}

class MetaMerger {
    constructor() {
        this.pages = [];
        this.cats = new Map();      // id -> entry
        this.threads = new Map();   // key -> entry
        this.params = null;
        this.service = '';
        this.title = '';
        this.mediaRefs = new Map(); // ref -> kind (from the HTML tag)
    }

    addPage(name, page, opts) {
        const pageDir = (opts && opts.pageDir) || '';
        const pi = this.pages.length;
        const kind = pageKind(name);
        const info = { name, kind, title: page.title || '', service: page.service || '', layout: page.layout || '', categories: (page.categories || []).length, items: 0 };
        this.pages.push(info);
        if (!this.title && page.title) this.title = page.title;
        if (!this.service && page.service) this.service = page.service;
        const onRef = (r, k) => { if (!this.mediaRefs.has(r) || this.mediaRefs.get(r) === 'file') this.mediaRefs.set(r, k); };

        for (const cat of (page.categories || [])) {
            let e = this.cats.get(cat.id);
            if (!e) {
                e = { id: cat.id, name: cat.name, def: [], notes: [], kind: 'items', items: new Map(), pages: [], emptyOn: [] };
                this.cats.set(cat.id, e);
            }
            e.pages.push(pi);
            if (!e.def.length && cat.def && cat.def.length) e.def = cat.def;
            if (!e.notes.length && cat.notes && cat.notes.length) e.notes = cat.notes;

            if (/^request_parameters$/i.test(cat.id)) {
                const p = MI.requestParams(cat);
                info.params = p;
                if (!this.params || (kind === 'records' && this.params._kind !== 'records')) {
                    this.params = Object.assign({ _kind: kind }, p);
                }
            }

            const isThreads = MI.isThreadCategory(cat);
            if (isThreads) {
                e.kind = 'threads';
                for (const th of MI.threads(cat)) this._addThread(cat.id, th, pi, pageDir, onRef);
            }

            const occ = new Map();
            let real = 0;
            for (const it of MI.items(isThreads ? MI.nonThreadPart(cat) : cat)) {
                if (MI.isNoRecords(it.f)) continue;
                real++;
                rewriteMedia(it.f, pageDir, onRef);
                const h = hashOf({ g: it.g, f: it.f });
                const n = (occ.get(h) || 0) + 1;
                occ.set(h, n);
                const key = h + '.' + n;
                const have = e.items.get(key);
                if (have) { if (have.src[have.src.length - 1] !== pi) have.src.push(pi); }
                else e.items.set(key, { key, g: it.g, f: it.f, src: [pi], t: MI.itemTime(it.f) });
                info.items++;
            }
            if (!real && !isThreads) e.emptyOn.push(pi);
        }
        return pi;
    }

    _addThread(catId, th, pi, pageDir, onRef) {
        const ident = th.threadId || hashOf(th.participants);
        const key = hashOf([catId, ident]).slice(0, 12);
        let e = this.threads.get(key);
        if (!e) {
            e = { key, cat: catId, threadId: th.threadId, name: th.name, participants: [], past: [], header: th.header, src: [], messages: new Map() };
            this.threads.set(key, e);
        }
        if (e.src[e.src.length - 1] !== pi) e.src.push(pi);
        if (!e.name && th.name) e.name = th.name;
        for (const p of th.participants) if (e.participants.indexOf(p) < 0) e.participants.push(p);
        for (const p of th.past) if (e.past.indexOf(p) < 0) e.past.push(p);
        rewriteMedia(th.header, pageDir, onRef);
        const occ = new Map();
        for (const m of th.messages) {
            rewriteMedia(m.f, pageDir, onRef);
            const h = hashOf(m.f);
            const n = (occ.get(h) || 0) + 1;
            occ.set(h, n);
            const mk = h + '.' + n;
            const have = e.messages.get(mk);
            if (have) { if (have.src[have.src.length - 1] !== pi) have.src.push(pi); }
            else e.messages.set(mk, { key: mk, author: m.author, sent: m.sent, body: m.body, f: m.f, src: [pi] });
        }
        this.pages[pi].items += th.messages.length;
    }

    /**
     * @returns {{service,title,params,pages,categories,items,threads,ips,timeline,mediaRefs,mediaUse}}
     */
    finish() {
        const recordsPi = this.pages.findIndex(p => p.kind === 'records');
        const notInRecords = (src) => recordsPi >= 0 && src.indexOf(recordsPi) < 0;
        const categories = [];
        const items = {};
        const ips = [];
        const timeline = [];
        const mediaUse = {};
        const use = (ref, where) => { (mediaUse[ref] = mediaUse[ref] || []).length < 20 && mediaUse[ref].push(where); };

        for (const e of this.cats.values()) {
            const c = { id: e.id, name: e.name, def: e.def, notes: e.notes, kind: e.kind, pages: e.pages, emptyOn: e.emptyOn, count: 0, onlyPres: 0, media: 0, timed: 0 };
            // Every page carries its own request parameters; a different
            // "Generated" stamp on a preservation is not extra evidence.
            const perPage = /^request_parameters$/i.test(e.id);
            if (perPage) c.perPage = true;
            {
                // threads categories may also carry plain records beside the threads
                const list = Array.from(e.items.values());
                if (e.kind === 'items' || list.length) items[e.id] = list;
                c.count = list.length;
                c.items = list.length;
                const seen = new Set();
                for (const it of list) {
                    if (!perPage && notInRecords(it.src)) c.onlyPres++;
                    if (it.t) {
                        c.timed++;
                        timeline.push({ t: it.t, c: e.id, k: it.key, s: MI.summary(it.f, 120) });
                    }
                    for (const m of MI.deepMedia(it.f)) {
                        if (!seen.has(m.s)) { seen.add(m.s); c.media++; }
                        use(m.s, { c: e.id, k: it.key, t: it.t || '' });
                    }
                    for (const s of MI.ipsInFields(it.f)) ips.push({ ip: s.ip, t: s.t || it.t || '', c: e.id, k: it.key, f: s.k });
                }
            }
            categories.push(c);
        }

        const threads = [];
        for (const e of this.threads.values()) {
            const msgs = Array.from(e.messages.values());
            msgs.sort((a, b) => String(a.sent || '').localeCompare(String(b.sent || '')));
            let onlyPres = 0, media = 0;
            for (const m of msgs) {
                if (notInRecords(m.src)) onlyPres++;
                const mm = MI.deepMedia(m.f);
                media += mm.length;
                for (const x of mm) use(x.s, { th: e.key, k: m.key, t: m.sent || '' });
                if (m.sent) timeline.push({ t: m.sent, th: e.key, k: m.key, s: (m.author ? m.author.replace(/\s*\((Facebook|Instagram)?:?\s*\d+\)\s*$/i, '') + ': ' : '') + (MI.summary(m.f, 120) || '') });
            }
            const t = {
                key: e.key, cat: e.cat, threadId: e.threadId, name: e.name,
                participants: e.participants, past: e.past, header: e.header, src: e.src,
                count: msgs.length, onlyPres, media,
                first: msgs.length ? msgs[0].sent : '', last: msgs.length ? msgs[msgs.length - 1].sent : '',
                messages: msgs
            };
            threads.push(t);
            const c = categories.find(x => x.id === e.cat);
            if (c) { c.count += msgs.length; c.onlyPres += onlyPres; c.media += media; c.threads = (c.threads || 0) + 1; }
        }
        threads.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
        timeline.sort((a, b) => String(b.t).localeCompare(String(a.t)));
        ips.sort((a, b) => String(b.t).localeCompare(String(a.t)));

        const params = this.params ? Object.assign({}, this.params) : null;
        if (params) delete params._kind;
        return {
            service: (params && params.service) || this.service,
            title: this.title,
            params,
            pages: this.pages,
            categories,
            items,
            threads,
            ips,
            timeline,
            mediaRefs: Array.from(this.mediaRefs.entries()).map(([ref, kind]) => ({ ref, kind })),
            mediaUse
        };
    }
}

module.exports = { MetaMerger, hashOf, pageKind, preservationNo, sortPageNames, resolveRef, rewriteMedia };
