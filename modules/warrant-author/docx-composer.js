// modules/warrant-author/docx-composer.js
// DOCX composition — MAIN-process, uses the `docx` npm package.
// Consumes the block stream produced by block-builder.js and emits a
// US-Letter Word document that visually mirrors the jsPDF output:
//   - Times New Roman 12pt body, 1" margins
//   - Bold headings (cover 18, h1 15, h2 13)
//   - Numbered lists with hanging indent
//   - Signature blocks rendered as underscore line + label
//   - Page-break before each addendum
//   - Header: none by default (CA running banner only) — matches pdf-composer
//   - Footer: affiant (left) · "Page X of Y · SW#/Case Ref" (right)
//
// Returns a Buffer ready for disk persistence (encrypted by warrant-author-main
// when Field Security is active).

const docxLib = require('docx');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
  PageBreak, PageOrientation, Header, Footer, PageNumber,
  TabStopType, TabStopPosition, BorderStyle, ImageRun,
  Table, TableRow, TableCell, WidthType, TableLayoutType, LineRuleType,
  SectionType, CheckBox,
} = docxLib;

// Convert inches → twentieths-of-a-point (TWIPs) — Word's unit.
function _in(inches) { return Math.round(inches * 1440); }

// Leading, in twips, for a block. Blocks may state `lh` IN POINTS — the
// PDF composer's own line height — so Word matches the PDF instead of
// falling back to this module's 16pt default. Only the Arkansas blocks
// set it today; every other jurisdiction keeps `dflt`.
//
// Pair it with _lineRule(): with no w:lineRule Word treats w:line as a
// MULTIPLE of single spacing, not an absolute height, so an `lh` of 18pt
// would silently become 1.5 x single (~20.7pt in Times 12). AT_LEAST
// pins the absolute value while still growing for tall glyphs.
function _lineTw(b, dflt) {
  const lh = b && b.lh;
  return (typeof lh === 'number' && isFinite(lh) && lh > 0) ? Math.round(lh * 20) : dflt;
}
function _lineRule(b) {
  const lh = b && b.lh;
  return (typeof lh === 'number' && isFinite(lh) && lh > 0) ? LineRuleType.AT_LEAST : undefined;
}

// Twips for vertical spacing chunks (matching jsPDF spacer sizes ~6/14/24 pt).
function _spacerTwips(size) {
  if (size === 'lg') return 480; // 24pt -> 24*20
  if (size === 'md') return 280; // 14pt
  return 120;                    // sm -> 6pt
}

function _safe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\u00a0/g, ' ');
}

// Build a TextRun with consistent font + size (size is half-points).
function _run(text, opts = {}) {
  return new TextRun({
    text: _safe(text),
    font: 'Times New Roman',
    size: opts.size || 24,           // 12pt
    bold: !!opts.bold,
    italics: !!opts.italics,
  });
}

function _para(text, opts = {}) {
  return new Paragraph({
    children: [_run(text, opts)],
    alignment: opts.align || AlignmentType.LEFT,
    spacing: {
      before: opts.before || 0,
      after:  opts.after  || 120,    // ~6pt after paragraph
      line: 320,                     // 1.33x line height for readability
    },
    indent: opts.indent ? { left: opts.indent } : undefined,
  });
}

function _coverHeading(text) {
  return _para(text, { bold: true, size: 36, align: AlignmentType.CENTER, before: 120, after: 80 });
}

function _coverSubheading(text) {
  return _para(text, { size: 28, align: AlignmentType.CENTER, after: 80 });
}

function _coverMeta(label, value) {
  return _para(`${label}: ${value}`, { size: 22, align: AlignmentType.CENTER, after: 80 });
}

function _h1(text) {
  return new Paragraph({
    children: [_run(text, { bold: true, size: 30 })],
    spacing: { before: 240, after: 160, line: 320 },
  });
}

function _h2(text) {
  return new Paragraph({
    children: [_run(text, { bold: true, size: 26 })],
    spacing: { before: 160, after: 100, line: 320 },
  });
}

// Centered + bold + UNDERLINED section heading (Arkansas exemplar style).
// Every other jurisdiction keeps _h2 above. keepNext is Word's native
// orphan guard — the heading cannot end a page.
function _h2CenteredUnderlined(b) {
  const text = (b && typeof b === 'object') ? b.text : b;
  const line = _lineTw(b, 320);
  return new Paragraph({
    children: [new TextRun({
      text: _safe(text),
      font: 'Times New Roman',
      size: 26,
      bold: true,
      underline: {},
    })],
    alignment: AlignmentType.CENTER,
    keepNext: true,
    // 6pt before / 2pt after mirrors pdf-composer's heading-2 arm
    // (`y += 6` … `y += 2`). The module default of 160/100 opened a
    // visibly larger gap in Word than the same heading had in the PDF.
    spacing: { before: 120, after: 40, line, lineRule: _lineRule(b) },
  });
}

// ─── Borderless layout tables ─────────────────────────────────────────
// Word can fake columns with tab stops, but a tabbed paragraph wraps back
// to the paragraph indent, NOT to the tab column — so a long document
// title or provider name in the Arkansas caption spilled underneath
// column 1. A real (invisible) table wraps inside its cell, which is what
// pdf-composer does, so the two outputs agree.
const _NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const _NO_BORDERS = {
  top: _NO_BORDER, bottom: _NO_BORDER, left: _NO_BORDER, right: _NO_BORDER,
  insideHorizontal: _NO_BORDER, insideVertical: _NO_BORDER,
};

function _cell(widthTw, children) {
  return new TableCell({
    width: { size: widthTw, type: WidthType.DXA },
    borders: _NO_BORDERS,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    children,
  });
}

function _cellPara(text, line, opts = {}) {
  return new Paragraph({
    children: text ? [_run(text, opts)] : [],
    spacing: { before: 0, after: 0, line, lineRule: LineRuleType.AT_LEAST },
    alignment: AlignmentType.LEFT,
  });
}

// A table may not be the last body element of a section, and Word needs a
// paragraph between two consecutive tables. One empty, near-zero-height
// paragraph is the standard guard.
function _tableGuard() {
  return new Paragraph({
    children: [],
    spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
  });
}

// Three-column ")" caption (Arkansas). Column geometry comes verbatim
// from the block (points, measured from the LEFT MARGIN) so it matches
// pdf-composer's drawCaptionTable.
function _captionTable(b) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return [];
  const sep = _safe(b.sep || ')');
  const line = _lineTw(b, 300);
  const indentTw = Math.round((((b.indent | 0) || 72)) * 20);
  const sepTw = Math.round((((b.sepCol | 0) || 234)) * 20);
  const CONTENT_TW = _in(6.5);
  const col1 = Math.max(720, sepTw - indentTw);
  const col2 = 320;                                   // ~16pt ")" gutter
  const col3 = Math.max(1440, CONTENT_TW - indentTw - col1 - col2);
  const tbl = new Table({
    layout: TableLayoutType.FIXED,
    borders: _NO_BORDERS,
    indent: { size: indentTw, type: WidthType.DXA },
    width: { size: col1 + col2 + col3, type: WidthType.DXA },
    columnWidths: [col1, col2, col3],
    rows: rows.map(r => new TableRow({
      children: [
        _cell(col1, [_cellPara(_safe((r && r.left) || '').trim(), line)]),
        _cell(col2, [_cellPara(sep, line)]),
        _cell(col3, [_cellPara(_safe((r && r.right) || '').trim(), line)]),
      ],
    })),
  });
  return [tbl, _tableGuard()];
}

// Two-column label/value block (Arkansas). `lead` sits bold in column 1;
// every row prints a BOLD field label and a plain value in column 2.
// `col: 0` means there is no lead column, so the fields sit flush at the
// left margin as plain paragraphs — exactly what the PDF composer does.
function _fieldTable(b) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return [];
  const colPt = (typeof b.col === 'number' && isFinite(b.col)) ? Math.max(0, b.col) : 216;
  const colTw = Math.round(colPt * 20);
  const line = _lineTw(b, 300);
  const lead = _safe(b.lead || '').trim();

  if (colTw <= 0) {
    return rows.map((r) => {
      const label = _safe((r && r.label) || '').trim();
      const value = _safe((r && r.value) || '').trim();
      const kids = [];
      if (label) kids.push(_run(label + ' ', { bold: true }));
      if (value) kids.push(_run(value));
      return new Paragraph({ children: kids, spacing: { before: 0, after: 0, line, lineRule: LineRuleType.AT_LEAST } });
    });
  }

  const CONTENT_TW = _in(6.5);
  const col1 = Math.max(720, colTw);
  const col2 = Math.max(1440, CONTENT_TW - col1);
  const tbl = new Table({
    layout: TableLayoutType.FIXED,
    borders: _NO_BORDERS,
    width: { size: col1 + col2, type: WidthType.DXA },
    columnWidths: [col1, col2],
    rows: rows.map((r, i) => {
      const label = _safe((r && r.label) || '').trim();
      const value = _safe((r && r.value) || '').trim();
      const right = [];
      if (label) right.push(_run(label + ' ', { bold: true }));
      if (value) right.push(_run(value));
      return new TableRow({
        children: [
          _cell(col1, [(i === 0 && lead)
            ? _cellPara(lead, line, { bold: !!b.leadBold })
            : _cellPara('', line)]),
          _cell(col2, [new Paragraph({ children: right, spacing: { before: 0, after: 0, line, lineRule: LineRuleType.AT_LEAST } })]),
        ],
      });
    }),
  });
  return [tbl, _tableGuard()];
}

function _spacer(size) {
  // An EXACT line rule on an empty paragraph makes the gap exactly the
  // height pdf-composer reserves (6 / 14 / 24 pt). The previous form —
  // a space run at 12pt plus `after` — stacked the run's own line height
  // on top of the gap, so every spacer in the document came out roughly
  // three times taller in Word than in the PDF.
  return new Paragraph({
    children: [],
    spacing: { before: 0, after: 0, line: _spacerTwips(size), lineRule: LineRuleType.EXACT },
  });
}

// Numbered list — uses an inline tab-delimited approach so we don't depend on
// docx's numbering definitions (simpler + portable across viewers).
function _numberedItem(text, index) {
  return new Paragraph({
    children: [
      _run(`${index + 1}.`, {}),
      new TextRun({ text: '\t', font: 'Times New Roman', size: 24 }),
      _run(text, {}),
    ],
    indent: { left: 720, hanging: 360 }, // 0.5" indent with 0.25" hanging
    tabStops: [{ type: TabStopType.LEFT, position: 720 }],
    spacing: { before: 0, after: 80, line: 320 },
  });
}

function _signature(label) {
  // 60 underscores ≈ 4" line
  const underscores = '__________________________________________________';
  return [
    new Paragraph({
      children: [_run(underscores, {})],
      // The rule must never be the last line on a page with its label
      // stranded at the top of the next one — a signature line with no
      // caption is unsignable. jsPDF's flow keeps the pair together via
      // the orphan guard; keepNext is Word's equivalent.
      keepNext: true,
      spacing: { before: 240, after: 40, line: 240 },
    }),
    new Paragraph({
      children: [_run(_safe(label), {})],
      spacing: { before: 0, after: 200, line: 240 },
    }),
  ];
}

function _disclaimer(text) {
  return _para(text, { italics: true, size: 18, align: AlignmentType.CENTER, before: 200, after: 80 });
}

function _pageBreakPara() {
  return new Paragraph({
    children: [new TextRun({ children: [new PageBreak()] })],
  });
}

// Render an exhibit image block. dataUrl is a base64 data URI; decode to a
// Buffer and embed via ImageRun. Display size fits a 6.5" content width and
// caps at 9" tall, preserving aspect ratio from the stored w/h.
function _exhibitImage(b) {
  try {
    const dataUrl = String((b && b.dataUrl) || '');
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return [_para('[exhibit image missing]', { italics: true, align: AlignmentType.CENTER })];
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const type = /png/i.test(mime) ? 'png' : 'jpg';
    const MAXW = 624; // 6.5" @ 96dpi
    const MAXH = 864; // 9"   @ 96dpi
    let w = (b && b.w) || 0;
    let h = (b && b.h) || 0;
    if (!(w > 0 && h > 0)) { w = MAXW; h = Math.round(MAXW * 0.75); }
    let dw = MAXW;
    let dh = Math.round(dw * (h / w));
    if (dh > MAXH) { dh = MAXH; dw = Math.round(dh * (w / h)); }
    return [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 200 },
      children: [new ImageRun({ type, data: buf, transformation: { width: dw, height: dh } })],
    })];
  } catch (_e) {
    return [_para('[exhibit image could not be rendered]', { italics: true, align: AlignmentType.CENTER })];
  }
}

/**
 * Convert one block to one-or-more docx Paragraphs.
 */
function _renderBlock(b) {
  switch (b.kind) {
    case 'cover-heading':    return [_coverHeading(b.text)];
    case 'cover-subheading': return [_coverSubheading(b.text)];
    case 'cover-meta':       return [_coverMeta(b.label, b.value)];
    case 'heading-1':        return [_h1(b.text)];
    case 'heading-2':
      return [(b.align === 'center' || b.underline)
        ? _h2CenteredUnderlined(b)
        : _h2(b.text)];
    case 'caption-table':    return _captionTable(b);
    case 'field-table':      return _fieldTable(b);
    case 'paragraph': {
      const align = b.justify              ? AlignmentType.JUSTIFIED
                  : (b.align === 'right')  ? AlignmentType.RIGHT
                  : (b.align === 'center') ? AlignmentType.CENTER
                  : AlignmentType.LEFT;
      // after: 200 twips (~10pt) gives a clear visible gap between
      // paragraphs — important on un-indented legal-document prose
      // where "IT APPEARING", "IT IS ORDERED", etc. each open a new
      // logical section the reader needs to find quickly.
      // AR prose sets `tight` and marks its breaks with a first-line
      // indent instead, matching the exemplar.
      const firstLine = (b.firstIndent | 0) ? Math.round((b.firstIndent | 0) * 20) : 0;
      const line = _lineTw(b, 320);
      const indent = (b.indent || firstLine)
        ? { left: b.indent ? 360 : 0, firstLine: firstLine || undefined }
        : undefined;
      // Block text may carry hard line breaks. jsPDF's splitTextToSize
      // honours "\n", but a docx TextRun does NOT — the newline lands
      // verbatim inside <w:t> and Word collapses it to a space, which
      // silently fused every multi-paragraph boilerplate (training /
      // experience narratives, probable cause) into one wall of text.
      // Emit one Paragraph per segment so Word matches the PDF; a blank
      // segment becomes an empty paragraph, i.e. the blank line the
      // author typed.
      const segs = _safe(b.text).split(/\r?\n/);
      const mk = (t, isLast) => new Paragraph({
        children: t ? [_run(t, { bold: !!b.bold })] : [],
        alignment: align,
        spacing: { before: 0, after: (isLast && !b.tight) ? 200 : 0, line, lineRule: _lineRule(b) },
        indent,
      });
      if (segs.length <= 1) return [mk(segs[0] || '', true)];
      return segs.map((t, i) => mk(t, i === segs.length - 1));
    }
    case 'numbered': {
      const items = Array.isArray(b.items) ? b.items : [];
      return items.map((it, i) => _numberedItem(it, i));
    }
    case 'signature':        return _signature(b.label);
    case 'exhibit-image':    return _exhibitImage(b);
    case 'spacer':           return [_spacer(b.size)];
    case 'page-break':       return [_pageBreakPara()];
    case 'footer-disclaimer': return [_disclaimer(b.text)];
    default: return [];
  }
}

// ─── TEXAS layout (meta.layout === 'tx') ───────────────────────────────
// Mirrors pdf-composer's _flowTx: Letter, 0.5" top/bottom, 1" sides,
// Times 10pt single-spaced body, a blank line (size × 1.15) between
// blocks unless `tight`, framed boxes, "•" bullets, one Word SECTION per
// warrant / affidavit so "Page n of m" counts that section only
// (PageNumber.TOTAL_PAGES_IN_SECTION, numbering restarts at 1).
const TXD = Object.freeze({
  CONTENT_TW: 9360,     // 6.5" text column
  LH: 1.15,
  BULLET_X: 76,         // pt from the left margin (same as the PDF)
  TEXT_X: 96,
  BOX_OUT: 4,           // frame sits 4pt outside the text column
  BOX_PAD: 5,
  HDR_LEFT: 58,
});
const _TX_LINE = { style: BorderStyle.SINGLE, size: 5, color: '000000' };

// Font + text-column width for the TX layout. Layouts that reuse it (AZ)
// swap them for the duration of one _composeTxDocx call (the element tree
// is built synchronously, so nothing else can observe the swap).
let _txdFont = 'Times New Roman';
let _txdContentTw = TXD.CONTENT_TW;

function _txSz(b, dflt) { return Math.round(((b && b.size) || dflt || 10) * 2); }

// "**bold** plain" → TextRuns (unbalanced markers fall back to plain).
function _txRunsDocx(text, rich, bold, sizeHalf) {
  const s = _safe(text);
  const mk = (t, bb) => new TextRun({ text: t, font: _txdFont, size: sizeHalf, bold: !!bb });
  if (!rich || s.indexOf('**') === -1) return [mk(s, bold)];
  const parts = s.split('**');
  if (parts.length % 2 === 0) return [mk(s.replace(/\*\*/g, ''), bold)];
  return parts.map((t, i) => (t ? mk(t, bold || (i % 2 === 1)) : null)).filter(Boolean);
}

function _txGapPara(pt) {
  return new Paragraph({
    children: [],
    spacing: { before: 0, after: 0, line: Math.max(20, Math.round(pt * 20)), lineRule: LineRuleType.EXACT },
  });
}

function _txParagraphs(b, beforeTw) {
  const sizeHalf = _txSz(b, 10);
  const align = (b.align === 'center') ? AlignmentType.CENTER
              : b.justify ? AlignmentType.JUSTIFIED
              : (b.align === 'right') ? AlignmentType.RIGHT
              : AlignmentType.LEFT;
  const firstLine = (b.firstIndent | 0) ? Math.round((b.firstIndent | 0) * 20) : 0;
  const left = (b.indent > 0) ? Math.round(b.indent * 20) : 0;
  const ind = (firstLine || left)
    ? Object.assign({}, firstLine ? { firstLine } : {}, left ? { left } : {})
    : undefined;
  const segs = _safe(b.text).split(/\r?\n/);
  return segs.map((seg, i) => new Paragraph({
    children: seg.trim() ? _txRunsDocx(seg, b.rich, b.bold, sizeHalf) : [],
    alignment: align,
    indent: ind,
    keepLines: segs.length === 1 && seg.length < 320,
    keepNext: i < segs.length - 1,
    widowControl: true,
    spacing: { before: i === 0 ? (beforeTw || 0) : 0, after: 0, line: 240 },
  }));
}

function _txTitle(b, beforeTw) {
  return new Paragraph({
    children: [new TextRun({
      text: _safe(b.text), font: _txdFont, size: _txSz(b, 11), bold: true,
      underline: b.underline ? {} : undefined,
    })],
    alignment: AlignmentType.CENTER,
    keepNext: true,
    spacing: { before: beforeTw || 0, after: 0, line: 240 },
  });
}

function _txBullets(b, beforeTw, inBox) {
  const sizeHalf = _txSz(b, 10);
  const shift = inBox ? TXD.BOX_OUT : 0;
  const textTw = Math.round((TXD.TEXT_X - shift) * 20);
  const hang = Math.round((TXD.TEXT_X - TXD.BULLET_X) * 20);
  const items = Array.isArray(b.items) ? b.items : [];
  return items.map((it, idx) => {
    const segs = _safe((it && it.text) || '').split(/\r?\n/).filter(s => s.trim());
    const kids = [new TextRun({ text: '\u2022\t', font: _txdFont, size: sizeHalf })];
    segs.forEach((seg, i) => {
      const runs = _txRunsDocx(seg, it && it.rich, it && it.bold, sizeHalf);
      if (i > 0) kids.push(new TextRun({ text: '', break: 1, font: _txdFont, size: sizeHalf }));
      runs.forEach(r => kids.push(r));
    });
    return new Paragraph({
      children: kids,
      indent: { left: textTw, hanging: hang },
      tabStops: [{ type: TabStopType.LEFT, position: textTw }],
      keepLines: segs.join(' ').length < 320,
      widowControl: true,
      spacing: { before: idx === 0 ? (beforeTw || 0) : 0, after: 0, line: 240 },
    });
  });
}

function _txCaption(b) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return [];
  const sizeHalf = _txSz(b, 11);
  const col1 = Math.round((b.sepCol || 216) * 20);
  const col2 = Math.max(200, Math.round(((b.rightCol || 256) - (b.sepCol || 216)) * 20));
  const col3 = Math.max(1440, _txdContentTw - col1 - col2);
  const cp = (t) => new Paragraph({
    children: t ? [new TextRun({ text: _safe(t), font: _txdFont, size: sizeHalf, bold: !!b.bold })] : [],
    keepNext: true,
    spacing: { before: 0, after: 0, line: 240 },
  });
  const tbl = new Table({
    layout: TableLayoutType.FIXED,
    borders: _NO_BORDERS,
    width: { size: col1 + col2 + col3, type: WidthType.DXA },
    columnWidths: [col1, col2, col3],
    rows: rows.map(r => new TableRow({
      cantSplit: true,
      children: [
        _cell(col1, [cp((r && r.left) || '')]),
        _cell(col2, [cp(b.sep || '\u00a7')]),
        _cell(col3, [cp((r && r.right) || '')]),
      ],
    })),
  });
  return [tbl];
}

function _txSigColumns(b) {
  const sizeHalf = _txSz(b, 10);
  const left = Array.isArray(b.left) ? b.left : [];
  const right = Array.isArray(b.right) ? b.right : [];
  const n = Math.max(left.length, right.length);
  if (!n) return [];
  const col1 = Math.round((b.rightX || 252) * 20);
  const col2 = _txdContentTw - col1;
  const ruleTw = Math.round((b.ruleW || 200) * 20);
  const ep = (e, colTw, last) => {
    const base = { keepNext: !last, keepLines: true, spacing: { before: 0, after: 0, line: 240 } };
    if (!e || e.blank) return new Paragraph(Object.assign({ children: [] }, base));
    if (e.rule) {
      return new Paragraph(Object.assign({
        children: [],
        border: { bottom: _TX_LINE },
        indent: { right: Math.max(0, colTw - ruleTw) },
      }, base));
    }
    return new Paragraph(Object.assign({
      children: [new TextRun({ text: _safe(e.text), font: _txdFont, size: sizeHalf, bold: !!e.bold })],
      indent: e.indent ? { left: Math.round(e.indent * 20) } : undefined,
    }, base));
  };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    rows.push(new TableRow({
      cantSplit: true,
      children: [_cell(col1, [ep(left[i], col1, last)]), _cell(col2, [ep(right[i], col2, last)])],
    }));
  }
  const out = [];
  if (b.space) out.push(new Paragraph({
    children: [], keepNext: true,
    spacing: { before: 0, after: 0, line: Math.round(b.space * 20), lineRule: LineRuleType.EXACT },
  }));
  out.push(new Table({
    layout: TableLayoutType.FIXED,
    borders: _NO_BORDERS,
    width: { size: col1 + col2, type: WidthType.DXA },
    columnWidths: [col1, col2],
    rows,
  }));
  return out;
}

// ☒ / ☐ item → a clickable Word checkbox (content control) + tab, with
// the text hanging 22pt after the box (same geometry as the PDF).
function _txCheckbox(b, beforeTw) {
  const sizeHalf = _txSz(b, 10);
  const leftPt = (b.indent > 0 ? b.indent : 0) + 22;
  const leftTw = Math.round(leftPt * 20);
  const kids = [];
  try {
    kids.push(new CheckBox({ checked: !!b.checked }));
  } catch (_e) {
    kids.push(new TextRun({ text: b.checked ? '\u2612' : '\u2610', font: 'MS Gothic', size: sizeHalf }));
  }
  kids.push(new TextRun({ text: '\t', font: _txdFont, size: sizeHalf }));
  const segs = _safe(b.text).split(/\r?\n/).filter(s => s.trim());
  segs.forEach((seg, i) => {
    if (i > 0) kids.push(new TextRun({ text: '', break: 1, font: _txdFont, size: sizeHalf }));
    _txRunsDocx(seg, b.rich, b.bold, sizeHalf).forEach(r => kids.push(r));
  });
  return [new Paragraph({
    children: kids,
    indent: { left: leftTw, hanging: Math.round(22 * 20) },
    tabStops: [{ type: TabStopType.LEFT, position: leftTw }],
    keepLines: segs.join(' ').length < 320,
    widowControl: true,
    spacing: { before: beforeTw || 0, after: 0, line: 240 },
  })];
}

function _txBox(children) {
  const pad = Math.round(TXD.BOX_PAD * 20);
  const out = Math.round(TXD.BOX_OUT * 20);
  const w = _txdContentTw + out * 2;
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: w, type: WidthType.DXA },
    columnWidths: [w],
    indent: { size: -out, type: WidthType.DXA },
    borders: {
      top: _TX_LINE, bottom: _TX_LINE, left: _TX_LINE, right: _TX_LINE,
      insideHorizontal: _NO_BORDER, insideVertical: _NO_BORDER,
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: w, type: WidthType.DXA },
        margins: { top: pad, bottom: pad, left: out, right: out },
        children: children.length ? children : [new Paragraph({ children: [] })],
      })],
    })],
  });
}

// Blocks of ONE section → body elements. Gaps work like the PDF flow:
// each block leaves a pending gap (its line height unless `tight`) that
// the NEXT block opens with; box-start/-end reset it.
function _txSectionChildren(blocks) {
  const top = [];
  let target = top;          // where elements go (top or the open box)
  let box = null;
  let pending = 0;           // pt
  let started = false;       // anything placed in the current container
  const isTable = (el) => el instanceof Table;
  const push = (els) => { for (const el of els) target.push(el); };
  const beforeTw = () => (started && pending) ? Math.round(pending * 20) : 0;
  const gapIfTable = () => { if (started && pending) target.push(_txGapPara(pending)); };

  for (const b of blocks) {
    if (!b) continue;
    switch (b.kind) {
      case 'box-start':
        if (box) continue;
        if (started && pending) top.push(_txGapPara(pending));
        box = [];
        target = box;
        pending = 0;
        started = false;
        continue;
      case 'box-end':
        if (!box) continue;
        top.push(_txBox(box));
        top.push(_tableGuard());
        box = null;
        target = top;
        started = true;
        pending = 10 * TXD.LH;
        continue;
      case 'spacer':
        target.push(_spacer(b.size));
        continue;
      case 'page-break':
        target.push(_pageBreakPara());
        started = false;
        pending = 0;
        continue;
      case 'section-break':
        continue;
      default:
        break;
    }
    let els;
    switch (b.kind) {
      case 'caption-table': gapIfTable(); els = _txCaption(b); break;
      case 'sig-columns':   gapIfTable(); els = _txSigColumns(b); break;
      case 'heading-2':
        els = (b.align === 'center' || b.underline)
          ? [_txTitle(b, beforeTw())]
          : _txParagraphs({ text: b.text, bold: true, size: b.size || 11 }, beforeTw());
        break;
      case 'heading-1':
        els = _txParagraphs({ text: b.text, bold: true, size: 11 }, beforeTw());
        break;
      case 'paragraph': els = _txParagraphs(b, beforeTw()); break;
      case 'bullets':   els = _txBullets(b, beforeTw(), !!box); break;
      case 'checkbox':  els = _txCheckbox(b, beforeTw()); break;
      case 'exhibit-image': els = _exhibitImage(b); break;
      default:
        els = b.text ? _txParagraphs({ text: b.text, size: 10 }, beforeTw()) : [];
    }
    push(els);
    if (els.length && isTable(els[els.length - 1])) target.push(_tableGuard());
    started = true;
    pending = b.tight ? 0 : ((b.size || 10) * TXD.LH);
  }
  if (box) { top.push(_txBox(box)); top.push(_tableGuard()); }
  if (!top.length || isTable(top[top.length - 1])) top.push(_tableGuard());
  return top;
}

async function _composeTxDocx({ blockStream, draft }) {
  const meta = blockStream.meta || {};
  const rh = meta.runningHeader || {};
  const leftText = _safe(rh.left || 'SEARCH WARRANT NO:');
  // meta.txStyle (AZ): {docxFont, margin, top, bottom} in points.
  const st = meta.txStyle || {};
  const font = st.docxFont || 'Times New Roman';
  const sideTw = st.margin > 0 ? Math.round(st.margin * 20) : 1440;
  const topTw = st.top > 0 ? Math.round(st.top * 20) : 720;
  const bottomTw = st.bottom > 0 ? Math.round(st.bottom * 20) : 720;
  const contentTw = st.margin > 0 ? (_in(8.5) - sideTw * 2) : TXD.CONTENT_TW;
  const withHeader = !(meta.runningHeader && meta.runningHeader.enabled === false);
  const bodyHalf = st.docxFont ? 22 : 20;

  // Split on section-break; drop empty sections.
  const groups = [[]];
  for (const b of blockStream.blocks) {
    if (b && b.kind === 'section-break') { if (groups[groups.length - 1].length) groups.push([]); continue; }
    groups[groups.length - 1].push(b);
  }
  if (!groups[groups.length - 1].length && groups.length > 1) groups.pop();

  const hdrRun = (o) => new TextRun(Object.assign({ font, size: 22 }, o));
  const makeHeader = () => new Header({
    children: [new Paragraph({
      children: [
        hdrRun({ text: leftText }),
        hdrRun({ text: '\tPage ' }),
        hdrRun({ children: [PageNumber.CURRENT] }),
        hdrRun({ text: ' of ' }),
        hdrRun({ children: [PageNumber.TOTAL_PAGES_IN_SECTION] }),
      ],
      indent: { left: Math.round(TXD.HDR_LEFT * 20) },
      tabStops: [{ type: TabStopType.RIGHT, position: contentTw }],
      spacing: { before: 0, after: 240, line: 240 },
    })],
  });
  const makeFooter = () => new Footer({ children: [new Paragraph({ children: [] })] });

  let sections;
  _txdFont = font;
  _txdContentTw = contentTw;
  try {
    sections = groups.map((blocks, i) => ({
      properties: {
        type: i === 0 ? undefined : SectionType.NEXT_PAGE,
        page: {
          size: { width: _in(8.5), height: _in(11), orientation: PageOrientation.PORTRAIT },
          margin: {
            top: topTw, bottom: bottomTw, left: sideTw, right: sideTw,
            header: withHeader ? 720 : Math.min(720, topTw), footer: withHeader ? 720 : Math.min(720, bottomTw),
          },
          pageNumbers: { start: 1 },
        },
      },
      headers: withHeader ? { default: makeHeader() } : undefined,
      footers: { default: makeFooter() },
      children: _txSectionChildren(blocks),
    }));
  } finally {
    _txdFont = 'Times New Roman';
    _txdContentTw = TXD.CONTENT_TW;
  }

  const doc = new Document({
    creator: 'Affiant',
    title: `Search Warrant Draft ${(draft && draft.id) || ''}`,
    description: st.docxFont ? 'Search Warrant and Affidavit' : 'Warrant for Electronic Customer Data and Affidavit',
    styles: { default: { document: { run: { font, size: bodyHalf } } } },
    sections,
  });
  return Packer.toBuffer(doc);
}

/**
 * Build a Document from a block stream.
 * @param {Object} args
 * @param {Object} args.blockStream — { blocks, stats } from block-builder.build
 * @param {Object} args.draft       — { swNumber, caseRef, affiantSnapshot }
 * @param {Object} args.agency      — { affiantName }
 * @returns {Promise<Buffer>}
 */
async function composeDocx({ blockStream, draft, agency } = {}) {
  if (!blockStream || !Array.isArray(blockStream.blocks)) {
    throw new Error('composeDocx: blockStream.blocks required');
  }
  draft = draft || {};
  agency = agency || {};
  if (blockStream.meta && blockStream.meta.layout === 'tx') {
    return _composeTxDocx({ blockStream, draft });
  }
  const aff = draft.affiantSnapshot || {};

  // Flatten block-stream → flat array of Paragraphs.
  const paragraphs = [];
  for (const b of blockStream.blocks) {
    const rendered = _renderBlock(b);
    for (const p of rendered) paragraphs.push(p);
  }

  const ref = (_safe(draft.swNumber).trim()) || (_safe(draft.caseRef).trim()) || '(no SW#)';
  const affiantName = _safe(aff.affiantName) || _safe(agency.affiantName) || '';

  // Running header/footer metadata from block-builder
  const meta = blockStream.meta || {};
  const runningHeader = meta.runningHeader || { enabled: false };
  const runningFooter = meta.runningFooter || { enabled: false };

  let header;
  if (runningHeader.enabled && Array.isArray(runningHeader.lines) && runningHeader.lines.length) {
    // CA running header — two centered, bold lines (state/county + SEARCH WARRANT and AFFIDAVIT).
    // size 32 = 16pt (legal-document scale; this is the page banner, not body text).
    // Last line carries `after: 240` (~one body line) so body content has visible breathing room.
    const lines = runningHeader.lines;
    header = new Header({
      children: lines.map((ln, idx) => new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [_run(ln, { bold: true, size: 32 })],
        spacing: { after: (idx === lines.length - 1) ? 240 : 0, line: 320 },
      })),
    });
  } else {
    // No default header. pdf-composer stamps a top banner ONLY for the CA
    // running header; every other jurisdiction's PDF starts at the top
    // margin with no case-ref strip. An empty Header keeps the DOCX page
    // geometry identical to the PDF instead of pushing body text down a
    // line and printing a ref the PDF never shows.
    header = new Header({ children: [] });
  }

  let footer;
  if (runningFooter.enabled) {
    // CA running footer — line 1: revision + page X of Y (right). Line 2: DR # — left-aligned bold.
    const drVal = _safe(runningFooter.drNumber) || '________________';
    footer = new Footer({
      children: [
        new Paragraph({
          children: [
            _run(_safe(runningFooter.revision) || '', { size: 18, italics: true }),
            new TextRun({ text: '\t', font: 'Times New Roman', size: 18 }),
            new TextRun({ text: 'Page ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Times New Roman', size: 18 }),
            new TextRun({ text: ' of ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Times New Roman', size: 18 }),
          ],
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          spacing: { line: 240 },
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [_run(`DR # ${drVal}`, { bold: true, size: 20 })],
          spacing: { line: 240 },
        }),
      ],
    });
  } else {
    // Default footer — mirrors pdf-composer._stampFooters: affiant name on
    // the left, "Page X of N · {sw or caseRef}" on the right, same 9pt.
    footer = new Footer({
      children: [
        new Paragraph({
          children: [
            _run(affiantName, { size: 18 }),
            new TextRun({ text: '\t', font: 'Times New Roman', size: 18 }),
            new TextRun({ text: 'Page ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Times New Roman', size: 18 }),
            new TextRun({ text: ' of ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Times New Roman', size: 18 }),
            new TextRun({ text: ` · ${ref}`, font: 'Times New Roman', size: 18 }),
          ],
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          spacing: { line: 240 },
        }),
      ],
    });
  }

  const doc = new Document({
    creator: 'Affiant',
    title: `Search Warrant Draft ${draft.id || ''}`,
    description: 'Search Warrant and Affidavit',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: _in(8.5), height: _in(11), orientation: PageOrientation.PORTRAIT },
          margin: { top: _in(1), right: _in(1), bottom: _in(1), left: _in(1) },
        },
      },
      headers: { default: header },
      footers: { default: footer },
      children: paragraphs,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return buf;
}

module.exports = { composeDocx };
