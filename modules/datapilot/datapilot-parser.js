/**
 * Datapilot Parser — Node.js (Electron main process)
 *
 * Supports TWO Datapilot export formats:
 *
 *   CSV (legacy "Datapilot CSV"):
 *     Summary_CaseAndAcquisitionInformation.csv  ← signature file
 *     DeviceInfo.csv, Contacts.csv, Applications.csv
 *     OtherImageFiles1.csv / ThumbnailImageFiles1.csv / VideoFiles1.csv /
 *       AudioFiles1.csv / Files1.csv / DatabaseFiles1.csv / TextFiles1.csv /
 *       CompressedFiles1.csv
 *     DeletedData.csv, AppData.csv
 *     AppData/, Contacts/Thumbnails, DeletedData/, FileSystem/, HtmlPreview/, PhotoExif/
 *
 *   DPX (Datapilot 10):
 *     {extractionFolder}/
 *       FileSystem/, HtmlPreview/, AppData/, Contacts/, MailAttachments/, Icons/, DPData/
 *       dptData.db        ← signature file (SQLite, primary data)
 *       dpData.db         (empty schema mirror — ignored)
 *       FileSystem.json   (file index, redundant w/ Files table)
 *       dpsmr             (binary signature — ignored)
 *     The extraction folder is typically nested inside
 *     {root}/{caseName}/exp{ts}/vpr-{ts}/{ts}-{platform}/  with a sibling
 *     dpCaseInfo.db (case-level metadata) one level up.
 *
 * Public API normalises both formats to the SAME `result` shape so all
 * downstream UI / analytics code stays unchanged.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// SQLite is only needed for DPX. Lazy-loaded so CSV-only environments don't
// fail if the native module is missing.
let _Database = null;
function _loadSqlite() {
    if (_Database) return _Database;
    try {
        _Database = require('better-sqlite3');
        return _Database;
    } catch (e) {
        const err = new Error('better-sqlite3 is required to parse Datapilot DPX (SQLite) folders. Run `npm install better-sqlite3` and rebuild against Electron.');
        err.cause = e;
        throw err;
    }
}

class DatapilotParser {
    constructor() {
        this.SIGNATURE_FILE = 'Summary_CaseAndAcquisitionInformation.csv';
        this.DPX_SIGNATURE_FILE = 'dptData.db';
    }

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Quick check: is this folder a Datapilot export of EITHER format?
     * @param {string} folderPath
     * @returns {boolean}
     */
    static isDatapilotFolder(folderPath) {
        return DatapilotParser.isDatapilotCsvFolder(folderPath)
            || DatapilotParser.isDatapilotDpxFolder(folderPath);
    }

    /**
     * Detect Datapilot CSV export (legacy format).
     * @param {string} folderPath
     * @returns {boolean}
     */
    static isDatapilotCsvFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath)) return false;
            const stat = fs.statSync(folderPath);
            if (!stat.isDirectory()) return false;
            const sig = path.join(folderPath, 'Summary_CaseAndAcquisitionInformation.csv');
            return fs.existsSync(sig);
        } catch (_) {
            return false;
        }
    }

    /**
     * Detect Datapilot DPX (Datapilot 10) export by SQLite signature.
     * @param {string} folderPath
     * @returns {boolean}
     */
    static isDatapilotDpxFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath)) return false;
            const stat = fs.statSync(folderPath);
            if (!stat.isDirectory()) return false;
            const sig = path.join(folderPath, 'dptData.db');
            if (!fs.existsSync(sig)) return false;
            // Sanity-check size — empty schema mirror dpData.db is similar but tiny.
            // dptData.db with real data is always >100KB even for sparse extracts.
            const fstat = fs.statSync(sig);
            return fstat.size > 32 * 1024; // 32KB threshold
        } catch (_) {
            return false;
        }
    }

    /**
     * Return 'csv' | 'dpx' | null for the folder (without throwing).
     */
    static detectFormat(folderPath) {
        if (DatapilotParser.isDatapilotDpxFolder(folderPath)) return 'dpx';
        if (DatapilotParser.isDatapilotCsvFolder(folderPath)) return 'csv';
        return null;
    }

    /**
     * Recursively scan a directory tree for Datapilot folders (BOTH formats).
     * Skips hidden + node_modules + heavy data subdirs (they never contain a
     * top-level signature themselves).
     * @param {string} rootPath
     * @param {number} maxDepth
     * @returns {Array<{folderPath: string, format: 'csv'|'dpx'}>}
     */
    static scanForDatapilotFolders(rootPath, maxDepth = 6) {
        const results = [];
        const skip = new Set([
            'node_modules', '.git', '.cache',
            'HtmlPreview', 'FileSystem', 'PhotoExif', 'AppData', 'DeletedData',
            'Contacts', 'MailAttachments', 'Icons', 'DPData',
        ]);

        function walk(dir, depth) {
            if (depth > maxDepth) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch (_) { return; }

            // Detect either format and DON'T recurse into a hit
            const fmt = DatapilotParser.detectFormat(dir);
            if (fmt) {
                results.push({ folderPath: dir, format: fmt });
                return;
            }

            for (const e of entries) {
                if (!e.isDirectory()) continue;
                if (e.name.startsWith('.')) continue;
                if (skip.has(e.name)) continue;
                walk(path.join(dir, e.name), depth + 1);
            }
        }

        walk(rootPath, 0);
        return results;
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Parse a Datapilot folder into structured data.
     * @param {string} folderPath
     * @returns {Promise<object>}
     */
    /**
     * Parse a Datapilot folder (auto-detects CSV vs DPX) into structured data.
     * @param {string} folderPath
     * @returns {Promise<object>}
     */
    async parseFolder(folderPath) {
        const fmt = DatapilotParser.detectFormat(folderPath);
        if (fmt === 'dpx') return this._parseDpxFolder(folderPath);
        if (fmt === 'csv') return this._parseCsvFolder(folderPath);
        throw new Error('Not a Datapilot folder (no Summary_CaseAndAcquisitionInformation.csv or dptData.db found)');
    }

    /**
     * Parse a Datapilot CSV (legacy) export folder.
     * @param {string} folderPath
     * @returns {Promise<object>}
     */
    async _parseCsvFolder(folderPath) {
        if (!DatapilotParser.isDatapilotCsvFolder(folderPath)) {
            throw new Error('Not a Datapilot CSV folder');
        }

        const result = {
            folderPath,
            format: 'csv',
            parsedAt: new Date().toISOString(),
            deviceInfo: null,
            summary: {},
            contacts: [],
            messages: [],
            calls: [],
            calendar: [],
            apps: [],
            media: [],          // photos + videos + thumbnails
            files: [],          // generic files (audio/text/db/compressed)
            deleted: [],        // deleted data index entries
            appDataIndex: [],   // index of available per-app data CSVs
            photoExifByHash: {},// SHA → { gps?, dateTaken?, make, model, ... }
            stats: {},
            warnings: [],
        };

        // Summary files
        result.summary = await this._parseSummary(folderPath);
        result.deviceInfo = await this._parseDeviceInfo(folderPath);

        // Contacts (primary)
        result.contacts = await this._parseContacts(folderPath);

        // Apps
        result.apps = await this._parseApplications(folderPath);

        // Media (photos + videos)
        result.media = await this._parseMedia(folderPath);

        // Other files
        result.files = await this._parseFiles(folderPath);

        // Deleted data + AppData indexes
        result.deleted = await this._parseDeletedIndex(folderPath);
        result.appDataIndex = await this._parseAppDataIndex(folderPath);

        // Calls (from DeletedData/calllog_db.csv — mostly hex blobs, surface as raw rows)
        result.calls = await this._parseCallLogDeleted(folderPath);

        // Messages (from AppData/com.android.providers.telephony_Correspondence.csv)
        result.messages = await this._parseMessages(folderPath);

        // Calendar (deleted hex blob — show as raw)
        result.calendar = await this._parseCalendarDeleted(folderPath);

        // PhotoExif (per-photo lookup by SHA hash from media row)
        result.photoExifByHash = await this._parseAllPhotoExif(folderPath, result.media);

        // Stats
        result.stats = this._computeStats(result);

        return result;
    }

    // ─── DPX parser (Datapilot 10 SQLite format) ────────────────────────

    /**
     * Parse a Datapilot DPX (SQLite) extraction folder.
     * @param {string} folderPath
     * @returns {Promise<object>}
     */
    async _parseDpxFolder(folderPath) {
        if (!DatapilotParser.isDatapilotDpxFolder(folderPath)) {
            throw new Error('Not a Datapilot DPX folder (missing dptData.db)');
        }

        const Database = _loadSqlite();
        const dbPath = path.join(folderPath, 'dptData.db');

        // Open read-only — dptData.db may be on a USB drive / read-only media.
        // Do NOT change journal_mode on a readonly handle (raises "disk I/O error" on some media).
        let db;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
        } catch (e) {
            throw new Error(`Failed to open ${dbPath}: ${e.message}`);
        }

        // dpCaseInfo.db is one or two levels up. Search a few candidates.
        const caseDb = this._findDpxCaseDb(folderPath);

        const result = {
            folderPath,
            format: 'dpx',
            parsedAt: new Date().toISOString(),
            deviceInfo: null,
            summary: {},
            contacts: [],
            messages: [],
            calls: [],
            calendar: [],
            apps: [],
            media: [],
            files: [],
            deleted: [],          // SUMMARY only — full rows loaded on demand
            appDataIndex: [],
            photoExifByHash: {},
            stats: {},
            warnings: [],
            // DPX-specific bonus fields (extra, harmless to existing UI):
            chats: [],            // explicit conversation grouping
            dpxPaths: {
                extractionRoot: folderPath,
                dptDataDb: dbPath,
                caseInfoDb: caseDb,
                fileSystemRoot: path.join(folderPath, 'FileSystem'),
                htmlPreviewRoot: path.join(folderPath, 'HtmlPreview'),
                appDataRoot: path.join(folderPath, 'AppData'),
                contactsRoot: path.join(folderPath, 'Contacts'),
                iconsRoot: path.join(folderPath, 'Icons'),
            },
        };

        try {
            // Summary + device info
            result.summary = this._dpxParseSummary(db, caseDb);
            result.deviceInfo = this._dpxParseDeviceInfo(db, caseDb);

            // Contacts
            result.contacts = this._dpxParseContacts(db);

            // Apps
            result.apps = this._dpxParseApps(db);

            // Media + files (single Files table, partitioned by FileType)
            const filesPart = this._dpxParseFiles(db, folderPath);
            result.media = filesPart.media;
            result.files = filesPart.files;

            // Chats + Messages
            const chatsAndMessages = this._dpxParseChatsAndMessages(db);
            result.chats = chatsAndMessages.chats;
            result.messages = chatsAndMessages.messages;

            // Calls
            result.calls = this._dpxParseCalls(db);

            // Calendar
            result.calendar = this._dpxParseCalendar(db);

            // App data index (top-level apps with extracted data)
            result.appDataIndex = this._dpxParseAppDataIndex(db);

            // Deleted: SUMMARY ONLY (per user decision — 27K rows on demand)
            result.deleted = this._dpxParseDeletedSummary(db);

            // Photo EXIF — by hash, from ExifTag + GeoMetadata
            result.photoExifByHash = this._dpxParsePhotoExif(db, result.media);

            result.stats = this._computeStats(result);
        } finally {
            try { db.close(); } catch (_) {}
        }

        return result;
    }

    /**
     * Search a few candidate locations for dpCaseInfo.db (case-level metadata).
     * Layout: {root}/{caseName}/exp{ts}/vpr-{ts}/dpCaseInfo.db
     * extraction folder is {root}/{caseName}/exp{ts}/vpr-{ts}/{ts}-{platform}/
     * → so dpCaseInfo.db is one level up from the extraction folder.
     */
    _findDpxCaseDb(extractionFolder) {
        try {
            const candidates = [
                path.join(extractionFolder, 'dpCaseInfo.db'),
                path.join(extractionFolder, '..', 'dpCaseInfo.db'),
                path.join(extractionFolder, '..', '..', 'dpCaseInfo.db'),
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) return path.resolve(c);
            }
        } catch (_) {}
        return null;
    }

    // Open a secondary read-only SQLite (caller closes).
    _dpxOpenReadonly(dbPath) {
        if (!dbPath || !fs.existsSync(dbPath)) return null;
        try {
            const Database = _loadSqlite();
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            return db;
        } catch (_) {
            return null;
        }
    }

    /** Try-parse a JSON cell that may be NULL/empty/string. */
    _dpxJson(val, fallback) {
        if (val === null || val === undefined || val === '') return fallback;
        if (typeof val !== 'string') return val;
        try { return JSON.parse(val); } catch (_) { return fallback; }
    }

    /** Convert SQLite datetime ('YYYY-MM-DD HH:MM:SS' or ISO) to ISO string. */
    _dpxIso(s) {
        if (!s) return '';
        const str = String(s).trim();
        if (!str) return '';
        // SQLite stores datetimes as 'YYYY-MM-DD HH:MM:SS' (UTC assumed)
        // Convert to ISO. Pass through if already ISO.
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(str)) {
            const norm = str.replace(' ', 'T');
            // If no timezone marker, treat as UTC
            const withTz = /[zZ]|[+-]\d{2}:\d{2}$/.test(norm) ? norm : norm + 'Z';
            const d = new Date(withTz);
            if (!isNaN(d.getTime())) return d.toISOString();
        }
        const d = new Date(str);
        return isNaN(d.getTime()) ? '' : d.toISOString();
    }

    /** Parse ISO-8601 duration "PT0H0M5S" → seconds. */
    _dpxDurationSeconds(iso) {
        if (!iso) return 0;
        const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i);
        if (!m) return 0;
        const h = parseInt(m[1] || '0', 10);
        const mn = parseInt(m[2] || '0', 10);
        const s = parseFloat(m[3] || '0');
        return Math.round(h * 3600 + mn * 60 + s);
    }

    _dpxFileTypeToMediaKind(fileType, name) {
        const t = String(fileType || '').toLowerCase();
        if (t === 'camera' || t === 'otherimage') return { isMedia: true, mediaType: 'photo' };
        if (t === 'thumbnailimage') return { isMedia: true, mediaType: 'thumbnail' };
        if (t === 'video') return { isMedia: true, mediaType: 'video' };
        if (t === 'audio') return { isMedia: true, mediaType: 'audio' };
        // Some FileTypes can leak through with mixed case or "Image" — fallback to ext
        const ext = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        if (ext) {
            const e = ext[1];
            if (['jpg','jpeg','png','gif','webp','bmp','heic','heif'].includes(e)) return { isMedia: true, mediaType: 'photo' };
            if (['mp4','m4v','mov','avi','mkv','webm','3gp'].includes(e)) return { isMedia: true, mediaType: 'video' };
            if (['mp3','m4a','wav','aac','ogg','flac','opus','amr'].includes(e)) return { isMedia: true, mediaType: 'audio' };
        }
        return { isMedia: false, mediaType: '', kind: t || 'other' };
    }

    // ── DPX section parsers ─────────────────────────────────────────────

    _dpxParseSummary(db, caseDbPath) {
        const summary = {};
        try {
            const acq = db.prepare(`SELECT Summary, ConsentInfo, ActivityTrail FROM AcquisitionSummary LIMIT 1`).get();
            if (acq) {
                summary.acquisition = this._dpxJson(acq.Summary, {}) || {};
                summary.consent     = this._dpxJson(acq.ConsentInfo, {}) || {};
                summary.activity    = this._dpxJson(acq.ActivityTrail, []) || [];
            }
        } catch (_) {}

        // Case info from sibling dpCaseInfo.db
        if (caseDbPath) {
            const cdb = this._dpxOpenReadonly(caseDbPath);
            if (cdb) {
                try {
                    const c = cdb.prepare(`SELECT * FROM CaseData LIMIT 1`).get();
                    if (c) summary.caseInfo = c;
                    const a = cdb.prepare(`SELECT * FROM Acquisition LIMIT 1`).get();
                    if (a) summary.caseAcquisition = a;
                } catch (_) {}
                try { cdb.close(); } catch (_) {}
            }
        }

        return summary;
    }

    _dpxParseDeviceInfo(db, caseDbPath) {
        let devInfo = null;
        try {
            const r = db.prepare(`SELECT DeviceInfo, ExternalDeviceInfo FROM DeviceInfoSummary LIMIT 1`).get();
            if (r) {
                const d = this._dpxJson(r.DeviceInfo, null);
                if (d) devInfo = d;
            }
        } catch (_) {}

        // Some versions nest DeviceInfo inside an array or wrap it. Flatten common shapes.
        if (Array.isArray(devInfo)) devInfo = devInfo[0] || {};
        if (!devInfo) devInfo = {};

        // Project to canonical shape used by CSV path
        const get = (...keys) => {
            for (const k of keys) {
                if (devInfo[k] !== undefined && devInfo[k] !== null && String(devInfo[k]).trim() !== '') {
                    return String(devInfo[k]);
                }
            }
            return '';
        };

        const out = {
            make:        get('Make', 'Manufacturer', 'Vendor', 'Brand'),
            model:       get('Model', 'DeviceModel', 'ModelName', 'Product'),
            phoneNumber: get('PhoneNumber', 'Phone Number', 'MSISDN'),
            carrier:     get('Carrier', 'WirelessCarrier', 'Wireless Carrier', 'Operator'),
            serial:      get('Serial', 'SerialNumber', 'Serial Number', 'IMEI'),
            firmware:    get('Firmware', 'FirmwareVersion', 'Firmware Version', 'OS', 'OSVersion', 'AndroidVersion'),
            clockUtc:    get('ClockUtc', 'Clock', 'Clock (UTC)', 'CurrentTime'),
            timeZone:    get('TimeZone', 'Time Zone'),
        };

        // Fallback: pull from caseInfoDb.DeviceInfo if we got nothing
        if (!out.make && !out.model && caseDbPath) {
            const cdb = this._dpxOpenReadonly(caseDbPath);
            if (cdb) {
                try {
                    const r = cdb.prepare(`SELECT * FROM DeviceInfo LIMIT 1`).get();
                    if (r) {
                        out.make = out.make || r.Make || r.Vendor || '';
                        out.model = out.model || r.Model || '';
                        out.phoneNumber = out.phoneNumber || r.PhoneNumber || '';
                        out.serial = out.serial || r.Serial || r.IMEI || '';
                    }
                } catch (_) {}
                try { cdb.close(); } catch (_) {}
            }
        }

        return out;
    }

    _dpxParseContacts(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`
                SELECT ContactUUID, AccountName, AccountType, Birthday, CreatedTime, Deleted,
                       DisplayName, EmailAddresses, FullName, FirstName, LastName, MiddleName,
                       NickName, Notes, OtherContactDetails, PhoneNumbers, PhotoPath,
                       PostalAddresses, Websites, LastUpdatedTime, IsFavorite, FileAs, Prefix, Suffix
                FROM Contacts
            `).all();
        } catch (e) {
            return out;
        }

        let no = 0;
        for (const r of rows) {
            no++;
            const phonesArr = this._dpxJson(r.PhoneNumbers, []) || [];
            const emailsArr = this._dpxJson(r.EmailAddresses, []) || [];
            const postalArr = this._dpxJson(r.PostalAddresses, []) || [];
            const notesArr  = this._dpxJson(r.Notes, []) || [];
            const websitesArr = this._dpxJson(r.Websites, []) || [];

            // Phone JSON shape: [{ Number, Label, IsPrimary, ... }, ...]
            const phones = phonesArr.map(p =>
                typeof p === 'string' ? p
                    : (p && (p.Number || p.PhoneNumber || p.Value)) || ''
            ).filter(Boolean);

            const emails = emailsArr.map(e =>
                typeof e === 'string' ? e
                    : (e && (e.Address || e.Email || e.Value)) || ''
            ).filter(Boolean);

            const postal = postalArr.map(p => {
                if (typeof p === 'string') return p;
                if (!p) return '';
                return [p.Street, p.City, p.Region, p.PostalCode, p.Country].filter(Boolean).join(', ');
            }).filter(Boolean).join(' | ');

            const notes = notesArr.map(n =>
                typeof n === 'string' ? n : (n && (n.Note || n.Value)) || ''
            ).filter(Boolean).join('; ');

            const name = r.DisplayName || r.FullName ||
                [r.FirstName, r.MiddleName, r.LastName].filter(Boolean).join(' ').trim() ||
                phones[0] || '';

            out.push({
                no,
                uuid: r.ContactUUID || '',
                name,
                photo: r.PhotoPath || '',
                phones,
                emails,
                created: this._dpxIso(r.CreatedTime),
                accountType: r.AccountType || '',
                accountName: r.AccountName || '',
                groupName: '',
                lastUpdated: this._dpxIso(r.LastUpdatedTime),
                notes,
                postal,
                organizations: '',
                isFavorite: !!r.IsFavorite,
                deleted: !!r.Deleted,
            });
        }
        return out;
    }

    _dpxParseApps(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`SELECT ID, AppID, DisplayName, Version, IsSuspicious, IconPath FROM AppInfo`).all();
        } catch (e) { return out; }

        let no = 0;
        for (const r of rows) {
            no++;
            out.push({
                no: r.ID || no,
                appId: r.AppID || '',
                displayName: r.DisplayName || '',
                version: r.Version || '',
                isPrivate: !!r.IsSuspicious, // CSV used "isPrivate" — repurpose for "suspicious"
                iconPath: r.IconPath || '',
            });
        }
        return out;
    }

    _dpxParseFiles(db, extractionRoot) {
        const media = [];
        const files = [];
        let rows;
        try {
            rows = db.prepare(`
                SELECT FileUUID, ReportUUID, Path, SrcPath, ThumbnailPath, Name, FileType,
                       DateTimeTaken, LastModifiedUtc, LastModifiedLocal,
                       SHA3, SHA256, MD5, Size, Dimension, GpsCoordinates, Model,
                       IsImage, Deleted
                FROM Files
            `).all();
        } catch (e) {
            return { media, files };
        }

        let mNo = 0, fNo = 0;
        for (const r of rows) {
            const cls = this._dpxFileTypeToMediaKind(r.FileType, r.Name);
            const exifHash = (r.SHA256 || r.SHA3 || '').toLowerCase();

            // Path normalization — DPX uses forward slashes already, prefix with extraction root
            const relPath = (r.Path || '').replace(/\\/g, '/');
            const absPath = relPath ? path.join(extractionRoot, relPath) : '';
            const thumbRel = (r.ThumbnailPath || '').replace(/\\/g, '/');

            if (cls.isMedia) {
                mNo++;
                media.push({
                    mediaType: cls.mediaType,
                    no: mNo,
                    fileName: r.Name || '',
                    fileSystemPath: relPath,         // relative to extraction root (matches CSV semantics)
                    absolutePath: absPath,           // absolute (DPX-only convenience)
                    previewPath: thumbRel,
                    sourcePath: r.SrcPath || '',
                    sizeStr: r.Size ? this._fmtBytes(r.Size) : '',
                    sizeBytes: r.Size || 0,
                    sha3: r.SHA3 || '',
                    sha256: r.SHA256 || '',
                    md5: r.MD5 || '',
                    lastModified: this._dpxIso(r.LastModifiedLocal || r.LastModifiedUtc),
                    dateTaken: this._dpxIso(r.DateTimeTaken),
                    dimension: r.Dimension || '',
                    cameraModel: r.Model || '',
                    gpsRaw: r.GpsCoordinates || '',
                    isDeleted: !!r.Deleted,
                    exifData: '',                    // populated separately if needed
                    exifHash,
                });
            } else {
                fNo++;
                files.push({
                    kind: cls.kind || 'other',
                    no: fNo,
                    fileName: r.Name || '',
                    fileSystemPath: relPath,
                    absolutePath: absPath,
                    sourcePath: r.SrcPath || '',
                    sizeStr: r.Size ? this._fmtBytes(r.Size) : '',
                    sizeBytes: r.Size || 0,
                    sha3: r.SHA3 || '',
                    sha256: r.SHA256 || '',
                    md5: r.MD5 || '',
                    lastModified: this._dpxIso(r.LastModifiedLocal || r.LastModifiedUtc),
                });
            }
        }
        return { media, files };
    }

    _dpxParseChatsAndMessages(db) {
        const chats = [];
        const messages = [];

        let chatRows = [];
        try {
            chatRows = db.prepare(`
                SELECT ChatUUID, ChatStyle, ServiceName, ChatOwner, Title, MessageDateTime,
                       Participants, LastMessage, MessageCount, IsArchived, IsHidden, IsRemoved
                FROM Chats
            `).all();
        } catch (_) {}

        const chatById = new Map();
        for (const r of chatRows) {
            const participants = this._dpxJson(r.Participants, []) || [];
            const partsArr = Array.isArray(participants) ? participants : [participants];
            const chat = {
                chatUuid: r.ChatUUID || '',
                style: r.ChatStyle || '',           // "Single" | "Group"
                service: r.ServiceName || '',
                owner: r.ChatOwner || '',
                title: r.Title || '',
                lastMessageAt: this._dpxIso(r.MessageDateTime),
                participants: partsArr.map(p => typeof p === 'string' ? p : (p && (p.Name || p.Address)) || '').filter(Boolean),
                lastMessage: r.LastMessage || '',
                messageCount: r.MessageCount || 0,
                isArchived: !!r.IsArchived,
                isHidden: !!r.IsHidden,
                isRemoved: !!r.IsRemoved,
            };
            chats.push(chat);
            chatById.set(chat.chatUuid, chat);
        }

        let msgRows = [];
        try {
            msgRows = db.prepare(`
                SELECT MessageUUID, ChatUUID, MessageType, MessageBox, DateTime, DateTimeSpan,
                       DateRead, DateDelivered, DateEdited, DateDeleted,
                       MessageFrom, MessageTo, MessageCc, MessageBcc, Name, Subject, Body,
                       Status, Read, Deleted, Delivered, Forward, AudioMessage, Played, Seen,
                       MailAttachments, GUID, ReplyToThreadGUID
                FROM Messages
                ORDER BY DateTime ASC
            `).all();
        } catch (_) {}

        for (const r of msgRows) {
            const box = String(r.MessageBox || '').toLowerCase();
            const isOutgoing = box === 'sent' || box === 'outbox' || box === 'sending';
            const direction = isOutgoing ? 'outgoing' : (box ? 'incoming' : 'unknown');
            const address = isOutgoing
                ? (r.MessageTo || r.MessageBcc || r.MessageCc || '')
                : (r.MessageFrom || r.MessageTo || '');
            const chat = chatById.get(r.ChatUUID);
            const msgType = String(r.MessageType || '').toLowerCase();
            const attachments = this._dpxJson(r.MailAttachments, []) || [];

            messages.push({
                uid: r.MessageUUID || '',
                chatUuid: r.ChatUUID || '',
                chatTitle: chat ? chat.title : '',
                chatStyle: chat ? chat.style : '',
                service: chat ? chat.service : (msgType === 'sms' || msgType === 'mms' ? 'Telephony' : ''),
                timestamp: r.DateTime || '',
                timestampIso: this._dpxIso(r.DateTime),
                type: msgType + (direction === 'outgoing' ? ' outgoing' : ' incoming'),
                direction,
                address: String(address || '').trim(),
                text: r.Body || '',
                subject: r.Subject || '',
                serviceCenter: '',
                isRead: !!r.Read,
                isDeleted: !!r.Deleted,
                attachments: Array.isArray(attachments) ? attachments : [],
            });
        }

        return { chats, messages };
    }

    _dpxParseCalls(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`
                SELECT CallHistoryUUID, DateTime, DateTimeSpan, Type, Name, Number,
                       Label, Duration, Provider, CountryCode, Location, VoicemailLink, Deleted
                FROM CallHistory
                ORDER BY DateTime ASC
            `).all();
        } catch (_) { return out; }

        let no = 0;
        for (const r of rows) {
            no++;
            const t = String(r.Type || '').toUpperCase();
            const direction =
                t.includes('OUTGOING') || t.includes('DIALED') ? 'outgoing'
                : t.includes('INCOMING') || t.includes('RECEIVED') ? 'incoming'
                : t.includes('MISSED') ? 'missed'
                : t.includes('VOICEMAIL') || t.includes('REJECTED') ? 'incoming'
                : 'unknown';
            const durSec = this._dpxDurationSeconds(r.Duration);

            out.push({
                no,
                uid: r.CallHistoryUUID || '',
                timestamp: r.DateTime || '',
                timestampIso: this._dpxIso(r.DateTime),
                type: t.replace(/^TYPE_/, '').toLowerCase(),
                direction,
                name: r.Name || '',
                number: r.Number || '',
                address: r.Number || '',          // alias for analytics compat
                duration: durSec,
                durationIso: r.Duration || '',
                provider: r.Provider || '',
                countryCode: r.CountryCode || '',
                location: r.Location || '',
                summary: [r.Name, r.Number, r.Location].filter(Boolean).join(' • '),
                isDeleted: !!r.Deleted,
                // Backward-compat fields (CSV path emitted these for hex-blob carved rows)
                source: r.Provider || '',
                deletedData: '',
                hexDump: '',
            });
        }
        return out;
    }

    _dpxParseCalendar(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`
                SELECT CalendarUUID, StartDateTime, EndDateTime, Title, Description, Location,
                       Duration, AllDay, Organizer, Notes, CalendarTitle, URL,
                       LastModifiedTime, CreatedTime, Address, Longitude, Latitude,
                       Deleted, Attendees
                FROM Calendar
                ORDER BY StartDateTime ASC
            `).all();
        } catch (_) { return out; }

        let no = 0;
        for (const r of rows) {
            no++;
            out.push({
                no,
                uid: r.CalendarUUID || '',
                title: r.Title || '',
                description: r.Description || '',
                location: r.Location || r.Address || '',
                start: this._dpxIso(r.StartDateTime),
                end: this._dpxIso(r.EndDateTime),
                allDay: !!r.AllDay,
                organizer: r.Organizer || '',
                notes: r.Notes || '',
                calendarTitle: r.CalendarTitle || '',
                url: r.URL || '',
                created: this._dpxIso(r.CreatedTime),
                lastModified: this._dpxIso(r.LastModifiedTime),
                lat: parseFloat(r.Latitude) || null,
                lon: parseFloat(r.Longitude) || null,
                isDeleted: !!r.Deleted,
                attendees: this._dpxJson(r.Attendees, []) || [],
                // Backward-compat fields (CSV path emitted these for hex-blob carved rows)
                source: r.CalendarTitle || '',
                deletedData: '',
                hexDump: '',
            });
        }
        return out;
    }

    _dpxParseAppDataIndex(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`SELECT AppDataUUID, Caption, UniqueName, AppGroup, IconPath, AppDataEntityTitles FROM AppData`).all();
        } catch (_) { return out; }

        let no = 0;
        for (const r of rows) {
            no++;
            const titles = this._dpxJson(r.AppDataEntityTitles, []) || [];
            out.push({
                no,
                uuid: r.AppDataUUID || '',
                csvPath: '',                                    // DPX has no CSV path
                label: r.Caption || r.UniqueName || '',
                packageName: r.UniqueName || '',
                group: r.AppGroup || '',
                iconPath: r.IconPath || '',
                entityTitles: Array.isArray(titles) ? titles : [],
            });
        }
        return out;
    }

    _dpxParseDeletedSummary(db) {
        const out = [];
        let rows;
        try {
            rows = db.prepare(`SELECT DeletedDataSummaryUUID, Caption, UniqueName, NumberOfRecord, Path FROM DeletedDataSummary`).all();
        } catch (_) { return out; }

        let no = 0;
        for (const r of rows) {
            no++;
            out.push({
                no,
                uuid: r.DeletedDataSummaryUUID || '',
                csvPath: '',
                label: r.Caption || r.UniqueName || '',
                info: r.NumberOfRecord ? `${r.NumberOfRecord} records` : '',
                packageName: r.UniqueName || '',
                count: r.NumberOfRecord || 0,
                path: r.Path || '',
            });
        }
        return out;
    }

    _dpxParsePhotoExif(db, mediaList) {
        const out = {};
        // Build a SHA → media[] map so we can attach EXIF to media items.
        const byHash = {};
        for (const m of mediaList) {
            const h = (m.sha256 || m.sha3 || '').toLowerCase();
            if (h) byHash[h] = m;
        }

        // ExifTag rows are key/value per FieldName. Aggregate into per-MediaFileUUID maps.
        const tagsByMedia = new Map();
        try {
            const rows = db.prepare(`SELECT MediaFileUUID, FieldName, Value FROM ExifTag`).all();
            for (const r of rows) {
                if (!r.MediaFileUUID) continue;
                const m = tagsByMedia.get(r.MediaFileUUID) || {};
                if (r.FieldName) m[r.FieldName] = r.Value;
                tagsByMedia.set(r.MediaFileUUID, m);
            }
        } catch (_) {}

        // GeoMetadata rows give explicit lat/lon — easiest path.
        try {
            const rows = db.prepare(`SELECT PhotoUUID, Latitude, Longitude, DateTimeTaken FROM GeoMetadata WHERE PhotoUUID IS NOT NULL`).all();
            // Need media UUID → SHA mapping. Re-query Files for that.
            const fileSha = {};
            try {
                const f = db.prepare(`SELECT FileUUID, SHA256, SHA3, Model FROM Files`).all();
                for (const x of f) {
                    fileSha[x.FileUUID] = {
                        sha256: (x.SHA256 || '').toLowerCase(),
                        sha3: (x.SHA3 || '').toLowerCase(),
                        model: x.Model || '',
                    };
                }
            } catch (_) {}

            for (const r of rows) {
                const sha = fileSha[r.PhotoUUID];
                if (!sha) continue;
                const key = sha.sha256 || sha.sha3;
                if (!key) continue;
                const lat = parseFloat(r.Latitude);
                const lon = parseFloat(r.Longitude);
                if (isFinite(lat) && isFinite(lon)) {
                    out[key] = out[key] || {};
                    out[key].gps = { lat, lon };
                    if (r.DateTimeTaken) out[key].dateTaken = this._dpxIso(r.DateTimeTaken);
                    if (sha.model) out[key].model = sha.model;
                }
            }
        } catch (_) {}

        // Merge ExifTag rows for any media we already have via Files.SHA*
        for (const m of mediaList) {
            const key = (m.sha256 || m.sha3 || '').toLowerCase();
            if (!key) continue;
            const fileTags = tagsByMedia.get(m.no);   // unlikely match — MediaFileUUID is FileUUID
            // Instead, lookup ExifTag by file's UUID. We didn't carry FileUUID into media[], so skip
            // this path unless rows[0].MediaFileUUID === media.FileUUID later. Use Files.GpsCoordinates as fallback.
            if (m.gpsRaw && !out[key]?.gps) {
                const parsed = this._parseGpsCoordinatesText(m.gpsRaw);
                if (parsed) {
                    out[key] = out[key] || {};
                    out[key].gps = parsed;
                }
            }
            if (m.dateTaken && !(out[key] && out[key].dateTaken)) {
                out[key] = out[key] || {};
                out[key].dateTaken = m.dateTaken;
            }
            if (m.cameraModel && !(out[key] && out[key].model)) {
                out[key] = out[key] || {};
                out[key].model = m.cameraModel;
            }
            // Attach raw tags if present for this UUID
            const tags = tagsByMedia.get(fileTags && fileTags.MediaFileUUID);
            if (tags) {
                out[key] = out[key] || {};
                out[key].tags = tags;
            }
        }
        return out;
    }

    /** Parse "lat, lon" or "lat°N lon°W" style strings → {lat, lon} | null */
    _parseGpsCoordinatesText(s) {
        if (!s) return null;
        const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*[, ]+\s*(-?\d+(?:\.\d+)?)/);
        if (!m) return null;
        const lat = parseFloat(m[1]); const lon = parseFloat(m[2]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return { lat, lon };
    }

    _fmtBytes(n) {
        if (!n || n < 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    // ─── Section parsers ────────────────────────────────────────────────

    async _parseSummary(folderPath) {
        const summary = {};
        const files = [
            ['caseInfo', 'Summary_CaseAndAcquisitionInformation.csv'],
            ['acquisition', 'Summary_AcquisitionSummary.csv'],
            ['activity', 'Summary_ActivityTrail.csv'],
        ];
        for (const [key, name] of files) {
            const p = path.join(folderPath, name);
            const rows = await this._readCsvSafe(p);
            if (rows.length >= 2) {
                summary[key] = this._rowsToKeyedObject(rows);
            }
        }
        return summary;
    }

    async _parseDeviceInfo(folderPath) {
        const rows = await this._readCsvSafe(path.join(folderPath, 'DeviceInfo.csv'));
        if (rows.length < 2) return null;
        const obj = this._rowsToKeyedObject(rows);
        // Normalize
        return {
            make: obj['Make'] || '',
            model: obj['Model'] || '',
            phoneNumber: obj['Phone Number'] || '',
            carrier: obj['Wireless Carrier'] || '',
            serial: obj['Serial Number'] || '',
            firmware: obj['Firmware Version'] || '',
            clockUtc: obj['Clock (UTC)'] || '',
            timeZone: obj['Time Zone'] || '',
        };
    }

    async _parseContacts(folderPath) {
        const rows = await this._readCsvSafe(path.join(folderPath, 'Contacts.csv'));
        if (rows.length < 2) return [];
        const headers = rows[0];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            const obj = {};
            for (let c = 0; c < headers.length; c++) {
                obj[headers[c]] = row[c] || '';
            }
            const phones = this._splitMultiline(obj['Phone Numbers']);
            const emails = this._splitMultiline(obj['Email Addresses']);
            out.push({
                no: parseInt(obj['No.'] || obj['No'] || '0', 10) || (out.length + 1),
                name: obj['Name'] || '',
                photo: obj['Photo'] || '',
                phones,
                emails,
                created: obj['Created Time'] || '',
                accountType: obj['Account Type'] || '',
                accountName: obj['Account Name'] || '',
                groupName: obj['[Detail] Group Name'] || '',
                lastUpdated: obj['Last Updated Time'] || '',
                notes: obj['[Detail] Notes'] || '',
                postal: obj['[Detail] Postal Addresses'] || '',
                organizations: obj['[Detail] Organizations'] || '',
            });
        }
        return out;
    }

    async _parseApplications(folderPath) {
        const rows = await this._readCsvSafe(path.join(folderPath, 'Applications.csv'));
        if (rows.length < 2) return [];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            out.push({
                no: parseInt(row[0] || '0', 10) || (out.length + 1),
                appId: row[1] || '',
                displayName: row[2] || '',
                version: row[3] || '',
                isPrivate: (row[4] || '').toLowerCase() === 'yes',
            });
        }
        return out;
    }

    async _parseMedia(folderPath) {
        const out = [];
        const sources = [
            { file: 'OtherImageFiles1.csv',     mediaType: 'photo' },
            { file: 'CameraImageFile1.csv',     mediaType: 'photo' },
            { file: 'ThumbnailImageFiles1.csv', mediaType: 'thumbnail' },
            { file: 'VideoFiles1.csv',          mediaType: 'video' },
            { file: 'AudioFiles1.csv',          mediaType: 'audio' },
        ];
        for (const src of sources) {
            const p = path.join(folderPath, src.file);
            const rows = await this._readCsvSafe(p);
            if (rows.length < 2) continue;
            const headers = rows[0].map(h => (h || '').trim().replace(/:\s*$/, ''));
            for (let r = 1; r < rows.length; r++) {
                const row = rows[r];
                if (this._isFooterRow(row)) continue;
                const item = this._rowToObj(headers, row);
                const previewLink = src.mediaType === 'photo' || src.mediaType === 'thumbnail'
                    ? this._parseHyperlink(row[1] || '') : null;
                const fileLink = this._parseHyperlink(item['File Name'] || row[(src.mediaType === 'photo' || src.mediaType === 'thumbnail') ? 2 : 1] || '');
                out.push({
                    mediaType: src.mediaType,
                    no: parseInt(item['No'] || row[0] || '0', 10) || (out.length + 1),
                    fileName: fileLink ? fileLink.label : '',
                    fileSystemPath: fileLink ? fileLink.href : '',
                    previewPath: previewLink ? previewLink.href : '',
                    sourcePath: item['Source Path'] || '',
                    sizeStr: item['File Size'] || '',
                    sizeBytes: this._parseSizeBytes(item['File Size'] || ''),
                    sha3: item['SHA3'] || '',
                    sha256: item['SHA256'] || '',
                    lastModified: item['Last Modified Date (Local)'] || '',
                    exifData: item['EXIF Data'] || '',
                    exifHash: this._extractExifHash(item['EXIF Data'] || ''),
                });
            }
        }
        return out;
    }

    _extractExifHash(exifCell) {
        if (!exifCell) return '';
        const link = this._parseHyperlink(exifCell);
        if (!link || !link.href) return '';
        const base = link.href.replace(/^.*[\/\\]/, '').replace(/\.csv$/i, '');
        return base.toLowerCase();
    }

    async _parseFiles(folderPath) {
        const out = [];
        const sources = [
            { file: 'Files1.csv',           kind: 'other' },
            { file: 'DatabaseFiles1.csv',   kind: 'database' },
            { file: 'TextFiles1.csv',       kind: 'text' },
            { file: 'CompressedFiles1.csv', kind: 'compressed' },
        ];
        for (const src of sources) {
            const p = path.join(folderPath, src.file);
            const rows = await this._readCsvSafe(p);
            if (rows.length < 2) continue;
            const headers = rows[0].map(h => (h || '').trim().replace(/:\s*$/, ''));
            for (let r = 1; r < rows.length; r++) {
                const row = rows[r];
                if (this._isFooterRow(row)) continue;
                const item = this._rowToObj(headers, row);
                const fileLink = this._parseHyperlink(item['File Name'] || row[1] || '');
                out.push({
                    kind: src.kind,
                    no: parseInt(item['No'] || row[0] || '0', 10) || (out.length + 1),
                    fileName: fileLink ? fileLink.label : '',
                    fileSystemPath: fileLink ? fileLink.href : '',
                    sourcePath: item['Source Path'] || '',
                    sizeStr: item['File Size'] || '',
                    sizeBytes: this._parseSizeBytes(item['File Size'] || ''),
                    sha3: item['SHA3'] || '',
                    sha256: item['SHA256'] || '',
                    lastModified: item['Last Modified Date (Local)'] || '',
                });
            }
        }
        return out;
    }

    async _parseDeletedIndex(folderPath) {
        const rows = await this._readCsvSafe(path.join(folderPath, 'DeletedData.csv'));
        if (rows.length < 2) return [];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            const link = this._parseHyperlink(row[1] || '');
            out.push({
                no: parseInt(row[0] || '0', 10) || (out.length + 1),
                csvPath: link ? link.href : '',
                label: link ? link.label : '',
                info: row[2] || '',
            });
        }
        return out;
    }

    async _parseAppDataIndex(folderPath) {
        const rows = await this._readCsvSafe(path.join(folderPath, 'AppData.csv'));
        if (rows.length < 2) return [];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            const link = this._parseHyperlink(row[1] || '');
            out.push({
                no: parseInt(row[0] || '0', 10) || (out.length + 1),
                csvPath: link ? link.href : '',
                label: link ? link.label : '',
            });
        }
        return out;
    }

    async _parseMessages(folderPath) {
        const p = path.join(folderPath, 'AppData', 'com.android.providers.telephony_Correspondence.csv');
        const rows = await this._readCsvSafe(p);
        if (rows.length < 2) return [];
        const headers = rows[0].map(h => (h || '').trim());
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            const item = this._rowToObj(headers, row);
            const typeRaw = (item['Message Type'] || '').trim().toLowerCase();
            out.push({
                uid: (item['UID'] || '').trim(),
                timestamp: (item['Timestamp'] || '').trim(),
                timestampIso: this._parseDpDate(item['Timestamp'] || ''),
                type: typeRaw,                                    // outgoing|incoming SMS/MMS
                direction: typeRaw.startsWith('outgoing') ? 'outgoing' : (typeRaw.startsWith('incoming') ? 'incoming' : 'unknown'),
                address: (item['Address'] || '').trim(),
                text: item['Text'] || '',
                serviceCenter: (item['Service Center'] || '').trim(),
            });
        }
        return out;
    }

    async _parseCallLogDeleted(folderPath) {
        // calllog_db.csv contains mostly hex blob fragments — surface as raw rows for advanced viewing
        const p = path.join(folderPath, 'DeletedData', 'calllog_db.csv');
        const rows = await this._readCsvSafe(p);
        if (rows.length < 2) return [];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            out.push({
                no: parseInt(row[0] || '0', 10) || (out.length + 1),
                source: row[1] || '',
                deletedData: row[2] || '',
                hexDump: row[3] || '',
            });
        }
        return out;
    }

    async _parseCalendarDeleted(folderPath) {
        const p = path.join(folderPath, 'DeletedData', 'calendar_db.csv');
        const rows = await this._readCsvSafe(p);
        if (rows.length < 2) return [];
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (this._isFooterRow(row)) continue;
            out.push({
                no: parseInt(row[0] || '0', 10) || (out.length + 1),
                source: row[1] || '',
                deletedData: row[2] || '',
                hexDump: row[3] || '',
            });
        }
        return out;
    }

    async _parseAllPhotoExif(folderPath, mediaList) {
        const exifDir = path.join(folderPath, 'PhotoExif');
        const out = {};
        let entries;
        try { entries = await fsp.readdir(exifDir); }
        catch (_) { return out; }

        // Build set of SHA hashes referenced by media rows for fast lookup
        const mediaHashes = new Set();
        for (const m of mediaList) {
            if (m.sha3) mediaHashes.add(m.sha3.toLowerCase());
            if (m.sha256) mediaHashes.add(m.sha256.toLowerCase());
        }

        for (const name of entries) {
            if (!name.toLowerCase().endsWith('.csv')) continue;
            const sha = name.replace(/\.csv$/i, '').toLowerCase();
            const fp = path.join(exifDir, name);
            const obj = await this._parsePhotoExifFile(fp);
            if (obj) out[sha] = obj;
        }
        return out;
    }

    async _parsePhotoExifFile(filePath) {
        const rows = await this._readCsvSafe(filePath);
        if (!rows.length) return null;
        const kv = {};
        for (const row of rows) {
            if (this._isFooterRow(row)) continue;
            if (row.length < 2) continue;
            const key = (row[0] || '').replace(/[: ]+$/, '').trim();
            const val = row.slice(1).join(',').trim();
            if (!key) continue;
            kv[key] = val;
        }
        // Extract GPS if present
        const gps = this._extractGps(kv);
        return {
            name: kv['Name'] || '',
            size: parseInt(kv['Size'] || '0', 10) || 0,
            dimension: kv['Dimension'] || '',
            imageTakenDate: kv['Image Taken Date'] || '',
            lastModified: kv['Last Modified Date'] || '',
            make: kv['Image input equipment manufacturer'] || '',
            model: kv['Image input equipment model'] || '',
            software: kv['Software used'] || '',
            iso: kv['ISO speed rating'] || '',
            fNumber: kv['F number'] || '',
            exposureTime: kv['Exposure time'] || '',
            focalLength: kv['Lens focal length'] || '',
            flash: kv['Flash'] || '',
            orientation: kv['Orientation of image'] || '',
            colorSpace: kv['Color space information'] || '',
            sceneType: kv['Scene type'] || '',
            whiteBalance: kv['White balance'] || '',
            gps,
            raw: kv,
        };
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _extractGps(kv) {
        if (!kv['Latitude'] && !kv['GPS Data']) return null;
        const latStr = kv['Latitude'] || '';
        const lngStr = kv['Longitude'] || '';
        const ns = (kv['North or South Latitude'] || '').toUpperCase();
        const ew = (kv['East or West Longitude'] || '').toUpperCase();
        const lat = this._dmsToDecimal(latStr, ns);
        const lng = this._dmsToDecimal(lngStr, ew);
        const altStr = kv['Altitude'] || '';
        const altM = parseFloat((altStr.match(/-?[\d.]+/) || [''])[0]) || null;
        if (lat == null || lng == null) {
            // Fallback to GPS Data combined string
            const combined = kv['GPS Data'] || '';
            const m = combined.match(/([NS])\s*(\d+)°\s*(\d+)'?\s*([\d.]+)"?,\s*([EW])\s*(\d+)°\s*(\d+)'?\s*([\d.]+)"?/i);
            if (m) {
                const a = (parseFloat(m[2]) + parseFloat(m[3])/60 + parseFloat(m[4])/3600) * (m[1].toUpperCase() === 'S' ? -1 : 1);
                const b = (parseFloat(m[6]) + parseFloat(m[7])/60 + parseFloat(m[8])/3600) * (m[5].toUpperCase() === 'W' ? -1 : 1);
                return { lat: a, lng: b, altM, raw: combined };
            }
            return null;
        }
        return { lat, lng, altM, raw: kv['GPS Data'] || `${latStr} ${ns}, ${lngStr} ${ew}` };
    }

    _dmsToDecimal(dmsStr, hemisphere) {
        if (!dmsStr) return null;
        // Examples: "34° 9' 51.2"" / "117° 28' 56.46""
        const m = dmsStr.match(/(\d+(?:\.\d+)?)°?\s*(\d+(?:\.\d+)?)'?\s*([\d.]+)?"?/);
        if (!m) {
            const f = parseFloat(dmsStr);
            return isFinite(f) ? f : null;
        }
        const deg = parseFloat(m[1]) || 0;
        const min = parseFloat(m[2]) || 0;
        const sec = parseFloat(m[3]) || 0;
        let dec = deg + min/60 + sec/3600;
        if (hemisphere === 'S' || hemisphere === 'W') dec = -dec;
        return dec;
    }

    _parseHyperlink(cell) {
        if (!cell) return null;
        const s = String(cell);
        // =HYPERLINK("path","label")  or  =HYPERLINK("path")
        const m = s.match(/^=HYPERLINK\(\s*"([^"]*(?:""[^"]*)*)"(?:\s*,\s*"([^"]*(?:""[^"]*)*)")?\s*\)\s*$/);
        if (!m) {
            // Sometimes outer quotes already stripped by CSV parser → try simpler
            const m2 = s.match(/^=HYPERLINK\(\s*([^,)]+?)(?:\s*,\s*([^)]+))?\s*\)/);
            if (!m2) return null;
            return {
                href: m2[1].replace(/^"|"$/g, '').replace(/""/g, '"'),
                label: (m2[2] || m2[1]).replace(/^"|"$/g, '').replace(/""/g, '"'),
            };
        }
        return {
            href: m[1].replace(/""/g, '"'),
            label: (m[2] || m[1]).replace(/""/g, '"'),
        };
    }

    _parseSizeBytes(str) {
        if (!str) return 0;
        const m = String(str).match(/(-?[\d.]+)\s*(bytes|KB|MB|GB|TB)?/i);
        if (!m) return 0;
        const n = parseFloat(m[1]);
        const unit = (m[2] || 'bytes').toLowerCase();
        const mult = { bytes: 1, kb: 1024, mb: 1024**2, gb: 1024**3, tb: 1024**4 }[unit] || 1;
        return Math.round(n * mult);
    }

    _splitMultiline(s) {
        if (!s) return [];
        return String(s).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    }

    _isFooterRow(row) {
        if (!row || row.length === 0) return true;
        const joined = row.join(' ').trim();
        if (!joined) return true;
        if (/Note:\s*Excel may corrupt data/i.test(joined)) return true;
        return false;
    }

    _rowsToKeyedObject(rows) {
        // First row = headers, second row = values (and maybe 3+ rows of values for multi-line)
        const headers = rows[0];
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            const key = (headers[c] || '').trim();
            const vals = [];
            for (let r = 1; r < rows.length; r++) {
                if (this._isFooterRow(rows[r])) continue;
                if (rows[r][c]) vals.push(rows[r][c]);
            }
            obj[key] = vals.join(' | ');
        }
        return obj;
    }

    _rowToObj(headers, row) {
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = row[c] != null ? row[c] : '';
        }
        return obj;
    }

    /**
     * Parse a Datapilot date string (e.g. "5/1/2026 8:55:45 PM" or "2/2/2026 03:56:51")
     * Returns ISO string or null. Times are local; we don't apply tz here.
     */
    _parseDpDate(s) {
        if (!s) return null;
        const t = String(s).trim();
        if (!t) return null;
        const d = new Date(t);
        if (!isNaN(d.getTime())) return d.toISOString();
        return null;
    }

    _computeStats(result) {
        const photos = result.media.filter(m => m.mediaType === 'photo' || m.mediaType === 'thumbnail').length;
        const videos = result.media.filter(m => m.mediaType === 'video').length;
        const audio  = result.media.filter(m => m.mediaType === 'audio').length;
        let gpsCount = 0;
        for (const k in result.photoExifByHash) {
            if (result.photoExifByHash[k] && result.photoExifByHash[k].gps) gpsCount++;
        }
        return {
            contacts: result.contacts.length,
            messages: result.messages.length,
            calls: result.calls.length,
            calendarEntries: result.calendar.length,
            apps: result.apps.length,
            photos,
            videos,
            audio,
            files: result.files.length,
            deletedSources: result.deleted.length,
            appDataSources: result.appDataIndex.length,
            photosWithGps: gpsCount,
        };
    }

    // ─── Low-level CSV reader ───────────────────────────────────────────

    async _readCsvSafe(filePath) {
        try {
            const buf = await fsp.readFile(filePath);
            // Strip BOM
            let text = buf.toString('utf8');
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            return this._parseCsv(text);
        } catch (_) {
            return [];
        }
    }

    /**
     * State-machine CSV parser handling multi-line quoted fields.
     * Ported from VIPER's google-warrant-parser._parseCsvFull.
     */
    _parseCsv(csvStr) {
        const records = [];
        let current = [];
        let field = '';
        let inQuotes = false;
        let i = 0;

        while (i < csvStr.length) {
            const ch = csvStr[i];

            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < csvStr.length && csvStr[i + 1] === '"') {
                        field += '"';
                        i += 2;
                    } else {
                        inQuotes = false;
                        i++;
                    }
                } else {
                    field += ch;
                    i++;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                    i++;
                } else if (ch === ',') {
                    current.push(field);
                    field = '';
                    i++;
                } else if (ch === '\n' || (ch === '\r' && i + 1 < csvStr.length && csvStr[i + 1] === '\n')) {
                    current.push(field);
                    field = '';
                    if (current.some(f => f && f.toString().trim())) records.push(current);
                    current = [];
                    i += (ch === '\r') ? 2 : 1;
                } else if (ch === '\r') {
                    current.push(field);
                    field = '';
                    if (current.some(f => f && f.toString().trim())) records.push(current);
                    current = [];
                    i++;
                } else {
                    field += ch;
                    i++;
                }
            }
        }

        if (field || current.length > 0) {
            current.push(field);
            if (current.some(f => f && f.toString().trim())) records.push(current);
        }

        return records;
    }
}

module.exports = DatapilotParser;
