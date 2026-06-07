// modules/warrant-author/pdf-composer.js
// PDF composition — RENDERER-side, uses jsPDF (already loaded by VIPER
// via libs/jspdf.umd.min.js, same as datapilot-report.js).
//
// Consumes the block stream produced by block-builder.js and emits a
// paginated US-Letter PDF in Times New Roman 12pt with 1" margins.
// Returns the result as an ArrayBuffer which the renderer hands to
// `warrant-author-write-output` IPC for disk persistence.
//
// Visual style (matches OPS Plan look):
//   - Letter (8.5" × 11"), portrait
//   - 1" margins (72pt)
//   - Times-Roman 12pt body, 14pt heading-2, 16pt heading-1 bold,
//     20pt cover-heading bold/centered
//   - Body line height 1.5 (single-spaced narrative reads cleanly on screen)
//   - Page footer: "Page X of N · {sw or caseRef} · {affiantName}"
//   - Disclaimer renders as italic small footer block on last page.

(function (root) {
  'use strict';

  const PAGE_W = 612; // 8.5 * 72
  const PAGE_H = 792; // 11 * 72
  const MARGIN = 72;  // 1 inch
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const FOOTER_RESERVE = 36;
  const CONTENT_BOTTOM = PAGE_H - MARGIN - FOOTER_RESERVE;

  const FONT_BODY      = { face: 'times', style: 'normal', size: 12, lh: 18 };
  const FONT_BODY_BOLD = { face: 'times', style: 'bold',   size: 12, lh: 18 };
  const FONT_ITALIC    = { face: 'times', style: 'italic', size: 10, lh: 14 };
  const FONT_H2        = { face: 'times', style: 'bold',   size: 13, lh: 20 };
  const FONT_H1        = { face: 'times', style: 'bold',   size: 15, lh: 22 };
  const FONT_COVER_H   = { face: 'times', style: 'bold',   size: 18, lh: 26 };
  const FONT_COVER_SUB = { face: 'times', style: 'normal', size: 14, lh: 22 };
  const FONT_META      = { face: 'times', style: 'normal', size: 11, lh: 16 };
  const FONT_FOOTER    = { face: 'times', style: 'normal', size: 9,  lh: 12 };
  // Running header (CA) — bold, 13pt, ~16pt line-height. Larger than body
  // so the state/county banner reads clearly on the printed page.
  const FONT_RUN_HDR   = { face: 'times', style: 'bold',   size: 16, lh: 20 };

  function _setFont(doc, font) {
    doc.setFont(font.face, font.style);
    doc.setFontSize(font.size);
  }

  function _splitToWidth(doc, text, font, maxWidth) {
    _setFont(doc, font);
    return doc.splitTextToSize(_safeText(text), maxWidth);
  }

  function _safeText(s) {
    if (s == null) return '';
    // jsPDF doesn't render real "smart quotes" with the core Times font;
    // normalize a couple common Unicode chars to ASCII to avoid blank glyphs.
    return String(s)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2013|\u2014/g, '-')
      .replace(/\u00a0/g, ' ')
      .replace(/\u00b7/g, '*');
  }

  function _spacerSize(size) {
    if (size === 'lg') return 24;
    if (size === 'md') return 14;
    return 6; // sm + default
  }

  /**
   * State machine that flows blocks across pages.
   * opts: { headerReserve, footerExtra } — both default 0.
   *   headerReserve — extra pt added to top margin (for CA running header)
   *   footerExtra   — extra pt subtracted from content bottom (for CA DR/CT footer)
   */
  function _flowBlocks(doc, blocks, opts) {
    opts = opts || {};
    const headerReserve = Math.max(0, opts.headerReserve | 0);
    const footerExtra   = Math.max(0, opts.footerExtra   | 0);
    const contentTop    = MARGIN + headerReserve;
    const contentBottom = CONTENT_BOTTOM - footerExtra;
    let pageIdx = 1;
    let y = contentTop;
    const footerPlaceholders = []; // {pageIdx} so we can stamp page X of N

    function newPage() {
      footerPlaceholders.push({ pageIdx });
      doc.addPage();
      pageIdx += 1;
      y = contentTop;
    }

    function ensureRoom(needed) {
      if (y + needed > contentBottom) newPage();
    }

    function drawCentered(font, text) {
      _setFont(doc, font);
      const lines = doc.splitTextToSize(_safeText(text), CONTENT_W);
      for (const ln of lines) {
        ensureRoom(font.lh);
        doc.text(ln, PAGE_W / 2, y + font.size, { align: 'center' });
        y += font.lh;
      }
    }

    function drawLeft(font, text, indent = 0) {
      _setFont(doc, font);
      const lines = doc.splitTextToSize(_safeText(text), CONTENT_W - indent);
      for (const ln of lines) {
        ensureRoom(font.lh);
        doc.text(ln, MARGIN + indent, y + font.size);
        y += font.lh;
      }
    }

    function drawRight(font, text) {
      _setFont(doc, font);
      const lines = doc.splitTextToSize(_safeText(text), CONTENT_W);
      for (const ln of lines) {
        ensureRoom(font.lh);
        doc.text(ln, PAGE_W - MARGIN, y + font.size, { align: 'right' });
        y += font.lh;
      }
    }

    function drawNumbered(items) {
      _setFont(doc, FONT_BODY);
      const indent = 24;
      items.forEach((raw, i) => {
        const num = `${i + 1}.`;
        const lines = doc.splitTextToSize(_safeText(raw), CONTENT_W - indent);
        // First line: write number then first line of text
        ensureRoom(FONT_BODY.lh);
        doc.text(num, MARGIN, y + FONT_BODY.size);
        doc.text(lines[0] || '', MARGIN + indent, y + FONT_BODY.size);
        y += FONT_BODY.lh;
        for (let j = 1; j < lines.length; j++) {
          ensureRoom(FONT_BODY.lh);
          doc.text(lines[j], MARGIN + indent, y + FONT_BODY.size);
          y += FONT_BODY.lh;
        }
        y += 2; // little gap between items
      });
    }

    function drawSignature(label) {
      ensureRoom(36);
      // signature line
      _setFont(doc, FONT_BODY);
      doc.line(MARGIN, y + 16, MARGIN + 280, y + 16);
      y += 22;
      doc.text(_safeText(label), MARGIN, y + FONT_BODY.size);
      y += FONT_BODY.lh + 6;
    }

    // First page footer placeholder
    footerPlaceholders.push({ pageIdx: 1 });

    for (const b of blocks) {
      switch (b.kind) {
        case 'cover-heading':
          ensureRoom(FONT_COVER_H.lh);
          drawCentered(FONT_COVER_H, b.text);
          break;
        case 'cover-subheading':
          ensureRoom(FONT_COVER_SUB.lh);
          drawCentered(FONT_COVER_SUB, b.text);
          break;
        case 'cover-meta':
          ensureRoom(FONT_META.lh);
          drawCentered(FONT_META, `${b.label}: ${b.value}`);
          break;
        case 'heading-1':
          ensureRoom(FONT_H1.lh + 4);
          y += 4; // little breathing room above
          drawLeft(FONT_H1, b.text);
          break;
        case 'heading-2':
          ensureRoom(FONT_H2.lh + 2);
          y += 2;
          drawLeft(FONT_H2, b.text);
          break;
        case 'paragraph':
          if (b.align === 'right') {
            drawRight(FONT_BODY, b.text);
          } else if (b.align === 'center') {
            drawCentered(FONT_BODY, b.text);
          } else {
            drawLeft(FONT_BODY, b.text, b.indent ? 18 : 0);
          }
          y += 4; // paragraph spacing
          break;
        case 'numbered':
          drawNumbered(Array.isArray(b.items) ? b.items : []);
          break;
        case 'signature':
          drawSignature(b.label);
          break;
        case 'page-break':
          newPage();
          break;
        case 'spacer':
          y += _spacerSize(b.size);
          if (y > contentBottom) newPage();
          break;
        case 'footer-disclaimer':
          ensureRoom(FONT_ITALIC.lh * 2);
          y += 6;
          _setFont(doc, FONT_ITALIC);
          drawCentered(FONT_ITALIC, b.text);
          break;
        default:
          // Skip unknown
          break;
      }
    }

    return { pageCount: pageIdx };
  }

  /**
   * Stamp the CA running header on every page (two centered, bold lines
   * just inside the top margin — matches the official San Bernardino SW).
   */
  function _stampHeaders(doc, pageCount, runningHeader) {
    if (!runningHeader || !runningHeader.enabled) return;
    const lines = Array.isArray(runningHeader.lines) ? runningHeader.lines.filter(Boolean) : [];
    if (!lines.length) return;
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      _setFont(doc, FONT_RUN_HDR);
      // First line sits ~28pt from top; subsequent lines stack by line-height.
      let hy = 30;
      for (const ln of lines) {
        doc.text(_safeText(ln), PAGE_W / 2, hy + FONT_RUN_HDR.size, { align: 'center' });
        hy += FONT_RUN_HDR.lh;
      }
    }
  }

  /**
   * Stamp footer text onto every page after rendering content.
   *
   * Default footer: "{affiant}                  Page X of N · {ref}"
   * CA running footer (when supplied): two lines — revision tag on top,
   * "DR # {drNumber}" on bottom (left-aligned). Matches the official
   * San Bernardino SW footer block.
   */
  function _stampFooters(doc, pageCount, { swNumber, caseRef, affiantName, runningFooter }) {
    const ref = (swNumber && swNumber.trim()) || (caseRef && caseRef.trim()) || '(no SW#)';
    const aff = (affiantName && affiantName.trim()) || '';
    const useCa = !!(runningFooter && runningFooter.enabled);
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      _setFont(doc, FONT_FOOTER);
      if (useCa) {
        // Line 1: revision tag + page X of N
        // Line 2: DR # ... — left-aligned bold
        const revision = _safeText(runningFooter.revision || '');
        const dr = _safeText(runningFooter.drNumber || '');
        const drLine = `DR # ${dr || '________________'}`;
        const pageLabel = `Page ${i} of ${pageCount}`;
        const footerY1 = PAGE_H - MARGIN + 14;
        const footerY2 = footerY1 + 12;
        // Top line: revision left, "Page X of N" right
        doc.text(revision, MARGIN, footerY1);
        doc.text(pageLabel, PAGE_W - MARGIN, footerY1, { align: 'right' });
        // Bottom line: DR # — left-aligned, bold
        _setFont(doc, FONT_BODY_BOLD);
        doc.text(drLine, MARGIN, footerY2);
      } else {
        const footerY = PAGE_H - MARGIN + 18;
        const pageLabel = `Page ${i} of ${pageCount}`;
        const left  = aff ? `${aff}` : '';
        const right = `${pageLabel} · ${ref}`;
        doc.text(left, MARGIN, footerY);
        doc.text(right, PAGE_W - MARGIN, footerY, { align: 'right' });
      }
    }
  }

  /**
   * Compose a PDF from a block stream.
   * @param {Object} args
   * @param {Object} args.blockStream — output of WarrantAuthorBlockBuilder.build(...)
   * @param {Object} args.draft       — for footer ref
   * @param {Object} args.agency      — for footer affiant name
   * @returns {{ arrayBuffer: ArrayBuffer, blob: Blob, pageCount: number }}
   */
  function composePdf({ blockStream, draft, agency }) {
    const jspdfLib = (typeof window !== 'undefined' && window.jspdf) || (typeof root.jspdf !== 'undefined' ? root.jspdf : null);
    if (!jspdfLib || !jspdfLib.jsPDF) {
      throw new Error('jsPDF not loaded — ensure libs/jspdf.umd.min.js is included before pdf-composer.js');
    }
    const { jsPDF } = jspdfLib;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });

    const blocks = (blockStream && Array.isArray(blockStream.blocks)) ? blockStream.blocks : [];
    const meta = (blockStream && blockStream.meta) || {};
    const runningHeader = meta.runningHeader || { enabled: false };
    const runningFooter = meta.runningFooter || { enabled: false };

    if (!blocks.length) {
      _setFont(doc, FONT_BODY);
      doc.text('(empty document)', MARGIN, MARGIN + 12);
      const ab = doc.output('arraybuffer');
      return { arrayBuffer: ab, blob: doc.output('blob'), pageCount: 1 };
    }

    // When a CA running header is enabled, only push content start down if
    // the header extends past the normal top margin. Header sits at y=30
    // and consumes (lines * lh) at FONT_RUN_HDR (16pt, lh=20). User spec:
    // leave one full body-line of breathing room (FONT_BODY.lh = 18pt)
    // between the header and the first body line.
    let headerReserve = 0;
    if (runningHeader.enabled && Array.isArray(runningHeader.lines) && runningHeader.lines.length) {
      const HDR_TOP = 30;
      const HDR_LH  = 20;
      const headerBottom = HDR_TOP + (runningHeader.lines.length * HDR_LH) + 6;
      const desiredContentTop = headerBottom + 18; // ~1 body line of gap
      if (desiredContentTop > 72 /* MARGIN */) {
        headerReserve = desiredContentTop - 72;
      }
    }
    // When a CA running footer is enabled, reserve an extra footer line
    // so body content doesn't run into the DR#/CT# strip.
    const footerExtra = (runningFooter.enabled) ? 14 : 0;
    const { pageCount } = _flowBlocks(doc, blocks, { headerReserve, footerExtra });

    const aff = (draft && draft.affiantSnapshot) || {};
    _stampHeaders(doc, pageCount, runningHeader);
    _stampFooters(doc, pageCount, {
      swNumber: (draft && draft.swNumber) || '',
      caseRef:  (draft && draft.caseRef)  || '',
      affiantName: aff.affiantName || (agency && agency.affiantName) || '',
      runningFooter,
    });

    const arrayBuffer = doc.output('arraybuffer');
    const blob = doc.output('blob');
    return { arrayBuffer, blob, pageCount };
  }

  const api = Object.freeze({
    composePdf,
    _internals: { _flowBlocks, _stampFooters, _stampHeaders, _safeText, PAGE_W, PAGE_H, MARGIN, CONTENT_W },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WarrantAuthorPdfComposer = api;
})(typeof window !== 'undefined' ? window : globalThis);
