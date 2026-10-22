/**
 * Warrant tabs — search boxes keep focus while typing, and video tiles get
 * first-frame thumbnails (Snapchat / X / KIK / Google / Meta / DataPilot).
 *
 * Covers modules/_shared/keep-focus.js, modules/_shared/video-thumbs.js,
 * electron-main.js `_warrantMediaCheckPath` (warrant-media-url IPC) and the
 * per-tab wiring, lifted from the shipping source.
 * Run: node modules/_shared/__tests__/warrant-media-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const KF = require('../keep-focus.js');
const VT = require('../video-thumbs.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL ' + msg); } }
const tick = (ms) => new Promise(r => setTimeout(r, ms || 2));
async function until(cond, max) { for (let i = 0; i < (max || 300) && !cond(); i++) await tick(2); }

// ── tiny fake DOM ───────────────────────────────────────────────────
function parseSel(sel) {
    if (sel[0] === '#') return { id: sel.slice(1) };
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(sel);
    if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
    const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
    const attrs = [];
    m[3].replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, n, v) => { attrs.push([n, v]); return ''; });
    return { tag: m[1].toUpperCase(), classes, attrs };
}
class El {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.dataset = {};
        this.style = {};
        this.value = '';
        this.selectionStart = null; this.selectionEnd = null; this.selectionDirection = 'none';
        const self = this;
        this.classList = {
            add(c) { const s = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean)); s.add(c); self.attrs.class = [...s].join(' '); },
            remove(c) { self.attrs.class = (self.attrs.class || '').split(/\s+/).filter(x => x && x !== c).join(' '); },
            contains(c) { return (self.attrs.class || '').split(/\s+/).includes(c); }
        };
    }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n._root === true || n === this.ownerDocument.body; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
        if (c.parentNode) c.remove();
        const i = ref ? this.children.indexOf(ref) : -1;
        c.parentNode = this;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    remove() { if (!this.parentNode) return; const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    matches(sel) {
        const p = parseSel(sel);
        if (p.id) return this.id === p.id;
        if (p.tag && p.tag !== this.tagName) return false;
        for (const c of p.classes) if (!this.classList.contains(c)) return false;
        for (const [n, v] of p.attrs) { const a = this.getAttribute(n); if (a == null || (v !== undefined && a !== v)) return false; }
        return true;
    }
    querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    focus() { this.ownerDocument.activeElement = this; }
    setSelectionRange(s, e, d) { this.selectionStart = s; this.selectionEnd = e; this.selectionDirection = d || 'none'; }
    // Re-render: the old children (and the focused <input>) are destroyed,
    // new <input>s are created from the markup — exactly what breaks typing.
    set innerHTML(html) {
        const doc = this.ownerDocument;
        if (doc.activeElement && doc.activeElement !== this && this.contains(doc.activeElement)) doc.activeElement = doc.body;
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        String(html).replace(/<input\b([^>]*)>/g, (_, a) => {
            const el = new El('input', doc);
            a.replace(/([\w-]+)="([^"]*)"/g, (__, n, v) => { if (n === 'value') el.value = v; else el.setAttribute(n, v); return ''; });
            this.appendChild(el);
            return '';
        });
        this._html = html;
    }
    get innerHTML() { return this._html || ''; }
}
class Doc {
    constructor() {
        this.body = new El('body', this);
        this.head = new El('head', this);
        this.activeElement = this.body;
        this.defaultView = { getComputedStyle: (el) => ({ position: el.style.position || 'static' }) };
    }
    createElement(t) { return new El(t, this); }
    getElementById(id) {
        const walk = (n) => { for (const c of n.children) { if (c.id === id) return c; const r = walk(c); if (r) return r; } return null; };
        return walk(this.body);
    }
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

// ── source lifting ──────────────────────────────────────────────────
function braceEnd(src, i) {
    let depth = 1;
    while (depth && i < src.length) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    if (depth) throw new Error('unbalanced braces');
    return i;
}
function liftMethod(src, name) {
    const m = new RegExp('\\n    (async )?' + name + '\\(([^)]*)\\)\\s*\\{').exec(src);
    if (!m) throw new Error('method not found: ' + name);
    const start = m.index + m[0].length;
    return (m[1] || '') + 'function ' + name + '(' + m[2] + ') {' + src.slice(start, braceEnd(src, start));
}
function bindMethod(src, name, doc, win) {
    // eslint-disable-next-line no-new-func
    return new Function('document', 'window', 'return ' + liftMethod(src, name))(doc, win);
}

const SRC = {
    snapUi: read('modules/snapchat-warrant/snapchat-warrant-ui.js'),
    snapMod: read('modules/snapchat-warrant/snapchat-warrant-module.js'),
    xUi: read('modules/x-warrant/x-warrant-ui.js'),
    xMod: read('modules/x-warrant/x-warrant-module.js'),
    kikUi: read('modules/kik-warrant/kik-warrant-ui.js'),
    kikMod: read('modules/kik-warrant/kik-warrant-module.js'),
    googleUi: read('modules/google-warrant/google-warrant-ui.js'),
    metaUi: read('modules/meta-warrant/meta-warrant-ui.js'),
    dpUi: read('modules/datapilot/datapilot-ui.js'),
    main: read('electron-main.js'),
    preload: read('preload.js'),
    caseDetail: read('case-detail-with-analytics.html'),
};

(async () => {
try {
    // ── 1. VpKeepFocus ──
    {
        const doc = new Doc();
        const box = doc.body.appendChild(new El('div', doc));
        box.innerHTML = '<input id="q" value="hello">';
        const inp = doc.getElementById('q');
        inp.focus(); inp.setSelectionRange(3, 4, 'forward');
        const snap = KF.capture(box, doc);
        ok(snap && snap.id === 'q' && snap.s === 3 && snap.e === 4 && snap.dir === 'forward', 'capture records id + selection');
        box.innerHTML = '<input id="q" value="hel">';
        ok(doc.activeElement === doc.body, 'fake DOM: innerHTML swap drops focus (the bug)');
        ok(KF.restore(box, snap, doc) === true, 'restore returns true');
        const n = doc.getElementById('q');
        ok(doc.activeElement === n && n !== inp, 'restore focuses the NEW input');
        ok(n.selectionStart === 3 && n.selectionEnd === 3, 'selection clamped to the new value length');

        // data-focus-key path
        box.innerHTML = '<input data-focus-key="k1" value="ab">';
        box.children[0].focus(); box.children[0].setSelectionRange(1, 1);
        const s2 = KF.capture(box, doc);
        box.innerHTML = '<input data-focus-key="k1" value="ab">';
        KF.restore(box, s2, doc);
        ok(doc.activeElement === box.children[0] && box.children[0].selectionStart === 1, 'data-focus-key restore');

        // no id / outside container / not an input → nothing tracked
        box.innerHTML = '<input value="x">';
        box.children[0].focus();
        ok(KF.capture(box, doc) === null, 'input without id/key is not tracked');
        const other = doc.body.appendChild(new El('div', doc));
        other.innerHTML = '<input id="o" value="">';
        doc.getElementById('o').focus();
        ok(KF.capture(box, doc) === null, 'focus outside the container is not tracked');
        const btn = box.appendChild(new El('button', doc)); btn.id = 'b'; btn.focus();
        ok(KF.capture(box, doc) === null, 'non-text element not tracked');
        ok(KF.restore(box, null, doc) === false, 'restore(null) is a no-op');
        // around()
        box.innerHTML = '<input id="a1" value="abc">';
        doc.getElementById('a1').focus(); doc.getElementById('a1').setSelectionRange(2, 2);
        const r = KF.around(box, () => { box.innerHTML = '<input id="a1" value="abcd">'; return 7; }, doc);
        ok(r === 7 && doc.activeElement === doc.getElementById('a1') && doc.activeElement.selectionStart === 2, 'around() keeps focus and returns fn result');
    }

    // ── 2. Per-tab re-render keeps the search box focused (lifted code) ──
    const typingCase = (label, src, method, containerId, inputId, ctxFor) => {
        const doc = new Doc();
        const win = { VpKeepFocus: KF };
        const content = doc.body.appendChild(new El('div', doc));
        content.id = containerId;
        const html = (v) => `<div><input type="text" id="${inputId}" value="${v}"></div>`;
        content.innerHTML = html('ab');
        const inp = doc.getElementById(inputId);
        inp.focus(); inp.setSelectionRange(2, 2);
        const fn = bindMethod(src, method, doc, win);
        const ctx = ctxFor(html('abc'));
        fn.call(ctx, ...(ctx.__args ? ctx.__args(content) : []));
        const now = doc.getElementById(inputId);
        ok(now && now !== inp, label + ': section was re-rendered');
        ok(doc.activeElement === now, label + ': search box still focused after a keystroke');
        ok(now && now.selectionStart === 2, label + ': caret position kept');
    };
    typingCase('Snapchat Conversations search', SRC.snapUi, 'rerenderSection', 'swp-content-area', 'swp-conv-filter',
        (h) => ({ _renderSection: () => h, _loadLazyImages() {}, activeSection: 'conversations', _initGeoMap() {} }));
    typingCase('X Conversations search', SRC.xUi, 'rerenderSection', 'xwp-content-area', 'xwp-conv-filter',
        (h) => ({ _renderSection: () => h, _loadLazyImages() {} }));
    typingCase('X Tweets search', SRC.xUi, 'rerenderSection', 'xwp-content-area', 'xwp-tweet-filter',
        (h) => ({ _renderSection: () => h, _loadLazyImages() {} }));
    typingCase('KIK Media search', SRC.kikUi, '_renderSection', 'kkp-content', 'kkp-media-search',
        (h) => ({ _renderSectionHtml(c) { c.innerHTML = h; }, _hydrateVideoThumbs() {} }));
    typingCase('Google Email search', SRC.googleUi, '_refreshContent', 'gwp-content-area', 'gwp-email-q',
        (h) => ({ _renderSection: () => h, _afterSectionRender() {} }));
    for (const id of ['dp-subject-contact-search', 'dp-comms-search', 'dp-art-search']) {
        typingCase('DataPilot ' + id, SRC.dpUi, 'render', 'dp-root', id, (h) => ({
            module: { getActiveImport: () => ({ id: 'imp1' }) }, _lastImportId: 'imp1',
            _renderHeader: () => '', _renderViewSwitcher: () => '', _renderViewContent: () => h,
            _wireHeader() {}, _wireViewSwitcher() {}, _wireView() {},
            __args: (c) => [c],
        }));
    }

    // ── 3. Static wiring ──
    {
        ok(/id="swp-conv-filter"/.test(SRC.snapUi), 'Snapchat conv filter has an id');
        ok(/id="xwp-conv-filter"/.test(SRC.xUi) && /id="xwp-tweet-filter"/.test(SRC.xUi), 'X filters have ids');
        ok(/id="kkp-media-search" value="\$\{this\._esc\(this\._mediaFilter\)\}"/.test(SRC.kikUi), 'KIK media search value is escaped');
        ok(!/wasFocused/.test(SRC.dpUi), 'DataPilot dead refocus code removed');
        const cb = SRC.caseDetail.indexOf('modules/_shared/case-blobs.js');
        const kf = SRC.caseDetail.indexOf('<script src="modules/_shared/keep-focus.js"></script>');
        const vt = SRC.caseDetail.indexOf('<script src="modules/_shared/video-thumbs.js"></script>');
        const firstTab = SRC.caseDetail.indexOf('modules/snapchat-warrant/');
        ok(cb >= 0 && kf > cb && vt > kf, 'case-detail loads keep-focus + video-thumbs after case-blobs');
        ok(firstTab < 0 || vt < firstTab, 'shared scripts load before the warrant tabs');
        ok(/warrantMediaUrl: \(data\) => ipcRenderer\.invoke\('warrant-media-url', data\)/.test(SRC.preload), 'preload exposes warrantMediaUrl');
        ok(/ipcMain\.handle\('warrant-media-url'/.test(SRC.main), 'main registers warrant-media-url');
        ok(/class="swp-media-video-thumb"\$\{m\.diskPath \? ` data-vpt-src="\$\{this\._esc\(m\.diskPath\)\}"` : ''\}/.test(SRC.snapUi), 'Snapchat video tile opts into thumbnails');
        ok(/swp-media-placeholder vpt-hide/.test(SRC.snapUi), 'Snapchat placeholder hides once a frame exists');
        ok(/class="xwp-media-video-thumb" data-vpt-src=/.test(SRC.xUi) && /xwp-media-placeholder vpt-hide/.test(SRC.xUi), 'X video tile opts into thumbnails');
        ok(/_hydrateVideoThumbs\(content\)/.test(liftMethod(SRC.kikUi, '_renderSection')), 'KIK hydrates after each section render');
        // Snapchat lazy video player prefers the streamed URL over base64
        const lazy = liftMethod(SRC.snapUi, '_loadLazyImages');
        ok(lazy.indexOf('_hydrateVideoThumbs(') >= 0, 'Snapchat lazy loader hydrates video tiles');
        ok(/mediaUrl\(/.test(lazy), 'Snapchat lazy video uses mediaUrl first');
        ok(/async playVideo\(tile\)/.test(SRC.xUi) && /mediaUrl\(/.test(liftMethod(SRC.xUi, 'playVideo')), 'X playVideo uses streamed URL');
        ok(/mediaUrl\(/.test(liftMethod(SRC.kikUi, 'loadMediaThumb')), 'KIK video playback uses streamed URL');
    }

    // ── 4. module.mediaUrl (Snapchat / X / KIK) ──
    for (const [label, src] of [['Snapchat', SRC.snapMod], ['X', SRC.xMod], ['KIK', SRC.kikMod]]) {
        const calls = [];
        let reply = { success: true, fileUrl: 'viper-media://m/tok' };
        const win = { electronAPI: { warrantMediaUrl: async (d) => { calls.push(d); return reply; } } };
        const fn = bindMethod(src, 'mediaUrl', null, win);
        ok(await fn.call({}, 'C:\\c\\1\\Evidence\\X\\v.mp4') === 'viper-media://m/tok', label + ' mediaUrl returns streamed URL');
        ok(calls.length === 1 && calls[0].filePath === 'C:\\c\\1\\Evidence\\X\\v.mp4', label + ' mediaUrl sends filePath');
        reply = { success: false };
        ok(await fn.call({}, 'a') === null, label + ' mediaUrl null on failure');
        ok(await fn.call({}, '') === null && calls.length === 2, label + ' mediaUrl skips empty path');
        const fn2 = bindMethod(src, 'mediaUrl', null, {});
        ok(await fn2.call({}, 'a') === null, label + ' mediaUrl null without API (stale preload)');
    }

    // ── 5. VpVideoThumbs.hydrate ──
    const mkRoot = (doc, keys) => {
        const r = new El('div', doc); r._root = true;
        const tiles = keys.map(k => { const t = r.appendChild(new El('div', doc)); t.setAttribute('data-vpt-src', k); return t; });
        return { r, tiles };
    };
    {
        // cached tiles applied at once, getUrl not called
        VT._resetForTests();
        const doc = new Doc();
        const cache = new Map([['a', 'data:A'], ['bad', '']]);
        const { r, tiles } = mkRoot(doc, ['a', 'bad']);
        const applied = []; let urls = 0;
        const n = VT.hydrate(r, { cache, getUrl: async () => { urls++; return 'u'; }, apply: (el, d) => applied.push([el, d]), capture: async () => 'x' });
        ok(n === 0 && urls === 0, 'cached tiles are not re-decoded');
        ok(applied.length === 1 && applied[0][0] === tiles[0] && applied[0][1] === 'data:A', 'cached thumbnail applied; cached failure not');
        ok(tiles[1].getAttribute('data-vpt-done') === '1', 'cached failure marked done');
    }
    {
        // global decode cap across separate hydrate() calls (Meta hydrates per slot)
        VT._resetForTests();
        const doc = new Doc();
        let active = 0, max = 0;
        const applied = [];
        const capture = async (url) => { active++; max = Math.max(max, active); await tick(8); active--; return 'data:' + url; };
        for (let i = 0; i < 3; i++) {
            const { r } = mkRoot(doc, ['k' + i + 'a', 'k' + i + 'b']);
            VT.hydrate(r, { cache: new Map(), concurrency: 2, getUrl: async (k) => 'url-' + k, apply: (el, d) => applied.push(d), capture });
        }
        await until(() => applied.length === 6);
        ok(applied.length === 6, 'all six tiles decoded');
        ok(max === 2, 'at most two video decodes at once across calls (got ' + max + ')');
    }
    {
        // failures cached; null URL not cached; done tiles skipped on re-hydrate
        VT._resetForTests();
        const doc = new Doc();
        const cache = new Map();
        let urlCalls = 0, capCalls = 0;
        const opts = { cache, getUrl: async () => { urlCalls++; return 'u'; }, capture: async () => { capCalls++; return null; }, apply: () => {} };
        const a = mkRoot(doc, ['hevc']);
        VT.hydrate(a.r, opts);
        await until(() => cache.has('hevc'));
        ok(cache.get('hevc') === '', 'undecodable video cached as failure');
        VT.hydrate(a.r, opts);
        const b = mkRoot(doc, ['hevc']);
        VT.hydrate(b.r, opts);
        await tick(10);
        ok(urlCalls === 1 && capCalls === 1, 'failure not retried (same root re-hydrate or new tile)');

        let nullCalls = 0;
        const c = mkRoot(doc, ['nourl']);
        const o2 = { cache, getUrl: async () => { nullCalls++; return null; }, capture: async () => 'x', apply: () => {} };
        VT.hydrate(c.r, o2);
        await tick(10);
        ok(!cache.has('nourl'), 'missing URL (e.g. stale main process) is not cached');
        const d = mkRoot(doc, ['nourl']);
        VT.hydrate(d.r, o2);
        await tick(10);
        ok(nullCalls === 2, 'missing URL retried on a later render');
    }
    {
        // in-flight de-duplication: same file shown twice → one decode, both tiles filled
        VT._resetForTests();
        const doc = new Doc();
        let caps = 0;
        const got = [];
        const { r, tiles } = mkRoot(doc, ['same', 'same']);
        VT.hydrate(r, { cache: new Map(), getUrl: async () => 'u', capture: async () => { caps++; await tick(5); return 'data:S'; }, apply: (el, dd) => got.push(el) });
        await until(() => got.length === 2);
        ok(caps === 1, 'same key decoded once');
        ok(got.includes(tiles[0]) && got.includes(tiles[1]), 'both tiles get the thumbnail');
    }
    {
        // removed tiles are not applied
        VT._resetForTests();
        const doc = new Doc();
        const got = [];
        const { r, tiles } = mkRoot(doc, ['gone']);
        VT.hydrate(r, { cache: new Map(), getUrl: async () => { tiles[0].remove(); return 'u'; }, capture: async () => 'data:G', apply: (el) => got.push(el) });
        await tick(10);
        ok(got.length === 0, 'tile removed mid-decode is left alone');
        ok(VT.hydrate({}, { getUrl: () => {} }) === 0 && VT.hydrate(r, {}) === 0, 'bad arguments → 0');
    }
    {
        // defaultApply: frame UNDER the play icon, placeholder hidden by class
        VT._resetForTests();
        const doc = new Doc();
        const tile = doc.body.appendChild(new El('div', doc));
        const icon = tile.appendChild(new El('span', doc));
        VT.defaultApply(tile, 'data:image/jpeg;base64,AAA');
        const img = tile.children[0];
        ok(img.tagName === 'IMG' && img.classList.contains('vpt-img') && img.src === 'data:image/jpeg;base64,AAA', 'img.vpt-img inserted first');
        ok(tile.children[1] === icon, 'existing children (play icon) kept after the image');
        ok(tile.classList.contains('vpt-has-thumb') && tile.style.position === 'relative', 'tile marked + positioned');
        VT.defaultApply(tile, 'data:B');
        ok(tile.children.length === 2 && tile.children[0].src === 'data:B', 'second apply reuses the img');
        ok(doc.head.children.length === 1 && /\.vpt-has-thumb>\.vpt-hide\{display:none!important\}/.test(doc.head.children[0].textContent), 'style injected once with vpt-hide rule');
    }

    // ── 6. electron-main _warrantMediaCheckPath ──
    {
        const s = SRC.main.indexOf('// ── warrant-media-url (start) ──');
        const e = SRC.main.indexOf('// ── warrant-media-url (end) ──');
        ok(s > 0 && e > s, 'warrant-media-url markers present');
        const block = SRC.main.slice(s, e);
        const dirs = /const WARRANT_MEDIA_DIRS = \[[^\]]*\];/.exec(block)[0];
        const fs0 = block.indexOf('function _warrantMediaCheckPath(');
        const body0 = block.indexOf('{', fs0) + 1;
        const fnText = block.slice(fs0, braceEnd(block, body0));
        // eslint-disable-next-line no-new-func
        const check = new Function('path', dirs + '\n' + fnText + '\nreturn _warrantMediaCheckPath;')(path.win32);
        const R = 'C:\\VIPER\\cases';
        const yes = [
            R + '\\2024-001\\Evidence\\SnapchatWarrant\\imp1\\media\\v.mp4',
            'c:\\viper\\CASES\\2024-001\\evidence\\kikwarrant\\content\\abc',
            R + '\\2024-001\\Evidence\\XWarrant\\v.mp4',
            'C:/VIPER/cases/2024-001/Evidence/XWarrant/a/v.mp4',
        ];
        for (const p of yes) ok(check(p, R) !== null, 'allowed: ' + p);
        const no = [
            R + '\\2024-001\\Evidence\\SnapchatWarrant\\..\\..\\..\\..\\Windows\\win.ini',
            R + '\\2024-001\\Evidence\\SnapchatWarrant\\..\\MetaWarrant\\v.mp4',
            R + '\\2024-001\\Evidence\\GoogleWarrant\\v.mp4',
            R + '\\2024-001\\Attachments\\XWarrant\\v.mp4',
            'C:\\VIPER\\casesX1\\Evidence\\XWarrant\\v.mp4',
            'C:\\Windows\\System32\\Evidence\\XWarrant\\a\\b',
            R + '\\2024-001\\Evidence\\SnapchatWarrant',
            R + '\\Evidence\\XWarrant\\v.mp4',
        ];
        for (const p of no) ok(check(p, R) === null, 'blocked: ' + p);
        ok(check(null, R) === null && check(42, R) === null && check({}, R) === null && check(yes[0], '') === null, 'non-string / no root blocked');
        ok(check(yes[0], R) === path.win32.resolve(yes[0]), 'returns the resolved path');
    }

    // ── 7. Google Photos: video tiles never fed to <img>, decoded instead ──
    {
        const doc = new Doc();
        const wrap = doc.body.appendChild(new El('div', doc));
        const grid = wrap.appendChild(new El('div', doc)); grid.id = 'gwp-photos-grid';
        const mkTile = (rel, video) => {
            const t = grid.appendChild(new El('div', doc)); t.className = 'gwp-photo-thumb';
            t.setAttribute('data-rel', rel); if (video) t.setAttribute('data-video', '1');
            const l = t.appendChild(new El('span', doc)); l.className = 'gwp-photo-loading';
            return t;
        };
        const vTile = mkTile('Takeout/Google Photos/v.mp4', true);
        mkTile('Takeout/Google Photos/a.jpg', false);
        const reads = [], urls = [], hyd = [];
        const win = { VpVideoThumbs: { hydrate: (r, o) => hyd.push({ r, o }) } };
        const fn = bindMethod(SRC.googleUi, '_hydratePhotoThumbs', doc, win);
        const ctx = { module: {
            readMedia: async (rel) => { reads.push(rel); return 'data:image/jpeg;base64,AA'; },
            getMediaUrl: async (rel) => { urls.push(rel); return 'viper-media://m/g'; },
        } };
        fn.call(ctx, [], '#gwp-photos-grid .gwp-photo-thumb'.split(' ')[1]);
        await tick(10);
        ok(reads.length === 1 && reads[0] === 'Takeout/Google Photos/a.jpg', 'Google: only the photo is read as an image (got ' + JSON.stringify(reads) + ')');
        ok(vTile.getAttribute('data-vpt-src') === 'Takeout/Google Photos/v.mp4', 'Google: video tile opted into frame thumbnail');
        ok(hyd.length === 1 && hyd[0].r === wrap, 'Google: one hydrate over the grid container');
        ok(hyd.length && await hyd[0].o.getUrl('Takeout/Google Photos/v.mp4') === 'viper-media://m/g' && urls[0] === 'Takeout/Google Photos/v.mp4', 'Google: frame decoded from streamed getMediaUrl');
        if (hyd.length) hyd[0].o.apply(vTile, 'data:F');
        ok(!vTile.querySelector('.gwp-photo-loading') && vTile.querySelector('img') && vTile.querySelector('img').src === 'data:F', 'Google: thumbnail replaces the loading glyph');
        ok(/isVideo \? '🎬' : '…'/.test(SRC.googleUi), 'Google: video tiles show a film glyph while loading');
    }

    // ── 8. Meta: poster from first frame, never overwrites ──
    {
        VT._resetForTests();
        const doc = new Doc();
        const caps = [];
        const win = { VpVideoThumbs: { hydrate: (r, o) => VT.hydrate(r, Object.assign({}, o, { cache: new Map(), capture: async (u) => { caps.push(u); return 'data:P'; } })) } };
        const fn = bindMethod(SRC.metaUi, '_videoPoster', doc, win);
        const slot = new El('div', doc); slot._root = true;
        const v = slot.appendChild(new El('video', doc)); v.className = 'mwp-media-video'; v.setAttribute('src', 'viper-media://m/meta1');
        fn.call({}, slot, 'store|linked_media/1.mp4');
        await until(() => v.getAttribute('poster'));
        ok(v.getAttribute('data-vpt-src') === 'store|linked_media/1.mp4', 'Meta: video keyed by store+ref');
        ok(caps[0] === 'viper-media://m/meta1' && v.getAttribute('poster') === 'data:P', 'Meta: poster set from the video\'s own src');
        const slot2 = new El('div', doc); slot2._root = true;
        const v2 = slot2.appendChild(new El('video', doc)); v2.className = 'mwp-media-video'; v2.setAttribute('src', 'viper-media://m/meta2'); v2.setAttribute('poster', 'existing');
        fn.call({}, slot2, 'store|2');
        await tick(15);
        ok(v2.getAttribute('poster') === 'existing', 'Meta: existing poster kept');
        const slot3 = new El('div', doc); slot3._root = true;
        const v3 = slot3.appendChild(new El('video', doc)); v3.className = 'mwp-media-video';
        fn.call({}, slot3, '');
        ok(v3.getAttribute('data-vpt-src') === null, 'Meta: no key → nothing queued');
        ok(/this\._videoPoster\(slot, /.test(SRC.metaUi), 'Meta: _loadSlot calls _videoPoster');
    }

    // ── 9. KIK media tiles ──
    {
        const files = {
            vid: { diskPath: 'C:\\cases\\1\\Evidence\\KikWarrant\\content\\vid', mimeType: 'video/mp4' },
            mov: { diskPath: 'C:\\cases\\1\\Evidence\\KikWarrant\\content\\clip.MOV' },
            img: { diskPath: 'C:\\cases\\1\\Evidence\\KikWarrant\\content\\img', mimeType: 'image/jpeg' },
        };
        const ctx = { _getContentFile: (u) => files[u] || null };
        ctx._esc = bindMethod(SRC.kikUi, '_esc', null, {});
        ctx._isVideoFile = bindMethod(SRC.kikUi, '_isVideoFile', null, {});
        const span = bindMethod(SRC.kikUi, '_mediaLoadSpan', null, {});
        const v = span.call(ctx, 'vid', 'kk-1', '[Video]', true);
        ok(/class="kkp-media-thumb kkp-vthumb"/.test(v) && v.includes('data-vpt-src="C:\\cases\\1\\Evidence\\KikWarrant\\content\\vid"'), 'KIK: video span is a thumbnail tile');
        ok(v.includes('onclick="window.kikWarrantUI.loadMediaThumb(this.dataset.uuid, this.id)"') && v.includes('data-uuid="vid"'), 'KIK: click passes uuid via data attribute');
        ok(/kkp-vthumb-ph vpt-hide/.test(v) && /kkp-vthumb-play/.test(v), 'KIK: play icon + hideable placeholder');
        ok(/data-vpt-src=/.test(span.call(ctx, 'mov', 'kk-2', 'x', false)), 'KIK: .MOV without mime treated as video');
        const im = span.call(ctx, 'img', 'kk-3', '[Image]', false);
        ok(!/data-vpt-src/.test(im) && im.includes('>[Image]</span>'), 'KIK: image keeps the click-to-load label');
        const evil = 'x"\');alert(1);//';
        const ev = span.call(ctx, evil, 'kk-4', 'l', false);
        ok(!ev.includes(evil) && ev.includes('data-uuid="x&quot;'), 'KIK: hostile uuid escaped, never in JS');
        ok(!/loadMediaThumb\('\$\{/.test(SRC.kikUi), 'KIK: no uuid interpolated into onclick JS anywhere');
    }
} catch (e) {
    fail++;
    console.log('FAIL threw: ' + (e && e.stack || e));
}
console.log(fail ? `\n✖ FAILURES pass=${pass} fail=${fail}` : `\n✔ warrant-media-ui: ${pass} passed`);
process.exitCode = fail ? 1 : 0;
})();
