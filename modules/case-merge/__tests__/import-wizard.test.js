/*
 * import-wizard.test.js — the dashboard screen in front of the merge engine.
 *
 * The engine is tested on its own in case-merge.test.js. This file tests the
 * part the officer actually touches, and it does it by LIFTING the shipping
 * code straight out of index.html rather than re-typing it, because a copied
 * block is the thing that drifts.
 *
 * What these assertions are protecting:
 *
 *   1. A merge either lands or says it did not. A full storage quota must
 *      never produce a summary claiming records were imported.
 *   2. A half-written merge is rolled back, not left behind.
 *   3. A local store we cannot read is never written over.
 *   4. Case files are extracted BEFORE the merge is planned, so a record
 *      that names a renamed file is repointed at the name it actually has.
 *   5. Undo puts the case back exactly, and does not delete evidence files.
 *   6. The destination screen returns the case and mode the officer picked.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\case-merge\__tests__\import-wizard.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CaseStores = require(path.join(REPO, 'modules', '_shared', 'case-stores.js'));
const CaseMerge = require(path.join(REPO, 'modules', 'case-merge', 'case-merge.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL  ' + name + (extra !== undefined ? '   ' + JSON.stringify(extra) : ''));
}
function section(t) { console.log('\n— ' + t); }

/* ────────────────────────────────────────────────────────────────
   lifting the wizard out of index.html
   ──────────────────────────────────────────────────────────────── */

const INDEX_PATH = path.join(REPO, 'index.html');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');

const START = '/* ========== Import wizard';
const END = '\n        async function importVcasePackage(pkg) {';
const s0 = INDEX_SRC.indexOf(START);
const s1 = INDEX_SRC.indexOf(END);
if (s0 < 0 || s1 < 0 || s1 < s0) {
    console.log('FAIL  could not locate the import wizard block in index.html');
    process.exit(1);
}
/* `let` at the top of the lifted block never lands on the vm sandbox global
 * the way a function declaration does, and the undo state has to be visible
 * to the test. Rewriting the declaration is a test-only hook; every bare
 * reference inside the block still resolves to the same slot. */
const WIZARD_SRC = INDEX_SRC.slice(s0, s1)
    .replace('let _lastImportUndo = null;', 'globalThis._lastImportUndo = null;');

/* ────────────────────────────────────────────────────────────────
   stubs
   ──────────────────────────────────────────────────────────────── */

/** A localStorage that can be told to run out of room. */
function makeStorage(seed) {
    const map = Object.assign({}, seed || {});
    return {
        _map: map,
        refuse: null,          // set to a key substring to make writes fail
        getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
        setItem(k, v) {
            if (this.refuse && String(k).indexOf(this.refuse) === 0) {
                const e = new Error('QuotaExceededError');
                e.name = 'QuotaExceededError';
                throw e;
            }
            map[k] = String(v);
        },
        removeItem(k) { delete map[k]; },
    };
}

/* A DOM stub that is just real enough to drive the two modals. It does not
 * parse HTML; it scans the assigned innerHTML for the handful of tags the
 * wizard looks up again, which is all the selectors below need. */
function scanTags(html) {
    const out = [];
    const re = /<(input|select|button|div|option)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(html))) {
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        const get = (n) => {
            const a = new RegExp(n + '="([^"]*)"').exec(attrs);
            return a ? a[1] : '';
        };
        out.push({
            tag,
            id: get('id'),
            name: get('name'),
            value: get('value'),
            cls: get('class'),
            checked: /\bchecked\b/.test(attrs),
            disabled: /\bdisabled\b/.test(attrs),
        });
    }
    return out;
}

function makeNode(tag, spec) {
    const node = {
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        value: (spec && spec.value) || '',
        checked: !!(spec && spec.checked),
        disabled: !!(spec && spec.disabled),
        id: (spec && spec.id) || '',
        name: (spec && spec.name) || '',
        parentNode: null,
        _html: '',
        _nodes: [],
        _on: {},
        addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
        fire(ev) { (this._on[ev] || []).forEach(f => f()); },
        remove() { this.parentNode = null; },
        appendChild() { },
    };
    Object.defineProperty(node, 'innerHTML', {
        get() { return this._html; },
        set(v) {
            this._html = String(v);
            const scanned = scanTags(this._html);
            this._nodes = scanned.map(s => {
                const n = makeNode(s.tag, s);
                n.className = s.cls;
                return n;
            });
            // A <select> takes the value of its selected <option>; the real
            // browser does the same and the wizard reads it straight back.
            this._nodes.forEach((n, i) => {
                if (n.tagName !== 'SELECT') return;
                const opts = [];
                for (let j = i + 1; j < this._nodes.length; j++) {
                    if (this._nodes[j].tagName !== 'OPTION') break;
                    opts.push(this._nodes[j]);
                }
                const sel = scanned.slice(i + 1, i + 1 + opts.length)
                    .map((s, k) => ({ s, n: opts[k] }))
                    .find(p => /selected/.test(p.s.cls) || p.s.checked);
                n.value = (sel ? sel.n.value : (opts[0] ? opts[0].value : ''));
            });
        }
    });
    node.querySelectorAll = function (sel) { return matchAll(this._nodes, sel, this._html); };
    node.querySelector = function (sel) { return matchAll(this._nodes, sel, this._html)[0] || null; };
    return node;
}

function matchAll(nodes, sel, html) {
    if (sel.charAt(0) === '#') {
        const id = sel.slice(1);
        return nodes.filter(n => n.id === id);
    }
    const attr = /^(\w+)\[name="([^"]+)"\]$/.exec(sel);
    if (attr) {
        return nodes.filter(n => n.tagName === attr[1].toUpperCase() && n.name === attr[2]);
    }
    if (/button$/.test(sel)) return nodes.filter(n => n.tagName === 'BUTTON');
    return [];
}

/** Everything the lifted block reaches for, in one sandbox. */
function makeEnv(opts) {
    opts = opts || {};
    const storage = opts.storage || makeStorage();
    const notes = [];
    const audits = [];
    const created = [];

    const env = {
        console: { log() { }, warn() { }, error() { } },
        JSON, Date, Math, Number, String, Object, Array, Boolean,
        RegExp, Error, Promise, isNaN, parseInt, parseFloat,
        setTimeout: (fn) => { try { fn(); } catch (_) { } return 0; },
        localStorage: storage,
        cases: opts.cases || [],
        _reloadCases() {
            try {
                const parsed = JSON.parse(storage.getItem('viperCases') || '[]');
                if (Array.isArray(parsed)) env.cases = parsed;
            } catch (_) { }
            return env.cases;
        },
        _normCaseNumber(v) {
            return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase();
        },
        showNotification(msg, type) { notes.push({ msg: String(msg), type: type || 'info' }); },
        audit(ev, data) { audits.push({ ev, data }); },
        updateDashboardCaseData() { env._repainted = (env._repainted || 0) + 1; },
        importVcasePackage: opts.importVcasePackage || (async () => undefined),
        document: {
            body: { appendChild(n) { created.push(n); n.parentNode = { }; } },
            createElement(tag) { return makeNode(tag); },
        },
        _notes: notes,
        _audits: audits,
        _created: created,
        _storage: storage,
    };
    env.window = { CaseStores, CaseMerge, VpCaseStorage: null };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext(WIZARD_SRC, env, { filename: 'index.html#import-wizard' });
    return env;
}

/* ────────────────────────────────────────────────────────────────
   fixtures
   ──────────────────────────────────────────────────────────────── */

const HOST_CASE = { id: 1000, caseNumber: '26-0905538', title: 'Burglary of a habitation' };

function pkg(extra) {
    return Object.assign({
        _viperExport: true,
        _version: '1.0',
        _exportedAt: '2026-10-08T09:00:00.000Z',
        _exportedBy: 'M. Alvarez',
        _source: {
            officerName: 'M. Alvarez',
            officerRank: 'Det.',
            officerBadge: '4471',
            agencyName: 'Fort Worth PD',
            caseNumber: '26-0905538',
            appVersion: '5.3.4'
        },
        caseMetadata: { id: 7, caseNumber: '26-0905538', title: 'Burglary of a habitation' },
        moduleData: {},
        sharedData: {},
        tasks: []
    }, extra || {});
}

/* ════════════════════════════════════════════════════════════════
   the wizard is wired into the page
   ════════════════════════════════════════════════════════════════ */
section('the wizard is wired into index.html');
{
    const iHead = INDEX_SRC.indexOf('modules/_shared/case-stores.js');
    const iMerge = INDEX_SRC.indexOf('modules/case-merge/case-merge.js');
    const iStore = INDEX_SRC.indexOf('modules/_shared/case-storage.js');
    const iSnap = INDEX_SRC.indexOf('src="case-snapshot.js"');
    ok('case-merge.js is loaded by the dashboard', iMerge > 0);
    ok('case-storage.js is loaded by the dashboard', iStore > 0);
    ok('the merge engine loads after the store registry it reads', iMerge > iHead);
    ok('both load before case-snapshot.js, as the rest of the import does',
        iMerge < iSnap && iStore < iSnap);
    ok('none of the new tags are deferred',
        !/case-merge\/case-merge\.js"\s+defer/.test(INDEX_SRC));

    ok('the plain .vcase path goes through the wizard, not straight to a new case',
        /Format 1: \.vcase single-case export[\s\S]{0,200}routeVcaseImport\(pkg, null\)/.test(INDEX_SRC));
    ok('the v2 ZIP path goes through the wizard too',
        /await routeVcaseImport\(pkg, fileCtx\)/.test(INDEX_SRC));
    ok('the merge writes go through the quota-guarded helper, never bare setItem',
        /_lsSetSafe\(`\$\{s\.key\}_\$\{target\.id\}`/.test(WIZARD_SRC));
}

/* ════════════════════════════════════════════════════════════════
   naming the sender
   ════════════════════════════════════════════════════════════════ */
section('naming the sender');
{
    const env = makeEnv();
    const o = env._packageOfficer(pkg());
    ok('reads the officer out of the v2 source block', o.who === 'M. Alvarez', o);
    ok('carries the badge', o.officerBadge === '4471');
    ok('carries the agency', o.agencyName === 'Fort Worth PD');
    ok('carries the case number it had on their machine', o.caseNumber === '26-0905538');

    const old = pkg({ _source: undefined, _exportedBy: 'J. Rivera' });
    const o2 = env._packageOfficer(old);
    ok('an older package with no source block still names whoever exported it',
        o2.who === 'J. Rivera', o2);
    ok('and falls back to the case metadata for the case number',
        o2.caseNumber === '26-0905538');

    ok('the sender line reads as a person, not a record',
        env._senderLine(pkg()) === 'Det. M. Alvarez · Badge 4471 · Fort Worth PD',
        env._senderLine(pkg()));
    ok('a package with nobody named says so rather than printing "undefined"',
        env._senderLine(pkg({ _source: undefined, _exportedBy: '' })) === 'Sender not recorded',
        env._senderLine(pkg({ _source: undefined, _exportedBy: '' })));

    ok('html in a sender name cannot reach the screen',
        env._impEsc('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;',
        env._impEsc('<img src=x onerror=1>'));
    ok('quotes are escaped too, because the name lands inside an attribute',
        env._impEsc('a"b') === 'a&quot;b');
    ok('bytes read as sizes a person recognises', env._impBytes(1536) === '2 KB', env._impBytes(1536));
    ok('and megabytes keep a decimal', env._impBytes(5 * 1048576) === '5.0 MB', env._impBytes(5 * 1048576));
}

/* ════════════════════════════════════════════════════════════════
   what is in the package
   ════════════════════════════════════════════════════════════════ */
section('what is in the package');
{
    const env = makeEnv();
    const p = pkg({
        moduleData: {
            suspects: [{ name: 'Doe, John', dob: '1990-01-02' }, { name: 'Roe, Jane' }],
            firearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }],
        },
        sharedData: {
            viperCaseFirearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }],
        },
        tasks: [{ id: 1, title: 'Serve the warrant', date: '2026-10-12' }]
    });

    const stores = env._packageStores(p);
    ok('pattern-2 values are picked up', Array.isArray(stores.suspects) && stores.suspects.length === 2);
    ok('pattern-1 values are picked up too', Array.isArray(stores.viperCaseFirearms));

    const rows = env._packageContents(p);
    const label = k => (rows.find(r => r.label === k) || {}).n;
    ok('suspects are counted', label('Suspects') === 2, rows);
    ok('firearms are counted once', label('Firearms') === 1, rows);
    ok('the dual-written mirror is NOT counted a second time',
        rows.filter(r => /firearm/i.test(r.label)).length === 1, rows);
    ok('tasks are counted', label('Tasks and reminders') === 1, rows);
    ok('a store that is not in the package is not listed',
        rows.every(r => r.label !== 'Victims'), rows);

    const empty = env._packageContents(pkg());
    ok('an empty package lists nothing rather than rows of zeroes', empty.length === 0, empty);
}

/* ════════════════════════════════════════════════════════════════
   reading what the host already has
   ════════════════════════════════════════════════════════════════ */
section('reading what the host already has');
{
    const storage = makeStorage({
        'suspects_1000': JSON.stringify([{ name: 'Doe, John', dob: '1990-01-02' }]),
        'viperCaseNotes': JSON.stringify({ '26-0905538': [{ id: 5, text: 'knock and talk' }] }),
    });
    const env = makeEnv({ storage });
    const r = env._readCaseStores(HOST_CASE);
    ok('a pattern-2 store is read under the case id',
        r.values.suspects && r.values.suspects.length === 1, r.values.suspects);
    ok('a pattern-1 store is read under the case number',
        r.values.viperCaseNotes && r.values.viperCaseNotes.length === 1);
    ok('nothing is invented for a store the case has never used',
        r.values.victims === undefined);
    ok('nothing unreadable', r.unreadable.length === 0);

    storage._map['firearms_1000'] = '{"not":"valid"';
    const r2 = env._readCaseStores(HOST_CASE);
    ok('a corrupted local store is REPORTED', r2.unreadable.some(s => s.key === 'firearms'),
        r2.unreadable.map(s => s.key));
    ok('and is not silently reported as empty, which would invite overwriting it',
        r2.values.firearms === undefined);
}

/* ════════════════════════════════════════════════════════════════
   writing, and refusing to pretend
   ════════════════════════════════════════════════════════════════ */
section('writing, and refusing to pretend');
{
    const storage = makeStorage({ 'viperCaseNotes': JSON.stringify({ 'OTHER-1': [{ id: 1 }] }) });
    const env = makeEnv({ storage });
    const res = env._writeCaseStores(HOST_CASE, {
        suspects: [{ name: 'Doe, John' }],
        viperCaseNotes: [{ id: 9, text: 'theirs' }],
    });
    ok('both stores landed', res.done.length === 2 && !res.failedKey, res);
    ok('the pattern-2 store is under the case id',
        JSON.parse(storage.getItem('suspects_1000'))[0].name === 'Doe, John');
    const notes = JSON.parse(storage.getItem('viperCaseNotes'));
    ok('the pattern-1 store is filed under the case number', notes['26-0905538'].length === 1);
    ok('and another case sharing that store is untouched', notes['OTHER-1'].length === 1);

    const storage2 = makeStorage();
    storage2.refuse = 'firearms_';
    const env2 = makeEnv({ storage: storage2 });
    const res2 = env2._writeCaseStores(HOST_CASE, {
        suspects: [{ name: 'A' }],
        firearms: [{ make: 'Taurus' }],
        victims: [{ name: 'B' }],
    });
    ok('a write that cannot be made is named', res2.failedKey === 'firearms', res2);
    ok('and everything after it is abandoned rather than written piecemeal',
        res2.done.indexOf('victims') < 0, res2.done);
    ok('the store that did land is reported as landed', res2.done.indexOf('suspects') >= 0);
    ok('nothing was written for the refused key', storage2.getItem('firearms_1000') === null);
}

/* ════════════════════════════════════════════════════════════════
   putting it back
   ════════════════════════════════════════════════════════════════ */
section('putting it back');
{
    const storage = makeStorage({
        'suspects_1000': JSON.stringify([{ name: 'mine' }, { name: 'theirs' }]),
        'victims_1000': JSON.stringify([{ name: 'theirs only' }]),
        'viperCaseNotes': JSON.stringify({ '26-0905538': [{ id: 1 }, { id: 2 }], 'OTHER-1': [{ id: 3 }] }),
    });
    const env = makeEnv({ storage });
    const failed = env._restoreCaseStores(HOST_CASE, {
        suspects: [{ name: 'mine' }],
        victims: undefined,
        viperCaseNotes: [{ id: 1 }],
    }, ['suspects', 'victims', 'viperCaseNotes']);
    ok('nothing failed', failed === 0);
    ok('a list is restored to exactly what it was',
        JSON.parse(storage.getItem('suspects_1000')).length === 1);
    ok('a store the case did not have is REMOVED, not blanked',
        storage.getItem('victims_1000') === null);
    const notes = JSON.parse(storage.getItem('viperCaseNotes'));
    ok('a shared store is restored for this case only', notes['26-0905538'].length === 1);
    ok('and the other case in it is still there', notes['OTHER-1'].length === 1);
}

/* ════════════════════════════════════════════════════════════════
   tasks
   ════════════════════════════════════════════════════════════════ */
section('tasks');
{
    const existing = [
        { id: 10, title: 'Serve the warrant', date: '2026-10-12', time: '09:00', caseId: '26-0905538' },
        { id: 11, title: 'Unrelated', date: '2026-11-01', caseId: 'OTHER-1' },
    ];
    const storage = makeStorage({ viperTasks: JSON.stringify(existing) });
    const env = makeEnv({ storage });
    const prov = { by: 'M. Alvarez', at: '2026-10-08T12:00:00.000Z' };

    const incoming = [
        { id: 10, title: 'Serve the warrant', date: '2026-10-12', time: '09:00', caseId: '26-0905538' },
        { id: 12, title: 'Canvass the alley', date: '2026-10-13', caseId: '26-0905538' },
    ];

    const a = env._planTaskMerge(pkg({ tasks: incoming }), HOST_CASE, 'new', prov);
    ok('the task both officers have is left out', a.added === 1 && a.skipped === 1, a);
    ok('the new one is added', a.after.length === 3);
    const added = a.after[a.after.length - 1];
    ok('it is credited to the sender', added._prov && added._prov.by === 'M. Alvarez');
    ok('and its id was re-minted away from the one already in use',
        String(added.id) !== '10' && String(added.id) !== '11', added.id);

    const b = env._planTaskMerge(pkg({ tasks: incoming }), HOST_CASE, 'all', prov);
    ok('"everything including duplicates" takes both', b.added === 2 && b.skipped === 0, b);
    ok('and the duplicate does not inherit the colliding id',
        b.after.filter(t => String(t.id) === '10').length === 1,
        b.after.map(t => t.id));

    const c = env._planTaskMerge(pkg({
        tasks: [{ id: 99, title: 'Pull the video', date: '2026-10-14', caseId: 'THEIR-CASE' }]
    }), HOST_CASE, 'new', prov);
    ok('a task arrives filed under the case it landed in, not the one it left',
        c.after[c.after.length - 1].caseId === '26-0905538');
    ok('an unrelated case\'s tasks are never touched',
        c.after.filter(t => t.caseId === 'OTHER-1').length === 1);

    ok('a package with no tasks plans nothing at all',
        env._planTaskMerge(pkg(), HOST_CASE, 'new', prov) === null);
}

/* ════════════════════════════════════════════════════════════════
   the merge, end to end
   ════════════════════════════════════════════════════════════════ */
section('the merge, end to end');

/** An env with the two modals replaced by answers, so the merge can be
 *  driven without a browser. The modals themselves are tested below. */
function mergeEnv(seed, answer) {
    const storage = makeStorage(seed || {});
    const env = makeEnv({ storage });
    env._promptMergeSummary = async function (plan, taskPlan, target, p, extra) {
        env._lastSummary = { plan, taskPlan, target, extra };
        return answer === undefined ? true : answer;
    };
    env._showMergeResult = function (s) { env._lastResult = s; };
    return env;
}

{
    const seed = {
        viperCases: JSON.stringify([HOST_CASE]),
        'suspects_1000': JSON.stringify([{ id: 1, name: 'Doe, John', dob: '1990-01-02' }]),
    };
    const env = mergeEnv(seed);
    ok('the merge helpers are all reachable from the lifted block',
        typeof env.mergeVcaseIntoCase === 'function'
        && typeof env.routeVcaseImport === 'function'
        && typeof env.undoLastImport === 'function');
}

/* everything from here needs await, so it runs inside main() */
async function main() {
    {
        const seed = {
            viperCases: JSON.stringify([HOST_CASE]),
            'suspects_1000': JSON.stringify([{ id: 1, name: 'Doe, John', dob: '1990-01-02' }]),
        };
        const env = mergeEnv(seed);
        const p = pkg({
            moduleData: {
                suspects: [
                    { id: 1, name: 'Doe, John', dob: '1990-01-02' },
                    { id: 2, name: 'Roe, Jane', dob: '1988-05-05' },
                ],
                firearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }],
            },
            tasks: [{ id: 50, title: 'Pull the video', date: '2026-10-14' }],
        });

        const landed = await env.mergeVcaseIntoCase(p, HOST_CASE, 'new', [], 0);
        ok('the merge reports where it landed',
            landed && landed.merged === true && landed.caseNumber === '26-0905538', landed);

        const sus = JSON.parse(env._storage.getItem('suspects_1000'));
        ok('the suspect both officers had is not duplicated', sus.length === 2, sus.map(s => s.name));
        ok('the host\'s own record is left unmarked', !sus[0]._prov);
        ok('the one that arrived is credited to the sender',
            sus[1]._prov && sus[1]._prov.by === 'M. Alvarez', sus[1]._prov);
        ok('the credit carries the badge', sus[1]._prov.badge === '4471');
        ok('and the case number it came off', sus[1]._prov.case === '26-0905538');

        const fa = JSON.parse(env._storage.getItem('firearms_1000'));
        ok('a module the host had nothing in is created', fa && fa.length === 1, fa);
        ok('and its dashboard mirror is rebuilt alongside it, so the two cannot disagree',
            JSON.parse(env._storage.getItem('viperCaseFirearms'))['26-0905538'].length === 1);

        const tasks = JSON.parse(env._storage.getItem('viperTasks'));
        ok('the sender\'s task came across', tasks.length === 1 && tasks[0].title === 'Pull the video');

        const rec = JSON.parse(env._storage.getItem('viperCases'))[0];
        ok('the handoff is recorded on the case', Array.isArray(rec.importedSupplements)
            && rec.importedSupplements.length === 1, rec.importedSupplements);
        ok('naming who sent it', rec.importedSupplements[0].by === 'M. Alvarez');
        ok('and which mode was used', rec.importedSupplements[0].mode === 'new');

        ok('the dashboard was told to repaint', env._repainted > 0);
        ok('an audit line was written',
            env._audits.some(a => a.ev === 'case_supplement_imported'), env._audits);
        ok('the officer is shown what landed', !!env._lastResult && /Suspects: 1 new/.test(env._lastResult.body),
            env._lastResult && env._lastResult.body);
        ok('and told who it is credited to', /M\. Alvarez/.test(env._lastResult.body));

        /* undo */
        env.undoLastImport();
        const sus2 = JSON.parse(env._storage.getItem('suspects_1000'));
        ok('undo puts the suspect list back exactly', sus2.length === 1 && sus2[0].name === 'Doe, John', sus2);
        ok('undo removes a store the case never had', env._storage.getItem('firearms_1000') === null);
        ok('undo puts the tasks back', JSON.parse(env._storage.getItem('viperTasks')).length === 0);
        const rec2 = JSON.parse(env._storage.getItem('viperCases'))[0];
        ok('undo clears the handoff from the case record',
            !rec2.importedSupplements || rec2.importedSupplements.length === 0, rec2.importedSupplements);
        ok('undo says so', env._notes.some(n => /back as it was/.test(n.msg)), env._notes.map(n => n.msg));
        env.undoLastImport();
        ok('undoing twice does not undo something else',
            env._notes.some(n => /nothing to undo/i.test(n.msg)));
    }

    section('declining the summary');
    {
        const seed = {
            viperCases: JSON.stringify([HOST_CASE]),
            'suspects_1000': JSON.stringify([{ id: 1, name: 'Doe, John' }]),
        };
        const env = mergeEnv(seed, false);
        await env.mergeVcaseIntoCase(pkg({ moduleData: { suspects: [{ id: 2, name: 'Roe, Jane' }] } }),
            HOST_CASE, 'new', [], 0);
        ok('cancelling at the summary writes nothing',
            JSON.parse(env._storage.getItem('suspects_1000')).length === 1);
        ok('and leaves no undo lying around that would modify the case',
            env._lastImportUndo === null || env._lastImportUndo === undefined);
    }

    section('when there is no room to store it');
    {
        const seed = {
            viperCases: JSON.stringify([HOST_CASE]),
            'suspects_1000': JSON.stringify([{ id: 1, name: 'Doe, John' }]),
        };
        const storage = makeStorage(seed);
        const env = makeEnv({ storage });
        env._promptMergeSummary = async () => true;
        env._showMergeResult = (s) => { env._lastResult = s; };
        storage.refuse = 'firearms_';

        await env.mergeVcaseIntoCase(pkg({
            moduleData: {
                suspects: [{ id: 2, name: 'Roe, Jane' }],
                firearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }],
            }
        }), HOST_CASE, 'new', [], 0);

        ok('a quota failure is never reported as a success',
            !env._lastResult, env._lastResult);
        ok('the officer is told nothing was imported',
            env._notes.some(n => n.type === 'error' && /Nothing was imported/.test(n.msg)),
            env._notes.map(n => n.msg));
        ok('the part that did land is rolled back',
            JSON.parse(storage.getItem('suspects_1000')).length === 1,
            JSON.parse(storage.getItem('suspects_1000')));
        ok('and the case record is not stamped with a handoff that did not happen',
            !JSON.parse(storage.getItem('viperCases'))[0].importedSupplements);
    }

    section('a local store we cannot read is never written over');
    {
        const seed = {
            viperCases: JSON.stringify([HOST_CASE]),
            'firearms_1000': '{"truncated":',
        };
        const env = mergeEnv(seed);
        await env.mergeVcaseIntoCase(pkg({
            moduleData: {
                firearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }],
                suspects: [{ id: 2, name: 'Roe, Jane' }],
            }
        }), HOST_CASE, 'new', [], 0);

        ok('the damaged store is left exactly as it was',
            env._storage.getItem('firearms_1000') === '{"truncated":',
            env._storage.getItem('firearms_1000'));
        ok('the rest of the package still imports',
            JSON.parse(env._storage.getItem('suspects_1000')).length === 1);
        ok('and the summary screen names what was held back',
            env._lastSummary.extra.unreadable.some(s => s.key === 'firearms'),
            env._lastSummary.extra.unreadable.map(s => s.key));
    }

    section('records follow their files when a file had to be renamed');
    {
        const seed = { viperCases: JSON.stringify([HOST_CASE]) };
        const env = mergeEnv(seed);
        await env.mergeVcaseIntoCase(pkg({
            moduleData: {
                fieldwork: [{ id: 3, address: '100 Main St', media: [{ fileName: 'door.jpg', bytes: 10 }] }]
            }
        }), HOST_CASE, 'new',
            [{ from: 'Field Work Media/door.jpg', to: 'Field Work Media/door (2).jpg' }], 1);

        const fw = JSON.parse(env._storage.getItem('fieldwork_1000'));
        ok('the record points at the name the file actually has',
            fw[0].media[0].fileName === 'door (2).jpg', fw[0].media);
        ok('the files that were copied in are reported to the officer',
            /Case files: 1 copied in/.test(env._lastResult.body), env._lastResult.body);
    }

    section('undo leaves the evidence files alone');
    {
        const seed = { viperCases: JSON.stringify([HOST_CASE]) };
        const env = mergeEnv(seed);
        await env.mergeVcaseIntoCase(pkg({
            moduleData: { firearms: [{ make: 'Taurus', model: 'G2C', serial: 'ABC123' }] }
        }), HOST_CASE, 'new', [], 4);
        env.undoLastImport();
        const said = env._notes.map(n => n.msg).join(' | ');
        ok('undo says the files were left in place rather than deleting them',
            /4 files already copied into the case folder were left in place/.test(said), said);
    }

    section('new case, or add to one already here');
    {
        /* routeVcaseImport with the destination screen answered for it. */
        function routeEnv(answer, restoreResult) {
            const storage = makeStorage({ viperCases: JSON.stringify([HOST_CASE]) });
            const order = [];
            const env = makeEnv({
                storage,
                importVcasePackage: async () => { order.push('newCase'); return { caseNumber: 'NEW-1', caseId: 2 }; }
            });
            env._promptImportDestination = async () => answer;
            env._promptMergeSummary = async (plan) => { order.push('plan'); env._plan = plan; return true; };
            env._showMergeResult = () => { };
            env._order = order;
            env._fileCtx = {
                fileCount: 2,
                restore: async (caseNumber) => {
                    order.push('files:' + caseNumber);
                    return restoreResult;
                }
            };
            return env;
        }

        const a = routeEnv({ kind: 'new' }, { ok: true, written: 2, renamed: [] });
        const landedA = await a.routeVcaseImport(pkg(), a._fileCtx);
        ok('choosing a new case uses the existing new-case path',
            landedA && landedA.caseNumber === 'NEW-1', landedA);
        ok('and its files are restored into the case it just created',
            a._order.join(',') === 'newCase,files:NEW-1', a._order);

        const b = routeEnv({ kind: 'merge', target: HOST_CASE, mergeMode: 'new' },
            { ok: true, written: 2, renamed: [] });
        await b.routeVcaseImport(pkg({ moduleData: { suspects: [{ id: 1, name: 'Roe, Jane' }] } }), b._fileCtx);
        ok('merging extracts the files BEFORE the merge is planned',
            b._order.join(',') === 'files:26-0905538,plan', b._order);

        const c = routeEnv({ kind: 'merge', target: HOST_CASE, mergeMode: 'new' }, false);
        await c.routeVcaseImport(pkg({ moduleData: { suspects: [{ id: 1, name: 'Roe, Jane' }] } }), c._fileCtx);
        ok('if the files cannot be restored, nothing is merged either',
            c._order.indexOf('plan') < 0, c._order);
        ok('and the case is untouched', c._storage.getItem('suspects_1000') === null);

        const d = routeEnv(null, false);
        const landedD = await d.routeVcaseImport(pkg(), d._fileCtx);
        ok('cancelling the destination screen does nothing at all',
            landedD === undefined && d._order.length === 0, d._order);

        const e = routeEnv({ kind: 'merge', target: HOST_CASE, mergeMode: 'overwrite' }, null);
        e._fileCtx = null;
        await e.routeVcaseImport(pkg({ moduleData: { suspects: [{ id: 1, name: 'Roe, Jane' }] } }), null);
        ok('a data-only package needs no file step', e._order.join(',') === 'plan', e._order);
        ok('and the mode the officer chose is the mode the engine is given',
            e._plan.mode === 'overwrite', e._plan && e._plan.mode);
    }

    section('the destination screen');
    {
        const env = makeEnv({ cases: [HOST_CASE, { id: 2000, caseNumber: '26-1111111', title: 'Robbery' }] });
        const p = pkg({ moduleData: { suspects: [{ name: 'Roe, Jane' }] } });

        const promise = env._promptImportDestination(p, { fileCount: 3, fileBytes: 2048 });
        const box = env._created[env._created.length - 1];
        const html = box.innerHTML;

        ok('the sender is named at the top', html.indexOf('Det. M. Alvarez') > 0);
        ok('the case number is in the heading', html.indexOf('26-0905538') > 0);
        ok('the contents are listed', /Suspects — <strong>1<\/strong>/.test(html), html.slice(0, 400));
        ok('the files are listed with a size', /Case files — <strong>3<\/strong> \(2 KB\)/.test(html));
        ok('both local cases are offered', (html.match(/<option /g) || []).length === 2);
        ok('the case with the matching number is preselected',
            /value="1000" selected/.test(html), html.match(/<option[^>]*>/g));
        ok('overwrite is worded as the hazard it is',
            /Your own entry for that record is overwritten/.test(html));
        ok('the officer is told a summary comes first',
            /see exactly what changes before anything is written/.test(html));

        const dests = box.querySelectorAll('input[name="impDest"]');
        const modes = box.querySelectorAll('input[name="impMode"]');
        const [, okBtn] = box.querySelectorAll('.viper-confirm-btns button');
        ok('add-to-existing is the default when there are cases to add to',
            dests.find(r => r.value === 'merge').checked === true);
        ok('"only what I do not have" is the default mode',
            modes.find(r => r.value === 'new').checked === true);

        modes.find(r => r.value === 'new').checked = false;
        modes.find(r => r.value === 'overwrite').checked = true;
        okBtn.onclick();
        const picked = await promise;
        ok('the screen returns the case that was selected',
            picked.kind === 'merge' && picked.target.id === 1000, picked);
        ok('and the mode that was ticked', picked.mergeMode === 'overwrite', picked);
    }

    section('the destination screen with no cases to merge into');
    {
        const env = makeEnv({ cases: [] });
        const promise = env._promptImportDestination(pkg(), null);
        const box = env._created[env._created.length - 1];
        const dests = box.querySelectorAll('input[name="impDest"]');
        ok('new case is forced when there is nothing to add to',
            dests.find(r => r.value === 'new').checked === true);
        ok('and the merge option is disabled rather than quietly broken',
            dests.find(r => r.value === 'merge').disabled === true);
        const [, okBtn] = box.querySelectorAll('.viper-confirm-btns button');
        okBtn.onclick();
        const picked = await promise;
        ok('it returns a new-case choice', picked && picked.kind === 'new', picked);
    }

    section('the summary screen');
    {
        const env = makeEnv();
        const local = { suspects: [{ id: 1, name: 'Doe, John', dob: '1990-01-02' }] };
        const incoming = {
            suspects: [
                { id: 1, name: 'Doe, John', dob: '1990-01-02' },
                { id: 2, name: 'Roe, Jane', dob: '1988-05-05' },
            ]
        };
        const plan = CaseMerge.planMerge(local, incoming, 'new', {
            registry: CaseStores, officer: { who: 'M. Alvarez' }, packageId: 'PKG1'
        });

        const promise = env._promptMergeSummary(plan, null, HOST_CASE, pkg(), {});
        const box = env._created[env._created.length - 1];
        const html = box.innerHTML;
        ok('the target case is named, so it cannot land in the wrong one unnoticed',
            html.indexOf('Adding to case 26-0905538') > 0);
        ok('the counts are shown before anything is written', /1 new/.test(html) && /1 already here/.test(html));
        ok('the mode is spelled out in words',
            /adding only what you do not already have/.test(html));
        ok('the officer is told it can be undone', /can be undone/.test(html));
        const [cancel] = box.querySelectorAll('.viper-confirm-btns button');
        cancel.onclick();
        ok('cancel answers no', (await promise) === false);

        /* nothing to add */
        const flat = CaseMerge.planMerge(local, local, 'new', {
            registry: CaseStores, officer: { who: 'M. Alvarez' }, packageId: 'PKG2'
        });
        const promise2 = env._promptMergeSummary(flat, null, HOST_CASE, pkg(), {});
        const box2 = env._created[env._created.length - 1];
        ok('a package with nothing new says so plainly',
            /Nothing in this package is new to your case/.test(box2.innerHTML));
        ok('and the Add button is disabled rather than doing nothing when pressed',
            /Add to this case<\/button>/.test(box2.innerHTML.replace(/\s+disabled[^>]*>/, '>')) &&
            /disabled/.test(box2.innerHTML));
        const [cancel2] = box2.querySelectorAll('.viper-confirm-btns button');
        cancel2.onclick();
        await promise2;
    }

    section('the wizard as shipped');
    {
        ok('it never writes a merged store with a bare setItem',
            !/localStorage\.setItem\(`\$\{s\.key\}/.test(WIZARD_SRC));
        ok('the rollback path exists and is reached from the failure branch',
            /if \(res\.failedKey\) \{[\s\S]{0,300}_restoreCaseStores\(target, plan\.before, res\.done\)/.test(WIZARD_SRC));
        ok('the values written are the ones the summary counted, not a second computation',
            /const writes = window\.CaseMerge\.applyMerge\(plan\);/.test(WIZARD_SRC));
        ok('undo does not delete case files',
            /Case FILES are deliberately not removed/.test(WIZARD_SRC));
    }

    console.log('\n' + (fail === 0 ? 'OK' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
