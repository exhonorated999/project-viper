'use strict';
// Tests for modules/case-forms/pdf-form.js. Every PDF is generated here (SYNTHETIC).
// Run: node modules/case-forms/__tests__/pdf-form.test.js
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const PF = require('../pdf-form.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
async function rejects(p, re, label) {
  try { await p; ok(false, label + ' — did not throw'); } catch (e) { ok(re.test(e.message), label + ' — wrong error: ' + e.message); }
}

// A two-page form, fields created OUT of reading order on purpose.
async function makeForm() {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  const text = (name, page, x, y, w, extra) => {
    const f = form.createTextField(name);
    if (extra && extra.max) f.setMaxLength(extra.max);
    if (extra && extra.multi) f.enableMultiline();
    f.addToPage(page, { x, y, width: w || 150, height: 18 });
    return f;
  };
  text('Page Two Box', p2, 50, 700);
  text('First Name', p1, 300, 652);
  text('Case Number', p1, 400, 720);
  text('Last Name', p1, 50, 650);
  text('Short', p1, 50, 560, 60, { max: 4 });
  text('Notes', p1, 50, 400, 400, { multi: true });
  const cb = form.createCheckBox('Agree');
  cb.addToPage(p1, { x: 50, y: 600, width: 12, height: 12 });
  const dd = form.createDropdown('Choice');
  dd.addOptions(['Yes', 'No']);
  dd.addToPage(p1, { x: 200, y: 600, width: 80, height: 18 });
  const rg = form.createRadioGroup('Pick');
  rg.addOptionToPage('alpha', p1, { x: 300, y: 600, width: 12, height: 12 });
  rg.addOptionToPage('beta', p1, { x: 330, y: 600, width: 12, height: 12 });
  return doc;
}

// Turn field `name`'s only widget into a STANDALONE field object with the same name and put
// it on the page in place of the original widget — the original stays in /AcroForm /Fields
// but is no longer drawn (what some editors leave behind after re-saving).
function orphanField(doc, name) {
  const field = doc.getForm().getField(name);
  const w = field.acroField.getWidgets()[0];
  const wRef = doc.context.getObjectRef(w.dict);
  const clone = w.dict.clone(doc.context);
  clone.delete(PDFName.of('Parent'));
  clone.set(PDFName.of('T'), PDFString.of(name));
  clone.set(PDFName.of('FT'), PDFName.of('Tx'));
  const cloneRef = doc.context.register(clone);
  const page = doc.getPages()[0];
  const annots = page.node.lookup(PDFName.of('Annots'));
  for (let i = 0; i < annots.size(); i++) if (String(annots.get(i)) === String(wRef)) annots.set(i, cloneRef);
  return cloneRef;
}

// Add a SECOND top-level field with the same name as `name`, on the page and in /Fields.
function duplicateField(doc, name, dy) {
  const field = doc.getForm().getField(name);
  const w = field.acroField.getWidgets()[0];
  const clone = w.dict.clone(doc.context);
  clone.delete(PDFName.of('Parent'));
  clone.set(PDFName.of('T'), PDFString.of(name));
  clone.set(PDFName.of('FT'), PDFName.of('Tx'));
  const r = w.getRectangle();
  clone.set(PDFName.of('Rect'), doc.context.obj([r.x, r.y - dy, r.x + r.width, r.y - dy + r.height]));
  const ref = doc.context.register(clone);
  doc.getPages()[0].node.lookup(PDFName.of('Annots')).push(ref);
  doc.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields')).push(ref);
  return ref;
}

const vOf = (dict) => { const v = dict.lookup(PDFName.of('V')); return v && v.decodeText ? v.decodeText() : String(v); };

(async () => {
  const bytes = Buffer.from(await (await makeForm()).save());

  // ---- inspect ---------------------------------------------------------------------------------
  const info = await PF.inspect(bytes);
  eq(info.pageCount, 2, 'inspect: page count');
  eq(info.pages[0], { width: 612, height: 792, rotation: 0 }, 'inspect: page size');
  eq(info.fields.map(f => f.name), ['Case Number', 'Last Name', 'First Name', 'Agree', 'Choice', 'Pick', 'Short', 'Notes', 'Page Two Box'],
    'inspect: reading order (rows within 4pt join, left to right, page 2 last)');
  const by = Object.fromEntries(info.fields.map(f => [f.name, f]));
  eq(['Case Number', 'Agree', 'Choice', 'Pick'].map(n => by[n].type), ['text', 'checkbox', 'dropdown', 'radio'], 'inspect: types');
  eq(by['Page Two Box'].page, 1, 'inspect: page index of page-2 field');
  ok(by['Case Number'].rect.every((v, i) => Math.abs(v - [400, 720, 150, 18][i]) <= 1), 'inspect: rect x,y,w,h (pdf-lib pads by the border)');
  eq(by.Short.maxLength, 4, 'inspect: maxLength');
  eq(by.Notes.multiline, true, 'inspect: multiline');
  eq(by.Choice.options, ['Yes', 'No'], 'inspect: dropdown options');
  eq(by.Pick.options, ['alpha', 'beta'], 'inspect: radio options');
  eq(by.Pick.widgets.length, 2, 'inspect: radio has two boxes');
  eq(info.repaired, 0, 'inspect: consistent form is not repaired');

  // A tall box must not swallow the rows beside it.
  {
    const d = await PDFDocument.create();
    const pg = d.addPage([612, 792]);
    const fm = d.getForm();
    const add = (n, x, y, w, h) => fm.createTextField(n).addToPage(pg, { x, y, width: w, height: h });
    add('Right B', 300, 640, 150, 18);
    add('Big Left', 50, 600, 200, 100);
    add('Right A', 300, 680, 150, 18);
    add('Right C', 300, 600, 150, 18);
    const order = (await PF.inspect(Buffer.from(await d.save()))).fields.map(f => f.name);
    eq(order, ['Big Left', 'Right A', 'Right B', 'Right C'], 'inspect: column beside a tall box stays top-down');
  }

  const blank = Buffer.from(await (async () => { const d = await PDFDocument.create(); d.addPage(); return d.save(); })());
  eq((await PF.inspect(blank)).fields, [], 'inspect: PDF without a form has no fields');
  await rejects(PF.inspect(Buffer.alloc(0)), /Empty PDF/, 'inspect: empty input');
  await rejects(PF.inspect(Buffer.alloc(PF.MAX_PDF_BYTES + 1)), /larger than/, 'inspect: size cap');

  // ---- fill ------------------------------------------------------------------------------------
  const r = await PF.fill(bytes, {
    'Case Number': '26-0001',
    'Last Name': 'Núñez ¿Sí?',
    'First Name': 'Ann\u4e00e',
    Short: 'ABCDEFG',
    Notes: 'line one\nline two',
    Agree: 'yes',
    Choice: 'no',
    Pick: 'gamma',
    'Not Here': 'x',
  });
  eq(r.filled, ['Case Number', 'Last Name', 'First Name', 'Short', 'Notes', 'Agree', 'Choice'], 'fill: filled list');
  eq(r.warnings.map(w => w.field + ':' + w.code), ['First Name:chars', 'Short:truncated', 'Pick:option', 'Not Here:missing'], 'fill: warnings');
  const out = (await PDFDocument.load(r.bytes)).getForm();
  eq(out.getTextField('Case Number').getText(), '26-0001', 'fill: text round trip');
  eq(out.getTextField('Last Name').getText(), 'Núñez ¿Sí?', 'fill: Spanish characters kept');
  eq(out.getTextField('First Name').getText(), 'Ann?e', 'fill: unprintable character replaced');
  eq(out.getTextField('Short').getText(), 'ABCD', 'fill: cut to maxLength');
  eq(out.getTextField('Notes').getText(), 'line one\nline two', 'fill: multiline keeps line breaks');
  eq(out.getCheckBox('Agree').isChecked(), true, 'fill: checkbox checked');
  eq(out.getDropdown('Choice').getSelected(), ['No'], 'fill: dropdown matched case-insensitively');
  eq(out.getRadioGroup('Pick').getSelected(), undefined, 'fill: bad radio choice left alone');

  const r2 = await PF.fill(bytes, { 'Case Number': 'a\nb', Agree: 'no', Pick: 'beta' });
  const out2 = (await PDFDocument.load(r2.bytes)).getForm();
  eq(out2.getTextField('Case Number').getText(), 'a b', 'fill: single-line box flattens line breaks');
  eq(out2.getCheckBox('Agree').isChecked(), false, 'fill: "no" unchecks');
  eq(out2.getRadioGroup('Pick').getSelected(), 'beta', 'fill: radio choice');
  eq(r2.warnings, [], 'fill: no warnings');

  const flat = await PF.fill(bytes, { 'Case Number': '26-0002' }, { flatten: true });
  eq((await PDFDocument.load(flat.bytes)).getForm().getFields().length, 0, 'fill: flatten removes the fields');
  eq(flat.warnings, [], 'fill: flatten without warnings');

  // ---- stale /Fields copies (the page draws different widgets) ---------------------------------
  {
    const doc = await makeForm();
    doc.getForm().getTextField('Case Number').setText('OLD');
    const cloneRef = orphanField(doc, 'Case Number');
    const sb = Buffer.from(await doc.save());
    const si = await PF.inspect(sb);
    eq(si.repaired, 2, 'repair: stale entry dropped, on-page field added');
    eq(si.fields.filter(f => f.name === 'Case Number').length, 1, 'repair: name listed once');
    const sf = await PF.fill(sb, { 'Case Number': 'NEW' });
    eq(sf.filled, ['Case Number'], 'repair: fill reports the field');
    const back = await PDFDocument.load(sf.bytes);
    const drawn = back.context.lookup(cloneRef);
    eq(vOf(drawn), 'NEW', 'repair: the widget on the page holds the value');
    ok(!!drawn.lookup(PDFName.of('AP')), 'repair: the widget on the page has an appearance');
    eq(back.getForm().getTextField('Case Number').getText(), 'NEW', 'repair: saved form reads back the value');
  }

  // ---- two separate fields sharing one name ----------------------------------------------------
  {
    const doc = await makeForm();
    const dupRef = duplicateField(doc, 'Last Name', 300);
    const db = Buffer.from(await doc.save());
    const di = await PF.inspect(db);
    const dups = di.fields.filter(f => f.name === 'Last Name');
    eq(dups.length, 1, 'duplicates: listed once');
    eq(dups[0].widgets.length, 2, 'duplicates: both boxes kept');
    const df = await PF.fill(db, { 'Last Name': 'Sample' });
    eq(df.filled, ['Last Name'], 'duplicates: filled once in the report');
    const back = await PDFDocument.load(df.bytes);
    eq(vOf(back.context.lookup(dupRef)), 'Sample', 'duplicates: second copy filled too');
    eq(back.getForm().getTextField('Last Name').getText(), 'Sample', 'duplicates: first copy filled');
  }

  console.log(`case-forms pdf-form: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
