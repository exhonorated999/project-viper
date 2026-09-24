/**
 * The relay crypto contract.
 *
 * Canvas attachments are encrypted on an officer's phone by SubtleCrypto in
 * a browser and decrypted here by node's crypto in the main process. Two
 * different APIs agreeing on a byte layout by convention alone: a 12-byte
 * IV, then AES-GCM ciphertext with its 16-byte tag appended.
 *
 * Nothing in either codebase fails loudly if that convention drifts. The
 * officer just gets a photo that will not open — weeks later, in a case
 * that matters. So this pins it, and it does so against the decrypt block
 * LIFTED OUT OF electron-main.js rather than a copy of it, because a copy
 * is the thing that drifts.
 *
 * Run:  node modules/area-canvas/__tests__/relay-crypto.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN = path.join(__dirname, '..', '..', '..', 'electron-main.js');

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

const SRC = fs.readFileSync(MAIN, 'utf8');

// ── Lift the decrypt block out of the shipping handler ─────────────────
const START = 'const iv = cipher.subarray(0, 12);';
const END = 'plain = Buffer.concat([decipher.update(body), decipher.final()]);';

function decryptUsingShippedCode(cipherBuf, keyBuf) {
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  if (a === -1 || b === -1) {
    throw new Error('the decrypt block moved in electron-main.js — update this test');
  }
  const block = SRC.slice(a, b + END.length);
  const sandbox = { cipher: cipherBuf, key: keyBuf, nodeCrypto: crypto, Buffer: Buffer };
  vm.createContext(sandbox);
  // The lifted block opens a try{} the handler closes with its own error
  // message; close it here so the throw reaches the caller intact.
  vm.runInContext(block + '\n} catch (e) { throw e; }\nglobalThis.__out = plain;', sandbox);
  return sandbox.__out;
}

// ── Encrypt exactly the way the hosted form page does ──────────────────
async function encryptLikeThePhone(keyB64Url, plaintext) {
  const raw = Buffer.from(keyB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const key = await crypto.webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return Buffer.from(out);
}

(async function run() {
  console.log('\n1. Key minting');

  ok('the key is 32 raw bytes, base64url', () => {
    assert.ok(/randomBytes\(32\)\.toString\('base64url'\)/.test(SRC),
      'canvas-form-create no longer mints a 32-byte base64url key');
  });

  ok('the key rides in the URL fragment, never a query string', () => {
    assert.ok(/form_url[^\n]*\+ '#k=' \+ mediaKey/.test(SRC),
      "the key must be appended as '#k=' — a query string would be sent to the server");
    // And the QR must encode the URL that carries it.
    const qr = SRC.slice(SRC.indexOf("const mediaKey = require('crypto')"));
    assert.ok(/QRCode\.toDataURL\(formUrl,/.test(qr),
      'the QR code must encode the URL WITH the fragment, not the bare form URL');
  });

  console.log('\n2. Round trip, browser to main process');

  const keyB64 = crypto.randomBytes(32).toString('base64url');

  await okAsync('a photo-sized blob comes back byte-identical', async () => {
    // Incompressible bytes, so a silent re-encode anywhere would show up.
    const original = crypto.randomBytes(300 * 1024);
    const blob = await encryptLikeThePhone(keyB64, original);
    assert.strictEqual(blob.length, original.length + 12 + 16, 'IV + body + tag');
    const plain = decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url'));
    assert.ok(plain.equals(original));
  });

  await okAsync('a one-byte file survives', async () => {
    const original = Buffer.from([0x42]);
    const blob = await encryptLikeThePhone(keyB64, original);
    const plain = decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url'));
    assert.ok(plain.equals(original));
  });

  await okAsync('the ciphertext does not contain the plaintext', async () => {
    const original = Buffer.alloc(4096, 0x61);
    const blob = await encryptLikeThePhone(keyB64, original);
    assert.strictEqual(blob.indexOf(original.subarray(0, 64)), -1);
  });

  console.log('\n3. A blob that is not exactly right is refused, never written');

  await okAsync('the wrong key throws', async () => {
    const blob = await encryptLikeThePhone(keyB64, crypto.randomBytes(1024));
    assert.throws(() => decryptUsingShippedCode(blob, crypto.randomBytes(32)));
  });

  await okAsync('one flipped bit throws', async () => {
    const blob = await encryptLikeThePhone(keyB64, crypto.randomBytes(1024));
    blob[100] ^= 0xff;
    assert.throws(() => decryptUsingShippedCode(blob, Buffer.from(keyB64, 'base64url')));
  });

  await okAsync('a truncated tag throws', async () => {
    const blob = await encryptLikeThePhone(keyB64, crypto.randomBytes(1024));
    assert.throws(() => decryptUsingShippedCode(blob.subarray(0, blob.length - 4),
                                                Buffer.from(keyB64, 'base64url')));
  });

  ok('the handler refuses a key that is not 32 bytes', () => {
    assert.ok(/key\.length !== 32/.test(SRC),
      'a short key must be rejected with a plain message, not passed to createDecipheriv');
  });

  ok('the handler refuses a blob too short to hold IV and tag', () => {
    assert.ok(/cipher\.length < 12 \+ 16 \+ 1/.test(SRC));
  });

  console.log('\n4. Order of operations');

  ok('the file is written before the server copy is purged', () => {
    const h = SRC.slice(SRC.indexOf("ipcMain.handle('canvas-fetch-media'"));
    const write = h.indexOf('_writeCanvasMediaFile');
    const purge = h.indexOf("method: 'DELETE'");
    assert.ok(write !== -1 && purge !== -1, 'both steps must be present');
    assert.ok(write < purge, 'purging before the write would destroy the only copy');
  });

  ok('a failed purge does not fail the import', () => {
    const h = SRC.slice(SRC.indexOf("ipcMain.handle('canvas-fetch-media'"));
    const end = h.indexOf('return { success: true, fileName: written.fileName');
    assert.ok(end !== -1, 'the success return moved');
    assert.ok(/purged = false/.test(h.slice(0, end)),
      'a delete failure must degrade to purged:false, not throw — the bytes are already on disk');
  });

  ok('attachments are fetched as bytes, not JSON', () => {
    assert.ok(/_canvasApiFetchBinary\(p\.apiKey, `\/api\/canvas\/media\/\$\{mediaId\}`\)/.test(SRC),
      'the JSON helper would mangle ciphertext into a string');
  });

  console.log('');
  if (failed) { console.log(`FAILED — ${passed} passed, ${failed} failed`); process.exit(1); }
  console.log(`ALL PASS — ${passed} passed, 0 failed`);
})();
