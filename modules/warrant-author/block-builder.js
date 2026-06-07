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

    // 7) Command + addendum routing
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

    // Detect California jurisdiction once — used to switch the document
    // flow + emit running header/footer metadata for the composer.
    const isCa = (
      _safe(draft.template) === 'ca-multi-business-esp' ||
      _safe(draft.jurisdiction).toUpperCase() === 'CA'
    );

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
    _internals: { _mapResolvedBlock, _abc, _buildCover, _buildCaFacePage, _buildProbableCause, _buildAddendum, _buildSignature, _buildCaStatementOfProbableCause },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WarrantAuthorBlockBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis);
