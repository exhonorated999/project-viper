'use strict';
// Tests for modules/case-forms/form-sources.js and auto-map.js. SYNTHETIC data only.
// Run: node modules/case-forms/__tests__/form-sources.test.js
const FS = require('../form-sources.js');
const AM = require('../auto-map.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}

// ---- Names -----------------------------------------------------------------------------------
eq(FS.splitName('John Paul Smith'), { first: 'John', middle: 'Paul', last: 'Smith' }, 'name: first middle last');
eq(FS.splitName('Smith, John Paul'), { last: 'Smith', first: 'John', middle: 'Paul' }, 'name: last, first middle');
eq(FS.splitName('Smith, John Jr'), { last: 'Smith Jr', first: 'John', middle: '' }, 'name: comma form keeps suffix with last');
eq(FS.splitName('John Q Smith III'), { first: 'John', middle: 'Q', last: 'Smith III' }, 'name: suffix stays with last');
eq(FS.splitName('  Ana   de  Leon '), { first: 'Ana', middle: 'de', last: 'Leon' }, 'name: whitespace collapsed');
eq(FS.splitName('Prince'), { first: 'Prince', middle: '', last: '' }, 'name: single word');
eq(FS.splitName(''), { first: '', middle: '', last: '' }, 'name: empty');

// ---- Addresses -------------------------------------------------------------------------------
eq(FS.splitCityStateZip('Springfield, CO 80000'), { city: 'Springfield', state: 'CO', zip: '80000' }, 'csz: comma form');
eq(FS.splitCityStateZip('Springfield co 80000-1234'), { city: 'Springfield', state: 'CO', zip: '80000-1234' }, 'csz: no comma, zip+4');
eq(FS.splitCityStateZip('North Town, Colorado'), { city: 'North Town', state: 'Colorado', zip: '' }, 'csz: long state, no zip');
eq(FS.splitCityStateZip('Springfield'), { city: 'Springfield', state: '', zip: '' }, 'csz: city only');
eq(FS.splitAddress('1 Main St, Springfield, CO 80000', ''), { street: '1 Main St', city: 'Springfield', state: 'CO', zip: '80000' }, 'address: whole line in the street box');
eq(FS.splitAddress('1 Main St', 'Springfield, CO 80000'), { street: '1 Main St', city: 'Springfield', state: 'CO', zip: '80000' }, 'address: two boxes');

// ---- Dates -----------------------------------------------------------------------------------
eq(FS.formatDate('2009-03-04'), '03/04/2009', 'date: default MM/DD/YYYY');
eq(FS.formatDate('2009-03-04', 'M/D/YYYY'), '3/4/2009', 'date: M/D/YYYY');
eq(FS.formatDate('2009-03-04', 'long'), 'March 4, 2009', 'date: long');
eq(FS.formatDate('03/04/2009', 'YYYY-MM-DD'), '2009-03-04', 'date: US input');
eq(FS.formatDate('not a date'), 'not a date', 'date: unparseable passes through');
const now = new Date(2026, 10, 24, 9, 5);
eq(FS.formatTime(now), '09:05', 'time: HH:mm');
eq(FS.formatTime(now, 'HHmm'), '0905', 'time: HHmm');
eq(FS.formatTime(new Date(2026, 0, 1, 0, 30), 'h:mm A'), '12:30 AM', 'time: midnight 12h');
eq(FS.ageOn('2009-11-24', now), '17', 'age: birthday today');
eq(FS.ageOn('2009-11-25', now), '16', 'age: birthday tomorrow');
eq(FS.ageOn('', now), '', 'age: no dob');

// ---- Records ---------------------------------------------------------------------------------
const p = FS.normPerson({
  name: 'Sample, Alex Robin', dob: '1990-05-06', address: '22 Oak Ave', addressCityStateZip: 'Lakeside, CO 80001',
  identifiers: [{ type: 'phone', value: '555-0101' }, { type: 'email', value: 'alex@example.test' }, { type: 'dl', value: 'DL123' }],
});
eq([p.firstName, p.middleName, p.lastName, p.fullName], ['Alex', 'Robin', 'Sample', 'Alex Robin Sample'], 'person: comma name split and rebuilt');
eq([p.street, p.city, p.state, p.zip], ['22 Oak Ave', 'Lakeside', 'CO', '80001'], 'person: address split');
eq([p.phone, p.email, p.dlNumber], ['555-0101', 'alex@example.test', 'DL123'], 'person: identifiers used when no direct field');
const le = FS.normPerson({ lawEnforcement: true, firstName: 'Pat', lastName: 'Officer', agencyPhone: '555-0199' });
eq([le.fullName, le.phone], ['Pat Officer', '555-0199'], 'person: LE witness uses first/last');

const v = FS.normVehicle({ makeModel: '2015 Honda Civic', licensePlate: 'ABC123', plateState: 'CO', vin: '1hgcm82633a004352' });
eq([v.year, v.make, v.model, v.plate, v.vin], ['2015', 'Honda', 'Civic', 'ABC123', '1HGCM82633A004352'], 'vehicle: year/make/model split, VIN upper');
const v2 = FS.normVehicle({ makeModel: 'Ford', plateNumber: 'XYZ9', color: 'Red' });
eq([v2.make, v2.model, v2.plate, v2.color], ['Ford', '', 'XYZ9', 'Red'], 'vehicle: suspect-vehicle shape');

const stores = {
  suspects: [{ name: 'Doe, John', dob: '2000-01-02', vehicles: [{ makeModel: 'Toyota Camry', plateNumber: 'S1' }] }, { name: '' }],
  victims: [{ name: 'Vic Tim' }],
  witnesses: [{ lawEnforcement: true, firstName: 'Lee', lastName: 'Badge' }],
  recoveredVehicles: [{ makeModel: 'Honda Civic', year: '2015', licensePlate: 'R1', plateState: 'CO' }],
};
const people = FS.peopleFromCase(stores);
eq(people.map(x => x.key), ['suspects:0', 'victims:0', 'witnesses:0'], 'people: nameless records skipped, order by role');
eq(people[0].label, 'John Doe (DOB 01/02/2000)', 'people: label with DOB');
const vehicles = FS.vehiclesFromCase(stores);
eq(vehicles.map(x => x.key), ['recoveredVehicles:0', 'suspects:0:vehicles:0'], 'vehicles: recovered then person vehicles');
ok(/\(Doe, John\)$/.test(vehicles[1].label), 'vehicles: owner shown');

// ---- Context + resolve -----------------------------------------------------------------------
const ctx = FS.buildContext({
  currentCase: { caseNumber: '26-0001', title: 'Test case', primaryOffense: 'Theft', offenseDate: '2026-11-01T10:00', createdBy: 'Fallback Name' },
  suspects: stores.suspects,
  officer: { affiantName: 'Det. Sample', affiantRank: 'Detective', affiantBadge: '#42', agencyName: 'Sample PD' },
  people: { subject: { name: 'Doe, John Quincy', dob: '2009-03-04' }, guardian: null },
  vehicles: { vehicle: stores.recoveredVehicles[0] },
  now,
});
const R = (b) => FS.resolve(b, ctx);
eq(R({ src: 'case.number' }), '26-0001', 'resolve: case number');
eq(R({ src: 'case.offenseDate', fmt: 'long' }), 'November 1, 2026', 'resolve: offense date formatted, time dropped');
eq(R({ src: 'case.suspectNames' }), 'John Doe', 'resolve: suspect names skip blanks');
eq(R({ src: 'officer.nameBadge' }), 'Det. Sample #42', 'resolve: name + badge, no double #');
eq(R({ src: 'officer.rankName' }), 'Detective Det. Sample', 'resolve: rank + name');
eq(R({ src: 'person.lastFirst', slot: 'subject' }), 'Doe, John Quincy', 'resolve: last, first middle');
eq(R({ src: 'person.middleInitial', slot: 'subject' }), 'Q', 'resolve: middle initial');
eq(R({ src: 'person.age', slot: 'subject' }), '17', 'resolve: age on now');
eq(R({ src: 'person.lastName', slot: 'subject', upper: true }), 'DOE', 'resolve: upper');
eq(R({ src: 'person.lastName', slot: 'guardian' }), '', 'resolve: empty slot');
eq(R({ src: 'vehicle.plate', slot: 'vehicle' }), 'R1', 'resolve: vehicle');
eq(R({ src: 'now.dateTime', fmt: 'YYYY-MM-DD', timeFmt: 'HHmm' }), '2026-11-24 0905', 'resolve: date-time');
eq(R({ src: 'const', value: 'X' }), 'X', 'resolve: const');
eq(R({ src: 'ask' }), '', 'resolve: ask');
eq(R({ src: 'nope.nothing' }), '', 'resolve: unknown source is empty');
const all = FS.resolveAll({ A: { src: 'case.number' }, B: { src: 'person.email', slot: 'subject' }, C: { src: 'ask' }, D: { src: 'const', value: true } }, ctx);
eq(all, { values: { A: '26-0001', D: true }, empty: ['B'] }, 'resolveAll: values, empties, asks skipped');
eq(FS.buildContext({ currentCase: { createdBy: 'Fallback Name' } }).officer.name, 'Fallback Name', 'context: officer falls back to case creator');

// ---- Auto-map --------------------------------------------------------------------------------
const F = (name, type) => ({ name, type: type || 'text' });
const src = (r, n) => r.bindings[n] ? r.bindings[n].src + (r.bindings[n].slot ? '@' + r.bindings[n].slot : '') : '';

const adult = AM.suggest([
  F('Case Number'), F('Subjects Last Name'), F('First Name'), F('Middle Name'), F('Date of Birth'),
  F('Advising Officer printed'), F('Location of Advisement'), F('Date'), F('Time'),
  F('I am a Law Enforcement Officer and want to interview you concerning'),
  F("Subject's Signature", 'signature'), F('Date_2'), F('Time_2'),
]);
eq(['Case Number', 'Subjects Last Name', 'First Name', 'Middle Name', 'Date of Birth', 'Advising Officer printed', 'Date', 'Time']
  .map(n => src(adult, n)),
['case.number', 'person.lastName@subject', 'person.firstName@subject', 'person.middleName@subject', 'person.dob@subject', 'officer.name', 'now.date', 'now.time'],
'auto-map: advisement header');
eq(src(adult, 'I am a Law Enforcement Officer and want to interview you concerning'), 'case.offenses', 'auto-map: "concerning" box gets offenses');
eq(src(adult, 'Location of Advisement'), '', 'auto-map: location left for the officer');
eq(src(adult, "Subject's Signature"), '', 'auto-map: signatures never bound');
eq(src(adult, 'Time_2'), '', 'auto-map: only the first time is filled');
eq(adult.confidence['Date_2'], 'low', 'auto-map: later dates are low confidence');
eq(adult.confidence['Case Number'], 'high', 'auto-map: first case number high');
eq(adult.slots.map(s => s.id + ':' + s.label), ['subject:Subject'], 'auto-map: one subject slot');

const juvenile = AM.suggest([
  F('Case Number'), F('Juveniles Last Name'), F('First Name'), F('Middle Name'), F('Date of Birth'), F('Age of Juvenile'),
  F('ParentGuardianCustodian Last Name'), F('First Name_2'), F('Middle Name_2'), F('Date of Birth_2'),
  F('Advising Officer printed'),
]);
eq(['Juveniles Last Name', 'Age of Juvenile', 'ParentGuardianCustodian Last Name', 'First Name_2', 'Date of Birth_2', 'Advising Officer printed'].map(n => src(juvenile, n)),
  ['person.lastName@subject', 'person.age@subject', 'person.lastName@guardian', 'person.firstName@guardian', 'person.dob@guardian', 'officer.name'],
  'auto-map: guardian block follows its hint');
eq(juvenile.slots.map(s => s.id + ':' + s.label), ['subject:Juvenile', 'guardian:Parent / guardian'], 'auto-map: juvenile + guardian slots');

const device = AM.suggest([
  F('Case Number'), F('Consenting Party Name'), F('Date of Birth'), F('Officer Requesting Consent'), F('Badge Number'),
  F('Make'), F('Model'), F('Phone Number'), F('Serial Number'), F('Application Name'), F('Username'), F('Password  PIN'),
  F('Consenting Party Name Printed'), F('Witness Name Printed'),
]);
eq(['Consenting Party Name', 'Officer Requesting Consent', 'Badge Number', 'Witness Name Printed'].map(n => src(device, n)),
  ['person.fullName@subject', 'officer.name', 'officer.badge', 'person.fullName@witness'], 'auto-map: device consent people');
eq(['Make', 'Model', 'Phone Number', 'Serial Number', 'Application Name', 'Username', 'Password  PIN'].map(n => src(device, n)),
  ['', '', '', '', '', '', ''], 'auto-map: device details and credentials never auto-filled');

const veh = AM.suggest([
  F('Case Number'), F('Year'), F('Make'), F('Model'), F('Color'), F('Color_2'), F('License Plate Number'), F('License State'), F('VIN'),
  F('Extension Authorized By'), F('Badge Number'),
  F('Last Name'), F('First Name'), F('Street Address'), F('City'), F('State'), F('Zip Code'),
]);
eq(['Year', 'Make', 'Model', 'Color', 'Color_2', 'License Plate Number', 'License State', 'VIN'].map(n => src(veh, n)),
  ['vehicle.year@vehicle', 'vehicle.make@vehicle', 'vehicle.model@vehicle', 'vehicle.color@vehicle', '', 'vehicle.plate@vehicle', 'vehicle.plateState@vehicle', 'vehicle.vin@vehicle'],
  'auto-map: vehicle block');
eq(['Extension Authorized By', 'Badge Number', 'Last Name', 'First Name', 'Street Address', 'City', 'State', 'Zip Code'].map(n => src(veh, n)),
  ['officer.name', 'officer.badge', 'person.lastName@subject', 'person.firstName@subject', 'person.street@subject', 'person.city@subject', 'person.state@subject', 'person.zip@subject'],
  'auto-map: owner block after an officer line still maps to the person');
eq(veh.vehicleSlots, [{ id: 'vehicle', label: 'Vehicle' }], 'auto-map: vehicle slot declared');
eq(veh.slots.map(s => s.label), ['Registered owner'], 'auto-map: owner label on a vehicle form');

const checklist = AM.suggest([F('Case Number'), F('Def Names'), F('Dropdown1', 'dropdown'), F('Button1', 'button')]);
eq([src(checklist, 'Def Names'), src(checklist, 'Dropdown1'), src(checklist, 'Button1')], ['case.suspectNames', '', ''], 'auto-map: checklist');
eq(checklist.slots, [], 'auto-map: no person slots when no person fields');

const es = AM.suggest([F('Número de caso Case Number'), F('Apellido del individuo Subjects Last Name'), F('Fecha de Nacimiento Date of Birth')]);
eq([src(es, 'Número de caso Case Number'), src(es, 'Apellido del individuo Subjects Last Name'), src(es, 'Fecha de Nacimiento Date of Birth')],
  ['case.number', 'person.lastName@subject', 'person.dob@subject'], 'auto-map: bilingual labels');

eq(AM.suggest([]).bindings, {}, 'auto-map: empty form');

console.log(`case-forms sources/auto-map: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
