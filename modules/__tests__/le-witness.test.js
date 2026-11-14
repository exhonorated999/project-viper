/**
 * Law-enforcement witnesses (witness record with `lawEnforcement: true`).
 * Run: node modules/__tests__/le-witness.test.js
 *
 * Covers:
 *   1. The name helpers in case-detail-with-analytics.html (split / compose /
 *      display) — `name` must always be "First Last" so every other consumer
 *      (search, notes, reports) keeps working.
 *   2. CaseLink: an officer who appears in many cases must NOT link those
 *      cases together or raise duplicate-person hints, but must still be
 *      found by the people search.
 *   3. Report "From case" witnesses table gets a Law enforcement column
 *      (and a Testifying to column) only when an LE witness is present.
 *   4. The witness form / detail view are wired to the LE fields.
 * All data is synthetic.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(a, b, name) {
  ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8');

// ── 1. helpers from the page ─────────────────────────────────────────
console.log('-- page helpers --');
{
  const start = HTML.indexOf('const LE_WITNESS_TITLES');
  const end = HTML.indexOf('function renderLeWitnessCard');
  ok(start > 0 && end > start, 'LE helper block found');
  const sb = {
    _esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  };
  vm.createContext(sb);
  vm.runInContext(HTML.slice(start, end) + '\n;this._h = { _isLeWitness, _leClearFlag, _leComposeName, _leSplitName, _leNameParts, _leDisplayName, _leTitleDatalist, _leChip, LE_WITNESS_TITLES };', sb);
  const h = sb._h;
  eq(h._isLeWitness({ lawEnforcement: true }), true, 'flagged record is LE');
  eq(h._isLeWitness({ name: 'Pat Q' }), false, 'plain record is not LE');
  eq(h._isLeWitness(null), false, 'null is not LE');
  eq(h._leComposeName(' Pat ', ' Quill '), 'Pat Quill', 'compose trims');
  eq(h._leComposeName('', 'Quill'), 'Quill', 'compose with last only');
  eq(JSON.stringify(h._leSplitName('Pat Q. Quill')), JSON.stringify({ first: 'Pat Q.', last: 'Quill' }), 'split "First M. Last"');
  eq(JSON.stringify(h._leSplitName('Quill, Pat')), JSON.stringify({ first: 'Pat', last: 'Quill' }), 'split "Last, First"');
  eq(JSON.stringify(h._leSplitName('')), JSON.stringify({ first: '', last: '' }), 'split empty');
  eq(JSON.stringify(h._leNameParts({ firstName: 'A', lastName: 'B', name: 'X Y' })), JSON.stringify({ first: 'A', last: 'B' }), 'parts prefer firstName/lastName');
  eq(JSON.stringify(h._leNameParts({ name: 'X Y' })), JSON.stringify({ first: 'X', last: 'Y' }), 'parts fall back to name');
  eq(h._leDisplayName({ leTitle: 'Detective', name: 'Pat Quill' }), 'Detective Pat Quill', 'display adds title');
  eq(h._leDisplayName({}), 'Unknown Officer', 'display fallback');
  const rec = { lawEnforcement: true, firstName: 'A', lastName: 'B', name: 'A B', badgeNumber: '42', agency: 'Test PD' };
  h._leClearFlag(rec);
  ok(!('lawEnforcement' in rec) && !('firstName' in rec) && !('lastName' in rec), 'clear flag drops flag + split name');
  eq(rec.badgeNumber, '42', 'clear flag keeps LE details for a later re-tick');
  ok(h._leTitleDatalist().includes('id="leWitnessTitles"') && h._leTitleDatalist().includes('value="CSI"'), 'title datalist has CSI');
  ok(h._leChip().includes('LAW ENFORCEMENT') && h._leChip().includes('data-le-chip'), 'chip markup');
}

// ── 2. CaseLink exclusions ───────────────────────────────────────────
console.log('\n-- case-link --');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'modules', 'case-link.js'), 'utf8');
  const CASES = [
    { id: 'c1', caseNumber: '26-0101', title: 'Burglary', status: 'Active' },
    { id: 'c2', caseNumber: '26-0102', title: 'Theft', status: 'Active' },
    { id: 'c3', caseNumber: '26-0103', title: 'Fraud', status: 'Active' },
  ];
  const OFFICER = (caseTag) => ({
    lawEnforcement: true, firstName: 'Robin', lastName: 'Testcase', name: 'Robin Testcase',
    leTitle: 'Detective', badgeNumber: '0042', agency: 'Example PD',
    agencyPhone: '(555) 010-0000', email: 'records@example.invalid', testimony: 'Interviewed ' + caseTag,
  });
  const store = {
    viperCases: JSON.stringify(CASES),
    witnesses_c1: JSON.stringify([OFFICER('c1')]),
    witnesses_c2: JSON.stringify([OFFICER('c2')]),
    // c3: a civilian sharing a person with c1 — must still link.
    suspects_c1: JSON.stringify([{ name: 'Doe, Jordan', dob: '1991-02-03' }]),
    suspects_c3: JSON.stringify([{ name: 'Doe, Jordan', dob: '1991-02-03' }]),
  };
  const data = Object.assign({}, store);
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
  const sandbox = { localStorage, console, Date, JSON, Math };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'case-link.js' });
  const CL = sandbox.CaseLink;

  const rel = CL.getRelatedCases('c1');
  ok(!rel.find((r) => r.caseId === 'c2'), 'officer alone does not link c1 to c2');
  ok(!!rel.find((r) => r.caseId === 'c3'), 'civilian suspect still links c1 to c3');
  eq(CL.getRelatedCases('c2').length, 0, 'c2 (only the officer) has no related cases');

  const m = CL.findMatches({ name: 'Robin Testcase' }, { excludeCaseId: 'c1' });
  eq(m.length, 0, 'officer never raises a duplicate-person hint');
  const mPhone = CL.findMatches({ phone: '(555) 010-0000' }, {});
  eq(mPhone.length, 0, 'shared agency phone never raises a hint');

  const ppl = CL.findPersons('testcase');
  eq(ppl.length, 1, 'officer still found by people search');
  eq(ppl[0] && ppl[0].cases.length, 2, 'people search lists both cases');

  // Flip the c2 record to civilian → it becomes linkable again.
  data.witnesses_c2 = JSON.stringify([{ name: 'Robin Testcase' }]);
  data.witnesses_c1 = JSON.stringify([{ name: 'Robin Testcase' }]);
  CL.invalidateIndex();
  ok(!!CL.getRelatedCases('c1').find((r) => r.caseId === 'c2'), 'civilian witnesses with same name link again');
}

// ── 3. report "From case" table ──────────────────────────────────────
console.log('\n-- case-inserts --');
{
  const CI = require(path.join(ROOT, 'modules', 'reports', 'case-inserts.js'));
  const civ = [{ name: 'Lee Sample', phone: '555-0101' }];
  const civHtml = CI.people(civ, 'witnesses');
  ok(!civHtml.includes('Law enforcement'), 'civilian-only table has no LE column');
  ok(!civHtml.includes('Testifying to'), 'civilian-only table has no testimony column');
  const mixed = civ.concat([{
    lawEnforcement: true, name: 'Robin Testcase', firstName: 'Robin', lastName: 'Testcase',
    leTitle: 'CSI', badgeNumber: '77', agency: 'Example PD', agencyPhone: '555-0199', testimony: 'Photographed the scene <b>',
  }]);
  const html = CI.people(mixed, 'witnesses');
  ok(html.includes('>Law enforcement<'), 'mixed table has LE column');
  ok(html.includes('CSI<br>Example PD<br>Badge #77<br>555-0199'), 'LE cell = title / agency / badge / phone');
  ok(html.includes('Photographed the scene &lt;b&gt;'), 'testimony escaped');
  ok(!CI.people(mixed, 'suspects').includes('Law enforcement'), 'LE column only for witnesses');
}

// ── 4. wiring in the page ────────────────────────────────────────────
console.log('\n-- page wiring --');
{
  const fnBody = (name) => {
    const i = HTML.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = HTML.indexOf('\n        function ', i + 10);
    return HTML.slice(i, j < 0 ? i + 40000 : j);
  };
  const modal = fnBody('showWitnessModal');
  ok(modal.includes('id="witnessLeToggle"'), 'form has the LE checkbox');
  ['firstName', 'lastName', 'leTitle', 'badgeNumber', 'agency', 'agencyPhone', 'testimony'].forEach((f) =>
    ok(modal.includes(`name="${f}"`), `form has ${f}`));
  ok(/data-witness-le[\s\S]*name="email"/.test(modal), 'LE section has email');
  ok(modal.includes('lawEnforcement: true'), 'submit stores the flag');
  ok(modal.includes('_leClearFlag(witnesses[editIndex])'), 'civilian save clears the flag');
  ok(fnBody('renderWitnessCard').includes('renderLeWitnessCard'), 'list card branches to LE card');
  const detail = fnBody('renderWitnessDetail');
  ok(detail.includes('renderLeWitnessDetailBody') && detail.includes('wle-toggle-'), 'detail view has LE body + toggle');
  ok(/\$\{le \? '' : `[\s\S]*importDmvWitness/.test(detail), 'DMV buttons hidden for LE');
  const save = fnBody('saveInlineEditWitness');
  ok(save.includes('wle-toggle-') && save.includes("v('leEmail')") && save.includes('_leClearFlag(witness)'), 'inline save reads LE fields / clears flag');
  ok(HTML.includes('function _leWitnessPrintCard('), 'printable LE card exists');
  ok(detail.includes('convertWitnessType(${index})') && detail.includes('Convert to Law Enforcement'), 'detail view has the convert button');
  ok(fnBody('convertWitnessType').includes('{ convert: true }'), 'convert opens the form flipped');
  ok(modal.includes('opts.convert') && modal.includes('applyLeMode(!isLe, true)'), 'form honours convert');
}

console.log(`\nle-witness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
