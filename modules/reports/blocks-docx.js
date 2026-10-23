'use strict';
/**
 * Report blocks → editable Word document (.docx). MAIN PROCESS ONLY.
 *
 * A tab describes its report once as plain JSON "blocks" (first user:
 * BtReport.reportBlocks() in modules/bittorrent/bt-report.js, which also
 * renders the same blocks to HTML for the PDF). This file lays them out
 * with the `docx` package so the Word version matches the PDF and the
 * officer can edit it. The result is saved as a Reports-tab Word report
 * (IPC 'report-doc-from-blocks' in electron-main.js).
 *
 *   run   : string | { t, s: 'mono'|'ref'|'warn'|'sub'|'i' } | { br: true }
 *   block : { k:'title', text } | { k:'sub', runs } | { k:'notice', text } | { k:'h2', text }
 *         | { k:'p', runs, style?: 'sub'|'warn' } | { k:'kv', rows:[{ label, runs }] }
 *         | { k:'table', head:[text], widths:[fraction], nowrap:[col], rows:[[runs]] }
 *         | { k:'file', title, lines:[{ style?, runs }], desc } | { k:'ul', items:[text] } | { k:'end', text }
 *
 * Text only — there is no image block, by design. The blocks come from the
 * renderer, so everything is treated as untrusted text: coerced to string,
 * stripped of characters XML cannot hold, and size-capped.
 */

const PAGE_W = 12240, PAGE_H = 15840;           // Letter, twips
const MARGIN = 864, BOTTOM = 1080;              // 0.6 in, 0.75 in (same as the PDF)
const CONTENT_W = PAGE_W - 2 * MARGIN;          // 10512
const FONT = 'Calibri', MONO = 'Consolas';
const SZ = 21, SMALL = 19, TINY = 17;           // half-points: 10.5 / 9.5 / 8.5 pt
const MAX_BLOCKS = 20000;
const MAX_TEXT = 4 * 1024 * 1024;

/** Characters XML 1.0 cannot hold (they would make Word refuse the file). */
function cleanText(s) {
    return String(s == null ? '' : s)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/\r\n?/g, '\n');
}

async function buildDocx(blocks, opts) {
    opts = opts || {};
    const D = opts.docx || require('docx');
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle,
        ShadingType, Footer, AlignmentType, PageNumber, HeadingLevel } = D;

    if (!Array.isArray(blocks) || !blocks.length) throw new Error('There is nothing to put in the Word report.');
    if (blocks.length > MAX_BLOCKS) throw new Error('The report is too large for a Word document.');
    let budget = MAX_TEXT;
    const txt = (s) => {
        const c = cleanText(s);
        budget -= c.length;
        if (budget < 0) throw new Error('The report is too large for a Word document.');
        return c;
    };

    const line = (color, size) => ({ style: BorderStyle.SINGLE, size: size || 4, color: color || 'BBBBBB' });
    const box = (color, size) => ({ top: line(color, size), bottom: line(color, size), left: line(color, size), right: line(color, size) });
    const grid = (color) => Object.assign(box(color), { insideHorizontal: line(color), insideVertical: line(color) });
    const shade = (fill) => ({ fill, type: ShadingType.CLEAR, color: 'auto' });
    const CELL_M = { top: 40, bottom: 40, left: 100, right: 100 };

    function pushText(out, s, st) {
        s.split('\n').forEach((part, i) => out.push(new TextRun(Object.assign({ text: part }, st, i ? { break: 1 } : {}))));
    }
    function runs(list, base) {
        const out = [];
        for (const r of (Array.isArray(list) ? list : [list])) {
            if (r == null) continue;
            if (typeof r !== 'object') { pushText(out, txt(r), base || {}); continue; }
            if (r.br) { out.push(new TextRun({ text: '', break: 1 })); continue; }
            const st = Object.assign({}, base || {});
            if (r.s === 'mono') { st.font = MONO; st.size = TINY; }
            else if (r.s === 'ref') { st.color = '555555'; st.size = TINY; }
            else if (r.s === 'warn') { st.color = '8A1C1C'; st.bold = true; }
            else if (r.s === 'sub') { st.color = '444444'; st.size = SMALL; }
            else if (r.s === 'i') { st.italics = true; }
            pushText(out, txt(r.t), st);
        }
        return out;
    }
    const SUB = { color: '444444', size: SMALL };
    const WARN = { color: '8A1C1C', bold: true };
    const para = (children, o) => new Paragraph(Object.assign({ children }, o || {}));
    const cellPara = (children) => para(children, { spacing: { after: 0 } });
    const cell = (paras, w, o) => new TableCell(Object.assign({ children: paras, width: { size: w, type: WidthType.DXA }, margins: CELL_M }, o || {}));
    const spacer = () => para([new TextRun({ text: '', size: 8 })], { spacing: { after: 0 } });

    const children = [];
    for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        switch (b.k) {
            case 'title':
                children.push(para(runs([b.text], { bold: true, size: 34 }), { spacing: { after: 40 } }));
                break;
            case 'sub':
                children.push(para(runs(b.runs, SUB), { spacing: { after: 20 } }));
                break;
            case 'notice':
                children.push(para(runs([b.text], { size: SMALL }), { border: box('999999'), shading: shade('F4F4F4'), spacing: { before: 200, after: 80 } }));
                break;
            case 'h2':
                children.push(para(runs([b.text]), { heading: HeadingLevel.HEADING_2 }));
                break;
            case 'p':
                children.push(para(runs(b.runs, b.style === 'warn' ? WARN : b.style === 'sub' ? SUB : undefined)));
                break;
            case 'kv': {
                const rows = (Array.isArray(b.rows) ? b.rows : []).filter(Boolean);
                if (!rows.length) break;
                const w1 = Math.round(CONTENT_W * 0.34), w2 = CONTENT_W - w1;
                children.push(new Table({
                    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [w1, w2], borders: grid(),
                    rows: rows.map(r => new TableRow({
                        cantSplit: true,
                        children: [
                            cell([cellPara(runs([r.label], { color: '333333', size: SMALL }))], w1, { shading: shade('FAFAFA') }),
                            cell([cellPara(runs(r.runs, { size: SMALL }))], w2)
                        ]
                    }))
                }), spacer());
                break;
            }
            case 'table': {
                const head = (Array.isArray(b.head) ? b.head : []).map(String);
                const n = head.length || ((b.rows && b.rows[0]) || []).length;
                if (!n) break;
                const fr = Array.isArray(b.widths) && b.widths.length === n ? b.widths.map(Number) : new Array(n).fill(1 / n);
                const tot = fr.reduce((a, x) => a + (x > 0 ? x : 0), 0) || 1;
                const widths = fr.map(x => Math.max(400, Math.round(CONTENT_W * (x > 0 ? x : 0) / tot)));
                const rows = [];
                if (head.length) rows.push(new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell([cellPara(runs([h], { bold: true, size: SMALL }))], widths[i], { shading: shade('EEEEEE') })) }));
                for (const row of (Array.isArray(b.rows) ? b.rows : [])) {
                    const cells = Array.isArray(row) ? row : [];
                    rows.push(new TableRow({ cantSplit: true, children: widths.map((w, i) => cell([cellPara(runs(cells[i] == null ? '' : cells[i], { size: SMALL }))], w)) }));
                }
                children.push(new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, borders: grid(), rows }), spacer());
                break;
            }
            case 'file': {
                const inner = [cellPara(runs([b.title], { bold: true }))];
                for (const l of (Array.isArray(b.lines) ? b.lines : [])) {
                    if (l) inner.push(cellPara(runs(l.runs, l.style === 'sub' ? SUB : undefined)));
                }
                inner.push(para(b.desc ? runs([b.desc]) : runs([{ t: '(No description entered.)', s: 'i' }]), {
                    spacing: { before: 80, after: 0 }, shading: shade('F6F6F6'),
                    border: { left: { style: BorderStyle.SINGLE, size: 18, color: '555555', space: 6 } }, indent: { left: 120 }
                }));
                children.push(new Table({
                    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W], borders: grid('999999'),
                    rows: [new TableRow({ cantSplit: true, children: [cell(inner, CONTENT_W, { margins: { top: 80, bottom: 100, left: 140, right: 140 } })] })]
                }), spacer());
                break;
            }
            case 'ul':
                for (const it of (Array.isArray(b.items) ? b.items : [])) children.push(para(runs([it]), { bullet: { level: 0 }, spacing: { after: 40 } }));
                break;
            case 'end':
                children.push(para(runs([b.text], SUB), { spacing: { before: 280 } }));
                break;
            default:
                break;   // unknown blocks are skipped, never guessed at
        }
    }
    if (!children.length) throw new Error('There is nothing to put in the Word report.');

    const foot = txt(opts.footerText || '').slice(0, 300);
    const FS = { size: 16, color: '555555' };
    const footer = new Footer({
        children: [para([
            new TextRun(Object.assign({ text: foot ? foot + '  ·  Page ' : 'Page ' }, FS)),
            new TextRun(Object.assign({ children: [PageNumber.CURRENT] }, FS)),
            new TextRun(Object.assign({ text: ' of ' }, FS)),
            new TextRun(Object.assign({ children: [PageNumber.TOTAL_PAGES] }, FS))
        ], { alignment: AlignmentType.CENTER })]
    });

    const doc = new Document({
        creator: 'V.I.P.E.R.',
        title: txt(opts.title || 'Report').slice(0, 200),
        description: 'Text only. Contains no images or video.',
        styles: {
            default: { document: { run: { font: FONT, size: SZ, color: '111111' }, paragraph: { spacing: { after: 100, line: 264 } } } },
            paragraphStyles: [{
                id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                run: { font: FONT, size: 24, bold: true, color: '111111' },
                paragraph: { keepNext: true, spacing: { before: 320, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '333333', space: 2 } } }
            }]
        },
        sections: [{
            properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, right: MARGIN, bottom: BOTTOM, left: MARGIN, footer: 432 } } },
            footers: { default: footer },
            children
        }]
    });
    return Packer.toBuffer(doc);
}

module.exports = { buildDocx, cleanText, CONTENT_W };
