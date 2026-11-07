'use strict';
// Tests for modules/agency-packs/docx-form-engine.js
// Run: node modules/agency-packs/__tests__/docx-form-engine.test.js
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');
const F = require('../docx-form-engine.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) { ok(a === b, label + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

// Helpers for building synthetic docx fixtures
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CUSTOM_XML_SCHEMA_URI = 'http://warrant-builder/schema';

function _parseXml(s) {
  const doc = new DOMParser().parseFromString(s, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('parse error');
  return doc;
}

function _el(doc, qname) { return doc.createElementNS(W_NS, qname); }

function makeDocx(opts) {
  opts = opts || {};
  const zip = new AdmZip();

  const documentXml = opts.documentXml || (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'
  );
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf-8'));

  const settingsXml = opts.settingsXml || (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="' + W_NS + '">' +
    '<w:zoom w:percent="100"/>' +
    '</w:settings>'
  );
  zip.addFile('word/settings.xml', Buffer.from(settingsXml, 'utf-8'));

  const numberingXml = opts.numberingXml || (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="' + W_NS + '">' +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  );
  zip.addFile('word/numbering.xml', Buffer.from(numberingXml, 'utf-8'));

  const relsXml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="' + RELS_NS + '">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="document.xml"/>' +
    '</Relationships>'
  );
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf-8'));

  const pkgRelsXml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="' + RELS_NS + '">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  );
  zip.addFile('_rels/.rels', Buffer.from(pkgRelsXml, 'utf-8'));

  const ctXml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  );
  zip.addFile('[Content_Types].xml', Buffer.from(ctXml, 'utf-8'));

  return zip.toBuffer();
}

function docXmlWithHighlight(fieldText, highlightVal) {
  const hl = highlightVal || 'yellow';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' +
    '<w:p><w:r>' +
    '<w:rPr><w:highlight w:val="' + hl + '"/></w:rPr>' +
    '<w:t>[' + fieldText + ']</w:t>' +
    '</w:r></w:p>' +
    '</w:body></w:document>'
  );
}

function docXmlWithSplitHighlight() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' +
    '<w:p>' +
    '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>[Case</w:t></w:r>' +
    '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t> Number]</w:t></w:r>' +
    '</w:p>' +
    '</w:body></w:document>'
  );
}

function docXmlWithDaSection() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' +
    '<w:p><w:r><w:t>Some text</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>APPROVED AS TO FORM:</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>DA signature</w:t></w:r></w:p>' +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

function findSdts(docXml) {
  const doc = _parseXml(docXml);
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 1 && node.namespaceURI === W_NS && node.localName === 'sdt') {
      const sdtPr = node.getElementsByTagNameNS(W_NS, 'sdtPr')[0];
      const tagEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'tag')[0] : null;
      const aliasEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'alias')[0] : null;
      const bindingEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'dataBinding')[0] : null;
      const dropDownEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'dropDownList')[0] : null;
      const textEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'text')[0] : null;
      const richTextEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'richText')[0] : null;
      const idEl = sdtPr ? sdtPr.getElementsByTagNameNS(W_NS, 'id')[0] : null;
      out.push({
        tag: tagEl ? tagEl.getAttributeNS(W_NS, 'val') : null,
        alias: aliasEl ? aliasEl.getAttributeNS(W_NS, 'val') : null,
        binding: bindingEl ? {
          storeItemID: bindingEl.getAttributeNS(W_NS, 'storeItemID'),
          prefixMappings: bindingEl.getAttributeNS(W_NS, 'prefixMappings'),
          xpath: bindingEl.getAttributeNS(W_NS, 'xpath'),
        } : null,
        hasDropDown: !!dropDownEl,
        hasText: !!textEl,
        hasRichText: !!richTextEl,
        id: idEl ? idEl.getAttributeNS(W_NS, 'val') : null,
      });
    }
    if (node.childNodes) for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  };
  walk(doc.documentElement);
  return out;
}

function findCustomXml(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().map(e => e.entryName);
  const items = entries.filter(n => /^customXml\/item\d+\.xml$/.test(n));
  const props = entries.filter(n => /^customXml\/itemProps\d+\.xml$/.test(n));
  const rels = entries.filter(n => /^customXml\/_rels\/item\d+\.xml\.rels$/.test(n));
  const ct = zip.readAsText('[Content_Types].xml');
  const hasCtOverride = ct.includes('customXmlProperties+xml');
  return { items, props, rels, hasCtOverride, entries };
}

function readStory(buf, name) {
  const zip = new AdmZip(buf);
  return zip.readAsText(name);
}

// ================================================================================
// Tests
// ================================================================================

// 1. Basic placeholder → sdt with tag, alias, dataBinding
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Case Number') });
  const out = F.convertDocx(docx, { 'Case Number': { title: 'Case Number', tag: 'Case_Number' } }, { protect: false });
  const story = readStory(out, 'word/document.xml');
  const sdts = findSdts(story);
  eq(sdts.length, 1, 'basic: one sdt');
  eq(sdts[0].tag, 'Case_Number', 'basic: tag');
  eq(sdts[0].alias, 'Case Number', 'basic: alias');
  ok(sdts[0].binding, 'basic: has binding');
  ok(sdts[0].binding.xpath.includes('/ns0:root[1]/ns0:Case_Number[1]'), 'basic: xpath');
  ok(sdts[0].binding.prefixMappings.includes(CUSTOM_XML_SCHEMA_URI), 'basic: prefixMappings');
  ok(sdts[0].binding.storeItemID, 'basic: storeItemID');
}

// 2. Value seeding
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Case Number') });
  const out = F.convertDocx(docx, { 'Case Number': { title: 'Case Number', tag: 'Case_Number' } }, { protect: false, values: { 'Case Number': '2024-001' } });
  const story = readStory(out, 'word/document.xml');
  ok(story.includes('2024-001'), 'value seeding: run text');
  const cx = findCustomXml(out);
  eq(cx.items.length, 1, 'value seeding: one customXml item');
  const itemXml = new AdmZip(out).readAsText(cx.items[0]);
  ok(itemXml.includes('>2024-001<'), 'value seeding: customXml text');
}

// 3. CustomXml parts + Content_Types overrides
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Field') });
  const out = F.convertDocx(docx, { 'Field': { title: 'Field', tag: 'Field' } }, { protect: false });
  const cx = findCustomXml(out);
  eq(cx.items.length, 1, 'customXml: item');
  eq(cx.props.length, 1, 'customXml: props');
  eq(cx.rels.length, 1, 'customXml: rels');
  ok(cx.hasCtOverride, 'customXml: Content_Types override');
  const relsXml = new AdmZip(out).readAsText(cx.rels[0]);
  ok(relsXml.includes('customXmlProps'), 'customXml: rels type');
}

// 4. Protection true/false
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Field') });
  const outProtected = F.convertDocx(docx, { 'Field': { title: 'Field', tag: 'Field' } }, { protect: true });
  const settingsP = readStory(outProtected, 'word/settings.xml');
  ok(settingsP.includes('w:edit="forms"'), 'protect true: has forms restriction');

  const outUnprotected = F.convertDocx(docx, { 'Field': { title: 'Field', tag: 'Field' } }, { protect: false });
  const settingsU = readStory(outUnprotected, 'word/settings.xml');
  ok(!settingsU.includes('w:edit="forms"'), 'protect false: no forms restriction');
}

// 5. Dropdown
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Chief/Senior') });
  const out = F.convertDocx(docx, { 'Chief/Senior': { title: 'Chief/Senior', tag: 'Chief_Senior', type: 'dropdown', choices: ['Chief', 'Senior'] } }, { protect: false });
  const story = readStory(out, 'word/document.xml');
  const sdts = findSdts(story);
  eq(sdts.length, 1, 'dropdown: one sdt');
  ok(sdts[0].hasDropDown, 'dropdown: has dropDownList');
  ok(!sdts[0].hasText, 'dropdown: no text element');
}

// 6. Multi-line value
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Background') });
  const out = F.convertDocx(docx, { 'Background': { title: 'Background', tag: 'Background' } }, { protect: false, values: { 'Background': 'Line one\nLine two' } });
  const story = readStory(out, 'word/document.xml');
  ok(story.includes('w:br'), 'multiline: has br element');
}

// 7. Split-across-runs bracket
{
  const docx = makeDocx({ documentXml: docXmlWithSplitHighlight() });
  const out = F.convertDocx(docx, { 'Case Number': { title: 'Case Number', tag: 'Case_Number' } }, { protect: false });
  const story = readStory(out, 'word/document.xml');
  const sdts = findSdts(story);
  eq(sdts.length, 1, 'split: one sdt');
  eq(sdts[0].tag, 'Case_Number', 'split: tag');
}

// 8. Rich-text block (paragraph, bullet, number, table, image)
{
  const docXml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' +
    '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>[PC Statement]</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  );
  const docx = makeDocx({ documentXml: docXml });
  // Tiny 1x1 PNG data URL
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const rtBlocks = [
    { type: 'paragraph', runs: [{ text: 'Bold run', bold: true }, { break: true }, { text: 'Italic run', italic: true }, { text: 'Underline run', underline: true }] },
    { type: 'bullet', runs: [{ text: 'Bullet item' }] },
    { type: 'number', runs: [{ text: 'Numbered item' }] },
    { type: 'table', rows: [[{ runs: [{ text: 'Cell 1', fontSizePt: 10 }] }, { runs: [{ text: 'Cell 2' }] }]] },
    { type: 'paragraph', runs: [{ image: tinyPng }] },
  ];
  const out = F.convertDocx(docx, { 'PC Statement': { title: 'PC Statement', tag: 'PC_Statement' } }, {
    protect: false,
    richtextBlocks: { 'PC Statement': rtBlocks }
  });
  const story = readStory(out, 'word/document.xml');
  const sdts = findSdts(story);
  eq(sdts.length, 1, 'richtext: one sdt');
  ok(sdts[0].hasRichText, 'richtext: has richText');
  ok(!sdts[0].hasText, 'richtext: no text element');
  ok(!sdts[0].binding, 'richtext: no dataBinding');

  // Check list numPr
  ok(story.includes('w:numPr'), 'richtext: has numPr');
  ok(story.includes('w:numId'), 'richtext: has numId');

  // Check table
  ok(story.includes('w:tbl'), 'richtext: has table');
  ok(story.includes('w:tblBorders'), 'richtext: has table borders');

  // Check image part + rel + content type
  const zip = new AdmZip(out);
  const entries = zip.getEntries().map(e => e.entryName);
  ok(entries.some(n => n.startsWith('word/media/image')), 'richtext: image part exists');
  const rels = zip.readAsText('word/_rels/document.xml.rels');
  ok(rels.includes('image'), 'richtext: image rel exists');
  const ct = zip.readAsText('[Content_Types].xml');
  ok(ct.includes('image/png'), 'richtext: image content type');
}

// 9. DA strip
{
  const docx = makeDocx({ documentXml: docXmlWithDaSection() });
  const out = F.convertDocx(docx, {}, { protect: false, removeDaApprovalSection: true });
  const story = readStory(out, 'word/document.xml');
  ok(!story.includes('APPROVED AS TO FORM'), 'da strip: marker removed');
  ok(!story.includes('DA signature'), 'da strip: content removed');
  ok(story.includes('sectPr'), 'da strip: sectPr preserved');
}

// 10. Filename sanitising and uniquify
{
  eq(F.sanitizeOutputFilename('test.docx', 'fallback.docx'), 'test.docx', 'sanitize: normal');
  eq(F.sanitizeOutputFilename('../evil.txt', 'fallback.docx'), 'evil.txt.docx', 'sanitize: path stripped to basename (as app.py)');
  eq(F.sanitizeOutputFilename('..\\..\\x.docx', 'fallback.docx'), 'x.docx', 'sanitize: backslash path');
  eq(F.sanitizeOutputFilename(' ... ', 'fallback.docx'), 'fallback.docx', 'sanitize: nothing usable');
  eq(F.sanitizeOutputFilename('a<b>:c?.docx', 'fallback.docx'), 'abc.docx', 'sanitize: illegal chars');
  eq(F.sanitizeOutputFilename('con.docx', 'fallback.docx'), 'con_.docx', 'sanitize: device name');
  const used = new Set();
  eq(F.uniquifyFilename('a.docx', used), 'a.docx', 'uniquify: first');
  eq(F.uniquifyFilename('a.docx', used), 'a_2.docx', 'uniquify: second');
  eq(F.uniquifyFilename('a.docx', used), 'a_3.docx', 'uniquify: third');
}

// 11. buildPacket single vs zip
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Field') });
  const single = F.buildPacket([{ fileBytes: docx, filename: 'a.docx', placeholders: { 'Field': { title: 'Field', tag: 'Field' } } }]);
  eq(single.mimetype, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'packet single: mimetype');
  ok(single.filename.endsWith('.docx'), 'packet single: extension');

  const multi = F.buildPacket([
    { fileBytes: docx, filename: 'a.docx', placeholders: { 'Field': { title: 'Field', tag: 'Field' } } },
    { fileBytes: docx, filename: 'b.docx', placeholders: { 'Field': { title: 'Field', tag: 'Field' } } },
  ]);
  eq(multi.mimetype, 'application/zip', 'packet multi: mimetype');
  ok(multi.filename.endsWith('.zip'), 'packet multi: extension');
  const zip = new AdmZip(multi.data);
  const names = zip.getEntries().map(e => e.entryName);
  eq(names.length, 2, 'packet multi: two entries');
}

// 12. extractValuesFromDocx round-trip
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Case Number') });
  const out = F.convertDocx(docx, { 'Case Number': { title: 'Case Number', tag: 'Case_Number' } }, { protect: false, values: { 'Case Number': '2024-001' } });
  const extracted = F.extractValuesFromDocx(out);
  eq(extracted.values['Case_Number'], '2024-001', 'extract: value round-trip');
  eq(extracted.aliases['Case_Number'], 'Case Number', 'extract: alias');
}

// 13. Deterministic ids via injectables
{
  const docx = makeDocx({ documentXml: docXmlWithHighlight('Field') });
  let seq = 100;
  const out1 = F.convertDocx(docx, { 'Field': { title: 'Field', tag: 'Field' } }, { protect: false, randomInt: () => seq++, newGuid: () => '{GUID}' });
  const story1 = readStory(out1, 'word/document.xml');
  const sdts1 = findSdts(story1);
  eq(sdts1[0].id, '100', 'deterministic: id');
  const cx1 = findCustomXml(out1);
  const props1 = new AdmZip(out1).readAsText(cx1.props[0]);
  ok(props1.includes('{GUID}'), 'deterministic: guid');
}

// 12. Photo fields (VIPER addition): blocks supplied for a non-PC field make it rich text;
// a photo placeholder sharing its line gets its text inline and its pictures right below.
{
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const hl = (t) => '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>' + t + '</w:t></w:r>';
  const docXml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' +
    '<w:p>' + hl('[include photo of residence]') + '</w:p>' +
    '<w:p><w:pPr><w:jc w:val="left"/></w:pPr>' + hl('[describe item]') + '<w:r><w:t xml:space="preserve"> — </w:t></w:r>' + hl('[include photo of item if available]') + '</w:p>' +
    '<w:p><w:r><w:t>After</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  );
  const ph = {
    'include photo of residence': { title: 'include photo of residence', tag: 'res_photo' },
    'describe item': { title: 'describe item', tag: 'item_desc' },
    'include photo of item if available': { title: 'include photo of item if available', tag: 'item_photo' },
  };
  const blocksA = [{ type: 'paragraph', runs: [{ text: 'Front of house' }] }, { type: 'paragraph', runs: [{ image: tinyPng }] }];
  const blocksB = [{ type: 'paragraph', runs: [{ text: 'Black case' }, { image: tinyPng }] }];
  const out = F.convertDocx(makeDocx({ documentXml: docXml }), ph, {
    protect: false,
    values: { 'include photo of residence': 'Front of house', 'describe item': 'Rifle', 'include photo of item if available': 'Black case' },
    richtextBlocks: { 'include photo of residence': blocksA, 'include photo of item if available': blocksB },
  });
  const story = readStory(out, 'word/document.xml');
  const zip = new AdmZip(out);
  const media = zip.getEntries().map(e => e.entryName).filter(n => n.startsWith('word/media/'));
  eq(media.length, 2, 'photo: two pictures embedded');
  eq((story.match(/<w:drawing>/g) || []).length, 2, 'photo: two drawings in the story');
  ok(story.includes('Front of house'), 'photo: whole-paragraph text kept');
  ok(story.includes('Rifle') && story.includes('Black case'), 'photo: inline texts filled');
  ok(story.includes('w:val="item_photo_photos"'), 'photo: pictures control after the shared line');
  const iLine = story.indexOf('Black case'), iPics = story.indexOf('item_photo_photos'), iAfter = story.indexOf('After');
  ok(iLine < iPics && iPics < iAfter, 'photo: pictures sit between the line and the next paragraph');
  const rels = zip.readAsText('word/_rels/document.xml.rels');
  eq((rels.match(/relationships\/image"/g) || []).length, 2, 'photo: two image relationships');
  _parseXml(story);   // still well-formed

  // No picture → no blocks sent → plain field exactly as before.
  const out2 = F.convertDocx(makeDocx({ documentXml: docXml }), ph, { protect: false, values: { 'include photo of residence': 'Front of house' } });
  const story2 = readStory(out2, 'word/document.xml');
  ok(!story2.includes('<w:drawing>') && !story2.includes('_photos'), 'photo: text-only answer adds nothing');
  ok(!story2.includes('w:richText'), 'photo: text-only answer stays a plain field');

  // Adjacent [a][b] merge into one field "a/b" (original rule) — whole line, so pictures go in place.
  const merged = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '"><w:body>' +
    '<w:p>' + hl('[describe item]') + hl('[include photo of item if available]') + '</w:p></w:body></w:document>'
  );
  const mName = 'describe item/include photo of item if available';
  const out3 = F.convertDocx(makeDocx({ documentXml: merged }), { [mName]: { title: mName, tag: 'item_merged' } }, {
    protect: false, values: { [mName]: 'Black case' }, richtextBlocks: { [mName]: blocksB },
  });
  const story3 = readStory(out3, 'word/document.xml');
  eq((story3.match(/<w:drawing>/g) || []).length, 1, 'photo: merged field gets its picture');
  ok(story3.includes('Black case') && !story3.includes('_photos'), 'photo: merged field filled in place');

  // Pictures only on a shared line: the line says where they are instead of showing {{tag}}.
  const out4 = F.convertDocx(makeDocx({ documentXml: docXml }), ph, {
    protect: false, values: { 'describe item': 'Rifle' },
    richtextBlocks: { 'include photo of item if available': [{ type: 'paragraph', runs: [{ image: tinyPng }] }] },
  });
  const story4 = readStory(out4, 'word/document.xml');
  ok(story4.includes('(see photo below)') && !story4.includes('{{item_photo}}'), 'photo: picture-only inline note');
  eq((story4.match(/<w:drawing>/g) || []).length, 1, 'photo: picture-only still embedded');
  // Word refreshes bound controls from the customXml part on open, so it must say the same.
  const bound4 = new AdmZip(out4).getEntries()
    .filter(e => /^customXml\/item\d+\.xml$/.test(e.entryName))
    .map(e => e.getData().toString('utf-8'))
    .find(s => s.includes('<item_photo>')) || '';
  ok(bound4.includes('<item_photo>(see photo below)</item_photo>'), 'photo: picture-only note in bound data');
  ok(bound4.includes('Rifle'), 'photo: other bound values unchanged');
}

console.log(`docx-form-engine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
