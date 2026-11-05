// modules/warrant-author/__tests__/tx-esp.test.js
// Texas "Warrant for Electronic Customer Data" (Art. 18B) template:
// engine resolvers → block-builder TX layout → PDF + DOCX composers.
// SYNTHETIC data only (Example County / example.gov / J. Sample).
//
// Run: node modules/warrant-author/__tests__/tx-esp.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const W = (p) => path.join(ROOT, 'modules', 'warrant-author', p);

globalThis.jspdf = require(path.join(ROOT, 'libs', 'jspdf.umd.min.js'));
const engine = require(W('template-engine.js'));
const items = require(W('items-taxonomy.js'));
const pdir = require(W('provider-directory.js'));
const builder = require(W('block-builder.js'));
const pdf = require(W('pdf-composer.js'));
const validator = require(W('validator.js'));
const store = require(W('draft-store.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log('  FAIL:', msg, '\n    got:', A, '\n    exp:', B); }
}
function section(t) { console.log('— ' + t); }

// ─── fixtures ─────────────────────────────────────────────────────────
const providers = pdir.mergeProviders({});
const tpl = engine.getTemplate('tx-multi-business-esp');
const AGENCY = {
  agencyName: 'Example City Police Department', county: 'Example',
  affiantName: 'J. Sample', affiantRank: 'Detective', affiantBadge: '9999',
  affiantEmail: 'j.sample@example.gov',
  trainingExperienceBoilerplate: 'Affiant, Detective J. Sample #9999, is a certified Peace Officer employed by the Example City Police Department.',
};
const PC = 'Affiant learned the following information from reading related reports.\nOn January 5, 2017 an example event occurred at an example address.';
const CASE = { number: '17-000001', offenseDescription: 'Example Offense - Robbery' };

function mkAd(providerKey, targets, extra) {
  return Object.assign({
    providerKey, targets,
    dateRange: { start: '2017-01-01', end: '2017-02-01', allAvailable: false },
    itemsToProduce: [], probableCause: PC,
  }, extra || {});
}
function mkProvider(key) {
  return providers.find(p => p.key === key) || { key, name: key };
}
function compose(ad, opts) {
  opts = opts || {};
  const ctx = {
    addendum: ad,
    provider: opts.provider || mkProvider(ad.providerKey),
    items,
    agency: opts.agency || AGENCY,
    draft: opts.draft || { id: 'd1', template: 'tx-multi-business-esp', jurisdiction: 'TX' },
    court: opts.court === undefined ? { county: 'Example' } : opts.court,
    case: opts.case || CASE,
  };
  return engine.compose(tpl, ctx);
}
const byKind = (res, kind) => res.blocks.filter(b => b.kind === kind);
const byKey = (res, key) => res.blocks.find(b => b.key === key);

// ─── 1. template registration + bundle parity ─────────────────────────
section('1. template + bundle');
ok(tpl && tpl.id === 'tx-multi-business-esp', 'template loads from templates/*.json');
ok(tpl && tpl.jurisdiction === 'TX', 'jurisdiction TX');
{
  const json = JSON.parse(fs.readFileSync(W('templates/tx-multi-business-esp.json'), 'utf8'));
  const registered = [];
  const sandbox = {
    window: { WarrantAuthorTemplateEngine: { registerTemplate: (t) => registered.push(t) } },
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(fs.readFileSync(W('templates-bundle.js'), 'utf8'), sandbox);
  const inBundle = registered.find(t => t.id === 'tx-multi-business-esp');
  ok(!!inBundle, 'bundle registers the TX template');
  eq(inBundle, json, 'bundle entry is identical to templates/tx-multi-business-esp.json');
  ok(registered.length >= 8, 'bundle still registers every other template');
}

// ─── 2. _txLongDate ───────────────────────────────────────────────────
section('2. _txLongDate');
eq(engine._txLongDate('2017-01-01'), 'January 1, 2017', 'ISO → long date');
eq(engine._txLongDate('2024-12-31'), 'December 31, 2024', 'Dec 31');
eq(engine._txLongDate('March 3, 2020'), 'March 3, 2020', 'non-ISO passes through');
eq(engine._txLongDate(''), '', 'empty stays empty');

// ─── 3. compose: resolvers ────────────────────────────────────────────
section('3. compose');
const resSnap = compose(mkAd('snapchat', [{ type: 'username', value: 'example_user1' }], { includeNonDisclosure: true, txGround9: true }));
const resApple = compose(mkAd('apple', [{ type: 'email', value: 'someone@example.com' }, { type: 'esp-user-id', value: '000111' }]));
eq(resSnap.danglingSlots, [], 'snapchat: no dangling slots');
eq(resApple.danglingSlots, [], 'apple: no dangling slots');

const capW = byKey(resSnap, 'w01-caption');
eq(capW.rows, [
  { left: 'THE STATE OF TEXAS', right: '' },
  { left: 'COUNTY OF EXAMPLE', right: 'COURT: ________ DISTRICT COURT' },
], 'warrant caption rows (blank district court)');
const capA = byKey(resSnap, 'a01-caption');
eq(capA.rows[1], { left: 'COUNTY OF EXAMPLE', right: 'AND FOR EXAMPLE COUNTY, TEXAS' }, 'affidavit caption county row');
{
  const r = compose(mkAd('apple', [{ type: 'email', value: 'a@example.com' }]),
    { draft: { id: 'd2', template: 'tx-multi-business-esp', jurisdiction: 'TX', txDistrictCourt: '999th' } });
  eq(byKey(r, 'w01-caption').rows[1].right, 'COURT: 999th DISTRICT COURT', 'district court number prints');
}
{
  const r = compose(mkAd('apple', [{ type: 'email', value: 'a@example.com' }]), { court: null, agency: Object.assign({}, AGENCY, { county: '' }) });
  ok(r.danglingSlots.includes('court.county'), 'missing county → dangling court.county');
}

const addr = byKey(resSnap, 'w03-address');
ok(/Peace Officer of Example County, Texas/.test(addr.text), 'address line names the county');

const recSnap = byKey(resSnap, 'w08-records');
eq(recSnap.lead, 'Snapchat username example_user1 from January 1, 2017 to February 1, 2017:', 'records lead (brand name, long dates)');
eq(recSnap.provideTo, 'Provide Records to Detective J. Sample at email address j.sample@example.gov', 'provide-to line');
ok(recSnap.items.length > 0, 'records carry item descriptions');
const recApple = byKey(resApple, 'w08-records');
ok(/email someone@example\.com and\/or Account ID 000111/.test(recApple.lead), 'multiple targets joined with and/or + labels');
{
  const r = compose(mkAd('apple', [{ type: 'phone', value: '555-0100' }], { dateRange: { start: '', end: '', allAvailable: true } }));
  ok(/phone number 555-0100 for all available dates:$/.test(byKey(r, 'w08-records').lead), 'all available dates wording');
  eq(r.danglingSlots, [], 'all-available leaves no date dangling');
}
{
  const r = compose(mkAd('apple', [{ type: 'email', value: 'a@example.com' }], { dateRange: { start: '2017-01-01', end: '' } }));
  ok(r.danglingSlots.includes('addendum.dateRange.end'), 'missing end date → dangling');
}
{
  const r = compose(mkAd('apple', [], { recordsPertainingTo: 'Example account X AND any account that messaged it.' }));
  eq(byKey(r, 'w08-records').lead, 'Example account X AND any account that messaged it:', 'override replaces the lead and ends with a colon');
  ok(!r.danglingSlots.includes('addendum.targets'), 'override → no targets dangling');
}
{
  const r = compose(mkAd('apple', []));
  ok(r.danglingSlots.includes('addendum.targets'), 'no targets → dangling addendum.targets');
}

const prov = byKey(resApple, 'w06-provider');
ok(prov.lines.length >= 2, 'provider block has name + address');
ok(!/\n/.test(prov.lines[1]), 'address flattened to one line');
{
  const p = { key: 'x', name: 'ExampleApp', legalEntity: 'ExampleApp LLC', address: '1 Example Way\nExample, TX 75000',
    phone: '555-0101', email: 'legal@example.com', notes: 'Fax 555-0102 (legal)' };
  const r = compose(mkAd('x', [{ type: 'email', value: 'a@example.com' }]), { provider: p });
  eq(byKey(r, 'a04-provider').lines, ['ExampleApp LLC', '1 Example Way, Example, TX 75000', 'Phone: 555-0101 / Fax: 555-0102 / legal@example.com'],
    'legal entity + fax read from notes');
  ok(/^ExampleApp username|^ExampleApp email/.test(byKey(r, 'w08-records').lead), 'records lead uses the brand name');
}

const ndoOn = byKey(resSnap, 'w09-ndo');
ok(ndoOn && !ndoOn.omitted && /Snap Inc\./.test(ndoOn.text), 'NDO included + names the legal entity');
ok(byKey(resApple, 'w09-ndo').omitted === true, 'NDO omitted when not requested');

const gSnap = byKey(resSnap, 'a11-grounds');
eq(gSnap.offense, 'Example Offense - Robbery', 'offense from the case');
ok(gSnap.lines.some(l => /^\(9\)/.test(l)), 'ground 9 when ticked');
ok(!byKey(resApple, 'a11-grounds').lines.some(l => /^\(9\)/.test(l)), 'no ground 9 by default');
ok(gSnap.lines.some(l => /^\(10\)/.test(l)) && gSnap.lines.some(l => /^\(13\)/.test(l)), 'grounds 10 + 13 always');
{
  const r = compose(mkAd('apple', [{ type: 'email', value: 'a@example.com' }], { txOffense: 'Override Offense' }));
  eq(byKey(r, 'a11-grounds').offense, 'Override Offense', 'per-addendum offense override');
  const r2 = compose(mkAd('apple', [{ type: 'email', value: 'a@example.com' }]), { case: { number: '1' } });
  ok(r2.danglingSlots.includes('case.offenseDescription'), 'no offense → dangling');
}
const sigs = byKey(resSnap, 'a21-signatures');
eq([sigs.name, sigs.badge, sigs.rank, sigs.agencyName, sigs.county], ['J. Sample', '9999', 'Detective', 'Example City Police Department', 'Example'], 'signature fields');
eq(byKey(resSnap, 'w14-magistrate').county, 'Example', 'magistrate county');

// ─── 4. block-builder TX layout ───────────────────────────────────────
section('4. block-builder');
const DRAFT = { id: 'd1', template: 'tx-multi-business-esp', jurisdiction: 'TX', swNumber: '' };
const composes = [
  { addendumId: 'a0', providerKey: 'snapchat', compose: resSnap },
  { addendumId: 'a1', providerKey: 'apple', compose: resApple },
];
const bs = builder.build({ draft: DRAFT, addendumComposes: composes, agency: AGENCY, caseInfo: {}, pcNarrative: PC, includeDisclaimer: true });
eq(bs.meta.layout, 'tx', 'meta.layout tx');
eq(bs.meta.jurisdiction, 'TX', 'meta.jurisdiction TX');
ok(bs.meta.runningHeader.enabled && bs.meta.runningHeader.sectionPages, 'running header with per-section pages');
ok(/^SEARCH WARRANT NO:_{10,}$/.test(bs.meta.runningHeader.left), 'header shows a blank SW number line');
ok(bs.meta.runningFooter.enabled === false, 'no running footer');
eq(bs.blocks.filter(b => b.kind === 'section-break').length, 3, '2 providers → 4 sections → 3 section-breaks');
ok(!bs.blocks.some(b => b.kind === 'footer-disclaimer'), 'no disclaimer block');
eq(bs.blocks.filter(b => b.kind === 'box-start').length, bs.blocks.filter(b => b.kind === 'box-end').length, 'boxes balanced');
eq(bs.blocks.filter(b => b.kind === 'box-start').length, 6, '3 boxes per affidavit');
const caps = bs.blocks.filter(b => b.kind === 'caption-table');
eq(caps.length, 4, 'one caption per section');
ok(caps.every(c => c.sep === '\u00a7' && c.bold), '§ separator, bold');
const titles = bs.blocks.filter(b => b.kind === 'heading-2' && b.underline).map(b => b.text);
eq(titles, ['WARRANT FOR ELECTRONIC CUSTOMER DATA', 'AFFIDAVIT AND APPLICATION FOR SEARCH WARRANT',
  'WARRANT FOR ELECTRONIC CUSTOMER DATA', 'AFFIDAVIT AND APPLICATION FOR SEARCH WARRANT'], 'section titles in order');
const provParas = bs.blocks.filter(b => b.kind === 'paragraph' && b.align === 'center' && b.bold && /Snap Inc\./.test(b.text));
eq(provParas.length, 2, 'provider block in warrant + affidavit');
const recPara = bs.blocks.find(b => b.kind === 'paragraph' && b.rich && /^\*\*Records pertaining to\*\*:/.test(b.text));
ok(!!recPara, 'records lead is a rich paragraph with bold label');
const bl = bs.blocks.find(b => b.kind === 'bullets');
ok(bl && bl.items[bl.items.length - 1].bold && /^Provide Records to/.test(bl.items[bl.items.length - 1].text), 'last bullet = bold Provide Records line');
const ndoHead = bs.blocks.filter(b => b.kind === 'paragraph' && b.text === 'REQUEST FOR NON-DISCLOSURE:');
eq(ndoHead.length, 1, 'NDO heading once (snapchat only)');
const sigCols = bs.blocks.filter(b => b.kind === 'sig-columns');
eq(sigCols.length, 4, 'magistrate + affiant/judge columns per provider');
ok(sigCols[1].left.some(e => e.text === 'J. Sample #9999, DETECTIVE'), 'affiant line "Name #badge, RANK"');
ok(sigCols[1].right.some(e => e.text === 'COUNTY OF EXAMPLE'), 'judge county line');
const auth = bs.blocks.find(b => b.kind === 'paragraph' && /^Affiant is requesting this warrant/.test(b.text));
ok(auth && !auth.bold && auth.size === 11, 'closing statutory sentence: 11pt, not bold');
{
  const bsSw = builder.build({ draft: Object.assign({}, DRAFT, { swNumber: 'SW-0001' }), addendumComposes: composes.slice(0, 1), agency: AGENCY, caseInfo: {}, pcNarrative: PC });
  eq(bsSw.meta.runningHeader.left, 'SEARCH WARRANT NO:SW-0001', 'SW number fills the header');
  eq(bsSw.blocks.filter(b => b.kind === 'section-break').length, 1, '1 provider → 1 section-break');
}
{
  // Another jurisdiction is untouched by the TX branch.
  const arTpl = engine.getTemplate('ar-multi-business-esp');
  if (arTpl) {
    const arDraft = { id: 'd9', template: 'ar-multi-business-esp', jurisdiction: 'AR' };
    const arRes = engine.compose(arTpl, { addendum: mkAd('apple', [{ type: 'email', value: 'a@example.com' }]), provider: mkProvider('apple'), items, agency: AGENCY, draft: arDraft, court: { county: 'Example' }, case: CASE });
    const arBs = builder.build({ draft: arDraft, addendumComposes: [{ addendumId: 'x', providerKey: 'apple', compose: arRes }], agency: AGENCY, caseInfo: {}, pcNarrative: PC });
    ok(arBs.meta.layout !== 'tx', 'AR draft does not get the TX layout');
  }
}

// ─── 5. validator ─────────────────────────────────────────────────────
section('5. validator');
function warnCodes(input) {
  const r = validator.validateDraft(input);
  return (r.warnings || []).map(w => w.code);
}
{
  const draft = { id: 'v1', template: 'tx-multi-business-esp', jurisdiction: 'TX', addendums: [] };
  const codes = warnCodes({ draft, agency: { county: '', affiantEmail: '' }, caseCtx: {} });
  ok(codes.includes('TX_COUNTY_EMPTY'), 'TX_COUNTY_EMPTY');
  ok(codes.includes('TX_OFFENSE_DESCRIPTION_EMPTY'), 'TX_OFFENSE_DESCRIPTION_EMPTY');
  ok(codes.includes('TX_AFFIANT_EMAIL_EMPTY'), 'TX_AFFIANT_EMAIL_EMPTY');
  ok(!codes.some(c => /^AR_/.test(c)), 'no AR warnings on a TX draft');
  const codes2 = warnCodes({ draft: Object.assign({}, draft, { arCounty: 'Example' }), agency: { affiantEmail: 'j@example.gov' }, caseCtx: { offenseDescription: 'X' } });
  ok(!codes2.some(c => /^TX_/.test(c)), 'no TX warnings when county/offense/email are present');
  const codes3 = warnCodes({ draft: Object.assign({}, draft, { addendums: [{ id: 'a', txOffense: 'Y' }] }), agency: { county: 'Example', affiantEmail: 'j@example.gov' }, caseCtx: {} });
  ok(!codes3.includes('TX_OFFENSE_DESCRIPTION_EMPTY'), 'per-addendum offense override satisfies the warning');
  const codesAr = warnCodes({ draft: { id: 'v2', template: 'ar-multi-business-esp', jurisdiction: 'AR', addendums: [] }, agency: {}, caseCtx: {} });
  ok(!codesAr.some(c => /^TX_/.test(c)), 'no TX warnings on an AR draft');
}

// ─── 6. draft-store default template ──────────────────────────────────
section('6. draft-store');
eq(store.newDraft({ jurisdiction: 'TX' }).template, 'tx-multi-business-esp', 'TX default template');
eq(store.newDraft({ jurisdiction: 'AR' }).template, 'ar-multi-business-esp', 'AR unchanged');

// ─── 7. PDF ───────────────────────────────────────────────────────────
section('7. PDF');
const pdfRes = pdf.composePdf({ blockStream: bs, draft: DRAFT, agency: AGENCY });
ok(pdfRes.pageCount >= 4, 'at least one page per section');
ok(Array.isArray(pdfRes.sections) && pdfRes.sections.length === 4, '4 sections reported');
{
  let next = 1, contiguous = true;
  for (const s of pdfRes.sections) { if (s.start !== next || s.end < s.start) contiguous = false; next = s.end + 1; }
  ok(contiguous && next - 1 === pdfRes.pageCount, 'sections are contiguous and cover every page');
}
{
  const raw = Buffer.from(pdfRes.arrayBuffer).toString('latin1');
  ok(raw.indexOf('SEARCH WARRANT NO:') !== -1, 'header text present');
  const pages = (raw.match(/\(Page \d+ of \d+\)/g) || []);
  eq(pages.length, pdfRes.pageCount, 'one "Page n of m" per page');
  ok(pages[0] === '(Page 1 of ' + (pdfRes.sections[0].end) + ')', 'first section numbered from 1');
  const s2 = pdfRes.sections[1];
  ok(pages[s2.start - 1] === '(Page 1 of ' + (s2.end - s2.start + 1) + ')', 'numbering restarts in section 2');
}
{
  const one = builder.build({ draft: DRAFT, addendumComposes: composes.slice(1), agency: AGENCY, caseInfo: {}, pcNarrative: PC });
  const r = pdf.composePdf({ blockStream: one, draft: DRAFT, agency: AGENCY });
  eq(r.sections.length, 2, 'single provider → 2 sections');
}

// ─── 8. DOCX ──────────────────────────────────────────────────────────
section('8. DOCX');
(async () => {
  try {
    const JSZip = require('jszip');
    const { composeDocx } = require(W('docx-composer.js'));
    const buf = await composeDocx({ blockStream: bs, draft: DRAFT, agency: AGENCY });
    ok(Buffer.isBuffer(buf) && buf.length > 5000, 'docx buffer produced');
    const zip = await JSZip.loadAsync(buf);
    const doc = await zip.file('word/document.xml').async('string');
    eq((doc.match(/<w:sectPr/g) || []).length, 4, '4 Word sections');
    eq((doc.match(/<w:pgNumType w:start="1"/g) || []).length, 4, 'numbering restarts in every section');
    const headers = Object.keys(zip.files).filter(n => /^word\/header\d*\.xml$/.test(n));
    ok(headers.length >= 1, 'header parts exist');
    const h = await zip.file(headers[0]).async('string');
    ok(/SECTIONPAGES/.test(h), 'header uses SECTIONPAGES');
    ok(/SEARCH WARRANT NO:/.test(h), 'header text');
    ok(doc.indexOf('Records pertaining to') !== -1, 'records label in body');
    ok(doc.indexOf('Provide Records to Detective J. Sample') !== -1, 'provide-to line in body');
    ok(doc.indexOf('**') === -1, 'no raw ** markers leak into Word');
    ok((doc.match(/<w:tbl>/g) || []).length >= 4 * 1 + 6, 'caption / box / signature tables present');
    ok(doc.indexOf('\u00a7') !== -1, '§ caption separator present');
  } catch (e) {
    fail++; console.log('  FAIL: DOCX threw', e && e.stack);
  }
  console.log(`\ntx-esp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
