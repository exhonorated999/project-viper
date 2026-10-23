/**
 * Report blocks → Word (.docx), main process (modules/reports/blocks-docx.js),
 * fed with the BitTorrent tab's Download Summary blocks. Synthetic fixtures only.
 *
 * Run: node modules/reports/__tests__/blocks-docx.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const X = require('../blocks-docx');
const P = require('../../bittorrent/td-log-parser');
const FX = require('../../bittorrent/test_fixtures/td-fixtures');
const TM = require('../../bittorrent/td-model');
const R = require('../../bittorrent/bt-report');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) { if (cond) pass++; else { fail++; failures.push(name); } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-blocks-docx-'));
const clean = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} };
const ROOT = path.join(__dirname, '..', '..', '..');

async function unzip(buf) {
  const z = await JSZip.loadAsync(buf);
  const doc = await z.file('word/document.xml').async('string');
  const footers = await Promise.all(Object.keys(z.files).filter(n => /^word\/footer\d*\.xml$/.test(n)).map(n => z.file(n).async('string')));
  return { z, doc, footer: footers.join(''), names: Object.keys(z.files) };
}
/** Visible text of document.xml, runs joined. */
const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

(async () => {
  const inv = path.join(TMP, 'Investigations');
  const srcCase = FX.writeCase(inv, 'A', FX.td147({}), { netstat: FX.netstat('203.0.113.45', true) });
  const model = await P.parseTdDownload(srcCase);
  const got = model.files.filter(Boolean).filter(f => f.status === 'complete' || f.status === 'incomplete');
  const a = got[0].index, b = got[1].index;
  const UNDERCOVER = ((model.investigator && model.investigator.publicIps) || []).map(x => x.ip).concat(['192.168.1.20']);
  const imp = {
    id: model.id, ip: '203.0.113.45', location: 'US, CA, Testville',
    arin: { ip: '203.0.113.45', provider: 'Example ISP', org: 'EXAMPLE-ORG', country: 'US' },
    report: { items: { [a]: { description: 'Image of a red bicycle (synthetic).\nSecond line.' }, [b]: { description: '' } } }
  };
  const ctx = { caseNumber: 'C-100', caseName: 'Synthetic', officer: { who: 'Det. Test 123', agencyName: 'Test PD' }, appVersion: '5.4.9', generatedAt: '2026-03-04T12:00:00Z', TM,
    events: [{ at: model.download.startedAt, text: 'Download started', ref: 'summary.txt:1' }] };
  const blocks = R.reportBlocks(imp, model, ctx);
  const footerText = R.footerText(imp, model, ctx);

  const buf = await X.buildDocx(JSON.parse(JSON.stringify(blocks)), { footerText, title: 'BitTorrent Download Summary' });
  ok(Buffer.isBuffer(buf) && buf.slice(0, 2).toString() === 'PK', 'docx: a zip (Office Open XML)');
  fs.writeFileSync(path.join(TMP, 'out.docx'), buf);
  const u = await unzip(buf);
  const text = textOf(u.doc);
  ok(text.includes('Download Summary — BitTorrent (Torrential Downpour)'), 'docx: title');
  const heads = blocks.filter(x => x.k === 'h2').map(x => x.text);
  ok(heads.every(h => text.includes(h)), 'docx: every section heading');
  ok(heads.every(h => !/^\d+\./.test(h)) && !/\b[1-9]\. (Summary|Download details|Notes)/.test(text), 'docx: headings not numbered');
  ok((u.doc.match(/<w:pStyle w:val="Heading2"\/>/g) || []).length === heads.length, 'docx: real Word Heading 2 (navigation pane)');
  ok(text.includes('203.0.113.45') && text.includes('Example ISP') && text.includes('Det. Test 123, Test PD'), 'docx: suspect IP, ARIN, officer');
  ok(text.includes('Image of a red bicycle (synthetic).') && text.includes('Second line.') && text.includes('(No description entered.)'), 'docx: descriptions, line breaks kept, placeholder');
  ok(sel(blocks).every(t => text.includes(t)), 'docx: each picked file block');
  ok(UNDERCOVER.every(ip => !u.doc.includes(ip) && !u.footer.includes(ip)), 'docx: no undercover address');
  ok(!u.names.some(n => /^word\/media\//.test(n)) && !/<w:drawing|<pic:|<v:imagedata/.test(u.doc), 'docx: no images of any kind');
  ok(/<w:tbl>/.test(u.doc) && /<w:tblHeader\/>/.test(u.doc), 'docx: tables, event table header repeats on each page');
  ok(/<w:numPr>/.test(u.doc), 'docx: Notes are a bulleted list');
  ok(u.footer.includes('Case C-100 · BitTorrent Download Summary · 203.0.113.45') && /PAGE/.test(u.footer) && /NUMPAGES/.test(u.footer), 'docx: footer with case, IP and Page n of N');
  ok(/<w:pgSz w:w="12240" w:h="15840"/.test(u.doc), 'docx: Letter paper');

  // untrusted text: escaped, XML-illegal characters removed
  const evil = await X.buildDocx([{ k: 'p', runs: ['<w:t>x</w:t> & "q"\u0000\u0007\uD800 ok'] }, { k: 'file', title: 'File #1 — <img src=x>.jpg', lines: [], desc: '</w:p><script>' }], {});
  const ue = await unzip(evil);
  ok(!ue.doc.includes('<w:t>x</w:t> &') && textOf(ue.doc).includes('<w:t>x</w:t> & "q" ok') && !/[\u0000\u0007]/.test(ue.doc), 'docx: markup escaped, control characters dropped');
  ok(textOf(ue.doc).includes('<img src=x>.jpg') && textOf(ue.doc).includes('</w:p><script>'), 'docx: file names / descriptions are text, not markup');
  ok(X.cleanText('a\uDC00b\uD83D\uDE00c') === 'ab\uD83D\uDE00c', 'cleanText: lone surrogate dropped, pairs kept');

  // bad input
  const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };
  ok(await rejects(X.buildDocx(null), /nothing to put/i) && await rejects(X.buildDocx([]), /nothing to put/i), 'docx: no blocks refused');
  ok(await rejects(X.buildDocx([{ k: 'image', src: 'x' }, null, 5]), /nothing to put/i), 'docx: unknown blocks skipped (an image block is never drawn)');
  ok(await rejects(X.buildDocx(new Array(20001).fill({ k: 'p', runs: ['x'] })), /too large/i), 'docx: block count capped');
  ok(await rejects(X.buildDocx([{ k: 'p', runs: ['x'.repeat(4 * 1024 * 1024 + 1)] }]), /too large/i), 'docx: text size capped');
  const plain = await unzip(await X.buildDocx([{ k: 'h2', text: 'Only' }], {}));
  ok(/PAGE/.test(plain.footer) && !/Case /.test(plain.footer), 'docx: footer still has page numbers without footer text');

  // wiring: main IPC + preload
  const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
  const i = main.indexOf("ipcMain.handle('report-doc-from-blocks'");
  const handler = i > 0 ? main.slice(i, i + 900) : '';
  ok(/require\('\.\/modules\/reports\/blocks-docx'\)\.buildDocx/.test(handler) && /_reportDocs\(\)\.addBuffer\(caseNumber, name, buf\)/.test(handler), 'main: report-doc-from-blocks builds + saves via the Reports Word manager');
  ok(/withExt\(WorkingDocsLib\.cleanName\(newName\), '\.docx'\)/.test(handler) && /_wdFail\(e\)/.test(handler), 'main: name cleaned, failures reported');
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  ok(/reportDocFromBlocks: \(caseNumber, newName, blocks, opts\) => ipcRenderer\.invoke\('report-doc-from-blocks'/.test(pre), 'preload: reportDocFromBlocks');
  const vp = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-package.js'), 'utf8');
  ok(/blocks-docx\.js/.test(vp), 'verify-package: blocks-docx spot-check');

  // Reports tab: hint in the VIPER-editor view + invalidate()
  const UI = require('../word-report-ui');
  let fmt = 'viper';
  const listCalls = [];
  UI.configure({ getCaseNumber: () => 'C-100', getFormat: () => fmt, api: { reportDocsList: async (cn) => { listCalls.push(cn); return { success: true, docs: [{ fileName: 'BitTorrent Download Summary - 203.0.113.45 - 2026-03-02.docx' }] }; } } });
  ok(/id="wrWordHint"/.test(UI.renderModeSwitch()), 'reports: hint slot in the VIPER-editor view');
  await UI.refresh();
  ok(/1 Word report saved in this case/.test(UI.renderModeSwitch()), 'reports: hint counts Word reports');
  fmt = 'word';
  ok(!/wrWordHint/.test(UI.renderModeSwitch()), 'reports: no hint in the Word view (the list is right there)');
  ok(typeof UI.invalidate === 'function', 'reports: invalidate exported');
  UI.invalidate();
  ok(UI._state().loadedFor === null, 'reports: invalidate forces a re-read');

  clean();
  failures.forEach(x => console.log('FAIL', x));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { clean(); console.log('CRASH', e.stack); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

function sel(blocks) { return blocks.filter(x => x.k === 'file').map(x => x.title); }
