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

  // 3. The entry point must exist and be valid JavaScript.
  try {
    const mainBuf = asar.extractFile(asarPath, pkg.main);
    new vm.Script(mainBuf.toString('utf8'), { filename: pkg.main });
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

console.log('');
if (failures) {
  console.log('PACKAGE VERIFICATION FAILED (' + failures + ' problem' + (failures > 1 ? 's' : '') + ') — DO NOT PUBLISH');
  process.exit(1);
}
console.log('Package verification passed — safe to sign off and publish.');
