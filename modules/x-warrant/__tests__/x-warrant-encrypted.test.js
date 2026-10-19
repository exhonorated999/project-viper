/**
 * X / Twitter Warrant — password-protected, nested and Evidence-linked
 * productions (submission #21).
 *
 *   node modules/x-warrant/__tests__/x-warrant-encrypted.test.js
 *
 * Fixtures are synthetic and built here by a ZIP writer whose ZipCrypto and
 * WinZip-AES encryption is written independently of modules/_shared/zip-crypto.js
 * (AES keystream via per-block aes-ctr, CRC via zlib.crc32 when present).
 * adm-zip (ZipCrypto) and 7-Zip (AES-256 + ZipCrypto, if installed) are used
 * as outside oracles.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const XWarrantParser = require(path.join(ROOT, 'modules', 'x-warrant', 'x-warrant-parser.js'));
const { openZip } = require(path.join(ROOT, 'modules', '_shared', 'zip-reader.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }
async function rejects(p, code, m) {
    try { await p; ok(false, m + ' (did not throw)'); return null; }
    catch (e) { ok(e && e.code === code, m + ' (got ' + (e && e.code) + ': ' + (e && e.message) + ')'); return e; }
}

// ─── Independent ZIP writer ───────────────────────────────────────────
const T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crcByte = (c, b) => (T[(c ^ b) & 255] ^ (c >>> 8)) >>> 0;
const crc32 = (buf) => {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = 0xFFFFFFFF; for (const b of buf) c = crcByte(c, b); return (c ^ 0xFFFFFFFF) >>> 0;
};
function zcKeys(pwBytes) {
    const k = { a: 0x12345678, b: 0x23456789, c: 0x34567890 };
    k.upd = (x) => { k.a = crcByte(k.a, x); k.b = (k.b + (k.a & 255)) >>> 0; k.b = (Math.imul(k.b, 134775813) + 1) >>> 0; k.c = crcByte(k.c, k.b >>> 24); };
    k.ks = () => { const t = (k.c | 2) & 0xFFFF; return ((t * (t ^ 1)) >>> 8) & 255; };
    for (const x of pwBytes) k.upd(x);
    return k;
}
function zcEncrypt(plain, pwBytes, check) {
    const k = zcKeys(pwBytes);
    const hdr = crypto.randomBytes(12); hdr[11] = check;
    const src = Buffer.concat([hdr, plain]); const out = Buffer.alloc(src.length);
    for (let i = 0; i < src.length; i++) { out[i] = src[i] ^ k.ks(); k.upd(src[i]); }
    return out;
}
function zcDecrypt(enc, pwBytes) {
    const k = zcKeys(pwBytes); const out = Buffer.alloc(enc.length);
    for (let i = 0; i < enc.length; i++) { out[i] = enc[i] ^ k.ks(); k.upd(out[i]); }
    return out;
}
function aesEncrypt(plain, pwBytes, strength) {
    const kl = { 1: 16, 2: 24, 3: 32 }[strength];
    const salt = crypto.randomBytes(kl / 2);
    const dk = crypto.pbkdf2Sync(pwBytes, salt, 1000, 2 * kl + 2, 'sha1');
    const out = Buffer.alloc(plain.length);
    for (let i = 0, ctr = 1; i < plain.length; i += 16, ctr++) {
        const iv = Buffer.alloc(16); iv.writeUInt32LE(ctr >>> 0, 0); iv.writeUInt32LE(Math.floor(ctr / 0x100000000), 4);
        const ks = crypto.createCipheriv('aes-' + (kl * 8) + '-ctr', dk.subarray(0, kl), iv).update(Buffer.alloc(16));
        for (let j = 0; j < 16 && i + j < plain.length; j++) out[i + j] = plain[i + j] ^ ks[j];
    }
    const mac = crypto.createHmac('sha1', dk.subarray(kl, 2 * kl)).update(out).digest().subarray(0, 10);
    return Buffer.concat([salt, dk.subarray(2 * kl), out, mac]);
}
const TIME = 0x7A3C, DATE = 0x5B53;
/** entries: { name, data, method=8, enc: null|'zc'|'zc8'|'aes', pw, pwBytes, strength=3, ae=2 } */
function buildZip(entries) {
    const parts = [], cds = [], dataAt = {}; let off = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8'); const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
        const method = e.method == null ? 8 : e.method; const crc = crc32(raw);
        let comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
        let flags = 0, outMethod = method, extra = Buffer.alloc(0), storedCrc = crc, ver = 20;
        const pwb = e.pwBytes || (e.pw != null ? Buffer.from(e.pw, 'utf8') : null);
        if (e.enc === 'zc' || e.enc === 'zc8') {
            flags |= 1; if (e.enc === 'zc8') flags |= 8;
            comp = zcEncrypt(comp, pwb, e.enc === 'zc8' ? (TIME >>> 8) & 255 : (crc >>> 24) & 255);
        } else if (e.enc === 'aes') {
            flags |= 1; outMethod = 99; ver = 51; const st = e.strength || 3; const ae = e.ae || 2;
            extra = Buffer.alloc(11); extra.writeUInt16LE(0x9901, 0); extra.writeUInt16LE(7, 2); extra.writeUInt16LE(ae, 4);
            extra.write('AE', 6, 'latin1'); extra[8] = st; extra.writeUInt16LE(method, 9);
            comp = aesEncrypt(comp, pwb, st); if (ae === 2) storedCrc = 0;
        }
        const bit3 = !!(flags & 8);
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(ver, 4); lh.writeUInt16LE(flags, 6);
        lh.writeUInt16LE(outMethod, 8); lh.writeUInt16LE(TIME, 10); lh.writeUInt16LE(DATE, 12);
        lh.writeUInt32LE(bit3 ? 0 : storedCrc, 14); lh.writeUInt32LE(bit3 ? 0 : comp.length, 18); lh.writeUInt32LE(bit3 ? 0 : raw.length, 22);
        lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28);
        parts.push(lh, name, extra, comp);
        dataAt[e.name] = off + 30 + name.length + extra.length;
        let ddLen = 0;
        if (bit3) { const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(storedCrc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(raw.length, 12); parts.push(dd); ddLen = 16; }
        const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(ver, 4); cd.writeUInt16LE(ver, 6); cd.writeUInt16LE(flags, 8);
        cd.writeUInt16LE(outMethod, 10); cd.writeUInt16LE(TIME, 12); cd.writeUInt16LE(DATE, 14); cd.writeUInt32LE(storedCrc, 16);
        cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30);
        cd.writeUInt32LE(off, 42);
        cds.push(cd, name, extra);
        off += 30 + name.length + extra.length + comp.length + ddLen;
    }
    const cdBuf = Buffer.concat(cds); const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...parts, cdBuf, eocd]); buf.dataAt = dataAt; return buf;
}

// ─── Synthetic X production ───────────────────────────────────────────
const ACC = '1965190314169372672';
const PW = 'Hunter2!pw-21';
const pgp = (body) => `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${body}\n-----BEGIN PGP SIGNATURE-----\nAAAA\n-----END PGP SIGNATURE-----\n`;
const MEDIA = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(5000)]);
const BIG_MEDIA = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(1200 * 1024)]); // > 1 MiB keystream pass
const PROD = [
    ['README.txt', 'CONTENTS\n/' + ACC + '-account.txt: Account\n/' + ACC + '-direct-messages.txt: DMs\n'],
    [ACC + '-account.txt', pgp('[{"account":{"accountId":"' + ACC + '","username":"synthuser","email":"s@example.com"}}]')],
    [ACC + '-direct-messages.txt', pgp('window.YTD.direct_messages.part0 = [{"dmConversation":{"conversationId":"1-2","messages":[{"messageCreate":{"id":"55","senderId":"1","recipientId":"2","text":"hi","createdAt":"2026-01-01T00:00:00.000Z","mediaUrls":[]}}]}}]')],
    [ACC + '-tweets.txt', pgp('[]')],
    [ACC + '_direct_messages_media/55-abc.jpg', MEDIA],
    ['file_1.asc', '-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n'],
];
const prodEntries = (enc, extra = {}) => PROD.map(([name, data]) => Object.assign({ name, data, enc, pw: PW }, extra));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-enc-'));
const W = (rel, buf) => { const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const noPwInMsg = (e, m) => ok(!e || !String(e.message).includes(PW), m + ': password never echoed in error');

function checkParsed(r, m, extractDir) {
    ok(r && r.accountUsername === 'synthuser', m + ': username');
    ok(r && r.stats && r.stats.threadCount === 1 && r.stats.messageCount === 1, m + ': 1 thread / 1 message');
    ok(r && r.stats && r.stats.mediaCount >= 1, m + ': media listed');
    if (extractDir) {
        const p = path.join(extractDir, '55-abc.jpg');
        ok(fs.existsSync(p) && fs.readFileSync(p).equals(MEDIA), m + ': media bytes identical after decrypt');
    }
}

(async () => {
    const parser = new XWarrantParser();

    // 1. Plain baseline + reader unchanged when a password is supplied.
    const plainP = W('plain.zip', buildZip(prodEntries(null)));
    checkParsed(await parser.parseZip(plainP, {}), 'plain');
    {
        const a = await openZip(plainP), b = await openZip(plainP, { password: 'whatever' });
        const ea = a.getEntries(), eb = b.getEntries();
        ok(ea.length === eb.length && ea.every((e, i) => e.entryName === eb[i].entryName && !e.encrypted && a.readAsText(e) === b.readAsText(eb[i])), 'plain zip reads identically with/without password');
        ok(!a.hasEncryptedEntries(), 'plain zip: hasEncryptedEntries false');
        a.close(); b.close();
        const i = await XWarrantParser.inspectZip(plainP);
        ok(i.isX && !i.encrypted && !i.nested, 'inspect plain: isX, not encrypted');
    }

    // 2. Encrypted variants.
    const variants = [
        ['ZipCrypto deflate', prodEntries('zc')],
        ['ZipCrypto + data descriptor (bit 3)', prodEntries('zc8')],
        ['ZipCrypto stored', prodEntries('zc', { method: 0 })],
        ['AES-256 AE-2', prodEntries('aes', { strength: 3, ae: 2 }).concat([{ name: ACC + '_direct_messages_media/56-big.jpg', data: BIG_MEDIA, enc: 'aes', pw: PW, strength: 3, ae: 2 }])],
        ['AES-128 AE-1', prodEntries('aes', { strength: 1, ae: 1 })],
        ['AES-192 AE-2 stored', prodEntries('aes', { strength: 2, ae: 2, method: 0 })],
    ];
    let vi = 0;
    for (const [label, entries] of variants) {
        const zp = W('enc' + (vi++) + '.zip', buildZip(entries));
        const ins = await XWarrantParser.inspectZip(zp);
        ok(ins.isX && ins.encrypted && !ins.nested, label + ': inspect → isX + encrypted');
        ok(await XWarrantParser.isXWarrantZipAsync(zp), label + ': isXWarrantZipAsync');
        noPwInMsg(await rejects(parser.parseZip(zp, {}), 'ZIP_PASSWORD_REQUIRED', label + ': no password → REQUIRED'), label);
        noPwInMsg(await rejects(parser.parseZip(zp, { password: 'not-it' }), 'ZIP_PASSWORD_WRONG', label + ': wrong → WRONG'), label);
        const xd = path.join(TMP, 'out' + vi);
        const r = await parser.parseZip(zp, { password: PW, extractDir: xd });
        checkParsed(r, label, xd);
        if (/big/.test(JSON.stringify(entries.map(e => e.name)))) {
            const bp = path.join(xd, '56-big.jpg');
            ok(fs.existsSync(bp) && fs.readFileSync(bp).equals(BIG_MEDIA), label + ': 1.2 MB media crosses keystream pass boundary intact');
        }
        if (label === 'ZipCrypto deflate') {
            // adm-zip as an outside oracle for our ZipCrypto fixture.
            try {
                const AdmZip = require('adm-zip');
                const az = new AdmZip(zp);
                const got = az.readFile(ACC + '-account.txt', PW);
                ok(got && got.toString('utf8') === PROD[1][1], 'adm-zip decrypts our ZipCrypto fixture (writer sanity)');
            } catch (e) { ok(false, 'adm-zip oracle threw: ' + e.message); }
        }
    }

    // 3. Non-ASCII password: ZipCrypto tools hash latin1 bytes, AES tools UTF-8.
    {
        const PWU = 'pässwörd';
        const zcL = W('latin1.zip', buildZip(PROD.map(([name, data]) => ({ name, data, enc: 'zc', pwBytes: Buffer.from(PWU, 'latin1') }))));
        checkParsed(await parser.parseZip(zcL, { password: PWU }), 'ZipCrypto latin1 password');
        const aesU = W('utf8aes.zip', buildZip(PROD.map(([name, data]) => ({ name, data, enc: 'aes', pwBytes: Buffer.from(PWU, 'utf8') }))));
        checkParsed(await parser.parseZip(aesU, { password: PWU }), 'AES utf-8 password');
    }

    // 4. Wrong password that passes the ZipCrypto check byte (1 in 256) on a
    //    deflated entry: must report WRONG, not a raw zlib error.
    {
        const entries = PROD.map(([name, data]) => ({ name, data, enc: name.endsWith('-account.txt') ? 'zc' : null, pw: PW }));
        const buf = buildZip(entries);
        const at = buf.dataAt[ACC + '-account.txt'];
        const crc = crc32(Buffer.from(PROD[1][1], 'utf8'));
        const enc = buf.subarray(at, at + zlib.deflateRawSync(Buffer.from(PROD[1][1], 'utf8')).length + 12);
        let slip = null;
        for (let i = 0; i < 200000 && !slip; i++) {
            const cand = 'wrong' + i; const d = zcDecrypt(enc, Buffer.from(cand, 'utf8'));
            if (d[11] !== ((crc >>> 24) & 255)) continue;
            try { zlib.inflateRawSync(d.subarray(12)); } catch (_) { slip = cand; }
        }
        ok(!!slip, 'found a wrong password that passes the check byte');
        const zp = W('slip.zip', buf);
        await rejects(parser.parseZip(zp, { password: slip }), 'ZIP_PASSWORD_WRONG', 'check-byte collision → WRONG (not zlib error)');
        checkParsed(await parser.parseZip(zp, { password: PW }), 'mixed plain/encrypted entries');
    }

    // 5. AES damage: verifier OK but HMAC fails → CORRUPT, not "wrong password".
    {
        const buf = buildZip(prodEntries('aes'));
        const at = buf.dataAt[ACC + '-account.txt'];
        buf[at + 16 + 2 + 3] ^= 0x55; // inside the ciphertext (salt 16 + verifier 2)
        const zp = W('damaged.zip', buf);
        await rejects(parser.parseZip(zp, { password: PW }), 'ZIP_ENTRY_CORRUPT', 'AES tampered entry → CORRUPT');
    }

    // 6. Nested delivery ZIPs.
    {
        const innerPlain = buildZip(prodEntries(null));
        const innerLocked = buildZip(prodEntries('aes'));
        const cover = { name: 'X-Production-12345/LE-cover-letter.pdf', data: Buffer.from('%PDF-1.4 cover') };
        const n1 = W('nested-plain.zip', buildZip([cover, { name: 'X-Production-12345/' + ACC + '.zip', data: innerPlain, method: 0 }]));
        let ins = await XWarrantParser.inspectZip(n1);
        ok(ins.isX && ins.nested && !ins.encrypted && /\.zip$/.test(ins.innerName || ''), 'nested plain: inspect isX + nested');
        let r = await parser.parseZip(n1, {});
        checkParsed(r, 'nested plain');
        ok(r.nestedIn === 'X-Production-12345/' + ACC + '.zip', 'nested plain: nestedIn recorded');

        const n2 = W('nested-inner-locked.zip', buildZip([cover, { name: 'X-Production-12345/' + ACC + '.zip', data: innerLocked, method: 0 }]));
        ins = await XWarrantParser.inspectZip(n2);
        ok(ins.isX && ins.nested && ins.encrypted, 'nested, inner production locked: inspect isX + nested + encrypted');
        await rejects(parser.parseZip(n2, {}), 'ZIP_PASSWORD_REQUIRED', 'nested inner locked: no password → REQUIRED');
        await rejects(parser.parseZip(n2, { password: 'nope' }), 'ZIP_PASSWORD_WRONG', 'nested inner locked: wrong → WRONG');
        const xd = path.join(TMP, 'out-n2');
        checkParsed(await parser.parseZip(n2, { password: PW, extractDir: xd }), 'nested inner locked', xd);

        const n3 = W('nested-outer-locked.zip', buildZip([Object.assign({}, cover, { enc: 'zc', pw: PW }), { name: 'X-Production-12345/' + ACC + '.zip', data: innerPlain, method: 0, enc: 'zc', pw: PW }]));
        await rejects(parser.parseZip(n3, {}), 'ZIP_PASSWORD_REQUIRED', 'outer locked: no password → REQUIRED');
        checkParsed(await parser.parseZip(n3, { password: PW }), 'outer locked, inner plain');

        // Not an X production at all → clear error instead of an empty import.
        const other = W('other.zip', buildZip([{ name: 'photos/IMG_0001.jpg', data: MEDIA }, { name: 'notes.txt', data: 'hello' }]));
        ok(!(await XWarrantParser.inspectZip(other)).isX, 'unrelated zip: inspect isX false');
        await rejects(parser.parseZip(other, {}), 'NOT_X_PRODUCTION', 'unrelated zip → NOT_X_PRODUCTION');
        await rejects(parser.parseFolder(path.join(TMP, 'out1'), {}), 'NOT_X_PRODUCTION', 'folder of media only → NOT_X_PRODUCTION');
    }

    // 7. 7-Zip as an outside oracle (skipped when not installed).
    const SEVEN = 'C:\\Program Files\\7-Zip\\7z.exe';
    if (fs.existsSync(SEVEN)) {
        const src = path.join(TMP, 'src7');
        for (const [name, data] of PROD) W(path.join('src7', name), data);
        for (const mem of ['AES256', 'ZipCrypto']) {
            const out = path.join(TMP, 'seven-' + mem + '.zip');
            cp.execFileSync(SEVEN, ['a', '-tzip', '-p' + PW, '-mem=' + mem, out, '*'], { cwd: src, stdio: 'ignore' });
            const ins = await XWarrantParser.inspectZip(out);
            ok(ins.isX && ins.encrypted, '7-Zip ' + mem + ': inspect isX + encrypted');
            await rejects(parser.parseZip(out, {}), 'ZIP_PASSWORD_REQUIRED', '7-Zip ' + mem + ': REQUIRED');
            await rejects(parser.parseZip(out, { password: 'nope' }), 'ZIP_PASSWORD_WRONG', '7-Zip ' + mem + ': WRONG');
            const xd = path.join(TMP, 'out7-' + mem);
            checkParsed(await parser.parseZip(out, { password: PW, extractDir: xd }), '7-Zip ' + mem, xd);
        }
    } else console.log('note: 7-Zip not installed — oracle block skipped');

    // 8. Lifted electron-main scan/import handlers.
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = mainSrc.indexOf('const _xwInspectCache');
    const b = mainSrc.indexOf("ipcMain.handle('x-warrant-pick-file'");
    ok(a > 0 && b > a, 'electron-main: X scan/import handlers found');
    const handlers = {};
    const logs = [];
    const fakeConsole = { log() {}, warn() {}, error: (...x) => logs.push(x.map(String).join(' ')) };
    const casesDir = path.join(TMP, 'cases');
    new Function('ipcMain', 'fs', 'path', 'casesDir', 'security', 'XWarrantParser', 'xwParser', '_sourceFingerprint', 'console', mainSrc.slice(a, b))(
        { handle: (ch, fn) => { handlers[ch] = fn; } }, fs, path, casesDir, null, XWarrantParser, parser, async () => ({ sha256: 'x' }), fakeConsole);
    ok(typeof handlers['x-warrant-scan'] === 'function' && typeof handlers['x-warrant-import'] === 'function', 'handlers registered');

    W(path.join('cases', 'C1', 'Evidence', 'copied', 'copied-x.zip'), fs.readFileSync(plainP));
    const linkedZip = W(path.join('USBDRIVE', 'Returns', 'X-21-locked.zip'), buildZip(prodEntries('zc')));
    const linkedDir = path.join(TMP, 'USBDRIVE', 'Unzipped', ACC);
    for (const [name, data] of PROD) W(path.join('USBDRIVE', 'Unzipped', ACC, name), data);
    const linkedParent = path.join(TMP, 'USBDRIVE', 'Returns');

    let s = await handlers['x-warrant-scan'](null, { caseNumber: 'C1' });
    ok(s.success && s.files.length === 1 && s.files[0].source === 'case' && s.files[0].name === 'copied-x.zip', 'scan without links: only the copied case zip');
    s = await handlers['x-warrant-scan'](null, { caseNumber: 'C1', extraPaths: [linkedZip, linkedDir, path.join(TMP, 'GONE', 'x.zip'), 42, linkedZip.toUpperCase()] });
    const byName = Object.fromEntries((s.files || []).map(f => [f.name, f]));
    ok(s.success && s.files.length === 3, 'scan with links: 3 productions (dupes/missing/non-string ignored) — got ' + (s.files || []).length);
    ok(byName['X-21-locked.zip'] && byName['X-21-locked.zip'].source === 'evidence-link' && byName['X-21-locked.zip'].encrypted === true, 'linked locked zip listed, encrypted, source evidence-link');
    ok(byName[ACC] && byName[ACC].isFolder && byName[ACC].source === 'evidence-link', 'linked unzipped folder listed');
    s = await handlers['x-warrant-scan'](null, { caseNumber: 'C1', extraPaths: [linkedParent] });
    ok(s.files.some(f => f.name === 'X-21-locked.zip' && f.source === 'evidence-link'), 'linked parent folder is searched');

    let im = await handlers['x-warrant-import'](null, { filePath: linkedZip, caseNumber: 'C1', isFolder: false });
    ok(!im.success && im.code === 'ZIP_PASSWORD_REQUIRED', 'import IPC: REQUIRED code returned');
    im = await handlers['x-warrant-import'](null, { filePath: linkedZip, caseNumber: 'C1', isFolder: false, password: 'nope-' + PW.slice(0, 3) });
    ok(!im.success && im.code === 'ZIP_PASSWORD_WRONG', 'import IPC: WRONG code returned');
    im = await handlers['x-warrant-import'](null, { filePath: linkedZip, caseNumber: 'C1', isFolder: false, password: PW });
    ok(im.success && im.data.stats.messageCount === 1 && im.data.sourceIntegrity, 'import IPC: success with password');
    ok(fs.existsSync(path.join(casesDir, 'C1', 'Evidence', 'XWarrant', '55-abc.jpg')), 'import IPC: media extracted into the case');
    ok(!logs.join('\n').includes(PW), 'main log never contains the password');

    // 9. Renderer: module + UI against the lifted handlers.
    const store = {};
    const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    store.viperCaseEvidence = JSON.stringify({
        C1: [
            { id: 'e1', referenceOnly: true, storageMode: 'reference', sourcePath: linkedParent, files: [{ name: 'X-21-locked.zip', path: linkedZip }, { name: 'note.pdf', path: path.join(linkedParent, 'note.pdf') }] },
            { id: 'e2', storageMode: 'copy', sourcePath: 'Z:\\should-not-be-sent', files: [{ path: 'Z:\\copied.zip' }] },
            null,
        ],
        OTHER: [{ referenceOnly: true, sourcePath: 'Q:\\other-case' }],
    });
    const bar = { innerHTML: '' };
    const document = { getElementById: id => (id === 'xwp-evidence-bar' ? bar : null), querySelectorAll: () => [] };
    const scanCalls = [];
    const sb = { console, localStorage, document, setTimeout, JSON, Promise, Array, Set, Object, Error, Date, Math, String };
    sb.window = sb;
    sb.electronAPI = {
        xWarrantScan: (args) => { scanCalls.push(args); return handlers['x-warrant-scan'](null, args); },
        xWarrantImport: (args) => handlers['x-warrant-import'](null, args),
    };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'x-warrant', 'x-warrant-module.js'), 'utf8'), sb, { filename: 'x-warrant-module.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'x-warrant', 'x-warrant-ui.js'), 'utf8'), sb, { filename: 'x-warrant-ui.js' });
    const mod = new sb.XWarrantModule('id1', 'C1', 'Case 1');
    const refs = mod._evidenceReferencePaths();
    ok(refs.length === 2 && refs.includes(linkedParent) && refs.includes(linkedZip), 'reference paths: sourcePath + linked .zip only (copy-mode, other cases, non-zip skipped)');
    const ui = new sb.XWarrantUI('xw-container', mod);
    mod.ui = ui;
    let renders = 0; ui.render = () => { renders++; }; ui._showLoading = () => {};
    await mod.scanForWarrants();
    ok(scanCalls.length === 1 && Array.isArray(scanCalls[0].extraPaths) && scanCalls[0].extraPaths.includes(linkedZip), 'scanForWarrants sends extraPaths');
    ok(mod.evidenceFiles.some(f => f.path === linkedZip), 'linked zip appears in the X tab evidence list');
    ok(bar.innerHTML.includes('🔒') && bar.innerHTML.includes('linked') && bar.innerHTML.includes('X-21-locked.zip'), 'evidence bar: lock icon + linked badge');
    ok(bar.innerHTML.includes('password-protected'), 'evidence bar: tooltip says password-protected');

    let asks = [], answers = [null];
    ui._askPassword = (name, wasWrong) => { asks.push([name, !!wasWrong]); return Promise.resolve(answers.shift()); };
    let rec = await ui._runImport(linkedZip, 'X-21-locked.zip', false);
    ok(rec === null && asks.length === 1 && mod.imports.length === 0, 'cancel at password prompt → nothing imported');
    asks = []; answers = ['nope', PW];
    rec = await ui._runImport(linkedZip, 'X-21-locked.zip', false);
    ok(rec && rec.accountUsername === 'synthuser' && mod.imports.length === 1, 'wrong then right password → imported');
    ok(asks.length === 2 && asks[0][1] === false && asks[1][1] === true && asks[0][0] === 'X-21-locked.zip', 'prompt shown twice; second says the password was wrong');
    ok(!JSON.stringify(store).includes(PW), 'password never written to localStorage');
    ok(mod.evidenceFiles.find(f => f.path === linkedZip).alreadyImported === true, 'after import the linked zip shows as imported');
    asks = []; answers = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    let tooMany = null; try { await ui._runImport(linkedZip, 'X-21-locked.zip', false); } catch (e) { tooMany = e; }
    ok(tooMany && /Too many/.test(tooMany.message) && asks.length === 6, 'gives up after 6 wrong passwords');
    let otherErr = null; try { await ui._runImport(path.join(TMP, 'other.zip'), 'other.zip', false); } catch (e) { otherErr = e; }
    ok(otherErr && otherErr.code === 'NOT_X_PRODUCTION' && asks.length === 6, 'non-password errors are not turned into a prompt');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${fail === 0 ? '✔ ALL TESTS PASSED' : '✖ FAILURES'} pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack); process.exit(2); });
