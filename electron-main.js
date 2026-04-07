const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, globalShortcut, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const { spawn } = require('child_process');
const SecurityManager = require('./modules/security');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let server;
let apertureProcess = null;
let security = null;
let isQuitting = false;
let mediaPlayerWindow = null;
let mediaBrowserView = null;
let mediaViewVisible = false;
let lastMediaBounds = null;

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
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'VIPER - Network Intelligence',
    icon: iconPath,
    show: false,
    backgroundColor: '#1a1a1a'
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
    mainWindow.addBrowserView(mediaBrowserView);
    mediaBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden
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
autoUpdater.autoDownload = false;          // user must click "Download"
autoUpdater.autoInstallOnAppQuit = false;  // user must click "Install & Restart"
autoUpdater.allowDowngrade = false;

function sendUpdateStatus(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

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

// Renderer requests: check → download → install+restart
ipcMain.handle('update-check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-install', () => {
  // quitAndInstall runs the NSIS installer which uses installer.nsh
  // to backup userdata/ and cases/ before replacing files, then restores them.
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
});

// --- Backup & Restore ---
ipcMain.handle('select-backup-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup Destination',
    properties: ['openDirectory']
  });
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

ipcMain.handle('select-backup-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup File to Restore',
    properties: ['openFile'],
    filters: [{ name: 'VIPER Backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('restore-backup', async (event, { backupPath }) => {
  const raw = fs.readFileSync(backupPath);
  // Decrypt backup if it's encrypted
  if (security && security.isUnlocked() && security.isEncryptedBuffer(raw)) {
    return security.decryptBuffer(raw).toString('utf-8');
  }
  return raw.toString('utf-8');
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
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
});

ipcMain.handle('extract-pdf-text', async (event, filePath) => {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return {
      text: data.text,
      numPages: data.numpages,
      info: data.info || {},
      fileName: path.basename(filePath)
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
  if (result.canceled || !result.filePath) return null;

  // Collect evidence files for this case
  const evidenceBase = path.join(casesDir, caseNumber, 'Evidence');
  const evidenceFiles = [];
  if (fs.existsSync(evidenceBase)) {
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
          evidenceFiles.push({ name: relPath, data: buf });
        }
      }
    };
    walkDir(evidenceBase, '');
  }

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
    return exportDir;
  }
});

ipcMain.handle('open-case-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Case Package',
    properties: ['openFile'],
    filters: [
      { name: 'VIPER Files', extensions: ['vcase', 'json'] },
      { name: 'VIPER Case Package', extensions: ['vcase'] },
      { name: 'VIPER Backup', extensions: ['json'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const raw = fs.readFileSync(result.filePaths[0]);
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
    if (security && security.isUnlocked() && fs.existsSync(filePath)) {
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
    mediaBrowserView.setBounds(lastMediaBounds);
  } else if (!visible) {
    mediaBrowserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
});
