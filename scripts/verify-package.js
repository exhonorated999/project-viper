#!/usr/bin/env node
/*
 * verify-package.js — post-build gate for the packaged Windows app.
 *
 * WHY THIS EXISTS
 * ---------------
 * 5.1.3 shipped an app.asar whose entry offsets were shifted: the archive
 * listed all 6,984 entries fine, but reading "package.json" returned bytes
 * from the middle of an unrelated JavaScript file. Electron could not parse
 * package.json, so it never resolved `main`, and the process exited silently
 * — no window, no crash dialog, nothing in the Windows event log. Every
 * artifact built from that win-unpacked tree (Setup, Portable, MSI) was
 * bricked, and it reached users before anyone launched the build.
 *
 * electron-builder reported success, so "the build exited 0" is NOT evidence
 * that the app runs. This script reads the packed archive the way Electron
 * does and refuses the build if anything fails to come back out intact.
 *
 * Usage:  node scripts/verify-package.js [pathToUnpackedDir]
 * Exits non-zero on any failure.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const asar = require('@electron/asar');

const root       = path.resolve(__dirname, '..');
const unpackedIn = process.argv[2] || path.join(root, 'dist', 'win-unpacked');
const asarPath   = path.join(unpackedIn, 'resources', 'app.asar');
const expected   = require(path.join(root, 'package.json')).version;

let failures = 0;
const pass = (m) => console.log('  ok    ' + m);
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };

console.log('Verifying ' + asarPath);

if (!fs.existsSync(asarPath)) {
  console.log('  FAIL  app.asar not found — did the build run?');
  process.exit(1);
}

// 1. The archive header must be readable.
let entries = [];
try {
  entries = asar.listPackage(asarPath);
  pass('archive header readable (' + entries.length + ' entries)');
} catch (e) {
  fail('archive header unreadable: ' + e.message);
  process.exit(1);
}

// 2. package.json must round-trip. This is the exact read Electron performs
//    first; a shifted offset here is fatal and otherwise invisible.
let pkg = null;
try {
  const raw = asar.extractFile(asarPath, 'package.json').toString('utf8');
  pkg = JSON.parse(raw);
  pass('package.json parses');
} catch (e) {
  fail('package.json did NOT parse — archive offsets are corrupt: ' + e.message);
}

if (pkg) {
  if (pkg.version === expected) pass('version matches source (' + expected + ')');
  else fail('version mismatch: asar=' + pkg.version + ' source=' + expected);

  // 3. The entry point must exist and be valid JavaScript. Compile it the
  //    way Electron loads it — as a CommonJS module, i.e. inside Node's
  //    module wrapper function — so a legal top-level `return` (the portable
  //    update helper branch at the top of electron-main.js) is accepted.
  //    Corrupt or truncated bytes still fail to compile.
  try {
    const mainBuf = asar.extractFile(asarPath, pkg.main);
    new vm.Script(require('module').wrap(mainBuf.toString('utf8')), { filename: pkg.main });
    pass('entry point ' + pkg.main + ' parses (' + mainBuf.length + ' bytes)');
  } catch (e) {
    fail('entry point ' + pkg.main + ' unusable: ' + e.message);
  }
}

// 4. Spot-check the files a corrupt-offset archive would also mangle. Each
//    must both extract AND start with content of the right shape — a size
//    match alone would not catch bytes read from the wrong location.
const spotChecks = [
  { file: 'preload.js',                       test: (s) => /contextBridge/.test(s),        want: 'contextBridge' },
  { file: 'index.html',                       test: (s) => /^\s*<!DOCTYPE html/i.test(s),  want: '<!DOCTYPE html>' },
  { file: 'case-detail-with-analytics.html',  test: (s) => /^\s*<!DOCTYPE html/i.test(s),  want: '<!DOCTYPE html>' },
  // electron-main.js requires bt-main at startup — a missing file means the app never opens.
  { file: path.join('modules', 'bittorrent', 'bt-main.js'),           test: (s) => /register/.test(s) && /bt-verify/.test(s) && /bt-media-url/.test(s), want: 'register() + bt-media-url / bt-verify' },
  { file: path.join('modules', 'bittorrent', 'td-log-parser.js'),     test: (s) => /discoverLogs/.test(s),      want: 'discoverLogs' },
  { file: path.join('modules', 'bittorrent', 'td-model.js'),          test: (s) => /clientProfile/.test(s),     want: 'clientProfile' },
  { file: path.join('modules', 'bittorrent', 'bittorrent-module.js'), test: (s) => /BitTorrentModule/.test(s) && /verifyFiles/.test(s) && /exportSummaryPdf/.test(s) && /sendToWarrantAuthor/.test(s), want: 'BitTorrentModule + verifyFiles + report outputs' },
  { file: path.join('modules', 'bittorrent', 'bt-report.js'),         test: (s) => /BtReport/.test(s) && /reportHtml/.test(s) && /reportBlocks/.test(s) && /pcParagraph/.test(s) && /hashCsv/.test(s), want: 'BtReport reportBlocks / reportHtml / pcParagraph / hashCsv' },
  { file: path.join('modules', 'reports', 'blocks-docx.js'),          test: (s) => /buildDocx/.test(s) && /cleanText/.test(s), want: 'blocks-docx buildDocx (Word report from blocks)' },
  { file: path.join('modules', 'bittorrent', 'bittorrent-ui.js'),     test: (s) => /BitTorrentUI/.test(s) && /openViewer/.test(s), want: 'BitTorrentUI + viewer' },
  { file: path.join('modules', 'bittorrent', 'bittorrent-styles.css'), test: (s) => /\.btt-/.test(s) && /\.btt-tile\.blur/.test(s), want: '.btt- styles + blur' },
  { file: path.join('modules', '_shared', 'evidence-view.js'),        test: (s) => /createEvidenceView/.test(s), want: 'createEvidenceView' },
  { file: path.join('modules', '_shared', 'cdr-formats.js'),          test: (s) => /CdrFormats/.test(s) && /tmobileMapping/.test(s), want: 'CdrFormats.tmobileMapping' },
  { file: path.join('modules', 'parser-submission', 'sample-builder.js'), test: (s) => /function inspectExcel/.test(s), want: 'inspectExcel (Scout Excel headers)' },
  { file: path.join('modules', '_shared', 'video-playback.js'),       test: (s) => /createVideoPlayback/.test(s) && /locateFfmpeg/.test(s), want: 'createVideoPlayback' },
  { file: path.join('modules', '_shared', 'legacy-video.js'),         test: (s) => /VpLegacyVideo/.test(s) && /warrantVideo/.test(s), want: 'VpLegacyVideo' },
];

for (const { file, test, want } of spotChecks) {
  try {
    const s = asar.extractFile(asarPath, file).toString('utf8');
    if (test(s)) pass(file + ' intact');
    else fail(file + ' extracted but content is wrong (expected ' + want + ') — offsets shifted');
  } catch (e) {
    fail(file + ' could not be extracted: ' + e.message);
  }
}

// 5. Every unpacked native module referenced must actually be on disk.
const unpackedDir = asarPath + '.unpacked';
if (fs.existsSync(unpackedDir)) {
  const nodeFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.node')) nodeFiles.push(f);
    }
  })(unpackedDir);
  if (nodeFiles.length) pass('native modules present (' + nodeFiles.length + ' .node)');
  else fail('app.asar.unpacked exists but contains no .node binaries');
}

// 6. ffmpeg (old-format video playback + video thumbnails) ships via
//    extraResources → resources\ffmpeg (an .exe cannot run from inside the
//    asar) with its DLLs and LGPL notice, and must actually run.
//    Missing → run scripts\fetch-ffmpeg.js.
(function checkFfmpeg() {
  const dir = path.join(unpackedIn, 'resources', 'ffmpeg');
  const exe = path.join(dir, 'ffmpeg.exe');
  if (!fs.existsSync(exe)) { fail('ffmpeg missing at ' + exe + ' — run: node scripts\\fetch-ffmpeg.js, then package again'); return; }
  const dlls = fs.readdirSync(dir).filter(n => /\.dll$/i.test(n));
  const need = ['avcodec', 'avformat', 'avutil', 'avfilter', 'swscale', 'swresample', 'avdevice'];
  const missing = need.filter(p => !dlls.some(n => n.toLowerCase().startsWith(p + '-')));
  if (missing.length) fail('ffmpeg DLLs missing: ' + missing.join(', '));
  if (!fs.existsSync(path.join(dir, 'LICENSE')) || !fs.existsSync(path.join(dir, 'NOTICE'))) fail('ffmpeg LICENSE / NOTICE missing (LGPL notice must ship)');
  try {
    const cp = require('child_process');
    const ver = cp.execFileSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000 }).split(/\r?\n/)[0];
    const enc = cp.execFileSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20000 });
    const cfg = cp.execFileSync(exe, ['-hide_banner', '-buildconf'], { encoding: 'utf8', timeout: 20000 });
    if (/--enable-gpl|--enable-nonfree/.test(cfg)) fail('ffmpeg is a GPL/nonfree build — VIPER ships LGPL only');
    else if (!/\slibopenh264\s/.test(enc) || !/\saac\s/.test(enc)) fail('ffmpeg lacks the libopenh264 / aac encoders');
    else pass('ffmpeg runs, LGPL (' + ver.replace(/ Copyright.*/, '') + ', ' + dlls.length + ' DLLs)');
  } catch (e) {
    fail('ffmpeg did not run: ' + e.message);
  }
})();

console.log('');
if (failures) {
  console.log('PACKAGE VERIFICATION FAILED (' + failures + ' problem' + (failures > 1 ? 's' : '') + ') — DO NOT PUBLISH');
  process.exit(1);
}
console.log('Package verification passed — safe to sign off and publish.');
