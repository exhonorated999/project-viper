/**
 * Old-format video playback + video thumbnails — modules/_shared/video-playback.js,
 * its wiring (electron-main / preload / evidence-view / packaging) and the
 * Evidence tab renderer pieces LIFTED from case-detail-with-analytics.html.
 *
 * Why: a BitTorrent case had 159 videos; 147 (FLV, AVI, WMV, MPG, 3GP) would
 * not play in VIPER and had no thumbnails — the window cannot decode them.
 *
 * The integration half runs the real shipped ffmpeg on SYNTHETIC test clips
 * (lavfi test pattern) when build\ffmpeg\ffmpeg.exe is present
 * (node scripts\fetch-ffmpeg.js); otherwise it is skipped and says so.
 *
 * Run: node modules\_shared\__tests__\video-playback.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const VP = require('../video-playback');
const EV = require('../evidence-view');
const rd = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = rd('electron-main.js');
const PRELOAD = rd('preload.js');
const CD = rd('case-detail-with-analytics.html');
const YML = rd('electron-builder.yml');
const VERIFY = rd('scripts/verify-package.js');
const FF = path.join(REPO, 'build', 'ffmpeg', 'ffmpeg.exe');
const HAVE_FF = fs.existsSync(FF);

let passed = 0, failed = 0, skipped = 0;
async function ok(label, fn) {
    try { await fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-vp-'));
const MAGIC = Buffer.from('VIPENC');
function vault(unlocked) {
    return {
        isUnlocked: () => unlocked,
        isEncryptedBuffer: (b) => b.length >= 6 && b.subarray(0, 6).equals(MAGIC),
        decryptBuffer: (b) => b.subarray(6),
    };
}

// ── lift a renderer function by name (brace matched, strings/templates aware enough for this file) ──
function lift(src, name) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    const m = re.exec(src);
    if (!m) throw new Error('function not found: ' + name);
    let i = src.indexOf('{', m.index), depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
    }
    throw new Error('unbalanced: ' + name);
}
function constBlock(src, name) {
    const i = src.indexOf('const ' + name + ' = ');
    if (i < 0) throw new Error('const not found: ' + name);
    const open = src[src.indexOf('=', i) + 2];
    const close = open === '{' ? '}' : open === '[' ? ']' : ';';
    let j = src.indexOf(open, i), depth = 0;
    for (; j < src.length; j++) {
        if (src[j] === open) depth++;
        else if (src[j] === close) { depth--; if (depth === 0) break; }
    }
    return src.slice(i, j + 1) + ';';
}

const SAMPLE_FLV = `Input #0, flv, from 'C:\\x\\a.flv':
  Duration: 00:01:23.50, start: 0.000000, bitrate: 633 kb/s
  Stream #0:0: Video: flv1 (flv), yuv420p, 640x480, 200 kb/s, 25 fps, 25 tbr, 1k tbn
  Stream #0:1: Audio: adpcm_swf, 22050 Hz, mono, s16, 88 kb/s
At least one output file must be specified`;
const SAMPLE_MP4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'b.mp4':
  Duration: 01:02:03.25, start: 0.000000, bitrate: 444 kb/s
  Stream #0:0[0x1](und): Video: mjpeg (Baseline), yuvj420p(pc), 300x300, 90k tbr, 90k tbn (attached pic)
  Stream #0:1[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 1500 kb/s, 29.97 fps, 29.97 tbr
  Stream #0:2[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`;

(async () => {
    console.log('video-playback — unit');

    await ok('parseProbe reads container, duration, codecs, size, fps (FLV)', () => {
        const p = VP.parseProbe(SAMPLE_FLV);
        assert.deepStrictEqual(p, { container: 'flv', durationSec: 83.5, vcodec: 'flv1', acodec: 'adpcm_swf', width: 640, height: 480, fps: 25 });
    });
    await ok('parseProbe skips cover art ("attached pic") for the real video stream', () => {
        const p = VP.parseProbe(SAMPLE_MP4);
        assert.strictEqual(p.vcodec, 'h264');
        assert.strictEqual(p.width, 1280); assert.strictEqual(p.height, 720);
        assert.strictEqual(p.acodec, 'aac');
        assert.strictEqual(Math.round(p.durationSec), 3723);
    });
    await ok('parseProbe on garbage / empty → no codecs', () => {
        const p = VP.parseProbe('x.bin: Invalid data found when processing input');
        assert.strictEqual(p.vcodec, ''); assert.strictEqual(p.acodec, ''); assert.strictEqual(p.durationSec, 0);
        assert.strictEqual(VP.parseProbe(undefined).vcodec, '');
    });
    await ok('planFor: H.264+AAC/MP3 → remux MP4; VP8/VP9+Opus/Vorbis → remux WebM; old codecs → transcode', () => {
        assert.deepStrictEqual(VP.planFor({ vcodec: 'h264', acodec: 'aac' }), { mode: 'remux', format: 'mp4' });
        assert.deepStrictEqual(VP.planFor({ vcodec: 'h264', acodec: 'mp3' }), { mode: 'remux', format: 'mp4' });
        assert.deepStrictEqual(VP.planFor({ vcodec: 'h264', acodec: '' }), { mode: 'remux', format: 'mp4' });
        assert.deepStrictEqual(VP.planFor({ vcodec: 'vp9', acodec: 'opus' }), { mode: 'remux', format: 'webm' });
        for (const v of ['flv1', 'mpeg4', 'msmpeg4v3', 'wmv2', 'wmv3', 'mpeg1video', 'mpeg2video', 'h263', 'hevc', 'vp6f'])
            assert.strictEqual(VP.planFor({ vcodec: v, acodec: 'aac' }).mode, 'transcode', v);
        assert.strictEqual(VP.planFor({ vcodec: 'h264', acodec: 'wmav2' }).mode, 'transcode');
        assert.strictEqual(VP.planFor({ vcodec: '', acodec: 'wmav2' }).mode, 'transcode');   // sound only
        assert.ok(VP.planFor({ vcodec: '', acodec: '' }).error);
    });
    await ok('transcode uses OpenH264 + AAC MP4 (LGPL) — never x264/x265; caps size; faststart; progress', () => {
        const a = VP.transcodeArgs('in.avi', 'out.part', { vcodec: 'mpeg4', acodec: 'mp3', width: 640, height: 480 });
        const s = a.join(' ');
        assert.ok(/-c:v libopenh264/.test(s) && /-c:a aac/.test(s));
        assert.ok(!/x264|x265|nonfree/.test(s));
        assert.ok(/min\(1920\\,iw\)/.test(s) && /format=yuv420p/.test(s));
        assert.ok(/\+faststart/.test(s) && /-progress pipe:1/.test(s));
        assert.deepStrictEqual(a.slice(-3), ['-f', 'mp4', 'out.part']);
        assert.strictEqual(a[a.indexOf('-i') + 1], 'in.avi');
        const audioOnly = VP.transcodeArgs('in.wma', 'o', { vcodec: '', acodec: 'wmav2' }).join(' ');
        assert.ok(!/libopenh264/.test(audioOnly) && /-c:a aac/.test(audioOnly));
    });
    await ok('remux copies streams untouched', () => {
        const s = VP.remuxArgs('in.flv', 'o', { mode: 'remux', format: 'mp4' }).join(' ');
        assert.ok(/-c copy/.test(s) && !/libopenh264/.test(s) && /-f mp4 o$/.test(s));
        assert.ok(!/faststart/.test(VP.remuxArgs('i', 'o', { mode: 'remux', format: 'webm' }).join(' ')));
    });
    await ok('videoBitrate scales with picture size, clamped 0.6–8 Mb/s', () => {
        assert.strictEqual(VP.videoBitrate({ width: 160, height: 120 }), 600000);
        assert.strictEqual(VP.videoBitrate({ width: 640, height: 480 }), 1382400);
        assert.strictEqual(VP.videoBitrate({ width: 3840, height: 2160 }), 8000000);
    });
    await ok('legacy list covers the case formats (flv avi wmv mpg 3gp) and not the playable ones', () => {
        for (const x of ['a.flv', 'b.AVI', 'c.wmv', 'd.mpg', 'e.3gp', 'f.mpeg', 'g.asf', 'h.vob', 'i.m2ts']) assert.ok(VP.isLegacyVideo(x), x);
        for (const x of ['a.mp4', 'b.mov', 'c.webm', 'd.mkv', 'e.m4v', 'f.jpg']) assert.ok(!VP.isLegacyVideo(x), x);
        assert.ok(VP.isVideo('x.mkv') && !VP.isVideo('x.jpg'));
    });
    await ok('locateFfmpeg: packaged resources\\ffmpeg first, then dev build\\ffmpeg, else ""', () => {
        const have = new Set();
        const ffs = { statSync: (p) => { if (!have.has(p)) throw new Error('ENOENT'); return { isFile: () => true }; } };
        const res = path.join('R', 'ffmpeg', 'ffmpeg.exe'), dev = path.join('A', 'build', 'ffmpeg', 'ffmpeg.exe');
        assert.strictEqual(VP.locateFfmpeg({ fs: ffs, resourcesPath: 'R', appDir: 'A' }), '');
        have.add(dev);
        assert.strictEqual(VP.locateFfmpeg({ fs: ffs, resourcesPath: 'R', appDir: 'A' }), dev);
        have.add(res);
        assert.strictEqual(VP.locateFfmpeg({ fs: ffs, resourcesPath: 'R', appDir: 'A' }), res);
    });
    await ok('prepare refuses non-video / relative / missing paths; no ffmpeg → noEngine (no spawn)', async () => {
        let spawned = 0;
        const v = VP.createVideoPlayback({ fs, spawn: () => { spawned++; throw new Error('x'); }, ffmpegPath: () => '', cacheRoot: path.join(TMP, 'c0'), issueToken: () => 't' });
        const txt = path.join(TMP, 'a.txt'); fs.writeFileSync(txt, 'x');
        const flv = path.join(TMP, 'a.flv'); fs.writeFileSync(flv, 'x');
        assert.strictEqual((await v.prepare({ filePath: txt })).success, false);
        assert.strictEqual((await v.prepare({ filePath: 'a.flv' })).success, false);
        assert.strictEqual((await v.prepare({ filePath: path.join(TMP, 'nope.flv') })).success, false);
        assert.strictEqual((await v.prepare({ filePath: flv + '\0.flv' })).success, false);
        const r = await v.prepare({ filePath: flv });
        assert.ok(r.noEngine && /Open Externally/.test(r.error));
        const t = await v.thumb({ filePath: flv });
        assert.strictEqual(t.reason, 'no-engine');
        assert.strictEqual(spawned, 0);
    });
    await ok('sweep removes copies left by a crashed VIPER, keeps a running one and this run', () => {
        const root = path.join(TMP, 'sweep');
        for (const d of ['111', '222', String(process.pid), 'junk']) { fs.mkdirSync(path.join(root, d), { recursive: true }); fs.writeFileSync(path.join(root, d, 'x.mp4'), 'x'); }
        const v = VP.createVideoPlayback({ fs, spawn: cp.spawn, ffmpegPath: '', cacheRoot: root, issueToken: () => 't', isPidAlive: (p) => p === 222 });
        v.sweep();
        assert.deepStrictEqual(fs.readdirSync(root).sort(), ['222', String(process.pid)].sort());
        v.dispose();
        assert.ok(!fs.existsSync(path.join(root, String(process.pid))));
    });

    console.log('evidence-view — videos');
    await ok('Evidence viewer accepts the old video formats', () => {
        for (const x of ['flv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp', 'mp4', 'mov', 'mkv']) assert.ok(EV.VIDEO_EXT.includes(x), x);
    });
    await ok('evidence thumb() sends videos to videoThumb with the resolved path; images unchanged', async () => {
        const flv = path.join(TMP, 'clip.flv'); fs.writeFileSync(flv, 'x');
        const calls = [];
        const view = EV.createEvidenceView({ fs, nativeImage: {}, issueToken: () => 't', videoThumb: async (a) => { calls.push(a); return { success: true, dataUrl: 'data:image/jpeg;base64,AA', video: true }; } });
        const r = await view.thumb({ filePath: flv, size: 320 });
        assert.ok(r.success && r.video);
        assert.deepStrictEqual(calls, [{ filePath: path.resolve(flv), size: 320 }]);
        const txt = path.join(TMP, 'x.flv.txt'); fs.writeFileSync(txt, 'x');
        assert.strictEqual((await view.thumb({ filePath: txt })).reason, 'not-image');
        const noHook = EV.createEvidenceView({ fs, nativeImage: {}, issueToken: () => 't' });
        assert.strictEqual((await noHook.thumb({ filePath: flv })).reason, 'not-image');
    });
    await ok('REGRESSION: Field Security made AFTER the view is still used (getter, not a snapshot)', async () => {
        // electron-main creates the view at load; `security` is assigned later in whenReady.
        let security = null;
        const p = path.join(TMP, 'sealed.mp4');
        fs.writeFileSync(p, Buffer.concat([MAGIC, Buffer.from('plain-bytes')]));
        const view = EV.createEvidenceView({ fs, getSecurity: () => security, nativeImage: {}, issueToken: () => 'tok' });
        security = vault(false);
        const locked = await view.mediaUrl({ filePath: p });
        assert.ok(locked.locked, 'locked vault must be honoured');
        security = vault(true);
        const r = await view.mediaUrl({ filePath: p });
        assert.ok(r.success && Buffer.from(r.bytes).toString() === 'plain-bytes');
        // the old snapshot behaviour: security captured as null → encrypted file streamed raw
        const snap = EV.createEvidenceView({ fs, security: null, nativeImage: {}, issueToken: () => 'tok' });
        assert.ok((await snap.mediaUrl({ filePath: p })).url, 'documented: a null snapshot streams the ciphertext');
    });

    console.log('wiring');
    await ok('electron-main: video-playback IPC with progress, sweep at start, dispose at quit, ffmpeg located', () => {
        assert.ok(/require\('\.\/modules\/_shared\/video-playback'\)/.test(MAIN));
        assert.ok(/ipcMain\.handle\('video-playback-url'/.test(MAIN));
        assert.ok(/sender\.send\('video-playback-progress'/.test(MAIN));
        assert.ok(/_videoPlayback\.sweep\(\)/.test(MAIN) && /will-quit[^\n]*_videoPlayback\.dispose\(\)/.test(MAIN));
        assert.ok(/getSecurity: \(\) => security/.test(MAIN));
        assert.ok(/locateFfmpeg\(\{ fs, resourcesPath: app\.isPackaged \? process\.resourcesPath : ''/.test(MAIN));
    });
    await ok('electron-main: Evidence view gets Field Security through a getter + videoThumb', () => {
        const blk = MAIN.slice(MAIN.indexOf("const _evidenceView = require('./modules/_shared/evidence-view')"));
        const head = blk.slice(0, blk.indexOf('});'));
        assert.ok(/getSecurity: \(\) => security/.test(head), head);
        assert.ok(!/\bfs, security,/.test(head));
        assert.ok(/videoThumb: \(a\) => _videoPlayback\.thumb\(a\)/.test(head));
    });
    await ok('preload exposes videoPlaybackUrl + onVideoPlaybackProgress (with unsubscribe)', () => {
        assert.ok(/videoPlaybackUrl: \(args\) => ipcRenderer\.invoke\('video-playback-url', args\)/.test(PRELOAD));
        assert.ok(/ipcRenderer\.on\('video-playback-progress', handler\)/.test(PRELOAD));
        assert.ok(/removeListener\('video-playback-progress', handler\)/.test(PRELOAD));
    });
    await ok('packaging: build/ffmpeg → resources/ffmpeg; verify-package checks it runs and is LGPL', () => {
        assert.ok(/extraResources:\n\s+- from: build\/ffmpeg\n\s+to: ffmpeg/.test(YML));
        assert.ok(/resources', 'ffmpeg'/.test(VERIFY) && /--enable-gpl\|--enable-nonfree/.test(VERIFY) && /libopenh264/.test(VERIFY));
        assert.ok(/video-playback\.js/.test(VERIFY));
        assert.ok(fs.existsSync(path.join(REPO, 'scripts', 'fetch-ffmpeg.js')));
    });

    console.log('Evidence tab renderer (lifted)');
    const sb = { window: null, document: {}, console };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext([
        constBlock(CD, 'EV_FV_EXT'), constBlock(CD, 'EV_FV_LEGACY_VIDEO'), constBlock(CD, 'EV_FV_SLOT_H'), constBlock(CD, 'EV_FV_ICON'),
        'const EV_FV_GRID_MIN_IMAGES = 100; var _evFv = null; const _S = "src";',
        'function _evEsc(s){return String(s==null?"":s).replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]));}',
        ...['_evFvExt', '_evFvKind', '_evFvPlan', '_evFvIsLegacyVideo', '_evFvCanConvert', '_evFvConvertHtml', '_evFvPlayerHtml', '_evFvTileHtml', '_evFvMediaHtml']
            .map(n => lift(CD, n)),
        'function _evFvDirectUrl(){return "";} function formatFileSize(n){return n+" B";}',
    ].join('\n'), sb);

    await ok('renderer legacy list = main legacy list (no drift)', () => {
        const legacy = vm.runInContext('EV_FV_LEGACY_VIDEO', sb), vids = vm.runInContext('EV_FV_EXT.video', sb);
        assert.deepStrictEqual(Array.from(legacy).sort(), VP.LEGACY_VIDEO_EXT.slice().sort());
        for (const x of VP.ALL_VIDEO_EXT) assert.ok(vids.includes(x), x);
    });
    await ok('a folder of 159 videos opens as a thumbnail grid (videos count, not just images)', () => {
        const files = [];
        for (let i = 0; i < 159; i++) files.push({ name: 'v' + i + ['.flv', '.avi', '.wmv', '.mpg', '.3gp', '.mp4'][i % 6], path: 'C:\\x\\' + i });
        const p = sb._evFvPlan(files);
        assert.strictEqual(p.mode, 'grid'); assert.strictEqual(p.videos, 159); assert.strictEqual(p.images, 0);
        assert.strictEqual(sb._evFvPlan(files.slice(0, 20)).mode, 'list');
    });
    await ok('video tiles ask for a thumbnail when on disk; not for web-only videos', () => {
        assert.ok(/data-ev-kind="thumb"/.test(sb._evFvTileHtml({ name: 'a.flv', path: 'C:\\a.flv', size: 1 }, 0)));
        assert.ok(/data-ev-kind="icon"/.test(sb._evFvTileHtml({ name: 'a.flv', url: 'https://x/a.flv', size: 1 }, 0)));
    });
    await ok('convert panel: Play button, escaped name/ext, says the original is not changed', () => {
        const h = sb._evFvConvertHtml({ name: 'a.flv"><img onerror=1>.flv' });
        assert.ok(/_evFvConvert\(this, true\)/.test(h) && /▶ Play in VIPER/.test(h));
        assert.ok(/FLV video/.test(h) && /original file is not changed/.test(h));
        assert.ok(!/<img onerror/.test(h));
    });
    await ok('player after conversion explains it is a copy; native <video> falls back on error / no picture', () => {
        const h = sb._evFvPlayerHtml('viper-media://m/abc', { mode: 'transcode', format: 'mp4', from: 'flv' }, true);
        assert.ok(/autoplay/.test(h) && /FLV converted to MP4/.test(h) && /original evidence file is unchanged/.test(h));
        assert.ok(/repackaged/.test(sb._evFvPlayerHtml('u', { mode: 'remux', format: 'mp4', from: 'flv' }, false)));
        assert.ok(!/autoplay/.test(sb._evFvPlayerHtml('u', { mode: 'cached', format: 'mp4', from: 'avi' }, false)));
        const v = sb._evFvMediaHtml('video', 'viper-media://m/x', { name: 'a.mp4' });
        assert.ok(/onerror="_evFvVideoFail\(this\)"/.test(v) && /onloadedmetadata="_evFvVideoMeta\(this\)"/.test(v));
    });
    await ok('hydrate: legacy video never fetches the original — panel + poster, or the cached copy', () => {
        const h = lift(CD, '_evFvHydrate');
        const legacy = h.indexOf('_evFvIsLegacyVideo(file)'), media = h.indexOf('evidenceMediaUrl');
        assert.ok(legacy > 0 && media > legacy, 'legacy branch must come before evidenceMediaUrl');
        assert.ok(/_evFv\.converted\.has\(file\.path\)/.test(h) && /_evFvPoster\(slot, file\)/.test(h));
        const d = lift(CD, '_evFvDehydrate');
        assert.ok(/if \(slot\._evConvJob\) return;/.test(d), 'scrolling away must not wipe a running conversion');
    });
    await ok('convert: progress listener registered once; stale result ignored after scroll/page change', () => {
        const c = lift(CD, '_evFvConvert');
        assert.ok(/if \(!_evFvConvOff && api\.onVideoPlaybackProgress\)/.test(c));
        assert.ok(/if \(slot\._evConvJob !== jobId\) return;/.test(c));
        assert.ok(/fv\.converted\.add\(file\.path\)/.test(c));
    });
    await ok('grid thumbnails: video tiles get ▶ + format badge, blur still applies, failures keep the film icon', () => {
        const p = lift(CD, '_evFvPaintThumb');
        assert.ok(/ev-fv-play/.test(p) && /_evFv\.blur \? 'filter:blur\(14px\);'/.test(p) && /EV_FV_ICON\.video/.test(p));
        const mk = lift(CD, '_evFvMakeThumb');
        assert.ok(/_evFvKind\(file\) === 'image' \? _evFvDirectUrl\(file\) : ''/.test(mk), 'a web URL of a video is not an <img>');
    });

    console.log('integration (real ffmpeg, synthetic clips)');
    if (!HAVE_FF) {
        console.log('  SKIP  build\\ffmpeg\\ffmpeg.exe not present — run node scripts\\fetch-ffmpeg.js');
        skipped++;
    } else {
        const clipDir = path.join(TMP, 'clips');
        fs.mkdirSync(clipDir);
        const SRC = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
        const make = (name, codec) => {
            const out = path.join(clipDir, name);
            cp.execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', ...SRC, ...codec, '-shortest', out]);
            return out;
        };
        const clips = {
            flv: make('a.flv', ['-c:v', 'flv', '-c:a', 'adpcm_swf', '-ar', '22050']),
            avi: make('b.avi', ['-c:v', 'mpeg4', '-vtag', 'XVID', '-c:a', 'libmp3lame']),
            wmv: make('c.wmv', ['-c:v', 'wmv2', '-c:a', 'wmav2']),
            mpg: make('d.mpg', ['-c:v', 'mpeg1video', '-c:a', 'mp2']),
            '3gp': make('e.3gp', ['-s', '176x144', '-c:v', 'h263', '-c:a', 'aac', '-ar', '8000', '-ac', '1']),
            h264flv: make('f.flv', ['-c:v', 'libopenh264', '-c:a', 'aac']),
        };
        const tokens = [];
        const progress = [];
        const mk = (extra) => VP.createVideoPlayback(Object.assign({
            fs, spawn: cp.spawn, ffmpegPath: () => FF, cacheRoot: path.join(TMP, 'cache'), pid: 4242,
            issueToken: (p) => { tokens.push(p); return 'tok' + tokens.length; },
        }, extra || {}));
        const vpb = mk();
        const probeOut = (p) => VP.parseProbe(cp.spawnSync(FF, ['-hide_banner', '-i', p], { encoding: 'utf8' }).stderr);

        for (const k of ['flv', 'avi', 'wmv', 'mpg', '3gp']) {
            await ok(k.toUpperCase() + ' → playable H.264/AAC MP4 copy; original untouched', async () => {
                const before = fs.readFileSync(clips[k]);
                const r = await vpb.prepare({ filePath: clips[k], onProgress: (p) => progress.push(p) });
                assert.ok(r.success, JSON.stringify(r));
                assert.strictEqual(r.mode, 'transcode'); assert.strictEqual(r.format, 'mp4'); assert.strictEqual(r.from, k);
                assert.ok(/^viper-media:\/\/m\/tok\d+$/.test(r.url));
                const out = tokens[tokens.length - 1];
                assert.ok(out.startsWith(vpb._cacheDir) && out.endsWith('.mp4'));
                const info = probeOut(out);
                assert.strictEqual(info.vcodec, 'h264'); assert.strictEqual(info.acodec, 'aac');
                assert.ok(Math.abs(info.durationSec - 4) < 0.6, 'duration ' + info.durationSec);
                assert.ok(before.equals(fs.readFileSync(clips[k])), 'original changed');
            });
        }
        await ok('progress reported during conversion', () => {
            assert.ok(progress.some(p => p.stage === 'transcode' && p.pct > 0), JSON.stringify(progress.slice(0, 5)));
            assert.ok(progress.every(p => p.pct >= 0 && p.pct <= 99));
        });
        await ok('H.264 inside FLV is repackaged (remux), not re-encoded', async () => {
            const r = await vpb.prepare({ filePath: clips.h264flv });
            assert.ok(r.success && r.mode === 'remux' && r.format === 'mp4', JSON.stringify(r));
        });
        await ok('second open is instant from the copy (mode cached), no new files', async () => {
            const n = fs.readdirSync(vpb._cacheDir).length;
            const t = Date.now();
            const r = await vpb.prepare({ filePath: clips.flv });
            assert.ok(r.success && r.mode === 'cached'); assert.ok(Date.now() - t < 500);
            assert.strictEqual(fs.readdirSync(vpb._cacheDir).length, n);
            assert.ok(!fs.readdirSync(vpb._cacheDir).some(f => /\.part$|\.src\./.test(f)), 'no leftovers');
        });
        await ok('the same file opened twice at once converts once', async () => {
            const copy = path.join(clipDir, 'twice.avi'); fs.copyFileSync(clips.avi, copy);
            let spawns = 0;
            const v2 = mk({ pid: 4243, spawn: (...a) => { spawns++; return cp.spawn(...a); } });
            const t0 = tokens.length;
            const [a, b] = await Promise.all([v2.prepare({ filePath: copy }), v2.prepare({ filePath: copy })]);
            assert.ok(a.success && b.success, JSON.stringify([a, b]));
            assert.strictEqual(tokens.length - t0, 2); assert.strictEqual(tokens[t0], tokens[t0 + 1], 'both play the same copy');
            assert.strictEqual(spawns, 2, 'probe + one conversion');   // not 4
            v2.dispose();
        });
        await ok('thumbnails: a JPEG frame for every old format', async () => {
            for (const k of Object.keys(clips)) {
                const t = await vpb.thumb({ filePath: clips[k], size: 200 });
                assert.ok(t.success && /^data:image\/jpeg;base64,\/9j\//.test(t.dataUrl), k + ' ' + JSON.stringify(t).slice(0, 200));
            }
        });
        await ok('thumbnail of a clip shorter than 2 s falls back to the first frame', async () => {
            const short = path.join(clipDir, 'short.wmv');
            cp.execFileSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'wmv2', short]);
            const t = await vpb.thumb({ filePath: short });
            assert.ok(t.success, JSON.stringify(t));
        });
        await ok('damaged file: clear error, no copy, thumbnail says undecodable', async () => {
            const bad = path.join(clipDir, 'bad.avi'); fs.writeFileSync(bad, Buffer.alloc(5000, 0x41));
            const r = await vpb.prepare({ filePath: bad });
            assert.ok(!r.success && /damaged|unfinished|could not/i.test(r.error), JSON.stringify(r));
            const t = await vpb.thumb({ filePath: bad });
            assert.strictEqual(t.reason, 'undecodable');
        });
        await ok('cut-off download (first 60%) still converts what is there', async () => {
            const buf = fs.readFileSync(clips.avi);
            const cut = path.join(clipDir, 'cut.avi'); fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length * 0.6)));
            const r = await vpb.prepare({ filePath: cut });
            assert.ok(r.success, JSON.stringify(r));
        });
        await ok('Field Security: locked → refused; unlocked → converts, decrypted temp deleted', async () => {
            const sealed = path.join(clipDir, 'sealed.flv');
            fs.writeFileSync(sealed, Buffer.concat([MAGIC, fs.readFileSync(clips.flv)]));
            let sec = vault(false);
            const v3 = mk({ pid: 4244, getSecurity: () => sec });
            const l = await v3.prepare({ filePath: sealed });
            assert.ok(!l.success && l.locked);
            assert.strictEqual((await v3.thumb({ filePath: sealed })).reason, 'locked');
            sec = vault(true);
            const r = await v3.prepare({ filePath: sealed });
            assert.ok(r.success && r.mode === 'transcode', JSON.stringify(r));
            const t = await v3.thumb({ filePath: sealed });
            assert.ok(t.success);
            assert.ok(!fs.readdirSync(v3._cacheDir).some(f => /\.src\./.test(f)), 'decrypted source left behind');
            v3.dispose();
            assert.ok(!fs.existsSync(v3._cacheDir));
        });
        await ok('dispose deletes every playback copy', () => {
            assert.ok(fs.readdirSync(vpb._cacheDir).length > 0);
            vpb.dispose();
            assert.ok(!fs.existsSync(vpb._cacheDir));
        });
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
    process.exit(failed ? 1 : 0);
})();
