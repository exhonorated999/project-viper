/**
 * The VIPER browser window (modules/_shared/link-browser.js).
 *
 * Where a link clicked in a Case Note opens. Runs the REAL module against
 * a fake Electron and pins the parts that matter to an officer and to the
 * security of the app:
 *   - one remembered session (sign in once) that Settings can wipe;
 *   - the session presents as Chrome so Google allows sign-in;
 *   - the web page has no Node, no preload, a sandbox, and only http(s)
 *     loads inside it — mail / Office desktop links go to Windows, every
 *     other scheme is refused;
 *   - sign-in popups stay attached to their opener; "new tab" links get a
 *     full window; popups inherit the same guards;
 *   - camera / microphone / location are refused;
 *   - a failed load or a Google sign-in refusal shows the banner with
 *     "Open in my browser";
 *   - only the window's own toolbar can drive it;
 *   - the IPC + preload wiring in electron-main.js / preload.js.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd
 *      modules\_shared\__tests__\link-browser.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const LB = require('../link-browser.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL: ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
}
function eq(a, b, name) { ok(a === b, name, { got: a, want: b }); }

// ── Fake Electron ───────────────────────────────────────────────────
class Emitter {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return this; }
    emit(ev, ...args) { (this._l[ev] || []).slice().forEach((fn) => fn(...args)); }
    count(ev) { return (this._l[ev] || []).length; }
}
const log = [];
class FakeWC extends Emitter {
    constructor(kind) {
        super();
        this.kind = kind; this.url = ''; this.title = ''; this.back = false; this.fwd = false;
        this.loading = false; this.destroyed = false; this.sent = []; this.openHandler = null; this.loads = [];
    }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    canGoBack() { return this.back; }
    canGoForward() { return this.fwd; }
    isLoading() { return this.loading; }
    isDestroyed() { return this.destroyed; }
    loadURL(u) { log.push(this.kind + ':loadURL'); this.loads.push(u); return Promise.resolve(); }
    send(ch, data) { this.sent.push([ch, data]); }
    goBack() { log.push('goBack'); } goForward() { log.push('goForward'); }
    reload() { log.push('reload'); } stop() { log.push('stop'); }
    cut() {} copy() {} paste() {} selectAll() {}
    close() { this.destroyed = true; }
}
const windows = [];
class FakeBrowserWindow extends Emitter {
    constructor(opts) {
        super();
        this.opts = opts; this.webContents = new FakeWC('toolbar'); this.destroyed = false;
        this.bv = null; this.title = ''; this.minimized = false; this.focused = 0; this.menuRemoved = false;
        windows.push(this);
    }
    static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
    removeMenu() { this.menuRemoved = true; }
    setBrowserView(v) { log.push('setBrowserView'); this.bv = v; }
    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 860 }; }
    loadFile(f) { log.push('toolbar:loadFile'); this.file = f; return Promise.resolve(); }
    setTitle(t) { this.title = t; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; } show() {} focus() { this.focused++; }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
}
const views = [];
class FakeBrowserView {
    constructor(opts) { this.opts = opts; this.webContents = new FakeWC('view'); this.bounds = null; views.push(this); }
    setBounds(b) { log.push('setBounds'); this.bounds = b; }
}
const sessions = {};
function fakeSession(part) {
    const s = {
        part, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) viper-electron/5.4.2 Chrome/120.0.6099.291 Electron/28.3.3 Safari/537.36',
        cleared: [], headerFn: null, permReq: null, permCheck: null,
        getUserAgent() { return this.ua; }, setUserAgent(u) { this.ua = u; },
        webRequest: { onBeforeSendHeaders: (fn) => { s.headerFn = fn; } },
        setPermissionRequestHandler(fn) { this.permReq = fn; },
        setPermissionCheckHandler(fn) { this.permCheck = fn; },
        clearStorageData() { this.cleared.push('storage'); return Promise.resolve(); },
        clearCache() { this.cleared.push('cache'); return Promise.resolve(); },
        clearAuthCache() { this.cleared.push('auth'); return Promise.resolve(); }
    };
    return s;
}
const session = { fromPartition: (p) => (sessions[p] = sessions[p] || fakeSession(p)) };
const shellCalls = [];
const shell = { openExternal: (u) => { shellCalls.push(u); return Promise.resolve(); } };
const ipcListeners = {};
const ipcMain = { on: (ch, fn) => { ipcListeners[ch] = fn; } };
const menus = [];
const Menu = { buildFromTemplate: (t) => ({ t, popup() { menus.push(t); } }) };
const clip = [];
const clipboard = { writeText: (t) => clip.push(t) };

const DRIVE = 'https://drive.google.com/drive/folders/1AbC?usp=sharing';
const DOC = 'https://docs.google.com/document/d/1x2Y3z/edit';

(async () => {
    // ── Pure helpers ────────────────────────────────────────────────
    const A = Date.UTC(2023, 10, 21), D = 864e5;
    eq(LB.firefoxMajor(A), 120, 'Firefox 120 at the anchor date');
    eq(LB.firefoxMajor(A + 84 * D - 1), 120, 'trails Mozilla by two cycles: still 120 just before week 12');
    eq(LB.firefoxMajor(A + 84 * D), 121, '121 at week 12 (three cycles, minus the two-cycle lag)');
    eq(LB.firefoxMajor(Date.UTC(2026, 9, 15)), 155, 'Oct 2026 → 155 (Mozilla shipped ~156; never ahead of it)');
    eq(LB.firefoxMajor(Date.UTC(2020, 0, 1)), 120, 'a wrong (past) clock never goes below 120');
    eq(LB.firefoxUserAgent(A),
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
        'exact Firefox-on-Windows user agent shape');
    const nowUa = LB.firefoxUserAgent();
    ok(!/Electron|viper|V\.I\.P\.E\.R|Chrome|AppleWebKit/i.test(nowUa), 'no Electron / VIPER / Chrome tokens', nowUa);
    for (const h of ['sec-ch-ua', 'Sec-CH-UA', 'sec-ch-ua-mobile', 'Sec-CH-UA-Platform', 'sec-ch-ua-full-version-list'])
        eq(LB.isClientHintHeader(h), true, 'client hint recognised: ' + h);
    for (const h of ['Accept', 'User-Agent', 'Sec-Fetch-Mode', 'sec-ch-prefers-color-scheme', '', null])
        eq(LB.isClientHintHeader(h), false, 'not a UA client hint: ' + JSON.stringify(h));

    eq(LB.isGoogleSigninRejected('https://accounts.google.com/v3/signin/rejected?x=1'), true, 'Google rejection page recognised');
    eq(LB.isGoogleSigninRejected('https://accounts.google.com/v3/signin/identifier'), false, 'normal Google sign-in page is not a rejection');
    eq(LB.isGoogleSigninRejected('https://evil.com/accounts.google.com/rejected'), false, 'rejection only counts on accounts.google.com');

    const nav = [
        [DRIVE, 'web'], ['http://intranet.agency.local/x', 'web'], ['about:blank', 'web'],
        ['mailto:det@agency.gov', 'external'], ['ms-word:ofe|u|https://x.sharepoint.com/a.docx', 'external'],
        ['MS-EXCEL:ofv|u|https://x/b.xlsx', 'external'],
        ['javascript:alert(1)', 'block'], ['file:///C:/Windows/System32/calc.exe', 'block'],
        ['data:text/html,hi', 'block'], ['ms-settings:privacy', 'block'], ['search-ms:query=x', 'block'],
        ['viper-media://x', 'block'], ['', 'block'], [null, 'block']
    ];
    for (const [u, want] of nav) eq(LB.classifyNavigation(u), want, 'navigation ' + JSON.stringify(u) + ' → ' + want);

    // ── createLinkBrowser ───────────────────────────────────────────
    const lb = LB.createLinkBrowser({
        BrowserWindow: FakeBrowserWindow, BrowserView: FakeBrowserView, session, shell, ipcMain, Menu,
        clipboard, iconPath: 'icon.ico', toolbarFile: 'C:/app/link-browser.html', toolbarPreload: 'C:/app/link-browser-preload.js'
    });
    ok(typeof ipcListeners['link-browser:cmd'] === 'function', 'toolbar command channel registered');

    eq(lb.open('javascript:alert(1)').success, false, 'refuses to open a non-web address');
    eq(lb.open('file:///C:/x').success, false, 'refuses file:');
    eq(windows.length, 0, '…without creating any window');

    log.length = 0;
    const r1 = lb.open('  ' + DRIVE + ' ');
    eq(r1.success, true, 'opens a Drive link');
    eq(windows.length, 1, 'one window');
    eq(views.length, 1, 'one web view');
    const w = windows[0];
    const v = views[0];
    const s = sessions[LB.PARTITION];
    ok(!!s, 'the remembered session (' + LB.PARTITION + ') is used');
    ok(/^persist:/.test(LB.PARTITION), 'the session is persistent (sign in once)');

    // web page isolation
    const vp = v.opts.webPreferences;
    eq(vp.partition, LB.PARTITION, 'web page uses the remembered session');
    eq(vp.sandbox, true, 'web page sandboxed');
    eq(vp.contextIsolation, true, 'web page context-isolated');
    eq(vp.nodeIntegration, false, 'web page has no Node');
    eq(vp.preload, undefined, 'web page has NO preload');
    // toolbar
    eq(w.opts.webPreferences.preload, 'C:/app/link-browser-preload.js', 'toolbar gets the tiny toolbar preload');
    eq(w.opts.webPreferences.sandbox, true, 'toolbar sandboxed');
    eq(w.opts.webPreferences.nodeIntegration, false, 'toolbar has no Node');
    eq(w.file, 'C:/app/link-browser.html', 'toolbar page loaded');
    ok(w.menuRemoved, 'no menu bar');
    eq(v.webContents.loads[0], DRIVE, 'the page loads the normalised link');
    const iAttach = log.indexOf('setBrowserView');
    const iBounds = log.indexOf('setBounds');
    const iLoad = log.indexOf('view:loadURL');
    ok(iAttach >= 0 && iAttach < iBounds && iBounds < iLoad, 'view attached and sized BEFORE it loads', log);
    eq(JSON.stringify(v.bounds), JSON.stringify({ x: 0, y: LB.TOOLBAR_HEIGHT, width: 1200, height: 860 - LB.TOOLBAR_HEIGHT }),
        'page sits under the toolbar');

    // Firefox presentation (Google refuses sign-in to Chrome-from-Electron)
    ok(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/.test(s.ua),
        'session user agent is Firefox', s.ua);
    ok(!/Electron|viper-electron|Chrome/.test(s.ua), 'no Electron / Chrome token left in the session user agent', s.ua);
    let hdrOut = null;
    s.headerFn({ requestHeaders: { 'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"', 'Sec-CH-UA-Platform': '"Windows"',
        'sec-ch-ua-mobile': '?0', Accept: 'x', 'User-Agent': 'UA' } }, (r) => { hdrOut = r; });
    eq(Object.keys(hdrOut.requestHeaders).filter((k) => /^sec-ch-ua/i.test(k)).length, 0, 'every Sec-CH-UA* header removed (Firefox never sends them)');
    eq(hdrOut.requestHeaders.Accept, 'x', 'other headers untouched');
    eq(hdrOut.requestHeaders['User-Agent'], 'UA', 'User-Agent header untouched by the filter');
    s.headerFn({ requestHeaders: { Accept: 'y' } }, (r) => { hdrOut = r; });
    eq(JSON.stringify(hdrOut.requestHeaders), '{"Accept":"y"}', 'a request with no client hints passes through unchanged');

    // permissions
    const perm = (p) => { let got; s.permReq(null, p, (x) => { got = x; }); return got; };
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'hid', 'serial', 'usb', 'display-capture'])
        eq(perm(p), false, 'permission refused: ' + p);
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
        eq(perm(p), true, 'permission allowed: ' + p);
    eq(s.permCheck(null, 'media'), false, 'permission CHECK also refuses media');

    // reuse
    const r2 = lb.open(DRIVE);
    ok(r2.success && r2.reused, 'clicking the same link again brings its window forward');
    eq(windows.length, 1, '…no second window');
    ok(w.focused >= 1, '…focused');

    // ── window-open handler ────────────────────────────────────────
    const vwc = v.webContents;
    let res = vwc.openHandler({ url: 'https://accounts.google.com/o/oauth2/auth?x', disposition: 'new-window' });
    eq(res.action, 'allow', 'a scripted sign-in popup is allowed (stays attached to its opener)');
    eq(res.overrideBrowserWindowOptions.webPreferences.partition, LB.PARTITION, '…in the same remembered session');
    eq(res.overrideBrowserWindowOptions.webPreferences.sandbox, true, '…sandboxed');
    eq(res.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false, '…no Node');
    eq(res.overrideBrowserWindowOptions.webPreferences.preload, undefined, '…no preload');
    res = vwc.openHandler({ url: DOC, disposition: 'foreground-tab' });
    eq(res.action, 'deny', '"open in new tab" is not a bare popup…');
    eq(windows.length, 2, '…it gets a full VIPER browser window');
    eq(views[1].webContents.loads[0], DOC, '…loading that document');
    shellCalls.length = 0;
    res = vwc.openHandler({ url: 'mailto:det@agency.gov', disposition: 'foreground-tab' });
    ok(res.action === 'deny' && shellCalls[0] === 'mailto:det@agency.gov', 'mail link handed to Windows');
    res = vwc.openHandler({ url: 'javascript:alert(1)', disposition: 'new-window' });
    ok(res.action === 'deny' && shellCalls.length === 1, 'javascript: popup refused, nothing launched');
    res = vwc.openHandler({ url: 'file:///C:/x.exe', disposition: 'foreground-tab' });
    ok(res.action === 'deny' && shellCalls.length === 1 && windows.length === 2, 'file: popup refused, nothing launched');

    // popups inherit the guards
    const child = new FakeBrowserWindow({});
    vwc.emit('did-create-window', child);
    ok(typeof child.webContents.openHandler === 'function', 'a popup gets the same window-open guard');
    ok(child.webContents.count('will-navigate') === 1, '…and the same navigation guard');
    eq(child.webContents.openHandler({ url: 'ms-settings:x', disposition: 'new-window' }).action, 'deny', '…which refuses odd schemes');

    // ── navigation guard ───────────────────────────────────────────
    function navigate(wc, ev, u) {
        const e = { url: u, prevented: false, preventDefault() { this.prevented = true; } };
        wc.emit(ev, e, u);
        return e.prevented;
    }
    shellCalls.length = 0;
    eq(navigate(vwc, 'will-navigate', DOC), false, 'https navigation allowed inside the window');
    eq(navigate(vwc, 'will-navigate', 'https://login.microsoftonline.com/common/oauth2'), false, 'Microsoft sign-in allowed');
    eq(navigate(vwc, 'will-navigate', 'https://adfs.agency.gov/adfs/ls'), false, 'an agency\'s own sign-in server allowed');
    eq(navigate(vwc, 'will-navigate', 'file:///C:/Windows/win.ini'), true, 'file: navigation blocked');
    eq(navigate(vwc, 'will-redirect', 'javascript:alert(1)'), true, 'javascript: redirect blocked');
    eq(shellCalls.length, 0, '…neither launched anything');
    eq(navigate(vwc, 'will-navigate', 'ms-word:ofe|u|https://x.sharepoint.com/a.docx'), true, 'Office desktop link not loaded in the window…');
    eq(shellCalls[0], 'ms-word:ofe|u|https://x.sharepoint.com/a.docx', '…handed to Windows to open Word');

    // ── state, banner, title ───────────────────────────────────────
    vwc.url = DRIVE; vwc.title = 'Case 24-1187 - Google Drive'; vwc.back = true;
    vwc.emit('did-navigate', {}, DRIVE);
    let st = w.webContents.sent.filter((x) => x[0] === 'link-browser:state').pop();
    ok(st && st[1].url === DRIVE && st[1].canGoBack === true && st[1].secure === true, 'toolbar told the address and back state', st);
    eq(w.title, 'Case 24-1187 - Google Drive — VIPER Browser', 'window titled after the page');
    vwc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://drive.google.com/x', true);
    st = w.webContents.sent.filter((x) => x[0] === 'link-browser:state').pop()[1];
    ok(st.error && st.error.description === 'ERR_NAME_NOT_RESOLVED', 'a failed load reaches the toolbar');
    eq(v.bounds.y, LB.TOOLBAR_HEIGHT_WITH_BANNER, '…and the page moves down to make room for the banner');
    log.length = 0;
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'reload');
    eq(vwc.loads[vwc.loads.length - 1], 'https://drive.google.com/x', '"Try again" reloads the address that failed');
    vwc.emit('did-start-loading');
    eq(v.bounds.y, LB.TOOLBAR_HEIGHT, 'banner goes away when a new load starts');
    vwc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', DOC, true);
    st = w.webContents.sent.filter((x) => x[0] === 'link-browser:state').pop()[1];
    eq(st.error, null, 'a superseded load (-3) is not an error');
    vwc.emit('did-fail-load', {}, -105, 'x', DOC, false);
    st = w.webContents.sent.filter((x) => x[0] === 'link-browser:state').pop()[1];
    eq(st.error, null, 'a failed sub-frame is not a page error');
    vwc.url = 'https://accounts.google.com/v3/signin/rejected?continue=x';
    vwc.emit('did-navigate', {}, vwc.url);
    st = w.webContents.sent.filter((x) => x[0] === 'link-browser:state').pop()[1];
    ok(st.googleBlocked === true && v.bounds.y === LB.TOOLBAR_HEIGHT_WITH_BANNER, 'Google sign-in refusal shows the banner');
    shellCalls.length = 0; clip.length = 0;
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'external');
    eq(shellCalls[0], DRIVE, 'on Google\'s refusal page "Open in my browser" hands over the NOTE\'s link, not the refusal page');
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'copy');
    eq(clip[0], DRIVE, '…and "Copy link" copies the note\'s link');
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'reload');
    eq(vwc.loads[vwc.loads.length - 1], DRIVE, '"Try again" on the refusal page restarts from the note\'s link');

    // ── toolbar commands ───────────────────────────────────────────
    shellCalls.length = 0; clip.length = 0; log.length = 0;
    vwc.url = DOC;
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'external');
    eq(shellCalls[0], DOC, '"Open in my browser" hands the CURRENT page to the system browser');
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'copy');
    eq(clip[0], DOC, '"Copy link" copies the current page address');
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'back');
    ok(log.includes('goBack'), 'Back works');
    log.length = 0;
    ipcListeners['link-browser:cmd']({ sender: vwc }, 'back');
    ipcListeners['link-browser:cmd']({ sender: new FakeWC('stranger') }, 'external');
    ok(log.length === 0 && shellCalls.length === 1, 'only the window\'s OWN toolbar can drive it (not the web page, not others)');
    vwc.url = 'javascript:alert(1)';
    ipcListeners['link-browser:cmd']({ sender: w.webContents }, 'external');
    eq(shellCalls.length, 1, '"Open in my browser" never hands a non-web address to Windows');
    vwc.url = DOC;

    // context menu
    menus.length = 0;
    vwc.emit('context-menu', {}, { linkURL: DOC, isEditable: false, selectionText: '', editFlags: {} });
    ok(menus.length === 1 && menus[0].some((i) => i.label === 'Open link in my browser') && menus[0].some((i) => i.label === 'Copy link'),
        'right-click on a link offers open / copy');
    menus.length = 0;
    vwc.emit('context-menu', {}, { linkURL: 'javascript:x', isEditable: true, selectionText: '', editFlags: { canPaste: true } });
    ok(!menus[0].some((i) => /Open link/.test(i.label || '')) && menus[0].some((i) => i.label === 'Paste'),
        'no "open link" for a non-web link; editing items when editable');

    // keyboard
    log.length = 0;
    const key = (k, mods) => { const e = { preventDefault() { this.p = true; } }; vwc.emit('before-input-event', e, Object.assign({ type: 'keyDown', key: k }, mods || {})); return e.p; };
    ok(key('F5') && log.includes('reload'), 'F5 reloads');
    ok(key('ArrowLeft', { alt: true }) && log.includes('goBack'), 'Alt+Left goes back');
    ok(!key('b', { control: true }), 'Ctrl+B (bold in Docs) is left to the page');

    // ── sign out + close ───────────────────────────────────────────
    const second = windows[1];
    const secondView = views[1];
    eq(lb.windowCount(), 2, 'two windows open before sign-out');
    const so = await lb.signOut();
    ok(so.success && so.closedWindows === 2, 'sign-out closes every VIPER browser window', so);
    ok(w.destroyed && second.destroyed, '…both closed');
    ok(child.destroyed, '…popups too');
    ok(v.webContents.destroyed && secondView.webContents.destroyed, '…and their pages released');
    eq(s.cleared.join(','), 'storage,cache,auth', '…then wipes stored sign-ins, cache and auth');
    eq(lb.windowCount(), 0, 'no windows left');
    const r3 = lb.open(DRIVE);
    ok(r3.success && !r3.reused && windows.length === 4, 'after sign-out the same link opens a fresh window');

    // ── Shipping wiring ────────────────────────────────────────────
    const ROOT = path.join(__dirname, '..', '..', '..');
    const MAIN = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
    const PRE = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
    const SET = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8').replace(/\r\n/g, '\n');
    const TB = fs.readFileSync(path.join(ROOT, 'link-browser.html'), 'utf8').replace(/\r\n/g, '\n');
    const TBP = fs.readFileSync(path.join(ROOT, 'link-browser-preload.js'), 'utf8');
    ok(/ipcMain\.handle\('open-web-link'/.test(MAIN), 'main: open-web-link handler');
    ok(/ipcMain\.handle\('web-links-sign-out'/.test(MAIN), 'main: web-links-sign-out handler');
    ok(/require\('\.\/modules\/_shared\/link-browser\.js'\)\.createLinkBrowser\(/.test(MAIN), 'main: uses the shared module');
    ok(/toolbarFile: path\.join\(__dirname, 'link-browser\.html'\)/.test(MAIN), 'main: toolbar page path');
    ok(/toolbarPreload: path\.join\(__dirname, 'link-browser-preload\.js'\)/.test(MAIN), 'main: toolbar preload path');
    ok(/openWebLink: \(url\) => ipcRenderer\.invoke\('open-web-link', url\)/.test(PRE), 'preload: openWebLink');
    ok(/webLinksSignOut: \(\) => ipcRenderer\.invoke\('web-links-sign-out'\)/.test(PRE), 'preload: webLinksSignOut');
    ok(/onclick="signOutWebLinks\(\)"/.test(SET) && /async function signOutWebLinks\(\)/.test(SET), 'settings: sign-out button wired');
    ok(/electronAPI\.webLinksSignOut\(\)/.test(SET), 'settings: calls the bridge');
    ok(/Content-Security-Policy" content="default-src 'none'/.test(TB), 'toolbar page has a locked-down CSP');
    ok(TB.indexOf('innerHTML') === -1, 'toolbar never uses innerHTML (page titles / addresses are untrusted)');
    ok(/exposeInMainWorld\('viperLinkBrowser'/.test(TBP) && TBP.indexOf('electronAPI') === -1, 'toolbar preload exposes only the toolbar API');
    // 80 = 44 toolbar + 36 banner, as laid out in link-browser.html
    ok(/\.bar \{ height: 44px;/.test(TB) && /\.banner \{ height: 36px;/.test(TB), 'toolbar CSS heights match the module');
    eq(LB.TOOLBAR_HEIGHT, 44, 'toolbar height 44');
    eq(LB.TOOLBAR_HEIGHT_WITH_BANNER, 80, 'toolbar + banner height 80');

    console.log(`${pass} passed \u00b7 ${fail} failed`);
    if (fail) process.exit(1);
})().catch((err) => { console.log('FAIL: threw ' + (err && err.stack || err)); process.exit(1); });
