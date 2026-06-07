// modules/warrant-author/docx-composer.js
// DOCX composition — uses the `docx` npm package (NEW dep added in P0-2).
//
// Phase P0 stub. P5/P9 implement:
//   - composeDocx(draft, resolved) → Buffer (Word .docx)
//   - Match the visual layout of jsPDF output (Times New Roman 12pt,
//     1" margins, double-spaced narrative, indented numbered items).
//   - Each addendum starts on its own page via Paragraph({ pageBreakBefore: true }).
//   - Header: SW number top-right; Footer: page N of M.
//   - Signature blocks rendered as ___________________ lines + label.

function composeDocx(/* draft, resolved */) {
    throw new Error('not-implemented (P5/P9)');
}

module.exports = { composeDocx };
