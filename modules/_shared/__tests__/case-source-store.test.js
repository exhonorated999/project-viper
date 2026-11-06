/**
 * Tests for modules/_shared/case-source-store.js
 * Run: node modules/_shared/__tests__/case-source-store.test.js
 *
 * Field report (Nov 2026): an imported RMS report PDF was parsed and then
 * forgotten — unlike DMV printouts, the original never reached the case
 * folder. The store copies an imported file into cases/<n>/<folder>/.
 * All files here are synthetic and live in a temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('../case-source-store');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'css-test-'));
const casesDir = path.join(T, 'cases');
const srcDir = path.join(T, 'downloads');
fs.mkdirSync(casesDir); fs.mkdirSync(srcDir);

// Fake Field Security: "VIPENC" + reversed bytes.
const sec = { enabled: false, unlocked: true,
  isEnabled() { return this.enabled; }, isUnlocked() { return this.unlocked; },
  encryptBuffer(b) { return Buffer.concat([Buffer.from('VIPENC'), Buffer.from(b).reverse()]); },
  decryptBuffer(b) { return Buffer.from(b.slice(6)).reverse(); } };

function safeCaseNumber(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.indexOf('..') !== -1 || s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return null;
  return s;
}
function sanitizeName(n) {
  if (!n || typeof n !== 'string') return null;
  let b = n.replace(/[\\/]/g, '_').trim().replace(/[\x00-\x1f<>:"|?*]/g, '_');
  return (b === '.' || b === '..' || !b) ? null : b;
}
const store = S.create({ fs, path, getCasesDir: () => casesDir, getSecurity: () => sec,
  safeCaseNumber, sanitizeName, dirs: { rmsReports: 'RMS_Reports' }, maxEncryptBytes: 1000 });

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function src(name, text) { const p = path.join(srcDir, name); fs.writeFileSync(p, text); return p; }
const rmsDir = path.join(casesDir, 'CASE-001', 'RMS_Reports');

(async () => {
  // ── 1. plain copy ────────────────────────────────────────────────────
  const a = src('Offense Report.synthetic.pdf', '%PDF-1.4 synthetic offense report A');
  let r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: a });
  ok(r.success, '1 copy succeeds');
  eq(r.fileName, 'Offense Report.synthetic.pdf', '1 keeps the original name');
  eq(r.sha256, sha(fs.readFileSync(a)), '1 returns the SHA-256 of the source');
  eq(r.size, fs.statSync(a).size, '1 returns the size');
  eq(r.encrypted, false, '1 not encrypted with security off');
  eq(r.reused, false, '1 a new copy');
  ok(fs.readFileSync(path.join(rmsDir, r.fileName)).equals(fs.readFileSync(a)), '1 bytes identical');
  ok(fs.existsSync(a), '1 source left in place');

  // ── 2. same file again → reused ──────────────────────────────────────
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: a });
  ok(r.success && r.reused, '2 same file is reused');
  eq(r.fileName, 'Offense Report.synthetic.pdf', '2 same name');
  eq(fs.readdirSync(rmsDir).length, 1, '2 no second copy');

  // ── 3. different file, same name → " (1)", never overwritten ─────────
  const b = path.join(T, 'other'); fs.mkdirSync(b);
  const b1 = path.join(b, 'Offense Report.synthetic.pdf'); fs.writeFileSync(b1, '%PDF-1.4 synthetic offense report B');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: b1 });
  ok(r.success && !r.reused, '3 different content is stored');
  eq(r.fileName, 'Offense Report.synthetic (1).pdf', '3 suffixed name');
  ok(fs.readFileSync(path.join(rmsDir, 'Offense Report.synthetic.pdf')).equals(fs.readFileSync(a)), '3 first copy untouched');
  // and B again finds its (1) copy
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: b1 });
  ok(r.reused && r.fileName === 'Offense Report.synthetic (1).pdf', '3 B again reuses (1)');

  // ── 4. picking the stored copy itself ────────────────────────────────
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: path.join(rmsDir, 'Offense Report.synthetic.pdf') });
  ok(r.success && r.reused, '4 the stored copy itself is reused');
  eq(fs.readdirSync(rmsDir).length, 2, '4 still two files');

  // ── 5. guards ─────────────────────────────────────────────────────────
  r = await store.keep({ caseNumber: '../x', kind: 'rmsReports', sourcePath: a });
  eq(r.code, 'CASE', '5 traversal case number refused');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'evidence', sourcePath: a });
  eq(r.code, 'KIND', '5 unknown kind refused');
  r = await store.keep({ caseNumber: 'CASE-001', kind: '__proto__', sourcePath: a });
  eq(r.code, 'KIND', '5 prototype key refused');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: path.join(srcDir, 'gone.pdf') });
  eq(r.code, 'NOT_FOUND', '5 missing source');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: 'relative.pdf' });
  eq(r.code, 'SOURCE', '5 relative path refused');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: srcDir });
  eq(r.code, 'SOURCE', '5 folder refused');
  r = await store.keep(null);
  eq(r.success, false, '5 null payload → result, no throw');

  // ── 6. Field Security ────────────────────────────────────────────────
  sec.enabled = true; sec.unlocked = false;
  const c = src('Supplement.synthetic.pdf', '%PDF-1.4 synthetic supplement C');
  r = await store.keep({ caseNumber: 'CASE-002', kind: 'rmsReports', sourcePath: c });
  eq(r.code, 'LOCKED', '6 locked vault refuses');
  ok(!fs.existsSync(path.join(casesDir, 'CASE-002', 'RMS_Reports', 'Supplement.synthetic.pdf')), '6 nothing written while locked');
  sec.unlocked = true;
  r = await store.keep({ caseNumber: 'CASE-002', kind: 'rmsReports', sourcePath: c });
  ok(r.success && r.encrypted, '6 unlocked → encrypted copy');
  const stored = fs.readFileSync(path.join(casesDir, 'CASE-002', 'RMS_Reports', r.fileName));
  eq(stored.slice(0, 6).toString(), 'VIPENC', '6 sealed on disk');
  ok(sec.decryptBuffer(stored).equals(fs.readFileSync(c)), '6 decrypts to the source');
  eq(r.sha256, sha(fs.readFileSync(c)), '6 hash is of the plain bytes');
  r = await store.keep({ caseNumber: 'CASE-002', kind: 'rmsReports', sourcePath: c });
  ok(r.success && r.reused && r.encrypted, '6 same file again reuses the sealed copy');
  const big = src('Big.synthetic.pdf', Buffer.alloc(1001, 65));
  r = await store.keep({ caseNumber: 'CASE-002', kind: 'rmsReports', sourcePath: big });
  eq(r.code, 'TOO_LARGE', '6 over the encryption ceiling refused');
  sec.enabled = false;

  // ── 7. no temp files left behind ─────────────────────────────────────
  const left = fs.readdirSync(rmsDir).concat(fs.readdirSync(path.join(casesDir, 'CASE-002', 'RMS_Reports')));
  ok(!left.some(n => /\.partial$/.test(n)), '7 no .partial files left');

  // ── 8. awkward names ─────────────────────────────────────────────────
  const d = src('Report.synthetic.pdf', '%PDF synthetic D');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: d, fileName: 'a:b?.pdf' });
  eq(r.fileName, 'a_b_.pdf', '8 reserved characters replaced');
  r = await store.keep({ caseNumber: 'CASE-001', kind: 'rmsReports', sourcePath: d, fileName: '..' });
  eq(r.code, 'NAME', '8 ".." name refused');

  // ── 9. folderFor ──────────────────────────────────────────────────────
  eq(store.folderFor('CASE-001', 'rmsReports').dir, path.resolve(rmsDir), '9 folderFor');

  // ── 10. wiring (source contracts) ────────────────────────────────────
  const root = path.join(__dirname, '..', '..', '..');
  const MAIN = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
  const PRE = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const CD = fs.readFileSync(path.join(root, 'case-detail-with-analytics.html'), 'utf8');
  const IDX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ok(/ipcMain\.handle\('case-source-keep'/.test(MAIN), '10 main registers case-source-keep');
  ok(/rmsReports:\s*'RMS_Reports'/.test(MAIN), '10 RMS_Reports is an allow-listed attachment folder (readable back)');
  ok(/dirs:\s*CASE_ATTACHMENT_DIRS/.test(MAIN), '10 store shares the attachment allow-list');
  ok(/caseSourceKeep:\s*\(data\)\s*=>\s*ipcRenderer\.invoke\('case-source-keep'/.test(PRE), '10 preload exposes caseSourceKeep');
  const hi = CD.indexOf('async function handleRmsImport()');
  const hBody = CD.slice(hi, CD.indexOf('async function deleteRmsImport', hi));
  ok(/await _rmsKeepSource\(filePath\)/.test(hBody), '10 open-case import keeps the PDF');
  ok(/report\.sourceFile = /.test(hBody), '10 every document gets sourceFile');
  const pi = CD.indexOf('function processPendingRmsImport()');
  const pBody = CD.slice(pi, pi + 6000);
  ok(/sourcePath \} = JSON\.parse\(raw\)/.test(pBody) && /_rmsKeepSourceLater\(sourcePath, srcToken\)/.test(pBody), '10 create-case import keeps the PDF');
  ok(/sourcePath: chosenPath/.test(IDX) && /sourcePath: pendingRmsData\.sourcePath/.test(IDX), '10 index.html hands the path over');
  ok(/openRmsSourcePdf\(\$\{index\}\)/.test(CD) && /attachRmsSourcePdf\(\$\{index\}\)/.test(CD), '10 detail view offers view / attach');
  const di = CD.indexOf('async function deleteRmsImport');
  ok(!/caseAttachmentDelete/.test(CD.slice(di, di + 600)), '10 removing an import never deletes the PDF');

  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log(`case-source-store: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
