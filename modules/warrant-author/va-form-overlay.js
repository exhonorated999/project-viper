// modules/warrant-author/va-form-overlay.js
//
// Virginia DC-338 (Affidavit) + DC-339 (Search Warrant) form overlay.
//
// PURPOSE
//   These two forms are mandated Supreme Court of Virginia magistrate forms
//   with fixed layouts. We must NOT reconstruct them as free-flowing text —
//   instead we fill the official blank masters via their AcroForm fields.
//
//   Blank PDF assets:
//     templates/va/DC-338-blank.pdf  (29 AcroForm fields, rotation=90)
//     templates/va/DC-339-blank.pdf  (42 AcroForm fields, rotation=0)
//
// USAGE (Node main-process only — pdf-lib + fs)
//   const overlay = require('./va-form-overlay.js');
//   const { dc338Bytes, dc339Bytes } = await overlay.fillVaForms({
//     draft, agency, caseInfo, addendumComposes,
//   });
//
// SCHEMA LOCK (confirmed by user — do not edit without re-confirmation)
//
//   DC-338 — page 1 (front, affidavit side)
//     Text1                 offense narrative (statute + facts)
//     Text2                 place / thing to search (premises description)
//     Text3                 "See Attachment A" static label
//     Text4                 foreign-corp facts (Va. Code § 19.2-70.3)
//     Text5                 "See Attachment B" static label
//     Name                  affiant full name
//     Title                 affiant title (rank + role)
//     Address               agency address
//     CityState             agency city, state
//     CB01..CB07            § 19.2-53 grounds checkboxes (items 1-5 on form)
//
//   DC-338 — page 2 (back)
//     Text6                 night-service good-cause justification
//     Text7, Text8          COURT-fill — leave blank
//     Text9                 affiant training & experience
//     ApplicantTitle        affiant rank label ("Officer", "Detective")
//     CB08                  item 5: "constitutes evidence of the offense"
//     CB15                  item 5: "is the person to be arrested"
//     CB10                  night-service REQUEST checkbox
//     CB12                  "I have personal knowledge" checkbox
//     CB13                  "I was advised of the facts" hearsay checkbox
//     CB09, CB11            COURT-fill (clerk delivery / magistrate jurat)
//     (APPLICANT signature underline — no AcroField; overlay separately)
//
//   DC-339 — page 1 (warrant front)
//     COMMONWEALTH OF VIRGINIA vIn re   advanced/custom (default blank)
//     "You are hereby commanded… place/person/thing 2"   premises desc
//     "1"                                      "Things to be seized" header → "See Attachment A"
//     "undefined"                              target-account caption: {Provider} Account "{id}"
//     "a person to be arrested… 1"             offense statute citation
//     "a person to be arrested… 2"             additional offense (optional)
//     "undefined_2", "undefined_3"             advanced/custom (default blank)
//     NAME OF AFFIANT                          affiant name
//     FILE NO, DATE AND TIME, CLERK            COURT-fill — leave blank
//
//   DC-339 — page 2 (return of service / inventory / jurat / notary)
//     ALL FIELDS = COURT/CLERK/EXECUTING-OFFICER/NOTARY fill — leave blank.
//
// VA UI DATA SHAPE (draft.va.* — populated by warrant-author-ui.js)
//   draft.va.offenseNarrative           → Text1
//   draft.va.placeDescription           → Text2 (DC-338) + "You are hereby commanded…" (DC-339)
//   draft.va.foreignCorpFacts           → Text4
//   draft.va.grounds                    → { c01: true, c02: false, ... c07 } → CB01..CB07
//   draft.va.nightService.requested     → CB10
//   draft.va.nightService.justification → Text6
//   draft.va.knowledge.personal         → CB12
//   draft.va.knowledge.hearsay          → CB13
//   draft.va.knowledge.reliability      → (free text appended to Text1 or in Att. B)
//   draft.va.targetAccounts             → [{ provider, type, identifier }] → "undefined"
//   draft.va.offenseCitations           → [string, string] → arrest-as-follows fields
//   draft.va.item5                      → { evidence: bool, person: bool } → CB08 / CB15
//   draft.va.advancedDc339              → { caption, mystery2, mystery3 } → advanced fields
//
// AGENCY DATA SHAPE (agency.affiant.* — from agency settings)
//   agency.affiantName        → DC-338 Name
//   agency.affiantTitle       → DC-338 Title
//   agency.affiantRank        → DC-338 ApplicantTitle
//   agency.affiantAddress     → DC-338 Address
//   agency.affiantCityState   → DC-338 CityState
//   agency.affiantTraining    → DC-338 Text9
//
// SIGNATURE OVERLAY
//   DC-338 page 2 has no AcroField for the affiant signature. If draft.va.
//   signatureImagePng (base64) is provided we draw it at fixed coords;
//   otherwise we draw the typed affiant name on the same line.
//   Coordinates derived from calibration PDF: see _SIGNATURE_COORDS_DC338.

const fs = require('fs');
const path = require('path');

// pdf-lib is lazy-loaded so this module is requireable in environments where
// pdf-lib isn't installed (e.g. quick CLI tools).
let _pdfLib = null;
function _getPdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

// ────────────────────────────────────────────────────────────────────────────
// Asset paths
// ────────────────────────────────────────────────────────────────────────────

const DC_338_BLANK_PATH = path.join(__dirname, 'templates', 'va', 'DC-338-blank.pdf');
const DC_339_BLANK_PATH = path.join(__dirname, 'templates', 'va', 'DC-339-blank.pdf');

function _loadBlank(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`[va-form-overlay] missing blank PDF asset: ${p}`);
  }
  return fs.readFileSync(p);
}

// ────────────────────────────────────────────────────────────────────────────
// Signature overlay coordinates (DC-338 page 2)
//
// DC-338 has page rotation=90 — widget Rects are in unrotated landscape space,
// page size is 612×792 stored as portrait. The "APPLICANT" signature underline
// sits to the right of "TITLE OF APPLICANT" near the bottom of page 2 (back).
//
// Coordinates are in PDF units (1/72"), origin = bottom-left of unrotated page.
// Width/height are the signature image's drawable region; if a signature
// image isn't provided we draw the typed name at this same anchor.
// ────────────────────────────────────────────────────────────────────────────

const _SIGNATURE_COORDS_DC338 = {
  // Approximate — calibrated against the "APPLICANT" underline on page 2.
  // If signatures land in the wrong spot the user can fine-tune these here.
  x: 410,
  y: 150,
  width: 180,
  height: 28,
};

// DC-338 form-field font size. The blank's auto-fit default lands oversized
// when pdf-lib regenerates appearances, so we pin it.
const _DC338_FIELD_FONT_SIZE = 10;

// DC-339 form-field font size. Same auto-fit issue, but the boxes are smaller
// so we drop one point.
const _DC339_FIELD_FONT_SIZE = 9;

// DC-339 "[ ] Supplemental sheet attached..." printed checkbox glyph location
// (no AcroForm widget — we draw an "X" overlay). Coords are in unrotated PDF
// units; calibrated against the printed "[ ]" at the start of the
// supplemental-sheet row (y ≈ 152 matches undefined_3 y=150).
const _DC339_SUPP_CHECKBOX = {
  x: 30,
  y: 152,
  size: 11,
};

// ────────────────────────────────────────────────────────────────────────────
// Font-size normalizer — runs across every AcroForm text field before
// regenerating appearance streams. Without this, pdf-lib uses the field's
// own DA (default appearance) which on these blanks is auto-fit (size 0),
// and pdf-lib's auto-fit calculation lands much too large in practice.
// ────────────────────────────────────────────────────────────────────────────
function _normalizeTextFontSizes(form, size, warnings) {
  const { PDFTextField } = _getPdfLib();
  let count = 0;
  for (const f of form.getFields()) {
    if (f instanceof PDFTextField) {
      try {
        f.setFontSize(size);
        count++;
      } catch (e) {
        // Some fields (notably signature-only fields) have no /DA appearance
        // entry — sizing them is a no-op, not an error. Suppress that
        // specific case; surface anything else.
        const msg = String(e && e.message || '');
        if (/No \/DA/i.test(msg)) continue;
        if (warnings) warnings.push(`setFontSize(${f.getName()}) failed: ${msg}`);
      }
    }
  }
  return count;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fill the DC-338 and DC-339 official Virginia search-warrant forms.
 *
 * @param {object} opts
 * @param {object} opts.draft      Warrant draft (draft.va.* + draft.template)
 * @param {object} opts.agency     Agency settings (affiant block, address, etc.)
 * @param {object} [opts.caseInfo] Optional case context (caseNumber etc.)
 * @param {Array}  [opts.addendumComposes] Provider-addendum array (used for target acct fallback)
 *
 * @returns {Promise<{dc338Bytes: Uint8Array, dc339Bytes: Uint8Array,
 *                    warnings: string[], filledFields: {dc338: number, dc339: number}}>}
 */
async function fillVaForms(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('[va-form-overlay] fillVaForms: opts required');
  }
  const draft = opts.draft || {};
  const agency = opts.agency || {};
  const addendumComposes = Array.isArray(opts.addendumComposes) ? opts.addendumComposes : [];

  const warnings = [];

  const dc338 = await _fillDc338({ draft, agency, addendumComposes, warnings });
  const dc339 = await _fillDc339({ draft, agency, addendumComposes, warnings });

  return {
    dc338Bytes: dc338.bytes,
    dc339Bytes: dc339.bytes,
    warnings,
    filledFields: { dc338: dc338.filled, dc339: dc339.filled },
    text9Overflowed: !!dc338.text9Overflowed,
    text9OverflowText: dc338.text9OverflowText || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DC-338 Affidavit overlay
// ────────────────────────────────────────────────────────────────────────────

async function _fillDc338({ draft, agency, addendumComposes, warnings }) {
  const { PDFDocument, rgb, StandardFonts, degrees } = _getPdfLib();
  const bytes = _loadBlank(DC_338_BLANK_PATH);
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();

  const va = (draft.va && typeof draft.va === 'object') ? draft.va : {};
  const _text9Overflow = { overflowed: false, overflowText: '' };

  // ─── Page 1 affiant fills ────────────────────────────────────────────────
  // ESP template defaults: when caller leaves a field blank, fall back to a
  // "See Attachment A" cross-reference so the form is self-consistent with
  // the CB03/05/07 "CONTINUED ON ATTACHED SHEET" checkmarks. The full
  // narrative lives on Attachment A (probable cause) / Attachment B (training).
  const isEsp = String(draft.template || '') === 'va-multi-business-esp';
  const espFallback = isEsp ? 'See Attachment A' : '';

  let filled = 0;
  // Item 1 — offense substantially described. Prefer composed narrative,
  // otherwise short statute citation, otherwise ESP attachment reference.
  const text1Body = _buildText1OffenseNarrative(va, draft, agency);
  filled += _setText(form, 'Text1', text1Body || espFallback, warnings);

  // Item 2 — place/person/thing to be searched. Prefer explicit description,
  // otherwise compose from target-account caption, otherwise ESP reference.
  const text2Body = _safe(va.placeDescription)
    || _buildTargetAccountCaption(va, addendumComposes)
    || espFallback;
  filled += _setText(form, 'Text2', text2Body, warnings);

  // Item 3 — things or persons to be searched for. Always "See Attachment A"
  // under the ESP template (Attachment A — Production Schedule lists the
  // categories of records being sought). Honor explicit override if present.
  const text3Body = _safe(va.thingsToSearchFor) || espFallback;
  filled += _setText(form, 'Text3', text3Body, warnings);

  // Item 3 foreign-corp facts — short cross-reference; full facts on Att A.
  const text4Body = _safe(va.foreignCorpFacts) || espFallback;
  filled += _setText(form, 'Text4', text4Body, warnings);

  // Item 4 — material facts constituting probable cause. ESP convention:
  // the full PC narrative lives on Attachment B (Statement of Material Facts).
  const text5Body = _safe(va.probableCauseSummary)
    || ((addendumComposes.length || va.placeDescription || isEsp) ? 'See Attachment B' : '');
  filled += _setText(form, 'Text5', text5Body, warnings);

  filled += _setText(form, 'Name', _safe(agency.affiantName), warnings);
  filled += _setText(form, 'Title', _safe(agency.affiantTitle) || _composeAffiantTitle(agency), warnings);
  filled += _setText(form, 'Address', _safe(agency.affiantAddress) || _safe(agency.agencyAddress), warnings);
  filled += _setText(form, 'CityState', _safe(agency.affiantCityState) || _composeCityState(agency), warnings);

  // §19.2-53 per-item checkboxes (CB01-CB07). These are NOT statutory
  // "grounds" — they're per-item modifiers scattered across items 1-3:
  //   CB01 = item 1 "an offense substantially described as follows"
  //   CB02 = item 1 "a person to be arrested for whom a warrant…"
  //   CB03 = item 1 "CONTINUED ON ATTACHED SHEET"
  //   CB04 = item 2 "and is a place of abode"
  //   CB05 = item 2 "CONTINUED ON ATTACHED SHEET"
  //   CB06 = item 3 foreign-corp electronic-records clause
  //   CB07 = item 3 "CONTINUED ON ATTACHED SHEET"
  // For the multi-business ESP template the defaults are deterministic:
  // offense (not arrest), all three items reference Attachment A, and
  // the records are held by a foreign corporation. The UI lets the user
  // override individual boxes via draft.va.grounds.cNN, but if the field
  // is omitted entirely we apply the ESP defaults so the form is not
  // missing structural checkmarks.
  const grounds = (va.grounds && typeof va.grounds === 'object') ? va.grounds : {};
  const espDefaults = (String(draft.template || '') === 'va-multi-business-esp')
    ? { c01: true, c02: false, c03: true, c04: false, c05: true, c06: true, c07: true }
    : {};
  for (let i = 1; i <= 7; i++) {
    const key = 'c' + String(i).padStart(2, '0');     // c01, c02, ..., c07
    const cbName = 'CB' + String(i).padStart(2, '0'); // CB01, CB02, ..., CB07
    const userVal = grounds[key];
    // user value wins if explicitly true/false; otherwise fall back to ESP default
    const effective = (userVal === true || userVal === false)
      ? userVal
      : (espDefaults[key] === true);
    if (effective === true) {
      filled += _setCheckbox(form, cbName, true, warnings);
    }
  }

  // ─── Page 2 affiant fills ────────────────────────────────────────────────
  const ns = (va.nightService && typeof va.nightService === 'object') ? va.nightService : {};
  if (ns.requested === true) {
    filled += _setCheckbox(form, 'CB10', true, warnings);
    filled += _setText(form, 'Text6', _safe(ns.justification), warnings);
  }

  const k = (va.knowledge && typeof va.knowledge === 'object') ? va.knowledge : {};
  if (k.personal === true) filled += _setCheckbox(form, 'CB12', true, warnings);
  if (k.hearsay === true) {
    filled += _setCheckbox(form, 'CB13', true, warnings);
    // Reliability/credibility facts go alongside the hearsay box.
    // The form gives a free-text region under item 7 — but it doesn't have
    // a named AcroField for that on page 2; we tack it onto Text9 (training)
    // with a clear separator only when training is already populated.
  }

  // Item 5: "The object, thing or person to be searched for [ ] constitutes
  // evidence of the commission of such offense [ ] is the person to be
  // arrested for whom a warrant or process for arrest has been issued."
  // For ESP warrants the evidence box is the standard pick (records constitute
  // evidence of the offense). Default it on when the template is the VA ESP
  // multi-business template and the caller hasn't specified.
  const item5 = (va.item5 && typeof va.item5 === 'object') ? va.item5 : {};
  let item5Evidence = item5.evidence;
  let item5Person   = item5.person;
  // ESP default: if neither user choice is set, tick "constitutes evidence".
  if (item5Evidence === undefined && item5Person === undefined) {
    if (String(draft.template || '') === 'va-multi-business-esp') {
      item5Evidence = true;
    }
  }
  if (item5Evidence === true) filled += _setCheckbox(form, 'CB08', true, warnings);
  if (item5Person === true)   filled += _setCheckbox(form, 'CB15', true, warnings);

  filled += _setText(form, 'Text9', _buildText9TrainingAndReliability(va, agency, _text9Overflow, draft), warnings);
  filled += _setText(form, 'ApplicantTitle', _safe(agency.affiantRank), warnings);

  // ─── Signature overlay on page 2 ─────────────────────────────────────────
  // DC-338 has page rotation=90; drawing text/images directly via drawText
  // inherits the page rotation transform, so naive coords render sideways at
  // the wrong location. For now we only support a real signature IMAGE
  // overlay (PNG bytes supplied by the caller); typed-name fallback is
  // skipped entirely to avoid a broken vertical artifact on the form.
  //
  // Affiants who want a typed signature should provide a PNG; otherwise the
  // form prints with a blank "APPLICANT" underline and the affiant signs by
  // hand at execution time — which is the normal Virginia practice anyway.
  if (_safe(va.signatureImagePng) || _safe(agency.affiantSignaturePng)) {
    try {
      const page2 = doc.getPages()[1];
      const sigB64 = _safe(va.signatureImagePng) || _safe(agency.affiantSignaturePng);
      if (page2 && sigB64) {
        const png = await doc.embedPng(_base64ToUint8(sigB64));
        const c = _SIGNATURE_COORDS_DC338;
        // Match the page's rotation so the image renders right-side-up
        // in the viewer's displayed orientation.
        const rot = page2.getRotation();
        page2.drawImage(png, {
          x: c.x, y: c.y, width: c.width, height: c.height,
          rotate: rot,
        });
      }
    } catch (e) {
      warnings.push(`DC-338 signature overlay failed: ${e.message}`);
    }
  }

  // Regenerate AcroForm widget appearance streams with an embedded Helvetica
  // font. This forces extended chars like § (0xA7 in WinAnsi) to render
  // correctly instead of round-tripping as mojibake.
  try {
    _normalizeTextFontSizes(form, _DC338_FIELD_FONT_SIZE, warnings);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helv);
  } catch (e) {
    warnings.push(`DC-338 updateFieldAppearances failed: ${e.message}`);
  }

  const out = await doc.save();
  return {
    bytes: out,
    filled,
    text9Overflowed: _text9Overflow.overflowed,
    text9OverflowText: _text9Overflow.overflowText,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DC-339 Warrant overlay
// ────────────────────────────────────────────────────────────────────────────

async function _fillDc339({ draft, agency, addendumComposes, warnings }) {
  const { PDFDocument } = _getPdfLib();
  const bytes = _loadBlank(DC_339_BLANK_PATH);
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();

  const va = (draft.va && typeof draft.va === 'object') ? draft.va : {};
  let filled = 0;

  // ─── Page 1 affiant fills ────────────────────────────────────────────────
  const isEsp = String(draft.template || '') === 'va-multi-business-esp';

  // Premises description (long field name preserved as-is from AcroForm).
  // ESP fallback: target-account caption when placeDescription is empty,
  // then "See Attachment A" as last resort.
  const searchLocation = _safe(va.placeDescription)
    || _buildTargetAccountCaption(va, addendumComposes)
    || (isEsp ? 'See Attachment A' : '');
  filled += _setText(
    form,
    'You are hereby commanded in the name of the Commonwealth to forthwith search the following place person or thing 2',
    searchLocation,
    warnings
  );

  // "1" field — "Things to be seized" header. Always "See Attachment A" for
  // ESP template; otherwise only if we have content or an addendum.
  if (isEsp || addendumComposes.length || _safe(va.placeDescription)) {
    filled += _setText(form, '1', 'See Attachment A', warnings);
  }

  // Note: the "undefined" caption field is filled below as part of the
  // 3-line v./In re caption block (target #2 → undefined).

  // Offense citations — the misleadingly-named "a person to be arrested..." fields
  const citations = Array.isArray(va.offenseCitations) ? va.offenseCitations : [];
  const primaryCitation = _safe(citations[0]) || _buildPrimaryCitation(va);
  if (primaryCitation) {
    filled += _setText(
      form,
      'a person to be arrested for whom a warrant or process for arrest has been issued identified as follows 1',
      primaryCitation,
      warnings
    );
  }
  const secondaryCitation = _safe(citations[1]);
  if (secondaryCitation) {
    filled += _setText(
      form,
      'a person to be arrested for whom a warrant or process for arrest has been issued identified as follows 2',
      secondaryCitation,
      warnings
    );
  }

  // Affiant name (rank + name combined for the magistrate's reference).
  filled += _setText(form, 'NAME OF AFFIANT', _composeAffiantTitle(agency), warnings);

  // Case caption (top right column, immediately under "v./In re").
  // Priority: explicit advanced override → first target account → first
  // addendum compose label → empty.
  const adv = (va.advancedDc339 && typeof va.advancedDc339 === 'object') ? va.advancedDc339 : {};
  const targetAccountsList = Array.isArray(va.targetAccounts) ? va.targetAccounts : [];
  let captionLine1 = _safe(adv.caption);
  if (!captionLine1 && targetAccountsList.length) {
    captionLine1 = _formatOneTargetAccount(targetAccountsList[0]);
  }
  if (!captionLine1 && Array.isArray(addendumComposes) && addendumComposes.length) {
    const first = addendumComposes[0] || {};
    const prov = _safe(first.providerName);
    const ident = _safe(first.businessName);
    if (prov && ident) captionLine1 = `${prov} Account "${ident}"`;
    else if (ident) captionLine1 = `Account "${ident}"`;
  }
  if (captionLine1) {
    filled += _setText(form, 'COMMONWEALTH OF VIRGINIA vIn re', captionLine1, warnings);
  }

  // Middle caption line (DC-339 right column, between line 1 and line 2).
  // Used as target #2 when multiple targets are present.
  if (targetAccountsList.length > 1) {
    const midCaption = _formatOneTargetAccount(targetAccountsList[1]);
    if (midCaption) {
      filled += _setText(form, 'undefined', midCaption, warnings);
    }
  }

  // undefined_2 — third-line continuation of the v./In re target-account
  // caption (sits directly below the middle line in the right column). If we
  // have a third target account it goes here; otherwise honors an advanced
  // override (captionLine2).
  let captionLine2 = '';
  if (targetAccountsList.length > 2) {
    captionLine2 = _formatOneTargetAccount(targetAccountsList[2]);
  }
  if (!captionLine2) captionLine2 = _safe(adv.captionLine2);
  if (captionLine2) {
    filled += _setText(form, 'undefined_2', captionLine2, warnings);
  }

  // undefined_3 — "Number of supplemental pages" count (narrow box at y=150).
  // Auto-computed by the PDF generator based on Attachment A/B/Training page
  // counts and passed in as draft.va.supplementalPageCount, OR explicitly
  // overridden via advanced field.
  const suppPages = _safe(adv.supplementalPageCount) || _safe(va.supplementalPageCount);
  if (suppPages) {
    filled += _setText(form, 'undefined_3', String(suppPages), warnings);
  }

  // ─── Page 2 affiant pre-fills (ESP) ─────────────────────────────────────
  // Most of page 2 is filled by the clerk/notary/magistrate at execution time.
  // For the multi-business ESP workflow the affiant typically also serves the
  // warrant electronically on the provider, so pre-populate the two
  // "EXECUTING OFFICER" lines with the affiant identity. The agency can wipe
  // these in Acrobat if a different deputy ends up serving the return.
  const execOfficer = _composeAffiantTitle(agency);
  if (execOfficer) {
    filled += _setText(form, 'EXECUTING OFFICER', execOfficer, warnings);
    filled += _setText(form, 'EXECUTING OFFICER_2', execOfficer, warnings);
  }

  // ─── Coordinate overlays for printed checkboxes (not AcroForm widgets) ──
  // DC-339 has all its checkbox glyphs printed onto the page; none are
  // interactive form fields. We draw an "X" via coordinates over the
  // "[ ] Supplemental sheet attached and incorporated by reference" box
  // whenever a supplemental sheet is attached (i.e., we wrote "See
  // Attachment A" into field "1" OR the caller passed supplementalPageCount).
  const supplementalAttached = (
    !!addendumComposes.length ||
    !!_safe(va.placeDescription) ||
    !!suppPages
  );
  if (supplementalAttached) {
    try {
      const page1 = doc.getPages()[0];
      const { StandardFonts: SF1 } = _getPdfLib();
      const fontX = await doc.embedFont(SF1.HelveticaBold);
      // Coords calibrated against the "[ ]" glyph on the supplemental-sheet line.
      page1.drawText('X', {
        x: _DC339_SUPP_CHECKBOX.x,
        y: _DC339_SUPP_CHECKBOX.y,
        size: _DC339_SUPP_CHECKBOX.size,
        font: fontX,
      });
    } catch (e) {
      warnings.push(`DC-339 supplemental checkbox overlay failed: ${e.message}`);
    }
  }

  // Normalize font sizes BEFORE regenerating appearances so values aren't
  // rendered at the AcroForm's auto-fit default (which lands wildly oversized).
  _normalizeTextFontSizes(form, _DC339_FIELD_FONT_SIZE, warnings);

  // Regenerate AcroForm widget appearances with embedded Helvetica so § etc.
  // render correctly.
  try {
    const { StandardFonts } = _getPdfLib();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helv);
  } catch (e) {
    warnings.push(`DC-339 updateFieldAppearances failed: ${e.message}`);
  }

  const out = await doc.save();
  return { bytes: out, filled };
}

// ────────────────────────────────────────────────────────────────────────────
// Field composers
// ────────────────────────────────────────────────────────────────────────────

function _buildText1OffenseNarrative(va, draft, agency) {
  // Prefer explicit offenseNarrative field. Otherwise compose from
  // code section + offense description (matches the SnapChat training aide
  // format: "§ 18.2-374.1:1 Possession, reproduction... ").
  if (_safe(va.offenseNarrative)) return _safe(va.offenseNarrative);

  const sec = _safe(va.codeSection);
  const desc = _safe(va.offenseDescription);
  if (sec && desc) return `§ ${sec} ${desc}`;
  if (sec) return `§ ${sec}`;
  return desc;
}

// Threshold (characters) above which the training boilerplate is too long to
// fit in the DC-338 Text9 box. Past this we substitute a "See attached" pointer
// and surface a flag so the generator appends a Training & Experience addendum.
//
// Calibrated against the SnapChat sample warrant — ~5 paragraphs of long-form
// prose is the realistic boilerplate length agencies use, well past any
// reasonable inline cap. Conservative cutoff at 400 keeps single-paragraph
// statements inline.
const _TEXT9_INLINE_MAX = 400;

function _buildText9TrainingAndReliability(va, agency, opts, draft) {
  // DC-338 Item 7 — credibility / reliability text area.
  //
  // This box holds CASE-SPECIFIC reliability/credibility facts about the
  // hearsay sources cited in the affidavit (per the form's instruction
  // "...may be determined from the following facts"). It is NOT for the
  // affiant's general Training & Experience boilerplate — that lives on
  // Attachment C and ONLY on Attachment C.
  //
  // Behavior:
  //   - If user provided draft.va.knowledge.reliability → render inline.
  //   - If reliability exceeds inline cap → pointer + flag overflow to Att C
  //     (rare; allows extremely long source attestations to spill into
  //     the appendix rather than truncating).
  //   - Otherwise → empty (let the affiant fill by hand at execution).
  //
  // NOTE: agency.affiantTraining is DELIBERATELY ignored here. Training
  // is appended exclusively to Attachment C via block-builder._buildVaEsp.
  void agency; void draft; // retained in signature for API stability
  const k = (va.knowledge && typeof va.knowledge === 'object') ? va.knowledge : {};
  const reliability = _safe(k.reliability);

  if (!reliability) return '';

  if (reliability.length > _TEXT9_INLINE_MAX) {
    if (opts && typeof opts === 'object') {
      opts.overflowed = true;
      opts.overflowText = reliability;
    }
    return 'See Attachment C — Reliability Statement';
  }

  return reliability;
}

function _buildTargetAccountCaption(va, addendumComposes) {
  // Preferred: explicit draft.va.targetAccounts list of {provider, type, identifier}.
  if (Array.isArray(va.targetAccounts) && va.targetAccounts.length) {
    return va.targetAccounts
      .map(t => _formatOneTargetAccount(t))
      .filter(Boolean)
      .join('; ');
  }
  // Fallback: derive from first addendum compose entry (providerName + businessName).
  if (Array.isArray(addendumComposes) && addendumComposes.length) {
    const first = addendumComposes[0] || {};
    const prov = _safe(first.providerName);
    const ident = _safe(first.businessName);
    if (prov && ident) return `${prov} Account "${ident}"`;
    if (ident) return `Account "${ident}"`;
  }
  return '';
}

function _formatOneTargetAccount(t) {
  if (!t || typeof t !== 'object') return '';
  const prov = _safe(t.provider) || 'Account';
  const ident = _safe(t.identifier);
  if (!ident) return '';
  // Per user direction: `{Provider} Account "{identifier}"` regardless of identifier type.
  return `${prov} Account "${ident}"`;
}

function _buildPrimaryCitation(va) {
  // Default to the codeSection + offenseDescription combo.
  const sec = _safe(va.codeSection);
  const desc = _safe(va.offenseDescription);
  if (sec && desc) return `§ ${sec} ${desc}`;
  if (sec) return `§ ${sec}`;
  return desc;
}

function _composeAffiantTitle(agency) {
  const rank = _safe(agency.affiantRank);
  const name = _safe(agency.affiantName);
  if (!name) return rank;
  if (!rank) return name;
  // Avoid "Detective Detective J. Moyer" if affiantName already starts with the rank.
  const nameLower = name.toLowerCase();
  const rankLower = rank.toLowerCase();
  if (nameLower.startsWith(rankLower + ' ') || nameLower === rankLower) {
    return name;
  }
  return `${rank} ${name}`.replace(/\s+/g, ' ').trim();
}

function _composeCityState(agency) {
  const city = _safe(agency.city);
  const state = _safe(agency.state);
  if (city && state) return `${city}, ${state}`;
  return city || state;
}

// ────────────────────────────────────────────────────────────────────────────
// AcroForm helpers (safe — never throw on missing fields)
// ────────────────────────────────────────────────────────────────────────────

function _setText(form, name, value, warnings) {
  if (!value) return 0;
  try {
    const field = form.getField(name);
    if (!field) {
      warnings.push(`text field not found: ${name}`);
      return 0;
    }
    if (typeof field.setText !== 'function') {
      warnings.push(`field ${name} is not a text field (kind=${field.constructor.name})`);
      return 0;
    }
    field.setText(String(value));
    return 1;
  } catch (e) {
    warnings.push(`setText(${name}) failed: ${e.message}`);
    return 0;
  }
}

function _setCheckbox(form, name, checked, warnings) {
  try {
    const field = form.getField(name);
    if (!field) {
      warnings.push(`checkbox not found: ${name}`);
      return 0;
    }
    if (typeof field.check !== 'function') {
      warnings.push(`field ${name} is not a checkbox (kind=${field.constructor.name})`);
      return 0;
    }
    if (checked) field.check();
    else field.uncheck();
    return 1;
  } catch (e) {
    warnings.push(`setCheckbox(${name}) failed: ${e.message}`);
    return 0;
  }
}

function _safe(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function _base64ToUint8(b64) {
  // Accepts data-URL or raw base64.
  let s = String(b64);
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma !== -1) s = s.slice(comma + 1);
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

module.exports = {
  fillVaForms,
  // Exported for tests:
  _internals: {
    _buildText1OffenseNarrative,
    _buildText9TrainingAndReliability,
    _buildTargetAccountCaption,
    _formatOneTargetAccount,
    _composeAffiantTitle,
    _composeCityState,
    DC_338_BLANK_PATH,
    DC_339_BLANK_PATH,
  },
};
