/**
 * Tests for the Related-Cases → "import this person" plumbing in
 * modules/case-link.js.
 * Run: node modules/__tests__/case-link-import.test.js
 *
 * The feature depends on two things that are easy to get quietly wrong:
 *   1. getRelatedCases() must attach a `ref` descriptor to every shared
 *      person, including manual links (which have no underlying record).
 *   2. getPersonRecord(ref) must find the ORIGINAL stored object again, so
 *      the import copies what is on disk now rather than a stale snapshot.
 *
 * case-link.js is a browser module that attaches to `window`, so it is loaded
 * with vm and sandbox.window = sandbox — making window === globalThis exactly
 * as in a real renderer (see THE HOST-SCOPING TRAP).
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

const SRC = fs.readFileSync(path.join(__dirname, '..', 'case-link.js'), 'utf8');

// ── Fixture: three cases sharing people in different ways ───────────
const CASES = [
  { id: 'c1', caseNumber: '26-0001', title: 'Burglary', status: 'Active' },
  { id: 'c2', caseNumber: '26-0002', title: 'Fraud', status: 'Active' },
  { id: 'c3', caseNumber: '26-0003', title: 'Missing juvenile', status: 'Active' },
];

// The record we expect an import to copy. Deliberately carries fields the
// importer must preserve (dlState, vehicles) so a lossy ref resolution shows up.
const HOBBES_C2 = {
  id: 9001,
  name: 'Hobbes, Calvin',
  dob: '1985-03-04',
  dlNumber: 'D1234567',
  dlState: 'CA',
  sex: 'M',
  height: `5'11"`,
  address: '123 Transmogrifier Ln',
  phone: '(555) 010-2030',
  vehicles: [{ plateNumber: '7ABC123', plateState: 'CA', makeModel: 'Ford F-150' }],
};

const store = {
  viperCases: JSON.stringify(CASES),
  // c1: our case. Calvin is a WITNESS here.
  suspects_c1: JSON.stringify([{ id: 1, name: 'Doe, John', dob: '1990-01-01' }]),
  witnesses_c1: JSON.stringify([{ id: 2, name: 'Hobbes, Calvin', dob: '1985-03-04' }]),
  // c2: Calvin is a SUSPECT here, with the full record.
  suspects_c2: JSON.stringify([HOBBES_C2]),
  // c3: identifier-only link to c1 via a shared email, no name overlap.
  victims_c1: JSON.stringify([{ id: 3, name: 'Roe, Jane', email: 'shared@example.com' }]),
  suspects_c3: JSON.stringify([{ id: 4, name: 'Nobody, Anon', email: 'shared@example.com' }]),
};

function load(extraStore) {
  const data = Object.assign({}, store, extraStore || {});
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
  const sandbox = { localStorage, console, Date, JSON, Math, _data: data };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'case-link.js' });
  return { CaseLink: sandbox.CaseLink, data };
}

// ── refs are attached ───────────────────────────────────────────────
console.log('\n-- ref descriptors --');
{
  const { CaseLink } = load();
  const related = CaseLink.getRelatedCases('c1');
  ok(related.length >= 1, 'c1 has related cases');

  const c2 = related.find(r => r.caseId === 'c2');
  ok(!!c2, 'c2 is related to c1 (Calvin, name + DOB)');
  const calvin = c2 && c2.sharedPersons.find(sp => /Hobbes/i.test(sp.name));
  ok(!!calvin, 'Calvin appears as a shared person');

  if (calvin) {
    eq(calvin.confidence, 'HIGH', 'name + DOB match is HIGH confidence');
    eq(calvin.sourceCaseId, 'c2', 'sourceCaseId points at the OTHER case');
    eq(calvin.sourceCaseNumber, '26-0002', 'sourceCaseNumber carried');
    eq(calvin.sourceRole, 'suspect', 'sourceRole is the role in the other case');
    eq(calvin.myRole, 'witness', 'myRole is the role in THIS case');
    ok(!!calvin.ref, 'ref descriptor present');
    eq(calvin.ref.caseId, 'c2', 'ref.caseId');
    eq(calvin.ref.role, 'suspect', 'ref.role');
    ok(!!calvin.ref.canonical, 'ref.canonical populated for a name+DOB match');
  }

  // Every shared person on every related case must be importable.
  let missingRef = 0;
  related.forEach(r => r.sharedPersons.forEach(sp => { if (!sp.ref) missingRef++; }));
  eq(missingRef, 0, 'every shared person carries a ref');
}

// ── getPersonRecord resolves the original object ────────────────────
console.log('\n-- record resolution --');
{
  const { CaseLink } = load();
  const related = CaseLink.getRelatedCases('c1');
  const c2 = related.find(r => r.caseId === 'c2');
  const calvin = c2.sharedPersons.find(sp => /Hobbes/i.test(sp.name));

  const rec = CaseLink.getPersonRecord(calvin.ref);
  ok(!!rec, 'record resolved');
  eq(rec && rec.id, 9001, 'resolved the right record');
  eq(rec && rec.dlNumber, 'D1234567', 'DL number present');
  eq(rec && rec.dlState, 'CA', 'DL STATE present — the new field must survive the ref round-trip');
  eq(rec && rec.vehicles && rec.vehicles[0] && rec.vehicles[0].plateState, 'CA', 'vehicle plate state present');
  eq(rec && rec.phone, '(555) 010-2030', 'phone present (raw, not normalised)');

  // Identifier-only link: names differ entirely, matched on email.
  const c3 = related.find(r => r.caseId === 'c3');
  ok(!!c3, 'c3 is related to c1 via a shared email');
  const anon = c3 && c3.sharedPersons[0];
  ok(anon && !!anon.ref, 'identifier-only shared person carries a ref');
  ok(anon && anon.ref.ident.indexOf('shared@example.com') !== -1,
    'ref.ident records the matched identifier');
  const anonRec = anon && CaseLink.getPersonRecord(anon.ref);
  eq(anonRec && anonRec.id, 4, 'identifier-only record resolves by ident');
}

// ── ref resolution is tolerant ──────────────────────────────────────
console.log('\n-- resolution fallbacks --');
{
  const { CaseLink } = load();
  // Canonical key wrong / stale but the name key still good: must still find
  // the person. This is the case where the source record's DOB was corrected
  // between the render and the click.
  const rec = CaseLink.getPersonRecord({
    caseId: 'c2', role: 'suspect', canonical: 'STALE|KEY|9999', nameKey: 'HOBBES|CALVIN', ident: '',
  });
  eq(rec && rec.id, 9001, 'falls back to the name key when canonical is stale');

  // Manual-link shape: free-text name, no keys at all.
  const manual = CaseLink.getPersonRecord({
    caseId: 'c2', role: '', canonical: '', nameKey: '', ident: '',
    name: 'Hobbes, Calvin', dob: '1985-03-04',
  });
  eq(manual && manual.id, 9001, 'manual-link name lookup finds the record');

  const manualOtherOrder = CaseLink.getPersonRecord({
    caseId: 'c2', role: '', name: 'Calvin Hobbes', dob: '',
  });
  eq(manualOtherOrder && manualOtherOrder.id, 9001, '"First Last" order also resolves');

  // Misses must return null, never a wrong person. Importing the wrong human
  // into a case file is far worse than importing nobody.
  eq(CaseLink.getPersonRecord(null), null, 'null ref -> null');
  eq(CaseLink.getPersonRecord({}), null, 'empty ref -> null');
  eq(CaseLink.getPersonRecord({ caseId: 'nope', role: 'suspect', canonical: 'x' }), null,
    'unknown case -> null');
  eq(CaseLink.getPersonRecord({ caseId: 'c2', role: 'suspect', name: 'Ghost, Casper' }), null,
    'name not in the case -> null');
  eq(CaseLink.getPersonRecord({ caseId: 'c2', role: 'victim', canonical: '', nameKey: 'HOBBES|CALVIN' }), null,
    'right name, wrong role, no fallback name -> null');
}

// ── manual links carry an importable ref ────────────────────────────
console.log('\n-- manual links --');
{
  const { CaseLink } = load();
  CaseLink.addManualLink(
    { caseId: 'c1', caseNumber: '26-0001' },
    { caseId: 'c2', caseNumber: '26-0002' },
    { name: 'Hobbes, Calvin', dob: '1985-03-04', role: 'suspect' },
    'same MO'
  );
  CaseLink.invalidateIndex();
  const related = CaseLink.getRelatedCases('c1');
  const c2 = related.find(r => r.caseId === 'c2');
  ok(!!c2, 'manually linked case present');
  const man = c2.sharedPersons.find(sp => sp.confidence === 'MANUAL');
  ok(!!man, 'manual shared person present');
  if (man) {
    ok(!!man.ref, 'manual shared person carries a ref');
    eq(man.ref.caseId, 'c2', 'manual ref.caseId');
    eq(man.ref.name, 'Hobbes, Calvin', 'manual ref keeps the typed name');
    const rec = CaseLink.getPersonRecord(man.ref);
    eq(rec && rec.id, 9001, 'manual ref resolves to the real record when one exists');
  }
}

// ── manual link to a case with no matching record ───────────────────
{
  const { CaseLink } = load();
  CaseLink.addManualLink(
    { caseId: 'c1', caseNumber: '26-0001' },
    { caseId: 'c3', caseNumber: '26-0003' },
    { name: 'Phantom, Pat', dob: '', role: 'suspect' },
    'hunch'
  );
  CaseLink.invalidateIndex();
  const related = CaseLink.getRelatedCases('c1');
  const c3 = related.find(r => r.caseId === 'c3');
  const man = c3 && c3.sharedPersons.find(sp => sp.confidence === 'MANUAL');
  ok(!!man, 'manual link to c3 present');
  // No such person in c3 — must resolve to null so the UI falls back to
  // importing just the typed name rather than importing the wrong person.
  eq(man && CaseLink.getPersonRecord(man.ref), null,
    'manual link with no underlying record resolves to null');
}

// ── surface ─────────────────────────────────────────────────────────
console.log('\n-- module surface --');
{
  const { CaseLink } = load();
  eq(typeof CaseLink.getPersonRecord, 'function', 'CaseLink.getPersonRecord exported');
  eq(typeof CaseLink.getRelatedCases, 'function', 'CaseLink.getRelatedCases exported');
}

console.log(`\ncase-link-import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
