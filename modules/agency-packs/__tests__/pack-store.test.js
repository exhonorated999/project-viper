'use strict';
// Tests for modules/agency-packs/pack-store.js and scripts/build-agency-pack.js.
// Everything here is SYNTHETIC and written to the OS temp folder.
// Run: node modules/agency-packs/__tests__/pack-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const S = require('../pack-store.js');
const { buildPack } = require('../../../scripts/build-agency-pack.js');

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-packstore-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

// ---- Synthetic template library -------------------------------------------------------------
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function makeDocx(fields, extraBody) {
  const zip = new AdmZip();
  const runs = fields.map(f => '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>[' + f + ']</w:t></w:r></w:p>').join('');
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + W_NS + '"><w:body>' + runs + (extraBody || '') + '</w:body></w:document>'));
  zip.addFile('word/settings.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="' + W_NS + '"><w:zoom w:percent="100"/></w:settings>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  return zip.toBuffer();
}
const ph = (name, extra) => Object.assign({ name, customTitle: name, customTag: name.replace(/[^A-Za-z0-9]/g, '_'), type: 'text', choices: [] }, extra || {});
const T_ACME = 'Warrants/Acme/Acme_Template.docx';
const T_ARR = 'Arrest/County Arrest Warrant_Template.docx';
const LIB = path.join(TMP, 'library');
fs.mkdirSync(path.join(LIB, 'templates_v2', 'Warrants', 'Acme'), { recursive: true });
fs.mkdirSync(path.join(LIB, 'templates_v2', 'Arrest'), { recursive: true });
fs.writeFileSync(path.join(LIB, 'templates_v2', ...T_ACME.split('/')), makeDocx(['case number', 'account']));
fs.writeFileSync(path.join(LIB, 'templates_v2', ...T_ARR.split('/')), makeDocx(['case number', 'defendant name', 'NORTH/SOUTH'],
  '<w:p><w:r><w:t>APPROVED AS TO FORM:</w:t></w:r></w:p><w:p><w:r><w:t>DA line</w:t></w:r></w:p>'));
fs.writeFileSync(path.join(LIB, 'templates_v2', 'Unlisted_Template.docx'), makeDocx(['x']));   // not in config → not packed
const CONFIG = {
  globalFields: [{ id: 'g_case', name: 'Case Number', tag: 'case_number', mappings: [
    { templateId: T_ACME, placeholderName: 'case number' }, { templateId: T_ARR, placeholderName: 'case number' }] }],
  unbracketedFields: [],
  filenameSuffixFields: { [T_ACME]: ['account'], [T_ARR]: 'defendant name' },
  templatesConfig: {
    [T_ACME]: { category: 'Search Warrant', placeholders: [ph('case number'), ph('account')] },
    [T_ARR]: { category: 'Arrest Warrant', placeholders: [ph('case number'), ph('defendant name'), ph('NORTH/SOUTH', { customTitle: 'county' })] },
  },
  privateNotes: 'SYNTHETIC — must not be packed',
};
fs.writeFileSync(path.join(LIB, 'app_config.json'), JSON.stringify(CONFIG));
const RULES = {
  counties: [{ label: 'North County', countyValue: 'NORTH', judicialDistrict: '9th', removeDaApproval: false },
    { label: 'South County', countyValue: 'SOUTH', judicialDistrict: '10th', removeDaApproval: true }],
  typeTokens: { 'Search Warrant': 'SW', 'Arrest Warrant': 'AW' },
  venueCategories: ['Arrest Warrant'],
};
const RULES_PATH = path.join(TMP, 'rules.json');
fs.writeFileSync(RULES_PATH, JSON.stringify(RULES));
const baseOpts = (over) => Object.assign({ source: LIB, rules: RULES_PATH, id: 'test-pack', name: 'Test pack', agency: 'Test agency', version: '1.0.0', out: path.join(TMP, 'out', 'test.viperpack') }, over || {});

// ---- isSafeRelPath ------------------------------------------------------------------------------
ok(S.isSafeRelPath('templates/A b/C.docx'), 'safe nested path');
ok(S.isSafeRelPath('templates/Google.AccountData_Template.docx'), 'dots inside name ok');
['', '../x', 'a/../b', '/abs', 'a\\b', 'C:/x', 'a//b', 'a/./b', 'trail./x', 'trail /x', 'x/ lead', 'con', 'aux.docx', 'x/nul.txt', 'a?b', 'a\u0001b', 'a'.repeat(401)]
  .forEach(p => ok(!S.isSafeRelPath(p), 'unsafe path rejected: ' + JSON.stringify(p.slice(0, 20))));
ok(!S.isSafeRelPath(null), 'non-string rejected');

// ---- Manifest / rules validation ----------------------------------------------------------------
const goodManifest = () => ({ format: S.FORMAT, formatVersion: S.FORMAT_VERSION, id: 'abc', name: 'N', packVersion: '1', kind: 'warrant-builder', files: { 'config.json': 'a'.repeat(64) } });
ok(S.validateManifest(goodManifest()), 'good manifest');
throws(() => S.validateManifest(Object.assign(goodManifest(), { format: 'zip' })), /Not a VIPER agency pack/, 'wrong format');
throws(() => S.validateManifest(Object.assign(goodManifest(), { formatVersion: 2 })), /not supported/, 'future format version');
throws(() => S.validateManifest(Object.assign(goodManifest(), { id: 'Bad Id' })), /id/, 'bad id');
throws(() => S.validateManifest(Object.assign(goodManifest(), { id: '../x' })), /id/, 'traversal id');
throws(() => S.validateManifest(Object.assign(goodManifest(), { kind: 'other' })), /kind/, 'unknown kind');
throws(() => S.validateManifest(Object.assign(goodManifest(), { name: ' ' })), /name/, 'blank name');
throws(() => S.validateManifest(Object.assign(goodManifest(), { files: { '../evil': 'a'.repeat(64) } })), /Unsafe path/, 'unsafe manifest path');
throws(() => S.validateManifest(Object.assign(goodManifest(), { files: { 'config.json': 'xyz' } })), /checksum/i, 'bad checksum format');
throws(() => S.validateRules({ counties: [{}] }), /label/, 'county needs label');
throws(() => S.validateRules({ hiddenFields: [1] }), /list of text/, 'hiddenFields text');
throws(() => S.validateRules({ photoPatterns: 'photo' }), /list of text/, 'photoPatterns list');
eq(S.validateRules({ photoPatterns: ['photo of'] }).photoPatterns, ['photo of'], 'photoPatterns ok');
throws(() => S.validateRules({ municipalPattern: '(' }), /pattern/, 'bad regex');
throws(() => S.validateRules({ typeTokens: { a: 1 } }), /typeTokens/, 'typeTokens text');
throws(() => S.validateRules([]), /object/, 'rules array');
eq(S.validateRules(undefined), {}, 'no rules ok');

// ---- build-agency-pack ---------------------------------------------------------------------------
throws(() => buildPack(baseOpts({ out: path.join(__dirname, 'x.viperpack') })), /inside the VIPER repository/, 'refuses output inside repo');
throws(() => buildPack(baseOpts({ out: path.join(TMP, 'x.zip') })), /\.viperpack/, 'output extension');
throws(() => buildPack(baseOpts({ id: 'Has Space' })), /--id/, 'bad id arg');
throws(() => buildPack(baseOpts({ name: '' })), /Missing --name/, 'missing arg');
const built = buildPack(baseOpts());
ok(fs.existsSync(built.out), 'pack written');
eq(built.summary.templateCount, 2, 'summary template count');
eq(built.summary.categories, { 'Search Warrant': 1, 'Arrest Warrant': 1 }, 'summary categories');
eq(built.summary.counties, ['North County', 'South County'], 'summary counties');
const PACK = built.out;
{
  const z = new AdmZip(PACK);
  const names = z.getEntries().map(e => e.entryName).sort();
  eq(names, ['config.json', 'manifest.json', 'templates/' + T_ARR, 'templates/' + T_ACME].sort(), 'only listed files packed');
  const cfg = JSON.parse(z.readAsText('config.json'));
  eq(Object.keys(cfg).sort(), ['filenameSuffixFields', 'globalFields', 'templatesConfig', 'unbracketedFields'], 'only Builder config keys packed');
  const m = JSON.parse(z.readAsText('manifest.json'));
  eq(m.builder.typeTokens, RULES.typeTokens, 'rules in manifest');
  eq(m.files['config.json'], sha(z.readFile('config.json')), 'config hash');
}
{
  const missingLib = path.join(TMP, 'lib-missing');
  fs.mkdirSync(path.join(missingLib, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(missingLib, 'app_config.json'), JSON.stringify(CONFIG));
  throws(() => buildPack(baseOpts({ source: missingLib, out: path.join(TMP, 'm.viperpack') })), /missing/, 'build reports missing templates');
}

// ---- Tampered / hostile pack files --------------------------------------------------------------
const ROOT = path.join(TMP, 'userData', 'agency-packs');
let clock = 1700000000000;
const store = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: ROOT, now: () => (clock += 1000) });

// Rewrite a pack: mutate(entries Map<name, Buffer>, manifest) then optionally re-sign.
function variant(name, mutate, opts) {
  opts = opts || {};
  const src = new AdmZip(PACK);
  const entries = new Map(src.getEntries().map(e => [e.entryName, e.getData()]));
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  entries.delete('manifest.json');
  mutate(entries, manifest);
  if (opts.resign) {
    manifest.files = {};
    for (const [n, b] of entries) manifest.files[n] = sha(b);
  }
  const z = new AdmZip();
  if (!opts.noManifest) z.addFile('manifest.json', Buffer.from(typeof opts.rawManifest === 'string' ? opts.rawManifest : JSON.stringify(manifest)));
  for (const [n, b] of entries) z.addFile(n, b);
  const out = path.join(TMP, 'variants', name + '.viperpack');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  z.writeZip(out);
  return out;
}
const rejects = (file, re, label) => {
  throws(() => store.inspect(file), re, label + ' (inspect)');
  throws(() => store.install(file), re, label + ' (install)');
};
rejects(variant('extra', (e) => e.set('notes.txt', Buffer.from('x'))), /Unexpected file/, 'extra file type');
rejects(variant('unlisted', (e) => e.set('templates/Extra_Template.docx', makeDocx(['y']))), /not listed/, 'unlisted template');
rejects(variant('hash', (e) => e.set('templates/' + T_ACME, makeDocx(['changed']))), /Checksum mismatch/, 'hash mismatch');
rejects(variant('missingtpl', (e) => e.delete('templates/' + T_ARR)), /listed in manifest is missing/, 'listed file missing');
rejects(variant('missingtpl2', (e) => e.delete('templates/' + T_ARR), { resign: true }), /Template missing from pack/, 'config template missing (re-signed)');
rejects(variant('notdocx', (e) => e.set('templates/' + T_ACME, Buffer.from('not a zip')), { resign: true }), /Not a Word document/, 'template not docx');
rejects(variant('nomanifest', () => {}, { noManifest: true }), /no manifest/, 'no manifest');
rejects(variant('badjson', () => {}, { rawManifest: '{oops' }), /not valid JSON/, 'manifest JSON');
rejects(variant('badformat', (e, m) => { m.format = 'other'; }), /Not a VIPER agency pack/, 'manifest format');
rejects(variant('badcfg', (e) => e.set('config.json', Buffer.from('{"templatesConfig":5}')), { resign: true }), /templatesConfig/, 'bad config');
rejects(variant('emptycfg', (e) => { e.set('config.json', Buffer.from('{"templatesConfig":{}}')); e.delete('templates/' + T_ACME); e.delete('templates/' + T_ARR); }, { resign: true }), /no templates/, 'no templates');
rejects(variant('dup', (e) => e.set('Config.json', Buffer.from('{}'))), /Unexpected file|Duplicate/, 'case-duplicate entry');
{
  const z = new AdmZip(PACK);
  z.addFile('templates/../../evil.docx', makeDocx(['z']));
  const out = path.join(TMP, 'variants', 'traversal.viperpack');
  z.writeZip(out);
  let threw = false, msg = '';
  try { store.inspect(out); } catch (e) { threw = true; msg = e.message; }
  ok(threw && /Unsafe|Unexpected|not listed/.test(msg), 'traversal entry rejected — ' + msg);
}
{
  const junk = path.join(TMP, 'variants', 'junk.viperpack');
  fs.writeFileSync(junk, 'not a zip at all');
  throws(() => store.inspect(junk), /damaged|not a pack/, 'not a zip');
  throws(() => store.inspect(path.join(TMP, 'nope.viperpack')), /could not be read/, 'missing file');
  throws(() => store.inspect(''), /No pack file/, 'empty path');
  const tiny = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: path.join(TMP, 'tiny'), limits: { maxEntryBytes: 100 } });
  throws(() => tiny.inspect(PACK), /too large/, 'entry size limit');
  const tinyTotal = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: path.join(TMP, 'tiny'), limits: { maxTotalBytes: 1000 } });
  throws(() => tinyTotal.inspect(PACK), /too large when unpacked/, 'total size limit');
  const tinyFile = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: path.join(TMP, 'tiny'), limits: { maxPackFileBytes: 10 } });
  throws(() => tinyFile.inspect(PACK), /pack file is too large/, 'pack file limit');
  const fewEntries = S.createPackStore({ fs, path, crypto, AdmZip, rootDir: path.join(TMP, 'tiny'), limits: { maxEntries: 2 } });
  throws(() => fewEntries.inspect(PACK), /too many files/, 'entry count limit');
}
ok(!fs.existsSync(ROOT) || fs.readdirSync(ROOT).length === 0, 'nothing installed by rejected packs');

// ---- Install / list / load ------------------------------------------------------------------------
eq(store.list(), [], 'empty list');
ok(!store.hasBuilderPack(), 'no builder pack yet');
const ins = store.inspect(PACK);
eq(ins.installedVersion, null, 'inspect: not installed');
const r1 = store.install(PACK);
eq([r1.id, r1.packVersion, r1.previousVersion, r1.templateCount], ['test-pack', '1.0.0', null, 2], 'install summary');
ok(fs.existsSync(path.join(ROOT, 'test-pack', 'templates', ...T_ACME.split('/'))), 'template on disk');
ok(fs.existsSync(path.join(ROOT, 'test-pack', 'install-info.json')), 'install info written');
eq(fs.readdirSync(ROOT + '-staging'), [], 'staging cleaned');
eq(store.inspect(PACK).installedVersion, '1.0.0', 'inspect shows installed version');
const listed = store.list();
eq(listed.map(p => [p.id, p.packVersion, p.agency, p.templateCount]), [['test-pack', '1.0.0', 'Test agency', 2]], 'list');
ok(typeof listed[0].installedAt === 'string', 'list installedAt');
ok(store.hasBuilderPack(), 'builder pack present');
const L = store.load('test-pack');
eq(Object.keys(L.config.templatesConfig).sort(), [T_ARR, T_ACME].sort(), 'load config');
eq(L.rules.typeTokens, RULES.typeTokens, 'load rules');
ok(store.readTemplate('test-pack', T_ACME).equals(fs.readFileSync(path.join(LIB, 'templates_v2', ...T_ACME.split('/')))), 'readTemplate bytes');
throws(() => store.readTemplate('test-pack', 'Warrants/Other.docx'), /Unknown template/, 'readTemplate unknown');
throws(() => store.load('not-installed'), /not installed/, 'load missing');
throws(() => store.load('../etc'), /Invalid pack id/, 'load bad id');
eq(store.verify('test-pack'), { ok: true, problems: [], fileCount: 3 }, 'verify ok');

// Reinstall a newer version
const PACK2 = buildPack(baseOpts({ version: '1.1.0', out: path.join(TMP, 'out', 'test-1.1.viperpack') })).out;
const r2 = store.install(PACK2);
eq([r2.packVersion, r2.previousVersion], ['1.1.0', '1.0.0'], 'upgrade reports previous version');
eq(store.list().map(p => p.packVersion), ['1.1.0'], 'one copy after upgrade');
eq(fs.readdirSync(ROOT + '-staging'), [], 'staging cleaned after upgrade');
{
  // Installing an older file over a newer one is flagged before anything happens.
  const old = store.inspect(PACK);
  eq([old.installedVersion, old.versionVsInstalled, old.olderThanInstalled], ['1.1.0', -1, true], 'inspect: older than installed');
  const same = store.inspect(PACK2);
  eq([same.versionVsInstalled, same.olderThanInstalled], [0, false], 'inspect: same version');
  eq([ins.versionVsInstalled, ins.olderThanInstalled], [null, false], 'inspect: nothing installed');
  const C = S.compareVersions;
  eq([C('1.0.0', '1.1.0'), C('1.10', '1.9'), C('2', '2.0.0'), C('1.0.1', '1.0'), C('v3.1', '3.0.9')], [-1, 1, 0, 1, 1], 'compareVersions numbers');
  eq([C('2026-01', '1.0'), C('1.0 beta', '1.0'), C('', '1'), C(null, '1')], [null, null, null, null], 'compareVersions: not plain numbers');
}

// A second pack lists alongside; a broken folder shows an error instead of hiding
const PACK3 = buildPack(baseOpts({ id: 'other-pack', out: path.join(TMP, 'out', 'other.viperpack') })).out;
store.install(PACK3);
fs.mkdirSync(path.join(ROOT, 'broken-pack'));
fs.mkdirSync(path.join(ROOT, 'Not An Id'));
const l3 = store.list();
eq(l3.map(p => p.id), ['broken-pack', 'other-pack', 'test-pack'], 'list includes broken, skips non-ids');
ok(/missing/.test(l3[0].error || ''), 'broken pack has error');
fs.rmSync(path.join(ROOT, 'broken-pack'), { recursive: true });
fs.rmSync(path.join(ROOT, 'Not An Id'), { recursive: true });

// ---- Build documents --------------------------------------------------------------------------
const docText = (buf) => new AdmZip(buf).readAsText('word/document.xml');
const settingsText = (buf) => new AdmZip(buf).readAsText('word/settings.xml');
{
  const values = { 'global:g_case': '26-000777', ['tpl:' + T_ACME + ':account']: 'user@example.test', ['tpl:' + T_ARR + ':defendant name']: 'Pat SYNTHETIC' };
  const out = store.build('test-pack', { templateIds: [T_ACME, T_ARR], values, county: 'South County' });
  eq(out.documents.map(d => d.templateId), [T_ACME, T_ARR], 'build order');
  eq(out.documents.map(d => d.filename), ['26000777 SW Acme_user@example.test.docx', '26000777 AW South County_Pat SYNTHETIC.docx'], 'build filenames');
  eq(out.packetFilename, '26000777_Warrant_Packet.zip', 'packet filename');
  eq(out.removeDaApprovalSection, true, 'county rule removes DA section');
  ok(out.documents.every(d => /wordprocessingml\.document$/.test(d.mimetype)), 'mimetype');
  const t0 = docText(out.documents[0].data), t1 = docText(out.documents[1].data);
  ok(t0.includes('26-000777') && t0.includes('user@example.test'), 'values filled (search)');
  ok(t1.includes('Pat SYNTHETIC') && t1.includes('SOUTH'), 'values + county filled (arrest)');
  ok(!t1.includes('APPROVED AS TO FORM'), 'DA section removed for South');
  ok(!/documentProtection/.test(settingsText(out.documents[0].data)), 'filled doc unprotected');
  const north = store.build('test-pack', { templateIds: [T_ARR], values, county: 'North County' });
  ok(docText(north.documents[0].data).includes('APPROVED AS TO FORM'), 'DA section kept for North');
  const over = store.build('test-pack', { templateIds: [T_ACME], values, overrides: { [T_ACME]: 'My name' } });
  eq(over.documents[0].filename, 'My name.docx', 'filename override');
  const zipBuf = store.zipDocuments(out.documents);
  eq(new AdmZip(zipBuf).getEntries().map(e => e.entryName).sort(), out.documents.map(d => d.filename).sort(), 'packet zip entries');
  const blank = store.build('test-pack', { templateIds: [T_ACME, T_ARR] }, { blank: true });
  eq(blank.documents.map(d => d.filename), ['Acme_Template.docx', 'County Arrest Warrant_Template.docx'], 'blank filenames');
  ok(blank.documents.every(d => /documentProtection/.test(settingsText(d.data))), 'blank forms protected');
  ok(docText(blank.documents[1].data).includes('APPROVED AS TO FORM'), 'blank keeps DA section');
  throws(() => store.build('test-pack', { templateIds: [] }), /at least one/, 'build needs templates');
  throws(() => store.build('test-pack', { templateIds: ['Warrants/Nope.docx'] }), /Unknown template/, 'build unknown template');
  const dup = store.build('test-pack', { templateIds: [T_ACME, T_ACME], values });
  eq(dup.documents.map(d => d.filename), ['26000777 SW Acme_user@example.test.docx', '26000777 SW Acme_user@example.test_2.docx'], 'duplicate filenames uniquified');
}

// ---- Tamper detection --------------------------------------------------------------------------
{
  const tpl = path.join(ROOT, 'test-pack', 'templates', ...T_ACME.split('/'));
  const orig = fs.readFileSync(tpl);
  const bad = Buffer.from(orig); bad[bad.length - 5] ^= 1;
  fs.writeFileSync(tpl, bad);
  throws(() => store.readTemplate('test-pack', T_ACME), /changed on disk/, 'tampered template');
  throws(() => store.build('test-pack', { templateIds: [T_ACME] }), /changed on disk/, 'build refuses tampered template');
  const v = store.verify('test-pack');
  eq([v.ok, v.problems], [false, ['Changed: templates/' + T_ACME]], 'verify reports change');
  fs.unlinkSync(tpl);
  eq(store.verify('test-pack').problems, ['Missing: templates/' + T_ACME], 'verify reports missing');
  fs.writeFileSync(tpl, orig);
  eq(store.verify('test-pack').ok, true, 'verify ok after restore');
  const cfg = path.join(ROOT, 'test-pack', 'config.json');
  const corig = fs.readFileSync(cfg);
  fs.writeFileSync(cfg, Buffer.concat([corig, Buffer.from(' ')]));
  throws(() => store.load('test-pack'), /changed on disk \(config\.json\)/, 'tampered config');
  eq(store.verify('test-pack').ok, false, 'verify fails on tampered config');
  fs.writeFileSync(cfg, corig);
  const mf = path.join(ROOT, 'test-pack', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  fs.writeFileSync(mf, JSON.stringify(Object.assign({}, m, { id: 'other-pack' })));
  throws(() => store.load('test-pack'), /does not match/, 'manifest id mismatch');
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  eq(store.verify('test-pack').ok, true, 'restored');
}

// ---- Remove ------------------------------------------------------------------------------------
eq(store.remove('other-pack'), { removed: true, packVersion: '1.0.0' }, 'remove');
eq(store.remove('other-pack'), { removed: false }, 'remove again');
throws(() => store.remove('../x'), /Invalid pack id/, 'remove bad id');
eq(store.list().map(p => p.id), ['test-pack'], 'list after remove');
eq(fs.readdirSync(ROOT + '-staging'), [], 'staging cleaned after remove');

// ---- IPC ----------------------------------------------------------------------------------------
(async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const audits = [];
  const auditObj = { write: (ev, data) => audits.push([ev, data]) };
  let dialogResult = { canceled: true };
  S.registerPackIpc(ipcMain, store, {
    dialog: { showOpenDialog: async () => dialogResult },
    getWindow: () => null,
    audit: () => auditObj,
    AUDIT_EVENTS: { AGENCY_PACK_INSTALLED: 'agency_pack_installed', AGENCY_PACK_REMOVED: 'agency_pack_removed' },
  });
  eq(Object.keys(handlers).sort(), ['agency-pack-build', 'agency-pack-choose', 'agency-pack-get', 'agency-pack-install', 'agency-pack-list', 'agency-pack-open-output', 'agency-pack-remove', 'agency-pack-verify'], 'ipc channels');
  const lst = await handlers['agency-pack-list']({});
  eq([lst.success, lst.packs.map(p => p.id)], [true, ['test-pack']], 'ipc list');
  const got = await handlers['agency-pack-get']({}, 'test-pack');
  ok(got.success && !('files' in got.manifest) && got.config.templatesConfig[T_ACME], 'ipc get hides file hashes');
  const bad = await handlers['agency-pack-get']({}, '../x');
  eq([bad.success, bad.error], [false, 'Invalid pack id'], 'ipc get bad id');
  eq(await handlers['agency-pack-choose']({}), { success: true, canceled: true }, 'ipc choose canceled');
  dialogResult = { canceled: false, filePaths: [PACK3] };
  const ch = await handlers['agency-pack-choose']({});
  eq([ch.success, ch.filePath, ch.summary.id, ch.summary.installedVersion], [true, PACK3, 'other-pack', null], 'ipc choose summary');
  const nope = await handlers['agency-pack-install']({}, path.join(TMP, 'x.zip'));
  eq([nope.success, nope.error], [false, 'Choose a .viperpack file'], 'ipc install needs .viperpack');
  const insR = await handlers['agency-pack-install']({}, PACK3);
  eq([insR.success, insR.pack.id], [true, 'other-pack'], 'ipc install');
  const badIns = await handlers['agency-pack-install']({}, path.join(TMP, 'variants', 'hash.viperpack'));
  ok(!badIns.success && /Checksum mismatch/.test(badIns.error), 'ipc install rejects tampered');
  const ver = await handlers['agency-pack-verify']({}, 'other-pack');
  eq([ver.success, ver.ok], [true, true], 'ipc verify');
  const rem = await handlers['agency-pack-remove']({}, 'other-pack');
  eq([rem.success, rem.removed], [true, true], 'ipc remove');
  const rem2 = await handlers['agency-pack-remove']({}, 'other-pack');
  eq([rem2.success, rem2.removed], [true, false], 'ipc remove missing');
  eq(audits.map(a => a[0]), ['agency_pack_installed', 'agency_pack_removed'], 'audit events (only on real changes)');
  eq(audits[0][1], { pack_id: 'other-pack', pack_version: '1.0.0', templates: 2 }, 'install audit details');
  // An audit failure never blocks
  const h2 = {};
  S.registerPackIpc({ handle: (c, f) => { h2[c] = f; } }, store, { audit: () => { throw new Error('x'); }, AUDIT_EVENTS: { AGENCY_PACK_INSTALLED: 'a' } });
  eq((await h2['agency-pack-install']({}, PACK3)).success, true, 'audit failure does not block');

  // ---- Build + save IPC --------------------------------------------------------------------------
  {
    const hb = {};
    const bAudits = [];
    const savedToCase = [];
    const written = [];
    let saveResult = { canceled: true };
    let focusRestored = 0;
    S.registerPackIpc({ handle: (c, f) => { hb[c] = f; } }, store, {
      dialog: { showSaveDialog: async (_w, o) => { written.push(['dialog', o.defaultPath, o.filters[0].extensions[0]]); return saveResult; } },
      getWindow: () => null,
      audit: () => ({ write: (ev, data) => bAudits.push([ev, data]) }),
      AUDIT_EVENTS: { AGENCY_PACK_DOCS_GENERATED: 'agency_pack_docs_generated' },
      saveToCase: (cn, name, bytes) => { savedToCase.push([cn, name, bytes.length > 0]); return { fileName: name.replace('.docx', ' (1).docx') }; },
      defaultDir: () => path.join(TMP, 'docs'),
      restoreFocus: () => { focusRestored++; },
      writeFile: (p, b) => written.push(['write', path.basename(p), b.length > 0, b.slice(0, 2).toString('latin1')]),
    });
    ok(typeof hb['agency-pack-build'] === 'function', 'ipc build registered');
    const values = { 'global:g_case': '26-000777', ['tpl:' + T_ACME + ':account']: 'user@example.test', ['tpl:' + T_ARR + ':defendant name']: 'Pat SYNTHETIC' };
    const base = { packId: 'test-pack', templateIds: [T_ACME, T_ARR], values, county: 'South County' };

    const toCase = await hb['agency-pack-build']({}, Object.assign({ mode: 'case', caseNumber: ' 26-000777 ' }, base));
    eq([toCase.success, toCase.count, toCase.saved], [true, 2, ['26000777 SW Acme_user@example.test (1).docx', '26000777 AW South County_Pat SYNTHETIC (1).docx']], 'build to case');
    eq(savedToCase, [['26-000777', '26000777 SW Acme_user@example.test.docx', true], ['26-000777', '26000777 AW South County_Pat SYNTHETIC.docx', true]], 'saveToCase called per document');
    eq(bAudits[0], ['agency_pack_docs_generated', { case_number: '26-000777', pack_id: 'test-pack', pack_version: '1.1.0', documents: 2, destination: 'case',
      files: ['26000777 SW Acme_user@example.test (1).docx', '26000777 AW South County_Pat SYNTHETIC (1).docx'] }], 'case audit');

    const noCase = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'case', caseNumber: '  ' }));
    eq([noCase.success, noCase.error], [false, 'Open a case first'], 'case mode needs a case number');
    const badMode = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'email' }));
    eq([badMode.success, badMode.error], [false, 'Unknown save option'], 'unknown mode');
    const noReq = await hb['agency-pack-build']({}, null);
    eq(noReq.success, false, 'null request rejected');
    const badPack = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'saveAs', packId: '../x' }));
    eq([badPack.success, badPack.error], [false, 'Invalid pack id'], 'bad pack id');
    const noTpl = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'saveAs', templateIds: [] }));
    eq([noTpl.success, noTpl.error], [false, 'Choose at least one template'], 'no templates');

    written.length = 0;
    const cancel = await hb['agency-pack-build']({}, Object.assign({ mode: 'saveAs' }, base));
    eq(cancel, { success: true, canceled: true }, 'save as canceled');
    eq(written, [['dialog', path.join(TMP, 'docs', '26000777_Warrant_Packet.zip'), 'zip']], 'packet default name');
    ok(focusRestored >= 1, 'focus restored after dialog');

    written.length = 0;
    saveResult = { canceled: false, filePath: path.join(TMP, 'docs', 'packet.zip') };
    const asZip = await hb['agency-pack-build']({}, Object.assign({ mode: 'saveAs' }, base));
    eq([asZip.success, asZip.count, asZip.zipped], [true, 2, true], 'save as zip');
    eq(written[1], ['write', 'packet.zip', true, 'PK'], 'zip written');
    eq(bAudits[bAudits.length - 1][1].destination, 'export', 'export audited');
    eq(bAudits[bAudits.length - 1][1].files, ['packet.zip'], 'export audit names the file only');

    written.length = 0;
    saveResult = { canceled: false, filePath: path.join(TMP, 'docs', 'one.docx') };
    const one = await hb['agency-pack-build']({}, Object.assign({ mode: 'saveAs' }, base, { templateIds: [T_ACME] }));
    eq([one.success, one.zipped], [true, false], 'save as single docx');
    eq(written[0][1], path.join(TMP, 'docs', '26000777 SW Acme_user@example.test.docx'), 'single default name');
    eq(written[0][2], 'docx', 'single docx filter');

    const auditsBefore = bAudits.length;
    written.length = 0;
    saveResult = { canceled: false, filePath: path.join(TMP, 'docs', 'blank.zip') };
    const blankR = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'blank' }));
    eq([blankR.success, blankR.count], [true, 2], 'blank forms');
    eq(written[0][1], path.join(TMP, 'docs', 'Blank_Forms.zip'), 'blank default name');
    eq(bAudits.length, auditsBefore, 'blank forms not audited (no case data)');

    const huge = await hb['agency-pack-build']({}, Object.assign({}, base, { mode: 'saveAs', values: { x: 'a'.repeat(61 * 1024 * 1024) } }));
    ok(!huge.success && /too large/.test(huge.error), 'oversized form rejected');

    const hc = {};
    S.registerPackIpc({ handle: (c, f) => { hc[c] = f; } }, store, {});
    const noSaver = await hc['agency-pack-build']({}, Object.assign({ mode: 'case', caseNumber: 'X1' }, base));
    eq([noSaver.success, noSaver.error], [false, 'Saving to the case is not available'], 'no saveToCase dep');
  }

  // ---- Word documents into Downloads + open / show ------------------------------------------------
  {
    const DL = path.join(TMP, 'Downloads');
    fs.mkdirSync(DL, { recursive: true });
    const hd = {};
    const dAudits = [];
    const shellCalls = [];
    let openErr = '';
    S.registerPackIpc({ handle: (c, f) => { hd[c] = f; } }, store, {
      audit: () => ({ write: (ev, data) => dAudits.push([ev, data]) }),
      AUDIT_EVENTS: { AGENCY_PACK_DOCS_GENERATED: 'agency_pack_docs_generated' },
      downloadsDir: () => DL,
      shell: { openPath: async (p) => { shellCalls.push(['open', p]); return openErr; }, showItemInFolder: (p) => shellCalls.push(['show', p]) },
    });
    const values = { 'global:g_case': '26-000777', ['tpl:' + T_ACME + ':account']: 'user@example.test', ['tpl:' + T_ARR + ':defendant name']: 'Pat SYNTHETIC' };
    const base = { packId: 'test-pack', templateIds: [T_ACME, T_ARR], values, county: 'South County', caseNumber: '26-000777' };
    const r1 = await hd['agency-pack-build']({}, Object.assign({ mode: 'downloads' }, base));
    eq([r1.success, r1.count, r1.dir], [true, 2, DL], 'downloads build');
    eq(r1.files.map(f => f.name), ['26000777 SW Acme_user@example.test.docx', '26000777 AW South County_Pat SYNTHETIC.docx'], 'each document separately (no zip)');
    ok(r1.files.every(f => path.dirname(f.path) === DL && fs.readFileSync(f.path).slice(0, 2).toString('latin1') === 'PK'), 'docx files written in Downloads');
    eq(dAudits[0], ['agency_pack_docs_generated', { case_number: '26-000777', pack_id: 'test-pack', pack_version: '1.1.0', documents: 2, destination: 'downloads',
      files: ['26000777 SW Acme_user@example.test.docx', '26000777 AW South County_Pat SYNTHETIC.docx'] }], 'downloads audit names files only');
    const r2 = await hd['agency-pack-build']({}, Object.assign({ mode: 'downloads' }, base, { templateIds: [T_ACME] }));
    eq(r2.files.map(f => f.name), ['26000777 SW Acme_user@example.test (2).docx'], 'never overwrites: (2)');
    const r3 = await hd['agency-pack-build']({}, Object.assign({ mode: 'downloads' }, base, { templateIds: [T_ACME] }));
    eq(r3.files.map(f => f.name), ['26000777 SW Acme_user@example.test (3).docx'], 'never overwrites: (3)');
    const noCaseOk = await hd['agency-pack-build']({}, Object.assign({ mode: 'downloads' }, base, { caseNumber: '' }));
    eq(noCaseOk.success, true, 'downloads does not need a case number');

    const op = await hd['agency-pack-open-output']({}, { path: r1.files[0].path });
    eq([op.success, op.opened, shellCalls[0]], [true, true, ['open', r1.files[0].path]], 'open in Word');
    const sh = await hd['agency-pack-open-output']({}, { path: r1.files[1].path, action: 'show' });
    eq([sh.success, sh.shown, shellCalls[1]], [true, true, ['show', r1.files[1].path]], 'show in folder');
    openErr = 'No application';
    const oe = await hd['agency-pack-open-output']({}, { path: r1.files[0].path });
    ok(!oe.success && /No application/.test(oe.error), 'open error reported');
    const calls = shellCalls.length;
    const outside = await hd['agency-pack-open-output']({}, { path: path.join(TMP, 'docs', 'x.docx') });
    ok(!outside.success && /Only Builder documents/.test(outside.error), 'outside Downloads refused');
    const sub = await hd['agency-pack-open-output']({}, { path: path.join(DL, 'sub', 'x.docx') });
    eq(sub.success, false, 'subfolder refused');
    const trav = await hd['agency-pack-open-output']({}, { path: path.join(DL, '..', 'x.docx') });
    eq(trav.success, false, 'traversal refused');
    fs.writeFileSync(path.join(DL, 'evil.exe'), 'x');
    const exe = await hd['agency-pack-open-output']({}, { path: path.join(DL, 'evil.exe') });
    eq(exe.success, false, 'non-docx refused');
    const gone = await hd['agency-pack-open-output']({}, { path: path.join(DL, 'gone.docx') });
    ok(!gone.success && /no longer in Downloads/.test(gone.error), 'missing file explained');
    eq((await hd['agency-pack-open-output']({}, null)).success, false, 'null request refused');
    eq((await hd['agency-pack-open-output']({}, { path: 42 })).success, false, 'non-string path refused');
    eq(shellCalls.length, calls, 'shell never called for refused paths');

    const hn = {};
    S.registerPackIpc({ handle: (c, f) => { hn[c] = f; } }, store, {});
    const noDl = await hn['agency-pack-build']({}, Object.assign({ mode: 'downloads' }, base));
    eq([noDl.success, noDl.error], [false, 'The Downloads folder is not available'], 'no downloadsDir dep');
  }

  console.log(`pack-store: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
