/**
 * Clickable web links inside Case Notes.
 *
 * An officer keeps case material in Google Drive and OneDrive and wants to
 * paste a link to a folder or a file into a note, then click it and land in
 * that folder — signed in, able to edit — without leaving VIPER. The window
 * itself lives in the main process (modules/_shared/link-browser.js); this
 * file is the note side of it:
 *
 *   linkifyHtml(html)  — at DISPLAY time, turns bare web addresses in a
 *       note into links and rewrites every <a> already in the note (pasted
 *       from a web page or Word) into one safe shape. Display only: the
 *       stored note is not changed, so old notes get working links too and
 *       nothing about saving, exporting or the DA report moves.
 *   pasteAsLink(e)     — pasting a bare address into the note editor drops
 *       in a link straight away, so the officer sees it took.
 *   installClickHandler — a click on a link in a saved note (or Ctrl+click
 *       while editing) opens it in the VIPER browser window.
 *
 * Only http:// and https:// ever become a link. A `javascript:`, `file:`
 * or `data:` address pasted from somewhere else is shown as plain text.
 *
 * UMD: the renderer loads it with a <script> tag, the main process and the
 * tests require() it. VIPER's renderer DEFINES `module`, so both exports
 * are always assigned.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.NoteLinks = api;
    // A page that loads this file gets working links with no further wiring.
    // Plain Node (the tests, the main process) has no document and skips it.
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        api.installClickHandler(document, api.openInViper);
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    var MAX_URL_LENGTH = 4096;

    // Accept a web address the way an officer would paste it. Returns the
    // canonical href, or null for anything that is not plainly http(s).
    function normalizeWebUrl(raw) {
        if (typeof raw !== 'string') return null;
        var s = raw.trim();
        if (!s || s.length > MAX_URL_LENGTH) return null;
        if (/^www\./i.test(s)) s = 'https://' + s;
        if (!/^https?:\/\//i.test(s)) return null;
        var u;
        try { u = new URL(s); } catch (_) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!u.hostname) return null;
        return u.href;
    }

    var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    function decodeEntities(s) {
        return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, body) {
            if (body[0] === '#') {
                var cp = body[1] === 'x' || body[1] === 'X'
                    ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
                if (!isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
                try { return String.fromCodePoint(cp); } catch (_) { return m; }
            }
            var k = body.toLowerCase();
            return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
        });
    }
    function escapeText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(s) {
        return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Sentence punctuation after an address belongs to the sentence:
    // "see https://drive.google.com/x." must not link the full stop. A
    // closing bracket is kept only when the address opened one itself —
    // "(https://en.wikipedia.org/wiki/A_(b))" keeps one, drops the other.
    function trimUrlTail(u) {
        var s = u;
        for (;;) {
            var c = s.charAt(s.length - 1);
            if (!c) return s;
            if ('.,;:!?\'"*'.indexOf(c) !== -1) { s = s.slice(0, -1); continue; }
            var pairs = { ')': '(', ']': '[', '}': '{' };
            if (pairs[c]) {
                var opens = s.split(pairs[c]).length - 1;
                var closes = s.split(c).length - 1;
                if (closes > opens) { s = s.slice(0, -1); continue; }
            }
            return s;
        }
    }

    var URL_RE = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'`\u00a0\u200b]+/gi;

    // Every linkable address in a run of plain (decoded) text.
    function findUrls(text) {
        var out = [];
        var s = String(text == null ? '' : text);
        URL_RE.lastIndex = 0;
        var m;
        while ((m = URL_RE.exec(s)) !== null) {
            var raw = trimUrlTail(m[0]);
            var href = normalizeWebUrl(raw);
            if (href) {
                out.push({ start: m.index, end: m.index + raw.length, text: raw, href: href });
            }
        }
        return out;
    }

    function anchorOpen(href) {
        // target=_blank is the fallback, not the route: the click handler
        // below always gets there first. If it ever did not, a plain link
        // would navigate the case page itself away and lose the open form;
        // _blank sends it to the main window's popup handler instead.
        return '<a href="' + escapeAttr(href) + '" class="viper-note-link" data-viper-link="1"' +
            ' target="_blank" rel="noopener noreferrer"' +
            ' title="' + escapeAttr('Open in the VIPER browser: ' + href) + '">';
    }

    // One text segment of note HTML (still entity-escaped as stored).
    function linkifyTextSegment(seg) {
        if (!seg || !/https?:\/\/|www\./i.test(seg)) return seg;
        var decoded = decodeEntities(seg);
        var hits = findUrls(decoded);
        if (!hits.length) return seg;
        var out = '';
        var at = 0;
        for (var i = 0; i < hits.length; i++) {
            var h = hits[i];
            out += escapeText(decoded.slice(at, h.start));
            out += anchorOpen(h.href) + escapeText(h.text) + '</a>';
            at = h.end;
        }
        return out + escapeText(decoded.slice(at));
    }

    function hrefOf(tag) {
        var m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
        if (!m) return null;
        return decodeEntities(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
    }

    // A tag, honouring quoted attribute values that contain '>'.
    var TOKEN_RE = /<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    var RAW_TEXT = { script: 1, style: 1, textarea: 1, title: 1 };

    function linkifyHtml(html) {
        var src = String(html == null ? '' : html);
        if (!src) return src;
        var out = '';
        var last = 0;
        var stack = [];          // what each open <a> was rewritten to: 'a' | 'span'
        var raw = null;          // inside <style>/<script>/...: no linking
        var m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(src)) !== null) {
            var text = src.slice(last, m.index);
            out += (stack.length || raw) ? text : linkifyTextSegment(text);
            last = m.index + m[0].length;
            var tag = m[0];
            if (tag.slice(0, 4) === '<!--') { out += tag; continue; }
            var t = /^<\s*(\/)?\s*([a-zA-Z][\w:-]*)/.exec(tag);
            if (!t) { out += tag; continue; }
            var closing = !!t[1];
            var name = t[2].toLowerCase();
            if (raw) {
                if (closing && name === raw) raw = null;
                out += tag;
                continue;
            }
            if (name === 'a') {
                if (closing) {
                    if (stack.length) out += '</' + stack.pop() + '>';
                    // a stray </a> with nothing open is dropped
                } else {
                    var href = normalizeWebUrl(hrefOf(tag) || '');
                    if (href) { out += anchorOpen(href); stack.push('a'); }
                    else { out += '<span class="viper-note-link-dead">'; stack.push('span'); }
                }
                continue;
            }
            if (!closing && RAW_TEXT[name]) raw = name;
            out += tag;
        }
        var tail = src.slice(last);
        out += (stack.length || raw) ? tail : linkifyTextSegment(tail);
        while (stack.length) out += '</' + stack.pop() + '>';
        return out;
    }

    // Paste handler for a note editor. Returns true when it handled the
    // paste. Only a single bare address is turned into a link here —
    // pasted text with words in it, pictures, and rich HTML all take the
    // editor's normal path (and still display as links once saved).
    function pasteAsLink(e, doc) {
        var cd = e && e.clipboardData;
        if (!cd || !doc || typeof doc.execCommand !== 'function') return false;
        var items = cd.items || [];
        for (var i = 0; i < items.length; i++) {
            if (items[i] && String(items[i].type || '').indexOf('image') !== -1) return false;
        }
        var text = String(cd.getData('text/plain') || '').trim();
        if (!text || /\s/.test(text)) return false;
        var href = normalizeWebUrl(text);
        if (!href) return false;
        e.preventDefault();
        doc.execCommand('insertHTML', false, anchorOpen(href) + escapeText(text) + '</a>&nbsp;');
        return true;
    }

    function _toast(win, msg) {
        var w = win || (typeof window !== 'undefined' ? window : null);
        if (!w) return;
        if (typeof w.viperToast === 'function') { w.viperToast(msg, 'error'); return; }
        if (typeof w.showToast === 'function') { w.showToast(msg, 'error'); return; }
        try { console.warn('[NoteLinks] ' + msg); } catch (_) {}
    }

    // Default opener: the VIPER browser window, or the system browser if
    // this page somehow has no bridge to it.
    function openInViper(url, win) {
        var w = win || (typeof window !== 'undefined' ? window : null);
        var href = normalizeWebUrl(url);
        if (!href || !w) return Promise.resolve(false);
        var api = w.electronAPI;
        if (api && typeof api.openWebLink === 'function') {
            return Promise.resolve(api.openWebLink(href)).then(function (r) {
                if (r && r.success) return true;
                _toast(w, 'Could not open that link' + (r && r.error ? ': ' + r.error : '.'));
                return false;
            }, function (err) {
                _toast(w, 'Could not open that link: ' + (err && err.message ? err.message : err));
                return false;
            });
        }
        if (api && typeof api.openExternalUrl === 'function') return Promise.resolve(api.openExternalUrl(href));
        return Promise.resolve(false);
    }

    function _closest(el, sel) {
        while (el && el.nodeType !== 1) el = el.parentNode;
        return el && typeof el.closest === 'function' ? el.closest(sel) : null;
    }

    // Saved notes (.note-rendered): a plain click opens the link.
    // Note editors (contenteditable): a plain click places the caret like
    // any word processor; Ctrl+click opens.
    function installClickHandler(doc, opener) {
        if (!doc || doc.__viperNoteLinksInstalled) return false;
        doc.__viperNoteLinksInstalled = true;
        var open = typeof opener === 'function' ? opener : openInViper;
        function handle(e) {
            if (e.type === 'auxclick' && e.button !== 1) return;
            var a = _closest(e.target, 'a[href]');
            if (!a) return;
            var inNote = _closest(a, '.note-rendered');
            var inEditor = _closest(a, '[contenteditable="true"], [contenteditable=""]');
            if (!inNote && !inEditor) return;
            e.preventDefault();
            if (inEditor && !inNote && !(e.ctrlKey || e.metaKey)) return;
            e.stopPropagation();
            var href = normalizeWebUrl(a.getAttribute('href') || '');
            if (href) open(href);
        }
        doc.addEventListener('click', handle, true);
        doc.addEventListener('auxclick', handle, true);
        return true;
    }

    return {
        normalizeWebUrl: normalizeWebUrl,
        decodeEntities: decodeEntities,
        trimUrlTail: trimUrlTail,
        findUrls: findUrls,
        linkifyHtml: linkifyHtml,
        pasteAsLink: pasteAsLink,
        openInViper: openInViper,
        installClickHandler: installClickHandler,
        _anchorOpen: anchorOpen
    };
});
