/**
 * Snapchat Warrant Parser
 * Parses Snapchat law-enforcement warrant return ZIP archives or unzipped folders.
 * Runs in Electron main process (Node.js) — uses adm-zip + fs.
 *
 * Snapchat productions contain one or more "part" folders, named like:
 *   {username}-{caseId}-{requestId}-{partNum}-{date}/
 *
 * Each part folder may contain:
 *   conversations.csv         — message log (always present in this sample)
 *   geo_locations.csv         — lat/lon/timestamp
 *   memories.csv              — saved memory snaps
 *   device_advertising_id.csv — device IDs
 *   subscriber_info.csv       — (optional) account/registration info
 *   login_history.csv         — (optional) login events with IPs
 *   friends.csv               — (optional) friend list
 *   snap_history.csv          — (optional) snap activity
 *   {anything-else}.csv       — generic fallback
 *   chat~media_v4~...~v4.{jpeg|mp4|webp|png|jpg|gif}  — chat media
 *
 * CSV files have a multi-line legend "preamble" before the actual header row;
 * the preamble ends with a "===" separator line, after which the next non-empty
 * line is the column header.
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

// Filenames we have hardcoded handlers for (lowercase basenames).
const KNOWN_CSVS = new Set([
    'conversations.csv',
    'geo_locations.csv',
    'memories.csv',
    'device_advertising_id.csv',
    'subscriber_info.csv',
    'login_history.csv',
    'friends.csv',
    'snap_history.csv'
]);

const MEDIA_EXTS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.mp4', '.webp', '.webm', '.mov']);

class SnapchatWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Check if a buffer looks like a Snapchat warrant ZIP.
     * Heuristic: contains at least one folder with conversations.csv whose
     * first line contains the Snapchat preamble token "Target username".
     */
    static isSnapchatWarrantZip(zipBufferOrPath) {
        try {
            // Accept Buffer OR file path string — file path uses central-directory only (no full file read)
            const zip = new AdmZip(zipBufferOrPath);
            const entries = zip.getEntries();
            for (const entry of entries) {
                const lower = entry.entryName.toLowerCase();
                if (lower.endsWith('/conversations.csv') || lower === 'conversations.csv') {
                    try {
                        const head = zip.readAsText(entry).slice(0, 800);
                        if (/Target username/i.test(head) || /User ID/i.test(head)) {
                            return true;
                        }
                    } catch (e) { /* keep looking */ }
                }
            }
            // Fallback: filename pattern in part folders
            for (const entry of entries) {
                const segs = entry.entryName.split('/');
                if (segs.length >= 2 && /^[\w.-]+-\d+-\d+-\d+-\d+\/?$/.test(segs[0] + '/')) {
                    return true;
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a directory on disk looks like a Snapchat warrant production.
     * Either: top-level has conversations.csv with Snapchat preamble,
     *  OR top-level has subfolders that match the part pattern and contain conversations.csv.
     */
    static isSnapchatWarrantFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;

            const checkConv = (dir) => {
                const conv = path.join(dir, 'conversations.csv');
                if (!fs.existsSync(conv)) return false;
                try {
                    const head = fs.readFileSync(conv, 'utf8').slice(0, 800);
                    return /Target username/i.test(head) || /User ID/i.test(head);
                } catch (e) { return false; }
            };

            if (checkConv(folderPath)) return true;

            const entries = fs.readdirSync(folderPath, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && checkConv(path.join(folderPath, e.name))) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // ─── Public Parse Entry Points ──────────────────────────────────────

    /**
     * Parse a Snapchat warrant ZIP buffer.
     * @param {Buffer} zipBuffer
     * @param {Object} options { extractDir, security }
     *   - extractDir: directory where media files are extracted (required for media)
     *   - security: optional VIPER security helper for encryption
     * @returns {Object} parse result
     */
    async parseZip(zipBuffer, options = {}) {
        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries();

        // Group entries by part folder (top-level dir)
        const partMap = new Map(); // partFolder -> { csvEntries: [], mediaEntries: [] }
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const segs = entry.entryName.split('/');
            // Files at root => single-part production at top level
            const partFolder = segs.length >= 2 ? segs[0] : '__root__';
            if (!partMap.has(partFolder)) {
                partMap.set(partFolder, { csvEntries: [], mediaEntries: [] });
            }
            const bucket = partMap.get(partFolder);
            const lower = entry.entryName.toLowerCase();
            if (lower.endsWith('.csv')) {
                bucket.csvEntries.push(entry);
            } else {
                const ext = path.extname(lower);
                if (MEDIA_EXTS.has(ext)) bucket.mediaEntries.push(entry);
            }
        }

        return this._parsePartMap({
            partMap,
            readCsv: (entry) => zip.readAsText(entry),
            readBinary: (entry) => entry.getData(),
            options
        });
    }

    /**
     * Parse an unzipped Snapchat warrant folder on disk.
     * @param {string} folderPath  Top-level folder containing part subfolders OR a single part folder.
     * @param {Object} options { extractDir, security }
     */
    async parseFolder(folderPath, options = {}) {
        const partMap = new Map();

        const collectFromDir = (dir, partFolder) => {
            if (!partMap.has(partFolder)) {
                partMap.set(partFolder, { csvEntries: [], mediaEntries: [] });
            }
            const bucket = partMap.get(partFolder);
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const it of items) {
                const full = path.join(dir, it.name);
                if (it.isFile()) {
                    const lower = it.name.toLowerCase();
                    if (lower.endsWith('.csv')) {
                        bucket.csvEntries.push({ entryName: it.name, _diskPath: full });
                    } else {
                        const ext = path.extname(lower);
                        if (MEDIA_EXTS.has(ext)) {
                            bucket.mediaEntries.push({ entryName: it.name, _diskPath: full });
                        }
                    }
                } else if (it.isDirectory()) {
                    // Nested directory inside a part — flatten media but keep CSVs at top level only
                    const subItems = fs.readdirSync(full, { withFileTypes: true });
                    for (const sub of subItems) {
                        if (sub.isFile()) {
                            const subFull = path.join(full, sub.name);
                            const lower = sub.name.toLowerCase();
                            const ext = path.extname(lower);
                            if (MEDIA_EXTS.has(ext)) {
                                bucket.mediaEntries.push({ entryName: sub.name, _diskPath: subFull });
                            }
                        }
                    }
                }
            }
        };

        // Determine layout: single-part (folderPath itself contains conversations.csv) vs multi-part
        const topConv = path.join(folderPath, 'conversations.csv');
        if (fs.existsSync(topConv)) {
            collectFromDir(folderPath, path.basename(folderPath));
        } else {
            const subs = fs.readdirSync(folderPath, { withFileTypes: true });
            for (const s of subs) {
                if (!s.isDirectory()) continue;
                const subPath = path.join(folderPath, s.name);
                const subConv = path.join(subPath, 'conversations.csv');
                if (fs.existsSync(subConv)) {
                    collectFromDir(subPath, s.name);
                }
            }
        }

        return this._parsePartMap({
            partMap,
            readCsv: (entry) => fs.readFileSync(entry._diskPath, 'utf8'),
            readBinary: (entry) => fs.readFileSync(entry._diskPath),
            options
        });
    }

    // ─── Core Parsing ───────────────────────────────────────────────────

    async _parsePartMap({ partMap, readCsv, readBinary, options }) {
        const { extractDir, security } = options || {};
        const parts = [];
        const mediaFiles = {};

        // Sort part folders by partNum if discoverable in name (e.g. "...-0-..." vs "...-1-...")
        const sortedPartKeys = Array.from(partMap.keys()).sort((a, b) => {
            const na = this._extractPartNum(a);
            const nb = this._extractPartNum(b);
            if (na !== null && nb !== null) return na - nb;
            return a.localeCompare(b);
        });

        for (const partFolder of sortedPartKeys) {
            const bucket = partMap.get(partFolder);
            const part = await this._parseOnePart(partFolder, bucket, { readCsv, readBinary, extractDir, security, mediaFiles });
            parts.push(part);
        }

        // Merge cross-part collections
        const merged = this._mergeParts(parts);

        // After parts are parsed, build media linkage map (media_id token → filename)
        const mediaIndex = this._buildMediaIndex(Object.keys(mediaFiles));

        // Attach a `_mediaFile` reference on each conversation row when match found
        for (const conv of merged.conversations) {
            if (conv.media_id) {
                const matchedFilename = this._findMediaFileForId(conv.media_id, mediaIndex);
                if (matchedFilename) conv._mediaFile = matchedFilename;
            }
        }

        return {
            parts,
            mergedHeader: merged.header,
            conversations: merged.conversations,
            geoLocations: merged.geoLocations,
            memories: merged.memories,
            deviceAdvertisingIds: merged.deviceAdvertisingIds,
            subscriberInfo: merged.subscriberInfo,
            loginHistory: merged.loginHistory,
            friends: merged.friends,
            snapHistory: merged.snapHistory,
            otherCsvs: merged.otherCsvs,
            mediaFiles,
            stats: {
                partCount: parts.length,
                mediaCount: Object.keys(mediaFiles).length,
                conversationCount: merged.conversations.length,
                geoLocationCount: merged.geoLocations.length,
                memoryCount: merged.memories.length
            }
        };
    }

    async _parseOnePart(partFolder, bucket, ctx) {
        const { readCsv, readBinary, extractDir, security, mediaFiles } = ctx;

        const part = {
            partFolder,
            partNum: this._extractPartNum(partFolder),
            header: null,
            conversations: [],
            geoLocations: [],
            memories: [],
            deviceAdvertisingIds: [],
            subscriberInfo: null,
            loginHistory: [],
            friends: [],
            snapHistory: [],
            otherCsvs: {} // filename -> { headers, rows, raw }
        };

        // ─── Parse CSVs ───
        for (const entry of bucket.csvEntries) {
            const baseName = path.basename(entry.entryName).toLowerCase();
            let text;
            try {
                text = readCsv(entry);
            } catch (e) { continue; }

            const { header, headers, rows } = this._parseSnapchatCsv(text);

            // Capture aggregate header info from first CSV that supplies it.
            if (header && !part.header) part.header = header;

            switch (baseName) {
                case 'conversations.csv':
                    part.conversations = rows;
                    break;
                case 'geo_locations.csv':
                    part.geoLocations = rows.map(r => ({
                        latitude: this._parseLatLon(r.latitude),
                        longitude: this._parseLatLon(r.longitude),
                        latitudeAccuracy: this._parseAccuracy(r.latitude),
                        longitudeAccuracy: this._parseAccuracy(r.longitude),
                        timestamp: r.timestamp || null,
                        _raw: r
                    })).filter(g => g.latitude !== null && g.longitude !== null);
                    break;
                case 'memories.csv':
                    part.memories = rows;
                    break;
                case 'device_advertising_id.csv':
                    part.deviceAdvertisingIds = rows;
                    break;
                case 'subscriber_info.csv':
                    // Subscriber info is typically a single key/value style record; flatten
                    part.subscriberInfo = rows.length === 1 ? rows[0] : (rows.length > 1 ? rows : null);
                    break;
                case 'login_history.csv':
                    part.loginHistory = rows;
                    break;
                case 'friends.csv':
                    part.friends = rows;
                    break;
                case 'snap_history.csv':
                    part.snapHistory = rows;
                    break;
                default:
                    if (!KNOWN_CSVS.has(baseName)) {
                        part.otherCsvs[baseName] = { headers, rows };
                    }
                    break;
            }
        }

        // ─── Extract media files ───
        if (extractDir && bucket.mediaEntries.length > 0) {
            const partExtractDir = path.join(extractDir, partFolder);
            if (!fs.existsSync(partExtractDir)) fs.mkdirSync(partExtractDir, { recursive: true });

            for (const entry of bucket.mediaEntries) {
                const fileName = path.basename(entry.entryName);
                const dest = path.join(partExtractDir, fileName);
                try {
                    let buf = readBinary(entry);
                    if (security && security.isUnlocked && security.isUnlocked()) {
                        buf = security.encryptBuffer(buf);
                    }
                    fs.writeFileSync(dest, buf);

                    const meta = this._parseMediaFilename(fileName);
                    mediaFiles[fileName] = {
                        diskPath: dest,
                        partFolder,
                        size: buf.length,
                        mimeType: this._mimeFromExt(path.extname(fileName)),
                        ...meta
                    };
                } catch (e) {
                    // skip individual file failures
                }
            }
        }

        return part;
    }

    _mergeParts(parts) {
        const merged = {
            header: null,
            conversations: [],
            geoLocations: [],
            memories: [],
            deviceAdvertisingIds: [],
            subscriberInfo: null,
            loginHistory: [],
            friends: [],
            snapHistory: [],
            otherCsvs: {}
        };

        for (const p of parts) {
            if (!merged.header && p.header) merged.header = p.header;
            merged.conversations.push(...p.conversations);
            merged.geoLocations.push(...p.geoLocations);
            merged.memories.push(...p.memories);
            merged.deviceAdvertisingIds.push(...p.deviceAdvertisingIds);
            if (!merged.subscriberInfo && p.subscriberInfo) merged.subscriberInfo = p.subscriberInfo;
            merged.loginHistory.push(...p.loginHistory);
            merged.friends.push(...p.friends);
            merged.snapHistory.push(...p.snapHistory);
            for (const [k, v] of Object.entries(p.otherCsvs || {})) {
                if (!merged.otherCsvs[k]) merged.otherCsvs[k] = { headers: v.headers, rows: [] };
                merged.otherCsvs[k].rows.push(...v.rows);
            }
        }

        // Deduplicate conversations by message_id + conversation_id (when present)
        const seen = new Set();
        merged.conversations = merged.conversations.filter(m => {
            const key = `${m.conversation_id || ''}::${m.message_id || ''}::${m.timestamp || ''}::${m.sender_user_id || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Sort conversations by parsed timestamp ascending
        merged.conversations.sort((a, b) => this._parseSnapTimestamp(a.timestamp) - this._parseSnapTimestamp(b.timestamp));

        // Sort geo by timestamp
        merged.geoLocations.sort((a, b) => this._parseSnapTimestamp(a.timestamp) - this._parseSnapTimestamp(b.timestamp));

        return merged;
    }

    // ─── Snapchat CSV Parsing ───────────────────────────────────────────

    /**
     * Parse a Snapchat CSV with its multi-line preamble.
     * Strategy:
     *   1. Read preamble lines until we hit a "===" separator.
     *   2. Capture header info (Target username, email, User ID, date range) from preamble.
     *   3. The first non-empty line after the separator is the column header row.
     *   4. Remaining rows are data, parsed via standard CSV state machine.
     *
     * Returns: { header: {...} | null, headers: [...], rows: [{...}] }
     */
    _parseSnapchatCsv(text) {
        if (!text) return { header: null, headers: [], rows: [] };

        const allRows = this._parseCsv(text);
        if (allRows.length === 0) return { header: null, headers: [], rows: [] };

        // Snapchat CSVs always have an "===" separator line between the legend and the header row.
        // The next non-empty row after the last "===" line is the column-header row.
        let headerIdx = -1;
        let lastSeparatorIdx = -1;
        let preambleRows = [];

        for (let i = 0; i < allRows.length; i++) {
            const row = allRows[i];
            const first = (row[0] || '').trim();
            if (/^=+$/.test(first)) {
                lastSeparatorIdx = i;
            }
        }

        if (lastSeparatorIdx >= 0) {
            // First non-empty row after the separator is the header
            for (let j = lastSeparatorIdx + 1; j < allRows.length; j++) {
                const r = allRows[j];
                if (r.length > 0 && r.some(c => c && c.length)) {
                    headerIdx = j;
                    break;
                }
            }
            preambleRows = allRows.slice(0, lastSeparatorIdx);
        } else {
            // No separator found — fall back to heuristic detection
            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                if (row.length === 0) { preambleRows.push(row); continue; }
                const first = (row[0] || '').trim();

                // Separator or legend boundary
                if (/^-+$/.test(first)) {
                    preambleRows.push(row);
                    continue;
                }

                // Recognized known header names
                const knownHeaderHits = row.filter(c => /^(content_type|message_type|conversation_id|message_id|latitude|longitude|timestamp|id|media_id|encrypted|source_type|duration|device id|device_id|device_type|os|os_version|id type|advertising_id|version|ip|login_time|country|carrier|username|user_id|display_name|email|phone|created|time recorded|is hms\?)$/i.test((c || '').trim())).length;

                if (knownHeaderHits >= 2) {
                    headerIdx = i;
                    break;
                }
                preambleRows.push(row);
            }
        }

        if (headerIdx === -1) {
            // No clear header — return empty
            return {
                header: this._extractHeaderInfo(preambleRows),
                headers: [],
                rows: []
            };
        }

        const headers = allRows[headerIdx].map(h => (h || '').trim());
        const dataRows = allRows.slice(headerIdx + 1).filter(r => r.length > 0 && r.some(c => c && c.length));

        const rows = dataRows.map(r => {
            const obj = {};
            for (let i = 0; i < headers.length; i++) {
                const key = headers[i];
                if (!key) continue;
                obj[key] = r[i] !== undefined ? r[i] : '';
            }
            return obj;
        });

        return {
            header: this._extractHeaderInfo(preambleRows),
            headers,
            rows
        };
    }

    /**
     * Extract account/header info from Snapchat preamble lines.
     */
    _extractHeaderInfo(preambleRows) {
        const info = {
            targetUsername: null,
            email: null,
            userId: null,
            dateRange: null
        };
        for (const row of preambleRows) {
            const text = (row[0] || '');
            // "Target username "icecube086" and email "isaacm2326@gmail.com" is associated with User ID "d9295f18-..."
            const userMatch = text.match(/Target username\s+["']?([^"']+)["']?/i);
            if (userMatch && !info.targetUsername) info.targetUsername = userMatch[1].trim();
            const emailMatch = text.match(/email\s+["']?([^"'\s]+@[^"'\s]+)["']?/i);
            if (emailMatch && !info.email) info.email = emailMatch[1].trim();
            const uidMatch = text.match(/User ID\s+["']?([0-9a-f-]{8,})["']?/i);
            if (uidMatch && !info.userId) info.userId = uidMatch[1].trim();
            const dateMatch = text.match(/Date range searched:?\s*(.+)/i);
            if (dateMatch && !info.dateRange) info.dateRange = dateMatch[1].trim();
        }
        return (info.targetUsername || info.email || info.userId || info.dateRange) ? info : null;
    }

    /**
     * Generic state-machine CSV parser. Handles multi-line quoted fields.
     */
    _parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        let i = 0;
        const len = text.length;

        while (i < len) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < len && text[i + 1] === '"') {
                        field += '"';
                        i += 2;
                        continue;
                    }
                    inQuotes = false;
                    i++;
                    continue;
                }
                field += ch;
                i++;
                continue;
            }
            // Not in quotes
            if (ch === '"') {
                inQuotes = true;
                i++;
                continue;
            }
            if (ch === ',') {
                row.push(field);
                field = '';
                i++;
                continue;
            }
            if (ch === '\r') {
                if (i + 1 < len && text[i + 1] === '\n') i++;
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
                i++;
                continue;
            }
            if (ch === '\n') {
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
                i++;
                continue;
            }
            field += ch;
            i++;
        }
        if (field.length > 0 || row.length > 0) {
            row.push(field);
            rows.push(row);
        }
        return rows;
    }

    // ─── Media Filename Parsing & Linking ───────────────────────────────

    /**
     * Parse a Snapchat media filename:
     *   chat~media_v4~2022-08-01-20-57-47UTC~icecube086~hellck1tty~saved~b~EiQSFU...~v4.jpeg
     *
     * Returns metadata extracted from the filename pattern.
     */
    _parseMediaFilename(fileName) {
        const meta = { sender: null, recipient: null, timestamp: null, savedFlag: null, mediaIdToken: null };
        try {
            const parts = fileName.split('~');
            // ['chat', 'media_v4', '2022-08-01-20-57-47UTC', 'sender', 'recipient', 'saved'|'unsaved', 'b', '<token>', 'v4.jpeg']
            if (parts.length >= 8) {
                meta.timestamp = parts[2] || null;
                meta.sender = parts[3] || null;
                meta.recipient = parts[4] || null;
                meta.savedFlag = parts[5] || null;
                // mediaIdToken is the segment after the 'b' marker: parts[7]
                if (parts[6] === 'b' && parts[7]) {
                    meta.mediaIdToken = parts[7];
                }
            }
        } catch (e) { /* ignore */ }
        return meta;
    }

    /**
     * Build a lookup index: token-suffix → filename, for fast media linking.
     */
    _buildMediaIndex(filenames) {
        const idx = new Map();
        for (const f of filenames) {
            const meta = this._parseMediaFilename(f);
            if (meta.mediaIdToken) {
                // Index by full token AND by trailing 24 chars (CSV media_id may have a different prefix byte)
                idx.set(meta.mediaIdToken, f);
                if (meta.mediaIdToken.length > 24) {
                    idx.set(meta.mediaIdToken.slice(-24), f);
                }
            }
        }
        return idx;
    }

    /**
     * Look up a media filename for a given conversations.csv media_id value.
     * media_id format from CSV: "b~EiQSFU..." (the `b~` prefix may differ slightly per row variant).
     */
    _findMediaFileForId(mediaId, mediaIndex) {
        if (!mediaId || !mediaIndex || mediaIndex.size === 0) return null;
        // Strip leading "b~" if present
        let token = mediaId.startsWith('b~') ? mediaId.slice(2) : mediaId;
        if (mediaIndex.has(token)) return mediaIndex.get(token);
        // Try last 24 chars suffix (the file token & csv token often share the suffix)
        if (token.length > 24) {
            const suffix = token.slice(-24);
            if (mediaIndex.has(suffix)) return mediaIndex.get(suffix);
        }
        return null;
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _extractPartNum(partFolder) {
        // Match "...-{N}-..." where N is a small integer near the end of the name
        const m = partFolder.match(/-(\d+)-\d{8,}/);
        if (m) return parseInt(m[1], 10);
        const m2 = partFolder.match(/-(\d+)-/);
        if (m2) return parseInt(m2[1], 10);
        return null;
    }

    _parseLatLon(cell) {
        if (!cell) return null;
        const m = String(cell).match(/-?\d+\.?\d*/);
        if (!m) return null;
        const n = parseFloat(m[0]);
        return Number.isFinite(n) ? n : null;
    }

    _parseAccuracy(cell) {
        if (!cell) return null;
        const m = String(cell).match(/±\s*(\d+\.?\d*)/);
        return m ? parseFloat(m[1]) : null;
    }

    /**
     * Parse Snapchat timestamps like "Tue Dec 13 15:46:22 UTC 2022".
     */
    _parseSnapTimestamp(ts) {
        if (!ts) return 0;
        const t = Date.parse(ts);
        return Number.isFinite(t) ? t : 0;
    }

    _mimeFromExt(ext) {
        const map = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
        };
        return map[(ext || '').toLowerCase()] || 'application/octet-stream';
    }
}

module.exports = SnapchatWarrantParser;
