// modules/warrant-author/validator.js
// Validator — hard errors + soft warnings.
//
// Phase P0 stub. P4 implements:
//   - validateDraft(draft) → { errors: [...], warnings: [...], ok }
//
// HARD ERRORS (block generation):
//   - missing affiant identity (name, agency, badge)
//   - missing SW number
//   - missing case-ref / court / county / judge
//   - any addendum missing: providerKey, businessName, targetAccounts[≥1],
//     itemsToProduce[≥1], dateRangeFrom or "all available" flag
//   - probableCauseNarrative empty
//   - PC §1524 grounds: at least one box checked
//   - Provider-required fields per provider-registry rules
//   - Multi-Business copy-paste guard: provider name in addendum body MUST
//     match providerKey lookup (catches the "Google in Charter addendum"
//     class of bugs)
//
// SOFT WARNINGS (allow generation):
//   - date range > 365 days
//   - target accounts with non-standard format for provider
//     (e.g. phone in @handle field for Twitter)
//   - "all records" boilerplate without explicit Pattern A/B/C selection
//   - missing notes / unusual capitalization in target account
//   - nightSearch enabled without articulation
//   - non-disclosure days set above 90 (CA cap)

function validateDraft(/* draft */) {
    throw new Error('not-implemented (P4)');
}

module.exports = { validateDraft };
