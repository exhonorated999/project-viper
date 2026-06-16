// modules/warrant-author/case-pc-store.js
// ------------------------------------------------------------------
// Per-case shared Probable Cause narrative store.
//
// Design rationale:
//   Probable cause is iterative. A detective writes the initial PC for
//   an ESP / IP warrant to ID a suspect, then builds onto the SAME PC
//   for the residence warrant a week later. The PC therefore lives at
//   the CASE level, not the draft level — a perpetual document that
//   every warrant in this case reads from and writes back to.
//
// Storage:
//   Pattern 2 — localStorage[`casePcNarrative_${caseId}`] holds:
//   { version: 1, body: string, updatedAt: ISO, history: [{ ts, length, label? }] }
//
// Compat:
//   The draft schema still carries `draft.probableCauseNarrative` so
//   the validator (P7) and template engine (P4) don't need to change.
//   The UI mirrors case-level PC into every draft on save (one-way:
//   case → drafts), keeping the snapshot model intact for when a
//   warrant is later finalized/served and the PC needs to freeze.
// ------------------------------------------------------------------

(function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const PREFIX = 'casePcNarrative_';
  const MAX_HISTORY = 20;

  function _key(caseId) { return PREFIX + String(caseId); }

  function _now() { return new Date().toISOString(); }

  function _safeRead(caseId) {
    try {
      const raw = localStorage.getItem(_key(caseId));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (_e) { return null; }
  }

  function _safeWrite(caseId, obj) {
    try {
      localStorage.setItem(_key(caseId), JSON.stringify(obj));
      return true;
    } catch (_e) { return false; }
  }

  // ── Public API ──────────────────────────────────────────────

  /** Returns the current PC narrative body for the case (string, may be ''). */
  function getBody(caseId) {
    const rec = _safeRead(caseId);
    return rec && typeof rec.body === 'string' ? rec.body : '';
  }

  /**
   * Returns the case-level offense description (string, may be '').
   * Used by CO templates (`{{case.offenseDescription}}`) and any future
   * jurisdictions that need a single offense identifier across every
   * warrant in the case. UI lives in the Case Probable Cause panel.
   */
  function getOffenseDescription(caseId) {
    const rec = _safeRead(caseId);
    return rec && typeof rec.offenseDescription === 'string' ? rec.offenseDescription : '';
  }

  /**
   * Returns the case-level offense date (ISO YYYY-MM-DD or '').
   * Used by CO templates (`{{case.offenseDate}}`).
   */
  function getOffenseDate(caseId) {
    const rec = _safeRead(caseId);
    return rec && typeof rec.offenseDate === 'string' ? rec.offenseDate : '';
  }

  /** Returns the full record { version, body, updatedAt, history } or a fresh empty one. */
  function getRecord(caseId) {
    const rec = _safeRead(caseId);
    if (rec) return rec;
    return { version: SCHEMA_VERSION, body: '', offenseDescription: '', offenseDate: '', updatedAt: null, history: [] };
  }

  /**
   * Writes the new body. Pushes a small history entry when the diff is
   * non-trivial (≥10 char delta) so we keep an audit trail of growth.
   * Returns the new record.
   */
  function setBody(caseId, body, opts) {
    opts = opts || {};
    const next = String(body == null ? '' : body);
    const cur = getRecord(caseId);
    const prev = cur.body || '';
    const rec = {
      version: SCHEMA_VERSION,
      body: next,
      offenseDescription: cur.offenseDescription || '',
      offenseDate: cur.offenseDate || '',
      updatedAt: _now(),
      history: Array.isArray(cur.history) ? cur.history.slice() : []
    };
    const sizeDelta = Math.abs(next.length - prev.length);
    if (sizeDelta >= 10 || opts.label) {
      rec.history.unshift({
        ts: rec.updatedAt,
        length: next.length,
        delta: next.length - prev.length,
        label: opts.label || ''
      });
      if (rec.history.length > MAX_HISTORY) rec.history.length = MAX_HISTORY;
    }
    _safeWrite(caseId, rec);
    return rec;
  }

  /**
   * Set the case-level offense description. Lightweight — no history
   * entry (these are short scalar fields, not the narrative). Returns
   * the updated record.
   */
  function setOffenseDescription(caseId, value) {
    const cur = getRecord(caseId);
    const rec = Object.assign({}, cur, {
      offenseDescription: String(value == null ? '' : value),
      updatedAt: _now(),
    });
    _safeWrite(caseId, rec);
    return rec;
  }

  /**
   * Set the case-level offense date. Accepts ISO YYYY-MM-DD or ''.
   * Returns the updated record.
   */
  function setOffenseDate(caseId, value) {
    const cur = getRecord(caseId);
    const rec = Object.assign({}, cur, {
      offenseDate: String(value == null ? '' : value),
      updatedAt: _now(),
    });
    _safeWrite(caseId, rec);
    return rec;
  }

  /**
   * Initial-load migration: if case-level PC is empty AND a draft on this
   * case already has a PC narrative, promote the longest non-empty draft
   * PC up to the case level. Idempotent — once promoted, every subsequent
   * call no-ops because case body is non-empty.
   */
  function promoteFromDrafts(caseId, drafts) {
    const cur = getRecord(caseId);
    if (cur.body && cur.body.trim()) return cur;
    if (!Array.isArray(drafts) || !drafts.length) return cur;
    let best = '';
    for (const d of drafts) {
      const pc = (d && typeof d.probableCauseNarrative === 'string') ? d.probableCauseNarrative : '';
      if (pc.length > best.length) best = pc;
    }
    if (!best.trim()) return cur;
    return setBody(caseId, best, { label: 'auto-promoted from draft' });
  }

  /** Stats for the editor footer. */
  function stats(caseId) {
    const rec = getRecord(caseId);
    const body = rec.body || '';
    const words = body ? body.trim().split(/\s+/).filter(Boolean).length : 0;
    return {
      chars: body.length,
      words,
      updatedAt: rec.updatedAt,
      revisionCount: (rec.history || []).length
    };
  }

  // ── Exports ─────────────────────────────────────────────────
  const API = {
    SCHEMA_VERSION,
    getBody,
    getRecord,
    setBody,
    getOffenseDescription,
    setOffenseDescription,
    getOffenseDate,
    setOffenseDate,
    promoteFromDrafts,
    stats
  };

  if (typeof window !== 'undefined') window.WarrantAuthorCasePcStore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
