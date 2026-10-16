/**
 * Meta Warrant renderer half: MetaWarrantModule (records, flags, re-import,
 * delete, push-to-Evidence, Source Validation citations) and MetaWarrantUI
 * (what each section draws), end to end against a REAL store.
 *
 * Nothing is re-implemented here: the IPC handlers are lifted out of
 * electron-main.js, the electronAPI bridge out of preload.js, and they drive
 * the real meta-warrant-service over a synthetic Instagram return.  Values
 * cross the fake IPC boundary through structuredClone, like Electron's.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\electron\dist\electron.exe modules\meta-warrant\__tests__\meta-ui.test.js
 *      (plain `node` works too)
 */
'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const IG = require('./fixtures/ig-fixture');
const { createService } = require('../meta-warrant-service');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
async function rejects(p, re, name) {
    let err = null;
    try { await p; } catch (e) { err = e; }
    ok(!!err && re.test(err.message), name + (err ? ' (' + err.message + ')' : ' (did not throw)'));
}
const count = (s, needle) => String(s).split(needle).length - 1;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-meta-ui-'));
const casesRoot = path.join(tmp, 'cases');
fs.mkdirSync(casesRoot, { recursive: true });
const CASE = '2026-0777';
fs.mkdirSync(path.join(casesRoot, CASE), { recursive: true });

const logs = { error: [], log: [] };
const quiet = {
    log: (...a) => logs.log.push(a.join(' ')),
    info: () => {}, warn: () => {},
    error: (...a) => logs.error.push(a.map(x => (x && x.message) || String(x)).join(' '))
};

// ── main process: real service + the handlers exactly as electron-main.js has them ──
let tokens = 0;
const svc = createService({
    casesDir: () => casesRoot,
    security: () => null,
    tempDir: path.join(tmp, 'view-temp'),
    issueToken: () => 'tok' + (++tokens),
    fingerprint: async (spec) => ({ sha256: 'f'.repeat(64), path: spec.path })
});

const mainSrc = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
const hA = mainSrc.indexOf('const _metaErr =');
const hB = mainSrc.indexOf("ipcMain.handle('meta-warrant-read-media'");
ok(hA > 0 && hB > hA, 'found the Meta IPC block in electron-main.js');
let pickReply = { canceled: true, filePaths: [] };
function liftHandlers(service) {
    const out = {};
    new Function('ipcMain', '_metaService', 'pickProductionFileOrFolder', 'restoreFocus', 'fs', 'console', mainSrc.slice(hA, hB))(
        { handle: (ch, fn) => { out[ch] = fn; } }, service, async () => pickReply, () => {}, fs, quiet);
    return out;
}
const handlers = liftHandlers(svc);
for (const ch of ['scan', 'import', 'pick-file', 'overview', 'query', 'media-url', 'list-stores', 'delete-store']) {
    ok(typeof handlers['meta-warrant-' + ch] === 'function', 'lifted handler meta-warrant-' + ch);
}

// ── preload bridge, lifted from preload.js ──
const preSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const pA = preSrc.indexOf('metaWarrantScan:');
const pEndMark = "ipcRenderer.removeListener('meta-warrant-import-progress', handler);";
const pB = preSrc.indexOf('},', preSrc.indexOf(pEndMark)) + 2;
ok(pA > 0 && pB > pA, 'found the Meta bridge in preload.js');
const listeners = new Map();
const invoked = [];
const ipcRenderer = {
    invoke: async (ch, data) => {
        invoked.push(ch);
        const h = handlers[ch];
        if (!h) throw new Error(`Error invoking remote method '${ch}': Error: No handler registered for '${ch}'`);
        const sender = {
            isDestroyed: () => false,
            send: (c, p) => { for (const fn of (listeners.get(c) || [])) fn({}, structuredClone(p)); }
        };
        const r = await h({ sender }, data === undefined ? undefined : structuredClone(data));
        return r === undefined ? undefined : structuredClone(r);
    },
    on: (c, fn) => { if (!listeners.has(c)) listeners.set(c, []); listeners.get(c).push(fn); },
    removeListener: (c, fn) => { const l = listeners.get(c) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
};
const bridge = new Function('ipcRenderer', 'return {' + preSrc.slice(pA, pB) + '};')(ipcRenderer);
const calls = (ch) => invoked.filter(c => c === ch).length;

// ── renderer: the five scripts case-detail loads, in that order ──
const lsMap = new Map();
const svPayloads = [];
const evidenceCalls = [];
const citeCalls = [];
const sandbox = {
    console: quiet,
    setTimeout, clearTimeout,
    localStorage: {
        getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
        setItem: (k, v) => lsMap.set(k, String(v)),
        removeItem: (k) => lsMap.delete(k)
    },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    SourceViewer: { buttonHtml: (payload, opts) => { svPayloads.push(payload); return '<button class="sv-btn"></button>'; } }
};
sandbox.window = sandbox;
sandbox.electronAPI = Object.assign({}, bridge, {
    warrantExportFlagsBundle: async (req) => {
        evidenceCalls.push(structuredClone(req));
        return { success: true, bundlePath: 'B', reportJsonPath: 'B/report.json', reportHtmlPath: 'B/report.html', counts: {} };
    },
    sourceHash: async () => ({ ok: true, scope: 'folder', status: 'match', folder: { fileCount: 1, totalBytes: 1, manifestSha256: 'x' } }),
    sourceCiteBatch: async (req) => {
        citeCalls.push(structuredClone(req));
        return { ok: true, results: req.items.map(q => ({ id: q.id, found: true, member: q.memberHints[0], line: 1 })) };
    }
});
vm.createContext(sandbox);
for (const f of ['modules/_shared/warrant-flags.js', 'modules/meta-warrant/meta-interpret.js',
                 'modules/meta-warrant/meta-warrant-module.js', 'modules/meta-warrant/meta-warrant-legacy-ui.js',
                 'modules/meta-warrant/meta-warrant-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const M = sandbox.MetaWarrantModule;
const UI = sandbox.MetaWarrantUI;
ok(typeof M === 'function' && typeof UI === 'function' && typeof sandbox.MetaWarrantLegacyUI === 'function', 'all classes load');
ok(typeof sandbox.mwpArinLookup === 'function', 'mwpArinLookup global still defined');

function newModule(caseId, caseNumber) {
    const m = new M(caseId || 'case-1', caseNumber || CASE, 'Test case');
    m.ui = new UI('mwp-test', m);
    return m;
}

(async () => {
    const src = path.join(tmp, 'ig-return');
    IG.writeReturn(src, { preservations: 2 });

    // 1. static helpers
    ok(M.isLegacy({ records: [] }), 'isLegacy: old record');
    ok(!M.isLegacy({ storeKey: 'k', records: [] }), 'isLegacy: store key wins');
    ok(!M.isLegacy(null) && !M.isLegacy({}), 'isLegacy: null / empty');
    const subj = (o) => JSON.stringify(M.subjectOf(o));
    eq(subj({ accountId: '17841400000000001', targetId: '17841400000000001' }), '{"userId":"17841400000000001"}', 'subjectOf: id == target');
    eq(subj({ accountId: '1', targetId: 'kid@example.com' }), '{"userId":"1","email":"kid@example.com"}', 'subjectOf: email target');
    eq(subj({ accountId: '', targetId: '+1 (555) 123-4567' }), '{"phone":"+1 (555) 123-4567"}', 'subjectOf: phone target');
    eq(subj({ accountId: '', targetId: 'some.user' }), '{"username":"some.user"}', 'subjectOf: username target');
    eq(subj({ accountId: '', targetId: '100004567890123' }), '{"userId":"100004567890123"}', 'subjectOf: bare-digit target is an account id, not a phone');
    eq(M.itemFlagKey('photos', 'ab.1'), 'c:photos:ab.1', 'itemFlagKey');
    eq(M.msgFlagKey('t1', 'cd.1'), 'm:t1:cd.1', 'msgFlagKey');
    eq(M.pageLabel({ name: 'sub/dir/preservation-1.html' }, 1), 'preservation-1.html', 'pageLabel basename');
    eq(M.pageLabel(null, 1), 'page 2', 'pageLabel fallback');

    const F = (k, t, extra) => Object.assign({ k, v: Object.assign(t ? { t } : {}, extra || {}) });
    const fields = [F('Id', ['1800000']), F('Taken', ['2026-04-01 13:41:40 UTC']), F('Caption', ['caption number 0'])];
    eq(M.primaryValue(fields), 'caption number 0', 'primaryValue prefers a summary key');
    eq(M.primaryValue([F('Taken', ['2026-04-01 13:41:40 UTC']), F('Id', ['1800000'])]), '1800000', 'primaryValue skips time-only lines');
    eq(M.primaryValue([F('Taken', ['2026-04-01 13:41:40 UTC']), F('Image', null, { m: [{ k: 'image', s: 'linked_media/p_1.jpg' }] })]), 'p_1.jpg', 'primaryValue falls back to the media basename');
    eq(M.primaryValue([F('Body', ['x'.repeat(300)])]).length, 200, 'primaryValue capped at 200');
    eq(M.rawTimeLine(fields, '2026-04-01 13:41:40'), '2026-04-01 13:41:40 UTC', 'rawTimeLine returns the printed line');
    eq(M.rawTimeLine(fields, '2020-01-01 00:00:00'), '', 'rawTimeLine: no such time');
    const nested = [F('Thread', ['abc', 'def']), F('Messages', null, { r: [[F('Author', ['me']), F('Body', ['hi'])]] })];
    eq(M.fieldsText(nested), 'Thread: abc\n  def\nMessages:\n  Author: me\n  Body: hi', 'fieldsText indents continuation lines and records');

    // 2. pickSource: the real handler's {path,isFolder}, an old string reply, cancel
    const mod = newModule('case-1');
    pickReply = { canceled: false, filePaths: [src] };
    let picked = await mod.pickSource();
    eq(picked && picked.path, src, 'pickSource: path from the lifted handler');
    eq(picked && picked.isFolder, true, 'pickSource: folder detected');
    pickReply = { canceled: true, filePaths: [] };
    eq(await mod.pickSource(), null, 'pickSource: cancel → null');
    const realPick = sandbox.electronAPI.metaWarrantPickFile;
    sandbox.electronAPI.metaWarrantPickFile = async () => 'C:\\old\\reply.zip';
    picked = await mod.pickSource();
    eq(picked && picked.path, 'C:\\old\\reply.zip', 'pickSource: old string reply accepted');
    eq(picked && picked.isFolder, false, 'pickSource: string reply is a file');
    sandbox.electronAPI.metaWarrantPickFile = realPick;

    // 3. import through the real bridge + handler + service
    const progress = [];
    const off = sandbox.electronAPI.onMetaWarrantImportProgress((p) => progress.push(p));
    const rec = await mod.importWarrant(src, 'ig-return');
    off();
    eq((listeners.get('meta-warrant-import-progress') || []).length, 0, 'progress unsubscribe removes the listener');
    ok(!!rec && /^[0-9a-f]{16}$/.test(rec.storeKey), 'import: record has a store key');
    eq(rec.service, 'Instagram', 'import: service');
    eq(rec.accountType, 'User', 'import: account type carried to the light record');
    eq(rec.subject.userId, IG.TARGET, 'import: Warrant Author subject');
    eq(rec.fileName, 'ig-return', 'import: file name');
    eq(rec.sourceIntegrity && rec.sourceIntegrity.sha256, 'f'.repeat(64), 'import: fingerprint kept for Source Validation');
    ok(!('records' in rec) && !M.isLegacy(rec), 'import: no parse in localStorage');
    eq(mod.imports.length, 1, 'import: one record');
    const saved = JSON.parse(lsMap.get('metaWarrant_case-1'));
    eq(saved.imports[0].storeKey, rec.storeKey, 'import: saved to localStorage');
    ok(lsMap.get('metaWarrant_case-1').length < 4000, 'import: localStorage record stays small (' + lsMap.get('metaWarrant_case-1').length + ' chars)');
    ok(progress.length >= 2 && progress.every(p => p.caseNumber === CASE), 'progress events carry the case number');
    eq(progress[progress.length - 1].phase, 'done', 'progress ends with done');
    ok(calls('meta-warrant-scan') >= 1, 'import rescans the case folder');

    // 4. overview + caches
    const ov1 = await mod.overview(rec);
    ok(ov1.success && ov1.overview.threadCount === 2, 'overview through the bridge');
    const nOv = calls('meta-warrant-overview');
    await mod.overview(rec);
    eq(calls('meta-warrant-overview'), nOv, 'overview is cached');
    const mu = await mod.mediaUrl(rec, 'linked_media/photos_1800000.jpg');
    ok(mu.success && /^viper-media:\/\/m\/tok\d+$/.test(mu.fileUrl) && mu.kind === 'image', 'mediaUrl: viper-media URL for an image');
    const nMu = calls('meta-warrant-media-url');
    await mod.mediaUrl(rec, 'linked_media/photos_1800000.jpg');
    eq(calls('meta-warrant-media-url'), nMu, 'mediaUrl is cached');
    const miss = await mod.mediaUrl(rec, 'linked_media/unified_message_MISSING.jpg');
    ok(!miss.success && /not found/i.test(miss.error), 'mediaUrl: missing file');
    ok(!(await mod.mediaUrl(rec, '')).success, 'mediaUrl: empty ref refused without IPC');

    // 5. flags (one section 'meta', content-hash keys)
    const photos = await mod.query(rec, { kind: 'items', cat: 'photos', limit: 50, sort: 'time-asc' });
    eq(photos.total, 6, 'query: 6 photos');
    const p0 = photos.rows.find(r => (r.f || []).some(f => f.k === 'Caption' && f.v.t[0] === 'caption number 0'));
    ok(!!p0, 'photo 0 found');
    const threads = await mod.query(rec, { kind: 'threads', limit: 10 });
    const th1 = threads.rows.find(t => t.threadId === '340282366841710300949128000000000002');
    const msgs = await mod.query(rec, { kind: 'thread', thread: th1.key, limit: 10 });
    const m1 = msgs.rows.find(m => m.body === 'second thread 1');
    ok(!!m1, 'message found');
    const kP = M.itemFlagKey('photos', p0.key), kM = M.msgFlagKey(th1.key, m1.key);
    ok(mod.toggleFlag('meta', kP) === true && mod.toggleFlag('meta', kM) === true, 'flags set');
    eq(mod.flagCount(), 2, 'flag count');
    ok(mod.isFlagged('meta', kP) && mod.isFlagged('meta', kM), 'isFlagged');
    const firstId = rec.id;

    // 6. re-import keeps id and flags; store key unchanged; caches dropped
    const rec2 = await mod.importWarrant(src, 'ig-return');
    eq(rec2.id, firstId, 're-import keeps the record id');
    eq(mod.imports.length, 1, 're-import replaces, does not add');
    eq(mod.flagCount(), 2, 're-import keeps flags');
    eq(rec2.storeKey, rec.storeKey, 're-import uses the same store');
    await mod.overview(rec2);
    eq(calls('meta-warrant-overview'), nOv + 1, 're-import drops the overview cache');
    const rec3 = await mod.upgradeImport(firstId);
    eq(rec3.id, firstId, 'upgradeImport keeps the id');
    eq(mod.flagCount(), 2, 'upgradeImport keeps flags');
    const keysAfter = await mod.query(rec3, { kind: 'keys', keys: [kP, kM] });
    ok(keysAfter.items.length === 1 && keysAfter.messages.length === 1 && keysAfter.missing.length === 0, 'flag keys still resolve after re-import (content hashes)');

    // 7. push to Evidence: sections, report rows, citations (WeakMap), subject info
    mod.toggleFlag('meta', 'c:photos:0000000000000000.1');     // flagged earlier, gone now
    const res = await mod.pushFlagsToEvidence();
    ok(res && res.success, 'push succeeds');
    eq(evidenceCalls.length, 1, 'one bundle written');
    const ev = evidenceCalls[0];
    const ids = ev.sectionConfigs.map(c => c.id).join(',');
    eq(ids, 'c_photos,messages,missing', 'sections: per category, messages, missing');
    const prow = ev.sections.c_photos[0];
    ok(/Caption: caption number 0/.test(prow.details), 'photo row: details as text');
    eq(prow.media, 'linked_media/photos_1800000.jpg', 'photo row: media ref');
    eq(prow.time, '2026-04-01 13:41:40', 'photo row: time');
    eq(prow.foundOn, 'records.html (records)', 'photo row: found on');
    const mrow = ev.sections.messages[0];
    eq(mrow.body, 'second thread 1', 'message row: body');
    ok(/third\.person/.test(mrow.author), 'message row: author');
    ok(/340282366841710300949128000000000002/.test(mrow.thread), 'message row: thread');
    eq(mrow.foundOn, 'records.html (records), preservation-1.html (preservation), preservation-2.html (preservation)', 'message row: every page it was on');
    eq(ev.sections.missing.length, 1, 'missing row for the vanished flag');
    eq(ev.sections.missing[0].key, 'c:photos:0000000000000000.1', 'missing row names the key');
    ok(ev.sectionConfigs.every(c => c.renderHint === 'cards' || c.id === 'missing'), 'cards render hint (files in the return, not web attachments)');
    eq(ev.subjectInfo['Account Type'], 'User', 'subject info: account type');
    eq(ev.subjectInfo['Pages'], 'Records + 2 preservations', 'subject info: pages');
    eq(ev.subjectInfo['Target'], IG.TARGET, 'subject info: target');
    ok(ev.citations && ev.provenance, 'source validation ran');
    eq(citeCalls.length, 1, 'one citation batch');
    const qs = citeCalls[0].items;
    const qP = qs.find(q => q.id.startsWith('c_photos'));
    const qM = qs.find(q => q.id.startsWith('messages'));
    eq(qP && qP.values[0], 'caption number 0', 'citation: photo value');
    eq(qP && qP.values[1], '2026-04-01 13:41:40 UTC', 'citation: photo time as printed');
    eq(qP && qP.memberHints.join('|'), 'records.html', 'citation: photo page hint');
    eq(qM && qM.values[0], 'second thread 1', 'citation: message value');
    ok(qM && /third\.person/.test(qM.values[2]), 'citation: message author corroborates');
    eq(qM && qM.memberHints.join('|'), 'records.html|preservation-1.html|preservation-2.html', 'citation: message page hints');
    eq(qs.length, 2, 'missing row is not cited');
    eq(ev.citations.missing[0].notApplicable, true, 'missing row marked not applicable');
    const evStore = JSON.parse(lsMap.get('viperCaseEvidence'))[CASE];
    eq(evStore && evStore[0].metadata.kind, 'warrant-meta', 'evidence record stored');
    eq(evStore[0].metadata.sourceValidation.found, 2, 'evidence record: 2 cited');
    eq(logs.error.length, 0, 'no console errors so far ' + JSON.stringify(logs.error));
    mod.clearFlags();

    // 8. old main process / missing handler → restart message, record untouched
    const before = JSON.stringify(mod.imports);
    const realImport = sandbox.electronAPI.metaWarrantImport;
    sandbox.electronAPI.metaWarrantImport = async () => ({ success: true, data: { records: [] } });
    await rejects(mod.importWarrant(src, 'x'), /full restart/, 'old main reply → restart message');
    delete sandbox.electronAPI.metaWarrantImport;
    await rejects(mod.importWarrant(src, 'x'), /full restart/, 'missing bridge method → restart message');
    sandbox.electronAPI.metaWarrantImport = (d) => ipcRenderer.invoke('meta-warrant-import-gone', d);
    await rejects(mod.importWarrant(src, 'x'), /full restart/, '"No handler registered" → restart message');
    sandbox.electronAPI.metaWarrantImport = realImport;
    eq(JSON.stringify(mod.imports), before, 'failed imports leave the records alone');
    await rejects(mod.importWarrant(path.join(tmp, 'nope'), 'x'), /could not be found/, 'service error passes through');
    await rejects(mod.importWarrant('', 'x'), /No return selected/, 'empty path refused');
    ok(logs.error.length === 1 && /could not be found/.test(logs.error[0]), 'the deliberate missing-file import is logged once ' + JSON.stringify(logs.error));
    logs.error.length = 0;

    // 9. old-style imports: flags block an upgrade; once cleared it upgrades in place
    const lmod = newModule('case-2');
    const legacy = { id: 'L1', service: 'Instagram', fileName: 'old.zip', filePath: src, records: [{ source: 'records', ipAddresses: [] }], flagged: { photos: ['x'], messages: ['a|b|c'] } };
    lmod.imports.push(legacy);
    const nImp = calls('meta-warrant-import');
    await rejects(lmod.upgradeImport('L1'), /Push or clear your 2 flagged items first/, 'legacy upgrade blocked by pending flags');
    await rejects(lmod.importWarrant(src, 'again'), /Push or clear your 2 flagged items first/, 'importing the same file over a flagged legacy record is blocked too');
    eq(calls('meta-warrant-import'), nImp, 'blocked before any import work');
    ok(lmod.imports[0] === legacy && legacy.records, 'legacy record untouched');
    lmod.ui.activeImportIdx = 0;
    lmod.clearFlags();
    const up = await lmod.upgradeImport('L1');
    eq(up.id, 'L1', 'legacy upgrade keeps the id');
    ok(!M.isLegacy(lmod.imports[0]) && !('records' in lmod.imports[0]), 'legacy upgrade drops the old parse');
    eq(lmod.imports.length, 1, 'legacy upgrade replaces in place');
    // an explicit replaceId wins over a store-key match with another record
    lmod.imports.push({ id: 'L2', fileName: 'old2.zip', filePath: path.join(tmp, 'elsewhere.zip'), records: [{ source: 'records' }] });
    const up2 = await lmod.upgradeImport('L2', src);
    eq(up2.id, 'L2', 'upgrade with Locate replaces THAT record');
    eq(lmod.imports.length, 2, 'both records kept');
    ok(lmod.imports.every(i => !M.isLegacy(i)), 'both upgraded');
    await rejects(lmod.upgradeImport('nope'), /no longer exists/, 'upgrade of an unknown id');

    // 10. delete: the store goes only with its last record
    eq(svc.list(CASE).length, 1, 'one store on disk');
    const nDel = calls('meta-warrant-delete-store');
    await lmod.deleteImport('L1');
    eq(calls('meta-warrant-delete-store'), nDel, 'store shared with another record is not deleted');
    eq(svc.list(CASE).length, 1, 'store still on disk');
    await lmod.deleteImport('L2');
    eq(lmod.imports.length, 0, 'records gone');
    // case-1 (mod) still points at the same store, but lmod cannot know that —
    // stores are per case folder; this case's last record went, so it is removed.
    eq(calls('meta-warrant-delete-store'), nDel + 1, 'last record → store deleted');
    eq(svc.list(CASE).length, 0, 'store removed from disk');
    eq(JSON.parse(lsMap.get('metaWarrant_case-2')).imports.length, 0, 'deletion saved');

    // fresh import for the UI checks
    mod.imports = [];
    const R = await mod.importWarrant(src, 'ig-return');
    const ui = mod.ui;
    ui.activeImportIdx = 0;
    ui.ov = (await mod.overview(R)).overview;

    // 11. UI: navigation
    const secs = ui._sections().map(s => s.id || ('#' + s.heading));
    for (const want of ['overview', 'search', 'messages', 'media', 'ips', 'timeline', '#Categories', 'cat:photos', 'cat:videos', 'cat:ip_addresses']) {
        ok(secs.indexOf(want) >= 0, 'nav has ' + want);
    }
    ok(secs.indexOf('cat:unified_messages') < 0, 'message category is under Messages, not a category');
    eq(secs.filter(s => s.indexOf('cat:') === 0).length, 11, 'nav lists only categories with records');
    const navHtml = ui._renderNavItems();
    ok(/data-section="cat:photos"/.test(navHtml) && /🟠/.test(navHtml), 'nav: only-in-preservation categories marked');

    // 12. UI: badges
    ok(/>R</.test(ui._pageBadge(0)) && /mwp-badge-rec/.test(ui._pageBadge(0)), 'badge R for the records page');
    ok(/>P2</.test(ui._pageBadge(2)) && /mwp-badge-pres/.test(ui._pageBadge(2)), 'badge P2 for the second preservation');
    ok(/only in preservation/.test(ui._srcBadges([1, 2])), 'only-in-preservation badge');
    ok(!/only in preservation/.test(ui._srcBadges([0, 1])), 'no badge when on the records page');
    ok(!/only in preservation/.test(ui._srcBadges([1], true)), 'badge suppressed on request');
    const realOv = ui.ov;
    ui.ov = Object.assign({}, realOv, { pages: [{ name: 'a', kind: 'preservation' }, { name: 'b', kind: 'preservation' }, { name: 'c', kind: 'records' }] });
    ok(/>P2</.test(ui._pageBadge(1)) && />R</.test(ui._pageBadge(2)), 'badges count preservations, not page positions');
    ok(/only in preservation/.test(ui._srcBadges([0, 1])) && !/only in preservation/.test(ui._srcBadges([2])), 'only-badge follows the records page wherever it is');
    ui.ov = realOv;

    // 13. UI: overview
    const ovHtml = ui._renderOverview();
    ok(/33 items appear only in preservation pages/.test(ovHtml), 'overview: only-in-preservation total (ip 12 + following 7 + likes 9 + photos 1 + messages 4)');
    ok(/1 media file is referenced but not in the return/.test(ovHtml), 'overview: missing media count');
    ok(/unified_message_MISSING\.jpg/.test(ovHtml), 'overview: missing media listed');
    ok(/62 categories with no records/.test(ovHtml), 'overview: empty categories folded away');
    ok(/Account Type/.test(ovHtml) && />User</.test(ovHtml), 'overview: account type');
    ok(/preservation-2\.html/.test(ovHtml), 'overview: pages table');
    ok(/data-section="messages"/.test(ovHtml), 'overview: message category row opens Messages');
    ok(/per page/.test(ovHtml), 'overview: Request Parameters shown per page, not as preservation-only');

    // 14. UI: a category page (paged, flagged state, source button payload)
    mod.toggleFlag('meta', M.itemFlagKey('photos', p0.key));
    svPayloads.length = 0;
    let html = await ui._renderCategory(R, 'photos');
    eq(count(html, 'data-flag-row='), 6, 'photos: 6 items');
    ok(/caption number 0/.test(html), 'photos: caption shown');
    eq(count(html, 'mwp-item mwp-flagged'), 1, 'photos: the flagged one is marked');
    ok(/data-mw="pagefilter"/.test(html), 'photos: page filter (3 pages)');
    ok(/Only in preservation \(1\)/.test(html), 'photos: only-in-preservation filter');
    ok(/data-ref="linked_media\/photos_1800000\.jpg"/.test(html), 'photos: media slot for the stored file');
    ok(/🔗 https:\/\/scontent-/.test(html) === false, 'photos: CDN URL is text, not a media slot');
    const sv0 = svPayloads.find(p => p.values[0] === 'caption number 0');
    ok(!!sv0, 'source button: value is the caption');
    eq(sv0 && sv0.values[1], '2026-04-01 13:41:40 UTC', 'source button: time as printed');
    eq(sv0 && sv0.memberHints.join('|'), 'records.html', 'source button: page hint');
    const svSrc = sv0 && await sv0.resolveSource();
    eq(svSrc && svSrc.path, src, 'source button: resolves the original');
    ui.v.onlyPres = true;
    html = await ui._renderCategory(R, 'photos');
    eq(count(html, 'data-flag-row='), 1, 'only-in-preservation filter: 1 photo');
    ok(/only in preservation<\/span>/.test(html), 'filtered item carries the badge');
    ui.v = ui._freshView();
    html = await ui._renderCategory(R, 'ip_addresses');
    ok(/Page 1 of 1/.test(html) === false && count(html, 'data-flag-row=') === 40, 'ip_addresses: 40 on one page (limit 50)');
    ok(/Ip Addresses/.test(html), 'category title');
    eq(await ui._renderCategory(R, 'nope'), '<div class="mwp-empty">Category not found</div>', 'unknown category');

    // 15. UI: messages
    html = await ui._renderThreadList(R);
    eq(count(html, 'data-mw="thread"'), 2, 'threads: 2');
    ok(/3 only in preservation/.test(html), 'threads: preservation-only messages counted');
    ui.v.thread = th1.key;
    html = await ui._renderMessages(R);
    ok(/mwp-msg-list/.test(html) && !/mwp-thread-messages/.test(html), 'thread view does not use the collapsed legacy container');
    eq(count(html, 'class="mwp-message'), 4, 'thread: 4 messages');
    ok(/second thread 1/.test(html) && /third\.person/.test(html), 'thread: body + author');
    ok(/Current Participants/.test(html), 'thread: header details');
    ui.v = ui._freshView();

    // 16. UI: media, IPs, timeline, search
    html = await ui._renderMedia(R);
    eq(count(html, 'class="mwp-media-tile"'), 17, 'media: 17 files');
    eq(count(html, '>relabelled<'), 2, 'media: 2 files whose extension lied');
    ok(/not referenced/.test(html), 'media: unreferenced file still listed');
    ui.v.mediaKind = 'audio';
    html = await ui._renderMedia(R);
    ok(count(html, 'class="mwp-media-tile"') >= 2 && !/photos_1800000/.test(html), 'media: kind filter');
    ui.v = ui._freshView();
    html = await ui._renderIps(R);
    eq(count(html, 'data-mw="ip"'), 47, 'ips: 47 addresses');
    ui.v.ip = '198.51.100.0';
    html = await ui._renderIps(R);
    ok(count(html, 'data-flag-row=') >= 1 && /Upload Ip/.test(html), 'ip detail: photo upload sighting');
    ui.v = ui._freshView();
    html = await ui._renderTimeline(R);
    eq(count(html, 'mwp-timeline-event'), 100, 'timeline: first page of 100');
    ok(/Page 1 of 2/.test(html), 'timeline: pager');
    ui.v.q = 'caption number 3';
    html = await ui._renderSearch(R);
    ok(/<mark>caption number 3<\/mark>/.test(html), 'search: hit highlighted');
    ok(/1 match\b/.test(html), 'search: one match');
    ui.v = ui._freshView();
    ok(/Searches every category/.test(await ui._renderSearch(R)), 'search: empty query draws the prompt only');

    // 17. UI: escaping + never fetching links
    const evil = [
        F('<img src=x onerror=alert(1)>', ['<script>alert(1)</script>']),
        F('Pic', null, { m: [{ k: 'image', s: 'https://evil.example/x.jpg' }, { k: 'image', s: 'javascript:alert(1)' }, { k: 'image', s: 'linked_media/a".jpg' }] })
    ];
    html = ui._renderFields(evil);
    ok(!/<script>/.test(html) && !/<img src=x/.test(html), 'fields: keys and values escaped');
    ok(!/data-ref="https:/.test(html) && !/data-ref="javascript:/.test(html), 'fields: links in the return are never media slots');
    ok(/🔗 https:\/\/evil\.example\/x\.jpg/.test(html), 'fields: link shown as text');
    ok(/data-ref="linked_media\/a&quot;\.jpg"/.test(html), 'fields: ref attribute escaped');
    let deep = [F('leaf', ['bottom'])];
    for (let i = 0; i < 12; i++) deep = [F('lvl' + i, null, { r: [deep] })];
    html = ui._renderFields(deep);
    ok(!/bottom/.test(html) && /…/.test(html), 'fields: depth capped');
    eq(ui._attr(`a'b"<`), 'a&#39;b&quot;&lt;', '_attr escapes quotes');
    eq(ui._highlight('<b>Hello</b>', 'hello'), '&lt;b&gt;<mark>Hello</mark>&lt;/b&gt;', '_highlight escapes around the mark');
    eq(ui._pager({ total: 50, limit: 50, offset: 0, rows: [] }), '', 'pager hidden on one page');
    const pg = ui._pager({ total: 120, limit: 50, offset: 50, rows: [] });
    ok(/Page 2 of 3/.test(pg) && /data-offset="100"[^>]*>Next/.test(pg) && /data-offset="0"[^>]*>« First/.test(pg), 'pager offsets');
    ok(!/disabled>Next/.test(pg) && !/disabled>‹ Prev/.test(pg), 'pager: middle page enables both directions');
    const pgLast = ui._pager({ total: 120, limit: 50, offset: 100, rows: [] });
    ok(/disabled>Next/.test(pgLast) && /disabled>Last/.test(pgLast) && !/disabled>‹ Prev/.test(pgLast), 'pager: last page disables Next and Last');
    const pgFirst = ui._pager({ total: 120, limit: 50, offset: 0, rows: [] });
    ok(/disabled>« First/.test(pgFirst) && /disabled>‹ Prev/.test(pgFirst) && !/disabled>Next/.test(pgFirst), 'pager: first page disables First and Prev');
    eq(ui._fmtSize(2048), '2 KB', '_fmtSize KB');
    eq(ui._fmtSize(3 * 1048576), '3.0 MB', '_fmtSize MB');

    // 18. UI: flag clicks dispatch by import kind; legacy banner
    mod.clearFlags();
    ui._onFlagClick('meta', 'c:photos:abc');
    eq(JSON.stringify(R.flagged), '{"meta":["c:photos:abc"]}', 'new import: flag click toggles the meta key');
    mod.clearFlags();
    const lm = newModule('case-3');
    lm.imports.push({ id: 'L9', fileName: 'old.zip', records: [{ source: 'records' }], flagged: {} });
    lm.ui._onFlagClick('photos', 'p1');
    eq(JSON.stringify(lm.imports[0].flagged), '{"photos":["p1"]}', 'old import: flag click goes to the old viewer');
    ok(/push or clear them first/.test(lm.ui._upgradeBanner(lm.imports[0])), 'banner warns about pending old flags');
    ok(!/push or clear/.test(lm.ui._upgradeBanner({ records: [] })), 'banner: no warning without flags');
    eq(JSON.stringify(lm._buildSubjectInfo(lm.imports[0])).indexOf('Registration IP') > 0, true, 'old import: old subject info');

    // 19. media slots: what each reply from main draws
    const fakeSlot = (ref, kind) => { const s = { dataset: { ref, kind }, innerHTML: '', classes: [] }; s.classList = { add: (c) => s.classes.push(c) }; return s; };
    ui.activeImportIdx = 0;
    let slot = fakeSlot('linked_media/videos_1900000.mp4', 'video');
    await ui._loadSlot(slot);
    ok(/^<video class="mwp-media-video" src="viper-media:\/\/m\/tok\d+" controls/.test(slot.innerHTML), 'slot: video player for a stored video ' + slot.innerHTML.slice(0, 80));
    eq(slot.dataset.done, '1', 'slot: marked done');
    slot.innerHTML = 'kept';
    await ui._loadSlot(slot);
    eq(slot.innerHTML, 'kept', 'slot: loaded once only');
    slot = fakeSlot('linked_media/photos_1800000.jpg', 'image');
    await ui._loadSlot(slot);
    ok(/^<img class="mwp-media-img" src="viper-media:\/\/m\/tok\d+"[^>]*data-mw="zoom"/.test(slot.innerHTML), 'slot: zoomable image');
    slot = fakeSlot('linked_media/unified_message_4400004.txt', 'file');
    await ui._loadSlot(slot);
    ok(/^<audio class="mwp-media-audio"/.test(slot.innerHTML) && /relabelled/.test(slot.innerHTML), 'slot: voice note saved as .txt plays as audio and says so ' + slot.innerHTML.slice(0, 80));
    slot = fakeSlot('linked_media/unified_message_MISSING.jpg', 'image');
    await ui._loadSlot(slot);
    ok(slot.classes.join() === 'mwp-media-missing' && /Not in the return: unified_message_MISSING\.jpg/.test(slot.innerHTML), 'slot: missing file says so');
    // a locked vault: the lifted handler's _metaErr sets `locked`, the slot asks to unlock
    const lockedErr = () => { const e = new Error('VIPER is locked'); e.code = 'VIPER_LOCKED'; throw e; };
    const lockedH = liftHandlers({ mediaUrl: lockedErr, query: lockedErr, overview: lockedErr });
    const lr = await lockedH['meta-warrant-media-url']({}, { caseNumber: CASE, storeKey: 'k', ref: 'r' });
    ok(lr.success === false && lr.locked === true && lr.error === 'VIPER is locked', 'IPC: locked vault reported as locked');
    const qr = await lockedH['meta-warrant-query']({}, { caseNumber: CASE, storeKey: 'k', req: {} });
    eq(qr.locked, true, 'IPC: locked query reported as locked');
    const plainH = liftHandlers({ mediaUrl: () => { throw new Error('disk'); } });
    eq((await plainH['meta-warrant-media-url']({}, {})).locked, false, 'IPC: other errors are not "locked"');
    const realMU = handlers['meta-warrant-media-url'];
    handlers['meta-warrant-media-url'] = lockedH['meta-warrant-media-url'];
    slot = fakeSlot('linked_media/photos_1800001.jpg', 'image');
    try { await ui._loadSlot(slot); } finally { handlers['meta-warrant-media-url'] = realMU; }
    ok(slot.classes.join() === 'mwp-media-locked' && /Unlock VIPER/.test(slot.innerHTML), 'slot: locked vault asks to unlock');
    ok((await mod.mediaUrl(R, 'linked_media/photos_1800001.jpg')).success, 'a locked reply is not cached — works once unlocked');

    // 20. import progress throttle: bursts collapse, a finished phase and "done" always arrive
    const burstH = liftHandlers({
        importReturn: async (req, onP) => {
            onP({ phase: 'start' });
            for (let i = 1; i <= 5; i++) onP({ phase: 'pages', done: i, total: 5 });
            onP({ phase: 'media', done: 3, total: 10 });
            onP({ phase: 'done' });
            return { storeKey: 'abc' };
        }
    });
    const sent = [];
    const br = await burstH['meta-warrant-import']({ sender: { isDestroyed: () => false, send: (c, p) => sent.push([c, p]) } }, { caseNumber: 'C1', sourcePath: 'S' });
    eq(br.success && br.record.storeKey, 'abc', 'IPC import returns the record');
    eq(sent.map(([, p]) => p.phase + (p.done != null ? p.done : '')).join(','), 'start,pages5,done', 'progress: burst throttled, completed phase and done kept');
    ok(sent.every(([c, p]) => c === 'meta-warrant-import-progress' && p.caseNumber === 'C1'), 'progress: channel + case number');
    const goneSent = [];
    const gr = await burstH['meta-warrant-import']({ sender: { isDestroyed: () => true, send: () => goneSent.push(1) } }, { caseNumber: 'C1', sourcePath: 'S' });
    ok(gr.success && goneSent.length === 0, 'progress: closed window is skipped, import still finishes');

    // 21. click delegation: a click on an icon inside a button acts on the button
    const hits = [];
    let stopped = 0;
    const btn = { tagName: 'BUTTON', dataset: { mw: 'flag', key: 'c:photos:zz' } };
    const icon = { tagName: 'SPAN', dataset: {}, closest: (sel) => (sel === '[data-mw]' ? btn : null) };
    ui._toggleFlag = (k) => hits.push(k);
    let fakeContainer = { contains: (t) => t === btn };
    Object.defineProperty(ui, 'container', { configurable: true, get: () => fakeContainer });
    try {
        ui._onClick({ target: icon, stopPropagation: () => stopped++ });
        eq(hits.join(), 'c:photos:zz', 'click on a child element reaches its data-mw button');
        eq(stopped, 1, 'flag click does not bubble to the row');
        fakeContainer = { contains: () => false };
        ui._onClick({ target: icon, stopPropagation: () => {} });
        eq(hits.length, 1, 'clicks outside this viewer are ignored');
    } finally { delete ui._toggleFlag; delete ui.container; }

    // 22. Locate a moved copy: same record, new store; the old store goes when nothing uses it
    const CASE2 = '2026-0778';
    fs.mkdirSync(path.join(casesRoot, CASE2), { recursive: true });
    const srcB = path.join(tmp, 'ig-return-moved');
    IG.writeReturn(srcB, { preservations: 2 });
    const pm = newModule('case-5', CASE2);
    const a1 = await pm.importWarrant(src, 'ig-return');
    pm.toggleFlag('meta', kP);
    const a2 = await pm.upgradeImport(a1.id, srcB);
    ok(a2.id === a1.id && a2.storeKey !== a1.storeKey, 'Locate: same record, new store key');
    eq(a2.fileName, 'ig-return-moved', 'Locate: file name follows the new location');
    eq(pm.flagCount(), 1, 'Locate: flags carried (content-hash keys)');
    eq(svc.list(CASE2).map(s => s.storeKey).join(','), a2.storeKey, 'Locate: the old store is removed from disk');

    // 23. a stored file the window cannot decode says so; timeline rows are typed
    const errSlot = (cls) => {
        const s = { dataset: { ref: 'linked_media/videos_1900000.mp4' }, innerHTML: '<video>', classes: [] };
        s.classList = { add: (c) => s.classes.push(c) };
        const t = { classList: { contains: (c) => c === cls }, closest: (sel) => (sel === '.mwp-media' ? s : null) };
        return { s, t };
    };
    for (const cls of ['mwp-media-img', 'mwp-media-video', 'mwp-media-audio']) {
        const { s, t } = errSlot(cls);
        ui._onMediaError({ target: t });
        ok(s.dataset.failed === '1' && s.classes.join() === 'mwp-media-missing' && /Cannot display this file/.test(s.innerHTML) && /title="linked_media\/videos_1900000\.mp4 — /.test(s.innerHTML), 'decode error replaces the ' + cls + ' with a notice');
    }
    {
        const { s, t } = errSlot('mwp-media-video');
        ui._onMediaError({ target: t });
        s.innerHTML = 'kept';
        ui._onMediaError({ target: t });
        eq(s.innerHTML + s.classes.length, 'kept1', 'decode error handled once per slot');
        const other = errSlot('mwp-lightbox-img');
        ui._onMediaError({ target: other.t });
        eq(other.s.innerHTML, '<video>', 'errors from other elements are ignored');
        ui._onMediaError({ target: null });
        ui._onMediaError({ target: { classList: { contains: () => true }, closest: () => null } });
    }
    eq(ui._eventStyle({ th: 't1', c: 'photos' }).cls, 'message', 'timeline: messages typed as message');
    eq(ui._eventStyle({ c: 'ip_addresses' }).cls, 'ip', 'timeline: IP rows typed as ip');
    eq(ui._eventStyle({ c: 'photos' }).cls, 'photo', 'timeline: photos typed as photo');
    eq(ui._eventStyle({ c: 'request_parameters' }).cls, 'status', 'timeline: anything else is plain');
    html = await ui._renderTimeline(R);
    ok(/class="mwp-timeline-event mwp-event-message mwp-row-click"/.test(html) && /<div class="mwp-timeline-dot">💬<\/div>/.test(html), 'timeline: the row carries the type, the dot an icon');

    eq(logs.error.length, 0, 'no console errors ' + JSON.stringify(logs.error));
})().catch(e => { fail++; console.log('  FAIL: threw ' + (e && e.stack)); }).then(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nmeta-ui: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
});
