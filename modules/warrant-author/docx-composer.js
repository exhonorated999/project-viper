// modules/warrant-author/docx-composer.js
// DOCX composition — MAIN-process, uses the `docx` npm package.
// Consumes the block stream produced by block-builder.js and emits a
// US-Letter Word document that visually mirrors the jsPDF output:
//   - Times New Roman 12pt body, 1" margins
//   - Bold headings (cover 18, h1 15, h2 13)
//   - Numbered lists with hanging indent
//   - Signature blocks rendered as underscore line + label
//   - Page-break before each addendum
//   - Header (right): SW# / Case Ref
//   - Footer (right): Page X of Y · affiant name
//
// Returns a Buffer ready for disk persistence (encrypted by warrant-author-main
// when Field Security is active).

const docxLib = require('docx');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
  PageBreak, PageOrientation, Header, Footer, PageNumber,
  TabStopType, TabStopPosition, BorderStyle,
} = docxLib;

// Convert inches → twentieths-of-a-point (TWIPs) — Word's unit.
function _in(inches) { return Math.round(inches * 1440); }

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

function _spacer(size) {
  return new Paragraph({
    children: [_run(' ', { size: 24 })],
    spacing: { before: 0, after: _spacerTwips(size), line: 240 },
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

/**
 * Convert one block to one-or-more docx Paragraphs.
 */
function _renderBlock(b) {
  switch (b.kind) {
    case 'cover-heading':    return [_coverHeading(b.text)];
    case 'cover-subheading': return [_coverSubheading(b.text)];
    case 'cover-meta':       return [_coverMeta(b.label, b.value)];
    case 'heading-1':        return [_h1(b.text)];
    case 'heading-2':        return [_h2(b.text)];
    case 'paragraph': {
      const align = (b.align === 'right')  ? AlignmentType.RIGHT
                  : (b.align === 'center') ? AlignmentType.CENTER
                  : AlignmentType.LEFT;
      return [_para(b.text, { indent: b.indent ? 360 : 0, align })];
    }
    case 'numbered': {
      const items = Array.isArray(b.items) ? b.items : [];
      return items.map((it, i) => _numberedItem(it, i));
    }
    case 'signature':        return _signature(b.label);
    case 'spacer':           return [_spacer(b.size)];
    case 'page-break':       return [_pageBreakPara()];
    case 'footer-disclaimer': return [_disclaimer(b.text)];
    default: return [];
  }
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
    // size 28 = 14pt (legal-document scale; this is the page banner, not body text).
    header = new Header({
      children: runningHeader.lines.map((ln) => new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [_run(ln, { bold: true, size: 28 })],
        spacing: { after: 0, line: 280 },
      })),
    });
  } else {
    // Default header (right-aligned with case ref).
    header = new Header({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [_run(ref, { size: 18, italics: true })],
          spacing: { after: 0, line: 240 },
        }),
      ],
    });
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
    // Default footer (page X of Y · affiant).
    footer = new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: 'Page ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Times New Roman', size: 18 }),
            new TextRun({ text: ' of ', font: 'Times New Roman', size: 18 }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Times New Roman', size: 18 }),
            ...(affiantName ? [
              new TextRun({ text: ` · ${affiantName}`, font: 'Times New Roman', size: 18 }),
            ] : []),
          ],
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
