// modules/warrant-author/__tests__/az-esp.test.js
// Arizona Search Warrant + Affidavit (ARS 13-3911) for electronic service
// providers: ONE warrant + ONE affidavit listing every provider, then one
// ADDENDUM (items to produce) per provider; the 18 U.S.C. 2705(b)
// non-disclosure order is folded into the warrant.
// engine resolvers → block-builder (TX layout + AZ style) → PDF + DOCX.
// SYNTHETIC data only (Example County / example.gov / J. Sample).
//
// Run: node modules/warrant-author/__tests__/az-esp.test.js
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
const TPL_ID = 'az-multi-business-esp';
const tpl = engine.getTemplate(TPL_ID);
const AGENCY = {
  agencyName: 'Example City Police Department', county: 'Example',
  agencyAddress: '100 Example Ave, Example City, AZ 85000',
  affiantName: 'J. Sample', affiantRank: 'Detective', affiantBadge: '9999',
  affiantEmail: 'j.sample@example.gov',
  trainingExperienceBoilerplate: 'Your affiant, Detective J. Sample #9999, is a certified Peace Officer employed by the Example City Police Department.',
};
const PC = 'Synopsis:\nOn January 5, 2024 an example event occurred at an example address.\n\nNarrative:\nAffiant learned the following information from reading related reports.';
const CASE = { number: '24-000001', offenseDescription: 'Example Offense', offenseDate: '2024-01-05' };
const AGENT = 'Example Agent Co.\n1 Agent Way\nPhoenix, AZ 85001';

const prov = (k) => providers.find(p => p.key === k) || { key: k, name: k };
const nameOf = (k) => { const p = prov(k); return p.legalEntity || p.name; };

const ADS = [
  { id: 'a0', providerKey: 'google', targets: [{ type: 'email', value: 'example.user@gmail.com' }],
    dateRange: { start: '2024-01-01', end: '2024-02-01', allAvailable: false }, itemsToProduce: [], probableCause: PC,
    azStatutoryAgent: AGENT },
  { id: 'a1', providerKey: 'snapchat', targets: [{ type: 'username', value: 'example_user1' }],
    dateRange: { start: '2024-01-01', end: '', allAvailable: true }, itemsToProduce: [], probableCause: PC },
];
function addendumList(ads) {
  return ads.map((a, i) => ({
    pageLabel: String.fromCharCode(65 + i), providerName: nameOf(a.providerKey),
    address: prov(a.providerKey).address || '', azStatutoryAgent: a.azStatutoryAgent || '',
  }));
}
function compose(ads, idx, draftExtra, opts) {
  const o = opts || {};
  const list = addendumList(ads);
  const ad = Object.assign({ pageLabel: list[idx].pageLabel }, ads[idx]);
  return engine.compose(tpl, {
    addendum: ad,
    provider: prov(ad.providerKey),
    items,
    agency: o.agency || AGENCY,
    draft: Object.assign({ id: 'd1', template: TPL_ID, jurisdiction: 'AZ' }, draftExtra || {}),
    court: { county: 'Example' },
    case: o.case || CASE,
    addendums: o.noList ? undefined : list,
  });
}
const byKind = (res, kind) => res.blocks.filter(b => b.kind === kind);
const byKey = (res, key) => res.blocks.find(b => b.key === key);

// ─── 1. template registration + bundle parity ─────────────────────────
section('1. template + bundle');
ok(tpl && tpl.id === TPL_ID, 'template loads from templates/*.json');
ok(tpl && tpl.jurisdiction === 'AZ', 'jurisdiction AZ');
{
  const json = JSON.parse(fs.readFileSync(W('templates/' + TPL_ID + '.json'), 'utf8'));
  const registered = [];
  const sandbox = {
    window: { WarrantAuthorTemplateEngine: { registerTemplate: (t) => registered.push(t) } },
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(fs.readFileSync(W('templates-bundle.js'), 'utf8'), sandbox);
  const inBundle = registered.find(t => t.id === TPL_ID);
  ok(!!inBundle, 'bundle registers the AZ template');
  eq(inBundle, json, 'bundle entry is identical to the JSON template');
  ok(registered.length >= 9, 'bundle still registers every other template');
  ok(!!registered.find(t => t.id === 'tx-multi-business-esp'), 'TX template still registered');
}
eq(engine.AZ_GROUND_DEFS.map(g => g.key), ['stolen', 'means', 'intent', 'concealing', 'evidence', 'warrant'], 'six statutory grounds');
eq(Object.assign({}, engine.AZ_GROUND_DEFAULTS), { means: true, evidence: true }, 'grounds default to means + evidence');

// ─── 2. compose: warrant face ─────────────────────────────────────────
section('2. compose — warrant face');
const r0 = compose(ADS, 0);
const r1 = compose(ADS, 1);
eq(r0.danglingSlots, [], 'google: no dangling slots');
eq(r1.danglingSlots, [], 'snapchat: no dangling slots');
{
  const h = byKey(r0, 'w01-header');
  eq(h.kind, 'az-header', 'warrant header kind');
  eq(h.cityLine, 'CITY OF EXAMPLE CITY, ARIZONA', 'city read from agency address');
  eq(h.title, 'SEARCH WARRANT', 'title');
  eq(h.countyLine, 'COUNTY OF EXAMPLE, STATE OF ARIZONA', 'county line');
  const hc = byKey(compose(ADS, 0, { azCity: 'Override Town', arCounty: 'Other' }), 'w01-header');
  eq(hc.cityLine, 'CITY OF OVERRIDE TOWN, ARIZONA', 'azCity override prints its own city line');
  eq(hc.agencyLine, 'EXAMPLE CITY POLICE DEPARTMENT', 'agency name in full when it does not start with the override city');
  eq(hc.countyLine, 'COUNTY OF OTHER, STATE OF ARIZONA', 'county override');
}
{
  const n = byKind(r0, 'az-numbers')[0];
  ok(/^WARRANT NO\. _+$/.test(n.warrantNo), 'blank warrant number line');
  eq(n.drLine, 'DR # 24-000001', 'DR # = case number');
}
{
  const p = byKey(r0, 'w05-places');
  eq(p.person.checked, false, 'person unchecked by default');
  eq(p.premises.checked, true, 'premises checked by default');
  eq(p.vehicle.checked, false, 'vehicle unchecked by default');
  eq(p.providers.length, 2, 'every provider listed on the warrant');
  eq(p.providers.map(x => x.label), ['Addendum A', 'Addendum B'], 'addendum labels A, B');
  eq(p.providers[0].lines[0], nameOf('google'), 'provider legal name first');
  ok(p.providers[0].lines.includes('Statutory Agent: Example Agent Co.'), 'statutory agent line');
  ok(p.providers[0].lines.includes('Phoenix, AZ 85001'), 'statutory agent extra lines');
  ok(!p.providers[1].lines.some(l => /Statutory Agent/.test(l)), 'no agent line when none given');
  const p2 = byKey(compose(ADS, 0, { azPremises: false, azPerson: true, azPersonDesc: 'Example Person', azVehicle: true, azVehicleDesc: 'Example vehicle' }), 'w05-places');
  eq([p2.person.checked, p2.premises.checked, p2.vehicle.checked], [true, false, true], 'place toggles');
  eq(p2.person.text, 'on the person(s) of: Example Person', 'person description');
  eq(p2.vehicle.text, 'in the vehicle(s) described as: Example vehicle', 'vehicle description');
}
{
  const ref = byKey(r0, 'w06-concealed');
  ok(/Addendum A \(.+\) and Addendum B \(.+\)/.test(ref.ref) || /Addendum A .*Addendum B/.test(ref.ref), 'items ref names every addendum');
}
{
  const g = byKey(r0, 'w07-grounds');
  eq(g.items.filter(i => i.checked).map(i => i.key), ['means', 'evidence'], 'default grounds');
  ok(g.items.find(i => i.key === 'means').text.indexOf('that offense being Example Offense.') !== -1, 'offense fills the grounds');
  const g2 = byKey(compose(ADS, 0, { azGrounds: { stolen: true, concealing: true }, azConcealingPerson: 'Example Holder' }), 'w07-grounds');
  eq(g2.items.filter(i => i.checked).map(i => i.key), ['stolen', 'concealing'], 'custom grounds');
  ok(/in possession of Example Holder to whom/.test(g2.items.find(i => i.key === 'concealing').text), 'concealing person filled');
  const g3 = compose(ADS, 0, { azOffense: 'Override Offense' });
  ok(byKey(g3, 'w07-grounds').items[1].text.indexOf('Override Offense') !== -1, 'azOffense override');
  const g4 = compose(ADS, 0, {}, { case: { number: '24-1' } });
  ok(g4.danglingSlots.includes('case.offenseDescription'), 'missing offense → dangling');
}
{
  const s = byKey(r0, 'w08-service');
  eq(s.items.map(i => i.checked), [true, false], 'daytime by default');
  const s2 = byKey(compose(ADS, 0, { azDaytime: false, azNighttime: true }), 'w08-service');
  eq(s2.items.map(i => i.checked), [false, true], 'nighttime toggle');
}
{
  const d = byKey(r0, 'w11-delivery');
  ok(/^Each provider named above may send/.test(d.lead), 'multi-provider delivery lead');
  eq(d.lines[0], 'j.sample@example.gov', 'delivery e-mail first');
  const single = compose([ADS[0]], 0);
  ok(byKey(single, 'w11-delivery').lead.indexOf(nameOf('google') + ' may send') === 0, 'single provider named in the delivery lead');
  const noMail = compose(ADS, 0, {}, { agency: Object.assign({}, AGENCY, { affiantEmail: '' }) });
  ok(noMail.danglingSlots.includes('agency.affiantEmail'), 'missing e-mail → dangling');
}
{
  ok(!byKey(r0, 'w12-felony').omitted, 'felony warning on by default');
  ok(byKey(compose(ADS, 0, { azFelony: false }), 'w12-felony').omitted, 'felony warning off');
  const ndo = byKey(r0, 'w13-ndo');
  ok(!ndo.omitted, 'NDO on by default');
  ok(/^\*\*IT IS FURTHER ORDERED\*\*, pursuant to 18 U\.S\.C\. \u00a7 2705\(b\)/.test(ndo.text), 'NDO cites 2705(b)');
  ok(ndo.text.indexOf('for a period of') === -1, 'no time limit by default');
  ok(/the recipients of this search warrant, are not to disclose/.test(ndo.text), 'plural wording for 2 providers');
  ok(/attached Addendums\.$/.test(ndo.text), 'plural addendums');
  const n90 = byKey(compose(ADS, 0, { azNdoDays: '90' }), 'w13-ndo');
  ok(n90.text.indexOf('for a period of ninety (90) days from the date of this order') !== -1, '90-day period');
  eq(n90.period, '90', 'period recorded');
  ok(byKey(compose(ADS, 0, { azNdoDays: 180 }), 'w13-ndo').text.indexOf('one hundred eighty (180) days') !== -1, '180-day period');
  ok(byKey(compose(ADS, 0, { azNdoDays: '365' }), 'w13-ndo').text.indexOf('one (1) year') !== -1, '1-year period');
  ok(byKey(compose(ADS, 0, { azNdoDays: '7' }), 'w13-ndo').text.indexOf('for a period of') === -1, 'unknown period ignored');
  ok(byKey(compose(ADS, 0, { azNdo: false }), 'w13-ndo').omitted, 'NDO can be turned off');
  const one = byKey(compose([ADS[0]], 0), 'w13-ndo');
  ok(/the recipient of this search warrant, is not to disclose/.test(one.text), 'singular wording for 1 provider');
}

// ─── 3. compose: affidavit + addendum ─────────────────────────────────
section('3. compose — affidavit + addendum');
{
  const inf = byKind(r0, 'az-informant')[0];
  eq(inf.items.map(i => i.checked), [true, false], 'learned by default');
  eq(byKind(compose(ADS, 0, { azInformant: 'informant' }), 'az-informant')[0].items.map(i => i.checked), [false, true], 'informant toggle');
  const aff = r0.blocks.filter(b => b.kind === 'az-header' && b.variant === 'affidavit');
  eq(aff.length, 1, 'one affidavit header');
  ok(r0.blocks.some(b => typeof b.text === 'string' && b.text.indexOf('Affiant learned the following information from reading related reports.') !== -1), 'Case Facts = the probable cause narrative');
  const sig = byKind(r0, 'az-affiant-signature')[0];
  eq(sig.nameLine, 'Detective J. Sample # 9999', 'affiant line');
  ok(byKind(r0, 'az-judge').length >= 2, 'judge lines on warrant + affidavit');
  ok(!JSON.stringify(r0.blocks).match(/\d{4}-\d{2}-\d{2}/), 'no ISO dates leak into the text');
}
{
  const head = byKind(r0, 'az-addendum-heading')[0];
  eq(head.title, 'ADDENDUM A', 'addendum title');
  eq(head.providerName, nameOf('google'), 'addendum provider name');
  eq(byKind(r1, 'az-addendum-heading')[0].title, 'ADDENDUM B', 'second addendum letter');
  const acct = byKind(r0, 'az-account')[0];
  eq(acct.lines, ['Email: example.user@gmail.com'], 'account identifier line');
  eq(byKind(r1, 'az-account')[0].lines, ['Username: example_user1'], 'username label');
  const rec = byKind(r0, 'az-records')[0];
  ok(rec.lead.indexOf('January 1, 2024 to February 1, 2024') !== -1, 'date range in records lead');
  ok(rec.items.length > 0, 'records items present');
  ok(r0.blocks.filter(b => String(b.key || '').startsWith('ad-')).length >= 4, 'addendum blocks keyed ad-');
}
{
  const bare = compose(ADS, 0, {}, { noList: true });
  const pl = byKey(bare, 'w05-places');
  eq(pl.providers.length, 1, 'bare ctx degrades to the composed provider');
}

// ─── 4. block-builder ─────────────────────────────────────────────────
section('4. block-builder');
const DRAFT = { id: 'd1', template: TPL_ID, jurisdiction: 'AZ', swNumber: '' };
const composes = [
  { addendumId: 'a0', providerKey: 'google', compose: r0 },
  { addendumId: 'a1', providerKey: 'snapchat', compose: r1 },
];
const bs = builder.build({ draft: DRAFT, addendumComposes: composes, agency: AGENCY, caseInfo: CASE, pcNarrative: PC, includeDisclaimer: true });
eq(bs.meta.jurisdiction, 'AZ', 'meta.jurisdiction AZ');
eq(bs.meta.layout, 'tx', 'reuses the flexible TX layout engine');
eq(bs.meta.txStyle, { pdfFont: 'helvetica', docxFont: 'Verdana', margin: 36, top: 36, bottom: 36 }, 'AZ style');
eq(bs.meta.runningHeader.enabled, false, 'no running header');
ok(bs.stats.arizona === true && bs.stats.addendums === 2, 'stats');
ok(!bs.blocks.some(b => b.kind === 'footer-disclaimer'), 'no disclaimer block');
{
  const texts = bs.blocks.filter(b => b.kind === 'paragraph').map(b => b.text);
  eq(texts.filter(t => t === 'SEARCH WARRANT').length, 1, 'ONE warrant');
  eq(texts.filter(t => /^ADDENDUM [A-Z]$/.test(t)), ['ADDENDUM A', 'ADDENDUM B'], 'one addendum per provider, in order');
  const cbs = bs.blocks.filter(b => b.kind === 'checkbox');
  ok(cbs.length >= 3 + 6 + 2 + 6 + 2, 'checkbox blocks for places/grounds/service/informant');
  ok(cbs.every(c => typeof c.checked === 'boolean' && typeof c.text === 'string'), 'checkbox shape');
  ok(bs.blocks.some(b => b.kind === 'paragraph' && b.rich && /^\*\*IT IS FURTHER ORDERED\*\*/.test(b.text)), 'NDO paragraph is rich');
  ok(bs.blocks.some(b => b.kind === 'paragraph' && b.align === 'right' && /^WARRANT NO\./.test(b.text)), 'warrant number right-aligned');
  ok(bs.blocks.some(b => b.kind === 'paragraph' && b.indent > 0), 'indented paragraphs');
  ok(bs.blocks.filter(b => b.kind === 'sig-columns').length >= 3, 'signature blocks');
}
{
  const empty = builder.build({ draft: DRAFT, addendumComposes: [], agency: AGENCY });
  ok(empty.blocks.length === 1 && /No provider attached/.test(empty.blocks[0].text), 'no providers → placeholder');
  const tx = builder.build({ draft: { id: 't', template: 'tx-multi-business-esp', jurisdiction: 'TX' }, addendumComposes: [], agency: AGENCY });
  ok(!tx.meta.txStyle, 'TX draft has no AZ style');
}

// ─── 5. validator ─────────────────────────────────────────────────────
section('5. validator');
function warnCodes(input) {
  const r = validator.validateDraft(input);
  return (r.warnings || []).map(w => w.code);
}
{
  const draft = { id: 'v1', template: TPL_ID, jurisdiction: 'AZ', addendums: [] };
  const codes = warnCodes({ draft, agency: { county: '', affiantEmail: '' }, caseCtx: {} });
  ['AZ_COUNTY_EMPTY', 'AZ_CITY_EMPTY', 'AZ_OFFENSE_DESCRIPTION_EMPTY', 'AZ_AFFIANT_EMAIL_EMPTY'].forEach(c => ok(codes.includes(c), c));
  ok(!codes.some(c => /^(TX|AR)_/.test(c)), 'no TX/AR warnings on an AZ draft');
  const codes2 = warnCodes({ draft, agency: AGENCY, caseCtx: { offenseDescription: 'X' } });
  ok(!codes2.some(c => /^AZ_/.test(c)), 'no AZ warnings when everything is present');
  const codes3 = warnCodes({ draft: Object.assign({}, draft, { arCounty: 'Example', azCity: 'Example City', azOffense: 'Y' }),
    agency: { affiantEmail: 'j@example.gov', agencyAddress: 'unparseable' }, caseCtx: {} });
  ok(!codes3.some(c => /^AZ_/.test(c)), 'draft overrides satisfy the warnings');
  const codes4 = warnCodes({ draft, agency: Object.assign({}, AGENCY, { agencyAddress: '100 Example Ave\nExample City, AZ 85000' }), caseCtx: { offenseDescription: 'X' } });
  ok(!codes4.includes('AZ_CITY_EMPTY'), 'multi-line agency address parses');
  const codesTx = warnCodes({ draft: { id: 'v2', template: 'tx-multi-business-esp', jurisdiction: 'TX', addendums: [] }, agency: {}, caseCtx: {} });
  ok(!codesTx.some(c => /^AZ_/.test(c)), 'no AZ warnings on a TX draft');
}

// ─── 6. draft-store default template ──────────────────────────────────
section('6. draft-store');
eq(store.newDraft({ jurisdiction: 'AZ' }).template, TPL_ID, 'AZ default template');
eq(store.newDraft({ jurisdiction: 'TX' }).template, 'tx-multi-business-esp', 'TX unchanged');

// ─── 7. PDF ───────────────────────────────────────────────────────────
section('7. PDF');
const pdfRes = pdf.composePdf({ blockStream: bs, draft: DRAFT, agency: AGENCY });
ok(pdfRes.pageCount >= 4, 'warrant + affidavit + 2 addendums → at least 4 pages');
{
  const raw = Buffer.from(pdfRes.arrayBuffer).toString('latin1');
  ok(raw.indexOf('SEARCH WARRANT NO:') === -1, 'no TX running header');
  // jsPDF lists all 14 standard fonts; F1-F4 = Helvetica family, F9-F12 = Times.
  const used = new Set((raw.match(/\/F\d+ [\d.]+ Tf/g) || []).map(x => x.split(' ')[0]));
  ok(used.size > 0 && [...used].every(f => ['/F1', '/F2', '/F3', '/F4'].includes(f)), 'only Helvetica faces drawn');
  ok(/\/F1 17 0 R/.test(raw) && /17 0 obj\s*<<\s*\/Type \/Font\s*\/BaseFont \/Helvetica\b/.test(raw), 'F1 is Helvetica');
  ok((raw.match(/\(ADDENDUM\)/g) || []).length >= 2, 'both addendums rendered');
}
{
  // TX output still uses Times after an AZ compose (style is reset).
  const txTpl = engine.getTemplate('tx-multi-business-esp');
  const txAd = { providerKey: 'snapchat', targets: [{ type: 'username', value: 'example_user1' }],
    dateRange: { start: '2024-01-01', end: '2024-02-01' }, itemsToProduce: [], probableCause: PC };
  const txRes = engine.compose(txTpl, { addendum: txAd, provider: prov('snapchat'), items, agency: AGENCY,
    draft: { id: 't', template: 'tx-multi-business-esp', jurisdiction: 'TX' }, court: { county: 'Example' }, case: CASE });
  const txBs = builder.build({ draft: { id: 't', template: 'tx-multi-business-esp', jurisdiction: 'TX' },
    addendumComposes: [{ addendumId: 't', providerKey: 'snapchat', compose: txRes }], agency: AGENCY, caseInfo: {}, pcNarrative: PC });
  const raw = Buffer.from(pdf.composePdf({ blockStream: txBs, draft: {}, agency: AGENCY }).arrayBuffer).toString('latin1');
  const txUsed = new Set((raw.match(/\/F\d+ [\d.]+ Tf/g) || []).map(x => x.split(' ')[0]));
  ok([...txUsed].some(f => ['/F9', '/F10', '/F11', '/F12'].includes(f)), 'TX PDF still Times after AZ');
  ok(raw.indexOf('SEARCH WARRANT NO:') !== -1, 'TX header still stamped');
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
    ok(/<w14:checkbox>/.test(doc), 'Word checkbox content controls');
    ok((doc.match(/<w14:checkbox>/g) || []).length >= 19, 'one control per checkbox line');
    ok(/w:ascii="Verdana"/.test(doc), 'Verdana face');
    ok(!/Times New Roman/.test(doc), 'no Times New Roman runs');
    ok(/w:top="720"/.test(doc) && /w:left="720"/.test(doc) && /w:right="720"/.test(doc), '0.5" margins');
    const headers = Object.keys(zip.files).filter(n => /^word\/header\d*\.xml$/.test(n));
    eq(headers.length, 0, 'no header parts');
    ok(doc.indexOf('**') === -1, 'no raw ** markers leak into Word');
    ok(doc.indexOf('IT IS FURTHER ORDERED') !== -1, 'NDO in body');
    ok(doc.indexOf('ADDENDUM A') !== -1 && doc.indexOf('ADDENDUM B') !== -1, 'both addendums in body');
    // TX DOCX unaffected afterwards.
    const txTpl = engine.getTemplate('tx-multi-business-esp');
    const txRes = engine.compose(txTpl, { addendum: { providerKey: 'snapchat', targets: [{ type: 'username', value: 'u' }],
      dateRange: { start: '2024-01-01', end: '2024-02-01' }, itemsToProduce: [], probableCause: PC }, provider: prov('snapchat'), items,
      agency: AGENCY, draft: { id: 't', template: 'tx-multi-business-esp', jurisdiction: 'TX' }, court: { county: 'Example' }, case: CASE });
    const txBs = builder.build({ draft: { id: 't', template: 'tx-multi-business-esp', jurisdiction: 'TX' },
      addendumComposes: [{ addendumId: 't', providerKey: 'snapchat', compose: txRes }], agency: AGENCY, caseInfo: {}, pcNarrative: PC });
    const txBuf = await composeDocx({ blockStream: txBs, draft: {}, agency: AGENCY });
    const txZip = await JSZip.loadAsync(txBuf);
    const txDoc = await txZip.file('word/document.xml').async('string');
    ok(/Times New Roman/.test(txDoc), 'TX DOCX still Times New Roman after AZ');
    ok(Object.keys(txZip.files).some(n => /^word\/header\d*\.xml$/.test(n)), 'TX DOCX still has headers');
  } catch (e) {
    fail++; console.log('  FAIL: DOCX threw', e && e.stack);
  }
  console.log(`\naz-esp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
