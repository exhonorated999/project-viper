const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, globalShortcut, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const { spawn } = require('child_process');
const SecurityManager = require('./modules/security');

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
      console.log(`Request: ${req.url}`);
      
      let filePath = path.join(__dirname, req.url);
      if (req.url === '/') {
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
    show: true,
    backgroundColor: '#1a1a1a'
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

app.whenReady().then(async () => {
  try {
    // Initialize security manager (uses userData for config + vault)
    const secDir = app.getPath('userData');
    if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });
    security = new SecurityManager(secDir);
    console.log('Security:', security.isEnabled() ? 'ENABLED (locked)' : 'disabled');

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
    casesDir: path.join(__dirname, 'cases'),
    userData: app.getPath('userData')
  };
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
  fs.writeFileSync(filePath, data, 'utf-8');
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
  const data = fs.readFileSync(backupPath, 'utf-8');
  return data;
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
    const casesDir = path.join(__dirname, 'cases', caseNumber, 'Evidence', evidenceTag);
    fs.mkdirSync(casesDir, { recursive: true });

    const filePath = path.join(casesDir, fileName);
    const buffer = Buffer.from(fileData);
    fs.writeFileSync(filePath, buffer);

    console.log(`Evidence saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (error) {
    console.error('Failed to save evidence file:', error);
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
const apertureData = new ApertureData(path.join(__dirname, 'cases'));

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
    const outDir = path.join(__dirname, 'cases', caseId, 'aperture');
    fs.mkdirSync(outDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `Aperture_Report_${timestamp}.html`;
    const outPath = path.join(outDir, fileName);

    fs.writeFileSync(outPath, html, 'utf-8');
    await shell.openPath(outPath);

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
