/**
 * VIPER Shared ZIP decryption (main process only)
 * ─────────────────────────────────────────────────────────────────────────
 * Reads ONE password-protected entry out of a ZIP on disk. Providers (X,
 * and others) deliver warrant returns as password-protected ZIPs; the
 * streaming reader (node-stream-zip) lists those entries but refuses to
 * read them. This module supports both schemes found in the wild:
 *
 *   • Traditional PKWARE "ZipCrypto" (GP flag bit 0, any method)
 *   • WinZip AES-128/192/256 (method 99, extra field 0x9901), AE-1 and AE-2
 *
 * The password is only ever held in memory for the call. Nothing here logs
 * or stores it, and error messages never contain it.
 *
 *   readEncryptedEntry(fd, entry, password) → Buffer (uncompressed bytes)
 *     entry = { offset, compressedSize, method, flags, crc }  (central directory;
 *     offset = local header position — node-stream-zip's entry fields)
 *
 * Errors carry err.code:
 *   ZIP_PASSWORD_REQUIRED   no password supplied
 *   ZIP_PASSWORD_WRONG      password does not open this entry
 *   ZIP_ENCRYPTION_UNSUPPORTED  strong encryption / unknown method
 *   ZIP_ENTRY_CORRUPT       data fails its integrity check
 */

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

const MSG = {
    ZIP_PASSWORD_REQUIRED: 'This ZIP is password-protected. Enter the password the provider sent with the production.',
    ZIP_PASSWORD_WRONG: 'That password does not open this ZIP.',
    ZIP_ENCRYPTION_UNSUPPORTED: 'This ZIP uses an encryption type VIPER cannot open. Extract it with 7-Zip using the password, then import the folder.',
    ZIP_ENTRY_CORRUPT: 'A file inside this ZIP is damaged (integrity check failed).',
};

// ─── ZipCrypto (traditional PKWARE) ─────────────────────────────────────

function _zipCryptoKeys(pwBytes) {
    const k = [0x12345678, 0x23456789, 0x34567890];
    for (let i = 0; i < pwBytes.length; i++) _zcUpdate(k, pwBytes[i]);
    return k;
}

function _zcUpdate(k, c) {
    k[0] = (CRC_TABLE[(k[0] ^ c) & 0xFF] ^ (k[0] >>> 8)) >>> 0;
    k[1] = (k[1] + (k[0] & 0xFF)) >>> 0;
    k[1] = (Math.imul(k[1], 134775813) + 1) >>> 0;
    k[2] = (CRC_TABLE[(k[2] ^ (k[1] >>> 24)) & 0xFF] ^ (k[2] >>> 8)) >>> 0;
}

/** Decrypt a ZipCrypto stream (12-byte header + data). Returns null if the check byte fails. */
function zipCryptoDecrypt(data, pwBytes, checkByte) {
    if (data.length < 12) return null;
    const k = _zipCryptoKeys(pwBytes);
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
        const t = (k[2] | 2) & 0xFFFF;
        const c = (data[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xFF)) & 0xFF;
        _zcUpdate(k, c);
        out[i] = c;
        if (i === 11 && c !== checkByte) return null;
    }
    return out.subarray(12);
}

// ─── WinZip AES ─────────────────────────────────────────────────────────

/** Parse the 0x9901 AES extra field from a local/central extra block. */
function parseAesExtra(extra) {
    let p = 0;
    while (extra && p + 4 <= extra.length) {
        const id = extra.readUInt16LE(p);
        const len = extra.readUInt16LE(p + 2);
        if (id === 0x9901 && len >= 7 && p + 4 + len <= extra.length) {
            return {
                version: extra.readUInt16LE(p + 4),          // 1 = AE-1 (CRC kept), 2 = AE-2
                strength: extra[p + 8],                       // 1/2/3 = 128/192/256
                method: extra.readUInt16LE(p + 9),            // real compression method
            };
        }
        p += 4 + len;
    }
    return null;
}

function aesDecrypt(data, pwBytes, strength) {
    const keyLen = { 1: 16, 2: 24, 3: 32 }[strength];
    if (!keyLen) throw zipError('ZIP_ENCRYPTION_UNSUPPORTED', MSG.ZIP_ENCRYPTION_UNSUPPORTED);
    const saltLen = keyLen / 2;
    if (data.length < saltLen + 2 + 10) throw zipError('ZIP_ENTRY_CORRUPT', MSG.ZIP_ENTRY_CORRUPT);
    const salt = data.subarray(0, saltLen);
    const verifier = data.subarray(saltLen, saltLen + 2);
    const cipher = data.subarray(saltLen + 2, data.length - 10);
    const auth = data.subarray(data.length - 10);
    const dk = crypto.pbkdf2Sync(pwBytes, salt, 1000, keyLen * 2 + 2, 'sha1');
    if (!dk.subarray(keyLen * 2).equals(verifier)) return null;           // wrong password (1 in 65536 false pass)
    const mac = crypto.createHmac('sha1', dk.subarray(keyLen, keyLen * 2)).update(cipher).digest().subarray(0, 10);
    if (!crypto.timingSafeEqual(mac, auth)) return false;                 // verifier matched but data altered → damage
    // AES-CTR with a LITTLE-endian counter starting at 1 (Node's ctr mode is
    // big-endian), so build the keystream from ECB-encrypted counter blocks.
    const ecb = crypto.createCipheriv(`aes-${keyLen * 8}-ecb`, dk.subarray(0, keyLen), null);
    ecb.setAutoPadding(false);
    const out = Buffer.allocUnsafe(cipher.length);
    const BLOCKS = 65536;                                                  // 1 MiB of keystream per pass
    let counter = 1;
    for (let pos = 0; pos < cipher.length; pos += BLOCKS * 16) {
        const n = Math.min(BLOCKS, Math.ceil((cipher.length - pos) / 16));
        const ctr = Buffer.alloc(n * 16);
        for (let b = 0; b < n; b++, counter++) {
            ctr.writeUInt32LE(counter >>> 0, b * 16);
            ctr.writeUInt32LE(Math.floor(counter / 0x100000000), b * 16 + 4);
        }
        const ks = ecb.update(ctr);
        const end = Math.min(cipher.length, pos + n * 16);
        for (let i = pos; i < end; i++) out[i] = cipher[i] ^ ks[i - pos];
    }
    return out;
}

// ─── Entry reader ───────────────────────────────────────────────────────

function _inflate(method, buf) {
    if (method === 0) return buf;
    if (method === 8) return zlib.inflateRawSync(buf);
    throw zipError('ZIP_ENCRYPTION_UNSUPPORTED', `This ZIP uses compression method ${method}, which VIPER cannot read. Extract it with 7-Zip, then import the folder.`);
}

function _pwVariants(password) {
    const s = String(password);
    const utf8 = Buffer.from(s, 'utf8');
    const latin1 = Buffer.from(s, 'latin1');
    return utf8.equals(latin1) ? [utf8] : [utf8, latin1];
}

function readEncryptedEntry(fd, entry, password) {
    if (password == null || password === '') throw zipError('ZIP_PASSWORD_REQUIRED', MSG.ZIP_PASSWORD_REQUIRED);
    if (entry.flags & 0x40) throw zipError('ZIP_ENCRYPTION_UNSUPPORTED', MSG.ZIP_ENCRYPTION_UNSUPPORTED); // PKWARE strong encryption
    const loc = Buffer.alloc(30);
    fs.readSync(fd, loc, 0, 30, entry.offset);
    if (loc.readUInt32LE(0) !== 0x04034b50) throw zipError('ZIP_ENTRY_CORRUPT', MSG.ZIP_ENTRY_CORRUPT);
    const fnLen = loc.readUInt16LE(26);
    const exLen = loc.readUInt16LE(28);
    const extra = Buffer.alloc(exLen);
    if (exLen) fs.readSync(fd, extra, 0, exLen, entry.offset + 30 + fnLen);
    const data = Buffer.alloc(entry.compressedSize);
    if (entry.compressedSize) fs.readSync(fd, data, 0, entry.compressedSize, entry.offset + 30 + fnLen + exLen);

    const variants = _pwVariants(password);
    if (entry.method === 99) {
        const aes = parseAesExtra(extra);
        if (!aes) throw zipError('ZIP_ENCRYPTION_UNSUPPORTED', MSG.ZIP_ENCRYPTION_UNSUPPORTED);
        let damaged = false;
        for (const pw of variants) {
            const plain = aesDecrypt(data, pw, aes.strength);
            if (plain === false) { damaged = true; continue; }
            if (!plain) continue;
            const out = _inflate(aes.method, plain);
            if (aes.version === 1 && entry.crc && crc32(out) !== (entry.crc >>> 0)) throw zipError('ZIP_ENTRY_CORRUPT', MSG.ZIP_ENTRY_CORRUPT);
            return out;
        }
        if (damaged) throw zipError('ZIP_ENTRY_CORRUPT', MSG.ZIP_ENTRY_CORRUPT);
        throw zipError('ZIP_PASSWORD_WRONG', MSG.ZIP_PASSWORD_WRONG);
    }

    // ZipCrypto. Check byte = high byte of CRC, or of the DOS time when the
    // sizes/CRC follow in a data descriptor (GP bit 3).
    const locFlags = loc.readUInt16LE(6);
    const dosTime = loc.readUInt16LE(10);
    const checkByte = ((entry.flags | locFlags) & 0x08) ? ((dosTime >>> 8) & 0xFF) : ((entry.crc >>> 24) & 0xFF);
    for (const pw of variants) {
        const plain = zipCryptoDecrypt(data, pw, checkByte);
        if (!plain) continue;
        let out;
        try { out = _inflate(entry.method, plain); }
        catch (e) { if (e && /^ZIP_/.test(e.code || '')) throw e; continue; } // zlib garbage → wrong password that passed the check byte
        if (crc32(out) !== (entry.crc >>> 0)) continue;
        return out;
    }
    throw zipError('ZIP_PASSWORD_WRONG', MSG.ZIP_PASSWORD_WRONG);
}

module.exports = { readEncryptedEntry, crc32, zipError, parseAesExtra, MSG, _zipCryptoKeys, _zcUpdate };
