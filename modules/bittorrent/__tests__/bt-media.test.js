/**
 * BitTorrent tab — Phase 4: downloaded files (find on disk, serve by index,
 * ffmpeg video thumbs / playback copies, SHA-1 re-check) and the renderer
 * grid / blur / verify UI pieces. Synthetic fixtures only.
 *
 * Run: node modules/bittorrent/__tests__/bt-media.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require('../bt-main');
const P = require('../td-log-parser');
const FX = require('../test_fixtures/td-fixtures');
const VP = require('../../_shared/video-playback');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) { if (cond) pass++; else { fail++; failures.push(name); } }
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; failures.push(`${name}: got ${g} want ${w}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-bt-media-'));
const clean = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
const REPO = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

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
function fakeIpc() { const h = {}; return { handle: (ch, fn) => { h[ch] = fn; }, h }; }
function fakeEvent(log) { return { sender: { isDestroyed: () => false, send: (ch, d) => log.push([ch, d]) } }; }

/** Write the Download folder: content 'file<i>' hashes to the fixture's SHA-1. */
function writeDownload(dlRoot, model, prefix) {
  for (const f of model.files) {
    if (!f || !f.path || f.status === 'none') continue;
    const p = path.join(dlRoot, prefix || '', f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'file' + f.index);
  }
}

(async () => {
  // ── fixture: TD download with a Download folder (paths are relative to the torrent)
  const inv = path.join(TMP, 'Investigations');
  const srcCase = FX.writeCase(inv, 'A', FX.td147({}), {});
  const model0 = await P.parseTdDownload(srcCase);
  const hashed = model0.files.filter(f => f.sha1).map(f => f.index);
  ok(hashed.length >= 2, 'fixture: at least two files have a SHA-1 in the log');
  const notNone = model0.files.filter(f => f.status !== 'none').map(f => f.index);
  writeDownload(path.join(srcCase, 'Download'), model0);
  fs.writeFileSync(path.join(srcCase, 'Download', 'stray.bin'), 'x');   // not in the torrent

  // ── mediaKind / renderer kindOf agree for every video extension main knows
  eq(['a.jpg', 'b.JPEG', 'c.jpe', 'd.png', 'e.flv', 'f.avi', 'g.wmv', 'h.mpg', 'i.3gp', 'j.mp4', 'k.txt', 'l.url', 'm'].map(B.mediaKind),
    ['image', 'image', 'image', 'image', 'video', 'video', 'video', 'video', 'video', 'video', 'other', 'other', 'other'], 'mediaKind');
  const UI = require('../bittorrent-ui.js');
  ok(typeof UI === 'function' && typeof UI.kindOf === 'function', 'bittorrent-ui exports BitTorrentUI with kindOf');
  const allV = VP.ALL_VIDEO_EXT || [];
  ok(allV.length > 10 && allV.every(e => UI.kindOf('x.' + e) === 'video'), 'renderer treats every main video extension as video');
  ok(allV.every(e => B.mediaKind('x.' + e) === 'video'), 'main mediaKind: every video extension');
  ok(['jpg', 'jpeg', 'jpe', 'png', 'gif', 'bmp', 'webp'].every(e => UI.kindOf('x.' + e) === 'image' && B.mediaKind('x.' + e) === 'image'), 'image extensions agree');

  // ── resolveDownloadFiles: <Download>\<path>
  const m1 = Object.assign({}, model0, { storage: { downloadDir: path.join(srcCase, 'Download') } });
  const r1 = B.resolveDownloadFiles(m1);
  ok(r1.exists, 'resolve: folder found');
  eq([...r1.byIndex.keys()].sort(), notNone.slice().sort(), 'resolve: every written file matched by torrent path');
  eq(r1.extra, 1, 'resolve: a file not in the torrent is counted, not matched');
  ok([...r1.byIndex.values()].every(l => l.path.startsWith(path.join(srcCase, 'Download') + path.sep)), 'resolve: every match is inside the Download folder');
  // <Download>\<torrent name>\<path> and different case
  const alt = path.join(TMP, 'alt', 'Download');
  writeDownload(alt, model0, 'Some Torrent Name');
  const r2 = B.resolveDownloadFiles(Object.assign({}, model0, { storage: { downloadDir: alt } }));
  eq(r2.byIndex.size, notNone.length, 'resolve: extra torrent-name folder level is tolerated');
  const alt3 = path.join(TMP, 'alt3', 'Download');
  for (const f of model0.files) if (f.status !== 'none') { const p = path.join(alt3, f.path.toUpperCase()); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'file' + f.index); }
  eq(B.resolveDownloadFiles(Object.assign({}, model0, { storage: { downloadDir: alt3 } })).byIndex.size, notNone.length, 'resolve: case-insensitive (Windows)');
  eq(B.resolveDownloadFiles(Object.assign({}, model0, { storage: { downloadDir: null } })).exists, false, 'resolve: no Download folder → nothing');
  eq(B.resolveDownloadFiles(Object.assign({}, model0, { storage: { downloadDir: path.join(TMP, 'nope') } })).exists, false, 'resolve: unreachable folder → exists:false');

  // ── verifyDownload
  const prog = [];
  const v1 = await B.verifyDownload(m1, r1, { onProgress: (p) => prog.push(p) });
  eq([v1.withHash, v1.checked, v1.matched, v1.mismatched, v1.missing, v1.unreadable], [hashed.length, hashed.length, hashed.length, [], [], []], 'verify: all files match the TD SHA-1');
  ok(prog.length && prog[prog.length - 1].phase === 'verify' && prog[prog.length - 1].filesDone === hashed.length, 'verify: progress reaches every hashed file');
  eq(v1.noHashInLog, model0.files.length - hashed.length, 'verify: files with no log hash are counted, not compared');
  // tamper one, remove one
  const bad = hashed[0], gone = hashed[1];
  fs.writeFileSync(r1.byIndex.get(bad).path, 'tampered');
  fs.unlinkSync(r1.byIndex.get(gone).path);
  const r1b = B.resolveDownloadFiles(m1);
  const v2 = await B.verifyDownload(m1, r1b, {});
  eq([v2.matched, v2.mismatched, v2.missing], [hashed.length - 2, [bad], [gone]], 'verify: changed file → mismatched, deleted file → missing');
  ok(B.verifySummary(v2).mismatched === 1 && B.verifySummary(v2).missing === 1, 'verifySummary counts');
  let cancelled = null;
  try { await B.verifyDownload(m1, r1b, { isCancelled: () => true }); } catch (e) { cancelled = e; }
  ok(cancelled && cancelled.cancelled, 'verify: cancel stops the check');
  // restore for the IPC tests
  writeDownload(path.join(srcCase, 'Download'), model0);

  // ── IPC: import (copy) → media list / url / video / verify
  const casesDir = path.join(TMP, 'cases');
  fs.mkdirSync(path.join(casesDir, '24-001'), { recursive: true });
  let security = null;
  const ipc = fakeIpc();
  const served = [], vcalls = [];
  B.register({
    ipcMain: ipc, dialog: {}, getMainWindow: () => null, getCasesDir: () => casesDir, getSecurity: () => security,
    mediaUrl: (p) => { served.push(p); return { success: true, fileUrl: 'viper-media://m/tok' + served.length }; },
    videoPlayback: {
      thumb: async (a) => { vcalls.push(['thumb', a]); return { success: true, dataUrl: 'data:image/jpeg;base64,AA' }; },
      prepare: async (a) => { vcalls.push(['play', a]); if (a.onProgress) a.onProgress({ pct: 50, stage: 'transcode' }); return { success: true, url: 'viper-media://m/copy', from: 'flv', format: 'mp4' }; }
    }
  });
  ['bt-media-list', 'bt-media-url', 'bt-video', 'bt-verify'].forEach(ch => ok(typeof ipc.h[ch] === 'function', 'registers ' + ch));
  const imp = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j1', caseNumber: '24-001', sourceDir: srcCase, mode: 'copy' });
  ok(imp.success, 'import (copy) ok');
  ok(imp.meta.storage.hasDownload === true, 'meta.storage.hasDownload');
  ok(imp.meta.verify === null, 'meta.verify null before any check');
  const id = imp.meta.id;
  const list = await ipc.h['bt-media-list']({}, { caseNumber: '24-001', downloadId: id });
  ok(list.success && list.hasDownloadFolder && list.folderFound, 'media-list: Download folder found in the case copy');
  eq(Object.keys(list.onDisk).map(Number).sort(), notNone.slice().sort(), 'media-list: on-disk files by index');
  ok(!JSON.stringify(list).includes(casesDir), 'media-list: no paths sent to the renderer');
  const copyDl = path.join(imp.copied.dest, 'Download');
  const u = await ipc.h['bt-media-url']({}, { caseNumber: '24-001', downloadId: id, index: notNone[0] });
  ok(u.success && /^viper-media:\/\//.test(u.fileUrl), 'media-url: token URL');
  ok(served[served.length - 1].startsWith(copyDl + path.sep), 'media-url: serves the case copy, inside its Download folder');
  const nPrev = served.length;
  for (const bad of [9999, -1, '../x', 'abc', 1.5, null]) {
    const r = await ipc.h['bt-media-url']({}, { caseNumber: '24-001', downloadId: id, index: bad });
    ok(r && r.success === false, 'media-url: refuses index ' + JSON.stringify(bad));
  }
  const none = model0.files.find(f => f.status === 'none');
  if (none) ok((await ipc.h['bt-media-url']({}, { caseNumber: '24-001', downloadId: id, index: none.index })).success === false, 'media-url: not-downloaded file refused');
  ok((await ipc.h['bt-media-url']({}, { caseNumber: '24-001', downloadId: '..\\..\\x', index: 0 })).success === false, 'media-url: bad download id refused');
  ok((await ipc.h['bt-media-url']({}, { caseNumber: '..', downloadId: id, index: 0 })).success === false, 'media-url: bad case refused');
  ok((await ipc.h['bt-media-url']({}, { caseNumber: '24-001', downloadId: id, index: 0, filePath: 'C:\\Windows\\win.ini' })).success !== undefined && served.length === nPrev + (served.length - nPrev), 'media-url: a filePath arg is ignored');
  ok(!served.some(p => /win\.ini/i.test(p)), 'media-url: never serves a renderer-sent path');

  const th = await ipc.h['bt-video'](fakeEvent([]), { op: 'thumb', caseNumber: '24-001', downloadId: id, index: notNone[0], size: 320 });
  ok(th.success && vcalls[0][0] === 'thumb' && vcalls[0][1].anyExt === true && vcalls[0][1].filePath.startsWith(copyDl), 'bt-video thumb: ffmpeg on the resolved file, anyExt');
  const evLog = [];
  const pl = await ipc.h['bt-video'](fakeEvent(evLog), { op: 'play', jobId: 'vplv-9', caseNumber: '24-001', downloadId: id, index: notNone[0] });
  ok(pl.success && pl.url === 'viper-media://m/copy', 'bt-video play: playback copy');
  ok(evLog.some(([ch, d]) => ch === 'video-playback-progress' && d.jobId === 'vplv-9' && d.pct === 50), 'bt-video play: progress on video-playback-progress with jobId');
  const nv = await ipc.h['bt-video'](fakeEvent([]), { op: 'thumb', caseNumber: '24-001', downloadId: id, index: 9999 });
  ok(nv.success === false && nv.reason === 'not-allowed', 'bt-video: unknown index → not-allowed');

  const vlog = [];
  const ver = await ipc.h['bt-verify'](fakeEvent(vlog), { jobId: 'v1', caseNumber: '24-001', downloadId: id });
  ok(ver.success && ver.summary.matched === hashed.length && !ver.summary.mismatched && !ver.summary.missing, 'bt-verify: copy matches the TD hashes');
  ok(vlog.some(([ch, d]) => ch === 'bt-progress' && d.jobId === 'v1' && d.phase === 'verify'), 'bt-verify: bt-progress phase verify');
  const saved = B.readModel(B.modelPath(casesDir, '24-001', id), null);
  ok(saved.verify && saved.verify.matched === hashed.length, 'bt-verify: result saved in the parsed JSON');
  ok(ver.meta.verify && ver.meta.verify.matched === hashed.length, 'bt-verify: meta carries the summary');
  ok(saved.sessions && saved.sessions.length === imp.meta.summary.attempts || saved.sessions.length > 0, 'bt-verify: rest of the model kept');
  const list2 = await ipc.h['bt-media-list']({}, { caseNumber: '24-001', downloadId: id });
  ok(list2.verify && list2.verify.matched === hashed.length, 'media-list returns the saved check');
  // tamper with the case copy → mismatch reported
  fs.writeFileSync(path.join(copyDl, model0.files[bad].path), 'changed');
  const ver2 = await ipc.h['bt-verify'](fakeEvent([]), { jobId: 'v2', caseNumber: '24-001', downloadId: id });
  eq(ver2.verify.mismatched, [bad], 'bt-verify: changed file in the case copy is flagged');

  // ── Field Security: encrypted copy is decrypted to hash + served via mediaUrl (main decrypts there)
  security = fakeSecurity(true);
  fs.mkdirSync(path.join(casesDir, '24-002'), { recursive: true });
  const impE = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j2', caseNumber: '24-002', sourceDir: srcCase, mode: 'copy' });
  ok(impE.success, 'vault import ok');
  const encFile = path.join(impE.copied.dest, 'Download', model0.files[hashed[0]].path);
  ok(security.isEncryptedBuffer(fs.readFileSync(encFile)), 'vault: media copy encrypted at rest');
  const verE = await ipc.h['bt-verify'](fakeEvent([]), { jobId: 'v3', caseNumber: '24-002', downloadId: impE.meta.id });
  ok(verE.success && verE.summary.matched === hashed.length, 'vault: encrypted copies hash to the TD values (decrypted in memory)');
  ok(security.isEncryptedBuffer(fs.readFileSync(B.modelPath(casesDir, '24-002', impE.meta.id))), 'vault: JSON with the check result stays encrypted');
  security.lock();
  const verL = await ipc.h['bt-verify'](fakeEvent([]), { jobId: 'v4', caseNumber: '24-002', downloadId: impE.meta.id });
  ok(verL.success === false, 'vault locked: check refused');
  const listL = await ipc.h['bt-media-list']({}, { caseNumber: '24-002', downloadId: impE.meta.id });
  ok(listL.success === false, 'vault locked: file list refused');
  security.unlock();
  security = null;

  // ── logs without a Download folder (the real-case shape)
  const noDl = FX.writeCase(path.join(TMP, 'Inv2'), 'B', FX.td147({}), {});
  fs.mkdirSync(path.join(casesDir, '24-003'), { recursive: true });
  const impN = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j3', caseNumber: '24-003', sourceDir: noDl, mode: 'copy' });
  ok(impN.success && impN.meta.storage.hasDownload === false, 'no Download folder: meta says so');
  const listN = await ipc.h['bt-media-list']({}, { caseNumber: '24-003', downloadId: impN.meta.id });
  ok(listN.success && listN.hasDownloadFolder === false && listN.matched === 0, 'no Download folder: empty list');

  // ── media uploaded to Evidence somewhere other than a Download folder
  const logsSrc = path.join(srcCase, 'Logs');
  const putLogs = (dir, tweak) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of fs.readdirSync(logsSrc)) fs.copyFileSync(path.join(logsSrc, n), path.join(dir, n));
    if (tweak) fs.appendFileSync(path.join(dir, 'details.txt'), '\n2026-03-02 21:20:00 another download\n');
  };
  const sized = (p, n, head) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const b = Buffer.alloc(n, 0x61);
    if (head) head.copy(b, 0);
    fs.writeFileSync(p, b);
  };
  const SZ = {}; model0.files.forEach(f => { SZ[f.index] = f.size; });
  const evOf = (cn) => path.join(casesDir, cn, 'Evidence');
  const ctxOf = (cn, extra) => ({ casesDir, caseNumber: cn, extraRoots: extra || [], security: null });
  const withStore = (st) => Object.assign({}, model0, { storage: st });

  // 1. files uploaded flat beside loose logs (no Download folder)
  const flat = path.join(evOf('24-010'), 'TD upload');
  putLogs(flat);
  sized(path.join(flat, 'beach_01.jpg'), SZ[0]);
  sized(path.join(flat, 'beach_02.jpg'), SZ[1] - 10);        // partial copy, own folder → name match
  const rF = await B.locateDownloadFiles(withStore({ caseDir: flat, logsDir: flat, downloadDir: null }), ctxOf('24-010'));
  ok(rF.byIndex.has(0) && rF.byIndex.has(1), 'locate: files flat beside the logs are found');
  ok(rF.byIndex.get(0).where === 'case' && rF.byIndex.get(0).how === 'size', 'locate: flat file matched by name + exact size, in the own folder');
  eq(rF.exists, false, 'locate: exists stays false without a Download folder');
  const rFs = B.resolveDownloadFiles(withStore({ caseDir: flat, logsDir: flat, downloadDir: null }), ctxOf('24-010'));
  ok(rFs.byIndex.size === 2 && rFs.extra === 0, 'resolve (sync): own folder only, extras counted only in a Download folder');

  // 2. media in a separate Evidence item (own logs in their own tag folder)
  putLogs(path.join(evOf('24-011'), 'TD logs', 'Logs'));
  sized(path.join(evOf('24-011'), 'Pictures', 'beach_01.jpg'), SZ[0]);
  writeDownload(path.join(evOf('24-011'), 'Pictures'), { files: [model0.files[1]] });          // Holiday Set\beach_02.jpg, partial content
  sized(path.join(evOf('24-011'), 'Pictures', 'clip.mp4'), 1234);                              // wrong size, name only → not used
  const st11 = { caseDir: path.join(evOf('24-011'), 'TD logs'), logsDir: path.join(evOf('24-011'), 'TD logs', 'Logs'), downloadDir: null };
  const r11 = await B.locateDownloadFiles(withStore(st11), ctxOf('24-011'));
  ok(r11.searchedEvidence, 'locate: case Evidence searched when files are missing');
  ok(r11.byIndex.has(0) && r11.byIndex.get(0).where === 'evidence' && r11.byIndex.get(0).how === 'size', 'locate: same name + exact size in another Evidence item');
  ok(r11.byIndex.has(1) && r11.byIndex.get(1).how === 'path', 'locate: torrent folder + name in another Evidence item (partial file)');
  ok(!r11.byIndex.has(2), 'locate: name-only match with the wrong size is not used outside the own folder');
  eq(r11.places, [{ where: 'evidence', label: 'Pictures', count: 2 }], 'locate: places name the Evidence item');
  eq(r11.elsewhere, 2, 'locate: elsewhere count');
  ok(r11.roots.includes(evOf('24-011')), 'locate: matched Evidence folder becomes an allowed root');

  // 3 + 4. another TD download is never borrowed from; a copy of this one (twin) is
  const own12 = path.join(evOf('24-012'), 'Own');
  putLogs(own12);
  putLogs(path.join(evOf('24-012'), 'Other TD', 'Logs'), true);
  sized(path.join(evOf('24-012'), 'Other TD', 'Download', 'Holiday Set', 'beach_01.jpg'), SZ[0]);
  putLogs(path.join(evOf('24-012'), 'Copy TD', 'Logs'));
  sized(path.join(evOf('24-012'), 'Copy TD', 'Download', 'Holiday Set', 'clip.mp4'), 5000);
  sized(path.join(evOf('24-012'), 'Copy TD', 'Download', 'beach_02.jpg'), 40);             // twin: own rules (name only)
  const r12 = await B.locateDownloadFiles(withStore({ caseDir: own12, logsDir: own12, downloadDir: null }), ctxOf('24-012'));
  ok(!r12.byIndex.has(0), 'locate: files under another TD download are never used');
  ok(r12.byIndex.has(2) && r12.byIndex.get(2).where === 'evidence', 'locate: a copy of the same TD download (same log sizes) is used');
  ok(r12.byIndex.has(1) && r12.byIndex.get(1).how === 'name', 'locate: twin copy gets the own-folder rules');

  // 5. the same file in two Evidence items → left unmatched (ambiguous)
  const own13 = path.join(evOf('24-013'), 'Own');
  putLogs(own13);
  sized(path.join(evOf('24-013'), 'Item A', 'beach_01.jpg'), SZ[0]);
  sized(path.join(evOf('24-013'), 'Item B', 'beach_01.jpg'), SZ[0]);
  const r13 = await B.locateDownloadFiles(withStore({ caseDir: own13, logsDir: own13, downloadDir: null }), ctxOf('24-013'));
  ok(!r13.byIndex.has(0) && r13.ambiguous.includes(0), 'locate: same name + size in two Evidence items → ambiguous, not guessed');

  // 6. Field Security copy: size = plain + 40-byte header
  const own15 = path.join(evOf('24-015'), 'Own');
  putLogs(own15);
  sized(path.join(evOf('24-015'), 'Enc', 'beach_02.jpg'), SZ[1] + 40, Buffer.from('VIPENC'));
  sized(path.join(evOf('24-015'), 'Enc', 'beach_01.jpg'), SZ[0] + 40);                        // no header → size is off by 40
  const r15 = await B.locateDownloadFiles(withStore({ caseDir: own15, logsDir: own15, downloadDir: null }), ctxOf('24-015'));
  ok(r15.byIndex.has(1) && r15.byIndex.get(1).how === 'size', 'locate: encrypted copy matched on its plain size');
  ok(!r15.byIndex.has(0), 'locate: unencrypted file 40 bytes too big is not matched');

  // 7. case folder moved: stored paths re-based onto the current cases folder
  const moved = path.join(evOf('24-014'), 'TD1');
  putLogs(path.join(moved, 'Logs'));
  writeDownload(path.join(moved, 'Download'), model0);
  const oldBase = path.join(TMP, 'old-drive', 'cases', '24-014', 'Evidence', 'TD1');
  const r14 = await B.locateDownloadFiles(withStore({ caseDir: oldBase, logsDir: path.join(oldBase, 'Logs'), downloadDir: path.join(oldBase, 'Download') }), ctxOf('24-014'));
  ok(r14.exists && r14.byIndex.size === notNone.length && [...r14.byIndex.values()].every(v => v.where === 'download'), 'locate: moved case folder → stored paths re-based');
  const r14b = await B.locateDownloadFiles(withStore({ caseDir: oldBase, logsDir: path.join(oldBase, 'Logs'), downloadDir: path.join(oldBase, 'Download') }), ctxOf('24-099'));
  eq(r14b.byIndex.size, 0, 'locate: re-basing only within the same case number');

  // 8. Logs uploaded straight into Evidence: the whole Evidence folder is not an "own" folder
  putLogs(path.join(evOf('24-016'), 'Logs'));
  sized(path.join(evOf('24-016'), 'Pics', 'beach_02.jpg'), 77);                                 // name only, wrong size
  const r16 = await B.locateDownloadFiles(withStore({ caseDir: evOf('24-016'), logsDir: path.join(evOf('24-016'), 'Logs'), downloadDir: null }), ctxOf('24-016'));
  ok(!r16.roots.includes(evOf('24-016')) || !r16.byIndex.size, 'locate: Evidence root is not searched with the loose own rules');
  ok(!r16.byIndex.has(1), 'locate: no name-only match across the whole Evidence folder');

  // 9. linked ("reference only") Evidence folder outside the cases folder
  const linked = path.join(TMP, 'USB', 'Linked media');
  sized(path.join(linked, 'beach_02.jpg'), SZ[1]);
  const r17 = await B.locateDownloadFiles(withStore(st11), ctxOf('24-011', B.cleanExtraRoots([linked, path.join(linked, 'beach_02.jpg')])));
  ok(r17.byIndex.get(1).where === 'evidence' && !r17.roots.includes(linked), 'locate: a stronger match in the case Evidence beats a linked copy; unused linked folder not allowed');
  eq(B.cleanExtraRoots([path.parse(TMP).root, 'relative\\x', '', null, path.join(TMP, 'nope'), linked, path.join(linked, 'beach_02.jpg')]), [linked], 'cleanExtraRoots: no drive root, relative or missing paths; files → folder; deduped');
  const r18 = await B.locateDownloadFiles(withStore({ caseDir: own13, logsDir: own13, downloadDir: null }), ctxOf('24-013', B.cleanExtraRoots([linked])));
  ok(!r18.byIndex.has(0) && r18.byIndex.has(1) && r18.byIndex.get(1).where === 'linked', 'locate: linked folder match reported as linked');
  // cached listing is reused, not re-walked
  sized(path.join(evOf('24-011'), 'Late', 'Holiday Set', 'clip.mp4'), 9000);
  const r11c = await B.locateDownloadFiles(withStore(st11), Object.assign(ctxOf('24-011'), { wide: r11.wide }));
  ok(!r11c.byIndex.has(2), 'locate: cached Evidence listing reused');
  const r11d = await B.locateDownloadFiles(withStore(st11), ctxOf('24-011'));
  ok(r11d.byIndex.has(2), 'locate: fresh search finds a newly added file');

  // IPC: import from inside the case, media found elsewhere in Evidence, served by index
  const imp11 = await ipc.h['bt-import'](fakeEvent([]), { jobId: 'j11', caseNumber: '24-011', sourceDir: path.join(evOf('24-011'), 'TD logs'), mode: 'case' });
  ok(imp11.success && imp11.meta.storage.hasDownload === false, 'IPC: import of logs without a Download folder');
  const l11 = await ipc.h['bt-media-list']({}, { caseNumber: '24-011', downloadId: imp11.meta.id, extraPaths: [linked], rescan: true });
  ok(l11.success && l11.matched === 3 && l11.elsewhere === 3, 'IPC media-list: files found elsewhere in Evidence + linked folder');
  ok(l11.hasDownloadFolder === false && l11.searchedEvidence === true && l11.ambiguous === 0, 'IPC media-list: state fields');
  ok(Array.isArray(l11.places) && l11.places.some(p => p.label === 'Pictures' && p.count === 2) && l11.places.some(p => p.label === 'Late'), 'IPC media-list: places by Evidence item');
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  ok(!JSON.stringify(l11).includes(esc(casesDir)) && !JSON.stringify(l11).includes(esc(TMP)), 'IPC media-list: still no paths sent to the renderer');
  const u11 = await ipc.h['bt-media-url']({}, { caseNumber: '24-011', downloadId: imp11.meta.id, index: 0 });
  ok(u11.success && served[served.length - 1] === path.join(evOf('24-011'), 'Pictures', 'beach_01.jpg'), 'IPC media-url: serves the file found in another Evidence item');
  const u11l = await ipc.h['bt-media-url']({}, { caseNumber: '24-011', downloadId: imp11.meta.id, index: 1 });
  ok(u11l.success && served[served.length - 1].startsWith(path.join(evOf('24-011'), 'Pictures')), 'IPC media-url: own-case Evidence preferred over the linked copy');
  const u11r = await ipc.h['bt-media-url']({}, { caseNumber: '24-011', downloadId: imp11.meta.id, index: 3 });
  ok(u11r.success === false, 'IPC media-url: not-found file refused');

  // ── renderer: grid / blur / verify UI (pure parts)
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const mod = { caseNumber: '24-001', imports: [{ id, ip: '203.0.113.45', summary: {}, verify: null }], verifyJob: null };
  const ui = new UI('x', mod);
  ui.selectedId = id;
  ui.model = JSON.parse(JSON.stringify(saved));
  ui.model.verify = ver2.verify;
  ui.media = { id, hasDownloadFolder: true, folderFound: true, onDisk: list.onDisk, matched: list.matched };
  ui.fileView = { q: '', status: '', page: 0 };
  const fBad = ui.model.files[bad];
  const fOk = ui.model.files.find(f => f.sha1 && f.index !== bad);
  eq(ui._fileState(fBad).verify, 'mismatch', 'ui: mismatched file state');
  eq(ui._fileState(fOk).verify, 'ok', 'ui: matching file state');
  ui.fileView.status = 'problem';
  eq(ui._filteredFiles().map(f => f.index), [bad], 'ui: "Hash problems" filter');
  ui.fileView.status = 'media';
  ok(ui._filteredFiles().every(f => UI.kindOf(f.path) !== 'other') && ui._filteredFiles().length === ui.model.files.filter(f => UI.kindOf(f.path) !== 'other').length, 'ui: "Pictures and videos" filter');
  ui.fileView.status = '';
  const vh = ui._verifyHtml();
  ok(/⚠/.test(vh) && /1<\/b> different/.test(vh) && /data-act="vproblems"/.test(vh), 'ui: verify line reports the mismatch with Show them');
  ui.model.verify = ver.verify;
  ok(new RegExp(`${hashed.length} of ${hashed.length} files on disk match the SHA-1 hashes in the TD log`).test(ui._verifyHtml()), 'ui: all-match line');
  ui.model.verify = null;
  ok(/Check SHA-1 hashes/.test(ui._verifyHtml()), 'ui: not checked yet → button');
  ui.verifyRun = { id, pct: 40, text: '1 of 3 files' };
  ok(/Checking SHA-1 hashes/.test(ui._verifyHtml()) && /width:40\.0%/.test(ui._verifyHtml()) && /vcancel/.test(ui._verifyHtml()), 'ui: running check shows progress + Cancel');
  ui.verifyRun = null;
  ui.media = { id, hasDownloadFolder: false };
  ok(/without a Download folder/.test(ui._verifyHtml()), 'ui: no Download folder message');
  ui.media = { id, hasDownloadFolder: true, folderFound: false };
  ok(/can't be reached/.test(ui._verifyHtml()), 'ui: unreachable folder message');
  ok(/data-act="mrescan"/.test(ui._verifyHtml()), 'ui: nothing found → Look again button');
  ui.media = { id, hasDownloadFolder: false, folderFound: false, onDisk: list.onDisk, matched: 3, elsewhere: 3, places: [{ where: 'evidence', label: 'Pictures <b>', count: 3 }], ambiguous: 1 };
  const vhE = ui._verifyHtml();
  ok(/found in Evidence: Pictures &lt;b&gt; \(3\)/.test(vhE) && !/without a Download folder/.test(vhE), 'ui: files found elsewhere in Evidence (label escaped)');
  ok(/1 file found in more than one Evidence item/.test(vhE), 'ui: ambiguous count shown');
  ui.media = { id, hasDownloadFolder: false, folderFound: false, onDisk: list.onDisk, matched: 3, elsewhere: 1, places: [{ where: 'evidence', label: 'Pictures', count: 1 }], ambiguous: 0 };
  ok(/2 in the download's folder, 1 elsewhere in Evidence \(Pictures \(1\)\)/.test(ui._verifyHtml()), 'ui: split between own folder and Evidence');
  ui.media = { id, hasDownloadFolder: true, folderFound: true, onDisk: list.onDisk, matched: list.matched };

  // blur: default on, per-officer pref, reveal one, reveal all (session)
  const img = ui.model.files.find(f => UI.kindOf(f.path) === 'image' && list.onDisk[f.index] != null);
  ok(img, 'fixture has an image on disk');
  let t = ui._tileHtml(img);
  ok(/btt-tile blur can/.test(t) && /Click to reveal/.test(t), 'tile: blurred by default with cover');
  ok(!/<img/.test(t) && !t.includes(casesDir) && !t.includes('viper-media'), 'tile html: no image source or path (filled in by index later)');
  UI.revealed.add(id + '|' + img.index);
  ok(!/ blur/.test(ui._tileHtml(img)), 'tile: revealed one is not blurred');
  UI.revealed.clear();
  UI.revealAll = true;
  ok(!/ blur/.test(ui._tileHtml(img)), 'tile: reveal all (session)');
  UI.revealAll = false;
  store.viperBtBlur = '0';
  ok(!/ blur/.test(ui._tileHtml(img)) && !ui._isBlurred(img.index), 'tile: officer turned blur off');
  delete store.viperBtBlur;
  ok(ui._isBlurred(img.index), 'blur back on by default');
  if (none) ok(/not downloaded/.test(ui._tileHtml(ui.model.files[none.index])) && !/ can/.test(ui._tileHtml(ui.model.files[none.index])), 'tile: not-downloaded file is not viewable');
  const part = ui.model.files.find(f => f.status === 'incomplete');
  if (part) ok(/partial/.test(ui._tileHtml(part)), 'tile: partial badge');
  const vid = ui.model.files.find(f => UI.kindOf(f.path) === 'video');
  if (vid) ok(/▶ MP4/.test(ui._tileHtml(vid)), 'tile: video badge with format');
  ui.model.verify = ver2.verify;
  ok(/hash differs/.test(ui._tileHtml(fBad)) && /hash differs/.test(ui._tableHtml([fBad])), 'tile + table: hash differs badge');
  // tile click: blurred → reveal; revealed → viewer; not on disk → toast
  const calls = [];
  ui._reveal = (i, on) => { calls.push(['reveal', i, on]); if (on) UI.revealed.add(id + '|' + i); };
  ui.openViewer = (i) => calls.push(['view', i]);
  ui._toast = (m) => calls.push(['toast', m]);
  ui._onTile(img.index);
  ui._onTile(img.index);
  eq(calls.slice(0, 2), [['reveal', img.index, true], ['view', img.index]], 'tile click: first reveals, second opens the in-app viewer');
  if (none) { ui._onTile(none.index); ok(calls[calls.length - 1][0] === 'toast' && /not downloaded/.test(calls[calls.length - 1][1]), 'tile click: not-downloaded → message only'); }
  const other = ui.model.files.find(f => UI.kindOf(f.path) === 'other' && list.onDisk[f.index] != null);
  if (other) { ui._onTile(other.index); ok(/pictures and videos/.test(calls[calls.length - 1][1]), 'tile click: other file types are not opened'); }
  UI.revealed.clear();
  // list item mark
  ok(/✓ hashes/.test(ui._listItemHtml({ id, summary: {}, verify: { withHash: 3, matched: 3, mismatched: 0, missing: 0, unreadable: 0 } })), 'list: ✓ hashes');
  ok(/⚠ hashes/.test(ui._listItemHtml({ id, summary: {}, verify: { withHash: 3, matched: 2, mismatched: 1, missing: 0, unreadable: 0 } })), 'list: ⚠ hashes');

  // ── module: verifyFiles / mediaUrl / videoThumb go by index
  const BM = require('../bittorrent-module.js');
  const seen = [];
  globalThis.window = globalThis;
  globalThis.electronAPI = {
    btMediaUrl: async (a) => { seen.push(['url', a]); return { success: true, fileUrl: 'viper-media://m/x' }; },
    btVideo: async (a) => { seen.push(['video', a]); return a.index === 1 ? { success: false, reason: 'undecodable' } : { success: true, dataUrl: 'data:x' }; },
    btMediaList: async (a) => ({ success: true, onDisk: {}, a }),
    btVerify: async (a) => { seen.push(['verify', a]); return { success: true, verify: { matched: 1 }, summary: { matched: 1, withHash: 1 } }; },
    onBtProgress: () => () => {}
  };
  const bm = new BM('c1', '24-001', 'x');
  bm.imports = [{ id: 'd1' }];
  bm.saveData = () => {};
  eq(await bm.mediaUrl('d1', 3), 'viper-media://m/x', 'module.mediaUrl');
  const mlA = (await bm.mediaList('d1', { rescan: true })).a;
  ok(mlA.downloadId === 'd1' && mlA.rescan === true && Array.isArray(mlA.extraPaths), 'module.mediaList sends linked Evidence folders + rescan');
  bm._evidenceList = () => [{ referenceOnly: true, sourcePath: 'E:\\Seized\\Pics', files: [{ path: 'E:\\Seized\\Pics\\sub\\a.jpg' }] }, { released: true, referenceOnly: true, sourcePath: 'E:\\Gone' }, { sourcePath: 'C:\\copied' }];
  eq(bm._evidenceLinkedFolders(), ['E:\\Seized\\Pics', 'E:\\Seized\\Pics\\sub'], 'module: linked folders from reference-only Evidence items (not released, not copied)');
  eq(Object.keys(seen[0][1]).sort(), ['caseNumber', 'downloadId', 'index'], 'module.mediaUrl sends case + download id + index only');
  eq(await bm.videoThumb('d1', 1), false, 'module.videoThumb: undecodable → false (final)');
  eq(await bm.videoThumb('d1', 2), 'data:x', 'module.videoThumb: frame');
  const vr = await bm.verifyFiles('d1');
  ok(vr.success && bm.imports[0].verify.matched === 1 && bm.verifyJob === null, 'module.verifyFiles stores the summary and clears the job');
  delete globalThis.electronAPI;

  // ── legacy-video: BitTorrent viewer source goes to bt-video, never warrant-video
  const LV = require('../../_shared/legacy-video.js');
  const host = (json) => { const h = { getAttribute: (k) => (k === 'data-vplv' ? json : null) }; h.closest = () => h; return h; };
  const src = LV.sourceOf(host(JSON.stringify({ caseNumber: '24-001', downloadId: id, index: 2, name: 'clip.flv' })));
  eq(src, { caseNumber: '24-001', downloadId: id, index: 2 }, 'legacy-video: bt source from data-vplv');
  eq(LV.keyOf(src), `b|24-001|${id}|2`, 'legacy-video: bt key');
  const lvCalls = [];
  LV._resetForTests();
  LV.win = { electronAPI: { warrantVideo: async () => { lvCalls.push('warrant'); return {}; }, btVideo: async (a) => { lvCalls.push(['bt', a]); return { success: true, dataUrl: 'data:f' }; } } };
  eq(await LV.thumb(src), 'data:f', 'legacy-video: bt thumb');
  ok(lvCalls.length === 1 && lvCalls[0][0] === 'bt' && lvCalls[0][1].index === 2 && !('filePath' in lvCalls[0][1]), 'legacy-video: bt thumb uses btVideo by index');
  LV.win = null;

  // ── wiring
  const pre = read('preload.js');
  ok(['bt-media-list', 'bt-media-url', 'bt-video', 'bt-verify'].every(ch => pre.includes(`'${ch}'`)), 'preload exposes the four channels');
  const em = read('electron-main.js');
  ok(/mediaUrl:\s*\(p\)\s*=>\s*_mediaUrlForCheckedPath\(p\)/.test(em) && /videoPlayback:\s*_videoPlayback/.test(em), 'electron-main passes mediaUrl + videoPlayback to bt-main');
  ok(/const full = _warrantMediaCheckPath\(filePath, casesDir\);\s*if \(!full\) return \{ success: false, error: 'Path not allowed' \};\s*return _mediaUrlForCheckedPath\(full\);/.test(em), 'warrant-media-url still guards before serving');
  ok(em.indexOf('const _videoPlayback =') < em.indexOf("require('./modules/bittorrent/bt-main').register"), '_videoPlayback defined before the BitTorrent register call');
  const ui1 = read('modules/bittorrent/bittorrent-ui.js');
  ok(!/Downloaded files are never shown here/.test(ui1), 'import text no longer says files are never shown');
  ok(/_autoVerify\(toVerify\)/.test(ui1), 'hash check starts after import');
  ok(!/shell\.openPath|openExternal|openPath/.test(ui1), 'viewer never opens an outside program');
  const cd = read('case-detail-with-analytics.html');
  ok(cd.includes('modules/_shared/legacy-video.js') && cd.includes('modules/bittorrent/bittorrent-ui.js'), 'case-detail loads legacy-video + BitTorrent UI');

  clean();
  failures.forEach(x => console.log('FAIL', x));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clean(); failures.forEach(x => console.log('FAIL', x)); console.log('CRASH', e.stack); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
