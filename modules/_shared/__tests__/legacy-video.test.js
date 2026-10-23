/**
 * Old-format video in the warrant-return tabs (Snapchat, KIK, X, Meta).
 *
 * Covers modules/_shared/legacy-video.js (VpLegacyVideo: failed <video> →
 * "Play in VIPER" panel → playback copy; "No picture?" link; VpVideoThumbs
 * ffmpeg fallback), the path-guarded 'warrant-video' IPC in electron-main,
 * preload, the importers' video types (FLV/AVI/WMV/MPG/3GP now count as
 * video), video-playback's anyExt + sniffVideo, and the tab hooks.
 *
 * The last part runs the real shipped ffmpeg on a SYNTHETIC clip when
 * build\ffmpeg\ffmpeg.exe is present; otherwise it is skipped and says so.
 *
 * Run: node modules\_shared\__tests__\legacy-video.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const rd = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const VP = require('../video-playback');
const VT = require('../video-thumbs');
const LV = require('../legacy-video');
const MAIN = rd('electron-main.js');
const PRELOAD = rd('preload.js');
const CD = rd('case-detail-with-analytics.html');
const VERIFY = rd('scripts/verify-package.js');
const FF = path.join(REPO, 'build', 'ffmpeg', 'ffmpeg.exe');
const HAVE_FF = fs.existsSync(FF);

let passed = 0, failed = 0, skipped = 0;
async function ok(label, fn) {
    try { await fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); failed++; }
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

// ── a tiny DOM: enough for legacy-video.js and VpVideoThumbs.hydrate ──
class El {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.parentNode = null;
        this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.hidden = false;
        this.disabled = false; this.textContent = ''; this._cls = [];
        const self = this;
        this.classList = {
            add: (c) => { if (!self._cls.includes(c)) self._cls.push(c); },
            remove: (c) => { self._cls = self._cls.filter(x => x !== c); },
            contains: (c) => self._cls.includes(c),
        };
    }
    get className() { return this._cls.join(' '); }
    set className(v) { this._cls = String(v || '').split(/\s+/).filter(Boolean); }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
    getAttribute(k) { return k === 'class' ? this.className || null : (k in this.attrs ? this.attrs[k] : null); }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c;
    }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
    replaceChild(n, o) { const i = this.children.indexOf(o); if (n.parentNode) n.parentNode.removeChild(n); this.children[i] = n; n.parentNode = this; o.parentNode = null; return o; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    _match(sel) {
        return sel.split(',').some(s => {
            s = s.trim();
            if (s[0] === '[') return s.slice(1, -1) in this.attrs;
            if (s[0] === '.') return this._cls.includes(s.slice(1));
            return this.tagName === s.toUpperCase();
        });
    }
    closest(sel) { let n = this; while (n && n !== this.ownerDocument) { if (n._match && n._match(sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c._match(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    click(target) {
        const ev = { target: target || this, stopped: false, stopPropagation() { this.stopped = true; } };
        let n = target || this;
        while (n && !ev.stopped) { for (const fn of (n.listeners.click || [])) fn(ev); n = n.parentNode; }
        return ev;
    }
    pause() { this.paused = true; }
}
function makeDoc() {
    const doc = { listeners: {}, addEventListener(t, fn, cap) { (this.listeners[t] = this.listeners[t] || []).push({ fn, cap }); } };
    doc.createElement = (t) => new El(t, doc);
    doc.head = new El('head', doc);
    doc.body = new El('body', doc);
    doc.fire = (type, target) => { for (const l of (doc.listeners[type] || [])) l.fn({ type, target }); };
    return doc;
}
const W = 'C:\\VIPER\\cases\\2024-001\\Evidence\\SnapchatWarrant\\media\\clip.flv';
const WK = 'C:\\VIPER\\cases\\2024-001\\Evidence\\KikWarrant\\content\\abc123';   // no extension (sniffed)

function fakeApi(opts) {
    const o = opts || {};
    const calls = [];
    let progressCb = null;
    const E = {
        calls,
        async warrantVideo(a) {
            calls.push(a);
            if (a.op === 'thumb') return o.thumb ? o.thumb(a) : { success: true, dataUrl: 'data:image/jpeg;base64,AAA', video: true };
            if (o.beforePlay) await o.beforePlay(a, (p) => progressCb && progressCb(Object.assign({ jobId: a.jobId }, p)));
            return o.play ? o.play(a) : { success: true, url: 'viper-media://m/copy', mode: 'transcode', format: 'mp4', from: 'flv' };
        },
        onVideoPlaybackProgress(cb) { progressCb = cb; return () => { progressCb = null; E.unsubscribed = (E.unsubscribed || 0) + 1; }; },
    };
    return E;
}

(async () => {
    console.log('VpLegacyVideo: which videos it may touch');
    await ok('legacy list is exactly video-playback LEGACY_VIDEO_EXT', () => {
        assert.deepStrictEqual(LV.LEGACY_EXT, VP.LEGACY_VIDEO_EXT);
    });
    await ok('only Snapchat / KIK / X evidence folders (any case, any depth) count as warrant paths', () => {
        assert.ok(LV.isWarrantPath(W) && LV.isWarrantPath(WK));
        assert.ok(LV.isWarrantPath('D:\\cases\\x\\evidence\\xwarrant\\a\\b.mp4'));
        assert.ok(LV.isWarrantPath('\\\\nas\\share\\cases\\1\\Evidence\\KikWarrant\\c'));
        for (const bad of ['C:\\cases\\1\\Evidence\\Other\\a.flv', 'cases\\1\\Evidence\\SnapchatWarrant\\a.flv',
            'C:\\Users\\a\\Downloads\\a.flv', 'C:\\cases\\1\\SnapchatWarrant\\a.flv', '', null, 42])
            assert.ok(!LV.isWarrantPath(bad), String(bad));
    });
    await ok('sourceOf: data-disk-path / data-vpt-src (warrant paths only) and Meta data-vplv JSON', () => {
        const doc = makeDoc();
        const v = doc.createElement('video'); v.setAttribute('data-disk-path', W);
        assert.deepStrictEqual(LV.sourceOf(v), { filePath: W });
        const tile = doc.createElement('div'); tile.setAttribute('data-vpt-src', WK);
        const inner = tile.appendChild(doc.createElement('span'));
        assert.deepStrictEqual(LV.sourceOf(inner), { filePath: WK }, 'found through an ancestor tile');
        const g = doc.createElement('div'); g.setAttribute('data-vpt-src', 'Takeout/Google Photos/v.mp4');
        assert.strictEqual(LV.sourceOf(g), null, 'Google tab keys are left alone');
        const ev = doc.createElement('video'); ev.setAttribute('data-disk-path', 'C:\\cases\\1\\Evidence\\a.flv');
        assert.strictEqual(LV.sourceOf(ev), null, 'Evidence tab handles its own videos');
        const m = doc.createElement('video');
        m.setAttribute('data-vplv', JSON.stringify({ caseNumber: '2024-001', storeKey: 'abc', ref: 'linked_media/v.avi', name: 'v.avi' }));
        assert.deepStrictEqual(LV.sourceOf(m), { caseNumber: '2024-001', storeKey: 'abc', ref: 'linked_media/v.avi' });
        assert.strictEqual(LV.nameOf(m), 'v.avi');
        const bad = doc.createElement('video'); bad.setAttribute('data-vplv', '{oops');
        assert.strictEqual(LV.sourceOf(bad), null);
        const badPath = doc.createElement('video'); badPath.setAttribute('data-vplv', JSON.stringify({ filePath: 'C:\\Windows\\a.flv' }));
        assert.strictEqual(LV.sourceOf(badPath), null, 'JSON filePath is guarded too');
    });

    console.log('VpLegacyVideo: failed video → Play in VIPER');
    await ok('a warrant <video> that errors becomes a panel with the ffmpeg poster; the click converts and plays the copy', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        const E = fakeApi({ beforePlay: async (a, prog) => { prog({ stage: 'transcode', pct: 40 }); } });
        LV.win = { electronAPI: E };
        const bubble = doc.body.appendChild(doc.createElement('div'));
        const v = bubble.appendChild(doc.createElement('video'));
        v.className = 'swp-msg-video swp-lazy-video'; v.setAttribute('data-disk-path', W); v.setAttribute('style', 'max-width:300px');
        const ev = { target: v };
        LV.onError(ev);
        const panel = bubble.children[0];
        assert.ok(panel !== v && panel.classList.contains('vplv-panel'), 'video swapped for the panel');
        assert.ok(panel.classList.contains('swp-msg-video') && !panel.classList.contains('swp-lazy-video'), 'keeps sizing class, drops lazy class (the tab loader would grab it)');
        assert.strictEqual(panel.getAttribute('style'), 'max-width:300px');
        assert.ok(/FLV video/.test(panel._vplv.msg.textContent) && /original file is not changed/.test(panel._vplv.msg.textContent));
        await tick(5);
        assert.deepStrictEqual(E.calls[0], { op: 'thumb', size: 360, filePath: W });
        assert.ok(!panel._vplv.img.hidden && /^data:image\/jpeg/.test(panel._vplv.img.src), 'poster frame shown');
        assert.strictEqual(E.calls.length, 1, 'nothing converts until the officer clicks');
        const clickEv = panel.click(panel._vplv.btn);
        assert.ok(clickEv.stopped, 'click does not reach the tab (lightbox would close)');
        assert.ok(panel._vplv.btn.disabled && !panel._vplv.bar.hidden, 'busy state while converting');
        await tick(5);
        const play = E.calls.find(c => c.op === 'play');
        assert.ok(play && play.filePath === W && /^vplv-\d+$/.test(play.jobId));
        const player = panel.children[0];
        assert.strictEqual(player.tagName, 'VIDEO');
        assert.strictEqual(player.src, 'viper-media://m/copy');
        assert.ok(player.controls && !player.autoplay, 'inline video: no autoplay');
        assert.ok(/^data:image\/jpeg/.test(player.getAttribute('poster')));
        assert.ok(/VIPER playback copy \(FLV → MP4\)/.test(panel.children[1].textContent));
        assert.strictEqual(E.unsubscribed, 1, 'progress listener removed');
        assert.ok(LV.converted.has('f|' + W.toLowerCase()));
        LV.onError({ target: player });
        assert.strictEqual(panel.children[0], player, 'the copy itself is never offered again');
    });
    await ok('progress events update the bar (only for this job)', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        let seen = null;
        let release;
        const gate = new Promise(r => { release = r; });
        const E = fakeApi({ beforePlay: async (a, prog) => { prog({ stage: 'remux', pct: 55.7 }); seen = a.jobId; await gate; } });
        LV.win = { electronAPI: E };
        const v = doc.body.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W);
        const panel = LV.offer(v, {});
        const p = LV.start(panel);
        await tick(5);
        assert.ok(seen);
        assert.strictEqual(panel._vplv.fill.style.width, '55%');
        assert.ok(/Repackaging for playback… 55%/.test(panel._vplv.msg.textContent));
        assert.strictEqual(await LV.start(panel), null, 'second click while busy does nothing');
        release(); await p;
    });
    await ok('lightbox / click-to-play (autoplay) starts converting straight away and autoplays the copy', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        const v = doc.body.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W); v.autoplay = true;
        LV.onError({ target: v });
        await tick(5);
        const panel = doc.body.children[0];
        assert.ok(E.calls.some(c => c.op === 'play'));
        assert.ok(panel.children[0].autoplay);
    });
    await ok('<source> errors count; a video converted earlier this session plays without another click', async () => {
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        const v = doc.body.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W);
        const s = v.appendChild(doc.createElement('source'));
        LV.onError({ target: s });
        await tick(5);
        assert.ok(E.calls.some(c => c.op === 'play'), 'remembered from the previous test');
        assert.strictEqual(doc.body.children[0].children[0].tagName, 'VIDEO');
    });
    await ok('failure: message shown, Try again; missing converter or refused path hides the button', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        let reply = { success: false, error: 'VIPER could not convert this video. bad data' };
        const E = fakeApi({ play: () => reply });
        LV.win = { electronAPI: E };
        const v = doc.body.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W);
        const panel = LV.offer(v, {});
        await LV.start(panel);
        assert.ok(panel.classList.contains('vplv-failed'));
        assert.strictEqual(panel._vplv.msg.textContent, reply.error);
        assert.ok(!panel._vplv.btn.disabled && !panel._vplv.btn.hidden && /Try again/.test(panel._vplv.btn.textContent));
        assert.ok(!LV.converted.size, 'a failure is not remembered as converted');
        reply = { success: false, locked: true, error: 'This file is protected by Field Security. Unlock Field Security to view it.' };
        await LV.start(panel);
        assert.ok(/Unlock Field Security/.test(panel._vplv.msg.textContent) && !panel._vplv.btn.hidden, 'locked: can retry after unlocking');
        reply = { success: false, noEngine: true, error: 'The video converter is missing' };
        await LV.start(panel);
        assert.ok(panel._vplv.btn.hidden);
        const E2 = fakeApi({ play: () => { throw new Error('ipc gone'); } });
        LV.win = { electronAPI: E2 };
        const v2 = doc.body.appendChild(doc.createElement('video')); v2.setAttribute('data-disk-path', W);
        const p2 = LV.offer(v2, {});
        await LV.start(p2);
        assert.ok(/ipc gone/.test(p2._vplv.msg.textContent));
    });
    await ok('non-warrant videos, no electronAPI, or a missing poster frame leave things alone', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        LV.win = { electronAPI: fakeApi({ thumb: () => ({ success: false, reason: 'locked', locked: true }) }) };
        const plain = doc.body.appendChild(doc.createElement('video')); plain.setAttribute('src', 'viper-media://m/x');
        LV.onError({ target: plain });
        assert.strictEqual(doc.body.children[0], plain);
        LV.onError({ target: doc.createElement('img') });
        LV.onError({});
        const v = doc.body.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W);
        const panel = LV.offer(v, {});
        await tick(5);
        assert.ok(panel._vplv.img.hidden, 'locked → no poster, panel still offered');
        LV.win = { electronAPI: {} };
        const v2 = doc.body.appendChild(doc.createElement('video')); v2.setAttribute('data-disk-path', W);
        assert.strictEqual(LV.offer(v2, {}), null, 'main not restarted yet (no warrantVideo) → untouched');
    });
    await ok('loaded with no picture → "No picture?" link under the video; clicking it converts and autoplays', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        const wrap = doc.body.appendChild(doc.createElement('div'));
        const v = wrap.appendChild(doc.createElement('video')); v.setAttribute('data-disk-path', W.replace('.flv', '.mp4'));
        v.videoWidth = 640;
        LV.onMeta({ target: v });
        assert.strictEqual(wrap.children.length, 1, 'picture fine → nothing added');
        v.videoWidth = 0;
        LV.onMeta({ target: v });
        LV.onMeta({ target: v });
        assert.strictEqual(wrap.children.length, 2, 'one link only');
        const link = wrap.children[1];
        assert.ok(/No picture\?/.test(link.textContent));
        link.click();
        await tick(5);
        assert.strictEqual(wrap.children.length, 1, 'link removed with the video');
        const panel = wrap.children[0];
        assert.ok(panel.classList.contains('vplv-playing') && panel.children[0].autoplay);
        assert.ok(/can.t show this video/.test(JSON.stringify(panel.getAttribute('data-vplv'))) === false);
    });
    await ok('install(): capture-phase error + loadedmetadata listeners on the document, once', () => {
        const doc = makeDoc();
        assert.ok(LV.install(doc));
        assert.ok(!LV.install(doc));
        assert.ok(doc.listeners.error[0].cap === true && doc.listeners.loadedmetadata[0].cap === true);
    });
    await ok('Meta: offer/start send caseNumber + storeKey + ref (never a path)', async () => {
        LV._resetForTests();
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        const v = doc.body.appendChild(doc.createElement('video'));
        v.setAttribute('data-vplv', JSON.stringify({ caseNumber: '7', storeKey: 'k1', ref: 'linked_media/a.3gp', name: 'a.3gp' }));
        const panel = LV.offer(v, {});
        assert.ok(/3GP video/.test(panel._vplv.msg.textContent));
        await LV.start(panel);
        const play = E.calls.find(c => c.op === 'play');
        assert.deepStrictEqual(Object.keys(play).sort(), ['caseNumber', 'jobId', 'op', 'ref', 'storeKey']);
    });

    console.log('VpVideoThumbs fallback (ffmpeg frame from main)');
    function tiles(doc, keys) {
        const r = doc.body.appendChild(doc.createElement('div'));   // hydrate skips detached tiles
        const els = keys.map(k => { const t = r.appendChild(doc.createElement('div')); t.setAttribute('data-vpt-src', k); return t; });
        return { r, els };
    }
    await ok('legacy files skip the in-window decode; others try it first and fall back when it fails', async () => {
        LV._resetForTests(); VT._resetForTests();
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        LV.attachThumbs(VT);
        const mp4 = W.replace('clip.flv', 'old.mp4');
        const { r } = tiles(doc, [W, mp4]);
        const urls = [], caps = [], applied = [];
        VT.hydrate(r, { cache: new Map(), getUrl: async (k) => { urls.push(k); return 'viper-media://m/' + urls.length; },
            capture: async (u) => { caps.push(u); return null; }, apply: (el, d) => applied.push([el.getAttribute('data-vpt-src'), d]) });
        await tick(20);
        assert.deepStrictEqual(urls, [mp4], 'FLV never streamed to the window');
        assert.strictEqual(caps.length, 1);
        assert.deepStrictEqual(E.calls.map(c => c.filePath).sort(), [W, mp4].sort());
        assert.strictEqual(applied.length, 2);
        VT.fallback = null;
    });
    await ok('fallback: undecodable is cached as a failure; locked/transient is not (retried next render)', async () => {
        LV._resetForTests(); VT._resetForTests();
        const doc = makeDoc();
        let reason = 'locked';
        const E = fakeApi({ thumb: () => ({ success: false, reason }) });
        LV.win = { electronAPI: E };
        LV.attachThumbs(VT);
        const cache = new Map();
        const opts = { cache, getUrl: async () => 'u', capture: async () => null, apply: () => {} };
        VT.hydrate(tiles(doc, [W]).r, opts);
        await tick(20);
        assert.ok(!cache.has(W), 'locked → not cached');
        reason = 'undecodable';
        VT.hydrate(tiles(doc, [W]).r, opts);
        await tick(20);
        assert.strictEqual(cache.get(W), '', 'damaged → cached failure, no endless retries');
        VT.fallback = null;
    });
    await ok('without the fallback VpVideoThumbs behaves exactly as before (null URL is not cached)', async () => {
        VT._resetForTests();
        const doc = makeDoc();
        const cache = new Map();
        VT.hydrate(tiles(doc, [W]).r, { cache, getUrl: async () => null, capture: async () => 'x', apply: () => {} });
        await tick(10);
        assert.ok(!cache.has(W));
        VT.hydrate(tiles(doc, [W]).r, { cache, getUrl: async () => 'u', capture: async () => null, apply: () => {} });
        await tick(10);
        assert.strictEqual(cache.get(W), '');
    });
    await ok('non-warrant tiles (Google, DataPilot …) get no ffmpeg call even with the fallback attached', async () => {
        LV._resetForTests(); VT._resetForTests();
        const doc = makeDoc();
        const E = fakeApi();
        LV.win = { electronAPI: E };
        LV.attachThumbs(VT);
        const cache = new Map();
        VT.hydrate(tiles(doc, ['Takeout/v.flv']).r, { cache, getUrl: async () => null, capture: async () => 'x', apply: () => {} });
        await tick(10);
        assert.strictEqual(E.calls.length, 0);
        assert.ok(!cache.has('Takeout/v.flv'), 'still "may succeed later"');
        VT.fallback = null;
    });

    console.log('main: warrant-video IPC (lifted from electron-main.js)');
    const block = (() => {
        const s = MAIN.indexOf('// ── warrant-video (start) ──'), e = MAIN.indexOf('// ── warrant-video (end) ──');
        assert.ok(s > 0 && e > s);
        return MAIN.slice(s, e);
    })();
    const guard = (() => {
        const s = MAIN.indexOf('// ── warrant-media-url (start) ──');
        const b = MAIN.slice(s, MAIN.indexOf('// ── warrant-media-url (end) ──'));
        const dirs = /const WARRANT_MEDIA_DIRS = [^;]+;/.exec(b)[0];
        const f0 = b.indexOf('function _warrantMediaCheckPath(');
        let i = b.indexOf('{', f0), d = 0;
        for (; i < b.length; i++) { if (b[i] === '{') d++; else if (b[i] === '}' && --d === 0) break; }
        return new Function('path', dirs + '\n' + b.slice(f0, i + 1) + '\nreturn _warrantMediaCheckPath;')(path.win32);
    })();
    function mainHarness() {
        const handlers = {}, vpCalls = [], metaCalls = [], sent = [];
        const ipcMain = { handle: (n, fn) => { handlers[n] = fn; } };
        const vp = {
            thumb: async (a) => { vpCalls.push(['thumb', a]); return { success: true, dataUrl: 'd' }; },
            prepare: async (a) => { vpCalls.push(['prepare', a]); if (a.onProgress) a.onProgress({ stage: 'transcode', pct: 12 }); return { success: true, url: 'viper-media://m/t' }; },
        };
        const meta = { mediaSource: (c, k, r) => { metaCalls.push([c, k, r]); return r === 'linked_media/a.avi' ? 'C:\\store\\linked_media\\a.avi' : null; } };
        new Function('ipcMain', '_warrantMediaCheckPath', 'casesDir', '_metaService', '_videoPlayback', block)(
            ipcMain, guard, 'C:\\VIPER\\cases', meta, vp);
        const event = { sender: { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) } };
        return { h: handlers['warrant-video'], event, vpCalls, metaCalls, sent };
    }
    await ok('Snapchat/KIK/X path: guarded, thumb + play with anyExt, progress on video-playback-progress', async () => {
        const m = mainHarness();
        assert.ok(typeof m.h === 'function');
        const t = await m.h(m.event, { op: 'thumb', filePath: WK, size: 200 });
        assert.ok(t.success);
        assert.deepStrictEqual(m.vpCalls[0], ['thumb', { filePath: WK, size: 200, anyExt: true }]);
        const p = await m.h(m.event, { op: 'play', filePath: W, jobId: 'vplv-3' });
        assert.ok(p.success);
        assert.strictEqual(m.vpCalls[1][1].filePath, W);
        assert.strictEqual(m.vpCalls[1][1].anyExt, true);
        assert.deepStrictEqual(m.sent[0], ['video-playback-progress', { jobId: 'vplv-3', stage: 'transcode', pct: 12 }]);
    });
    await ok('refuses anything outside the three warrant evidence folders (traversal, other folders, relative)', async () => {
        const m = mainHarness();
        for (const fp of ['C:\\VIPER\\cases\\1\\Evidence\\Other\\a.flv', 'C:\\Windows\\a.flv',
            'C:\\VIPER\\cases\\1\\Evidence\\SnapchatWarrant\\..\\..\\..\\x.flv', 'cases\\1\\Evidence\\XWarrant\\a.flv', 'C:\\VIPER\\cases\\1\\Evidence\\SnapchatWarrant']) {
            const r = await m.h(m.event, { op: 'play', filePath: fp });
            assert.ok(!r.success && r.reason === 'not-allowed', fp);
        }
        assert.ok(!(await m.h(m.event, null)).success);
        assert.strictEqual(m.vpCalls.length, 0);
    });
    await ok('Meta: resolved by the store (caseNumber + storeKey + ref); unknown ref refused', async () => {
        const m = mainHarness();
        const r = await m.h(m.event, { op: 'play', caseNumber: '7', storeKey: 'k1', ref: 'linked_media/a.avi', jobId: 'j' });
        assert.ok(r.success);
        assert.deepStrictEqual(m.metaCalls[0], ['7', 'k1', 'linked_media/a.avi']);
        assert.strictEqual(m.vpCalls[0][1].filePath, 'C:\\store\\linked_media\\a.avi');
        const no = await m.h(m.event, { op: 'thumb', caseNumber: '7', storeKey: 'k1', ref: 'nope' });
        assert.ok(!no.success && no.reason === 'not-allowed');
        assert.ok(!(await m.h(m.event, { op: 'play', storeKey: 'k1', ref: 'x' })).success, 'caseNumber required');
    });
    await ok('wiring: preload warrantVideo, case-detail loads legacy-video.js after video-thumbs.js, verify-package spot-check', () => {
        assert.ok(/warrantVideo: \(args\) => ipcRenderer\.invoke\('warrant-video', args\)/.test(PRELOAD));
        assert.ok(/onVideoPlaybackProgress/.test(PRELOAD));
        const a = CD.indexOf('<script src="modules/_shared/video-thumbs.js"></script>');
        const b = CD.indexOf('<script src="modules/_shared/legacy-video.js"></script>');
        assert.ok(a > 0 && b > a);
        assert.ok(/legacy-video\.js/.test(VERIFY) && /VpLegacyVideo/.test(VERIFY));
        assert.ok(MAIN.indexOf('// ── warrant-video (start) ──') > MAIN.indexOf('const _videoPlayback = '), 'defined after _videoPlayback');
    });

    console.log('tabs + importers');
    await ok('Meta tab marks stored videos with data-vplv (caseNumber, storeKey, ref, name)', () => {
        const ui = rd('modules/meta-warrant/meta-warrant-ui.js');
        assert.ok(/JSON\.stringify\(\{ caseNumber: this\.module\.caseNumber, storeKey: imp && imp\.storeKey, ref, name: r\.name \|\| '' \}\)/.test(ui));
        assert.ok(/<video class="mwp-media-video"[^`]*data-vplv="\$\{this\._attr\(vplv\)\}"/.test(ui), 'attribute-escaped');
        const svc = rd('modules/meta-warrant/meta-warrant-service.js');
        assert.ok(/mediaSource\(caseNumber, storeKey, ref\)/.test(svc) && /hit\.entry\.kind !== 'video' && hit\.entry\.kind !== 'audio'/.test(svc));
    });
    await ok('KIK click-to-play video and X media player carry the disk path; KIK knows the old extensions', () => {
        const kik = rd('modules/kik-warrant/kik-warrant-ui.js');
        assert.ok(/<video src="\$\{this\._esc\(streamUrl\)\}" data-disk-path="\$\{this\._esc\(file\.diskPath\)\}"/.test(kik));
        assert.ok(/flv\|f4v\|wmv/.test(kik) && /avi/.test(kik));
        const x = rd('modules/x-warrant/x-warrant-ui.js');
        assert.ok(/v\.setAttribute\('data-disk-path', diskPath\)/.test(x));
        const snap = rd('modules/snapchat-warrant/snapchat-warrant-ui.js');
        assert.ok(/swp-lazy-video" data-disk-path=/.test(snap), 'Snapchat already does');
    });
    await ok('Snapchat + X importers: FLV/AVI/WMV/MPG/3GP are video types (were application/octet-stream)', () => {
        const S = require('../../snapchat-warrant/snapchat-warrant-parser');
        const X = require('../../x-warrant/x-warrant-parser');
        const s = Object.create(S.prototype), x = Object.create(X.prototype);
        for (const [e, m] of [['.flv', 'video/x-flv'], ['.AVI', 'video/x-msvideo'], ['.wmv', 'video/x-ms-wmv'], ['.mpg', 'video/mpeg'], ['.3gp', 'video/3gpp']]) {
            assert.strictEqual(s._mimeFromExt(e), m, 'snap ' + e);
            assert.strictEqual(x._mimeFromExt(e), m, 'x ' + e);
        }
        assert.strictEqual(s._mimeFromExt('.mp4'), 'video/mp4');
        assert.strictEqual(s._mimeFromExt('.xyz'), 'application/octet-stream');
        assert.strictEqual(x._mimeFromExt('.mp3'), 'audio/mpeg');
    });
    const FLV_HEAD = Buffer.from([0x46, 0x4C, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0]);
    const AVI_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('AVI LIST')]);
    const ASF_HEAD = Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0, 0xAA, 0, 0x62, 0xCE, 0x6C]);
    const MPG_HEAD = Buffer.from([0, 0, 1, 0xBA, 0x44, 0, 4, 0, 4, 1, 1, 0x89, 0xC3, 0xF8, 0, 0]);
    const GP3_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp3gp4'), Buffer.alloc(4)]);
    const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    await ok('sniffVideo: FLV, AVI, ASF/WMV, MPEG-PS, 3GP from the first bytes; MP4/JPEG/garbage are not "old"', () => {
        assert.deepStrictEqual(VP.sniffVideo(FLV_HEAD), { mime: 'video/x-flv', ext: 'flv' });
        assert.deepStrictEqual(VP.sniffVideo(AVI_HEAD), { mime: 'video/x-msvideo', ext: 'avi' });
        assert.deepStrictEqual(VP.sniffVideo(ASF_HEAD), { mime: 'video/x-ms-wmv', ext: 'wmv' });
        assert.deepStrictEqual(VP.sniffVideo(MPG_HEAD), { mime: 'video/mpeg', ext: 'mpg' });
        assert.deepStrictEqual(VP.sniffVideo(GP3_HEAD), { mime: 'video/3gpp', ext: '3gp' });
        assert.strictEqual(VP.sniffVideo(MP4_HEAD), null);
        assert.strictEqual(VP.sniffVideo(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), null);
        assert.strictEqual(VP.sniffVideo(Buffer.from('RIFF....WAVE')), null);
        assert.strictEqual(VP.sniffVideo(Buffer.from('ab')), null);
        assert.strictEqual(VP.sniffVideo(null), null);
        for (const x of VP.LEGACY_VIDEO_EXT) assert.ok(/^video\//.test(VP.VIDEO_MIME_BY_EXT[x]), 'mime for ' + x);
    });
    await ok('KIK importer: extension-less content files sniffed as FLV/AVI/3GP are video; .avi by name too', () => {
        const K = require('../../kik-warrant/kik-warrant-parser');
        const k = Object.create(K.prototype);
        const ent = (b) => ({ getData: () => b });
        assert.strictEqual(k._detectMimeType('abc123', ent(FLV_HEAD)), 'video/x-flv');
        assert.strictEqual(k._detectMimeType('abc123', ent(AVI_HEAD)), 'video/x-msvideo');
        assert.strictEqual(k._detectMimeType('abc123', ent(GP3_HEAD)), 'video/3gpp');
        assert.strictEqual(k._detectMimeType('abc123', ent(MP4_HEAD)), 'video/mp4');
        assert.strictEqual(k._detectMimeType('abc123', ent(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]))), 'image/jpeg');
        assert.strictEqual(k._detectMimeType('x.avi', ent(Buffer.alloc(0))), 'video/x-msvideo');
        assert.strictEqual(k._detectMimeType('abc', ent(Buffer.from('hello world 1234'))), 'application/octet-stream');
    });
    await ok('Meta importer: old videos are kind "video"; wrong extension relabelled; .wma (ASF audio) is not a video', () => {
        const M = require('../../meta-warrant/meta-warrant-importer');
        const a = M.classifyMedia('clip.avi', AVI_HEAD, '');
        assert.strictEqual(a.kind, 'video'); assert.strictEqual(a.mime, 'video/x-msvideo');
        assert.ok(!a.sniffed, '.avi already names it');
        const f = M.classifyMedia('upload.bin', FLV_HEAD, '');
        assert.strictEqual(f.kind, 'video'); assert.ok(f.sniffed);
        const w = M.classifyMedia('movie.wmv', ASF_HEAD, '');
        assert.strictEqual(w.kind, 'video');
        const wma = M.classifyMedia('voice.wma', ASF_HEAD, '');
        assert.notStrictEqual(wma.kind, 'video');
        const g = M.classifyMedia('a.3gp', GP3_HEAD, '');
        assert.strictEqual(g.kind, 'video');
    });

    console.log('video-playback: anyExt (real ffmpeg)');
    if (!HAVE_FF) {
        console.log('  SKIP  build\\ffmpeg\\ffmpeg.exe not present — run node scripts\\fetch-ffmpeg.js');
        skipped++;
    } else {
        const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-lv-'));
        try {
            const flv = path.join(TMP, 'a.flv');
            cp.execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=2',
                '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'flv', '-c:a', 'adpcm_swf', '-ar', '22050', '-shortest', flv]);
            const bare = path.join(TMP, 'abc123');                     // KIK-style content file
            fs.copyFileSync(flv, bare);
            const vpb = VP.createVideoPlayback({ fs, spawn: cp.spawn, ffmpegPath: () => FF, cacheRoot: path.join(TMP, 'cache'), pid: 5151, issueToken: () => 'tok' });
            await ok('extension-less file: refused without anyExt, converted + thumbnailed with it (main vouched for the path)', async () => {
                assert.strictEqual((await vpb.prepare({ filePath: bare })).success, false);
                assert.strictEqual((await vpb.thumb({ filePath: bare })).reason, 'not-video');
                const r = await vpb.prepare({ filePath: bare, anyExt: true });
                assert.ok(r.success, JSON.stringify(r));
                assert.strictEqual(r.from, 'bin');
                const t = await vpb.thumb({ filePath: bare, anyExt: true });
                assert.ok(t.success && /^data:image\/jpeg;base64,/.test(t.dataUrl));
                assert.ok(fs.readFileSync(bare).equals(fs.readFileSync(flv)), 'original untouched');
            });
            vpb.dispose();
        } finally {
            try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
        }
    }

    console.log(`\n${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
    process.exit(failed ? 1 : 0);
})();
