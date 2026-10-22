/**
 * BitTorrent (TD) tab — Phase 1 tests: td-model.js + td-log-parser.js
 * on synthetic Torrential Downpour logs. Run: node modules/bittorrent/__tests__/td-parser.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../td-model');
const P = require('../td-log-parser');
const FX = require('../test_fixtures/td-fixtures');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) { if (cond) pass++; else { fail++; failures.push(name); } }
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; failures.push(`${name}: got ${g} want ${w}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-td-test-'));
const clean = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

(async () => {
  // ── td-model: ranges
  eq(M.parseRanges('0-21, 23-173, 175-687'), [[0, 21], [23, 173], [175, 687]], 'parseRanges');
  eq(M.countRanges('0-21, 23-173, 175-687'), 686, 'countRanges real-shape');
  eq(M.countRanges('0-20, 23-173, 175-687'), 685, 'countRanges written');
  eq(M.countRanges(''), 0, 'countRanges empty');
  eq(M.formatRanges('5, 3-4, 9, 10'), '3-5, 9-10', 'formatRanges merges');
  eq(M.formatRanges(M.rangesFromList([7, 1, 2, 3, 9])), '1-3, 7, 9', 'rangesFromList');
  eq(M.formatRanges(M.missingRanges('0-21, 23-173, 175-687', 688)), '22, 174', 'missingRanges');
  eq(M.formatRanges(M.missingRanges('', 4)), '0-3', 'missingRanges none');

  // ── td-model: Teredo (worked example from TD/Teredo documentation)
  const t = M.teredoDecode('2001:0:9d38:90d7:2c18:10:62c3:f1f4');
  eq(t && t.clientIPv4, '157.60.14.11', 'teredo client IPv4');
  eq(t && t.server, '157.56.144.215', 'teredo server');
  eq(M.teredoDecode('2001:0:9d38:90d7:14b1:1da:cd01:3b7a').clientIPv4, '50.254.196.133', 'teredo TD 1.27 example');
  eq(M.teredoDecode('2601:543:c000:7900::1'), null, 'non-teredo IPv6 → null');
  eq(M.teredoDecode('203.0.113.45'), null, 'IPv4 → null');
  eq(M.expandIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304], 'expandIPv6 mapped v4');

  // ── td-model: clients
  eq(M.decodeClient('-qB5240-').name + ' ' + M.decodeClient('-qB5240-').version, 'qBittorrent 5.2.4', 'qB decode');
  eq(M.decodeClient('-UT3450-').version, '3.4.5', 'uT decode');
  eq(M.decodeClient('-TR2940-').name + ' ' + M.decodeClient('-TR2940-').version, 'Transmission 2.94', 'TR decode');
  eq(M.decodeClient('-lt0D80-').version, '0.13.8', 'rTorrent base-36 digit');
  eq(M.decodeClient('2d7142353234302d' + '00'.repeat(12)).tag, '-qB5240-', 'decode from hex peer id');
  eq(M.decodeClient('M7-2-2--').name, null, 'unknown style → null name');
  eq(M.clientLabel({ clientTag: '-UT3450-', clientName: 'μTorrent 3.4.5' }), 'μTorrent 3.4.5 (-UT3450-)', 'clientLabel prefers v=');

  // ── td-model: dates
  eq(M.parseLongDate('Monday, October 19, 2026 23:37'), '2026-10-19 23:37', 'long date 24h');
  eq(M.parseLongDate('Wednesday, August 17, 2016 10:17:34 AM'), '2016-08-17 10:17:34', 'long date AM');
  eq(M.parseLongDate('Wednesday, August 17, 2016 12:05:00 AM'), '2016-08-17 00:05:00', 'long date 12 AM');
  eq(M.parseLongDate('Wednesday, August 17, 2016 2:17:34 PM'), '2016-08-17 14:17:34', 'long date PM');
  eq(M.parseGmtOffset('(GMT-07:00)'), -420, 'gmt offset');
  eq(M.localToUtc('2026-10-19 23:37:42', -420), '2026-10-20 06:37:42', 'localToUtc');
  eq(M.formatDuration(86400 + 360), '1d 0h 6m', 'formatDuration');

  // ── splitLine
  eq(P.splitLine('2026-10-19 23:37:41 - Torrential Downpour version 1.47'), { ts: '2026-10-19 23:37:41', msg: 'Torrential Downpour version 1.47' }, 'splitLine 24h');
  eq(P.splitLine('8/17/2016 2:17:34 PM - Connected'), { ts: '2016-08-17 14:17:34', msg: 'Connected' }, 'splitLine 12h');
  eq(P.splitLine('Connected'), { ts: null, msg: 'Connected' }, 'splitLine bare');

  // ── folder meta
  eq(P.parseFolderMeta('C:\\TD\\US.MA.Amherst_128.119.245.1\\20120312_150308_4'),
    { caseFolder: '20120312_150308_4', stamp: '2012-03-12 15:03:08', downloadId: 4, ipFolder: 'US.MA.Amherst_128.119.245.1', location: 'US.MA.Amherst', ip: '128.119.245.1' }, 'folder meta 1.47');
  eq(P.parseFolderMeta('C:\\TD\\US.MA.Amherst_128.119.245.1\\2012-03-12_15-03-08_4').stamp, '2012-03-12 15:03:08', 'folder meta pre-1.47');
  // Hand-off folders like OneDrive_1_10-21-2026 are dates, not IPv6 IP folders
  eq(P.parseFolderMeta('C:\\x\\OneDrive_1_10-21-2026\\sub').ip, null, 'folder meta: OneDrive date folder is not an IP');
  eq(P.parseFolderMeta('C:\\x\\Export_2026-10-21\\sub').ip, null, 'folder meta: ISO date folder is not an IP');
  eq(P.parseFolderMeta('C:\\x\\US.CA.X_2001-db8--1\\sub').ip, '2001:db8::1', 'folder meta: compressed IPv6 still read');
  eq(P.parseFolderMeta('C:\\x\\US.CA.X_2001-0-9d38-90d7\\sub').ip, '2001:0:9d38:90d7', 'folder meta: short IPv6 with hex letters still read');

  // ── A: TD 1.47 full download, details rolled mid-session, netstat
  const a = FX.td147({});
  const caseA = FX.writeCase(path.join(TMP, 'A'), 'A', a, { split: 40, netstat: FX.netstat('203.0.113.45', true) });
  const foundAll = P.findTdDownloads(path.join(TMP, 'A'));
  eq(foundAll.length, 1, 'A: discovered from investigations root');
  eq(foundAll[0].files.details.map(f => f.name), ['details.txt', 'details_001.txt'], 'A: roll order');
  eq(P.discoverLogs(path.join(caseA, 'Logs')).caseDir, caseA, 'A: discover from Logs folder → case dir');
  ok(!!P.discoverLogs(caseA).downloadDir, 'A: Download dir found');
  let progressCalls = 0;
  const A = await P.parseTdDownload(caseA, { onProgress: () => progressCalls++ });
  ok(progressCalls >= 2, 'A: progress reported');
  eq(A.tool.version, '1.47', 'A: version');
  eq(A.remote.ip, '203.0.113.45', 'A: remote ip');
  eq(A.remote.port, 51413, 'A: port');
  eq(A.torrent.infoHash, FX.IH, 'A: info hash');
  eq(A.torrent.pieceCount, 4, 'A: pieces');
  eq(A.download.gmtOffsetMin, -480, 'A: offset');
  eq(A.download.startedUtc, '2026-03-03 05:15', 'A: started UTC from log');
  eq(A.sessions.length, 4, 'A: 4 attempts');
  eq(A.sessions.map(s => s.result), ['connected', 'connected', 'failed', 'connected'], 'A: results');
  eq(A.sessions.map(s => M.sessionEndKind(s)), ['closed', 'reset', 'failed', 'idle'], 'A: end kinds');
  eq(A.sessions[0].piecesDownloaded, 3, 'A: s1 pieces');
  eq(A.sessions[0].piecesReceived, 3, 'A: s1 piece lines across roll boundary');
  eq(A.sessions[0].have, 3, 'A: s1 have');
  eq(A.sessions[0].haveRanges, '0-2', 'A: s1 have ranges');
  eq(A.sessions[0].clientTag, '-qB5240-', 'A: client tag');
  eq(A.sessions[0].ourIp, '198.51.100.7', 'A: yourip');
  eq(A.sessions[0].encrypted, true, 'A: encrypted');
  eq(A.sessions[2].failReason.endsWith('failed to respond'), true, 'A: fail reason strips ip:port');
  eq(A.sessions[0].sleepSec, 130, 'A: sleep parsed');
  ok(/^details(_001)?\.txt:\d+$/.test(A.sessions[1].ref), 'A: session ref');
  eq(A.closing.acknowledgedRanges, '0-2', 'A: acknowledged ranges');
  eq(A.closing.writtenRanges, '0-2', 'A: written ranges');
  eq(A.closing.limits, ['Exceeded maximum download time limit of 1 day'], 'A: limit');
  eq(A.closing.outcome, 'incomplete', 'A: outcome');
  eq(A.closing.validation.allValid, true, 'A: validation');
  eq(A.closing.validation.ok, 3, 'A: per-piece validations counted');
  eq(M.fileStatusCounts(A.files), { complete: 2, incomplete: 1, none: 1, unknown: 0, total: 4 }, 'A: file statuses');
  eq(A.files[0].sha1, FX.sha1('file0'), 'A: file sha1');
  eq(A.files[0].sha1b32, FX.b32(FX.sha1('file0')), 'A: file base32');
  ok(/^details_001\.txt:\d+$/.test(A.files[0].ref), 'A: hash ref points at roll file');
  eq(A.files[2].bytesWritten, 75000, 'A: incomplete bytes');
  eq(A.files[0].path, 'Holiday Set\\beach_01.jpg', 'A: path from torrentinfo');
  eq(A.files[0].diskPath, 'Holiday-Set-Torrent\\Holiday Set\\beach_01.jpg', 'A: disk path from created line');
  eq([A.files[2].firstPiece, A.files[2].lastPiece], [1, 3], 'A: spans');
  eq(A.files[1].completedInSession, 1, 'A: file completed in session 1');
  eq(A.pieceHashes.length, 4, 'A: piece hashes from torrentinfo');
  eq(A.pieceDelivery, { 0: 1, 1: 1, 2: 1 }, 'A: piece delivery map');
  eq(A.stats.unknownLines, 0, 'A: no unknown lines');
  eq(A.warnings, [], 'A: no warnings');
  const sA = A.summary;
  eq([sA.attempts, sA.connected, sA.failed, sA.handshakes], [4, 3, 1, 3], 'A: summary counts');
  eq([sA.piecesWritten, sA.acknowledged, sA.haveOf], [3, 3, 4], 'A: summary pieces');
  eq(sA.endReason, 'Exceeded maximum download time limit of 1 day', 'A: summary end');
  eq(sA.suspectIp, '203.0.113.45', 'A: suspect ip');
  eq(sA.clients, [{ label: 'qBittorrent 5.2.4 (-qB5240-)', sessions: 3 }], 'A: clients');
  eq(sA.acknowledgedAllNoData, false, 'A: not ack-all-no-data');
  eq(A.netstat.length, 2, 'A: netstat blocks');
  eq(A.netstat[0].matches.length, 1, 'A: netstat match');
  eq(A.netstat[1].matches.length, 0, 'A: netstat non-match');
  eq(A.netstat[0].at, '2026-03-02 21:15', 'A: netstat time');
  eq(M.netstatSummary(A), { blocks: 2, withRemote: 1, established: 1, first: '2026-03-02 21:15', last: '2026-03-02 21:15', remoteIp: '203.0.113.45' }, 'A: netstat summary');
  eq(A.id, 'td_203.0.113.45_202603022115_7_' + FX.IH.slice(0, 8), 'A: download id');
  const gA = M.groupSessions(A.sessions);
  eq(gA.map(g => [g.kind, g.count, g.hasData]), [['closed', 1, true], ['reset', 1, false], ['failed', 1, false], ['idle', 1, false]], 'A: groups');
  ok(JSON.parse(JSON.stringify(A)).files.length === 4, 'A: JSON round-trip');

  // ── B: grouping collapses repeats
  const b = FX.td147({ sessions: ['data', 'reset', 'reset', 'reset', 'failed', 'failed', 'idle', 'idle', 'failed'] });
  const B = await P.parseTdDownload(FX.writeCase(path.join(TMP, 'B'), 'B', b, {}));
  eq(M.groupSessions(B.sessions).map(g => g.kind + 'x' + g.count), ['closedx1', 'resetx3', 'failedx2', 'idlex2', 'failedx1'], 'B: grouped timeline');

  // ── C: summary-only (no details) still yields handshakes + closing
  const C = await P.parseTdDownload(FX.writeCase(path.join(TMP, 'C'), 'C', { summary: a.summary }, {}));
  eq(C.primaryLog, 'summary', 'C: summary primary');
  eq(C.sessions.length, 3, 'C: sessions from handshakes');
  eq(C.sessions.map(s => s.piecesDownloaded), [3, 0, 0], 'C: per-session pieces');
  eq(M.fileStatusCounts(C.files).complete, 2, 'C: closing file status');
  eq(C.stats.unknownLines, 0, 'C: no unknown');

  // ── D: TD 1.27 Teredo + 12h timestamps + has-all, zero download
  const D = await P.parseTdDownload(FX.writeCase(path.join(TMP, 'D'), 'D', { details: FX.td127Teredo() }, { ip: '2001-0-9d38-90d7', stamp: '2016-08-17_10-17-34_2' }));
  eq(D.tool.version, '1.27', 'D: version');
  eq(D.remote.ip, '2001:0:9d38:90d7:14b1:1da:cd01:3b7a', 'D: teredo ip');
  eq(D.remote.teredo.ipv4, '50.254.196.133', 'D: teredo ipv4 from log');
  eq(D.remote.teredo.server, '157.56.144.215', 'D: teredo server decoded');
  eq(D.remote.identifyIp, '50.254.196.133', 'D: identify ip');
  eq(D.remote.reportedIPv6, '2601:543:c000:7900:e9e1:88ff:8d0d:b7f6', 'D: reported v6');
  eq(D.download.startedAt, '2016-08-17 10:17:34', 'D: 12h start');
  eq(D.download.gmtOffsetMin, -240, 'D: offset');
  eq(D.sessions[0].attemptAt, '2016-08-17 10:18:34', 'D: 12h session time');
  eq(D.sessions[0].clientName, 'μTorrent 3.4.5', 'D: v= client');
  eq(D.sessions[0].have, 4, 'D: have-all');
  eq(D.sessions[0].ext.ipv4, '50.254.196.133', 'D: ext ipv4');
  eq(D.summary.suspectIp, '50.254.196.133', 'D: suspect ip is IPv4');
  eq(D.summary.acknowledgedAllNoData, true, 'D: acknowledged all, downloaded none');
  eq(D.summary.piecesWritten, 0, 'D: none written');
  eq(D.folder.downloadId, 2, 'D: pre-1.47 folder id');
  eq(D.stats.unknownLines, 0, 'D: no unknown lines');
  eq(D.warnings, [], 'D: no warnings');

  // ── E: failed only
  const e = FX.td147({ sessions: ['failed', 'failed', 'failed'], have: 0 });
  const E = await P.parseTdDownload(FX.writeCase(path.join(TMP, 'E'), 'E', e, {}));
  eq([E.summary.attempts, E.summary.connected, E.summary.handshakes, E.summary.piecesWritten], [3, 0, 0, 0], 'E: failed-only counts');
  eq(E.summary.firstContact, null, 'E: no contact');
  eq(M.fileStatusCounts(E.files).none, 4, 'E: no files');

  // ── F: validation failure + unknown wording + encryption reject
  const f = FX.td147({ sessions: ['reject', 'data'], badPiece: 1, unknownLine: 'Some brand new TD message 42 here' });
  const F = await P.parseTdDownload(FX.writeCase(path.join(TMP, 'F'), 'F', f, {}));
  eq(F.closing.validation.allValid, false, 'F: validation failed');
  eq(F.closing.validation.failures.map(x => x.piece), [1], 'F: failing piece');
  eq(F.summary.hashesValid, false, 'F: summary hashes invalid');
  eq(F.stats.unknownLines, 1, 'F: unknown counted');
  eq(F.stats.unknown[0].template, 'Some brand new TD message N here', 'F: unknown template');
  ok(F.warnings.some(w => w.code === 'unknown-lines'), 'F: unknown warning');
  eq(M.sessionEndKind(F.sessions[0]), 'rejected', 'F: encryption reject');
  eq(F.sessions[0].handshake, false, 'F: no handshake on reject');

  // ── G: last details roll missing → closing from summary, roll gap warned
  const gDir = FX.writeCase(path.join(TMP, 'G'), 'G', a, { split: a.details.length - 30, secondName: 'details_002.txt' });
  fs.unlinkSync(path.join(gDir, 'Logs', 'details_002.txt'));
  fs.writeFileSync(path.join(gDir, 'Logs', 'summary.txt'), a.summary.join('\r\n'));
  fs.writeFileSync(path.join(gDir, 'Logs', 'details_002.txt'), '');
  const G = await P.parseTdDownload(gDir);
  ok(G.warnings.some(w => w.code === 'roll-gap'), 'G: roll gap warned');
  ok(G.warnings.some(w => w.code === 'closing-from-summary'), 'G: closing from summary');
  eq(M.fileStatusCounts(G.files).complete, 2, 'G: file results recovered');

  // ── H: info hash mismatch warns
  const hDir = FX.writeCase(path.join(TMP, 'H'), 'H', a, {});
  fs.writeFileSync(path.join(hDir, 'Logs', 'torrentinfo.txt'), FX.torrentInfo().replace(new RegExp(FX.IH, 'gi'), 'f'.repeat(40)));
  const H = await P.parseTdDownload(hDir);
  ok(H.warnings.some(w => w.code === 'infohash-mismatch'), 'H: info hash mismatch warned');

  // ── I: cancel
  let cancelled = false;
  const big = FX.td147({});
  const pad = [];
  for (let i = 0; i < 40000; i++) pad.push(`2026-03-02 21:15:20 - File index ${i % 4} is named "x.jpg" in the torrent`);
  big.details.splice(12, 0, ...pad);
  try { await P.parseTdDownload(FX.writeCase(path.join(TMP, 'I'), 'I', big, {}), { isCancelled: () => true }); }
  catch (err) { cancelled = !!err.cancelled; }
  ok(cancelled, 'I: cancellation rejects with cancelled flag');

  // ── J: no logs
  let threw = false;
  try { await P.parseTdDownload(TMP + '\\nope'); } catch (_) { threw = true; }
  ok(threw, 'J: missing logs throws');
  eq(P.findTdDownloads(path.join(TMP, 'nope')), [], 'J: find on missing dir → []');

  // ── K: td-model loads in a renderer-like sandbox (module defined AND window)
  const src = fs.readFileSync(path.join(__dirname, '..', 'td-model.js'), 'utf8');
  const sb = { module: { exports: {} } }; sb.window = sb;
  vm.createContext(sb); vm.runInContext(src, sb);
  ok(typeof sb.window.TdModel === 'object' && typeof sb.window.TdModel.summarize === 'function', 'K: window.TdModel set in renderer');
  ok(typeof sb.module.exports.summarize === 'function', 'K: module.exports set too');

  clean();
  failures.forEach(x => console.log('FAIL', x));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clean(); console.log('CRASH', e.stack); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
