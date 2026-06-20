/**
 * Parser Submission — structural sample builder.
 *
 * Port of the Datapilot Scout `warrant/sample` engine (Rust) to Node.js
 * for VIPER's Electron main process.  Walks a warrant return (folder OR
 * .zip) and produces a shape-only JSON envelope that lets a parser author
 * write a real parser without ever touching the actual evidence.
 *
 *   - Filenames replaced with `file_NNN.ext` (sequential per parent dir).
 *   - Directory components matching PII shapes (email / phone / UUID /
 *     long hex / JWT-shape) are replaced with `<redacted-*>`.
 *     Structural folder names ("Messages", "Attachments", …) kept.
 *   - Per-format `structure` blocks contain only counts, header names,
 *     key paths, format inferences — NEVER raw values.
 *
 * Envelope schema (wire-compatible with Scout v1):
 *   {
 *     schema_version: 1,
 *     scout_version:  "<viper version>",
 *     submitted_at:   "<ISO 8601 UTC>",
 *     provider_hint:  "T-Mobile CDR",
 *     submitter_email:"jdoe@agency.gov",
 *     submitter_notes:"...",
 *     agency_name:    "...",
 *     license_key_last4:"",
 *     root_summary:   { total_files, total_bytes, max_depth, truncated_files,
 *                       format_counts: { json: 12, html: 3, ... } },
 *     tree: [ { path, size, ext, format, structure }, ... ]
 *   }
 */

const fs = require('fs');
const path = require('path');

// ─── Limits & knobs (mirror Scout) ─────────────────────────────────────────

const SCHEMA_VERSION = 1;
const PER_FILE_BUDGET_BYTES = 64 * 1024 * 1024;     // 64 MB
const MAX_FILES = 50_000;
const MAX_STRUCTURE_DEPTH = 32;
const MAX_NODES_PER_FILE = 100_000;
const ENVELOPE_SOFT_CAP_BYTES = 8 * 1024 * 1024;    // 8 MB
const PEEK_BYTES = 4096;

// ─── Path sanitization ─────────────────────────────────────────────────────

const RE_EMAIL  = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_PHONE  = /^[+()\d\s.-]{7,}$/;
const RE_UUID   = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_HEX_ID = /^[0-9a-fA-F]{16,}$/;
const RE_JWT    = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/;
const RE_BIG_NUM = /^\d{10,}$/;

// Structural folder names we always keep (case-insensitive match).
const STRUCTURAL_NAMES = new Set([
    'messages', 'message', 'inbox', 'sent', 'drafts', 'archive', 'attachments',
    'media', 'photos', 'videos', 'audio', 'voicemail', 'calls', 'sms', 'mms',
    'rcs', 'chats', 'chat', 'groups', 'contacts', 'accounts', 'account',
    'profile', 'profiles', 'users', 'user', 'servers', 'guilds', 'channels',
    'devices', 'sessions', 'logins', 'login', 'activity', 'events', 'log',
    'logs', 'billing', 'subscriptions', 'orders', 'transactions',
    'preferences', 'settings', 'metadata', 'headers', 'history', 'cookies',
    'reports', 'report', 'report_data', 'export', 'exports', 'data',
    'connections', 'friends', 'followers', 'following', 'likes', 'reactions',
    'analytics', 'tns', 'reporting', 'modeling', 'dsar', 'gdpr', 'ccpa',
    'request', 'requests', 'response', 'responses', 'production',
    'evidence', 'warrant', 'warrants', 'subpoena', 'subpoenas',
    'apps', 'wifi', 'bluetooth', 'locations', 'gps', 'browser', 'web',
]);

function sanitizeDirComponent(component) {
    if (!component) return component;
    const lower = component.toLowerCase();
    if (STRUCTURAL_NAMES.has(lower)) return component;
    if (RE_EMAIL.test(component)) return '<redacted-email>';
    if (RE_UUID.test(component)) return '<redacted-uuid>';
    if (RE_JWT.test(component)) return '<redacted-token>';
    if (RE_HEX_ID.test(component)) return '<redacted-hexid>';
    if (RE_BIG_NUM.test(component) && component.length >= 10) return '<redacted-id>';
    // Phone-shaped folder (must contain at least one digit)
    if (RE_PHONE.test(component) && /\d/.test(component) && component.replace(/\D/g, '').length >= 7) {
        return '<redacted-phone>';
    }
    return component;
}

class PathSanitizer {
    constructor() {
        // Map dir-path -> counter so files get sequential numbering per parent.
        this._counters = new Map();
    }

    sanitize(relPath) {
        const parts = relPath.split(/[\\/]+/).filter(Boolean);
        if (parts.length === 0) return '';
        const fileName = parts.pop();
        const dirs = parts.map(sanitizeDirComponent);
        const ext = (path.extname(fileName) || '').replace(/^\./, '').toLowerCase();
        const dirKey = dirs.join('/') + '||' + ext;
        const next = (this._counters.get(dirKey) || 0) + 1;
        this._counters.set(dirKey, next);
        const newName = ext ? `file_${next}.${ext}` : `file_${next}`;
        return [...dirs, newName].join('/');
    }
}

// ─── Format detection ──────────────────────────────────────────────────────

const FORMAT_BY_EXT = {
    json: 'json', ndjson: 'json', jsonl: 'json',
    html: 'html', htm: 'html', xhtml: 'html',
    csv: 'csv',  tsv: 'tsv',
    mbox: 'mbox', mboxrd: 'mbox', mbx: 'mbox',
    eml: 'eml',  msg: 'eml',
    pdf: 'pdf',
    xml: 'xml',
    txt: 'text', log: 'text', md: 'text',
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
    tiff: 'image', tif: 'image', bmp: 'image', heic: 'image', heif: 'image',
    svg: 'image', ico: 'image', avif: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', mkv: 'video', avi: 'video',
    wmv: 'video', webm: 'video', flv: 'video', '3gp': 'video', '3g2': 'video',
    mpg: 'video', mpeg: 'video',
    mp3: 'audio', m4a: 'audio', wav: 'audio', aac: 'audio', ogg: 'audio',
    opus: 'audio', flac: 'audio', wma: 'audio', amr: 'audio',
    xlsx: 'excel', xlsm: 'excel', xlsb: 'excel', xls: 'excel', ods: 'excel',
    docx: 'word', doc: 'word', odt: 'word', rtf: 'word',
    pptx: 'powerpoint', ppt: 'powerpoint', odp: 'powerpoint',
    zip: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive',
    gz: 'archive', bz2: 'archive', xz: 'archive', tgz: 'archive',
    db: 'binary', sqlite: 'binary', sqlite3: 'binary', dat: 'binary',
};

function sniffFormat(peek) {
    if (!peek || peek.length === 0) return 'binary';
    // PDF
    if (peek.length >= 5 && peek.slice(0, 5).toString('ascii') === '%PDF-') return 'pdf';
    // Common image / archive magic
    if (peek[0] === 0xFF && peek[1] === 0xD8 && peek[2] === 0xFF) return 'image'; // JPEG
    if (peek[0] === 0x89 && peek[1] === 0x50 && peek[2] === 0x4E && peek[3] === 0x47) return 'image'; // PNG
    if (peek[0] === 0x47 && peek[1] === 0x49 && peek[2] === 0x46) return 'image'; // GIF
    if (peek[0] === 0x50 && peek[1] === 0x4B && (peek[2] === 0x03 || peek[2] === 0x05)) return 'archive';
    if (peek[0] === 0x37 && peek[1] === 0x7A && peek[2] === 0xBC && peek[3] === 0xAF) return 'archive'; // 7z
    if (peek[0] === 0x52 && peek[1] === 0x61 && peek[2] === 0x72) return 'archive'; // RAR
    // BOM strip
    let head = peek;
    if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) head = head.slice(3);
    // Skip ASCII whitespace
    let i = 0;
    while (i < head.length && head[i] <= 0x20) i++;
    const trimmed = head.slice(i, i + 128).toString('utf8', 0, Math.min(128, head.length - i));
    if (/^<!DOCTYPE html|^<html|^<HTML/i.test(trimmed)) return 'html';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    if (/^From [^@\s]+@/.test(trimmed)) return 'mbox';
    if (/^<\?xml/i.test(trimmed)) return 'xml';
    // Otherwise: printable ratio
    let printable = 0, total = 0;
    const sample = peek.slice(0, Math.min(peek.length, 1024));
    for (const b of sample) {
        total++;
        if ((b >= 0x20 && b < 0x7F) || b === 0x09 || b === 0x0A || b === 0x0D) printable++;
    }
    if (total > 0 && printable / total > 0.85) return 'text';
    return 'binary';
}

function detectFormat(relPath, peek) {
    const ext = path.extname(relPath).replace(/^\./, '').toLowerCase();
    if (FORMAT_BY_EXT[ext]) return FORMAT_BY_EXT[ext];
    return sniffFormat(peek || Buffer.alloc(0));
}

// ─── Value-format inference (for JSON leaf values) ─────────────────────────

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const RE_EPOCH_S  = /^1[0-9]{9}$/;
const RE_EPOCH_MS = /^1[0-9]{12}$/;
const RE_URL      = /^https?:\/\/\S+$/i;
const RE_IPV4     = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const RE_IPV6     = /^[0-9a-fA-F:]{2,}$/;

function inferValueFormat(v) {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') {
        if (Number.isInteger(v)) {
            if (v > 1_000_000_000 && v < 4_000_000_000) return 'epoch_s';
            if (v > 1_000_000_000_000 && v < 4_000_000_000_000) return 'epoch_ms';
            return 'int';
        }
        return 'float';
    }
    if (typeof v === 'string') {
        if (!v) return 'string_empty';
        if (RE_ISO_DATE.test(v))  return 'iso_datetime';
        if (RE_EPOCH_MS.test(v))  return 'epoch_ms_str';
        if (RE_EPOCH_S.test(v))   return 'epoch_s_str';
        if (RE_URL.test(v))       return 'url';
        if (RE_EMAIL.test(v))     return 'email';
        if (RE_UUID.test(v))      return 'uuid';
        if (RE_JWT.test(v))       return 'jwt';
        if (RE_IPV4.test(v))      return 'ipv4';
        if (v.length > 5 && RE_IPV6.test(v) && v.includes(':')) return 'ipv6';
        if (RE_PHONE.test(v) && /\d/.test(v) && v.replace(/\D/g,'').length >= 7) return 'phone';
        if (RE_HEX_ID.test(v))    return 'hex_id';
        if (/^\d+$/.test(v))      return 'int_str';
        return 'string';
    }
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return 'object';
    return 'unknown';
}

// ─── Per-format inspectors ─────────────────────────────────────────────────

/**
 * JSON: walk and record key paths + leaf-value formats.  No values captured.
 * Supports plain JSON and NDJSON/JSONL (one object per line).
 */
function inspectJson(text) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let parsed;
    let isJsonl = false;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Try JSONL
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length >= 2) {
            const parsedLines = [];
            for (const line of lines.slice(0, 200)) {
                try { parsedLines.push(JSON.parse(line)); } catch { /* skip */ }
            }
            if (parsedLines.length > 0) { parsed = parsedLines; isJsonl = true; }
        }
    }
    if (parsed === undefined) {
        return { type: 'invalid_json', truncated: false };
    }

    const keyPaths = new Map();  // path -> { types: Set, count }
    let nodeCount = 0;
    let truncated = false;
    let maxDepth = 0;

    function walk(v, pathStr, depth) {
        if (nodeCount >= MAX_NODES_PER_FILE) { truncated = true; return; }
        if (depth > maxDepth) maxDepth = depth;
        if (depth > MAX_STRUCTURE_DEPTH) {
            const key = pathStr + '.*';
            if (!keyPaths.has(key)) keyPaths.set(key, { types: new Set(['truncated_depth']), count: 0 });
            keyPaths.get(key).count++;
            nodeCount++;
            return;
        }
        if (Array.isArray(v)) {
            const key = pathStr + '[]';
            if (!keyPaths.has(key)) keyPaths.set(key, { types: new Set(['array']), count: 0 });
            keyPaths.get(key).count++;
            nodeCount++;
            // Inspect first 5 elements to learn array shape.
            for (let i = 0; i < Math.min(v.length, 5); i++) {
                walk(v[i], pathStr + '[*]', depth + 1);
            }
        } else if (v !== null && typeof v === 'object') {
            for (const k of Object.keys(v)) {
                const childPath = pathStr ? pathStr + '.' + k : k;
                const childVal = v[k];
                const fmt = inferValueFormat(childVal);
                if (!keyPaths.has(childPath)) keyPaths.set(childPath, { types: new Set(), count: 0 });
                keyPaths.get(childPath).types.add(fmt);
                keyPaths.get(childPath).count++;
                nodeCount++;
                if (nodeCount >= MAX_NODES_PER_FILE) { truncated = true; return; }
                walk(childVal, childPath, depth + 1);
            }
        }
    }

    walk(parsed, '', 0);

    const keys = Array.from(keyPaths.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 500)
        .map(([k, info]) => ({
            path: k || '$',
            types: Array.from(info.types),
            count: info.count,
        }));

    return {
        type: isJsonl ? 'jsonl' : 'json',
        root_type: Array.isArray(parsed) ? 'array' : typeof parsed === 'object' ? 'object' : typeof parsed,
        node_count: nodeCount,
        max_depth: maxDepth,
        unique_key_paths: keyPaths.size,
        truncated,
        keys,
    };
}

/**
 * CSV/TSV: only the header row is captured (column names).  Body is
 * counted, not read.  Privacy: column names usually describe schema,
 * not values.
 */
function inspectCsv(text, delim) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const firstNl = text.indexOf('\n');
    const headerLine = (firstNl >= 0 ? text.slice(0, firstNl) : text).replace(/\r$/, '');
    const headers = parseCsvLine(headerLine, delim);
    // Count rows without storing them.
    let rowCount = 0;
    if (firstNl >= 0) {
        let i = firstNl + 1;
        while (i < text.length) {
            const nl = text.indexOf('\n', i);
            if (nl < 0) {
                if (i < text.length) rowCount++;
                break;
            }
            if (nl - i > 1 || text[i] !== '\r') rowCount++;
            i = nl + 1;
        }
    }
    return {
        type: delim === '\t' ? 'tsv' : 'csv',
        headers: headers.slice(0, 200),
        column_count: headers.length,
        row_count: rowCount,
    };
}

function parseCsvLine(line, delim) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === delim) { fields.push(cur); cur = ''; }
            else cur += c;
        }
    }
    fields.push(cur);
    return fields.map(f => f.trim());
}

/**
 * HTML: tag-name frequency.  No text content captured.
 */
function inspectHtml(text) {
    const tagCounts = new Map();
    const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/g;
    let m;
    let totalTags = 0;
    while ((m = re.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
        totalTags++;
        if (totalTags >= MAX_NODES_PER_FILE) break;
    }
    const tags = Array.from(tagCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([name, count]) => ({ name, count }));
    return {
        type: 'html',
        total_tags: totalTags,
        unique_tags: tagCounts.size,
        tags,
    };
}

/**
 * MBOX: header-name frequency.  No body content captured, no header values.
 */
function inspectMbox(text) {
    const lines = text.split(/\r?\n/);
    let messageCount = 0;
    const headerCounts = new Map();
    let inHeaders = false;
    for (const line of lines) {
        if (line.startsWith('From ')) {
            messageCount++;
            inHeaders = true;
            continue;
        }
        if (inHeaders) {
            if (line === '') { inHeaders = false; continue; }
            const colon = line.indexOf(':');
            if (colon > 0 && colon < 80 && !line.startsWith(' ') && !line.startsWith('\t')) {
                const name = line.slice(0, colon).toLowerCase();
                headerCounts.set(name, (headerCounts.get(name) || 0) + 1);
            }
        }
    }
    const headers = Array.from(headerCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([name, count]) => ({ name, count }));
    return { type: 'mbox', message_count: messageCount, unique_headers: headerCounts.size, headers };
}

/**
 * EML / single-message email: header-name frequency.
 */
function inspectEml(text) {
    const headerEnd = text.indexOf('\r\n\r\n') >= 0 ? text.indexOf('\r\n\r\n') : text.indexOf('\n\n');
    const headerBlock = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
    const headers = new Set();
    for (const line of headerBlock.split(/\r?\n/)) {
        if (line.startsWith(' ') || line.startsWith('\t')) continue;
        const colon = line.indexOf(':');
        if (colon > 0 && colon < 80) headers.add(line.slice(0, colon).toLowerCase());
    }
    return { type: 'eml', header_names: Array.from(headers).sort() };
}

/**
 * PDF: header check + /Count regex for page count.  No text extraction.
 */
function inspectPdf(buf) {
    if (!buf || buf.length < 5 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return { type: 'pdf', valid_header: false };
    }
    const version = buf.slice(5, 9).toString('ascii').match(/^\d\.\d/);
    // Page count: count "/Type /Page" occurrences (excluding /Pages).
    const text = buf.toString('latin1');
    const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
    const pageCount = pageMatches ? pageMatches.length : 0;
    return {
        type: 'pdf',
        valid_header: true,
        version: version ? version[0] : null,
        page_count: pageCount,
    };
}

/**
 * Plain text: line count + char count + first-line-shape hint.
 */
function inspectText(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const firstLine = lines.find(l => l.length > 0) || '';
    return {
        type: 'text',
        line_count: lines.length,
        char_count: text.length,
        first_line_format: inferValueFormat(firstLine),
    };
}

// ─── Top-level inspector dispatch ──────────────────────────────────────────

function inspectFormat(format, buffer) {
    try {
        switch (format) {
            case 'json': return inspectJson(buffer.toString('utf8'));
            case 'csv':  return inspectCsv(buffer.toString('utf8'), ',');
            case 'tsv':  return inspectCsv(buffer.toString('utf8'), '\t');
            case 'html': return inspectHtml(buffer.toString('utf8'));
            case 'mbox': return inspectMbox(buffer.toString('utf8'));
            case 'eml':  return inspectEml(buffer.toString('utf8'));
            case 'pdf':  return inspectPdf(buffer);
            case 'xml':  return inspectHtml(buffer.toString('utf8'));   // tag-freq reuse
            case 'text': return inspectText(buffer.toString('utf8'));
            default:     return { type: format, metadata_only: true };
        }
    } catch (err) {
        return { type: format, inspect_error: String(err && err.message || err) };
    }
}

// ─── Approx envelope-size cost (matches Scout's accounting) ────────────────

function approxEntrySize(entry) {
    try { return JSON.stringify(entry).length; }
    catch { return 256; }
}

// ─── Walkers ───────────────────────────────────────────────────────────────

function readPeek(absPath, n) {
    let fd;
    try {
        fd = fs.openSync(absPath, 'r');
        const buf = Buffer.alloc(n);
        const bytes = fs.readSync(fd, buf, 0, n, 0);
        return buf.slice(0, bytes);
    } catch { return Buffer.alloc(0); }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function readUpTo(absPath, n) {
    let fd;
    try {
        fd = fs.openSync(absPath, 'r');
        const buf = Buffer.alloc(n);
        const bytes = fs.readSync(fd, buf, 0, n, 0);
        return buf.slice(0, bytes);
    } catch { return Buffer.alloc(0); }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function inspectFileFromDisk(rel, abs, size, envelopeBytes, sanitizer) {
    const ext = path.extname(rel).replace(/^\./, '').toLowerCase();
    const peek = readPeek(abs, PEEK_BYTES);
    const fmt = detectFormat(rel, peek);

    let structure;
    if (size > PER_FILE_BUDGET_BYTES) {
        structure = { skipped: 'too_large' };
    } else if (envelopeBytes >= ENVELOPE_SOFT_CAP_BYTES) {
        structure = { skipped: 'envelope_cap' };
    } else {
        // Cap read size at min(per-file budget, 8 MB) — generous enough for
        // every realistic per-file inspection while protecting memory.
        const readCap = Math.min(size, 8 * 1024 * 1024);
        const buf = readCap === peek.length ? peek : readUpTo(abs, readCap);
        structure = inspectFormat(fmt, buf);
    }

    return {
        path: sanitizer.sanitize(rel),
        size,
        ext,
        format: fmt,
        structure,
    };
}

function inspectZipEntry(rel, size, entryBuffer, envelopeBytes, sanitizer) {
    const ext = path.extname(rel).replace(/^\./, '').toLowerCase();
    const peek = entryBuffer.slice(0, PEEK_BYTES);
    const fmt = detectFormat(rel, peek);
    let structure;
    if (size > PER_FILE_BUDGET_BYTES) {
        structure = { skipped: 'too_large' };
    } else if (envelopeBytes >= ENVELOPE_SOFT_CAP_BYTES) {
        structure = { skipped: 'envelope_cap' };
    } else {
        structure = inspectFormat(fmt, entryBuffer);
    }
    return {
        path: sanitizer.sanitize(rel),
        size,
        ext,
        format: fmt,
        structure,
    };
}

// ── Single-file walk ───────────────────────────────────────────────────────
// Used when the user submits one PDF (DMV printout, RMS report) or a single
// CSV (cell tower dump) without the bother of zipping it.  The entry's `path`
// is just the file's basename (after sanitization).
function walkSingleFile(filePath, summary, entries, sanitizer, envelopeBytesRef) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    const size = stat.size;
    summary.total_bytes += size;
    if (summary.max_depth < 1) summary.max_depth = 1;
    const rel = path.basename(filePath);
    const entry = inspectFileFromDisk(rel, filePath, size, envelopeBytesRef.value, sanitizer);
    summary.format_counts[entry.format] = (summary.format_counts[entry.format] || 0) + 1;
    envelopeBytesRef.value += approxEntrySize(entry);
    entries.push(entry);
}

function walkDir(rootPath, summary, entries, sanitizer, envelopeBytesRef, onProgress) {
    const stack = [{ dir: rootPath, depth: 0 }];
    let inspected = 0;
    while (stack.length) {
        const { dir, depth } = stack.pop();
        let names;
        try { names = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const dirent of names) {
            const abs = path.join(dir, dirent.name);
            if (dirent.isSymbolicLink()) continue;
            if (dirent.isDirectory()) {
                stack.push({ dir: abs, depth: depth + 1 });
                continue;
            }
            if (!dirent.isFile()) continue;

            if (entries.length >= MAX_FILES) {
                summary.truncated_files++;
                continue;
            }
            let stat;
            try { stat = fs.statSync(abs); } catch { continue; }
            const size = stat.size;
            summary.total_bytes += size;
            if (depth + 1 > summary.max_depth) summary.max_depth = depth + 1;

            const rel = path.relative(rootPath, abs);
            const entry = inspectFileFromDisk(rel, abs, size, envelopeBytesRef.value, sanitizer);
            summary.format_counts[entry.format] = (summary.format_counts[entry.format] || 0) + 1;
            envelopeBytesRef.value += approxEntrySize(entry);
            entries.push(entry);
            inspected++;
            if (onProgress && inspected % 200 === 0) {
                try { onProgress({ phase: 'walk', files: inspected }); } catch {}
            }
        }
    }
}

function walkZip(zipPath, summary, entries, sanitizer, envelopeBytesRef, onProgress) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    let inspected = 0;
    for (const ze of zipEntries) {
        if (ze.isDirectory) continue;
        if (entries.length >= MAX_FILES) {
            summary.truncated_files++;
            continue;
        }
        const rel = ze.entryName;
        const depth = rel.split(/[\\/]+/).filter(Boolean).length;
        if (depth > summary.max_depth) summary.max_depth = depth;
        const size = ze.header.size;
        summary.total_bytes += size;
        // Read bounded — skip giant files (matches Scout's per-file cap).
        let buf;
        if (size > PER_FILE_BUDGET_BYTES) {
            buf = Buffer.alloc(0);
        } else {
            try { buf = ze.getData(); }
            catch { buf = Buffer.alloc(0); }
        }
        const entry = inspectZipEntry(rel, size, buf, envelopeBytesRef.value, sanitizer);
        summary.format_counts[entry.format] = (summary.format_counts[entry.format] || 0) + 1;
        envelopeBytesRef.value += approxEntrySize(entry);
        entries.push(entry);
        inspected++;
        if (onProgress && inspected % 200 === 0) {
            try { onProgress({ phase: 'walk-zip', files: inspected }); } catch {}
        }
    }
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Build a structural-sample envelope from a folder OR a `.zip` file.
 *
 * @param {string} rootPath  Absolute path to folder or .zip.
 * @param {object} opts
 *   - providerHint     {string}
 *   - submitterEmail   {string}
 *   - submitterNotes   {string}
 *   - agencyName       {string}
 *   - reporterName     {string}
 *   - productSlug      {string}  e.g. "project-viper"
 *   - appVersion       {string}
 *   - platform         {string}  "desktop" | "portable"
 *   - onProgress       {function} optional
 * @returns {object} envelope ready to send to /api/parser-submissions
 */
function buildSampleEnvelope(rootPath, opts = {}) {
    if (!rootPath || !fs.existsSync(rootPath)) {
        throw new Error(`Path does not exist: ${rootPath}`);
    }
    const stat = fs.statSync(rootPath);
    const sanitizer = new PathSanitizer();
    const entries = [];
    const envelopeBytesRef = { value: 0 };
    const summary = {
        total_files: 0,
        total_bytes: 0,
        max_depth: 0,
        truncated_files: 0,
        format_counts: {},
    };

    if (stat.isFile() && /\.zip$/i.test(rootPath)) {
        walkZip(rootPath, summary, entries, sanitizer, envelopeBytesRef, opts.onProgress);
    } else if (stat.isDirectory()) {
        walkDir(rootPath, summary, entries, sanitizer, envelopeBytesRef, opts.onProgress);
    } else if (stat.isFile()) {
        // Single-file submission — e.g. one DMV PDF, one RMS report, one CDR
        // CSV.  Behaves like a 1-entry folder walk.
        walkSingleFile(rootPath, summary, entries, sanitizer, envelopeBytesRef);
    } else {
        throw new Error(`Root path is not a regular file, directory, or .zip: ${rootPath}`);
    }
    summary.total_files = entries.length + summary.truncated_files;

    // Normalise + validate format_category against the dashboard's taxonomy.
    // Unknown values get rewritten to "other" so admin filtering stays sane.
    const VALID_CATEGORIES = new Set([
        'warrant_return', 'rms_report', 'dmv_record',
        'cell_tower_dump', 'mobile_forensics', 'other',
    ]);
    let formatCategory = (opts.formatCategory || 'warrant_return').trim();
    if (!VALID_CATEGORIES.has(formatCategory)) formatCategory = 'other';

    const envelope = {
        schema_version: SCHEMA_VERSION,
        scout_version: opts.appVersion || '',
        submitted_at: new Date().toISOString(),
        format_category: formatCategory,
        provider_hint: opts.providerHint || '',
        submitter_email: opts.submitterEmail || '',
        submitter_notes: opts.submitterNotes || '',
        agency_name: opts.agencyName || '',
        license_key_last4: opts.licenseKeyLast4 || '',
        root_summary: summary,
        tree: entries,
    };

    return envelope;
}

module.exports = {
    buildSampleEnvelope,
    // Exposed for unit tests.
    _internal: {
        PathSanitizer,
        sanitizeDirComponent,
        detectFormat,
        sniffFormat,
        inferValueFormat,
        inspectJson,
        inspectCsv,
        inspectHtml,
        inspectMbox,
        inspectEml,
        inspectPdf,
        inspectText,
        SCHEMA_VERSION,
        MAX_FILES,
        PER_FILE_BUDGET_BYTES,
        ENVELOPE_SOFT_CAP_BYTES,
    },
};
