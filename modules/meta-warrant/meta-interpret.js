/**
 * Meta return interpreter — turns the generic category tree produced by
 * meta-html-tree.js into things an investigator reads: flat items, message
 * threads, request parameters, IP sightings, times and one-line summaries.
 *
 * Pure and UMD: the main process uses it at import time and the renderer
 * uses the same helpers to label what it draws.  (`module` IS defined in
 * VIPER's renderer, so assign both module.exports and root.MetaInterpret.)
 *
 * Shapes (see meta-html-tree.js):
 *   Value  = { t?: [lines], m?: [{k,s}], r?: [[Field]] }
 *   Field  = { k, v: Value }
 *   Item   = { g: [group labels], f: [Field] }
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.MetaInterpret = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    const TIME_RE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/;
    const TIME_KEY_RE = /time|date|sent|created|uploaded|taken|timestamp|updated|posted|captured|start|end|joined|when/i;
    const NOT_EVENT_KEY_RE = /range|birth|birthday|expir/i;
    const MSG_START_RE = /^(author|sender|from)$/i;
    const THREAD_KEY_RE = /^(thread|conversation|chat)$/i;
    const IP_KEY_RE = /(^|[^a-z])ip([^a-z]|$)|ip ?address|ipaddress/i;
    const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
    const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}(?::?[0-9a-f]{1,4}){1,7}\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?\b/gi;
    const SUMMARY_KEYS = ['body', 'text', 'caption', 'post', 'status', 'comment', 'title', 'message', 'content', 'description', 'name', 'query', 'search', 'url', 'link', 'value'];

    function lines(v) { return (v && Array.isArray(v.t)) ? v.t : []; }
    function text(v) { return lines(v).join('\n'); }
    function fieldText(f) { return f ? text(f.v) : ''; }

    /** 'YYYY-MM-DD HH:MM:SS' (sortable) or '' */
    function normTime(s) {
        const m = TIME_RE.exec(String(s || ''));
        if (!m) return '';
        return m[1] + ' ' + m[2] + (m[3] || ':00');
    }

    function findField(fields, re) {
        for (const f of (fields || [])) if (re.test(f.k)) return f;
        return null;
    }

    /** All media under a Value, a Field list or a Record list. Deduped by src. */
    function deepMedia(x, out, seen) {
        out = out || []; seen = seen || new Set();
        const visitV = (v) => {
            if (!v) return;
            for (const m of (v.m || [])) if (!seen.has(m.s)) { seen.add(m.s); out.push(m); }
            for (const rec of (v.r || [])) for (const f of rec) visitV(f.v);
        };
        if (Array.isArray(x)) for (const f of x) { if (Array.isArray(f)) for (const g of f) visitV(g.v); else visitV(f.v); }
        else if (x && x.v) visitV(x.v);
        else visitV(x);
        return out;
    }

    /** Every text line and key under fields, for search. */
    function deepText(fields) {
        const out = [];
        const visitV = (v) => {
            if (!v) return;
            for (const l of (v.t || [])) out.push(l);
            for (const m of (v.m || [])) out.push(m.s);
            for (const rec of (v.r || [])) for (const f of rec) { if (f.k) out.push(f.k); visitV(f.v); }
        };
        for (const f of (fields || [])) { if (f.k) out.push(f.k); visitV(f.v); }
        return out.join('\n');
    }

    function isGroupField(f) {
        const v = f && f.v;
        return !!v && Array.isArray(v.r) && v.r.length > 0 && !(v.t && v.t.length) && !(v.m && v.m.length);
    }

    /**
     * Flatten a category into items.  A record whose every field is a pure
     * container ("Album: Timeline photos" -> photos) is a grouping, not an
     * item: its children become the items and the labels go into `g`.
     */
    function items(cat) {
        const out = [];
        const v = (cat && cat.v) || {};
        const walk = (value, group, depth) => {
            for (const rec of (value.r || [])) {
                if (depth < 4 && rec.length && rec.every(isGroupField) && !rec.some(f => THREAD_KEY_RE.test(f.k))) {
                    for (const f of rec) walk(f.v, f.k ? group.concat(f.k) : group, depth + 1);
                } else {
                    out.push({ g: group, f: rec });
                }
            }
        };
        walk(v, [], 0);
        if (!out.length && ((v.t && v.t.length) || (v.m && v.m.length))) {
            const one = {};
            if (v.t) one.t = v.t;
            if (v.m) one.m = v.m;
            out.push({ g: [], f: [{ k: (cat && cat.name) || '', v: one }] });
        } else if ((v.t && v.t.length) || (v.m && v.m.length)) {
            // Loose text / media beside records.  Beside ONE record (an image
            // and its "Linked Media File:" row) it belongs to that record;
            // beside several it is its own item.  Never dropped.
            const one = {};
            if (v.t) one.t = v.t;
            if (v.m) one.m = v.m;
            if (out.length === 1) out[0] = { g: out[0].g, f: [{ k: '', v: one }].concat(out[0].f) };
            else out.unshift({ g: [], f: [{ k: '', v: one }] });
        }
        return out;
    }

    /** The event time of an item: a time-ish key first, then any top-level time value. */
    function itemTime(fields) {
        let fallback = '';
        for (const f of (fields || [])) {
            const t = normTime(lines(f.v)[0] || '');
            if (!t) continue;
            if (NOT_EVENT_KEY_RE.test(f.k)) continue;
            if (TIME_KEY_RE.test(f.k)) return t;
            if (!fallback) fallback = t;
        }
        return fallback;
    }

    function summary(fields, max) {
        max = max || 160;
        const byKey = {};
        for (const f of (fields || [])) {
            const k = String(f.k || '').toLowerCase();
            if (!(k in byKey) && lines(f.v).length) byKey[k] = text(f.v);
        }
        let s = '';
        for (const want of SUMMARY_KEYS) {
            if (byKey[want]) { s = byKey[want]; break; }
        }
        if (!s) {
            for (const f of (fields || [])) {
                const t = text(f.v);
                if (t && !normTime(t)) { s = (f.k ? f.k + ': ' : '') + t; break; }
            }
        }
        if (!s) {
            const media = deepMedia(fields);
            if (media.length) s = media.length + ' media file' + (media.length === 1 ? '' : 's');
        }
        s = String(s).replace(/\s+/g, ' ').trim();
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function isThreadCategory(cat) {
        const v = (cat && cat.v) || {};
        for (const rec of (v.r || [])) for (const f of rec) if (THREAD_KEY_RE.test(f.k) && f.v && f.v.r) return true;
        return false;
    }

    function participantLines(f) {
        return lines(f && f.v).filter(l => l && !(normTime(l) && l.replace(TIME_RE, '').replace(/\bUTC\b/i, '').trim() === ''));
    }

    function parseThreadValue(v) {
        const first = lines(v)[0] || '';
        const m = /^\(?\s*([^()\s][^()]*?)\s*\)?$/.exec(first.trim());
        const threadId = m ? m[1] : first.trim();
        const stream = [];
        for (const rec of (v.r || [])) for (const f of rec) stream.push(f);
        const hasStart = stream.some(f => MSG_START_RE.test(f.k));
        const header = [];
        const messages = [];
        if (hasStart) {
            let cur = null;
            for (const f of stream) {
                if (MSG_START_RE.test(f.k)) { cur = []; messages.push(cur); }
                if (cur) cur.push(f); else header.push(f);
            }
        } else {
            // No author rows: every record that carries a time is a message.
            for (const rec of (v.r || [])) {
                if (itemTime(rec)) messages.push(rec); else for (const f of rec) header.push(f);
            }
        }
        const nameF = findField(header, /^(thread name|name|title)$/i);
        const cur = findField(header, /^(current participants|participants)$/i);
        const past = findField(header, /^past participants$/i);
        return {
            threadId,
            name: nameF ? fieldText(nameF) : '',
            participants: participantLines(cur),
            past: participantLines(past),
            header,
            messages: messages.map(msgFromFields)
        };
    }

    function msgFromFields(fields) {
        const a = findField(fields, MSG_START_RE);
        const s = findField(fields, /^(sent|time|timestamp|date)$/i);
        const b = findField(fields, /^(body|text|message|content)$/i);
        return {
            author: a ? fieldText(a) : '',
            sent: s ? normTime(fieldText(s)) || fieldText(s) : itemTime(fields),
            body: b ? fieldText(b) : '',
            f: fields
        };
    }

    /** Threads of a messages category: [{threadId, name, participants, past, header, messages}] */
    function threads(cat) {
        const out = [];
        const v = (cat && cat.v) || {};
        for (const rec of (v.r || [])) {
            for (const f of rec) {
                if (THREAD_KEY_RE.test(f.k) && f.v) out.push(parseThreadValue(f.v));
            }
        }
        return out;
    }

    /** The part of a messages category that is NOT a thread (kept as plain items, never dropped). */
    function nonThreadPart(cat) {
        const v = (cat && cat.v) || {};
        const r = (v.r || []).filter(rec => !rec.some(f => THREAD_KEY_RE.test(f.k)));
        const out = { r };
        if (v.t) out.t = v.t;
        if (v.m) out.m = v.m;
        return { id: cat && cat.id, name: cat && cat.name, v: out };
    }

    /** {key: text} for the first item of a category (request parameters). */
    function keyValues(cat) {
        const its = items(cat);
        const out = {};
        for (const it of its) for (const f of it.f) if (f.k && !(f.k in out)) out[f.k] = text(f.v);
        return out;
    }

    function requestParams(cat) {
        const kv = keyValues(cat);
        const get = (re) => { for (const k of Object.keys(kv)) if (re.test(k)) return kv[k]; return ''; };
        return {
            service: get(/^service$/i),
            target: get(/^target$/i),
            accountId: get(/^account (identifier|id)$/i),
            accountType: get(/^account type$/i),
            generated: get(/^generated$/i),
            dateRange: get(/^date range$/i),
            all: kv
        };
    }

    /**
     * Meta's "nothing here" placeholder ("No responsive records located").
     * Not a record: storing it would make an empty preservation look like
     * it holds something the records page lacks.
     * Deliberately NOT "None" / "N/A": a one-row record whose value is
     * "None" (e.g. two-factor: None) is evidence and must be kept.
     */
    const NO_RECORDS_RE = /^\s*no (responsive )?(records?|data|results|information)( (were |was )?(located|found|available|responsive))?\s*\.?\s*$/i;
    function isNoRecords(fields) {
        if (!fields || !fields.length) return true;
        if (deepMedia(fields).length) return false;
        const vals = [];
        const visit = (fs) => {
            for (const f of fs) {
                for (const l of lines(f.v)) if (String(l).trim()) vals.push(String(l).trim());
                for (const rec of ((f.v && f.v.r) || [])) visit(rec);
            }
        };
        visit(fields);
        return vals.length > 0 && vals.every(l => NO_RECORDS_RE.test(l));
    }

    function extractIps(s) {
        const out = [];
        const str = String(s || '');
        for (const m of str.match(IPV4_RE) || []) out.push(m);
        if (!out.length && str.indexOf(':') >= 0) {
            for (const m of str.match(IPV6_RE) || []) {
                if (/[a-f]/i.test(m) || (m.match(/:/g) || []).length >= 3) out.push(m.toLowerCase());
            }
        }
        return out;
    }

    /**
     * IP sightings in one item, anywhere in its tree, from rows whose key
     * says IP.  Time = the nearest record's own time, else the item's.
     */
    function ipsInFields(fields) {
        const out = [];
        const itemT = itemTime(fields);
        const visitRec = (rec, inheritedT) => {
            const recT = itemTime(rec) || inheritedT;
            for (const f of rec) {
                if (IP_KEY_RE.test(f.k)) {
                    for (const l of lines(f.v)) for (const ip of extractIps(l)) out.push({ ip, t: recT, k: f.k });
                }
                for (const sub of ((f.v && f.v.r) || [])) visitRec(sub, recT);
            }
        };
        visitRec(fields || [], itemT);
        return out;
    }

    return {
        TIME_RE, normTime, lines, text, fieldText, findField, deepMedia, deepText,
        items, itemTime, summary, isThreadCategory, threads, parseThreadValue, nonThreadPart,
        keyValues, requestParams, extractIps, ipsInFields, isNoRecords, NO_RECORDS_RE
    };
});
