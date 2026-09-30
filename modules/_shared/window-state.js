/**
 * window-state.js — main-process-only window sizing + position memory.
 *
 * WHY THIS EXISTS
 * ---------------
 * VIPER used to create its main window at a hard-coded 1400x900. Electron does
 * NOT shrink a requested size down to fit the monitor, and the app shell is
 * `flex h-screen overflow-hidden` with `#tabContent { overflow-x: hidden }`,
 * so any width the display could not accommodate was silently CLIPPED with no
 * horizontal scrollbar. On a 1080p laptop at Windows' default 150% scaling the
 * usable work area is only 1280x688 device-independent pixels, so 120px of the
 * right-hand side — the Save Case / Export buttons, the "+ Add" buttons on
 * every tab — simply could not be reached. Reported from the field 2026-09-30.
 *
 * Deliberately NOT fixed by removing `overflow-hidden`: the slide-out drawers
 * (#glPanel, #tracePanel, .gl-panel) are parked off-screen at +460px and rely
 * on that clip. Unhiding it puts a permanent horizontal scrollbar on the app.
 *
 * So: never ask for a window bigger than the work area, keep the minimums low
 * enough that they can never re-introduce the same problem, and remember what
 * the user chose last time.
 *
 * MAIN-PROCESS ONLY — requires `fs`. See modules/_shared/ (it holds both
 * main-side and renderer-side helpers; check before importing).
 */

'use strict';

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;

// Chosen to sit safely BELOW every real Windows work area we measured
// (the smallest was 1280x688 at 1080p/150% scaling). A minimum larger than
// the work area would be enforced by Electron and would recreate the exact
// clipping bug this module exists to prevent.
const MIN_WIDTH = 860;
const MIN_HEIGHT = 560;

// How much of the window has to land inside a display's work area before we
// accept remembered coordinates. Guards against restoring onto a monitor that
// has since been unplugged, or a position dragged mostly off the edge.
const MIN_VISIBLE_FRACTION = 0.5;

function _int(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
}

/**
 * Is this a usable saved-state object? Anything short of four finite numbers
 * is treated as absent rather than repaired — a half-read file should fall
 * back to the centred default, not to a guess.
 */
function isValidBounds(b) {
    if (!b || typeof b !== 'object') return false;
    const w = _int(b.width), h = _int(b.height);
    const x = _int(b.x), y = _int(b.y);
    if (w === null || h === null || x === null || y === null) return false;
    // A zero/negative extent means the record is junk, not minimised.
    return w > 0 && h > 0;
}

function _area(r) {
    return Math.max(0, r.width) * Math.max(0, r.height);
}

function _intersection(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/**
 * Fit a size into a work area. Never returns something wider or taller than
 * the work area, and never smaller than the minimums UNLESS the work area
 * itself is smaller — in which case the work area wins, because a window
 * bigger than the screen is the bug.
 */
function clampSize(width, height, workArea) {
    const wa = workArea || {};
    const availW = _int(wa.width) || DEFAULT_WIDTH;
    const availH = _int(wa.height) || DEFAULT_HEIGHT;

    let w = _int(width) || DEFAULT_WIDTH;
    let h = _int(height) || DEFAULT_HEIGHT;

    w = Math.min(w, availW);
    h = Math.min(h, availH);
    w = Math.max(w, Math.min(MIN_WIDTH, availW));
    h = Math.max(h, Math.min(MIN_HEIGHT, availH));

    return { width: w, height: h };
}

/** Centre a size inside a work area, honouring the work area's own origin. */
function centreIn(size, workArea) {
    const wa = workArea || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const x0 = _int(wa.x) || 0;
    const y0 = _int(wa.y) || 0;
    return {
        x: x0 + Math.round((wa.width - size.width) / 2),
        y: y0 + Math.round((wa.height - size.height) / 2)
    };
}

/**
 * Push a fully-sized rect back inside a work area. Top-left is pinned last so
 * the title bar always stays reachable — an off-top window cannot be dragged.
 */
function clampPosition(rect, workArea) {
    const wa = workArea || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const x0 = _int(wa.x) || 0;
    const y0 = _int(wa.y) || 0;
    let x = _int(rect.x) || 0;
    let y = _int(rect.y) || 0;

    x = Math.min(x, x0 + wa.width - rect.width);
    y = Math.min(y, y0 + wa.height - rect.height);
    x = Math.max(x, x0);
    y = Math.max(y, y0);

    return { x, y };
}

/**
 * Pick the work area the saved bounds belong to. Returns null when the saved
 * rect does not meaningfully overlap ANY connected display — the "they
 * undocked the second monitor" case, where remembering the position would
 * strand the window somewhere the user cannot see or reach.
 */
function pickWorkArea(bounds, displays) {
    const list = Array.isArray(displays) ? displays.filter(d => d && d.workArea) : [];
    if (!list.length) return null;
    if (!isValidBounds(bounds)) return null;

    let best = null;
    let bestOverlap = 0;
    for (const d of list) {
        const overlap = _area(_intersection(bounds, d.workArea));
        if (overlap > bestOverlap) { bestOverlap = overlap; best = d; }
    }
    if (!best) return null;

    const needed = _area(bounds) * MIN_VISIBLE_FRACTION;
    if (needed > 0 && bestOverlap < needed) return null;
    return best.workArea;
}

/**
 * THE function. Given whatever was saved last time and the displays that exist
 * right now, decide where the window opens.
 *
 * @param {object|null} saved   Previously persisted state, or null/garbage.
 * @param {object} env          { displays: Display[], primaryWorkArea: Rect }
 * @returns {{bounds:{x,y,width,height}, maximized:boolean, minWidth:number, minHeight:number}}
 */
function resolveStartup(saved, env) {
    const e = env || {};
    const displays = Array.isArray(e.displays) ? e.displays : [];
    const primary = e.primaryWorkArea
        || (displays[0] && displays[0].workArea)
        || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

    const savedOk = isValidBounds(saved);
    const targetWa = (savedOk && pickWorkArea(saved, displays)) || primary;

    let size, pos;
    if (savedOk) {
        size = clampSize(saved.width, saved.height, targetWa);
        // If clamping actually shrank the remembered size, the remembered
        // position is meaningless — re-centre instead of pinning a corner.
        const shrank = size.width !== _int(saved.width) || size.height !== _int(saved.height);
        pos = shrank
            ? centreIn(size, targetWa)
            : clampPosition({ x: saved.x, y: saved.y, width: size.width, height: size.height }, targetWa);
    } else {
        size = clampSize(DEFAULT_WIDTH, DEFAULT_HEIGHT, targetWa);
        pos = centreIn(size, targetWa);
    }

    return {
        bounds: { x: pos.x, y: pos.y, width: size.width, height: size.height },
        maximized: !!(saved && saved.maximized),
        minWidth: Math.min(MIN_WIDTH, targetWa.width || MIN_WIDTH),
        minHeight: Math.min(MIN_HEIGHT, targetWa.height || MIN_HEIGHT)
    };
}

/* ── persistence ─────────────────────────────────────────────────────── */

function read(filePath) {
    try {
        const fs = require('fs');
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_) {
        // Missing or corrupt is normal on first run. Never fatal — the caller
        // falls back to the centred default.
        return null;
    }
}

function write(filePath, state) {
    try {
        const fs = require('fs');
        const path = require('path');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
        return true;
    } catch (e) {
        try { console.warn('[window-state] save failed:', e.message); } catch (_) {}
        return false;
    }
}

/**
 * What we persist. Only ever records a NORMAL (non-maximised, non-minimised,
 * non-fullscreen) rect as the bounds, so un-maximising later restores a real
 * window instead of a screen-filling one.
 */
function captureState(win, previous) {
    const prev = previous || null;
    try {
        if (!win || win.isDestroyed()) return prev;
        const maximized = !!(win.isMaximized() || win.isFullScreen());
        if (maximized || win.isMinimized()) {
            const base = (prev && isValidBounds(prev)) ? prev : null;
            return {
                x: base ? base.x : undefined,
                y: base ? base.y : undefined,
                width: base ? base.width : DEFAULT_WIDTH,
                height: base ? base.height : DEFAULT_HEIGHT,
                maximized
            };
        }
        const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: false };
    } catch (_) {
        return prev;
    }
}

/**
 * Wire a window up so its size/position survives a restart. Writes are
 * debounced (a drag fires 'move' continuously) and flushed synchronously on
 * close, because a debounced timer does not survive app teardown.
 */
function attach(win, filePath, opts) {
    const delay = (opts && opts.debounceMs) || 500;
    let last = read(filePath);
    let timer = null;

    const snapshot = () => { last = captureState(win, last); };

    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (last) write(filePath, last);
    };

    const schedule = () => {
        snapshot();
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, delay);
    };

    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
        try { win.on(ev, schedule); } catch (_) {}
    }
    // 'close' can be preventDefault()ed elsewhere (the vault save path does),
    // so snapshot on close but also flush on 'closed' as the backstop.
    try { win.on('close', () => { snapshot(); flush(); }); } catch (_) {}
    try { win.on('closed', flush); } catch (_) {}

    return { flush, snapshot, state: () => last };
}

module.exports = {
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    MIN_WIDTH,
    MIN_HEIGHT,
    MIN_VISIBLE_FRACTION,
    isValidBounds,
    clampSize,
    clampPosition,
    centreIn,
    pickWorkArea,
    resolveStartup,
    captureState,
    read,
    write,
    attach
};
