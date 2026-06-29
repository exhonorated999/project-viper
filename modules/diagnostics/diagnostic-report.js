// modules/diagnostics/diagnostic-report.js
//
// VIPER Diagnostic Edition — Report Bundler
// ─────────────────────────────────────────────────────────────────────
// Walks the diagnostics directory created by launch-logger, collects
// all launch-*.json files, plus the main-process log, plus a one-shot
// snapshot of the current system state, and bundles them into a single
// .zip file the user can email back.
//
// Output: VIPER-DIAG-<computer>-<user>-<timestamp>.zip on the user's
// Desktop (or wherever they save it).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = (() => {
  try { return require('archiver'); } catch (_) { return null; }
})();
const { spawnSync } = require('child_process');

function _safe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    return r.stdout || (r.stderr || '');
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
}

function _collectLiveSnapshot(app, launchLogger) {
  const lines = [];
  lines.push('VIPER DIAGNOSTIC REPORT');
  lines.push('=======================');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Computer:  ' + os.hostname());
  lines.push('User:      ' + (process.env.USERNAME || process.env.USER || 'unknown'));
  lines.push('Platform:  ' + process.platform + ' ' + os.release());
  lines.push('Arch:      ' + process.arch);
  lines.push('Node:      ' + process.versions.node);
  lines.push('Electron:  ' + process.versions.electron);
  lines.push('Chrome:    ' + process.versions.chrome);
  lines.push('App ver:   ' + (app && app.getVersion ? app.getVersion() : 'unknown'));
  lines.push('App path:  ' + (app && app.getAppPath ? app.getAppPath() : 'unknown'));
  lines.push('Exec path: ' + process.execPath);
  lines.push('PID:       ' + process.pid);
  lines.push('PPID:      ' + process.ppid);
  lines.push('Argv:      ' + JSON.stringify(process.argv));
  lines.push('');

  if (process.platform === 'win32') {
    lines.push('=== Currently running VIPER processes ===');
    lines.push(_safe('tasklist', ['/FI', 'IMAGENAME eq V.I.P.E.R..exe', '/FO', 'TABLE', '/V']));
    lines.push(_safe('tasklist', ['/FI', 'IMAGENAME eq viper-electron.exe', '/FO', 'TABLE', '/V']));
    lines.push('');

    lines.push('=== Registry: HKCU\\...\\Run (login auto-start) ===');
    lines.push(_safe('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']));
    lines.push('');

    lines.push('=== Registry: HKLM\\...\\Run (system auto-start) ===');
    lines.push(_safe('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']));
    lines.push('');

    lines.push('=== Scheduled tasks mentioning VIPER ===');
    const st = _safe('schtasks', ['/Query', '/FO', 'CSV', '/V']);
    const stLines = st.split(/\r?\n/).filter(l => /viper/i.test(l));
    lines.push(stLines.slice(0, 50).join('\n') || '(none)');
    lines.push('');

    lines.push('=== Windows Defender history (Brocoiner / Trojan / VIPER, last 24h) ===');
    const wd = _safe('wevtutil', [
      'qe', 'Microsoft-Windows-Windows Defender/Operational',
      '/q:*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]',
      '/c:50', '/rd:true', '/f:text',
    ]);
    const wdBlocks = wd.split(/\r?\n\r?\n/).filter(b => /viper|brocoiner|trojan|threat/i.test(b));
    lines.push(wdBlocks.slice(0, 20).join('\n---\n') || '(no matching events)');
    lines.push('');

    lines.push('=== Windows version ===');
    lines.push(_safe('ver', []));
    lines.push(_safe('systeminfo', []).split('\n').slice(0, 25).join('\n'));
  }

  return lines.join('\n');
}

/**
 * Bundle all diagnostic data into a zip on the given path.
 *
 * @param {object} opts
 * @param {object} opts.app           Electron app instance
 * @param {object} opts.launchLogger  The launch-logger module (for outputDir)
 * @param {string} opts.outPath       Absolute path to write the .zip to
 * @returns {Promise<{ok: boolean, zipPath?: string, error?: string, fileCount?: number}>}
 */
async function generate({ app, launchLogger, outPath }) {
  if (!archiver) {
    return { ok: false, error: 'archiver module not installed (npm install archiver)' };
  }

  const diagDir = launchLogger.getOutputDir(app);

  // Take a live snapshot
  let liveTxt;
  try {
    liveTxt = _collectLiveSnapshot(app, launchLogger);
  } catch (e) {
    liveTxt = 'Failed to collect live snapshot: ' + e.message;
  }

  return new Promise((resolve) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let entryCount = 0;

    output.on('close', () => {
      resolve({ ok: true, zipPath: outPath, fileCount: entryCount, size_bytes: archive.pointer() });
    });
    archive.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    archive.on('entry', () => { entryCount++; });

    archive.pipe(output);

    // 1) The live snapshot
    archive.append(liveTxt, { name: 'SUMMARY.txt' });

    // 2) Every launch log
    try {
      if (fs.existsSync(diagDir)) {
        const files = fs.readdirSync(diagDir).filter(f => /\.json$/i.test(f));
        for (const f of files) {
          try {
            const full = path.join(diagDir, f);
            archive.file(full, { name: 'launch-logs/' + f });
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 3) The main-process console log if we have one
    try {
      const userData = app.getPath('userData');
      const mainLog = path.join(userData, 'logs', 'main.log');
      if (fs.existsSync(mainLog)) {
        archive.file(mainLog, { name: 'main.log' });
      }
    } catch (_) {}

    archive.finalize();
  });
}

module.exports = { generate };
