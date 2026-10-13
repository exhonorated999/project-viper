/**
 * Source Locator — find a value VIPER displays inside the ORIGINAL file it
 * came from, so an investigator can see it with their own eyes.
 *                                   MAIN PROCESS ONLY (fs / zip / mupdf).
 * ─────────────────────────────────────────────────────────────────────────
 * Why this works without any record of "where each value came from":
 * VIPER's warrant-return and CyberTip readers do not infer anything. Every
 * value on screen is a verbatim copy of text in the original return. So the
 * way to prove a value is to SEARCH the original for it — literally — and
 * show the spot. That also works for returns imported before this feature
 * existed, because nothing about the import has to change.
 *
 * Several values can be given for one item (e.g. an IP address, its
 * timestamp and its port). The first is the one being proved; the rest are
 * used only to pick the right occurrence when the first appears many times
 * (they "corroborate" a hit when they sit on the same line / near it / on
 * the same page). If the first value is not found, the next one that is
 * found is used instead — and the result says so plainly.
 *
 * Match tiers are reported honestly: exact, case differs, spacing differs.
 * For HTML, an entity-encoded spelling of the same characters (&amp; for &)
 * and a <br> where VIPER shows a line break count as the same text.
 *
 * Safety rules (the CyberTip ZIP rules carry over):
 *   - Only text-like files (txt/csv/html/json/xml/eml/…) and PDFs are ever
 *     read or searched. Pictures, video and audio are never opened here.
 *   - A phone database (SQLite) on disk is searched by record from a
 *     private temporary copy (from memory if Field Security encrypted it),
 *     so the original is never opened by SQLite at all.
 *   - An encrypted original is decrypted into MEMORY only (evidence-zip.js
 *     for ZIPs, decryptBuffer for plain files). Nothing is written to disk.
 *   - A locked vault is a flat refusal, and cached plaintext is dropped.
 *   - Very large members are searched as a stream (the Million-Record Rule):
 *     never one giant string, never more than one chunk plus a small tail.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const ez = require('./evidence-zip');

const MB = 1024 * 1024;

const LIMITS = Object.freeze({
    minValueChars: 2,
    maxValueChars: 160,          // longer values (message bodies) are searched by their opening
    maxValues: 8,
    maxHitsPerValuePerMember: 200,
    maxHitsReturned: 60,
    searchBudgetMs: 60000,
    citeBudgetMs: 120000,
    citeMaxItems: 400,
    maxWalkFiles: 20000,
    maxWalkDepth: 4,
    textCacheMemberMax: 64 * MB,
    textCacheTotalMax: 192 * MB,
    cacheIdleMs: 60000,
    contextLines: 6,
    rawContextLines: 12,
    lineWindowChars: 600,
    sliceChars: 12000,
    htmlWindowChars: 110000,
    htmlHeadScanChars: 262144,
    pdfMaxBytes: 300 * MB,
    pdfScale: 1.75,
    plainHashMaxBytes: ez.LIMITS.encryptedMaxBytes,
});

let _chunkBytes = 1024 * 1024;   // tests shrink this to prove chunk boundaries

// ── small helpers ──────────────────────────────────────────────────────────

function lockedError() {
    const e = new Error('This file is protected by Field Security. Unlock VIPER and try again.');
    e.code = 'VIPER_LOCKED';
    return e;
}

function _unlocked(security) {
    return !!(security && security.isUnlocked && security.isUnlocked());
}

function searchKind(name) {
    const k = ez.kindOf(name);
    if (k === 'text' || k === 'pdf') return k;
    // Plain-text formats returns are delivered in: e-mail (eml/emlx/mbox),
    // calendars and address cards (ics/vcf), X's data/*.js files, and the
    // property/config/index files of a phone extraction.
    if (/\.(tsv|log|txt|csv|json|xml|html?|xhtml|eml|emlx|mbox|ics|vcf|vcard|js|prop|conf|ini|ufd|ufdx)$/i.test(String(name || ''))) return 'text';
    return null;
}

/**
 * A phone database (SQLite). Searched by record, never as text, and only
 * when it sits on disk as its own file (a Cellebrite extraction) — a
 * database inside a ZIP is not opened.
 */
function isSqliteName(name) {
    const b = baseName(name).toLowerCase();
    if (b === 'thumbs.db') return false;
    return /\.(db|sqlite|sqlite3|sqlitedb)$/.test(b) || b === 'bugle_db';
}

function formatOf(name) {
    const n = String(name || '').toLowerCase();
    if (isSqliteName(n)) return 'sqlite';
    if (/\.pdf$/.test(n)) return 'pdf';
    if (/\.(html?|xhtml)$/.test(n)) return 'html';
    if (/\.(csv|tsv)$/.test(n)) return 'csv';
    return 'text';
}

function baseName(p) {
    return String(p || '').replace(/\\/g, '/').split('/').pop();
}

function escRe(s) {
    // Syntax characters only: under the 'u' flag an identity escape of
    // anything else (e.g. "\-") is a SyntaxError.
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function decodeHtml(s) {
    return String(s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function compact(s) { return String(s).replace(/\s+/g, ''); }

function _countBefore(sortedIdx, i) {
    // number of entries in sortedIdx strictly less than i
    let lo = 0, hi = sortedIdx.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedIdx[mid] < i) lo = mid + 1; else hi = mid; }
    return lo;
}

// ── value → matcher ────────────────────────────────────────────────────────

const HTML_CHAR = {
    '&': '(?:&amp;|&)',
    '"': '(?:&quot;|")',
    "'": "(?:&#0?39;|&apos;|')",
    '<': '(?:&lt;|<)',
    '>': '(?:&gt;|>)',
};

/**
 * One regex per value, case-insensitive and tolerant of spacing, bounded so
 * "1.2.3.4" is never found inside "11.2.3.45". Which tier actually matched
 * is decided afterwards by comparing the matched text with the value.
 */
function buildMatcher(value, html) {
    let v = String(value);
    let truncated = false;
    let c = compact(v);
    if (c.length > LIMITS.maxValueChars) {
        // Long text (a message body): search by its opening words.
        let cut = 0, seen = 0;
        while (cut < v.length && seen < LIMITS.maxValueChars) { if (!/\s/.test(v[cut])) seen++; cut++; }
        v = v.slice(0, cut);
        c = compact(v);
        truncated = true;
    }
    const chars = Array.from(c);
    const parts = chars.map(ch => (html && HTML_CHAR[ch]) ? HTML_CHAR[ch] : escRe(ch));
    const gap = html ? '(?:\\s|<br\\s*/?>|&nbsp;|&#160;)*' : '\\s*';
    let src = parts.join(gap);
    if (/^[A-Za-z0-9_]/.test(c)) src = '(?<![A-Za-z0-9_])' + src;
    if (!truncated && /[A-Za-z0-9_]$/.test(c)) src += '(?![A-Za-z0-9_])';
    return { value: v, len: c.length, truncated, html: !!html, re: new RegExp(src, 'giu') };
}

function classify(matched, value, html) {
    const t = html ? decodeHtml(matched) : String(matched);
    const v = String(value);
    if (t === v) return 'exact';
    const sq = s => s.replace(/\s+/g, ' ').trim();
    if (sq(t) === sq(v)) return 'exact';
    if (sq(t).toLowerCase() === sq(v).toLowerCase()) return 'case';
    if (compact(t) === compact(v)) return 'spacing';
    return 'case+spacing';
}

const KIND_RANK = { exact: 0, case: 1, spacing: 2, 'case+spacing': 3 };

function cleanValues(values) {
    const out = [];
    const arr = Array.isArray(values) ? values : [values];
    for (let i = 0; i < arr.length && out.length < LIMITS.maxValues; i++) {
        const raw = arr[i];
        if (raw === null || raw === undefined) continue;
        const s = String(raw).trim();
        if (compact(s).length < LIMITS.minValueChars) continue;
        out.push({ text: s, index: i });
    }
    return out;
}

// ── members ────────────────────────────────────────────────────────────────

function _walk(dir, baseLabel, depth, out) {
    if (out.length >= LIMITS.maxWalkFiles) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
        if (out.length >= LIMITS.maxWalkFiles) return;
        const full = path.join(dir, it.name);
        const label = baseLabel ? baseLabel + '/' + it.name : it.name;
        if (it.isDirectory()) {
            if (depth < LIMITS.maxWalkDepth && it.name !== '__MACOSX') _walk(full, label, depth + 1, out);
        } else if (it.isFile() && !ez.isJunk(label) && !/-(shm|journal)$/i.test(it.name)) {
            // A database's -shm/-journal file is SQLite's scratch space, not
            // evidence: merely opening the database can rewrite it, which
            // would make an untouched original look altered.
            out.push({ full, label });
        }
    }
}

function _sameEntry(a, b) {
    return String(a || '').replace(/\\/g, '/') === String(b || '').replace(/\\/g, '/');
}

/**
 * Every searchable file in the source.
 * spec = { path, entry?, inZip?, extraPaths? }
 *   path        a ZIP, a single file, or a folder
 *   entry/inZip restrict a ZIP to one member (a CyberTip PDF inside its ZIP)
 *   extraPaths  more folders that belong to the same production (Snapchat
 *               splits a return into sibling "part" folders)
 */
async function listMembers(spec, security) {
    spec = spec || {};
    const primary = await _listMembersOne(spec, security);
    // A return split into several ZIPs (Google's -1.zip, -2.zip …) is one
    // original: search every part. Folders take their extra folders below.
    const extras = Array.isArray(spec.extraPaths) ? spec.extraPaths : [];
    if (!primary.ok || primary.sourceKind === 'folder' || spec.entry || !extras.length) return primary;
    const seen = new Set([spec.path]);
    for (const x of extras) {
        if (typeof x !== 'string' || !x || seen.has(x)) continue;
        seen.add(x);
        if (!fs.existsSync(x)) { primary.nestedErrors = (primary.nestedErrors || []).concat([baseName(x) + ': no longer at ' + x]); continue; }
        const r = await _listMembersOne({ path: x }, security);
        if (!r.ok) {
            if (r.locked) return r;
            primary.nestedErrors = (primary.nestedErrors || []).concat([baseName(x) + ': ' + (r.error || 'could not be opened')]);
            continue;
        }
        for (const m of r.members) primary.members.push(Object.assign({}, m, { key: x + '::' + m.key }));
        if (r.nestedErrors && r.nestedErrors.length) primary.nestedErrors = (primary.nestedErrors || []).concat(r.nestedErrors);
    }
    return primary;
}

async function _listMembersOne(spec, security) {
    const p = spec.path;
    if (typeof p !== 'string' || !p) return { ok: false, error: 'No original file is recorded for this item.', missing: true };
    if (!fs.existsSync(p)) return { ok: false, error: 'The original file is no longer at ' + p, missing: true };
    const st = fs.statSync(p);

    if (st.isDirectory()) {
        const dirs = [p].concat(Array.isArray(spec.extraPaths) ? spec.extraPaths : [])
            .filter((d, i, a) => typeof d === 'string' && d && a.indexOf(d) === i && fs.existsSync(d) && fs.statSync(d).isDirectory());
        const files = [];
        for (const d of dirs) _walk(d, baseName(d), 0, files);
        const members = [];
        const nestedErrors = [];
        for (const f of files) {
            if (/\.zip$/i.test(f.label)) {
                // A folder of the provider's ZIPs (Google ships one per
                // product): search inside each, exactly as for a single ZIP.
                const zEnc = ez.isEncryptedFile(f.full, security);
                if (zEnc && !_unlocked(security)) return { ok: false, locked: true, error: lockedError().message };
                let listed;
                try { listed = await ez.listEvidenceZip(f.full, security); } catch (e) { listed = { ok: false, error: e && e.message }; }
                if (!listed || !listed.ok) { nestedErrors.push(f.label + ': ' + ((listed && listed.error) || 'could not be opened')); continue; }
                let zm = 0;
                try { zm = fs.statSync(f.full).mtimeMs; } catch (_) {}
                for (const e of listed.entries) {
                    const k = searchKind(e.name);
                    if (!k) continue;
                    members.push({
                        key: f.full + '::' + (e.inZip ? e.inZip + '::' : '') + e.name,
                        label: f.label + ' \u203A ' + (e.inZip ? e.inZip + ' \u203A ' : '') + e.name,
                        kind: k, format: formatOf(e.name), size: e.size || 0,
                        zipPath: f.full, entry: e.name, inZip: e.inZip || '', mtimeMs: zm, encrypted: zEnc,
                    });
                }
                for (const ne of (listed.nestedErrors || [])) nestedErrors.push(ne);
                continue;
            }
            const kind = searchKind(f.label) || (isSqliteName(f.label) ? 'sqlite' : null);
            if (!kind) continue;
            let size = 0, mtimeMs = 0;
            try { const s2 = fs.statSync(f.full); size = s2.size; mtimeMs = s2.mtimeMs; } catch (_) { continue; }
            members.push({
                key: f.full, label: f.label, kind, format: formatOf(f.label), size,
                diskPath: f.full, mtimeMs, encrypted: ez.isEncryptedFile(f.full, security),
            });
        }
        return { ok: true, sourceKind: 'folder', containerName: baseName(p), members, encrypted: false, nestedErrors };
    }

    if (/\.zip$/i.test(p)) {
        const encrypted = ez.isEncryptedFile(p, security);
        if (encrypted && !_unlocked(security)) return { ok: false, locked: true, error: lockedError().message };
        const listed = await ez.listEvidenceZip(p, security);
        if (!listed.ok) return { ok: false, error: listed.error, locked: !!listed.locked };
        let entries = listed.entries.filter(e => searchKind(e.name));
        if (spec.entry) {
            entries = entries.filter(e => _sameEntry(e.name, spec.entry) && String(e.inZip || '') === String(spec.inZip || ''));
            if (!entries.length) return { ok: false, error: 'That file is no longer inside the ZIP (' + spec.entry + ').' };
        }
        const zipName = baseName(p);
        const members = entries.map(e => ({
            key: (e.inZip ? e.inZip + '::' : '') + e.name,
            label: zipName + ' \u203A ' + (e.inZip ? e.inZip + ' \u203A ' : '') + e.name,
            kind: searchKind(e.name), format: formatOf(e.name), size: e.size || 0,
            zipPath: p, entry: e.name, inZip: e.inZip || '', mtimeMs: st.mtimeMs, encrypted,
        }));
        return { ok: true, sourceKind: 'zip', containerName: zipName, members, encrypted, nestedErrors: listed.nestedErrors || [] };
    }

    const kind = searchKind(p) || (isSqliteName(p) ? 'sqlite' : null);
    if (!kind) return { ok: false, error: 'VIPER can only search text files, web pages, spreadsheets (CSV) and PDFs.' };
    const encrypted = ez.isEncryptedFile(p, security);
    return {
        ok: true, sourceKind: 'file', containerName: baseName(p), encrypted,
        members: [{ key: p, label: baseName(p), kind, format: formatOf(p), size: st.size, diskPath: p, mtimeMs: st.mtimeMs, encrypted }],
    };
}

// ── reading a member ──────────────────────────────────────────────────────

function* _slices(buf) {
    for (let i = 0; i < buf.length; i += _chunkBytes) yield buf.subarray(i, Math.min(buf.length, i + _chunkBytes));
}

function _readDiskPlain(file, security) {
    if (ez.isEncryptedFile(file, security)) {
        if (!_unlocked(security)) throw lockedError();
        if (fs.statSync(file).size > LIMITS.plainHashMaxBytes) throw new Error('This encrypted file is too large to open inside VIPER.');
        return security.decryptBuffer(fs.readFileSync(file));
    }
    return null;
}

async function* _rawChunks(m, security) {
    if (m.diskPath) {
        const plain = _readDiskPlain(m.diskPath, security);
        if (plain) { yield* _slices(plain); return; }
        const rs = fs.createReadStream(m.diskPath, { highWaterMark: _chunkBytes });
        try {
            for await (const c of rs) yield* _slices(c);
        } finally { rs.destroy(); }
        return;
    }
    if (m.encrypted && !_unlocked(security)) throw lockedError();
    const stm = await ez.openEvidenceZipEntryStream(m.zipPath, m.entry, m.inZip || '', security);
    try {
        for await (const c of stm) yield* _slices(Buffer.isBuffer(c) ? c : Buffer.from(c));
    } finally { try { stm.destroy(); } catch (_) {} }
}

async function* _textChunks(m, security) {
    let dec = null;
    for await (const b of _rawChunks(m, security)) {
        let buf = b;
        if (!dec) {
            if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) { dec = new StringDecoder('utf16le'); buf = buf.subarray(2); }
            else {
                dec = new StringDecoder('utf8');
                if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
            }
        }
        const s = dec.write(buf);
        if (s) yield s;
    }
    if (dec) { const s = dec.end(); if (s) yield s; }
}

async function _memberBytes(m, security) {
    if (m.diskPath) {
        const plain = _readDiskPlain(m.diskPath, security);
        if (plain) return plain;
        return fs.readFileSync(m.diskPath);
    }
    if (m.encrypted && !_unlocked(security)) throw lockedError();
    const r = await ez.readEvidenceZipEntry(m.zipPath, m.entry, m.inZip || '', security);
    return r.bytes;
}

// ── decoded-text cache (repeat clicks and batch citation) ─────────────────

const _textCache = new Map();   // key -> { text, encrypted, timer }
let _textCacheTotal = 0;

function _cacheKey(m) {
    return (m.diskPath ? 'f|' + m.diskPath : 'z|' + m.zipPath + '|' + (m.inZip || '') + '|' + m.entry) + '|' + m.mtimeMs;
}

function _textCacheDrop(k) {
    const c = _textCache.get(k);
    if (!c) return;
    _textCache.delete(k);
    _textCacheTotal -= c.text.length;
    if (c.timer) clearTimeout(c.timer);
}

function _textCacheGet(k, security) {
    const c = _textCache.get(k);
    if (!c) return null;
    if (c.encrypted && !_unlocked(security)) { _textCacheDrop(k); throw lockedError(); }
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => _textCacheDrop(k), LIMITS.cacheIdleMs);
    if (c.timer.unref) c.timer.unref();
    return c;
}

function _textCachePut(k, text, encrypted) {
    if (text.length > LIMITS.textCacheMemberMax) return;
    while (_textCacheTotal + text.length > LIMITS.textCacheTotalMax && _textCache.size) {
        _textCacheDrop(_textCache.keys().next().value);
    }
    const c = { text, encrypted: !!encrypted, timer: null };
    c.timer = setTimeout(() => _textCacheDrop(k), LIMITS.cacheIdleMs);
    if (c.timer.unref) c.timer.unref();
    _textCache.set(k, c);
    _textCacheTotal += text.length;
}

/** fn(text, absStart) is called per decoded chunk; return false to stop. */
async function _eachText(m, security, fn) {
    const k = _cacheKey(m);
    const c = _textCacheGet(k, security);
    if (c) { fn(c.text, 0); return; }
    const keep = (m.size || 0) <= LIMITS.textCacheMemberMax;
    const parts = keep ? [] : null;
    let pos = 0, stopped = false;
    for await (const s of _textChunks(m, security)) {
        if (parts) parts.push(s);
        const r = fn(s, pos);
        pos += s.length;
        if (r === false) { stopped = true; break; }
    }
    if (parts && !stopped) _textCachePut(k, parts.join(''), m.encrypted);
}

async function _sliceChars(m, start, end, security) {
    const out = [];
    await _eachText(m, security, (t, abs) => {
        const a = Math.max(start, abs), b = Math.min(end, abs + t.length);
        if (b > a) out.push(t.slice(a - abs, b - abs));
        return abs + t.length < end;
    });
    return out.join('');
}

// ── scanning ──────────────────────────────────────────────────────────────

function _linePreview(win, idx, end, nls, k) {
    const ls = k > 0 ? nls[k - 1] + 1 : 0;
    const le = k < nls.length ? nls[k] : win.length;
    const a = Math.max(ls, idx - 90), b = Math.min(Math.max(le, end), end + 90);
    return (a > ls ? '\u2026' : '') + win.slice(a, b).replace(/\s+/g, ' ').trim() + (b < le ? '\u2026' : '');
}

/**
 * Stream a text member once, running every matcher over each window.
 * The window is (tail of the previous window) + (new chunk); a match is
 * accepted only if it reaches into the new chunk and does not touch the
 * window's end (a boundary look-ahead at end-of-buffer is meaningless —
 * "1.2.3.4" at a chunk edge might really be "1.2.3.45"). The final tail is
 * flushed with end-of-text treated as real.
 */
async function _scanText(m, matchers, security, deadline) {
    const hits = matchers.map(() => []);
    const seen = matchers.map(() => new Set());
    const CARRY = Math.max(4096, ...matchers.map(mt => mt.len * 12));
    let carry = '', consumed = 0, lineBase = 1, lastNlAbs = -1;
    let timedOut = false;

    const run = (win, cl, final) => {
        const nls = [];
        for (let i = win.indexOf('\n'); i !== -1; i = win.indexOf('\n', i + 1)) nls.push(i);
        for (let vi = 0; vi < matchers.length; vi++) {
            if (hits[vi].length >= LIMITS.maxHitsPerValuePerMember) continue;
            const re = matchers[vi].re;
            re.lastIndex = 0;
            let mm;
            while ((mm = re.exec(win)) !== null) {
                if (!mm[0].length) { re.lastIndex++; continue; }
                const end = mm.index + mm[0].length;
                if (end <= cl) continue;
                if (!final && end >= win.length) continue;
                const abs = consumed + mm.index;
                if (seen[vi].has(abs)) continue;
                seen[vi].add(abs);
                const k = _countBefore(nls, mm.index);
                const col = k > 0 ? mm.index - (nls[k - 1] + 1) : abs - (lastNlAbs + 1);
                hits[vi].push({ offset: abs, line: lineBase + k, col, matched: mm[0], preview: _linePreview(win, mm.index, end, nls, k) });
                if (hits[vi].length >= LIMITS.maxHitsPerValuePerMember) break;
            }
        }
        return nls;
    };

    await _eachText(m, security, (t) => {
        const win = carry + t;
        const nls = run(win, carry.length, false);
        const keep = Math.min(win.length, CARRY);
        const cut = win.length - keep;
        const kc = _countBefore(nls, cut);
        lineBase += kc;
        if (kc > 0) lastNlAbs = consumed + nls[kc - 1];
        consumed += cut;
        carry = win.slice(cut);
        if (deadline && Date.now() > deadline) { timedOut = true; return false; }
        return true;
    });
    if (carry && !timedOut) run(carry, 0, true);
    return { hits, timedOut };
}

// PDF: one open document per member, closed after a minute idle.
const _pdfCache = new Map();   // key -> { doc, pages, encrypted, timer }
let _mupdf = null;
async function _getMupdf() {
    if (!_mupdf) _mupdf = await import('mupdf');
    return _mupdf;
}

function _pdfDrop(k) {
    const c = _pdfCache.get(k);
    if (!c) return;
    _pdfCache.delete(k);
    if (c.timer) clearTimeout(c.timer);
    try { c.doc.destroy && c.doc.destroy(); } catch (_) {}
}

async function _pdfDoc(m, security) {
    const k = _cacheKey(m);
    let c = _pdfCache.get(k);
    if (c && c.encrypted && !_unlocked(security)) { _pdfDrop(k); throw lockedError(); }
    if (!c) {
        if ((m.size || 0) > LIMITS.pdfMaxBytes) throw new Error('This PDF is too large to search inside VIPER.');
        const bytes = await _memberBytes(m, security);
        const mupdf = await _getMupdf();
        const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
        const pages = [];
        const n = doc.countPages();
        for (let i = 0; i < n; i++) {
            const pg = doc.loadPage(i);
            try { pages.push(pg.toStructuredText().asText()); }
            finally { try { pg.destroy && pg.destroy(); } catch (_) {} }
        }
        c = { doc, pages, encrypted: !!m.encrypted, timer: null };
        _pdfCache.set(k, c);
    }
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => _pdfDrop(k), LIMITS.cacheIdleMs);
    if (c.timer.unref) c.timer.unref();
    return c;
}

async function _scanPdf(m, matchers, security) {
    const c = await _pdfDoc(m, security);
    const hits = matchers.map(() => []);
    c.pages.forEach((text, pi) => {
        const nls = [];
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nls.push(i);
        for (let vi = 0; vi < matchers.length; vi++) {
            const re = matchers[vi].re;
            re.lastIndex = 0;
            let mm;
            while ((mm = re.exec(text)) !== null) {
                if (!mm[0].length) { re.lastIndex++; continue; }
                if (hits[vi].length >= LIMITS.maxHitsPerValuePerMember) break;
                const k = _countBefore(nls, mm.index);
                const col = k > 0 ? mm.index - (nls[k - 1] + 1) : mm.index;
                hits[vi].push({
                    page: pi + 1, pageCount: c.pages.length, offset: mm.index, line: k + 1, col,
                    matched: mm[0], preview: _linePreview(text, mm.index, mm.index + mm[0].length, nls, k),
                });
            }
        }
    });
    return { hits, timedOut: false };
}

// ── locate ────────────────────────────────────────────────────────────────

// ── phone databases (SQLite) ───────────────────────────────────────────────
// A Cellebrite extraction keeps texts, calls and contacts in SQLite files.
// Their words ARE in the file, but scattered across binary pages, so they
// are proved by RECORD instead: the table and row a value sits in, with
// every column of that row shown raw. The database is always opened from a
// private temporary COPY — SQLite may touch a database's side files even
// when it is opened read-only, and the original must stay byte-identical.

const _sqlCache = new Map();   // key -> { db, dir, encrypted, timer }
let _Sqlite = null;

function _sqliteLib() {
    if (!_Sqlite) _Sqlite = require('better-sqlite3');
    return _Sqlite;
}

function _sqlDrop(k) {
    const c = _sqlCache.get(k);
    if (!c) return;
    clearTimeout(c.timer);
    try { c.db.close(); } catch (_) {}
    try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (_) {}
    _sqlCache.delete(k);
}

function _qi(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

async function _sqliteOpen(m, security) {
    const k = _cacheKey(m);
    const hit = _sqlCache.get(k);
    if (hit) {
        clearTimeout(hit.timer);
        hit.timer = setTimeout(() => _sqlDrop(k), LIMITS.cacheIdleMs);
        if (hit.timer.unref) hit.timer.unref();
        return hit.db;
    }
    if (!m.diskPath) throw new Error('A database inside a ZIP cannot be opened here.');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-srcdb-'));
    const dest = path.join(dir, baseName(m.diskPath));
    let encrypted = false;
    try {
        const Sqlite = _sqliteLib();
        const notDb = () => new Error('This file is not a readable database (it may be encrypted by the phone).');
        let db;
        const plain = _readDiskPlain(m.diskPath, security);
        if (plain) {
            // Encrypted by Field Security: opened from memory only, never
            // written out decrypted.
            encrypted = true;
            if (plain.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw notDb();
            db = new Sqlite(plain);
        } else {
            fs.copyFileSync(m.diskPath, dest);
            // The write-ahead log holds rows not yet folded into the main
            // file; without it recent messages would be missing.
            const wal = m.diskPath + '-wal';
            if (fs.existsSync(wal) && !ez.isEncryptedFile(wal, security)) fs.copyFileSync(wal, dest + '-wal');
            const head = Buffer.alloc(16);
            const fd = fs.openSync(dest, 'r');
            try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
            if (head.toString('latin1') !== 'SQLite format 3\u0000') throw notDb();
            db = new Sqlite(dest, { readonly: true, fileMustExist: true });
        }
        const timer = setTimeout(() => _sqlDrop(k), LIMITS.cacheIdleMs);
        if (timer.unref) timer.unref();
        _sqlCache.set(k, { db, dir, encrypted, timer });
        return db;
    } catch (e) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        throw e;
    }
}

function _sqliteTables(db) {
    const out = [];
    let rows = [];
    try { rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all(); } catch (_) { return out; }
    for (const r of rows) {
        let cols = [];
        try { cols = db.prepare('PRAGMA table_info(' + _qi(r.name) + ')').all(); } catch (_) { continue; }
        if (!cols.length) continue;
        out.push({ name: r.name, cols: cols.map(c => ({ name: c.name, type: String(c.type || '') })) });
    }
    return out;
}

function _cellText(v) {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return null;
    return String(v);
}

function _sqlRowPreview(table, colName, text, idx, len) {
    const a = Math.max(0, idx - 70), b = Math.min(text.length, idx + len + 70);
    return table + ' \u203A ' + colName + ': ' + (a > 0 ? '\u2026' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '\u2026' : '');
}

function _matchRow(table, row, rowid, cols, matchers, hits) {
    for (let vi = 0; vi < matchers.length; vi++) {
        if (hits[vi].length >= LIMITS.maxHitsPerValuePerMember) continue;
        const re = matchers[vi].re;
        for (let ci = 0; ci < cols.length; ci++) {
            const t = _cellText(row[cols[ci].name]);
            if (t === null || !t) continue;
            re.lastIndex = 0;
            const mm = re.exec(t);
            if (!mm || !mm[0].length) continue;
            hits[vi].push({
                offset: ci, line: rowid, col: mm.index, matched: mm[0],
                table, rowid, column: cols[ci].name,
                preview: _sqlRowPreview(table, cols[ci].name, t, mm.index, mm[0].length),
            });
            break;   // one hit per value per row
        }
    }
}

function _prefilterToken(v) {
    const toks = String(v).toLowerCase().match(/[\p{L}\p{N}_@.+-]+/gu) || [];
    toks.sort((a, b) => b.length - a.length);
    return toks[0] || '';
}

/**
 * Search one database. With query.record = { table, rowid } only that row
 * is read (the reader knows exactly where each text came from). Otherwise
 * every table is searched, prefiltered in SQL and confirmed with the same
 * matcher the text search uses.
 */
async function _scanSqlite(m, matchers, security, deadline, record) {
    const hits = matchers.map(() => []);
    const db = await _sqliteOpen(m, security);
    const tables = _sqliteTables(db);
    if (record && record.table && record.rowid != null && record.rowid !== '') {
        const t = tables.find(x => x.name === String(record.table));
        if (t) {
            let row = null;
            try { row = db.prepare('SELECT rowid AS "__viper_rowid", * FROM ' + _qi(t.name) + ' WHERE rowid = ?').get(record.rowid); } catch (_) { row = null; }
            if (row) _matchRow(t.name, row, row.__viper_rowid, t.cols, matchers, hits);
        }
        if (hits.some(h => h.length)) return { hits, timedOut: false };
    }
    let timedOut = false;
    for (const t of tables) {
        if (deadline && Date.now() > deadline) { timedOut = true; break; }
        for (let vi = 0; vi < matchers.length; vi++) {
            if (hits[vi].length >= LIMITS.maxHitsPerValuePerMember) continue;
            const tok = _prefilterToken(matchers[vi].value);
            if (!tok) continue;
            const where = t.cols.map(c => 'instr(lower(CAST(' + _qi(c.name) + ' AS TEXT)), ?) > 0').join(' OR ');
            let rows;
            try {
                rows = db.prepare('SELECT rowid AS "__viper_rowid", * FROM ' + _qi(t.name) + ' WHERE ' + where + ' LIMIT ' + LIMITS.maxHitsPerValuePerMember)
                    .all(...t.cols.map(() => tok));
            } catch (_) { break; }   // e.g. a WITHOUT ROWID table
            const only = matchers.map((mt, j) => (j === vi ? mt : { re: /(?!)/g }));
            for (const row of rows) _matchRow(t.name, row, row.__viper_rowid, t.cols, only, hits);
        }
    }
    return { hits, timedOut };
}

async function _viewSqlite(m, hit, query, security) {
    const db = await _sqliteOpen(m, security);
    const t = _sqliteTables(db).find(x => x.name === String(hit.table));
    if (!t) throw new Error('That table is no longer in the database.');
    const row = db.prepare('SELECT rowid AS "__viper_rowid", * FROM ' + _qi(t.name) + ' WHERE rowid = ?').get(hit.rowid);
    if (!row) throw new Error('That row is no longer in the database.');
    const values = cleanValues(query && query.values);
    const MAXC = 4000;
    const columns = t.cols.map(c => {
        const raw = row[c.name];
        let text, binary = false;
        if (raw === null || raw === undefined) text = null;
        else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) { binary = true; text = '<binary data, ' + raw.length.toLocaleString() + ' bytes>'; }
        else text = String(raw);
        const col = { name: c.name, type: c.type, value: text, binary };
        if (text !== null && !binary) {
            if (c.name === hit.column) {
                const mt = buildMatcher(hit.matched, false);
                mt.re.lastIndex = 0;
                const mm = mt.re.exec(text);
                col.target = true;
                if (mm) { col.hlStart = mm.index; col.hlEnd = mm.index + mm[0].length; }
            } else {
                for (const v of values) {
                    if (v.index === hit.valueIndex) continue;
                    const mt = buildMatcher(v.text, false);
                    mt.re.lastIndex = 0;
                    if (mt.re.test(text)) { col.corroborate = true; col.valueIndex = v.index; break; }
                }
            }
            if (text.length > MAXC) {
                const a = col.hlStart != null ? Math.max(0, col.hlStart - MAXC / 2) : 0;
                col.value = text.slice(a, a + MAXC);
                col.cutLeft = a > 0;
                col.cutRight = a + MAXC < text.length;
                if (col.hlStart != null) { col.hlStart -= a; col.hlEnd -= a; }
            }
        }
        return col;
    });
    return { format: 'record', table: t.name, rowid: row.__viper_rowid, columns };
}

function _orderMembers(members, hints) {
    const hs = (Array.isArray(hints) ? hints : (hints ? [hints] : []))
        .map(h => String(h || '').toLowerCase().trim()).filter(Boolean);
    const hinted = [], rest = [];
    const rank = m => {
        const b = baseName(m.entry || m.label).toLowerCase();
        for (let i = 0; i < hs.length; i++) {
            const h = hs[i];
            if (b === h || b.startsWith(h.replace(/\.[a-z0-9]+$/, '') + '-') || (h.startsWith('*') && b.endsWith(h.slice(1)))) return i;
            if (!/\./.test(h) && b.includes(h)) return i;
        }
        return -1;
    };
    members.forEach((m, i) => {
        const r = rank(m);
        if (r >= 0) hinted.push({ m, r, i }); else rest.push({ m, i });
    });
    hinted.sort((a, b) => a.r - b.r || a.i - b.i);
    // Unhinted: text before PDF, small before large — the cheap places first.
    rest.sort((a, b) => (a.m.kind === 'pdf') - (b.m.kind === 'pdf') || (a.m.size || 0) - (b.m.size || 0));
    return { hinted: hinted.map(x => x.m), rest: rest.map(x => x.m), hintsGiven: hs.length > 0 };
}

function _proximity(a, b, format) {
    if (format === 'sqlite') return (a.table === b.table && a.rowid === b.rowid) ? 2 : 0;
    if (format === 'pdf') {
        if (a.page !== b.page) return 0;
        return Math.abs(a.line - b.line) <= 1 ? 2 : 1;
    }
    if (format === 'html') {
        const d = Math.abs(a.offset - b.offset);
        if (a.line === b.line && d <= 600) return 2;
        return d <= 4000 ? 1 : 0;
    }
    if (a.line === b.line) return 2;
    return Math.abs(a.line - b.line) <= 3 ? 1 : 0;
}

/** A record pointer applies to the database it names (or to any, if none). */
function _recordFor(record, m) {
    if (!record || typeof record !== 'object' || !record.table) return null;
    if (record.member && baseName(m.diskPath || m.label).toLowerCase() !== String(record.member).toLowerCase()) return null;
    return { table: String(record.table), rowid: record.rowid };
}

/**
 * query = { values: [primary, ...corroborating], memberHints: ['records.html'], maxHits,
 *           record?: { member, table, rowid } — the database row a value came from }
 * → { ok, found, usedValueIndex, primaryFound, hits:[…], totalHits,
 *     searchedMembers, skippedMembers, incomplete, sourceKind, containerName }
 */
async function locate(spec, query, security, opts) {
    query = query || {};
    opts = opts || {};
    const values = cleanValues(query.values);
    if (!values.length) return { ok: false, error: 'There is no value to look for.' };
    const lm = opts.listed || await listMembers(spec, security);
    if (!lm.ok) return lm;
    if (!lm.members.length) {
        return { ok: true, found: false, searchedMembers: [], skippedMembers: [], sourceKind: lm.sourceKind,
            containerName: lm.containerName, note: 'The original contains no text files, web pages, spreadsheets or PDFs that VIPER can search.' };
    }
    const order = _orderMembers(lm.members, query.memberHints);
    const deadline = opts.deadline || (Date.now() + LIMITS.searchBudgetMs);
    const found = [];
    const searched = [], skipped = [];
    let incomplete = false;
    const memberIndex = new Map();
    let mi = 0;
    const groups = [order.hinted, order.rest];
    let stopAfterHinted = false;
    for (let gi = 0; gi < groups.length; gi++) {
        if (gi === 1 && stopAfterHinted) break;
        for (const m of groups[gi]) {
            if (Date.now() > deadline) { incomplete = true; break; }
            memberIndex.set(m.key, mi++);
            const matchers = values.map(v => buildMatcher(v.text, m.format === 'html'));
            let res;
            try {
                res = m.format === 'pdf' ? await _scanPdf(m, matchers, security)
                    : m.format === 'sqlite' ? await _scanSqlite(m, matchers, security, deadline, _recordFor(query.record, m))
                    : await _scanText(m, matchers, security, deadline);
            } catch (e) {
                if (e && e.code === 'VIPER_LOCKED') return { ok: false, locked: true, error: e.message };
                skipped.push({ member: m.label, error: (e && e.message) || String(e) });
                continue;
            }
            searched.push(m.label);
            if (res.timedOut) incomplete = true;
            res.hits.forEach((arr, vi) => arr.forEach(h => found.push(Object.assign(h, { vi, m, matcher: matchers[vi] }))));
        }
        if (gi === 0 && order.hinted.length && found.some(h => h.vi === 0)) stopAfterHinted = true;
        if (incomplete) break;
    }

    const base = {
        ok: true, searchedMembers: searched, skippedMembers: skipped, incomplete,
        sourceKind: lm.sourceKind, containerName: lm.containerName,
        values: values.map(v => ({ text: v.text, index: v.index })),
    };
    if (!found.length) return Object.assign(base, { found: false });

    const scoreHits = (vi0) => {
        const arr = found.filter(h => h.vi === vi0);
        for (const h of arr) {
            h.score = 0;
            h.corroboratedBy = [];
            for (let vi = 0; vi < values.length; vi++) {
                if (vi === vi0) continue;
                let best = 0;
                for (const o of found) {
                    if (o.vi !== vi || o.m.key !== h.m.key) continue;
                    const p = _proximity(h, o, h.m.format);
                    if (p > best) best = p;
                    if (best === 2) break;
                }
                if (best > 0) { h.score += best; h.corroboratedBy.push(values[vi].index); }
            }
            h.matchKind = classify(h.matched, h.matcher.value, h.m.format === 'html');
        }
        return arr;
    };

    // The displayed value itself, when it is anywhere in the original.
    let usedVi = 0;
    let primary = found.some(h => h.vi === 0) ? scoreHits(0) : [];
    if (!primary.length) {
        // The displayed value is NOT in the original. Point at a related record
        // only when it is genuinely the same record: a lone sender name or date
        // sits on hundreds of rows and would give a confident-looking line
        // number that means nothing. With two or more related details, a hit
        // must be backed by at least one other; with one, it stands alone.
        const needed = values.length - 1 >= 2 ? 1 : 0;
        for (let vi = 1; vi < values.length && !primary.length; vi++) {
            if (!found.some(h => h.vi === vi)) continue;
            const backed = scoreHits(vi).filter(h => h.corroboratedBy.length >= needed);
            if (backed.length) { usedVi = vi; primary = backed; }
        }
        if (!primary.length) return Object.assign(base, { found: false, relatedOnly: true });
    }
    primary.sort((a, b) =>
        b.score - a.score ||
        KIND_RANK[a.matchKind] - KIND_RANK[b.matchKind] ||
        memberIndex.get(a.m.key) - memberIndex.get(b.m.key) ||
        (a.page || 0) - (b.page || 0) ||
        a.offset - b.offset);
    const max = Math.max(1, Math.min(LIMITS.maxHitsReturned, query.maxHits || LIMITS.maxHitsReturned));
    const hits = primary.slice(0, max).map(h => ({
        memberKey: h.m.key, member: h.m.label, format: h.m.format,
        valueIndex: values[usedVi].index, offset: h.offset, line: h.line, col: h.col,
        page: h.page || null, pageCount: h.pageCount || null,
        matched: h.matched, matchKind: h.matchKind, valueTruncated: h.matcher.truncated,
        score: h.score, corroboratedBy: h.corroboratedBy, preview: h.preview,
        table: h.table || undefined, rowid: h.rowid != null ? h.rowid : undefined, column: h.column || undefined,
    }));
    return Object.assign(base, {
        found: true, usedValueIndex: values[usedVi].index, primaryFound: usedVi === 0,
        totalHits: primary.length, hits,
    });
}

// ── view ──────────────────────────────────────────────────────────────────

function _windowLine(text, col, len, isTarget) {
    const W = LIMITS.lineWindowChars;
    if (text.length <= W * 2 + 200) return { text, shift: 0, cutLeft: false, cutRight: false };
    if (!isTarget) return { text: text.slice(0, W), shift: 0, cutLeft: false, cutRight: true };
    const a = Math.max(0, col - W), b = Math.min(text.length, col + len + W);
    return { text: text.slice(a, b), shift: a, cutLeft: a > 0, cutRight: b < text.length };
}

function splitCsvLine(s) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) {
            if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return { cells: out, balanced: !q };
}

async function _textContext(m, hit, security, ctxLines) {
    const S = LIMITS.sliceChars;
    const start = Math.max(0, hit.offset - S);
    const wantEnd = hit.offset + String(hit.matched || '').length + S;
    const slice = await _sliceChars(m, start, wantEnd, security);
    const atEof = start + slice.length < wantEnd;   // the slice ran out of file
    const rel = hit.offset - start;
    const nls = [];
    for (let i = slice.indexOf('\n'); i !== -1; i = slice.indexOf('\n', i + 1)) nls.push(i);
    const k = _countBefore(nls, rel);
    const lineStart = j => (j > 0 ? nls[j - 1] + 1 : 0);
    const lineEnd = j => (j < nls.length ? nls[j] : slice.length);
    const first = Math.max(0, k - ctxLines), last = Math.min(nls.length, k + ctxLines);
    const lines = [];
    let targetFull = null;
    for (let j = first; j <= last; j++) {
        let raw = slice.slice(lineStart(j), lineEnd(j)).replace(/\r$/, '');
        const partialLeft = j === 0 && start > 0;
        const partialRight = j === nls.length && lineEnd(j) === slice.length && !atEof;
        const isT = j === k;
        if (!isT && j === nls.length && atEof && !raw) continue;   // the empty "line" after a final newline
        if (isT) targetFull = { text: raw, complete: !partialLeft && !partialRight };
        const colInLine = isT ? rel - lineStart(j) : 0;
        const w = _windowLine(raw, colInLine, String(hit.matched || '').length, isT);
        const row = { n: hit.line - (k - j), text: w.text, cutLeft: w.cutLeft || partialLeft, cutRight: w.cutRight || partialRight };
        if (isT) {
            row.target = true;
            row.hlStart = colInLine - w.shift;
            row.hlEnd = Math.min(w.text.length, row.hlStart + String(hit.matched || '').length);
            row.hlContinues = row.hlStart + String(hit.matched || '').length > w.text.length;
        }
        lines.push(row);
    }
    return { lines, targetFull };
}

async function _csvHeaderBefore(m, hit, security) {
    let pos = 0, lineNo = 1, cur = '', curStart = 0;
    let header = null, firstLine = null, pendingHeader = false;
    const finalize = () => {
        const text = cur.replace(/\r$/, '');
        const row = { n: lineNo, text };
        if (lineNo < hit.line) {
            if (!firstLine) firstLine = row;
            if (pendingHeader && text.trim()) { header = row; pendingHeader = false; }
            if (/^\s*"?={3,}/.test(text)) { pendingHeader = true; header = null; }
        }
        lineNo++;
        cur = '';
    };
    await _eachText(m, security, (t, abs) => {
        let i = 0;
        while (i < t.length) {
            if (lineNo >= hit.line) return false;
            const nl = t.indexOf('\n', i);
            const piece = nl === -1 ? t.slice(i) : t.slice(i, nl);
            if (cur.length < 20000) cur += piece.slice(0, 20000 - cur.length);
            if (nl === -1) break;
            curStart = abs + nl + 1;
            finalize();
            i = nl + 1;
        }
        pos = abs + t.length;
        return lineNo < hit.line;
    });
    void pos; void curStart;
    return header || (firstLine && firstLine.n < hit.line ? firstLine : null);
}

function _cellsFor(header, targetFull, matched) {
    if (!header || !targetFull || !targetFull.complete || targetFull.text.length > 20000) return null;
    const h = splitCsvLine(header.text), r = splitCsvLine(targetFull.text);
    if (!h.balanced || !r.balanced || h.cells.length !== r.cells.length || h.cells.length < 2) return null;
    const needle = compact(String(matched || '')).toLowerCase();
    return h.cells.map((name, i) => ({
        name: name.trim(), value: r.cells[i],
        hit: !!needle && compact(r.cells[i]).toLowerCase().includes(needle),
    }));
}

function sanitizeHtml(s) {
    return String(s)
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<\/?script\b[^>]*>/gi, '')
        .replace(/<(iframe|object|embed|frame|frameset|applet)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?(iframe|object|embed|frame|frameset|applet|link|meta|base|form|input|button|textarea|select|html|head|body|title)\b[^>]*>/gi, '')
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|src|action|formaction|xlink:href|srcset|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'data-viper-$1=$2')
        .replace(/javascript:/gi, 'blocked:');
}

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const HTML_EXTRA_CSS =
    '#viper-src-hit{background:#ffe600!important;color:#000!important;outline:3px solid #ff8a00;border-radius:2px;' +
    'box-shadow:0 0 0 6px rgba(255,138,0,.25);scroll-margin:120px}' +
    '.viper-src-anchor{display:inline-block;min-width:10px}' +
    'img,video,audio,picture,svg image{display:none!important}' +
    '.viper-src-cut{font:12px/1.4 sans-serif;color:#666;background:#f3f3f3;border:1px dashed #bbb;padding:6px 10px;margin:8px 0}' +
    'body{background:#fff;color:#111}';

async function _viewHtml(m, hit, security) {
    const head = await _sliceChars(m, 0, LIMITS.htmlHeadScanChars, security);
    const styles = (head.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) || []).join('\n').slice(0, 200000);
    const W = LIMITS.htmlWindowChars;
    const mlen = String(hit.matched || '').length;
    const s0 = Math.max(0, hit.offset - W);
    let raw = await _sliceChars(m, s0, hit.offset + mlen + W, security);
    let rel = hit.offset - s0;
    let cutTop = false, cutBottom = false;
    if (s0 > 0) {
        const limit = Math.min(rel, Math.floor(raw.length * 0.25));
        const re = /<(div|table|tr|p|li|section|h[1-6])\b/gi;
        re.lastIndex = 0;
        const mm = re.exec(raw);
        let a = (mm && mm.index <= limit) ? mm.index : raw.indexOf('<');
        if (a < 0 || a > rel) a = 0;
        raw = raw.slice(a); rel -= a; cutTop = true;
    }
    if (raw.length > rel + mlen + 10) {
        const b = raw.lastIndexOf('>');
        if (b >= rel + mlen) { if (b + 1 < raw.length) cutBottom = true; raw = raw.slice(0, b + 1); }
    }
    const before = raw.slice(0, rel);
    const inText = before.lastIndexOf('<') <= before.lastIndexOf('>');
    const matchedRaw = raw.slice(rel, rel + mlen);
    let body;
    let marked = false;
    if (inText && matchedRaw && !/[<>]/.test(matchedRaw)) {
        body = before + '<mark id="viper-src-hit">' + matchedRaw + '</mark>' + raw.slice(rel + mlen);
        marked = true;
    } else if (inText) {
        body = before + '<mark id="viper-src-hit" class="viper-src-anchor">\u25B6</mark>' + raw.slice(rel);
        marked = true;
    } else {
        body = raw;
    }
    body = sanitizeHtml(body);
    if (marked && !/id="viper-src-hit"/.test(body)) marked = false;
    const cutNote = '<div class="viper-src-cut">\u2026 part of the original page is not shown here (VIPER shows the section around the match). Use Raw text or Save a copy to see all of it.</div>';
    const doc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + HTML_CSP + '">' +
        sanitizeHtml(styles) + '<style>' + HTML_EXTRA_CSS + '</style></head><body>' +
        (cutTop ? cutNote : '') + body + (cutBottom ? cutNote : '') + '</body></html>';
    const ctx = await _textContext(m, hit, security, LIMITS.rawContextLines);
    return { format: 'html', html: doc, marked, raw: ctx.lines };
}

async function _viewText(m, hit, security) {
    const ctx = await _textContext(m, hit, security, LIMITS.contextLines);
    const out = { format: m.format, lines: ctx.lines };
    if (m.format === 'csv') {
        const header = await _csvHeaderBefore(m, hit, security);
        out.header = header ? { n: header.n, text: _windowLine(header.text, 0, 0, false).text } : null;
        out.cells = _cellsFor(header, ctx.targetFull, hit.matched);
    }
    return out;
}

function _quadBox(q) {
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function _pdfSearchBoxes(page, needle) {
    const n = String(needle || '').replace(/\s+/g, ' ').trim();
    if (!n) return [];
    let res;
    try { res = page.search(n, 500) || []; } catch (_) { return []; }
    return res.map(quads => {
        const boxes = (quads || []).map(_quadBox);
        if (!boxes.length) return null;
        return {
            x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
            x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)),
        };
    }).filter(Boolean);
}

async function _viewPdf(m, hit, query, security) {
    const c = await _pdfDoc(m, security);
    const mupdf = await _getMupdf();
    const pi = Math.max(1, Math.min(c.pages.length, hit.page || 1)) - 1;
    const pageText = c.pages[pi] || '';
    const page = c.doc.loadPage(pi);
    try {
        const bounds = page.getBounds();
        const s = LIMITS.pdfScale;
        const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
        const png = Buffer.from(pix.asPNG());
        const width = pix.getWidth(), height = pix.getHeight();
        try { pix.destroy && pix.destroy(); } catch (_) {}
        const toPx = b => ({
            x: (b.x0 - bounds[0]) * s, y: (b.y0 - bounds[1]) * s,
            w: (b.x1 - b.x0) * s, h: (b.y1 - b.y0) * s,
        });
        const rects = [];
        // The hit itself: which occurrence on the page is it?
        const primaryMatcher = buildMatcher(hit.matched, false);
        const occ = [];
        let mm;
        primaryMatcher.re.lastIndex = 0;
        while ((mm = primaryMatcher.re.exec(pageText)) !== null) {
            if (!mm[0].length) { primaryMatcher.re.lastIndex++; continue; }
            occ.push(mm.index);
        }
        const ordinal = Math.max(0, occ.indexOf(hit.offset));
        const pBoxes = _pdfSearchBoxes(page, hit.matched);
        const exactOrdinal = pBoxes.length === occ.length;
        pBoxes.forEach((b, i) => rects.push(Object.assign(toPx(b), {
            role: (!exactOrdinal || i === ordinal) ? 'hit' : 'also',
        })));
        // Corroborating values on the same page.
        const values = cleanValues(query && query.values);
        const done = new Set([String(hit.matched).toLowerCase()]);
        for (const v of values) {
            if (v.index === hit.valueIndex) continue;
            const mt = buildMatcher(v.text, false);
            mt.re.lastIndex = 0;
            let m2;
            while ((m2 = mt.re.exec(pageText)) !== null) {
                if (!m2[0].length) { mt.re.lastIndex++; continue; }
                const key = m2[0].toLowerCase();
                if (done.has(key)) continue;
                done.add(key);
                _pdfSearchBoxes(page, m2[0]).forEach(b => rects.push(Object.assign(toPx(b), { role: 'corroborate', valueIndex: v.index })));
            }
        }
        const ctx = (() => {
            const lines = pageText.split('\n');
            const k = Math.max(0, (hit.line || 1) - 1);
            const out = [];
            for (let j = Math.max(0, k - LIMITS.contextLines); j <= Math.min(lines.length - 1, k + LIMITS.contextLines); j++) {
                const row = { n: j + 1, text: lines[j] };
                if (j === k) {
                    row.target = true;
                    row.hlStart = hit.col || 0;
                    row.hlEnd = Math.min(lines[j].length, row.hlStart + String(hit.matched).length);
                }
                out.push(row);
            }
            return out;
        })();
        return {
            format: 'pdf', page: pi + 1, pageCount: c.pages.length,
            png: png.toString('base64'), width, height, rects,
            highlightDrawn: rects.some(r => r.role === 'hit'), lines: ctx,
        };
    } finally {
        try { page.destroy && page.destroy(); } catch (_) {}
    }
}

/**
 * Show one hit. The member is re-resolved from the source on disk — a path
 * handed back by the renderer is never trusted on its own.
 */
async function view(spec, hit, query, security) {
    if (!hit || typeof hit.memberKey !== 'string') return { ok: false, error: 'No match was chosen.' };
    const lm = await listMembers(spec, security);
    if (!lm.ok) return lm;
    const m = lm.members.find(x => x.key === hit.memberKey);
    if (!m) return { ok: false, error: 'That file is no longer part of the original.' };
    try {
        let out;
        if (m.format === 'pdf') out = await _viewPdf(m, hit, query, security);
        else if (m.format === 'sqlite') out = await _viewSqlite(m, hit, query, security);
        else if (m.format === 'html') out = await _viewHtml(m, hit, security);
        else out = await _viewText(m, hit, security);
        return Object.assign({ ok: true, member: m.label, memberKey: m.key, line: hit.line, page: hit.page || null }, out);
    } catch (e) {
        if (e && e.code === 'VIPER_LOCKED') return { ok: false, locked: true, error: e.message };
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/** Bytes of one member, for "Save a copy". Text and PDF members only. */
async function memberBytes(spec, memberKey, security) {
    const lm = await listMembers(spec, security);
    if (!lm.ok) return lm;
    const m = lm.members.find(x => x.key === memberKey);
    if (!m) return { ok: false, error: 'That file is no longer part of the original.' };
    try {
        const bytes = await _memberBytes(m, security);
        return { ok: true, bytes, name: baseName(m.entry || m.diskPath || m.label), member: m.label };
    } catch (e) {
        if (e && e.code === 'VIPER_LOCKED') return { ok: false, locked: true, error: e.message };
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

// ── integrity ─────────────────────────────────────────────────────────────

const _hashCache = new Map();

function _sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(file, { highWaterMark: 4 * MB });
        rs.on('data', d => h.update(d));
        rs.on('error', reject);
        rs.on('end', () => resolve(h.digest('hex')));
    });
}

function _sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

/**
 * SHA-256 of the original.
 *   container.sha256       the file exactly as it sits on disk
 *   container.contentSha256 the provider's original bytes — equal to sha256
 *                          for a plain file, the decrypted bytes for a file
 *                          VIPER encrypted at rest (null if that could not
 *                          be computed, e.g. the vault is locked)
 *   member                 one file inside a ZIP (a CyberTip PDF)
 *   folder                 a manifest hash over every file in a folder source
 */
async function hashSource(spec, security) {
    spec = spec || {};
    const p = spec.path;
    if (typeof p !== 'string' || !p || !fs.existsSync(p)) return { ok: false, missing: true, error: 'The original file is not on disk.' };
    const st = fs.statSync(p);
    const extra = Array.isArray(spec.extraPaths) ? spec.extraPaths.filter(x => typeof x === 'string') : [];
    // hashOnly: for a folder source, fingerprint just these files (paths
    // relative to the folder). A phone dump or a Datapilot export can hold
    // gigabytes of pictures VIPER never reads; the index files and the
    // databases it does read are what an examiner needs to see unchanged.
    const only = Array.isArray(spec.hashOnly)
        ? spec.hashOnly.filter(x => typeof x === 'string' && x).map(x => x.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())
        : [];
    let ck = [p, st.size, st.mtimeMs, spec.entry || '', spec.inZip || '', extra.join('|'), only.join('|')].join('\u0001');
    if (!st.isDirectory()) {
        const hit = _hashCache.get(ck);
        if (hit && (!hit.encrypted || _unlocked(security))) return hit.result;
    }

    let result;
    if (st.isDirectory()) {
        const dirs = [p].concat(extra).filter((d, i, a) => a.indexOf(d) === i && fs.existsSync(d) && fs.statSync(d).isDirectory());
        const files = [];
        const onlySet = only.length ? new Set(only) : null;
        if (onlySet) {
            // Go straight to the named files rather than walking: a full
            // phone dump has far more files than the walk limit, and the
            // ones that matter sit deep in it.
            for (const d of dirs) {
                for (const rel of only) {
                    const full = path.join(d, rel);
                    try { if (fs.statSync(full).isFile()) files.push({ full, label: baseName(d) + '/' + rel }); } catch (_) {}
                }
            }
        } else {
            for (const d of dirs) _walk(d, baseName(d), 0, files);
        }
        // Paths in the manifest are relative to the folder itself, so the
        // same export moved to a differently named folder still matches its
        // fingerprint. (Extra part folders keep their own name in front.)
        const mainPrefix = baseName(p) + '/';
        const mainRoot = path.resolve(p) + path.sep;
        for (const f of files) {
            f.rel = path.resolve(f.full).startsWith(mainRoot) && f.label.startsWith(mainPrefix) ? f.label.slice(mainPrefix.length) : f.label;
            try { const s2 = fs.statSync(f.full); f.size = s2.size; f.mtimeMs = s2.mtimeMs; } catch (_) { f.size = 0; f.mtimeMs = 0; }
        }
        // A folder's own timestamp does not change when a file deep inside
        // it is edited, so the cache is keyed on every file's size and time.
        ck += '\u0001' + _sha256Buf(Buffer.from(files.map(f => f.full + '|' + f.size + '|' + f.mtimeMs).join('\n'), 'utf8'));
        const hit = _hashCache.get(ck);
        if (hit) return hit.result;
        const rows = [];
        let total = 0;
        for (const f of files) {
            total += f.size;
            rows.push({ rel: f.rel, size: f.size, sha256: await _sha256File(f.full) });
        }
        rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        const manifest = rows.map(r => r.sha256 + '  ' + r.rel).join('\n');
        result = {
            ok: true, algorithm: 'SHA-256', scope: 'folder',
            folder: { name: baseName(p), fileCount: rows.length, totalBytes: total, manifestSha256: _sha256Buf(Buffer.from(manifest, 'utf8')), files: rows, selected: !!onlySet },
            contentSha256: _sha256Buf(Buffer.from(manifest, 'utf8')),
        };
        _hashCache.set(ck, { result, encrypted: false });
        return result;
    }

    const encrypted = ez.isEncryptedFile(p, security);
    const container = { name: baseName(p), path: p, size: st.size, mtimeMs: st.mtimeMs, encryptedAtRest: encrypted, sha256: await _sha256File(p) };
    if (!encrypted) container.contentSha256 = container.sha256;
    else if (!_unlocked(security)) { container.contentSha256 = null; container.contentNote = 'locked'; }
    else if (st.size > LIMITS.plainHashMaxBytes) { container.contentSha256 = null; container.contentNote = 'too-large'; }
    else container.contentSha256 = _sha256Buf(security.decryptBuffer(fs.readFileSync(p)));
    result = { ok: true, algorithm: 'SHA-256', scope: 'file', container, contentSha256: container.contentSha256 };
    if (spec.entry && /\.zip$/i.test(p)) {
        try {
            const r = await ez.readEvidenceZipEntry(p, spec.entry, spec.inZip || '', security);
            result.member = { name: spec.entry, inZip: spec.inZip || '', size: r.bytes.length, sha256: _sha256Buf(r.bytes) };
        } catch (e) {
            result.member = { name: spec.entry, inZip: spec.inZip || '', error: (e && e.message) || String(e), locked: !!(e && e.code === 'VIPER_LOCKED') };
        }
    }
    if (!(encrypted && !_unlocked(security))) _hashCache.set(ck, { result, encrypted });
    return result;
}

/**
 * Compare today's hash with the fingerprint recorded at import.
 * expected = { sha256 (content), containerSha256?, memberSha256?, scope }
 * → 'match' | 'mismatch' | 'unknown'
 */
function compareIntegrity(expected, actual) {
    if (!expected || !actual || !actual.ok) return 'unknown';
    const want = [], have = [];
    if (expected.sha256) want.push(String(expected.sha256).toLowerCase());
    if (expected.containerSha256) want.push(String(expected.containerSha256).toLowerCase());
    if (actual.contentSha256) have.push(actual.contentSha256);
    if (actual.container && actual.container.sha256) have.push(actual.container.sha256);
    if (actual.folder) have.push(actual.folder.manifestSha256);
    if (expected.memberSha256 && actual.member && actual.member.sha256) {
        return String(expected.memberSha256).toLowerCase() === actual.member.sha256 ? 'match' : 'mismatch';
    }
    // The report was imported from inside a ZIP and the officer has since
    // pointed VIPER at the report on its own (extracted): the file IS the
    // member, so the member's fingerprint is the one to compare against.
    if (expected.memberSha256 && !actual.member) want.push(String(expected.memberSha256).toLowerCase());
    if (!want.length || !have.length) return 'unknown';
    if (want.some(w => have.includes(w))) return 'match';
    // An encrypted file whose plaintext could not be hashed today cannot be
    // called a mismatch just because the on-disk (encrypted) bytes differ.
    if (actual.container && actual.container.encryptedAtRest && !actual.contentSha256) return 'unknown';
    return 'mismatch';
}

/**
 * Cite many items at once (Flag → Evidence report). Each item gets its best
 * location or found:false. Items beyond the time budget are marked
 * notChecked rather than silently dropped.
 * items = [{ id, values, memberHints }]
 */
async function citeBatch(spec, items, security) {
    const list = Array.isArray(items) ? items.slice(0, LIMITS.citeMaxItems) : [];
    const lm = await listMembers(spec, security);
    if (!lm.ok) return Object.assign({ results: list.map(it => ({ id: it && it.id, found: false, notChecked: true })) }, lm);
    const deadline = Date.now() + LIMITS.citeBudgetMs;
    const results = [];
    for (const it of list) {
        if (!it) continue;
        if (Date.now() > deadline) { results.push({ id: it.id, found: false, notChecked: true }); continue; }
        let r;
        try { r = await locate(spec, { values: it.values, memberHints: it.memberHints, record: it.record, maxHits: 1 }, security, { listed: lm, deadline }); }
        catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        if (r && r.locked) return { ok: false, locked: true, error: r.error, results: [] };
        if (!r || !r.ok || !r.found) {
            results.push({ id: it.id, found: false, notChecked: !!(r && r.incomplete) });
            continue;
        }
        const h = r.hits[0];
        results.push({
            id: it.id, found: true, member: h.member, line: h.line, page: h.page,
            matchKind: h.matchKind, usedValueIndex: r.usedValueIndex, primaryFound: r.primaryFound,
            corroborated: h.corroboratedBy.length, totalHits: r.totalHits,
            table: h.table, rowid: h.rowid,
        });
    }
    if (Array.isArray(items) && items.length > list.length) {
        for (const it of items.slice(list.length)) results.push({ id: it && it.id, found: false, notChecked: true });
    }
    return { ok: true, results, containerName: lm.containerName };
}

function _clearCaches() {
    for (const k of Array.from(_textCache.keys())) _textCacheDrop(k);
    for (const k of Array.from(_pdfCache.keys())) _pdfDrop(k);
    for (const k of Array.from(_sqlCache.keys())) _sqlDrop(k);
    _hashCache.clear();
}

/** Drop every decrypted copy held in memory (call when Field Security locks). */
function onLock() {
    for (const [k, c] of Array.from(_textCache.entries())) if (c.encrypted) _textCacheDrop(k);
    for (const [k, c] of Array.from(_pdfCache.entries())) if (c.encrypted) _pdfDrop(k);
    for (const [k, c] of Array.from(_sqlCache.entries())) if (c.encrypted) _sqlDrop(k);
}

module.exports = {
    LIMITS, listMembers, locate, view, memberBytes, hashSource, compareIntegrity, citeBatch, onLock,
    // exposed for tests
    buildMatcher, classify, sanitizeHtml, splitCsvLine, searchKind, formatOf, decodeHtml, isSqliteName,
    _setChunkBytes(n) { _chunkBytes = Math.max(16, n | 0); },
    _clearCaches,
};
