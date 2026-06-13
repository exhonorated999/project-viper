// modules/warrant-author/provider-directory.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure schema + 13 shipped provider records for the Warrant Author Provider
// Directory. No I/O — no localStorage reads, no IPC, no DOM. Both the
// renderer (settings page + warrant authoring UI) and the main process
// (template engine, P4+) consume this.
//
// Storage location (renderer-side; see settings.html):
//   • viperWarrantAuthorCustomProviders   → array of agency-added providers
//   • viperWarrantAuthorProviderOverrides → object { shippedKey: {...fields} }
//   • viperWarrantAuthorProviderDeletions → array of shipped keys to hide
//
// Design rules:
//   • The 13 SHIPPED_PROVIDERS array is immutable in code. Agencies that
//     need to change shipped data write an entry in providerOverrides
//     keyed by the shipped key. mergeProviders() applies overrides on top
//     of the shipped baseline so the agency never loses the shipped data.
//   • Agencies that want to hide a shipped provider add its key to
//     providerDeletions. mergeProviders() filters it out. The shipped
//     data is preserved for restore.
//   • Custom providers live in customProviders. Their key is auto-
//     generated from the legal entity name on first save and is
//     guaranteed unique against shipped + existing custom keys.
//   • itemsPattern is a HINT to the items-taxonomy module (P3) — it
//     names the canonical bundle (A / B / C) plus optional provider-
//     specific additions ("A+snaps", "mail+drive"). v1 stores it as
//     free text; P3 wires the pattern→items resolver.
//   • providerType is a UI bucket (ESP / Phone / Internet / Financial /
//     Other). It is NOT the same as CalECPA §1546(d) ESP classification
//     — `esp: true` is the legal flag that drives §1546.1(d)(2/3)
//     clause inclusion. Some `providerType: 'Phone'` entries are also
//     `esp: true` (e.g. TextNow).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// IIFE wrapper so top-level const/let don't pollute the renderer's shared
// classic-script scope (would collide with agency-profile.js etc.).
(function () {

const SCHEMA_VERSION = 1;

// ─── PROVIDER TYPES (UI bucket) ────────────────────────────────────────────
const PROVIDER_TYPES = Object.freeze([
  { value: 'ESP',       label: 'ESP (Social / Messaging / Mail)' },
  { value: 'Phone',     label: 'Phone / Carrier' },
  { value: 'Internet',  label: 'Internet / ISP' },
  { value: 'Financial', label: 'Financial / Payments' },
  { value: 'Other',     label: 'Other' },
]);

// ─── ITEMS PATTERN HINTS ───────────────────────────────────────────────────
// Mirrors §7 taxonomy (P3 will wire these into actual item lists).
//   A = basic ESP: subscriber, content, IP history, contacts
//   B = telecom / ISP: subscriber, CDR, IP history, cell-site
//   C = financial: account, transactions, IP/login history
const ITEMS_PATTERNS = Object.freeze([
  { value: 'A',        label: 'A — ESP (subscriber + content + IP + contacts)' },
  { value: 'B',        label: 'B — Telecom / ISP (subscriber + CDR + IP + cell-site)' },
  { value: 'C',        label: 'C — Financial (account + transactions + login)' },
  { value: 'A+snaps',  label: 'A + Snaps & Memories (Snapchat)' },
  { value: 'mail+drive', label: 'Mail + Drive/Cloud (Google, Microsoft, Yahoo)' },
  { value: 'B+telephony', label: 'B + Telephony / Texts (TextNow)' },
  { value: 'B+cdr+cell',  label: 'B + CDR + Cell-site (T-Mobile / Sprint)' },
  { value: 'C+transactions', label: 'C + Transactions (Venmo / PayPal)' },
  { value: 'custom',   label: 'Custom (free text)' },
]);

// ─── SHIPPED PROVIDERS (13 entries, immutable) ─────────────────────────────
// Sourced from plan.md §6. Free-text addresses retained verbatim so
// affidavit caption matches the user's exemplar set.
const SHIPPED_PROVIDERS = Object.freeze([
  Object.freeze({
    key: 'snapchat',
    name: 'Snapchat',
    legalEntity: 'Snap Inc.',
    address: '2772 Donald Douglas Loop N, Santa Monica, CA 90405',
    custodianAttention: 'Custodian of Records',
    email: 'lawenforcement@snapchat.com',
    phone: '',
    portalUrl: '',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'A+snaps',
    notes: 'Memories, Snaps, Stories, Chats, friends list, login IPs.',
  }),
  Object.freeze({
    key: 'tiktok',
    name: 'TikTok',
    legalEntity: 'TikTok Inc.',
    address: '5800 Bristol Pkwy #100, Culver City, CA 90230',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: 'https://lawenforcement.tiktok.com/',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'A',
    notes: 'Submit via Law Enforcement Portal (LERP).',
  }),
  Object.freeze({
    key: 'twitter-x',
    name: 'Twitter / X',
    legalEntity: 'Twitter Inc. c/o Trust & Safety',
    address: '1355 Market St #900, San Francisco, CA 94103',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: 'https://legalrequests.twitter.com/',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'A',
    notes: 'Submit via X Legal Request Portal.',
  }),
  Object.freeze({
    key: 'whatsapp',
    name: 'WhatsApp',
    legalEntity: 'WhatsApp LLC (Law Enforcement Response Team)',
    address: '1601 Willow Rd, Menlo Park, CA 94025',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: 'https://www.facebook.com/records',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'A',
    notes: 'Submit via Meta Law Enforcement Online Request System.',
  }),
  Object.freeze({
    key: 'yahoo',
    name: 'Yahoo',
    legalEntity: 'Yahoo Inc. (Custodian of Records)',
    address: '1199 Coleman Ave, San Jose, CA 95110',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: 'https://eo.yahooinc.com/',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'mail+drive',
    notes: 'Mail content, Yahoo Cloud / Flickr / contacts, login IPs, GPS data.',
  }),
  Object.freeze({
    key: 'text-now',
    name: 'TextNow',
    legalEntity: 'TextNow Inc.',
    address: '2710 Gateway Oaks Dr #150N, Sacramento, CA 95833',
    custodianAttention: 'Custodian of Records',
    email: 'lawenforcement@textnow.com',
    phone: '',
    portalUrl: '',
    providerType: 'Phone',
    esp: true,
    nre: false,
    itemsPattern: 'B+telephony',
    notes: 'VoIP/SMS provider — subscriber, CDR-equivalent message logs, IP history.',
  }),
  Object.freeze({
    key: 'venmo-paypal',
    name: 'Venmo / PayPal',
    legalEntity: 'PayPal Inc. / Venmo (Global Investigations)',
    address: '2211 N First St, San Jose, CA 95131',
    custodianAttention: 'Global Investigations',
    email: '',
    phone: '(402) 935-7733',
    portalUrl: '',
    providerType: 'Financial',
    esp: false,
    nre: false,
    itemsPattern: 'C+transactions',
    notes: 'Subscriber, full transaction ledger, login IP/device history.',
  }),
  Object.freeze({
    key: 'zscaler',
    name: 'Zscaler',
    legalEntity: 'Zscaler Inc. (Legal Compliance)',
    address: '110 Rose Orchard Way, San Jose, CA 95134',
    custodianAttention: 'Legal Compliance',
    email: 'support@zscaler.com',
    phone: '',
    portalUrl: '',
    providerType: 'Internet',
    esp: false,
    nre: false,
    itemsPattern: 'B',
    notes: 'Cloud security / SWG logs — subscriber, web traffic logs by tenant.',
  }),
  Object.freeze({
    key: 'ultimate-internet',
    name: 'Ultimate Internet Access',
    legalEntity: 'Ultimate Internet Access Inc.',
    address: '3633 Inland Empire Blvd, Ontario, CA 91764',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '(909) 605-2000',
    portalUrl: '',
    providerType: 'Internet',
    esp: false,
    nre: false,
    itemsPattern: 'B',
    notes: 'Regional ISP — subscriber, IP assignments, NAT/CG-NAT logs.',
  }),
  Object.freeze({
    key: 'sprint-tmobile',
    name: 'T-Mobile (formerly Sprint)',
    legalEntity: 'T-Mobile USA, Inc.',
    address: '6480 Sprint Pkwy, Overland Park, KS 66251',
    custodianAttention: 'Law Enforcement Relations Team',
    email: '',
    phone: '',
    portalUrl: '',
    providerType: 'Phone',
    esp: false,
    nre: false,
    itemsPattern: 'B+cdr+cell',
    notes: 'Subscriber, CDR, cell-site / tower-dump, IP session logs.',
  }),
  Object.freeze({
    key: 'microsoft',
    name: 'Microsoft',
    legalEntity: 'Microsoft Corporation (Online Services)',
    address: '1 Microsoft Way, Redmond, WA 98052',
    custodianAttention: 'Online Services Custodian of Records',
    email: '',
    phone: '(425) 722-1299',
    portalUrl: 'https://portal.microsoft.com/leerequest',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'mail+drive',
    notes: 'Outlook / Hotmail / OneDrive / Xbox Live — subscriber, content, IP, location.',
  }),
  Object.freeze({
    key: 'charter-spectrum',
    name: 'Charter / Spectrum',
    legalEntity: 'Charter Communications',
    address: '12405 Powerscourt Dr, St. Louis, MO 63131',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: '',
    providerType: 'Internet',
    esp: false,
    nre: false,
    itemsPattern: 'B',
    notes: 'Cable/internet ISP — subscriber, IP assignments, modem MAC/MTA logs.',
  }),
  Object.freeze({
    key: 'google',
    name: 'Google',
    legalEntity: 'Google LLC',
    address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043',
    custodianAttention: 'Custodian of Records',
    email: '',
    phone: '',
    portalUrl: 'https://lers.google.com/',
    providerType: 'ESP',
    esp: true,
    nre: false,
    itemsPattern: 'mail+drive',
    notes: 'Submit via LERS portal. Gmail, Drive, Photos, location history, YouTube.',
  }),
]);

// ─── FIELD METADATA ────────────────────────────────────────────────────────
// Used by the settings Add/Edit Provider form (P2-3).
const FIELDS = Object.freeze([
  { key: 'name',               label: 'Display Name',         group: 'identity', type: 'text',     placeholder: 'Snapchat',                              required: true,  helper: 'Short name used in headers and dropdowns.' },
  { key: 'legalEntity',        label: 'Legal Entity Name',    group: 'identity', type: 'text',     placeholder: 'Snap Inc.',                             required: true,  helper: 'Full legal name printed on the warrant block.' },
  { key: 'providerType',       label: 'Provider Type',        group: 'identity', type: 'select',   options: PROVIDER_TYPES,                              required: true,  helper: 'UI bucket. Affects filter chips only.' },
  { key: 'address',            label: 'Mailing Address',      group: 'contact',  type: 'text',     placeholder: '2772 Donald Douglas Loop N, Santa Monica, CA 90405', required: true, helper: 'Single line — printed verbatim on the warrant.' },
  { key: 'custodianAttention', label: 'Attention / Custodian',group: 'contact',  type: 'text',     placeholder: 'Custodian of Records',                  required: false, helper: 'Attention line on the addendum.' },
  { key: 'email',              label: 'Service Email',        group: 'contact',  type: 'email',    placeholder: 'lawenforcement@example.com',            required: false, helper: 'Primary law-enforcement contact email.' },
  { key: 'phone',              label: 'Service Phone',        group: 'contact',  type: 'text',     placeholder: '(909) 555-1212',                        required: false, helper: 'LE response team phone.' },
  { key: 'portalUrl',          label: 'Portal URL',           group: 'contact',  type: 'url',      placeholder: 'https://example.com/le-portal',         required: false, helper: 'Submission portal (Meta, LERS, etc.).' },
  // ── Colorado-specific (used only by co-multi-business-esp template) ────
  { key: 'coRegisteredAgent',        label: 'CO Registered Agent',         group: 'colorado', type: 'text',     placeholder: 'CT Corporation System',                 required: false, helper: 'Out-of-state ESP\u2019s Colorado registered agent (printed on the CO warrant under "Registered Agent:"). Optional on non-CO warrants.' },
  { key: 'coRegisteredAgentAddress', label: 'CO Registered Agent Address', group: 'colorado', type: 'textarea', placeholder: '7700 E. Arapahoe Rd. Suite 220\nCentennial, CO 80112', required: false, helper: 'Full CO address (street + city/state/ZIP). Multi-line accepted.' },
  { key: 'esp',                label: 'CalECPA §1546(d) ESP', group: 'legal',    type: 'checkbox',                                                       required: false, helper: 'Drives §1546.1(d)(2) sealing + §1546.1(d)(3) authenticity clauses.' },
  { key: 'nre',                label: 'Non-Records (NRE)',    group: 'legal',    type: 'checkbox',                                                       required: false, helper: 'Provider can produce items beyond stored records (live data, etc.).' },
  { key: 'itemsPattern',       label: 'Items Pattern',        group: 'legal',    type: 'select',   options: ITEMS_PATTERNS,                              required: false, helper: 'Pre-selects the items-to-seize bundle when authoring.' },
  { key: 'notes',              label: 'Affiant Notes',        group: 'notes',    type: 'textarea',                                                       required: false, helper: 'Free text — visible only to authoring officers (not printed).' },
]);

const FIELD_GROUPS = Object.freeze([
  { id: 'identity', label: 'Identity',         helper: 'Display + legal entity name printed on the warrant.' },
  { id: 'contact',  label: 'Service Contact',  helper: 'Where the warrant is served and returns are received.' },
  { id: 'colorado', label: 'Colorado',         helper: 'Used only by the CO Multi-Business ESP template. Out-of-state ESPs are typically required to have a Colorado registered agent.' },
  { id: 'legal',    label: 'Legal Classification', helper: 'Drives which CalECPA clauses are included on this addendum.' },
  { id: 'notes',    label: 'Notes',            helper: 'Internal-only — never printed on the warrant.' },
]);

// ─── PURE HELPERS ──────────────────────────────────────────────────────────

/** True if `key` is a shipped provider key. */
function isShipped(key) {
  return SHIPPED_PROVIDERS.some(p => p.key === key);
}

/** Returns the shipped provider for `key`, or null. */
function getShippedByKey(key) {
  return SHIPPED_PROVIDERS.find(p => p.key === key) || null;
}

/**
 * Normalises a provider object — strips unknown keys, coerces booleans,
 * trims strings. Returns a new object (does not mutate input).
 */
function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    key: '', name: '', legalEntity: '', address: '', custodianAttention: '',
    email: '', phone: '', portalUrl: '', providerType: 'Other',
    coRegisteredAgent: '', coRegisteredAgentAddress: '',
    esp: false, nre: false, itemsPattern: '', notes: '',
  };
  for (const f of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, f.key)) {
      const v = raw[f.key];
      if (f.type === 'checkbox') {
        out[f.key] = v === true || v === 'true' || v === 1 || v === '1';
      } else if (f.type === 'textarea') {
        // Preserve embedded newlines; only trim outer whitespace.
        out[f.key] = (v == null ? '' : String(v)).replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '');
      } else {
        out[f.key] = (v == null ? '' : String(v)).trim();
      }
    }
  }
  // key is not in FIELDS (not user-editable on existing entries) — preserve.
  if (typeof raw.key === 'string') out.key = raw.key.trim();
  // providerType enum guard
  if (!PROVIDER_TYPES.some(t => t.value === out.providerType)) out.providerType = 'Other';
  return out;
}

/**
 * Returns the list of required-field keys missing from `provider`.
 */
function findMissingRequired(provider) {
  const p = normalizeProvider(provider) || {};
  const missing = [];
  for (const f of FIELDS) {
    if (!f.required) continue;
    const v = (p[f.key] || '').toString().trim();
    if (!v) missing.push(f.key);
  }
  return missing;
}

/** Convenience — true when zero required fields are missing. */
function isValidProvider(provider) {
  return findMissingRequired(provider).length === 0;
}

/**
 * Generate a slug-style key from a legal-entity/display name. Returns
 * lowercase a-z 0-9 + dashes. Guarantees uniqueness against the supplied
 * existingKeys set by suffixing -2, -3, etc.
 */
function generateProviderKey(name, existingKeys) {
  const exist = new Set(existingKeys || []);
  const base = String(name || 'provider')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'provider';
  if (!exist.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!exist.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Merge shipped + custom + overrides − deletions into the rendered
 * provider list. Each entry is tagged with `_source` so the UI can show
 * the "Shipped" / "Custom" / "Shipped + Edited" pill.
 *
 * @param {object} stores
 *   {
 *     customProviders:  array,
 *     providerOverrides: object { key: partial },
 *     providerDeletions: array of shipped keys to hide
 *   }
 */
function mergeProviders(stores) {
  const s = stores || {};
  const customProviders = Array.isArray(s.customProviders) ? s.customProviders : [];
  const overrides = (s.providerOverrides && typeof s.providerOverrides === 'object') ? s.providerOverrides : {};
  const deletions = new Set(Array.isArray(s.providerDeletions) ? s.providerDeletions : []);

  const out = [];
  // Shipped first (minus hidden)
  for (const ship of SHIPPED_PROVIDERS) {
    if (deletions.has(ship.key)) continue;
    const ov = overrides[ship.key];
    if (ov && typeof ov === 'object') {
      const merged = Object.assign({}, ship, ov, { key: ship.key });
      const norm = normalizeProvider(merged);
      norm._source = 'shipped-override';
      out.push(norm);
    } else {
      const norm = normalizeProvider(ship);
      norm._source = 'shipped';
      out.push(norm);
    }
  }
  // Custom
  for (const c of customProviders) {
    if (!c || !c.key) continue;
    if (isShipped(c.key)) continue;   // safety — custom must not collide
    const norm = normalizeProvider(c);
    norm._source = 'custom';
    out.push(norm);
  }
  // Sort by display name, case-insensitive
  out.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
  return out;
}

/**
 * Look up a single provider by key against the merged set.
 */
function getProviderByKey(key, stores) {
  const all = mergeProviders(stores);
  return all.find(p => p.key === key) || null;
}

/** Returns the human label for a field key, or the key itself if unknown. */
function labelFor(key) {
  const f = FIELDS.find(x => x.key === key);
  return f ? f.label : key;
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────
const api = Object.freeze({
  SCHEMA_VERSION,
  SHIPPED_PROVIDERS,
  PROVIDER_TYPES,
  ITEMS_PATTERNS,
  FIELDS,
  FIELD_GROUPS,
  // helpers
  isShipped,
  getShippedByKey,
  normalizeProvider,
  findMissingRequired,
  isValidProvider,
  generateProviderKey,
  mergeProviders,
  getProviderByKey,
  labelFor,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorProviderDirectory = api;
}

})();
