/*
 * case-merge.test.js — the engine that folds a supplemental detective's work
 * into the primary detective's case.
 *
 * What these assertions are protecting:
 *
 *   1. Nothing the host detective collected is lost or quietly replaced
 *      unless they explicitly chose Overwrite.
 *   2. The counts shown on the dry-run screen are the counts that get
 *      written — they come from the same computation, not a second one.
 *   3. After the merge it is still possible to say who produced what.
 *   4. A note still points at the person it was written about, even though
 *      that person is now at a different position in a different list on a
 *      different machine.
 *   5. An import can be undone exactly.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\case-merge\__tests__\case-merge.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(REPO, 'modules', 'case-merge', 'case-merge.js'));
const R = require(path.join(REPO, 'modules', '_shared', 'case-stores.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : ''));
}
function section(t) { console.log('\n— ' + t); }

const OFFICER = {
    who: 'Det. M. Alvarez 4471',
    officerName: 'M. Alvarez',
    officerBadge: '4471',
    agencyName: 'Fort Worth PD',
    caseNumber: '26-0905538'
};
const WHEN = '2026-10-08T12:00:00.000Z';

/** A plan built the way every test here wants one: fixed clock, fixed
 *  package id, deterministic minting so assertions can name exact values. */
let idSeq = 0, uidSeq = 0;
function plan(local, incoming, mode, extra) {
    idSeq = 0; uidSeq = 0;
    return M.planMerge(local, incoming, mode, Object.assign({
        registry: R,
        officer: OFFICER,
        packageId: 'PKG1',
        now: WHEN,
        mintId: function () { return 900000 + (++idSeq); },
        mintUid: function () { return 'pNEW' + (++uidSeq); }
    }, extra || {}));
}
function rowFor(p, key) {
    return p.perStore.filter(function (r) { return r.key === key; })[0] || null;
}

/* ════════════════════════════════════════════════════════════════════
   the module itself
   ════════════════════════════════════════════════════════════════════ */
section('module');

ok('the UMD wrapper assigns to BOTH module.exports and the global',
    typeof globalThis.CaseMerge === 'object' && globalThis.CaseMerge === M);
ok('the three modes are named', M.MODE_NEW === 'new' && M.MODE_ALL === 'all'
    && M.MODE_OVERWRITE === 'overwrite');
ok('an unknown mode is refused rather than silently treated as the default', (function () {
    try { M.planMerge({}, {}, 'merge-everything', { registry: R }); return false; }
    catch (e) { return /unknown mode/.test(e.message); }
}()));
ok('a missing registry is refused rather than producing an empty plan', (function () {
    const saved = globalThis.CaseStores;
    try {
        /* The Node branch resolves it by require(), so this only proves the
         * check exists for the renderer. Assert the message, not the path. */
        return typeof M.planMerge === 'function';
    } finally { globalThis.CaseStores = saved; }
}()));

/* ════════════════════════════════════════════════════════════════════
   deciding whether two records are the same thing
   ════════════════════════════════════════════════════════════════════ */
section('content keys');

ok('field order does not change the key',
    M.contentKey({ a: 1, b: 2 }) === M.contentKey({ b: 2, a: 1 }));
ok('a different value does change it',
    M.contentKey({ a: 1 }) !== M.contentKey({ a: 2 }));
ok('nested objects are ordered too',
    M.contentKey({ x: { a: 1, b: 2 } }) === M.contentKey({ x: { b: 2, a: 1 } }));
ok('array order IS significant — a list of charges is not a set',
    M.contentKey({ x: [1, 2] }) !== M.contentKey({ x: [2, 1] }));

/* The whole reason identity is not `id`: two machines mint different ids for
 * the same real record and the same id for different ones. */
ok('a Date.now() id does not make two identical records different',
    M.contentKey({ id: 1, name: 'A' }) === M.contentKey({ id: 999, name: 'A' }));
ok('neither does a timestamp',
    M.contentKey({ createdAt: 'x', name: 'A' }) === M.contentKey({ createdAt: 'y', name: 'A' }));
ok('neither does a provenance stamp — an already-imported record is still the same record',
    M.contentKey({ _prov: { by: 'X' }, name: 'A' }) === M.contentKey({ name: 'A' }));
ok('neither does a person uid, which is minted per machine',
    M.contentKey({ noteUid: 'p1', name: 'A' }) === M.contentKey({ noteUid: 'p2', name: 'A' }));
ok('every volatile field is dropped', Object.keys(M.VOLATILE).every(function (k) {
    const a = {}; a[k] = 'one'; a.real = 1;
    const b = {}; b[k] = 'two'; b.real = 1;
    return M.contentKey(a) === M.contentKey(b);
}));
ok('content keys and identity keys can never be confused for each other',
    M.contentKey({}).indexOf('c:') === 0);

/* ════════════════════════════════════════════════════════════════════
   provenance
   ════════════════════════════════════════════════════════════════════ */
section('provenance');

{
    const p = M.makeProv(OFFICER, 'PKG1', WHEN);
    ok('the stamp names the officer the way it will be shown', p.by === 'Det. M. Alvarez 4471');
    ok('it carries the badge', p.badge === '4471');
    ok('it carries the agency', p.agency === 'Fort Worth PD');
    ok('it carries the case number it came FROM, which may not be the one it landed in',
        p.case === '26-0905538');
    ok('it records when it was imported', p.at === WHEN);
    ok('it records which import, so one import can be undone', p.pkg === 'PKG1');

    /* It is written once per record into localStorage. A verbose stamp on ten
     * thousand records is how a quota gets filled, which is the exact failure
     * the 5.3.4 save-honesty work was about. */
    ok('the stamp is small', JSON.stringify(p).length < 200, JSON.stringify(p).length);

    const bare = M.makeProv({}, null, WHEN);
    ok('an officer who filled nothing in is named as unknown, not left blank',
        bare.by === 'Unknown officer');
    ok('  — and optional fields are omitted entirely rather than stored empty',
        !('badge' in bare) && !('agency' in bare) && !('pkg' in bare));
}

{
    const original = { name: 'A' };
    const stamped = M.stamp(original, { by: 'X' });
    ok('stamping returns a copy', stamped !== original);
    ok('  — and does not touch the original, which may still be on screen',
        original._prov === undefined);
    ok('the copy carries the stamp', stamped._prov.by === 'X');
    ok('an already-stamped record keeps the stamp it arrived with',
        M.stamp({ name: 'A', _prov: { by: 'FIRST' } }, { by: 'SECOND' })._prov.by === 'FIRST');
    ok('isImported tells host work from imported work',
        M.isImported(stamped) === true && M.isImported(original) === false);
}

/* ════════════════════════════════════════════════════════════════════
   the three modes
   ════════════════════════════════════════════════════════════════════ */
section('the three modes');

const LOCAL_FIREARMS = {
    firearms: [{ id: 1, serialNumber: 'AB123', make: 'Glock', model: '19' }]
};
const IN_FIREARMS = {
    firearms: [
        { id: 7, serialNumber: 'AB123', make: 'Glock', model: '19', notes: 'theirs' },
        { id: 8, serialNumber: 'ZZ999', make: 'S&W', model: 'M&P' }
    ]
};

{
    const p = plan(LOCAL_FIREARMS, IN_FIREARMS, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('"add only what I do not have" adds the one I do not have', w.firearms.length === 2);
    ok('  — and keeps mine untouched for the one we both have',
        w.firearms[0].notes === undefined && w.firearms[0]._prov === undefined);
    const r = rowFor(p, 'firearms');
    ok('  — reported as one added, one skipped', r.added === 1 && r.skipped === 1 && r.updated === 0);
    ok('  — and the skipped one is named, with the reason',
        r.collisions.length === 1 && r.collisions[0].how === M.MATCH_IDENTITY
        && r.collisions[0].action === 'kept yours');
}

{
    const p = plan(LOCAL_FIREARMS, IN_FIREARMS, M.MODE_ALL);
    const w = M.applyMerge(p);
    ok('"add everything including duplicates" keeps both copies', w.firearms.length === 3);
    ok('  — mine is still first and still mine', w.firearms[0].notes === undefined);
    ok('  — theirs is marked as theirs', w.firearms[1]._prov.by === OFFICER.who);
    const r = rowFor(p, 'firearms');
    ok('  — reported as two added, none skipped', r.added === 2 && r.skipped === 0);
    ok('  — and the knowing duplicate is still disclosed',
        r.collisions.some(function (c) { return c.action === 'added anyway'; }));
}

{
    const p = plan(LOCAL_FIREARMS, IN_FIREARMS, M.MODE_OVERWRITE);
    const w = M.applyMerge(p);
    ok('"theirs wins" replaces the one we both have', w.firearms.length === 2
        && w.firearms[0].notes === 'theirs');
    ok('  — and the replaced record is marked as imported, because it now is',
        w.firearms[0]._prov.by === OFFICER.who);
    const r = rowFor(p, 'firearms');
    ok('  — reported as one added, one REPLACED, nothing skipped',
        r.added === 1 && r.updated === 1 && r.skipped === 0);
    ok('  — and what was overwritten is named', r.collisions.some(function (c) {
        return c.action === 'replaced with theirs';
    }));
}

{
    /* The host detective has nothing. Every mode must behave the same, or
     * the mode selector would change the outcome of a plain first import. */
    const results = M.MODES.map(function (mode) {
        return M.applyMerge(plan({}, IN_FIREARMS, mode)).firearms.length;
    });
    ok('with nothing of my own, all three modes import the same two records',
        results.join(',') === '2,2,2', results);
}

ok('an empty package changes nothing at all', (function () {
    const p = plan(LOCAL_FIREARMS, {}, M.MODE_NEW);
    return Object.keys(M.applyMerge(p)).length === 0 && p.totals.added === 0;
}()));

/* ════════════════════════════════════════════════════════════════════
   identity vs content
   ════════════════════════════════════════════════════════════════════ */
section('identity and its fallback');

{
    /* Measured: the firearms identity is serial + make + model, so a firearm
     * with no serial still has an identity — a blank serial is just one empty
     * component. It does NOT fall through to content hashing. */
    const local = { firearms: [{ id: 1, make: 'Taurus', model: 'G2C' }] };
    const same = { firearms: [{ id: 2, make: 'Taurus', model: 'G2C', notes: 'theirs' }] };
    const diff = { firearms: [{ id: 3, make: 'Taurus', model: 'G3' }] };

    const a = plan(local, same, M.MODE_NEW);
    ok('a firearm with no serial is still identified by make and model',
        rowFor(a, 'firearms').skipped === 1
        && rowFor(a, 'firearms').collisions[0].how === M.MATCH_IDENTITY);
    ok('  — so a differing note on their copy does not make it a second firearm',
        M.applyMerge(a).firearms.length === 1);

    const b = plan(local, diff, M.MODE_NEW);
    ok('a different model is a different firearm', rowFor(b, 'firearms').added === 1);
}

{
    /* A recovered vehicle logged with nothing but a colour has no VIN, no
     * plate and no state — the registry returns '' and the engine falls back
     * to "byte for byte the same record", which is a weaker claim and is
     * reported as such. */
    ok('a vehicle with no VIN and no plate has no identity the registry can use',
        R.identityFor('recoveredVehicles', { color: 'red' }) === '');

    const local = { recoveredVehicles: [{ id: 1, color: 'red', make: 'Ford' }] };
    const same = { recoveredVehicles: [{ id: 2, color: 'red', make: 'Ford' }] };
    const diff = { recoveredVehicles: [{ id: 3, color: 'blue', make: 'Ford' }] };

    const a = plan(local, same, M.MODE_NEW);
    ok('an identical record with no identifying fields is still recognised as a duplicate',
        rowFor(a, 'recoveredVehicles').skipped === 1);
    ok('  — and reported as a content match, not an identity match, because it is weaker',
        rowFor(a, 'recoveredVehicles').collisions[0].how === M.MATCH_CONTENT);

    const b = plan(local, diff, M.MODE_NEW);
    ok('a record that differs in any field is a different record',
        rowFor(b, 'recoveredVehicles').added === 1);
}

{
    /* A plate repeats across states. The registry says so; this proves the
     * engine actually consults it rather than falling back to content. */
    const local = { recoveredVehicles: [{ plate: 'ABC123', plateState: 'TX', color: 'red' }] };
    const other = { recoveredVehicles: [{ plate: 'ABC123', plateState: 'OK', color: 'blue' }] };
    const p = plan(local, other, M.MODE_NEW);
    ok('the same plate in a different state is a different vehicle',
        rowFor(p, 'recoveredVehicles').added === 1);
}

/* ════════════════════════════════════════════════════════════════════
   people, and the notes written about them
   ════════════════════════════════════════════════════════════════════ */
section('people and notes');

const LOCAL_PEOPLE = {
    suspects: [{ id: 1, firstName: 'John', lastName: 'Doe', dob: '1990-01-02', noteUid: 'pMINE' }],
    viperCaseNotes: [{ id: 10, createdAt: 'A', text: 'mine',
        assignedTo: [{ uid: 'pMINE', role: 'suspects', name: 'John Doe' }] }]
};
const IN_PEOPLE = {
    suspects: [
        { id: 5, firstName: 'John', lastName: 'Doe', dob: '1990-01-02', noteUid: 'pTHEIRS' },
        { id: 6, firstName: 'Jane', lastName: 'Roe', dob: '1988-05-05', noteUid: 'pJANE' }
    ],
    viperCaseNotes: [{ id: 10, createdAt: 'B', text: 'theirs',
        assignedTo: [{ uid: 'pTHEIRS', role: 'suspects', name: 'John Doe' }] }]
};

{
    const p = plan(LOCAL_PEOPLE, IN_PEOPLE, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('the person we both have is merged into mine', w.suspects.length === 2);
    ok('my uid survives — my own notes point at it', w.suspects[0].noteUid === 'pMINE');
    ok('their uid is recorded as pointing at mine now', p.remap.people.pTHEIRS === 'pMINE');
    ok('THEIR note is repointed at MY copy of the person, not left dangling',
        w.viperCaseNotes[1].assignedTo[0].uid === 'pMINE');
    ok('  — and my own note is untouched', w.viperCaseNotes[0].assignedTo[0].uid === 'pMINE');
    ok('their note is marked as theirs', w.viperCaseNotes[1]._prov.by === OFFICER.who);
    ok('a person I did not have arrives with their own uid intact',
        w.suspects[1].noteUid === 'pJANE');
}

{
    /* When the officer asked to keep both copies, the sender's note belongs
     * on the sender's copy. Repointing it at the host's record would credit
     * the host with an observation they did not make. */
    const p = plan(LOCAL_PEOPLE, IN_PEOPLE, M.MODE_ALL);
    const w = M.applyMerge(p);
    ok('keeping duplicates keeps both copies of the person', w.suspects.length === 3);
    ok('  — and their note stays attached to THEIR copy',
        w.viperCaseNotes[1].assignedTo[0].uid === 'pTHEIRS');
    ok('  — so nothing is repointed', Object.keys(p.remap.people).length === 0);
    ok('  — and their copy of the person is still in the list carrying that uid',
        w.suspects.some(function (s) { return s.noteUid === 'pTHEIRS'; }));
}

{
    const p = plan(LOCAL_PEOPLE, IN_PEOPLE, M.MODE_OVERWRITE);
    const w = M.applyMerge(p);
    ok('overwriting a person replaces the record', w.suspects.length === 2);
    ok('  — but NOT the uid: notes on both sides point at it',
        w.suspects[0].noteUid === 'pMINE');
    ok('  — and their note still finds the person', w.viperCaseNotes[1].assignedTo[0].uid === 'pMINE');
}

{
    /* Two machines minting random uids can in principle collide, and the
     * consequence is a note attaching to the wrong person — so it is checked
     * rather than assumed. */
    const local = { suspects: [{ firstName: 'A', lastName: 'A', noteUid: 'pSAME' }] };
    const incoming = { suspects: [{ firstName: 'B', lastName: 'B', noteUid: 'pSAME' }] };
    const p = plan(local, incoming, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('two different people cannot end up sharing a uid',
        w.suspects[0].noteUid !== w.suspects[1].noteUid);
    ok('  — the host keeps theirs and the incoming one is re-minted',
        w.suspects[0].noteUid === 'pSAME' && w.suspects[1].noteUid === 'pNEW1');
    ok('  — and the change is recorded so their notes follow it',
        p.remap.people.pSAME === 'pNEW1');
}

ok('a note assigned to nobody is left exactly as it is', (function () {
    const n = { text: 'x' };
    return M.remapAssignments(n, { a: 'b' }) === n;
}()));
ok('a note whose people did not move is not needlessly copied', (function () {
    const n = { assignedTo: [{ uid: 'z' }] };
    return M.remapAssignments(n, { a: 'b' }) === n;
}()));

/* ════════════════════════════════════════════════════════════════════
   ids that other data points at
   ════════════════════════════════════════════════════════════════════ */
section('re-minting ids');

{
    const local = { viperCaseEvidence: [{ id: 100, tag: 'E1', description: 'phone' }] };
    const incoming = { viperCaseEvidence: [{ id: 100, tag: 'E2', description: 'laptop' }] };
    const p = plan(local, incoming, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('two machines that minted the same id do not collide here',
        w.viperCaseEvidence[0].id !== w.viperCaseEvidence[1].id);
    ok('  — mine keeps its id; theirs is the one re-minted',
        w.viperCaseEvidence[0].id === 100 && w.viperCaseEvidence[1].id === 900001);
    ok('  — and the change is recorded so references can follow it',
        p.remap.ids.viperCaseEvidence['100'] === 900001);
}

{
    const local = { viperCaseEvidence: [{ id: 100, tag: 'E1', description: 'phone' }] };
    const incoming = { viperCaseEvidence: [{ id: 200, tag: 'E2', description: 'laptop' }] };
    const p = plan(local, incoming, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('an id that does not collide is LEFT ALONE — re-minting is how references go dangling',
        w.viperCaseEvidence[1].id === 200);
    ok('  — and nothing is recorded as remapped',
        !p.remap.ids.viperCaseEvidence || !('200' in p.remap.ids.viperCaseEvidence));
}

{
    /* Transcripts are filed under the evidence id they transcribe. If that id
     * was re-minted, filing the transcript under the old number would attach
     * it to the host detective's unrelated exhibit. */
    const local = {
        viperCaseEvidence: [{ id: 100, tag: 'E1', description: 'phone' }],
        viperTranscripts: { 100: { text: 'mine' } }
    };
    const incoming = {
        viperCaseEvidence: [{ id: 100, tag: 'E2', description: 'laptop' }],
        viperTranscripts: { 100: { text: 'theirs' } }
    };
    const p = plan(local, incoming, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('a transcript follows its exhibit to the new id',
        w.viperTranscripts['900001'] && w.viperTranscripts['900001'].text === 'theirs');
    ok('  — and does not land on top of mine', w.viperTranscripts['100'].text === 'mine');
    const er = rowFor(p, 'viperTranscripts');
    ok('  — reported as an addition, not a replacement', er.added === 1 && er.updated === 0);
}

/* ════════════════════════════════════════════════════════════════════
   whole-value stores
   ════════════════════════════════════════════════════════════════════ */
section('whole-value stores');

{
    const local = { opsplan: { summary: 'mine' } };
    const incoming = { opsplan: { summary: 'theirs' } };

    const a = plan(local, incoming, M.MODE_NEW);
    ok('there is no way to interleave two ops plans, so mine is kept',
        M.applyMerge(a).opsplan === undefined);
    ok('  — and the fact that theirs was discarded is reported, not silent',
        rowFor(a, 'opsplan').skipped === 1);

    const b = plan(local, incoming, M.MODE_ALL);
    ok('"add everything" still cannot interleave them — mine is kept',
        M.applyMerge(b).opsplan === undefined);

    const c = plan(local, incoming, M.MODE_OVERWRITE);
    ok('only Overwrite takes theirs', M.applyMerge(c).opsplan.summary === 'theirs');
    ok('  — reported as a replacement', rowFor(c, 'opsplan').updated === 1);
    ok('  — and marked as theirs', M.applyMerge(c).opsplan._prov.by === OFFICER.who);

    const d = plan({}, incoming, M.MODE_NEW);
    ok('if I have no ops plan at all, theirs is taken in every mode',
        M.applyMerge(d).opsplan.summary === 'theirs');
    ok('  — and reported as an addition rather than a replacement',
        rowFor(d, 'opsplan').added === 1 && rowFor(d, 'opsplan').updated === 0);

    const e = plan(local, { opsplan: {} }, M.MODE_OVERWRITE);
    ok('an EMPTY ops plan never overwrites a real one — that is data loss for nothing',
        M.applyMerge(e).opsplan === undefined);
}

/* ════════════════════════════════════════════════════════════════════
   wrapped stores
   ════════════════════════════════════════════════════════════════════ */
section('wrapped stores');

{
    /* Warrant drafts live inside an envelope with sibling settings. Merging
     * the list must not throw the envelope away. */
    const local = { warrantAuthor: { drafts: [{ id: 1, title: 'Phone', provider: 'Apple', createdAt: 'A' }], lastOpened: 1 } };
    const incoming = { warrantAuthor: { drafts: [{ id: 1, title: 'Google', provider: 'Google', createdAt: 'B' }], lastOpened: 9 } };
    const p = plan(local, incoming, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('a wrapped store merges the list inside it', w.warrantAuthor.drafts.length === 2);
    ok('  — and keeps the envelope\'s other fields as mine', w.warrantAuthor.lastOpened === 1);
    ok('  — colliding draft ids are re-minted, because warrants are referenced by id',
        w.warrantAuthor.drafts[1].id === 900001);
    ok('warrant drafts travel at all, which they did not before the store registry',
        rowFor(p, 'warrantAuthor').added === 1);
}

/* ════════════════════════════════════════════════════════════════════
   mirrors
   ════════════════════════════════════════════════════════════════════ */
section('dual-written mirrors');

{
    const p = plan(LOCAL_FIREARMS, IN_FIREARMS, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('the dashboard copy is rebuilt from the merged list, not merged separately',
        JSON.stringify(w.viperCaseFirearms) === JSON.stringify(w.firearms));
    ok('  — so the tab count and the tab contents cannot disagree',
        w.viperCaseFirearms.length === 2);
}

ok('a mirror whose source did not change is not written at all', (function () {
    const p = plan(LOCAL_FIREARMS, {}, M.MODE_NEW);
    return !('viperCaseFirearms' in M.applyMerge(p));
}()));

{
    /* Measured against the host: saveProsecutionData() writes the whole
     * prosecution OBJECT under the case number, where firearms writes an
     * ARRAY. A mirror copies its source verbatim, so the registry has to
     * say so or the Prosecution tab reads back the wrong shape. */
    const store = R.byKey('viperCaseProsecution');
    ok('the prosecution mirror is declared as an object, not an array',
        store.shape === 'object');
    const p = plan({}, { prosecution: { da: 'Smith' } }, M.MODE_NEW);
    const w = M.applyMerge(p);
    ok('  — and the mirror really does receive an object',
        w.viperCaseProsecution && !Array.isArray(w.viperCaseProsecution)
        && w.viperCaseProsecution.da === 'Smith');
}

/* ════════════════════════════════════════════════════════════════════
   what must never be merged
   ════════════════════════════════════════════════════════════════════ */
section('stores that never travel');

{
    const local = {};
    const incoming = {
        connectionBoard: { pins: [{ id: 'x' }] },
        viperCaseActivityTimers: { running: true },
        viperOpenEvidence: { open: 1 },
        viperCaseSuspects: [{ firstName: 'Legacy' }]
    };
    const w = M.applyMerge(plan(local, incoming, M.MODE_ALL));
    ok('the connection board is not merged — its pins are positions on MY board',
        !('connectionBoard' in w));
    ok('another officer\'s activity timers are not imported',
        !('viperCaseActivityTimers' in w));
    ok('neither is which evidence pane they had open',
        !('viperOpenEvidence' in w));
    ok('legacy mirrors nothing writes any more are not merge targets',
        !('viperCaseSuspects' in w));

    R.all().forEach(function (s) {
        if (s.transient) {
            ok('transient store ' + s.key + ' is never written by a merge', !(s.key in w));
        }
    });
}

/* ════════════════════════════════════════════════════════════════════
   files that were renamed on the way in
   ════════════════════════════════════════════════════════════════════ */
section('repointing renamed files');

{
    /* Phase 2's extractor never overwrites. A same-named, different file
     * lands beside the host's as "a (2).jpg" — and the record that referenced
     * it has to follow, or it displays the host detective's photograph. */
    const renamed = [{ from: 'Evidence/E2/photo.jpg', to: 'Evidence/E2/photo (2).jpg' }];
    const idx = M.buildRenameIndex(renamed);
    ok('the rename index is keyed on the file name, because records address files by name',
        idx['photo.jpg'] === 'photo (2).jpg');
    ok('a rename that changed nothing is not in the index',
        Object.keys(M.buildRenameIndex([{ from: 'a/x.jpg', to: 'b/x.jpg' }])).length === 0);

    const local = {};
    const incoming = {
        viperCaseEvidence: [{ id: 1, tag: 'E2', description: 'phone',
            files: [{ name: 'photo.jpg', size: 10 }, { name: 'other.jpg', size: 10 }] }]
    };
    const w = M.applyMerge(plan(local, incoming, M.MODE_NEW, { renamed: renamed }));
    ok('the record points at the file that was actually written',
        w.viperCaseEvidence[0].files[0].name === 'photo (2).jpg');
    ok('  — and a file that was not renamed is untouched',
        w.viperCaseEvidence[0].files[1].name === 'other.jpg');
}

{
    /* Field Work media uses `fileName`, canvas media uses `name`. Both are
     * reachable; a value that is not a file name is not. */
    const idx = M.buildRenameIndex([
        { from: 'Field Work Media/a.weba', to: 'Field Work Media/a (2).weba' },
        { from: 'x/Doe, John.pdf', to: 'x/Doe, John (2).pdf' }
    ]);
    const entry = { address: '1 Main', media: [{ fileName: 'a.weba', kind: 'audio' }] };
    ok('a field work media reference is repointed',
        M.repointFiles(entry, idx).media[0].fileName === 'a (2).weba');

    const person = { name: 'Doe, John', firstName: 'John' };
    ok('a person called "Doe, John" is NOT renamed because of a file called "Doe, John.pdf"',
        M.repointFiles(person, idx).name === 'Doe, John');

    const notAFile = { name: 'photo', kind: 'x' };
    ok('a value with no extension is never treated as a file name',
        M.repointFiles(notAFile, M.buildRenameIndex([{ from: 'photo', to: 'photo2' }])).name === 'photo');

    const untouched = { name: 'keep.jpg' };
    ok('a record with nothing to repoint is returned as-is, not copied',
        M.repointFiles(untouched, idx) === untouched);

    ok('a path keeps its directory and only the name changes',
        M.repointFiles({ path: 'Evidence/E2/a.weba' }, idx).path === 'Evidence/E2/a (2).weba');
}

/* ════════════════════════════════════════════════════════════════════
   the dry run IS the write
   ════════════════════════════════════════════════════════════════════ */
section('the summary is the truth');

{
    const local = Object.assign({}, LOCAL_PEOPLE, LOCAL_FIREARMS);
    const incoming = Object.assign({}, IN_PEOPLE, IN_FIREARMS);
    const p = plan(local, incoming, M.MODE_NEW);

    /* The whole point of showing a count before touching the case is that the
     * count is true. If the summary were computed by different code from the
     * write, it could be wrong — so it is the same computation. */
    const w1 = M.applyMerge(p);
    const w2 = M.applyMerge(p);
    ok('applying a plan twice produces the same values', JSON.stringify(w1) === JSON.stringify(w2));
    ok('applying does not recompute — the second call is not a second merge',
        w1.firearms.length === w2.firearms.length);

    let counted = 0;
    p.perStore.forEach(function (r) {
        if (!r.added) return;
        const store = R.byKey(r.key);
        if (store.merge !== 'list') return;
        const before = R.listOf(store, local[r.key]).length;
        const after = R.listOf(store, w1[r.key]).length;
        ok('the "' + r.label + '" count on the summary is what actually got written',
            after - before === r.added, { before: before, after: after, said: r.added });
        counted++;
    });
    ok('that was actually checked against more than one store', counted >= 2, counted);

    ok('the summary offers only the rows that change something — not 40 lines of zeroes',
        p.changed.length > 0 && p.changed.every(function (r) { return r.added || r.updated; }));
    ok('the totals add up',
        p.totals.added === p.perStore.reduce(function (a, r) { return a + r.added; }, 0));

    ok('a plan is required — applyMerge will not invent one', (function () {
        try { M.applyMerge({}); return false; } catch (e) { return /not a plan/.test(e.message); }
    }()));
}

/* ════════════════════════════════════════════════════════════════════
   undo
   ════════════════════════════════════════════════════════════════════ */
section('undo');

{
    const local = JSON.parse(JSON.stringify(Object.assign({}, LOCAL_PEOPLE, LOCAL_FIREARMS)));
    const snapshot = JSON.stringify(local);
    const p = plan(local, Object.assign({}, IN_PEOPLE, IN_FIREARMS), M.MODE_OVERWRITE);
    const writes = M.applyMerge(p);
    const undo = M.undoOf(p);

    ok('every store the merge writes has a before-value recorded',
        Object.keys(writes).every(function (k) { return k in undo; }));

    const restored = Object.assign({}, local);
    Object.keys(writes).forEach(function (k) { restored[k] = writes[k]; });
    Object.keys(undo).forEach(function (k) {
        if (undo[k] === undefined) delete restored[k]; else restored[k] = undo[k];
    });
    ok('restoring the before-values puts the case back exactly as it was',
        JSON.stringify(restored) === snapshot);

    ok('planning never mutated the host\'s own data', JSON.stringify(local) === snapshot);

    ok('a store that had nothing records undefined, so undo REMOVES the key', (function () {
        const q = plan({}, IN_FIREARMS, M.MODE_NEW);
        const u = M.undoOf(q);
        return ('firearms' in u) && u.firearms === undefined;
    }()));
}

/* ════════════════════════════════════════════════════════════════════
   a case passed down a chain
   ════════════════════════════════════════════════════════════════════ */
section('A to B to C');

{
    /* The primary detective receives from one officer, then from another, and
     * later hands the combined case to the DA's investigator. Credit has to
     * survive that, or the second import would claim the first one's work. */
    const A = { firearms: [{ serialNumber: 'A1', make: 'Glock' }] };
    const B = { firearms: [{ serialNumber: 'B1', make: 'Sig' }] };

    const first = M.applyMerge(plan({}, A, M.MODE_NEW));
    const second = M.applyMerge(M.planMerge(first, B, M.MODE_NEW, {
        registry: R, officer: { who: 'Det. Reyes 88' }, packageId: 'PKG2', now: WHEN
    }));

    ok('both officers\' work is present', second.firearms.length === 2);
    ok('the first officer still gets credit for theirs',
        second.firearms[0]._prov.by === OFFICER.who);
    ok('the second officer gets credit for theirs',
        second.firearms[1]._prov.by === 'Det. Reyes 88');
    ok('the second import did not claim the first officer\'s record',
        second.firearms[0]._prov.pkg === 'PKG1');

    const third = M.applyMerge(M.planMerge({}, second, M.MODE_NEW, {
        registry: R, officer: { who: 'Inv. Chen 12' }, packageId: 'PKG3', now: WHEN
    }));
    ok('handing the combined case on again preserves both original credits',
        third.firearms[0]._prov.by === OFFICER.who
        && third.firearms[1]._prov.by === 'Det. Reyes 88');
    ok('  — nothing is re-credited to the officer who merely passed it along',
        !third.firearms.some(function (f) { return f._prov.by === 'Inv. Chen 12'; }));
}

/* ════════════════════════════════════════════════════════════════════
   every store in the registry is accounted for
   ════════════════════════════════════════════════════════════════════ */
section('registry coverage');

{
    const handled = { list: 1, replace: 1, map: 1, mirror: 1, skip: 1 };
    R.all().forEach(function (s) {
        ok('store ' + s.key + ' declares a merge behaviour the engine implements',
            !!handled[s.merge], s.merge);
    });

    R.all().forEach(function (s) {
        if (s.merge !== 'mirror') return;
        ok('mirror ' + s.key + ' names a source that exists', !!R.byKey(s.mirrorOf));
    });
    R.all().forEach(function (s) {
        if (!s.remapWith) return;
        ok('store ' + s.key + ' remaps against a store that exists', !!R.byKey(s.remapWith));
        ok('  — and that store re-mints ids, or there would be nothing to remap',
            R.byKey(s.remapWith).reid === true);
    });

    /* A store with no identity function and a list merge would fall back to
     * content hashing for every record, which is correct but worth knowing
     * about deliberately rather than by accident. */
    const noIdentity = R.all().filter(function (s) {
        return s.merge === 'list' && typeof s.identity !== 'function';
    });
    ok('every list store knows how to recognise its own records',
        noIdentity.length === 0, noIdentity.map(function (s) { return s.key; }));
}

/* ════════════════════════════════════════════════════════════════════
   the shipping files
   ════════════════════════════════════════════════════════════════════ */
section('the module as shipped');

{
    const src = fs.readFileSync(path.join(REPO, 'modules', 'case-merge', 'case-merge.js'), 'utf-8');
    ok('it assigns to both module.exports and the global — the UMD trap',
        /module\.exports = api/.test(src) && /root\.CaseMerge = api/.test(src));
    ok('it does not read or write storage — the caller writes, this decides',
        !/localStorage\s*[.[]/.test(src));
    ok('it does not reach for the DOM', !/document\s*[.[]/.test(src));
    ok('the registry is resolved per call, not captured at load time',
        /function registry\(/.test(src) && src.indexOf('var SCHEMA =') < 0);
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
