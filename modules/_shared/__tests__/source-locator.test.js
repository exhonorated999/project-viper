/**
 * source-locator.js — finding a displayed value in the ORIGINAL return.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd modules\_shared\__tests__\source-locator.test.js
 * (needs mupdf, so run it under Electron-as-Node like the other main-process suites)
 *
 * WHY THIS EXISTS
 * An ICAC commander asked the question every examiner asks of a parser:
 * "how do I know what it shows me is really in the return?" Source
 * Validation answers it by searching the original for the value and
 * showing the spot. The failure modes that matter are all silent:
 *
 *   - the wrong occurrence highlighted        -> the officer "validates"
 *                                                against a different record
 *   - "1.2.3.4" found inside "11.2.3.45"      -> a false confirmation
 *   - a match lost or invented at a chunk edge -> large returns lie quietly
 *   - a near-match reported as exact          -> the officer is told the
 *                                                text is identical when it
 *                                                is not
 *   - a picture or video opened to search it  -> CSAM shown or decoded
 *   - plaintext of an encrypted return left    -> the Field Security promise
 *     in a temp file or served while locked      is broken
 *   - an integrity check that says "matches"   -> the one line a court will
 *     when it cannot know                        read is wrong
 *
 * Every one of those is pinned below.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..', '..');
const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
const L = require(path.join(__dirname, '..', 'source-locator.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL ' + label); }
}
function section(s) { console.log('[' + s + ']'); }

const HDR = Buffer.from('VIPENC');
const security = {
    unlocked: true,
    isEnabled() { return true; },
    isUnlocked() { return this.unlocked; },
    isEncryptedBuffer(b) { return b.length >= 6 && b.slice(0, 6).equals(HDR); },
    encryptBuffer(b) { return Buffer.concat([HDR, b]); },
    decryptBuffer(b) { return b.slice(6); },
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-srcloc-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ── fixtures (synthetic) ───────────────────────────────────────────────────

const CSV = [
    'Target Username,jdoe_test',
    'Date Range,2025-01-01 - 2025-02-01',
    '===========================',
    'Timestamp,IP Address,Port,Status',
    '2025-01-03 10:00:00 UTC,10.0.0.5,443,success',
    '2025-01-04 11:00:00 UTC,10.0.0.5,8443,success',
    '2025-01-05 12:00:00 UTC,10.0.0.5,443,failure',
    '2025-01-06 13:00:00 UTC,11.0.0.55,80,success',
    '2025-01-07 14:00:00 UTC,"Mobility, Inc",22,success',
].join('\r\n') + '\r\n';

const HTML = [
    '<html><head><title>Records</title><style>.t{color:#333}</style>',
    '<script>window.bad = 1</script></head><body>',
    '<div class="t">Registration IP<div>203.0.113.9</div></div>',
    '<div class="t">Carrier<div>AT&amp;T Mobility</div></div>',
    '<div class="t">About<div>first line<br>second line</div></div>',
    '<img src="linked_media/photo_1.jpg" onerror="alert(1)">',
    '<a href="javascript:alert(2)">x</a>',
    '</body></html>',
].join('\n');

function makePdf(pages) {
    // A minimal, valid PDF with Helvetica text — one array of lines per page.
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('PAGES');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const kids = [];
    for (const lines of pages) {
        const body = 'BT /F1 12 Tf 72 720 Td 16 TL ' +
            lines.map(l => '(' + l.replace(/[()\\]/g, '\\$&') + ") '").join(' ') + ' ET';
        const c = add('<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream');
        kids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + c + ' 0 R >>'));
    }
    objs[1] = '<< /Type /Pages /Kids [' + kids.map(k => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const x = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
        offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
        'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
    return Buffer.from(out, 'latin1');
}

const PDF = makePdf([
    ['CyberTipline Report 123456', 'Section A: Reported Information'],
    ['Section B: Automated Information', 'IP Address: 198.51.100.24', 'Date: 01-05-2025 12:00:00 UTC', 'Port: 5555'],
]);

const zipPlain = path.join(TMP, 'return.zip');
{
    const z = new AdmZip();
    z.addFile('part-1/login_history.csv', Buffer.from(CSV, 'utf8'));
    z.addFile('part-1/records.html', Buffer.from(HTML, 'utf8'));
    z.addFile('part-1/friends.csv', Buffer.from('Username,Added\r\nother_user,2025-01-01\r\n10.0.0.5 note,x\r\n', 'utf8'));
    // A "picture" whose bytes contain a searchable string: must never be read.
    z.addFile('part-1/media/secret.jpg', Buffer.from('\xFF\xD8\xFF NEEDLE_IN_IMAGE 10.0.0.5', 'latin1'));
    z.addFile('part-1/notes_utf16.txt', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Device ID: ABC-123-XYZ\r\n', 'utf16le')]));
    z.addFile('report.pdf', PDF);
    fs.writeFileSync(zipPlain, z.toBuffer());
}
const zipEnc = path.join(TMP, 'sealed.zip');
fs.writeFileSync(zipEnc, security.encryptBuffer(fs.readFileSync(zipPlain)));

const spec = { path: zipPlain };

(async () => {
    // ── matcher unit behaviour ─────────────────────────────────────────────
    section('matcher');
    {
        const m = L.buildMatcher('1.2.3.4', false);
        ok(!m.re.test('11.2.3.45'), '"1.2.3.4" is not found inside "11.2.3.45"');
        m.re.lastIndex = 0;
        ok(!m.re.test('21.2.3.4 '), '"1.2.3.4" is not found at the end of "21.2.3.4"');
        m.re.lastIndex = 0;
        ok(m.re.test('ip=1.2.3.4,'), '"1.2.3.4" is found between punctuation');
        const u = L.buildMatcher('jdoe', false);
        ok(!u.re.test('jdoe_test'), 'a username is not found inside a longer username');
        ok(L.classify('10.0.0.5', '10.0.0.5', false) === 'exact', 'identical text is exact');
        ok(L.classify('JDoe', 'jdoe', false) === 'case', 'a case difference is reported as case');
        ok(L.classify('AB C123', 'ABC 123', false) === 'spacing', 'a spacing difference is reported as spacing');
        ok(L.classify('AT&amp;T', 'AT&T', true) === 'exact', 'an HTML-encoded & is the same text');
        ok(L.classify('a<br>b', 'a\nb', true) === 'exact', 'a <br> where VIPER shows a line break is the same text');
        const long = L.buildMatcher('word '.repeat(80), false);
        ok(long.truncated && long.len <= L.LIMITS.maxValueChars, 'a long message body is searched by its opening');
        let threw = false;
        try { L.buildMatcher('a-b/c(d)[e]{f}|g^h$i+j*k?l.m\\n', false); } catch (_) { threw = true; }
        ok(!threw, 'every punctuation character is escaped validly under the u flag');
    }

    // ── members: what is ever opened ───────────────────────────────────────
    section('members');
    {
        const lm = await L.listMembers(spec, security);
        ok(lm.ok && lm.sourceKind === 'zip', 'a ZIP source lists');
        const names = lm.members.map(m => m.entry);
        ok(!names.some(n => /\.jpg$/i.test(n)), 'pictures are never listed as searchable');
        ok(names.includes('part-1/login_history.csv') && names.includes('report.pdf'), 'CSV and PDF members are listed');
        const r = await L.locate(spec, { values: ['NEEDLE_IN_IMAGE'] }, security);
        ok(r.ok && r.found === false, 'text inside a picture is never found (the picture is not opened)');
        ok(!r.searchedMembers.some(s => /\.jpg/i.test(s)), 'the picture is not in the searched list');
        const miss = await L.listMembers({ path: path.join(TMP, 'nope.zip') }, security);
        ok(!miss.ok && miss.missing, 'a missing original reports missing');
        const pin = await L.listMembers({ path: zipPlain, entry: 'report.pdf' }, security);
        ok(pin.ok && pin.members.length === 1, 'entry restricts a ZIP to one member');
    }

    // ── CSV: the right row, the header, the cells ──────────────────────────
    section('csv');
    let csvHit;
    {
        const r = await L.locate(spec, {
            values: ['10.0.0.5', '2025-01-04 11:00:00 UTC', '8443'],
            memberHints: ['login_history.csv'],
        }, security);
        ok(r.ok && r.found && r.primaryFound, 'the IP is found');
        csvHit = r.hits[0];
        ok(csvHit.member.endsWith('login_history.csv'), 'the hinted file is used');
        ok(csvHit.line === 6, 'corroboration picks the row with the matching timestamp and port (line 6), got ' + csvHit.line);
        ok(csvHit.corroboratedBy.length === 2, 'both corroborating values are reported');
        ok(csvHit.matchKind === 'exact', 'reported as an exact match');
        ok(r.totalHits === 3, 'all three occurrences in the hinted file are counted (not the 11.0.0.55 row), got ' + r.totalHits);
        ok(!r.searchedMembers.some(s => /friends\.csv/.test(s)), 'once found in the hinted file, other files are not searched');
        const v = await L.view(spec, csvHit, { values: ['10.0.0.5'] }, security);
        ok(v.ok && v.format === 'csv', 'CSV view');
        ok(v.header && v.header.n === 4 && /^Timestamp,IP Address/.test(v.header.text), 'the header is the line after the === separator');
        const t = v.lines.find(l => l.target);
        ok(t && t.n === 6 && t.text.slice(t.hlStart, t.hlEnd) === '10.0.0.5', 'the target line is highlighted at the value');
        ok(v.lines[0].n >= 1 && v.lines.length >= 5, 'context lines are returned with line numbers');
        ok(Array.isArray(v.cells) && v.cells.length === 4, 'header → cell mapping for the row');
        const ipCell = v.cells && v.cells.find(c => c.name === 'IP Address');
        ok(ipCell && ipCell.value === '10.0.0.5' && ipCell.hit, 'the matched cell is marked under its column name');
        const portCell = v.cells && v.cells.find(c => c.name === 'Port');
        ok(portCell && portCell.value === '8443', 'neighbouring cells read from the original row');
    }
    {
        const r = await L.locate(spec, { values: ['Mobility, Inc'], memberHints: ['login_history.csv'] }, security);
        ok(r.found && r.hits[0].line === 9, 'a quoted CSV cell with a comma is found');
        const v = await L.view(spec, r.hits[0], { values: ['Mobility, Inc'] }, security);
        const c = v.cells && v.cells.find(x => x.name === 'IP Address');
        ok(c && c.value === 'Mobility, Inc', 'quoted cells map to the right column');
        // Line 9 is the last line; the file ends with a newline.
        const last = v.lines[v.lines.length - 1];
        ok(last.n === 9 && last.text !== '' && !last.cutRight,
            'the window ends at the true last line \u2014 no empty phantom line, no "\u2026" after it');
    }

    // ── fallback and not-found honesty ─────────────────────────────────────
    section('honesty');
    {
        const r = await L.locate(spec, { values: ['NOT-IN-RETURN-XYZ', '11.0.0.55'] }, security);
        ok(r.found && r.primaryFound === false && r.usedValueIndex === 1, 'falls back to the next value and says so');
        // A related detail that sits on many rows (a status, a sender name)
        // must not produce a confident line number on its own.
        const lone = await L.locate(spec, { values: ['NOT-IN-RETURN-XYZ', 'success', '1999-12-31 00:00:00 UTC'] }, security);
        ok(lone.ok && lone.found === false && lone.relatedOnly === true,
            'two related details given, only one found (on many rows) \u2192 not found, no line offered');
        const backed = await L.locate(spec, { values: ['NOT-IN-RETURN-XYZ', '2025-01-04 11:00:00 UTC', '8443'] }, security);
        ok(backed.found && backed.primaryFound === false && backed.hits[0].line === 6 && backed.hits[0].corroboratedBy.length === 1,
            'two related details found TOGETHER \u2192 that record is offered (line 6), still marked not-found-itself');
        const later = await L.locate(spec, { values: ['NOT-IN-RETURN-XYZ', 'no-such-detail', '11.0.0.55', '80'] }, security);
        ok(later.found && later.usedValueIndex === 2 && later.hits[0].line === 8,
            'skips a related detail that is absent and anchors on the next one that is backed');
        const n = await L.locate(spec, { values: ['definitely-not-here-777'] }, security);
        ok(n.ok && n.found === false && n.searchedMembers.length >= 4, 'not found lists every file searched');
        const tier = await L.locate(spec, { values: ['TIMESTAMP,IP ADDRESS'] }, security);
        ok(tier.found && tier.hits[0].matchKind === 'case', 'a case-only match is never reported as exact');
        const e = await L.locate(spec, { values: [' '] }, security);
        ok(!e.ok, 'a blank value is refused');
    }

    // ── chunk boundaries ───────────────────────────────────────────────────
    section('chunks');
    {
        const base = await L.locate(spec, { values: ['10.0.0.5'] }, security);
        L._clearCaches();
        L._setChunkBytes(17);
        const small = await L.locate(spec, { values: ['10.0.0.5'] }, security);
        const key = r => r.hits.map(h => h.member + '|' + h.line + '|' + h.offset + '|' + h.col).sort().join(';');
        ok(key(base) === key(small) && base.totalHits === small.totalHits, 'a 17-byte chunk size finds exactly the same hits at the same lines');
        // A value ending exactly at a chunk edge, followed by a digit.
        const f = path.join(TMP, 'edge.txt');
        const pre = ' '.repeat(40);   // spaces: a letter here would hide the edge behind the look-behind
        fs.writeFileSync(f, pre + '1.2.3.4' + '5 trailing\nline two 1.2.3.4\n');
        L._clearCaches();
        L._setChunkBytes(47);  // edge lands right after "1.2.3.4"
        const edge = await L.locate({ path: f }, { values: ['1.2.3.4'] }, security);
        ok(edge.found && edge.totalHits === 1 && edge.hits[0].line === 2, 'a value cut at a chunk edge is not confused with a longer one');
        const big = path.join(TMP, 'big.csv');
        const rows = [];
        for (let i = 0; i < 5000; i++) rows.push(i + ',user' + i + ',' + (i === 4321 ? 'TARGET-VALUE' : 'v' + i));
        fs.writeFileSync(big, 'n,user,val\n' + rows.join('\n') + '\n');
        L._clearCaches();
        L._setChunkBytes(4096);
        const b = await L.locate({ path: big }, { values: ['TARGET-VALUE', 'user4321'] }, security);
        ok(b.found && b.hits[0].line === 4323 && b.hits[0].corroboratedBy.length === 1, 'line numbers stay right across hundreds of chunks');
        L._setChunkBytes(1024 * 1024);
        L._clearCaches();
    }

    // ── encodings ──────────────────────────────────────────────────────────
    section('encodings');
    {
        const r = await L.locate(spec, { values: ['ABC-123-XYZ'] }, security);
        ok(r.found && /notes_utf16/.test(r.hits[0].member), 'a UTF-16 text file with a byte-order mark is searched');
        const f = path.join(TMP, 'bom.csv');
        fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a,b\nfoo,bar\n')]));
        const v = await L.locate({ path: f }, { values: ['a,b'] }, security);
        ok(v.found && v.hits[0].col === 0, 'a UTF-8 byte-order mark is not counted as text');
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    section('html');
    {
        const r = await L.locate(spec, { values: ['AT&T Mobility'], memberHints: ['records.html'] }, security);
        ok(r.found && r.hits[0].matchKind === 'exact', 'an entity-encoded value is found as exact');
        const v = await L.view(spec, r.hits[0], { values: ['AT&T Mobility'] }, security);
        ok(v.ok && v.format === 'html' && v.marked, 'rendered view marks the hit');
        ok(/<mark id="viper-src-hit">AT&amp;T Mobility<\/mark>/.test(v.html), 'the mark wraps the original text');
        ok(/Content-Security-Policy/.test(v.html) && /default-src 'none'/.test(v.html), 'the rendered page carries a no-network CSP');
        ok(!/<script/i.test(v.html), 'scripts are removed');
        ok(!/onerror\s*=/i.test(v.html), 'inline event handlers are removed');
        ok(!/\ssrc\s*=/i.test(v.html) && !/javascript:/i.test(v.html), 'no src and no javascript: URL survives');
        ok(/\.t\{color:#333\}/.test(v.html), 'the page\'s own styles are kept');
        ok(Array.isArray(v.raw) && v.raw.some(l => l.target), 'a raw-text view is returned too');
        const br = await L.locate(spec, { values: ['first line\nsecond line'] }, security);
        ok(br.found && br.hits[0].matchKind === 'exact', 'text split by <br> is found');
        const attr = L.sanitizeHtml('<div style="x" onclick="evil()">a</div><iframe src="x"></iframe><meta http-equiv="refresh" content="0;url=x">');
        ok(!/onclick|iframe|<meta/i.test(attr), 'sanitizer strips handlers, frames and meta refresh');
    }

    // ── PDF ────────────────────────────────────────────────────────────────
    section('pdf');
    {
        const r = await L.locate(spec, { values: ['198.51.100.24', '5555'] }, security);
        ok(r.found && r.hits[0].page === 2 && r.hits[0].pageCount === 2, 'the IP is found on page 2 of 2');
        ok(r.hits[0].corroboratedBy.length === 1, 'the port on the same page corroborates');
        const v = await L.view(spec, r.hits[0], { values: ['198.51.100.24', '5555'] }, security);
        ok(v.ok && v.format === 'pdf' && v.page === 2, 'PDF view renders page 2');
        const png = Buffer.from(v.png || '', 'base64');
        ok(png.slice(1, 4).toString() === 'PNG' && v.width > 500, 'a PNG page image is returned');
        const hit = v.rects.find(x => x.role === 'hit');
        ok(hit && hit.w > 10 && hit.h > 4 && hit.y > 0 && hit.y < v.height, 'a highlight rectangle is placed on the page');
        ok(v.rects.some(x => x.role === 'corroborate'), 'the corroborating value is outlined');
        ok(v.lines.some(l => l.target && /198\.51\.100\.24/.test(l.text)), 'the page text line is returned');
        const pinned = await L.locate({ path: zipPlain, entry: 'report.pdf' }, { values: ['10.0.0.5'] }, security);
        ok(pinned.found === false, 'a source pinned to the PDF does not search the rest of the ZIP');
    }

    // ── encrypted originals ────────────────────────────────────────────────
    section('encrypted');
    {
        const tmpBefore = fs.readdirSync(os.tmpdir()).filter(n => /^viper-zip-/.test(n)).length;
        L._clearCaches();
        const r = await L.locate({ path: zipEnc }, { values: ['10.0.0.5'], memberHints: ['login_history.csv'] }, security);
        ok(r.found && r.hits[0].line === 5, 'an encrypted ZIP is searched (in memory)');
        const v = await L.view({ path: zipEnc }, r.hits[0], { values: ['10.0.0.5'] }, security);
        ok(v.ok && v.lines.some(l => l.target), 'an encrypted ZIP is viewable when unlocked');
        const tmpAfter = fs.readdirSync(os.tmpdir()).filter(n => /^viper-zip-/.test(n)).length;
        ok(tmpAfter === tmpBefore, 'no plaintext temp file is written');
        security.unlocked = false;
        const lk = await L.locate({ path: zipEnc }, { values: ['10.0.0.5'] }, security);
        ok(!lk.ok && lk.locked, 'locked vault: flat refusal');
        const lv = await L.view({ path: zipEnc }, r.hits[0], { values: ['10.0.0.5'] }, security);
        ok(!lv.ok && lv.locked, 'locked vault: a cached plaintext copy is not served');
        security.unlocked = true;
        const encFile = path.join(TMP, 'sealed.csv');
        fs.writeFileSync(encFile, security.encryptBuffer(Buffer.from(CSV)));
        const ef = await L.locate({ path: encFile }, { values: ['11.0.0.55'] }, security);
        ok(ef.found && ef.hits[0].line === 8, 'an encrypted single file is searched');
        // That search left a decrypted copy in the cache. Locking must stop it being served.
        security.unlocked = false;
        const efl = await L.locate({ path: encFile }, { values: ['11.0.0.55'] }, security);
        ok(!efl.ok && efl.locked, 'locked vault: a cached decrypted copy of an encrypted file is not served');
        security.unlocked = true;
    }

    // ── folders ────────────────────────────────────────────────────────────
    section('folders');
    {
        const p1 = path.join(TMP, 'jdoe-111-222-1-20250101');
        const p2 = path.join(TMP, 'jdoe-111-222-2-20250101');
        fs.mkdirSync(p1); fs.mkdirSync(p2);
        fs.writeFileSync(path.join(p1, 'conversations.csv'), 'a,b\nhello,world\n');
        fs.writeFileSync(path.join(p2, 'conversations.csv'), 'a,b\npart two text,here\n');
        fs.writeFileSync(path.join(p2, 'clip.mp4'), 'part two text');
        const only = await L.locate({ path: p1 }, { values: ['part two text'] }, security);
        ok(only.found === false, 'without extraPaths the sibling part is not searched');
        const both = await L.locate({ path: p1, extraPaths: [p2] }, { values: ['part two text'] }, security);
        ok(both.found && /jdoe-111-222-2-20250101\/conversations\.csv/.test(both.hits[0].member), 'extraPaths searches sibling part folders');
        ok(!both.searchedMembers.some(s => /\.mp4/.test(s)), 'video in a folder is never searched');
        const h = await L.hashSource({ path: p1, extraPaths: [p2] }, security);
        ok(h.ok && h.scope === 'folder' && h.folder.fileCount === 3, 'a folder source is fingerprinted file by file (media included)');
        fs.appendFileSync(path.join(p2, 'conversations.csv'), 'tampered\n');
        L._clearCaches();
        const h2 = await L.hashSource({ path: p1, extraPaths: [p2] }, security);
        ok(L.compareIntegrity({ sha256: h.contentSha256 }, h2) === 'mismatch', 'a changed file in the folder is a mismatch');
    }

    // ── integrity ──────────────────────────────────────────────────────────
    section('integrity');
    {
        const h = await L.hashSource(spec, security);
        ok(h.ok && h.container.sha256 === sha(fs.readFileSync(zipPlain)), 'the container hash is the file\'s real SHA-256');
        ok(h.contentSha256 === h.container.sha256, 'for a plain file, content hash = file hash');
        const he = await L.hashSource({ path: zipEnc }, security);
        ok(he.container.encryptedAtRest && he.contentSha256 === sha(fs.readFileSync(zipPlain)), 'for an encrypted file, the content hash is the provider\'s original bytes');
        ok(L.compareIntegrity({ sha256: h.contentSha256 }, he) === 'match', 'a return encrypted after import still matches its import fingerprint');
        const hm = await L.hashSource({ path: zipPlain, entry: 'report.pdf' }, security);
        ok(hm.member && hm.member.sha256 === sha(PDF), 'a member hash is the PDF\'s own SHA-256');
        ok(L.compareIntegrity({ sha256: 'deadbeef', memberSha256: sha(PDF) }, hm) === 'match', 'the member hash decides when recorded');
        const extracted = path.join(TMP, 'extracted-report.pdf');
        fs.writeFileSync(extracted, PDF);
        const hx = await L.hashSource({ path: extracted }, security);
        ok(L.compareIntegrity({ sha256: h.contentSha256, memberSha256: sha(PDF) }, hx) === 'match', 'imported from a ZIP, relocated to the extracted report: matches its member fingerprint');
        fs.writeFileSync(extracted, Buffer.concat([PDF, Buffer.from('%x')]));
        L._clearCaches();
        const hx2 = await L.hashSource({ path: extracted }, security);
        ok(L.compareIntegrity({ sha256: h.contentSha256, memberSha256: sha(PDF) }, hx2) === 'mismatch', 'a changed extracted report is still a mismatch');
        security.unlocked = false;
        L._clearCaches();
        const hl = await L.hashSource({ path: zipEnc }, security);
        ok(hl.contentSha256 === null && hl.container.contentNote === 'locked', 'locked: the content hash is not guessed');
        ok(L.compareIntegrity({ sha256: h.contentSha256 }, hl) === 'unknown', 'locked: never reported as a mismatch');
        security.unlocked = true;
        ok(L.compareIntegrity(null, h) === 'unknown', 'no fingerprint at import: unknown, not match');
        const copy = path.join(TMP, 'copy.zip');
        fs.copyFileSync(zipPlain, copy);
        const before = await L.hashSource({ path: copy }, security);
        fs.appendFileSync(copy, Buffer.from('x'));
        const after = await L.hashSource({ path: copy }, security);
        ok(L.compareIntegrity({ sha256: before.contentSha256 }, after) === 'mismatch', 'one changed byte is a mismatch (the cache does not hide it)');
    }

    // ── view refuses what is not in the source ─────────────────────────────
    section('view-guard');
    {
        const v = await L.view(spec, Object.assign({}, csvHit, { memberKey: 'part-1/media/secret.jpg' }), { values: ['x'] }, security);
        ok(!v.ok, 'a picture cannot be viewed by naming it');
        const v2 = await L.view(spec, Object.assign({}, csvHit, { memberKey: 'C:/Windows/win.ini' }), { values: ['x'] }, security);
        ok(!v2.ok, 'a path outside the source is refused');
        const mb = await L.memberBytes(spec, 'part-1/media/secret.jpg', security);
        ok(!mb.ok, 'Save a copy refuses a picture');
        const mb2 = await L.memberBytes(spec, 'part-1/login_history.csv', security);
        ok(mb2.ok && mb2.bytes.toString('utf8') === CSV, 'Save a copy returns the original bytes of a text member');
    }

    // ── batch citation ─────────────────────────────────────────────────────
    section('cite');
    {
        const r = await L.citeBatch(spec, [
            { id: 'a', values: ['10.0.0.5', '8443'], memberHints: ['login_history.csv'] },
            { id: 'b', values: ['198.51.100.24'] },
            { id: 'c', values: ['nowhere-to-be-found-1'] },
        ], security);
        ok(r.ok && r.results.length === 3, 'one result per item');
        const a = r.results.find(x => x.id === 'a');
        ok(a.found && a.line === 6 && /login_history/.test(a.member), 'item a cites the corroborated row');
        const b = r.results.find(x => x.id === 'b');
        ok(b.found && b.page === 2, 'item b cites the PDF page');
        const c = r.results.find(x => x.id === 'c');
        ok(c.found === false && !c.notChecked, 'item c is honestly not found');
    }

    // ── plain-text formats a return arrives in ─────────────────────────────
    section('text-kinds');
    {
        for (const n of ['a.eml', 'b.emlx', 'Mail.mbox', 'cal.ics', 'card.vcf', 'tweets.js', 'build.prop', 'softap.conf', 'x.ufd', 'EvidenceCollection.ufdx'])
            ok(L.searchKind(n) === 'text', n + ' is searched as text');
        for (const n of ['photo.jpg', 'clip.mp4', 'mmssms.db', 'bugle_db', 'archive.zip'])
            ok(L.searchKind(n) !== 'text', n + ' is not searched as text');
        ok(L.isSqliteName('contacts2.db') && L.isSqliteName('bugle_db') && L.isSqliteName('x.sqlite3'), 'phone databases are recognised by name');
        ok(!L.isSqliteName('Thumbs.db') && !L.isSqliteName('mmssms.db-wal') && !L.isSqliteName('notes.txt'), 'Thumbs.db, a -wal file and text are not databases');
        ok(L.formatOf('mmssms.db') === 'sqlite' && L.formatOf('x.eml') === 'text', 'formatOf: database vs text');
    }

    // ── phone databases (Cellebrite) ───────────────────────────────────────
    section('sqlite');
    {
        const Sqlite = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
        const dir = path.join(TMP, 'extracted');
        fs.mkdirSync(dir, { recursive: true });
        const dbPath = path.join(dir, 'mmssms.db');
        const w = new Sqlite(dbPath);
        w.exec('CREATE TABLE sms (_id INTEGER PRIMARY KEY, address TEXT, body TEXT, date INTEGER, type INTEGER, data BLOB)');
        const ins = w.prepare('INSERT INTO sms (_id, address, body, date, type, data) VALUES (?,?,?,?,?,?)');
        ins.run(1, '+15551230001', 'ok', 1700000000000, 1, Buffer.from([1, 2, 3]));
        ins.run(2, '+15551230002', 'ok', 1700000100000, 2, null);
        ins.run(7, '+15551230002', 'Meet me behind the gym at 9', 1700000200000, 1, null);
        w.exec('CREATE TABLE threads (_id INTEGER PRIMARY KEY, recipient_ids TEXT)');
        w.prepare('INSERT INTO threads VALUES (?,?)').run(1, '+15551230002');
        w.close();
        fs.writeFileSync(path.join(dir, 'build.prop'), 'ro.product.model=Pixel Fold\nro.serialno=ABC123XYZ\n');
        fs.writeFileSync(path.join(dir, 'mmssms.db-shm'), Buffer.alloc(64, 7));
        const dbHash0 = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
        const mtime0 = fs.statSync(dbPath).mtimeMs;
        const dspec = { path: dir };

        const lm = await L.listMembers(dspec, security);
        ok(lm.ok && lm.members.some(m => m.format === 'sqlite' && /mmssms\.db$/.test(m.label)), 'the database is listed as a searchable member');
        ok(!lm.members.some(m => /-shm$/.test(m.label)), 'its -shm scratch file is not');

        const r1 = await L.locate(dspec, { values: ['Meet me behind the gym at 9', '+15551230002'] }, security);
        ok(r1.ok && r1.found && r1.primaryFound, 'a message body is found in the database');
        const h1 = r1.hits[0];
        ok(h1.format === 'sqlite' && h1.table === 'sms' && h1.rowid === 7 && h1.column === 'body', 'cited by table, row and column (sms row 7, body)');
        ok(h1.corroboratedBy.length === 1, 'the sender on the same row corroborates it');
        ok(/sms \u203A body: Meet me/.test(h1.preview), 'preview names table and column');

        // "ok" is on two rows: the record pointer picks the right one.
        const r2 = await L.locate(dspec, { values: ['ok'], record: { member: 'mmssms.db', table: 'sms', rowid: 2 } }, security);
        ok(r2.found && r2.hits.length === 1 && r2.hits[0].rowid === 2, 'record pointer reads exactly the row the reader used');
        const r2b = await L.locate(dspec, { values: ['ok'] }, security);
        ok(r2b.found && r2b.totalHits === 2, 'without a pointer both rows are offered');
        const r2c = await L.locate(dspec, { values: ['Meet me behind the gym at 9'], record: { table: 'sms', rowid: 1 } }, security);
        ok(r2c.found && r2c.hits[0].rowid === 7, 'a pointer at a row that does not hold the value falls back to searching');
        const r2d = await L.locate(dspec, { values: ['ok'], record: { member: 'other.db', table: 'sms', rowid: 2 } }, security);
        ok(r2d.found && r2d.totalHits === 2, 'a pointer naming another database is ignored here');
        const r2e = await L.locate(dspec, { values: ['ok'], record: { table: 'sms"; DROP TABLE sms; --', rowid: 1 } }, security);
        ok(r2e.found && r2e.totalHits === 2, 'an unknown table name is never used in SQL');

        const r3 = await L.locate(dspec, { values: ['1700000200000'] }, security);
        ok(r3.found && r3.hits[0].column === 'date' && r3.hits[0].rowid === 7, 'a raw epoch timestamp is found in its integer column');
        const r4 = await L.locate(dspec, { values: ['+1555123000'] }, security);
        ok(!r4.found, 'a number is never found inside a longer number');
        const r5 = await L.locate(dspec, { values: ['ABC123XYZ'] }, security);
        ok(r5.found && /build\.prop$/.test(r5.hits[0].member) && r5.hits[0].line === 2, 'build.prop is searched as text beside the databases');

        const v = await L.view(dspec, h1, { values: ['Meet me behind the gym at 9', '+15551230002'] }, security);
        ok(v.ok && v.format === 'record' && v.table === 'sms' && v.rowid === 7, 'view shows the record');
        const body = v.columns.find(c => c.name === 'body');
        ok(body.target && body.value.slice(body.hlStart, body.hlEnd) === 'Meet me behind the gym at 9', 'the matched column is highlighted exactly');
        const addr = v.columns.find(c => c.name === 'address');
        ok(addr.corroborate && !addr.target, 'the corroborating column is tagged');
        ok(v.columns.find(c => c.name === 'date').value === '1700000200000', 'raw values are shown untranslated');
        const v1 = await L.view(dspec, Object.assign({}, h1, { rowid: 1, column: 'address', matched: '+15551230001' }), { values: ['+15551230001'] }, security);
        const blob = v1.columns.find(c => c.name === 'data');
        ok(blob.binary && /3 bytes/.test(blob.value), 'binary columns are described, never dumped');
        const vbad = await L.view(dspec, Object.assign({}, h1, { table: 'nope' }), { values: ['x'] }, security);
        ok(!vbad.ok, 'an unknown table cannot be viewed');

        const cb = await L.citeBatch(dspec, [
            { id: 'a', values: ['ok'], record: { member: 'mmssms.db', table: 'sms', rowid: 2 } },
            { id: 'b', values: ['Meet me behind the gym at 9'] },
        ], security);
        const ca = cb.results.find(x => x.id === 'a'), cbb = cb.results.find(x => x.id === 'b');
        ok(ca.found && ca.table === 'sms' && ca.rowid === 2, 'report citation carries table and row');
        ok(cbb.found && cbb.rowid === 7, 'report citation without a pointer finds the row');

        L._clearCaches();
        ok(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex') === dbHash0 && fs.statSync(dbPath).mtimeMs === mtime0, 'the original database is byte-identical and untouched');
        ok(!fs.existsSync(dbPath + '-wal') && fs.readFileSync(path.join(dir, 'mmssms.db-shm')).equals(Buffer.alloc(64, 7)), 'no side files were created or changed beside it');

        const fh1 = await L.hashSource(dspec, security);
        fs.writeFileSync(path.join(dir, 'mmssms.db-shm'), Buffer.alloc(64, 9));
        L._clearCaches();
        const fh2 = await L.hashSource(dspec, security);
        ok(fh1.ok && fh1.folder.manifestSha256 === fh2.folder.manifestSha256, 'a rewritten -shm file does not change the folder fingerprint');
        ok(!fh1.folder.files.some(f => /-shm$/.test(f.rel)), 'the fingerprint lists no -shm file');

        // hashOnly: fingerprint just the files VIPER reads, not the pictures.
        const hoDir = path.join(TMP, 'Export One');
        fs.mkdirSync(path.join(hoDir, 'AppData'), { recursive: true });
        fs.mkdirSync(path.join(hoDir, 'FileSystem'), { recursive: true });
        fs.writeFileSync(path.join(hoDir, 'Contacts.csv'), 'No.,Name\n1,Alpha\n');
        fs.writeFileSync(path.join(hoDir, 'AppData', 'msgs.csv'), 'UID,Text\n9f-1,hello\n');
        fs.writeFileSync(path.join(hoDir, 'FileSystem', 'photo.jpg'), Buffer.alloc(4096, 3));
        const hoSpec = { path: hoDir, hashOnly: ['Contacts.csv', 'AppData\\msgs.csv', 'Missing.csv'] };
        const ho1 = await L.hashSource(hoSpec, security);
        ok(ho1.ok && ho1.folder.fileCount === 2 && ho1.folder.selected === true, 'hashOnly fingerprints only the named files (missing ones skipped)');
        ok(!ho1.folder.files.some(f => /photo\.jpg$/.test(f.rel)), 'hashOnly leaves the pictures out');
        const hoAll = await L.hashSource({ path: hoDir }, security);
        ok(hoAll.folder.fileCount === 3 && !hoAll.folder.selected, 'without hashOnly every file is fingerprinted');
        ok(ho1.folder.files.every(f => !/^Export One\//i.test(f.rel)), 'manifest paths are relative to the folder');

        // The same export moved to a differently named folder still matches.
        const hoMoved = path.join(TMP, 'Moved Elsewhere');
        fs.mkdirSync(path.join(hoMoved, 'AppData'), { recursive: true });
        fs.copyFileSync(path.join(hoDir, 'Contacts.csv'), path.join(hoMoved, 'Contacts.csv'));
        fs.copyFileSync(path.join(hoDir, 'AppData', 'msgs.csv'), path.join(hoMoved, 'AppData', 'msgs.csv'));
        const hoM = await L.hashSource({ path: hoMoved, hashOnly: hoSpec.hashOnly }, security);
        ok(L.compareIntegrity({ sha256: ho1.contentSha256 }, hoM) === 'match', 'a relocated export matches the fingerprint taken at import');

        // Editing a file deep inside does not change the folder's own
        // timestamp; the cached hash must not hide the change.
        await new Promise(r => setTimeout(r, 25));
        fs.writeFileSync(path.join(hoDir, 'AppData', 'msgs.csv'), 'UID,Text\n9f-1,HELLO\n');
        const ho2 = await L.hashSource(hoSpec, security);
        ok(L.compareIntegrity({ sha256: ho1.contentSha256 }, ho2) === 'mismatch', 'an edited file inside a folder shows as changed (no stale cache)');
        const ho3 = await L.hashSource({ path: hoDir }, security);
        ok(L.compareIntegrity({ sha256: hoAll.contentSha256 }, ho3) === 'mismatch', 'the same holds without hashOnly');

        // Field Security: an encrypted database is opened from memory.
        const encDir = path.join(TMP, 'extracted-enc');
        fs.mkdirSync(encDir, { recursive: true });
        fs.writeFileSync(path.join(encDir, 'mmssms.db'), security.encryptBuffer(fs.readFileSync(dbPath)));
        const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('viper-srcdb-')).length;
        const re1 = await L.locate({ path: encDir }, { values: ['Meet me behind the gym at 9'] }, security);
        ok(re1.found && re1.hits[0].rowid === 7, 'an encrypted database is searched once unlocked');
        const tmpDirs = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('viper-srcdb-'));
        const leaked = tmpDirs.some(n => { try { return fs.readdirSync(path.join(os.tmpdir(), n)).length > 0 && fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= mtime0 && fs.readdirSync(path.join(os.tmpdir(), n)).some(f => fs.readFileSync(path.join(os.tmpdir(), n, f)).includes('behind the gym')); } catch (_) { return false; } });
        ok(!leaked, 'its plaintext is never written to a temp file');
        L.onLock();
        security.unlocked = false;
        const re2 = await L.locate({ path: encDir }, { values: ['Meet me behind the gym at 9'] }, security);
        ok(!re2.ok && re2.locked, 'locked: a flat refusal');
        security.unlocked = true;
        void before;
    }

    // ── a folder of the provider's ZIPs (Google ships one per product) ──
    section('folder-of-zips');
    {
        const fz = path.join(TMP, 'google-folder');
        fs.mkdirSync(fz, { recursive: true });
        const z1 = new AdmZip();
        z1.addFile('Takeout/SubscriberInfo.html', Buffer.from('<html><body><p>Recovery IP: 203.0.113.77</p></body></html>', 'utf8'));
        z1.writeZip(path.join(fz, 'acct.SubscriberInfo_001.zip'));
        const z2 = new AdmZip();
        z2.addFile('Mail/All mail.mbox', Buffer.from('From x\r\nMessage-ID: <abc123@mail.gmail.com>\r\nSubject: Hello\r\n\r\nbody\r\n', 'utf8'));
        z2.writeZip(path.join(fz, 'acct.Mail_001.zip'));
        fs.writeFileSync(path.join(fz, 'notes.txt'), 'loose file 203.0.113.99\n');
        const lm = await L.listMembers({ path: fz });
        ok(lm.ok && lm.members.length === 3, 'folder lists members inside each ZIP plus loose files (' + (lm.members && lm.members.length) + ')');
        const r = await L.locate({ path: fz }, { values: ['203.0.113.77'], memberHints: ['SubscriberInfo'] });
        ok(r.ok && r.found && /acct\.SubscriberInfo_001\.zip \u203A Takeout\/SubscriberInfo\.html$/.test(r.hits[0].member), 'value found inside a ZIP in the folder, labelled zip › member');
        const v = await L.view({ path: fz }, r.hits[0], { values: ['203.0.113.77'] });
        ok(v.ok, 'the ZIP member opens in the viewer');
        const r2 = await L.locate({ path: fz }, { values: ['<abc123@mail.gmail.com>'], memberHints: ['.mbox'] });
        ok(r2.ok && r2.found && /\.mbox$/.test(r2.hits[0].member), '.mbox inside a ZIP is searched as text');
        fs.writeFileSync(path.join(fz, 'broken.zip'), 'not a zip');
        const lm2 = await L.listMembers({ path: fz });
        ok(lm2.ok && lm2.members.length === 3 && lm2.nestedErrors.length >= 1, 'an unreadable ZIP is reported, not fatal');

        // A return split across several ZIP files, each holding a same-named member.
        const p1 = path.join(TMP, 'split-1.zip'), p2 = path.join(TMP, 'split-2.zip');
        { const a = new AdmZip(); a.addFile('data/ip.csv', Buffer.from('ip\r\n198.51.100.1\r\n')); a.writeZip(p1); }
        { const a = new AdmZip(); a.addFile('data/ip.csv', Buffer.from('ip\r\n198.51.100.2\r\n')); a.writeZip(p2); }
        const one = await L.locate({ path: p1 }, { values: ['198.51.100.2'] });
        ok(one.ok && !one.found, 'without the other parts, part 2 content is not found');
        const both = await L.locate({ path: p1, extraPaths: [p2, p1, path.join(TMP, 'gone-3.zip')] }, { values: ['198.51.100.2'] });
        ok(both.ok && both.found && /^split-2\.zip \u203A data\/ip\.csv$/.test(both.hits[0].member), 'every part of a split return is searched (' + (both.hits && both.hits[0] && both.hits[0].member) + ')');
        const vb = await L.view({ path: p1, extraPaths: [p2] }, both.hits[0], { values: ['198.51.100.2'] });
        ok(vb.ok && JSON.stringify(vb).includes('198.51.100.2'), 'a same-named member in another part opens the right file');
        const lmb = await L.listMembers({ path: p1, extraPaths: [p2, path.join(TMP, 'gone-3.zip')] });
        ok(lmb.ok && lmb.members.length === 2 && lmb.nestedErrors.some(e => /gone-3/.test(e)), 'a missing part is reported, not silently skipped');
    }

    L._clearCaches();
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
