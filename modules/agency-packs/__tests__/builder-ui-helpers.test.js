'use strict';
// Tests for modules/agency-packs/richtext-blocks.js and case-facts.js. All data SYNTHETIC.
// Run: node modules/agency-packs/__tests__/builder-ui-helpers.test.js
const { DOMParser } = require('@xmldom/xmldom');
const RB = require('../richtext-blocks.js');
const CF = require('../case-facts.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
const parse = (html) => new DOMParser({ onError: () => {} }).parseFromString('<div>' + html + '</div>', 'text/html');
const blocks = (html) => RB.fromNode(parse(html));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// ---- HTML → blocks ------------------------------------------------------------------------------
eq(blocks('<p>One</p><p>Two</p>'), [{ type: 'paragraph', runs: [{ text: 'One' }] }, { type: 'paragraph', runs: [{ text: 'Two' }] }], 'paragraphs');
eq(blocks('First line<div>Second</div><div><br></div><div>Fourth</div>'),
  [{ type: 'paragraph', runs: [{ text: 'First line' }] }, { type: 'paragraph', runs: [{ text: 'Second' }] }, { type: 'paragraph', runs: [] }, { type: 'paragraph', runs: [{ text: 'Fourth' }] }],
  'contenteditable divs + blank line');
eq(blocks('<p>A <b>bold</b> and <i>it</i> <u>u</u> <b><i>both</i></b></p>')[0].runs,
  [{ text: 'A ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'it', italic: true }, { text: ' ' }, { text: 'u', underline: true }, { text: ' ' }, { text: 'both', bold: true, italic: true }],
  'inline formatting');
eq(blocks('<p><span style="font-weight:700">x</span><span style="font-style: italic; text-decoration: underline">y</span><strong style="font-weight:normal">z</strong></p>')[0].runs,
  [{ text: 'x', bold: true }, { text: 'y', italic: true, underline: true }, { text: 'z' }], 'style attributes (Word paste)');
eq(blocks('<ul><li>a</li><li>b <b>c</b></li></ul><ol><li>one</li></ol><p>after</p>'),
  [{ type: 'bullet', runs: [{ text: 'a' }] }, { type: 'bullet', runs: [{ text: 'b ' }, { text: 'c', bold: true }] },
    { type: 'number', runs: [{ text: 'one' }] }, { type: 'paragraph', runs: [{ text: 'after' }] }], 'lists');
eq(blocks('<ul><li><p>x</p><p>y</p></li></ul>'), [{ type: 'bullet', runs: [{ text: 'x' }, { break: true }, { text: 'y' }] }], 'paragraphs inside a list item become line breaks');
eq(blocks('<p>a<br>b<br></p>'), [{ type: 'paragraph', runs: [{ text: 'a' }, { break: true }, { text: 'b' }] }], 'line breaks, trailing dropped');
eq(blocks('<table><tbody><tr><th>H</th><td>v <i>i</i></td></tr><tr><td></td><td>z</td></tr></tbody></table>'),
  [{ type: 'table', rows: [[{ runs: [{ text: 'H', bold: true }] }, { runs: [{ text: 'v ' }, { text: 'i', italic: true }] }], [{ runs: [] }, { runs: [{ text: 'z' }] }]] }], 'table');
eq(blocks(`<p>see <img src="${PNG}"> <img src="https://example.test/x.png"><img src="data:image/gif;base64,R0lG"></p>`)[0].runs,
  [{ text: 'see ' }, { image: PNG }], 'only PNG/JPEG data-URL pictures kept');
eq(blocks('<style>p{}</style><script>alert(1)</script><p>ok</p><!-- c -->'), [{ type: 'paragraph', runs: [{ text: 'ok' }] }], 'scripts/styles/comments dropped');
eq(blocks('<p>  spaced\n  out&#160;text  </p>')[0].runs, [{ text: 'spaced out text' }], 'whitespace normalised');
eq(blocks('<p>x</p><p></p><div><br></div>'), [{ type: 'paragraph', runs: [{ text: 'x' }] }], 'trailing blank paragraphs dropped');
eq(blocks(''), [], 'empty');
eq(blocks('<h2>Head</h2>')[0].runs, [{ text: 'Head', bold: true }], 'heading → bold');

// ---- blocks → HTML → blocks (round trip) --------------------------------------------------------
const sample = [
  { type: 'paragraph', runs: [{ text: 'Plain <&> "q" ' }, { text: 'B', bold: true }, { text: 'IU', italic: true, underline: true }] },
  { type: 'bullet', runs: [{ text: 'b1' }] }, { type: 'bullet', runs: [{ text: 'b2' }] },
  { type: 'number', runs: [{ text: 'n1' }] },
  { type: 'paragraph', runs: [{ text: 'l1' }, { break: true }, { text: 'l2' }, { image: PNG }] },
  { type: 'table', rows: [[{ runs: [{ text: 'c1' }] }, { runs: [{ text: 'c2' }] }]] },
];
const html = RB.toHtml(sample);
ok(html.includes('Plain &lt;&amp;&gt; &quot;q&quot;'), 'toHtml escapes text');
ok(/<ul><li>b1<\/li><li>b2<\/li><\/ul><ol><li>n1<\/li><\/ol>/.test(html), 'toHtml groups list items');
eq(blocks(html), sample, 'round trip');
ok(!RB.toHtml([{ type: 'paragraph', runs: [{ image: 'javascript:alert(1)' }, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }] }]).includes('img'), 'toHtml refuses non PNG/JPEG pictures');
eq(RB.toHtml('line one\nline two'), '<p>line one</p><p>line two</p>', 'toHtml accepts plain text');
eq(RB.toHtml(null), '', 'toHtml null');
eq(RB.toText(sample), 'Plain <&> "q" BIU\nb1\nb2\nn1\nl1\nl2\nc1\tc2', 'toText');
ok(!RB.hasContent([{ type: 'paragraph', runs: [{ text: '  ' }] }]), 'blank blocks have no content');
ok(RB.hasContent([{ type: 'paragraph', runs: [{ image: PNG }] }]), 'a picture is content');
eq(RB.fromText(' a \r\n\r\nb'), [{ type: 'paragraph', runs: [{ text: 'a' }] }, { type: 'paragraph', runs: [{ text: 'b' }] }], 'fromText');

// ---- case facts ---------------------------------------------------------------------------------
eq(['70', '70"', '5-10', "5'10", "5' 10\"", '510', '5ft 10in', '6-0', '12', '5-13', 'tall'].map(CF.heightText),
  ["5'10\"", "5'10\"", "5'10\"", "5'10\"", "5'10\"", "5'10\"", "5'10\"", "6'00\"", '12', '5-13', 'tall'], 'heightText');
eq(['180', '95', '180 lbs', ''].map(CF.weightText), ['180 lbs', '95 lbs', '180 lbs', ''], 'weightText');
eq(['M', 'f', 'Female', ''].map(CF.sexText), ['Male', 'Female', 'Female', ''], 'sexText');

const currentCase = {
  caseNumber: '26-000777', primaryOffense: 'Offense A SYNTHETIC',
  additionalOffenses: [{ offense: 'Offense B', type: 'F' }, 'Offense C', { offense: 'Offense A SYNTHETIC' }],
  offenseDate: '2026-03-04T00:00:00.000Z',
};
const suspect = {
  name: 'Pat SYNTHETIC', dob: '1990-01-02', height: '70', weight: '180', hairColor: 'BRO', eyeColor: 'BLU', sex: 'M', race: 'W',
  address: '100 Example St', addressCityStateZip: 'Example City, CO 80000',
  identifiers: [{ type: 'dl', value: 'X' }, { type: 'phone', value: '555-0100' }, { type: 'email', value: 'pat@example.test' }],
};
eq(CF.fromCase({ currentCase, suspect, pcText: ' PC text ' }), {
  caseNumber: '26-000777', suspectName: 'Pat SYNTHETIC', suspectDob: '1990-01-02', suspectHeight: "5'10\"", suspectWeight: '180 lbs',
  suspectHair: 'BRO', suspectEye: 'BLU', suspectSex: 'Male', suspectRace: 'W', suspectAddress: '100 Example St, Example City, CO 80000',
  suspectPhone: '555-0100', suspectEmail: 'pat@example.test', offenses: ['Offense A SYNTHETIC', 'Offense B', 'Offense C'], offenseDate: '2026-03-04',
  pcText: 'PC text',
}, 'fromCase');
const noSuspect = CF.fromCase({ currentCase: { caseNumber: 'X1', charges: 'C1\nC2' }, offenseDate: '2026-01-01', pcBlocks: [{ type: 'paragraph', runs: [{ text: 'p' }] }] });
eq([noSuspect.suspectName, noSuspect.offenses, noSuspect.offenseDate, noSuspect.pcBlocks.length, 'pcText' in noSuspect], ['', ['C1', 'C2'], '2026-01-01', 1, false], 'fromCase without suspect; legacy charges; pc blocks');
eq(CF.fromCase({ currentCase: {}, offenseDescription: 'Desc' }).offenses, ['Desc'], 'offense description fallback');
eq(CF.fromCase({}).caseNumber, '', 'fromCase empty');
eq([CF.suspectLabel(suspect, 0), CF.suspectLabel({}, 1)], ['Pat SYNTHETIC (DOB 1990-01-02)', 'Suspect 2'], 'suspectLabel');

const wa = { affiantName: 'Alex Example', affiantRank: 'Detective', affiantBadge: '1234', agencyName: 'Example PD', affiantEmail: 'a@example.test',
  affiantPhone: '555-0199', agencyAddress: '1 Example Plaza', trainingExperienceBoilerplate: 'REPLACE THIS — paragraph' };
eq(CF.profileFrom(wa), { name: 'Alex Example', badge: '1234', title: 'Detective', agency: 'Example PD', email: 'a@example.test', phone: '555-0199',
  address: '1 Example Plaza', signatureText: 'Detective Alex Example', backgroundOfAffiant: '' }, 'profile seeded from agency profile (placeholder T&E dropped)');
const p2 = CF.profileFrom(Object.assign({}, wa, { trainingExperienceBoilerplate: 'Real T&E' }), { badge: '99', title: '', signatureText: 'Det. A. Example #99' });
eq([p2.badge, p2.title, p2.signatureText, p2.backgroundOfAffiant], ['99', 'Detective', 'Det. A. Example #99', 'Real T&E'], 'saved profile wins; blanks fall back');
eq(CF.profileFrom(null, null).name, '', 'profile empty');

console.log(`builder-ui-helpers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
