// modules/supervisor-link/supervisor-link-crypto.js
// ---------------------------------------------------------------------------
// V.I.P.E.R. LAN crypto — protocol v2 (investigator / Electron-main side, CJS).
//
// MUST stay byte-compatible with:
//   viper_supervisor_edition/lan-node/crypto.mjs   (Node ESM, LAN node)
//   viper_supervisor_edition/src/lan/crypto.ts      (browser Web Crypto)
//
// ECDSA P-256 (identity, raw r||s sigs), ECDH P-256 (ephemeral) → HKDF-SHA-256
// → AES-256-GCM (12-byte IV, 16-byte tag appended). RFC 7638 JWK thumbprints.
// The shared-PSK-as-key model (v1) is retired; trust is per-device.
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('node:crypto');

const AEAD_IV_BYTES = 12;
const AEAD_TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('VIPER-LAN-session-v2', 'utf8');
const PROTOCOL_VERSION = 2;

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

function pubOnly(jwk) { return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }; }

function jwkThumbprint(jwk) {
  const canon = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

function deviceIdFromJwk(jwk, prefix = 'DEV') {
  return `${prefix}-${jwkThumbprint(jwk).slice(0, 16).toUpperCase()}`;
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

function signUtf8(privateJwk, msg) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return sig.toString('hex');
}

function verifyUtf8(publicJwk, msg, sigHex) {
  try {
    const key = crypto.createPublicKey({ key: pubOnly(publicJwk), format: 'jwk' });
    return crypto.verify(
      'sha256', Buffer.from(msg, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigHex, 'hex')
    );
  } catch {
    return false;
  }
}

function deriveSessionKey(myPrivJwk, peerPubJwk, saltHex) {
  const priv = crypto.createPrivateKey({ key: myPrivJwk, format: 'jwk' });
  const pub = crypto.createPublicKey({ key: pubOnly(peerPubJwk), format: 'jwk' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const salt = Buffer.from(saltHex, 'hex');
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

function encryptJSON(key, obj) {
  const iv = crypto.randomBytes(AEAD_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), data: Buffer.concat([ct, tag]).toString('hex') };
}

function decryptJSON(key, iv, data) {
  const ivBuf = Buffer.from(iv, 'hex');
  const buf = Buffer.from(data, 'hex');
  const tag = buf.subarray(buf.length - AEAD_TAG_BYTES);
  const ct = buf.subarray(0, buf.length - AEAD_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function nodeProofString(challengeHex, nodeEphThumb) {
  return `viper-node-proof|v2|${challengeHex}|${nodeEphThumb}`;
}
function deviceProofString(challengeHex, nodeEphThumb, clientEphThumb, deviceId, role) {
  return `viper-device-proof|v2|${challengeHex}|${nodeEphThumb}|${clientEphThumb}|${deviceId}|${role}`;
}

module.exports = {
  AEAD_IV_BYTES, AEAD_TAG_BYTES, HKDF_INFO, PROTOCOL_VERSION,
  randomHex, jwkThumbprint, deviceIdFromJwk, generateKeyPair,
  signUtf8, verifyUtf8, deriveSessionKey, encryptJSON, decryptJSON,
  nodeProofString, deviceProofString,
};
