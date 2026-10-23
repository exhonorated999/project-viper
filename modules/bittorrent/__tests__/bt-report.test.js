/**
 * BitTorrent tab — Phase 5 outputs: Download Summary (HTML → PDF), hash list
 * CSV, Probable Cause paragraph for Warrant Author, report picks in the
 * module and UI. Synthetic fixtures only.
 *
 * Run: node modules/bittorrent/__tests__/bt-report.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const P = require('../td-log-parser');
const FX = require('../test_fixtures/td-fixtures');
const TM = require('../td-model');
const R = require('../bt-report');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) { if (cond) pass++; else { fail++; failures.push(name); } }
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; failures.push(`${name}: got ${g} want ${w}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-bt-rpt-'));
const clean = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };

/** Minimal RFC 4180 reader (quotes, doubled quotes, CRLF). */
function parseCsv(s) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* CRLF */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

(async () => {
  const inv = path.join(TMP, 'Investigations');
  const srcCase = FX.writeCase(inv, 'A', FX.td147({}), { netstat: FX.netstat('203.0.113.45', true) });
  const model = await P.parseTdDownload(srcCase);
  const files = model.files.filter(Boolean);
  const got = files.filter(f => f.status === 'complete' || f.status === 'incomplete');
  ok(got.length >= 2, 'fixture: at least two downloaded files');

  // Undercover infrastructure that must never be written: the investigator's
  // public IP the suspect saw (yourip) and the LAN side of netstat.
  const ours = ((model.investigator && model.investigator.publicIps) || []).map(x => x.ip);
  ok(ours.includes('198.51.100.7'), 'fixture: investigator public IP is in the parsed model');
  const UNDERCOVER = ours.concat(['192.168.1.20']);
  const nsText = fs.readFileSync(path.join(srcCase, 'Logs', 'netstat.txt'), 'utf8');
  ok(nsText.includes('192.168.1.20'), 'fixture: netstat has the investigator LAN address');

  // ── report picks: one with a description, one without, one unknown index
  const a = got[0].index, b = got[1].index;
  const imp = {
    id: model.id, ip: '203.0.113.45', port: model.summary && model.summary.port, location: 'US, CA, Testville',
    arin: { ip: '203.0.113.45', provider: 'Example ISP', org: 'EXAMPLE-ORG', netRange: '203.0.113.0 - 203.0.113.255', country: 'US', lookedUpAt: '2026-03-03T10:00:00Z' },
    report: { items: { [a]: { description: '  Image of a red bicycle (synthetic).  ' }, [b]: { description: '' }, 9999: { description: 'ghost' } } }
  };
  const sel = R.selectedFiles(imp, model);
  eq(sel.map(x => x.index), [a, b].sort((x, y) => x - y), 'selectedFiles: picked files only, index order, unknown index dropped');
  eq(sel.find(x => x.index === a).description, 'Image of a red bicycle (synthetic).', 'selectedFiles: description trimmed');
  eq(R.missingDescriptions(imp, model), 1, 'missingDescriptions counts empty ones');

  const ui0 = { events: [{ at: model.download.startedAt, text: 'Download started', ref: 'summary.txt:1' }] };
  const html = R.reportHtml(imp, model, Object.assign({ caseNumber: 'C-100', caseName: 'Synthetic', officer: { who: 'Det. Test 123', agencyName: 'Test PD' }, appVersion: '5.4.9', generatedAt: '2026-03-04T12:00:00Z', TM }, ui0));
  ok(/^<!DOCTYPE html>/.test(html) && /Download Summary — BitTorrent \(Torrential Downpour\)/.test(html), 'html: title');
  ok(html.includes('This report contains no images or video'), 'html: no-media notice');
  ok(!/<img|<video|<source|data:image|file:\/\/|viper-media:/i.test(html), 'html: no media of any kind');
  UNDERCOVER.forEach(ip => ok(!html.includes(ip), `html: undercover address ${ip.replace(/\d+$/, 'x')} absent`));
  ok(html.includes('203.0.113.45'), 'html: suspect IP present');
  ok(html.includes('Det. Test 123, Test PD') && html.includes('Case C-100') && html.includes('V.I.P.E.R. 5.4.9'), 'html: case, officer, version');
  ok(/Internet provider \(ARIN\)/.test(html) && html.includes('Example ISP'), 'html: ARIN section when looked up');
  ok(!/Internet provider \(ARIN\)/.test(R.reportHtml(Object.assign({}, imp, { arin: null }), model, { TM })), 'html: no ARIN section when never looked up');
  ok(html.includes('Image of a red bicycle (synthetic).') && html.includes('(No description entered.)'), 'html: descriptions + placeholder');
  const baseOf = (f) => String(f.path || f.name).split(/[\\/]/).pop();
  const notPicked = files.filter(f => f.index !== a && f.index !== b);
  ok(sel.every(x => html.includes(`File #${x.index} — `)), 'html: each picked file has its block');
  ok(notPicked.every(f => !html.includes(`File #${f.index} — `)), 'html: files not picked are not listed');
  ok(!html.includes('ghost'), 'html: unknown index never rendered');
  ok(/Netstat corroboration/.test(html) && /recorded \d+ netstat snapshot/.test(html), 'html: netstat described without addresses');
  ok(!/sha-?256/i.test(html), 'html: no source-log SHA-256 section');
  ok(!/ICACCops data or training material\./.test(html.replace('It contains no images, video, ICACCops data or training material.', '')), 'html: ICACCops only mentioned as excluded');
  const heads = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(m => m[1]);
  ok(heads.length >= 6 && heads[0] === 'Summary' && heads.includes('Download details') && heads[heads.length - 1] === 'Notes', 'html: section headings present');
  ok(heads.every(t => !/^\s*\d+\s*[.)]/.test(t)), 'html: section headings are not numbered');
  // PDF and Word come from the same blocks
  const blocks = R.reportBlocks(imp, model, Object.assign({ caseNumber: 'C-100', generatedAt: '2026-03-04T12:00:00Z', TM }, ui0));
  ok(Array.isArray(blocks) && JSON.parse(JSON.stringify(blocks)).length === blocks.length, 'blocks: plain JSON (crosses IPC)');
  eq(blocks.filter(b => b.k === 'h2').map(b => b.text), heads, 'blocks: same headings as the PDF');
  const bj = JSON.stringify(blocks);
  ok(UNDERCOVER.every(ip => !bj.includes(ip)) && bj.includes('203.0.113.45') && bj.includes('Image of a red bicycle (synthetic).'), 'blocks: suspect IP + descriptions, no undercover address');
  ok(!/<img|<video|data:image|viper-media:/i.test(bj) && !blocks.some(b => /image|media|picture/i.test(b.k)), 'blocks: no media block of any kind');
  eq(R.fileName({ ip: '203.0.113.45' }, 'docx', { download: { startedAt: '2026-03-02 21:15:10' } }), 'BitTorrent Download Summary - 203.0.113.45 - 2026-03-02.docx', 'fileName docx');
  const ft = R.footerText(imp, model, { caseNumber: 'C-100', generatedAt: '2026-03-04T12:00:00Z' });
  ok(/^Case C-100 · BitTorrent Download Summary · 203\.0\.113\.45 · generated /.test(ft), 'footerText: case, title, suspect IP');
  ok(UNDERCOVER.every(ip => !ft.includes(ip)) && ft.length < 300, 'footerText: no undercover address, fits main 300-char cap');
  ok(html.includes('— End of report —'), 'html: end-of-report line');

  // keyEvents straight from the UI never carry undercover addresses
  const vmUi = { module: { exports: {} }, console, JSON, Date, Math, Promise, Array, Object, String, Number, Set, Map, Error };
  vmUi.window = vmUi; vm.createContext(vmUi);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'td-model.js'), 'utf8'), vmUi);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'bittorrent-ui.js'), 'utf8'), vmUi);
  const uiK = Object.create(vmUi.BitTorrentUI.prototype);
  const events = uiK.keyEvents(model);
  const html2 = R.reportHtml(imp, model, { events, TM });
  ok(events.length > 3 && UNDERCOVER.every(ip => !html2.includes(ip)), 'html: full key-event table, still no undercover address');

  // escaping: suspect-controlled names + officer text
  const evil = JSON.parse(JSON.stringify(model));
  const ef = evil.files.find(f => f.index === a);
  ef.path = 'dir/<img src=x onerror=alert(1)>.jpg';
  const impE = Object.assign({}, imp, { report: { items: { [a]: { description: '</div><script>alert(2)</script>' } } } });
  const he = R.reportHtml(impE, evil, { TM });
  ok(!/<img src=x|<script>alert/.test(he) && he.includes('&lt;img src=x onerror=alert(1)&gt;.jpg') && he.includes('&lt;/div&gt;&lt;script&gt;'), 'html: file names and descriptions escaped');

  // ── hash CSV: every file, BOM, CRLF, 12 columns, injection guard
  const csv = R.hashCsv(imp, model);
  ok(csv.charCodeAt(0) === 0xfeff && /\r\n$/.test(csv), 'csv: BOM + CRLF');
  const rows = parseCsv(csv.slice(1));
  eq(rows[0].length, 12, 'csv: 12 columns');
  ok(rows.every(r => r.length === 12), 'csv: every row has 12 cells');
  eq(rows.length - 1, files.length, 'csv: one row per torrent file (not just the picked ones)');
  const rowA = rows.find(r => r[0] === String(a));
  ok(rowA && rowA[10] === 'yes' && rowA[11] === 'Image of a red bicycle (synthetic).', 'csv: In report + description');
  ok(rowA && rowA[6] === files.find(f => f.index === a).sha1, 'csv: SHA-1');
  UNDERCOVER.forEach(ip => ok(!csv.includes(ip), `csv: undercover address ${ip.replace(/\d+$/, 'x')} absent`));
  const inj = JSON.parse(JSON.stringify(model));
  inj.files[0].path = '=HYPERLINK("x","y")';
  const ir = parseCsv(R.hashCsv({}, inj).slice(1)).find(r => r[0] === String(inj.files[0].index));
  ok(ir[1].startsWith("'=") && ir[2].startsWith("'="), 'csv: formula injection guarded');
  eq(['=1', '+1', '-1', '@x', 'a,b', 'q"q'].map(R.csvCell), ["'=1", "'+1", "'-1", "'@x", '"a,b"', '"q""q"'], 'csvCell');
  const vm2 = JSON.parse(JSON.stringify(model));
  vm2.verify = { withHash: 2, matched: 1, mismatched: [b], missing: [], unreadable: [] };
  const vr = parseCsv(R.hashCsv(imp, vm2).slice(1));
  ok(vr.find(r => r[0] === String(b))[9] === 'does NOT match the TD log' && vr.find(r => r[0] === String(a))[9] === 'matches the TD log', 'csv: VIPER hash check in words');

  // ── file names
  eq(R.fileName({ ip: '203.0.113.45' }, 'pdf', { download: { startedAt: '2026-03-02 21:15:10' } }), 'BitTorrent Download Summary - 203.0.113.45 - 2026-03-02.pdf', 'fileName pdf');
  eq(R.fileName({ ip: '2001:db8::1' }, 'csv', {}), 'BitTorrent Hash List - 2001-db8--1 - undated.csv', 'fileName csv: IPv6 colons made Windows-safe');
  ok(!/[:<>"|?*\\/]/.test(R.fileName({ ip: 'a/b\\c:d*e?"<>|' }, 'pdf', {})), 'fileName: no illegal characters');

  // ── dates are string-based (no DST / time-zone drift)
  eq([R.fmtDate('2026-11-01 01:30:00'), R.fmtTime('2026-11-01 01:30:00'), R.fmtTime('2026-03-08 12:05'), R.fmtTime('2026-03-08 00:00:09')],
    ['November 1, 2026', '1:30:00 AM', '12:05 PM', '12:00:09 AM'], 'fmtDate/fmtTime');
  eq([R.utcLabel(-420), R.utcLabel(330), R.utcLabel(0), R.utcLabel(null)], ['UTC−07:00', 'UTC+05:30', 'UTC+00:00', ''], 'utcLabel');
  eq([R.spellDuration(0), R.spellDuration(61), R.spellDuration(3725)], ['0 seconds', '1 minute and 1 second', '1 hour, 2 minutes and 5 seconds'], 'spellDuration');

  // ── PC paragraph
  const pc = R.pcParagraph(imp, model, { TM });
  ok(/^On [A-Z][a-z]+ \d{1,2}, \d{4}, I utilized a law enforcement BitTorrent investigative tool designed to download data exclusively from a single target Internet Protocol \(IP\) address\./.test(pc), 'pc: first-person opening (tool + configuration)');
  ok(/not from any other BitTorrent peer participating in the torrent swarm\./.test(pc), 'pc: single-source configuration sentence');
  ok(/\n\nUsing this tool, I established a direct connection with a device utilizing IP address 203\.0\.113\.45 on port \d+ that was advertising/.test(pc), 'pc: connection paragraph');
  ok(pc.includes(FX.IH) || pc.toUpperCase().includes(String(FX.IH).toUpperCase()), 'pc: info hash');
  ok(/I downloaded [\d,]+ torrent pieces? directly from the device at IP address 203\.0\.113\.45\./.test(pc), 'pc: pieces downloaded');
  ok(pc.includes('No portion of the downloaded data was obtained from any other device or peer on the BitTorrent network.'), 'pc: exclusivity sentence');
  ok(/The downloaded pieces reconstructed .* contained within the torrent\./.test(pc), 'pc: files reconstructed');
  ok(pc.includes('A query of the American Registry for Internet Numbers (ARIN) showed that IP address 203.0.113.45 is registered to Example ISP.'), 'pc: ARIN sentence');
  ok(/\n\nI subsequently reviewed the recovered files and observed(, among others| the following):/.test(pc), 'pc: reviewed-files lead-in');
  ok(pc.includes(`\n\n"${baseOf(files.find(f => f.index === a))}"`) && pc.includes(', image of a red bicycle (synthetic).') && pc.includes('[description not entered].'), 'pc: picked files with descriptions / placeholder');
  ok(/\n\nBased on the direct connection to IP address 203\.0\.113\.45, the exclusive download of torrent pieces from that IP address, .*my review of the reconstructed files, I determined that the device associated with IP address 203\.0\.113\.45 was actively offering and distributing files/.test(pc), 'pc: conclusion with grounds');
  ok(UNDERCOVER.every(ip => !pc.includes(ip)), 'pc: no undercover address');
  const pcNo = R.pcParagraph(Object.assign({}, imp, { arin: null, report: null }), model, { TM });
  ok(!/ARIN|I subsequently reviewed|my review of/.test(pcNo), 'pc: no ARIN / no file list / no review ground when absent');
  ok(/Based on .* I determined/.test(pcNo), 'pc: conclusion still present without picks');
  const failModel = JSON.parse(JSON.stringify(model));
  failModel.sessions = []; failModel.summary = Object.assign({}, failModel.summary, { connected: 0, handshakes: 0, piecesWritten: 0, piecesDownloaded: 0, attempts: 3 });
  const pcFail = R.pcParagraph({ ip: '203.0.113.45' }, failModel, { TM });
  ok(/I attempted to establish a direct connection/.test(pcFail) && /None of the 3 connection attempts succeeded\./.test(pcFail) && !/I determined|I downloaded/.test(pcFail), 'pc: failed connection asserts nothing more');
  const sum = R.summaryParagraph(R.facts(imp, model, { TM }));
  ok(/connected directly to a BitTorrent client at 203\.0\.113\.45/.test(sum) && /single source/.test(sum), 'summary: single-source account');

  // ── renderer module in a sandbox: picks, outputs, Warrant Author
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const saved = []; let pdfReq = null, refreshed = 0;
  const api = {
    btRead: async (d) => ({ success: d.downloadId === model.id, model }),
    getAppVersion: async () => '5.4.9',
    saveHtmlAsPdf: async (d) => { pdfReq = d; return { success: true, base64: Buffer.from('%PDF-1.4 synthetic').toString('base64') }; },
    saveEvidenceFile: async (d) => { saved.push(d); return path.join(TMP, 'cases', d.caseNumber, 'Evidence', d.evidenceTag, d.fileName); }
  };
  let pcBody = 'Existing PC text.'; const pcCalls = [];
  const sb = {
    module: { exports: {} }, localStorage: ls, console, JSON, Date, Math, Promise, Array, Object, String, Number, Set, Map, Error,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder,
    WarrantAuthorCasePcStore: { getBody: (id) => (id === '77' ? pcBody : ''), setBody: (id, body, o) => { pcCalls.push([id, o && o.label]); pcBody = body; } }
  };
  sb.window = sb; sb.electronAPI = api; sb.refreshCaseEvidenceFromStorage = () => { refreshed++; };
  vm.createContext(sb);
  for (const f of ['td-model.js', 'bt-report.js', 'bittorrent-module.js', 'bittorrent-ui.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb);
  ok(typeof sb.BtReport === 'object' && typeof sb.BtReport.reportHtml === 'function', 'renderer: window.BtReport defined');
  store.bittorrent_77 = JSON.stringify({ imports: [{ id: model.id, ip: '203.0.113.45', arin: imp.arin }] });
  store.viperAgencyProfile = JSON.stringify({ affiantName: 'Pat Test', affiantRank: 'Det.', affiantBadge: '#123', agencyName: 'Test PD' });
  const mod = new sb.BitTorrentModule('77', 'C-100', 'Synthetic');
  mod.loadData();
  ok(mod.setInReport(model.id, a, true) && mod.isInReport(model.id, a), 'module: add to report');
  ok(!mod.setInReport(model.id, -1, true) && !mod.setInReport(model.id, 1.5, true) && !mod.setInReport('nope', a, true), 'module: bad index / unknown download refused');
  mod.setInReport(model.id, b, true);
  ok(mod.setReportDescription(model.id, a, 'Picture (synthetic).'), 'module: description saved');
  ok(!mod.setReportDescription(model.id, 12345, 'x'), 'module: description refused for a file not in the report');
  mod.setReportDescription(model.id, b, 'x'.repeat(5000));
  const persisted = JSON.parse(store.bittorrent_77).imports[0].report.items;
  eq([persisted[a].description, persisted[b].description.length], ['Picture (synthetic).', 4000], 'module: persisted, capped at 4000');
  mod.setInReport(model.id, b, false);
  ok(!mod.isInReport(model.id, b) && !(b in JSON.parse(store.bittorrent_77).imports[0].report.items), 'module: remove from report');
  eq(mod.officer(), { who: 'Det. Pat Test #123', agencyName: 'Test PD' }, 'module: officer from the Warrant Author profile');

  const out = await mod.exportSummaryPdf(model.id, { events: [] });
  ok(pdfReq && pdfReq.returnBase64 === true && /Picture \(synthetic\)\./.test(pdfReq.html) && UNDERCOVER.every(ip => !pdfReq.html.includes(ip)), 'module pdf: HTML built from the report picks');
  ok(pdfReq && /^Case .* · BitTorrent Download Summary · /.test(pdfReq.options && pdfReq.options.footerText || ''), 'module pdf: per-page footer text passed to main');
  ok(saved[0].evidenceTag === 'BitTorrent Reports' && /^BitTorrent Download Summary - 203\.0\.113\.45 - \d{4}-\d{2}-\d{2} \(made \d{4}-\d{2}-\d{2} \d{6}\)\.pdf$/.test(saved[0].fileName), 'module pdf: saved under BitTorrent Reports with a made-stamp');
  ok(Buffer.from(saved[0].fileData).toString() === '%PDF-1.4 synthetic' && out.name === saved[0].fileName, 'module pdf: base64 decoded to bytes');
  const csvOut = await mod.exportHashCsv(model.id);
  ok(/\.csv$/.test(csvOut.name) && Buffer.from(saved[1].fileData).toString('utf8').includes('Index,File name'), 'module csv: saved');
  const evs = JSON.parse(store.viperCaseEvidence)['C-100'];
  ok(evs.length === 2 && evs.every(e => e.tag === 'BitTorrent Reports' && e.metadata.kind === 'bittorrent-report' && e.metadata.downloadId === model.id && e.source === 'BitTorrent tab'), 'module: both outputs listed on the Evidence tab');
  ok(evs[0].files[0].type === 'application/pdf' && evs[1].files[0].type === 'text/csv' && refreshed === 2, 'module: mime + Evidence refreshed');

  // ── Word report: blocks to main, saved in the Reports tab (not Evidence)
  let docxReq = null, invalidated = 0;
  sb.WordReportUI = { invalidate: () => { invalidated++; } };
  api.reportDocFromBlocks = async (cn, name, blocks, o) => { docxReq = { cn, name, blocks, o }; return { success: true, fileName: name.replace(/\.docx$/, ' (2).docx') }; };
  const savedBefore = saved.length;
  const dOut = await mod.exportSummaryDocx(model.id, { events: [] });
  ok(docxReq && docxReq.cn === 'C-100' && /^BitTorrent Download Summary - 203\.0\.113\.45 - \d{4}-\d{2}-\d{2}\.docx$/.test(docxReq.name), 'module docx: case number + .docx name');
  ok(docxReq && Array.isArray(docxReq.blocks) && JSON.stringify(docxReq.blocks).includes('Picture (synthetic).') && UNDERCOVER.every(ip => !JSON.stringify(docxReq.blocks).includes(ip)), 'module docx: blocks from the report picks, no undercover address');
  ok(docxReq && /^Case C-100 · BitTorrent Download Summary · /.test(docxReq.o.footerText) && docxReq.o.title === 'BitTorrent Download Summary', 'module docx: footer + title');
  ok(dOut.fileName === docxReq.name.replace(/\.docx$/, ' (2).docx') && saved.length === savedBefore && invalidated === 1, 'module docx: main\'s final name returned, nothing put in Evidence, Reports list invalidated');
  api.reportDocFromBlocks = async () => ({ success: false, error: 'disk full (synthetic)' });
  let derr = null; try { await mod.exportSummaryDocx(model.id, {}); } catch (e) { derr = e; }
  ok(derr && /disk full/.test(derr.message), 'module docx: main error surfaces');
  const keepFn = api.reportDocFromBlocks; delete api.reportDocFromBlocks;
  derr = null; try { await mod.exportSummaryDocx(model.id, {}); } catch (e) { derr = e; }
  ok(derr && /desktop app/.test(derr.message), 'module docx: old preload → clear message');
  api.reportDocFromBlocks = async () => { throw new Error("Error invoking remote method 'report-doc-from-blocks': Error: No handler registered for 'report-doc-from-blocks'"); };
  derr = null; try { await mod.exportSummaryDocx(model.id, {}); } catch (e) { derr = e; }
  ok(derr && /needs a restart/.test(derr.message) && !/remote method/.test(derr.message), 'module docx: old main process → restart message');
  api.reportDocFromBlocks = keepFn;
  api.reportDocOpen = async (cn, fn) => ({ success: cn === 'C-100' && fn === 'x.docx' });
  ok((await mod.openReportDoc('x.docx')).success === true, 'module docx: openReportDoc passes case + file');

  const para = await mod.pcParagraph(model.id);
  ok(para.includes(', picture (synthetic).'), 'module: PC paragraph uses the saved picks');
  eq(mod.sendToWarrantAuthor(model.id, para), { appended: true }, 'warrant author: appended');
  ok(pcBody === 'Existing PC text.\n\n' + para.trim() && pcCalls[0][0] === '77' && pcCalls[0][1] === 'BitTorrent download 203.0.113.45', 'warrant author: appended after existing PC, labelled');
  eq(mod.sendToWarrantAuthor(model.id, para), { already: true }, 'warrant author: second send is a no-op');
  eq(pcCalls.length, 1, 'warrant author: not written twice');
  let werr = null; try { mod.sendToWarrantAuthor(model.id, '   '); } catch (e) { werr = e; }
  ok(werr && /Nothing to send/.test(werr.message), 'warrant author: empty text refused');

  // ── UI pieces
  const ui = Object.create(sb.BitTorrentUI.prototype);
  ui.module = mod; ui.selectedId = model.id; ui.model = model; ui.media = { onDisk: { [a]: {} } };
  ui.fileView = { q: '', status: 'report' };
  eq(ui._filteredFiles().map(f => f.index), [a], 'ui: "In report" filter');
  const fa = files.find(f => f.index === a);
  ok(/data-act="rpt"/.test(ui._reportToggleHtml(fa)) && /✓ In report/.test(ui._reportToggleHtml(fa)), 'ui: toggle shows In report');
  ok(/＋ Report/.test(ui._reportToggleHtml(files.find(f => f.index === b))), 'ui: toggle offers ＋ Report');
  const none = files.find(f => f.status === 'none');
  if (none) ok(ui._reportToggleHtml(none) === '', 'ui: never-downloaded file cannot go in the report');
  const rh = ui._reportHtml();
  ok(/data-act="rpdf"/.test(rh) && /data-act="rdocx"/.test(rh) && /data-act="rcsv"/.test(rh) && /data-act="rwa"/.test(rh), 'ui: four output buttons (PDF, Word, CSV, Warrant Author)');
  ok(/Word report \(editable\)/.test(rh) && /Reports tab/.test(rh), 'ui: Word button + help says where it goes');
  ok(new RegExp(`data-rdesc="${a}"`).test(rh) && rh.includes('Picture (synthetic).'), 'ui: description box with saved text');
  ok(/data-act="rview"/.test(rh), 'ui: View for a file on disk');
  ui._outBusy = true; ui._outLabel = '📄 Making PDF…';
  ok((ui._reportHtml().match(/disabled/g) || []).length === 4 && ui._reportHtml().includes('Making PDF'), 'ui: buttons disabled + label while busy');
  ui._outBusy = false;
  // exportDocx: makes it, then opens it in Word; an open failure still says it is saved
  const toasts = []; const opened = [];
  ui._toast = (m, t) => toasts.push([m, t]); ui._confirm = async () => true; ui._refreshReport = () => {};
  ui.keyEvents = () => [];
  api.reportDocFromBlocks = async (cn, name) => ({ success: true, fileName: name });
  api.reportDocOpen = async (cn, fn) => { opened.push(fn); return { success: false, error: 'no Word (synthetic)' }; };
  await ui.exportDocx();
  ok(opened.length === 1 && /\.docx$/.test(opened[0]), 'ui docx: opens the new report in Word');
  ok(toasts.some(t => t[1] === 'success' && /Reports tab/.test(t[0])) && toasts.some(t => t[1] === 'error' && /saved in the Reports tab, but it could not be opened: no Word/.test(t[0])), 'ui docx: success toast + open-failure toast');
  ok(/act === 'rdocx'\) return this\.exportDocx\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'bittorrent-ui.js'), 'utf8')), 'ui: rdocx click wired');

  // ── wiring
  const page = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html'), 'utf8');
  const iR = page.indexOf('modules/bittorrent/bt-report.js'), iM = page.indexOf('modules/bittorrent/bittorrent-module.js');
  ok(iR > 0 && iR < iM, 'page: bt-report.js loads before bittorrent-module.js');
  const css = fs.readFileSync(path.join(__dirname, '..', 'bittorrent-styles.css'), 'utf8');
  ok(['.btt-report-bar', '.btt-rpt-item', '.btt-rpt-desc', '.btt-vw-report'].every(c => css.includes(c)), 'css: report styles');

  clean();
  failures.forEach(x => console.log('FAIL', x));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clean(); console.log('CRASH', e.stack); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
