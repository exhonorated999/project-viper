'use strict';
/*
 * case-source-store.js — MAIN PROCESS. Keeps a copy of an imported source
 * file (an RMS report PDF, …) in the case folder:
 *
 *     cases/<caseNumber>/<folder for kind>/<original file name>
 *
 * Importers used to read a file, keep what they parsed and forget the file.
 * The parsed record is a reading OF the document, not the document, so the
 * original has to sit with the case: to check the parse against, to hand to
 * a prosecutor, and to survive the officer tidying up Downloads.
 *
 * Rules:
 *   - `kind` picks the folder from a fixed allow-list (same table as the
 *     case-attachment handlers); nothing the renderer sends becomes a path
 *     except the source path we read FROM;
 *   - the stored name is the source's base name, sanitised; a different file
 *     already holding that name gets " (n)" — nothing is ever overwritten;
 *   - importing the same file twice reuses the copy already there (same
 *     name family, same SHA-256 of the plain bytes);
 *   - Field Security on + unlocked → written encrypted; on + locked → refused
 *     (never plaintext behind a locked vault);
 *   - written to a temp file in the same folder, renamed into place, then
 *     read back and checked against the source hash;
 *   - `ifInCase: 'skip'` → a source already inside this case's folder is
 *     not copied again ({success, inCase:true, path}).
 * Success results carry `path`, the stored copy's full path.
 *
 * Never throws: every outcome is {success, ...}.
 */

const nodeCrypto = require('crypto');

const DEFAULT_MAX_ENCRYPT = 1900 * 1024 * 1024;

function create(deps) {
    const fs = deps.fs;
    const path = deps.path;
    const crypto = deps.crypto || nodeCrypto;
    const getCasesDir = deps.getCasesDir;
    const getSecurity = deps.getSecurity || (() => null);
    const safeCaseNumber = deps.safeCaseNumber;
    const sanitizeName = deps.sanitizeName;
    const dirs = deps.dirs || {};
    const maxEncryptBytes = deps.maxEncryptBytes || DEFAULT_MAX_ENCRYPT;

    function fail(code, error) { return { success: false, code, error: error || code }; }

    function isVipenc(buf) {
        return buf.length >= 6 && buf[0] === 0x56 && buf[1] === 0x49 && buf[2] === 0x50
            && buf[3] === 0x45 && buf[4] === 0x4E && buf[5] === 0x43;
    }

    function hashFile(file) {
        return new Promise((resolve, reject) => {
            const h = crypto.createHash('sha256');
            const s = fs.createReadStream(file);
            s.on('error', reject);
            s.on('data', d => h.update(d));
            s.on('end', () => resolve(h.digest('hex')));
        });
    }

    function hashBuf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

    // SHA-256 of the PLAIN bytes of a stored file (decrypting a sealed one).
    // null when it can't be read (or is sealed and the vault can't open it).
    async function plainHash(file) {
        const sec = getSecurity();
        let fd = null;
        try {
            fd = await fs.promises.open(file, 'r');
            const head = Buffer.alloc(6);
            const { bytesRead } = await fd.read(head, 0, 6, 0);
            await fd.close(); fd = null;
            if (bytesRead === 6 && isVipenc(head)) {
                if (!sec || !sec.isUnlocked || !sec.isUnlocked()) return null;
                const raw = await fs.promises.readFile(file);
                return hashBuf(sec.decryptBuffer(raw));
            }
            return await hashFile(file);
        } catch (_) {
            if (fd) { try { await fd.close(); } catch (_e) { /* ignore */ } }
            return null;
        }
    }

    function inside(parent, child) {
        const rel = path.relative(parent, child);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    function folderFor(caseNumber, kind) {
        const cn = safeCaseNumber(caseNumber);
        if (!cn) return { error: fail('CASE', 'Invalid case number') };
        if (!Object.prototype.hasOwnProperty.call(dirs, kind)) return { error: fail('KIND', 'Unknown file kind') };
        const root = path.resolve(getCasesDir());
        const caseDir = path.resolve(root, cn);
        const dir = path.resolve(caseDir, dirs[kind]);
        if (!inside(root, caseDir) || !inside(caseDir, dir)) return { error: fail('CASE', 'Invalid case folder') };
        return { dir, caseDir };
    }

    async function keep(payload) {
        try {
            const p = payload || {};
            const f = folderFor(p.caseNumber, p.kind);
            if (f.error) return f.error;
            const dir = f.dir;

            const src = typeof p.sourcePath === 'string' ? p.sourcePath : '';
            if (!src || !path.isAbsolute(src)) return fail('SOURCE', 'No source file');
            let st;
            try { st = await fs.promises.stat(src); } catch (_) { return fail('NOT_FOUND', 'The source file is no longer there'); }
            if (!st.isFile()) return fail('SOURCE', 'The source is not a file');

            // A file read from inside this case's own folder (its Evidence,
            // say) is already kept with the case: no second copy when the
            // caller asks for that.
            if (p.ifInCase === 'skip' && inside(f.caseDir, path.resolve(src))) {
                return { success: true, inCase: true, fileName: path.basename(src), path: path.resolve(src),
                    size: st.size, reused: true };
            }

            const name = sanitizeName(p.fileName || path.basename(src));
            if (!name) return fail('NAME', 'Invalid file name');

            const sec = getSecurity();
            const secOn = !!(sec && sec.isEnabled && sec.isEnabled());
            if (secOn && !sec.isUnlocked()) {
                return fail('LOCKED', 'Field Security is locked — unlock it to keep a copy of the file in the case folder.');
            }
            const encrypting = secOn;
            if (encrypting && st.size > maxEncryptBytes) {
                return fail('TOO_LARGE', 'The file is too large to encrypt into the case folder while Field Security is on.');
            }

            // Read the source ONCE when it is going to be encrypted (that is
            // in memory anyway) and hash those bytes; otherwise stream-hash.
            let srcBuf = null;
            let sha;
            if (encrypting) { srcBuf = await fs.promises.readFile(src); sha = hashBuf(srcBuf); }
            else sha = await hashFile(src);

            await fs.promises.mkdir(dir, { recursive: true });

            const ext = path.extname(name);
            const stem = name.slice(0, name.length - ext.length);
            const srcAbs = path.resolve(src);
            const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

            for (let n = 0; n <= 999; n++) {
                const candName = n === 0 ? name : `${stem} (${n})${ext}`;
                const dest = path.join(dir, candName);
                if (fs.existsSync(dest)) {
                    // The file picked IS the stored copy, or an identical
                    // copy is already there: nothing to write.
                    if (same(path.resolve(dest), srcAbs) || (await plainHash(dest)) === sha) {
                        return { success: true, fileName: candName, path: dest, size: st.size, sha256: sha,
                            encrypted: isVipencFile(dest), reused: true };
                    }
                    continue;
                }

                const tmp = path.join(dir, '.' + sha.slice(0, 12) + '.' + process.pid + '.'
                    + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.partial');
                try {
                    if (encrypting) await fs.promises.writeFile(tmp, sec.encryptBuffer(srcBuf), { flag: 'wx' });
                    else await fs.promises.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
                    if (fs.existsSync(dest)) {           // lost a race for the name
                        try { await fs.promises.unlink(tmp); } catch (_) { /* ignore */ }
                        n--; continue;                   // re-check this name (maybe identical now)
                    }
                    await fs.promises.rename(tmp, dest);
                } catch (e) {
                    try { await fs.promises.unlink(tmp); } catch (_) { /* ignore */ }
                    return fail('WRITE', e && e.message);
                }

                const check = await plainHash(dest);
                if (check !== sha) {
                    try { await fs.promises.unlink(dest); } catch (_) { /* ignore */ }
                    return fail('VERIFY', 'The copy did not match the original');
                }
                return { success: true, fileName: candName, path: dest, size: st.size, sha256: sha,
                    encrypted: encrypting, reused: false };
            }
            return fail('NAME', 'Too many files with this name');
        } catch (e) {
            return fail('ERROR', e && e.message);
        }
    }

    function isVipencFile(file) {
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const b = Buffer.alloc(6);
                const n = fs.readSync(fd, b, 0, 6, 0);
                return n === 6 && isVipenc(b);
            } finally { fs.closeSync(fd); }
        } catch (_) { return false; }
    }

    return { keep, folderFor };
}

module.exports = { create, DEFAULT_MAX_ENCRYPT };
