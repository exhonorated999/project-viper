/**
 * Sealed relay entries — Area Canvas + Field Work written answers are
 * encrypted on the phone and opened here. Pinned against code LIFTED from
 * electron-main.js (and, when the dashboard repo is checked out alongside,
 * the phone's own SEAL_JS from app/relay_guard.py for a true round trip).
 *
 * Run: node modules\field-work\__tests__\relay-sealed.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const CD = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const FWUI = fs.readFileSync(path.join(REPO, 'modules', 'field-work', 'field-work-ui.js'), 'utf8').replace(/\r\n/g, '\n');
const SEAL_PY = path.join(REPO, '..', 'intellect_unified_dashboard', 'app', 'relay_guard.py');

let passed = 0, failed = 0;
async function ok(label, fn) {
  try { await fn(); console.log('  PASS  ' + label); passed++; }
  catch (e) { console.log('  FAIL  ' + label + '  ' + e.message); failed++; }
}
function fnSource(name) {
  const a = SRC.indexOf('function ' + name + '(');
  assert.ok(a !== -1, name + ' missing');
  return SRC.slice(a, SRC.indexOf('\n}\n', a) + 2);
}
function handlerSource(channel) {
  const a = SRC.indexOf("ipcMain.handle('" + channel + "'");
  assert.ok(a !== -1, channel + ' missing');
  return SRC.slice(a, SRC.indexOf('\n});', a) + 4);
}
const sandbox = { require, Buffer };
vm.createContext(sandbox);
vm.runInContext(fnSource('_relayFormUrl') + '\n' + fnSource('_openSealedRelayEntries') +
  '\nthis._relayFormUrl=_relayFormUrl;this._open=_openSealedRelayEntries;', sandbox);
const { _relayFormUrl, _open } = sandbox;

const KEY = crypto.randomBytes(32);
const KEY64 = KEY.toString('base64url');
function seal(obj, key) {           // the phone's layout: IV ‖ ct ‖ tag, base64
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key || KEY, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

(async () => {
  console.log('\n1. Form URL');
  await ok('fragment carries key, seal flag, title and case; nothing before #', () => {
    const u = _relayFormUrl('https://relay.example/canvas/abc', KEY64, 'Canvas — Smith & Co', '24-00123');
    const [base, frag] = u.split('#');
    assert.strictEqual(base, 'https://relay.example/canvas/abc');
    const p = new URLSearchParams(frag);
    assert.strictEqual(p.get('k'), KEY64);
    assert.strictEqual(p.get('t'), '1');
    assert.strictEqual(p.get('n'), 'Canvas — Smith & Co');
    assert.strictEqual(p.get('c'), '24-00123');
  });
  await ok('empty title/case are omitted, long ones capped', () => {
    assert.strictEqual(_relayFormUrl('u', KEY64, '', ''), 'u#k=' + KEY64 + '&t=1');
    const p = new URLSearchParams(_relayFormUrl('u', KEY64, 'x'.repeat(500), 'y'.repeat(500)).split('#')[1]);
    assert.strictEqual(p.get('n').length, 120);
    assert.strictEqual(p.get('c').length, 60);
  });

  console.log('\n2. The relay is never told the title or case number');
  for (const ch of ['canvas-form-create', 'fieldwork-form-create']) {
    await ok(ch + ' sends a generic title and an empty case_ref', () => {
      const h = handlerSource(ch);
      const body = h.slice(h.indexOf('body: {'), h.indexOf('const mediaKey'));
      assert.ok(/case_ref: ''/.test(body), 'case_ref must be empty');
      assert.ok(!/title: (p\.)?title/.test(body), 'officer title must not be sent');
      assert.ok(!/caseRef/.test(body.replace(/\/\/.*$/gm, '')), 'caseRef must not be sent');
      assert.ok(/_relayFormUrl\(result\.form_url, mediaKey/.test(h));
    });
  }

  console.log('\n3. Opening entries');
  await ok('a sealed entry opens and keeps relay id/submittedAt/media', () => {
    const out = _open([{ e2e: 1, ct: seal({ notes: 'Saw J. Doe, 555-0100', street: '1 Main', timestamp: 't0' }),
      id: 7, submittedAt: 's7', media: [{ mediaId: 1, label: 'IMG-1' }] }], KEY64);
    assert.strictEqual(out[0].notes, 'Saw J. Doe, 555-0100');
    assert.strictEqual(out[0].street, '1 Main');
    assert.strictEqual(out[0].id, 7);
    assert.strictEqual(out[0].submittedAt, 's7');
    assert.strictEqual(out[0].media.length, 1);
    assert.ok(!('ct' in out[0]) && !('e2e' in out[0]));
  });
  await ok('the entry cannot overwrite the relay id', () => {
    const out = _open([{ e2e: 1, ct: seal({ id: 999, submittedAt: 'fake' }), id: 3, submittedAt: 's3', media: [] }], KEY64);
    assert.strictEqual(out[0].id, 3);
    assert.strictEqual(out[0].submittedAt, 's3');
  });
  await ok('sealed document names are restored onto their attachments', () => {
    const out = _open([{ e2e: 1, ct: seal({ _mediaNames: { 'DOC-2': 'statement.pdf' } }), id: 1, submittedAt: 's',
      media: [{ mediaId: 5, label: 'DOC-2', fileName: '' }, { mediaId: 6, label: 'IMG-3', fileName: '' }] }], KEY64);
    assert.strictEqual(out[0].media[0].fileName, 'statement.pdf');
    assert.strictEqual(out[0].media[1].fileName, '');
    assert.ok(!('_mediaNames' in out[0]));
  });
  await ok('plaintext entries from older forms pass through untouched', () => {
    const e = { notes: 'plain', id: 2, submittedAt: 's', media: [] };
    assert.strictEqual(_open([e], KEY64)[0], e);
  });
  await ok('wrong key: entry is KEPT with its ciphertext and flagged', () => {
    const ct = seal({ notes: 'x' }, crypto.randomBytes(32));
    const out = _open([{ e2e: 1, ct, id: 4, submittedAt: 's4', media: [{ mediaId: 9 }] }], KEY64);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].e2eError, true);
    assert.strictEqual(out[0].e2eCipher, ct);
    assert.strictEqual(out[0].id, 4);
    assert.strictEqual(out[0].media.length, 1);
    assert.ok(/could not decrypt/.test(out[0].notes));
  });
  await ok('missing key and tampered ciphertext are both kept, not dropped', () => {
    const ct = seal({ notes: 'x' });
    assert.strictEqual(_open([{ e2e: 1, ct, id: 1 }], '')[0].e2eError, true);
    const b = Buffer.from(ct, 'base64'); b[20] ^= 1;
    assert.strictEqual(_open([{ e2e: 1, ct: b.toString('base64'), id: 1 }], KEY64)[0].e2eError, true);
  });

  console.log('\n4. Wiring');
  await ok('both download handlers open sealed entries with the passed key', () => {
    assert.ok(/_openSealedRelayEntries\(result\.submissions, mediaKey\)/.test(handlerSource('canvas-form-download')));
    assert.ok(/_openSealedRelayEntries\(result\.entries, mediaKey\)/.test(handlerSource('fieldwork-form-download')));
  });
  await ok('both renderers pass the form key on download and keep failed ciphertext', () => {
    assert.ok(/canvasFormDownload\(\{ apiKey: key, formId, mediaKey:/.test(CD));
    assert.ok(/e2eCipher: s\.e2eCipher/.test(CD));
    assert.ok(/fieldWorkFormDownload\(\{ apiKey: key, formId: formId, mediaKey: form\.mediaKey/.test(FWUI));
    assert.ok(/entry\.e2eCipher = row\.e2eCipher/.test(FWUI));
  });

  console.log('\n5. Round trip with the phone\'s own SEAL_JS');
  if (!fs.existsSync(SEAL_PY) || !globalThis.crypto || !globalThis.crypto.subtle) {
    console.log('  SKIP  dashboard repo or WebCrypto not available');
  } else {
    const py = fs.readFileSync(SEAL_PY, 'utf8').replace(/\r\n/g, '\n');
    const a = py.indexOf('SEAL_JS = r"""') + 'SEAL_JS = r"""'.length;
    const js = py.slice(a, py.indexOf('"""', a));
    const mk = (hash) => {
      const els = { formTitle: { textContent: 'Area Canvas' }, formCase: { textContent: '', style: { display: 'none' } } };
      const ctx = { location: { hash }, document: { title: 'Area Canvas', getElementById: (id) => els[id] || null },
        crypto: globalThis.crypto, TextEncoder, atob, btoa, Uint8Array, String, JSON, Object, Error };
      ctx.window = ctx;
      vm.createContext(ctx);
      vm.runInContext(js + '\nthis.sealEntry=sealEntry;this.SEAL_TEXT=SEAL_TEXT;this.VIPER_FRAG=VIPER_FRAG;', ctx);
      return { ctx, els };
    };
    await ok('phone seals → VIPER opens, and the page shows the fragment title', async () => {
      const { ctx, els } = mk('#' + _relayFormUrl('', KEY64, 'Knock — 12 Elm', 'CR-9').split('#')[1]);
      assert.strictEqual(ctx.SEAL_TEXT, true);
      assert.strictEqual(els.formTitle.textContent, 'Knock — 12 Elm');
      assert.strictEqual(els.formCase.textContent, 'Case: CR-9');
      const sealed = await ctx.sealEntry({ notes: 'DOB 01/02/1990', officerName: 'Ofc. A' });
      assert.deepStrictEqual(Object.keys(sealed).sort(), ['ct', 'e2e']);
      assert.ok(sealed.ct.indexOf('DOB') === -1);
      const out = _open([Object.assign({ id: 1, submittedAt: 's', media: [] }, sealed)], KEY64);
      assert.strictEqual(out[0].notes, 'DOB 01/02/1990');
      assert.strictEqual(out[0].officerName, 'Ofc. A');
    });
    await ok('old links (#k= only) still parse the key and post plaintext', async () => {
      const { ctx } = mk('#k=' + KEY64);
      assert.strictEqual(ctx.VIPER_FRAG.k, KEY64);
      assert.strictEqual(ctx.SEAL_TEXT, false);
      const d = { notes: 'n' };
      assert.strictEqual(await ctx.sealEntry(d), d);
    });
    await ok('a sealed link with a broken key refuses rather than sending plaintext', async () => {
      const { ctx } = mk('#k=short&t=1');
      let threw = false;
      try { await ctx.sealEntry({ notes: 'n' }); } catch (_) { threw = true; }
      assert.ok(threw);
    });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
