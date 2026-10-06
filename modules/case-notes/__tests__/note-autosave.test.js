/**
 * Case Notes autosave — the single-writer contract.
 *
 * An officer reported losing a note by clicking to another tab without
 * pressing Save. The fix routes the Save button, the five-minute timer,
 * the tab-switch hook, `beforeunload` and the pop-out through ONE writer,
 * `_noteCommit()`.
 *
 * That consolidation creates two ways to destroy an officer's work, and
 * this file exists to pin both:
 *
 *   THE DUPLICATE TRAP — an unsaved new note has `editingNoteId === null`
 *   and takes the insert branch. If a silent commit left it null, the next
 *   timer pass five minutes later would file a SECOND copy, and the one
 *   after that a third. The insert MUST promote `editingNoteId`.
 *
 *   THE DOUBLE-WRITE — the same attachment bytes must not be written to
 *   disk twice. Uploaded files move from `pendingNoteAttachments` to
 *   `savedNoteAttachments`, so a second commit against the same open form
 *   has nothing left to upload.
 *
 * Plus the `beforeunload` guarantee: `sync` mode must reach localStorage
 * with no `await` in front of it, because a page teardown cannot wait for
 * a promise.
 *
 * The logic lives inline in case-detail-with-analytics.html, so this test
 * LIFTS the shipping block and runs it in a vm. A copied block is the
 * thing that drifts.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\case-notes\__tests__\note-autosave.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html');
// The page is CRLF on disk. Normalise or the multi-line anchors below miss
// silently and the whole file passes against nothing.
const SRC = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- lift

const START = '// \u2500\u2500\u2500 Autosave';
const END = 'async function openNotePopout';
const a = SRC.indexOf(START);
const b = SRC.indexOf(END);
if (a < 0 || b < 0 || b <= a) {
    console.error('Could not locate the notes autosave block in the page. Anchors moved?');
    process.exit(1);
}
const BLOCK = SRC.slice(a, b);

// `const NOTE_AUTOSAVE_MS` and the two `let`s are lexical, so they never
// land on the sandbox global the way a function declaration does. Append a
// test-only hook rather than restructuring shipping code.
const HOOK = '\n;Object.assign(globalThis, {' +
    ' NOTE_AUTOSAVE_MS,' +
    ' _peekLastCommittedHtml: () => _noteLastCommittedHtml,' +
    ' _peekAutosaveTimer: () => _noteAutosaveTimer' +
    '});\n';

section('the lift');
check('block located in the page', BLOCK.length > 1000, BLOCK.length + ' chars');
check('block carries _noteCommit', /async function _noteCommit\(/.test(BLOCK));
check('block carries the thin saveNote', /async function saveNote\(event\)/.test(BLOCK));
check('block carries _noteAutosave', /async function _noteAutosave\(/.test(BLOCK));
check('block carries the start/stop pair',
    /function _noteStartAutosave\(/.test(BLOCK) && /function _noteStopAutosave\(/.test(BLOCK));
check('the duplicate trap is documented in shipping source',
    /THE DUPLICATE TRAP/.test(BLOCK));

// ------------------------------------------------------- fake platform

function makeStorage() {
    const data = Object.create(null);
    return {
        _data: data,
        writes: 0,
        getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem(k, v) { this.writes++; data[k] = String(v); },
        removeItem(k) { delete data[k]; }
    };
}

function makeEl(extra) {
    const el = Object.assign({
        innerHTML: '',
        textContent: '',
        _classes: new Set(),
        classList: null
    }, extra || {});
    el.classList = {
        contains: c => el._classes.has(c),
        add: c => el._classes.add(c),
        remove: c => el._classes.delete(c)
    };
    return el;
}

/**
 * @param {object} o
 *   o.formOpen   — is #noteForm mounted and visible
 *   o.editorHtml — starting editor content
 */
function build(o) {
    o = o || {};
    const localStorage = makeStorage();
    const toasts = [];
    const rendered = [];
    const attachmentCalls = [];
    const timers = [];

    const editor = makeEl({ innerHTML: o.editorHtml || '', innerText: '' });
    // innerText mirrors a crude text version of innerHTML — enough for the
    // emptiness gate, which is all the block asks of it.
    Object.defineProperty(editor, 'innerText', {
        get() { return String(this.innerHTML).replace(/<[^>]*>/g, '').trim(); }
    });
    const form = makeEl();
    if (!o.formOpen) form.classList.add('hidden');
    const stamp = makeEl();
    stamp.classList.add('hidden');

    const elements = {
        noteEditor: o.formOpen === false && o.noEditor ? null : editor,
        noteForm: o.formMissing ? null : form,
        noteAutosaveStatus: stamp
    };

    // Stands in for cases/<case>/Notes/ on disk.
    const fakeDisk = {};

    const sandbox = {
        console,
        localStorage,
        Date, Math, JSON, String, Array, Object, Promise, Error,
        RegExp, parseInt, isNaN,
        setTimeout, clearTimeout,

        setInterval(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return t; },
        clearInterval(t) { if (t) t.live = false; },

        // --- host state (top-level `let` in the real page) ---
        currentCase: { id: 'case-1', caseNumber: '25-55555' },
        caseNotes: o.caseNotes || [],
        editingNoteId: o.editingNoteId == null ? null : o.editingNoteId,
        pendingNoteAttachments: o.pending || [],
        savedNoteAttachments: o.saved || [],
        currentTab: 'notes',

        // --- host helpers ---
        // Wire the REAL storage module in. Note bodies with pasted pictures
        // are exactly what filled an officer's quota, and the offload is now
        // part of the commit path, so stubbing it out would hide the thing
        // most worth testing.
        _CS: require('../../_shared/case-storage.js'),
        _noteImagesToDisk(html) {
            return sandbox._CS.dehydrateHtml(html, (f) => {
                if (o.diskFails) return null;
                fakeDisk[f.fileName] = f.base64;
                return f.fileName;
            }, { kind: 'notes', stem: 'note-image' });
        },
        _noteImagesFromDisk(html) {
            return sandbox._CS.hydrateHtml(html, (r) => (
                fakeDisk[r.fileName] ? 'data:image/png;base64,' + fakeDisk[r.fileName] : null
            ));
        },
        viperToast: (m, k) => toasts.push({ m, k }),
        ensureCaseModule: () => {},
        renderTabContent: t => rendered.push(t),
        renderNoteAttachmentsList: () => {},
        _revealNoteDay: () => {},
        _persistCaseNotes() {
            // Mirrors the page: a real quota-guarded write that reports back.
            return sandbox._CS.setItemSafe('viperCaseNotes', JSON.stringify({
                [sandbox.currentCase.caseNumber]: sandbox.caseNotes
            }), { store: localStorage, label: 'this note' }).ok;
        },
        _collectNoteAssignments: () => (o.assignments === undefined ? [] : o.assignments),
        _fileToBase64: async () => 'BASE64',

        document: {
            getElementById: id => (id in elements ? elements[id] : null)
        }
    };

    sandbox.electronAPI = {
        noteSaveAttachment: async (args) => {
            attachmentCalls.push(args);
            return { success: true, fileName: args.fileName, size: 123 };
        }
    };
    // Renderer classes reach host globals through `window.x`; the sandbox
    // must be its own window or `window.electronAPI` is undefined.
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(BLOCK + HOOK, sandbox, { filename: 'case-notes-autosave.lifted.js' });

    return { sandbox, localStorage, toasts, rendered, attachmentCalls, timers, editor, form, stamp, fakeDisk };
}

// -------------------------------------------------------------- basics

section('constants and wiring');
{
    const t = build({ formOpen: true });
    check('autosave interval is five minutes', t.sandbox.NOTE_AUTOSAVE_MS === 5 * 60 * 1000,
        String(t.sandbox.NOTE_AUTOSAVE_MS));
    check('_noteCommit is callable', typeof t.sandbox._noteCommit === 'function');
    check('saveNote is callable', typeof t.sandbox.saveNote === 'function');
    check('_noteAutosave is callable', typeof t.sandbox._noteAutosave === 'function');
    check('_noteFormIsOpen sees a mounted visible form', t.sandbox._noteFormIsOpen() === true);

    const shut = build({ formOpen: false });
    check('_noteFormIsOpen sees a hidden form as closed', shut.sandbox._noteFormIsOpen() === false);
}

// ------------------------------------------------------ THE DUPLICATE TRAP

section('THE DUPLICATE TRAP — repeated silent commits update, never insert');
(async () => {
    const t = build({ formOpen: true, editorHtml: 'first pass' });
    const s = t.sandbox;

    const r1 = await s._noteCommit({ silent: true });
    check('first silent commit saves', r1.saved === true);
    check('  one note exists', s.caseNotes.length === 1, 'len=' + s.caseNotes.length);
    check('  editingNoteId was promoted off null', s.editingNoteId === r1.noteId,
        'editingNoteId=' + s.editingNoteId + ' noteId=' + r1.noteId);
    check('  returned a note id', typeof r1.noteId === 'number');
    check('  returned the createdAt of a fresh note', typeof r1.createdAt === 'string');

    t.editor.innerHTML = 'first pass, now longer';
    const r2 = await s._noteCommit({ silent: true });
    check('second silent commit saves', r2.saved === true);
    check('  STILL one note — no duplicate filed', s.caseNotes.length === 1,
        'len=' + s.caseNotes.length);
    check('  same note id returned', r2.noteId === r1.noteId);
    check('  content was updated in place',
        s.caseNotes[0].contentHtml === 'first pass, now longer', s.caseNotes[0].contentHtml);
    check('  createdAt is the ORIGINAL, not a new one',
        s.caseNotes[0].createdAt === r1.createdAt);
    check('  an edit was recorded', s.caseNotes[0].editHistory.length === 1,
        'editHistory=' + JSON.stringify(s.caseNotes[0].editHistory));

    t.editor.innerHTML = 'third';
    await s._noteCommit({ silent: true });
    check('third silent commit still leaves one note', s.caseNotes.length === 1,
        'len=' + s.caseNotes.length);
    check('  two edits now recorded', s.caseNotes[0].editHistory.length === 2);
    check('  no toast fired across three silent commits', t.toasts.length === 0,
        JSON.stringify(t.toasts));
    check('  silent commits never re-render the tab', t.rendered.length === 0,
        JSON.stringify(t.rendered));

    // ------------------------------------------------- THE DOUBLE-WRITE

    section('THE DOUBLE-WRITE — attachment bytes are uploaded exactly once');
    const t2 = build({
        formOpen: true,
        editorHtml: 'with a file',
        pending: [{ file: {}, fileName: 'photo.jpg', size: 99, type: 'image/jpeg' }]
    });
    const s2 = t2.sandbox;

    const a1 = await s2._noteCommit({ silent: true });
    check('commit with a pending attachment saves', a1.saved === true);
    check('  the file was uploaded once', t2.attachmentCalls.length === 1,
        'calls=' + t2.attachmentCalls.length);
    check('  pending list was drained', s2.pendingNoteAttachments.length === 0);
    check('  file moved into savedNoteAttachments', s2.savedNoteAttachments.length === 1);
    check('  note carries the attachment', s2.caseNotes[0].attachments.length === 1);
    check('  upload was addressed to the right case',
        t2.attachmentCalls[0].caseNumber === '25-55555');

    t2.editor.innerHTML = 'with a file, edited';
    await s2._noteCommit({ silent: true });
    check('second commit uploads NOTHING further', t2.attachmentCalls.length === 1,
        'calls=' + t2.attachmentCalls.length);
    check('  still one attachment on the note', s2.caseNotes[0].attachments.length === 1);
    check('  still one note', s2.caseNotes.length === 1);

    // -------------------------------------------------- dirty tracking

    section('dirty tracking — the timer never writes an unchanged note');
    const t3 = build({ formOpen: true, editorHtml: 'hello' });
    const s3 = t3.sandbox;

    s3._noteMarkClean();
    check('freshly marked clean is not dirty', s3._noteEditorIsDirty() === false);
    check('  baseline captured from the DOM, not the input string',
        s3._peekLastCommittedHtml() === 'hello');

    const clean = await s3._noteAutosave('timer');
    check('autosave on a clean form does not write', clean.saved === false);
    check('  and says why', clean.reason === 'clean', clean.reason);
    check('  nothing was filed', s3.caseNotes.length === 0);

    t3.editor.innerHTML = 'hello there';
    check('typing makes it dirty', s3._noteEditorIsDirty() === true);
    const dirty = await s3._noteAutosave('timer');
    check('autosave on a dirty form writes', dirty.saved === true);
    check('  one note filed', s3.caseNotes.length === 1);
    check('  commit reset the baseline, so it is clean again',
        s3._noteEditorIsDirty() === false);
    check('  the stamp was revealed', t3.stamp.classList.contains('hidden') === false);
    check('  the stamp reads as an autosave', /^Auto-saved /.test(t3.stamp.textContent),
        t3.stamp.textContent);
    check('  still silent — no toast', t3.toasts.length === 0, JSON.stringify(t3.toasts));

    const t4 = build({ formOpen: true, editorHtml: 'x' });
    t4.sandbox._noteMarkClean();
    t4.sandbox.pendingNoteAttachments.push({ file: {}, fileName: 'a.png', size: 1, type: 'image/png' });
    check('a queued attachment alone counts as dirty',
        t4.sandbox._noteEditorIsDirty() === true);

    const t5 = build({ formOpen: false, editorHtml: 'typed but form shut' });
    const shutResult = await t5.sandbox._noteAutosave('leave-tab');
    check('autosave with the form closed is a no-op', shutResult.saved === false);
    check('  and says why', shutResult.reason === 'form-closed', shutResult.reason);
    check('  nothing was filed', t5.sandbox.caseNotes.length === 0);

    // ---------------------------------------------------- emptiness gate

    section('an empty note is never filed');
    const t6 = build({ formOpen: true, editorHtml: '   ' });
    const empty = await t6.sandbox._noteCommit({ silent: true });
    check('empty editor does not save', empty.saved === false);
    check('  reason is empty', empty.reason === 'empty', empty.reason);
    check('  no note filed', t6.sandbox.caseNotes.length === 0);
    check('  silent mode stays quiet about it', t6.toasts.length === 0,
        JSON.stringify(t6.toasts));

    const t7 = build({ formOpen: true, editorHtml: '' });
    await t7.sandbox._noteCommit({ silent: false });
    check('explicit Save on an empty note DOES tell the officer', t7.toasts.length === 1,
        JSON.stringify(t7.toasts));
    check('  and it is advisory, not an error', t7.toasts[0].k === 'info', t7.toasts[0].k);

    const t8 = build({ formOpen: true, editorHtml: '<img src="data:image/png;base64,AAA">' });
    const imgOnly = await t8.sandbox._noteCommit({ silent: true });
    check('a pasted screenshot with no text still counts as content',
        imgOnly.saved === true);

    // ------------------------------- pasted pictures leave localStorage

    // The reported bug: "I have spent all day adding pictures to my notes
    // and wont let me save. Says not enough space." Every pasted screenshot
    // was being base64'd into a ~5MB storage area shared by the whole app.
    section('pasted pictures are moved to the case folder, not stored');

    const FATPNG = 'data:image/png;base64,' + 'A'.repeat(120000);
    const t20 = build({ formOpen: true, editorHtml: '<p>at the door</p><img src="' + FATPNG + '"><p>end</p>' });
    const r20 = await t20.sandbox._noteCommit({ silent: true });
    check('the note saves', r20.saved === true, r20.reason);
    const stored20 = t20.sandbox.caseNotes[0].contentHtml;
    check('  one file was written to the case folder',
        Object.keys(t20.fakeDisk).length === 1, JSON.stringify(Object.keys(t20.fakeDisk)));
    check('  the bytes are NOT in the stored note',
        stored20.indexOf('A'.repeat(1000)) === -1);
    check('  the stored note is tiny', stored20.length < 500, 'len=' + stored20.length);
    check('  it keeps a reference to the file',
        t20.sandbox._CS.diskImages(stored20).length === 1);
    check('  the officer\'s text is untouched',
        /<p>at the door<\/p>/.test(stored20) && /<p>end<\/p>/.test(stored20));
    check('  and what landed on disk is the real image',
        t20.fakeDisk[t20.sandbox._CS.diskImages(stored20)[0].fileName] === 'A'.repeat(120000));
    const back20 = await t20.sandbox._noteImagesFromDisk(stored20);
    check('  reading it back gives the picture again', back20.indexOf(FATPNG) !== -1);

    // A write that fails must keep the picture in the note rather than
    // silently drop it. A lost screenshot is evidence lost.
    const t21 = build({ formOpen: true, editorHtml: '<img src="' + FATPNG + '">', diskFails: true });
    const r21 = await t21.sandbox._noteCommit({ silent: false });
    check('a failed disk write still saves the note', r21.saved === true, r21.reason);
    check('  the picture stays in the note rather than vanishing',
        t21.sandbox.caseNotes[0].contentHtml.indexOf(FATPNG) !== -1);
    check('  and the officer is told', t21.toasts.some(t => /could not be moved to disk/i.test(t.m)),
        JSON.stringify(t21.toasts));

    // The close/quit flush cannot await a disk write. It must still not put
    // the hydrated bytes back, or closing the window would undo the space
    // the case just freed.
    const t22 = build({ formOpen: true, editorHtml: '<img src="' + FATPNG + '">' });
    await t22.sandbox._noteCommit({ silent: true });
    const lean22 = t22.sandbox.caseNotes[0].contentHtml;
    const wet22 = await t22.sandbox._noteImagesFromDisk(lean22);
    t22.sandbox.document.getElementById('noteEditor').innerHTML = wet22;
    t22.sandbox._noteCommit({ silent: true, sync: true });
    check('the close flush does not write the picture back into storage',
        t22.sandbox.caseNotes[0].contentHtml.indexOf('A'.repeat(1000)) === -1);
    check('  and it keeps the reference',
        t22.sandbox._CS.diskImages(t22.sandbox.caseNotes[0].contentHtml).length === 1);

    // A note with no pictures must not pay for any of this.
    const t23 = build({ formOpen: true, editorHtml: '<p>text only</p>' });
    await t23.sandbox._noteCommit({ silent: true });
    check('a plain-text note is stored verbatim',
        t23.sandbox.caseNotes[0].contentHtml === '<p>text only</p>');
    check('  and nothing was written to disk', Object.keys(t23.fakeDisk).length === 0);

    // Storage really is full: the commit must say so, not claim success.
    const t24 = build({ formOpen: true, editorHtml: '<p>a note</p>' });
    t24.sandbox._persistCaseNotes = () => false;
    const r24 = await t24.sandbox._noteCommit({ silent: true });
    check('a refused write reports the commit as FAILED', r24.saved === false);
    check('  with a quota reason', r24.reason === 'quota', r24.reason);

    // ------------------------------------- the beforeunload guarantee

    section('sync mode — beforeunload reaches storage with no await in front');
    const t9 = build({
        formOpen: true,
        editorHtml: 'half a sentence',
        pending: [{ file: {}, fileName: 'big.mp4', size: 999, type: 'video/mp4' }]
    });
    const s9 = t9.sandbox;

    // Deliberately NOT awaited. An `async` function body runs synchronously
    // until its first `await`; sync mode skips the upload loop, which holds
    // the only awaits, so the localStorage write must already have happened
    // by the time control returns here. This is the whole reason the flag
    // exists — `beforeunload` cannot wait for a promise.
    const pending9 = s9._noteCommit({ silent: true, sync: true });
    check('note reached caseNotes before the promise settled',
        s9.caseNotes.length === 1, 'len=' + s9.caseNotes.length);
    check('  localStorage was written synchronously', t9.localStorage.writes === 1,
        'writes=' + t9.localStorage.writes);
    check('  the officer\'s text survived',
        s9.caseNotes[0].contentHtml === 'half a sentence', s9.caseNotes[0].contentHtml);
    check('  no attachment upload was attempted', t9.attachmentCalls.length === 0);
    check('  the queued file was left alone rather than half-written',
        s9.pendingNoteAttachments.length === 1);
    const r9 = await pending9;
    check('  and it reports saved', r9.saved === true);

    // Contrast: the async path genuinely defers, which is exactly why
    // beforeunload cannot use it.
    const t10 = build({
        formOpen: true,
        editorHtml: 'async path',
        pending: [{ file: {}, fileName: 'x.png', size: 1, type: 'image/png' }]
    });
    const pending10 = t10.sandbox._noteCommit({ silent: true });
    check('async commit has NOT written by the next statement',
        t10.sandbox.caseNotes.length === 0, 'len=' + t10.sandbox.caseNotes.length);
    await pending10;
    check('  it lands once awaited', t10.sandbox.caseNotes.length === 1);

    // ------------------------------------------------- timer lifecycle

    section('timer lifecycle');
    const t11 = build({ formOpen: true, editorHtml: 'timer test' });
    const s11 = t11.sandbox;

    check('no timer before start', s11._peekAutosaveTimer() === null);
    s11._noteStartAutosave();
    check('start creates a timer', s11._peekAutosaveTimer() !== null);
    check('  registered at five minutes', t11.timers[0].ms === 5 * 60 * 1000);
    check('  exactly one timer', t11.timers.filter(x => x.live).length === 1);

    s11._noteStartAutosave();
    check('starting twice does not leak a second live timer',
        t11.timers.filter(x => x.live).length === 1,
        'live=' + t11.timers.filter(x => x.live).length);

    s11._noteMarkClean();
    t11.editor.innerHTML = 'timer test, edited';
    t11.timers.filter(x => x.live)[0].fn();
    await new Promise(r => setTimeout(r, 0));
    check('firing the timer commits the note', s11.caseNotes.length === 1,
        'len=' + s11.caseNotes.length);

    s11._noteStopAutosave();
    check('stop clears the handle', s11._peekAutosaveTimer() === null);
    check('  and kills the interval', t11.timers.filter(x => x.live).length === 0);

    // ------------------------------------------------ explicit Save path

    section('explicit Save tears the form down; autosave does not');
    const t12 = build({ formOpen: true, editorHtml: 'press save' });
    const s12 = t12.sandbox;
    s12._noteStartAutosave();
    await s12.saveNote({ preventDefault() {}, stopPropagation() {} });

    check('note was filed', s12.caseNotes.length === 1);
    check('  editingNoteId was released', s12.editingNoteId === null,
        String(s12.editingNoteId));
    check('  attachment buffers were cleared',
        s12.pendingNoteAttachments.length === 0 && s12.savedNoteAttachments.length === 0);
    check('  the baseline was released', s12._peekLastCommittedHtml() === null);
    check('  the timer was stopped', s12._peekAutosaveTimer() === null);
    check('  the tab was re-rendered', t12.rendered.includes('notes'));
    check('  the officer was told', t12.toasts.some(x => /saved/i.test(x.m)),
        JSON.stringify(t12.toasts));
    check('  and told once, not twice', t12.toasts.length === 1,
        JSON.stringify(t12.toasts));

    const t13 = build({ formOpen: true, editorHtml: '' });
    const before13 = t13.rendered.length;
    await t13.sandbox.saveNote({ preventDefault() {}, stopPropagation() {} });
    check('Save on an empty note does NOT tear the form down',
        t13.rendered.length === before13, 'rendered=' + JSON.stringify(t13.rendered));
    check('  and leaves the editing state alone',
        t13.sandbox.editingNoteId === null && t13.sandbox.caseNotes.length === 0);

    // ------------------------------------------------------- assignments

    section('assignments — a null picker must not wipe existing links');
    const existing = [{
        id: 777, contentHtml: 'old', createdAt: '2026-01-01T00:00:00.000Z',
        editHistory: [], attachments: [],
        assignedTo: [{ uid: 'u1', role: 'suspect', name: 'Doe' }]
    }];
    const t14 = build({
        formOpen: true, editorHtml: 'edited body',
        caseNotes: existing, editingNoteId: 777, assignments: null
    });
    await t14.sandbox._noteCommit({ silent: true });
    check('an unmounted picker leaves assignedTo intact',
        t14.sandbox.caseNotes[0].assignedTo.length === 1,
        JSON.stringify(t14.sandbox.caseNotes[0].assignedTo));
    check('  while the body still updates',
        t14.sandbox.caseNotes[0].contentHtml === 'edited body');

    const existing2 = [{
        id: 778, contentHtml: 'old', createdAt: '2026-01-01T00:00:00.000Z',
        editHistory: [], attachments: [],
        assignedTo: [{ uid: 'u1', role: 'suspect', name: 'Doe' }]
    }];
    const t15 = build({
        formOpen: true, editorHtml: 'unticked',
        caseNotes: existing2, editingNoteId: 778, assignments: []
    });
    await t15.sandbox._noteCommit({ silent: true });
    check('a mounted-but-unticked picker DOES clear assignedTo',
        t15.sandbox.caseNotes[0].assignedTo.length === 0,
        JSON.stringify(t15.sandbox.caseNotes[0].assignedTo));

    // ------------------------------------------------------ host guards

    section('host guards');
    const t16 = build({ formOpen: true, editorHtml: 'no case' });
    t16.sandbox.currentCase = null;
    const noCase = await t16.sandbox._noteCommit({ silent: true });
    check('no loaded case refuses to write', noCase.saved === false);
    check('  reason is no-case', noCase.reason === 'no-case', noCase.reason);
    check('  and stays silent when silent', t16.toasts.length === 0);

    // ------------------------------------------------------------ done

    console.log('\n' + '-'.repeat(52));
    console.log(`${pass} passed \u00b7 ${fail} failed`);
    if (fail) process.exit(1);
})().catch(e => {
    console.error('\nUNCAUGHT:', e && e.stack || e);
    process.exit(1);
});
