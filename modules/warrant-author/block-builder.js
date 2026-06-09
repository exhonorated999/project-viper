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

      case 'affiant-contact': {
        if (heading) out.push({ kind: 'heading-2', text: heading });
        // Affiant contact resolves a multi-field block (Affiant / Agency /
        // Phone / Email / Address). Render one paragraph per non-blank
        // source line so it reads as a vertical list instead of a single
        // run-on paragraph (composer otherwise reflows on `\n`).
        if (text) {
          const lines = text.split(/\r?\n/);
          for (const ln of lines) {
            const t = ln.trim();
            if (t) out.push({ kind: 'paragraph', text: t });
          }
        }
        break;
      }

      default:
        // Unknown kind — render as plain paragraph with heading fallback
        if (heading) out.push({ kind: 'heading-2', text: heading });
        if (text) out.push({ kind: 'paragraph', text });
        break;
    }
    return out;
  }

  // ─── CA Multi-Business SW Face Page ──────────────────────────────────
  // Mirrors the structure of the standard California Search Warrant face
  // page (Multi SW Face Page.docx). Layout:
  //   1) Affiant oath paragraph
  //   2) HOBBS SEALING + NIGHT SEARCH check lines
  //   3) Signature block ("Signature of Affiant")
  //   4) Centered "(SEARCH WARRANT)" title
  //   5) "THE PEOPLE OF THE STATE OF CALIFORNIA TO ANY SHERIFF…" intro
  //   6) Eight PC §1524 grounds with check boxes
  //   7) "YOU ARE THEREFORE COMMANDED to SEARCH" + per-addendum
  //      "Page A for {Provider}" / "Page B for {Provider}" lines
  //
  // Checkboxes use ASCII `[X]` / `[ ]` so they render reliably in BOTH
  // jsPDF (Times) and docx — neither needs a Unicode glyph fallback.
  function _buildCaFacePage(draft, agency, caseInfo, addendumComposes) {
    const blocks = [];
    const aff = draft.affiantSnapshot || {};
    const affName  = _safe(aff.affiantName)  || _safe(agency.affiantName)  || '________________';
    const affRank  = _safe(aff.affiantRank)  || _safe(agency.affiantRank)  || 'Detective';
    const affBadge = _safe(aff.affiantBadge) || _safe(agency.affiantBadge) || '';
    const affTitle = `${affRank} ${affName}`.replace(/\s+/g, ' ').trim();
    const county = (_safe(agency.county) || _safe(draft.county) || '__________________').toUpperCase();
    const hobbsYes = draft.hobbsSealing === 'requested';
    const nightYes = draft.nightSearch === 'requested';
    const box = (on) => on ? '[X]' : '[ ]';

    // 0) SW NO. line — right-aligned at top of page 1, matches the
    //    official Multi-Business SW face page layout. Court file-stamps
    //    here, so it must NOT be at the end of the document.
    const swRaw = _safe(draft.swNumber).trim();
    const swLine = swRaw
      ? `SW NO. ${swRaw}`
      : 'SW NO. ______________________________';
    blocks.push({ kind: 'paragraph', text: swLine, align: 'right' });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 1) Affiant oath block (top of face page)
    blocks.push({
      kind: 'paragraph',
      text:
        `${affTitle} swears under oath that the facts expressed by him in the attached and incorporated Affidavit ` +
        `are true and that based thereon he has probable cause to believe and does believe that the articles, ` +
        `property, and persons described below are lawfully seizable pursuant to Penal Code Section 1524 et seq., ` +
        `as indicated below, and are now located at the locations set forth below. Wherefore, Affiant requests ` +
        `that this Search Warrant be issued. I declare that the information below is true and correct under ` +
        `penalty of perjury of the laws of the State of California.`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 2) HOBBS SEALING + NIGHT SEARCH check lines (centered like the docx)
    blocks.push({
      kind: 'cover-subheading',
      text: `HOBBS SEALING REQUESTED:   ${box(hobbsYes)} YES    ${box(!hobbsYes)} NO`,
    });
    blocks.push({
      kind: 'cover-subheading',
      text: `NIGHT SEARCH REQUESTED:    ${box(nightYes)} YES    ${box(!nightYes)} NO`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 3) Signature line for affiant
    const sigLabel = '(Signature of Affiant)  ' + affTitle + (affBadge ? `, Badge #${affBadge}` : '');
    blocks.push({ kind: 'signature', label: sigLabel });
    blocks.push({ kind: 'spacer', size: 'md' });

    // 4) Title
    blocks.push({ kind: 'cover-heading', text: '( SEARCH WARRANT )' });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 5) People of the State of California intro
    blocks.push({
      kind: 'paragraph',
      text:
        `THE PEOPLE OF THE STATE OF CALIFORNIA TO ANY SHERIFF, POLICEMAN OR PEACE OFFICER IN THE COUNTY OF ` +
        `${county}: proof by affidavit, under penalty of perjury, having been made before me by ${affTitle} ` +
        `that there is probable cause to believe that the property or person described herein may be found at ` +
        `the location(s) set forth herein and that it is lawfully seizable pursuant to Penal Code Section 1524 ` +
        `et seq., as indicated below by "[X]"(s), in that:`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 6) Eight PC §1524 grounds
    const g = draft.pc1524Grounds || {};
    const grounds = [
      [g.stolen,              'It was stolen or embezzled;'],
      [g.felonyMeans,         'It was used as the means of committing a felony;'],
      [g.possessedWithIntent, 'It is possessed by a person with the intent to use it as means of committing a public offense or is possessed by another to whom he or she may have delivered it for the purpose of concealing it or preventing its discovery;'],
      [g.evidenceOfFelony,    'It tends to show that a felony has been committed or that a particular person has committed a felony;'],
      [g.sexualExploitation,  'It tends to show that sexual exploitation of a child, in violation of Penal Code Section 311.3, or possession of matter depicting sexual conduct of a person under the age of 18 years, in violation of Section 311.11, has occurred or is occurring;'],
      [g.arrestWarrant,       'There is a warrant to arrest the person;'],
      [g.ecspMisdemeanor,     'A provider of electronic communication service or remote computing service has records of evidence, as specified in Penal Code Section 1524.3, showing that property was stolen or embezzled constituting a misdemeanor, or that property or things are in possession of any person with intent to use them as a means of committing a misdemeanor public offense, or in the possession of another to whom he or she may have delivered them for the purpose of concealing them or preventing their discovery;'],
      [g.laborCode,           'The property or things to be seized include an item or any evidence that tends to show a violation of Section 3700.5 of the Labor Code, or tends to show that a particular person has violated Section 3700.5 of the Labor Code;'],
    ];
    for (const [checked, text] of grounds) {
      blocks.push({ kind: 'paragraph', text: `${box(!!checked)}  ${text}`, indent: true });
    }

    blocks.push({ kind: 'spacer', size: 'md' });

    // 7) Command + addendum routing — always on its OWN page so the
    //    provider routing list reads cleanly and is easy for the court
    //    clerk to find when serving the warrant.
    blocks.push({ kind: 'page-break' });
    blocks.push({
      kind: 'heading-2',
      text: 'YOU ARE THEREFORE COMMANDED to SEARCH:  (premises, vehicles, persons)',
    });
    blocks.push({ kind: 'paragraph', text: 'See attachment:' });

    addendumComposes = Array.isArray(addendumComposes) ? addendumComposes : [];
    if (!addendumComposes.length) {
      blocks.push({
        kind: 'paragraph',
        text: '(no provider addendums attached)',
        indent: true,
      });
    } else {
      addendumComposes.forEach((ac, i) => {
        const letter = _abc(i);
        const providerName = _safe(ac.providerName) || _safe(ac.providerKey) || '(Provider)';
        blocks.push({
          kind: 'paragraph',
          text: `Page ${letter} for ${providerName}`,
          indent: true,
        });
      });
    }

    // The official face page ENDS with the addendum routing. SW number
    // already appears at the top (right-aligned). Case Reference and Date
    // are carried by the running header/footer (DR # / CT #) so they don't
    // need a duplicate centered strip here.

    return blocks;
  }

  /**
   * CA Statement of Probable Cause — matches the sample
   * "Multi Business SW.docx" verbatim. Renders after all addendums.
   * Sections (in order):
   *   - STATEMENT OF PROBABLE CAUSE (centered, bold heading)
   *   - "Affiant declares under penalty of perjury..." opener
   *   - IDENTIFICATION AND EXPERTISE OF AFFIANT: heading-2 + boilerplate
   *   - (2) PROBABLE CAUSE: heading-2 + pcNarrative
   *   - "It has been my experience..." closing
   *   - AND TO SEIZE IT / THEM IF FOUND... order block
   *   - HOBBS SEALING APPROVED + NIGHT SEARCH APPROVED check lines
   *   - Judge signature + printed name lines
   */
  function _buildCaStatementOfProbableCause(draft, agency, caseInfo, pcNarrative) {
    const blocks = [];
    const aff = draft.affiantSnapshot || {};
    const affFirst   = _safe(aff.affiantFirstName) || _safe(agency.affiantFirstName) || '';
    const affLast    = _safe(aff.affiantLastName)  || _safe(agency.affiantLastName)  || '';
    const affFull    = (affFirst || affLast)
      ? `${affFirst} ${affLast}`.trim()
      : (_safe(aff.affiantName) || _safe(agency.affiantName) || '________________');
    const county     = _safe(agency.county) || _safe(draft.county) || '__________________';

    // 1) STATEMENT OF PROBABLE CAUSE — page break so it lands cleanly on a new page
    blocks.push({ kind: 'page-break' });
    blocks.push({ kind: 'cover-heading', text: 'STATEMENT OF PROBABLE CAUSE' });
    blocks.push({ kind: 'spacer', size: 'md' });

    // 2) Affiant declaration opener (verbatim from sample)
    blocks.push({
      kind: 'paragraph',
      text:
        'Affiant declares under penalty of perjury that the following facts are true and that there ' +
        'is probable cause to believe, and Affiant does believe, that the designated articles, property, ' +
        'and persons are now in the described locations, including all rooms, buildings, and structures ' +
        'used in connection with the premises and buildings adjoining them, the vehicles and the persons:',
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 3) IDENTIFICATION AND EXPERTISE OF AFFIANT
    blocks.push({ kind: 'heading-2', text: 'IDENTIFICATION AND EXPERTISE OF AFFIANT:' });
    const trainingExperience = _safe(aff.trainingExperienceBoilerplate)
      || _safe(aff.trainingExperience)
      || _safe(agency.trainingExperienceBoilerplate)
      || _safe(agency.trainingExperience)
      || _safe(agency.affiantTrainingExperience)
      || _safe(agency.identificationAndExpertise)
      || '';
    if (trainingExperience.trim()) {
      const paras = trainingExperience.split(/\r?\n\s*\r?\n/);
      for (const p of paras) {
        const t = p.trim();
        if (t) blocks.push({ kind: 'paragraph', text: t });
      }
    } else {
      blocks.push({
        kind: 'paragraph',
        text:
          `[Training & experience boilerplate not yet set — open Settings → Agency Profile → ` +
          `Training & Experience Boilerplate and paste your career/training narrative. This text appears ` +
          `unchanged on every California warrant signed by ${affFull}.]`,
      });
    }
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 4) (2) PROBABLE CAUSE — case-level narrative
    blocks.push({ kind: 'heading-2', text: ' (2) PROBABLE CAUSE:' });
    const pc = _safe(pcNarrative).trim();
    if (!pc) {
      blocks.push({
        kind: 'paragraph',
        text:
          '[Probable cause narrative not yet authored — author it before serving. This narrative ' +
          'should describe what happened, what evidence supports the search, and why each provider ' +
          'record is relevant.]',
      });
    } else {
      const paras = pc.split(/\r?\n\s*\r?\n/);
      for (const p of paras) {
        const t = p.trim();
        if (t) blocks.push({ kind: 'paragraph', text: t });
      }
    }
    blocks.push({ kind: 'spacer', size: 'md' });

    // 5) "It has been my experience..." 10-day return clause (verbatim)
    blocks.push({
      kind: 'paragraph',
      text:
        'It has been my experience that it takes companies considerable time beyond the statutory ' +
        '10-day search warrant return period to collect and provide materials sought in this search ' +
        'warrant. Therefore, I request permission to return this Search Warrant within 10 days from ' +
        'the date all materials are received from these companies.',
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 6) AND TO SEIZE IT / THEM... judge order block (verbatim from sample)
    blocks.push({
      kind: 'paragraph',
      text:
        'AND TO SEIZE IT / THEM IF FOUND and bring it / them forthwith before me, or this court, ' +
        'at the courthouse of this court. This Search Warrant and Affidavit and attached and ' +
        'incorporated Affidavit were sworn to as true and subscribed before me on this ' +
        '_________________________, at __________ A.M. / P.M. Wherefore, I find probable cause for ' +
        'the issuance of this Search Warrant and do issue it.',
    });
    blocks.push({ kind: 'spacer', size: 'md' });

    // 7) HOBBS / NIGHT APPROVED check lines — judge fills these in
    blocks.push({
      kind: 'cover-subheading',
      text: 'HOBBS SEALING APPROVED:   [ ] YES    [ ] NO',
    });
    blocks.push({
      kind: 'cover-subheading',
      text: 'NIGHT SEARCH APPROVED:    [ ] YES    [ ] NO',
    });
    blocks.push({ kind: 'spacer', size: 'md' });

    // 8) Judge signature lines (verbatim layout from sample)
    blocks.push({ kind: 'signature', label: '(Signature of Judge)' });
    blocks.push({ kind: 'spacer', size: 'sm' });
    blocks.push({
      kind: 'paragraph',
      text: `Judge of the Superior Court of California, County of ${county}, Superior Court,`,
    });
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({ kind: 'signature', label: '(Printed Name of Judge)' });

    return blocks;
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
        text: '[Probable cause narrative not yet authored — author it before serving.]',
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
   * CA Residential Search Warrant — full document, single function.
   * Mirrors the 26-block ca-residential.json template:
   *   PAGE 1 (warrant face): heading, people-opener, attestation,
   *     §1524 grounds checklist, search command, premises, suspects,
   *     items-to-seize, optional face-page checkboxes (night/Hobbs),
   *     magistrate ruling boilerplate + signature line.
   *   PAGE 2+ (affidavit): affiant declaration, identification &
   *     experience, statement of probable cause sections, premises +
   *     items recaps, optional clauses (offsite/duplicate/return
   *     extension/night justification/Hobbs justification/statutory
   *     grounds recap), executed-at, affiant signature block.
   *
   * Consumes ONLY the canonical block kinds the composers understand
   * (heading-1, heading-2, paragraph, numbered, signature, spacer,
   * page-break). No new block kinds are introduced.
   */
  function _buildCaResidential(draft, agency, caseInfo, pcNarrative) {
    const blocks = [];
    const aff = draft.affiantSnapshot || {};
    const res = (draft.residential && typeof draft.residential === 'object') ? draft.residential : {};

    // ── Identity fields (with fallbacks) ──────────────────────────────
    const affName  = _safe(aff.affiantName)  || _safe(agency.affiantName)  || '________________';
    const affRank  = _safe(aff.affiantRank)  || _safe(agency.affiantRank)  || 'Detective';
    const affBadge = _safe(aff.affiantBadge) || _safe(agency.affiantBadge) || '';
    const affUnit  = _safe(aff.unit)         || _safe(agency.unit)         || '';
    const affEmail = _safe(aff.affiantEmail) || _safe(agency.affiantEmail) || '';
    const affPhone = _safe(aff.affiantPhone) || _safe(agency.affiantPhone) || '';
    const agName   = _safe(agency.agencyName) || '';
    const agAddr   = _safe(agency.agencyAddress) || '';
    const countyRaw = _safe(agency.county) || _safe(draft.county) || 'San Bernardino';
    const county    = countyRaw.toUpperCase();
    const countyTitle = countyRaw.replace(/\b\w/g, m => m.toUpperCase());
    const courtDivision = _safe(agency.courtDivision) || _safe(agency.defaultCourtName) || 'Rancho Cucamonga Division';
    const yearNow = new Date().getFullYear();

    const affTitle = `${affRank} ${affName}`.replace(/\s+/g, ' ').trim();
    const _sigBadge = affBadge ? `, Badge #${affBadge}` : '';

    const box = (on) => on ? '[X]' : '[ ]';

    // Substitute template placeholders ({{agency.*}}, {{affiant.*}})
    function _sub(text) {
      if (!text) return '';
      return String(text)
        .replace(/\{\{agency\.county\}\}/g, county)
        .replace(/\{\{agency\.name\}\}/g, agName)
        .replace(/\{\{agency\.unit\}\}/g, affUnit)
        .replace(/\{\{affiant\.rank\}\}/g, affRank)
        .replace(/\{\{affiant\.name\}\}/g, affName)
        .replace(/\{\{affiant\.badge\}\}/g, affBadge || '________');
    }

    // ── CSAM terminology normalizer ──────────────────────────────────
    // When the crime-type preset is CSAM, scrub legacy "child pornography"
    // wording from any user-supplied text (T&E boilerplate, pcNarrative,
    // items-to-seize bodies, optional-clause justifications) and replace
    // with the modern "Child Sexual Abuse Material" terminology, preserving
    // case. The agency-typed boilerplate often carries the legacy phrase
    // verbatim from older Fontana PD / SBSD templates; this transform
    // normalises every rendered CSAM warrant without forcing agencies to
    // hand-edit their saved profile.
    const isCsam = String(res.crimeType || '').toLowerCase() === 'csam';
    function _normalizeCsam(text) {
      if (!isCsam || !text) return text;
      return String(text)
        // Compound legacy phrasing ("child abuse/pornography") split clearly
        .replace(/\bchild abuse\s*\/\s*pornography\b/g, 'child abuse / Child Sexual Abuse Material')
        .replace(/\bChild Abuse\s*\/\s*Pornography\b/g, 'Child Abuse / Child Sexual Abuse Material')
        .replace(/\bCHILD ABUSE\s*\/\s*PORNOGRAPHY\b/g, 'CHILD ABUSE / CHILD SEXUAL ABUSE MATERIAL')
        // Standard phrase, preserve case pattern
        .replace(/\bchild pornography\b/g, 'child sexual abuse material')
        .replace(/\bChild Pornography\b/g, 'Child Sexual Abuse Material')
        .replace(/\bCHILD PORNOGRAPHY\b/g, 'CHILD SEXUAL ABUSE MATERIAL');
    }

    function _bodyParagraphs(body) {
      const t = _normalizeCsam(_safe(body).replace(/\r\n/g, '\n').trim());
      if (!t) return [];
      const parts = t.split(/\n\s*\n+/);
      const out = [];
      for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed) out.push({ kind: 'paragraph', text: trimmed });
      }
      return out;
    }

    // ══════════════════════════════════════════════════════════════════
    // PAGE 1 — WARRANT FACE
    // ══════════════════════════════════════════════════════════════════
    // Boilerplate mirrors the official San Bernardino "STATE of
    // CALIFORNIA / COUNTY of …" residential SW template verbatim.
    // Running header (stamped by the composer) supplies the
    // "STATE of CALIFORNIA, COUNTY of …, " banner on every page.

    const hobbsYes = !!(res.optionalClauses && res.optionalClauses.hobbsSealing && res.optionalClauses.hobbsSealing.enabled);
    const nightYes = !!(res.optionalClauses && res.optionalClauses.nightService && res.optionalClauses.nightService.enabled);

    // 01: SW NO. placeholder (right-aligned slot the clerk fills in)
    blocks.push({ kind: 'paragraph', text: 'SW NO. __________________' });

    // 02: dual title
    blocks.push({ kind: 'cover-heading', text: 'SEARCH WARRANT and AFFIDAVIT' });
    blocks.push({ kind: 'cover-subheading', text: '(AFFIDAVIT)' });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 03: affiant oath (verbatim from sample)
    blocks.push({
      kind: 'paragraph',
      text:
        `${affTitle} swears under oath that the facts expressed by him/her in the attached and ` +
        `incorporated Affidavit are true and that based thereon he/she has probable cause to believe ` +
        `and does believe that the articles, property, and persons described below are lawfully ` +
        `seizable pursuant to Penal Code Section 1524 et seq., as indicated below, and are now located ` +
        `at the locations set forth below. Wherefore, Affiant requests that this Search Warrant be issued.`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 04: HOBBS / NIGHT REQUESTED check lines (affiant fills these in)
    blocks.push({
      kind: 'cover-subheading',
      text: `HOBBS SEALING REQUESTED:   ${box(hobbsYes)} YES    ${box(!hobbsYes)} NO`,
    });
    blocks.push({
      kind: 'cover-subheading',
      text: `NIGHT SEARCH REQUESTED:    ${box(nightYes)} YES    ${box(!nightYes)} NO`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 05: affiant signature line
    blocks.push({ kind: 'signature', label: `(Signature of Affiant)  ${affTitle}${_sigBadge}` });
    blocks.push({ kind: 'spacer', size: 'md' });

    // 06: SEARCH WARRANT title (no inner spaces — matches original)
    blocks.push({ kind: 'cover-heading', text: '(SEARCH WARRANT)' });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 07: People intro
    blocks.push({
      kind: 'paragraph',
      text:
        `THE PEOPLE OF THE STATE OF CALIFORNIA TO ANY PEACE OFFICER IN THE COUNTY OF ${county}: ` +
        `proof by affidavit, having been this day made before me by ${affTitle} that there is probable ` +
        `cause to believe that the property or person described herein may be found at the location(s) ` +
        `set forth herein and that it is lawfully seizable pursuant to Penal Code Section 1524 et seq., ` +
        `as indicated below by "[X]"(s), in that:`,
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // 08: PC §1524 grounds checklist (8 verbatim grounds)
    const g = draft.pc1524Grounds || {};
    const groundsList = [
      [g.stolen,              'The property was stolen or embezzled;'],
      [g.felonyMeans,         'The property or things were used as the means of committing a felony;'],
      [g.possessedWithIntent, 'The property or things are possessed by a person with the intent to use them as means of committing a public offense, or is possessed by another to whom he or she may have delivered them for the purpose of concealing them or preventing them from discovery;'],
      [g.evidenceOfFelony,    'The property or things to be seized consist of any item or constitute any evidence which tends to show that a felony has been committed, or tends to show that a particular person has committed a felony;'],
      [g.sexualExploitation,  'The property or things to be seized consist of evidence that tends to show that sexual exploitation of a child, in violation of Penal Code Section 311.3, or possession of matter depicting sexual conduct of a person under the age of 18 years, in violation of Penal Code Section 311.11, has occurred or is occurring;'],
      [g.arrestWarrant,       'There is a warrant to arrest the person;'],
      [g.ecspMisdemeanor,     'A provider of electronic communication service or remote computing service has records or evidence, as specified in Penal Code Section 1524.3, showing that property was stolen or embezzled constituting a misdemeanor, or that property or things are in possession of any person with intent to use them as a means of committing a misdemeanor public offense, or in the possession of another to whom he or she may have delivered them for the purpose of concealing them or preventing their discovery;'],
      [g.laborCode,           'The property or things to be seized include an item or any evidence that tends to show a violation of Section 3700.5 of the Labor Code, or tends to show that a particular person has violated Section 3700.5 of the Labor Code.'],
    ];
    for (const [checked, text] of groundsList) {
      blocks.push({ kind: 'paragraph', text: `${box(!!checked)}  ${text}`, indent: true });
    }
    blocks.push({ kind: 'spacer', size: 'md' });

    // ══════════════════════════════════════════════════════════════════
    // PAGE 2+ — COMMAND TO SEARCH (premises, property to seize)
    // ══════════════════════════════════════════════════════════════════
    blocks.push({ kind: 'page-break' });

    // Search command — verbatim original heading
    blocks.push({ kind: 'heading-2', text: 'You are Therefore COMMANDED to SEARCH: (premises, vehicles, persons)' });

    // Premises — short address + detailed legal description.
    // (Per original boilerplate: BOTH are emitted — short address as a
    //  stand-alone line, then the long legal description paragraph.)
    const premises = (res.premises && typeof res.premises === 'object') ? res.premises : {};
    const addrShort = _safe(premises.address).trim();
    const legalDesc = _safe(premises.legalDescription).trim();
    if (addrShort) {
      blocks.push({ kind: 'paragraph', text: addrShort });
    } else if (!legalDesc) {
      blocks.push({ kind: 'paragraph', text: '__________________________________________________  [premises address]' });
    }
    if (legalDesc) {
      for (const p of _bodyParagraphs(legalDesc)) blocks.push(p);
    } else if (!addrShort) {
      blocks.push({ kind: 'paragraph', text: '__________________________________________________  [legal description of premises]' });
    }

    // Scope boilerplate — verbatim from original sample.
    if (premises.includeScopeBoilerplate !== false) {
      blocks.push({
        kind: 'paragraph',
        text: 'And all rooms, attics, basements, and other parts therein, and the surrounding grounds and any garages, trailers, store rooms and outbuildings of any kind located thereon. Any vehicles located within the property, on the property or leaving the property.',
      });
      blocks.push({
        kind: 'paragraph',
        text: "And all persons at the location for any electronic storage devices and media on their persons, to include but not limited to, PDA's, cellular phones, electronic address books, thumb drives, writable storage media, cassette tapes; laptop computer(s); desktop computer(s), in addition to:",
      });
    }

    // Optional suspect identification (kept from prior implementation —
    // not in the verbatim sample but provides utility for named-person
    // residential warrants).
    const suspects = Array.isArray(res.suspects) ? res.suspects : [];
    const namedSuspects = suspects.filter(s => s && _safe(s.name));
    if (namedSuspects.length) {
      blocks.push({ kind: 'heading-2', text: 'INCLUDING THE PERSON OF:' });
      for (const s of namedSuspects) {
        const parts = [
          _safe(s.name),
          _safe(s.aliases) ? `aka ${_safe(s.aliases)}` : '',
          _safe(s.dob) ? `DOB ${_safe(s.dob)}` : '',
          _safe(s.descriptors),
          _safe(s.address),
        ].filter(Boolean);
        blocks.push({ kind: 'paragraph', text: parts.join(' · '), indent: true });
      }
    }
    blocks.push({ kind: 'spacer', size: 'md' });

    // Items to seize — original boilerplate uses verbatim heading
    // "For the FOLLOWING PROPERTY, THING(s) or PERSON(s):" and emits
    // the property list as a flowing series of paragraphs (no numbered
    // sub-headings — flowing prose like the official template).
    blocks.push({ kind: 'heading-2', text: 'For the FOLLOWING PROPERTY, THING(s) or PERSON(s):' });
    const itemsObj = (res.itemsToSeize && typeof res.itemsToSeize === 'object') ? res.itemsToSeize : {};
    const itemBlocks = Array.isArray(itemsObj.blocks) ? itemsObj.blocks : [];
    if (!itemBlocks.length) {
      blocks.push({ kind: 'paragraph', text: '(no items-to-seize blocks selected — re-apply a crime-type preset or add items manually)', indent: true });
    } else {
      // Emit each block as flowing paragraphs WITHOUT a numbered/labelled
      // heading — matches the original template's untitled prose blocks.
      itemBlocks.forEach((b) => {
        const body  = _safe(b.body).trim();
        for (const p of _bodyParagraphs(body)) blocks.push(p);
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // END OF WARRANT — JUDGE'S MAGISTRATE BLOCK
    // ══════════════════════════════════════════════════════════════════
    // Verbatim recital + sworn/subscribed language + HOBBS/NIGHT
    // APPROVED check lines (judge fills these in) + magistrate signature
    // + court division + nighttime service endorsement line.
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({
      kind: 'paragraph',
      text:
        'AND TO SEIZE IT/THEM IF FOUND and bring it/them forthwith before me, or this court, at the ' +
        'courthouse of this court. This Search Warrant and Affidavit and attached and incorporated ' +
        `Affidavit were sworn to as true and subscribed before me on this _______ day of _________, ${yearNow}, at ` +
        '___________ A.M. / P.M. Wherefore, I find probable cause for the issuance of this Search Warrant and ' +
        'do issue it.',
    });
    blocks.push({ kind: 'spacer', size: 'sm', keepWithNext: true });
    blocks.push({ kind: 'cover-subheading', text: 'HOBBS SEALING APPROVED:   [ ] YES    [ ] NO', keepWithNext: true });
    blocks.push({ kind: 'cover-subheading', text: 'NIGHT SEARCH APPROVED:    [ ] YES    [ ] NO', keepWithNext: true });
    blocks.push({ kind: 'spacer', size: 'sm', keepWithNext: true });
    blocks.push({ kind: 'signature', label: '(Signature of Magistrate)', keepWithNext: true });
    blocks.push({
      kind: 'paragraph',
      text: `Judge of the Superior Court of California, County of ${countyTitle}, ${courtDivision}.`,
      keepWithNext: true,
    });
    blocks.push({
      kind: 'paragraph',
      text: 'Endorsement of Magistrate for Nighttime Service: _____________________________',
    });

    // ══════════════════════════════════════════════════════════════════
    // AFFIDAVIT — ATTACHED and INCORPORATED / STATEMENT OF PROBABLE CAUSE
    // ══════════════════════════════════════════════════════════════════
    blocks.push({ kind: 'page-break' });
    blocks.push({ kind: 'cover-subheading', text: 'ATTACHED and INCORPORATED' });
    blocks.push({ kind: 'cover-heading', text: 'STATEMENT OF PROBABLE CAUSE' });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // Original boilerplate opener (replaces the generic "I, Detective…
    // being first duly sworn…" wording).
    blocks.push({
      kind: 'paragraph',
      text:
        'Affiant declares under penalty of perjury that the following facts are true and that there is ' +
        'probable cause to believe, and Affiant does believe, that the designated articles, property, ' +
        'and persons are now in the described locations, including all rooms, buildings, and structures ' +
        'used in connection with the premises and buildings adjoining them, the vehicles and the persons:',
    });
    blocks.push({ kind: 'spacer', size: 'sm' });

    // (1) IDENTIFICATION AND EXPERTISE OF AFFIANT
    const te = (res.trainingExperience && typeof res.trainingExperience === 'object') ? res.trainingExperience : {};
    const teBody = (te.mode === 'inline')
      ? _safe(te.inlineBody)
      : _safe(agency.trainingExperienceBoilerplate);
    blocks.push({ kind: 'heading-2', text: '(1) IDENTIFICATION AND EXPERTISE OF AFFIANT:' });
    if (teBody.trim()) {
      for (const p of _bodyParagraphs(teBody)) blocks.push(p);
    } else {
      blocks.push({
        kind: 'paragraph',
        text: '(No training & experience boilerplate configured — set it in Settings → Warrant Author → Agency Profile, or switch this draft to inline T&E.)',
        indent: true,
      });
    }

    // (2) STATEMENT OF PROBABLE CAUSE — sourced from case-level pcNarrative
    blocks.push({ kind: 'heading-2', text: '(2) STATEMENT OF PROBABLE CAUSE:' });
    const _pcText = _safe(pcNarrative).trim();
    if (!_pcText) {
      blocks.push({
        kind: 'paragraph',
        text: '(Case Probable Cause not yet authored — open the Warrant Author header and complete the Case Probable Cause narrative before submission.)',
        indent: true,
      });
    } else {
      for (const p of _bodyParagraphs(_pcText)) blocks.push(p);
    }

    // (3) SPECIAL REQUEST OFF-SITE COMPUTER SEARCH (with verbatim 6-reason list)
    const opts = (res.optionalClauses && typeof res.optionalClauses === 'object') ? res.optionalClauses : {};
    const night = (opts.nightService && typeof opts.nightService === 'object') ? opts.nightService : {};
    const hobbs = (opts.hobbsSealing && typeof opts.hobbsSealing === 'object') ? opts.hobbsSealing : {};
    if (opts.offsiteComputerSearch) {
      blocks.push({ kind: 'heading-2', text: '(3) SPECIAL REQUEST OFF-SITE COMPUTER SEARCH:' });
      blocks.push({
        kind: 'paragraph',
        text:
          'Investigating officers are authorized, at their discretion, to seize all "computer systems," ' +
          '"computer programs or software," and "supporting documentation" as defined by Penal Code section 502, ' +
          'subdivision (b), including any supporting hardware, software or documentation that is necessary to ' +
          'the use of the system or is necessary to recover digital evidence from the system and any associated ' +
          'peripherals that are believed to contain some or all of the evidence described in the warrant, and to ' +
          'conduct an off-site search of the seized items for the evidence described. Investigating officers and ' +
          'those agents acting under the direction of the investigating officers are authorized to access all ' +
          'computer data to determine if the data contains "property," "records," and "information" as ' +
          'described above. If necessary, investigating officers are authorized to employ the use of outside ' +
          'experts, acting under the direction of the investigating officers, to access and preserve computer ' +
          'data.',
      });
      blocks.push({
        kind: 'paragraph',
        text:
          'For the following reasons, I request authorization to remove the described computers and computer-' +
          'related equipment from the premises and search them at a secure location:',
      });
      // Verbatim 6-reason enumeration from the original template
      blocks.push({ kind: 'paragraph', indent: true, text: '(1) The amount of data that may be stored digitally is enormous, and I do not know the number or size of the hard drives and removable storage devices on the premises that will have to be searched pursuant to this warrant.' });
      blocks.push({ kind: 'paragraph', indent: true, text: '(2) The listed data may be located anywhere on the hard drives and removable storage devices, including hidden files, program files, and "deleted" files that have not been overwritten.' });
      blocks.push({ kind: 'paragraph', indent: true, text: '(3) The data may have been encrypted, it may be inaccessible without a password, and it may be protected by self-destruct programming, all of which will take time to detect and bypass.' });
      blocks.push({ kind: 'paragraph', indent: true, text: '(4) Because data stored on computers can be easily destroyed or altered, either intentionally or accidentally, the search must be conducted carefully and in a secure environment.' });
      blocks.push({ kind: 'paragraph', indent: true, text: '(5) To prevent alteration of data and to ensure the integrity of the search, we plan to make clones/images of all drives and devices, and then search the clones/images; this, too, will take time and special equipment.' });
      blocks.push({ kind: 'paragraph', indent: true, text: '(6) A lengthy search at the scene may pose a severe hardship on all people who [live] [work] there, as it would require the presence of law enforcement officers to secure the premises while the search is being conducted.' });
    }

    // (4) AUTHORITY TO DUPLICATE ELECTRONIC MEDIA (verbatim original)
    if (opts.authorityToDuplicate) {
      blocks.push({ kind: 'heading-2', text: '(4) AUTHORITY TO DUPLICATE ELECTRONIC MEDIA:' });
      blocks.push({
        kind: 'paragraph',
        text:
          'It is further requested that a forensic technician, sworn or non-sworn, be granted authority to ' +
          'examine and make duplicate copies of any above listed computers, cell phones and/or other digital ' +
          'evidence to determine if evidence of the offenses enumerated are contained therein. Therefore, ' +
          'authorization is requested to make images/copies of the requested data. Evidence copies of the items ' +
          'relating to these offenses will be created and retained for further proceedings and made available to ' +
          'the authorities. Only those items recovered under the Search Warrant and relating to the offenses ' +
          'will be retained.',
      });
    }

    // Optional additional sections (kept from prior implementation —
    // these aren't in the original boilerplate but are useful when
    // the user toggles them on).
    if (opts.returnExtension) {
      blocks.push({ kind: 'heading-2', text: 'REQUEST FOR EXTENSION OF TIME FOR RETURN' });
      blocks.push({
        kind: 'paragraph',
        text:
          'Your affiant requests that the time for return of this warrant pursuant to Penal Code §1534 be ' +
          'extended to permit completion of forensic examination of any digital storage media seized. Forensic ' +
          'examination of digital media often requires extended time due to encryption, volume of data, queue ' +
          'at the forensic laboratory, and the technical complexity of the analysis.',
      });
    }
    if (night.enabled) {
      blocks.push({ kind: 'heading-2', text: 'REQUEST FOR NIGHT SERVICE (Penal Code §1533)' });
      for (const p of _bodyParagraphs(night.justification)) blocks.push(p);
    }
    if (hobbs.enabled) {
      blocks.push({ kind: 'heading-2', text: 'REQUEST TO SEAL AFFIDAVIT (People v. Hobbs)' });
      for (const p of _bodyParagraphs(hobbs.justification)) blocks.push(p);
    }

    // ══════════════════════════════════════════════════════════════════
    // END-OF-AFFIDAVIT — grounds recap + I pray + judge review block
    // ══════════════════════════════════════════════════════════════════
    blocks.push({ kind: 'spacer', size: 'md' });

    // Repeat the 8 PC §1524 grounds as the affiant's attestation that
    // those grounds apply. Original template renders this as the
    // "(6) STATUTORY GROUNDS:" section with checkbox indicators
    // mirroring the face-page checklist — keep that structure verbatim.
    if (opts.statutoryGroundsRecap !== false) {
      blocks.push({ kind: 'heading-2', text: '(6) STATUTORY GROUNDS:' });
      for (const [checked, text] of groundsList) {
        blocks.push({ kind: 'paragraph', text: `${box(!!checked)}  ${text}`, indent: true });
      }
    }

    // "I pray that a Search Warrant be issued…" closing paragraph
    blocks.push({
      kind: 'paragraph',
      text:
        'I pray that a Search Warrant be issued based upon the aforementioned facts, for the seizure of said ' +
        'property, or any part thereof, with good cause being shown thereof, and the same be brought before ' +
        'this Magistrate or retained subject to the order of the court, or of any court in which the offense(s) ' +
        'in respect to which the property of things taken, triable, pursuant to Section 1536 of the Penal Code.',
    });

    // Items attached & incorporated check line
    blocks.push({ kind: 'spacer', size: 'sm' });
    const itemsAttachedYes = (res.itemsIncorporatedByReference !== false);
    blocks.push({
      kind: 'paragraph',
      text: `Items attached and incorporated by Reference:   ${box(itemsAttachedYes)} YES    ${box(!itemsAttachedYes)} NO`,
    });
    blocks.push({
      kind: 'paragraph',
      text: 'I certify (declare) under penalty of perjury that the foregoing is true and correct.',
    });

    // "Executed at" / date / signature block — keep the city/date/sig
    // chain together so the affiant signature never orphans onto a fresh
    // page without the preceding execution context.
    blocks.push({ kind: 'spacer', size: 'sm', keepWithNext: true });
    const execAt = (res.executedAt && typeof res.executedAt === 'object') ? res.executedAt : {};
    const execCity = _safe(execAt.city) || _safe(agency.city) || '_______________';
    const execDate = _safe(execAt.date) || '';
    const execTime = _safe(execAt.time) || '';
    const execAmPm = _safe(execAt.timeAmPm) || '';
    // Format time as 12-hour clock (HH:MM) if a 24-hour HTML time value
    // came in (e.g. "14:30"); otherwise pass the raw user string through.
    function _fmt12(t) {
      const m = /^(\d{1,2}):(\d{2})/.exec(t);
      if (!m) return t;
      let h = parseInt(m[1], 10);
      if (h === 0) h = 12;
      else if (h > 12) h -= 12;
      return `${h}:${m[2]}`;
    }
    const execTimeFmt = execTime ? _fmt12(execTime) : '';
    // Compose the time portion: prefer "10:30 P.M." when both filled,
    // fall back to "_____ A.M./P.M." for incomplete drafts so the judge
    // can still pen-and-paper the missing field.
    const _ampmFull = execAmPm === 'AM' ? 'A.M.' : execAmPm === 'PM' ? 'P.M.' : '';
    const timePortion = (execTimeFmt && _ampmFull)
      ? `${execTimeFmt} ${_ampmFull}`
      : execTimeFmt
        ? `${execTimeFmt} A.M./P.M.`
        : '_____ A.M./P.M.';
    blocks.push({ kind: 'paragraph', text: `Executed at ${execCity}, California`, keepWithNext: true });
    const execDateLine = execDate
      ? `_______________________________________, ${execDate}, at ${timePortion}`
      : `_______________________________________, ______ day of __________, ${yearNow}, at ${timePortion}`;
    blocks.push({ kind: 'paragraph', text: execDateLine, keepWithNext: true });
    blocks.push({ kind: 'signature', label: `(Signature of Affiant)  ${affTitle}${_sigBadge}` });

    // Judge review line — original boilerplate. The entire judge-review
    // chain (Reviewed-by → Signature of Judge → court line → spacer →
    // Printed Name of Judge) is marked keepWithNext so the PDF composer
    // breaks it as a unit — prevents the final "(Printed Name of Judge)"
    // signature from orphaning alone on a fresh page.
    blocks.push({ kind: 'spacer', size: 'sm', keepWithNext: true });
    blocks.push({
      kind: 'paragraph',
      text: `Reviewed by : ____________________, _____ day of _________, ${yearNow}, at _______ A.M./P.M.`,
      keepWithNext: true,
    });
    blocks.push({ kind: 'signature', label: '(Signature of Judge)', keepWithNext: true });
    blocks.push({
      kind: 'paragraph',
      text: `Judge of the Superior Court of California, County of ${countyTitle}, ${courtDivision},`,
      keepWithNext: true,
    });

    // Printed name of judge line (final page of the original)
    blocks.push({ kind: 'spacer', size: 'md', keepWithNext: true });
    blocks.push({ kind: 'signature', label: '(Printed Name of Judge)' });

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
   * Virginia ESP — DC-338 + DC-339 official forms.
   *
   * IMPORTANT: This function is intentionally short-circuited.
   *
   * The DC-338 (Affidavit for Search Warrant) and DC-339 (Search Warrant)
   * are official Virginia magistrate forms with mandated layouts. Free-flowing
   * text reconstruction of those forms is non-compliant — they MUST be
   * generated by overlaying field values onto the official blank PDF masters
   * via the va-form-overlay.js module.
   *
   * This block builder is the text/DOCX path. While the PDF overlay path is
   * the canonical generator, this function emits ONLY:
   *   1. A visible WIP notice that the official DC-338/DC-339 require the
   *      PDF overlay path (which the generator wraps as embedded full-page
   *      images for DOCX export).
   *   2. The Attachment A (per-provider production schedule) and Attachment B
   *      (Statement of Material Facts / probable cause narrative) sections,
   *      which CAN be free-flowing text since they are appended to the form
   *      pages, not part of them.
   *
   * DO NOT add flow-text reconstructions of DC-338 or DC-339 content here.
   * If the official form layout needs to change, update va-form-overlay.js
   * and the blank PDF assets at templates/va/DC-{338,339}-blank.pdf.
   */
  function _buildVaEsp(draft, agency, caseInfo, addendumComposes, pcNarrative) {
    const blocks = [];
    const aff = draft.affiantSnapshot || {};
    const affName  = _safe(aff.affiantName)  || _safe(agency.affiantName)  || '________________';
    const affRank  = _safe(aff.affiantRank)  || _safe(agency.affiantRank)  || 'Detective';
    const affBadge = _safe(aff.affiantBadge) || _safe(agency.affiantBadge) || '';
    const affTitle = `${affRank} ${affName}`.replace(/\s+/g, ' ').trim();

    // NOTE: For the VA-multi-business-esp template, the official DC-338
    // Affidavit and DC-339 Search Warrant are produced by the PDF overlay
    // path (va-form-overlay.js) and merged in MAIN process before the
    // attachment PDF below is concatenated. The blocks below produce ONLY
    // the attachments — Attachment A (per-provider production schedule),
    // Attachment B (Statement of Material Facts), and conditional
    // Attachment C (Training & Experience Statement, when boilerplate
    // exceeds the inline DC-338 Text9 limit of 400 chars).
    //
    // For DOCX exports (no overlay path), Attachments A/B/C still carry
    // the substantive content. The DOCX composer may optionally embed
    // rasterized DC-338/DC-339 pages as images in a future enhancement.

    // ─── Attachment A — Per-provider production schedule ──────────────────
    if (Array.isArray(addendumComposes) && addendumComposes.length) {
      for (let i = 0; i < addendumComposes.length; i++) {
        const ac = addendumComposes[i] || {};
        blocks.push({ kind: 'heading-1', text: `ATTACHMENT A — PRODUCTION SCHEDULE${addendumComposes.length > 1 ? ` (${i + 1} of ${addendumComposes.length})` : ''}` });
        if (ac.providerName) {
          blocks.push({ kind: 'cover-meta', label: 'Provider', value: _safe(ac.providerName) });
        }
        if (ac.businessName) {
          blocks.push({ kind: 'cover-meta', label: 'Target', value: _safe(ac.businessName) });
        }
        blocks.push({ kind: 'spacer', size: 'sm' });
        for (const b of _buildAddendum(ac, i)) blocks.push(b);
        if (i < addendumComposes.length - 1) blocks.push({ kind: 'page-break' });
      }
      blocks.push({ kind: 'page-break' });
    }

    // ─── Attachment B — Statement of Material Facts ───────────────────────
    blocks.push({ kind: 'heading-1', text: 'ATTACHMENT B — STATEMENT OF MATERIAL FACTS' });
    blocks.push({ kind: 'spacer', size: 'sm' });
    if (pcNarrative && _safe(pcNarrative)) {
      for (const b of _buildProbableCause(pcNarrative)) blocks.push(b);
    } else {
      blocks.push({ kind: 'paragraph', text: '[ Probable cause narrative not provided. ]' });
    }

    // Affiant signature block at end of Attachment B.
    blocks.push({ kind: 'spacer', size: 'md' });
    blocks.push({ kind: 'paragraph', text: 'I declare under penalty of perjury under the laws of the Commonwealth of Virginia that the foregoing is true and correct.', keepWithNext: true });
    blocks.push({ kind: 'spacer', size: 'sm', keepWithNext: true });
    blocks.push({ kind: 'paragraph', text: `_________________________________________`, keepWithNext: true });
    blocks.push({ kind: 'paragraph', text: `(Signature of Affiant) ${affTitle}${affBadge ? `, Badge #${affBadge}` : ''}` });

    // ─── Attachment C — Training & Experience Statement ───────────────────
    // Attachment C contains ONLY the affiant's Training & Experience
    // boilerplate (agency.affiantTraining). Case-specific reliability
    // facts (va.knowledge.reliability) live INLINE in DC-338 Item 7 / Text9
    // and are NOT duplicated here.
    //
    // For VA Multi-Business ESP we always emit Att C when training content
    // exists. For other VA templates Att C only emits when training
    // exceeds the inline threshold (kept for backward compat).
    const VA_TRAINING_INLINE_MAX = 400;
    const trainingBody = _safe(agency.affiantTraining) || _safe(agency.trainingExperienceBoilerplate);
    const isEspTemplate = String(draft.template || '') === 'va-multi-business-esp';
    const shouldEmitAttC = trainingBody.length > 0 &&
      (isEspTemplate || trainingBody.length > VA_TRAINING_INLINE_MAX);
    if (shouldEmitAttC) {
      blocks.push({ kind: 'page-break' });
      blocks.push({ kind: 'heading-1', text: 'ATTACHMENT C — TRAINING & EXPERIENCE STATEMENT' });
      blocks.push({ kind: 'spacer', size: 'sm' });
      // Split on blank-line paragraph boundaries so the PDF/DOCX layout
      // renders multi-paragraph training boilerplate cleanly.
      const paragraphs = String(trainingBody).split(/\n\s*\n/);
      for (const para of paragraphs) {
        const text = String(para || '').trim();
        if (text) blocks.push({ kind: 'paragraph', text });
      }
      blocks.push({ kind: 'spacer', size: 'md' });
      blocks.push({ kind: 'paragraph', text: `_________________________________________`, keepWithNext: true });
      blocks.push({ kind: 'paragraph', text: `(Signature of Affiant) ${affTitle}${affBadge ? `, Badge #${affBadge}` : ''}` });
    }

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

    // Detect California jurisdiction once — used to switch the document
    // flow + emit running header/footer metadata for the composer.
    const isCa = (
      _safe(draft.template) === 'ca-multi-business-esp' ||
      _safe(draft.jurisdiction).toUpperCase() === 'CA'
    );
    // Detect Virginia jurisdiction — switches to DC-338/DC-339 ESP format.
    // Mutually exclusive with isCa (VA wins if both somehow set).
    const isVa = (
      _safe(draft.template) === 'va-multi-business-esp' ||
      _safe(draft.jurisdiction).toUpperCase() === 'VA' ||
      _safe(agency.state).toUpperCase() === 'VA'
    );
    const isResidential = (
      _safe(draft.type) === 'residential' ||
      _safe(draft.template) === 'ca-residential'
    );

    // 0-VA) Virginia ESP flow — DC-338 affidavit + DC-339 warrant + Attachment
    //       A (per provider) + Attachment B (Statement of Material Facts).
    //       Distinct top-level branch — returns early before CA/residential.
    if (isVa && !isResidential) {
      for (const b of _buildVaEsp(draft, agency, caseInfo, addendumComposes, pcNarrative)) blocks.push(b);
      const drNumberV = _safe(draft.caseRef) || _safe(caseInfo.caseNumber) || '';
      const fileNoV = _safe(draft.swNumber) || drNumberV || '';
      return {
        blocks,
        meta: {
          jurisdiction: 'VA',
          runningHeader: {
            enabled: true,
            lines: [
              `COMMONWEALTH OF VIRGINIA`,
              fileNoV ? `FILE NO. ${fileNoV}` : '',
            ].filter(Boolean),
          },
          runningFooter: {
            enabled: true,
            drNumber: drNumberV,
            revision: 'AFFIDAVIT / SEARCH WARRANT',
          },
        },
        stats: {
          addendums: addendumComposes.length,
          totalBlocks: blocks.length,
          danglingSlots: [],
          pcAuthored: !!(pcNarrative && String(pcNarrative).trim().length > 0),
          virginia: true,
        },
      };
    }

    // 0) Residential search-warrant flow — distinct top-level branch.
    //    Residential drafts never carry provider addendums; emit the
    //    full document (face page + affidavit + signature) and bail
    //    before the ESP flow runs.
    if (isResidential) {
      for (const b of _buildCaResidential(draft, agency, caseInfo, pcNarrative)) blocks.push(b);
      // Aggregate empty (no addendums, no dangling slots)
      const _STATE_FULL_R = {
        AL:'ALABAMA',AK:'ALASKA',AZ:'ARIZONA',AR:'ARKANSAS',CA:'CALIFORNIA',CO:'COLORADO',CT:'CONNECTICUT',
        DE:'DELAWARE',FL:'FLORIDA',GA:'GEORGIA',HI:'HAWAII',ID:'IDAHO',IL:'ILLINOIS',IN:'INDIANA',IA:'IOWA',
        KS:'KANSAS',KY:'KENTUCKY',LA:'LOUISIANA',ME:'MAINE',MD:'MARYLAND',MA:'MASSACHUSETTS',MI:'MICHIGAN',
        MN:'MINNESOTA',MS:'MISSISSIPPI',MO:'MISSOURI',MT:'MONTANA',NE:'NEBRASKA',NV:'NEVADA',NH:'NEW HAMPSHIRE',
        NJ:'NEW JERSEY',NM:'NEW MEXICO',NY:'NEW YORK',NC:'NORTH CAROLINA',ND:'NORTH DAKOTA',OH:'OHIO',OK:'OKLAHOMA',
        OR:'OREGON',PA:'PENNSYLVANIA',RI:'RHODE ISLAND',SC:'SOUTH CAROLINA',SD:'SOUTH DAKOTA',TN:'TENNESSEE',
        TX:'TEXAS',UT:'UTAH',VT:'VERMONT',VA:'VIRGINIA',WA:'WASHINGTON',WV:'WEST VIRGINIA',WI:'WISCONSIN',WY:'WYOMING',
      };
      const countyR = _safe(agency.county) || _safe(draft.county) || '__________________';
      const stateR = _STATE_FULL_R[(_safe(agency.state) || 'CA').toUpperCase()] || 'CALIFORNIA';
      const drNumR = _safe(draft.caseRef) || _safe(caseInfo.caseNumber) || '';
      return {
        blocks,
        stats: {
          addendums: 0,
          pcAuthored: !!(pcNarrative && String(pcNarrative).trim().length > 0),
          danglingSlots: [],
          residential: true,
        },
        meta: {
          runningHeader: {
            enabled: true,
            // Matches the verbatim San Bernardino residential SW boilerplate:
            // single centered banner — "STATE of CALIFORNIA, COUNTY of {COUNTY},"
            // (Section-specific subheadings like "ATTACHED and INCORPORATED" /
            //  "STATEMENT OF PROBABLE CAUSE" appear inline in the affidavit
            //  block stream, NOT in the running header — the original document
            //  only adds those on the SOPC face page.)
            lines: [
              `STATE of ${stateR}, COUNTY of ${countyR.toUpperCase()},`,
            ],
          },
          runningFooter: {
            enabled: true,
            drNumber: drNumR,
            revision: '',
          },
        },
      };
    }

    // 1) Cover / Face Page (jurisdiction-aware)
    //    CA template uses the official Multi-Business SW Face Page layout
    //    (oath, HOBBS/NIGHT checkboxes, signature, "See attachment: Page A
    //    for {Provider}" routing). All other templates fall through to the
    //    generic affidavit cover.
    if (isCa) {
      for (const b of _buildCaFacePage(draft, agency, caseInfo, addendumComposes)) blocks.push(b);
    } else {
      for (const b of _buildCover(draft, agency, caseInfo)) blocks.push(b);
    }

    if (isCa) {
      // 2-CA) Addendums FIRST (Pages A, B, C, ...) — per the sample warrant,
      //       attachments are physically incorporated before the Statement of
      //       Probable Cause body.
      addendumComposes.forEach((ac, i) => {
        for (const b of _buildAddendum(ac, i)) blocks.push(b);
      });
      // 3-CA) STATEMENT OF PROBABLE CAUSE body (verbatim CA closing) —
      //       contains identification & expertise, the PC narrative, the
      //       10-day return clause, HOBBS/NIGHT APPROVED checkboxes, and
      //       the judge signature block. Replaces the generic
      //       _buildProbableCause + _buildSignature pair.
      for (const b of _buildCaStatementOfProbableCause(draft, agency, caseInfo, pcNarrative)) blocks.push(b);
    } else {
      // Generic (non-CA) flow: PC heading → addendums → affidavit signature
      for (const b of _buildProbableCause(pcNarrative)) blocks.push(b);
      addendumComposes.forEach((ac, i) => {
        for (const b of _buildAddendum(ac, i)) blocks.push(b);
      });
      for (const b of _buildSignature(draft, agency)) blocks.push(b);
    }

    // Optional compliance disclaimer (suppressed for CA — the verbatim
    // CA template already closes with the affiant declaration + judge
    // signature; no further commentary belongs on a filed legal document).
    if (includeDisclaimer !== false && !isCa) {
      blocks.push({ kind: 'spacer', size: 'md' });
      blocks.push({
        kind: 'footer-disclaimer',
        text: 'Draft document. Not a substitute for legal review.',
      });
    }

    // Aggregate dangling slots (informational, composer can render warnings)
    const allDangling = [];
    for (const ac of addendumComposes) {
      const cs = (ac.compose && Array.isArray(ac.compose.danglingSlots)) ? ac.compose.danglingSlots : [];
      for (const d of cs) allDangling.push(`${ac.addendumId || ac.providerKey || '?'}/${d}`);
    }

    // Running header/footer metadata for the composer to stamp on every page.
    // Mirrors the sample San Bernardino SW (header + revision tag + DR#/CT#).
    // State must be SPELLED OUT in the header — this is a legal document, no
    // abbreviations. Map common postal abbreviations → full state name.
    const _STATE_FULL = {
      AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS',
      CA: 'CALIFORNIA', CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE',
      FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII', ID: 'IDAHO',
      IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA', KS: 'KANSAS',
      KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND',
      MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI',
      MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA',
      NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO', NY: 'NEW YORK',
      NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA',
      OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA',
      SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH',
      VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON', WV: 'WEST VIRGINIA',
      WI: 'WISCONSIN', WY: 'WYOMING', DC: 'DISTRICT OF COLUMBIA',
    };
    const county = _safe(agency.county) || _safe(draft.county) || '__________________';
    const rawState = (_safe(agency.state) || (isCa ? 'CA' : '')).toUpperCase();
    const state = _STATE_FULL[rawState] || rawState || 'CALIFORNIA';
    const drNumber = _safe(draft.caseRef) || _safe(caseInfo.caseNumber) || '';
    const ctNumber = _safe(draft.ctNumber) || _safe(draft.swNumber) || '';
    const runningHeader = isCa ? {
      enabled: true,
      lines: [
        `STATE of ${state}, COUNTY of ${county.toUpperCase()},`,
        'SEARCH WARRANT and AFFIDAVIT',
      ],
    } : { enabled: false, lines: [] };
    const runningFooter = isCa ? {
      enabled: true,
      revision: 'SEARCH WARRANT and AFFIDAVIT',
      drNumber,
      ctNumber: '',
    } : { enabled: false };

    return {
      blocks,
      meta: {
        jurisdiction: isCa ? 'CA' : (_safe(draft.jurisdiction).toUpperCase() || ''),
        runningHeader,
        runningFooter,
      },
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
    _internals: { _mapResolvedBlock, _abc, _buildCover, _buildCaFacePage, _buildProbableCause, _buildAddendum, _buildSignature, _buildCaStatementOfProbableCause, _buildVaEsp },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WarrantAuthorBlockBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis);
