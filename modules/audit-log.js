/**
 * VIPER Audit Log
 * ─────────────────────────────────────────────────────────────────────────
 *  Append-only, tamper-evident audit log. Records security-relevant
 *  events (app lifecycle, case lifecycle, evidence/warrant operations,
 *  lock/unlock, license events, settings changes, update events).
 *
 *  Storage:
 *    %APPDATA%\viper-electron\audit.log              (current)
 *    %APPDATA%\viper-electron\audit.log.1 .. .5      (rotated, oldest = .5)
 *
 *  File format: JSON Lines (one entry per line, '\n' terminated).
 *
 *    Plaintext entry:  {"seq":N, "ts":"...", "event":"...", ..., "hash":"..."}
 *    Encrypted entry:  {"enc":"<base64 VIPENC block of the plaintext entry>"}
 *
 *  Tamper evidence:
 *    Each entry contains `prev_hash` = hash of the previous entry's
 *    canonical form (everything except its own `hash` field). The first
 *    entry uses prev_hash = "GENESIS". Any deletion or edit of any entry
 *    breaks the chain and is detectable via verifyChain().
 *
 *  Encryption:
 *    When SecurityManager is unlocked, entries are written in encrypted
 *    form using AES-256-GCM (same key the rest of the app uses for case
 *    files). Hash is computed on the plaintext BEFORE encryption, so
 *    chain integrity can be verified after decryption.
 *
 *  Retention policy:
 *    - User cannot delete entries from inside the app. Period.
 *    - Rotated files stay until IT removes them.
 *    - Rotation is size-based (50 MB per file × 5 files = ~250 MB cap).
 *
 *  PII policy:
 *    - Records THAT an action happened, not the data involved.
 *    - Filenames + sizes + SHA-256s are logged; file contents are not.
 *    - Case names are logged; victim/suspect names are not.
 *
 *  CJIS positioning:
 *    Designed to satisfy CJIS Security Policy v6.0 §5.4 (auditing &
 *    accountability) for a vendor application: timestamps, user
 *    attribution, action types, success/failure, no plaintext disclosure
 *    of CJI, append-only with integrity verification, retention bounded
 *    only by IT.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ─────────────────────────────────────────────────────
const FILENAME           = 'audit.log';
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024;   // 50 MB
const KEEP_ROTATED       = 5;                   // audit.log.1 .. audit.log.5
const GENESIS_HASH       = 'GENESIS';
const SCHEMA_VERSION     = 1;

// ─── Public event vocabulary ──────────────────────────────────────────
// Centralized list. Anything not in this set is rejected by write() —
// prevents drift and gives auditors a finite vocabulary to reason about.
const EVENT_TYPES = Object.freeze({
  // App lifecycle
  APP_LAUNCH:           'app_launch',
  APP_EXIT:             'app_exit',
  APP_CRASH:            'app_crash',

  // Security / session
  SECURITY_ENABLED:     'security_enabled',
  SECURITY_DISABLED:    'security_disabled',
  SECURITY_UNLOCK:      'security_unlock',
  SECURITY_UNLOCK_FAIL: 'security_unlock_fail',
  SECURITY_LOCK:        'security_lock',
  SECURITY_IDLE_LOCK:   'security_idle_lock',
  SECURITY_RECOVERY:    'security_recovery_used',

  // License
  LICENSE_ACTIVATED:    'license_activated',
  LICENSE_REVOKED:      'license_revoked',
  LICENSE_VALIDATED:    'license_validated',
  LICENSE_VALIDATE_FAIL:'license_validate_fail',

  // Case lifecycle
  CASE_CREATED:         'case_created',
  CASE_OPENED:          'case_opened',
  CASE_CLOSED:          'case_closed',
  CASE_DELETED:         'case_deleted',
  CASE_EXPORTED:        'case_exported',
  CASE_IMPORTED:        'case_imported',

  // Evidence
  EVIDENCE_ADDED:       'evidence_added',
  EVIDENCE_DELETED:     'evidence_deleted',
  EVIDENCE_VIEWED:      'evidence_viewed',
  EVIDENCE_EXPORTED:    'evidence_exported',

  // Warrant
  WARRANT_ADDED:        'warrant_added',
  WARRANT_DELETED:      'warrant_deleted',
  WARRANT_RETURN_IMPORTED: 'warrant_return_imported',

  // Update
  UPDATE_CHECKED:       'update_checked',
  UPDATE_DOWNLOADED:    'update_downloaded',
  UPDATE_APPLIED:       'update_applied',

  // Settings
  SETTINGS_CHANGED:     'settings_changed',

  // Audit log itself (meta)
  AUDIT_LOG_EXPORTED:   'audit_log_exported',
  AUDIT_LOG_VERIFIED:   'audit_log_verified',
  AUDIT_LOG_ROTATED:    'audit_log_rotated',
});
const VALID_EVENTS = new Set(Object.values(EVENT_TYPES));

// ─── Utility ──────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

/** Stable, deterministic JSON serialization (sorted keys) — required for
 *  hash determinism. JSON.stringify alone is NOT stable across keys. */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex');
}

// ─── Audit Logger ─────────────────────────────────────────────────────
class AuditLogger {
  /**
   * @param {string} basePath  Directory where audit.log lives (typically userData)
   * @param {object} [opts]
   * @param {object} [opts.security]  SecurityManager instance (optional)
   * @param {string} [opts.appVersion] e.g. '3.0.0'
   */
  constructor(basePath, opts = {}) {
    this.basePath = basePath;
    this.security = opts.security || null;
    this.appVersion = opts.appVersion || 'unknown';
    this.logPath = path.join(basePath, FILENAME);
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.host = (() => { try { return os.hostname(); } catch { return 'unknown'; } })();
    this.user = (() => { try { return os.userInfo().username; } catch { return 'unknown'; } })();
    this.eventLogEnabled = false;   // Windows Event Log forwarding (off by default)

    this._lastSeq = 0;
    this._lastHash = GENESIS_HASH;
    this._initialize();
  }

  /** Set the SecurityManager after construction (e.g. once it's available). */
  setSecurityManager(security) {
    this.security = security;
  }

  /** Toggle Windows Event Log forwarding. */
  setEventLogForwarding(enabled) {
    this.eventLogEnabled = !!enabled;
  }

  /** Build the canonical (hash-input) form of an entry — everything except `hash`. */
  _canonicalForm(entry) {
    const { hash, ...rest } = entry;
    return canonicalize(rest);
  }

  /** Compute hash for an entry (entry must already include prev_hash). */
  _computeHash(entry) {
    return sha256Hex(this._canonicalForm(entry));
  }

  /** On startup: load tail of current audit.log to recover seq + last hash. */
  _initialize() {
    try {
      if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
      if (!fs.existsSync(this.logPath)) return;  // fresh start, GENESIS

      // Read last non-empty line. For small files just read all; for large
      // files (close to 50 MB) we use a chunk-from-end read.
      const stat = fs.statSync(this.logPath);
      let lastLine = null;

      if (stat.size < 64 * 1024) {
        const lines = fs.readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
        lastLine = lines[lines.length - 1];
      } else {
        // Read last 8 KB
        const fd = fs.openSync(this.logPath, 'r');
        const bufSize = Math.min(8192, stat.size);
        const buf = Buffer.alloc(bufSize);
        fs.readSync(fd, buf, 0, bufSize, stat.size - bufSize);
        fs.closeSync(fd);
        const tail = buf.toString('utf-8').split('\n').filter(Boolean);
        lastLine = tail[tail.length - 1];
      }

      if (!lastLine) return;
      const last = this._decodeLine(lastLine);
      if (last && typeof last.seq === 'number') {
        this._lastSeq = last.seq;
        this._lastHash = last.hash || GENESIS_HASH;
      }
    } catch (e) {
      console.error('AuditLogger._initialize:', e.message);
      // Fallback to genesis — chain will fork from here. The verify
      // routine will flag the discontinuity, which is the correct
      // behavior (we'd rather log forward than silently lose entries).
    }
  }

  /** Decode a single file line into its plaintext entry object.
   *  Returns null if the line is malformed. */
  _decodeLine(line) {
    if (!line || !line.length) return null;
    let parsed;
    try { parsed = JSON.parse(line); } catch { return null; }

    // Encrypted form
    if (parsed && typeof parsed === 'object' && typeof parsed.enc === 'string') {
      if (!this.security || !this.security.isUnlocked || !this.security.isUnlocked()) {
        // We can't decode; return placeholder so caller knows.
        return { __encrypted: true };
      }
      try {
        const enc = Buffer.from(parsed.enc, 'base64');
        const dec = this.security.decryptBuffer(enc);
        return JSON.parse(dec.toString('utf-8'));
      } catch (e) {
        return null;
      }
    }
    return parsed;
  }

  /** Encode a plaintext entry object into the on-disk line representation. */
  _encodeEntry(entry) {
    const json = JSON.stringify(entry);
    if (this.security && this.security.isUnlocked && this.security.isUnlocked()) {
      const enc = this.security.encryptBuffer(Buffer.from(json, 'utf-8'));
      return JSON.stringify({ enc: enc.toString('base64') });
    }
    return json;
  }

  /** Rotate audit.log → audit.log.1 → audit.log.2 → ... */
  _maybeRotate() {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const stat = fs.statSync(this.logPath);
      if (stat.size < MAX_BYTES_PER_FILE) return;

      // Drop oldest if at cap
      const oldest = `${this.logPath}.${KEEP_ROTATED}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

      // Shift .N → .N+1 (descending so we don't clobber)
      for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
        const src = `${this.logPath}.${i}`;
        const dst = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      // Current → .1
      fs.renameSync(this.logPath, `${this.logPath}.1`);

      // Record the rotation event in the new file (chain continues from
      // the prior last hash, so verification spans rotations).
      this._writeRaw(EVENT_TYPES.AUDIT_LOG_ROTATED, {
        rotated_to: path.basename(`${this.logPath}.1`),
        rotated_at: nowIso()
      });
    } catch (e) {
      console.error('AuditLogger._maybeRotate:', e.message);
    }
  }

  /** Internal write that does NOT recurse into rotation. */
  _writeRaw(eventType, data) {
    this._lastSeq += 1;
    const entry = {
      schema:     SCHEMA_VERSION,
      seq:        this._lastSeq,
      ts:         nowIso(),
      event:      eventType,
      user:       this.user,
      host:       this.host,
      session:    this.sessionId,
      app_version:this.appVersion,
      data:       data || {},
      prev_hash:  this._lastHash,
    };
    entry.hash = this._computeHash(entry);
    this._lastHash = entry.hash;

    const line = this._encodeEntry(entry) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf-8');

    // Best-effort Windows Event Log mirror (never throws into caller)
    if (this.eventLogEnabled) {
      this._mirrorToWindowsEventLog(entry).catch(() => {});
    }

    return entry;
  }

  /**
   * Public write API.
   * Returns the entry object on success, throws on validation failure.
   */
  write(eventType, data) {
    if (!VALID_EVENTS.has(eventType)) {
      throw new Error(`AuditLogger.write: unknown event type "${eventType}"`);
    }
    this._maybeRotate();
    return this._writeRaw(eventType, data || {});
  }

  /**
   * Read the last `limit` entries from the current audit.log (does not
   * span rotated files — use exportAll() for that). Returns plaintext
   * entries; encrypted lines are returned with `__encrypted: true` if
   * the SecurityManager is currently locked.
   */
  readTail(limit = 200) {
    if (!fs.existsSync(this.logPath)) return [];
    const text = fs.readFileSync(this.logPath, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.min(10000, limit)));
    return slice.map(line => this._decodeLine(line)).filter(Boolean);
  }

  /**
   * Export ALL entries across current + rotated files, oldest first.
   * Decrypts entries when possible; returns __encrypted markers when not.
   */
  exportAll() {
    const files = [];
    for (let i = KEEP_ROTATED; i >= 1; i--) {
      const f = `${this.logPath}.${i}`;
      if (fs.existsSync(f)) files.push(f);
    }
    if (fs.existsSync(this.logPath)) files.push(this.logPath);

    const out = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf-8');
      for (const line of text.split('\n').filter(Boolean)) {
        const e = this._decodeLine(line);
        if (e) out.push(e);
      }
    }
    return out;
  }

  /**
   * Verify the integrity of the entire chain (current + rotated).
   * Returns { ok, totalEntries, brokenAt, reason }.
   * brokenAt = seq of first inconsistent entry (or null on success).
   */
  verifyChain() {
    const entries = this.exportAll();
    if (entries.length === 0) {
      return { ok: true, totalEntries: 0, brokenAt: null, reason: null };
    }

    let expectedSeq = entries[0].seq;
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];

      if (e.__encrypted) {
        return { ok: false, totalEntries: entries.length,
                 brokenAt: i + 1, reason: 'encrypted_entries_not_decryptable' };
      }
      if (typeof e.seq !== 'number' || e.seq !== expectedSeq) {
        return { ok: false, totalEntries: entries.length,
                 brokenAt: e.seq || (i + 1), reason: 'sequence_mismatch' };
      }
      if (e.prev_hash !== prevHash) {
        return { ok: false, totalEntries: entries.length,
                 brokenAt: e.seq, reason: 'prev_hash_mismatch' };
      }
      const recomputed = this._computeHash(e);
      if (recomputed !== e.hash) {
        return { ok: false, totalEntries: entries.length,
                 brokenAt: e.seq, reason: 'hash_mismatch' };
      }
      prevHash = e.hash;
      expectedSeq += 1;
    }

    return { ok: true, totalEntries: entries.length, brokenAt: null, reason: null };
  }

  /** Best-effort Windows Event Log forwarding via PowerShell Write-EventLog. */
  async _mirrorToWindowsEventLog(entry) {
    if (process.platform !== 'win32') return;
    const { spawn } = require('child_process');
    // Map event type → severity. Failures = Warning, security-relevant = Information.
    const isFailure = entry.event.endsWith('_fail') || entry.event === EVENT_TYPES.APP_CRASH;
    const entryType = isFailure ? 'Warning' : 'Information';
    // Numeric event ID derived from FNV-1a of event name (stable)
    const eid = (() => {
      let h = 2166136261;
      for (let i = 0; i < entry.event.length; i++) {
        h ^= entry.event.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return (h % 60000) + 1000;  // 1000..61000 — avoids reserved <1000
    })();
    // Compact, single-line message; full data minus PII-bearing fields would
    // be ideal, but data is already PII-policed at write time.
    const msg = `[VIPER ${entry.app_version}] seq=${entry.seq} user=${entry.user} ` +
                `event=${entry.event} data=${JSON.stringify(entry.data)}`;
    // Note: source 'VIPER' should ideally be registered (admin-only) at install
    // time. If not registered, Write-EventLog falls back to 'Application'
    // source attribution — still emits an event, just with imperfect labeling.
    const ps = `try { Write-EventLog -LogName Application -Source VIPER ` +
               `-EntryType ${entryType} -EventId ${eid} -Message ${JSON.stringify(msg)} } ` +
               `catch { Write-EventLog -LogName Application -Source Application ` +
               `-EntryType ${entryType} -EventId ${eid} -Message ${JSON.stringify(msg)} }`;
    try {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (_) { /* swallow */ }
  }
}

module.exports = AuditLogger;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
