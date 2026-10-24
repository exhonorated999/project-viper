/**
 * Old-format video playback + video thumbnails — main process only.
 *
 * VIPER's window (Chromium) plays H.264/VP8/VP9/AV1 video with AAC/MP3/Opus/
 * Vorbis audio in MP4/WebM/MOV/MKV. Evidence from older devices and file-
 * sharing networks is mostly FLV, AVI (Xvid/DivX), WMV, MPG and 3GP, which it
 * cannot decode. This module uses the LGPL ffmpeg shipped in build/ffmpeg
 * (scripts/fetch-ffmpeg.js) to:
 *
 *   prepare()  make a PLAYBACK COPY the window can play, and hand back a
 *              streaming viper-media:// URL for it. The original evidence file
 *              is only ever read. Copies are:
 *                remux      already H.264 / VP8 / VP9 inside — repackaged as
 *                           MP4 / WebM in seconds, picture untouched;
 *                transcode  everything else — H.264 (OpenH264) + AAC MP4.
 *              Copies live in <temp>\viper-video-playback\<pid>\ and are deleted
 *              when VIPER closes (and swept on the next start after a crash).
 *   thumb()    one JPEG frame from ~2 s in (or the first frame), as a data URL.
 *
 * Field Security: an encrypted original is decrypted to the same temp folder
 * only for as long as ffmpeg reads it, then deleted. Locked → refused.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

// Chromium can usually play these itself; VIPER tries the original first and
// offers a converted copy only if the window cannot decode what is inside.
const NATIVE_VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv'];
// Containers the window never plays — always go through a playback copy.
const LEGACY_VIDEO_EXT = ['avi', 'flv', 'f4v', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob',
    '3gp', '3g2', 'ts', 'mts', 'm2ts', 'divx', 'rm', 'rmvb', 'ogm', 'dv', 'mxf'];
const ALL_VIDEO_EXT = NATIVE_VIDEO_EXT.concat(LEGACY_VIDEO_EXT);
// What the warrant importers record as mimeType for these, so the tabs treat
// the file as a video (every tab tests mimeType.startsWith('video/')).
const VIDEO_MIME_BY_EXT = {
    avi: 'video/x-msvideo', divx: 'video/x-msvideo', flv: 'video/x-flv', f4v: 'video/x-f4v',
    wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf', mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg',
    m1v: 'video/mpeg', m2v: 'video/mpeg', vob: 'video/mpeg', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
    ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', rm: 'video/x-pn-realvideo',
    rmvb: 'video/x-pn-realvideo', ogm: 'video/ogg', dv: 'video/x-dv', mxf: 'video/mxf',
    mkv: 'video/x-matroska', ogv: 'video/ogg'
};

/**
 * Old video containers from their first bytes (for files with no or a wrong
 * extension). → { mime, ext } | null. 3GP/3G2 are ISO files: brand '3gp*'/'3g2*'.
 */
function sniffVideo(buf) {
    if (!buf || buf.length < 4) return null;
    const b = buf;
    const ascii = (s, e) => (b.length >= e ? Buffer.from(b.slice(s, e)).toString('latin1') : '');
    const r = (ext) => ({ mime: VIDEO_MIME_BY_EXT[ext], ext });
    if (ascii(0, 3) === 'FLV' && b[3] === 1) return r('flv');
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return r('avi');
    if (b.length >= 8 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75 &&
        b[4] === 0x8E && b[5] === 0x66 && b[6] === 0xCF && b[7] === 0x11) return r('wmv');
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xBA) return r('mpg');
    if (ascii(0, 4) === '.RMF') return r('rm');
    if (ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 11);
        if (brand === '3gp') return r('3gp');
        if (brand === '3g2') return r('3g2');
    }
    return null;
}

const DECRYPT_MAX = 1024 * 1024 * 1024;         // 1 GB, same as warrant-media-url
const THUMB_DECRYPT_MAX = 256 * 1024 * 1024;    // don't decrypt a huge file for a thumbnail
const CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024; // oldest copies dropped past 8 GB
const THUMB_CACHE = 600;
const THUMB_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 20000;
const STALL_MS = 120000;                        // no progress for 2 min → stop
const MAX_LONG_SIDE = 1920;

function extOf(p) {
    const m = /\.([^.\\/]+)$/.exec(String(p || ''));
    return m ? m[1].toLowerCase() : '';
}
function isLegacyVideo(p) { return LEGACY_VIDEO_EXT.indexOf(extOf(p)) !== -1; }
function isVideo(p) { return ALL_VIDEO_EXT.indexOf(extOf(p)) !== -1; }

/** Where the shipped ffmpeg.exe is (packaged: resources\ffmpeg; dev: build\ffmpeg), or ''. */
function locateFfmpeg(o) {
    const fs = o.fs;
    const c = [];
    if (o.resourcesPath) c.push(path.join(o.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    if (o.appDir) c.push(path.join(o.appDir, 'build', 'ffmpeg', 'ffmpeg.exe'));
    for (const p of c) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
    return '';
}

/** `ffmpeg -i <file>` stderr → what is inside. */
function parseProbe(stderr) {
    const s = String(stderr || '');
    const info = { container: '', durationSec: 0, vcodec: '', acodec: '', width: 0, height: 0, fps: 0 };
    const inp = /Input #0,\s*([^\n]*?),\s*from /.exec(s);
    if (inp) info.container = inp[1].trim();
    const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
    if (d) info.durationSec = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
    const re = /Stream #0:\d+[^:\n]*: (Video|Audio): ([^\s,]+)([^\n]*)/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[1] === 'Video') {
            if (info.vcodec || /\(attached pic\)/.test(m[3])) continue;   // cover art is not the video
            info.vcodec = m[2].toLowerCase();
            const wh = /[\s,](\d{2,5})x(\d{2,5})(?=[\s,\]]|$)/.exec(m[3]);
            if (wh) { info.width = +wh[1]; info.height = +wh[2]; }
            const f = /([\d.]+) fps/.exec(m[3]);
            if (f) info.fps = parseFloat(f[1]);
        } else if (!info.acodec) {
            info.acodec = m[2].toLowerCase();
        }
    }
    return info;
}

/**
 * What kind of playback copy this needs.
 * → { mode:'remux'|'transcode', format:'mp4'|'webm' } | { error }
 */
function planFor(info) {
    const v = info.vcodec, a = info.acodec;
    if (!v && !a) return { error: 'No video or sound was found in this file — it may be damaged, or an unfinished download.' };
    if (v === 'h264' && (!a || a === 'aac' || a === 'mp3')) return { mode: 'remux', format: 'mp4' };
    if ((v === 'vp8' || v === 'vp9') && (!a || a === 'opus' || a === 'vorbis')) return { mode: 'remux', format: 'webm' };
    return { mode: 'transcode', format: 'mp4' };
}

/** Bits/s for the H.264 copy — enough that the copy looks like the original. */
function videoBitrate(info) {
    const px = (info.width || 640) * (info.height || 480);
    return Math.max(600000, Math.min(8000000, Math.round(px * 4.5)));
}

function remuxArgs(src, out, plan) {
    return ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-fflags', '+genpts', '-i', src,
        '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy']
        .concat(plan.format === 'mp4' ? ['-movflags', '+faststart'] : [])
        .concat(['-progress', 'pipe:1', '-nostats', '-f', plan.format, out]);
}

function transcodeArgs(src, out, info) {
    const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err', '-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
    if (info.vcodec) {
        a.push('-vf', 'scale=w=trunc(min(' + MAX_LONG_SIDE + '\\,iw)/2)*2:h=-2,format=yuv420p',
            '-c:v', 'libopenh264', '-b:v', String(videoBitrate(info)));
    }
    if (info.acodec) a.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    return a.concat(['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', out]);
}

function thumbArgs(src, seekSec, size) {
    return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(seekSec), '-i', src,
        '-frames:v', '1', '-vf', 'scale=' + size + ':' + size + ':force_original_aspect_ratio=decrease',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'];
}

function frameArgs(src, seekSec, size) {
    return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(seekSec), '-i', src,
        '-frames:v', '1', '-vf', 'scale=' + size + ':' + size + ':force_original_aspect_ratio=decrease',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'];
}

/** A small "at most n at once" gate. */
function gate(n) {
    let active = 0;
    const waiting = [];
    return function run(fn) {
        return new Promise((resolve, reject) => {
            const go = () => {
                active++;
                Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                    active--;
                    if (waiting.length) waiting.shift()();
                });
            };
            if (active < n) go(); else waiting.push(go);
        });
    };
}

function createVideoPlayback(o) {
    const fs = o.fs;
    const spawn = o.spawn;
    const getSecurity = typeof o.getSecurity === 'function' ? o.getSecurity : () => o.security || null;
    const issueToken = o.issueToken;
    const ffmpegPath = typeof o.ffmpegPath === 'function' ? o.ffmpegPath : () => o.ffmpegPath || '';
    const rootDir = o.cacheRoot;                        // <temp>\viper-video-playback
    const pid = o.pid || process.pid;
    const cacheDir = path.join(rootDir, String(pid));
    const procs = new Set();
    const jobs = new Map();                             // cache key → Promise
    const thumbs = new Map();                           // key|size → result
    const convertGate = gate(o.convertJobs || 1);
    const thumbGate = gate(o.thumbJobs || 2);
    let ffCached = null;

    function ff() {
        if (ffCached === null || !ffCached) ffCached = ffmpegPath() || '';
        return ffCached;
    }
    function noEngine() {
        return { success: false, noEngine: true, error: 'The video converter is missing from this copy of VIPER — use Open Externally, or reinstall VIPER.' };
    }
    function locked() {
        return { success: false, locked: true, error: 'This file is protected by Field Security. Unlock Field Security to view it.' };
    }

    /**
     * Absolute path to an existing regular video file, else null.
     * anyExt: the caller already vouched for the file (a path-guarded warrant
     * media file the importer sniffed as video, which may have no extension).
     */
    function checkVideo(filePath, anyExt) {
        if (!filePath || typeof filePath !== 'string' || filePath.indexOf('\0') !== -1) return null;
        if (!path.isAbsolute(filePath)) return null;
        const full = path.resolve(filePath);
        let ext = extOf(full);
        if (ALL_VIDEO_EXT.indexOf(ext) === -1) {
            if (!anyExt) return null;
            if (!/^[a-z0-9]{1,8}$/.test(ext)) ext = 'bin';
        }
        let st;
        try { st = fs.statSync(full); } catch (_) { return null; }
        if (!st.isFile()) return null;
        return { full, ext, size: st.size, mtimeMs: st.mtimeMs };
    }
    function keyOf(chk) {
        return crypto.createHash('sha1').update(chk.full.toLowerCase() + '|' + chk.size + '|' + chk.mtimeMs).digest('hex').slice(0, 24);
    }
    function ensureDir() { fs.mkdirSync(cacheDir, { recursive: true }); }

    function isEncrypted(full) {
        const sec = getSecurity();
        if (!sec || typeof sec.isEncryptedBuffer !== 'function') return false;
        const head = Buffer.alloc(64);
        const fd = fs.openSync(full, 'r');
        let n = 0;
        try { n = fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
        return !!sec.isEncryptedBuffer(head.subarray(0, n));
    }

    /** A path ffmpeg can read: the original, or a short-lived decrypted copy. */
    async function readablePath(chk, key, maxBytes) {
        if (!isEncrypted(chk.full)) return { path: chk.full, done() {} };
        const sec = getSecurity();
        if (!(sec && sec.isUnlocked && sec.isUnlocked())) return { error: locked() };
        if (chk.size > maxBytes) return { error: { success: false, tooLarge: true, error: 'This protected video is too large to convert inside VIPER — use Open Externally.' } };
        ensureDir();
        const tmp = path.join(cacheDir, key + '.' + crypto.randomBytes(4).toString('hex') + '.src.' + chk.ext);
        await fs.promises.writeFile(tmp, sec.decryptBuffer(await fs.promises.readFile(chk.full)));
        return { path: tmp, done() { try { fs.unlinkSync(tmp); } catch (_) {} } };
    }

    /** Run ffmpeg → { code, stderr, stdout(Buffer) }. Never throws. */
    function runFf(args, opt) {
        const op = opt || {};
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(ff(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                return resolve({ code: -1, stderr: String((e && e.message) || e), stdout: Buffer.alloc(0) });
            }
            procs.add(child);
            const out = [];
            let outLen = 0, err = '', lineBuf = '', finished = false, timer = null, stall = null;
            const stdoutMax = op.stdoutMax || 0;
            const finish = (code) => {
                if (finished) return;
                finished = true;
                if (timer) clearTimeout(timer);
                if (stall) clearTimeout(stall);
                procs.delete(child);
                resolve({ code, stderr: err, stdout: Buffer.concat(out), killed: !!child._viperKilled });
            };
            const kill = (why) => { child._viperKilled = why; try { child.kill(); } catch (_) {} };
            if (op.timeoutMs) timer = setTimeout(() => kill('timeout'), op.timeoutMs);
            const bump = () => { if (stall) clearTimeout(stall); stall = setTimeout(() => kill('stalled'), op.stallMs || STALL_MS); };
            if (op.onLine) bump();
            child.stdout.on('data', (b) => {
                if (op.onLine) {
                    bump();
                    lineBuf += b.toString('latin1');
                    let i;
                    while ((i = lineBuf.indexOf('\n')) !== -1) { op.onLine(lineBuf.slice(0, i).trim()); lineBuf = lineBuf.slice(i + 1); }
                } else if (outLen < stdoutMax) {
                    out.push(b); outLen += b.length;
                }
            });
            child.stderr.on('data', (b) => { err = (err + b.toString('utf8')).slice(-16384); });
            child.on('error', (e) => { err += String((e && e.message) || e); finish(-1); });
            child.on('close', (code) => finish(code == null ? -1 : code));
        });
    }

    async function probe(src) {
        // `ffmpeg -i x` with no output always exits 1; the report is on stderr.
        const r = await runFf(['-hide_banner', '-nostdin', '-i', src], { timeoutMs: PROBE_TIMEOUT_MS });
        return parseProbe(r.stderr);
    }

    function existingCopy(key) {
        for (const f of ['mp4', 'webm']) {
            const p = path.join(cacheDir, key + '.' + f);
            try { if (fs.statSync(p).size > 0) return { path: p, format: f }; } catch (_) {}
        }
        return null;
    }

    function pruneCache(keep) {
        let list = [];
        try {
            list = fs.readdirSync(cacheDir).filter(n => /\.(mp4|webm)$/.test(n)).map(n => {
                const p = path.join(cacheDir, n);
                const st = fs.statSync(p);
                return { p, size: st.size, t: st.mtimeMs };
            });
        } catch (_) { return; }
        let total = list.reduce((s, x) => s + x.size, 0);
        list.sort((a, b) => a.t - b.t);
        for (const x of list) {
            if (total <= CACHE_MAX_BYTES) break;
            if (x.p === keep) continue;
            try { fs.unlinkSync(x.p); total -= x.size; } catch (_) {}
        }
    }

    async function convert(chk, key, onProgress) {
        const src = await readablePath(chk, key, DECRYPT_MAX);
        if (src.error) return src.error;
        try {
            const info = await probe(src.path);
            const plan = planFor(info);
            if (plan.error) return { success: false, error: plan.error, info };
            ensureDir();
            const progress = (stage) => (line) => {
                const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
                if (m && info.durationSec > 0 && onProgress) {
                    onProgress({ stage, pct: Math.max(0, Math.min(99, Math.floor(+m[1] / 1e6 / info.durationSec * 100))) });
                }
            };
            const attempt = async (p, args) => {
                const out = path.join(cacheDir, key + '.' + p.format);
                const part = out + '.part';
                if (onProgress) onProgress({ stage: p.mode, pct: 0 });
                const r = await runFf(args(part), { onLine: progress(p.mode), timeoutMs: 15 * 60000 + info.durationSec * 3000 });
                let size = 0;
                try { size = fs.statSync(part).size; } catch (_) {}
                if (r.code === 0 && size > 0) {
                    fs.renameSync(part, out);
                    return { ok: true, out, format: p.format };
                }
                try { fs.unlinkSync(part); } catch (_) {}
                return { ok: false, why: r.killed ? 'The conversion stopped (' + r.killed + ').' : lastErrorLine(r.stderr) };
            };
            let res = null;
            if (plan.mode === 'remux') res = await attempt(plan, (part) => remuxArgs(src.path, part, plan));
            const usedMode = res && res.ok ? 'remux' : 'transcode';
            if (!res || !res.ok) res = await attempt({ mode: 'transcode', format: 'mp4' }, (part) => transcodeArgs(src.path, part, info));
            if (!res.ok) return { success: false, error: 'VIPER could not convert this video. ' + (res.why || ''), info };
            pruneCache(res.out);
            return { success: true, path: res.out, format: res.format, mode: usedMode, info };
        } finally {
            src.done();
        }
    }

    /**
     * { filePath, onProgress } → { success, url, mode:'remux'|'transcode'|'cached', format, from }
     *                          | { success:false, error, locked?, noEngine?, tooLarge? }
     */
    async function prepare(args) {
        const a = args || {};
        try {
            const chk = checkVideo(a.filePath, !!a.anyExt);
            if (!chk) return { success: false, error: 'This file cannot be played here.' };
            if (!ff()) return noEngine();
            const key = keyOf(chk);
            const have = existingCopy(key);
            if (have) {
                try { const t = new Date(); fs.utimesSync(have.path, t, t); } catch (_) {}
                return { success: true, url: 'viper-media://m/' + issueToken(have.path), mode: 'cached', format: have.format, from: chk.ext };
            }
            let job = jobs.get(key);
            if (!job) {
                job = convertGate(() => convert(chk, key, a.onProgress)).finally(() => jobs.delete(key));
                jobs.set(key, job);
            }
            const r = await job;
            if (!r.success) return r;
            return { success: true, url: 'viper-media://m/' + issueToken(r.path), mode: r.mode, format: r.format, from: chk.ext };
        } catch (e) {
            return { success: false, error: (e && e.message) || String(e) };
        }
    }

    /** { filePath, size } → { success, dataUrl } | { success:false, reason, error? } */
    async function thumb(args) {
        const a = args || {};
        try {
            const chk = checkVideo(a.filePath, !!a.anyExt);
            if (!chk) return { success: false, reason: 'not-video' };
            if (chk.size === 0) return { success: false, reason: 'undecodable', sniff: 'empty' };
            if (!ff()) return Object.assign(noEngine(), { reason: 'no-engine' });
            const size = Math.max(64, Math.min(512, parseInt(a.size, 10) || 320));
            const key = keyOf(chk);
            const ck = key + '|' + size;
            if (thumbs.has(ck)) return thumbs.get(ck);
            const res = await thumbGate(async () => {
                const src = await readablePath(chk, key, THUMB_DECRYPT_MAX);
                if (src.error) return Object.assign(src.error, { reason: src.error.locked ? 'locked' : 'too-large' });
                try {
                    for (const seek of [2, 0]) {
                        const r = await runFf(thumbArgs(src.path, seek, size), { timeoutMs: THUMB_TIMEOUT_MS, stdoutMax: 4 * 1024 * 1024 });
                        const b = r.stdout;
                        if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) {
                            return { success: true, dataUrl: 'data:image/jpeg;base64,' + b.toString('base64'), video: true };
                        }
                    }
                    return { success: false, reason: 'undecodable', video: true, error: 'VIPER could not read a picture from this video — it may be damaged, or an unfinished download.' };
                } finally {
                    src.done();
                }
            });
            if (res.success || res.reason === 'undecodable') {
                if (thumbs.size >= THUMB_CACHE) thumbs.delete(thumbs.keys().next().value);
                thumbs.set(ck, res);
            }
            return res;
        } catch (e) {
            return { success: false, reason: 'error', error: (e && e.message) || String(e) };
        }
    }

    /**
     * One still from an exact point in the ORIGINAL file (no canvas, so no
     * tainted-canvas problem with viper-media:// playback).
     * { filePath, atSec, size } → { success, dataUrl, atSec } | { success:false, reason, error? }
     */
    async function frame(args) {
        const a = args || {};
        try {
            const chk = checkVideo(a.filePath, !!a.anyExt);
            if (!chk) return { success: false, reason: 'not-video', error: 'This file cannot be read here.' };
            if (!ff()) return Object.assign(noEngine(), { reason: 'no-engine' });
            const size = Math.max(64, Math.min(1920, parseInt(a.size, 10) || 960));
            const at = Math.max(0, Number(a.atSec) || 0);
            const key = keyOf(chk);
            return await thumbGate(async () => {
                const src = await readablePath(chk, key, DECRYPT_MAX);
                if (src.error) return Object.assign(src.error, { reason: src.error.locked ? 'locked' : 'too-large' });
                try {
                    // Input seeking re-decodes to the exact frame; step back a hair
                    // if the very end of the file yields nothing.
                    for (const seek of [at, Math.max(0, at - 0.5)]) {
                        const r = await runFf(frameArgs(src.path, seek, size), { timeoutMs: THUMB_TIMEOUT_MS * 2, stdoutMax: 12 * 1024 * 1024 });
                        const b = r.stdout;
                        if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) {
                            return { success: true, dataUrl: 'data:image/jpeg;base64,' + b.toString('base64'), atSec: seek };
                        }
                    }
                    return { success: false, reason: 'undecodable', error: 'VIPER could not read a picture at that point in the video.' };
                } finally {
                    src.done();
                }
            });
        } catch (e) {
            return { success: false, reason: 'error', error: (e && e.message) || String(e) };
        }
    }

    /** Remove this run's copies and any left by a VIPER that crashed. */
    function sweep() {
        let names = [];
        try { names = fs.readdirSync(rootDir); } catch (_) { return; }
        for (const n of names) {
            if (n === String(pid)) continue;
            if (/^\d+$/.test(n) && o.isPidAlive && o.isPidAlive(+n)) continue;   // another VIPER (portable + installed)
            try { fs.rmSync(path.join(rootDir, n), { recursive: true, force: true }); } catch (_) {}
        }
    }
    function dispose() {
        for (const c of procs) { try { c.kill(); } catch (_) {} }
        procs.clear();
        thumbs.clear();
        try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    }

    return { prepare, thumb, frame, probe, sweep, dispose, available: () => !!ff(), _cacheDir: cacheDir };
}

function lastErrorLine(stderr) {
    const lines = String(stderr || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

module.exports = {
    createVideoPlayback, locateFfmpeg, parseProbe, planFor, videoBitrate,
    remuxArgs, transcodeArgs, thumbArgs, frameArgs, isLegacyVideo, isVideo, extOf,
    NATIVE_VIDEO_EXT, LEGACY_VIDEO_EXT, ALL_VIDEO_EXT, VIDEO_MIME_BY_EXT, sniffVideo,
};
