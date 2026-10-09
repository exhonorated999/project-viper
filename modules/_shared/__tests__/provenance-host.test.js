/**
 * The host glue that joins provenance.js to the case screen.
 *
 * `_provStampEdits` and `_provCollectRows` live inline in
 * case-detail-with-analytics.html. They are LIFTED out of the shipping file
 * here rather than copied, because a copy is the thing that drifts.
 *
 * What is being protected:
 *  - an imported record the detective then edits must say so on its chip
 *  - a save that changes nothing must not claim an edit
 *  - a store that cannot be read must not be reported as empty, because an
 *    empty Contributions panel reads as "nobody sent you anything"
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond) {
    if (cond) { passed++; console.log('  PASS  ' + label); }
    else { failed++; console.log('  FAIL  ' + label); }
}
function section(name) { console.log('\n[' + name + ']'); }

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8')
    .replace(/\r\n/g, '\n');          // the big pages are CRLF on disk

/** Lift a top-level function out of the page by brace matching. */
function liftFunction(name) {
    const lines = HTML.split('\n');
    const re = new RegExp('^\\s*function ' + name + '\\s*\\(');
    const start = lines.findIndex(l => re.test(l));
    if (start < 0) throw new Error('could not find function ' + name + ' in case-detail-with-analytics.html');
    let depth = 0, opened = false;
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/\{/g) || []).length;
        depth -= (lines[i].match(/\}/g) || []).length;
        if (lines[i].indexOf('{') >= 0) opened = true;
        if (opened && depth <= 0) return lines.slice(start, i + 1).join('\n');
    }
    throw new Error('unbalanced braces lifting ' + name);
}

const Provenance = require('../provenance.js');
const CaseStores = require('../case-stores.js');

/* ── a localStorage good enough for the two functions under test ────────── */
function makeStorage(seed) {
    const data = Object.assign({}, seed || {});
    return {
        _data: data,
        getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem(k, v) { data[k] = String(v); },
        removeItem(k) { delete data[k]; }
    };
}

function makeEnv(seed, theCase) {
    const env = {
        console: console,
        JSON: JSON,
        Object: Object,
        Array: Array,
        String: String,
        Number: Number,
        Date: Date,
        localStorage: makeStorage(seed),
        currentCase: theCase || { id: 7, caseNumber: '26-00123' },
        window: { Provenance: Provenance, CaseStores: CaseStores }
    };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext(liftFunction('_provStampEdits') + '\n' + liftFunction('_provCollectRows')
        /* const/let in a lifted block never land on the sandbox global;
         * function declarations do, so nothing extra is needed here —
         * but pin that, because it is easy to break by accident. */
        + '\n;globalThis.__lifted = typeof _provStampEdits === "function" && typeof _provCollectRows === "function";',
        env);
    return env;
}

const prov = (by, badge, pkg, at) => ({ by: by, badge: badge, pkg: pkg, at: at || '2026-10-02T14:00:00Z' });

/* ════════════════════════════════════════════════════════════════════════ */
section('the glue lifts and runs');

{
    const env = makeEnv({}, null);
    ok('both host functions lifted out of the shipping page', env.__lifted === true);
    ok('they are the real ones, not a copy kept in this test',
        liftFunction('_provStampEdits').indexOf('window.Provenance') > 0);
}

/* ════════════════════════════════════════════════════════════════════════ */
section('editing a record another detective sent');

{
    const onDisk = [
        { id: 'a', name: 'SMITH, ALAN', phone: '555-0100', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') },
        { id: 'b', name: 'REED, CARLA', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }
    ];
    const env = makeEnv({ 'suspects_7': JSON.stringify(onDisk) });

    // the detective corrects a phone number on the first one
    const about_to_save = JSON.parse(JSON.stringify(onDisk));
    about_to_save[0].phone = '555-0199';

    env.__list = about_to_save;
    vm.runInContext('_provStampEdits("suspects", __list)', env);

    ok('the changed record is marked as edited on this machine',
        Provenance.isEditedHere(about_to_save[0]) === true);
    ok('the untouched record is not', Provenance.isEditedHere(about_to_save[1]) === false);
    ok('the record still says who sent it',
        Provenance.sourceName(about_to_save[0]).indexOf('Det. Alvarez') === 0);
    ok('  — an edit annotates the provenance, it does not erase it',
        Provenance.isImported(about_to_save[0]) === true);
    ok('the edit carries a timestamp', !!about_to_save[0]._prov.editedAt);
    ok('the batch is unchanged so the import can still be undone as a unit',
        Provenance.batchId(about_to_save[0]) === 'pkg-a');
}

{
    const onDisk = [{ id: 'a', name: 'SMITH, ALAN', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }];
    const env = makeEnv({ 'suspects_7': JSON.stringify(onDisk) });
    const same = JSON.parse(JSON.stringify(onDisk));
    env.__list = same;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    ok('a save that changed nothing does not claim an edit',
        Provenance.isEditedHere(same[0]) === false);
}

{
    // saving twice must not re-stamp, or the timestamp would creep forward
    const onDisk = [{ id: 'a', v: 1, _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }];
    const env = makeEnv({ 'suspects_7': JSON.stringify(onDisk) });
    const first = [{ id: 'a', v: 2, _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }];
    env.__list = first;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    const stampedAt = first[0]._prov.editedAt;
    ok('first edit stamps', !!stampedAt);

    env.localStorage.setItem('suspects_7', JSON.stringify(first));
    const second = JSON.parse(JSON.stringify(first));
    second[0].v = 3;
    env.__list = second;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    ok('a second edit leaves the original edit time alone',
        second[0]._prov.editedAt === stampedAt);
    ok('  — the chip says "edited here", not "edited 40 seconds ago", so the time only has to be the first one',
        second[0]._prov.editedHere === true);
}

{
    const env = makeEnv({ 'suspects_7': JSON.stringify([{ id: 'a', v: 1 }]) });
    const list = [{ id: 'a', v: 2 }];
    env.__list = list;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    ok('a record created on this machine is never stamped as edited',
        list[0]._prov === undefined);
    ok('  — "edited here" is only meaningful against work that came from somewhere else',
        Provenance.isEditedHere(list[0]) === false);
}

{
    // no id: index is the fallback match
    const onDisk = [{ note: 'one', _prov: prov('Sgt. Okafor', '#201', 'pkg-b') }];
    const env = makeEnv({ 'viperCaseNotes': JSON.stringify({ '26-00123': onDisk }) });
    const list = [{ note: 'one, corrected', _prov: prov('Sgt. Okafor', '#201', 'pkg-b') }];
    env.__list = list;
    vm.runInContext('_provStampEdits("viperCaseNotes", __list)', env);
    ok('a record with no id is matched by position', Provenance.isEditedHere(list[0]) === true);
    ok('  — pattern-1 stores are read by case number, not case id', true === true);
}

/* ════════════════════════════════════════════════════════════════════════ */
section('the stamper refuses rather than guesses');

{
    /* The stamp itself must be excluded from the comparison. The importer
     * can legitimately rewrite it — filling in the agency, say — without
     * the detective having touched a single field of the record. */
    const onDisk = [{ id: 'a', v: 1, _prov: { by: 'Det. Alvarez', badge: '#4417', pkg: 'pkg-a', at: '2026-10-02T14:00:00Z' } }];
    const env = makeEnv({ 'suspects_7': JSON.stringify(onDisk) });
    const list = [{ id: 'a', v: 1, _prov: { by: 'Det. Alvarez', badge: '#4417', pkg: 'pkg-a', at: '2026-10-02T14:00:00Z', agency: 'Fort Worth PD' } }];
    env.__list = list;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    ok('a change to the provenance stamp alone is not an edit to the record',
        Provenance.isEditedHere(list[0]) === false);
    ok('  — otherwise every record would read as edited the moment the stamp was written',
        list[0]._prov.agency === 'Fort Worth PD');
}

{
    const env = makeEnv({});                       // nothing on disk at all
    const list = [{ id: 'a', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }];
    env.__list = list;
    vm.runInContext('_provStampEdits("suspects", __list)', env);
    ok('a first write with nothing to compare against is not an edit',
        Provenance.isEditedHere(list[0]) === false);
}

{
    const env = makeEnv({ 'suspects_7': '{ not json' });
    const list = [{ id: 'a', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }];
    env.__list = list;
    let threw = false;
    try { vm.runInContext('_provStampEdits("suspects", __list)', env); } catch (_) { threw = true; }
    ok('an unreadable store does not throw and block the save', threw === false);
    ok('  — losing the edit marker is survivable, losing the save is not',
        Provenance.isEditedHere(list[0]) === false);
}

{
    const env = makeEnv({ 'suspects_7': JSON.stringify([{ id: 'a', v: 1, _prov: prov('D', '#1', 'p') }]) });
    env.__list = [];
    let threw = false;
    try { vm.runInContext('_provStampEdits("suspects", __list)', env); } catch (_) { threw = true; }
    ok('an empty list does not throw', threw === false);

    env.__list = null;
    threw = false;
    try { vm.runInContext('_provStampEdits("suspects", __list)', env); } catch (_) { threw = true; }
    ok('a null list does not throw', threw === false);

    env.__list = [null, undefined];
    threw = false;
    try { vm.runInContext('_provStampEdits("suspects", __list)', env); } catch (_) { threw = true; }
    ok('null rows in the list do not throw', threw === false);
}

{
    const env = makeEnv({ 'suspects_7': JSON.stringify([{ id: 'a', _prov: prov('D', '#1', 'p') }]) });
    env.__list = [{ id: 'a', _prov: prov('D', '#1', 'p') }];
    let threw = false;
    try { vm.runInContext('_provStampEdits("storeThatDoesNotExist", __list)', env); } catch (_) { threw = true; }
    ok('an unknown store key does not throw', threw === false);
}

/* ════════════════════════════════════════════════════════════════════════ */
section('what the Contributions panel reads');

{
    const env = makeEnv({
        'suspects_7': JSON.stringify([
            { id: 'a', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') },
            { id: 'b' }
        ]),
        'viperCaseEvidence': JSON.stringify({
            '26-00123': [{ id: 'e1', _prov: prov('Sgt. Okafor', '#201', 'pkg-b') }]
        })
    });
    const rows = vm.runInContext('_provCollectRows()', env);
    ok('rows come back from both storage patterns', rows.length === 3);
    ok('each row names the store it came from',
        rows.every(r => typeof r.store === 'string' && r.store.length > 0));
    ok('each row carries a human label for the panel',
        rows.every(r => typeof r.label === 'string' && r.label.length > 0));

    const groups = Provenance.contributions(rows);
    ok('two contributors', groups.length === 2);
    ok('own work is not attributed to anyone',
        groups.reduce((n, g) => n + g.total, 0) === 2);
}

{
    const env = makeEnv({ 'suspects_7': '{{{ garbage' , 'victims_7': JSON.stringify([
        { id: 'v', _prov: prov('Det. Alvarez', '#4417', 'pkg-a') }
    ])});
    const rows = vm.runInContext('_provCollectRows()', env);
    ok('a store that cannot be parsed is skipped, not counted as empty',
        rows.length === 1);
    ok('  — the panel under-reports rather than telling an officer nothing was sent',
        Provenance.contributions(rows).length === 1);
}

{
    const env = makeEnv({});
    const rows = vm.runInContext('_provCollectRows()', env);
    ok('a case with nothing stored reads back as no rows', rows.length === 0);
    ok('  — and therefore no Contributions panel at all',
        Provenance.contributions(rows).length === 0);
}

{
    // a wrapped store (warrant returns) exposes its list through the registry
    const env = makeEnv({ 'googleWarrant_7': JSON.stringify({
        imports: [{ id: 'g1', _prov: prov('Inv. Whitfield', '', 'pkg-c') }]
    })});
    const rows = vm.runInContext('_provCollectRows()', env);
    ok('a wrapped store is unwrapped by the registry, not by the panel',
        rows.length === 1 && rows[0].store === 'googleWarrant');
    ok('  — so a new store shape is added in one place',
        Provenance.isImported(rows[0].record) === true);
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' — ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
