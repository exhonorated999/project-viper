// modules/warrant-author/__tests__/pc-rich-build.test.js
// Rich-text probable cause end to end: case-pc-store (setRich /
// getBodyHtml) → block-builder (rich paragraph blocks for every layout,
// plain fallback when the HTML no longer matches the text) → PDF + DOCX.
// SYNTHETIC data only (Example County / example.gov / J. Sample).
//
// Run: node modules/warrant-author/__tests__/pc-rich-build.test.js
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const W = (p) => path.join(ROOT, 'modules', 'warrant-author', p);

globalThis.jspdf = require(path.join(ROOT, 'libs', 'jspdf.umd.min.js'));
const R = require(W('pc-rich.js'));
const engine = require(W('template-engine.js'));
const items = require(W('items-taxonomy.js'));
const pdir = require(W('provider-directory.js'));
const builder = require(W('block-builder.js'));
const pdf = require(W('pdf-composer.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log('  FAIL:', msg, '\n    got:', A, '\n    exp:', B); }
}
function section(t) { console.log('— ' + t); }

// ─── fixtures ─────────────────────────────────────────────────────────
const HTML = '<p>Synopsis: <b>Bold words</b> and <i>italic words</i> and <u>underlined words</u> here.</p>'
  + '<ul><li>First point</li><li>Second point</li></ul>'
  + '<p style="text-align:center">Centered line</p>'
  + '<p style="margin-left:40px">Indented paragraph text.</p>'
  + '<p>Line one<br>Line two</p>';
const PLAIN = R.toPlain(R.parse(HTML));
const AGENCY = {
  agencyName: 'Example City Police Department', county: 'Example',
  agencyAddress: '100 Example Ave, Example City, AZ 85000',
  affiantName: 'J. Sample', affiantRank: 'Detective', affiantBadge: '9999',
  affiantEmail: 'j.sample@example.gov',
  trainingExperienceBoilerplate: 'Affiant, Detective J. Sample #9999, is a certified Peace Officer employed by the Example City Police Department.',
};
const CASE = { number: '24-000001', offenseDescription: 'Example Offense', offenseDate: '2024-01-05' };
const providers = pdir.mergeProviders({});
const prov = (k) => providers.find(p => p.key === k) || { key: k, name: k };

function buildFor(tplId, jur, pcHtml, pcText) {
  const tpl = engine.getTemplate(tplId);
  if (!tpl) return null;
  const draft = { id: 'd-' + tplId, template: tplId, jurisdiction: jur, swNumber: '' };
  const ad = {
    id: 'a0', pageLabel: 'A', providerKey: 'google', targets: [{ type: 'email', value: 'example.user@gmail.com' }],
    dateRange: { start: '2024-01-01', end: '2024-02-01', allAvailable: false }, itemsToProduce: [],
    probableCause: pcText,
  };
  const res = engine.compose(tpl, {
    addendum: ad, provider: prov('google'), items, agency: AGENCY, draft,
    court: { county: 'Example' }, case: CASE,
    addendums: [{ pageLabel: 'A', providerName: prov('google').name, address: prov('google').address || '' }],
  });
  return builder.build({
    draft, addendumComposes: [{ addendumId: 'a0', providerKey: 'google', compose: res }],
    agency: AGENCY, caseInfo: CASE, pcNarrative: pcText, pcHtml, includeDisclaimer: true,
  });
}
const richOf = (bs) => bs.blocks.filter(b => b.kind === 'paragraph' && Array.isArray(b.runs));

// ─── 1. case-pc-store ─────────────────────────────────────────────────
section('1. case-pc-store');
{
  const mem = {};
  globalThis.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
  const store = require(W('case-pc-store.js'));
  store.setBody('c1', 'First paragraph.\n\nSecond paragraph.');
  eq(store.getBodyHtml('c1'), '<p>First paragraph.</p><p>Second paragraph.</p>', 'plain body → paragraphs');
  store.setRich('c1', HTML);
  eq(store.getBody('c1'), PLAIN, 'setRich stores the matching plain body');
  ok(/<b>Bold words<\/b>/.test(store.getBodyHtml('c1')) && /<ul>/.test(store.getBodyHtml('c1')), 'getBodyHtml returns the rich HTML');
  store.setOffenseDescription('c1', 'Example');
  ok(/<b>Bold words<\/b>/.test(store.getBodyHtml('c1')), 'offense edit keeps the rich HTML');
  store.setBody('c1', 'Replaced text.');
  eq(store.getBodyHtml('c1'), '<p>Replaced text.</p>', 'plain edit drops stale HTML');
  store.setRich('c1', '<p>x<img src="data:image/png;base64,AAAA"><script>alert(1)</script></p><table><tr><td>t</td></tr></table>');
  ok(!/<img|<script|<table/i.test(store.getBodyHtml('c1')), 'pictures / scripts / tables are stripped');
  delete globalThis.localStorage;
}

// ─── 2. builder: every layout ─────────────────────────────────────────
section('2. builder');
const CASES = [
  ['generic-us-multi-business-esp', 'US'],
  ['va-multi-business-esp', 'VA'],
  ['ca-multi-business-esp', 'CA'],
  ['tx-multi-business-esp', 'TX'],
  ['az-multi-business-esp', 'AZ'],
  ['co-multi-business-esp', 'CO'],
  ['ar-multi-business-esp', 'AR'],
];
const built = {};
for (const [id, jur] of CASES) {
  let bs = null;
  try { bs = buildFor(id, jur, HTML, PLAIN); } catch (e) { fail++; console.log('  FAIL:', id, 'build threw', e && e.stack); continue; }
  if (!bs) { console.log('  (skip) no template', id); continue; }
  built[id] = bs;
  const rich = richOf(bs);
  ok(rich.length >= 5, id + ': PC rendered as rich paragraphs (' + rich.length + ')');
  ok(rich.some(b => b.runs.some(r => r.bold && r.text === 'Bold words')), id + ': bold run');
  ok(rich.some(b => b.runs.some(r => r.italics && r.text === 'italic words')), id + ': italic run');
  ok(rich.some(b => b.runs.some(r => r.underline && r.text === 'underlined words')), id + ': underline run');
  ok(rich.filter(b => b.marker === '\u2022').length >= 2, id + ': bullet items');
  ok(rich.some(b => b.align === 'center' && /Centered line/.test(b.text)), id + ': centered paragraph');
  ok(rich.some(b => b.leftPt === 36 && /Indented paragraph/.test(b.text)), id + ': indented paragraph');
  ok(!bs.blocks.some(b => typeof b.text === 'string' && /<\/?(p|b|ul|li)>/.test(b.text)), id + ': no HTML tags leak into text');
  // Mismatched HTML (stale) → plain text fallback, no runs anywhere.
  const stale = buildFor(id, jur, '<p>Some <b>other</b> text.</p>', PLAIN);
  eq(richOf(stale).length, 0, id + ': stale HTML falls back to plain text');
  ok(stale.blocks.some(b => typeof b.text === 'string' && b.text.indexOf('Bold words') !== -1), id + ': plain PC still present');
  // No HTML at all → unchanged behaviour.
  eq(richOf(buildFor(id, jur, undefined, PLAIN)).length, 0, id + ': no pcHtml → no rich blocks');
}
{
  // The module-level rich state never leaks into the next build.
  const after = buildFor('generic-us-multi-business-esp', 'US', undefined, PLAIN);
  eq(richOf(after).length, 0, 'rich state reset after build');
}

// ─── 3. PDF ───────────────────────────────────────────────────────────
section('3. PDF');
for (const id of Object.keys(built)) {
  try {
    const out = pdf.composePdf({ blockStream: built[id], draft: {}, agency: AGENCY });
    const raw = Buffer.from(out.arrayBuffer).toString('latin1');
    ok(raw.length > 2000, id + ': PDF produced');
    ok(raw.indexOf('Bold words') !== -1 || raw.indexOf('Bold') !== -1, id + ': PC text in PDF');
    const fonts = new Set((raw.match(/\/F\d+ [\d.]+ Tf/g) || []).map(x => x.split(' ')[0]));
    ok(fonts.size >= 3, id + ': several faces used (regular/bold/italic) — ' + [...fonts].join(','));
  } catch (e) { fail++; console.log('  FAIL:', id, 'PDF threw', e && e.stack); }
}

// ─── 4. DOCX ──────────────────────────────────────────────────────────
section('4. DOCX');
(async () => {
  try {
    const JSZip = require('jszip');
    const { composeDocx } = require(W('docx-composer.js'));
    for (const id of Object.keys(built)) {
      const buf = await composeDocx({ blockStream: built[id], draft: {}, agency: AGENCY });
      const zip = await JSZip.loadAsync(buf);
      const doc = await zip.file('word/document.xml').async('string');
      ok(doc.indexOf('Bold words') !== -1, id + ': PC text in Word');
      ok(/<w:b\/>[\s\S]{0,400}?Bold words/.test(doc) || /<w:b w:val="true"\/>[\s\S]{0,400}?Bold words/.test(doc), id + ': bold run in Word');
      ok(/<w:i\/>[\s\S]{0,400}?italic words/.test(doc) || /<w:i w:val="true"\/>[\s\S]{0,400}?italic words/.test(doc), id + ': italic run in Word');
      ok(/<w:u w:val="single"\/>[\s\S]{0,400}?underlined words/.test(doc), id + ': underline run in Word');
      ok(/\u2022\t/.test(doc) || /\u2022<\/w:t>[\s\S]{0,80}<w:tab\/>/.test(doc) || /<w:t xml:space="preserve">\u2022\t<\/w:t>/.test(doc), id + ': bullet marker in Word');
      ok(doc.indexOf('&lt;b&gt;') === -1, id + ': no escaped tags in Word');
      const justified = richOf(built[id]).some(b => b.justify && /Line one/.test(b.text));
      if (justified) {
        ok(/Line one<\/w:t><\/w:r><\/w:p>/.test(doc), id + ': justified soft break → separate Word paragraph (no stretched line)');
      } else {
        ok(/Line one<\/w:t><\/w:r><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:br\/>/.test(doc), id + ': soft break → <w:br/>');
      }
    }
  } catch (e) {
    fail++; console.log('  FAIL: DOCX threw', e && e.stack);
  }
  console.log(`\npc-rich-build: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
