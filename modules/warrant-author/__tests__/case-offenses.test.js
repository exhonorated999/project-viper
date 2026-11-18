// modules/warrant-author/__tests__/case-offenses.test.js
// The Warrant Author names EVERY case offense (primary + additional), with
// bare statute numbers expanded to "code - description" from the Offense
// Reference library. SYNTHETIC data only.
//
// Run: node modules/warrant-author/__tests__/case-offenses.test.js
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CO = require(path.join(ROOT, 'modules', 'warrant-author', 'case-offenses.js'));

let pass = 0, fail = 0;
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log('  FAIL:', msg, '\n    got:', A, '\n    exp:', B); }
}
function ok(c, msg) { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } }

const LIB = [
  { kind: 'state', code: '99-101', description: 'Example offense one' },
  { kind: 'state', code: '§99-202', description: 'Example offense two, aggravated' },
  { kind: 'caselaw', code: '99-303', description: 'Not chargeable' },
];

console.log('— list');
eq(CO.list(null, LIB), [], 'no record');
eq(CO.list({ primaryOffense: '99-101 - Example offense one' }, LIB),
  ['99-101 - Example offense one'], 'library pick kept verbatim');
eq(CO.list({
  primaryOffense: '99-101 - Example offense one',
  additionalOffenses: [{ offense: '99-202', type: 'Felony' }, 'Custom typed charge', { offense: '  ' }],
}, LIB), ['99-101 - Example offense one', '99-202 - Example offense two, aggravated', 'Custom typed charge'],
'primary + additional; bare code expanded; blanks dropped');
eq(CO.list({ primaryOffense: '99-101' }, LIB), ['99-101 - Example offense one'], 'bare primary code expanded');
eq(CO.list({ primaryOffense: '§ 99-101' }, LIB), ['§ 99-101 - Example offense one'], '§ prefix tolerated');
eq(CO.list({ primaryOffense: '99-303' }, LIB), ['99-303'], 'case law never used to expand');
eq(CO.list({ primaryOffense: '12-345' }, LIB), ['12-345'], 'unknown code kept verbatim');
eq(CO.list({ primaryOffense: 'A', charges: 'B\nC\n' }, LIB), ['A', 'B', 'C'], 'legacy charges when no additional');
eq(CO.list({ primaryOffense: 'A', additionalOffenses: ['B'], charges: 'X' }, LIB), ['A', 'B'], 'charges ignored when additional present');
eq(CO.list({ primaryOffense: 'A', additionalOffenses: ['a', 'B'] }, LIB), ['A', 'B'], 'duplicates removed');
eq(CO.list({ additionalOffenses: ['B'] }, LIB), ['B'], 'no primary');

console.log('— join');
eq(CO.join([]), '', 'none');
eq(CO.join(['a']), 'a', 'one');
eq(CO.join(['a', 'b']), 'a and b', 'two');
eq(CO.join(['a', 'b', 'c']), 'a; b; and c', 'three');
eq(CO.describe({ primaryOffense: '99-101', additionalOffenses: ['99-202', 'Custom'] }, LIB),
  '99-101 - Example offense one; 99-202 - Example offense two, aggravated; and Custom', 'describe');

console.log('— wiring');
const ui = fs.readFileSync(path.join(ROOT, 'modules', 'warrant-author', 'warrant-author-ui.js'), 'utf8');
ok(!/String\(rec\.primaryOffense \|\| ''\)\.trim\(\);\s*\n\s*caseDate/.test(ui), 'ctx no longer reads primary only');
ok((ui.match(/_caseOffensesText\(rec\)/g) || []).length >= 2, 'ctx + PC panel use all offenses');
const host = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8');
ok(host.indexOf('modules/warrant-author/case-offenses.js') !== -1, 'script loaded by the case page');

console.log(`\ncase-offenses: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
