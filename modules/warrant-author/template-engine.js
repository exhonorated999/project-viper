// modules/warrant-author/template-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Slot-aware template engine for the Warrant Author. Pure function — no I/O,
// no DOM, no IPC. Composes the 18-block addendum per plan §5 by walking the
// template's block list and substituting slot placeholders against the
// resolved context (agency profile + provider entry + addendum data +
// items taxonomy).
//
// Block kinds (declarative — each kind has its own resolver):
//   • 'constant'              — verbatim text. No substitution.
//   • 'verbatim-paragraph'    — long-form verbatim text with optional
//                               {{provider.legalName}} / {{provider.name}}
//                               slot interpolation. Used for CalECPA
//                               §1546.1(d)(2) and (d)(3) blocks.
//   • 'label'                 — short heading rendered from a single slot
//                               (e.g. "Page A").
//   • 'provider-block'        — multi-line provider identification block:
//                               legalEntity / address / custodianAttention.
//                               All lines come from the provider entry.
//   • 'target-account'        — list of typed identifiers (handle/email/
//                               phone/UID) from addendum.targets.
//   • 'date-range'            — "from <start> to <end>" or "all available
//                               records" depending on addendum.dateRange.
//   • 'items-to-seize'        — resolves the addendum's itemsPattern via
//                               WarrantAuthorItemsTaxonomy (must be
//                               supplied as ctx.items) into an enumerated
//                               list. Falls back to the provider's
//                               default pattern when addendum lacks one.
//   • 'provider-slot-paragraph' — verbatim text with provider slots
//                               (legal name, custodian email, NDO period).
//                               Used for blocks #10, #12, #15.
//   • 'optional-paragraph'    — verbatim text rendered ONLY when a guard
//                               slot resolves truthy (e.g. NDO supporting
//                               info shown only when addendum.ndoExtended).
//   • 'affiant-contact'       — agency-profile-driven affiant block.
//
// Slot syntax:
//   • {{path.to.value}}       — replaced with the resolved string. Missing
//                               paths leave the {{...}} placeholder intact
//                               so the validator (P7) can flag dangling
//                               slots as a hard error.
//   • {{path | upper}}        — single trailing filter. Filters: upper,
//                               lower, trim. (Kept intentionally tiny; the
//                               template engine is not a programming
//                               language.)
//
// Compose output:
//   compose(template, ctx) → {
//     blocks: [ { key, kind, heading, text, items?, danglingSlots: [...] }, … ],
//     danglingSlots: [ 'addendum.dateRange.end', ... ],   // aggregated
//     missingItems: false | true,
//   }
//
// The composer is intentionally side-effect-free so PDF (P8) and DOCX (P9)
// can share it. The downstream composers walk the `blocks` array and
// translate each kind into pages-elements; no template logic lives in the
// PDF/DOCX layer.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// IIFE wrapper so top-level const/let don't collide with sibling warrant-
// author modules (agency-profile.js, provider-directory.js,
// items-taxonomy.js).
(function () {

const SCHEMA_VERSION = 1;

// ─── SLOT RESOLVER ─────────────────────────────────────────────────────────

// Pull a dotted path out of a context object. Returns undefined if any
// segment is missing. Does NOT throw — the composer wants graceful misses
// so it can record dangling placeholders.
function _lookup(ctx, path) {
  if (!ctx || !path) return undefined;
  const parts = path.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// One-shot filter pipeline. Tiny — three filters cover every case in the
// shipped templates. Add more here as the template library grows.
function _applyFilter(value, filterName) {
  if (value == null) return value;
  const str = String(value);
  switch ((filterName || '').trim().toLowerCase()) {
    case 'upper': return str.toUpperCase();
    case 'lower': return str.toLowerCase();
    case 'trim':  return str.trim();
    default:      return str;  // unknown filter → identity
  }
}

// Match a {{path}} or {{path | filter}} expression. Spaces around the path
// and pipe are tolerated so templates stay readable.
const SLOT_RE = /\{\{\s*([\w.\-]+)(?:\s*\|\s*([\w\-]+))?\s*\}\}/g;

/**
 * Substitute every {{slot}} in `text` against `ctx`. Returns the
 * substituted string AND the list of paths that failed to resolve.
 */
function substituteSlots(text, ctx) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text || '', danglingSlots: [] };
  }
  const dangling = [];
  const out = text.replace(SLOT_RE, (match, path, filter) => {
    const v = _lookup(ctx, path);
    if (v === undefined || v === null || v === '') {
      dangling.push(path);
      return match;  // leave placeholder so the validator (P7) sees it
    }
    return _applyFilter(v, filter);
  });
  return { text: out, danglingSlots: dangling };
}

// ─── BLOCK RESOLVERS ───────────────────────────────────────────────────────
// Each resolver returns the same shape:
//   { key, kind, heading, text, items?, danglingSlots }
// `items` is only set for items-to-seize and target-account blocks.

function _resolveConstant(block) {
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text: block.text || '',
    danglingSlots: [],
  };
}

function _resolveVerbatim(block, ctx) {
  // Pre-evaluate heading + text for {{slot}} substitution.
  const headRes = substituteSlots(block.heading || '', ctx);
  const bodyRes = substituteSlots(block.text || '', ctx);
  return {
    key: block.key,
    kind: block.kind,
    heading: headRes.text,
    text: bodyRes.text,
    danglingSlots: headRes.danglingSlots.concat(bodyRes.danglingSlots),
  };
}

function _resolveLabel(block, ctx) {
  // Label blocks have a single `slot` field instead of inline text.
  const slot = block.slot || '';
  const direct = _lookup(ctx, slot);
  if (direct === undefined || direct === null || direct === '') {
    return {
      key: block.key,
      kind: block.kind,
      heading: '',
      text: `{{${slot}}}`,
      danglingSlots: [slot],
    };
  }
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: String(direct),
    danglingSlots: [],
  };
}

function _resolveProviderBlock(block, ctx) {
  // Pull canonical 5–7 lines from provider entry.
  const provider = ctx.provider || {};
  const lines = [];
  const dangling = [];
  const fields = block.fields || ['legalEntity', 'address', 'custodianAttention'];
  for (const f of fields) {
    const v = provider[f];
    if (v != null && v !== '') lines.push(String(v));
    else if (block.requiredFields && block.requiredFields.indexOf(f) !== -1) {
      dangling.push('provider.' + f);
    }
  }
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text: lines.join('\n'),
    danglingSlots: dangling,
  };
}

function _resolveTargetAccount(block, ctx) {
  // ctx.addendum.targets = [{ type, value, helper }]
  const targets = (ctx.addendum && Array.isArray(ctx.addendum.targets))
    ? ctx.addendum.targets : [];
  const dangling = [];
  if (targets.length === 0) dangling.push('addendum.targets');
  const items = targets
    .filter(t => t && (t.value || '').toString().trim() !== '')
    .map(t => ({
      label: t.type || 'identifier',
      value: String(t.value || ''),
      helper: t.helper || '',
    }));
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text: items.length
      ? items.map(i => `  • ${i.label}: ${i.value}${i.helper ? ` (${i.helper})` : ''}`).join('\n')
      : '{{addendum.targets}}',
    items,
    danglingSlots: dangling,
  };
}

function _resolveDateRange(block, ctx) {
  const range = (ctx.addendum && ctx.addendum.dateRange) || null;
  if (!range) {
    return {
      key: block.key,
      kind: block.kind,
      heading: block.heading || '',
      text: '{{addendum.dateRange}}',
      danglingSlots: ['addendum.dateRange'],
    };
  }
  const { start, end, allAvailable } = range;
  let text;
  if (allAvailable) {
    text = 'For all dates the records exist.';
  } else if (!start || !end) {
    text = '{{addendum.dateRange.start}} — {{addendum.dateRange.end}}';
    return {
      key: block.key,
      kind: block.kind,
      heading: block.heading || '',
      text,
      danglingSlots: [
        !start ? 'addendum.dateRange.start' : null,
        !end ? 'addendum.dateRange.end' : null,
      ].filter(Boolean),
    };
  } else {
    text = `From ${start} through ${end}, inclusive.`;
  }
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text,
    danglingSlots: [],
  };
}

function _resolveItemsToSeize(block, ctx) {
  // ctx.items = WarrantAuthorItemsTaxonomy API
  // Precedence:
  //   1. addendum.itemsToProduce  (explicit user-selected keys)
  //   2. addendum.itemsPattern    (named pattern)
  //   3. provider.itemsPattern    (default for provider)
  const tax = ctx.items;
  if (!tax || typeof tax.resolveForProvider !== 'function') {
    return {
      key: block.key,
      kind: block.kind,
      heading: block.heading || '',
      text: '{{items.unavailable}}',
      items: [],
      danglingSlots: ['items.taxonomy'],
    };
  }
  const provider = ctx.provider || {};
  const userKeys = (ctx.addendum && Array.isArray(ctx.addendum.itemsToProduce))
    ? ctx.addendum.itemsToProduce.filter(Boolean)
    : [];
  const overridePattern = ctx.addendum && ctx.addendum.itemsPattern;
  let list;
  if (userKeys.length && typeof tax.getItem === 'function') {
    list = userKeys.map(k => tax.getItem(k)).filter(Boolean);
  } else if (overridePattern && tax.isPattern(overridePattern) && overridePattern !== 'custom') {
    list = tax.resolvePattern(overridePattern);
  } else {
    list = tax.resolveForProvider(provider);
  }
  const items = list.map(it => ({
    key: it.key,
    label: it.label,
    description: it.description,
    legalBasis: it.legalBasis || '',
  }));
  const dangling = items.length === 0 ? ['items.empty'] : [];
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text: items.length
      ? items.map((it, i) => `  ${String.fromCharCode(97 + i)}. ${it.description}`).join('\n\n')
      : '{{items.empty}}',
    items,
    danglingSlots: dangling,
  };
}

function _resolveProviderSlotParagraph(block, ctx) {
  // Same shape as verbatim-paragraph but typically references provider.* slots.
  return _resolveVerbatim(block, ctx);
}

function _resolveOptional(block, ctx) {
  // Renders text only if guardSlot resolves truthy. Otherwise emits an
  // empty block (still in the output for index stability — composer may
  // skip empty blocks).
  const guard = block.guardSlot;
  const guardVal = guard ? _lookup(ctx, guard) : true;
  if (!guardVal) {
    return {
      key: block.key,
      kind: block.kind,
      heading: '',
      text: '',
      omitted: true,
      danglingSlots: [],
    };
  }
  return _resolveVerbatim(block, ctx);
}

function _resolveAffiantContact(block, ctx) {
  const agency = ctx.agency || {};
  const fields = block.fields || [
    'affiantName', 'affiantBadgeId', 'affiantUnit',
    'affiantPhone', 'affiantEmail',
    'agencyName', 'agencyAddressLine1', 'agencyAddressCityStateZip',
  ];
  const dangling = [];
  const labelMap = block.labels || {
    affiantName: 'Affiant',
    affiantBadgeId: 'Badge / ID',
    affiantUnit: 'Unit',
    affiantPhone: 'Phone',
    affiantEmail: 'Email',
    agencyName: 'Agency',
    agencyAddressLine1: '',
    agencyAddressCityStateZip: '',
  };
  const lines = [];
  for (const f of fields) {
    const v = agency[f];
    if (v != null && v !== '') {
      const label = labelMap[f] || '';
      lines.push(label ? `${label}: ${v}` : String(v));
    } else if (block.requiredFields && block.requiredFields.indexOf(f) !== -1) {
      dangling.push('agency.' + f);
    }
  }
  return {
    key: block.key,
    kind: block.kind,
    heading: block.heading || '',
    text: lines.join('\n'),
    danglingSlots: dangling,
  };
}

// ─── BLOCK DISPATCH TABLE ──────────────────────────────────────────────────
const RESOLVERS = Object.freeze({
  'constant':                _resolveConstant,
  'verbatim-paragraph':      _resolveVerbatim,
  'label':                   _resolveLabel,
  'provider-block':          _resolveProviderBlock,
  'target-account':          _resolveTargetAccount,
  'date-range':              _resolveDateRange,
  'items-to-seize':          _resolveItemsToSeize,
  'provider-slot-paragraph': _resolveProviderSlotParagraph,
  'optional-paragraph':      _resolveOptional,
  'affiant-contact':         _resolveAffiantContact,
});

// ─── COMPOSE ───────────────────────────────────────────────────────────────

/**
 * Compose a template against a context. Returns the rendered block list
 * plus the aggregated set of dangling slot paths so the validator (P7)
 * can hard-block "Generate" when any required slot fails to resolve.
 *
 *   template: { id, name, jurisdiction, version, blocks: [...] }
 *   ctx:      { addendum, agency, provider, items }
 *     addendum: per-addendum data (targets, dateRange, itemsPattern, ...)
 *     agency:   resolved WarrantAuthorAgencyProfile object
 *     provider: resolved provider entry (from mergeProviders)
 *     items:    WarrantAuthorItemsTaxonomy api (the module)
 */
function compose(template, ctx) {
  if (!template || !Array.isArray(template.blocks)) {
    return {
      blocks: [],
      danglingSlots: ['template.invalid'],
      missingItems: true,
    };
  }
  const out = [];
  const allDangling = [];
  let missingItems = false;

  for (const block of template.blocks) {
    const resolver = RESOLVERS[block.kind];
    if (!resolver) {
      out.push({
        key: block.key || '<unknown>',
        kind: block.kind || '<unknown>',
        heading: '',
        text: `{{unknown-block-kind:${block.kind}}}`,
        danglingSlots: [`template.unknownKind:${block.kind}`],
      });
      allDangling.push(`template.unknownKind:${block.kind}`);
      continue;
    }
    const resolved = resolver(block, ctx);
    out.push(resolved);
    if (resolved.danglingSlots && resolved.danglingSlots.length) {
      for (const d of resolved.danglingSlots) allDangling.push(d);
    }
    if (block.kind === 'items-to-seize' && (!resolved.items || resolved.items.length === 0)) {
      missingItems = true;
    }
  }

  return {
    blocks: out,
    danglingSlots: allDangling,
    missingItems,
  };
}

// ─── TEMPLATE REGISTRY ─────────────────────────────────────────────────────
// Templates are JSON files shipped under modules/warrant-author/templates/.
// In Node (main process), they're loaded with require(). In the renderer
// they'll be fetched at first use (P6 wires the renderer-side registry).
// For now the registry exposes register(name, json) so the renderer can
// inject preloaded templates.
const _TEMPLATES = Object.create(null);

function registerTemplate(template) {
  if (!template || !template.id) {
    throw new Error('registerTemplate: template missing id');
  }
  _TEMPLATES[template.id] = template;
  return template;
}

function getTemplate(id) {
  return _TEMPLATES[id] || null;
}

function listTemplates() {
  return Object.keys(_TEMPLATES).map(id => {
    const t = _TEMPLATES[id];
    return {
      id: t.id,
      name: t.name,
      jurisdiction: t.jurisdiction,
      version: t.version,
      blockCount: Array.isArray(t.blocks) ? t.blocks.length : 0,
    };
  });
}

// Auto-load shipped templates in Node (CommonJS) context. The renderer
// must call registerTemplate() with preloaded JSON via an IPC bridge or
// fetch() — the engine itself doesn't reach for disk.
if (typeof require === 'function' && typeof module !== 'undefined') {
  try {
    const path = require('path');
    const fs = require('fs');
    const tplDir = path.join(__dirname, 'templates');
    if (fs.existsSync(tplDir)) {
      const files = fs.readdirSync(tplDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(tplDir, f), 'utf8');
          const json = JSON.parse(raw);
          registerTemplate(json);
        } catch (e) {
          // Silently skip malformed templates — main-process logs them
          // when the validator (P7) reports a missing template.
        }
      }
    }
  } catch (_) { /* require() unavailable — skip */ }
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────
const api = Object.freeze({
  SCHEMA_VERSION,
  compose,
  substituteSlots,
  registerTemplate,
  getTemplate,
  listTemplates,
  // exposed for tests + downstream composers
  RESOLVERS,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorTemplateEngine = api;
}

})();
