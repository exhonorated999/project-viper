/*
 * The print document for a VIPER-editor case report (modules/reports/report-print.js).
 *
 * Run: node modules\reports\__tests__\report-print.test.js
 *
 * What it pins:
 *   - the page can load nothing from outside (CSP: only data: pictures and
 *     inline styles, no scripts);
 *   - Export to DA pages: no printer margins, the first page starts lower
 *     (under the section title VIPER draws), clamped to a sane range;
 *   - Export PDF (Reports tab): printer margins + a header with the case
 *     number and dates, every value escaped;
 *   - tables/pictures/page breaks print as laid out (break rules present).
 */
const path = require('path');
const RP = require(path.join(__dirname, '..', 'report-print.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

console.log('\n[the page is sealed]');
{
    const h = RP.buildPrintHtml({ bodyHtml: '<p>x</p>' });
    ok('CSP meta: nothing by default, pictures only as data:, inline styles only', h.indexOf('<meta http-equiv="Content-Security-Policy" content="' + RP.CSP + '">') > 0 &&
        /default-src 'none'/.test(RP.CSP) && /img-src data:/.test(RP.CSP) && /style-src 'unsafe-inline'/.test(RP.CSP) && !/script-src/.test(RP.CSP));
    ok('…and it comes before the body', h.indexOf('Content-Security-Policy') < h.indexOf('<body>'));
    ok('UTF-8 declared', /<meta charset="utf-8">/.test(h));
    ok('the body is placed as given (the caller sanitizes)', /<div class="rp-body"><p>x<\/p><\/div>/.test(h));
    ok('floats are cleared at the end', /<div class="rp-end"><\/div><\/body>/.test(h));
}

console.log('\n[Export to DA pages]');
{
    const h = RP.buildPrintHtml({ bodyHtml: '<p>x</p>', firstPageTopMm: 23.456 });
    ok('no printer margins (the page is printed at the box size)', /@page\{margin:0\}/.test(h));
    ok('the first page starts under the section title', /@page :first\{margin-top:23\.46mm\}/.test(h));
    ok('no header block', !/rp-head"/.test(h.slice(h.indexOf('<body>'))));
    const z = RP.buildPrintHtml({ bodyHtml: '', firstPageTopMm: 0 });
    ok('a report starting at the top: no first-page rule', !/@page :first/.test(z) && /@page\{margin:0\}/.test(z));
    const big = RP.buildPrintHtml({ bodyHtml: '', firstPageTopMm: 9999 });
    ok('an absurd offset is clamped', /margin-top:250\.00mm/.test(big));
    const neg = RP.buildPrintHtml({ bodyHtml: '', firstPageTopMm: -5 });
    ok('a negative offset is ignored', !/@page :first/.test(neg));
    const nan = RP.buildPrintHtml({ bodyHtml: '', firstPageTopMm: 'abc' });
    ok('a non-number is ignored', !/@page :first/.test(nan));
}

console.log('\n[Export PDF from the Reports tab]');
{
    const h = RP.buildPrintHtml({
        bodyHtml: '<p>x</p>', marginsFromPrinter: true, firstPageTopMm: 30,
        header: { title: 'Case Report', caseNumber: '24-<1>', lines: ['Generated: now', '', null, 'By: A & B "C"'] },
    });
    ok('printer margins are used (no @page rules)', !/@page/.test(h));
    ok('the header names the report and the case', /<p class="rp-title">Case Report<\/p>/.test(h) && /<p class="rp-case">Case 24-&lt;1&gt;<\/p>/.test(h));
    ok('…empty lines are skipped, the rest escaped', (h.match(/class="rp-meta"/g) || []).length === 2 && /By: A &amp; B &quot;C&quot;/.test(h));
    ok('the window title is the report title', /<title>Case Report<\/title>/.test(h));
    const t = RP.buildPrintHtml({ bodyHtml: '', header: { title: '<script>x</script>' } });
    ok('a title cannot inject markup', !/<script>x/.test(t) && /&lt;script&gt;x/.test(t));
}

console.log('\n[layout rules]');
{
    const h = RP.buildPrintHtml({ bodyHtml: '' });
    ok('black text, Arial 14px, transparent page (VIPER\'s page shows through)', /color:#000/.test(h) && /Arial/.test(h) && /font-size:14px/.test(h) && /background:transparent/.test(h));
    ok('a page break starts a new page', /\.rp-body \.vre-pagebreak\{page-break-after:always;break-after:page/.test(h));
    ok('table rows and pictures are not split across pages', /\.rp-body tr\{page-break-inside:avoid/.test(h) && /\.rp-body img\{[^}]*page-break-inside:avoid/.test(h));
    ok('a table header row repeats on each page', /thead\{display:table-header-group\}/.test(h));
    ok('pictures never overflow the column', /\.rp-body img\{max-width:100%/.test(h));
    ok('lists keep their bullets and numbers', /\.rp-body ul\{list-style:disc/.test(h) && /\.rp-body ol\{list-style:decimal/.test(h));
    ok('headings stay with the text after them', /h1,\.rp-body h2,\.rp-body h3,\.rp-body h4\{page-break-after:avoid/.test(h));
}

console.log('\n[esc]');
ok('esc covers & < > " \'', RP.esc('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;');
ok('esc of null is empty', RP.esc(null) === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
