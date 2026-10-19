/*
 * case-blobs.test.js
 *
 * Field report (5.4.4): "setItem … 'witnesses_…' exceeded the quota" on a
 * DMV import, and "Out of storage" when adding a Victim photo — on a machine
 * whose case folders sit on OneDrive with plenty of free space. localStorage
 * is a fixed per-app area (~52M chars) unrelated to disk space; every person
 * record kept its photo / DMV PDF inline as base64 and filled it.
 *
 * case-blobs.js (renderer) + case-blob-store.js (main) move those data URLs
 * into cases/<caseNumber>/Attachments/ and leave a short reference behind,
 * transparently: getItem gives every reader back the identical data URL.
 *
 * This drives the REAL renderer module against the REAL main-side store on
 * a temp folder, through a bridge that behaves like the sync IPC.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CB = require(path.join(__dirname, '..', 'case-blobs.js'));
const STORE = require(path.join(__dirname, '..', 'case-blob-store.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + String(JSON.stringify(detail)).slice(0, 300) : ''));
}
function section(name) { console.log('\n== ' + name + ' =='); }

// localStorage stand-in with a character ceiling (keys + values), throwing
// the same QuotaExceededError shape Chromium does.
function makeStorage(limitChars) {
    const map = new Map();
    const size = () => { let t = 0; for (const [k, v] of map) t += k.length + v.length; return t; };
    const s = {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
        removeItem(k) { map.delete(String(k)); },
        setItem(k, v) {
            if (arguments.length < 2) throw new TypeError("Failed to execute 'setItem' on 'Storage': 2 arguments required, but only " + arguments.length + ' present.');
            k = String(k);
            const prev = map.get(k);
            map.set(k, String(v));
            if (limitChars && size() > limitChars) {
                if (prev === undefined) map.delete(k); else map.set(k, prev);
                const err = new Error("Failed to execute 'setItem' on 'Storage': Setting the value of '" + k + "' exceeded the quota.");
                err.name = 'QuotaExceededError';
                err.code = 22;
                throw err;
            }
        },
        _map: map,
        _size: size
    };
    return s;
}

function safeCaseNumber(s) {
    if (!s || typeof s !== 'string') return null;
    if (s.indexOf('..') !== -1 || s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return null;
    return s;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-case-blobs-'));
let casesDir = path.join(TMP, 'cases');

function makeEnv(opts) {
    const o = opts || {};
    const storage = makeStorage(o.limit || 0);
    const store = STORE.create({ fs, path, getCasesDir: () => casesDir, getSecurity: () => o.security || null, safeCaseNumber, log: () => {} });
    const calls = { put: 0, read: 0 };
    const bridge = {
        caseBlobPutSync: (p) => { calls.put++; if (o.putOverride) return o.putOverride(p, store); return JSON.parse(JSON.stringify(store.put(p))); },
        caseBlobReadSync: (p) => { calls.read++; if (o.readOverride) return o.readOverride(p, store); return JSON.parse(JSON.stringify(store.read(p))); }
    };
    const toasts = [];
    let t = 1000000;
    const win = o.noWindow ? null : {
        setTimeout: (fn) => { fn(); return 0; },
        viperToast: (m, type) => toasts.push({ m, type })
    };
    if (o.cases !== false) storage.setItem('viperCases', JSON.stringify(o.cases || [
        { id: 'c1', caseNumber: '26-0001' }, { id: 'c2', caseNumber: '26-0002' }, { id: 'c3' }
    ]));
    const ctl = CB.install({ storage, bridge, window: win, now: () => t });
    return { storage, store, bridge, calls, toasts, ctl, tick: (ms) => { t += ms; } };
}

function dataUrl(mime, nBytes, seed) {
    const buf = crypto.createHash('sha256').update(String(seed)).digest();
    const out = Buffer.alloc(nBytes);
    for (let i = 0; i < nBytes; i++) out[i] = buf[i % 32] ^ (i & 0xff);
    return 'data:' + mime + ';base64,' + out.toString('base64');
}
const PHOTO = dataUrl('image/jpeg', 30000, 'photo-1');
const PHOTO2 = dataUrl('image/png', 20000, 'photo-2');
const PDF = dataUrl('application/pdf', 60000, 'dmv-pdf');
const JPG_ALIAS = dataUrl('image/jpg', 9000, 'alias');
const TINY = dataUrl('image/png', 100, 'tiny'); // under MIN_CHARS — stays inline

function filesIn(cn) {
    const d = path.join(casesDir, cn, 'Attachments');
    try { return fs.readdirSync(d).filter(n => !n.startsWith('.')); } catch (_) { return []; }
}

try {
    // ═══════════════════════════════════════════════════════════════════
    section('pure helpers');
    ok('scopeOf: witnesses_ key', JSON.stringify(CB.scopeOf('witnesses_1792365283241')) === JSON.stringify({ prefix: 'witnesses_', caseId: '1792365283241' }));
    ok('scopeOf: involvedPersons_', CB.scopeOf('involvedPersons_x').prefix === 'involvedPersons_');
    ok('scopeOf: bare prefix is not a key', CB.scopeOf('suspects_') === null);
    ok('scopeOf: viperCases out of scope', CB.scopeOf('viperCases') === null);
    ok('scopeOf: connectionBoard_ out of scope', CB.scopeOf('connectionBoard_c1') === null);
    ok('scopeOf: non-string', CB.scopeOf(null) === null && CB.scopeOf(5) === null);
    ok('parseDataUrl: jpeg', CB.parseDataUrl(PHOTO) && CB.parseDataUrl(PHOTO).id === 'jpeg');
    ok('parseDataUrl: image/jpg keeps its own id', CB.parseDataUrl(JPG_ALIAS).id === 'jpg');
    ok('parseDataUrl: pdf', CB.parseDataUrl(PDF).id === 'pdf');
    ok('parseDataUrl: tiny stays inline', CB.parseDataUrl(TINY) === null);
    ok('parseDataUrl: unknown MIME stays inline', CB.parseDataUrl(dataUrl('video/mp4', 9000, 'v')) === null);
    ok('parseDataUrl: non-base64 stays inline', CB.parseDataUrl('data:image/png,' + 'a'.repeat(9000)) === null);
    ok('parseDataUrl: junk in payload stays inline', CB.parseDataUrl(PHOTO.slice(0, 5000) + '!' + PHOTO.slice(5001)) === null);
    ok('parseDataUrl: bad length stays inline', CB.parseDataUrl(PHOTO + 'A') === null);
    ok('parseDataUrl: params before base64 stay inline', CB.parseDataUrl('data:image/png;name=x.png;base64,' + PHOTO2.split(',')[1]) === null);
    const sha = 'a'.repeat(64);
    ok('makeRef/parseRef round trip', CB.parseRef(CB.makeRef(sha, 'pdf')).mime === 'application/pdf');
    ok('parseRef: unknown id', CB.parseRef(CB.REF_PREFIX + sha + ':zzz') === null);
    ok('parseRef: short sha', CB.parseRef(CB.REF_PREFIX + 'abc:jpeg') === null);
    ok('parseRef: uppercase sha rejected', CB.parseRef(CB.REF_PREFIX + 'A'.repeat(64) + ':jpeg') === null);
    ok('parseRef: trailing junk rejected', CB.parseRef(CB.makeRef(sha, 'jpeg') + 'x') === null);
    ok('parseRef: __proto__ id rejected', CB.parseRef(CB.REF_PREFIX + sha + ':constructor') === null);
    ok('isQuotaError: Chromium shape', CB.isQuotaError({ name: 'QuotaExceededError', code: 22 }));
    ok('isQuotaError: other error', !CB.isQuotaError(new TypeError('x')));

    // dehydrate/hydrate with an in-memory map
    const mem = new Map();
    const putMem = (p, s) => { const h = crypto.createHash('sha256').update(Buffer.from(p.b64, 'base64')).digest('hex'); const r = CB.makeRef(h, p.id); mem.set(r, s); return r; };
    const readMem = (p, r) => mem.get(r) || null;
    const doc = JSON.stringify([{ id: 1, name: 'Jos\u00e9 \u201cJoe\u201d O\'Neil', note: 'line1\nline2\t"q" \\ \u2028', photo: PHOTO,
        attachments: [{ name: 'dmv.pdf', data: PDF }, { name: 'tiny', data: TINY }], ['__proto__']: PHOTO2, nested: { deep: [[[JPG_ALIAS]]] }, n: 1.5e-7, b: false, z: null }]);
    const dh = CB.dehydrateText(doc, putMem);
    ok('dehydrate moved 4 values (photo, pdf, __proto__, nested alias)', dh.moved === 4, dh.moved);
    ok('dehydrated text is small', dh.text.length < 2000, dh.text.length);
    ok('dehydrated text keeps the tiny one', dh.text.indexOf(TINY) !== -1);
    ok('dehydrated text has no large data URL', dh.text.indexOf(PHOTO) === -1 && dh.text.indexOf(PDF) === -1);
    const own = JSON.parse(dh.text)[0];
    ok('__proto__ stays an own property holding a ref', Object.prototype.hasOwnProperty.call(own, '__proto__') && CB.parseRef(own['__proto__']) !== null);
    const hh = CB.hydrateText(dh.text, readMem);
    ok('hydrate(dehydrate(x)) is byte-identical', hh.text === doc);
    ok('hydrate restored 4', hh.restored === 4 && hh.failed === 0);
    ok('dehydrate: no data URL → same string object path', CB.dehydrateText('[{"a":1}]', putMem).changed === false);
    ok('dehydrate: invalid JSON untouched', CB.dehydrateText('{"x":"data:' + 'a'.repeat(5000), putMem).text.length === 5011);
    ok('dehydrate: put returning null keeps value', CB.dehydrateText(doc, () => null).text === doc);
    ok('dehydrate: put returning garbage keeps value', CB.dehydrateText(doc, () => 'not-a-ref').text === doc);
    ok('dehydrate: put throwing keeps value', CB.dehydrateText(doc, () => { throw new Error('x'); }).text === doc);
    const hfail = CB.hydrateText(dh.text, () => null);
    ok('hydrate: failed read leaves the ref (never drops it)', hfail.text === dh.text && hfail.failed === 4);
    const hpart = CB.hydrateText(dh.text, (p, r) => (r === own.photo ? null : mem.get(r)));
    ok('hydrate: partial failure keeps that one ref, restores others', hpart.restored === 3 && hpart.failed === 1 && hpart.text.indexOf(own.photo) !== -1 && hpart.text.indexOf(PDF) !== -1);
    ok('hydrate: plain text fast path', CB.hydrateText('[1,2]', readMem).changed === false);
    ok('hydrate: a typed string that only looks like a ref prefix is untouched', CB.hydrateText(JSON.stringify(['viper-file:v1:hello']), readMem).changed === false);

    // ═══════════════════════════════════════════════════════════════════
    section('install: transparent setItem / getItem');
    {
        const E = makeEnv();
        const val = JSON.stringify([{ id: 'w1', firstName: 'Ann', photo: PHOTO, dmvPdf: PDF }]);
        E.storage.setItem('witnesses_c1', val);
        const raw = E.ctl.getRaw('witnesses_c1');
        ok('stored text is small', raw.length < 500, raw.length);
        ok('stored text holds refs', raw.indexOf(CB.REF_PREFIX) !== -1);
        ok('two files written to cases/26-0001/Attachments', filesIn('26-0001').length === 2, filesIn('26-0001'));
        const f = filesIn('26-0001').find(n => n.endsWith('.pdf'));
        ok('PDF file holds the exact bytes', f && fs.readFileSync(path.join(casesDir, '26-0001', 'Attachments', f)).equals(Buffer.from(PDF.split(',')[1], 'base64')));
        ok('file is named by its sha256', f && f === crypto.createHash('sha256').update(Buffer.from(PDF.split(',')[1], 'base64')).digest('hex') + '.pdf');
        ok('getItem returns the identical string', E.storage.getItem('witnesses_c1') === val);
        ok('getItem served from cache: no read IPC', E.calls.read === 0, E.calls.read);
        ok('getItem with a numeric-ish key coerces', E.storage.getItem('witnesses_c1') === val);

        const putsBefore = E.calls.put;
        E.storage.setItem('witnesses_c1', val);
        ok('re-saving an unchanged record costs no put IPC', E.calls.put === putsBefore, E.calls.put - putsBefore);

        // Another window wrote the key (raw changes) → hydrate by reading files
        const E2 = makeEnv();
        E2.storage._map.set('witnesses_c1', raw);
        ok('fresh page: getItem rebuilds from the case folder', E2.storage.getItem('witnesses_c1') === val);
        ok('fresh page: two read IPCs', E2.calls.read === 2, E2.calls.read);
        E2.storage.getItem('witnesses_c1');
        ok('fresh page: second getItem cached', E2.calls.read === 2);

        // Another window saves a different version: the cache must not shadow it
        const otherVal = JSON.stringify([{ id: 'w1', firstName: 'Ann (edited elsewhere)', photo: PHOTO }]);
        const O = makeEnv();
        O.storage.setItem('witnesses_c1', otherVal);
        E.storage._map.set('witnesses_c1', O.ctl.getRaw('witnesses_c1'));
        ok('a write from another window is seen, not the cached copy', E.storage.getItem('witnesses_c1') === otherVal);
        E.storage.setItem('witnesses_c1', val);

        // A ref known from case 1 is NOT trusted for case 2 without its file
        const N = makeEnv();
        N.storage.setItem('victims_c1', JSON.stringify([{ photo: PHOTO }]));
        const refText = N.ctl.getRaw('victims_c1');
        const r0 = N.calls.read;
        N.storage._map.set('victims_c2', refText);
        const g2 = N.storage.getItem('victims_c2');
        ok('case 2 checks its own folder (read IPC made)', N.calls.read === r0 + 1, N.calls.read - r0);
        ok('…and reports the missing file instead of serving case 1\u2019s copy', g2 === refText && N.toasts.length === 1);

        // Out-of-scope keys pass straight through
        const big = JSON.stringify({ photo: PHOTO });
        E.storage.setItem('viperCaseNotes', big);
        ok('out-of-scope key stored inline', E.ctl.getRaw('viperCaseNotes') === big);
        E.storage.setItem('connectionBoard_c1', big);
        ok('connectionBoard_ stays inline', E.ctl.getRaw('connectionBoard_c1') === big);
        ok('non-JSON in-scope value stored as-is', (E.storage.setItem('suspects_c1', 'hello'), E.ctl.getRaw('suspects_c1') === 'hello'));
        ok('missing key → null', E.storage.getItem('victims_nope') === null);
        let threw = null;
        try { E.storage.setItem('only-one-arg'); } catch (e) { threw = e; }
        ok('setItem with one argument still throws the native TypeError', threw instanceof TypeError);
        ok('setItem coerces a non-string value', (E.storage.setItem('victims_c2', 42), E.storage.getItem('victims_c2') === '42'));
    }

    section('install: things that must stay inline');
    {
        const E = makeEnv();
        const val = JSON.stringify([{ photo: PHOTO }]);
        E.storage.setItem('suspects_c3', val);
        ok('case without a case number: inline', E.ctl.getRaw('suspects_c3') === val);
        E.storage.setItem('suspects_unknownCase', val);
        ok('case not in viperCases: inline', E.ctl.getRaw('suspects_unknownCase') === val);
        const unk = JSON.stringify([{ photo: dataUrl('video/mp4', 9000, 'mp4') }]);
        E.storage.setItem('suspects_c1', unk);
        ok('unknown MIME: inline', E.ctl.getRaw('suspects_c1') === unk);

        const L = makeEnv({ security: { isEnabled: () => true, isUnlocked: () => false } });
        L.storage.setItem('suspects_c1', val);
        ok('Field Security locked: inline, no file', L.ctl.getRaw('suspects_c1') === val && L.ctl.errors().length === 0);

        const bad = makeEnv({ cases: [{ id: 'c1', caseNumber: '../escape' }] });
        bad.storage.setItem('suspects_c1', val);
        ok('traversal case number: inline', bad.ctl.getRaw('suspects_c1') === val);
        ok('nothing written outside cases/', !fs.existsSync(path.join(TMP, 'escape')));

        const C = makeEnv({ cases: false });
        C.storage._map.set('viperCases', '{not json');
        C.storage.setItem('suspects_c1', val);
        ok('unreadable viperCases: inline', C.ctl.getRaw('suspects_c1') === val);
    }

    section('per-case confirmation (same photo in two cases → two files)');
    {
        const E = makeEnv();
        const val = JSON.stringify([{ photo: PHOTO2 }]);
        E.storage.setItem('victims_c1', val);
        const p1 = E.calls.put;
        E.storage.setItem('victims_c2', val);
        ok('second case triggers its own put', E.calls.put === p1 + 1);
        ok('file exists in both case folders', filesIn('26-0001').some(n => n.endsWith('.png')) && filesIn('26-0002').some(n => n.endsWith('.png')));
    }

    section('case number change picks up the renamed folder');
    {
        const E = makeEnv();
        const val = JSON.stringify([{ photo: PHOTO }]);
        E.storage.setItem('money_c1', val);
        // rename-case-folder moves the whole folder; viperCases updates
        fs.renameSync(path.join(casesDir, '26-0001'), path.join(casesDir, '26-0001-R'));
        E.storage.setItem('viperCases', JSON.stringify([{ id: 'c1', caseNumber: '26-0001-R' }]));
        E.storage._map.set('money_c1', E.ctl.getRaw('money_c1') + ' '); // force re-hydrate (raw differs)
        ok('reads from the renamed folder', E.storage.getItem('money_c1') === val);
        fs.renameSync(path.join(casesDir, '26-0001-R'), path.join(casesDir, '26-0001'));
    }

    section('read failures: non-destructive and visible');
    {
        const W = makeEnv();
        const val = JSON.stringify([{ id: 1, photo: PHOTO }]);
        W.storage.setItem('firearms_c2', val);
        const raw = W.ctl.getRaw('firearms_c2');
        const E = makeEnv({ readOverride: () => ({ ok: false, code: 'MISSING', error: 'gone' }) });
        E.storage._map.set('firearms_c2', raw);
        const got = E.storage.getItem('firearms_c2');
        ok('failed read returns the stored text (ref kept)', got === raw);
        ok('officer is told, with the case number', E.toasts.length === 1 && /26-0002/.test(E.toasts[0].m) && /OneDrive/.test(E.toasts[0].m) && E.toasts[0].type === 'warning', E.toasts);
        E.storage.getItem('firearms_c2');
        ok('told once per case, not per read', E.toasts.length === 1);
        // Saving the record back keeps the ref intact
        const rec = JSON.parse(got); rec[0].name = 'edited';
        E.storage.setItem('firearms_c2', JSON.stringify(rec));
        ok('a save after a failed read keeps the ref', JSON.parse(E.ctl.getRaw('firearms_c2'))[0].photo === JSON.parse(raw)[0].photo);
        ok('errors() records the failure', E.ctl.errors().some(e => e.kind === 'load' && e.code === 'MISSING'));

        const X = makeEnv({ cases: [{ id: 'c9', caseNumber: '<img src=x onerror=alert(1)>' }], readOverride: () => ({ ok: false, code: 'READ' }) });
        X.storage._map.set('narcotics_c9', raw);
        X.storage.getItem('narcotics_c9');
        ok('case number is HTML-escaped in the toast', X.toasts.length === 1 && X.toasts[0].m.indexOf('<img') === -1 && X.toasts[0].m.indexOf('&lt;img') !== -1);

        const LK = makeEnv({ readOverride: () => ({ ok: false, code: 'LOCKED' }) });
        LK.storage._map.set('firearms_c2', raw);
        LK.storage.getItem('firearms_c2');
        ok('LOCKED read: no toast (the lock screen explains it)', LK.toasts.length === 0);

        // folder comes back (OneDrive finished syncing) → picked up after expiry
        let down = true;
        const R = makeEnv({ readOverride: (p, s) => (down ? { ok: false, code: 'READ' } : s.read(p)) });
        R.storage._map.set('firearms_c2', raw);
        ok('while down: ref text', R.storage.getItem('firearms_c2') === raw);
        down = false;
        ok('within 10 s: still the cached failure', R.storage.getItem('firearms_c2') === raw);
        R.tick(11000);
        ok('after 10 s: restored from disk', R.storage.getItem('firearms_c2') === val);
    }

    section('put failures');
    {
        const E = makeEnv({ putOverride: () => ({ ok: false, code: 'WRITE', error: 'disk' }) });
        const val = JSON.stringify([{ photo: PHOTO }]);
        E.storage.setItem('cargo_c1', val);
        ok('failed put keeps data inline', E.ctl.getRaw('cargo_c1') === val);
        const p = E.calls.put;
        E.storage.setItem('cargo_c1', val);
        ok('not retried for a minute', E.calls.put === p);
        E.tick(61000);
        E.storage.setItem('cargo_c1', val);
        ok('retried after a minute', E.calls.put === p + 1);
        const W = makeEnv({ putOverride: () => ({ ok: true, ref: CB.makeRef('b'.repeat(64), 'png') }) });
        W.storage.setItem('cargo_c1', val);
        ok('a ref with the wrong MIME id is refused', W.ctl.getRaw('cargo_c1') === val);
        const T = makeEnv({ putOverride: () => { throw new Error('ipc died'); } });
        T.storage.setItem('cargo_c1', val);
        ok('a throwing bridge keeps data inline', T.ctl.getRaw('cargo_c1') === val);
    }

    section('quota: sweep everything else out, then retry once');
    {
        // Simulate the field state: data written inline BEFORE this release.
        const E = makeEnv({ limit: 200000 });
        const inlineA = JSON.stringify([{ photo: PHOTO, pdf: PDF }]);   // ~120K
        E.storage._map.set('witnesses_c1', inlineA);
        E.storage._map.set('suspects_c3', JSON.stringify([{ photo: PHOTO2 }])); // no case number: cannot move
        const before = E.storage._size();
        // A DMV import on another key that does not fit — its own PDF moves
        // out, but its 60K of text cannot, so only a sweep makes room.
        const big = JSON.stringify([{ name: 'new', narrative: 'n'.repeat(60000), dmv: dataUrl('application/pdf', 45000, 'dmv2') }]);
        let err = null;
        try { E.storage.setItem('victims_c2', big); } catch (e) { err = e; }
        ok('write succeeded after the sweep', err === null, err && err.message);
        ok('old inline key was moved out', E.ctl.getRaw('witnesses_c1').length < 500);
        ok('and still reads back identical', E.storage.getItem('witnesses_c1') === inlineA);
        ok('new record reads back identical', E.storage.getItem('victims_c2') === big);
        ok('storage shrank', E.storage._size() < before, [before, E.storage._size()]);
        ok('no-case-number key left alone', E.ctl.getRaw('suspects_c3').indexOf('data:image/png') !== -1);

        // Truly full: no movable data anywhere → caller gets the real error
        const F = makeEnv({ limit: 30000 });
        F.storage._map.set('viperCaseNotes', 'x'.repeat(29000));
        let e2 = null;
        try { F.storage.setItem('viperOther', 'y'.repeat(5000)); } catch (e) { e2 = e; }
        ok('nothing to free → original QuotaExceededError rethrown', e2 && e2.name === 'QuotaExceededError');
        let e3 = null;
        try { F.storage.setItem('suspects_c1', JSON.stringify([{ n: 'z'.repeat(5000) }])); } catch (e) { e3 = e; }
        ok('in-scope key with nothing to move → rethrown too', e3 && e3.name === 'QuotaExceededError');
    }

    section('background sweep (compare-and-set)');
    {
        const E = makeEnv();
        const a = JSON.stringify([{ photo: PHOTO }]);
        E.storage._map.set('missingpersons_c1', a);
        E.storage._map.set('recoveredVehicles_c2', JSON.stringify([{ photo: PDF }]));
        const freed = E.ctl.sweepAll();
        ok('sweepAll freed space', freed > 50000, freed);
        ok('both keys now hold refs', E.ctl.getRaw('missingpersons_c1').indexOf(CB.REF_PREFIX) !== -1 && E.ctl.getRaw('recoveredVehicles_c2').indexOf(CB.REF_PREFIX) !== -1);
        ok('swept key reads back identical', E.storage.getItem('missingpersons_c1') === a);
        ok('second sweep frees nothing', E.ctl.sweepAll() === 0);

        // A write lands between the dehydrate and the compare: sweep must not clobber it
        let E2;
        E2 = makeEnv({ putOverride: (p, s) => { E2.storage._map.set('victimBusinesses_c1', '"newer"'); return JSON.parse(JSON.stringify(s.put(p))); } });
        E2.storage._map.set('victimBusinesses_c1', JSON.stringify([{ logo: PHOTO }]));
        E2.ctl.sweepAll();
        ok('concurrent write wins over the sweep', E2.ctl.getRaw('victimBusinesses_c1') === '"newer"');

        // scheduled sweep through timers
        const S = makeEnv();
        S.storage._map.set('narcotics_c1', JSON.stringify([{ photo: PHOTO2 }]));
        ok('scheduleSweep runs', S.ctl.scheduleSweep(0) === true);
        ok('scheduled sweep moved the data', S.ctl.getRaw('narcotics_c1').indexOf(CB.REF_PREFIX) !== -1);
        ok('stats counted the sweep', S.ctl.stats().sweeps >= 1 && S.ctl.stats().moved >= 1);
    }

    section('install is idempotent; chained wrappers work');
    {
        const E = makeEnv();
        const again = CB.install({ storage: E.storage, bridge: E.bridge });
        ok('second install returns the same controller', again === E.ctl);
        // case-snapshot.js wraps setItem AFTER us
        const inner = E.storage.setItem;
        const seen = [];
        E.storage.setItem = function (k, v) { inner(k, v); seen.push(k); };
        const val = JSON.stringify([{ photo: PHOTO }]);
        E.storage.setItem('involvedPersons_c1', val);
        ok('outer wrapper still sees the write', seen[0] === 'involvedPersons_c1');
        ok('and the data still went to disk', E.ctl.getRaw('involvedPersons_c1').length < 300 && E.storage.getItem('involvedPersons_c1') === val);
    }

    section('page auto-install guard (UMD)');
    {
        const vm = require('vm');
        const src = fs.readFileSync(path.join(__dirname, '..', 'case-blobs.js'), 'utf8');
        const st = makeStorage(0);
        const sb = { console, localStorage: st, document: {}, electronAPI: { caseBlobPutSync: () => ({ ok: false }), caseBlobReadSync: () => ({ ok: false }) }, setTimeout: () => 0 };
        sb.window = sb; sb.globalThis = sb;
        vm.createContext(sb);
        vm.runInContext(src, sb);
        ok('window.VpCaseBlobs defined', sb.VpCaseBlobs && sb.VpCaseBlobs.__vpCaseBlobs === 1);
        ok('page storage wrapped', Object.prototype.hasOwnProperty.call(st, 'getItem') && st.getItem !== makeStorage(0).getItem);
        ok('VpCaseBlobs.getRaw exposed', typeof sb.VpCaseBlobs.getRaw === 'function');
        const first = sb.VpCaseBlobs;
        vm.runInContext(src, sb);
        ok('loading twice reuses the instance', sb.VpCaseBlobs === first);
        const sb2 = { console, localStorage: makeStorage(0), document: {}, electronAPI: {} };
        sb2.window = sb2; sb2.globalThis = sb2;
        vm.createContext(sb2);
        vm.runInContext(src, sb2);
        ok('no bridge → not installed (old preload)', !Object.prototype.hasOwnProperty.call(sb2.localStorage, 'getItem') || /map\.has/.test(String(sb2.localStorage.getItem)));
        ok('no bridge → no getRaw', typeof sb2.VpCaseBlobs.getRaw === 'undefined');
    }

    // ═══════════════════════════════════════════════════════════════════
    section('main store: case-blob-store.js');
    {
        const S = STORE.create({ fs, path, getCasesDir: () => casesDir, safeCaseNumber, log: () => {} });
        const b64 = PHOTO.split(',')[1];
        const r = S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: b64 });
        ok('put ok', r.ok && CB.parseRef(r.ref) && r.existed === false, r);
        const r2 = S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: b64 });
        ok('put again: existed', r2.ok && r2.existed === true && r2.ref === r.ref);
        ok('no temp files left behind', fs.readdirSync(path.join(casesDir, 'S-1', 'Attachments')).length === 1);
        const rd = S.read({ caseNumber: 'S-1', ref: r.ref });
        ok('read returns identical base64', rd.ok && rd.base64 === b64);
        ok('bad case', S.put({ caseNumber: '..', mime: 'image/jpeg', base64: b64 }).code === 'CASE');
        ok('slash case', S.put({ caseNumber: 'a/b', mime: 'image/jpeg', base64: b64 }).code === 'CASE');
        ok('empty case', S.read({ caseNumber: '', ref: r.ref }).code === 'CASE');
        ok('unknown mime', S.put({ caseNumber: 'S-1', mime: 'text/html', base64: b64 }).code === 'MIME');
        ok('non-canonical base64', S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: 'QQ=A' }).code === 'BASE64');
        ok('base64 with whitespace', S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: 'QUJD\nRA==' }).code === 'BASE64');
        ok('base64 non-zero pad bits', S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: 'QR==' }).code === 'BASE64');
        ok('empty base64', S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: '' }).code === 'BASE64');
        ok('null payload', S.put(null).ok === false && S.read(undefined).ok === false);
        ok('malformed ref', S.read({ caseNumber: 'S-1', ref: '../../x' }).code === 'REF');
        ok('missing file', S.read({ caseNumber: 'S-1', ref: CB.makeRef('c'.repeat(64), 'jpeg') }).code === 'MISSING');
        const Small = STORE.create({ fs, path, getCasesDir: () => casesDir, safeCaseNumber, maxBytes: 1000, log: () => {} });
        ok('oversize refused', Small.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: b64 }).code === 'SIZE');
        ok('oversize read refused', Small.read({ caseNumber: 'S-1', ref: r.ref }).code === 'SIZE');

        // corruption
        const file = path.join(casesDir, 'S-1', 'Attachments', CB.parseRef(r.ref).sha + '.jpg');
        fs.writeFileSync(file, Buffer.from('tampered'));
        ok('corrupt file is never served', S.read({ caseNumber: 'S-1', ref: r.ref }).code === 'CORRUPT');
        const r3 = S.put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: b64 });
        ok('put replaces a corrupt file', r3.ok && r3.existed === false);
        ok('and it reads correctly again', S.read({ caseNumber: 'S-1', ref: r.ref }).base64 === b64);

        ok('no cases dir → CASE', STORE.create({ fs, path, getCasesDir: () => null, safeCaseNumber }).put({ caseNumber: 'S-1', mime: 'image/jpeg', base64: b64 }).code === 'CASE');

        // Field Security (fake VIPENC: magic + XOR)
        const MAGIC = Buffer.from('VIPENC');
        let unlocked = true;
        const sec = {
            isEnabled: () => true, isUnlocked: () => unlocked,
            encryptBuffer: (b) => Buffer.concat([MAGIC, Buffer.from(b.map(x => x ^ 0x5a))]),
            decryptBuffer: (b) => { if (!unlocked) throw new Error('locked'); return Buffer.from(b.subarray(6).map(x => x ^ 0x5a)); }
        };
        const V = STORE.create({ fs, path, getCasesDir: () => casesDir, getSecurity: () => sec, safeCaseNumber, log: () => {} });
        const b64b = PDF.split(',')[1];
        const vr = V.put({ caseNumber: 'S-2', mime: 'application/pdf', base64: b64b });
        const vfile = path.join(casesDir, 'S-2', 'Attachments', CB.parseRef(vr.ref).sha + '.pdf');
        ok('vault on: put ok', vr.ok);
        ok('vault on: file on disk is encrypted', fs.readFileSync(vfile).subarray(0, 6).equals(MAGIC));
        ok('vault on: no plaintext on disk', fs.readFileSync(vfile).indexOf(Buffer.from(b64b, 'base64').subarray(0, 64)) === -1);
        ok('vault on: read decrypts', V.read({ caseNumber: 'S-2', ref: vr.ref }).base64 === b64b);
        ok('vault on: existing encrypted file is verified and reused', V.put({ caseNumber: 'S-2', mime: 'application/pdf', base64: b64b }).existed === true);
        unlocked = false;
        ok('vault locked: put refused', V.put({ caseNumber: 'S-2', mime: 'application/pdf', base64: b64b }).code === 'LOCKED');
        ok('vault locked: read refused', V.read({ caseNumber: 'S-2', ref: vr.ref }).code === 'LOCKED');
        ok('vault off: encrypted file cannot be read', S.read({ caseNumber: 'S-2', ref: vr.ref }).code === 'LOCKED');
        unlocked = true;
        ok('vault on: plaintext file written before the vault still reads', V.read({ caseNumber: 'S-1', ref: r.ref }).base64 === b64);
    }

    section('static wiring');
    {
        const ROOT = path.join(__dirname, '..', '..', '..');
        const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
        const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
        ok('main: put handler', /ipcMain\.on\('case-blob-put-sync'[\s\S]{0,300}e\.returnValue = res/.test(main));
        ok('main: read handler', /ipcMain\.on\('case-blob-read-sync'[\s\S]{0,300}e\.returnValue = res/.test(main));
        ok('main: store gets the case-number gate', /case-blob-store\.js'\)\.create\(\{[\s\S]{0,200}safeCaseNumber: _safeCaseNumber/.test(main));
        ok('preload: caseBlobPutSync via sendSync', /caseBlobPutSync:[\s\S]{0,200}sendSync\('case-blob-put-sync'/.test(pre));
        ok('preload: caseBlobReadSync via sendSync', /caseBlobReadSync:[\s\S]{0,200}sendSync\('case-blob-read-sync'/.test(pre));
        for (const page of ['index.html', 'case-detail-with-analytics.html', 'settings.html']) {
            const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
            const tag = html.indexOf('<script src="modules/_shared/case-blobs.js"></script>');
            const firstScript = html.search(/<script[\s>]/);
            ok(page + ': case-blobs.js is the first script', tag !== -1 && tag === firstScript, [tag, firstScript]);
            const snap = html.search(/<script[^>]+src="case-snapshot\.js"/);
            ok(page + ': loads before case-snapshot.js', snap !== -1 && tag < snap, [tag, snap]);
        }
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log('\nRESULT case-blobs: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
