/**
 * VIPER crash log — main process only.
 *
 * When VIPER disappears (out of memory, native crash, renderer killed) there
 * is usually nothing on screen and nothing in the console the officer can
 * send us.  This writes a small local log:
 *
 *   <userData>/logs/viper-crash.log      (rotates to viper-crash.1.log at 5 MB)
 *   <userData>/logs/viper-session.json   (present while VIPER runs)
 *
 * If viper-session.json is still there at the next start, the previous run
 * did not exit cleanly; its last breadcrumb (e.g. "Google Warrant import,
 * Mail.MessageContent, 18 GB") is written to the log and shown in Settings.
 *
 * Nothing is uploaded.  The user's home folder is written as %USERPROFILE%
 * and e-mail addresses as <email>, so a log can be shared safely.
 */
'use strict';

const path = require('path');

const LOG_NAME = 'viper-crash.log';
const OLD_LOG_NAME = 'viper-crash.1.log';
const SESSION_NAME = 'viper-session.json';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

function _escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function makeRedactor(homeDir) {
    const homes = [];
    if (homeDir) {
        homes.push(homeDir.replace(/\\/g, '\\\\'));   // JSON-escaped form first
        homes.push(homeDir);
        homes.push(homeDir.replace(/\\/g, '/'));
    }
    const homeRes = homes.filter(Boolean).map(h => new RegExp(_escapeRe(h), 'gi'));
    return function redact(text) {
        let s = String(text == null ? '' : text);
        for (const re of homeRes) s = s.replace(re, '%USERPROFILE%');
        s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>');
        return s;
    };
}

function _errText(err) {
    if (err == null) return String(err);
    if (err instanceof Error || (err && err.stack)) {
        const stack = String(err.stack || err.message || err).split('\n').slice(0, 20).join('\n');   // write() indents continuation lines
        return stack;
    }
    if (typeof err === 'object') { try { return JSON.stringify(err); } catch (_) {} }
    return String(err);
}

function _mb(n) { return Math.round((Number(n) || 0) / 1048576); }

/**
 * @param {Object} o
 * @param {Object} o.fs           node fs (injectable for tests)
 * @param {string} o.logDir
 * @param {string} o.version
 * @param {string} [o.homeDir]
 * @param {number} [o.maxBytes]
 * @param {Function} [o.now]      () => Date
 * @param {Function} [o.memory]   () => { rss, heapUsed }
 * @param {number} [o.pid]
 * @param {boolean} [o.isPortable]
 */
function createCrashLog(o) {
    const fs = o.fs;
    const logDir = o.logDir;
    const logPath = path.join(logDir, LOG_NAME);
    const oldPath = path.join(logDir, OLD_LOG_NAME);
    const sessionPath = path.join(logDir, SESSION_NAME);
    const maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
    const now = o.now || (() => new Date());
    const memory = o.memory || (() => process.memoryUsage());
    const redact = makeRedactor(o.homeDir);
    let session = null;
    let previous = null;     // last session that did not exit cleanly
    let ended = false;
    let started = false;

    function _ensureDir() {
        try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
    }

    function _rotateIfNeeded() {
        try {
            const st = fs.statSync(logPath);
            if (st.size < maxBytes) return;
            try { fs.unlinkSync(oldPath); } catch (_) {}
            fs.renameSync(logPath, oldPath);
        } catch (_) { /* no log yet */ }
    }

    function write(level, message) {
        try {
            _ensureDir();
            _rotateIfNeeded();
            const line = `${now().toISOString()} [${level}] ${redact(message)}`.replace(/\r?\n/g, '\n    ') + '\n';
            fs.appendFileSync(logPath, line);
        } catch (_) { /* logging must never throw */ }
    }

    function _memText() {
        try { const m = memory(); return `rss=${_mb(m.rss)}MB heap=${_mb(m.heapUsed)}MB`; } catch (_) { return ''; }
    }

    function _writeSession() {
        try { _ensureDir(); fs.writeFileSync(sessionPath, JSON.stringify(session)); } catch (_) {}
    }

    function start() {
        if (started) return api;
        started = true;
        _ensureDir();
        try {
            if (fs.existsSync(sessionPath)) {
                let prev = null;
                try { prev = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')); } catch (_) { prev = {}; }
                previous = prev || {};
                const last = previous.lastMark
                    ? `${previous.lastMark.label} ${previous.lastMark.detail || ''} at ${previous.lastMark.at} (${previous.lastMark.mem || ''})`
                    : 'none recorded';
                write('UNCLEAN-EXIT', `The previous session (VIPER ${previous.version || '?'}, started ${previous.startedAt || '?'}, pid ${previous.pid || '?'}) did not close normally. Last activity: ${last}`);
            }
        } catch (_) {}
        session = {
            pid: o.pid || process.pid,
            version: o.version || '',
            startedAt: now().toISOString(),
            portable: !!o.isPortable,
            lastMark: null,
        };
        _writeSession();
        write('START', `VIPER ${o.version || ''} pid=${session.pid} portable=${!!o.isPortable} ${_memText()}`);
        return api;
    }

    function mark(label, detail) {
        const at = now().toISOString();
        const mem = _memText();
        let d = '';
        if (detail != null) { try { d = JSON.stringify(detail); } catch (_) { d = String(detail); } }
        write('MARK', `${label}${d ? ' ' + d : ''} ${mem}`);
        if (session && !ended) {
            session.lastMark = { at, label: redact(label), detail: d ? redact(d) : null, mem };
            _writeSession();
        }
    }

    function error(kind, err) {
        write('ERROR', `${kind}: ${_errText(err)} ${_memText()}`);
    }

    function crash(kind, details) {
        let d = '';
        try { d = JSON.stringify(details || {}); } catch (_) { d = String(details); }
        write('CRASH', `${kind} ${d} ${_memText()}`);
    }

    function endSession(reason) {
        if (ended) return;
        ended = true;
        write('EXIT', `clean exit${reason ? ' (' + reason + ')' : ''}`);
        try { fs.unlinkSync(sessionPath); } catch (_) {}
    }

    function _size(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }

    function tail(maxBytesToRead) {
        const n = maxBytesToRead || TAIL_BYTES;
        try {
            const size = _size(logPath);
            if (!size) return '';
            const len = Math.min(size, n);
            const fd = fs.openSync(logPath, 'r');
            try {
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, size - len);
                let s = buf.toString('utf-8');
                if (len < size) s = s.slice(s.indexOf('\n') + 1);
                return s;
            } finally { fs.closeSync(fd); }
        } catch (_) { return ''; }
    }

    function info() {
        return {
            logDir,
            logPath,
            size: _size(logPath) + _size(oldPath),
            previousUnclean: !!previous,
            previous: previous ? {
                version: previous.version || null,
                startedAt: previous.startedAt || null,
                lastMark: previous.lastMark || null,
            } : null,
            tail: tail(16 * 1024),
        };
    }

    function exportText() {
        let s = '';
        try { if (fs.existsSync(oldPath)) s += fs.readFileSync(oldPath, 'utf-8'); } catch (_) {}
        try { if (fs.existsSync(logPath)) s += fs.readFileSync(logPath, 'utf-8'); } catch (_) {}
        return s;
    }

    function clear() {
        try { fs.unlinkSync(oldPath); } catch (_) {}
        try { fs.writeFileSync(logPath, ''); } catch (_) {}
        previous = null;
        write('INFO', 'Log cleared by user');
    }

    const api = { start, write, mark, error, crash, endSession, info, tail, exportText, clear, redact, logPath, logDir, sessionPath };
    return api;
}

/** Wire the log to process / app events.  Behaviour of the app is unchanged. */
function install(log, { app, crashReporter, proc } = {}) {
    proc = proc || process;
    try {
        proc.on('uncaughtExceptionMonitor', (err, origin) => log.error(`uncaught exception (${origin})`, err));
        proc.on('unhandledRejection', (reason) => {
            log.error('unhandled promise rejection', reason);
            try { console.error('Unhandled promise rejection:', reason); } catch (_) {}
        });
        proc.on('exit', (code) => log.endSession(`exit code ${code}`));
    } catch (_) {}
    if (app && typeof app.on === 'function') {
        app.on('render-process-gone', (_e, wc, details) => {
            let url = '';
            try { url = wc && wc.getURL ? wc.getURL() : ''; } catch (_) {}
            url = String(url).replace(/^file:\/\/\/?/, '').split(/[?#]/)[0];
            log.crash('window process gone', { reason: details && details.reason, exitCode: details && details.exitCode, page: path.basename(url) });
        });
        app.on('child-process-gone', (_e, details) => {
            log.crash('helper process gone', { type: details && details.type, reason: details && details.reason, exitCode: details && details.exitCode, name: details && details.name });
        });
        app.on('will-quit', () => log.endSession('quit'));
    }
    if (crashReporter && typeof crashReporter.start === 'function') {
        try { crashReporter.start({ uploadToServer: false, compress: true }); } catch (e) { log.error('crash reporter start failed', e); }
    }
}

/** Count native crash dump files (Crashpad) under the crashDumps folder. */
function countDumps(fs, dir) {
    let n = 0;
    const walk = (d, depth) => {
        let names;
        try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of names) {
            if (x.isDirectory() && depth < 2) walk(path.join(d, x.name), depth + 1);
            else if (x.isFile() && /\.dmp$/i.test(x.name)) n++;
        }
    };
    if (dir) walk(dir, 0);
    return n;
}

module.exports = { createCrashLog, install, countDumps, makeRedactor, LOG_NAME, OLD_LOG_NAME, SESSION_NAME };
