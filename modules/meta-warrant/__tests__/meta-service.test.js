/**
 * Meta return service (the main-process half of the Meta Warrant module):
 * case-folder confinement, scan, one-import-per-case guard, the light record
 * the renderer stores, overview/query, media URLs (plain + vault-encrypted),
 * delete and temp cleanup.
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\electron\dist\electron.exe modules\meta-warrant\__tests__\meta-service.test.js
 *      (plain `node` works too)
 */
'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const IG = require('./fixtures/ig-fixture');
const Store = require('../meta-warrant-store');
const { createService } = require('../meta-warrant-service');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
async function rejects(p, re, name) {
    let err = null;
    try { await p; } catch (e) { err = e; }
    ok(!!err && re.test(err.message), name + (err ? ' (' + err.message + ')' : ' (did not throw)'));
    return err;
}
function throws(fn, re, name) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    ok(!!err && re.test(err.message), name + (err ? ' (' + err.message + ')' : ' (did not throw)'));
    return err;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-meta-svc-'));
const casesRoot = path.join(tmp, 'cases');
const tempDir = path.join(tmp, 'view-temp');
fs.mkdirSync(casesRoot, { recursive: true });

async function zipFolder(dir, zipPath) {
    const JSZip = require('jszip');
    const z = new JSZip();
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(abs, r); else z.file(r, fs.readFileSync(abs));
        }
    };
    walk(dir, '');
    fs.writeFileSync(zipPath, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

(async () => {
    let unlocked = true;
    let decrypts = 0;
    const vault = {
        isUnlocked: () => unlocked,
        encryptBuffer: (b) => Buffer.concat([Buffer.from('VENC'), b]),
        isEncryptedBuffer: (b) => b.slice(0, 4).toString() === 'VENC',
        decryptBuffer: (b) => { decrypts++; return b.slice(4); }
    };
    let sec = null;
    const issued = [];
    let fpMode = 'ok';
    const svc = createService({
        casesDir: () => casesRoot,
        security: () => sec,
        tempDir,
        issueToken: (abs) => { issued.push(abs); return 'tok' + issued.length; },
        fingerprint: async (spec) => {
            if (fpMode === 'throw') throw new Error('fingerprint exploded');
            return { sha256: 'abc', path: spec.path };
        }
    });

    // 1. case folder confinement
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', '../x', 'x\0y', null, undefined]) {
        throws(() => svc.caseDirOf(bad), /Invalid case number/, 'caseDirOf refuses ' + JSON.stringify(bad));
    }
    if (process.platform === 'win32') {
        throws(() => svc.caseDirOf('C:evil'), /Invalid case number/, 'caseDirOf refuses a drive-relative name');
    }
    eq(svc.caseDirOf('2026-0042'), path.join(casesRoot, '2026-0042'), 'caseDirOf plain case number');
    eq(svc.caseDirOf(1234), path.join(casesRoot, '1234'), 'caseDirOf numeric case number');
    await rejects(svc.scan('..'), /Invalid case number/, 'scan refuses traversal');
    await rejects(svc.importReturn({ caseNumber: '../../x', sourcePath: tmp }), /Invalid case number/, 'import refuses traversal');
    throws(() => svc.query('a/b', 'k', {}), /Invalid case number/, 'query refuses traversal');
    throws(() => svc.mediaUrl('..', 'k', 'x'), /Invalid case number/, 'mediaUrl refuses traversal');
    throws(() => svc.remove('..', 'k'), /Invalid case number/, 'remove refuses traversal');

    // 2. scan
    const src = path.join(tmp, 'ig-return');
    const gen = IG.writeReturn(src, { preservations: 3 });
    const caseA = '2026-0001';
    const caseDirA = path.join(casesRoot, caseA);
    const evSub = path.join(caseDirA, 'Evidence', 'Instagram');
    const prod = path.join(caseDirA, 'Warrants', 'Production', 'deep', 'er');
    fs.mkdirSync(evSub, { recursive: true });
    fs.mkdirSync(prod, { recursive: true });
    const zipEv = path.join(evSub, 'ig return.zip');
    await zipFolder(src, zipEv);
    fs.copyFileSync(zipEv, path.join(prod, 'copy.ZIP'));
    // not a Meta return
    const notMeta = path.join(tmp, 'notmeta');
    fs.mkdirSync(notMeta);
    fs.writeFileSync(path.join(notMeta, 'readme.txt'), 'hello');
    await zipFolder(notMeta, path.join(evSub, 'other.zip'));
    // a zip sitting inside the module's own store folder is never offered
    const ownRoot = Store.returnsRoot(caseDirA);
    fs.mkdirSync(path.join(ownRoot, 'abc'), { recursive: true });
    fs.copyFileSync(zipEv, path.join(ownRoot, 'abc', 'inside-store.zip'));
    // somewhere outside Evidence / Warrants\Production
    fs.mkdirSync(path.join(caseDirA, 'Misc'), { recursive: true });
    fs.copyFileSync(zipEv, path.join(caseDirA, 'Misc', 'elsewhere.zip'));

    const found = await svc.scan(caseA);
    const names = found.map(f => f.name).sort();
    eq(names.join('|'), 'copy.ZIP|ig return.zip', 'scan finds Meta zips in Evidence + Warrants/Production only');
    const fEv = found.find(f => f.name === 'ig return.zip');
    eq(fEv && fEv.path, zipEv, 'scan returns the absolute path');
    eq(fEv && fEv.size, fs.statSync(zipEv).size, 'scan returns the size');
    eq((await svc.scan('2026-9999')).length, 0, 'scan of a case with no folder = empty');
    fs.rmSync(path.join(ownRoot, 'abc'), { recursive: true, force: true });

    // 3. import: guards
    await rejects(svc.importReturn({ caseNumber: caseA, sourcePath: path.join(tmp, 'nope.zip') }), /could not be found/, 'missing source rejected');
    await rejects(svc.importReturn({ caseNumber: caseA, sourcePath: '' }), /could not be found/, 'empty source rejected');

    const phases = [];
    const p1 = svc.importReturn({ caseNumber: caseA, sourcePath: zipEv }, p => phases.push(p.phase));
    eq(svc.isImporting(caseA), true, 'isImporting while running');
    eq(svc.isImporting('2026-0002'), false, 'isImporting is per case');
    await rejects(svc.importReturn({ caseNumber: caseA, sourcePath: src }), /already being imported/, 'second import for the same case rejected');
    throws(() => svc.remove(caseA, Store.storeKeyFor(zipEv)), /running import/, 'delete refused during an import');
    const rec = await p1;
    eq(svc.isImporting(caseA), false, 'isImporting cleared after success');
    eq(phases[phases.length - 1], 'done', 'progress forwarded');

    // 4. the light record
    eq(rec.storeKey, Store.storeKeyFor(zipEv), 'record.storeKey defaults to storeKeyFor(source)');
    eq(rec.service, 'Instagram', 'record.service');
    eq(rec.targetId, IG.TARGET, 'record.targetId');
    eq(rec.pages.length, 4, 'record.pages');
    eq(rec.pages.map(p => p.kind).join(), 'records,preservation,preservation,preservation', 'record.pages kinds');
    ok(rec.pages.every(p => typeof p.items === 'number' && Object.keys(p).length === 3), 'record.pages only name/kind/items');
    eq(rec.mediaMissing, gen.truth.missingMedia, 'record.mediaMissing');
    eq(rec.encrypted, false, 'record.encrypted (vault off)');
    ok(rec.totals && typeof rec.totals === 'object', 'record.totals');
    eq(rec.sourceIntegrity && rec.sourceIntegrity.sha256, 'abc', 'record.sourceIntegrity from the fingerprint');
    eq(rec.sourceIntegrity && rec.sourceIntegrity.path, zipEv, 'fingerprint given the source path');
    ok(!('threads' in rec) && !('categories' in rec) && !('index' in rec), 'record carries no bulk data');
    ok(JSON.stringify(rec).length < 4000, 'record is small (' + JSON.stringify(rec).length + ' chars)');
    const meta = Store.readMeta(Store.storeDir(caseDirA, rec.storeKey));
    eq(meta && meta.fileName, 'ig return.zip', 'store meta keeps the file name');
    eq(meta && meta.sourcePath, zipEv, 'store meta keeps the source path');

    // fingerprint failure never fails the import; custom store key is sanitised
    fpMode = 'throw';
    const recB = await svc.importReturn({ caseNumber: caseA, sourcePath: src, storeKey: '../Folder Key!' });
    fpMode = 'ok';
    eq(recB.storeKey, 'FolderKey', 'custom storeKey sanitised');
    eq(recB.sourceIntegrity, null, 'fingerprint failure -> sourceIntegrity null');
    ok(fs.existsSync(path.join(ownRoot, 'FolderKey')), 'custom store written inside the returns folder');

    // a failed import releases the guard
    const broken = path.join(tmp, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'records.html'), '<html><body>nope</body></html>');
    await rejects(svc.importReturn({ caseNumber: caseA, sourcePath: broken, storeKey: 'brk' }), /No Meta pages/, 'non-Meta source rejected');
    eq(svc.isImporting(caseA), false, 'isImporting cleared after failure');

    // 5. overview / query / list
    const ov = svc.overview(caseA, rec.storeKey);
    ok(!!ov, 'overview found');
    ok(!('threads' in ov), 'overview drops the thread list');
    eq(ov.threadCount, 2, 'overview.threadCount');
    ok(Array.isArray(ov.categories) && ov.categories.length === gen.truth.categories, 'overview keeps categories');
    eq(svc.overview(caseA, 'doesnotexist'), null, 'overview of an unknown store = null');
    const q = svc.query(caseA, rec.storeKey, { kind: 'items', cat: 'likes', limit: 5 });
    eq(q.rows.length, 5, 'query forwards to the store');
    eq(q.total, gen.truth.items.likes.count, 'query total');
    const listed = svc.list(caseA).map(s => s.storeKey).sort();
    eq(listed.join(), [rec.storeKey, 'FolderKey'].sort().join(), 'list = the two stores');

    // 6. media URL, vault off
    const P = '';
    const plain = svc.mediaUrl(caseA, rec.storeKey, P + 'linked_media/unified_message_4400004.txt');
    eq(plain.found, true, 'mediaUrl found');
    eq(plain.fileUrl, 'viper-media://m/tok' + issued.length, 'mediaUrl is a viper-media token URL');
    ok(issued[issued.length - 1].indexOf(Store.returnsRoot(caseDirA)) === 0, 'plain media served straight from the store');
    eq(plain.mime, 'audio/ogg', 'mediaUrl mime (sniffed voice note)');
    eq(plain.kind, 'audio', 'mediaUrl kind');
    eq(plain.sniffed, true, 'mediaUrl sniffed flag');
    eq(plain.name, 'linked_media/unified_message_4400004.txt', 'mediaUrl name = original name');
    eq(svc.mediaUrl(caseA, rec.storeKey, 'linked_media/not_there.jpg').found, false, 'unknown ref -> found:false');
    eq(svc.mediaUrl(caseA, rec.storeKey, '').found, false, 'empty ref -> found:false');
    eq(svc.mediaUrl(caseA, rec.storeKey, 'linked_media/unified_message_MISSING.jpg').found, false, 'referenced-but-not-shipped -> found:false');
    ok(!fs.existsSync(tempDir), 'plain media never touches the temp folder');

    // 7. media URL, vault on
    sec = vault;
    const caseV = '2026-0003';
    const recV = await svc.importReturn({ caseNumber: caseV, sourcePath: src });
    eq(recV.encrypted, true, 'record.encrypted (vault on)');
    const ref = 'linked_media/photos_1800000.jpg';
    const original = fs.readFileSync(path.join(src, ref));
    unlocked = false;
    const lockedErr = throws(() => svc.mediaUrl(caseV, recV.storeKey, ref), /Unlock VIPER/, 'locked vault -> clear message');
    eq(lockedErr && lockedErr.code, 'VIPER_LOCKED', 'locked vault -> code VIPER_LOCKED');
    ok(!fs.existsSync(tempDir), 'locked vault writes nothing');
    sec = null;
    eq((throws(() => svc.mediaUrl(caseV, recV.storeKey, ref), /Unlock VIPER/, 'no vault object -> locked') || {}).code, 'VIPER_LOCKED', 'no vault object -> code VIPER_LOCKED');
    sec = vault;
    unlocked = true;
    decrypts = 0;
    const encU = svc.mediaUrl(caseV, recV.storeKey, ref);
    eq(encU.found, true, 'encrypted media found');
    const served = issued[issued.length - 1];
    ok(served.indexOf(path.join(tempDir, recV.storeKey)) === 0, 'encrypted media served from the temp copy (' + served + ')');
    ok(Buffer.compare(fs.readFileSync(served), original) === 0, 'temp copy = original bytes');
    eq(decrypts, 1, 'decrypted once');
    svc.mediaUrl(caseV, recV.storeKey, ref);
    eq(decrypts, 1, 'second view reuses the temp copy');
    fs.writeFileSync(served, Buffer.from('trunc'));
    svc.mediaUrl(caseV, recV.storeKey, ref);
    eq(decrypts, 2, 'a damaged temp copy is decrypted again');
    ok(Buffer.compare(fs.readFileSync(served), original) === 0, 'temp copy repaired');
    const atRest = Store.mediaPath(Store.storeDir(path.join(casesRoot, caseV), recV.storeKey), ref).path;
    eq(fs.readFileSync(atRest).slice(0, 4).toString(), 'VENC', 'store copy stays encrypted');

    // re-import drops the old decrypted copies
    await svc.importReturn({ caseNumber: caseV, sourcePath: src });
    ok(!fs.existsSync(path.join(tempDir, recV.storeKey)), 're-import clears that store\'s temp copies');
    svc.mediaUrl(caseV, recV.storeKey, ref);
    ok(fs.existsSync(path.join(tempDir, recV.storeKey)), 'temp copy recreated on next view');

    // 8. delete
    eq(svc.remove(caseV, recV.storeKey), true, 'remove returns true');
    ok(!fs.existsSync(Store.storeDir(path.join(casesRoot, caseV), recV.storeKey)), 'remove deletes the store');
    ok(!fs.existsSync(path.join(tempDir, recV.storeKey)), 'remove deletes the temp copies');
    eq(svc.overview(caseV, recV.storeKey), null, 'overview after delete = null');
    eq(svc.list(caseV).length, 0, 'list after delete = empty');
    ok(fs.existsSync(zipEv), 'remove never touches the source zip');
    ok(!!svc.overview(caseA, rec.storeKey), 'other case untouched');

    // 9. clearTemp
    svc.mediaUrl(caseA, rec.storeKey, ref);     // plain: no temp
    fs.mkdirSync(path.join(tempDir, 'leftover'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'leftover', 'x.jpg'), 'x');
    svc.clearTemp();
    ok(!fs.existsSync(tempDir), 'clearTemp removes decrypted leftovers');
    svc.clearTemp();
    ok(true, 'clearTemp on a missing folder is harmless');
    const noTemp = createService({ casesDir: () => casesRoot });
    noTemp.clearTemp();
    ok(true, 'clearTemp without a tempDir is harmless');
    eq(noTemp.overview(caseA, rec.storeKey).threadCount, 2, 'service works without optional host hooks');
    const recN = await noTemp.importReturn({ caseNumber: '2026-0004', sourcePath: src });
    eq(recN.sourceIntegrity, null, 'no fingerprint hook -> sourceIntegrity null');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nResult: ${pass} / ${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack); process.exit(1); });
