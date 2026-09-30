// Closing the note pop-out must save the note.
//
// The pop-out's own `beforeunload` handler is not a guarantee: it fires an
// async ipcRenderer.invoke and the window teardown can kill the renderer
// before the call arrives. So electron-main.js holds the close, reads the
// editor out of the still-live window, commits it, and only then lets the
// window go. That is the behaviour under test here.
//
// The code is LIFTED out of electron-main.js, not copied. A copy is the
// thing that drifts.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const MAIN = path.join(__dirname, '..', '..', '..', 'electron-main.js');
const SRC = fs.readFileSync(MAIN, 'utf8').replace(/\r\n/g, '\n');

// ───────────────────────── the lift ─────────────────────────
section('the lift');

const START = 'async function _noteWriteToMain(';
const END_ANCHOR = "// --- RMS PDF Import ---";
const a = SRC.indexOf(START);
const b = SRC.indexOf(END_ANCHOR);
check('_noteWriteToMain is present in electron-main.js', a > 0);
check('the RMS import marker still terminates the note block', b > a);

let BLOCK = SRC.slice(a, b);

// `const`/`let` declared at the top of a lifted block never land on the vm
// sandbox global (function declarations do), so republish the ones the
// assertions need to reach.
const HOOK = '\n;Object.assign(globalThis, {' +
  ' _noteWriteToMain, _flushNoteWindow, _attachNoteCloseFlush,' +
  ' _peekFlushed: (w) => _noteFlushed.has(w),' +
  ' _peekFlushing: (w) => _noteFlushing.has(w)' +
  '});\n';
BLOCK += HOOK;

check('the block carries the close-flush attacher', /function _attachNoteCloseFlush\(/.test(BLOCK));
check('the block carries the quit flush', /app\.on\('before-quit'/.test(BLOCK));

// ───────────────────── harness ─────────────────────
// A fake main window whose executeJavaScript actually RUNS the injected
// script against a localStorage stub, so the note record really is written.
function makeHarness(opts) {
  opts = opts || {};
  const store = { viperCaseNotes: JSON.stringify(opts.notes || {}) };
  const t = { writes: 0, quitCalls: 0, ipcHandlers: {}, quitListeners: [] };

  const pageCtx = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); t.writes++; }
    },
    // The page-side repaint guards. No inline form, not on the notes tab —
    // the write is the whole job.
    document: { getElementById: () => null },
    JSON, String, Array, Date, Object
  };
  pageCtx.globalThis = pageCtx;
  vm.createContext(pageCtx);

  const mainWindow = {
    isDestroyed: () => !!opts.mainDestroyed,
    webContents: {
      executeJavaScript: async (js) => vm.runInContext(js, pageCtx)
    }
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, String, Array, Date, Object, Promise, WeakSet, Map,
    setTimeout, clearTimeout,
    mainWindow,
    ipcMain: { handle: (n, fn) => { t.ipcHandlers[n] = fn; } },
    app: {
      on: (ev, fn) => { if (ev === 'before-quit') t.quitListeners.push(fn); },
      quit: () => { t.quitCalls++; }
    },
    _noteWindows: new Map()
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BLOCK, sandbox);

  t.store = store;
  t.sandbox = sandbox;
  t.readNotes = () => JSON.parse(store.viperCaseNotes || '{}');
  return t;
}

// A fake pop-out BrowserWindow.
function makeNoteWin(opts) {
  opts = opts || {};
  const w = {
    _closeListeners: [],
    destroyed: false,
    closeAttempts: 0,
    prevented: 0,
    execCalls: 0,
    isDestroyed: () => w.destroyed,
    webContents: {
      isDestroyed: () => !!opts.wcDestroyed,
      executeJavaScript: async () => {
        w.execCalls++;
        if (opts.throwOnRead) throw new Error('renderer gone');
        return opts.editorHtml === undefined ? null : opts.editorHtml;
      }
    },
    on: (ev, fn) => { if (ev === 'close') w._closeListeners.push(fn); },
    close: () => {
      w.closeAttempts++;
      let prevented = false;
      const e = { preventDefault: () => { prevented = true; w.prevented++; } };
      w._closeListeners.forEach(fn => fn(e));
      if (!prevented) w.destroyed = true;
      return prevented;
    }
  };
  return w;
}

const NOTES = () => ({
  '25-123456': [
    { id: 991, contentHtml: '<p>original</p>', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 992, contentHtml: '<p>other note</p>', createdAt: '2026-09-02T10:00:00.000Z' }
  ]
});

// ───────────── the write path itself ─────────────
section('_noteWriteToMain is the single writer');

(async () => {
  {
    const t = makeHarness({ notes: NOTES() });
    const ok = await t.sandbox._noteWriteToMain('25-123456', '991', '<p>edited</p>');
    check('a changed note is written', ok === true);
    check('  the new html landed on the right note',
      t.readNotes()['25-123456'][0].contentHtml === '<p>edited</p>');
    check('  the sibling note was not touched',
      t.readNotes()['25-123456'][1].contentHtml === '<p>other note</p>');
    check('  one edit timestamp was recorded',
      t.readNotes()['25-123456'][0].editHistory.length === 1);
    check('  localStorage was written exactly once', t.writes === 1);
  }

  {
    // THE DOUBLE-CLOSE GUARD. The pop-out's beforeunload and the main-side
    // flush can both fire for one close. Without the identical-content
    // guard the note collects two edit stamps for a single keystroke.
    const t = makeHarness({ notes: NOTES() });
    await t.sandbox._noteWriteToMain('25-123456', '991', '<p>edited</p>');
    const ok2 = await t.sandbox._noteWriteToMain('25-123456', '991', '<p>edited</p>');
    check('an identical re-write reports success', ok2 === true);
    check('  but does NOT write localStorage again', t.writes === 1);
    check('  and does NOT add a second edit timestamp',
      t.readNotes()['25-123456'][0].editHistory.length === 1);
  }

  {
    const t = makeHarness({ notes: NOTES() });
    const ok = await t.sandbox._noteWriteToMain('25-123456', '404', '<p>ghost</p>');
    check('a deleted note reports failure rather than inventing a record', ok === false);
    check('  nothing was written', t.writes === 0);
    check('  the case still has its two notes', t.readNotes()['25-123456'].length === 2);
  }

  {
    const t = makeHarness({ notes: NOTES() });
    const ok = await t.sandbox._noteWriteToMain('99-000000', '991', '<p>x</p>');
    check('a case with no notes list reports failure', ok === false);
    check('  and no stray case key was created',
      Object.keys(t.readNotes()).length === 1);
  }

  {
    const t = makeHarness({ notes: NOTES(), mainDestroyed: true });
    const ok = await t.sandbox._noteWriteToMain('25-123456', '991', '<p>x</p>');
    check('with the main window gone the write reports failure', ok === false);
    check('  rather than throwing', true);
  }

  // ───────────── the close flush ─────────────
  section('closing the pop-out saves the note');

  {
    const t = makeHarness({ notes: NOTES() });
    const win = makeNoteWin({ editorHtml: '<p>typed in the pop-out</p>' });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');

    check('the window carries its own note identity',
      win._viperNote && win._viperNote.caseNumber === '25-123456'
      && win._viperNote.noteId === '991');

    win.close();
    check('the first close is held open', win.prevented === 1);
    check('  the window is NOT destroyed yet', win.destroyed === false);

    await new Promise(r => setTimeout(r, 20));

    check('the editor text was committed',
      t.readNotes()['25-123456'][0].contentHtml === '<p>typed in the pop-out</p>');
    check('  the window then closed for real', win.destroyed === true);
    check('  it took exactly two close passes', win.closeAttempts === 2);
    check('  the second pass was not prevented', win.prevented === 1);
    check('  the window is marked flushed', t.sandbox._peekFlushed(win) === true);
    check('  and is no longer marked in-flight', t.sandbox._peekFlushing(win) === false);
  }

  {
    // NOT DIRTY. The injected reader returns null when isDirty() is false,
    // which is also how an unloaded window and a deleted note present.
    // Nothing may be written in that case — an empty string here would
    // erase a real note.
    const t = makeHarness({ notes: NOTES() });
    const win = makeNoteWin({ editorHtml: null });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');
    win.close();
    await new Promise(r => setTimeout(r, 20));
    check('an unchanged pop-out writes nothing', t.writes === 0);
    check('  the note keeps its original text',
      t.readNotes()['25-123456'][0].contentHtml === '<p>original</p>');
    check('  no edit timestamp was invented',
      t.readNotes()['25-123456'][0].editHistory === undefined);
    check('  the window still closed', win.destroyed === true);
  }

  {
    // A save failure must never leave the officer with a window that will
    // not close.
    const t = makeHarness({ notes: NOTES() });
    const win = makeNoteWin({ throwOnRead: true });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');
    win.close();
    await new Promise(r => setTimeout(r, 20));
    check('a renderer that throws on read does not block the close',
      win.destroyed === true);
    check('  and nothing was written', t.writes === 0);
  }

  {
    // Already-dead webContents: nothing to read, so let the close proceed
    // immediately rather than holding a window that can never answer.
    const t = makeHarness({ notes: NOTES() });
    const win = makeNoteWin({ wcDestroyed: true, editorHtml: '<p>unreachable</p>' });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');
    win.close();
    check('a dead renderer closes on the first pass without being held',
      win.prevented === 0);
    check('  the window is destroyed', win.destroyed === true);
    check('  no read was attempted', win.execCalls === 0);
    await new Promise(r => setTimeout(r, 20));
    check('  and nothing was written', t.writes === 0);
  }

  {
    // Impatient officer clicks X twice while the save is in flight.
    const t = makeHarness({ notes: NOTES() });
    const win = makeNoteWin({ editorHtml: '<p>twice</p>' });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');
    win.close();
    win.close();
    check('the second click is also held', win.prevented === 2);
    check('  but only one flush was started', win.execCalls === 1);
    await new Promise(r => setTimeout(r, 20));
    check('  the text still landed',
      t.readNotes()['25-123456'][0].contentHtml === '<p>twice</p>');
    check('  written exactly once', t.writes === 1);
    check('  and the window closed', win.destroyed === true);
  }

  // ───────────── quitting with a pop-out open ─────────────
  section('quitting with a pop-out open');

  {
    const t = makeHarness({ notes: NOTES() });
    check('exactly one before-quit listener was registered',
      t.quitListeners.length === 1);

    const win = makeNoteWin({ editorHtml: '<p>unsaved at quit</p>' });
    t.sandbox._attachNoteCloseFlush(win, '25-123456', '991');
    t.sandbox._noteWindows.set('25-123456::991', win);

    let prevented = false;
    t.quitListeners[0]({ preventDefault: () => { prevented = true; } });
    check('the quit is held while an open pop-out is flushed', prevented === true);

    await new Promise(r => setTimeout(r, 30));
    check('  the note was saved before the process could exit',
      t.readNotes()['25-123456'][0].contentHtml === '<p>unsaved at quit</p>');
    check('  and the quit was then re-issued', t.quitCalls === 1);

    // Second pass must sail straight through or the app never exits.
    let prevented2 = false;
    t.quitListeners[0]({ preventDefault: () => { prevented2 = true; } });
    check('the re-issued quit is NOT held again', prevented2 === false);
  }

  {
    const t = makeHarness({ notes: NOTES() });
    let prevented = false;
    t.quitListeners[0]({ preventDefault: () => { prevented = true; } });
    check('with no pop-outs open the quit is never delayed', prevented === false);
    check('  and no redundant app.quit() was issued', t.quitCalls === 0);
  }

  {
    const t = makeHarness({ notes: NOTES() });
    const dead = makeNoteWin({ wcDestroyed: true });
    t.sandbox._noteWindows.set('25-123456::991', dead);
    let prevented = false;
    t.quitListeners[0]({ preventDefault: () => { prevented = true; } });
    check('a pop-out whose renderer is already gone does not delay the quit',
      prevented === false);
  }

  // ───────────── source-level invariants ─────────────
  section('source-level invariants');

  check('note-save is a thin wrapper over the single writer',
    /ipcMain\.handle\('note-save',[\s\S]{0,140}_noteWriteToMain\(/.test(SRC));
  check('the close flush is attached where the window is created',
    /_noteWindows\.set\(key, noteWin\);\s*\n\s*_attachNoteCloseFlush\(noteWin, caseNumber, noteId\);/.test(SRC));
  check('the quit flush is bounded by a timeout so it cannot wedge the quit',
    /Promise\.race\(\[[\s\S]{0,200}setTimeout\(r, 3000\)/.test(BLOCK));
  check('the editor reader gates on isDirty()',
    /typeof isDirty !== 'function' \|\| !isDirty\(\)/.test(BLOCK));
  check('only a string is ever committed from the reader',
    /if \(typeof html === 'string'\)/.test(BLOCK));

  const POPOUT = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'note-popout.html'), 'utf8'
  ).replace(/\r\n/g, '\n');
  check('the pop-out still makes its own best-effort save on unload',
    /beforeunload[\s\S]{0,160}saveToMain\(true\)/.test(POPOUT));
  check('  and says in the source that it is not the guarantee',
    /not the guarantee/.test(POPOUT));

  console.log('\n' + passed + ' passed · ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
