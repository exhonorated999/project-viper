'use strict';
// Tests for modules/case-forms/form-set.js. Every PDF and set here is SYNTHETIC.
// Run: node modules/case-forms/__tests__/form-set.test.js
const AdmZip = require('adm-zip');
const { PDFDocument } = require('pdf-lib');
const S = require('../form-set.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
function throws(fn, re, label) {
  try { fn(); ok(false, label + ' — did not throw'); } catch (e) {
    ok(e instanceof S.FormSetError && re.test(e.message), label + ' — wrong error: ' + e.message);
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

async function pdfWith(fieldNames) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  fieldNames.forEach((n, i) => form.createTextField(n).addToPage(page, { x: 50, y: 700 - i * 30, width: 200, height: 18 }));
  return Buffer.from(await doc.save());
}

(async () => {
  const pdfA = await pdfWith(['Case Number', 'Last Name', 'Date']);
  const pdfB = await pdfWith(['Plate', 'Officer']);
  const input = {
    id: 'sample-pd',
    name: 'Sample PD forms',
    agency: 'Sample Police Department',
    version: '1.0.0',
    createdAt: '2026-11-24T00:00:00.000Z',
    forms: [
      {
        id: 'advisement-adult', title: 'Advisement (adult)', category: 'Interview', language: 'en', group: 'advisement',
        slots: [{ id: 'subject', label: 'Subject', roles: ['suspect'] }],
        bindings: {
          'Case Number': { src: 'case.number' },
          'Last Name': { src: 'person.lastName', slot: 'subject', upper: true },
          Date: { src: 'now.date', fmt: 'long' },
        },
        pdf: pdfA,
      },
      {
        id: 'vehicle-hold', title: 'Vehicle hold', category: 'Property', flatten: true,
        vehicleSlots: [{ id: 'vehicle', label: 'Vehicle' }],
        bindings: { Plate: { src: 'vehicle.plate', slot: 'vehicle' }, Officer: { src: 'const', value: 'Records' } },
        pdf: pdfB,
      },
    ],
  };

  // ---- build + read round trip ---------------------------------------------------------------
  const built = S.buildFormSetBuffer(input);
  ok(Buffer.isBuffer(built.buffer), 'build: returns a buffer');
  eq(built.manifest.forms.map(f => f.file), ['forms/advisement-adult.pdf', 'forms/vehicle-hold.pdf'], 'build: file names from ids');
  eq(built.manifest.forms[0].sha256, S.sha256(pdfA), 'build: checksum');
  eq(built.manifest.forms[1].flatten, true, 'build: flatten kept');
  ok(!('category' in built.manifest.forms[1]) || built.manifest.forms[1].category === 'Property', 'build: optional fields kept when set');
  ok(!('language' in built.manifest.forms[1]), 'build: unset optional fields left out');

  const read = S.readFormSetBuffer(built.buffer);
  eq(read.manifest, built.manifest, 'read: manifest round trip');
  ok(read.pdfs.get('advisement-adult').equals(pdfA) && read.pdfs.get('vehicle-hold').equals(pdfB), 'read: PDFs byte-identical');

  const sum = S.summarize(read.manifest, { enabled: true });
  eq([sum.id, sum.formCount, sum.languages, sum.categories, sum.enabled], ['sample-pd', 2, ['en'], { Interview: 1, Property: 1 }, true], 'summarize');
  eq(S.compareVersions('1.0.10', '1.0.9'), 1, 'compareVersions re-exported');

  // ---- damaged / hostile files ---------------------------------------------------------------
  const rezip = (mutate) => {
    const z = new AdmZip(built.buffer);
    mutate(z);
    return z.toBuffer();
  };
  throws(() => S.readFormSetBuffer(Buffer.alloc(0)), /empty or damaged/, 'read: empty');
  throws(() => S.readFormSetBuffer(Buffer.from('not a zip at all, definitely not a zip')), /damaged|not a form set/, 'read: not a zip');
  throws(() => S.readFormSetBuffer(rezip(z => z.updateFile('forms/vehicle-hold.pdf', Buffer.concat([pdfB, Buffer.from(' ')])))), /Checksum mismatch/, 'read: altered PDF');
  throws(() => S.readFormSetBuffer(rezip(z => z.addFile('forms/extra.pdf', pdfA))), /not listed/, 'read: unlisted PDF');
  throws(() => S.readFormSetBuffer(rezip(z => z.addFile('notes.txt', Buffer.from('x')))), /Unexpected file/, 'read: unexpected file');
  throws(() => S.readFormSetBuffer(rezip(z => z.addFile('forms/Upper.pdf', pdfA))), /Unexpected file/, 'read: name outside the id pattern');
  throws(() => S.readFormSetBuffer(rezip(z => z.deleteFile('manifest.json'))), /no manifest/, 'read: no manifest');
  throws(() => S.readFormSetBuffer(rezip(z => z.deleteFile('forms/vehicle-hold.pdf'))), /missing/, 'read: listed PDF missing');
  throws(() => S.readFormSetBuffer(rezip(z => z.updateFile('manifest.json', Buffer.from('{oops')))), /not valid JSON/, 'read: broken manifest');
  {
    const m = clone(built.manifest);
    m.forms[0].sha256 = S.sha256(pdfB);
    throws(() => S.readFormSetBuffer(rezip(z => z.updateFile('manifest.json', Buffer.from(JSON.stringify(m))))), /Checksum mismatch/, 'read: manifest checksum swapped');
  }
  {
    const fake = Buffer.from('PK not really a pdf');
    const m = clone(built.manifest);
    m.forms[1].sha256 = S.sha256(fake);
    const buf = rezip(z => { z.updateFile('forms/vehicle-hold.pdf', fake); z.updateFile('manifest.json', Buffer.from(JSON.stringify(m))); });
    throws(() => S.readFormSetBuffer(buf), /Not a PDF/, 'read: non-PDF with a matching checksum');
  }

  // ---- manifest validation -------------------------------------------------------------------
  const M = () => clone(built.manifest);
  const bad = (edit, re, label) => { const m = M(); edit(m); throws(() => S.validateManifest(m), re, label); };
  ok(S.validateManifest(M()) && true, 'validate: built manifest is valid');
  bad(m => { m.format = 'viper-agency-pack'; }, /Not a VIPER form set/, 'validate: wrong format');
  bad(m => { m.formatVersion = 2; }, /not supported/, 'validate: future format');
  bad(m => { m.id = 'Bad Id'; }, /id/, 'validate: set id');
  bad(m => { m.name = ' '; }, /name/, 'validate: name');
  bad(m => { m.version = ''; }, /version/, 'validate: version');
  bad(m => { m.forms = []; }, /no forms/, 'validate: no forms');
  bad(m => { m.forms[1].id = m.forms[0].id; m.forms[1].file = m.forms[0].file; }, /used twice/, 'validate: duplicate form id');
  bad(m => { m.forms[0].file = 'forms/../x.pdf'; }, /file must be/, 'validate: file path tied to id');
  bad(m => { m.forms[0].language = 'english'; }, /language/, 'validate: language code');
  bad(m => { m.forms[0].flatten = 'yes'; }, /flatten/, 'validate: flatten type');
  bad(m => { m.forms[0].slots.push({ id: 'subject', label: 'Again' }); }, /listed twice/, 'validate: duplicate slot');
  bad(m => { m.forms[0].slots[0].roles = ['judge']; }, /unknown roles/, 'validate: slot roles');
  bad(m => { m.forms[1].vehicleSlots.push({ id: 'vehicle2' }); }, /needs a label/, 'validate: slot label');
  bad(m => { m.forms[0].vehicleSlots = [{ id: 'subject', label: 'Car' }]; }, /both a person and a vehicle/, 'validate: slot id clash');

  const binding = (b, re, label) => bad(m => { m.forms[0].bindings['Case Number'] = b; }, re, label);
  binding({ src: 'case.nothing' }, /unknown source/, 'binding: unknown source');
  binding({ src: 'person.lastName' }, /person slot/, 'binding: person source without slot');
  binding({ src: 'person.lastName', slot: 'guardian' }, /person slot/, 'binding: slot not declared');
  binding({ src: 'vehicle.vin', slot: 'subject' }, /vehicle slot/, 'binding: vehicle source on a person slot');
  binding({ src: 'case.number', slot: 'subject' }, /does not take a slot/, 'binding: slot on a case source');
  binding({ src: 'case.number', fmt: 'long' }, /date format/, 'binding: date format on text');
  binding({ src: 'now.date', fmt: 'DD.MM.YYYY' }, /date format/, 'binding: unknown date format');
  binding({ src: 'now.time', fmt: 'MM/DD/YYYY' }, /time format/, 'binding: date format on a time');
  binding({ src: 'now.date', timeFmt: 'HHmm' }, /time format/, 'binding: time format on a date');
  binding({ src: 'case.number', upper: 'yes' }, /upper/, 'binding: upper type');
  binding({ src: 'case.number', script: 'x' }, /unknown setting/, 'binding: unknown key');
  binding({ src: 'case.number', value: 'x' }, /only fixed values/, 'binding: value on a source');
  binding({ src: 'const', value: 5 }, /fixed value/, 'binding: const must be text or boolean');
  binding('case.number', /not an object/, 'binding: not an object');
  const good = (b, label) => { const m = M(); m.forms[0].bindings['Case Number'] = b; try { S.validateManifest(m); ok(true, label); } catch (e) { ok(false, label + ' — ' + e.message); } };
  good({ src: 'ask' }, 'binding: ask');
  good({ src: 'const', value: true }, 'binding: const checkbox');
  good({ src: 'now.time', fmt: 'h:mm A' }, 'binding: time with fmt');
  good({ src: 'now.dateTime', fmt: 'YYYY-MM-DD', timeFmt: 'HHmm' }, 'binding: date-time with both');
  good({ src: 'person.dob', slot: 'subject', fmt: 'M/D/YYYY' }, 'binding: person date');

  // ---- build refuses what would not load -----------------------------------------------------
  const tweak = (fn) => { const i = Object.assign({}, input, { forms: input.forms.map(f => Object.assign({}, f)) }); fn(i); return i; };
  throws(() => S.buildFormSetBuffer(tweak(i => { i.forms[0].pdf = Buffer.from('hello'); })), /not a PDF/, 'build: non-PDF refused');
  throws(() => S.buildFormSetBuffer(tweak(i => { i.forms = []; })), /no forms/, 'build: no forms');
  throws(() => S.buildFormSetBuffer(tweak(i => { i.forms[0].bindings = { X: { src: 'person.age' } }; })), /person slot/, 'build: bad binding refused');
  throws(() => S.buildFormSetBuffer(tweak(i => { i.forms[0].id = 'Bad'; })), /id must be/, 'build: bad form id');

  console.log(`case-forms form-set: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
