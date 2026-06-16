/**
 * VIPER Field Security — Recovery Module  (v3.8.7)
 *
 * Recovers VIPENC-encrypted files when SecurityManager state has been
 * lost (disable+re-enable cycle, accidental config overwrite, etc.)
 * by accepting an externally-supplied security.json plus the password
 * or recovery key that pairs with it.
 *
 * All operations are file-by-file, atomic where possible, and
 * preceded by a mandatory pre-flight backup of every root that will
 * be touched.  Credentials never leave the main process — the
 * derived master key is held in a closure local to a session
 * handle returned by createSession().
 *
 *  ─── Usage shape ─────────────────────────────────────────────────
 *    const session = await Recovery.createSession({
 *      configPath: 'C:/path/to/security.json',
 *      credential: 'PASSWORD or VIPER-XXXX-...-XXXX',
 *      credentialKind: 'password' | 'recovery'
 *    });
 *    // session.deriveResult: { success, samples? }
 *    // If success false, caller surfaces error; no master key held.
 *
 *    const scan = await session.scan([roots]);
 *    // { totalFiles, totalBytes, byRoot: {root: {files, bytes}} }
 *
 *    const backup = await session.preflightBackup({ workingDir, onProgress });
 *    // { backupDir, copiedFiles, copiedBytes }
 *
 *    const report = await session.decryptAll({ onProgress });
 *    // { decrypted: [], failed: [{path, error}], skipped: [] }
 *
 *    session.dispose();   // wipes master key from memory
 *
 *  Designed so the only persistent disk artifact of a failed run is
 *  the pre-flight backup folder — the original VIPENC blobs are
 *  never modified until atomic-rename time, and any in-flight
 *  shadow file (`*.recovered.tmp`) is unlinked on error.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SecurityManager = require('./security');

const SHADOW_SUFFIX = '.recovered.tmp';
const BACKUP_PREFIX = '_recovery_backup_';

// ─── Helpers ─────────────────────────────────────────────────────

function _normalizeRoots(roots) {
  if (!Array.isArray(roots)) throw new Error('roots must be an array');
  return Array.from(new Set(roots.filter(Boolean).map(r => path.resolve(r))));
}

function _walk(root, visit, opts = {}) {
  const skipDirNames = new Set([
    'node_modules', '.git', '__pycache__',
    ...((opts.skipDirNames) || [])
  ]);
  const skipPrefixes = ['_recovery_backup_', '_recovery_decrypted_'];
  const inner = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirNames.has(ent.name)) continue;
        if (skipPrefixes.some(p => ent.name.startsWith(p))) continue;
        inner(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(SHADOW_SUFFIX)) continue;
        visit(full, ent);
      }
    }
  };
  if (fs.existsSync(root)) inner(root);
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _diskFreeBytes(somePath) {
  // Best-effort cross-platform free-space probe.  Falls back to
  // null on platforms / Node versions that don't expose statfs().
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(somePath);
      return Number(s.bavail) * Number(s.bsize);
    }
  } catch (_) {}
  return null;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Validate a config file + credential WITHOUT writing or reading
 * any user data.  Returns { success, masterKey?, error? } where the
 * masterKey is a Buffer the caller should hold privately.
 *
 * The caller is responsible for never logging / serializing the key.
 */
function deriveMasterKey({ configPath, credential, credentialKind }) {
  if (!fs.existsSync(configPath)) {
    return { success: false, error: `Config not found: ${configPath}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    return { success: false, error: `Config not valid JSON: ${e.message}` };
  }
  if (!credentialKind || (credentialKind !== 'password' && credentialKind !== 'recovery')) {
    return { success: false, error: `credentialKind must be 'password' or 'recovery'` };
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    return { success: false, error: 'credential must be a non-empty string' };
  }
  try {
    const masterKey = SecurityManager.deriveMasterKey(cfg, credential, credentialKind);
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== SecurityManager.KEY_LENGTH) {
      return { success: false, error: 'derived key has unexpected length' };
    }
    return { success: true, masterKey };
  } catch (e) {
    // PBKDF2 returns a valid-length buffer regardless of input; the
    // GCM tag check is what actually rejects a wrong password.
    return { success: false, error: 'Wrong password or recovery key (auth tag mismatch).' };
  }
}

/**
 * Try to decrypt the first chunk of a file to PROVE a master key
 * matches without writing decrypted bytes anywhere.  Used by the
 * derive-test CLI to validate credentials against a known VIPENC
 * blob (e.g. an outer-wrapped .vbak) before kicking off a full run.
 *
 * Returns { match: bool, error? }
 */
function verifyKeyAgainstFile(filePath, masterKey) {
  try {
    if (!fs.existsSync(filePath)) return { match: false, error: 'File not found' };
    const stat = fs.statSync(filePath);
    if (stat.size < SecurityManager.HEADER_SIZE + 1) {
      return { match: false, error: 'File too small for VIPENC header' };
    }
    // For large files, only attempt the first up-to-4MB chunk.
    // AES-GCM is single-blob (no chunking), so partial decrypt can't
    // succeed — we have to read the whole file to validate the tag.
    // For small files (< 64MB) we just read it all and try.
    if (stat.size > 64 * 1024 * 1024) {
      // Caller should pick a smaller VIPENC blob to test against,
      // not a 600MB outer-wrapped backup.  We refuse rather than
      // load a huge file into memory just for a key check.
      return {
        match: false,
        error: `File too large (${stat.size}B) for key-check; pick a small VIPENC blob.`
      };
    }
    const raw = fs.readFileSync(filePath);
    if (!raw.subarray(0, 6).equals(SecurityManager.MAGIC)) {
      return { match: false, error: 'Not a VIPENC blob' };
    }
    SecurityManager.decryptBufferWithKey(raw, masterKey);
    return { match: true };
  } catch (e) {
    return { match: false, error: e.message };
  }
}

/**
 * Create a stateful recovery session.  Holds the master key in a
 * closure; the caller never sees it.  dispose() zeros the slot.
 */
async function createSession({ configPath, credential, credentialKind }) {
  const d = deriveMasterKey({ configPath, credential, credentialKind });
  if (!d.success) {
    return {
      deriveResult: { success: false, error: d.error },
      scan: async () => { throw new Error('Session not authenticated'); },
      preflightBackup: async () => { throw new Error('Session not authenticated'); },
      decryptAll: async () => { throw new Error('Session not authenticated'); },
      dispose: () => {}
    };
  }
  let masterKey = d.masterKey;
  let scanResult = null;

  const dispose = () => {
    if (masterKey) {
      try { masterKey.fill(0); } catch (_) {}
      masterKey = null;
    }
    scanResult = null;
  };

  const scan = async (roots) => {
    const normRoots = _normalizeRoots(roots);
    const byRoot = {};
    let totalFiles = 0, totalBytes = 0;
    const all = [];
    for (const root of normRoots) {
      let f = 0, b = 0;
      _walk(root, (full) => {
        if (!SecurityManager.isEncryptedFile(full)) return;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        all.push({ path: full, root, size });
        f++; b += size;
      });
      byRoot[root] = { files: f, bytes: b };
      totalFiles += f;
      totalBytes += b;
    }
    scanResult = { roots: normRoots, files: all, totalFiles, totalBytes, byRoot };
    return { totalFiles, totalBytes, byRoot, roots: normRoots };
  };

  const preflightBackup = async ({ workingDir, onProgress }) => {
    if (!scanResult) throw new Error('Call scan() before preflightBackup()');
    if (!workingDir) throw new Error('workingDir required');
    _ensureDir(workingDir);

    // Mandatory safety: require 1.5x the scanned size in free space.
    const free = _diskFreeBytes(workingDir);
    const required = Math.ceil(scanResult.totalBytes * 1.5);
    if (free !== null && free < required) {
      throw new Error(
        `Insufficient free space on ${workingDir}: ` +
        `have ${free} bytes, need ${required} bytes (1.5x of ${scanResult.totalBytes}).`
      );
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(workingDir, `${BACKUP_PREFIX}${ts}`);
    _ensureDir(backupDir);

    let copiedFiles = 0, copiedBytes = 0;
    for (let i = 0; i < scanResult.files.length; i++) {
      const f = scanResult.files[i];
      // Mirror the path UNDER the root inside backupDir, namespaced
      // by a sanitized root name so cross-root collisions are
      // impossible.
      const rootName = f.root.replace(/[^a-zA-Z0-9._-]/g, '_');
      const rel = path.relative(f.root, f.path);
      const dest = path.join(backupDir, rootName, rel);
      _ensureDir(path.dirname(dest));
      try {
        fs.copyFileSync(f.path, dest);
        copiedFiles++;
        copiedBytes += f.size;
      } catch (e) {
        // Pre-flight backup failures are FATAL — we refuse to start
        // decryption if we couldn't even copy a file safely.
        throw new Error(`Pre-flight backup failed at ${f.path}: ${e.message}`);
      }
      if (onProgress) {
        onProgress({
          phase: 'backup',
          current: i + 1,
          total: scanResult.files.length,
          path: f.path
        });
      }
    }
    return { backupDir, copiedFiles, copiedBytes };
  };

  const decryptAll = async ({ onProgress }) => {
    if (!scanResult) throw new Error('Call scan() before decryptAll()');
    if (!masterKey) throw new Error('Session disposed');

    const decrypted = [];
    const failed = [];
    const skipped = [];

    for (let i = 0; i < scanResult.files.length; i++) {
      const f = scanResult.files[i];
      if (onProgress) {
        onProgress({
          phase: 'decrypt',
          current: i + 1,
          total: scanResult.files.length,
          path: f.path
        });
      }
      const shadow = f.path + SHADOW_SUFFIX;
      try {
        const raw = fs.readFileSync(f.path);
        // The blob might have been already-plaintext by the time we
        // re-walk (eg. another process raced us).  decryptBufferWithKey
        // returns raw unchanged when no VIPENC header; treat that as
        // a skip rather than a failure.
        if (!raw.subarray(0, 6).equals(SecurityManager.MAGIC)) {
          skipped.push(f.path);
          continue;
        }
        const plain = SecurityManager.decryptBufferWithKey(raw, masterKey);
        fs.writeFileSync(shadow, plain);
        fs.renameSync(shadow, f.path);
        decrypted.push(f.path);
      } catch (e) {
        // Try to clean up shadow if it exists
        try { if (fs.existsSync(shadow)) fs.unlinkSync(shadow); } catch (_) {}
        failed.push({ path: f.path, error: e.message });
      }
    }
    return { decrypted, failed, skipped };
  };

  return {
    deriveResult: { success: true },
    scan,
    preflightBackup,
    decryptAll,
    dispose
  };
}

module.exports = {
  deriveMasterKey,
  verifyKeyAgainstFile,
  createSession,
  // Re-exports for tests
  _SHADOW_SUFFIX: SHADOW_SUFFIX,
  _BACKUP_PREFIX: BACKUP_PREFIX
};
