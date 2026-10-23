/**
 * BitTorrent tab — collapsible sections + "pick up where you left off"
 * (selected download, open sections, file filters/page, scroll; same
 * module/UI reused when the tab is shown again). Synthetic data only.
 *
 * Run: node modules/bittorrent/__tests__/bt-ui-state.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  PASS  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  globalThis.document = { getElementById: () => null, querySelector: () => null, scrollingElement: null, body: {} };
  const UI = require('../bittorrent-ui.js');
  const mk = () => ({ caseId: 'c1', caseNumber: 'C-1', imports: [{ id: 'a', summary: {} }, { id: 'b', summary: {} }, { id: 'c', summary: {} }], verifyJob: null });

  // ── sections: closed by default, open ones remembered
  let mod = mk();
  let ui = new UI('x', mod);
  eq(ui.selectedId, 'c', 'no saved state: newest download selected');
  const sec = ui._section('files', 'Files', '<div id="btt-files"></div>');
  ok(/^<details class="btt-sec" data-sec="files">/.test(sec) && !/ open/.test(sec.split('>')[0]), 'section starts collapsed');
  ok(/data-act="sec"/.test(sec) && /btt-sec-btn/.test(sec), 'summary is the Expand/Collapse button');
  const det = { open: true, isConnected: true };
  ui._viewMode = () => 'table';
  ui._onSectionToggle('files', det);
  ui._onSectionToggle('events', { open: true, isConnected: true });
  await wait(5);
  ok(/ open>/.test(ui._section('files', 'Files', '').split('\n')[0]), 'opened section renders open next time');
  ui._onSectionToggle('events', { open: false, isConnected: true });
  await wait(5);
  ok(!ui.state.open.events && ui.state.open.files, 'closing removes it from state');

  // ── selection + per-download file filters
  ui.selectedId = 'a'; ui._rememberSelection();
  ui.fileView = { q: 'x'.repeat(300), status: 'media', page: 2 };
  ui._rememberFileView();
  ui.state.scroll = 640;
  ui.state.views.gone = { q: 'old', status: '', page: 0 };
  ui._writeState();
  await wait(200);
  const saved = JSON.parse(store.viperBtUi_c1);
  eq(saved.selectedId, 'a', 'selection saved per case');
  eq(saved.open, { files: true }, 'open sections saved');
  eq([saved.views.a.q.length, saved.views.a.status, saved.views.a.page], [200, 'media', 2], 'file search/filter/page saved (search capped)');
  ok(!saved.views.gone, 'views for removed downloads are pruned');
  eq(saved.scroll, 640, 'scroll saved');

  // ── new UI (VIPER restarted / case reopened) picks it back up
  const ui2 = new UI('x', mk());
  eq(ui2.selectedId, 'a', 'restored selection');
  eq(ui2._pendingScroll, 640, 'scroll queued to restore after the card draws');
  ok(ui2.state.open.files === true, 'restored open sections');
  const m3 = mk(); m3.imports = m3.imports.filter(x => x.id !== 'a');
  const ui3 = new UI('x', m3);
  eq(ui3.selectedId, 'c', 'saved download removed elsewhere → newest instead');
  ok(store.viperBtUi_other === undefined && new UI('x', Object.assign(mk(), { caseId: 'other' })).selectedId === 'c', 'state is per case');

  // ── grid thumbnails wait until Files is expanded
  const ui4 = new UI('x', mk());
  ui4.model = { files: [] };
  let queried = 0;
  const box = { closest: () => ({ open: false }), querySelectorAll: () => { queried++; return []; } };
  globalThis.document.getElementById = (k) => (k === 'btt-files' ? box : null);
  await ui4._hydrateGrid();
  eq(queried, 0, 'collapsed Files: no thumbnail work');
  box.closest = () => ({ open: true });
  await ui4._hydrateGrid();
  eq(queried, 1, 'expanded Files: thumbnails load');
  globalThis.document.getElementById = () => null;

  // ── Send to Notes
  globalThis.TdModel = { PLATFORM_LABELS: { windows: 'Windows', macos: 'macOS' }, clientsSeen: () => [
    { name: 'qBittorrent', version: '4.6.3', tag: '-qB4630-', handshakes: 4, dataSessions: 2, firstAt: '2026-09-15 14:02:12', firstRef: 'details.txt:10', code: 'qB', label: 'qBittorrent 4.6.3',
      profile: { kind: 'Free desktop program', platforms: ['windows', 'macos'], device: 'A computer <desktop>', look: ['BT_backup\\{hash}.torrent'] } },
    { name: 'uTorrent', handshakes: 1, dataSessions: 0, code: 'UT', label: 'µTorrent 3.5' }] };
  const imp = { id: 'a', ip: '203.0.113.77', port: 49152, location: 'US.NV.Sampletown', startedAt: '2026-09-15 14:00:00', gmtOffsetMin: -420,
    arin: { provider: 'Example ISP', org: 'Example Org', netRange: '203.0.113.0 - 203.0.113.255', country: 'US', lookedUpAt: '2026-10-23T10:00:00Z', ip: '203.0.113.77' } };
  const model = { download: { startedAt: '2026-09-15 14:00:00', gmtOffsetMin: -420 }, torrent: { name: 'Sample Set', infoHash: 'DC261E3E' }, sessions: [],
    investigator: { publicIps: [{ ip: '198.51.100.9', sessions: 4 }], lanIps: ['10.0.0.5'] } };
  const note = ui._section ? new UI('x', mk()).clientNoteHtml(imp, model) : '';
  ok(/203\.0\.113\.77:49152/.test(note) && /US\.NV\.Sampletown/.test(note), 'note: suspect IP:port + location');
  ok(/Example ISP · Example Org · 203\.0\.113\.0 - 203\.0\.113\.255 · US/.test(note), 'note: ARIN result');
  ok(/qBittorrent 4\.6\.3/.test(note) && /-qB4630- · 4 handshakes · 2 with data · first 2026-09-15 14:02:12 GMT-07:00 \(details\.txt:10\)/.test(note), 'note: software, peer ID, handshakes, first seen + log ref');
  ok(/Runs on:<\/b> Windows, macOS/.test(note) && /A computer &lt;desktop&gt;/.test(note), 'note: runs on + likely device (escaped)');
  ok(/<li>BT_backup\\dc261e3e\.torrent<\/li>/.test(note) && /The program itself/.test(note), 'note: warrant look-fors with the info hash filled in');
  ok(/2 different BitTorrent programs/.test(note) && /µTorrent 3\.5/.test(note), 'note: second program warning');
  ok(/self-reported and can be faked/.test(note), 'note: caveat included');
  ok(!/198\.51\.100\.9|10\.0\.0\.5/.test(note), 'note: no undercover / investigator IPs');
  globalThis.TdModel.clientsSeen = () => [];
  ok(/not identified — no handshake/.test(new UI('x', mk()).clientNoteHtml(imp, model)), 'note: no handshake → says so');
  const added = [];
  globalThis.viperAddCaseNote = (h, o) => { added.push([h, o]); return { saved: true }; };
  const toasts = [];
  const u5 = new UI('x', Object.assign(mk(), { imports: [imp], loadModel: async () => model }));
  u5._toast = (m, t) => toasts.push(t);
  await u5.sendToNotes('a');
  ok(added.length === 1 && added[0][1].source === 'BitTorrent' && /203\.0\.113\.77/.test(added[0][0]) && toasts[0] === 'success', 'Send to Notes files one Case Note and confirms');
  globalThis.viperAddCaseNote = () => ({ saved: false, reason: 'quota' });
  await u5.sendToNotes('a');
  eq(toasts[1], 'error', 'storage full → error toast');
  delete globalThis.viperAddCaseNote;
  ok(/data-act="notes"[^>]*>📝 Send to Notes/.test(u5._cardHeadHtml(imp)), 'header: Send to Notes button next to Send to Suspect');

  // ── source wiring
  const src = fs.readFileSync(path.join(__dirname, '..', 'bittorrent-ui.js'), 'utf8');
  for (const k of ['events', 'possession', 'sessions', 'files', 'report', 'netstat', 'logs']) ok(src.includes(`this._section('${k}'`), `section "${k}" is collapsible`);
  ok(/act === 'sec'/.test(src) && /act === 'secall'/.test(src), 'click handlers: section toggle + Expand all / Collapse all');
  ok(/'vproblems'[\s\S]{0,300}state\.open\.files = true/.test(src), '"Show them" opens the Files section');
  ok(/btt-file-q[\s\S]{0,120}_rememberFileView/.test(src) && /btt-file-status[\s\S]{0,120}_rememberFileView/.test(src) && /'fpage'[\s\S]{0,120}_rememberFileView/.test(src), 'search, filter and page changes are remembered');
  const css = fs.readFileSync(path.join(__dirname, '..', 'bittorrent-styles.css'), 'utf8');
  ok(/\.btt-sec-btn::after \{ content: 'Expand/.test(css) && /\.btt-sec\[open\] > \.btt-sec-title \.btt-sec-btn::after \{ content: 'Collapse/.test(css), 'Expand / Collapse button label');
  ok(/\.btt-sec-title::-webkit-details-marker \{ display: none/.test(css), 'default disclosure marker hidden');

  const cd = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html'), 'utf8');
  const init = cd.slice(cd.indexOf('function initializeBitTorrent()'), cd.indexOf('function initializeBitTorrent()') + 2000);
  ok(/prev\.caseId === String\(currentCase\.id\)/.test(init) && /prev\.ui\.resume\(\)/.test(init) && /return;/.test(init.split('destroy')[0]), 'tab shown again → same module/UI resumed (no re-import, jobs keep running)');
  ok(/if \(!prev\.job && !prev\.verifyJob\) prev\.loadData\(\)/.test(init), 'stored list re-read only when nothing is running');
  ok(cd.includes('bittorrent:      hasArr((_ls(`bittorrent_${caseId}`) || {}).imports)'), 'self-heal sees BitTorrent data ({imports:[]})');
  const fbd = cd.slice(cd.indexOf('async function _fileBitTorrentDownload'), cd.indexOf('async function _fileBitTorrentDownload') + 600);
  ok(!/bitTorrentModule = null/.test(fbd), 'Evidence → BitTorrent Download keeps the officer\'s place');
  const an = cd.slice(cd.indexOf('window.viperAddCaseNote = function'), cd.indexOf('window.viperAddCaseNote = function') + 1200);
  ok(/caseNotes\.push\(/.test(an) && /_persistCaseNotes\(\) === false\) \{ caseNotes = before;/.test(an) && /ensureCaseModule\('notes'\)/.test(an), 'case-detail: viperAddCaseNote saves to Case Notes, rolls back if storage refuses');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
