// modules/warrant-author/test_fixtures/_composers_smoke.js
// Sandbox smoke test (plain `node` — no Electron) for:
//   - block-builder.js  (pure data layer)
//   - docx-composer.js  (Node-side docx package output)
//
// Run:  node modules/warrant-author/test_fixtures/_composers_smoke.js

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const bb = require('../block-builder.js');
const dc = require('../docx-composer.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  \u001b[32m\u2713\u001b[0m ${name}`);
      passed++;
    })
    .catch(err => {
      console.log(`  \u001b[31m\u2717\u001b[0m ${name}`);
      console.log(`      ${err && err.stack ? err.stack.split('\n')[0] : err}`);
      failed++;
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────
const baseDraft = {
  id: 'wa-test-1',
  swNumber: '',
  caseRef: '25-001234',
  courtName: 'Superior Court of California',
  template: 'ca-multi-business-esp',
  affiantSnapshot: {
    affiantName: 'Justin Moyer',
    affiantRank: 'Detective',
    affiantBadge: '1234',
    affiantEmail: 'jmoyer@fontana.org',
    affiantPhone: '(909) 356-7168',
  },
};

const baseAgency = {
  agencyName: 'Fontana Police Department',
  unit: 'ICAC',
  county: 'San Bernardino',
  state: 'CA',
};

const baseCase = { caseNumber: '25-001234', caseName: 'Test Case' };

function makeCompose(overrides = {}) {
  return Object.assign({
    addendumId: 'a1',
    providerKey: 'google',
    providerName: 'Google LLC',
    businessName: 'Google LLC',
    compose: {
      blocks: [
        { kind: 'provider-block', heading: 'Google LLC', text: 'Records held by Google LLC.' },
        {
          kind: 'items-to-seize', heading: 'Items to Produce',
          items: [
            { key: 'content', label: 'Content of communications', description: 'All emails' },
            { key: 'metadata', label: 'Subscriber metadata' },
          ],
        },
      ],
      danglingSlots: [],
      missingItems: false,
    },
  }, overrides);
}

// ── Suite 1: block-builder ──────────────────────────────────────────────
async function suite_blockBuilder() {
  console.log('\nblock-builder.build()');

  await test('builds a non-empty block stream with valid inputs', () => {
    const out = bb.build({
      draft: baseDraft,
      addendumComposes: [makeCompose()],
      agency: baseAgency,
      caseInfo: baseCase,
      pcNarrative: 'PC narrative.',
    });
    assert(Array.isArray(out.blocks), 'blocks should be array');
    assert(out.blocks.length > 0, 'blocks should be non-empty');
    assert(out.stats.totalBlocks === out.blocks.length, 'stats.totalBlocks should match');
    assertEq(out.stats.addendums, 1, 'one addendum');
    assertEq(out.stats.pcAuthored, true, 'pcAuthored should be true');
  });

  await test('cover page contains court name and case ref', () => {
    // Use a non-CA template here: the CA template now renders the official
    // Multi-Business SW Face Page (oath + checkboxes + People of CA block),
    // not the generic court caption. Court-name uppercased belongs to the
    // generic affidavit cover.
    const usDraft = Object.assign({}, baseDraft, {
      template: 'generic-us-multi-business-esp',
      jurisdiction: 'US',
    });
    const out = bb.build({
      draft: usDraft, addendumComposes: [], agency: baseAgency,
      caseInfo: baseCase, pcNarrative: '',
    });
    const txts = out.blocks.map(b => b.text || `${b.label || ''}: ${b.value || ''}`).join('\n');
    assert(/SUPERIOR COURT/.test(txts), 'court name uppercased in cover');
    assert(/25-001234/.test(txts), 'case ref appears');
    assert(/Fontana/.test(txts) || /Justin Moyer/.test(txts), 'affiant identity rendered');
  });

  await test('inserts page-break before each addendum', () => {
    const out = bb.build({
      draft: baseDraft,
      addendumComposes: [makeCompose({ providerName: 'Google' }), makeCompose({ providerName: 'Snapchat', addendumId: 'a2' })],
      agency: baseAgency,
      caseInfo: baseCase,
      pcNarrative: 'PC.',
    });
    // CA flow: face page → page-break before routing list → 2 addendums (2 page-breaks) → Statement of PC (1 page-break) = 4 total.
    // The two-addendum invariant is verified via the count of addendum heading-1 blocks instead.
    const breaks = out.blocks.filter(b => b.kind === 'page-break').length;
    assertEq(breaks, 4, 'four page breaks (routing list + 2 addendums + 1 STATEMENT OF PROBABLE CAUSE) in CA flow');
    const addendumHeadings = out.blocks.filter(b => b.kind === 'heading-1' && /ADDENDUM/.test(b.text || '')).length;
    assertEq(addendumHeadings, 2, 'two ADDENDUM headings');
  });

  await test('items-to-seize maps to numbered block', () => {
    const out = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    const num = out.blocks.find(b => b.kind === 'numbered');
    assert(num, 'numbered block present');
    assertEq(num.items.length, 2, 'two numbered items');
    assert(/Content of communications/.test(num.items[0]), 'first item label');
    assert(/All emails/.test(num.items[0]), 'first item description joined');
  });

  await test('empty PC shows placeholder', () => {
    const out = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: '',
    });
    const txt = out.blocks.map(b => b.text || '').join(' ');
    assert(/[Pp]robable cause narrative not yet authored/.test(txt), 'PC placeholder rendered');
    assertEq(out.stats.pcAuthored, false, 'pcAuthored false');
  });

  await test('PC with blank lines splits into multiple paragraphs', () => {
    const out = bb.build({
      draft: baseDraft, addendumComposes: [],
      agency: baseAgency, caseInfo: baseCase,
      pcNarrative: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
    });
    const paragraphs = out.blocks.filter(b => b.kind === 'paragraph' && /paragraph/.test(b.text || ''));
    assert(paragraphs.length >= 3, `expected >=3 PC paragraphs, got ${paragraphs.length}`);
  });

  await test('signature block at the end', () => {
    const out = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    const sigs = out.blocks.filter(b => b.kind === 'signature');
    assert(sigs.length >= 2, `expected >=2 signature blocks (affiant + judge), got ${sigs.length}`);
    assert(/Justin Moyer|Detective/.test(sigs[0].label), 'affiant sig label includes name or rank');
  });

  await test('disclaimer when includeDisclaimer=true (non-CA)', () => {
    const usDraft = Object.assign({}, baseDraft, { template: 'generic-us-multi-business-esp' });
    const out = bb.build({
      draft: usDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
      includeDisclaimer: true,
    });
    const d = out.blocks.find(b => b.kind === 'footer-disclaimer');
    assert(d, 'disclaimer block present');
    assert(/Not a substitute for legal review/.test(d.text), 'disclaimer text correct');
  });

  await test('disclaimer skipped on CA template even with includeDisclaimer=true', () => {
    const out = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
      includeDisclaimer: true,
    });
    const d = out.blocks.find(b => b.kind === 'footer-disclaimer');
    assert(!d, 'CA flow suppresses disclaimer on filed legal document');
  });

  await test('disclaimer skipped when includeDisclaimer=false', () => {
    const usDraft = Object.assign({}, baseDraft, { template: 'generic-us-multi-business-esp' });
    const out = bb.build({
      draft: usDraft, addendumComposes: [], agency: baseAgency,
      caseInfo: baseCase, pcNarrative: 'PC.', includeDisclaimer: false,
    });
    const d = out.blocks.find(b => b.kind === 'footer-disclaimer');
    assert(!d, 'no disclaimer block');
  });

  await test('aggregates dangling slots across addendums', () => {
    const out = bb.build({
      draft: baseDraft,
      addendumComposes: [
        makeCompose({ compose: { blocks: [], danglingSlots: ['addendum.dateRange'], missingItems: false } }),
        makeCompose({ addendumId: 'a2', compose: { blocks: [], danglingSlots: ['agency.affiantName'], missingItems: false } }),
      ],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    assertEq(out.stats.danglingSlots.length, 2, 'two dangling slots');
    assert(out.stats.danglingSlots.some(s => /a1\//.test(s)), 'prefixed by addendum id');
  });

  await test('throws when draft is missing', () => {
    let threw = false;
    try { bb.build({ addendumComposes: [], agency: {}, caseInfo: {}, pcNarrative: '' }); }
    catch (_) { threw = true; }
    assert(threw, 'should throw on missing draft');
  });

  await test('addendum labels use A, B, C... letters', () => {
    const out = bb.build({
      draft: baseDraft,
      addendumComposes: [
        makeCompose({ providerName: 'Google', addendumId: 'a1' }),
        makeCompose({ providerName: 'Meta',   addendumId: 'a2' }),
        makeCompose({ providerName: 'X Corp', addendumId: 'a3' }),
      ],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    const h1Texts = out.blocks.filter(b => b.kind === 'heading-1').map(b => b.text);
    assert(h1Texts.some(t => /ADDENDUM A/.test(t)), 'ADDENDUM A present');
    assert(h1Texts.some(t => /ADDENDUM B/.test(t)), 'ADDENDUM B present');
    assert(h1Texts.some(t => /ADDENDUM C/.test(t)), 'ADDENDUM C present');
  });
}

// ── Suite 2: docx-composer ──────────────────────────────────────────────
async function suite_docxComposer() {
  console.log('\ndocx-composer.composeDocx()');

  await test('returns a Buffer with PK ZIP magic header', async () => {
    const stream = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    const buf = await dc.composeDocx({ blockStream: stream, draft: baseDraft, agency: baseAgency });
    assert(Buffer.isBuffer(buf), 'returns Buffer');
    assert(buf.length > 1000, `docx should be >1KB, got ${buf.length}`);
    // .docx is a ZIP — should start with PK\x03\x04
    assertEq(buf[0], 0x50, 'byte 0 is P (0x50)');
    assertEq(buf[1], 0x4B, 'byte 1 is K (0x4B)');
  });

  await test('rejects when blockStream missing', async () => {
    let threw = false;
    try { await dc.composeDocx({ draft: baseDraft }); }
    catch (_) { threw = true; }
    assert(threw, 'should throw');
  });

  await test('rejects when blockStream.blocks not an array', async () => {
    let threw = false;
    try { await dc.composeDocx({ blockStream: { blocks: null }, draft: baseDraft }); }
    catch (_) { threw = true; }
    assert(threw, 'should throw');
  });

  await test('larger draft (3 addendums) still produces valid buffer', async () => {
    const stream = bb.build({
      draft: baseDraft,
      addendumComposes: [
        makeCompose({ providerName: 'Google' }),
        makeCompose({ providerName: 'Meta',   addendumId: 'a2' }),
        makeCompose({ providerName: 'X Corp', addendumId: 'a3' }),
      ],
      agency: baseAgency, caseInfo: baseCase,
      pcNarrative: 'A long PC narrative.\n\nWith multiple paragraphs.\n\nAnd a final summary.',
    });
    const buf = await dc.composeDocx({ blockStream: stream, draft: baseDraft, agency: baseAgency });
    assert(buf.length > 2000, `larger docx should be >2KB, got ${buf.length}`);
  });

  await test('writes a sample .docx to temp and confirms file system view', async () => {
    const stream = bb.build({
      draft: baseDraft, addendumComposes: [makeCompose()],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC narrative for disk write test.',
    });
    const buf = await dc.composeDocx({ blockStream: stream, draft: baseDraft, agency: baseAgency });
    const out = path.join(os.tmpdir(), `wa_smoke_${Date.now()}.docx`);
    fs.writeFileSync(out, buf);
    const stat = fs.statSync(out);
    assert(stat.size === buf.length, 'file size matches');
    fs.unlinkSync(out);
  });

  await test('addendum block-stream gets transformed into Word paragraphs', async () => {
    // Indirect: ensure we don't crash on long item lists
    const items = [];
    for (let i = 0; i < 25; i++) items.push({ key: `k${i}`, label: `Item ${i}`, description: 'desc' });
    const stream = bb.build({
      draft: baseDraft,
      addendumComposes: [makeCompose({
        compose: {
          blocks: [{ kind: 'items-to-seize', heading: 'Items to Produce', items }],
          danglingSlots: [], missingItems: false,
        },
      })],
      agency: baseAgency, caseInfo: baseCase, pcNarrative: 'PC.',
    });
    const buf = await dc.composeDocx({ blockStream: stream, draft: baseDraft, agency: baseAgency });
    assert(buf.length > 1500, 'long item list produces non-trivial output');
  });
}

(async () => {
  console.log('Warrant Author: composers smoke test\n');
  await suite_blockBuilder();
  await suite_docxComposer();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
