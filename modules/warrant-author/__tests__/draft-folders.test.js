// modules/warrant-author/__tests__/draft-folders.test.js
// Readable per-draft folders under cases/<n>/Warrants/Drafts/ and the
// guarded Word/PDF writes that never destroy an officer's edit.
// Temp directories only; SYNTHETIC data.
//
// Run: node modules/warrant-author/__tests__/draft-folders.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require(path.join(__dirname, '..', 'draft-folders.js'));

let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL:', msg, extra === undefined ? '' : JSON.stringify(extra)); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, exp: b }); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-folders-'));
let n = 0;
function freshRoot() { const r = path.join(TMP, 'case' + (++n), 'Warrants', 'Drafts'); fs.mkdirSync(r, { recursive: true }); return r; }
const ls = (r) => fs.readdirSync(r).sort();

try {
  console.log('— labels');
  eq(F.buildLabel({ swNumber: '24-001', addendums: [{ providerKey: 'google' }] }, ['Google']), 'Google ESP - SW 24-001', 'one provider + SW');
  eq(F.buildLabel({ addendums: [] }, []), 'ESP Warrant', 'no providers, no SW');
  eq(F.buildLabel({ swNumber: ' 7 ' }, ['Google', 'Meta']), 'Google & Meta ESP - SW 7', 'two providers');
  eq(F.buildLabel({}, ['Google', 'Meta', 'Snap', 'X']), 'Google, Meta + 2 more ESP', 'four providers');
  eq(F.buildLabel({}, ['Google', 'google']), 'Google ESP', 'duplicate names once');
  eq(F.buildLabel({ addendums: [{ providerKey: 'google' }, { providerKey: 'some_isp' }] }), 'Google & Some Isp ESP', 'keys title-cased without display names');
  eq(F.buildLabel({ type: 'residential', swNumber: '24-9' }, []), 'Residential - SW 24-9', 'residential');
  eq(F.safeFolderName('Google ESP - SW 24/001'), 'Google ESP - SW 24-001', 'slash becomes dash');
  eq(F.safeFolderName('A:B*C?"<>|'), 'A B C', 'illegal characters');
  eq(F.safeFolderName('Meta ESP - SW 5.'), 'Meta ESP - SW 5', 'trailing dot dropped');
  eq(F.safeFolderName('CON'), '_CON', 'reserved device name');
  eq(F.safeFolderName('   ', 'wa-1'), 'wa-1', 'empty → fallback');
  ok(F.safeFolderName('x'.repeat(300)).length <= 80, 'length capped');
  eq(F.labelFor({ swNumber: '1' }), null, 'no hint → null (keep existing name)');
  eq(F.labelFor({ swNumber: '1', folderProviders: ['Google'] }), 'Google ESP - SW 1', 'folderProviders hint');
  eq(F.labelFor({ folderLabel: ' Mine ', folderProviders: ['Google'] }), 'Mine', 'explicit folderLabel wins');
  eq(F.labelFor({ type: 'residential', folderProviders: [] }), 'Residential', 'residential hint');
  const ed = F._editedName('warrant.docx', new Date(2026, 10, 17, 14, 32));
  eq(ed, 'warrant (edited 2026-11-17 1432).docx', 'edited-copy name');

  console.log('— ensureDir / findDir');
  {
    const root = freshRoot();
    const a = F.ensureDir(root, 'wa-a', 'Google ESP');
    ok(a.created && path.basename(a.dir) === 'Google ESP', 'new readable folder', a);
    eq(F.readSidecar(a.dir).id, 'wa-a', 'sidecar names the id');
    eq(F.findDir(root, 'wa-a'), a.dir, 'found by sidecar');
    const a2 = F.ensureDir(root, 'wa-a', 'Google ESP');
    ok(!a2.created && !a2.renamed && a2.dir === a.dir, 'same label → same folder');
    fs.writeFileSync(path.join(a.dir, 'manifest.json'), '{}');
    const a3 = F.ensureDir(root, 'wa-a', 'Google ESP - SW 24-001');
    ok(a3.renamed && path.basename(a3.dir) === 'Google ESP - SW 24-001', 'label change → renamed', a3);
    ok(fs.existsSync(path.join(a3.dir, 'manifest.json')), 'files travel with the rename');
    ok(!fs.existsSync(a.dir), 'old name gone');
    const a4 = F.ensureDir(root, 'wa-a', null);
    ok(a4.dir === a3.dir && !a4.renamed, 'no label → existing name kept');

    const b = F.ensureDir(root, 'wa-b', 'Google ESP - SW 24-001');
    eq(path.basename(b.dir), 'Google ESP - SW 24-001 (2)', 'same label for another draft → numbered twin');
    const b2 = F.ensureDir(root, 'wa-b', 'Google ESP - SW 24-001');
    ok(b2.dir === b.dir && !b2.renamed, 'numbered twin is stable');
    eq(F.findDir(root, 'wa-a'), a3.dir, 'each id still maps to its own folder (a)');
    eq(F.findDir(root, 'wa-b'), b.dir, 'each id still maps to its own folder (b)');
    eq(F.findDir(root, 'wa-zzz'), null, 'unknown id → null');
    const ids = F.listEntries(root).map(e => e.id).sort();
    eq(ids, ['wa-a', 'wa-b'], 'listEntries reports ids, not folder names');
    const c = F.ensureDir(root, 'wa-c', null, { swNumber: '9', addendums: [{ providerKey: 'meta' }] });
    eq(path.basename(c.dir), 'Meta ESP - SW 9', 'new folder without hint → derived from the draft');
  }

  console.log('— legacy id folders');
  {
    const root = freshRoot();
    const legacy = path.join(root, 'wa-old');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'manifest.json'), '{"id":"wa-old"}');
    fs.writeFileSync(path.join(legacy, 'warrant.pdf'), 'PDF');
    eq(F.findDir(root, 'wa-old'), legacy, 'legacy folder found by name');
    eq(F.listEntries(root).map(e => e.id), ['wa-old'], 'legacy folder listed by name');
    const kept = F.ensureDir(root, 'wa-old', null);
    ok(kept.dir === legacy, 'no label → legacy name kept');
    const moved = F.ensureDir(root, 'wa-old', 'Snap ESP - SW 3');
    ok(moved.renamed && path.basename(moved.dir) === 'Snap ESP - SW 3', 'legacy folder gets its readable name');
    eq(fs.readFileSync(path.join(moved.dir, 'warrant.pdf'), 'utf8'), 'PDF', 'legacy files kept');
    eq(F.readSidecar(moved.dir).id, 'wa-old', 'sidecar written on migration');
    eq(F.findDir(root, 'wa-old'), moved.dir, 'found after migration');
  }

  console.log('— rename refused (folder in use)');
  {
    const root = freshRoot();
    const a = F.ensureDir(root, 'wa-a', 'One');
    const real = fs.renameSync;
    fs.renameSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
    let r;
    try { r = F.ensureDir(root, 'wa-a', 'Two'); } finally { fs.renameSync = real; }
    ok(r.dir === a.dir && !r.renamed, 'keeps the current folder when Windows refuses the rename', r);
    const r2 = F.ensureDir(root, 'wa-a', 'Two');
    ok(r2.renamed && path.basename(r2.dir) === 'Two', 'retried on the next save');
  }

  console.log('— guarded writes');
  {
    const root = freshRoot();
    const { dir } = F.ensureDir(root, 'wa-w', 'W');
    const w1 = F.writeGuarded(dir, 'warrant.docx', Buffer.from('v1'), { id: 'wa-w' });
    ok(w1.written && !w1.keptAs, 'first write', w1);
    ok(F.readSidecar(dir).files['warrant.docx'].size === 2, 'stamp recorded');
    eq(F.readSidecar(dir).id, 'wa-w', 'sidecar id kept');
    const w2 = F.writeGuarded(dir, 'warrant.docx', Buffer.from('v2!'), { id: 'wa-w' });
    ok(w2.written && !w2.keptAs, 'untouched file is simply refreshed', w2);
    eq(fs.readFileSync(path.join(dir, 'warrant.docx'), 'utf8'), 'v2!', 'fresh content');

    // The officer edits the Word file.
    const p = path.join(dir, 'warrant.docx');
    fs.writeFileSync(p, 'officer edit');
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(p, later, later);
    const w3 = F.writeGuarded(dir, 'warrant.docx', Buffer.from('v3'), { id: 'wa-w', now: new Date(2026, 10, 17, 9, 5) });
    ok(w3.written && w3.keptAs === 'warrant (edited 2026-11-17 0905).docx', 'edit kept aside', w3);
    eq(fs.readFileSync(path.join(dir, w3.keptAs), 'utf8'), 'officer edit', 'officer text intact');
    eq(fs.readFileSync(p, 'utf8'), 'v3', 'fresh copy written');
    const w4 = F.writeGuarded(dir, 'warrant.docx', Buffer.from('v4'), { id: 'wa-w', now: new Date(2026, 10, 17, 9, 5) });
    ok(w4.written && !w4.keptAs, 'no second aside copy when nothing changed', w4);

    // Same-size edit, only the time moved.
    fs.writeFileSync(p, 'zz');
    const later2 = new Date(Date.now() + 120000);
    fs.utimesSync(p, later2, later2);
    const w5 = F.writeGuarded(dir, 'warrant.docx', Buffer.from('v5'), { id: 'wa-w', now: new Date(2026, 10, 17, 9, 5) });
    eq(w5.keptAs, 'warrant (edited 2026-11-17 0905) (2).docx', 'same-size edit detected; aside name stays unique');

    // Word holds the file open.
    const realW = fs.writeFileSync;
    fs.writeFileSync = (f, ...rest) => {
      if (String(f).endsWith('warrant.pdf')) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; }
      return realW(f, ...rest);
    };
    let w6;
    try { w6 = F.writeGuarded(dir, 'warrant.pdf', Buffer.from('pdf'), { id: 'wa-w' }); } finally { fs.writeFileSync = realW; }
    ok(!w6.written && w6.busy && !w6.error, 'open file → busy, not an error', w6);

    const names = ls(dir);
    ok(names.includes('.viper-draft.json') && names.includes('warrant.docx'), 'folder contents', names);
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) {}
}

console.log(`\ndraft-folders: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
