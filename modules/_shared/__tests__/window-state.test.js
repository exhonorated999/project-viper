/**
 * Tests for modules/_shared/window-state.js
 * Run: node modules/_shared/__tests__/window-state.test.js
 *
 * The bug this guards: VIPER opened at a hard-coded 1400x900 regardless of the
 * display. Electron does not clamp, and the app shell clips horizontal
 * overflow with no scrollbar, so on a 1080p screen at Windows' default 150%
 * scaling (1280x688 usable DIP) the right-hand 120px of the UI — Save Case,
 * Export, every "+ Add" button — was unreachable. Field report 2026-09-30.
 *
 * The real work-area figures below were measured on this machine with
 * electron.screen, not invented.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../window-state');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-winstate-'));

// Effective work areas in device-independent pixels, as reported by Windows
// for real officer-laptop configurations.
const WA = {
  fhd100:   { x: 0, y: 0, width: 1920, height: 1032 }, // 1920x1080 @100%
  fhd125:   { x: 0, y: 0, width: 1536, height: 825  }, // 1920x1080 @125%
  fhd150:   { x: 0, y: 0, width: 1280, height: 688  }, // 1920x1080 @150%  <- the reported case
  hd768:    { x: 0, y: 0, width: 1366, height: 720  }, // 1366x768  @100%
  wxga:     { x: 0, y: 0, width: 1280, height: 752  }, // 1280x800  @100%
  hdplus:   { x: 0, y: 0, width: 1600, height: 852  }, // 1600x900  @100%
  qhd150:   { x: 0, y: 0, width: 1706, height: 928  }  // 2560x1440 @150%
};
const d = (workArea) => ({ workArea });

// ── clampSize: never bigger than the screen ─────────────────────────
(function sizes() {
  // The whole point. 1400x900 must come back shrunk on every display that
  // cannot show it.
  const fhd150 = W.clampSize(1400, 900, WA.fhd150);
  eq(fhd150.width, 1280, '1080p@150%: width clamped to work area');
  eq(fhd150.height, 688, '1080p@150%: height clamped to work area');

  const hd = W.clampSize(1400, 900, WA.hd768);
  eq(hd.width, 1366, '1366x768: width clamped');
  eq(hd.height, 720, '1366x768: height clamped');

  const wxga = W.clampSize(1400, 900, WA.wxga);
  eq(wxga.width, 1280, '1280x800: width clamped');
  eq(wxga.height, 752, '1280x800: height clamped');

  const fhd125 = W.clampSize(1400, 900, WA.fhd125);
  eq(fhd125.width, 1400, '1080p@125%: width already fits, untouched');
  eq(fhd125.height, 825, '1080p@125%: height clamped');

  const hdplus = W.clampSize(1400, 900, WA.hdplus);
  eq(hdplus.width, 1400, '1600x900: width fits');
  eq(hdplus.height, 852, '1600x900: height clamped');

  // Displays that CAN show the default must be left alone — this fix must not
  // shrink the window for the users who were never affected.
  const fhd = W.clampSize(1400, 900, WA.fhd100);
  eq(fhd.width, 1400, '1080p@100%: default width preserved');
  eq(fhd.height, 900, '1080p@100%: default height preserved');
  const qhd = W.clampSize(1400, 900, WA.qhd150);
  eq(qhd.width, 1400, '1440p@150%: default width preserved');
  eq(qhd.height, 900, '1440p@150%: default height preserved');

  // Minimums are applied, but never above what the screen can show —
  // a minimum larger than the work area would recreate the original bug.
  const tiny = W.clampSize(300, 200, { x: 0, y: 0, width: 1920, height: 1032 });
  eq(tiny.width, W.MIN_WIDTH, 'undersized request raised to MIN_WIDTH');
  eq(tiny.height, W.MIN_HEIGHT, 'undersized request raised to MIN_HEIGHT');

  const cramped = W.clampSize(1400, 900, { x: 0, y: 0, width: 640, height: 400 });
  eq(cramped.width, 640, 'work area narrower than MIN_WIDTH still wins');
  eq(cramped.height, 400, 'work area shorter than MIN_HEIGHT still wins');
  ok(cramped.width <= 640 && cramped.height <= 400,
     'clampSize NEVER returns something larger than the work area');

  // The minimums themselves must be low enough to fit the smallest real
  // display we measured, or Electron would enforce them and re-clip the UI.
  ok(W.MIN_WIDTH <= WA.fhd150.width, 'MIN_WIDTH fits the narrowest measured work area');
  ok(W.MIN_HEIGHT <= WA.fhd150.height, 'MIN_HEIGHT fits the shortest measured work area');

  // Garbage in must not produce NaN bounds.
  const junk = W.clampSize(NaN, undefined, WA.fhd100);
  eq(junk.width, W.DEFAULT_WIDTH, 'NaN width falls back to default');
  eq(junk.height, W.DEFAULT_HEIGHT, 'undefined height falls back to default');
  const noWa = W.clampSize(1400, 900, null);
  ok(Number.isFinite(noWa.width) && Number.isFinite(noWa.height), 'null work area still yields finite size');
})();

// ── centreIn / clampPosition ────────────────────────────────────────
(function positions() {
  const c = W.centreIn({ width: 1400, height: 900 }, WA.fhd100);
  eq(c.x, 260, 'centred x on 1920 work area');
  eq(c.y, 66, 'centred y on 1032 work area');

  // A secondary display to the right: the work area origin is not 0,0.
  const right = { x: 1920, y: 0, width: 1920, height: 1032 };
  eq(W.centreIn({ width: 1400, height: 900 }, right).x, 2180,
     'centring honours a non-zero work area origin');

  // Off the right edge -> pulled back so the whole window is visible.
  let p = W.clampPosition({ x: 1800, y: 10, width: 1400, height: 900 }, WA.fhd100);
  eq(p.x, 520, 'window pushed back inside the right edge');
  // Negative coordinates -> pinned to the work area origin, never above it.
  p = W.clampPosition({ x: -400, y: -200, width: 1400, height: 900 }, WA.fhd100);
  eq(p.x, 0, 'negative x pinned to work area left');
  eq(p.y, 0, 'negative y pinned to work area top — the title bar must stay grabbable');

  // When the window is as large as the work area there is exactly one legal spot.
  p = W.clampPosition({ x: 500, y: 500, width: 1920, height: 1032 }, WA.fhd100);
  eq(p.x, 0, 'full-width window pinned to x=0');
  eq(p.y, 0, 'full-height window pinned to y=0');

  // Even an oversized rect must not be placed above/left of the work area.
  p = W.clampPosition({ x: 40, y: 40, width: 3000, height: 3000 }, WA.fhd150);
  ok(p.x === WA.fhd150.x && p.y === WA.fhd150.y,
     'oversized rect still pinned to the work area origin, not negative');
})();

// ── isValidBounds ───────────────────────────────────────────────────
(function validity() {
  ok(W.isValidBounds({ x: 0, y: 0, width: 1400, height: 900 }), 'complete bounds are valid');
  ok(W.isValidBounds({ x: -8, y: -8, width: 1400, height: 900 }), 'negative origin still valid');
  ok(!W.isValidBounds(null), 'null invalid');
  ok(!W.isValidBounds(undefined), 'undefined invalid');
  ok(!W.isValidBounds('1400x900'), 'string invalid');
  ok(!W.isValidBounds({ width: 1400, height: 900 }), 'missing x/y invalid');
  ok(!W.isValidBounds({ x: 0, y: 0, width: 1400 }), 'missing height invalid');
  ok(!W.isValidBounds({ x: 0, y: 0, width: 0, height: 900 }), 'zero width invalid');
  ok(!W.isValidBounds({ x: 0, y: 0, width: -10, height: 900 }), 'negative width invalid');
  ok(!W.isValidBounds({ x: 'a', y: 0, width: 1400, height: 900 }), 'non-numeric x invalid');
  ok(!W.isValidBounds({ x: 0, y: 0, width: NaN, height: 900 }), 'NaN width invalid');
})();

// ── pickWorkArea: the undocked-monitor case ─────────────────────────
(function displayChoice() {
  const primary = d(WA.fhd100);
  const secondary = d({ x: 1920, y: 0, width: 1920, height: 1032 });

  const onPrimary = { x: 100, y: 100, width: 1200, height: 800 };
  eq(W.pickWorkArea(onPrimary, [primary, secondary]).x, 0, 'bounds on primary pick primary');

  const onSecondary = { x: 2100, y: 100, width: 1200, height: 800 };
  eq(W.pickWorkArea(onSecondary, [primary, secondary]).x, 1920, 'bounds on secondary pick secondary');

  // THE important case: saved on a monitor that is no longer connected.
  // Returning null is what makes resolveStartup re-centre on the primary
  // instead of stranding the window somewhere invisible.
  eq(W.pickWorkArea(onSecondary, [primary]), null, 'unplugged monitor -> null, do not restore there');

  // Mostly-off-screen counts as gone too.
  eq(W.pickWorkArea({ x: 1850, y: 900, width: 1200, height: 800 }, [primary]), null,
     'barely-overlapping bounds rejected');
  // Majority on screen is accepted.
  ok(W.pickWorkArea({ x: 1000, y: 100, width: 1200, height: 800 }, [primary]) !== null,
     'majority-visible bounds accepted');

  eq(W.pickWorkArea(onPrimary, []), null, 'no displays -> null');
  eq(W.pickWorkArea(onPrimary, null), null, 'null display list -> null');
  eq(W.pickWorkArea(null, [primary]), null, 'invalid bounds -> null');
  ok(W.pickWorkArea(onPrimary, [null, undefined, {}, primary]) !== null,
     'junk entries in the display list are skipped');
})();

// ── resolveStartup: first run ───────────────────────────────────────
(function firstRun() {
  // Nothing saved, roomy display: the historical 1400x900, centred.
  let r = W.resolveStartup(null, { displays: [d(WA.fhd100)], primaryWorkArea: WA.fhd100 });
  eq(r.bounds.width, 1400, 'first run on 1080p@100% keeps 1400 wide');
  eq(r.bounds.height, 900, 'first run on 1080p@100% keeps 900 tall');
  eq(r.bounds.x, 260, 'first run centred horizontally');
  eq(r.bounds.y, 66, 'first run centred vertically');
  eq(r.maximized, false, 'first run not maximized');

  // THE REPORTED CONFIGURATION. This is the assertion that represents the bug.
  r = W.resolveStartup(null, { displays: [d(WA.fhd150)], primaryWorkArea: WA.fhd150 });
  eq(r.bounds.width, 1280, '1080p@150%: opens 1280 wide, not 1400 — nothing is cut off');
  eq(r.bounds.height, 688, '1080p@150%: opens 688 tall');
  eq(r.bounds.x, 0, '1080p@150%: flush to the left edge');
  eq(r.bounds.y, 0, '1080p@150%: flush to the top edge');

  r = W.resolveStartup(null, { displays: [d(WA.hd768)], primaryWorkArea: WA.hd768 });
  eq(r.bounds.width, 1366, '1366x768: opens exactly as wide as the screen');
  eq(r.bounds.height, 720, '1366x768: opens exactly as tall as the work area');

  // Corrupt/garbage saved state behaves exactly like a first run.
  for (const junk of [undefined, {}, 'nope', 42, { width: 'x', height: 'y' }, { x: 0, y: 0 }]) {
    const g = W.resolveStartup(junk, { displays: [d(WA.fhd100)], primaryWorkArea: WA.fhd100 });
    eq(g.bounds.width, 1400, 'junk saved state (' + JSON.stringify(junk) + ') -> default width');
  }

  // No display information at all must still produce a usable window.
  r = W.resolveStartup(null, {});
  ok(Number.isFinite(r.bounds.width) && r.bounds.width > 0, 'empty env still yields a finite width');
  ok(Number.isFinite(r.bounds.height) && r.bounds.height > 0, 'empty env still yields a finite height');
  r = W.resolveStartup(null, null);
  ok(Number.isFinite(r.bounds.width), 'null env does not throw');
})();

// ── resolveStartup: returning user ──────────────────────────────────
(function restore() {
  const env100 = { displays: [d(WA.fhd100)], primaryWorkArea: WA.fhd100 };

  // Exact restore when it still fits.
  let r = W.resolveStartup({ x: 120, y: 80, width: 1600, height: 950, maximized: false }, env100);
  eq(r.bounds.width, 1600, 'remembered width restored');
  eq(r.bounds.height, 950, 'remembered height restored');
  eq(r.bounds.x, 120, 'remembered x restored');
  eq(r.bounds.y, 80, 'remembered y restored');

  eq(W.resolveStartup({ x: 0, y: 0, width: 1400, height: 900, maximized: true }, env100).maximized,
     true, 'maximized flag survives a restart');

  // A remembered position that would hang off the edge gets pulled in, with
  // the size kept intact.
  r = W.resolveStartup({ x: 1850, y: 1000, width: 1400, height: 900 }, env100);
  eq(r.bounds.width, 1400, 'off-edge restore keeps the size');
  eq(r.bounds.x, 520, 'off-edge restore pulls x back on screen');
  eq(r.bounds.y, 132, 'off-edge restore pulls y back on screen');

  // Docked at work, undocked at home: a window remembered at 1600 wide on a
  // big monitor must shrink AND re-centre on the laptop panel, not keep a
  // corner from a screen that no longer exists.
  const env150 = { displays: [d(WA.fhd150)], primaryWorkArea: WA.fhd150 };
  r = W.resolveStartup({ x: 2100, y: 60, width: 1600, height: 950 }, env150);
  eq(r.bounds.width, 1280, 'undock: width clamped to the laptop panel');
  eq(r.bounds.height, 688, 'undock: height clamped to the laptop panel');
  eq(r.bounds.x, 0, 'undock: re-centred, not restored to the missing monitor');
  eq(r.bounds.y, 0, 'undock: re-centred vertically');

  // A shrink always re-centres rather than pinning the old corner — a corner
  // that made sense at 1600 wide is meaningless at 1280.
  r = W.resolveStartup({ x: 400, y: 20, width: 1900, height: 900 }, env150);
  eq(r.bounds.width, 1280, 'shrunk to work area width');
  eq(r.bounds.x, 0, 'shrink re-centres x');

  // Whatever happens, the result must be fully on screen. This is the
  // invariant the whole module exists to guarantee.
  const configs = Object.keys(WA);
  const saves = [
    null,
    { x: 0, y: 0, width: 1400, height: 900 },
    { x: 2500, y: 1500, width: 1920, height: 1200 },
    { x: -900, y: -500, width: 1400, height: 900 },
    { x: 10, y: 10, width: 100, height: 100 },
    { x: 10, y: 10, width: 5000, height: 5000 }
  ];
  let violations = 0;
  for (const name of configs) {
    const wa = WA[name];
    for (const s of saves) {
      const got = W.resolveStartup(s, { displays: [d(wa)], primaryWorkArea: wa }).bounds;
      const fits = got.x >= wa.x && got.y >= wa.y
        && got.x + got.width <= wa.x + wa.width
        && got.y + got.height <= wa.y + wa.height;
      if (!fits) { violations++; console.log('    ' + name + ' + ' + JSON.stringify(s) + ' -> ' + JSON.stringify(got)); }
    }
  }
  eq(violations, 0, 'every display x saved-state combination lands fully inside the work area');

  // And the reported minimums are always honourable on the target display.
  for (const name of configs) {
    const wa = WA[name];
    const r2 = W.resolveStartup(null, { displays: [d(wa)], primaryWorkArea: wa });
    ok(r2.minWidth <= wa.width, name + ': minWidth never exceeds the work area');
    ok(r2.minHeight <= wa.height, name + ': minHeight never exceeds the work area');
    ok(r2.bounds.width >= r2.minWidth, name + ': opening width respects its own minimum');
  }
})();

// ── captureState ────────────────────────────────────────────────────
(function capture() {
  function fakeWin(o) {
    return {
      isDestroyed: () => !!o.destroyed,
      isMaximized: () => !!o.maximized,
      isMinimized: () => !!o.minimized,
      isFullScreen: () => !!o.fullscreen,
      getNormalBounds: () => o.normal,
      getBounds: () => o.bounds || o.normal
    };
  }

  let s = W.captureState(fakeWin({ normal: { x: 10, y: 20, width: 1300, height: 800 } }), null);
  eq(s.width, 1300, 'captures normal width');
  eq(s.x, 10, 'captures normal x');
  eq(s.maximized, false, 'normal window records maximized=false');

  // Maximised: record the FLAG, but keep the previous normal rect as the
  // bounds so un-maximising later restores a real window.
  const prev = { x: 10, y: 20, width: 1300, height: 800, maximized: false };
  s = W.captureState(fakeWin({ maximized: true, normal: { x: 0, y: 0, width: 1920, height: 1032 } }), prev);
  eq(s.maximized, true, 'maximized window records the flag');
  eq(s.width, 1300, 'maximized window keeps the previous normal width');
  eq(s.x, 10, 'maximized window keeps the previous normal x');

  s = W.captureState(fakeWin({ fullscreen: true, normal: { x: 0, y: 0, width: 1920, height: 1080 } }), prev);
  eq(s.maximized, true, 'fullscreen treated as maximized');

  // Minimised bounds are useless — never overwrite good state with them.
  s = W.captureState(fakeWin({ minimized: true, normal: { x: -32000, y: -32000, width: 160, height: 28 } }), prev);
  eq(s.width, 1300, 'minimized window does not clobber the saved size');
  ok(s.x !== -32000, 'minimized window does not persist off-screen coordinates');

  // A destroyed window, or one whose accessors throw, returns the previous
  // state untouched rather than corrupting it.
  eq(W.captureState(fakeWin({ destroyed: true, normal: {} }), prev), prev, 'destroyed window -> previous state');
  eq(W.captureState(null, prev), prev, 'null window -> previous state');
  const thrower = { isDestroyed: () => false, isMaximized: () => { throw new Error('boom'); } };
  eq(W.captureState(thrower, prev), prev, 'throwing window -> previous state, no crash');

  // Maximised on the very first run: no previous rect to fall back on, so the
  // default is recorded and the flag still round-trips.
  s = W.captureState(fakeWin({ maximized: true, normal: { x: 0, y: 0, width: 1920, height: 1032 } }), null);
  eq(s.width, W.DEFAULT_WIDTH, 'maximized with no history records the default width');
  eq(s.maximized, true, 'maximized with no history still records the flag');
  eq(W.resolveStartup(s, { displays: [d(WA.fhd100)], primaryWorkArea: WA.fhd100 }).maximized, true,
     'that state round-trips through resolveStartup as maximized');
})();

// ── read / write ────────────────────────────────────────────────────
(function persistence() {
  const f = path.join(tmpRoot, 'window-state.json');

  eq(W.read(f), null, 'missing file reads as null (normal first run)');
  eq(W.read(path.join(tmpRoot, 'nope', 'deep', 'x.json')), null, 'missing directory reads as null');

  ok(W.write(f, { x: 1, y: 2, width: 1300, height: 800, maximized: false }), 'write reports success');
  const back = W.read(f);
  eq(back.width, 1300, 'round-trips width');
  eq(back.x, 1, 'round-trips x');
  eq(back.maximized, false, 'round-trips the maximized flag');

  // Creates its own directory — userData may be a fresh relocated path.
  const nested = path.join(tmpRoot, 'made', 'up', 'window-state.json');
  ok(W.write(nested, { x: 0, y: 0, width: 900, height: 700 }), 'write creates missing directories');
  eq(W.read(nested).height, 700, 'nested write round-trips');

  // A corrupt file must degrade to "no memory", never throw on startup.
  fs.writeFileSync(f, '{ this is not json');
  eq(W.read(f), null, 'corrupt JSON reads as null');
  fs.writeFileSync(f, '"just a string"');
  eq(W.read(f), null, 'non-object JSON reads as null');
  fs.writeFileSync(f, '');
  eq(W.read(f), null, 'empty file reads as null');

  // And a corrupt file still yields a usable window.
  const r = W.resolveStartup(W.read(f), { displays: [d(WA.fhd150)], primaryWorkArea: WA.fhd150 });
  eq(r.bounds.width, 1280, 'corrupt state still produces a correctly clamped window');
})();

// ── attach ──────────────────────────────────────────────────────────
(function attachment() {
  const f = path.join(tmpRoot, 'attach-state.json');
  const handlers = {};
  const win = {
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    isDestroyed: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => ({ x: 5, y: 6, width: 1250, height: 780 }),
    getBounds: () => ({ x: 5, y: 6, width: 1250, height: 780 })
  };

  const h = W.attach(win, f, { debounceMs: 10000 });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'close', 'closed']) {
    ok(Array.isArray(handlers[ev]) && handlers[ev].length > 0, 'listens for "' + ev + '"');
  }

  // A long debounce means nothing is on disk yet...
  handlers.resize[0]();
  eq(W.read(f), null, 'resize alone does not write immediately (debounced)');
  // ...but close must flush synchronously, because a pending timer does not
  // survive app teardown. This is the whole reason attach() has a flush.
  handlers.close[0]();
  const saved = W.read(f);
  ok(saved && saved.width === 1250, 'close flushes the pending state to disk');
  eq(saved.x, 5, 'flushed state has the right position');
  eq(h.state().height, 780, 'exposed state matches what was written');

  // Explicit flush is idempotent, and a window that throws must not take the
  // app down during quit.
  h.flush();
  eq(W.read(f).width, 1250, 'repeat flush leaves the file consistent');

  let threw = false;
  try {
    const bad = { on: () => { throw new Error('nope'); } };
    W.attach(bad, path.join(tmpRoot, 'bad.json'));
  } catch (_) { threw = true; }
  ok(!threw, 'attach survives a window that rejects listeners');
})();

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nwindow-state: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
