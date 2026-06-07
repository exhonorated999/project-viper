// modules/warrant-author/pdf-composer.js
// PDF composition — uses jsPDF in the renderer side. Main-process side
// (this file) only assembles the structured block-list that the renderer
// will pour into a paginated jsPDF document.
//
// Phase P0 stub. P5/P9 implement:
//   - composeBlocks(draft, resolved) → ordered list of paragraph blocks
//     { kind: 'heading'|'paragraph'|'numbered'|'signature'|'spacer',
//       text: string, level?: number, indexLabel?: string }
//   - Multi-addendum: each addendum starts on new page with label
//     ("ADDENDUM A — TWITTER (X CORP)"), shares affidavit header.
//   - Footer: SW number + page X of N + affiant name.

function composeBlocks(/* draft, resolved */) {
    throw new Error('not-implemented (P5/P9)');
}

module.exports = { composeBlocks };
