const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, globalShortcut, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const { spawn } = require('child_process');
const os = require('os');
const SecurityManager = require('./modules/security');

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

  // Gate on security — show login page or main app
  if (security && security.isEnabled()) {
    mainWindow.loadURL('http://localhost:8000/security-login.html');
  } else {
    mainWindow.loadURL('http://localhost:8000/case-detail-with-analytics.html');
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
    // Initialize security manager (uses userData for config + vault)
    const secDir = app.getPath('userData');
    if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });
    security = new SecurityManager(secDir);
    console.log('Security:', security.isEnabled() ? 'ENABLED (locked)' : 'disabled');

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

    // On page navigation, detach resource-hub BrowserViews so they can't steal clicks
    // on the next page. Media player is handled by its own show/hide via reportBounds().
    mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace) => {
      if (isInPlace) return; // ignore hash/pushState navigations
      const pageViews = [flockBrowserView, tloBrowserView, accurintBrowserView];
      for (const bv of pageViews) {
        if (!bv) continue;
        try { mainWindow.removeBrowserView(bv); } catch (_) {}
        bv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
      flockViewVisible = false;
      tloViewVisible = false;
      accurintViewVisible = false;
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
  if (!autoUpdater) return;
  const path = require('path');
  const fs = require('fs');
  const { shell } = require('electron');

  // 1) Use the path captured from the update-downloaded event
  let installerPath = autoUpdater._downloadedInstallerPath || null;
  console.log('update-install: downloadedInstallerPath =', installerPath);

  // 2) Fallback: search multiple possible cache locations
  if (!installerPath || !fs.existsSync(installerPath)) {
    const localAppData = process.env.LOCALAPPDATA;
    const possibleCaches = [];
    if (localAppData) {
      possibleCaches.push(path.join(localAppData, 'viper-electron-updater'));
    }
    try { possibleCaches.push(path.join(app.getPath('userData'), '..', '..', 'Local', 'viper-electron-updater')); } catch (_) {}
    try { possibleCaches.push(path.join(app.getPath('temp'), 'viper-electron-updater')); } catch (_) {}

    for (const cachePath of possibleCaches) {
      try {
        const files = fs.readdirSync(cachePath);
        console.log('update-install: scanning', cachePath, '→', files);
        const exe = files.find(f => f.endsWith('.exe') && f.toLowerCase().includes('v.i.p.e.r'));
        if (exe) {
          installerPath = path.join(cachePath, exe);
          break;
        }
      } catch (_) {}
    }
  }

  if (installerPath && fs.existsSync(installerPath)) {
    // Use shell.openPath — this triggers UAC elevation properly
    console.log('Launching installer via shell.openPath:', installerPath);
    const err = await shell.openPath(installerPath);
    if (err) {
      console.error('shell.openPath failed:', err, '— falling back to quitAndInstall');
      autoUpdater.quitAndInstall(false, true);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    }
    // Give the installer time to start before quitting
    await new Promise(resolve => setTimeout(resolve, 2000));
    app.quit();
  } else {
    console.log('No installer found in any cache, using standard quitAndInstall');
    autoUpdater.quitAndInstall(false, true);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
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
  return { success: true, recoveryKey };
});

ipcMain.handle('security-unlock', async (event, { password }) => {
  const success = security.unlock(password);
  if (!success) return { success: false, vaultData: null };
  // Decrypt vault and return localStorage snapshot
  let vaultData = null;
  try {
    const raw = security.decryptVault();
    if (raw) vaultData = JSON.parse(raw);
  } catch (e) { console.error('Vault decrypt:', e.message); }
  return { success: true, vaultData };
});

ipcMain.handle('security-recover', async (event, { recoveryKey }) => {
  const success = security.recover(recoveryKey);
  if (!success) return { success: false, vaultData: null };
  let vaultData = null;
  try {
    const raw = security.decryptVault();
    if (raw) vaultData = JSON.parse(raw);
  } catch (e) { console.error('Vault decrypt:', e.message); }
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
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('security-navigate-app', async () => {
  // Called after successful unlock/setup to navigate to main app
  if (mainWindow) {
    mainWindow.loadURL('http://localhost:8000/case-detail-with-analytics.html');
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

ipcMain.handle('security-lock', async () => {
  // Lock master key and navigate back to login page
  if (security) security.lock();
  if (mainWindow) {
    mainWindow.loadURL('http://localhost:8000/security-login.html');
  }
  return { success: true };
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
    const { caseNumber, subfolder, fileName, fileData } = data;
    // subfolder: 'Signed', 'Production', or 'CourtReturn'
    const warrantDir = path.join(casesDir, caseNumber, 'Warrants', subfolder);
    fs.mkdirSync(warrantDir, { recursive: true });

    const filePath = path.join(warrantDir, fileName);
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

// --- Select ZIP archive for warrant production uploads ---
ipcMain.handle('select-production-zip', async (event, { caseNumber }) => {
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

  const files = [];
  for (const srcPath of result.filePaths) {
    const fileName = path.basename(srcPath);
    const destPath = path.join(warrantDir, fileName);
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

ipcMain.handle('resolve-warrant-path', async (event, { caseNumber, subfolder, fileName }) => {
  const warrantDir = path.join(casesDir, caseNumber, 'Warrants', subfolder);
  // Try exact filename first
  if (fileName) {
    const filePath = path.join(warrantDir, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  // Fallback: scan directory for any file (handles missing/mismatched fileName)
  try {
    if (fs.existsSync(warrantDir)) {
      const files = fs.readdirSync(warrantDir).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        console.log('resolve-warrant-path: found', files[0], 'in', warrantDir);
        return path.join(warrantDir, files[0]);
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
