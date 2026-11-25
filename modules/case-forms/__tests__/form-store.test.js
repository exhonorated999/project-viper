'use strict';
// Tests for modules/case-forms/form-store.js. Every PDF, set and case here is SYNTHETIC.
// Run: node modules/case-forms/__tests__/form-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const S = require('../form-set.js');
const F = require('../form-store.js');

let pass = 0, failed = 0;
function ok(c, label) { if (c) pass++; else { failed++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
function throws(fn, re, label) {
  try { fn(); ok(false, label + ' — did not throw'); } catch (e) {
    ok(e instanceof S.FormSetError && re.test(e.message), label + ' — wrong error: ' + e.message);
  }
}
async function rejects(p, re, label) {
  try { await p; ok(false, label + ' — did not reject'); } catch (e) {
    ok(e instanceof S.FormSetError && re.test(e.message), label + ' — wrong error: ' + e.message);
  }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-cf-store-'));
const ROOT = path.join(TMP, 'userData', 'case-forms');
const CASES = path.join(TMP, 'cases');

async function pdfWith(fieldNames) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  fieldNames.forEach((n, i) => {
    if (n.startsWith('[x]')) form.createCheckBox(n.slice(3)).addToPage(page, { x: 300, y: 700 - i * 30, width: 14, height: 14 });
    else form.createTextField(n).addToPage(page, { x: 50, y: 700 - i * 30, width: 200, height: 18 });
  });
  return Buffer.from(await doc.save());
}

function buildSet(pdfs, over) {
  return S.buildFormSetBuffer(Object.assign({
    id: 'sample-pd',
    name: 'Sample PD forms',
    agency: 'Sample Police Department',
    version: '1.0.0',
    createdAt: '2026-11-24T00:00:00.000Z',
    forms: [
      {
        id: 'advisement', title: 'Advisement (adult)', category: 'Interview', language: 'en',
        slots: [{ id: 'subject', label: 'Subject' }],
        bindings: { 'Case Number': { src: 'case.number' }, 'Last Name': { src: 'person.lastName', slot: 'subject' } },
        pdf: pdfs.a,
      },
      { id: 'vehicle-hold', title: 'Vehicle hold', category: 'Property', flatten: true, pdf: pdfs.b },
    ],
  }, over || {}));
}

// Field Security stand-in: "VIPENC" + reversed bytes.
function fakeSecurity(state) {
  const MAGIC = Buffer.from('VIPENC');
  return {
    isEnabled: () => state.enabled,
    isUnlocked: () => state.unlocked,
    isEncryptedBuffer: (b) => b.length >= 6 && b.slice(0, 6).equals(MAGIC),
    encryptBuffer: (b) => Buffer.concat([MAGIC, Buffer.from(b).reverse()]),
    decryptBuffer: (b) => Buffer.from(b.slice(6)).reverse(),
  };
}

function writeCaseFileFor(security) {
  return (cn, subdir, name, buf) => {
    const dir = path.join(CASES, cn, subdir);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = security.isEnabled() && security.isUnlocked() ? security.encryptBuffer(buf) : buf;
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let final = name;
    for (let n = 1; ; n++) {
      try { fs.writeFileSync(path.join(dir, final), bytes, { flag: 'wx' }); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        final = `${stem} (${n})${ext}`;
      }
    }
    return { fileName: final, size: buf.length };
  };
}

function mockResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

(async () => {
  const pdfs = { a: await pdfWith(['Case Number', 'Last Name', '[x]Waived']), b: await pdfWith(['Plate', 'Officer']) };
  const v1 = buildSet(pdfs);
  const v2 = buildSet(pdfs, { version: '1.1.0', description: 'Updated' });

  // ---------------------------------------------------------------- store
  let clock = 1_700_000_000_000;
  const store = F.createFormStore({ fs, path, crypto, rootDir: ROOT, now: () => clock++ });
  eq(store.list(), [], 'empty list before anything is installed');
  ok(!store.hasAny(), 'hasAny false when empty');

  const inst = store.installBuffer(v1.buffer, { source: 'library', sourceName: 'Sample PD forms', expectedSha256: sha(v1.buffer) });
  eq([inst.id, inst.version, inst.formCount, inst.source, inst.previousVersion], ['sample-pd', '1.0.0', 2, 'library', null], 'install summary');
  ok(fs.existsSync(path.join(ROOT, 'sample-pd', 'forms', 'advisement.pdf')), 'pdf written');
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-pd', F.INSTALL_INFO), 'utf8'));
  eq([info.source, info.sha256], ['library', sha(v1.buffer)], 'install-info records source and file hash');
  eq(fs.readdirSync(ROOT + '-staging'), [], 'staging emptied after install');
  ok(store.hasAny(), 'hasAny after install');

  const listed = store.list();
  eq(listed.map(s => [s.id, s.version, s.source, s.sha256 === sha(v1.buffer)]), [['sample-pd', '1.0.0', 'library', true]], 'list');
  eq(listed[0].forms.map(f => f.id), ['advisement', 'vehicle-hold'], 'list forms');

  const m = store.load('sample-pd');
  eq(m.forms.length, 2, 'load');
  ok(store.readPdf('sample-pd', 'advisement').equals(pdfs.a), 'readPdf returns the original bytes');
  throws(() => store.readPdf('sample-pd', 'nope'), /not in this set/, 'unknown form id');
  throws(() => store.readPdf('sample-pd', '../x'), /Unknown form/, 'bad form id');
  throws(() => store.load('../etc'), /Invalid form set id/, 'bad set id');
  throws(() => store.load('not-here'), /not installed/, 'not installed');
  eq(store.verify('sample-pd'), { ok: true, problems: [], formCount: 2 }, 'verify clean');

  // Tamper detection
  const pdfPath = path.join(ROOT, 'sample-pd', 'forms', 'vehicle-hold.pdf');
  const orig = fs.readFileSync(pdfPath);
  fs.writeFileSync(pdfPath, Buffer.concat([orig, Buffer.from('\n%tamper')]));
  throws(() => store.readPdf('sample-pd', 'vehicle-hold'), /changed on disk/, 'tampered pdf refused');
  eq(store.verify('sample-pd').problems, ['Changed: forms/vehicle-hold.pdf'], 'verify reports tamper');
  fs.unlinkSync(pdfPath);
  throws(() => store.readPdf('sample-pd', 'vehicle-hold'), /missing on disk/, 'missing pdf refused');
  fs.writeFileSync(pdfPath, orig);

  // Bad inputs never disturb the installed set
  throws(() => store.installBuffer(v2.buffer, { expectedSha256: sha(v1.buffer) }), /checksum mismatch/, 'expected sha mismatch');
  throws(() => store.installBuffer(v2.buffer, { expectedId: 'other-pd' }), /different form set/, 'expected id mismatch');
  throws(() => store.installBuffer(Buffer.from('not a zip at all, definitely not')), /damaged|not a form set/, 'garbage refused');
  throws(() => store.installBuffer(Buffer.alloc(0)), /Nothing to install/, 'empty refused');
  eq(store.load('sample-pd').version, '1.0.0', 'still v1 after failed installs');
  const small = F.createFormStore({ fs, path, crypto, rootDir: ROOT, maxFileBytes: 100 });
  throws(() => small.installBuffer(v1.buffer), /too large/, 'size cap on buffer');

  // File import + inspect
  const fileV2 = path.join(TMP, 'sample-v2.viperforms');
  fs.writeFileSync(fileV2, v2.buffer);
  const insp = store.inspectFile(fileV2);
  eq([insp.version, insp.installedVersion, insp.versionVsInstalled, insp.olderThanInstalled], ['1.1.0', '1.0.0', 1, false], 'inspect newer file');
  throws(() => small.installFile(fileV2), /too large/, 'size cap on file');
  throws(() => store.installFile(path.join(TMP, 'missing.viperforms')), /could not be read/, 'missing file');
  const up = store.installFile(fileV2);
  eq([up.version, up.previousVersion, up.source], ['1.1.0', '1.0.0', 'file'], 'replace via file');
  eq(store.list()[0].source, 'file', 'source now file');
  const fileV1 = path.join(TMP, 'sample-v1.viperforms');
  fs.writeFileSync(fileV1, v1.buffer);
  eq(store.inspectFile(fileV1).olderThanInstalled, true, 'inspect older file');
  eq(fs.readdirSync(ROOT + '-staging'), [], 'staging empty after replace');

  // Damaged install shows as an error row, not a crash
  fs.mkdirSync(path.join(ROOT, 'broken-set'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'broken-set', 'manifest.json'), '{nope');
  fs.writeFileSync(path.join(ROOT, 'README.txt'), 'x');
  const withBroken = store.list();
  eq(withBroken.map(s => [s.id, !!s.error]), [['broken-set', true], ['sample-pd', false]], 'broken set listed with error');
  eq(store.remove('broken-set').removed, true, 'broken set removable');

  // ---------------------------------------------------------------- library client
  const calls = [];
  let routes = {};
  const fakeFetch = async (url, opts) => {
    calls.push({ url, key: opts && opts.headers && opts.headers['X-API-Key'] });
    const r = routes[url];
    if (!r) return mockResponse(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  };
  const BASE = 'https://dash.example.test';
  const lib = F.createLibraryClient({ fetch: fakeFetch, baseUrl: BASE + '/' });
  const entryV2 = { id: 'sample-pd', name: 'Sample PD forms', agency: 'Sample Police Department', description: 'Updated', version: '1.1.0', sha256: sha(v2.buffer), size: v2.buffer.length, formCount: 2, forms: [{ id: 'advisement', title: 'Advisement (adult)', category: 'Interview', language: 'en', group: '' }, { id: 'vehicle-hold', title: 'Vehicle hold' }], updatedAt: '2026-11-24T00:00:00Z' };
  routes[BASE + '/api/form-sets'] = () => mockResponse(JSON.stringify({ sets: [
    entryV2,
    Object.assign({}, entryV2),                              // duplicate id → dropped
    { id: 'BAD ID', name: 'x', version: '1', sha256: sha(v1.buffer), size: 10 },
    { id: 'no-sha', name: 'x', version: '1', sha256: 'abc', size: 10 },
    { id: 'huge-set', name: 'x', version: '1', sha256: sha(v1.buffer), size: 500 * 1024 * 1024 },
    'nonsense',
  ] }), { headers: { 'content-type': 'application/json' } });
  const cat = await lib.catalogue('KEY1');
  eq(cat.map(e => e.id), ['sample-pd'], 'catalogue keeps only well-formed entries');
  eq(cat[0].forms[1], { id: 'vehicle-hold', title: 'Vehicle hold', category: '', language: '', group: '' }, 'form summary normalised');
  eq(calls[0], { url: BASE + '/api/form-sets', key: 'KEY1' }, 'catalogue sends X-API-Key, trailing slash trimmed');
  await rejects(lib.catalogue(''), /Missing API key/, 'no key');

  routes[BASE + '/api/form-sets'] = () => mockResponse(JSON.stringify({ detail: 'Invalid or inactive API key' }), { status: 401 });
  try { await lib.catalogue('OLD'); ok(false, '401 should reject'); } catch (e) {
    ok(e instanceof F.LibraryError && e.status === 401 && /invalid or inactive api key/i.test(e.message), '401 detail + status passed through');
  }
  routes[BASE + '/api/form-sets'] = new TypeError('fetch failed');
  await rejects(lib.catalogue('K'), /Could not reach/, 'network error');
  routes[BASE + '/api/form-sets'] = () => mockResponse('<html>', { status: 200 });
  await rejects(lib.catalogue('K'), /unreadable/, 'non-JSON catalogue');
  routes[BASE + '/api/form-sets'] = () => mockResponse(JSON.stringify({ nope: 1 }));
  await rejects(lib.catalogue('K'), /unreadable/, 'wrong catalogue shape');

  const DL = BASE + '/api/form-sets/sample-pd/download';
  routes[DL] = () => mockResponse(v2.buffer, { headers: { 'x-form-set-sha256': sha(v2.buffer) } });
  ok((await lib.download('K', entryV2)).equals(v2.buffer), 'download verified');
  routes[DL] = () => mockResponse(v2.buffer, { headers: { 'x-form-set-sha256': sha(v1.buffer) } });
  await rejects(lib.download('K', entryV2), /changed in the library/, 'header sha differs from catalogue');
  routes[DL] = () => mockResponse(v1.buffer);
  await rejects(lib.download('K', entryV2), /checksum mismatch/, 'body sha differs from catalogue');
  routes[DL] = () => mockResponse(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
  await rejects(lib.download('K', entryV2), /no longer in the library/, '404 download');
  const tiny = F.createLibraryClient({ fetch: fakeFetch, baseUrl: BASE, maxBytes: 1000 });
  routes[DL] = () => mockResponse(v2.buffer, { headers: { 'content-length': String(v2.buffer.length) } });
  await rejects(tiny.download('K', entryV2), /too large/, 'content-length over cap');
  routes[DL] = () => mockResponse(new ReadableStream({
    start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(400)); c.close(); },
  }));
  await rejects(tiny.download('K', entryV2), /too large/, 'streamed body over cap');
  await rejects(lib.download('K', { id: 'x' }), /Unknown form set/, 'download needs a real entry');

  // ---------------------------------------------------------------- merge
  const installedRows = [
    { id: 'a-set', version: '1.0.0', source: 'library', sha256: 'a'.repeat(64) },
    { id: 'b-set', version: '1.0.0', source: 'file', sha256: 'b'.repeat(64) },
    { id: 'c-set', version: '2.0.0', source: 'library', sha256: 'c'.repeat(64) },
    { id: 'local-only', version: '0.1', source: 'file' },
    { id: 'broken', error: 'manifest.json is missing' },
  ];
  const catRows = [
    { id: 'a-set', version: '1.0.0', sha256: 'f'.repeat(64) },   // same version, republished → update
    { id: 'b-set', version: '1.0.1', sha256: 'b'.repeat(64) },   // file install, newer in library → update
    { id: 'c-set', version: '2.0.0', sha256: 'c'.repeat(64) },   // identical
    { id: 'new-set', version: '1.0.0', sha256: 'd'.repeat(64) },
    { id: 'broken', version: '1.0.0', sha256: 'e'.repeat(64) },
  ];
  const merged = F.mergeLibrary(catRows, installedRows);
  eq(merged.map(r => [r.id, r.inLibrary, r.installed, r.updateAvailable]), [
    ['a-set', true, true, true], ['b-set', true, true, true], ['c-set', true, true, false],
    ['new-set', true, false, false], ['broken', true, true, false], ['local-only', false, true, false],
  ], 'merge rows');
  eq(merged[4].installError, 'manifest.json is missing', 'broken install surfaces its error');
  eq(merged[0].installedVersion, '1.0.0', 'installedVersion carried');

  // ---------------------------------------------------------------- helpers
  eq(F.checkValues({ a: 'x', b: true, c: null }), { a: 'x', b: true }, 'checkValues keeps text/bools, drops null');
  throws(() => F.checkValues([1]), /could not be read/, 'checkValues array');
  throws(() => F.checkValues({ a: 5 }), /must be text/, 'checkValues number');
  throws(() => F.checkValues({ a: 'x'.repeat(20001) }), /too long/, 'checkValues long');
  throws(() => F.checkValues({ ['x'.repeat(301)]: 'a' }), /bad field name/, 'checkValues long name');
  const many = {}; for (let i = 0; i < 2001; i++) many['f' + i] = 'v';
  throws(() => F.checkValues(many), /too many/, 'checkValues count');
  const d = new Date(2026, 10, 25);
  eq(F.outputFileName('Advisement (adult)', 'DOE, John', d), 'Advisement (adult) - DOE, John - 2026-11-25.pdf', 'output name');
  eq(F.outputFileName('A/B: "C"', '..\\..\\x', d), 'A_B_ _C_ - _.._x - 2026-11-25.pdf', 'output name sanitised');
  eq(F.outputFileName('', '', d), 'Form - 2026-11-25.pdf', 'output name fallback');
  eq([F.safeCaseNumber(' 26-001 '), F.safeCaseNumber('../x'), F.safeCaseNumber('a/b'), F.safeCaseNumber(''), F.safeCaseNumber(5)], ['26-001', null, null, null, null], 'safeCaseNumber');

  // ---------------------------------------------------------------- case Forms folder
  const secState = { enabled: false, unlocked: false };
  const security = fakeSecurity(secState);
  const opened = [], shown = [];
  const shell = { openPath: async (p) => { opened.push(p); return ''; }, showItemInFolder: (p) => shown.push(p) };
  const caseForms = F.createCaseForms({ fs, path, getCasesDir: () => CASES, getSecurity: () => security, writeCaseFile: writeCaseFileFor(security), tempDir: path.join(TMP, 'view'), shell, now: () => 42 });
  const noRoot = F.createCaseForms({ fs, path, getCasesDir: () => null, security, writeCaseFile: writeCaseFileFor(security) });
  throws(() => noRoot.listFiles('26-001'), /cases folder/, 'no cases folder');
  eq(caseForms.listFiles('26-001'), [], 'no Forms folder yet');
  const s1 = caseForms.save('26-001', 'Plain.pdf', pdfs.b);
  eq(s1.fileName, 'Plain.pdf', 'plain save');
  ok(fs.readFileSync(path.join(CASES, '26-001', 'Forms', 'Plain.pdf')).equals(pdfs.b), 'plain bytes on disk');
  eq(caseForms.save('26-001', 'Plain.pdf', pdfs.b).fileName, 'Plain (1).pdf', 'collision suffixed');
  secState.enabled = true; secState.unlocked = false;
  throws(() => caseForms.save('26-001', 'Locked.pdf', pdfs.b), /Unlock Field Security/, 'locked refuses to write');
  ok(!fs.existsSync(path.join(CASES, '26-001', 'Forms', 'Locked.pdf')), 'nothing written while locked');
  secState.unlocked = true;
  caseForms.save('26-001', 'Secret.pdf', pdfs.a);
  ok(security.isEncryptedBuffer(fs.readFileSync(path.join(CASES, '26-001', 'Forms', 'Secret.pdf'))), 'encrypted on disk when unlocked');
  fs.writeFileSync(path.join(CASES, '26-001', 'Forms', 'notes.txt'), 'x');
  eq(caseForms.listFiles('26-001').map(f => f.fileName).sort(), ['Plain (1).pdf', 'Plain.pdf', 'Secret.pdf'], 'list only pdfs');
  throws(() => caseForms.listFiles('../x'), /Open a case/, 'list bad case');

  await caseForms.open('26-001', 'Secret.pdf', 'open');
  ok(opened.length === 1 && opened[0].startsWith(path.join(TMP, 'view')), 'encrypted form opened from a decrypted temp copy');
  ok(fs.readFileSync(opened[0]).equals(pdfs.a), 'temp copy is the plaintext');
  await caseForms.open('26-001', 'Plain.pdf', 'open');
  eq(opened[1], path.join(CASES, '26-001', 'Forms', 'Plain.pdf'), 'plain form opened in place');
  await caseForms.open('26-001', 'Plain.pdf', 'show');
  eq(shown, [path.join(CASES, '26-001', 'Forms', 'Plain.pdf')], 'show in folder');
  secState.unlocked = false;
  await rejects(caseForms.open('26-001', 'Secret.pdf', 'open'), /unlock Field Security/, 'locked encrypted open refused');
  await rejects(caseForms.open('26-001', '..\\x.pdf', 'open'), /Unknown form file/, 'traversal refused');
  await rejects(caseForms.open('26-001', 'notes.txt', 'open'), /Unknown form file/, 'non-pdf refused');
  await rejects(caseForms.open('26-001', 'Gone.pdf', 'open'), /no longer in the case/, 'missing refused');

  // ---------------------------------------------------------------- IPC
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const audits = [];
  const savedAs = path.join(TMP, 'export', 'out.pdf');
  fs.mkdirSync(path.dirname(savedAs), { recursive: true });
  let dialogAnswer = { canceled: false, filePath: savedAs };
  const ipcStore = F.createFormStore({ fs, path, crypto, rootDir: path.join(TMP, 'ipc', 'case-forms'), now: () => clock++ });
  const libRoutes = {
    catalogue: async () => [entryV2],
    download: async () => v2.buffer,
  };
  F.registerFormIpc(ipcMain, ipcStore, {
    library: { catalogue: (k) => libRoutes.catalogue(k), download: (k, e) => libRoutes.download(k, e) },
    caseForms,
    dialog: {
      showSaveDialog: async () => dialogAnswer,
      showOpenDialog: async () => ({ canceled: false, filePaths: [fileV1] }),
    },
    getWindow: () => null,
    restoreFocus: () => {},
    defaultDir: () => path.join(TMP, 'export'),
    audit: () => ({ write: (ev, data) => audits.push([ev, data]) }),
    AUDIT_EVENTS: { CASE_FORM_SET_INSTALLED: 'case_form_set_installed', CASE_FORM_SET_REMOVED: 'case_form_set_removed', CASE_FORM_FILLED: 'case_form_filled' },
  });
  const call = (ch, ...a) => handlers[ch]({}, ...a);
  eq(Object.keys(handlers).sort(), ['case-forms-case-files', 'case-forms-choose-file', 'case-forms-enable', 'case-forms-fill', 'case-forms-get-form',
    'case-forms-install-file', 'case-forms-installed', 'case-forms-library', 'case-forms-open', 'case-forms-remove', 'case-forms-verify'], 'channels');

  let r = await call('case-forms-library', { apiKey: 'K' });
  eq([r.success, r.online, r.sets.length, r.sets[0].installed], [true, true, 1, false], 'library lists the set, not installed');
  libRoutes.catalogue = async () => { throw new F.LibraryError('Invalid or inactive API key', 401); };
  r = await call('case-forms-library', { apiKey: 'OLD' });
  eq([r.success, r.online, r.libraryStatus, r.sets.length], [true, false, 401, 0], 'library offline/auth failure falls back to installed');
  ok(/inactive api key/i.test(r.libraryError), 'libraryError carries the server detail');
  r = await call('case-forms-enable', { apiKey: 'OLD', id: 'sample-pd' });
  eq([r.success, r.status], [false, 401], 'enable passes the auth status back for the self-heal retry');
  libRoutes.catalogue = async () => [entryV2];

  r = await call('case-forms-enable', { apiKey: 'K', id: 'nope-set' });
  ok(!r.success && /no longer in the library/.test(r.error), 'enable unknown id');
  r = await call('case-forms-enable', { apiKey: 'K', id: '../x' });
  ok(!r.success && /Unknown form set/.test(r.error), 'enable bad id');
  libRoutes.download = async () => v1.buffer;    // client verified it, but it is not what the catalogue said
  r = await call('case-forms-enable', { apiKey: 'K', id: 'sample-pd' });
  ok(!r.success && /checksum mismatch/.test(r.error), 'store re-checks the catalogue hash');
  libRoutes.download = async () => v2.buffer;
  r = await call('case-forms-enable', { apiKey: 'K', id: 'sample-pd' });
  eq([r.success, r.set && r.set.version, r.set && r.set.source], [true, '1.1.0', 'library'], 'enable installs');
  eq(audits[0], ['case_form_set_installed', { set_id: 'sample-pd', version: '1.1.0', forms: 2, source: 'library', previous_version: null }], 'enable audited');
  r = await call('case-forms-library', { apiKey: 'K' });
  eq([r.sets[0].installed, r.sets[0].updateAvailable, r.sets[0].installedSource], [true, false, 'library'], 'installed, up to date');
  r = await call('case-forms-installed');
  eq(r.sets.map(s => s.id), ['sample-pd'], 'installed channel');

  r = await call('case-forms-get-form', { setId: 'sample-pd', formId: 'advisement' });
  ok(r.success, 'get-form ok — ' + r.error);
  eq(r.form.slots, [{ id: 'subject', label: 'Subject' }], 'get-form slots');
  eq(Object.keys(r.form.bindings), ['Case Number', 'Last Name'], 'get-form bindings');
  eq(r.pdf.fields.map(f => f.name).sort(), ['Case Number', 'Last Name', 'Waived'], 'get-form fields from the pdf');
  r = await call('case-forms-get-form', { setId: 'sample-pd', formId: 'zzz' });
  ok(!r.success && /not in this set/.test(r.error), 'get-form unknown form');

  // preview
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'preview', values: { 'Case Number': '26-001', 'Last Name': 'SAMPLE', Waived: true, Ghost: 'x' } });
  ok(r.success, 'preview ok — ' + r.error);
  eq(r.filled, 3, 'preview filled count');
  eq(r.warnings.map(w => w.field), ['Ghost'], 'unknown field warned');
  const doc = await PDFDocument.load(Buffer.from(r.dataBase64, 'base64'));
  eq([doc.getForm().getTextField('Last Name').getText(), doc.getForm().getCheckBox('Waived').isChecked()], ['SAMPLE', true], 'preview bytes carry the values');
  const auditsBeforePreview = audits.length;

  // case save
  secState.enabled = false;
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'case', caseNumber: '26-002', nameHint: 'SAMPLE, Pat', values: { 'Case Number': '26-002' } });
  ok(r.success && /^Advisement \(adult\) - SAMPLE, Pat - \d{4}-\d{2}-\d{2}\.pdf$/.test(r.fileName), 'saved to the case — ' + (r.error || r.fileName));
  eq(audits.length, auditsBeforePreview + 1, 'preview not audited, save audited');
  const fa = audits[audits.length - 1];
  eq([fa[0], fa[1].case_number, fa[1].form_id, fa[1].destination, fa[1].filled], ['case_form_filled', '26-002', 'advisement', 'case', 1], 'fill audit');
  ok(!('values' in fa[1]), 'no values key in the audit');
  r = await call('case-forms-case-files', { caseNumber: '26-002' });
  eq(r.files.length, 1, 'case-files lists the saved form');
  const savedDoc = await PDFDocument.load(fs.readFileSync(path.join(CASES, '26-002', 'Forms', r.files[0].fileName)));
  eq(savedDoc.getForm().getTextField('Case Number').getText(), '26-002', 'saved form filled');

  // flatten honoured from the manifest
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'vehicle-hold', mode: 'case', caseNumber: '26-002', values: { Plate: 'ABC123' } });
  ok(r.success, 'vehicle hold saved');
  const flat = await PDFDocument.load(fs.readFileSync(path.join(CASES, '26-002', 'Forms', r.fileName)));
  eq(flat.getForm().getFields().length, 0, 'flatten:true form has no fields left');

  secState.enabled = true; secState.unlocked = false;
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'case', caseNumber: '26-003', values: {} });
  ok(!r.success && /Unlock Field Security/.test(r.error), 'locked: case save refused');
  ok(!fs.existsSync(path.join(CASES, '26-003')), 'locked: nothing created');
  secState.enabled = false;
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'case', caseNumber: '', values: {} });
  ok(!r.success && /Open a case/.test(r.error), 'case mode needs a case');
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'email', values: {} });
  ok(!r.success && /Unknown save option/.test(r.error), 'unknown mode');
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'preview', values: { a: 7 } });
  ok(!r.success && /must be text/.test(r.error), 'bad values refused');

  // save as
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'saveAs', caseNumber: '26-002', values: { 'Case Number': '26-002' } });
  eq([r.success, r.filePath], [true, savedAs], 'save as');
  ok(fs.existsSync(savedAs), 'save-as file written');
  eq(audits[audits.length - 1][1].destination, 'export', 'save-as audited as export');
  dialogAnswer = { canceled: true };
  r = await call('case-forms-fill', { setId: 'sample-pd', formId: 'advisement', mode: 'saveAs', values: {} });
  eq([r.success, r.canceled], [true, true], 'save-as cancel');

  r = await call('case-forms-open', { caseNumber: '26-002', fileName: '..\\..\\evil.pdf' });
  ok(!r.success && /Unknown form file/.test(r.error), 'open traversal refused over IPC');

  // file import over IPC
  r = await call('case-forms-choose-file');
  eq([r.success, r.summary.version, r.summary.olderThanInstalled], [true, '1.0.0', true], 'choose-file inspects');
  r = await call('case-forms-install-file', path.join(TMP, 'x.zip'));
  ok(!r.success && /\.viperforms/.test(r.error), 'install-file wants .viperforms');
  r = await call('case-forms-install-file', fileV1);
  eq([r.success, r.set.version, r.set.previousVersion], [true, '1.0.0', '1.1.0'], 'install-file (downgrade allowed when chosen)');
  r = await call('case-forms-library', { apiKey: 'K' });
  eq([r.sets[0].installedSource, r.sets[0].updateAvailable], ['file', true], 'file install older than library → update available');

  r = await call('case-forms-verify', 'sample-pd');
  eq([r.success, r.ok], [true, true], 'verify over IPC');
  r = await call('case-forms-remove', 'sample-pd');
  eq([r.success, r.removed, r.version], [true, true, '1.0.0'], 'remove');
  eq(audits[audits.length - 1], ['case_form_set_removed', { set_id: 'sample-pd', version: '1.0.0' }], 'remove audited');
  r = await call('case-forms-remove', 'sample-pd');
  eq([r.success, r.removed], [true, false], 'remove again is a no-op');
  eq(audits.filter(a => a[0] === 'case_form_set_removed').length, 1, 'no-op remove not audited');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`form-store: ${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
