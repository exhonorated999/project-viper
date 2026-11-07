"use strict";
// docx-form-engine — turns highlighted [bracket] placeholders in an agency's Word template into
// Word content controls bound to a customXml part, optionally seeding officer values, rich-text
// PC statements, forms protection, and DA-approval-section removal. Also reads values back out
// of a finished document (extractValuesFromDocx).
//
// Node port of a partner agency's Python "Warrant Builder" (convert_docx and helpers), used with
// the author's permission. Behaviour is golden-tested against the original over the agency's full
// template library (semantic XML equality of every part, ids/GUID normalized) — keep it that way:
// sdtPr child order, namespace declarations and highlight handling are load-bearing for Word.
// Agency templates/config live in a private pack in userData and are NEVER committed here.

const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const AdmZip = require("adm-zip");
const crypto = require("crypto");

const CUSTOM_XML_SCHEMA_URI = "http://warrant-builder/schema";

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  ds: "http://schemas.openxmlformats.org/officeDocument/2006/customXml",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  rels: "http://schemas.openxmlformats.org/package/2006/relationships",
  xml: "http://www.w3.org/XML/1998/namespace",
};

const _XML_ILLEGAL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const _FILENAME_ILLEGAL_RE = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const _RESERVED_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_OUTPUT_FILENAME_STEM = 150;

const DEFAULT_FIELD_MERGES = { "name, badge": "detective, badge" };
const _DEFAULT_FIELD_MERGES_LOWER = Object.fromEntries(
  Object.entries(DEFAULT_FIELD_MERGES).map(([k, v]) => [k.toLowerCase(), v])
);

const LONG_NARRATIVE_NAME_LENGTH_THRESHOLD = 80;
const BACKGROUND_OF_AFFIANT_FIELD_NAMES = new Set([
  "background of affiant", "affiant background", "background of officer", "background of your affiant",
]);

const EMU_PER_INCH = 914400;
const MAX_IMAGE_WIDTH_EMU = Math.floor(5.5 * EMU_PER_INCH);
const TABLE_TOTAL_WIDTH_DXA = 9360;

const _DATA_URL_IMAGE_RE = /^data:image\/(png|jpe?g);base64,(.+)$/is;

const RETURN_BLOCK_HEADER_RE = /records\s+should\s+be\s+provided\s+to\s*:?\s*$/i;
const RETURN_BLOCK_ROLE_NAMES = { name: "detective name", email: "detective email", "phone number": "detective phone number" };
const RETURN_BLOCK_MAX_LINE_LEN = 120;
const RETURN_BLOCK_MAX_LINES = 5;
const _RECOVERED_NAME_TRAILING = " \t)\u2026:;.,.";

function _rndInt() { return crypto.randomInt(1, 0x7FFFFFFF); }
function _newGuid() { return "{" + crypto.randomUUID().toUpperCase() + "}"; }

function sanitizeTagName(name) {
  let tag = String(name || "").replace(/[^a-zA-Z0-9]/g, "_");
  tag = tag.replace(/^_+/, "");
  if (!tag || /^[0-9]/.test(tag)) tag = "field_" + tag;
  return tag;
}

function sanitizeOutputFilename(name, fallback) {
  let stem = String(name || "").trim().replace(/\\/g, "/").split("/").pop() || "";
  if (stem.toLowerCase().endsWith(".docx")) stem = stem.slice(0, -5);
  stem = stem.replace(_FILENAME_ILLEGAL_RE, "").replace(/^[. ]+|[. ]+$/g, "");
  if (!stem) return fallback;
  stem = stem.slice(0, MAX_OUTPUT_FILENAME_STEM).replace(/^[. ]+|[. ]+$/g, "");
  if (!stem) return fallback;
  if (_RESERVED_DEVICE_NAME_RE.test(stem)) stem += "_";
  return stem + ".docx";
}

function uniquifyFilename(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const stem = name.toLowerCase().endsWith(".docx") ? name.slice(0, -5) : name;
  let n = 2;
  while (used.has(stem + "_" + n + ".docx")) n++;
  const unique = stem + "_" + n + ".docx";
  used.add(unique);
  return unique;
}

function sanitizeXmlText(value) {
  if (value == null) return value;
  return String(value).replace(_XML_ILLEGAL_CHARS_RE, "");
}

function isLongNarrativeField(name) {
  const trimmed = String(name || "").trim();
  return BACKGROUND_OF_AFFIANT_FIELD_NAMES.has(trimmed.toLowerCase()) || trimmed.length > LONG_NARRATIVE_NAME_LENGTH_THRESHOLD;
}

function isPcStatementField(name) {
  const lower = String(name || "").trim().toLowerCase();
  return lower.includes("probable cause") || lower.includes("pc statement");
}

function _parse(xmlBytes) {
  const text = Buffer.isBuffer(xmlBytes) ? xmlBytes.toString("utf-8") : xmlBytes;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("XML parse error");
  return doc;
}

function _serialize(node) { return new XMLSerializer().serializeToString(node); }
function _elNS(doc, ns, qname) { return doc.createElementNS(ns, qname); }

function _childElements(parent, ns, localName) {
  const out = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c.nodeType === 1 && c.namespaceURI === ns && c.localName === localName) out.push(c);
  }
  return out;
}

function _firstChildElement(parent, ns, localName) {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i];
    if (c.nodeType === 1 && c.namespaceURI === ns && c.localName === localName) return c;
  }
  return null;
}

function _removeChild(parent, child) { if (child && child.parentNode === parent) parent.removeChild(child); }
// Mirrors ElementTree's Element.clear(): drops all children AND attributes (app.py relies on
// this when it rebuilds a paragraph -- w14:paraId / w:rsid* do not survive a rewritten <w:p>).
// Namespace declarations are kept; ET has no notion of them as attributes.
function _etClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  const attrs = [];
  for (let i = 0; i < el.attributes.length; i++) attrs.push(el.attributes[i]);
  for (const at of attrs) {
    if (at.name === "xmlns" || at.prefix === "xmlns") continue;
    el.removeAttributeNode(at);
  }
}
function _deepCloneElement(el) { return el.cloneNode(true); }
function _setAttrNS(el, ns, qname, value) { el.setAttributeNS(ns, qname, String(value)); }
function _getAttrNS(el, ns, localName) { return el.getAttributeNS(ns, localName); }

function findBracketRanges(text) {
  const ranges = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") stack.push(i);
    else if (text[i] === "]") { if (stack.length) { const start = stack.pop(); if (!stack.length) ranges.push([start, i + 1]); } }
  }
  return ranges;
}

function findUnmatchedBracketOpens(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) { if (text[i] === "[") stack.push(i); else if (text[i] === "]") { if (stack.length) stack.pop(); } }
  return stack;
}

function _charIsHighlighted(charMapping, i) {
  if (i >= charMapping.length) return false;
  const run = charMapping[i][1];
  const rPr = _firstChildElement(run, NS.w, "rPr");
  if (!rPr) return false;
  return _firstChildElement(rPr, NS.w, "highlight") !== null;
}

function findHighlightedBracketGroups(pText, charMapping) {
  const unmatched = findUnmatchedBracketOpens(pText);
  const recovered = {};
  for (const u of unmatched) {
    let end = u + 1;
    while (end < pText.length && _charIsHighlighted(charMapping, end)) end++;
    if (end === u + 1) continue;
    let unclosedWithin = findUnmatchedBracketOpens(pText.slice(u + 1, end)).length;
    while (unclosedWithin > 0 && end < pText.length && pText[end] === "]") { end++; unclosedWithin--; }
    recovered[u] = end;
  }

  let rawRanges;
  if (Object.keys(recovered).length) {
    const masked = pText.split("");
    for (const u of Object.keys(recovered).map(Number)) masked[u] = " ";
    rawRanges = findBracketRanges(masked.join(""));
    rawRanges = rawRanges.filter(([S, E]) => !Object.entries(recovered).some(([rs, re_]) => !(E <= +rs || S >= re_)));
  } else {
    rawRanges = findBracketRanges(pText);
  }

  const candidates = [...rawRanges.map(([S, E]) => [S, E, false]), ...Object.entries(recovered).map(([S, E]) => [+S, E, true])];
  candidates.sort((a, b) => a[0] - b[0]);

  const groups = [];
  for (const [S, E, isRecovered] of candidates) {
    let content;
    if (isRecovered) {
      content = pText.slice(S + 1, E).trim();
      while (content.length && _RECOVERED_NAME_TRAILING.includes(content[content.length - 1])) content = content.slice(0, -1).trim();
      while (content.endsWith("]") && (content.split("]").length - 1) > (content.split("[").length - 1)) {
        content = content.slice(0, -1).trim();
        while (content.length && _RECOVERED_NAME_TRAILING.includes(content[content.length - 1])) content = content.slice(0, -1).trim();
      }
    } else {
      content = pText.slice(S + 1, E - 1).trim();
    }
    if (!content) continue;

    const runIndices = new Set();
    for (let ci = S; ci < E; ci++) { if (ci < charMapping.length) runIndices.add(charMapping[ci][1]); }
    let hasHighlight = false;
    for (const run of runIndices) {
      const rPr = _firstChildElement(run, NS.w, "rPr");
      if (rPr && _firstChildElement(rPr, NS.w, "highlight") !== null) { hasHighlight = true; break; }
    }
    if (!hasHighlight) continue;

    content = _DEFAULT_FIELD_MERGES_LOWER[content.toLowerCase()] || content;

    if (groups.length) {
      const prev = groups[groups.length - 1];
      const between = S >= prev.E ? pText.slice(prev.E, S) : null;
      if (between !== null && (between === "" || between === "/")) { prev.parts.push(content); prev.E = E; continue; }
    }
    groups.push({ S, E, parts: [content] });
  }

  return groups.map(g => [g.S, g.E, g.parts.join("/")]);
}

function rebuildCharMapping(p) {
  let pText = "";
  const charMapping = [];
  for (let i = 0; i < p.childNodes.length; i++) {
    const child = p.childNodes[i];
    if (child.nodeType === 1 && child.namespaceURI === NS.w && child.localName === "r") {
      const tElems = [];
      for (let j = 0; j < child.childNodes.length; j++) {
        const c2 = child.childNodes[j];
        if (c2.nodeType === 1 && c2.namespaceURI === NS.w && c2.localName === "t") tElems.push(c2);
      }
      const runText = tElems.map(t => t.textContent || "").join("");
      for (let offset = 0; offset < runText.length; offset++) charMapping.push([i, child, offset]);
      pText += runText;
    }
  }
  return [pText, charMapping];
}

function normalizeParagraph(p) {
  const newChildren = [];
  for (let i = 0; i < p.childNodes.length; i++) {
    const child = p.childNodes[i];
    if (child.nodeType === 1 && child.namespaceURI === NS.w && child.localName === "r") {
      const tElems = [];
      for (let j = 0; j < child.childNodes.length; j++) {
        const c2 = child.childNodes[j];
        if (c2.nodeType === 1 && c2.namespaceURI === NS.w && c2.localName === "t") tElems.push(c2);
      }
      if (tElems.length > 1) {
        const rPr = _firstChildElement(child, NS.w, "rPr");
        for (const t of tElems) {
          const newR = _elNS(p.ownerDocument, NS.w, "w:r");
          if (rPr) newR.appendChild(_deepCloneElement(rPr));
          newR.appendChild(t);
          newChildren.push(newR);
        }
      } else {
        newChildren.push(child);
      }
    } else {
      newChildren.push(child);
    }
  }
  const pPr = _firstChildElement(p, NS.w, "pPr");
  _etClear(p);
  if (pPr) p.appendChild(pPr);
  for (const c of newChildren) { if (!(c.nodeType === 1 && c.namespaceURI === NS.w && c.localName === "pPr")) p.appendChild(c); }
}

function splitRunAtCharOffset(p, pText, charMapping, charOffset) {
  if (charOffset <= 0 || charOffset >= pText.length) return [pText, charMapping];
  const [childIdx, run, runOffset] = charMapping[charOffset];
  if (runOffset === 0) return [pText, charMapping];
  const t = _firstChildElement(run, NS.w, "t");
  if (!t || !t.textContent) return [pText, charMapping];
  const text1 = t.textContent.slice(0, runOffset);
  const text2 = t.textContent.slice(runOffset);
  const rPr = _firstChildElement(run, NS.w, "rPr");
  const doc = p.ownerDocument;

  const r1 = _elNS(doc, NS.w, "w:r");
  if (rPr) r1.appendChild(_deepCloneElement(rPr));
  const t1 = _elNS(doc, NS.w, "w:t");
  t1.setAttributeNS(NS.xml, "xml:space", "preserve");
  t1.textContent = text1;
  r1.appendChild(t1);

  const r2 = _elNS(doc, NS.w, "w:r");
  if (rPr) r2.appendChild(_deepCloneElement(rPr));
  const t2 = _elNS(doc, NS.w, "w:t");
  t2.setAttributeNS(NS.xml, "xml:space", "preserve");
  t2.textContent = text2;
  r2.appendChild(t2);

  const children = [];
  for (let i = 0; i < p.childNodes.length; i++) children.push(p.childNodes[i]);
  const idx = children.indexOf(run);

  _etClear(p);
  for (let i = 0; i < children.length; i++) {
    if (i === idx) { p.appendChild(r1); p.appendChild(r2); }
    else p.appendChild(children[i]);
  }
  return rebuildCharMapping(p);
}

function setRunTextWithBreaks(run, text) {
  const doc = run.ownerDocument;
  const toRemove = [];
  for (let i = 0; i < run.childNodes.length; i++) {
    const c = run.childNodes[i];
    if (c.nodeType === 1 && c.namespaceURI === NS.w && (c.localName === "t" || c.localName === "br")) toRemove.push(c);
  }
  for (const c of toRemove) run.removeChild(c);

  const lines = text.split(/\r\n|\r|\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    if (idx > 0) run.appendChild(_elNS(doc, NS.w, "w:br"));
    const t = _elNS(doc, NS.w, "w:t");
    t.setAttributeNS(NS.xml, "xml:space", "preserve");
    t.textContent = lines[idx];
    run.appendChild(t);
  }
}

function replacePlaceholderInParagraph(p, S, E, fieldName, fieldTitle, fieldTag, fieldId,
  fieldType = "text", choices = null, storeItemId = null, fieldValue = null, multiline = false) {
  normalizeParagraph(p);
  let [pText, charMapping] = rebuildCharMapping(p);
  [pText, charMapping] = splitRunAtCharOffset(p, pText, charMapping, E);
  [pText, charMapping] = splitRunAtCharOffset(p, pText, charMapping, S);

  const startChildIdx = charMapping[S][0];
  const endChildIdx = charMapping[E - 1][0];

  const children = [];
  for (let i = 0; i < p.childNodes.length; i++) children.push(p.childNodes[i]);
  const sliceChildren = children.slice(startChildIdx, endChildIdx + 1);

  const BOUNDARY_TAGS = new Set([`${NS.w}bookmarkStart`, `${NS.w}bookmarkEnd`, `${NS.w}commentRangeStart`, `${NS.w}commentRangeEnd`]);
  const HYPERLINK_TAG = `${NS.w}hyperlink`;

  const runsToWrap = [];
  const boundaryMarkers = [];
  for (const c of sliceChildren) {
    const tagKey = c.namespaceURI + c.localName;
    if (BOUNDARY_TAGS.has(tagKey)) boundaryMarkers.push(c);
    else if (tagKey === HYPERLINK_TAG) { for (let j = 0; j < c.childNodes.length; j++) { const cc = c.childNodes[j]; if (cc.nodeType === 1) runsToWrap.push(cc); } }
    else runsToWrap.push(c);
  }

  let representativeRun = runsToWrap[0];
  for (const run of runsToWrap) {
    const rPr = _firstChildElement(run, NS.w, "rPr");
    if (rPr && _firstChildElement(rPr, NS.w, "highlight") !== null) { representativeRun = run; break; }
  }

  let sdtRPr = null;
  const repRPr = _firstChildElement(representativeRun, NS.w, "rPr");
  if (repRPr) sdtRPr = _deepCloneElement(repRPr);

  const cleanValue = sanitizeXmlText(fieldValue);
  const targetText = cleanValue || `{{${fieldTag}}}`;
  for (let i = 0; i < runsToWrap.length; i++) {
    if (i === 0) {
      if (sdtRPr) {
        const oldRPr = _firstChildElement(runsToWrap[0], NS.w, "rPr");
        if (oldRPr) runsToWrap[0].removeChild(oldRPr);
        runsToWrap[0].insertBefore(_deepCloneElement(sdtRPr), runsToWrap[0].firstChild);
      }
      setRunTextWithBreaks(runsToWrap[0], targetText);
    } else {
      { const ts = runsToWrap[i].getElementsByTagNameNS(NS.w, "t"); for (let k = 0; k < ts.length; k++) ts[k].textContent = ""; }
    }
  }

  const doc = p.ownerDocument;
  const sdt = _elNS(doc, NS.w, "w:sdt");
  const sdtPr = _elNS(doc, NS.w, "w:sdtPr");

  if (sdtRPr) sdtPr.appendChild(sdtRPr);

  const aliasElem = _elNS(doc, NS.w, "w:alias");
  _setAttrNS(aliasElem, NS.w, "w:val", fieldTitle);
  sdtPr.appendChild(aliasElem);

  const tagElem = _elNS(doc, NS.w, "w:tag");
  _setAttrNS(tagElem, NS.w, "w:val", fieldTag);
  sdtPr.appendChild(tagElem);

  const idElem = _elNS(doc, NS.w, "w:id");
  _setAttrNS(idElem, NS.w, "w:val", String(fieldId));
  sdtPr.appendChild(idElem);

  const bindingElem = _elNS(doc, NS.w, "w:dataBinding");
  if (storeItemId) _setAttrNS(bindingElem, NS.w, "w:storeItemID", storeItemId);
  _setAttrNS(bindingElem, NS.w, "w:prefixMappings", `xmlns:ns0='${CUSTOM_XML_SCHEMA_URI}'`);
  _setAttrNS(bindingElem, NS.w, "w:xpath", `/ns0:root[1]/ns0:${fieldTag}[1]`);
  sdtPr.appendChild(bindingElem);

  if (fieldType === "dropdown" && choices && choices.length) {
    const dropdownElem = _elNS(doc, NS.w, "w:dropDownList");
    for (const choice of choices) {
      const itemElem = _elNS(doc, NS.w, "w:listItem");
      _setAttrNS(itemElem, NS.w, "w:value", choice);
      _setAttrNS(itemElem, NS.w, "w:displayText", choice);
      dropdownElem.appendChild(itemElem);
    }
    sdtPr.appendChild(dropdownElem);
  } else {
    const textElem = _elNS(doc, NS.w, "w:text");
    if (multiline) _setAttrNS(textElem, NS.w, "w:multiLine", "1");
    sdtPr.appendChild(textElem);
  }

  sdt.appendChild(sdtPr);
  sdt.appendChild(_elNS(doc, NS.w, "w:sdtEndPr"));

  const sdtContent = _elNS(doc, NS.w, "w:sdtContent");
  for (const run of runsToWrap) sdtContent.appendChild(run);
  sdt.appendChild(sdtContent);

  _etClear(p);
  for (let i = 0; i < children.length; i++) {
    if (i === startChildIdx) {
      for (const marker of boundaryMarkers) p.appendChild(marker);
      p.appendChild(sdt);
    } else if (startChildIdx < i && i <= endChildIdx) continue;
    else p.appendChild(children[i]);
  }
}

function getImagePixelSize(imageBytes, mime) {
  try {
    if (mime === "image/png" && imageBytes[0] === 0x89 && imageBytes[1] === 0x50) {
      return [imageBytes.readUInt32BE(16), imageBytes.readUInt32BE(20)];
    }
    if (mime === "image/jpeg") {
      let idx = 2, n = imageBytes.length;
      const SOF = new Set([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF]);
      while (idx + 9 < n) {
        if (imageBytes[idx] !== 0xFF) { idx++; continue; }
        if (SOF.has(imageBytes[idx+1])) return [imageBytes.readUInt16BE(idx+7), imageBytes.readUInt16BE(idx+5)];
        idx += 2 + imageBytes.readUInt16BE(idx+2);
      }
    }
  } catch(e){}
  return [null,null];
}

function computeImageEmuSize(widthPx, heightPx) {
  if (!widthPx || !heightPx) return [MAX_IMAGE_WIDTH_EMU, Math.floor(MAX_IMAGE_WIDTH_EMU*0.75)];
  let emuW = Math.floor(widthPx/96*EMU_PER_INCH), emuH = Math.floor(heightPx/96*EMU_PER_INCH);
  if (emuW > MAX_IMAGE_WIDTH_EMU) { const s = MAX_IMAGE_WIDTH_EMU/emuW; emuH = Math.floor(emuH*s); emuW = MAX_IMAGE_WIDTH_EMU; }
  return [emuW, emuH];
}

class ImageEmbedder {
  constructor(existingNames, ridCounter) {
    this._usedNames = new Set(existingNames);
    this._ridCounter = ridCounter;
    this._nextDocPrId = 1;
    this.mediaFiles = [];
    this.newRels = [];
    this.usedExts = new Set();
  }
  _nextMediaName(ext) {
    let n = 1;
    while (this._usedNames.has("word/media/image" + n + "." + ext)) n++;
    const name = "word/media/image" + n + "." + ext;
    this._usedNames.add(name);
    return name;
  }
  embed(dataUrl) {
    const m = _DATA_URL_IMAGE_RE.exec(dataUrl || "");
    if (!m) return null;
    const ext = (m[1].toLowerCase() === "jpg" || m[1].toLowerCase() === "jpeg") ? "jpeg" : "png";
    let imageBytes;
    try { imageBytes = Buffer.from(m[2], "base64"); } catch (e) { return null; }
    if (!imageBytes || !imageBytes.length) return null;
    const archivePath = this._nextMediaName(ext);
    this.mediaFiles.push([archivePath, imageBytes]);
    this.usedExts.add(ext);
    const rid = "rId" + this._ridCounter[0];
    this._ridCounter[0] += 1;
    this.newRels.push([rid, archivePath.slice("word/".length)]);
    const [w, h] = getImagePixelSize(imageBytes, "image/" + ext);
    const [emuW, emuH] = computeImageEmuSize(w, h);
    const docPrId = this._nextDocPrId++;
    return [rid, emuW, emuH, docPrId];
  }
}

function buildDrawingElement(rid, emuW, emuH, docPrId) {
  const doc = new DOMParser().parseFromString("<root/>", "application/xml");
  const drawing = _elNS(doc, NS.w, "w:drawing");
  const inline = _elNS(doc, NS.wp, "wp:inline");
  for (const a of ["distT","distB","distL","distR"]) inline.setAttribute(a, "0");
  const extent = _elNS(doc, NS.wp, "wp:extent");
  extent.setAttribute("cx", String(emuW)); extent.setAttribute("cy", String(emuH));
  inline.appendChild(extent);
  const ee = _elNS(doc, NS.wp, "wp:effectExtent");
  for (const a of ["l","t","r","b"]) ee.setAttribute(a, "0");
  inline.appendChild(ee);
  const docPr = _elNS(doc, NS.wp, "wp:docPr");
  docPr.setAttribute("id", String(docPrId)); docPr.setAttribute("name", "Picture " + docPrId);
  inline.appendChild(docPr);
  const cgf = _elNS(doc, NS.wp, "wp:cNvGraphicFramePr");
  const gfl = _elNS(doc, NS.a, "a:graphicFrameLocks");
  gfl.setAttribute("noChangeAspect", "1"); cgf.appendChild(gfl); inline.appendChild(cgf);
  const pic = _elNS(doc, NS.pic, "pic:pic");
  const nvpp = _elNS(doc, NS.pic, "pic:nvPicPr");
  const cpr = _elNS(doc, NS.pic, "pic:cNvPr");
  cpr.setAttribute("id", String(docPrId)); cpr.setAttribute("name", "Picture " + docPrId);
  nvpp.appendChild(cpr); nvpp.appendChild(_elNS(doc, NS.pic, "pic:cNvPicPr")); pic.appendChild(nvpp);
  const bf = _elNS(doc, NS.pic, "pic:blipFill");
  const blip = _elNS(doc, NS.a, "a:blip");
  _setAttrNS(blip, NS.r, "r:embed", rid); bf.appendChild(blip);
  const stretch = _elNS(doc, NS.a, "a:stretch");
  stretch.appendChild(_elNS(doc, NS.a, "a:fillRect")); bf.appendChild(stretch); pic.appendChild(bf);
  const spPr = _elNS(doc, NS.pic, "pic:spPr");
  const xfrm = _elNS(doc, NS.a, "a:xfrm");
  const off = _elNS(doc, NS.a, "a:off"); off.setAttribute("x", "0"); off.setAttribute("y", "0"); xfrm.appendChild(off);
  const ext = _elNS(doc, NS.a, "a:ext"); ext.setAttribute("cx", String(emuW)); ext.setAttribute("cy", String(emuH)); xfrm.appendChild(ext);
  spPr.appendChild(xfrm);
  const pg = _elNS(doc, NS.a, "a:prstGeom"); pg.setAttribute("prst", "rect"); pg.appendChild(_elNS(doc, NS.a, "a:avLst")); spPr.appendChild(pg);
  pic.appendChild(spPr);
  const gd = _elNS(doc, NS.a, "a:graphicData"); gd.setAttribute("uri", "http://schemas.openxmlformats.org/drawingml/2006/picture"); gd.appendChild(pic);
  const graphic = _elNS(doc, NS.a, "a:graphic"); graphic.appendChild(gd); inline.appendChild(graphic);
  drawing.appendChild(inline);
  return drawing;
}

function buildRunElement(runSpec, baseRunRPr, imageEmbedder) {
  const doc = (baseRunRPr && baseRunRPr.ownerDocument) || new DOMParser().parseFromString("<root/>", "application/xml");
  if (runSpec.image) {
    const res = imageEmbedder ? imageEmbedder.embed(runSpec.image) : null;
    if (!res) return null;
    const [rid, emuW, emuH, docPrId] = res;
    const run = _elNS(doc, NS.w, "w:r");
    run.appendChild(buildDrawingElement(rid, emuW, emuH, docPrId));
    return run;
  }
  const run = _elNS(doc, NS.w, "w:r");
  let rPr = baseRunRPr ? _deepCloneElement(baseRunRPr) : _elNS(doc, NS.w, "w:rPr");
  if (runSpec.fontSizePt) {
    const szVal = String(Math.max(2, Math.round(parseFloat(runSpec.fontSizePt) * 2)));
    for (const szTag of ["sz", "szCs"]) {
      const ex = _firstChildElement(rPr, NS.w, szTag);
      if (ex) rPr.removeChild(ex);
      const sz = _elNS(doc, NS.w, "w:" + szTag);
      _setAttrNS(sz, NS.w, "w:val", szVal); rPr.appendChild(sz);
    }
  }
  if (runSpec.bold) rPr.appendChild(_elNS(doc, NS.w, "w:b"));
  if (runSpec.italic) rPr.appendChild(_elNS(doc, NS.w, "w:i"));
  if (runSpec.underline) { const u = _elNS(doc, NS.w, "w:u"); _setAttrNS(u, NS.w, "w:val", "single"); rPr.appendChild(u); }
  if (rPr.childNodes.length) run.appendChild(rPr);
  if (runSpec.break) run.appendChild(_elNS(doc, NS.w, "w:br"));
  else { const t = _elNS(doc, NS.w, "w:t"); t.setAttributeNS(NS.xml, "xml:space", "preserve"); t.textContent = runSpec.text || ""; run.appendChild(t); }
  return run;
}

function buildTableElement(rows, baseRunRPr, imageEmbedder) {
  const doc = (baseRunRPr && baseRunRPr.ownerDocument) || new DOMParser().parseFromString("<root/>", "application/xml");
  const tbl = _elNS(doc, NS.w, "w:tbl");
  const tblPr = _elNS(doc, NS.w, "w:tblPr");
  const tblW = _elNS(doc, NS.w, "w:tblW"); _setAttrNS(tblW, NS.w, "w:w", "0"); _setAttrNS(tblW, NS.w, "w:type", "auto"); tblPr.appendChild(tblW);
  const tblBorders = _elNS(doc, NS.w, "w:tblBorders");
  for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
    const b = _elNS(doc, NS.w, "w:" + side); _setAttrNS(b, NS.w, "w:val", "single"); _setAttrNS(b, NS.w, "w:sz", "4"); _setAttrNS(b, NS.w, "w:space", "0"); _setAttrNS(b, NS.w, "w:color", "auto"); tblBorders.appendChild(b);
  }
  tblPr.appendChild(tblBorders); tbl.appendChild(tblPr);
  const numCols = Math.max(...rows.map(r => r.length), 1);
  const colWidth = Math.max(1, Math.floor(TABLE_TOTAL_WIDTH_DXA / numCols));
  const tblGrid = _elNS(doc, NS.w, "w:tblGrid");
  for (let i = 0; i < numCols; i++) { const gc = _elNS(doc, NS.w, "w:gridCol"); _setAttrNS(gc, NS.w, "w:w", String(colWidth)); tblGrid.appendChild(gc); }
  tbl.appendChild(tblGrid);
  for (const row of rows) {
    const tr = _elNS(doc, NS.w, "w:tr");
    for (const cell of row) {
      const tc = _elNS(doc, NS.w, "w:tc"); const tcPr = _elNS(doc, NS.w, "w:tcPr"); const tcW = _elNS(doc, NS.w, "w:tcW");
      _setAttrNS(tcW, NS.w, "w:w", String(colWidth)); _setAttrNS(tcW, NS.w, "w:type", "dxa"); tcPr.appendChild(tcW); tc.appendChild(tcPr);
      const p = _elNS(doc, NS.w, "w:p");
      for (const rs of (cell.runs || [])) { const r = buildRunElement(rs, baseRunRPr, imageEmbedder); if (r) p.appendChild(r); }
      tc.appendChild(p); tr.appendChild(tc);
    }
    tbl.appendChild(tr);
  }
  return tbl;
}

function getRepresentativeRunRPr(paragraph) {
  const runs = [];
  for (let i = 0; i < paragraph.childNodes.length; i++) { const c = paragraph.childNodes[i]; if (c.nodeType === 1 && c.namespaceURI === NS.w && c.localName === "r") runs.push(c); }
  if (!runs.length) return null;
  let rep = runs[0];
  for (const run of runs) { const rPr = _firstChildElement(run, NS.w, "rPr"); if (rPr && _firstChildElement(rPr, NS.w, "highlight") !== null) { rep = run; break; } }
  const rPr = _firstChildElement(rep, NS.w, "rPr");
  return rPr ? _deepCloneElement(rPr) : null;
}

function buildRichtextBlockPPr(originalPPr, numId) {
  const doc = (originalPPr && originalPPr.ownerDocument) || new DOMParser().parseFromString("<root/>", "application/xml");
  const pPr = originalPPr ? _deepCloneElement(originalPPr) : _elNS(doc, NS.w, "w:pPr");
  if (numId != null) {
    const numPr = _elNS(doc, NS.w, "w:numPr"); const ilvl = _elNS(doc, NS.w, "w:ilvl"); _setAttrNS(ilvl, NS.w, "w:val", "0"); numPr.appendChild(ilvl);
    const nid = _elNS(doc, NS.w, "w:numId"); _setAttrNS(nid, NS.w, "w:val", String(numId)); numPr.appendChild(nid);
    const pStyle = _firstChildElement(pPr, NS.w, "pStyle");
    pPr.insertBefore(numPr, pPr.childNodes[pStyle ? 1 : 0] || null);
  }
  return pPr;
}

function replaceParagraphWithRichtextBlock(paragraph, parentMap, contentBlocks, fieldTitle, fieldTag, fieldId, listNumIds, imageEmbedder) {
  const parent = parentMap.get(paragraph);
  if (!parent) return false;
  const siblings = [];
  for (let i = 0; i < parent.childNodes.length; i++) siblings.push(parent.childNodes[i]);
  const idx = siblings.indexOf(paragraph);
  if (idx === -1) return false;
  listNumIds = listNumIds || {};
  const doc = paragraph.ownerDocument;
  const originalPPr = _firstChildElement(paragraph, NS.w, "pPr");
  const baseRunRPr = getRepresentativeRunRPr(paragraph);
  const sdt = _elNS(doc, NS.w, "w:sdt"); const sdtPr = _elNS(doc, NS.w, "w:sdtPr");
  const alias = _elNS(doc, NS.w, "w:alias"); _setAttrNS(alias, NS.w, "w:val", fieldTitle); sdtPr.appendChild(alias);
  const tag = _elNS(doc, NS.w, "w:tag"); _setAttrNS(tag, NS.w, "w:val", fieldTag); sdtPr.appendChild(tag);
  const id = _elNS(doc, NS.w, "w:id"); _setAttrNS(id, NS.w, "w:val", String(fieldId)); sdtPr.appendChild(id);
  sdtPr.appendChild(_elNS(doc, NS.w, "w:richText"));
  sdt.appendChild(sdtPr); sdt.appendChild(_elNS(doc, NS.w, "w:sdtEndPr"));
  const sdtContent = _elNS(doc, NS.w, "w:sdtContent");
  let blocks = contentBlocks;
  if (blocks && blocks.length && blocks[blocks.length - 1].type === "table") blocks = blocks.concat([{ type: "paragraph", runs: [] }]);
  for (const block of (blocks || [])) {
    const bt = block.type || "paragraph";
    if (bt === "table") { sdtContent.appendChild(buildTableElement(block.rows || [], baseRunRPr, imageEmbedder)); continue; }
    const nid = (bt === "bullet" || bt === "number") ? listNumIds[bt] : null;
    const np = _elNS(doc, NS.w, "w:p");
    const pPr = buildRichtextBlockPPr(originalPPr, nid);
    if (pPr.childNodes.length) np.appendChild(pPr);
    for (const rs of (block.runs || [])) { const r = buildRunElement(rs, baseRunRPr, imageEmbedder); if (r) np.appendChild(r); }
    sdtContent.appendChild(np);
  }
  sdt.appendChild(sdtContent);
  parent.removeChild(paragraph);
  parent.insertBefore(sdt, parent.childNodes[idx] || null);
  return true;
}

// VIPER addition: every picture in a block list, one per paragraph block.
function _imageOnlyBlocks(blocks) {
  const out = [];
  const take = (runs) => { for (const r of (runs || [])) if (r && typeof r.image === "string" && _DATA_URL_IMAGE_RE.test(r.image)) out.push({ type: "paragraph", runs: [{ image: r.image }] }); };
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!b) continue;
    if (b.type === "table") { for (const row of (b.rows || [])) for (const c of (row || [])) take(c && c.runs); continue; }
    take(b.runs);
  }
  return out;
}

// VIPER addition: for photo fields whose placeholder shares a paragraph with other text, put
// the pictures in a rich-text content control directly after that paragraph (in field order).
function insertPictureParagraphsAfter(paragraph, parentMap, infos, listNumIds, imageEmbedder) {
  const parent = parentMap.get(paragraph);
  if (!parent) return;
  const doc = paragraph.ownerDocument;
  const pPr = _firstChildElement(paragraph, NS.w, "pPr");
  let anchor = paragraph;
  for (const info of infos) {
    const np = _elNS(doc, NS.w, "w:p");
    if (pPr) {
      const clone = _deepCloneElement(pPr);
      // Pictures shouldn't continue a list or carry the line's own numbering.
      const numPr = _firstChildElement(clone, NS.w, "numPr"); if (numPr) clone.removeChild(numPr);
      np.appendChild(clone);
    }
    parent.insertBefore(np, anchor.nextSibling || null);
    parentMap.set(np, parent);
    const ok = replaceParagraphWithRichtextBlock(np, parentMap, _imageOnlyBlocks(info.richtextBlocks),
      info.title + " (photos)", (info.tag + "_photos").slice(0, 64), info.idGenerator(), listNumIds, imageEmbedder);
    if (!ok) { parent.removeChild(np); continue; }
    // The content control now sits where np was.
    let node = anchor.nextSibling;
    while (node && node.nodeType !== 1) node = node.nextSibling;
    anchor = node || anchor;
  }
}

function _stripDocumentProtection(xmlStr) {
  xmlStr = xmlStr.replace(/<w:documentProtection\b[^>]*\/>/g, "");
  xmlStr = xmlStr.replace(/<w:documentProtection\b[^>]*>.*?<\/w:documentProtection>/gs, "");
  return xmlStr;
}

function removeProtection(settingsXmlBytes) {
  return Buffer.from(_stripDocumentProtection(settingsXmlBytes.toString("utf-8")), "utf-8");
}

function addFormsProtection(settingsXmlBytes) {
  let xmlStr = _stripDocumentProtection(settingsXmlBytes.toString("utf-8"));
  const protectionTag = '<w:documentProtection w:edit="forms" w:enforcement="1"/>';
  const zoomMatch = xmlStr.match(/<w:zoom\b[^>]*\/>/);
  let insertPos;
  if (zoomMatch) insertPos = zoomMatch.index + zoomMatch[0].length;
  else { const m = xmlStr.match(/<w:settings\b[^>]*>/); insertPos = m ? m.index + m[0].length : 0; }
  xmlStr = xmlStr.slice(0, insertPos) + protectionTag + xmlStr.slice(insertPos);
  return Buffer.from(xmlStr, "utf-8");
}

function findLiteralRanges(pText, searchTerm) {
  const ranges = []; if (!searchTerm) return ranges;
  let start = 0, tl = searchTerm.length;
  while (true) { const pos = pText.indexOf(searchTerm, start); if (pos === -1) break; ranges.push([pos, pos + tl]); start = pos + tl; }
  return ranges;
}

function findListNumIds(zipEntries) {
  const result = { bullet: null, number: null };
  const entry = zipEntries.find(e => e.entryName === "word/numbering.xml");
  if (!entry) return result;
  try {
    const root = _parse(entry.getData());
    const abstractFmt = {};
    for (const an of _childElements(root.documentElement, NS.w, "abstractNum")) {
      const aid = _getAttrNS(an, NS.w, "abstractNumId"); let lvl0 = null;
      for (const l of _childElements(an, NS.w, "lvl")) { if (_getAttrNS(l, NS.w, "ilvl") === "0") { lvl0 = l; break; } }
      if (!lvl0) continue;
      const nf = _firstChildElement(lvl0, NS.w, "numFmt");
      abstractFmt[aid] = nf ? _getAttrNS(nf, NS.w, "val") : null;
    }
    for (const num of _childElements(root.documentElement, NS.w, "num")) {
      const numId = _getAttrNS(num, NS.w, "numId");
      const ar = _firstChildElement(num, NS.w, "abstractNumId"); if (!ar) continue;
      const fv = abstractFmt[_getAttrNS(ar, NS.w, "val")];
      if (fv === "bullet" && result.bullet == null) result.bullet = numId;
      else if ((fv === "decimal" || fv === "decimalZero") && result.number == null) result.number = numId;
    }
  } catch (e) {}
  return result;
}

function findReturnBlockIndices(paragraphTexts) {
  const block = new Set();
  for (let i = 0; i < paragraphTexts.length; i++) {
    const t = paragraphTexts[i]; if (!t || !RETURN_BLOCK_HEADER_RE.test(t)) continue;
    block.add(i);
    for (let j = i + 1; j < Math.min(paragraphTexts.length, i + 1 + RETURN_BLOCK_MAX_LINES); j++) {
      const f = paragraphTexts[j]; if (f && f.length > RETURN_BLOCK_MAX_LINE_LEN) break; block.add(j);
    }
  }
  return block;
}

function resolvePlaceholderRole(content, inReturnBlock) {
  if (!inReturnBlock) return content;
  return RETURN_BLOCK_ROLE_NAMES[content.trim().toLowerCase()] || content;
}

function flattenStoryParagraphs(paragraphs) { return paragraphs.map(p => rebuildCharMapping(p)); }

function processXmlStory(xmlContent, fieldInfoMap, unbracketedFields, storeItemId, listNumIds, imageEmbedder) {
  if (!unbracketedFields) unbracketedFields = [];
  const root = _parse(xmlContent);
  const paragraphs = [];
  const walk = (node) => {
    if (node.nodeType !== 1) return; // xmldom: text nodes have childNodes === null
    if (node.namespaceURI === NS.w && node.localName === "p") paragraphs.push(node);
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  };
  walk(root.documentElement);
  let modified = false;
  const parentMap = new Map();
  const bpm = (node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const c = node.childNodes[i]; if (c.nodeType === 1) { parentMap.set(c, node); bpm(c); }
    }
  };
  bpm(root.documentElement);
  const paraData = flattenStoryParagraphs(paragraphs);
  const returnBlock = findReturnBlockIndices(paraData.map(([text]) => text));
  for (let idx = 0; idx < paragraphs.length; idx++) {
    const p = paragraphs[idx]; const [pText, charMapping] = paraData[idx]; if (!pText) continue;
    const inRB = returnBlock.has(idx); const placeholdersInP = [];
    for (const [S, E, content] of findHighlightedBracketGroups(pText, charMapping)) {
      placeholdersInP.push([S, E, resolvePlaceholderRole(content, inRB), true]);
    }
    for (const uf of unbracketedFields) {
      const st = uf.search; const lr = findLiteralRanges(pText, st);
      for (const [S, E] of lr) {
        let overlap = false;
        for (const [bS, bE] of placeholdersInP) { if (!(E <= bS || S >= bE)) { overlap = true; break; } }
        if (!overlap) placeholdersInP.push([S, E, st, false]);
      }
    }
    if (placeholdersInP.length) {
      if (placeholdersInP.length === 1) {
        const [S, E, content] = placeholdersInP[0];
        const info = fieldInfoMap[content];
        if (info && info.isRichtext && S === 0 && E === pText.length) {
          const fieldId = info.idGenerator();
          const blocks = info.richtextBlocks;
          if (!blocks || !blocks.length) {
            info.richtextBlocks = [{ type: "paragraph", runs: [{ text: info.value || "[" + info.title + "]" }] }];
          }
          const replaced = replaceParagraphWithRichtextBlock(p, parentMap, info.richtextBlocks || [{ type: "paragraph", runs: [{ text: info.value || "[" + info.title + "]" }] }], info.title, info.tag, fieldId, listNumIds, imageEmbedder);
          if (replaced) { modified = true; continue; }
        }
      }
      const ms = [...placeholdersInP].sort((a, b) => b[0] - a[0]);
      const pictureFields = [];
      for (const [S, E, content] of ms) {
        const info = fieldInfoMap[content]; if (!info) continue;
        const fieldId = info.idGenerator();
        const hasPics = _fieldHasPictures(info);
        const inlineValue = _picturesOnlyText(info) || info.value;
        replacePlaceholderInParagraph(p, S, E, content, info.title, info.tag, fieldId, info.type, info.choices, storeItemId, inlineValue, info.isMultiline);
        if (hasPics) pictureFields.push(info);
      }
      // VIPER addition: a photo field that shares its line with other text gets its words in
      // the line and its pictures in their own content control right below the paragraph.
      if (pictureFields.length) insertPictureParagraphsAfter(p, parentMap, pictureFields.reverse(), listNumIds, imageEmbedder);
      modified = true;
    }
  }
  if (!modified) return null;
  return Buffer.from(_serialize(root), "utf-8");
}

// VIPER addition: photo fields carry pictures as image-only blocks (never probable-cause fields).
function _fieldHasPictures(info) {
  return !!info && !isPcStatementField(info.title) && _imageOnlyBlocks(info.richtextBlocks).length > 0;
}
// Text shown for a photo field that has pictures but no words; "" otherwise.
function _picturesOnlyText(info) {
  return _fieldHasPictures(info) && !String(info.value || "").trim() ? "(see photo below)" : "";
}

function stripDaApprovalSection(xmlContent) {
  const root = _parse(xmlContent);
  const body = _firstChildElement(root.documentElement, NS.w, "body");
  if (!body) return xmlContent;
  const children = [];
  for (let i = 0; i < body.childNodes.length; i++) children.push(body.childNodes[i]);
  let targetIdx = null;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.nodeType === 1 && c.namespaceURI === NS.w && c.localName === "p") {
      let text = "";
      const ts = c.getElementsByTagNameNS(NS.w, "t"); // .//w:t (descendants), as app.py
      for (let k = 0; k < ts.length; k++) text += ts[k].textContent || "";
      if (text.toLowerCase().includes("approved as to form")) { targetIdx = i; break; }
    }
  }
  if (targetIdx == null) return xmlContent;
  for (const c of children.slice(targetIdx)) {
    if (!(c.nodeType === 1 && c.namespaceURI === NS.w && c.localName === "sectPr")) _removeChild(body, c);
  }
  return Buffer.from(_serialize(root), "utf-8");
}

function convertDocx(fileBytes, placeholders, opts) {
  opts = opts || {};
  const unbracketedFields = opts.unbracketedFields || [];
  const values = opts.values || {};
  const removeDaApprovalSection = opts.removeDaApprovalSection || false;
  const richtextBlocks = opts.richtextBlocks || {};
  const protect = opts.protect !== false;
  const randomInt = opts.randomInt || _rndInt;
  const newGuid = opts.newGuid || _newGuid;

  const fieldInfoMap = {};
  const usedTags = new Set();
  const isDict = placeholders && typeof placeholders === "object" && !Array.isArray(placeholders);
  const pNames = isDict ? Object.keys(placeholders) : (placeholders || []);

  for (const pName of pNames.sort()) {
    let title, tag, fieldType, choices, ci = {};
    if (isDict) {
      ci = placeholders[pName] || {};
      title = ci.title || pName; tag = ci.tag || sanitizeTagName(pName);
      fieldType = ci.type || "text"; choices = ci.choices || [];
    } else {
      title = pName; const baseTag = sanitizeTagName(pName); tag = baseTag; let c = 1;
      while (usedTags.has(tag)) { tag = baseTag + "_" + c; c++; }
      fieldType = "text"; choices = [];
    }
    usedTags.add(tag);
    const makeIdGen = () => { const usedIds = new Set(); return () => { while (true) { const v = randomInt(); if (!usedIds.has(v)) { usedIds.add(v); return v; } } }; };
    const cleanValue = sanitizeXmlText(values[pName]);
    fieldInfoMap[pName] = {
      title, tag, type: fieldType, choices,
      idGenerator: makeIdGen(),
      value: cleanValue,
      // The original only ever sends blocks for probable-cause fields; VIPER also sends them for
      // photo fields that carry a picture, so supplied blocks make a field rich text too.
      isRichtext: (ci.richtext != null ? !!ci.richtext : isPcStatementField(title)) || (Array.isArray(richtextBlocks[pName]) && richtextBlocks[pName].length > 0),
      isMultiline: (ci.multiline != null ? !!ci.multiline : (isLongNarrativeField(title) || isLongNarrativeField(pName))) || /\n/.test(cleanValue || ""),
      richtextBlocks: richtextBlocks[pName]
    };
  }

  const customXmlDoc = new DOMParser().parseFromString("<root/>", "application/xml");
  const customXmlRoot = customXmlDoc.documentElement;
  customXmlRoot.setAttribute("xmlns", CUSTOM_XML_SCHEMA_URI);
  const addedTags = new Set();
  for (const [pName, info] of Object.entries(fieldInfoMap)) {
    const tag = info.tag;
    if (!addedTags.has(tag)) {
      const child = customXmlDoc.createElementNS(CUSTOM_XML_SCHEMA_URI, tag);
      // Word refreshes bound controls from this part when the file opens, so a pictures-only
      // photo field must carry the same "(see photo below)" text here as in the document.
      child.textContent = _picturesOnlyText(info) || info.value || "[" + info.title + "]";
      customXmlRoot.appendChild(child); addedTags.add(tag);
    }
  }
  const customXmlContent = Buffer.from(_serialize(customXmlDoc), "utf-8");

  const customGuid = newGuid();
  const propsDoc = new DOMParser().parseFromString("<root/>", "application/xml");
  const propsRoot = _elNS(propsDoc, NS.ds, "ds:datastoreItem");
  _setAttrNS(propsRoot, NS.ds, "ds:itemID", customGuid);
  const schemaRefs = _elNS(propsDoc, NS.ds, "ds:schemaRefs");
  const schemaRef = _elNS(propsDoc, NS.ds, "ds:schemaRef");
  _setAttrNS(schemaRef, NS.ds, "ds:uri", CUSTOM_XML_SCHEMA_URI);
  schemaRefs.appendChild(schemaRef); propsRoot.appendChild(schemaRefs);
  propsDoc.documentElement.appendChild(propsRoot);
  let serProps = _serialize(propsDoc);
  serProps = serProps.replace(/<\?xml[^?]*\?>/, "").trim();
  serProps = serProps.replace(/^<root>/, "").replace(/<\/root>$/, "").trim();
  if (!serProps.startsWith("<?xml")) serProps = '<?xml version="1.0" encoding="UTF-8"?>\n' + serProps;
  const customPropsContent = Buffer.from(serProps, "utf-8");

  const inZip = new AdmZip(fileBytes);
  const outZip = new AdmZip();
  const inEntries = inZip.getEntries();
  const entryMap = new Map(inEntries.map(e => [e.entryName, e]));
  const listNumIds = findListNumIds(inEntries);

  const ridVals = [];
  const relsEntry = entryMap.get("word/_rels/document.xml.rels");
  if (relsEntry) {
    try {
      const relsRoot = _parse(relsEntry.getData());
      for (const rel of _childElements(relsRoot.documentElement, NS.rels, "Relationship")) {
        const rid = rel.getAttribute("Id");
        if (rid && rid.startsWith("rId")) { const n = parseInt(rid.slice(3), 10); if (!isNaN(n)) ridVals.push(n); }
      }
    } catch (e) {}
  }
  const ridCounter = [ridVals.length ? Math.max(...ridVals) + 1 : 999];
  const imageEmbedder = new ImageEmbedder(inEntries.map(e => e.entryName), ridCounter);

  const storyFiles = ["word/document.xml"];
  for (const e of inEntries) { if (e.entryName.startsWith("word/header") || e.entryName.startsWith("word/footer")) storyFiles.push(e.entryName); }

  for (const e of inEntries) {
    const n = e.entryName;
    if (n === "[Content_Types].xml" || n === "word/_rels/document.xml.rels" || n === "word/settings.xml" || storyFiles.includes(n)) continue;
    outZip.addFile(n, e.getData());
  }

  const settingsEntry = entryMap.get("word/settings.xml");
  if (settingsEntry) { outZip.addFile("word/settings.xml", protect ? addFormsProtection(settingsEntry.getData()) : removeProtection(settingsEntry.getData())); }

  for (const name of storyFiles) {
    const entry = entryMap.get(name); if (!entry) continue;
    let xmlContent = entry.getData();
    if (name === "word/document.xml" && removeDaApprovalSection) xmlContent = stripDaApprovalSection(xmlContent);
    const newXml = processXmlStory(xmlContent, fieldInfoMap, unbracketedFields, customGuid, listNumIds, imageEmbedder);
    outZip.addFile(name, newXml || xmlContent);
  }

  for (const [ap, ib] of imageEmbedder.mediaFiles) outZip.addFile(ap, ib);

  let nextItem = 1;
  for (const e of inEntries) {
    const m = e.entryName.match(/^customXml\/itemProps(\d+)\.xml$/);
    if (m) nextItem = Math.max(nextItem, parseInt(m[1], 10) + 1);
  }

  outZip.addFile("customXml/item" + nextItem + ".xml", customXmlContent);
  outZip.addFile("customXml/itemProps" + nextItem + ".xml", customPropsContent);

  const itemRelsDoc = new DOMParser().parseFromString("<Relationships/>", "application/xml");
  const itemRelsRoot = itemRelsDoc.documentElement;
  itemRelsRoot.setAttribute("xmlns", NS.rels);
  const itemRel = _elNS(itemRelsDoc, NS.rels, "Relationship");
  itemRel.setAttribute("Id", "rId1");
  itemRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps");
  itemRel.setAttribute("Target", "itemProps" + nextItem + ".xml");
  itemRelsRoot.appendChild(itemRel);
  outZip.addFile("customXml/_rels/item" + nextItem + ".xml.rels", Buffer.from(_serialize(itemRelsDoc), "utf-8"));

  const typesEntry = entryMap.get("[Content_Types].xml");
  if (typesEntry) {
    const typesRoot = _parse(typesEntry.getData());
    const typesEl = typesRoot.documentElement;
    // Reuse the root's own prefix (normally none / default namespace) so the added elements
    // don't each carry a redundant xmlns:ct declaration.
    const ctQ = (local) => (typesEl.prefix ? typesEl.prefix + ":" : "") + local;
    const op = _elNS(typesRoot, NS.ct, ctQ("Override"));
    op.setAttribute("PartName", "/customXml/itemProps" + nextItem + ".xml");
    op.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.customXmlProperties+xml");
    typesEl.appendChild(op);
    const ox = _elNS(typesRoot, NS.ct, ctQ("Override"));
    ox.setAttribute("PartName", "/customXml/item" + nextItem + ".xml");
    ox.setAttribute("ContentType", "application/xml");
    typesEl.appendChild(ox);
    if (imageEmbedder.usedExts.size) {
      const existing = new Set();
      for (const d of _childElements(typesEl, NS.ct, "Default")) existing.add((d.getAttribute("Extension") || "").toLowerCase());
      for (const ext of imageEmbedder.usedExts) {
        if (!existing.has(ext.toLowerCase())) {
          const de = _elNS(typesRoot, NS.ct, ctQ("Default"));
          de.setAttribute("Extension", ext); de.setAttribute("ContentType", "image/" + ext);
          typesEl.appendChild(de); existing.add(ext.toLowerCase());
        }
      }
    }
    outZip.addFile("[Content_Types].xml", Buffer.from(_serialize(typesRoot), "utf-8"));
  }

  if (relsEntry) {
    const relsRoot = _parse(relsEntry.getData());
    const relsEl = relsRoot.documentElement;
    const nr = _elNS(relsRoot, NS.rels, "Relationship");
    nr.setAttribute("Id", "rId" + ridCounter[0]); ridCounter[0] += 1;
    nr.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml");
    nr.setAttribute("Target", "../customXml/item" + nextItem + ".xml");
    relsEl.appendChild(nr);
    for (const [imgRid, imgTarget] of imageEmbedder.newRels) {
      const ir = _elNS(relsRoot, NS.rels, "Relationship");
      ir.setAttribute("Id", imgRid); ir.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
      ir.setAttribute("Target", imgTarget); relsEl.appendChild(ir);
    }
    outZip.addFile("word/_rels/document.xml.rels", Buffer.from(_serialize(relsRoot), "utf-8"));
  }

  return outZip.toBuffer();
}

function buildPacket(templates, opts) {
  opts = opts || {};
  const unbracketedFields = opts.unbracketedFields || [];
  const removeDaApprovalSection = opts.removeDaApprovalSection || false;
  const packetFilename = opts.packetFilename || "";
  const now = opts.now || new Date();
  const built = []; const usedNames = new Set();
  for (const t of templates) {
    const packetBytes = convertDocx(t.fileBytes, t.placeholders || {}, {
      unbracketedFields, values: t.values || {}, removeDaApprovalSection,
      richtextBlocks: t.richtextBlocks || {}, protect: false
    });
    const fallback = (t.filename || "template").replace(/\.docx$/i, "") + "_packet.docx";
    const outFilename = uniquifyFilename(sanitizeOutputFilename(t.outFilename, fallback), usedNames);
    built.push([outFilename, packetBytes]);
  }
  if (built.length === 1) {
    return { filename: built[0][0], data: built[0][1], mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  const zip = new AdmZip();
  for (const [fn, data] of built) zip.addFile(fn, data);
  let pn = String(packetFilename || "").trim().replace(_FILENAME_ILLEGAL_RE, "").replace(/^[. ]+|[. ]+$/g, "");
  if (!pn) {
    const ts = now instanceof Date ? now : new Date(now);
    const pad = n => String(n).padStart(2, "0");
    pn = "Warrant_Packet_" + ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + "_" + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
  }
  if (pn.toLowerCase().endsWith(".zip")) pn = pn.slice(0, -4);
  return { filename: pn.slice(0, MAX_OUTPUT_FILENAME_STEM) + ".zip", data: zip.toBuffer(), mimetype: "application/zip" };
}

function _sdtRunsToBlocks(sdtContent) {
  const blocks = [];
  const ps = sdtContent.getElementsByTagNameNS(NS.w, "p"); // .//w:p, as app.py
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    const runs = [];
    for (const r of _childElements(p, NS.w, "r")) {
      const rPr = _firstChildElement(r, NS.w, "rPr");
      const bold = !!(rPr && _firstChildElement(rPr, NS.w, "b"));
      const italic = !!(rPr && _firstChildElement(rPr, NS.w, "i"));
      const underline = !!(rPr && _firstChildElement(rPr, NS.w, "u"));
      for (let i = 0; i < r.childNodes.length; i++) {
        const n = r.childNodes[i]; if (n.nodeType !== 1) continue;
        if (n.localName === "t" && n.textContent) runs.push({ text: n.textContent, bold, italic, underline });
        else if (n.localName === "br") runs.push({ break: true });
      }
    }
    blocks.push({ type: "paragraph", runs });
  }
  while (blocks.length && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return blocks;
}

function extractValuesFromDocx(fileBytes) {
  const values = {}, richtextBlocks = {}, aliases = {}, pendingRichtext = {};
  const zip = new AdmZip(fileBytes);
  const names = zip.getEntries().map(e => e.entryName);
  for (const name of names) {
    const m = name.match(/^customXml\/item\d+\.xml$/); if (!m) continue;
    try {
      const root = _parse(zip.readAsText(name));
      if (root.documentElement.namespaceURI !== CUSTOM_XML_SCHEMA_URI || root.documentElement.localName !== "root") continue;
      for (let i = 0; i < root.documentElement.childNodes.length; i++) {
        const c = root.documentElement.childNodes[i]; if (c.nodeType === 1) { const t = c.textContent || ""; if (t.trim()) values[c.localName] = t; }
      }
    } catch (e) {}
  }
  const storyFiles = ["word/document.xml", ...names.filter(n => n.startsWith("word/header") || n.startsWith("word/footer"))];
  for (const fileName of storyFiles) {
    if (!names.includes(fileName)) continue;
    try {
      const root = _parse(zip.readAsText(fileName));
      const walk = (node) => {
        if (node.nodeType !== 1) return; // xmldom: text nodes have childNodes === null
        if (node.namespaceURI === NS.w && node.localName === "sdt") {
          const sdtPr = _firstChildElement(node, NS.w, "sdtPr"); if (!sdtPr) return;
          const tagEl = _firstChildElement(sdtPr, NS.w, "tag"); if (!tagEl) return;
          const tag = _getAttrNS(tagEl, NS.w, "val"); if (!tag) return;
          const aliasEl = _firstChildElement(sdtPr, NS.w, "alias");
          if (aliasEl && !aliases[tag]) aliases[tag] = _getAttrNS(aliasEl, NS.w, "val") || tag;
          if (_firstChildElement(sdtPr, NS.w, "dataBinding")) return;
          const content = _firstChildElement(node, NS.w, "sdtContent"); if (!content) return;
          const blocks = _sdtRunsToBlocks(content);
          const plain = blocks.map(b => b.runs.map(r => r.text || "").join("")).join("\n").trim();
          if (plain) pendingRichtext[tag] = [blocks, plain];
        }
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      };
      walk(root.documentElement);
    } catch (e) {}
  }
  function _isUnfilledSeed(tag, text) { const a = aliases[tag]; const t = text.trim(); return (a != null && t === "[" + a + "]") || t === "{{" + tag + "}}"; }
  const outValues = {};
  for (const [tag, text] of Object.entries(values)) { if (!_isUnfilledSeed(tag, text)) outValues[tag] = text; }
  for (const [tag, [blocks, plain]] of Object.entries(pendingRichtext)) {
    if (_isUnfilledSeed(tag, plain)) continue;
    richtextBlocks[tag] = blocks; if (!outValues[tag]) outValues[tag] = plain;
  }
  return { values: outValues, richtextBlocks, aliases };
}

// ---------------------------------------------------------------------------------------------
// Placeholder scanning (port of the partner tool's scan_placeholders + extract_context_snippet).
// Used when an officer adds a Word template to a pack: finds every highlighted [Field name].
// ---------------------------------------------------------------------------------------------
const PRECEDING_CONTEXT_CHARS = 90;
const CONTEXT_ELLIPSIS = "\u2026";
const CONTEXT_LINE_MARK = "\u23CE";

function extractContextSnippet(pText, S, E, window, preceding) {
  if (window == null) window = 110;
  const start = Math.max(0, S - window);
  const end = Math.min(pText.length, E + window);
  const prefix = start > 0 ? CONTEXT_ELLIPSIS : "";
  const suffix = end < pText.length ? CONTEXT_ELLIPSIS : "";
  let snippet = (prefix + pText.slice(start, end) + suffix).trim();
  if (preceding && snippet.length <= (E - S) + 4) {
    let lead = preceding.trim();
    if (lead.length > PRECEDING_CONTEXT_CHARS) lead = CONTEXT_ELLIPSIS + lead.slice(-PRECEDING_CONTEXT_CHARS);
    snippet = lead + " " + CONTEXT_LINE_MARK + " " + snippet;
  }
  return snippet;
}

function _storyParagraphs(root) {
  const paragraphs = [];
  const walk = (node) => {
    if (node.nodeType !== 1) return; // xmldom: text nodes have childNodes === null
    if (node.namespaceURI === NS.w && node.localName === "p") paragraphs.push(node);
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  };
  walk(root.documentElement);
  return paragraphs;
}

function _unhighlightedBracketTexts(pText, charMapping) {
  // Outermost [..] groups with no highlighting at all: VIPER leaves these alone, which is almost
  // always a template the author forgot to highlight. Reported so the editor can say so.
  const out = [];
  for (const [S, E] of findBracketRanges(pText)) {
    const content = pText.slice(S + 1, E - 1).trim(); if (!content) continue;
    let hl = false;
    for (let ci = S; ci < E && !hl; ci++) if (_charIsHighlighted(charMapping, ci)) hl = true;
    if (!hl) out.push(content);
  }
  return out;
}

/**
 * Scan a .docx for its fill-in fields.
 * Returns { placeholders: [{name, count, context}] (document order, keyed like the partner tool),
 *           unhighlighted: [text] (bracketed text Word has no highlight on — VIPER ignores it),
 *           unclosed: [snippet] ('[' never closed and not recoverable), stories: n }.
 */
function scanTemplate(fileBytes, unbracketedFields) {
  if (!unbracketedFields) unbracketedFields = [];
  const found = new Map();
  const unhighlighted = new Set();
  const unclosed = [];
  let zip;
  try { zip = new AdmZip(fileBytes); } catch (e) { throw new Error("Not a Word (.docx) file."); }
  const names = zip.getEntries().map(e => e.entryName);
  if (!names.includes("word/document.xml")) throw new Error("Not a Word (.docx) file.");
  const storyFiles = ["word/document.xml", ...names.filter(n => n.startsWith("word/header") || n.startsWith("word/footer"))];
  let stories = 0;
  for (const fileName of storyFiles) {
    let root;
    try { root = _parse(zip.getEntry(fileName).getData()); } catch (e) { continue; }
    stories++;
    const paraData = flattenStoryParagraphs(_storyParagraphs(root));
    const returnBlock = findReturnBlockIndices(paraData.map(([t]) => t));
    let preceding = null;
    for (let idx = 0; idx < paraData.length; idx++) {
      const [pText, charMapping] = paraData[idx];
      if (!pText) continue;
      const inRB = returnBlock.has(idx);
      const bracketMatches = [];
      const groups = findHighlightedBracketGroups(pText, charMapping);
      for (const [S, E, content] of groups) {
        const key = resolvePlaceholderRole(content, inRB);
        if (!found.has(key)) found.set(key, { name: key, count: 0, context: extractContextSnippet(pText, S, E, 110, preceding) });
        found.get(key).count++;
        bracketMatches.push([S, E]);
      }
      for (const uf of unbracketedFields) {
        const term = uf && uf.search; if (!term) continue;
        const valid = findLiteralRanges(pText, term).filter(([S, E]) => !bracketMatches.some(([bS, bE]) => !(E <= bS || S >= bE)));
        if (valid.length) {
          if (!found.has(term)) found.set(term, { name: term, count: 0, context: extractContextSnippet(pText, valid[0][0], valid[0][1], 110, preceding) });
          found.get(term).count += valid.length;
        }
      }
      for (const t of _unhighlightedBracketTexts(pText, charMapping)) unhighlighted.add(t);
      const opens = findUnmatchedBracketOpens(pText);
      for (const u of opens) {
        const covered = groups.some(([S, E]) => u >= S && u < E);
        if (!covered) unclosed.push(extractContextSnippet(pText, u, Math.min(pText.length, u + 1), 40, null));
      }
      preceding = pText;
    }
  }
  return { placeholders: [...found.values()], unhighlighted: [...unhighlighted], unclosed, stories };
}

/** Partner-compatible shape: { name: {count, context} } in discovery order. */
function scanPlaceholders(fileBytes, unbracketedFields) {
  const out = {};
  for (const p of scanTemplate(fileBytes, unbracketedFields).placeholders) out[p.name] = { count: p.count, context: p.context };
  return out;
}

module.exports = {
  scanTemplate,
  scanPlaceholders,
  extractContextSnippet,
  convertDocx,
  buildPacket,
  extractValuesFromDocx,
  sanitizeTagName,
  sanitizeOutputFilename,
  uniquifyFilename,
  sanitizeXmlText,
  isPcStatementField,
  isLongNarrativeField,
  stripDaApprovalSection,
};
