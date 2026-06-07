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
};

function _selectDraft(caseId, draftId) {
  _state.caseId = caseId;
  _state.activeDraftId = draftId;
  const d = _store() ? _store().getDraft(caseId, draftId) : null;
  _state.activeAddendumId = (d && d.addendums && d.addendums[0]) ? d.addendums[0].id : null;
  _state.view = 'editor';
  _state.caOptionsOpen = undefined;  // each new draft starts with options panel open
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

function _renderNewDraftModal(caseId) {
  const agency = _loadAgencyProfile();
  const jurisdiction = agency && agency.state ? agency.state : 'CA';
  const isCA = jurisdiction === 'CA';
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
            <span class="text-slate-400 text-xs uppercase tracking-wider">Template</span>
            <select id="waNewTemplate" class="mt-1 w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded text-white focus:border-viper-cyan focus:outline-none">
              <option value="ca-multi-business-esp" ${isCA ? 'selected' : ''}>CA — Multi-Business ESP (CalECPA §1546.1)</option>
              <option value="generic-us-multi-business-esp" ${!isCA ? 'selected' : ''}>US Generic — Multi-Business ESP (SCA §2703)</option>
            </select>
            <span class="block text-[11px] text-slate-500 mt-1">Default derived from Agency Profile state = <code>${attr(jurisdiction)}</code>.</span>
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
    const adCount = Array.isArray(d.addendums) ? d.addendums.length : 0;
    const updated = _shortDate(d.updatedAt);
    const providers = (d.addendums || []).map(a => a.providerKey || 'unset').filter(Boolean).slice(0, 4).join(', ') || '—';
    return `
      <div class="wa-draft-row">
        <div class="flex-1 min-w-0 cursor-pointer" onclick="WarrantAuthorUI.bus.onOpenDraft('${attr(caseId)}','${attr(d.id)}')">
          <div class="flex items-center gap-2 mb-1">
            ${_statusBadge(d.status)}
            <span class="text-white font-medium truncate">${esc(d.swNumber || d.caseRef || 'Untitled draft')}</span>
            <span class="text-slate-500 text-xs">·</span>
            <span class="text-slate-400 text-xs">${esc(d.template === 'ca-multi-business-esp' ? 'CA' : 'US')}</span>
          </div>
          <div class="flex items-center gap-3 text-xs text-slate-400">
            <span><span class="text-viper-cyan font-mono">${adCount}</span> addendum${adCount === 1 ? '' : 's'}</span>
            <span class="truncate">${esc(providers)}</span>
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

// ─── 2-pane editor ──────────────────────────────────────────────────────

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
    { v: 'generic-us-multi-business-esp', label: 'US Generic — SCA §2703' },
  ];
  // Probable cause now lives on the Warrant Author screen header (above the
  // subtab pills). Show a compact reference here pointing back up to it.
  const pcStore = (typeof window !== 'undefined') ? window.WarrantAuthorCasePcStore : null;
  const pcStats = pcStore ? pcStore.stats(caseId) : { chars: 0, words: 0, updatedAt: null };
  const hasPc = pcStats.chars > 0;
  return `
    <div class="grid grid-cols-2 gap-3 p-3 bg-viper-dark/60 border border-slate-700 rounded-lg">
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Court Name</span>
        <input type="text" value="${attr(draft.courtName)}"
               onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','courtName',this.value)"
               class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
      </label>
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Template</span>
        <select onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','template',this.value)"
                class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
          ${tplOpts.map(o => `<option value="${attr(o.v)}" ${o.v === draft.template ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>

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
  `;
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
  try {
    return V.validateDraft({
      draft,
      agency: agencyProfile,
      providers: providersMerged,
      pcNarrative,
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
      <div class="grid grid-cols-2 gap-2">
        <label class="block text-xs">
          <span class="text-slate-400 uppercase tracking-wider">From</span>
          <input type="date" value="${attr(ad.dateRangeFrom)}"
                 min="1900-01-01" max="2100-12-31"
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeFrom',this.value)"
                 class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
        </label>
        <label class="block text-xs">
          <span class="text-slate-400 uppercase tracking-wider">To</span>
          <input type="date" value="${attr(ad.dateRangeTo)}"
                 min="1900-01-01" max="2100-12-31"
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeTo',this.value)"
                 class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
        </label>
      </div>

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
          <span class="text-slate-400 uppercase tracking-wider text-xs">Items to Produce</span>
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

      <!-- Optional clauses -->
      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" ${ad.includeNonDisclosure ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeNonDisclosure',this.checked)">
          NDO (90-day)
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" ${ad.includeNonDisclosureInfoSupport ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeNonDisclosureInfoSupport',this.checked)">
          NDO Info-Support
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" ${ad.includeDelay1546_2a ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeDelay1546_2a',this.checked)">
          Delay (§1546.2(a))
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" ${ad.includeCalecpaSealing ? 'checked' : ''}
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','includeCalecpaSealing',this.checked)">
          §1546.1(d)(3) Sealing
        </label>
      </div>
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
  });

  const ctx = {
    addendum: adForEngine,
    provider: provider || { key: ad.providerKey, name: ad.providerKey || '(no provider)' },
    items, // taxonomy API module
    affiant: draft.affiantSnapshot || {},
    agency:  draft.affiantSnapshot || {},
    draft,
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
      body = `<ol class="wa-pv-list">${b.items.map(it => `<li><span class="wa-pv-item-label">${esc(it.label || it.key)}</span>${it.description ? ` — <span class="wa-pv-item-desc">${esc(it.description)}</span>` : ''}</li>`).join('')}</ol>`;
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
      <div class="wa-pv-title">Live Preview — ${esc(draft.template === 'ca-multi-business-esp' ? 'CA template' : 'US template')} · Page ${esc(ad.pageLabel)}</div>
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
            Template: <span class="text-slate-300 font-mono">${esc(draft.template === 'ca-multi-business-esp' ? 'CA · CalECPA' : 'US · SCA §2703')}</span>
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
    if (ov) ov.innerHTML = _renderNewDraftModal(caseId);
  },
  onCloseNewDraftModal() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) ov.innerHTML = '';
  },
  onCreateDraftConfirm(caseId) {
    const ds = _store(); if (!ds) return;
    let ref = (document.getElementById('waNewCaseRef') || {}).value || '';
    // Fall back to the running case number if the user cleared the input.
    if (!String(ref).trim()) {
      ref = (window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '';
    }
    const tpl = (document.getElementById('waNewTemplate') || {}).value || 'ca-multi-business-esp';
    const agency = _loadAgencyProfile();
    const draft = ds.createDraft(caseId, {
      swNumber: '', caseRef: ref, template: tpl,
      jurisdiction: tpl.startsWith('ca-') ? 'CA' : 'US',
      agencyProfile: agency
    });
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
    ds.saveDraft(caseId, d);
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
    ds.saveDraft(caseId, d);
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
    ds.saveDraft(caseId, d);
    _rerender();
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
            ds.saveDraft(caseId, d);
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
    ds.saveDraft(caseId, d);
    _rerender();
  },
  onAddendumFieldChange(caseId, draftId, addendumId, field, value) {
    const ds = _store(); if (!ds) return;
    // Normalize date fields — Chromium's <input type="date"> happily accepts
    // 2-digit years and stores them as literal years 25 / 0025 etc. Sanitize.
    if (field === 'dateRangeFrom' || field === 'dateRangeTo') {
      value = _normalizeDateValue(value);
    }
    ds.updateAddendum(caseId, draftId, addendumId, { [field]: value });
    _rerender();
  },

  /**
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
    const engine = _engine();
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
      const vres = V.validateDraft({
        draft,
        agency: agencyProfile,
        providers: providers0,
        pcNarrative: pcNarrative0,
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
      });
      const ctx = {
        addendum: adForEngine,
        provider,
        items,
        affiant: draft.affiantSnapshot || {},
        agency:  draft.affiantSnapshot || {},
        draft,
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

    // 4. Persist to disk via IPC (PDF bytes + DOCX built in main)
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
        } catch (e) {
          saveResult = { success: false, error: e.message };
        }
      } else {
        saveResult = { success: false, error: 'No case number available — cannot persist to disk.' };
      }
    }

    // 5. Show result modal
    _state._genPdfBlob = pdfResult.blob;
    _state._genFilename = (draft.caseRef || 'warrant') + '_' + (draft.template === 'ca-multi-business-esp' ? 'CA' : 'US');
    _state._genPageCount = pdfResult.pageCount;
    _state._genSave = saveResult;
    _showGenerateResultModal(caseId, draft, blockStream, issues, pdfResult, saveResult);
  },
  onCloseGenerateModal() {
    const ov = document.getElementById('waModalOverlay');
    if (ov) ov.innerHTML = '';
    _state._genPdfBlob = null;
    _state._genFilename = null;
    _state._genPageCount = null;
    _state._genSave = null;
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
    ds.saveDraft(caseId, d);
    _rerender();
  },
  onRemoveTarget(caseId, draftId, addendumId, idx) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    ad.targetAccounts = (ad.targetAccounts || []).filter((_, i) => i !== idx);
    ds.saveDraft(caseId, d);
    _rerender();
  },
  onTargetFieldChange(caseId, draftId, addendumId, idx, field, value) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    if (!ad.targetAccounts[idx]) return;
    ad.targetAccounts[idx][field] = value;
    ds.saveDraft(caseId, d);
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
    ds.saveDraft(caseId, d);
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
    ds.saveDraft(caseId, d);
    _rerender();
  },
  onToggleItem(caseId, draftId, addendumId, itemKey, checked) {
    const ds = _store(); if (!ds) return;
    const d = ds.getDraft(caseId, draftId); if (!d) return;
    const ad = d.addendums.find(a => a.id === addendumId); if (!ad) return;
    const set = new Set(ad.itemsToProduce || []);
    if (checked) set.add(itemKey); else set.delete(itemKey);
    ad.itemsToProduce = Array.from(set);
    ds.saveDraft(caseId, d);
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
