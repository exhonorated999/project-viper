/**
 * canvas-media.test.js — plain node, no Electron needed.
 *
 *   node modules/area-canvas/__tests__/canvas-media.test.js
 *
 * The module is written for a browser, so this loads it into a vm context
 * with a minimal window/document stub. Everything exercised here is the
 * logic that decides what gets kept, what gets refused and what the DA
 * export withholds — the parts where a mistake costs evidence.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    ok(actual === expected, label + ' — got ' + JSON.stringify(actual) +
       ', expected ' + JSON.stringify(expected));
}

// ── Load the module ──────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'canvas-media.js'), 'utf8');

function makeSandbox() {
    const noop = () => {};
    const elements = new Map();
    const mkEl = (id) => ({
        id,
        style: {},
        className: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        children: [],
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        appendChild(c) { this.children.push(c); },
        addEventListener: noop,
        setAttribute: noop,
        getAttribute: () => null,
        querySelectorAll: () => [],
        remove: noop,
        click: noop
    });
    const document = {
        getElementById: (id) => {
            if (!elements.has(id)) elements.set(id, mkEl(id));
            return elements.get(id);
        },
        createElement: (tag) => mkEl(tag),
        querySelectorAll: () => [],
        body: { insertAdjacentHTML: noop, appendChild: noop }
    };
    const sandbox = {
        document,
        console,
        navigator: { mediaDevices: null },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
        Map, Set, Promise, Date, Math, JSON, Number, String, Array, Object,
        Blob: function (parts, o) { this.type = (o && o.type) || ''; this.size = 1; },
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        setInterval: () => 0,
        clearInterval: noop,
        MediaRecorder: undefined,
        electronAPI: undefined,
        _elements: elements
    };
    sandbox.window = sandbox;      // top-level `window.X = X` needs this
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox;
}

const sb = makeSandbox();
const CM = sb.CanvasMedia;
const I = CM._internals;

// ── 1. Limits match what the officer was told ────────────────────────────
console.log('\n1. Limits');
eq(CM.MAX_PHOTOS, 5, 'five photos per entry');
eq(CM.VIDEO_TOTAL_SECONDS, 60, 'one minute of video per entry');
eq(CM.AUDIO_TOTAL_SECONDS, 900, 'fifteen minutes of audio per entry');
eq(CM.IMAGE_MAX_EDGE, 1600, 'photos downscale to a 1600px long edge');

// ── 2. formatClock ───────────────────────────────────────────────────────
console.log('2. formatClock');
eq(I.formatClock(0), '0:00', 'zero');
eq(I.formatClock(9), '0:09', 'pads seconds');
eq(I.formatClock(60), '1:00', 'one minute');
eq(I.formatClock(900), '15:00', 'fifteen minutes');
eq(I.formatClock(61.4), '1:01', 'rounds');
eq(I.formatClock(-5), '0:00', 'never negative');
eq(I.formatClock(null), '0:00', 'null is zero');

// ── 3. prettySize ────────────────────────────────────────────────────────
console.log('3. prettySize');
eq(I.prettySize(0), '0 B', 'zero bytes');
eq(I.prettySize(512), '512 B', 'bytes');
eq(I.prettySize(2048), '2 KB', 'kilobytes');
eq(I.prettySize(1572864), '1.5 MB', 'megabytes');
eq(I.prettySize(undefined), '0 B', 'undefined is zero');

// ── 4. Extension mapping ─────────────────────────────────────────────────
console.log('4. extFor');
eq(I.extFor('image', 'image/jpeg'), 'jpg', 'jpeg');
eq(I.extFor('image', 'image/png'), 'png', 'png');
eq(I.extFor('image', 'image/webp'), 'webp', 'webp');
eq(I.extFor('image', ''), 'jpg', 'unknown image defaults to jpg');
eq(I.extFor('video', 'video/mp4'), 'mp4', 'mp4');
eq(I.extFor('video', 'video/webm;codecs=vp8,opus'), 'webm', 'webm with codecs');
eq(I.extFor('video', ''), 'mp4', 'unknown video defaults to mp4');
eq(I.extFor('audio', 'audio/mp4'), 'm4a', 'audio mp4 is m4a');
eq(I.extFor('audio', 'audio/webm;codecs=opus'), 'weba', 'audio webm is weba');
eq(I.extFor('audio', 'audio/mpeg'), 'mp3', 'mpeg is mp3');
eq(I.extFor('audio', 'audio/wav'), 'wav', 'wav');

// ── 5. Slug — file names must survive a Windows path ─────────────────────
console.log('5. slug');
eq(I.slug('123 Main St'), '123-Main-St', 'spaces become dashes');
eq(I.slug('Apt #4/B'), 'Apt-4-B', 'path and reserved characters stripped');
eq(I.slug(''), 'entry', 'empty falls back');
eq(I.slug(null), 'entry', 'null falls back');
eq(I.slug('   '), 'entry', 'whitespace-only falls back');
ok(I.slug('x'.repeat(200)).length <= 40, 'capped at 40 characters');
ok(!/[\\/:*?"<>|]/.test(I.slug('a:b*c?d"e<f>g|h')), 'no Windows-reserved characters survive');

// ── 6. mimeFor — playback must pick the right element ────────────────────
console.log('6. mimeFor');
eq(I.mimeFor({ mime: 'video/webm' }), 'video/webm', 'stored mime wins');
eq(I.mimeFor({ fileName: 'a.jpg' }), 'image/jpeg', 'jpg by extension');
eq(I.mimeFor({ fileName: 'a.JPG' }), 'image/jpeg', 'extension is case-insensitive');
eq(I.mimeFor({ fileName: 'a.png' }), 'image/png', 'png');
eq(I.mimeFor({ fileName: 'a.mp4' }), 'video/mp4', 'mp4');
eq(I.mimeFor({ fileName: 'a.mov' }), 'video/mp4', 'mov reads as mp4');
eq(I.mimeFor({ fileName: 'a.m4a' }), 'audio/mp4', 'm4a');
eq(I.mimeFor({ fileName: 'a.weba' }), 'audio/webm', 'weba');
eq(I.mimeFor({ fileName: 'a.xyz', kind: 'video' }), 'video/mp4', 'unknown falls back to kind');

// ── 7. The duration budget ───────────────────────────────────────────────
// This is the core of the user's "multiple clips as long as the total stays
// under the limit" decision, so it gets exercised hard.
console.log('7. duration budget');
function stateWith(saved, staged) {
    I.setState({
        caseNumber: 'CASE-1', label: 'door', saved: saved || [],
        removed: [], staged: staged || [], seq: 1, recording: false, canRecord: true
    });
}

stateWith([], []);
eq(I.remaining('video'), 60, 'a fresh entry has the whole video budget');
eq(I.remaining('audio'), 900, 'a fresh entry has the whole audio budget');

stateWith([{ kind: 'video', fileName: 'a.mp4', durationSec: 20 }], []);
eq(I.remaining('video'), 40, 'a saved 20s clip spends 20s');
eq(I.remaining('audio'), 900, 'video does not touch the audio budget');

stateWith(
    [{ kind: 'video', fileName: 'a.mp4', durationSec: 20 }],
    [{ kind: 'video', id: 's1', durationSec: 25, bytes: 1 }]
);
eq(I.remaining('video'), 15, 'saved and staged both count');
eq(I.countOf('video'), 2, 'two clips across saved and staged');

stateWith([
    { kind: 'video', fileName: 'a.mp4', durationSec: 30 },
    { kind: 'video', fileName: 'b.mp4', durationSec: 30 }
], []);
eq(I.remaining('video'), 0, 'budget can be spent exactly');

stateWith([{ kind: 'video', fileName: 'a.mp4', durationSec: 999 }], []);
eq(I.remaining('video'), 0, 'an over-long legacy clip clamps at zero, never negative');

// Striking a saved file out returns its time immediately — the officer
// should not have to save and reopen to reclaim the budget.
I.setState({
    caseNumber: 'C', label: '', removed: ['a.mp4'], staged: [], seq: 1, recording: false,
    saved: [{ kind: 'video', fileName: 'a.mp4', durationSec: 40 }]
});
eq(I.remaining('video'), 60, 'removing a saved clip gives its time back at once');
eq(I.countOf('video'), 0, 'and it stops counting toward the clip count');

// Audio budget in minutes.
stateWith([
    { kind: 'audio', fileName: 'a.m4a', durationSec: 300 },
    { kind: 'audio', fileName: 'b.m4a', durationSec: 300 }
], []);
eq(I.remaining('audio'), 300, 'two five-minute clips leave five minutes');
eq(I.secondsOf('audio'), 600, 'total audio seconds');

// Photos are a count, not a duration.
stateWith([
    { kind: 'image', fileName: '1.jpg' }, { kind: 'image', fileName: '2.jpg' },
    { kind: 'image', fileName: '3.jpg' }
], []);
eq(I.countOf('image'), 3, 'photo count');
eq(I.secondsOf('image'), 0, 'photos carry no duration');

// ── 8. Staging refusals ──────────────────────────────────────────────────
console.log('8. staging refusals');
function blob(size, type) { return { size: size, type: type || '' }; }

stateWith([
    { kind: 'image', fileName: '1.jpg' }, { kind: 'image', fileName: '2.jpg' },
    { kind: 'image', fileName: '3.jpg' }, { kind: 'image', fileName: '4.jpg' },
    { kind: 'image', fileName: '5.jpg' }
], []);
eq(I.stage('image', blob(1000, 'image/jpeg'), 'image/jpeg', 0, null), false,
   'the sixth photo is refused');
eq(I.state().staged.length, 0, 'and nothing was staged');

stateWith([], []);
eq(I.stage('image', blob(1000, 'image/jpeg'), 'image/jpeg', 0, null), true,
   'the first photo is accepted');
eq(I.state().staged.length, 1, 'and it is staged');

stateWith([], []);
eq(I.stage('video', blob(1000, 'video/mp4'), 'video/mp4', 0.4, null), false,
   'a sub-second clip is a mis-tap, not evidence');

stateWith([{ kind: 'video', fileName: 'a.mp4', durationSec: 50 }], []);
eq(I.stage('video', blob(1000, 'video/mp4'), 'video/mp4', 20, null), false,
   'a clip longer than the remaining budget is refused');
eq(I.stage('video', blob(1000, 'video/mp4'), 'video/mp4', 10, null), true,
   'a clip that exactly fits the remaining budget is accepted');

stateWith([], []);
eq(I.stage('image', blob(99 * 1024 * 1024, 'image/jpeg'), 'image/jpeg', 0, null), false,
   'a pathologically large photo is refused by the byte backstop');

// ── 9. summaryText ───────────────────────────────────────────────────────
console.log('9. summaryText');
eq(I.summaryText([]), '', 'nothing reads as nothing');
eq(I.summaryText([{ kind: 'image' }]), '1 photo', 'singular photo');
eq(I.summaryText([{ kind: 'image' }, { kind: 'image' }]), '2 photos', 'plural photos');
eq(I.summaryText([{ kind: 'video', durationSec: 30 }]), '1 video (0:30)', 'one video with its length');
eq(I.summaryText([
    { kind: 'video', durationSec: 30 }, { kind: 'video', durationSec: 15 }
]), '2 videos (0:45)', 'video durations are summed');
eq(I.summaryText([{ kind: 'audio', durationSec: 125 }]), '1 audio clip (2:05)', 'one audio clip');
eq(I.summaryText([
    { kind: 'image' }, { kind: 'video', durationSec: 10 }, { kind: 'audio', durationSec: 10 }
]), '1 photo \u00B7 1 video (0:10) \u00B7 1 audio clip (0:10)', 'mixed, in kind order');

// ── 10. Discovery Status — the DA export contract ────────────────────────
// Getting this wrong ships a withheld photo to the DA, so it is tested by
// shape rather than by trusting the caller.
console.log('10. nonDiscoverableFileNames');
eq(CM.nonDiscoverableFileNames([]).length, 0, 'no entries, nothing withheld');
eq(CM.nonDiscoverableFileNames(null).length, 0, 'null is tolerated');
eq(CM.nonDiscoverableFileNames([{}]).length, 0, 'an entry with no media');
eq(CM.nonDiscoverableFileNames([{ media: [] }]).length, 0, 'an entry with empty media');

const entries = [
    { media: [
        { fileName: 'a.jpg', discoverable: true },
        { fileName: 'b.jpg', discoverable: false }
    ] },
    { media: [
        { fileName: 'c.mp4', discoverable: false },
        { fileName: 'd.m4a' }                       // legacy: no flag at all
    ] }
];
const withheld = CM.nonDiscoverableFileNames(entries);
eq(withheld.length, 2, 'exactly the two flagged items');
ok(withheld.indexOf('b.jpg') !== -1, 'the flagged photo is withheld');
ok(withheld.indexOf('c.mp4') !== -1, 'the flagged video is withheld');
ok(withheld.indexOf('a.jpg') === -1, 'a discoverable item is NOT withheld');
ok(withheld.indexOf('d.m4a') === -1,
   'an item with no flag defaults to discoverable — absence of a flag must never withhold');

// Only `=== false` withholds. A truthy-but-odd value must not.
eq(CM.nonDiscoverableFileNames([{ media: [{ fileName: 'x', discoverable: 0 }] }]).length, 0,
   'falsy-but-not-false does not withhold');

// ── 11. summaryBadge ─────────────────────────────────────────────────────
console.log('11. summaryBadge');
eq(CM.summaryBadge({}), '', 'no media, no badge');
eq(CM.summaryBadge({ media: [] }), '', 'empty media, no badge');
ok(CM.summaryBadge({ media: [{ kind: 'image' }] }).indexOf('cm-badge') !== -1,
   'badge carries its class');
ok(CM.summaryBadge({ media: [{ kind: 'image' }, { kind: 'image' }] }).indexOf('2') !== -1,
   'badge shows the photo count');

// ── 12. galleryHtml ──────────────────────────────────────────────────────
console.log('12. galleryHtml');
eq(CM.galleryHtml({}, 0), '', 'no media renders nothing at all');
eq(CM.galleryHtml({ media: [] }, 0), '', 'empty media renders nothing');

const gal = CM.galleryHtml({ media: [
    { fileName: 'p.jpg', kind: 'image', bytes: 2048, discoverable: true },
    { fileName: 'v.mp4', kind: 'video', bytes: 4096, durationSec: 30, discoverable: false }
] }, 7);
ok(gal.indexOf('data-cm-file="p.jpg"') !== -1, 'photos emit a hydration hook');
ok(gal.indexOf('data-cm-file="v.mp4"') === -1, 'clips do not — they load on demand');
ok(gal.indexOf('cmClip_7_1') !== -1, 'the clip box is keyed by entry and media index');
ok(gal.indexOf('CanvasMedia.loadClip(7, 1)') !== -1, 'clip loads on request');
ok(gal.indexOf('CanvasMedia.openLightbox(7, 0)') !== -1, 'photo opens a lightbox');
ok(gal.indexOf('CanvasMedia.toggleDiscoverable(7, 0)') !== -1, 'each item has a discovery toggle');
ok(gal.indexOf('cm-disc on') !== -1, 'the discoverable item shows the "on" chip');
ok(gal.indexOf('cm-disc off') !== -1, 'the withheld item shows the "off" chip');
ok(gal.indexOf('Not Discoverable') !== -1, 'withheld state is stated in words, not colour alone');
ok(gal.indexOf('withheld from the DA export package') !== -1,
   'the consequence of the flag is spelled out');
ok(gal.indexOf('0:30') !== -1, 'the clip advertises its length before it is loaded');

// Index arithmetic: tiles are rendered in two grids (photos, then clips) but
// must address the ORIGINAL media array, not their position in the grid.
const gal2 = CM.galleryHtml({ media: [
    { fileName: 'v.mp4', kind: 'video', bytes: 1, durationSec: 5 },
    { fileName: 'p.jpg', kind: 'image', bytes: 1 }
] }, 0);
ok(gal2.indexOf('CanvasMedia.openLightbox(0, 1)') !== -1,
   'the photo keeps index 1 even though it renders in the first grid');
ok(gal2.indexOf('cmClip_0_0') !== -1,
   'the clip keeps index 0 even though it renders in the second grid');

// Escaping — a file name is not a trusted string.
const gal3 = CM.galleryHtml({ media: [
    { fileName: 'a"><img src=x onerror=alert(1)>.jpg', kind: 'image', bytes: 1 }
] }, 0);
ok(gal3.indexOf('<img src=x') === -1, 'a hostile file name cannot inject a tag');
ok(gal3.indexOf('&lt;img') !== -1, 'the angle brackets are escaped, so the payload is inert text');
ok(gal3.indexOf('&quot;') !== -1, 'quotes are escaped');

// ── 13. commit() with no editor mounted ──────────────────────────────────
// A bug here silently strips an entry's media off its record and orphans the
// files, so the "not mounted" case is explicitly distinguishable.
console.log('13. commit without a mounted editor');
I.setState(null);
CM.commit().then(res => {
    eq(res.media, null, 'media is null, NOT an empty array');
    eq(res.mounted, false, 'and the result says so plainly');
    ok(!Array.isArray(res.media),
       'the host guard `if (Array.isArray(res.media))` therefore leaves existing media alone');
    finish();
}).catch(err => { fail++; console.error('  FAIL: commit threw', err); finish(); });

function finish() {
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') +
                ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
}
