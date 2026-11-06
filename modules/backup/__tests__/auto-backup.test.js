'use strict';
/**
 * Automatic weekly backup — main module (real fs in a temp dir, real
 * archiver + adm-zip) and the renderer helpers. Synthetic data only.
 *
 *   node modules/backup/__tests__/auto-backup.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const M = require('../auto-backup-main.js');
const UI = require('../auto-backup.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }
async function throwsAsync(fn, re, name) {
    try { await fn(); ok(false, name, 'no throw'); }
    catch (e) { ok(re.test(e.message), name, e.message); }
}

const DAY = 864e5;
const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);       // Mon 2 Nov 2026 15:00Z

// ── Stub Field Security (same 'VIPENC' magic as modules/security.js) ──
const MAGIC = Buffer.from('VIPENC');
const xor = b => Buffer.from(b.map(x => x ^ 0x5a));
function makeSecurity(o) {
    return Object.assign({
        enabled: true, unlocked: true,
        isEnabled() { return this.enabled; },
        isUnlocked() { return this.unlocked; },
        isEncryptedBuffer(b) { return Buffer.isBuffer(b) && b.length >= 6 && b.subarray(0, 6).equals(MAGIC); },
        encryptBuffer(b) { if (!this.unlocked) throw new Error('locked'); return Buffer.concat([MAGIC, Buffer.from([1, 0]), xor(b)]); },
        decryptBuffer(b) { if (!this.isEncryptedBuffer(b)) return b; if (!this.unlocked) throw new Error('locked'); return xor(b.subarray(8)); },
    }, o || {});
}

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'viper-autobak-'));
}

function setup(opts) {
    opts = opts || {};
    const root = tmpRoot();
    const userData = path.join(root, 'userData');
    const cases = path.join(root, 'cases');
    const dest = path.join(root, 'Backups');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(path.join(cases, '26-000123', 'Evidence', 'Item 1'), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    const sec = opts.security === null ? null : (opts.security || makeSecurity());
    fs.writeFileSync(path.join(cases, '26-000123', 'notes.synthetic.txt'), 'SYNTHETIC note text');
    fs.writeFileSync(path.join(cases, '26-000123', 'Evidence', 'Item 1', 'photo.synthetic.jpg'), Buffer.alloc(5000, 7));
    if (sec) fs.writeFileSync(path.join(cases, '26-000123', 'Evidence', 'Item 1', 'sealed.synthetic.txt'), (sec.isUnlocked() ? sec : makeSecurity()).encryptBuffer(Buffer.from('SYNTHETIC sealed content')));
    const clock = { t: opts.t || T0 };
    const logs = [];
    const ab = M.createAutoBackup({
        userDataDir: userData,
        getCasesDir: () => cases,
        getSecurity: () => sec,
        now: () => clock.t,
        log: (...a) => logs.push(a.join(' ')),
        sqlite: opts.sqlite,
    });
    return { root, userData, cases, dest, sec, clock, ab, logs };
}

const DATA2 = JSON.stringify({ viperCases: JSON.stringify([{ id: 1, caseNumber: '26-000123' }, { id: 2, caseNumber: '26-000124' }]), viperSettings: '{}', suspects_1: '[]' });
const DATA0 = JSON.stringify({ viperCases: '[]', viperSettings: '{}' });

(async function main() {
    // ─────────────────────────────────────────────────────────────
    console.log('\n1. Pure helpers');
    eq(M.stampOf('VIPER_AutoBackup_2026-11-06T17-48-58-123Z.vbak'), Date.UTC(2026, 10, 6, 17, 48, 58, 123), 'stampOf auto');
    eq(M.stampOf('VIPER_Backup_2026-04-14T19-31-30-000Z.vbak'), Date.UTC(2026, 3, 14, 19, 31, 30, 0), 'stampOf manual');
    eq(M.stampOf('VIPER_Backup copy.vbak'), null, 'stampOf no stamp');
    eq(M.caseCountOf(DATA2), 2, 'caseCountOf string payload');
    eq(M.caseCountOf({ viperCases: [{}, {}, {}] }), 3, 'caseCountOf object payload');
    eq(M.caseCountOf('not json'), 0, 'caseCountOf bad json');
    eq(M.caseCountOf('{}'), 0, 'caseCountOf no cases key');
    eq([M.clampKeep(0), M.clampKeep(4), M.clampKeep(99), M.clampKeep('x')], [1, 4, 52, 4], 'clampKeep');
    ok(M.AUTO_RE.test('VIPER_AutoBackup_x.vbak') && !M.AUTO_RE.test('VIPER_Backup_x.vbak'), 'AUTO_RE only matches automatic');
    ok(M.ANY_RE.test('VIPER_Backup_x.vbak') && M.ANY_RE.test('viper_autobackup_x.VBAK') && !M.ANY_RE.test('VIPER_Backup_x.vbak.partial'), 'ANY_RE');

    const base = { enabled: true, folder: 'X:\\B', intervalDays: 7 };
    ok(!M.isDue({ ...base, enabled: false }, T0), 'not due when off');
    ok(!M.isDue({ ...base, folder: '' }, T0), 'not due without folder');
    ok(M.isDue(base, T0), 'due when never backed up');
    ok(!M.isDue({ ...base, lastAutoAt: new Date(T0 - 6 * DAY).toISOString() }, T0), 'not due after 6 days');
    ok(M.isDue({ ...base, lastAutoAt: new Date(T0 - 7 * DAY).toISOString() }, T0), 'due after 7 days');
    const failed = { ...base, lastAutoAt: new Date(T0 - 8 * DAY).toISOString(), lastAttemptAt: new Date(T0 - 2 * 3600e3).toISOString(), lastError: 'drive missing' };
    ok(!M.isDue(failed, T0), 'failed 2h ago → wait');
    ok(M.isDue(failed, T0 + 5 * 3600e3), 'failed 7h ago → retry');
    ok(M.isDue({ ...failed, lastError: null }, T0), 'attempt without error (crash mid-run) → retry now');
    eq(M.nextDueAt({ ...base, lastAutoAt: new Date(T0).toISOString() }), new Date(T0 + 7 * DAY).toISOString(), 'nextDueAt');
    eq(M.nextDueAt({ ...base }), null, 'nextDueAt null before first');
    eq(M.nextDueAt({ ...base, enabled: false, lastAutoAt: new Date(T0).toISOString() }), null, 'nextDueAt null when off');

    // ─────────────────────────────────────────────────────────────
    console.log('\n2. Config');
    {
        const s = setup();
        const st0 = s.ab.getState();
        eq([st0.enabled, st0.folder, st0.keep, st0.encrypt, st0.due], [false, '', 4, false, false], 'defaults');
        try { s.ab.setConfig({ enabled: true }); ok(false, 'enable without folder throws'); }
        catch (e) { ok(/backup folder/i.test(e.message), 'enable without folder throws'); }
        const st = s.ab.setConfig({ folder: s.dest, enabled: true, keep: 3, encrypt: false, bogus: 1 });
        eq([st.enabled, st.folder, st.keep, st.due, st.folderExists], [true, s.dest, 3, true, true], 'enabled + due');
        ok(!('bogus' in JSON.parse(fs.readFileSync(path.join(s.userData, 'auto-backup.json'), 'utf-8'))), 'unknown keys ignored');
        // A fresh instance (app restart) reads the same file.
        const again = M.createAutoBackup({ userDataDir: s.userData, getCasesDir: () => s.cases, now: () => s.clock.t });
        eq(again.getState().folder, s.dest, 'config survives restart');
        const off = s.ab.setConfig({ folder: '' });
        eq([off.enabled, off.folder], [false, ''], 'clearing the folder turns it off');
        // Corrupt config file → defaults, no throw.
        fs.writeFileSync(path.join(s.userData, 'auto-backup.json'), '{oops');
        eq(s.ab.getState().keep, 4, 'corrupt config → defaults');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n3. Weekly run — contents');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true });
        const r = await s.ab.runAuto({ data: DATA2 });
        ok(r.ok, 'runAuto ok', r);
        ok(/^VIPER_AutoBackup_2026-11-02T15-00-00-000Z\.vbak$/.test(path.basename(r.filePath || '')), 'auto file name', r.filePath);
        eq([r.cases, r.files, r.skipped, r.encrypted], [2, 3, 0, false], 'counts');
        eq(fs.readdirSync(s.dest).filter(n => /partial/.test(n)), [], 'no .partial left');
        const zip = new AdmZip(r.filePath);              // the restore reader
        const names = zip.getEntries().map(e => e.entryName).sort();
        eq(names, ['cases/26-000123/Evidence/Item 1/photo.synthetic.jpg', 'cases/26-000123/Evidence/Item 1/sealed.synthetic.txt', 'cases/26-000123/notes.synthetic.txt', 'viper_data.json'], 'entries');
        eq(zip.getEntry('viper_data.json').getData().toString(), DATA2, 'viper_data.json = renderer payload');
        eq(zip.getEntry('cases/26-000123/Evidence/Item 1/sealed.synthetic.txt').getData().toString(), 'SYNTHETIC sealed content', 'encrypted case file is stored decrypted');
        eq(zip.getEntry('cases/26-000123/Evidence/Item 1/photo.synthetic.jpg').getData().length, 5000, 'binary intact');
        eq(zip.getEntry('cases/26-000123/Evidence/Item 1/photo.synthetic.jpg').header.method, 0, 'jpg stored, not deflated');
        eq(zip.getEntry('cases/26-000123/notes.synthetic.txt').header.method, 8, 'txt deflated');
        const st = s.ab.getState();
        eq([st.lastAutoFile, st.lastBackupFile, st.lastError, st.lastCaseCount, st.due], [r.filePath, r.filePath, null, 2, false], 'state recorded');
        eq(st.nextDueAt, new Date(T0 + 7 * DAY).toISOString(), 'next due in a week');
        eq((await s.ab.runAuto({ data: DATA2 })).skipped, 'not-due', 'second run same day skipped');
        s.clock.t = T0 + 7 * DAY;
        ok(s.ab.getState().due, 'due again a week later');
        s.ab.setConfig({ enabled: false });
        eq((await s.ab.runAuto({ data: DATA2 })).skipped, 'off', 'off → skipped');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n4. One at a time');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true });
        const p1 = s.ab.runAuto({ data: DATA2 });
        const r2 = await s.ab.runAuto({ data: DATA2 });
        eq(r2.skipped, 'running', 'parallel call skipped');
        ok(s.ab.getState().running, 'state shows running');
        ok((await p1).ok, 'first finished');
        ok(!s.ab.getState().running, 'running cleared');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n5. Keeping N automatic backups');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true, keep: 3 });
        const manual = path.join(s.dest, 'VIPER_Backup_2026-01-01T00-00-00-000Z.vbak');
        fs.writeFileSync(manual, 'PK\u0003\u0004 synthetic manual');
        const other = path.join(s.dest, 'holiday-photos.zip');
        fs.writeFileSync(other, 'x');
        const files = [];
        for (let w = 0; w < 6; w++) {
            s.clock.t = T0 + w * 7 * DAY;
            const r = await s.ab.runAuto({ data: DATA2 });
            ok(r.ok, 'week ' + (w + 1) + ' ok', r);
            files.push(path.basename(r.filePath));
        }
        const autos = fs.readdirSync(s.dest).filter(n => M.AUTO_RE.test(n)).sort();
        eq(autos, files.slice(3).sort(), 'newest 3 automatic kept');
        ok(fs.existsSync(manual), 'manual backup never deleted');
        ok(fs.existsSync(other), 'unrelated file untouched');
        // Stale .partial from a crash: removed only when a day old.
        const stale = path.join(s.dest, 'VIPER_AutoBackup_2026-01-01T00-00-00-000Z.vbak.partial');
        fs.writeFileSync(stale, 'x');
        const fresh = path.join(s.dest, 'VIPER_AutoBackup_2026-12-31T00-00-00-000Z.vbak.partial');
        fs.writeFileSync(fresh, 'x');
        const old = (s.clock.t - 3 * DAY) / 1000;
        fs.utimesSync(stale, old, old);
        fs.utimesSync(fresh, s.clock.t / 1000, s.clock.t / 1000);
        await s.ab.prune(s.dest, 3);
        ok(!fs.existsSync(stale) && fs.existsSync(fresh), 'old .partial removed, recent one kept');
        const keepAll = await s.ab.prune(s.dest, 10);
        eq(keepAll, [], 'nothing removed when under the limit');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n6. Safety guards');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true, keep: 2 });
        ok((await s.ab.runAuto({ data: DATA2 })).ok, 'baseline');
        s.clock.t += 7 * DAY;
        const r = await s.ab.runAuto({ data: DATA0 });
        ok(!r.ok && /No cases were found/.test(r.error), 'empty profile after a real one → refused', r);
        eq(fs.readdirSync(s.dest).filter(n => M.AUTO_RE.test(n)).length, 1, 'good backup still there');
        ok(!s.ab.getState().due, 'waits before retrying');
        s.clock.t += 7 * 3600e3;
        ok(s.ab.getState().due, 'retries after 6 h');

        // Very first backup of an empty install is fine.
        const e = setup();
        e.ab.setConfig({ folder: e.dest, enabled: true });
        ok((await e.ab.runAuto({ data: DATA0 })).ok, 'first backup with 0 cases allowed');

        // Folder gone (USB drive unplugged).
        const g = setup();
        const usb = path.join(g.root, 'USB');
        fs.mkdirSync(usb);
        g.ab.setConfig({ folder: usb, enabled: true });
        fs.rmdirSync(usb);
        const rg = await g.ab.runAuto({ data: DATA2 });
        ok(!rg.ok && /can’t be reached/.test(rg.error), 'missing folder → error', rg);
        const sg = g.ab.getState();
        eq([sg.folderExists, sg.lastError === rg.error, sg.lastAutoAt], [false, true, null], 'error recorded');
        fs.mkdirSync(usb);
        g.ab.setConfig({ enabled: true });
        ok(g.ab.getState().due, 're-enabling clears the wait');
        ok((await g.ab.runAuto({ data: DATA2 })).ok, 'works once the drive is back');
        eq(g.ab.getState().lastError, null, 'error cleared on success');

        // Field Security locked.
        const l = setup();
        l.ab.setConfig({ folder: l.dest, enabled: true });
        l.sec.unlocked = false;
        const rl = await l.ab.runAuto({ data: DATA2 });
        ok(!rl.ok && /locked/i.test(rl.error), 'locked → error', rl);
        eq(fs.readdirSync(l.dest), [], 'nothing written while locked');

        // force bypasses "not due" (still needs enabled).
        const f = setup();
        f.ab.setConfig({ folder: f.dest, enabled: true });
        await f.ab.runAuto({ data: DATA2 });
        f.clock.t += 1000;
        ok((await f.ab.runAuto({ data: DATA2, force: true })).ok, 'force runs when not due');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n7. Encrypt option + no security');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true, encrypt: true });
        const r = await s.ab.runAuto({ data: DATA2 });
        ok(r.ok && r.encrypted, 'sealed', r);
        const raw = fs.readFileSync(r.filePath);
        ok(s.sec.isEncryptedBuffer(raw), 'outer VIPENC header');
        const zip = new AdmZip(s.sec.decryptBuffer(raw));
        eq(zip.getEntry('cases/26-000123/Evidence/Item 1/sealed.synthetic.txt').getData().toString(), 'SYNTHETIC sealed content', 'inner still plaintext');

        const n = setup({ security: null });
        n.ab.setConfig({ folder: n.dest, enabled: true, encrypt: true });
        const rn = await n.ab.runAuto({ data: DATA2 });
        ok(rn.ok && !rn.encrypted, 'no Field Security → plain ZIP even with encrypt on', rn);
        eq(new AdmZip(rn.filePath).getEntries().length, 3, 'plain zip readable');

        const d = setup({ security: makeSecurity({ enabled: false, unlocked: false }) });
        d.ab.setConfig({ folder: d.dest, enabled: true, encrypt: true });
        const rd = await d.ab.runAuto({ data: DATA2 });
        ok(rd.ok && !rd.encrypted, 'security disabled → plain', rd);
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n8. Finding the latest backup');
    {
        const s = setup();
        s.ab.setConfig({ folder: s.dest, enabled: true });
        const r1 = await s.ab.runAuto({ data: DATA2 });
        s.clock.t += 7 * DAY;
        const r2 = await s.ab.runAuto({ data: DATA2 });
        // A manual backup made later, in another folder.
        const elsewhere = path.join(s.root, 'Elsewhere');
        fs.mkdirSync(elsewhere);
        const manual = path.join(elsewhere, 'VIPER_Backup_2026-11-12T09-00-00-000Z.vbak');
        fs.copyFileSync(r1.filePath, manual);
        s.clock.t = Date.UTC(2026, 10, 12, 9, 0, 1);
        s.ab.record(manual, 'manual');
        // Junk named like a backup.
        fs.writeFileSync(path.join(s.dest, 'VIPER_Backup_2026-11-01T00-00-00-000Z.vbak'), 'not a zip');
        fs.writeFileSync(path.join(s.dest, 'VIPER_AutoBackup_2026-11-20T00-00-00-000Z.vbak.partial'), 'x');

        const L = await s.ab.listBackups([]);
        eq(L.backups.map(b => b.name), [
            'VIPER_Backup_2026-11-12T09-00-00-000Z.vbak',
            path.basename(r2.filePath),
            path.basename(r1.filePath),
            'VIPER_Backup_2026-11-01T00-00-00-000Z.vbak',
        ], 'newest first, across both folders, no .partial');
        eq(L.backups.map(b => [b.auto, b.valid]), [[false, true], [true, true], [true, true], [false, false]], 'auto / valid flags');
        ok(L.searched.length === 2, 'searched backup folder + last backup folder', L.searched);
        const st = s.ab.getState();
        eq([st.lastBackupFile, st.lastAutoFile], [manual, r2.filePath], 'manual record does not touch lastAutoFile');
        ok(!st.due, 'manual backup does not reset the weekly schedule early');

        // Extra folder from the Settings field; duplicates folded.
        const extra = path.join(s.root, 'Extra');
        fs.mkdirSync(extra);
        fs.copyFileSync(r2.filePath, path.join(extra, 'VIPER_AutoBackup_2026-12-01T00-00-00-000Z.vbak'));
        const L2 = await s.ab.listBackups([extra, s.dest, s.dest.toUpperCase()]);
        eq(L2.backups[0].name, 'VIPER_AutoBackup_2026-12-01T00-00-00-000Z.vbak', 'extra folder included');
        eq(L2.searched.length, 3, 'folders de-duplicated (case-insensitive)');

        // Encrypted backup flagged.
        const e = setup();
        e.ab.setConfig({ folder: e.dest, enabled: true, encrypt: true });
        await e.ab.runAuto({ data: DATA2 });
        const LE = await e.ab.listBackups();
        eq([LE.backups[0].encrypted, LE.backups[0].valid], [true, true], 'encrypted flag');

        // Nothing configured → empty list, no throw.
        const z = setup();
        eq((await z.ab.listBackups()).backups, [], 'empty when nothing known');
        // Last backup file deleted → just not listed.
        fs.unlinkSync(manual);
        ok(!(await s.ab.listBackups()).backups.some(b => b.path === manual), 'deleted file not listed');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n9. IPC wiring');
    {
        const s = setup();
        const h = {};
        s.ab.register({ handle: (ch, fn) => { h[ch] = fn; } });
        eq(Object.keys(h).sort(), ['auto-backup-get', 'auto-backup-run', 'auto-backup-set', 'backup-list'], 'channels');
        const st = await h['auto-backup-set']({}, { folder: s.dest, enabled: true });
        ok(st.enabled, 'set via IPC');
        ok((await h['auto-backup-run']({}, { data: DATA2 })).ok, 'run via IPC');
        eq((await h['backup-list']({}, { folders: [] })).backups.length, 1, 'list via IPC');
        eq((await h['auto-backup-get']()).due, false, 'get via IPC');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n10. Renderer helpers');
    {
        const store = { _k: ['viperCases', 'suspects_1', 'otherApp', 'viperSettings', 'connectionBoard_1'], _v: { viperCases: '[1]', suspects_1: '[]', otherApp: 'x', viperSettings: '{}', connectionBoard_1: '{}' } };
        const ls = { get length() { return store._k.length; }, key: i => store._k[i], getItem: k => store._v[k] };
        eq(UI.collect(ls, ['suspects_', 'connectionBoard_']), { viperCases: '[1]', suspects_1: '[]', viperSettings: '{}', connectionBoard_1: '{}' }, 'collect = viper* + per-case stores');
        eq(UI.collect(ls, null), { viperCases: '[1]', viperSettings: '{}' }, 'collect without registry');
        const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
        eq([UI.relDays(new Date(2026, 10, 6, 1).toISOString(), now), UI.relDays(new Date(2026, 10, 5, 23).toISOString(), now), UI.relDays(new Date(2026, 10, 1).toISOString(), now), UI.relDays(new Date(2026, 10, 13).toISOString(), now)],
            ['today', 'yesterday', '5 days ago', 'in 7 days'], 'relDays');
        eq([UI.fmtSize(500), UI.fmtSize(2048), UI.fmtSize(5 * 1024 * 1024), UI.fmtSize(3.4 * 1024 ** 3)], ['500 B', '2.0 KB', '5.0 MB', '3.4 GB'], 'fmtSize');
        eq(UI.esc('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;', 'esc');
        eq(UI.statusText({ enabled: false }, now), 'Automatic backup is off.', 'status off');
        ok(/first one runs/.test(UI.statusText({ enabled: true }, now)), 'status before first');
        const s1 = UI.statusText({ enabled: true, lastAutoAt: new Date(2026, 10, 2, 9).toISOString(), nextDueAt: new Date(2026, 10, 9, 9).toISOString() }, now);
        ok(/Last automatic backup: .*\(4 days ago\) · Next: .*\(in 3 days\)/.test(s1), 'status with last + next', s1);
        ok(/Next: due now/.test(UI.statusText({ enabled: true, lastAutoAt: new Date(2026, 9, 1).toISOString(), nextDueAt: new Date(2026, 9, 8).toISOString() }, now)), 'status overdue');
        ok(/Backing up now/.test(UI.statusText({ enabled: true, running: true }, now)), 'status running');
    }

    const sha = f => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const autosIn = d => fs.readdirSync(d).filter(n => M.AUTO_RE.test(n)).sort();

    // ─────────────────────────────────────────────────────────────
    console.log('\n11. Secondary location — config');
    {
        const s = setup();
        const sec2 = path.join(s.root, 'OneDrive', 'VIPER Backups');
        fs.mkdirSync(sec2, { recursive: true });
        eq([s.ab.getState().secondaryEnabled, s.ab.getState().secondaryFolder], [false, ''], 'off by default');
        try { s.ab.setConfig({ secondaryEnabled: true }); ok(false, 'enable without folder throws'); }
        catch (e) { ok(/secondary backup folder first/i.test(e.message), 'enable without folder throws', e.message); }
        s.ab.setConfig({ folder: s.dest });
        for (const same of [s.dest, s.dest + path.sep, s.dest.toUpperCase()]) {
            try { s.ab.setConfig({ secondaryFolder: same, secondaryEnabled: true }); ok(false, 'same folder refused: ' + same); }
            catch (e) { ok(/must be different/i.test(e.message), 'same folder refused: ' + path.basename(same) + (same.endsWith(path.sep) ? ' (trailing slash)' : ''), e.message); }
        }
        eq(s.ab.getState().secondaryEnabled, false, 'refused change not saved');
        const st = s.ab.setConfig({ secondaryFolder: sec2, secondaryEnabled: true });
        eq([st.secondaryEnabled, st.secondaryFolder, st.secondaryFolderExists], [true, sec2, true], 'secondary on');
        try { s.ab.setConfig({ folder: sec2 }); ok(false, 'primary moved onto secondary refused'); }
        catch (e) { ok(/must be different/i.test(e.message), 'primary moved onto secondary refused'); }
        eq(s.ab.getState().folder, s.dest, 'primary unchanged');
        s.ab.setConfig({ secondaryEnabled: false });
        eq([s.ab.getState().secondaryEnabled, s.ab.getState().secondaryFolder], [false, sec2], 'off keeps the folder for next time');
        s.ab.setConfig({ secondaryEnabled: true });
        ok(s.ab.getState().secondaryEnabled, 're-enable with remembered folder');
        s.ab.setConfig({ secondaryFolder: '' });
        eq(s.ab.getState().secondaryEnabled, false, 'clearing the folder turns it off');
        ok(M.isDue({ enabled: true, folder: '', secondaryEnabled: true, secondaryFolder: 'Y:\\S' }, T0), 'due with only a secondary folder');
        ok(!M.isDue({ enabled: true, folder: '', secondaryEnabled: false, secondaryFolder: 'Y:\\S' }, T0), 'not due with a disabled secondary only');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n12. Secondary location — every backup in both places');
    {
        const s = setup();
        const sec2 = path.join(s.root, 'Second');
        fs.mkdirSync(sec2);
        s.ab.setConfig({ folder: s.dest, enabled: true, keep: 2, secondaryFolder: sec2, secondaryEnabled: true });
        const r = await s.ab.runAuto({ data: DATA2 });
        ok(r.ok && !r.primaryError && !r.warning, 'weekly ok', r);
        ok(r.secondary && r.secondary.filePath && !r.secondary.error, 'secondary copy reported', r.secondary);
        eq(path.dirname(r.filePath), s.dest, 'primary file in Backup Destination');
        eq([path.dirname(r.secondary.filePath), path.basename(r.secondary.filePath)], [sec2, path.basename(r.filePath)], 'same name in the secondary folder');
        eq(sha(r.secondary.filePath), sha(r.filePath), 'identical bytes');
        eq(new AdmZip(r.secondary.filePath).getEntry('viper_data.json').getData().toString(), DATA2, 'secondary copy restorable');
        eq([fs.readdirSync(s.dest).filter(n => /partial/.test(n)), fs.readdirSync(sec2).filter(n => /partial/.test(n))], [[], []], 'no .partial left');
        let st = s.ab.getState();
        eq([st.lastBackupFile, st.lastAutoFile, st.lastSecondaryFile, st.lastSecondaryError, st.lastError], [r.filePath, r.filePath, r.secondary.filePath, null, null], 'state');
        ok(!!st.lastSecondaryAt, 'lastSecondaryAt set');

        // Manual backup also goes to both, under the manual name.
        s.clock.t += 3600e3;
        const m = await s.ab.backupNow({ folder: s.dest, data: DATA2, kind: 'manual' });
        ok(/^VIPER_Backup_/.test(path.basename(m.filePath)) && m.secondary && fs.existsSync(m.secondary.filePath), 'manual → both', m);
        st = s.ab.getState();
        eq([st.lastBackupFile, st.lastAutoFile], [m.filePath, r.filePath], 'manual does not touch lastAutoFile');

        // Rotation applies in both folders; manual backups stay.
        for (let w = 1; w <= 3; w++) {
            s.clock.t = T0 + w * 7 * DAY;
            ok((await s.ab.runAuto({ data: DATA2 })).ok, 'week ' + (w + 1));
        }
        eq(autosIn(s.dest), autosIn(sec2), 'same automatic backups in both folders');
        eq(autosIn(sec2).length, 2, 'secondary pruned to keep');
        ok(fs.existsSync(m.filePath) && fs.existsSync(m.secondary.filePath), 'manual backups kept in both');

        // Restore list sees both folders.
        const L = await s.ab.listBackups([]);
        ok(L.searched.some(f => f.toLowerCase() === sec2.toLowerCase()), 'secondary folder searched', L.searched);
        eq(L.backups.filter(b => path.dirname(b.path) === sec2).length, 3, 'secondary copies listed');

        // A secondary folder the same as the destination of a one-off manual backup isn't copied onto itself.
        const self = await s.ab.backupNow({ folder: sec2, data: DATA2, kind: 'manual' });
        eq(self.secondary, null, 'manual backup made INTO the secondary folder → no self-copy');

        // copyToSecondary on its own.
        const other = path.join(s.root, 'Other');
        fs.mkdirSync(other);
        const c = await s.ab.copyToSecondary(m.filePath, other);
        ok(fs.existsSync(c.filePath) && c.sha256 === sha(m.filePath), 'copyToSecondary copies + returns the checksum');
        await throwsAsync(() => s.ab.copyToSecondary(m.filePath, path.join(s.root, 'Nope')), /can’t be reached/, 'copyToSecondary to a missing folder throws');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n13. Secondary location — one place unreachable');
    {
        // Primary unplugged → still backed up to the secondary.
        const a = setup();
        const usb = path.join(a.root, 'USB'); fs.mkdirSync(usb);
        const sec2 = path.join(a.root, 'Second'); fs.mkdirSync(sec2);
        a.ab.setConfig({ folder: usb, enabled: true, secondaryFolder: sec2, secondaryEnabled: true });
        fs.rmdirSync(usb);
        const ra = await a.ab.runAuto({ data: DATA2 });
        ok(ra.ok, 'primary missing → still ok', ra);
        eq(path.dirname(ra.filePath || ''), sec2, 'written straight into the secondary folder');
        ok(/can’t be reached/.test(ra.primaryError || '') && /can’t be reached/.test(ra.warning || ''), 'primary failure reported', ra);
        let st = a.ab.getState();
        eq([st.lastAutoFile, st.lastSecondaryFile, st.lastError === ra.warning, st.due], [ra.filePath, ra.filePath, true, false], 'state: backed up, warning kept, not due');
        eq(autosIn(sec2).length, 1, 'one file in secondary');

        // Secondary unplugged → primary only, warning.
        const b = setup();
        const usb2 = path.join(b.root, 'USB2'); fs.mkdirSync(usb2);
        b.ab.setConfig({ folder: b.dest, enabled: true, secondaryFolder: usb2, secondaryEnabled: true });
        fs.rmdirSync(usb2);
        eq(b.ab.getState().secondaryFolderExists, false, 'state shows secondary missing');
        const rb = await b.ab.runAuto({ data: DATA2 });
        ok(rb.ok && path.dirname(rb.filePath) === b.dest, 'secondary missing → primary ok', rb);
        ok(rb.secondary && /secondary backup folder can’t be reached/.test(rb.secondary.error || ''), 'secondary error reported', rb.secondary);
        st = b.ab.getState();
        ok(/secondary/.test(st.lastSecondaryError || '') && st.lastSecondaryFile === null, 'lastSecondaryError recorded', st);
        // Back again → error cleared on next success.
        fs.mkdirSync(usb2);
        b.clock.t += 7 * DAY;
        const rb2 = await b.ab.runAuto({ data: DATA2 });
        ok(rb2.ok && !rb2.warning && fs.existsSync(rb2.secondary.filePath), 'drive back → copied', rb2);
        eq([b.ab.getState().lastSecondaryError, b.ab.getState().lastError], [null, null], 'errors cleared');

        // Both gone → failure, retry later.
        const c = setup();
        const u1 = path.join(c.root, 'U1'); const u2 = path.join(c.root, 'U2');
        fs.mkdirSync(u1); fs.mkdirSync(u2);
        c.ab.setConfig({ folder: u1, enabled: true, secondaryFolder: u2, secondaryEnabled: true });
        fs.rmdirSync(u1); fs.rmdirSync(u2);
        const rc = await c.ab.runAuto({ data: DATA2 });
        ok(!rc.ok && /U1/.test(rc.error) && /U2/.test(rc.error), 'both missing → error naming both', rc);
        await throwsAsync(() => c.ab.backupNow({ folder: u1, data: DATA2, kind: 'manual' }), /can’t be reached/, 'manual with both missing throws');

        // Locked: nothing anywhere.
        const l = setup();
        const s2 = path.join(l.root, 'Second'); fs.mkdirSync(s2);
        l.ab.setConfig({ folder: l.dest, enabled: true, secondaryFolder: s2, secondaryEnabled: true });
        l.sec.unlocked = false;
        const rl = await l.ab.runAuto({ data: DATA2 });
        ok(!rl.ok && /locked/i.test(rl.error), 'locked → error', rl);
        eq([fs.readdirSync(l.dest), fs.readdirSync(s2)], [[], []], 'nothing written in either folder');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n14. Case data kept in userData');
    function seedUserData(ud) {
        const w = (rel, body) => { const f = path.join(ud, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
        w('snapchat-warrant-store/snapchat_1.json', '{"SYNTHETIC":"snap"}');
        w('datapilot-store/datapilot_1.json', '{"SYNTHETIC":"dp"}');
        w('datapilot-store/datapilot_2.json.tmp', 'half written');
        w('uc_photos/3/face.synthetic.jpg', Buffer.alloc(300, 9));
        w('uc_avatars/p1.synthetic.png', Buffer.alloc(50, 3));
        w('warrant-author/library.json', '{"SYNTHETIC":"lib"}');
        w('branding/badge.png', Buffer.alloc(80, 1));
        w('audit.log', '{"seq":1,"SYNTHETIC":true}\n');
        w('audit.log.1', '{"seq":0}\n');
        w('audit.logger.txt', 'not an audit file');
        w('security.json', '{"SYNTHETIC":"never backed up"}');
        w('viper-uc.db', 'RAW-DB');
        w('viper-uc.db-wal', 'RAW-WAL');
        w('models/big.bin', 'not backed up');
    }
    const UD_ENTRIES = [
        'userdata/audit/audit.log', 'userdata/audit/audit.log.1',
        'userdata/branding/badge.png',
        'userdata/datapilot-store/datapilot_1.json',
        'userdata/snapchat-warrant-store/snapchat_1.json',
        'userdata/uc_avatars/p1.synthetic.png',
        'userdata/uc_photos/3/face.synthetic.jpg',
        'userdata/viper-uc.db',
        'userdata/warrant-author/library.json',
    ];
    let udBackup = null;
    {
        const snaps = [];
        const s = setup({ sqlite: { 'viper-uc.db': { snapshot: async (dest) => { snaps.push(dest); fs.writeFileSync(dest, 'SNAPSHOT-DB'); return true; } } } });
        seedUserData(s.userData);
        s.ab.setConfig({ folder: s.dest, enabled: true });
        const r = await s.ab.runAuto({ data: DATA2 });
        ok(r.ok, 'backup ok', r);
        const zip = new AdmZip(r.filePath);
        const ud = zip.getEntries().map(e => e.entryName).filter(n => n.startsWith('userdata/')).sort();
        eq(ud, UD_ENTRIES, 'userdata entries (no .tmp, security.json, models, look-alike files)');
        eq([r.userFiles, r.userSkipped], [UD_ENTRIES.length, 0], 'userdata counts');
        eq(zip.getEntry('userdata/viper-uc.db').getData().toString(), 'SNAPSHOT-DB', 'database from the consistent snapshot');
        ok(!zip.getEntry('userdata/viper-uc.db-wal'), 'no raw WAL when a snapshot is used');
        eq(zip.getEntry('userdata/datapilot-store/datapilot_1.json').getData().toString(), '{"SYNTHETIC":"dp"}', 'DataPilot store intact');
        ok(snaps.length === 1 && !fs.existsSync(snaps[0]), 'snapshot temp file removed');
        eq(fs.readdirSync(s.userData).filter(n => /backup-tmp/.test(n)), [], 'no temp files left in userData');
        eq(zip.getEntry('cases/26-000123/notes.synthetic.txt').getData().toString(), 'SYNTHETIC note text', 'cases still there');
        udBackup = { file: r.filePath, s };

        // Without a snapshot function: raw file + WAL.
        const n = setup();
        seedUserData(n.userData);
        n.ab.setConfig({ folder: n.dest, enabled: true });
        const rn = await n.ab.runAuto({ data: DATA2 });
        const zn = new AdmZip(rn.filePath);
        eq([zn.getEntry('userdata/viper-uc.db').getData().toString(), zn.getEntry('userdata/viper-uc.db-wal').getData().toString()], ['RAW-DB', 'RAW-WAL'], 'raw db + WAL fallback');

        // Snapshot says "no database" → left out; snapshot throws → skipped, backup still made.
        const f = setup({ sqlite: { 'viper-uc.db': { snapshot: async () => false } } });
        seedUserData(f.userData);
        f.ab.setConfig({ folder: f.dest, enabled: true });
        const rf = await f.ab.runAuto({ data: DATA2 });
        ok(rf.ok && !new AdmZip(rf.filePath).getEntry('userdata/viper-uc.db'), 'snapshot false → not included');
        const t = setup({ sqlite: { 'viper-uc.db': { snapshot: async () => { throw new Error('SQLITE_BUSY'); } } } });
        seedUserData(t.userData);
        t.ab.setConfig({ folder: t.dest, enabled: true });
        const rt = await t.ab.runAuto({ data: DATA2 });
        ok(rt.ok && rt.userSkipped === 1 && !new AdmZip(rt.filePath).getEntry('userdata/viper-uc.db'), 'snapshot error → skipped, backup still made', rt);
        eq(fs.readdirSync(t.userData).filter(n => /backup-tmp/.test(n)), [], 'temp removed after a snapshot error');

        // No database at all → nothing, no error.
        const e = setup({ sqlite: { 'viper-uc.db': { snapshot: async () => { throw new Error('should not be called'); } } } });
        e.ab.setConfig({ folder: e.dest, enabled: true });
        const re = await e.ab.runAuto({ data: DATA2 });
        eq([re.ok, re.userFiles, re.userSkipped], [true, 0, 0], 'empty userData → nothing extra');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n15. Restore');
    {
        // Onto a fresh install (new userData, empty cases), Field Security on.
        let closed = 0;
        const d = setup({ sqlite: { 'viper-uc.db': { close: () => { closed++; } } } });
        fs.rmSync(path.join(d.cases, '26-000123'), { recursive: true, force: true });
        fs.writeFileSync(path.join(d.userData, 'audit.log'), '{"seq":99,"LIVE":true}\n');
        fs.writeFileSync(path.join(d.userData, 'viper-uc.db'), 'OLD-DB');
        fs.writeFileSync(path.join(d.userData, 'viper-uc.db-wal'), 'STALE-WAL');
        fs.writeFileSync(path.join(d.userData, 'viper-uc.db-shm'), 'STALE-SHM');
        const res = await d.ab.restoreBackup(udBackup.file);
        eq(res.jsonData, DATA2, 'jsonData returned');
        eq([res.filesRestored, res.filesReEncrypted, res.filesPlaintext, res.outerEncrypted, res.blocked], [3, 3, 0, false, 0], 'case file counts');
        const note = fs.readFileSync(path.join(d.cases, '26-000123', 'notes.synthetic.txt'));
        ok(d.sec.isEncryptedBuffer(note) && d.sec.decryptBuffer(note).toString() === 'SYNTHETIC note text', 'case file re-encrypted under Field Security');
        eq(fs.readFileSync(path.join(d.userData, 'datapilot-store', 'datapilot_1.json'), 'utf8'), '{"SYNTHETIC":"dp"}', 'DataPilot store restored (raw)');
        eq(fs.readFileSync(path.join(d.userData, 'snapchat-warrant-store', 'snapchat_1.json'), 'utf8'), '{"SYNTHETIC":"snap"}', 'Snapchat store restored');
        eq(fs.readFileSync(path.join(d.userData, 'uc_photos', '3', 'face.synthetic.jpg')).length, 300, 'UC photo restored');
        eq(fs.readFileSync(path.join(d.userData, 'warrant-author', 'library.json'), 'utf8'), '{"SYNTHETIC":"lib"}', 'Warrant Author library restored');
        eq(fs.readFileSync(path.join(d.userData, 'viper-uc.db'), 'utf8'), 'SNAPSHOT-DB', 'database replaced');
        ok(!fs.existsSync(path.join(d.userData, 'viper-uc.db-wal')) && !fs.existsSync(path.join(d.userData, 'viper-uc.db-shm')), 'stale WAL/SHM removed');
        eq(closed, 1, 'live database closed first');
        eq(fs.readFileSync(path.join(d.userData, 'audit.log'), 'utf8'), '{"seq":99,"LIVE":true}\n', 'live audit log untouched');
        ok(res.auditRestoredTo && res.auditRestoredTo.startsWith(path.join(d.userData, 'restored-audit')), 'audit to side folder', res.auditRestoredTo);
        eq(fs.readdirSync(res.auditRestoredTo).sort(), ['audit.log', 'audit.log.1'], 'both audit files in side folder');
        eq(res.userDataRestored, UD_ENTRIES.length, 'userDataRestored count');
        eq(fs.readdirSync(d.userData).filter(n => /restore-tmp/.test(n)), [], 'no restore temp files');

        // The side folder is carried by later backups.
        d.ab.setConfig({ folder: d.dest, enabled: true });
        const again = await d.ab.runAuto({ data: DATA2 });
        ok(new AdmZip(again.filePath).getEntries().some(e => /^userdata\/restored-audit\/.+\/audit\.log$/.test(e.entryName)), 'restored audit kept in the next backup');

        // Encrypted outer file.
        const e = setup();
        e.ab.setConfig({ folder: e.dest, enabled: true, encrypt: true });
        const re = await e.ab.runAuto({ data: DATA2 });
        const er = await e.ab.restoreBackup(re.filePath);
        ok(er.outerEncrypted && er.jsonData === DATA2, 'sealed backup restores when unlocked');
        e.sec.unlocked = false;
        await throwsAsync(() => e.ab.restoreBackup(re.filePath), /encrypted \(sealed/, 'sealed backup while locked → clear error');

        // Plain restore with no Field Security keeps files plain.
        const p = setup({ security: null });
        const rp = await p.ab.restoreBackup(udBackup.file);
        eq([rp.filesReEncrypted, rp.filesPlaintext], [0, 3], 'no security → plaintext restore');

        // Not a VIPER backup.
        const bad = path.join(d.root, 'not-viper.vbak');
        const bz = new AdmZip(); bz.addFile('readme.txt', Buffer.from('x')); bz.writeZip(bad);
        await throwsAsync(() => d.ab.restoreBackup(bad), /missing viper_data\.json/, 'missing viper_data.json → error');

        // Hostile entry names never leave their folder.
        const h = setup();
        const hz = new AdmZip();
        hz.addFile('viper_data.json', Buffer.from(DATA0));
        hz.addFile('cases/26-1/ok.synthetic.txt', Buffer.from('fine'));
        const evil = ['cases/../escape1.txt', 'userdata/../escape2.txt', 'userdata/datapilot-store/../../escape3.txt',
            'userdata/unknown-store/x.txt', 'userdata/audit/../../escape4.txt', 'userdata/audit/notes.txt', 'userdata/viper-uc.db/x'];
        // adm-zip tidies "../" on add, so write "QQ" and patch the bytes to
        // ".." afterwards (same length; CRCs cover data, not names).
        for (const n of evil) hz.addFile(n.replace(/\.\./g, 'QQ'), Buffer.from('EVIL'));
        const hostile = path.join(h.root, 'hostile.vbak');
        fs.writeFileSync(hostile, Buffer.from(hz.toBuffer().toString('latin1').replace(/QQ/g, '..'), 'latin1'));
        const names = new AdmZip(hostile).getEntries().map(x => x.entryName);
        ok(evil.every(n => names.includes(n)), 'hostile names kept as written', names);
        const rh = await h.ab.restoreBackup(hostile);
        const leaked = ['escape1.txt', 'escape2.txt', 'escape3.txt', 'escape4.txt'].filter(n =>
            fs.existsSync(path.join(h.root, n)) || fs.existsSync(path.join(h.userData, n)) || fs.existsSync(path.join(h.cases, n)) || fs.existsSync(path.join(path.dirname(h.root), n)));
        eq(leaked, [], 'no file written outside its folder');
        ok(!fs.existsSync(path.join(h.userData, 'unknown-store')), 'unknown userdata folder not created');
        eq(fs.readFileSync(path.join(h.cases, '26-1', 'ok.synthetic.txt'), 'utf8').length > 0, true, 'normal entry restored');
        eq(rh.blocked, evil.length, 'every hostile entry blocked');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('\n16. Renderer — extra keys + secondary status');
    {
        const store = { _k: ['viperCases', 'pendingRmsImport_7', 'traceSearchAuditLog', 'genlogsActivityLog', 'otherApp'],
            _v: { viperCases: '[1]', pendingRmsImport_7: '{}', traceSearchAuditLog: '[]', genlogsActivityLog: '[]', otherApp: 'x' } };
        const ls = { get length() { return store._k.length; }, key: i => store._k[i], getItem: k => store._v[k] };
        eq(Object.keys(UI.collect(ls, [])).sort(), ['genlogsActivityLog', 'pendingRmsImport_7', 'traceSearchAuditLog', 'viperCases'], 'pending RMS import + tool logs included');
        const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
        eq(UI.secondaryText({ secondaryEnabled: false, secondaryFolder: 'X' }, now), '', 'off → empty');
        ok(/No copy yet/.test(UI.secondaryText({ secondaryEnabled: true, secondaryFolder: 'X', secondaryFolderExists: true }, now)), 'before first copy');
        ok(/Last copy: .*\(yesterday\)/.test(UI.secondaryText({ secondaryEnabled: true, secondaryFolder: 'X', secondaryFolderExists: true, lastSecondaryAt: new Date(2026, 10, 5, 9).toISOString() }, now)), 'last copy');
        ok(/^Last copy failed: nope/.test(UI.secondaryText({ secondaryEnabled: true, secondaryFolder: 'X', lastSecondaryError: 'nope' }, now)), 'failure shown');
        ok(/not reachable/.test(UI.secondaryText({ secondaryEnabled: true, secondaryFolder: 'X', secondaryFolderExists: false }, now)), 'unreachable shown');
    }

    console.log('\nauto-backup: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
