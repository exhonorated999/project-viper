'use strict';
// Tests for the pure helpers in modules/case-forms/case-forms-tab.js. SYNTHETIC data only.
// Run: node modules/case-forms/__tests__/case-forms-tab.test.js
const T = require('../case-forms-tab.js');
const FS = require('../form-sources.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}

// ---- Exports ---------------------------------------------------------------------------------
['formGroups', 'defaultPicks', 'describeBinding', 'computeRows', 'collectValues', 'nameHint', 'langName']
  .forEach(n => ok(typeof T[n] === 'function', 'export: ' + n));
ok(typeof T.mount === 'undefined', 'node: no renderer exported');

// ---- formGroups ------------------------------------------------------------------------------
const forms = [
  { id: 'adv-en', title: 'Advisement (English)', category: 'Advisements', language: 'en', group: 'Adult Advisement' },
  { id: 'adv-es', title: 'Advisement (Spanish)', category: 'Advisements', language: 'es', group: 'Adult Advisement' },
  { id: 'juv-en', title: 'Juvenile Advisement', category: 'Advisements', language: 'en', group: 'Juvenile Advisement' },
  { id: 'misc', title: 'Misc Sheet' },
  { id: 'consent', title: 'Device Consent', category: 'Consent', language: 'en' },
];
const groups = T.formGroups(forms);
eq(groups.map(g => g.category), ['Advisements', 'Consent', 'Other'], 'groups: categories sorted, Other last');
eq(groups[0].entries.map(e => e.key), ['g:Adult Advisement', 'g:Juvenile Advisement'], 'groups: group keys');
eq(groups[0].entries[0].forms.map(f => f.id), ['adv-en', 'adv-es'], 'groups: languages share one entry');
eq(groups[0].entries[0].title, 'Adult Advisement', 'groups: multi-form entry shows the group name');
eq(groups[0].entries[1].title, 'Juvenile Advisement', 'groups: one-form group shows the form title');
eq(groups[1].entries[0].key, 'f:consent', 'groups: ungrouped form key');
eq(groups[2].entries[0].title, 'Misc Sheet', 'groups: no category → Other');
eq(T.formGroups(null), [], 'groups: null');

// ---- defaultPicks ----------------------------------------------------------------------------
const stores = {
  suspects: [{ name: 'Doe, John', dob: '2009-03-04' }, { name: 'Roe, Rick' }],
  victims: [{ name: 'Vic Tim' }],
  witnesses: [{ name: 'Wit Ness' }],
  involvedPersons: [{ name: 'Parent, Pat' }],
  recoveredVehicles: [{ makeModel: 'Honda Civic', year: '2015', licensePlate: 'R1', plateState: 'CO' }],
};
const people = FS.peopleFromCase(stores);
const vehicles = FS.vehiclesFromCase(stores);
ok(people.length === 5, 'fixture: five people');

let picks = T.defaultPicks(
  [{ id: 'subject', label: 'Subject' }, { id: 'guardian', label: 'Parent', roles: ['involved', 'witness'] }],
  people, [{ id: 'vehicle', label: 'Vehicle' }], vehicles);
eq(picks.people, { subject: 'suspects:0', guardian: 'involvedPersons:0' }, 'picks: first slot → suspect, role slot → its first listed role wins');
eq(picks.vehicles, { vehicle: 'recoveredVehicles:0' }, 'picks: vehicle by index');

picks = T.defaultPicks([{ id: 'w', roles: ['witness', 'victim'] }, { id: 'w2', roles: ['witness', 'victim'] }], people, [], []);
eq(picks.people, { w: 'witnesses:0', w2: 'victims:0' }, 'picks: role order is a preference, next role when the first runs out');

picks = T.defaultPicks([{ id: 'a', roles: ['suspect'] }, { id: 'b', roles: ['suspect'] }, { id: 'c', roles: ['suspect'] }], people, [], []);
eq(picks.people, { a: 'suspects:0', b: 'suspects:1' }, 'picks: no person used twice, slot left empty when none left');

picks = T.defaultPicks([{ id: 'x' }, { id: 'y' }], people, [], []);
eq(picks.people, { x: 'suspects:0' }, 'picks: role-less later slot stays empty');

picks = T.defaultPicks([{ id: 'v', roles: ['victim'] }], [], [{ id: 'v1' }, { id: 'v2' }], vehicles);
eq(picks, { people: {}, vehicles: { v1: 'recoveredVehicles:0' } }, 'picks: no people, fewer vehicles than slots');

// ---- describeBinding -------------------------------------------------------------------------
const slots = [{ id: 'subject', label: 'Subject' }];
const vslots = [{ id: 'veh', label: 'Held vehicle' }];
eq(T.describeBinding(null), { kind: 'ask', text: 'Type it' }, 'how: unbound');
eq(T.describeBinding({ src: 'ask' }), { kind: 'ask', text: 'Type it' }, 'how: ask');
eq(T.describeBinding({ src: 'nope.x' }), { kind: 'ask', text: 'Type it' }, 'how: unknown source');
eq(T.describeBinding({ src: 'const', value: true }).text, 'Always checked', 'how: const checkbox');
eq(T.describeBinding({ src: 'const', value: 'X' }).text, 'Fixed text', 'how: const text');
eq(T.describeBinding({ src: 'person.lastName', slot: 'subject' }, slots), { kind: 'case', text: 'Subject · Last name' }, 'how: person slot label');
eq(T.describeBinding({ src: 'vehicle.plate', slot: 'veh' }, slots, vslots).text, 'Held vehicle · ' + FS.SOURCE_BY_ID['vehicle.plate'].label, 'how: vehicle slot label');
eq(T.describeBinding({ src: 'case.number' }), { kind: 'case', text: 'Case · Case number' }, 'how: case group');

// ---- computeRows -----------------------------------------------------------------------------
const spec = {
  set: { id: 's', name: 'Sample Set', version: '1.0.0' },
  form: {
    id: 'adv-en', title: 'Advisement', slots, vehicleSlots: vslots,
    bindings: {
      'Case Number': { src: 'case.number' },
      'Last Name': { src: 'person.lastName', slot: 'subject' },
      'Plate': { src: 'vehicle.plate', slot: 'veh' },
      'Location': { src: 'ask' },
      'Understood': { src: 'const', value: true },
      'Waived': { src: 'const', value: 'Yes' },
      'Nope': { src: 'const', value: false },
    },
  },
  pdf: {
    fields: [
      { name: 'Case Number', type: 'text', page: 0 },
      { name: 'Last Name', type: 'text', page: 0, maxLength: 20 },
      { name: 'Plate', type: 'text', page: 0 },
      { name: 'Location', type: 'text', page: 1, multiline: true },
      { name: 'Understood', type: 'checkbox', page: 1 },
      { name: 'Waived', type: 'checkbox', page: 1 },
      { name: 'Nope', type: 'checkbox', page: 1 },
      { name: 'Signature', type: 'signature', page: 1 },
      { name: 'Locked', type: 'text', page: 1, readOnly: true },
      { name: 'Kind', type: 'dropdown', page: 1, options: ['A', 'B'] },
    ],
  },
};
const input = {
  currentCase: { caseNumber: '26-0001' },
  people: { subject: stores.suspects[0] },
  vehicles: {},
  now: new Date(2026, 10, 24, 9, 5),
};
let r = T.computeRows(spec, input, {});
eq(r.skipped, 2, 'rows: signature + read-only skipped');
eq(r.rows.map(x => x.name), ['Case Number', 'Last Name', 'Plate', 'Location', 'Understood', 'Waived', 'Nope', 'Kind'], 'rows: PDF order kept');
const byName = (rows, n) => rows.find(x => x.name === n);
eq(byName(r.rows, 'Case Number').value, '26-0001', 'rows: case value');
eq(byName(r.rows, 'Last Name').value, 'Doe', 'rows: person value');
eq(byName(r.rows, 'Last Name').maxLength, 20, 'rows: maxLength carried');
eq([byName(r.rows, 'Plate').value, byName(r.rows, 'Plate').blank], ['', true], 'rows: empty vehicle slot → blank');
eq([byName(r.rows, 'Location').how.kind, byName(r.rows, 'Location').blank, byName(r.rows, 'Location').multiline], ['ask', true, true], 'rows: ask is blank');
eq([byName(r.rows, 'Understood').value, byName(r.rows, 'Waived').value, byName(r.rows, 'Nope').value], [true, true, false], 'rows: checkbox values coerced');
ok(byName(r.rows, 'Nope').blank === false, 'rows: checkbox never blank');
eq(byName(r.rows, 'Kind').options, ['A', 'B'], 'rows: dropdown options');

r = T.computeRows(spec, input, { 'Last Name': 'Typed', 'Understood': false, 'Location': '' });
eq([byName(r.rows, 'Last Name').value, byName(r.rows, 'Last Name').edited, byName(r.rows, 'Last Name').auto], ['Typed', true, 'Doe'], 'rows: typed value wins, auto kept');
eq(byName(r.rows, 'Understood').value, false, 'rows: officer can clear a const box');
eq([byName(r.rows, 'Location').edited, byName(r.rows, 'Location').blank], [true, true], 'rows: typed empty is still blank');

const noPdf = T.computeRows({ form: {} }, {}, null);
eq(noPdf, { rows: [], skipped: 0 }, 'rows: no pdf fields');

// ---- collectValues ---------------------------------------------------------------------------
const vals = T.collectValues(r.rows);
eq(vals, { 'Case Number': '26-0001', 'Last Name': 'Typed', 'Location': '', 'Understood': false, 'Waived': true, 'Nope': false },
  'collect: non-empty text, edited empties, true boxes, cleared const box, bound false box (clears a box printed checked); blanks omitted');
eq(T.collectValues(null), {}, 'collect: null');
eq(T.collectValues([{ name: 'n', type: 'text', value: 0, edited: false, auto: '' }]), { n: '0' }, 'collect: numbers stringified');
eq(T.collectValues([{ name: 'c', type: 'checkbox', value: false, edited: false, auto: false, bound: false }]), {}, 'collect: unbound untouched false box omitted');

// ---- form defaults (what the blank PDF already holds) ------------------------------------------
{
  const pspec = {
    form: { bindings: { 'Bound Box': { src: 'const', value: false }, 'Typed': { src: 'case.number' } } },
    pdf: { fields: [
      { name: 'Status', type: 'dropdown', page: 0, options: ['N/A', 'In File'], value: 'N/A' },
      { name: 'Printed Checked', type: 'checkbox', page: 0, value: true },
      { name: 'Bound Box', type: 'checkbox', page: 0, value: true },
      { name: 'Typed', type: 'text', page: 0, value: 'OLD' },
      { name: 'Plain', type: 'text', page: 0 },
    ] },
  };
  const pr = T.computeRows(pspec, { currentCase: { caseNumber: '26-0009' } }, {});
  const st = byName(pr.rows, 'Status');
  eq([st.value, st.preset, st.blank, st.how.text], ['N/A', true, false, 'Form default'], 'preset: dropdown starts at its form default');
  eq([byName(pr.rows, 'Printed Checked').value, byName(pr.rows, 'Printed Checked').preset], [true, true], 'preset: box printed checked shows checked');
  eq([byName(pr.rows, 'Bound Box').value, byName(pr.rows, 'Bound Box').preset, byName(pr.rows, 'Bound Box').bound], [false, false, true], 'preset: a binding beats the form default');
  eq(byName(pr.rows, 'Typed').value, '26-0009', 'preset: bound text ignores the old text');
  eq([byName(pr.rows, 'Plain').value, byName(pr.rows, 'Plain').preset, byName(pr.rows, 'Plain').blank], ['', false, true], 'preset: no default → blank');
  const pv = T.collectValues(pr.rows);
  eq(pv, { 'Status': 'N/A', 'Printed Checked': true, 'Bound Box': false, 'Typed': '26-0009' }, 'preset: collect keeps defaults, clears the bound box');
  const pe = T.computeRows(pspec, {}, { 'Status': 'In File', 'Printed Checked': false });
  eq([byName(pe.rows, 'Status').value, byName(pe.rows, 'Printed Checked').value], ['In File', false], 'preset: officer edits win');
  eq(T.collectValues(pe.rows)['Printed Checked'], false, 'preset: unchecking a printed box is sent');
}

// ---- nameHint --------------------------------------------------------------------------------
eq(T.nameHint(spec, input), 'DOE, John', 'hint: LAST, First');
eq(T.nameHint(spec, { people: { subject: { name: 'Prince' } } }), 'Prince', 'hint: single name falls back to full name');
eq(T.nameHint(spec, { people: {}, vehicles: { veh: stores.recoveredVehicles[0] } }), 'R1', 'hint: plate when nobody');
eq(T.nameHint(spec, {}), '', 'hint: nothing');
eq(T.nameHint({ form: {} }, input), '', 'hint: form without slots');

// ---- langName --------------------------------------------------------------------------------
eq([T.langName('en'), T.langName('es-MX'), T.langName('fr'), T.langName('')], ['English', 'Spanish', 'FR', ''], 'lang names');

console.log(`case-forms-tab: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
