// modules/warrant-author/__tests__/working-copy.test.js
// Every Warrant Author draft keeps a Word + PDF working copy in the case
// folder, refreshed automatically after the draft changes. Loads the real
// draft-store.js + warrant-author-ui.js in a vm with stubbed composers and
// a fake desktop bridge. SYNTHETIC data only.
//
// Run: node modules/warrant-author/__tests__/working-copy.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL:', msg, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } }

// ── fake renderer ──
const ls = new Map();
const localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
};
const listeners = {};
const timers = [];
let timerId = 0;
const toasts = [];
const calls = [];
let genResult = null;
let saveResult = null;

const ctx = {
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Set, Map,
  Uint8Array, ArrayBuffer, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  localStorage,
  setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms, cleared: false }); return id; },
  clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  document: { getElementById: () => null, hasFocus: () => false },
};
ctx.window = ctx;
ctx.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
ctx.dispatchEvent = (ev) => { (listeners[ev.type] || []).forEach(fn => fn(ev)); return true; };
ctx.showToast = (m, kind) => toasts.push([m, kind]);
ctx.currentCase = { id: 'c1', caseNumber: '26-0001', name: 'Synthetic case' };
ctx.electronAPI = {
  warrantAuthorSaveDraft: async (casePath, id, draft) => { calls.push({ op: 'save', casePath, id, draft }); return saveResult || { success: true, folder: 'Saved Folder' }; },
  warrantAuthorGenerate: async (p) => { calls.push({ op: 'gen', p }); return genResult || { success: true, folder: 'Google ESP - SW 24-001' }; },
};
ctx.WarrantAuthorTemplateEngine = {
  getTemplate: (id) => ({ id }),
  compose: () => ({ blocks: [{ kind: 'paragraph', text: 'addendum' }], danglingSlots: [] }),
};
ctx.WarrantAuthorProviderDirectory = { mergeProviders: () => [{ key: 'google', name: 'Google' }, { key: 'meta', name: 'Meta' }] };
ctx.WarrantAuthorBlockBuilder = { build: (i) => ({ blocks: [{ kind: 'paragraph', text: i.pcNarrative || '' }], stats: { pcAuthored: true } }) };
ctx.WarrantAuthorPdfComposer = { composePdf: () => ({ arrayBuffer: new ArrayBuffer(8), pageCount: 1, blob: null }) };
ctx.WarrantAuthorCasePcStore = { getBody: () => 'Synthetic probable cause.', getBodyHtml: () => '' };

vm.createContext(ctx);
for (const f of ['draft-store.js', 'warrant-author-ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'warrant-author', f), 'utf8'), ctx, { filename: f });
}
const ds = ctx.WarrantAuthorDraftStore;
const UI = ctx.WarrantAuthorUI;
const WC = UI._workingCopy;
const live = (list) => list.filter(t => !t.cleared);

(async () => {
  console.log('— a change schedules a debounced refresh');
  const d = ds.createDraft('c1', { template: 'generic-us-multi-business-esp', type: 'multi-business-esp', jurisdiction: 'US', swNumber: '24-001' });
  ok(live(timers).length === 1 && live(timers)[0].ms === 4000, 'create → one refresh in 4 s', timers);
  ds.addAddendum('c1', d.id, { providerKey: 'google' });
  ok(live(timers).length === 1, 'second change replaces the pending refresh (debounce)', live(timers).length);
  const draft = ds.getDraft('c1', d.id);
  draft.swNumber = '24-001';
  ds.saveDraft('c1', draft, { silent: true });
  ok(live(timers).length === 1, 'silent saves count too');
  ok(WC.status[d.id] && WC.status[d.id].pending, 'status shows pending');

  console.log('— ESP refresh: folder hints + Word + PDF');
  calls.length = 0;
  await WC.refresh('c1', d.id);
  const save = calls.find(c => c.op === 'save');
  const gen = calls.find(c => c.op === 'gen');
  ok(save && save.casePath === 'cases/26-0001' && save.id === d.id, 'manifest saved into the case', save && save.casePath);
  ok(save && JSON.stringify(save.draft.folderProviders) === '["Google"]', 'provider display names for the folder name', save && save.draft.folderProviders);
  ok(!('folderProviders' in ds.getDraft('c1', d.id)), 'stored draft never gets the hint');
  ok(gen && JSON.stringify(gen.p.formats) === '["pdf","docx"]', 'Word + PDF', gen && gen.p.formats);
  ok(gen && gen.p.pdfBytes instanceof ArrayBuffer && gen.p.blockStream && Array.isArray(gen.p.blockStream.blocks), 'PDF bytes + block stream for the DOCX');
  ok(gen && gen.p.casePath === 'cases/26-0001' && gen.p.warrantId === d.id, 'generate targets the draft');
  ok(gen && gen.p.draft.folderProviders && gen.p.draft.folderProviders[0] === 'Google', 'generate carries the folder hint');
  const st = WC.status[d.id];
  ok(st && st.written && !st.pending && st.folder === 'Google ESP - SW 24-001', 'status: written, folder', st);
  const html = WC.statusHtml('c1', d.id);
  ok(/Word \+ PDF updated/.test(html) && /Drafts\/Google ESP - SW 24-001/.test(html), 'chip text', html);
  ok(/onOpenGeneratedFolder\('c1','/.test(html), 'chip opens the folder', html);
  ok(toasts.length === 0, 'silent: no toast', toasts);

  console.log('— no addendums: folder only');
  const e = ds.createDraft('c1', { template: 'generic-us-multi-business-esp', type: 'multi-business-esp', jurisdiction: 'US' });
  calls.length = 0;
  await WC.refresh('c1', e.id);
  ok(calls.length === 1 && calls[0].op === 'save', 'manifest/folder saved, nothing generated', calls.map(c => c.op));
  ok(WC.status[e.id] && /addendum/.test(WC.status[e.id].skipped || ''), 'status explains', WC.status[e.id]);

  console.log('— residential + PA');
  const r = ds.createDraft('c1', { template: 'ca-residential', type: 'residential', jurisdiction: 'CA', swNumber: '24-002' });
  calls.length = 0;
  await WC.refresh('c1', r.id);
  const rs = calls.find(c => c.op === 'save'); const rg = calls.find(c => c.op === 'gen');
  ok(rs && Array.isArray(rs.draft.folderProviders) && rs.draft.folderProviders.length === 0, 'residential hint is []', rs && rs.draft.folderProviders);
  ok(rg && JSON.stringify(rg.p.formats) === '["pdf","docx"]', 'residential Word + PDF', rg && rg.p.formats);
  const pa = ds.createDraft('c1', { template: 'pa-multi-business-esp', type: 'multi-business-esp', jurisdiction: 'PA' });
  ds.addAddendum('c1', pa.id, { providerKey: 'meta' });
  calls.length = 0;
  await WC.refresh('c1', pa.id);
  const pg = calls.find(c => c.op === 'gen');
  ok(pg && JSON.stringify(pg.p.formats) === '["pdf"]' && !pg.p.blockStream, 'PA: official PDF forms only', pg && pg.p.formats);
  ok(pg && pg.p.draft.folderProviders[0] === 'Meta', 'PA folder hint');

  console.log('— edits kept / file open / locked / no case');
  genResult = { success: true, folder: 'F', keptEdits: ['warrant (edited 2026-11-17 0905).docx'] };
  await WC.refresh('c1', d.id);
  ok(toasts.some(t => /edited copy was kept/.test(t[0]) && /0905/.test(t[0])), 'officer told where the edit went', toasts);
  genResult = { success: true, folder: 'F', busy: ['warrant.docx'] };
  await WC.refresh('c1', d.id);
  ok(/warrant\.docx is open/.test(WC.statusHtml('c1', d.id)), 'open Word file reported', WC.statusHtml('c1', d.id));
  genResult = { success: true, folder: '<img src=x onerror=1>' };
  await WC.refresh('c1', d.id);
  ok(!/<img/.test(WC.statusHtml('c1', d.id)), 'folder name escaped');
  genResult = null;
  saveResult = { success: false, locked: true, error: 'Field Security is locked' };
  calls.length = 0;
  await WC.refresh('c1', d.id);
  ok(calls.length === 1 && calls[0].op === 'save', 'locked: nothing generated', calls.map(c => c.op));
  ok(WC.status[d.id].error && /not updated/.test(WC.statusHtml('c1', d.id)), 'locked shown');
  saveResult = null;
  const other = ds.createDraft('c9', { template: 'generic-us-multi-business-esp', type: 'multi-business-esp', jurisdiction: 'US' });
  calls.length = 0;
  await WC.refresh('c9', other.id);
  ok(calls.length === 0 && /No case number/.test(WC.status[other.id].error || ''), 'unknown case: nothing written', calls.length);

  console.log('— cancel before a manual Generate');
  WC.schedule('c1', d.id);
  const newest = timers[timers.length - 1];
  ok(newest && !newest.cleared && newest.ms === 4000, 'scheduled');
  await WC.cancel('c1', d.id);
  ok(newest.cleared, 'cancel drops the pending refresh');
  calls.length = 0;
  WC.schedule('c1', d.id);
  timers[timers.length - 1].fn();
  await WC.cancel('c1', d.id);   // waits for the run in flight
  ok(calls.some(c => c.op === 'gen'), 'the timer runs the refresh; cancel waits for it', calls.map(c => c.op));

  console.log('— no desktop bridge');
  const api = ctx.electronAPI; ctx.electronAPI = undefined;
  ok(WC.statusHtml('c1', d.id) === 'saves to case folder', 'browser preview keeps the old hint');
  const t0 = live(timers).length;
  WC.schedule('c1', d.id);
  ok(live(timers).length === t0, 'no refresh without the bridge');
  ctx.electronAPI = api;

  console.log('— wiring');
  const ui = fs.readFileSync(path.join(ROOT, 'modules', 'warrant-author', 'warrant-author-ui.js'), 'utf8');
  ok((ui.match(/await _autoCancel\(caseId, draft\.id\)/g) || []).length === 3, 'ESP, residential and PA Generate wait for a running refresh');
  ok((ui.match(/_withFolderHints\(/g) || []).length >= 8, 'every disk IPC carries the folder hint');
  ok(!/saves to case folder<\/span>/.test(ui), 'toolbars use the status chip');
  const main = fs.readFileSync(path.join(ROOT, 'modules', 'warrant-author', 'warrant-author-main.js'), 'utf8');
  ok(!/fs\.writeFileSync\((pdfPath|docxPath)/.test(main), 'main writes Word/PDF only through writeGuarded');
  ok(/_isSecLocked\(\)/.test(main), 'main refuses plaintext writes while the vault is locked');

  console.log(`\nworking-copy: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
