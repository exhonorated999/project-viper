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

const SCHEMA_VERSION = 2;
const PER_FILE_BUDGET_BYTES = 64 * 1024 * 1024;     // 64 MB
const MAX_FILES = 50_000;
const MAX_STRUCTURE_DEPTH = 32;
const MAX_NODES_PER_FILE = 100_000;
const ENVELOPE_SOFT_CAP_BYTES = 8 * 1024 * 1024;    // 8 MB
const PEEK_BYTES = 4096;
const MAX_ARCHIVE_DEPTH = 4;                        // outer.zip → inner.zip → ... — guards zip-bombs
const MAX_INNER_ARCHIVE_BYTES = 64 * 1024 * 1024;   // per inner zip; skip absurdly large

// PDF text-enrichment knobs (schema v2).
const PDF_TEXT_SAMPLES_DEFAULT = 5;          // Max PDFs to text-extract per envelope.
const PDF_TEXT_TIMEOUT_MS = 8000;            // Per-PDF pdf-parse timeout.
const PDF_TEXT_MAX_PAGES = 50;               // pdf-parse `max` option.
const PDF_TOP_HEADINGS = 40;
const PDF_TOP_LABELS = 80;
const PDF_TOP_VERTICAL_LABELS = 60;
const PDF_TOP_SHAPES = 30;
const PDF_TOP_FONTS = 20;
const PDF_EXCERPT_CHARS = 1500;

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
    // Warrant-return root pattern: handle + multi-segment numeric IDs.
    // Examples:
    //   icecube086-235112678-616234-0-2023012602   (Snapchat)
    //   john.doe_123456789_abc                     (Meta-style)
    //   user@example.com-1234567890-records        (already caught above by RE_EMAIL)
    // Heuristic: hyphen/underscore-separated, ≥3 segments, ≥1 segment ≥6 digits,
    // first segment contains a letter (so it's not just numbers).  Account
    // handles, case IDs and warrant IDs all live in this shape.
    if (/[-_]/.test(component)) {
        const segs = component.split(/[-_]/);
        if (segs.length >= 3) {
            const firstHasLetter = /[A-Za-z]/.test(segs[0]);
            const numericSegments = segs.filter(s => /^\d{6,}$/.test(s)).length;
            if (firstHasLetter && numericSegments >= 1) {
                return '<redacted-warrant-root>';
            }
        }
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

    // ── Header pick: scan first ~8 lines and choose the one that looks
    // most like a column header — multiple short fields, no prose.
    // Snapchat / Meta / Google warrant CSVs often prefix a banner row
    // ("Target username '...' is associated with...").  Picking row 1
    // blindly leaks PII; instead score each candidate.
    const MAX_HEAD_SCAN = 8;
    const heads = [];
    let cursor = 0;
    for (let i = 0; i < MAX_HEAD_SCAN; i++) {
        const nl = text.indexOf('\n', cursor);
        const end = nl < 0 ? text.length : nl;
        const line = text.slice(cursor, end).replace(/\r$/, '');
        if (line.length === 0 && nl < 0) break;
        heads.push({ idx: i, line, startOffset: cursor });
        if (nl < 0) break;
        cursor = nl + 1;
    }
    const scored = heads.map(h => {
        const fields = parseCsvLine(h.line, delim);
        const cells = fields.length;
        const longest = fields.reduce((m, f) => Math.max(m, f.length), 0);
        const avg = fields.length ? (fields.reduce((s, f) => s + f.length, 0) / fields.length) : 0;
        // Score: prefer many fields, penalize very long cells (prose) and quoted PII.
        let score = cells * 10;
        if (longest > 120) score -= 60;
        else if (longest > 60) score -= 25;
        if (avg > 40) score -= 30;
        if (cells === 1) score -= 50;
        // Prose markers in any cell.
        const proseHit = fields.some(f =>
            /\b(target|username|email|associated|user id|account|subject)\b/i.test(f)
        );
        if (proseHit) score -= 80;
        return { ...h, fields, cells, score, longest };
    });
    // Prefer the highest scoring candidate, tie-break on earliest line.
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const picked = scored[0] || { fields: [], idx: 0 };

    // Redact PII inside the chosen header cells regardless.  Column names
    // *shouldn't* contain emails/UUIDs/phones, but if they do (banner row
    // survived all scoring) we never want the raw value in the envelope.
    const safeHeaders = picked.fields.map(_redactCellPii);

    // Row count: count physical newlines after the chosen header line.
    const tailStart = picked.startOffset != null
        ? (picked.startOffset + picked.line.length + 1)
        : 0;
    let rowCount = 0;
    if (tailStart < text.length) {
        let i = tailStart;
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

    const out = {
        type: delim === '\t' ? 'tsv' : 'csv',
        headers: safeHeaders.slice(0, 200),
        column_count: picked.fields.length,
        row_count: rowCount,
    };
    if (picked.idx > 0) {
        out.banner_rows_skipped = picked.idx;
    }
    return out;
}

// Strip PII substrings from a single CSV header/cell.  Even though column
// names *shouldn't* carry PII, banner-row text or accidental subject ID
// concatenations sometimes survive header detection.  Tokens used here
// match the same vocabulary as `_redactExcerpt` for consistency.
function _redactCellPii(cell) {
    if (typeof cell !== 'string') return cell;
    let s = cell;
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>');
    s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>');
    s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '<HEX>');
    s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<SSN>');
    s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, '<PHONE>');
    s = s.replace(/\b\d{10,}\b/g, '<NUM>');
    // Cap length so prose banner rows can't blow up the envelope.
    if (s.length > 160) s = s.slice(0, 157) + '...';
    return s;
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
 * PDF (sync, schema v1 compat) — header + page count + raw-byte signals.
 * Cheap; runs on every PDF.  Heavy text extraction is in inspectPdfTextAsync().
 */
function inspectPdf(buf) {
    if (!buf || buf.length < 5 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
        return { type: 'pdf', valid_header: false };
    }
    const version = buf.slice(5, 9).toString('ascii').match(/^\d\.\d/);
    const text = buf.toString('latin1');
    const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
    const pageCount = pageMatches ? pageMatches.length : 0;

    // Raw-byte signals that don't need pdf-parse — cheap fingerprint.
    const textOps = (text.match(/\b(Tj|TJ)\b/g) || []).length;
    const imageOps = (text.match(/\/Subtype\s*\/Image/g) || []).length;

    // Font family histogram (template signal — schema, not user data).
    const fontCounts = {};
    const fontMatches = text.match(/\/BaseFont\s*\/[A-Za-z0-9_\-+,]+/g) || [];
    for (const m of fontMatches) {
        let name = m.replace(/^\/BaseFont\s*\//, '');
        // Strip subset prefix "AAABBB+" that PDF embeds add.
        name = name.replace(/^[A-Z]{6}\+/, '');
        fontCounts[name] = (fontCounts[name] || 0) + 1;
    }
    const fonts = Object.entries(fontCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, PDF_TOP_FONTS)
        .map(([font, count]) => ({ font, count }));

    return {
        type: 'pdf',
        valid_header: true,
        version: version ? version[0] : null,
        page_count: pageCount,
        text_ops: textOps,
        image_ops: imageOps,
        scanned_likely: textOps < 20 && imageOps > 0,
        fonts,
        text_extracted: false,  // flipped to true by inspectPdfTextAsync().
    };
}

/**
 * Abstract a line into a shape token.  Schema signal only — no value leaks.
 *   "JONES, MARK 4521"  → "A, A N"
 *   "(909) 555-1234"    → "(N) N-N"
 *   "Date of Birth:"    → "Aa a Aa:"
 * Runs of same character class collapse to a single token char.
 */
function _lineShape(line) {
    let out = '';
    let last = null;
    for (let i = 0; i < line.length && out.length < 40; i++) {
        const ch = line[i];
        let cls;
        if (/[A-Z]/.test(ch)) cls = 'A';
        else if (/[a-z]/.test(ch)) cls = 'a';
        else if (/[0-9]/.test(ch)) cls = 'N';
        else cls = ch;
        if (cls === last && (cls === 'A' || cls === 'a' || cls === 'N')) continue;
        out += cls;
        last = cls;
    }
    return out;
}

/**
 * Redact a short PDF text excerpt so it's safe to ship in the envelope.
 * Keeps layout/punctuation; strips identifiers.  Schema labels (uppercase
 * single tokens like "NARRATIVE", lowercase mixed-case fragments) survive.
 */
function _redactExcerpt(s) {
    return s
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<SSN>')
        .replace(/\(\d{3}\)\s*\d{3}-?\d{4}/g, '<PHONE>')
        .replace(/\b\d{3}-\d{3}-\d{4}\b/g, '<PHONE>')
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '<DATE>')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
        // Uppercase comma-separated names: "JONES, MARK ANDREW"
        .replace(/\b[A-Z]{2,}, [A-Z]{2,}(?: [A-Z]{2,})?\b/g, '<UPPERNAME>')
        // Proper-case multi-word names: "Mark Andrew Jones"
        .replace(/\b[A-Z][a-z]+(?: [A-Z][a-z]+){1,3}\b/g, '<NAME>')
        // Street addresses ending in common suffix
        .replace(/\b\d{1,5}\s+[A-Za-z][A-Za-z\s]{1,30}\s+(?:St|Ave|Rd|Dr|Blvd|Ln|Way|Ct|Pl|Hwy)\b\.?/g, '<ADDRESS>')
        // Bare long digit runs (badge nums, case nums, ZIPs).
        .replace(/\b\d{4,}\b/g, '<NUM>')
        // Collapse whitespace for compactness.
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * PDF (async, schema v2) — full text-pass fingerprint.  Runs pdf-parse,
 * extracts headings / labels / line-shapes / per-page metrics.  No raw
 * values leave this function: only schema tokens (label text, heading
 * text, shape histograms, redacted excerpts) and counts.
 *
 * @param {Buffer} buf      PDF bytes.
 * @param {object} syncShape inspectPdf() result to merge into.
 * @returns {Promise<object>} enriched structure object.
 */
async function inspectPdfTextAsync(buf, syncShape) {
    const base = { ...syncShape, text_extracted: false };
    if (!syncShape || syncShape.valid_header === false) return base;

    let parsed;
    try {
        const pdfParse = require('pdf-parse');
        parsed = await Promise.race([
            pdfParse(buf, { max: PDF_TEXT_MAX_PAGES }),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error('pdf-parse timeout')), PDF_TEXT_TIMEOUT_MS)
            ),
        ]);
    } catch (err) {
        return { ...base, text_error: String((err && err.message) || err) };
    }

    const text = parsed.text || '';
    const numpages = parsed.numpages || syncShape.page_count || 0;
    const info = parsed.info || {};

    if (!text || text.trim().length < 20) {
        return { ...base, text_chars: text.length, scanned_likely: true };
    }

    const lines = text.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);

    // --- Heading frequency: predominantly-uppercase short lines ---
    const headingCounts = {};
    for (const line of lines) {
        if (line.length < 3 || line.length > 60) continue;
        const letters = line.match(/[A-Za-z]/g) || [];
        if (letters.length < 3) continue;
        const upper = (line.match(/[A-Z]/g) || []).length;
        if (upper / letters.length < 0.85) continue;
        if (/^[\d\W]+$/.test(line)) continue;
        headingCounts[line] = (headingCounts[line] || 0) + 1;
    }
    const headings = Object.entries(headingCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, PDF_TOP_HEADINGS)
        .map(([heading, count]) => ({ heading, count }));

    // --- Label tokens: text before ":" within first 40 chars of a line ---
    const labelCounts = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 2 || colon > 40) continue;
        const label = line.slice(0, colon).trim();
        if (!/^[A-Za-z][A-Za-z0-9 ./()\-#&]{0,38}$/.test(label)) continue;
        if (/\d{4,}/.test(label)) continue;   // skip badge nums, case nums
        const digits = (label.match(/\d/g) || []).length;
        if (digits > label.length / 2) continue;
        labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
    const labels = Object.entries(labelCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, PDF_TOP_LABELS)
        .map(([label, count]) => ({ label, count }));

    // --- Line shape histogram ---
    const shapeCounts = {};
    for (const line of lines) {
        const shape = _lineShape(line);
        if (!shape) continue;
        shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
    }
    const shapes = Object.entries(shapeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, PDF_TOP_SHAPES)
        .map(([shape, count]) => ({ shape, count }));

    // --- Vertical labels: line N is label-shaped, line N+1 is value-shaped ---
    // SSRS-style reports (INFORM RMS, Microsoft Reporting Services) lay labels
    // and values on separate lines.  inline-`Label: value` detection misses
    // every field.  This pass catches them.
    //
    // Rules for "label line":
    //   - 2-30 chars, starts with letter
    //   - mostly letters (digits ≤ 30% of length)
    //   - no colon, no period in interior, no dollar sign
    //   - next non-blank line exists and is NOT itself another label-shaped line
    //     (so we don't double-count consecutive labels in a form-header row)
    //   - case: title-case OR mixed-case OK; reject ALL-CAPS unless ≤15 chars
    //     (ALL-CAPS long lines are usually values like "FREIGHTLINER CORP.")
    const verticalLabelCounts = {};
    const isLabelShape = (s) => {
        if (!s || s.length < 2 || s.length > 30) return false;
        if (!/^[A-Za-z]/.test(s)) return false;
        if (s.includes(':') || s.includes('$')) return false;
        if (/\d{4,}/.test(s)) return false;
        const letters = (s.match(/[A-Za-z]/g) || []).length;
        const digits = (s.match(/\d/g) || []).length;
        if (letters < 2) return false;
        if (digits / s.length > 0.3) return false;
        // ALL-CAPS long lines = probably values not labels.
        const upper = (s.match(/[A-Z]/g) || []).length;
        if (upper / letters > 0.95 && s.length > 15) return false;
        // Reject pure punctuation-laden strings.
        if (/[!@#%^*]/.test(s)) return false;
        return true;
    };
    for (let i = 0; i < lines.length - 1; i++) {
        const cur = lines[i];
        const next = lines[i + 1];
        if (!isLabelShape(cur)) continue;
        if (!next || next.length === 0) continue;
        // If next is also label-shaped, this may be a consecutive header row
        // (e.g. "Color(s)\nYear\nMake\n...") — still count cur, those are real labels.
        verticalLabelCounts[cur] = (verticalLabelCounts[cur] || 0) + 1;
    }
    const verticalLabels = Object.entries(verticalLabelCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, PDF_TOP_VERTICAL_LABELS)
        .map(([label, count]) => ({ label, count }));

    // --- Redacted excerpt (first PDF_EXCERPT_CHARS chars of page 1-ish) ---
    const excerpt = _redactExcerpt(text.slice(0, 2500)).slice(0, PDF_EXCERPT_CHARS);

    return {
        ...base,
        text_extracted: true,
        text_chars: text.length,
        text_lines: lines.length,
        text_lines_per_page: numpages ? Math.round(lines.length / numpages) : null,
        page_count: numpages,
        scanned_likely: lines.length < 5 && (syncShape.image_ops || 0) > 0,
        pdf_info: {
            creator: info.Creator || null,
            producer: info.Producer || null,
        },
        headings,
        label_tokens: labels,
        vertical_labels: verticalLabels,
        line_shapes: shapes,
        page_excerpt_redacted: excerpt,
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
function walkSingleFile(filePath, summary, entries, sanitizer, envelopeBytesRef, pdfRefs) {
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
    if (entry.format === 'pdf' && pdfRefs) {
        pdfRefs.push({ entryIdx: entries.length - 1, abs: filePath });
    }
}

// Yield interval — every N files we hand control back to the Node event loop
// so the Electron main process can pump its message loop.  Without this the
// OS marks the window "Not Responding" on multi-thousand-file scans.
const YIELD_EVERY_N_FILES = 100;
function _yieldToEventLoop() {
    return new Promise(r => setImmediate(r));
}

async function walkDir(rootPath, summary, entries, sanitizer, envelopeBytesRef, onProgress, pdfRefs) {
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
            if (entry.format === 'pdf' && pdfRefs) {
                pdfRefs.push({ entryIdx: entries.length - 1, abs });
            }
            inspected++;
            if (onProgress && inspected % 50 === 0) {
                try { onProgress({ phase: 'walk', files: inspected, bytes: summary.total_bytes }); } catch {}
            }
            // Yield periodically so the main process can pump its message
            // loop (prevents OS "Not Responding" on large folder scans).
            if (inspected % YIELD_EVERY_N_FILES === 0) {
                await _yieldToEventLoop();
            }
        }
    }
}

function walkZip(zipPath, summary, entries, sanitizer, envelopeBytesRef, onProgress, pdfRefs) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const counters = { inspected: 0, pdfBufKept: 0 };
    return _walkZipObject(zip, '', 1, summary, entries, sanitizer, envelopeBytesRef, onProgress, pdfRefs, counters);
}

/**
 * Walk an AdmZip object.  Entry names get an optional `pathPrefix` so nested
 * archives produce paths like `outer.zip/inner/messages/file_001.json`.
 *
 * Inner ZIPs (format='archive', PK magic, depth ≤ MAX_ARCHIVE_DEPTH, size
 * ≤ MAX_INNER_ARCHIVE_BYTES) are parsed from the in-memory buffer and
 * recursed into.  Each parent entry gets `structure.recursed: true` or
 * `structure.recurse_skipped: '<reason>'` so parser-authors can see the
 * recursion graph.
 *
 * `counters` is a shared `{ inspected, pdfBufKept }` ref so PDF-buffer
 * keeping is enforced across the entire envelope, not per-archive.
 */
function _walkZipObject(zip, pathPrefix, archiveDepth, summary, entries, sanitizer, envelopeBytesRef, onProgress, pdfRefs, counters) {
    return (async () => {
    const AdmZip = require('adm-zip');
    const zipEntries = zip.getEntries();
    for (const ze of zipEntries) {
        if (ze.isDirectory) continue;
        if (entries.length >= MAX_FILES) {
            summary.truncated_files++;
            continue;
        }
        const innerRel = ze.entryName;
        // Compose path with outer prefix for nested-zip context.
        const rel = pathPrefix ? `${pathPrefix}/${innerRel}` : innerRel;
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
        const entryIdx = entries.length;
        entries.push(entry);
        // Keep buffer for first N PDFs only — memory-bounded, shared across archives.
        if (entry.format === 'pdf' && pdfRefs && counters.pdfBufKept < PDF_TEXT_SAMPLES_DEFAULT && buf.length) {
            pdfRefs.push({ entryIdx, buf });
            counters.pdfBufKept++;
        }

        // ── Nested archive recursion ──────────────────────────────────────
        // Only ZIPs are recursed (7z/rar/tar use different libraries).
        // PK\03\04 (regular) or PK\05\06 (empty) — same detection used by detectFormat.
        const isZipMagic = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B
            && (buf[2] === 0x03 || buf[2] === 0x05);
        if (entry.format === 'archive' && isZipMagic) {
            if (archiveDepth >= MAX_ARCHIVE_DEPTH) {
                entry.structure = { ...entry.structure, recurse_skipped: 'max_depth' };
            } else if (size > MAX_INNER_ARCHIVE_BYTES) {
                entry.structure = { ...entry.structure, recurse_skipped: 'too_large' };
            } else if (!buf.length) {
                entry.structure = { ...entry.structure, recurse_skipped: 'no_buffer' };
            } else {
                try {
                    const innerZip = new AdmZip(buf);
                    entry.structure = { ...entry.structure, recursed: true };
                    await _walkZipObject(
                        innerZip,
                        entry.path,                  // sanitized path becomes inner prefix
                        archiveDepth + 1,
                        summary,
                        entries,
                        sanitizer,
                        envelopeBytesRef,
                        onProgress,
                        pdfRefs,
                        counters
                    );
                } catch (err) {
                    entry.structure = {
                        ...entry.structure,
                        recurse_error: String(err && err.message || err).slice(0, 200),
                    };
                }
            }
        }

        // Accounting: do this *after* recursion so structure mutations
        // (recursed/recurse_skipped/recurse_error) are reflected.
        envelopeBytesRef.value += approxEntrySize(entry);

        counters.inspected++;
        if (onProgress && counters.inspected % 50 === 0) {
            try { onProgress({ phase: 'walk-zip', files: counters.inspected, bytes: summary.total_bytes }); } catch {}
        }
        // Yield periodically so the main process can pump its message loop.
        if (counters.inspected % YIELD_EVERY_N_FILES === 0) {
            await _yieldToEventLoop();
        }
    }
    })();
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
async function buildSampleEnvelope(rootPath, opts = {}) {
    if (!rootPath || !fs.existsSync(rootPath)) {
        throw new Error(`Path does not exist: ${rootPath}`);
    }
    const stat = fs.statSync(rootPath);
    const sanitizer = new PathSanitizer();
    const entries = [];
    const pdfRefs = [];                          // PDFs to text-enrich post-walk.
    const envelopeBytesRef = { value: 0 };
    const summary = {
        total_files: 0,
        total_bytes: 0,
        max_depth: 0,
        truncated_files: 0,
        format_counts: {},
    };

    // ── Start signal ─────────────────────────────────────────────────────
    if (typeof opts.onProgress === 'function') {
        let kind = 'file';
        if (stat.isFile() && /\.zip$/i.test(rootPath)) kind = 'zip';
        else if (stat.isDirectory()) kind = 'dir';
        try { opts.onProgress({ phase: 'start', kind, rootPath }); } catch {}
    }

    if (stat.isFile() && /\.zip$/i.test(rootPath)) {
        await walkZip(rootPath, summary, entries, sanitizer, envelopeBytesRef, opts.onProgress, pdfRefs);
    } else if (stat.isDirectory()) {
        await walkDir(rootPath, summary, entries, sanitizer, envelopeBytesRef, opts.onProgress, pdfRefs);
    } else if (stat.isFile()) {
        // Single-file submission — e.g. one DMV PDF, one RMS report, one CDR
        // CSV.  Behaves like a 1-entry folder walk.
        walkSingleFile(rootPath, summary, entries, sanitizer, envelopeBytesRef, pdfRefs);
    } else {
        throw new Error(`Root path is not a regular file, directory, or .zip: ${rootPath}`);
    }
    summary.total_files = entries.length + summary.truncated_files;

    // Walk-complete signal — UI can switch the bar from indeterminate to a
    // determinate "N files found, enriching PDFs…" state.
    if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({
            phase: 'walk-complete',
            files: summary.total_files,
            bytes: summary.total_bytes,
        }); } catch {}
    }

    // ── PDF text-enrichment (async) ───────────────────────────────────────
    // pdf-parse is async-only.  Run it on the first N PDFs found; the rest
    // keep the cheap raw-byte fingerprint from inspectPdf().
    const maxPdfEnrich = (typeof opts.maxPdfTextSamples === 'number')
        ? opts.maxPdfTextSamples
        : PDF_TEXT_SAMPLES_DEFAULT;
    const enrichTargets = pdfRefs.slice(0, Math.max(0, maxPdfEnrich));
    const enrichmentPromise = (async () => {
        if (typeof opts.onProgress === 'function' && enrichTargets.length) {
            try { opts.onProgress({ phase: 'pdf-text', total: enrichTargets.length }); } catch {}
        }
        for (let i = 0; i < enrichTargets.length; i++) {
            const ref = enrichTargets[i];
            const entry = entries[ref.entryIdx];
            if (!entry || entry.format !== 'pdf') continue;
            let buf;
            if (ref.buf && ref.buf.length) {
                buf = ref.buf;
            } else if (ref.abs) {
                try { buf = fs.readFileSync(ref.abs); }
                catch (err) {
                    entry.structure = {
                        ...entry.structure,
                        text_extracted: false,
                        text_error: 'read_failed: ' + err.message,
                    };
                    continue;
                }
            } else {
                continue;
            }
            try {
                envelopeBytesRef.value -= approxEntrySize(entry);
                entry.structure = await inspectPdfTextAsync(buf, entry.structure);
                envelopeBytesRef.value += approxEntrySize(entry);
            } catch (err) {
                entry.structure = {
                    ...entry.structure,
                    text_extracted: false,
                    text_error: String(err.message || err),
                };
            }
            if (typeof opts.onProgress === 'function') {
                try { opts.onProgress({ phase: 'pdf-text', done: i + 1, total: enrichTargets.length }); } catch {}
            }
        }
        if (pdfRefs.length > enrichTargets.length) {
            summary.pdf_text_samples_omitted = pdfRefs.length - enrichTargets.length;
        }
        if (enrichTargets.length > 0) {
            summary.pdf_text_samples_emitted = enrichTargets.length;
        }
    })();

    // Normalise + validate format_category against the dashboard's taxonomy.
    // Unknown values get rewritten to "other" so admin filtering stays sane.
    const VALID_CATEGORIES = new Set([
        'warrant_return', 'rms_report', 'dmv_record',
        'cell_tower_dump', 'mobile_forensics', 'other',
    ]);
    let formatCategory = (opts.formatCategory || 'warrant_return').trim();
    if (!VALID_CATEGORIES.has(formatCategory)) formatCategory = 'other';

    // Return a Promise that resolves to the envelope after enrichment.
    return enrichmentPromise.then(() => {
        if (typeof opts.onProgress === 'function') {
            try { opts.onProgress({ phase: 'done', files: summary.total_files }); } catch {}
        }
        return ({
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
        });
    });
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
