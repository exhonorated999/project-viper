// modules/warrant-author/validator.js
// Validator — hard errors + soft warnings for the Warrant Author.
//
// Phase P7 implementation.
//
// API:
//   validateDraft({
//     draft,                  // draft object (see draft-store.js shape)
//     agency,                 // agency profile object (viperAgencyProfile)
//     providers,              // array of merged provider records (optional)
//     pcNarrative,            // case-level PC narrative (optional, falls
//                             // back to draft.probableCauseNarrative)
//     composeResults,         // optional: [{addendumId, danglingSlots:[],
//                             //            missingItems:bool|[]}]
//     today,                  // optional Date — for test stability
//   }) → {
//     errors:   [{id, code, label, scope, addendumId?, fieldPath?, ...}],
//     warnings: [...],
//     ok: bool,               // true when errors.length === 0
//     stats: { addendumCount, errorCount, warningCount, hardBlockers:[codes] },
//   }
//
// HARD ERRORS (block generation):
//   AGENCY_PROFILE_INCOMPLETE — required agency-profile field missing
//   DRAFT_NO_ADDENDUMS        — draft has zero addendums
//   ADDENDUM_NO_PROVIDER      — addendum.providerKey is empty
//   ADDENDUM_NO_BUSINESS      — providerKey is custom-provider sentinel but
//                               businessNameSnapshot is empty
//   ADDENDUM_NO_TARGETS       — addendum has zero non-empty target accounts
//   ADDENDUM_NO_DATE_RANGE    — neither dateRange nor allDatesAvailable set
//   ADDENDUM_INVERTED_RANGE   — dateRangeFrom > dateRangeTo
//   ADDENDUM_BAD_YEAR         — year in From or To is < 1990 or > 2100
//                               (typo guard — usually "25" entered without
//                               the "20" prefix becomes year 25 / 0025)
//   PC_NARRATIVE_EMPTY        — case PC narrative empty
//   PC_1524_GROUNDS_NONE      — every §1524 ground checkbox unchecked
//   COMPOSE_DANGLING_SLOTS    — engine reported unresolved {{slot}}s
//
// SOFT WARNINGS (panel only):
//   AGENCY_AFFIANT_CONTACT_BLANK   — affiant email + phone both empty
//   ADDENDUM_DATE_RANGE_LONG       — range exceeds 365 days
//   ADDENDUM_DATE_RANGE_FUTURE     — dateRangeTo > today
//   ADDENDUM_ITEMS_EMPTY           — itemsToProduce array empty
//   ADDENDUM_NDO_OVER_CAP          — nonDisclosureDays > 90 (CA cap)
//   ADDENDUM_TARGET_SUSPICIOUS     — target value looks like a hash/UUID
//                                    when provider expects username/email
//   HOBBS_SEALING_NO_ARTICULATION  — hobbsSealing='requested' but the PC
//                                    narrative never mentions "hobbs"
//   NIGHT_SEARCH_NO_ARTICULATION   — nightSearch='requested' but the PC
//                                    narrative never mentions night-search
//                                    necessity ('night', 'destruction',
//                                    'imminent')
//   AGENCY_TRAINING_PLACEHOLDER    — trainingExperienceBoilerplate still
//                                    starts with the shipped "REPLACE THIS"
//                                    sentinel
//
// NOT VALIDATED (structurally implicit / out-of-band):
//   draft.caseRef  — auto-filled from window.currentCase.caseNumber by
//                    _renderEditor; never user-facing as a required field.
//   draft.swNumber — assigned by the court after the judge signs (Mark
//                    Served flow), not knowable at authoring time.
//
// All issues use a stable string `id` so the UI can dedupe and remember
// "dismissed" toggles between renders.

'use strict';

// ─── constants ──────────────────────────────────────────────────────────

const REQUIRED_AGENCY_FIELDS = Object.freeze([
    { key: 'agencyName',                     label: 'Agency Name' },
    { key: 'agencyAddress',                  label: 'Agency Address' },
    { key: 'unit',                           label: 'Unit / Bureau' },
    { key: 'state',                          label: 'State' },
    { key: 'affiantName',                    label: 'Affiant Name' },
    { key: 'affiantRank',                    label: 'Affiant Rank' },
    { key: 'affiantBadge',                   label: 'Affiant Badge' },
    { key: 'trainingExperienceBoilerplate',  label: 'Training & Experience Boilerplate' },
    { key: 'defaultCourtName',               label: 'Default Court Name' },
]);

const MS_PER_DAY = 86400000;
const NDO_CA_CAP_DAYS = 90;
const DATE_RANGE_LONG_DAYS = 365;
const DATE_YEAR_MIN = 1990;
const DATE_YEAR_MAX = 2100;
const TRAINING_PLACEHOLDER_PREFIX = 'REPLACE THIS';

// ─── helpers ────────────────────────────────────────────────────────────

function _isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
}

function _parseDate(s) {
    if (!s) return null;
    if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
    // accept YYYY-MM-DD (input[type=date]) or any Date.parse-able string
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function _daysBetween(a, b) {
    if (!a || !b) return 0;
    return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

function _isHashLike(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    // hex-ish blobs 24+ chars long, no spaces, mostly hex chars
    if (v.length < 24) return false;
    if (/\s/.test(v)) return false;
    const hexish = (v.match(/[0-9a-f]/gi) || []).length;
    return hexish / v.length >= 0.85;
}

function _safeStr(v) { return v == null ? '' : String(v); }

function _addendumLabel(ad, idx) {
    return ad && ad.pageLabel ? String(ad.pageLabel)
         : String.fromCharCode(65 + (idx || 0));
}

function _providerDisplayName(ad, providers) {
    if (ad && ad.providerNameOverride) return ad.providerNameOverride;
    if (Array.isArray(providers)) {
        const p = providers.find(x => x && x.key === ad.providerKey);
        if (p && p.name) return p.name;
    }
    return ad && ad.providerKey ? ad.providerKey : '(no provider)';
}

function _provider(ad, providers) {
    if (!Array.isArray(providers)) return null;
    return providers.find(p => p && p.key === ad && ad.providerKey) || null;
}

// ─── issue factories ────────────────────────────────────────────────────

function _err(id, code, label, extra) {
    return Object.assign({ id, code, label, severity: 'error' }, extra || {});
}
function _warn(id, code, label, extra) {
    return Object.assign({ id, code, label, severity: 'warning' }, extra || {});
}

// ─── public API ─────────────────────────────────────────────────────────

function validateDraft(input) {
    input = input || {};
    const draft    = input.draft    || {};
    const agency   = input.agency   || {};
    const providers = Array.isArray(input.providers) ? input.providers : null;
    const today    = input.today instanceof Date ? input.today : new Date();
    const composeResults = Array.isArray(input.composeResults) ? input.composeResults : [];

    const errors = [];
    const warnings = [];

    // ── 1. Agency profile completeness ─────────────────────────────────
    const missingAgency = [];
    for (const f of REQUIRED_AGENCY_FIELDS) {
        if (_isEmpty(agency[f.key])) missingAgency.push(f);
    }
    if (missingAgency.length) {
        errors.push(_err(
            'agency.profile.incomplete',
            'AGENCY_PROFILE_INCOMPLETE',
            'Agency profile missing ' + missingAgency.length + ' required field' +
              (missingAgency.length === 1 ? '' : 's') + ' — open Settings → Warrant Author → Agency Profile.',
            { scope: 'agency', missing: missingAgency.map(f => f.key), detail: missingAgency.map(f => f.label).join(', ') }
        ));
    }

    // training boilerplate still the shipped placeholder?
    if (typeof agency.trainingExperienceBoilerplate === 'string' &&
        agency.trainingExperienceBoilerplate.trim().startsWith(TRAINING_PLACEHOLDER_PREFIX)) {
        warnings.push(_warn(
            'agency.training.placeholder',
            'AGENCY_TRAINING_PLACEHOLDER',
            'Training & Experience boilerplate still contains the shipped REPLACE THIS placeholder.',
            { scope: 'agency', fieldPath: 'agency.trainingExperienceBoilerplate' }
        ));
    }

    // affiant contact (soft — both empty is suspicious)
    if (_isEmpty(agency.affiantEmail) && _isEmpty(agency.affiantPhone)) {
        warnings.push(_warn(
            'agency.affiant.contact.blank',
            'AGENCY_AFFIANT_CONTACT_BLANK',
            'Affiant has no contact email or phone in Agency Profile — providers cannot reach you.',
            { scope: 'agency' }
        ));
    }

    // ── 2. Draft-level checks ─────────────────────────────────────────
    // Note: caseRef + swNumber are intentionally NOT validated here.
    //   • caseRef is structurally implicit — the Warrant Author is always
    //     opened from a case context, and _renderEditor auto-fills
    //     draft.caseRef from window.currentCase.caseNumber on every
    //     paint. Asking the user to "fix" an empty field they never see
    //     is friction, not safety.
    //   • swNumber is assigned BY THE COURT after the judge signs, via
    //     the Mark-Served flow. The affiant cannot know it at authoring
    //     time. Warning about it at generate time is structurally wrong.

    const pcNarrative = _safeStr(input.pcNarrative || draft.probableCauseNarrative);
    if (_isEmpty(pcNarrative)) {
        errors.push(_err(
            'draft.pc.empty',
            'PC_NARRATIVE_EMPTY',
            'Probable cause narrative is empty.',
            { scope: 'draft', fieldPath: 'draft.probableCauseNarrative' }
        ));
    }

    // §1524 grounds — at least one ticked.
    // CA-only: PC §1524 is a California Penal Code provision. Virginia
    // search-warrant grounds are governed by Va. Code §§ 19.2-53 / 19.2-54
    // (handled via the DC-338 form's item-1-through-7 checkboxes in the
    // VA block builder, not via draft.pc1524Grounds). Generic-US drafts
    // also skip this check — the underlying federal SCA does not have a
    // numbered-grounds taxonomy.  Colorado warrants cite C.R.S. §16-3-301
    // and §19-2.5-205 (not PC §1524) so they ALSO skip this check.
    //
    // Routing: explicit draft.jurisdiction wins. Otherwise we sniff the
    // template prefix. A draft with BOTH fields empty is treated as
    // legacy CA — the validator predates the multi-jurisdiction field
    // and existing CA drafts must keep firing this check.
    const _jx = String(draft.jurisdiction || '').toUpperCase();
    const _tpl = String(draft.template || '');
    let _isCaJurisdiction;
    let _isCoJurisdiction;
    if (_jx) {
        _isCaJurisdiction = (_jx === 'CA');
        _isCoJurisdiction = (_jx === 'CO');
    } else if (_tpl) {
        _isCaJurisdiction = _tpl.startsWith('ca-');
        _isCoJurisdiction = _tpl.startsWith('co-');
    } else {
        // Fully empty draft → legacy default = CA.
        _isCaJurisdiction = true;
        _isCoJurisdiction = false;
    }
    if (_isCaJurisdiction) {
        const grounds = (draft.pc1524Grounds && typeof draft.pc1524Grounds === 'object') ? draft.pc1524Grounds : {};
        const anyGround = Object.values(grounds).some(v => v === true);
        if (!anyGround) {
            errors.push(_err(
                'draft.pc1524.none',
                'PC_1524_GROUNDS_NONE',
                'No §1524 grounds checkbox is ticked.',
                { scope: 'draft', fieldPath: 'draft.pc1524Grounds' }
            ));
        }
    }

    // ── CO-specific checks (court selection + DA name) ──────────────────
    if (_isCoJurisdiction) {
        // 1) A court must be selected. The agency profile holds the list
        //    of CO courts; the draft holds the chosen id (coCourtId).
        const coCourtId = String(draft.coCourtId || '').trim();
        const apCourts = Array.isArray(agency.coCourts) ? agency.coCourts : [];
        if (!apCourts.length) {
            errors.push(_err(
                'draft.coCourt.profileEmpty',
                'CO_COURT_PROFILE_EMPTY',
                'Agency profile has no Colorado courts on file. Add at least one under Settings → Agency Profile → Colorado Courts before generating.',
                { scope: 'agency', fieldPath: 'agency.coCourts' }
            ));
        } else if (!coCourtId || !apCourts.find(c => c.id === coCourtId)) {
            errors.push(_err(
                'draft.coCourt.unselected',
                'CO_COURT_UNSELECTED',
                'No Colorado court selected on this draft. Pick one from the dropdown in the draft header.',
                { scope: 'draft', fieldPath: 'draft.coCourtId' }
            ));
        }
        // 2) DA name warning — the "APPROVED AS TO FORM" block reads
        //    awkwardly with "[District Attorney Name]" as a placeholder.
        const daName = String(agency.daName || '').trim();
        if (!daName) {
            warnings.push(_warn(
                'agency.daName.empty',
                'CO_DA_NAME_EMPTY',
                'No District Attorney name on file — the CO "APPROVED AS TO FORM" block will print a [placeholder]. Set it under Settings → Agency Profile → Colorado-Specific.',
                { scope: 'agency', fieldPath: 'agency.daName' }
            ));
        }
        // 3) Offense description + date — used by CO templates'
        //    "*These records will be searched for evidence pertaining..." line.
        if (!String(draft.offenseDescription || '').trim()) {
            warnings.push(_warn(
                'draft.offenseDescription.empty',
                'CO_OFFENSE_DESCRIPTION_EMPTY',
                'No offense description on draft — the CO warrant will print "[case offense]" as a placeholder.',
                { scope: 'draft', fieldPath: 'draft.offenseDescription' }
            ));
        }
        if (!String(draft.offenseDate || '').trim()) {
            warnings.push(_warn(
                'draft.offenseDate.empty',
                'CO_OFFENSE_DATE_EMPTY',
                'No offense date on draft — the CO warrant will print "[offense date]" as a placeholder.',
                { scope: 'draft', fieldPath: 'draft.offenseDate' }
            ));
        }
    }

    // Hobbs articulation warning
    if (draft.hobbsSealing === 'requested' && pcNarrative && !/hobbs/i.test(pcNarrative)) {
        warnings.push(_warn(
            'draft.hobbs.no.articulation',
            'HOBBS_SEALING_NO_ARTICULATION',
            'Hobbs sealing requested but the PC narrative does not mention "Hobbs".',
            { scope: 'draft', fieldPath: 'draft.hobbsSealing' }
        ));
    }

    // Night-search articulation
    if (draft.nightSearch === 'requested' && pcNarrative &&
        !/(night|destruction|imminent|exigent)/i.test(pcNarrative)) {
        warnings.push(_warn(
            'draft.nightsearch.no.articulation',
            'NIGHT_SEARCH_NO_ARTICULATION',
            'Night-service requested but PC narrative does not articulate necessity (night/destruction/imminent/exigent).',
            { scope: 'draft', fieldPath: 'draft.nightSearch' }
        ));
    }

    // ── 3. Addendums ──────────────────────────────────────────────────
    const ads = Array.isArray(draft.addendums) ? draft.addendums : [];
    if (!ads.length) {
        errors.push(_err(
            'draft.addendums.none',
            'DRAFT_NO_ADDENDUMS',
            'Draft has zero addendums — add at least one business / ESP.',
            { scope: 'draft', fieldPath: 'draft.addendums' }
        ));
    }

    ads.forEach((ad, idx) => {
        const label = _addendumLabel(ad, idx);
        const provName = _providerDisplayName(ad, providers);
        const scope = 'addendum';
        const ctx = { scope, addendumId: ad.id || null, pageLabel: label, providerName: provName };

        // provider
        if (_isEmpty(ad.providerKey)) {
            errors.push(_err(
                'ad.' + (ad.id || idx) + '.provider.empty',
                'ADDENDUM_NO_PROVIDER',
                'Page ' + label + ': no provider selected.',
                Object.assign({}, ctx, { fieldPath: 'addendum.providerKey' })
            ));
        }

        // custom-provider sentinel requires explicit business name
        if (ad.providerKey === '_custom' && _isEmpty(ad.businessNameSnapshot)) {
            errors.push(_err(
                'ad.' + (ad.id || idx) + '.business.empty',
                'ADDENDUM_NO_BUSINESS',
                'Page ' + label + ': custom provider selected but no business name supplied.',
                Object.assign({}, ctx, { fieldPath: 'addendum.businessNameSnapshot' })
            ));
        }

        // targets
        const targets = Array.isArray(ad.targetAccounts) ? ad.targetAccounts : [];
        const liveTargets = targets.filter(t => t && !_isEmpty(t.value));
        if (!liveTargets.length) {
            errors.push(_err(
                'ad.' + (ad.id || idx) + '.targets.empty',
                'ADDENDUM_NO_TARGETS',
                'Page ' + label + ' (' + provName + '): no target accounts entered.',
                Object.assign({}, ctx, { fieldPath: 'addendum.targetAccounts' })
            ));
        }

        // hash-like target heuristic for ESPs that take usernames/emails
        liveTargets.forEach((t, ti) => {
            if (_isHashLike(t.value)) {
                warnings.push(_warn(
                    'ad.' + (ad.id || idx) + '.target.' + ti + '.hashlike',
                    'ADDENDUM_TARGET_SUSPICIOUS',
                    'Page ' + label + ': target "' + _safeStr(t.value).slice(0, 24) + '…" looks hash-like — confirm provider accepts this as an account identifier.',
                    Object.assign({}, ctx, { fieldPath: 'addendum.targetAccounts[' + ti + '].value' })
                ));
            }
        });

        // date range
        const hasFrom = !_isEmpty(ad.dateRangeFrom);
        const hasTo   = !_isEmpty(ad.dateRangeTo);
        const allDates = !!ad.allDatesAvailable;
        if (!allDates && (!hasFrom || !hasTo)) {
            errors.push(_err(
                'ad.' + (ad.id || idx) + '.daterange.empty',
                'ADDENDUM_NO_DATE_RANGE',
                'Page ' + label + ': date range incomplete (need both From and To, or tick "all available dates").',
                Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeFrom' })
            ));
        }
        if (hasFrom && hasTo) {
            const from = _parseDate(ad.dateRangeFrom);
            const to   = _parseDate(ad.dateRangeTo);
            // Year sanity — catches the "user typed 25 not 2025" trap
            // BEFORE the inverted-range check (which is the downstream
            // symptom and confuses the user about the real fix).
            const yearOf = (s) => {
                const m = String(s || '').match(/^(\d{1,4})-/);
                return m ? parseInt(m[1], 10) : NaN;
            };
            const fy = yearOf(ad.dateRangeFrom);
            const ty = yearOf(ad.dateRangeTo);
            const badYears = [];
            if (!isNaN(fy) && (fy < DATE_YEAR_MIN || fy > DATE_YEAR_MAX)) {
                badYears.push('From year ' + String(fy).padStart(4, '0'));
            }
            if (!isNaN(ty) && (ty < DATE_YEAR_MIN || ty > DATE_YEAR_MAX)) {
                badYears.push('To year ' + String(ty).padStart(4, '0'));
            }
            if (badYears.length) {
                errors.push(_err(
                    'ad.' + (ad.id || idx) + '.daterange.badyear',
                    'ADDENDUM_BAD_YEAR',
                    'Page ' + label + ': ' + badYears.join(', ') +
                        ' — year must be between ' + DATE_YEAR_MIN + ' and ' + DATE_YEAR_MAX +
                        ' (likely typo — re-enter with full 4-digit year).',
                    Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeFrom' })
                ));
            }
            if (from && to) {
                if (from.getTime() > to.getTime()) {
                    // Skip the inverted error if a bad-year error already
                    // explains the real problem — no need to double up.
                    if (!badYears.length) {
                        errors.push(_err(
                            'ad.' + (ad.id || idx) + '.daterange.inverted',
                            'ADDENDUM_INVERTED_RANGE',
                            'Page ' + label + ': date range is inverted (From after To).',
                            Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeFrom' })
                        ));
                    }
                } else {
                    const days = _daysBetween(from, to);
                    if (days > DATE_RANGE_LONG_DAYS) {
                        warnings.push(_warn(
                            'ad.' + (ad.id || idx) + '.daterange.long',
                            'ADDENDUM_DATE_RANGE_LONG',
                            'Page ' + label + ': date range is ' + days + ' days (> 365). Long windows are common rejection grounds.',
                            Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeTo' })
                        ));
                    }
                }
                if (to.getTime() > today.getTime() + MS_PER_DAY) {
                    warnings.push(_warn(
                        'ad.' + (ad.id || idx) + '.daterange.future',
                        'ADDENDUM_DATE_RANGE_FUTURE',
                        'Page ' + label + ': "To" date is in the future — likely typo.',
                        Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeTo' })
                    ));
                }
            }
        }

        // items to produce
        const items = Array.isArray(ad.itemsToProduce) ? ad.itemsToProduce : [];
        if (!items.length && _isEmpty(ad.itemsCustomText)) {
            warnings.push(_warn(
                'ad.' + (ad.id || idx) + '.items.empty',
                'ADDENDUM_ITEMS_EMPTY',
                'Page ' + label + ': no items-to-seize selected — the template will render an empty list.',
                Object.assign({}, ctx, { fieldPath: 'addendum.itemsToProduce' })
            ));
        }

        // non-disclosure days cap
        const ndoDays = Number(ad.nonDisclosureDays);
        if (Number.isFinite(ndoDays) && ndoDays > NDO_CA_CAP_DAYS) {
            warnings.push(_warn(
                'ad.' + (ad.id || idx) + '.ndo.over',
                'ADDENDUM_NDO_OVER_CAP',
                'Page ' + label + ': non-disclosure ' + ndoDays + ' days exceeds CA 90-day cap — requires court extension.',
                Object.assign({}, ctx, { fieldPath: 'addendum.nonDisclosureDays' })
            ));
        }
    });

    // ── 4. Compose results (dangling slots / missing items) ────────────
    composeResults.forEach((cr, ci) => {
        if (!cr) return;
        const dangling = Array.isArray(cr.danglingSlots) ? cr.danglingSlots : [];
        const ad = ads.find(a => a && a.id === cr.addendumId) || ads[ci] || {};
        const label = _addendumLabel(ad, ci);
        if (dangling.length) {
            errors.push(_err(
                'ad.' + (cr.addendumId || ci) + '.compose.dangling',
                'COMPOSE_DANGLING_SLOTS',
                'Page ' + label + ': ' + dangling.length + ' unresolved {{slot}}' +
                  (dangling.length === 1 ? '' : 's') + ' — fix before generating.',
                { scope: 'compose', addendumId: cr.addendumId || null, pageLabel: label, slots: dangling }
            ));
        }
    });

    // ── 5. Summary ─────────────────────────────────────────────────────
    return {
        errors,
        warnings,
        ok: errors.length === 0,
        stats: {
            addendumCount: ads.length,
            errorCount: errors.length,
            warningCount: warnings.length,
            hardBlockers: Array.from(new Set(errors.map(e => e.code))),
        },
    };
}

// ─── residential validator ──────────────────────────────────────────────
//
// validateResidential({ draft, agency, pcNarrative, today }) → same shape
// as validateDraft: { errors, warnings, ok, stats }
//
// Residential drafts do NOT use addendums / providers — instead they
// describe a single premises with offenses, items-to-seize blocks, and
// optional clauses. The Statement of Probable Cause is sourced from
// the CASE-LEVEL `pcNarrative` (shared across all warrants in the case)
// — NOT from a per-draft SOPC array. The legacy `draft.residential.sopc`
// substructure is retained for back-compat but ignored.
//
// HARD ERRORS:
//   AGENCY_PROFILE_INCOMPLETE             — same fields as ESP
//   RESIDENTIAL_NO_PREMISES_ADDRESS       — premises.address blank
//   RESIDENTIAL_NO_LEGAL_DESCRIPTION      — premises.legalDescription blank
//   RESIDENTIAL_NO_OFFENSES               — offenses array has no usable row
//   RESIDENTIAL_NO_ITEMS_TO_SEIZE         — itemsToSeize.blocks has no usable block
//   PC_NARRATIVE_EMPTY                    — case-level pcNarrative blank
//                                           (Case Probable Cause not authored)
//   PC_1524_GROUNDS_NONE                  — every §1524 toggle false
//   RESIDENTIAL_NIGHT_NO_JUSTIFICATION    — nightService.enabled but
//                                           justification blank
//   RESIDENTIAL_HOBBS_NO_JUSTIFICATION    — hobbsSealing.enabled but
//                                           justification blank
//   RESIDENTIAL_TE_INLINE_EMPTY           — trainingExperience.mode='inline'
//                                           but inlineBody blank/placeholder
//
// SOFT WARNINGS:
//   AGENCY_AFFIANT_CONTACT_BLANK          — same as ESP
//   AGENCY_TRAINING_PLACEHOLDER           — same as ESP (only relevant when
//                                           T&E mode='profile')
//   RESIDENTIAL_NO_SUSPECTS               — no suspect rows (informational)
//   RESIDENTIAL_OFFENSE_ROW_PARTIAL       — at least one row has code w/o
//                                           label or label w/o code
//   RESIDENTIAL_ITEM_BLOCK_BLANK_BODY     — block has label but blank body
//   RESIDENTIAL_EXECUTED_AT_BLANK         — executedAt.city or .date blank
//                                           (court/date stamp incomplete)
//   RESIDENTIAL_NO_CRIME_TYPE             — crimeType empty (no preset
//                                           applied — likely manual setup)

function _hasOffense(o) {
    if (!o || typeof o !== 'object') return false;
    return !_isEmpty(o.code) || !_isEmpty(o.label);
}
function _hasItemBlock(b) {
    if (!b || typeof b !== 'object') return false;
    return !_isEmpty(b.label) || !_isEmpty(b.body);
}

function validateResidential(input) {
    input = input || {};
    const draft  = input.draft  || {};
    const agency = input.agency || {};
    const errors = [];
    const warnings = [];

    const res = (draft.residential && typeof draft.residential === 'object')
        ? draft.residential : {};
    const premises  = (res.premises  && typeof res.premises  === 'object') ? res.premises  : {};
    const offenses  = Array.isArray(res.offenses) ? res.offenses : [];
    const suspects  = Array.isArray(res.suspects) ? res.suspects : [];
    const itemsObj  = (res.itemsToSeize && typeof res.itemsToSeize === 'object') ? res.itemsToSeize : {};
    const itemBlocks = Array.isArray(itemsObj.blocks) ? itemsObj.blocks : [];
    const te        = (res.trainingExperience && typeof res.trainingExperience === 'object') ? res.trainingExperience : {};
    const opts      = (res.optionalClauses && typeof res.optionalClauses === 'object') ? res.optionalClauses : {};
    const execAt    = (res.executedAt && typeof res.executedAt === 'object') ? res.executedAt : {};

    // Case-level Probable Cause — sourced from the Case Probable Cause
    // panel (shared across all warrants in the case). Caller passes it
    // in via `input.pcNarrative`; fall back to legacy draft field for
    // back-compat with older drafts.
    const pcNarrative = (typeof input.pcNarrative === 'string' && input.pcNarrative)
        ? input.pcNarrative
        : (typeof draft.probableCauseNarrative === 'string' ? draft.probableCauseNarrative : '');

    // ── 1. Agency profile completeness ─────────────────────────────────
    const missingAgency = [];
    for (const f of REQUIRED_AGENCY_FIELDS) {
        if (_isEmpty(agency[f.key])) missingAgency.push(f);
    }
    if (missingAgency.length) {
        errors.push(_err(
            'agency.profile.incomplete',
            'AGENCY_PROFILE_INCOMPLETE',
            'Agency profile missing ' + missingAgency.length + ' required field' +
              (missingAgency.length === 1 ? '' : 's') + ' — open Settings → Warrant Author → Agency Profile.',
            { scope: 'agency', missing: missingAgency.map(f => f.key), detail: missingAgency.map(f => f.label).join(', ') }
        ));
    }

    // training placeholder warning (only relevant when residential uses
    // the agency profile T&E; if mode='inline' the user supplies their own)
    if (te.mode !== 'inline' &&
        typeof agency.trainingExperienceBoilerplate === 'string' &&
        agency.trainingExperienceBoilerplate.trim().startsWith(TRAINING_PLACEHOLDER_PREFIX)) {
        warnings.push(_warn(
            'agency.training.placeholder',
            'AGENCY_TRAINING_PLACEHOLDER',
            'Training & Experience boilerplate still contains the shipped REPLACE THIS placeholder.',
            { scope: 'agency', fieldPath: 'agency.trainingExperienceBoilerplate' }
        ));
    }

    // affiant contact (soft)
    if (_isEmpty(agency.affiantEmail) && _isEmpty(agency.affiantPhone)) {
        warnings.push(_warn(
            'agency.affiant.contact.blank',
            'AGENCY_AFFIANT_CONTACT_BLANK',
            'Affiant has no contact email or phone in Agency Profile — providers cannot reach you.',
            { scope: 'agency' }
        ));
    }

    // ── 2. Premises ────────────────────────────────────────────────────
    if (_isEmpty(premises.address)) {
        errors.push(_err(
            'res.premises.address.empty',
            'RESIDENTIAL_NO_PREMISES_ADDRESS',
            'Premises address is empty — the warrant must identify the location to be searched.',
            { scope: 'residential', fieldPath: 'draft.residential.premises.address' }
        ));
    }
    if (_isEmpty(premises.legalDescription)) {
        errors.push(_err(
            'res.premises.legal.empty',
            'RESIDENTIAL_NO_LEGAL_DESCRIPTION',
            'Premises legal description is empty — required for particularity (4th Amendment / PC §1525).',
            { scope: 'residential', fieldPath: 'draft.residential.premises.legalDescription' }
        ));
    }

    // ── 3. Crime type / offenses ──────────────────────────────────────
    if (_isEmpty(res.crimeType)) {
        warnings.push(_warn(
            'res.crimetype.empty',
            'RESIDENTIAL_NO_CRIME_TYPE',
            'No crime-type preset applied — items-to-seize and training & experience blocks were not auto-populated.',
            { scope: 'residential', fieldPath: 'draft.residential.crimeType' }
        ));
    }

    const usableOffenses = offenses.filter(_hasOffense);
    if (usableOffenses.length === 0) {
        errors.push(_err(
            'res.offenses.empty',
            'RESIDENTIAL_NO_OFFENSES',
            'No offenses listed — at least one PC/HS/VC offense is required.',
            { scope: 'residential', fieldPath: 'draft.residential.offenses' }
        ));
    } else {
        // partial rows (code without label, or label without code)
        const partial = usableOffenses.filter(o => _isEmpty(o.code) || _isEmpty(o.label));
        if (partial.length) {
            warnings.push(_warn(
                'res.offenses.partial',
                'RESIDENTIAL_OFFENSE_ROW_PARTIAL',
                partial.length + ' offense row' + (partial.length === 1 ? '' : 's') +
                  ' missing either a code or a label.',
                { scope: 'residential', fieldPath: 'draft.residential.offenses', count: partial.length }
            ));
        }
    }

    // ── 4. PC §1524 grounds (CA-only) ─────────────────────────────────
    // Skip for non-CA jurisdictions. Virginia residential warrants (if
    // ever supported) use Va. Code §§ 19.2-53 / 19.2-54 grounds — a
    // different taxonomy keyed off the DC-338 face page, not pc1524Grounds.
    // Empty jurisdiction + empty template → legacy CA default.
    const _resJx = String(draft.jurisdiction || '').toUpperCase();
    const _resTpl = String(draft.template || '');
    let _resIsCa;
    if (_resJx) {
        _resIsCa = (_resJx === 'CA');
    } else if (_resTpl) {
        _resIsCa = _resTpl.startsWith('ca-');
    } else {
        _resIsCa = true;
    }
    if (_resIsCa) {
        const grounds = (draft.pc1524Grounds && typeof draft.pc1524Grounds === 'object') ? draft.pc1524Grounds : {};
        const anyGround = Object.values(grounds).some(v => v === true);
        if (!anyGround) {
            errors.push(_err(
                'draft.pc1524.none',
                'PC_1524_GROUNDS_NONE',
                'No §1524 grounds checkbox is ticked.',
                { scope: 'draft', fieldPath: 'draft.pc1524Grounds' }
            ));
        }
    }

    // ── 5. Items to seize ──────────────────────────────────────────────
    const usableBlocks = itemBlocks.filter(_hasItemBlock);
    if (usableBlocks.length === 0) {
        errors.push(_err(
            'res.items.empty',
            'RESIDENTIAL_NO_ITEMS_TO_SEIZE',
            'No items-to-seize blocks — the warrant must describe the things to be seized with particularity.',
            { scope: 'residential', fieldPath: 'draft.residential.itemsToSeize.blocks' }
        ));
    } else {
        const blankBody = usableBlocks.filter(b => !_isEmpty(b.label) && _isEmpty(b.body));
        if (blankBody.length) {
            warnings.push(_warn(
                'res.items.blankbody',
                'RESIDENTIAL_ITEM_BLOCK_BLANK_BODY',
                blankBody.length + ' items-to-seize block' + (blankBody.length === 1 ? '' : 's') +
                  ' have a label but no body text.',
                { scope: 'residential', fieldPath: 'draft.residential.itemsToSeize.blocks', count: blankBody.length }
            ));
        }
    }

    // ── 6. Training & Experience ───────────────────────────────────────
    if (te.mode === 'inline') {
        const body = _safeStr(te.inlineBody).trim();
        if (_isEmpty(body)) {
            errors.push(_err(
                'res.te.inline.empty',
                'RESIDENTIAL_TE_INLINE_EMPTY',
                'Training & Experience set to inline but the inline body is empty.',
                { scope: 'residential', fieldPath: 'draft.residential.trainingExperience.inlineBody' }
            ));
        } else if (body.startsWith(TRAINING_PLACEHOLDER_PREFIX)) {
            warnings.push(_warn(
                'res.te.inline.placeholder',
                'AGENCY_TRAINING_PLACEHOLDER',
                'Inline Training & Experience still starts with the shipped REPLACE THIS placeholder.',
                { scope: 'residential', fieldPath: 'draft.residential.trainingExperience.inlineBody' }
            ));
        }
    }

    // ── 7. Statement of Probable Cause (sourced from case-level PC) ────
    //
    // Residential SOPC is rendered from the shared Case Probable Cause
    // narrative — not from a per-draft sopc.sections array. So validate
    // the case-level pcNarrative here. Empty PC is a hard blocker.
    if (_isEmpty(pcNarrative)) {
        errors.push(_err(
            'res.pc.empty',
            'PC_NARRATIVE_EMPTY',
            'Case Probable Cause narrative is empty — author it in the Case Probable Cause panel before submission.',
            { scope: 'case', fieldPath: 'caseProbableCause.body' }
        ));
    }

    // ── 8. Optional clauses — justifications ───────────────────────────
    const night = (opts.nightService && typeof opts.nightService === 'object') ? opts.nightService : {};
    if (night.enabled && _isEmpty(night.justification)) {
        errors.push(_err(
            'res.night.no.justification',
            'RESIDENTIAL_NIGHT_NO_JUSTIFICATION',
            'Night service requested but the justification is blank (PC §1533 requires good cause).',
            { scope: 'residential', fieldPath: 'draft.residential.optionalClauses.nightService.justification' }
        ));
    }
    const hobbs = (opts.hobbsSealing && typeof opts.hobbsSealing === 'object') ? opts.hobbsSealing : {};
    if (hobbs.enabled && _isEmpty(hobbs.justification)) {
        errors.push(_err(
            'res.hobbs.no.justification',
            'RESIDENTIAL_HOBBS_NO_JUSTIFICATION',
            'Hobbs sealing requested but the justification is blank.',
            { scope: 'residential', fieldPath: 'draft.residential.optionalClauses.hobbsSealing.justification' }
        ));
    }

    // ── 9. Suspects (soft) ─────────────────────────────────────────────
    const namedSuspects = suspects.filter(s => s && !_isEmpty(s.name));
    if (namedSuspects.length === 0) {
        warnings.push(_warn(
            'res.suspects.empty',
            'RESIDENTIAL_NO_SUSPECTS',
            'No named suspects — premises-only warrants are valid, but most residential SWs name at least one resident.',
            { scope: 'residential', fieldPath: 'draft.residential.suspects' }
        ));
    }

    // ── 10. Executed-at (soft) ─────────────────────────────────────────
    if (_isEmpty(execAt.city) || _isEmpty(execAt.date)) {
        warnings.push(_warn(
            'res.executedat.blank',
            'RESIDENTIAL_EXECUTED_AT_BLANK',
            'Executed-at city or date is blank — fill in before printing the affiant declaration.',
            { scope: 'residential', fieldPath: 'draft.residential.executedAt' }
        ));
    }

    // ── Summary ────────────────────────────────────────────────────────
    return {
        errors,
        warnings,
        ok: errors.length === 0,
        stats: {
            offenseCount:   usableOffenses.length,
            suspectCount:   namedSuspects.length,
            itemBlockCount: usableBlocks.length,
            pcNarrativeChars: _isEmpty(pcNarrative) ? 0 : String(pcNarrative).trim().length,
            errorCount:    errors.length,
            warningCount:  warnings.length,
            hardBlockers:  Array.from(new Set(errors.map(e => e.code))),
        },
    };
}

// ─── exports ────────────────────────────────────────────────────────────

const _api = {
    validateDraft,
    validateResidential,
    REQUIRED_AGENCY_FIELDS,
    constants: { NDO_CA_CAP_DAYS, DATE_RANGE_LONG_DAYS, DATE_YEAR_MIN, DATE_YEAR_MAX, TRAINING_PLACEHOLDER_PREFIX },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.WarrantAuthorValidator = _api;
}
