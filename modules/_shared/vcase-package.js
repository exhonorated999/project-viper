/**
 * vcase-package.js — the .vcase v2 container format.
 *
 * MAIN-PROCESS ONLY. This module requires node's `crypto`; the renderer
 * never seals or opens a package itself, it asks main to do it. A renderer
 * reload will not pick up edits here — the app has to restart.
 *
 * ── Why v2 exists ────────────────────────────────────────────────────────
 * v1 was a bare JSON file: case record, module data, shared data, tasks.
 * It carried NO files, so an exported case arrived at the other detective
 * with evidence records that pointed at photographs, recordings and
 * extractions that were not in the package. And it was sealed — when Field
 * Security was on — with the EXPORTING machine's vault key, which is
 * derived from that officer's password and that machine's salt. Nobody
 * else could ever open it. A case handoff that only works on the machine
 * that made it is not a case handoff.
 *
 * v2 is a ZIP:
 *
 *     supplement.json          the data package (same shape as v1, + more)
 *     cases/<caseNumber>/...   the case folder, written DECRYPTED
 *     MANIFEST.csv             every file, with its SHA-256 and who sent it
 *
 * Files go in decrypted for the same reason the .vbak backup does: the key
 * that would unwrap them does not travel, and shipping bytes nobody can
 * read while calling it an export is a lie. The receiving VIPER re-encrypts
 * on the way to disk under ITS OWN Field Security policy.
 *
 * ── The password ─────────────────────────────────────────────────────────
 * Optional, and separate from Field Security. It is derived from what the
 * sender types and nothing else, so the recipient can open the package on
 * any machine with any vault state — which is the whole point. The sender
 * has to tell the recipient the password by some other channel; that is
 * the same deal the PULSE export already makes.
 *
 * Sealed layout — header, then the ciphertext, then the tag:
 *
 *     0  ..  7   magic 'VCASEENC'
 *     8          format version (1)
 *     9          KDF id (1 = PBKDF2-HMAC-SHA256)
 *    10  .. 13   iteration count, uint32 big-endian
 *    14  .. 29   salt (16 bytes)
 *    30  .. 41   IV (12 bytes)
 *    42  ..  n   AES-256-GCM ciphertext
 *     n  ..      auth tag (16 bytes, at the very end)
 *
 * Tag-last matches the Area Canvas / Field Work relay layout, which is
 * IV ‖ ciphertext ‖ tag. Here the IV lives in the header because the header
 * also has to carry the KDF parameters, but the tag stays where the rest of
 * the codebase expects to find it.
 *
 * The iteration count is written into the file rather than compiled in, so
 * raising it later does not orphan every package already in the field.
 */

(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VcasePackage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var crypto = null;
    try { crypto = require('crypto'); } catch (_) { crypto = null; }

    var MAGIC = 'VCASEENC';
    var MAGIC_LEN = 8;
    var FORMAT_VERSION = 1;
    var KDF_PBKDF2_SHA256 = 1;
    var SALT_LEN = 16;
    var IV_LEN = 12;
    var TAG_LEN = 16;
    var KEY_LEN = 32;
    var HEADER_LEN = MAGIC_LEN + 1 + 1 + 4 + SALT_LEN + IV_LEN;   // 42

    /* OWASP's current PBKDF2-HMAC-SHA256 floor. This runs once per export
     * and once per import, against a file that may sit in a third party's
     * cloud storage for years, so the cost is in the right place. */
    var ITERATIONS = 310000;

    /* The entry names inside the ZIP. Fixed strings — the importer looks
     * for them by name, so they are part of the format. */
    var DATA_ENTRY = 'supplement.json';
    var MANIFEST_ENTRY = 'MANIFEST.csv';
    var FILES_PREFIX = 'cases/';

    var PACKAGE_VERSION = '2.0';

    /* ── shape sniffing ──────────────────────────────────────────────── */

    /** True when the buffer starts with the sealed-package magic. Read from
     *  the first 8 bytes only, so a 2 GB package can be classified from a
     *  partial read. */
    function isSealed(buf) {
        if (!buf || buf.length < MAGIC_LEN) return false;
        for (var i = 0; i < MAGIC_LEN; i++) {
            if (buf[i] !== MAGIC.charCodeAt(i)) return false;
        }
        return true;
    }

    /** True for a plain (unsealed) ZIP. Every ZIP starts 'PK'. */
    function looksLikeZip(buf) {
        return !!buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B;
    }

    /* ── header ──────────────────────────────────────────────────────── */

    function buildHeader(salt, iv, iterations) {
        var h = Buffer.alloc(HEADER_LEN);
        h.write(MAGIC, 0, MAGIC_LEN, 'ascii');
        h.writeUInt8(FORMAT_VERSION, MAGIC_LEN);
        h.writeUInt8(KDF_PBKDF2_SHA256, MAGIC_LEN + 1);
        h.writeUInt32BE(iterations, MAGIC_LEN + 2);
        Buffer.from(salt).copy(h, MAGIC_LEN + 6);
        Buffer.from(iv).copy(h, MAGIC_LEN + 6 + SALT_LEN);
        return h;
    }

    /**
     * Read a sealed header. Returns null for anything that is not one —
     * callers treat null as "this is not a sealed package", never as an
     * error, because the same bytes might be a plain ZIP or v1 JSON.
     */
    function parseHeader(buf) {
        if (!isSealed(buf) || buf.length < HEADER_LEN) return null;
        var version = buf.readUInt8(MAGIC_LEN);
        var kdf = buf.readUInt8(MAGIC_LEN + 1);
        /* An unknown version means the package was made by a NEWER VIPER.
         * Say so rather than failing on the tag at the far end of a
         * multi-gigabyte decrypt. */
        if (version !== FORMAT_VERSION) {
            return { unsupported: true, version: version, kdf: kdf };
        }
        if (kdf !== KDF_PBKDF2_SHA256) {
            return { unsupported: true, version: version, kdf: kdf };
        }
        return {
            unsupported: false,
            version: version,
            kdf: kdf,
            iterations: buf.readUInt32BE(MAGIC_LEN + 2),
            salt: buf.subarray(MAGIC_LEN + 6, MAGIC_LEN + 6 + SALT_LEN),
            iv: buf.subarray(MAGIC_LEN + 6 + SALT_LEN, HEADER_LEN),
            headerLen: HEADER_LEN
        };
    }

    /* ── key derivation ──────────────────────────────────────────────── */

    function deriveKey(password, salt, iterations) {
        if (!crypto) throw new Error('vcase-package: crypto unavailable');
        return crypto.pbkdf2Sync(
            Buffer.from(String(password), 'utf-8'),
            Buffer.from(salt),
            iterations || ITERATIONS,
            KEY_LEN,
            'sha256'
        );
    }

    /* ── sealing ─────────────────────────────────────────────────────── */

    /**
     * Start a streaming seal. The caller pipes the ZIP through `cipher`,
     * writes `header` first, and appends `tag()` once the cipher has
     * finished — which is why the tag lives at the end of the file.
     *
     * Streaming rather than buffering is deliberate: a case with a phone
     * extraction in it can be several gigabytes, and holding the archive
     * and its ciphertext in memory at once is how an export turns into a
     * crash at the end of a ten-minute wait.
     */
    function createSeal(password, opts) {
        if (!crypto) throw new Error('vcase-package: crypto unavailable');
        var iterations = (opts && opts.iterations) || ITERATIONS;
        var salt = (opts && opts.salt) ? Buffer.from(opts.salt) : crypto.randomBytes(SALT_LEN);
        var iv = (opts && opts.iv) ? Buffer.from(opts.iv) : crypto.randomBytes(IV_LEN);
        var key = deriveKey(password, salt, iterations);
        var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        return {
            header: buildHeader(salt, iv, iterations),
            cipher: cipher,
            tag: function () { return cipher.getAuthTag(); }
        };
    }

    /** Whole-buffer seal. Used by the tests and by small data-only
     *  packages; the file path uses createSeal() instead. */
    function sealBuffer(plain, password, opts) {
        var s = createSeal(password, opts);
        var body = Buffer.concat([s.cipher.update(Buffer.from(plain)), s.cipher.final()]);
        return Buffer.concat([s.header, body, s.tag()]);
    }

    /* ── opening ─────────────────────────────────────────────────────── */

    /**
     * Reasons an open can fail, as stable strings rather than prose, so the
     * caller can tell "you typed the wrong password" apart from "this file
     * is damaged" and say the right thing to the officer.
     */
    var ERR_NOT_SEALED = 'not_sealed';
    var ERR_UNSUPPORTED = 'unsupported_version';
    var ERR_TRUNCATED = 'truncated';
    var ERR_PASSWORD = 'bad_password';

    /**
     * Whole-buffer open. Returns { ok: true, data } or { ok: false, reason }.
     *
     * A GCM tag mismatch cannot distinguish a wrong password from a
     * corrupted file — both are "the bytes are not what the key says they
     * should be". We report bad_password because that is overwhelmingly
     * the likely cause and it is the one the officer can act on, and the
     * message says "wrong password, or the file is damaged" so we are not
     * claiming more than we know.
     */
    function openBuffer(buf, password) {
        if (!crypto) throw new Error('vcase-package: crypto unavailable');
        var hdr = parseHeader(buf);
        if (!hdr) return { ok: false, reason: ERR_NOT_SEALED };
        if (hdr.unsupported) return { ok: false, reason: ERR_UNSUPPORTED, version: hdr.version };
        if (buf.length < HEADER_LEN + TAG_LEN) return { ok: false, reason: ERR_TRUNCATED };
        var key = deriveKey(password, hdr.salt, hdr.iterations);
        var body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
        var tag = buf.subarray(buf.length - TAG_LEN);
        try {
            var d = crypto.createDecipheriv('aes-256-gcm', key, hdr.iv);
            d.setAuthTag(tag);
            return { ok: true, data: Buffer.concat([d.update(body), d.final()]) };
        } catch (_) {
            return { ok: false, reason: ERR_PASSWORD };
        }
    }

    /* ── MANIFEST.csv ────────────────────────────────────────────────── */

    /* Same 11 columns, same quoting and same CRLF as the Assist Package
     * manifest, because a detective who has read one has read both. Keeping
     * them identical is worth more than tailoring the wording. */
    var MANIFEST_COLUMNS = [
        'Archived Path', 'Original Path', 'Module', 'Size (bytes)', 'SHA-256',
        'Contributed By', 'Rank', 'Badge', 'Agency', 'Parent Case Number', 'Notes'
    ];

    function _q(v) {
        return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    }

    /**
     * rows: [{ archived, original, module, bytes, sha256, note }]
     * who:  { officerName, officerRank, officerBadge, agencyName }
     */
    function manifestCsv(rows, who, caseNumber) {
        var w = who || {};
        var out = [MANIFEST_COLUMNS.map(_q).join(',')];
        (rows || []).forEach(function (r) {
            out.push([
                r.archived, r.original, r.module, r.bytes, r.sha256,
                w.officerName || '', w.officerRank || '', w.officerBadge || '',
                w.agencyName || '', caseNumber || '', r.note || ''
            ].map(_q).join(','));
        });
        return out.join('\r\n') + '\r\n';
    }

    /* ── archive paths ───────────────────────────────────────────────── */

    /**
     * A ZIP entry name is attacker-controlled on the import side: a package
     * from another agency is a file we did not write. Reject anything that
     * climbs out of the destination folder, anything absolute, and anything
     * with a drive letter. Returns null for a path that must not be
     * written, which the caller logs and skips rather than aborting the
     * whole import — one hostile or malformed entry should not cost the
     * detective the rest of the case.
     */
    function safeRelPath(entryName) {
        var n = String(entryName || '').replace(/\\/g, '/');
        if (!n) return null;
        if (n.charAt(0) === '/') return null;
        if (/^[a-zA-Z]:/.test(n)) return null;
        var parts = n.split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p === '' || p === '.') continue;
            if (p === '..') return null;
            out.push(p);
        }
        return out.length ? out.join('/') : null;
    }

    /** `cases/<caseNumber>/Evidence/x.jpg` → `Evidence/x.jpg`, or null when
     *  the entry is not a case file at all. */
    function caseFileRelPath(entryName) {
        var safe = safeRelPath(entryName);
        if (!safe || safe.indexOf(FILES_PREFIX) !== 0) return null;
        var rest = safe.slice(FILES_PREFIX.length);
        var slash = rest.indexOf('/');
        if (slash < 0) return null;
        var inner = rest.slice(slash + 1);
        return inner || null;
    }

    return {
        MAGIC: MAGIC,
        FORMAT_VERSION: FORMAT_VERSION,
        PACKAGE_VERSION: PACKAGE_VERSION,
        HEADER_LEN: HEADER_LEN,
        SALT_LEN: SALT_LEN,
        IV_LEN: IV_LEN,
        TAG_LEN: TAG_LEN,
        ITERATIONS: ITERATIONS,
        DATA_ENTRY: DATA_ENTRY,
        MANIFEST_ENTRY: MANIFEST_ENTRY,
        FILES_PREFIX: FILES_PREFIX,
        MANIFEST_COLUMNS: MANIFEST_COLUMNS,

        ERR_NOT_SEALED: ERR_NOT_SEALED,
        ERR_UNSUPPORTED: ERR_UNSUPPORTED,
        ERR_TRUNCATED: ERR_TRUNCATED,
        ERR_PASSWORD: ERR_PASSWORD,

        isSealed: isSealed,
        looksLikeZip: looksLikeZip,
        buildHeader: buildHeader,
        parseHeader: parseHeader,
        deriveKey: deriveKey,
        createSeal: createSeal,
        sealBuffer: sealBuffer,
        openBuffer: openBuffer,
        manifestCsv: manifestCsv,
        safeRelPath: safeRelPath,
        caseFileRelPath: caseFileRelPath
    };
}));
