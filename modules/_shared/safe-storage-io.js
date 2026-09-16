/**
 * Safe storage I/O helpers (MAIN PROCESS ONLY - uses node fs).
 *
 * Extracted from electron-main.js so they can be unit-tested in plain
 * Node. These sit on the bootstrap path: if atomicWriteFileSync is wrong,
 * every user's storage overrides can be corrupted, which silently reverts
 * all data paths to their defaults and looks exactly like total data loss.
 */
const fs = require('fs');

/**
 * Write a file atomically: temp file -> fsync -> rename over the target.
 * rename() is atomic on NTFS and POSIX, so a crash or power loss can never
 * leave a half-written, unparseable file behind.
 *
 * The previous implementation wrote straight onto the live config; a
 * truncated storage.json makes the JSON.parse fail, the loader returns {},
 * and every path silently falls back to its default.
 */
function atomicWriteFileSync(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch (_) { /* fsync unsupported - best effort */ }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

/**
 * Is this path inside a known cloud-sync root?
 *
 * Chromium's localStorage is a LevelDB. LevelDB on cloud-synced storage is
 * a documented availability hazard: placeholder ("files on demand") stubs,
 * sync locks and multi-machine writes can all make an intact database read
 * as empty. We never block it - we warn, and we never mistake "not yet
 * hydrated" for "no data".
 *
 * Returns a provider label, or null.
 */
function looksCloudSynced(p, env) {
  if (!p || typeof p !== 'string') return null;
  env = env || process.env;
  const s = p.replace(/\//g, '\\').toLowerCase();

  const providers = [
    ['onedrive', 'OneDrive'],
    ['dropbox', 'Dropbox'],
    ['google drive', 'Google Drive'],
    ['googledrive', 'Google Drive'],
    ['my drive', 'Google Drive'],
    ['icloud', 'iCloud'],
    ['box sync', 'Box'],
    ['creative cloud', 'Adobe CC'],
    ['nextcloud', 'Nextcloud'],
    ['owncloud', 'ownCloud'],
    ['syncthing', 'Syncthing'],
    ['pcloud', 'pCloud'],
    ['mega sync', 'MEGA'],
    ['megasync', 'MEGA'],
    ['sharepoint', 'SharePoint'],
  ];
  for (const [needle, label] of providers) {
    if (s.indexOf(needle) !== -1) return label;
  }

  // Environment-declared roots (OneDrive sets these on Windows).
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const root = env[key];
    if (root && typeof root === 'string' && root.trim()) {
      if (s.startsWith(root.replace(/\//g, '\\').toLowerCase())) return 'OneDrive';
    }
  }
  return null;
}

/**
 * Does a real Chromium localStorage database exist at this userData path?
 * A LevelDB is only meaningful if it has a CURRENT manifest; an empty or
 * absent directory means there is nothing to load - which is exactly the
 * difference between "new user" and "files have not arrived yet".
 */
function probeLocalStorage(userDataPath, fsImpl) {
  const F = fsImpl || fs;
  try {
    const ldb = userDataPath.replace(/[\\/]+$/, '') + '\\Local Storage\\leveldb';
    const alt = userDataPath.replace(/[\\/]+$/, '') + '/Local Storage/leveldb';
    const dir = F.existsSync(ldb) ? ldb : (F.existsSync(alt) ? alt : null);
    if (!dir) return { present: false, files: 0 };
    const files = F.readdirSync(dir);
    return { present: files.indexOf('CURRENT') !== -1, files: files.length };
  } catch (_) {
    return { present: false, files: 0 };
  }
}

module.exports = { atomicWriteFileSync, looksCloudSynced, probeLocalStorage };
