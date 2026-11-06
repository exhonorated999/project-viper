// RMS Import — combined case packets and cross-document person merging.
// Lifts the shipping helpers + routeRmsPersonsToTabs() out of
// case-detail-with-analytics.html and runs them over SYNTHETIC report
// objects (every name / number below is invented).
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('\n        function _rmsSplitPhones(');
const end = html.indexOf('\n        /*\n         * Arkansas NIBRS incident reports only: the primary OCR pass', start);
if (start < 0 || end < 0) throw new Error('router block not found');
const block = html.slice(start + 1, end);

// minimal host
const mem = {};
const localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
};
const _lsParse = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
const currentCase = { id: 'C1' };
const modules = [];
const ensureCaseModule = m => modules.push(m);

const api = new Function('localStorage', '_lsParse', 'currentCase', 'ensureCaseModule',
    block + '\nreturn { _rmsExpandReport, _rmsRouteOrder, _rmsDocKey, _rmsUpsertImport, _rmsMergePopulated, _rmsTabFor, _rmsFillBlanks, routeRmsPersonsToTabs };'
)(localStorage, _lsParse, currentCase, ensureCaseModule);

const tab = t => _lsParse(`${t}_C1`, []);
const reset = () => { for (const k of Object.keys(mem)) delete mem[k]; };

function person(o) {
    return Object.assign({ involvement: 'OTHER', name: '', dob: '', address: '', phone: '', sex: '', race: '',
        dl: '', dlState: '', ssn: '', sourcePage: '1', rmsKey: '' }, o);
}
function doc(kind, o) {
    return Object.assign({ reportNumber: '990000001', fileName: 'packet.pdf', supplementNo: '',
        personsInvolved: [], vehicles: [], offenses: [], narratives: [], location: '',
        fw: { kind: kind, documentNo: '', reportingOfficer: 'Officer A' } }, o);
}

console.log('\n── packet expansion / order');
const off = doc('offense', { splitIndex: 1 });
const arr = doc('arrest', { splitIndex: 0, fw: { kind: 'arrest', documentNo: 'A0000001', reportingOfficer: 'Officer B' } });
const sup = doc('supplement', { splitIndex: 2, supplementNo: '001' });
const head = Object.assign({}, arr, { splitReports: [arr, off, sup] });
ok('a packet expands into its documents', api._rmsExpandReport(head).length === 3);
ok('a single report stays itself', api._rmsExpandReport(off).length === 1 && api._rmsExpandReport(off)[0] === off);
ok('null → []', api._rmsExpandReport(null).length === 0);
const ord = api._rmsRouteOrder([arr, off, sup]);
ok('offense report routes first', ord[0] === off && ord.length === 3);
ok('others keep their order', ord[1] === arr && ord[2] === sup);

console.log('\n── duplicate detection');
const list = [];
api._rmsUpsertImport(list, arr); api._rmsUpsertImport(list, off); api._rmsUpsertImport(list, sup);
ok('three documents of one packet are three imports', list.length === 3, list.length);
const supAlone = Object.assign({}, sup, { fileName: 'supp1.pdf', splitIndex: undefined });
api._rmsUpsertImport(list, supAlone);
ok('the same supplement imported on its own replaces the packet copy', list.length === 3 && list.indexOf(supAlone) !== -1);
const addendum = doc('officer', { fw: { kind: 'officer', documentNo: 'OE0000001', reportingOfficer: 'Officer C' } });
const addendum2 = doc('officer', { fw: { kind: 'officer', documentNo: 'OE0000001', reportingOfficer: 'Officer D' } });
api._rmsUpsertImport(list, addendum); api._rmsUpsertImport(list, addendum2);
ok('two officers on one OE number are two documents', list.length === 5, list.length);
const legacy = [{ reportNumber: '5', fileName: 'x.pdf' }];
api._rmsUpsertImport(legacy, { reportNumber: '5', fileName: 'x.pdf', v: 2 });
ok('non-Fort-Worth reports keep the old rule (number + file)', legacy.length === 1 && legacy[0].v === 2);
api._rmsUpsertImport(legacy, { reportNumber: '6', fileName: 'x.pdf' });
ok('a different number is a new import', legacy.length === 2);

console.log('\n── kept source PDF on re-import');
const kept = [{ reportNumber: '7', fileName: 'y.pdf', sourceFile: { kind: 'rmsReports', fileName: 'y.pdf', sha256: 'aa' } }];
api._rmsUpsertImport(kept, { reportNumber: '7', fileName: 'y.pdf', v: 2 });
ok('a re-import whose copy failed keeps the earlier PDF link', kept.length === 1 && kept[0].v === 2 &&
    kept[0].sourceFile && kept[0].sourceFile.sha256 === 'aa', kept[0]);
api._rmsUpsertImport(kept, { reportNumber: '7', fileName: 'y.pdf', v: 3, sourceFile: { kind: 'rmsReports', fileName: 'y (1).pdf', sha256: 'bb' } });
ok('a re-import with its own copy uses that copy', kept[0].v === 3 && kept[0].sourceFile.sha256 === 'bb');
const fresh = [];
api._rmsUpsertImport(fresh, { reportNumber: '8', fileName: 'z.pdf' });
ok('a new import without a copy gets none', fresh.length === 1 && !fresh[0].sourceFile);
const pk = [doc('supplement', { splitIndex: 3, supplementNo: '001', fileName: 'packet.pdf', sourceFile: { kind: 'rmsReports', fileName: 'packet.pdf', sha256: 'cc' } })];
api._rmsUpsertImport(pk, doc('supplement', { supplementNo: '001', fileName: 'supp-only.pdf' }));
ok('the same document from a different file does not borrow the packet PDF', pk.length === 1 &&
    pk[0].fileName === 'supp-only.pdf' && !pk[0].sourceFile, pk[0].sourceFile);

console.log('\n── populated merge');
const m = api._rmsMergePopulated(['Suspects (2)', 'Victims (1)', 'Suspects (1)', 'RMS Imports']);
ok('counts summed per tab', m[0] === 'Suspects (3)' && m[1] === 'Victims (1)' && m[2] === 'RMS Imports', m);

console.log('\n── tab choice');
ok('arrested → suspects', api._rmsTabFor('ARRESTED') === 'suspects');
ok('victim → victims', api._rmsTabFor('VICTIM') === 'victims');
ok("victim's parent → involved", api._rmsTabFor("VICTIM'S PARENT") === 'involvedPersons');
ok('witness → witnesses', api._rmsTabFor('WITNESS') === 'witnesses');
ok('other → involved', api._rmsTabFor('OTHER') === 'involvedPersons');

console.log('\n── fill blanks');
const tgt = { name: 'DOE, JANE', dob: '', address: '1 SYNTHETIC ST' };
const n = api._rmsFillBlanks(tgt, { name: 'X', dob: '01/02/1990', address: '2 OTHER ST', rmsSource: 'z' });
ok('only blanks filled', n === 1 && tgt.dob === '01/02/1990' && tgt.name === 'DOE, JANE' && tgt.address === '1 SYNTHETIC ST', tgt);
ok('rmsSource never copied by fill', tgt.rmsSource === undefined);

console.log('\n── routing a packet: one person per key');
reset();
const KEY = 'SAMPLE ALEX|01/02/1990';
const offR = doc('offense', { personsInvolved: [
    person({ involvement: 'SUSPECT', name: 'SAMPLE, ALEX', dob: '01/02/1990', address: '10 SYNTHETIC AVE', rmsKey: KEY }),
    person({ involvement: 'VICTIM', name: 'EXAMPLE, BO', dob: '03/04/1985', rmsKey: 'EXAMPLE BO|03/04/1985' })
]});
const supR = doc('supplement', { supplementNo: '001', personsInvolved: [
    person({ involvement: 'OTHER', name: 'Sample, Alex', dob: '01/02/1990', phone: '555-010-0199', dl: '99999999', dlState: 'TX', sourcePage: '2', rmsKey: KEY }),
    person({ involvement: 'OTHER', name: 'Witness, Cy', dob: '05/06/2001', rmsKey: 'WITNESS CY|05/06/2001' })
]});
let p1 = api.routeRmsPersonsToTabs(offR);
let p2 = api.routeRmsPersonsToTabs(supR);
ok('suspect filed once', tab('suspects').length === 1, tab('suspects'));
ok('suspect carries rmsKey', tab('suspects')[0].rmsKey === KEY);
ok('supplement filled the blank phone', tab('suspects')[0].phone === '555-010-0199', tab('suspects')[0]);
ok('supplement filled the blank licence', tab('suspects')[0].dlNumber === '99999999' && tab('suspects')[0].dlState === 'TX');
ok('existing address kept', tab('suspects')[0].address === '10 SYNTHETIC AVE');
ok('phone added as an identifier', (tab('suspects')[0].identifiers || []).some(i => i.type === 'phone' && i.value === '555-010-0199'));
ok('not also filed under Involved Persons', !tab('involvedPersons').some(p => p.rmsKey === KEY));
ok('a new person from the supplement is filed', tab('involvedPersons').some(p => p.rmsKey === 'WITNESS CY|05/06/2001'));
ok('router reports the update', p2.some(s => /^Updated persons \(1\)$/.test(s)), p2);
api.routeRmsPersonsToTabs(supR);
ok('re-import adds nobody', tab('suspects').length === 1 && tab('involvedPersons').length === 1);

console.log('\n── involved → stronger role moves (RMS-made, unannotated)');
reset();
api.routeRmsPersonsToTabs(supR);
ok('first filed under Involved', tab('involvedPersons').some(p => p.rmsKey === KEY));
api.routeRmsPersonsToTabs(offR);
ok('moved to Suspects', tab('suspects').some(p => p.rmsKey === KEY));
ok('removed from Involved', !tab('involvedPersons').some(p => p.rmsKey === KEY));
ok('carried the earlier phone', tab('suspects')[0].phone === '555-010-0199', tab('suspects')[0]);
reset();
api.routeRmsPersonsToTabs(supR);
const inv = tab('involvedPersons'); inv.forEach(p => { if (p.rmsKey === KEY) p.notes = 'investigator note'; });
localStorage.setItem('involvedPersons_C1', JSON.stringify(inv));
api.routeRmsPersonsToTabs(offR);
ok('an annotated record is not moved', tab('involvedPersons').some(p => p.rmsKey === KEY && p.notes === 'investigator note'));
ok('…and not duplicated into Suspects', !tab('suspects').some(p => p.rmsKey === KEY));

console.log('\n── persons without a key keep the old behaviour');
reset();
const nk = doc('offense', { personsInvolved: [person({ involvement: 'SUSPECT', name: 'NOKEY, PAT' })] });
api.routeRmsPersonsToTabs(nk);
api.routeRmsPersonsToTabs(Object.assign({}, nk, { reportNumber: '990000002' }));
ok('different source → filed again (unchanged rule)', tab('suspects').length === 2);

console.log('\n── vehicles across documents');
reset();
const v1 = { year: '2010', make: 'SYNTHMAKE', model: 'Model1', license: 'ZZZ0000', state: 'TX', vin: '1SYNTHETICVIN0001', colors: 'Silver', status: 'IMPOUNDED', involvement: 'Evidence' };
api.routeRmsPersonsToTabs(doc('offense', { vehicles: [v1] }));
const p3 = api.routeRmsPersonsToTabs(doc('supplement', { reportNumber: '990000003', vehicles: [Object.assign({}, v1, { model: 'Model1 4D', notes: 'Towed by SAMPLE WRECKER' })] }));
const vs = tab('recoveredVehicles');
ok('same VIN filed once', vs.length === 1, vs.length);
ok('notes carry status + involvement', /Status: IMPOUNDED/.test(vs[0].notes) && /Involvement: Evidence/.test(vs[0].notes), vs[0].notes);
ok('no vehicle count when nothing new was filed', !p3.some(s => /^Vehicles/.test(s)), p3);
api.routeRmsPersonsToTabs(doc('supplement', { reportNumber: '990000004', vehicles: [{ year: '2001', make: 'OTHER', model: 'X', license: 'AAA1111', vin: '' }] }));
ok('a different vehicle is filed', tab('recoveredVehicles').length === 2);

console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
