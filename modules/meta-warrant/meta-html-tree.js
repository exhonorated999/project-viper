/**
 * Meta (Facebook / Instagram) return page -> generic category tree.
 * Main-process only (node-html-parser); no Electron import, so it runs headless.
 *
 * ── Why generic ────────────────────────────────────────────────────────
 * The old parser knew 12 Facebook categories by id and silently dropped the
 * rest.  An Instagram return (Scout submission #20) has ~75 categories per
 * page and a newer markup: no <br> separators, <video>/<audio>/<source>
 * media.  Every Meta page is built from the same primitive, so we parse the
 * primitive and let the interpreter give known categories a richer view:
 *
 *   <div id="property-<snake_id>" class="content-pane">        a category
 *     <div class="div_table">                                  wrapper
 *       <div class="div_table" style="display:table">KEY       a key/value row
 *         <div style="display:table-cell"><div>VALUE</div></div>
 *
 * VALUE is text lines, media tags and/or further key/value rows, nested to
 * any depth.  Rows that repeat form a list of records.
 *
 * ── Output ─────────────────────────────────────────────────────────────
 *   parsePage(html) -> { title, service, categories: [Category] }
 *   Category = { id, name, def: [lines], notes: [lines], v: Value }
 *   Value    = { t?: [lines], m?: [Media], r?: [Record] }   (empty keys omitted)
 *   Record   = [Field]
 *   Field    = { k: 'Key', v: Value }
 *   Media    = { k: 'image'|'video'|'audio'|'file', s: 'linked_media/x.jpg' }
 *
 * ── Record splitting (the part the markup does not state) ──────────────
 *   1. A <br> (or an empty <div>) between rows ends a record  - Facebook.
 *   2. A plain <div> that wraps two or more rows is one record.
 *   3. With neither, a key that repeats inside the current record starts a
 *      new one (IP Address, Time, IP Address, Time -> two records).
 * Rule 1 wins whenever the container has a separator between rows, so a
 * Facebook record that legitimately repeats a key is never cut in two.
 */

'use strict';

const { parse } = require('node-html-parser');

const BLOCK_TAGS = new Set([
    'div', 'p', 'li', 'ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th',
    'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'pre', 'blockquote', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'hr'
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'input', 'button', 'label', 'select', 'option', 'textarea']);
const MEDIA_TAGS = { img: 'image', video: 'video', audio: 'audio' };

function styleOf(el) {
    const s = el.getAttribute && el.getAttribute('style');
    return s ? String(s).toLowerCase().replace(/\s+/g, '') : '';
}
function tagOf(el) { return String(el.rawTagName || el.tagName || '').toLowerCase(); }
function hasClass(el, c) {
    const v = el.getAttribute && el.getAttribute('class');
    return !!v && (' ' + String(v).replace(/\s+/g, ' ') + ' ').indexOf(' ' + c + ' ') >= 0;
}
// Class names the page's own <style> block lays out as a table row / cell.
// Set by parsePage for the duration of one (synchronous) parse.  Lets a
// layout that moved `display:table` from inline styles into CSS classes
// (Scout submission #31: records.html + preservation-1.html not recognised)
// parse exactly like the inline one.
let CSS = { row: new Set(), cell: new Set() };

function classesOf(el) {
    const v = el.getAttribute && el.getAttribute('class');
    return v ? String(v).trim().split(/\s+/) : [];
}
function hasCssClass(el, set) {
    if (!set.size) return false;
    for (const c of classesOf(el)) if (set.has(c)) return true;
    return false;
}

/**
 * Classes a stylesheet displays as table / table-row (rows) or table-cell (cells).
 * Only the LAST compound of each selector counts (`.wrap .kv` -> kv).
 */
function cssTableClasses(cssText) {
    const out = { row: new Set(), cell: new Set() };
    const css = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const decl = m[2].toLowerCase().replace(/\s+/g, '');
        let kind = null;
        if (/(^|;)display:table-cell(;|!|$)/.test(decl)) kind = 'cell';
        else if (/(^|;)display:table(-row)?(;|!|$)/.test(decl)) kind = 'row';
        if (!kind) continue;
        for (const sel of m[1].split(',')) {
            const last = sel.trim().split(/[\s>+~]+/).pop() || '';
            if (/:/.test(last)) continue;   // :hover, ::before … are not the element itself
            const cm = last.match(/\.([A-Za-z_-][\w-]*)/g);
            if (cm) for (const c of cm) out[kind].add(c.slice(1));
        }
    }
    // A class that is both (unlikely) is treated as a cell, never a row.
    for (const c of out.cell) out.row.delete(c);
    return out;
}

function isCell(el) {
    return el.nodeType === 1 && (/display:table-cell/.test(styleOf(el)) || hasCssClass(el, CSS.cell));
}
/** A key/value row: display:table (not -cell / -row), or a div_table that directly holds a cell. */
function isRow(el) {
    if (el.nodeType !== 1) return false;
    const s = styleOf(el);
    if (/display:table(;|$|!)/.test(s)) return true;
    if (hasCssClass(el, CSS.row) && !isCell(el)) return el.childNodes.some(isCell);
    if (hasClass(el, 'div_table')) return el.childNodes.some(isCell);
    return false;
}
function cleanText(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

/**
 * Walk a container's children into a flat part stream:
 *   {p:'text', s}  {p:'br'}  {p:'media', k, s}  {p:'row', f: Field}  {p:'group', v: Value}
 */
function collectParts(el, out, depth) {
    if (depth > 200) return;   // pathological nesting guard
    for (const c of el.childNodes) {
        if (c.nodeType === 3) {
            const t = cleanText(c.text);
            if (t) out.push({ p: 'text', s: t });
            continue;
        }
        if (c.nodeType !== 1) continue;
        const tag = tagOf(c);
        if (SKIP_TAGS.has(tag)) continue;
        if (tag === 'br' || tag === 'hr') { out.push({ p: 'br' }); continue; }
        if (MEDIA_TAGS[tag]) {
            const src = c.getAttribute('src');
            if (src) out.push({ p: 'media', k: MEDIA_TAGS[tag], s: String(src).trim() });
            for (const s of c.querySelectorAll('source')) {
                const ss = s.getAttribute('src');
                if (ss) out.push({ p: 'media', k: MEDIA_TAGS[tag], s: String(ss).trim() });
            }
            continue;
        }
        if (tag === 'source') {
            const ss = c.getAttribute('src');
            if (ss) out.push({ p: 'media', k: 'file', s: String(ss).trim() });
            continue;
        }
        if (tag === 'a') {
            const href = c.getAttribute('href') || '';
            if (/^(\.\/)?linked_media\//i.test(href)) out.push({ p: 'media', k: 'file', s: href.trim() });
            const t = cleanText(c.text);
            if (t) out.push({ p: 'text', s: t, inline: true });
            continue;
        }
        if (isRow(c)) { out.push({ p: 'row', f: parseRow(c, depth + 1) }); continue; }
        if (BLOCK_TAGS.has(tag)) {
            const inner = [];
            collectParts(c, inner, depth + 1);
            const rows = inner.filter(x => x.p === 'row' || x.p === 'group').length;
            if (!inner.length) {
                if (tag === 'div' || tag === 'p') out.push({ p: 'br' });   // empty block = separator
                continue;
            }
            if (rows >= 2 && tag === 'div' && !hasClass(c, 'div_table') && !hasCssClass(c, CSS.row)) {
                out.push({ p: 'group', v: buildValue(inner) });
                continue;
            }
            // Transparent: a block boundary is a line break for text.
            out.push({ p: 'brk' });
            for (const x of inner) out.push(x);
            out.push({ p: 'brk' });
            continue;
        }
        // Inline element (span, u, i, b, font, ...): text joins the current line.
        const inner = [];
        collectParts(c, inner, depth + 1);
        for (const x of inner) out.push(x.p === 'text' ? { p: 'text', s: x.s, inline: true } : x);
    }
}

function parseRow(el, depth) {
    let keyBits = [];
    let cell = null;
    const cells = [];
    for (const c of el.childNodes) {
        if (c.nodeType === 3) { const t = cleanText(c.text); if (t) keyBits.push(t); continue; }
        if (c.nodeType !== 1) continue;
        if (isCell(c)) { if (!cell) cell = c; cells.push(c); continue; }
        const tag = tagOf(c);
        if (SKIP_TAGS.has(tag) || tag === 'br') continue;
        if (!cell) { const t = cleanText(c.text); if (t) keyBits.push(t); }
    }
    // Two-cell row (key cell + value cell) with no key text in front:
    // the first cell is the key, the rest is the value.
    if (!keyBits.length && cells.length >= 2) {
        const kp = [];
        collectParts(cells[0], kp, depth + 1);
        const key = kp.filter(x => x.p === 'text').map(x => x.s).join(' ');
        if (key && !kp.some(x => x.p === 'row' || x.p === 'group' || x.p === 'media')) {
            const parts = [];
            for (let i = 1; i < cells.length; i++) {
                if (i > 1) parts.push({ p: 'brk' });
                collectParts(cells[i], parts, depth + 1);
            }
            return { k: key, v: buildValue(parts) };
        }
    }
    const parts = [];
    if (cell) collectParts(cell, parts, depth + 1);
    return { k: keyBits.join(' '), v: buildValue(parts) };
}

/** Turn a part stream into a Value: text lines, media, records. */
function buildValue(parts) {
    // A wrapper that holds nothing but one group IS that group (the <div>
    // directly inside a table-cell wraps the whole value).
    const meaningful = parts.filter(x => x.p !== 'br' && x.p !== 'brk');
    if (meaningful.length === 1 && meaningful[0].p === 'group') return meaningful[0].v;

    const lines = [];
    let cur = null;
    const media = [];
    const seen = new Set();
    const recordsRaw = [];   // stream of rows / groups / separators (text excluded)
    for (const x of parts) {
        if (x.p === 'text') {
            // Text runs until a line break, exactly as a browser lays it out.
            cur = cur === null ? x.s : cur + ' ' + x.s;
            continue;
        }
        if (x.p === 'br' || x.p === 'brk') {
            if (cur !== null) { lines.push(cur); cur = null; }
            if (x.p === 'br') recordsRaw.push(x);
            continue;
        }
        if (cur !== null) { lines.push(cur); cur = null; }
        if (x.p === 'media') {
            if (!seen.has(x.s)) { seen.add(x.s); media.push({ k: x.k, s: x.s }); }
            continue;
        }
        recordsRaw.push(x);   // row | group
    }
    if (cur !== null) lines.push(cur);

    const v = {};
    if (lines.length) v.t = lines;
    if (media.length) v.m = media;
    const r = splitRecords(recordsRaw);
    if (r.length) v.r = r;
    return v;
}

function splitRecords(raw) {
    // Does a separator sit BETWEEN two rows?  (Leading/trailing <br> do not count.)
    let sepMode = false;
    let sawRow = false, pendingSep = false;
    for (const x of raw) {
        if (x.p === 'row') { if (sawRow && pendingSep) { sepMode = true; break; } sawRow = true; pendingSep = false; }
        else if (x.p === 'br') { if (sawRow) pendingSep = true; }
        else if (x.p === 'group') { sawRow = false; pendingSep = false; }
    }
    const out = [];
    let cur = [];
    let keys = new Set();
    let run = [];   // consecutive rows (no separator mode): split once the run ends
    const flushRun = () => {
        if (!run.length) return;
        // If the run's first key comes back, records START with it: split
        // only there, so a record that repeats some other key (two images,
        // two "Linked Media File:" rows) stays whole.  Otherwise split at
        // any repeated key.
        const first = run[0].k;
        const firstRepeats = run.some((f, i) => i > 0 && f.k === first);
        let rec = [];
        let seen = new Set();
        for (const f of run) {
            const cut = firstRepeats ? (f.k === first && rec.length > 0) : seen.has(f.k);
            if (cut) { out.push(rec); rec = []; seen = new Set(); }
            rec.push(f);
            seen.add(f.k);
        }
        if (rec.length) out.push(rec);
        run = [];
    };
    const close = () => { if (cur.length) out.push(cur); cur = []; keys = new Set(); };
    for (const x of raw) {
        if (x.p === 'br') { if (sepMode) close(); continue; }
        if (x.p === 'group') {
            close();
            flushRun();
            const g = x.v;
            const recs = (g.r || []).map(rec => rec.slice());
            // Loose text / media inside a group belong to it: keep them as an untitled field.
            if ((g.t && g.t.length) || (g.m && g.m.length)) {
                const extra = { k: '', v: {} };
                if (g.t) extra.v.t = g.t;
                if (g.m) extra.v.m = g.m;
                if (recs.length) recs[0].unshift(extra); else recs.push([extra]);
            }
            for (const rec of recs) out.push(rec);
            continue;
        }
        if (!sepMode) { run.push(x.f); continue; }
        cur.push(x.f);
        keys.add(x.f.k);
    }
    close();
    flushRun();
    return out;
}

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function titleCaseId(id) {
    return String(id || '').split(/[_\s]+/).filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Every element whose id passes `test`, not nested in another match. */
function findCategoryPanes(root, test) {
    test = test || ((id) => /^property-/i.test(id));
    const out = [];
    const walk = (el, depth) => {
        if (depth > 200) return;
        for (const c of (el.childNodes || [])) {
            if (c.nodeType !== 1) continue;
            const id = c.getAttribute && c.getAttribute('id');
            if (id && test(id)) { out.push(c); continue; }
            walk(c, depth + 1);
        }
    };
    walk(root, 0);
    return out;
}

/** Does this element hold at least one key/value row? */
function hasRow(el) {
    let found = false;
    const walk = (n, depth) => {
        if (found || depth > 60) return;
        for (const c of (n.childNodes || [])) {
            if (c.nodeType !== 1) continue;
            if (isRow(c)) { found = true; return; }
            walk(c, depth + 1);
            if (found) return;
        }
    };
    walk(el, 0);
    return found;
}

function parseCategory(pane, nameMap, forced) {
    const id = forced ? forced.id : String(pane.getAttribute('id')).replace(/^property-/i, '');
    const name = (forced && forced.name) || (nameMap && nameMap[id]) || titleCaseId(id);
    const parts = [];
    collectParts(pane, parts, 0);
    const whole = buildValue(parts);
    const def = [];
    const notes = [];
    const data = [];      // surviving fields, flat (for the single-row unwrap test)
    const recs = [];      // surviving records — the record boundaries are kept
    for (const rec of (whole.r || [])) {
        const kept = [];
        for (const f of rec) {
            if (/\bdefinitions?$/i.test(f.k)) { for (const l of (f.v.t || [])) def.push(l); continue; }
            if (!f.k && !f.v.r && !f.v.m && f.v.t) { for (const l of f.v.t) notes.push(l); continue; }
            kept.push(f);
            data.push(f);
        }
        if (kept.length) recs.push(kept);
    }
    let v;
    if (data.length === 1 && (normName(data[0].k) === normName(name) || normName(data[0].k) === normName(id))) {
        v = data[0].v;
    } else {
        v = {};
        if (recs.length) v.r = recs;
    }
    if (whole.t && whole.t.length) v.t = (v.t || []).concat(whole.t);
    if (whole.m && whole.m.length) v.m = (v.m || []).concat(whole.m);
    return { id, name, def, notes, v };
}

/**
 * @param {string} html
 * @param {{ onlyIds?: string[], textFallback?: boolean }} [opts]
 *   textFallback: when no key/value rows are found at all, keep the page's
 *   text (per TOC-linked section, else the whole body) instead of returning
 *   no categories.  The importer turns it on only for files carrying Meta's
 *   own page names, so an unknown future layout still shows its content.
 */
function parsePage(html, opts) {
    const src = String(html || '');
    let cssText = '';
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRe.exec(src)) && cssText.length < 2000000) cssText += sm[1] + '\n';
    const prevCss = CSS;
    CSS = cssTableClasses(cssText);
    try {
        return parsePageInner(src, opts);
    } finally {
        CSS = prevCss;
    }
}

function parsePageInner(html, opts) {
    const root = parse(html, {
        lowerCaseTagName: false,
        comment: false,
        blockTextElements: { script: false, noscript: false, style: false, pre: true }
    });
    const titleEl = root.querySelector('title');
    const title = titleEl ? cleanText(titleEl.text) : '';
    const service = /instagram/i.test(title) ? 'Instagram'
        : /whatsapp/i.test(title) ? 'WhatsApp'
        : /threads/i.test(title) ? 'Threads'
        : /facebook/i.test(title) ? 'Facebook' : (title ? 'Meta' : '');

    // Category display names from the sidebar table of contents.
    const nameMap = {};
    const hrefNames = {};   // any in-page "#id" link -> its text (fallback layout)
    for (const a of root.querySelectorAll('a')) {
        const prop = a.getAttribute('property');
        const href = a.getAttribute('href') || '';
        const id = prop || (/^#property-/i.test(href) ? href.replace(/^#property-/i, '') : '');
        if (id && !nameMap[id]) { const t = cleanText(a.text); if (t) nameMap[id] = t; }
        if (/^#./.test(href)) { const hid = href.slice(1); if (!hrefNames[hid]) { const t = cleanText(a.text); if (t) hrefNames[hid] = t; } }
    }
    const order = Object.keys(nameMap);
    const only = opts && Array.isArray(opts.onlyIds) ? new Set(opts.onlyIds) : null;
    const categories = [];
    let layout = 'property';
    let panes = findCategoryPanes(root);
    if (!panes.length) {
        // A future layout without "property-" ids: any element the table of
        // contents links to that holds key/value rows is a category.
        const ids = new Set(Object.keys(hrefNames));
        panes = ids.size ? findCategoryPanes(root, (id) => ids.has(id)).filter(hasRow) : [];
        layout = panes.length ? 'toc' : 'none';
    }
    for (const pane of panes) {
        let forced = null;
        if (layout === 'toc') {
            const rawId = String(pane.getAttribute('id'));
            forced = { id: rawId.replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase(), name: hrefNames[rawId] };
        }
        const id = forced ? forced.id : String(pane.getAttribute('id')).replace(/^property-/i, '');
        if (only && !only.has(id)) continue;
        categories.push(parseCategory(pane, nameMap, forced));
    }
    if (!panes.length) {
        // Last resort: no recognisable sections at all.  Keep every row the
        // page has as one category so nothing is silently dropped.
        const body = root.querySelector('body') || root;
        if (hasRow(body)) {
            layout = 'page';
            categories.push(parseCategory(body, null, { id: 'page_records', name: 'Page Records' }));
        }
    }
    if (!categories.length && opts && opts.textFallback && !only) {
        // No rows anywhere: keep the text so the investigator still sees it.
        const ids = new Set(Object.keys(hrefNames));
        const secs = ids.size ? findCategoryPanes(root, (id) => ids.has(id)) : [];
        for (const sec of secs) {
            const rawId = String(sec.getAttribute('id'));
            const cat = parseCategory(sec, null, { id: rawId.replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase(), name: hrefNames[rawId] });
            if ((cat.v.t && cat.v.t.length) || (cat.v.m && cat.v.m.length)) categories.push(cat);
        }
        if (categories.length) layout = 'toc-text';
        else {
            const body = root.querySelector('body') || root;
            const cat = parseCategory(body, null, { id: 'page_text', name: 'Page Text' });
            if ((cat.v.t && cat.v.t.length) || (cat.v.m && cat.v.m.length)) { layout = 'page-text'; categories.push(cat); }
        }
    }
    const page = { title, service, categories, layout, toc: order.map(id => ({ id, name: nameMap[id] })) };
    // Detach: the parser's strings are V8 slices of the whole page source,
    // so keeping even one small value (a request parameter, a record) would
    // pin the entire 14 MB page in memory for the rest of the import.  A JSON
    // round trip gives every string its own storage (~30 MB retained per
    // preservation page otherwise; measured).
    return JSON.parse(JSON.stringify(page));
}

/** Cheap check used by detection and Scout: does this text look like a Meta return page? */
function looksLikeMetaPage(head) {
    const s = String(head || '');
    const brand = /(instagram|facebook|meta platforms|whatsapp)/i;
    if (/(Facebook|Instagram|Meta|WhatsApp|Threads) Legal Request/i.test(s)) return true;
    if (/id=["']?property-/i.test(s) && /div_table/i.test(s)) return true;
    if (/div_table/i.test(s) && /display:\s*table/i.test(s) && brand.test(s)) return true;
    // Meta's page template (sidebar TOC, print checkboxes, content panes)
    // with the table layout moved into CSS classes.
    const template = /printOptionChange|class=["'][^"']*\b(content-pane|records_output|sticky_side_bar)\b|<a[^>]+\bproperty=["']|href=["']#property-/i;
    if (template.test(s) && brand.test(s)) return true;
    if (/Request Parameters/i.test(s) && brand.test(s) && /display:\s*table/i.test(s)) return true;
    return false;
}

module.exports = {
    parsePage,
    looksLikeMetaPage,
    // exposed for tests
    _internal: { buildValue, splitRecords, collectParts, parseRow, isRow, isCell, cleanText, titleCaseId, normName, cssTableClasses }
};
