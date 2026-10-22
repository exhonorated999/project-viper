/**
 * Google Warrant Parser
 * Parses Google warrant return ZIP-of-ZIPs archives
 * Runs in Electron main process (Node.js) — uses node-stream-zip (via the
 * shared ZipReader), node-html-parser, mailparser
 *
 * Accepts either a Buffer (legacy / small in-memory case) or a file path
 * (preferred — required for warrant returns over 2 GB).
 */

const AdmZip = require('adm-zip'); // retained for any external callers
const { parse: parseHTML } = require('node-html-parser');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs   = require('fs');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');
const { openZip } = require('../_shared/zip-reader');

// ─── Memory guards (large returns — dozens of GB) ───────────────────────
// Inner zips above this are extracted to a temp file and read from disk
// instead of being held in a Buffer.
const INNER_BUFFER_MAX = 32 * 1024 * 1024;
// A single non-streamed file (HTML / CSV / JSON) above this is not parsed;
// it is copied out to the case folder so nothing is lost.
const MAX_INLINE_ENTRY = 64 * 1024 * 1024;
// One e-mail above this keeps its first 64 MB (attachments are the bulk).
const MBOX_MESSAGE_MAX = 64 * 1024 * 1024;
// Arrays kept in the import record (which lives in localStorage).
const INLINE_ROW_CAP = 10000;
const INLINE_EMAIL_CAP = 5000;       // only when no SQLite store is attached
const INLINE_LOCATION_CAP = 20000;   // only when no SQLite store is attached
const INLINE_TEXT_CAP = 2 * 1024 * 1024;
const RESULT_CHAR_BUDGET = 16 * 1000 * 1000;

const FOLDER_SCAN_DEPTH = 4;
const FOLDER_EXTS = /\.(zip|pdf|mbox)$/i;

/**
 * A folder of Google's per-product ZIPs, presented with the ZipReader
 * surface the parser uses.  Each entry carries `_path`, so the parser opens
 * the inner ZIP straight from disk — the files are never read into memory
 * (the old code read every file and re-zipped the folder in a Buffer, which
 * crashed VIPER on large returns).
 */
class FolderReader {
    constructor(root, options = {}) {
        this.root = root;
        this.security = options.security || null;
        this._skip = new Set((options.skipDirs || []).filter(Boolean).map(d => path.resolve(d).toLowerCase()));
        this._entries = null;
    }

    getEntries() {
        if (this._entries) return this._entries;
        const out = [];
        const walk = (dir, rel, depth) => {
            let names;
            try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const d of names) {
                const full = path.join(dir, d.name);
                const relName = rel ? `${rel}/${d.name}` : d.name;
                if (d.isDirectory()) {
                    if (depth >= FOLDER_SCAN_DEPTH) continue;
                    if (d.name === '_store' || this._skip.has(path.resolve(full).toLowerCase())) continue;
                    walk(full, relName, depth + 1);
                } else if (d.isFile() && FOLDER_EXTS.test(d.name)) {
                    let size = 0;
                    try { size = fs.statSync(full).size; } catch (_) {}
                    out.push({
                        entryName: relName,
                        isDirectory: false,
                        size,
                        _path: full,
                        getData() { return fs.readFileSync(full); },
                    });
                }
            }
        };
        walk(this.root, '', 0);
        this._entries = out;
        return out;
    }

    _isEncrypted(p) {
        const s = this.security;
        if (!s || !s.isUnlocked || !s.isUnlocked() || !s.isEncryptedBuffer) return false;
        try {
            const fd = fs.openSync(p, 'r');
            try {
                const b = Buffer.alloc(8);
                fs.readSync(fd, b, 0, 8, 0);
                return s.isEncryptedBuffer(b);
            } finally { fs.closeSync(fd); }
        } catch (_) { return false; }
    }

    openStream(entry) {
        if (this._isEncrypted(entry._path)) {
            return Promise.resolve(Readable.from([this.security.decryptBuffer(fs.readFileSync(entry._path))]));
        }
        return Promise.resolve(fs.createReadStream(entry._path, { highWaterMark: 1024 * 1024 }));
    }

    extractEntryToFile(entry, dest) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry._path, dest);
        return Promise.resolve();
    }

    close() {}
}

/**
 * Stream the items of one JSON array out of a (possibly multi-GB) JSON
 * document without parsing the whole document.
 *   arrayKey = 'locations' → the array under the root object's "locations"
 *   arrayKey = null        → the root value is itself the array
 * Each object item is JSON.parse'd on its own and handed to onItem (awaited).
 */
async function streamJsonArray(readable, arrayKey, onItem, opts = {}) {
    const maxItem = opts.maxItemChars || 16 * 1024 * 1024;
    const dec = new StringDecoder('utf8');
    let depth = 0, inStr = false, esc = false;
    let keyBuf = null, lastStr = null;
    let inTarget = false, done = false, targetDepth = -1;
    let parts = null, partLen = 0, tooBig = false;
    const stats = { found: false, items: 0, bad: 0, oversized: 0 };

    const run = async (s) => {
        let start = parts ? 0 : -1;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c === 92) esc = true;
                else if (c === 34) { inStr = false; if (keyBuf !== null) { lastStr = keyBuf; keyBuf = null; } continue; }
                if (keyBuf !== null && keyBuf.length < 200) keyBuf += s[i];
                continue;
            }
            if (c === 34) {
                inStr = true;
                if (!inTarget && depth === 1) keyBuf = '';
            } else if (c === 123 || c === 91) {
                if (inTarget && depth === targetDepth && c === 123 && !parts) {
                    parts = []; partLen = 0; tooBig = false; start = i;
                }
                if (c === 91 && !inTarget && !done &&
                    ((arrayKey == null && depth === 0) || (arrayKey != null && depth === 1 && lastStr === arrayKey))) {
                    inTarget = true; targetDepth = depth + 1; stats.found = true;
                }
                depth++;
            } else if (c === 125 || c === 93) {
                depth--;
                if (parts && depth === targetDepth) {
                    let text = null;
                    if (!tooBig) { parts.push(s.slice(start, i + 1)); text = parts.join(''); }
                    parts = null; start = -1;
                    if (text === null) { stats.oversized++; continue; }
                    let obj;
                    try { obj = JSON.parse(text); } catch (_) { stats.bad++; continue; }
                    stats.items++;
                    await onItem(obj);
                } else if (inTarget && c === 93 && depth === targetDepth - 1) {
                    inTarget = false; done = true;
                }
            } else if (c === 44 && depth === 1 && !inTarget) {
                lastStr = null;
            }
        }
        if (parts && start >= 0 && !tooBig) {
            const piece = s.slice(start);
            partLen += piece.length;
            if (partLen > maxItem) { tooBig = true; parts = []; }
            else parts.push(piece);
        }
    };

    for await (const chunk of readable) {
        await run(typeof chunk === 'string' ? chunk : dec.write(chunk));
    }
    await run(dec.end());
    return stats;
}

class GoogleWarrantParser {

    /**
     * Parse a Google warrant return.
     * @param {Buffer|string} input  ZIP file path (recommended) OR Buffer
     * @param {Object} [options]     { security }
     * @returns {Object} parsed warrant data
     */
    async parseOuterZip(input, options = {}) {
        // Build a parse context so handlers can write media to disk and tag
        // each photo with the master-bundle it came from.
        //   mediaRoot:  cases/{caseNumber}/Evidence/google-warrant   (optional)
        //   inputName:  '30136296-20260514-1'  (top-level zip basename without .zip)
        //   accountId:  populated as soon as we see it on an inner zip
        const inputName = options.inputName || ((typeof input === 'string')
            ? path.basename(input).replace(/\.zip$/i, '')
            : 'warrant-' + Date.now());
        const ctx = {
            mediaRoot: options.mediaRoot || null,
            inputName,
            accountId: null,
            accountEmail: null,
            // Tracks photos extracted in *this* parse pass so we can report
            // counts in the import banner even if photos got streamed.
            mediaWritten: 0,
            mediaBytes: 0,
            mediaErrors: 0,
            security: options.security || null,
            // { email(em), location(loc) } — SQLite writer for large returns.
            sink: options.sink || null,
            storeDir: options.storeDir || null,
            storeKey: options.storeKey || null,
            // Breadcrumbs for the crash log (category being parsed, size).
            onMark: typeof options.onMark === 'function' ? options.onMark : null,
            emailSeq: 0,
            truncated: {},
            oversizeFiles: [],
            mboxErrors: 0
        };
        let zip;
        let isDir = false;
        if (typeof input === 'string') {
            try { isDir = fs.statSync(input).isDirectory(); } catch (_) {}
        }
        if (isDir) {
            zip = new FolderReader(input, { security: options.security, skipDirs: [options.mediaRoot] });
        } else {
            zip = await openZip(input, { security: options.security });
        }
        try {
            return await this._parseFromZip(zip, options, ctx);
        } finally {
            zip.close();
        }
    }

    async _parseFromZip(zip, options, ctx) {
        ctx = ctx || { mediaRoot: null, inputName: 'warrant', accountId: null, accountEmail: null, mediaWritten: 0, mediaBytes: 0, mediaErrors: 0 };
        this._ensureCtx(ctx);
        const entries = zip.getEntries();
        const _diag = { outerEntries: entries.length, innerZipsFound: 0, processed: 0, noRecords: 0, skippedMaster: 0, skippedPattern: 0, errors: [], byCategory: [] };
        console.log(`[google-warrant] _parseFromZip: outer has ${entries.length} entries`);

        const result = {
            accountEmail: null,
            accountId: null,
            dateRange: { start: null, end: null },
            coverLetter: null,
            categories: [],
            subscriber: null,
            changeHistory: [],
            emails: [],
            emailMetadata: [],
            locationRecords: [],
            semanticLocations: [],
            devices: [],
            installs: [],
            library: [],
            userActivity: [],
            chatMessages: [],
            chatUserInfo: null,
            chatGroupInfo: [],
            hangoutsInfo: null,
            googlePay: { instruments: [], transactions: [], addresses: [], customerInfo: null },
            driveFiles: [],
            accessLogActivity: [],
            aggregatedActivity: [],
            myActivity: [],
            ipActivity: [],
            playStorePreferences: [],
            contacts: [],
            calendars: [],
            calendarSettings: null,
            tasks: [],
            mailUserSettings: null,
            voiceSubscriber: null,
            meetHistory: [],
            linkedByPhone: [],
            // GooglePhotos.PhotoResourceLegal media — files extracted to disk.
            //   { filename, path (absolute), relPath (relative to mediaRoot),
            //     mimeType, size, bundle, takenAt? (parsed from name) }
            photos: [],
            // Track the master bundles seen during this parse so the renderer
            // can show "Imported from: 30136296-20260514-1, ...-2, ...-3" and
            // the auto-merge logic can dedupe by sourceFile.
            bundleSources: [],
            // Generic fallback bucket: any category we don't have an explicit
            // handler for ends up here so the renderer can still display it.
            //   { [category]: { html: [{name, text, tables}], csv: [{name, rows}], json: [{name, data}], other: [{name, ext}] } }
            rawSections: {},
            noRecordCategories: []
        };

        // Categorize entries
        const innerZips = [];
        const looseFolders = [];
        const otherFiles = [];

        for (const entry of entries) {
            const name = entry.entryName;
            if (entry.isDirectory) {
                looseFolders.push(name);
            } else if (name.toLowerCase().endsWith('.zip')) {
                innerZips.push(entry);
            } else if (name.toLowerCase().endsWith('.pdf')) {
                result.coverLetter = { name: path.basename(name), size: entry.size != null ? entry.size : (entry.header && entry.header.size) };
            } else if (name.toLowerCase().endsWith('.mbox')) {
                // Loose mbox (extracted from inner zip that was too large)
                otherFiles.push(entry);
            }
        }

        // Process inner ZIPs — including recursing into master bundle ZIPs
        // (pattern XXXXXXX-YYYYMMDD-N.zip). Master bundles can contain the
        // *only* copy of the per-service inner zips in some Google warrant
        // layouts, so we MUST open and walk them, not just skip them.
        _diag.innerZipsFound = innerZips.length;
        console.log(`[google-warrant] inner zip candidates: ${innerZips.length}`);

        // Track filenames we've already processed so a master bundle that
        // duplicates outer-level service zips doesn't get parsed twice.
        const seenInnerNames = new Set();

        // Build the work queue: { entry, ownerZip, sourceLabel }
        // ownerZip is whichever reader holds entry.getData(). We populate
        // outer-level entries first, then expand each master bundle's
        // contents and append.
        const workQueue = [];
        const masterBundles = [];

        for (const zipEntry of innerZips) {
            const fileName = path.basename(zipEntry.entryName);
            if (/^\d+-\d{8}-\d+\.zip$/i.test(fileName)) {
                masterBundles.push(zipEntry);
                continue;
            }
            workQueue.push({ entry: zipEntry, ownerZip: zip, sourceLabel: 'outer' });
        }

        // Open each master bundle and append its inner zips to the queue.
        // We keep each master bundle reader open until ALL its service zips
        // have been processed (their .getData() depends on it).
        const bundleReaders = []; // { reader, tempPath } — closed after queue drains
        for (const bundleEntry of masterBundles) {
            const bundleFileName = path.basename(bundleEntry.entryName);
            // Record this master bundle in the source list so the renderer/
            // auto-merge can show "Imported from: ...-1, ...-2, ...-3".
            const bundleLabel = bundleFileName.replace(/\.zip$/i, '');
            if (!result.bundleSources.includes(bundleLabel)) result.bundleSources.push(bundleLabel);
            const bundleSizeMB = ((bundleEntry.size || 0) / (1024 * 1024)).toFixed(1);
            console.log(`[google-warrant]   master bundle: ${bundleFileName} (${bundleSizeMB} MB) → opening`);
            let bundleReader = null;
            let bundleTempPath = null;
            try {
                this._mark(ctx, 'google-warrant:bundle', { bundle: bundleFileName, sizeMB: Number(bundleSizeMB) });
                if (bundleEntry._path) {
                    // Folder import: open the bundle in place — no copy, no Buffer.
                    bundleReader = await openZip(bundleEntry._path, { security: ctx.security });
                } else if (typeof zip.extractEntryToTemp === 'function' && bundleEntry.size && bundleEntry.size > INNER_BUFFER_MAX) {
                    bundleTempPath = await zip.extractEntryToTemp(bundleEntry, '.zip');
                    bundleReader = await openZip(bundleTempPath);
                } else {
                    const bundleBuf = bundleEntry.getData();
                    bundleReader = await openZip(bundleBuf);
                }
                const bundleEntries = bundleReader.getEntries();
                let added = 0;
                for (const be of bundleEntries) {
                    if (be.isDirectory) continue;
                    if (!be.entryName.toLowerCase().endsWith('.zip')) continue;
                    const innerName = path.basename(be.entryName);
                    // A master bundle inside a master bundle would be weird, but skip just in case
                    if (/^\d+-\d{8}-\d+\.zip$/i.test(innerName)) continue;
                    workQueue.push({ entry: be, ownerZip: bundleReader, sourceLabel: `bundle:${bundleFileName}` });
                    added++;
                }
                console.log(`[google-warrant]     bundle ${bundleFileName}: +${added} inner zip(s) queued`);
                _diag.innerZipsFound += added;
                bundleReaders.push({ reader: bundleReader, tempPath: bundleTempPath });
            } catch (err) {
                console.error(`[google-warrant]   bundle ${bundleFileName} failed to open:`, err.message);
                _diag.errors.push({ category: `master-bundle:${bundleFileName}`, sizeMB: Number(bundleSizeMB), error: err.message, stack: err.stack });
                try { if (bundleReader) bundleReader.close(); } catch (_) {}
                if (bundleTempPath) { try { fs.unlinkSync(bundleTempPath); } catch (_) {} }
            }
        }
        _diag.masterBundlesOpened = masterBundles.length;

        // Process the queue
        for (const work of workQueue) {
            const zipEntry = work.entry;
            const ownerZip = work.ownerZip;
            const sourceLabel = work.sourceLabel;
            const fileName = path.basename(zipEntry.entryName);
            const sizeMB = ((zipEntry.size || 0) / (1024 * 1024)).toFixed(1);

            // Dedupe (same service zip may appear at outer level AND inside bundle)
            if (seenInnerNames.has(fileName)) {
                console.log(`[google-warrant]   DEDUP skip: ${fileName} (already processed from ${sourceLabel})`);
                continue;
            }
            seenInnerNames.add(fileName);

            // Parse service.resource from filename.
            // Accepts both the standard pattern (`<...>.<Service>.<Resource>_<N>.zip`)
            // and large-warrant variants that carry an extra dotted marker before .zip
            // — most commonly `.Preserved` (preserved-data extraction) but the suffix
            // group is intentionally permissive so any future marker (`.Encrypted`,
            // `.Continuation`, etc.) still routes correctly.
            //
            // Examples:
            //   raptor26x@gmail.com.518160276335.GooglePhotos.PhotoResourceLegal_005.zip          ✓
            //   raptor26x@gmail.com.518160276335.GoogleMeet.MediaInformation_001.Preserved.zip   ✓
            //   raptor26x@gmail.com.518160276335.GoogleMeet.UserSessions_001.Preserved.zip       ✓
            const svcMatch = fileName.match(/\.(\w+)\.(\w+)_\d+(?:\.[\w]+)*\.zip$/i);
            if (!svcMatch) {
                _diag.skippedPattern++;
                console.log(`[google-warrant]   SKIP no-pattern-match: ${fileName} (${sizeMB} MB, src=${sourceLabel})`);
                continue;
            }

            const service = svcMatch[1];
            const resource = svcMatch[2];
            const category = `${service}.${resource}`;

            // Extract email and account ID from filename
            if (!result.accountEmail) {
                const idMatch = fileName.match(/^(.+?)\.(\d+)\./);
                if (idMatch) {
                    result.accountEmail = idMatch[1];
                    result.accountId = idMatch[2];
                    ctx.accountEmail = idMatch[1];
                    ctx.accountId = idMatch[2];
                }
            }

            // Declare cleanup-able locals OUTSIDE the try so the catch can also see them.
            let innerEntries;
            let innerZip = null;
            let tempInnerPath = null;
            try {
                this._mark(ctx, 'google-warrant:category', { category, sizeMB: Number(sizeMB), source: sourceLabel });
                // Inner ZIP can be multi-GB on its own (e.g. Mail.MessageContent).
                // Folder imports open it in place; inside a zip, anything over
                // INNER_BUFFER_MAX is extracted to a temp file and read from
                // disk instead of being buffered through Buffer/AdmZip.
                if (zipEntry._path) {
                    console.log(`[google-warrant]   ${category} (${sizeMB} MB, src=${sourceLabel}) → open from folder`);
                    innerZip = await openZip(zipEntry._path, { security: ctx.security });
                    innerEntries = innerZip.getEntries();
                } else if (typeof ownerZip.extractEntryToTemp === 'function' && zipEntry.size && zipEntry.size > INNER_BUFFER_MAX) {
                    console.log(`[google-warrant]   ${category} (${sizeMB} MB, src=${sourceLabel}) → temp-extract path`);
                    tempInnerPath = await ownerZip.extractEntryToTemp(zipEntry, '.zip');
                    innerZip = await openZip(tempInnerPath);
                    innerEntries = innerZip.getEntries();
                } else {
                    console.log(`[google-warrant]   ${category} (${sizeMB} MB, src=${sourceLabel}) → buffer path`);
                    const innerBuf = zipEntry.getData();
                    innerZip = await openZip(innerBuf);
                    innerEntries = innerZip.getEntries();
                }

                // Check for NoRecords
                const hasNoRecords = innerEntries.some(e => e.entryName.toLowerCase().includes('norecords'));
                if (hasNoRecords) {
                    result.noRecordCategories.push(category);
                    _diag.noRecords++;
                    _diag.byCategory.push({ category, sizeMB: Number(sizeMB), source: sourceLabel, result: 'no-records' });
                    // Still parse ExportSummary
                    const summary = innerEntries.find(e => e.entryName.includes('ExportSummary'));
                    if (summary) {
                        const meta = this.parseExportSummary(summary.getData().toString('utf-8'));
                        if (meta.dateRange) result.dateRange = meta.dateRange;
                    }
                    try { if (innerZip) innerZip.close(); } catch (_) {}
                    if (tempInnerPath) { try { fs.unlinkSync(tempInnerPath); } catch (_) {} }
                    continue;
                }

                result.categories.push(category);

                // Parse ExportSummary for metadata
                const summary = innerEntries.find(e => e.entryName.includes('ExportSummary'));
                if (summary) {
                    const meta = this.parseExportSummary(summary.getData().toString('utf-8'));
                    if (meta.dateRange && meta.dateRange.end) result.dateRange = meta.dateRange;
                }

                // Route to appropriate parser based on service.resource
                ctx.currentZip = innerZip;
                try {
                    await this._parseCategory(service, resource, innerEntries, result, ctx, work.sourceLabel);
                } finally {
                    ctx.currentZip = null;
                }
                _diag.processed++;
                _diag.byCategory.push({ category, sizeMB: Number(sizeMB), source: sourceLabel, result: 'ok' });

                try { if (innerZip) innerZip.close(); } catch (_) {}
                if (tempInnerPath) { try { fs.unlinkSync(tempInnerPath); } catch (_) {} }

            } catch (err) {
                console.error(`[google-warrant] Error parsing ${category} (${sizeMB} MB, src=${sourceLabel}):`, err.message);
                _diag.errors.push({ category, sizeMB: Number(sizeMB), source: sourceLabel, error: err.message, stack: err.stack });
                _diag.byCategory.push({ category, sizeMB: Number(sizeMB), source: sourceLabel, result: 'error', error: err.message });
                try { if (innerZip) innerZip.close(); } catch (_) {}
                if (tempInnerPath) { try { fs.unlinkSync(tempInnerPath); } catch (_) {} }
            }
        }

        // Close master-bundle readers and unlink temp files
        for (const br of bundleReaders) {
            try { br.reader.close(); } catch (_) {}
            if (br.tempPath) { try { fs.unlinkSync(br.tempPath); } catch (_) {} }
        }

        // Surface diagnostics on the result so the renderer can display them
        result._diagnostics = _diag;
        _diag.photosExtracted = ctx.mediaWritten;
        _diag.photosBytes = ctx.mediaBytes;
        _diag.photosErrors = ctx.mediaErrors;
        // If we didn't recurse through any master bundle, the input itself
        // is the "bundle" — record it so multi-part auto-merge has something
        // to key on. Same logic when caller is parsing a virtual outer zip
        // built from a folder of inner zips (ctx.inputName then is generic).
        if (!result.bundleSources.length && ctx.inputName) {
            result.bundleSources.push(ctx.inputName);
        }
        console.log(`[google-warrant] DONE: ${_diag.processed} with-records + ${_diag.noRecords} no-records + ${_diag.masterBundlesOpened || 0} master-bundles-opened + ${_diag.skippedPattern} pattern-mismatch + ${_diag.errors.length} errors  /  ${_diag.innerZipsFound} total inner zips (outer + bundle contents)`);
        if (ctx.mediaWritten) {
            console.log(`[google-warrant]   media extracted: ${ctx.mediaWritten} file(s), ${(ctx.mediaBytes/1024/1024).toFixed(1)} MB (errors: ${ctx.mediaErrors})`);
        }
        if (_diag.errors.length) {
            console.log('[google-warrant] error summary:');
            for (const e of _diag.errors) console.log(`  - ${e.category} (${e.sizeMB} MB, src=${e.source || 'outer'}): ${e.error}`);
        }

        // Handle loose MBOX files (not inside an inner ZIP) — streamed.
        for (const entry of otherFiles) {
            if (entry.entryName.toLowerCase().endsWith('.mbox')) {
                try {
                    this._mark(ctx, 'google-warrant:loose-mbox', { name: path.basename(entry.entryName), sizeMB: Math.round((entry.size || 0) / 1048576) });
                    const stm = await zip.openStream(entry);
                    await this.parseMboxStream(stm, (em) => this._emitEmail(em, result, ctx), ctx);
                } catch (err) {
                    console.error('Error parsing loose mbox:', err.message);
                    _diag.errors.push({ category: 'loose-mbox:' + path.basename(entry.entryName), sizeMB: Math.round((entry.size || 0) / 1048576), error: err.message });
                }
            }
        }

        this._capResult(result, ctx);
        _diag.mboxErrors = ctx.mboxErrors;
        return result;
    }

    /**
     * Route parsing to the correct handler based on service/resource
     * @param {string} service
     * @param {string} resource
     * @param {Array}  innerEntries
     * @param {Object} result
     * @param {Object} ctx          Parse context (mediaRoot, accountId, …). May be undefined for legacy callers.
     * @param {string} sourceLabel  'outer' | 'bundle:<filename>' — for diagnostics + per-bundle media subdir
     */
    async _parseCategory(service, resource, innerEntries, result, ctx, sourceLabel) {
        ctx = ctx || { mediaRoot: null, inputName: 'warrant', accountId: null, mediaWritten: 0, mediaBytes: 0, mediaErrors: 0 };
        this._ensureCtx(ctx);
        const key = `${service}.${resource}`;

        // Any file this handler would read whole that is too big to parse
        // safely is copied out to the case folder (nothing lost) and skipped.
        const keep = [];
        for (const e of innerEntries) {
            if (e && !e.isDirectory && (e.size || 0) > MAX_INLINE_ENTRY && !this._isStreamedEntry(key, e)) {
                await this._saveOversizeEntry(e, key, result, ctx);
            } else {
                keep.push(e);
            }
        }
        innerEntries = keep;

        switch (key) {
            case 'GoogleAccount.SubscriberInfo':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        const parsed = this.parseSubscriberInfo(e.getData().toString('utf-8'));
                        result.subscriber = parsed;
                        result.ipActivity = parsed.ipActivity || [];
                    }
                }
                break;

            case 'GoogleAccount.ChangeHistory':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        result.changeHistory = this.parseChangeHistory(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'Mail.MessageContent':
            case 'Mail.Messages':            // newer Google warrant schema
            case 'Gmail.Messages':           // alt naming
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.mbox')) {
                        const stm = await this._entryStream(e, ctx);
                        await this.parseMboxStream(stm, (em) => this._emitEmail(em, result, ctx), ctx);
                    }
                }
                break;

            case 'Mail.MessageInformation':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json')) {
                        try {
                            const meta = this.parseMailMetadata(e.getData().toString('utf-8'));
                            result.emailMetadata.push(meta);
                        } catch (err) { /* skip bad JSON */ }
                    }
                }
                break;

            case 'Mail.UserSettings':
                result.mailUserSettings = this._captureGenericCategory(key, innerEntries) || result.mailUserSettings;
                break;

            case 'LocationHistory.Records':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        const stm = await this._entryStream(e, ctx);
                        await streamJsonArray(stm, 'locations', (loc) => this._emitLocation(this._mapLocation(loc), result, ctx));
                    }
                }
                break;

            case 'LocationHistory.SemanticLocationHistory':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        const stm = await this._entryStream(e, ctx);
                        await streamJsonArray(stm, 'timelineObjects', (obj) => {
                            const m = this._mapSemantic(obj);
                            if (m) this._pushCapped(result.semanticLocations, 'semanticLocations', m, ctx);
                        });
                    }
                }
                break;

            case 'GooglePlayStore.Devices':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.devices = this.parseDevicesCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.Installs':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.installs = this.parseInstallsCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.Library':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.library = this.parseLibraryCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.UserActivity':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        result.userActivity = this.parseUserActivityHtml(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.UserPreferences':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.playStorePreferences = this.csvToObjects(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GoogleChat.Messages':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try {
                            result.chatMessages.push(JSON.parse(e.getData().toString('utf-8')));
                        } catch (err) { /* skip */ }
                    } else if (e.entryName.endsWith('.html')) {
                        result.chatMessages.push({ type: 'html', content: this._capText(e.getData().toString('utf-8'), 'chatHtml', ctx) });
                    }
                }
                break;

            case 'GoogleChat.UserInfo':
                for (const e of innerEntries) {
                    if (!e.entryName.includes('ExportSummary') && !e.entryName.includes('NoRecords')) {
                        result.chatUserInfo = this._capText(e.getData().toString('utf-8'), 'chatUserInfo', ctx);
                    }
                }
                break;

            case 'GoogleChat.GroupInfo':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.chatGroupInfo.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    }
                }
                break;

            case 'Hangouts.ContentAndMetadata':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.txt') && !e.entryName.includes('ExportSummary')) {
                        result.hangoutsInfo = this.parseHangoutsUserInfo(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'AccessLogActivity.Activity':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        const parsed = this.parseAccessLogHtml(e.getData().toString('utf-8'));
                        if (Array.isArray(parsed)) result.accessLogActivity.push(...parsed);
                    }
                }
                break;

            case 'AccessLogActivity.Devices':
                // Newer Google warrant schema: per-device access log table.
                // Reuse the access-log HTML parser and ALSO mirror entries
                // into result.devices so the Devices sidebar tab lights up.
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        const rows = this.parseAccessLogHtml(e.getData().toString('utf-8')) || [];
                        // Some warrant returns put device columns in the same table;
                        // copy them into the device list (deduplicated by raw row).
                        for (const r of rows) {
                            result.devices.push({
                                manufacturer: r.manufacturer || null,
                                model: r.model || r.device || r.details || null,
                                deviceName: r.deviceName || r.device || null,
                                lastActive: r.timestamp || r.lastActive || null,
                                _raw: r
                            });
                        }
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        const rows = this.csvToObjects(e.getData().toString('utf-8'));
                        result.devices.push(...rows.map(r => ({
                            manufacturer: r['Manufacturer'] || r['manufacturer'] || null,
                            model: r['Model'] || r['model'] || null,
                            deviceName: r['Device Name'] || r['Name'] || null,
                            lastActive: r['Last Active'] || r['Timestamp'] || null,
                            _raw: r
                        })));
                    }
                }
                break;

            case 'AccessLogActivity.AggregatedActivities':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        const rows = this.parseGenericHtmlTables(e.getData().toString('utf-8'));
                        result.aggregatedActivity.push(...rows);
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.aggregatedActivity.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    }
                }
                break;

            case 'MyActivity.MyActivity':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        // Reuse Play Store user-activity HTML parser (same mdl-card layout)
                        const acts = this.parseUserActivityHtml(e.getData().toString('utf-8'));
                        if (Array.isArray(acts)) result.myActivity.push(...acts);
                    } else if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.myActivity.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    }
                }
                break;

            // Google Pay categories
            case 'GooglePay.Transactions':
            case 'GooglePay.PaymentMethods':
            case 'GooglePay.PaymentInstruments':
            case 'GooglePay.CustomerInformation':
            case 'Google Pay.Transactions':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        const rows = this.csvToObjects(e.getData().toString('utf-8'));
                        if (resource.toLowerCase().includes('transaction')) {
                            result.googlePay.transactions.push(...rows);
                        } else if (resource.toLowerCase().includes('customer')) {
                            result.googlePay.customerInfo = rows[0] || result.googlePay.customerInfo;
                        } else {
                            result.googlePay.instruments.push(...rows);
                        }
                    } else if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        const parsed = this.parseGooglePayHtml(e.getData().toString('utf-8'));
                        if (parsed.transactions) result.googlePay.transactions.push(...parsed.transactions);
                        if (parsed.instruments) result.googlePay.instruments.push(...parsed.instruments);
                        if (parsed.addresses) result.googlePay.addresses.push(...parsed.addresses);
                        if (resource.toLowerCase().includes('customer')) {
                            // Store summary HTML text under customerInfo for display
                            const root = parseHTML(e.getData().toString('utf-8'));
                            result.googlePay.customerInfo = result.googlePay.customerInfo || {};
                            result.googlePay.customerInfo._html = root.text.trim().slice(0, 8000);
                        }
                    }
                }
                break;

            // Drive
            case 'Drive.Files':
            case 'Drive.DriveFiles':                 // newer naming
            case 'Drive.DriveMetadata':
            case 'Drive.FileContentAndMetadata':
            case 'Drive.DriveFileContent':
                for (const e of innerEntries) {
                    if (e.isDirectory) continue;
                    const name = e.entryName.split('/').pop();
                    if (!name) continue;
                    const lower = name.toLowerCase();

                    if (lower.endsWith('.json') && !lower.includes('exportsummary')) {
                        try { result.driveFiles.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    } else if (lower.endsWith('.csv')) {
                        result.driveFiles.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    } else if (lower.endsWith('.html') && !lower.includes('exportsummary')) {
                        // Newer Drive.DriveFiles ships an index.html table of files
                        const rows = this.parseGenericHtmlTables(e.getData().toString('utf-8'));
                        result.driveFiles.push(...rows);
                    } else {
                        // Binary file (image, video, PDF, doc, etc.)
                        const ext = lower.substring(lower.lastIndexOf('.'));
                        const mimeMap = {
                            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                            '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml',
                            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
                            '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.3gp': 'video/3gpp',
                            '.pdf': 'application/pdf',
                            '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                            '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html',
                            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
                        };
                        const mimeType = mimeMap[ext] || 'application/octet-stream';
                        // Written to the case folder like photos — never
                        // base64-inlined (a large Drive used to be held in
                        // memory, cloned over IPC and put in localStorage).
                        const rec = await this._writeEntryToMedia(e, ctx, key, true);
                        result.driveFiles.push({
                            _isFile: true,
                            name: name,
                            path: e.entryName,
                            mimeType: mimeType,
                            size: rec ? rec.size : (e.size || 0),
                            relPath: rec ? rec.relPath : null,
                            stub: !rec
                        });
                    }
                }
                break;

            // ─── Newer Google warrant categories — capture generically ─────
            case 'Contacts.Contacts':
                // Try to extract structured contact rows from HTML/CSV
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.contacts.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    } else if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        result.contacts.push(...this.parseGenericHtmlTables(e.getData().toString('utf-8')));
                    } else if (e.entryName.toLowerCase().endsWith('.vcf')) {
                        result.contacts.push({ _vcard: e.getData().toString('utf-8') });
                    } else if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.contacts.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    }
                }
                break;

            case 'Calendar.Calendars':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.ics')) {
                        result.calendars.push({ _ics: true, name: e.entryName.split('/').pop(), content: this._capText(e.getData().toString('utf-8'), 'calendarIcs', ctx) });
                    } else if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        result.calendars.push(...this.parseGenericHtmlTables(e.getData().toString('utf-8')));
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.calendars.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    }
                }
                break;

            case 'Calendar.UserSettings':
                result.calendarSettings = this._captureGenericCategory(key, innerEntries) || result.calendarSettings;
                break;

            case 'Voice.SubscriberInformation':
                result.voiceSubscriber = this._captureGenericCategory(key, innerEntries) || result.voiceSubscriber;
                break;

            case 'GoogleMeet.MeetingHistory':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        result.meetHistory.push(...this.parseGenericHtmlTables(e.getData().toString('utf-8')));
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.meetHistory.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    }
                }
                break;

            case 'Tasks.TaskList':
            case 'Tasks.Tasks':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        result.tasks.push(...this.parseGenericHtmlTables(e.getData().toString('utf-8')));
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.tasks.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    } else if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.tasks.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    }
                }
                break;

            case 'GoogleAccountTargetAssociation.LinkedByPhone':
            case 'GoogleAccountTargetAssociation.LinkedByCookies':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        result.linkedByPhone.push(...this.parseGenericHtmlTables(e.getData().toString('utf-8')));
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.linkedByPhone.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    }
                }
                break;

            // ─── Google Photos / Media-bearing categories ───────────────
            // PhotoResourceLegal: typically the largest payload in any
            // warrant — contains the actual JPG/MP4/HEIC files plus a
            // companion JSON/HTML metadata file. We stream each binary to
            // disk under ctx.mediaRoot (instead of base64-inlining into
            // the result blob, which would blow up localStorage and JSON
            // serialization for multi-GB returns).
            case 'GooglePhotos.PhotoResourceLegal':
            case 'GooglePhotos.Photos':
            case 'GooglePhotos.Videos':
            case 'GooglePhotos.AlbumLegal':
            case 'GoogleFiWireless.Voicemails':
            case 'GoogleFiWireless.Voicemails&Greetings':
            case 'GoogleMeet.MediaInformation':
            case 'GoogleMeet.UserSessions':
            case 'YoutubeAndYoutubeMusic.MediaUploads':
            case 'Keep.Media':
                for (const e of innerEntries) {
                    await this._extractMediaEntry(e, result, ctx, sourceLabel, key);
                }
                break;

            default:
                // Unknown category — capture into rawSections so investigators
                // can still see HTML/CSV/JSON content in the Other Data tab.
                // This is the safety net against future Google schema changes.
                console.log(`[google-warrant] No explicit handler for category "${key}" — capturing to rawSections`);
                for (const e of innerEntries) this._captureEntryToRawSection(key, e, result);
                break;
        }
    }

    // ─── Generic capture helpers (for unknown / newer categories) ──────

    /**
     * Read an entry and stash it under result.rawSections[category]
     * Buckets: html (parsed text + tables), csv (rows), json (data), other.
     * Skips ExportSummary / NoRecords markers.
     */
    _captureEntryToRawSection(category, entry, result) {
        if (entry.isDirectory) return;
        const name = entry.entryName.split('/').pop() || entry.entryName;
        const lower = name.toLowerCase();
        if (lower.includes('exportsummary') || lower.includes('norecords')) return;

        if (!result.rawSections[category]) {
            result.rawSections[category] = { html: [], csv: [], json: [], other: [] };
        }
        const bucket = result.rawSections[category];

        try {
            if (lower.endsWith('.html') || lower.endsWith('.htm')) {
                const html = entry.getData().toString('utf-8');
                const root = parseHTML(html);
                const tables = this.parseGenericHtmlTables(html);
                // Trim text to keep the payload reasonable
                const text = (root.text || '').replace(/\s+/g, ' ').trim().slice(0, 50000);
                const item = { name, text, tables };
                if (tables.length > INLINE_ROW_CAP) { item.totalRows = tables.length; item.tables = tables.slice(0, INLINE_ROW_CAP); }
                bucket.html.push(item);
            } else if (lower.endsWith('.csv')) {
                const rows = this.csvToObjects(entry.getData().toString('utf-8'));
                const item = { name, rows };
                if (rows.length > INLINE_ROW_CAP) { item.totalRows = rows.length; item.rows = rows.slice(0, INLINE_ROW_CAP); }
                bucket.csv.push(item);
            } else if (lower.endsWith('.json')) {
                const text = entry.getData().toString('utf-8');
                if (text.length > INLINE_TEXT_CAP) {
                    bucket.other.push({ name, ext: 'json', text: text.slice(0, 50000), truncated: true, size: text.length });
                } else {
                    try {
                        const data = JSON.parse(text);
                        bucket.json.push({ name, data });
                    } catch (_) {
                        bucket.other.push({ name, ext: 'json', text: text.slice(0, 50000) });
                    }
                }
            } else if (lower.endsWith('.txt') || lower.endsWith('.vcf') || lower.endsWith('.ics')) {
                bucket.other.push({ name, ext: lower.slice(lower.lastIndexOf('.') + 1), text: entry.getData().toString('utf-8').slice(0, 100000) });
            } else {
                bucket.other.push({ name, ext: lower.slice(lower.lastIndexOf('.') + 1) || 'bin' });
            }
        } catch (err) {
            console.error(`[google-warrant] capture failed for ${category}/${name}: ${err.message}`);
        }
    }

    /**
     * Capture a whole category to rawSections AND return the bucket so the
     * caller can stash it in a top-level field (e.g. result.mailUserSettings).
     */
    _captureGenericCategory(category, innerEntries) {
        const bucket = { html: [], csv: [], json: [], other: [] };
        const tmpResult = { rawSections: { [category]: bucket } };
        for (const e of innerEntries) this._captureEntryToRawSection(category, e, tmpResult);
        return (bucket.html.length || bucket.csv.length || bucket.json.length || bucket.other.length) ? bucket : null;
    }

    // ─── Media extraction (GooglePhotos / large binary categories) ─────

    /**
     * Stream a single entry from a media-bearing inner zip to disk.
     *
     * Disk layout (when ctx.mediaRoot is set):
     *   <mediaRoot>/<accountId | 'unknown'>/<inputName>/<category>/<basename>
     *
     * Companion JSON/HTML metadata files are written next to their binaries
     * AND also parsed-as-JSON into the photo's metadata field where possible.
     *
     * If ctx.mediaRoot is null we fall back to cataloging (filename + size)
     * so the UI can still tell the investigator something is there.
     */
    async _extractMediaEntry(entry, result, ctx, sourceLabel, category) {
        if (!entry || entry.isDirectory) return;
        const raw = entry.entryName;
        const name = raw.split('/').pop() || raw;
        if (!name) return;
        const lower = name.toLowerCase();
        if (lower.includes('exportsummary') || lower.includes('norecords')) return;

        const ext = lower.includes('.') ? lower.substring(lower.lastIndexOf('.')) : '';
        const mimeMap = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
            '.svg': 'image/svg+xml', '.heic': 'image/heic', '.heif': 'image/heif',
            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
            '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.3gp': 'video/3gpp',
            '.m4v': 'video/mp4',
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
            '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.amr': 'audio/amr',
            '.pdf': 'application/pdf',
            '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
            '.csv': 'text/csv', '.txt': 'text/plain', '.xml': 'application/xml',
        };
        const mimeType = mimeMap[ext] || 'application/octet-stream';
        const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/');
        const isMetadata = lower.endsWith('.json') || lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.csv') || lower.endsWith('.xml');

        // Without a mediaRoot we can't write to disk — still record a stub
        // so the renderer can show counts.
        if (!ctx.mediaRoot) {
            result.photos.push({
                filename: name,
                stub: true,
                mimeType,
                isMedia,
                size: entry.size || 0,
                bundle: ctx.inputName,
                category
            });
            return;
        }

        const rec = await this._writeEntryToMedia(entry, ctx, category, false);
        if (!rec) return;
        try {
            const targetPath = rec.path;
            const relPath = rec.relPath;
            const meta = {
                filename: name,
                path: targetPath,
                relPath,
                mimeType,
                size: rec.size,
                bundle: ctx.inputName,
                category,
                isMedia,
                isMetadata
            };

            // Try to parse companion JSON metadata inline so the gallery can
            // show takenAt / geolocation / device.
            if (lower.endsWith('.json') && rec.size <= 5 * 1024 * 1024) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
                    meta.metadata = parsed;
                    if (parsed.photoTakenTime && parsed.photoTakenTime.timestamp) {
                        meta.takenAt = new Date(Number(parsed.photoTakenTime.timestamp) * 1000).toISOString();
                    } else if (parsed.creationTime && parsed.creationTime.timestamp) {
                        meta.takenAt = new Date(Number(parsed.creationTime.timestamp) * 1000).toISOString();
                    }
                    if (parsed.geoData && (parsed.geoData.latitude || parsed.geoData.longitude)) {
                        meta.geo = { lat: parsed.geoData.latitude, lon: parsed.geoData.longitude };
                    }
                } catch (_) { /* keep raw file, ignore parse error */ }
            }

            result.photos.push(meta);
        } catch (err) {
            ctx.mediaErrors++;
            console.error(`[google-warrant] media extract failed: ${category}/${name}: ${err.message}`);
        }
    }

    // ─── Large-return helpers ────────────────────────────────────────────

    _ensureCtx(ctx) {
        if (ctx.emailSeq == null) ctx.emailSeq = 0;
        if (!ctx.truncated) ctx.truncated = {};
        if (!ctx.oversizeFiles) ctx.oversizeFiles = [];
        if (ctx.mboxErrors == null) ctx.mboxErrors = 0;
        return ctx;
    }

    _mark(ctx, label, detail) {
        if (!ctx || !ctx.onMark) return;
        try { ctx.onMark(label, detail); } catch (_) { /* never break a parse */ }
    }

    /** Readable for an inner-zip entry (streamed from disk when possible). */
    async _entryStream(entry, ctx) {
        if (ctx && ctx.currentZip && typeof ctx.currentZip.openStream === 'function') {
            const s = await ctx.currentZip.openStream(entry);
            if (s) return s;
        }
        return Readable.from([entry.getData()]);
    }

    /** Entries the handler streams instead of reading whole. */
    _isStreamedEntry(key, e) {
        const lower = (e.entryName || '').toLowerCase();
        if (/^(Mail\.MessageContent|Mail\.Messages|Gmail\.Messages)$/.test(key) && lower.endsWith('.mbox')) return true;
        if (/^LocationHistory\.(Records|SemanticLocationHistory)$/.test(key) && lower.endsWith('.json')) return true;
        if (/^(GooglePhotos\.|GoogleFiWireless\.Voicemails|GoogleMeet\.(MediaInformation|UserSessions)$|YoutubeAndYoutubeMusic\.MediaUploads$|Keep\.Media$)/.test(key)) return true;
        if (/^Drive\./.test(key) && !/\.(json|csv|html?)$/.test(lower)) return true;
        return false;
    }

    /**
     * Copy an entry to <mediaRoot>/<acct>/<bundle>/<category>/[subdirs/]<name>
     * without buffering it.  Returns { path, relPath, size } or null.
     */
    async _writeEntryToMedia(entry, ctx, category, keepSubdirs) {
        if (!ctx.mediaRoot) return null;
        const raw = entry.entryName || '';
        const segs = raw.split('/').filter(Boolean);
        const name = segs.pop();
        if (!name) return null;
        const clean = (s) => String(s).replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/^\.+$/, '_');
        const acctSub = (ctx.accountId || 'unknown').toString().replace(/[^\w.-]/g, '_');
        const bundleSub = (ctx.inputName || 'warrant').replace(/[^\w.-]/g, '_');
        const catSub = String(category || 'media').split('/').map(s => s.replace(/[^\w.-]/g, '_'));
        const sub = keepSubdirs ? segs.map(clean) : [];
        const targetDir = path.join(ctx.mediaRoot, acctSub, bundleSub, ...catSub, ...sub);
        try {
            if (!path.resolve(targetDir).startsWith(path.resolve(ctx.mediaRoot))) throw new Error('unsafe entry path');
            fs.mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, clean(name));
            if (ctx.currentZip && typeof ctx.currentZip.extractEntryToFile === 'function') {
                await ctx.currentZip.extractEntryToFile(entry, targetPath);
            } else {
                fs.writeFileSync(targetPath, entry.getData());
            }
            let size = entry.size || 0;
            try { size = fs.statSync(targetPath).size; } catch (_) {}
            ctx.mediaWritten++;
            ctx.mediaBytes += size;
            const relPath = path.relative(ctx.mediaRoot, targetPath).split(path.sep).join('/');
            return { path: targetPath, relPath, size };
        } catch (err) {
            ctx.mediaErrors++;
            console.error(`[google-warrant] media extract failed: ${category}/${name}: ${err.message}`);
            return null;
        }
    }

    /** A file too large to parse: copy it out so the investigator still has it. */
    async _saveOversizeEntry(entry, category, result, ctx) {
        const name = (entry.entryName || '').split('/').pop();
        const rec = await this._writeEntryToMedia(entry, ctx, '_oversize/' + category, false);
        const item = { category, name, size: entry.size || 0, relPath: rec ? rec.relPath : null };
        ctx.oversizeFiles.push(item);
        console.warn(`[google-warrant] ${category}/${name} is ${(item.size / 1048576).toFixed(0)} MB — too large to display; saved to ${item.relPath || '(not saved: no case folder)'}`);
    }

    _capText(text, label, ctx) {
        if (typeof text !== 'string' || text.length <= INLINE_TEXT_CAP) return text;
        if (ctx) ctx.truncated[label] = (ctx.truncated[label] || 0) + 1;
        return text.slice(0, INLINE_TEXT_CAP) + '\n\n[… truncated by VIPER — file too large to display in full]';
    }

    _pushCapped(arr, label, item, ctx, cap) {
        if (arr.length < (cap || INLINE_ROW_CAP)) { arr.push(item); return; }
        ctx.truncated[label] = (ctx.truncated[label] || 0) + 1;
    }

    async _emitEmail(em, result, ctx) {
        if (ctx.sink) { await ctx.sink.email(em); return; }
        this._pushCapped(result.emails, 'emails', em, ctx, INLINE_EMAIL_CAP);
    }

    async _emitLocation(loc, result, ctx) {
        if (!loc) return;
        if (ctx.sink) { await ctx.sink.location(loc); return; }
        this._pushCapped(result.locationRecords, 'locationRecords', loc, ctx, INLINE_LOCATION_CAP);
    }

    /**
     * Keep the import record small enough for IPC + localStorage.  Arrays
     * beyond the cap are written to <storeDir>/<storeKey>.overflow/<field>.ndjson
     * (when a case folder is available) so no parsed row is thrown away.
     */
    _capResult(result, ctx) {
        const skip = new Set(['categories', 'noRecordCategories', 'bundleSources', 'emails', 'locationRecords']);
        const fields = [];
        for (const k of Object.keys(result)) {
            if (!skip.has(k) && Array.isArray(result[k])) fields.push({ label: k, holder: result, key: k });
        }
        if (result.googlePay) {
            for (const k of ['instruments', 'transactions', 'addresses']) {
                if (Array.isArray(result.googlePay[k])) fields.push({ label: 'googlePay.' + k, holder: result.googlePay, key: k });
            }
        }
        const estimate = (arr) => {
            if (!arr.length) return 0;
            const n = Math.min(arr.length, 50);
            let s = 0;
            try { s = JSON.stringify(arr.slice(0, n)).length; } catch (_) { s = n * 1000; }
            return Math.ceil((s / n) * arr.length);
        };
        const cut = (f, cap) => {
            const arr = f.holder[f.key];
            if (arr.length <= cap) return;
            this._writeOverflow(ctx, f.label, arr, cap);
            ctx.truncated[f.label] = (ctx.truncated[f.label] || 0) + (arr.length - cap);
            arr.length = cap;
        };
        for (const f of fields) cut(f, INLINE_ROW_CAP);
        // Then shrink the biggest arrays until the whole record fits the budget.
        for (let guard = 0; guard < 40; guard++) {
            const sizes = fields.map(f => ({ f, size: estimate(f.holder[f.key]) }));
            const total = sizes.reduce((a, b) => a + b.size, 0);
            if (total <= RESULT_CHAR_BUDGET) break;
            sizes.sort((a, b) => b.size - a.size);
            const big = sizes[0];
            const len = big.f.holder[big.f.key].length;
            if (len <= 200) break;
            cut(big.f, Math.max(200, Math.floor(len / 2)));
        }
        if (Object.keys(ctx.truncated).length) result.truncated = Object.assign({}, ctx.truncated);
        if (ctx.oversizeFiles.length) result.oversizeFiles = ctx.oversizeFiles.slice();
        return result;
    }

    _writeOverflow(ctx, label, arr, from) {
        if (!ctx.storeDir || !ctx.storeKey) return;
        try {
            const dir = path.join(ctx.storeDir, `${ctx.storeKey}.overflow`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, label.replace(/[^\w.-]/g, '_') + '.ndjson');
            const fd = fs.openSync(file, 'a');
            try {
                for (let i = from; i < arr.length; i += 1000) {
                    const lines = [];
                    for (let j = i; j < Math.min(arr.length, i + 1000); j++) {
                        try { lines.push(JSON.stringify(arr[j])); } catch (_) {}
                    }
                    fs.writeSync(fd, lines.join('\n') + '\n');
                }
            } finally { fs.closeSync(fd); }
        } catch (err) {
            console.error(`[google-warrant] overflow write failed for ${label}: ${err.message}`);
        }
    }

    /**
     * Stream an MBOX (any size).  Each message is parsed on its own and
     * handed to onEmail (awaited), so memory is bounded by one message.
     */
    async parseMboxStream(readable, onEmail, ctx) {
        ctx = this._ensureCtx(ctx || {});
        const SEP = Buffer.from('\nFrom ');
        let parts = [], size = 0, rawSize = 0, truncated = false;
        let carry = null, atStart = true, skipLine = false, count = 0;

        const flush = async () => {
            if (!rawSize) return;
            const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
            const wasTrunc = truncated, raw = rawSize;
            parts = []; size = 0; rawSize = 0; truncated = false;
            if (buf.length < 20 || !buf.toString('latin1', 0, Math.min(buf.length, 4096)).trim()) return;
            const em = await this._parseMessage(buf, ctx, raw, wasTrunc);
            if (em) { count++; await onEmail(em); }
        };
        const append = (b) => {
            if (!b.length) return;
            rawSize += b.length;
            if (size >= MBOX_MESSAGE_MAX) { truncated = true; return; }
            const room = MBOX_MESSAGE_MAX - size;
            const piece = b.length > room ? b.subarray(0, room) : b;
            if (piece.length < b.length) truncated = true;
            parts.push(piece);
            size += piece.length;
        };

        for await (let chunk of readable) {
            if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf-8');
            const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
            carry = null;
            let pos = 0;
            if (atStart) {
                if (buf.length < 5) { carry = Buffer.from(buf); continue; }
                atStart = false;
                if (buf.toString('latin1', 0, 5) === 'From ') { skipLine = true; pos = 5; }
            }
            while (pos < buf.length) {
                if (skipLine) {
                    const nl = buf.indexOf(10, pos);
                    if (nl === -1) { pos = buf.length; break; }
                    pos = nl + 1;
                    skipLine = false;
                    continue;
                }
                const idx = buf.indexOf(SEP, pos);
                if (idx === -1) {
                    const keep = Math.min(SEP.length - 1, buf.length - pos);
                    append(buf.subarray(pos, buf.length - keep));
                    carry = Buffer.from(buf.subarray(buf.length - keep));
                    pos = buf.length;
                    break;
                }
                append(buf.subarray(pos, idx + 1));
                await flush();
                pos = idx + SEP.length;
                skipLine = true;
            }
        }
        if (carry && !skipLine) append(carry);
        await flush();
        return count;
    }

    async _parseMessage(buf, ctx, rawSize, truncated) {
        let parsed;
        try {
            parsed = await simpleParser(buf, { skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
        } catch (err) {
            ctx.mboxErrors++;
            console.warn('Failed to parse email part:', err.message);
            return null;
        }
        const n = ++ctx.emailSeq;
        const em = {
            id: parsed.messageId || `msg-${n}`,
            from: parsed.from?.text || '',
            to: parsed.to?.text || '',
            cc: parsed.cc?.text || '',
            subject: parsed.subject || '(no subject)',
            date: parsed.date ? (isNaN(parsed.date.getTime()) ? '' : parsed.date.toISOString()) : '',
            labels: parsed.headers?.get('x-gmail-labels') || '',
            threadId: parsed.headers?.get('x-gm-thrid') || '',
            textBody: parsed.text || '',
            htmlBody: parsed.html || '',
            attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename,
                contentType: a.contentType,
                size: a.size
            }))
        };
        if (typeof em.labels !== 'string') em.labels = String(em.labels);
        if (typeof em.threadId !== 'string') em.threadId = String(em.threadId);
        if (truncated) { em.truncated = true; em.rawSize = rawSize; }
        return em;
    }

    _mapLocation(loc) {
        if (!loc || typeof loc !== 'object') return null;
        return {
            timestamp: loc.timestamp || (loc.timestampMs ? new Date(parseInt(loc.timestampMs)).toISOString() : null),
            lat: loc.latitudeE7 ? loc.latitudeE7 / 1e7 : null,
            lng: loc.longitudeE7 ? loc.longitudeE7 / 1e7 : null,
            accuracy: loc.accuracy || null,
            altitude: loc.altitude || null,
            velocity: loc.velocity || null,
            heading: loc.heading || null,
            source: loc.source || null,
            deviceTag: loc.deviceTag || null,
            activity: loc.activity || null
        };
    }

    _mapSemantic(obj) {
        if (!obj) return null;
        if (obj.placeVisit) {
            const pv = obj.placeVisit;
            return {
                type: 'placeVisit',
                name: pv.location?.name || null,
                address: pv.location?.address || null,
                placeId: pv.location?.placeId || null,
                lat: pv.location?.latitudeE7 ? pv.location.latitudeE7 / 1e7 : null,
                lng: pv.location?.longitudeE7 ? pv.location.longitudeE7 / 1e7 : null,
                startTime: pv.duration?.startTimestamp || null,
                endTime: pv.duration?.endTimestamp || null,
                confidence: pv.location?.locationConfidence || null
            };
        }
        if (obj.activitySegment) {
            const as = obj.activitySegment;
            return {
                type: 'activitySegment',
                activityType: as.activityType || null,
                confidence: as.confidence || null,
                distance: as.distance || null,
                startLat: as.startLocation?.latitudeE7 ? as.startLocation.latitudeE7 / 1e7 : null,
                startLng: as.startLocation?.longitudeE7 ? as.startLocation.longitudeE7 / 1e7 : null,
                endLat: as.endLocation?.latitudeE7 ? as.endLocation.latitudeE7 / 1e7 : null,
                endLng: as.endLocation?.longitudeE7 ? as.endLocation.longitudeE7 / 1e7 : null,
                startTime: as.duration?.startTimestamp || null,
                endTime: as.duration?.endTimestamp || null
            };
        }
        return null;
    }

    /**
     * Parse all <table> elements in an HTML doc to row-objects keyed by header text.
     * Returns a flat array (concatenated across all tables).
     */
    parseGenericHtmlTables(html) {
        const out = [];
        try {
            const root = parseHTML(html);
            const tables = root.querySelectorAll('table');
            for (const table of tables) {
                const headerEls = table.querySelectorAll('th');
                let headers = Array.from(headerEls).map(h => h.text.trim());
                const rows = table.querySelectorAll('tr');
                // If no <th>, use first row as headers
                let startIdx = 1;
                if (!headers.length && rows.length) {
                    headers = Array.from(rows[0].querySelectorAll('td')).map(c => c.text.trim());
                    startIdx = 1;
                }
                for (let i = startIdx; i < rows.length; i++) {
                    const cells = rows[i].querySelectorAll('td');
                    if (!cells.length) continue;
                    const obj = {};
                    cells.forEach((c, idx) => {
                        const key = headers[idx] || `col${idx}`;
                        obj[key] = c.text.trim();
                    });
                    out.push(obj);
                }
            }
        } catch (_) { /* ignore */ }
        return out;
    }

    // ─── Export Summary Parser ──────────────────────────────────────────

    parseExportSummary(text) {
        const result = { email: null, accountId: null, service: null, resource: null, dateRange: { start: null, end: null } };
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Originating Identifier:')) {
                const m = trimmed.match(/:\s*(.+?)\s*\[/);
                if (m) result.email = m[1];
            }
            if (trimmed.startsWith('Resolved Identifier:')) {
                const m = trimmed.match(/:\s*(\d+)/);
                if (m) result.accountId = m[1];
            }
            if (trimmed.startsWith('Service:')) {
                result.service = trimmed.replace('Service:', '').trim();
            }
            if (trimmed.startsWith('Resource:')) {
                result.resource = trimmed.replace('Resource:', '').trim();
            }
            if (trimmed.startsWith('Start of date range:')) {
                const val = trimmed.replace('Start of date range:', '').trim();
                if (val !== 'Not Specified.') result.dateRange.start = val;
            }
            if (trimmed.startsWith('End of date range:')) {
                const val = trimmed.replace('End of date range:', '').trim();
                if (val !== 'Not Specified.') result.dateRange.end = val;
            }
        }
        return result;
    }

    // ─── Subscriber Info Parser ─────────────────────────────────────────

    parseSubscriberInfo(html) {
        const root = parseHTML(html);
        const result = {
            name: null, givenName: null, familyName: null,
            email: null, alternateEmails: null,
            accountId: null, createdOn: null, tosIp: null,
            tosLanguage: null, birthday: null,
            services: null, status: null, lastUpdated: null,
            lastLogins: [], deletionDate: null,
            recovery: { contactEmail: null, recoveryEmail: null, recoverySms: null },
            phoneNumbers: { user: null, twoStep: null },
            devices: null,
            ipActivity: []
        };

        // Parse <li> elements
        const items = root.querySelectorAll('li');
        for (const li of items) {
            const text = li.text.trim();
            this._matchField(text, 'Google Account ID:', v => result.accountId = v);
            this._matchField(text, 'Name:', v => result.name = v);
            this._matchField(text, 'Given Name:', v => result.givenName = v);
            this._matchField(text, 'Family Name:', v => result.familyName = v);
            this._matchField(text, 'e-Mail:', v => result.email = v);
            this._matchField(text, 'Alternate e-Mails:', v => result.alternateEmails = v || null);
            this._matchField(text, 'Created on:', v => result.createdOn = v);
            this._matchField(text, 'Terms of Service IP:', v => result.tosIp = v);
            this._matchField(text, 'Terms of Service Language:', v => result.tosLanguage = v);
            this._matchField(text, 'Birthday (Month Day, Year):', v => result.birthday = v);
            this._matchField(text, 'Services:', v => result.services = v);
            this._matchField(text, 'Status:', v => result.status = v);
            this._matchField(text, 'Last Updated Date:', v => result.lastUpdated = v);
            this._matchField(text, 'Last Logins:', v => result.lastLogins = v.split(',').map(s => s.trim()).filter(Boolean));
            this._matchField(text, 'Deletion Date:', v => result.deletionDate = v || null);
            this._matchField(text, 'Contact e-Mail:', v => result.recovery.contactEmail = v);
            this._matchField(text, 'Recovery e-Mail:', v => result.recovery.recoveryEmail = v || null);
            this._matchField(text, 'Recovery SMS:', v => result.recovery.recoverySms = v || null);
            this._matchField(text, 'User Phone Numbers:', v => result.phoneNumbers.user = v || null);
            this._matchField(text, '2-Step Verification Phone Numbers:', v => result.phoneNumbers.twoStep = v || null);
        }

        // Parse IP Activity table
        const rows = root.querySelectorAll('table tr');
        for (let i = 1; i < rows.length; i++) { // skip header
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 3) {
                result.ipActivity.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    ip: cells[1]?.text?.trim() || '',
                    activityType: cells[2]?.text?.trim() || '',
                    androidId: cells[3]?.text?.trim() || '',
                    appleIdfv: cells[4]?.text?.trim() || '',
                    userAgent: cells[5]?.text?.trim() || ''
                });
            }
        }

        return result;
    }

    _matchField(text, label, setter) {
        if (text.startsWith(label)) {
            setter(text.substring(label.length).trim());
        }
    }

    // ─── Change History Parser ──────────────────────────────────────────

    parseChangeHistory(html) {
        const root = parseHTML(html);
        const rows = root.querySelectorAll('table tr');
        const changes = [];
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 5) {
                changes.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    ip: cells[1]?.text?.trim() || '',
                    changeType: cells[2]?.text?.trim() || '',
                    oldValue: cells[3]?.text?.trim() || '',
                    newValue: cells[4]?.text?.trim() || ''
                });
            }
        }
        return changes;
    }

    // ─── MBOX Parser ────────────────────────────────────────────────────

    async parseMbox(buffer) {
        // Kept for callers holding a small Buffer; large returns use
        // parseMboxStream directly (see _parseCategory).
        const emails = [];
        await this.parseMboxStream(Readable.from([Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf-8')]), (em) => { emails.push(em); });
        return emails;
    }

    // ─── Mail Metadata Parser ───────────────────────────────────────────

    parseMailMetadata(jsonStr) {
        const data = JSON.parse(jsonStr);
        const item = data.item || data;
        return {
            messageId: item.item_key?.server_id?.toString() || null,
            threadId: item.thread_key?.server_id?.toString() || null,
            creationTime: item.creation_time_microseconds
                ? new Date(item.creation_time_microseconds / 1000).toISOString()
                : null,
            lastModified: item.last_modification_time_us
                ? new Date(item.last_modification_time_us / 1000).toISOString()
                : null,
            readTime: item.read_ts
                ? new Date(item.read_ts / 1000).toISOString()
                : null
        };
    }

    // ─── Location History Parsers ───────────────────────────────────────

    parseLocationRecords(jsonStr) {
        const data = JSON.parse(jsonStr);
        const locations = data.locations || [];
        return locations.map(loc => ({
            timestamp: loc.timestamp || (loc.timestampMs ? new Date(parseInt(loc.timestampMs)).toISOString() : null),
            lat: loc.latitudeE7 ? loc.latitudeE7 / 1e7 : null,
            lng: loc.longitudeE7 ? loc.longitudeE7 / 1e7 : null,
            accuracy: loc.accuracy || null,
            altitude: loc.altitude || null,
            velocity: loc.velocity || null,
            heading: loc.heading || null,
            source: loc.source || null,
            deviceTag: loc.deviceTag || null,
            activity: loc.activity || null
        }));
    }

    parseSemanticLocation(jsonStr) {
        const data = JSON.parse(jsonStr);
        const items = data.timelineObjects || [];
        return items.map(obj => {
            if (obj.placeVisit) {
                const pv = obj.placeVisit;
                return {
                    type: 'placeVisit',
                    name: pv.location?.name || null,
                    address: pv.location?.address || null,
                    placeId: pv.location?.placeId || null,
                    lat: pv.location?.latitudeE7 ? pv.location.latitudeE7 / 1e7 : null,
                    lng: pv.location?.longitudeE7 ? pv.location.longitudeE7 / 1e7 : null,
                    startTime: pv.duration?.startTimestamp || null,
                    endTime: pv.duration?.endTimestamp || null,
                    confidence: pv.location?.locationConfidence || null
                };
            } else if (obj.activitySegment) {
                const as = obj.activitySegment;
                return {
                    type: 'activitySegment',
                    activityType: as.activityType || null,
                    confidence: as.confidence || null,
                    distance: as.distance || null,
                    startLat: as.startLocation?.latitudeE7 ? as.startLocation.latitudeE7 / 1e7 : null,
                    startLng: as.startLocation?.longitudeE7 ? as.startLocation.longitudeE7 / 1e7 : null,
                    endLat: as.endLocation?.latitudeE7 ? as.endLocation.latitudeE7 / 1e7 : null,
                    endLng: as.endLocation?.longitudeE7 ? as.endLocation.longitudeE7 / 1e7 : null,
                    startTime: as.duration?.startTimestamp || null,
                    endTime: as.duration?.endTimestamp || null
                };
            }
            return null;
        }).filter(Boolean);
    }

    // ─── Google Play Store Parsers ──────────────────────────────────────

    parseDevicesCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => {
            // Extract device info from nested "Most Recent Data" field
            const recentData = row['Most Recent Data'] || row['Data At Time Of User Play Activity'] || '';
            const extract = (key) => {
                const m = recentData.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
                return m ? m[1].trim() : null;
            };

            return {
                androidId: row['Android Id'] || null,
                registrationTime: row['Device Registration Time'] || null,
                lastActive: row['Last Time Device Active'] || null,
                manufacturer: extract('manufacturer'),
                model: extract('model_name'),
                deviceName: extract('device_name'),
                brand: extract('retail_brand'),
                carrier: extract('carrier_name'),
                country: extract('device_ip_country'),
                locale: extract('user_locale'),
                sdkVersion: extract('android_sdk_version'),
                buildFingerprint: extract('build_fingerprint'),
                totalMemory: extract('total_memory_bytes'),
                platform: extract('native_platform')
            };
        });
    }

    parseInstallsCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => ({
            packageName: row['Doc Package Name'] || row['Package Name'] || null,
            title: row['Doc Title'] || null,
            installTime: row['First Installation Time'] || null,
            lastUpdate: row['Last Update Time'] || null,
            state: row['State'] || null,
            installSource: row['Install Source'] || null,
            isSystemApp: row['Is System App'] === 'true',
            deviceModel: row['Device Attribute Model'] || null,
            deviceManufacturer: row['Device Attribute Manufacturer'] || null
        }));
    }

    parseLibraryCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => ({
            packageName: row['Doc Backend Docid'] || null,
            title: row['Doc Title'] || null,
            type: row['Doc Document Type'] || null,
            url: row['Doc Url'] || null,
            acquisitionTime: row['Acquisition Time'] || null,
            hidden: row['Hidden'] === 'true'
        }));
    }

    parseUserActivityHtml(html) {
        const root = parseHTML(html);
        const activities = [];

        // Google uses Material Design Lite cards — each activity is in .outer-cell
        const cards = root.querySelectorAll('.outer-cell');
        for (const card of cards) {
            const bodyEl = card.querySelector('.content-cell.mdl-typography--body-1');
            if (!bodyEl) continue;

            const bodyHtml = bodyEl.innerHTML;
            const bodyText = bodyEl.text.trim();

            // Split on <br> to get action and timestamp
            const parts = bodyHtml.split(/<br\s*\/?>/i);
            const action = parts[0] ? parts[0].replace(/<[^>]+>/g, '').trim() : bodyText;
            const timestamp = parts[1] ? parts[1].replace(/<[^>]+>/g, '').trim() : '';

            // Extract link if present
            const linkEl = bodyEl.querySelector('a');
            const link = linkEl ? linkEl.getAttribute('href') : null;

            activities.push({ action, timestamp, link });
        }

        return activities;
    }

    // ─── Hangouts Parser ────────────────────────────────────────────────

    parseHangoutsUserInfo(text) {
        const result = {};
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed.includes(':')) continue;
            const colonIdx = trimmed.indexOf(':');
            const key = trimmed.substring(0, colonIdx).trim();
            const val = trimmed.substring(colonIdx + 1).trim();
            if (key && val) result[key] = val;
        }
        return result;
    }

    // ─── Access Log Parser ──────────────────────────────────────────────

    parseAccessLogHtml(html) {
        const root = parseHTML(html);
        const rows = root.querySelectorAll('table tr');
        const activities = [];
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 2) {
                activities.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    activity: cells[1]?.text?.trim() || '',
                    ip: cells[2]?.text?.trim() || '',
                    details: cells[3]?.text?.trim() || ''
                });
            }
        }
        return activities;
    }

    // ─── Google Pay Parser ──────────────────────────────────────────────

    parseGooglePayHtml(html) {
        const root = parseHTML(html);
        const result = { transactions: [], instruments: [], addresses: [] };

        // Google Pay HTML varies — try to extract tables
        const tables = root.querySelectorAll('table');
        for (const table of tables) {
            const headers = table.querySelectorAll('th');
            const headerTexts = Array.from(headers).map(h => h.text.trim().toLowerCase());

            const rows = table.querySelectorAll('tr');
            for (let i = 1; i < rows.length; i++) {
                const cells = rows[i].querySelectorAll('td');
                const obj = {};
                cells.forEach((cell, idx) => {
                    const key = headerTexts[idx] || `col${idx}`;
                    obj[key] = cell.text.trim();
                });

                if (headerTexts.some(h => h.includes('transaction') || h.includes('amount'))) {
                    result.transactions.push(obj);
                } else if (headerTexts.some(h => h.includes('card') || h.includes('instrument') || h.includes('payment'))) {
                    result.instruments.push(obj);
                } else if (headerTexts.some(h => h.includes('address') || h.includes('billing') || h.includes('shipping'))) {
                    result.addresses.push(obj);
                }
            }
        }

        // Also try list items for payment methods
        const sections = root.querySelectorAll('.section, div');
        for (const section of sections) {
            const bold = section.querySelector('b');
            if (bold) {
                const title = bold.text.toLowerCase();
                if (title.includes('payment') || title.includes('card') || title.includes('billing')) {
                    const items = section.querySelectorAll('li');
                    const obj = {};
                    items.forEach(li => {
                        const text = li.text.trim();
                        const colonIdx = text.indexOf(':');
                        if (colonIdx > 0) {
                            obj[text.substring(0, colonIdx).trim()] = text.substring(colonIdx + 1).trim();
                        }
                    });
                    if (Object.keys(obj).length > 0) {
                        result.instruments.push(obj);
                    }
                }
            }
        }

        return result;
    }

    // ─── CSV Parser ─────────────────────────────────────────────────────

    csvToObjects(csvStr) {
        const records = this._parseCsvFull(csvStr);
        if (records.length < 2) return [];

        const headers = records[0];
        const objects = [];

        for (let i = 1; i < records.length; i++) {
            const values = records[i];
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h.trim()] = (values[idx] || '').trim();
            });
            objects.push(obj);
        }

        return objects;
    }

    /**
     * Full CSV parser that handles multi-line quoted fields
     */
    _parseCsvFull(csvStr) {
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
                    if (current.some(f => f.trim())) records.push(current);
                    current = [];
                    i += (ch === '\r') ? 2 : 1;
                } else if (ch === '\r') {
                    current.push(field);
                    field = '';
                    if (current.some(f => f.trim())) records.push(current);
                    current = [];
                    i++;
                } else {
                    field += ch;
                    i++;
                }
            }
        }

        // Last field/record
        if (field || current.length > 0) {
            current.push(field);
            if (current.some(f => f.trim())) records.push(current);
        }

        return records;
    }

    // ─── Detection Heuristic ────────────────────────────────────────────

    /**
     * Check if a ZIP is a Google warrant return.
     * Accepts a Buffer (legacy) OR a file path (preferred — central
     * directory only, no full-file read). Returns boolean.
     *
     * For backward compatibility this remains synchronous when given a
     * Buffer; pass a path to use the streaming async detector.
     * @param {Buffer|string} input
     * @returns {boolean | Promise<boolean>}
     */
    static isGoogleWarrantZip(input, options) {
        if (typeof input === 'string') {
            return GoogleWarrantParser.isGoogleWarrantZipAsync(input, options);
        }
        try {
            const zip = new AdmZip(input);
            const entries = zip.getEntries();
            for (const entry of entries) {
                const name = entry.entryName;
                if (name.includes('ExportSummary.txt')) return true;
                if (/\.\d+\.(GoogleAccount|GooglePlayStore|Mail|LocationHistory|GoogleChat|Hangouts|GooglePay|Drive)\./i.test(name)) return true;
            }
        } catch (e) { /* not a valid zip */ }
        return false;
    }

    static async isGoogleWarrantZipAsync(filePath, options = {}) {
        let zip;
        try {
            zip = await openZip(filePath, { security: options.security });
            const entries = zip.getEntries();
            for (const entry of entries) {
                const name = entry.entryName;
                if (name.includes('ExportSummary.txt')) return true;
                if (/\.\d+\.(GoogleAccount|GooglePlayStore|Mail|LocationHistory|GoogleChat|Hangouts|GooglePay|Drive)\./i.test(name)) return true;
            }
        } catch (e) { /* not a valid zip */ }
        finally { try { if (zip) zip.close(); } catch (_) {} }
        return false;
    }
}

GoogleWarrantParser.streamJsonArray = streamJsonArray;
GoogleWarrantParser.FolderReader = FolderReader;
GoogleWarrantParser.LIMITS = { INNER_BUFFER_MAX, MAX_INLINE_ENTRY, MBOX_MESSAGE_MAX, INLINE_ROW_CAP, INLINE_EMAIL_CAP, INLINE_LOCATION_CAP, INLINE_TEXT_CAP, RESULT_CHAR_BUDGET };
module.exports = GoogleWarrantParser;
