/**
 * Custom Tools credential vault — MAIN PROCESS ONLY.
 *
 * Stores the username/password an examiner supplies for a user-added
 * investigative resource (a county e-warrant portal, an RMS, a regional
 * intel share). Encrypted at rest with Electron safeStorage, which is
 * DPAPI-backed on Windows — the ciphertext is bound to the Windows user
 * account, so copying the file to another machine yields nothing.
 *
 * ── Why this is not localStorage ────────────────────────────────────
 * The 14 built-in resources keep their credentials in renderer
 * localStorage in plaintext and ship them to the main process on every
 * login page (`_makeResourceBV` in electron-main.js). That is a known
 * wart. Custom tools do not repeat it:
 *
 *   - The password is written once, from the settings page, and never
 *     travels back to a renderer.
 *   - Auto-fill injection is composed IN MAIN and executed directly in
 *     the target BrowserView, so the secret's only in-memory hop is
 *     main → that view.
 *   - `status()` deliberately returns `hasPassword` and the username,
 *     never the secret, so a compromised renderer cannot exfiltrate it.
 *
 * On-disk shape (userData/custom-tools-creds.json):
 *   { version: 1, entries: { "<toolId>": { blob: "<base64>", encrypted: true } } }
 * The whole {username, password} pair is encrypted together, so the
 * username is not readable at rest either.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'custom-tools-creds.json';
const VERSION = 1;

class CredentialVault {
  /**
   * @param {string} userDataDir  Electron app.getPath('userData')
   * @param {object} safeStorage  Electron safeStorage (injected so this is testable)
   */
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, FILE_NAME);
    this.safeStorage = safeStorage || null;
  }

  /** True when the OS keychain/DPAPI is usable. */
  canEncrypt() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable && this.safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  _read() {
    try {
      if (!fs.existsSync(this.file)) return { version: VERSION, entries: {} };
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { version: VERSION, entries: {} };
      return { version: parsed.version || VERSION, entries: parsed.entries };
    } catch (_) {
      // A corrupt vault must not brick the tray. Callers see "no
      // credentials stored" and can re-enter them.
      return { version: VERSION, entries: {} };
    }
  }

  _write(data) {
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // 0o600: owner-only. Advisory on Windows (the ACL inherited from
    // userData is the real control) but correct on every platform and
    // free to set.
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  _seal(obj) {
    const json = JSON.stringify(obj);
    if (this.canEncrypt()) {
      return { blob: this.safeStorage.encryptString(json).toString('base64'), encrypted: true };
    }
    // Plaintext fallback. Refusing to store at all would break the
    // feature on a machine where DPAPI is unavailable; instead the flag
    // is surfaced to the UI so the examiner can decide whether to enter
    // a password on this workstation.
    return { blob: Buffer.from(json, 'utf8').toString('base64'), encrypted: false };
  }

  _open(entry) {
    if (!entry || !entry.blob) return null;
    try {
      const buf = Buffer.from(entry.blob, 'base64');
      const json = entry.encrypted
        ? this.safeStorage.decryptString(buf)
        : buf.toString('utf8');
      const obj = JSON.parse(json);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (_) {
      // Wrong Windows user, rotated DPAPI key, or a truncated write.
      // Treat as absent rather than throwing into an IPC handler.
      return null;
    }
  }

  /**
   * @param password Pass `null` to KEEP the currently sealed password.
   *   The renderer is never given a stored password, so "leave blank to
   *   keep it" cannot be expressed by echoing the old value back — the
   *   caller sends `null` and the merge happens here, in the only place
   *   that is allowed to read it.
   * @returns {{success:boolean, encrypted?:boolean, error?:string}}
   */
  save(toolId, username, password) {
    if (!toolId) return { success: false, error: 'Missing tool id' };
    try {
      const data = this._read();
      const user = String(username == null ? '' : username);
      let pass;
      if (password === null) {
        const existing = this._open(data.entries[toolId]);
        pass = existing ? existing.password : '';
      } else {
        pass = String(password == null ? '' : password);
      }
      if (!user && !pass) {
        delete data.entries[toolId];
        this._write(data);
        return { success: true, encrypted: this.canEncrypt() };
      }
      data.entries[toolId] = this._seal({ username: user, password: pass });
      this._write(data);
      return { success: true, encrypted: !!data.entries[toolId].encrypted };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Renderer-safe view. NEVER include the password here — this crosses
   * the IPC boundary into a renderer.
   * @returns {{hasPassword:boolean, username:string, encrypted:boolean}}
   */
  status(toolId) {
    const data = this._read();
    const entry = data.entries[toolId];
    if (!entry) return { hasPassword: false, username: '', encrypted: this.canEncrypt() };
    const creds = this._open(entry);
    if (!creds) return { hasPassword: false, username: '', encrypted: !!entry.encrypted, unreadable: true };
    return {
      hasPassword: !!creds.password,
      username: creds.username || '',
      encrypted: !!entry.encrypted,
    };
  }

  /**
   * Full credentials — MAIN PROCESS CALLERS ONLY. The only legitimate
   * consumer is the auto-fill injector.
   * @returns {{username:string, password:string}|null}
   */
  reveal(toolId) {
    const data = this._read();
    return this._open(data.entries[toolId]);
  }

  /** @returns {{success:boolean, error?:string}} */
  clear(toolId) {
    try {
      const data = this._read();
      if (data.entries[toolId]) {
        delete data.entries[toolId];
        this._write(data);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** Ids currently holding an entry — used to prune orphans. */
  ids() {
    return Object.keys(this._read().entries);
  }
}

module.exports = { CredentialVault, FILE_NAME, VERSION };
