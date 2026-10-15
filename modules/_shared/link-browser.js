/**
 * The VIPER browser window — where a link clicked in a Case Note opens.
 *
 * MAIN-PROCESS ONLY. A renderer reload does not pick up changes here.
 *
 * Built for one job: an officer pastes a Google Drive or OneDrive link into
 * a note, clicks it, and lands in that folder or document, signed in and
 * able to edit, without leaving VIPER. Any web link in a note opens here.
 *
 * Shape: a small toolbar page (link-browser.html) across the top of a
 * normal window, with the web page in a BrowserView underneath it.
 *
 *   - ONE remembered session for every link window (PARTITION below), so
 *     the officer signs in to Google / Microsoft once. Settings has a
 *     "Sign out" button that wipes it. On a drive copy the session lives in
 *     the drive's userdata folder, like everything else VIPER keeps.
 *   - Google refuses sign-in from browsers it thinks are embedded in an
 *     app, and (measured) it refuses even a clean Chrome identity from
 *     here. The session therefore presents itself as a current Firefox,
 *     which Google lets through far more often, and drops Chromium's
 *     Sec-CH-UA headers that real Firefox never sends. When Google still
 *     refuses, the toolbar says so and offers "Open in my browser".
 *   - The page gets no Node, no preload and a sandbox. Only http(s) loads
 *     inside the window. Mail links and the Office "open in desktop app"
 *     links go to Windows; every other scheme is refused.
 *   - Camera, microphone, location and notifications are refused. Clipboard
 *     and full screen are allowed — Docs and Sheets need the clipboard.
 */
'use strict';

const { normalizeWebUrl } = require('../case-notes/note-links.js');

const PARTITION = 'persist:viper-web-links';
const TOOLBAR_HEIGHT = 44;
const TOOLBAR_HEIGHT_WITH_BANNER = 80;
const APP_TITLE = 'VIPER Browser';

// Handed to Windows, never loaded in the window. mailto opens the mail
// client; the ms-* schemes are OneDrive/SharePoint "Open in Desktop App".
const EXTERNAL_SCHEMES = new Set([
  'mailto:', 'ms-word:', 'ms-excel:', 'ms-powerpoint:', 'ms-onenote:', 'ms-visio:'
]);

const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'
]);

// Firefox ships a new major version roughly every four weeks; 120 shipped
// on 21 Nov 2023. Computing the version from today's date keeps the window
// looking like a CURRENT Firefox as the years go by, so Google never
// starts calling it an outdated browser. A few cycles a year run five
// weeks, so the count runs slightly ahead of Mozilla; trailing it by
// FIREFOX_LAG keeps the window from claiming a Firefox that isn't out yet
// (a user one or two updates behind is entirely ordinary).
const FIREFOX_ANCHOR_VERSION = 120;
const FIREFOX_ANCHOR_MS = Date.UTC(2023, 10, 21);
const FIREFOX_CYCLE_MS = 28 * 24 * 60 * 60 * 1000;
const FIREFOX_LAG = 2;

function firefoxMajor(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const steps = Math.floor((now - FIREFOX_ANCHOR_MS) / FIREFOX_CYCLE_MS) - FIREFOX_LAG;
  return FIREFOX_ANCHOR_VERSION + Math.max(0, steps);
}

// MEASURED Oct 2026 (real Electron 28, real accounts.google.com, a made-up
// address typed into the sign-in box): with a Chrome identity Google went
// straight to /signin/rejected ("This browser or app may not be secure")
// 3 times out of 3, even with "Google Chrome" injected into the client
// hints. With a Firefox identity it went on to the normal next step 3
// times out of 7. Google decides per attempt, so Firefox is the better
// identity but not a guarantee. The toolbar banner and "Open in my
// browser" cover the times it refuses.
function firefoxUserAgent(nowMs) {
  const v = firefoxMajor(nowMs);
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}

// Chromium's client-hint headers. Real Firefox never sends them, so a
// window claiming to be Firefox must not either.
function isClientHintHeader(name) {
  return /^sec-ch-ua/i.test(String(name || ''));
}

// Google's "Couldn't sign you in — this browser or app may not be secure"
// page lives under accounts.google.com/…/rejected.
function isGoogleSigninRejected(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname === 'accounts.google.com' && /rejected/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

// 'web' loads in the window, 'external' goes to Windows, 'block' is refused.
function classifyNavigation(url) {
  const s = String(url || '');
  if (/^https?:\/\//i.test(s)) return normalizeWebUrl(s) ? 'web' : 'block';
  if (s === 'about:blank') return 'web';
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(s);
  if (m && EXTERNAL_SCHEMES.has(m[1].toLowerCase())) return 'external';
  return 'block';
}

/**
 * deps: { BrowserWindow, BrowserView, session, shell, ipcMain, Menu,
 *         clipboard, iconPath, toolbarFile, toolbarPreload, log? }
 */
function createLinkBrowser(deps) {
  const {
    BrowserWindow, BrowserView, session, shell, ipcMain, Menu, clipboard,
    iconPath, toolbarFile, toolbarPreload
  } = deps;
  const log = deps.log || (() => {});
  const records = new Set();
  let ses = null;

  function getSession() {
    if (ses) return ses;
    const s = session.fromPartition(PARTITION);
    s.setUserAgent(firefoxUserAgent());
    if (s.webRequest && typeof s.webRequest.onBeforeSendHeaders === 'function') {
      s.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders || {};
        for (const k of Object.keys(h)) {
          if (isClientHintHeader(k)) delete h[k];
        }
        cb({ requestHeaders: h });
      });
    }
    s.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMISSIONS.has(perm)));
    if (typeof s.setPermissionCheckHandler === 'function') {
      s.setPermissionCheckHandler((_wc, perm) => ALLOWED_PERMISSIONS.has(perm));
    }
    ses = s;
    return s;
  }

  function webPrefs() {
    return { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false };
  }

  function openExternal(url) {
    const kind = classifyNavigation(url);
    if (kind === 'web' && url !== 'about:blank') return shell.openExternal(normalizeWebUrl(url));
    if (kind === 'external') return shell.openExternal(url);
    return Promise.resolve();
  }

  function alive(rec) {
    return rec && rec.win && !rec.win.isDestroyed() &&
      rec.view && rec.view.webContents && !rec.view.webContents.isDestroyed();
  }

  function layout(rec) {
    if (!alive(rec)) return;
    const b = rec.win.getContentBounds();
    const top = rec.toolbarHeight;
    rec.view.setBounds({ x: 0, y: top, width: Math.max(0, b.width), height: Math.max(0, b.height - top) });
  }

  function stateOf(rec) {
    const wc = rec.view.webContents;
    const url = wc.getURL() || rec.lastUrl;
    return {
      url,
      title: wc.getTitle() || '',
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      loading: wc.isLoading(),
      secure: /^https:/i.test(url),
      error: rec.error,
      googleBlocked: isGoogleSigninRejected(url)
    };
  }

  function pushState(rec) {
    if (!alive(rec)) return;
    const st = stateOf(rec);
    const wantHeight = (st.error || st.googleBlocked) ? TOOLBAR_HEIGHT_WITH_BANNER : TOOLBAR_HEIGHT;
    if (wantHeight !== rec.toolbarHeight) { rec.toolbarHeight = wantHeight; layout(rec); }
    const title = st.title && st.title !== st.url ? `${st.title} — ${APP_TITLE}` : APP_TITLE;
    rec.win.setTitle(title);
    if (rec.win.webContents && !rec.win.webContents.isDestroyed()) {
      rec.win.webContents.send('link-browser:state', st);
    }
  }

  function contextMenu(wc, params, rec) {
    if (!Menu) return;
    const t = [];
    if (params.linkURL && classifyNavigation(params.linkURL) === 'web') {
      t.push(
        { label: 'Open link in a new VIPER window', click: () => open(params.linkURL) },
        { label: 'Open link in my browser', click: () => openExternal(params.linkURL) },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    const f = params.editFlags || {};
    if (params.isEditable) {
      t.push(
        { label: 'Cut', enabled: !!f.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: !!f.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: !!f.canPaste, click: () => wc.paste() },
        { label: 'Select all', click: () => wc.selectAll() },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      t.push({ label: 'Copy', click: () => wc.copy() }, { type: 'separator' });
    }
    t.push(
      { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Open this page in my browser', click: () => openExternal(wc.getURL()) }
    );
    Menu.buildFromTemplate(t).popup(rec && rec.win && !rec.win.isDestroyed() ? { window: rec.win } : {});
  }

  // Applied to the page in every link window AND to every popup it opens
  // (sign-in popups, "open in new window"), however deep.
  function guardContents(wc, rec) {
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const kind = classifyNavigation(url);
      if (kind === 'external') { openExternal(url); return { action: 'deny' }; }
      if (kind !== 'web') return { action: 'deny' };
      // A scripted popup (sign-in, share dialog) must stay attached to the
      // page that opened it or the sign-in never reports back. A plain
      // "open in new tab" link gets a full window with its own toolbar.
      if (disposition === 'new-window' || url === 'about:blank') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, autoHideMenuBar: true, icon: iconPath,
            title: APP_TITLE, webPreferences: webPrefs()
          }
        };
      }
      open(url);
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      rec.children.add(child);
      child.on('closed', () => rec.children.delete(child));
      if (typeof child.removeMenu === 'function') child.removeMenu();
      guardContents(child.webContents, rec);
    });

    const onNav = (e, navUrl) => {
      const u = (e && e.url) || navUrl;
      const kind = classifyNavigation(u);
      if (kind === 'web') return;
      e.preventDefault();
      if (kind === 'external') openExternal(u);
    };
    wc.on('will-navigate', onNav);
    wc.on('will-redirect', onNav);

    wc.on('context-menu', (_e, params) => contextMenu(wc, params, rec));

    wc.on('before-input-event', (e, input) => {
      if (!input || input.type !== 'keyDown') return;
      const k = input.key;
      const ctrl = input.control || input.meta;
      if (input.alt && k === 'ArrowLeft') { if (wc.canGoBack()) wc.goBack(); e.preventDefault(); }
      else if (input.alt && k === 'ArrowRight') { if (wc.canGoForward()) wc.goForward(); e.preventDefault(); }
      else if (k === 'F5' || (ctrl && (k === 'r' || k === 'R'))) { wc.reload(); e.preventDefault(); }
      else if (ctrl && (k === 'w' || k === 'W')) {
        const w = BrowserWindow.fromWebContents ? BrowserWindow.fromWebContents(wc) : null;
        const target = w || (rec.view.webContents === wc ? rec.win : null);
        if (target && !target.isDestroyed()) target.close();
        e.preventDefault();
      }
    });
  }

  function wireState(rec) {
    const wc = rec.view.webContents;
    const push = () => pushState(rec);
    wc.on('did-start-loading', () => { rec.error = null; push(); });
    wc.on('did-stop-loading', push);
    wc.on('did-navigate', (_e, u) => { if (u) rec.lastUrl = u; push(); });
    wc.on('did-navigate-in-page', (_e, u, isMainFrame) => { if (u && isMainFrame !== false) rec.lastUrl = u; push(); });
    wc.on('page-title-updated', push);
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (code === -3 || isMainFrame === false) return;   // -3 = superseded by another load
      rec.error = { code, description: String(description || 'Load failed'), url: failedUrl || rec.lastUrl };
      push();
    });
    rec.win.webContents.on('did-finish-load', push);
  }

  // The address worth copying or handing to the officer's own browser.
  // Google's refusal page is useless there — give back the note's link.
  function shareableUrl(rec) {
    const cur = rec.view.webContents.getURL() || rec.lastUrl;
    return isGoogleSigninRejected(cur) ? rec.openedUrl : cur;
  }

  function findByToolbar(sender) {
    for (const r of records) {
      if (r.win && !r.win.isDestroyed() && r.win.webContents === sender) return r;
    }
    return null;
  }

  ipcMain.on('link-browser:cmd', (e, cmd) => {
    const rec = findByToolbar(e.sender);
    if (!alive(rec)) return;
    const wc = rec.view.webContents;
    switch (String(cmd)) {
      case 'back': if (wc.canGoBack()) wc.goBack(); break;
      case 'forward': if (wc.canGoForward()) wc.goForward(); break;
      case 'reload':
        if (rec.error && rec.error.url) { const u = rec.error.url; rec.error = null; wc.loadURL(u).catch(() => {}); }
        // Re-running Google's refusal page just shows it again; start the
        // sign-in over from the officer's own link instead.
        else if (isGoogleSigninRejected(wc.getURL())) wc.loadURL(rec.openedUrl).catch(() => {});
        else wc.reload();
        break;
      case 'stop': wc.stop(); break;
      case 'external': openExternal(shareableUrl(rec)); break;
      case 'copy': clipboard.writeText(shareableUrl(rec)); break;
      default: break;
    }
  });

  function open(raw) {
    const url = normalizeWebUrl(raw);
    if (!url) return { success: false, error: 'That is not a web address.' };

    // Clicking the same link twice brings the window forward instead of
    // stacking copies of it.
    for (const r of records) {
      if (alive(r) && (r.openedUrl === url || r.lastUrl === url)) {
        if (r.win.isMinimized()) r.win.restore();
        r.win.show();
        r.win.focus();
        return { success: true, reused: true };
      }
    }

    getSession();
    const win = new BrowserWindow({
      width: 1200, height: 860, minWidth: 560, minHeight: 360,
      title: APP_TITLE, icon: iconPath, backgroundColor: '#0f1117', autoHideMenuBar: true,
      webPreferences: {
        preload: toolbarPreload, sandbox: true, contextIsolation: true, nodeIntegration: false
      }
    });
    if (typeof win.removeMenu === 'function') win.removeMenu();
    const view = new BrowserView({ webPreferences: webPrefs() });
    const rec = {
      win, view, children: new Set(), openedUrl: url, lastUrl: url,
      error: null, toolbarHeight: TOOLBAR_HEIGHT
    };
    records.add(rec);

    // The toolbar page must not rename the window after itself.
    win.on('page-title-updated', (e) => e.preventDefault());
    // Attach and size the view BEFORE loading anything into it.
    win.setBrowserView(view);
    layout(rec);
    for (const ev of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
      win.on(ev, () => layout(rec));
    }
    wireState(rec);
    guardContents(view.webContents, rec);

    win.on('closed', () => {
      records.delete(rec);
      for (const c of rec.children) { try { if (!c.isDestroyed()) c.close(); } catch (_) {} }
      rec.children.clear();
      try {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed()) {
          if (typeof wc.close === 'function') wc.close();
          else if (typeof wc.destroy === 'function') wc.destroy();
        }
      } catch (_) {}
    });

    win.loadFile(toolbarFile).catch((err) => log('toolbar load failed', err && err.message));
    view.webContents.loadURL(url).catch(() => { /* did-fail-load reports it */ });
    return { success: true };
  }

  async function signOut() {
    let closed = 0;
    for (const r of Array.from(records)) {
      try {
        if (r.win && !r.win.isDestroyed()) { r.win.close(); closed++; }
      } catch (_) {}
    }
    const s = getSession();
    await s.clearStorageData();
    await s.clearCache();
    if (typeof s.clearAuthCache === 'function') await s.clearAuthCache();
    return { success: true, closedWindows: closed };
  }

  return {
    open,
    signOut,
    windowCount: () => Array.from(records).filter(alive).length,
    _records: records
  };
}

module.exports = {
  PARTITION,
  TOOLBAR_HEIGHT,
  TOOLBAR_HEIGHT_WITH_BANNER,
  EXTERNAL_SCHEMES,
  ALLOWED_PERMISSIONS,
  firefoxMajor,
  firefoxUserAgent,
  isClientHintHeader,
  isGoogleSigninRejected,
  classifyNavigation,
  createLinkBrowser
};
