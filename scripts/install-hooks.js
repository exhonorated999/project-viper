#!/usr/bin/env node
/*
 * install-hooks.js — points git at the repo's .githooks folder so the
 * sensitive-data guard (scripts/sensitive-guard.js) runs on every commit and
 * push. Runs from `npm install` (the "prepare" script); safe to run again.
 * Does nothing outside a git checkout (e.g. a packaged build or a zip).
 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const run = (args) => cp.execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

try {
  if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);
} catch (_) { process.exit(0); }

if (!fs.existsSync(path.join(root, '.githooks', 'pre-commit'))) process.exit(0);

let current = '';
try { current = run(['config', '--get', 'core.hooksPath']); } catch (_) { /* unset */ }
if (current && current !== '.githooks') {
  console.warn('install-hooks: core.hooksPath is "' + current + '"; leaving it. The sensitive-data guard will NOT run on commit.');
  console.warn('install-hooks: to use it: git config core.hooksPath .githooks');
  process.exit(0);
}
if (current !== '.githooks') {
  run(['config', 'core.hooksPath', '.githooks']);
  console.log('install-hooks: git hooks enabled (.githooks: sensitive-data guard on commit and push)');
}
