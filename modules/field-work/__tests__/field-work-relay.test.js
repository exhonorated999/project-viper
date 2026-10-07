/**
 * Field Work — the main-process relay contract.
 *
 * Everything here is pinned against code LIFTED OUT OF electron-main.js and
 * preload.js rather than a copy of it, because a copy is the thing that
 * drifts. Three separate claims are being defended:
 *
 *   1. THE CRYPTO. Attachments are encrypted on an investigator's phone by
 *      SubtleCrypto in a browser and decrypted here by node's crypto in the
 *      main process. Two different APIs agreeing on a byte layout by
 *      convention alone — 12-byte IV, then AES-GCM ciphertext with its
 *      16-byte tag appended. Nothing fails loudly if that drifts; the
 *      investigator just gets a file that will not open, weeks later, in a
 *      case that matters.
 *
 *   2. THE KEY NEVER REACHES THE SERVER. It is minted here and appended to
 *      the form URL as a FRAGMENT. Browsers do not put a fragment in an HTTP
 *      request, which is the entire basis of what we tell an agency about
 *      this feature. A query string would void it silently.
 *
 *   3. FIELD WORK AND AREA CANVAS DO NOT SHARE A FOLDER. They share the code
 *      that writes files, which is what stops them drifting, but not the
 *      directory — so one module's delete can never take the other's
 *      evidence.
 *
 * Run:  set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *       modules\field-work\__tests__\field-work-relay.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA = require(path.join(REPO, 'modules', 'field-work', 'field-work-schema.js'));

let passed = 0;
let failed = 0;
function ok(label, fn) {
  try { fn(); console.log('  PASS  ' + label); passed++; }
  catch (e) { console.log('  FAIL  ' + label + '  ' + e.message); failed++; }
}
async function okAsync(label, fn) {
  try { await fn(); console.log('  PASS  ' + label); passed++; }
  catch (e) { console.log('  FAIL  ' + label + '  ' + e.message); failed++; }
}

// The handler for a given IPC channel, sliced out of the shipping file.
function handlerSource(channel) {
  const a = SRC.indexOf("ipcMain.handle('" + channel + "'");
  assert.ok(a !== -1, 'the ' + channel + ' handler is missing from electron-main.js');
  const b = SRC.indexOf('\n});', a);
  assert.ok(b !== -1, 'the ' + channel + ' handler has no end');
  return SRC.slice(a, b + 4);
}

(async () => {

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1. The key is minted here and never sent to the relay');
  // ═══════════════════════════════════════════════════════════════════════

  const create = handlerSource('fieldwork-form-create');

  ok('a fresh 32-byte key is minted per form', () => {
    assert.ok(/randomBytes\(32\)\.toString\('base64url'\)/.test(create),
      'fieldwork-form-create no longer mints a 32-byte base64url key');
  });

  ok('the key rides in the URL fragment', () => {
    assert.ok(create.indexOf("'#k=' + mediaKey") !== -1,
      'the key must be a fragment — a browser never puts a fragment in a request');
  });

  ok('the key is never appended as a query string', () => {
    assert.ok(create.indexOf('?k=') === -1,
      'a query string would hand the key to the server on every page load');
  });

  ok('the key is never included in the create request body', () => {
    const body = create.slice(create.indexOf('body: {'), create.indexOf('const mediaKey'));
    assert.ok(body.indexOf('mediaKey') === -1 && body.indexOf('k:') === -1);
  });

  ok('the QR encodes the URL that carries the key', () => {
    const qr = create.indexOf('QRCode.toDataURL(formUrl');
    assert.ok(qr !== -1, 'the QR must encode formUrl, not result.form_url');
    assert.ok(create.indexOf('const formUrl') < qr, 'the fragment is appended before the QR is drawn');
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2. The relay is handed the whole field definition');
  // ═══════════════════════════════════════════════════════════════════════
  // This is the single thing that makes Field Work different from Area
  // Canvas. Canvas sends a list of names and hopes the server's hard-coded
  // ladder recognises them; a mismatch shows up as a form with a missing
  // box, in the field, with no error anywhere. Field Work sends the complete
  // descriptors, so the server looks nothing up.

  ok('fields and captures are forwarded as sent, not rebuilt here', () => {
    assert.ok(/fields: Array\.isArray\(p\.fields\) \? p\.fields : \[\]/.test(create));
    assert.ok(/captures: Array\.isArray\(p\.captures\) \? p\.captures : \[\]/.test(create));
  });

  ok('no field key is hard-coded in the main process', () => {
    const named = SCHEMA.FIELD_ORDER.filter(function (k) {
      return create.indexOf("'" + k + "'") !== -1 || create.indexOf('"' + k + '"') !== -1;
    });
    assert.deepStrictEqual(named, [], 'main must not know what a field is called: ' + named.join(', '));
  });

  ok('the preset is carried so the entry can be labelled on arrival', () => {
    assert.ok(create.indexOf('preset:') !== -1 && create.indexOf('preset_label:') !== -1);
  });

  ok('the caps the server ACCEPTED come back, not the ones we asked for', () => {
    assert.ok(/captures: result\.captures/.test(create),
      'the relay clamps any over-reaching spec; showing the asked-for number promises a slot that does not exist');
  });

  ok('the schema produces descriptors the relay can render', () => {
    const ds = SCHEMA.descriptorsFor(['location', 'subject', 'notes']);
    ds.forEach(function (d) {
      assert.ok(d.key && d.label && d.type, 'every descriptor is complete');
      assert.ok(SCHEMA.TYPES.indexOf(d.type) !== -1, d.type + ' is not a renderable type');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n3. The crypto contract with the phone');
  // ═══════════════════════════════════════════════════════════════════════

  const fetchMedia = handlerSource('fieldwork-fetch-media');

  // Lift the decrypt block out of the shipping handler and run it.
  const DEC_START = 'const iv = cipher.subarray(0, 12);';
  const DEC_END = 'plain = Buffer.concat([decipher.update(body), decipher.final()]);';
  function decryptUsingShippedCode(cipherBuf, keyBuf) {
    const a = fetchMedia.indexOf(DEC_START);
    const b = fetchMedia.indexOf(DEC_END);
    assert.ok(a !== -1 && b !== -1, 'the decrypt block moved — update this test');
    const block = fetchMedia.slice(a, b + DEC_END.length);
    const sandbox = { cipher: cipherBuf, key: keyBuf, nodeCrypto: crypto, Buffer: Buffer };
    vm.createContext(sandbox);
    // The lifted block opens a try{} the handler closes with its own error
    // message; close it here so the throw reaches the caller intact.
    vm.runInContext(block + '\n} catch (e) { throw e; }\nglobalThis.__out = plain;', sandbox);
    return sandbox.__out;
  }

  // Encrypt exactly the way the hosted form page does: random 12-byte IV,
  // then AES-GCM, then IV ‖ ciphertext ‖ tag in one buffer.
  async function encryptLikeThePhone(keyB64Url, plaintext) {
    const raw = Buffer.from(keyB64Url, 'base64url');
    const subtle = crypto.webcrypto.subtle;
    const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plaintext);
    const out = Buffer.alloc(12 + ct.byteLength);
    iv.copy(out, 0);
    Buffer.from(ct).copy(out, 12);
    return out;
  }

  const keyB64 = crypto.randomBytes(32).toString('base64url');

  await okAsync('a document round-trips byte for byte', async () => {
    const plain = crypto.randomBytes(40000); // a PDF-sized payload
    const blob = await encryptLikeThePhone(keyB64, plain);
    const out = decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url'));
    assert.ok(out.equals(plain));
  });

  await okAsync('an empty file round-trips', async () => {
    const blob = await encryptLikeThePhone(keyB64, Buffer.alloc(0));
    assert.strictEqual(decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url')).length, 0);
  });

  await okAsync('the IV is a prefix, not a suffix', async () => {
    const plain = crypto.randomBytes(256);
    const blob = await encryptLikeThePhone(keyB64, plain);
    // IV ‖ ciphertext ‖ 16-byte tag.
    assert.strictEqual(blob.length, 12 + plain.length + 16);
  });

  await okAsync('a key from another form throws', async () => {
    const blob = await encryptLikeThePhone(keyB64, crypto.randomBytes(1024));
    assert.throws(function () { decryptUsingShippedCode(blob, crypto.randomBytes(32)); });
  });

  await okAsync('one flipped bit throws', async () => {
    const blob = await encryptLikeThePhone(keyB64, crypto.randomBytes(1024));
    blob[100] ^= 0xff;
    assert.throws(function () { decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url')); });
  });

  ok('a file that fails its integrity check is never written', () => {
    // The refusal is the whole statement, not a flag set and then ignored:
    // GCM authenticates as well as decrypts, so a failure here means the
    // bytes were altered in transit or belong to another form. Either way
    // they are not evidence and must not reach the case folder.
    const line = fetchMedia.split('\n').find(function (l) {
      return l.indexOf('failed its integrity check') !== -1;
    });
    assert.ok(line, 'the integrity refusal is gone');
    assert.ok(/^\s*return \{ success: false,/.test(line),
      'the integrity failure must return, not fall through to the write');
    const catchIdx = fetchMedia.indexOf('failed its integrity check');
    const writeIdx = fetchMedia.indexOf('_writeFieldWorkMediaFile');
    assert.ok(catchIdx !== -1 && writeIdx !== -1);
    assert.ok(catchIdx < writeIdx, 'the refusal must come before the write');
  });

  ok('a key that is not 32 bytes is refused with a plain message', () => {
    assert.ok(/key\.length !== 32/.test(fetchMedia));
    assert.ok(fetchMedia.indexOf('no usable media key') !== -1);
  });

  ok('a blob too short to hold an IV and a tag is refused', () => {
    assert.ok(/cipher\.length < 12 \+ 16 \+ 1/.test(fetchMedia));
  });

  ok('attachments are fetched as bytes, not JSON', () => {
    assert.ok(/_relayApiFetchBinary\(p\.apiKey, `\/api\/fieldwork\/media\/\$\{mediaId\}`\)/.test(fetchMedia),
      'the JSON helper would mangle ciphertext into a string');
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4. Order of operations');
  // ═══════════════════════════════════════════════════════════════════════

  ok('the file is written before the server copy is purged', () => {
    const write = fetchMedia.indexOf('_writeFieldWorkMediaFile');
    const purge = fetchMedia.indexOf("method: 'DELETE'");
    assert.ok(write !== -1 && purge !== -1, 'both steps must be present');
    assert.ok(write < purge, 'purging before the write would destroy the only copy');
  });

  ok('a failed purge does not fail the import', () => {
    const end = fetchMedia.indexOf('return { success: true, fileName: written.fileName');
    assert.ok(end !== -1, 'the success return moved');
    assert.ok(/purged = false/.test(fetchMedia.slice(0, end)),
      'a delete failure must degrade to purged:false — the bytes are already on disk');
  });

  ok('downloading results is documented as destructive on the server', () => {
    const dl = handlerSource('fieldwork-form-download');
    assert.ok(/DELETES the entry rows/.test(dl),
      'the next person to touch this needs to know the attachments outlive the entries');
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n5. Field Work and Area Canvas do not share a folder');
  // ═══════════════════════════════════════════════════════════════════════

  ok('Field Work has its own media directory', () => {
    assert.ok(SRC.indexOf("FIELD_WORK_MEDIA_DIR = 'Field Work Media'") !== -1);
    assert.ok(SRC.indexOf("CANVAS_MEDIA_DIR = 'Canvas Media'") !== -1);
  });

  ok('every Field Work handler points at the Field Work folder', () => {
    ['fieldwork-read-media', 'fieldwork-delete-media', 'fieldwork-media-to-evidence']
      .forEach(function (ch) {
        const h = handlerSource(ch);
        assert.ok(h.indexOf('FIELD_WORK_MEDIA_DIR') !== -1, ch + ' lost its folder');
        assert.ok(h.indexOf('CANVAS_MEDIA_DIR') === -1, ch + ' reaches into the canvass folder');
      });
  });

  ok('but they share the code that writes, reads and deletes', () => {
    ['_writeCaseMediaFile', '_readCaseMediaFile', '_deleteCaseMediaFiles', '_caseMediaToEvidence']
      .forEach(function (fn) {
        assert.ok(SRC.indexOf('function ' + fn + '(') !== -1, fn + ' is missing');
      });
    assert.ok(/function _writeCanvasMediaFile[\s\S]{0,200}_writeCaseMediaFile\(/.test(SRC),
      'canvass must go through the shared writer, not keep a second copy of it');
    assert.ok(/function _writeFieldWorkMediaFile[\s\S]{0,200}_writeCaseMediaFile\(/.test(SRC),
      'field work must go through the shared writer too');
  });

  // Run the shared writer for real against a temp case folder. The whole
  // point of the exclusive-create loop is that two saves racing for one name
  // cannot silently destroy the first file.
  ok('the shared writer claims its name with an exclusive create', () => {
    const a = SRC.indexOf('function _writeCaseMediaFile(');
    const b = SRC.indexOf('\n}', SRC.indexOf('return { fileName: finalName, size: buf.length };', a));
    const block = SRC.slice(a, b + 2);
    assert.ok(block.indexOf("flag: 'wx'") !== -1,
      'a check-then-write window is how one capture silently overwrites another');

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-fw-'));
    const env = {
      fs: fs, path: path, casesDir: TMP, security: null,
      Buffer: Buffer, Error: Error, String: String
    };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext(block + '\nglobalThis.__w = _writeCaseMediaFile;', env);

    const first = env.__w('25-010', 'Field Work Media', 'statement.pdf', Buffer.from('ONE'));
    const second = env.__w('25-010', 'Field Work Media', 'statement.pdf', Buffer.from('TWO'));
    assert.strictEqual(first.fileName, 'statement.pdf');
    assert.strictEqual(second.fileName, 'statement (1).pdf', 'a collision suffixes, never overwrites');
    const dir = path.join(TMP, '25-010', 'Field Work Media');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'statement.pdf'), 'utf8'), 'ONE',
      'the first file survived the second save');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'statement (1).pdf'), 'utf8'), 'TWO');
    assert.ok(!fs.existsSync(path.join(TMP, '25-010', 'Canvas Media')),
      'nothing leaked into the canvass folder');
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6. The renderer can actually reach all of it');
  // ═══════════════════════════════════════════════════════════════════════
  // A handler with no preload bridge is invisible to the renderer, and the
  // failure mode is a button that does nothing with no error in any log.

  const BRIDGES = {
    fieldWorkSaveMedia: 'fieldwork-save-media',
    fieldWorkReadMedia: 'fieldwork-read-media',
    fieldWorkDeleteMedia: 'fieldwork-delete-media',
    fieldWorkMediaToEvidence: 'fieldwork-media-to-evidence',
    fieldWorkFormCreate: 'fieldwork-form-create',
    fieldWorkFormGetInfo: 'fieldwork-form-get-info',
    fieldWorkFormDownload: 'fieldwork-form-download',
    fieldWorkFormDelete: 'fieldwork-form-delete',
    fieldWorkFetchMedia: 'fieldwork-fetch-media'
  };

  Object.keys(BRIDGES).forEach(function (name) {
    const channel = BRIDGES[name];
    ok('preload exposes ' + name, function () {
      const re = new RegExp(name + ':\\s*\\(.*?\\)\\s*=>\\s*ipcRenderer\\.invoke\\(\'' + channel + '\'');
      assert.ok(re.test(PRELOAD), name + ' is not bridged to ' + channel);
    });
    ok('main registers ' + channel, function () {
      assert.ok(SRC.indexOf("ipcMain.handle('" + channel + "'") !== -1);
    });
  });

  console.log('');
  if (failed) { console.log('FAILED — ' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
  console.log('ALL PASS — ' + passed + ' passed, 0 failed');
})();
