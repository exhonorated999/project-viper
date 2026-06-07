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

    // §1524 grounds — at least one ticked
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
            if (from && to) {
                if (from.getTime() > to.getTime()) {
                    errors.push(_err(
                        'ad.' + (ad.id || idx) + '.daterange.inverted',
                        'ADDENDUM_INVERTED_RANGE',
                        'Page ' + label + ': date range is inverted (From after To).',
                        Object.assign({}, ctx, { fieldPath: 'addendum.dateRangeFrom' })
                    ));
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

// ─── exports ────────────────────────────────────────────────────────────

const _api = {
    validateDraft,
    REQUIRED_AGENCY_FIELDS,
    constants: { NDO_CA_CAP_DAYS, DATE_RANGE_LONG_DAYS, TRAINING_PLACEHOLDER_PREFIX },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.WarrantAuthorValidator = _api;
}
