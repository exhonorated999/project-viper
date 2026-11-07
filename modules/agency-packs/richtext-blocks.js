/*
 * modules/agency-packs/richtext-blocks.js
 *
 * Converts between the Builder's rich-text editor (an HTML fragment) and the
 * content blocks the docx form engine writes into a rich-text content control:
 *
 *   { type: 'paragraph' | 'bullet' | 'number', runs: [run] }
 *   { type: 'table', rows: [[{ runs: [run] }]] }
 *   run: { text, bold?, italic?, underline? } | { break: true } | { image: 'data:image/png;base64,...' }
 *
 * Only what Word needs survives: bold / italic / underline, lists, tables, line
 * breaks and PNG/JPEG pictures. Everything else pasted in (Word styles, fonts,
 * colours, links, scripts) is dropped. Works on any DOM-like tree (browser DOM
 * or @xmldom/xmldom), so it is unit-tested in Node.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperRichBlocks = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const IMAGE_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/i;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'TITLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
    const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ADDRESS', 'BODY', 'HTML', 'DL', 'DT', 'DD', 'CENTER']);

    const tagOf = (n) => String((n && (n.localName || n.nodeName)) || '').toUpperCase();
    const kids = (n) => {
        const c = n && n.childNodes;
        if (!c) return [];
        const out = [];
        for (let i = 0; i < c.length; i++) out.push(c[i]);
        return out;
    };
    const attr = (n, name) => (n && typeof n.getAttribute === 'function' ? (n.getAttribute(name) || '') : '');
    // Collapse source whitespace the way the browser renders it; typed double spaces are
    // non-breaking spaces in an editor, so they survive as spaces.
    const normWs = (v) => String(v == null ? '' : v).replace(/[ \t\r\n]+/g, ' ').replace(/\u00a0/g, ' ');

    function styleFmt(n, fmt) {
        const out = Object.assign({}, fmt);
        const t = tagOf(n);
        if (t === 'B' || t === 'STRONG') out.bold = true;
        if (t === 'I' || t === 'EM') out.italic = true;
        if (t === 'U' || t === 'INS') out.underline = true;
        if (/^H[1-6]$/.test(t)) out.bold = true;
        const st = attr(n, 'style').toLowerCase();
        if (st) {
            const fw = /font-weight\s*:\s*([a-z0-9]+)/.exec(st);
            if (fw) out.bold = fw[1] === 'bold' || fw[1] === 'bolder' || (/^\d+$/.test(fw[1]) && Number(fw[1]) >= 600);
            const fs = /font-style\s*:\s*([a-z]+)/.exec(st);
            if (fs) out.italic = fs[1] === 'italic' || fs[1] === 'oblique';
            const td = /text-decoration(?:-line)?\s*:\s*([^;]+)/.exec(st);
            if (td) out.underline = /underline/.test(td[1]);
        }
        return out;
    }

    function makeRun(text, fmt) {
        const r = { text };
        if (fmt.bold) r.bold = true;
        if (fmt.italic) r.italic = true;
        if (fmt.underline) r.underline = true;
        return r;
    }
    const sameFmt = (a, b) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline;

    function pushText(runs, text, fmt) {
        if (!text) return;
        const last = runs[runs.length - 1];
        if (last && typeof last.text === 'string' && !last.image && !last.break && sameFmt(last, fmt)) last.text += text;
        else runs.push(makeRun(text, fmt));
    }

    function trimRuns(runs) {
        while (runs.length && runs[runs.length - 1].break) runs.pop();
        while (runs.length && runs[0].break) runs.shift();
        // Collapse whitespace at the paragraph edges the way a browser renders it.
        if (runs.length && typeof runs[0].text === 'string') { runs[0].text = runs[0].text.replace(/^ +/, ''); if (!runs[0].text) runs.shift(); }
        const l = runs[runs.length - 1];
        if (l && typeof l.text === 'string') { l.text = l.text.replace(/ +$/, ''); if (!l.text) runs.pop(); }
        return runs;
    }

    // Inline content of a node, flattened into runs (used for table cells).
    function inlineRuns(node, fmt, runs) {
        kids(node).forEach(c => {
            if (c.nodeType === 3) { pushText(runs, normWs(c.nodeValue), fmt); return; }
            if (c.nodeType !== 1) return;
            const t = tagOf(c);
            if (SKIP.has(t)) return;
            if (t === 'BR') { runs.push({ break: true }); return; }
            if (t === 'IMG') { const s = attr(c, 'src'); if (IMAGE_RE.test(s)) runs.push({ image: s.replace(/\s+/g, '') }); return; }
            const before = runs.length;
            inlineRuns(c, styleFmt(c, fmt), runs);
            if ((BLOCK.has(t) || t === 'LI') && runs.length > before) runs.push({ break: true });
        });
        return runs;
    }

    function tableRows(table) {
        const rows = [];
        const visit = (n) => kids(n).forEach(c => {
            if (c.nodeType !== 1) return;
            const t = tagOf(c);
            if (t === 'TR') {
                const cells = kids(c).filter(x => x.nodeType === 1 && (tagOf(x) === 'TD' || tagOf(x) === 'TH'))
                    .map(x => ({ runs: trimRuns(inlineRuns(x, tagOf(x) === 'TH' ? { bold: true } : {}, [])) }));
                if (cells.length) rows.push(cells);
            } else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') visit(c);
        });
        visit(table);
        return rows;
    }

    /** DOM node (editor root / pasted fragment) → blocks. */
    function fromNode(rootNode) {
        const blocks = [];
        let cur = null;
        const open = (type) => { cur = { type, runs: [] }; blocks.push(cur); return cur; };
        const close = () => { if (cur) trimRuns(cur.runs); cur = null; };
        const ensure = (type) => cur || open(type || 'paragraph');

        function walk(node, fmt, list) {
            kids(node).forEach(c => {
                if (c.nodeType === 3) {
                    const text = normWs(c.nodeValue);
                    if (!cur && !text.trim()) return;      // whitespace between blocks
                    pushText(ensure(list).runs, text, fmt);
                    return;
                }
                if (c.nodeType !== 1) return;
                const t = tagOf(c);
                if (SKIP.has(t)) return;
                if (t === 'BR') { ensure(list).runs.push({ break: true }); return; }
                if (t === 'IMG') {
                    const s = attr(c, 'src');
                    if (IMAGE_RE.test(s)) ensure(list).runs.push({ image: s.replace(/\s+/g, '') });
                    return;
                }
                if (t === 'TABLE') {
                    close();
                    const rows = tableRows(c);
                    if (rows.length) blocks.push({ type: 'table', rows });
                    return;
                }
                if (t === 'UL' || t === 'OL') {
                    close();
                    walk(c, fmt, t === 'OL' ? 'number' : 'bullet');
                    close();
                    return;
                }
                if (t === 'LI') {
                    close();
                    open(list || 'bullet');
                    walkInline(c, styleFmt(c, fmt));
                    close();
                    return;
                }
                if (BLOCK.has(t)) {
                    close();
                    const before = blocks.length;
                    walk(c, styleFmt(c, fmt), null);
                    // An empty <div><br></div> / <p></p> is a deliberate blank line.
                    if (blocks.length === before) blocks.push({ type: 'paragraph', runs: [] });
                    close();
                    return;
                }
                walk(c, styleFmt(c, fmt), list);
            });
        }
        // Inside a list item, nested paragraphs become line breaks (one item = one block).
        function walkInline(node, fmt) {
            const runs = inlineRuns(node, fmt, []);
            cur.runs.push(...runs);
        }

        walk(rootNode, {}, null);
        close();
        // A trailing blank paragraph is an editor artefact, not content.
        while (blocks.length && blocks[blocks.length - 1].type !== 'table' && !blocks[blocks.length - 1].runs.length) blocks.pop();
        return blocks;
    }

    function fromText(text) {
        return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
            .map(s => s.trim()).filter(Boolean)
            .map(s => ({ type: 'paragraph', runs: [{ text: s }] }));
    }

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function runsHtml(runs) {
        return (runs || []).map(r => {
            if (!r || typeof r !== 'object') return '';
            if (r.break) return '<br>';
            if (r.image) return IMAGE_RE.test(r.image) ? `<img src="${esc(r.image)}" style="max-width:100%">` : '';
            let h = esc(r.text);
            if (r.underline) h = `<u>${h}</u>`;
            if (r.italic) h = `<i>${h}</i>`;
            if (r.bold) h = `<b>${h}</b>`;
            return h;
        }).join('');
    }

    /** blocks → editor HTML (escaped; only pictures that are PNG/JPEG data URLs). */
    function toHtml(blocks) {
        if (typeof blocks === 'string') blocks = fromText(blocks);
        if (!Array.isArray(blocks)) return '';
        let html = '', list = null;
        const endList = () => { if (list) { html += list === 'number' ? '</ol>' : '</ul>'; list = null; } };
        blocks.forEach(b => {
            if (!b || typeof b !== 'object') return;
            const type = b.type || 'paragraph';
            if (type === 'bullet' || type === 'number') {
                if (list !== type) { endList(); html += type === 'number' ? '<ol>' : '<ul>'; list = type; }
                html += `<li>${runsHtml(b.runs) || '<br>'}</li>`;
                return;
            }
            endList();
            if (type === 'table') {
                html += '<table>' + (b.rows || []).map(row => '<tr>' + (row || []).map(cell => `<td>${runsHtml(cell && cell.runs) || '<br>'}</td>`).join('') + '</tr>').join('') + '</table>';
                return;
            }
            html += `<p>${runsHtml(b.runs) || '<br>'}</p>`;
        });
        endList();
        return html;
    }

    /** Plain text of blocks (word counts, "is it empty?"). */
    function toText(blocks) {
        if (typeof blocks === 'string') return blocks;
        if (!Array.isArray(blocks)) return '';
        const runsText = (runs) => (runs || []).map(r => (r && r.break ? '\n' : (r && typeof r.text === 'string' ? r.text : ''))).join('');
        return blocks.map(b => (b && b.type === 'table'
            ? (b.rows || []).map(row => (row || []).map(c => runsText(c && c.runs)).join('\t')).join('\n')
            : runsText(b && b.runs))).join('\n').trim();
    }

    const hasContent = (blocks) => !!toText(blocks).trim()
        || (Array.isArray(blocks) && blocks.some(b => b && (b.runs || []).some(r => r && r.image)));

    return { fromNode, fromText, toHtml, toText, hasContent, IMAGE_RE };
});
