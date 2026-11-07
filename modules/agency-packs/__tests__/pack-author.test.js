'use strict';
// Tests for modules/agency-packs/pack-author.js — all data SYNTHETIC.
// Run: node modules/agency-packs/__tests__/pack-author.test.js
const AdmZip = require('adm-zip');
const A = require('../pack-author.js');
const BM = require('../builder-model.js');
const F = require('../docx-form-engine.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, label + ' — got ' + x + ', want ' + y); }
function throws(fn, re, label) { try { fn(); ok(false, label + ' (no throw)'); } catch (e) { ok(re.test(e.message), label + ' — ' + e.message); } }

const scan = (...names) => ({ placeholders: names.map(n => ({ name: n, count: 1, context: 'ctx ' + n })) });
let seq = 0;
const opts = { newId: () => 'g' + (++seq) };

// ---- small helpers ----
eq(A.bumpVersion('1.0.1'), '1.0.2', 'bump x.y.z');
eq(A.bumpVersion('2.3'), '2.3.1', 'bump x.y');
eq(A.bumpVersion('4'), '4.0.1', 'bump x');
eq(A.bumpVersion(''), '1.0.0', 'bump empty');
eq(A.bumpVersion('v2-beta'), 'v2-beta.1', 'bump odd');
eq(A.makePackId('Springfield PD — Warrants!', []), 'springfield-pd-warrants', 'id slug');
eq(A.makePackId('Springfield PD', ['springfield-pd']), 'springfield-pd-2', 'id unique');
eq(A.makePackId('!', []), 'agency-pack', 'id fallback');
ok(/^[a-z0-9][a-z0-9-]{1,62}$/.test(A.makePackId('x'.repeat(200), [])), 'id within pack-store ID_RE');

// ---- templates + auto-link ----
const c = A.newConfig();
const relA = A.templateRelFor(c, 'C:\\fake\\Phone Records_Template.docx');
eq(relA, 'Phone Records_Template.docx', 'rel from path');
eq(A.templateRelFor(c, 'con.docx'), 'Template con.docx', 'rel reserved name');
eq(A.templateRelFor(c, 'a<b>:c?.docx'), 'a b c.docx', 'rel illegal chars');
let r = A.addTemplate(c, relA, scan('Case Number', 'Suspect Name', 'Brown/Black', 'Only In A'), Object.assign({ category: 'Search Warrant' }, opts));
eq([r.fields, r.created], [4, 0], 'add A: no shared yet');
eq(c.templatesConfig[relA].placeholders[2].type, 'dropdown', 'detected dropdown');
eq(c.templatesConfig[relA].placeholders[2].choices, ['Brown', 'Black'], 'detected choices');
eq(c.templatesConfig[relA].placeholders[0].context, 'ctx Case Number', 'context kept');
eq(A.templateRelFor(c, 'phone records_template.docx'), 'phone records_template (2).docx', 'rel unique (case-insensitive)');
throws(() => A.addTemplate(c, relA, scan('x')), /already/, 'add twice');

const relB = 'Arrest.docx';
r = A.addTemplate(c, relB, scan('case number', 'Suspect Name', 'Only In B'), Object.assign({ category: 'Arrest Warrant' }, opts));
eq([r.created, r.linked], [2, 4], 'add B: case number + suspect name shared');
const gCase = c.globalFields.find(g => g.mappings.some(m => m.placeholderName === 'case number'));
eq(gCase.mappings.length, 2, 'auto-link ignores case/space');
eq(gCase.name, 'Case Number', 'shared label from first template');

const relC = 'Third.docx';
r = A.addTemplate(c, relC, scan('Case Number', 'Only In A'), opts);
eq(gCase.mappings.length, 3, 'joins existing shared field');
eq(c.templatesConfig[relC].category, A.DEFAULT_CATEGORY, 'default category');
eq(c.globalFields.length, 3, 'Only In A now shared (A + C)');
eq(A.categories(c), ['Search Warrant', 'Arrest Warrant'], 'categories');
A.setCategory(c, relC, '  Court Order ');
eq(c.templatesConfig[relC].category, 'Court Order', 'set category');

// ---- listFields ----
let L = A.listFields(c, {});
eq(L.shared.map(f => f.label), ['Case Number', 'Only In A', 'Suspect Name'], 'shared list sorted');
eq(L.own.map(f => f.label), ['Brown/Black', 'Only In B'], 'own fields');
const fCase = L.shared[0];
eq([fCase.effectiveAutofill, fCase.effectiveKind, fCase.kind], ['case:caseNumber', 'text', ''], 'effective autofill from name rules');
eq(fCase.uses.length, 3, 'uses listed');
eq(A.parseRef(fCase.key), fCase.ref, 'ref key round-trip');
eq(A.parseRef('not json'), null, 'bad ref key');

// ---- updateField ----
A.updateField(c, fCase.ref, { label: 'Report #' }, {});
L = A.listFields(c, {});
const fRep = L.shared.find(f => f.label === 'Report #');
eq(fRep.autofill, 'case:caseNumber', 'rename pins the old autofill');
eq(fRep.effectiveAutofill, 'case:caseNumber', 'rename keeps autofill working');
A.updateField(c, fRep.ref, { autofill: 'none' }, {});
eq(A.listFields(c, {}).shared.find(f => f.label === 'Report #').effectiveAutofill, '', 'autofill none');
A.updateField(c, fRep.ref, { autofill: '' }, {});
eq(A.listFields(c, {}).shared.find(f => f.label === 'Report #').effectiveAutofill, '', 'automatic again: new name has no rule');
throws(() => A.updateField(c, fRep.ref, { autofill: 'case:bogus' }), /autofill/, 'bad autofill');
throws(() => A.updateField(c, fRep.ref, { kind: 'bogus' }), /type/, 'bad kind');
throws(() => A.updateField(c, fRep.ref, { label: '   ' }), /label/, 'empty label');
throws(() => A.updateField(c, { g: 'nope' }, {}), /not found/, 'missing field');

const own = { t: relB, p: 'Only In B' };
A.updateField(c, own, { kind: 'date', hint: ' Day it happened ', hidden: true }, {});
let p = c.templatesConfig[relB].placeholders.find(x => x.name === 'Only In B');
eq([p.kind, p.type, p.hint, p.hidden], ['date', 'text', 'Day it happened', true], 'own field settings');
A.updateField(c, own, { kind: 'dropdown', choices: [' Yes ', 'No', 'Yes', ''] }, {});
eq([p.type, p.choices], ['dropdown', ['Yes', 'No']], 'dropdown + cleaned choices');
A.updateField(c, own, { kind: '', hidden: null }, {});
eq([p.kind, p.type, 'hidden' in p], [undefined, 'dropdown', false], 'automatic kind keeps dropdown when choices exist');
A.updateField(c, { t: relA, p: 'Brown/Black' }, { label: 'Start date' }, {});
p = c.templatesConfig[relA].placeholders.find(x => x.name === 'Brown/Black');
eq(p.kind, 'dropdown', 'rename into a date-rule name pins dropdown');
throws(() => A.updateField(c, { t: relA, p: 'Case Number' }, { hint: 'x' }), /not found/, 'shared placeholder not editable as own field');

// ---- merge / split + value migration ----
const before = BM.createBuilder(A.clone(c), {});
const keyOwnB = before.fieldKeyTemplate(relB, 'Only In B');
const keyOwnA = before.fieldKeyTemplate(relA, 'Brown/Black');
const values = { [keyOwnB]: 'typed B', [keyOwnA]: 'typed A' };
const merged = A.mergeFields(c, own, { t: relA, p: 'Brown/Black' }, opts);
ok(merged.g, 'merge two own fields makes a shared field');
const gm = c.globalFields.find(g => g.id === merged.g);
eq(gm.mappings.length, 2, 'merged mappings');
eq(gm.name, 'Only In B', 'merged keeps target label');
let b2 = BM.createBuilder(A.clone(c), {});
b2.migrateValues(values);
eq(values['global:' + merged.g], 'typed B', 'merge: target value kept');

const gSus = c.globalFields.find(g => g.name === 'Suspect Name');
const into = A.mergeFields(c, { g: gSus.id }, merged, opts);
eq(into.g, gSus.id, 'merge shared into shared');
ok(!c.globalFields.some(g => g.id === merged.g), 'source shared field removed');
ok(gSus.aliases.includes('global:' + merged.g), 'alias recorded');
const v2 = { ['global:' + merged.g]: 'from merged' };
BM.createBuilder(A.clone(c), {}).migrateValues(v2);
eq(v2['global:' + gSus.id], 'from merged', 'merge: value follows alias');
throws(() => A.mergeFields(c, { g: gSus.id }, { g: gSus.id }), /different/, 'merge self');

const sp = A.splitField(c, gSus.id, relB, 'Suspect Name');
p = c.templatesConfig[relB].placeholders.find(x => x.name === 'Suspect Name');
eq([sp.t, p.unlinked, p.customTitle], [relB, true, 'Suspect Name'], 'split out');
ok(p.aliases.includes('global:' + gSus.id), 'split alias');
ok(p.customTag !== gSus.tag || !gSus.mappings.some(m => m.templateId === relB), 'split tag does not collide in its template');
const v3 = { ['global:' + gSus.id]: 'Jane SYNTHETIC' };
const b3 = BM.createBuilder(A.clone(c), {});
b3.migrateValues(v3);
eq(v3[b3.fieldKeyTemplate(relB, 'Suspect Name')], 'Jane SYNTHETIC', 'split: value carried');
A.autoLink(c, opts);
ok(!BM.createBuilder(c, {}).globalFor(BM.createBuilder(c, {}).getTemplate(relB), p), 'auto-link leaves split field alone');
throws(() => A.splitField(c, gSus.id, relB, 'Suspect Name'), /not part/, 'split twice');

// Separating one of only two templates ends the shared field: both go back to their own templates.
{
  const c2 = A.newConfig();
  A.addTemplate(c2, 'X.docx', scan('Phone Number'), opts);
  A.addTemplate(c2, 'Y.docx', scan('Target Phone'), opts);
  const m2 = A.mergeFields(c2, { t: 'X.docx', p: 'Phone Number' }, { t: 'Y.docx', p: 'Target Phone' }, opts);
  A.updateField(c2, m2, { hint: 'SYNTHETIC hint' }, {});
  const vals2 = { ['global:' + m2.g]: '555-0100' };
  A.splitField(c2, m2.g, 'X.docx', 'Phone Number');
  eq(c2.globalFields.length, 0, 'split of a two-template field: shared field gone');
  const L2 = A.listFields(c2, {});
  eq([L2.shared.length, L2.own.length], [0, 2], 'split of a two-template field: two own fields');
  const py = c2.templatesConfig['Y.docx'].placeholders[0];
  eq([py.hint, !!py.unlinked], ['SYNTHETIC hint', false], 'remaining field keeps the settings, can link again by name');
  ok(c2.templatesConfig['X.docx'].placeholders[0].unlinked === true, 'separated field stays separate');
  eq(L2.own.map(f => f.label).sort(), ['Phone Number', 'Target Phone'], 'split: each field gets its own name back, not the other template\'s');
  const b4 = BM.createBuilder(A.clone(c2), {});
  b4.migrateValues(vals2);
  eq([vals2[b4.fieldKeyTemplate('X.docx', 'Phone Number')], vals2[b4.fieldKeyTemplate('Y.docx', 'Target Phone')]], ['555-0100', '555-0100'], 'split of a two-template field: both keep the typed value');
}

// ---- replace / remove template ----
const gOnlyA = c.globalFields.find(g => g.name === 'Only In A');
r = A.replaceTemplate(c, relC, scan('Case Number', 'Brand New'), opts);
eq([r.added, r.removed, r.kept], [['Brand New'], ['Only In A'], ['Case Number']], 'replace: diff');
eq(gOnlyA.mappings.length, 1, 'replace: removed field unmapped');
ok(c.globalFields.includes(gOnlyA), 'still used by A, kept');
eq(c.templatesConfig[relC].placeholders.find(x => x.name === 'Case Number').context, 'ctx Case Number', 'replace: context refreshed');
A.updateField(c, { t: relC, p: 'Brand New' }, { hint: 'keep me' }, {});
A.replaceTemplate(c, relC, scan('Brand New'), opts);
eq(c.templatesConfig[relC].placeholders[0].hint, 'keep me', 'replace: settings kept for unchanged names');
A.removeTemplate(c, relA);
ok(!c.templatesConfig[relA], 'removed');
ok(!c.globalFields.includes(gOnlyA), 'shared field with no template left is dropped');
ok(c.globalFields.every(g => g.mappings.every(m => m.templateId !== relA)), 'no mappings to removed template');
throws(() => A.removeTemplate(c, relA), /not found/, 'remove twice');

// ---- checkDraft ----
eq(A.checkDraft({ meta: {}, config: A.newConfig() }).errors.length, 2, 'draft: name + template required');
const chk = A.checkDraft({ meta: { name: 'X' }, config: { templatesConfig: { 'E.docx': { placeholders: [] } } } });
eq([chk.ok, chk.warnings.length], [true, 1], 'draft: empty template warns');

// ---- end to end: scan a synthetic docx, author, build mapping, fill ----
{
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const hl = (t) => '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const pl = (t) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));
  z.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="' + W + '"><w:body>' +
    '<w:p>' + pl('Report ') + hl('[Case Number]') + pl(' on ') + hl('[Incident Day]') + '</w:p></w:body></w:document>'));
  const bytes = z.toBuffer();
  const cfg = A.newConfig();
  A.addTemplate(cfg, 'E2E.docx', F.scanTemplate(bytes), opts);
  A.updateField(cfg, { t: 'E2E.docx', p: 'Incident Day' }, { kind: 'date', autofill: 'case:offenseDate' }, {});
  const b = BM.createBuilder(cfg, {});
  const model = b.formModel(['E2E.docx']);
  const vals = b.applyCaseFacts(model, {}, { caseNumber: '26-SYN-1', offenseDate: '2026-02-03' });
  const res = b.resolveValues('E2E.docx', vals);
  eq(res.values, { 'Case Number': '26-SYN-1', 'Incident Day': '02/03/2026' }, 'e2e: autofill + date');
  const out = F.convertDocx(bytes, b.placeholderMapping('E2E.docx'), { values: res.values, protect: false });
  const xml = new AdmZip(out).readAsText('word/document.xml');
  ok(xml.includes('26-SYN-1') && xml.includes('02/03/2026'), 'e2e: filled docx');
}

console.log(`pack-author: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
