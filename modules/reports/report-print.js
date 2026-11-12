/**
 * ViperReportPrint — the print document for a case report written in the
 * VIPER editor. Rendered to PDF by Chromium (electron-main save-html-as-pdf),
 * so tables, pictures, text wrap, alignment and font sizes come out as laid
 * out in the editor.
 *
 *   buildPrintHtml({ bodyHtml, header, firstPageTopMm })
 *     bodyHtml        report HTML, ALREADY cleaned (ViperRichEditor.sanitize)
 *     header          optional { title, caseNumber, lines[] } — standalone PDF
 *     firstPageTopMm  Export to DA: extra top margin on the first page so it
 *                     sits under the section title already on that page
 *
 * The document carries a CSP that allows nothing but inline styles and data:
 * pictures, so nothing in a report can load or run while it prints.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ViperReportPrint = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const BASE_CSS = [
        'html,body{margin:0;padding:0;background:transparent}',
        'body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
        '.rp-body{overflow-wrap:break-word}',
        '.rp-body p{margin:0 0 .35em}',
        '.rp-body div{margin:0}',
        '.rp-body h1{font-size:1.75em;line-height:1.25;margin:.5em 0 .3em}',
        '.rp-body h2{font-size:1.4em;line-height:1.3;margin:.5em 0 .3em}',
        '.rp-body h3{font-size:1.17em;line-height:1.35;margin:.45em 0 .25em}',
        '.rp-body h1,.rp-body h2,.rp-body h3,.rp-body h4{page-break-after:avoid;break-after:avoid}',
        '.rp-body ul{list-style:disc;padding-left:1.7em;margin:.3em 0}',
        '.rp-body ol{list-style:decimal;padding-left:1.7em;margin:.3em 0}',
        '.rp-body blockquote{margin:0 0 0 40px}',
        '.rp-body img{max-width:100%;height:auto;page-break-inside:avoid;break-inside:avoid}',
        '.rp-body table{border-collapse:collapse;max-width:100%}',
        '.rp-body td,.rp-body th{vertical-align:top}',
        '.rp-body tr{page-break-inside:avoid;break-inside:avoid}',
        '.rp-body thead{display:table-header-group}',
        '.rp-body .vre-pagebreak{page-break-after:always;break-after:page;height:0;margin:0;border:0}',
        '.rp-end{clear:both}',
        '.rp-head{border-bottom:2px solid #005aa0;padding-bottom:8px;margin-bottom:14px}',
        '.rp-title{font-size:20px;font-weight:700;color:#005aa0;margin:0}',
        '.rp-case{font-size:15px;font-weight:700;margin:2px 0 4px}',
        '.rp-meta{font-size:11px;color:#555;margin:0}',
    ].join('\n');

    function buildPrintHtml(opts) {
        const o = opts || {};
        const top = Math.max(0, Math.min(250, +o.firstPageTopMm || 0));
        const pageCss = '@page{margin:0}' + (top ? '@page :first{margin-top:' + top.toFixed(2) + 'mm}' : '');
        const h = o.header;
        const head = h ? '<div class="rp-head">'
            + (h.title ? '<p class="rp-title">' + esc(h.title) + '</p>' : '')
            + (h.caseNumber ? '<p class="rp-case">Case ' + esc(h.caseNumber) + '</p>' : '')
            + (Array.isArray(h.lines) ? h.lines.filter(Boolean).map((l) => '<p class="rp-meta">' + esc(l) + '</p>').join('') : '')
            + '</div>' : '';
        return '<!DOCTYPE html><html><head><meta charset="utf-8">'
            + '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
            + '<title>' + esc((h && h.title) || 'Case report') + '</title>'
            + '<style>' + (o.marginsFromPrinter ? '' : pageCss) + '\n' + BASE_CSS + '</style></head><body>'
            + head + '<div class="rp-body">' + String(o.bodyHtml || '') + '</div><div class="rp-end"></div></body></html>';
    }

    return { buildPrintHtml, CSP, esc };
});
