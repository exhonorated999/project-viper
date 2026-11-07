'use strict';
// Tests for modules/agency-packs/pack-drafts.js (the pack editor's main-process side) and
// pack-store's buildPackBuffer / installBuffer / exportBuffer.
// Everything here is SYNTHETIC and written to the OS temp folder.
// Run: node modules/agency-packs/__tests__/pack-drafts.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const S = require('../pack-store.js');
const D = require('../pack-drafts.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
function throws(fn, re, label) {
  try { fn(); ok(false, label + ' — did not throw'); } catch (e) {
    ok(re.test(e.message), label + ' — wrong error: ' + e.message);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-packdrafts-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

// ---- Synthetic Word templates -----------------------------------------------------------------
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const hl = (t) => '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
const plain = (t) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
function makeDocx(paras) {
  const zip = new AdmZip();
  const body = paras.map(p => '<w:p>' + p + '</w:p>').join('');
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + W_NS + '"><w:body>' + body + '</w:body></w:document>'));
  zip.addFile('word/settings.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="' + W_NS + '"><w:zoom w:percent="100"/></w:settings>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  return zip.toBuffer();
}
const SRC = path.join(TMP, 'src');
fs.mkdirSync(SRC, { recursive: true });
const put = (name, buf) => { const p = path.join(SRC, name); fs.writeFileSync(p, buf); return p; };
const DOC_A = put('Example Phone Co.docx', makeDocx([
  plain('Case: ') + hl('[case number]'),
  plain('Account ') + hl('[target phone number]') + plain(' held by the provider.'),
  plain('Sworn by ') + hl('[affiant name]'),
  plain('Plain [not highlighted] text.'),
]));
const DOC_B = put('Example Mail Co.docx', makeDocx([
  plain('Case: ') + hl('[case number]'),
  plain('Mailbox ') + hl('[email address]'),
  plain('Sworn by ') + hl('[affiant name]'),
  plain('Broken [field never closed'),
]));
const DOC_A2 = put('Example Phone Co v2.docx', makeDocx([
  plain('Case: ') + hl('[case number]'),
  plain('Account ') + hl('[target phone number]'),
  plain('Dates ') + hl('[date range]'),
]));
const NOT_DOCX = put('notes.txt', Buffer.from('SYNTHETIC text'));
const FAKE_DOCX = put('fake.docx', Buffer.from('SYNTHETIC not a zip'));

// ---- buildPackBuffer / installBuffer / exportBuffer -------------------------------------------
const ROOT = path.join(TMP, 'userData', 'agency-packs');
const DROOT = path.join(TMP, 'userData', 'agency-pack-drafts');
let clock = Date.parse('2026-01-02T03:04:05Z');
const now = () => (clock += 1000);
const store = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: ROOT, now });
const ph = (name) => ({ name, customTitle: name, customTag: name.replace(/[^A-Za-z0-9]/g, '_'), type: 'text', choices: [] });
const CLI_CONFIG = {
  globalFields: [], unbracketedFields: [], filenameSuffixFields: {},
  templatesConfig: { 'Example Phone Co.docx': { category: 'Search Warrant', placeholders: [ph('case number'), ph('target phone number'), ph('affiant name')] } },
};
const CLI_RULES = { typeTokens: { 'Search Warrant': 'SW' }, counties: [{ label: 'North County', countyValue: 'NORTH' }] };
const tplA = fs.readFileSync(DOC_A);
let CLI_CREATED = null;

{
  const b = S.buildPackBuffer({ id: 'cli-pack', name: 'CLI pack', agency: 'Example agency', packVersion: '2.3', rules: CLI_RULES, config: CLI_CONFIG,
    templates: new Map([['Example Phone Co.docx', tplA]]) }, { AdmZip, crypto });
  ok(Buffer.isBuffer(b.buffer) && b.buffer[0] === 0x50, 'buildPackBuffer returns a zip');
  CLI_CREATED = b.manifest.createdAt;
  eq(Object.keys(b.manifest.files).sort(), ['config.json', 'templates/Example Phone Co.docx'], 'manifest lists config + template');
  eq(b.manifest.builder, CLI_RULES, 'rules in manifest');
  const f = path.join(TMP, 'cli.viperpack');
  fs.writeFileSync(f, b.buffer);
  const p = store.readPackFile(f);
  eq([p.manifest.id, p.manifest.packVersion], ['cli-pack', '2.3'], 'buffer reads back as a valid pack');
  throws(() => S.buildPackBuffer({ id: 'x-pack', name: 'X', packVersion: '1', config: CLI_CONFIG, templates: [] }), /missing/, 'missing template refused');
  throws(() => S.buildPackBuffer({ id: 'x-pack', name: 'X', packVersion: '1', config: CLI_CONFIG, templates: [['Example Phone Co.docx', Buffer.from('nope')]] }), /Not a Word/, 'non-docx template refused');
  throws(() => S.buildPackBuffer({ id: 'Bad Id', name: 'X', packVersion: '1', config: CLI_CONFIG, templates: [] }), /id/, 'bad id refused');
  throws(() => S.buildPackBuffer({ id: 'x-pack', name: ' ', packVersion: '1', config: CLI_CONFIG, templates: [['Example Phone Co.docx', tplA]] }), /name/, 'blank name refused');
  throws(() => S.buildPackBuffer({ id: 'x-pack', name: 'X', packVersion: '1', config: { templatesConfig: {} }, templates: [] }), /no templates/, 'empty pack refused');
  const inst = store.installBuffer(b.buffer, 'test');
  eq([inst.id, inst.packVersion, inst.templateCount], ['cli-pack', '2.3', 1], 'installBuffer installs');
  ok(!fs.readdirSync(store.stagingRoot).some(n => /\.viperpack$/.test(n)), 'installBuffer leaves no temp pack behind');
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli-pack', 'install-info.json'), 'utf8'));
  eq(info.sourceName, 'test', 'source name recorded');
  const ex = store.exportBuffer('cli-pack');
  eq(ex.manifest.files, b.manifest.files, 'export has the same files and hashes');
  eq([ex.manifest.createdAt, ex.manifest.packVersion], [b.manifest.createdAt, '2.3'], 'export keeps createdAt + version');
  const f2 = path.join(TMP, 'exported.viperpack');
  fs.writeFileSync(f2, ex.buffer);
  eq(store.inspect(f2).templateCount, 1, 'exported pack inspects');
  fs.writeFileSync(path.join(ROOT, 'cli-pack', 'templates', 'Example Phone Co.docx'), Buffer.from('PK tampered'));
  throws(() => store.exportBuffer('cli-pack'), /changed on disk/, 'export refuses a tampered install');
  store.installBuffer(b.buffer, 'test');
}

// ---- Drafts: create, add, edit ------------------------------------------------------------------
const drafts = D.createDraftStore({ fs, path, crypto, AdmZip, store, rootDir: DROOT, now });
throws(() => drafts.create({ name: '  ' }), /name/, 'draft needs a name');
let v = drafts.create({ name: 'Example Warrants', agency: 'Example PD', description: 'SYNTHETIC' });
eq(v.id, 'example-warrants', 'id from the name');
eq([v.meta.name, v.meta.agency, v.meta.packVersion, v.meta.nextVersion, v.dirty], ['Example Warrants', 'Example PD', null, '1.0.0', true], 'new draft meta');
eq(v.check.ok, false, 'empty draft cannot be saved');
eq(drafts.create({ name: 'Example Warrants' }).id, 'example-warrants-2', 'second draft with the same name gets a new id');
drafts.discard('example-warrants-2');
eq(drafts.create({ name: 'CLI pack' }).id, 'cli-pack-2', 'installed ids are taken too');
drafts.discard('cli-pack-2');

let r = drafts.addTemplates('example-warrants', [DOC_A, DOC_B, NOT_DOCX, FAKE_DOCX], { category: 'Search Warrant' });
eq(r.results.map(x => !!x.error), [false, false, true, true], 'bad files reported, good ones added');
ok(/not a Word/.test(r.results[2].error), 'txt refused: ' + r.results[2].error);
ok(/fake\.docx: Not a Word/.test(r.results[3].error), 'fake docx refused: ' + r.results[3].error);
eq([r.results[0].rel, r.results[0].fields], ['Example Phone Co.docx', 3], 'template A added with 3 fields');
eq(r.results[0].unhighlighted, 1, 'unhighlighted bracket counted');
eq(r.results[1].unclosed, 1, 'unclosed bracket counted');
v = r.draft;
eq(v.templates.map(t => t.rel), ['Example Mail Co.docx', 'Example Phone Co.docx'], 'templates listed');
eq(v.templates[1].unhighlighted, ['not highlighted'], 'note text kept');
eq(v.fields.shared.map(f => f.label).sort(), ['affiant name', 'case number'], 'same names auto-linked');
eq(v.fields.own.map(f => f.label).sort(), ['email address', 'target phone number'], 'own fields');
ok(v.check.ok, 'draft with templates can be saved');
ok(fs.existsSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Phone Co.docx')), 'template copied into the draft');
ok(!fs.existsSync(path.join(DROOT, 'example-warrants', 'templates', 'fake.docx')), 'refused file not copied');
r = drafts.addTemplates('example-warrants', [DOC_A]);
eq([r.results.length, r.conflicts.length], [0, 1], 'same template again is a question, not a copy');
eq(r.conflicts[0], { file: 'Example Phone Co.docx', path: DOC_A, rel: 'Example Phone Co.docx', title: 'Example Phone Co' }, 'conflict names the template it matches');
eq(r.draft.templates.length, 2, 'nothing added for a conflict');
ok(!fs.existsSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Phone Co (2).docx')), 'no copy written for a conflict');
{
  // Matches ignore case, "_Template", folders and a copy number; different names are not matched.
  const d1 = put('EXAMPLE PHONE CO_Template.docx', fs.readFileSync(DOC_A));
  const d2 = put('Example Phone Co (3).docx', fs.readFileSync(DOC_A));
  const rr = drafts.addTemplates('example-warrants', [d1, d2, DOC_A2, FAKE_DOCX]);
  eq(rr.conflicts.map(c => c.rel), ['Example Phone Co.docx', 'Example Phone Co.docx'], 'loose name matches');
  eq(rr.results.map(x => x.rel || 'error'), ['Example Phone Co v2.docx', 'error'], 'other files still added; bad file still an error, not a conflict');
  drafts.op('example-warrants', 'removeTemplate', { rel: 'Example Phone Co v2.docx' });
}
r = drafts.addTemplates('example-warrants', [DOC_A], { duplicates: 'add' });
eq([r.results[0].rel, r.conflicts.length], ['Example Phone Co (2).docx', 0], 'officer chose "add as a separate template"');
v = drafts.op('example-warrants', 'removeTemplate', { rel: 'Example Phone Co (2).docx' });
ok(!fs.existsSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Phone Co (2).docx')), 'removed template file deleted');
eq(v.templates.length, 2, 'template removed');

const caseNo = v.fields.shared.find(f => f.label === 'case number');
v = drafts.op('example-warrants', 'updateField', { ref: caseNo.key, patch: { label: 'Case Number', hint: 'Your report number', autofill: 'case:caseNumber' } });
const cn = v.fields.shared.find(f => f.label === 'Case Number');
ok(cn && cn.hint === 'Your report number' && cn.autofill === 'case:caseNumber', 'shared field updated');
v = drafts.op('example-warrants', 'setMeta', { name: 'Example Warrant Packet', agency: 'Example PD ', description: 'SYNTHETIC set' });
eq([v.meta.name, v.meta.agency, v.id], ['Example Warrant Packet', 'Example PD', 'example-warrants'], 'meta updated, id unchanged');
throws(() => drafts.op('example-warrants', 'setMeta', { name: '' }), /name/, 'blank name refused');
v = drafts.op('example-warrants', 'setCategory', { rel: 'Example Mail Co.docx', category: 'Preservation Request' });
eq(v.categories.sort(), ['Preservation Request', 'Search Warrant'], 'category changed');
// Adding the same file twice linked 'target phone number' across both copies; removing the copy
// leaves it a shared field used by one template.
const all = () => v.fields.shared.concat(v.fields.own);
const phone = all().find(f => f.label === 'target phone number');
const mail = all().find(f => f.label === 'email address');
v = drafts.op('example-warrants', 'mergeFields', { into: phone.key, from: mail.key });
const merged = v.fields.shared.find(f => f.label === 'target phone number');
eq(merged && merged.uses.length, 2, 'merged into one shared field');
v = drafts.op('example-warrants', 'splitField', { ref: merged.key, rel: 'Example Mail Co.docx', name: 'email address' });
ok(v.fields.own.some(f => f.label === 'email address' && f.unlinked), 'split back out, with its own name again');
ok(v.fields.own.some(f => f.label === 'target phone number' && !f.unlinked), 'the one template left is not shared any more');
eq(v.fields.shared.filter(f => f.label === 'target phone number').length, 0, 'no one-template shared field left behind');
throws(() => drafts.op('example-warrants', 'splitField', { ref: v.fields.own[0].key, rel: 'x', name: 'y' }), /not shared/, 'split needs a shared field');
throws(() => drafts.op('example-warrants', 'eval', {}), /Unknown change/, 'unknown op refused');
throws(() => drafts.op('example-warrants', 'updateField', { ref: '{"g":"nope"}', patch: {} }), /Field not found/, 'unknown field refused');
throws(() => drafts.op('example-warrants', 'updateField', { ref: cn.key, patch: { kind: 'bogus' } }), /Unknown field type/, 'author errors come through');
throws(() => drafts.op('../evil', 'setMeta', {}), /Invalid pack id/, 'bad draft id refused');
throws(() => drafts.get('no-such-draft'), /no longer exists/, 'missing draft');

// Survives a restart.
const drafts2 = D.createDraftStore({ fs, path, crypto, AdmZip, store, rootDir: DROOT, now });
eq(JSON.stringify(drafts2.get('example-warrants').fields), JSON.stringify(v.fields), 'draft read back after restart');

// ---- Preview -------------------------------------------------------------------------------------
{
  const pv = drafts.preview('example-warrants', 'Example Phone Co.docx');
  eq(pv.filename, 'Preview - Example Phone Co.docx', 'preview name');
  const xml = new AdmZip(pv.data).readAsText('word/document.xml');
  ok(/<w:sdt>/.test(xml) && /Case Number/.test(xml), 'preview has labelled fields');
  ok(!/documentProtection/.test(new AdmZip(pv.data).readAsText('word/settings.xml')), 'preview is not locked');
  throws(() => drafts.preview('example-warrants', 'nope.docx'), /not found/, 'preview unknown template');
}

// ---- Save ------------------------------------------------------------------------------------------
let s = drafts.save('example-warrants');
eq([s.pack.id, s.pack.packVersion, s.pack.templateCount, s.pack.name], ['example-warrants', '1.0.0', 2, 'Example Warrant Packet'], 'first save installs 1.0.0');
eq([s.draft.dirty, s.draft.meta.packVersion, s.draft.meta.installedVersion, s.draft.meta.nextVersion], [false, '1.0.0', '1.0.0', '1.0.1'], 'draft after save');
{
  const L = store.load('example-warrants');
  eq(L.manifest.agency, 'Example PD', 'agency in manifest');
  eq(L.rules, {}, 'new packs have no rules');
  const built = store.build('example-warrants', { templateIds: ['Example Phone Co.docx'], values: { ['global:' + JSON.parse(cn.key).g]: 'SYN-26-001' } });
  ok(/SYN-26-001/.test(new AdmZip(built.documents[0].data).readAsText('word/document.xml')), 'saved pack fills documents');
}
drafts.op('example-warrants', 'setMeta', { description: 'SYNTHETIC v2' });
s = drafts.save('example-warrants');
eq(s.pack.packVersion, '1.0.1', 'second save bumps the version');
eq(store.list().find(p => p.id === 'example-warrants').description, 'SYNTHETIC v2', 'installed pack updated in place');

// ---- Replace a template ---------------------------------------------------------------------------
r = drafts.replaceTemplate('example-warrants', 'Example Phone Co.docx', DOC_A2);
eq([r.result.added, r.result.removed, r.result.kept], [['date range'], ['affiant name'], 2], 'replace reports added / removed / kept');
ok(r.draft.fields.shared.some(f => f.label === 'Case Number' && f.hint === 'Your report number'), 'kept field keeps its settings');
ok(r.draft.dirty, 'replace marks the draft changed');
throws(() => drafts.replaceTemplate('example-warrants', 'Example Phone Co.docx', FAKE_DOCX), /Not a Word/, 'replace with a bad file refused');
eq(fs.readFileSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Phone Co.docx')).equals(fs.readFileSync(DOC_A2)), true, 'bad replace left the file alone');
throws(() => drafts.replaceTemplate('example-warrants', 'nope.docx', DOC_A2), /not found/, 'replace unknown template');

// Missing Word file blocks saving with a clear message.
fs.unlinkSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Mail Co.docx'));
throws(() => drafts.save('example-warrants'), /Example Mail Co is missing/, 'missing template file blocks save');
fs.writeFileSync(path.join(DROOT, 'example-warrants', 'templates', 'Example Mail Co.docx'), fs.readFileSync(DOC_B));
eq(drafts.save('example-warrants').pack.packVersion, '1.0.2', 'saves again once the file is back');

// ---- Edit an installed pack (made by the command-line builder) ----------------------------------
v = drafts.openInstalled('cli-pack');
eq([v.id, v.meta.name, v.meta.packVersion, v.dirty, v.meta.hasRules], ['cli-pack', 'CLI pack', '2.3', false, true], 'installed pack opened for editing');
ok(v.fields.own.every(f => f.uses[0].context), 'contexts filled from the templates');
eq(v.templates[0].unhighlighted, ['not highlighted'], 'notes filled from the templates');
drafts.op('cli-pack', 'setMeta', { description: 'edited' });
eq(drafts.openInstalled('cli-pack').meta.description, 'edited', 'unsaved changes picked up again');
eq(drafts.openInstalled('cli-pack', { fresh: true }).meta.description, '', 'fresh copy discards them');
drafts.op('cli-pack', 'setMeta', { agency: 'Example agency 2' });
s = drafts.save('cli-pack');
eq(s.pack.packVersion, '2.3.1', 'version bumped from the installed one');
eq(store.load('cli-pack').rules, CLI_RULES, 'manifest rules untouched');
eq(store.load('cli-pack').manifest.createdAt, CLI_CREATED, 'createdAt kept');

// ---- Unsaved edits made to an older install -----------------------------------------------------
{
  const packOf = (ver) => S.buildPackBuffer({ id: 'cli-pack', name: 'CLI pack', agency: 'Example agency', packVersion: ver, rules: CLI_RULES, config: CLI_CONFIG,
    templates: new Map([['Example Phone Co.docx', tplA]]) }, { AdmZip, crypto }).buffer;
  eq(s.draft.stale, null, 'just saved: not stale');
  drafts.op('cli-pack', 'setMeta', { description: 'my edits' });
  eq(drafts.get('cli-pack').stale, null, 'own edits are not stale');
  store.installBuffer(packOf('3.0'), 'agency file');
  v = drafts.get('cli-pack');
  eq([v.stale && v.stale.baseVersion, v.stale && v.stale.installedVersion, v.meta.nextVersion], ['2.3.1', '3.0', '3.0.1'], 'stale after a newer pack is installed');
  ok(v.stale && v.stale.installedAt, 'stale says when');
  eq(drafts.list().find(d => d.id === 'cli-pack').stale.installedVersion, '3.0', 'stale in the drafts list');
  eq(drafts.openInstalled('cli-pack').stale.installedVersion, '3.0', 'opening again keeps the edits and says they are stale');
  throws(() => drafts.save('cli-pack'), /made to version 2\.3\.1, but version 3\.0 has been installed since/, 'stale save refused');
  eq([store.load('cli-pack').manifest.packVersion, store.load('cli-pack').manifest.description || ''], ['3.0', ''], 'newer install untouched');
  s = drafts.save('cli-pack', { force: true });
  eq([s.pack.packVersion, s.replacedNewer, s.draft.stale, s.pack.description], ['3.0.1', '3.0', null, 'my edits'], 'forced save goes on top of the newer version');
  eq(drafts.save('cli-pack').replacedNewer, null, 'next save is normal');

  // An older file installed over it is stale too; starting fresh takes the installed version.
  drafts.op('cli-pack', 'setMeta', { description: 'more edits' });
  store.installBuffer(packOf('2.0'), 'old file');
  eq(drafts.get('cli-pack').stale.installedVersion, '2.0', 'older install also makes the edits stale');
  v = drafts.openInstalled('cli-pack', { fresh: true });
  eq([v.stale, v.meta.packVersion, v.meta.description, v.dirty], [null, '2.0', '', false], 'start from the installed version');

  // The same version installed again from a file is noticed by its install time.
  drafts.op('cli-pack', 'setMeta', { description: 'edits on 2.0' });
  store.installBuffer(packOf('2.0'), 'same file again');
  eq(drafts.get('cli-pack').stale && drafts.get('cli-pack').stale.installedVersion, '2.0', 'reinstall of the same version noticed');

  // Drafts from before install times were recorded only compare versions.
  const f = path.join(DROOT, 'cli-pack', 'draft.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete j.meta.baseInstalledAt;
  fs.writeFileSync(f, JSON.stringify(j));
  eq(drafts.get('cli-pack').stale, null, 'older draft, same version: not stale');
  store.installBuffer(packOf('2.1'), 'newer');
  eq(drafts.get('cli-pack').stale.baseVersion, '2.0', 'older draft, other version: stale');

  // A removed pack: saving installs it again, nothing to overwrite.
  store.remove('cli-pack');
  eq(drafts.get('cli-pack').stale, null, 'pack removed: not stale');
  store.installBuffer(packOf('2.3.1'), 'restore');
  drafts.openInstalled('cli-pack', { fresh: true });
}

// A new draft whose id gets installed by someone else before the first save.
v = drafts.create({ name: 'Clash' });
drafts.addTemplates('clash', [DOC_A]);
const other = S.buildPackBuffer({ id: 'clash', name: 'Other', packVersion: '1', config: CLI_CONFIG, templates: [['Example Phone Co.docx', tplA]] });
store.installBuffer(other.buffer);
throws(() => drafts.save('clash'), /already installed/, 'never overwrite a different pack');

// ---- list / discard --------------------------------------------------------------------------------
{
  const L = drafts.list();
  eq(L.map(d => d.id), ['clash', 'cli-pack', 'example-warrants'], 'drafts listed (preview folder skipped)');
  eq(L.find(d => d.id === 'example-warrants').installed, true, 'installed flag');
  eq(drafts.discard('clash'), { discarded: true }, 'discard');
  eq(drafts.discard('clash'), { discarded: false }, 'discard twice');
  fs.mkdirSync(path.join(DROOT, 'broken-draft'));
  ok(drafts.list().find(d => d.id === 'broken-draft').error, 'damaged draft listed with an error');
  drafts.discard('broken-draft');
}

// ---- IPC ---------------------------------------------------------------------------------------------
(async () => {
  const handlers = {};
  const audits = [];
  const opened = [];
  let nextOpen = { canceled: true }, nextSave = { canceled: true };
  const DOCS = path.join(TMP, 'docs');
  const APPDIR = path.join(TMP, 'app');
  fs.mkdirSync(DOCS, { recursive: true });
  D.registerDraftIpc({ handle: (c, f) => { handlers[c] = f; } }, drafts, store, {
    dialog: { showOpenDialog: async () => nextOpen, showSaveDialog: async () => nextSave },
    shell: { openPath: async (p) => { opened.push(p); return ''; } },
    audit: () => ({ write: (e, d) => audits.push([e, d]) }),
    AUDIT_EVENTS: { AGENCY_PACK_INSTALLED: 'agency_pack_installed', AGENCY_PACK_EXPORTED: 'agency_pack_exported' },
    defaultDir: () => DOCS, forbiddenDirs: [APPDIR], fs,
  });
  eq(Object.keys(handlers).sort(), ['agency-pack-draft-add-templates', 'agency-pack-draft-create', 'agency-pack-draft-discard', 'agency-pack-draft-get',
    'agency-pack-draft-op', 'agency-pack-draft-open', 'agency-pack-draft-preview', 'agency-pack-draft-replace-template', 'agency-pack-draft-save',
    'agency-pack-drafts', 'agency-pack-export'], 'ipc channels');
  const call = (c, ...a) => handlers[c]({}, ...a);
  let x = await call('agency-pack-draft-create', { name: 'IPC Pack' });
  eq([x.success, x.draft.id], [true, 'ipc-pack'], 'create over IPC');
  x = await call('agency-pack-draft-create', null);
  eq(x.success, false, 'create with nothing refused');
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack' });
  eq(x, { success: true, canceled: true }, 'picker canceled');
  nextOpen = { canceled: false, filePaths: [DOC_A, DOC_B] };
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack', category: 'Court Order' });
  eq([x.success, x.results.length, x.draft.categories], [true, 2, ['Court Order']], 'templates from the picker');
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack', paths: [DOC_A2, 42] });
  eq(x.results.length, 1, 'dropped paths (non-strings ignored)');
  x = await call('agency-pack-draft-op', { id: 'ipc-pack', op: 'setMeta', args: { agency: 'IPC agency' } });
  eq(x.draft.meta.agency, 'IPC agency', 'op over IPC');
  x = await call('agency-pack-draft-op', { id: 'ipc-pack', op: 'nope' });
  eq([x.success, x.error], [false, 'Unknown change'], 'bad op over IPC');
  nextOpen = { canceled: false, filePaths: [DOC_A2] };
  x = await call('agency-pack-draft-replace-template', { id: 'ipc-pack', rel: 'Example Phone Co.docx' });
  eq(x.result.added, ['date range'], 'replace via picker');
  x = await call('agency-pack-draft-preview', { id: 'ipc-pack', rel: 'Example Phone Co.docx' });
  eq(x.opened, true, 'preview opened');
  ok(opened.length === 1 && opened[0].startsWith(path.join(DROOT, '_preview')), 'preview written next to the drafts');
  fs.writeFileSync(opened[0] + '.lock', 'x');
  x = await call('agency-pack-draft-preview', { id: 'ipc-pack', rel: 'Example Phone Co.docx' });
  ok(x.opened && opened.length === 2, 'second preview');
  x = await call('agency-pack-draft-get', 'ipc-pack');
  eq(x.draft.id, 'ipc-pack', 'get over IPC');
  x = await call('agency-pack-draft-save', 'ipc-pack');
  eq([x.success, x.pack.packVersion], [true, '1.0.0'], 'save over IPC');
  eq(audits[0], ['agency_pack_installed', { pack_id: 'ipc-pack', pack_version: '1.0.0', templates: 3, source: 'editor' }], 'save audited');
  x = await call('agency-pack-export', 'ipc-pack');
  eq(x, { success: true, canceled: true }, 'export canceled');
  nextSave = { canceled: false, filePath: path.join(APPDIR, 'sub', 'x.viperpack') };
  x = await call('agency-pack-export', 'ipc-pack');
  ok(!x.success && /outside/.test(x.error), 'export into the app folder refused');
  nextSave = { canceled: false, filePath: path.join(DOCS, 'IPC Pack') };
  x = await call('agency-pack-export', 'ipc-pack');
  eq([x.success, path.basename(x.filePath), x.packVersion], [true, 'IPC Pack.viperpack', '1.0.0'], 'export adds the extension');
  eq(store.inspect(x.filePath).templateCount, 3, 'exported file installs');
  eq(audits[1], ['agency_pack_exported', { pack_id: 'ipc-pack', pack_version: '1.0.0', file: 'IPC Pack.viperpack' }], 'export audited');
  x = await call('agency-pack-export', 'not-installed');
  eq(x.success, false, 'export of an unknown pack refused');
  x = await call('agency-pack-drafts');
  ok(x.drafts.some(d => d.id === 'ipc-pack'), 'list over IPC');
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack', paths: [DOC_B] });
  eq([x.success, x.results.length, x.conflicts.map(c => c.rel)], [true, 0, ['Example Mail Co.docx']], 'duplicate over IPC is a conflict');
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack', paths: [DOC_B], duplicates: 'add' });
  eq([x.results[0].rel, x.conflicts.length], ['Example Mail Co (2).docx', 0], 'duplicates: add over IPC');
  x = await call('agency-pack-draft-add-templates', { id: 'ipc-pack', paths: [DOC_B], duplicates: 'yes please' });
  eq(x.conflicts.length, 1, 'only "add" skips the question');
  store.installBuffer(S.buildPackBuffer({ id: 'ipc-pack', name: 'IPC Pack', packVersion: '5.0', config: CLI_CONFIG, templates: [['Example Phone Co.docx', tplA]] }).buffer, 'agency');
  x = await call('agency-pack-draft-save', 'ipc-pack');
  ok(!x.success && /version 5\.0 has been installed since/.test(x.error), 'stale save refused over IPC');
  x = await call('agency-pack-draft-save', { id: 'ipc-pack', force: 'true' });
  eq(x.success, false, 'force must be true, not truthy');
  x = await call('agency-pack-draft-save', { id: 'ipc-pack', force: true });
  eq([x.success, x.pack.packVersion, x.pack.templateCount], [true, '5.0.1', 4], 'forced save over IPC');
  eq(audits[audits.length - 1], ['agency_pack_installed', { pack_id: 'ipc-pack', pack_version: '5.0.1', templates: 4, source: 'editor', replaced_newer: '5.0' }], 'forced save audited');
  x = await call('agency-pack-draft-open', { id: 'example-warrants', fresh: true });
  eq([x.success, x.draft.meta.packVersion], [true, '1.0.2'], 'open over IPC');
  x = await call('agency-pack-draft-discard', 'ipc-pack');
  eq(x.discarded, true, 'discard over IPC');
})().then(() => {
  console.log(`pack-drafts: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
