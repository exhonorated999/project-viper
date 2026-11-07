'use strict';
// node modules/agency-packs/__tests__/warrant-list.test.js
const W = require('../warrant-list.js');

let pass = 0, fail = 0;
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A === B) pass++; else { fail++; console.log('FAIL: ' + m + ' — got ' + A + ', want ' + B); } };
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL: ' + m); } };

function mem(init) {
  const m = new Map(Object.entries(init || {}));
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}

// ---- keys ----
eq([W.indexKey('c1'), W.formKey('c1', 'a'), W.legacyKey('c1'), W.imagePrefix('c1', 'a')],
  ['agencyBuilderWarrants_c1', 'agencyBuilderWarrant_c1_a', 'agencyBuilderDraft_c1', 'c1|a|'], 'keys');
ok(/^aw[a-z0-9]+$/.test(W.newId(1700000000000)) && W.newId() !== W.newId(), 'newId shape + unique');

// ---- normalize ----
eq(W.normalizeEntry(null), null, 'null entry');
eq(W.normalizeEntry({ id: '../x' }), null, 'unsafe id rejected');
const n = W.normalizeEntry({ id: 'a1', templateIds: ['t1', 3], status: 'weird', createdAt: '2026-01-01', outputs: [{ name: 'x.docx', path: 'C:/D/x.docx', at: 'z' }, { path: 'nope' }, null] });
eq([n.templateIds, n.status, n.updatedAt, n.outputs], [['t1'], 'draft', '2026-01-01', [{ name: 'x.docx', path: 'C:/D/x.docx', at: 'z' }]], 'normalize fills defaults, drops junk');

// ---- legacy migration ----
{
  const legacyDraft = { packId: 'p1', templateIds: ['Warrants/A/Res_Template.docx'], values: { k: 'v', img: [{ runs: [{ image: 'abimg:c1|h1' }] }] }, county: 'North', savedAt: '2026-10-01T10:00:00.000Z' };
  const s = mem({ agencyBuilderDraft_c1: JSON.stringify(legacyDraft) });
  const r = W.migrateLegacy(s, 'c1', { id: 'm1', packName: 'Partner', templateNames: ['Residence Search'] });
  eq(r, { migrated: true, id: 'm1' }, 'migrated');
  eq(s.getItem('agencyBuilderDraft_c1'), null, 'legacy key removed');
  eq(W.readForm(s, 'c1', 'm1'), legacyDraft, 'form moved as-is (picture refs intact)');
  const L = W.readIndex(s, 'c1');
  eq([L.length, L[0].id, L[0].packId, L[0].packName, L[0].county, L[0].status, L[0].createdAt, L[0].templateNames],
    [1, 'm1', 'p1', 'Partner', 'North', 'draft', '2026-10-01T10:00:00.000Z', ['Residence Search']], 'index entry from legacy draft');
  eq(W.migrateLegacy(s, 'c1'), { migrated: false }, 'second run is a no-op');

  const s2 = mem({ agencyBuilderDraft_c2: JSON.stringify({ packId: 'p1', templateIds: [], values: {} }) });
  eq(W.migrateLegacy(s2, 'c2'), { migrated: false }, 'empty legacy draft not migrated');
  eq([s2.getItem('agencyBuilderDraft_c2'), W.readIndex(s2, 'c2')], [null, []], 'empty legacy draft dropped');
  const s3 = mem({ agencyBuilderDraft_c3: '{broken' });
  eq(W.migrateLegacy(s3, 'c3').migrated, false, 'broken legacy draft ignored');
  const s4 = mem({});
  eq(W.migrateLegacy(s4, 'c4'), { migrated: false }, 'nothing to migrate');

  // Storage full: the legacy form stays where it was.
  const s5 = mem({ agencyBuilderDraft_c5: JSON.stringify(legacyDraft) });
  s5.setItem = () => { throw new Error('QuotaExceeded'); };
  eq(W.migrateLegacy(s5, 'c5', { id: 'q' }).migrated, false, 'quota: not migrated');
  ok(s5.getItem('agencyBuilderDraft_c5'), 'quota: legacy draft kept');
}

// ---- upsert / outputs / remove ----
{
  const s = mem({});
  const e1 = W.upsert(s, 'c1', { id: 'a', packId: 'p', templateIds: ['t1'], templateNames: ['One'], updatedAt: '2026-11-01T00:00:00Z' });
  eq([e1.createdAt, e1.updatedAt, e1.status], ['2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'draft'], 'new entry: createdAt = first save');
  W.upsert(s, 'c1', { id: 'b', packId: 'p', templateIds: ['t2', 't3'], templateNames: ['Two', 'Three'], updatedAt: '2026-11-03T00:00:00Z' });
  const e1b = W.upsert(s, 'c1', { id: 'a', templateIds: ['t1', 't4'], templateNames: ['One', 'Four'], updatedAt: '2026-11-02T00:00:00Z' });
  eq([e1b.createdAt, e1b.packId, e1b.templateIds], ['2026-11-01T00:00:00Z', 'p', ['t1', 't4']], 'update keeps createdAt + unspecified fields');
  eq(W.sorted(W.readIndex(s, 'c1')).map(e => e.id), ['b', 'a'], 'newest first');

  const files = [{ name: 'x.docx', path: 'D:/x.docx' }, { name: 'y.docx', path: 'D:/y.docx' }];
  const c = W.addOutputs(s, 'c1', 'a', files, '2026-11-04T00:00:00Z');
  eq([c.status, c.updatedAt, c.outputs.length, c.outputs[1]], ['created', '2026-11-04T00:00:00Z', 2, { name: 'y.docx', path: 'D:/y.docx', at: '2026-11-04T00:00:00Z' }], 'outputs recorded, status created');
  eq(W.addOutputs(s, 'c1', 'zz', files, 'x'), null, 'outputs for unknown warrant');
  for (let i = 0; i < 30; i++) W.addOutputs(s, 'c1', 'a', [{ name: 'f' + i + '.docx' }], 'z');
  const capped = W.readIndex(s, 'c1').find(e => e.id === 'a').outputs;
  eq([capped.length, capped[capped.length - 1].name], [W.MAX_OUTPUTS, 'f29.docx'], 'outputs capped, newest kept');

  // status stays created when the form is edited again
  eq(W.upsert(s, 'c1', { id: 'a', updatedAt: '2026-11-05T00:00:00Z' }).status, 'created', 'edit keeps created');

  s.setItem(W.formKey('c1', 'b'), '{}');
  eq(W.remove(s, 'c1', 'b'), true, 'remove');
  eq([W.readIndex(s, 'c1').map(e => e.id), s.getItem(W.formKey('c1', 'b'))], [['a'], null], 'removed from list and its form deleted');
  eq(W.remove(s, 'c1', 'b'), false, 'remove twice');
  eq(W.readIndex(mem({ agencyBuilderWarrants_c9: 'nope' }), 'c9'), [], 'corrupt index → empty');
  eq(W.readForm(s, 'c1', 'missing'), null, 'missing form');
}

// ---- title ----
eq(W.title(W.normalizeEntry({ id: 'a', templateNames: ['Residence Search'] })), 'Residence Search', 'title one');
eq(W.title(W.normalizeEntry({ id: 'a', templateNames: ['A', 'B', 'C'] })), 'A + 2 more', 'title several');
eq(W.title(W.normalizeEntry({ id: 'a', templateIds: ['Warrants/Res/Residence Search_Template.docx'] })), 'Residence Search', 'title from id');
eq(W.title(W.normalizeEntry({ id: 'a' })), 'Untitled warrant', 'title none');

// ---- pictures ----
eq(W.referencedImages('{"v":[{"runs":[{"image":"abimg:c1|a|h1"},{"image":"abimg:c1|h0"},{"image":"data:x"}]}]}'), ['c1|a|h1', 'c1|h0'], 'referenced images');
eq(W.referencedImages(null), [], 'no json');
const keys = ['c1|a|h1', 'c1|a|h2', 'c1|gone|h3', 'c1|h0', 'c1|h9', 'c10|x|y', 'other', 42];
eq(W.orphanImageKeys(keys, 'c1', ['a'], ['c1|h0']), ['c1|gone|h3', 'c1|h9'], 'orphans: deleted warrant + unused old-style keys only');
eq(W.orphanImageKeys(keys, 'c1', ['a', 'gone'], ['c1|h0', 'c1|h9']), [], 'nothing orphaned');

console.log(`warrant-list: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
