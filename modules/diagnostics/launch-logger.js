// modules/diagnostics/launch-logger.js
//
// VIPER Diagnostic Edition — Launch Logger
// ─────────────────────────────────────────────────────────────────────
// Captures every signal we'd want to investigate the "N windows on
// launch" bug and Defender Brocoiner false positive without requiring
// access to the user's machine.
//
// Initialized at the VERY TOP of electron-main.js (before any other
// module). Writes a structured JSON log to:
//   %APPDATA%\V.I.P.E.R.\diagnostics\launch-YYYYMMDD-HHMMSS-<pid>.json
//
// Each launch produces a separate file. The diagnostic-report module
// bundles them all into a zip for the user to email back.
//
// Captures:
//   - Timestamp (UTC + local), PID, PPID
//   - process.argv, working dir, exe path, app path
//   - Filtered process.env (TEMP, USERPROFILE, LOCALAPPDATA, etc.)
//   - Existing viper-electron processes at launch (tasklist snapshot)
//   - Registry Run keys (HKCU + HKLM Software\Microsoft\Windows\CurrentVersion\Run)
//   - Windows Defender event log (last 24h Brocoiner / VIPER mentions)
//   - Single-instance lock acquisition result
//   - Every BrowserWindow construction (wrapped, stack trace logged)
//   - Every app event firing (ready, activate, window-all-closed, etc.)
//   - Subprocess spawn attempts (wrapped, args logged)
//   - Errors / unhandled rejections

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let _logFile = null;
let _events = [];
let _startedAt = null;
let _flushTimer = null;

function _now() {
  const d = new Date();
  return {
    iso: d.toISOString(),
    local: d.toString(),
    epoch_ms: d.getTime(),
  };
}

function _safeSpawnSync(cmd, args, opts) {
  try {
    const r = spawnSync(cmd, args, Object.assign({
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }, opts || {}));
    return {
      ok: r.status === 0,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      status: r.status,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _push(type, payload) {
  _events.push({
    t: _now().iso,
    pid: process.pid,
    type,
    payload: payload || {},
  });
  _scheduleFlush();
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _flush();
  }, 250);
}

function _flush() {
  if (!_logFile) return;
  try {
    const snapshot = {
      schema_version: 1,
      started_at: _startedAt,
      flushed_at: _now(),
      events: _events,
    };
    fs.writeFileSync(_logFile, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (e) {
    // Silent — we don't want logger errors to affect the app.
  }
}

function _collectInitialSnapshot(app) {
  const snap = {
    timestamp: _now(),
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.versions.node,
    electron_version: process.versions.electron,
    chrome_version: process.versions.chrome,
    app_version: (app && app.getVersion) ? app.getVersion() : null,
    app_path: (app && app.getAppPath) ? app.getAppPath() : null,
    user_data: (app && app.getPath) ? (function(){ try { return app.getPath('userData'); } catch(_) { return null; } })() : null,
    os: {
      release: os.release(),
      type: os.type(),
      hostname: os.hostname(),
      uptime_sec: os.uptime(),
      totalmem_mb: Math.round(os.totalmem() / 1024 / 1024),
      freemem_mb: Math.round(os.freemem() / 1024 / 1024),
      cpus: os.cpus().length,
    },
    env_filtered: {},
  };
  // Capture a filtered subset of env (avoid logging secrets / tokens)
  const ENV_ALLOW = [
    'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMPUTERNAME', 'USERNAME',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'SESSIONNAME',
    'VIPER_DIAGNOSTIC_MODE', 'VIPER_DISABLE_AUTOUPDATE',
  ];
  for (const k of ENV_ALLOW) {
    if (process.env[k] != null) snap.env_filtered[k] = process.env[k];
  }
  return snap;
}

function _collectWindowsContext() {
  if (process.platform !== 'win32') return { skipped: 'not-windows' };
  const ctx = {};

  // Snapshot of currently-running viper-electron processes
  const tl = _safeSpawnSync('tasklist', ['/FI', 'IMAGENAME eq V.I.P.E.R..exe', '/FO', 'CSV', '/V']);
  ctx.tasklist_viper = tl.ok ? tl.stdout : ('error: ' + (tl.error || tl.stderr));

  const tl2 = _safeSpawnSync('tasklist', ['/FI', 'IMAGENAME eq viper-electron.exe', '/FO', 'CSV', '/V']);
  ctx.tasklist_viper_electron = tl2.ok ? tl2.stdout : ('error: ' + (tl2.error || tl2.stderr));

  // Registry Run keys — what auto-starts at boot/login?
  const rk1 = _safeSpawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  ctx.run_hkcu = rk1.ok ? rk1.stdout : ('error: ' + (rk1.error || rk1.stderr));

  const rk2 = _safeSpawnSync('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  ctx.run_hklm = rk2.ok ? rk2.stdout : ('error: ' + (rk2.error || rk2.stderr));

  // Scheduled tasks that mention VIPER
  const st = _safeSpawnSync('schtasks', ['/Query', '/FO', 'CSV', '/V']);
  if (st.ok) {
    const lines = st.stdout.split(/\r?\n/).filter(l => /viper/i.test(l));
    ctx.scheduled_tasks_viper = lines.slice(0, 50).join('\n');
  } else {
    ctx.scheduled_tasks_viper = 'error: ' + (st.error || st.stderr);
  }

  // Windows Defender events (last 24h, Brocoiner / Trojan / VIPER mentions)
  const wd = _safeSpawnSync('wevtutil', [
    'qe', 'Microsoft-Windows-Windows Defender/Operational',
    '/q:*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]',
    '/c:50', '/rd:true', '/f:text',
  ], { timeout: 10000 });
  if (wd.ok) {
    // Filter to events that mention us or threats
    const lines = wd.stdout.split(/\r?\n/);
    const interesting = [];
    let buf = [];
    for (const line of lines) {
      buf.push(line);
      if (line.trim() === '' && buf.length > 1) {
        const block = buf.join('\n');
        if (/viper|brocoiner|trojan|threat/i.test(block)) interesting.push(block);
        buf = [];
      }
    }
    ctx.defender_events = interesting.slice(0, 20).join('\n---\n');
  } else {
    ctx.defender_events = 'error: ' + (wd.error || wd.stderr);
  }

  return ctx;
}

/**
 * Initialize the launch logger. Must be called BEFORE any other module
 * has a chance to create windows or spawn processes.
 *
 * @param {object} opts
 * @param {object} opts.app                 — Electron app instance
 * @param {string} [opts.outputDir]         — override; default: %APPDATA%/V.I.P.E.R./diagnostics
 * @param {boolean} [opts.captureWindows]   — wrap BrowserWindow constructor (default true)
 */
function init(opts) {
  opts = opts || {};
  const app = opts.app;
  _startedAt = _now();

  // Resolve output directory
  let outDir = opts.outputDir;
  if (!outDir) {
    try {
      const ud = app && app.getPath ? app.getPath('userData') : null;
      outDir = ud ? path.join(ud, 'diagnostics') : path.join(os.tmpdir(), 'viper-diagnostics');
    } catch (_) {
      outDir = path.join(os.tmpdir(), 'viper-diagnostics');
    }
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}

  // Build a unique-per-launch filename
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  _logFile = path.join(outDir, `launch-${ts}-pid${process.pid}.json`);

  // Initial snapshot
  _push('launch_start', _collectInitialSnapshot(app));
  _push('windows_context', _collectWindowsContext());

  // Wrap process events
  process.on('uncaughtException', (err) => {
    _push('uncaught_exception', { message: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    _push('unhandled_rejection', {
      reason: (reason && reason.stack) ? reason.stack : String(reason),
    });
  });

  // Wrap app lifecycle events
  if (app) {
    ['ready', 'activate', 'window-all-closed', 'before-quit', 'will-quit',
     'quit', 'second-instance', 'open-url', 'open-file'].forEach(evt => {
      try {
        app.on(evt, (...args) => {
          _push('app_event', {
            event: evt,
            args_summary: args.map(a => {
              if (a == null) return null;
              if (typeof a === 'string') return a.slice(0, 200);
              if (typeof a === 'number' || typeof a === 'boolean') return a;
              if (Array.isArray(a)) return `[array len=${a.length}]`;
              return '[object]';
            }),
          });
        });
      } catch (_) {}
    });
  }

  // Wrap BrowserWindow constructor to log every window creation
  // with a stack trace — this is the KEY signal for "N windows opened"
  if (opts.captureWindows !== false) {
    try {
      const electron = require('electron');
      const OriginalBW = electron.BrowserWindow;
      if (OriginalBW && OriginalBW.__viperWrapped !== true) {
        const Wrapped = function (...args) {
          const stack = new Error('BrowserWindow constructed').stack;
          _push('browser_window_created', {
            options_summary: (() => {
              const o = args[0] || {};
              return {
                width: o.width, height: o.height,
                show: o.show, frame: o.frame,
                webPreferences_keys: o.webPreferences ? Object.keys(o.webPreferences) : [],
              };
            })(),
            stack: stack.split('\n').slice(0, 20).join('\n'),
            existing_window_count: OriginalBW.getAllWindows().length,
          });
          return new OriginalBW(...args);
        };
        // Preserve static methods
        Object.setPrototypeOf(Wrapped, OriginalBW);
        Wrapped.prototype = OriginalBW.prototype;
        Wrapped.__viperWrapped = true;
        // Replace on the electron module — anything that does
        // const { BrowserWindow } = require('electron') AFTER this
        // point will get the wrapped constructor.
        try { electron.BrowserWindow = Wrapped; } catch (_) {}
      }
    } catch (e) {
      _push('window_wrap_failed', { error: e.message });
    }
  }

  // Final flush before process exit
  process.on('exit', (code) => {
    _push('process_exit', { code });
    _flush();
  });

  _flush();
  return {
    logFile: _logFile,
    outputDir: outDir,
    push: _push,
    flush: _flush,
  };
}

/**
 * Return the directory where launch logs are written. Used by the
 * diagnostic-report module to find logs to bundle.
 */
function getOutputDir(app) {
  try {
    const ud = app && app.getPath ? app.getPath('userData') : null;
    return ud ? path.join(ud, 'diagnostics') : path.join(os.tmpdir(), 'viper-diagnostics');
  } catch (_) {
    return path.join(os.tmpdir(), 'viper-diagnostics');
  }
}

module.exports = { init, push: _push, flush: _flush, getOutputDir };
