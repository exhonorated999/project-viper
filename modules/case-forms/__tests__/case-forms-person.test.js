'use strict';
// Tests for the pure helpers in modules/case-forms/case-forms-person.js. SYNTHETIC data only.
// Run: node modules/case-forms/__tests__/case-forms-person.test.js
const P = require('../case-forms-person.js');
const FS = require('../form-sources.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}

// ---- Exports ---------------------------------------------------------------------------------
['slotForPerson', 'fitFor', 'formChoices', 'formForLanguage', 'picksForPerson', 'picksSummary']
  .forEach(n => ok(typeof P[n] === 'function', 'export: ' + n));
ok(typeof P.open === 'undefined', 'node: no renderer exported');
eq(P.ROLE_OF, { suspects: 'suspect', victims: 'victim', witnesses: 'witness', involvedPersons: 'involved' }, 'role map');

// ---- Fixture forms (shaped like the set summary) ---------------------------------------------
const adultEn = { id: 'adult-en', title: 'Adult EN', category: 'Advisements', language: 'en', group: 'Adult Advisement', slots: [{ id: 'subject', label: 'Subject', roles: ['suspect'] }], vehicleSlots: [] };
const adultEs = Object.assign({}, adultEn, { id: 'adult-es', title: 'Adult ES', language: 'es' });
const juv = { id: 'juv-en', title: 'Juvenile', category: 'Advisements', language: 'en', group: 'Juvenile Advisement',
  slots: [{ id: 'juvenile', label: 'Juvenile', roles: ['suspect'] }, { id: 'guardian', label: 'Parent', roles: ['involved', 'witness'] }], vehicleSlots: [] };
const consent = { id: 'consent', title: 'Device Consent', category: 'Consent', language: 'en', slots: [{ id: 'consenter', label: 'Consenting party', roles: [] }, { id: 'witness', label: 'Witness', roles: [] }], vehicleSlots: [] };
const intake = { id: 'intake', title: 'Intake Checklist', category: 'DA', language: 'en', slots: [], vehicleSlots: [] };
const hold = { id: 'hold', title: 'Vehicle Hold', category: 'Vehicles', language: 'en', slots: [], vehicleSlots: [{ id: 'vehicle', label: 'Vehicle' }] };
const release = { id: 'release', title: 'Vehicle Release', category: 'Vehicles', language: 'en',
  slots: [{ id: 'owner', label: 'Released to', roles: ['victim', 'involved'] }], vehicleSlots: [{ id: 'vehicle', label: 'Vehicle' }] };
const lineup = { id: 'lineup', title: 'Lineup', category: 'Lineups', language: 'en', slots: [{ id: 'witness', label: 'Witness', roles: ['witness', 'victim'] }], vehicleSlots: [] };
const legacy = { id: 'legacy', title: 'Old Summary', category: 'Other' };   // set summary without slot info

// ---- slotForPerson / fitFor ------------------------------------------------------------------
eq(P.slotForPerson(juv.slots, 'suspect'), 'juvenile', 'slot: role match');
eq(P.slotForPerson(juv.slots, 'involved'), 'guardian', 'slot: second slot when it is meant for the role');
eq(P.slotForPerson(juv.slots, 'victim'), 'juvenile', 'slot: no fit → first slot');
eq(P.slotForPerson(consent.slots, 'witness'), 'consenter', 'slot: open slot');
eq(P.slotForPerson([], 'suspect'), null, 'slot: none');
eq(P.slotForPerson(null, 'suspect'), null, 'slot: null');

eq([adultEn, juv, consent, intake, hold, release, lineup, legacy].map(f => P.fitFor(f, 'victim')),
  ['other', 'other', 'open', 'case', 'case', 'match', 'match', 'open'], 'fit: victim');
eq([adultEn, juv, lineup].map(f => P.fitFor(f, 'suspect')), ['match', 'match', 'other'], 'fit: suspect');
eq(P.fitFor(juv, 'involved'), 'match', 'fit: guardian slot fits an involved person');

// ---- formChoices -----------------------------------------------------------------------------
const sets = [
  { id: 'sample-pd', name: 'Sample PD', agency: 'Sample Police', forms: [adultEn, adultEs, juv, consent, intake, hold, release, lineup] },
  { id: 'broken', error: 'bad manifest' },
  { id: 'empty', name: 'Empty', forms: [] },
];
let ch = P.formChoices(sets, 'suspect');
eq(ch.map(c => c.setId), ['sample-pd'], 'choices: broken and empty sets left out');
eq(ch[0].entries.map(e => [e.title, e.suggested]), [
  ['Adult Advisement', true], ['Juvenile', true], ['Device Consent', true],
  ['Intake Checklist', false], ['Lineup', false], ['Vehicle Hold', false], ['Vehicle Release', false],
], 'choices: suspect — suggested first, tab order kept within each part');
eq(ch[0].entries[0].languages, ['en', 'es'], 'choices: languages of a group');
eq(ch[0].entries[0].forms.map(f => f.id), ['adult-en', 'adult-es'], 'choices: group forms kept');

ch = P.formChoices(sets, 'victim');
eq(ch[0].entries.filter(e => e.suggested).map(e => e.title), ['Device Consent', 'Lineup', 'Vehicle Release'], 'choices: victim suggestions');
eq(P.formChoices(null, 'victim'), [], 'choices: null sets');

// ---- formForLanguage -------------------------------------------------------------------------
const adultEntry = P.formChoices(sets, 'suspect')[0].entries[0];
eq(P.formForLanguage(adultEntry, 'es').id, 'adult-es', 'lang: Spanish');
eq(P.formForLanguage(adultEntry, 'fr').id, 'adult-en', 'lang: unknown → English');
eq(P.formForLanguage({ forms: [{ id: 'x', language: 'es' }] }, 'en').id, 'x', 'lang: only form');
eq(P.formForLanguage({ forms: [] }, 'en'), null, 'lang: none');

// ---- picksForPerson --------------------------------------------------------------------------
const stores = {
  suspects: [
    { name: 'Doe, John', dob: '2009-03-04', vehicles: [{ makeModel: 'Ford F150', year: '2001', licensePlate: 'S1' }] },
    { name: 'Roe, Rick' },
  ],
  victims: [{ name: 'Vic Tim', vehicles: [{ makeModel: 'Toyota Camry', licensePlate: 'V1' }] }],
  witnesses: [{ name: 'Wit Ness' }],
  involvedPersons: [{ name: 'Parent, Pat' }],
  recoveredVehicles: [{ makeModel: 'Honda Civic', year: '2015', licensePlate: 'R1', plateState: 'CO' }],
};
const people = FS.peopleFromCase(stores);
const vehicles = FS.vehiclesFromCase(stores);

let pk = P.picksForPerson(adultEn, 'suspects:1', 'suspect', people, vehicles);
eq(pk.people, { subject: 'suspects:1' }, 'picks: second suspect goes on the form, not the first');
eq(pk.slotId, 'subject', 'picks: slot reported');

pk = P.picksForPerson(juv, 'involvedPersons:0', 'involved', people, vehicles);
eq(pk.people, { juvenile: 'suspects:0', guardian: 'involvedPersons:0' }, 'picks: parent page → parent as guardian, juvenile defaulted');

pk = P.picksForPerson(juv, 'suspects:1', 'suspect', people, vehicles);
eq(pk.people, { guardian: 'involvedPersons:0', juvenile: 'suspects:1' }, 'picks: juvenile page → guardian defaulted');

pk = P.picksForPerson(consent, 'witnesses:0', 'witness', people, vehicles);
eq(pk.people, { consenter: 'witnesses:0' }, 'picks: open slots — person first, second open slot left for the officer');

pk = P.picksForPerson(consent, 'suspects:0', 'suspect', people, vehicles);
eq(pk.people, { consenter: 'suspects:0' }, 'picks: a role-less second slot never grabs a suspect');

pk = P.picksForPerson(release, 'victims:0', 'victim', people, vehicles);
eq(pk.people, { owner: 'victims:0' }, 'picks: release to the victim');
eq(pk.vehicles, { vehicle: 'victims:0:vehicles:0' }, 'picks: the person\'s own vehicle first');

pk = P.picksForPerson(hold, 'witnesses:0', 'witness', people, vehicles);
eq(pk.people, {}, 'picks: no person slot');
eq(pk.slotId, null, 'picks: no slot id');
eq(pk.vehicles, { vehicle: 'recoveredVehicles:0' }, 'picks: no own vehicle → case vehicle order');

pk = P.picksForPerson(lineup, 'suspects:0', 'suspect', people, vehicles);
eq(pk.people, { witness: 'suspects:0' }, 'picks: chosen form with no fitting slot → first slot');

// ---- picksSummary ----------------------------------------------------------------------------
pk = P.picksForPerson(juv, 'involvedPersons:0', 'involved', people, vehicles);
eq(P.picksSummary(juv, pk, people, vehicles), 'Juvenile: John Doe · Parent: Pat Parent', 'summary: names without DOB');
pk = P.picksForPerson(release, 'victims:0', 'victim', people, vehicles);
ok(/^Released to: Vic Tim · Vehicle: .*V1/.test(P.picksSummary(release, pk, people, vehicles)), 'summary: vehicle');
eq(P.picksSummary(consent, { people: { consenter: 'witnesses:0' }, vehicles: {} }, people, vehicles), 'Consenting party: Wit Ness · Witness: —', 'summary: empty slot');

console.log(`case-forms-person: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
