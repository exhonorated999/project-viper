/*
 * after-pack-guard.js — electron-builder `afterPack` hook.
 *
 * Runs after the app folder is packed and BEFORE any installer is built or
 * anything is published. Scans resources/app.asar with the same rules as the
 * commit hook (scripts/sensitive-guard.js) and aborts the build if case
 * data, evidence, documents outside the asset folders, local sensitive terms
 * or secrets made it into the package. v2.2.2 – v5.5.0 shipped a local
 * `sample-data/` folder this way, because `files: "**\/*"` packs everything
 * on disk, tracked or not.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const guard = require('./sensitive-guard');

exports.default = async function afterPack(context) {
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) throw new Error('after-pack-guard: ' + asarPath + ' not found (asar disabled?) — refusing to build unchecked');
  const terms = guard.loadTerms(path.resolve(__dirname, '..'));
  const entries = guard.asarEntries(asarPath);
  const bad = [];
  for (const e of entries) for (const v of guard.checkEntry(e, { terms, skipSize: true, packaged: true })) bad.push(v);
  if (bad.length) {
    console.error('\nafter-pack-guard: the package contains files that must never ship:');
    for (const v of bad) console.error('  ' + v.path + '  — ' + v.rule + ': ' + v.msg);
    console.error('Exclude them in the electron-builder "files" list (or remove them from disk) and build again.\n');
    throw new Error('after-pack-guard: ' + bad.length + ' sensitive file(s) in app.asar — build stopped before any installer was made');
  }
  console.log('  • after-pack-guard: app.asar clean (' + entries.length + ' app files checked)');
};
