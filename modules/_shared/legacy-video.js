/**
 * VpLegacyVideo — old-format video in the warrant-return tabs
 * (Snapchat, KIK, X, Meta). Renderer, loaded after video-thumbs.js.
 *
 * VIPER's window can't decode FLV / AVI / WMV / MPG / 3GP (and some MP4s with
 * old codecs inside). The main process makes a playback copy with the shipped
 * ffmpeg (modules/_shared/video-playback.js, IPC 'warrant-video'). This file:
 *
 *  - watches every <video> in the page (capture-phase 'error' and
 *    'loadedmetadata'). A warrant-tab video that fails is swapped for a panel
 *    with a poster frame and "▶ Play in VIPER"; one that loads with no picture
 *    gets a "No picture? ▶ Play a converted copy" link. The tabs only have to
 *    say which file a <video> is — they already do (data-disk-path /
 *    data-vpt-src for Snapchat / KIK / X; Meta sets data-vplv JSON).
 *  - gives VpVideoThumbs a fallback, so video tiles get an ffmpeg frame when
 *    the window can't decode one (FLV/AVI/… skip the in-window try).
 *
 * Only files under cases\<n>\Evidence\{SnapchatWarrant,KikWarrant,XWarrant}\
 * or a Meta store ref are offered — main re-checks the same rule. The
 * BitTorrent tab's viewer passes { caseNumber, downloadId, index } in
 * data-vplv; those go to 'bt-video', which resolves and guards the file.
 * The original evidence file is never changed.
 *
 * Renderer UMD: `module` IS defined in the renderer → assign both.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VpLegacyVideo = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';

    // Same list as modules/_shared/video-playback.js LEGACY_VIDEO_EXT (test-enforced).
    const LEGACY_EXT = ['avi', 'flv', 'f4v', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob',
        '3gp', '3g2', 'ts', 'mts', 'm2ts', 'divx', 'rm', 'rmvb', 'ogm', 'dv', 'mxf'];
    const WARRANT_PATH_RE = /[\\/]evidence[\\/](snapchatwarrant|kikwarrant|xwarrant)[\\/]/i;
    const HOST_SEL = '[data-vplv],[data-disk-path],[data-vpt-src]';
    const THUMB_CACHE_MAX = 600;

    const thumbs = new Map();      // source key → Promise<dataUrl|false|null>
    const converted = new Set();   // source keys converted this session → re-open plays at once
    let seq = 0;
    let styleDone = false;

    function extOf(p) {
        const m = /\.([^.\\/]+)$/.exec(String(p || ''));
        return m ? m[1].toLowerCase() : '';
    }
    function isLegacyName(p) { return LEGACY_EXT.indexOf(extOf(p)) !== -1; }
    function isWarrantPath(p) {
        return typeof p === 'string' && (/^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p)) && WARRANT_PATH_RE.test(p);
    }
    function electron() {
        const w = api.win || root;
        return (w && w.electronAPI) || null;
    }

    function hostOf(el) {
        return el && typeof el.closest === 'function' ? el.closest(HOST_SEL) : null;
    }
    function parseJson(s) { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (_) { return null; } }

    /** Which file a <video> / tile shows → { filePath } | { caseNumber, storeKey, ref } | { caseNumber, downloadId, index } | null. */
    function srcFromObj(o) {
        if (!o) return null;
        if (typeof o.filePath === 'string') return isWarrantPath(o.filePath) ? { filePath: o.filePath } : null;
        // BitTorrent tab: file by index in a TD download (main resolves + guards it).
        if (o.downloadId != null && o.index != null && o.caseNumber != null) {
            return { caseNumber: String(o.caseNumber), downloadId: String(o.downloadId), index: Number(o.index) };
        }
        if (o.storeKey && o.ref != null && o.caseNumber != null) {
            return { caseNumber: String(o.caseNumber), storeKey: String(o.storeKey), ref: String(o.ref) };
        }
        return null;
    }
    function sourceOf(el) {
        const host = hostOf(el);
        if (!host) return null;
        const j = host.getAttribute('data-vplv');
        if (j) return srcFromObj(parseJson(j));
        const p = host.getAttribute('data-disk-path') || host.getAttribute('data-vpt-src') || '';
        return isWarrantPath(p) ? { filePath: p } : null;
    }
    /** IPC for a source: BitTorrent files go through 'bt-video', the rest 'warrant-video'. */
    function callFor(E, src) {
        if (!E || !src) return null;
        const fn = src.downloadId != null ? E.btVideo : E.warrantVideo;
        return typeof fn === 'function' ? fn : null;
    }
    /** File name (for the format label / legacy test). */
    function nameOf(el) {
        const host = hostOf(el);
        if (!host) return '';
        const j = host.getAttribute('data-vplv');
        if (j) {
            const o = parseJson(j) || {};
            return String(o.name || o.filePath || o.ref || '');
        }
        return host.getAttribute('data-disk-path') || host.getAttribute('data-vpt-src') || '';
    }
    function keyOf(src) {
        if (src.filePath) return 'f|' + src.filePath.toLowerCase();
        if (src.downloadId != null) return 'b|' + src.caseNumber + '|' + src.downloadId + '|' + src.index;
        return 'm|' + src.caseNumber + '|' + src.storeKey + '|' + src.ref;
    }

    function ensureStyle(doc) {
        if (styleDone || !doc || !doc.head || typeof doc.createElement !== 'function') return;
        styleDone = true;
        const s = doc.createElement('style');
        s.setAttribute('data-vplv', '1');
        s.textContent =
            '.vplv-panel{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:140px;min-width:200px;padding:12px;box-sizing:border-box;background:#0f1115;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e5e7eb;overflow:hidden;text-align:center}' +
            '.vplv-panel>.vplv-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:.45;pointer-events:none}' +
            '.vplv-body{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:420px}' +
            '.vplv-play{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer}' +
            '.vplv-play:disabled{opacity:.6;cursor:default}' +
            '.vplv-msg{font-size:12px;line-height:1.35;color:#d1d5db;text-shadow:0 1px 2px #000}' +
            '.vplv-bar{width:180px;height:4px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden}' +
            '.vplv-bar>i{display:block;height:100%;width:0;background:#60a5fa;transition:width .3s}' +
            '.vplv-failed .vplv-msg{color:#fca5a5}' +
            '.vplv-panel.vplv-playing{display:block;padding:0;background:transparent;border:0;min-height:0}' +
            '.vplv-video{display:block;width:100%;max-height:inherit;background:#000;border-radius:inherit}' +
            '.vplv-note{font-size:11px;color:#9ca3af;padding:3px 2px;text-align:left}' +
            '.vplv-hint{display:block;margin:4px 0 0;background:none;border:0;color:#60a5fa;font-size:12px;cursor:pointer;padding:0}';
        doc.head.appendChild(s);
    }

    /** ffmpeg frame from main → dataURL | false (can't be read, final) | null (locked / not now). */
    function thumb(src, size) {
        const E = electron();
        const call = callFor(E, src);
        if (!src || !call) return Promise.resolve(null);
        const k = keyOf(src) + '|' + (size || 360);
        if (thumbs.has(k)) return thumbs.get(k);
        const p = Promise.resolve()
            .then(() => call(Object.assign({ op: 'thumb', size: size || 360 }, src)))
            .then((r) => {
                if (r && r.success && r.dataUrl) return r.dataUrl;
                if (r && (r.reason === 'undecodable' || r.reason === 'not-video' || r.reason === 'not-allowed')) return false;
                return null;
            }, () => null)
            .then((v) => {
                if (v === null) thumbs.delete(k);           // transient: try again next time
                return v;
            });
        thumbs.set(k, p);
        if (thumbs.size > THUMB_CACHE_MAX) thumbs.delete(thumbs.keys().next().value);
        return p;
    }

    function message(name) {
        const ext = extOf(name);
        if (isLegacyName(name)) {
            return ext.toUpperCase() + ' video — VIPER\u2019s player can\u2019t open this format, so VIPER makes a playback copy first. The original file is not changed.';
        }
        return 'VIPER\u2019s player can\u2019t show this video. VIPER can make a playback copy — the original file is not changed.';
    }

    function keepClasses(cls) {
        return String(cls || '').split(/\s+/).filter(c => c && !/lazy|^vpt-|^vplv-/.test(c)).join(' ');
    }

    function setPoster(panel, dataUrl) {
        const img = panel._vplv && panel._vplv.img;
        if (img && dataUrl && img.parentNode === panel) { img.src = dataUrl; img.hidden = false; }
    }

    /**
     * Swap a <video> the window can't play for the "Play in VIPER" panel.
     * opts: { autoStart, autoplay }. → panel | null (not a warrant-tab video).
     */
    function offer(v, opts) {
        const o = opts || {};
        if (!v || !v.parentNode || v._vplvDone) return null;
        const src = sourceOf(v);
        const E = electron();
        if (!src || !callFor(E, src)) return null;
        v._vplvDone = true;
        const doc = v.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc) return null;
        ensureStyle(doc);
        const name = nameOf(v);
        const panel = doc.createElement('div');
        panel.className = ('vplv-panel ' + keepClasses(v.className)).trim();
        const st = v.getAttribute('style');
        if (st) panel.setAttribute('style', st);
        panel.setAttribute('data-vplv', JSON.stringify(Object.assign({}, src, { name })));
        panel._vplvAutoplay = o.autoplay != null ? !!o.autoplay : !!v.autoplay;
        const mk = (tag, cls, parent) => { const n = doc.createElement(tag); n.className = cls; parent.appendChild(n); return n; };
        const img = mk('img', 'vplv-poster', panel);
        img.alt = ''; img.hidden = true;
        const body = mk('div', 'vplv-body', panel);
        const btn = mk('button', 'vplv-play', body);
        btn.type = 'button';
        btn.textContent = '\u25B6 Play in VIPER';
        mk('div', 'vplv-msg', body).textContent = message(name);
        const bar = mk('div', 'vplv-bar', body);
        bar.hidden = true;
        mk('i', '', bar);
        panel._vplv = { img, btn, msg: body.children[1], bar, fill: bar.firstChild };
        // Clicks inside the panel never reach the tab (lightboxes close on click).
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === btn && !btn.disabled) start(panel);
        });
        try { if (typeof v.pause === 'function') v.pause(); } catch (_) { /* ignore */ }
        if (v._vplvHint && v._vplvHint.parentNode) v._vplvHint.parentNode.removeChild(v._vplvHint);
        const poster = v.getAttribute('poster');
        v.parentNode.replaceChild(panel, v);
        if (poster) setPoster(panel, poster);
        else thumb(src).then((d) => { if (d) setPoster(panel, d); });
        if (o.autoStart || converted.has(keyOf(src))) start(panel);
        return panel;
    }

    /** Make (or reuse) the playback copy and put a player in the panel. */
    async function start(panel) {
        if (!panel || panel._vplvBusy) return null;
        const meta = parseJson(panel.getAttribute('data-vplv') || '') || {};
        const src = srcFromObj(meta);
        const E = electron();
        const call = callFor(E, src);
        if (!call) return null;
        panel._vplvBusy = true;
        panel.classList.remove('vplv-failed');
        const ui = panel._vplv || {};
        const btn = ui.btn, msg = ui.msg, bar = ui.bar, fill = ui.fill;
        if (btn) btn.disabled = true;
        if (bar) bar.hidden = false;
        if (fill) fill.style.width = '0%';
        if (msg) msg.textContent = 'Making a playback copy\u2026';
        const jobId = 'vplv-' + (++seq);
        let off = null;
        if (typeof E.onVideoPlaybackProgress === 'function') {
            off = E.onVideoPlaybackProgress((p) => {
                if (!p || p.jobId !== jobId) return;
                const pct = Math.max(0, Math.min(100, Math.floor(+p.pct || 0)));
                if (fill) fill.style.width = pct + '%';
                if (msg) msg.textContent = (p.stage === 'remux' ? 'Repackaging for playback\u2026 ' : 'Converting for playback\u2026 ') + pct + '%';
            });
        }
        let r;
        try { r = await call(Object.assign({ op: 'play', jobId }, src)); }
        catch (e) { r = { success: false, error: String((e && e.message) || e) }; }
        finally { if (typeof off === 'function') { try { off(); } catch (_) { /* ignore */ } } }
        panel._vplvBusy = false;
        if (!r || !r.success || !r.url) {
            panel.classList.add('vplv-failed');
            if (bar) bar.hidden = true;
            if (msg) msg.textContent = (r && r.error) || 'VIPER could not convert this video.';
            if (btn) {
                btn.disabled = false;
                btn.textContent = '\u21BB Try again';
                if (r && (r.noEngine || r.reason === 'not-allowed')) btn.hidden = true;
            }
            return r;
        }
        converted.add(keyOf(src));
        if (panel.isConnected === false) return r;
        const doc = panel.ownerDocument;
        const v = doc.createElement('video');
        v.className = 'vplv-video';
        v.controls = true;
        v.preload = 'metadata';
        v._vplvDone = true;                       // never offered again
        if (panel._vplvAutoplay) v.autoplay = true;
        const pimg = ui.img;
        if (pimg && !pimg.hidden && pimg.src) v.setAttribute('poster', pimg.src);
        v.src = r.url;
        const note = doc.createElement('div');
        note.className = 'vplv-note';
        const from = r.from && r.from !== 'bin' ? String(r.from).toUpperCase() + ' \u2192 ' : '';
        note.textContent = 'Playing a VIPER playback copy (' + from + String(r.format || 'mp4').toUpperCase() + '). The original file is not changed.';
        while (panel.firstChild) panel.removeChild(panel.firstChild);
        panel.classList.add('vplv-playing');
        panel.appendChild(v);
        panel.appendChild(note);
        return r;
    }

    /** A warrant-tab video that loaded with no picture: offer a converted copy. */
    function hint(v) {
        if (!v || v._vplvDone || v._vplvHint || !v.parentNode) return null;
        if (!sourceOf(v) || !electron()) return null;
        const doc = v.ownerDocument;
        ensureStyle(doc);
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'vplv-hint';
        b.textContent = 'No picture? \u25B6 Play a converted copy';
        b.addEventListener('click', (e) => { e.stopPropagation(); offer(v, { autoStart: true, autoplay: true }); });
        v._vplvHint = b;
        v.parentNode.insertBefore(b, v.nextSibling || null);
        return b;
    }

    function onError(e) {
        const t = e && e.target;
        if (!t || !t.tagName) return;
        let v = null;
        if (t.tagName === 'VIDEO') v = t;
        else if (t.tagName === 'SOURCE' && t.parentNode && t.parentNode.tagName === 'VIDEO') v = t.parentNode;
        if (!v || v._vplvDone) return;
        if (!sourceOf(v)) return;
        // The user already asked to play (lightbox / click-to-play) → start straight away.
        offer(v, { autoStart: !!v.autoplay });
    }
    function onMeta(e) {
        const v = e && e.target;
        if (!v || v.tagName !== 'VIDEO' || v._vplvDone) return;
        if (v.videoWidth === 0) hint(v);
    }
    function install(doc) {
        if (!doc || doc._vplvInstalled || typeof doc.addEventListener !== 'function') return false;
        doc._vplvInstalled = true;
        doc.addEventListener('error', onError, true);           // media errors don't bubble; capture sees them
        doc.addEventListener('loadedmetadata', onMeta, true);
        return true;
    }

    /** Fallback for VpVideoThumbs (see video-thumbs.js). */
    const thumbFallback = {
        first: (el) => { const n = nameOf(el); return !!n && isLegacyName(n) && !!sourceOf(el); },
        thumb: (el) => { const src = sourceOf(el); return src ? thumb(src) : Promise.resolve(null); },
    };
    function attachThumbs(vt) {
        if (vt && typeof vt === 'object') { vt.fallback = thumbFallback; return true; }
        return false;
    }

    function _resetForTests() { thumbs.clear(); converted.clear(); seq = 0; styleDone = false; }

    const api = {
        LEGACY_EXT, isLegacyName, isWarrantPath, sourceOf, nameOf, keyOf, thumb, offer, start, hint,
        onError, onMeta, install, attachThumbs, thumbFallback, converted, _resetForTests, win: null,
    };

    if (root && root.VpVideoThumbs) attachThumbs(root.VpVideoThumbs);
    if (typeof document !== 'undefined' && document && document.addEventListener) install(document);
    return api;
});
