const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, globalShortcut, session, protocol, net } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const SecurityManager = require('./modules/security');
const AuditLogger = require('./modules/audit-log');
const AUDIT_EVENTS = AuditLogger.EVENT_TYPES;

// Shared temp dir for Resource Hub captures (downloads, PDFs, single-file HTML).
// Hoisted to module scope so IPC handlers can access it.
const rhDownloadTmpDir = path.join(os.tmpdir(), 'viper-rh-downloads');
try { fs.mkdirSync(rhDownloadTmpDir, { recursive: true }); } catch (_) {}

// ── Datapilot custom media protocol ──────────────────────────────────
// The renderer is loaded over http://localhost, which blocks `file:///` URLs
// for local resources (e.g. videos). We register a custom `viper-media://`
// scheme as privileged so the renderer can stream local files via tokens
// without exposing absolute paths in the URL or running afoul of CSP.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'viper-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);

// token → { absPath, expiresAt }. Tokens are short-lived (1 hour) and only
// resolved by the protocol handler. The renderer never sees the absolute path.
const datapilotMediaTokens = new Map();
function _datapilotIssueMediaToken(absPath) {
  // Reuse token if same path already issued and unexpired
  const now = Date.now();
  for (const [tok, entry] of datapilotMediaTokens) {
    if (entry.expiresAt < now) datapilotMediaTokens.delete(tok);
    else if (entry.absPath === absPath) return tok;
  }
  const tok = crypto.randomBytes(16).toString('hex');
  datapilotMediaTokens.set(tok, { absPath, expiresAt: now + 60 * 60 * 1000 });
  return tok;
}

// electron-updater: lazy-load to avoid crashing in dev mode
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  console.warn('electron-updater not available (dev mode):', e.message);
}

let mainWindow;
let server;
let apertureProcess = null;
let security = null;
let audit = null;
let isQuitting = false;
let mediaPlayerWindow = null;
let mediaBrowserView = null;
let mediaViewVisible = false;
let lastMediaBounds = null;
let flockBrowserView = null;
let flockViewVisible = false;
let lastFlockBounds = null;
let tloBrowserView = null;
let tloViewVisible = false;
let lastTloBounds = null;
let accurintBrowserView = null;
let accurintViewVisible = false;
let lastAccurintBounds = null;
let vigilantBrowserView = null;
let vigilantViewVisible = false;
let lastVigilantBounds = null;
let icacDataSystemBrowserView = null;
let icacDataSystemViewVisible = false;
let lastIcacDataSystemBounds = null;
let icacCopsBrowserView = null;
let icacCopsViewVisible = false;
let lastIcacCopsBounds = null;
let gridcopBrowserView = null;
let gridcopViewVisible = false;
let lastGridcopBounds = null;

// Icon path: use unpacked asar path in production, normal path in dev
const iconPath = app.isPackaged
  ? path.join(__dirname, '..', 'app.asar.unpacked', 'build', 'icon.ico')
  : path.join(__dirname, 'build', 'icon.ico');

// ── Portable mode detection ──────────────────────────────────────────
// If the app is NOT installed under C:\Program Files, treat it as a portable
// USB / portable install. All user data (localStorage, security vault, cases)
// is stored on the USB itself so each stick is self-contained and independent.
// Detection: exe is on a non-system drive (USB stick), OR a .portable marker exists.
const exeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase();
const isPortable = app.isPackaged && (
  fs.existsSync(path.join(exeDir, '.portable')) ||
  !exeDir.toLowerCase().startsWith(systemDrive)
);

let casesDir;   // writable directory for case data
if (isPortable) {
  const portableData = path.join(exeDir, 'userdata');
  if (!fs.existsSync(portableData)) fs.mkdirSync(portableData, { recursive: true });
  app.setPath('userData', portableData);   // redirects localStorage, cookies, etc.
  casesDir = path.join(exeDir, 'cases');
  console.log('PORTABLE MODE — data stored on USB:', portableData);
} else {
  // Desktop install: cases next to the app in dev, or under userData in production
  casesDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'cases')
    : path.join(__dirname, 'cases');
}
if (!fs.existsSync(casesDir)) fs.mkdirSync(casesDir, { recursive: true });

// MIME types mapping
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Start local HTTP server
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsedUrl.pathname);
      console.log(`Request: ${pathname}`);
      
      let filePath = path.join(__dirname, pathname);
      if (pathname === '/') {
        filePath = path.join(__dirname, 'case-detail-with-analytics.html');
      }

      const extname = String(path.extname(filePath)).toLowerCase();
      const contentType = mimeTypes[extname] || 'application/octet-stream';

      fs.readFile(filePath, (error, content) => {
        if (error) {
          if (error.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 - File Not Found</h1>', 'utf-8');
          } else {
            res.writeHead(500);
            res.end(`Server Error: ${error.code}`, 'utf-8');
          }
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content, 'utf-8');
        }
      });
    });

    server.listen(8000, () => {
      console.log('Server running on http://localhost:8000');
      resolve();
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'VIPER - Network Intelligence',
    icon: iconPath,
    show: false,
    backgroundColor: '#1a1a1a'
  });

  // Handle window.open calls from renderer — create properly-sized popup windows
  // instead of letting Electron create blank default BrowserWindows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // For blank windows (window.open('', '_blank')) used for in-app previews,
    // allow but configure the popup properly
    if (!url || url === '' || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 800,
          height: 700,
          icon: iconPath,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false  // allow blob: and data: URLs in popups
          }
        }
      };
    }
    // For blob: and data: URLs, allow in popup
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 800,
          height: 700,
          icon: iconPath,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
          }
        }
      };
    }
    // For http/https URLs, open in system browser
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    // Deny everything else
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  });

  // Ensure web content always receives focus when the window is activated
  // Prevents the "first click ignored" issue with Electron modals/popups
  mainWindow.on('focus', () => {
    mainWindow.webContents.focus();
  });

  // Force focus back after native dialogs (file pickers, save dialogs)
  // NOTE: restoreFocus is defined at module scope (see below createWindow)

  // Gate on security — show login page or main app.
  // Always land on the Dashboard (index.html), not a case detail page.
  if (security && security.isEnabled()) {
    mainWindow.loadURL('http://localhost:8000/security-login.html');
  } else {
    mainWindow.loadURL('http://localhost:8000/index.html');
  }

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Vault save on close when security is active
  mainWindow.on('close', (e) => {
    if (!isQuitting && security && security.isEnabled() && security.isUnlocked()) {
      e.preventDefault();
      saveVaultAndQuit();
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
    if (apertureProcess) {
      apertureProcess.kill();
      apertureProcess = null;
    }
  });
}

// Force focus back after native dialogs (file pickers, save dialogs)
// Defined at module scope so all IPC handlers can access it
function restoreFocus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }, 100);
  }
}

// Encrypt localStorage snapshot to vault, clear sensitive data, then quit
async function saveVaultAndQuit() {
  try {
    const data = await mainWindow.webContents.executeJavaScript(`
      JSON.stringify(Object.fromEntries(
        Object.keys(localStorage)
          .filter(k => k.startsWith('viper') || k.startsWith('Viper'))
          .map(k => [k, localStorage.getItem(k)])
      ))
    `);
    security.encryptVault(data);
    // Clear sensitive localStorage so it's not readable at rest
    await mainWindow.webContents.executeJavaScript(`
      Object.keys(localStorage)
        .filter(k => k.startsWith('viper') || k.startsWith('Viper'))
        .forEach(k => localStorage.removeItem(k))
    `);
    security.lock();
  } catch (e) {
    console.error('Vault save error:', e.message);
  }
  isQuitting = true;
  mainWindow.destroy();
}

// Helper: set cases folder hidden/visible (Windows: attrib +H / -H)
function _setCasesHidden(hidden) {
  try {
    if (process.platform === 'win32' && fs.existsSync(casesDir)) {
      const flag = hidden ? '+H' : '-H';
      spawn('attrib', [flag, casesDir]);
    }
  } catch (e) { console.error('attrib error:', e.message); }
}

app.whenReady().then(async () => {
  try {
    // Register viper-media:// protocol handler — serves local files for
    // Datapilot media streaming (videos, audio) without exposing paths.
    protocol.handle('viper-media', async (request) => {
      try {
        const reqUrl = new URL(request.url);
        // viper-media://m/<token>
        const token = reqUrl.pathname.replace(/^\/+/, '').replace(/\/.*$/, '');
        const entry = datapilotMediaTokens.get(token);
        if (!entry) return new Response('Not Found', { status: 404 });
        if (entry.expiresAt < Date.now()) {
          datapilotMediaTokens.delete(token);
          return new Response('Expired', { status: 410 });
        }
        if (!fs.existsSync(entry.absPath)) {
          return new Response('Missing', { status: 404 });
        }
        // Delegate streaming (incl. byte-range requests for video scrubbing)
        // to net.fetch on a file:// URL — this is the magic that lets
        // <video> seek without loading the entire file into memory.
        return net.fetch('file:///' + entry.absPath.replace(/\\/g, '/'));
      } catch (err) {
        console.error('viper-media protocol error:', err);
        return new Response('Error: ' + err.message, { status: 500 });
      }
    });

    // Initialize security manager (uses userData for config + vault)
    const secDir = app.getPath('userData');
    if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });
    security = new SecurityManager(secDir);
    console.log('Security:', security.isEnabled() ? 'ENABLED (locked)' : 'disabled');

    // Initialize audit logger (writes to userData/audit.log)
    // - When SecurityManager is later unlocked, entries are encrypted under
    //   the same master key.  Until then, entries are written in plaintext
    //   (unavoidable: we can't encrypt before the user provides the key).
    // - The chain is hash-linked, so even plaintext entries are tamper-evident.
    try {
      audit = new AuditLogger(secDir, {
        security,
        appVersion: app.getVersion()
      });
      // Restore Windows Event Log forwarding preference (off by default)
      try {
        const prefPath = path.join(secDir, 'audit-prefs.json');
        if (fs.existsSync(prefPath)) {
          const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
          if (prefs.eventLogEnabled) audit.setEventLogForwarding(true);
        }
      } catch (_) { /* ignore */ }

      audit.write(AUDIT_EVENTS.APP_LAUNCH, {
        platform: process.platform,
        electron: process.versions.electron,
        node: process.versions.node,
        portable: !!isPortable,
        security_enabled: security.isEnabled(),
      });
    } catch (e) {
      console.error('AuditLogger init failed:', e.message);
      audit = null;
    }

    // Wire security into aperture data for case file encryption
    if (typeof apertureData !== 'undefined') {
      apertureData.setSecurityManager(security);
    }

    // Keep cases folder hidden on disk when security is enabled
    if (security.isEnabled()) _setCasesHidden(true);

    await startServer();
    createWindow();

    // Media player permissions (audio/video/DRM for streaming services)
    const allowedPerms = ['media', 'mediaKeySystem', 'fullscreen'];
    const setupPermissions = (ses) => {
      ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowedPerms.includes(perm)));
      ses.setPermissionCheckHandler((_wc, perm) => allowedPerms.includes(perm));
    };
    setupPermissions(session.defaultSession);
    setupPermissions(session.fromPartition('persist:media'));

    // Create persistent BrowserView for media player (survives page navigations)
    mediaBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: true,
        preload: path.join(__dirname, 'preload-media.js'),
      },
    });
    // Don't add to window yet — will be attached on first media-set-visible(true)
    mediaBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    mediaBrowserView.setAutoResize({ width: false, height: false });
    mediaBrowserView.webContents.loadURL('http://localhost:8000/media-player.html');

    // Prevent media BrowserView from stealing focus when it loads
    mediaBrowserView.webContents.on('did-finish-load', () => {
      if (!mediaViewVisible) mainWindow.webContents.focus();
    });

    // Re-position media BrowserView on window resize
    mainWindow.on('resize', () => {
      if (mediaViewVisible && lastMediaBounds) {
        mediaBrowserView.setBounds(lastMediaBounds);
      }
    });

    // Create persistent BrowserView for Flock Safety LPR (survives page navigations)
    flockBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:flock', // separate session to persist login cookies
      },
    });
    // Don't add to window yet — will be attached on first flock-set-visible(true)
    flockBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    flockBrowserView.setAutoResize({ width: false, height: false });
    // Don't load URL here — Electron suspends network I/O for zero-size views.
    // URL will be loaded on first flock-set-visible(true) call.

    // Prevent Flock BrowserView from stealing focus + auto-fill credentials on login page
    flockBrowserView.webContents.on('did-finish-load', () => {
      if (!flockViewVisible) mainWindow.webContents.focus();
      // Inject dark theme override CSS to blend with VIPER
      flockBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});

      // Auto-fill credentials on Auth0 login page
      const url = flockBrowserView.webContents.getURL();
      if (url.includes('auth0.com') || url.includes('/login') || url.includes('/authorize')) {
        // Request stored credentials from renderer
        mainWindow.webContents.executeJavaScript(
          `JSON.stringify({ email: localStorage.getItem('flockEmail') || '', password: localStorage.getItem('flockPassword') || '' })`
        ).then(json => {
          const creds = JSON.parse(json);
          if (creds.email || creds.password) {
            flockBrowserView.webContents.executeJavaScript(`
              (function() {
                function fill() {
                  const emailInput = document.querySelector('input[name="email"], input[name="username"], input[type="email"]');
                  const passInput = document.querySelector('input[name="password"], input[type="password"]');
                  function setVal(el, val) {
                    if (!el || !val) return;
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  setVal(emailInput, ${JSON.stringify(creds.email)});
                  setVal(passInput, ${JSON.stringify(creds.password)});
                }
                // Auth0 may render fields after page load
                setTimeout(fill, 500);
                setTimeout(fill, 1500);
              })();
            `).catch(() => {});
          }
        }).catch(() => {});
      }
    });

    // Re-position Flock BrowserView on window resize
    mainWindow.on('resize', () => {
      if (flockViewVisible && lastFlockBounds) {
        flockBrowserView.setBounds(lastFlockBounds);
      }
      if (tloViewVisible && lastTloBounds) {
        tloBrowserView.setBounds(lastTloBounds);
      }
      if (accurintViewVisible && lastAccurintBounds) {
        accurintBrowserView.setBounds(lastAccurintBounds);
      }
      if (vigilantViewVisible && lastVigilantBounds) {
        vigilantBrowserView.setBounds(lastVigilantBounds);
      }
      if (icacDataSystemViewVisible && lastIcacDataSystemBounds) icacDataSystemBrowserView.setBounds(lastIcacDataSystemBounds);
      if (icacCopsViewVisible && lastIcacCopsBounds) icacCopsBrowserView.setBounds(lastIcacCopsBounds);
      if (gridcopViewVisible && lastGridcopBounds) gridcopBrowserView.setBounds(lastGridcopBounds);
    });

    // Create persistent BrowserView for TLO (TransUnion) — people search / skip tracing
    tloBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:tlo', // separate session to persist login cookies
      },
    });
    // Don't add to window yet — will be attached on first tlo-set-visible(true)
    tloBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    tloBrowserView.setAutoResize({ width: false, height: false });
    // Don't load URL here — Electron suspends network I/O for zero-size views.
    // URL will be loaded on first tlo-set-visible(true) call.

    // Prevent TLO BrowserView from stealing focus + auto-fill credentials on login page
    tloBrowserView.webContents.on('did-finish-load', () => {
      if (!tloViewVisible) mainWindow.webContents.focus();
      tloBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});

      // Auto-fill credentials on TLO login page
      const url = tloBrowserView.webContents.getURL();
      if (url.includes('tlo.com') && (url.includes('login') || url.includes('Login') || url === 'https://tloxp.tlo.com/' || url.includes('Account'))) {
        mainWindow.webContents.executeJavaScript(
          `JSON.stringify({ username: localStorage.getItem('tloUsername') || '', password: localStorage.getItem('tloPassword') || '' })`
        ).then(json => {
          const creds = JSON.parse(json);
          if (creds.username || creds.password) {
            tloBrowserView.webContents.executeJavaScript(`
              (function() {
                function fill() {
                  const userInput = document.querySelector('input[name="Username"], input[name="username"], input[name="email"], input[type="email"], input[id*="user"], input[id*="User"]');
                  const passInput = document.querySelector('input[name="Password"], input[name="password"], input[type="password"]');
                  function setVal(el, val) {
                    if (!el || !val) return;
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  setVal(userInput, ${JSON.stringify(creds.username)});
                  setVal(passInput, ${JSON.stringify(creds.password)});
                }
                setTimeout(fill, 500);
                setTimeout(fill, 1500);
              })();
            `).catch(() => {});
          }
        }).catch(() => {});
      }
    });

    // Create persistent BrowserView for LexisNexis Accurint — people/asset search
    accurintBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:accurint',
      },
    });
    // Don't add to window yet — will be attached on first accurint-set-visible(true)
    accurintBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    accurintBrowserView.setAutoResize({ width: false, height: false });

    accurintBrowserView.webContents.on('did-finish-load', () => {
      if (!accurintViewVisible) mainWindow.webContents.focus();
      accurintBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});

      const url = accurintBrowserView.webContents.getURL();
      if (url.includes('accurint.com') && (url.includes('login') || url.includes('Login') || url.includes('bps/main'))) {
        mainWindow.webContents.executeJavaScript(
          `JSON.stringify({ username: localStorage.getItem('accurintUsername') || '', password: localStorage.getItem('accurintPassword') || '' })`
        ).then(json => {
          const creds = JSON.parse(json);
          if (creds.username || creds.password) {
            accurintBrowserView.webContents.executeJavaScript(`
              (function() {
                function fill() {
                  const userInput = document.querySelector('input[name="UserID"], input[name="userid"], input[name="username"], input[id*="user" i], input[id*="User" i], input[type="text"]');
                  const passInput = document.querySelector('input[name="Password"], input[name="password"], input[type="password"]');
                  function setVal(el, val) {
                    if (!el || !val) return;
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  setVal(userInput, ${JSON.stringify(creds.username)});
                  setVal(passInput, ${JSON.stringify(creds.password)});
                }
                setTimeout(fill, 500);
                setTimeout(fill, 1500);
              })();
            `).catch(() => {});
          }
        }).catch(() => {});
      }
    });

    // Create persistent BrowserView for Vigilant Solutions / Motorola VehicleManager LPR
    vigilantBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:vigilant',
      },
    });
    // Don't add to window yet — will be attached on first vigilant-set-visible(true)
    vigilantBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    vigilantBrowserView.setAutoResize({ width: false, height: false });

    vigilantBrowserView.webContents.on('did-finish-load', () => {
      if (!vigilantViewVisible) mainWindow.webContents.focus();
      vigilantBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});

      const url = vigilantBrowserView.webContents.getURL();
      // VehicleManager login page — autofill credentials
      if (url.includes('motorolasolutions.com') && (url.includes('Login') || url.includes('login') || url.includes('VM8_Auth'))) {
        mainWindow.webContents.executeJavaScript(
          `JSON.stringify({ username: localStorage.getItem('vigilantUsername') || '', password: localStorage.getItem('vigilantPassword') || '' })`
        ).then(json => {
          const creds = JSON.parse(json);
          if (creds.username || creds.password) {
            vigilantBrowserView.webContents.executeJavaScript(`
              (function() {
                function fill() {
                  const userInput = document.querySelector('input[name*="ser" i], input[id*="ser" i], input[name="UserName"], input[id*="UserName" i], input[name="username"], input[type="text"]');
                  const passInput = document.querySelector('input[name*="assword" i], input[id*="assword" i], input[type="password"]');
                  function setVal(el, val) {
                    if (!el || !val) return;
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  setVal(userInput, ${JSON.stringify(creds.username)});
                  setVal(passInput, ${JSON.stringify(creds.password)});
                }
                setTimeout(fill, 500);
                setTimeout(fill, 1500);
              })();
            `).catch(() => {});
          }
        }).catch(() => {});
      }
    });

    // Create persistent BrowserView for ICAC Data System
    icacDataSystemBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:icacDataSystem',
      },
    });
    icacDataSystemBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    icacDataSystemBrowserView.setAutoResize({ width: false, height: false });
    icacDataSystemBrowserView.webContents.on('did-finish-load', () => {
      if (!icacDataSystemViewVisible) mainWindow.webContents.focus();
      icacDataSystemBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});
    });
    icacDataSystemBrowserView.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain) console.error('[ICAC-DS] did-fail-load', code, desc, url);
    });
    icacDataSystemBrowserView.webContents.on('render-process-gone', (_e, details) => {
      console.error('[ICAC-DS] render-process-gone', details);
    });

    // Create persistent BrowserView for ICACCOPS
    icacCopsBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:icacCops',
      },
    });
    icacCopsBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    icacCopsBrowserView.setAutoResize({ width: false, height: false });
    icacCopsBrowserView.webContents.on('did-finish-load', () => {
      if (!icacCopsViewVisible) mainWindow.webContents.focus();
      icacCopsBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});

      // Auto-fill credentials on ICACCOPS login page
      const url = icacCopsBrowserView.webContents.getURL();
      const looksLikeLogin = /login|signin|sign-in|authenticate|account/i.test(url) || url.endsWith('/') || url.includes('icaccops');
      if (!looksLikeLogin) return;
      mainWindow.webContents.executeJavaScript(
        `JSON.stringify({ username: localStorage.getItem('icacCopsUsername') || '', password: localStorage.getItem('icacCopsPassword') || '' })`
      ).then(json => {
        const creds = JSON.parse(json);
        if (!creds.username && !creds.password) return;
        icacCopsBrowserView.webContents.executeJavaScript(`
          (function() {
            function setVal(el, val) {
              if (!el || !val) return;
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            function pickUser() {
              return document.querySelector('input[name="username"]')
                  || document.querySelector('input#username')
                  || document.querySelector('input[name="user"]')
                  || document.querySelector('input[name="email"]')
                  || document.querySelector('input[type="email"]')
                  || document.querySelector('input[autocomplete="username"]')
                  || (function() {
                       const all = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
                       return all.find(i => /user|email|login/i.test((i.name||'') + ' ' + (i.id||'') + ' ' + (i.placeholder||''))) || all[0] || null;
                     })();
            }
            function pickPass() {
              return document.querySelector('input[type="password"]')
                  || document.querySelector('input[name="password"]')
                  || document.querySelector('input#password');
            }
            function fill() {
              setVal(pickUser(), ${JSON.stringify(creds.username)});
              setVal(pickPass(), ${JSON.stringify(creds.password)});
            }
            setTimeout(fill, 400);
            setTimeout(fill, 1200);
            setTimeout(fill, 2500);
          })();
        `).catch(() => {});
      }).catch(() => {});
    });
    icacCopsBrowserView.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain) console.error('[ICACCOPS] did-fail-load', code, desc, url);
    });
    icacCopsBrowserView.webContents.on('render-process-gone', (_e, details) => {
      console.error('[ICACCOPS] render-process-gone', details);
    });

    // Create persistent BrowserView for Gridcop
    gridcopBrowserView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:gridcop',
      },
    });
    gridcopBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    gridcopBrowserView.setAutoResize({ width: false, height: false });
    gridcopBrowserView.webContents.on('did-finish-load', () => {
      if (!gridcopViewVisible) mainWindow.webContents.focus();
      gridcopBrowserView.webContents.insertCSS(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `).catch(() => {});
    });
    gridcopBrowserView.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain) console.error('[GRIDCOP] did-fail-load', code, desc, url);
    });
    gridcopBrowserView.webContents.on('render-process-gone', (_e, details) => {
      console.error('[GRIDCOP] render-process-gone', details);
    });

    // ── Resource-Hub download interceptor ────────────────────────────
    // Intercept file downloads that originate INSIDE a Resource Hub
    // BrowserView (Flock, ICACCOPS, ICAC Data System, etc.) and route
    // them to the renderer so the user can drop the file straight into
    // a case's Evidence module without bouncing through ~/Downloads.
    //
    // Flow: will-download → pause → save to temp → forward {tempPath,
    // filename, size, mime, sourceUrl, resource} to renderer over
    // `rh-download-ready`.  Renderer presents a routing modal and
    // posts back to `rh-download-route` with the chosen destination.
    const RESOURCE_PARTITIONS = [
      { partition: 'persist:flock',          label: 'Flock Safety',     defaultTag: 'Flock-Reports'    },
      { partition: 'persist:tlo',            label: 'TLO',              defaultTag: 'TLO-Reports'      },
      { partition: 'persist:accurint',       label: 'Accurint',         defaultTag: 'Accurint-Reports' },
      { partition: 'persist:vigilant',       label: 'Vigilant LPR',     defaultTag: 'Vigilant-Reports' },
      { partition: 'persist:icacDataSystem', label: 'ICAC Data System', defaultTag: 'CyberTip-Reports' },
      { partition: 'persist:icacCops',       label: 'ICACCOPS',         defaultTag: 'ICACCOPS-Reports' },
      { partition: 'persist:gridcop',        label: 'Gridcop',          defaultTag: 'Gridcop-Reports'  },
    ];

    const _sanitizeDlName = (n) => String(n || 'download').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 180) || 'download';

    function _attachResourceDownloadInterceptor(meta) {
      try {
        const ses = session.fromPartition(meta.partition);
        ses.on('will-download', (event, item, _wc) => {
          try {
            const originalName = _sanitizeDlName(item.getFilename());
            const tempName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalName}`;
            const tempPath = path.join(rhDownloadTmpDir, tempName);
            // Don't prompt the user with a Save dialog — route to temp first.
            item.setSavePath(tempPath);

            const startedAt = Date.now();
            const sourceUrl = item.getURL();
            const mime      = item.getMimeType();
            const totalBytes= item.getTotalBytes();

            item.on('done', (_evt, state) => {
              if (state !== 'completed') {
                // Failed or cancelled — clean up partial file if any
                try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('rh-download-ready', {
                    success: false, state, resource: meta.label, fileName: originalName,
                  });
                }
                return;
              }
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('rh-download-ready', {
                  success: true,
                  tempPath,
                  fileName: originalName,
                  size: totalBytes || (fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0),
                  mime,
                  sourceUrl,
                  resource: meta.label,
                  defaultTag: meta.defaultTag,
                  durationMs: Date.now() - startedAt,
                });
              }
            });
          } catch (err) {
            console.error(`[ResourceHub-DL ${meta.label}] will-download handler error:`, err);
          }
        });
        console.log(`[ResourceHub-DL] interceptor attached: ${meta.label} (${meta.partition})`);
      } catch (err) {
        console.error(`[ResourceHub-DL] failed to attach for ${meta.label}:`, err);
      }
    }
    RESOURCE_PARTITIONS.forEach(_attachResourceDownloadInterceptor);

    // On page navigation, detach resource-hub BrowserViews so they can't steal clicks
    // on the next page. Media player is handled by its own show/hide via reportBounds().
    mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace) => {
      if (isInPlace) return; // ignore hash/pushState navigations
      const pageViews = [flockBrowserView, tloBrowserView, accurintBrowserView, vigilantBrowserView, icacDataSystemBrowserView, icacCopsBrowserView, gridcopBrowserView];
      for (const bv of pageViews) {
        if (!bv) continue;
        try { mainWindow.removeBrowserView(bv); } catch (_) {}
        bv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
      flockViewVisible = false;
      tloViewVisible = false;
      accurintViewVisible = false;
      vigilantViewVisible = false;
      icacDataSystemViewVisible = false;
      icacCopsViewVisible = false;
      gridcopViewVisible = false;
    });

    // When the renderer page finishes loading, ask it to report media bounds
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('request-media-bounds');
    });

    // Boss key: Ctrl+Alt+M toggles media player
    globalShortcut.register('CommandOrControl+Alt+M', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-media-player');
      }
    });
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (server) {
    server.close();
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // Final audit entry — uptime + reason. Synchronous append, so it lands
  // before the process exits.
  try {
    if (audit) {
      audit.write(AUDIT_EVENTS.APP_EXIT, {
        uptime_sec: Math.round(process.uptime())
      });
    }
  } catch (_) { /* ignore — never block quit on logging */ }

  if (server) {
    server.close();
  }
  if (apertureProcess) {
    apertureProcess.kill();
  }
});

// --- Storage paths for Settings page ---
ipcMain.handle('get-storage-paths', async () => {
  return {
    appDir: __dirname,
    casesDir: casesDir,
    userData: app.getPath('userData'),
    isPortable: isPortable
  };
});

// --- Create case folder on disk ---
ipcMain.handle('create-case-folder', async (_e, caseNumber) => {
  if (!caseNumber || typeof caseNumber !== 'string') return { success: false, error: 'Invalid case number' };
  const caseDir = path.join(casesDir, caseNumber);
  try {
    fs.mkdirSync(caseDir, { recursive: true });
    return { success: true, path: caseDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Check if case folder exists on disk ---
ipcMain.handle('case-folder-exists', async (_e, caseNumber) => {
  if (!caseNumber || typeof caseNumber !== 'string') return false;
  return fs.existsSync(path.join(casesDir, caseNumber));
});

// --- Save text file into case subfolder ---
ipcMain.handle('save-case-text-file', async (_e, { caseNumber, subfolder, fileName, content }) => {
  if (!caseNumber || !fileName) return { success: false, error: 'Missing params' };
  try {
    const dir = subfolder
      ? path.join(casesDir, caseNumber, subfolder)
      : path.join(casesDir, caseNumber);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    // Encrypt if security is enabled
    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(Buffer.from(content, 'utf8')));
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Delete case folder (entire case directory on disk) ---
ipcMain.handle('delete-case-folder', async (_e, caseNumber) => {
  if (!caseNumber || typeof caseNumber !== 'string') return { success: false, error: 'Invalid case number' };
  const caseDir = path.join(casesDir, caseNumber);
  if (!fs.existsSync(caseDir)) return { success: true };
  try {
    fs.rmSync(caseDir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Delete only evidence files for a case ---
ipcMain.handle('delete-case-evidence', async (_e, caseNumber) => {
  if (!caseNumber || typeof caseNumber !== 'string') return { success: false, error: 'Invalid case number' };
  const evidenceDir = path.join(casesDir, caseNumber, 'Evidence');
  if (!fs.existsSync(evidenceDir)) return { success: true, message: 'No evidence folder found' };
  try {
    fs.rmSync(evidenceDir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Per-case auto-snapshot to disk (data-loss recovery, v2.8.4+) ────
// Writes cases/{caseNumber}/.case-snapshot.json on every module change.
// The renderer-side case-snapshot.js builds the JSON in the same shape
// as a .vcase export and calls these handlers debounced ~800ms after
// any tracked localStorage write. Encryption follows the same Field
// Security pattern as warrants/evidence — encrypted iff security is on.
const SNAPSHOT_FILENAME = '.case-snapshot.json';

function _safeCaseNumber(s) {
  // Disallow path traversal — case numbers are user-typed strings
  if (!s || typeof s !== 'string') return null;
  if (s.indexOf('..') !== -1 || s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return null;
  return s;
}

ipcMain.handle('save-case-snapshot', async (_e, payload) => {
  try {
    const data = payload && payload.data;
    const caseNumber = _safeCaseNumber(payload && payload.caseNumber);
    if (!caseNumber || typeof data !== 'string') {
      return { success: false, error: 'Invalid params' };
    }
    const caseDir = path.join(casesDir, caseNumber);
    fs.mkdirSync(caseDir, { recursive: true });
    const filePath = path.join(caseDir, SNAPSHOT_FILENAME);

    const buf = Buffer.from(data, 'utf8');
    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(buf));
    } else {
      fs.writeFileSync(filePath, buf);
    }
    return { success: true, path: filePath, size: buf.length };
  } catch (err) {
    console.error('save-case-snapshot failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-case-snapshot', async (_e, caseNumber) => {
  try {
    const safe = _safeCaseNumber(caseNumber);
    if (!safe) return null;
    const filePath = path.join(casesDir, safe, SNAPSHOT_FILENAME);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath);
    let buf = raw;
    if (security && security.isUnlocked() && security.isEncryptedBuffer && security.isEncryptedBuffer(raw)) {
      buf = security.decryptBuffer(raw);
    }
    return buf.toString('utf8');
  } catch (err) {
    console.error('load-case-snapshot failed:', err);
    return null;
  }
});

ipcMain.handle('list-case-snapshots', async () => {
  try {
    if (!fs.existsSync(casesDir)) return [];
    const entries = fs.readdirSync(casesDir, { withFileTypes: true });
    const result = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const snapPath = path.join(casesDir, ent.name, SNAPSHOT_FILENAME);
      if (!fs.existsSync(snapPath)) continue;
      try {
        const stat = fs.statSync(snapPath);
        result.push({
          caseNumber: ent.name,
          mtime: stat.mtimeMs,
          size: stat.size
        });
      } catch (e) { /* skip unreadable */ }
    }
    result.sort((a, b) => b.mtime - a.mtime); // newest first
    return result;
  } catch (err) {
    console.error('list-case-snapshots failed:', err);
    return [];
  }
});

ipcMain.handle('delete-case-snapshot', async (_e, caseNumber) => {
  try {
    const safe = _safeCaseNumber(caseNumber);
    if (!safe) return { success: false, error: 'Invalid case number' };
    const filePath = path.join(casesDir, safe, SNAPSHOT_FILENAME);
    if (!fs.existsSync(filePath)) return { success: true, alreadyGone: true };
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Open external URL in system browser ---
ipcMain.handle('open-external-url', async (_e, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// --- App version (reads from package.json via Electron) ---
ipcMain.handle('get-app-version', () => app.getVersion());

// ── Auto-Update (electron-updater) ─────────────────────────────────
// Uses GitHub Releases. NSIS installer.nsh backup/restore logic ensures
// userdata/ and cases/ are NEVER overwritten during an update.
function sendUpdateStatus(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

if (autoUpdater) {
  autoUpdater.autoDownload = false;          // user must click "Download"
  autoUpdater.autoInstallOnAppQuit = false;  // user must click "Install & Restart"
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    try { audit && audit.write(AUDIT_EVENTS.UPDATE_CHECKED, { current_version: app.getVersion() }); } catch (_) {}
    sendUpdateStatus('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('update-status', {
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus('update-status', {
      status: 'up-to-date',
      version: info.version
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Store the actual downloaded file path for the install handler
    autoUpdater._downloadedInstallerPath = info.downloadedFile || null;
    console.log('Update downloaded. File path:', info.downloadedFile);
    try {
      audit && audit.write(AUDIT_EVENTS.UPDATE_DOWNLOADED, {
        from_version: app.getVersion(),
        to_version: info.version,
        file: info.downloadedFile ? path.basename(info.downloadedFile) : null,
      });
    } catch (_) {}
    sendUpdateStatus('update-status', {
      status: 'downloaded',
      version: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    sendUpdateStatus('update-status', {
      status: 'error',
      message: err.message || 'Update check failed.'
    });
  });
}

// Renderer requests: check → download → install+restart
ipcMain.handle('update-check', async () => {
  if (!autoUpdater) return { success: false, error: 'Auto-updater not available in dev mode.' };
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-download', async () => {
  if (!autoUpdater) return { success: false, error: 'Auto-updater not available.' };
  try {
    const path = require('path');
    const fs = require('fs');
    // Clear stale cached installer before downloading to prevent
    // electron-updater from running an old cached installer.exe
    const cachePath = path.join(app.getPath('userData'), '..', '..', 'Local', 'viper-electron-updater');
    try {
      const files = fs.readdirSync(cachePath);
      files.filter(f => f.endsWith('.exe')).forEach(f => {
        try { fs.unlinkSync(path.join(cachePath, f)); } catch (_) {}
      });
    } catch (_) { /* cache dir may not exist yet */ }
    await autoUpdater.downloadUpdate();
    // Log what's in the cache after download
    try {
      const files = fs.readdirSync(cachePath);
      console.log('Updater cache after download:', files);
    } catch (_) {}
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-install', async () => {
  if (!autoUpdater) return { success: false, error: 'Auto-updater not available.' };
  const path = require('path');
  const fs = require('fs');

  // ── 1. Locate the downloaded installer ─────────────────────────────
  // Primary: the path captured from the update-downloaded event.
  // Fallback: scan electron-updater's known cache locations, INCLUDING
  // the `pending/` subdirectory where it actually stores downloads.
  let installerPath = autoUpdater._downloadedInstallerPath || null;
  console.log('update-install: _downloadedInstallerPath =', installerPath);

  if (!installerPath || !fs.existsSync(installerPath)) {
    const cacheDirs = [];
    if (process.env.LOCALAPPDATA) {
      cacheDirs.push(path.join(process.env.LOCALAPPDATA, 'viper-electron-updater', 'pending'));
      cacheDirs.push(path.join(process.env.LOCALAPPDATA, 'viper-electron-updater'));
    }
    try { cacheDirs.push(path.join(app.getPath('userData'), '..', '..', 'Local', 'viper-electron-updater', 'pending')); } catch (_) {}
    try { cacheDirs.push(path.join(app.getPath('userData'), '..', '..', 'Local', 'viper-electron-updater')); } catch (_) {}
    try { cacheDirs.push(path.join(app.getPath('temp'), 'viper-electron-updater', 'pending')); } catch (_) {}
    try { cacheDirs.push(path.join(app.getPath('temp'), 'viper-electron-updater')); } catch (_) {}

    for (const dir of cacheDirs) {
      try {
        const files = fs.readdirSync(dir);
        console.log('update-install: scanning', dir, '→', files);
        const exe = files.find(f => /\.exe$/i.test(f) && /v\.?i\.?p\.?e\.?r/i.test(f));
        if (exe) {
          installerPath = path.join(dir, exe);
          break;
        }
      } catch (_) {}
    }
  }

  if (!installerPath || !fs.existsSync(installerPath)) {
    console.error('update-install: installer file not found in any known cache location');
    sendUpdateStatus('update-status', {
      status: 'error',
      message: 'Update installer was not found on disk. Try clicking Download Update again, or download the installer manually from project-viper.com.'
    });
    return { success: false, error: 'installer-not-found' };
  }

  console.log('update-install: launching', installerPath);

  // ── 2. Write a self-deleting launcher batch file ───────────────────
  // Why a batch file (not direct spawn):
  //  - Runs OUTSIDE this Electron process tree, so it survives app.quit().
  //    A direct child spawn (even with detached:true + unref()) can be
  //    killed by Windows' job object when the parent dies.
  //  - Lets us add a timeout so the installer launches AFTER VIPER has
  //    fully exited and released its file locks.
  //  - Lets the installer pop its own UAC dialog naturally (NSIS handles
  //    elevation itself when targeting Program Files). No PowerShell
  //    -Verb RunAs gymnastics, no /D= quoting issues.
  //  - We deliberately DO NOT pass /S (silent) or /D= (install dir):
  //      * oneClick:false NSIS shows an assisted wizard either way; let
  //        the user click Next so they can SEE the install succeed.
  //      * NSIS reads the previous install path from its registry key
  //        and upgrades in-place — far more reliable than passing /D=
  //        with a space-containing path through cmd/PowerShell quoting.
  //
  // installer.nsh's customInit/customInstall handle the data-preservation
  // backup/restore regardless.
  const batPath = path.join(app.getPath('temp'), `viper_update_${Date.now()}.bat`);
  const batLines = [
    '@echo off',
    'rem VIPER auto-update launcher (auto-generated, self-deleting)',
    'rem Wait for VIPER to fully exit and release file locks',
    'timeout /t 4 /nobreak >nul 2>&1',
    `start "" "${installerPath}"`,
    'rem Self-delete after launch',
    '(goto) 2>nul & del "%~f0"'
  ];
  const batContent = batLines.join('\r\n') + '\r\n';

  try {
    fs.writeFileSync(batPath, batContent, 'utf-8');
  } catch (err) {
    console.error('update-install: failed to write launcher batch:', err);
    sendUpdateStatus('update-status', {
      status: 'error',
      message: 'Failed to prepare installer launcher: ' + err.message
    });
    return { success: false, error: err.message };
  }

  // ── 3. Spawn the batch via `cmd /c start` to fully detach ──────────
  // `start ""` opens the batch in a NEW window/session, escaping the
  // Electron process tree's job object so the launcher survives
  // app.quit().  windowsHide keeps the launcher invisible until the
  // installer's own UI appears.
  try {
    const { spawn } = require('child_process');
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/min', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    console.log('update-install: launcher batch dispatched:', batPath);
    try {
      audit && audit.write(AUDIT_EVENTS.UPDATE_APPLIED, {
        from_version: app.getVersion(),
        installer: path.basename(installerPath),
      });
    } catch (_) {}
  } catch (err) {
    console.error('update-install: failed to spawn launcher:', err);
    sendUpdateStatus('update-status', {
      status: 'error',
      message: 'Failed to launch installer: ' + err.message
    });
    return { success: false, error: err.message };
  }

  // ── 4. Quit so the new installer can replace the running exe ───────
  // Brief delay lets the cmd.exe spawn fully detach before we exit.
  await new Promise(resolve => setTimeout(resolve, 1500));
  app.quit();
  return { success: true };
});

// --- Backup & Restore ---
ipcMain.handle('select-backup-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup Destination',
    properties: ['openDirectory']
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('create-backup', async (event, { backupPath, data }) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(backupPath, `VIPER_Backup_${timestamp}.json`);
  // Encrypt backup if security is active
  if (security && security.isEnabled() && security.isUnlocked()) {
    fs.writeFileSync(filePath, security.encryptBuffer(Buffer.from(data, 'utf-8')));
  } else {
    fs.writeFileSync(filePath, data, 'utf-8');
  }
  return filePath;
});

// Legacy JSON-only restore (kept for backward compat with old .json backups)
ipcMain.handle('restore-backup', async (event, { backupPath }) => {
  const raw = fs.readFileSync(backupPath);
  // Decrypt backup if it's encrypted
  if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
    return security.decryptBuffer(raw).toString('utf-8');
  }
  return raw.toString('utf-8');
});

// --- Full ZIP Backup (localStorage + case files) ---
ipcMain.handle('create-backup-zip', async (event, { backupPath, data }) => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  // 1. Add localStorage data as JSON
  const jsonBuf = Buffer.from(data, 'utf-8');
  zip.addFile('viper_data.json', jsonBuf);

  // 2. Add all case folders from casesDir
  const addDirRecursive = (dirPath, zipPrefix) => {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const zipPath = zipPrefix + '/' + entry.name;
      if (entry.isDirectory()) {
        addDirRecursive(fullPath, zipPath);
      } else if (entry.isFile()) {
        zip.addLocalFile(fullPath, zipPrefix);
      }
    }
  };

  if (fs.existsSync(casesDir)) {
    const caseFolders = fs.readdirSync(casesDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const folder of caseFolders) {
      addDirRecursive(path.join(casesDir, folder.name), 'cases/' + folder.name);
    }
  }

  // 3. Write ZIP file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(backupPath, `VIPER_Backup_${timestamp}.vbak`);

  // Encrypt if security is active
  if (security && security.isEnabled() && security.isUnlocked()) {
    const zipBuf = zip.toBuffer();
    fs.writeFileSync(filePath, security.encryptBuffer(zipBuf));
  } else {
    zip.writeZip(filePath);
  }

  return filePath;
});

ipcMain.handle('restore-backup-zip', async (event, { backupPath }) => {
  const AdmZip = require('adm-zip');
  let raw = fs.readFileSync(backupPath);

  // Decrypt if encrypted
  if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
    raw = security.decryptBuffer(raw);
  }

  const zip = new AdmZip(raw);
  const entries = zip.getEntries();

  // 1. Extract localStorage JSON
  const jsonEntry = entries.find(e => e.entryName === 'viper_data.json');
  if (!jsonEntry) throw new Error('Invalid backup: missing viper_data.json');
  const jsonData = jsonEntry.getData().toString('utf-8');

  // 2. Extract case files to casesDir
  let filesRestored = 0;
  for (const entry of entries) {
    if (entry.entryName.startsWith('cases/') && !entry.isDirectory) {
      // cases/CASENUMBER/Evidence/file.jpg → casesDir/CASENUMBER/Evidence/file.jpg
      const relativePath = entry.entryName.slice('cases/'.length);
      const destPath = path.join(casesDir, relativePath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      filesRestored++;
    }
  }

  return { jsonData, filesRestored };
});

ipcMain.handle('select-backup-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup File to Restore',
    properties: ['openFile'],
    filters: [
      { name: 'VIPER Backup', extensions: ['vbak', 'json'] }
    ]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- Report Pop-out Window ---
ipcMain.handle('open-report-window', async (event, caseNumber) => {
  const reportWin = new BrowserWindow({
    width: 900,
    height: 700,
    title: `Report — Case ${caseNumber}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  reportWin.loadURL(`http://localhost:8000/report-popout.html?case=${encodeURIComponent(caseNumber)}`);
  return true;
});

// Report popout sync — relay through main window's localStorage
ipcMain.handle('report-get', async (event, caseNumber) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const js = `(() => { const r = JSON.parse(localStorage.getItem('viperCaseReports') || '{}'); return r[${JSON.stringify(caseNumber)}] || null; })()`;
  return await mainWindow.webContents.executeJavaScript(js);
});

ipcMain.handle('report-save', async (event, caseNumber, content, lastSaved) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const safePayload = JSON.stringify(JSON.stringify({ caseNumber, content, lastSaved }));
  const js = `(() => {
    const d = JSON.parse(${safePayload});
    const r = JSON.parse(localStorage.getItem('viperCaseReports') || '{}');
    r[d.caseNumber] = { content: d.content, lastSaved: d.lastSaved };
    localStorage.setItem('viperCaseReports', JSON.stringify(r));
    // Also update the live editor DOM and JS variables so auto-save doesn't overwrite
    const ed = document.getElementById('reportEditor');
    if (ed) ed.innerHTML = d.content;
    if (typeof caseReport !== 'undefined') caseReport = d.content;
    if (typeof reportLastSaved !== 'undefined') reportLastSaved = d.lastSaved;
    const ts = document.getElementById('reportLastSavedText');
    if (ts) ts.textContent = 'Last saved: ' + new Date(d.lastSaved).toLocaleString();
    return true;
  })()`;
  return await mainWindow.webContents.executeJavaScript(js);
});

// --- RMS PDF Import ---
ipcMain.handle('select-rms-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import RMS Reports',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Reports', extensions: ['pdf'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
});

ipcMain.handle('select-dmv-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import DMV Printout',
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('extract-pdf-text', async (event, filePath) => {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    // Check if text looks garbled (Type3 custom fonts) — test for common readable keywords
    const readable = /[A-Za-z]{3,}/.test(data.text) &&
      (/\b(?:Name|DOB|Dob|OLN|DLN?|SSN|Sex|Height|Weight|Address|License|Incident|Event|Offense|Suspect|Victim|Witness|Narrative|Report)\b/i.test(data.text));

    // Secondary check: some PDFs pass readability but have spaces stripped in body text
    // (form labels are fine, narrative text is garbled like "OnNovember30th,2025,...")
    let spacesStripped = false;
    if (readable) {
      const longLines = data.text.split('\n').filter(l => l.length > 60);
      if (longLines.length > 0) {
        // Any single very long line with almost no spaces is a strong signal
        const veryLongNoSpace = longLines.some(l => l.length > 100 &&
          (l.match(/ /g) || []).length / l.length < 0.01);
        // Or a moderate proportion of long lines lacking spaces
        const noSpaceLines = longLines.filter(l => {
          const spaceRatio = (l.match(/ /g) || []).length / l.length;
          return spaceRatio < 0.02; // less than 2% spaces in a long line
        });
        spacesStripped = veryLongNoSpace ||
          (longLines.length >= 3 && noSpaceLines.length > longLines.length * 0.2);
      }
    }

    if (readable && !spacesStripped) {
      return {
        text: data.text,
        numPages: data.numpages,
        info: data.info || {},
        fileName: path.basename(filePath)
      };
    }

    // Garbled text detected — fall back to MuPDF render + Tesseract OCR
    console.log('PDF text garbled (Type3 font), falling back to OCR...');
    const mupdf = await import('mupdf');

    // First try MuPDF's own text extraction (much faster than OCR)
    const doc = mupdf.Document.openDocument(dataBuffer, 'application/pdf');
    const numPages = doc.countPages();
    let mupdfText = '';
    for (let i = 0; i < numPages; i++) {
      const page = doc.loadPage(i);
      const stext = page.toStructuredText();
      mupdfText += stext.asText() + '\n';
    }

    // Check if MuPDF text is usable (has proper spacing)
    const mupdfLongLines = mupdfText.split('\n').filter(l => l.length > 60);
    const mupdfSpaceOk = mupdfLongLines.length === 0 || mupdfLongLines.filter(l => {
      const sr = (l.match(/ /g) || []).length / l.length;
      return sr >= 0.02;
    }).length > mupdfLongLines.length * 0.5;

    if (mupdfSpaceOk && /[A-Za-z]{3,}/.test(mupdfText)) {
      console.log('MuPDF text extraction succeeded');
      return {
        text: mupdfText,
        numPages,
        info: data.info || {},
        fileName: path.basename(filePath)
      };
    }

    // MuPDF text also bad — full OCR fallback
    console.log('MuPDF text also garbled, falling back to Tesseract OCR...');
    const Tesseract = (await import('tesseract.js')).default;

    for (let i = 0; i < numPages; i++) {
      const page = doc.loadPage(i);
      const matrix = mupdf.Matrix.scale(300 / 72, 300 / 72);
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const pngBuf = pixmap.asPNG();
      const result = await Tesseract.recognize(Buffer.from(pngBuf), 'eng');
      ocrText += result.data.text + '\n';
    }

    // Clean common OCR artifacts
    ocrText = ocrText
      .replace(/©/g, '0')           // © misread as 0
      .replace(/\(([A-Z])0\)/g, '($1O)')  // state code: (C0) → (CO)
      .replace(/['']/g, "'");        // smart quotes

    return {
      text: ocrText,
      numPages,
      info: data.info || {},
      fileName: path.basename(filePath),
      ocr: true
    };
  } catch (error) {
    console.error('PDF parse error:', error);
    throw error;
  }
});

// --- Case Export / Import ---
ipcMain.handle('save-case-export', async (event, { fileName, data }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Case Package',
    defaultPath: fileName,
    filters: [{ name: 'VIPER Case Package', extensions: ['vcase'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePath) return null;
  const buf = Buffer.from(data, 'utf-8');
  if (security && security.isEnabled() && security.isUnlocked()) {
    fs.writeFileSync(result.filePath, security.encryptBuffer(buf));
  } else {
    fs.writeFileSync(result.filePath, buf, 'utf-8');
  }
  return result.filePath;
});

// --- Export DA Package (ZIP with PDF + evidence files) ---
ipcMain.handle('save-da-export', async (event, { fileName, pdfBytes, caseNumber }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save DA Export Package',
    defaultPath: fileName,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePath) return null;

  // Walk a directory tree and collect files (decrypting if needed)
  const collectFiles = (baseDir) => {
    const files = [];
    if (fs.existsSync(baseDir)) {
      const walkDir = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walkDir(full, relPath);
          else {
            let buf = fs.readFileSync(full);
            if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
              buf = security.decryptBuffer(buf);
            }
            files.push({ name: relPath, data: buf });
          }
        }
      };
      walkDir(baseDir, '');
    }
    return files;
  };

  // Collect evidence and warrant files for this case
  const evidenceFiles = collectFiles(path.join(casesDir, caseNumber, 'Evidence'));
  const warrantFiles = collectFiles(path.join(casesDir, caseNumber, 'Warrants'));

  // Build ZIP using Node.js built-in zlib (no external lib needed)
  // Use archiver-like manual ZIP construction or write a simple one
  // For simplicity, use the 'archiver' package or manual approach
  // Since we don't want external deps, write files to a temp dir then use native zip
  // Actually, let's use a simple approach: save PDF + copy evidence to a temp folder, then zip

  const archiver = (() => {
    try { return require('archiver'); } catch { return null; }
  })();

  if (archiver) {
    // Use archiver if available
    const output = fs.createWriteStream(result.filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    return new Promise((resolve, reject) => {
      output.on('close', () => resolve(result.filePath));
      archive.on('error', err => reject(err));
      archive.pipe(output);
      archive.append(Buffer.from(pdfBytes), { name: `${caseNumber}_DA_Report.pdf` });
      for (const f of evidenceFiles) {
        archive.append(f.data, { name: `Evidence/${f.name}` });
      }
      for (const f of warrantFiles) {
        archive.append(f.data, { name: `Warrants/${f.name}` });
      }
      archive.finalize();
    });
  } else {
    // Fallback: save PDF directly and copy evidence alongside
    const dir = path.dirname(result.filePath);
    const base = path.basename(result.filePath, '.zip');
    const exportDir = path.join(dir, base);
    fs.mkdirSync(exportDir, { recursive: true });

    // Save PDF
    fs.writeFileSync(path.join(exportDir, `${caseNumber}_DA_Report.pdf`), Buffer.from(pdfBytes));

    // Copy evidence
    if (evidenceFiles.length > 0) {
      const evDir = path.join(exportDir, 'Evidence');
      for (const f of evidenceFiles) {
        const dest = path.join(evDir, f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.data);
      }
    }

    // Copy warrants
    if (warrantFiles.length > 0) {
      const wDir = path.join(exportDir, 'Warrants');
      for (const f of warrantFiles) {
        const dest = path.join(wDir, f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.data);
      }
    }
    return exportDir;
  }
});

ipcMain.handle('open-case-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Case Package',
    properties: ['openFile'],
    filters: [
      { name: 'VIPER Files', extensions: ['vcase', 'json', 'vbak'] },
      { name: 'VIPER Case Package', extensions: ['vcase'] },
      { name: 'VIPER Backup', extensions: ['json', 'vbak'] }
    ]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];

  // .vbak = ZIP backup — extract localStorage JSON, case files restored by main process
  if (filePath.endsWith('.vbak')) {
    const AdmZip = require('adm-zip');
    let raw = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
      raw = security.decryptBuffer(raw);
    }
    const zip = new AdmZip(raw);
    // Restore case files to casesDir
    let filesRestored = 0;
    for (const entry of zip.getEntries()) {
      if (entry.entryName.startsWith('cases/') && !entry.isDirectory) {
        const relativePath = entry.entryName.slice('cases/'.length);
        const destPath = path.join(casesDir, relativePath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(destPath, entry.getData());
        filesRestored++;
      }
    }
    console.log(`Restored ${filesRestored} case files from .vbak`);
    // Return the JSON data for localStorage restore
    const jsonEntry = zip.getEntries().find(e => e.entryName === 'viper_data.json');
    if (!jsonEntry) throw new Error('Invalid .vbak: missing viper_data.json');
    return jsonEntry.getData().toString('utf-8');
  }

  // .vcase or .json — read as text
  const raw = fs.readFileSync(filePath);
  if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
    return security.decryptBuffer(raw).toString('utf-8');
  }
  return raw.toString('utf-8');
});

// --- Offense Reference Export/Import ---
ipcMain.handle('save-offense-export', async (event, { fileName, data }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Offense Reference List',
    defaultPath: fileName,
    filters: [{ name: 'VIPER Offense List', extensions: ['voffenses'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, data, 'utf-8');
  return result.filePath;
});

ipcMain.handle('open-offense-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Offense Reference List',
    properties: ['openFile'],
    filters: [{ name: 'VIPER Offense List', extensions: ['voffenses'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return fs.readFileSync(result.filePaths[0], 'utf-8');
});

// --- ARIN WHOIS Lookup ---
ipcMain.handle('arin-lookup', async (_event, ipAddress) => {
  const https = require('https');
  
  function fetchJson(url, redirects = 3) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects > 0) {
          return fetchJson(res.headers.location, redirects - 1).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Failed to parse response')); }
        });
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }
  
  try {
    const json = await fetchJson(`https://whois.arin.net/rest/ip/${encodeURIComponent(ipAddress)}`);
    const net = json.net;
    if (net) {
      const orgRef = net.orgRef || net.customerRef;
      const blocks = net.netBlocks?.netBlock;
      let netRange = '';
      if (blocks) {
        const b = Array.isArray(blocks) ? blocks[0] : blocks;
        netRange = `${b.startAddress?.$} - ${b.endAddress?.$}`;
      }
      return { success: true, provider: orgRef?.['@name'] || net.name?.$ || 'Unknown', organization: orgRef?.['@name'] || 'Unknown', network: net.name?.$, netRange };
    } else {
      return { success: false, error: 'No network information found' };
    }
  } catch (e) {
    return { success: false, error: e.message || 'ARIN lookup failed' };
  }
});

// --- FMCSA Carrier Lookup (SAFER web scrape — no API key needed) ---
ipcMain.handle('fmcsa-lookup', async (_event, params) => {
  const https = require('https');
  const { parse: parseHTML } = require('node-html-parser');
  const { type, query } = params;
  if (!query) return { success: false, error: 'Search term is required.' };

  function fetchHtml(urlStr, redirects = 5) {
    return new Promise((resolve, reject) => {
      const req = https.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects > 0) {
          return fetchHtml(res.headers.location, redirects - 1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`FMCSA returned status ${res.statusCode}`));
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('FMCSA request timed out')); });
    });
  }

  try {
    const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=${encodeURIComponent(type)}&query_string=${encodeURIComponent(query)}`;
    const html = await fetchHtml(url);
    const root = parseHTML(html);

    const bodyText = root.text;
    if (bodyText.includes('No records matching') || bodyText.includes('No Record Found') || bodyText.includes('Missing Parameter')) {
      return { success: false, error: 'No carrier found matching your search.' };
    }

    // NAME search may return a list page with links to individual carriers
    const carrierLinks = [];
    for (const a of root.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      if (href.includes('query_type=queryCarrierSnapshot') && href.includes('query_param=USDOT')) {
        const match = href.match(/query_string=(\d+)/);
        if (match) carrierLinks.push({ dot: match[1], name: a.text.trim() });
      }
    }
    if (type === 'NAME' && carrierLinks.length > 1) {
      return { success: true, carriers: carrierLinks.slice(0, 20).map(cl => ({ dotNumber: cl.dot, legalName: cl.name, _listResult: true })), isList: true };
    }

    // ── Parse single carrier snapshot ──
    // SAFER HTML is deeply malformed. Use regex on raw HTML for reliable KV extraction.
    // Pattern: <TH...>Label:</TH> followed by <TD...>Value</TD>
    const info = {};
    const kvPattern = /<TH[^>]*>(?:<A[^>]*>)?([^<]+?)(?:<\/A>)?<\/TH>\s*<TD[^>]*>([\s\S]*?)<\/TD>/gi;
    let kvMatch;
    while ((kvMatch = kvPattern.exec(html)) !== null) {
      const key = kvMatch[1].trim().replace(/:$/, '').replace(/\s+/g, ' ');
      // Strip HTML tags from value and decode &nbsp;
      const val = kvMatch[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().replace(/\s+/g, ' ');
      if (key && val && val !== '--') info[key] = val;
    }

    // Cargo carried — extract checked items from HTML section via regex
    // Pattern: <TD...>X</TD> then <TD...><FONT...>Label</FONT></TD> (FONT may or may not be present)
    const cargoChecked = [], opsChecked = [];
    function extractChecked(sectionHtml) {
      const items = [];
      const pat = /<TD[^>]*>\s*X\s*<\/TD>\s*<TD[^>]*>([\s\S]*?)<\/TD>/gi;
      let m;
      while ((m = pat.exec(sectionHtml)) !== null) {
        const label = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (label) items.push(label);
      }
      return items;
    }
    const cargoStart = html.indexOf('Cargo Carried');
    const cargoEnd = html.indexOf('Inspections/Crashes', cargoStart > 0 ? cargoStart : 0);
    if (cargoStart > 0) {
      cargoChecked.push(...extractChecked(html.substring(cargoStart, cargoEnd > cargoStart ? cargoEnd : cargoStart + 5000)));
    }
    const opsStart = html.indexOf('Operation Classification');
    const opsEnd = html.indexOf('Carrier Operation', opsStart > 0 ? opsStart : 0);
    if (opsStart > 0) {
      opsChecked.push(...extractChecked(html.substring(opsStart, opsEnd > opsStart ? opsEnd : opsStart + 3000)));
    }

    // Inspections — parse from the well-structured inspections table via DOM
    const allTables = root.querySelectorAll('table');
    let inspections = null;
    for (const tbl of allTables) {
      const rows = [];
      for (const tr of tbl.querySelectorAll('tr')) {
        const cells = tr.querySelectorAll('th, td').map(td => td.text.trim().replace(/\s+/g, ' '));
        if (cells.some(c => c)) rows.push(cells);
      }
      // US inspections table: 5 cols (Type, Vehicle, Driver, Hazmat, IEP), 5 data rows
      if (rows.length >= 4 && rows[0].length >= 4 && rows[0][0] === 'Inspection Type' && rows[0].includes('Vehicle')) {
        inspections = { headers: rows[0], inspections: rows[1], oos: rows[2], oosPercent: rows[3], natAvg: rows.length > 4 ? rows[4] : null };
        break;
      }
    }

    // Crashes table
    let crashes = null;
    for (const tbl of allTables) {
      const rows = [];
      for (const tr of tbl.querySelectorAll('tr')) {
        const cells = tr.querySelectorAll('th, td').map(td => td.text.trim().replace(/\s+/g, ' '));
        if (cells.some(c => c)) rows.push(cells);
      }
      if (rows.length >= 2 && rows[0].length >= 4 && rows[0][0] === 'Type' && rows[0].includes('Fatal')) {
        crashes = { headers: rows[0], data: rows[1] };
        break;
      }
    }

    const carrier = {
      dotNumber: info['USDOT Number'] || '',
      legalName: info['Legal Name'] || '',
      dbaName: info['DBA Name'] || '',
      status: info['USDOT Status'] || '',
      outOfServiceDate: info['Out of Service Date'] || 'None',
      phone: info['Phone'] || '',
      address: info['Physical Address'] || '',
      mailingAddress: info['Mailing Address'] || '',
      mcNumber: (info['MC/MX/FF Number(s)'] || '').replace(/\s+/g, ' '),
      powerUnits: info['Power Units'] || '',
      drivers: info['Drivers'] || '',
      mcsDate: info['MCS-150 Form Date'] || '',
      mileage: info['MCS-150 Mileage (Year)'] || '',
      entityType: info['Entity Type'] || '',
      opAuthority: (info['Operating Authority Status'] || '').replace(/For Licensing.*$/i, '').trim(),
      operationClass: opsChecked,
      cargoCarried: cargoChecked,
      safetyRating: info['Rating'] || 'None',
      safetyRatingDate: info['Rating Date'] || '',
      reviewDate: info['Review Date'] || '',
      reviewType: info['Type'] || '',
      inspections,
      crashes,
    };

    return { success: true, carriers: [carrier] };
  } catch (e) {
    return { success: false, error: e.message || 'FMCSA lookup failed.' };
  }
});

// --- Email Verification ---
ipcMain.handle('verify-email', async (_event, email) => {
  const dns = require('dns');
  const netMod = require('net');
  const { promisify } = require('util');
  const resolveMx = promisify(dns.resolveMx);

  const DISPOSABLE_DOMAINS = [
    '10minutemail.com','guerrillamail.com','mailinator.com','tempmail.com',
    'throwaway.email','trashmail.com','yopmail.com','getnada.com',
    'maildrop.cc','temp-mail.org','fakeinbox.com','sharklasers.com'
  ];
  const COMMON_TYPOS = {
    'gmial.com':'gmail.com','gmai.com':'gmail.com','gmil.com':'gmail.com',
    'yahooo.com':'yahoo.com','yaho.com':'yahoo.com',
    'hotmial.com':'hotmail.com','hotmil.com':'hotmail.com',
    'outlok.com':'outlook.com','outloo.com':'outlook.com'
  };

  // Major providers that block RCPT TO verification (anti-spam)
  // These have valid MX but reject or mislead on mailbox checks
  const UNVERIFIABLE_PROVIDERS = [
    'icloud.com','me.com','mac.com',           // Apple
    'yahoo.com','ymail.com','aol.com',          // Yahoo/Verizon
    'protonmail.com','proton.me','pm.me',       // ProtonMail
    'tutanota.com','tuta.io',                   // Tutanota
    'zoho.com','zohomail.com',                  // Zoho
    'fastmail.com',                             // FastMail
    'gmx.com','gmx.net',                        // GMX
    'mail.com',                                 // Mail.com
  ];

  const result = {
    email, valid: false, status: 'unknown', classification: 'risky',
    checks: { syntax: {}, disposable: {}, typo: {}, dns: {}, smtp: {} },
    message: '', timestamp: new Date().toISOString()
  };

  // Syntax check
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(email)) {
    result.checks.syntax = { valid: false, message: 'Invalid email format' };
    result.status = 'invalid'; result.classification = 'undeliverable';
    result.message = 'Invalid email format';
    return result;
  }
  result.checks.syntax = { valid: true, message: 'Valid format' };

  const domain = email.split('@')[1].toLowerCase();

  // Disposable check
  const isDisposable = DISPOSABLE_DOMAINS.includes(domain);
  result.checks.disposable = { isDisposable, message: isDisposable ? 'Disposable email service' : 'Not disposable' };
  if (isDisposable) {
    result.status = 'disposable'; result.classification = 'risky';
    result.message = 'Disposable/temporary email service detected';
    return result;
  }

  // Typo check
  if (COMMON_TYPOS[domain]) {
    result.checks.typo = { hasTypo: true, suggestion: COMMON_TYPOS[domain], message: `Did you mean ${COMMON_TYPOS[domain]}?` };
    result.status = 'risky'; result.classification = 'risky';
    result.message = `Possible typo. Did you mean ${email.split('@')[0]}@${COMMON_TYPOS[domain]}?`;
    return result;
  }
  result.checks.typo = { hasTypo: false, message: 'No typos detected' };

  // Known providers that block verification — trust DNS only
  if (UNVERIFIABLE_PROVIDERS.includes(domain)) {
    try {
      const records = await resolveMx(domain);
      result.checks.dns = { valid: true, message: 'MX records found' };
      result.checks.smtp = { valid: true, accepted: null, message: 'Provider blocks mailbox verification' };
      result.valid = true; result.status = 'unverifiable'; result.classification = 'risky';
      result.message = `Domain valid (${domain}) — provider blocks mailbox-level verification`;
      return result;
    } catch (e) {
      result.checks.dns = { valid: false, message: 'No MX records found' };
      result.status = 'invalid'; result.classification = 'undeliverable';
      result.message = 'Domain has no mail server';
      return result;
    }
  }

  // DNS/MX check
  try {
    const records = await resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    result.checks.dns = { valid: true, message: 'MX records found', mxRecords: records.map(r => r.exchange) };

    // SMTP + RCPT TO verification (checks if actual mailbox exists)
    const mxHost = records[0]?.exchange;
    if (mxHost) {
      const smtpResult = await new Promise((resolve) => {
        const socket = netMod.createConnection({ host: mxHost, port: 25, timeout: 8000 });
        let step = 'connect'; // connect → ehlo → mailfrom → rcptto
        let buffer = '';
        const timeout = setTimeout(() => { socket.destroy(); resolve({ connected: false, reason: 'timeout' }); }, 12000);

        socket.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\r\n');
          buffer = lines.pop(); // keep incomplete line
          for (const line of lines) {
            const code = parseInt(line.substring(0, 3));
            if (isNaN(code)) continue;
            // Multi-line responses have '-' after code; wait for final line (space after code)
            if (line[3] === '-') continue;

            if (step === 'connect' && code === 220) {
              step = 'ehlo';
              socket.write('EHLO viper.local\r\n');
            } else if (step === 'ehlo' && code === 250) {
              step = 'mailfrom';
              socket.write('MAIL FROM:<verify@viper.local>\r\n');
            } else if (step === 'mailfrom' && code === 250) {
              step = 'rcptto';
              socket.write(`RCPT TO:<${email}>\r\n`);
            } else if (step === 'rcptto') {
              socket.write('QUIT\r\n');
              clearTimeout(timeout);
              socket.destroy();
              if (code === 250) {
                resolve({ connected: true, accepted: true, reason: 'Mailbox exists' });
              } else if (code === 550 || code === 551 || code === 553 || code === 554) {
                resolve({ connected: true, accepted: false, reason: 'Mailbox does not exist' });
              } else if (code === 452 || code === 421) {
                resolve({ connected: true, accepted: null, reason: 'Server busy, cannot verify' });
              } else {
                resolve({ connected: true, accepted: null, reason: `Server responded ${code}` });
              }
            } else if (code >= 500) {
              // Server rejected our command
              socket.write('QUIT\r\n');
              clearTimeout(timeout);
              socket.destroy();
              resolve({ connected: true, accepted: null, reason: `Server rejected at ${step} (${code})` });
            }
          }
        });
        socket.on('error', () => { clearTimeout(timeout); resolve({ connected: false, reason: 'Connection failed' }); });
        socket.on('timeout', () => { clearTimeout(timeout); socket.destroy(); resolve({ connected: false, reason: 'Connection timed out' }); });
      });

      result.checks.smtp = { valid: smtpResult.connected, accepted: smtpResult.accepted, message: smtpResult.reason };
      if (smtpResult.accepted === true) {
        result.valid = true; result.status = 'valid'; result.classification = 'deliverable';
        result.message = 'Email verified — mailbox exists on server';
      } else if (smtpResult.accepted === false) {
        result.valid = false; result.status = 'invalid'; result.classification = 'undeliverable';
        result.message = 'Mailbox does not exist on server';
      } else if (smtpResult.connected) {
        result.valid = true; result.status = 'catch-all'; result.classification = 'risky';
        result.message = 'Domain valid but server blocks mailbox verification';
      } else {
        result.valid = false; result.status = 'unknown'; result.classification = 'risky';
        result.message = 'Could not connect to mail server';
      }
    }
  } catch (e) {
    result.checks.dns = { valid: false, message: 'No MX records found' };
    result.status = 'invalid'; result.classification = 'undeliverable';
    result.message = 'Domain has no mail server (MX records)';
  }

  return result;
});

// --- Field Security IPC ---
ipcMain.handle('security-check', async () => {
  return {
    enabled: security ? security.isEnabled() : false,
    unlocked: security ? security.isUnlocked() : false
  };
});

ipcMain.handle('security-setup', async (event, { password }) => {
  const recoveryKey = security.setup(password);
  // Hide the cases folder on disk
  _setCasesHidden(true);
  try { audit && audit.write(AUDIT_EVENTS.SECURITY_ENABLED, {}); } catch (_) {}
  return { success: true, recoveryKey };
});

ipcMain.handle('security-unlock', async (event, { password }) => {
  const success = security.unlock(password);
  if (!success) {
    try { audit && audit.write(AUDIT_EVENTS.SECURITY_UNLOCK_FAIL, { method: 'password' }); } catch (_) {}
    return { success: false, vaultData: null };
  }
  // Decrypt vault and return localStorage snapshot
  let vaultData = null;
  try {
    const raw = security.decryptVault();
    if (raw) vaultData = JSON.parse(raw);
  } catch (e) { console.error('Vault decrypt:', e.message); }
  try { audit && audit.write(AUDIT_EVENTS.SECURITY_UNLOCK, { method: 'password' }); } catch (_) {}
  return { success: true, vaultData };
});

ipcMain.handle('security-recover', async (event, { recoveryKey }) => {
  const success = security.recover(recoveryKey);
  if (!success) {
    try { audit && audit.write(AUDIT_EVENTS.SECURITY_UNLOCK_FAIL, { method: 'recovery_key' }); } catch (_) {}
    return { success: false, vaultData: null };
  }
  let vaultData = null;
  try {
    const raw = security.decryptVault();
    if (raw) vaultData = JSON.parse(raw);
  } catch (e) { console.error('Vault decrypt:', e.message); }
  try { audit && audit.write(AUDIT_EVENTS.SECURITY_RECOVERY, {}); } catch (_) {}
  return { success: true, vaultData };
});

ipcMain.handle('security-change-password', async (event, { newPassword }) => {
  try {
    security.changePassword(newPassword);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('security-new-recovery-key', async () => {
  try {
    const recoveryKey = security.generateNewRecoveryKey();
    return { success: true, recoveryKey };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('security-disable', async () => {
  try {
    security.disable();
    try { audit && audit.write(AUDIT_EVENTS.SECURITY_DISABLED, {}); } catch (_) {}
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Pre-lock URL stash — survives lock→unlock within a single app session,
// but is intentionally NOT persisted (in-memory only). On a full app
// quit/relaunch this resets to null, so the next launch lands on Dashboard.
let preLockUrl = null;

ipcMain.handle('security-navigate-app', async () => {
  // Called after successful unlock/setup to navigate to main app.
  // If we stashed a pre-lock URL, restore that exact screen; otherwise
  // (fresh launch, no prior lock this session) land on the Dashboard.
  if (mainWindow) {
    let target = 'http://localhost:8000/index.html';
    if (preLockUrl && /^http:\/\/localhost:8000\//.test(preLockUrl)
        && !/security-login\.html/.test(preLockUrl)) {
      target = preLockUrl;
    }
    preLockUrl = null; // single-use; clear after consuming
    mainWindow.loadURL(target);
  }
  return { success: true };
});

ipcMain.handle('security-save-vault', async (event, data) => {
  // Encrypt localStorage snapshot to vault (called by renderer before lock)
  try {
    security.encryptVault(data);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('security-lock', async (event, opts) => {
  const reason = (opts && opts.reason) || 'manual';
  // Lock master key and navigate back to login page.
  // Capture the current URL FIRST so we can restore it on unlock.
  try {
    if (mainWindow && mainWindow.webContents) {
      const cur = mainWindow.webContents.getURL();
      if (cur && /^http:\/\/localhost:8000\//.test(cur)
          && !/security-login\.html/.test(cur)) {
        preLockUrl = cur;
      }
    }
  } catch (_) { /* ignore */ }
  if (security) security.lock();
  try {
    const evt = reason === 'idle' ? AUDIT_EVENTS.SECURITY_IDLE_LOCK : AUDIT_EVENTS.SECURITY_LOCK;
    audit && audit.write(evt, { reason });
  } catch (_) {}
  if (mainWindow) {
    mainWindow.loadURL('http://localhost:8000/security-login.html');
  }
  return { success: true };
});

// ─── Audit Log IPC ──────────────────────────────────────────────────
// Read recent entries (decrypted in-place when security is unlocked).
ipcMain.handle('audit-log-read', async (event, opts) => {
  if (!audit) return { success: false, error: 'Audit logger not initialized' };
  try {
    const limit = (opts && Number.isInteger(opts.limit)) ? opts.limit : 200;
    const entries = await audit.readTail(limit);
    return { success: true, entries };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Export the full audit chain (across rotated files) to a user-chosen file.
// Writes plaintext JSONL — exporter is responsible for safe handling.
ipcMain.handle('audit-log-export', async () => {
  if (!audit) return { success: false, error: 'Audit logger not initialized' };
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Audit Log',
      defaultPath: `VIPER_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
      filters: [
        { name: 'JSON Lines', extensions: ['jsonl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    restoreFocus();
    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    const entries = await audit.exportAll();
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(result.filePath, lines, 'utf-8');
    try {
      audit.write(AUDIT_EVENTS.AUDIT_LOG_EXPORTED, {
        path: result.filePath,
        entries: entries.length,
      });
    } catch (_) {}
    return { success: true, path: result.filePath, entries: entries.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Verify the SHA-256 hash chain across all rotated files.
ipcMain.handle('audit-log-verify', async () => {
  if (!audit) return { success: false, error: 'Audit logger not initialized' };
  try {
    const result = await audit.verifyChain();
    try {
      audit.write(AUDIT_EVENTS.AUDIT_LOG_VERIFIED, {
        ok: result.ok,
        total: result.totalEntries,
        broken_at: result.brokenAt || null,
        reason: result.reason || null,
      });
    } catch (_) {}
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Toggle Windows Event Log forwarding. Persists to audit-prefs.json next
// to the audit log so it survives restarts.
ipcMain.handle('audit-log-set-event-forwarding', async (event, enabled) => {
  if (!audit) return { success: false, error: 'Audit logger not initialized' };
  try {
    audit.setEventLogForwarding(!!enabled);
    try {
      const prefPath = path.join(app.getPath('userData'), 'audit-prefs.json');
      fs.writeFileSync(prefPath, JSON.stringify({ eventLogEnabled: !!enabled }, null, 2), 'utf-8');
    } catch (_) {}
    try {
      audit.write(AUDIT_EVENTS.SETTINGS_CHANGED, {
        setting: 'audit_event_log_forwarding',
        value: !!enabled,
      });
    } catch (_) {}
    return { success: true, enabled: !!enabled };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Renderer-side write hook. Intentionally narrow: only events from the
// frozen vocabulary are accepted — write() rejects anything else.
ipcMain.handle('audit-log-write', async (event, payload) => {
  if (!audit) return { success: false, error: 'Audit logger not initialized' };
  try {
    const eventType = payload && payload.event;
    const data = (payload && payload.data) || {};
    if (!eventType) return { success: false, error: 'Missing event type' };
    audit.write(eventType, data);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
// --- Select evidence files or folder via native dialog ---
ipcMain.handle('select-evidence-files', async (event, { mode }) => {
  // mode: 'files' or 'folder'
  const props = mode === 'folder'
    ? ['openDirectory']
    : ['openFile', 'multiSelections'];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: mode === 'folder' ? 'Select Evidence Folder' : 'Select Evidence Files',
    properties: props,
    filters: mode === 'folder' ? [] : [{ name: 'All Files', extensions: ['*'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;

  if (mode === 'folder') {
    // Recursively collect all files in folder
    const dirPath = result.filePaths[0];
    const files = [];
    function walk(dir, rel) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, relPath);
        } else {
          const stat = fs.statSync(full);
          files.push({ name: entry.name, path: full, relativePath: relPath, size: stat.size });
        }
      }
    }
    walk(dirPath, '');
    return { folderName: path.basename(dirPath), files };
  }

  // files mode — return list of selected files
  const files = result.filePaths.map(fp => {
    const stat = fs.statSync(fp);
    return { name: path.basename(fp), path: fp, relativePath: path.basename(fp), size: stat.size };
  });
  return { files };
});

// --- Copy an evidence file from source path to case Evidence dir ---
ipcMain.handle('copy-evidence-file', async (event, { caseNumber, evidenceTag, sourcePath, relativePath }) => {
  try {
    const fileName = relativePath || path.basename(sourcePath);
    const evidenceDir = path.join(casesDir, caseNumber, 'Evidence', evidenceTag);
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Preserve subfolder structure
    const destPath = path.join(evidenceDir, fileName);
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const buffer = fs.readFileSync(sourcePath);

    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(destPath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(destPath, buffer);
    }

    return destPath;
  } catch (error) {
    console.error('Failed to copy evidence file:', error);
    throw error;
  }
});

// --- Evidence file storage (replaces Tauri save_evidence_file) ---
ipcMain.handle('save-evidence-file', async (event, data) => {
  try {
    const { caseNumber, evidenceTag, fileName, fileData } = data;
    const evidenceDir = path.join(casesDir, caseNumber, 'Evidence', evidenceTag);
    fs.mkdirSync(evidenceDir, { recursive: true });

    const filePath = path.join(evidenceDir, fileName);
    const buffer = Buffer.from(fileData);

    // Encrypt evidence if security is enabled and unlocked
    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(filePath, buffer);
    }

    console.log(`Evidence saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error) {
    console.error('Failed to save evidence file:', error);
    throw error;
  }
});

// --- Route a Resource-Hub download to its final destination ---
// Called by the renderer after the user picks where the file should go.
// Sources are always a temp file under `${os.tmpdir()}/viper-rh-downloads/`
// produced by the will-download interceptor; we move/encrypt them
// into the case folder and clean up.
ipcMain.handle('rh-download-route', async (_e, payload) => {
  try {
    const action   = payload && payload.action;
    const tempPath = payload && payload.tempPath;
    if (!tempPath || !fs.existsSync(tempPath)) {
      return { success: false, error: 'Source file no longer exists' };
    }
    // Hard safety: tempPath must live inside our temp dir
    const tmpRoot = path.join(os.tmpdir(), 'viper-rh-downloads');
    if (path.resolve(tempPath).indexOf(path.resolve(tmpRoot)) !== 0) {
      return { success: false, error: 'Invalid source path' };
    }

    const fileName = _sanitizeNameSafe(payload.fileName || path.basename(tempPath));

    if (action === 'cancel') {
      try { fs.unlinkSync(tempPath); } catch (_) {}
      return { success: true, action: 'cancel' };
    }

    if (action === 'downloads') {
      const dlDir = app.getPath('downloads');
      let dest = path.join(dlDir, fileName);
      // Avoid clobbering existing file
      if (fs.existsSync(dest)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        dest = path.join(dlDir, `${base}-${Date.now()}${ext}`);
      }
      fs.copyFileSync(tempPath, dest);
      try { fs.unlinkSync(tempPath); } catch (_) {}
      try { shell.showItemInFolder(dest); } catch (_) {}
      return { success: true, action: 'downloads', path: dest };
    }

    const caseNumber = _safeCaseNumber(payload.caseNumber);
    if (!caseNumber) return { success: false, error: 'Invalid case number' };

    if (action === 'evidence') {
      const evidenceTag = _sanitizeNameSafe(payload.evidenceTag || 'Imports');
      const evidenceDir = path.join(casesDir, caseNumber, 'Evidence', evidenceTag);
      fs.mkdirSync(evidenceDir, { recursive: true });

      let dest = path.join(evidenceDir, fileName);
      if (fs.existsSync(dest)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        dest = path.join(evidenceDir, `${base}-${Date.now()}${ext}`);
      }
      const buffer = fs.readFileSync(tempPath);
      if (security && security.isEnabled() && security.isUnlocked()) {
        fs.writeFileSync(dest, security.encryptBuffer(buffer));
      } else {
        fs.writeFileSync(dest, buffer);
      }
      try { fs.unlinkSync(tempPath); } catch (_) {}
      return {
        success: true,
        action: 'evidence',
        path: dest,
        size: buffer.length,
        evidenceTag,
        fileName: path.basename(dest),
      };
    }

    if (action === 'warrant-production') {
      const subfolder = 'Production';
      const warrantDir = path.join(casesDir, caseNumber, 'Warrants', subfolder);
      fs.mkdirSync(warrantDir, { recursive: true });
      let dest = path.join(warrantDir, fileName);
      if (fs.existsSync(dest)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        dest = path.join(warrantDir, `${base}-${Date.now()}${ext}`);
      }
      const buffer = fs.readFileSync(tempPath);
      if (security && security.isEnabled() && security.isUnlocked()) {
        fs.writeFileSync(dest, security.encryptBuffer(buffer));
      } else {
        fs.writeFileSync(dest, buffer);
      }
      try { fs.unlinkSync(tempPath); } catch (_) {}
      return { success: true, action: 'warrant-production', path: dest, size: buffer.length, fileName: path.basename(dest) };
    }

    return { success: false, error: `Unknown action: ${action}` };
  } catch (err) {
    console.error('rh-download-route failed:', err);
    return { success: false, error: err.message || String(err) };
  }
});

function _sanitizeNameSafe(n) {
  return String(n || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 180) || 'file';
}

// --- Capture current Resource-Hub BrowserView as PDF ---
// Uses Electron's native webContents.printToPDF() — captures the full
// rendered page (including content below the fold). The resulting file
// is written to the same temp dir as downloads, then `rh-download-ready`
// is emitted so the existing destination-picker modal handles routing.
const _rhResourceMap = () => ({
  flock:          { bv: flockBrowserView,          label: 'Flock Safety',     defaultTag: 'Flock-Reports'    },
  tlo:            { bv: tloBrowserView,            label: 'TLO',              defaultTag: 'TLO-Reports'      },
  accurint:       { bv: accurintBrowserView,       label: 'Accurint',         defaultTag: 'Accurint-Reports' },
  vigilant:       { bv: vigilantBrowserView,       label: 'Vigilant LPR',     defaultTag: 'Vigilant-Reports' },
  icacDataSystem: { bv: icacDataSystemBrowserView, label: 'ICAC Data System', defaultTag: 'CyberTip-Reports' },
  icacCops:       { bv: icacCopsBrowserView,       label: 'ICACCOPS',         defaultTag: 'ICACCOPS-Reports' },
  gridcop:        { bv: gridcopBrowserView,        label: 'Gridcop',          defaultTag: 'Gridcop-Reports'  },
});

ipcMain.handle('rh-capture-pdf', async (_e, payload) => {
  const resourceId = payload && payload.resourceId;
  const meta = _rhResourceMap()[resourceId];
  if (!meta || !meta.bv || meta.bv.webContents.isDestroyed()) {
    return { success: false, error: 'Resource view not available' };
  }
  try {
    const wc = meta.bv.webContents;
    const url = wc.getURL() || '';
    let title = '';
    try { title = await wc.executeJavaScript('document.title || ""'); } catch (_) {}
    const safeTitle = _sanitizeNameSafe((title || meta.label).replace(/\s+/g, '_')).slice(0, 80);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const fileName = `${safeTitle || meta.label.replace(/\s+/g, '_')}_${ts}.pdf`;

    const tempName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${fileName}`;
    const tempPath = path.join(rhDownloadTmpDir, tempName);

    const pdfBuf = await wc.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(tempPath, pdfBuf);
    const stat = fs.statSync(tempPath);

    mainWindow.webContents.send('rh-download-ready', {
      success: true,
      tempPath,
      fileName,
      size: stat.size,
      mime: 'application/pdf',
      sourceUrl: url,
      resource: meta.label,
      defaultTag: meta.defaultTag,
      capture: true,
    });
    return { success: true, fileName };
  } catch (err) {
    console.error('[rh-capture-pdf]', err);
    return { success: false, error: err.message || String(err) };
  }
});

// --- Capture current Resource-Hub BrowserView as SingleFile HTML ---
// Loads the SingleFile bundle (single-file-cli) into the BrowserView via
// executeJavaScript, then calls singlefile.getPageData() to produce a
// fully-inlined .html file with all assets embedded as base64 (images,
// fonts, stylesheets). Output is a true single-file archive — opens in
// any browser offline, no broken links.
let _sfScriptCache = null;
async function _loadSingleFileScript() {
  if (_sfScriptCache) return _sfScriptCache;
  try {
    // Bundle is ESM; use dynamic import to get the script string.
    // pathToFileURL ensures Windows path is converted correctly.
    const bundlePath = path.join(__dirname, 'node_modules', 'single-file-cli', 'lib', 'single-file-bundle.js');
    const fileUrl = url.pathToFileURL(bundlePath).href;
    const mod = await import(fileUrl);
    _sfScriptCache = mod.script;
    return _sfScriptCache;
  } catch (err) {
    console.error('[rh-capture-html] Failed to load SingleFile bundle:', err);
    throw err;
  }
}

ipcMain.handle('rh-capture-html', async (_e, payload) => {
  const resourceId = payload && payload.resourceId;
  const meta = _rhResourceMap()[resourceId];
  if (!meta || !meta.bv || meta.bv.webContents.isDestroyed()) {
    return { success: false, error: 'Resource view not available' };
  }
  try {
    const wc = meta.bv.webContents;
    const url2 = wc.getURL() || '';
    let title = '';
    try { title = await wc.executeJavaScript('document.title || ""'); } catch (_) {}
    const safeTitle = _sanitizeNameSafe((title || meta.label).replace(/\s+/g, '_')).slice(0, 80);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const fileName = `${safeTitle || meta.label.replace(/\s+/g, '_')}_${ts}.html`;

    const tempName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${fileName}`;
    const tempPath = path.join(rhDownloadTmpDir, tempName);

    // 1) Inject SingleFile bundle into the BrowserView's main world.
    const sfScript = await _loadSingleFileScript();
    await wc.executeJavaScript(sfScript, /* userGesture */ true);

    // 2) Run getPageData and return the inlined HTML.
    const html = await wc.executeJavaScript(`
      (async () => {
        try {
          const opts = {
            removeHiddenElements: false,
            removeUnusedStyles: false,
            removeUnusedFonts: false,
            removeImports: false,
            blockScripts: true,
            blockVideos: false,
            blockAudios: false,
            saveFavicon: true,
            removeFrames: false,
            compressHTML: true,
            backgroundSave: false,
            networkTimeout: 30000,
          };
          const pd = await singlefile.getPageData(opts);
          return pd && pd.content ? pd.content : '';
        } catch (e) {
          return '__SF_ERR__:' + (e && e.message ? e.message : String(e));
        }
      })()
    `, /* userGesture */ true);

    if (typeof html !== 'string' || !html) {
      return { success: false, error: 'SingleFile returned empty content' };
    }
    if (html.startsWith('__SF_ERR__:')) {
      return { success: false, error: html.slice('__SF_ERR__:'.length) };
    }

    fs.writeFileSync(tempPath, html, 'utf8');
    const stat = fs.statSync(tempPath);

    mainWindow.webContents.send('rh-download-ready', {
      success: true,
      tempPath,
      fileName,
      size: stat.size,
      mime: 'text/html',
      sourceUrl: url2,
      resource: meta.label,
      defaultTag: meta.defaultTag,
      capture: true,
    });
    return { success: true, fileName, size: stat.size };
  } catch (err) {
    console.error('[rh-capture-html]', err);
    return { success: false, error: err.message || String(err) };
  }
});

// --- Read evidence file (for inline preview) ---
ipcMain.handle('read-evidence-file', async (event, filePath) => {
  try {
    // Skip files > 500MB (too large for inline preview / memory)
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024 * 1024) {
      throw new Error('File too large for inline preview (' + Math.round(stat.size / 1024 / 1024 / 1024 * 10) / 10 + ' GB)');
    }
    const raw = fs.readFileSync(filePath);
    // Decrypt if security is active and file is encrypted
    if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
      const decrypted = security.decryptBuffer(raw);
      return Array.from(new Uint8Array(decrypted));
    }
    return Array.from(new Uint8Array(raw));
  } catch (error) {
    console.error('Failed to read evidence file:', error);
    throw error;
  }
});

// --- Save warrant file to disk ---
ipcMain.handle('save-warrant-file', async (event, data) => {
  try {
    const { caseNumber, subfolder, fileName, fileData, warrantId } = data;
    // subfolder: 'Signed', 'Production', or 'CourtReturn'
    const warrantDir = path.join(casesDir, caseNumber, 'Warrants', subfolder);
    fs.mkdirSync(warrantDir, { recursive: true });

    // BUG FIX: When two warrants upload files with the same source filename
    // (e.g. both saved as "Search Warrant.pdf"), the second write used to
    // overwrite the first on disk — every warrant record still pointed at
    // the same path, so viewing any of them showed the LATEST uploaded PDF.
    // To users this looked like "all warrants change to the last one".
    // Prefix the on-disk filename with the warrant id so each warrant gets
    // its own unique file. The user-facing filename (warrantFileName /
    // file.name in productionFiles) is stored separately on the record, so
    // the UI continues to show the original name.
    const sanitize = (s) => String(s).replace(/[<>:"|?*\x00-\x1F]/g, '_');
    const safeName = warrantId
      ? `${warrantId}__${sanitize(fileName)}`
      : sanitize(fileName);

    const filePath = path.join(warrantDir, safeName);
    const buffer = Buffer.from(fileData);

    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(filePath, buffer);
    }

    console.log(`Warrant file saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error) {
    console.error('Failed to save warrant file:', error);
    throw error;
  }
});

// --- Read warrant file (for inline preview) ---
ipcMain.handle('read-warrant-file', async (event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
      const decrypted = security.decryptBuffer(raw);
      return Array.from(new Uint8Array(decrypted));
    }
    return Array.from(new Uint8Array(raw));
  } catch (error) {
    console.error('Failed to read warrant file:', error);
    throw error;
  }
});

// --- Save Ops Plan file (photo or document) to disk ---
// Storing Ops Plan photos inline as base64 in localStorage hits the 10MB
// per-origin Chromium quota. Save them under
//   cases/{caseNumber}/OpsPlan/{subfolder}/{fileName}
// and store ONLY the resulting filePath in opsplan_* localStorage.
ipcMain.handle('save-opsplan-file', async (event, data) => {
  try {
    const { caseNumber, subfolder, fileName, fileData } = data;
    const sub = (subfolder || 'Photos').replace(/[<>:"|?*\x00-\x1F\\/]/g, '_');
    const opsDir = path.join(casesDir, caseNumber, 'OpsPlan', sub);
    fs.mkdirSync(opsDir, { recursive: true });

    const sanitize = (s) => String(s || 'file').replace(/[<>:"|?*\x00-\x1F\\/]/g, '_');
    // Prefix with timestamp so two uploads with the same source name don't collide.
    const safeName = `${Date.now()}__${sanitize(fileName)}`;
    const filePath = path.join(opsDir, safeName);
    const buffer = Buffer.from(fileData);

    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(filePath, buffer);
    }

    console.log(`OpsPlan file saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error) {
    console.error('Failed to save Ops Plan file:', error);
    throw error;
  }
});

// --- Read Ops Plan file (for inline preview) ---
ipcMain.handle('read-opsplan-file', async (event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
      const decrypted = security.decryptBuffer(raw);
      return Array.from(new Uint8Array(decrypted));
    }
    return Array.from(new Uint8Array(raw));
  } catch (error) {
    console.error('Failed to read Ops Plan file:', error);
    throw error;
  }
});

// --- Delete Ops Plan file (when user removes a photo) ---
ipcMain.handle('delete-opsplan-file', async (event, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, reason: 'not_found' };
  } catch (error) {
    console.error('Failed to delete Ops Plan file:', error);
    return { success: false, error: error.message };
  }
});

// --- CDR Dumps: per-case JSON storage on disk ---
// Bypasses localStorage origin quota. Source CDR files are already in
// Evidence/ or Warrants/Production/, so dumps.json is a parsed cache, not
// canonical data. Encrypted when Field Security is on.
ipcMain.handle('save-cdr-dumps', async (event, { caseNumber, dumps }) => {
  try {
    if (!caseNumber) throw new Error('caseNumber required');
    const cdrDir = path.join(casesDir, caseNumber, 'CDR');
    fs.mkdirSync(cdrDir, { recursive: true });
    const filePath = path.join(cdrDir, 'dumps.json');
    const json = JSON.stringify(dumps || []);
    const buffer = Buffer.from(json, 'utf8');
    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(filePath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(filePath, buffer);
    }
    return { success: true, path: filePath, bytes: buffer.length };
  } catch (error) {
    console.error('Failed to save CDR dumps:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-cdr-dumps', async (event, { caseNumber }) => {
  try {
    if (!caseNumber) throw new Error('caseNumber required');
    const filePath = path.join(casesDir, caseNumber, 'CDR', 'dumps.json');
    if (!fs.existsSync(filePath)) return { success: true, dumps: [] };
    let buffer = fs.readFileSync(filePath);
    if (security && security.isEnabled() && security.isUnlocked()
        && security.isEncryptedBuffer && security.isEncryptedBuffer(buffer)) {
      buffer = security.decryptBuffer(buffer);
    }
    const text = buffer.toString('utf8');
    const dumps = text ? JSON.parse(text) : [];
    return { success: true, dumps };
  } catch (error) {
    console.error('Failed to read CDR dumps:', error);
    return { success: false, error: error.message, dumps: [] };
  }
});

// --- Department Badge: single agency-wide image stored under userData ---
// Eliminates the 2.5MB base64 string from localStorage.
ipcMain.handle('save-dept-badge', async (event, { fileData, mime }) => {
  try {
    const ext = (mime && /image\/(png|jpe?g|gif|webp|svg\+xml)/.exec(mime))
      ? mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')
      : 'png';
    const badgeDir = path.join(app.getPath('userData'), 'branding');
    fs.mkdirSync(badgeDir, { recursive: true });
    // Wipe any prior badge files (different extension) so we don't accumulate.
    try {
      for (const f of fs.readdirSync(badgeDir)) {
        if (/^dept-badge\./i.test(f)) fs.unlinkSync(path.join(badgeDir, f));
      }
    } catch (_) {}
    const filePath = path.join(badgeDir, `dept-badge.${ext}`);
    const buffer = Buffer.from(fileData);
    fs.writeFileSync(filePath, buffer);
    return { success: true, path: filePath, mime: mime || `image/${ext}` };
  } catch (error) {
    console.error('Failed to save dept badge:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-dept-badge', async () => {
  try {
    const badgeDir = path.join(app.getPath('userData'), 'branding');
    if (!fs.existsSync(badgeDir)) return { success: true, found: false };
    const files = fs.readdirSync(badgeDir).filter(f => /^dept-badge\./i.test(f));
    if (!files.length) return { success: true, found: false };
    const filePath = path.join(badgeDir, files[0]);
    const buffer = fs.readFileSync(filePath);
    const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    const mime = mimeMap[ext] || 'image/png';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return { success: true, found: true, dataUrl, path: filePath, mime };
  } catch (error) {
    console.error('Failed to read dept badge:', error);
    return { success: false, error: error.message, found: false };
  }
});

// --- HTML → PDF (no print dialog) ---
// Used by report generators (e.g. Ops Plan). Spawns a hidden BrowserWindow,
// renders the supplied HTML, waits for assets to settle, calls printToPDF(),
// shows a Save dialog, and writes the file. Avoids the freeze caused by
// invoking window.print() inside a renderer popup that's still rendering
// html2canvas-captured Leaflet maps.
//
// Scaling notes (v3.1.1):
// - HTML is written to a tempfile and loaded via file:// — data: URLs hit
//   ERR_INVALID_URL above ~2MB and inflate ~33% from URL-encoding.
// - A serialization mutex prevents concurrent generations from compounding
//   memory pressure (2 parallel 200MB renders = 400MB peak + Chromium
//   workers).
// - Hard size cap surfaces a clear, actionable error instead of letting
//   Chromium OOM or silently truncate.
// - Session cache is cleared after each generation so cached image bytes
//   from a prior huge report don't accumulate over a long-running session.
// - Renderers are expected to emit disk-backed photos as file:// URLs
//   rather than inline base64 — keeps payload near the structural HTML
//   size regardless of photo count. Photos are decoded on-demand by
//   Chromium during print, then released.

const PDF_HTML_HARD_LIMIT_BYTES = 200 * 1024 * 1024; // 200 MB — sanity ceiling
const PDF_HTML_WARN_BYTES = 50 * 1024 * 1024; // 50 MB — log warning but proceed
const PDF_PRINT_TIMEOUT_MS = 90 * 1000; // 90s
const PDF_TEMP_ROOT = path.join(os.tmpdir(), 'viper-pdf');

let _pdfChain = Promise.resolve(); // mutex: serialize all PDF generations

// Sweep stale PDF temp files (older than 1h) on startup. Prevents leak
// across crash-recovered sessions.
function _sweepPdfTempDir() {
  try {
    if (!fs.existsSync(PDF_TEMP_ROOT)) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of fs.readdirSync(PDF_TEMP_ROOT)) {
      const full = path.join(PDF_TEMP_ROOT, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}
app.whenReady().then(_sweepPdfTempDir);

ipcMain.handle('save-html-as-pdf', async (event, payload) => {
  // Serialize: each invocation chains onto the previous. Failures don't
  // poison the chain (we always resolve, never reject the outer promise).
  const run = _pdfChain.then(() => _doSaveHtmlAsPdf(payload), () => _doSaveHtmlAsPdf(payload));
  _pdfChain = run.catch(() => {});
  return run;
});

async function _doSaveHtmlAsPdf({ html, defaultFileName, options, attachments }) {
  let pdfWin = null;
  let tempHtmlPath = null;
  let printTimer = null;
  try {
    // ── Size guard ──
    const htmlBytes = Buffer.byteLength(html || '', 'utf8');
    if (htmlBytes > PDF_HTML_HARD_LIMIT_BYTES) {
      return {
        success: false,
        error: `Report too large to render (${(htmlBytes / 1024 / 1024).toFixed(1)} MB exceeds ${PDF_HTML_HARD_LIMIT_BYTES / 1024 / 1024} MB ceiling). ` +
               `This usually means too many full-resolution photos are embedded inline. ` +
               `Try unchecking "Include Photos" or reduce the number of attached photos.`
      };
    }
    if (htmlBytes > PDF_HTML_WARN_BYTES) {
      console.warn(`[save-html-as-pdf] Large payload: ${(htmlBytes / 1024 / 1024).toFixed(1)} MB — generation may be slow`);
    }

    const fileName = (defaultFileName || 'report.pdf').replace(/[<>:"|?*\x00-\x1F\\/]/g, '_');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Report as PDF',
      defaultPath: fileName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    restoreFocus && restoreFocus();
    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    pdfWin = new BrowserWindow({
      show: false,
      width: 1100,
      height: 1400,
      backgroundThrottling: false,   // hidden window must run full-speed
      webPreferences: {
        offscreen: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        webSecurity: false,           // tile images from OSM etc. + allow file:// → file://
        devTools: false,
        spellcheck: false
      }
    });

    // Wait for both did-finish-load AND a settle delay so Leaflet tiles +
    // images embedded as data URLs are fully painted.
    const ready = new Promise((resolve, reject) => {
      pdfWin.webContents.once('did-finish-load', resolve);
      pdfWin.webContents.once('did-fail-load', (_e, code, desc) => {
        reject(new Error(`PDF window failed to load: ${desc} (${code})`));
      });
    });

    // Write HTML to a temp file and load via file:// — data: URLs break
    // (ERR_INVALID_URL -300) once the encoded payload exceeds Chromium's
    // URL length limit. file:// has no such limit and avoids the
    // ~33% encodeURIComponent inflation.
    try { fs.mkdirSync(PDF_TEMP_ROOT, { recursive: true }); } catch (_) {}
    tempHtmlPath = path.join(PDF_TEMP_ROOT, `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
    // Write with UTF-8 BOM. Chromium falls back to the OS legacy code page
    // (Windows-1252) when loading file:// HTML that lacks both a <meta
    // charset> tag and a BOM — that's how em-dashes and emoji rendered as
    // â€" / ðŸ"" in earlier 3.1.1 exports. The BOM is an unconditional
    // UTF-8 declaration that wins regardless of in-document meta tags.
    const utf8Bom = '\ufeff';
    const htmlForFile = (html && html.charCodeAt(0) === 0xFEFF) ? html : (utf8Bom + html);
    fs.writeFileSync(tempHtmlPath, htmlForFile, 'utf8');
    await pdfWin.loadFile(tempHtmlPath);
    await ready;
    // Settle delay for in-page async work (Leaflet, fonts, image decode)
    await new Promise(r => setTimeout(r, (options && options.settleMs) || 1500));

    // Print with timeout — if Chromium hangs on a malformed asset we don't
    // want the hidden window to live forever holding GPU + RAM.
    const printPromise = pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: (options && options.pageSize) || 'Letter',
      margins: { marginType: 'default' },
      landscape: !!(options && options.landscape)
    });
    const timeoutPromise = new Promise((_, rej) => {
      printTimer = setTimeout(() => rej(new Error(`PDF render timed out after ${PDF_PRINT_TIMEOUT_MS / 1000}s`)), PDF_PRINT_TIMEOUT_MS);
    });
    const pdfBuffer = await Promise.race([printPromise, timeoutPromise]);
    if (printTimer) { clearTimeout(printTimer); printTimer = null; }

    // ── Merge attached PDFs (rap sheets, firearms docs) into the output ──
    // We deliberately do NOT inline these as <a href="data:application/pdf
    // ;base64,..."> in the report HTML because Adobe Acrobat hard-blocks
    // every data: URL embedded in a PDF link annotation with its
    // "Security Block — does not allow connection to data:..." dialog.
    // Instead we render the report on its own and append the attached
    // PDFs as additional pages via pdf-lib so the detective gets one
    // self-contained document with no external links.
    let finalPdfBuffer = pdfBuffer;
    let mergedCount = 0;
    let mergeWarnings = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      try {
        const { PDFDocument } = require('pdf-lib');
        const outDoc = await PDFDocument.load(pdfBuffer);
        for (const att of attachments) {
          if (!att || !att.base64) continue;
          try {
            const attBytes = Buffer.from(att.base64, 'base64');
            // ignoreEncryption tolerates secured PDFs (e.g. CCH-stamped
            // criminal histories). They'll either copy or fail gracefully.
            const attDoc = await PDFDocument.load(attBytes, { ignoreEncryption: true });
            const pageIndices = attDoc.getPageIndices();
            const copied = await outDoc.copyPages(attDoc, pageIndices);
            for (const p of copied) outDoc.addPage(p);
            mergedCount += pageIndices.length;
          } catch (perAttErr) {
            console.warn(`[save-html-as-pdf] failed to merge attachment "${att.filename}":`, perAttErr.message);
            mergeWarnings.push(`${att.filename}: ${perAttErr.message}`);
          }
        }
        const mergedBytes = await outDoc.save({ useObjectStreams: true });
        finalPdfBuffer = Buffer.from(mergedBytes);
      } catch (mergeErr) {
        console.error('[save-html-as-pdf] PDF merge failed, falling back to report-only PDF:', mergeErr);
        mergeWarnings.push('Merge failed: ' + mergeErr.message);
        finalPdfBuffer = pdfBuffer;
      }
    }

    fs.writeFileSync(result.filePath, finalPdfBuffer);
    return {
      success: true,
      path: result.filePath,
      bytesIn: htmlBytes,
      bytesOut: finalPdfBuffer.length,
      attachmentsMerged: mergedCount,
      attachmentsRequested: Array.isArray(attachments) ? attachments.length : 0,
      mergeWarnings: mergeWarnings.length ? mergeWarnings : undefined
    };
  } catch (error) {
    console.error('save-html-as-pdf failed:', error);
    return { success: false, error: error.message || String(error) };
  } finally {
    if (printTimer) { try { clearTimeout(printTimer); } catch (_) {} }
    if (pdfWin && !pdfWin.isDestroyed()) {
      // Drop session cache so a sequence of large reports doesn't
      // accumulate decoded image bytes across the app's lifetime.
      try { await pdfWin.webContents.session.clearCache(); } catch (_) {}
      try { pdfWin.destroy(); } catch (_) {}
    }
    if (tempHtmlPath) {
      try { fs.unlinkSync(tempHtmlPath); } catch (_) {}
    }
  }
}

// --- Select ZIP archive for warrant production uploads ---
ipcMain.handle('select-production-zip', async (event, { caseNumber, warrantId }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Production ZIP Archive(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'ZIP Archives', extensions: ['zip'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return { files: [] };

  const warrantDir = path.join(casesDir, caseNumber, 'Warrants', 'Production');
  fs.mkdirSync(warrantDir, { recursive: true });

  const sanitize = (s) => String(s).replace(/[<>:"|?*\x00-\x1F]/g, '_');

  const files = [];
  for (const srcPath of result.filePaths) {
    const fileName = path.basename(srcPath);
    // Prefix on-disk filename with warrant id to prevent cross-warrant overwrites.
    const safeName = warrantId ? `${warrantId}__${sanitize(fileName)}` : sanitize(fileName);
    const destPath = path.join(warrantDir, safeName);
    let buffer = fs.readFileSync(srcPath);
    const fileSize = buffer.length;

    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(destPath, security.encryptBuffer(buffer));
    } else {
      fs.writeFileSync(destPath, buffer);
    }

    files.push({ name: fileName, path: destPath, size: fileSize, type: 'application/zip' });
    console.log(`Production ZIP saved: ${destPath} (${fileSize} bytes)`);
  }

  return { files };
});

ipcMain.handle('resolve-warrant-path', async (event, { caseNumber, subfolder, fileName, warrantId }) => {
  const warrantDir = path.join(casesDir, caseNumber, 'Warrants', subfolder);
  const sanitize = (s) => String(s || '').replace(/[<>:"|?*\x00-\x1F]/g, '_');

  // Try id-prefixed filename first (current scheme)
  if (warrantId && fileName) {
    const prefixed = path.join(warrantDir, `${warrantId}__${sanitize(fileName)}`);
    if (fs.existsSync(prefixed)) return prefixed;
  }
  // Try exact filename (legacy non-prefixed scheme)
  if (fileName) {
    const filePath = path.join(warrantDir, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  // Fallback: scan directory — but ONLY return a file that's clearly tied
  // to THIS warrant id (prefix match). Returning a random sibling file is
  // what caused the "all warrants change to last upload" bug.
  try {
    if (fs.existsSync(warrantDir) && warrantId) {
      const files = fs.readdirSync(warrantDir).filter(f => !f.startsWith('.'));
      const owned = files.find(f => f.startsWith(`${warrantId}__`));
      if (owned) {
        console.log('resolve-warrant-path: matched by warrantId prefix:', owned, 'in', warrantDir);
        return path.join(warrantDir, owned);
      }
    }
  } catch (err) {
    console.error('resolve-warrant-path scan error:', err);
  }
  return null;
});

ipcMain.handle('view-warrant-external', async (event, filePath) => {
  try {
    console.log('view-warrant-external called with:', filePath);

    // Reject blob: and data: URLs — these are stale references from old data
    if (!filePath || filePath.startsWith('blob:') || filePath.startsWith('data:')) {
      return { success: false, error: 'Invalid file path — file may need to be re-uploaded' };
    }

    // Check file exists on disk
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found on disk: ' + path.basename(filePath) };
    }

    let viewPath = filePath;
    // If encrypted, decrypt to temp first
    if (security && security.isUnlocked()) {
      const raw = fs.readFileSync(filePath);
      if (security.isEncryptedBuffer(raw)) {
        const decrypted = security.decryptBuffer(raw);
        const tempDir = path.join(app.getPath('temp'), 'viper-warrants');
        fs.mkdirSync(tempDir, { recursive: true });
        viewPath = path.join(tempDir, path.basename(filePath));
        fs.writeFileSync(viewPath, decrypted);
      }
    }

    // Use Windows 'start' command to open in system default viewer
    const { exec } = require('child_process');
    exec(`start "" "${viewPath}"`, (err) => {
      if (err) console.error('exec start failed:', err);
    });
    return { success: true };
  } catch (error) {
    console.error('Failed to open warrant file externally:', error);
    return { success: false, error: error.message };
  }
});

// ====== Canvas Forms (Railway-hosted) ======
// Forms are created on the Intellect Dashboard server (Railway) — accessible from anywhere.
// No local server needed. Officers open the form URL on any device with internet.
// API key is passed from the renderer (licensing.js stores it in localStorage).
const CANVAS_API_BASE = 'https://intellect-unified-dashboard-production.up.railway.app';

async function _canvasApiFetch(apiKey, endpoint, options = {}) {
  if (!apiKey) throw new Error('Not registered — activate your VIPER license first');
  const https = require('https');
  const http_ = require('http');
  const url = new URL(endpoint, CANVAS_API_BASE);
  const transport = url.protocol === 'https:' ? https : http_;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = transport.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject(new Error(data.detail || `Server error ${res.statusCode}`));
          } else {
            resolve(data);
          }
        } catch {
          if (res.statusCode >= 400) reject(new Error(`Server error ${res.statusCode}`));
          else resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Canvas Form IPC handlers — all calls go to Railway server
ipcMain.handle('canvas-form-create', async (event, { apiKey, title, caseRef, fields }) => {
  const result = await _canvasApiFetch(apiKey, '/api/canvas/forms', {
    method: 'POST',
    body: {
      title: title || 'Area Canvas',
      case_ref: caseRef || '',
      fields: fields || ['address']
    }
  });

  // Generate QR code for the form URL
  const QRCode = require('qrcode');
  const qrDataUrl = await QRCode.toDataURL(result.form_url, {
    width: 300, margin: 2,
    color: { dark: '#22d3ee', light: '#0f1117' }
  });

  return {
    formId: result.form_id,
    formUrl: result.form_url,
    qrDataUrl,
    expiresAt: result.expires_at
  };
});

ipcMain.handle('canvas-form-get-info', async (event, { apiKey, formId }) => {
  return await _canvasApiFetch(apiKey, `/api/canvas/${formId}/info`);
});

ipcMain.handle('canvas-form-download', async (event, { apiKey, formId }) => {
  // Download results AND delete them from server
  return await _canvasApiFetch(apiKey, `/api/canvas/${formId}/results`);
});

ipcMain.handle('canvas-form-delete', async (event, { apiKey, formId }) => {
  return await _canvasApiFetch(apiKey, `/api/canvas/${formId}`, { method: 'DELETE' });
});

// ====== Cellebrite Report Integration ======
ipcMain.handle('select-cellebrite-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Cellebrite Report Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('scan-cellebrite-folder', async (event, folderPath) => {
  try {
    // Recursively search for CellebriteReader.exe (max 4 levels deep)
    let readerExePath = null;
    let ufdxPath = null;
    let ufdPath = null;
    let ufdrPath = null;
    let summaryPdfPath = null;

    const scanDir = (dir, depth) => {
      if (depth > 4) return;
      let items;
      try { items = fs.readdirSync(dir); } catch { return; }
      for (const item of items) {
        const full = path.join(dir, item);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const lower = item.toLowerCase();
        if (stat.isFile()) {
          if (lower === 'cellebritereader.exe') readerExePath = full;
          if (lower.endsWith('.ufdx')) ufdxPath = full;
          if (lower.endsWith('.ufd')) ufdPath = full;
          if (lower.endsWith('.ufdr')) ufdrPath = full;
          if (lower === 'summaryreport.pdf') summaryPdfPath = full;
        } else if (stat.isDirectory()) {
          scanDir(full, depth + 1);
        }
      }
    };
    scanDir(folderPath, 0);

    if (!readerExePath) {
      return { success: false, error: 'CellebriteReader.exe not found in the selected folder. Make sure you selected the correct Cellebrite report folder.' };
    }

    // Parse metadata from .ufdx (XML)
    let caseInfo = {};
    let deviceInfo = {};
    if (ufdxPath) {
      try {
        const xml = fs.readFileSync(ufdxPath, 'utf8');
        // Parse DeviceInfo attributes
        const devMatch = xml.match(/<DeviceInfo\s+([^>]+)\/>/);
        if (devMatch) {
          const attrs = devMatch[1];
          const getAttr = (name) => { const m = attrs.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : ''; };
          deviceInfo.vendor = getAttr('Vendor');
          deviceInfo.familyName = getAttr('FamilyName');
        }
        // Parse CrimeCase fields
        const fieldsRegex = /<Fields\s+Caption="([^"]*)"\s+Value="([^"]*)"\s*\/>/g;
        let fm;
        while ((fm = fieldsRegex.exec(xml)) !== null) {
          const key = fm[1].replace(/\s+/g, '').toLowerCase();
          if (key.includes('caseidentifier')) caseInfo.caseIdentifier = fm[2];
          if (key.includes('examinername')) caseInfo.examinerName = fm[2];
          if (key.includes('devicename') || key.includes('evidencenumber')) caseInfo.deviceName = fm[2];
          if (key.includes('crimetype')) caseInfo.crimeType = fm[2];
          if (key.includes('department')) caseInfo.department = fm[2];
          if (key.includes('location')) caseInfo.location = fm[2];
        }
      } catch (e) { console.error('Error parsing .ufdx:', e); }
    }

    // Parse metadata from .ufd (INI-style)
    if (ufdPath) {
      try {
        const ini = fs.readFileSync(ufdPath, 'utf8');
        const getVal = (key) => { const m = ini.match(new RegExp('^' + key + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
        deviceInfo.chipset = getVal('Chipset');
        deviceInfo.model = getVal('Model');
        deviceInfo.os = getVal('OS');
        deviceInfo.securityPatch = getVal('SecurityPatchLevel');
        if (!deviceInfo.vendor) deviceInfo.vendor = getVal('Vendor');
        deviceInfo.version = getVal('Version');
      } catch (e) { console.error('Error parsing .ufd:', e); }
    }

    // Get .ufdr file size if present
    let ufdrSize = 0;
    if (ufdrPath) {
      try { ufdrSize = fs.statSync(ufdrPath).size; } catch {}
    }

    return {
      success: true,
      readerExePath,
      ufdrPath,
      ufdxPath,
      ufdPath,
      summaryPdfPath,
      ufdrSize,
      deviceInfo,
      caseInfo,
      folderPath
    };
  } catch (error) {
    console.error('Error scanning Cellebrite folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('launch-cellebrite-reader', async (event, exePath) => {
  try {
    if (!fs.existsSync(exePath)) {
      return { success: false, error: 'CellebriteReader.exe not found at: ' + exePath };
    }

    const { spawn } = require('child_process');
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exePath)
    });
    child.unref();
    return { success: true };
  } catch (error) {
    console.error('Failed to launch Cellebrite Reader:', error);
    return { success: false, error: error.message };
  }
});

// ====== Cellebrite Embedded Viewer (Win32 window reparenting) ======
let _cellebriteChild = null;
let _cellebriteHwnd = null;  // stored as integer (intptr)
let _cellebriteWatcher = null; // interval that re-reparents new windows
let _cellebriteParentHwnd = null;
let _cellebriteBounds = null;
let _cellebriteScale = 1;
let _win32 = null;

function loadWin32() {
  if (_win32) return _win32;
  try {
    const koffi = require('koffi');
    const u32 = koffi.load('user32.dll');
    // Use intptr for all HWND params — Electron's getNativeWindowHandle() gives a Buffer
    // that we read as integer. koffi void* won't accept raw integers.
    const WNDENUMPROC = koffi.proto('int __stdcall wndenumproc(intptr hwnd, intptr param)');
    _win32 = {
      koffi,
      WNDENUMPROC,
      SetParent: u32.func('intptr __stdcall SetParent(intptr child, intptr parent)'),
      MoveWindow: u32.func('int __stdcall MoveWindow(intptr hWnd, int x, int y, int w, int h, int repaint)'),
      ShowWindow: u32.func('int __stdcall ShowWindow(intptr hWnd, int cmd)'),
      GetWindowLongPtrW: u32.func('intptr __stdcall GetWindowLongPtrW(intptr hWnd, int idx)'),
      SetWindowLongPtrW: u32.func('intptr __stdcall SetWindowLongPtrW(intptr hWnd, int idx, intptr val)'),
      SetWindowPos: u32.func('int __stdcall SetWindowPos(intptr hWnd, intptr hWndAfter, int x, int y, int cx, int cy, uint flags)'),
      EnumWindows: u32.func('int __stdcall EnumWindows(wndenumproc *cb, intptr param)'),
      GetWindowThreadProcessId: u32.func('uint __stdcall GetWindowThreadProcessId(intptr hWnd, _Out_ uint *pid)'),
      IsWindowVisible: u32.func('int __stdcall IsWindowVisible(intptr hWnd)'),
      GetWindowTextW: u32.func('int __stdcall GetWindowTextW(intptr hWnd, str16 *lpString, int nMaxCount)'),
      GetWindowTextLengthW: u32.func('int __stdcall GetWindowTextLengthW(intptr hWnd)'),
    };
    return _win32;
  } catch (e) {
    console.error('Win32 embed not available:', e.message);
    return null;
  }
}

function hwndFromBuffer(buf) {
  // Electron getNativeWindowHandle() returns a Buffer containing the HWND
  // Read as integer — pointer-sized (8 bytes on x64, 4 on x86)
  if (buf.length >= 8) return Number(buf.readBigInt64LE(0));
  return buf.readInt32LE(0);
}

function findHwndByPid(targetPid) {
  const w = loadWin32();
  if (!w) return null;
  let found = null;
  const cb = w.koffi.register((hwnd, _) => {
    const pidBuf = [0];
    w.GetWindowThreadProcessId(hwnd, pidBuf);
    if (pidBuf[0] === targetPid && w.IsWindowVisible(hwnd)) {
      found = hwnd;  // hwnd is already intptr (integer)
      return 0; // stop enumeration
    }
    return 1; // continue
  }, w.koffi.pointer(w.WNDENUMPROC));
  w.EnumWindows(cb, 0);
  w.koffi.unregister(cb);
  return found;
}

// Find ALL visible top-level windows for a given PID
function findAllHwndsByPid(targetPid) {
  const w = loadWin32();
  if (!w) return [];
  const results = [];
  const cb = w.koffi.register((hwnd, _) => {
    const pidBuf = [0];
    w.GetWindowThreadProcessId(hwnd, pidBuf);
    if (pidBuf[0] === targetPid && w.IsWindowVisible(hwnd)) {
      results.push(hwnd);
    }
    return 1; // continue — find all
  }, w.koffi.pointer(w.WNDENUMPROC));
  w.EnumWindows(cb, 0);
  w.koffi.unregister(cb);
  return results;
}

// Reparent a window into the Electron host
function reparentWindow(childHwnd, parentHwnd, bounds, scaleFactor) {
  const w = loadWin32();
  if (!w) return false;

  const GWL_STYLE = -16;
  const GWL_EXSTYLE = -20;
  const WS_CAPTION = 0x00C00000;
  const WS_THICKFRAME = 0x00040000;
  const WS_POPUP = 0x80000000;
  const WS_EX_APPWINDOW = 0x00040000; // remove from taskbar
  const SWP_FRAMECHANGED = 0x0020;
  const SWP_NOZORDER = 0x0004;

  // Strip title bar + thick frame + popup. Do NOT set WS_CHILD — apps like
  // Cellebrite (likely .NET/WPF) fight WS_CHILD and re-detach themselves.
  let style = Number(w.GetWindowLongPtrW(childHwnd, GWL_STYLE));
  style = style & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_POPUP;
  w.SetWindowLongPtrW(childHwnd, GWL_STYLE, style);

  // Remove taskbar entry
  let exStyle = Number(w.GetWindowLongPtrW(childHwnd, GWL_EXSTYLE));
  exStyle = exStyle & ~WS_EX_APPWINDOW;
  w.SetWindowLongPtrW(childHwnd, GWL_EXSTYLE, exStyle);

  // Reparent
  const prev = w.SetParent(childHwnd, parentHwnd);
  console.log('[Cellebrite] SetParent returned:', prev, '(0 = failed) for hwnd:', childHwnd);

  // Apply style changes
  const x = Math.round(bounds.x * scaleFactor);
  const y = Math.round(bounds.y * scaleFactor);
  const width = Math.round(bounds.width * scaleFactor);
  const height = Math.round(bounds.height * scaleFactor);
  w.SetWindowPos(childHwnd, 0, x, y, width, height, SWP_FRAMECHANGED | SWP_NOZORDER);
  w.ShowWindow(childHwnd, 5);
  return prev !== 0;
}

// Find a top-level window by title substring (case-insensitive)
function findWindowByTitle(pattern) {
  const w = loadWin32();
  if (!w) return null;
  let found = null;
  const lowerPattern = pattern.toLowerCase();
  const cb = w.koffi.register((hwnd, _) => {
    if (!w.IsWindowVisible(hwnd)) return 1;
    const len = w.GetWindowTextLengthW(hwnd);
    if (len <= 0) return 1;
    const buf = Buffer.alloc((len + 2) * 2);
    w.GetWindowTextW(hwnd, buf, len + 1);
    const title = buf.toString('utf16le').replace(/\0/g, '');
    if (title.toLowerCase().includes(lowerPattern)) {
      found = { hwnd, title };
      return 0;
    }
    return 1;
  }, w.koffi.pointer(w.WNDENUMPROC));
  w.EnumWindows(cb, 0);
  w.koffi.unregister(cb);
  return found;
}

// Continuous watcher: monitors for escaped Cellebrite windows
// Checks both by PID and by title (in case app spawns child processes)
function startCellebriteWatcher() {
  stopCellebriteWatcher();
  const viperHwnd = _cellebriteParentHwnd;

  _cellebriteWatcher = setInterval(() => {
    if (!_cellebriteChild || !viperHwnd || !_cellebriteBounds) {
      stopCellebriteWatcher();
      return;
    }
    const w = loadWin32();
    if (!w) return;

    // Strategy 1: check by PID for windows that aren't children yet
    const hwnds = findAllHwndsByPid(_cellebriteChild.pid);
    for (const hwnd of hwnds) {
      // Check if already reparented (parent is our window)
      const GWL_STYLE = -16;
      const WS_CHILD = 0x40000000;
      const curStyle = Number(w.GetWindowLongPtrW(hwnd, GWL_STYLE));
      // Check if this window still has a caption (not reparented by us)
      const WS_CAPTION = 0x00C00000;
      if (curStyle & WS_CAPTION) {
        console.log('[Cellebrite] Watcher: reparenting escaped PID window:', hwnd);
        reparentWindow(hwnd, viperHwnd, _cellebriteBounds, _cellebriteScale);
        _cellebriteHwnd = hwnd;
      }
    }

    // Strategy 2: search by title for child-process windows
    const result = findWindowByTitle('Cellebrite');
    if (result && result.hwnd !== viperHwnd) {
      // Verify this window still has a caption (not already reparented)
      const GWL_STYLE = -16;
      const WS_CAPTION = 0x00C00000;
      const curStyle = Number(w.GetWindowLongPtrW(result.hwnd, GWL_STYLE));
      if (curStyle & WS_CAPTION) {
        console.log('[Cellebrite] Watcher: reparenting by title:', result.title, 'hwnd:', result.hwnd);
        reparentWindow(result.hwnd, viperHwnd, _cellebriteBounds, _cellebriteScale);
        _cellebriteHwnd = result.hwnd;
      }
    }
  }, 300); // check every 300ms
}

function stopCellebriteWatcher() {
  if (_cellebriteWatcher) {
    clearInterval(_cellebriteWatcher);
    _cellebriteWatcher = null;
  }
}

ipcMain.handle('cellebrite-launch-embedded', async (event, { exePath, bounds }) => {
  try {
    // Kill existing
    if (_cellebriteChild) {
      try { _cellebriteChild.kill(); } catch {}
      _cellebriteChild = null;
      _cellebriteHwnd = null;
    }

    if (!fs.existsSync(exePath)) {
      return { success: false, error: 'CellebriteReader.exe not found' };
    }

    const w = loadWin32();
    if (!w) {
      return { success: false, error: 'Win32 embedding not available — launching externally' };
    }

    const { spawn } = require('child_process');
    _cellebriteChild = spawn(exePath, [], {
      stdio: 'ignore',
      cwd: path.dirname(exePath)
    });

    _cellebriteChild.on('exit', () => {
      stopCellebriteWatcher();
      _cellebriteChild = null;
      _cellebriteHwnd = null;
      _cellebriteParentHwnd = null;
      _cellebriteBounds = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cellebrite-embed-closed');
      }
    });

    // Convert Electron's Buffer HWND to integer for koffi intptr params
    const parentHwndBuf = mainWindow.getNativeWindowHandle();
    _cellebriteParentHwnd = hwndFromBuffer(parentHwndBuf);
    _cellebriteScale = require('electron').screen.getPrimaryDisplay().scaleFactor;
    _cellebriteBounds = bounds;
    console.log('[Cellebrite] Parent HWND:', _cellebriteParentHwnd, 'Scale:', _cellebriteScale, 'PID:', _cellebriteChild.pid);

    return new Promise((resolve) => {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        if (attempts > 60) {
          clearInterval(poll);
          console.log('[Cellebrite] Window not found after 30s');
          resolve({ success: false, error: 'Cellebrite Reader window did not appear within 30s' });
          return;
        }
        if (!_cellebriteChild) {
          clearInterval(poll);
          resolve({ success: false, error: 'Cellebrite Reader exited unexpectedly' });
          return;
        }

        const childHwnd = findHwndByPid(_cellebriteChild.pid);
        if (!childHwnd) return;
        clearInterval(poll);
        _cellebriteHwnd = childHwnd;
        console.log('[Cellebrite] Found initial window:', childHwnd, 'at attempt', attempts);

        // Reparent the first window
        reparentWindow(childHwnd, _cellebriteParentHwnd, _cellebriteBounds, _cellebriteScale);

        // Start continuous watcher to catch when the app replaces its window
        startCellebriteWatcher();

        resolve({ success: true });
      }, 500);
    });
  } catch (error) {
    console.error('Cellebrite embed failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('cellebrite-set-bounds', (event, bounds) => {
  _cellebriteBounds = bounds; // update for watcher
  if (!_cellebriteHwnd) return;
  const w = loadWin32();
  if (!w) return;
  const sf = _cellebriteScale || require('electron').screen.getPrimaryDisplay().scaleFactor;
  w.MoveWindow(_cellebriteHwnd,
    Math.round(bounds.x * sf),
    Math.round(bounds.y * sf),
    Math.round(bounds.width * sf),
    Math.round(bounds.height * sf), 1);
});

ipcMain.on('cellebrite-set-visible', (event, visible) => {
  if (!_cellebriteHwnd) return;
  const w = loadWin32();
  if (!w) return;
  w.ShowWindow(_cellebriteHwnd, visible ? 5 : 0);
});

ipcMain.handle('cellebrite-close', async () => {
  stopCellebriteWatcher();
  if (_cellebriteChild) {
    try { _cellebriteChild.kill(); } catch {}
    _cellebriteChild = null;
  }
  _cellebriteHwnd = null;
  _cellebriteParentHwnd = null;
  _cellebriteBounds = null;
  return { success: true };
});

ipcMain.handle('copy-cellebrite-folder', async (event, { sourcePath, caseNumber, evidenceTag }) => {
  try {
    const casesDir = path.join(app.getPath('userData'), 'cases');
    const destDir = path.join(casesDir, caseNumber, 'Evidence', evidenceTag);
    fs.mkdirSync(destDir, { recursive: true });

    // Recursively enumerate source files
    const allFiles = [];
    const walk = (dir, rel) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const relPath = rel ? `${rel}/${item}` : item;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full, relPath);
        } else {
          allFiles.push({ src: full, rel: relPath, size: stat.size });
        }
      }
    };
    walk(sourcePath, '');

    const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
    let copiedSize = 0;
    const fileRecords = [];
    let readerExePath = null;
    let ufdrPath = null;

    // Copy each file using streams for memory efficiency
    for (const file of allFiles) {
      const destFile = path.join(destDir, file.rel);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });

      // Stream copy
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(file.src);
        const ws = fs.createWriteStream(destFile);
        rs.on('data', (chunk) => {
          copiedSize += chunk.length;
          // Send progress to renderer
          const pct = Math.round((copiedSize / totalSize) * 100);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cellebrite-copy-progress', { percent: pct, copiedSize, totalSize, currentFile: file.rel });
          }
        });
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });

      fileRecords.push({ name: path.basename(file.rel), path: destFile, size: file.size, type: '' });

      const lower = path.basename(file.rel).toLowerCase();
      if (lower === 'cellebritereader.exe') readerExePath = destFile;
      if (lower.endsWith('.ufdr')) ufdrPath = destFile;
    }

    return {
      success: true,
      fileCount: fileRecords.length,
      totalSize,
      files: fileRecords,
      readerExePath,
      ufdrPath
    };
  } catch (error) {
    console.error('Copy Cellebrite folder failed:', error);
    return { success: false, error: error.message };
  }
});

// --- Oversight file import (.oversight is a ZIP) ---
ipcMain.handle('select-oversight-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Oversight File',
    filters: [{ name: 'Oversight Files', extensions: ['oversight'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('import-oversight-file', async (event, data) => {
  const { filePath, caseNumber } = data;
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    // Read all JSON data files
    const readJson = (name) => {
      const entry = entries.find(e => e.entryName === name);
      return entry ? JSON.parse(entry.getData().toString('utf8')) : [];
    };

    const manifest = (() => {
      const e = entries.find(e => e.entryName === 'manifest.json');
      return e ? JSON.parse(e.getData().toString('utf8')) : {};
    })();

    const offenders = readJson('data/offenders.json');
    const vehicles = readJson('data/vehicles.json');
    const convictions = readJson('data/convictions.json');
    const supervision = readJson('data/supervision.json');
    const registrationEvents = readJson('data/registration_events.json');
    const complianceChecks = readJson('data/compliance_checks.json');
    const officerNotes = readJson('data/officer_notes.json');
    const drugTests = readJson('data/drug_tests.json');
    const polygraphTests = readJson('data/polygraph_tests.json');

    // Save embedded files to disk under cases/{caseNumber}/Oversight/
    const oversightDir = path.join(casesDir, caseNumber, 'Oversight');
    fs.mkdirSync(oversightDir, { recursive: true });

    // Read file_map.json which contains base64-encoded file data
    const fileMapEntry = entries.find(e => e.entryName === 'files/file_map.json');
    const fileMap = fileMapEntry ? JSON.parse(fileMapEntry.getData().toString('utf8')) : [];

    // Map of original @files/ paths to saved disk paths
    const savedFiles = {};

    // Save files from the ZIP (actual binary entries under files/)
    const fileDirs = ['profile_photos', 'residence_photos', 'vehicle_photos', 'documents'];
    for (const dir of fileDirs) {
      const dirPath = path.join(oversightDir, dir);
      fs.mkdirSync(dirPath, { recursive: true });
    }

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith('files/')) continue;
      if (entry.entryName === 'files/file_map.json') continue;

      const relativeName = entry.entryName.replace('files/', '');
      const destPath = path.join(oversightDir, relativeName);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });

      let buffer = entry.getData();
      if (security && security.isEnabled() && security.isUnlocked()) {
        fs.writeFileSync(destPath, security.encryptBuffer(buffer));
      } else {
        fs.writeFileSync(destPath, buffer);
      }

      savedFiles[`@files/${relativeName}`] = destPath;
    }

    // Also handle file_map entries (base64 data for files referenced as data: URIs)
    for (const item of fileMap) {
      if (item.original_path && item.original_path.startsWith('data:') && item.zip_path) {
        const relativeName = item.zip_path.replace('files/', '');
        const destPath = path.join(oversightDir, relativeName);
        // Already saved above from ZIP binary entries, just map the reference
        savedFiles[item.original_path] = destPath;
        savedFiles[`@files/${relativeName}`] = destPath;
      }
    }

    console.log(`Oversight imported: ${offenders.length} offenders, ${Object.keys(savedFiles).length} files saved to ${oversightDir}`);

    return {
      manifest,
      offenders,
      vehicles,
      convictions,
      supervision,
      registrationEvents,
      complianceChecks,
      officerNotes,
      drugTests,
      polygraphTests,
      savedFiles,
      oversightDir
    };
  } catch (error) {
    console.error('Failed to import oversight file:', error);
    throw error;
  }
});

ipcMain.handle('read-oversight-file', async (event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
      const decrypted = security.decryptBuffer(raw);
      return Array.from(new Uint8Array(decrypted));
    }
    return Array.from(new Uint8Array(raw));
  } catch (error) {
    console.error('Failed to read oversight file:', error);
    throw error;
  }
});

// IPC Handlers for Aperture Integration
ipcMain.handle('launch-aperture', async (event, caseData) => {
  const aperturePath = 'C:\\Users\\JUSTI\\Downloads\\Aperture.exe';
  
  // Check if Aperture exists
  if (!fs.existsSync(aperturePath)) {
    console.error('Aperture not found at:', aperturePath);
    return { success: false, error: 'Aperture.exe not found' };
  }

  try {
    // Launch Aperture with case information as command line arguments
    apertureProcess = spawn(aperturePath, [
      `--case-id=${caseData.caseId}`,
      `--case-number=${caseData.caseNumber}`,
      `--case-title=${caseData.caseTitle}`
    ], {
      detached: true,
      stdio: 'ignore'
    });

    apertureProcess.unref();

    console.log('Aperture launched successfully');
    return { success: true };
  } catch (error) {
    console.error('Failed to launch Aperture:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    // If file is encrypted, decrypt to temp and open the temp copy
    // Skip encryption check for files > 500MB (too large to read into memory)
    if (security && security.isUnlocked() && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size < 500 * 1024 * 1024) {
        const raw = fs.readFileSync(filePath);
        if (security.isEncryptedBuffer(raw)) {
          const decrypted = security.decryptBuffer(raw);
          const tempDir = path.join(app.getPath('temp'), 'viper-view');
          fs.mkdirSync(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, path.basename(filePath));
          fs.writeFileSync(tempPath, decrypted);
          await shell.openPath(tempPath);
          return { success: true };
        }
      }
    }
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open file:', error);
    return { success: false, error: error.message };
  }
});

// Aperture Native Integration IPC Handlers
const ApertureParser = require('./modules/aperture/aperture-parser.js');
const ApertureData = require('./modules/aperture/aperture-data.js');
const apertureData = new ApertureData(casesDir);

ipcMain.handle('aperture-load-emails', async (event, caseId) => {
  try {
    const emails = apertureData.loadEmails(String(caseId));
    return { success: true, emails };
  } catch (error) {
    console.error('Failed to load emails:', error);
    return { success: false, error: error.message, emails: [] };
  }
});

ipcMain.handle('aperture-load-sources', async (event, caseId) => {
  try {
    const sources = apertureData.loadSources(String(caseId));
    return { success: true, sources };
  } catch (error) {
    console.error('Failed to load sources:', error);
    return { success: false, error: error.message, sources: [] };
  }
});

ipcMain.handle('aperture-import-mbox', async (event, data) => {
  try {
    const { caseId, filePath, sourceName, fileName } = data;
    
    console.log('Importing mbox:', filePath);
    
    // Parse the mbox file
    const emails = await ApertureParser.parseMbox(filePath);
    
    console.log(`Parsed ${emails.length} emails`);
    
    // Add source
    const source = apertureData.addSource(caseId, {
      name: sourceName,
      fileName: fileName,
      filePath: filePath,
      fileType: 'mbox',
      emailCount: emails.length
    });
    
    // Add emails
    const addedEmails = apertureData.addEmails(caseId, source.id, emails);
    
    return { 
      success: true, 
      emailCount: emails.length,
      sourceId: source.id 
    };
  } catch (error) {
    console.error('Failed to import mbox:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('aperture-update-email', async (event, data) => {
  try {
    const { caseId, emailId, updates } = data;
    const updatedEmail = apertureData.updateEmail(caseId, emailId, updates);
    return { success: true, email: updatedEmail };
  } catch (error) {
    console.error('Failed to update email:', error);
    return { success: false, error: error.message };
  }
});

// --- Aperture: Import a single .eml/.emlx/.msg file ---
ipcMain.handle('aperture-import-email-file', async (event, data) => {
  try {
    const { caseId, filePath, sourceName, fileName } = data;
    const ext = path.extname(filePath).toLowerCase();

    let emails;
    if (ext === '.mbox') {
      emails = await ApertureParser.parseMbox(filePath);
    } else {
      // .eml, .emlx, .msg → single email
      const email = await ApertureParser.parseEml(filePath);
      emails = [email];
    }

    const source = apertureData.addSource(caseId, {
      name: sourceName,
      fileName: fileName,
      filePath: filePath,
      fileType: ext.replace('.', ''),
      emailCount: emails.length
    });

    apertureData.addEmails(caseId, source.id, emails);

    return { success: true, emailCount: emails.length, sourceId: source.id };
  } catch (error) {
    console.error('Failed to import email file:', error);
    return { success: false, error: error.message };
  }
});

// --- Aperture: Scan evidence for email files ---
ipcMain.handle('aperture-scan-evidence', async (event, data) => {
  try {
    const { caseNumber, caseId } = data;
    const files = apertureData.scanEvidenceForEmailFiles(String(caseNumber));
    const imported = apertureData.getImportedFilePaths(String(caseId));

    // Mark which files are already imported
    const results = files.map(f => ({
      ...f,
      alreadyImported: imported.includes(f.path)
    }));

    return { success: true, files: results };
  } catch (error) {
    console.error('Failed to scan evidence:', error);
    return { success: false, error: error.message, files: [] };
  }
});

// --- Aperture: Notes CRUD ---
ipcMain.handle('aperture-get-notes', async (event, data) => {
  try {
    const notes = apertureData.getNotes(data.caseId, data.emailId);
    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message, notes: [] };
  }
});

ipcMain.handle('aperture-add-note', async (event, data) => {
  try {
    const note = apertureData.addNote(data.caseId, data.emailId, data.content);
    return { success: true, note };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('aperture-delete-note', async (event, data) => {
  try {
    apertureData.deleteNote(data.caseId, data.emailId, data.noteId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Aperture: IP Geolocation Lookup ---
ipcMain.handle('aperture-lookup-ip', async (event, data) => {
  try {
    const { net } = require('electron');
    const ipAddress = data.ipAddress;

    // Use ip-api.com (free, no API key needed, 45 req/min)
    const result = await new Promise((resolve, reject) => {
      const request = net.request(`http://ip-api.com/json/${ipAddress}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`);
      let body = '';
      request.on('response', (response) => {
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.end();
    });

    if (result.status === 'fail') {
      return { success: false, error: result.message || 'IP lookup failed' };
    }

    return {
      success: true,
      geo: {
        ip: ipAddress,
        country: result.country,
        countryCode: result.countryCode,
        region: result.regionName,
        city: result.city,
        zip: result.zip,
        latitude: result.lat,
        longitude: result.lon,
        timezone: result.timezone,
        isp: result.isp,
        org: result.org,
        asn: result.as
      }
    };
  } catch (error) {
    console.error('IP lookup error:', error);
    return { success: false, error: error.message };
  }
});

// --- Aperture: Save attachment to temp and open ---
ipcMain.handle('aperture-open-attachment', async (event, data) => {
  try {
    const { caseId, emailId, attachment } = data;
    const savedPath = apertureData.saveAttachment(caseId, emailId, attachment, 0);
    if (savedPath) {
      // If encrypted on disk, decrypt to temp for viewing
      if (security && security.isUnlocked()) {
        const raw = fs.readFileSync(savedPath);
        if (security.isEncryptedBuffer(raw)) {
          const tempDir = path.join(app.getPath('temp'), 'viper-view');
          fs.mkdirSync(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, path.basename(savedPath));
          fs.writeFileSync(tempPath, security.decryptBuffer(raw));
          await shell.openPath(tempPath);
          return { success: true, path: tempPath };
        }
      }
      await shell.openPath(savedPath);
      return { success: true, path: savedPath };
    }
    return { success: false, error: 'No attachment content to save' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Aperture: Get attachment as base64 for inline viewing ---
ipcMain.handle('aperture-get-attachment-data', async (event, data) => {
  try {
    const { caseId, emailId, attachmentIndex } = data;
    const emails = apertureData.loadEmails(caseId);
    const email = emails.find(e => e.id === emailId);
    if (!email || !email.attachments || !email.attachments[attachmentIndex]) {
      return { success: false, error: 'Attachment not found' };
    }
    const att = email.attachments[attachmentIndex];
    return { success: true, attachment: att };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Aperture: Generate Report ---
ipcMain.handle('aperture-generate-report', async (event, data) => {
  try {
    const { caseId, caseName, flaggedOnly } = data;
    const html = apertureData.generateReport(caseId, { caseName, flaggedOnly });

    // Always resolve relative to app dir
    const outDir = path.join(casesDir, caseId, 'aperture');
    fs.mkdirSync(outDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `Aperture_Report_${timestamp}.html`;
    const outPath = path.join(outDir, fileName);

    // Encrypt report if security is enabled and unlocked
    if (security && security.isEnabled() && security.isUnlocked()) {
      fs.writeFileSync(outPath, security.encryptBuffer(Buffer.from(html, 'utf-8')));
      // Decrypt to temp for viewing
      const tempDir = path.join(app.getPath('temp'), 'viper-view');
      fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, path.basename(outPath));
      fs.writeFileSync(tempPath, html, 'utf-8');
      await shell.openPath(tempPath);
    } else {
      fs.writeFileSync(outPath, html, 'utf-8');
      await shell.openPath(outPath);
    }

    return { success: true, path: outPath };
  } catch (error) {
    console.error('Report generation error:', error);
    return { success: false, error: error.message };
  }
});

// --- Media Player: Pop-out window ---
ipcMain.handle('pop-out-media-player', async (_event, mediaUrl) => {
  try {
    if (mediaPlayerWindow && !mediaPlayerWindow.isDestroyed()) {
      mediaPlayerWindow.loadURL(mediaUrl);
      mediaPlayerWindow.focus();
      return { success: true };
    }

    mediaPlayerWindow = new BrowserWindow({
      width: 1024,
      height: 700,
      minWidth: 480,
      minHeight: 400,
      frame: true,
      title: 'VIPER Media Player',
      autoHideMenuBar: true,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        plugins: true,
        partition: 'persist:media',
      },
    });

    mediaPlayerWindow.loadURL(mediaUrl);
    mediaPlayerWindow.on('closed', () => {
      mediaPlayerWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('media-popout-closed');
      }
    });

    return { success: true };
  } catch (error) {
    console.error('Pop-out media error:', error);
    return { success: false, error: error.message };
  }
});

// --- Media Player: BrowserView positioning ---
// Renderer reports the bounding rect of its mediaPlayerContainer placeholder
ipcMain.on('media-set-bounds', (_event, bounds) => {
  if (!mediaBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  // bounds = { x, y, width, height } from getBoundingClientRect()
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  lastMediaBounds = b;
  if (mediaViewVisible) {
    mediaBrowserView.setBounds(b);
  }
});

// Renderer tells main process to show/hide the media BrowserView
ipcMain.on('media-set-visible', (_event, visible) => {
  if (!mediaBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  mediaViewVisible = visible;
  if (visible && lastMediaBounds) {
    try { mainWindow.addBrowserView(mediaBrowserView); } catch (_) {}
    mediaBrowserView.setBounds(lastMediaBounds);
  } else if (!visible) {
    mediaBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(mediaBrowserView); } catch (_) {}
  }
});

// --- Flock Safety LPR: BrowserView positioning ---
ipcMain.on('flock-set-bounds', (_event, bounds) => {
  if (!flockBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  lastFlockBounds = b;
  if (flockViewVisible) {
    flockBrowserView.setBounds(b);
  }
});

ipcMain.on('flock-set-visible', (_event, visible) => {
  if (!flockBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  flockViewVisible = visible;
  if (visible && lastFlockBounds) {
    // Lazy-load Flock on first show (avoids ERR_NETWORK_IO_SUSPENDED)
    const currentUrl = flockBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === '' || currentUrl === 'about:blank') {
      flockBrowserView.webContents.loadURL('https://search-2.flocksafety.com/');
    }
    try { mainWindow.addBrowserView(flockBrowserView); } catch (_) {}
    flockBrowserView.setBounds(lastFlockBounds);
  } else if (!visible) {
    flockBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(flockBrowserView); } catch (_) {}
  }
});

// Navigate Flock to search page and optionally fill a plate number
ipcMain.handle('flock-search-plate', async (_event, { plate, state }) => {
  if (!flockBrowserView) return { success: false, error: 'Flock not initialized' };
  try {
    const currentUrl = flockBrowserView.webContents.getURL();
    // If not on search page, navigate there first
    if (!currentUrl.includes('search-2.flocksafety.com')) {
      flockBrowserView.webContents.loadURL('https://search-2.flocksafety.com/');
      // Wait for page to load
      await new Promise(resolve => {
        flockBrowserView.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 8000); // timeout fallback
      });
    }
    // Fill plate number into the search field after a short delay for SPA rendering
    if (plate) {
      await new Promise(r => setTimeout(r, 1500));
      await flockBrowserView.webContents.executeJavaScript(`
        (function() {
          // Flock uses React — find the plate input and set its value
          const plateInput = document.querySelector('input[placeholder*="license plate" i], input[name*="plate" i], input[aria-label*="plate" i]');
          if (plateInput) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(plateInput, '${plate.replace(/'/g, "\\'")}');
            plateInput.dispatchEvent(new Event('input', { bubbles: true }));
            plateInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          ${state ? `
          // Try to set the state dropdown if provided
          const stateSelect = document.querySelector('select[name*="state" i], [aria-label*="state" i]');
          if (stateSelect) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            nativeSetter.call(stateSelect, '${state.replace(/'/g, "\\'")}');
            stateSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }` : ''}
        })();
      `);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Reset Flock session (logout)
ipcMain.handle('flock-reset', async () => {
  if (!flockBrowserView) return;
  const ses = flockBrowserView.webContents.session;
  await ses.clearStorageData();
  flockBrowserView.webContents.loadURL('https://search-2.flocksafety.com/');
});

/* ── TLO (TransUnion) IPC handlers ─────────────────────────── */
ipcMain.on('tlo-set-bounds', (_event, bounds) => {
  if (!tloBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  lastTloBounds = b;
  if (tloViewVisible) {
    tloBrowserView.setBounds(b);
  }
});

ipcMain.on('tlo-set-visible', (_event, visible) => {
  if (!tloBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  tloViewVisible = visible;
  if (visible && lastTloBounds) {
    // Lazy-load TLO on first show (avoids ERR_NETWORK_IO_SUSPENDED)
    const currentUrl = tloBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === '' || currentUrl === 'about:blank') {
      tloBrowserView.webContents.loadURL('https://tloxp.tlo.com/');
    }
    try { mainWindow.addBrowserView(tloBrowserView); } catch (_) {}
    tloBrowserView.setBounds(lastTloBounds);
  } else if (!visible) {
    tloBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(tloBrowserView); } catch (_) {}
  }
});

// Navigate TLO to search and optionally fill a person's name
ipcMain.handle('tlo-search-person', async (_event, { firstName, lastName, state, dob }) => {
  if (!tloBrowserView) return { success: false, error: 'TLO not initialized' };
  try {
    const currentUrl = tloBrowserView.webContents.getURL();
    // If on login page or not on TLO, navigate to main page
    if (!currentUrl.includes('tloxp.tlo.com') || currentUrl.includes('Login') || currentUrl.includes('login')) {
      tloBrowserView.webContents.loadURL('https://tloxp.tlo.com/');
      await new Promise(resolve => {
        tloBrowserView.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 8000);
      });
    }
    // Fill person search fields
    if (firstName || lastName) {
      await new Promise(r => setTimeout(r, 1500));
      await tloBrowserView.webContents.executeJavaScript(`
        (function() {
          function setVal(el, val) {
            if (!el || !val) return;
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // TLO person search fields
          const fnInput = document.querySelector('input[name*="irstName" i], input[id*="irstName" i], input[placeholder*="First" i]');
          const lnInput = document.querySelector('input[name*="astName" i], input[id*="astName" i], input[placeholder*="Last" i]');
          const stInput = document.querySelector('select[name*="tate" i], select[id*="tate" i]');
          setVal(fnInput, ${JSON.stringify(firstName || '')});
          setVal(lnInput, ${JSON.stringify(lastName || '')});
          ${state ? `if (stInput) { stInput.value = ${JSON.stringify(state)}; stInput.dispatchEvent(new Event('change', { bubbles: true })); }` : ''}
        })();
      `);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Reset TLO session (logout)
ipcMain.handle('tlo-reset', async () => {
  if (!tloBrowserView) return;
  const ses = tloBrowserView.webContents.session;
  await ses.clearStorageData();
  tloBrowserView.webContents.loadURL('https://tloxp.tlo.com/');
});

// ── LexisNexis Accurint IPC ────────────────────────────────
ipcMain.on('accurint-set-bounds', (_event, bounds) => {
  if (!accurintBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  lastAccurintBounds = b;
  if (accurintViewVisible) {
    accurintBrowserView.setBounds(b);
  }
});

ipcMain.on('accurint-set-visible', (_event, visible) => {
  if (!accurintBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  accurintViewVisible = visible;
  if (visible && lastAccurintBounds) {
    const currentUrl = accurintBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === '' || currentUrl === 'about:blank') {
      accurintBrowserView.webContents.loadURL('https://secure.accurint.com/app/bps/main');
    }
    try { mainWindow.addBrowserView(accurintBrowserView); } catch (_) {}
    accurintBrowserView.setBounds(lastAccurintBounds);
  } else if (!visible) {
    accurintBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(accurintBrowserView); } catch (_) {}
  }
});

ipcMain.handle('accurint-search-person', async (_event, { firstName, lastName, state, dob }) => {
  if (!accurintBrowserView) return { success: false, error: 'Accurint not initialized' };
  try {
    const currentUrl = accurintBrowserView.webContents.getURL();
    if (!currentUrl.includes('accurint.com') || currentUrl.includes('login') || currentUrl.includes('Login')) {
      accurintBrowserView.webContents.loadURL('https://secure.accurint.com/app/bps/main');
      await new Promise(resolve => {
        accurintBrowserView.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 8000);
      });
    }
    if (firstName || lastName) {
      await new Promise(r => setTimeout(r, 1500));
      await accurintBrowserView.webContents.executeJavaScript(`
        (function() {
          function setVal(el, val) {
            if (!el || !val) return;
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const fnInput = document.querySelector('input[name*="irstName" i], input[id*="irstName" i], input[placeholder*="First" i]');
          const lnInput = document.querySelector('input[name*="astName" i], input[id*="astName" i], input[placeholder*="Last" i]');
          const stInput = document.querySelector('select[name*="tate" i], select[id*="tate" i]');
          setVal(fnInput, ${JSON.stringify(firstName || '')});
          setVal(lnInput, ${JSON.stringify(lastName || '')});
          ${state ? `if (stInput) { stInput.value = ${JSON.stringify(state)}; stInput.dispatchEvent(new Event('change', { bubbles: true })); }` : ''}
        })();
      `);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('accurint-reset', async () => {
  if (!accurintBrowserView) return;
  const ses = accurintBrowserView.webContents.session;
  await ses.clearStorageData();
  accurintBrowserView.webContents.loadURL('https://secure.accurint.com/app/bps/main');
});

// ── Vigilant Solutions / Motorola VehicleManager IPC ────────────────
const VIGILANT_LOGIN_URL = 'https://vm.motorolasolutions.com/VM8_Auth/Login/VehicleManager_web';

ipcMain.on('vigilant-set-bounds', (_event, bounds) => {
  if (!vigilantBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  lastVigilantBounds = b;
  if (vigilantViewVisible) {
    vigilantBrowserView.setBounds(b);
  }
});

ipcMain.on('vigilant-set-visible', (_event, visible) => {
  if (!vigilantBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  vigilantViewVisible = visible;
  if (visible && lastVigilantBounds) {
    const currentUrl = vigilantBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === '' || currentUrl === 'about:blank') {
      vigilantBrowserView.webContents.loadURL(VIGILANT_LOGIN_URL);
    }
    try { mainWindow.addBrowserView(vigilantBrowserView); } catch (_) {}
    vigilantBrowserView.setBounds(lastVigilantBounds);
  } else if (!visible) {
    vigilantBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(vigilantBrowserView); } catch (_) {}
  }
});

// ── ICAC Data System IPC ────────────────────────────────────────────
ipcMain.on('icac-data-system-set-bounds', (_event, bounds) => {
  if (!icacDataSystemBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
  if (b.width < 10 || b.height < 10) return;
  lastIcacDataSystemBounds = b;
  if (icacDataSystemViewVisible) icacDataSystemBrowserView.setBounds(b);
});
ipcMain.on('icac-data-system-set-visible', (_event, visible) => {
  if (!icacDataSystemBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  icacDataSystemViewVisible = visible;
  if (visible && lastIcacDataSystemBounds) {
    const currentUrl = icacDataSystemBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === 'about:blank') {
      icacDataSystemBrowserView.webContents.loadURL('https://www.icacdatasystem.com/landing/login');
    }
    try { mainWindow.addBrowserView(icacDataSystemBrowserView); } catch (_) {}
    icacDataSystemBrowserView.setBounds(lastIcacDataSystemBounds);
  } else {
    icacDataSystemBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(icacDataSystemBrowserView); } catch (_) {}
  }
});

// ── ICACCOPS IPC ────────────────────────────────────────────────────
ipcMain.on('icac-cops-set-bounds', (_event, bounds) => {
  if (!icacCopsBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
  if (b.width < 10 || b.height < 10) return;
  lastIcacCopsBounds = b;
  if (icacCopsViewVisible) icacCopsBrowserView.setBounds(b);
});
ipcMain.on('icac-cops-set-visible', (_event, visible) => {
  if (!icacCopsBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  icacCopsViewVisible = visible;
  if (visible && lastIcacCopsBounds) {
    const currentUrl = icacCopsBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === 'about:blank') {
      icacCopsBrowserView.webContents.loadURL('https://www.icaccops.com/users?ReturnUrl=%2Fusers%2Fhome');
    }
    try { mainWindow.addBrowserView(icacCopsBrowserView); } catch (_) {}
    icacCopsBrowserView.setBounds(lastIcacCopsBounds);
  } else {
    icacCopsBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(icacCopsBrowserView); } catch (_) {}
  }
});

// ── Gridcop IPC ─────────────────────────────────────────────────────
ipcMain.on('gridcop-set-bounds', (_event, bounds) => {
  if (!gridcopBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
  if (b.width < 10 || b.height < 10) return;
  lastGridcopBounds = b;
  if (gridcopViewVisible) gridcopBrowserView.setBounds(b);
});
ipcMain.on('gridcop-set-visible', (_event, visible) => {
  if (!gridcopBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  gridcopViewVisible = visible;
  if (visible && lastGridcopBounds) {
    const currentUrl = gridcopBrowserView.webContents.getURL();
    if (!currentUrl || currentUrl === 'about:blank') {
      gridcopBrowserView.webContents.loadURL('https://www.gridcop.com/cb-login');
    }
    try { mainWindow.addBrowserView(gridcopBrowserView); } catch (_) {}
    gridcopBrowserView.setBounds(lastGridcopBounds);
  } else {
    gridcopBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { mainWindow.removeBrowserView(gridcopBrowserView); } catch (_) {}
  }
});

// Generic zoom factor control for the Resource Hub BrowserViews.
// Renderer sends a resource id ('flock' | 'tlo' | 'accurint' | 'vigilant')
// and a zoom factor (0.5 .. 2.0). Persists across visibility toggles
// because we apply directly to the BV's webContents.
ipcMain.on('rh-set-zoom', (_event, payload) => {
  try {
    const { resId, factor } = payload || {};
    const f = Math.max(0.5, Math.min(2.0, parseFloat(factor) || 1));
    let bv = null;
    if (resId === 'flock') bv = flockBrowserView;
    else if (resId === 'tlo') bv = tloBrowserView;
    else if (resId === 'accurint') bv = accurintBrowserView;
    else if (resId === 'vigilant') bv = vigilantBrowserView;
    else if (resId === 'icacDataSystem') bv = icacDataSystemBrowserView;
    else if (resId === 'icacCops') bv = icacCopsBrowserView;
    else if (resId === 'gridcop') bv = gridcopBrowserView;
    if (bv && bv.webContents && !bv.webContents.isDestroyed()) {
      bv.webContents.setZoomFactor(f);
    }
  } catch (e) {
    console.warn('rh-set-zoom failed:', e);
  }
});

ipcMain.handle('vigilant-search-plate', async (_event, { plate, state }) => {
  if (!vigilantBrowserView) return { success: false, error: 'Vigilant not initialized' };
  try {
    const currentUrl = vigilantBrowserView.webContents.getURL();
    if (!currentUrl.includes('motorolasolutions.com') || currentUrl.includes('Login') || currentUrl.includes('VM8_Auth')) {
      vigilantBrowserView.webContents.loadURL(VIGILANT_LOGIN_URL);
      await new Promise(resolve => {
        vigilantBrowserView.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 8000);
      });
    }
    if (plate) {
      await new Promise(r => setTimeout(r, 1500));
      await vigilantBrowserView.webContents.executeJavaScript(`
        (function() {
          function setVal(el, val) {
            if (!el || !val) return;
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const plateInput = document.querySelector('input[name*="late" i], input[id*="late" i], input[placeholder*="Plate" i], input[placeholder*="plate" i]');
          const stateInput = document.querySelector('select[name*="tate" i], select[id*="tate" i]');
          setVal(plateInput, ${JSON.stringify(plate)});
          ${state ? `if (stateInput) { stateInput.value = ${JSON.stringify(state)}; stateInput.dispatchEvent(new Event('change', { bubbles: true })); }` : ''}
        })();
      `);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vigilant-reset', async () => {
  if (!vigilantBrowserView) return;
  const ses = vigilantBrowserView.webContents.session;
  await ses.clearStorageData();
  vigilantBrowserView.webContents.loadURL(VIGILANT_LOGIN_URL);
});

// --- GenLogs API Proxy (avoids CORS in renderer) ---
ipcMain.handle('genlogs-request', async (_event, { method, url, headers, body }) => {
  const https = require('https');
  const { URL } = require('url');

  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: method || 'GET',
        headers: headers || {}
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, body: { detail: 'Failed to parse response' } });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ ok: false, status: 0, body: { detail: e.message } });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ ok: false, status: 0, body: { detail: 'Request timed out' } });
      });

      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, body: { detail: e.message } });
    }
  });
});

// ─── Google Warrant Parser IPC ──────────────────────────────────────────

const GoogleWarrantParser = require('./modules/google-warrant/google-warrant-parser');
const gwParser = new GoogleWarrantParser();

ipcMain.handle('google-warrant-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Warrants', 'Production')
    ];

    const googlePattern = /\.\d+\.(GoogleAccount|GooglePlayStore|Mail|LocationHistory|GoogleChat|Hangouts|GooglePay|Drive)\./i;
    const files = [];

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      const scanDir = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });

        // Check if this directory itself contains Google warrant inner ZIPs
        const innerZips = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.zip') && googlePattern.test(e.name));
        if (innerZips.length >= 2) {
          // This folder IS an extracted Google warrant return — report as a scannable folder
          files.push({
            name: path.basename(d),
            path: d,
            size: entries.filter(e => e.isFile()).reduce((s, e) => {
              try { return s + fs.statSync(path.join(d, e.name)).size; } catch { return s; }
            }, 0),
            isFolder: true
          });
          return; // don't recurse deeper into inner zip files
        }

        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
            try {
              let buf = fs.readFileSync(fullPath);
              // Decrypt if Field Security is active
              if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
                buf = security.decryptBuffer(buf);
              }
              if (GoogleWarrantParser.isGoogleWarrantZip(buf)) {
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: fs.statSync(fullPath).size
                });
              }
            } catch (e) { /* not a valid zip or encrypted, skip */ }
          }
        }
      };
      scanDir(dir);
    }

    return { success: true, files };
  } catch (error) {
    console.error('Google warrant scan error:', error);
    return { success: false, error: error.message, files: [] };
  }
});

ipcMain.handle('google-warrant-import', async (event, { filePath }) => {
  try {
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Folder of extracted inner ZIPs — reassemble into a virtual outer ZIP
      const AdmZip = require('adm-zip');
      const outerZip = new AdmZip();
      const entries = fs.readdirSync(filePath);
      for (const name of entries) {
        const full = path.join(filePath, name);
        if (fs.statSync(full).isFile()) {
          let buf = fs.readFileSync(full);
          if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
            buf = security.decryptBuffer(buf);
          }
          outerZip.addFile(name, buf);
        }
      }
      const data = await gwParser.parseOuterZip(outerZip.toBuffer());
      return { success: true, data };
    }

    // Single ZIP file
    let buf = fs.readFileSync(filePath);
    // Decrypt if Field Security is active
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    const data = await gwParser.parseOuterZip(buf);
    return { success: true, data };
  } catch (error) {
    console.error('Google warrant import error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('google-warrant-pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Google Warrant Return ZIP',
    properties: ['openFile'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ─── META Warrant Parser IPC ────────────────────────────────────────────

const MetaWarrantParser = require('./modules/meta-warrant/meta-warrant-parser');
const mwParser = new MetaWarrantParser();

ipcMain.handle('meta-warrant-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Warrants', 'Production')
    ];

    const files = [];

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      const scanDir = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
            try {
              let buf = fs.readFileSync(fullPath);
              if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
                buf = security.decryptBuffer(buf);
              }
              if (MetaWarrantParser.isMetaWarrantZip(buf)) {
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: fs.statSync(fullPath).size
                });
              }
            } catch (e) { /* not a valid zip or encrypted, skip */ }
          }
        }
      };
      scanDir(dir);
    }

    return { success: true, files };
  } catch (error) {
    console.error('META warrant scan error:', error);
    return { success: false, error: error.message, files: [] };
  }
});

ipcMain.handle('meta-warrant-import', async (event, { filePath, caseNumber }) => {
  try {
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    const data = await mwParser.parseZip(buf);

    // Save large media files to disk instead of keeping in localStorage
    if (caseNumber && data.mediaFiles) {
      const mediaDir = path.join(casesDir, caseNumber, 'Evidence', 'MetaWarrant', 'linked_media');
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

      for (const [fileName, info] of Object.entries(data.mediaFiles)) {
        const fileDest = path.join(mediaDir, fileName);
        const fileBuf = Buffer.from(info.data, 'base64');
        if (security && security.isUnlocked()) {
          fs.writeFileSync(fileDest, security.encryptBuffer(fileBuf));
        } else {
          fs.writeFileSync(fileDest, fileBuf);
        }
        // Replace base64 with disk path reference
        info.diskPath = fileDest;
        info.data = null; // clear base64 to save memory
      }
    }

    return { success: true, data };
  } catch (error) {
    console.error('META warrant import error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('meta-warrant-pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select META Warrant Return ZIP',
    properties: ['openFile'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('meta-warrant-read-media', async (event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm'
    };
    return {
      success: true,
      data: buf.toString('base64'),
      mimeType: mimeMap[ext] || 'application/octet-stream'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── KIK Warrant Parser IPC ────────────────────────────────────────────

const KikWarrantParser = require('./modules/kik-warrant/kik-warrant-parser');
const kkParser = new KikWarrantParser();

ipcMain.handle('kik-warrant-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Warrants', 'Production')
    ];

    const files = [];

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      const scanDir = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
            try {
              let buf = fs.readFileSync(fullPath);
              if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
                buf = security.decryptBuffer(buf);
              }
              if (KikWarrantParser.isKikWarrantZip(buf)) {
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: fs.statSync(fullPath).size
                });
              }
            } catch (e) { /* not a valid zip or encrypted, skip */ }
          }
        }
      };
      scanDir(dir);
    }

    return { success: true, files };
  } catch (error) {
    console.error('KIK warrant scan error:', error);
    return { success: false, error: error.message, files: [] };
  }
});

ipcMain.handle('kik-warrant-import', async (event, { filePath, caseNumber }) => {
  try {
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }

    // Single-pass: parse + extract content to disk simultaneously
    const extractDir = caseNumber
      ? path.join(casesDir, caseNumber, 'Evidence', 'KikWarrant', 'content')
      : null;
    const data = await kkParser.parseZip(buf, {
      extractDir,
      security: security && security.isUnlocked() ? security : null
    });

    // Free buffer immediately
    buf = null;

    const extractedCount = extractDir
      ? Object.values(data.contentFiles).filter(f => f.diskPath).length
      : 0;
    if (extractedCount > 0) {
      console.log(`KIK warrant: extracted ${extractedCount} media files to ${extractDir}`);
    }

    return { success: true, data };
  } catch (error) {
    console.error('KIK warrant import error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('kik-warrant-pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select KIK Warrant Return ZIP',
    properties: ['openFile'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('kik-warrant-read-media', async (event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    // Detect mime from magic bytes
    let mimeType = 'application/octet-stream';
    if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg';
    else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png';
    else if (buf.length > 7 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mimeType = 'video/mp4';
    else {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.mp4') mimeType = 'video/mp4';
      else if (ext === '.gif') mimeType = 'image/gif';
    }
    return { success: true, data: buf.toString('base64'), mimeType };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Snapchat Warrant Parser IPC ────────────────────────────────────────

const SnapchatWarrantParser = require('./modules/snapchat-warrant/snapchat-warrant-parser');
const swParser = new SnapchatWarrantParser();

/**
 * Scan Evidence/ and Warrants/Production/ for Snapchat warrant data.
 * Detects BOTH unzipped folders AND .zip archives containing Snapchat
 * production part-folders (those with conversations.csv + Snapchat preamble).
 */
ipcMain.handle('snapchat-warrant-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Warrants', 'Production')
    ];

    // Helper: detect Field Security encryption via 6-byte magic header (no full read)
    const isFileEncrypted = (filePath) => {
      try {
        const fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(6);
        fs.readSync(fd, head, 0, 6, 0);
        fs.closeSync(fd);
        return head.equals(Buffer.from('VIPENC'));
      } catch (e) { return false; }
    };

    const files = [];
    const seen = new Set();

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;

      const scanDir = (d, depth) => {
        if (depth > 5) return; // safety cap (deeper for nested Evidence groups)
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (seen.has(fullPath)) continue;

          if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
            try {
              let detected = false;
              if (isFileEncrypted(fullPath)) {
                if (security && security.isUnlocked()) {
                  const buf = security.decryptBuffer(fs.readFileSync(fullPath));
                  detected = SnapchatWarrantParser.isSnapchatWarrantZip(buf);
                }
              } else {
                // Fast path: AdmZip reads only central directory from disk
                detected = SnapchatWarrantParser.isSnapchatWarrantZip(fullPath);
              }
              if (detected) {
                seen.add(fullPath);
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: fs.statSync(fullPath).size,
                  isFolder: false
                });
              }
            } catch (e) { /* skip */ }
          } else if (entry.isDirectory()) {
            // Check if THIS directory is itself a Snapchat production
            if (SnapchatWarrantParser.isSnapchatWarrantFolder(fullPath)) {
              seen.add(fullPath);
              files.push({
                name: entry.name,
                path: fullPath,
                size: 0,
                isFolder: true
              });
              // Don't descend further into a confirmed production folder
              continue;
            }
            scanDir(fullPath, depth + 1);
          }
        }
      };
      scanDir(dir, 0);
    }

    return { success: true, files };
  } catch (error) {
    console.error('Snapchat warrant scan error:', error);
    return { success: false, error: error.message, files: [] };
  }
});

ipcMain.handle('snapchat-warrant-import', async (event, { filePath, caseNumber, isFolder }) => {
  try {
    const extractDir = caseNumber
      ? path.join(casesDir, caseNumber, 'Evidence', 'SnapchatWarrant')
      : null;
    if (extractDir && !fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

    // Detect Field Security encryption via 6-byte magic header (no full read)
    const isFileEncrypted = (fp) => {
      try {
        const fd = fs.openSync(fp, 'r');
        const head = Buffer.alloc(6);
        fs.readSync(fd, head, 0, 6, 0);
        fs.closeSync(fd);
        return head.equals(Buffer.from('VIPENC'));
      } catch (e) { return false; }
    };

    let data;
    if (isFolder) {
      data = await swParser.parseFolder(filePath, { extractDir, security });
    } else if (isFileEncrypted(filePath)) {
      // Encrypted ZIP — must load + decrypt fully into memory
      if (!security || !security.isUnlocked()) {
        return { success: false, error: 'File is Field Security encrypted but security is locked' };
      }
      const buf = security.decryptBuffer(fs.readFileSync(filePath));
      data = await swParser.parseZip(buf, { extractDir, security });
    } else {
      // Unencrypted: pass path directly so AdmZip streams from disk (no full buffer in RAM)
      data = await swParser.parseZip(filePath, { extractDir, security });
    }

    return { success: true, data };
  } catch (error) {
    console.error('Snapchat warrant import error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('snapchat-warrant-pick-file', async () => {
  // Allow user to pick either a ZIP file OR a folder
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Snapchat Warrant Production (ZIP or Folder)',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Snapchat Warrant Production', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  const picked = result.filePaths[0];
  let isFolder = false;
  try {
    isFolder = fs.statSync(picked).isDirectory();
  } catch (e) { /* leave false */ }
  return { path: picked, isFolder };
});

ipcMain.handle('snapchat-warrant-read-media', async (event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    let mimeType = 'application/octet-stream';
    if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg';
    else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png';
    else if (buf.length > 7 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mimeType = 'video/mp4';
    else if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
    else {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.mp4') mimeType = 'video/mp4';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.webm') mimeType = 'video/webm';
      else if (ext === '.mov') mimeType = 'video/quicktime';
    }
    return { success: true, data: buf.toString('base64'), mimeType };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Discord Warrant Parser IPC ─────────────────────────────────────

const DiscordWarrantParser = require('./modules/discord-warrant/discord-warrant-parser');
const dwParser = new DiscordWarrantParser();

/**
 * Scan Evidence/ and Warrants/Production/ for Discord Data Package warrant returns.
 * Detects both unzipped folders and .zip archives.
 */
ipcMain.handle('discord-warrant-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Warrants', 'Production')
    ];

    const isFileEncrypted = (filePath) => {
      try {
        const fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(6);
        fs.readSync(fd, head, 0, 6, 0);
        fs.closeSync(fd);
        return head.equals(Buffer.from('VIPENC'));
      } catch (e) { return false; }
    };

    // Filename / folder name hints (used when we can't open the ZIP — e.g. encrypted + locked)
    const looksLikeDiscord = (name) => /discord|^package(?:\.zip)?$/i.test(name || '');

    const files = [];
    const seen = new Set();
    const debug = {
      casesDir,
      caseNumber,
      scannedDirs: [],
      candidates: [],   // every .zip we considered, with reason
      securityState: {
        present: !!security,
        enabled: !!(security && security.isEnabled && security.isEnabled()),
        unlocked: !!(security && security.isUnlocked && security.isUnlocked())
      }
    };

    for (const dir of dirsToScan) {
      const exists = fs.existsSync(dir);
      debug.scannedDirs.push({ dir, exists });
      if (!exists) continue;
      const scanDir = (d, depth) => {
        if (depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (seen.has(fullPath)) continue;

          if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
            const parentDir = path.basename(path.dirname(fullPath));
            const cand = { path: fullPath, parent: parentDir, encrypted: false, detected: false, reason: '' };
            try {
              const enc = isFileEncrypted(fullPath);
              cand.encrypted = enc;
              if (enc) {
                if (security && security.isUnlocked && security.isUnlocked()) {
                  try {
                    const buf = security.decryptBuffer(fs.readFileSync(fullPath));
                    cand.detected = DiscordWarrantParser.isDiscordWarrantZip(buf);
                    cand.reason = cand.detected ? 'decrypted+matched' : 'decrypted+nomatch';
                  } catch (e) {
                    cand.reason = 'decrypt-error:' + e.message;
                  }
                } else {
                  // Can't open — fall back to filename / parent-folder hint
                  if (looksLikeDiscord(parentDir) || looksLikeDiscord(entry.name)) {
                    cand.detected = true;
                    cand.reason = 'encrypted-locked, hint:' + parentDir + '/' + entry.name;
                  } else {
                    cand.reason = 'encrypted-locked, no hint';
                  }
                }
              } else {
                cand.detected = DiscordWarrantParser.isDiscordWarrantZip(fullPath);
                cand.reason = cand.detected ? 'matched' : 'nomatch';
                // Fall back to hint even for unencrypted files (e.g. partial productions)
                if (!cand.detected && (looksLikeDiscord(parentDir) || looksLikeDiscord(entry.name))) {
                  cand.detected = true;
                  cand.reason = 'fallback hint:' + parentDir + '/' + entry.name;
                }
              }
              debug.candidates.push(cand);
              if (cand.detected) {
                seen.add(fullPath);
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: fs.statSync(fullPath).size,
                  isFolder: false,
                  encryptedLocked: enc && !(security && security.isUnlocked && security.isUnlocked())
                });
              }
            } catch (e) {
              cand.reason = 'error:' + e.message;
              debug.candidates.push(cand);
            }
          } else if (entry.isDirectory()) {
            if (DiscordWarrantParser.isDiscordWarrantFolder(fullPath)) {
              seen.add(fullPath);
              files.push({
                name: entry.name,
                path: fullPath,
                size: 0,
                isFolder: true
              });
              continue;
            }
            scanDir(fullPath, depth + 1);
          }
        }
      };
      scanDir(dir, 0);
    }

    console.log('[discord-warrant-scan]', JSON.stringify(debug, null, 2));
    return { success: true, files, debug };
  } catch (error) {
    console.error('Discord warrant scan error:', error);
    return { success: false, error: error.message, files: [] };
  }
});

ipcMain.handle('discord-warrant-import', async (event, { filePath, caseNumber, isFolder }) => {
  try {
    const extractDir = caseNumber
      ? path.join(casesDir, caseNumber, 'Evidence', 'DiscordWarrant')
      : null;
    if (extractDir && !fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

    const isFileEncrypted = (fp) => {
      try {
        const fd = fs.openSync(fp, 'r');
        const head = Buffer.alloc(6);
        fs.readSync(fd, head, 0, 6, 0);
        fs.closeSync(fd);
        return head.equals(Buffer.from('VIPENC'));
      } catch (e) { return false; }
    };

    let data;
    if (isFolder) {
      data = await dwParser.parseFolder(filePath, { extractDir, security });
    } else if (isFileEncrypted(filePath)) {
      if (!security || !security.isUnlocked()) {
        return { success: false, error: 'File is Field Security encrypted but security is locked' };
      }
      const buf = security.decryptBuffer(fs.readFileSync(filePath));
      data = await dwParser.parseZip(buf, { extractDir, security });
    } else {
      data = await dwParser.parseZip(filePath, { extractDir, security });
    }

    return { success: true, data };
  } catch (error) {
    console.error('Discord warrant import error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord-warrant-pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Discord Warrant Return (ZIP or Folder)',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Discord Data Package', extensions: ['zip'] }]
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  const picked = result.filePaths[0];
  let isFolder = false;
  try { isFolder = fs.statSync(picked).isDirectory(); } catch (e) { /* leave false */ }
  return { path: picked, isFolder };
});

ipcMain.handle('discord-warrant-read-media', async (event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    let buf = fs.readFileSync(filePath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    let mimeType = 'application/octet-stream';
    if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg';
    else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png';
    else if (buf.length > 7 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mimeType = 'video/mp4';
    else if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
    else {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.mp4') mimeType = 'video/mp4';
    }
    return { success: true, data: buf.toString('base64'), mimeType };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Datapilot Parser IPC ────────────────────────────────────────────

const DatapilotParser = require('./modules/datapilot/datapilot-parser');
const dpParser = new DatapilotParser();

/**
 * Scan the case Evidence tree for Datapilot folders (CSV or DPX).
 * Returns folders with their detected format for UI labeling.
 */
ipcMain.handle('datapilot-scan', async (event, { caseNumber }) => {
  try {
    const dirsToScan = [
      path.join(casesDir, caseNumber, 'Evidence'),
      path.join(casesDir, caseNumber, 'Datapilot'),
      path.join(casesDir, caseNumber)
    ];
    const seen = new Set();
    const folders = [];
    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      const found = DatapilotParser.scanForDatapilotFolders(dir, 6);
      for (const entry of found) {
        // Backward compat: scan may return string or {folderPath, format}
        const fPath = typeof entry === 'string' ? entry : entry.folderPath;
        const fmt   = typeof entry === 'string' ? (DatapilotParser.detectFormat ? DatapilotParser.detectFormat(fPath) : 'csv') : entry.format;
        if (seen.has(fPath)) continue;
        seen.add(fPath);
        folders.push({
          name: path.basename(fPath),
          path: fPath,
          parent: path.dirname(fPath),
          format: fmt || 'csv'
        });
      }
    }
    return { success: true, folders };
  } catch (error) {
    console.error('Datapilot scan error:', error);
    return { success: false, error: error.message, folders: [] };
  }
});

/**
 * Open a folder picker so the user can manually point to a Datapilot folder.
 * Accepts either a Datapilot folder directly OR any ancestor folder — in the
 * latter case we recursively scan for Datapilot exports beneath it and return
 * all candidates for the renderer to disambiguate.
 */
ipcMain.handle('datapilot-pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Datapilot Export Folder (CSV or DPX)',
    properties: ['openDirectory']
  });
  restoreFocus();
  if (result.canceled || !result.filePaths.length) return null;
  const picked = result.filePaths[0];

  // Direct hit: the picked folder itself is a Datapilot export.
  if (DatapilotParser.isDatapilotFolder(picked)) {
    const fmt = DatapilotParser.detectFormat ? DatapilotParser.detectFormat(picked) : 'csv';
    return {
      success: true,
      path: picked,
      name: path.basename(picked),
      format: fmt || 'csv',
      candidates: [{ path: picked, name: path.basename(picked), parent: path.dirname(picked), format: fmt || 'csv' }]
    };
  }

  // Indirect hit: scan beneath the picked folder for any Datapilot exports.
  let scanned = [];
  try {
    scanned = DatapilotParser.scanForDatapilotFolders(picked, 6) || [];
  } catch (e) {
    console.error('datapilot-pick-folder scan error:', e);
  }
  const candidates = scanned.map(entry => {
    const fPath = typeof entry === 'string' ? entry : entry.folderPath;
    const fmt   = typeof entry === 'string' ? (DatapilotParser.detectFormat ? DatapilotParser.detectFormat(fPath) : 'csv') : entry.format;
    return {
      path: fPath,
      name: path.basename(fPath),
      parent: path.dirname(fPath),
      format: fmt || 'csv'
    };
  });

  if (candidates.length === 0) {
    return {
      success: false,
      error: 'No Datapilot export found at or beneath the selected folder. Looking for either Summary_CaseAndAcquisitionInformation.csv (CSV format) or dptData.db (DPX format).'
    };
  }

  // Single candidate → behave like a direct pick.
  if (candidates.length === 1) {
    return {
      success: true,
      path: candidates[0].path,
      name: candidates[0].name,
      format: candidates[0].format,
      candidates
    };
  }

  // Multiple candidates → renderer presents a picker.
  return {
    success: true,
    multipleFound: true,
    candidates
  };
});

/**
 * Parse a Datapilot folder (CSV or DPX). Returns the structured data for the renderer.
 */
ipcMain.handle('datapilot-import', async (event, { folderPath }) => {
  try {
    if (!folderPath) return { success: false, error: 'No folder path provided' };
    if (!DatapilotParser.isDatapilotFolder(folderPath)) {
      return { success: false, error: 'Not a Datapilot folder (no Summary CSV or dptData.db found)' };
    }
    const data = await dpParser.parseFolder(folderPath);
    return { success: true, data };
  } catch (error) {
    console.error('Datapilot import error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Lightweight check — does a folder path exist + look like a Datapilot folder?
 * Used by the Datapilot tab's auto-scan to flag unreachable references without
 * walking the entire tree (which is what `datapilot-folder-size` does).
 */
ipcMain.handle('datapilot-folder-exists', async (event, { folderPath }) => {
  try {
    if (!folderPath) return { success: false, exists: false, isDatapilot: false };
    let exists = false;
    try { exists = fs.existsSync(folderPath); } catch (_) { exists = false; }
    let isDatapilot = false;
    if (exists) {
      try { isDatapilot = DatapilotParser.isDatapilotFolder(folderPath); } catch (_) {}
    }
    return { success: true, exists, isDatapilot };
  } catch (error) {
    return { success: false, error: error.message, exists: false, isDatapilot: false };
  }
});

/**
 * Measure total size + file count of a folder tree (synchronously walks).
 * Returns { totalBytes, fileCount }. Used to warn the user before copy.
 */
ipcMain.handle('datapilot-folder-size', async (event, { folderPath }) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder not found' };
    }
    let totalBytes = 0;
    let fileCount = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile()) {
            const st = fs.statSync(full);
            totalBytes += st.size;
            fileCount++;
          }
        } catch (_) { /* skip unreadable */ }
      }
    };
    walk(folderPath);
    return { success: true, totalBytes, fileCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Copy an entire Datapilot extraction folder into the case Evidence directory
 * so it travels with DA exports. Honors Field Security encryption.
 *
 * Reports progress via 'datapilot-copy-progress' on the sender's webContents.
 *   { phase: 'copy', filesDone, fileCount, bytesDone, totalBytes, currentFile }
 *
 * Returns { success, destPath, fileCount, totalBytes }
 */
ipcMain.handle('datapilot-copy-to-evidence', async (event, { caseNumber, evidenceTag, sourcePath }) => {
  try {
    if (!caseNumber || !evidenceTag || !sourcePath) {
      return { success: false, error: 'Missing caseNumber, evidenceTag, or sourcePath' };
    }
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: 'Source folder no longer exists: ' + sourcePath };
    }

    // Sanitize tag for filesystem use
    const safeTag = String(evidenceTag).replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/[\\/]/g, '_').trim() || `datapilot_${Date.now()}`;
    const destRoot = path.join(casesDir, caseNumber, 'Evidence', safeTag);
    fs.mkdirSync(destRoot, { recursive: true });

    // Two-pass: count first so progress UI knows the total.
    const allFiles = [];
    let totalBytes = 0;
    const collect = (dir, relBase) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const rel  = relBase ? path.join(relBase, ent.name) : ent.name;
        try {
          if (ent.isDirectory()) collect(full, rel);
          else if (ent.isFile()) {
            const st = fs.statSync(full);
            allFiles.push({ src: full, rel, size: st.size });
            totalBytes += st.size;
          }
        } catch (_) { /* skip */ }
      }
    };
    collect(sourcePath, '');

    const sender = event.sender;
    const send = (payload) => {
      try { if (sender && !sender.isDestroyed()) sender.send('datapilot-copy-progress', payload); } catch (_) {}
    };

    send({ phase: 'start', filesDone: 0, fileCount: allFiles.length, bytesDone: 0, totalBytes });

    let bytesDone = 0;
    let lastEmit = 0;
    const encryptOn = security && security.isEnabled() && security.isUnlocked();

    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      const dest = path.join(destRoot, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      if (encryptOn) {
        // Field Security: read+encrypt+write (small files only safe in memory; cap at 256MB)
        if (f.size > 256 * 1024 * 1024) {
          // Too large to encrypt in-memory — copy raw and warn
          fs.copyFileSync(f.src, dest);
        } else {
          const buf = fs.readFileSync(f.src);
          fs.writeFileSync(dest, security.encryptBuffer(buf));
        }
      } else {
        fs.copyFileSync(f.src, dest);
      }
      bytesDone += f.size;

      // Throttle progress events to ~10/s
      const now = Date.now();
      if (now - lastEmit > 100 || i === allFiles.length - 1) {
        send({
          phase: 'copy',
          filesDone: i + 1,
          fileCount: allFiles.length,
          bytesDone,
          totalBytes,
          currentFile: f.rel
        });
        lastEmit = now;
      }
    }

    send({ phase: 'done', filesDone: allFiles.length, fileCount: allFiles.length, bytesDone, totalBytes });

    return {
      success: true,
      destPath: destRoot,
      fileCount: allFiles.length,
      totalBytes
    };
  } catch (error) {
    console.error('Datapilot copy-to-evidence error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Read a media file from inside a Datapilot folder (FileSystem/, HtmlPreview/).
 * Supports Field Security decryption transparently.
 */
ipcMain.handle('datapilot-read-media', async (event, { folderPath, relativePath }) => {
  try {
    if (!folderPath || !relativePath) {
      return { success: false, error: 'Missing folderPath or relativePath' };
    }
    // Normalize and prevent path traversal
    const normRel = path.normalize(relativePath).replace(/^[\\/]+/, '');
    if (normRel.startsWith('..')) {
      return { success: false, error: 'Invalid relative path' };
    }
    const fullPath = path.join(folderPath, normRel);
    const resolvedRoot = path.resolve(folderPath);
    if (!path.resolve(fullPath).startsWith(resolvedRoot)) {
      return { success: false, error: 'Path traversal blocked' };
    }
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: 'File not found: ' + relativePath };
    }
    let buf = fs.readFileSync(fullPath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    // Detect mime from magic bytes
    let mimeType = 'application/octet-stream';
    if (buf.length > 1 && buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg';
    else if (buf.length > 1 && buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png';
    else if (buf.length > 7 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mimeType = 'video/mp4';
    else if (buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mimeType = 'image/gif';
    else if (buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) mimeType = 'image/webp';
    else {
      const ext = path.extname(fullPath).toLowerCase();
      const map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
        '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv'
      };
      if (map[ext]) mimeType = map[ext];
    }
    return {
      success: true,
      data: buf.toString('base64'),
      mimeType,
      size: buf.length,
      fileName: path.basename(fullPath)
    };
  } catch (error) {
    console.error('Datapilot read-media error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Return a streamable file:// URL for a Datapilot media file. Use this for
 * videos / audio / very large files instead of `datapilot-read-media`, which
 * base64-encodes the entire file (fine for thumbnails, terrible for a 285MB
 * video). For Field-Security-encrypted files, decrypts to a temp location
 * first and returns the temp path's file URL.
 */
ipcMain.handle('datapilot-get-media-url', async (event, { folderPath, relativePath }) => {
  try {
    if (!folderPath || !relativePath) {
      return { success: false, error: 'Missing folderPath or relativePath' };
    }
    const normRel = path.normalize(relativePath).replace(/^[\\/]+/, '');
    if (normRel.startsWith('..')) return { success: false, error: 'Invalid relative path' };
    const fullPath = path.join(folderPath, normRel);
    const resolvedRoot = path.resolve(folderPath);
    if (!path.resolve(fullPath).startsWith(resolvedRoot)) {
      return { success: false, error: 'Path traversal blocked' };
    }
    if (!fs.existsSync(fullPath)) return { success: false, error: 'File not found' };

    let servePath = fullPath;
    let isTemp = false;
    if (security && security.isUnlocked()) {
      // Sniff the first 32 bytes to detect encryption (avoid reading the whole file).
      const fd = fs.openSync(fullPath, 'r');
      const head = Buffer.alloc(64);
      try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
      if (security.isEncryptedBuffer(head)) {
        // Encrypted — must decrypt to a temp file. Read full buffer here
        // (unavoidable if encrypted), then write decrypted bytes to temp.
        const buf = fs.readFileSync(fullPath);
        const decrypted = security.decryptBuffer(buf);
        const tempDir = path.join(app.getPath('temp'), 'viper-view-datapilot');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempName = `${Date.now()}_${path.basename(fullPath)}`;
        servePath = path.join(tempDir, tempName);
        fs.writeFileSync(servePath, decrypted);
        isTemp = true;
      }
    }
    const stat = fs.statSync(servePath);
    // Issue a token-backed viper-media URL — bypasses the file:// block
    // that http://localhost renderer pages enforce, and supports byte-range
    // requests so <video> can seek without loading the whole file.
    const token = _datapilotIssueMediaToken(servePath);
    const fileUrl = `viper-media://m/${token}`;
    return { success: true, fileUrl, sizeBytes: stat.size, isTemp, fileName: path.basename(fullPath) };
  } catch (error) {
    console.error('Datapilot get-media-url error:', error);
    return { success: false, error: error.message };
  }
});


/**
 * ─── Datapilot: Export flagged items to a self-contained case bundle ──
 *
 * Writes:
 *   cases/<caseNumber>/Evidence/Datapilot/<bundleId>/
 *     ├── media/<sha>__<safeName>.<ext>   (full originals, encrypted if Field Security active)
 *     ├── thumbs/<sha>.jpg                (renderer-generated previews, encrypted likewise)
 *     ├── report.json                     (structured flag data — for in-VIPER viewer)
 *     └── report.html                     (self-contained DA-ready report w/ embedded thumbnails)
 *
 * The DA-facing HTML is produced here in main so the renderer doesn't have
 * to assemble large strings. Thumbnails are inlined as base64 so a single
 * file is enough for any browser to display the report.
 *
 * Inputs:
 *   {
 *     caseNumber:   string,
 *     bundleId:     string,         // e.g., 'dp_1730655813004'
 *     dpLabel:      string,         // e.g., 'DP-001'
 *     folderPath:   string,         // original Datapilot import folder
 *     fileName:     string,         // imp.fileName
 *     deviceInfo:   { make, model, phoneNumber, carrier, imei, serial, osVersion },
 *     summary:      { acquisitionDate, examiner, caseRef, ... },
 *     resolved:     { messages[], calls[], contacts[], media[] },
 *     thumbsByKey:  { [sha]: 'data:image/jpeg;base64,…' },
 *     generatedAt:  ISO string
 *   }
 *
 * Returns:
 *   {
 *     success: true,
 *     bundlePath: <abs>,
 *     reportJsonPath, reportHtmlPath,
 *     mediaFiles: [{ name, path, size, type, sha }],
 *     totalSize: number
 *   }
 */
ipcMain.handle('datapilot-export-flags-bundle', async (event, payload) => {
  try {
    const {
      caseNumber, bundleId, dpLabel,
      folderPath, fileName,
      deviceInfo = {}, summary = {},
      resolved = {}, thumbsByKey = {},
      generatedAt
    } = payload || {};

    if (!caseNumber || !bundleId || !folderPath) {
      return { success: false, error: 'Missing caseNumber/bundleId/folderPath' };
    }

    const bundlePath  = path.join(casesDir, caseNumber, 'Evidence', 'Datapilot', bundleId);
    const mediaDir    = path.join(bundlePath, 'media');
    const thumbsDir   = path.join(bundlePath, 'thumbs');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });

    const useEnc = security && security.isEnabled() && security.isUnlocked();
    const writeFileMaybeEncrypted = (dest, buf) => {
      fs.writeFileSync(dest, useEnc ? security.encryptBuffer(buf) : buf);
    };
    const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);

    // ── 1. Copy flagged media originals + write thumbnails ─────────────
    const mediaList   = Array.isArray(resolved.media) ? resolved.media : [];
    const mediaFiles  = [];
    let   totalSize   = 0;

    for (const m of mediaList) {
      const sha = (m.sha || m.sha256 || m.sha3 || '').toLowerCase();
      if (!sha || !m.relativePath) continue;
      // Re-use the same path-traversal protection as datapilot-read-media
      const normRel = path.normalize(m.relativePath).replace(/^[\\/]+/, '');
      if (normRel.startsWith('..')) continue;
      const srcPath = path.join(folderPath, normRel);
      const resolvedRoot = path.resolve(folderPath);
      if (!path.resolve(srcPath).startsWith(resolvedRoot)) continue;
      if (!fs.existsSync(srcPath)) continue;

      let buf = fs.readFileSync(srcPath);
      // The source folder may itself hold encrypted files when Field
      // Security has been used on the import staging area.
      if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
        buf = security.decryptBuffer(buf);
      }

      const ext  = path.extname(m.fileName || normRel) || '';
      const base = `${sha}__${safeName(path.basename(m.fileName || normRel, ext))}${ext}`;
      const destPath = path.join(mediaDir, base);
      writeFileMaybeEncrypted(destPath, buf);
      const size = buf.length;
      totalSize += size;

      // MIME by extension (good enough for the evidence card)
      const extLow = ext.toLowerCase();
      const mimeMap = {
        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
        '.webp':'image/webp','.heic':'image/heic','.heif':'image/heif',
        '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/x-m4v',
        '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac'
      };
      const mime = mimeMap[extLow] || 'application/octet-stream';

      mediaFiles.push({
        name: base,
        path: destPath,
        size,
        type: mime,
        sha
      });

      // Write thumbnail if renderer supplied one
      const thumbDataUrl = thumbsByKey[sha];
      if (thumbDataUrl && typeof thumbDataUrl === 'string') {
        const m64 = thumbDataUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (m64) {
          try {
            const tBuf = Buffer.from(m64[2], 'base64');
            writeFileMaybeEncrypted(path.join(thumbsDir, `${sha}.jpg`), tBuf);
          } catch (_) { /* non-fatal */ }
        }
      }
    }

    // ── 2. Write report.json ───────────────────────────────────────────
    const report = {
      bundleId,
      dpLabel,
      generatedAt: generatedAt || new Date().toISOString(),
      source: { fileName, folderPath },
      device: deviceInfo,
      summary,
      counts: {
        messages: (resolved.messages || []).length,
        calls:    (resolved.calls    || []).length,
        contacts: (resolved.contacts || []).length,
        media:    mediaFiles.length
      },
      messages: resolved.messages || [],
      calls:    resolved.calls    || [],
      contacts: resolved.contacts || [],
      media:    mediaList.map(m => {
        const sha = (m.sha || m.sha256 || m.sha3 || '').toLowerCase();
        const copied = mediaFiles.find(f => f.sha === sha);
        return {
          sha,
          fileName: m.fileName,
          mediaType: m.mediaType,
          lastModified: m.lastModified || '',
          sizeBytes: m.sizeBytes || (copied && copied.size) || 0,
          lat: m.lat || null, lng: m.lng || null,
          mediaRel: copied ? `media/${copied.name}` : null,
          thumbRel: thumbsByKey[sha] ? `thumbs/${sha}.jpg` : null,
          mime: copied ? copied.type : ''
        };
      })
    };
    const reportJsonPath = path.join(bundlePath, 'report.json');
    writeFileMaybeEncrypted(reportJsonPath, Buffer.from(JSON.stringify(report, null, 2), 'utf-8'));

    // ── 3. Generate self-contained report.html (DA-facing) ─────────────
    const html = _buildDatapilotReportHtml(report, thumbsByKey);
    const reportHtmlPath = path.join(bundlePath, 'report.html');
    writeFileMaybeEncrypted(reportHtmlPath, Buffer.from(html, 'utf-8'));

    return {
      success: true,
      bundlePath,
      reportJsonPath, reportHtmlPath,
      mediaFiles,
      totalSize
    };
  } catch (error) {
    console.error('datapilot-export-flags-bundle error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Read a file from inside a Datapilot evidence bundle, decrypting if needed.
 * Used by the in-VIPER Datapilot evidence viewer to fetch report.json and
 * to load thumbnails and full-size media on demand.
 *
 * Inputs: { bundlePath, relPath }
 * Returns: { success, mimeType, dataBase64, size } | { success:false, error }
 */
ipcMain.handle('datapilot-read-bundle-file', async (event, { bundlePath, relPath }) => {
  try {
    if (!bundlePath || !relPath) return { success: false, error: 'Missing bundlePath/relPath' };
    const normRel = path.normalize(relPath).replace(/^[\\/]+/, '');
    if (normRel.startsWith('..')) return { success: false, error: 'Invalid relPath' };
    const fullPath = path.join(bundlePath, normRel);
    const resolvedRoot = path.resolve(bundlePath);
    if (!path.resolve(fullPath).startsWith(resolvedRoot)) {
      return { success: false, error: 'Path traversal blocked' };
    }
    if (!fs.existsSync(fullPath)) return { success: false, error: 'Not found: ' + relPath };
    let buf = fs.readFileSync(fullPath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    const extLow = path.extname(fullPath).toLowerCase();
    const mimeMap = {
      '.json':'application/json','.html':'text/html','.txt':'text/plain',
      '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
      '.webp':'image/webp','.heic':'image/heic','.heif':'image/heif',
      '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm',
      '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'
    };
    const mimeType = mimeMap[extLow] || 'application/octet-stream';
    return { success: true, mimeType, dataBase64: buf.toString('base64'), size: buf.length };
  } catch (error) {
    console.error('datapilot-read-bundle-file error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Same as datapilot-read-bundle-file but returns a streamable viper-media://
 * URL — for full-size video/audio playback inside the in-VIPER viewer.
 */
ipcMain.handle('datapilot-bundle-media-url', async (event, { bundlePath, relPath }) => {
  try {
    if (!bundlePath || !relPath) return { success: false, error: 'Missing args' };
    const normRel = path.normalize(relPath).replace(/^[\\/]+/, '');
    if (normRel.startsWith('..')) return { success: false, error: 'Invalid relPath' };
    const fullPath = path.join(bundlePath, normRel);
    const resolvedRoot = path.resolve(bundlePath);
    if (!path.resolve(fullPath).startsWith(resolvedRoot)) {
      return { success: false, error: 'Path traversal blocked' };
    }
    if (!fs.existsSync(fullPath)) return { success: false, error: 'Not found' };

    let servePath = fullPath;
    if (security && security.isUnlocked()) {
      const fd = fs.openSync(fullPath, 'r');
      const head = Buffer.alloc(64);
      try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
      if (security.isEncryptedBuffer(head)) {
        const buf = fs.readFileSync(fullPath);
        const decrypted = security.decryptBuffer(buf);
        const tempDir = path.join(app.getPath('temp'), 'viper-view-datapilot-bundle');
        fs.mkdirSync(tempDir, { recursive: true });
        servePath = path.join(tempDir, `${Date.now()}_${path.basename(fullPath)}`);
        fs.writeFileSync(servePath, decrypted);
      }
    }
    const stat = fs.statSync(servePath);
    const token = _datapilotIssueMediaToken(servePath);
    return { success: true, fileUrl: `viper-media://m/${token}`, sizeBytes: stat.size };
  } catch (error) {
    console.error('datapilot-bundle-media-url error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Build a self-contained HTML report from the structured bundle data.
 * Embeds all thumbnails as base64 so the file works offline without the
 * media/ folder. Full-size links point at the relative media/ paths so
 * a DA opening the file from inside the exported ZIP can click through.
 */
function _buildDatapilotReportHtml(report, thumbsByKey) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDate = (s) => {
    if (!s) return '';
    try { const d = new Date(s); if (!isNaN(d)) return d.toLocaleString(); } catch(_){}
    return s;
  };
  const fmtBytes = (n) => {
    if (!n || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };

  const dev = report.device || {};
  const counts = report.counts || {};

  const messagesHtml = (report.messages || []).map(m => {
    const dirLabel = m.direction === 'outgoing' ? 'SENT' : (m.direction === 'incoming' ? 'RECEIVED' : 'UNKNOWN');
    const dirCls = m.direction === 'outgoing' ? 'msg-out' : (m.direction === 'incoming' ? 'msg-in' : 'msg-unk');
    return `
      <div class="msg ${dirCls}">
        <div class="msg-head">
          <span class="msg-dir">${esc(dirLabel)}</span>
          <span class="msg-addr">${esc(m.contactName ? `${m.contactName} (${m.address || ''})` : (m.address || ''))}</span>
          <span class="msg-time">${esc(fmtDate(m.timestampIso || m.timestamp))}</span>
        </div>
        <div class="msg-text">${esc(m.text || '(empty)')}</div>
        ${m.type ? `<div class="msg-meta">${esc(m.type)}</div>` : ''}
      </div>
    `;
  }).join('');

  const callsHtml = (report.calls || []).map(c => `
    <tr>
      <td>${esc(c.direction || 'unknown')}</td>
      <td>${esc(c.contactName || '')}</td>
      <td class="mono">${esc(c.address || c.number || '')}</td>
      <td>${esc(fmtDate(c.timestampIso || c.timestamp))}</td>
      <td>${esc(c.duration ? `${c.duration}s` : '')}</td>
      <td>${esc(c.summary || c.deletedData || '')}</td>
    </tr>
  `).join('');

  const contactsHtml = (report.contacts || []).map(c => `
    <div class="contact-card">
      <div class="contact-name">${esc(c.name || '(unknown)')}</div>
      ${(c.phones || []).map(p => `<div class="contact-row mono">${esc(p)}</div>`).join('')}
      ${(c.emails || []).map(e => `<div class="contact-row">${esc(e)}</div>`).join('')}
      ${c.notes ? `<div class="contact-notes">${esc(c.notes)}</div>` : ''}
    </div>
  `).join('');

  const mediaHtml = (report.media || []).map(m => {
    const sha = (m.sha || '').toLowerCase();
    const thumb = thumbsByKey[sha];  // base64 dataURL
    const fullLink = m.mediaRel ? `<a class="media-open" href="${esc(m.mediaRel)}" target="_blank">Open original</a>` : '';
    const meta = [
      m.mediaType,
      fmtDate(m.lastModified),
      fmtBytes(m.sizeBytes),
      (m.lat != null && m.lng != null) ? `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}` : ''
    ].filter(Boolean).map(esc).join(' · ');
    return `
      <div class="media-card">
        <div class="media-thumb">
          ${thumb ? `<img src="${esc(thumb)}" alt="${esc(m.fileName)}"/>` : `<div class="no-thumb">${esc((m.mediaType || 'file').toUpperCase())}</div>`}
        </div>
        <div class="media-meta">
          <div class="media-name">${esc(m.fileName || sha)}</div>
          <div class="media-sub">${meta}</div>
          ${fullLink}
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>Datapilot Evidence Report — ${esc(report.source && report.source.fileName || report.bundleId || '')}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 28px 36px; background: #f7f8fa; color: #111827;
    line-height: 1.45;
  }
  h1 { font-size: 22px; margin: 0 0 6px; color: #0e7490; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #d1d5db; color: #111827; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 18px; }
  .device-card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px 24px; font-size: 13px;
  }
  .device-card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  .device-card .value { font-weight: 500; }
  .stats { display: flex; gap: 18px; margin: 12px 0 22px; }
  .stat-pill { background: #0e7490; color: #fff; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 600; }

  .msg { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
  .msg-out { border-left: 4px solid #0e7490; }
  .msg-in  { border-left: 4px solid #f59e0b; }
  .msg-unk { border-left: 4px solid #9ca3af; }
  .msg-head { display: flex; gap: 10px; align-items: baseline; font-size: 11px; flex-wrap: wrap; margin-bottom: 4px; }
  .msg-dir { font-weight: 700; color: #0e7490; letter-spacing: 0.05em; }
  .msg-in .msg-dir { color: #b45309; }
  .msg-unk .msg-dir { color: #6b7280; }
  .msg-addr { font-family: ui-monospace, "Menlo", monospace; color: #374151; }
  .msg-time { margin-left: auto; color: #6b7280; }
  .msg-text { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg-meta { font-size: 10px; color: #9ca3af; margin-top: 4px; text-transform: uppercase; }

  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; }
  th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, "Menlo", monospace; font-size: 12px; }

  .contact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .contact-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
  .contact-name { font-weight: 600; margin-bottom: 4px; }
  .contact-row { font-size: 12px; color: #374151; }
  .contact-notes { margin-top: 6px; font-size: 12px; color: #6b7280; font-style: italic; }

  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .media-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .media-thumb { background: #111827; display: flex; align-items: center; justify-content: center; height: 160px; }
  .media-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .no-thumb { color: #9ca3af; font-size: 11px; letter-spacing: 0.1em; }
  .media-meta { padding: 8px 10px; font-size: 12px; }
  .media-name { font-weight: 600; word-break: break-all; margin-bottom: 4px; }
  .media-sub { color: #6b7280; font-size: 11px; margin-bottom: 6px; }
  .media-open { color: #0e7490; text-decoration: none; font-size: 12px; font-weight: 600; }
  .media-open:hover { text-decoration: underline; }

  .empty { color: #9ca3af; font-size: 13px; padding: 12px; background: #fff; border: 1px dashed #d1d5db; border-radius: 8px; text-align: center; }
  @media print {
    body { background: #fff; padding: 0.5in; }
    .media-card, .msg, table, .device-card, .contact-card { break-inside: avoid; }
  }
</style>
</head><body>

<h1>Datapilot Evidence Report</h1>
<div class="sub">
  ${esc(report.dpLabel || '')} ·
  Source: ${esc(report.source && report.source.fileName || '')} ·
  Generated: ${esc(fmtDate(report.generatedAt))}
</div>

<h2>Device & Owner</h2>
<div class="device-card">
  ${[
    ['Make', dev.make], ['Model', dev.model],
    ['Phone Number', dev.phoneNumber], ['Carrier', dev.carrier],
    ['IMEI', dev.imei], ['Serial', dev.serial],
    ['OS', dev.osVersion],
    ['Acquisition', report.summary && (report.summary.acquisitionDate || report.summary.created)],
    ['Examiner', report.summary && report.summary.examiner],
    ['Case Ref', report.summary && report.summary.caseRef]
  ].map(([l,v]) => `
    <div>
      <div class="label">${esc(l)}</div>
      <div class="value">${esc(v || '—')}</div>
    </div>
  `).join('')}
</div>

<div class="stats">
  <span class="stat-pill">${counts.messages || 0} messages</span>
  <span class="stat-pill">${counts.calls || 0} calls</span>
  <span class="stat-pill">${counts.media || 0} media</span>
  <span class="stat-pill">${counts.contacts || 0} contacts</span>
</div>

<h2>Flagged Messages (${counts.messages || 0})</h2>
${messagesHtml || '<div class="empty">No messages flagged.</div>'}

<h2>Flagged Calls (${counts.calls || 0})</h2>
${callsHtml ? `<table><thead><tr>
  <th>Direction</th><th>Contact</th><th>Number</th><th>Timestamp</th><th>Duration</th><th>Summary</th>
</tr></thead><tbody>${callsHtml}</tbody></table>` : '<div class="empty">No calls flagged.</div>'}

<h2>Flagged Media (${counts.media || 0})</h2>
${mediaHtml ? `<div class="media-grid">${mediaHtml}</div>` : '<div class="empty">No media flagged.</div>'}

<h2>Flagged Contacts (${counts.contacts || 0})</h2>
${contactsHtml ? `<div class="contact-grid">${contactsHtml}</div>` : '<div class="empty">No contacts flagged.</div>'}

</body></html>`;
}

// ════════════════════════════════════════════════════════════════════════
// Generic Warrant Flag-to-Evidence Bundle System
// Mirrors the Datapilot push-to-evidence pipeline but parameterized by
// moduleSlug + sectionConfigs so all 6 warrant parsers (Discord, Google,
// Meta, KIK, Snapchat, Aperture) can share one backend.
// ════════════════════════════════════════════════════════════════════════

/**
 * Push flagged warrant items to the case Evidence module as a self-contained
 * bundle. Writes structured report.json + DA-ready report.html into
 * cases/<caseNumber>/Evidence/<ModuleFolder>/<bundleId>/.
 */
ipcMain.handle('warrant-export-flags-bundle', async (event, payload) => {
  try {
    const {
      caseNumber, bundleId,
      moduleSlug, moduleLabel, moduleFolder, bundleLabel,
      sourceFileName, subjectInfo = {},
      sectionConfigs = [],
      sections = {},
      generatedAt
    } = payload || {};

    if (!caseNumber || !bundleId || !moduleSlug || !moduleFolder) {
      return { success: false, error: 'Missing caseNumber/bundleId/moduleSlug/moduleFolder' };
    }

    const safeModuleFolder = String(moduleFolder).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 60);
    const safeBundleId     = String(bundleId).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
    const bundlePath = path.join(casesDir, caseNumber, 'Evidence', safeModuleFolder, safeBundleId);
    fs.mkdirSync(bundlePath, { recursive: true });

    const useEnc = security && security.isEnabled() && security.isUnlocked();
    const writeFileMaybeEncrypted = (dest, buf) => {
      fs.writeFileSync(dest, useEnc ? security.encryptBuffer(buf) : buf);
    };

    let totalItems = 0;
    const counts = {};
    for (const cfg of sectionConfigs) {
      const arr = Array.isArray(sections[cfg.id]) ? sections[cfg.id] : [];
      counts[cfg.id] = arr.length;
      totalItems += arr.length;
    }

    const report = {
      bundleId,
      bundleLabel,
      moduleSlug,
      moduleLabel,
      generatedAt: generatedAt || new Date().toISOString(),
      source: { fileName: sourceFileName || '' },
      subjectInfo,
      sectionConfigs,
      sections,
      counts,
      totalItems
    };
    const reportJsonPath = path.join(bundlePath, 'report.json');
    writeFileMaybeEncrypted(reportJsonPath, Buffer.from(JSON.stringify(report, null, 2), 'utf-8'));

    const html = _buildWarrantReportHtml(report);
    const reportHtmlPath = path.join(bundlePath, 'report.html');
    writeFileMaybeEncrypted(reportHtmlPath, Buffer.from(html, 'utf-8'));

    return {
      success: true,
      bundlePath,
      reportJsonPath,
      reportHtmlPath,
      totalItems,
      counts
    };
  } catch (error) {
    console.error('warrant-export-flags-bundle error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('warrant-read-bundle-file', async (event, { bundlePath, relPath }) => {
  try {
    if (!bundlePath || !relPath) return { success: false, error: 'Missing bundlePath/relPath' };
    const normRel = path.normalize(relPath).replace(/^[\\/]+/, '');
    if (normRel.startsWith('..')) return { success: false, error: 'Invalid relPath' };
    const fullPath = path.join(bundlePath, normRel);
    const resolvedRoot = path.resolve(bundlePath);
    if (!path.resolve(fullPath).startsWith(resolvedRoot)) {
      return { success: false, error: 'Path traversal blocked' };
    }
    if (!fs.existsSync(fullPath)) return { success: false, error: 'Not found: ' + relPath };
    let buf = fs.readFileSync(fullPath);
    if (security && security.isUnlocked() && security.isEncryptedBuffer(buf)) {
      buf = security.decryptBuffer(buf);
    }
    const extLow = path.extname(fullPath).toLowerCase();
    const mimeMap = { '.json':'application/json','.html':'text/html','.txt':'text/plain' };
    const mimeType = mimeMap[extLow] || 'application/octet-stream';
    return { success: true, mimeType, dataBase64: buf.toString('base64'), size: buf.length };
  } catch (error) {
    console.error('warrant-read-bundle-file error:', error);
    return { success: false, error: error.message };
  }
});

function _buildWarrantReportHtml(report) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDate = (s) => {
    if (!s) return '';
    try { const d = new Date(s); if (!isNaN(d)) return d.toLocaleString(); } catch(_){}
    return s;
  };

  const fmtCell = (val, type) => {
    if (val == null || val === '') return '<span class="empty-cell">—</span>';
    if (Array.isArray(val)) return val.map(v => esc(v)).join('<br>');
    if (type === 'date') return esc(fmtDate(val));
    if (type === 'mono') return `<code>${esc(val)}</code>`;
    if (type === 'longtext') {
      const s = String(val);
      return `<div class="longtext">${esc(s).replace(/\n/g, '<br>')}</div>`;
    }
    if (type === 'pre') {
      let s = val;
      if (typeof s !== 'string') {
        try { s = JSON.stringify(s, null, 2); } catch(_) { s = String(s); }
      }
      return `<pre class="pre-cell">${esc(s)}</pre>`;
    }
    return esc(val);
  };

  const renderSection = (cfg) => {
    const items = Array.isArray(report.sections[cfg.id]) ? report.sections[cfg.id] : [];
    const title = `${cfg.icon ? cfg.icon + ' ' : ''}${esc(cfg.title || cfg.id)}`;
    if (!items.length) {
      return `<h2>${title} <span class="count">(0)</span></h2>
        <div class="empty">${esc(cfg.emptyText || 'No items flagged.')}</div>`;
    }
    const cols = Array.isArray(cfg.columns) ? cfg.columns : [];
    const hint = cfg.renderHint || (cols.length ? 'table' : 'pre');

    if (hint === 'messages') {
      const timeF = (cols.find(c => c.type === 'date') || {}).field;
      const authorF = (cols.find(c => /author|from|sender|address/i.test(c.label || c.field || '')) || {}).field;
      const bodyF = (cols.find(c => c.type === 'longtext') || cols[cols.length-1] || {}).field;
      const idF = (cols.find(c => /id$/i.test(c.field || '')) || {}).field;
      const attachF = (cols.find(c => /attach/i.test((c.label || '') + ' ' + (c.field || ''))) || {}).field;
      const attKind = (url) => {
        const p = String(url).split('?')[0].toLowerCase();
        const m = p.match(/\.([a-z0-9]+)$/);
        const ext = m ? m[1] : '';
        if (['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return 'image';
        if (['mp4','webm','mov','m4v','mkv','avi'].includes(ext)) return 'video';
        if (['mp3','wav','ogg','m4a','aac','flac','opus'].includes(ext)) return 'audio';
        return 'link';
      };
      const renderAtts = (txt) => {
        const s = String(txt || '');
        const urls = s.split(/\s+/).filter(Boolean).filter(u => /^https?:\/\//i.test(u));
        if (!urls.length) return '';
        return `<div class="msg-attach">` + urls.map(u => {
          const k = attKind(u);
          const fname = (u.split('?')[0].split('/').pop()) || u;
          if (k === 'image') return `<div class="att att-img"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(fname)}" loading="lazy"/></a><div class="att-cap">📎 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(fname)}</a></div></div>`;
          if (k === 'video') return `<div class="att att-video"><video controls preload="metadata" src="${esc(u)}"></video><div class="att-cap">🎬 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(fname)}</a></div></div>`;
          if (k === 'audio') return `<div class="att att-audio"><audio controls preload="metadata" src="${esc(u)}"></audio><div class="att-cap">🔊 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(fname)}</a></div></div>`;
          return `<div class="att att-link">📎 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(fname)}</a></div>`;
        }).join('') + `</div>`;
      };
      const html = items.map(item => `
        <div class="msg">
          <div class="msg-head">
            ${authorF ? `<span class="msg-author">${esc(item[authorF] || '')}</span>` : ''}
            ${timeF ? `<span class="msg-time">${esc(fmtDate(item[timeF]))}</span>` : ''}
            ${idF ? `<span class="msg-id"><code>${esc(item[idF] || '')}</code></span>` : ''}
          </div>
          <div class="msg-body">${esc(item[bodyF] || '').replace(/\n/g, '<br>') || '<em class="muted">(no body)</em>'}</div>
          ${attachF && item[attachF] ? renderAtts(item[attachF]) : ''}
        </div>
      `).join('');
      return `<h2>${title} <span class="count">(${items.length})</span></h2>${html}`;
    }

    if (hint === 'cards') {
      const html = items.map(item => `
        <div class="warrant-card">
          ${cols.map(c => {
            const v = item[c.field];
            if (v == null || v === '') return '';
            return `<div class="kv-row">
              <div class="kv-label">${esc(c.label)}</div>
              <div class="kv-value">${fmtCell(v, c.type)}</div>
            </div>`;
          }).join('')}
        </div>
      `).join('');
      return `<h2>${title} <span class="count">(${items.length})</span></h2>
        <div class="card-grid">${html}</div>`;
    }

    if (hint === 'pre') {
      const html = items.map(item => `<pre class="pre-cell">${esc(JSON.stringify(item, null, 2))}</pre>`).join('');
      return `<h2>${title} <span class="count">(${items.length})</span></h2>${html}`;
    }

    const head = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
    const rows = items.map(item => `<tr>${cols.map(c => `<td>${fmtCell(item[c.field], c.type)}</td>`).join('')}</tr>`).join('');
    return `<h2>${title} <span class="count">(${items.length})</span></h2>
      <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  };

  const subjectRows = Object.entries(report.subjectInfo || {})
    .filter(([_, v]) => v != null && v !== '')
    .map(([k, v]) => `
      <div>
        <div class="label">${esc(k)}</div>
        <div class="value">${esc(v)}</div>
      </div>
    `).join('');

  const countsBar = (report.sectionConfigs || [])
    .filter(c => (report.counts || {})[c.id] > 0)
    .map(c => `<span class="stat-pill">${(report.counts[c.id] || 0).toLocaleString()} ${esc(c.title)}</span>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<title>${esc(report.moduleLabel || 'Warrant')} Evidence Report — ${esc(report.bundleLabel || report.bundleId || '')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 28px 36px; background: #f7f8fa; color: #111827; line-height: 1.45; }
  h1 { font-size: 22px; margin: 0 0 6px; color: #0e7490; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #d1d5db; color: #111827; display:flex; align-items:baseline; gap:8px; }
  h2 .count { font-size: 12px; font-weight: 500; color: #6b7280; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 18px; }
  .subject-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 24px; font-size: 13px; }
  .subject-card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  .subject-card .value { font-weight: 500; word-break: break-word; }
  .stats { display: flex; gap: 10px; margin: 12px 0 22px; flex-wrap: wrap; }
  .stat-pill { background: #0e7490; color: #fff; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; }
  th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  tr:last-child td { border-bottom: none; }
  td code, code { font-family: ui-monospace, "Menlo", monospace; font-size: 12px; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
  .empty-cell { color: #d1d5db; }
  .longtext { white-space: pre-wrap; word-break: break-word; max-width: 600px; }
  .pre-cell { background: #f3f4f6; padding: 8px 10px; border-radius: 4px; font-size: 11px; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .msg { background: #fff; border: 1px solid #e5e7eb; border-left: 4px solid #0e7490; border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
  .msg-head { display: flex; gap: 10px; align-items: baseline; font-size: 11px; flex-wrap: wrap; margin-bottom: 4px; }
  .msg-author { font-weight: 700; color: #0e7490; }
  .msg-time { margin-left: auto; color: #6b7280; }
  .msg-id { font-size: 10px; color: #9ca3af; }
  .msg-body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg-attach { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e5e7eb; display: flex; flex-wrap: wrap; gap: 8px; }
  .att { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px; max-width: 320px; }
  .att-img img { display: block; max-width: 100%; max-height: 240px; height: auto; border-radius: 4px; }
  .att-video video, .att-audio audio { display: block; width: 100%; max-width: 320px; border-radius: 4px; }
  .att-audio audio { height: 36px; }
  .att-link { padding: 8px 10px; word-break: break-all; }
  .att-cap { margin-top: 4px; font-size: 11px; color: #6b7280; word-break: break-all; line-height: 1.3; }
  .att-cap a, .att-link a { color: #0e7490; }
  .muted { color: #9ca3af; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  .warrant-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
  .kv-row { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px dashed #e5e7eb; font-size: 12px; }
  .kv-row:last-child { border-bottom: none; }
  .kv-label { font-weight: 600; color: #6b7280; min-width: 110px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
  .kv-value { flex: 1; word-break: break-word; }
  .empty { color: #9ca3af; font-size: 13px; padding: 12px; background: #fff; border: 1px dashed #d1d5db; border-radius: 8px; text-align: center; }
  @media print { body { background: #fff; padding: 0.5in; } .warrant-card, .msg, table, .subject-card { break-inside: avoid; } }
</style>
</head><body>

<h1>${esc(report.moduleLabel || 'Warrant')} Evidence Report</h1>
<div class="sub">
  ${esc(report.bundleLabel || report.bundleId)}${report.source && report.source.fileName ? ` · Source: ${esc(report.source.fileName)}` : ''}
  · Generated: ${esc(fmtDate(report.generatedAt))}
</div>

${subjectRows ? `<h2>Subject &amp; Account</h2>
<div class="subject-card">${subjectRows}</div>` : ''}

${countsBar ? `<div class="stats">${countsBar}</div>` : ''}

${(report.sectionConfigs || []).map(renderSection).join('\n')}

<div class="sub" style="margin-top:30px;border-top:1px solid #e5e7eb;padding-top:12px;">
  Generated by Project VIPER · ${esc(report.moduleLabel || 'Warrant')} Module · Bundle ${esc(report.bundleId)}
</div>

</body></html>`;
}
