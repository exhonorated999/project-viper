/**
 * ViperDrop — drag-and-drop and paste (Ctrl+V) for every upload in VIPER.
 *
 * Field request (Nov 2026): "drag and drop a photo in the Personal
 * Information tab instead of having to save and import — I often snip photos
 * and paste them in". So, everywhere a file can be chosen:
 *
 *   1. Any <input type="file"> works as a drop target with no per-page code.
 *      Dropping on the input, or on the nearest card / form section that holds
 *      exactly ONE file input, hands the files to that input (accept= is
 *      respected) and fires its normal `change` handler — the same code path
 *      as choosing the file in the dialog.
 *   2. Pasting an image (Snipping Tool, "Copy image") goes to the image upload
 *      under the mouse, else the one around the focused field, else the one
 *      last clicked. A text field with text on the clipboard pastes normally.
 *   3. Pages can declare their own zones for uploads that are not a file
 *      input (photo frames in view mode, the Evidence picker):
 *          <div data-vdrop="inlinePhoto" ...>      + ViperDrop.define('inlinePhoto', spec)
 *      spec = { accept, multiple, paste (default true), folders, onFiles(files, zone, meta) }
 *      meta = { source: 'drop'|'paste', items: [{ file, path, isDir }] }
 *      data-vdrop="off" switches a subtree off. data-vdrop-boundary stops the
 *      search for "the nearest section".
 *   4. A file dropped anywhere else no longer navigates the window away to
 *      the file (Chromium's default), which used to throw away unsaved work.
 *
 * Handlers that already own a drop (note editors, DMV import, index drop
 * zones) run first and win: anything that called preventDefault is left
 * alone.
 *
 * Renderer UMD: `module` IS defined in the renderer, so assign both
 * module.exports and root.ViperDrop; only install listeners where a document
 * exists.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) {
        root.ViperDrop = api;
        if (root.document && !root.__viperDropInstalled) {
            root.__viperDropInstalled = true;
            api.install(root, root.document);
        }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';

    const specs = Object.create(null);
    const ARM_MS = 5 * 60 * 1000;
    const MAX_WALK = 40;

    // ── pure helpers ─────────────────────────────────────────────────────

    function parseAccept(accept) {
        return String(accept || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    // Does a file ({name, type}) satisfy an accept= string? A file with no
    // name (dragover: only the MIME type is known) and an empty type is
    // "maybe" → true, so the drop is allowed and checked again on drop.
    function acceptOk(accept, file) {
        const toks = parseAccept(accept);
        if (!toks.length) return true;
        const name = String((file && file.name) || '').toLowerCase();
        const type = String((file && file.type) || '').toLowerCase();
        if (!name && !type) return true;
        for (const t of toks) {
            if (t.charAt(0) === '.') {
                if (name && name.endsWith(t)) return true;
                // During dragover only the MIME type is known. Unknown
                // extensions → allow (checked again on drop by name).
                if (!name && type) { const m = _extMime(t); if (!m.length || m.indexOf(type) >= 0) return true; }
            } else if (t.endsWith('/*')) {
                if (type && type.startsWith(t.slice(0, -1))) return true;
                if (!type && name && t === 'image/*' && /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|jfif)$/.test(name)) return true;
            } else if (type === t) {
                return true;
            }
        }
        return false;
    }

    // Windows reports these MIME types while dragging (e.g. .csv is
    // application/vnd.ms-excel when Excel is installed).
    const EXT_MIME = {
        '.pdf': ['application/pdf'], '.png': ['image/png'], '.jpg': ['image/jpeg', 'image/pjpeg'], '.jpeg': ['image/jpeg', 'image/pjpeg'],
        '.gif': ['image/gif'], '.webp': ['image/webp'], '.bmp': ['image/bmp'],
        '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv'],
        '.tsv': ['text/tab-separated-values', 'text/plain'], '.txt': ['text/plain'],
        '.html': ['text/html'], '.htm': ['text/html'],
        '.zip': ['application/zip', 'application/x-zip-compressed', 'application/x-zip'],
        '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        '.xlsm': ['application/vnd.ms-excel.sheet.macroenabled.12', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
        '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        '.doc': ['application/msword'],
        '.eml': ['message/rfc822'], '.msg': ['application/vnd.ms-outlook'],
    };
    function _extMime(ext) { return EXT_MIME[ext] || []; }

    // During dragover only the MIME types are visible. True when at least one
    // dragged file could fit.
    function typesOk(accept, types) {
        const list = Array.isArray(types) ? types : [];
        if (!list.length) return true;
        return list.some(t => acceptOk(accept, { name: '', type: t }));
    }

    function acceptsImages(accept) {
        const toks = parseAccept(accept);
        if (!toks.length) return true;
        return toks.some(t => t === 'image/*' || t.startsWith('image/') || /^\.(png|jpe?g|gif|webp|bmp)$/.test(t));
    }

    // Split files into the ones this target takes and the rest.
    function pick(accept, multiple, files) {
        const ok = [], rejected = [];
        for (const f of (files || [])) (acceptOk(accept, f) ? ok : rejected).push(f);
        return { ok: multiple ? ok : ok.slice(0, 1), rejected, extra: multiple ? 0 : Math.max(0, ok.length - 1) };
    }

    function _pad(n) { return String(n).padStart(2, '0'); }
    const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tif' };
    // Clipboard images arrive as "image.png"; give them a dated name so an
    // upload list can tell two pastes apart.
    function pastedName(type, date) {
        const d = date instanceof Date ? date : new Date();
        const ext = MIME_EXT[String(type || '').toLowerCase()] || 'png';
        return `pasted-image-${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}_${_pad(d.getHours())}-${_pad(d.getMinutes())}-${_pad(d.getSeconds())}.${ext}`;
    }

    function describeAccept(accept) {
        const toks = parseAccept(accept);
        if (!toks.length) return 'any file';
        if (toks.every(t => t.startsWith('image/') || /^\.(png|jpe?g|gif|webp|bmp)$/.test(t))) return 'an image';
        return toks.map(t => t.endsWith('/*') ? t.slice(0, -2) + ' files' : t.replace(/^\./, '').toUpperCase()).join(', ');
    }

    // ── DOM resolution (only parentElement / getAttribute / tagName /
    // classList / querySelectorAll are used, so tests can fake it) ──────────

    function _attr(el, n) { try { return el && el.getAttribute ? el.getAttribute(n) : null; } catch (_) { return null; } }
    function _tag(el) { return String((el && el.tagName) || '').toUpperCase(); }
    function _hasClass(el, c) { try { return !!(el && el.classList && el.classList.contains(c)); } catch (_) { return false; } }
    function _isFileInput(el) {
        return _tag(el) === 'INPUT' && String(el.type || _attr(el, 'type') || '').toLowerCase() === 'file' && !el.disabled;
    }
    function _offOrInside(el, stop) {
        for (let n = el; n && n !== stop; n = n.parentElement) if (_attr(n, 'data-vdrop') === 'off') return true;
        return false;
    }
    function _isBoundary(el) {
        const t = _tag(el);
        if (t === 'FORM' || t === 'DIALOG' || t === 'FIELDSET') return true;
        if (_hasClass(el, 'glass-card')) return true;
        if (_attr(el, 'role') === 'dialog' || _attr(el, 'data-vdrop-boundary') != null) return true;
        const p = el.parentElement;
        return !!(p && _tag(p) === 'BODY');
    }

    /**
     * Find the drop target for a point in the page.
     *   start : element under the pointer (or the focused element)
     *   want  : { types: [mime…], paste: bool }
     * Returns { kind:'spec', zone, name, spec } | { kind:'input', zone, input }
     *       | { kind:'reject', zone, accept } (a target exists but takes none
     *         of these files) | null.
     */
    function resolve(start, want) {
        const w = want || {};
        const types = w.types || [];
        let el = start && start.nodeType === 3 ? start.parentElement : start;
        if (_offOrInside(el, null)) return null;
        for (let depth = 0; el && depth < MAX_WALK; depth++, el = el.parentElement) {
            const t = _tag(el);
            if (t === 'BODY' || t === 'HTML') return null;
            const mark = _attr(el, 'data-vdrop');
            if (mark === 'off') return null;
            if (mark && specs[mark]) {
                const spec = specs[mark];
                if (w.paste && spec.paste === false) return null;
                if (!typesOk(spec.accept, types)) return { kind: 'reject', zone: el, accept: spec.accept || '' };
                return { kind: 'spec', zone: el, name: mark, spec };
            }
            let inputs = [];
            if (_isFileInput(el)) inputs = [el];
            else if (el.querySelectorAll) {
                try { inputs = Array.from(el.querySelectorAll('input[type="file"]')).filter(i => _isFileInput(i) && !_offOrInside(i, el)); }
                catch (_) { inputs = []; }
            }
            if (inputs.length) {
                const fit = inputs.filter(i => typesOk(i.accept || _attr(i, 'accept'), types));
                if (fit.length === 1) return { kind: 'input', zone: _isFileInput(el) ? (el.parentElement || el) : el, input: fit[0] };
                if (!fit.length && inputs.length === 1) return { kind: 'reject', zone: el, accept: inputs[0].accept || _attr(inputs[0], 'accept') || '' };
                return null; // ambiguous: several uploads in one section
            }
            if (_isBoundary(el)) return null;
        }
        return null;
    }

    function define(name, spec) {
        if (!name || !spec || typeof spec.onFiles !== 'function') throw new Error('ViperDrop.define(name, {onFiles})');
        specs[name] = Object.assign({ accept: '', multiple: false, paste: true, folders: false }, spec);
        return specs[name];
    }

    // ── browser wiring ───────────────────────────────────────────────────

    function install(win, doc) {
        let lastHover = null;
        let armed = null;          // { zoneEl, at }
        let hiEl = null, hiBad = false, hiTimer = null;
        let cacheTarget = null, cacheTypes = '', cacheRes = null;

        const style = doc.createElement('style');
        style.id = 'viper-drop-style';
        style.textContent = [
            '.vdrop-over{outline:2px dashed #22d3ee !important;outline-offset:2px;background-color:rgba(34,211,238,.07) !important;border-radius:8px}',
            '.vdrop-bad{outline:2px dashed #f87171 !important;outline-offset:2px}',
            '.vdrop-flash{animation:vdropFlash .9s ease-out}',
            '@keyframes vdropFlash{0%{box-shadow:0 0 0 3px rgba(34,211,238,.85)}100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}}',
            '[data-vdrop-hint]{position:relative}',
            '[data-vdrop-hint]:hover::after{content:attr(data-vdrop-hint);position:absolute;left:0;right:0;bottom:0;padding:5px 6px;font-size:11px;line-height:1.3;',
            'background:rgba(2,6,23,.82);color:#a5f3fc;text-align:center;pointer-events:none;z-index:2}',
        ].join('\n');
        (doc.head || doc.documentElement).appendChild(style);

        const toast = (msg, type) => {
            try {
                if (typeof win.viperToast === 'function') return win.viperToast(msg, type || 'info');
                if (typeof win.showToast === 'function') return win.showToast(msg, type || 'info');
            } catch (_) { /* toast is best effort */ }
        };

        const hasFiles = (dt) => {
            if (!dt) return false;
            const types = Array.from(dt.types || []);
            if (types.indexOf('Files') >= 0) return true;
            return Array.from(dt.items || []).some(it => it.kind === 'file');
        };
        const dragTypes = (dt) => Array.from((dt && dt.items) || []).filter(it => it.kind === 'file').map(it => it.type || '');

        const unhighlight = () => {
            if (hiEl) { hiEl.classList.remove('vdrop-over'); hiEl.classList.remove('vdrop-bad'); }
            hiEl = null;
        };
        const highlight = (el, bad) => {
            if (hiEl === el && hiBad === bad) return;
            unhighlight();
            if (!el || !el.classList) return;
            hiEl = el; hiBad = bad;
            el.classList.add(bad ? 'vdrop-bad' : 'vdrop-over');
        };
        const flash = (el) => {
            if (!el || !el.classList) return;
            el.classList.remove('vdrop-flash');
            void el.offsetWidth;
            el.classList.add('vdrop-flash');
            setTimeout(() => { try { el.classList.remove('vdrop-flash'); } catch (_) {} }, 1000);
        };

        const pathOf = (file) => {
            try {
                const api = win.electronAPI;
                if (api && typeof api.getPathForFile === 'function') return api.getPathForFile(file) || file.path || '';
            } catch (_) { /* fall through */ }
            return (file && file.path) || '';
        };

        // Hand files to a resolved target. Returns true when used.
        const deliver = (res, files, meta) => {
            if (!res || !files || !files.length) return false;
            if (res.kind === 'reject') {
                toast(`That file can't go here — this upload takes ${describeAccept(res.accept)}.`, 'warning');
                return true;
            }
            if (res.kind === 'spec') {
                const spec = res.spec;
                const items = (meta && meta.items) || files.map(f => ({ file: f, path: pathOf(f), isDir: false }));
                const dirs = items.filter(i => i.isDir);
                const plain = items.filter(i => !i.isDir);
                const p = pick(spec.accept, spec.multiple, plain.map(i => i.file));
                if (!p.ok.length && !(spec.folders && dirs.length)) {
                    toast(`That file can't go here — this upload takes ${describeAccept(spec.accept)}.`, 'warning');
                    return true;
                }
                if (dirs.length && !spec.folders) {
                    toast('Folders cannot be dropped here — drop the files themselves.', 'warning');
                    if (!p.ok.length) return true;
                }
                const keep = new Set(p.ok);
                const useItems = items.filter(i => (i.isDir && spec.folders) || keep.has(i.file));
                flash(res.zone);
                try {
                    const out = spec.onFiles(p.ok, res.zone, { source: (meta && meta.source) || 'drop', items: useItems });
                    if (out && typeof out.catch === 'function') out.catch(e => toast('Could not add the file: ' + (e && e.message || e), 'error'));
                } catch (e) { toast('Could not add the file: ' + (e && e.message || e), 'error'); }
                if (p.rejected.length) toast(`${p.rejected.length} file${p.rejected.length === 1 ? ' was' : 's were'} skipped (wrong type).`, 'warning');
                return true;
            }
            const input = res.input;
            const accept = input.accept || _attr(input, 'accept') || '';
            const p = pick(accept, !!input.multiple, files);
            if (!p.ok.length) {
                toast(`That file can't go here — this upload takes ${describeAccept(accept)}.`, 'warning');
                return true;
            }
            try {
                const dt = new win.DataTransfer();
                p.ok.forEach(f => dt.items.add(f));
                input.files = dt.files;
            } catch (e) {
                toast('Could not attach the file: ' + (e && e.message || e), 'error');
                return true;
            }
            flash(res.zone);
            input.dispatchEvent(new win.Event('change', { bubbles: true }));
            if (p.extra) toast('Only one file is used here — the first one was taken.', 'info');
            else if (p.rejected.length) toast(`${p.rejected.length} file${p.rejected.length === 1 ? ' was' : 's were'} skipped (wrong type).`, 'warning');
            return true;
        };

        // ── drag & drop ──
        const resolveDrag = (e) => {
            const types = dragTypes(e.dataTransfer);
            const key = types.join('|');
            if (e.target === cacheTarget && key === cacheTypes) return cacheRes;
            cacheTarget = e.target; cacheTypes = key;
            cacheRes = resolve(e.target, { types });
            return cacheRes;
        };

        doc.addEventListener('dragover', (e) => {
            if (!hasFiles(e.dataTransfer)) return;
            if (e.defaultPrevented) { unhighlight(); return; }
            const res = resolveDrag(e);
            clearTimeout(hiTimer);
            hiTimer = setTimeout(unhighlight, 180);
            // A target that takes none of these files is left unclaimed, so a
            // page-wide handler (e.g. the DMV PDF import) can still take it;
            // if nobody does, the window guard below shows "not allowed".
            if (!res || res.kind === 'reject') { unhighlight(); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            highlight(res.zone, false);
        });

        doc.addEventListener('drop', (e) => {
            if (!hasFiles(e.dataTransfer)) return;
            unhighlight();
            if (e.defaultPrevented) return;
            const res = resolve(e.target, { types: dragTypes(e.dataTransfer) });
            cacheTarget = null;
            if (!res || res.kind === 'reject') return;
            // Read entries synchronously: DataTransfer is emptied after the
            // event returns.
            const items = [];
            Array.from(e.dataTransfer.items || []).forEach(it => {
                if (it.kind !== 'file') return;
                const f = it.getAsFile();
                if (!f) return;
                let isDir = false;
                try { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); isDir = !!(en && en.isDirectory); } catch (_) {}
                items.push({ file: f, path: pathOf(f), isDir });
            });
            const files = items.length ? items.map(i => i.file) : Array.from(e.dataTransfer.files || []);
            e.preventDefault();
            e.stopPropagation();
            if (res.kind === 'input') {
                const dirs = items.filter(i => i.isDir).length;
                const plain = items.filter(i => !i.isDir).map(i => i.file);
                if (dirs && !plain.length) { toast('Folders cannot be dropped here — drop the files themselves.', 'warning'); return; }
                deliver(res, plain.length ? plain : files, { source: 'drop' });
                return;
            }
            deliver(res, files, { source: 'drop', items });
        });

        // Last line: a file dropped where nothing takes it must not navigate
        // the window to that file. Window listeners run after every element
        // and document handler, so this only acts on unclaimed drags.
        win.addEventListener('dragover', (e) => {
            if (!hasFiles(e.dataTransfer) || e.defaultPrevented) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
        });
        win.addEventListener('drop', (e) => {
            if (!hasFiles(e.dataTransfer)) return;
            unhighlight();
            if (!e.defaultPrevented) e.preventDefault();
        });
        win.addEventListener('dragleave', (e) => { if (!e.relatedTarget) unhighlight(); });
        win.addEventListener('dragend', unhighlight);

        // ── paste ──
        doc.addEventListener('mousemove', (e) => { lastHover = e.target; }, { passive: true, capture: true });
        doc.addEventListener('mouseout', (e) => { if (!e.relatedTarget) lastHover = null; }, true);
        doc.addEventListener('pointerdown', (e) => {
            const res = resolve(e.target, { types: ['image/png'], paste: true });
            armed = res && res.kind !== 'reject' ? { zone: res.zone, at: Date.now() } : null;
        }, true);

        const isTextField = (el) => {
            if (!el) return false;
            if (_tag(el) === 'TEXTAREA') return true;
            if (_tag(el) !== 'INPUT') return false;
            const t = String(el.type || 'text').toLowerCase();
            return ['text', 'search', 'url', 'email', 'tel', 'password', 'number', ''].indexOf(t) >= 0;
        };

        doc.addEventListener('paste', (e) => {
            if (e.defaultPrevented) return;
            const cd = e.clipboardData;
            if (!cd) return;
            const imgs = [];
            Array.from(cd.items || []).forEach(it => {
                if (it.kind === 'file' && /^image\//i.test(it.type || '')) {
                    const f = it.getAsFile();
                    if (f) imgs.push(f);
                }
            });
            if (!imgs.length) return;
            const ae = doc.activeElement;
            if (ae && ae.isContentEditable) return; // rich editors handle their own paste
            const textual = isTextField(ae);
            let text = '';
            try { text = String(cd.getData('text/plain') || '').trim(); } catch (_) {}
            if (textual && text) return;

            const want = { types: imgs.map(f => f.type), paste: true };
            const ok = (r) => r && r.kind !== 'reject' ? r : null;
            let res = null;
            if (lastHover && lastHover.isConnected !== false) res = ok(resolve(lastHover, want));
            if (!res && ae && ae !== doc.body) res = ok(resolve(ae, want));
            if (!res && armed && Date.now() - armed.at < ARM_MS && armed.zone.isConnected !== false) res = ok(resolve(armed.zone, want));
            if (!res) return;

            const now = new Date();
            const files = imgs.map((f, i) => {
                const name = (!f.name || /^image\.\w+$/i.test(f.name))
                    ? pastedName(f.type, i ? new Date(now.getTime() + i * 1000) : now) : f.name;
                try { return new win.File([f], name, { type: f.type || 'image/png', lastModified: now.getTime() }); }
                catch (_) { return f; }
            });
            e.preventDefault();
            deliver(res, files, { source: 'paste' });
        });

        api._deliver = deliver; // test hook
    }

    const api = {
        define, resolve, install,
        acceptOk, typesOk, acceptsImages, pick, pastedName, describeAccept, parseAccept,
        _specs: specs,
    };
    return api;
});
