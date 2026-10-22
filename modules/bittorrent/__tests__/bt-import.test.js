/**
 * BitTorrent (TD) tab — Phase 2 tests: bt-main.js IPC (scan / import with
 * copy + Field Security / read / delete / cancel), bittorrent-module.js in
 * a renderer sandbox, and the case-stores registration.
 * Run: node modules/bittorrent/__tests__/bt-import.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const B = require('../bt-main');
const P = require('../td-log-parser');
const FX = require('../test_fixtures/td-fixtures');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) { if (cond) pass++; else { fail++; failures.push(name); } }
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; failures.push(`${name}: got ${g} want ${w}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-bt-imp-'));
const clean = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

// Fake Field Security: VIPENC-style header + AES-GCM, same surface as modules/security.js
function fakeSecurity(enabled) {
  const key = crypto.randomBytes(32);
  const MAGIC = Buffer.from('VIPENC');
  let unlocked = true;
  return {
    isEnabled: () => enabled,
    isUnlocked: () => unlocked,
    lock() { unlocked = false; }, unlock() { unlocked = true; },
    isEncryptedBuffer: (b) => Buffer.isBuffer(b) && b.length >= 6 && b.subarray(0, 6).equals(MAGIC),
    encryptBuffer(buf) {
      const iv = crypto.randomBytes(16);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(buf), c.final()]);
      return Buffer.concat([MAGIC, Buffer.from([1, 0]), iv, c.getAuthTag(), ct]);
    },
    decryptBuffer(b) {
      if (!this.isEncryptedBuffer(b)) return b;
      if (!unlocked) throw new Error('locked');
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(8, 24));
      d.setAuthTag(b.subarray(24, 40));
      return Buffer.concat([d.update(b.subarray(40)), d.final()]);
    }
  };
}

function fakeIpc() {
  const h = {};
  return { handle: (ch, fn) => { h[ch] = fn; }, h };
}
function fakeEvent(log) {
  return { sender: { isDestroyed: () => false, send: (ch, d) => log.push([ch, d]) } };
}

(async () => {
  // ── fixtures: an investigations folder outside the case, with media
  const inv = path.join(TMP, 'Investigations');
  const logs = FX.td147({});
  const srcCase = FX.writeCase(inv, 'A', logs, { split: 40, netstat: FX.netstat('203.0.113.45', true) });
  fs.mkdirSync(path.join(srcCase, 'Download', 'Synthetic Torrent'), { recursive: true });
  fs.writeFileSync(path.join(srcCase, 'Download', 'Synthetic Torrent', 'a.bin'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(srcCase, 'Download', 'Synthetic Torrent', 'b.bin'), Buffer.alloc(5000, 2));
  fs.writeFileSync(path.join(srcCase, 'suspectviewer.epx'), '<x/>');
  const plainModel = await P.parseTdDownload(srcCase);

  // ── safe ids / segments
  ok(B.safeId(plainModel.id) === plainModel.id, 'safeId accepts parser id');
  ok(B.safeId('..') === null && B.safeId('a/b') === null && B.safeId('') === null, 'safeId rejects traversal/empty');
  ok(B.safeSegment('..') === null && B.safeSegment('a\\b') === null, 'safeSegment rejects traversal');

  // ── copyDownload (no vault)
  const ev1 = path.join(TMP, 'ev1');
  const progress = [];
  const c1 = await B.copyDownload(P.discoverLogs(srcCase), ev1, { onProgress: (p) => progress.push(p) });
  eq(path.relative(ev1, c1.dest), path.join('US.CA.Testville_203.0.113.45', '20260302_211510_7'), 'copy: <IP folder>/<download folder>');
  ok(fs.existsSync(path.join(c1.dest, 'Download', 'Synthetic Torrent', 'b.bin')), 'copy: media copied');
  ok(fs.existsSync(path.join(c1.dest, 'suspectviewer.epx')), 'copy: other case-folder files copied');
  eq(c1.logFiles.map(f => f.name).sort(), ['details.txt', 'details_001.txt', 'netstat.txt', 'summary.txt', 'torrentinfo.txt'], 'copy: logFiles = Logs folder only');
  eq(c1.mediaFiles, 2, 'copy: mediaFiles = files under Download only (viewer files are not media)');
  ok(c1.logFiles.every(f => f.path.startsWith(c1.dest)), 'copy: logFiles point at the copy');
  ok(progress.length > 0 && progress[progress.length - 1].filesDone === c1.files, 'copy: progress reaches all files');
  eq(fs.readFileSync(path.join(c1.dest, 'Logs', 'details.txt'), 'utf8'), fs.readFileSync(path.join(srcCase, 'Logs', 'details.txt'), 'utf8'), 'copy: bytes identical');
  const c1b = await B.copyDownload(P.discoverLogs(srcCase), ev1, {});
  ok(c1b.dest === c1.dest + ' (2)', 'copy: second copy gets a fresh folder, never overwrites');

  // loose Logs folder (no case folder around it)
  const loose = path.join(TMP, 'loose', 'Logs');
  fs.mkdirSync(loose, { recursive: true });
  fs.copyFileSync(path.join(srcCase, 'Logs', 'summary.txt'), path.join(loose, 'summary.txt'));
  const c2 = await B.copyDownload(P.discoverLogs(loose), path.join(TMP, 'ev2'), {});
  ok(fs.existsSync(path.join(c2.dest, 'Logs', 'summary.txt')), 'copy: loose Logs → <dest>/Logs');
  ok(c2.dest.indexOf('Unknown IP') >= 0, 'copy: no IP folder → "Unknown IP"');
  eq(c2.logFiles.length, 1, 'copy: loose logFiles');

  // ── companion folder: details.txt at the root, the rest in ONE subfolder (how agencies hand logs over)
  const comp = path.join(TMP, 'handover');
  const compSub = path.join(comp, 'OneDrive_1_01-01-2026');
  fs.mkdirSync(compSub, { recursive: true });
  fs.copyFileSync(path.join(srcCase, 'Logs', 'details.txt'), path.join(comp, 'details.txt'));
  ['details_001.txt', 'summary.txt', 'torrentinfo.txt', 'netstat.txt'].forEach(n => fs.copyFileSync(path.join(srcCase, 'Logs', n), path.join(compSub, n)));
  fs.writeFileSync(path.join(comp, 'Manual.pdf'), 'x');
  const fc = P.discoverLogs(comp);
  ok(fc && fc.files.summary.length === 1 && fc.files.torrentinfo && fc.files.netstat, 'companion: summary/torrentinfo/netstat merged from the one subfolder');
  eq(fc.files.details.length, 2, 'companion: details roll from the subfolder joins the root roll');
  ok(fc.files.companionDir && path.resolve(fc.files.companionDir) === path.resolve(compSub), 'companion: companionDir recorded');
  const mc = await P.parseTdDownload(comp);
  eq([mc.torrent.infoHash, mc.closing.outcome, mc.sessions.length], [plainModel.torrent.infoHash, plainModel.closing.outcome, plainModel.sessions.length], 'companion: parses the same as the original folder');
  const cc = await B.copyDownload(fc, path.join(TMP, 'evc'), {});
  eq(cc.logFiles.map(f => f.name).sort(), ['details.txt', 'details_001.txt', 'netstat.txt', 'summary.txt', 'torrentinfo.txt'], 'companion: Evidence lists the subfolder logs too');
  eq(cc.mediaFiles, 0, 'companion: manuals are not counted as media');
  fs.mkdirSync(path.join(comp, 'Second'));
  fs.copyFileSync(path.join(srcCase, 'Logs', 'summary.txt'), path.join(comp, 'Second', 'summary.txt'));
  const fc2 = P.discoverLogs(comp);
  ok(fc2 && fc2.files.summary.length === 0 && !fc2.files.torrentinfo, 'companion: two candidate subfolders → nothing merged (ambiguous)');

  // ── handshake time kept per session
  const hsS = plainModel.sessions.filter(s => s.handshake);
  ok(hsS.length > 0 && hsS.every(s => s.handshakeAt), 'parser: every handshaked session has handshakeAt');
  ok(hsS.every(s => !s.attemptAt || s.handshakeAt >= s.attemptAt), 'parser: handshakeAt not before the attempt');

  // ── copy with Field Security on → every file encrypted, parse still works
  const sec = fakeSecurity(true);
  const c3 = await B.copyDownload(P.discoverLogs(srcCase), path.join(TMP, 'ev3'), { security: sec });
  ok(B.isEncryptedFile(path.join(c3.dest, 'Logs', 'details.txt'), sec), 'vault: log copy encrypted');
  ok(B.isEncryptedFile(path.join(c3.dest, 'Download', 'Synthetic Torrent', 'a.bin'), sec), 'vault: media copy encrypted');
  const encModel = await P.parseTdDownload(c3.dest, B.vaultIo(sec));
  eq(encModel.summary, plainModel.summary, 'vault: encrypted copy parses to the same summary');
  eq(encModel.files.length, plainModel.files.length, 'vault: same files');
  eq(encModel.netstat.length, plainModel.netstat.length, 'vault: netstat read through vault');
  sec.lock();
  let lockedErr = null;
  try { await P.parseTdDownload(c3.dest, B.vaultIo(sec)); } catch (e) { lockedErr = e; }
  ok(lockedErr && lockedErr.code === 'VAULT_LOCKED', 'vault: locked → VAULT_LOCKED');
  sec.unlock();

  // too large to encrypt
  let bigErr = null;
  try { await B.copyDownload(P.discoverLogs(srcCase), path.join(TMP, 'ev4'), { security: sec, encryptMaxBytes: 4000 }); } catch (e) { bigErr = e; }
  ok(bigErr && bigErr.code === 'TOO_LARGE_TO_ENCRYPT', 'vault: oversize file refused before copying');
  ok(!fs.existsSync(path.join(TMP, 'ev4')), 'vault: nothing written when refused');

  // cancel during copy
  let cancelErr = null, n = 0;
  try { await B.copyDownload(P.discoverLogs(srcCase), path.join(TMP, 'ev5'), { isCancelled: () => ++n > 2 }); } catch (e) { cancelErr = e; }
  ok(cancelErr && cancelErr.cancelled, 'copy: cancel rejects with cancelled');

  // ── IPC end-to-end
  const casesDir = path.join(TMP, 'cases');
  fs.mkdirSync(path.join(casesDir, 'C-100', 'Evidence'), { recursive: true });
  let security = null;
  const ipc = fakeIpc();
  const dlg = { showOpenDialog: async () => ({ canceled: false, filePaths: [inv] }) };
  B.register({ ipcMain: ipc, dialog: dlg, getMainWindow: () => null, getCasesDir: () => casesDir, getSecurity: () => security,
    restoreFocus: () => {}, sourceFingerprint: async (spec) => ({ algorithm: 'SHA-256', name: path.basename(spec.path) }) });
  eq(['bt-pick-source', 'bt-scan', 'bt-import', 'bt-cancel', 'bt-read', 'bt-delete'].filter(c => typeof ipc.h[c] !== 'function'), [], 'ipc: all channels registered');

  const picked = await ipc.h['bt-pick-source']();
  eq(picked.downloads.length, 1, 'pick: finds the TD download under the investigations folder');
  const d0 = picked.downloads[0];
  eq([d0.ip, d0.ipFolder, d0.caseFolder, d0.hasDetails, d0.hasSummary, d0.inCase, d0.encrypted], ['203.0.113.45', 'US.CA.Testville_203.0.113.45', '20260302_211510_7', true, true, false, false], 'pick: describe fields');

  const plog = [];
  const r1 = await ipc.h['bt-import'](fakeEvent(plog), { jobId: 'j1', caseNumber: 'C-100', sourceDir: d0.caseDir, mode: 'copy' });
  ok(r1.success, 'import(copy): success ' + (r1.error || ''));
  eq(r1.meta.id, plainModel.id, 'import: meta id = parser id');
  eq(r1.meta.ip, '203.0.113.45', 'import: meta ip');
  eq(r1.meta.storage.mode, 'copy', 'import: storage mode copy');
  ok(r1.copied && r1.copied.dest.startsWith(path.join(casesDir, 'C-100', 'Evidence', 'BitTorrent')), 'import: copied under Evidence/BitTorrent');
  ok(plog.some(([ch, p]) => ch === 'bt-progress' && p.jobId === 'j1' && p.phase === 'logs'), 'import: logs progress sent');
  ok(plog.some(([, p]) => p.phase === 'copy') && plog.some(([, p]) => p.phase === 'save'), 'import: copy + save progress sent');
  ok(JSON.stringify(r1.meta).length < 4000, 'import: meta is small (localStorage-safe)');
  const jsonFile = path.join(casesDir, 'C-100', 'BitTorrent', r1.meta.id + '.json');
  ok(fs.existsSync(jsonFile), 'import: JSON written to cases/<n>/BitTorrent/<id>.json');
  ok(!fs.existsSync(jsonFile + '.tmp'), 'import: no temp file left');

  const rd = await ipc.h['bt-read']({}, { caseNumber: 'C-100', downloadId: r1.meta.id });
  ok(rd.success && rd.model.summary.piecesDownloaded === plainModel.summary.piecesDownloaded, 'read: model round-trips');
  ok(rd.model.storage.caseDir === r1.copied.dest && rd.model.storage.sourceCaseDir === d0.caseDir, 'read: storage points at copy, remembers source');
  eq(rd.model.import.sourceIntegrity, { algorithm: 'SHA-256', name: 'Logs' }, 'read: source fingerprint of the Logs folder recorded');

  const sc = await ipc.h['bt-scan']({}, { caseNumber: 'C-100', extraPaths: [inv, path.join(TMP, 'gone')] });
  ok(sc.success, 'scan: success');
  const inCase = sc.downloads.filter(x => x.inCase), linked = sc.downloads.filter(x => x.source === 'evidence-link');
  eq([inCase.length, linked.length], [1, 1], 'scan: copy found in case + linked original found; missing path skipped');

  // in-place import of the copy → same id, mode 'case', no second copy
  const r2 = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j2', caseNumber: 'C-100', sourceDir: inCase[0].caseDir, mode: 'inplace' });
  ok(r2.success && r2.meta.id === r1.meta.id && r2.meta.storage.mode === 'case' && !r2.copied, 'import(inplace) of case copy: same id, mode case, no copy');
  const r3 = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j3', caseNumber: 'C-100', sourceDir: d0.caseDir, mode: 'inplace' });
  ok(r3.success && r3.meta.storage.mode === 'reference', 'import(inplace) outside case: mode reference');

  // guards
  const bad1 = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j4', caseNumber: '..', sourceDir: d0.caseDir, mode: 'copy' });
  ok(!bad1.success && bad1.code === 'BAD_CASE', 'guard: caseNumber ".." refused');
  const bad2 = await ipc.h['bt-read']({}, { caseNumber: 'C-100', downloadId: '..\\..\\secret' });
  ok(!bad2.success && bad2.code === 'BAD_ID', 'guard: traversal download id refused');
  const notTd = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j5', caseNumber: 'C-100', sourceDir: path.join(TMP, 'ev2', 'nothing'), mode: 'copy' });
  ok(!notTd.success && notTd.code === 'NOT_TD', 'guard: non-TD folder → NOT_TD');
  const miss = await ipc.h['bt-read']({}, { caseNumber: 'C-100', downloadId: 'td_nothing_here' });
  ok(!miss.success && miss.code === 'MISSING', 'read: missing JSON → MISSING');

  // cancel: flag set before parse loop ticks → cancelled result, no JSON
  const big = FX.td147({ sessions: Array(1200).fill('reset') });
  const bigCase = FX.writeCase(path.join(TMP, 'BigInv'), 'Big', big, { stamp: '20260303_101010_9' });
  const pending = ipc.h['bt-import'](fakeEvent([]), { jobId: 'jc', caseNumber: 'C-100', sourceDir: bigCase, mode: 'copy' });
  await ipc.h['bt-cancel']({}, { jobId: 'jc' });
  const rc = await pending;
  ok(!rc.success && rc.cancelled, 'cancel: import returns cancelled');
  ok(!fs.existsSync(path.join(casesDir, 'C-100', 'Evidence', 'BitTorrent', 'US.CA.Testville_203.0.113.45', '20260303_101010_9')), 'cancel: nothing copied');

  // Field Security on → JSON encrypted at rest, still readable
  security = fakeSecurity(true);
  const r4 = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j6', caseNumber: 'C-100', sourceDir: d0.caseDir, mode: 'inplace' });
  ok(r4.success, 'vault import: success');
  ok(security.isEncryptedBuffer(fs.readFileSync(jsonFile)), 'vault import: JSON encrypted at rest');
  ok(!fs.readFileSync(jsonFile).includes(Buffer.from('203.0.113.45')), 'vault import: no plaintext IP in JSON file');
  const rd2 = await ipc.h['bt-read']({}, { caseNumber: 'C-100', downloadId: r4.meta.id });
  ok(rd2.success && rd2.model.remote.ip === '203.0.113.45', 'vault read: decrypts');

  const del = await ipc.h['bt-delete']({}, { caseNumber: 'C-100', downloadId: r1.meta.id });
  ok(del.success && !fs.existsSync(jsonFile), 'delete: JSON removed');
  ok(fs.existsSync(path.join(r1.copied.dest, 'Logs', 'details.txt')), 'delete: Evidence copy untouched');

  // ── renderer module in a sandbox
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  security = null;
  const calls = [];
  let progressCb = null;
  const api = {
    btScan: (d) => ipc.h['bt-scan']({}, d),
    btImport: async (d) => { calls.push(['import', d.mode]); if (progressCb) progressCb({ jobId: d.jobId, phase: 'logs', bytesDone: 1, bytesTotal: 2 }); return ipc.h['bt-import'](fakeEvent([]), d); },
    btRead: (d) => ipc.h['bt-read']({}, d),
    btDelete: (d) => ipc.h['bt-delete']({}, d),
    btCancel: (d) => ipc.h['bt-cancel']({}, d),
    btPickSource: () => ipc.h['bt-pick-source'](),
    onBtProgress: (cb) => { progressCb = cb; return () => { progressCb = null; }; }
  };
  let refreshed = 0;
  const sb = { module: { exports: {} }, localStorage: ls, console, JSON, Date, Math, Promise, Array, Object, String, Number, Set, Error };
  sb.window = sb;
  sb.electronAPI = api;
  sb.refreshCaseEvidenceFromStorage = () => { refreshed++; };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'bittorrent-module.js'), 'utf8'), sb);
  ok(typeof sb.BitTorrentModule === 'function' && typeof sb.module.exports === 'function', 'renderer: window.BitTorrentModule + module.exports');

  fs.mkdirSync(path.join(casesDir, 'C-200', 'Evidence'), { recursive: true });
  store.viperCaseEvidence = JSON.stringify({ 'C-200': [{ id: 1, tag: 'E1', storageMode: 'copy', files: [] }] });
  const mod = new sb.BitTorrentModule('77', 'C-200', 'Test');
  await mod.init('nope');
  eq(mod.imports.length, 0, 'renderer: empty to start');
  const pk = await mod.pickSource();
  eq(pk.downloads.length, 1, 'renderer: pickSource lists download');
  const seen = [];
  const res = await mod.importDownload(pk.downloads[0], { mode: 'copy', onProgress: (p) => seen.push(p.phase) });
  ok(res.meta && !res.replaced, 'renderer: import added');
  eq(seen, ['logs'], 'renderer: progress forwarded for own job only');
  ok(mod.job === null && progressCb === null, 'renderer: job cleared and progress listener removed');
  const saved = JSON.parse(store.bittorrent_77);
  eq(saved.imports.length, 1, 'renderer: saved under bittorrent_<caseId>');
  const evs = JSON.parse(store.viperCaseEvidence)['C-200'];
  eq(evs.length, 2, 'renderer: Evidence item auto-created');
  const ev = evs[1];
  eq([ev.tag, ev.storageMode, ev.metadata.kind, ev.metadata.downloadId], ['BitTorrent', 'copy', 'bittorrent', res.meta.id], 'renderer: Evidence item fields');
  ok(ev.files.length === 5 && ev.files.every(f => /\.txt$/i.test(f.name)), 'renderer: Evidence item lists log files only (no media)');
  ok(ev.metadata.mediaFiles === 2, 'renderer: media count recorded, files not listed');
  eq(ev.type, 'bittorrent', 'renderer: Evidence item filed under the BitTorrent category');
  ok(refreshed === 1, 'renderer: Evidence tab refreshed');
  eq(saved.imports[0].evidenceId, ev.id, 'renderer: import remembers its Evidence item');

  await mod.scanEvidence();
  const cands = mod.evidenceCandidates();
  ok(cands.length === 1 && cands[0].alreadyImported, 'renderer: Find in Evidence sees the copy as already imported');
  ok(mod.findImportFor(pk.downloads[0]), 'renderer: original source maps to the import');

  const again = await mod.importDownload(cands[0], { mode: 'copy' });
  ok(again.replaced && mod.imports.length === 1, 'renderer: re-reading replaces, no duplicate record');
  eq(calls[calls.length - 1], ['import', 'inplace'], 'renderer: in-case download never copied again');
  eq(JSON.parse(store.viperCaseEvidence)['C-200'].length, 2, 'renderer: no second Evidence item on re-read');
  eq(mod.imports[0].evidenceId, ev.id, 'renderer: evidenceId kept on re-read');

  // ── ARIN + Send to Suspect
  let arinIp = null;
  api.arinLookup = async (ip) => { arinIp = ip; return { success: true, provider: 'Example ISP', org: 'EXAMPLE', network: 'EX-NET', netRange: '203.0.113.0 - 203.0.113.255', country: 'US' }; };
  const ar = await mod.lookupArin(mod.imports[0].id);
  ok(arinIp === '203.0.113.45' && ar.provider === 'Example ISP', 'arin: looks up the suspect IP');
  ok(JSON.parse(store.bittorrent_77).imports[0].arin.provider === 'Example ISP', 'arin: saved on the download record');
  api.arinLookup = async () => ({ success: false, error: 'boom' });
  let aerr = null; try { await mod.lookupArin(mod.imports[0].id); } catch (e) { aerr = e; }
  ok(aerr && /boom/.test(aerr.message) && mod.imports[0].arin.provider === 'Example ISP', 'arin: failure throws and keeps the last answer');
  const si = mod.sendItems(mod.imports[0].id);
  ok(si[0].key === 'ip' && si[0].value === '203.0.113.45' && si[0].provider === 'Example ISP', 'send: IP item carries the ARIN provider');
  ok(/Torrential Downpour/.test(si[0].meta) && /GMT[+-]\d\d:\d\d/.test(si[0].meta), 'send: note says where and when (with GMT offset)');
  eq(mod.sendItems('nope').length, 0, 'send: unknown id → nothing');
  await mod.importDownload(cands[0], { mode: 'copy' });
  ok(mod.imports[0].arin && mod.imports[0].arin.provider === 'Example ISP', 'arin: kept when the download is re-read');

  // ── items filed by the first build are re-filed under BitTorrent
  const evAll = JSON.parse(store.viperCaseEvidence); evAll['C-200'][1].type = 'digital'; store.viperCaseEvidence = JSON.stringify(evAll);
  const r0 = refreshed;
  eq(mod.upgradeEvidenceType(), 1, 'upgrade: old generic item re-filed');
  ok(JSON.parse(store.viperCaseEvidence)['C-200'][1].type === 'bittorrent' && refreshed === r0 + 1, 'upgrade: saved + Evidence tab refreshed');
  eq(mod.upgradeEvidenceType(), 0, 'upgrade: idempotent');
  ok(JSON.parse(store.viperCaseEvidence)['C-200'][0].type === undefined, 'upgrade: other Evidence untouched');

  const model = await mod.loadModel(res.meta.id);
  ok(model && model.id === res.meta.id, 'renderer: loadModel');
  await mod.removeImport(res.meta.id);
  eq(JSON.parse(store.bittorrent_77).imports.length, 0, 'renderer: removeImport');
  eq(JSON.parse(store.viperCaseEvidence)['C-200'].length, 2, 'renderer: remove keeps Evidence item');

  // failure path surfaces code
  let ferr = null;
  try { await mod.importDownload({ caseDir: path.join(TMP, 'nothing'), inCase: false }, { mode: 'copy' }); } catch (e) { ferr = e; }
  ok(ferr && ferr.code === 'NOT_TD' && mod.job === null, 'renderer: failed import throws with code, job cleared');

  // UI file loads in a sandbox too (no DOM needed to define the class)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'bittorrent-ui.js'), 'utf8'), sb);
  ok(typeof sb.BitTorrentUI === 'function', 'renderer: window.BitTorrentUI defined');

  // ── key events (handshake start / session end / download end)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'td-model.js'), 'utf8'), sb);
  const ui = Object.create(sb.BitTorrentUI.prototype);
  const ke = ui.keyEvents(plainModel);
  const kt = ke.map(e => e.text);
  ok(kt[0] === 'Download started', 'events: first is Download started');
  ok(kt.some(t => /^First handshake completed/.test(t)), 'events: first handshake');
  ok(kt.some(t => /^Handshake — session #\d+ starts/.test(t)), 'events: data-session handshake start');
  ok(kt.some(t => /^Session #\d+ ends — \d+ pieces? downloaded/.test(t)), 'events: data-session end with pieces');
  ok(kt.some(t => /^Download ended/.test(t)), 'events: download ended');
  ok(ke.every((e, i) => !i || ke[i - 1].at <= e.at), 'events: in time order');
  const ke2 = ui.keyEvents(Object.assign({}, plainModel, { closing: {} }));
  ok(ke2.some(e => e.text === 'Download ended'), 'events: end shown even without a logged reason');

  // ── suspect's client callout (software → platform / device / warrant hints)
  const TMs = sb.TdModel;
  const qb = TMs.clientProfile(TMs.decodeClient('-qB5240-').code);
  ok(qb && ['windows', 'macos', 'linux'].every(k => qb.platforms.includes(k)) && !qb.platforms.includes('android'), 'client: qBittorrent → Windows/Mac/Linux, not Android');
  ok(qb.look.some(x => /BT_backup/.test(x) && /\{hash\}/.test(x)), 'client: qBittorrent warrant hint names BT_backup + info hash');
  const fl = TMs.clientProfile('FL');
  ok(fl && fl.platforms.join() === 'android' && /Android phone/.test(fl.device), 'client: Flud → Android only');
  ok(TMs.clientProfile('ZZ') === null && TMs.clientProfile(null) === null, 'client: unknown code → no profile');
  const pid = (tag, n) => Buffer.from(tag + 'x'.repeat(20 - tag.length - String(n).length) + n).toString('hex');
  const fakeS = [
    { n: 1, handshake: true, handshakeAt: '2026-01-01 10:00:01', peerId: pid('-qB4630-', 1), ref: 'details.txt:5' },
    { n: 2, handshake: true, handshakeAt: '2026-01-01 11:00:00', peerId: pid('-qB5240-', 2), piecesDownloaded: 9, ref: 'details.txt:50' },
    { n: 3, handshake: false, peerId: null },
    { n: 4, handshake: true, handshakeAt: '2026-01-01 12:00:00', peerId: pid('-qB5240-', 2), piecesDownloaded: 3 }
  ];
  const cs = TMs.clientsSeen(fakeS);
  eq(cs.map(c => [c.name, c.version, c.handshakes, c.dataSessions, c.peerIds]), [['qBittorrent', '5.2.4', 2, 2, 1], ['qBittorrent', '4.6.3', 1, 0, 1]], 'client: clientsSeen groups by label, data-sessions first');
  eq([cs[0].firstAt, cs[0].firstRef], ['2026-01-01 11:00:00', 'details.txt:50'], 'client: first handshake time + log ref');
  const ch = ui._clientHtml({ sessions: fakeS, torrent: { infoHash: 'AB'.repeat(20) }, download: { gmtOffsetMin: -420 } });
  ok(/qBittorrent/.test(ch) && /5\.2\.4/.test(ch) && /Windows/.test(ch) && /macOS/.test(ch) && /Linux/.test(ch), 'client callout: name, version, platforms');
  ok(ch.includes('ab'.repeat(20) + '</code>.torrent') || ch.includes('<code>' + 'ab'.repeat(20) + '</code>'), 'client callout: info hash inserted into warrant hints');
  ok(/2 different BitTorrent programs/.test(ch) && /updated during the download/.test(ch), 'client callout: second version flagged');
  ok(/self-reported/.test(ch), 'client callout: self-reported caveat');
  ok(/did not identify itself/.test(ui._clientHtml({ sessions: [{ n: 1, handshake: false }] })), 'client callout: no handshake → says so');

  // ── case-stores registration
  const CS = require('../../_shared/case-stores');
  const st = CS.byKey('bittorrent');
  ok(st && st.pattern === 2 && st.shape === 'wrapped' && st.list === 'imports', 'case-stores: bittorrent registered');
  ok(st && st.orphanOnTransfer === true && !st.reid && !st.files, 'case-stores: payload never travels, id never re-minted');
  ok(CS.keys2().indexOf('bittorrent') >= 0, 'case-stores: snapshotted/exported key');
  eq(st.identity({ id: 'td_x' }), 'bt|td_x', 'case-stores: identity = download id');

  clean();
  failures.forEach(x => console.log('FAIL', x));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clean(); console.log('CRASH', e.stack); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
