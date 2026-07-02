// modules/warrant-author/warrant-author-ui.js
// Renderer-side authoring UI for the Warrant Author tab.
//
// Loaded by case-detail-with-analytics.html. Exposes WarrantAuthorUI on
// window. The case page calls into:
//   WarrantAuthorUI.renderSubtab(caseId, subtabName)  → HTML string
//   WarrantAuthorUI.bus.onClickNewDraft(caseId)
//   WarrantAuthorUI.bus.onOpenDraft(caseId, draftId)
//   WarrantAuthorUI.bus.onBackToList(caseId)
//   …etc.
//
// Depends on (load order matters):
//   agency-profile.js, provider-directory.js, items-taxonomy.js,
//   template-engine.js, boilerplate-library.js, draft-store.js
//
// IIFE-wrapped per the established Warrant Author convention.
'use strict';

(function () {
const SCHEMA_VERSION = 1;

// ─── module handles (resolved lazily on first use) ──────────────────────

function _store()    { return window.WarrantAuthorDraftStore || null; }
function _agency()   { return window.WarrantAuthorAgencyProfile || null; }
function _pdir()     { return window.WarrantAuthorProviderDirectory || null; }
function _items()    { return window.WarrantAuthorItemsTaxonomy || null; }
function _engine()   { return window.WarrantAuthorTemplateEngine || null; }
function _boiler()   { return window.WarrantAuthorBoilerplateLibrary || null; }
function _validator(){ return window.WarrantAuthorValidator || null; }

function _loadAgencyProfile() {
  try {
    const raw = localStorage.getItem('viperAgencyProfile');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) { return {}; }
}

// Merge the LIVE agency profile with the draft's frozen affiantSnapshot.
// Non-empty snapshot values win (preserves fidelity for a served/finalized
// warrant), but BLANK snapshot fields fall back to the live profile. This
// fixes the CO compose path, which previously read draft.affiantSnapshot
// ONLY — so a draft created before the agency profile was filled out (or
// edited afterward) lost affiantName / affiantRank / affiantBadge /
// trainingExperienceBoilerplate and rendered them as raw {{...}} slots.
// The residential/CA paths already merged; CO did not.
function _mergeAgencyForDraft(draft) {
  const live = _loadAgencyProfile() || {};
  const snap = (draft && draft.affiantSnapshot && typeof draft.affiantSnapshot === 'object')
    ? draft.affiantSnapshot : {};
  const merged = Object.assign({}, live);
  Object.keys(snap).forEach((k) => {
    const v = snap[k];
    // Non-empty snapshot value wins; '' / null / undefined defers to live.
    if (v !== '' && v != null) merged[k] = v;
  });
  return merged;
}

// Resolve the case-level Probable Cause narrative for a draft. Source of
// truth is the case PC store (casePcNarrative_${caseId}); falls back to the
// draft's mirrored copy. The CO template renders this via
// {{addendum.probableCause}}, so it must be injected into adForEngine.
function _resolvePcForDraft(caseId, draft) {
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  const fromStore = (pcStore && pcStore.getBody && caseId) ? pcStore.getBody(caseId) : '';
  return (fromStore && String(fromStore).trim())
    ? fromStore
    : ((draft && draft.probableCauseNarrative) || '');
}

// Default basis sentence used when the affiant leaves the date-range basis
// field blank, so the CO template's block 15 never prints a raw
// {{addendum.dateRangeBasis}} token. The affiant can override via the UI.
const CO_DEFAULT_DATE_RANGE_BASIS =
  'the date range corresponds to the period relevant to the offenses under ' +
  'investigation as described in the facts set forth above.';

function _resolveDateRangeBasis(ad) {
  const v = (ad && ad.dateRangeBasis != null) ? String(ad.dateRangeBasis).trim() : '';
  return v || CO_DEFAULT_DATE_RANGE_BASIS;
}

// ─── CO-specific compose-ctx helpers ────────────────────────────────────
// Resolve the per-draft Colorado court + case info needed by the CO
// template's co-caption / co-affiant-signature / co-judge-* / co-da-*
// block resolvers. Harmless on other templates — non-CO resolvers
// simply ignore ctx.court and ctx.case.
function _resolveCoCourtForDraft(draft) {
  try {
    const ap = _agency();
    if (!ap) return null;
    // Prefer the per-draft snapshot's courts list (frozen at draft
    // creation). Fall back to the live profile so a court added AFTER
    // the draft was created is still selectable.
    const snapshot = (draft && draft.affiantSnapshot) || {};
    const snapList = Array.isArray(snapshot.coCourts) ? snapshot.coCourts : [];
    if (draft && draft.coCourtId) {
      const snapMatch = snapList.find(c => c.id === draft.coCourtId);
      if (snapMatch) {
        return {
          name: snapMatch.courtName || 'COUNTY/DISTRICT COURT',
          judicialDistrict: snapMatch.judicialDistrict || '',
          county: snapMatch.county || '',
        };
      }
    }
    const profile = ap.normalize(_loadAgencyProfile());
    const court = ap.getCoCourtById(profile, draft && draft.coCourtId);
    if (court) {
      return {
        name: court.courtName || 'COUNTY/DISTRICT COURT',
        judicialDistrict: court.judicialDistrict || '',
        county: court.county || '',
      };
    }
    // ── Fallback path: no court picked, and/or the Colorado Courts list
    // is empty. Build a court object from the draft's header fields +
    // the agency's "Default Court Name". This is the path single-court
    // agencies use — the CO courts list is optional, intended for
    // agencies that straddle multiple Judicial Districts.
    const courtName =
      String((draft && draft.courtName) || '').trim() ||
      String(profile.defaultCourtName || '').trim() ||
      '';
    const judicialDistrict = String((draft && draft.judicialDistrict) || '').trim();
    const county = String(profile.county || '').trim();
    if (!courtName && !judicialDistrict && !county) return null;
    return {
      name: courtName || 'COUNTY/DISTRICT COURT',
      judicialDistrict,
      county,
    };
  } catch (_) { return null; }
}
function _resolveCaseCtxForDraft(draft) {
  if (!draft) return {};
  // Case-level overrides (offense description + date live on the Case
  // Probable Cause panel — case-pc-store). Fall back to draft fields so
  // legacy drafts authored before the case-level store existed still work.
  let caseOffenseDesc = '';
  let caseOffenseDate = '';
  try {
    const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    const caseId  = (window.currentCase && (window.currentCase.id || window.currentCase.caseId)) || _state.caseId;
    if (pcStore && caseId) {
      caseOffenseDesc = pcStore.getOffenseDescription(caseId) || '';
      caseOffenseDate = pcStore.getOffenseDate(caseId) || '';
    }
  } catch (_e) { /* non-fatal */ }
  return {
    number: draft.caseRef || draft.caseNumber || '',
    offenseDescription: caseOffenseDesc || draft.offenseDescription || '',
    offenseDate:        caseOffenseDate || draft.offenseDate || '',
  };
}

// ─── ephemeral renderer state (not persisted) ───────────────────────────

const _state = {
  caseId: null,
  subtab: 'drafts',   // drafts | outstanding | returned
  view: 'list',       // list | editor
  activeDraftId: null,
  activeAddendumId: null,
  // CA Options panel open/closed state — persisted in memory only so the
  // <details> doesn't snap shut every time _rerender rebuilds the DOM
  // after a checkbox toggle. Defaults to open until the user collapses
  // it manually. Reset to undefined on draft switch so each new draft
  // starts with the panel visible.
  caOptionsOpen: undefined,
  // VA Options panel open/closed state — same pattern as caOptionsOpen,
  // applies to the VA-specific options panel (item 5, night service,
  // knowledge basis, target accounts, advanced DC-339).
  vaOptionsOpen: undefined,
  // VA advanced DC-339 inner <details> open/closed state.
  vaAdvancedDc339Open: undefined,
};

function _selectDraft(caseId, draftId) {
  _state.caseId = caseId;
  _state.activeDraftId = draftId;
  const d = _store() ? _store().getDraft(caseId, draftId) : null;
  _state.activeAddendumId = (d && d.addendums && d.addendums[0]) ? d.addendums[0].id : null;
  _state.view = 'editor';
  _state.caOptionsOpen = undefined;  // each new draft starts with options panel open
  _state.vaOptionsOpen = undefined;
  _state.vaAdvancedDc339Open = undefined;
}

function _backToList() {
  _state.view = 'list';
  _state.activeDraftId = null;
  _state.activeAddendumId = null;
}

// ─── escape helpers ─────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function attr(s) { return esc(s); }

// ─── dot-path / blob helpers (residential editor) ───────────────────────

/**
 * Set a value on a deeply nested object by dot-path. Numeric segments are
 * treated as array indices (e.g. 'residential.suspects.0.name').
 * Creates intermediate objects/arrays as needed.
 */
function _setByPath(root, path, value) {
  if (!root || typeof root !== 'object' || !path) return;
  const parts = String(path).split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = nextIsIndex ? [] : {};
    }
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  cur[last] = value;
}
function _getByPath(root, path) {
  if (!root || !path) return undefined;
  const parts = String(path).split('.');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/** Returns a sensible blank row to append to a residential list. */
function _blankRowFor(listPath) {
  if (listPath === 'residential.offenses')          return { code: '', label: '' };
  if (listPath === 'residential.suspects')          return { name: '', aliases: '', dob: '', descriptors: '', address: '' };
  if (listPath === 'residential.itemsToSeize.blocks') return { id: 'custom-' + Date.now().toString(36), label: '', body: '' };
  if (listPath === 'residential.sopc.sections')     return { heading: '', body: '' };
  return {};
}

/** Render the residential validator result panel (legacy bottom-mount
 *  variant — still used by `onResidentialValidate` for back-compat).
 *  The active editor uses `_renderResidentialValidatorPanel` instead,
 *  which mirrors the ESP validator-panel look (collapsible banner +
 *  scope chips + auto-runs on every render).
 */
function _renderResidentialValidation(result) {
  if (!result) return '';
  const errs = Array.isArray(result.errors) ? result.errors : [];
  const warns = Array.isArray(result.warnings) ? result.warnings : [];
  if (result.ok && warns.length === 0) {
    return `<div class="bg-emerald-500/10 border border-emerald-500/40 rounded p-3 text-sm text-emerald-200">
      ✓ Validator passed — draft ready for export.
    </div>`;
  }
  const errLines = errs.map(e =>
    `<li class="text-rose-200"><span class="font-mono text-rose-400">●</span> ${esc(e.label || e.message || String(e))}</li>`
  ).join('');
  const warnLines = warns.map(w =>
    `<li class="text-amber-200"><span class="font-mono text-amber-400">○</span> ${esc(w.label || w.message || String(w))}</li>`
  ).join('');
  return `
    <div class="bg-slate-800/50 border border-slate-600 rounded p-3 text-sm space-y-2">
      ${errs.length ? `<div><div class="text-rose-300 font-semibold mb-1">${errs.length} error${errs.length === 1 ? '' : 's'} blocking export:</div><ul class="space-y-1 pl-2">${errLines}</ul></div>` : ''}
      ${warns.length ? `<div><div class="text-amber-300 font-semibold mb-1">${warns.length} warning${warns.length === 1 ? '' : 's'}:</div><ul class="space-y-1 pl-2">${warnLines}</ul></div>` : ''}
    </div>
  `;
}

/**
 * Auto-runs the residential validator and renders the result panel
 * using the same `wa-validator*` CSS the ESP panel uses. Returns
 * markup ready to be injected at the top of the editor.
 *
 * Pulls the case-level Case Probable Cause narrative and passes it
 * along so PC_NARRATIVE_EMPTY fires correctly.
 */
function _renderResidentialValidatorPanel(caseId, draft) {
  const v = (typeof window !== 'undefined') ? window.WarrantAuthorValidator : null;
  if (!v || typeof v.validateResidential !== 'function') {
    return `<div class="wa-validator wa-validator--unloaded">Validator not loaded.</div>`;
  }
  const agency = _loadAgencyProfile();
  const agencyMerged = Object.assign({}, agency, draft.affiantSnapshot || {});
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  const pcNarrative = (pcStore && pcStore.getBody)
    ? pcStore.getBody(caseId)
    : (draft.probableCauseNarrative || '');
  let result;
  try {
    result = v.validateResidential({ draft, agency: agencyMerged, pcNarrative });
  } catch (_e) {
    return `<div class="wa-validator wa-validator--unloaded">Validator threw: ${esc(_e && _e.message || String(_e))}</div>`;
  }
  const { errors, warnings } = result;
  const stats = result.stats || {};

  let tone = 'ok';
  let icon = '✓';
  let title = 'Pre-flight: ready to generate';
  if (errors.length) {
    tone = 'fail'; icon = '⛔';
    title = errors.length + ' hard error' + (errors.length === 1 ? '' : 's') +
            ' — generation blocked';
  } else if (warnings.length) {
    tone = 'warn'; icon = '⚠';
    title = warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') +
            ' — generation allowed';
  }

  const sub = `${stats.offenseCount || 0} offense${stats.offenseCount === 1 ? '' : 's'} · ` +
              `${stats.itemBlockCount || 0} item block${stats.itemBlockCount === 1 ? '' : 's'} · ` +
              `${errors.length} error${errors.length === 1 ? '' : 's'} · ` +
              `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;

  const chip = (issue) => {
    const sc = issue.scope || '';
    if (sc === 'agency')      return `<span class="wa-vl-chip wa-vl-chip--agency">Agency</span>`;
    if (sc === 'residential') return `<span class="wa-vl-chip wa-vl-chip--draft">Premises</span>`;
    if (sc === 'case')        return `<span class="wa-vl-chip wa-vl-chip--compose">Case PC</span>`;
    if (sc === 'draft')       return `<span class="wa-vl-chip wa-vl-chip--draft">Draft</span>`;
    return '';
  };
  const renderIssue = (issue) => {
    const label = issue.label || issue.message || issue.code || String(issue);
    const code  = issue.code  ? `<span class="text-[10px] font-mono text-slate-500 ml-2">[${esc(issue.code)}]</span>` : '';
    return `<li data-code="${attr(issue.code || '')}">${chip(issue)} ${esc(label)}${code}</li>`;
  };

  const errorList = errors.length ? `
    <details class="wa-validator-group wa-validator-group--err" open>
      <summary>
        <span class="wa-vg-icon">⛔</span>
        <span class="wa-vg-title">${errors.length} hard error${errors.length === 1 ? '' : 's'}</span>
      </summary>
      <ul class="wa-validator-list">
        ${errors.map(renderIssue).join('')}
      </ul>
    </details>
  ` : '';

  const warnList = warnings.length ? `
    <details class="wa-validator-group wa-validator-group--warn"${errors.length ? '' : ' open'}>
      <summary>
        <span class="wa-vg-icon">⚠</span>
        <span class="wa-vg-title">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>
      </summary>
      <ul class="wa-validator-list">
        ${warnings.map(renderIssue).join('')}
      </ul>
    </details>
  ` : '';

  const body = (errors.length || warnings.length)
    ? `<div class="wa-validator-body">${errorList}${warnList}</div>`
    : `<div class="wa-validator-body wa-validator-body--ok">All checks pass — safe to generate.</div>`;

  return `
    <details class="wa-validator wa-validator--${tone}"${errors.length ? ' open' : ''}>
      <summary class="wa-validator-summary">
        <span class="wa-validator-icon">${icon}</span>
        <span class="wa-validator-title">${esc(title)}</span>
        <span class="wa-validator-sub">${esc(sub)}</span>
        <span class="wa-validator-chevron">▾</span>
      </summary>
      ${body}
    </details>
  `;
}

/**
 * Render a block-stream as readable HTML for the right-side Live
 * Preview pane. Mirrors the look of the ESP preview but works on the
 * residential block kinds emitted by `_buildCaResidential`. Pure CSS,
 * no jsPDF needed — this is just a visual approximation so the user
 * can confirm the document shape before exporting.
 */
function _residentialBlocksToHtml(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return '<div class="wa-lp-empty">No blocks emitted yet — fill in premises + offenses to start the preview.</div>';
  }
  const out = [];
  let pageIdx = 1;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const k = b.kind || '';
    const text = (b.text != null) ? String(b.text) : '';
    if (k === 'page-break') {
      pageIdx += 1;
      out.push(`<div class="wa-lp-pagebreak">— Page ${pageIdx} —</div>`);
    } else if (k === 'cover-heading') {
      out.push(`<div class="wa-lp-coverhead">${esc(text)}</div>`);
    } else if (k === 'cover-subheading' || k === 'cover-meta') {
      out.push(`<div class="wa-lp-covermeta">${esc(text)}</div>`);
    } else if (k === 'heading-1') {
      out.push(`<div class="wa-lp-h1">${esc(text)}</div>`);
    } else if (k === 'heading-2') {
      out.push(`<div class="wa-lp-h2">${esc(text)}</div>`);
    } else if (k === 'paragraph') {
      out.push(`<div class="wa-lp-p${b.indent ? ' wa-lp-p--indent' : ''}">${esc(text)}</div>`);
    } else if (k === 'numbered') {
      out.push(`<div class="wa-lp-num">${esc(text)}</div>`);
    } else if (k === 'signature') {
      out.push(`<div class="wa-lp-sig">
        <div class="wa-lp-sig-line">_______________________________________</div>
        <div class="wa-lp-sig-label">${esc(b.label || '')}</div>
      </div>`);
    } else if (k === 'spacer') {
      out.push(`<div class="wa-lp-spacer wa-lp-spacer--${esc(b.size || 'md')}"></div>`);
    } else if (k === 'footer-disclaimer') {
      out.push(`<div class="wa-lp-disclaimer">${esc(text)}</div>`);
    }
    // unknown kinds silently skipped
  }
  return out.join('');
}

/**
 * Build & render the right-side Live Preview pane for a residential
 * draft. Pulls the case-level Case PC narrative and runs the same
 * `_buildCaResidential` path the export uses — so what the user sees
 * is what the PDF/DOCX will contain.
 */
function _renderResidentialLivePreview(caseId, draft) {
  const builder = (typeof window !== 'undefined') ? window.WarrantAuthorBlockBuilder : null;
  if (!builder || typeof builder.build !== 'function') {
    return `<div class="wa-lp-shell"><div class="wa-lp-empty">Block builder not loaded.</div></div>`;
  }
  const agency = _loadAgencyProfile();
  const agencyMerged = Object.assign({}, agency, draft.affiantSnapshot || {});
  const caseInfo = {
    caseNumber: (typeof window !== 'undefined' && window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || draft.caseRef || '',
    caseName:   (typeof window !== 'undefined' && window.currentCase && window.currentCase.name) || '',
  };
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  const pcNarrative = (pcStore && pcStore.getBody)
    ? pcStore.getBody(caseId)
    : (draft.probableCauseNarrative || '');
  let stream;
  try {
    stream = builder.build({
      draft,
      addendumComposes: [],
      agency: agencyMerged,
      caseInfo,
      pcNarrative,
      includeDisclaimer: false,
    });
  } catch (e) {
    return `<div class="wa-lp-shell"><div class="wa-lp-empty">Preview build failed: ${esc(e && e.message || String(e))}</div></div>`;
  }
  const meta = (stream && stream.meta) || {};
  const headerLines = (meta.runningHeader && Array.isArray(meta.runningHeader.lines))
    ? meta.runningHeader.lines : [];
  const footerLine = (meta.runningFooter && meta.runningFooter.drNumber) ? ('DR # ' + meta.runningFooter.drNumber) : '';
  const headerHtml = headerLines.length
    ? `<div class="wa-lp-runheader">${headerLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>`
    : '';
  const footerHtml = footerLine
    ? `<div class="wa-lp-runfooter">${esc(footerLine)}</div>`
    : '';
  return `
    <div class="wa-lp-shell">
      <div class="wa-lp-title">LIVE PREVIEW — CA RESIDENTIAL SEARCH WARRANT</div>
      <div class="wa-lp-page">
        ${headerHtml}
        <div class="wa-lp-body">${_residentialBlocksToHtml((stream && stream.blocks) || [])}</div>
        ${footerHtml}
      </div>
    </div>
  `;
}

/** Trigger download of a Blob with the given filename. Browser-side only. */
function _downloadBlob(blob, filename, mimeType) {
  try {
    let b = blob;
    if (!(b instanceof Blob)) {
      b = new Blob([blob], { type: mimeType || 'application/octet-stream' });
    }
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  } catch (e) {
    console.error('[WarrantAuthor] download failed:', e);
  }
}

// ─── status pill ────────────────────────────────────────────────────────

function _statusBadge(status) {
  const map = {
    'draft':           { txt: 'DRAFT',           cls: 'bg-slate-500/20 text-slate-300 border-slate-500/40' },
    'finalized':       { txt: 'FINALIZED',       cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
    'served':          { txt: 'SERVED',          cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' },
    'partial-return':  { txt: 'PARTIAL RETURN',  cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
    'fully-returned':  { txt: 'RETURNED',        cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
    'quashed':         { txt: 'QUASHED',         cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
  };
  const e = map[status] || map['draft'];
  return `<span class="text-[10px] tracking-wider font-mono px-2 py-0.5 rounded border ${e.cls}">${e.txt}</span>`;
}

// ─── identifier harvest ─────────────────────────────────────────────────
// Scans case-local storage (Pattern 2) for emails/phones/usernames/IPs/
// account-ids that could be auto-fed into addendum targetAccounts.

function harvestIdentifiers(caseId) {
  if (!caseId) return { emails: [], phones: [], usernames: [], ips: [], by_source: {} };

  const out = {
    emails: new Map(),       // value → {value, sources[]}
    phones: new Map(),
    usernames: new Map(),
    ips: new Map(),
    by_source: {},
  };

  function _add(bucket, value, source, meta) {
    const v = String(value || '').trim();
    if (!v) return;
    const key = v.toLowerCase();
    let rec = out[bucket].get(key);
    if (!rec) { rec = { value: v, sources: [] }; out[bucket].set(key, rec); }
    rec.sources.push({ source, ...(meta || {}) });
    if (!out.by_source[source]) out.by_source[source] = 0;
    out.by_source[source] += 1;
  }

  function _readJson(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
  }

  // ── Pattern 2 persons (suspects, victims, witnesses, missing) ──
  for (const [k, label] of [
    ['suspects_',       'Suspect'],
    ['victims_',        'Victim'],
    ['witnesses_',      'Witness'],
    ['missingpersons_', 'Missing Person']
  ]) {
    const list = _readJson(`${k}${caseId}`);
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p) continue;
      _add('emails', p.email, label, { name: p.name || p.fullName });
      _add('phones', p.phone, label, { name: p.name || p.fullName });
      _add('phones', p.phone2, label, { name: p.name || p.fullName });
      _add('usernames', p.username, label, { name: p.name || p.fullName });
      _add('usernames', p.screenName, label, { name: p.name || p.fullName });
      if (Array.isArray(p.identifiers)) {
        for (const id of p.identifiers) {
          const t = String(id && id.type || '').toLowerCase();
          if (t === 'email') _add('emails', id.value, label, { name: p.name });
          else if (t === 'phone') _add('phones', id.value, label, { name: p.name });
          else if (t === 'ip') _add('ips', id.value, label, { name: p.name });
          else _add('usernames', id.value, label, { name: p.name, kind: id.type });
        }
      }
    }
  }

  // ── Aperture (email warrant) — subjects + IP roster ──
  const aperture = _readJson(`apertureImport_${caseId}`);
  if (aperture) {
    const list = Array.isArray(aperture) ? aperture : (aperture && aperture.imports) || [];
    for (const imp of list) {
      const subj = imp && (imp.subject || imp.subjectInfo);
      if (subj) {
        _add('emails', subj.email, 'Aperture', { ref: imp.id });
      }
      // common IP roster shapes
      const ipList = (imp && imp.ips) || (imp && imp.ipRoster) || [];
      if (Array.isArray(ipList)) {
        for (const ipRec of ipList) {
          const v = typeof ipRec === 'string' ? ipRec : (ipRec && (ipRec.ip || ipRec.address));
          _add('ips', v, 'Aperture', { ref: imp.id });
        }
      }
    }
  }

  // ── Per-provider warrant returns (Google/Discord/Snapchat/KIK/Meta) ──
  for (const [k, src] of [
    ['googleWarrant_',   'Google Return'],
    ['discordWarrant_',  'Discord Return'],
    ['snapchatWarrant_', 'Snapchat Return'],
    ['kikWarrant_',      'KIK Return'],
    ['metaWarrant_',     'Meta Return'],
  ]) {
    const data = _readJson(`${k}${caseId}`);
    if (!data) continue;
    const imports = Array.isArray(data) ? data : (data.imports || []);
    for (const imp of imports) {
      const subj = imp && (imp.subject || imp.subjectInfo);
      if (subj) {
        _add('emails',    subj.email,    src, { ref: imp.id });
        _add('phones',    subj.phone,    src, { ref: imp.id });
        _add('usernames', subj.username, src, { ref: imp.id });
        _add('usernames', subj.screenName, src, { ref: imp.id });
        _add('usernames', subj.userId, src, { ref: imp.id, kind: 'user-id' });
      }
    }
  }

  // ── Cellebrite (mobile forensics) — accounts/contacts ──
  const cb = _readJson(`cellebriteImport_${caseId}`);
  if (cb && Array.isArray(cb.imports)) {
    for (const imp of cb.imports) {
      const subj = imp && (imp.subject || imp.deviceOwner);
      if (subj) {
        _add('emails',    subj.email,    'Cellebrite', { ref: imp.id });
        _add('phones',    subj.phone,    'Cellebrite', { ref: imp.id });
        _add('usernames', subj.appleId,  'Cellebrite', { ref: imp.id, kind: 'apple-id' });
        _add('usernames', subj.googleAccount, 'Cellebrite', { ref: imp.id, kind: 'google' });
      }
    }
  }

  function _flatten(m) {
    return Array.from(m.values()).sort((a, b) => a.value.localeCompare(b.value));
  }

  return {
    emails:    _flatten(out.emails),
    phones:    _flatten(out.phones),
    usernames: _flatten(out.usernames),
    ips:       _flatten(out.ips),
    by_source: out.by_source,
  };
}

// ─── new-draft modal HTML ───────────────────────────────────────────────

function _readWarrantAuthorState() {
  // Settings dropdown wins over agency.state; falls back to agency.state, then 'CA'.
  // Must mirror _WARRANT_AUTHOR_SUPPORTED_STATES in settings.html.
  const SUPPORTED = ['CA', 'VA', 'CO', 'PA'];
  try {
    const s = (localStorage.getItem('viperWarrantAuthorState') || '').toUpperCase();
    if (SUPPORTED.includes(s)) return s;
  } catch (_e) { /* localStorage unavailable */ }
  const agency = _loadAgencyProfile();
  const as = (agency && agency.state) ? String(agency.state).toUpperCase() : '';
  if (SUPPORTED.includes(as)) return as;
  return 'CA';
}

// ESP template descriptor for a given state. Used to lock the New-Draft
// Template dropdown to the jurisdiction chosen in Settings → Warrant
// Authoring (users can no longer change state formatting from inside the
// case module — they must change it in Settings).
function _espTemplateForState(state) {
  switch ((state || '').toUpperCase()) {
    case 'CA': return { id: 'ca-multi-business-esp',     label: 'CA — Multi-Business ESP (CalECPA §1546.1)' };
    case 'VA': return { id: 'va-multi-business-esp',     label: 'VA — Multi-Business ESP (DC-338/DC-339, §19.2-53) · Beta' };
    case 'CO': return { id: 'co-multi-business-esp',     label: 'CO — Affidavit + Search Warrant (§16-3-301) · Beta' };
    case 'PA': return { id: 'pa-multi-business-esp',     label: 'PA — Search Warrant + Affidavit (AOPC 410A) · Beta' };
    default:   return { id: 'generic-us-multi-business-esp', label: 'US Generic — Multi-Business ESP (SCA §2703)' };
  }
}

function _renderNewDraftModal(caseId) {
  const agency = _loadAgencyProfile();
  const jurisdiction = _readWarrantAuthorState();
  const espTpl = _espTemplateForState(jurisdiction);
  // Crime presets are optional — module may not yet be loaded in some embeds.
  const crimePresets = (typeof window !== 'undefined' && window.WarrantAuthorCrimePresets
                         && typeof window.WarrantAuthorCrimePresets.listForPicker === 'function')
    ? window.WarrantAuthorCrimePresets.listForPicker()
    : [];
  const crimeOptions = crimePresets.map(p =>
    `<option value="${attr(p.id)}">${esc(p.label)}</option>`
  ).join('');
  return `
    <div id="waNewDraftModal" class="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div class="w-full max-w-lg bg-viper-dark border border-viper-cyan/30 rounded-xl shadow-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-white">New Warrant Draft</h3>
          <button onclick="WarrantAuthorUI.bus.onCloseNewDraftModal()" class="text-slate-400 hover:text-white">&times;</button>
        </div>
        <div class="space-y-3 text-sm">
          <label class="block">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Case Ref</span>
            <input id="waNewCaseRef" type="text" class="mt-1 w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded text-white focus:border-viper-cyan focus:outline-none"
                   value="${attr((window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '')}"
                   placeholder="e.g. 25-001234">
            <span class="block text-[11px] text-slate-500 mt-1">Auto-populated from current case. Edit if you want a different label on this draft.</span>
          </label>
          <label class="block">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Warrant Type</span>
            <select id="waNewType"
                    onchange="WarrantAuthorUI.bus.onNewDraftTypeChange(this.value)"
                    class="mt-1 w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded text-white focus:border-viper-cyan focus:outline-none">
              <option value="multi-business-esp" selected>Multi-Business ESP (records from providers)</option>
              <option value="residential">Residential Search Warrant</option>
            </select>
            <span class="block text-[11px] text-slate-500 mt-1">Pick the document the magistrate will sign. Template &amp; defaults populate from this choice.</span>
          </label>
          <label class="block">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Template</span>
            <select id="waNewTemplate" disabled
                    class="mt-1 w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded text-white opacity-80 cursor-not-allowed focus:outline-none">
              <option value="${attr(espTpl.id)}" selected>${esc(espTpl.label)}</option>
            </select>
            <span class="block text-[11px] text-slate-500 mt-1">Locked to Warrant Authoring state = <code>${attr(jurisdiction)}</code>. Change in Settings → Warrant Authoring.</span>
          </label>
          <label class="block hidden" id="waNewCrimeWrap">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Crime Type</span>
            <select id="waNewCrime" class="mt-1 w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded text-white focus:border-viper-cyan focus:outline-none">
              <option value="">— Select crime category —</option>
              ${crimeOptions}
            </select>
            <span class="block text-[11px] text-slate-500 mt-1">Seeds PC §1524 grounds, items to seize, T&amp;E paragraph, default optional clauses, and SOPC scaffolding. All fields remain editable after creation.</span>
          </label>
        </div>
        <div class="mt-5 flex items-center justify-end gap-2">
          <button onclick="WarrantAuthorUI.bus.onCloseNewDraftModal()"
                  class="px-3 py-2 text-slate-300 hover:text-white text-sm">Cancel</button>
          <button onclick="WarrantAuthorUI.bus.onCreateDraftConfirm('${attr(caseId)}')"
                  class="px-4 py-2 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan/50 text-viper-cyan rounded text-sm font-medium">
            Create Draft
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Drafts subtab — list view ──────────────────────────────────────────

function _renderDraftsList(caseId) {
  const ds = _store();
  const drafts = ds ? ds.listDrafts(caseId) : [];
  if (!drafts.length) {
    return `
      <div class="wa-empty">
        <div class="wa-empty-title">No drafts yet</div>
        <div class="wa-empty-body">
          Create a new Multi-Business ESP warrant to start drafting. One affidavit can serve multiple providers via per-business addendums.
          <div class="mt-4">
            <button onclick="WarrantAuthorUI.bus.onClickNewDraft('${attr(caseId)}')"
                    class="px-4 py-2 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan rounded text-viper-cyan text-sm">
              + New Warrant Draft
            </button>
          </div>
        </div>
      </div>
    `;
  }

  const rows = drafts.map(d => {
    const isResidential = d.type === 'residential';
    const adCount = Array.isArray(d.addendums) ? d.addendums.length : 0;
    const updated = _shortDate(d.updatedAt);
    const providers = isResidential
      ? ((d.residential && d.residential.premises && d.residential.premises.address) || '— no premises set')
      : ((d.addendums || []).map(a => a.providerKey || 'unset').filter(Boolean).slice(0, 4).join(', ') || '—');
    const juris = (d.template && d.template.startsWith('ca-')) ? 'CA' : 'US';
    const typeBadge = isResidential
      ? '<span class="ml-1 px-1.5 py-0 bg-viper-orange/20 text-viper-orange border border-viper-orange/40 rounded text-[10px] font-mono uppercase">Residential</span>'
      : '<span class="ml-1 px-1.5 py-0 bg-viper-purple/20 text-viper-purple border border-viper-purple/40 rounded text-[10px] font-mono uppercase">ESP</span>';
    const subline = isResidential
      ? `<span class="truncate">${esc(providers)}</span>`
      : `<span><span class="text-viper-cyan font-mono">${adCount}</span> addendum${adCount === 1 ? '' : 's'}</span>
         <span class="truncate">${esc(providers)}</span>`;
    return `
      <div class="wa-draft-row">
        <div class="flex-1 min-w-0 cursor-pointer" onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(d.id)}')">
          <div class="flex items-center gap-2 mb-1">
            ${_statusBadge(d.status)}
            <span class="text-white font-medium truncate">${esc(d.swNumber || d.caseRef || 'Untitled draft')}</span>
            <span class="text-slate-500 text-xs">·</span>
            <span class="text-slate-400 text-xs">${esc(juris)}</span>
            ${typeBadge}
          </div>
          <div class="flex items-center gap-3 text-xs text-slate-400">
            ${subline}
            <span class="ml-auto text-slate-500">updated ${esc(updated)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 pl-3">
          <button onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(d.id)}')"
                  class="px-2 py-1 text-xs bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 text-viper-cyan rounded">
            Open
          </button>
          <button onclick="WarrantAuthorUI.bus.onDeleteDraft('${attr(caseId)}','${attr(d.id)}')"
                  class="px-2 py-1 text-xs text-rose-300 hover:text-rose-200" title="Delete">
            ✕
          </button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-xs text-slate-400">
          <span class="text-white font-mono">${drafts.length}</span> draft${drafts.length === 1 ? '' : 's'}
        </div>
        <button onclick="WarrantAuthorUI.bus.onClickNewDraft('${attr(caseId)}')"
                class="px-3 py-1.5 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan/50 text-viper-cyan rounded text-xs flex items-center gap-1">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          New Draft
        </button>
      </div>
      <div class="space-y-2">${rows}</div>
    </div>
  `;
}

// ─── Residential editor (Phase R2 — interactive form) ─────────────────
//
// Full editor for type='residential' drafts. Single-pane scrollable form
// with sections: identification → crime/offenses → PC §1524 grounds →
// premises → suspects → items-to-seize → T&E → SOPC → optional clauses →
// executed-at → export.
//
// Save pattern:
//   - text inputs / selects / checkboxes: onchange → save + rerender
//   - long textareas (SOPC body, items body, justifications, premises
//     legal, T&E inline body): oninput → silent save (no rerender) so the
//     caret doesn't jump. Structural ops (add/remove rows) trigger
//     rerender via bus.
function _renderResidentialEditor(caseId, draft) {
  const r = draft.residential || {};
  const presetId = r.crimePresetId || '';
  const presetAPI = (typeof window !== 'undefined') ? window.WarrantAuthorCrimePresets : null;
  const presetPick = (presetAPI && typeof presetAPI.listForPicker === 'function')
    ? presetAPI.listForPicker() : [];
  let presetLabel = '— (no preset)';
  if (presetId && presetAPI && presetAPI.get) {
    const pinfo = presetAPI.get(presetId);
    if (pinfo) presetLabel = pinfo.label;
  }

  const dId = attr(draft.id);
  const cId = attr(caseId);

  // Helpers ----------------------------------------------------------
  const setField = (path) =>
    `WarrantAuthorUI.bus.onResidentialFieldSet('${cId}','${dId}','${path}', this.value)`;
  const setBool = (path) =>
    `WarrantAuthorUI.bus.onResidentialFieldSet('${cId}','${dId}','${path}', this.checked)`;
  const setTextSilent = (path) =>
    `WarrantAuthorUI.bus.onResidentialTextInput('${cId}','${dId}','${path}', this.value)`;
  const listAdd = (path) =>
    `WarrantAuthorUI.bus.onResidentialListAdd('${cId}','${dId}','${path}')`;
  const listRemove = (path, idx) =>
    `WarrantAuthorUI.bus.onResidentialListRemove('${cId}','${dId}','${path}',${idx})`;

  // Top toolbar -----------------------------------------------------
  const presetOptions = presetPick
    .map(p => `<option value="${attr(p.id)}" ${p.id === presetId ? 'selected' : ''}>${esc(p.label)}</option>`)
    .join('');

  // Offenses -------------------------------------------------------
  const offenses = Array.isArray(r.offenses) ? r.offenses : [];
  const offensesRows = offenses.map((o, i) => `
    <div class="grid grid-cols-12 gap-2 mb-2">
      <input type="text" class="col-span-3 px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm font-mono focus:border-viper-cyan outline-none"
             placeholder="Code (e.g. PC 311.11)"
             value="${attr(o.code || '')}"
             onchange="${setField('residential.offenses.' + i + '.code')}">
      <input type="text" class="col-span-8 px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none"
             placeholder="Description"
             value="${attr(o.label || '')}"
             onchange="${setField('residential.offenses.' + i + '.label')}">
      <button onclick="${listRemove('residential.offenses', i)}"
              class="col-span-1 px-2 py-1 text-rose-300 hover:text-rose-200 text-sm" title="Remove">✕</button>
    </div>
  `).join('');

  // PC §1524 grounds ----------------------------------------------
  const G = draft.pc1524Grounds || {};
  const groundsList = [
    ['stolen',              '(1) Stolen or embezzled'],
    ['felonyMeans',         '(2) Used as means of committing a felony'],
    ['possessedWithIntent', '(3) Possessed with intent to use as means of a public offense'],
    ['evidenceOfFelony',    '(4) Tends to show a felony was committed / by a particular person'],
    ['sexualExploitation',  '(5) Tends to show PC 311.3 / 311.11 (sexual exploitation of minor / CSAM)'],
    ['arrestWarrant',       '(6) Subject of outstanding arrest warrant'],
    ['ecspMisdemeanor',     '(7) Evidence of misdemeanor served on ECSP (PC §1546)'],
    ['laborCode',           '(7) Tends to show Labor Code §3700.5 violation'],
  ];
  const groundsHtml = groundsList.map(([k, label]) => `
    <label class="flex items-start gap-2 text-sm py-1">
      <input type="checkbox" ${G[k] ? 'checked' : ''}
             onchange="WarrantAuthorUI.bus.onPc1524GroundChange('${cId}','${dId}','${k}', this.checked)"
             class="mt-0.5 accent-viper-cyan">
      <span class="text-slate-200">${esc(label)}</span>
    </label>
  `).join('');

  // Premises -------------------------------------------------------
  const p = r.premises || { address: '', legalDescription: '' };

  // Suspects -------------------------------------------------------
  const suspects = Array.isArray(r.suspects) ? r.suspects : [];
  const suspectsHtml = suspects.length
    ? suspects.map((s, i) => `
        <div class="bg-viper-dark/70 border border-slate-700 rounded p-3 mb-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-slate-400 uppercase tracking-wider">Suspect ${i + 1}</span>
            <button onclick="${listRemove('residential.suspects', i)}" class="text-rose-300 hover:text-rose-200 text-sm">✕ Remove</button>
          </div>
          <div class="grid grid-cols-2 gap-2 mb-2">
            <label class="block">
              <span class="text-[11px] uppercase text-slate-500">Name</span>
              <input type="text" value="${attr(s.name || '')}" placeholder="LASTNAME, FIRSTNAME"
                     onchange="${setField('residential.suspects.' + i + '.name')}"
                     class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
            </label>
            <label class="block">
              <span class="text-[11px] uppercase text-slate-500">Aliases</span>
              <input type="text" value="${attr(s.aliases || '')}" placeholder="AKA ..."
                     onchange="${setField('residential.suspects.' + i + '.aliases')}"
                     class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
            </label>
            <label class="block">
              <span class="text-[11px] uppercase text-slate-500">DOB</span>
              <input type="text" value="${attr(s.dob || '')}" placeholder="MM/DD/YYYY"
                     onchange="${setField('residential.suspects.' + i + '.dob')}"
                     class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm font-mono focus:border-viper-cyan outline-none">
            </label>
            <label class="block">
              <span class="text-[11px] uppercase text-slate-500">Descriptors</span>
              <input type="text" value="${attr(s.descriptors || '')}" placeholder="WMA, 5'10\", 180 lbs, brn/brn"
                     onchange="${setField('residential.suspects.' + i + '.descriptors')}"
                     class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
            </label>
            <label class="block col-span-2">
              <span class="text-[11px] uppercase text-slate-500">Address</span>
              <input type="text" value="${attr(s.address || '')}" placeholder="Residence address"
                     onchange="${setField('residential.suspects.' + i + '.address')}"
                     class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
            </label>
          </div>
        </div>
      `).join('')
    : '<div class="text-slate-500 text-sm italic mb-2">No suspects added yet.</div>';

  // Items to seize ------------------------------------------------
  const items = (r.itemsToSeize && Array.isArray(r.itemsToSeize.blocks)) ? r.itemsToSeize.blocks : [];
  const itemsHtml = items.length
    ? items.map((b, i) => `
        <div class="bg-viper-dark/70 border border-slate-700 rounded p-3 mb-3">
          <div class="flex items-center justify-between mb-2">
            <input type="text" value="${attr(b.label || '')}" placeholder="Block label (e.g. Electronic Devices)"
                   onchange="${setField('residential.itemsToSeize.blocks.' + i + '.label')}"
                   class="flex-1 px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm font-mono focus:border-viper-cyan outline-none">
            <button onclick="${listRemove('residential.itemsToSeize.blocks', i)}" class="ml-2 text-rose-300 hover:text-rose-200 text-sm">✕</button>
          </div>
          <textarea rows="6"
                    oninput="${setTextSilent('residential.itemsToSeize.blocks.' + i + '.body')}"
                    placeholder="Describe the property to be seized..."
                    class="w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(b.body || '')}</textarea>
        </div>
      `).join('')
    : '<div class="text-slate-500 text-sm italic mb-2">No items-to-seize blocks. Click "+ Add block" or "Re-seed from preset" above.</div>';

  // T&E -----------------------------------------------------------
  const te = r.trainingExperience || { mode: 'profile', inlineBody: '' };
  const teMode = te.mode === 'inline' ? 'inline' : 'profile';
  const _agencyForTe = _loadAgencyProfile();
  const teProfileBody = (_agencyForTe && typeof _agencyForTe.trainingExperienceBoilerplate === 'string')
    ? _agencyForTe.trainingExperienceBoilerplate.trim()
    : '';

  // SOPC ----------------------------------------------------------
  const sopc = (r.sopc && Array.isArray(r.sopc.sections)) ? r.sopc.sections : [];
  const sopcHtml = sopc.length
    ? sopc.map((s, i) => `
        <div class="bg-viper-dark/70 border border-slate-700 rounded p-3 mb-3">
          <div class="flex items-center justify-between mb-2">
            <input type="text" value="${attr(s.heading || '')}" placeholder="Section heading"
                   onchange="${setField('residential.sopc.sections.' + i + '.heading')}"
                   class="flex-1 px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm font-mono focus:border-viper-cyan outline-none">
            <button onclick="${listRemove('residential.sopc.sections', i)}" class="ml-2 text-rose-300 hover:text-rose-200 text-sm">✕</button>
          </div>
          <textarea rows="6"
                    oninput="${setTextSilent('residential.sopc.sections.' + i + '.body')}"
                    placeholder="Narrative for this SOPC section..."
                    class="w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(s.body || '')}</textarea>
        </div>
      `).join('')
    : '<div class="text-slate-500 text-sm italic mb-2">No SOPC sections yet. The preset usually seeds a scaffold — use "+ Add section" or re-seed.</div>';

  // Optional clauses ----------------------------------------------
  const opt = r.optionalClauses || {};
  const ns = opt.nightService || { enabled: false, justification: '' };
  const hb = opt.hobbsSealing || { enabled: false, justification: '' };

  // Executed at --------------------------------------------------
  const ex = r.executedAt || { city: '', date: '', time: '', timeAmPm: 'PM' };

  return `
    <div class="wa-editor space-y-4">
      <!-- toolbar -->
      <div class="flex items-center justify-between border-b border-slate-700 pb-3">
        <div class="flex items-center gap-3 min-w-0">
          <button onclick="WarrantAuthorUI.bus.onBackToList('${cId}')"
                  class="text-slate-400 hover:text-white text-sm flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            Drafts
          </button>
          <span class="text-slate-500">/</span>
          <span class="text-white font-medium truncate">${esc(draft.swNumber || draft.caseRef || 'Untitled residential draft')}</span>
          <span class="ml-2 px-2 py-0.5 bg-viper-orange/20 text-viper-orange border border-viper-orange/40 rounded text-[11px] font-mono uppercase tracking-wider">Residential</span>
          ${presetId
            ? `<span class="px-2 py-0.5 bg-viper-purple/20 text-viper-purple border border-viper-purple/40 rounded text-[11px] font-mono">${esc(presetLabel)}</span>`
            : ''}
          ${_statusBadge(draft.status)}
        </div>
        <div class="flex items-center gap-2 text-xs">
          <button onclick="WarrantAuthorUI.bus.onResidentialGenerate('${cId}','${dId}')"
                  class="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 rounded text-sm font-medium flex items-center gap-1.5">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            Generate PDF + DOCX
          </button>
          <span class="text-slate-500">saves to case folder</span>
        </div>
      </div>

      <!-- Validator panel — auto-runs on every render. Click the chevron
           to expand/collapse the error & warning lists. Mirrors the
           ESP validator panel pattern (top of editor, scope chips,
           collapsible groups). -->
      ${_renderResidentialValidatorPanel(caseId, draft)}

      <!-- Two-column layout: form fields on the left, live preview on
           the right. The preview re-runs the same _buildCaResidential
           path the export uses, so what the user sees is what the
           PDF/DOCX will contain. -->
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
        <div class="space-y-4 min-w-0">

      <!-- Identification (case ref + court + county) -->
      <!-- NOTE: SW Number and Judge are assigned by the court at filing time -->
      <!-- and intentionally omitted from the author module. -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Identification</summary>
        <div class="wa-section-body grid grid-cols-2 gap-3 pt-2">
          <label class="block col-span-2">
            <span class="text-[11px] uppercase text-slate-500">Case Ref</span>
            <input type="text" value="${attr(draft.caseRef || '')}"
                   onchange="WarrantAuthorUI.bus.onDraftFieldChange('${cId}','${dId}','caseRef',this.value)"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">Court</span>
            <input type="text" value="${attr(draft.courtName || '')}"
                   onchange="WarrantAuthorUI.bus.onDraftFieldChange('${cId}','${dId}','courtName',this.value)"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">County</span>
            <input type="text" value="${attr(draft.county || '')}"
                   onchange="WarrantAuthorUI.bus.onDraftFieldChange('${cId}','${dId}','county',this.value)"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
        </div>
      </details>

      <!-- Crime Type + Offenses -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Crime Type &amp; Offenses</summary>
        <div class="wa-section-body pt-2">
          <div class="flex items-center gap-2 mb-3">
            <label class="text-[11px] uppercase text-slate-500">Crime preset:</label>
            <select onchange="WarrantAuthorUI.bus.onResidentialPresetChange('${cId}','${dId}', this.value)"
                    class="px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
              <option value="">— Custom (no preset) —</option>
              ${presetOptions}
            </select>
            <button onclick="WarrantAuthorUI.bus.onResidentialReseed('${cId}','${dId}')"
                    class="ml-auto px-2 py-1 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 rounded text-amber-200 text-xs">
              ↺ Re-seed offenses / grounds / items / T&amp;E / SOPC from current preset
            </button>
          </div>
          <div class="mb-2 text-xs text-slate-400">Offenses charged (these flow into the document caption):</div>
          ${offensesRows}
          <button onclick="${listAdd('residential.offenses')}"
                  class="px-2 py-1 text-xs bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-200">
            + Add offense
          </button>
        </div>
      </details>

      <!-- PC §1524 Grounds -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">PC §1524 Grounds</summary>
        <div class="wa-section-body pt-2">
          <div class="text-xs text-slate-400 mb-2">Check the statutory grounds that authorize this search.</div>
          ${groundsHtml}
        </div>
      </details>

      <!-- Premises -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Premises (Property to be Searched)</summary>
        <div class="wa-section-body pt-2 space-y-3">
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">Street Address</span>
            <input type="text" value="${attr(p.address || '')}"
                   onchange="${setField('residential.premises.address')}"
                   placeholder="1234 Main St, Anytown, CA 92410"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">Legal Description</span>
            <textarea rows="6"
                      oninput="${setTextSilent('residential.premises.legalDescription')}"
                      placeholder="Describe the residence with particularity: lot/block, paint color, roof, fences, outbuildings, vehicles, mailbox, attached garage, etc."
                      class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(p.legalDescription || '')}</textarea>
            <span class="block text-[11px] text-slate-500 mt-1">This is the "legal" — the description an officer would use to identify the residence on arrival. Include APN, color, distinguishing features, vehicles, and curtilage you intend to search.</span>
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" ${p.includeScopeBoilerplate !== false ? 'checked' : ''}
                   onchange="${setBool('residential.premises.includeScopeBoilerplate')}"
                   class="accent-viper-cyan">
            Include scope boilerplate (all rooms, attached structures, vehicles, persons on premises, etc.)
          </label>
        </div>
      </details>

      <!-- Suspects -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Suspect(s) / Persons Identified</summary>
        <div class="wa-section-body pt-2">
          ${suspectsHtml}
          <button onclick="${listAdd('residential.suspects')}"
                  class="px-2 py-1 text-xs bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-200">
            + Add suspect
          </button>
        </div>
      </details>

      <!-- Items to seize -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Items to Seize (Property to be Seized)</summary>
        <div class="wa-section-body pt-2">
          ${itemsHtml}
          <button onclick="${listAdd('residential.itemsToSeize.blocks')}"
                  class="px-2 py-1 text-xs bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-200">
            + Add block
          </button>
        </div>
      </details>

      <!-- Training & Experience -->
      <details class="wa-section">
        <summary class="wa-section-summary">Training &amp; Experience</summary>
        <div class="wa-section-body pt-2 space-y-2">
          <div class="flex items-center gap-3 text-sm text-slate-200 mb-2">
            <label class="flex items-center gap-1">
              <input type="radio" name="te-mode-${dId}" ${teMode === 'profile' ? 'checked' : ''}
                     onchange="${setField('residential.trainingExperience.mode')}" value="profile"
                     class="accent-viper-cyan">
              <span>Use Agency Profile T&amp;E (settings)</span>
            </label>
            <label class="flex items-center gap-1">
              <input type="radio" name="te-mode-${dId}" ${teMode === 'inline' ? 'checked' : ''}
                     onchange="${setField('residential.trainingExperience.mode')}" value="inline"
                     class="accent-viper-cyan">
              <span>Override with inline text below (recommended for crime-specialized prose)</span>
            </label>
          </div>
          ${teMode === 'profile'
            ? (teProfileBody
                ? `<div class="rounded border border-slate-700 bg-viper-dark/60 p-3 max-h-[260px] overflow-y-auto whitespace-pre-wrap text-sm text-slate-200 leading-relaxed">${esc(teProfileBody)}</div>
                   <span class="block text-[11px] text-slate-500">Auto-populated from Settings → Warrant Author → Agency Profile → <em>Training &amp; Experience Boilerplate</em>. Read-only — edit it in Settings to update for every warrant, or switch to inline below to override for this draft only.</span>`
                : `<div class="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                     ⚠ No Training &amp; Experience boilerplate is set in the Agency Profile. Open <strong>Settings → Warrant Author → Agency Profile</strong> and fill in <em>Training &amp; Experience Boilerplate</em>, or switch this draft to inline mode.
                   </div>`)
            : `<textarea rows="10"
                    oninput="${setTextSilent('residential.trainingExperience.inlineBody')}"
                    placeholder="Crime-specific T&E paragraph (CSAM victimology, narcotics indicia, robbery/violent crime experience, property-crime patterns, etc.)..."
                    class="w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(te.inlineBody || '')}</textarea>
              <span class="block text-[11px] text-slate-500">Inline mode — this body is rendered verbatim under the IDENTIFICATION AND EXPERIENCE OF AFFIANT heading and replaces the Agency Profile T&amp;E for this draft. Crime presets seed this when first selected.</span>`}
        </div>
      </details>

      <!-- SOPC removed — Statement of Probable Cause is now sourced from
           the case-level Case Probable Cause narrative (shared across all
           warrants in this case). See top of Warrant Author for the
           authoritative editor; this draft will pull from it at export. -->
      <details class="wa-section" open>
        <summary class="wa-section-summary">Statement of Probable Cause</summary>
        <div class="wa-section-body pt-2">
          <div class="rounded border border-viper-cyan/30 bg-viper-cyan/5 px-3 py-2 text-xs text-slate-300">
            ⚖ <span class="text-viper-cyan font-medium">Sourced from Case Probable Cause</span> —
            the narrative authored in the <em>Case Probable Cause</em> panel at the top of
            Warrant Author is rendered verbatim under this heading on export. Edit it
            there so every warrant in this case stays in sync; nothing to author per-draft.
          </div>
        </div>
      </details>

      <!-- Optional clauses -->
      <details class="wa-section">
        <summary class="wa-section-summary">Optional Clauses</summary>
        <div class="wa-section-body pt-2 space-y-3">
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" ${opt.offsiteComputerSearch ? 'checked' : ''}
                   onchange="${setBool('residential.optionalClauses.offsiteComputerSearch')}"
                   class="mt-0.5 accent-viper-cyan">
            <span class="text-slate-200">Offsite examination of digital devices (forensic lab analysis off-scene)</span>
          </label>
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" ${opt.authorityToDuplicate ? 'checked' : ''}
                   onchange="${setBool('residential.optionalClauses.authorityToDuplicate')}"
                   class="mt-0.5 accent-viper-cyan">
            <span class="text-slate-200">Authority to make bit-for-bit forensic duplicates of seized media</span>
          </label>
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" ${opt.returnExtension ? 'checked' : ''}
                   onchange="${setBool('residential.optionalClauses.returnExtension')}"
                   class="mt-0.5 accent-viper-cyan">
            <span class="text-slate-200">Request extension of return time (PC §1534) for forensic examination</span>
          </label>
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" ${opt.statutoryGroundsRecap ? 'checked' : ''}
                   onchange="${setBool('residential.optionalClauses.statutoryGroundsRecap')}"
                   class="mt-0.5 accent-viper-cyan">
            <span class="text-slate-200">Include statutory grounds recap at end of affidavit</span>
          </label>

          <!-- Night service -->
          <div class="bg-viper-dark/70 border border-slate-700 rounded p-3">
            <label class="flex items-start gap-2 text-sm mb-2">
              <input type="checkbox" ${ns.enabled ? 'checked' : ''}
                     onchange="${setBool('residential.optionalClauses.nightService.enabled')}"
                     class="mt-0.5 accent-viper-cyan">
              <span class="text-slate-200 font-semibold">Night service (PC §1533 — service between 10pm–7am)</span>
            </label>
            <textarea rows="4"
                      oninput="${setTextSilent('residential.optionalClauses.nightService.justification')}"
                      placeholder="Good-cause justification for night service..."
                      class="w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(ns.justification || '')}</textarea>
          </div>

          <!-- Hobbs sealing -->
          <div class="bg-viper-dark/70 border border-slate-700 rounded p-3">
            <label class="flex items-start gap-2 text-sm mb-2">
              <input type="checkbox" ${hb.enabled ? 'checked' : ''}
                     onchange="${setBool('residential.optionalClauses.hobbsSealing.enabled')}"
                     class="mt-0.5 accent-viper-cyan">
              <span class="text-slate-200 font-semibold">Hobbs sealing (People v. Hobbs / Evidence Code §1041 — protect CI)</span>
            </label>
            <textarea rows="4"
                      oninput="${setTextSilent('residential.optionalClauses.hobbsSealing.justification')}"
                      placeholder="Justification for sealing the affidavit (CI identity, ongoing investigation, etc.)..."
                      class="w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">${esc(hb.justification || '')}</textarea>
          </div>
        </div>
      </details>

      <!-- Executed at -->
      <details class="wa-section">
        <summary class="wa-section-summary">Executed At</summary>
        <div class="wa-section-body pt-2 grid grid-cols-4 gap-3">
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">City</span>
            <input type="text" value="${attr(ex.city || '')}"
                   oninput="${setTextSilent('residential.executedAt.city')}"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">Date</span>
            <input type="date" value="${attr(ex.date || '')}"
                   oninput="${setTextSilent('residential.executedAt.date')}"
                   onchange="${setTextSilent('residential.executedAt.date')}"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">Time</span>
            <input type="time" value="${attr(ex.time || '')}"
                   oninput="${setTextSilent('residential.executedAt.time')}"
                   onchange="${setTextSilent('residential.executedAt.time')}"
                   class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
          </label>
          <label class="block">
            <span class="text-[11px] uppercase text-slate-500">AM/PM</span>
            <select onchange="${setField('residential.executedAt.timeAmPm')}"
                    class="mt-0.5 w-full px-2 py-1 bg-viper-dark border border-gray-600 rounded text-white text-sm focus:border-viper-cyan outline-none">
              <option value="AM" ${ex.timeAmPm === 'AM' ? 'selected' : ''}>AM</option>
              <option value="PM" ${ex.timeAmPm !== 'AM' ? 'selected' : ''}>PM</option>
            </select>
          </label>
        </div>
      </details>

      <!-- Validator results mount (legacy — kept for back-compat with the
           old standalone Validate button. The active panel is the one
           injected by _renderResidentialValidatorPanel at the top of
           the editor and auto-runs on every render. -->
      <div id="waResidentialValidation-${dId}"></div>
        </div><!-- /left column (form fields) -->

        <!-- Right column: Live Preview -->
        <aside class="wa-lp-col min-w-0">
          ${_renderResidentialLivePreview(caseId, draft)}
        </aside>
      </div><!-- /two-column grid -->
    </div>
  `;
}

function _renderEditor(caseId, draftId) {
  const ds = _store();
  const draft = ds ? ds.getDraft(caseId, draftId) : null;
  if (!draft) {
    return `<div class="wa-empty">
      <div class="wa-empty-title">Draft not found</div>
      <div class="wa-empty-body">
        <button onclick="WarrantAuthorUI.bus.onBackToList('${attr(caseId)}')" class="text-viper-cyan underline">← Back to drafts</button>
      </div>
    </div>`;
  }

  // Residential drafts render via a dedicated editor pane (Phase R2).
  // For now show a read-only summary of what the new-draft flow seeded so
  // the author can confirm the right preset + grounds + items + T&E + SOPC
  // landed on the draft, then keep working in the case until the full
  // residential editor ships.
  if (draft.type === 'residential') {
    return _renderResidentialEditor(caseId, draft);
  }

  // Auto-sync caseRef from the running case the moment the editor opens.
  // The Warrant Author is always launched from inside a case context, so a
  // missing caseRef should never block the validator or the disk-persist
  // path — it's structurally implicit. We only write if the case number is
  // present AND draft.caseRef is blank, to avoid clobbering user-entered
  // overrides.
  const runningCaseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
  if (runningCaseNumber && !(draft.caseRef && String(draft.caseRef).trim())) {
    draft.caseRef = runningCaseNumber;
    try { ds.saveDraft(caseId, draft); } catch (_) {}
  }

  // Auto-migrate persisted date fields — fixes drafts saved before the
  // onAddendumFieldChange normalizer existed, and any draft that was
  // imported via .vcase. Without this, a year like `0025` survives every
  // re-render and the user sees "date range is inverted" forever without
  // understanding why. _normalizeDateValue clamps to [1900, 2100] and
  // expands 2-digit years to 2000+.
  let _dateMigrated = false;
  (draft.addendums || []).forEach((ad) => {
    if (ad.dateRangeFrom) {
      const v = _normalizeDateValue(ad.dateRangeFrom);
      if (v !== ad.dateRangeFrom) { ad.dateRangeFrom = v; _dateMigrated = true; }
    }
    if (ad.dateRangeTo) {
      const v = _normalizeDateValue(ad.dateRangeTo);
      if (v !== ad.dateRangeTo) { ad.dateRangeTo = v; _dateMigrated = true; }
    }
  });
  if (_dateMigrated) { try { ds.saveDraft(caseId, draft); } catch (_) {} }

  const activeId = _state.activeAddendumId && draft.addendums.find(a => a.id === _state.activeAddendumId)
    ? _state.activeAddendumId
    : (draft.addendums[0] && draft.addendums[0].id) || null;

  const harvest = harvestIdentifiers(caseId);
  const harvestCount = harvest.emails.length + harvest.phones.length + harvest.usernames.length + harvest.ips.length;

  return `
    <div class="wa-editor space-y-4">
      <!-- toolbar -->
      <div class="flex items-center justify-between border-b border-slate-700 pb-3">
        <div class="flex items-center gap-3 min-w-0">
          <button onclick="WarrantAuthorUI.bus.onBackToList('${attr(caseId)}')"
                  class="text-slate-400 hover:text-white text-sm flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            Drafts
          </button>
          <span class="text-slate-500">/</span>
          <span class="text-white font-medium truncate">${esc(draft.swNumber || draft.caseRef || 'Untitled draft')}</span>
          ${_statusBadge(draft.status)}
        </div>
        <div class="flex items-center gap-2 text-xs">
          <button onclick="WarrantAuthorUI.bus.onGenerateWarrant('${attr(caseId)}','${attr(draft.id)}')"
                  class="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 rounded text-sm font-medium flex items-center gap-1.5">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            Generate PDF + DOCX
          </button>
          <span class="text-slate-500">saves to case folder</span>
        </div>
      </div>

      <!-- pre-flight validator panel -->
      ${_renderValidatorPanel(caseId, draft)}

      <!-- draft-level fields -->
      ${_renderDraftHeader(caseId, draft)}

      <!-- CA-specific face-page options: PC §1524 grounds + HOBBS + Night Search -->
      ${_renderCaWarrantOptions(caseId, draft)}

      <!-- VA-specific face-page options: item 5, night service, knowledge, target accounts, advanced DC-339 -->
      ${_renderVaWarrantOptions(caseId, draft)}

      <!-- PA-specific face-page options: AOPC 410A application fields + photo exhibits -->
      ${_renderPaWarrantOptions(caseId, draft)}

      <!-- 2-pane: addendum form (left) + live preview (right) -->
      <div class="grid grid-cols-12 gap-4">
        <!-- addendum list rail -->
        <div class="col-span-2">
          ${_renderAddendumRail(caseId, draft, activeId)}
        </div>
        <!-- form -->
        <div class="col-span-5">
          ${activeId ? _renderAddendumForm(caseId, draft, activeId, harvest) : _renderAddendumEmptyForm(caseId, draft.id)}
        </div>
        <!-- live preview -->
        <div class="col-span-5">
          ${_renderLivePreview(caseId, draft, activeId)}
        </div>
      </div>

      ${harvestCount > 0 ? `
        <div class="text-[11px] text-slate-500 text-right pt-2">
          Auto-fill source pool: ${harvestCount} identifier${harvestCount===1?'':'s'} harvested from this case
          (${Object.entries(harvest.by_source).map(([k,v]) => `${esc(k)}:${v}`).join(' · ')})
        </div>
      ` : ''}
    </div>
  `;
}

function _renderDraftHeader(caseId, draft) {
  const tplOpts = [
    { v: 'ca-multi-business-esp', label: 'CA — CalECPA §1546.1' },
    { v: 'va-multi-business-esp', label: 'VA — DC-338/DC-339 (§19.2-53)' },
    { v: 'co-multi-business-esp', label: 'CO — Affidavit + Search Warrant (§16-3-301)' },
    { v: 'pa-multi-business-esp', label: 'PA — Search Warrant + Affidavit (AOPC 410A)' },
    { v: 'generic-us-multi-business-esp', label: 'US Generic — SCA §2703' },
  ];
  // Colorado: the agency profile carries a user-maintained list of courts
  // (many CO agencies straddle two or more Judicial Districts). When the
  // CO template is selected, render a court picker that drives the
  // caption + judge-oath + judge-signature blocks. Courts are managed
  // in Settings → Warrant Author → Colorado Courts.
  let coCourts = [];
  let coDefaultId = '';
  if (typeof window !== 'undefined' && window.WarrantAuthorAgencyProfile) {
    try {
      const raw = localStorage.getItem('viperAgencyProfile');
      const profile = window.WarrantAuthorAgencyProfile.normalize(raw ? JSON.parse(raw) : {});
      coCourts = Array.isArray(profile.coCourts) ? profile.coCourts : [];
      const def = coCourts.find(c => c.isDefault) || coCourts[0];
      coDefaultId = def ? def.id : '';
    } catch (_) { /* non-fatal */ }
  }
  const isCoTemplate = String(draft.template || '') === 'co-multi-business-esp';
  // When CO template is active AND the agency has a Colorado Courts list,
  // the court picker (coCourtId) is the authoritative source for the
  // caption — the legacy free-text "Court Name" field is ignored by the
  // CO resolver. Hide it to stop it confusing affiants (it would otherwise
  // show the agency default, e.g. "17th Judicial", and never change when
  // they switch courts in the picker). When no CO Courts are configured,
  // the CO fallback still uses Court Name, so keep it editable.
  const coCourtPickerAuthoritative = isCoTemplate && coCourts.length > 0;
  const courtPickerHtml = isCoTemplate ? `
      <label class="text-xs col-span-2">
        <span class="text-slate-400 uppercase tracking-wider">Colorado Court</span>
        ${coCourts.length === 0
          ? `<div class="mt-1 grid grid-cols-2 gap-2">
              <label class="text-xs col-span-2 text-[11px] text-slate-500 leading-snug">
                Optional: add courts under
                <a class="text-viper-cyan underline cursor-pointer" onclick="(window.openSettings ? openSettings() : (location.href='settings.html'))">Settings → Agency Profile → Colorado Courts</a>
                if you file in more than one Judicial District. Otherwise the caption uses the
                <span class="text-slate-300">Court Name</span> field above plus the
                <span class="text-slate-300">Judicial District</span> below.
              </label>
              <label class="text-xs">
                <span class="text-slate-400 uppercase tracking-wider">Judicial District</span>
                <input type="text" placeholder="e.g. 17th"
                       value="${attr(draft.judicialDistrict || '')}"
                       onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','judicialDistrict',this.value)"
                       class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
              </label>
            </div>`
          : `<select onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','coCourtId',this.value)"
                     class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
              ${coCourts.map(c => {
                const sel = (draft.coCourtId || coDefaultId) === c.id ? 'selected' : '';
                return `<option value="${attr(c.id)}" ${sel}>${esc(c.label)} (${esc(c.judicialDistrict || '')} JD, ${esc(c.county || '')})</option>`;
              }).join('')}
             </select>`
        }
      </label>
    ` : '';
  // Probable cause now lives on the Warrant Author screen header (above the
  // subtab pills). Show a compact reference here pointing back up to it.
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  const pcStats = pcStore ? pcStore.stats(caseId) : { chars: 0, words: 0, updatedAt: null };
  const hasPc = pcStats.chars > 0;
  return `
    <div class="grid grid-cols-2 gap-3 p-3 bg-viper-dark/60 border border-slate-700 rounded-lg">
      ${coCourtPickerAuthoritative ? `
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Court</span>
        <div class="mt-1 w-full px-2 py-1.5 bg-viper-dark/40 border border-slate-700 border-dashed rounded text-slate-500 text-xs leading-snug">
          Set by the <span class="text-viper-cyan">Colorado Court</span> picker below.
        </div>
      </label>
      ` : `
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Court Name</span>
        <input type="text" value="${attr(draft.courtName)}"
               onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','courtName',this.value)"
               class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
      </label>
      `}
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Template</span>
        <select onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','template',this.value)"
                class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
          ${tplOpts.map(o => `<option value="${attr(o.v)}" ${o.v === draft.template ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>
      ${courtPickerHtml}

      <div class="col-span-2 text-[11px] text-slate-500 flex items-center justify-between border-t border-slate-700 pt-2 mt-1">
        <span>
          ⚖ Probable Cause:
          ${hasPc
            ? `<span class="text-emerald-400">✓ filled</span> · <span class="text-viper-cyan font-mono">${pcStats.words}</span> words ·
               <span class="text-slate-400">edit at the top of this screen.</span>`
            : `<span class="text-amber-400">empty</span> ·
               <a onclick="document.querySelector('.wa-case-pc')?.setAttribute('open',''); document.getElementById('waCasePcTextarea')?.scrollIntoView({behavior:'smooth',block:'center'}); document.getElementById('waCasePcTextarea')?.focus();"
                  class="text-viper-cyan hover:underline cursor-pointer">open the case PC section above to author it.</a>`}
        </span>
        <span class="text-slate-500">SW # and Judge captured when marked served</span>
      </div>
    </div>
    ${_renderExhibitsPanel(caseId, draft)}
  `;
}

// ─── Exhibits (CR-Exhibit) ──────────────────────────────────────────────
// Affiants frequently need to attach photos or screenshots of tables that
// can't live inside the PC text field. We store them per-draft as
// downscaled data URLs, auto-number them CR-Exhibit #N, and append an
// "EXHIBITS" section to the generated PDF + DOCX (both consume the same
// blockStream). Images are capped to a longest-side of EXHIBIT_MAX_DIM and
// re-encoded so the draft localStorage / IPC payload stays manageable.

const EXHIBIT_MAX_DIM = 1600;                 // px — cap longest side
const EXHIBIT_MAX_BYTES = 8 * 1024 * 1024;    // 8 MB per source file guard

function _draftExhibits(draft) {
  return (draft && Array.isArray(draft.exhibits)) ? draft.exhibits : [];
}

// Read + (if needed) downscale an image File → { dataUrl, mime, w, h, name }.
function _readExhibitFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    if (!/^image\//i.test(file.type)) return reject(new Error('Not an image: ' + file.name));
    if (file.size > EXHIBIT_MAX_BYTES) return reject(new Error('Image too large (max 8 MB): ' + file.name));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Read failed: ' + file.name));
    fr.onload = () => {
      const srcDataUrl = String(fr.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image: ' + file.name));
      img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const longest = Math.max(width, height) || 1;
        const scale = longest > EXHIBIT_MAX_DIM ? (EXHIBIT_MAX_DIM / longest) : 1;
        // Small enough + no scaling needed → keep the source bytes as-is.
        if (scale === 1 && srcDataUrl.length < 1.5 * 1024 * 1024) {
          return resolve({ dataUrl: srcDataUrl, mime: file.type, w: width, h: height, name: file.name });
        }
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const cx = canvas.getContext('2d');
          // White matte so transparent PNGs don't go black when flattened to JPEG.
          if (!/png/i.test(file.type)) { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h); }
          cx.drawImage(img, 0, 0, w, h);
          const outMime = /png/i.test(file.type) ? 'image/png' : 'image/jpeg';
          const outDataUrl = canvas.toDataURL(outMime, 0.9);
          resolve({ dataUrl: outDataUrl, mime: outMime, w, h, name: file.name });
        } catch (_e) {
          resolve({ dataUrl: srcDataUrl, mime: file.type, w: width, h: height, name: file.name });
        }
      };
      img.src = srcDataUrl;
    };
    fr.readAsDataURL(file);
  });
}

function _renderExhibitsPanel(caseId, draft) {
  const exhibits = _draftExhibits(draft);
  const rows = exhibits.map((ex, i) => `
    <div class="flex gap-2 items-start p-2 bg-viper-dark/40 border border-slate-700 rounded">
      <img src="${attr(ex.dataUrl)}" alt="exhibit thumbnail"
           class="w-16 h-16 object-cover rounded border border-slate-600 flex-shrink-0 bg-white">
      <div class="flex-1 min-w-0">
        <div class="text-xs font-mono text-viper-cyan mb-1">CR-Exhibit #${i + 1}</div>
        <input type="text" value="${attr(ex.caption || '')}" placeholder="Caption / description (optional)"
               onchange="WarrantAuthorUI.bus.onExhibitCaptionChange('${attr(caseId)}','${attr(draft.id)}','${attr(ex.id)}',this.value)"
               class="w-full px-2 py-1 bg-viper-dark border border-slate-700 rounded text-white text-xs">
        <div class="text-[10px] text-slate-500 mt-1 truncate">${esc(ex.name || '')}</div>
      </div>
      <button onclick="WarrantAuthorUI.bus.onRemoveExhibit('${attr(caseId)}','${attr(draft.id)}','${attr(ex.id)}')"
              class="px-2 py-1 text-rose-300 hover:text-rose-200 text-xs flex-shrink-0" title="Remove exhibit">✕</button>
    </div>
  `).join('');
  return `
    <div class="mt-3 p-3 bg-viper-dark/60 border border-slate-700 rounded-lg">
      <div class="flex items-center justify-between mb-2">
        <div>
          <span class="text-slate-300 text-sm font-medium">Exhibits</span>
          <span class="text-[11px] text-slate-500 ml-2">photos / screenshots appended as CR-Exhibit #</span>
        </div>
        <button onclick="WarrantAuthorUI.bus.onAddExhibits('${attr(caseId)}','${attr(draft.id)}')"
                class="text-[11px] text-viper-cyan hover:underline">+ Add Image</button>
      </div>
      ${exhibits.length
        ? `<div class="space-y-2">${rows}</div>`
        : `<div class="text-[11px] text-slate-500 leading-snug">No exhibits. Use <span class="text-viper-cyan">+ Add Image</span> to attach photos or screenshots of tables. Each is auto-labeled CR-Exhibit #1, #2, … and appended in its own EXHIBITS section after the warrant body.</div>`}
    </div>
  `;
}

// Append an EXHIBITS section to a built blockStream. Called by the generate
// path AFTER builder.build() so BOTH the renderer PDF composer and the
// main-process DOCX composer (which receive the same blockStream) render
// the images.
function _appendExhibitBlocks(blockStream, draft) {
  const exhibits = _draftExhibits(draft);
  if (!exhibits.length) return;
  if (!blockStream || !Array.isArray(blockStream.blocks)) return;
  blockStream.blocks.push({ kind: 'page-break' });
  blockStream.blocks.push({ kind: 'heading-1', text: 'EXHIBITS' });
  exhibits.forEach((ex, i) => {
    const label = `CR-Exhibit #${i + 1}`;
    blockStream.blocks.push({ kind: 'heading-2', text: label });
    if (ex.caption && String(ex.caption).trim()) {
      blockStream.blocks.push({ kind: 'paragraph', text: String(ex.caption).trim() });
    }
    blockStream.blocks.push({
      kind: 'exhibit-image',
      dataUrl: ex.dataUrl,
      mime: ex.mime || 'image/png',
      w: ex.w || 0,
      h: ex.h || 0,
      label,
    });
  });
}

/**
 * Format the draft's ESP addendum(s) into plain text for the Pennsylvania
 * Application Continuation form. Produces ONLY the electronic-service-
 * provider production details (provider, target accounts, records period,
 * records to produce, non-disclosure) — it deliberately does NOT include
 * the Probable Cause narrative, which lives on the Affidavit.
 *
 * Returns a string (\n-separated) or '' when the draft has no addendums.
 */
function _buildPaEspContinuationText(caseId, draft) {
  const ads = Array.isArray(draft.addendums) ? draft.addendums : [];
  if (!ads.length) return '';

  const items = _items();
  const pdir = _pdir();
  const providersMerged = pdir ? pdir.mergeProviders({
    providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
    customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
    providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
  }) : [];

  const labelFor = (k) => (items && typeof items.labelFor === 'function') ? items.labelFor(k) : k;
  const out = [];
  out.push('The following records are to be produced by the electronic service provider(s) identified below:');

  ads.forEach((ad, idx) => {
    const provider = providersMerged.find(p => p.key === ad.providerKey)
      || { key: ad.providerKey, name: ad.providerKey || '(no provider)' };
    const letter = String.fromCharCode(65 + (idx % 26));
    const provName = ad.businessName || provider.name || provider.key || '(provider)';

    out.push('');
    out.push(`ATTACHMENT ${letter} — ${provName}`);
    if (provider.legalEntity) out.push(`Service Provider: ${provider.legalEntity}`);
    if (provider.address) {
      const attn = provider.custodianAttention ? ` (Attn: ${provider.custodianAttention})` : '';
      out.push(`Service Address: ${provider.address}${attn}`);
    }

    // Target accounts
    const targets = (Array.isArray(ad.targetAccounts) ? ad.targetAccounts : [])
      .filter(t => t && String(t.value || '').trim() !== '');
    if (targets.length) {
      out.push('Target Account(s):');
      targets.forEach(t => out.push(`  - ${t.type || 'account'}: ${String(t.value).trim()}`));
    }

    // Records period
    if (ad.allDatesAvailable) {
      out.push('Records Period: All records available (no date restriction)');
    } else if (ad.dateRangeFrom || ad.dateRangeTo) {
      out.push(`Records Period: ${ad.dateRangeFrom || '(open)'} to ${ad.dateRangeTo || '(open)'}`);
    }

    // Items to produce (resolve to human labels; fall back to provider default pattern)
    let itemKeys = (Array.isArray(ad.itemsToProduce) && ad.itemsToProduce.length)
      ? ad.itemsToProduce.slice()
      : (items && ad.providerKey ? items.resolvePatternKeys(items.defaultPatternFor(ad.providerKey)) : []);
    if (itemKeys && itemKeys.length) {
      out.push('Records to be produced:');
      itemKeys.forEach(k => out.push(`  - ${labelFor(k)}`));
    }

    // Non-disclosure (federal SCA — standard for out-of-state ESPs)
    if (ad.includeNonDisclosure) {
      out.push('Non-Disclosure: A 90-day non-disclosure order under 18 U.S.C. § 2705(b) is requested as to this provider.');
    }
  });

  return out.join('\n');
}

// ─── CA face-page options (PC §1524 grounds + HOBBS + Night Search) ─────
//
// The CA SW Face Page (oath, HOBBS/NIGHT checks, signature, "(SEARCH
// WARRANT)" title, "People of CA…" block, 8 §1524 grounds) is the
// universal skeleton for EVERY California search warrant — premises,
// vehicle, person, electronics, ECSP records, etc. Only the "what to
// search" portion at the bottom varies between warrant types; the
// face page above it does not.
//
// Therefore this options panel is gated on jurisdiction === 'CA',
// not on a specific template id. Adding a new CA warrant template
// (e.g. ca-premises-sw, ca-vehicle-sw, ca-person-sw, ca-electronics-sw)
// will automatically inherit this UI with zero changes here.
//
// The validator requires at least one §1524 ground to be ticked.
// HOBBS sealing and night-search default to 'not-requested' and only
// flip when the affiant articulates a basis in the PC narrative.
const _PC1524_GROUNDS = [
  ['stolen',              'It was stolen or embezzled'],
  ['felonyMeans',         'Used as the means of committing a felony'],
  ['possessedWithIntent', 'Possessed with intent to use as means of committing a public offense'],
  ['evidenceOfFelony',    'Tends to show a felony has been committed / committed by a particular person'],
  ['sexualExploitation',  'Sexual exploitation of a child (PC §311.3 / §311.11)'],
  ['arrestWarrant',       'There is a warrant to arrest the person'],
  ['ecspMisdemeanor',     'ECSP records re: misdemeanor (PC §1524.3)'],
  ['laborCode',           'Labor Code §3700.5 violation'],
];

function _renderCaWarrantOptions(caseId, draft) {
  if (!draft) return '';
  // Gate on jurisdiction so every future CA warrant template inherits
  // this UI automatically. Fall back to template-id check for legacy
  // drafts that pre-date the jurisdiction field being populated.
  const jx = String(draft.jurisdiction || '').toUpperCase();
  const isCa = jx === 'CA' || draft.template === 'ca-multi-business-esp';
  if (!isCa) return '';
  const g = draft.pc1524Grounds || {};
  const anyTicked = _PC1524_GROUNDS.some(([k]) => !!g[k]);

  const groundsHtml = _PC1524_GROUNDS.map(([key, label]) => {
    const checked = g[key] ? 'checked' : '';
    return `
      <label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800/60 cursor-pointer">
        <input type="checkbox" ${checked}
               onchange="WarrantAuthorUI.bus.onPc1524GroundChange('${attr(caseId)}','${attr(draft.id)}','${attr(key)}',this.checked)"
               class="mt-0.5 accent-viper-cyan flex-shrink-0">
        <span class="text-xs text-slate-200 leading-snug">${esc(label)}</span>
      </label>
    `;
  }).join('');

  const hobbsRequested = draft.hobbsSealing === 'requested';
  const nightRequested = draft.nightSearch === 'requested';

  const statusColor = anyTicked ? 'text-emerald-400' : 'text-rose-400';
  const statusIcon  = anyTicked ? '✓' : '⛔';
  const statusText  = anyTicked
    ? `${_PC1524_GROUNDS.filter(([k]) => !!g[k]).length} ground(s) selected`
    : 'No grounds selected — generation blocked';

  // Open/closed state survives _rerender so a checkbox tick does not
  // collapse the card mid-selection. Default: open. Once the user
  // collapses or expands it, _state.caOptionsOpen takes over.
  const isOpen = (_state.caOptionsOpen === undefined) ? true : !!_state.caOptionsOpen;

  return `
    <details class="bg-viper-dark/60 border border-slate-700 rounded-lg" ${isOpen ? 'open' : ''}
             ontoggle="WarrantAuthorUI.bus.onCaOptionsToggle(this.open)">
      <summary class="px-3 py-2 cursor-pointer select-none flex items-center justify-between hover:bg-slate-800/40">
        <span class="text-xs uppercase tracking-wider text-slate-300 font-medium">
          CA Face Page · PC §1524 Grounds + Procedural Toggles
        </span>
        <span class="text-[11px] ${statusColor}">${statusIcon} ${esc(statusText)}</span>
      </summary>
      <div class="p-3 border-t border-slate-700 space-y-3">
        <div>
          <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
            Penal Code §1524 grounds (check all that apply)
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-2 gap-y-0.5 bg-slate-900/40 rounded border border-slate-800 p-1.5">
            ${groundsHtml}
          </div>
          <div class="text-[10px] text-slate-500 mt-1.5">
            At least one ground must be ticked — these become <code class="text-slate-400">[X]</code> marks on the face page.
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
          <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-slate-800/40">
            <input type="checkbox" ${hobbsRequested ? 'checked' : ''}
                   onchange="WarrantAuthorUI.bus.onDraftToggleChange('${attr(caseId)}','${attr(draft.id)}','hobbsSealing',this.checked?'requested':'not-requested')"
                   class="accent-viper-cyan flex-shrink-0">
            <span class="text-xs text-slate-200">
              <span class="font-medium">HOBBS Sealing</span>
              <span class="block text-[10px] text-slate-500">If requested, articulate the basis in the PC narrative.</span>
            </span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-slate-800/40">
            <input type="checkbox" ${nightRequested ? 'checked' : ''}
                   onchange="WarrantAuthorUI.bus.onDraftToggleChange('${attr(caseId)}','${attr(draft.id)}','nightSearch',this.checked?'requested':'not-requested')"
                   class="accent-viper-cyan flex-shrink-0">
            <span class="text-xs text-slate-200">
              <span class="font-medium">Night Search</span>
              <span class="block text-[10px] text-slate-500">PC §1533 — requires good cause in the PC narrative.</span>
            </span>
          </label>
        </div>
      </div>
    </details>
  `;
}

// ─── VA face-page options (DC-338 / DC-339) ──────────────────────────────
//
// Mirrors the CA options panel pattern: a single <details> block that
// houses every VA-template-specific knob that doesn't fit elsewhere.
// Fields surface on DC-338 / DC-339 via the va-form-overlay module:
//
//   draft.va.item5.evidence              → CB08 (item 5 "constitutes evidence")
//   draft.va.item5.person                → CB15 (item 5 "is the person to be arrested")
//   draft.va.nightService.requested      → CB10 (DC-338 item 6 toggle)
//   draft.va.nightService.justification  → Text6 (DC-338 item 6 narrative)
//   draft.va.knowledge.personal          → CB12 (DC-338 item 7 personal knowledge)
//   draft.va.knowledge.hearsay           → CB13 (DC-338 item 7 hearsay basis)
//   draft.va.knowledge.reliability       → credibility narrative (Att. B)
//   draft.va.targetAccounts[]            → {provider, identifier} → DC-339 "undefined"
//   draft.va.advancedDc339.caption       → DC-339 "v./In re" caption override
//   draft.va.advancedDc339.captionLine2  → DC-339 "undefined_2" continuation
//   draft.va.advancedDc339.supplementalPageCount → DC-339 "undefined_3"
//
// Per-item DC-338 grounds (CB01-CB07) are deterministic for the ESP
// template — the overlay applies safe defaults (CB01,03,05,06,07 ticked;
// CB02,04 unticked). Power users can override via draft.va.grounds.cNN
// but the routine ESP workflow never touches them.

function _renderVaWarrantOptions(caseId, draft) {
  if (!draft) return '';
  const jx = String(draft.jurisdiction || '').toUpperCase();
  const isVa = jx === 'VA' || draft.template === 'va-multi-business-esp';
  if (!isVa) return '';

  const va = (draft.va && typeof draft.va === 'object') ? draft.va : {};
  const item5 = (va.item5 && typeof va.item5 === 'object') ? va.item5 : {};
  // ESP template default: evidence box ticked when neither sub-option set.
  const item5Evidence = (item5.evidence === undefined && item5.person === undefined && draft.template === 'va-multi-business-esp')
    ? true : !!item5.evidence;
  const item5Person   = !!item5.person;

  const ns = (va.nightService && typeof va.nightService === 'object') ? va.nightService : {};
  const nightRequested = !!ns.requested;
  const nightJustification = String(ns.justification || '');

  const k = (va.knowledge && typeof va.knowledge === 'object') ? va.knowledge : {};
  const knowledgePersonal = !!k.personal;
  const knowledgeHearsay  = !!k.hearsay;
  const knowledgeReliability = String(k.reliability || '');

  const targetAccounts = Array.isArray(va.targetAccounts) ? va.targetAccounts : [];

  const adv = (va.advancedDc339 && typeof va.advancedDc339 === 'object') ? va.advancedDc339 : {};
  const advCaption       = String(adv.caption || '');
  const advCaptionLine2  = String(adv.captionLine2 || '');
  const advSuppPages     = String(adv.supplementalPageCount || '');

  // Case Particulars — feeds DC-338 Text1..Text5 + DC-339 search location.
  // Each blank field falls back to "See Attachment {letter}" per ESP convention:
  //   Items 1-3 (Text1..Text4) → Attachment A (Production Schedule + identifiers)
  //   Item 4   (Text5)         → Attachment B (Statement of Material Facts / PC)
  //   Item 7   (Text9)         → Attachment C (Training & Experience Statement)
  const codeSection         = String(va.codeSection || '');
  const offenseDescription  = String(va.offenseDescription || '');
  const placeDescription    = String(va.placeDescription || '');
  const thingsToSearchFor   = String(va.thingsToSearchFor || '');
  const foreignCorpFacts    = String(va.foreignCorpFacts || '');
  const probableCauseSummary = String(va.probableCauseSummary || '');

  const cId = attr(caseId), dId = attr(draft.id);

  // status: how many populated facets
  const particularsFilled = [codeSection, offenseDescription, placeDescription, thingsToSearchFor, foreignCorpFacts, probableCauseSummary]
    .some(s => String(s || '').trim() !== '');
  const facets = [
    particularsFilled,
    item5Evidence || item5Person,
    nightRequested && nightJustification.length > 0,
    knowledgePersonal || knowledgeHearsay,
    targetAccounts.some(t => t && String(t.identifier || '').trim() !== ''),
  ];
  const filledFacets = facets.filter(Boolean).length;
  const statusColor = filledFacets >= 3 ? 'text-emerald-400' : 'text-amber-400';
  const statusIcon  = filledFacets >= 3 ? '✓' : '⚠';
  const statusText  = `${filledFacets}/5 facets populated`;

  const isOpen = (_state.vaOptionsOpen === undefined) ? true : !!_state.vaOptionsOpen;
  const advOpen = (_state.vaAdvancedDc339Open === undefined) ? false : !!_state.vaAdvancedDc339Open;

  // Case Particulars — DC-338 Text1..Text5 + DC-339 search-location
  const _attPill = (letter, color) => `<span class="ml-1 inline-flex items-center px-1.5 py-px rounded text-[9px] font-semibold uppercase tracking-wider ${color}">Att ${letter}</span>`;
  const caseParticularsHtml = `
    <div>
      <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-2">
        Case Particulars
        <span class="text-[10px] normal-case tracking-normal text-slate-500">— blank fields fall back to "See Attachment X"</span>
      </div>
      <div class="bg-slate-900/40 rounded border border-slate-800 p-2.5 space-y-2.5">

        <div class="grid grid-cols-3 gap-2">
          <div>
            <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
              Va. Code §
            </label>
            <input type="text" value="${attr(codeSection)}"
                   placeholder='e.g. "18.2-374.1"'
                   oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.codeSection', this.value)"
                   class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
          </div>
          <div class="col-span-2">
            <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center">
              Offense description (DC-338 Item 1)
              ${_attPill('A', 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50')}
            </label>
            <input type="text" value="${attr(offenseDescription)}"
                   placeholder='e.g. "Possession of child sexual abuse material"'
                   oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.offenseDescription', this.value)"
                   class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
          </div>
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center">
            Place / person / thing to be searched (DC-338 Item 2 + DC-339 search location)
            ${_attPill('A', 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50')}
          </label>
          <textarea rows="2"
                    placeholder='Leave blank to auto-render target accounts. Otherwise enter explicit description.'
                    oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.placeDescription', this.value)"
                    class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-none">${esc(placeDescription)}</textarea>
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center">
            Things or persons to search for (DC-338 Item 3)
            ${_attPill('A', 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50')}
          </label>
          <textarea rows="2"
                    placeholder='Leave blank for "See Attachment A". Otherwise short summary of records sought.'
                    oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.thingsToSearchFor', this.value)"
                    class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-none">${esc(thingsToSearchFor)}</textarea>
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center">
            Foreign-corp facts (DC-338 Item 3 sub-box)
            ${_attPill('A', 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50')}
          </label>
          <textarea rows="2"
                    placeholder='Material facts that the provider transacts business in VA. Leave blank for "See Attachment A".'
                    oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.foreignCorpFacts', this.value)"
                    class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-none">${esc(foreignCorpFacts)}</textarea>
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center">
            Probable-cause summary (DC-338 Item 4)
            ${_attPill('B', 'bg-purple-900/50 text-purple-300 border border-purple-700/50')}
          </label>
          <textarea rows="2"
                    placeholder='Short PC summary. Full narrative goes on Attachment B. Leave blank for "See Attachment B".'
                    oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.probableCauseSummary', this.value)"
                    class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-none">${esc(probableCauseSummary)}</textarea>
        </div>

        <div class="text-[10px] text-slate-500 pt-1 border-t border-slate-800/60">
          <span class="font-medium text-slate-400">Training &amp; Experience</span> (DC-338 Item 7)
          ${_attPill('C', 'bg-amber-900/50 text-amber-300 border border-amber-700/50')}
          — pulled from Agency Settings → Affiant Training. Auto-attaches as its own appendix for ESP warrants.
        </div>

      </div>
    </div>
  `;

  // Item 5 sub-options
  const item5Html = `
    <div>
      <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
        DC-338 Item 5 — Object, thing or person to be searched for
      </div>
      <div class="bg-slate-900/40 rounded border border-slate-800 p-1.5 space-y-0.5">
        <label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800/60 cursor-pointer">
          <input type="checkbox" ${item5Evidence ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.item5.evidence', this.checked)"
                 class="mt-0.5 accent-viper-cyan flex-shrink-0">
          <span class="text-xs text-slate-200 leading-snug">
            <span class="font-medium">constitutes evidence</span> of the commission of such offense
            <span class="block text-[10px] text-slate-500">CB08 — typical for ESP / records production warrants</span>
          </span>
        </label>
        <label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800/60 cursor-pointer">
          <input type="checkbox" ${item5Person ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.item5.person', this.checked)"
                 class="mt-0.5 accent-viper-cyan flex-shrink-0">
          <span class="text-xs text-slate-200 leading-snug">
            <span class="font-medium">is the person to be arrested</span> for whom a warrant or process for arrest has been issued
            <span class="block text-[10px] text-slate-500">CB15 — uncommon for ESP; tick only if searching for a person</span>
          </span>
        </label>
      </div>
    </div>
  `;

  // Night Service (item 6)
  const nightHtml = `
    <div class="pt-2 border-t border-slate-800">
      <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-slate-800/40">
        <input type="checkbox" ${nightRequested ? 'checked' : ''}
               onchange="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.nightService.requested', this.checked)"
               class="accent-viper-cyan flex-shrink-0">
        <span class="text-xs text-slate-200">
          <span class="font-medium">Night-Service Authorization</span> — DC-338 item 6 (CB10)
          <span class="block text-[10px] text-slate-500">Authorize execution outside 8:00 a.m. – 5:00 p.m. window.</span>
        </span>
      </label>
      ${nightRequested ? `
        <div class="pl-7 pr-2 pt-1">
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            Good-cause justification (Text6)
          </label>
          <textarea
            oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.nightService.justification', this.value)"
            placeholder="Articulate why night execution is necessary…"
            rows="3"
            class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-y">${esc(nightJustification)}</textarea>
        </div>
      ` : ''}
    </div>
  `;

  // Knowledge Basis (item 7)
  const knowledgeHtml = `
    <div class="pt-2 border-t border-slate-800">
      <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
        DC-338 Item 7 — Knowledge basis (check all that apply)
      </div>
      <div class="bg-slate-900/40 rounded border border-slate-800 p-1.5 space-y-0.5">
        <label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800/60 cursor-pointer">
          <input type="checkbox" ${knowledgePersonal ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.knowledge.personal', this.checked)"
                 class="mt-0.5 accent-viper-cyan flex-shrink-0">
          <span class="text-xs text-slate-200 leading-snug">
            <span class="font-medium">I have personal knowledge</span> of the facts set forth in this affidavit
            <span class="block text-[10px] text-slate-500">CB12</span>
          </span>
        </label>
        <label class="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800/60 cursor-pointer">
          <input type="checkbox" ${knowledgeHearsay ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.knowledge.hearsay', this.checked)"
                 class="mt-0.5 accent-viper-cyan flex-shrink-0">
          <span class="text-xs text-slate-200 leading-snug">
            <span class="font-medium">I was advised of the facts</span> in whole or in part by one or more other person(s)
            <span class="block text-[10px] text-slate-500">CB13 — requires credibility/reliability statement below</span>
          </span>
        </label>
      </div>
      ${knowledgeHearsay ? `
        <div class="pt-1.5">
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            Credibility / reliability of source(s)
          </label>
          <textarea
            oninput="WarrantAuthorUI.bus.onVaTextInput('${cId}','${dId}','va.knowledge.reliability', this.value)"
            placeholder="e.g. The reporting party is a sworn officer with the Chesapeake Police Department who personally observed…"
            rows="3"
            class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none resize-y">${esc(knowledgeReliability)}</textarea>
          <div class="text-[10px] text-slate-500 mt-1">
            Goes inline into the DC-338 Item 7 reliability text area (Text9). Long statements overflow to Att C.
          </div>
        </div>
      ` : ''}
    </div>
  `;

  // Target Accounts (DC-339 caption)
  const targetRowsHtml = targetAccounts.length === 0
    ? `<div class="text-[10px] text-slate-500 italic px-2 py-2 bg-slate-900/30 rounded border border-slate-800">
         No target accounts. Without explicit entries, the overlay falls back to the first addendum's provider + business name.
       </div>`
    : targetAccounts.map((t, i) => {
        const prov  = String(t && t.provider   || '');
        const ident = String(t && t.identifier || '');
        return `
          <div class="flex items-start gap-1.5 bg-slate-900/40 rounded border border-slate-800 p-1.5">
            <div class="flex-1 grid grid-cols-2 gap-1.5">
              <input type="text" value="${attr(prov)}"
                     placeholder="Provider (Snapchat / Google / Meta…)"
                     oninput="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.targetAccounts.${i}.provider', this.value)"
                     class="bg-slate-900/60 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
              <input type="text" value="${attr(ident)}"
                     placeholder='Identifier (e.g. "Wally1234" or user@gmail.com)'
                     oninput="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.targetAccounts.${i}.identifier', this.value)"
                     class="bg-slate-900/60 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
            </div>
            <button type="button"
                    onclick="WarrantAuthorUI.bus.onVaTargetAccountRemove('${cId}','${dId}',${i})"
                    class="text-[10px] text-rose-400 hover:text-rose-300 px-2 py-1 rounded hover:bg-rose-500/10 flex-shrink-0"
                    title="Remove">✕</button>
          </div>
        `;
      }).join('');

  const targetsHtml = `
    <div class="pt-2 border-t border-slate-800">
      <div class="flex items-center justify-between mb-1.5">
        <div class="text-[11px] uppercase tracking-wider text-slate-400">
          DC-339 Target Accounts (caption — "v./In re")
        </div>
        <button type="button"
                onclick="WarrantAuthorUI.bus.onVaTargetAccountAdd('${cId}','${dId}')"
                class="text-[10px] text-viper-cyan hover:text-cyan-300 px-2 py-0.5 rounded hover:bg-cyan-500/10">
          + Add Account
        </button>
      </div>
      <div class="space-y-1.5">
        ${targetRowsHtml}
      </div>
      <div class="text-[10px] text-slate-500 mt-1">
        Format on the warrant: <code class="text-slate-400">{Provider} Account "{identifier}"</code>.
        Multiple entries are joined with "; "; entries 1 and 2 land in DC-339 fields "undefined" and "undefined_2" respectively.
      </div>
    </div>
  `;

  // Advanced DC-339 (collapsible inside the VA panel)
  const advancedHtml = `
    <details class="pt-2 border-t border-slate-800 group" ${advOpen ? 'open' : ''}
             ontoggle="WarrantAuthorUI.bus.onVaAdvancedDc339Toggle(this.open)">
      <summary class="cursor-pointer select-none text-[11px] uppercase tracking-wider text-slate-400 hover:text-slate-300 flex items-center gap-1.5">
        <span class="group-open:rotate-90 inline-block transition-transform">▶</span>
        Advanced DC-339 Overrides
      </summary>
      <div class="pt-2 space-y-2">
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            Caption override (overrides auto-computed v./In re line)
          </label>
          <input type="text" value="${attr(advCaption)}"
                 placeholder='e.g. Snapchat Account "Wally1234"'
                 oninput="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.advancedDc339.caption', this.value)"
                 class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
        </div>
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            Caption continuation (DC-339 "undefined_2")
          </label>
          <input type="text" value="${attr(advCaptionLine2)}"
                 placeholder="(optional — right-column continuation)"
                 oninput="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.advancedDc339.captionLine2', this.value)"
                 class="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
        </div>
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            Supplemental sheet — number of pages (DC-339 "undefined_3")
          </label>
          <input type="text" value="${attr(advSuppPages)}"
                 placeholder='e.g. "2"'
                 oninput="WarrantAuthorUI.bus.onVaFieldSet('${cId}','${dId}','va.advancedDc339.supplementalPageCount', this.value)"
                 class="w-32 bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none">
          <div class="text-[10px] text-slate-500 mt-1">
            When set, an "X" is overlaid on the printed "Supplemental sheet attached and incorporated by reference" checkbox.
          </div>
        </div>
      </div>
    </details>
  `;

  return `
    <details class="bg-viper-dark/60 border border-slate-700 rounded-lg" ${isOpen ? 'open' : ''}
             ontoggle="WarrantAuthorUI.bus.onVaOptionsToggle(this.open)">
      <summary class="px-3 py-2 cursor-pointer select-none flex items-center justify-between hover:bg-slate-800/40">
        <span class="text-xs uppercase tracking-wider text-slate-300 font-medium">
          VA Face Page · DC-338 / DC-339 Form Fields
        </span>
        <span class="text-[11px] ${statusColor}">${statusIcon} ${esc(statusText)}</span>
      </summary>
      <div class="p-3 border-t border-slate-700 space-y-3">
        ${caseParticularsHtml}
        ${item5Html}
        ${nightHtml}
        ${knowledgeHtml}
        ${targetsHtml}
        ${advancedHtml}
      </div>
    </details>
  `;
}

// ─── PA (AOPC 410A) face-page options ────────────────────────────────────
// Surfaces the Pennsylvania Application + Affidavit officer-fill fields that
// feed modules/warrant-author/pa-form-overlay.js:
//   draft.pa.premisesDescription  → DescOfPremisesOrPersonSearched
//   draft.pa.ownerOccupant        → NameOfOwnerSearchedProp
//   draft.pa.itemsToSearchSeize   → IDItemsForSearchSeize (flows to continuation)
//   draft.pa.violationOf          → ViolationOf
//   draft.pa.datesOfViolation     → DATE(S) OF VIOLATION
//   draft.pa.daApproved/daFileNumber → ViolationCheckBox1 + DAFile#
//   draft.pa.county / policeIncidentNumber / warrantControlNumber → headers
//   draft.pa.photos[]             → appended photo-exhibit pages (2/page)
// The Affidavit narrative reuses the shared Case Probable Cause narrative
// (draft.probableCauseNarrative); signatures/issuing-authority left blank.
function _renderPaWarrantOptions(caseId, draft) {
  if (!draft) return '';
  const jx = String(draft.jurisdiction || '').toUpperCase();
  const isPa = jx === 'PA' || draft.template === 'pa-multi-business-esp';
  if (!isPa) return '';

  const pa = (draft.pa && typeof draft.pa === 'object') ? draft.pa : {};
  const cId = attr(caseId), dId = attr(draft.id);

  const county          = String(pa.county || '');
  const policeIncident  = String(pa.policeIncidentNumber || '');
  const warrantControl  = String(pa.warrantControlNumber || '');
  const items           = String(pa.itemsToSearchSeize || '');
  const premises        = String(pa.premisesDescription || '');
  const owner           = String(pa.ownerOccupant || '');
  const violationOf     = String(pa.violationOf || '');
  const datesOfViolation = String(pa.datesOfViolation || '');
  const daApproved      = !!pa.daApproved;
  const daFileNumber    = String(pa.daFileNumber || '');
  const photos          = Array.isArray(pa.photos) ? pa.photos : [];

  const isOpen = (_state.paOptionsOpen === undefined) ? true : !!_state.paOptionsOpen;

  // status: how many of the core application fields are populated
  const facets = [
    items.trim() !== '',
    premises.trim() !== '',
    owner.trim() !== '',
    violationOf.trim() !== '',
    String(draft.probableCauseNarrative || '').trim() !== '',
  ];
  const filledFacets = facets.filter(Boolean).length;
  const statusColor = filledFacets >= 4 ? 'text-emerald-400' : 'text-amber-400';
  const statusIcon  = filledFacets >= 4 ? '✓' : '⚠';
  const statusText  = `${filledFacets}/5 core fields populated`;

  const inputCls = 'w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:border-viper-cyan focus:outline-none';
  const areaCls  = inputCls + ' resize-none';
  const labelCls = 'block text-[10px] uppercase tracking-wider text-slate-400 mb-1';

  const photosHtml = photos.map((p, i) => {
    const src = attr(p && (p.dataUrl || p.pngBase64) || '');
    const cap = attr(p && p.caption || '');
    return `
      <div class="flex items-center gap-2 bg-slate-900/50 border border-slate-800 rounded p-2">
        <div class="w-14 h-14 flex-shrink-0 rounded overflow-hidden bg-slate-800 flex items-center justify-center">
          ${src ? `<img src="${src}" class="w-full h-full object-cover" alt="Exhibit ${i + 1}">` : '<span class="text-[9px] text-slate-500">no img</span>'}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[10px] text-slate-400 mb-1">Exhibit ${i + 1}</div>
          <input type="text" value="${cap}" placeholder="Caption (e.g. 'Front of residence')"
                 oninput="WarrantAuthorUI.bus.onPaPhotoCaption('${cId}','${dId}',${i}, this.value)"
                 class="${inputCls}">
        </div>
        <button onclick="WarrantAuthorUI.bus.onPaPhotoRemove('${cId}','${dId}',${i})"
                class="flex-shrink-0 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-900/30 border border-rose-800/50 rounded transition" title="Remove">
          Remove
        </button>
      </div>`;
  }).join('');

  return `
    <details class="bg-viper-dark/60 border border-slate-700 rounded-lg" ${isOpen ? 'open' : ''}
             ontoggle="WarrantAuthorUI.bus.onPaOptionsToggle(this.open)">
      <summary class="px-3 py-2 cursor-pointer select-none flex items-center justify-between hover:bg-slate-800/40">
        <span class="text-xs uppercase tracking-wider text-slate-300 font-medium">
          PA Face Page · AOPC 410A Application + Affidavit
        </span>
        <span class="text-[11px] ${statusColor}">${statusIcon} ${esc(statusText)}</span>
      </summary>
      <div class="p-3 border-t border-slate-700 space-y-3">

        <div class="text-[10px] text-slate-500 -mt-0.5">
          The Affidavit of Probable Cause narrative uses this case's shared
          <span class="text-slate-400 font-medium">Probable Cause narrative</span> and flows onto
          official continuation pages automatically. Issuing-authority fields and all signature
          lines are left blank for signing at issuance.
        </div>

        <div class="grid grid-cols-3 gap-2">
          <div>
            <label class="${labelCls}">County</label>
            <input type="text" value="${attr(county)}" placeholder="Auto from agency profile"
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.county', this.value)"
                   class="${inputCls}">
          </div>
          <div>
            <label class="${labelCls}">Police Incident #</label>
            <input type="text" value="${attr(policeIncident)}" placeholder="Auto from case #"
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.policeIncidentNumber', this.value)"
                   class="${inputCls}">
          </div>
          <div>
            <label class="${labelCls}">Warrant Control #</label>
            <input type="text" value="${attr(warrantControl)}"
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.warrantControlNumber', this.value)"
                   class="${inputCls}">
          </div>
        </div>

        <div>
          <label class="${labelCls}">Identify items/persons to be searched for &amp; seized</label>
          <textarea rows="4" placeholder="Be as specific as possible. Overflow flows onto the Application Continuation page."
                    oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.itemsToSearchSeize', this.value)"
                    class="${areaCls}">${esc(items)}</textarea>
        </div>

        <div>
          <label class="${labelCls}">Specific description of premises and/or person to be searched</label>
          <textarea rows="3" placeholder="Street & No., Apt. No., Vehicle, Safe Deposit Box, etc. Overflow flows to continuation."
                    oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.premisesDescription', this.value)"
                    class="${areaCls}">${esc(premises)}</textarea>
        </div>

        <div>
          <label class="${labelCls}">Name of owner, occupant or possessor</label>
          <input type="text" value="${attr(owner)}" placeholder="If unknown, give alias and/or description"
                 oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.ownerOccupant', this.value)"
                 class="${inputCls}">
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="${labelCls}">Violation of (conduct or statute)</label>
            <input type="text" value="${attr(violationOf)}" placeholder='e.g. "18 Pa.C.S. § 3502 (Burglary)"'
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.violationOf', this.value)"
                   class="${inputCls}">
          </div>
          <div>
            <label class="${labelCls}">Date(s) of violation</label>
            <input type="text" value="${attr(datesOfViolation)}"
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.datesOfViolation', this.value)"
                   class="${inputCls}">
          </div>
        </div>

        <div class="bg-slate-900/40 rounded border border-slate-800 p-2.5">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" ${daApproved ? 'checked' : ''}
                   onchange="WarrantAuthorUI.bus.onPaFieldSet('${cId}','${dId}','pa.daApproved', this.checked)"
                   class="rounded border-slate-600 bg-slate-900 text-viper-cyan focus:ring-0">
            <span class="text-xs text-slate-300">Warrant Application Approved by District Attorney (Pa.R.Crim.P. 202(A)/507)</span>
          </label>
          ${daApproved ? `
          <div class="mt-2">
            <label class="${labelCls}">DA File No.</label>
            <input type="text" value="${attr(daFileNumber)}"
                   oninput="WarrantAuthorUI.bus.onPaTextInput('${cId}','${dId}','pa.daFileNumber', this.value)"
                   class="${inputCls}">
          </div>` : ''}
        </div>

        <div>
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[11px] uppercase tracking-wider text-slate-400">
              Photographic Exhibits
              <span class="text-[10px] normal-case tracking-normal text-slate-500">— appended 2 per page after the affidavit</span>
            </span>
            <label class="px-2.5 py-1 text-[11px] text-viper-cyan hover:bg-viper-cyan/10 border border-viper-cyan/30 rounded transition cursor-pointer">
              + Add photos
              <input type="file" accept="image/png,image/jpeg" multiple class="hidden"
                     onchange="WarrantAuthorUI.bus.onPaPhotoFiles('${cId}','${dId}', this)">
            </label>
          </div>
          <div class="space-y-2">
            ${photos.length ? photosHtml : '<div class="text-[11px] text-slate-500 italic py-2">No photos attached. Use “Add photos” to attach PNG/JPEG images as numbered exhibits (Exhibit A, B, C…).</div>'}
          </div>
        </div>

      </div>
    </details>
  `;
}

function _runValidator(caseId, draft) {
  const V = _validator();
  if (!V) return null;
  const agencyProfile = _loadAgencyProfile();
  const pdir = _pdir();
  const providersMerged = pdir ? pdir.mergeProviders({
    providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
    customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
    providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
  }) : [];
  const pcStore = window.WarrantAuthorCasePcStore;
  const pcNarrative = (pcStore && pcStore.getBody)
    ? pcStore.getBody(caseId)
    : (draft.probableCauseNarrative || '');
  // Case-level offense (offense description + date live on the Case
  // Probable Cause panel). Pass through so the CO validator branch can
  // fall back to these without having to read the store itself.
  const caseCtx = {
    offenseDescription: (pcStore && pcStore.getOffenseDescription) ? pcStore.getOffenseDescription(caseId) : '',
    offenseDate:        (pcStore && pcStore.getOffenseDate)        ? pcStore.getOffenseDate(caseId)        : '',
  };
  try {
    return V.validateDraft({
      draft,
      agency: agencyProfile,
      providers: providersMerged,
      pcNarrative,
      caseCtx,
    });
  } catch (_e) {
    return null;
  }
}

function _renderValidatorPanel(caseId, draft) {
  const result = _runValidator(caseId, draft);
  if (!result) {
    return `<div class="wa-validator wa-validator--unloaded">Validator not loaded.</div>`;
  }
  const { errors, warnings, ok, stats } = result;

  let tone = 'ok';
  let icon = '✓';
  let title = 'Pre-flight: ready to generate';
  if (errors.length) {
    tone = 'fail';
    icon = '⛔';
    title = errors.length + ' hard error' + (errors.length === 1 ? '' : 's') +
            ' — generation blocked';
  } else if (warnings.length) {
    tone = 'warn';
    icon = '⚠';
    title = warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') +
            ' — generation allowed';
  }

  const subtitle = `${stats.addendumCount} addendum${stats.addendumCount === 1 ? '' : 's'} · ` +
                   `${errors.length} error${errors.length === 1 ? '' : 's'} · ` +
                   `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;

  const summarize = (issue) => {
    // Use the long label; if scope=addendum, prepend a chip.
    if (issue.scope === 'addendum' && issue.pageLabel) {
      return `<span class="wa-vl-chip">Page ${esc(issue.pageLabel)}</span> ${esc(issue.label)}`;
    }
    if (issue.scope === 'agency') {
      return `<span class="wa-vl-chip wa-vl-chip--agency">Agency</span> ${esc(issue.label)}`;
    }
    if (issue.scope === 'draft') {
      return `<span class="wa-vl-chip wa-vl-chip--draft">Draft</span> ${esc(issue.label)}`;
    }
    if (issue.scope === 'compose') {
      return `<span class="wa-vl-chip wa-vl-chip--compose">Page ${esc(issue.pageLabel || '?')}</span> ${esc(issue.label)}`;
    }
    return esc(issue.label);
  };

  const errorList = errors.length ? `
    <details class="wa-validator-group wa-validator-group--err" open>
      <summary>
        <span class="wa-vg-icon">⛔</span>
        <span class="wa-vg-title">${errors.length} hard error${errors.length === 1 ? '' : 's'}</span>
      </summary>
      <ul class="wa-validator-list">
        ${errors.map(e => `<li data-code="${attr(e.code)}">${summarize(e)}</li>`).join('')}
      </ul>
    </details>
  ` : '';

  const warnList = warnings.length ? `
    <details class="wa-validator-group wa-validator-group--warn"${errors.length ? '' : ' open'}>
      <summary>
        <span class="wa-vg-icon">⚠</span>
        <span class="wa-vg-title">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>
      </summary>
      <ul class="wa-validator-list">
        ${warnings.map(w => `<li data-code="${attr(w.code)}">${summarize(w)}</li>`).join('')}
      </ul>
    </details>
  ` : '';

  const body = (errors.length || warnings.length)
    ? `<div class="wa-validator-body">${errorList}${warnList}</div>`
    : `<div class="wa-validator-body wa-validator-body--ok">All checks pass — safe to generate.</div>`;

  return `
    <details class="wa-validator wa-validator--${tone}"${errors.length ? ' open' : ''}>
      <summary class="wa-validator-summary">
        <span class="wa-validator-icon">${icon}</span>
        <span class="wa-validator-title">${esc(title)}</span>
        <span class="wa-validator-sub">${esc(subtitle)}</span>
        <span class="wa-validator-chevron">▾</span>
      </summary>
      ${body}
    </details>
  `;
}

function _renderAddendumRail(caseId, draft, activeId) {
  const ads = draft.addendums || [];
  const rows = ads.map(a => {
    const isActive = a.id === activeId;
    const pkLabel = a.providerKey || '(no provider)';
    return `
      <button onclick="WarrantAuthorUI.bus.onSelectAddendum('${attr(caseId)}','${attr(draft.id)}','${attr(a.id)}')"
              class="wa-addendum-pill ${isActive ? 'active' : ''}">
        <span class="wa-page-label">${esc(a.pageLabel)}</span>
        <span class="wa-page-provider">${esc(pkLabel)}</span>
      </button>
    `;
  }).join('');
  return `
    <div class="space-y-2">
      <div class="text-[10px] uppercase tracking-wider text-slate-500 px-1">Addendums</div>
      ${rows || '<div class="text-[11px] text-slate-500 px-1">No addendums yet.</div>'}
      <button onclick="WarrantAuthorUI.bus.onAddAddendum('${attr(caseId)}','${attr(draft.id)}')"
              class="w-full text-xs px-2 py-1.5 bg-viper-cyan/10 hover:bg-viper-cyan/20 border border-dashed border-viper-cyan/40 text-viper-cyan rounded">
        + Add Addendum
      </button>
    </div>
  `;
}

function _renderAddendumEmptyForm(caseId, draftId) {
  return `
    <div class="wa-empty-mini">
      <div class="text-slate-400 text-sm mb-3">Add an addendum to start authoring per-provider sections.</div>
      <button onclick="WarrantAuthorUI.bus.onAddAddendum('${attr(caseId)}','${attr(draftId)}')"
              class="px-3 py-2 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan/50 text-viper-cyan rounded text-sm">
        + Add First Addendum
      </button>
    </div>
  `;
}

function _renderAddendumForm(caseId, draft, addendumId, harvest) {
  const ad = draft.addendums.find(a => a.id === addendumId);
  if (!ad) return _renderAddendumEmptyForm(caseId, draft.id);

  // CO Multi-Business ESP exposes an extra "Basis for Date Range" field
  // (template block 15). Detected by jurisdiction or template id.
  const isCo = (String(draft.jurisdiction || '').toUpperCase() === 'CO')
            || /(^|[-_])co[-_]/i.test(String(draft.template || ''));

  const pdir = _pdir();
  const merged = pdir ? pdir.mergeProviders({
    providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
    customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
    providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
  }) : [];

  const providerOpts = ['<option value="">— Select provider —</option>'].concat(
    merged.map(p => `<option value="${attr(p.key)}" ${p.key === ad.providerKey ? 'selected' : ''}>${esc(p.name)} (${esc(p.providerType || '?')})</option>`)
  ).join('');

  const items = _items();
  const patternKeys = items ? items.listPatternKeys() : [];
  const resolvedItemKeys = (ad.itemsToProduce && ad.itemsToProduce.length)
    ? ad.itemsToProduce.slice()
    : (items && ad.providerKey ? items.resolvePatternKeys(items.defaultPatternFor(ad.providerKey)) : []);
  const allItems = items ? items.allItems() : [];
  const checked = new Set(resolvedItemKeys);

  const targetRows = (ad.targetAccounts || []).map((t, i) => `
    <div class="flex gap-2 items-center">
      <select onchange="WarrantAuthorUI.bus.onTargetFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}',${i},'type',this.value)"
              class="px-2 py-1 bg-viper-dark border border-slate-700 rounded text-white text-xs">
        ${['esp-user-id','email','phone','username','ip','screen-name'].map(o =>
          `<option value="${o}" ${t.type === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
      <input type="text" value="${attr(t.value)}" placeholder="value"
             onchange="WarrantAuthorUI.bus.onTargetFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}',${i},'value',this.value)"
             class="flex-1 px-2 py-1 bg-viper-dark border border-slate-700 rounded text-white text-xs font-mono">
      <button onclick="WarrantAuthorUI.bus.onRemoveTarget('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}',${i})"
              class="px-2 py-1 text-rose-300 hover:text-rose-200 text-xs">✕</button>
    </div>
  `).join('');

  // ─── autofill picker ────────────────────────────────────────────────
  const _autofillList = function (bucket, type) {
    const arr = harvest[bucket] || [];
    if (!arr.length) return '';
    return `
      <div class="wa-autofill-group">
        <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">${esc(bucket)}</div>
        <div class="flex flex-wrap gap-1">
          ${arr.slice(0, 8).map(rec => `
            <button onclick="WarrantAuthorUI.bus.onAutofillTarget('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','${attr(type)}','${attr(rec.value)}')"
                    class="wa-autofill-chip" title="${attr(rec.sources.map(s => s.source).join(', '))}">
              ${esc(rec.value)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  };
  const autofill = (_autofillList('emails','email') + _autofillList('phones','phone') +
                    _autofillList('usernames','username') + _autofillList('ips','ip'));

  return `
    <div class="wa-form space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-sm font-medium text-white">
          Addendum <span class="text-viper-cyan font-mono">${esc(ad.pageLabel)}</span>
        </div>
        <button onclick="WarrantAuthorUI.bus.onRemoveAddendum('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}')"
                class="text-xs text-rose-300 hover:text-rose-200">Remove</button>
      </div>

      <!-- Provider -->
      <label class="block text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Provider</span>
        <select onchange="WarrantAuthorUI.bus.onAddendumProviderChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}',this.value)"
                class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
          ${providerOpts}
        </select>
      </label>

      <!-- Date range -->
      <!-- Plain text inputs (not type="date") so Chromium's native date
           segment editor doesn't fight us. User types MM/DD/YYYY; we
           parse to ISO YYYY-MM-DD on blur via _usDateToIso. -->
      <div class="grid grid-cols-2 gap-2">
        <label class="block text-xs">
          <span class="text-slate-400 uppercase tracking-wider">From <span class="text-slate-500 normal-case">(MM/DD/YYYY)</span></span>
          <input type="text" inputmode="numeric" autocomplete="off" maxlength="10"
                 placeholder="MM/DD/YYYY"
                 value="${attr(_isoToUsDate(ad.dateRangeFrom))}"
                 onblur="WarrantAuthorUI.bus.onAddendumDateBlur('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeFrom',this.value)"
                 class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm font-mono">
        </label>
        <label class="block text-xs">
          <span class="text-slate-400 uppercase tracking-wider">To <span class="text-slate-500 normal-case">(MM/DD/YYYY)</span></span>
          <input type="text" inputmode="numeric" autocomplete="off" maxlength="10"
                 placeholder="MM/DD/YYYY"
                 value="${attr(_isoToUsDate(ad.dateRangeTo))}"
                 onblur="WarrantAuthorUI.bus.onAddendumDateBlur('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeTo',this.value)"
                 class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm font-mono">
        </label>
      </div>
      ${isCo ? `
      <!-- CO only: Basis for the requested date range (template block 15).
           If left blank, a neutral default sentence prints so the document
           never shows a raw {{addendum.dateRangeBasis}} token. -->
      <label class="block text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Basis for Date Range <span class="text-slate-500 normal-case">(optional — CO)</span></span>
        <textarea rows="2"
                  placeholder="e.g. The date range aligns with the suspected account activity established in the probable cause."
                  onblur="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeBasis',this.value)"
                  class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm resize-y">${esc(ad.dateRangeBasis || '')}</textarea>
      </label>
      ` : ''}

      <!-- Target accounts -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-slate-400 uppercase tracking-wider text-xs">Target Accounts</span>
          <button onclick="WarrantAuthorUI.bus.onAddTarget('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}')"
                  class="text-[11px] text-viper-cyan hover:underline">+ Add Target</button>
        </div>
        <div class="space-y-1">${targetRows || '<div class="text-[11px] text-slate-500">No targets — add at least one.</div>'}</div>
        ${autofill ? `<div class="mt-2 p-2 bg-viper-dark/40 border border-slate-700 rounded">
          <div class="text-[10px] uppercase tracking-wider text-viper-orange mb-1">Auto-fill from case data</div>
          ${autofill}
        </div>` : ''}
      </div>

      <!-- Items to seize -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-slate-400 uppercase tracking-wider text-xs flex items-center gap-1.5">
            Items to Produce
            <button type="button"
                    onclick="WarrantAuthorUI.bus.onShowAddendumHelp()"
                    title="What do these patterns and clauses mean?"
                    class="inline-flex items-center justify-center w-4 h-4 rounded-full border border-viper-cyan/50 text-viper-cyan text-[10px] leading-none hover:bg-viper-cyan/20 hover:text-white">?</button>
          </span>
          <select onchange="WarrantAuthorUI.bus.onApplyPattern('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}',this.value); this.selectedIndex=0;"
                  class="text-[11px] px-2 py-1 bg-viper-dark border border-slate-700 rounded text-slate-300">
            <option value="">Apply pattern…</option>
            ${patternKeys.map(p => `<option value="${attr(p)}">${esc(p)}</option>`).join('')}
          </select>
        </div>
        <div class="max-h-40 overflow-y-auto pr-1 grid grid-cols-2 gap-1 p-2 bg-viper-dark/40 border border-slate-700 rounded">
          ${allItems.map(it => `
            <label class="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer hover:text-white">
              <input type="checkbox" ${checked.has(it.key) ? 'checked' : ''}
                     onchange="WarrantAuthorUI.bus.onToggleItem('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','${attr(it.key)}',this.checked)"
                     class="mt-0.5">
              <span class="truncate" title="${attr(it.description || it.label)}">${esc(it.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <!-- Optional clauses (jurisdiction-aware labels; same underlying flags) -->
      ${_renderAddendumOptionalClauses(caseId, draft, ad)}
    </div>
  `;
}

/**
 * Renders the 4 optional-clause checkboxes for an addendum. Labels swap
 * by draft.jurisdiction so non-CA users see federal SCA citations (18
 * U.S.C. § 2705) instead of CalECPA (§ 1546.x). The underlying flag names
 * (`includeNonDisclosure`, `includeNonDisclosureInfoSupport`,
 * `includeDelay1546_2a`, `includeCalecpaSealing`) are kept stable so the
 * draft store / block-builder paths are unchanged — only the rendered
 * label + tooltip vary.
 *
 * Citation notes:
 *  • CA → CalECPA Penal Code §§ 1546.2(b), 1546.2(a), 1546.1(d)(3)
 *  • VA / CO / US-generic → No state-law equivalent for these specific
 *    clauses; standard practice for warrants served on nationwide ESPs
 *    is the federal SCA at 18 U.S.C. § 2705(b) (NDO) and § 2705(a)
 *    (delay-of-notice). Court-file sealing is by motion under local
 *    state rules (e.g. Va. Code §§ 17.1-208 / 19.2-265.01; Colo. C.R.S.
 *    § 16-3-305.5).
 */
function _renderAddendumOptionalClauses(caseId, draft, ad) {
  const jx = (draft.jurisdiction || '').toUpperCase();
  const tpl = String(draft.template || '');
  // CalECPA §1546.x clauses are California-specific. Show them ONLY when
  // the draft jurisdiction / template is CA. All other states (VA, CO,
  // US-generic, anything we add later) fall through to the federal SCA
  // labels — never expose §1546.x outside CA.
  const isCa = (jx === 'CA') || tpl.startsWith('ca-');
  const labels = isCa ? {
    ndo:       { text: 'NDO (90-day)',              tip: 'Non-Disclosure Order under Cal. Pen. Code § 1546.2(b).' },
    ndoInfo:   { text: 'NDO Info-Support',          tip: 'Companion clause that articulates the factual basis for the NDO. Always check this when you check NDO.' },
    delay:     { text: 'Delay (§1546.2(a))',        tip: 'Use when contemporaneous notice to the subscriber would jeopardize the investigation. NDO covers the provider; this covers your duty to notify the user.' },
    sealing:   { text: '§1546.1(d)(3) Sealing',     tip: 'Asks the magistrate to seal the warrant, affidavit, and returns from public inspection. Distinct from NDO — NDO binds the provider; sealing binds the court file.' },
  } : {
    ndo:       { text: 'NDO (90-day) — §2705(b)',   tip: 'Non-Disclosure Order under 18 U.S.C. § 2705(b) (federal SCA). Used for warrants served on out-of-state ESPs in jurisdictions without an equivalent state-law NDO statute.' },
    ndoInfo:   { text: 'NDO Info-Support',          tip: 'Factual articulation supporting the § 2705(b) NDO finding. Check this whenever NDO is checked.' },
    delay:     { text: 'Delay-of-Notice — §2705(a)',tip: 'Order delaying notice to the subscriber under 18 U.S.C. § 2705(a). Covers the affiant\'s duty to notify the user; the NDO covers the provider.' },
    sealing:   { text: 'Court Sealing (motion)',    tip: 'Request to seal the warrant, affidavit, and returns from public inspection. Handled by motion under local state-court rules (e.g. Va. Code §§ 17.1-208 / 19.2-265.01; Colo. C.R.S. § 16-3-305.5).' },
  };
  return `
      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
        <label class="flex items-center gap-2 text-xs text-slate-300" title="${attr(labels.ndo.tip)}">
          <input type="checkbox" ${ad.includeNonDisclosure ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeNonDisclosure',this.checked)">
          ${esc(labels.ndo.text)}
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300" title="${attr(labels.ndoInfo.tip)}">
          <input type="checkbox" ${ad.includeNonDisclosureInfoSupport ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeNonDisclosureInfoSupport',this.checked)">
          ${esc(labels.ndoInfo.text)}
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300" title="${attr(labels.delay.tip)}">
          <input type="checkbox" ${ad.includeDelay1546_2a ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeDelay1546_2a',this.checked)">
          ${esc(labels.delay.text)}
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300" title="${attr(labels.sealing.tip)}">
          <input type="checkbox" ${ad.includeCalecpaSealing ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeCalecpaSealing',this.checked)">
          ${esc(labels.sealing.text)}
        </label>
      </div>
  `;
}

// ─── live preview ──────────────────────────────────────────────────────

function _renderLivePreview(caseId, draft, activeId) {
  const engine = _engine();
  if (!engine) {
    return `<div class="wa-preview"><div class="wa-empty-mini text-slate-400 text-sm">Template engine unavailable.</div></div>`;
  }
  const ad = (draft.addendums || []).find(a => a.id === activeId);
  if (!ad) {
    return `<div class="wa-preview"><div class="wa-empty-mini text-slate-400 text-sm">Select or add an addendum to preview.</div></div>`;
  }

  const tpl = engine.getTemplate(draft.template);
  if (!tpl) {
    return `<div class="wa-preview"><div class="wa-empty-mini text-rose-300 text-sm">Template '${esc(draft.template)}' not loaded.</div></div>`;
  }

  // resolve provider from directory (merged)
  const pdir = _pdir();
  let provider = null;
  if (pdir) {
    const merged = pdir.mergeProviders({
      providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
      customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
      providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
    });
    provider = merged.find(p => p.key === ad.providerKey) || null;
  }

  // resolve items taxonomy API (the engine calls tax.resolveForProvider /
  // resolvePattern internally — pass the API, NOT a pre-resolved array)
  const items = _items();

  // Adapt addendum shape to what the engine expects:
  //   targets        ← targetAccounts (filter to non-empty)
  //   dateRange      ← { start: dateRangeFrom, end: dateRangeTo, allAvailable }
  //   itemsPattern   ← if user checked custom items, switch pattern to 'custom'
  //                    and the engine resolution path will fall to the
  //                    `addendum.itemsToProduce` override (handled below).
  const adForEngine = Object.assign({}, ad, {
    targets: Array.isArray(ad.targetAccounts)
      ? ad.targetAccounts.filter(t => t && String(t.value || '').trim() !== '')
      : [],
    dateRange: {
      start: ad.dateRangeFrom || '',
      end:   ad.dateRangeTo   || '',
      allAvailable: !!ad.allDatesAvailable,
    },
    // itemsToProduce is the array of checkbox-selected item keys —
    // engine override path consumes this directly.
    itemsToProduce: Array.isArray(ad.itemsToProduce) ? ad.itemsToProduce.slice() : [],
    // Probable Cause lives at the CASE level (pc store) / mirrored on the
    // draft — inject it so the CO template's {{addendum.probableCause}}
    // slot resolves instead of dangling.
    probableCause: _resolvePcForDraft(caseId, draft),
    // Date-range basis: CO block 15 ({{addendum.dateRangeBasis}}). Falls
    // back to a neutral sentence so the slot never prints raw.
    dateRangeBasis: _resolveDateRangeBasis(ad),
  });

  const _coAgency = _mergeAgencyForDraft(draft);
  const ctx = {
    addendum: adForEngine,
    provider: provider || { key: ad.providerKey, name: ad.providerKey || '(no provider)' },
    items, // taxonomy API module
    affiant: _coAgency,
    agency:  _coAgency,
    draft,
    // Colorado template needs court (selected per-draft from agency.coCourts)
    // + case info (case number, offense). The block-builder reads these
    // from the resolved blocks emitted by the CO resolvers.
    court: _resolveCoCourtForDraft(draft),
    case: _resolveCaseCtxForDraft(draft),
  };

  let result;
  try {
    result = engine.compose(tpl, ctx);
  } catch (err) {
    return `<div class="wa-preview"><div class="wa-empty-mini text-rose-300 text-sm">Preview error: ${esc(err.message)}</div></div>`;
  }

  const blocks = (result && result.blocks) || [];
  const danglingRaw = (result && result.danglingSlots) || [];
  const missingRaw  = (result && result.missingItems);
  // Coerce to arrays — template engine returns missingItems as a boolean
  // flag, danglingSlots as an array. Be defensive for both shapes.
  const dangling = Array.isArray(danglingRaw) ? danglingRaw : [];
  const missingItems = Array.isArray(missingRaw) ? missingRaw : (missingRaw ? ['(see Items to Seize)'] : []);

  const html = blocks.map((b, i) => {
    if (b.omitted) return '';
    const heading = b.heading ? `<div class="wa-pv-heading">${esc(b.heading)}</div>` : '';
    let body = '';
    if (b.kind === 'items-to-seize' && Array.isArray(b.items)) {
      if (b.style === 'semicolons') {
        // CO semicolon-terminated list — render as semicolon paragraphs
        // so the preview matches the exported DOCX faithfully.
        body = `<div class="wa-pv-text">${b.items.map((it, idx) => {
          const txt = (it.description || it.label || it.key || '').trim().replace(/[.;]?\s*$/, '');
          const sep = (idx === b.items.length - 1) ? '.' : ';';
          return esc(txt + sep);
        }).join('<br>')}</div>`;
      } else {
        body = `<ol class="wa-pv-list">${b.items.map(it => `<li><span class="wa-pv-item-label">${esc(it.label || it.key)}</span>${it.description ? ` — <span class="wa-pv-item-desc">${esc(it.description)}</span>` : ''}</li>`).join('')}</ol>`;
      }
    } else if (b.kind === 'co-caption') {
      const captionLine = `${(b.courtName || 'COUNTY/DISTRICT COURT')}, ${b.judicialDistrict ? b.judicialDistrict + ' JUDICIAL DISTRICT, ' : ''}COLORADO`.toUpperCase();
      body = `<div class="wa-pv-text text-center font-semibold">${esc(captionLine)}</div>
              <div class="wa-pv-text text-center text-slate-400">Case No. ${esc(b.caseNumber || '[case number]')}</div>
              ${b.documentTitle ? `<div class="wa-pv-text text-center font-bold mt-1">${esc(b.documentTitle)}</div>` : ''}`;
    } else if (b.kind === 'co-provider-block') {
      body = `<div class="wa-pv-text">${_safeMultilineHtml(b.text || '')}</div>`;
    } else if (b.kind === 'co-affiant-signature') {
      body = `<div class="wa-pv-text">Subscribed and Sworn to in the ${esc(b.judicialDistrict || '_______')} Judicial District of Colorado<br><br>______________________________<br><span class="text-slate-400">Signature of Affiant</span></div>`;
    } else if (b.kind === 'co-judge-oath-affidavit') {
      body = `<div class="wa-pv-text">Subscribed under oath before me on this ___ day of __________, 20__ in the ${esc(b.judicialDistrict || '_______')} Judicial District of Colorado<br><br>______________________________<br><span class="text-slate-400">Signature of Judge</span><br><br>______________________________<br><span class="text-slate-400">Printed Name of Judge</span></div>`;
    } else if (b.kind === 'co-judge-signature') {
      body = `<div class="wa-pv-text">Date<br>In the ${esc(b.judicialDistrict || '_______')} Judicial District, Colorado<br><br>______________________________<br><span class="text-slate-400">Signature of Judge</span><br><br>______________________________<br><span class="text-slate-400">Printed Name of Judge</span></div>`;
    } else if (b.kind === 'co-da-approval') {
      body = `<div class="wa-pv-text">APPROVED AS TO FORM:<br>${esc(b.daName || '[District Attorney Name]')}<br>${esc(b.daTitle || 'District Attorney')}<br>By /s<br>${esc(b.daDeputyLine || '[Chief][Senior] Deputy District Attorney')}</div>`;
    } else if (b.kind === 'page-break') {
      body = `<div class="wa-pv-text text-center text-amber-400 italic border-t border-b border-dashed border-amber-500/40 py-1 my-1">— Page Break —</div>`;
    } else if (b.text) {
      body = `<div class="wa-pv-text">${_safeMultilineHtml(b.text)}</div>`;
    } else {
      body = '<div class="wa-pv-text text-slate-500 italic">(empty block)</div>';
    }
    return `<div class="wa-pv-block" data-kind="${attr(b.kind || '')}">
      <div class="wa-pv-block-num">#${i + 1}</div>
      ${heading}
      ${body}
    </div>`;
  }).join('');

  const issuesBar = (dangling.length || missingItems.length) ? _renderIssuesPanel(dangling, missingItems) : '';

  return `
    <div class="wa-preview">
      <div class="wa-pv-title">Live Preview — ${esc(
        draft.template === 'ca-multi-business-esp' ? 'CA template'
        : draft.template === 'va-multi-business-esp' ? 'VA template'
        : draft.template === 'co-multi-business-esp' ? 'CO template'
        : 'US template'
      )} · Page ${esc(ad.pageLabel)}</div>
      ${issuesBar}
      <div class="wa-pv-body">${html || '<div class="text-slate-500 text-sm">No blocks rendered.</div>'}</div>
    </div>
  `;
}

// preserves single \n as <br> while still escaping html
function _safeMultilineHtml(text) {
  return esc(text).split(/\n/g).map(l => l).join('<br>');
}

/**
 * Block modal: shown when validateDraft.errors is non-empty. User cannot
 * proceed — they must close, fix the issues, and re-click Generate.
 */
function _showValidatorBlockModal(caseId, draft, vres) {
  const ov = document.getElementById('waModalOverlay');
  if (!ov) {
    // No overlay → fall back to alert so the user is never silently blocked.
    const lines = vres.errors.map(e => '• ' + e.label).join('\n');
    alert('Cannot generate — ' + vres.errors.length + ' hard error(s):\n\n' + lines);
    return;
  }
  const errBlocks = vres.errors.map(e => {
    const chip = e.scope === 'agency'    ? '<span class="wa-vl-chip wa-vl-chip--agency">Agency</span>'
              : e.scope === 'draft'     ? '<span class="wa-vl-chip wa-vl-chip--draft">Draft</span>'
              : e.scope === 'compose'   ? `<span class="wa-vl-chip wa-vl-chip--compose">Page ${esc(e.pageLabel||'?')}</span>`
              : e.pageLabel             ? `<span class="wa-vl-chip">Page ${esc(e.pageLabel)}</span>`
              : '';
    return `<li>${chip}${esc(e.label)}</li>`;
  }).join('');
  const warnBlocks = vres.warnings.length ? `
      <details class="wa-validator-group wa-validator-group--warn mt-3">
        <summary><span class="wa-vg-icon">⚠</span><span class="wa-vg-title">${vres.warnings.length} warning${vres.warnings.length===1?'':'s'} (also outstanding)</span></summary>
        <ul class="wa-validator-list">
          ${vres.warnings.map(w => `<li>${esc(w.label)}</li>`).join('')}
        </ul>
      </details>` : '';
  ov.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onclick="event.target===this && WarrantAuthorUI.bus.onCloseValidatorModal()">
      <div class="wa-modal" style="max-width:640px">
        <div class="wa-modal-header">
          <span class="text-rose-400">⛔</span>
          <span>Cannot generate — ${vres.errors.length} hard error${vres.errors.length===1?'':'s'}</span>
          <button class="ml-auto text-slate-400 hover:text-white" onclick="WarrantAuthorUI.bus.onCloseValidatorModal()">✕</button>
        </div>
        <div class="wa-modal-body">
          <div class="text-sm text-slate-300 mb-3">
            Fix the issues below, then click <span class="text-emerald-300">Generate PDF + DOCX</span> again.
          </div>
          <ul class="wa-validator-list">${errBlocks}</ul>
          ${warnBlocks}
        </div>
        <div class="wa-modal-footer">
          <button class="wa-btn-secondary" onclick="WarrantAuthorUI.bus.onCloseValidatorModal()">Close</button>
        </div>
      </div>
    </div>
  `;
  ov.classList.remove('hidden');
}

/**
 * Warning confirm — shown when validateDraft.ok but warnings exist.
 * Returns a Promise<boolean>: true = proceed, false = cancel.
 */
function _confirmValidatorWarnings(vres) {
  return new Promise((resolve) => {
    const ov = document.getElementById('waModalOverlay');
    if (!ov) {
      const lines = vres.warnings.map(w => '• ' + w.label).join('\n');
      resolve(window.confirm(
        'Generation allowed but ' + vres.warnings.length +
        ' warning(s) outstanding:\n\n' + lines +
        '\n\nProceed anyway?'
      ));
      return;
    }
    _state._validatorResolve = resolve;
    const list = vres.warnings.map(w => {
      const chip = w.scope === 'agency' ? '<span class="wa-vl-chip wa-vl-chip--agency">Agency</span>'
                : w.scope === 'draft'  ? '<span class="wa-vl-chip wa-vl-chip--draft">Draft</span>'
                : w.pageLabel          ? `<span class="wa-vl-chip">Page ${esc(w.pageLabel)}</span>`
                : '';
      return `<li>${chip}${esc(w.label)}</li>`;
    }).join('');
    ov.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onclick="event.target===this && WarrantAuthorUI.bus.onResolveValidatorConfirm(false)">
        <div class="wa-modal" style="max-width:640px">
          <div class="wa-modal-header">
            <span class="text-amber-300">⚠</span>
            <span>${vres.warnings.length} warning${vres.warnings.length===1?'':'s'} — proceed with generation?</span>
            <button class="ml-auto text-slate-400 hover:text-white" onclick="WarrantAuthorUI.bus.onResolveValidatorConfirm(false)">✕</button>
          </div>
          <div class="wa-modal-body">
            <div class="text-sm text-slate-300 mb-3">
              No hard errors. These warnings won't block generation, but review before serving on the providers.
            </div>
            <ul class="wa-validator-list">${list}</ul>
          </div>
          <div class="wa-modal-footer">
            <button class="wa-btn-secondary" onclick="WarrantAuthorUI.bus.onResolveValidatorConfirm(false)">Cancel</button>
            <button class="wa-btn-primary" onclick="WarrantAuthorUI.bus.onResolveValidatorConfirm(true)">Generate anyway</button>
          </div>
        </div>
      </div>
    `;
    ov.classList.remove('hidden');
  });
}

/**
 * Mount the addendum Help / Legend modal into #waModalOverlay.
 * Explains the "Apply pattern…" dropdown (what each pattern key means
 * + which providers it's for) and the four optional CalECPA clauses
 * (NDO 90-day, NDO Info-Support, Delay §1546.2(a), §1546.1(d)(3)
 * Sealing). Pure read-only — no draft state mutation.
 */
function _showAddendumHelpModal() {
  const ov = document.getElementById('waModalOverlay');
  if (!ov) return;

  // ── Patterns: keep labels in sync with PATTERN_BUNDLES in items-taxonomy.js ─
  const patterns = [
    { key: 'A',                title: 'Social Media / ESP base',          providers: 'Snapchat, TikTok, Twitter / X, WhatsApp, Discord, Meta', what: 'Standard ESP set: subscriber info, account credentials, payment/billing, IP history, messages, media, location data, internet artifacts, device IDs, multimedia metadata.' },
    { key: 'A+snaps',          title: 'Social Media + Snaps',             providers: 'Snapchat',                                                what: 'Pattern A with the Snapchat-specific "Snaps and Memories" item added.' },
    { key: 'B',                title: 'ISP / Carrier base',               providers: 'Charter / Spectrum, Ultimate Internet, Zscaler',          what: 'Minimal ISP subscriber + connection records: subscriber info, payment/billing, IP history, device identification.' },
    { key: 'B+telephony',      title: 'ISP + Telephony (VoIP)',           providers: 'TextNow',                                                 what: 'Pattern B plus account credentials, message content, and CDR for VoIP carriers.' },
    { key: 'B+cdr+cell',       title: 'Full Telecom (CDR + Cell)',        providers: 'T-Mobile, Sprint, AT&T, Verizon',                         what: 'Pattern B plus call-detail records and cell-site / tower information.' },
    { key: 'C',                title: 'Custom base',                      providers: 'Microsoft, Yahoo, fallback',                              what: 'Catch-all minimum: subscriber info, account credentials, payment/billing, IP history, messages, media, device identification.' },
    { key: 'C+transactions',   title: 'Custom + Transactions',            providers: 'Venmo, PayPal, Cash App',                                 what: 'Pattern C plus transaction records and internet artifacts (no message content emphasis).' },
    { key: 'mail+drive',       title: 'Mailbox + Cloud Drive',            providers: 'Google, Microsoft 365, Yahoo Mail',                       what: 'Full mailbox + cloud storage set: subscriber, credentials, payment/billing, IP history, messages, media, drive contents, location, devices, metadata.' },
    { key: 'custom',           title: 'Custom (no preset)',               providers: '—',                                                       what: 'Start from a clean slate — tick only the boxes you actually need.' },
  ];

  const patternRows = patterns.map(p => `
    <tr class="border-b border-slate-800/60">
      <td class="py-1.5 pr-3 align-top">
        <code class="text-viper-cyan font-mono text-[12px] whitespace-nowrap">${esc(p.key)}</code>
      </td>
      <td class="py-1.5 pr-3 align-top text-slate-200 text-[12px]">${esc(p.title)}</td>
      <td class="py-1.5 pr-3 align-top text-slate-400 text-[11px]">${esc(p.providers)}</td>
      <td class="py-1.5 align-top text-slate-300 text-[11px] leading-snug">${esc(p.what)}</td>
    </tr>
  `).join('');

  // ── Optional clauses ──────────────────────────────────────────────
  const clauses = [
    {
      name: 'NDO (90-day)',
      what: 'Non-Disclosure Order under 18 U.S.C. §2705(b) / Cal. Pen. Code §1546.2(b).',
      when: 'Use when notice to the subscriber would jeopardize the investigation — e.g., evidence destruction, witness intimidation, flight risk, or danger to a person.',
      effect: 'Orders the provider not to notify the subscriber, user, or any third party (other than provider counsel) about the warrant or production for 90 days.'
    },
    {
      name: 'NDO Info-Support',
      what: 'Companion clause that articulates the factual basis for the NDO.',
      when: 'Always check this when you check NDO (90-day). Without articulation, courts can deny or quash sealing.',
      effect: 'Inserts the standard "court finds reason to believe…" findings paragraph that supports the non-disclosure order.'
    },
    {
      name: 'Delay (§1546.2(a))',
      what: 'CalECPA delay-of-notice. California-only.',
      when: 'Use on California warrants when contemporaneous notice to the subscriber would jeopardize the investigation. NDO covers the provider; this covers your duty to notify the user.',
      effect: 'Authorizes you to delay your statutory notice to the target/user by 90 days. Notice still has to be served within 3 days of the delay period expiring.'
    },
    {
      name: '§1546.1(d)(3) Sealing',
      what: 'CalECPA sealing of the warrant + affidavit. California-only.',
      when: 'Use when the affidavit itself contains sensitive investigative detail (informants, techniques, ongoing surveillance) that should not be public.',
      effect: 'Asks the magistrate to seal the warrant, affidavit, and returns from public inspection. Distinct from NDO — NDO binds the provider; sealing binds the court file.'
    },
  ];
  const clauseRows = clauses.map(c => `
    <div class="p-3 bg-slate-800/40 border border-slate-700 rounded">
      <div class="text-viper-cyan font-semibold text-[13px] mb-1">${esc(c.name)}</div>
      <div class="text-[11px] text-slate-200 mb-1"><span class="text-slate-400">What:</span> ${esc(c.what)}</div>
      <div class="text-[11px] text-slate-200 mb-1"><span class="text-slate-400">When to use:</span> ${esc(c.when)}</div>
      <div class="text-[11px] text-slate-200"><span class="text-slate-400">Effect:</span> ${esc(c.effect)}</div>
    </div>
  `).join('');

  ov.innerHTML = `
    <div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm"
         onclick="event.target===this && WarrantAuthorUI.bus.onCloseAddendumHelp()">
      <div class="w-full max-w-4xl max-h-[90vh] bg-viper-dark border border-viper-cyan/30 rounded-xl shadow-2xl flex flex-col">
        <div class="flex items-center justify-between p-4 border-b border-slate-700">
          <h3 class="text-lg font-bold text-white flex items-center gap-2">
            <span class="text-viper-cyan">?</span>
            Addendum Help — Patterns &amp; Optional Clauses
          </h3>
          <button onclick="WarrantAuthorUI.bus.onCloseAddendumHelp()"
                  class="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>
        <div class="flex-1 overflow-y-auto p-4 space-y-5">

          <div>
            <h4 class="text-sm font-semibold text-white mb-2">Apply pattern&hellip;</h4>
            <p class="text-[12px] text-slate-300 mb-3 leading-relaxed">
              A <span class="text-viper-cyan">pattern</span> is a pre-set bundle of "Items to Produce" tailored to a category of provider.
              Pick a pattern that matches your provider and the checkboxes below populate automatically.
              You can still tick or untick anything manually after applying.
              <span class="text-slate-400">Selecting the provider at the top of the addendum already applies its default pattern — only use this dropdown to override or to start over.</span>
            </p>
            <div class="overflow-x-auto">
              <table class="w-full text-left">
                <thead class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700">
                  <tr>
                    <th class="py-1.5 pr-3 font-medium">Key</th>
                    <th class="py-1.5 pr-3 font-medium">Pattern</th>
                    <th class="py-1.5 pr-3 font-medium">Typical Providers</th>
                    <th class="py-1.5 font-medium">What it includes</th>
                  </tr>
                </thead>
                <tbody>${patternRows}</tbody>
              </table>
            </div>
          </div>

          <div class="border-t border-slate-800 pt-4">
            <h4 class="text-sm font-semibold text-white mb-2">Optional Clauses</h4>
            <p class="text-[12px] text-slate-300 mb-3 leading-relaxed">
              These are independent toggles that add specific legal-authority paragraphs to the addendum. They can be combined.
              The first two control disclosure to the subscriber by the <em>provider</em>; the last two are California-specific (CalECPA) and control your own notice duty and the court file.
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              ${clauseRows}
            </div>
            <div class="mt-3 text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              ⚠ Legal selection is your call. This guide is operational, not legal advice — confirm with your DA / prosecutor before serving.
            </div>
          </div>

        </div>
        <div class="flex items-center justify-end gap-2 p-3 border-t border-slate-700">
          <button onclick="WarrantAuthorUI.bus.onCloseAddendumHelp()"
                  class="px-3 py-1.5 bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 text-viper-cyan rounded text-sm font-medium">
            Got it
          </button>
        </div>
      </div>
    </div>
  `;
  ov.classList.remove('hidden');
}

/**
 * Mount the generate-result modal into #waModalOverlay.
 * Shows PDF + DOCX status, page count, dangling-slot issues, and
 * Open / Download actions.
 */
function _showGenerateResultModal(caseId, draft, blockStream, issues, pdfResult, saveResult) {
  const ov = document.getElementById('waModalOverlay');
  if (!ov) return;

  const issuesHtml = (issues && issues.length) ? `
    <div class="mb-3 p-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-200">
      <div class="font-semibold mb-1">⚠ ${issues.length} addendum${issues.length===1?'':'s'} with dangling slots — review before serving</div>
      <ul class="list-disc pl-5 space-y-0.5">
        ${issues.map(i => `<li>${esc(i)}</li>`).join('')}
      </ul>
    </div>` : `
    <div class="mb-3 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs text-emerald-200">
      ✓ All template slots resolved across every addendum.
    </div>`;

  const pcBanner = (blockStream && blockStream.stats && !blockStream.stats.pcAuthored) ? `
    <div class="mb-3 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200">
      ⚠ Probable Cause narrative is empty — the document includes a placeholder where it should appear.
    </div>` : '';

  // Disk-save status block — only when running in Electron
  let saveStatusHtml = '';
  if (saveResult === null) {
    saveStatusHtml = `
      <div class="mb-3 p-2 bg-slate-700/30 border border-slate-600 rounded text-xs text-slate-300">
        Running outside Electron — disk persistence skipped. Use Download to save the PDF locally.
      </div>`;
  } else if (saveResult && saveResult.success && saveResult.diskSkipped) {
    // DOCX + PDF were composed in memory but never written to disk because
    // window.currentCase.caseNumber wasn't available at generate time.
    saveStatusHtml = `
      <div class="mb-3 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200">
        <div class="font-semibold mb-0.5">⚠ Generated in memory only — not saved to case folder</div>
        <div class="text-amber-100/80">${esc(saveResult.diskSkippedReason || 'No case number available.')}</div>
        <div class="mt-1 text-amber-100/70">Use the Download buttons below to save the .pdf and .docx manually.</div>
      </div>`;
  } else if (saveResult && saveResult.success) {
    const pdfKB  = saveResult.sizes && saveResult.sizes.pdf  ? ` (${Math.round(saveResult.sizes.pdf / 1024)} KB)` : '';
    const docxKB = saveResult.sizes && saveResult.sizes.docx ? ` (${Math.round(saveResult.sizes.docx / 1024)} KB)` : '';
    saveStatusHtml = `
      <div class="mb-3 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs text-emerald-200">
        <div class="font-semibold mb-0.5">✓ Saved to case folder</div>
        <ul class="ml-1 space-y-0.5">
          ${saveResult.pdfPath  ? `<li>📄 <span class="font-mono text-emerald-100">warrant.pdf</span>${pdfKB}</li>`  : ''}
          ${saveResult.docxPath ? `<li>📝 <span class="font-mono text-emerald-100">warrant.docx</span>${docxKB}</li>` : ''}
        </ul>
      </div>`;
  } else if (saveResult) {
    saveStatusHtml = `
      <div class="mb-3 p-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-200">
        ✗ Disk persistence failed: ${esc(saveResult.error || 'unknown error')}
      </div>`;
  }

  const stats = (blockStream && blockStream.stats) || {};
  const totalBlocks = stats.totalBlocks || 0;
  const addendums   = stats.addendums   || 0;

  const hasElectron = !!(window.electronAPI && saveResult && saveResult.success);

  ov.innerHTML = `
    <div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div class="w-full max-w-2xl max-h-[90vh] bg-viper-dark border border-viper-cyan/30 rounded-xl shadow-2xl flex flex-col">
        <div class="flex items-center justify-between p-4 border-b border-slate-700">
          <h3 class="text-lg font-bold text-white">📄 Warrant Generated</h3>
          <button onclick="WarrantAuthorUI.bus.onCloseGenerateModal()" class="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>
        <div class="flex-1 overflow-y-auto p-4 text-sm text-slate-200">
          <div class="grid grid-cols-3 gap-3 mb-4 text-center">
            <div class="bg-slate-800/60 border border-slate-700 rounded p-2">
              <div class="text-[10px] uppercase tracking-wider text-slate-400">Pages</div>
              <div class="text-2xl font-bold text-viper-cyan">${pdfResult.pageCount}</div>
            </div>
            <div class="bg-slate-800/60 border border-slate-700 rounded p-2">
              <div class="text-[10px] uppercase tracking-wider text-slate-400">Addendums</div>
              <div class="text-2xl font-bold text-viper-cyan">${addendums}</div>
            </div>
            <div class="bg-slate-800/60 border border-slate-700 rounded p-2">
              <div class="text-[10px] uppercase tracking-wider text-slate-400">Blocks</div>
              <div class="text-2xl font-bold text-viper-cyan">${totalBlocks}</div>
            </div>
          </div>

          ${saveStatusHtml}
          ${pcBanner}
          ${issuesHtml}

          <div class="text-[11px] text-slate-500 mt-2">
            Case Ref: <span class="text-slate-300 font-mono">${esc(draft.caseRef || '(none)')}</span> ·
            Template: <span class="text-slate-300 font-mono">${esc(
              draft.template === 'ca-multi-business-esp'  ? 'CA · CalECPA' :
              draft.template === 'va-multi-business-esp'  ? 'VA · DC-338/DC-339' :
              draft.template === 'co-multi-business-esp'  ? 'CO · §16-3-301' :
              draft.template === 'pa-multi-business-esp'  ? 'PA · AOPC 410A' :
              (String(draft.jurisdiction || '').toUpperCase() === 'PA') ? 'PA · AOPC 410A' :
              draft.template === 'ca-residential-sw'      ? 'CA · Residential SW' :
              draft.template === 'ca-residential'         ? 'CA · Residential SW' :
              'US · SCA §2703'
            )}</span>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 p-3 border-t border-slate-700 text-xs">
          <button onclick="WarrantAuthorUI.bus.onPreviewGeneratedPdf()"
                  class="px-3 py-1.5 bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 text-viper-cyan rounded text-sm font-medium"
                  title="Open the generated PDF in a new tab">
            👁 Preview PDF
          </button>
          <button onclick="WarrantAuthorUI.bus.onDownloadGeneratedPdf()"
                  class="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 rounded text-sm font-medium">
            ⬇ Download PDF
          </button>
          ${_state._genDocxBlob ? `
          <button onclick="WarrantAuthorUI.bus.onDownloadGeneratedDocx()"
                  class="px-3 py-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/40 text-blue-300 rounded text-sm font-medium"
                  title="Download the .docx (works even when disk persistence is unavailable)">
            ⬇ Download DOCX
          </button>` : ''}
          ${hasElectron && saveResult.docxPath ? `
          <button onclick="WarrantAuthorUI.bus.onOpenGeneratedOnDisk('${attr(caseId)}','${attr(draft.id)}','docx')"
                  class="px-3 py-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/40 text-blue-300 rounded text-sm font-medium"
                  title="Open the saved .docx in Word">
            📝 Open DOCX
          </button>` : ''}
          ${hasElectron ? `
          <button onclick="WarrantAuthorUI.bus.onOpenGeneratedFolder('${attr(caseId)}','${attr(draft.id)}')"
                  class="px-3 py-1.5 bg-slate-700/40 hover:bg-slate-700/60 border border-slate-600 text-slate-200 rounded text-sm font-medium">
            📂 Open Folder
          </button>` : ''}
          <button onclick="WarrantAuthorUI.bus.onCloseGenerateModal()"
                  class="px-3 py-1.5 text-slate-300 hover:text-white text-sm">Close</button>
        </div>
      </div>
    </div>
  `;
  // The overlay may have had `hidden` added by the validator confirm/block
  // modal's resolve handler — strip it so the result modal is actually
  // visible. Without this, hitting "Generate anyway" appears to do nothing
  // and the Download / Preview / Open buttons are unreachable.
  ov.classList.remove('hidden');
}

/**
 * Map a template slot key (e.g. "addendum.targets") to user-facing guidance.
 * Returned shape: { label, what, where } — all plain strings.
 * Unknown slots fall through to a generic explanation so the panel still
 * helps the user track them down via the slot key.
 */
function _slotGuidance(key) {
  const K = String(key || '').toLowerCase();
  const M = {
    'addendum.pagelabel':              { label: 'Page label',           what: 'Auto-assigned (A, B, C…) — should never be blank.',                 where: 'Internal — report this as a bug if it persists.' },
    'addendum.targets':                { label: 'Target accounts',      what: 'At least one account/identifier the warrant compels production for.', where: 'This addendum → Target Accounts. Use + Add Target or pull from the auto-fill chips.' },
    'addendum.targetaccounts':         { label: 'Target accounts',      what: 'At least one account/identifier the warrant compels production for.', where: 'This addendum → Target Accounts. Use + Add Target or pull from the auto-fill chips.' },
    'addendum.daterange':              { label: 'Date range (From / To)', what: 'Both From and To dates so the provider knows what window to produce.', where: 'This addendum → From / To. Years must be 4 digits.' },
    'addendum.daterangefrom':          { label: 'Date range — From',    what: 'Earliest date the provider must produce records for.',               where: 'This addendum → From.' },
    'addendum.daterangeto':            { label: 'Date range — To',      what: 'Latest date the provider must produce records for.',                 where: 'This addendum → To.' },
    'addendum.providerkey':            { label: 'Provider',             what: 'Which business this addendum compels production from.',              where: 'This addendum → Provider dropdown at the top of the form.' },
    'addendum.businessname':           { label: 'Provider legal entity',what: 'Full legal entity name of the provider.',                            where: 'This addendum → Provider dropdown auto-populates this. If blank, the provider directory entry is missing a legalEntity.' },
    'addendum.ndoextendedjustification': { label: 'Extended NDO justification', what: 'Free-text justification when you check the NDO clause.',     where: 'This addendum → Optional Clauses → Non-Disclosure Order. Field appears when toggled on.' },

    'provider.legalentity':            { label: 'Provider legal entity',what: 'Full legal entity name of the provider (e.g. "Snap Inc.").',         where: 'Provider Directory. Check Settings → Warrant Author → Providers if blank.' },
    'provider.servicelocation':        { label: 'Provider service address', what: 'Mailing / service address for the provider.',                    where: 'Provider Directory entry for this provider.' },
    'provider.warrantsemail':          { label: 'Provider warrants email', what: 'Address where warrant returns are sent.',                         where: 'Provider Directory entry for this provider.' },

    'agency.name':                     { label: 'Agency name',          what: 'Full name of your agency (e.g. "Rancho Cucamonga PD").',             where: 'Settings → Warrant Author → Agency Profile.' },
    'agency.address':                  { label: 'Agency address',       what: 'Mailing address of your agency.',                                    where: 'Settings → Warrant Author → Agency Profile.' },
    'agency.state':                    { label: 'Agency state',         what: 'Two-letter state code — determines which template defaults to CA vs US.', where: 'Settings → Warrant Author → Agency Profile.' },
    'agency.affiantname':              { label: 'Affiant name',         what: 'Officer / detective signing the affidavit.',                         where: 'Settings → Warrant Author → Agency Profile → Affiant.' },
    'agency.affianttitle':             { label: 'Affiant title',        what: 'Rank / title (Detective, Officer, etc.).',                           where: 'Settings → Warrant Author → Agency Profile → Affiant.' },
    'agency.affiantbadge':             { label: 'Affiant badge #',      what: 'Badge or serial number for the affiant.',                            where: 'Settings → Warrant Author → Agency Profile → Affiant.' },
    'agency.affiantcontact':           { label: 'Affiant contact',      what: 'Phone / email for service of returns.',                              where: 'Settings → Warrant Author → Agency Profile → Affiant.' },

    'draft.courtname':                 { label: 'Court name',           what: 'Court hearing the application.',                                     where: 'Editor header → Court Name.' },
    'draft.probablecausenarrative':    { label: 'Probable cause narrative', what: 'Facts establishing probable cause.',                            where: 'Editor header → Probable Cause Narrative (shared across all warrants in this case).' },
    'draft.swnumber':                  { label: 'SW number',            what: 'Court-assigned warrant number.',                                     where: 'Captured later when the draft is marked served.' },
    'draft.judgename':                 { label: 'Judge',                what: 'Signing judge.',                                                     where: 'Captured later at submission.' },

    'items.taxonomy':                  { label: 'Items-to-seize list',  what: 'At least one item must be selected for production.',                 where: 'This addendum → Items to Seize → check items or apply a Pattern.' },
    'items.list':                      { label: 'Items-to-seize list',  what: 'At least one item must be selected for production.',                 where: 'This addendum → Items to Seize → check items or apply a Pattern.' },
  };
  if (M[K]) return M[K];
  // Fallbacks by prefix
  if (K.startsWith('addendum.'))  return { label: key, what: 'Addendum-level value referenced by the template.', where: 'This addendum form.' };
  if (K.startsWith('provider.'))  return { label: key, what: 'Provider-level value referenced by the template.', where: 'Provider Directory.' };
  if (K.startsWith('agency.'))    return { label: key, what: 'Agency-level value referenced by the template.',   where: 'Settings → Warrant Author → Agency Profile.' };
  if (K.startsWith('draft.'))     return { label: key, what: 'Draft-level value referenced by the template.',    where: 'Editor header.' };
  if (K.startsWith('items.'))     return { label: key, what: 'Items-taxonomy value referenced by the template.', where: 'This addendum → Items to Seize.' };
  return { label: key, what: 'Slot referenced by the template but not present in context.', where: 'Check the template definition.' };
}

function _renderIssuesPanel(dangling, missingItems) {
  // Coerce to arrays defensively — engine may return non-array shapes.
  dangling = Array.isArray(dangling) ? dangling : (dangling ? [String(dangling)] : []);
  missingItems = Array.isArray(missingItems) ? missingItems
    : (missingItems ? ['(see Items to Seize)'] : []);

  const danglingRows = dangling.map(k => {
    const g = _slotGuidance(k);
    return `
      <li class="wa-issue-row">
        <div class="wa-issue-row-head">
          <span class="wa-issue-key">${esc(k)}</span>
          <span class="wa-issue-label">${esc(g.label)}</span>
        </div>
        <div class="wa-issue-what">${esc(g.what)}</div>
        <div class="wa-issue-where"><span class="wa-issue-where-label">Fix in:</span> ${esc(g.where)}</div>
      </li>`;
  }).join('');

  const missingRows = missingItems.map(k => `
    <li class="wa-issue-row">
      <div class="wa-issue-row-head">
        <span class="wa-issue-key">${esc(k)}</span>
        <span class="wa-issue-label">Unknown item key</span>
      </div>
      <div class="wa-issue-what">The pattern referenced an item that isn't in the taxonomy.</div>
      <div class="wa-issue-where"><span class="wa-issue-where-label">Fix in:</span> Either pick a different Pattern, or add this item key to the taxonomy in modules/warrant-author/items-taxonomy.js.</div>
    </li>`).join('');

  const summary = [
    dangling.length ? `${dangling.length} dangling slot${dangling.length===1?'':'s'}` : '',
    missingItems.length ? `${missingItems.length} unknown item${missingItems.length===1?'':'s'}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <details class="wa-pv-issues" open>
      <summary class="wa-pv-issues-summary">
        <span class="wa-pv-issues-icon">⚠</span>
        <span class="wa-pv-issues-text">${esc(summary)}</span>
        <span class="wa-pv-issues-hint">click for details</span>
      </summary>
      <ul class="wa-issue-list">
        ${danglingRows}
        ${missingRows}
      </ul>
    </details>
  `;
}

// ─── Outstanding / Returned subtabs ─────────────────────────────────────

function _renderOutstanding(caseId) {
  const ds = _store();
  const list = ds ? ds.listOutstandingAddendums(caseId) : [];
  if (!list.length) {
    return `<div class="wa-empty">
      <div class="wa-empty-title">No outstanding addendums</div>
      <div class="wa-empty-body">Addendums show here after a draft is served but no return has been linked. Mark a draft as served from the editor (P10).</div>
    </div>`;
  }
  return `
    <div class="space-y-2">
      ${list.map(({ draft, addendum }) => `
        <div class="wa-row">
          <div class="flex-1 min-w-0 cursor-pointer" onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(draft.id)}')">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-viper-cyan font-mono text-xs">Page ${esc(addendum.pageLabel)}</span>
              <span class="text-white">${esc(addendum.providerKey)}</span>
              <span class="text-slate-500">·</span>
              <span class="text-slate-400 text-xs">${esc(draft.swNumber || draft.caseRef || 'Untitled draft')}</span>
            </div>
            <div class="text-xs text-slate-400">
              Served ${esc(_shortDate(addendum.servedAt))} · ${(addendum.targetAccounts || []).length} target(s)
            </div>
          </div>
          <button onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(draft.id)}')"
                  class="px-2 py-1 text-xs bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 text-viper-cyan rounded">Open</button>
        </div>
      `).join('')}
    </div>
  `;
}

function _renderReturned(caseId) {
  const ds = _store();
  const list = ds ? ds.listReturnedAddendums(caseId) : [];
  if (!list.length) {
    return `<div class="wa-empty">
      <div class="wa-empty-title">No returns yet</div>
      <div class="wa-empty-body">Returned data appears once auto-linkage matches a parsed warrant return to an addendum (P11). For now, view returns under each per-provider warrant tab.</div>
    </div>`;
  }
  return `
    <div class="space-y-2">
      ${list.map(({ draft, addendum }) => `
        <div class="wa-row">
          <div class="flex-1 min-w-0 cursor-pointer" onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(draft.id)}')">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-emerald-400 font-mono text-xs">Page ${esc(addendum.pageLabel)}</span>
              <span class="text-white">${esc(addendum.providerKey)}</span>
              <span class="text-slate-500">·</span>
              <span class="text-slate-400 text-xs">${esc(draft.swNumber || draft.caseRef || 'Untitled draft')}</span>
            </div>
            <div class="text-xs text-slate-400">
              Returned ${esc(_shortDate(addendum.returnedAt))} · ${(addendum.linkedReturnIds || []).length} linked import(s)
            </div>
          </div>
          <button onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(draft.id)}')"
                  class="px-2 py-1 text-xs bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 rounded">Open</button>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── subtab dispatcher ──────────────────────────────────────────────────

function renderSubtab(caseId, subtab) {
  _state.caseId = caseId;
  _state.subtab = subtab || 'drafts';
  if (_state.view === 'editor' && _state.subtab === 'drafts' && _state.activeDraftId) {
    return _renderEditor(caseId, _state.activeDraftId);
  }
  if (_state.subtab === 'outstanding') return _renderOutstanding(caseId);
  if (_state.subtab === 'returned')    return _renderReturned(caseId);
  return _renderDraftsList(caseId);
}

/**
 * Render the case-level Probable Cause card that lives at the top of the
 * Warrant Author screen (above the subtab pills). Always visible regardless
 * of which subtab is active. Reads/writes case-pc-store; mirrors body into
 * every draft on this case so the validator + template engine see it.
 */
function renderCasePc(caseId) {
  if (!caseId) return '';
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  if (!pcStore) return '';
  // One-time migration: if any existing draft already has PC, lift it.
  try {
    const ds = _store();
    const allDrafts = ds ? ds.listDrafts(caseId) : [];
    pcStore.promoteFromDrafts(caseId, allDrafts);
  } catch (_e) {}
  const body  = pcStore.getBody(caseId);
  const stats = pcStore.stats(caseId);
  const updated = stats.updatedAt ? _shortDate(stats.updatedAt) : '—';
  const offenseDesc = pcStore.getOffenseDescription(caseId);
  const offenseDate = pcStore.getOffenseDate(caseId);
  // Pull the user's offense reference library so they can pick from it
  // instead of typing the description by hand. Stored by the offense
  // reference page (index.html) under localStorage['viperOffenseReference'].
  let offenseRefs = [];
  try {
    const rawRefs = localStorage.getItem('viperOffenseReference');
    if (rawRefs) {
      const parsed = JSON.parse(rawRefs);
      if (Array.isArray(parsed)) offenseRefs = parsed;
    }
  } catch (_e) { /* non-fatal */ }
  // Build the "pick from reference" options. Use the description as the
  // display label (with the statute code prefixed so users see e.g.
  // "§18-8-208 — Escape"). The value is what gets injected into the
  // description input verbatim.
  const offenseRefOpts = offenseRefs
    .filter(o => o && o.description)
    .map(o => {
      const label = o.code ? `${o.code} — ${o.description}` : o.description;
      return `<option value="${attr(label)}">${esc(label)}</option>`;
    }).join('');
  const collapsedAttr = body && body.trim().length > 0 ? '' : 'open';
  return `
    <details class="wa-case-pc" ${collapsedAttr}>
      <summary>
        <span class="wa-case-pc-title">
          <span class="wa-case-pc-chevron">▶</span>
          <span>⚖ Case Probable Cause</span>
          ${body && body.trim().length > 0
            ? '<span class="pill-filled text-[11px] font-mono">✓ authored</span>'
            : '<span class="pill-empty text-[11px] font-mono">empty</span>'}
        </span>
        <span class="wa-case-pc-stats">
          <span><span class="text-viper-cyan">${stats.words}</span> words</span>
          <span><span class="text-viper-cyan">${stats.chars}</span> chars</span>
          <span>updated ${esc(updated)}</span>
        </span>
      </summary>
      <div class="wa-case-pc-body">
        <div class="wa-case-pc-banner">
          <strong>Shared across all warrants in this case</strong> — author here, then build onto it as the investigation progresses
          (initial ESP/IP warrants → search-history → residence). Validator (P7) will flag empty PC as a hard error at submission.
        </div>
        <!-- Case-level offense fields (offense description + date).
             Used by CO templates' "*These records will be searched for
             evidence pertaining the {{case.offenseDescription}} that
             occurred on {{case.offenseDate}}" line. Stored at the case
             level so a single edit propagates to every draft in the case. -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <label class="block text-xs">
            <span class="text-slate-400 uppercase tracking-wider">Offense Description</span>
            <div class="mt-1 flex items-center gap-2">
              <input type="text"
                     id="waCaseOffenseDesc"
                     value="${attr(offenseDesc)}"
                     placeholder="e.g. Aggravated Robbery, Sexual Assault on a Child…"
                     oninput="WarrantAuthorUI.bus.onCaseOffenseDescChange('${attr(caseId)}', this.value)"
                     onblur="WarrantAuthorUI.bus.onCaseOffenseDescBlur('${attr(caseId)}')"
                     class="flex-1 px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
              ${offenseRefOpts ? `
                <select onchange="WarrantAuthorUI.bus.onCaseOffensePickFromRef('${attr(caseId)}', this.value); this.value='';"
                        class="px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-slate-300 text-xs"
                        title="Pick from your Offense Reference library">
                  <option value="">📚 From reference…</option>
                  ${offenseRefOpts}
                </select>
              ` : `
                <span class="text-[10px] text-slate-500 italic" title="Build your Offense Reference library to enable picking from a list">📚 (empty)</span>
              `}
            </div>
            <span class="block text-[10px] text-slate-500 mt-1">
              Manual entry or pick from your Offense Reference library. Used by CO templates; harmless on others.
            </span>
          </label>
          <label class="block text-xs">
            <span class="text-slate-400 uppercase tracking-wider">Offense Date</span>
            <input type="date"
                   id="waCaseOffenseDate"
                   value="${attr(offenseDate)}"
                   onchange="WarrantAuthorUI.bus.onCaseOffenseDateChange('${attr(caseId)}', this.value)"
                   class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
            <span class="block text-[10px] text-slate-500 mt-1">
              The date the offense occurred. Auto-populates every CO warrant in this case.
            </span>
          </label>
        </div>
        <textarea id="waCasePcTextarea"
                  oninput="WarrantAuthorUI.bus.onCasePcChange('${attr(caseId)}', this.value)"
                  class="w-full px-3 py-2 bg-viper-dark border border-slate-700 rounded text-white text-sm font-mono leading-relaxed wa-pc-textarea"
                  placeholder="Probable cause narrative for this case. Author here, then re-use across every warrant draft below.">${esc(body)}</textarea>
        <div class="wa-case-pc-footer">
          <span>
            <span id="waPcWordCount" class="text-viper-cyan">${stats.words}</span> words ·
            <span id="waPcCharCount" class="text-viper-cyan">${stats.chars}</span> chars ·
            <span id="waPcRevCount" class="text-viper-cyan">${stats.revisionCount}</span> revision${stats.revisionCount === 1 ? '' : 's'}
          </span>
          <span>Last updated <span id="waPcUpdated">${esc(updated)}</span></span>
        </div>
      </div>
    </details>
  `;
}

// ─── small utilities ────────────────────────────────────────────────────

function _shortDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString();
  } catch (_) { return '—'; }
}

/**
 * Normalize an <input type="date"> value (YYYY-MM-DD).
 * Chromium accepts whatever year segment the user types — so "01/24/25"
 * stores as `0025-01-24`. Expand:
 *   - 2-digit years  → 2000+yy   (25  → 2025)
 *   - 3-digit years  → 2000 + (y mod 100) (020 → 2020)
 *   - clamp to [1900, 2100]
 *   - leave plausible 4-digit years alone
 * Returns the original string if it doesn't look like a date.
 */
function _normalizeDateValue(v) {
  if (!v || typeof v !== 'string') return v;
  const m = v.match(/^(\d{1,4})-(\d{2})-(\d{2})$/);
  if (!m) return v;
  let y = parseInt(m[1], 10);
  if (isNaN(y)) return v;
  if (y < 100) y = 2000 + y;
  else if (y < 1000) y = 2000 + (y % 100);
  if (y < 1900) y = 1900;
  if (y > 2100) y = 2100;
  return `${String(y).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

/**
 * Convert ISO date "YYYY-MM-DD" → display "MM/DD/YYYY". Used to seed the
 * text inputs with persisted values without confusing the user.
 */
function _isoToUsDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso; // unknown shape — return as-is (lets user keep editing)
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * Convert user-typed "MM/DD/YYYY" → ISO "YYYY-MM-DD". Returns '' if the
 * input is empty; returns the original string if it doesn't parse (lets
 * the validator surface the issue rather than silently dropping data).
 * Accepts single-digit M / D and 2- or 4-digit years.
 */
function _usDateToIso(s) {
  if (s == null) return '';
  const trimmed = String(s).trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return trimmed; // keep raw so user sees their typo + validator flags
  let mo = parseInt(m[1], 10), d = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (y < 100) y = 2000 + y;
  if (y < 1900) y = 1900;
  if (y > 2100) y = 2100;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return trimmed;
  return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function _safeLS(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return /Overrides$/.test(key) ? {} : [];
    const parsed = JSON.parse(raw);
    if (parsed == null) return /Overrides$/.test(key) ? {} : [];
    return parsed;
  } catch (_) { return /Overrides$/.test(key) ? {} : []; }
}

// ─── event bus (called from inline onclick handlers) ────────────────────

function _rerender() {
  if (typeof window.waSwitchSubtab === 'function') {
    // re-emit current subtab to force re-render
    window.waSwitchSubtab(_state.subtab);
  } else {
    const root = document.getElementById('waSubtabContent');
    if (root) root.innerHTML = renderSubtab(_state.caseId, _state.subtab);
  }
}

const bus = {
  onClickNewDraft(caseId) {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = _renderNewDraftModal(caseId); ov.classList.remove('hidden'); }
  },
  onCloseNewDraftModal() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = ''; ov.classList.add('hidden'); }
  },
  /**
   * Handle Warrant Type dropdown changes in the New Draft modal: swap the
   * Template option to the one ESP template that matches the jurisdiction
   * configured in Settings → Warrant Authoring. The Template select stays
   * disabled (locked) — users change state formatting via Settings, never
   * from inside the module. Residential remains CA-only in v1.
   */
  onNewDraftTypeChange(type) {
    const tplSel = document.getElementById('waNewTemplate');
    const crimeWrap = document.getElementById('waNewCrimeWrap');
    if (!tplSel) return;
    if (type === 'residential') {
      // Residential is CA-only — Phase 1 of VA/CO only added ESP. Surface a
      // hint so non-CA users understand why they're being pushed to CA.
      tplSel.innerHTML = '<option value="ca-residential" selected>CA — Residential Search Warrant (combined SW + Affidavit + SOPC)</option>';
      tplSel.disabled = true;
      if (crimeWrap) crimeWrap.classList.remove('hidden');
    } else {
      const state = _readWarrantAuthorState();
      const espTpl = _espTemplateForState(state);
      tplSel.innerHTML = `<option value="${attr(espTpl.id)}" selected>${esc(espTpl.label)}</option>`;
      tplSel.disabled = true;
      if (crimeWrap) crimeWrap.classList.add('hidden');
    }
  },
  onCreateDraftConfirm(caseId) {
    const ds = _store(); if (!ds) return;
    let ref = (document.getElementById('waNewCaseRef') || {}).value || '';
    // Fall back to the running case number if the user cleared the input.
    if (!String(ref).trim()) {
      ref = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    }
    const type = (document.getElementById('waNewType') || {}).value || 'multi-business-esp';
    const tpl = (document.getElementById('waNewTemplate') || {}).value
              || (type === 'residential' ? 'ca-residential' : 'ca-multi-business-esp');
    const crimeId = (document.getElementById('waNewCrime') || {}).value || '';
    const agency = _loadAgencyProfile();
    const draft = ds.createDraft(caseId, {
      swNumber: '', caseRef: ref, template: tpl,
      type,
      jurisdiction: tpl.startsWith('ca-') ? 'CA'
                  : tpl.startsWith('va-') ? 'VA'
                  : tpl.startsWith('co-') ? 'CO'
                  : tpl.startsWith('pa-') ? 'PA'
                  : 'US',
      agencyProfile: agency,
      crimeType: type === 'residential' ? crimeId : ''
    });
    // Residential + crime preset selected → overlay the preset onto the
    // empty shell that newDraft() created. Done here (not in the factory)
    // so the factory stays preset-agnostic and easy to unit-test.
    if (draft && type === 'residential' && crimeId
        && window.WarrantAuthorCrimePresets
        && typeof window.WarrantAuthorCrimePresets.buildResidentialFromPreset === 'function') {
      try {
        const filled = window.WarrantAuthorCrimePresets.buildResidentialFromPreset(crimeId);
        // Preserve premises/suspects/executedAt city if newDraft already set them.
        if (filled) {
          if (draft.residential && draft.residential.executedAt && draft.residential.executedAt.city) {
            filled.executedAt = Object.assign({}, filled.executedAt, { city: draft.residential.executedAt.city });
          }
          draft.residential = filled;
        }
        // Overlay default PC §1524 grounds from the preset.
        if (typeof window.WarrantAuthorCrimePresets.pc1524GroundsFor === 'function') {
          draft.pc1524Grounds = window.WarrantAuthorCrimePresets.pc1524GroundsFor(crimeId);
        }
        ds.saveDraft(caseId, draft, { silent: true });
      } catch (e) {
        console.error('[WarrantAuthor] residential preset overlay failed:', e);
      }
    }
    bus.onCloseNewDraftModal();
    _selectDraft(caseId, draft.id);
    _rerender();
  },
  onOpenDraft(caseId, draftId) { _selectDraft(caseId, draftId); _state.subtab = 'drafts'; _rerender(); },
  onBackToList(caseId)         { _backToList(); _state.caseId = caseId; _state.subtab = 'drafts'; _rerender(); },
  onDeleteDraft(caseId, draftId) {
    if (!confirm('Delete this draft? This cannot be undone.')) return;
    const ds = _store(); if (!ds) return;
    ds.deleteDraft(caseId, draftId);
    if (_state.activeDraftId === draftId) _backToList();
    _rerender();
  },
  onDraftFieldChange(caseId, draftId, field, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    d[field] = value;
    // Keep jurisdiction in sync when the user swaps templates from the
    // draft header dropdown. Otherwise the optional-clause labels on
    // existing addendums won't refresh (they read draft.jurisdiction).
    if (field === 'template') {
      const v = String(value || '');
      if (v.startsWith('ca-'))      d.jurisdiction = 'CA';
      else if (v.startsWith('va-')) d.jurisdiction = 'VA';
      else if (v.startsWith('co-')) d.jurisdiction = 'CO';
      else if (v.startsWith('pa-')) d.jurisdiction = 'PA';
      else                          d.jurisdiction = 'US';
    }
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  /**
   * Toggle a draft field that takes 'requested' / 'not-requested' values
   * (hobbsSealing, nightSearch). Called from CA face-page options.
   */
  onDraftToggleChange(caseId, draftId, field, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    d[field] = value;
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  /**
   * Toggle one PC §1524 ground checkbox. Initializes the grounds object
   * if missing (legacy drafts created before the schema was finalized).
   */
  onPc1524GroundChange(caseId, draftId, key, checked) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.pc1524Grounds || typeof d.pc1524Grounds !== 'object') {
      d.pc1524Grounds = {
        stolen: false, felonyMeans: false, possessedWithIntent: false,
        evidenceOfFelony: false, sexualExploitation: false,
        arrestWarrant: false, ecspMisdemeanor: false, laborCode: false,
      };
    }
    d.pc1524Grounds[key] = !!checked;
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },

  /**
   * Set a single residential field by dot-path.
   *   path = 'residential.premises.address'
   *   path = 'residential.suspects.0.name'
   *   path = 'residential.optionalClauses.nightService.enabled'
   * Coerces boolean values for checkbox use. Rerenders after save.
   */
  onResidentialFieldSet(caseId, draftId, path, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },

  /**
   * Silent setter for long textareas (premises legal, items body,
   * SOPC body, T&E inline, justification text). Persists without
   * triggering re-render so the caret never jumps mid-typing.
   *
   * Also passes {silent: true} to saveDraft so the draft-store does
   * NOT dispatch the `warrant-author-change` window event — that
   * event is wired to wipe and re-render the entire warrant subtab
   * (case-detail-with-analytics.html), which would steal focus from
   * the textarea on every keystroke.
   */
  onResidentialTextInput(caseId, draftId, path, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    // intentionally no _rerender()
  },

  /**
   * Append a blank row to a residential list (offenses, suspects,
   * items.blocks, sopc.sections). Rerenders.
   */
  onResidentialListAdd(caseId, draftId, listPath) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const arr = _getByPath(d, listPath);
    if (!Array.isArray(arr)) return;
    arr.push(_blankRowFor(listPath));
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onResidentialListRemove(caseId, draftId, listPath, idx) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const arr = _getByPath(d, listPath);
    if (!Array.isArray(arr)) return;
    if (idx < 0 || idx >= arr.length) return;
    arr.splice(idx, 1);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },

  /**
   * Change the active crime preset (without overwriting current edits).
   * Only updates draft.residential.crimeType / crimePresetId. To
   * actually overlay items/T&E/SOPC, the user must click Re-seed.
   */
  onResidentialPresetChange(caseId, draftId, presetId) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d || !d.residential) return;
    d.residential.crimeType = presetId || '';
    d.residential.crimePresetId = presetId || '';
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },

  /**
   * Overlay the current crime preset onto the residential substructure.
   * WARNING: replaces offenses, items-to-seize, T&E inline body, SOPC
   * sections, optional-clause defaults, and PC §1524 grounds.
   * Premises / suspects / SW number / executedAt are preserved.
   */
  onResidentialReseed(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d || !d.residential) return;
    const presetId = d.residential.crimePresetId || d.residential.crimeType;
    if (!presetId) {
      if (typeof window.showToast === 'function') window.showToast('Pick a crime preset first', 'warn');
      return;
    }
    if (!window.WarrantAuthorCrimePresets || !window.WarrantAuthorCrimePresets.buildResidentialFromPreset) return;
    if (!confirm('Re-seed offenses, PC §1524 grounds, items to seize, training & experience, optional-clause defaults, and SOPC scaffold from the "' + presetId + '" preset?\n\nPremises, suspects, SW number, and executed-at are preserved.')) return;
    const filled = window.WarrantAuthorCrimePresets.buildResidentialFromPreset(presetId);
    if (!filled) return;
    // Preserve user-entered fields.
    const preserve = {
      premises: d.residential.premises,
      suspects: d.residential.suspects,
      executedAt: d.residential.executedAt,
      itemsIncorporatedByReference: d.residential.itemsIncorporatedByReference,
    };
    d.residential = Object.assign(filled, preserve);
    if (window.WarrantAuthorCrimePresets.pc1524GroundsFor) {
      d.pc1524Grounds = window.WarrantAuthorCrimePresets.pc1524GroundsFor(presetId);
    }
    ds.saveDraft(caseId, d, { silent: true });
    if (typeof window.showToast === 'function') window.showToast('Re-seeded from ' + presetId + ' preset', 'success');
    _rerender();
  },

  /**
   * Run residential validator and render results into the mount div.
   * Pulls the case-level Case Probable Cause narrative and passes it
   * along — validator uses it to enforce the PC_NARRATIVE_EMPTY hard
   * blocker (residential SOPC is sourced from the shared case PC).
   */
  onResidentialValidate(caseId, draftId) {
    const v = (typeof window !== 'undefined') ? window.WarrantAuthorValidator : null;
    if (!v || typeof v.validateResidential !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Residential validator not loaded', 'error');
      return;
    }
    const ds = _store(); const d = ds ? ds.getDraft(caseId, draftId) : null;
    if (!d) return;
    const agency = _loadAgencyProfile();
    const agencyMerged = Object.assign({}, agency, d.affiantSnapshot || {});
    const pcStoreV = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    const pcNarrativeV = (pcStoreV && pcStoreV.getBody)
      ? pcStoreV.getBody(caseId)
      : (d.probableCauseNarrative || '');
    const result = v.validateResidential({
      draft: d,
      agency: agencyMerged,
      pcNarrative: pcNarrativeV,
    });
    const mount = document.getElementById('waResidentialValidation-' + draftId);
    if (!mount) return;
    mount.innerHTML = _renderResidentialValidation(result);
  },

  /**
   * Export residential draft to .docx. Builds the block stream via
   * WarrantAuthorBlockBuilder (residential branch) and hands it to the
   * `warrant-author-generate` IPC with formats=['docx'] + writeToDisk=
   * false. Main runs docx-composer.composeDocx which already speaks the
   * canonical block kinds. The returned docxBytes are wrapped in a Blob
   * and pushed through the browser download trigger.
   */
  async onResidentialExportDocx(caseId, draftId) {
    const ds = _store(); const d = ds ? ds.getDraft(caseId, draftId) : null;
    if (!d) return;
    const builder = (typeof window !== 'undefined') ? window.WarrantAuthorBlockBuilder : null;
    if (!builder || typeof builder.build !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Block builder not loaded', 'error');
      return;
    }
    const api = (typeof window !== 'undefined') ? window.electronAPI : null;
    if (!api || typeof api.warrantAuthorGenerate !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Warrant Author IPC unavailable', 'error');
      return;
    }
    const agency = _loadAgencyProfile();
    const agencyMerged = Object.assign({}, agency, d.affiantSnapshot || {});
    const caseInfo = {
      caseNumber: (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || d.caseRef || '',
      caseName:   (window.currentCase && window.currentCase.name) || '',
    };

    // Case-level Probable Cause — shared across all warrants in this
    // case. Residential SOPC section is sourced from this narrative.
    const pcStoreDocx = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    const pcNarrativeDocx = (pcStoreDocx && pcStoreDocx.getBody)
      ? pcStoreDocx.getBody(caseId)
      : (d.probableCauseNarrative || '');

    let blockStream;
    try {
      blockStream = builder.build({
        draft: d,
        addendumComposes: [],
        agency: agencyMerged,
        caseInfo,
        pcNarrative: pcNarrativeDocx,
        includeDisclaimer: false,
      });
    } catch (e) {
      console.error('[WarrantAuthor] residential block build failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Block build failed: ' + e.message, 'error');
      return;
    }

    let result;
    try {
      result = await api.warrantAuthorGenerate({
        casePath: null,                  // skip disk; pure in-memory compose
        warrantId: d.id,
        draft: d,
        blockStream,
        formats: ['docx'],
        agency: agencyMerged,
      });
    } catch (e) {
      console.error('[WarrantAuthor] residential DOCX IPC failed:', e);
      if (typeof window.showToast === 'function') window.showToast('DOCX IPC failed: ' + e.message, 'error');
      return;
    }
    if (!result || !result.success || !result.docxBytes) {
      const msg = (result && result.error) || 'main process returned no DOCX bytes';
      if (typeof window.showToast === 'function') window.showToast('DOCX export failed: ' + msg, 'error');
      return;
    }
    try {
      const u8 = new Uint8Array(result.docxBytes);
      const blob = new Blob([u8], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const filename = (d.swNumber || d.caseRef || 'residential-sw') + '.docx';
      _downloadBlob(blob, filename,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (typeof window.showToast === 'function') window.showToast('DOCX downloaded — ' + filename, 'success');
    } catch (e) {
      console.error('[WarrantAuthor] residential DOCX download failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Download failed: ' + e.message, 'error');
    }
  },
  /**
   * Export residential draft to .pdf. Builds the block stream via
   * WarrantAuthorBlockBuilder (residential branch) and renders locally
   * via WarrantAuthorPdfComposer.composePdf — same renderer-side jsPDF
   * pipeline ESP uses. Saves via _downloadBlob.
   */
  onResidentialExportPdf(caseId, draftId) {
    const ds = _store(); const d = ds ? ds.getDraft(caseId, draftId) : null;
    if (!d) return;
    const builder = (typeof window !== 'undefined') ? window.WarrantAuthorBlockBuilder : null;
    if (!builder || typeof builder.build !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Block builder not loaded', 'error');
      return;
    }
    const pdfComp = (typeof window !== 'undefined') ? window.WarrantAuthorPdfComposer : null;
    if (!pdfComp || typeof pdfComp.composePdf !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('PDF composer not loaded', 'error');
      return;
    }
    const agency = _loadAgencyProfile();
    const agencyMerged = Object.assign({}, agency, d.affiantSnapshot || {});
    const caseInfo = {
      caseNumber: (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || d.caseRef || '',
      caseName:   (window.currentCase && window.currentCase.name) || '',
    };

    // Case-level Probable Cause — shared across all warrants in this
    // case. Residential SOPC section is sourced from this narrative.
    const pcStorePdf = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    const pcNarrativePdf = (pcStorePdf && pcStorePdf.getBody)
      ? pcStorePdf.getBody(caseId)
      : (d.probableCauseNarrative || '');

    let blockStream, pdfResult;
    try {
      blockStream = builder.build({
        draft: d,
        addendumComposes: [],
        agency: agencyMerged,
        caseInfo,
        pcNarrative: pcNarrativePdf,
        includeDisclaimer: false,
      });
    } catch (e) {
      console.error('[WarrantAuthor] residential block build failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Block build failed: ' + e.message, 'error');
      return;
    }
    try {
      pdfResult = pdfComp.composePdf({ blockStream, draft: d, agency: agencyMerged });
    } catch (e) {
      console.error('[WarrantAuthor] residential PDF compose failed:', e);
      if (typeof window.showToast === 'function') window.showToast('PDF compose failed: ' + e.message, 'error');
      return;
    }
    try {
      const filename = (d.swNumber || d.caseRef || 'residential-sw') + '.pdf';
      _downloadBlob(pdfResult.blob, filename, 'application/pdf');
      if (typeof window.showToast === 'function') {
        window.showToast('PDF downloaded — ' + filename + ' (' + pdfResult.pageCount + ' page' + (pdfResult.pageCount === 1 ? '' : 's') + ')', 'success');
      }
    } catch (e) {
      console.error('[WarrantAuthor] residential PDF download failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Download failed: ' + e.message, 'error');
    }
  },

  /**
   * Standardized residential warrant generation — mirrors
   * onGenerateWarrant (ESP) so the user gets the SAME flow:
   *   1. validator pre-flight (block on errors; confirm on warnings)
   *   2. build block stream via _buildCaResidential (no addendums)
   *   3. compose PDF locally (jsPDF)
   *   4. IPC main-process: compose DOCX + write both to case folder
   *   5. show the "Warrant Generated" result modal with stats +
   *      preview/download/open buttons — reuses _showGenerateResultModal.
   */
  async onResidentialGenerate(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const draft = ds.getDraft(caseId, draftId); if (!draft) return;

    // ── Auto-sync caseRef from running case ──────────────────────────
    const runningCaseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    if (runningCaseNumber && !(draft.caseRef && String(draft.caseRef).trim())) {
      draft.caseRef = runningCaseNumber;
      try { ds.saveDraft(caseId, draft, { silent: true }); } catch (_) {}
    }

    // ── Pre-flight validation (residential) ──────────────────────────
    const V = _validator();
    if (V && typeof V.validateResidential === 'function') {
      const agencyProfile = _loadAgencyProfile();
      const agencyMerged0 = Object.assign({}, agencyProfile, draft.affiantSnapshot || {});
      const pcStore0 = window.WarrantAuthorCasePcStore;
      const pcNarrative0 = (pcStore0 && pcStore0.getBody)
        ? pcStore0.getBody(caseId)
        : (draft.probableCauseNarrative || '');
      let vres;
      try {
        vres = V.validateResidential({ draft, agency: agencyMerged0, pcNarrative: pcNarrative0 });
      } catch (_e) { vres = null; }
      if (vres && !vres.ok) {
        _showValidatorBlockModal(caseId, draft, vres);
        return;
      }
      if (vres && vres.warnings && vres.warnings.length) {
        const proceed = await _confirmValidatorWarnings(vres);
        if (!proceed) return;
      }
    }

    // ── Build block stream ───────────────────────────────────────────
    const builder = window.WarrantAuthorBlockBuilder;
    if (!builder) { alert('Block builder not loaded.'); return; }
    const agencyProfile = _loadAgencyProfile();
    const agencyMerged = Object.assign({}, agencyProfile, draft.affiantSnapshot || {});
    const pcStore = window.WarrantAuthorCasePcStore;
    const pcNarrative = (pcStore && pcStore.getBody) ? pcStore.getBody(caseId) : (draft.probableCauseNarrative || '');
    const caseInfo = {
      caseNumber: (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || draft.caseRef || '',
      caseName:   (window.currentCase && window.currentCase.name) || '',
    };
    let blockStream;
    try {
      blockStream = builder.build({
        draft, addendumComposes: [], agency: agencyMerged, caseInfo, pcNarrative, includeDisclaimer: true,
      });
    } catch (e) {
      alert('Block builder failed: ' + e.message);
      return;
    }

    // ── Render PDF locally ───────────────────────────────────────────
    const pdfComp = window.WarrantAuthorPdfComposer;
    if (!pdfComp) { alert('PDF composer not loaded.'); return; }
    let pdfResult;
    try {
      pdfResult = pdfComp.composePdf({ blockStream, draft, agency: agencyMerged });
    } catch (e) {
      alert('PDF render failed: ' + e.message);
      return;
    }

    // ── Persist to disk via IPC (PDF bytes + DOCX built in main) ─────
    let saveResult = null;
    if (window.electronAPI && typeof window.electronAPI.warrantAuthorGenerate === 'function') {
      const caseNumber = caseInfo.caseNumber;
      const casePath   = caseNumber ? `cases/${caseNumber}` : null;
      if (casePath) {
        try { await window.electronAPI.warrantAuthorSaveDraft(casePath, draft.id, draft); } catch (_) {}
      }
      try {
        saveResult = await window.electronAPI.warrantAuthorGenerate({
          casePath,
          warrantId: draft.id,
          draft,
          blockStream,
          formats: ['pdf', 'docx'],
          pdfBytes: pdfResult.arrayBuffer,
          agency:   agencyMerged,
        });
        if (!casePath && saveResult && saveResult.success) {
          saveResult.diskSkipped = true;
          saveResult.diskSkippedReason = 'No case number available — DOCX/PDF available for manual download only.';
        }
      } catch (e) {
        saveResult = { success: false, error: e.message };
      }
    }

    // ── Show result modal (same modal ESP uses) ──────────────────────
    _state._genPdfBlob = pdfResult.blob;
    _state._genFilename = (draft.caseRef || 'residential-sw') + '_residential';
    _state._genPageCount = pdfResult.pageCount;
    _state._genSave = saveResult;
    _state._genDocxBlob = null;
    if (saveResult && saveResult.docxBytes) {
      try {
        const u8 = new Uint8Array(saveResult.docxBytes);
        _state._genDocxBlob = new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      } catch (_) { _state._genDocxBlob = null; }
    }
    _showGenerateResultModal(caseId, draft, blockStream, [], pdfResult, saveResult);
  },

  /**
   * Persist the CA Options <details> open/closed state across
   * re-renders. Fired by the native `ontoggle` event whenever the
   * user manually clicks the summary chevron. NO re-render — toggling
   * the chevron is a pure UI state change.
   */
  onCaOptionsToggle(open) {
    _state.caOptionsOpen = !!open;
  },

  // ─── VA face-page handlers ───────────────────────────────────────────
  // Generic "set dot-path under draft.va" setter. Coerces null/undefined
  // out (treats them as deletion), creates nested objects on demand, and
  // re-renders so dependent UI (textareas that appear when a checkbox
  // ticks on) shows up immediately. PREFIX-LOCKED to 'va.' to avoid the
  // handler being abused as a generic anywhere-writer.
  onVaFieldSet(caseId, draftId, path, value) {
    if (typeof path !== 'string' || path.indexOf('va.') !== 0) return;
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.va || typeof d.va !== 'object') d.va = {};
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  // Silent setter for VA textareas (night-service justification,
  // reliability narrative). Persists without _rerender so caret holds
  // position mid-typing. Same prefix-lock as onVaFieldSet.
  onVaTextInput(caseId, draftId, path, value) {
    if (typeof path !== 'string' || path.indexOf('va.') !== 0) return;
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.va || typeof d.va !== 'object') d.va = {};
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    // intentionally no _rerender()
  },
  onVaTargetAccountAdd(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.va || typeof d.va !== 'object') d.va = {};
    if (!Array.isArray(d.va.targetAccounts)) d.va.targetAccounts = [];
    d.va.targetAccounts.push({ provider: '', identifier: '' });
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onVaTargetAccountRemove(caseId, draftId, idx) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.va || !Array.isArray(d.va.targetAccounts)) return;
    if (idx < 0 || idx >= d.va.targetAccounts.length) return;
    d.va.targetAccounts.splice(idx, 1);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onVaOptionsToggle(open) {
    _state.vaOptionsOpen = !!open;
  },
  onVaAdvancedDc339Toggle(open) {
    _state.vaAdvancedDc339Open = !!open;
  },
  // ─── PA (AOPC 410A) face-page handlers ───────────────────────────────
  // Prefix-locked to 'pa.' — mirror of the VA setters.
  onPaFieldSet(caseId, draftId, path, value) {
    if (typeof path !== 'string' || path.indexOf('pa.') !== 0) return;
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.pa || typeof d.pa !== 'object') d.pa = {};
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onPaTextInput(caseId, draftId, path, value) {
    if (typeof path !== 'string' || path.indexOf('pa.') !== 0) return;
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.pa || typeof d.pa !== 'object') d.pa = {};
    _setByPath(d, path, value);
    ds.saveDraft(caseId, d, { silent: true });
    // no _rerender() — keep caret in the field while typing
  },
  onPaOptionsToggle(open) {
    _state.paOptionsOpen = !!open;
  },
  // Read selected image files as data URLs and append them as exhibits.
  onPaPhotoFiles(caseId, draftId, inputEl) {
    if (!inputEl || !inputEl.files || !inputEl.files.length) return;
    const ds = _store(); if (!ds) return;
    const files = Array.from(inputEl.files);
    let pending = files.length;
    const added = [];
    const commit = () => {
      const d = ds.getDraft(caseId, draftId); if (!d) return;
      if (!d.pa || typeof d.pa !== 'object') d.pa = {};
      if (!Array.isArray(d.pa.photos)) d.pa.photos = [];
      d.pa.photos.push(...added);
      ds.saveDraft(caseId, d, { silent: true });
      try { inputEl.value = ''; } catch (_) {}
      _rerender();
    };
    files.forEach(file => {
      if (!/^image\/(png|jpeg)$/i.test(file.type)) {
        if (typeof viperToast === 'function') viperToast(`Skipped ${file.name}: only PNG/JPEG supported.`, 'warning');
        if (--pending === 0) commit();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        added.push({ dataUrl: String(reader.result || ''), caption: '' });
        if (--pending === 0) commit();
      };
      reader.onerror = () => {
        if (typeof viperToast === 'function') viperToast(`Failed to read ${file.name}.`, 'error');
        if (--pending === 0) commit();
      };
      reader.readAsDataURL(file);
    });
  },
  onPaPhotoCaption(caseId, draftId, idx, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.pa || !Array.isArray(d.pa.photos) || !d.pa.photos[idx]) return;
    d.pa.photos[idx].caption = value;
    ds.saveDraft(caseId, d, { silent: true });
    // no _rerender() — keep caret in the caption field
  },
  onPaPhotoRemove(caseId, draftId, idx) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    if (!d.pa || !Array.isArray(d.pa.photos)) return;
    if (idx < 0 || idx >= d.pa.photos.length) return;
    d.pa.photos.splice(idx, 1);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  /**
   * Case-level shared probable cause edit. Fired on every keystroke.
   * Writes to the case-PC store, mirrors into every draft on this case
   * (so the validator + template engine still see it), and patches the
   * footer stats in-place — does NOT rerender so the textarea keeps focus.
   */
  onCasePcChange(caseId, body) {
    const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    if (!pcStore) return;
    const rec = pcStore.setBody(caseId, body);
    // Mirror into all drafts (one-way: case → drafts) for validator/template compat.
    const ds = _store();
    if (ds) {
      try {
        const drafts = ds.listDrafts(caseId) || [];
        for (const d of drafts) {
          if (d && d.probableCauseNarrative !== body) {
            d.probableCauseNarrative = body;
            ds.saveDraft(caseId, d, { silent: true });
          }
        }
      } catch (_e) {}
    }
    // Patch footer stats in-place (no rerender so focus stays in textarea).
    try {
      const stats = pcStore.stats(caseId);
      const w = document.getElementById('waPcWordCount');
      const c = document.getElementById('waPcCharCount');
      const r = document.getElementById('waPcRevCount');
      const u = document.getElementById('waPcUpdated');
      if (w) w.textContent = stats.words;
      if (c) c.textContent = stats.chars;
      if (r) r.textContent = stats.revisionCount;
      if (u) u.textContent = stats.updatedAt ? _shortDate(stats.updatedAt) : '—';
    } catch (_e) {}
  },
  /**
   * Case-level offense description edit (Case Probable Cause panel).
   * Mirrors into every draft on this case so the validator + template
   * engine see it on the draft path too (back-compat with the old
   * draft.offenseDescription field). Silent — no _rerender so the
   * input keeps caret position mid-typing.
   */
  onCaseOffenseDescChange(caseId, value) {
    const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    if (!pcStore) return;
    pcStore.setOffenseDescription(caseId, value);
    const ds = _store();
    if (ds) {
      try {
        const drafts = ds.listDrafts(caseId) || [];
        for (const d of drafts) {
          if (d && d.offenseDescription !== value) {
            d.offenseDescription = value;
            ds.saveDraft(caseId, d, { silent: true });
          }
        }
      } catch (_e) {}
    }
    // No rerender on every keystroke — keep focus/caret in the input.
    // The validator panel + live preview refresh on blur (see
    // onCaseOffenseDescBlur) so we don't re-run engine.compose per char.
  },
  /**
   * Fires when the offense-description input loses focus. The value was
   * already persisted by onCaseOffenseDescChange (oninput); this just
   * refreshes the validator panel + live preview so their "no offense
   * description" warning / dangling {{case.offenseDescription}} slot
   * clears once the field is filled. Safe to _rerender: the offense
   * input lives in #waCasePcMount, a separate container from the
   * #waSubtabContent that _rerender() rebuilds — caret is untouched.
   */
  onCaseOffenseDescBlur(_caseId) {
    _rerender();
  },
  /**
   * Case-level offense date edit. <input type="date"> fires change on a
   * fully-formed ISO value, so it's safe to rerender. We do — otherwise
   * the validator's "no offense date" warning and the dangling
   * {{case.offenseDate}} slot in the live preview never clear after the
   * user picks a date.
   */
  onCaseOffenseDateChange(caseId, value) {
    const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
    if (!pcStore) return;
    pcStore.setOffenseDate(caseId, value);
    const ds = _store();
    if (ds) {
      try {
        const drafts = ds.listDrafts(caseId) || [];
        for (const d of drafts) {
          if (d && d.offenseDate !== value) {
            d.offenseDate = value;
            ds.saveDraft(caseId, d, { silent: true });
          }
        }
      } catch (_e) {}
    }
    // Refresh validator + live preview so the offense-date warning/slot
    // clears. The date input is in #waCasePcMount, untouched by _rerender.
    _rerender();
  },
  /**
   * "Pick from reference" dropdown handler. Writes the selected label
   * into the offense description input + the case-pc store (same path
   * as a manual edit). Caller resets the <select> to "" after firing so
   * it visually goes back to the placeholder.
   */
  onCaseOffensePickFromRef(caseId, value) {
    if (!value) return;
    const input = document.getElementById('waCaseOffenseDesc');
    if (input) input.value = value;
    this.onCaseOffenseDescChange(caseId, value);
    // Picking from the library is a commit action — refresh validator +
    // live preview immediately so the warning/dangling slot clears.
    _rerender();
  },
  onSelectAddendum(caseId, draftId, addendumId) {
    _state.activeDraftId = draftId;
    _state.activeAddendumId = addendumId;
    _rerender();
  },
  onAddAddendum(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const ad = ds.addAddendum(caseId, draftId, {});
    if (ad) _state.activeAddendumId = ad.id;
    _rerender();
  },
  onRemoveAddendum(caseId, draftId, addendumId) {
    if (!confirm('Remove this addendum?')) return;
    const ds = _store(); if (!ds) return;
    ds.removeAddendum(caseId, draftId, addendumId);
    if (_state.activeAddendumId === addendumId) _state.activeAddendumId = null;
    _rerender();
  },
  onAddendumProviderChange(caseId, draftId, addendumId, providerKey) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.providerKey = providerKey;

    // populate snapshot from directory
    const pdir = _pdir();
    if (pdir && providerKey) {
      const merged = pdir.mergeProviders({
        providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
        customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
        providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
      });
      const p = merged.find(pp => pp.key === providerKey);
      if (p) {
        ad.businessNameSnapshot = p.name || '';
        ad.custodianAttention = p.custodian || ad.custodianAttention;
        ad.serviceAddress = p.address || '';
        ad.phone = p.phone || '';
        ad.email = p.email || '';
        ad.onlineService = p.onlineService || '';
      }
    }
    // refresh items-to-seize to provider default if user hasn't customized
    if (!ad.itemsToProduce || !ad.itemsToProduce.length) {
      const items = _items();
      if (items) ad.itemsToProduce = items.resolvePatternKeys(items.defaultPatternFor(providerKey));
    }
    ds.saveDraft(caseId, d, { silent: true });
    // Electron focus quirk: when a <select>'s change handler synchronously
    // tears down the DOM, the native popup-close focus event lands on a
    // node that no longer exists. The renderer's keyboard focus then goes
    // stale until the BrowserWindow itself loses + regains focus (which is
    // why users had to alt-tab to be able to type in the date inputs).
    //
    // Fix: blur the select first, defer the rerender to the next animation
    // frame so Chromium finishes its native popup cleanup against a stable
    // tree, then explicitly nudge the renderer's focus state and land the
    // caret in the "From" date input so the user can start typing.
    try {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    } catch (_e) { /* ignore */ }
    const _focusAfter = () => {
      try { if (typeof window.focus === 'function') window.focus(); } catch (_e) {}
      const fromInput = document.querySelector(
        `input[onblur*="'${addendumId}'"][onblur*="dateRangeFrom"]`
      );
      if (fromInput) {
        try { fromInput.focus({ preventScroll: true }); } catch (_e) { fromInput.focus(); }
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        _rerender();
        requestAnimationFrame(_focusAfter);
      });
    } else {
      _rerender();
      setTimeout(_focusAfter, 0);
    }
  },
  onAddendumFieldChange(caseId, draftId, addendumId, field, value) {
    const ds = _store(); if (!ds) return;
    const isDateField = (field === 'dateRangeFrom' || field === 'dateRangeTo');
    // DO NOT normalize date fields here — Chromium fires `change` between
    // year-digit keystrokes. Normalizing partial input (e.g. "0002") would
    // overwrite the user's typing with a coerced year. Validator + warrant
    // generation normalize on read instead (see _normalizeDateValue calls
    // in the validator section).
    ds.updateAddendum(caseId, draftId, addendumId, { [field]: value });
    // Skip rerender for date fields — rerender destroys the input DOM
    // mid-typing and kills focus. Date fields don't drive any conditional
    // rendering in this form, so deferring to the next natural rerender
    // is safe.
    if (!isDateField) _rerender();
  },

  // ── Exhibits (CR-Exhibit) ──────────────────────────────────────────
  onAddExhibits(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) { input.remove(); return; }
      const draft = ds.getDraft(caseId, draftId);
      if (!draft) { input.remove(); return; }
      if (!Array.isArray(draft.exhibits)) draft.exhibits = [];
      for (const f of files) {
        try {
          const ex = await _readExhibitFile(f);
          draft.exhibits.push({
            id: 'ex_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            caption: '',
            mime: ex.mime,
            dataUrl: ex.dataUrl,
            w: ex.w, h: ex.h,
            name: ex.name,
            addedAt: new Date().toISOString(),
          });
        } catch (e) {
          if (typeof window.showToast === 'function') window.showToast(e.message, 'error');
          else alert(e.message);
        }
      }
      try { ds.saveDraft(caseId, draft); } catch (_) {}
      input.remove();
      _rerender();
    };
    document.body.appendChild(input);
    input.click();
  },
  onExhibitCaptionChange(caseId, draftId, exhibitId, value) {
    const ds = _store(); if (!ds) return;
    const draft = ds.getDraft(caseId, draftId); if (!draft) return;
    const ex = (draft.exhibits || []).find(e => e.id === exhibitId);
    if (!ex) return;
    ex.caption = value;
    try { ds.saveDraft(caseId, draft); } catch (_) {}
    // No rerender — preserve focus; caption is read at generate time.
  },
  onRemoveExhibit(caseId, draftId, exhibitId) {
    const ds = _store(); if (!ds) return;
    const draft = ds.getDraft(caseId, draftId); if (!draft) return;
    draft.exhibits = (draft.exhibits || []).filter(e => e.id !== exhibitId);
    try { ds.saveDraft(caseId, draft); } catch (_) {}
    _rerender();
  },
  /**
   * Persist handler for the MM/DD/YYYY text inputs. Parses to ISO
   * YYYY-MM-DD on blur so downstream code (validator, generation) gets
   * the canonical format. No rerender — the input value is already
   * what the user typed; rerendering would reseed it from store via
   * _isoToUsDate, which is fine but pointless mid-edit.
   */
  onAddendumDateBlur(caseId, draftId, addendumId, field, value) {
    const ds = _store(); if (!ds) return;
    const iso = _usDateToIso(value);
    ds.updateAddendum(caseId, draftId, addendumId, { [field]: iso });
    // No _rerender(): the surrounding form needs no DOM update on a date save.
  },

  /**
   * Generate the Pennsylvania AOPC 410A deliverable (Application + Affidavit
   * + continuations + photo exhibits). Unlike the ESP path this has NO
   * per-provider addendums and doesn't run the ESP slot validator — the
   * main-process overlay (pa-form-overlay.js) builds the whole document from
   * draft.pa.* + the shared Probable Cause narrative + agency profile.
   * Output is PDF only (the official AcroForm document is the deliverable).
   */
  async onPaGenerate(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const draft = ds.getDraft(caseId, draftId); if (!draft) return;

    // Self-heal: ensure the draft is coherently PA before we build. A draft
    // can reach here with jurisdiction 'PA' but a stale non-PA template (e.g.
    // created before PA existed, or the header template <select> drifted).
    // Normalise both so the main-process overlay branch + the result modal
    // label agree, and persist the correction.
    if (draft.template !== 'pa-multi-business-esp' || String(draft.jurisdiction || '').toUpperCase() !== 'PA') {
      draft.template = 'pa-multi-business-esp';
      draft.jurisdiction = 'PA';
      try { ds.saveDraft(caseId, draft, { silent: true }); } catch (_) {}
    }

    // Auto-sync caseRef from the running case.
    const runningCaseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    if (runningCaseNumber && !(draft.caseRef && String(draft.caseRef).trim())) {
      draft.caseRef = runningCaseNumber;
      try { ds.saveDraft(caseId, draft, { silent: true }); } catch (_) {}
    }

    // Mirror shared case Probable Cause narrative onto the draft so main sees it.
    const pcStore = window.WarrantAuthorCasePcStore;
    const pcNarrative = (pcStore && pcStore.getBody) ? pcStore.getBody(caseId) : (draft.probableCauseNarrative || '');
    if (pcNarrative && draft.probableCauseNarrative !== pcNarrative) {
      draft.probableCauseNarrative = pcNarrative;
      try { ds.saveDraft(caseId, draft, { silent: true }); } catch (_) {}
    }

    // Soft pre-flight — warn (do not hard-block) on empty core fields.
    const pa = (draft.pa && typeof draft.pa === 'object') ? draft.pa : {};
    const missing = [];
    if (!String(pa.itemsToSearchSeize || '').trim())  missing.push('Items/persons to be searched for & seized');
    if (!String(pa.premisesDescription || '').trim()) missing.push('Description of premises/person to be searched');
    if (!String(pcNarrative || '').trim())            missing.push('Probable Cause narrative (Affidavit body)');
    if (missing.length) {
      const proceed = confirm('These Pennsylvania fields are empty:\n\n• ' + missing.join('\n• ') + '\n\nGenerate the warrant anyway?');
      if (!proceed) return;
    }

    const agencyProfile = _loadAgencyProfile();
    const agencyMerged = Object.assign({}, agencyProfile, draft.affiantSnapshot || {});
    const caseInfo = {
      caseNumber: runningCaseNumber || draft.caseRef || '',
      caseName:   (window.currentCase && window.currentCase.name) || '',
      county:     agencyMerged.county || '',
    };

    if (!window.electronAPI || typeof window.electronAPI.warrantAuthorGenerate !== 'function') {
      alert('Pennsylvania warrant generation requires the VIPER desktop app.');
      return;
    }

    const casePath = caseInfo.caseNumber ? `cases/${caseInfo.caseNumber}` : null;
    if (casePath) {
      try { await window.electronAPI.warrantAuthorSaveDraft(casePath, draft.id, draft); } catch (_) {}
    }

    // Build the ESP addendum info (Google/etc. provider records to produce)
    // as plain text and render it onto the OFFICIAL PA Application
    // Continuation form (not a generic appended page, and without
    // re-posting the Probable Cause narrative). The overlay flows this
    // into the continuation page's ContinuationField under box 18.
    let draftForGen = draft;
    try {
      const paOverrides = {};
      const espText = _buildPaEspContinuationText(caseId, draft);
      if (espText && espText.trim()) paOverrides.espContinuation = espText;
      // Exhibit photos → PA overlay photo-exhibit pages (2 per page, appended
      // after the affidavit). Overlay reads draft.pa.photos = [{dataUrl, caption}].
      const exhibits = _draftExhibits(draft);
      if (exhibits.length) {
        paOverrides.photos = exhibits.map(ex => ({
          dataUrl: ex.dataUrl,
          caption: ex.caption || '',
        }));
      }
      if (Object.keys(paOverrides).length) {
        draftForGen = Object.assign({}, draft, {
          pa: Object.assign(
            {},
            (draft.pa && typeof draft.pa === 'object') ? draft.pa : {},
            paOverrides
          ),
        });
      }
    } catch (_) { draftForGen = draft; }

    let saveResult;
    try {
      saveResult = await window.electronAPI.warrantAuthorGenerate({
        casePath,
        warrantId: draft.id,
        draft: draftForGen,
        formats: ['pdf'],           // PA deliverable is the official PDF forms
        agency: agencyMerged,
        caseInfo,
      });
    } catch (e) {
      saveResult = { success: false, error: e.message };
    }
    if (!casePath && saveResult && saveResult.success) {
      saveResult.diskSkipped = true;
      saveResult.diskSkippedReason = 'No case number available — PDF available for manual download only.';
    }

    // Build preview blob from the merged bytes main returns.
    _state._genPdfBlob   = null;
    _state._genDocxBlob  = null;
    _state._genFilename  = (draft.caseRef || 'warrant') + '_PA-AOPC410A';
    _state._genPageCount = (saveResult && saveResult.paOverlay && saveResult.paOverlay.pageCount) || 0;
    _state._genSave      = saveResult;
    if (saveResult && saveResult.pdfBytes) {
      try {
        _state._genPdfBlob = new Blob([new Uint8Array(saveResult.pdfBytes)], { type: 'application/pdf' });
      } catch (_) { _state._genPdfBlob = null; }
    }
    if (saveResult && saveResult.paOverlay && !saveResult.paOverlay.merged && saveResult.paOverlay.error) {
      alert('PA warrant build failed: ' + saveResult.paOverlay.error);
    }

    const pdfResult = { blob: _state._genPdfBlob, pageCount: _state._genPageCount, arrayBuffer: null };
    // PA fills official forms rather than a block stream, so synthesize a stats
    // object so the result modal reports the real addendum count (folded into the
    // Application Continuation page) instead of 0.
    const paAddCount = Array.isArray(draft.addendums) ? draft.addendums.length : 0;
    const paStats = { stats: { addendums: paAddCount, totalBlocks: 0, pcAuthored: true } };
    _showGenerateResultModal(caseId, draft, paStats, [], pdfResult, saveResult);
  },

  /**
   * Generate a full PDF + DOCX warrant for ALL addendums in this draft.
   *
   * Pipeline:
   *   1. Compose each addendum via template-engine (capture as addendumComposes[]).
   *   2. Build a unified block stream via WarrantAuthorBlockBuilder.build().
   *   3. Render PDF locally in the renderer via WarrantAuthorPdfComposer.composePdf().
   *   4. Ship pdfBytes + blockStream + draft + agency to main via
   *      electronAPI.warrantAuthorGenerate({...}) — main writes the PDF and
   *      builds the DOCX via the `docx` package.
   *   5. Show result modal with Open PDF / Open DOCX / Open Folder actions.
   *
   * If electronAPI is unavailable (browser preview / sandbox), falls back
   * to in-browser PDF download via Blob URL (DOCX is skipped).
   */
  async onGenerateWarrant(caseId, draftId) {
    const ds = _store(); if (!ds) return;
    const draft = ds.getDraft(caseId, draftId); if (!draft) return;
    // PA (AOPC 410A) uses its own overlay-driven generate flow — it has no
    // per-provider addendums and doesn't run the ESP block/slot validator.
    const _jx = String(draft.jurisdiction || '').toUpperCase();
    if (_jx === 'PA' || draft.template === 'pa-multi-business-esp') {
      return this.onPaGenerate(caseId, draftId);
    }
    const engine = _engine();
    if (!engine) { alert('Template engine not loaded.'); return; }
    if (!engine) { alert('Template engine not loaded.'); return; }
    const tpl = engine.getTemplate(draft.template);
    if (!tpl) { alert("Template '" + draft.template + "' not registered."); return; }

    // ── Auto-sync caseRef from running case ──────────────────────────
    // If the user opened the Warrant Author from a case page (the only
    // supported entry point) but never typed anything in the Case Ref
    // field, fall back to the running case's number. This (a) gives the
    // validator's DRAFT_NO_CASE_REF check a hit, (b) gives the disk
    // persistence layer a valid `cases/{caseRef}/` path, and (c) gets
    // the right value printed in the cover meta strip and footers.
    const runningCaseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    if (runningCaseNumber && !(draft.caseRef && String(draft.caseRef).trim())) {
      draft.caseRef = runningCaseNumber;
      try { ds.saveDraft(caseId, draft); } catch (_) {}
    }
    // ─────────────────────────────────────────────────────────────────

    // ── Pre-flight validation ────────────────────────────────────────
    const V = _validator();
    if (V) {
      const agencyProfile = _loadAgencyProfile();
      const pdir0 = _pdir();
      const providers0 = pdir0 ? pdir0.mergeProviders({
        providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
        customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
        providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
      }) : [];
      const pcStore0 = window.WarrantAuthorCasePcStore;
      const pcNarrative0 = (pcStore0 && pcStore0.getBody)
        ? pcStore0.getBody(caseId)
        : (draft.probableCauseNarrative || '');
      const caseCtx0 = {
        offenseDescription: (pcStore0 && pcStore0.getOffenseDescription) ? pcStore0.getOffenseDescription(caseId) : '',
        offenseDate:        (pcStore0 && pcStore0.getOffenseDate)        ? pcStore0.getOffenseDate(caseId)        : '',
      };
      const vres = V.validateDraft({
        draft,
        agency: agencyProfile,
        providers: providers0,
        pcNarrative: pcNarrative0,
        caseCtx: caseCtx0,
      });
      if (!vres.ok) {
        _showValidatorBlockModal(caseId, draft, vres);
        return;
      }
      if (vres.warnings.length) {
        const proceed = await _confirmValidatorWarnings(vres);
        if (!proceed) return;
      }
    }
    // ─────────────────────────────────────────────────────────────────

    const pdir = _pdir();
    const items = _items();
    const providersMerged = pdir ? pdir.mergeProviders({
      providerOverrides: _safeLS('viperWarrantAuthorProviderOverrides'),
      customProviders:   _safeLS('viperWarrantAuthorCustomProviders'),
      providerDeletions: _safeLS('viperWarrantAuthorProviderDeletions')
    }) : [];

    const ads = Array.isArray(draft.addendums) ? draft.addendums : [];
    if (!ads.length) { alert('Add at least one addendum before generating.'); return; }

    // 1. Compose each addendum
    const addendumComposes = [];
    const issues = [];
    for (const ad of ads) {
      const provider = providersMerged.find(p => p.key === ad.providerKey) || { key: ad.providerKey, name: ad.providerKey || '(no provider)' };
      const adForEngine = Object.assign({}, ad, {
        targets: Array.isArray(ad.targetAccounts)
          ? ad.targetAccounts.filter(t => t && String(t.value || '').trim() !== '')
          : [],
        dateRange: {
          start: ad.dateRangeFrom || '',
          end:   ad.dateRangeTo   || '',
          allAvailable: !!ad.allDatesAvailable,
        },
        itemsToProduce: Array.isArray(ad.itemsToProduce) ? ad.itemsToProduce.slice() : [],
        // Inject case-level Probable Cause + date-range basis so the CO
        // template's {{addendum.probableCause}} / {{addendum.dateRangeBasis}}
        // slots resolve in the EXPORTED document (not just preview).
        probableCause: _resolvePcForDraft(caseId, draft),
        dateRangeBasis: _resolveDateRangeBasis(ad),
      });
      const _coAgency = _mergeAgencyForDraft(draft);
      const ctx = {
        addendum: adForEngine,
        provider,
        items,
        affiant: _coAgency,
        agency:  _coAgency,
        draft,
        // CO template needs court + case ctx; harmless on other templates
        // because non-CO resolvers ignore them.
        court: _resolveCoCourtForDraft(draft),
        case: _resolveCaseCtxForDraft(draft),
      };
      let composed;
      try {
        composed = engine.compose(tpl, ctx);
      } catch (e) {
        composed = { blocks: [{ kind: 'paragraph', text: '(compose error: ' + e.message + ')' }], danglingSlots: ['engine.error'], missingItems: true };
      }
      const danglingArr = Array.isArray(composed.danglingSlots) ? composed.danglingSlots : [];
      if (danglingArr.length) {
        issues.push('Page ' + (ad.pageLabel || '?') + ' (' + (provider.name || ad.providerKey) + '): ' + danglingArr.join(', '));
      }
      addendumComposes.push({
        addendumId:   ad.id,
        providerKey:  provider.key,
        providerName: provider.name || provider.key,
        businessName: ad.businessName || '',
        compose:      composed,
      });
    }

    // 2. Build unified block stream
    const builder = window.WarrantAuthorBlockBuilder;
    if (!builder) { alert('Block builder not loaded.'); return; }
    const agencyProfile = _safeLS('viperAgencyProfile') || {};
    // Mirror affiant snapshot into agency for fallbacks
    const agencyMerged = Object.assign({}, agencyProfile, draft.affiantSnapshot || {});
    const pcStore = window.WarrantAuthorCasePcStore;
    const pcNarrative = (pcStore && pcStore.getBody) ? pcStore.getBody(caseId) : (draft.probableCauseNarrative || '');
    const caseInfo = {
      caseNumber: (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || draft.caseRef || '',
      caseName:   (window.currentCase && window.currentCase.name) || '',
    };
    let blockStream;
    try {
      blockStream = builder.build({
        draft, addendumComposes, agency: agencyMerged, caseInfo, pcNarrative, includeDisclaimer: true,
      });
    } catch (e) {
      alert('Block builder failed: ' + e.message);
      return;
    }

    // Append CR-Exhibit section (photos/screenshots) so both the renderer
    // PDF and the main-process DOCX render them from the same blockStream.
    try { _appendExhibitBlocks(blockStream, draft); } catch (_) {}

    // 3. Render PDF locally
    const pdfComp = window.WarrantAuthorPdfComposer;
    if (!pdfComp) { alert('PDF composer not loaded.'); return; }
    let pdfResult;
    try {
      pdfResult = pdfComp.composePdf({ blockStream, draft, agency: agencyMerged });
    } catch (e) {
      alert('PDF render failed: ' + e.message);
      return;
    }

    // 4. Persist to disk via IPC (PDF bytes + DOCX built in main).
    //    We ALWAYS call the IPC if available — even without a casePath —
    //    so we get the DOCX bytes back for an in-browser Download DOCX
    //    button. The main handler treats casePath as optional: when null
    //    it just composes DOCX in memory and returns bytes.
    let saveResult = null;
    if (window.electronAPI && typeof window.electronAPI.warrantAuthorGenerate === 'function') {
      const caseNumber = caseInfo.caseNumber;
      const casePath   = caseNumber ? `cases/${caseNumber}` : null;
      if (casePath) {
        // Ensure draft is persisted to manifest first (idempotent — the
        // generate handler patches generatedAt/pdfPath/docxPath onto it).
        try {
          await window.electronAPI.warrantAuthorSaveDraft(casePath, draft.id, draft);
        } catch (_) {}
      }
      try {
        saveResult = await window.electronAPI.warrantAuthorGenerate({
          casePath,                              // may be null — main will skip disk
          warrantId: draft.id,
          draft,
          blockStream,
          formats: ['pdf', 'docx'],
          pdfBytes: pdfResult.arrayBuffer,
          agency:   agencyMerged,
          caseInfo,                              // {caseNumber, county?} — PA overlay auto-fills headers
        });
        // Decorate failure mode when no case number — UI still wants the
        // DOCX/PDF blobs, but the disk-status banner should explain why
        // nothing was saved to the case folder.
        if (!casePath && saveResult && saveResult.success) {
          saveResult.diskSkipped = true;
          saveResult.diskSkippedReason = 'No case number available — DOCX/PDF available for manual download only.';
        }
      } catch (e) {
        saveResult = { success: false, error: e.message };
      }
    }

    // 5. Show result modal
    _state._genPdfBlob = pdfResult.blob;
    _state._genFilename = (draft.caseRef || 'warrant') + '_' + (
      draft.template === 'ca-multi-business-esp' ? 'CA'
      : draft.template === 'va-multi-business-esp' ? 'VA'
      : 'US'
    );
    _state._genPageCount = pdfResult.pageCount;
    _state._genSave = saveResult;
    // Stash the DOCX bytes returned by main as a Blob, so the result modal
    // can offer a Download DOCX button regardless of disk-persist outcome.
    _state._genDocxBlob = null;
    if (saveResult && saveResult.docxBytes) {
      try {
        const u8 = new Uint8Array(saveResult.docxBytes);
        _state._genDocxBlob = new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      } catch (_) { _state._genDocxBlob = null; }
    }
    // VA template: main returns the MERGED PDF (DC-338 + DC-339 + attachments).
    // Swap _genPdfBlob from the renderer-built jsPDF (attachments only) to
    // the merged deliverable so Preview/Download show the user the same
    // document that lands on disk.
    if (saveResult && saveResult.pdfBytes) {
      try {
        const u8 = new Uint8Array(saveResult.pdfBytes);
        _state._genPdfBlob = new Blob([u8], { type: 'application/pdf' });
        // Update jsPDF result page count to reflect the merged document
        // so the result modal banner shows the true total.
        if (saveResult.vaOverlay && saveResult.vaOverlay.sectionPageCounts) {
          const sp = saveResult.vaOverlay.sectionPageCounts;
          _state._genPageCount = (sp.dc338 || 0) + (sp.dc339 || 0) + (sp.attachments || 0);
        }
      } catch (_) { /* keep jsPDF blob as fallback */ }
    }
    _showGenerateResultModal(caseId, draft, blockStream, issues, pdfResult, saveResult);
  },
  onCloseGenerateModal() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = ''; ov.classList.add('hidden'); }
    _state._genPdfBlob = null;
    _state._genDocxBlob = null;
    _state._genFilename = null;
    _state._genPageCount = null;
    _state._genSave = null;
  },
  /** Show the addendum Help / Legend modal (patterns + clauses). */
  onShowAddendumHelp() {
    _showAddendumHelpModal();
  },
  /** Close the addendum Help modal. */
  onCloseAddendumHelp() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = ''; ov.classList.add('hidden'); }
  },
  onCloseValidatorModal() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = ''; ov.classList.add('hidden'); }
    // If a confirm() promise is pending, resolve it as cancel.
    if (typeof _state._validatorResolve === 'function') {
      const r = _state._validatorResolve;
      _state._validatorResolve = null;
      r(false);
    }
  },
  onResolveValidatorConfirm(proceed) {
    const ov = document.getElementById('waModalOverlay');
    if (ov) { ov.innerHTML = ''; ov.classList.add('hidden'); }
    if (typeof _state._validatorResolve === 'function') {
      const r = _state._validatorResolve;
      _state._validatorResolve = null;
      r(!!proceed);
    }
  },
  onDownloadGeneratedPdf() {
    const blob = _state._genPdfBlob;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = (_state._genFilename || 'warrant') + '.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  },
  onDownloadGeneratedDocx() {
    const blob = _state._genDocxBlob;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = (_state._genFilename || 'warrant') + '.docx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  },
  onPreviewGeneratedPdf() {
    const blob = _state._genPdfBlob;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Note: we leak the URL on purpose so the new tab/preview window stays valid.
  },
  async onOpenGeneratedOnDisk(caseId, draftId, format) {
    if (!window.electronAPI || typeof window.electronAPI.warrantAuthorOpenGenerated !== 'function') return;
    const caseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    if (!caseNumber) { alert('No case number available.'); return; }
    const r = await window.electronAPI.warrantAuthorOpenGenerated(`cases/${caseNumber}`, draftId, format);
    if (!r || !r.success) {
      alert((r && r.error) || 'Open failed.');
    }
  },
  async onOpenGeneratedFolder(caseId, draftId) {
    if (!window.electronAPI || typeof window.electronAPI.warrantAuthorOpenDraftFolder !== 'function') return;
    const caseNumber = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    if (!caseNumber) { alert('No case number available.'); return; }
    const r = await window.electronAPI.warrantAuthorOpenDraftFolder(`cases/${caseNumber}`, draftId);
    if (!r || !r.success) {
      alert((r && r.error) || 'Open folder failed.');
    }
  },

  onAddTarget(caseId, draftId, addendumId) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.targetAccounts = ad.targetAccounts || [];
    ad.targetAccounts.push({ type: 'email', value: '' });
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onRemoveTarget(caseId, draftId, addendumId, idx) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.targetAccounts = (ad.targetAccounts || []).filter((_, i) => i !== idx);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onTargetFieldChange(caseId, draftId, addendumId, idx, field, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    if (!ad.targetAccounts[idx]) return;
    ad.targetAccounts[idx][field] = value;
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onAutofillTarget(caseId, draftId, addendumId, type, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.targetAccounts = ad.targetAccounts || [];
    // dedupe
    if (ad.targetAccounts.some(t => String(t.value).toLowerCase() === String(value).toLowerCase())) {
      try { window.showToast && window.showToast('Already added', 'info'); } catch(_){}
      return;
    }
    ad.targetAccounts.push({ type, value });
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onApplyPattern(caseId, draftId, addendumId, patternKey) {
    if (!patternKey) return;
    const items = _items(); if (!items) return;
    const keys = items.resolvePatternKeys(patternKey);
    if (!keys.length) return;
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.itemsToProduce = keys.slice();
    ad.itemsPattern = patternKey;
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
  onToggleItem(caseId, draftId, addendumId, itemKey, checked) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    const set = new Set(ad.itemsToProduce || []);
    if (checked) set.add(itemKey); else set.delete(itemKey);
    ad.itemsToProduce = Array.from(set);
    ds.saveDraft(caseId, d, { silent: true });
    _rerender();
  },
};

// ─── export ─────────────────────────────────────────────────────────────

const api = Object.freeze({
  SCHEMA_VERSION,
  renderSubtab,
  renderCasePc,
  harvestIdentifiers,
  // internal state surface for the host page
  _state,
  bus,
});

if (typeof window !== 'undefined') {
  window.WarrantAuthorUI = api;
}
})();
