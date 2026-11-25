'use strict';
// Tests for modules/case-forms/fieldwork-sign.js. Every PDF and signature is generated here (SYNTHETIC).
// Run: node modules/case-forms/__tests__/fieldwork-sign.test.js
const crypto = require('crypto');
const zlib = require('zlib');
const { PDFDocument, PDFName } = require('pdf-lib');
const PF = require('../pdf-form.js');
const S = require('../fieldwork-sign.js');
const FS = require('../form-store.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}
async function rejects(p, re, label) {
  try { await p; ok(false, label + ' — did not throw'); } catch (e) { ok(re.test(e.message), label + ' — wrong error: ' + e.message); }
}
function throws(fn, re, label) {
  try { fn(); ok(false, label + ' — did not throw'); } catch (e) { ok(re.test(e.message), label + ' — wrong error: ' + e.message); }
}
const near = (a, b, label, tol) => ok(Math.abs(a - b) <= (tol || 0.0005), label + ' — got ' + a + ', want ' + b);

// ---- a tiny real PNG (w x h, RGBA, one dark pixel row) ----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    if (y === Math.floor(h / 2)) for (let x = 0; x < w; x++) { row[1 + x * 4 + 3] = 255; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const pngUrl = (w, h) => 'data:image/png;base64,' + makePng(w, h).toString('base64');

// ---- a two-page synthetic form with a signature box ----
async function makeForm(opts) {
  const o = opts || {};
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  if (o.crop) p1.setCropBox(36, 36, 540, 720);
  if (o.rotate) p2.setRotation({ type: 'degrees', angle: 90 });
  const form = doc.getForm();
  const t = form.createTextField('Subject.LastName');
  t.addToPage(p1, { x: 72, y: 700, width: 200, height: 20 });
  const pin = form.createTextField('Phone_PIN');
  pin.setMaxLength(6);
  pin.addToPage(p1, { x: 72, y: 650, width: 100, height: 20 });
  const cb = form.createCheckBox('ConsentGiven');
  cb.addToPage(p1, { x: 72, y: 600, width: 12, height: 12 });
  const rg = form.createRadioGroup('Device');
  rg.addOptionToPage('Phone', p1, { x: 72, y: 560, width: 12, height: 12 });
  rg.addOptionToPage('Tablet', p1, { x: 120, y: 560, width: 12, height: 12 });
  const dd = form.createDropdown('Scope');
  dd.addOptions(['Full', 'Limited']);
  dd.addToPage(p1, { x: 72, y: 520, width: 120, height: 18 });
  const ro = form.createTextField('OfficerBadge');
  ro.setText('1234');
  ro.enableReadOnly();
  ro.addToPage(p1, { x: 300, y: 700, width: 100, height: 20 });
  // A signature field: build a text field, then retype it /Sig with a tooltip.
  const sig = form.createTextField('SubjectSignature');
  sig.addToPage(p2, { x: 72, y: 100, width: 240, height: 40 });
  sig.acroField.dict.set(PDFName.of('FT'), PDFName.of('Sig'));
  sig.acroField.dict.set(PDFName.of('TU'), require('pdf-lib').PDFString.of('Signature of Subject'));
  return Buffer.from(await doc.save());
}

const fakeRender = async (bytes, step) => {
  const d = await PDFDocument.load(bytes);
  return d.getPages().map(() => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9, step.quality]), w: 1224, h: 1584 }));
};

(async () => {
  // ------------------------------------------------------------ crypto
  const keyB = crypto.randomBytes(32);
  const mediaKey = keyB.toString('base64url');
  eq(S.keyFrom(mediaKey).length, 32, 'keyFrom: 32 bytes');
  throws(() => S.keyFrom(''), /no usable key/, 'keyFrom: empty');
  throws(() => S.keyFrom(crypto.randomBytes(16).toString('base64url')), /no usable key/, 'keyFrom: short');
  const sealed = S.seal(keyB, Buffer.from('hello'));
  eq(sealed.length, 12 + 5 + 16, 'seal: IV + body + tag');
  eq(S.open(keyB, sealed).toString(), 'hello', 'open round-trips');
  // Same layout WebCrypto produces: IV ‖ ct ‖ tag.
  {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyB, iv);
    const blob = Buffer.concat([iv, c.update('phone'), c.final(), c.getAuthTag()]);
    eq(S.open(keyB, blob).toString(), 'phone', 'open reads the phone layout');
  }
  const tampered = Buffer.from(sealed); tampered[14] ^= 1;
  throws(() => S.open(keyB, tampered), /integrity check/, 'open: tampered refused');
  throws(() => S.open(crypto.randomBytes(32), sealed), /integrity check/, 'open: wrong key refused');
  throws(() => S.open(keyB, Buffer.alloc(20)), /truncated/, 'open: short refused');

  // ------------------------------------------------------------ geometry
  const page = { x: 0, y: 0, width: 612, height: 792 };
  const f = S.toFrac({ x: 61.2, y: 712.8, width: 306, height: 39.6 }, page);
  eq(f, { x: 0.1, y: 0.05, w: 0.5, h: 0.05 }, 'toFrac: top-left origin');
  const back = S.fromFrac(f, page);
  near(back.x, 61.2, 'fromFrac x'); near(back.y, 712.8, 'fromFrac y'); near(back.width, 306, 'fromFrac w'); near(back.height, 39.6, 'fromFrac h');
  const crop = { x: 36, y: 36, width: 540, height: 720 };
  const fc = S.toFrac({ x: 36, y: 736, width: 54, height: 20 }, crop);
  eq([fc.x, fc.y], [0, 0], 'toFrac: crop box origin');
  eq(S.toFrac({ x: -50, y: 780, width: 100, height: 40 }, page).x, 0, 'toFrac clamps off-page boxes');

  // ------------------------------------------------------------ labels
  eq(S.labelFor({ name: 'Subject.LastName[0]' }), 'Last Name', 'label: last part, camel split');
  eq(S.labelFor({ name: 'Phone_PIN' }), 'Phone PIN', 'label: underscores');
  eq(S.labelFor({ name: 'x', tooltip: 'Signature of Subject' }), 'Signature of Subject', 'label: tooltip wins');

  // ------------------------------------------------------------ describe a real form
  const blank = await makeForm();
  const info = await PF.inspect(blank);
  const fields = S.describeFields(info);
  const byName = Object.fromEntries(fields.map(x => [x.name, x]));
  eq(Object.keys(byName).sort(), ['ConsentGiven', 'Device', 'OfficerBadge', 'Phone_PIN', 'Scope', 'Subject.LastName', 'SubjectSignature'], 'describe: every phone-capable field');
  eq(byName.SubjectSignature.type, 'signature', 'describe: signature typed');
  eq(byName.SubjectSignature.label, 'Signature of Subject', 'describe: signature label from tooltip');
  eq(byName.SubjectSignature.boxes[0].page, 1, 'describe: signature on page 2');
  ok(!('value' in byName.SubjectSignature), 'describe: signature has no value');
  eq(byName.Device.boxes.map(b => b.option), ['Phone', 'Tablet'], 'describe: radio boxes carry options');
  eq(byName.Device.options, ['Phone', 'Tablet'], 'describe: radio options');
  eq(byName.Phone_PIN.maxLength, 6, 'describe: maxLength');
  eq([byName.OfficerBadge.readOnly, byName.OfficerBadge.value], [true, '1234'], 'describe: readOnly keeps value');
  eq(byName.ConsentGiven.value, false, 'describe: checkbox false');
  {
    const b = byName['Subject.LastName'].boxes[0];
    // pdf-lib draws a 1pt border, so the widget rect is half a point bigger each side.
    near(b.x, 71.5 / 612, 'describe: x'); near(b.y, (792 - 720.5) / 792, 'describe: y top-left'); near(b.w, 201 / 612, 'describe: w');
  }
  const cropped = S.describeFields(await PF.inspect(await makeForm({ crop: true })));
  near(cropped.find(x => x.name === 'Subject.LastName').boxes[0].x, (71.5 - 36) / 540, 'describe: uses the crop box');
  await rejects((async () => S.describeFields(await PF.inspect(await makeForm({ rotate: true }))))(), /rotated/, 'describe: rotated page refused');

  // ------------------------------------------------------------ packet
  const prefilled = (await PF.fill(blank, { 'Subject.LastName': 'Testperson', Scope: 'Full' }, { flatten: false })).bytes;
  const built = await S.buildPacket({ pdfBytes: prefilled, pdfForm: PF, render: fakeRender, title: 'Consent to Search Device', who: 'Alex Testperson', lang: 'en' });
  eq([built.packet.v, built.packet.kind, built.packet.pages.length, built.pageCount], [1, 'viper-form', 2, 2], 'packet: header');
  ok(/^data:image\/jpeg;base64,/.test(built.packet.pages[0].img), 'packet: jpeg data url');
  eq(built.packet.signers, S.DEFAULT_SIGNERS, 'packet: default signers');
  eq(built.packet.fields.find(x => x.name === 'Subject.LastName').value, 'Testperson', 'packet: carries pre-filled value');
  eq(JSON.parse(built.json.toString()).title, 'Consent to Search Device', 'packet: json');
  {
    // Too big at the first quality → steps down; too big at all → refused.
    let calls = 0;
    const big = async (bytes, step) => { calls++; const n = step.quality === 50 ? 10 : 4000; return (await fakeRender(bytes, step)).map(p => Object.assign(p, { jpeg: Buffer.alloc(n) })); };
    const b2 = await S.buildPacket({ pdfBytes: prefilled, pdfForm: PF, render: big, maxBytes: 9000 });
    eq(calls, 3, 'packet: steps quality down to fit');
    ok(b2.json.length < 9000, 'packet: fits');
    await rejects(S.buildPacket({ pdfBytes: prefilled, pdfForm: PF, render: big, maxBytes: 500 }), /too large/, 'packet: too large refused');
    await rejects(S.buildPacket({ pdfBytes: prefilled, pdfForm: PF, render: async () => [] }), /could not be drawn/, 'packet: page count mismatch');
  }

  // ------------------------------------------------------------ validate
  const sigBox = byName.SubjectSignature.boxes[0];
  const good = () => ({
    v: 1, kind: 'viper-form-result',
    values: { 'Subject.LastName': 'Testperson', Phone_PIN: '12345678', ConsentGiven: true, Device: 'Tablet', Scope: 'Limited', OfficerBadge: '9999', Bogus: 'x' },
    signatures: [
      Object.assign({ field: 'SubjectSignature', png: pngUrl(300, 80), signer: 'Subject', initials: false, signedAt: '2026-11-25T18:04:05.123Z' }, sigBox),
      { field: null, page: 0, x: 0.7, y: 0.9, w: 0.1, h: 0.04, png: pngUrl(60, 30), signer: 'Subject', initials: true, signedAt: '2026-11-25T18:04:09.000Z' },
    ],
    startedAt: '2026-11-25T18:00:00.000Z', completedAt: '2026-11-25T18:05:00.000Z', userAgent: 'SyntheticPhone/1.0',
  });
  const v = S.validateResult(good(), fields, 2);
  eq(v.values, { 'Subject.LastName': 'Testperson', Phone_PIN: '123456', ConsentGiven: true, Device: 'Tablet', Scope: 'Limited' }, 'validate: values kept, PIN cut to maxLength');
  eq(v.ignored, 2, 'validate: readOnly + unknown ignored');
  eq(v.signatures.length, 2, 'validate: signatures');
  ok(Buffer.isBuffer(v.signatures[0].png), 'validate: png decoded');
  eq([v.signatures[1].field, v.signatures[1].initials], [null, true], 'validate: free initials');
  const bad = (mut, re, label) => { const r = good(); mut(r); throws(() => S.validateResult(r, fields, 2), re, label); };
  bad(r => { r.kind = 'x'; }, /not a completed form/, 'validate: kind');
  bad(r => { r.values.ConsentGiven = 'yes'; }, /checked or unchecked/, 'validate: checkbox type');
  bad(r => { r.values.Device = 'Laptop'; }, /not on the form/, 'validate: radio option');
  bad(r => { r.values.Scope = 'Other'; }, /not on the form/, 'validate: dropdown option');
  bad(r => { r.values['Subject.LastName'] = 'x'.repeat(5000); }, /too long/, 'validate: long text');
  bad(r => { r.values['Subject.LastName'] = 5; }, /must be text/, 'validate: number');
  bad(r => { r.signatures[0].field = 'Subject.LastName'; }, /not on the form/, 'validate: sig in a text box');
  bad(r => { r.signatures[0].page = 2; }, /page the form does not have/, 'validate: sig page');
  bad(r => { r.signatures[0].x = 0.9; r.signatures[0].w = 0.5; }, /outside the page/, 'validate: sig outside');
  bad(r => { r.signatures[0].signer = ''; }, /who signed/, 'validate: signer missing');
  bad(r => { r.signatures[0].signer = 'x'.repeat(41); }, /who signed/, 'validate: signer long');
  bad(r => { r.signatures[0].png = 'data:image/jpeg;base64,AAAA'; }, /not a PNG/, 'validate: jpeg refused');
  bad(r => { r.signatures[0].png = 'data:image/png;base64,' + Buffer.from('not a png at all, really not one').toString('base64'); }, /not a PNG/, 'validate: fake png');
  bad(r => { r.signatures[0].png = pngUrl(3000, 10); }, /impossible size/, 'validate: huge png');
  bad(r => { r.signatures = new Array(25).fill(r.signatures[1]); }, /Too many signatures/, 'validate: count');

  // ------------------------------------------------------------ apply
  const sentFields = S.describeFields(await PF.inspect(prefilled));
  const applied = await S.applyResult({
    pdfBytes: prefilled, pdfForm: PF, fields: sentFields, pageCount: 2, result: v, now: new Date('2026-11-25T19:00:00Z'),
    meta: { title: 'Consent to Search Device', who: 'Alex Testperson', setName: 'Sample PD', setVersion: '1.0.0', caseNumber: 'TEST-0001', relayFormId: 'abcdef0123456789', docId: 'DOCID_0123456789ab', sentAt: '2026-11-25T17:59:00Z', sentSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64) },
  });
  eq(applied.signatures, 2, 'apply: two signatures');
  eq(applied.changed.sort(), ['Consent Given', 'Device', 'Phone PIN', 'Scope'].sort(), 'apply: changed fields named');
  {
    const out = await PDFDocument.load(applied.bytes);
    eq(out.getPageCount(), 3, 'apply: signing record page appended');
    let fieldsLeft = -1; try { fieldsLeft = out.getForm().getFields().length; } catch (_) { fieldsLeft = 0; }
    eq(fieldsLeft, 0, 'apply: flattened');
    const imgs = (p) => { const res = p.node.Resources(); const x = res && res.lookup(PDFName.of('XObject')); return x ? x.keys().length : 0; };
    ok(imgs(out.getPages()[1]) >= 1, 'apply: signature image on page 2');
    ok(imgs(out.getPages()[0]) >= 1, 'apply: initials image on page 1');
    // The record text is in the content stream (Helvetica hex-encoded by pdf-lib).
    const raw = Buffer.from(applied.bytes).toString('latin1');
    ok(raw.length > prefilled.length, 'apply: bytes grew');
  }
  {
    const words = S.wrapText('x'.repeat(300) + ' end', { widthOfTextAtSize: (s) => s.length * 5 }, 10, 100);
    ok(words.every(l => l.length <= 20), 'wrapText: hard-breaks long words');
    eq(S.ansi('“hi”—…\u4e2d'), '"hi"-...?', 'ansi: WinAnsi safe');
  }

  // ------------------------------------------------------------ relay client
  {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push([init.method, url, init.headers['X-API-Key'], init.headers['Content-Type'] || '']);
      if (url.endsWith('/docs')) return { ok: true, status: 200, json: async () => ({ doc_id: 'D'.repeat(22), position: 0, byte_size: 9 }) };
      if (url.endsWith('/result') && url.includes('NONE')) return { ok: false, status: 404, json: async () => ({ detail: 'No result for this document' }) };
      if (url.endsWith('/result') && url.includes('GONE')) return { ok: false, status: 404, json: async () => ({ detail: 'Form not found or expired' }) };
      if (url.endsWith('/result')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    };
    const rc = S.createRelayClient({ fetch, base: 'https://relay.example.test' });
    eq((await rc.postDoc('K', 'f0', Buffer.alloc(40))).doc_id.length, 22, 'relay: post');
    eq(calls[0], ['POST', 'https://relay.example.test/api/fieldwork/f0/docs', 'K', 'application/octet-stream'], 'relay: post shape');
    eq([...(await rc.getResult('K', 'f0', 'HAS'))], [1, 2, 3], 'relay: result bytes');
    eq(await rc.getResult('K', 'f0', 'NONE'), null, 'relay: no result → null');
    await rejects(rc.getResult('K', 'f0', 'GONE'), /not found or expired/, 'relay: gone form throws');
    eq((await rc.deleteDoc('K', 'f0', 'D')).deleted, true, 'relay: delete');
    await rejects(rc.postDoc('', 'f0', Buffer.alloc(40)), /Not registered/, 'relay: needs key');
  }

  // ------------------------------------------------------------ IPC end to end (fake relay = a phone)
  {
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const caseFiles = {};           // "<case>/<subdir>/<name>" → bytes
    const audits = [];
    const relayDocs = {};           // docId → { blob, result }
    let n = 0, isLocked = false;
    const manifest = { id: 'sample-pd', name: 'Sample PD', version: '1.0.0' };
    const deps = {
      store: {
        load: (id) => { if (id !== 'sample-pd') throw new Error('Form set not installed'); return manifest; },
        getForm: (_s, formId) => { if (formId !== 'consent') throw new Error('Unknown form'); return { form: { id: 'consent', title: 'Consent to Search Device', language: 'en' } }; },
        readPdf: () => blank,
      },
      pdfForm: PF, checkValues: FS.checkValues, outputFileName: FS.outputFileName,
      relay: {
        postDoc: async (k, fid, blob) => { const id = 'doc' + (++n) + '_abcdefghijklmnop'; relayDocs[id] = { blob }; return { doc_id: id, position: n - 1 }; },
        getResult: async (k, fid, id) => (relayDocs[id] && relayDocs[id].result) || null,
        deleteDoc: async (k, fid, id) => { delete relayDocs[id]; return { deleted: true }; },
      },
      render: fakeRender,
      writeCaseFile: (cn, sub, name, bytes) => {
        let fn = name, i = 1;
        while (caseFiles[cn + '/' + sub + '/' + fn]) fn = name.replace(/\.pdf$/, ` (${i++}).pdf`);
        caseFiles[cn + '/' + sub + '/' + fn] = Buffer.from(bytes);
        return { fileName: fn };
      },
      readCaseFile: (cn, sub, name) => { const b = caseFiles[cn + '/' + sub + '/' + name]; if (!b) throw new Error('missing'); return b; },
      locked: () => isLocked,
      audit: (ev, data) => audits.push([ev, data]),
      now: () => Date.parse('2026-11-25T19:00:00Z'),
    };
    S.registerFieldWorkSignIpc(ipcMain, deps);
    eq(Object.keys(handlers).sort(), ['fieldwork-sign-collect', 'fieldwork-sign-send'], 'ipc: channels');
    const call = (ch, r) => handlers[ch]({}, r);
    const base = { apiKey: 'K', relayFormId: 'abcdef0123456789', mediaKey, caseNumber: 'TEST-0001' };

    let r = await call('fieldwork-sign-send', Object.assign({}, base, { setId: 'sample-pd', formId: 'consent', values: { 'Subject.LastName': 'Testperson' }, who: 'Alex Testperson' }));
    ok(r.success, 'send ok — ' + r.error);
    ok(S.DOC_ID_RE.test(r.docId), 'send: doc id');
    eq(r.keptFile, 'abcdef0123456789_' + r.docId + '.pdf', 'send: kept file name');
    const keptKey = 'TEST-0001/' + S.KEPT_SUBDIR + '/' + r.keptFile;
    ok(!!caseFiles[keptKey], 'send: pre-filled PDF kept in the case');
    eq(r.sha256, crypto.createHash('sha256').update(caseFiles[keptKey]).digest('hex'), 'send: sha of kept copy');
    eq(audits[0][0], 'CASE_FORM_SENT_TO_PHONE', 'send: audited');
    const sent = r;

    // The phone opens the packet with the link key.
    const packet = JSON.parse(S.open(keyB, relayDocs[sent.docId].blob).toString());
    eq([packet.title, packet.who, packet.fields.find(x => x.name === 'Subject.LastName').value], ['Consent to Search Device', 'Alex Testperson', 'Testperson'], 'phone: packet decrypts');
    ok(!JSON.stringify(packet).includes('TEST-0001'), 'phone: packet never carries the case number');

    const collectReq = Object.assign({}, base, { docId: sent.docId, keptFile: sent.keptFile, sha256: sent.sha256, title: sent.title, who: sent.who, setName: sent.setName, setVersion: sent.setVersion, sentAt: sent.sentAt });
    r = await call('fieldwork-sign-collect', collectReq);
    eq([r.success, r.pending], [true, true], 'collect: pending before the phone sends');

    // The phone sends its result.
    const res = good();
    res.signatures[0] = Object.assign({}, res.signatures[0], packet.fields.find(x => x.name === 'SubjectSignature').boxes[0]);
    relayDocs[sent.docId].result = S.seal(keyB, Buffer.from(JSON.stringify(res)));

    // Locked vault, bad ids, missing kept copy.
    isLocked = true;
    r = await call('fieldwork-sign-collect', collectReq);
    ok(!r.success && /Unlock Field Security/.test(r.error), 'collect: refused while locked');
    isLocked = false;
    r = await call('fieldwork-sign-collect', Object.assign({}, collectReq, { docId: '../x' }));
    ok(!r.success && /Unknown form/.test(r.error), 'collect: bad doc id');
    r = await call('fieldwork-sign-collect', Object.assign({}, collectReq, { keptFile: '..\\evil.pdf' }));
    ok(!r.success && /Unknown form/.test(r.error), 'collect: kept file must be a plain name');
    r = await call('fieldwork-sign-collect', Object.assign({}, collectReq, { sha256: 'f'.repeat(64) }));
    ok(!r.success && /has changed since it was sent/.test(r.error), 'collect: kept copy hash checked');
    r = await call('fieldwork-sign-collect', Object.assign({}, collectReq, { mediaKey: crypto.randomBytes(32).toString('base64url') }));
    ok(!r.success && /integrity check/.test(r.error), 'collect: wrong key refused');

    r = await call('fieldwork-sign-collect', collectReq);
    ok(r.success, 'collect ok — ' + r.error);
    eq(r.fileName, 'Consent to Search Device - Alex Testperson - signed - 2026-11-25.pdf', 'collect: signed file name');
    eq([r.signatures, r.purged], [2, true], 'collect: stamped and purged');
    ok(!relayDocs[sent.docId], 'collect: relay doc deleted');
    const signed = caseFiles['TEST-0001/Forms/' + r.fileName];
    ok(!!signed, 'collect: saved in Forms');
    eq((await PDFDocument.load(signed)).getPageCount(), 3, 'collect: signed PDF has the record page');
    eq(audits[audits.length - 1][0], 'CASE_FORM_SIGNED_ON_PHONE', 'collect: audited');
    eq(r.mediaFile, r.fileName, 'collect: Field Work copy named like the Forms copy');
    const mediaCopy = caseFiles['TEST-0001/' + S.MEDIA_SUBDIR + '/' + r.mediaFile];
    ok(!!mediaCopy && mediaCopy.equals(signed), 'collect: same signed PDF in Field Work Media');
    eq([r.bytes, r.mediaError], [signed.length, ''], 'collect: size reported, no media error');

    // The Field Work copy failing must not fail the collect.
    {
      const s2 = await call('fieldwork-sign-send', Object.assign({}, base, { setId: 'sample-pd', formId: 'consent', who: 'Alex Testperson' }));
      const p2 = JSON.parse(S.open(keyB, relayDocs[s2.docId].blob).toString());
      const res2 = good();
      res2.signatures[0] = Object.assign({}, res2.signatures[0], p2.fields.find(x => x.name === 'SubjectSignature').boxes[0]);
      relayDocs[s2.docId].result = S.seal(keyB, Buffer.from(JSON.stringify(res2)));
      const realWrite = deps.writeCaseFile;
      deps.writeCaseFile = (cn, sub, name, bytes) => {
        if (sub === S.MEDIA_SUBDIR) throw new Error('media disk full');
        return realWrite(cn, sub, name, bytes);
      };
      const c2 = await call('fieldwork-sign-collect', Object.assign({}, collectReq, { docId: s2.docId, keptFile: s2.keptFile, sha256: s2.sha256 }));
      deps.writeCaseFile = realWrite;
      ok(c2.success, 'collect (media copy fails): still succeeds — ' + c2.error);
      ok(!!caseFiles['TEST-0001/Forms/' + c2.fileName], 'collect (media copy fails): Forms copy saved');
      eq([c2.mediaFile, c2.mediaError], ['', 'media disk full'], 'collect (media copy fails): error reported');
    }

    // Send failures.
    r = await call('fieldwork-sign-send', Object.assign({}, base, { mediaKey: 'short', setId: 'sample-pd', formId: 'consent' }));
    ok(!r.success && /no usable key/.test(r.error), 'send: bad key');
    r = await call('fieldwork-sign-send', Object.assign({}, base, { caseNumber: '../x', setId: 'sample-pd', formId: 'consent' }));
    ok(!r.success && /Open a case/.test(r.error), 'send: bad case');
    r = await call('fieldwork-sign-send', Object.assign({}, base, { relayFormId: 'a/b', setId: 'sample-pd', formId: 'consent' }));
    ok(!r.success && /Unknown Field Work form/.test(r.error), 'send: bad relay id');
    const writeCaseFile = deps.writeCaseFile;
    deps.writeCaseFile = () => { throw new Error('disk full'); };
    const before = Object.keys(relayDocs).length;
    r = await call('fieldwork-sign-send', Object.assign({}, base, { setId: 'sample-pd', formId: 'consent' }));
    ok(!r.success && /disk full/.test(r.error), 'send: write failure reported');
    eq(Object.keys(relayDocs).length, before, 'send: relay copy withdrawn when the case copy could not be kept');
    deps.writeCaseFile = writeCaseFile;
  }

  console.log(`fieldwork-sign: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
