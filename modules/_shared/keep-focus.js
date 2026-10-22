/**
 * VpKeepFocus — keep a search box focused across an innerHTML re-render.
 *
 * Several warrant tabs re-render the whole section on every keystroke. The
 * <input> the officer is typing in is part of that HTML, so the old element
 * is destroyed and focus is lost after one character. Wrap the re-render:
 *
 *     const snap = VpKeepFocus.capture(container);
 *     container.innerHTML = ...;
 *     VpKeepFocus.restore(container, snap);
 *
 * or VpKeepFocus.around(container, () => { container.innerHTML = ...; }).
 *
 * Only <input>/<textarea> elements with an id (or data-focus-key) inside the
 * container are tracked. Renderer UMD: `module` IS defined in the renderer,
 * so assign both module.exports and root.VpKeepFocus.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VpKeepFocus = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    function docOf(container, doc) {
        if (doc) return doc;
        if (container && container.ownerDocument) return container.ownerDocument;
        return (typeof document !== 'undefined') ? document : null;
    }

    function attrEsc(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function capture(container, doc) {
        const d = docOf(container, doc);
        const a = d && d.activeElement;
        if (!a || !container || a === container) return null;
        if (typeof container.contains === 'function' && !container.contains(a)) return null;
        const tag = String(a.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') return null;
        const id = a.id || '';
        const fk = (!id && typeof a.getAttribute === 'function') ? (a.getAttribute('data-focus-key') || '') : '';
        if (!id && !fk) return null;
        let s = null, e = null, dir = 'none';
        try {
            s = a.selectionStart; e = a.selectionEnd;
            dir = a.selectionDirection || 'none';
        } catch (_) { /* input types without selection */ }
        return { id, fk, s, e, dir };
    }

    function restore(container, snap, doc) {
        if (!snap || !container) return false;
        const d = docOf(container, doc);
        let el = null;
        if (snap.id && d && typeof d.getElementById === 'function') el = d.getElementById(snap.id);
        else if (snap.fk && typeof container.querySelector === 'function') {
            el = container.querySelector('[data-focus-key="' + attrEsc(snap.fk) + '"]');
        }
        if (!el || typeof el.focus !== 'function') return false;
        if (typeof container.contains === 'function' && !container.contains(el)) return false;
        try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
        if (snap.s != null && snap.e != null && typeof el.setSelectionRange === 'function') {
            const len = String(el.value == null ? '' : el.value).length;
            try { el.setSelectionRange(Math.min(snap.s, len), Math.min(snap.e, len), snap.dir); } catch (_) { /* ignore */ }
        }
        return true;
    }

    function around(container, fn, doc) {
        const snap = capture(container, doc);
        const out = fn();
        restore(container, snap, doc);
        return out;
    }

    return { capture, restore, around };
});
