/* ============================================================
   Series Analysis — footage review desk  (VIPER)

   Cameras are video files already filed on the case's Evidence
   tab. Each camera carries its own clock:

       DVR time  = startDvr + video position
       real time = DVR time + offsetSec      (clock correction)

   so a recorder that runs 3 minutes slow is fixed once and every
   bookmark after that reads in real time. Bookmarks become
   observations { id, cameraId, cameraName, incidentId, atSec, dvr,
   real, realIso, video, text, tag, frame } — `frame` is a small JPEG
   data URL the bulletin can use as the suspect-vehicle photo.

   Stills come from the ORIGINAL file through main (video-frame IPC,
   ffmpeg), never from a <canvas>, so the viper-media:// playback
   copy never taints anything and the still is full resolution.

   Contract with sa-tab.js:
     render(ctx) -> HTML, init(ctx), teardown(),
     onAction(act, el, e, ctx) -> bool, onChange(el, e, ctx) -> bool,
     onKey(e, ctx)
   The pure helpers at the top are exported for node tests.
   ============================================================ */
(function (root) {
    'use strict';

    var VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'flv', 'f4v', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe',
        'm1v', 'm2v', 'vob', '3gp', '3g2', 'ts', 'mts', 'm2ts', 'divx', 'rm', 'rmvb', 'ogm', 'dv', 'mxf', 'dav', 'h264', '264'];
    var NATIVE_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv'];
    var RATES = [0.5, 1, 2, 4, 8, 16];
    var TAGS = [['vehicle', 'Vehicle'], ['person', 'Person'], ['activity', 'Activity'], ['other', 'Other']];
    var EXACT_PAD_MIN = 10;          // an exact incident time is shaded ±10 min
    var STILL_STORE_PX = 480;        // the copy kept inside the series store
    var STILL_EVIDENCE_PX = 1920;    // the copy filed on Evidence

    // ═══════════════════════ pure helpers ═══════════════════════
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function extOf(name) { var m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

    /** "2026-10-14 02:30:00" | "2026-10-14T02:30" | "10/14/2026 2:30:05 AM" -> naive ms (Date.UTC) or null. */
    function parseStamp(v) {
        var s = String(v == null ? '' : v).trim();
        if (!s) return null;
        var y, mo, d, h, mi, se, ap, m;
        if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T_]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap])?\.?m?\.?$/i.exec(s))) {
            y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; se = +(m[6] || 0); ap = m[7];
        } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i.exec(s))) {
            mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; h = +m[4]; mi = +m[5]; se = +(m[6] || 0); ap = m[7];
        } else return null;
        if (ap) {
            if (h < 1 || h > 12) return null;
            h = h % 12 + (/p/i.test(ap) ? 12 : 0);
        }
        if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
        var t = Date.UTC(y, mo - 1, d, h, mi, se);
        var chk = new Date(t);
        if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
        return t;
    }
    function fmtStamp(ms) {
        if (ms == null || !isFinite(ms)) return '';
        var d = new Date(ms);
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
            pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }
    /** "10/14 02:33:41" */
    function fmtShort(ms) {
        if (ms == null || !isFinite(ms)) return '';
        var d = new Date(ms);
        return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }
    function fmtClock(ms) {
        if (ms == null || !isFinite(ms)) return '';
        var d = new Date(ms);
        return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }
    function isoOf(ms) { return ms == null || !isFinite(ms) ? '' : fmtStamp(ms).replace(' ', 'T'); }

    /** Recorder exports often carry their start in the file name: CH02_20261014_023000.mp4. */
    function stampFromFileName(name) {
        var m = /(?:^|\D)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[ T_\-]*([01]\d|2[0-3])[-_.:h]?([0-5]\d)(?:[-_.:m]?([0-5]\d))?(?!\d)/.exec(String(name || ''));
        if (!m) return '';
        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        return fmtStamp(t);
    }

    /** "+2:34" | "-1:02:03" | "90" | "2m 34s" | "-45s" | "" -> seconds, or null when unreadable. */
    function parseOffset(v) {
        var s = String(v == null ? '' : v).trim().replace(/\u2212/g, '-');
        if (!s) return 0;
        var sign = 1;
        if (/^[+-]/.test(s)) { if (s[0] === '-') sign = -1; s = s.slice(1).trim(); }
        var m;
        if ((m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s))) {
            var sec = m[3] != null ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2]);
            return sign * sec;
        }
        if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) return sign * Math.round(+m[1]);
        if ((m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/i.exec(s)) && (m[1] || m[2] || m[3])) {
            return sign * ((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)));
        }
        return null;
    }
    function fmtOffset(sec) {
        sec = Math.round(Number(sec) || 0);
        if (!sec) return '0:00';
        var a = Math.abs(sec), h = Math.floor(a / 3600), mi = Math.floor((a % 3600) / 60), s = a % 60;
        return (sec < 0 ? '-' : '+') + (h ? h + ':' + pad(mi) : String(mi)) + ':' + pad(s);
    }
    function fmtDur(sec) {
        if (sec == null || !isFinite(sec) || sec < 0) sec = 0;
        var a = Math.floor(sec), h = Math.floor(a / 3600), mi = Math.floor((a % 3600) / 60), s = a % 60;
        return h ? h + ':' + pad(mi) + ':' + pad(s) : pad(mi) + ':' + pad(s);
    }

    /** { dvr, real } naive ms at a video position, or null when the camera's clock is not set. */
    function clockAt(cam, sec) {
        var base = parseStamp(cam && cam.startDvr);
        if (base == null) return null;
        var dvr = base + Math.round((Number(sec) || 0) * 1000);
        return { dvr: dvr, real: dvr + Math.round((Number(cam.offsetSec) || 0) * 1000) };
    }
    /** Video seconds at which a real-time instant falls on this camera. */
    function videoSecAt(cam, realMs) {
        var base = parseStamp(cam && cam.startDvr);
        if (base == null || realMs == null) return null;
        return (realMs - (Number(cam.offsetSec) || 0) * 1000 - base) / 1000;
    }
    /** The incident's time on this camera's timeline: { from, to, exact } in video seconds (unclamped). */
    function windowFor(cam, inc) {
        if (!inc || !inc.date || !inc.timeFrom) return null;
        var a = parseStamp(inc.date + ' ' + inc.timeFrom);
        if (a == null) return null;
        var b, exact = !inc.timeTo;
        if (exact) { b = a + EXACT_PAD_MIN * 60000; a -= EXACT_PAD_MIN * 60000; }
        else {
            b = parseStamp(inc.date + ' ' + inc.timeTo);
            if (b == null) return null;
            if (b <= a) b += 86400000;                   // window runs past midnight
        }
        var from = videoSecAt(cam, a), to = videoSecAt(cam, b);
        if (from == null) return null;
        return { from: from, to: to, exact: exact };
    }
    /** The offset that makes `realText` (HH:MM[:SS]) the real time at video position `sec`. Nearest day wins. */
    function offsetFromSync(cam, sec, realText) {
        var c = clockAt(cam, sec);
        var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i.exec(String(realText || '').trim());
        if (!c || !m) return null;
        var h = +m[1], mi = +m[2], s = +(m[3] || 0);
        if (m[4]) { if (h < 1 || h > 12) return null; h = h % 12 + (/p/i.test(m[4]) ? 12 : 0); }
        if (h > 23 || mi > 59 || s > 59) return null;
        var d = new Date(c.dvr);
        var target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi, s);
        var diff = target - c.dvr;
        if (diff > 43200000) diff -= 86400000;
        if (diff < -43200000) diff += 86400000;
        return Math.round(diff / 1000);
    }

    function isVideoFile(f) {
        if (!f) return false;
        if (String(f.type || '').indexOf('video/') === 0) return true;
        return VIDEO_EXT.indexOf(extOf(f.name || f.path)) >= 0;
    }
    /** Every video file on the case's Evidence records. */
    function evidenceVideos(list) {
        var out = [];
        (Array.isArray(list) ? list : []).forEach(function (ev) {
            if (!ev || !Array.isArray(ev.files)) return;
            ev.files.forEach(function (f) {
                if (!f || !f.path || !isVideoFile(f)) return;
                out.push({ evidenceId: ev.id, evTag: ev.tag || '', evDesc: ev.description || '', filePath: f.path, fileName: f.name || String(f.path).split(/[\\/]/).pop(), size: f.size || 0 });
            });
        });
        return out;
    }
    /** Fill dvr / real / realIso / video on an observation from its camera's clock. */
    function stampObservation(ob, cam) {
        var c = clockAt(cam, ob.atSec);
        ob.video = fmtDur(ob.atSec);
        ob.dvr = c ? fmtStamp(c.dvr) : '';
        ob.realIso = c ? isoOf(c.real) : '';
        ob.real = c ? fmtShort(c.real) : ('video ' + ob.video);
        return ob;
    }
    function sortObservations(list) {
        return list.slice().sort(function (a, b) {
            var x = a.realIso || '', y = b.realIso || '';
            if (x && y && x !== y) return x < y ? -1 : 1;
            if (x && !y) return -1;
            if (!x && y) return 1;
            if (a.cameraId !== b.cameraId) return String(a.cameraName || '').localeCompare(String(b.cameraName || ''));
            return (a.atSec || 0) - (b.atSec || 0);
        });
    }
    /** A plain-text footage log for the case file. */
    function makeLog(data, caseObj, nowText, seqMap) {
        var d = data || {}, c = caseObj || {}, sq = seqMap || {};
        var L = [];
        L.push('FOOTAGE REVIEW LOG');
        L.push('Case: ' + (c.caseNumber || '') + (c.title ? ' - ' + c.title : ''));
        if (d.title) L.push('Series: ' + d.title);
        L.push('Generated: ' + (nowText || '') + ' by V.I.P.E.R. Series Analysis');
        L.push('');
        L.push('CAMERAS');
        (d.cameras || []).forEach(function (cam) {
            var off = Number(cam.offsetSec) || 0;
            L.push('- ' + (cam.name || cam.fileName) + ' | file: ' + (cam.fileName || '') +
                ' | video starts on DVR clock: ' + (cam.startDvr || 'not set') +
                ' | clock correction: ' + fmtOffset(off) + (off ? (off > 0 ? ' (recorder behind real time)' : ' (recorder ahead of real time)') : '') +
                (cam.incidentId && sq[cam.incidentId] ? ' | incident #' + sq[cam.incidentId] : ''));
        });
        L.push('');
        L.push('OBSERVATIONS (real time = DVR time + clock correction)');
        var obs = sortObservations(d.observations || []);
        if (!obs.length) L.push('(none)');
        obs.forEach(function (o, i) {
            L.push((i + 1) + '. ' + (o.realIso ? o.realIso.replace('T', ' ') + ' real' : 'clock not set') +
                ' | ' + (o.cameraName || '') + ' | DVR ' + (o.dvr || '-') + ' | video ' + (o.video || fmtDur(o.atSec)) +
                (o.incidentId && sq[o.incidentId] ? ' | incident #' + sq[o.incidentId] : '') +
                (o.tag ? ' | ' + o.tag : '') + (o.evidenceTag ? ' | still filed as ' + o.evidenceTag : ''));
            if (o.text) L.push('   ' + o.text);
        });
        return L.join('\r\n') + '\r\n';
    }

    var PURE = {
        parseStamp: parseStamp, fmtStamp: fmtStamp, fmtShort: fmtShort, stampFromFileName: stampFromFileName,
        parseOffset: parseOffset, fmtOffset: fmtOffset, fmtDur: fmtDur, clockAt: clockAt, videoSecAt: videoSecAt,
        windowFor: windowFor, offsetFromSync: offsetFromSync, isVideoFile: isVideoFile, evidenceVideos: evidenceVideos,
        stampObservation: stampObservation, sortObservations: sortObservations, makeLog: makeLog, RATES: RATES
    };

    if (typeof window === 'undefined') {
        if (typeof module === 'object' && module && module.exports) module.exports = PURE;
        return;
    }

    // ═══════════════════════ UI (renderer only) ═══════════════════════
    var UI = {
        ctx: null, camId: null, rate: 1, obsScope: 'cam', pos: {},
        tok: 0, converted: {}, triedConvert: false, offProgress: null, jobId: '',
        blobUrl: null, raf: 0, drag: false, listeners: [], showClock: false
    };

    function api() { return window.electronAPI || {}; }
    function $(id) { return document.getElementById(id); }
    function E(s) { return UI.ctx ? UI.ctx.esc(s) : String(s == null ? '' : s); }
    function cams() { return (UI.ctx && UI.ctx.data.cameras) || []; }
    function obsAll() { return (UI.ctx && UI.ctx.data.observations) || []; }
    function camById(id) { var l = cams(); for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return l[i]; return null; }
    function obsById(id) { var l = obsAll(); for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return l[i]; return null; }
    function cur() { return camById(UI.camId); }
    function vid() { return $('safVideo'); }
    function newId(p) { return (UI.ctx && UI.ctx.model && UI.ctx.model.newId) ? UI.ctx.model.newId(p) : (p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)); }
    function save() { return UI.ctx ? UI.ctx.save({ quiet: true }) : false; }
    function toast(m, k) { if (UI.ctx) UI.ctx.toast(m, k); }
    function incLabel(inc) {
        if (!inc) return '';
        var n = UI.ctx.seq[inc.id];
        return '#' + (n || '?') + ' · ' + (inc.date ? UI.ctx.fmtDate(inc.date) : 'no date') + (inc.address ? ' · ' + String(inc.address).slice(0, 30) : '');
    }
    function incOptions(selected, emptyLabel) {
        var list = UI.ctx.model.chrono ? UI.ctx.model.chrono(UI.ctx.all) : UI.ctx.all;
        return '<option value="">' + E(emptyLabel || 'No incident') + '</option>' + list.map(function (inc) {
            return '<option value="' + E(inc.id) + '"' + (String(selected) === String(inc.id) ? ' selected' : '') + '>' + E(incLabel(inc)) + '</option>';
        }).join('');
    }
    function typing(t) {
        if (!t) return false;
        var tag = (t.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
    }
    function b64ToBytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt || false); UI.listeners.push([el, ev, fn, opt || false]); }

    // ── render ───────────────────────────────────────────────────────
    function render(ctx) {
        UI.ctx = ctx;
        var list = cams();
        if (UI.camId && !camById(UI.camId)) UI.camId = null;
        if (!UI.camId && list.length) UI.camId = list[0].id;
        return '' +
        '<div class="grid grid-cols-1 xl:grid-cols-12 gap-3" id="safRoot">' +
            '<div class="xl:col-span-3 sa-card" style="align-self:start">' +
                '<div class="flex items-center justify-between mb-2"><div class="sa-card-h">Cameras <small>· from Evidence</small></div>' +
                    '<button class="sa-btn sa-btn-cyan" data-sa="saf-add">＋ Camera</button></div>' +
                '<div id="safCams" class="space-y-2">' + camsHtml() + '</div>' +
            '</div>' +
            '<div class="xl:col-span-6 sa-card" id="safPlayer" style="align-self:start">' + playerHtml() + '</div>' +
            '<div class="xl:col-span-3 sa-card" style="align-self:start">' +
                '<div class="flex items-center justify-between mb-2 gap-2 flex-wrap"><div class="sa-card-h">Observations <small id="safObsN"></small></div>' +
                    '<div class="flex gap-1">' +
                        '<button class="sa-btn" style="padding:2px 8px" data-sa="saf-log-copy" title="Copy the footage log as text">Copy log</button>' +
                        '<button class="sa-btn" style="padding:2px 8px" data-sa="saf-log-ev" title="File the footage log on the Evidence tab">⇪ Log</button>' +
                    '</div></div>' +
                '<div class="flex gap-1 mb-2">' +
                    '<button class="sa-pill' + (UI.obsScope === 'cam' ? ' on' : '') + '" data-sa="saf-scope" data-v="cam">This camera</button>' +
                    '<button class="sa-pill' + (UI.obsScope === 'all' ? ' on' : '') + '" data-sa="saf-scope" data-v="all">All cameras</button></div>' +
                '<div id="safObs" class="space-y-2" style="max-height:calc(100vh - 300px);min-height:120px;overflow:auto;padding-right:2px">' + obsHtml() + '</div>' +
            '</div>' +
        '</div>';
    }

    function camsHtml() {
        var list = cams();
        if (!list.length) {
            return '<div class="text-xs text-gray-400 leading-relaxed">No cameras yet. File the video exports on the <b class="text-gray-200">Evidence</b> tab, then add each one here as a camera.' +
                '<div class="mt-2 text-gray-500">Set each recorder\'s clock once and every bookmark reads in real time.</div></div>';
        }
        return list.map(function (cam) {
            var inc = cam.incidentId ? UI.ctx.byId(cam.incidentId) : null;
            var n = obsAll().filter(function (o) { return o.cameraId === cam.id; }).length;
            var clock = cam.startDvr
                ? '<span class="text-gray-400">DVR set</span>' + (Number(cam.offsetSec) ? ' · <span class="text-viper-orange">' + E(fmtOffset(cam.offsetSec)) + '</span>' : '')
                : '<span class="text-viper-orange">clock not set</span>';
            return '<div class="sa-cam' + (cam.id === UI.camId ? ' on' : '') + '" data-sa="saf-cam" data-id="' + E(cam.id) + '">' +
                '<div class="flex items-start justify-between gap-2"><div class="text-[13px] text-white font-semibold leading-tight" style="word-break:break-word">' + E(cam.name || cam.fileName) + '</div>' +
                    '<button class="text-gray-500 hover:text-red-300 text-sm leading-none" data-sa="saf-cam-del" data-id="' + E(cam.id) + '" title="Remove this camera (the evidence file is not touched)">✕</button></div>' +
                '<div class="text-[10.5px] text-gray-500 truncate" title="' + E(cam.filePath) + '">' + E(cam.fileName) + '</div>' +
                '<div class="text-[11px] mt-1 flex flex-wrap gap-x-2">' + clock +
                    (inc ? '<span class="text-viper-cyan">' + E('#' + (UI.ctx.seq[inc.id] || '?')) + '</span>' : '') +
                    (n ? '<span class="text-gray-400">★ ' + n + '</span>' : '') + '</div>' +
            '</div>';
        }).join('');
    }

    function playerHtml() {
        var cam = cur();
        if (!cam) {
            return '<div class="text-center py-16 text-gray-400 text-sm">' +
                '<div class="text-3xl mb-2 opacity-60">🎞</div>Add a camera to start reviewing footage.' +
                '<div class="mt-3"><button class="sa-btn sa-btn-cyan" data-sa="saf-add">＋ Add a camera from Evidence</button></div></div>';
        }
        var rates = RATES.map(function (r) {
            return '<button class="' + (r === UI.rate ? 'on' : '') + '" data-sa="saf-rate" data-r="' + r + '">' + (r === 0.5 ? '½' : r) + '×</button>';
        }).join('');
        var guess = !cam.startDvr ? stampFromFileName(cam.fileName) : '';
        return '' +
        '<div class="flex items-center gap-2 mb-2 flex-wrap">' +
            '<input class="sa-input" style="flex:1;min-width:150px" data-saf-cam="name" data-id="' + E(cam.id) + '" value="' + E(cam.name) + '" placeholder="Camera name, e.g. Cam 2 – rear lot">' +
            '<select class="sa-select" style="max-width:250px" data-saf-cam="incidentId" data-id="' + E(cam.id) + '">' + incOptions(cam.incidentId, 'Not linked to an incident') + '</select>' +
        '</div>' +
        '<div class="sa-video-wrap" style="min-height:220px">' +
            '<video id="safVideo" preload="metadata" playsinline></video>' +
            '<div class="sa-clock" id="safClockDvr" style="left:8px;color:#e5e7eb"></div>' +
            '<div class="sa-clock" id="safClockReal" style="right:8px;color:#00d9ff"></div>' +
            '<div id="safStatus" class="text-sm text-gray-300 text-center" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:none"></div>' +
        '</div>' +
        '<div class="sa-scrub mt-2" id="safScrub" title="Click or drag to move through the video">' +
            '<div class="sa-scrub-win" id="safWin" style="display:none"></div>' +
            '<div class="sa-scrub-fill" id="safFill" style="width:0"></div>' +
            '<div id="safMarks"></div>' +
            '<div class="sa-scrub-head" id="safHead" style="left:0"></div>' +
        '</div>' +
        '<div class="flex justify-between text-[10.5px] text-gray-500 mt-0.5 font-mono"><span id="safT0">00:00</span><span id="safWinLbl" class="text-red-300"></span><span id="safT1">--:--</span></div>' +
        '<div class="flex items-center gap-2 mt-2 flex-wrap">' +
            '<button class="sa-btn" data-sa="saf-skip" data-s="-10" title="Back 10 s (← 5 s, Shift+← 30 s)">⟲ 10</button>' +
            '<button class="sa-btn sa-btn-cyan" style="min-width:64px" data-sa="saf-play" id="safPlayBtn">▶ Play</button>' +
            '<button class="sa-btn" data-sa="saf-skip" data-s="10" title="Forward 10 s (→ 5 s, Shift+→ 30 s)">10 ⟳</button>' +
            '<button class="sa-btn" data-sa="saf-step" data-s="-1" title="One frame back ( , )">‹</button>' +
            '<button class="sa-btn" data-sa="saf-step" data-s="1" title="One frame forward ( . )">›</button>' +
            '<div class="sa-speed flex rounded-md overflow-hidden" style="border:1px solid #374151">' + rates + '</div>' +
            '<div class="flex-1"></div>' +
            '<button class="sa-btn" data-sa="saf-goto-win" id="safGotoWin" style="display:none" title="Jump to the linked incident\'s time">⇥ Incident time</button>' +
            '<button class="sa-btn sa-btn-orange" data-sa="saf-mark" title="Bookmark this moment and grab a still (B)">★ Bookmark</button>' +
        '</div>' +
        '<div class="mt-3 rounded-lg p-2.5" style="background:rgba(0,0,0,.2);border:1px solid rgba(75,85,99,.5)">' +
            '<div class="flex items-center justify-between"><div class="text-[12px] text-gray-300 font-semibold">Recorder clock</div>' +
                '<div class="text-[10.5px] text-gray-500">real time = DVR time + correction</div></div>' +
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-2 mt-1.5">' +
                '<div><label class="sa-label">DVR time at the very start of this video</label>' +
                    '<input class="sa-input font-mono" data-saf-cam="startDvr" data-id="' + E(cam.id) + '" value="' + E(cam.startDvr || '') + '" placeholder="' + E(guess || 'YYYY-MM-DD HH:MM:SS') + '">' +
                    (guess ? '<button class="text-[10.5px] text-viper-cyan mt-0.5" data-sa="saf-use-guess" data-id="' + E(cam.id) + '">Use ' + E(guess) + ' (from the file name)</button>' : '') +
                    '<div class="text-[10.5px] text-gray-500 mt-0.5">Read it off the burned-in clock on the first frame.</div></div>' +
                '<div><label class="sa-label">Clock correction (±h:mm:ss)</label>' +
                    '<input class="sa-input font-mono" data-saf-cam="offset" data-id="' + E(cam.id) + '" value="' + E(fmtOffset(cam.offsetSec)) + '" placeholder="0:00">' +
                    '<div class="text-[10.5px] text-gray-500 mt-0.5">Recorder 3 min slow → <span class="sa-kbd">+3:00</span>. Fast → <span class="sa-kbd">-3:00</span>.</div></div>' +
                '<div><label class="sa-label">…or sync: real time at this frame</label>' +
                    '<div class="flex gap-1"><input class="sa-input font-mono" id="safSyncReal" placeholder="HH:MM:SS"' + (cam.startDvr ? '' : ' disabled title="Set the DVR start first"') + '>' +
                    '<button class="sa-btn" data-sa="saf-sync" data-id="' + E(cam.id) + '"' + (cam.startDvr ? '' : ' disabled') + '>Set</button></div>' +
                    '<div class="text-[10.5px] text-gray-500 mt-0.5">Pause on a frame with a known time (a 911 call, a phone clock).</div></div>' +
            '</div>' +
        '</div>' +
        '<div class="text-[10.5px] text-gray-500 mt-2 flex flex-wrap gap-x-3 gap-y-1">' +
            '<span><span class="sa-kbd">Space</span> play / pause</span><span><span class="sa-kbd">←</span><span class="sa-kbd">→</span> 5 s (Shift 30 s)</span>' +
            '<span><span class="sa-kbd">,</span><span class="sa-kbd">.</span> frame</span><span><span class="sa-kbd">[</span><span class="sa-kbd">]</span> speed</span>' +
            '<span><span class="sa-kbd">B</span> bookmark</span></div>';
    }

    function scopedObs() {
        var l = obsAll();
        if (UI.obsScope === 'cam' && UI.camId) l = l.filter(function (o) { return o.cameraId === UI.camId; });
        return sortObservations(l);
    }
    function obsCardHtml(o) {
        var inc = o.incidentId ? UI.ctx.byId(o.incidentId) : null;
        var n = inc ? UI.ctx.seq[inc.id] : null;
        var tagOpts = TAGS.map(function (t) { return '<option value="' + t[0] + '"' + (o.tag === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('');
        var canSetTime = inc && o.realIso;
        var still = o.frame
            ? '<img src="' + E(o.frame) + '" alt="" data-sa="saf-seek-obs" data-id="' + E(o.id) + '" title="Go to this moment">'
            : '<button class="sa-btn w-full mb-1" style="padding:3px" data-sa="saf-grab" data-id="' + E(o.id) + '">📷 Grab still</button>';
        return '<div class="sa-obs" data-obs="' + E(o.id) + '">' + still +
            '<div class="flex items-center justify-between gap-1 text-[11px] mb-1">' +
                '<button class="font-mono ' + (o.realIso ? 'text-viper-cyan' : 'text-gray-400') + '" data-sa="saf-seek-obs" data-id="' + E(o.id) + '" title="DVR ' + E(o.dvr || '-') + ' · video ' + E(o.video || '') + '">' + E(o.real || o.video) + '</button>' +
                '<span class="text-gray-500 truncate" style="max-width:55%" title="' + E(o.cameraName) + '">' + E(o.cameraName || '') + '</span></div>' +
            '<input class="sa-input" style="padding:4px 7px;font-size:12px" data-saf-obs="text" data-id="' + E(o.id) + '" value="' + E(o.text || '') + '" placeholder="What do you see? e.g. silver sedan enters lot">' +
            '<div class="flex gap-1 mt-1"><select class="sa-select" style="padding:2px 4px;font-size:11px;width:84px;flex:0 0 84px" data-saf-obs="tag" data-id="' + E(o.id) + '">' + tagOpts + '</select>' +
                '<select class="sa-select" style="padding:2px 4px;font-size:11px;width:auto;flex:1 1 0;min-width:0" data-saf-obs="incidentId" data-id="' + E(o.id) + '">' + incOptions(o.incidentId, 'No incident') + '</select></div>' +
            '<div class="flex gap-1 mt-1 flex-wrap">' +
                (o.evidenceTag
                    ? '<span class="text-[10.5px] text-green-300 px-1" title="Full-size still filed on Evidence">✓ ' + E(o.evidenceTag) + '</span>'
                    : '<button class="sa-btn" style="padding:1px 7px;font-size:11px" data-sa="saf-obs-ev" data-id="' + E(o.id) + '" title="File a full-size still on the Evidence tab">⇪ Evidence</button>') +
                (canSetTime ? '<button class="sa-btn" style="padding:1px 7px;font-size:11px" data-sa="saf-obs-time" data-id="' + E(o.id) + '" title="Set incident #' + n + '\'s time to this moment">⏱ #' + n + ' time</button>' : '') +
                '<div class="flex-1"></div>' +
                '<button class="text-gray-500 hover:text-red-300 text-xs px-1" data-sa="saf-obs-del" data-id="' + E(o.id) + '" title="Delete this observation">✕</button>' +
            '</div></div>';
    }
    function obsHtml() {
        var l = scopedObs();
        if (!l.length) {
            return '<div class="text-xs text-gray-500 leading-relaxed">No observations' + (UI.obsScope === 'cam' && UI.camId ? ' on this camera' : '') + ' yet. ' +
                'Press <span class="sa-kbd">B</span> or ★ Bookmark when you see something; VIPER grabs a still and stamps the real time.</div>';
        }
        return l.map(obsCardHtml).join('');
    }
    function paintCams() { var el = $('safCams'); if (el) el.innerHTML = camsHtml(); }
    function paintObs() {
        var el = $('safObs'); if (el) el.innerHTML = obsHtml();
        var n = $('safObsN'); if (n) n.textContent = '· ' + obsAll().length;
        paintMarks();
    }
    function paintPlayer() {
        var el = $('safPlayer');
        if (!el) return;
        stopVideo();
        el.innerHTML = playerHtml();
        wirePlayer();
    }

    // ── playback ─────────────────────────────────────────────────────
    function setStatus(html) { var s = $('safStatus'); if (s) s.innerHTML = html || ''; }
    function stopVideo() {
        UI.tok++;
        cancelAnimationFrame(UI.raf); UI.raf = 0;
        var v = vid();
        if (v) {
            if (UI.camId && isFinite(v.currentTime)) UI.pos[UI.camId] = v.currentTime;
            try { v.pause(); } catch (_) {}
            v.removeAttribute('src');
            try { v.load(); } catch (_) {}
        }
        if (UI.blobUrl) { try { URL.revokeObjectURL(UI.blobUrl); } catch (_) {} UI.blobUrl = null; }
    }

    async function loadCamera() {
        var cam = cur(), v = vid();
        if (!cam || !v) return;
        var tok = ++UI.tok;
        UI.triedConvert = false;
        var A = api();
        if (!A.evidenceMediaUrl && !A.videoPlaybackUrl) { setStatus('Footage review needs the VIPER desktop app.'); return; }
        var ext = extOf(cam.fileName || cam.filePath);
        if (UI.converted[cam.filePath] || (NATIVE_EXT.indexOf(ext) < 0 && A.videoPlaybackUrl)) return convert(cam, tok);
        setStatus('Opening…');
        var res;
        try { res = A.evidenceMediaUrl ? await A.evidenceMediaUrl({ filePath: cam.filePath }) : null; }
        catch (e) { res = { success: false, error: (e && e.message) || String(e) }; }
        if (tok !== UI.tok) return;
        if (!res || !res.success) {
            if (A.videoPlaybackUrl && !(res && res.locked)) return convert(cam, tok);
            setStatus('<span class="text-red-300">' + E((res && res.error) || 'This video could not be opened.') + '</span>');
            return;
        }
        var url = res.url;
        if (res.bytes) { url = URL.createObjectURL(new Blob([res.bytes], { type: 'video/' + (ext === 'mov' ? 'quicktime' : ext || 'mp4') })); UI.blobUrl = url; }
        setSrc(url, tok);
    }
    async function convert(cam, tok) {
        var A = api();
        UI.triedConvert = true;
        UI.jobId = 'saf-' + tok + '-' + Date.now().toString(36);
        if (!UI.offProgress && A.onVideoPlaybackProgress) {
            UI.offProgress = A.onVideoPlaybackProgress(function (p) {
                if (!p || p.jobId !== UI.jobId) return;
                setStatus('Making a playback copy… ' + (p.pct || 0) + '%<br><span class="text-[11px] text-gray-500">The original evidence file is not changed.</span>');
            });
        }
        setStatus('Making a playback copy…<br><span class="text-[11px] text-gray-500">Recorder formats are converted once per session. The original is not changed.</span>');
        var res;
        try { res = await A.videoPlaybackUrl({ filePath: cam.filePath, jobId: UI.jobId }); }
        catch (e) { res = { success: false, error: (e && e.message) || String(e) }; }
        if (tok !== UI.tok) return;
        if (!res || !res.success) { setStatus('<span class="text-red-300">' + E((res && res.error) || 'VIPER could not play this video.') + '</span>'); return; }
        UI.converted[cam.filePath] = true;
        setSrc(res.url, tok);
    }
    function setSrc(url, tok) {
        var v = vid(), cam = cur();
        if (!v || tok !== UI.tok || !cam) return;
        setStatus('');
        v.onloadedmetadata = function () {
            if (tok !== UI.tok) return;
            var at = UI.pos[cam.id];
            if (at && isFinite(v.duration)) v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1));
            v.playbackRate = UI.rate;
            var t1 = $('safT1'); if (t1) t1.textContent = fmtDur(v.duration);
            paintMarks();
            paintWindow();
            tick();
        };
        v.onerror = function () {
            if (tok !== UI.tok) return;
            if (!UI.triedConvert && api().videoPlaybackUrl) { convert(cam, tok); return; }
            setStatus('<span class="text-red-300">This video could not be decoded.</span>');
        };
        v.onplay = function () { playBtn(); loop(); };
        v.onpause = function () { playBtn(); tick(); };
        v.onseeked = tick;
        v.ontimeupdate = function () { if (v.paused) tick(); };
        v.onratechange = function () { UI.rate = v.playbackRate; paintRates(); };
        v.src = url;
    }
    function loop() {
        cancelAnimationFrame(UI.raf);
        var v = vid();
        if (!v || v.paused) return;
        tick();
        UI.raf = requestAnimationFrame(loop);
    }
    function tick() {
        var v = vid(), cam = cur();
        if (!v || !cam) return;
        var t = v.currentTime || 0, d = v.duration;
        var c = clockAt(cam, t);
        var a = $('safClockDvr'), b = $('safClockReal');
        if (a) a.textContent = c ? 'DVR ' + fmtShort(c.dvr) : 'video ' + fmtDur(t);
        if (b) { b.textContent = c ? 'REAL ' + fmtShort(c.real) : 'set the recorder clock ↓'; b.style.color = c ? '#00d9ff' : '#ffa726'; }
        var f = $('safFill'), h = $('safHead'), t0 = $('safT0');
        var pct = d && isFinite(d) ? Math.max(0, Math.min(100, t / d * 100)) : 0;
        if (f) f.style.width = pct + '%';
        if (h) h.style.left = pct + '%';
        if (t0) t0.textContent = fmtDur(t);
    }
    function playBtn() { var b = $('safPlayBtn'), v = vid(); if (b && v) b.textContent = v.paused ? '▶ Play' : '❚❚ Pause'; }
    function paintRates() {
        var bs = document.querySelectorAll('#safPlayer [data-sa="saf-rate"]');
        for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', +bs[i].getAttribute('data-r') === UI.rate);
    }
    function paintMarks() {
        var el = $('safMarks'), v = vid(), cam = cur();
        if (!el) return;
        if (!v || !cam || !(v.duration > 0) || !isFinite(v.duration)) { el.innerHTML = ''; return; }
        el.innerHTML = obsAll().filter(function (o) { return o.cameraId === cam.id; }).map(function (o) {
            var p = Math.max(0, Math.min(100, (o.atSec || 0) / v.duration * 100));
            return '<div class="sa-scrub-obs" style="left:' + p + '%" data-sa="saf-seek-obs" data-id="' + E(o.id) + '" title="' + E((o.real || o.video) + (o.text ? ' · ' + o.text : '')) + '"></div>';
        }).join('');
    }
    function camWindow(cam) {
        var inc = cam && cam.incidentId ? UI.ctx.byId(cam.incidentId) : null;
        return inc ? windowFor(cam, inc) : null;
    }
    function paintWindow() {
        var el = $('safWin'), lbl = $('safWinLbl'), go = $('safGotoWin'), v = vid(), cam = cur();
        if (!el) return;
        var w = camWindow(cam), d = v && v.duration;
        var show = w && d > 0 && isFinite(d) && w.to > 0 && w.from < d;
        el.style.display = show ? '' : 'none';
        if (go) go.style.display = show ? '' : 'none';
        if (lbl) {
            var inc = cam && cam.incidentId ? UI.ctx.byId(cam.incidentId) : null;
            lbl.textContent = !inc ? '' : !cam.startDvr ? 'set the clock to see #' + (UI.ctx.seq[inc.id] || '?') + '\'s time'
                : !w ? '#' + (UI.ctx.seq[inc.id] || '?') + ' has no time'
                : show ? '#' + UI.ctx.seq[inc.id] + (w.exact ? ' ±' + EXACT_PAD_MIN + ' min' : ' window')
                : (d > 0 ? '#' + UI.ctx.seq[inc.id] + '\'s time is not in this video' : '');
        }
        if (!show) return;
        var a = Math.max(0, w.from) / d * 100, b = Math.min(d, w.to) / d * 100;
        el.style.left = a + '%';
        el.style.width = Math.max(0.4, b - a) + '%';
    }
    function seek(sec) {
        var v = vid();
        if (!v || !(v.duration > 0)) return;
        v.currentTime = Math.max(0, Math.min(v.duration - 0.05, sec));
        tick();
    }
    function togglePlay() {
        var v = vid();
        if (!v || !v.src) return;
        if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause();
    }
    function setRate(r) {
        UI.rate = r;
        var v = vid(); if (v) v.playbackRate = r;
        paintRates();
    }
    function stepFrame(dir) {
        var v = vid();
        if (!v) return;
        v.pause();
        seek((v.currentTime || 0) + dir / 30);
    }

    function unwire() {
        UI.listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (_) {} });
        UI.listeners = [];
        UI.drag = false;
    }
    function wirePlayer() {
        unwire();
        var sc = $('safScrub');
        if (sc) {
            var at = function (e) {
                var r = sc.getBoundingClientRect(), v = vid();
                if (!v || !(v.duration > 0) || !r.width) return;
                seek((e.clientX - r.left) / r.width * v.duration);
            };
            on(sc, 'mousedown', function (e) {
                if (e.button !== 0 || (e.target && e.target.classList && e.target.classList.contains('sa-scrub-obs'))) return;
                UI.drag = true; at(e); e.preventDefault();
            });
            on(document, 'mousemove', function (e) { if (UI.drag) at(e); });
            on(document, 'mouseup', function () { UI.drag = false; });
        }
        if (cur()) loadCamera();
    }

    // ── stills ───────────────────────────────────────────────────────
    function shrink(dataUrl, max, q) {
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
                var cv = document.createElement('canvas');
                cv.width = Math.max(1, Math.round(img.naturalWidth * s)); cv.height = Math.max(1, Math.round(img.naturalHeight * s));
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                try { resolve(cv.toDataURL('image/jpeg', q || 0.74)); } catch (_) { resolve(null); }
            };
            img.onerror = function () { resolve(null); };
            img.src = dataUrl;
        });
    }
    /** A JPEG data URL of the original file at `atSec`, or throws with a readable message. */
    async function still(cam, atSec, size) {
        var A = api();
        if (A.videoFrame) {
            var r = await A.videoFrame({ filePath: cam.filePath, atSec: atSec, size: size });
            if (r && r.success && r.dataUrl) return r.dataUrl;
            throw new Error((r && r.error) || 'No picture at that point.');
        }
        // Older main process: try the on-screen video (fails if the canvas is tainted).
        var v = vid();
        if (!v || cur() !== cam || Math.abs((v.currentTime || 0) - atSec) > 0.5) throw new Error('Restart VIPER to finish the update that adds frame grabs.');
        var cv = document.createElement('canvas');
        var s = Math.min(1, size / Math.max(v.videoWidth || 1, v.videoHeight || 1));
        cv.width = Math.round((v.videoWidth || 640) * s); cv.height = Math.round((v.videoHeight || 360) * s);
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        try { return cv.toDataURL('image/jpeg', 0.9); } catch (_) { throw new Error('Restart VIPER to finish the update that adds frame grabs.'); }
    }
    function paintObsCard(o) {
        var el = document.querySelector('#safObs [data-obs="' + (window.CSS && CSS.escape ? CSS.escape(o.id) : o.id) + '"]');
        if (el) el.outerHTML = obsCardHtml(o);
    }
    async function grabFor(o, quietFail) {
        var cam = camById(o.cameraId);
        if (!cam) { if (!quietFail) toast('That camera was removed; no still can be taken.', 'warning'); return; }
        try {
            var big = await still(cam, o.atSec, 960);
            var small = await shrink(big, STILL_STORE_PX, 0.74);
            if (!small) throw new Error('The still could not be prepared.');
            o.frame = small;
            if (!save()) { o.frame = ''; save(); return; }
            paintObsCard(o);
        } catch (e) {
            if (!quietFail) toast('No still: ' + ((e && e.message) || e), 'error');
        }
    }

    // ── observations ─────────────────────────────────────────────────
    function bookmark() {
        var cam = cur(), v = vid();
        if (!cam || !v || !v.src) { toast('Open a camera first.', 'info'); return; }
        try { v.pause(); } catch (_) {}
        var o = stampObservation({
            id: newId('obs'), cameraId: cam.id, cameraName: cam.name || cam.fileName, incidentId: cam.incidentId || '',
            atSec: Math.round((v.currentTime || 0) * 1000) / 1000, text: '', tag: 'vehicle', frame: '', createdAt: new Date().toISOString()
        }, cam);
        UI.ctx.data.observations = obsAll();
        UI.ctx.data.observations.push(o);
        save();
        if (UI.obsScope === 'cam' && UI.camId !== o.cameraId) UI.obsScope = 'all';
        paintObs(); paintCams();
        var input = document.querySelector('#safObs [data-saf-obs="text"][data-id="' + o.id + '"]');
        if (input) { input.scrollIntoView({ block: 'nearest' }); setTimeout(function () { try { input.focus(); } catch (_) {} }, 20); }
        grabFor(o, true);
    }
    function seekObs(o) {
        if (!o) return;
        if (o.cameraId !== UI.camId) {
            if (!camById(o.cameraId)) { toast('That camera was removed.', 'warning'); return; }
            stopVideo();
            UI.camId = o.cameraId;
            UI.pos[o.cameraId] = o.atSec;
            paintCams(); paintPlayer(); paintObs();
            return;
        }
        var v = vid(); if (v) v.pause();
        seek(o.atSec);
    }
    async function obsToEvidence(o, btn) {
        var cam = camById(o.cameraId);
        if (!cam) { toast('That camera was removed; no still can be taken.', 'warning'); return; }
        if (btn) { btn.disabled = true; btn.textContent = 'Filing…'; }
        try {
            var url = await still(cam, o.atSec, STILL_EVIDENCE_PX);
            var b64 = String(url).split(',')[1] || '';
            var stamp = (o.realIso || '').replace(/[-:]/g, '').replace('T', '-') || ('v' + Math.round(o.atSec));
            var name = ('Still_' + (cam.name || 'camera') + '_' + stamp + '.jpg').replace(/[^\w.\-]+/g, '_');
            var tag = 'STILL-' + (stamp.replace(/^v/, 'V') || Date.now());
            var rec = await UI.ctx.saveToEvidence({
                fileName: name, bytes: b64ToBytes(b64), mime: 'image/jpeg', type: 'photo', tag: tag, source: 'series_analysis_footage',
                description: 'Still from ' + (cam.name || cam.fileName) + ' at ' + (o.realIso ? o.realIso.replace('T', ' ') + ' (real time; DVR ' + o.dvr + ', correction ' + fmtOffset(cam.offsetSec) + ')' : 'video ' + o.video) +
                    (o.text ? ': ' + o.text : '') + '. Source file: ' + cam.fileName + ', video position ' + fmtDur(o.atSec) + '.'
            });
            o.evidenceTag = rec.tag; o.evidenceId = rec.id;
            if (!o.frame) { var sm = await shrink(url, STILL_STORE_PX, 0.74); if (sm) o.frame = sm; }
            save();
            paintObsCard(o);
            toast('Still filed on Evidence as ' + rec.tag + '.', 'success');
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = '⇪ Evidence'; }
            toast('Still not filed: ' + ((e && e.message) || e), 'error');
        }
    }
    async function obsSetIncidentTime(o) {
        var inc = o.incidentId ? UI.ctx.byId(o.incidentId) : null;
        if (!inc || !o.realIso) return;
        var n = UI.ctx.seq[inc.id];
        var date = o.realIso.slice(0, 10), time = o.realIso.slice(11, 16);
        var was = (inc.date ? UI.ctx.fmtDateLong(inc.date) + ' ' : '') + (UI.ctx.timeText(inc) || 'no time');
        var okd = await UI.ctx.confirm('Set incident #' + n + ' to <b>' + E(UI.ctx.fmtDateLong(date) + ' ' + time) + '</b> (exact)?<br><br>It is now ' + E(was) + '. The old value is kept in the incident notes.', { okText: 'Set time' });
        if (!okd) return;
        inc.notes = ((inc.notes ? inc.notes + '\n' : '') + 'Time from footage: ' + (o.cameraName || 'camera') + ' at ' + o.realIso.replace('T', ' ') + ' real time (was ' + was + ').').trim();
        inc.date = date; inc.timeFrom = time; inc.timeTo = '';
        inc.updatedAt = new Date().toISOString();
        UI.ctx.save();
        UI.ctx.all = UI.ctx.data.incidents;
        paintWindow();
        paintObsCard(o);
        toast('Incident #' + n + ' now reads ' + UI.ctx.fmtDateLong(date) + ' ' + time + '.', 'success');
    }

    // ── cameras ──────────────────────────────────────────────────────
    function openAddModal() {
        var vids = evidenceVideos(UI.ctx.evidence ? UI.ctx.evidence() : []);
        var have = {}; cams().forEach(function (c) { have[c.filePath] = 1; });
        var body;
        if (!vids.length) {
            body = '<div class="text-sm text-gray-300 leading-relaxed">This case has no video files on its Evidence tab yet.<br>' +
                '<span class="text-gray-400">Add the recorder exports there (one evidence item per camera, or one item holding every file), then come back and add them as cameras.</span></div>' +
                '<div class="flex justify-end mt-4"><button class="sa-btn" data-sa="modal-close">Close</button></div>';
        } else {
            body = '<div class="space-y-1 mb-3" style="max-height:340px;overflow:auto">' + vids.map(function (x, i) {
                var dup = have[x.filePath];
                return '<label class="flex items-start gap-2 p-2 rounded-md" style="border:1px solid rgba(75,85,99,.5);' + (dup ? 'opacity:.45' : 'cursor:pointer') + '">' +
                    '<input type="checkbox" class="accent-viper-cyan mt-0.5" data-saf-pick="' + i + '"' + (dup ? ' disabled' : '') + '>' +
                    '<div class="min-w-0"><div class="text-[13px] text-white truncate">' + E(x.fileName) + (dup ? ' <span class="text-[10.5px] text-gray-400">(already a camera)</span>' : '') + '</div>' +
                    '<div class="text-[11px] text-gray-500 truncate">' + E((x.evTag ? x.evTag + ' · ' : '') + (x.evDesc || '')) + (x.size ? ' · ' + (Math.round(x.size / 1048576 * 10) / 10) + ' MB' : '') +
                    (stampFromFileName(x.fileName) ? ' · <span class="text-viper-cyan">starts ' + E(stampFromFileName(x.fileName)) + '?</span>' : '') + '</div></div></label>';
            }).join('') + '</div>' +
            '<label class="sa-label">Link to incident (optional)</label><select class="sa-select w-full" id="safAddInc">' + incOptions('', 'Not linked') + '</select>' +
            '<div class="flex justify-end gap-2 mt-4"><button class="sa-btn" data-sa="modal-close">Cancel</button><button class="sa-btn sa-btn-cyan" data-sa="saf-add-save">Add cameras</button></div>';
        }
        UI.addList = vids;
        UI.ctx.openModal(UI.ctx.modalHead ? UI.ctx.modalHead('Add cameras', 'Video files on this case\'s Evidence tab. The files are only read.') + body
            : '<h3>Add cameras</h3>' + body);
    }
    function addFromModal() {
        var picks = document.querySelectorAll('#saModal [data-saf-pick]:checked');
        if (!picks.length) { toast('Tick at least one video.', 'info'); return; }
        var incId = ($('safAddInc') || {}).value || '';
        var first = null;
        UI.ctx.data.cameras = cams();
        for (var i = 0; i < picks.length; i++) {
            var x = UI.addList[+picks[i].getAttribute('data-saf-pick')];
            if (!x) continue;
            var nm = x.fileName.replace(/\.[^.]+$/, '');
            var cam = {
                id: newId('cam'), evidenceId: x.evidenceId, filePath: x.filePath, fileName: x.fileName,
                name: picks.length === 1 && x.evDesc && x.evDesc.length <= 40 ? x.evDesc : nm,
                incidentId: incId, startDvr: stampFromFileName(x.fileName), offsetSec: 0, createdAt: new Date().toISOString()
            };
            UI.ctx.data.cameras.push(cam);
            if (!first) first = cam;
        }
        save();
        UI.ctx.closeModal();
        if (first) { stopVideo(); UI.camId = first.id; }
        UI.ctx.renderBody();
        toast(picks.length + ' camera' + (picks.length === 1 ? '' : 's') + ' added.' + (first && first.startDvr ? ' Start time read from the file name; check it against the burned-in clock.' : ''), 'success');
    }
    async function removeCamera(id) {
        var cam = camById(id);
        if (!cam) return;
        var n = obsAll().filter(function (o) { return o.cameraId === id; }).length;
        var okd = await UI.ctx.confirm('Remove camera <b>' + E(cam.name || cam.fileName) + '</b>?<br><br>The evidence file is not touched.' + (n ? ' Its ' + n + ' observation' + (n === 1 ? '' : 's') + ' stay in the log.' : ''), { okText: 'Remove', danger: true });
        if (!okd) return;
        if (UI.camId === id) { stopVideo(); UI.camId = null; }
        UI.ctx.data.cameras = cams().filter(function (c) { return c.id !== id; });
        save();
        UI.ctx.renderBody();
    }
    function restamp(cam) {
        obsAll().forEach(function (o) { if (o.cameraId === cam.id) { o.cameraName = cam.name || cam.fileName; stampObservation(o, cam); } });
    }

    // ── contract ─────────────────────────────────────────────────────
    function init(ctx) {
        UI.ctx = ctx;
        var n = $('safObsN'); if (n) n.textContent = '· ' + obsAll().length;
        wirePlayer();
    }
    function teardown() {
        stopVideo();
        unwire();
        if (UI.offProgress) { try { UI.offProgress(); } catch (_) {} UI.offProgress = null; }
    }

    function onAction(act, el, e, ctx) {
        if (act.indexOf('saf-') !== 0) return false;
        UI.ctx = ctx;
        // Keep Space for play/pause: a focused button would also "click" on Space.
        if (el.tagName === 'BUTTON' && el.closest('#safPlayer') && el.blur) el.blur();
        var id = el.getAttribute('data-id');
        switch (act) {
            case 'saf-add': openAddModal(); break;
            case 'saf-add-save': addFromModal(); break;
            case 'saf-cam':
                if (e.target.closest('[data-sa="saf-cam-del"]')) break;
                if (id !== UI.camId) { stopVideo(); UI.camId = id; paintCams(); paintPlayer(); paintObs(); }
                break;
            case 'saf-cam-del': removeCamera(id); break;
            case 'saf-play': togglePlay(); break;
            case 'saf-skip': { var v = vid(); if (v) seek((v.currentTime || 0) + (+el.getAttribute('data-s') || 0)); break; }
            case 'saf-step': stepFrame(+el.getAttribute('data-s') || 1); break;
            case 'saf-rate': setRate(+el.getAttribute('data-r') || 1); break;
            case 'saf-mark': bookmark(); break;
            case 'saf-goto-win': { var w = camWindow(cur()); if (w) seek(Math.max(0, w.from)); break; }
            case 'saf-use-guess': {
                var c = camById(id); if (!c) break;
                c.startDvr = stampFromFileName(c.fileName); restamp(c); save();
                paintCams(); paintPlayer(); paintObs();
                break;
            }
            case 'saf-sync': {
                var cs = camById(id), v2 = vid(), inp = $('safSyncReal');
                if (!cs || !v2 || !inp) break;
                var off = offsetFromSync(cs, v2.currentTime || 0, inp.value);
                if (off == null) { toast('Type the real time as HH:MM:SS (and set the DVR start first).', 'warning'); break; }
                cs.offsetSec = off; restamp(cs); save();
                var keep = v2.currentTime;
                UI.pos[cs.id] = keep;
                paintCams(); paintPlayer(); paintObs();
                toast('Clock correction set to ' + fmtOffset(off) + '.', 'success');
                break;
            }
            case 'saf-scope': UI.obsScope = el.getAttribute('data-v') === 'all' ? 'all' : 'cam'; ctx.renderBody(); break;
            case 'saf-seek-obs': seekObs(obsById(id)); break;
            case 'saf-grab': { var o1 = obsById(id); if (o1) { el.disabled = true; el.textContent = 'Grabbing…'; grabFor(o1, false).then(function () { if (el.isConnected) { el.disabled = false; el.textContent = '📷 Grab still'; } }); } break; }
            case 'saf-obs-ev': { var o2 = obsById(id); if (o2) obsToEvidence(o2, el); break; }
            case 'saf-obs-time': { var o3 = obsById(id); if (o3) obsSetIncidentTime(o3); break; }
            case 'saf-obs-del': {
                ctx.data.observations = obsAll().filter(function (o) { return String(o.id) !== String(id); });
                save(); paintObs(); paintCams();
                break;
            }
            case 'saf-log-copy': {
                var txt = makeLog(ctx.data, ctx.caseObj, new Date().toLocaleString(), ctx.seq);
                var done = function () { toast('Footage log copied.', 'success'); };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { toast('Could not reach the clipboard.', 'error'); });
                break;
            }
            case 'saf-log-ev': {
                if (!obsAll().length) { toast('No observations to log yet.', 'info'); break; }
                var log = makeLog(ctx.data, ctx.caseObj, new Date().toLocaleString(), ctx.seq);
                var nm = ('Footage-Log_' + ((ctx.caseObj || {}).caseNumber || 'case') + '_' + ctx.today() + '.txt').replace(/[^\w.\-]+/g, '_');
                ctx.saveToEvidence({
                    fileName: nm, bytes: new TextEncoder().encode(log), mime: 'text/plain', type: 'document',
                    tag: 'FOOTAGE-LOG-' + ctx.today().replace(/-/g, ''), source: 'series_analysis_footage',
                    description: 'Footage review log: ' + obsAll().length + ' observations across ' + cams().length + ' camera' + (cams().length === 1 ? '' : 's')
                }).then(function (rec) { toast('Footage log filed on Evidence as ' + rec.tag + '.', 'success'); },
                    function (err) { toast('Log not filed: ' + ((err && err.message) || err), 'error'); });
                break;
            }
            default: return false;
        }
        return true;
    }

    function onChange(el, e, ctx) {
        var cf = el.getAttribute && el.getAttribute('data-saf-cam');
        var of = el.getAttribute && el.getAttribute('data-saf-obs');
        if (!cf && !of) return false;
        UI.ctx = ctx;
        var id = el.getAttribute('data-id');
        if (cf) {
            var cam = camById(id);
            if (!cam) return true;
            var v = String(el.value || '').trim();
            if (cf === 'name') { cam.name = v; restamp(cam); save(); paintCams(); paintObs(); return true; }
            if (cf === 'incidentId') { cam.incidentId = v; save(); paintCams(); paintWindow(); return true; }
            if (cf === 'startDvr') {
                if (v && parseStamp(v) == null) { toast('Use YYYY-MM-DD HH:MM:SS, e.g. 2026-10-14 02:30:00.', 'warning'); el.value = cam.startDvr || ''; return true; }
                cam.startDvr = v ? fmtStamp(parseStamp(v)) : '';
            } else if (cf === 'offset') {
                var off = parseOffset(v);
                if (off == null) { toast('Use ±h:mm:ss, e.g. +3:00 or -1:02:30.', 'warning'); el.value = fmtOffset(cam.offsetSec); return true; }
                cam.offsetSec = off;
            }
            restamp(cam); save();
            var vv = vid(); if (vv) UI.pos[cam.id] = vv.currentTime;
            paintCams(); paintPlayer(); paintObs();
            return true;
        }
        var o = obsById(id);
        if (!o) return true;
        if (of === 'text') { o.text = String(el.value || '').trim(); save(); paintMarks(); return true; }
        if (of === 'tag') { o.tag = el.value; save(); return true; }
        if (of === 'incidentId') { o.incidentId = el.value; save(); paintObsCard(o); return true; }
        return true;
    }

    function onKey(e, ctx) {
        var v = vid();
        if (!v || !v.isConnected || v.offsetParent === null || document.getElementById('saModal')) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (typing(e.target)) {
            if (e.key === 'Enter' && e.target.getAttribute && e.target.getAttribute('data-saf-obs') === 'text') { e.preventDefault(); e.target.blur(); }
            return;
        }
        UI.ctx = ctx;
        var k = e.key;
        if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); togglePlay(); }
        else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); seek((v.currentTime || 0) + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 30 : 5)); }
        else if (k === ',' || k === '.') { e.preventDefault(); stepFrame(k === ',' ? -1 : 1); }
        else if (k === '[' || k === ']') {
            e.preventDefault();
            var i = RATES.indexOf(UI.rate); if (i < 0) i = 1;
            setRate(RATES[Math.max(0, Math.min(RATES.length - 1, i + (k === '[' ? -1 : 1)))]);
        }
        else if (k === 'b' || k === 'B') { e.preventDefault(); bookmark(); }
    }

    var API = Object.assign({ render: render, init: init, teardown: teardown, onAction: onAction, onChange: onChange, onKey: onKey }, PURE);
    window.SeriesAnalysisFootage = API;
    if (typeof module === 'object' && module && module.exports) module.exports = API;
})(this);
