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
    style: block.style || '',
    text: items.length ? _formatItemsText(items, block.style) : '{{items.empty}}',
    items,
    danglingSlots: dangling,
  };
}

/**
 * Renders the resolved item list as text for the three supported styles:
 *   'semicolons'  one item per line, `;`-terminated, last one `.` (CO)
 *   'prose'       ONE flowing line, `; `-joined, `.`-terminated (AR) — the
 *                 Arkansas exemplar prints the records request as running
 *                 prose rather than an enumerated list.
 *   (default)     lettered list `a. …` separated by a blank line (CA/VA/US)
 * Pure — no side effects, safe to call from either process.
 */
function _formatItemsText(items, style) {
  const bodies = items
    .map(it => String(it.description || it.label || '').trim())
    .filter(Boolean)
    .map(b => b.replace(/[.;]?\s*$/, ''));
  if (!bodies.length) return '{{items.empty}}';
  if (style === 'prose') {
    return bodies.join('; ') + '.';
  }
  if (style === 'semicolons') {
    return bodies.map((b, i) => b + (i === bodies.length - 1 ? '.' : ';')).join('\n');
  }
  return items
    .map((it, i) => `  ${String.fromCharCode(97 + i)}. ${it.description}`)
    .join('\n\n');
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

// ─── CO-SPECIFIC RESOLVERS ─────────────────────────────────────────────────
// The CO Multi-Business ESP template emits a single combined document
// (Affidavit + Search Warrant and Court Order). These resolvers handle
// the layout-only block kinds the template adds. They do NOT format the
// final output — the block-builder's CO branch does that, using the
// substituted text + the per-kind metadata preserved here.

function _resolveCoCaption(block, ctx) {
  // ctx.court  = { name, judicialDistrict, county }   (from agency profile)
  // ctx.case   = { number, ... }                       (from draft / case info)
  const court = ctx.court || {};
  const cs = ctx.case || {};
  const dangling = [];
  const name = String(court.name || '').trim() || 'COUNTY/DISTRICT COURT';
  const jd = String(court.judicialDistrict || '').trim();
  const titleRes = substituteSlots(block.documentTitle || '', ctx);
  if (!jd) dangling.push('court.judicialDistrict');
  if (!cs.number) dangling.push('case.number');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    // Carry structured fields for the block-builder. (Composers read
    // resolved.* fields by name when they need them.)
    courtName: name,
    judicialDistrict: jd,
    county: String(court.county || '').trim(),
    caseNumber: String(cs.number || '').trim(),
    documentTitle: titleRes.text,
    danglingSlots: dangling.concat(titleRes.danglingSlots || []),
  };
}

function _resolveCoProviderBlock(block, ctx) {
  // Concatenates: legalEntity → custodian (c/o) → ATTN → address lines →
  // Registered Agent: → coRegisteredAgent → coRegisteredAgentAddress lines →
  // Service provided via portal at <portalUrl>.
  const provider = ctx.provider || {};
  const dangling = [];
  const lines = [];

  // Primary custodian block
  const legalEntity = String(provider.legalEntity || '').trim();
  if (legalEntity) lines.push(legalEntity);
  else dangling.push('provider.legalEntity');

  // "c/o" line — name shown if provider has a display name distinct from
  // legalEntity (e.g. "Cash App" → "c/o Block, Inc."). Optional.
  const displayName = String(provider.name || '').trim();
  if (displayName && legalEntity && displayName.toLowerCase() !== legalEntity.toLowerCase()) {
    // Show "c/o {legalEntity}" beneath the display name. But we've already
    // pushed legalEntity above; instead replace with the display name and
    // add c/o.
    lines[0] = displayName;
    lines.push('c/o ' + legalEntity);
  }

  const custodian = String(provider.custodianAttention || '').trim();
  if (custodian) lines.push('ATTN: ' + custodian);

  const address = String(provider.address || '').trim();
  if (address) {
    // Address may be a single line or multi-line. Split on \n for display.
    address.split(/\r?\n/).forEach(ln => { const t = ln.trim(); if (t) lines.push(t); });
  } else {
    dangling.push('provider.address');
  }

  // Registered Agent section (CO requirement for out-of-state ESPs).
  const agent = String(provider.coRegisteredAgent || '').trim();
  const agentAddr = String(provider.coRegisteredAgentAddress || '').trim();
  if (agent || agentAddr) {
    lines.push('Registered Agent:');
    if (agent) lines.push(agent);
    if (agentAddr) {
      agentAddr.split(/\r?\n/).forEach(ln => { const t = ln.trim(); if (t) lines.push(t); });
    }
  } else {
    // Soft warning — many CO templates DO include the registered agent.
    // Not a hard dangle; the affiant can omit if the provider has none.
  }

  // Portal line (verbatim phrasing from CO samples).
  const portal = String(provider.portalUrl || '').trim();
  if (portal) lines.push('Service provided via portal at ' + portal);

  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: lines.join('\n'),
    danglingSlots: dangling,
  };
}

function _resolveCoAffiantSignature(block, ctx) {
  // "Subscribed and Sworn to in the [N]th Judicial District, Colorado" +
  // signature line.
  const court = ctx.court || {};
  const jd = String(court.judicialDistrict || '').trim();
  const dangling = jd ? [] : ['court.judicialDistrict'];
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    judicialDistrict: jd,
    danglingSlots: dangling,
  };
}

function _resolveCoJudgeOathAffidavit(block, ctx) {
  // "Subscribed under oath before me on this ___ day of ___, 20__ in
  // the [N]th Judicial District, CO" + signature + printed name lines.
  const court = ctx.court || {};
  const jd = String(court.judicialDistrict || '').trim();
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    judicialDistrict: jd,
    danglingSlots: jd ? [] : ['court.judicialDistrict'],
  };
}

function _resolveCoJudgeSignature(block, ctx) {
  // Date / In the [N]th Judicial District, Colorado / Signature of Judge /
  // Printed Name of Judge.
  const court = ctx.court || {};
  const jd = String(court.judicialDistrict || '').trim();
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    judicialDistrict: jd,
    danglingSlots: jd ? [] : ['court.judicialDistrict'],
  };
}

function _resolveCoDaApproval(block, ctx) {
  // APPROVED AS TO FORM:
  // {{agency.daName}}
  // {{agency.daTitle}}
  // By /s
  // {{agency.daDeputyLine}}
  const agency = ctx.agency || {};
  const dangling = [];
  const daName = String(agency.daName || '').trim();
  const daTitle = String(agency.daTitle || 'District Attorney').trim();
  const daDeputy = String(agency.daDeputyLine || '[Chief][Senior] Deputy District Attorney').trim();
  if (!daName) dangling.push('agency.daName');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    daName,
    daTitle,
    daDeputyLine: daDeputy,
    danglingSlots: dangling,
  };
}

// ─── AR-SPECIFIC RESOLVERS ─────────────────────────────────────────────────
// The AR Circuit Court ESP template emits a single combined document
// (Affidavit for Search Warrant to Provide Records + Search Warrant to
// Provide Records), modelled verbatim on a Faulkner County exemplar.
// Layout-only kinds; the block-builder's AR branch renders them.
//
// Deliberate omissions, per the examiner:
//   • No judge name anywhere. The issuing judge signs/stamps by hand, so
//     the judge block prints a blank signature line + court + division.
//   • No statutory citations. The exemplar carries none.

// Splits a single-line provider mailing address into the discrete
// Address / City / State / Zip lines the AR warrant page prints.
// Conservative: only splits when the tail actually looks like
// "<city>, <ST> <zip>". Otherwise the whole string stays on Address:
// (a wrong split on a warrant is worse than an unsplit one).
const AR_ADDRESS_TAIL_RE = /^(.*),\s*([^,]+),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/;

function _splitUsAddress(raw) {
  const flat = String(raw || '').replace(/\r?\n/g, ', ').replace(/\s+/g, ' ').trim();
  if (!flat) return { street: '', city: '', state: '', zip: '' };
  const m = AR_ADDRESS_TAIL_RE.exec(flat);
  if (!m) return { street: flat, city: '', state: '', zip: '' };
  return {
    street: m[1].trim(),
    city: m[2].trim(),
    state: m[3].toUpperCase(),
    zip: m[4].trim(),
  };
}

// Resolves the county used by the AR caption + judge block. The AR
// template has no multi-court list (an Arkansas sheriff's office sits in
// one county); ctx.court is populated by the UI from the agency profile,
// with the raw profile as a fallback so a bare ctx still resolves.
function _arCounty(ctx) {
  const court = ctx.court || {};
  const agency = ctx.agency || {};
  return String(court.county || agency.county || '').trim();
}

function _arDivision(ctx) {
  const court = ctx.court || {};
  const agency = ctx.agency || {};
  return String(court.division || agency.arCircuitDivision || '').trim();
}

// ONE WARRANT, MANY ADDENDUMS (5.2.1).
//
// The Arkansas document is a single affidavit + single warrant with one
// Addendum page per Electronic Service Provider. The caption's third
// column and the two "addendum index" blocks therefore need the WHOLE
// provider list, not just the addendum currently being composed.
//
// `ctx.addendums` is that list — `[{pageLabel, providerName, businessName,
// providerKey}]`, supplied by the UI at BOTH compose sites. When it is
// absent (a bare ctx, an older caller, a single-addendum harness) we
// degrade to a one-entry list built from `ctx.provider` + `ctx.addendum`
// so the block still renders something truthful rather than dangling.
function _arAddendumList(ctx) {
  const raw = Array.isArray(ctx.addendums) ? ctx.addendums : null;
  if (raw && raw.length) {
    return raw.map((a, i) => ({
      pageLabel:    String((a && a.pageLabel) || _arFallbackLabel(i)).trim(),
      providerName: String((a && (a.providerName || a.provider || a.providerKey)) || '').trim(),
      businessName: String((a && a.businessName) || '').trim(),
    })).filter(e => e.providerName);
  }
  const provider = ctx.provider || {};
  const addendum = ctx.addendum || {};
  const name = String(provider.legalEntity || provider.name || '').trim();
  if (!name) return [];
  return [{
    pageLabel:    String(addendum.pageLabel || 'A').trim(),
    providerName: name,
    businessName: String(addendum.businessName || '').trim(),
  }];
}

// Mirrors draft-store.js _pageLabelFor: A..Z then AA, AB, ...
function _arFallbackLabel(idx) {
  let n = Number(idx) || 0;
  let out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

function _resolveArCaption(block, ctx) {
  // IN THE CIRCUIT COURT OF THE STATE OF ARKANSAS
  // FOR THE COUNTY OF <COUNTY>
  // STATE OF ARKANSAS   )  <documentTitle line 1>
  //                     )  <documentTitle line 2>
  // COUNTY OF <COUNTY>  )  <PROVIDER>[, <PROVIDER>...]
  //
  // Third column lists EVERY provider attached to the warrant, comma
  // separated, because this is one warrant covering all addendums.
  const dangling = [];
  const county = _arCounty(ctx);
  if (!county) dangling.push('court.county');
  const titleRes = substituteSlots(block.documentTitle || '', ctx);
  const list = _arAddendumList(ctx);
  const providerLine = list.map(e => e.providerName).join(', ');
  if (!providerLine) dangling.push('provider.name');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    county,
    documentTitle: titleRes.text,
    providerLine,
    danglingSlots: dangling.concat(titleRes.danglingSlots || []),
  };
}

function _resolveArAddendumIndex(block, ctx) {
  // <lead sentence>
  //     Addendum A: Google LLC
  //     Addendum B: Meta Platforms, Inc.
  //
  // Used TWICE in the AR template: once as "RECORDS TO BE PROVIDED"
  // (which says, in effect, see the attached addendums) and once on the
  // warrant page as the ordered-parties list. Only the lead differs, so
  // it comes off the block.
  const dangling = [];
  const leadRes = substituteSlots(block.lead || '', ctx);
  const list = _arAddendumList(ctx);
  if (!list.length) dangling.push('provider.name');
  const entries = list.map(e => ({
    label: 'Addendum ' + e.pageLabel,
    providerName: e.providerName,
    businessName: e.businessName,
  }));
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    lead: leadRes.text,
    entries,
    danglingSlots: dangling.concat(leadRes.danglingSlots || []),
  };
}

function _resolveArProviderOrderBlock(block, ctx) {
  // The following party is ordered: Online Service: <name>
  // Address:      <street>
  // City:         <city>
  // State:        <ST>
  // Zip Code:     <zip>
  // Phone Number: <phone>
  // Email:        <email>
  //
  // `block.lead` overrides the sentence that precedes the provider name.
  // The warrant page uses the default ordering language; the Addendum page
  // reuses the same discrete Address/City/State/Zip layout but must NOT
  // repeat "The following party is ordered", so it sets lead:"Online
  // Service:". Empty/absent => default.
  const provider = ctx.provider || {};
  const dangling = [];
  const name = String(provider.legalEntity || provider.name || '').trim();
  if (!name) dangling.push('provider.name');
  const rawAddress = String(provider.address || '').trim();
  if (!rawAddress) dangling.push('provider.address');
  const parts = _splitUsAddress(rawAddress);
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    lead: String(block.lead || '').trim(),
    providerName: name,
    street: parts.street,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,
    phone: String(provider.phone || '').trim(),
    email: String(provider.email || '').trim(),
    danglingSlots: dangling,
  };
}

function _resolveArAffiantSignature(block, ctx) {
  // Blank signature line, then the affiant's rank/name and agency.
  const agency = ctx.agency || {};
  const dangling = [];
  const rank = String(agency.affiantRank || '').trim();
  const name = String(agency.affiantName || '').trim();
  if (!name) dangling.push('agency.affiantName');
  const agencyName = String(agency.agencyName || '').trim();
  if (!agencyName) dangling.push('agency.agencyName');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    affiantRank: rank,
    affiantName: name,
    agencyName,
    danglingSlots: dangling,
  };
}

function _resolveArJudgeBlock(block, ctx) {
  // Blank signature line (the judge stamps/signs), then:
  //   <County> County Circuit Court
  //   <N> Division
  // NO judge name — deliberate.
  const county = _arCounty(ctx);
  const division = _arDivision(ctx);
  const dangling = [];
  if (!county) dangling.push('court.county');
  if (!division) dangling.push('court.division');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    county,
    division,
    danglingSlots: dangling,
  };
}

function _resolvePageBreak(block) {
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    danglingSlots: [],
  };
}

// ─── TX-SPECIFIC RESOLVERS ─────────────────────────────────────────────────
// Texas Warrant for Electronic Customer Data (CCP Art. 18B.354-18B.357) +
// Affidavit and Application, modelled on a Texas municipal department's
// ESP exemplars. Layout-only kinds; block-builder._buildTxEsp renders them.
// Nothing agency-specific is hard-coded: county, agency name, affiant
// name/rank/badge/email all come from the agency profile.

const TX_TARGET_LABELS = Object.freeze({
  'esp-user-id': 'Account ID',
  'user-id': 'Account ID',
  'uid': 'Account ID',
  'account-id': 'Account ID',
  'email': 'email',
  'phone': 'phone number',
  'username': 'username',
  'handle': 'username',
  'screen-name': 'screen name',
  'ip': 'IP address',
});

const TX_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "2017-01-01" → "January 1, 2017". Anything else passes through verbatim
// (the warrant never rewrites what the affiant typed).
function _txLongDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return s;
  return `${TX_MONTHS[mo - 1]} ${Number(m[3])}, ${m[1]}`;
}

function _txCounty(ctx) {
  return _arCounty(ctx);
}

function _txProviderName(ctx) {
  const p = ctx.provider || {};
  return String(p.name || p.legalEntity || '').trim();
}

function _txFax(provider) {
  const direct = String((provider && provider.fax) || '').trim();
  if (direct) return direct;
  const m = /\bfax[:\s]*([+()\d][\d\s().\-]{6,}\d)/i.exec(String((provider && provider.notes) || ''));
  return m ? m[1].trim() : '';
}

function _resolveTxCaption(block, ctx) {
  // Warrant:   THE STATE OF TEXAS  §
  //            COUNTY OF <COUNTY>  §   COURT: ____ DISTRICT COURT
  // Affidavit: THE STATE OF TEXAS  §   IN THE DISTRICT COURT IN
  //            COUNTY OF <COUNTY>  §   AND FOR <COUNTY> COUNTY, TEXAS
  const county = _txCounty(ctx);
  const dangling = county ? [] : ['court.county'];
  const C = (county || '__________').toUpperCase();
  const draft = ctx.draft || {};
  const courtNo = String(draft.txDistrictCourt || '').trim();
  const variant = block.variant === 'affidavit' ? 'affidavit' : 'warrant';
  const rows = variant === 'affidavit'
    ? [
        { left: 'THE STATE OF TEXAS', right: 'IN THE DISTRICT COURT IN' },
        { left: `COUNTY OF ${C}`, right: `AND FOR ${C} COUNTY, TEXAS` },
      ]
    : [
        { left: 'THE STATE OF TEXAS', right: '' },
        { left: `COUNTY OF ${C}`, right: `COURT: ${courtNo || '________'} DISTRICT COURT` },
      ];
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    variant,
    county,
    rows,
    danglingSlots: dangling,
  };
}

function _resolveTxProviderBlock(block, ctx) {
  // Centered, bold: name / mailing address / "Phone: … / Fax: … / email".
  const provider = ctx.provider || {};
  const dangling = [];
  const name = String(provider.legalEntity || provider.name || '').trim();
  if (!name) dangling.push('provider.name');
  const lines = [];
  if (name) lines.push(name);
  const address = String(provider.address || '').replace(/\s*\r?\n\s*/g, ', ').trim();
  if (address) lines.push(address);
  else dangling.push('provider.address');
  const contact = [];
  const phone = String(provider.phone || '').trim();
  const fax = _txFax(provider);
  const email = String(provider.email || '').trim();
  if (phone) contact.push('Phone: ' + phone);
  if (fax) contact.push('Fax: ' + fax);
  if (email) contact.push(email);
  if (contact.length) lines.push(contact.join(' / '));
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: lines.join('\n'),
    lines,
    danglingSlots: dangling,
  };
}

// "Records pertaining to: <Provider> Account ID X and/or email Y from
// January 1, 2017 to February 1, 2017:" + one bullet per record type +
// a bold closing bullet "Provide Records to <rank> <name> at email address
// <email>". addendum.recordsPertainingTo replaces the generated sentence
// when the affiant needs the exemplar's free-form wording ("... AND any
// account that has messaged ...").
function _resolveTxRecords(block, ctx) {
  const ad = ctx.addendum || {};
  const agency = ctx.agency || {};
  const dangling = [];
  const provider = _txProviderName(ctx);

  let lead = String(ad.recordsPertainingTo || '').trim();
  if (!lead) {
    const targets = Array.isArray(ad.targets) ? ad.targets : [];
    const ids = targets
      .filter(t => t && String(t.value || '').trim())
      .map(t => {
        const type = String(t.type || '').trim().toLowerCase();
        const label = TX_TARGET_LABELS[type] || (type ? type.replace(/[-_]/g, ' ') : 'identifier');
        return `${label} ${String(t.value).trim()}`;
      });
    if (!ids.length) dangling.push('addendum.targets');
    const range = ad.dateRange || {};
    let when = '';
    if (range.allAvailable) {
      when = ' for all available dates';
    } else if (range.start && range.end) {
      when = ` from ${_txLongDate(range.start)} to ${_txLongDate(range.end)}`;
    } else {
      if (!range.start) dangling.push('addendum.dateRange.start');
      if (!range.end) dangling.push('addendum.dateRange.end');
    }
    const who = ids.length ? ids.join(' and/or ') : '{{addendum.targets}}';
    lead = `${provider ? provider + ' ' : ''}${who}${when}`;
  }
  lead = lead.replace(/[:.;\s]+$/, '') + ':';

  // Record types — reuse the shared items-to-seize resolution.
  const itemsRes = _resolveItemsToSeize({ key: block.key, kind: 'items-to-seize' }, ctx);
  const items = (itemsRes.items || [])
    .map(it => String(it.description || it.label || '').trim())
    .filter(Boolean);
  for (const d of itemsRes.danglingSlots || []) dangling.push(d);

  const who = [agency.affiantRank, agency.affiantName].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  const email = String(agency.affiantEmail || '').trim();
  if (!String(agency.affiantName || '').trim()) dangling.push('agency.affiantName');
  if (!email) dangling.push('agency.affiantEmail');
  const provideTo = `Provide Records to ${who || '{{agency.affiantName}}'} at email address ${email || '{{agency.affiantEmail}}'}`;

  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: [`Records pertaining to: ${lead}`].concat(items.map(i => '• ' + i), ['• ' + provideTo]).join('\n'),
    lead,
    items,
    provideTo,
    danglingSlots: dangling,
  };
}

// Offense (centered, bold) + GROUNDS FOR ISSUANCE: CCP Art. 18.02 (a)(10)
// and (13) always; (9) "implements or instruments" only when the affiant
// ticks it (addendum.txGround9) — one exemplar has it, another doesn't.
function _resolveTxGrounds(block, ctx) {
  const ad = ctx.addendum || {};
  const cs = ctx.case || {};
  const offense = String(ad.txOffense || cs.offenseDescription || '').trim();
  const dangling = offense ? [] : ['case.offenseDescription'];
  const lines = ['Texas Code of Criminal Procedure Article 18.02:'];
  if (ad.txGround9) lines.push('(9) implements or instruments used in the commission of a crime;');
  lines.push('(10) property or items, except personal writings by the accused, constituting evidence tending to show that a particular person committed an offense;');
  lines.push('And');
  lines.push('(13) electronic customer data held in electronic storage, including the contents of and records and other information related to a wire communication or electronic communication held in electronic storage.');
  return {
    key: block.key,
    kind: block.kind,
    heading: 'GROUNDS FOR ISSUANCE:',
    text: lines.join('\n'),
    offense: offense || '{{case.offenseDescription}}',
    lines,
    danglingSlots: dangling,
  };
}

function _resolveTxMagistrateSignature(block, ctx) {
  const county = _txCounty(ctx);
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    county,
    danglingSlots: county ? [] : ['court.county'],
  };
}

function _resolveTxSignatures(block, ctx) {
  // Left:  ____ / AFFIANT / <Name> #<badge>, <RANK> / <agencyName>
  // Right: ____ / JUDGE / IN AND FOR THE STATE OF TEXAS / COUNTY OF <C>
  //        + "Sworn to and subscribed before me this __ day of __, 20__"
  const agency = ctx.agency || {};
  const county = _txCounty(ctx);
  const dangling = [];
  const name = String(agency.affiantName || '').trim();
  const agencyName = String(agency.agencyName || '').trim();
  if (!name) dangling.push('agency.affiantName');
  if (!agencyName) dangling.push('agency.agencyName');
  if (!county) dangling.push('court.county');
  return {
    key: block.key,
    kind: block.kind,
    heading: '',
    text: '',
    name,
    badge: String(agency.affiantBadge || '').trim(),
    rank: String(agency.affiantRank || '').trim(),
    agencyName,
    county,
    danglingSlots: dangling,
  };
}

// ─── AZ-SPECIFIC RESOLVERS ─────────────────────────────────────────────────
// Arizona Search Warrant + Affidavit for a Search Warrant (ARS 13-3911 et
// seq.), modelled on an Arizona municipal department's ESP exemplar. One
// warrant and one affidavit list EVERY provider (ctx.addendums); the
// records live in one 'ad-' ADDENDUM per provider (see _buildAzEsp).
// Nothing agency-specific is hard-coded: agency, city, county, court and
// affiant all come from the agency profile or the draft.
//
// Draft options (all optional; defaults mirror the exemplar):
//   azPremises (default on), azPerson + azPersonDesc, azVehicle + azVehicleDesc
//   azGrounds {stolen, means, intent, concealing, evidence, warrant}
//             (default means + evidence), azConcealingPerson
//   azDaytime (default on), azNighttime
//   azInformant 'learned' (default) | 'informant'
//   azFelony (default on), azNdo (default on), azNdoDays '' | 90 | 180 | 365
//   azOffense (else case offense), azCity (else city of the agency address),
//   arCounty (else agency county), courtName (else agency defaultCourtName)

const AZ_BLANK = '__________';

const AZ_GROUND_DEFS = Object.freeze([
  { key: 'stolen',     text: 'were stolen or embezzled' },
  { key: 'means',      text: 'were used as a means for committing a public offense, that offense being {offense}' },
  { key: 'intent',     text: 'is (are) being possessed with the intent to use as a means of committing a public offense' },
  { key: 'concealing', text: 'is (are) in possession of {person} to whom it was delivered for the purpose of concealing it or preventing it from being discovered' },
  { key: 'evidence',   text: 'constitute(s) any evidence tending to show that a public offense has been committed, that offense being {offense}' },
  { key: 'warrant',    text: 'such person is the subject of an outstanding arrest warrant' },
]);
const AZ_GROUND_DEFAULTS = Object.freeze({ means: true, evidence: true });

const AZ_NDO_PERIODS = Object.freeze({
  '90':  'ninety (90) days',
  '180': 'one hundred eighty (180) days',
  '365': 'one (1) year',
});

const AZ_TARGET_LABELS = Object.freeze({
  'esp-user-id': 'Account ID',
  'user-id': 'Account ID',
  'uid': 'Account ID',
  'account-id': 'Account ID',
  'email': 'Email',
  'phone': 'Phone Number',
  'username': 'Username',
  'handle': 'Username',
  'screen-name': 'Screen Name',
  'ip': 'IP Address',
  'name': 'Name',
});

function _azS(v) { return String(v == null ? '' : v).trim(); }

function _azAffiantLine(agency) {
  const a = agency || {};
  const who = [a.affiantRank, a.affiantName].map(_azS).filter(Boolean).join(' ');
  const badge = _azS(a.affiantBadge);
  return who + (who && badge ? ` # ${badge}` : '');
}

function _azCity(ctx) {
  const draft = ctx.draft || {};
  const agency = ctx.agency || {};
  return _azS(draft.azCity) || _splitUsAddress(agency.agencyAddress).city;
}

function _azCounty(ctx) {
  const draft = ctx.draft || {};
  return _azS(draft.arCounty) || _arCounty(ctx);
}

function _azOffense(ctx) {
  const draft = ctx.draft || {};
  const cs = ctx.case || {};
  return _azS(draft.azOffense) || _azS(cs.offenseDescription);
}

function _azCourt(ctx) {
  const draft = ctx.draft || {};
  const agency = ctx.agency || {};
  return _azS(draft.courtName) || _azS(agency.defaultCourtName);
}

// Every {{az.*}} slot. Empty values print as a blank line on the form;
// the REQUIRED ones are also reported as dangling so the issues list and
// the validator flag them.
function _azValues(ctx) {
  const agency = ctx.agency || {};
  const cs = ctx.case || {};
  const draft = ctx.draft || {};
  return {
    affiant: _azAffiantLine(agency),
    agency: _azS(agency.agencyName),
    city: _azCity(ctx),
    county: _azCounty(ctx),
    offense: _azOffense(ctx),
    offenseDate: _txLongDate(_azS(cs.offenseDate)),
    court: _azCourt(ctx),
    caseNumber: _azS(cs.number) || _azS(draft.caseRef),
  };
}
const AZ_REQUIRED = Object.freeze({
  affiant: 'agency.affiantName',
  agency: 'agency.agencyName',
  county: 'court.county',
  offense: 'case.offenseDescription',
});

// Substitutes {{az.*}} first (blank line when empty), then the ordinary
// slots.
function _azSubstitute(text, ctx) {
  const vals = _azValues(ctx);
  const dangling = [];
  const pre = String(text || '').replace(/\{\{\s*az\.(\w+)\s*\}\}/g, (m, k) => {
    const v = vals[k];
    if (v) return v;
    if (AZ_REQUIRED[k]) dangling.push(AZ_REQUIRED[k]);
    return AZ_BLANK;
  });
  const res = substituteSlots(pre, ctx);
  return { text: res.text, danglingSlots: dangling.concat(res.danglingSlots) };
}

// Provider block lines: name / street / city, ST zip / Statutory Agent: …
function _azProviderLines(p) {
  const lines = [];
  if (p.name) lines.push(p.name);
  const parts = _splitUsAddress(p.address);
  if (parts.street) lines.push(parts.street);
  if (parts.city) lines.push(`${parts.city}, ${parts.state} ${parts.zip}`.trim());
  const agent = String(p.statutoryAgent || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (agent.length) {
    lines.push('Statutory Agent: ' + agent[0]);
    for (const l of agent.slice(1)) lines.push(l);
  }
  return lines;
}

// Full provider list (with address + Arizona statutory agent) for the
// warrant / affidavit. ctx.addendums carries it from the UI; a bare ctx
// degrades to the provider being composed.
function _azProviders(ctx) {
  const raw = Array.isArray(ctx.addendums) ? ctx.addendums : null;
  if (raw && raw.length) {
    return raw.map((a, i) => ({
      pageLabel: _azS(a && a.pageLabel) || _arFallbackLabel(i),
      name: _azS(a && (a.providerName || a.provider || a.providerKey)),
      address: _azS(a && a.address),
      statutoryAgent: String((a && a.azStatutoryAgent) || ''),
    })).filter(e => e.name);
  }
  const provider = ctx.provider || {};
  const ad = ctx.addendum || {};
  const name = _azS(provider.legalEntity || provider.name);
  if (!name) return [];
  return [{
    pageLabel: _azS(ad.pageLabel) || 'A',
    name,
    address: _azS(provider.address),
    statutoryAgent: String(ad.azStatutoryAgent || ''),
  }];
}

function _azJoin(list) {
  if (list.length <= 1) return list.join('');
  if (list.length === 2) return list.join(' and ');
  return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
}

function _azBase(block, extra) {
  return Object.assign({ key: block.key, kind: block.kind, heading: '', text: '', danglingSlots: [] }, extra);
}

function _resolveAzParagraph(block, ctx) {
  const res = _azSubstitute(block.text || '', ctx);
  return _azBase(block, { text: res.text, danglingSlots: res.danglingSlots });
}

function _resolveAzHeader(block, ctx) {
  const v = _azValues(ctx);
  const variant = block.variant === 'affidavit' ? 'affidavit' : 'warrant';
  const C = (v.county || AZ_BLANK).toUpperCase();
  const dangling = v.county ? [] : ['court.county'];
  let agencyLine = '';
  let cityLine = '';
  if (variant === 'warrant') {
    // "Example City Police Department" + city "Example City" →
    // POLICE DEPARTMENT / CITY OF EXAMPLE CITY, ARIZONA (the exemplar).
    // Any other agency name prints in full with no city line.
    const name = v.agency.toUpperCase();
    const city = v.city.toUpperCase();
    if (name && city && name.startsWith(city + ' ') && name.length > city.length + 1) {
      agencyLine = name.slice(city.length + 1).trim();
      cityLine = `CITY OF ${city}, ARIZONA`;
    } else {
      agencyLine = name;
      // An explicit City override always prints its own header line.
      if (city && _azS((ctx.draft || {}).azCity)) cityLine = `CITY OF ${city}, ARIZONA`;
    }
    if (!name) dangling.push('agency.agencyName');
  }
  return _azBase(block, {
    variant,
    agencyLine,
    cityLine,
    title: variant === 'affidavit' ? 'AFFIDAVIT FOR A SEARCH WARRANT' : 'SEARCH WARRANT',
    countyLine: `COUNTY OF ${C}, STATE OF ARIZONA`,
    text: [agencyLine, cityLine, variant === 'affidavit' ? 'AFFIDAVIT FOR A SEARCH WARRANT' : 'SEARCH WARRANT', `COUNTY OF ${C}, STATE OF ARIZONA`].filter(Boolean).join('\n'),
    danglingSlots: dangling,
  });
}

function _resolveAzNumbers(block, ctx) {
  const v = _azValues(ctx);
  const draft = ctx.draft || {};
  const sw = _azS(draft.swNumber);
  const variant = block.variant === 'affidavit' ? 'affidavit' : 'warrant';
  const warrantNo = `${variant === 'affidavit' ? 'NO.' : 'WARRANT NO.'} ${sw || '____________________'}`;
  const drLine = `DR # ${v.caseNumber || '____________________'}`;
  return _azBase(block, { variant, warrantNo, drLine, text: warrantNo + '\n' + drLine });
}

function _resolveAzPlaces(block, ctx) {
  const draft = ctx.draft || {};
  const providers = _azProviders(ctx).map(p => ({
    label: 'Addendum ' + p.pageLabel,
    lines: _azProviderLines(p),
  }));
  const dangling = providers.length ? [] : ['provider.name'];
  const personDesc = _azS(draft.azPersonDesc);
  const vehicleDesc = _azS(draft.azVehicleDesc);
  const person = { checked: !!draft.azPerson, text: 'on the person(s) of' + (personDesc ? ': ' + personDesc : '') };
  const premises = { checked: draft.azPremises !== false, text: 'on the premise(s) known as:' };
  const vehicle = { checked: !!draft.azVehicle, text: 'in the vehicle(s) described as' + (vehicleDesc ? ': ' + vehicleDesc : '') };
  const lead = 'computer servers which are owned and operated by:';
  const box = (c) => (c ? '[X] ' : '[ ] ');
  const text = [
    box(person.checked) + person.text,
    box(premises.checked) + premises.text,
    lead,
  ].concat(providers.map(p => p.lines.concat('(' + p.label + ')').join('\n')), [box(vehicle.checked) + vehicle.text]).join('\n');
  return _azBase(block, { person, premises, vehicle, lead, providers, text, danglingSlots: dangling });
}

function _resolveAzItemsRef(block, ctx) {
  const list = _azProviders(ctx);
  const refs = list.map(p => `Addendum ${p.pageLabel} (${p.name})`);
  const dangling = refs.length ? [] : ['provider.name'];
  const ref = refs.length
    ? `The records and information described in ${_azJoin(refs)}, attached hereto and incorporated herein by reference.`
    : 'The records and information described in the attached Addendum, incorporated herein by reference.';
  return _azBase(block, { lead: String(block.lead || ''), ref, text: [block.lead || '', ref].filter(Boolean).join('\n'), danglingSlots: dangling });
}

function _resolveAzGrounds(block, ctx) {
  const draft = ctx.draft || {};
  const chosen = (draft.azGrounds && typeof draft.azGrounds === 'object') ? draft.azGrounds : AZ_GROUND_DEFAULTS;
  const offense = _azOffense(ctx);
  const person = _azS(draft.azConcealingPerson) || AZ_BLANK;
  const dangling = [];
  const items = AZ_GROUND_DEFS.map(g => {
    const checked = !!chosen[g.key];
    if (checked && g.text.indexOf('{offense}') !== -1 && !offense && dangling.indexOf('case.offenseDescription') === -1) {
      dangling.push('case.offenseDescription');
    }
    const t = g.text.replace('{offense}', offense || AZ_BLANK).replace('{person}', person);
    return { key: g.key, checked, text: /[.]$/.test(t) ? t : t + '.' };
  });
  const lead = String(block.lead || '');
  return _azBase(block, {
    lead,
    items,
    text: [lead].concat(items.map(i => (i.checked ? '[X] ' : '[ ] ') + i.text)).filter(Boolean).join('\n'),
    danglingSlots: dangling,
  });
}

function _resolveAzService(block, ctx) {
  const draft = ctx.draft || {};
  const items = [
    { key: 'day', checked: draft.azDaytime !== false, text: 'in the daytime (excluding the time period between 10 PM and 6:30 AM)' },
    { key: 'night', checked: !!draft.azNighttime, text: 'or nighttime (good cause therefore having been shown)' },
  ];
  const lead = 'YOU ARE THEREFORE COMMANDED';
  return _azBase(block, { lead, items, text: [lead].concat(items.map(i => (i.checked ? '[X] ' : '[ ] ') + i.text)).join('\n') });
}

function _resolveAzDelivery(block, ctx) {
  const agency = ctx.agency || {};
  const providers = _azProviders(ctx);
  const who = _azAffiantLine(agency) || '{{agency.affiantName}}';
  const dangling = [];
  if (!_azS(agency.affiantName)) dangling.push('agency.affiantName');
  const email = _azS(agency.affiantEmail);
  if (!email) dangling.push('agency.affiantEmail');
  const subject = providers.length === 1 ? providers[0].name : 'Each provider named above';
  const lead = `${subject} may send response materials for the search warrant to ${who} at the following address:`;
  const lines = [];
  lines.push(email || '{{agency.affiantEmail}}');
  if (_azS(agency.agencyName)) lines.push(_azS(agency.agencyName));
  const addr = _splitUsAddress(agency.agencyAddress);
  if (addr.street) lines.push(addr.street);
  if (addr.city) lines.push(`${addr.city}, ${addr.state} ${addr.zip}`.trim());
  const portalOwner = providers.length === 1 ? `the ${providers[0].name}` : "the provider's";
  const portal = `If able, the responsive data may also be delivered to ${who} through ${portalOwner} law enforcement request portal.`;
  return _azBase(block, { lead, lines, portal, text: [lead].concat(lines, [portal]).join('\n'), danglingSlots: dangling });
}

function _resolveAzFelony(block, ctx) {
  const draft = ctx.draft || {};
  if (draft.azFelony === false) return _azBase(block, { omitted: true });
  return _azBase(block, { text: String(block.text || '') });
}

function _resolveAzNdo(block, ctx) {
  const draft = ctx.draft || {};
  if (draft.azNdo === false) return _azBase(block, { omitted: true });
  const names = _azProviders(ctx).map(p => p.name);
  const many = names.length > 1;
  const who = names.length ? _azJoin(names) : 'the provider';
  const period = AZ_NDO_PERIODS[String(draft.azNdoDays || '').trim()] || '';
  const text = `**IT IS FURTHER ORDERED**, pursuant to 18 U.S.C. \u00a7 2705(b), that ${who}, ${many ? 'the recipients' : 'the recipient'} of this search warrant, ${many ? 'are' : 'is'} not to disclose the existence or contents of this search warrant, or any subsequent compliance with it, to the subscriber/account holder or to any other person, except as necessary to comply with this warrant${period ? `, for a period of ${period} from the date of this order` : ''}, nor ${many ? 'are they' : 'is it'} to terminate service to the account(s) identified in the attached Addendum${many ? 's' : ''}.`;
  return _azBase(block, { text, period: period ? String(draft.azNdoDays) : '' });
}

function _resolveAzInformant(block, ctx) {
  const draft = ctx.draft || {};
  const informant = String(draft.azInformant || '') === 'informant';
  const items = [
    { key: 'learned', checked: !informant, text: 'The affiant learned the following information in the following manner:' },
    { key: 'informant', checked: informant, text: 'The affiant received information from a/an (confidential informant) the information is as follows:' },
  ];
  const lead = 'CHECK ONE:';
  return _azBase(block, { lead, items, text: [lead].concat(items.map(i => (i.checked ? '[X] ' : '[ ] ') + i.text)).join('\n') });
}

function _resolveAzAffiantSignature(block, ctx) {
  const agency = ctx.agency || {};
  const dangling = [];
  if (!_azS(agency.affiantName)) dangling.push('agency.affiantName');
  if (!_azS(agency.agencyName)) dangling.push('agency.agencyName');
  const nameLine = _azAffiantLine(agency);
  return _azBase(block, { nameLine, agencyName: _azS(agency.agencyName), text: [nameLine, _azS(agency.agencyName)].filter(Boolean).join('\n'), danglingSlots: dangling });
}

function _resolveAzJudge(block, ctx) {
  const court = _azCourt(ctx);
  const title = block.variant === 'affidavit'
    ? 'JUDGE, JUSTICE OF THE PEACE, MAGISTRATE'
    : 'JUDGE, JUSTICE OF THE PEACE, OR MAGISTRATE';
  const courtLine = `Of the ${court || '______________________________'}`;
  return _azBase(block, { title, court, courtLine, text: title + '\n' + courtLine });
}

function _resolveAzAddendumHeading(block, ctx) {
  const ad = ctx.addendum || {};
  const draft = ctx.draft || {};
  const provider = ctx.provider || {};
  const v = _azValues(ctx);
  const label = _azS(ad.pageLabel) || 'A';
  const name = _azS(provider.legalEntity || provider.name);
  const sw = _azS(draft.swNumber);
  const ref = `Search Warrant No. ${sw || '__________'} \u00b7 DR # ${v.caseNumber || '__________'}`;
  const body = 'This Addendum is attached to and incorporated into the Search Warrant and the Affidavit for a Search Warrant issued in this matter.';
  return _azBase(block, {
    title: `ADDENDUM ${label}`,
    providerName: name,
    ref,
    body,
    text: [`ADDENDUM ${label}`, name, ref, body].filter(Boolean).join('\n'),
    danglingSlots: name ? [] : ['provider.name'],
  });
}

function _resolveAzProviderBlock(block, ctx) {
  const provider = ctx.provider || {};
  const ad = ctx.addendum || {};
  const name = _azS(provider.legalEntity || provider.name);
  const dangling = [];
  if (!name) dangling.push('provider.name');
  if (!_azS(provider.address)) dangling.push('provider.address');
  const lines = _azProviderLines({ name, address: provider.address, statutoryAgent: ad.azStatutoryAgent });
  return _azBase(block, { lines, text: lines.join('\n'), danglingSlots: dangling });
}

function _resolveAzAccount(block, ctx) {
  const ad = ctx.addendum || {};
  const provider = ctx.provider || {};
  const name = _azS(provider.name || provider.legalEntity);
  const targets = (Array.isArray(ad.targets) ? ad.targets : []).filter(t => t && _azS(t.value));
  const dangling = targets.length ? [] : ['addendum.targets'];
  const lines = targets.map(t => {
    const type = _azS(t.type).toLowerCase();
    const label = AZ_TARGET_LABELS[type] || (type ? type.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Identifier');
    return `${label}: ${_azS(t.value)}${_azS(t.helper) ? ` (${_azS(t.helper)})` : ''}`;
  });
  const lead = `For the following ${name ? name + ' ' : ''}account holder:`;
  return _azBase(block, { lead, lines: lines.length ? lines : ['{{addendum.targets}}'], text: [lead].concat(lines).join('\n'), danglingSlots: dangling });
}

function _resolveAzRecords(block, ctx) {
  const ad = ctx.addendum || {};
  const dangling = [];
  const range = ad.dateRange || {};
  let lead;
  if (range.allAvailable) {
    lead = 'All information below requested for all dates the records exist:';
  } else if (range.start && range.end) {
    lead = `All information below requested from ${_txLongDate(range.start)} to ${_txLongDate(range.end)}:`;
  } else if (range.start) {
    lead = `All information below requested from ${_txLongDate(range.start)} to the present:`;
  } else {
    dangling.push('addendum.dateRange.start');
    lead = `All information below requested from ${AZ_BLANK} to ${AZ_BLANK}:`;
  }
  const itemsRes = _resolveItemsToSeize({ key: block.key, kind: 'items-to-seize' }, ctx);
  const items = (itemsRes.items || [])
    .map(it => String(it.description || it.label || '').trim())
    .filter(Boolean);
  for (const d of itemsRes.danglingSlots || []) dangling.push(d);
  return _azBase(block, {
    lead,
    items,
    text: [lead].concat(items.map((t, i) => `${i + 1} \u2013 ${t}`)).join('\n'),
    danglingSlots: dangling,
  });
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
  // CO-specific
  'co-caption':              _resolveCoCaption,
  'co-provider-block':       _resolveCoProviderBlock,
  'co-affiant-signature':    _resolveCoAffiantSignature,
  'co-judge-oath-affidavit': _resolveCoJudgeOathAffidavit,
  'co-judge-signature':      _resolveCoJudgeSignature,
  'co-da-approval':          _resolveCoDaApproval,
  // AR-specific
  'ar-caption':              _resolveArCaption,
  'ar-addendum-index':       _resolveArAddendumIndex,
  'ar-provider-order-block': _resolveArProviderOrderBlock,
  'ar-affiant-signature':    _resolveArAffiantSignature,
  'ar-judge-block':          _resolveArJudgeBlock,
  'page-break':              _resolvePageBreak,
  // TX-specific
  'tx-caption':              _resolveTxCaption,
  'tx-provider-block':       _resolveTxProviderBlock,
  'tx-records':              _resolveTxRecords,
  'tx-grounds':              _resolveTxGrounds,
  'tx-magistrate-signature': _resolveTxMagistrateSignature,
  'tx-signatures':           _resolveTxSignatures,
  // AZ-specific
  'az-paragraph':            _resolveAzParagraph,
  'az-header':               _resolveAzHeader,
  'az-numbers':              _resolveAzNumbers,
  'az-places':               _resolveAzPlaces,
  'az-items-ref':            _resolveAzItemsRef,
  'az-grounds':              _resolveAzGrounds,
  'az-service':              _resolveAzService,
  'az-delivery':             _resolveAzDelivery,
  'az-felony':               _resolveAzFelony,
  'az-ndo':                  _resolveAzNdo,
  'az-informant':            _resolveAzInformant,
  'az-affiant-signature':    _resolveAzAffiantSignature,
  'az-judge':                _resolveAzJudge,
  'az-addendum-heading':     _resolveAzAddendumHeading,
  'az-provider-block':       _resolveAzProviderBlock,
  'az-account':              _resolveAzAccount,
  'az-records':              _resolveAzRecords,
  // Layout markers (pass-through, no slots)
  'section-break':           _resolvePageBreak,
  'box-start':               _resolvePageBreak,
  'box-end':                 _resolvePageBreak,
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
    // Presentation passthrough. `format` is a purely VISUAL hint declared
    // on the template block ('prose' = first-line indent + justified,
    // 'center' = centered line). It never participates in slot
    // resolution, so it is forwarded verbatim rather than being threaded
    // through every resolver. The block-builder and the live preview both
    // read it; composers that don't understand a value ignore it.
    if (block.format && resolved && !resolved.format) {
      resolved.format = String(block.format);
    }
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
  _splitUsAddress,
  _formatItemsText,
  _txLongDate,
  _azValues,
  _azProviders,
  AZ_GROUND_DEFS,
  AZ_GROUND_DEFAULTS,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorTemplateEngine = api;
}

})();
