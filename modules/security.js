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

  setup(password) {
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

  disable() {
    if (!this.masterKey) throw new Error('Not unlocked');
    // Decrypt vault to plain JSON if it exists
    if (fs.existsSync(this.vaultPath)) {
      try {
        const data = this.decryptVault();
        if (data) {
          fs.writeFileSync(
            path.join(this.basePath, 'vault_plain.json'), data, 'utf-8'
          );
        }
      } catch (e) { /* best effort */ }
      fs.unlinkSync(this.vaultPath);
    }
    this.config.enabled = false;
    this._saveConfig();
    this.masterKey = null;
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
}

module.exports = SecurityManager;
