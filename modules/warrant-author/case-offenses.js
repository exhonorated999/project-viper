// modules/warrant-author/case-offenses.js
// ------------------------------------------------------------------
// Every offense on a case, as one warrant-ready string.
//
// The case Overview holds a primary offense plus any number of
// additional offenses (or, on old cases, a newline-separated `charges`
// field). The Warrant Author used to read only `primaryOffense`, so a
// case with three charges produced a warrant that named one.
//
// Each entry is kept verbatim EXCEPT a bare statute number: when the
// examiner typed just "13-3553" and the Offense Reference library has
// that code, it is expanded to "13-3553 - <description>" so the warrant
// names the offense, not just its number. Text that already carries a
// description is never reworded.
//
// join() uses semicolons because offense descriptions contain commas.
// ------------------------------------------------------------------

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WarrantAuthorCaseOffenses = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

  // Codes compare without case, spacing, a leading "§" or "ARS"/"C.R.S."-
  // style prefixes the examiner may or may not have typed.
  function codeKey(v) {
    return str(v).toLowerCase()
      .replace(/^(§+|sec\.?|section)\s*/, '')
      .replace(/\s+/g, '');
  }

  function entryText(item) {
    if (item == null) return '';
    if (typeof item === 'string') return str(item);
    return str(item.offense);
  }

  /** Raw offense strings in Overview order: primary, additional, legacy charges. */
  function rawList(rec) {
    if (!rec) return [];
    const out = [];
    const primary = str(rec.primaryOffense);
    if (primary) out.push(primary);
    const extra = Array.isArray(rec.additionalOffenses) ? rec.additionalOffenses : [];
    extra.forEach(function (it) { const t = entryText(it); if (t) out.push(t); });
    if (!extra.length && rec.charges) {
      String(rec.charges).split(/\r?\n/).forEach(function (l) { const t = str(l); if (t) out.push(t); });
    }
    return out;
  }

  function libraryIndex(lib) {
    const idx = {};
    (Array.isArray(lib) ? lib : []).forEach(function (o) {
      if (!o || o.kind === 'caselaw') return;
      const k = codeKey(o.code);
      const d = str(o.description);
      if (k && d && !idx[k]) idx[k] = { code: str(o.code), description: d };
    });
    return idx;
  }

  /** Expand a bare code to "code - description" when the library knows it. */
  function expand(text, idx) {
    const t = str(text);
    if (!t) return '';
    const hit = idx[codeKey(t)];
    if (hit) return t + ' - ' + hit.description;
    return t;
  }

  /** All offenses on the case, codes expanded, duplicates removed. */
  function list(rec, lib) {
    const idx = libraryIndex(lib);
    const seen = {};
    const out = [];
    rawList(rec).forEach(function (t) {
      const v = expand(t, idx);
      const k = v.toLowerCase();
      if (v && !seen[k]) { seen[k] = true; out.push(v); }
    });
    return out;
  }

  /** "a" · "a and b" · "a; b; and c" */
  function join(items) {
    const a = (items || []).map(str).filter(Boolean);
    if (a.length <= 1) return a[0] || '';
    if (a.length === 2) return a[0] + ' and ' + a[1];
    return a.slice(0, -1).join('; ') + '; and ' + a[a.length - 1];
  }

  function describe(rec, lib) { return join(list(rec, lib)); }

  /** The chargeable library from the page, or [] outside the app. */
  function pageLibrary() {
    try {
      const g = typeof window !== 'undefined' ? window : null;
      if (!g) return [];
      if (g.OffenseReference) return g.OffenseReference.chargeable(g.OffenseReference.loadAll(g.localStorage));
      const raw = g.localStorage && g.localStorage.getItem('viperOffenseReference');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (o) { return o && o.kind !== 'caselaw'; }) : [];
    } catch (_e) { return []; }
  }

  return { rawList: rawList, list: list, join: join, describe: describe, expand: expand, libraryIndex: libraryIndex, pageLibrary: pageLibrary };
}));
