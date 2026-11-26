'use strict';
// Tests for the Intake / Discovery Checklist (modules/prosecution). SYNTHETIC data only.
// Run: node modules/prosecution/__tests__/intake-checklist.test.js
const IC = require('../intake-checklist.js');
const UI = require('../intake-checklist-ui.js');
const P = require('../intake-pdf.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
const NOW = new Date('2026-03-04T10:00:00Z');

(async () => {
  // ---- Schema ------------------------------------------------------------------------------
  const ids = [];
  IC.SECTIONS.forEach(s => s.items.forEach(i => ids.push(i.id)));
  eq(new Set(ids).size, ids.length, 'item ids unique');
  eq(ids.length, 34, 'item count');
  eq(IC.SECTIONS.filter(s => s.kind === 'check').map(s => s.id), ['general', 'reportsVideo'], 'check sections');
  eq(IC.STATUSES.map(s => s.label), ['N/A', 'In File', 'Requested', 'Other'], 'status labels');
  ok(Object.isFrozen(IC.SECTIONS) && Object.isFrozen(IC.SECTIONS[0].items[0]), 'schema frozen');
  // Generic wording: no state, statute or rule citations.
  ok(!/\b(rule|C\.R\.S|crim\.? ?p|statute|§|colorado)\b/i.test(IC.DISCOVERY_NOTE), 'discovery note cites no rules');
  ok(/exculpat|negate guilt/i.test(IC.DISCOVERY_NOTE) && /impeach/i.test(IC.DISCOVERY_NOTE), 'discovery note covers exculpatory + impeachment');

  // ---- create / normalize ------------------------------------------------------------------
  const c0 = IC.create({ defendants: 'Doe, Jane', agency: 'Sample City PD', agencyCaseNumber: '26-0001', junk: 'x' }, NOW);
  eq(c0.header, { defendants: 'Doe, Jane', agency: 'Sample City PD', agencyCaseNumber: '26-0001', assistingAgencies: '', caseNumbers: '' }, 'create header');
  eq([c0.version, c0.createdAt, c0.updatedAt, c0.notes, c0.lastExport], [1, NOW.toISOString(), NOW.toISOString(), '', null], 'create meta');
  eq([c0.checks, c0.statuses], [{}, {}], 'create empty');

  const dirty = IC.normalize({
    header: { defendants: 'A\nB  C', agency: 'x'.repeat(500), evil: '<script>' },
    checks: { witnessList: true, caseSummary: 'yes', bogus: true, photos: true },
    statuses: { photos: { status: 'in_file', detail: '  ' }, cadReport: { status: 'requested', detail: 'from\ndispatch' },
      courtOrders: { status: 'maybe' }, witnessList: { status: 'na' }, nope: { status: 'na' } },
    notes: 'line1\r\nline2\u0000',
    lastExport: { fileName: 'x.pdf', destination: 'weird', at: 'not a date' },
    extra: 1,
  }, NOW);
  eq(dirty.header.defendants, 'A B C', 'normalize: header one line');
  eq(dirty.header.agency.length, 160, 'normalize: header capped');
  ok(!('evil' in dirty.header) && !('extra' in dirty), 'normalize: unknown keys dropped');
  eq(dirty.checks, { witnessList: true }, 'normalize: only real check ids, only true');
  eq(dirty.statuses, { photos: { status: 'in_file' }, cadReport: { status: 'requested', detail: 'from dispatch' } }, 'normalize: statuses');
  eq(dirty.notes, 'line1\nline2', 'normalize: notes cleaned');
  eq(dirty.lastExport, { fileName: 'x.pdf', destination: 'case', at: NOW.toISOString() }, 'normalize: lastExport');
  eq(IC.normalize(null, NOW).header.defendants, '', 'normalize: null');
  eq(IC.normalize({ notes: 'n'.repeat(9000) }).notes.length, IC.LIMITS.notes, 'normalize: notes cap');

  // ---- edits -------------------------------------------------------------------------------
  const later = new Date('2026-03-05T10:00:00Z');
  let c = IC.setCheck(c0, 'witnessList', true, later);
  ok(c !== c0 && !c0.checks.witnessList, 'setCheck immutable');
  eq([c.checks.witnessList, c.updatedAt, c.createdAt], [true, later.toISOString(), NOW.toISOString()], 'setCheck');
  c = IC.setCheck(c, 'witnessList', false, later);
  eq(c.checks, {}, 'setCheck off');
  eq(IC.setCheck(c, 'photos', true, later).checks, {}, 'setCheck ignores status item');
  c = IC.setStatus(c, 'photos', 'other', later);
  c = IC.setDetail(c, 'photos', 'Partial set, rest pending', later);
  eq(c.statuses.photos, { status: 'other', detail: 'Partial set, rest pending' }, 'setStatus + setDetail');
  c = IC.setStatus(c, 'photos', 'requested', later);
  eq(c.statuses.photos, { status: 'requested', detail: 'Partial set, rest pending' }, 'status change keeps detail');
  eq(IC.setStatus(c, 'photos', '', later).statuses.photos, undefined, 'status cleared');
  eq(IC.setDetail(c0, 'cadReport', 'x', later).statuses.cadReport, { status: 'other', detail: 'x' }, 'detail on unset → other');
  eq(IC.setHeader(c, 'caseNumbers', '26CR1', later).header.caseNumbers, '26CR1', 'setHeader');
  eq(IC.setHeader(c, 'bogus', 'x', later).header.bogus, undefined, 'setHeader unknown');
  eq(IC.setNotes(c, 'hello', later).notes, 'hello', 'setNotes');
  eq(IC.setLastExport(c, { fileName: 'Intake Checklist - 2026-03-05.pdf', destination: 'case' }, later).lastExport,
    { fileName: 'Intake Checklist - 2026-03-05.pdf', destination: 'case', at: later.toISOString() }, 'setLastExport');

  // ---- progress / outstanding --------------------------------------------------------------
  eq(IC.progress(c0), { total: 34, done: 0, requested: 0, open: 34 }, 'progress empty');
  let pc = IC.setCheck(c0, 'witnessList', true);
  pc = IC.setStatus(pc, 'photos', 'in_file');
  pc = IC.setStatus(pc, 'call911', 'na');
  pc = IC.setStatus(pc, 'cadReport', 'other');
  pc = IC.setStatus(pc, 'radioTraffic', 'requested');
  pc = IC.setDetail(pc, 'radioTraffic', 'Asked dispatch 3/1');
  eq(IC.progress(pc), { total: 34, done: 4, requested: 1, open: 29 }, 'progress mixed');
  eq(IC.outstanding(pc), [{ section: 'Digital Evidence', id: 'radioTraffic', label: 'Radio traffic', detail: 'Asked dispatch 3/1' }], 'outstanding');
  eq(UI.progressText(pc), '4 of 34 complete · 1 requested · 29 open', 'progressText');

  // ---- names -------------------------------------------------------------------------------
  eq(IC.defendantNames([
    { firstName: 'Jane', lastName: 'Doe' },
    { name: 'John Q Public' },
    { name: 'Roe, Richard' },
    { lastName: 'Solo' },
    { name: '' }, null, 'x',
    { firstName: 'Jane', lastName: 'Doe' },
  ]), 'Doe, Jane; Public, John Q; Roe, Richard; Solo', 'defendantNames');
  eq(IC.defendantNames(null), '', 'defendantNames none');
  eq(IC.nameHint({ header: { defendants: 'Doe, Jane; Roe, Richard' } }), 'Doe', 'nameHint');
  eq(IC.nameHint({ header: { defendants: '' } }), '', 'nameHint empty');

  // ---- renderCard (escaping, states) ---------------------------------------------------------
  const empty = UI.renderCard(null);
  ok(/data-ic-act="add"/.test(empty) && /Add Intake Checklist/.test(empty), 'render: empty → add button');
  const x = IC.setStatus(IC.create({ defendants: '<img src=x onerror=alert(1)>' }), 'photos', 'requested');
  const html = UI.renderCard(IC.setNotes(x, '</textarea><b>'));
  ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'), 'render: header escaped');
  ok(!html.includes('</textarea><b>') && html.includes('&lt;/textarea&gt;&lt;b&gt;'), 'render: notes escaped');
  ok(/data-ic-status="photos"[^>]*>[\s\S]*?<option value="requested" selected>/.test(html), 'render: status selected');
  ok(/data-ic-detail="photos"[^>]*placeholder="Requested from/.test(html), 'render: requested detail placeholder');
  const tag = (id) => (html.match(new RegExp('<input type="text" data-ic-detail="' + id + '"[^>]*>')) || [''])[0];
  ok(tag('cadReport').includes('class="hidden ') && tag('photos') && !tag('photos').includes('hidden'), 'render: detail box only when needed');
  ok(/data-ic="body" class="hidden/.test(UI.renderCard(x, { open: false })), 'render: collapsed');
  eq(UI.lastExportText({ lastExport: null }), 'Not exported yet', 'lastExportText none');

  // ---- pdfText / wrap ----------------------------------------------------------------------
  eq(P.pdfText('“Smart” – quotes… café ✓ 日本'), '"Smart" - quotes... café ? ??', 'pdfText');

  // ---- PDF ---------------------------------------------------------------------------------
  const { PDFDocument } = require('pdf-lib');
  let full = IC.create({ defendants: 'Doe, Jane; Roe, Richard', agency: 'Sample City Police Department', agencyCaseNumber: '26-000123', assistingAgencies: 'Sample County Sheriff', caseNumbers: '26CR0001' }, NOW);
  IC.SECTIONS.forEach((s, si) => s.items.forEach((it, k) => {
    if (s.kind === 'check') { if (k % 2 === 0) full = IC.setCheck(full, it.id, true); }
    else full = IC.setStatus(full, it.id, IC.STATUSES[(si + k) % 4].id);
  }));
  full = IC.setDetail(full, 'otherDigital', 'Phone extraction from the second device is still with the lab — “ETA” two weeks');
  full = IC.setNotes(full, 'Synthetic note.\nSecond line with ü and — dash.');
  const bytes = await P.buildIntakePdf(full, { now: NOW });
  ok(Buffer.isBuffer(bytes) && bytes.slice(0, 5).toString() === '%PDF-', 'pdf: header');
  const doc = await PDFDocument.load(bytes);
  eq(doc.getPageCount(), 1, 'pdf: one page for a normal checklist');
  eq(doc.getTitle(), IC.TITLE, 'pdf: title metadata');
  eq(doc.getPage(0).getSize(), { width: 612, height: 792 }, 'pdf: letter');

  // Very long details / notes spill onto more pages instead of off the page.
  let big = full;
  IC.SECTIONS.forEach(s => { if (s.kind === 'status') s.items.forEach(it => { big = IC.setDetail(big, it.id, 'Long synthetic detail '.repeat(13)); }); });
  big = IC.setNotes(big, Array.from({ length: 200 }, (_, i) => 'Synthetic note line ' + i).join('\n'));
  const bigDoc = await PDFDocument.load(await P.buildIntakePdf(big, { now: NOW }));
  ok(bigDoc.getPageCount() >= 3, 'pdf: long content paginates (' + bigDoc.getPageCount() + ')');
  const emptyDoc = await PDFDocument.load(await P.buildIntakePdf(IC.create({}, NOW), { now: NOW }));
  eq(emptyDoc.getPageCount(), 1, 'pdf: blank checklist');
  const junkDoc = await PDFDocument.load(await P.buildIntakePdf({ header: { defendants: 'x'.repeat(400).replace(/x/g, 'Ω') } }, { now: NOW }));
  eq(junkDoc.getPageCount(), 1, 'pdf: unencodable text survives');

  // ---- IPC ---------------------------------------------------------------------------------
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const saved = [], audits = [], opened = [], written = [];
  let locked = false;
  const caseForms = {
    locked: () => locked,
    save: (cn, name, b) => { saved.push([cn, name, b.slice(0, 5).toString()]); return { fileName: name }; },
    openTemp: async (name, b) => { opened.push([name, b.length > 0]); return { opened: true }; },
  };
  let dialogResult = { canceled: false, filePath: 'C:\\out\\Intake.pdf' };
  P.registerIntakeIpc(ipc, {
    caseForms,
    outputFileName: (t, h) => `${t}${h ? ' - ' + h : ''} - 2026-03-04.pdf`,
    safeCaseNumber: (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null),
    dialog: { showSaveDialog: async () => dialogResult },
    getWindow: () => null,
    defaultDir: () => 'C:\\docs',
    writeFile: (p, b) => written.push([p, b.length > 0]),
    audit: (ev, data) => audits.push([ev, data]),
  });
  const h = handlers['prosecution-intake-pdf'];
  ok(typeof h === 'function', 'ipc: registered');
  let r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'case' });
  eq([r.success, r.fileName, r.destination], [true, 'Intake Checklist - Doe - 2026-03-04.pdf', 'case'], 'ipc: case save');
  eq(saved[0], ['26-000123', 'Intake Checklist - Doe - 2026-03-04.pdf', '%PDF-'], 'ipc: case bytes');
  eq(audits[0][0], 'PROSECUTION_INTAKE_EXPORTED', 'ipc: audit event');
  eq([audits[0][1].destination, audits[0][1].items, audits[0][1].case_number], ['case', 34, '26-000123'], 'ipc: audit data');
  ok(!JSON.stringify(audits[0][1]).includes('Doe, Jane'), 'ipc: audit has no names');
  r = await h(null, { caseNumber: '../x', checklist: full, mode: 'case' });
  eq([r.success, r.error], [false, 'Open a case first'], 'ipc: bad case number');
  locked = true;
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'case' });
  ok(!r.success && /Unlock Field Security/.test(r.error), 'ipc: locked refuses case');
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'open' });
  ok(!r.success && /Unlock/.test(r.error), 'ipc: locked refuses open');
  locked = false;
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'open' });
  eq([r.success, r.opened, opened.length], [true, true, 1], 'ipc: open');
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'saveAs' });
  eq([r.success, r.fileName, r.destination, written.length], [true, 'Intake.pdf', 'export', 1], 'ipc: saveAs');
  eq(audits.length, 2, 'ipc: open not audited, saveAs audited');
  dialogResult = { canceled: true };
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'saveAs' });
  eq([r.success, r.canceled, written.length], [true, true, 1], 'ipc: saveAs canceled');
  r = await h(null, { checklist: full, mode: 'preview' });
  ok(r.success && Buffer.from(r.dataBase64, 'base64').slice(0, 5).toString() === '%PDF-', 'ipc: preview');
  r = await h(null, { caseNumber: '26-000123', checklist: full, mode: 'zip' });
  eq([r.success, r.error], [false, 'Unknown save option'], 'ipc: bad mode');
  r = await h(null, { caseNumber: '26-000123', mode: 'case' });
  eq(r.success, false, 'ipc: no checklist');
  r = await h(null, 'nonsense');
  eq(r.success, false, 'ipc: junk request');

  // ---- Audit event registered ---------------------------------------------------------------
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'audit-log.js'), 'utf8');
  ok(/PROSECUTION_INTAKE_EXPORTED:\s*'prosecution_intake_exported'/.test(src), 'audit-log has the event');

  if (process.argv.includes('--write')) {
    require('fs').writeFileSync(process.argv[process.argv.indexOf('--write') + 1], bytes);
  }
  console.log(`intake-checklist: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
