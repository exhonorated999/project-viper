/**
 * Custom Tools ("Bring Your Own Tool") — store + credential vault tests.
 *
 * Covers the three things that can hurt an examiner:
 *   1. A URL that is not http(s) reaching BrowserView.loadURL.
 *   2. A blank password field silently wiping a stored password.
 *   3. A stored password leaking back across the IPC boundary.
 *
 * Run: node modules\__tests__\custom-tools.test.js
 * (plain Node is fine — neither module touches a native addon)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq = (n, a, b) => {
    const same = JSON.stringify(a) === JSON.stringify(b);
    ok(n + (same ? '' : ` -> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`), same);
};

/* ── localStorage shim, so the renderer store is testable headlessly ── */
const _store = new Map();
let _quotaFull = false;
global.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => {
        if (_quotaFull) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        _store.set(k, String(v));
    },
    removeItem: (k) => _store.delete(k),
    clear: () => _store.clear(),
};

const CT = require('../custom-tools');
const { CredentialVault } = require('../custom-tools-vault');

const reset = () => { _store.clear(); _quotaFull = false; };

(function () {

    /* ══ 1. URL normalisation — the security boundary ══════════════ */
    console.log('\n=== 1. normalizeUrl ===');

    eq('bare host gets https', CT.normalizeUrl('portal.example.gov').url, 'https://portal.example.gov/');
    eq('bare host + path', CT.normalizeUrl('portal.example.gov/warrants').url, 'https://portal.example.gov/warrants');
    ok('https passes', CT.normalizeUrl('https://a.example.gov/x').ok);
    ok('whitespace trimmed', CT.normalizeUrl('  https://a.example.gov  ').ok);
    ok('port allowed', CT.normalizeUrl('https://rms.example.gov:8443/login').ok);
    ok('query preserved', CT.normalizeUrl('https://a.example.gov/x?y=1').url.indexOf('y=1') > -1);

    // These are the ones that must never reach loadURL.
    ok('file: rejected', !CT.normalizeUrl('file:///C:/Windows/System32/').ok);
    ok('javascript: rejected', !CT.normalizeUrl('javascript:alert(1)').ok);
    ok('data: rejected', !CT.normalizeUrl('data:text/html,<h1>x').ok);
    ok('chrome: rejected', !CT.normalizeUrl('chrome://settings').ok);
    ok('about: rejected', !CT.normalizeUrl('about:blank').ok);
    ok('ftp: rejected', !CT.normalizeUrl('ftp://x.example.gov').ok);
    ok('empty rejected', !CT.normalizeUrl('').ok);
    ok('whitespace-only rejected', !CT.normalizeUrl('   ').ok);
    ok('null rejected', !CT.normalizeUrl(null).ok);
    ok('single word rejected (no dot)', !CT.normalizeUrl('intranet').ok);

    ok('localhost allowed', CT.normalizeUrl('localhost:3000').ok);
    ok('localhost http not flagged insecure', !CT.normalizeUrl('http://localhost:3000').insecure);
    ok('loopback IP http not flagged', !CT.normalizeUrl('http://127.0.0.1:8080').insecure);
    ok('remote http flagged insecure', CT.normalizeUrl('http://portal.example.gov').insecure === true);
    ok('remote http still accepted', CT.normalizeUrl('http://portal.example.gov').ok);
    ok('https not flagged insecure', !CT.normalizeUrl('https://portal.example.gov').insecure);

    // The host:port regression — a bare `host:port` must not be read as a
    // URL scheme. This broke every agency running an internal tool.
    eq('bare localhost:port', CT.normalizeUrl('localhost:3000').url, 'https://localhost:3000/');
    eq('bare host:port', CT.normalizeUrl('rms.example.gov:8443/login').url, 'https://rms.example.gov:8443/login');
    ok('bare localhost (no port) allowed', CT.normalizeUrl('localhost').ok);
    ok('bare host:port with digits still rejects mailto', !CT.normalizeUrl('mailto:tip@example.gov').ok);
    ok('vbscript: rejected', !CT.normalizeUrl('vbscript:msgbox(1)').ok);
    ok('a digit-leading fake scheme is still rejected', !CT.normalizeUrl('javascript:1').ok);
    ok('data with a digit body still rejected', !CT.normalizeUrl('data:1234').ok);

    /* ══ 2. Ids can never collide with a built-in ══════════════════ */
    console.log('\n=== 2. Ids ===');

    const idA = CT.makeId([]);
    ok('id is ct_-prefixed', /^ct_/.test(idA));
    ok('id is partition/DOM safe', /^[A-Za-z0-9_]+$/.test(idA));
    ok('isCustomId accepts own id', CT.isCustomId(idA));
    ['flock', 'tlo', 'accurint', 'whooster', 'vigilant', 'icacDataSystem', 'icacCops',
     'gridcop', 'callyo', 'outlook', 'leadsOnline', 'claimSearch', 'osintIndustries',
     'idiCore', 'trace', 'fmcsa'].forEach(b => {
        if (CT.isCustomId(b)) { fail++; console.log('  FAIL builtin id "' + b + '" looks custom'); }
    });
    ok('no builtin resource id is mistaken for custom', true);
    ok('isCustomId rejects traversal', !CT.isCustomId('ct_../../etc'));
    ok('isCustomId rejects empty', !CT.isCustomId(''));
    ok('isCustomId rejects null', !CT.isCustomId(null));
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(CT.makeId(Array.from(ids).map(x => ({ id: x }))));
    eq('200 ids are unique', ids.size, 200);

    /* ══ 3. validate ══════════════════════════════════════════════ */
    console.log('\n=== 3. validate ===');

    ok('missing name rejected', !CT.validate({ url: 'a.example.gov' }, []).ok);
    ok('missing url rejected', !CT.validate({ label: 'X' }, []).ok);
    ok('name + url accepted', CT.validate({ label: 'X', url: 'a.example.gov' }, []).ok);
    ok('overlong name rejected', !CT.validate({ label: 'x'.repeat(CT.MAX_LABEL + 1), url: 'a.example.gov' }, []).ok);
    ok('name at limit accepted', CT.validate({ label: 'x'.repeat(CT.MAX_LABEL), url: 'a.example.gov' }, []).ok);
    ok('overlong description rejected', !CT.validate({ label: 'X', url: 'a.example.gov', description: 'd'.repeat(CT.MAX_DESC + 1) }, []).ok);
    ok('whitespace-only name rejected', !CT.validate({ label: '   ', url: 'a.example.gov' }, []).ok);

    const dupeList = [{ id: 'ct_1', label: 'Warrant Portal', url: 'https://a.example.gov/' }];
    ok('duplicate name rejected', !CT.validate({ label: 'Warrant Portal', url: 'b.example.gov' }, dupeList).ok);
    ok('duplicate name is case-insensitive', !CT.validate({ label: 'warrant portal', url: 'b.example.gov' }, dupeList).ok);
    ok('editing itself is not a duplicate', CT.validate({ id: 'ct_1', label: 'Warrant Portal', url: 'b.example.gov' }, dupeList).ok);
    ok('validate reports every error at once', CT.validate({ label: '', url: 'javascript:1' }, []).errors.length >= 2);

    /* ══ 4. CRUD ══════════════════════════════════════════════════ */
    console.log('\n=== 4. add / update / remove ===');
    reset();

    eq('starts empty', CT.list(), []);
    const r1 = CT.add({ label: 'County E-Warrant', url: 'ewarrant.example.gov', description: 'Judicial submissions' });
    ok('add succeeded', r1.ok);
    eq('list has one', CT.list().length, 1);
    eq('label stored', CT.list()[0].label, 'County E-Warrant');
    eq('url normalised on add', CT.list()[0].url, 'https://ewarrant.example.gov/');
    eq('description stored', CT.list()[0].description, 'Judicial submissions');
    ok('enabled by default', CT.list()[0].enabled === true);
    ok('color assigned', CT.PALETTE.indexOf(CT.list()[0].color) > -1);
    ok('createdAt set', !!CT.list()[0].createdAt);

    const r2 = CT.add({ label: 'RMS', url: 'https://rms.example.gov/login' });
    ok('second add succeeded', r2.ok);
    ok('colors differ between the first two tools', CT.list()[0].color !== CT.list()[1].color);
    ok('duplicate label rejected at add', !CT.add({ label: 'RMS', url: 'other.example.gov' }).ok);
    ok('bad url rejected at add', !CT.add({ label: 'Evil', url: 'file:///C:/' }).ok);
    eq('rejected adds did not persist', CT.list().length, 2);

    const u1 = CT.update(r1.tool.id, { label: 'County E-Warrant Portal', description: '' });
    ok('update succeeded', u1.ok);
    eq('label updated', CT.get(r1.tool.id).label, 'County E-Warrant Portal');
    eq('description cleared', CT.get(r1.tool.id).description, '');
    eq('url survived a label-only update', CT.get(r1.tool.id).url, 'https://ewarrant.example.gov/');
    ok('update to a bad url rejected', !CT.update(r1.tool.id, { url: 'javascript:1' }).ok);
    eq('url unchanged after rejected update', CT.get(r1.tool.id).url, 'https://ewarrant.example.gov/');
    ok('update of unknown id rejected', !CT.update('ct_nope', { label: 'X' }).ok);

    CT.setEnabled(r1.tool.id, false);
    ok('setEnabled(false) applied', CT.get(r1.tool.id).enabled === false);
    eq('enabledTools excludes it', CT.enabledTools().length, 1);
    eq('list still includes it', CT.list().length, 2);
    CT.setEnabled(r1.tool.id, true);
    ok('setEnabled(true) restored', CT.get(r1.tool.id).enabled === true);

    eq('get returns null for unknown', CT.get('ct_missing'), null);

    /* ══ 5. Corruption tolerance — a bad entry must not blank the tray ══ */
    console.log('\n=== 5. Corrupt store tolerance ===');
    reset();

    localStorage.setItem(CT.STORE_KEY, 'not json at all');
    eq('unparseable store reads as empty', CT.list(), []);

    localStorage.setItem(CT.STORE_KEY, '{"not":"an array"}');
    eq('non-array store reads as empty', CT.list(), []);

    localStorage.setItem(CT.STORE_KEY, JSON.stringify([
        { id: 'ct_good', label: 'Good', url: 'https://a.example.gov/' },
        { id: 'flock', label: 'Hijack a builtin', url: 'https://evil.example/' },
        { id: 'ct_nourl', label: 'No url' },
        null,
        { label: 'No id', url: 'https://b.example.gov/' },
    ]));
    const survivors = CT.list();
    eq('only the valid entry survives', survivors.length, 1);
    eq('survivor is the good one', survivors[0].id, 'ct_good');
    eq('a missing label gets a placeholder',
        (function () {
            localStorage.setItem(CT.STORE_KEY, JSON.stringify([{ id: 'ct_x', url: 'https://a.example.gov/' }]));
            return CT.list()[0].label;
        })(), 'Untitled tool');

    /* ══ 6. Limits and quota ══════════════════════════════════════ */
    console.log('\n=== 6. Limits ===');
    reset();

    for (let i = 0; i < CT.MAX_TOOLS; i++) CT.add({ label: 'Tool ' + i, url: 't' + i + '.example.gov' });
    eq('filled to MAX_TOOLS', CT.list().length, CT.MAX_TOOLS);
    const over = CT.add({ label: 'One too many', url: 'x.example.gov' });
    ok('add past the cap is rejected', !over.ok);
    ok('cap error mentions the limit', /limit/i.test(over.errors[0]));
    eq('cap not exceeded', CT.list().length, CT.MAX_TOOLS);

    reset();
    CT.add({ label: 'A', url: 'a.example.gov' });
    _quotaFull = true;
    let threw = false;
    try { CT.add({ label: 'B', url: 'b.example.gov' }); } catch (_) { threw = true; }
    ok('QuotaExceededError propagates rather than silently losing the tool', threw);
    _quotaFull = false;

    /* ══ 7. Display helpers ═══════════════════════════════════════ */
    console.log('\n=== 7. Display helpers ===');

    eq('hostOf strips www', CT.hostOf('https://www.example.gov/x'), 'example.gov');
    eq('hostOf keeps subdomain', CT.hostOf('https://portal.example.gov/x'), 'portal.example.gov');
    eq('hostOf keeps a non-default port', CT.hostOf('https://rms.example.gov:8443/login'), 'rms.example.gov:8443');
    eq('hostOf omits an implicit 443', CT.hostOf('https://rms.example.gov/login'), 'rms.example.gov');
    eq('hostOf survives garbage', CT.hostOf('not a url'), 'not a url');
    eq('initials two words', CT.initialsOf('Warrant Portal'), 'WP');
    eq('initials one word', CT.initialsOf('Gridcop'), 'GR');
    eq('initials hyphenated', CT.initialsOf('E-Warrant'), 'EW');
    eq('initials empty', CT.initialsOf(''), '??');

    /* ══ 8. CredentialVault — encrypted path ══════════════════════ */
    console.log('\n=== 8. CredentialVault (safeStorage available) ===');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vault-'));
    // Reversible stand-in for DPAPI: proves we round-trip through
    // safeStorage rather than writing the plaintext.
    const fakeSafe = {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(s, 'utf8').reverse()]),
        decryptString: (b) => {
            const buf = Buffer.from(b);
            if (buf.slice(0, 4).toString() !== 'ENC:') throw new Error('bad blob');
            return Buffer.from(buf.slice(4)).reverse().toString('utf8');
        },
    };
    const v = new CredentialVault(dir, fakeSafe);
    const TID = 'ct_vault_1';

    eq('no creds initially', v.status(TID), { hasPassword: false, username: '', encrypted: true });

    const s1 = v.save(TID, 'jsmith', 'Sup3rSecret!');
    ok('save succeeded', s1.success);
    ok('save reports encrypted', s1.encrypted === true);

    const st1 = v.status(TID);
    ok('status reports hasPassword', st1.hasPassword === true);
    eq('status returns the username', st1.username, 'jsmith');
    ok('status reports encrypted', st1.encrypted === true);
    ok('status NEVER contains the password', !('password' in st1));
    ok('status has no stray secret value',
        JSON.stringify(st1).indexOf('Sup3rSecret!') === -1);

    // The on-disk file must not contain the plaintext.
    const onDisk = fs.readFileSync(path.join(dir, 'custom-tools-creds.json'), 'utf8');
    ok('plaintext password not on disk', onDisk.indexOf('Sup3rSecret!') === -1);
    ok('plaintext username not on disk', onDisk.indexOf('jsmith') === -1);
    ok('file records encrypted:true', /"encrypted"\s*:\s*true/.test(onDisk));

    const rev = v.reveal(TID);
    eq('reveal round-trips the username', rev.username, 'jsmith');
    eq('reveal round-trips the password', rev.password, 'Sup3rSecret!');

    /* ══ 9. The "leave blank to keep" contract ════════════════════ */
    console.log('\n=== 9. password === null keeps the stored password ===');

    v.save(TID, 'jsmith2', null);
    eq('username updated', v.status(TID).username, 'jsmith2');
    eq('password preserved through a null save', v.reveal(TID).password, 'Sup3rSecret!');
    ok('still reports hasPassword', v.status(TID).hasPassword === true);

    v.save(TID, 'jsmith2', 'Rotated#2');
    eq('an explicit new password replaces it', v.reveal(TID).password, 'Rotated#2');

    v.save(TID, 'jsmith2', '');
    eq('an explicit empty string clears the password', v.reveal(TID).password, '');
    ok('username kept when only the password is cleared', v.reveal(TID).username === 'jsmith2');

    // null on an entry that has nothing stored must not throw.
    const s2 = v.save('ct_vault_fresh', 'onlyuser', null);
    ok('null save on a fresh id succeeds', s2.success);
    eq('fresh null save yields an empty password', v.reveal('ct_vault_fresh').password, '');

    /* ══ 10. Clearing ════════════════════════════════════════════ */
    console.log('\n=== 10. clear ===');

    v.save('ct_vault_2', 'u2', 'p2');
    ok('two ids stored', v.ids().length >= 2);
    ok('clear succeeded', v.clear('ct_vault_2').success);
    ok('cleared id has no creds', v.status('ct_vault_2').hasPassword === false);
    ok('reveal on a cleared id is null', v.reveal('ct_vault_2') === null);
    ok('clearing an unknown id is not an error', v.clear('ct_vault_nope').success);
    ok('other ids untouched by a clear', v.reveal(TID) !== null);

    // Saving both fields empty is a delete.
    v.save('ct_vault_3', 'u3', 'p3');
    v.save('ct_vault_3', '', '');
    ok('empty username+password deletes the entry', v.ids().indexOf('ct_vault_3') === -1);

    /* ══ 11. Unencrypted fallback is surfaced, not hidden ═════════ */
    console.log('\n=== 11. safeStorage unavailable ===');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vault-plain-'));
    const noSafe = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('nope'); }, decryptString: () => { throw new Error('nope'); } };
    const v2 = new CredentialVault(dir2, noSafe);

    const s3 = v2.save('ct_plain', 'pu', 'pp');
    ok('save still succeeds without safeStorage', s3.success);
    ok('save reports encrypted:false', s3.encrypted === false);
    ok('status reports encrypted:false so the UI can warn', v2.status('ct_plain').encrypted === false);
    eq('creds still usable for auto-fill', v2.reveal('ct_plain').password, 'pp');
    ok('status with no entry also reports encrypted:false',
        v2.status('ct_absent').encrypted === false);

    /* ══ 12. Undecryptable blob reads as unreadable, not as absent ══ */
    console.log('\n=== 12. Rotated key / different Windows user ===');

    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vault-rot-'));
    const v3 = new CredentialVault(dir3, fakeSafe);
    v3.save('ct_rot', 'ru', 'rp');
    // Simulate a DPAPI key the current account cannot use.
    const brokenSafe = Object.assign({}, fakeSafe, { decryptString: () => { throw new Error('DPAPI failure'); } });
    const v3b = new CredentialVault(dir3, brokenSafe);
    const rotStatus = v3b.status('ct_rot');
    ok('unreadable flag set', rotStatus.unreadable === true);
    ok('hasPassword false when unreadable', rotStatus.hasPassword === false);
    ok('reveal returns null rather than throwing', v3b.reveal('ct_rot') === null);
    // And the UI must be able to fix it by re-entering.
    const v3c = new CredentialVault(dir3, fakeSafe);
    v3c.save('ct_rot', 'ru', 'newpass');
    eq('re-entering repairs the entry', v3c.reveal('ct_rot').password, 'newpass');
    ok('repaired entry no longer unreadable', !v3c.status('ct_rot').unreadable);

    /* ══ 13. Corrupt vault file ══════════════════════════════════ */
    console.log('\n=== 13. Corrupt vault file ===');

    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vault-bad-'));
    fs.writeFileSync(path.join(dir4, 'custom-tools-creds.json'), '{{{ not json', 'utf8');
    const v4 = new CredentialVault(dir4, fakeSafe);
    let vThrew = false;
    try {
        ok('corrupt vault reads as empty', v4.status('ct_any').hasPassword === false);
        ok('corrupt vault can be written over', v4.save('ct_any', 'u', 'p').success);
        eq('written value reads back', v4.reveal('ct_any').password, 'p');
    } catch (_) { vThrew = true; }
    ok('corrupt vault never throws at the IPC boundary', !vThrew);

    /* ── Cleanup ─────────────────────────────────────────────── */
    [dir, dir2, dir3, dir4].forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
