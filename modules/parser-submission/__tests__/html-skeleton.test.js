/*
 * VIPER Scout — HTML structure skeleton — unit tests.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\electron\dist\electron.exe ^
 *          modules\parser-submission\__tests__\html-skeleton.test.js
 *
 * Submission #31 (a Meta return that would not import) arrived with tag
 * counts only, which matched the known template — the markup that broke
 * the importer could not be seen.  The skeleton carries the markup's
 * shape.  These tests pin both halves: the shape is there, and nothing a
 * page SAYS (names, emails, phones, URLs, file names, message text) is.
 *
 * Every name, address and number in this file is invented.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require(path.join(__dirname, '..', 'sample-builder.js'));
const I = sb._internal;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x).slice(0, 400) : '')); }
};

const PII = ['Corvin', 'Haldane', 'corvin.haldane', 'example.com', '303-555-0142', '3035550142',
    'haldane_8834', 'Tamsin', 'Orrell', 'meet me at the pier', 'Brightwater', '4417 Larkspur',
    'Haldane Sans', 'secret-bg', '17589', '2026-03-14', 'tamsin.orrell'];

function metaPage(opts = {}) {
    const inline = opts.inline !== false;
    const row = (k, v) => inline
        ? `<div class="div_table" style="display:table;width:100%"><div style="display:table-cell;width:30%">${k}</div><div style="display:table-cell">${v}</div></div>`
        : `<div class="kv"><div class="kc">${k}</div><div class="kc">${v}</div></div>`;
    const css = inline ? '' : '.kv{display:table;width:100%} .kc{display:table-cell}';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Instagram Legal Request Corvin Haldane 17589</title>
<style>
/* Corvin Haldane export */
body{font-family:"Haldane Sans", Arial;background:url("https://example.com/secret-bg.png")}
.content-pane{display:none} .sticky_side_bar{position:fixed}
${css}
@media print{.noprint{display:none}}
</style>
<script>function printOptionChange(el){ var who = "corvin.haldane@example.com"; }</script>
</head><body>
<div class="sticky_side_bar">
  <input type="checkbox" id="print_unified_messages" onchange="printOptionChange(this)"><label for="print_unified_messages">Messages</label>
  <a property="unified_messages" href="#property-unified_messages">Unified Messages</a>
  <a href="mailto:corvin.haldane@example.com">corvin.haldane@example.com</a>
  <a href="https://example.com/u/haldane_8834">profile</a>
</div>
<div id="property-request_parameters" class="content-pane">
  ${row('Target', 'corvin.haldane 17589')}
  ${row('Service', 'Instagram')}
  ${row('Date Range', '2026-03-14 to 2026-04-01')}
</div>
<div id="property-unified_messages" class="content-pane">
  ${row('Author', 'Tamsin Orrell (tamsin.orrell)')}
  ${row('Body', 'meet me at the pier near 4417 Larkspur Way, Brightwater')}
  ${row('Phone', '303-555-0142')}
  ${row('Linked Media', '<img src="linked_media/haldane_8834.jpg">')}
  ${row('Author', 'Tamsin Orrell (tamsin.orrell)')}
  ${row('Body', 'meet me at the pier near 4417 Larkspur Way, Brightwater')}
</div>
<div id="user-corvin.haldane@example.com">x</div>
</body></html>`;
}

// ── A: the inline template ──────────────────────────────────────────────
const A = I.htmlSkeleton(metaPage());
const jA = JSON.stringify(A);
for (const p of PII) ok('A: "' + p + '" is not in the skeleton', jA.indexOf(p) < 0, jA.slice(Math.max(0, jA.indexOf(p) - 80), jA.indexOf(p) + 40));
ok('A: title shape keeps the product / legal words only', A.title_shape === 'Instagram Legal Request * #', A.title_shape);
ok('A: markers — inline Meta template', A.markers.legal_request_title && A.markers.property_ids && A.markers.property_toc_links &&
    A.markers.div_table_class && A.markers.inline_display_table && !A.markers.css_display_table && A.markers.content_pane &&
    A.markers.print_option && A.markers.linked_media_refs, A.markers);
const linesA = A.windows.map(w => w.lines.join('\n')).join('\n');
ok('A: section panes appear with id and class', /div#property-unified_messages\.content-pane/.test(linesA), linesA.slice(0, 600));
ok('A: rows show class + inline display', /div\.div_table \[style\{display:table\}\]/.test(linesA), linesA.slice(0, 1200));
ok('A: cells show inline display', /div \[style\{display:table-cell\}\]/.test(linesA));
ok('A: TOC link shape', /a \[property=unified_messages href=#property-unified_messages\]/.test(linesA));
ok('A: mailto / url shapes, no address', /href=mailto/.test(linesA) && /href=url/.test(linesA));
ok('A: media src shape only', /img \[src=linked_media\/\*\]/.test(linesA));
ok('A: print checkbox + handler name', /input#print_unified_messages \[type=checkbox onchange=printOptionChange\(\)\]/.test(linesA));
ok('A: text is a character count', /~text \d+/.test(linesA));
ok('A: an id holding an email is masked', /div#\?/.test(linesA) && A.ids.indexOf('?') >= 0, A.ids);
ok('A: digits in ids/classes masked', A.ids.every(i => !/\d/.test(i)));
ok('A: CSS kept without strings, urls or comments', /\.content-pane\{display:none\}/.test(A.css) && /url\(\)/.test(A.css) &&
    /@media print/.test(A.css) && A.css.indexOf('export') < 0, A.css);
ok('A: class frequencies', A.classes.some(c => c.name === 'div_table' && c.count === 9), A.classes);
ok('A: script body not walked', linesA.indexOf('who') < 0);

// ── B: the class-based layout (what #31 may be) ─────────────────────────
const B = I.htmlSkeleton(metaPage({ inline: false }));
const jB = JSON.stringify(B);
for (const p of PII) if (jB.indexOf(p) >= 0) ok('B: "' + p + '" is not in the skeleton', false);
ok('B: no PII', PII.every(p => jB.indexOf(p) < 0));
ok('B: markers flip to CSS tables', !B.markers.inline_display_table && B.markers.css_display_table && !B.markers.div_table_class, B.markers);
ok('B: CSS shows the table classes', /\.kv\{display:table;width:100%\}/.test(B.css) && /\.kc\{display:table-cell\}/.test(B.css), B.css);
ok('B: identical consecutive lines collapse', /×2/.test(I.htmlSkeleton('<ul><li></li><li></li></ul>').windows[0].lines.join('\n')));

// ── C: dispatch, budget, xml ────────────────────────────────────────────
I._resetHtmlSkeletonBudget();
const buf = Buffer.from(metaPage());
let withSk = 0;
for (let i = 0; i < I.HTML_SKELETON_MAX_FILES + 3; i++) if (I.inspectFormat('html', buf).skeleton) withSk++;
ok('C: skeleton for the first ' + I.HTML_SKELETON_MAX_FILES + ' pages only', withSk === I.HTML_SKELETON_MAX_FILES, withSk);
I._resetHtmlSkeletonBudget();
ok('C: xml keeps tag counts only', !I.inspectFormat('xml', Buffer.from('<a><b>Corvin</b></a>')).skeleton);
const plain = I.inspectFormat('html', buf);
ok('C: tag counts still there', plain.type === 'html' && plain.total_tags > 20 && Array.isArray(plain.tags));

// ── D: size and speed on a big page ─────────────────────────────────────
{
    const unit = metaPage().split('<body>')[1].split('</body>')[0];
    const big = metaPage().split('<body>')[0] + '<body>' + unit.repeat(Math.ceil(6e6 / unit.length)) + '</body></html>';
    const t0 = Date.now();
    const D = I.htmlSkeleton(big);
    const ms = Date.now() - t0;
    const bytes = JSON.stringify(D).length;
    ok('D: 6 MB page in under 3 s', ms < 3000, ms);
    ok('D: skeleton stays small (< 48 KB)', bytes < 48 * 1024, bytes);
    ok('D: four windows', D.windows.length === 4, D.windows.map(w => w.at_fraction));
    ok('D: no PII', PII.every(p => JSON.stringify(D).indexOf(p) < 0));
}

// ── E: tiny / odd input ─────────────────────────────────────────────────
{
    const e1 = I.htmlSkeleton('');
    ok('E: empty input', e1.windows.length === 0 && e1.title_shape === null);
    const e2 = I.htmlSkeleton('<div class="a"><p>Corvin <b>Haldane</b></div><title>x');
    ok('E: unclosed tags do not throw or leak', JSON.stringify(e2).indexOf('Corvin') < 0 && JSON.stringify(e2).indexOf('Haldane') < 0);
}

// ── F: end to end through buildSampleEnvelope ───────────────────────────
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vskel-'));
    try {
        fs.mkdirSync(path.join(tmp, 'linked_media'));
        fs.writeFileSync(path.join(tmp, 'records.html'), metaPage());
        fs.writeFileSync(path.join(tmp, 'preservation-1.html'), metaPage({ inline: false }));
        fs.writeFileSync(path.join(tmp, 'linked_media', 'haldane_8834.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2]));
        const env = await sb.buildSampleEnvelope(tmp, { deviceMode: false });
        const j = JSON.stringify(env);
        const tree = (env.envelope || env).tree || [];
        const htmls = tree.filter(e => e.format === 'html');
        ok('F: both pages carry a skeleton', htmls.length === 2 && htmls.every(e => e.structure && e.structure.skeleton && e.structure.skeleton.windows.length),
            htmls.map(e => e.structure && Object.keys(e.structure)));
        ok('F: no PII anywhere in the envelope', PII.every(p => j.indexOf(p) < 0), PII.filter(p => j.indexOf(p) >= 0));
    } catch (e) {
        ok('F: envelope build', false, String(e && e.stack || e));
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
    console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
