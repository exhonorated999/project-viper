/**
 * Tests for modules/_shared/safe-storage-io.js
 * Run: node modules/_shared/__tests__/safe-storage-io.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFileSync, looksCloudSynced, probeLocalStorage } =
  require('../safe-storage-io');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-ssio-'));

// ── atomicWriteFileSync ─────────────────────────────────────────────
(function atomicWrites() {
  const f = path.join(tmpRoot, 'storage.json');

  atomicWriteFileSync(f, JSON.stringify({ casesPath: 'D:\\Cases' }));
  eq(JSON.parse(fs.readFileSync(f, 'utf8')).casesPath, 'D:\\Cases', 'writes new file');

  // Overwrite must fully replace, never leave trailing bytes from the
  // longer previous content (the classic truncation bug).
  atomicWriteFileSync(f, JSON.stringify({ a: 1 }));
  const raw = fs.readFileSync(f, 'utf8');
  eq(raw, '{"a":1}', 'overwrite replaces entire file');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) {}
  ok(parsed && parsed.a === 1, 'overwritten file is still valid JSON');

  // No temp files may survive a successful write.
  const leftovers = fs.readdirSync(tmpRoot).filter(n => n.indexOf('.tmp') !== -1);
  eq(leftovers.length, 0, 'no temp files left behind');

  // Repeated writes stay parseable (simulates rapid setting changes).
  for (let i = 0; i < 50; i++) atomicWriteFileSync(f, JSON.stringify({ n: i }));
  eq(JSON.parse(fs.readFileSync(f, 'utf8')).n, 49, '50 sequential writes end consistent');
  eq(fs.readdirSync(tmpRoot).filter(n => n.indexOf('.tmp') !== -1).length, 0,
     'no temp leakage after many writes');

  // Failure path: unwritable target dir must throw AND not leave a temp.
  let threw = false;
  try {
    atomicWriteFileSync(path.join(tmpRoot, 'nope', 'deep', 'x.json'), 'x');
  } catch (_) { threw = true; }
  ok(threw, 'throws when target directory does not exist');
  eq(fs.readdirSync(tmpRoot).filter(n => n.indexOf('.tmp') !== -1).length, 0,
     'no temp left after a failed write');
})();

// ── looksCloudSynced ────────────────────────────────────────────────
(function cloudDetection() {
  const env = {};
  eq(looksCloudSynced('C:\\Users\\josh\\OneDrive\\VIPER', env), 'OneDrive', 'OneDrive path');
  eq(looksCloudSynced('C:\\Users\\josh\\OneDrive - Westminster PD\\VIPER', env),
     'OneDrive', 'OneDrive for Business path');
  eq(looksCloudSynced('C:/Users/josh/OneDrive/VIPER', env), 'OneDrive', 'forward slashes');
  eq(looksCloudSynced('C:\\Users\\josh\\ONEDRIVE\\viper', env), 'OneDrive', 'case insensitive');
  eq(looksCloudSynced('C:\\Users\\josh\\Dropbox\\VIPER', env), 'Dropbox', 'Dropbox');
  eq(looksCloudSynced('C:\\Users\\josh\\Google Drive\\v', env), 'Google Drive', 'Google Drive');
  eq(looksCloudSynced('C:\\Users\\josh\\Box Sync\\v', env), 'Box', 'Box');
  eq(looksCloudSynced('D:\\SharePoint\\Evidence', env), 'SharePoint', 'SharePoint');

  // Must NOT false-positive on ordinary local paths.
  eq(looksCloudSynced('C:\\Users\\josh\\AppData\\Roaming\\V.I.P.E.R.', env), null, 'default appdata is local');
  eq(looksCloudSynced('D:\\VIPER Cases', env), null, 'plain external drive');
  eq(looksCloudSynced('C:\\Program Files\\VIPER', env), null, 'program files');
  eq(looksCloudSynced('', env), null, 'empty string');
  eq(looksCloudSynced(null, env), null, 'null');
  eq(looksCloudSynced(undefined, env), null, 'undefined');
  eq(looksCloudSynced(12345, env), null, 'non-string');

  // Environment-declared root.
  eq(looksCloudSynced('C:\\Sync\\Cloudy\\VIPER', { OneDrive: 'C:\\Sync\\Cloudy' }),
     'OneDrive', 'matches OneDrive env root');
  eq(looksCloudSynced('C:\\Elsewhere\\VIPER', { OneDrive: 'C:\\Sync\\Cloudy' }),
     null, 'env root that does not match');
  eq(looksCloudSynced('C:\\x\\VIPER', { OneDrive: '   ' }), null, 'blank env root ignored');
})();

// ── probeLocalStorage ───────────────────────────────────────────────
(function probe() {
  const ud = path.join(tmpRoot, 'userdata');
  fs.mkdirSync(ud, { recursive: true });

  let r = probeLocalStorage(ud, fs);
  eq(r.present, false, 'no Local Storage dir -> absent');
  eq(r.files, 0, 'no files counted');

  const ldb = path.join(ud, 'Local Storage', 'leveldb');
  fs.mkdirSync(ldb, { recursive: true });
  r = probeLocalStorage(ud, fs);
  eq(r.present, false, 'empty leveldb dir -> absent (this is the OneDrive case)');

  // A dehydrated / partially-synced dir: files exist but no CURRENT manifest.
  fs.writeFileSync(path.join(ldb, '000003.log'), 'x');
  r = probeLocalStorage(ud, fs);
  eq(r.present, false, 'files without CURRENT manifest -> not a usable DB');
  eq(r.files, 1, 'counts the files it did see');

  fs.writeFileSync(path.join(ldb, 'CURRENT'), 'MANIFEST-000001\n');
  r = probeLocalStorage(ud, fs);
  eq(r.present, true, 'CURRENT manifest present -> real database');
  eq(r.files, 2, 'file count reflects directory');

  r = probeLocalStorage(path.join(tmpRoot, 'does-not-exist'), fs);
  eq(r.present, false, 'missing userData dir handled');

  // Must never throw, even on garbage input.
  let threw = false;
  try { probeLocalStorage('', fs); } catch (_) { threw = true; }
  ok(!threw, 'empty path does not throw');
})();

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nsafe-storage-io: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
