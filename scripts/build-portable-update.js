#!/usr/bin/env node
/*
 * build-portable-update.js — produce the self-update package for VIPER
 * folders that run from an external drive.
 *
 * A portable folder (F:\VIPER\V.I.P.E.R with userdata\ and cases\ beside
 * the exe) updates itself by downloading two release assets:
 *
 *   portable-update.json                    — what to fetch and its SHA-512
 *   V.I.P.E.R.-<version>-Portable-Update.zip — the contents of win-unpacked
 *
 * BOTH must be attached to the GitHub release (alongside latest.yml and
 * the installers) or portable folders report "this release has no portable
 * update package". latest.yml is not touched; desktop installs never read
 * either file. See modules/_shared/portable-update.js.
 *
 * Usage: node scripts/build-portable-update.js [pathToUnpackedDir]
 * Runs after verify-package.js in `npm run package`. Exits non-zero on failure.
 */

// If this is ever run under Electron-as-Node, the patched fs would expand
// app.asar into a folder and zip its contents. Keep archives as files.
process.noAsar = true;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const pu = require('../modules/_shared/portable-update.js');

const root = path.resolve(__dirname, '..');
const unpacked = path.resolve(process.argv[2] || path.join(root, 'dist', 'win-unpacked'));
const outDir = path.dirname(unpacked);
const version = require(path.join(root, 'package.json')).version;
const EXE = 'V.I.P.E.R.exe';
const zipName = 'V.I.P.E.R.-' + version + '-Portable-Update.zip';
const zipPath = path.join(outDir, zipName);
const manifestPath = path.join(outDir, pu.MANIFEST_NAME);

function die(msg) { console.error('  FAIL  ' + msg); process.exit(1); }

function walk(dir, rel, out) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + d.name : d.name;
        const p = path.join(dir, d.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) die('win-unpacked contains a link: ' + r);
        if (st.isDirectory()) { out.dirs.push(r); walk(p, r, out); }
        else out.files.push({ name: r, size: st.size });
    }
    return out;
}

(async () => {
    console.log('Building portable update package from ' + unpacked);
    if (!fs.existsSync(path.join(unpacked, EXE))) die(EXE + ' not found — did the build run?');
    // Plain fs here is Node's (this script never runs inside Electron), so
    // app.asar is read as an ordinary file.
    const asarPath = path.join(unpacked, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) die('resources/app.asar not found');
    const asarVersion = pu.readAsarVersion(fs, asarPath);
    if (asarVersion !== version) die('app.asar reports ' + asarVersion + ', package.json says ' + version);

    const tree = walk(unpacked, '', { dirs: [], files: [] });
    for (const top of fs.readdirSync(unpacked)) {
        if (pu.isProtectedName(top)) die('win-unpacked contains a protected name: ' + top);
    }
    // Check the tree against the SAME rules the client will apply.
    const check = pu.validateEntries(
        tree.dirs.map(n => ({ name: n + '/', isDirectory: true, size: 0 }))
            .concat(tree.files.map(f => ({ name: f.name, isDirectory: false, size: f.size }))));
    if (!check.ok) die(check.error);

    try { fs.unlinkSync(zipPath); } catch (_) {}
    try { fs.unlinkSync(manifestPath); } catch (_) {}

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath, { flags: 'wx' });
        const zip = archiver('zip', { zlib: { level: 9 } });
        out.on('close', resolve);
        out.on('error', reject);
        zip.on('error', reject);
        zip.on('warning', reject);
        zip.pipe(out);
        // Contents at the archive ROOT — the client swaps top-level entries.
        zip.directory(unpacked, false);
        zip.finalize();
    });

    const size = fs.statSync(zipPath).size;
    const hash = crypto.createHash('sha512');
    await new Promise((resolve, reject) => {
        fs.createReadStream(zipPath).on('data', c => hash.update(c)).on('end', resolve).on('error', reject);
    });
    const manifest = {
        kind: pu.MARKER_KIND,
        version,
        file: zipName,
        size,
        unpackedSize: check.totalBytes,
        sha512: hash.digest('base64'),
        exe: EXE,
    };
    // Prove the client will accept what we just wrote.
    pu.parseManifest(manifest, version, EXE);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    console.log('  ok    ' + zipName + ' (' + (size / 1048576).toFixed(1) + ' MB, ' + tree.files.length + ' files, '
        + (check.totalBytes / 1048576).toFixed(1) + ' MB unpacked)');
    console.log('  ok    ' + pu.MANIFEST_NAME + ' (version ' + version + ')');
    console.log('Attach BOTH to the v' + version + ' release, together with latest.yml and the installers.');
})().catch((e) => die(e && e.stack || String(e)));
