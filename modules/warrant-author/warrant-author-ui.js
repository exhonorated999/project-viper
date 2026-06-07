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
};

function _selectDraft(caseId, draftId) {
  _state.caseId = caseId;
  _state.activeDraftId = draftId;
  const d = _store() ? _store().getDraft(caseId, draftId) : null;
  _state.activeAddendumId = (d && d.addendums && d.addendums[0]) ? d.addendums[0].id : null;
  _state.view = 'editor';
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
            <span class="text-slate-400 text-xs uppercase tracking-wider">SW Number (optional)</span>
            <input id="waNewSwNumber" type="text" class="mt-1 w-full px-3 py-2 bg-viper-darker border border-slate-700 rounded text-white"
                   placeholder="SW-2026-0001">
          </label>
          <label class="block">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Case Ref (optional)</span>
            <input id="waNewCaseRef" type="text" class="mt-1 w-full px-3 py-2 bg-viper-darker border border-slate-700 rounded text-white"
                   placeholder="${attr((window.currentCase && (window.currentCase.caseNumber || window.currentCase.number)) || '')}">
          </label>
          <label class="block">
            <span class="text-slate-400 text-xs uppercase tracking-wider">Template</span>
            <select id="waNewTemplate" class="mt-1 w-full px-3 py-2 bg-viper-darker border border-slate-700 rounded text-white">
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
            <span class="text-white font-medium truncate">${esc(d.swNumber || '(no SW number)')}</span>
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
          <span class="text-white font-medium truncate">${esc(draft.swNumber || '(no SW number)')}</span>
          ${_statusBadge(draft.status)}
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-slate-500">P6 stub — PDF/DOCX in P8/P9</span>
        </div>
      </div>

      <!-- draft-level fields -->
      ${_renderDraftHeader(caseId, draft)}

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
  return `
    <div class="grid grid-cols-2 gap-3 p-3 bg-viper-darker/60 border border-slate-700 rounded-lg">
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">SW Number</span>
        <input type="text" value="${attr(draft.swNumber)}"
               onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','swNumber',this.value)"
               class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm font-mono">
      </label>
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Template</span>
        <select onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','template',this.value)"
                class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
          ${tplOpts.map(o => `<option value="${attr(o.v)}" ${o.v === draft.template ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Court Name</span>
        <input type="text" value="${attr(draft.courtName)}"
               onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','courtName',this.value)"
               class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
      </label>
      <label class="text-xs">
        <span class="text-slate-400 uppercase tracking-wider">Judge (optional)</span>
        <input type="text" value="${attr(draft.judgeName)}"
               onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','judgeName',this.value)"
               class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
      </label>
      <label class="text-xs col-span-2">
        <span class="text-slate-400 uppercase tracking-wider">Probable Cause Narrative</span>
        <textarea rows="3"
                  onchange="WarrantAuthorUI.bus.onDraftFieldChange('${attr(caseId)}','${attr(draft.id)}','probableCauseNarrative',this.value)"
                  class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm font-mono leading-snug"
                  placeholder="Brief facts supporting probable cause (validator will surface this as a hard-error when empty).">${esc(draft.probableCauseNarrative)}</textarea>
      </label>
    </div>
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
                 onchange="WarrantAuthorUI.bus.onAddendumFieldChange('${attr(caseId)}','${attr(draft.id)}','${attr(ad.id)}','dateRangeFrom',this.value)"
                 class="mt-1 w-full px-2 py-1.5 bg-viper-dark border border-slate-700 rounded text-white text-sm">
        </label>
        <label class="block text-xs">
          <span class="text-slate-400 uppercase tracking-wider">To</span>
          <input type="date" value="${attr(ad.dateRangeTo)}"
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
        ${autofill ? `<div class="mt-2 p-2 bg-viper-darker/40 border border-slate-700 rounded">
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
        <div class="max-h-40 overflow-y-auto pr-1 grid grid-cols-2 gap-1 p-2 bg-viper-darker/40 border border-slate-700 rounded">
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

  // resolve items
  const items = _items();
  const itemKeys = (ad.itemsToProduce && ad.itemsToProduce.length)
    ? ad.itemsToProduce
    : (items && ad.providerKey ? items.resolvePatternKeys(items.defaultPatternFor(ad.providerKey)) : []);
  const resolvedItems = items ? itemKeys.map(k => items.getItem(k)).filter(Boolean) : [];

  const ctx = {
    addendum: ad,
    provider: provider || { key: ad.providerKey, name: ad.providerKey || '(no provider)' },
    items: resolvedItems,
    affiant: draft.affiantSnapshot || {},
    agency: draft.affiantSnapshot || {},
    draft,
  };

  let result;
  try {
    result = engine.compose(tpl, ctx);
  } catch (err) {
    return `<div class="wa-preview"><div class="wa-empty-mini text-rose-300 text-sm">Preview error: ${esc(err.message)}</div></div>`;
  }

  const blocks = (result && result.blocks) || [];
  const dangling = (result && result.danglingSlots) || [];
  const missingItems = (result && result.missingItems) || [];

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

  const issuesBar = (dangling.length || missingItems.length) ? `
    <div class="wa-pv-issues">
      ${dangling.length ? `<div class="wa-pv-issue">⚠ ${dangling.length} dangling slot${dangling.length===1?'':'s'}: <span class="font-mono text-[10px]">${esc(dangling.slice(0,6).join(', '))}${dangling.length>6 ? '…' : ''}</span></div>` : ''}
      ${missingItems.length ? `<div class="wa-pv-issue">⚠ ${missingItems.length} unknown item${missingItems.length===1?'':'s'}: <span class="font-mono text-[10px]">${esc(missingItems.slice(0,6).join(', '))}</span></div>` : ''}
    </div>
  ` : '';

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
              <span class="text-slate-400 text-xs">SW: ${esc(draft.swNumber || '—')}</span>
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
              <span class="text-slate-400 text-xs">SW: ${esc(draft.swNumber || '—')}</span>
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
    const sw = (document.getElementById('waNewSwNumber') || {}).value || '';
    const ref = (document.getElementById('waNewCaseRef') || {}).value || '';
    const tpl = (document.getElementById('waNewTemplate') || {}).value || 'ca-multi-business-esp';
    const agency = _loadAgencyProfile();
    const draft = ds.createDraft(caseId, {
      swNumber: sw, caseRef: ref, template: tpl,
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
    ds.updateAddendum(caseId, draftId, addendumId, { [field]: value });
    _rerender();
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
  harvestIdentifiers,
  // internal state surface for the host page
  _state,
  bus,
});

if (typeof window !== 'undefined') {
  window.WarrantAuthorUI = api;
}
})();
