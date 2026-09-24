/**
 * Area Canvas media — photos, video and audio attached to a single canvass
 * entry.
 *
 * Ported from the SCOPE field-capture feature in Project Oversight, which
 * solved the same problem for compliance checks. The shape of that solution
 * is kept deliberately:
 *
 *   - Photos are ATTACHED from disk and downscaled before they are stored.
 *     A phone or body-cam frame is 4-12MB and nothing downstream benefits
 *     from that.
 *   - Video and audio are RECORDED IN-APP through a full-screen overlay
 *     with a running clock. Oversight rejected <input capture> on purpose:
 *     it hands back whatever the device already shot, so the only move left
 *     is to refuse a clip the officer already spent a minute recording.
 *     Recording in-app lets us cap the bitrate and stop the clock ON the
 *     limit instead of arguing about it afterwards.
 *   - Nothing is written to disk until the entry itself is saved, and
 *     nothing is deleted from disk until the entry itself is saved. Cancel
 *     means cancel.
 *
 * Bytes live on disk under cases/{caseNumber}/Canvas Media/ via the
 * canvas-save-media IPC, encrypted when Field Security is on. The entry's
 * record in localStorage keeps only the file NAME and the metadata. This is
 * not a style choice: localStorage is a ~5MB quota and one minute of 720p
 * video is around 11MB, so inlining it would destroy the case record.
 *
 * Every item carries `discoverable`, the same per-item Discovery Status flag
 * evidence has. Items marked Not Discoverable are withheld from the DA
 * export package by file name.
 */
(function (global) {
    'use strict';

    // ── Limits ───────────────────────────────────────────────────────────
    // Photos are a count. Video and audio are a TOTAL DURATION BUDGET per
    // entry rather than a per-clip cap, so an officer can record three short
    // clips at one door instead of being forced into one long take.
    const MAX_PHOTOS = 5;
    const VIDEO_TOTAL_SECONDS = 60;
    const AUDIO_TOTAL_SECONDS = 15 * 60;

    // Byte ceilings are a backstop against a pathological file, not the real
    // control — duration is. Generous on purpose.
    const MAX_BYTES = {
        image: 12 * 1024 * 1024,
        video: 128 * 1024 * 1024,
        audio: 64 * 1024 * 1024
    };

    // A clip shorter than this is a mis-tap, not evidence.
    const MIN_CLIP_SECONDS = 1;
    // Below this there is no room left to record anything meaningful.
    const MIN_USEFUL_BUDGET = 2;

    const IMAGE_MAX_EDGE = 1600;
    const IMAGE_QUALITY = 0.8;

    const VIDEO_BITS_PER_SECOND = 1500000;
    const AUDIO_BITS_PER_SECOND = 64000;

    const KIND_LABEL = { image: 'photo', video: 'video', audio: 'audio clip' };
    const KIND_PLURAL = { image: 'photos', video: 'videos', audio: 'audio clips' };

    const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="112">' +
        '<rect width="160" height="112" fill="#0f1721"/>' +
        '<text x="50%" y="50%" fill="#3a8" font-size="11" text-anchor="middle" dy=".3em">Loading\u2026</text>' +
        '</svg>');

    // ── Host wiring ──────────────────────────────────────────────────────
    // The host owns persistence and user feedback; this module never writes
    // localStorage and never calls alert().
    let _host = {
        persist: null,   // () => void   — save the case entry list
        rerender: null,  // () => void   — re-render the canvas tab
        toast: null,     // (msg, kind) => void
        confirm: null    // async (msg, opts) => bool
    };

    function configure(opts) {
        _host = Object.assign({}, _host, opts || {});
    }

    function _notify(msg, kind) {
        try {
            if (typeof _host.toast === 'function') { _host.toast(msg, kind || 'info'); return; }
            if (typeof global.viperToast === 'function') { global.viperToast(msg, kind || 'info'); return; }
            if (typeof global.showToast === 'function') { global.showToast(msg, kind || 'info'); return; }
        } catch (_) {}
        console.log('[canvas-media]', msg);
    }

    async function _confirm(msg) {
        try {
            if (typeof _host.confirm === 'function') return await _host.confirm(msg, { danger: true, okText: 'Remove' });
            if (typeof global.viperConfirm === 'function') return await global.viperConfirm(msg, { danger: true, okText: 'Remove' });
        } catch (_) {}
        return true;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function prettySize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1048576) return Math.round(n / 1024) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function formatClock(sec) {
        const s = Math.max(0, Math.round(Number(sec) || 0));
        const m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }

    // ── Editing state ────────────────────────────────────────────────────
    // `saved`   — items already on disk from a previous save.
    // `removed` — file names the officer struck out this session. Deleted on
    //             commit, NOT now, so Cancel really cancels.
    // `staged`  — blobs captured this session, not yet on disk.
    let _state = null;

    function _blank() {
        return { caseNumber: '', label: '', saved: [], removed: [], staged: [], seq: 1, recording: false };
    }

    function _liveSaved() {
        if (!_state) return [];
        return _state.saved.filter(m => _state.removed.indexOf(m.fileName) === -1);
    }

    function _countOf(kind) {
        if (!_state) return 0;
        return _liveSaved().filter(m => m.kind === kind).length
            + _state.staged.filter(m => m.kind === kind).length;
    }

    function _secondsOf(kind) {
        if (!_state) return 0;
        const add = (acc, m) => acc + (Number(m.durationSec) || 0);
        return _liveSaved().filter(m => m.kind === kind).reduce(add, 0)
            + _state.staged.filter(m => m.kind === kind).reduce(add, 0);
    }

    function _budgetFor(kind) {
        return kind === 'video' ? VIDEO_TOTAL_SECONDS : AUDIO_TOTAL_SECONDS;
    }

    /** Seconds left in the duration budget for a recordable kind. */
    function _remaining(kind) {
        return Math.max(0, _budgetFor(kind) - _secondsOf(kind));
    }

    // ── Attach bar markup ────────────────────────────────────────────────
    function attachBarHtml() {
        return `
            <div class="cm-attach" id="cmAttach">
                <div class="cm-attach-head">
                    <label class="cm-attach-title">Photos, Video &amp; Audio</label>
                    <span class="cm-attach-count" id="cmCount"></span>
                </div>
                <div class="cm-attach-btns">
                    <button type="button" class="cm-attach-btn" id="cmBtnPhoto">
                        <span class="cm-glyph">&#128247;</span>Add Photos
                    </button>
                    <button type="button" class="cm-attach-btn" id="cmBtnVideo">
                        <span class="cm-glyph">&#127909;</span>Record Video
                    </button>
                    <button type="button" class="cm-attach-btn" id="cmBtnAudio">
                        <span class="cm-glyph">&#127908;</span>Record Audio
                    </button>
                </div>
                <input type="file" id="cmPhotoInput" accept="image/*" multiple hidden>
                <div class="cm-thumbs" id="cmThumbs"></div>
                <p class="cm-note" id="cmNote"></p>
            </div>`;
    }

    function _recOverlayHtml() {
        return `
            <div class="cm-rec-overlay" id="cmRecOverlay">
                <video id="cmRecPreview" playsinline muted></video>
                <div class="cm-rec-timer" id="cmRecTimer">0:00</div>
                <div class="cm-rec-sub" id="cmRecSub"></div>
                <div class="cm-rec-actions">
                    <button type="button" class="cm-rec-cancel" id="cmRecCancel">Discard</button>
                    <button type="button" class="cm-rec-stop" id="cmRecStop">Stop &amp; Keep</button>
                </div>
            </div>`;
    }

    // ── Mount / unmount ──────────────────────────────────────────────────
    function mount(opts) {
        const o = opts || {};
        _state = _blank();
        _state.caseNumber = String(o.caseNumber || '');
        _state.label = String(o.label || '');
        _state.saved = (Array.isArray(o.media) ? o.media : []).map(m => Object.assign({}, m));

        const byId = (id) => document.getElementById(id);
        const btnPhoto = byId('cmBtnPhoto');
        const btnVideo = byId('cmBtnVideo');
        const btnAudio = byId('cmBtnAudio');
        const photoInput = byId('cmPhotoInput');
        if (!btnPhoto || !photoInput) return;

        if (!byId('cmRecOverlay')) {
            document.body.insertAdjacentHTML('beforeend', _recOverlayHtml());
            byId('cmRecStop').addEventListener('click', () => _finishRecording(true));
            byId('cmRecCancel').addEventListener('click', () => _finishRecording(false));
        }

        btnPhoto.addEventListener('click', () => photoInput.click());
        photoInput.addEventListener('change', _onPhotosPicked);
        if (btnVideo) btnVideo.addEventListener('click', () => _startRecording('video'));
        if (btnAudio) btnAudio.addEventListener('click', () => _startRecording('audio'));

        // Recording needs a camera/mic and MediaRecorder. If the platform has
        // neither, say so once rather than failing on click.
        const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder);
        if (!canRecord) {
            if (btnVideo) btnVideo.disabled = true;
            if (btnAudio) btnAudio.disabled = true;
        }
        _state.canRecord = canRecord;

        _renderThumbs();
        if (!canRecord) {
            _note('This device cannot record in-app. Photos can still be attached.', true);
        }
    }

    function unmount() {
        try { _finishRecording(false); } catch (_) {}
        if (_state) {
            _state.staged.forEach(i => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
        }
        const ov = document.getElementById('cmRecOverlay');
        if (ov) ov.remove();
        _state = null;
    }

    function _note(text, warn) {
        const el = document.getElementById('cmNote');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('warn', !!warn);
    }

    function _defaultNote() {
        const vRem = _remaining('video');
        const aRem = _remaining('audio');
        _note(
            'Up to ' + MAX_PHOTOS + ' photos, ' + formatClock(VIDEO_TOTAL_SECONDS) + ' of video and ' +
            formatClock(AUDIO_TOTAL_SECONDS) + ' of audio per entry. ' +
            'Remaining: ' + formatClock(vRem) + ' video, ' + formatClock(aRem) + ' audio. ' +
            'Files are saved with the case, not in the browser.',
            false
        );
    }

    // ── Thumbnail strip (the editing view) ───────────────────────────────
    function _renderThumbs() {
        const wrap = document.getElementById('cmThumbs');
        if (!wrap || !_state) return;
        wrap.innerHTML = '';

        const cell = (opts) => {
            const d = document.createElement('div');
            d.className = 'cm-thumb' + (opts.busy ? ' busy' : '') + (opts.onDisk ? ' on-disk' : '');
            if (opts.imgSrc) {
                const img = document.createElement('img');
                img.src = opts.imgSrc;
                img.alt = '';
                d.appendChild(img);
            } else {
                const g = document.createElement('span');
                g.className = 'cm-thumb-glyph';
                g.textContent = opts.glyph || '\u25CF';
                d.appendChild(g);
            }
            const meta = document.createElement('span');
            meta.className = 'cm-thumb-meta';
            meta.textContent = opts.meta || '';
            d.appendChild(meta);
            const kill = document.createElement('button');
            kill.type = 'button';
            kill.className = 'cm-thumb-kill';
            kill.title = opts.killTitle || 'Remove';
            kill.setAttribute('aria-label', opts.killTitle || 'Remove');
            kill.textContent = '\u00D7';
            kill.onclick = opts.onKill;
            d.appendChild(kill);
            if (opts.badge) {
                const b = document.createElement('span');
                b.className = 'cm-thumb-badge';
                b.textContent = opts.badge;
                d.appendChild(b);
            }
            wrap.appendChild(d);
        };

        // Glyph shown when there is no picture to show — a clip, or a photo
        // whose preview could not be built. Must follow the KIND, otherwise
        // a photo that failed to preview appears as an audio clip.
        const glyphFor = (kind) => kind === 'video' ? '\u25B6'
                                 : kind === 'audio' ? '\u266A'
                                 : '\u{1F4F7}';

        // Already on disk. Shown with a "saved" badge so the officer can tell
        // what is new in this sitting from what was already there.
        _liveSaved().forEach(m => {
            cell({
                onDisk: true,
                imgSrc: m.kind === 'image' ? (_urlCache.get(m.fileName) || PLACEHOLDER) : null,
                glyph: glyphFor(m.kind),
                meta: m.kind === 'image' ? prettySize(m.bytes) : formatClock(m.durationSec),
                badge: 'saved',
                killTitle: 'Remove this ' + KIND_LABEL[m.kind],
                onKill: () => _removeSavedInEditor(m.fileName)
            });
            if (m.kind === 'image' && !_urlCache.has(m.fileName)) {
                _resolveUrl(_state.caseNumber, m).then(() => _renderThumbs()).catch(() => {});
            }
        });

        _state.staged.forEach(item => {
            cell({
                busy: false,
                imgSrc: item.kind === 'image' ? item.previewUrl : null,
                glyph: glyphFor(item.kind),
                meta: item.kind === 'image' ? prettySize(item.bytes) : formatClock(item.durationSec),
                killTitle: 'Remove this ' + KIND_LABEL[item.kind],
                onKill: () => _removeStaged(item.id)
            });
        });

        const parts = [];
        ['image', 'video', 'audio'].forEach(k => {
            const n = _countOf(k);
            if (!n) return;
            parts.push(k === 'image'
                ? n + ' ' + (n === 1 ? 'photo' : 'photos')
                : n + ' ' + (n === 1 ? KIND_LABEL[k] : KIND_PLURAL[k]) + ' (' + formatClock(_secondsOf(k)) + ')');
        });
        const countEl = document.getElementById('cmCount');
        if (countEl) countEl.textContent = parts.join(' \u00B7 ');

        _syncButtons();
        _defaultNote();
    }

    function _syncButtons() {
        if (!_state) return;
        const rec = _state.recording;
        const btnPhoto = document.getElementById('cmBtnPhoto');
        const btnVideo = document.getElementById('cmBtnVideo');
        const btnAudio = document.getElementById('cmBtnAudio');
        if (btnPhoto) btnPhoto.disabled = rec || _countOf('image') >= MAX_PHOTOS;
        if (btnVideo) btnVideo.disabled = rec || !_state.canRecord || _remaining('video') < MIN_USEFUL_BUDGET;
        if (btnAudio) btnAudio.disabled = rec || !_state.canRecord || _remaining('audio') < MIN_USEFUL_BUDGET;
    }

    function _removeStaged(id) {
        if (!_state) return;
        const i = _state.staged.findIndex(x => x.id === id);
        if (i === -1) return;
        if (_state.staged[i].previewUrl) URL.revokeObjectURL(_state.staged[i].previewUrl);
        _state.staged.splice(i, 1);
        _renderThumbs();
    }

    async function _removeSavedInEditor(fileName) {
        if (!_state) return;
        const ok = await _confirm('Remove this file from the canvass entry? It will be deleted from the case folder when you save.');
        if (!ok) return;
        if (_state.removed.indexOf(fileName) === -1) _state.removed.push(fileName);
        _renderThumbs();
    }

    // ── Staging ──────────────────────────────────────────────────────────
    function _stage(kind, blob, mime, durationSec, previewUrl) {
        if (!_state) return false;
        const cleanup = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };

        if (kind === 'image' && _countOf('image') >= MAX_PHOTOS) {
            _note('This entry already has the maximum of ' + MAX_PHOTOS + ' photos.', true);
            cleanup();
            return false;
        }
        if (kind !== 'image') {
            const rem = _remaining(kind);
            const dur = Math.round(Number(durationSec) || 0);
            if (dur < MIN_CLIP_SECONDS) {
                _note('That recording was too short to keep.', true);
                cleanup();
                return false;
            }
            if (dur > rem) {
                _note('That clip is ' + formatClock(dur) + ' but only ' + formatClock(rem) +
                      ' of ' + kind + ' is left for this entry. It was not attached.', true);
                cleanup();
                return false;
            }
        }
        if (blob.size > MAX_BYTES[kind]) {
            _note('That ' + KIND_LABEL[kind] + ' is ' + prettySize(blob.size) + ', over the ' +
                  prettySize(MAX_BYTES[kind]) + ' limit. It was not attached.', true);
            cleanup();
            return false;
        }

        _state.staged.push({
            id: _state.seq++,
            kind: kind,
            mime: mime || blob.type || '',
            bytes: blob.size,
            durationSec: kind === 'image' ? 0 : Math.round(Number(durationSec) || 0),
            blob: blob,
            previewUrl: previewUrl || null,
            source: kind === 'image' ? 'attached' : 'recorded'
        });
        _renderThumbs();
        return true;
    }

    // ── Photos ───────────────────────────────────────────────────────────
    async function _onPhotosPicked() {
        const input = document.getElementById('cmPhotoInput');
        if (!input) return;
        const files = Array.from(input.files || []);
        input.value = '';
        let skipped = 0;
        for (const file of files) {
            if (_countOf('image') >= MAX_PHOTOS) { skipped++; continue; }
            try {
                const shrunk = await _downscaleImage(file);
                _stage('image', shrunk, 'image/jpeg', 0, URL.createObjectURL(shrunk));
            } catch (err) {
                _note('"' + (file.name || 'That photo') + '" could not be read as an image.', true);
            }
        }
        if (skipped > 0) {
            _note('Only the first ' + MAX_PHOTOS + ' photos were attached; ' + skipped + ' more were not.', true);
        }
    }

    /**
     * Shrink to a 1600px long edge at JPEG q0.8 before storing.
     * A phone or body-cam frame is 4-12MB; nothing downstream benefits from
     * that, and the case folder has to travel to the DA.
     */
    async function _downscaleImage(file) {
        const src = await _loadImageSource(file);
        const w0 = src.width, h0 = src.height;
        if (!w0 || !h0) throw new Error('no dimensions');
        const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(src, 0, 0, w, h);
        if (src.close) src.close();
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', IMAGE_QUALITY));
        if (!blob) throw new Error('encode failed');
        return blob;
    }

    async function _loadImageSource(file) {
        if (global.createImageBitmap) {
            try {
                return await createImageBitmap(file, { imageOrientation: 'from-image' });
            } catch (err) {
                try { return await createImageBitmap(file); } catch (err2) {}
            }
        }
        return await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
            img.src = url;
        });
    }

    // ── Video and audio recording ────────────────────────────────────────
    let _rec = null;

    function _pickMime(kind) {
        const cands = kind === 'video'
            ? ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
            : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
        for (const c of cands) {
            try {
                if (global.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
            } catch (_) {}
        }
        return '';
    }

    async function _startRecording(kind) {
        if (!_state || _state.recording) return;
        const maxSec = _remaining(kind);
        if (maxSec < MIN_USEFUL_BUDGET) {
            _note('There is no ' + kind + ' time left for this entry.', true);
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(kind === 'video'
                ? { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true }
                : { audio: true });
        } catch (err) {
            _note('Access to the ' + (kind === 'video' ? 'camera' : 'microphone') +
                  ' was blocked or no device was found. Allow it in Windows privacy settings to record ' +
                  KIND_PLURAL[kind] + '.', true);
            return;
        }

        const mime = _pickMime(kind);
        let rec;
        try {
            const opts = mime ? { mimeType: mime } : {};
            if (kind === 'video') opts.videoBitsPerSecond = VIDEO_BITS_PER_SECOND;
            opts.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
            rec = new MediaRecorder(stream, opts);
        } catch (err) {
            stream.getTracks().forEach(t => t.stop());
            _note('This device cannot record ' + KIND_PLURAL[kind] + '.', true);
            return;
        }

        const chunks = [];
        rec.ondataavailable = ev => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };

        _state.recording = true;
        _syncButtons();

        const overlay = document.getElementById('cmRecOverlay');
        const preview = document.getElementById('cmRecPreview');
        const timer = document.getElementById('cmRecTimer');
        const sub = document.getElementById('cmRecSub');

        _rec = { kind, rec, stream, chunks, mime: rec.mimeType || mime || '', keep: true, timer: null, elapsed: 0 };

        if (kind === 'video' && preview) {
            preview.style.display = 'block';
            preview.srcObject = stream;
            preview.play().catch(() => {});
        } else if (preview) {
            preview.style.display = 'none';
        }
        if (overlay) overlay.classList.add('open');

        if (timer) timer.innerHTML = '<span class="cm-rec-dot"></span>0:00';
        if (sub) {
            sub.textContent = 'Stops automatically at ' + formatClock(maxSec) +
                ' \u2014 the ' + kind + ' time remaining for this entry.';
        }

        _rec.timer = setInterval(() => {
            if (!_rec) return;
            _rec.elapsed++;
            if (timer) timer.innerHTML = '<span class="cm-rec-dot"></span>' + formatClock(_rec.elapsed);
            if (_rec.elapsed >= maxSec) _finishRecording(true);
        }, 1000);

        rec.onstop = () => {
            const st = _rec;
            _rec = null;
            if (!st) return;
            clearInterval(st.timer);
            try { st.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
            if (preview) preview.srcObject = null;
            if (overlay) overlay.classList.remove('open');
            if (_state) _state.recording = false;

            if (st.keep && st.chunks.length > 0) {
                const type = st.mime || (st.kind === 'video' ? 'video/mp4' : 'audio/mp4');
                _stage(st.kind, new Blob(st.chunks, { type }), type, st.elapsed, null);
            } else {
                _renderThumbs();
            }
        };

        rec.start(1000);
    }

    function _finishRecording(keep) {
        if (!_rec) return;
        _rec.keep = keep;
        try { _rec.rec.stop(); } catch (err) {}
    }

    // ── Commit ───────────────────────────────────────────────────────────
    function _extFor(kind, mime) {
        const m = String(mime || '').toLowerCase();
        if (kind === 'image') {
            if (m.indexOf('png') !== -1) return 'png';
            if (m.indexOf('webp') !== -1) return 'webp';
            return 'jpg';
        }
        if (kind === 'video') {
            if (m.indexOf('webm') !== -1) return 'webm';
            return 'mp4';
        }
        if (m.indexOf('webm') !== -1) return 'weba';
        if (m.indexOf('mpeg') !== -1) return 'mp3';
        if (m.indexOf('wav') !== -1) return 'wav';
        return 'm4a';
    }

    function _slug(s) {
        return String(s || '')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'entry';
    }

    function _blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                const s = String(fr.result || '');
                const comma = s.indexOf(',');
                resolve(comma === -1 ? '' : s.slice(comma + 1));
            };
            fr.onerror = () => reject(fr.error || new Error('read failed'));
            fr.readAsDataURL(blob);
        });
    }

    /**
     * Write every staged blob to disk and delete everything the officer
     * struck out, then hand back the entry's final media array.
     *
     * A file that fails to write is reported and dropped from the array —
     * never recorded as present when it is not on disk. Deletions run last
     * so a write failure cannot also cost the officer an old file.
     *
     * Returns `media: null` when there is no editor mounted. That is NOT the
     * same as "this entry has no media" and the caller must not treat it as
     * an empty array — doing so would silently strip an existing entry's
     * files off its record and leave them orphaned on disk.
     */
    async function commit() {
        if (!_state) return { media: null, errors: [], mounted: false };
        const api = global.electronAPI;
        const errors = [];
        const out = _liveSaved().map(m => Object.assign({}, m));

        if (_state.staged.length && !(api && api.canvasSaveMedia)) {
            return {
                media: out,
                mounted: true,
                errors: ['Photos, video and audio need the VIPER desktop app to be saved. Nothing was attached.']
            };
        }

        const datePart = new Date().toISOString().slice(0, 10);
        const slug = _slug(_state.label);
        let n = out.length + 1;

        for (const item of _state.staged) {
            const ext = _extFor(item.kind, item.mime);
            const word = item.kind === 'image' ? 'photo' : item.kind;
            const fileName = 'Canvas ' + datePart + ' ' + slug + ' ' + word + ' ' + n + '.' + ext;
            try {
                const dataBase64 = await _blobToBase64(item.blob);
                const res = await api.canvasSaveMedia({
                    caseNumber: _state.caseNumber,
                    fileName: fileName,
                    dataBase64: dataBase64
                });
                if (!res || !res.success) {
                    errors.push('A ' + KIND_LABEL[item.kind] + ' could not be saved: ' + ((res && res.error) || 'unknown error'));
                    continue;
                }
                out.push({
                    id: 'cm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    kind: item.kind,
                    fileName: res.fileName,
                    mime: item.mime,
                    bytes: res.size || item.bytes,
                    durationSec: item.durationSec || 0,
                    capturedAt: new Date().toISOString(),
                    source: item.source,
                    discoverable: true
                });
                n++;
            } catch (err) {
                errors.push('A ' + KIND_LABEL[item.kind] + ' could not be saved: ' + ((err && err.message) || String(err)));
            }
        }

        if (_state.removed.length && api && api.canvasDeleteMedia) {
            try {
                await api.canvasDeleteMedia({ caseNumber: _state.caseNumber, fileNames: _state.removed.slice() });
            } catch (err) {
                // The entry no longer references them either way; a leftover
                // file is recoverable, a dangling reference is not.
                console.warn('[canvas-media] delete failed:', err);
            }
        }

        _state.staged.forEach(i => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
        return { media: out, errors, mounted: true };
    }

    /** Delete every file behind an entry. Used when the entry itself goes. */
    async function deleteAll(caseNumber, media) {
        const names = (Array.isArray(media) ? media : []).map(m => m && m.fileName).filter(Boolean);
        if (!names.length) return;
        const api = global.electronAPI;
        if (!api || !api.canvasDeleteMedia) return;
        try {
            await api.canvasDeleteMedia({ caseNumber: String(caseNumber || ''), fileNames: names });
        } catch (err) {
            console.warn('[canvas-media] deleteAll failed:', err);
        }
    }

    // ── Playback ─────────────────────────────────────────────────────────
    // Object URLs keyed by file name, so collapsing and re-opening an entry
    // does not re-read bytes off disk.
    const _urlCache = new Map();
    const _failed = new Map();

    function _b64ToBlob(b64, mime) {
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || 'application/octet-stream' });
    }

    function _mimeFor(m) {
        if (m && m.mime) return m.mime;
        const ext = String((m && m.fileName) || '').split('.').pop().toLowerCase();
        switch (ext) {
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'png': return 'image/png';
            case 'webp': return 'image/webp';
            case 'mp4': case 'mov': return 'video/mp4';
            case 'webm': return 'video/webm';
            case 'm4a': return 'audio/mp4';
            case 'mp3': return 'audio/mpeg';
            case 'weba': return 'audio/webm';
            case 'wav': return 'audio/wav';
            default:
                return m && m.kind === 'image' ? 'image/jpeg'
                    : m && m.kind === 'video' ? 'video/mp4' : 'audio/mp4';
        }
    }

    async function _resolveUrl(caseNumber, m) {
        if (!m || !m.fileName) return null;
        if (_urlCache.has(m.fileName)) return _urlCache.get(m.fileName);
        const api = global.electronAPI;
        if (!api || !api.canvasReadMedia) throw new Error('Desktop app required');
        const res = await api.canvasReadMedia({ caseNumber: String(caseNumber || ''), fileName: m.fileName });
        if (!res || !res.success) throw new Error((res && res.error) || 'Could not read file');
        const url = URL.createObjectURL(_b64ToBlob(res.dataBase64, _mimeFor(m)));
        _urlCache.set(m.fileName, url);
        return url;
    }

    /**
     * Gallery for the entry detail view.
     *
     * Images render as a grid and decode as soon as the view is hydrated.
     * Video and audio wait to be asked — they are the large ones, and an
     * entry can carry several.
     */
    function galleryHtml(entry, entryIndex) {
        const media = (entry && Array.isArray(entry.media)) ? entry.media : [];
        if (!media.length) return '';

        const photos = media.filter(m => m.kind === 'image');
        const clips = media.filter(m => m.kind !== 'image');

        const head = `
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-xl font-bold text-viper-green">Photos, Video &amp; Audio</h3>
                <span class="text-sm text-gray-400">${esc(_summaryText(media))}</span>
            </div>`;

        const tile = (m, i) => {
            const idx = media.indexOf(m);
            const flag = m.discoverable === false;
            const discChip = `
                <button type="button"
                        class="cm-disc ${flag ? 'off' : 'on'}"
                        title="${flag ? 'Withheld from the DA export package' : 'Included in the DA export package'}"
                        onclick="CanvasMedia.toggleDiscoverable(${entryIndex}, ${idx})">
                    ${flag ? '\u2298 Not Discoverable' : '\u2713 Discoverable'}
                </button>`;

            if (m.kind === 'image') {
                return `
                    <div class="cm-tile">
                        <button type="button" class="cm-tile-body"
                                onclick="CanvasMedia.openLightbox(${entryIndex}, ${idx})"
                                title="${esc(m.fileName)}">
                            <img src="${PLACEHOLDER}" alt="" data-cm-file="${esc(m.fileName)}" data-cm-idx="${idx}">
                        </button>
                        <div class="cm-tile-foot">
                            <span class="cm-tile-name" title="${esc(m.fileName)}">${esc(m.fileName)}</span>
                            <span class="cm-tile-size">${esc(prettySize(m.bytes))}</span>
                        </div>
                        <div class="cm-tile-actions">
                            ${discChip}
                            <button type="button" class="cm-del" title="Delete this photo"
                                    onclick="CanvasMedia.removeOne(${entryIndex}, ${idx})">Delete</button>
                        </div>
                    </div>`;
            }

            const isVideo = m.kind === 'video';
            return `
                <div class="cm-tile">
                    <div class="cm-tile-body cm-clip" id="cmClip_${entryIndex}_${idx}">
                        <button type="button" class="cm-load"
                                onclick="CanvasMedia.loadClip(${entryIndex}, ${idx})">
                            <span class="cm-load-glyph">${isVideo ? '\u25B6' : '\u266A'}</span>
                            <span class="cm-load-text">Play ${isVideo ? 'video' : 'audio'} \u00B7 ${esc(formatClock(m.durationSec))}</span>
                        </button>
                    </div>
                    <div class="cm-tile-foot">
                        <span class="cm-tile-name" title="${esc(m.fileName)}">${esc(m.fileName)}</span>
                        <span class="cm-tile-size">${esc(prettySize(m.bytes))}</span>
                    </div>
                    <div class="cm-tile-actions">
                        ${discChip}
                        <button type="button" class="cm-del" title="Delete this clip"
                                onclick="CanvasMedia.removeOne(${entryIndex}, ${idx})">Delete</button>
                    </div>
                </div>`;
        };

        const withheld = media.filter(m => m.discoverable === false).length;
        const withheldNote = withheld
            ? `<p class="cm-withheld">\u2298 ${withheld} item${withheld === 1 ? '' : 's'} marked Not Discoverable — withheld from the DA export package and its report.</p>`
            : '';

        return `
            <div class="glass-card rounded-xl p-6">
                ${head}
                ${photos.length ? `<div class="cm-grid">${photos.map(tile).join('')}</div>` : ''}
                ${clips.length ? `<div class="cm-grid cm-grid-wide">${clips.map(tile).join('')}</div>` : ''}
                ${withheldNote}
            </div>`;
    }

    function _summaryText(media) {
        const parts = [];
        ['image', 'video', 'audio'].forEach(k => {
            const items = media.filter(m => m.kind === k);
            if (!items.length) return;
            if (k === 'image') {
                parts.push(items.length + (items.length === 1 ? ' photo' : ' photos'));
            } else {
                const secs = items.reduce((a, m) => a + (Number(m.durationSec) || 0), 0);
                parts.push(items.length + ' ' + (items.length === 1 ? KIND_LABEL[k] : KIND_PLURAL[k]) +
                           ' (' + formatClock(secs) + ')');
            }
        });
        return parts.join(' \u00B7 ');
    }

    /** Compact indicator for the canvass table. */
    function summaryBadge(entry) {
        const media = (entry && Array.isArray(entry.media)) ? entry.media : [];
        if (!media.length) return '';
        const n = { image: 0, video: 0, audio: 0 };
        media.forEach(m => { if (n[m.kind] != null) n[m.kind]++; });
        const bits = [];
        if (n.image) bits.push('\u{1F4F7}' + n.image);
        if (n.video) bits.push('\u{1F3AC}' + n.video);
        if (n.audio) bits.push('\u{1F3A4}' + n.audio);
        return '<span class="cm-badge" title="' + esc(_summaryText(media)) + '">' + bits.join(' ') + '</span>';
    }

    /** Fill in the image tiles after the gallery HTML is in the DOM. */
    async function hydrate(root, caseNumber, entry) {
        const scope = root || document;
        const media = (entry && Array.isArray(entry.media)) ? entry.media : [];
        const imgs = scope.querySelectorAll('img[data-cm-file]:not([data-cm-resolved])');
        for (const img of imgs) {
            img.setAttribute('data-cm-resolved', '1');
            const fileName = img.getAttribute('data-cm-file');
            const m = media.find(x => x.fileName === fileName) || { fileName, kind: 'image' };
            try {
                const url = await _resolveUrl(caseNumber, m);
                if (url) img.src = url;
            } catch (err) {
                const msg = (err && err.message) || 'Could not load';
                _failed.set(fileName, msg);
                const parent = img.parentElement;
                if (parent) {
                    parent.innerHTML = '<span class="cm-missing">' + esc(msg) + '</span>';
                }
            }
        }
    }

    // ── Gallery interactions ─────────────────────────────────────────────
    // These are invoked from inline onclick in generated HTML, so they read
    // the entry list through the host rather than closing over it.
    function _entryAt(entryIndex) {
        try {
            const list = (typeof _host.getEntries === 'function') ? _host.getEntries() : null;
            if (!Array.isArray(list)) return null;
            return list[entryIndex] || null;
        } catch (_) { return null; }
    }

    function _caseNumber() {
        try { return (typeof _host.getCaseNumber === 'function') ? _host.getCaseNumber() : ''; }
        catch (_) { return ''; }
    }

    async function loadClip(entryIndex, mediaIndex) {
        const entry = _entryAt(entryIndex);
        if (!entry || !Array.isArray(entry.media)) return;
        const m = entry.media[mediaIndex];
        const box = document.getElementById('cmClip_' + entryIndex + '_' + mediaIndex);
        if (!m || !box) return;
        box.innerHTML = '<span class="cm-loading">Loading\u2026</span>';
        try {
            const url = await _resolveUrl(_caseNumber(), m);
            const tag = m.kind === 'video' ? 'video' : 'audio';
            box.innerHTML = '<' + tag + ' controls preload="metadata" src="' + esc(url) + '"></' + tag + '>';
        } catch (err) {
            box.innerHTML = '<span class="cm-missing">' + esc((err && err.message) || 'Could not load') + '</span>';
        }
    }

    async function openLightbox(entryIndex, mediaIndex) {
        const entry = _entryAt(entryIndex);
        if (!entry || !Array.isArray(entry.media)) return;
        const m = entry.media[mediaIndex];
        if (!m) return;
        let url;
        try { url = await _resolveUrl(_caseNumber(), m); }
        catch (err) { _notify((err && err.message) || 'Could not open that photo.', 'error'); return; }

        closeLightbox();
        const host = document.createElement('div');
        host.id = 'cmLightbox';
        host.className = 'cm-lightbox';
        host.onclick = (e) => { if (e.target === host) closeLightbox(); };
        host.innerHTML =
            '<button type="button" class="cm-lightbox-close" title="Close" onclick="CanvasMedia.closeLightbox()">\u00D7</button>' +
            '<figure><img src="' + esc(url) + '" alt="">' +
            '<figcaption>' + esc(m.fileName) + ' \u00B7 ' + esc(prettySize(m.bytes)) +
            (m.capturedAt ? ' \u00B7 attached ' + esc(new Date(m.capturedAt).toLocaleString()) : '') +
            '</figcaption></figure>';
        document.body.appendChild(host);
    }

    function closeLightbox() {
        const el = document.getElementById('cmLightbox');
        if (el) el.remove();
    }

    function toggleDiscoverable(entryIndex, mediaIndex) {
        const entry = _entryAt(entryIndex);
        if (!entry || !Array.isArray(entry.media)) return;
        const m = entry.media[mediaIndex];
        if (!m) return;
        m.discoverable = (m.discoverable === false);
        if (typeof _host.persist === 'function') _host.persist();
        _notify(m.discoverable
            ? 'Marked Discoverable — it will be included in the DA export package.'
            : 'Marked Not Discoverable — it will be withheld from the DA export package.',
            m.discoverable ? 'success' : 'info');
        if (typeof _host.rerender === 'function') _host.rerender();
    }

    async function removeOne(entryIndex, mediaIndex) {
        const entry = _entryAt(entryIndex);
        if (!entry || !Array.isArray(entry.media)) return;
        const m = entry.media[mediaIndex];
        if (!m) return;
        const ok = await _confirm('Delete "' + m.fileName + '" from this canvass entry? The file is removed from the case folder and cannot be recovered from here.');
        if (!ok) return;

        const api = global.electronAPI;
        if (api && api.canvasDeleteMedia) {
            try { await api.canvasDeleteMedia({ caseNumber: _caseNumber(), fileNames: [m.fileName] }); }
            catch (err) { /* reference goes either way */ }
        }
        if (_urlCache.has(m.fileName)) {
            try { URL.revokeObjectURL(_urlCache.get(m.fileName)); } catch (_) {}
            _urlCache.delete(m.fileName);
        }
        entry.media.splice(mediaIndex, 1);
        if (typeof _host.persist === 'function') _host.persist();
        _notify('Deleted.', 'success');
        if (typeof _host.rerender === 'function') _host.rerender();
    }

    /** File names the DA export must withhold, across every canvass entry. */
    function nonDiscoverableFileNames(entries) {
        const out = [];
        (Array.isArray(entries) ? entries : []).forEach(e => {
            ((e && Array.isArray(e.media)) ? e.media : []).forEach(m => {
                if (m && m.discoverable === false && m.fileName) out.push(m.fileName);
            });
        });
        return out;
    }

    function releaseUrls() {
        _urlCache.forEach(url => { try { URL.revokeObjectURL(url); } catch (_) {} });
        _urlCache.clear();
        _failed.clear();
    }

    global.CanvasMedia = {
        MAX_PHOTOS,
        VIDEO_TOTAL_SECONDS,
        AUDIO_TOTAL_SECONDS,
        MAX_BYTES,
        IMAGE_MAX_EDGE,
        configure,
        attachBarHtml,
        mount,
        unmount,
        commit,
        deleteAll,
        galleryHtml,
        summaryBadge,
        hydrate,
        loadClip,
        openLightbox,
        closeLightbox,
        toggleDiscoverable,
        removeOne,
        nonDiscoverableFileNames,
        releaseUrls,
        // exposed for tests
        _internals: {
            extFor: _extFor,
            slug: _slug,
            formatClock,
            prettySize,
            mimeFor: _mimeFor,
            summaryText: _summaryText,
            state: () => _state,
            stage: _stage,
            remaining: _remaining,
            countOf: _countOf,
            secondsOf: _secondsOf,
            setState: (s) => { _state = s; }
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
