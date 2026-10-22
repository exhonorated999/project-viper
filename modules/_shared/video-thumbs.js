/**
 * VpVideoThumbs — first-frame thumbnails for video tiles in the warrant tabs.
 *
 * Generalised from DataPilot's _hydrateVideoThumbnails/_captureVideoFrame.
 * A tile opts in with `data-vpt-src="<key>"`; the caller supplies
 * `getUrl(key, el)` returning a streamable URL (viper-media://…). Frames are
 * decoded with a detached <video> + <canvas> (≤360 px JPEG), two at a time,
 * only for tiles near the viewport. Results are cached by key, failures too
 * (codecs Chromium can't decode, e.g. some iPhone HEVC, keep the placeholder).
 *
 * Default apply: the JPEG is laid UNDER the tile's existing children
 * (z-index:-1 inside an isolated tile) so play icons stay on top; children
 * with class `vpt-hide` are hidden once a thumbnail exists. Pass `apply` to
 * do something else (e.g. set a <video> poster).
 *
 * Renderer UMD: `module` IS defined in the renderer → assign both.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VpVideoThumbs = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    const CACHE_MAX = 600;
    const FAILED = '';                 // cached failure marker
    const sharedCache = new Map();     // key → dataURL | FAILED
    const inflight = new Map();        // key → Promise<dataURL|null>
    const observers = new WeakMap();   // root → IntersectionObserver

    // Global decode limiter: video decode is heavy, and callers like the Meta
    // tab hydrate one slot at a time, so the cap must span every call.
    const GLOBAL_MAX = 2;
    let gActive = 0;
    const gWait = [];
    function withDecodeSlot(fn) {
        return new Promise((resolve, reject) => {
            const go = () => {
                gActive++;
                Promise.resolve().then(fn).then(resolve, reject).then(() => {
                    gActive--;
                    const next = gWait.shift();
                    if (next) next();
                });
            };
            if (gActive < GLOBAL_MAX) go(); else gWait.push(go);
        });
    }

    function cacheSet(cache, key, val) {
        cache.set(key, val);
        if (cache === sharedCache && cache.size > CACHE_MAX) {
            const first = cache.keys().next().value;
            cache.delete(first);
        }
    }

    function docOf(el) {
        return (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    }

    let styleDone = false;
    function ensureStyle(doc) {
        if (styleDone || !doc || !doc.head || typeof doc.createElement !== 'function') return;
        styleDone = true;
        const s = doc.createElement('style');
        s.setAttribute('data-vpt', '1');
        s.textContent =
            '.vpt-has-thumb{isolation:isolate}' +
            '.vpt-has-thumb>.vpt-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none;display:block}' +
            '.vpt-has-thumb>.vpt-hide{display:none!important}';
        doc.head.appendChild(s);
    }

    function defaultApply(el, dataUrl) {
        const doc = docOf(el);
        if (!doc) return;
        ensureStyle(doc);
        let img = null;
        for (const c of Array.from(el.children || [])) {
            if (c.classList && c.classList.contains('vpt-img')) { img = c; break; }
        }
        if (!img) {
            img = doc.createElement('img');
            img.className = 'vpt-img';
            img.alt = '';
            img.setAttribute('draggable', 'false');
            el.insertBefore(img, el.firstChild || null);
        }
        img.src = dataUrl;
        try {
            const view = doc.defaultView;
            if (view && view.getComputedStyle && view.getComputedStyle(el).position === 'static') {
                el.style.position = 'relative';
            }
        } catch (_) { /* ignore */ }
        el.classList.add('vpt-has-thumb');
    }

    /**
     * Decode one frame (at 0.1 s) into a small JPEG data URL, or null.
     */
    function captureFrame(videoUrl, opts) {
        const o = opts || {};
        const doc = o.doc || (typeof document !== 'undefined' ? document : null);
        const maxW = o.maxW || 360;
        const timeoutMs = o.timeoutMs || 8000;
        return new Promise((resolve) => {
            if (!doc || !videoUrl) return resolve(null);
            const video = doc.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            let settled = false;
            let timer = null;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                try { video.removeAttribute('src'); video.load(); } catch (_) { /* ignore */ }
                resolve(val || null);
            };
            timer = setTimeout(() => finish(null), timeoutMs);
            video.onloadedmetadata = () => {
                try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); }
                catch (_) { /* some codecs can't seek yet */ }
            };
            video.onseeked = () => {
                try {
                    const w = video.videoWidth, h = video.videoHeight;
                    if (!w || !h) return finish(null);
                    const scale = w > maxW ? maxW / w : 1;
                    const cw = Math.max(1, Math.floor(w * scale));
                    const ch = Math.max(1, Math.floor(h * scale));
                    const canvas = doc.createElement('canvas');
                    canvas.width = cw; canvas.height = ch;
                    canvas.getContext('2d').drawImage(video, 0, 0, cw, ch);
                    finish(canvas.toDataURL('image/jpeg', 0.7));
                } catch (_) {
                    finish(null);
                }
            };
            video.onerror = () => finish(null);
            video.src = videoUrl;
        });
    }

    /**
     * Fill every `[data-vpt-src]` tile under `root` with a frame thumbnail.
     * opts: { getUrl(key, el) → Promise<url|null> (required), apply(el, dataUrl),
     *         selector, cache (Map), concurrency, rootMargin, capture(url) }
     * Returns the number of tiles queued (cached tiles are applied at once).
     */
    function hydrate(root, opts) {
        const o = opts || {};
        if (!root || typeof root.querySelectorAll !== 'function' || typeof o.getUrl !== 'function') return 0;
        const selector = o.selector || '[data-vpt-src]';
        const cache = o.cache || sharedCache;
        const apply = o.apply || defaultApply;
        const capture = o.capture || captureFrame;
        const maxActive = Math.max(1, o.concurrency || 2);

        const prevIo = observers.get(root);
        if (prevIo) { try { prevIo.disconnect(); } catch (_) {} observers.delete(root); }

        const queue = [];
        for (const el of Array.from(root.querySelectorAll(selector))) {
            const key = el.getAttribute('data-vpt-src');
            if (!key || el.getAttribute('data-vpt-done')) continue;
            if (cache.has(key)) {
                el.setAttribute('data-vpt-done', '1');
                const v = cache.get(key);
                if (v) apply(el, v);
                continue;
            }
            queue.push(el);
        }
        if (!queue.length) return 0;

        let active = 0;
        const run = async (el) => {
            const key = el.getAttribute('data-vpt-src');
            if (!key || el.getAttribute('data-vpt-done')) return;
            el.setAttribute('data-vpt-done', '1');
            let p = inflight.get(key);
            if (!p) {
                p = (async () => {
                    let url = null;
                    try { url = await o.getUrl(key, el); } catch (_) { url = null; }
                    if (!url) return null;           // not cached: may succeed later
                    const data = await withDecodeSlot(() => capture(url));
                    cacheSet(cache, key, data || FAILED);
                    return data || null;
                })();
                inflight.set(key, p);
                p.then(() => inflight.delete(key), () => inflight.delete(key));
            }
            let data = null;
            try { data = await p; } catch (_) { data = null; }
            if (data && el.isConnected !== false) apply(el, data);
        };
        const pump = () => {
            while (active < maxActive && queue.length) {
                const el = queue.shift();
                if (el.isConnected === false) continue;
                active++;
                run(el).catch(() => {}).then(() => { active--; pump(); });
            }
        };

        const IO = (typeof IntersectionObserver !== 'undefined') ? IntersectionObserver : null;
        if (IO) {
            const pending = new Set(queue);
            queue.length = 0;
            const io = new IO((entries) => {
                for (const ent of entries) {
                    if (!ent.isIntersecting) continue;
                    io.unobserve(ent.target);
                    if (!pending.delete(ent.target)) continue;
                    queue.unshift(ent.target);       // visible tiles first
                }
                if (!pending.size) { try { io.disconnect(); } catch (_) {} if (observers.get(root) === io) observers.delete(root); }
                pump();
            }, { rootMargin: o.rootMargin || '600px 0px' });
            observers.set(root, io);
            for (const el of pending) io.observe(el);
            return pending.size;
        }
        const n = queue.length;
        pump();
        return n;
    }

    function _resetForTests() {
        sharedCache.clear(); inflight.clear(); styleDone = false; gActive = 0; gWait.length = 0;
    }

    return { hydrate, captureFrame, defaultApply, sharedCache, _resetForTests };
});
