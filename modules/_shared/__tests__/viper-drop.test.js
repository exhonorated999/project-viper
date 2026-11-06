/**
 * Tests for modules/_shared/viper-drop.js
 * Run: node modules/_shared/__tests__/viper-drop.test.js
 *
 * Field request (Nov 2026): drag a photo onto Personal Information instead of
 * save-then-import, and paste snips. ViperDrop routes a drop/paste to the one
 * upload in the nearest section, respecting accept=. The DOM here is a tiny
 * fake (parentElement / tagName / getAttribute / classList / querySelectorAll).
 */
const D = require('../viper-drop');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(actual, expected, name) {
  const s = (v) => { try { return JSON.stringify(v); } catch (_) { return v && v.tagName ? '<' + v.tagName + '>' : String(v); } };
  ok(actual === expected, name + ` (got ${s(actual)}, want ${s(expected)})`);
}

// ── 1. accept matching ─────────────────────────────────────────────────
ok(D.acceptOk('', { name: 'a.exe', type: '' }), 'empty accept takes anything');
ok(D.acceptOk('image/*', { name: 'snip.png', type: 'image/png' }), 'image/* takes png');
ok(!D.acceptOk('image/*', { name: 'warrant.pdf', type: 'application/pdf' }), 'image/* refuses pdf');
ok(D.acceptOk('image/*', { name: 'IMG_0001.JPG', type: '' }), 'image/* takes .JPG with no MIME');
ok(D.acceptOk('.pdf', { name: 'Warrant.PDF', type: 'application/pdf' }), '.pdf case-insensitive');
ok(!D.acceptOk('.pdf', { name: 'photo.png', type: 'image/png' }), '.pdf refuses png');
ok(D.acceptOk('.pdf,.html,.htm,.zip', { name: 'report.zip', type: '' }), 'list: zip');
ok(D.acceptOk('image/png,image/jpeg', { name: 'x.jpg', type: 'image/jpeg' }), 'exact MIME');
ok(!D.acceptOk('image/png,image/jpeg', { name: 'x.gif', type: 'image/gif' }), 'exact MIME refuses gif');
ok(D.acceptOk('.pdf,.doc,.docx,image/*', { name: 'plan.docx', type: '' }), 'mixed list: docx');

// dragover: only the MIME type is known
ok(D.acceptOk('.pdf', { name: '', type: 'application/pdf' }), 'dragover pdf → .pdf');
ok(!D.acceptOk('.pdf', { name: '', type: 'image/png' }), 'dragover png → not .pdf');
ok(D.acceptOk('.csv', { name: '', type: 'application/vnd.ms-excel' }), 'dragover: Windows reports .csv as ms-excel');
ok(D.acceptOk('.mbox,.eml', { name: '', type: 'application/octet-stream' }), 'dragover: unknown extension → allowed (checked on drop)');
ok(D.acceptOk('image/*', { name: '', type: '' }), 'dragover: no type → maybe');
ok(D.typesOk('image/*', ['application/pdf', 'image/png']), 'typesOk: any fits');
ok(!D.typesOk('image/*', ['application/pdf']), 'typesOk: none fits');
ok(D.typesOk('image/*', []), 'typesOk: unknown list → allowed');

ok(D.acceptsImages('image/*') && D.acceptsImages('') && D.acceptsImages('.png,.pdf'), 'acceptsImages yes');
ok(!D.acceptsImages('.pdf') && !D.acceptsImages('.csv,.tsv,.txt'), 'acceptsImages no');

// ── 2. pick ────────────────────────────────────────────────────────────
const fPng = { name: 'a.png', type: 'image/png' }, fJpg = { name: 'b.jpg', type: 'image/jpeg' }, fPdf = { name: 'c.pdf', type: 'application/pdf' };
let p = D.pick('image/*', false, [fPdf, fPng, fJpg]);
eq(p.ok.length, 1, 'single: one file'); ok(p.ok[0] === fPng, 'single: first accepted');
eq(p.rejected.length, 1, 'single: pdf rejected'); eq(p.extra, 1, 'single: one extra image ignored');
p = D.pick('image/*', true, [fPdf, fPng, fJpg]);
eq(p.ok.length, 2, 'multiple: both images'); eq(p.extra, 0, 'multiple: no extra');
p = D.pick('', true, [fPdf, fPng]);
eq(p.ok.length, 2, 'no accept: all');

// ── 3. pasted names / descriptions ─────────────────────────────────────
eq(D.pastedName('image/png', new Date(2026, 10, 5, 9, 3, 7)), 'pasted-image-2026-11-05_09-03-07.png', 'pasted name png');
eq(D.pastedName('image/jpeg', new Date(2026, 0, 1, 0, 0, 0)), 'pasted-image-2026-01-01_00-00-00.jpg', 'pasted name jpg');
eq(D.pastedName('', new Date(2026, 0, 1, 0, 0, 0)), 'pasted-image-2026-01-01_00-00-00.png', 'pasted name default png');
eq(D.describeAccept('image/*'), 'an image', 'describe image');
eq(D.describeAccept(''), 'any file', 'describe any');
eq(D.describeAccept('.pdf'), 'PDF', 'describe pdf');
eq(D.describeAccept('.csv,.tsv'), 'CSV, TSV', 'describe list');

// ── 4. resolve (fake DOM) ──────────────────────────────────────────────
class El {
  constructor(tag, attrs, kids) {
    this.tagName = tag.toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentElement = null;
    this.classList = { contains: (c) => String(this.attrs.class || '').split(/\s+/).indexOf(c) >= 0 };
    if (this.tagName === 'INPUT') { this.type = this.attrs.type || 'text'; this.accept = this.attrs.accept || ''; this.multiple = 'multiple' in this.attrs; this.disabled = 'disabled' in this.attrs; }
    (kids || []).forEach(k => this.add(k));
  }
  add(k) { k.parentElement = this; this.children.push(k); return k; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  querySelectorAll(sel) {
    if (sel !== 'input[type="file"]') throw new Error('unexpected selector ' + sel);
    const out = [];
    const walk = (n) => n.children.forEach(c => { if (c.tagName === 'INPUT' && c.type === 'file') out.push(c); walk(c); });
    walk(this);
    return out;
  }
}
const h = (tag, attrs, ...kids) => new El(tag, attrs, kids);

// Suspect modal: two photo uploads, each in its own section
const photoIn = h('input', { type: 'file', accept: 'image/*' });
const resIn = h('input', { type: 'file', accept: 'image/*' });
const photoUrl = h('input', { type: 'text', name: 'photo' });
const nameIn = h('input', { type: 'text', name: 'name' });
const photoSec = h('div', { class: 'col-span-2' }, h('label', {}), photoUrl, photoIn);
const grid = h('div', { class: 'grid' }, photoSec, nameIn);
const resSec = h('div', {}, h('input', { type: 'text', name: 'residencePhoto' }), resIn);
const form = h('form', {}, grid, h('div', {}, resSec));
const card = h('div', { class: 'glass-card' }, form);
const body = h('body', {}, h('div', { class: 'fixed' }, card));
void body;

let r = D.resolve(photoUrl, { types: ['image/png'] });
ok(r && r.kind === 'input' && r.input === photoIn, 'photo URL field → photo upload');
eq(r && r.zone, photoSec, 'zone = photo section');
r = D.resolve(photoIn, { types: ['image/png'] });
ok(r && r.input === photoIn, 'drop on the input itself');
r = D.resolve(nameIn, { types: ['image/png'] });
ok(r && r.input === photoIn, 'name field: nearest section with one upload is the photo');
r = D.resolve(resSec.children[0], { types: ['image/png'] });
ok(r && r.input === resIn, 'residence field → residence upload');
r = D.resolve(form, { types: ['image/png'] });
eq(r, null, 'form level: two uploads → ambiguous → nothing');
r = D.resolve(photoUrl, { types: ['application/pdf'] });
ok(r && r.kind === 'reject', 'pdf onto image upload → reject');

// Hidden input + button (warrant upload pattern)
const wIn = h('input', { type: 'file', accept: '.pdf', class: 'hidden' });
const wBtn = h('button', {}, h('span', {}));
const wSec = h('div', {}, h('label', {}), wIn, wBtn);
const wCard = h('div', { class: 'glass-card' }, h('div', {}, h('input', { type: 'text' })), wSec);
h('body', {}, h('div', {}, wCard));
r = D.resolve(wBtn.children[0], { types: ['application/pdf'] });
ok(r && r.input === wIn, 'button text → hidden pdf input');

// Boundary: a glass-card without uploads does not reach a sibling card's upload
const viewPhoto = h('div', {}, h('img', {}));
const infoCard = h('div', { class: 'glass-card' }, viewPhoto);
const otherCard = h('div', { class: 'glass-card' }, h('input', { type: 'file', accept: 'image/*' }));
h('body', {}, h('div', { id: 'viewerContent' }, h('div', {}, infoCard, otherCard)));
eq(D.resolve(viewPhoto.children[0], { types: ['image/png'] }), null, 'boundary: card without upload → nothing');

// Explicit zones
let got = null;
D.define('inlinePhoto', { accept: 'image/*', onFiles: (f, z) => { got = z; } });
D.define('evidence', { multiple: true, folders: true, paste: false, onFiles: () => {} });
const frame = h('div', { 'data-vdrop': 'inlinePhoto' }, h('img', {}));
const editIn = h('input', { type: 'file', accept: 'image/*' });
const pCard = h('div', { class: 'glass-card' }, h('div', {}, frame, editIn));
h('body', {}, pCard);
r = D.resolve(frame.children[0], { types: ['image/png'] });
ok(r && r.kind === 'spec' && r.name === 'inlinePhoto' && r.zone === frame, 'photo frame → inlinePhoto zone');
r = D.resolve(frame.children[0], { types: ['application/pdf'] });
ok(r && r.kind === 'reject', 'pdf onto photo frame → reject');
r = D.resolve(editIn, { types: ['image/png'] });
ok(r && r.kind === 'input' && r.input === editIn, 'edit-mode input next to frame still works');
r = D.resolve(frame, { types: ['image/png'], paste: true });
ok(r && r.kind === 'spec', 'paste allowed on photo frame');
void got;

const evZone = h('div', { 'data-vdrop': 'evidence' }, h('button', {}));
h('body', {}, h('form', {}, evZone));
r = D.resolve(evZone.children[0], { types: ['application/pdf', ''] });
ok(r && r.kind === 'spec' && r.name === 'evidence', 'evidence buttons → evidence zone');
eq(D.resolve(evZone.children[0], { types: ['image/png'], paste: true }), null, 'evidence: no paste');

// Opt-out and undefined zone names
const offIn = h('input', { type: 'file' });
const offSec = h('div', { 'data-vdrop': 'off' }, offIn);
h('body', {}, h('form', {}, offSec));
eq(D.resolve(offIn, { types: [''] }), null, 'data-vdrop="off" switches a section off');
const offInside = h('input', { type: 'file' });
const keepIn = h('input', { type: 'file' });
const mixSec = h('div', {}, h('div', { 'data-vdrop': 'off' }, offInside), keepIn);
h('body', {}, h('form', {}, mixSec));
r = D.resolve(mixSec, { types: [''] });
ok(r && r.input === keepIn, 'inputs inside an off subtree are not counted');
const disIn = h('input', { type: 'file', disabled: '' });
h('body', {}, h('form', {}, h('div', {}, disIn)));
eq(D.resolve(disIn, { types: [''] }), null, 'disabled input ignored');

// Text node start, body stop
const txtParent = h('div', {}, h('input', { type: 'file' }));
h('body', {}, h('form', {}, txtParent));
r = D.resolve({ nodeType: 3, parentElement: txtParent }, { types: [''] });
ok(r && r.kind === 'input', 'text node start uses its parent');
eq(D.resolve(h('body', {}), { types: [''] }), null, 'body itself → nothing');

let threw = false;
try { D.define('bad', {}); } catch (_) { threw = true; }
ok(threw, 'define needs onFiles');

console.log(`viper-drop: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
