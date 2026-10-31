#!/usr/bin/env node
/*
 * sensitive-guard.js — keeps case data, evidence, personal details and
 * secrets out of git and out of the installer.
 *
 * WHY THIS EXISTS
 * ---------------
 * From v2.2.2 to v5.5.2 the repository carried a `sample-data/` folder of
 * RMS extracts, warrant-return pages and probation records from real
 * agencies, a `cases/` folder holding a Gmail takeout, and a filled warrant
 * (`modules/warrant-author/_sample_body/`). The repo is public, the folders
 * were in every tag, and v2.2.2 – v5.5.0 installers packed `sample-data/`
 * because electron-builder's `files` was `**\/*` without an exclusion.
 * Deleting a folder in a later commit does not remove it from history; the
 * whole history had to be rewritten and every release re-tagged. This
 * script makes sure it cannot happen again.
 *
 * WHERE IT RUNS
 * -------------
 *   pre-commit  (.githooks/pre-commit)   node scripts/sensitive-guard.js --staged
 *   pre-push    (.githooks/pre-push)     node scripts/sensitive-guard.js --pre-push <remote>
 *   CI          (.github/workflows/sensitive-data.yml)  --range A..B  and  --tree HEAD
 *   packaging   (scripts/after-pack-guard.js, electron-builder afterPack) --asar <app.asar>
 *   by hand     npm run check:sensitive   (= --tree HEAD)
 *
 * Hooks are installed by `npm install` (prepare → scripts/install-hooks.js).
 * `git commit --no-verify` skips pre-commit but the pre-push hook and CI
 * check every commit that is pushed, so a bypassed commit is still caught
 * before it reaches GitHub.
 *
 * LOCAL TERMS
 * -----------
 * Real names, e-mails, phone numbers, account ids or addresses that must
 * never be committed go one per line in `.sensitive-terms.local` (repo
 * root, gitignored) or `~/.viper-sensitive-terms`. They are matched
 * case-insensitively against file contents and paths. The list itself is
 * never committed.
 *
 * ALLOWING SOMETHING
 * ------------------
 * Test data must be synthetic. Name it `*.synthetic.<ext>` or put the word
 * SYNTHETIC (or REDACTED, for a scrubbed real layout) in its first 1 KB.
 * Anything else that trips a rule and is genuinely safe goes in ALLOW below
 * with a reason; that change is then visible in review.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// ─── Rules ─────────────────────────────────────────────────────────────────

// Any path segment equal to one of these (case-insensitive) is refused.
const BLOCKED_DIRS = [
  'sample-data', 'sample_data', 'sampledata', 'cases', 'case-data', 'case_data',
  '_sample_body', 'real-data', 'real_data', 'evidence-files', 'warrant-returns',
  'returns-real', 'takeout',
];

// Evidence containers, mail stores, extraction formats, media, archives and
// binaries. None of these belong in source control.
const BLOCKED_EXT = [
  // mail / messaging stores
  'mbox', 'mbx', 'pst', 'ost', 'eml', 'emlx', 'msg', 'olm', 'vcf',
  // forensic images / extractions / reports
  'ufdr', 'ufd', 'ufdx', 'clbx', 'oversight', 'e01', 'ex01', 'l01', 'lx01', 'ad1',
  'aff', 'aff4', 'dd', 'mem', 'vmdk', 'vhd', 'vhdx', 'dmp', 'pcap', 'pcapng', 'har',
  // location exports
  'kml', 'kmz', 'gpx',
  // databases
  'db', 'sqlite', 'sqlite3', 'sqlitedb', 'realm',
  // media
  'heic', 'heif', 'mp4', 'm4v', 'mov', 'avi', 'wmv', 'flv', '3gp', 'mkv', 'webm',
  'wav', 'mp3', 'm4a', 'amr', 'opus', 'aac', 'caf', 'ogg',
  // archives / binaries / builds
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso',
  'exe', 'msi', 'dll', 'dmg', 'pkg', 'appx', 'asar', 'blockmap', 'gguf',
];

// Documents and images are only allowed where shipped assets live.
const RESTRICTED_EXT = [
  'pdf', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'csv', 'tsv',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp',
];
const ASSET_DIRS = [
  /^assets\//, /^libs\//, /^build\//, /^compliance\//, /^docs\//,
  /^modules\/[^/]+\/assets\//, /^modules\/warrant-author\/templates\//,
  /^modules\/case-status-report\/csr-logo\.png$/,
];

// Data files inside test folders must be marked synthetic / redacted.
const TEST_DIRS = ['fixtures', '__fixtures__', 'test_fixtures', 'test', 'tests', '__tests__'];
const DATA_EXT = ['txt', 'json', 'csv', 'tsv', 'xml', 'html', 'htm', 'log', 'md', 'yaml', 'yml'];
const SYNTH_MARK = /\b(SYNTHETIC|REDACTED)\b/i;

// Extra rules for the packaged app only (--asar / afterPack). v5.5.2 shipped
// test fixtures holding a real CargoNet alert, test logs and dev notes
// because the root-only "!test_fixtures/**" pattern missed modules/*.
const PACKAGE_DIRS = ['__tests__', 'test_fixtures', 'fixtures', '__fixtures__', 'test', 'tests', '.workshop', 'plans', 'tasks', '.github', '.githooks'];
const PACKAGE_EXT = ['log', 'py', 'pyc'];

// Size limit for anything committed.
const MAX_BYTES = 2 * 1024 * 1024;
const SIZE_OK = [
  /^case-detail-with-analytics\.html$/, /^libs\//, /^package-lock\.json$/,
  /^modules\/warrant-author\/templates\//, /^compliance\//, /^docs\//,
];

// Secrets. Checked in every text file.
const SECRET_RX = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/, 'API secret key'],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}\b/, 'Slack token'],
  [/\bhf_[A-Za-z0-9]{34,}\b/, 'Hugging Face token'],
];

// Raw mail / provider-return markers. Only checked in data files (not code,
// which legitimately names these headers in parsers).
const RAW_MAIL_RX = [
  [/^X-Gmail-Labels: /m, 'Gmail takeout header'],
  [/^From \S+@\S+ +(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /m, 'mbox message separator'],
  [/^Received: from \S+ \(/m, 'raw e-mail Received header'],
];

// Reviewed exceptions: { path, rules: [...rule ids], reason }.
const ALLOW = [
  { path: 'test-sample.mbox', rules: ['ext'], reason: 'synthetic: three messages between example.com addresses' },
  { path: 'test/sample-trace-export.json', rules: ['fixture'], reason: 'synthetic TRACE export (invented case, example people)' },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '');
const extOf = (p) => { const b = path.posix.basename(p).toLowerCase(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : ''; };
const segsOf = (p) => norm(p).split('/').slice(0, -1).map((s) => s.toLowerCase());
const isText = (buf) => buf && buf.length !== undefined && !buf.subarray(0, 8000).includes(0);
const allowed = (p, rule) => ALLOW.some((a) => a.path === p && a.rules.indexOf(rule) >= 0);

function loadTerms(root) {
  const files = [path.join(root || process.cwd(), '.sensitive-terms.local'), path.join(os.homedir(), '.viper-sensitive-terms')];
  const terms = [];
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of t.split(/\r?\n/)) {
      const s = line.trim();
      if (s && s[0] !== '#' && s.length >= 4) terms.push(s.toLowerCase());
    }
  }
  return terms;
}

/**
 * Check one file. `entry` = { path, size, data (Buffer|null) }.
 * Returns a list of { path, rule, msg }.
 */
function checkEntry(entry, opts) {
  opts = opts || {};
  const p = norm(entry.path);
  const out = [];
  const add = (rule, msg) => { if (!allowed(p, rule)) out.push({ path: p, rule, msg }); };
  const ext = extOf(p);
  const segs = segsOf(p);
  const terms = opts.terms || [];

  const dir = segs.find((s) => BLOCKED_DIRS.indexOf(s) >= 0);
  if (dir) add('dir', 'inside a "' + dir + '/" folder (case data / evidence folders are never committed or packaged)');

  if (BLOCKED_EXT.indexOf(ext) >= 0) add('ext', '.' + ext + ' files (evidence, mail stores, media, archives, binaries) are never committed or packaged');

  if (RESTRICTED_EXT.indexOf(ext) >= 0 && !ASSET_DIRS.some((rx) => rx.test(p))) {
    add('doc', '.' + ext + ' outside the asset/template folders; documents and images there are usually real records');
  }

  if (!opts.skipSize && entry.size > MAX_BYTES && !SIZE_OK.some((rx) => rx.test(p))) {
    add('size', (entry.size / 1048576).toFixed(1) + ' MB is over the ' + (MAX_BYTES / 1048576) + ' MB limit');
  }

  const lowPath = p.toLowerCase();
  for (const t of terms) if (lowPath.indexOf(t) >= 0) add('term', 'path contains a term from the local sensitive-terms list');

  if (opts.packaged) {
    const pk = segs.find((s) => PACKAGE_DIRS.indexOf(s) >= 0);
    if (pk) add('pkg', 'the "' + pk + '/" folder (tests, fixtures, dev notes) must not ship in the app');
    if (PACKAGE_EXT.indexOf(ext) >= 0) add('pkg', '.' + ext + ' files (logs, scratch scripts) must not ship in the app');
    if (/^_[^/]*\.(js|py)$/i.test(p)) add('pkg', 'root-level scratch script must not ship in the app');
  }

  const data = entry.data;
  if (data && isText(data)) {
    const text = data.toString('utf8');
    for (const [rx, what] of SECRET_RX) if (rx.test(text)) add('secret', 'contains what looks like a ' + what);

    const isData = DATA_EXT.indexOf(ext) >= 0;
    if (isData) for (const [rx, what] of RAW_MAIL_RX) if (rx.test(text)) add('mail', 'contains a ' + what + ' (raw mail / provider return)');

    if (isData && segs.some((s) => TEST_DIRS.indexOf(s) >= 0)) {
      const base = path.posix.basename(p).toLowerCase();
      if (base.indexOf('.synthetic.') < 0 && !SYNTH_MARK.test(text.slice(0, 1024))) {
        add('fixture', 'test data must be synthetic: name it *.synthetic.' + ext + ' or put SYNTHETIC / REDACTED in its first 1 KB');
      }
    }

    if (terms.length) {
      const low = text.toLowerCase();
      for (const t of terms) if (low.indexOf(t) >= 0) { add('term', 'contains a term from the local sensitive-terms list'); break; }
    }
  }
  // Collapse duplicate term hits.
  return out.filter((v, i, a) => a.findIndex((w) => w.rule === v.rule && w.msg === v.msg) === i);
}

// ─── Git plumbing ──────────────────────────────────────────────────────────

function git(args, input) {
  return cp.execFileSync('git', args, { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Read many blobs with one `git cat-file --batch`. Returns Map sha → Buffer. */
function readBlobs(shas) {
  const uniq = Array.from(new Set(shas));
  const map = new Map();
  if (!uniq.length) return map;
  const buf = git(['cat-file', '--batch'], uniq.join('\n') + '\n');
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    const head = buf.subarray(i, nl).toString('utf8').split(' ');
    i = nl + 1;
    if (head[1] === 'missing') continue;
    const size = parseInt(head[2], 10);
    map.set(head[0], buf.subarray(i, i + size));
    i += size + 1;
  }
  return map;
}

function entriesFromBlobs(list) {
  const blobs = readBlobs(list.map((e) => e.sha));
  return list.map((e) => { const d = blobs.get(e.sha) || null; return { path: e.path, sha: e.sha, size: d ? d.length : 0, data: d, commit: e.commit }; });
}

function stagedEntries() {
  const names = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).toString('utf8').split('\0').filter(Boolean);
  if (!names.length) return [];
  const ls = git(['ls-files', '-s', '-z', '--'].concat(names)).toString('utf8').split('\0').filter(Boolean);
  const list = ls.map((l) => { const tab = l.indexOf('\t'); const f = l.slice(0, tab).split(' '); return { mode: f[0], sha: f[1], path: l.slice(tab + 1) }; })
    .filter((e) => e.mode !== '160000');                         // submodules
  return entriesFromBlobs(list);
}

function treeEntries(ref) {
  const ls = git(['ls-tree', '-r', '-z', ref || 'HEAD']).toString('utf8').split('\0').filter(Boolean);
  const list = [];
  for (const l of ls) {
    const tab = l.indexOf('\t'); const f = l.slice(0, tab).split(' ');
    if (f[1] === 'blob') list.push({ sha: f[2], path: l.slice(tab + 1) });
  }
  return entriesFromBlobs(list);
}

/** Every file version added or modified by the commits in `revArgs` (rev-list args). */
function rangeEntries(revArgs) {
  const commits = git(['rev-list'].concat(revArgs)).toString('utf8').split('\n').filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const c of commits) {
    const raw = git(['diff-tree', '-r', '-m', '--root', '--no-commit-id', '-z', '--diff-filter=ACMR', c]).toString('utf8').split('\0');
    for (let i = 0; i < raw.length - 1; i += 2) {
      const meta = raw[i].replace(/^:/, '').split(' ');
      const sha = meta[3]; const p = raw[i + 1];
      if (!sha || /^160000/.test(meta[1]) || seen.has(sha + '\0' + p)) continue;
      seen.add(sha + '\0' + p);
      list.push({ sha, path: p, commit: c.slice(0, 9) });
    }
  }
  return { entries: entriesFromBlobs(list), commits: commits.length };
}

/** pre-push: stdin lines "<local ref> <local sha> <remote ref> <remote sha>". */
function prePushEntries(remote, stdin) {
  const ZERO = /^0+$/;
  const all = []; let commits = 0;
  for (const line of String(stdin).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || ZERO.test(f[1])) continue;            // branch deletion
    const revs = ZERO.test(f[3]) ? [f[1], '--not', '--remotes=' + (remote || 'origin')] : [f[3] + '..' + f[1]];
    const r = rangeEntries(revs);
    commits += r.commits; all.push.apply(all, r.entries);
  }
  return { entries: all, commits };
}

function asarEntries(file) {
  const asar = require('@electron/asar');
  const raw = asar.listPackage(file).map((r) => String(r).replace(/^[\\/]+/, ''));
  const out = [];
  for (const r of raw) {
    const p = norm(r);
    // Third-party packages and the unpacked build tools are not ours to police
    // here (and legitimately contain binaries); everything else is.
    if (/^node_modules\//.test(p) || /^build\//.test(p)) continue;
    let st = null;
    try { st = asar.statFile(file, r); } catch (_) { continue; }    // asar wants the native separator
    if (!st || st.files || st.link) continue;                   // directory / symlink
    let data = null;
    const ext = extOf(p);
    if (!st.unpacked && st.size < 8 * 1024 * 1024 && BLOCKED_EXT.indexOf(ext) < 0) {
      try { data = asar.extractFile(file, r); } catch (_) { data = null; }
    }
    out.push({ path: p, size: st.size || 0, data });
  }
  return out;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function report(violations, label) {
  if (!violations.length) { console.log('sensitive-guard: ' + label + ' — clean'); return 0; }
  console.error('\nsensitive-guard: BLOCKED — ' + label);
  console.error('─'.repeat(72));
  for (const v of violations) console.error('  ' + v.path + (v.commit ? '  (commit ' + v.commit + ')' : '') + '\n      ' + v.rule + ': ' + v.msg);
  console.error('─'.repeat(72));
  console.error('Case data, evidence, real names/contacts and secrets must never be');
  console.error('committed to this repository (it is public) or packed into the app.');
  console.error('  • Unstage it:            git restore --staged <file>');
  console.error('  • Already committed?     Do NOT just delete it in a new commit — history');
  console.error('                           keeps it. Stop and rewrite the commit before pushing.');
  console.error('  • Test data:             make it synthetic and name it *.synthetic.<ext>');
  console.error('  • Truly safe exception:  add it to ALLOW in scripts/sensitive-guard.js with');
  console.error('                           a reason (reviewed like any other change).');
  return 1;
}

function main(argv) {
  const root = (() => { try { return git(['rev-parse', '--show-toplevel']).toString('utf8').trim(); } catch (_) { return process.cwd(); } })();
  const terms = loadTerms(root);
  const opts = { terms };
  const mode = argv[0] || '--tree';
  let entries = []; let label = '';
  if (mode === '--staged') {
    entries = stagedEntries(); label = entries.length + ' staged file(s)';
  } else if (mode === '--tree') {
    const ref = argv[1] || 'HEAD';
    entries = treeEntries(ref); label = 'tree ' + ref + ' (' + entries.length + ' files)';
  } else if (mode === '--range') {
    const r = rangeEntries([argv[1]]);
    entries = r.entries; label = 'range ' + argv[1] + ' (' + r.commits + ' commits, ' + entries.length + ' file versions)';
  } else if (mode === '--pre-push') {
    const r = prePushEntries(argv[1], fs.readFileSync(0, 'utf8'));
    entries = r.entries; label = 'push (' + r.commits + ' new commits, ' + entries.length + ' file versions)';
  } else if (mode === '--asar') {
    entries = asarEntries(argv[1]); opts.skipSize = true; opts.packaged = true; label = 'packaged ' + argv[1] + ' (' + entries.length + ' app files)';
  } else {
    console.error('usage: sensitive-guard.js --staged | --tree [ref] | --range A..B | --pre-push <remote> | --asar <app.asar>');
    return 2;
  }
  const violations = [];
  for (const e of entries) for (const v of checkEntry(e, opts)) violations.push(Object.assign(v, { commit: e.commit }));
  return report(violations, label);
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error('sensitive-guard: failed to run — ' + (e && e.message)); process.exit(2); }
}

module.exports = { checkEntry, asarEntries, loadTerms, main, BLOCKED_DIRS, BLOCKED_EXT, RESTRICTED_EXT, ALLOW, MAX_BYTES };
