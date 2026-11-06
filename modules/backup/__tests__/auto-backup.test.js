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

    console.log('\nauto-backup: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
