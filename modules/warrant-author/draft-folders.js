'use strict';
/**
 * Warrant Author — readable per-draft folders.
 *
 * MAIN-PROCESS ONLY (plain fs, no electron). A renderer reload will not pick
 * up a change here.
 *
 * Every working copy keeps its own folder under
 *   cases/<caseNumber>/Warrants/Drafts/<label>/
 * where <label> reads like "Google ESP - SW 24-001". The folder holds
 * manifest.json, warrant.pdf, warrant.docx and a small plain sidecar,
 * `.viper-draft.json` = { id, files }, which is how a warrant id is found
 * again after the folder was named (or renamed) for people. The sidecar
 * carries no case data: only the internal id and the size/time stamp of the
 * files VIPER last wrote, so it stays readable while Field Security is
 * locked.
 *
 * Folders written by older builds are named after the bare warrant id
 * ("wa-…"). They are still found, and get their readable name the next time
 * the draft is saved.
 *
 * Never lose an officer's edits: before a refresh overwrites warrant.docx /
 * warrant.pdf, the file on disk is compared with the stamp of the copy VIPER
 * last wrote. If someone changed it in Word (or annotated the PDF), that
 * file is first moved aside as "warrant (edited 2026-11-17 1432).docx".
 * A file the user has open (Word locks it) is skipped and reported as busy;
 * the next refresh tries again.
 */

const fs = require('fs');
const path = require('path');
const { cleanName, nextFreeName } = require('../warrants/working-docs');

const SIDECAR = '.viper-draft.json';
const MAX_LABEL = 80;

// ─── label ───────────────────────────────────────────────────────────────

function _titleKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  return s.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "Google", "Google & Meta", "Google, Meta + 2 more" */
function _joinNames(names) {
  const list = [];
  for (const n of names) {
    const t = String(n || '').trim();
    if (t && !list.some((x) => x.toLowerCase() === t.toLowerCase())) list.push(t);
  }
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return list[0] + ' & ' + list[1];
  return list[0] + ', ' + list[1] + ' + ' + (list.length - 2) + ' more';
}

/**
 * Human folder label for a draft. `providerNames` (optional) are the display
 * names of the addendum providers in order; without them the provider keys
 * are title-cased ("google" → "Google").
 */
function buildLabel(draft, providerNames) {
  const d = (draft && typeof draft === 'object') ? draft : {};
  const sw = String(d.swNumber || '').trim();
  let head;
  if (d.type === 'residential') {
    head = 'Residential';
  } else {
    const names = Array.isArray(providerNames) && providerNames.length
      ? providerNames
      : (Array.isArray(d.addendums) ? d.addendums.map((a) => _titleKey(a && (a.businessName || a.providerKey))) : []);
    const who = _joinNames(names);
    head = who ? who + ' ESP' : 'ESP Warrant';
  }
  return sw ? head + ' - SW ' + sw : head;
}

/** A safe Windows folder name for `label`, or `fallback` when nothing usable is left. */
function safeFolderName(label, fallback) {
  let s = cleanName(String(label || '').replace(/[\\/]/g, '-'));
  if (s.length > MAX_LABEL) s = s.slice(0, MAX_LABEL).replace(/[.\s]+$/, '');
  return s || cleanName(fallback) || 'Warrant draft';
}

/**
 * The folder label a caller asked for, or null when it did not say.
 *
 * The renderer stamps `folderProviders` (provider display names in addendum
 * order; [] for a residential warrant) or a ready `folderLabel` on the copy it
 * sends. Without either, an existing folder keeps its name — so an older
 * caller can never rename a folder back and forth — and a new folder gets a
 * label derived from the provider keys.
 */
function labelFor(draft) {
  const d = (draft && typeof draft === 'object') ? draft : {};
  const given = typeof d.folderLabel === 'string' ? d.folderLabel.trim() : '';
  if (given) return given;
  if (Array.isArray(d.folderProviders)) return buildLabel(d, d.folderProviders);
  return null;
}

// ─── sidecar ─────────────────────────────────────────────────────────────

function readSidecar(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR), 'utf-8'));
    return (o && typeof o === 'object') ? o : null;
  } catch (_e) { return null; }
}

function writeSidecar(dir, obj) {
  fs.writeFileSync(path.join(dir, SIDECAR), JSON.stringify(obj, null, 2), 'utf-8');
}

function _subdirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_e) { return []; }
}

// ─── lookup ──────────────────────────────────────────────────────────────

/**
 * Every draft folder under `root`: [{ id, dir, name }]. The id comes from the
 * sidecar; a legacy folder (no sidecar) is its own id.
 */
function listEntries(root) {
  const out = [];
  for (const name of _subdirs(root)) {
    const dir = path.join(root, name);
    const sc = readSidecar(dir);
    const id = sc && typeof sc.id === 'string' && sc.id ? sc.id : name;
    out.push({ id, dir, name });
  }
  return out;
}

/** Absolute folder of warrant `id` under `root`, or null when it has none yet. */
function findDir(root, id) {
  const want = String(id || '');
  if (!want || !root) return null;
  // Readable folder whose sidecar names this id.
  for (const name of _subdirs(root)) {
    const dir = path.join(root, name);
    const sc = readSidecar(dir);
    if (sc && sc.id === want) return dir;
  }
  // Legacy folder named after the id (and not claimed by another draft).
  const legacy = path.join(root, want);
  try {
    if (fs.statSync(legacy).isDirectory()) {
      const sc = readSidecar(legacy);
      if (!sc || !sc.id || sc.id === want) return legacy;
    }
  } catch (_e) { /* none */ }
  return null;
}

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True when folder name `name` is `base` or a numbered twin "base (2)". */
function _isNameFor(name, base) {
  return new RegExp('^' + _escapeRe(base) + '( \\(\\d+\\))?$', 'i').test(name);
}

/**
 * Make sure warrant `id` has its readable folder under `root`, creating or
 * renaming as needed. Returns { dir, renamed, created }.
 *
 * `label` null/'' = "no opinion": an existing folder keeps its name and a new
 * one is named from `draft` (provider keys). A rename that Windows refuses
 * (Explorer or Word holding a file inside) is not an error: the draft keeps
 * its current folder and the rename is tried again on the next save.
 */
function ensureDir(root, id, label, draft) {
  fs.mkdirSync(root, { recursive: true });
  const exists = (n) => fs.existsSync(path.join(root, n));
  const cur = findDir(root, id);
  if (cur) {
    const curName = path.basename(cur);
    let dir = cur;
    let renamed = false;
    const want = label ? safeFolderName(label, id) : '';
    if (want && !_isNameFor(curName, want)) {
      const target = path.join(root, nextFreeName(want, exists));
      try { fs.renameSync(cur, target); dir = target; renamed = true; }
      catch (_e) { dir = cur; }
    }
    const sc = readSidecar(dir);
    if (!sc || sc.id !== id) writeSidecar(dir, Object.assign({}, sc || {}, { id }));
    return { dir, renamed, created: false };
  }
  const want = safeFolderName(label || buildLabel(draft), id);
  const dir = path.join(root, nextFreeName(want, exists));
  fs.mkdirSync(dir, { recursive: true });
  writeSidecar(dir, { id, files: {} });
  return { dir, renamed: false, created: true };
}

// ─── guarded writes ──────────────────────────────────────────────────────

function _stamp(st) { return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }; }

function _sameStamp(a, b) {
  return !!(a && b && a.size === b.size && Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) <= 2);
}

function _editedName(fileName, when) {
  const d = when instanceof Date ? when : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  return `${base} (edited ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())})${ext}`;
}

function _isBusy(e) {
  return !!(e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'));
}

/**
 * Write `buf` to dir/fileName without destroying an edit someone made to the
 * previous copy. Keeps the sidecar stamp current.
 *
 * Returns { written, path, keptAs?, busy?, error? }.
 */
function writeGuarded(dir, fileName, buf, opts) {
  const o = opts || {};
  const filePath = path.join(dir, fileName);
  const sc = readSidecar(dir) || {};
  const files = (sc.files && typeof sc.files === 'object') ? sc.files : {};
  const last = files[fileName] || null;
  const res = { written: false, path: filePath };

  let st = null;
  try { st = fs.statSync(filePath); } catch (_e) { st = null; }
  if (st && last && !_sameStamp(_stamp(st), last)) {
    // Changed since VIPER wrote it — keep the officer's version beside it.
    const aside = nextFreeName(_editedName(fileName, o.now || new Date(st.mtimeMs)),
      (n) => fs.existsSync(path.join(dir, n)));
    try {
      fs.renameSync(filePath, path.join(dir, aside));
      res.keptAs = aside;
    } catch (e) {
      if (_isBusy(e)) { res.busy = true; return res; }
      res.error = e.message; return res;
    }
  }
  try {
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    if (_isBusy(e)) { res.busy = true; return res; }
    res.error = e.message; return res;
  }
  res.written = true;
  try {
    const now = fs.statSync(filePath);
    files[fileName] = _stamp(now);
    writeSidecar(dir, Object.assign({}, sc, { id: sc.id || o.id || '', files }));
  } catch (_e) { /* the file itself is written; a missing stamp only means no edit check next time */ }
  return res;
}

module.exports = {
  SIDECAR,
  buildLabel, safeFolderName, labelFor,
  readSidecar, writeSidecar,
  listEntries, findDir, ensureDir, writeGuarded,
  _editedName, _isNameFor, _joinNames,
};
