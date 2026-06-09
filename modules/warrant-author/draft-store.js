// modules/warrant-author/draft-store.js
// Renderer-side CRUD over `warrantAuthor_${caseId}` localStorage.
//
// Storage shape (per plan §4.1):
//   warrantAuthor_${caseId} = { drafts: [ { id, type, template, jurisdiction,
//                                           status, swNumber, caseRef,
//                                           courtName, county, judgeName,
//                                           affiantSnapshot, pc1524Grounds,
//                                           hobbsSealing, nightSearch,
//                                           probableCauseNarrative,
//                                           tenDayExtensionRequested,
//                                           addendums: [ … ],
//                                           pdfPath, docxPath, manifestPath,
//                                           createdAt, updatedAt } ] }
//
// IIFE wrapper so SCHEMA_VERSION et al. don't collide in the renderer's
// shared classic-script scope (matches the P2/P3/P4/P5 modules).
'use strict';

(function () {
const SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'warrantAuthor_';

// ─── id helpers ─────────────────────────────────────────────────────────

function _rand4() {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
}
function _draftId() { return `wa_${_rand4()}${_rand4()}`; }
function _addendumId() { return `ad_${_rand4()}${_rand4()}`; }

function _nowIso() {
  try { return new Date().toISOString(); } catch (_) { return ''; }
}

function _storageKey(caseId) { return `${STORAGE_PREFIX}${String(caseId)}`; }

// ─── storage I/O ────────────────────────────────────────────────────────

function _loadRaw(caseId) {
  if (!caseId) return { drafts: [] };
  let raw;
  try { raw = localStorage.getItem(_storageKey(caseId)); } catch (_) { return { drafts: [] }; }
  if (!raw) return { drafts: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { drafts: [] };
    if (!Array.isArray(parsed.drafts)) parsed.drafts = [];
    return parsed;
  } catch (_) {
    return { drafts: [] };
  }
}

function _save(caseId, data, opts) {
  if (!caseId) return false;
  const silent = !!(opts && opts.silent);
  try {
    localStorage.setItem(_storageKey(caseId), JSON.stringify(data));
    if (!silent) {
      try { window.dispatchEvent(new CustomEvent('warrant-author-change', { detail: { caseId } })); } catch (_) {}
    }
    return true;
  } catch (e) {
    console.error('[WarrantAuthor] draft-store save failed:', e);
    return false;
  }
}

// ─── pageLabel sequencer (A, B, …, Z, AA, AB, …) ────────────────────────

function _pageLabelFor(idx) {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function renumberPageLabels(draft) {
  if (!draft || !Array.isArray(draft.addendums)) return draft;
  draft.addendums.forEach((ad, i) => { ad.pageLabel = _pageLabelFor(i); });
  return draft;
}

// ─── factory: new addendum ─────────────────────────────────────────────

function newAddendum(overrides) {
  const ad = {
    id: _addendumId(),
    pageLabel: 'A',
    providerKey: '',
    providerNameOverride: null,
    businessNameSnapshot: '',
    custodianAttention: '',
    onlineService: '',
    serviceAddress: '',
    phone: '',
    email: '',
    notes: '',
    targetAccounts: [],
    dateRangeFrom: '',
    dateRangeTo: '',
    itemsToProduce: [],   // pattern-default snapshot lives in itemsCustomText if user edits
    itemsPattern: '',     // pattern key for rehydration in editor
    itemsCustomText: '',
    includeCalecpaSealing: true,
    includeCalecpaAuthenticity: true,
    includeNonDisclosure: true,
    includeNonDisclosureInfoSupport: false,
    includeDelay1546_2a: true,
    nonDisclosureDays: 90,
    orderToSendOverride: null,
    servedAt: null,
    returnedAt: null,
    linkedReturnIds: []
  };
  if (overrides && typeof overrides === 'object') Object.assign(ad, overrides);
  return ad;
}

// ─── factory: new draft ─────────────────────────────────────────────────

// Supported draft.type values. Residential is the v1 California combined
// SW + Affidavit + SOPC face-page format (CSAM / Narcotics / Persons /
// Property). ESP is the legacy multi-business addendum flow.
const DRAFT_TYPES = Object.freeze(['multi-business-esp', 'residential']);

function isResidentialType(t) {
  return t === 'residential';
}

function _defaultTemplateFor(type, jurisdiction) {
  if (type === 'residential') {
    return jurisdiction === 'CA' ? 'ca-residential' : 'ca-residential';
  }
  return jurisdiction === 'CA' ? 'ca-multi-business-esp' : 'generic-us-multi-business-esp';
}

// Crime-type defaults. Kept tiny here — full preset content (T&E paragraph,
// items-to-seize blocks, default optional clauses, SOPC scaffold, default
// PC 1524 grounds toggles) lives in crime-presets.js and is materialised
// by the UI when the user picks a crime. The factory only seeds the
// always-safe blank shell.
function _residentialShell(opts, agency) {
  const crimeType = (opts.crimeType && typeof opts.crimeType === 'string')
    ? opts.crimeType : '';
  return {
    crimeType,                          // 'csam' | 'narcotics' | 'persons' | 'property' | ''
    crimePresetId: crimeType || '',     // tracks preset origin; user can edit fields after
    offenses: [],                       // [{ code: 'PC 311.11', label: '...' }]
    premises: {
      address: '',
      legalDescription: '',
      includeScopeBoilerplate: true,
    },
    suspects: [],                       // [{ name, dob, cdl, descriptors }]
    itemsToSeize: {
      mode: 'preset',                   // 'preset' | 'custom'
      blocks: [],                       // [{ id, label, body }]
    },
    trainingExperience: {
      mode: 'profile',                  // 'profile' (use agency profile T&E) | 'inline'
      inlineBody: '',                   // populated from crime preset on first selection
    },
    sopc: {
      sections: [],                     // [{ heading, body }] — user narrative
    },
    optionalClauses: {
      offsiteComputerSearch: false,
      authorityToDuplicate: false,
      returnExtension: false,
      nightService: { enabled: false, justification: '' },
      hobbsSealing: { enabled: false, justification: '' },
      statutoryGroundsRecap: true,
    },
    itemsIncorporatedByReference: true,
    executedAt: { city: agency.city || '', date: '', time: '', timeAmPm: 'PM' },
  };
}

function newDraft(opts) {
  opts = opts || {};
  const agency = (opts.agencyProfile && typeof opts.agencyProfile === 'object') ? opts.agencyProfile : {};
  const jurisdiction = opts.jurisdiction || agency.state || 'CA';
  const type = DRAFT_TYPES.includes(opts.type) ? opts.type : 'multi-business-esp';
  const template = opts.template || _defaultTemplateFor(type, jurisdiction);
  const now = _nowIso();
  const base = {
    id: _draftId(),
    type,
    template,
    jurisdiction,
    status: 'draft',
    swNumber: opts.swNumber || '',
    caseRef: opts.caseRef || '',
    courtName: agency.defaultCourtName || '',
    county: agency.county || '',
    judgeName: agency.defaultJudgeName || '',
    affiantSnapshot: _snapshotAgency(agency),
    pc1524Grounds: {
      stolen: false, felonyMeans: false, possessedWithIntent: false,
      evidenceOfFelony: false, sexualExploitation: false,
      arrestWarrant: false, ecspMisdemeanor: false, laborCode: false
    },
    hobbsSealing: agency.hobbsSealingDefault || 'not-requested',
    nightSearch: agency.nightSearchDefault || 'not-requested',
    probableCauseNarrative: '',
    tenDayExtensionRequested: false,
    addendums: [],
    pdfPath: '',
    docxPath: '',
    manifestPath: '',
    createdAt: now,
    updatedAt: now
  };
  if (type === 'residential') {
    base.residential = _residentialShell(opts, agency);
  }
  return base;
}

function _snapshotAgency(profile) {
  if (!profile || typeof profile !== 'object') return {};
  return JSON.parse(JSON.stringify(profile));
}

// ─── public CRUD ────────────────────────────────────────────────────────

function listDrafts(caseId) {
  const data = _loadRaw(caseId);
  return Array.isArray(data.drafts) ? data.drafts.slice() : [];
}

function getDraft(caseId, draftId) {
  if (!draftId) return null;
  const drafts = listDrafts(caseId);
  return drafts.find(d => d.id === draftId) || null;
}

function createDraft(caseId, opts) {
  if (!caseId) return null;
  const draft = newDraft(opts);
  const data = _loadRaw(caseId);
  data.drafts.unshift(draft);
  _save(caseId, data);
  return draft;
}

function saveDraft(caseId, draft, opts) {
  if (!caseId || !draft || !draft.id) return false;
  const data = _loadRaw(caseId);
  const idx = data.drafts.findIndex(d => d.id === draft.id);
  draft.updatedAt = _nowIso();
  renumberPageLabels(draft);
  recomputeStatus(draft);
  if (idx === -1) data.drafts.unshift(draft);
  else data.drafts[idx] = draft;
  return _save(caseId, data, opts);
}

function deleteDraft(caseId, draftId) {
  if (!caseId || !draftId) return false;
  const data = _loadRaw(caseId);
  const before = data.drafts.length;
  data.drafts = data.drafts.filter(d => d.id !== draftId);
  if (data.drafts.length === before) return false;
  return _save(caseId, data);
}

function addAddendum(caseId, draftId, overrides) {
  const draft = getDraft(caseId, draftId);
  if (!draft) return null;
  const ad = newAddendum(overrides);
  draft.addendums.push(ad);
  saveDraft(caseId, draft);
  return ad;
}

function removeAddendum(caseId, draftId, addendumId) {
  const draft = getDraft(caseId, draftId);
  if (!draft) return false;
  const before = draft.addendums.length;
  draft.addendums = draft.addendums.filter(a => a.id !== addendumId);
  if (draft.addendums.length === before) return false;
  saveDraft(caseId, draft);
  return true;
}

function updateAddendum(caseId, draftId, addendumId, patch) {
  const draft = getDraft(caseId, draftId);
  if (!draft) return false;
  const idx = draft.addendums.findIndex(a => a.id === addendumId);
  if (idx === -1) return false;
  draft.addendums[idx] = Object.assign({}, draft.addendums[idx], patch || {});
  saveDraft(caseId, draft);
  return true;
}

// ─── status recomputation ───────────────────────────────────────────────

function recomputeStatus(draft) {
  if (!draft) return draft;
  if (draft.status === 'quashed') return draft;

  // Residential drafts have no addendums — status stays draft until the
  // composer marks it finalized. Service / return semantics are tracked
  // on the parent case warrants module, not on the residential draft.
  if (draft.type === 'residential') {
    if (draft.status !== 'finalized') draft.status = 'draft';
    return draft;
  }

  if (!Array.isArray(draft.addendums)) return draft;

  const ads = draft.addendums;
  if (!ads.length) { draft.status = 'draft'; return draft; }

  const served = ads.filter(a => a.servedAt).length;
  const returned = ads.filter(a => a.returnedAt).length;

  if (served === 0) {
    // never served — keep 'draft' unless explicitly finalized
    if (draft.status !== 'finalized') draft.status = 'draft';
    return draft;
  }
  if (returned === ads.length) draft.status = 'fully-returned';
  else if (returned > 0) draft.status = 'partial-return';
  else draft.status = 'served';
  return draft;
}

// ─── selection helpers for Outstanding/Returned views ───────────────────

function listOutstandingAddendums(caseId) {
  const out = [];
  for (const d of listDrafts(caseId)) {
    if (!Array.isArray(d.addendums)) continue;
    for (const ad of d.addendums) {
      if (ad.servedAt && !ad.returnedAt) {
        out.push({ draftId: d.id, draft: d, addendum: ad });
      }
    }
  }
  return out;
}

function listReturnedAddendums(caseId) {
  const out = [];
  for (const d of listDrafts(caseId)) {
    if (!Array.isArray(d.addendums)) continue;
    for (const ad of d.addendums) {
      if (ad.returnedAt) {
        out.push({ draftId: d.id, draft: d, addendum: ad });
      }
    }
  }
  return out;
}

// ─── inflight count for tab badge ───────────────────────────────────────

function inflightCount(caseId) {
  const drafts = listDrafts(caseId);
  let n = 0;
  for (const d of drafts) {
    if (d.status === 'quashed' || d.status === 'fully-returned') continue;
    // Residential drafts contribute 1 each (no addendum fanout).
    if (d.type === 'residential') { n += 1; continue; }
    n += 1 + (Array.isArray(d.addendums) ? d.addendums.length : 0);
  }
  return n;
}

// ─── export ─────────────────────────────────────────────────────────────

const api = Object.freeze({
  SCHEMA_VERSION,
  STORAGE_PREFIX,
  DRAFT_TYPES,
  isResidentialType,
  // factories
  newDraft, newAddendum,
  // CRUD
  listDrafts, getDraft, createDraft, saveDraft, deleteDraft,
  addAddendum, removeAddendum, updateAddendum,
  // sequencers + status
  renumberPageLabels, recomputeStatus,
  // selection helpers
  listOutstandingAddendums, listReturnedAddendums, inflightCount,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorDraftStore = api;
}
})();
