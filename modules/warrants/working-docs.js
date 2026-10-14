'use strict';
/**
 * Working Documents — the officer's live Word drafts, kept inside the case.
 *
 * MAIN-PROCESS ONLY. A renderer reload will not pick up a change here.
 *
 * The request this answers: an investigator keeps a running affidavit and
 * several warrant drafts as live Word documents and wants them in the case,
 * one click away, instead of scattered across a desktop. Editing happens in
 * the officer's own Microsoft Word — VIPER's job is to own the file, open it,
 * and make sure every save Word makes ends up in the case.
 *
 * Files live in   cases/<caseNumber>/Warrants/Working/<name>.docx
 * and the folder is the source of truth: there is no localStorage list to
 * drift away from what is actually on disk, and nothing to lose when a case
 * is re-imported under a new internal id.
 *
 * ── Two ways a document is opened ────────────────────────────────────────
 *  Field Security OFF  → Word opens the case file itself. Word's save IS the
 *                        save. VIPER only watches, to show "saved 2:14 PM".
 *  Field Security ON   → the case file is encrypted, which Word cannot read.
 *                        VIPER decrypts a working copy into a private folder
 *                        (a "session"), opens THAT, and every time Word saves
 *                        it, re-encrypts the copy back into the case. When
 *                        Word lets go of the file the plaintext copy is
 *                        deleted.
 *
 * The old generic `open-file` path also decrypts to a temp copy — but it
 * never brings changes back, which for a live document would mean every edit
 * silently lost. That is the trap this module exists to avoid.
 *
 * ── Never lose an officer's words ─────────────────────────────────────────
 *  - Locking the vault or quitting first brings in any save not yet taken.
 *  - A copy Word still holds open when the vault locks is left in place and
 *    brought in at the next unlock (it cannot be encrypted without the key).
 *  - At startup / unlock any leftover session is inspected: a save that
 *    never made it into the case is brought in, and if the case copy ALSO
 *    changed meanwhile, the leftover is kept beside it as "(recovered)".
 *  - A failed write into the case is reported as a failure. It never shows
 *    as saved.
 */

const ALLOWED_EXTS = ['.docx', '.doc', '.rtf'];
const WORKING_SUBDIR = 'Working';
const SESSION_DIR_RE = /^[0-9a-f]{16}$/;
const SESSION_META = 'session.json';
const DEFAULT_POLL_MS = 1500;
const MAX_NAME = 120;

// ─── pure helpers ────────────────────────────────────────────────────────

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i).toLowerCase() : '';
}

function hasAllowedExt(name) {
  return ALLOWED_EXTS.indexOf(extOf(name)) !== -1;
}

/** Strip a known Word extension, if there is one. */
function stripExt(name) {
  const s = String(name || '');
  return hasAllowedExt(s) ? s.slice(0, s.length - extOf(s).length) : s;
}

/**
 * A safe file name, or '' when nothing usable is left. Drops any folder part,
 * Windows-illegal characters and control characters, collapses whitespace,
 * trims dots/spaces (Windows silently drops a trailing dot) and caps length
 * while keeping the extension.
 */
function cleanName(name) {
  let s = String(name == null ? '' : name);
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[<>:"|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) return '';
  if (s.length > MAX_NAME) {
    const ext = extOf(s);
    const keep = ext && ext.length < 10 ? ext : '';
    s = s.slice(0, MAX_NAME - keep.length).replace(/[.\s]+$/, '') + keep;
  }
  // Reserved device names (CON, PRN, AUX, NUL, COM1, LPT1 …) cannot be files.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = '_' + s;
  return s;
}

/** `name` with `ext` on the end, replacing any Word extension it carried. */
function withExt(name, ext) {
  const base = stripExt(name);
  return base ? base + ext : '';
}

/**
 * Files that live beside documents but are not documents: Word's owner file
 * (~$…), Word's save temp files (~WRL0001.tmp), LibreOffice's lock file,
 * VIPER's own half-written temp files, and Explorer clutter.
 */
function isHiddenEntry(name) {
  const s = String(name || '');
  if (!s) return true;
  if (s.startsWith('~$') || s.startsWith('~')) return true;
  if (s.startsWith('.')) return true;           // .~lock.x#  and  .x.viper-tmp
  if (/\.viper-tmp$/i.test(s)) return true;
  if (/\.tmp$/i.test(s)) return true;
  const low = s.toLowerCase();
  return low === 'thumbs.db' || low === 'desktop.ini';
}

/**
 * The first of  name, "base (2).ext", "base (3).ext" …  for which
 * exists(candidate) is false. Case-insensitive on purpose — Windows is.
 */
function nextFreeName(name, exists) {
  const n0 = extOf(name).length;
  const ext = n0 ? name.slice(name.length - n0) : '';   // keep the caller's case
  const base = n0 ? name.slice(0, name.length - n0) : name;
  if (!exists(name)) return name;
  for (let n = 2; n < 10000; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!exists(cand)) return cand;
  }
  throw new Error('Could not find a free file name for ' + name);
}

/** Every name Word or LibreOffice might give the owner/lock file for `name`. */
function ownerFileCandidates(name) {
  const s = String(name || '');
  const out = new Set(['~$' + s, '.~lock.' + s + '#']);
  if (s.length > 1) out.add('~$' + s.slice(1));
  if (s.length > 2) out.add('~$' + s.slice(2));
  return Array.from(out);
}

/**
 * What to do with a leftover working copy found at startup / unlock.
 *   lastHash  — hash of the content last brought into the case
 *   plainHash — hash of the working copy now (null: it is gone)
 *   caseHash  — hash of the case copy now     (null: it is gone)
 *
 *   'nothing'        the working copy is gone; nothing to bring in
 *   'clean'          the working copy holds nothing the case lacks
 *   'ingest'         bring the working copy into the case
 *   'recover-beside' both changed; keep the working copy as a separate file
 */
function sessionDecision({ lastHash, plainHash, caseHash }) {
  if (!plainHash) return 'nothing';
  if (plainHash === lastHash) return 'clean';
  if (caseHash && plainHash === caseHash) return 'clean';
  if (!caseHash || caseHash === lastHash) return 'ingest';
  return 'recover-beside';
}

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ─── the manager ─────────────────────────────────────────────────────────

/**
 * deps:
 *   fs, path, crypto
 *   casesDir()      → current cases root (it can be moved in Settings)
 *   sessionsRoot()  → private folder for decrypted working copies
 *   getSecurity()   → the SecurityManager, or null
 *   openPath(p)     → Promise<string>  ('' on success — shell.openPath)
 *   trashItem(p)    → Promise<void>    (shell.trashItem)
 *   notify(evt)     → push an event to the renderer
 *   probeLocked(p)  → optional; true while another program holds p open
 *   now()           → optional clock
 *   pollMs          → optional
 *   setInterval / clearInterval → optional (tests drive tick() directly)
 */
function createWorkingDocs(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const crypto = deps.crypto;
  const now = deps.now || (() => Date.now());
  const notify = (evt) => { try { deps.notify && deps.notify(evt); } catch (_) {} };
  const pollMs = deps.pollMs || DEFAULT_POLL_MS;
  const setIv = deps.setInterval || setInterval;
  const clearIv = deps.clearInterval || clearInterval;

  const sessions = new Map();   // key → session
  let timer = null;

  const probeLocked = deps.probeLocked || function (p) {
    let fd = null;
    try { fd = fs.openSync(p, 'r+'); return false; }
    catch (e) { return !!e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'); }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  };

  // ── validation ──
  function assertCaseNumber(cn) {
    const s = String(cn == null ? '' : cn);
    if (!s.trim() || /[\\/\x00]/.test(s) || s === '.' || s === '..') {
      throw coded('BAD_CASE', 'This case has no usable case number.');
    }
    return s;
  }
  function assertFileName(name) {
    const s = String(name == null ? '' : name);
    if (!s || s !== cleanName(s) || !hasAllowedExt(s) || isHiddenEntry(s)) {
      throw coded('BAD_NAME', 'That is not a working document name VIPER recognises.');
    }
    return s;
  }
  function keyOf(cn, name) { return cn + '\u0000' + String(name).toLowerCase(); }

  function workingDir(caseNumber) {
    return path.join(deps.casesDir(), assertCaseNumber(caseNumber), 'Warrants', WORKING_SUBDIR);
  }

  // ── security ──
  function sec() { try { return deps.getSecurity ? deps.getSecurity() : null; } catch (_) { return null; } }
  function secState() {
    const s = sec();
    return { s, enabled: !!(s && s.isEnabled()), unlocked: !!(s && s.isUnlocked()) };
  }
  /** Plaintext of a case file, decrypting when it is encrypted. */
  function readCasePlain(full) {
    const raw = fs.readFileSync(full);
    const { s, unlocked } = secState();
    if (s && s.isEncryptedBuffer(raw)) {
      if (!unlocked) throw coded('LOCKED', 'Field Security is locked. Unlock VIPER first.');
      return s.decryptBuffer(raw);
    }
    return raw;
  }
  /** Bytes to put on disk in the case folder for this plaintext. */
  function encodeForCase(plain) {
    const { s, enabled, unlocked } = secState();
    if (!enabled) return plain;
    if (!unlocked) throw coded('LOCKED', 'Field Security is locked. Unlock VIPER first.');
    return s.encryptBuffer(plain);
  }

  function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

  // ── disk ──
  function existsCI(dir) {
    let names;
    try { names = fs.readdirSync(dir).map((n) => n.toLowerCase()); } catch (_) { names = []; }
    const set = new Set(names);
    return (cand) => set.has(String(cand).toLowerCase());
  }

  /** Exclusive-create under the first free name. Never overwrites. */
  function createExclusive(dir, desired, bytes) {
    fs.mkdirSync(dir, { recursive: true });
    const taken = existsCI(dir);
    let name = nextFreeName(desired, taken);
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
        return name;
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          const seen = new Set([name.toLowerCase()]);
          name = nextFreeName(desired, (c) => seen.has(c.toLowerCase()) || taken(c) || fs.existsSync(path.join(dir, c)));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Could not create ' + desired);
  }

  /** Replace `full` without ever leaving it half-written. */
  function writeAtomic(full, bytes) {
    const dir = path.dirname(full);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(full) + '.' + crypto.randomBytes(4).toString('hex') + '.viper-tmp');
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    try { fs.renameSync(tmp, full); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  }

  function statSig(p) {
    try { const st = fs.statSync(p); return st.size + ':' + st.mtimeMs; } catch (_) { return null; }
  }

  function ownerExists(dir, name) {
    for (const cand of ownerFileCandidates(name)) {
      if (fs.existsSync(path.join(dir, cand))) return true;
    }
    return false;
  }
  function isHeld(session) {
    if (!fs.existsSync(session.plainPath)) return false;
    return ownerExists(path.dirname(session.plainPath), path.basename(session.plainPath))
      || !!probeLocked(session.plainPath);
  }

  function sessionsRoot() { return deps.sessionsRoot(); }
  function writeMeta(session) {
    if (session.mode !== 'session') return;
    const meta = {
      v: 1, caseNumber: session.caseNumber, fileName: session.fileName,
      plainName: path.basename(session.plainPath),
      lastHash: session.lastHash, openedAt: new Date(session.openedAt).toISOString(),
    };
    writeAtomic(path.join(session.dir, SESSION_META), Buffer.from(JSON.stringify(meta, null, 2)));
  }
  /** Remove one of OUR session folders — and only one of ours. */
  function removeSessionDir(dir) {
    const root = path.resolve(sessionsRoot());
    const abs = path.resolve(dir);
    if (path.dirname(abs) !== root || !SESSION_DIR_RE.test(path.basename(abs))) return false;
    fs.rmSync(abs, { recursive: true, force: true });
    return !fs.existsSync(abs);
  }

  // ── session lifecycle ──
  function ensureTimer() {
    if (timer || !sessions.size) return;
    timer = setIv(tick, pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function maybeStopTimer() {
    if (timer && !sessions.size) { clearIv(timer); timer = null; }
  }

  /**
   * Bring the working copy's latest save into the case. Returns true when
   * something new was taken in. Throws (LOCKED, disk errors) — callers decide
   * whether that is fatal.
   */
  function syncSession(session) {
    // Signature taken BEFORE the read: if Word writes again in between, the
    // poll sees a newer signature and simply checks once more.
    const sigBefore = statSig(session.plainPath);
    const plain = fs.readFileSync(session.plainPath);
    const h = sha(plain);
    if (h === session.lastHash) { session.lastSig = sigBefore; return false; }
    if (session.mode === 'session') {
      const full = path.join(workingDir(session.caseNumber), session.fileName);
      writeAtomic(full, encodeForCase(plain));
      session.lastHash = h;
      try { writeMeta(session); } catch (_) { /* recovery treats plain===case as clean */ }
    } else {
      session.lastHash = h;
    }
    session.lastSig = sigBefore;
    session.lastSavedAt = now();
    session.error = null;
    notify({
      type: 'saved', caseNumber: session.caseNumber, fileName: session.fileName,
      savedAt: new Date(session.lastSavedAt).toISOString(), bytes: plain.length,
    });
    return true;
  }

  /** Drop a session. For an encrypted session this deletes the plaintext. */
  function dispose(session) {
    if (session.mode === 'session') {
      try { fs.unlinkSync(session.plainPath); }
      catch (e) { if (e && e.code !== 'ENOENT') return false; }
      try { removeSessionDir(session.dir); } catch (_) {}
    }
    sessions.delete(session.key);
    maybeStopTimer();
    notify({ type: 'closed', caseNumber: session.caseNumber, fileName: session.fileName });
    return true;
  }

  function reportError(session, e) {
    const msg = e && e.code === 'LOCKED'
      ? 'VIPER is locked, so this save could not go into the case yet. It is kept and will be brought in when you unlock.'
      : 'Could not save into the case: ' + ((e && e.message) || e) + '. Your work is still open in Word — save again.';
    if (session.error === msg) return;
    session.error = msg;
    notify({ type: 'error', caseNumber: session.caseNumber, fileName: session.fileName, message: msg, code: e && e.code });
  }

  /** One poll. Exposed so tests can drive it without a timer. */
  function tick() {
    for (const session of Array.from(sessions.values())) {
      const sig = statSig(session.plainPath);
      const held = isHeld(session);
      if (held) session.seenHeld = true;

      if (sig && sig !== session.lastSig) {
        // Only read a file whose size and time held still for a whole poll —
        // an editor that writes in place must not be caught half-way.
        if (sig === session.pendingSig) {
          try {
            syncSession(session);
            session.lastSig = sig;
            session.pendingSig = null;
          } catch (e) {
            if (!(e && (e.code === 'EBUSY' || e.code === 'EPERM'))) reportError(session, e);
          }
        } else {
          session.pendingSig = sig;
        }
        continue;
      }
      session.pendingSig = null;

      // Word has let go: take any last save, then clean up. A session that
      // was never seen held (an editor that does not lock files) is kept
      // until lock / quit rather than guessed at.
      if (session.seenHeld && !held) {
        try { syncSession(session); } catch (e) { reportError(session, e); continue; }
        dispose(session);
      }
    }
    maybeStopTimer();
  }

  // ── public API ──

  function list(caseNumber) {
    const dir = workingDir(caseNumber);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const ent of entries) {
      if (!ent.isFile() || isHiddenEntry(ent.name) || !hasAllowedExt(ent.name)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, ent.name)); } catch (_) { continue; }
      const s = sessions.get(keyOf(caseNumber, ent.name));
      out.push({
        fileName: ent.name,
        bytes: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        open: !!s,
        lastSavedAt: s && s.lastSavedAt ? new Date(s.lastSavedAt).toISOString() : null,
        error: s && s.error ? s.error : null,
      });
    }
    out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
    return out;
  }

  /** Add plaintext bytes to the case under (a free variant of) desiredName. */
  function addBuffer(caseNumber, desiredName, plain) {
    const name = cleanName(desiredName);
    if (!name || !hasAllowedExt(name)) throw coded('BAD_NAME', 'Only Word documents (.docx, .doc, .rtf) can be added.');
    const fileName = createExclusive(workingDir(caseNumber), name, encodeForCase(plain));
    return { fileName, bytes: plain.length };
  }

  function importFile(caseNumber, srcPath) {
    const base = path.basename(String(srcPath || ''));
    if (!hasAllowedExt(base)) throw coded('BAD_NAME', `"${base}" is not a Word document (.docx, .doc, .rtf).`);
    return addBuffer(caseNumber, base, fs.readFileSync(srcPath));
  }

  /** A copy of an existing working document under a new name. */
  function newFrom(caseNumber, sourceName, newName) {
    assertFileName(sourceName);
    const src = sessions.get(keyOf(caseNumber, sourceName));
    // If the source is open, take its latest save first so the copy is current.
    if (src) { try { syncSession(src); } catch (_) {} }
    const full = path.join(workingDir(caseNumber), sourceName);
    if (!fs.existsSync(full)) throw coded('NOT_FOUND', `"${sourceName}" is no longer in this case.`);
    const plain = readCasePlain(full);
    const ext = extOf(sourceName);
    const desired = withExt(cleanName(newName), ext) || ('Copy of ' + sourceName);
    return addBuffer(caseNumber, desired, plain);
  }

  function rename(caseNumber, fileName, newName) {
    assertFileName(fileName);
    if (sessions.has(keyOf(caseNumber, fileName))) {
      throw coded('OPEN', `"${fileName}" is open in Word. Close it there first, then rename it.`);
    }
    const dir = workingDir(caseNumber);
    const target = withExt(cleanName(newName), extOf(fileName));
    if (!target) throw coded('BAD_NAME', 'Type a name for the document.');
    if (target === fileName) return { fileName };
    const from = path.join(dir, fileName);
    if (!fs.existsSync(from)) throw coded('NOT_FOUND', `"${fileName}" is no longer in this case.`);
    if (target.toLowerCase() !== fileName.toLowerCase() && existsCI(dir)(target)) {
      throw coded('EXISTS', `There is already a document called "${target}" in this case.`);
    }
    fs.renameSync(from, path.join(dir, target));
    return { fileName: target };
  }

  async function remove(caseNumber, fileName) {
    assertFileName(fileName);
    if (sessions.has(keyOf(caseNumber, fileName))) {
      throw coded('OPEN', `"${fileName}" is open in Word. Close it there first, then remove it.`);
    }
    const full = path.join(workingDir(caseNumber), fileName);
    if (!fs.existsSync(full)) return { removed: false };
    await deps.trashItem(full);
    return { removed: true };
  }

  async function open(caseNumber, fileName) {
    assertFileName(fileName);
    const key = keyOf(caseNumber, fileName);
    const existing = sessions.get(key);
    if (existing) {
      // Already open: hand the SAME copy back to Word (it just comes forward).
      const err = await deps.openPath(existing.plainPath);
      if (err) throw coded('NO_APP', err);
      return { mode: existing.mode, alreadyOpen: true };
    }

    const full = path.join(workingDir(caseNumber), fileName);
    if (!fs.existsSync(full)) throw coded('NOT_FOUND', `"${fileName}" is no longer in this case.`);
    const st = secState();
    const t = now();
    let session;

    if (!st.enabled) {
      const head = fs.readFileSync(full);
      if (st.s && st.s.isEncryptedBuffer(head)) {
        throw coded('LOCKED', `"${fileName}" is encrypted, and Field Security is not set up to unlock it.`);
      }
      session = { key, mode: 'direct', caseNumber, fileName, plainPath: full, lastHash: sha(head) };
    } else {
      if (!st.unlocked) throw coded('LOCKED', 'Field Security is locked. Unlock VIPER first.');
      const plain = readCasePlain(full);
      const id = crypto.randomBytes(8).toString('hex');
      const dir = path.join(sessionsRoot(), id);
      fs.mkdirSync(dir, { recursive: true });
      const plainPath = path.join(dir, fileName);
      fs.writeFileSync(plainPath, plain, { flag: 'wx' });
      session = { key, mode: 'session', id, dir, caseNumber, fileName, plainPath, lastHash: sha(plain) };
    }
    Object.assign(session, {
      openedAt: t, lastSavedAt: null, lastSig: statSig(session.plainPath),
      pendingSig: null, seenHeld: false, error: null,
    });
    try { writeMeta(session); } catch (e) { dispose(session); throw e; }
    sessions.set(key, session);
    ensureTimer();

    let err = '';
    try { err = await deps.openPath(session.plainPath); }
    catch (e) { err = (e && e.message) || String(e); }
    if (err) {
      // Nothing could open it (no Word, no file association). Nothing was
      // edited, so the working copy can go straight away.
      dispose(session);
      throw coded('NO_APP', err);
    }
    notify({ type: 'opened', caseNumber, fileName, mode: session.mode });
    return { mode: session.mode, alreadyOpen: false };
  }

  /**
   * Take in every pending save. Called BEFORE the vault locks and on quit.
   * With final:true, sessions Word has let go of are cleaned up; sessions it
   * still holds stay registered (and on disk) so their later saves are kept.
   */
  function checkInAll(opts) {
    const final = !!(opts && opts.final);
    const out = { saved: [], stillOpen: [], failed: [] };
    for (const session of Array.from(sessions.values())) {
      try { if (syncSession(session)) out.saved.push(session.fileName); }
      catch (e) { out.failed.push({ fileName: session.fileName, error: (e && e.message) || String(e) }); }
      if (!final) continue;
      if (session.mode === 'direct') { dispose(session); continue; }
      if (isHeld(session)) { session.seenHeld = true; out.stillOpen.push(session.fileName); continue; }
      if (!out.failed.some((f) => f.fileName === session.fileName)) dispose(session);
    }
    return out;
  }

  /**
   * Inspect leftover sessions from a crash, a quit with Word still open, or a
   * lock. Needs the key for encrypted cases — sessions it cannot finish yet
   * are left exactly as they are for the next unlock.
   */
  function recover() {
    const out = [];
    const root = sessionsRoot();
    let names;
    try { names = fs.readdirSync(root); } catch (_) { return out; }
    const active = new Set(Array.from(sessions.values()).map((s) => s.id).filter(Boolean));
    for (const id of names) {
      if (!SESSION_DIR_RE.test(id) || active.has(id)) continue;
      const dir = path.join(root, id);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, SESSION_META), 'utf8')); }
      catch (_) { out.push({ id, action: 'unreadable' }); continue; }   // never delete what we cannot identify
      let fileName, caseNumber;
      try { caseNumber = assertCaseNumber(meta.caseNumber); fileName = assertFileName(meta.fileName); }
      catch (_) { out.push({ id, action: 'unreadable' }); continue; }
      const plainPath = path.join(dir, cleanName(meta.plainName || fileName) || fileName);
      const session = {
        key: keyOf(caseNumber, fileName), mode: 'session', id, dir, caseNumber, fileName, plainPath,
        lastHash: meta.lastHash || null, openedAt: Date.parse(meta.openedAt) || now(),
        lastSavedAt: null, lastSig: null, pendingSig: null, seenHeld: false, error: null,
      };
      if (!fs.existsSync(plainPath)) {
        try { removeSessionDir(dir); } catch (_) {}
        out.push({ caseNumber, fileName, action: 'nothing' });
        continue;
      }
      if (sessions.has(session.key)) {   // the same document is open again already
        out.push({ caseNumber, fileName, action: 'skipped-duplicate' });
        continue;
      }
      let action;
      try {
        const plain = fs.readFileSync(plainPath);
        const plainHash = sha(plain);
        const full = path.join(workingDir(caseNumber), fileName);
        const caseHash = fs.existsSync(full) ? sha(readCasePlain(full)) : null;
        action = sessionDecision({ lastHash: session.lastHash, plainHash, caseHash });
        if (action === 'ingest') {
          writeAtomic(full, encodeForCase(plain));
          session.lastHash = plainHash;
        } else if (action === 'recover-beside') {
          const ext = extOf(fileName);
          const made = addBuffer(caseNumber, stripExt(fileName) + ' (recovered)' + ext, plain);
          // Any further saves from a still-open Word go to the recovered copy.
          session.fileName = made.fileName;
          session.key = keyOf(caseNumber, made.fileName);
          session.lastHash = plainHash;
          out.push({ caseNumber, fileName, action, recoveredAs: made.fileName });
        } else {
          session.lastHash = plainHash;
        }
      } catch (e) {
        out.push({ caseNumber, fileName, action: e && e.code === 'LOCKED' ? 'waiting-for-unlock' : 'failed', error: e && e.message });
        continue;
      }
      if (action !== 'recover-beside') out.push({ caseNumber, fileName, action });
      session.lastSig = statSig(plainPath);
      if (isHeld(session)) {
        // Word still has it open (VIPER restarted underneath it): keep watching.
        session.seenHeld = true;
        try { writeMeta(session); } catch (_) {}
        sessions.set(session.key, session);
        ensureTimer();
      } else {
        try { fs.unlinkSync(plainPath); } catch (_) {}
        try { removeSessionDir(dir); } catch (_) {}
      }
      if (action === 'ingest' || action === 'recover-beside') {
        notify({ type: 'recovered', caseNumber, fileName: session.fileName, action });
      }
    }
    return out;
  }

  function active() {
    return Array.from(sessions.values()).map((s) => ({
      caseNumber: s.caseNumber, fileName: s.fileName, mode: s.mode,
      lastSavedAt: s.lastSavedAt ? new Date(s.lastSavedAt).toISOString() : null,
    }));
  }

  function stop() { if (timer) { clearIv(timer); timer = null; } }

  return {
    list, addBuffer, importFile, newFrom, rename, remove, open,
    checkInAll, recover, tick, active, stop,
    workingDir,
    _sessions: sessions,
  };
}

module.exports = {
  createWorkingDocs,
  ALLOWED_EXTS, WORKING_SUBDIR,
  cleanName, hasAllowedExt, extOf, stripExt, withExt, isHiddenEntry,
  nextFreeName, ownerFileCandidates, sessionDecision,
};
