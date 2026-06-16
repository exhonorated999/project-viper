/**
 * VIPER Field Security Module
 * AES-256-GCM encryption with PBKDF2 key derivation.
 * Master key wrapped with both password and recovery key.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;       // 256 bits
const IV_LENGTH = 16;        // 128 bits
const SALT_LENGTH = 32;      // 256 bits
const PBKDF2_ITERATIONS = 100000;
const MAGIC = Buffer.from('VIPENC');
const FORMAT_VERSION = 1;
const HEADER_SIZE = 40;      // 6 magic + 1 version + 1 reserved + 16 IV + 16 tag

class SecurityManager {
  constructor(basePath) {
    this.basePath = basePath;
    this.configPath = path.join(basePath, 'security.json');
    this.vaultPath = path.join(basePath, 'vault.enc');
    this.masterKey = null;
    this.config = null;
    this._loadConfig();
  }

  // ─── Config persistence ───────────────────────────────────────────

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
    } catch (e) {
      console.error('SecurityManager: failed to load config', e.message);
      this.config = null;
    }
  }

  _saveConfig() {
    // Forward-fix (v3.8.7): before overwriting, rotate a timestamped backup of
    // the existing config so a setup() / disable() cycle can never silently
    // destroy the only copy of the wrapping metadata that ties saved
    // password/recovery keys to the master key that encrypted on-disk blobs.
    // Keeps the 5 most recent snapshots; oldest are unlink()ed.
    try {
      if (fs.existsSync(this.configPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const bakPath = `${this.configPath}.bak.${ts}`;
        try {
          fs.copyFileSync(this.configPath, bakPath);
        } catch (e) {
          console.error('SecurityManager: failed to write config backup', e.message);
        }
        // Prune to last 5
        try {
          const dir = path.dirname(this.configPath);
          const base = path.basename(this.configPath);
          const baks = fs.readdirSync(dir)
            .filter(n => n.startsWith(`${base}.bak.`))
            .sort()
            .reverse();
          for (const stale of baks.slice(5)) {
            try { fs.unlinkSync(path.join(dir, stale)); } catch (_) {}
          }
        } catch (_) { /* best-effort prune */ }
      }
    } catch (e) {
      console.error('SecurityManager: backup-rotate failed', e.message);
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  // ─── Crypto primitives ────────────────────────────────────────────

  _deriveKey(secret, saltHex) {
    const salt = Buffer.from(saltHex, 'hex');
    return crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  }

  _encryptRaw(plainBuffer, key) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  _decryptRaw(encHex, key, ivHex, tagHex) {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final()
    ]);
  }

  _generateRecoveryKey() {
    // Format: VIPER-XXXX-XXXX-XXXX-XXXX-XXXX  (ambiguous chars removed)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = 'VIPER';
    for (let g = 0; g < 5; g++) {
      key += '-';
      for (let c = 0; c < 4; c++) {
        key += chars[crypto.randomInt(chars.length)];
      }
    }
    return key;
  }

  // ─── Public state queries ─────────────────────────────────────────

  isEnabled() {
    return !!(this.config && this.config.enabled);
  }

  isUnlocked() {
    return this.masterKey !== null;
  }

  // ─── Setup (first-time enable) ───────────────────────────────────

  setup(password, opts = {}) {
    // Forward-fix (v3.8.7): refuse to setup() when there is no existing
    // config but VIPENC blobs already exist on disk — that signature
    // means a previous SecurityManager session encrypted files with a
    // master key that this setup() call would silently replace.
    // Caller passes opts.scanRoots = [basePath, casesDir, ...] so we
    // know where to look.  Pass opts.allowOverwriteEncrypted = true
    // only after a successful recovery / decision to abandon old data.
    if (!this.config && Array.isArray(opts.scanRoots) && !opts.allowOverwriteEncrypted) {
      const found = [];
      for (const root of opts.scanRoots) {
        const hits = SecurityManager.scanForEncryptedFiles(root, { maxFiles: 5 });
        for (const h of hits) {
          found.push(h.path);
          if (found.length >= 5) break;
        }
        if (found.length >= 5) break;
      }
      if (found.length) {
        const err = new Error(
          'VIPER detected encrypted files from a prior Field Security session. ' +
          'Use "Recover Lost Encrypted Data" with your original security.json ' +
          'before re-enabling encryption, or contact support. ' +
          `Found ${found.length}+ encrypted file(s); first: ${found[0]}`
        );
        err.code = 'EXISTING_ENCRYPTED_FILES';
        err.samples = found;
        throw err;
      }
    }

    const masterKey = crypto.randomBytes(KEY_LENGTH);

    // Wrap with password
    const pwSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    const pwKey = this._deriveKey(password, pwSalt);
    const pwWrapped = this._encryptRaw(masterKey, pwKey);

    // Wrap with recovery key
    const recoveryKey = this._generateRecoveryKey();
    const recSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    const recKey = this._deriveKey(recoveryKey, recSalt);
    const recWrapped = this._encryptRaw(masterKey, recKey);

    this.config = {
      enabled: true,
      created_at: new Date().toISOString(),
      password_salt: pwSalt,
      password_wrapped_key: pwWrapped.encrypted,
      password_iv: pwWrapped.iv,
      password_tag: pwWrapped.tag,
      recovery_salt: recSalt,
      recovery_wrapped_key: recWrapped.encrypted,
      recovery_iv: recWrapped.iv,
      recovery_tag: recWrapped.tag
    };

    this._saveConfig();
    this.masterKey = masterKey;
    return recoveryKey;
  }

  // ─── Unlock with password ────────────────────────────────────────

  unlock(password) {
    if (!this.isEnabled()) return false;
    try {
      const pwKey = this._deriveKey(password, this.config.password_salt);
      this.masterKey = this._decryptRaw(
        this.config.password_wrapped_key, pwKey,
        this.config.password_iv, this.config.password_tag
      );
      return true;
    } catch (e) {
      this.masterKey = null;
      return false;
    }
  }

  // ─── Unlock with recovery key ────────────────────────────────────

  recover(recoveryKey) {
    if (!this.isEnabled()) return false;
    try {
      const recKey = this._deriveKey(recoveryKey, this.config.recovery_salt);
      this.masterKey = this._decryptRaw(
        this.config.recovery_wrapped_key, recKey,
        this.config.recovery_iv, this.config.recovery_tag
      );
      return true;
    } catch (e) {
      this.masterKey = null;
      return false;
    }
  }

  // ─── Password / recovery management ──────────────────────────────

  changePassword(newPassword) {
    if (!this.masterKey) throw new Error('Not unlocked');
    const pwSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    const pwKey = this._deriveKey(newPassword, pwSalt);
    const pwWrapped = this._encryptRaw(this.masterKey, pwKey);

    this.config.password_salt = pwSalt;
    this.config.password_wrapped_key = pwWrapped.encrypted;
    this.config.password_iv = pwWrapped.iv;
    this.config.password_tag = pwWrapped.tag;
    this._saveConfig();
  }

  generateNewRecoveryKey() {
    if (!this.masterKey) throw new Error('Not unlocked');
    const recoveryKey = this._generateRecoveryKey();
    const recSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    const recKey = this._deriveKey(recoveryKey, recSalt);
    const recWrapped = this._encryptRaw(this.masterKey, recKey);

    this.config.recovery_salt = recSalt;
    this.config.recovery_wrapped_key = recWrapped.encrypted;
    this.config.recovery_iv = recWrapped.iv;
    this.config.recovery_tag = recWrapped.tag;
    this._saveConfig();
    return recoveryKey;
  }

  /**
   * Disable Field Security.  Walks all caller-supplied roots, decrypts
   * every VIPENC blob found, and only then flips the enabled flag.
   *
   * @param {object} opts
   * @param {string[]} [opts.scanRoots] additional roots besides basePath
   *                                    (e.g. casesDir).  Caller MUST
   *                                    pass cases dir or those files
   *                                    will stay encrypted.
   * @param {function} [opts.onProgress] ({ phase, current, total, path }) => void
   * @returns {{ decrypted: string[], failed: {path:string,error:string}[] }}
   */
  disable(opts = {}) {
    if (!this.masterKey) throw new Error('Not unlocked');

    const roots = [this.basePath, ...(opts.scanRoots || [])];
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    // 1) Decrypt the localStorage snapshot vault to plaintext sidecar
    if (fs.existsSync(this.vaultPath)) {
      try {
        const data = this.decryptVault();
        if (data) {
          fs.writeFileSync(
            path.join(this.basePath, 'vault_plain.json'), data, 'utf-8'
          );
        }
      } catch (e) { /* best effort */ }
      try { fs.unlinkSync(this.vaultPath); } catch (_) {}
    }

    // 2) Scan all roots for VIPENC blobs, excluding security.json itself
    //    and our own backup shadows.
    const skipPaths = new Set([
      this.configPath,
      this.vaultPath,
    ]);
    const targets = [];
    for (const root of roots) {
      const hits = SecurityManager.scanForEncryptedFiles(root);
      for (const h of hits) {
        if (!skipPaths.has(h.path) && !targets.some(t => t.path === h.path)) {
          targets.push(h);
        }
      }
    }

    if (onProgress) onProgress({ phase: 'start', current: 0, total: targets.length });

    const decrypted = [];
    const failed = [];

    // 3) Decrypt in place via shadow-write + atomic rename so a crash
    //    mid-walk leaves either the original VIPENC or the decrypted
    //    plaintext on disk, never a half-written file.
    targets.forEach((t, idx) => {
      if (onProgress) onProgress({ phase: 'decrypt', current: idx + 1, total: targets.length, path: t.path });
      try {
        const raw = fs.readFileSync(t.path);
        const plain = SecurityManager.decryptBufferWithKey(raw, this.masterKey);
        const shadow = `${t.path}.recovered.tmp`;
        fs.writeFileSync(shadow, plain);
        fs.renameSync(shadow, t.path);
        decrypted.push(t.path);
      } catch (e) {
        failed.push({ path: t.path, error: e.message });
      }
    });

    // 4) Only NOW flip the flag and clear the master key.  If we
    //    crashed during the walk, security stays enabled — user can
    //    re-run disable to finish.
    this.config.enabled = false;
    this._saveConfig();
    this.masterKey = null;

    if (onProgress) onProgress({ phase: 'done', current: targets.length, total: targets.length });

    return { decrypted, failed };
  }

  // ─── Vault: localStorage snapshot encrypt / decrypt ──────────────

  encryptVault(jsonString) {
    if (!this.masterKey) throw new Error('Not unlocked');
    const plain = Buffer.from(jsonString, 'utf-8');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header[6] = FORMAT_VERSION;
    header[7] = 0;
    iv.copy(header, 8);
    tag.copy(header, 24);

    fs.writeFileSync(this.vaultPath, Buffer.concat([header, enc]));
  }

  decryptVault() {
    if (!this.masterKey) throw new Error('Not unlocked');
    if (!fs.existsSync(this.vaultPath)) return null;

    const data = fs.readFileSync(this.vaultPath);
    if (data.length < HEADER_SIZE) throw new Error('Corrupt vault');
    if (!data.subarray(0, 6).equals(MAGIC)) throw new Error('Invalid vault format');

    const iv = data.subarray(8, 24);
    const tag = data.subarray(24, 40);
    const ciphertext = data.subarray(40);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  // ─── Generic buffer encrypt / decrypt (for case files) ──────────

  encryptBuffer(buffer) {
    if (!this.masterKey) throw new Error('Not unlocked');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header[6] = FORMAT_VERSION;
    header[7] = 0;
    iv.copy(header, 8);
    tag.copy(header, 24);

    return Buffer.concat([header, enc]);
  }

  decryptBuffer(encBuffer) {
    if (!this.masterKey) throw new Error('Not unlocked');
    if (!Buffer.isBuffer(encBuffer)) encBuffer = Buffer.from(encBuffer);
    // Not encrypted → return as-is (backward compat)
    if (encBuffer.length < HEADER_SIZE || !encBuffer.subarray(0, 6).equals(MAGIC)) {
      return encBuffer;
    }
    const iv = encBuffer.subarray(8, 24);
    const tag = encBuffer.subarray(24, 40);
    const ciphertext = encBuffer.subarray(40);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  isEncryptedBuffer(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    return buf.length >= 6 && buf.subarray(0, 6).equals(MAGIC);
  }

  lock() {
    this.masterKey = null;
  }

  // ─── Recovery helpers (v3.8.7) ────────────────────────────────────
  // These are stateless / static-style helpers used by the recovery
  // module (modules/security-recovery.js) and the disable() walker.
  // They never mutate instance state and never write to disk.

  /**
   * Derive masterKey from a config object + credential.
   * Does NOT touch instance state.  Returns Buffer or throws.
   */
  static deriveMasterKey(configObj, credential, kind /* 'password' | 'recovery' */) {
    if (!configObj || typeof configObj !== 'object') {
      throw new Error('deriveMasterKey: invalid config object');
    }
    const saltHex   = kind === 'password' ? configObj.password_salt        : configObj.recovery_salt;
    const wrappedHex= kind === 'password' ? configObj.password_wrapped_key : configObj.recovery_wrapped_key;
    const ivHex     = kind === 'password' ? configObj.password_iv          : configObj.recovery_iv;
    const tagHex    = kind === 'password' ? configObj.password_tag         : configObj.recovery_tag;
    if (!saltHex || !wrappedHex || !ivHex || !tagHex) {
      throw new Error(`deriveMasterKey: config missing ${kind} wrapping fields`);
    }
    const salt = Buffer.from(saltHex, 'hex');
    const kek  = crypto.pbkdf2Sync(credential, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
    const decipher = crypto.createDecipheriv(
      ALGORITHM, kek, Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(wrappedHex, 'hex')),
      decipher.final()
    ]);
  }

  /**
   * Decrypt a VIPENC buffer with an externally-supplied master key.
   * Pure function; no instance state.  Plaintext buffer returned as-is.
   */
  static decryptBufferWithKey(encBuffer, masterKey) {
    if (!Buffer.isBuffer(encBuffer)) encBuffer = Buffer.from(encBuffer);
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_LENGTH) {
      throw new Error('decryptBufferWithKey: invalid master key');
    }
    if (encBuffer.length < HEADER_SIZE || !encBuffer.subarray(0, 6).equals(MAGIC)) {
      return encBuffer;
    }
    const iv         = encBuffer.subarray(8, 24);
    const tag        = encBuffer.subarray(24, 40);
    const ciphertext = encBuffer.subarray(40);
    const decipher   = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** True if file's first 6 bytes are the VIPENC magic. */
  static isEncryptedFile(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(6);
      const n = fs.readSync(fd, buf, 0, 6, 0);
      fs.closeSync(fd);
      return n === 6 && buf.equals(MAGIC);
    } catch (_) { return false; }
  }

  /**
   * Recursively walk `root` and return a list of VIPENC-encrypted files.
   * Skips obvious non-evidence dirs and the recovery-backup folders.
   * Returns [{ path, size }].
   */
  static scanForEncryptedFiles(root, opts = {}) {
    const max = opts.maxFiles || 1_000_000;
    const out = [];
    const skipDirNames = new Set([
      'node_modules', '.git', '__pycache__',
      // never re-encrypt our own recovery work
      ...((opts.skipDirNames) || [])
    ]);
    const skipPrefixes = ['_recovery_backup_', '_recovery_decrypted_'];
    const walk = (dir) => {
      if (out.length >= max) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const ent of entries) {
        if (out.length >= max) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (skipDirNames.has(ent.name)) continue;
          if (skipPrefixes.some(p => ent.name.startsWith(p))) continue;
          walk(full);
        } else if (ent.isFile()) {
          if (SecurityManager.isEncryptedFile(full)) {
            let size = 0;
            try { size = fs.statSync(full).size; } catch (_) {}
            out.push({ path: full, size });
          }
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
  }
}

// Constants exported for the recovery module + tests
SecurityManager.MAGIC = MAGIC;
SecurityManager.HEADER_SIZE = HEADER_SIZE;
SecurityManager.FORMAT_VERSION = FORMAT_VERSION;
SecurityManager.ALGORITHM = ALGORITHM;
SecurityManager.KEY_LENGTH = KEY_LENGTH;
SecurityManager.IV_LENGTH = IV_LENGTH;
SecurityManager.PBKDF2_ITERATIONS = PBKDF2_ITERATIONS;

module.exports = SecurityManager;
