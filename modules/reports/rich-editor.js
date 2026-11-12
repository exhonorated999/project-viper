/**
 * ViperRichEditor — the Word-like tools for the case report editor
 * (#reportEditor in case detail, #editor in report-popout.html).
 *
 *   toolbarHtml()            toolbar markup (wired by attach(); no inline handlers)
 *   attach({ editor, toolbar, onChange, toast })
 *                            paragraph styles, font size on the selection, bold/
 *                            italic/underline/strike, alignment, lists, indent,
 *                            tables (insert grid + row/column tools, Tab moves
 *                            between cells), pictures (insert, paste, drop; wrap
 *                            left/right, in line, top-and-bottom; drag any corner
 *                            to resize; size presets), page breaks, undo/redo.
 *   sanitize(html, doc)      allow-list cleaner for pasted HTML and for printing.
 *                            → { html, droppedImages }
 *   cleanHtml(editor)        editor HTML without editor-only selection marks.
 *   isRichReport(html)       true when the report has layout that plain text
 *                            rendering would lose (tables, pictures, alignment…).
 *
 * Everything the editor writes is inline style on the element (width as a % of
 * the column, float, margins), so the saved HTML prints the same way in the
 * report PDF and in Export to DA without this file's CSS.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ViperRichEditor = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const FONT_SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
    const FONT_TAG_PX = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
    const IMG_MAX_SIDE = 1600;
    const IMG_KEEP_BYTES = 600 * 1024;
    const CELL_STYLE = 'border:1px solid #888;padding:4px 6px;vertical-align:top;text-align:left';
    const TABLE_STYLE = 'width:100%;border-collapse:collapse;margin:6px 0';

    // ── Sanitizer (pure rules; the tree walk needs a DOM) ────────────────
    const KEEP_TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS',
        'SUB', 'SUP', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD',
        'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL', 'IMG', 'HR', 'BLOCKQUOTE',
        'PRE', 'CODE']);
    const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'NOSCRIPT',
        'TEMPLATE', 'SVG', 'MATH', 'LINK', 'META', 'TITLE', 'HEAD', 'XML', 'FORM', 'INPUT', 'BUTTON',
        'SELECT', 'TEXTAREA', 'OPTION', 'CANVAS', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'PICTURE', 'MAP',
        'AREA', 'BASE', 'APPLET', 'DIALOG', 'PORTAL']);
    const LEN = '-?\\d+(?:\\.\\d+)?(?:px|pt|em|rem|%|in|cm|mm|ex|ch)?';
    const reLen = new RegExp('^(?:' + LEN + '|auto)$', 'i');
    const reBox = new RegExp('^(?:(?:' + LEN + '|auto)\\s*){1,4}$', 'i');
    const reSize = /^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$|^(?:x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i;
    const reBorder = /^[a-z0-9#.,()%\s-]+$/i;
    const IMG_TABLE = ['IMG', 'TABLE', 'TD', 'TH', 'COL', 'CAPTION'];
    const STYLE_RULES = {
        'font-weight': { re: /^(?:bold|bolder|lighter|normal|[1-9]00)$/i },
        'font-style': { re: /^(?:italic|normal|oblique)$/i },
        'text-decoration': { re: /^(?:(?:underline|line-through|overline|none)\s*)+$/i },
        'text-decoration-line': { re: /^(?:(?:underline|line-through|overline|none)\s*)+$/i },
        'text-align': { re: /^(?:left|right|center|justify|start|end)$/i },
        'font-size': { re: reSize },
        'float': { re: /^(?:left|right|none)$/i, tags: ['IMG', 'TABLE'] },
        'clear': { re: /^(?:left|right|both|none)$/i },
        'width': { re: reLen, tags: IMG_TABLE },
        'max-width': { re: reLen, tags: IMG_TABLE },
        'min-width': { re: reLen, tags: ['TD', 'TH', 'COL'] },
        'height': { re: /^auto$/i, tags: ['IMG'] },
        'margin': { re: reBox },
        'margin-top': { re: reLen }, 'margin-right': { re: reLen }, 'margin-bottom': { re: reLen }, 'margin-left': { re: reLen },
        'padding': { re: reBox, tags: ['TD', 'TH', 'BLOCKQUOTE', 'TABLE'] },
        'padding-top': { re: reLen, tags: ['TD', 'TH'] }, 'padding-right': { re: reLen, tags: ['TD', 'TH'] },
        'padding-bottom': { re: reLen, tags: ['TD', 'TH'] }, 'padding-left': { re: reLen, tags: ['TD', 'TH', 'BLOCKQUOTE'] },
        'display': { re: /^(?:block|inline|inline-block)$/i, tags: ['IMG'] },
        'vertical-align': { re: /^(?:top|middle|bottom|baseline|text-top|text-bottom|sub|super)$/i },
        'border': { re: reBorder, tags: IMG_TABLE }, 'border-top': { re: reBorder, tags: IMG_TABLE },
        'border-right': { re: reBorder, tags: IMG_TABLE }, 'border-bottom': { re: reBorder, tags: IMG_TABLE },
        'border-left': { re: reBorder, tags: IMG_TABLE }, 'border-width': { re: reBorder, tags: IMG_TABLE },
        'border-style': { re: reBorder, tags: IMG_TABLE }, 'border-color': { re: reBorder, tags: IMG_TABLE },
        'border-collapse': { re: /^(?:collapse|separate)$/i, tags: ['TABLE'] },
        'page-break-before': { re: /^(?:always|auto|avoid)$/i }, 'page-break-after': { re: /^(?:always|auto|avoid)$/i },
        'break-before': { re: /^(?:page|auto|avoid)$/i }, 'break-after': { re: /^(?:page|auto|avoid)$/i },
        'list-style-type': { re: /^[a-z-]+$/i, tags: ['UL', 'OL', 'LI'] },
        'text-indent': { re: reLen },
        'white-space': { re: /^(?:normal|pre|pre-wrap|pre-line|nowrap)$/i },
    };
    const BAD_VALUE = /url\s*\(|expression|javascript:|vbscript:|[<>\\@{}]|behavior|-moz-binding/i;
    const WRAPS = ['inline', 'left', 'right', 'center'];
    const live = new Set();
    const IMG_SRC = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

    /** Keep only allow-listed declarations with harmless values. */
    function cleanStyle(style, tag) {
        const T = String(tag || '').toUpperCase();
        const out = [];
        String(style || '').split(';').forEach((decl) => {
            const k = decl.indexOf(':');
            if (k < 0) return;
            const prop = decl.slice(0, k).trim().toLowerCase();
            const val = decl.slice(k + 1).replace(/!important/i, '').trim();
            const rule = STYLE_RULES[prop];
            if (!rule || !val || val.length > 120 || BAD_VALUE.test(val)) return;
            if (rule.tags && rule.tags.indexOf(T) < 0) return;
            if (!rule.re.test(val)) return;
            out.push(prop + ':' + val);
        });
        return out.join(';');
    }

    function cleanAttrs(el, tag, stats) {
        const keep = {};
        const style = cleanStyle(el.getAttribute('style'), tag);
        if (style) keep.style = style;
        if (tag === 'TD' || tag === 'TH') {
            ['colspan', 'rowspan'].forEach((a) => {
                const v = parseInt(el.getAttribute(a), 10);
                if (v > 1 && v <= 50) keep[a] = String(v);
            });
        }
        if (tag === 'COL' || tag === 'COLGROUP') {
            const v = parseInt(el.getAttribute('span'), 10);
            if (v > 1 && v <= 50) keep.span = String(v);
        }
        if (tag === 'OL') {
            const s = parseInt(el.getAttribute('start'), 10);
            if (s > 1 && s < 100000) keep.start = String(s);
            const t = el.getAttribute('type');
            if (t && /^[1aAiI]$/.test(t)) keep.type = t;
        }
        if (tag === 'IMG') {
            const src = String(el.getAttribute('src') || '').trim();
            if (!IMG_SRC.test(src)) { stats.droppedImages++; return null; }
            keep.src = src;
            const alt = el.getAttribute('alt');
            if (alt) keep.alt = String(alt).slice(0, 200);
            const w = el.getAttribute('data-wrap');
            if (WRAPS.indexOf(w) >= 0) keep['data-wrap'] = w;
        }
        const cls = String(el.getAttribute('class') || '').split(/\s+/).filter((c) => /^vre-[a-z-]+$/.test(c));
        if (cls.length) keep.class = cls.join(' ');
        Array.from(el.attributes).map((a) => a.name).forEach((n) => el.removeAttribute(n));
        Object.keys(keep).forEach((n) => el.setAttribute(n, keep[n]));
        return el;
    }

    function unwrap(el) {
        const p = el.parentNode;
        while (el.firstChild) p.insertBefore(el.firstChild, el);
        p.removeChild(el);
    }

    function walkClean(node, stats, doc) {
        Array.from(node.childNodes).forEach((n) => {
            if (n.nodeType === 3) return;
            if (n.nodeType !== 1) { node.removeChild(n); return; }   // comments, PIs
            const tag = String(n.nodeName || '').toUpperCase();
            if (DROP_TAGS.has(tag) || tag.indexOf(':') > 0 && /^(?:V|W|M):/.test(tag)) {
                if (tag === 'IMG' || /^V:/.test(tag)) stats.droppedImages++;
                node.removeChild(n);
                return;
            }
            if (tag === 'FONT') {
                const span = doc.createElement('span');
                const px = FONT_TAG_PX[parseInt(n.getAttribute('size'), 10)];
                const st = cleanStyle(n.getAttribute('style'), 'SPAN');
                span.setAttribute('style', [st, px ? 'font-size:' + px + 'px' : ''].filter(Boolean).join(';'));
                if (!span.getAttribute('style')) span.removeAttribute('style');
                while (n.firstChild) span.appendChild(n.firstChild);
                node.replaceChild(span, n);
                walkClean(span, stats, doc);
                if (!span.attributes.length) unwrap(span);
                return;
            }
            if (!KEEP_TAGS.has(tag)) {           // A, o:p, unknown → keep the text
                walkClean(n, stats, doc);
                unwrap(n);
                return;
            }
            if (!cleanAttrs(n, tag, stats)) { node.removeChild(n); return; }
            walkClean(n, stats, doc);
            if (tag === 'SPAN' && !n.attributes.length) unwrap(n);
        });
    }

    /**
     * Allow-list clean of an HTML string. `doc` defaults to the page document;
     * parsing happens in an inert <template>, so nothing loads or runs.
     */
    function sanitize(html, doc) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d) throw new Error('sanitize needs a DOM document');
        const tpl = d.createElement('template');
        tpl.innerHTML = String(html == null ? '' : html);
        const stats = { droppedImages: 0 };
        walkClean(tpl.content, stats, d);
        const box = d.createElement('div');
        box.appendChild(tpl.content);
        return { html: box.innerHTML, droppedImages: stats.droppedImages };
    }

    /** Layout plain text rendering would lose. */
    function isRichReport(html) {
        const s = String(html || '');
        return /<(?:table|img|h[1-6]|ul|ol|hr|blockquote)\b/i.test(s)
            || /text-align\s*:\s*(?:center|right|justify)/i.test(s)
            || /font-size\s*:|<font\b[^>]*\bsize=/i.test(s)
            || /vre-pagebreak|page-break-after\s*:\s*always/i.test(s)
            || /margin-left\s*:\s*[1-9]/i.test(s);
    }

    function tableHtml(rows, cols, header) {
        const r = Math.max(1, Math.min(50, rows | 0)), c = Math.max(1, Math.min(20, cols | 0));
        const cell = (t) => '<' + t + ' style="' + CELL_STYLE + '"><br></' + t + '>';
        let h = '<table class="vre-table" data-vre-new="1" style="' + TABLE_STYLE + '"><tbody>';
        for (let i = 0; i < r; i++) {
            h += '<tr>';
            for (let j = 0; j < c; j++) h += cell(header && i === 0 ? 'th' : 'td');
            h += '</tr>';
        }
        return h + '</tbody></table><p><br></p>';
    }

    /** Inline style for a picture's wrap mode + width (% of its column). */
    function imgStyle(mode, widthPct) {
        const w = Math.max(5, Math.min(100, Math.round((+widthPct || 100) * 10) / 10));
        const base = 'width:' + w + '%;height:auto;max-width:100%;';
        switch (mode) {
            case 'left': return base + 'float:left;display:block;margin:4px 14px 8px 0';
            case 'right': return base + 'float:right;display:block;margin:4px 0 8px 14px';
            case 'inline': return base + 'float:none;display:inline-block;vertical-align:bottom;margin:4px 2px';
            default: return base + 'float:none;display:block;margin:8px auto';
        }
    }

    function wrapOf(img) {
        const w = img.getAttribute('data-wrap');
        if (WRAPS.indexOf(w) >= 0) return w;
        const f = (img.style && img.style.cssFloat) || '';
        return f === 'left' || f === 'right' ? f : 'center';
    }

    function cleanHtml(editor) {
        if (!editor) return '';
        const c = editor.cloneNode(true);
        c.querySelectorAll('.viper-img-selected,.vre-img-selected').forEach((el) => {
            el.classList.remove('viper-img-selected'); el.classList.remove('vre-img-selected');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        c.querySelectorAll('[data-vre-new]').forEach((el) => el.removeAttribute('data-vre-new'));
        return c.innerHTML;
    }

    // ── Toolbar markup ───────────────────────────────────────────────────
    const I = {
        undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
        redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
        alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
        alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
        alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
        alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
        ul: '<circle cx="5" cy="7" r="1.3"/><circle cx="5" cy="12" r="1.3"/><circle cx="5" cy="17" r="1.3"/><path d="M9 7h11M9 12h11M9 17h11"/>',
        ol: '<path d="M4 5h2v4M4 9h3M4 14.5c0-1 2.5-1 2.5.3 0 .9-2.5 1.7-2.5 2.7h2.7M10 7h10M10 12h10M10 17h10"/>',
        outdent: '<path d="M4 6h16M11 10h9M11 14h9M4 18h16M8 9l-4 3 4 3"/>',
        indent: '<path d="M4 6h16M11 10h9M11 14h9M4 18h16M4 9l4 3-4 3"/>',
        table: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 14.5h18M9 5v14M15 5v14"/>',
        image: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
        pagebreak: '<path d="M6 3v5h12V3M6 21v-5h12v5"/><path d="M3 12h3M9 12h2M13 12h2M18 12h3"/>',
        clear: '<path d="M6 5h12M12 5l-3 14M4 20l16-16"/>',
    };
    const svg = (k) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[k] + '</svg>';
    const btn = (cmd, title, inner, extra) => '<button type="button" class="vre-btn" data-re="' + cmd + '" title="' + title + '"' + (extra || '') + '>' + inner + '</button>';
    const sep = '<span class="vre-sep"></span>';

    function toolbarHtml() {
        const sizes = FONT_SIZES.map((s) => '<option value="' + s + '">' + s + '</option>').join('');
        return '<div class="vre-bar" data-vre-bar>'
            + btn('undo', 'Undo (Ctrl+Z)', svg('undo')) + btn('redo', 'Redo (Ctrl+Y)', svg('redo')) + sep
            + '<select class="vre-sel" data-re-select="block" title="Paragraph style">'
            + '<option value="p">Normal text</option><option value="h1">Heading 1</option>'
            + '<option value="h2">Heading 2</option><option value="h3">Heading 3</option></select>'
            + '<select class="vre-sel vre-size" data-re-select="size" title="Font size of the selected text">'
            + '<option value="">Size</option>' + sizes + '</select>' + sep
            + btn('bold', 'Bold (Ctrl+B)', '<b>B</b>', ' data-re-state="bold"')
            + btn('italic', 'Italic (Ctrl+I)', '<i style="font-family:Georgia,serif">I</i>', ' data-re-state="italic"')
            + btn('underline', 'Underline (Ctrl+U)', '<u>U</u>', ' data-re-state="underline"')
            + btn('strikeThrough', 'Strikethrough', '<s>S</s>', ' data-re-state="strikeThrough"') + sep
            + btn('justifyLeft', 'Align left', svg('alignLeft'), ' data-re-state="justifyLeft"')
            + btn('justifyCenter', 'Center', svg('alignCenter'), ' data-re-state="justifyCenter"')
            + btn('justifyRight', 'Align right', svg('alignRight'), ' data-re-state="justifyRight"')
            + btn('justifyFull', 'Justify', svg('alignJustify'), ' data-re-state="justifyFull"') + sep
            + btn('insertUnorderedList', 'Bulleted list', svg('ul'), ' data-re-state="insertUnorderedList"')
            + btn('insertOrderedList', 'Numbered list', svg('ol'), ' data-re-state="insertOrderedList"')
            + btn('outdent', 'Decrease indent', svg('outdent')) + btn('indent', 'Increase indent', svg('indent')) + sep
            + '<span class="vre-pop-wrap">' + btn('tablePicker', 'Insert table', svg('table') + '<span class="vre-lbl">Table</span>', ' data-re-wide="1"')
            + '<div class="vre-pop" data-vre-pop hidden><div class="vre-grid" data-vre-grid></div>'
            + '<div class="vre-pop-lbl" data-vre-grid-lbl>Insert table</div>'
            + '<label class="vre-pop-chk"><input type="checkbox" data-vre-hdr checked> Header row</label></div></span>'
            + btn('image', 'Insert picture', svg('image') + '<span class="vre-lbl">Picture</span>', ' data-re-wide="1"')
            + btn('pageBreak', 'Insert page break (PDF and Export to DA start a new page here)', svg('pagebreak'))
            + btn('removeFormat', 'Clear formatting', svg('clear'))
            + '<input type="file" data-vre-file accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden>'
            + '</div>'
            + '<div class="vre-ctx" data-vre-ctx="image" hidden><span class="vre-ctx-t">Picture</span>'
            + btn('wrap:inline', 'In line with text', 'In line', ' data-re-wrap="inline"')
            + btn('wrap:left', 'Picture on the left, text wraps on its right', 'Wrap left', ' data-re-wrap="left"')
            + btn('wrap:right', 'Picture on the right, text wraps on its left', 'Wrap right', ' data-re-wrap="right"')
            + btn('wrap:center', 'Centered on its own line, text above and below', 'Top &amp; bottom', ' data-re-wrap="center"') + sep
            + btn('size:25', 'A quarter of the column width', '25%') + btn('size:50', 'Half the column width', '50%')
            + btn('size:75', 'Three quarters of the column width', '75%') + btn('size:100', 'Full column width', '100%') + sep
            + btn('imgDelete', 'Remove picture', 'Remove', ' data-re-danger="1"')
            + '<span class="vre-ctx-hint">Drag a corner to resize</span></div>'
            + '<div class="vre-ctx" data-vre-ctx="table" hidden><span class="vre-ctx-t">Table</span>'
            + btn('row:above', 'Insert row above', 'Row above') + btn('row:below', 'Insert row below', 'Row below')
            + btn('col:left', 'Insert column left', 'Column left') + btn('col:right', 'Insert column right', 'Column right') + sep
            + btn('row:delete', 'Delete row', 'Delete row') + btn('col:delete', 'Delete column', 'Delete column') + sep
            + btn('table:header', 'Make the first row a header row (or a normal row)', 'Header row')
            + btn('table:delete', 'Delete table', 'Delete table', ' data-re-danger="1"')
            + '<span class="vre-ctx-hint">Tab moves to the next cell</span></div>';
    }

    const CSS = [
        '.vre-bar,.vre-ctx{display:flex;flex-wrap:wrap;align-items:center;gap:2px}',
        '.vre-ctx{padding:4px 0 0;margin-top:4px;border-top:1px solid rgba(148,163,184,.18)}',
        '.vre-ctx[hidden],.vre-pop[hidden]{display:none}',
        '.vre-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:30px;height:30px;padding:0 7px;border-radius:6px;border:1px solid transparent;background:transparent;color:#cbd5e1;font-size:13px;line-height:1;cursor:pointer}',
        '.vre-btn:hover{background:rgba(0,217,255,.14);color:#67e8f9}',
        '.vre-btn.vre-on{background:rgba(0,217,255,.2);border-color:rgba(0,217,255,.45);color:#67e8f9}',
        '.vre-btn[data-re-danger]:hover{background:rgba(248,113,113,.15);color:#fca5a5}',
        '.vre-ctx .vre-btn{font-size:12px;height:26px}',
        '.vre-lbl{font-size:12px}',
        '.vre-sep{width:1px;height:20px;background:rgba(148,163,184,.3);margin:0 5px}',
        '.vre-sel{height:30px;padding:0 6px;border-radius:6px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.35);color:#e5e7eb;font-size:12.5px;outline:none}',
        '.vre-sel:focus{border-color:#22d3ee}',
        '.vre-size{width:64px}',
        '.vre-ctx-t{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#67e8f9;margin:0 6px 0 2px}',
        '.vre-ctx-hint{font-size:11px;color:#94a3b8;margin-left:8px}',
        '.vre-pop-wrap{position:relative;display:inline-flex}',
        '.vre-pop{position:absolute;top:34px;left:0;z-index:10060;background:#0f172a;border:1px solid rgba(0,217,255,.4);border-radius:8px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.5)}',
        '.vre-grid{display:grid;grid-template-columns:repeat(10,16px);gap:3px}',
        '.vre-grid span{width:16px;height:16px;border:1px solid rgba(148,163,184,.45);border-radius:2px;cursor:pointer}',
        '.vre-grid span.vre-hot{background:rgba(0,217,255,.35);border-color:#22d3ee}',
        '.vre-pop-lbl{font-size:12px;color:#e5e7eb;margin-top:6px;text-align:center}',
        '.vre-pop-chk{display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;margin-top:6px;cursor:pointer}',
        '.vre-editor table{border-collapse:collapse}',
        '.vre-editor td,.vre-editor th{min-width:2.2em;vertical-align:top}',
        '.vre-editor th{font-weight:700}',
        '.vre-editor h1{font-size:1.75em;font-weight:700;line-height:1.25;margin:.5em 0 .3em}',
        '.vre-editor h2{font-size:1.4em;font-weight:700;line-height:1.3;margin:.5em 0 .3em}',
        '.vre-editor h3{font-size:1.17em;font-weight:700;line-height:1.35;margin:.45em 0 .25em}',
        '.vre-editor ul{list-style:disc;padding-left:1.7em;margin:.3em 0}',
        '.vre-editor ol{list-style:decimal;padding-left:1.7em;margin:.3em 0}',
        '.vre-editor ul ul{list-style:circle}',
        '.vre-editor blockquote{margin:0 0 0 40px}',
        '.vre-editor .vre-pagebreak{display:block;height:0;border-top:2px dashed #64748b;margin:18px 0;position:relative;clear:both}',
        '.vre-editor .vre-pagebreak::after{content:"Page break";position:absolute;left:50%;top:-9px;transform:translateX(-50%);font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:0 8px;background:#2a3441;color:#94a3b8}',
        '.vre-editor::after{content:"";display:block;clear:both}',
        '.vre-frame{position:fixed;pointer-events:none;border:2px solid #00d9ff;z-index:10050;box-shadow:0 0 0 3px rgba(0,217,255,.2)}',
        '.vre-h{position:fixed;width:12px;height:12px;background:#00d9ff;border:2px solid #0a0e14;border-radius:3px;z-index:10051}',
        '.vre-h[data-c=nw],.vre-h[data-c=se]{cursor:nwse-resize}.vre-h[data-c=ne],.vre-h[data-c=sw]{cursor:nesw-resize}',
        '.vre-badge{position:fixed;z-index:10052;background:#0a0e14;color:#67e8f9;font:600 11px/1 Arial,sans-serif;padding:4px 6px;border-radius:4px;border:1px solid rgba(0,217,255,.5);pointer-events:none}',
        'body.light-mode .vre-btn{color:#334155}body.light-mode .vre-sel{background:#fff;color:#0f172a}',
        'body.light-mode .vre-editor .vre-pagebreak::after{background:#fff}',
    ].join('\n');

    function injectCss(doc) {
        if (doc.getElementById('vre-style')) return;
        const st = doc.createElement('style');
        st.id = 'vre-style';
        st.textContent = CSS;
        (doc.head || doc.documentElement).appendChild(st);
    }

    // ── Pictures: read + downscale ───────────────────────────────────────
    function readDataUrl(file, win) {
        return new Promise((resolve, reject) => {
            const fr = new win.FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error || new Error('The picture could not be read.'));
            fr.readAsDataURL(file);
        });
    }
    function loadImage(src, win) {
        return new Promise((resolve, reject) => {
            const im = new win.Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('That file is not a picture VIPER can read.'));
            im.src = src;
        });
    }
    /** → { src, w, h } — large pictures are scaled to IMG_MAX_SIDE so the report stays small. */
    async function prepareImage(file, win, doc) {
        const raw = await readDataUrl(file, win);
        if (!IMG_SRC.test(raw.replace(/\s/g, ''))) throw new Error('That file is not a picture VIPER can read.');
        const im = await loadImage(raw, win);
        const w0 = im.naturalWidth || im.width, h0 = im.naturalHeight || im.height;
        const big = Math.max(w0, h0) > IMG_MAX_SIDE;
        if (!big && file.size <= IMG_KEEP_BYTES) return { src: raw, w: w0, h: h0 };
        const k = big ? IMG_MAX_SIDE / Math.max(w0, h0) : 1;
        const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        const cv = doc.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        const png = /png|gif|bmp/i.test(file.type || '');
        if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
        g.drawImage(im, 0, 0, w, h);
        const out = png ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
        return { src: out.length < raw.length ? out : raw, w, h };
    }

    // ── Editor wiring ────────────────────────────────────────────────────
    function attach(opts) {
        const editor = opts && opts.editor;
        const bar = opts && opts.toolbar;
        if (!editor || !bar) return null;
        if (editor._vre) return editor._vre;
        // The Reports tab re-renders its editor on every visit; retire the
        // controllers of editors that are gone.
        Array.from(live).forEach((c) => { if (!c.editor.isConnected) c.destroy(); });
        const doc = editor.ownerDocument, win = doc.defaultView;
        const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
        const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
        injectCss(doc);
        editor.classList.add('vre-editor');
        if (!bar.querySelector('[data-vre-bar]')) bar.insertAdjacentHTML('afterbegin', toolbarHtml());
        try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

        let savedRange = null;
        let pendingSize = 0;
        let selImg = null;
        let internalDrag = false;
        // Every listener goes through on(): destroy() aborts them all, so a
        // retired controller never keeps handling the editor or toolbar.
        const ac = new win.AbortController();
        const on = (t, ev, fn, capture) => t.addEventListener(ev, fn, { capture: !!capture, signal: ac.signal });
        const q = (s) => bar.querySelector(s);
        const ctxImg = q('[data-vre-ctx="image"]'), ctxTbl = q('[data-vre-ctx="table"]');
        const pop = q('[data-vre-pop]'), grid = q('[data-vre-grid]'), gridLbl = q('[data-vre-grid-lbl]');
        const fileIn = q('[data-vre-file]');

        const changed = () => {
            try { editor.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (_) {}
            try { onChange(); } catch (_) {}
        };
        const inEditor = (n) => !!n && (n === editor || editor.contains(n));
        function saveRange() {
            const s = win.getSelection();
            if (s && s.rangeCount && inEditor(s.getRangeAt(0).commonAncestorContainer)) savedRange = s.getRangeAt(0).cloneRange();
        }
        function restoreRange() {
            const s = win.getSelection();
            // The live selection, if it is in the editor, is the freshest
            // (selectionchange — and so savedRange — arrives asynchronously).
            const cur = s.rangeCount && inEditor(s.getRangeAt(0).commonAncestorContainer) ? s.getRangeAt(0).cloneRange() : null;
            if (cur) savedRange = cur;
            if (doc.activeElement !== editor) editor.focus({ preventScroll: true });
            if (savedRange && inEditor(savedRange.commonAncestorContainer)) { s.removeAllRanges(); s.addRange(savedRange); }
            else if (!(s.rangeCount && inEditor(s.getRangeAt(0).commonAncestorContainer))) {
                const r = doc.createRange(); r.selectNodeContents(editor); r.collapse(false);
                s.removeAllRanges(); s.addRange(r);
            }
        }
        function exec(cmd, val) {
            restoreRange();
            try { doc.execCommand(cmd, false, val == null ? null : val); } catch (_) {}
            saveRange();
            refresh();
        }
        function insertHtml(html) {
            restoreRange();
            const placeholder = editor.textContent.trim() === 'Start typing your report here...' && !editor.querySelector('img,table');
            if (placeholder) { editor.innerHTML = '<p><br></p>'; const r = doc.createRange(); r.setStart(editor.firstChild, 0); r.collapse(true); const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); }
            doc.execCommand('insertHTML', false, html);
            saveRange();
        }
        function caretIn(el, atEnd) {
            const r = doc.createRange(); r.selectNodeContents(el); r.collapse(!atEnd);
            const s = win.getSelection(); s.removeAllRanges(); s.addRange(r);
            savedRange = r.cloneRange();
        }

        // Font size on the selection: Chromium's fontSize command only knows
        // sizes 1–7, so size 7 is used as a marker and swapped for a real px.
        function convertFonts(px) {
            editor.querySelectorAll('font[size="7"]').forEach((f) => {
                const span = doc.createElement('span');
                span.style.fontSize = px + 'px';
                while (f.firstChild) span.appendChild(f.firstChild);
                f.parentNode.replaceChild(span, f);
                span.querySelectorAll('span').forEach((x) => { if (x.style.fontSize) { x.style.fontSize = ''; if (!x.getAttribute('style')) unwrap(x); } });
                const s = win.getSelection();
                if (s.rangeCount && !s.isCollapsed && inEditor(s.anchorNode)) { const r = doc.createRange(); r.selectNodeContents(span); s.removeAllRanges(); s.addRange(r); }
            });
        }
        function applySize(px) {
            if (!px) return;
            restoreRange();
            try { doc.execCommand('styleWithCSS', false, false); } catch (_) {}
            doc.execCommand('fontSize', false, '7');
            pendingSize = px;
            convertFonts(px);
            saveRange();
            changed();
        }

        // ── Tables ──
        function cellAt() {
            const s = win.getSelection();
            let n = s && s.rangeCount ? s.getRangeAt(0).startContainer : null;
            if (!inEditor(n) && savedRange) n = savedRange.startContainer;
            if (!inEditor(n)) return null;
            const el = n.nodeType === 1 ? n : n.parentElement;
            const c = el && el.closest('td,th');
            return c && inEditor(c) ? c : null;
        }
        const span = (c) => Math.max(1, parseInt(c.getAttribute('colspan'), 10) || 1);
        function colIndex(cell) {
            let i = 0;
            for (const c of Array.from(cell.parentElement.cells)) { if (c === cell) return i; i += span(c); }
            return i;
        }
        function cellAtCol(tr, col) {
            let i = 0;
            for (const c of Array.from(tr.cells)) { if (col < i + span(c)) return c; i += span(c); }
            return null;
        }
        function newCell(like, tag) {
            const c = doc.createElement(tag || (like ? like.tagName.toLowerCase() : 'td'));
            c.setAttribute('style', (like && like.getAttribute('style')) || CELL_STYLE);
            c.innerHTML = '<br>';
            return c;
        }
        function tableOp(op) {
            const cell = cellAt();
            if (!cell) return;
            const tr = cell.parentElement, table = cell.closest('table');
            const rows = Array.from(table.rows);
            const col = colIndex(cell);
            if (op === 'row:above' || op === 'row:below') {
                const nr = doc.createElement('tr');
                Array.from(tr.cells).forEach((c) => { const n = newCell(c, 'td'); if (span(c) > 1) n.setAttribute('colspan', String(span(c))); nr.appendChild(n); });
                tr.parentNode.insertBefore(nr, op === 'row:above' ? tr : tr.nextSibling);
                caretIn(nr.cells[Math.min(cell.cellIndex, nr.cells.length - 1)]);
            } else if (op === 'col:left' || op === 'col:right') {
                rows.forEach((r) => {
                    const ref = cellAtCol(r, col);
                    const n = newCell(ref || cell, ref ? ref.tagName.toLowerCase() : 'td');
                    if (!ref) r.appendChild(n);
                    else if (op === 'col:left') r.insertBefore(n, ref);
                    else r.insertBefore(n, ref.nextSibling);
                });
                caretIn(op === 'col:left' ? cell.previousElementSibling || cell : cell.nextElementSibling || cell);
            } else if (op === 'row:delete') {
                const next = tr.nextElementSibling || tr.previousElementSibling;
                tr.remove();
                if (!table.rows.length) return tableOp2Delete(table);
                if (next && next.cells.length) caretIn(next.cells[Math.min(cell.cellIndex, next.cells.length - 1)]);
            } else if (op === 'col:delete') {
                rows.forEach((r) => {
                    const c = cellAtCol(r, col);
                    if (!c) return;
                    if (span(c) > 1) c.setAttribute('colspan', String(span(c) - 1)); else c.remove();
                });
                Array.from(table.rows).forEach((r) => { if (!r.cells.length) r.remove(); });
                if (!table.rows.length) return tableOp2Delete(table);
                const r0 = tr.isConnected ? tr : table.rows[0];
                if (r0.cells.length) caretIn(r0.cells[Math.min(col, r0.cells.length - 1)]);
            } else if (op === 'table:header') {
                const first = table.rows[0];
                const toTh = Array.from(first.cells).some((c) => c.tagName === 'TD');
                Array.from(first.cells).forEach((c) => {
                    const n = doc.createElement(toTh ? 'th' : 'td');
                    Array.from(c.attributes).forEach((a) => n.setAttribute(a.name, a.value));
                    while (c.firstChild) n.appendChild(c.firstChild);
                    c.parentNode.replaceChild(n, c);
                });
                caretIn(first.cells[0], true);
            } else if (op === 'table:delete') {
                return tableOp2Delete(table);
            }
            changed(); refresh();
        }
        function tableOp2Delete(table) {
            const after = doc.createElement('p');
            after.innerHTML = '<br>';
            table.parentNode.replaceChild(after, table);
            caretIn(after);
            changed(); refresh();
        }
        function insertTable(r, c, header) {
            insertHtml(tableHtml(r, c, header));
            const t = editor.querySelector('table[data-vre-new]');
            if (t) { t.removeAttribute('data-vre-new'); if (t.rows[0] && t.rows[0].cells[0]) caretIn(t.rows[0].cells[0]); }
            changed(); refresh();
        }

        // ── Table picker ──
        const GR = 8, GC = 10;
        grid.innerHTML = Array.from({ length: GR * GC }, (_, i) => '<span data-r="' + (Math.floor(i / GC) + 1) + '" data-c="' + (i % GC + 1) + '"></span>').join('');
        function hot(r, c) {
            grid.querySelectorAll('span').forEach((s) => s.classList.toggle('vre-hot', +s.dataset.r <= r && +s.dataset.c <= c));
            gridLbl.textContent = r && c ? r + ' × ' + c + ' table' : 'Insert table';
        }
        on(grid, 'mouseover', (e) => { const s = e.target.closest('span[data-r]'); if (s) hot(+s.dataset.r, +s.dataset.c); });
        on(grid, 'mousedown', (e) => e.preventDefault());
        on(grid, 'click', (e) => {
            const s = e.target.closest('span[data-r]');
            if (!s) return;
            pop.hidden = true;
            insertTable(+s.dataset.r, +s.dataset.c, !!q('[data-vre-hdr]').checked);
        });
        const closePop = (e) => { if (!pop.hidden && !(e && pop.parentElement.contains(e.target))) pop.hidden = true; };
        on(doc, 'mousedown', closePop, true);

        // ── Picture selection, wrap, resize ──
        const frame = doc.createElement('div'); frame.className = 'vre-frame'; frame.hidden = true;
        const badge = doc.createElement('div'); badge.className = 'vre-badge'; badge.hidden = true;
        const handles = ['nw', 'ne', 'sw', 'se'].map((c) => { const h = doc.createElement('div'); h.className = 'vre-h'; h.dataset.c = c; h.hidden = true; return h; });
        [frame, badge].concat(handles).forEach((n) => doc.body.appendChild(n));
        let raf = 0, drag = null;
        function columnWidth(img) {
            const near = img !== editor && img.parentElement ? img.parentElement.closest('td,th,li,blockquote') : null;
            const host = near && inEditor(near) ? near : editor;
            const cs = win.getComputedStyle(host);
            return Math.max(40, host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
        }
        function place() {
            raf = 0;
            if (!selImg) return;
            if (!selImg.isConnected || !inEditor(selImg) || !editor.offsetParent) { deselect(); return; }
            const r = selImg.getBoundingClientRect();
            Object.assign(frame.style, { left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 'px', height: r.height + 'px' });
            const pos = { nw: [r.left, r.top], ne: [r.right, r.top], sw: [r.left, r.bottom], se: [r.right, r.bottom] };
            handles.forEach((h) => { const p = pos[h.dataset.c]; h.style.left = p[0] - 6 + 'px'; h.style.top = p[1] - 6 + 'px'; });
            if (drag) Object.assign(badge.style, { left: r.left + 6 + 'px', top: r.top + 6 + 'px' });
            raf = win.requestAnimationFrame(place);
        }
        function select(img) {
            selImg = img;
            frame.hidden = false; handles.forEach((h) => { h.hidden = false; });
            const s = win.getSelection(), r = doc.createRange();
            try { r.selectNode(img); s.removeAllRanges(); s.addRange(r); savedRange = r.cloneRange(); } catch (_) {}
            if (!raf) raf = win.requestAnimationFrame(place);
            refresh();
        }
        function deselect() {
            selImg = null; drag = null;
            frame.hidden = true; badge.hidden = true; handles.forEach((h) => { h.hidden = true; });
            if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
            refresh();
        }
        function widthPct(img) {
            const m = /([\d.]+)%/.exec(img.style.width || '');
            if (m) return +m[1];
            return Math.min(100, Math.round(img.getBoundingClientRect().width / columnWidth(img) * 1000) / 10);
        }
        function setWrap(img, mode) {
            img.setAttribute('data-wrap', mode);
            img.setAttribute('style', imgStyle(mode, widthPct(img)));
            changed(); refresh();
        }
        function setSize(img, pct) {
            img.setAttribute('style', imgStyle(wrapOf(img), pct));
            if (!img.getAttribute('data-wrap')) img.setAttribute('data-wrap', wrapOf(img));
            changed();
        }
        handles.forEach((h) => on(h, 'mousedown', (e) => {
            if (!selImg) return;
            e.preventDefault(); e.stopPropagation();
            const r = selImg.getBoundingClientRect();
            drag = { dir: /w/.test(h.dataset.c) ? -1 : 1, x: e.clientX, w: r.width, col: columnWidth(selImg) };
            badge.hidden = false;
            doc.body.style.userSelect = 'none';
        }));
        const onMove = (e) => {
            if (!drag || !selImg) return;
            const w = Math.max(24, Math.min(drag.col, drag.w + drag.dir * (e.clientX - drag.x)));
            const pct = Math.max(5, Math.min(100, Math.round(w / drag.col * 1000) / 10));
            selImg.style.width = pct + '%';
            selImg.style.height = 'auto';
            badge.textContent = Math.round(pct) + '% of column';
        };
        const onUp = () => {
            if (!drag) return;
            drag = null; badge.hidden = true; doc.body.style.userSelect = '';
            if (selImg) { if (!selImg.getAttribute('data-wrap')) selImg.setAttribute('data-wrap', wrapOf(selImg)); setSize(selImg, widthPct(selImg)); }
        };
        on(win, 'mousemove', onMove);
        on(win, 'mouseup', onUp);

        async function insertFiles(files) {
            const list = Array.from(files || []).filter((f) => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || ''));
            if (!list.length) return 0;
            let n = 0;
            for (const f of list) {
                try {
                    const im = await prepareImage(f, win, doc);
                    const pct = Math.min(100, Math.max(10, Math.round(im.w / Math.max(1, columnWidth(editor)) * 100)));
                    insertHtml('<img src="' + im.src + '" data-wrap="center" data-vre-new="1" style="' + imgStyle('center', pct) + '">');
                    const el = editor.querySelector('img[data-vre-new]');
                    if (el) { el.removeAttribute('data-vre-new'); const r = doc.createRange(); r.setStartAfter(el); r.collapse(true); const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); saveRange(); }
                    n++;
                } catch (e) {
                    toast((f.name ? f.name + ': ' : '') + ((e && e.message) || 'The picture could not be added.'), 'error');
                }
            }
            if (n) changed();
            return n;
        }

        // ── Toolbar events ──
        on(bar, 'mousedown', (e) => {
            const b = e.target.closest('.vre-btn');
            if (b && bar.contains(b)) e.preventDefault();   // keep the text selection
        });
        on(bar, 'click', (e) => {
            const b = e.target.closest('.vre-btn');
            if (!b || !bar.contains(b)) return;
            const cmd = b.getAttribute('data-re');
            if (cmd === 'tablePicker') { pop.hidden = !pop.hidden; hot(0, 0); return; }
            if (cmd === 'image') { saveRange(); fileIn.click(); return; }
            if (cmd === 'pageBreak') { insertHtml('<div class="vre-pagebreak" style="page-break-after:always;break-after:page"></div><p><br></p>'); changed(); return; }
            if (/^wrap:/.test(cmd)) { if (selImg) setWrap(selImg, cmd.slice(5)); return; }
            if (/^size:/.test(cmd)) { if (selImg) { setSize(selImg, +cmd.slice(5)); refresh(); } return; }
            if (cmd === 'imgDelete') { if (selImg) { const im = selImg; deselect(); im.remove(); changed(); } return; }
            if (/^(row|col|table):/.test(cmd)) { tableOp(cmd); return; }
            exec(cmd);
            changed();
        });
        on(bar, 'change', (e) => {
            const s = e.target.closest('[data-re-select]');
            if (!s) return;
            if (s.dataset.reSelect === 'block') { exec('formatBlock', '<' + s.value + '>'); changed(); }
            if (s.dataset.reSelect === 'size') { applySize(+s.value); refresh(); }
        });
        on(fileIn, 'change', async () => { const f = Array.from(fileIn.files || []); fileIn.value = ''; await insertFiles(f); });

        // ── Toolbar state ──
        let refreshQueued = false;
        function refresh() {
            if (refreshQueued) return;
            refreshQueued = true;
            win.requestAnimationFrame(() => { refreshQueued = false; refreshNow(); });
        }
        function refreshNow() {
            const s = win.getSelection();
            const inside = s && s.rangeCount && inEditor(s.getRangeAt(0).commonAncestorContainer);
            bar.querySelectorAll('[data-re-state]').forEach((b) => {
                let on = false;
                if (inside) { try { on = doc.queryCommandState(b.getAttribute('data-re-state')); } catch (_) {} }
                b.classList.toggle('vre-on', !!on);
            });
            if (inside) {
                let blk = '';
                try { blk = String(doc.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (_) {}
                const bs = q('[data-re-select="block"]');
                if (doc.activeElement !== bs) bs.value = /^h[1-3]$/.test(blk) ? blk : 'p';
                const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
                const ss = q('[data-re-select="size"]');
                if (n && doc.activeElement !== ss) {
                    const px = Math.round(parseFloat(win.getComputedStyle(n).fontSize) || 0);
                    ss.value = FONT_SIZES.indexOf(px) >= 0 ? String(px) : '';
                }
            }
            ctxImg.hidden = !selImg;
            if (selImg) {
                const w = wrapOf(selImg);
                ctxImg.querySelectorAll('[data-re-wrap]').forEach((b) => b.classList.toggle('vre-on', b.getAttribute('data-re-wrap') === w));
            }
            ctxTbl.hidden = !!selImg || !cellAt();
        }

        // ── Editor events ──
        const onSel = () => { saveRange(); refresh(); };
        on(doc, 'selectionchange', onSel);
        on(editor, 'click', (e) => {
            const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
            if (img && inEditor(img)) { e.preventDefault(); select(img); } else if (selImg) deselect();
        });
        on(editor, 'input', () => {
            if (pendingSize && editor.querySelector('font[size="7"]')) convertFonts(pendingSize);
            if (selImg && !selImg.isConnected) deselect();
        });
        on(editor, 'keydown', (e) => {
            if (selImg && (e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault(); e.stopImmediatePropagation();
                const im = selImg; const r = doc.createRange(); r.setStartBefore(im); r.collapse(true);
                deselect(); im.remove();
                const s = win.getSelection(); s.removeAllRanges(); s.addRange(r);
                changed(); return;
            }
            if (selImg && e.key === 'Escape') { deselect(); return; }
            if (selImg && !e.ctrlKey && !e.metaKey && e.key.length === 1) deselect();
            if (e.key === 'Tab') {
                const cell = cellAt();
                if (!cell) return;
                e.preventDefault();
                const table = cell.closest('table');
                const cells = Array.from(table.querySelectorAll('td,th')).filter((c) => c.closest('table') === table);
                const i = cells.indexOf(cell);
                if (e.shiftKey) { if (i > 0) caretIn(cells[i - 1], true); return; }
                if (i < cells.length - 1) { caretIn(cells[i + 1], true); return; }
                tableOp('row:below');
            }
        }, true);
        on(editor, 'paste', (e) => {
            const cd = e.clipboardData;
            if (!cd) return;
            let html = '';
            try { html = cd.getData('text/html') || ''; } catch (_) {}
            const imgs = Array.from(cd.items || []).filter((it) => it.kind === 'file' && /^image\//i.test(it.type || '')).map((it) => it.getAsFile()).filter(Boolean);
            if (html && /<[a-z]/i.test(html)) {
                e.preventDefault(); e.stopImmediatePropagation();
                const r = sanitize(html, doc);
                const body = r.html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
                if (body.trim()) insertHtml(body);
                else if (imgs.length) { insertFiles(imgs); return; }
                if (r.droppedImages) toast('Pictures in the pasted text could not come across. Use Picture on the toolbar to add them.', 'info');
                changed();
                return;
            }
            if (imgs.length) {
                e.preventDefault(); e.stopImmediatePropagation();
                insertFiles(imgs);
            }
        }, true);
        on(editor, 'dragstart', () => { internalDrag = true; });
        on(editor, 'dragend', () => { internalDrag = false; });
        const hasFiles = (dt) => !!dt && Array.from(dt.types || []).indexOf('Files') >= 0;
        on(editor, 'dragover', (e) => {
            if (!hasFiles(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = internalDrag ? 'move' : 'copy';
        });
        on(editor, 'drop', (e) => {
            if (internalDrag) { internalDrag = false; e.stopPropagation(); if (selImg) deselect(); return; }
            if (!hasFiles(e.dataTransfer)) return;
            const files = Array.from(e.dataTransfer.files || []);
            const pics = files.filter((f) => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || ''));
            e.preventDefault(); e.stopPropagation();
            if (!pics.length) { toast('Only pictures can be dropped into the report.', 'warning'); return; }
            let r = null;
            try { r = doc.caretRangeFromPoint(e.clientX, e.clientY); } catch (_) {}
            if (r && inEditor(r.startContainer)) { savedRange = r; const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); }
            insertFiles(pics);
        });

        const ctl = {
            exec, insertTable, insertFiles, select, deselect, setWrap, setSize, tableOp, applySize, refresh,
            get selectedImage() { return selImg; },
            editor,
            destroy() {
                deselect();
                ac.abort();
                [frame, badge].concat(handles).forEach((n) => n.remove());
                editor.classList.remove('vre-editor');
                delete editor._vre;
                live.delete(ctl);
            },
        };
        editor._vre = ctl;
        live.add(ctl);
        refresh();
        return ctl;
    }

    return { FONT_SIZES, attach, toolbarHtml, sanitize, cleanStyle, cleanHtml, isRichReport, tableHtml, imgStyle, wrapOf, prepareImage, CSS };
});
