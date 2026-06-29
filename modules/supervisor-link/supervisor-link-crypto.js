// modules/supervisor-link/supervisor-link-crypto.js
// ---------------------------------------------------------------------------
// AES-256-GCM crypto for the Supervisor Link handshake (investigator side).
//
// MUST stay byte-for-byte compatible with:
//   viper_supervisor_edition/lan-node/crypto.mjs   (the LAN node)
//   viper_supervisor_edition/src/lan/crypto.ts     (the supervisor browser)
//
// PBKDF2(SHA-256, 150000) -> 32-byte key. AES-256-GCM, 12-byte IV, 16-byte
// auth tag APPENDED to ciphertext (ct || tag) to match Web Crypto layout.
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('node:crypto');

const PBKDF2_ITERATIONS = 150000;
const PBKDF2_HASH = 'sha256';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derive a 256-bit key from PSK + salt (salt is a Buffer). */
function deriveKey(psk, salt) {
  return crypto.pbkdf2Sync(psk, salt, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_HASH);
}

/** Encrypt a JS object -> { iv, data } hex strings (data = ct||tag). */
function encryptJSON(key, obj) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), data: Buffer.concat([ct, tag]).toString('hex') };
}

/** Decrypt { iv, data } -> JS object. Throws if auth tag fails (wrong key). */
function decryptJSON(key, iv, data) {
  const ivBuf = Buffer.from(iv, 'hex');
  const buf = Buffer.from(data, 'hex');
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(0, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = {
  PBKDF2_ITERATIONS, PBKDF2_HASH, KEY_BYTES, IV_BYTES, TAG_BYTES,
  deriveKey, encryptJSON, decryptJSON,
};
