'use strict';
/*
 * case-blob-store.js — MAIN PROCESS half of case-blobs.js.
 *
 * Writes and reads the photos/documents that case records used to keep
 * inline in localStorage, under
 *
 *     cases/<caseNumber>/Attachments/<sha256>.<ext>
 *
 * Called through SYNCHRONOUS IPC (ipcMain.on + event.returnValue), because
 * it sits underneath localStorage.getItem/setItem, which are synchronous.
 * So everything here is synchronous too, never throws (every outcome is a
 * structured {ok, ...} result) and never trusts the renderer:
 *
 *   - the case number goes through the same _safeCaseNumber gate as every
 *     other case-folder handler, and the final path is checked to sit
 *     inside casesDir;
 *   - the file name is DERIVED here (hash + extension from a fixed MIME
 *     table) — no name or path from the renderer ever reaches the disk;
 *   - base64 must be canonical, so the bytes rebuild the identical string;
 *   - the SHA-256 of the plain bytes is checked before an existing file is
 *     accepted, after every write, and on every read. A file that does not
 *     match its name is reported, never served.
 *
 * Field Security: written encrypted when the vault is on and unlocked,
 * refused (code LOCKED) when it is on and locked — never plaintext behind a
 * locked vault. The renderer keeps such data inline instead.
 *
 * Writes are atomic: unique temp file in the same folder, fsync, rename.
 */

const nodeCrypto = require('crypto');
const shared = require('./case-blobs.js');

const MAX_BYTES = Math.floor(shared.MAX_CHARS / 4) * 3;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function create(deps) {
    const fs = deps.fs;
    const path = deps.path;
    const crypto = deps.crypto || nodeCrypto;
    const getCasesDir = deps.getCasesDir;
    const getSecurity = deps.getSecurity || (() => null);
    const safeCaseNumber = deps.safeCaseNumber;
    const maxBytes = deps.maxBytes || MAX_BYTES;
    const log = deps.log || ((...a) => { try { console.warn(...a); } catch (_) { /* ignore */ } });

    function fail(code, error) { return { ok: false, code, error: error || code }; }

    function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

    function isVipenc(buf) {
        return buf.length >= 6 && buf[0] === 0x56 && buf[1] === 0x49 && buf[2] === 0x50
            && buf[3] === 0x45 && buf[4] === 0x4E && buf[5] === 0x43;
    }

    function securityState() {
        const sec = getSecurity();
        if (!sec || typeof sec.isEnabled !== 'function' || !sec.isEnabled()) return { sec: null, on: false, unlocked: false };
        return { sec, on: true, unlocked: !!sec.isUnlocked() };
    }

    function folderFor(caseNumber) {
        const cn = safeCaseNumber(caseNumber);
        if (!cn || !cn.trim() || cn === '.' ) return null;
        const root = getCasesDir();
        if (!root || typeof root !== 'string') return null;
        const dir = path.join(root, cn, shared.FOLDER_NAME);
        const rel = path.relative(root, dir);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return dir;
    }

    function decodeStrict(b64) {
        if (typeof b64 !== 'string' || !b64.length || b64.length % 4 !== 0) return null;
        if (b64.length > shared.MAX_CHARS || !B64_RE.test(b64)) return null;
        const buf = Buffer.from(b64, 'base64');
        if (buf.toString('base64') !== b64) return null;
        return buf;
    }

    // Plain bytes of a stored file, or a failure code.
    function readPlain(file) {
        let raw;
        try { raw = fs.readFileSync(file); }
        catch (e) { return fail(e && e.code === 'ENOENT' ? 'MISSING' : 'READ', e && e.message); }
        if (isVipenc(raw)) {
            const st = securityState();
            if (!st.on || !st.unlocked) return fail('LOCKED', 'File is encrypted; unlock Field Security to open.');
            try { raw = st.sec.decryptBuffer(raw); }
            catch (e) { return fail('DECRYPT', e && e.message); }
            if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
        }
        return { ok: true, buf: raw };
    }

    function writeAll(fd, bytes) {
        let off = 0;
        while (off < bytes.length) {
            off += fs.writeSync(fd, bytes, off, bytes.length - off, off);
        }
    }

    function put(payload) {
        try {
            const dir = folderFor(payload && payload.caseNumber);
            if (!dir) return fail('CASE', 'Invalid case number');
            const id = shared.idForMime(payload && payload.mime);
            if (!id) return fail('MIME', 'Unsupported file type');
            const b64 = payload && payload.base64;
            if (typeof b64 === 'string' && b64.length > Math.ceil(maxBytes / 3) * 4) return fail('SIZE', 'File too large');
            const buf = decodeStrict(b64);
            if (!buf) return fail('BASE64', 'Malformed file data');
            if (buf.length > maxBytes) return fail('SIZE', 'File too large');

            const st = securityState();
            if (st.on && !st.unlocked) return fail('LOCKED', 'Field Security is locked');

            const sha = sha256(buf);
            const ref = shared.makeRef(sha, id);
            const file = path.join(dir, sha + '.' + shared.MIME_IDS[id].ext);

            // Content addressed: an existing file is only accepted once its
            // plain bytes prove they are these bytes.
            if (fs.existsSync(file)) {
                const have = readPlain(file);
                if (have.ok && sha256(have.buf) === sha) return { ok: true, ref, bytes: buf.length, existed: true };
                if (!have.ok && have.code === 'LOCKED') return fail('LOCKED', have.error);
                log('[case-blob-store] replacing a file that does not match its name:', file, have.ok ? 'hash mismatch' : have.code);
            }

            const bytes = st.on ? st.sec.encryptBuffer(buf) : buf;
            fs.mkdirSync(dir, { recursive: true });
            const tmp = path.join(dir, '.' + sha.slice(0, 16) + '.' + process.pid + '.'
                + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp');
            let fd = null;
            try {
                fd = fs.openSync(tmp, 'wx');
                writeAll(fd, bytes);
                try { fs.fsyncSync(fd); } catch (_) { /* best effort on network/cloud drives */ }
                fs.closeSync(fd);
                fd = null;
                fs.renameSync(tmp, file);
            } catch (e) {
                if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
                try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
                // A rename can lose a race with another window writing the
                // same content (or a sync client holding the file). If the
                // file there now verifies, the job is done.
                const have = fs.existsSync(file) ? readPlain(file) : null;
                if (have && have.ok && sha256(have.buf) === sha) return { ok: true, ref, bytes: buf.length, existed: true };
                return fail('WRITE', e && e.message);
            }

            const check = readPlain(file);
            if (!check.ok) return fail('VERIFY', check.error);
            if (sha256(check.buf) !== sha) return fail('VERIFY', 'Written file failed verification');
            return { ok: true, ref, bytes: buf.length, existed: false };
        } catch (e) {
            return fail('ERROR', e && e.message);
        }
    }

    function read(payload) {
        try {
            const dir = folderFor(payload && payload.caseNumber);
            if (!dir) return fail('CASE', 'Invalid case number');
            const p = shared.parseRef(payload && payload.ref);
            if (!p) return fail('REF', 'Malformed reference');
            const file = path.join(dir, p.sha + '.' + p.ext);
            const have = readPlain(file);
            if (!have.ok) return have;
            if (have.buf.length > maxBytes) return fail('SIZE', 'File too large');
            if (sha256(have.buf) !== p.sha) return fail('CORRUPT', 'File does not match its fingerprint');
            return { ok: true, base64: have.buf.toString('base64'), bytes: have.buf.length };
        } catch (e) {
            return fail('ERROR', e && e.message);
        }
    }

    return { put, read, folderFor };
}

module.exports = { create, MAX_BYTES };
