/**
 * VIPER AMP Case Importer  (modules/amp-import/amp-import.js)
 * ─────────────────────────────────────────────────────────────────────────
 * Ingests an AMP `.ampcase` file — a ZIP containing a GeoPackage (SQLite)
 * `project.gpkg`, `attachments/`, `manifest.json`, and
 * `checksums/sha256-manifest.txt` — and normalizes it into a VIPER CDR dump.
 *
 * Runs in the Electron MAIN process (Node). Uses:
 *   • modules/_shared/zip-reader.js  → open the .ampcase (handles ZIP64 + VIPENC)
 *   • better-sqlite3                 → read project.gpkg read-only
 *
 * The .ampcase is already fully geocoded, so no tower geodatabase is needed:
 * every location row carries a GeoPackage point geometry plus optional tower
 * sector geometry (azimuth / beamwidth / inner-outer radius).
 *
 * SHA-256 verification: every file listed in checksums/sha256-manifest.txt is
 * hashed from the archive and compared — a green "verified" badge is only
 * returned when every listed file matches (chain-of-custody at intake).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { openZip } = require('../_shared/zip-reader');

// ── GeoPackage geometry BLOB decoder ───────────────────────────────────────
// Layout: 'GP'(2) | version(1) | flags(1) | srs_id(int32) | [envelope] | WKB
// flags bit-1..3 select the envelope size; WKB point = byteOrder(1) +
// geomType(uint32) + X(double) + Y(double). For EPSG:4326, X=lon, Y=lat.
function decodeGpkgPoint(blob) {
    if (!blob || blob.length < 8) return null;
    if (blob[0] !== 0x47 || blob[1] !== 0x50) return null; // 'GP'
    const flags = blob[3];
    const envInd = (flags >> 1) & 0x07;
    const envBytes = { 0: 0, 1: 32, 2: 48, 3: 48, 4: 64 }[envInd];
    if (envBytes === undefined) return null;
    const off = 8 + envBytes;
    if (off + 21 > blob.length) return null;
    const le = blob[off] === 1;
    const geomType = le ? blob.readUInt32LE(off + 1) : blob.readUInt32BE(off + 1);
    if ((geomType & 0xff) !== 1) return null; // only Point supported here
    const x = le ? blob.readDoubleLE(off + 5) : blob.readDoubleBE(off + 5);
    const y = le ? blob.readDoubleLE(off + 13) : blob.readDoubleBE(off + 13);
    if (!isFinite(x) || !isFinite(y)) return null;
    return { lon: x, lat: y };
}

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseChecksumManifest(text) {
    // Lines: "<hex>  <relative/path>"
    const out = {};
    if (!text) return out;
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})\s+(.+?)\s*$/);
        if (m) out[m[2].replace(/\\/g, '/')] = m[1].toLowerCase();
    }
    return out;
}

// AMP kind → VIPER callType base + direction ("voice-outgoing" etc.)
function commKindToCallType(kind, outgoing) {
    const k = String(kind || '').toLowerCase();
    let base = 'data';
    if (k.includes('voice') || k.includes('call')) base = 'voice';
    else if (k.includes('text') || k.includes('sms') || k.includes('mms')) base = 'sms';
    else if (k.includes('data') || k.includes('session')) base = 'data';
    return base + (outgoing ? '-outgoing' : '-incoming');
}

function safeCols(db, table) {
    try {
        return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    } catch (_) { return new Set(); }
}

function tableExists(db, name) {
    try {
        return !!db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?"
        ).get(name);
    } catch (_) { return false; }
}

/**
 * Parse a .ampcase file into a normalized VIPER CDR payload.
 * @param {string} filePath  absolute path to the .ampcase file
 * @param {object} [opts]    { security } VIPER security helper (for VIPENC)
 * @returns {Promise<object>} normalized payload (see fields below)
 */
async function parseAmpcase(filePath, opts = {}) {
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (e) {
        const err = new Error(
            'better-sqlite3 is required to import .ampcase files. Run `npm install` and rebuild against Electron (electron-rebuild).'
        );
        err.cause = e;
        throw err;
    }

    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('AMP case file not found: ' + filePath);
    }

    const reader = await openZip(filePath, { security: opts.security });
    const tempFiles = [];
    let db = null;

    try {
        const entries = reader.getEntries();
        const byName = {};
        for (const e of entries) if (!e.isDirectory) byName[e.entryName.replace(/\\/g, '/')] = e;

        // ── manifest ───────────────────────────────────────────────────────
        let manifest = {};
        if (byName['manifest.json']) {
            try { manifest = JSON.parse(reader.readAsText(byName['manifest.json'])); } catch (_) {}
        }
        if (manifest.format && manifest.format !== 'ampcase') {
            throw new Error('Unrecognized case format: ' + manifest.format);
        }

        // ── integrity: verify every file listed in the checksum manifest ─────
        const expected = parseChecksumManifest(
            byName['checksums/sha256-manifest.txt']
                ? reader.readAsText(byName['checksums/sha256-manifest.txt'])
                : ''
        );
        const integrityFiles = [];
        let allOk = Object.keys(expected).length > 0;
        for (const [rel, hex] of Object.entries(expected)) {
            const ent = byName[rel];
            let actual = null;
            if (ent) { try { actual = sha256Hex(ent.getData()); } catch (_) {} }
            const ok = !!actual && actual === hex;
            if (!ok) allOk = false;
            integrityFiles.push({ name: rel, expected: hex, actual, ok });
        }

        // ── extract project.gpkg to a temp file and open it read-only ────────
        const gpkgEntry = byName['project.gpkg']
            || entries.find(e => /\.gpkg$/i.test(e.entryName));
        if (!gpkgEntry) throw new Error('No project.gpkg found inside the .ampcase');
        const tmpGpkg = path.join(
            os.tmpdir(),
            `viper-ampcase-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.gpkg`
        );
        await reader.extractEntryToFile(gpkgEntry, tmpGpkg);
        tempFiles.push(tmpGpkg);

        db = new Database(tmpGpkg, { readonly: true, fileMustExist: true });

        // ── amp_case (key/value metadata) ────────────────────────────────────
        const ampMeta = {
            schemaVersion: manifest.schema_version || null,
            app: manifest.app || 'AMP',
            appVersion: manifest.app_version || '',
            caseName: manifest.case_name || '',
            savedUtc: manifest.saved_utc || '',
            timeZone: manifest.time_zone || '',
            caseUid: null,
        };
        if (tableExists(db, 'amp_case')) {
            for (const row of db.prepare('SELECT key,value FROM amp_case').all()) {
                if (row.key === 'case_uid') ampMeta.caseUid = row.value;
                if (row.key === 'case_name' && !ampMeta.caseName) ampMeta.caseName = row.value;
                if (row.key === 'time_zone' && !ampMeta.timeZone) ampMeta.timeZone = row.value;
            }
        }

        // ── datasets (per-device / per-layer) ────────────────────────────────
        const datasets = [];
        const dsById = {};
        if (tableExists(db, 'amp_datasets')) {
            const c = safeCols(db, 'amp_datasets');
            for (const r of db.prepare('SELECT * FROM amp_datasets').all()) {
                const d = {
                    id: r.id,
                    folderId: c.has('folder_id') ? r.folder_id : null,
                    name: r.name || ('Dataset ' + r.id),
                    color: r.color || '#00d9ff',
                    sourceType: c.has('source_type') ? r.source_type : null,
                    target: c.has('target') ? (r.target || '') : '',
                    imei: c.has('target_imei') ? (r.target_imei || '') : '',
                    imsi: c.has('target_imsi') ? (r.target_imsi || '') : '',
                    showTrack: c.has('show_track') ? !!r.show_track : false,
                    visible: c.has('visible') ? (r.visible == null ? true : !!r.visible) : true,
                    sort: c.has('sort') ? r.sort : 0,
                };
                datasets.push(d);
                dsById[d.id] = d;
            }
        }

        // ── location_points (geo) ─────────────────────────────────────────────
        const points = [];
        let minT = null, maxT = null;
        if (tableExists(db, 'location_points')) {
            const c = safeCols(db, 'location_points');
            for (const r of db.prepare('SELECT * FROM location_points').all()) {
                const pt = decodeGpkgPoint(r.geom);
                if (!pt) continue;
                const t = c.has('t_utc_ms') ? r.t_utc_ms : null;
                if (t != null) { if (minT == null || t < minT) minT = t; if (maxT == null || t > maxT) maxT = t; }
                points.push({
                    fid: r.fid,
                    datasetId: c.has('dataset_id') ? r.dataset_id : null,
                    lat: pt.lat,
                    lon: pt.lon,
                    tUtcMs: t,
                    label: c.has('label') ? (r.label || '') : '',
                    callout: c.has('callout') ? (r.callout || '') : '',
                    accuracyM: c.has('accuracy_m') ? r.accuracy_m : null,
                    sectorAz: c.has('sector_az') ? r.sector_az : null,
                    sectorBw: c.has('sector_bw') ? r.sector_bw : null,
                    sectorInner: c.has('sector_inner') ? r.sector_inner : null,
                    sectorOuter: c.has('sector_outer') ? r.sector_outer : null,
                    tower: c.has('tower') ? !!r.tower : false,
                    approx: c.has('approx') ? !!r.approx : false,
                });
            }
        }

        // ── comms (CDR events) ────────────────────────────────────────────────
        const comms = [];
        const records = [];
        if (tableExists(db, 'amp_comms')) {
            const c = safeCols(db, 'amp_comms');
            let idx = 0;
            for (const r of db.prepare('SELECT * FROM amp_comms').all()) {
                const t = c.has('t_utc_ms') ? r.t_utc_ms : null;
                const outgoing = c.has('outgoing') ? !!r.outgoing : false;
                const other = c.has('other') ? (r.other || '') : '';
                const durS = c.has('duration_s') ? (r.duration_s || 0) : 0;
                const dsId = c.has('dataset_id') ? r.dataset_id : null;
                const kind = c.has('kind') ? (r.kind || '') : '';
                comms.push({
                    datasetId: dsId,
                    tUtcMs: t,
                    kind,
                    outgoing,
                    other,
                    durationS: durS,
                    pointIdx: c.has('point_idx') ? r.point_idx : -1,
                });
                // Synthesize a VIPER-schema record so existing Dashboard /
                // Network / Timeline / Frequency views work on ampcase data.
                const ds = dsId != null ? dsById[dsId] : null;
                const target = ds && ds.target ? ds.target : '';
                if (t != null) { if (minT == null || t < minT) minT = t; if (maxT == null || t > maxT) maxT = t; }
                records.push({
                    id: `amp_${dsId}_${idx++}`,
                    phoneA: outgoing ? target : other,
                    phoneB: outgoing ? other : target,
                    date: '',
                    time: '',
                    timestamp: t,
                    callType: commKindToCallType(kind, outgoing),
                    duration: durS,
                    imei: ds ? ds.imei : null,
                    imsi: ds ? ds.imsi : null,
                    towerA: null,
                    towerB: null,
                    datasetId: dsId,
                    raw: r,
                });
            }
        }

        // ── contacts (number → name) ──────────────────────────────────────────
        const contacts = {};
        if (tableExists(db, 'amp_contacts')) {
            for (const r of db.prepare('SELECT number_norm,name FROM amp_contacts').all()) {
                if (r.number_norm) contacts[String(r.number_norm)] = r.name || '';
            }
        }

        // ── pins ──────────────────────────────────────────────────────────────
        const pins = [];
        if (tableExists(db, 'amp_pins')) {
            const c = safeCols(db, 'amp_pins');
            for (const r of db.prepare('SELECT * FROM amp_pins').all()) {
                const pt = decodeGpkgPoint(r.geom);
                if (!pt) continue;
                pins.push({
                    fid: r.fid,
                    folderId: c.has('folder_id') ? r.folder_id : null,
                    lat: pt.lat,
                    lon: pt.lon,
                    name: c.has('name') ? (r.name || '') : '',
                    color: c.has('color') ? (r.color || '#ffa726') : '#ffa726',
                    address: c.has('address') ? (r.address || '') : '',
                    notes: c.has('notes') ? (r.notes || '') : '',
                    tsUtcMs: c.has('ts_utc_ms') ? r.ts_utc_ms : null,
                });
            }
        }

        // ── folders (case tree) ────────────────────────────────────────────────
        const folders = [];
        if (tableExists(db, 'amp_folders')) {
            const c = safeCols(db, 'amp_folders');
            for (const r of db.prepare('SELECT * FROM amp_folders').all()) {
                folders.push({
                    id: r.id,
                    name: r.name || '',
                    parentId: c.has('parent_id') ? r.parent_id : null,
                    color: c.has('color') ? (r.color || '') : '',
                    icon: c.has('icon') ? (r.icon || '') : '',
                });
            }
        }

        // ── analyses (tower-dump / area-search cross-match) ─────────────────────
        const analyses = [];
        if (tableExists(db, 'amp_analyses')) {
            for (const r of db.prepare('SELECT fid,name,json FROM amp_analyses').all()) {
                let d = {};
                try { d = JSON.parse(r.json || '{}'); } catch (_) {}
                analyses.push({
                    id: r.fid,
                    name: r.name || '',
                    sourceLabel: d.SourceLabel || '',
                    sourceFiles: d.SourceFiles || [],
                    warnings: d.Warnings || [],
                    locations: d.Locations || [],
                    records: d.Records || [],
                });
            }
        }

        return {
            format: 'ampcase',
            ampMeta,
            integrity: { verified: allOk, files: integrityFiles },
            datasets,
            points,
            comms,
            records,
            contacts,
            pins,
            folders,
            analyses,
            stats: {
                totalPoints: points.length,
                totalComms: comms.length,
                totalRecords: records.length,
                datasetCount: datasets.length,
                dateRangeMs: { start: minT, end: maxT },
            },
        };
    } finally {
        try { if (db) db.close(); } catch (_) {}
        try { reader.close(); } catch (_) {}
        for (const t of tempFiles) { try { fs.unlinkSync(t); } catch (_) {} }
    }
}

module.exports = { parseAmpcase, decodeGpkgPoint };
