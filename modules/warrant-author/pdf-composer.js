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
      // Paragraph-level pagination rules (judges dislike split sentences):
      //   • Short paragraphs (≤ 3 lines): keep entirely together — break
      //     the page first if it won't all fit on the current page.
      //   • Longer paragraphs: enforce widow/orphan ≥ 2 lines on each
      //     side of any break. If we can't honour that on the current
      //     page (fewer than 2 lines would fit, OR splitting here would
      //     orphan < 2 lines on the next page), break the page first.
      const widowOrphanMin = 2;
      if (font === FONT_BODY) {
        const totalH = lines.length * font.lh;
        const remaining = contentBottom - y;
        if (totalH > remaining) {
          if (lines.length <= 3) {
            // Short paragraph — keep together by starting a new page
            newPage();
          } else {
            const linesNowFit = Math.floor(remaining / font.lh);
            const linesLeftover = lines.length - linesNowFit;
            if (linesNowFit < widowOrphanMin || linesLeftover < widowOrphanMin) {
              newPage();
            }
          }
        }
      }
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

    /**
     * Centered heading with an underline sized to the rendered text.
     * Used by the Arkansas templates, whose exemplar centers, bolds AND
     * underlines every section heading. Other jurisdictions keep the
     * left-aligned bold heading drawn by drawLeft().
     */
    function drawCenteredUnderlined(font, text) {
      _setFont(doc, font);
      const lines = doc.splitTextToSize(_safeText(text), CONTENT_W);
      const cx = PAGE_W / 2;
      for (const ln of lines) {
        ensureRoom(font.lh + 3);
        const w = doc.getTextWidth(ln);
        const baseline = y + font.size;
        doc.text(ln, cx, baseline, { align: 'center' });
        doc.setLineWidth(0.7);
        doc.line(cx - w / 2, baseline + 1.8, cx + w / 2, baseline + 1.8);
        y += font.lh;
      }
    }

    /**
     * Word-level paragraph flow with an optional first-line indent and
     * optional full justification. jsPDF's splitTextToSize can't do
     * either (one wrap width, no word-space control), so we wrap greedily
     * against measured widths and place each word ourselves.
     *
     * opts: { firstIndent, justify, align }
     *   firstIndent — pt added to line 1's left edge only
     *   justify     — distribute slack into the word gaps on every line
     *                 EXCEPT the last of each hard-wrapped run (a
     *                 justified final line looks broken)
     *
     * Embedded newlines are honoured: each run between them flows as its
     * own paragraph (so a multi-paragraph probable-cause narrative keeps
     * its breaks and each sub-paragraph gets its own first-line indent).
     */
    function drawFlowed(font, text, opts) {
      opts = opts || {};
      const firstIndent = Math.max(0, opts.firstIndent | 0);
      _setFont(doc, font);
      const spaceW = doc.getTextWidth(' ');
      const segments = _safeText(text).split(/\r?\n/);

      // Lay out every segment first so widow/orphan control can see the
      // whole block height before the first line is committed.
      const laid = [];
      for (const seg of segments) {
        const words = seg.split(/\s+/).filter(Boolean);
        if (!words.length) { laid.push(null); continue; } // blank line
        let ind = firstIndent;
        let cur = [];
        let curW = 0;
        for (const w of words) {
          const ww = doc.getTextWidth(w);
          if (!cur.length) { cur = [w]; curW = ww; continue; }
          const need = curW + spaceW + ww;
          if (need > (CONTENT_W - ind)) {
            laid.push({ words: cur, indent: ind, width: curW, last: false });
            cur = [w]; curW = ww; ind = 0;
          } else {
            cur.push(w); curW = need;
          }
        }
        if (cur.length) laid.push({ words: cur, indent: ind, width: curW, last: true });
      }

      // Same paragraph-level pagination policy as drawLeft().
      const lineCount = laid.length;
      const totalH = lineCount * font.lh;
      const remaining = contentBottom - y;
      if (totalH > remaining) {
        if (lineCount <= 3) {
          newPage();
        } else {
          const linesNowFit = Math.floor(remaining / font.lh);
          if (linesNowFit < 2 || (lineCount - linesNowFit) < 2) newPage();
        }
      }

      for (const L of laid) {
        ensureRoom(font.lh);
        if (!L) { y += font.lh; continue; }
        const x0 = MARGIN + L.indent;
        const avail = CONTENT_W - L.indent;
        const gaps = L.words.length - 1;
        const slack = avail - L.width;
        _setFont(doc, font);
        // Don't justify the closing line of a segment, a single-word
        // line, or a line that would need grotesque word spacing.
        const doJustify = !!opts.justify && !L.last && gaps > 0
          && slack > 0 && slack < avail * 0.35;
        if (doJustify) {
          const gapW = spaceW + (slack / gaps);
          let x = x0;
          for (const w of L.words) {
            doc.text(w, x, y + font.size);
            x += doc.getTextWidth(w) + gapW;
          }
        } else if (opts.align === 'center') {
          doc.text(L.words.join(' '), PAGE_W / 2, y + font.size, { align: 'center' });
        } else {
          doc.text(L.words.join(' '), x0, y + font.size);
        }
        y += font.lh;
      }
    }

    /**
     * Three-column ")" caption (Arkansas). Column 1 carries the
     * STATE/COUNTY literals, the separator glyph sits at a real tab stop
     * and column 3 carries the document title / provider list. The tab
     * stop is the larger of the requested x and the widest measured
     * column-1 literal, so a long county name pushes the column instead
     * of colliding with it.
     */
    function drawCaptionTable(b) {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      if (!rows.length) return;
      _setFont(doc, FONT_BODY);
      const indent = Math.max(0, b.indent | 0);
      let sepCol = Math.max(0, b.sepCol | 0) || 234;
      let widest = 0;
      for (const r of rows) {
        widest = Math.max(widest, doc.getTextWidth(_safeText((r && r.left) || '')));
      }
      sepCol = Math.max(sepCol, indent + widest + 12);
      const sep = _safeText(b.sep || ')');
      const sepW = doc.getTextWidth(sep);
      const rightX = MARGIN + sepCol + sepW + 12;
      const rightW = Math.max(60, PAGE_W - MARGIN - rightX);
      const laid = rows.map(r => ({
        left: _safeText((r && r.left) || '').trim(),
        right: doc.splitTextToSize(_safeText((r && r.right) || '').trim(), rightW),
      }));
      const totalH = laid.reduce((a, L) => a + Math.max(1, L.right.length) * FONT_BODY.lh, 0);
      if (y + totalH > contentBottom) newPage();
      for (const L of laid) {
        const n = Math.max(1, L.right.length);
        _setFont(doc, FONT_BODY);
        if (L.left) doc.text(L.left, MARGIN + indent, y + FONT_BODY.size);
        doc.text(sep, MARGIN + sepCol, y + FONT_BODY.size);
        for (let i = 0; i < L.right.length; i++) {
          doc.text(L.right[i], rightX, y + FONT_BODY.size + (i * FONT_BODY.lh));
        }
        y += n * FONT_BODY.lh;
      }
    }

    /**
     * Two-column label/value block (Arkansas warrant page). `lead` sits
     * bold in column 1; every row renders a BOLD field label followed by
     * a plain value in column 2, exactly as the exemplar prints the
     * ordered provider's details.
     */
    function drawFieldTable(b) {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      // col === 0 is meaningful (a lead-less table sits flush at the left
      // margin), so don't collapse it with `|| default`.
      const col = (typeof b.col === 'number' && isFinite(b.col)) ? Math.max(0, b.col) : 216;
      const x2 = MARGIN + col;
      const w2 = Math.max(80, PAGE_W - MARGIN - x2);
      const lead = _safeText(b.lead || '').trim();
      const leadFont = b.leadBold ? FONT_BODY_BOLD : FONT_BODY;
      _setFont(doc, leadFont);
      const leadLines = lead ? doc.splitTextToSize(lead, Math.max(60, col - 12)) : [];
      const laid = rows.map(r => {
        const label = _safeText((r && r.label) || '').trim();
        const value = _safeText((r && r.value) || '').trim();
        _setFont(doc, FONT_BODY_BOLD);
        const labelW = label ? doc.getTextWidth(label + ' ') : 0;
        _setFont(doc, FONT_BODY);
        const wrapped = doc.splitTextToSize(value, Math.max(40, w2 - labelW));
        const head = wrapped.length ? wrapped[0] : '';
        const rest = wrapped.length > 1
          ? doc.splitTextToSize(wrapped.slice(1).join(' '), Math.max(40, w2 - 12))
          : [];
        return { label, labelW, head, rest };
      });
      const rowH = laid.reduce((a, L) => a + (1 + L.rest.length) * FONT_BODY.lh, 0);
      const totalH = Math.max(rowH, leadLines.length * FONT_BODY.lh);
      if (y + totalH > contentBottom) newPage();
      const y0 = y;
      leadLines.forEach((ln, i) => {
        _setFont(doc, leadFont);
        doc.text(ln, MARGIN, y0 + FONT_BODY.size + (i * FONT_BODY.lh));
      });
      let yy = y0;
      for (const L of laid) {
        if (L.label) {
          _setFont(doc, FONT_BODY_BOLD);
          doc.text(L.label, x2, yy + FONT_BODY.size);
        }
        _setFont(doc, FONT_BODY);
        if (L.head) doc.text(L.head, x2 + L.labelW, yy + FONT_BODY.size);
        yy += FONT_BODY.lh;
        for (const rl of L.rest) {
          doc.text(rl, x2 + 12, yy + FONT_BODY.size);
          yy += FONT_BODY.lh;
        }
      }
      y = y0 + totalH;
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

    function drawExhibitImage(b) {
      if (!b || !b.dataUrl) return;
      const fmt = /png/i.test(b.mime || '') ? 'PNG' : 'JPEG';
      const natW = b.w || 0;
      const natH = b.h || 0;
      const maxW = CONTENT_W;
      // Tallest an image may be: one full empty content page.
      const maxH = (contentBottom - contentTop) - 8;
      let w = maxW;
      let h;
      if (natW > 0 && natH > 0) {
        const ar = natH / natW;
        h = w * ar;
        if (h > maxH) { h = maxH; w = h / ar; }
      } else {
        h = Math.min(maxH, maxW * 0.75);
      }
      // Keep the whole image on one page where possible.
      if (y + h > contentBottom) newPage();
      const x = MARGIN + (CONTENT_W - w) / 2;
      try {
        doc.addImage(b.dataUrl, fmt, x, y, w, h, undefined, 'FAST');
        y += h + 8;
      } catch (e) {
        _setFont(doc, FONT_ITALIC);
        ensureRoom(FONT_ITALIC.lh);
        doc.text('[exhibit image could not be rendered]', MARGIN, y + FONT_ITALIC.size);
        y += FONT_ITALIC.lh + 6;
      }
    }

    // First page footer placeholder
    footerPlaceholders.push({ pageIdx: 1 });

    /**
     * Approximate height (pt) a block will consume when rendered.
     * Used by keepWithNext look-ahead to decide if a chain of blocks
     * should be pushed to the next page as a unit (e.g. judge review
     * chain: "Reviewed by..." + signature + court line + spacer +
     * "(Printed Name of Judge)" — we never want the last signature to
     * orphan alone on its own page).
     */
    function _measureBlock(b) {
      if (!b) return 0;
      switch (b.kind) {
        case 'paragraph': {
          _setFont(doc, b.bold ? FONT_BODY_BOLD : FONT_BODY);
          const indent = b.indent ? 18 : (b.firstIndent | 0);
          const lines = doc.splitTextToSize(_safeText(b.text), CONTENT_W - indent);
          return (lines.length * FONT_BODY.lh) + (b.tight ? 0 : 12);
        }
        case 'caption-table': {
          const rows = Array.isArray(b.rows) ? b.rows : [];
          return Math.max(1, rows.length) * FONT_BODY.lh;
        }
        case 'field-table': {
          const rows = Array.isArray(b.rows) ? b.rows : [];
          return Math.max(1, rows.length) * FONT_BODY.lh;
        }
        case 'cover-heading':    return FONT_COVER_H.lh;
        case 'cover-subheading': return FONT_COVER_SUB.lh;
        case 'cover-meta':       return FONT_META.lh;
        case 'heading-1':        return FONT_H1.lh + 12;
        case 'heading-2':        return FONT_H2.lh + 8;
        case 'signature':        return 22 + FONT_BODY.lh + 6;
        case 'exhibit-image': {
          const maxH = (CONTENT_BOTTOM - MARGIN) - 8;
          const natW = b.w || 0, natH = b.h || 0;
          if (natW > 0 && natH > 0) {
            let h = CONTENT_W * (natH / natW);
            if (h > maxH) h = maxH;
            return h + 8;
          }
          return Math.min(maxH, CONTENT_W * 0.75) + 8;
        }
        case 'spacer':           return _spacerSize(b.size);
        case 'page-break':       return 0;
        default:                 return FONT_BODY.lh;
      }
    }

    /**
     * Sum heights of `blocks[startIdx]` and any consecutive blocks
     * carrying `keepWithNext: true` (chain ends at the first block
     * WITHOUT the flag — that final block is part of the group too).
     * Returns 0 when the start block isn't part of a keep chain.
     */
    function _chainHeight(startIdx) {
      const start = blocks[startIdx];
      if (!start || !start.keepWithNext) return 0;
      let total = 0;
      for (let i = startIdx; i < blocks.length; i++) {
        total += _measureBlock(blocks[i]);
        if (!blocks[i].keepWithNext) break;
      }
      return total;
    }

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];

      // keepWithNext look-ahead: if the chain starting here won't fit
      // on the current page, force a page break BEFORE the chain begins.
      // Avoids orphaned trailing signatures (e.g. lone "(Printed Name
      // of Judge)" stranded on its own page).
      if (b.keepWithNext) {
        const chainH = _chainHeight(bi);
        if (chainH > 0 && (y + chainH) > contentBottom) {
          newPage();
        }
      }

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
          ensureRoom(FONT_H1.lh + 6);
          y += 8; // breathing room above section heading
          drawLeft(FONT_H1, b.text);
          y += 4;
          break;
        case 'heading-2':
          // orphanGuard reserves N following body lines so a section
          // header is never stranded at the foot of a page.
          ensureRoom(FONT_H2.lh + 4 + (Math.max(0, b.orphanGuard | 0) * FONT_BODY.lh));
          y += 6;
          // AR templates center + underline section headings; every other
          // jurisdiction keeps the original left-aligned bold heading.
          if (b.align === 'center' || b.underline) {
            drawCenteredUnderlined(FONT_H2, b.text);
          } else {
            drawLeft(FONT_H2, b.text);
          }
          y += 2;
          break;
        case 'paragraph': {
          const pFont = b.bold ? FONT_BODY_BOLD : FONT_BODY;
          if (b.justify || b.firstIndent) {
            // Word-placed flow — first-line indent and/or justification.
            drawFlowed(pFont, b.text, {
              firstIndent: b.firstIndent | 0,
              justify: !!b.justify,
              align: b.align,
            });
          } else if (b.align === 'right') {
            drawRight(pFont, b.text);
          } else if (b.align === 'center') {
            drawCentered(pFont, b.text);
          } else {
            drawLeft(pFont, b.text, b.indent ? 18 : 0);
          }
          // `tight` suppresses the inter-paragraph gap. AR prose marks its
          // paragraph breaks with a first-line indent instead of a blank
          // line, matching the exemplar; a gap there reads as a section
          // break the judge will look for and not find.
          if (!b.tight) y += 12;
          break;
        }
        case 'caption-table':
          drawCaptionTable(b);
          break;
        case 'field-table':
          drawFieldTable(b);
          break;
        case 'numbered':
          drawNumbered(Array.isArray(b.items) ? b.items : []);
          break;
        case 'signature':
          drawSignature(b.label);
          break;
        case 'exhibit-image':
          drawExhibitImage(b);
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
