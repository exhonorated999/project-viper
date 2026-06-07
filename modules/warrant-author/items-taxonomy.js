// modules/warrant-author/items-taxonomy.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure taxonomy module for the Warrant Author "Items to be Seized" section.
// No I/O — no localStorage reads, no IPC, no DOM. Consumed by both the
// renderer (authoring UI in P6, settings preview if added later) and the
// main process (template engine in P4+, addendum composer).
//
// Design rules:
//   • Two flat catalogs:
//       CANONICAL_CATEGORIES — 10 universal item types every ESP / ISP /
//         financial warrant draws from.
//       PROVIDER_EXTRAS — 11 provider-specific items (Snaps, Drive, CDR,
//         iCloud backups, etc.) that supplement a base pattern.
//   • Each item carries:
//       key             stable id, used in serialized addendums + pattern defs
//       label           short display label for the UI list
//       description     long-form prose used in the rendered "Items to be
//                       Seized" paragraph (template engine fills these in)
//       legalBasis      optional citation hint (e.g. "PC 1546(d)") — drives
//                       the validator's clause inclusion rules in P7
//       group           'canonical' | 'extra' (UI bucket)
//   • PATTERN_BUNDLES is a registry of named bundles. Each bundle resolves
//     to an ordered list of item keys. The 3 canonical patterns (A / B / C)
//     plus 6 provider-specific variants (A+snaps, mail+drive,
//     B+telephony, B+cdr+cell, C+transactions, custom) match the
//     itemsPattern hints baked into the provider directory (P2).
//   • resolvePattern(patternKey) returns the materialized item list — the
//     single function the template engine calls when composing a per-
//     provider addendum.
//   • PROVIDER_DEFAULT_PATTERN maps each shipped provider key to its v1
//     pattern, so getItemsForProvider() (bridge in provider-directory.js
//     in P3-2) can short-circuit when a provider hasn't been customized.
//   • The "custom" pattern resolves to an empty list — UI lets the user
//     hand-pick item keys from the full catalog when no preset fits.
//   • This module is the single source of truth for the validator (P7).
//     The hard error "Items-to-seize list empty" reads from a resolved
//     pattern; the soft warning "Pattern asks for cell-site data on a
//     non-carrier provider" reads from the legalBasis hints.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// IIFE wrapper so top-level const/let don't collide with sibling warrant-
// author modules (agency-profile.js, provider-directory.js) when all are
// loaded as classic <script> tags into the renderer's shared scope.
(function () {

const SCHEMA_VERSION = 1;

// ─── CANONICAL CATEGORIES (universal, 10 entries) ──────────────────────────
// Order here is the canonical display order in the "Items to be Seized"
// paragraph. Do not reorder without updating the templates.
const CANONICAL_CATEGORIES = Object.freeze([
  Object.freeze({
    key: 'subscriber-info',
    label: 'Subscriber information',
    description: 'Subscriber identity records including name, mailing address, billing address, telephone number(s), email address(es), screen name(s)/handle(s), date of account creation, account status (active/suspended/closed), and means/source of payment.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'account-credentials',
    label: 'Account credentials',
    description: 'Stored or recovery passwords, security questions and answers, two-factor authentication records, recovery email addresses, and recovery telephone numbers associated with the target account(s).',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'payment-billing',
    label: 'Payment and billing records',
    description: 'All payment instruments associated with the target account(s), including credit/debit card numbers, bank routing/account numbers, PayPal accounts, gift-card balances, billing addresses, and billing history for the specified date range.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'ip-history',
    label: 'IP address history',
    description: 'All IP addresses used to access or authenticate to the target account(s) during the specified date range, with associated timestamps in UTC and (if available) the ports used.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'messages-content',
    label: 'Messages and communications content',
    description: 'The contents of all private messages, chats, group chats, direct messages, voice messages, video calls, and call logs sent or received by the target account(s) during the specified date range, including any associated attachments, embedded media, deletion records, and recipient/sender identifiers.',
    legalBasis: 'PC 1546(d) — content',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'media',
    label: 'Stored media (photos, videos, files)',
    description: 'All photographs, videos, audio recordings, and files stored in, uploaded to, or downloaded from the target account(s) during the specified date range, including thumbnails, originals, and any associated EXIF / capture metadata.',
    legalBasis: 'PC 1546(d) — content',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'location-data',
    label: 'Location data',
    description: 'All location information associated with the target account(s) for the specified date range, including but not limited to GPS coordinates attached to media, location-history records, check-ins, geotagged events, and IP-derived geolocation.',
    legalBasis: 'PC 1546(d) — location',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'internet-artifacts',
    label: 'Internet artifacts',
    description: 'Browser history, search history, autofill records, cookies, and any other internet activity records preserved by the provider for the target account(s) during the specified date range.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'device-identification',
    label: 'Device identification',
    description: 'All device identifiers used to access the target account(s) during the specified date range, including device model, operating system, application version, advertising ID, IMEI/MEID, serial numbers, and any provider-assigned device fingerprints.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
  Object.freeze({
    key: 'multimedia-metadata',
    label: 'Multimedia metadata',
    description: 'For all media items produced, the original capture timestamps, EXIF data, GPS coordinates embedded in the file, upload timestamps, and any provider-side classification, hashing, or content-moderation labels applied to the media.',
    legalBasis: 'PC 1546(d)',
    group: 'canonical',
  }),
]);

// ─── PROVIDER EXTRAS (specialty items, 11 entries) ─────────────────────────
const PROVIDER_EXTRAS = Object.freeze([
  Object.freeze({
    key: 'cdr',
    label: 'Call detail records (CDR)',
    description: 'Call detail records for the target telephone number(s) during the specified date range, including incoming and outgoing call attempts, duration, calling/called numbers, and the originating/terminating cell tower for each call.',
    legalBasis: 'PC 1546(d) — telephony',
    group: 'extra',
  }),
  Object.freeze({
    key: 'cell-site',
    label: 'Cell-site / tower information',
    description: 'Historical cell-site location information (CSLI) for the target telephone number(s) during the specified date range, including tower ID, sector, azimuth, and any per-record location data the carrier preserves.',
    legalBasis: 'PC 1546(d); Carpenter v. United States, 138 S. Ct. 2206 (2018)',
    group: 'extra',
  }),
  Object.freeze({
    key: 'snaps',
    label: 'Snaps and Memories (Snapchat)',
    description: 'All Snaps (sent, received, opened, unopened, expired), Memories archives, and Stories posts associated with the target account during the specified date range, including any media that has been backed up to Memories or My Eyes Only.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
  Object.freeze({
    key: 'drive',
    label: 'Cloud drive contents',
    description: 'All files, folders, shared documents, and version history stored in the cloud-drive service (e.g. Google Drive, OneDrive, Yahoo Cloud) associated with the target account during the specified date range.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
  Object.freeze({
    key: 'icloud-backup',
    label: 'iCloud / cloud device backups',
    description: 'All device backups stored in the cloud account for the specified date range, including backup manifests, contained app data, and any preserved versions of prior backups.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
  Object.freeze({
    key: 'keychain',
    label: 'Stored credentials / keychain',
    description: 'Stored login credentials, autofill records, certificate chains, and any keychain or password-manager entries preserved by the provider for the target account.',
    legalBasis: 'PC 1546(d)',
    group: 'extra',
  }),
  Object.freeze({
    key: 'transactions',
    label: 'Financial transactions',
    description: 'All financial transactions associated with the target account during the specified date range, including transaction ID, counterparty identifier, amount, currency, memo/note, IP address at time of transaction, device fingerprint, and disposition (completed/refunded/disputed).',
    legalBasis: 'PC 1546(d) — financial',
    group: 'extra',
  }),
  Object.freeze({
    key: 'sensorvault',
    label: 'Location-history extracts (Sensorvault-equivalent)',
    description: 'Any granular location-history records the provider retains beyond the basic GPS metadata listed above, including the per-device timeline of latitude/longitude/timestamp points for the specified date range.',
    legalBasis: 'PC 1546(d) — location; Carpenter v. United States (2018)',
    group: 'extra',
  }),
  Object.freeze({
    key: 'youtube-history',
    label: 'YouTube watch / search history',
    description: 'YouTube watch history, search history, comments posted, channels subscribed, and any uploaded content associated with the target Google account during the specified date range.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
  Object.freeze({
    key: 'yahoo-cloud',
    label: 'Yahoo Cloud / Mail attachments',
    description: 'All mailbox contents (sent, received, drafts, deleted), attachments, contacts, calendars, and any Yahoo Cloud storage associated with the target account during the specified date range.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
  Object.freeze({
    key: 'onedrive',
    label: 'OneDrive / Microsoft 365 contents',
    description: 'All OneDrive files, SharePoint documents, OneNote notebooks, Outlook mailbox contents, Teams chat history, and any Microsoft 365 application data associated with the target account during the specified date range.',
    legalBasis: 'PC 1546(d) — content',
    group: 'extra',
  }),
]);

// ─── PATTERN BUNDLES ───────────────────────────────────────────────────────
// Each bundle is the ordered list of item keys composed into the "Items to
// be Seized" paragraph. Order matters — templates render in this sequence.
// Patterns A / B / C are the canonical 3 from plan §7. Provider-specific
// variants extend the base pattern with extras.
const PATTERN_BUNDLES = Object.freeze({
  // ─── A — Social Media / ESP base ─────────────────────────────────────────
  // Snapchat, TikTok, Twitter/X, WhatsApp, Discord, Meta — the standard
  // ESP search-warrant items list.
  'A': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'messages-content',
    'media',
    'location-data',
    'internet-artifacts',
    'device-identification',
    'multimedia-metadata',
  ]),

  // ─── A + Snaps — Snapchat-specific ───────────────────────────────────────
  'A+snaps': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'messages-content',
    'media',
    'snaps',
    'location-data',
    'internet-artifacts',
    'device-identification',
    'multimedia-metadata',
  ]),

  // ─── B — ISP / Carrier base ──────────────────────────────────────────────
  // Charter/Spectrum, Ultimate Internet, Zscaler — basic ISP subscriber +
  // connection records. Per plan §7 this is a "single paragraph" pattern.
  'B': Object.freeze([
    'subscriber-info',
    'payment-billing',
    'ip-history',
    'device-identification',
  ]),

  // ─── B + Telephony — TextNow (VoIP carrier) ──────────────────────────────
  'B+telephony': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'messages-content',
    'cdr',
    'device-identification',
  ]),

  // ─── B + CDR + Cell — T-Mobile / Sprint (full telecom carrier) ───────────
  'B+cdr+cell': Object.freeze([
    'subscriber-info',
    'payment-billing',
    'ip-history',
    'cdr',
    'cell-site',
    'device-identification',
  ]),

  // ─── C — Custom base (placeholder) ───────────────────────────────────────
  // Per plan §7 "C — Custom" is the catch-all for Microsoft / Yahoo /
  // Venmo / PayPal. v1 ships the minimum canonical core; the per-provider
  // variant patterns below extend it for those specific carriers.
  'C': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'messages-content',
    'media',
    'device-identification',
  ]),

  // ─── C + Transactions — Venmo / PayPal ───────────────────────────────────
  'C+transactions': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'transactions',
    'device-identification',
    'internet-artifacts',
  ]),

  // ─── Mail + Drive — Google / Microsoft / Yahoo (mailbox + cloud storage) ─
  'mail+drive': Object.freeze([
    'subscriber-info',
    'account-credentials',
    'payment-billing',
    'ip-history',
    'messages-content',
    'media',
    'drive',
    'location-data',
    'internet-artifacts',
    'device-identification',
    'multimedia-metadata',
  ]),

  // ─── Custom — user-picked items (empty default) ──────────────────────────
  'custom': Object.freeze([]),
});

// ─── PROVIDER → DEFAULT PATTERN MAP ────────────────────────────────────────
// First-class mapping for the 13 shipped providers (P2). Matches the
// itemsPattern hint embedded in SHIPPED_PROVIDERS. Kept here (and not
// imported from provider-directory.js) so this module stays standalone —
// the validator can look up a provider's default pattern without
// pulling the entire provider catalog.
const PROVIDER_DEFAULT_PATTERN = Object.freeze({
  // ESP / Social
  'snapchat':         'A+snaps',
  'tiktok':           'A',
  'twitter-x':        'A',
  'whatsapp':         'A',
  // Mail + cloud
  'google':           'mail+drive',
  'microsoft':        'mail+drive',
  'yahoo':            'mail+drive',
  // ISP
  'charter-spectrum': 'B',
  'ultimate-internet':'B',
  'zscaler':          'B',
  // Telecom
  'sprint-tmobile':   'B+cdr+cell',
  'text-now':         'B+telephony',
  // Financial
  'venmo-paypal':     'C+transactions',
});

// ─── INTERNAL INDEX ────────────────────────────────────────────────────────
const _ITEM_INDEX = (() => {
  const m = Object.create(null);
  for (const cat of CANONICAL_CATEGORIES) m[cat.key] = cat;
  for (const ex of PROVIDER_EXTRAS)       m[ex.key]  = ex;
  return Object.freeze(m);
})();

// ─── HELPERS ───────────────────────────────────────────────────────────────

/** Return the item record for a key, or null if unknown. */
function getItem(key) {
  return _ITEM_INDEX[key] || null;
}

/** Return all items in declaration order (canonical first, then extras). */
function allItems() {
  return CANONICAL_CATEGORIES.concat(PROVIDER_EXTRAS);
}

/** Returns true if a pattern key is registered. */
function isPattern(patternKey) {
  return Object.prototype.hasOwnProperty.call(PATTERN_BUNDLES, patternKey);
}

/**
 * Resolve a pattern key to a materialized list of item objects in the
 * canonical render order. Unknown keys → empty list. Unknown item keys
 * inside a pattern are silently dropped (defensive — keeps the composer
 * from blowing up on a typo'd item id).
 */
function resolvePattern(patternKey) {
  const keys = PATTERN_BUNDLES[patternKey];
  if (!keys) return [];
  const out = [];
  for (const k of keys) {
    const item = _ITEM_INDEX[k];
    if (item) out.push(item);
  }
  return out;
}

/** Resolve a pattern key to JUST the item keys (no item objects). */
function resolvePatternKeys(patternKey) {
  const keys = PATTERN_BUNDLES[patternKey];
  return keys ? keys.slice() : [];
}

/**
 * Return the default pattern key for a provider key. Falls back to
 * 'custom' if the provider has no shipped default — caller is expected
 * to honor the provider's own itemsPattern field when set.
 */
function defaultPatternFor(providerKey) {
  return PROVIDER_DEFAULT_PATTERN[providerKey] || 'custom';
}

/**
 * Resolve the items list for a provider object (as produced by
 * provider-directory.mergeProviders). Honors the provider's stored
 * itemsPattern first; falls back to the shipped default; finally
 * falls back to Pattern C.
 *   provider: { key, itemsPattern, ... }
 * Returns the same shape as resolvePattern().
 */
function resolveForProvider(provider) {
  if (!provider) return [];
  const p1 = provider.itemsPattern;
  if (p1 && isPattern(p1) && p1 !== 'custom') return resolvePattern(p1);
  const p2 = PROVIDER_DEFAULT_PATTERN[provider.key];
  if (p2) return resolvePattern(p2);
  return resolvePattern('C');
}

/** Human label for an item key, or the key itself if unknown. */
function labelFor(key) {
  const it = _ITEM_INDEX[key];
  return it ? it.label : key;
}

/** List of registered pattern keys in declaration order. */
function listPatternKeys() {
  return Object.keys(PATTERN_BUNDLES);
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────
const api = Object.freeze({
  SCHEMA_VERSION,
  CANONICAL_CATEGORIES,
  PROVIDER_EXTRAS,
  PATTERN_BUNDLES,
  PROVIDER_DEFAULT_PATTERN,
  // helpers
  getItem,
  allItems,
  isPattern,
  resolvePattern,
  resolvePatternKeys,
  defaultPatternFor,
  resolveForProvider,
  labelFor,
  listPatternKeys,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorItemsTaxonomy = api;
}

})();
