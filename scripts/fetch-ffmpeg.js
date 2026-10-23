#!/usr/bin/env node
/**
 * Put the LGPL ffmpeg that VIPER ships into build/ffmpeg/.
 *
 * VIPER plays old evidence video (FLV, AVI, WMV, MPG, 3GP …) by making a
 * playback copy with ffmpeg, and makes video thumbnails with it. build/ is
 * not in git, so run this once on the build machine before `npm run package`
 * (scripts/verify-package.js fails the package if ffmpeg is missing).
 *
 * Build: BtbN FFmpeg-Builds "win64-lgpl-shared" (release branch). LGPL only —
 * no x264/x265/GPL parts. Shared = ffmpeg.exe + its DLLs, so the LGPL
 * libraries stay replaceable. H.264 encoding uses OpenH264 (BSD).
 *
 *   node scripts\fetch-ffmpeg.js                 download + install
 *   node scripts\fetch-ffmpeg.js --zip <file>    install from a zip you already have
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BRANCH = '8.1';
const ASSET = 'ffmpeg-n' + BRANCH + '-latest-win64-lgpl-shared-' + BRANCH + '.zip';
const URL_ = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/' + ASSET;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'ffmpeg');

function download(url, dest, hops) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'viper-build' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if ((hops || 0) > 5) return reject(new Error('too many redirects'));
                return resolve(download(res.headers.location, dest, (hops || 0) + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const f = fs.createWriteStream(dest);
            res.pipe(f);
            f.on('finish', () => f.close(resolve));
            f.on('error', reject);
        }).on('error', reject);
    });
}

async function main() {
    const i = process.argv.indexOf('--zip');
    let zipPath = i > 0 ? path.resolve(process.argv[i + 1]) : '';
    if (!zipPath) {
        zipPath = path.join(require('os').tmpdir(), ASSET);
        console.log('Downloading ' + URL_);
        await download(URL_, zipPath);
    }
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const want = entries.filter(e => !e.isDirectory && /\/bin\/(ffmpeg\.exe|[^/]+\.dll)$/i.test(e.entryName));
    const lic = entries.find(e => /^[^/]+\/LICENSE\.txt$/i.test(e.entryName));
    if (!want.some(e => /ffmpeg\.exe$/i.test(e.entryName)) || !lic) throw new Error('zip does not look like a BtbN ffmpeg build');
    fs.mkdirSync(OUT, { recursive: true });
    for (const name of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, name));
    for (const e of want) fs.writeFileSync(path.join(OUT, path.basename(e.entryName)), e.getData());
    // No .txt / .md: electron-builder.yml excludes those patterns.
    fs.writeFileSync(path.join(OUT, 'LICENSE'), lic.getData());
    const exe = path.join(OUT, 'ffmpeg.exe');
    const version = execFileSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
    const encoders = execFileSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    for (const enc of ['libopenh264', 'aac', 'mjpeg']) {
        if (!new RegExp('\\s' + enc + '\\s').test(encoders)) throw new Error('this ffmpeg has no ' + enc + ' encoder');
    }
    const cfg = execFileSync(exe, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
    if (/--enable-gpl|--enable-nonfree/.test(cfg)) throw new Error('this ffmpeg is a GPL/nonfree build — VIPER ships LGPL only');
    const files = fs.readdirSync(OUT).filter(n => /\.(exe|dll)$/i.test(n)).sort();
    const sha = {};
    for (const n of files) sha[n] = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, n))).digest('hex');
    fs.writeFileSync(path.join(OUT, 'NOTICE'), [
        'FFmpeg — used by V.I.P.E.R. to play older video formats and make video thumbnails.',
        '',
        version,
        'Build: BtbN FFmpeg-Builds, ' + ASSET + ' (LGPL, shared libraries, unmodified).',
        'FFmpeg is licensed under the GNU Lesser General Public License (see LICENSE).',
        'Source code: https://ffmpeg.org/download.html  ·  build scripts: https://github.com/BtbN/FFmpeg-Builds',
        'The FFmpeg libraries are the separate .dll files in this folder and may be replaced.',
        'H.264 encoding uses Cisco OpenH264 (BSD licence).',
        '',
    ].join('\r\n'));
    fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ asset: ASSET, version, files: sha }, null, 2));
    const mb = files.reduce((a, n) => a + fs.statSync(path.join(OUT, n)).size, 0) / 1048576;
    console.log('Installed ' + version + ' → build\\ffmpeg (' + files.length + ' files, ' + mb.toFixed(1) + ' MB)');
}

main().catch((e) => { console.error('fetch-ffmpeg FAILED: ' + e.message); process.exit(1); });
