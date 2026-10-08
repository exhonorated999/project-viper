/**
 * vcase-package.test.js — the .vcase v2 container format.
 *
 * Run headlessly:
 *   set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd ^
 *     modules\_shared\__tests__\vcase-package.test.js
 *
 * Two things are being pinned here.
 *
 * 1. The FORMAT. A package written today has to open years from now, on a
 *    different machine, possibly by a different agency. The byte layout is
 *    asserted at fixed offsets rather than round-tripped only, because a
 *    round trip passes happily even if both ends drift together.
 *
 * 2. The BUG that made v2 necessary. Exports used to be sealed with the
 *    exporting machine's Field Security key, which meant the detective it
 *    was sent to could never open it. The last section reads the real
 *    electron-main.js and asserts that is gone.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(REPO, 'modules', '_shared', 'vcase-package.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL  ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
}
function section(t) { console.log('\n— ' + t); }

/* ════════════════════════════════════════════════════════════════════
   the module loads
   ════════════════════════════════════════════════════════════════════ */
section('module');

const V = require(MODULE_PATH);
ok('module.exports is populated', !!V && typeof V === 'object');

/* The UMD trap: `module` IS defined in VIPER's renderer, so a wrapper that
 * only takes the CommonJS branch leaves window.X undefined and every
 * `if (window.X)` host branch silently never fires. This module is
 * main-process only today, but the wrapper has to be right anyway — the
 * next person to need it in the renderer will not check. */
{
    const src = fs.readFileSync(MODULE_PATH, 'utf-8');
    ok('UMD assigns module.exports', /module\.exports\s*=\s*api/.test(src));
    ok('UMD ALSO assigns the global, not else-if', /root\.VcasePackage\s*=\s*api/.test(src));
    ok('  — and the global assignment is not inside an else branch',
        !/else\s*\{?\s*(if\s*\([^)]*\)\s*)?root\.VcasePackage/.test(src));
    ok('globalThis.VcasePackage is set by loading it', !!globalThis.VcasePackage);
    ok('  — and it is the same object as module.exports', globalThis.VcasePackage === V);
}

/* ════════════════════════════════════════════════════════════════════
   header layout — asserted at fixed offsets
   ════════════════════════════════════════════════════════════════════ */
section('header layout');

ok('magic is VCASEENC', V.MAGIC === 'VCASEENC');
ok('magic is 8 bytes', V.MAGIC.length === 8);
ok('salt is 16 bytes', V.SALT_LEN === 16);
ok('IV is 12 bytes, which is what AES-GCM wants', V.IV_LEN === 12);
ok('tag is 16 bytes', V.TAG_LEN === 16);
ok('header is 8 magic + 1 version + 1 kdf + 4 iterations + 16 salt + 12 IV',
    V.HEADER_LEN === 42, V.HEADER_LEN);

{
    const salt = Buffer.alloc(16, 0xAB);
    const iv = Buffer.alloc(12, 0xCD);
    const h = V.buildHeader(salt, iv, 123456);
    ok('header is exactly HEADER_LEN bytes', h.length === V.HEADER_LEN, h.length);
    ok('bytes 0..7 are the magic', h.subarray(0, 8).toString('ascii') === 'VCASEENC');
    ok('byte 8 is the format version', h.readUInt8(8) === V.FORMAT_VERSION);
    ok('byte 9 is the KDF id and it is 1 (PBKDF2-SHA256)', h.readUInt8(9) === 1);
    ok('bytes 10..13 are the iteration count, big-endian',
        h.readUInt32BE(10) === 123456, h.readUInt32BE(10));
    ok('bytes 14..29 are the salt', h.subarray(14, 30).equals(salt));
    ok('bytes 30..41 are the IV', h.subarray(30, 42).equals(iv));

    const p = V.parseHeader(h);
    ok('parseHeader reads it back', !!p && !p.unsupported);
    ok('  — iterations', p.iterations === 123456);
    ok('  — salt', Buffer.from(p.salt).equals(salt));
    ok('  — IV', Buffer.from(p.iv).equals(iv));
}

/* The iteration count is IN THE FILE, not compiled in. Raising the default
 * later must not orphan packages already in the field. */
{
    const low = V.sealBuffer(Buffer.from('x'), 'pw', { iterations: 1000 });
    ok('a package written with a different iteration count still opens',
        V.openBuffer(low, 'pw').ok);
    ok('  — and it really was written with that count, not the default',
        V.parseHeader(low).iterations === 1000);
    ok('  — which is NOT the current default, so the assertion above means something',
        V.ITERATIONS !== 1000, V.ITERATIONS);
}

ok('the default iteration count meets the current OWASP PBKDF2-SHA256 floor',
    V.ITERATIONS >= 210000, V.ITERATIONS);

/* ════════════════════════════════════════════════════════════════════
   sniffing — three file shapes have to be told apart from their first bytes
   ════════════════════════════════════════════════════════════════════ */
section('shape sniffing');

{
    const sealed = V.sealBuffer(Buffer.from('payload'), 'pw');
    const zipish = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
    const jsonish = Buffer.from('{"_viperExport":true}', 'utf-8');

    ok('a sealed package is recognised', V.isSealed(sealed));
    ok('a plain ZIP is not mistaken for a sealed package', !V.isSealed(zipish));
    ok('a v1 JSON file is not mistaken for a sealed package', !V.isSealed(jsonish));

    ok('a plain ZIP is recognised', V.looksLikeZip(zipish));
    ok('a sealed package does not look like a ZIP', !V.looksLikeZip(sealed));
    ok('a v1 JSON file does not look like a ZIP', !V.looksLikeZip(jsonish));

    /* Classification must work off a partial read — a 4 GB package cannot be
     * loaded into memory just to find out what it is. */
    ok('sniffing works on the first 8 bytes alone', V.isSealed(sealed.subarray(0, 8)));
    ok('an empty buffer is neither', !V.isSealed(Buffer.alloc(0)) && !V.looksLikeZip(Buffer.alloc(0)));
    ok('a 1-byte buffer is neither', !V.isSealed(Buffer.from([0x50])) && !V.looksLikeZip(Buffer.from([0x50])));
}

/* ════════════════════════════════════════════════════════════════════
   seal / open
   ════════════════════════════════════════════════════════════════════ */
section('seal and open');

{
    const plain = crypto.randomBytes(5000);
    const sealed = V.sealBuffer(plain, 'correct horse battery staple');

    ok('sealed output is header + ciphertext + tag',
        sealed.length === V.HEADER_LEN + plain.length + V.TAG_LEN,
        { got: sealed.length, want: V.HEADER_LEN + plain.length + V.TAG_LEN });

    const opened = V.openBuffer(sealed, 'correct horse battery staple');
    ok('the right password opens it', opened.ok);
    ok('  — and returns the original bytes exactly', opened.ok && opened.data.equals(plain));

    ok('the plaintext is not sitting in the file',
        sealed.indexOf(plain.subarray(0, 32)) === -1);

    const wrong = V.openBuffer(sealed, 'correct horse battery stapl');
    ok('one character wrong is refused', !wrong.ok);
    ok('  — with a reason the caller can act on', wrong.reason === V.ERR_PASSWORD);

    ok('an empty password is refused when the file was sealed with a real one',
        !V.openBuffer(sealed, '').ok);
}

/* Two seals of the same bytes must not produce the same file: the salt and
 * IV are random per package. Reusing a GCM IV across two packages under the
 * same password is a real break, not a tidiness point. */
{
    const a = V.sealBuffer(Buffer.from('same'), 'pw');
    const b = V.sealBuffer(Buffer.from('same'), 'pw');
    ok('two seals of the same bytes differ', !a.equals(b));
    ok('  — because the salt differs',
        !Buffer.from(V.parseHeader(a).salt).equals(Buffer.from(V.parseHeader(b).salt)));
    ok('  — and the IV differs',
        !Buffer.from(V.parseHeader(a).iv).equals(Buffer.from(V.parseHeader(b).iv)));
}

/* Tampering. AES-GCM is authenticated: a changed byte anywhere must fail,
 * not decrypt to garbage. A case package that silently yields corrupted
 * evidence is worse than one that refuses to open. */
{
    const sealed = V.sealBuffer(Buffer.from('a'.repeat(400)), 'pw');

    const bodyFlip = Buffer.from(sealed);
    bodyFlip[V.HEADER_LEN + 10] ^= 0x01;
    ok('a flipped ciphertext byte is caught', !V.openBuffer(bodyFlip, 'pw').ok);

    const tagFlip = Buffer.from(sealed);
    tagFlip[tagFlip.length - 1] ^= 0x01;
    ok('a flipped tag byte is caught', !V.openBuffer(tagFlip, 'pw').ok);

    const ivFlip = Buffer.from(sealed);
    ivFlip[30] ^= 0x01;
    ok('a flipped IV byte is caught', !V.openBuffer(ivFlip, 'pw').ok);

    const saltFlip = Buffer.from(sealed);
    saltFlip[14] ^= 0x01;
    ok('a flipped salt byte is caught', !V.openBuffer(saltFlip, 'pw').ok);

    ok('a truncated package is reported as truncated, not as a bad password',
        V.openBuffer(sealed.subarray(0, V.HEADER_LEN + 4), 'pw').reason === V.ERR_TRUNCATED);
}

/* A package from a NEWER VIPER has to say so. Failing on the tag at the far
 * end of a multi-gigabyte decrypt and calling it a bad password would send
 * the officer chasing the wrong problem. */
{
    const sealed = V.sealBuffer(Buffer.from('x'), 'pw');
    const future = Buffer.from(sealed);
    future.writeUInt8(99, 8);
    const r = V.openBuffer(future, 'pw');
    ok('an unknown format version is refused', !r.ok);
    ok('  — and named as a version problem', r.reason === V.ERR_UNSUPPORTED);
    ok('  — and reports which version it saw', r.version === 99);

    const badKdf = Buffer.from(sealed);
    badKdf.writeUInt8(7, 9);
    ok('an unknown KDF is refused as a version problem too',
        V.openBuffer(badKdf, 'pw').reason === V.ERR_UNSUPPORTED);
}

ok('opening something that is not sealed says so rather than failing on crypto',
    V.openBuffer(Buffer.from('PK\u0003\u0004 not sealed'), 'pw').reason === V.ERR_NOT_SEALED);

/* ════════════════════════════════════════════════════════════════════
   streaming seal — this is the path the real export uses
   ════════════════════════════════════════════════════════════════════ */
section('streaming seal');

/* A case with a phone extraction in it is gigabytes. The export streams the
 * archive through the cipher rather than buffering it, which is why the tag
 * is appended to the END of the file: it does not exist until the cipher has
 * finished. Pin that the streamed layout is identical to the buffered one. */
{
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const payload = crypto.randomBytes(9999);

    const s = V.createSeal('pw', { salt, iv });
    const chunks = [];
    for (let off = 0; off < payload.length; off += 777) {
        chunks.push(s.cipher.update(payload.subarray(off, Math.min(off + 777, payload.length))));
    }
    chunks.push(s.cipher.final());
    const streamed = Buffer.concat([s.header, Buffer.concat(chunks), s.tag()]);

    const buffered = V.sealBuffer(payload, 'pw', { salt, iv });
    ok('a chunk-at-a-time seal is byte-identical to a one-shot seal',
        streamed.equals(buffered));
    ok('  — and the streamed one opens', V.openBuffer(streamed, 'pw').ok);
    ok('the tag is the LAST 16 bytes, which is why it can be appended after the stream closes',
        streamed.subarray(streamed.length - 16).equals(s.tag()));
}

/* ════════════════════════════════════════════════════════════════════
   end to end through a real ZIP
   ════════════════════════════════════════════════════════════════════ */
section('end to end with a real archive');

{
    const AdmZip = require(path.join(REPO, 'node_modules', 'adm-zip'));
    const zip = new AdmZip();
    const supplement = JSON.stringify({ _viperExport: true, _version: '2.0', caseMetadata: { caseNumber: '26-0905538' } });
    zip.addFile(V.DATA_ENTRY, Buffer.from(supplement, 'utf-8'));
    zip.addFile('cases/26-0905538/Evidence/E-001/photo.jpg', Buffer.from('JPEGBYTES'));
    zip.addFile(V.MANIFEST_ENTRY, Buffer.from(V.manifestCsv([], {}, '26-0905538')));
    const zipBuf = zip.toBuffer();

    ok('an unsealed package is a plain ZIP', V.looksLikeZip(zipBuf));

    const sealed = V.sealBuffer(zipBuf, 'thepassword');
    const opened = V.openBuffer(sealed, 'thepassword');
    ok('a sealed package unwraps back to the ZIP', opened.ok && V.looksLikeZip(opened.data));

    const back = new AdmZip(opened.data);
    const data = back.getEntries().find(e => e.entryName === V.DATA_ENTRY);
    ok('supplement.json is in there under its fixed name', !!data);
    ok('  — and parses back to the case it went in as',
        JSON.parse(data.getData().toString('utf-8')).caseMetadata.caseNumber === '26-0905538');
    const photo = back.getEntries().find(e => e.entryName.indexOf('photo.jpg') >= 0);
    ok('the case file came through', !!photo && photo.getData().toString() === 'JPEGBYTES');
}

/* ════════════════════════════════════════════════════════════════════
   archive paths — a package from another agency is a file we did not write
   ════════════════════════════════════════════════════════════════════ */
section('archive paths');

ok('a normal path passes through',
    V.safeRelPath('cases/26-1/Evidence/a.jpg') === 'cases/26-1/Evidence/a.jpg');
ok('backslashes are normalised',
    V.safeRelPath('cases\\26-1\\Evidence\\a.jpg') === 'cases/26-1/Evidence/a.jpg');
ok('redundant segments are dropped',
    V.safeRelPath('cases/./26-1//Evidence/a.jpg') === 'cases/26-1/Evidence/a.jpg');

ok('a path that climbs out is refused', V.safeRelPath('cases/26-1/../../../windows/x.dll') === null);
ok('a bare .. is refused', V.safeRelPath('../x') === null);
ok('a .. anywhere in the path is refused, not just at the front',
    V.safeRelPath('cases/26-1/Evidence/../../../../x') === null);
ok('an absolute path is refused', V.safeRelPath('/etc/passwd') === null);
ok('a drive letter is refused', V.safeRelPath('C:/Windows/System32/x.dll') === null);
ok('a lowercase drive letter is refused too', V.safeRelPath('c:/x') === null);
ok('an empty name is refused', V.safeRelPath('') === null);
ok('a path of nothing but separators is refused', V.safeRelPath('///') === null);

ok('a case file is stripped to its path inside the case folder',
    V.caseFileRelPath('cases/26-0905538/Evidence/E-001/photo.jpg') === 'Evidence/E-001/photo.jpg');
ok('supplement.json is not a case file', V.caseFileRelPath('supplement.json') === null);
ok('MANIFEST.csv is not a case file', V.caseFileRelPath('MANIFEST.csv') === null);
ok('the case folder itself with nothing in it is not a case file',
    V.caseFileRelPath('cases/26-1/') === null);
ok('a traversal dressed up as a case file is refused',
    V.caseFileRelPath('cases/26-1/../../evil.exe') === null);

/* The case-number segment in the ZIP is the SENDER's case number. The
 * importer writes into the RECEIVER's folder, so that segment is discarded
 * rather than trusted — two officers can have the same case under different
 * numbers, and an imported file must never land outside the case it was
 * imported into. */
ok('the sender\'s case number is discarded, not used as the destination',
    V.caseFileRelPath('cases/THEIR-NUMBER/Notes/x.png') === 'Notes/x.png');

/* ════════════════════════════════════════════════════════════════════
   MANIFEST.csv
   ════════════════════════════════════════════════════════════════════ */
section('manifest');

ok('11 columns, same as the Assist Package manifest', V.MANIFEST_COLUMNS.length === 11);
{
    const csv = V.manifestCsv(
        [{ archived: 'cases/26-1/Evidence/a.jpg', original: 'Evidence/a.jpg', module: 'Evidence',
           bytes: 1234, sha256: 'deadbeef', note: '' }],
        { officerName: 'Ramirez, A.', officerRank: 'Detective', officerBadge: '2210', agencyName: 'Fort Worth PD' },
        '26-0905538'
    );
    ok('rows are CRLF terminated', csv.indexOf('\r\n') > 0);
    ok('  — and there are no bare LFs', csv.split('\n').every(l => l === '' || l.endsWith('\r')));
    ok('the file ends with a newline', /\r\n$/.test(csv));
    const lines = csv.trim().split('\r\n');
    ok('header plus one row', lines.length === 2, lines.length);
    ok('every header cell is quoted', lines[0].split('","').length === 11);
    ok('the hash is in the row', lines[1].indexOf('"deadbeef"') >= 0);
    ok('the contributing officer is in the row', lines[1].indexOf('"Ramirez, A."') >= 0);
    ok('the badge is in the row', lines[1].indexOf('"2210"') >= 0);
    ok('the parent case number is in the row', lines[1].indexOf('"26-0905538"') >= 0);
}
{
    /* A name with a quote in it must not break the CSV open. Excel is what
     * actually reads this file. */
    const csv = V.manifestCsv(
        [{ archived: 'a', original: 'b', module: 'c', bytes: 1, sha256: 'd', note: 'said "ok"' }],
        { officerName: 'O\'Brien, "Mac"' }, '26-1');
    ok('a double quote in a value is doubled, not dropped',
        csv.indexOf('"O\'Brien, ""Mac"""') >= 0, csv);
    ok('a double quote in a note is doubled too', csv.indexOf('"said ""ok"""') >= 0);
}
ok('an empty manifest is still a valid CSV with its header',
    V.manifestCsv([], {}, '26-1').trim().split('\r\n').length === 1);

/* ════════════════════════════════════════════════════════════════════
   THE BUG v2 EXISTS TO FIX
   ════════════════════════════════════════════════════════════════════ */
section('the vault-key handoff bug');

/* A .vcase used to be written through security.encryptBuffer(), which seals
 * with a key derived from THIS officer's vault password and THIS machine's
 * salt. Neither travels. So an export made on a vault-enabled machine could
 * not be opened by the detective it was sent to — which is the entire point
 * of an export. These assertions read the shipping file. */
{
    const main = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf-8').replace(/\r\n/g, '\n');
    const start = main.indexOf("ipcMain.handle('save-case-export'");
    ok('save-case-export is still there', start > 0);
    const end = main.indexOf("ipcMain.handle('vcase-read'", start);
    ok('vcase-read is registered after it', end > start);
    const handler = main.slice(start, end);

    ok('the export no longer seals with the local Field Security key',
        handler.indexOf('security.encryptBuffer') < 0);
    ok('it seals with the export password instead',
        handler.indexOf('VcasePackage.createSeal') > 0);
    ok('an export that includes files refuses while the vault is locked',
        /isEnabled\(\)\s*&&\s*!security\.isUnlocked\(\)/.test(handler));
    ok('  — and says why, in terms of the person receiving it',
        /cannot be read by whoever you send them to/.test(handler));

    ok('the importer sniffs for a sealed package', main.indexOf('VcasePackage.isSealed(raw)') > 0);
    ok('the importer still opens the old vault-sealed files it already made',
        main.indexOf('security.isEncryptedBuffer(raw)') > 0);

    ok('the data half has a fixed entry name both sides agree on',
        main.indexOf('VcasePackage.DATA_ENTRY') > 0);
    ok('imported files are re-encrypted under the RECEIVER\'s policy',
        /reEncrypt\s*\?\s*security\.encryptBuffer\(data\)\s*:\s*data/.test(main));
    ok('imported files never overwrite one the host detective already has',
        main.indexOf('renamed.push(') > 0 && /if\s*\(fs\.existsSync\(dest\)\)/.test(main));
}

/* The renderer has to stop treating the result as a bare path string, and
 * has to offer the two new choices. */
{
    const page = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf-8')
        .replace(/\r\n/g, '\n');
    ok('the export dialog exists', page.indexOf('_promptCaseExportOptions') > 0);
    ok('it offers to include the case files', page.indexOf('Include case files') > 0);
    ok('it offers a password', page.indexOf('Password protect this package') > 0);
    ok('it says plainly that an unprotected package is not encrypted',
        page.indexOf('this file is not encrypted') > 0);
    ok('it warns that a lost export password cannot be recovered',
        page.indexOf('no way to recover this password') > 0);
    ok('the password is confirmed rather than typed once',
        page.indexOf('vcxPw2') > 0 && page.indexOf('do not match') > 0);
    ok('every person gets a durable id before the case leaves the machine',
        page.indexOf('_mintAllPersonNoteUids') > 0);
    ok('  — and it is actually called from the export, not just defined',
        /try\s*\{\s*_mintAllPersonNoteUids\(\);/.test(page));
    ok('the officer identity is resolved once and shared with the assist package',
        page.indexOf('function _officerIdentity(') > 0
        && /_assistPackageInfo[\s\S]{0,900}?_officerIdentity\(\)/.test(page));

    const idx = fs.readFileSync(path.join(REPO, 'index.html'), 'utf-8').replace(/\r\n/g, '\n');
    ok('the importer handles the v2 sentinel', idx.indexOf('pkg._vcase2') > 0);
    ok('it prompts for the password', idx.indexOf('promptVcasePassword') > 0);
    ok('a wrong password is named as such rather than a generic failure',
        idx.indexOf('That password did not open the package') > 0);
    ok('  — and allows for the file simply being damaged',
        idx.indexOf('may have been damaged in transit') > 0);
    ok('a package from a newer VIPER says so', idx.indexOf('made by a newer version of VIPER') > 0);
    ok('files that failed to restore are reported as a failure, not folded into the success',
        /not restored[\s\S]{0,80}'error'/.test(idx));
}

/* preload has to expose the two new calls or the renderer silently has no
 * way to read a v2 package at all. */
{
    const pre = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf-8');
    ok('preload exposes vcaseRead', /vcaseRead:\s*\(data\)\s*=>\s*ipcRenderer\.invoke\('vcase-read'/.test(pre));
    ok('preload exposes vcaseExtractFiles', /vcaseExtractFiles:\s*\(data\)\s*=>\s*ipcRenderer\.invoke\('vcase-extract-files'/.test(pre));
    ok('preload exposes caseFilesSummary', /caseFilesSummary:\s*\(caseNumber\)\s*=>\s*ipcRenderer\.invoke\('case-files-summary'/.test(pre));
}

/* ════════════════════════════════════════════════════════════════════
   a real file on disk, start to finish
   ════════════════════════════════════════════════════════════════════ */
section('a real file on disk');

{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcase-test-'));
    const file = path.join(tmp, 'x.vcase');
    try {
        const AdmZip = require(path.join(REPO, 'node_modules', 'adm-zip'));
        const zip = new AdmZip();
        zip.addFile(V.DATA_ENTRY, Buffer.from('{"_viperExport":true}'));
        const zipBuf = zip.toBuffer();

        /* Written the way the handler writes it: header first, ciphertext
         * streamed, tag appended once the stream has closed. */
        const s = V.createSeal('pw');
        fs.writeFileSync(file, s.header);
        fs.appendFileSync(file, s.cipher.update(zipBuf));
        fs.appendFileSync(file, s.cipher.final());
        fs.appendFileSync(file, s.tag());

        const head = Buffer.alloc(8);
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, head, 0, 8, 0);
        fs.closeSync(fd);
        ok('the file is identifiable from an 8-byte read', V.isSealed(head));

        const whole = fs.readFileSync(file);
        const opened = V.openBuffer(whole, 'pw');
        ok('the file written in pieces opens', opened.ok);
        ok('  — back to the exact ZIP', opened.ok && opened.data.equals(zipBuf));
        ok('  — and the wrong password still fails on it',
            V.openBuffer(whole, 'nope').reason === V.ERR_PASSWORD);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
