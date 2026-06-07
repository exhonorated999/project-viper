// modules/warrant-author/block-builder.js
// Shared block-stream builder consumed by pdf-composer (renderer) and
// docx-composer (main). Produces an ordered list of typed blocks that
// represent the full warrant document.
//
// Block kinds:
//   { kind: 'cover-heading', text }            — centered, bold, large
//   { kind: 'cover-subheading', text }         — centered, normal
//   { kind: 'cover-meta', label, value }       — label: value, centered
//   { kind: 'heading-1', text }                — bold, all-caps lead
//   { kind: 'heading-2', text }                — bold, smaller
//   { kind: 'paragraph', text, indent? }       — body paragraph (double-spaced)
//   { kind: 'numbered', items: [text...] }     — arabic-numeral list
//   { kind: 'signature', label }               — underscore line + label
//   { kind: 'page-break' }                     — hard page break
//   { kind: 'spacer', size: 'sm'|'md'|'lg' }   — vertical whitespace
//   { kind: 'footer-disclaimer', text }        — italic, small, centered
//
// Inputs:
//   draft           — { id, swNumber, caseRef, courtName, template, affiantSnapshot, addendums: [...] }
//   addendumComposes — array of { addendumId, providerKey, providerName,
//                                  businessName, compose: {blocks, danglingSlots, missingItems} }
//   agency          — { agencyName, unitShort, county, state, affiantName,
//                       affiantRank, affiantBadge, affiantEmail, affiantPhone, ... }
//   caseInfo        — { caseNumber, caseName, synopsis }
//   pcNarrative     — case-level probable cause string
//
// Output: { blocks: [...], stats: { addendums, pages? (composer fills) } }

(function (root) {
  'use strict';

  function _abc(i) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (i < 26) return letters[i];
    return letters[Math.floor(i / 26) - 1] + letters[i % 26];
  }

  function _safe(s) { return (s == null) ? '' : String(s); }

  function _todayStr() {
    const d = new Date();
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /**
   * Map a single template-engine resolved block to one or more output blocks.
   * Returns an array (may be empty).
   */
  function _mapResolvedBlock(rb) {
    const out = [];
    if (!rb) return out;
    const kind = rb.kind;
    const heading = _safe(rb.heading).trim();
    const text = _safe(rb.text).trim();

    switch (kind) {
      case 'constant':
      case 'verbatim':
      case 'provider-slot-paragraph':
      case 'optional':
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;

      case 'label':
        if (text) out.push({ kind: 'heading-2', text });
        else if (heading) out.push({ kind: 'heading-2', text: heading });
        break;

      case 'provider-block':
        if (heading) out.push({ kind: 'heading-1', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;

      case 'target-account':
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;

      case 'date-range':
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;

      case 'items-to-seize': {
        if (heading) out.push({ kind: 'heading-2', text: heading });
        const items = Array.isArray(rb.items) ? rb.items : [];
        if (items.length === 0) {
          out.push({ kind: 'paragraph', text: '[NO ITEMS SELECTED — review Items to Produce]' });
        } else {
          out.push({
            kind: 'numbered',
            items: items.map(it => {
              const label = _safe(it.label || it.name || it.key).trim();
              const desc = _safe(it.description || '').trim();
              return desc ? `${label} — ${desc}` : label;
            }).filter(Boolean),
          });
        }
        break;
      }

      case 'affiant-contact':
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;

      default:
        // Unknown kind — render as plain paragraph with heading fallback
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;
    }
    return out;
  }

  /**
   * Build the cover page blocks (caption + affiant identity).
   */
  function _buildCover(draft, agency, caseInfo) {
    const blocks = [];
    const agencyName = _safe(agency.agencyName) || _safe(agency.agencyShortName) || '(AGENCY)';
    const county     = _safe(agency.county);
    const state      = _safe(agency.state) || 'CA';
    const court      = _safe(draft.courtName) || _safe(agency.defaultCourtName) || `Superior Court of ${state}`;

    blocks.push({ kind: 'cover-heading', text: court.toUpperCase() });
    if (county) {
      blocks.push({ kind: 'cover-subheading', text: `County of ${county}` });
    }
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({ kind: 'cover-heading', text: 'AFFIDAVIT IN SUPPORT OF SEARCH WARRANT' });
    blocks.push({ kind: 'cover-subheading', text: '(Multi-Business Electronic Service Provider Records)' });
    blocks.push({ kind: 'spacer', size: 'md' });

    // SW number — left blank intentionally if not yet assigned by court
    const sw = _safe(draft.swNumber).trim();
    blocks.push({
      kind: 'cover-meta',
      label: 'Search Warrant Number',
      value: sw ? sw : '________________________ (assigned by court)',
    });
    blocks.push({
      kind: 'cover-meta',
      label: 'Case Reference',
      value: _safe(draft.caseRef) || _safe(caseInfo.caseNumber) || '(not assigned)',
    });
    blocks.push({
      kind: 'cover-meta',
      label: 'Date',
      value: _todayStr(),
    });

    blocks.push({ kind: 'spacer', size: 'lg' });

    // Affiant identity block
    const aff = draft.affiantSnapshot || {};
    const affName = _safe(aff.affiantName) || _safe(agency.affiantName) || '(AFFIANT NAME)';
    const affRank = _safe(aff.affiantRank) || _safe(agency.affiantRank) || '';
    const affBadge = _safe(aff.affiantBadge) || _safe(agency.affiantBadge) || '';
    const affEmail = _safe(aff.affiantEmail) || _safe(agency.affiantEmail) || '';
    const affPhone = _safe(aff.affiantPhone) || _safe(agency.affiantPhone) || '';
    const unit    = _safe(agency.unit) || _safe(agency.unitShort) || '';

    const idLines = [];
    idLines.push(`I, ${affRank ? affRank + ' ' : ''}${affName}${affBadge ? `, Badge #${affBadge}` : ''}, of the ${agencyName}${unit ? `, ${unit}` : ''}, being duly sworn, depose and state:`);
    blocks.push({ kind: 'paragraph', text: idLines.join(' ') });

    if (affEmail || affPhone) {
      const contact = [affEmail, affPhone].filter(Boolean).join(' · ');
      blocks.push({ kind: 'paragraph', text: `Affiant contact: ${contact}`, indent: false });
    }

    return blocks;
  }

  /**
   * Build the probable cause section (case-level).
   */
  function _buildProbableCause(pcNarrative) {
    const blocks = [];
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({ kind: 'heading-1', text: 'PROBABLE CAUSE' });
    const pc = _safe(pcNarrative).trim();
    if (!pc) {
      blocks.push({
        kind: 'paragraph',
        text: '[PROBABLE CAUSE NARRATIVE NOT YET AUTHORED — author it on the Warrant Author screen before serving.]',
      });
    } else {
      // Split on blank lines into separate paragraphs
      const paras = pc.split(/\r?\n\s*\r?\n/);
      for (const p of paras) {
        const trimmed = p.trim();
        if (trimmed) blocks.push({ kind: 'paragraph', text: trimmed });
      }
    }
    return blocks;
  }

  /**
   * Build one addendum section (page-break + heading + resolved blocks).
   */
  function _buildAddendum(addendumCompose, index) {
    const blocks = [];
    const providerName = _safe(addendumCompose.providerName) || _safe(addendumCompose.providerKey) || '(PROVIDER)';
    const businessName = _safe(addendumCompose.businessName);

    blocks.push({ kind: 'page-break' });
    const label = `ADDENDUM ${_abc(index)} — ${providerName.toUpperCase()}${businessName ? ` (${businessName.toUpperCase()})` : ''}`;
    blocks.push({ kind: 'heading-1', text: label });
    blocks.push({ kind: 'spacer', size: 'sm' });

    const composed = addendumCompose.compose || {};
    const resolvedBlocks = Array.isArray(composed.blocks) ? composed.blocks : [];
    for (const rb of resolvedBlocks) {
      const mapped = _mapResolvedBlock(rb);
      for (const m of mapped) blocks.push(m);
    }

    return blocks;
  }

  /**
   * Build the signature page (signature lines + judge ruling).
   */
  function _buildSignature(draft, agency) {
    const blocks = [];
    blocks.push({ kind: 'spacer', size: 'lg' });
    blocks.push({ kind: 'paragraph', text: 'I declare under penalty of perjury under the laws of the State of California that the foregoing is true and correct to the best of my knowledge and belief.' });
    blocks.push({ kind: 'spacer', size: 'md' });

    const aff = draft.affiantSnapshot || {};
    const affName  = _safe(aff.affiantName)  || _safe(agency.affiantName)  || '';
    const affRank  = _safe(aff.affiantRank)  || _safe(agency.affiantRank)  || '';
    const affBadge = _safe(aff.affiantBadge) || _safe(agency.affiantBadge) || '';
    const agencyName = _safe(agency.agencyName) || '';
    const sigLabel = [
      affRank, affName, affBadge ? `Badge #${affBadge}` : '', agencyName,
    ].filter(Boolean).join(', ');

    blocks.push({ kind: 'signature', label: sigLabel || 'Affiant' });
    blocks.push({ kind: 'spacer', size: 'md' });

    blocks.push({ kind: 'paragraph', text: `Subscribed and sworn to before me on this ___ day of __________________, ${new Date().getFullYear()}.` });
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({ kind: 'signature', label: 'Judge of the Superior Court' });

    return blocks;
  }

  /**
   * Top-level: build complete document block stream.
   */
  function build({ draft, addendumComposes, agency, caseInfo, pcNarrative, includeDisclaimer }) {
    if (!draft) throw new Error('build: draft required');
    agency = agency || {};
    caseInfo = caseInfo || {};
    addendumComposes = Array.isArray(addendumComposes) ? addendumComposes : [];

    const blocks = [];

    // 1) Cover
    for (const b of _buildCover(draft, agency, caseInfo)) blocks.push(b);

    // 2) Probable Cause (case-level)
    for (const b of _buildProbableCause(pcNarrative)) blocks.push(b);

    // 3) Addendums
    addendumComposes.forEach((ac, i) => {
      for (const b of _buildAddendum(ac, i)) blocks.push(b);
    });

    // 4) Signature
    for (const b of _buildSignature(draft, agency)) blocks.push(b);

    // 5) Optional compliance disclaimer
    if (includeDisclaimer !== false) {
      blocks.push({ kind: 'spacer', size: 'md' });
      blocks.push({
        kind: 'footer-disclaimer',
        text: 'Drafted with VIPER Warrant Author v1. Not a substitute for legal review.',
      });
    }

    // Aggregate dangling slots (informational, composer can render warnings)
    const allDangling = [];
    for (const ac of addendumComposes) {
      const cs = (ac.compose && Array.isArray(ac.compose.danglingSlots)) ? ac.compose.danglingSlots : [];
      for (const d of cs) allDangling.push(`${ac.addendumId || ac.providerKey || '?'}/${d}`);
    }

    return {
      blocks,
      stats: {
        addendums: addendumComposes.length,
        totalBlocks: blocks.length,
        danglingSlots: allDangling,
        pcAuthored: !!(pcNarrative && String(pcNarrative).trim().length > 0),
      },
    };
  }

  const api = Object.freeze({
    build,
    _internals: { _mapResolvedBlock, _abc, _buildCover, _buildProbableCause, _buildAddendum, _buildSignature },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WarrantAuthorBlockBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis);
