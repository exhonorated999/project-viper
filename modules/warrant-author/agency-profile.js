// modules/warrant-author/agency-profile.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure schema + validation module for the Warrant Author Agency Profile.
// No I/O — no localStorage reads, no IPC, no DOM. Both the renderer (settings
// page) and the main process (template slot resolver, P4+) consume this.
//
// Storage location: localStorage.viperAgencyProfile (renderer-side; see
// settings.html). Schema version is embedded so future migrations are
// detectable.
//
// Design notes:
//   • The shipped DEFAULTS object is intentionally EMPTY for identity fields
//     (agency name, affiant name, badge, etc.). We never want to ship someone
//     else's badge number as a placeholder.
//   • The trainingExperienceBoilerplate is shipped with a generic
//     "REPLACE THIS" template so the user knows what shape of prose is
//     expected. It is treated as REQUIRED.
//   • Default court name is shipped blank — administrative default that
//     pre-fills the affidavit caption, editable per draft.
//   • Per-warrant decisions (Hobbs sealing, night-search authorization,
//     specific judge, override-court) are NOT stored here. They are
//     selected on each warrant's authoring form.
//   • The required-field set is the validator's source of truth — both the
//     P1 settings form and the P7 hard validator (at generate-time) must
//     read REQUIRED_FIELDS from here, never duplicate the list.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// IIFE wrapper so top-level const/let don't pollute the renderer's shared
// classic-script scope (would collide with provider-directory.js etc.).
(function () {

const SCHEMA_VERSION = 1;

// ─── DEFAULTS ──────────────────────────────────────────────────────────────
// Everything an empty/fresh agency profile starts as. Identity fields stay
// blank — they MUST be filled in by the agency.
const DEFAULTS = Object.freeze({
  _schemaVersion: SCHEMA_VERSION,

  // ── Agency identity ─────────────────────────────────────────────────────
  agencyName: '',             // e.g. "Fontana Police Department"
  agencyShortName: '',        // e.g. "FPD"
  agencyAddress: '',          // single-line, full mailing address
  unit: '',                   // e.g. "Internet Crimes Against Children Unit"
  unitShort: '',              // e.g. "ICAC"
  county: '',                 // e.g. "San Bernardino"
  state: '',                  // 2-letter postal code, uppercase, e.g. "CA"

  // ── Affiant identity ────────────────────────────────────────────────────
  affiantName: '',            // full legal name
  affiantRank: '',            // e.g. "Detective", "Special Agent"
  affiantBadge: '',           // free text — some agencies use letters
  affiantEmail: '',
  affiantPhone: '',           // free text — formatting varies

  // ── Training & experience boilerplate ───────────────────────────────────
  // Long-form prose inserted into the affidavit's "Training & Experience"
  // section. Shipped placeholder makes the expected shape obvious.
  trainingExperienceBoilerplate:
    'REPLACE THIS — paragraph(s) describing your law-enforcement career, ' +
    'specialized training, certifications, prior warrants authored and ' +
    'reviewed, hours of instruction, and case experience relevant to ESP / ' +
    'electronic-evidence investigations.',

  // ── Administrative defaults (editable; shipped non-empty) ───────────────
  // The court name MUST be filled per jurisdiction. We ship an empty
  // string rather than a guess so the user makes a conscious choice.
  defaultCourtName: '',       // e.g. "Superior Court of California, County of San Bernardino"
  defaultJudgeName: '',       // optional — most agencies leave blank

  // ── Colorado-specific: multi-court support ──────────────────────────────
  // Many CO agencies straddle two or more Judicial Districts (e.g. Adams
  // County straddles the 17th JD and Denver-area courts). The user maintains
  // their own list of courts here and picks one per warrant in the
  // warrant-author module's CO court dropdown.
  //
  // Each entry shape:
  //   { id: 'crt_xxx', label: 'Adams Co. — 17th JD',
  //     courtName: 'COUNTY/DISTRICT COURT', judicialDistrict: '17th',
  //     county: 'Adams', isDefault: false }
  // List is ALWAYS user-added (empty by default — no presets shipped).
  coCourts: [],

  // ── Colorado-specific: District Attorney "Approved as to Form" block ────
  // Appears at the foot of the CO Search Warrant / Order page in every
  // sample exemplar. Both fields editable per draft if needed.
  daName: '',                  // e.g. "Brian Mason"
  daTitle: 'District Attorney',// rarely changes
  daDeputyLine: '[Chief][Senior] Deputy District Attorney', // bracketed pick-list

  // NOTE: Hobbs sealing + night-search are per-warrant selections, NOT
  // agency defaults. They live on the warrant authoring form (P3+) as
  // checkboxes the affiant ticks per case. Do not re-add them here.
});

// ─── REQUIRED FIELDS ───────────────────────────────────────────────────────
// Anything missing from this set blocks the P7 hard validator at generate-
// time and lights the red dot on the settings completeness indicator.
//
// Notably NOT required:
//   • agencyShortName / unitShort — useful for headers but optional
//   • defaultJudgeName — most agencies omit
//   • affiantEmail / affiantPhone — included on cover page but not blocking
//   • county — derivable from defaultCourtName for most CA agencies
const REQUIRED_FIELDS = Object.freeze([
  'agencyName',
  'agencyAddress',
  'unit',
  'state',
  'affiantName',
  'affiantRank',
  'affiantBadge',
  'trainingExperienceBoilerplate',
  'defaultCourtName',
]);

// ─── FIELD METADATA ────────────────────────────────────────────────────────
// Used by the settings form to render labels, helper text, input types, and
// constraints. Keeping this here (alongside DEFAULTS + REQUIRED) means the
// form template in settings.html can be regenerated from a single source.
const FIELDS = Object.freeze([
  // Agency block
  { key: 'agencyName',         label: 'Agency Name',         group: 'agency',  type: 'text',      placeholder: 'Fontana Police Department',                helper: 'Full legal name of your agency.' },
  { key: 'agencyShortName',    label: 'Agency Short Name',   group: 'agency',  type: 'text',      placeholder: 'FPD',                                      helper: 'Abbreviation used in headers / footers.' },
  { key: 'agencyAddress',      label: 'Agency Address',      group: 'agency',  type: 'text',      placeholder: '17005 Upland Ave, Fontana, CA 92335',      helper: 'Mailing address printed on the affidavit cover.' },
  { key: 'unit',               label: 'Unit / Bureau',       group: 'agency',  type: 'text',      placeholder: 'Internet Crimes Against Children Unit',    helper: 'Full unit name.' },
  { key: 'unitShort',          label: 'Unit Short Name',     group: 'agency',  type: 'text',      placeholder: 'ICAC',                                     helper: 'Abbreviation used in headers.' },
  { key: 'county',             label: 'County',              group: 'agency',  type: 'text',      placeholder: 'San Bernardino',                           helper: 'County the agency operates in.' },
  { key: 'state',              label: 'State',               group: 'agency',  type: 'text',      placeholder: 'CA', maxlength: 2,                         helper: 'Two-letter postal code.' },

  // Affiant block
  { key: 'affiantName',        label: 'Affiant Name',        group: 'affiant', type: 'text',      placeholder: 'Justin Moyer',                             helper: 'Full legal name as it will appear on the affidavit.' },
  { key: 'affiantRank',        label: 'Rank / Title',        group: 'affiant', type: 'text',      placeholder: 'Detective',                                helper: 'e.g. Detective, Special Agent, Investigator.' },
  { key: 'affiantBadge',       label: 'Badge / ID #',        group: 'affiant', type: 'text',      placeholder: '1234',                                     helper: 'Some agencies use letters — free text.' },
  { key: 'affiantEmail',       label: 'Email',               group: 'affiant', type: 'email',     placeholder: 'jmoyer@fontana.org',                       helper: 'Contact email for the providers / court.' },
  { key: 'affiantPhone',       label: 'Phone',               group: 'affiant', type: 'text',      placeholder: '(909) 356-7168',                           helper: 'Contact phone for the providers / court.' },

  // Defaults block
  { key: 'defaultCourtName',   label: 'Default Court Name',  group: 'defaults', type: 'text',     placeholder: 'Superior Court of California, County of San Bernardino', helper: 'Pre-fills the affidavit caption; editable per draft.' },

  // Colorado-specific block (DA approval-as-to-form line)
  { key: 'daName',             label: 'District Attorney Name',        group: 'colorado', type: 'text', placeholder: 'Brian Mason',                          helper: 'Appears on the CO "APPROVED AS TO FORM" block.' },
  { key: 'daTitle',            label: 'DA Title',                       group: 'colorado', type: 'text', placeholder: 'District Attorney',                    helper: 'Almost always "District Attorney".' },
  { key: 'daDeputyLine',       label: 'Deputy DA Line',                 group: 'colorado', type: 'text', placeholder: '[Chief][Senior] Deputy District Attorney', helper: 'Bracketed pick-list shown beneath the DA signature.' },

  // Training & experience block (textarea, full-width)
  { key: 'trainingExperienceBoilerplate', label: 'Training & Experience Boilerplate', group: 'training', type: 'textarea', rows: 10,
    placeholder: 'Describe your law-enforcement career, specialized training, certifications, prior warrants authored and reviewed, and case experience relevant to ESP / electronic-evidence investigations.',
    helper: 'Inserted into the "Training & Experience" section of every affidavit. Long-form prose — edit per draft if needed.' },
]);

const FIELD_GROUPS = Object.freeze([
  { id: 'agency',   label: 'Agency Identity',   helper: 'Identifies your agency on the warrant caption + cover page.' },
  { id: 'affiant',  label: 'Affiant Identity',  helper: 'Identifies you (the affiant) on the affidavit + signature block.' },
  { id: 'defaults', label: 'Administrative Defaults', helper: 'Pre-fill these on every new draft. You can override per-warrant.' },
  { id: 'colorado', label: 'Colorado-Specific',  helper: 'Used only by the CO Multi-Business ESP template. Add your courts and DA below.' },
  { id: 'training', label: 'Training & Experience', helper: 'Re-usable boilerplate paragraph. Verbatim prose — review with your DA.' },
]);

// ─── PURE HELPERS ──────────────────────────────────────────────────────────

/** Returns a fresh defaults object (mutable shallow clone). */
function freshProfile() {
  return Object.assign({}, DEFAULTS);
}

/**
 * Merges a partial/stored profile over the defaults, dropping unknown keys
 * and coercing missing fields back to their defaults. Used on read.
 *
 * Migration shim: callers that loaded an older _schemaVersion can bump it
 * here. For v1 there is nothing to migrate.
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return freshProfile();
  const out = freshProfile();
  for (const f of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, f.key) && typeof raw[f.key] === 'string') {
      out[f.key] = raw[f.key];
    }
  }
  // state code normalisation — uppercase, max 2 chars
  if (typeof out.state === 'string') out.state = out.state.trim().toUpperCase().slice(0, 2);
  // Colorado courts list — array of {id, label, courtName, judicialDistrict,
  // county, isDefault}. Drop unknown keys and coerce strings; force exactly
  // one isDefault if any entries exist.
  if (Array.isArray(raw.coCourts)) {
    const cleaned = [];
    for (const c of raw.coCourts) {
      if (!c || typeof c !== 'object') continue;
      const id = String(c.id || '').trim();
      cleaned.push({
        id: id || _newCourtId(),
        label: String(c.label || '').trim(),
        courtName: String(c.courtName || 'COUNTY/DISTRICT COURT').trim(),
        judicialDistrict: String(c.judicialDistrict || '').trim(),
        county: String(c.county || '').trim(),
        isDefault: !!c.isDefault,
      });
    }
    // At most one default. If zero are flagged but the list is non-empty,
    // promote the first entry so the dropdown always has a sane default.
    let defaultIdx = cleaned.findIndex(c => c.isDefault);
    if (defaultIdx === -1 && cleaned.length) {
      cleaned[0].isDefault = true;
      defaultIdx = 0;
    }
    cleaned.forEach((c, i) => { c.isDefault = (i === defaultIdx); });
    out.coCourts = cleaned;
  } else {
    out.coCourts = [];
  }
  out._schemaVersion = SCHEMA_VERSION;
  return out;
}

// ─── Colorado courts: pure mutation helpers ────────────────────────────────
// Return a NEW profile object — callers persist it themselves.

function _newCourtId() {
  // Short opaque id; collisions are practically impossible at agency scale.
  return 'crt_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Insert a new CO court entry. If it's the first entry OR the user marks
 * it default, it becomes the sole default and demotes any prior default.
 */
function addCoCourt(profile, court) {
  const p = normalize(profile);
  const entry = {
    id: _newCourtId(),
    label: String((court && court.label) || '').trim(),
    courtName: String((court && court.courtName) || 'COUNTY/DISTRICT COURT').trim(),
    judicialDistrict: String((court && court.judicialDistrict) || '').trim(),
    county: String((court && court.county) || '').trim(),
    isDefault: !!(court && court.isDefault),
  };
  const list = p.coCourts.slice();
  if (entry.isDefault || list.length === 0) {
    list.forEach(c => { c.isDefault = false; });
    entry.isDefault = true;
  }
  list.push(entry);
  p.coCourts = list;
  return p;
}

/** Update fields on an existing court by id. */
function updateCoCourt(profile, id, patch) {
  const p = normalize(profile);
  const list = p.coCourts.slice();
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return p;
  const current = list[idx];
  list[idx] = Object.assign({}, current, {
    label: patch && 'label' in patch ? String(patch.label || '').trim() : current.label,
    courtName: patch && 'courtName' in patch ? String(patch.courtName || 'COUNTY/DISTRICT COURT').trim() : current.courtName,
    judicialDistrict: patch && 'judicialDistrict' in patch ? String(patch.judicialDistrict || '').trim() : current.judicialDistrict,
    county: patch && 'county' in patch ? String(patch.county || '').trim() : current.county,
  });
  p.coCourts = list;
  return p;
}

/** Delete a court by id. Promotes another entry to default if needed. */
function deleteCoCourt(profile, id) {
  const p = normalize(profile);
  const wasDefault = !!(p.coCourts.find(c => c.id === id) || {}).isDefault;
  const list = p.coCourts.filter(c => c.id !== id);
  if (wasDefault && list.length) list[0].isDefault = true;
  p.coCourts = list;
  return p;
}

/** Flip the default flag to the given id, demoting all others. */
function setCoCourtDefault(profile, id) {
  const p = normalize(profile);
  const list = p.coCourts.map(c => Object.assign({}, c, { isDefault: c.id === id }));
  p.coCourts = list;
  return p;
}

/** Returns the default court entry, or null. */
function getDefaultCoCourt(profile) {
  const p = normalize(profile);
  return p.coCourts.find(c => c.isDefault) || (p.coCourts[0] || null);
}

/** Look up a court by id, falling back to the default. */
function getCoCourtById(profile, id) {
  const p = normalize(profile);
  if (id) {
    const match = p.coCourts.find(c => c.id === id);
    if (match) return match;
  }
  return getDefaultCoCourt(p);
}

/**
 * Returns the list of required-field keys that are missing or blank in the
 * given profile. Empty list ⇒ profile is complete.
 *
 * "Blank" = empty string OR whitespace-only OR the shipped REPLACE-THIS
 * placeholder for trainingExperienceBoilerplate.
 */
function findMissingRequired(profile) {
  const p = normalize(profile);
  const missing = [];
  for (const key of REQUIRED_FIELDS) {
    const v = (p[key] || '').toString().trim();
    if (!v) { missing.push(key); continue; }
    // Reject the shipped placeholder for training/experience boilerplate.
    if (key === 'trainingExperienceBoilerplate' && /^REPLACE THIS\b/i.test(v)) {
      missing.push(key);
    }
  }
  return missing;
}

/** True when zero required fields are missing. */
function isComplete(profile) {
  return findMissingRequired(profile).length === 0;
}

/**
 * Returns a completeness ratio (0–1) for the progress indicator.
 *
 * Filled required / total required.
 */
function completenessRatio(profile) {
  if (REQUIRED_FIELDS.length === 0) return 1;
  const missing = findMissingRequired(profile).length;
  return (REQUIRED_FIELDS.length - missing) / REQUIRED_FIELDS.length;
}

/** Returns the human label for a field key, or the key itself if unknown. */
function labelFor(key) {
  const f = FIELDS.find(x => x.key === key);
  return f ? f.label : key;
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────
// Dual export pattern — node (main-process consumers) and browser (renderer
// loads via <script> tag and reads window.WarrantAuthorAgencyProfile).

const api = Object.freeze({
  SCHEMA_VERSION,
  DEFAULTS,
  REQUIRED_FIELDS,
  FIELDS,
  FIELD_GROUPS,
  freshProfile,
  normalize,
  findMissingRequired,
  isComplete,
  completenessRatio,
  labelFor,
  // Colorado multi-court helpers
  addCoCourt,
  updateCoCourt,
  deleteCoCourt,
  setCoCourtDefault,
  getDefaultCoCourt,
  getCoCourtById,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorAgencyProfile = api;
}

})();
