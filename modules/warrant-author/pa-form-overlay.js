// modules/warrant-author/pa-form-overlay.js
//
// Pennsylvania AOPC 410A search-warrant form overlay.
//
// PURPOSE
//   The Pennsylvania "Application for Search Warrant and Authorization"
//   (AOPC 410A, Rev. 10/2024) and its Affidavit of Probable Cause are
//   mandated Unified Judicial System forms with fixed layouts. We must NOT
//   reconstruct them as free-flowing text — instead we fill the official
//   blank masters via their AcroForm fields, flow long narratives onto the
//   official continuation pages, and append photo exhibits.
//
//   Blank PDF assets (portrait 612×792, rotation 0):
//     templates/pa/application-blank.pdf                 (51 AcroForm fields)
//     templates/pa/application-continuation-blank.pdf    (11 AcroForm fields)
//     templates/pa/affidavit-blank.pdf                   (8  AcroForm fields)
//     templates/pa/affidavit-continuation-blank.pdf      (8  AcroForm fields)
//
// USAGE (Node main-process only — pdf-lib + fs)
//   const overlay = require('./pa-form-overlay.js');
//   const { bytes, warnings, pageCount } = await overlay.fillPaForms({
//     draft, agency, caseInfo,
//   });
//   -> `bytes` is the COMPLETE merged deliverable, ordered:
//        Application, [Application Continuation…], Affidavit,
//        [Affidavit Continuation…], [Photo Exhibits…]
//
// SCHEMA LOCK (confirmed by user — do not edit field names without re-confirm)
//
//   APPLICATION (officer-fill fields; everything else = court/issuing-authority,
//   left blank for the magistrate):
//     CountyOf                      county
//     PoliceIncidentNumber          case police incident #
//     WarrantControlNumber          agency warrant control #
//     IssuingAgency                 agency name
//     IssuingAgencyPhoneNum         agency phone
//     AffiantName                   affiant full name
//     DateOfApp                     date of application
//     AgencyOrAddressAffiant        agency address
//     AffiantBadge#                 affiant badge / serial
//     IDItemsForSearchSeize         items/persons to be searched for & seized (flow)
//     DescOfPremisesOrPersonSearched premises/person description (flow)
//     NameOfOwnerSearchedProp       owner / occupant / possessor
//     ViolationOf                   violation (conduct / statute)
//     DATES OF VIOLATION            date(s) of violation
//     ViolationCheckBox1 + DAFile#  DA-approved + DA file no. (optional)
//     ViolationCheckBox2            additional pages attached (auto if App-Cont exists)
//     ViolationCheckBox3            PC affidavit(s) attached (always on — we attach one)
//     TotalNumberOfAffidavitPages   computed count of affidavit-family pages
//     AffiantSignature1             LEFT BLANK (wet/ink sign at execution)
//
//   AFFIDAVIT:
//     COUNTY OF / IssuingAuthority / PoliceIncidNo / WarrantContNo   header
//     ProbableCauseFacts            LEFT EMPTY — narrative is drawn (paginated)
//     Signature1                    LEFT BLANK
//     AffiantDate                   LEFT BLANK (signed at execution)
//     Page                          "N"
//
//   AFFIDAVIT CONTINUATION:
//     COUNTY OF / IssuingAuthority / PoliceIncidNo / WarrantContNo   header
//     ProbableCauseFacts            LEFT EMPTY — overflow narrative / photos drawn
//     Signature1                    LEFT BLANK
//     Page / of                     "N" / "M"
//
//   APPLICATION CONTINUATION:
//     County / Issuing Authority / Police Incident Number / Warrant Control Number
//     Check Box18 = Items | Check Box17 = Premises/person |
//     Check Box16 = Owner/Occupant | Check Box15 = Violations
//     ContinuationField             LEFT EMPTY — overflow text drawn
//     Text3 / Text4                 page N / of M
//
// DRAFT DATA SHAPE (draft.pa.* — populated by warrant-author-ui.js)
//   draft.pa.county
//   draft.pa.policeIncidentNumber
//   draft.pa.warrantControlNumber
//   draft.pa.itemsToSearchSeize          → IDItemsForSearchSeize (+ overflow)
//   draft.pa.premisesDescription         → DescOfPremisesOrPersonSearched (+ overflow)
//   draft.pa.ownerOccupant               → NameOfOwnerSearchedProp
//   draft.pa.violationOf                 → ViolationOf
//   draft.pa.datesOfViolation            → DATES OF VIOLATION
//   draft.pa.daApproved (bool) + draft.pa.daFileNumber
//   draft.pa.probableCauseFacts          → affidavit narrative (falls back to
//                                           draft.probableCauseNarrative)
//   draft.pa.photos = [{ pngBase64|dataUrl, caption }]  → exhibit pages (2/page)
//   draft.pa.espContinuation             → ESP addendum records text, flowed
//                                           onto an Application Continuation
//                                           page (box 18). Built by the
//                                           renderer from draft.addendums[].
//
// AGENCY DATA SHAPE (from agency profile)
//   agency.agencyName / agency.affiantName / agency.affiantBadge
//   agency.phone / agency.agencyAddress / agency.city / agency.state / agency.county

const fs = require('fs');
const path = require('path');

let _pdfLib = null;
function _getPdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

// ────────────────────────────────────────────────────────────────────────────
// Asset paths
// ────────────────────────────────────────────────────────────────────────────
const PA_DIR = path.join(__dirname, 'templates', 'pa');
const APPLICATION_BLANK      = path.join(PA_DIR, 'application-blank.pdf');
const APPLICATION_CONT_BLANK = path.join(PA_DIR, 'application-continuation-blank.pdf');
const AFFIDAVIT_BLANK        = path.join(PA_DIR, 'affidavit-blank.pdf');
const AFFIDAVIT_CONT_BLANK   = path.join(PA_DIR, 'affidavit-continuation-blank.pdf');

function _loadBlank(p) {
  if (!fs.existsSync(p)) throw new Error(`[pa-form-overlay] missing blank PDF asset: ${p}`);
  return fs.readFileSync(p);
}

// ────────────────────────────────────────────────────────────────────────────
// Layout constants (PDF units, origin bottom-left). Derived from the AcroForm
// widget Rects of the 10.1.2024 masters. If the official form is re-revised
// and text lands off-box, re-measure and adjust HERE.
// ────────────────────────────────────────────────────────────────────────────

// Drawable regions expressed as { x, yBottom, w, h } (bottom-left anchored).
const REGION = {
  // application-blank.pdf
  appItems:    { x: 47, yBottom: 599, w: 514, h: 55 },   // IDItemsForSearchSeize [45,597,563,656]
  appPremises: { x: 47, yBottom: 525, w: 514, h: 57 },   // DescOfPremisesOrPersonSearched [45,523,563,584]
  // affidavit-blank.pdf ProbableCauseFacts [37,99,574,653]
  affNarrative:  { x: 41, yBottom: 103, w: 529, h: 546 },
  // affidavit-continuation-blank.pdf ProbableCauseFacts [37,72,574,653]
  affContNarr:   { x: 41, yBottom: 76,  w: 529, h: 573 },
  // application-continuation-blank.pdf ContinuationField [45,76,561,612]
  appContField:  { x: 49, yBottom: 80,  w: 508, h: 528 },
};

const FONT_SIZE      = 10;   // narrative + flow body
const LINE_HEIGHT    = 12.5; // body leading
const SHORT_FONT     = 9;    // short single-line AcroForm fields

// Photo-exhibit layout on the affidavit-continuation ProbableCauseFacts region.
// Two stacked slots, each with a caption line at its bottom.
const EXHIBIT = {
  captionH: 16,      // reserved for caption text at slot bottom
  gap: 14,           // vertical gap between the two slots
  pad: 6,            // inner padding around each image
};

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fill the Pennsylvania AOPC 410A application + affidavit and return the
 * complete merged deliverable.
 *
 * @param {object} opts
 * @param {object} opts.draft      Warrant draft (draft.pa.* + draft.probableCauseNarrative)
 * @param {object} opts.agency     Agency profile
 * @param {object} [opts.caseInfo] Optional case context (caseNumber, county)
 * @returns {Promise<{bytes: Buffer, warnings: string[], pageCount: number,
 *                     sectionPageCounts: object}>}
 */
async function fillPaForms(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('[pa-form-overlay] fillPaForms: opts required');
  }
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const draft   = opts.draft   || {};
  const agency  = opts.agency  || {};
  const caseInfo = opts.caseInfo || {};
  const pa = (draft.pa && typeof draft.pa === 'object') ? draft.pa : {};
  const warnings = [];

  // Shared header values (appear on affidavit + all continuations).
  const county = _safe(pa.county) || _safe(caseInfo.county) || _safe(agency.county);
  const issuingAuthority = _safe(pa.issuingAuthority);      // usually court-fill; blank ok
  const policeIncident = _safe(pa.policeIncidentNumber) || _safe(caseInfo.caseNumber);
  const warrantControl = _safe(pa.warrantControlNumber);

  // Resolve narrative (draft.pa.probableCauseFacts wins; else shared PC narrative).
  const narrative = _safe(pa.probableCauseFacts) || _safe(draft.probableCauseNarrative);

  // Photos → normalized [{bytes, isPng, caption}]
  const photos = _normalizePhotos(pa.photos, warnings);

  // ── Build the section page bytes (each its own filled+saved single-page PDF)
  const pages = []; // { bytes, family: 'application'|'affidavit', role }

  // 1) APPLICATION (+ collect overflow for the continuation)
  const appResult = await _fillApplication({
    draft, pa, agency, caseInfo, county, policeIncident, warrantControl, narrative, warnings,
  });
  pages.push({ bytes: appResult.bytes, family: 'application', role: 'application' });

  // 2) APPLICATION CONTINUATION pages (items/premises overflow + ESP addendum)
  const appContPages = await _buildApplicationContinuations({
    overflow: appResult.overflow, county, issuingAuthority, policeIncident, warrantControl, warnings,
    espText: _safe(pa.espContinuation),
  });
  appContPages.forEach(b => pages.push({ bytes: b, family: 'application', role: 'application-cont' }));

  // 3) AFFIDAVIT (first narrative page) + overflow lines
  const affResult = await _fillAffidavit({
    county, issuingAuthority, policeIncident, warrantControl, narrative, warnings,
  });
  const affidavitPages = [{ bytes: affResult.bytes, role: 'affidavit' }];

  // 4) AFFIDAVIT CONTINUATION pages for leftover narrative lines
  let leftover = affResult.overflowLines;
  while (leftover.length) {
    const cont = await _fillAffidavitContinuation({
      county, issuingAuthority, policeIncident, warrantControl, lines: leftover, warnings,
    });
    affidavitPages.push({ bytes: cont.bytes, role: 'affidavit-cont' });
    leftover = cont.overflowLines;
  }

  // 5) PHOTO EXHIBIT pages (2 photos per page, affidavit-continuation master)
  for (let i = 0; i < photos.length; i += 2) {
    const slice = photos.slice(i, i + 2);
    const ex = await _buildExhibitPage({
      county, issuingAuthority, policeIncident, warrantControl,
      photos: slice, startIndex: i, warnings,
    });
    affidavitPages.push({ bytes: ex.bytes, role: 'exhibit' });
  }

  // Affidavit-family total (drives TotalNumberOfAffidavitPages + Page/of).
  const affidavitTotal = affidavitPages.length;

  // Re-fill the affidavit-family page numbers now that we know the total, and
  // re-fill the application's TotalNumberOfAffidavitPages + attached checkboxes.
  const numberedAffidavit = await _applyAffidavitPageNumbers(affidavitPages, affidavitTotal, {
    county, issuingAuthority, policeIncident, warrantControl,
  }, warnings);

  // Rebuild the application with the now-known counts (affidavit pages + whether
  // an application-continuation exists).
  const appFinal = await _fillApplication({
    draft, pa, agency, caseInfo, county, policeIncident, warrantControl, narrative, warnings,
    affidavitPageCount: affidavitTotal,
    hasAppContinuation: appContPages.length > 0,
  });
  pages[0] = { bytes: appFinal.bytes, family: 'application', role: 'application' };

  // Splice the numbered affidavit-family pages after the application-family pages.
  numberedAffidavit.forEach(b => pages.push({ bytes: b, family: 'affidavit', role: 'affidavit-family' }));

  // ── Merge everything in order ────────────────────────────────────────────
  const merged = await PDFDocument.create();
  for (const p of pages) {
    const src = await PDFDocument.load(p.bytes);
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach(pg => merged.addPage(pg));
  }
  const out = await merged.save();

  return {
    bytes: Buffer.from(out),
    warnings,
    pageCount: merged.getPageCount(),
    sectionPageCounts: {
      application: 1 + appContPages.length,
      affidavit: affidavitTotal,
      photos: photos.length,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// APPLICATION
// ────────────────────────────────────────────────────────────────────────────
async function _fillApplication(ctx) {
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const {
    pa, agency, caseInfo, county, policeIncident, warrantControl, narrative, warnings,
    affidavitPageCount, hasAppContinuation,
  } = ctx;

  const doc = await PDFDocument.load(_loadBlank(APPLICATION_BLANK));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];

  // Header + short single-line fields
  _setText(form, 'CountyOf', county, warnings);
  _setText(form, 'PoliceIncidentNumber', policeIncident, warnings);
  _setText(form, 'WarrantControlNumber', warrantControl, warnings);
  _setText(form, 'IssuingAgency', _safe(agency.agencyName), warnings);
  _setText(form, 'IssuingAgencyPhoneNum', _safe(agency.affiantPhone) || _safe(agency.phone), warnings);
  _setText(form, 'AffiantName', _safe(agency.affiantName), warnings);
  _setText(form, 'DateOfApp', _safe(pa.dateOfApplication) || _today(), warnings);
  _setText(form, 'AgencyOrAddressAffiant', _safe(agency.agencyAddress) || _composeCityState(agency), warnings);
  _setText(form, 'AffiantBadge#', _safe(agency.affiantBadge), warnings);
  _setText(form, 'NameOfOwnerSearchedProp', _safe(pa.ownerOccupant), warnings);
  _setText(form, 'ViolationOf', _safe(pa.violationOf), warnings);
  _setText(form, 'DATES OF VIOLATION', _safe(pa.datesOfViolation), warnings);

  // DA-approval (optional)
  if (pa.daApproved === true) {
    _setCheckbox(form, 'ViolationCheckBox1', true, warnings);
    _setText(form, 'DAFile#', _safe(pa.daFileNumber), warnings);
  }

  // Flow the two large boxes; capture overflow for the continuation page.
  const overflow = { items: [], premises: [] };

  const itemLines = _wrap(font, FONT_SIZE, _safe(pa.itemsToSearchSeize), REGION.appItems.w);
  const itemsFit = _drawFlow(page, font, FONT_SIZE, LINE_HEIGHT, itemLines, REGION.appItems);
  if (itemsFit.overflow.length) {
    // Mark that the full list continues; draw a pointer on the last visible line.
    overflow.items = itemLines;
    _drawContinuedPointer(page, font, REGION.appItems);
  }

  const premLines = _wrap(font, FONT_SIZE, _safe(pa.premisesDescription), REGION.appPremises.w);
  const premFit = _drawFlow(page, font, FONT_SIZE, LINE_HEIGHT, premLines, REGION.appPremises);
  if (premFit.overflow.length) {
    overflow.premises = premLines;
    _drawContinuedPointer(page, font, REGION.appPremises);
  }

  const willHaveCont = (hasAppContinuation !== undefined)
    ? hasAppContinuation
    : (overflow.items.length > 0 || overflow.premises.length > 0);

  // Additional pages attached (checkbox 2) if a continuation page exists.
  if (willHaveCont) _setCheckbox(form, 'ViolationCheckBox2', true, warnings);

  // PC affidavit(s) attached — always true (we attach one) + page count.
  _setCheckbox(form, 'ViolationCheckBox3', true, warnings);
  if (typeof affidavitPageCount === 'number' && affidavitPageCount > 0) {
    _setText(form, 'TotalNumberOfAffidavitPages', String(affidavitPageCount), warnings);
  }

  // NOTE: AffiantSignature1 + all issuing-authority fields intentionally blank.

  await _finalize(form, doc, font, SHORT_FONT, warnings);
  return { bytes: await doc.save(), overflow };
}

// ────────────────────────────────────────────────────────────────────────────
// APPLICATION CONTINUATION (items / premises overflow)
// ────────────────────────────────────────────────────────────────────────────
async function _buildApplicationContinuations(ctx) {
  const { overflow, county, issuingAuthority, policeIncident, warrantControl, warnings, espText } = ctx;
  const { PDFDocument, StandardFonts } = _getPdfLib();

  const sections = [];
  if (overflow.items && overflow.items.length) {
    sections.push({ box: 18, title: 'ITEMS/PERSONS TO BE SEARCHED FOR AND SEIZED (continued):', lines: overflow.items });
  }
  if (overflow.premises && overflow.premises.length) {
    sections.push({ box: 17, title: 'DESCRIPTION OF PREMISES AND/OR PERSON TO BE SEARCHED (continued):', lines: overflow.premises });
  }
  // ESP addendum — the electronic-service-provider records to be produced.
  // Rendered onto the official continuation form (box 18 = items to be
  // searched for and seized) rather than a generic appended page. The
  // renderer supplies pre-formatted plain text via draft.pa.espContinuation.
  if (espText && String(espText).trim()) {
    const tmp = await PDFDocument.create();
    const measureFont = await tmp.embedFont(StandardFonts.Helvetica);
    const espLines = _wrap(measureFont, FONT_SIZE, espText, REGION.appContField.w);
    sections.push({ box: 18, title: 'ELECTRONIC SERVICE PROVIDER — RECORDS TO BE PRODUCED:', lines: espLines });
  }
  if (!sections.length) return [];

  // Build a queue of {title, box, lines} then flow across as many continuation
  // pages as needed. Section checkboxes are checked on every page the section
  // appears on.
  const outPages = [];
  let queue = sections.map(s => ({ ...s, lines: s.lines.slice() }));

  while (queue.length) {
    const doc = await PDFDocument.load(_loadBlank(APPLICATION_CONT_BLANK));
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0];

    _setText(form, 'County', county, warnings);
    _setText(form, 'Issuing Authority', issuingAuthority, warnings);
    _setText(form, 'Police Incident Number', policeIncident, warnings);
    _setText(form, 'Warrant Control Number', warrantControl, warnings);

    // Draw sections into ContinuationField top-down until the page fills.
    let cursorTop = REGION.appContField.yBottom + REGION.appContField.h;
    const bottom = REGION.appContField.yBottom;
    const boxesOnThisPage = new Set();
    const nextQueue = [];

    for (const sec of queue) {
      if (cursorTop - LINE_HEIGHT <= bottom) { nextQueue.push(sec); continue; }
      boxesOnThisPage.add(sec.box);
      // Title line (bold-ish via same font; it's a header)
      page.drawText(sec.title, { x: REGION.appContField.x, y: cursorTop - FONT_SIZE, size: FONT_SIZE, font });
      cursorTop -= LINE_HEIGHT;

      const remaining = [];
      let i = 0;
      for (; i < sec.lines.length; i++) {
        if (cursorTop - LINE_HEIGHT <= bottom) break;
        page.drawText(sec.lines[i], { x: REGION.appContField.x, y: cursorTop - FONT_SIZE, size: FONT_SIZE, font });
        cursorTop -= LINE_HEIGHT;
      }
      if (i < sec.lines.length) {
        remaining.push(...sec.lines.slice(i));
        nextQueue.push({ ...sec, lines: remaining });
      }
      cursorTop -= LINE_HEIGHT * 0.5; // spacer between sections
    }

    // Check the section boxes present on this page.
    // Check Box18=Items, 17=Premises, 16=Owner, 15=Violations (states /Off /Yes).
    boxesOnThisPage.forEach(n => _setCheckbox(form, `Check Box${n}`, true, warnings, 'Yes'));

    await _finalize(form, doc, font, SHORT_FONT, warnings);
    outPages.push(await doc.save());
    queue = nextQueue;
    if (outPages.length > 40) { warnings.push('application continuation exceeded 40 pages — truncated'); break; }
  }

  // Page N of M on Text3/Text4
  const m = outPages.length;
  for (let i = 0; i < outPages.length; i++) {
    const doc = await PDFDocument.load(outPages[i]);
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    _setText(form, 'Text3', String(i + 1), warnings);
    _setText(form, 'Text4', String(m), warnings);
    await _finalize(form, doc, font, SHORT_FONT, warnings);
    outPages[i] = await doc.save();
  }
  return outPages;
}

// ────────────────────────────────────────────────────────────────────────────
// AFFIDAVIT (first narrative page)
// ────────────────────────────────────────────────────────────────────────────
async function _fillAffidavit(ctx) {
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const { county, issuingAuthority, policeIncident, warrantControl, narrative, warnings } = ctx;

  const doc = await PDFDocument.load(_loadBlank(AFFIDAVIT_BLANK));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];

  _setText(form, 'COUNTY OF', county, warnings);
  _setText(form, 'IssuingAuthority', issuingAuthority, warnings);
  _setText(form, 'PoliceIncidNo', policeIncident, warnings);
  _setText(form, 'WarrantContNo', warrantControl, warnings);

  const lines = _wrap(font, FONT_SIZE, narrative, REGION.affNarrative.w);
  const fit = _drawFlow(page, font, FONT_SIZE, LINE_HEIGHT, lines, REGION.affNarrative);

  await _finalize(form, doc, font, SHORT_FONT, warnings);
  return { bytes: await doc.save(), overflowLines: fit.overflow };
}

// ────────────────────────────────────────────────────────────────────────────
// AFFIDAVIT CONTINUATION (narrative overflow)
// ────────────────────────────────────────────────────────────────────────────
async function _fillAffidavitContinuation(ctx) {
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const { county, issuingAuthority, policeIncident, warrantControl, lines, warnings } = ctx;

  const doc = await PDFDocument.load(_loadBlank(AFFIDAVIT_CONT_BLANK));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];

  _setText(form, 'COUNTY OF', county, warnings);
  _setText(form, 'IssuingAuthority', issuingAuthority, warnings);
  _setText(form, 'PoliceIncidNo', policeIncident, warnings);
  _setText(form, 'WarrantContNo', warrantControl, warnings);

  const fit = _drawFlow(page, font, FONT_SIZE, LINE_HEIGHT, lines, REGION.affContNarr);

  await _finalize(form, doc, font, SHORT_FONT, warnings);
  return { bytes: await doc.save(), overflowLines: fit.overflow };
}

// ────────────────────────────────────────────────────────────────────────────
// PHOTO EXHIBIT PAGE (2 photos per page, affidavit-continuation master)
// ────────────────────────────────────────────────────────────────────────────
async function _buildExhibitPage(ctx) {
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const { county, issuingAuthority, policeIncident, warrantControl, photos, startIndex, warnings } = ctx;

  const doc = await PDFDocument.load(_loadBlank(AFFIDAVIT_CONT_BLANK));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];

  _setText(form, 'COUNTY OF', county, warnings);
  _setText(form, 'IssuingAuthority', issuingAuthority, warnings);
  _setText(form, 'PoliceIncidNo', policeIncident, warnings);
  _setText(form, 'WarrantContNo', warrantControl, warnings);

  const R = REGION.affContNarr;
  const slotH = (R.h - EXHIBIT.gap) / 2;

  for (let s = 0; s < photos.length && s < 2; s++) {
    const ph = photos[s];
    // Slot 0 = top, slot 1 = bottom.
    const slotBottom = (s === 0)
      ? R.yBottom + slotH + EXHIBIT.gap
      : R.yBottom;
    const imgAreaBottom = slotBottom + EXHIBIT.captionH;
    const imgAreaH = slotH - EXHIBIT.captionH - EXHIBIT.pad;
    const imgAreaW = R.w - EXHIBIT.pad * 2;

    try {
      const embedded = ph.isPng ? await doc.embedPng(ph.bytes) : await doc.embedJpg(ph.bytes);
      const scale = Math.min(imgAreaW / embedded.width, imgAreaH / embedded.height, 1);
      const drawW = embedded.width * scale;
      const drawH = embedded.height * scale;
      const drawX = R.x + (R.w - drawW) / 2;
      const drawY = imgAreaBottom + (imgAreaH - drawH); // top-align within area
      page.drawImage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH });
    } catch (e) {
      warnings.push(`exhibit image ${startIndex + s + 1} embed failed: ${e.message}`);
      page.drawText(`[image ${startIndex + s + 1} could not be embedded]`,
        { x: R.x + EXHIBIT.pad, y: imgAreaBottom + imgAreaH / 2, size: FONT_SIZE, font });
    }

    const label = `Exhibit ${_exhibitLabel(startIndex + s)}`;
    const caption = _safe(ph.caption);
    const capText = _sanitize(caption ? `${label} — ${caption}` : label);
    const capLines = _wrap(font, SHORT_FONT, capText, R.w);
    // Draw up to 1 caption line (keep it tidy); truncate with ellipsis if longer.
    const cap = capLines.length > 1 ? _truncateToWidth(font, SHORT_FONT, capText, R.w) : (capLines[0] || label);
    page.drawText(cap, { x: R.x, y: slotBottom + 3, size: SHORT_FONT, font });
  }

  await _finalize(form, doc, font, SHORT_FONT, warnings);
  return { bytes: await doc.save() };
}

// ────────────────────────────────────────────────────────────────────────────
// Apply Page / of numbering to affidavit-family pages once total is known.
// ────────────────────────────────────────────────────────────────────────────
async function _applyAffidavitPageNumbers(affidavitPages, total, hdr, warnings) {
  const { PDFDocument, StandardFonts } = _getPdfLib();
  const out = [];
  for (let i = 0; i < affidavitPages.length; i++) {
    const doc = await PDFDocument.load(affidavitPages[i].bytes);
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pageNo = String(i + 1);
    // AFFIDAVIT (first) has a single 'Page' field; continuations have 'Page' + 'of'.
    _setText(form, 'Page', pageNo, warnings);
    _setText(form, 'of', String(total), warnings); // no-op if field absent (first affidavit)
    await _finalize(form, doc, font, SHORT_FONT, warnings);
    out.push(await doc.save());
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Text flow / wrapping helpers
// ────────────────────────────────────────────────────────────────────────────
// Map Unicode punctuation the standard (WinAnsi) fonts can't encode down to
// safe equivalents, then drop anything still outside the WinAnsi range so
// pdf-lib never throws on a real-world narrative (smart quotes, em-dashes,
// ellipses, bullets, non-breaking spaces, stray replacement chars, emoji …).
const _SMART = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2026': '...', '\u2022': '-', '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ',
  '\u2032': "'", '\u2033': '"', '\uFEFF': '', '\uFFFD': '',
};
function _sanitize(v) {
  const s = String(v == null ? '' : v);
  let out = '';
  for (const ch of s) {
    if (_SMART[ch] !== undefined) { out += _SMART[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (cp === 9 || cp === 10) { out += ch; continue; }   // tab / newline
    if (cp < 32) { out += ' '; continue; }                 // other control chars
    if (cp <= 126) { out += ch; continue; }                // ASCII printable
    if (cp >= 160 && cp <= 255) { out += ch; continue; }   // Latin-1 (WinAnsi-safe)
    out += '?';                                            // anything else
  }
  return out;
}

function _wrap(font, size, text, maxWidth) {
  const out = [];
  const paragraphs = _sanitize(text).replace(/\r\n/g, '\n').split('\n');
  for (const para of paragraphs) {
    if (para.trim() === '') { out.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const trial = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
        line = trial;
      } else {
        if (line) out.push(line);
        // Word longer than the line: hard-break it.
        if (font.widthOfTextAtSize(w, size) > maxWidth) {
          let chunk = '';
          for (const ch of w) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { out.push(chunk); chunk = ch; }
            else chunk += ch;
          }
          line = chunk;
        } else {
          line = w;
        }
      }
    }
    out.push(line);
  }
  return out;
}

// Draw as many lines as fit in region (top-down). Returns { overflow: [...] }.
function _drawFlow(page, font, size, lineHeight, lines, region) {
  const top = region.yBottom + region.h;
  const maxLines = Math.max(0, Math.floor(region.h / lineHeight));
  let y = top - size; // baseline of first line
  let i = 0;
  for (; i < lines.length && i < maxLines; i++) {
    if (lines[i]) page.drawText(lines[i], { x: region.x, y, size, font });
    y -= lineHeight;
  }
  return { overflow: lines.slice(i) };
}

function _drawContinuedPointer(page, font, region) {
  const txt = '(continued on continuation page)';
  const size = 8;
  page.drawText(txt, {
    x: region.x + region.w - font.widthOfTextAtSize(txt, size) - 2,
    y: region.yBottom + 2,
    size, font,
  });
}

function _truncateToWidth(font, size, text, maxWidth) {
  let s = text;
  const ell = '…';
  while (s.length > 1 && font.widthOfTextAtSize(s + ell, size) > maxWidth) s = s.slice(0, -1);
  return s + ell;
}

function _exhibitLabel(index0) {
  // 0 -> A, 25 -> Z, 26 -> AA …
  let n = index0, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// ────────────────────────────────────────────────────────────────────────────
// Photo normalization
// ────────────────────────────────────────────────────────────────────────────
function _normalizePhotos(photos, warnings) {
  if (!Array.isArray(photos)) return [];
  const out = [];
  for (const p of photos) {
    if (!p) continue;
    const raw = _safe(p.pngBase64) || _safe(p.dataUrl) || _safe(p.data) || (typeof p === 'string' ? p : '');
    if (!raw) continue;
    try {
      const { bytes, isPng } = _decodeImage(raw);
      out.push({ bytes, isPng, caption: _safe(p.caption) });
    } catch (e) {
      warnings.push(`photo decode failed: ${e.message}`);
    }
  }
  return out;
}

function _decodeImage(raw) {
  let s = String(raw);
  let mime = '';
  if (s.startsWith('data:')) {
    const m = /^data:([^;,]+)[;,]/.exec(s);
    if (m) mime = m[1].toLowerCase();
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  const bytes = Uint8Array.from(Buffer.from(s, 'base64'));
  // Sniff magic bytes: PNG = 89 50 4E 47 ; JPEG = FF D8 FF
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpg) {
    if (mime.includes('png')) return { bytes, isPng: true };
    if (mime.includes('jpg') || mime.includes('jpeg')) return { bytes, isPng: false };
    throw new Error('unsupported image type (need PNG or JPEG)');
  }
  return { bytes, isPng };
}

// ────────────────────────────────────────────────────────────────────────────
// AcroForm helpers (safe — never throw on missing fields)
// ────────────────────────────────────────────────────────────────────────────
function _setText(form, name, value, warnings) {
  if (!value) return 0;
  try {
    const field = form.getFieldMaybe ? form.getFieldMaybe(name) : form.getField(name);
    if (!field) return 0; // silently skip — continuations lack some fields by design
    if (typeof field.setText !== 'function') return 0;
    field.setText(_sanitize(value));
    return 1;
  } catch (e) {
    // Missing field on a given master is expected (e.g. 'of' on first affidavit).
    if (/no field/i.test(String(e && e.message))) return 0;
    warnings.push(`setText(${name}) failed: ${e.message}`);
    return 0;
  }
}

function _setCheckbox(form, name, checked, warnings, onState) {
  try {
    const field = form.getField(name);
    if (!field || typeof field.check !== 'function') return 0;
    if (checked) field.check();
    else field.uncheck();
    return 1;
  } catch (e) {
    if (/no field/i.test(String(e && e.message))) return 0;
    warnings.push(`setCheckbox(${name}) failed: ${e.message}`);
    return 0;
  }
}

async function _finalize(form, doc, font, size, warnings) {
  try {
    const { PDFTextField } = _getPdfLib();
    for (const f of form.getFields()) {
      if (f instanceof PDFTextField) {
        try { f.setFontSize(size); } catch (_) { /* auto-fit fields may lack /DA */ }
      }
    }
    form.updateFieldAppearances(font);
  } catch (e) {
    warnings.push(`updateFieldAppearances failed: ${e.message}`);
  }
}

function _composeCityState(agency) {
  const county = _safe(agency.county);
  const state = _safe(agency.state);
  if (county && state) return `${county} County, ${state}`;
  return county || state;
}

function _today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function _safe(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

module.exports = {
  fillPaForms,
  _internals: {
    _wrap, _drawFlow, _exhibitLabel, _normalizePhotos, _decodeImage,
    APPLICATION_BLANK, APPLICATION_CONT_BLANK, AFFIDAVIT_BLANK, AFFIDAVIT_CONT_BLANK,
    REGION,
  },
};
