/**
 * Tests for modules/_shared/crash-log.js (Settings → Crash Log).
 * Run: node modules/_shared/__tests__/crash-log.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const CL = require('../crash-log.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL ' + msg); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-crashlog-'));
const HOME = 'C:\\Users\\Officer Smith';
let clock = Date.parse('2026-10-21T10:00:00Z');
const now = () => new Date(clock += 1000);
const memory = () => ({ rss: 300 * 1048576, heapUsed: 120 * 1048576 });
function mk(dir, extra) {
    return CL.createCrashLog(Object.assign({ fs, logDir: dir, version: '5.4.8', homeDir: HOME, now, memory, pid: 4242 }, extra || {}));
}
const read = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return ''; } };

try {
    // ── 1. clean start / exit ──
    {
        const dir = path.join(root, 'a', 'logs');
        const log = mk(dir).start();
        ok(fs.existsSync(dir), 'log folder created');
        ok(fs.existsSync(log.sessionPath), 'session file written on start');
        const sess = JSON.parse(read(log.sessionPath));
        ok(sess.pid === 4242 && sess.version === '5.4.8' && sess.lastMark === null, 'session has pid/version');
        ok(/\[START\] VIPER 5\.4\.8 pid=4242 portable=false rss=300MB heap=120MB/.test(read(log.logPath)), 'START line with memory');
        ok(log.start() === log && (read(log.logPath).match(/\[START\]/g) || []).length === 1, 'start() is idempotent');
        ok(log.info().previousUnclean === false, 'first start is not unclean');
        log.endSession('quit');
        log.endSession('again');
        ok(!fs.existsSync(log.sessionPath), 'endSession removes the session file');
        ok((read(log.logPath).match(/\[EXIT\]/g) || []).length === 1, 'EXIT written once');
        const log2 = mk(dir).start();
        ok(log2.info().previousUnclean === false && !/UNCLEAN/.test(read(log2.logPath)), 'clean exit → next start is clean');
        log2.endSession();
    }

    // ── 2. unclean exit detection + last mark ──
    {
        const dir = path.join(root, 'b');
        const log = mk(dir).start();
        log.mark('google-warrant:category', { category: 'Mail.MessageContent', sizeMB: 18000, source: HOME + '\\Desktop\\ret.zip' });
        const sess = JSON.parse(read(log.sessionPath));
        ok(sess.lastMark && sess.lastMark.label === 'google-warrant:category', 'mark updates session.lastMark');
        ok(typeof sess.lastMark.detail === 'string' && sess.lastMark.detail.includes('%USERPROFILE%') && !sess.lastMark.detail.includes('Officer Smith'), 'mark detail redacted (JSON-escaped home path)');
        ok(sess.lastMark.mem === 'rss=300MB heap=120MB', 'mark records memory');
        ok(/\[MARK\] google-warrant:category .*Mail\.MessageContent/.test(read(log.logPath)), 'MARK line in log');
        // simulate a crash: no endSession
        const next = mk(dir).start();
        const info = next.info();
        ok(info.previousUnclean === true, 'leftover session → previousUnclean');
        ok(info.previous.version === '5.4.8' && info.previous.lastMark.label === 'google-warrant:category', 'previous session details exposed');
        ok(/\[UNCLEAN-EXIT\].*pid 4242.*Last activity: google-warrant:category .*Mail\.MessageContent/.test(read(next.logPath)), 'UNCLEAN-EXIT line names last activity');
        ok(info.tail.includes('UNCLEAN-EXIT') && info.size > 0, 'info tail/size');
        ok(JSON.parse(read(next.sessionPath)).lastMark === null, 'new session starts fresh');
        next.endSession();
        // corrupt session file
        fs.writeFileSync(next.sessionPath, '{not json');
        const third = mk(dir).start();
        ok(third.info().previousUnclean === true && /Last activity: none recorded/.test(read(third.logPath)), 'corrupt session still reported');
        third.endSession();
    }

    // ── 3. redaction ──
    {
        const r = CL.makeRedactor(HOME);
        ok(r('C:\\Users\\Officer Smith\\cases\\x') === '%USERPROFILE%\\cases\\x', 'raw home path');
        ok(r('c:/users/officer smith/a') === '%USERPROFILE%/a', 'forward-slash, case-insensitive');
        ok(r('"C:\\\\Users\\\\Officer Smith\\\\a"') === '"%USERPROFILE%\\\\a"', 'JSON-escaped home path');
        ok(r('mail jane.doe+x@police.nv.gov now') === 'mail <email> now', 'email redacted');
        ok(r(null) === '' && CL.makeRedactor('')('abc') === 'abc', 'null/empty safe');
        const dir = path.join(root, 'c');
        const log = mk(dir).start();
        log.error('import failed', new Error('ENOENT: ' + HOME + '\\Desktop\\a@b.com.zip'));
        const t = read(log.logPath);
        ok(/\[ERROR\] import failed: Error: ENOENT: %USERPROFILE%\\Desktop\\<email>/.test(t), 'error line redacted');
        ok(!t.includes('Officer Smith'), 'no home path anywhere in the log');
        ok(/\n {4,}at /.test(t) && !/\n\S+ \[\w+\] *at /.test(t) && !/\n {12,}at /.test(t), 'stack lines indented (one record)');
        log.error('weird', { code: 7 });
        log.error('nothing', undefined);
        ok(/weird: \{"code":7\}/.test(read(log.logPath)) && /nothing: undefined/.test(read(log.logPath)), 'non-Error values logged');
        log.endSession();
    }

    // ── 4. rotation, export, clear ──
    {
        const dir = path.join(root, 'd');
        const log = mk(dir, { maxBytes: 2000 }).start();
        for (let i = 0; i < 60; i++) log.write('INFO', 'line ' + i + ' ' + 'x'.repeat(50));
        const oldP = path.join(dir, CL.OLD_LOG_NAME);
        ok(fs.existsSync(oldP), 'log rotated to .1');
        ok(fs.statSync(log.logPath).size < 2100, 'current log below the limit');
        ok(!fs.existsSync(path.join(dir, 'viper-crash.2.log')), 'only one old log kept');
        const ex = log.exportText();
        ok(ex.indexOf('line 59') > ex.lastIndexOf('line 30') || ex.includes('line 59'), 'export contains newest lines');
        ok(ex.length >= fs.statSync(log.logPath).size + fs.statSync(oldP).size - 1, 'export = old + current');
        const tl = log.tail(200);
        ok(tl.length <= 200 && /line 59/.test(tl) && !tl.startsWith('x'), 'tail is newest, starts on a line boundary');
        log.clear();
        ok(!fs.existsSync(oldP), 'clear removes old log');
        ok(/^\S+ \[INFO\] Log cleared by user\n$/.test(read(log.logPath)), 'clear leaves one line');
        ok(log.info().previousUnclean === false, 'clear resets the unclean flag');
        log.endSession();
    }

    // ── 5. never throws ──
    {
        const badFs = new Proxy({}, { get: () => () => { throw new Error('disk gone'); } });
        let threw = false;
        try {
            const log = CL.createCrashLog({ fs: badFs, logDir: 'Z:\\nope', version: 'x', now, memory }).start();
            log.mark('a', { b: 1 }); log.error('e', new Error('x')); log.crash('c', {}); log.write('INFO', 'x');
            log.info(); log.tail(); log.exportText(); log.clear(); log.endSession();
        } catch (e) { threw = e; }
        ok(!threw, 'logging never throws when the disk fails');
        const circ = {}; circ.self = circ;
        const log = mk(path.join(root, 'e')).start();
        log.mark('circular', circ); log.crash('circular', circ);
        ok(/\[MARK\] circular/.test(read(log.logPath)) && /\[CRASH\] circular/.test(read(log.logPath)), 'circular details tolerated');
        log.endSession();
    }

    // ── 6. install() wires events ──
    {
        const dir = path.join(root, 'f');
        const log = mk(dir).start();
        const proc = new EventEmitter();
        const app = new EventEmitter();
        let crOpts = null;
        const origErr = console.error; console.error = () => {};
        try {
            CL.install(log, { app, proc, crashReporter: { start: (o) => { crOpts = o; } } });
            ok(crOpts && crOpts.uploadToServer === false, 'crashReporter started with upload off');
            proc.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
            proc.emit('unhandledRejection', new Error('rej'));
            app.emit('render-process-gone', {}, { getURL: () => 'file:///' + HOME.replace(/\\/g, '/') + '/app/case-detail.html?case=1#x' }, { reason: 'oom', exitCode: -536870904 });
            app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 3 });
        } finally { console.error = origErr; }
        let t = read(log.logPath);
        ok(/\[ERROR\] uncaught exception \(uncaughtException\): Error: boom/.test(t), 'uncaught exception logged');
        ok(/\[ERROR\] unhandled promise rejection: Error: rej/.test(t), 'unhandled rejection logged');
        ok(/\[CRASH\] window process gone \{"reason":"oom","exitCode":-536870904,"page":"case-detail\.html"\}/.test(t), 'render-process-gone logs page basename only');
        ok(/\[CRASH\] helper process gone .*"type":"GPU".*"reason":"crashed"/.test(t), 'child-process-gone logged');
        ok(fs.existsSync(log.sessionPath), 'crash events do not end the session');
        app.emit('will-quit');
        proc.emit('exit', 0);
        t = read(log.logPath);
        ok(!fs.existsSync(log.sessionPath) && (t.match(/\[EXIT\]/g) || []).length === 1 && /clean exit \(quit\)/.test(t), 'will-quit ends session once');
        const log2 = mk(path.join(root, 'g')).start();
        const proc2 = new EventEmitter();
        CL.install(log2, { proc: proc2 });
        proc2.emit('exit', 3);
        ok(/clean exit \(exit code 3\)/.test(read(log2.logPath)), 'process exit ends session without app');
        let threw = false;
        try { CL.install(log2, { proc: new EventEmitter(), crashReporter: { start: () => { throw new Error('no'); } } }); } catch (_) { threw = true; }
        ok(!threw && /crash reporter start failed/.test(read(log2.logPath)), 'crashReporter failure logged, not thrown');
    }

    // ── 7. countDumps ──
    {
        const d = path.join(root, 'dumps');
        fs.mkdirSync(path.join(d, 'reports', 'deep', 'deeper'), { recursive: true });
        fs.writeFileSync(path.join(d, 'a.dmp'), 'x');
        fs.writeFileSync(path.join(d, 'reports', 'b.DMP'), 'x');
        fs.writeFileSync(path.join(d, 'reports', 'c.txt'), 'x');
        fs.writeFileSync(path.join(d, 'reports', 'deep', 'd.dmp'), 'x');
        fs.writeFileSync(path.join(d, 'reports', 'deep', 'deeper', 'e.dmp'), 'x');
        ok(CL.countDumps(fs, d) === 3, 'countDumps counts .dmp to depth 2');
        ok(CL.countDumps(fs, path.join(root, 'missing')) === 0 && CL.countDumps(fs, '') === 0, 'missing folder → 0');
    }

    // ── 8. electron-main wiring (static) ──
    {
        const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'electron-main.js'), 'utf-8');
        const pre = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'preload.js'), 'utf-8');
        ok(/require\('\.\/modules\/_shared\/crash-log\.js'\)/.test(main), 'electron-main requires crash-log');
        ok(/_crashLogLib\.install\(crashLog/.test(main), 'electron-main installs hooks');
        for (const ch of ['crash-log-info', 'crash-log-open-folder', 'crash-log-export', 'crash-log-clear']) {
            ok(main.includes(`ipcMain.handle('${ch}'`) && pre.includes(`'${ch}'`), 'IPC + preload: ' + ch);
        }
    }
} finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

console.log(fail ? `\n✖ FAILURES pass=${pass} fail=${fail}` : `\n✔ crash-log: ${pass} passed`);
process.exitCode = fail ? 1 : 0;
