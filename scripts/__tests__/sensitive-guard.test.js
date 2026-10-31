/*
 * Tests for scripts/sensitive-guard.js — run: node scripts/__tests__/sensitive-guard.test.js
 * All data below is synthetic.
 */
'use strict';
const G = require('../sensitive-guard');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL  ' + name); } }
const B = (s) => Buffer.from(s, 'utf8');
const rules = (path, text, opts) => G.checkEntry({ path, size: text ? Buffer.byteLength(text) : 0, data: text == null ? null : B(text) }, opts || {}).map((v) => v.rule);
const has = (path, text, rule, opts) => rules(path, text, opts).indexOf(rule) >= 0;
const clean = (path, text, opts) => rules(path, text, opts).length === 0;

// ── 1. Folders that held real case data ──────────────────────────────────
ok(has('sample-data/report.txt', 'x', 'dir'), 'sample-data/ blocked');
ok(has('sample-data/meta-sample/records.html', 'x', 'dir'), 'nested sample-data blocked');
ok(has('cases/26-123456/aperture/emails.json', '{}', 'dir'), 'cases/ blocked');
ok(has('modules/warrant-author/_sample_body/word/document.xml', '<w/>', 'dir'), '_sample_body blocked');
ok(has('Sample-Data/x.js', 'x', 'dir'), 'folder match is case-insensitive');
ok(clean('modules/assist-cases/ac.js', 'var a = 1;'), 'assist-cases is not cases/');
ok(clean('modules/case-status-report/csr-build.js', 'var a = 1;'), 'case-status-report is fine');

// ── 2. Evidence / mail / media / binaries ────────────────────────────────
['x.mbox', 'a/b.eml', 'x.pst', 'dump.ufdr', 'offender.oversight', 'x.e01', 'chat.db', 'clip.mp4', 'v.wav',
 'IMG_0001.heic', 'loc.kml', 'contacts.vcf', 'pack.zip', 'VIPER-setup.exe', 'app.asar', 'model.gguf'].forEach((p) =>
  ok(has(p, null, 'ext'), p + ' blocked'));
ok(clean('test-sample.mbox', 'From: a@example.com'), 'reviewed synthetic mbox allowed (ALLOW list)');

// ── 3. Documents and images only in asset folders ────────────────────────
ok(has('Incident-2024-000181.pdf', null, 'doc'), 'root PDF blocked');
ok(has('modules/rms/report.pdf', null, 'doc'), 'module PDF blocked');
ok(has('modules/x/photo.jpg', null, 'doc'), 'loose JPG blocked');
ok(has('exports/calls.csv', 'a,b', 'doc'), 'loose CSV blocked');
ok(clean('assets/icon.png', null), 'assets/ PNG ok');
ok(clean('libs/images/marker-icon.png', null), 'libs/ PNG ok');
ok(clean('modules/warrant-author/templates/va/DC-338-blank.pdf', null), 'blank form template ok');
ok(clean('modules/viper-sense/assets/scale-pulse-idle-64.png', null), 'module assets ok');
ok(clean('compliance/VIPER_NIST_CSF_Policy_Guide.pdf', null), 'compliance docs ok');

// ── 4. Test data must be synthetic ───────────────────────────────────────
ok(has('modules/rms/__tests__/fixtures/report.txt', 'INCIDENT 26-1', 'fixture'), 'unmarked fixture blocked');
ok(clean('modules/rms/fixtures/aj-incident.synthetic.txt', 'INCIDENT 26-1'), '*.synthetic.* ok');
ok(clean('modules/rms/__tests__/fixtures/ar.ocr.txt', '# REDACTED fixture — values swapped\nINCIDENT'), 'REDACTED header ok');
ok(clean('test/foo.json', '{"note":"SYNTHETIC data"}'), 'SYNTHETIC marker in JSON ok');
ok(has('test/foo.json', '{"name":"x"}', 'fixture'), 'unmarked test JSON blocked');
ok(clean('test/sample-trace-export.json', '{"case":{}}'), 'reviewed synthetic TRACE export allowed');
ok(clean('modules/rms/__tests__/rms.test.js', 'const s = "123 Main";'), 'test code itself is not a data file');

// ── 5. Secrets ───────────────────────────────────────────────────────────
ok(has('cfg.js', 'const t = "ghp_' + 'a'.repeat(36) + '";', 'secret'), 'GitHub token');
ok(has('cfg.js', 'k = "AKIA' + 'ABCDEFGHIJKLMNOP' + '"', 'secret'), 'AWS key');
ok(has('k.txt', '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMII', 'secret'), 'private key');
ok(has('cfg.js', 'x = "hf_' + 'b'.repeat(34) + '"', 'secret'), 'Hugging Face token');
ok(clean('cfg.js', 'const label = "github token goes in the keyring";'), 'prose about tokens ok');

// ── 6. Raw mail in data files (not in parser code) ───────────────────────
ok(has('notes/export.txt', 'X-Gmail-Labels: Inbox\nFrom: a@b.c', 'mail'), 'Gmail takeout header in data file');
ok(has('notes/raw.txt', 'From someone@example.org Mon Jan  1 00:00:00 2024\n', 'mail'), 'mbox separator in data file');
ok(clean('modules/google-warrant/gw-parser.js', 'if (/^X-Gmail-Labels: /m.test(t)) {}'), 'parser code naming the header ok');

// ── 7. Size ──────────────────────────────────────────────────────────────
ok(G.checkEntry({ path: 'big.js', size: G.MAX_BYTES + 1, data: null }).some((v) => v.rule === 'size'), 'oversize blocked');
ok(!G.checkEntry({ path: 'case-detail-with-analytics.html', size: G.MAX_BYTES + 1, data: null }).length, 'known large file ok');
ok(!G.checkEntry({ path: 'big.js', size: G.MAX_BYTES + 1, data: null }, { skipSize: true }).length, 'size skipped when asked (asar)');

// ── 8. Local sensitive terms ─────────────────────────────────────────────
const terms = ['pat example-officer', 'officer@example.gov', '(555) 010-0199'];
ok(has('modules/x/profile.js', "placeholder: 'Pat Example-Officer'", 'term', { terms }), 'term matched case-insensitively');
ok(has('modules/x/f.js', 'mail: officer@example.gov', 'term', { terms }), 'email term');
ok(has('notes/Pat Example-Officer.txt', 'x', 'term', { terms }), 'term in a path');
ok(clean('modules/x/f.js', 'nothing here', { terms }), 'no term, clean');
ok(G.checkEntry({ path: 'a.js', size: 30, data: B('officer@example.gov officer@example.gov') }, { terms }).length === 1, 'one hit per file');

// ── 9. Packaged-app rules ────────────────────────────────────────────────
const P = { packaged: true, skipSize: true };
ok(has('modules/cargonet/test_fixtures/_parser_test.js', 'x', 'pkg', P), 'test_fixtures not shipped');
ok(has('modules/rms/__tests__/rms.test.js', 'x', 'pkg', P), '__tests__ not shipped');
ok(has('.workshop/context.md', 'x', 'pkg', P), '.workshop not shipped');
ok(has('regress.log', 'x', 'pkg', P), 'logs not shipped');
ok(has('_parse_pdfs.py', 'x', 'pkg', P), 'scratch python not shipped');
ok(has('_extract_pdfs.js', 'x', 'pkg', P), 'root scratch js not shipped');
ok(clean('modules/rms/rms-shapes.js', 'var a;', P), 'module code ships');
ok(clean('modules/_shared/feature-flags.js', 'var a;', P), 'underscore folder is not a scratch file');
ok(clean('modules/rms/__tests__/rms.test.js', 'x'), 'test files are fine in git');

// ── 10. Binary content is not text-scanned ───────────────────────────────
const bin = Buffer.concat([Buffer.from([0, 1, 2, 0]), B('ghp_' + 'a'.repeat(36))]);
ok(!G.checkEntry({ path: 'assets/icon.png', size: bin.length, data: bin }).length, 'binary asset not text-scanned');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
