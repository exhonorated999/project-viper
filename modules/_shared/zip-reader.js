/**
 * VIPER Shared ZIP Reader
 * ─────────────────────────────────────────────────────────────────────────
 * Drop-in adm-zip API replacement that supports ZIP64 and streams entries
 * from disk on demand, so warrant returns larger than 2 GB no longer hit
 *
 *   • fs.readFileSync's ~2 GiB Buffer limit (ERR_FS_FILE_TOO_LARGE)
 *   • adm-zip's 32-bit central-directory offsets (silent garbage past 2 GB)
 *
 * Use openZip(input, options) — input may be a file path (preferred for
 * large warrant returns) OR a Buffer (used for small inner-zip blobs).
 * Returns a reader exposing the same surface VIPER parsers already use:
 *
 *   reader.getEntries()                  → [{ entryName, isDirectory, size, getData() }]
 *   reader.readAsText(entryOrName)       → utf-8 string
 *   reader.extractEntryToFile(entry, p)  → Promise<void>
 *   reader.close()                       → release file handle + temp files
 *
 * Backed by node-stream-zip in file mode, adm-zip in buffer mode.
 *
 * If options.security is a VIPER security helper and the input is a
 * VIPENC-encrypted file, we transparently decrypt to a temp file (for
 * paths) or decrypt in place (for buffers) before opening.
 */

const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');
const StreamZip = require('node-stream-zip');

class ZipReader {
    constructor() {
        this._mode = null;        // 'file' | 'buffer'
        this._zip = null;         // node-stream-zip instance
        this._adm = null;         // adm-zip fallback (small inner zips)
        this._tempFiles = [];     // cleanup queue
        this._entryList = null;   // cached entries array
        this._sourcePath = null;  // resolved path on disk (or null if buffer)
    }

    static async open(input, options = {}) {
        const reader = new ZipReader();
        await reader._init(input, options);
        return reader;
    }

    async _init(input, options) {
        // Optional password for password-protected entries. Held only on this
        // reader instance (cleared in close()); never logged.
        this._password = (options && options.password != null && options.password !== '') ? String(options.password) : null;
        if (Buffer.isBuffer(input)) {
            const buf = this._maybeDecryptBuffer(input, options.security);
            this._openFromBuffer(buf);
            return;
        }
        if (typeof input === 'string') {
            let zipPath = input;
            // Peek for VIPENC encryption when Field Security is active
            if (options.security && options.security.isUnlocked && options.security.isUnlocked()) {
                const header = ZipReader._peekHeader(zipPath, 8);
                if (header && options.security.isEncryptedBuffer && options.security.isEncryptedBuffer(header)) {
                    // Encrypted warrant returns must be decrypted before reading the
                    // central directory. Decrypt → temp file. (Encrypted files are
                    // assumed to fit in memory — they were originally written by us.)
                    const buf = options.security.decryptBuffer(fs.readFileSync(zipPath));
                    zipPath = ZipReader._writeTemp(buf, '.zip');
                    this._tempFiles.push(zipPath);
                }
            }
            await this._openFromFile(zipPath);
            return;
        }
        throw new Error('ZipReader.open: input must be a Buffer or file path');
    }

    _maybeDecryptBuffer(buf, security) {
        if (
            security &&
            security.isUnlocked && security.isUnlocked() &&
            security.isEncryptedBuffer && security.isEncryptedBuffer(buf)
        ) {
            return security.decryptBuffer(buf);
        }
        return buf;
    }

    _openFromBuffer(buf) {
        // Used for SMALL buffers only (inner-zip blobs, detection peeks).
        // Large outer warrant returns should always use the file path branch.
        const AdmZip = require('adm-zip');
        this._adm = new AdmZip(buf);
        this._mode = 'buffer';
    }

    _openFromFile(zipPath) {
        this._sourcePath = zipPath;
        return new Promise((resolve, reject) => {
            const zip = new StreamZip({ file: zipPath, storeEntries: true });
            zip.on('ready', () => { this._zip = zip; this._mode = 'file'; resolve(); });
            zip.on('error', err => reject(err));
        });
    }

    static _peekHeader(zipPath, n) {
        try {
            const fd = fs.openSync(zipPath, 'r');
            try {
                const buf = Buffer.alloc(n);
                fs.readSync(fd, buf, 0, n, 0);
                return buf;
            } finally { fs.closeSync(fd); }
        } catch (_) { return null; }
    }

    static _writeTemp(buf, ext) {
        const name = `viper-zip-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext || ''}`;
        const p = path.join(os.tmpdir(), name);
        fs.writeFileSync(p, buf);
        return p;
    }

    // ─── adm-zip-compatible surface ─────────────────────────────────────

    getEntries() {
        if (this._entryList) return this._entryList;
        if (this._mode === 'buffer') {
            this._entryList = this._adm.getEntries();
            return this._entryList;
        }
        const raw = this._zip.entries();
        const self = this;
        this._entryList = Object.values(raw).map(e => ({
            entryName: e.name,
            isDirectory: !!e.isDirectory,
            size: e.size,
            compressedSize: e.compressedSize,
            // The checksum and date the zip's own directory records — kept so
            // an index can later prove a file is unchanged.
            crc: e.crc,
            time: e.time,
            // Password-protected entry (GP flag bit 0). Read through
            // _readEncrypted() with the reader's password.
            encrypted: !!e.encrypted,
            _name: e.name,
            getData() { return self._entryData(this._name); },
        }));
        return this._entryList;
    }

    /** True when any file entry is password-protected. */
    hasEncryptedEntries() {
        return this.getEntries().some(e => e && !e.isDirectory && e.encrypted);
    }

    _rawEntry(name) {
        return (this._mode === 'file' && this._zip) ? this._zip.entry(name) : null;
    }

    _readEncrypted(raw) {
        const { readEncryptedEntry } = require('./zip-crypto');
        if (this._cryptFd == null) this._cryptFd = fs.openSync(this._sourcePath, 'r');
        return readEncryptedEntry(this._cryptFd, raw, this._password);
    }

    /** Entry bytes; decrypts password-protected entries, otherwise unchanged. */
    _entryData(name) {
        const raw = this._rawEntry(name);
        if (raw && raw.encrypted) return this._readEncrypted(raw);
        return this._zip.entryDataSync(name);
    }

    readAsText(entryOrName) {
        if (this._mode === 'buffer') {
            return this._adm.readAsText(entryOrName);
        }
        const name = (typeof entryOrName === 'string')
            ? entryOrName
            : (entryOrName && (entryOrName._name || entryOrName.entryName));
        if (!name) return '';
        return this._entryData(name).toString('utf-8');
    }

    /**
     * Open one entry as a Readable WITHOUT buffering it.  Required for the
     * 355 MB message CSVs in large warrant returns — readAsText() on those
     * costs a Buffer plus a same-sized JS string before parsing even starts.
     */
    openStream(entryOrName) {
        const name = (typeof entryOrName === 'string')
            ? entryOrName
            : (entryOrName && (entryOrName._name || entryOrName.entryName));
        if (!name) return Promise.resolve(null);
        if (this._mode === 'buffer') {
            const ent = this._adm.getEntry(name);
            if (!ent) return Promise.resolve(null);
            return Promise.resolve(require('stream').Readable.from([ent.getData()]));
        }
        const rawS = this._rawEntry(name);
        if (rawS && rawS.encrypted) {
            try { return Promise.resolve(require('stream').Readable.from([this._readEncrypted(rawS)])); }
            catch (e) { return Promise.reject(e); }
        }
        return new Promise((resolve, reject) => {
            this._zip.stream(name, (err, stm) => err ? reject(err) : resolve(stm));
        });
    }

    /**
     * Extract one entry to a target path on disk WITHOUT buffering the whole
     * entry in memory. Use this when an inner-zip or media file might itself
     * be multi-GB.
     */
    extractEntryToFile(entryOrName, destPath) {
        const name = (typeof entryOrName === 'string')
            ? entryOrName
            : (entryOrName && (entryOrName._name || entryOrName.entryName));
        if (this._mode === 'buffer') {
            const ent = this._adm.getEntry(name);
            if (!ent) throw new Error(`ZipReader.extractEntryToFile: entry not found: ${name}`);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, ent.getData());
            return Promise.resolve();
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const rawX = this._rawEntry(name);
        if (rawX && rawX.encrypted) {
            try { fs.writeFileSync(destPath, this._readEncrypted(rawX)); return Promise.resolve(); }
            catch (e) { return Promise.reject(e); }
        }
        return new Promise((resolve, reject) => {
            this._zip.extract(name, destPath, (err) => err ? reject(err) : resolve());
        });
    }

    /**
     * Extract one entry to a freshly-named temp file and return its path.
     * Used by parsers that need to recursively open an inner ZIP that
     * itself may exceed 2 GB.
     */
    async extractEntryToTemp(entryOrName, ext) {
        const tmp = ZipReader._writeTemp(Buffer.alloc(0), ext || path.extname(
            (typeof entryOrName === 'string') ? entryOrName : (entryOrName.entryName || entryOrName._name || '')
        ));
        // We wrote a placeholder; replace via the real extract.
        try { fs.unlinkSync(tmp); } catch (_) {}
        await this.extractEntryToFile(entryOrName, tmp);
        this._tempFiles.push(tmp);
        return tmp;
    }

    close() {
        try { if (this._zip) this._zip.close(); } catch (_) {}
        try { if (this._cryptFd != null) fs.closeSync(this._cryptFd); } catch (_) {}
        this._cryptFd = null;
        this._password = null;
        for (const t of this._tempFiles) {
            try { fs.unlinkSync(t); } catch (_) {}
        }
        this._tempFiles = [];
        this._zip = null;
        this._adm = null;
        this._entryList = null;
    }
}

/**
 * Resolve a possibly-encrypted warrant ZIP on disk to a *plain* ZIP file
 * path that streaming readers can open. Caller MUST invoke the returned
 * cleanup() once they're done.
 *
 *   const { path, cleanup } = await resolveZipPath(filePath, security);
 *   try { ... open path ... } finally { cleanup(); }
 *
 * For NON-encrypted files this is effectively a no-op (returns the input
 * path; cleanup() is a no-op). For VIPENC-encrypted files the buffer is
 * decrypted to a temp file once and cleanup() unlinks it.
 */
function resolveZipPath(filePath, security) {
    try {
        if (security && security.isUnlocked && security.isUnlocked()) {
            const header = ZipReader._peekHeader(filePath, 8);
            if (header && security.isEncryptedBuffer && security.isEncryptedBuffer(header)) {
                const buf = security.decryptBuffer(fs.readFileSync(filePath));
                const tmp = ZipReader._writeTemp(buf, '.zip');
                return {
                    path: tmp,
                    cleanup: () => { try { fs.unlinkSync(tmp); } catch (_) {} },
                };
            }
        }
    } catch (_) { /* fall through to passthrough */ }
    return { path: filePath, cleanup: () => {} };
}

const openZip = (input, options) => ZipReader.open(input, options);

module.exports = { ZipReader, openZip, resolveZipPath };
