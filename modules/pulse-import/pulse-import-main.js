// pulse-import-main.js — Electron main-process IPC for PULSE (.pulse) import.
// =====================================================================
// Wires the dependency-light translator (pulse-import-core.js) into VIPER:
//   • pulse-pick-file   → native open dialog, returns a .pulse path
//   • pulse-validate    → decrypt + read manifest, report case info + collisions
//   • pulse-import      → translate → write encrypted snapshot → extract files
// Snapshot encryption follows the same Field Security pattern as
// save-case-snapshot. Extracted case files are written plaintext, mirroring
// PULSE's on-disk layout under cases/<caseNumber>/<subtree>.
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./pulse-import-core');

let _security = null;
let _mainWindow = null;
let _getCasesDir = null;

function setSecurityManager(sec) { _security = sec; }
function setMainWindow(win) { _mainWindow = win; }
function setCasesDirGetter(fn) { _getCasesDir = fn; }

function getWin() {
  if (_mainWindow && !_mainWindow.isDestroyed()) return _mainWindow;
  try {
    const { BrowserWindow } = require('electron');
    return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  } catch (_) { return null; }
}

function casesDir() {
  if (typeof _getCasesDir === 'function') return _getCasesDir();
  throw new Error('PulseImport: casesDir getter not set');
}

function safeCaseNumber(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.indexOf('..') !== -1 || s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return null;
  return s;
}

// Guard an extracted file's relative path against traversal / absolute paths.
function safeRel(rel) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.split('/').some(seg => seg === '..' || seg === '')) return null;
  if (/^[a-zA-Z]:/.test(norm)) return null; // drive-absolute
  return norm;
}

function progress(step, current, total, message) {
  try {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send('pulse-import-progress', { step, current, total, message });
    }
  } catch (_) { /* non-fatal */ }
}

function writeSnapshotFile(caseNumber, snapshotObj) {
  const dir = path.join(casesDir(), caseNumber);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '.case-snapshot.json');
  const buf = Buffer.from(JSON.stringify(snapshotObj), 'utf8');
  if (_security && _security.isEnabled() && _security.isUnlocked()) {
    fs.writeFileSync(filePath, _security.encryptBuffer(buf));
  } else {
    fs.writeFileSync(filePath, buf);
  }
  return filePath;
}

function caseExists(caseNumber) {
  try {
    return fs.existsSync(path.join(casesDir(), caseNumber, '.case-snapshot.json'));
  } catch (_) { return false; }
}

// Decrypt + read manifest; report case info + whether it already exists.
async function validatePulse(args) {
  try {
    const { filePath, password } = args || {};
    if (!filePath || !fs.existsSync(filePath)) return { valid: false, error: 'File not found.' };
    if (!password) return { valid: false, error: 'Password required.' };
    const buf = fs.readFileSync(filePath);
    const { manifest } = core.openPulse(buf, password);
    const em = manifest.export_metadata || {};
    const caseNumber = safeCaseNumber(em.case_number || (manifest.data && manifest.data.case && manifest.data.case.case_number));
    if (!caseNumber) return { valid: false, error: 'Manifest has an invalid case number.' };
    return {
      valid: true,
      caseNumber,
      pulseVersion: em.pulse_version || '',
      exportDate: em.export_date || '',
      exportingOfficer: em.exporting_officer || '',
      caseType: (manifest.data && manifest.data.case && manifest.data.case.case_type) || '',
      fileCount: Array.isArray(manifest.file_inventory) ? manifest.file_inventory.length : 0,
      alreadyExists: caseExists(caseNumber)
    };
  } catch (e) {
    return { valid: false, error: e.message || 'Validation failed.' };
  }
}

// Full import: translate → snapshot → extract files.
async function importPulse(args) {
  const { filePath, password, overwrite } = args || {};
  try {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found.' };
    if (!password) return { success: false, error: 'Password required.' };

    progress('opening', 1, 5, 'Decrypting PULSE export…');
    const buf = fs.readFileSync(filePath);
    const { zip, manifest } = core.openPulse(buf, password);

    progress('translating', 2, 5, 'Translating case data…');
    const result = core.translate(zip, manifest, { casesDir: casesDir() });
    const caseNumber = safeCaseNumber(result.caseNumber);
    if (!caseNumber) return { success: false, error: 'Invalid case number in export.' };

    if (caseExists(caseNumber) && !overwrite) {
      return { success: false, needsConfirm: true, reason: 'exists', caseNumber,
               error: `A case ${caseNumber} already exists in VIPER.` };
    }

    // Write the snapshot first (this is what recover() ingests).
    progress('snapshot', 3, 5, 'Writing case snapshot…');
    const caseDir = path.join(casesDir(), caseNumber);
    fs.mkdirSync(caseDir, { recursive: true });
    writeSnapshotFile(caseNumber, result.snapshot);

    // Extract files (from the zip) + inline-json (aperture).
    const plan = result.filePlan || [];
    let done = 0;
    const fileWarnings = [];
    for (const item of plan) {
      done++;
      progress('files', 4, 5, `Extracting files… (${done} of ${plan.length})`);
      const destRel = safeRel(item.destRel);
      if (!destRel) { fileWarnings.push('Skipped unsafe path: ' + item.destRel); continue; }
      const destAbs = path.join(caseDir, destRel);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });

      if (item.inlineJson !== undefined) {
        fs.writeFileSync(destAbs, Buffer.from(JSON.stringify(item.inlineJson), 'utf8'));
        continue;
      }
      try {
        const entry = zip.getEntry(item.zipPath);
        if (!entry) { fileWarnings.push('Missing in archive: ' + item.zipPath); continue; }
        const data = entry.getData();
        if (item.checksum) {
          const sum = crypto.createHash('sha256').update(data).digest('hex');
          if (sum !== item.checksum) fileWarnings.push('Checksum mismatch: ' + destRel);
        }
        fs.writeFileSync(destAbs, data);
      } catch (fe) {
        fileWarnings.push('Failed to extract ' + item.zipPath + ': ' + fe.message);
      }
    }

    progress('done', 5, 5, 'Import complete.');
    return {
      success: true,
      caseNumber,
      newId: result.newId,
      modules: result.modules,
      stats: result.stats,
      warnings: (result.warnings || []).concat(fileWarnings)
    };
  } catch (e) {
    return { success: false, error: e.message || 'Import failed.' };
  }
}

function registerIpc(ipcMain) {
  const { dialog } = require('electron');

  // Native file picker (renderer has no direct FS path access).
  ipcMain.handle('pulse-pick-file', async () => {
    try {
      const res = await dialog.showOpenDialog(getWin(), {
        title: 'Select PULSE Case Export',
        properties: ['openFile'],
        filters: [{ name: 'PULSE Case Export', extensions: ['pulse'] }, { name: 'All Files', extensions: ['*'] }]
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
      return { canceled: false, filePath: res.filePaths[0] };
    } catch (e) {
      return { canceled: true, error: e.message };
    }
  });

  ipcMain.handle('pulse-validate', async (_e, args) => validatePulse(args));
  ipcMain.handle('pulse-import', async (_e, args) => importPulse(args));
}

module.exports = { registerIpc, validatePulse, importPulse, setSecurityManager, setMainWindow, setCasesDirGetter };
