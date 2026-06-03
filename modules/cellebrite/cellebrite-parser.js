/**
 * Cellebrite — Pure parsing functions
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1.2 — REAL impls for Device, Apps, Contacts.
 * Phase 1.3 — REAL impls for Calls, SMS/MMS, Accounts, Wi-Fi.
 *
 * Every parser returns { success, data, errors, skipped? } shape.
 * Parsers are PURE: they receive text/buffer/path and never touch IPC,
 * the UI, or process state. This keeps them unit-testable.
 */

const fs = require('fs');

let _bsqlite = null;
function _sqlite() {
    if (_bsqlite) return _bsqlite;
    _bsqlite = require('better-sqlite3');
    return _bsqlite;
}

// ─── Canonical surface list ─────────────────────────────────────────────
const SURFACES = ['device', 'apps', 'contacts', 'calls', 'sms', 'accounts', 'wifi'];

// ─── XML helpers (lightweight, regex-based) ─────────────────────────────
// We don't pull xml2js since the Cellebrite schemas are flat and the
// project pattern is regex-XML for warrant parsers. This is bounded scope.

function _xmlTag(xml, tagName) {
    // Returns FIRST occurrence inner text. Handles `<tag>X</tag>` and
    // `<ns:tag>X</ns:tag>`. Whitespace-tolerant.
    const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`, 'i');
    const m = re.exec(xml);
    if (!m) return null;
    return _xmlDecode(m[1].trim());
}

function _xmlTagAll(xml, tagName) {
    const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`, 'ig');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(_xmlDecode(m[1].trim()));
    return out;
}

function _xmlDecode(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * Parse attributes of every occurrence of <tagName ... /> or <tagName ...>.
 * Returns an array of attribute objects.
 *   _xmlElemAttrs('<Foo a="1" b="2"/>', 'Foo')  → [{a:'1', b:'2'}]
 */
function _xmlElemAttrs(xml, tagName) {
    const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}\\b([^>]*?)/?>`, 'ig');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
        out.push(_parseAttrs(m[1]));
    }
    return out;
}

function _parseAttrs(s) {
    const obj = {};
    const re = /([a-zA-Z_][a-zA-Z0-9_\-:]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s)) !== null) obj[m[1]] = _xmlDecode(m[2]);
    return obj;
}

// ─── parseUfdx ──────────────────────────────────────────────────────────
// Real Cellebrite EvidenceCollection.ufdx schema (UFED 4PC / Reader):
//
//   <EvidenceCollection EvidenceID="...">
//     <DeviceInfo Vendor="..." Model="..." ... />
//     <CrimeCase>
//       <Fields>
//         <Fields Caption="Case Identifier"   Value="..." />
//         <Fields Caption="Examiner Name"     Value="..." />
//         <Fields Caption="Device Name / Evidence Number" Value="..." />
//         ...
//       </Fields>
//     </CrimeCase>
//     <Extractions>
//       <Extraction TransferType="FileSystemDump" Path="FileSystem 01\X.ufd" />
//     </Extractions>
//   </EvidenceCollection>
function parseUfdx(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') {
        return { success: false, data: null, errors: ['empty xml'] };
    }
    try {
        // Collect every <Fields Caption=... Value=.../> tuple into a flat map.
        // (Top-level <Fields> wraps inner <Fields> attribute rows — both share
        // the tag name, but inner ones carry attributes.)
        const captionMap = {};
        for (const attrs of _xmlElemAttrs(xmlText, 'Fields')) {
            if (attrs.Caption !== undefined) {
                captionMap[attrs.Caption.trim()] = attrs.Value !== undefined ? attrs.Value : '';
            }
        }
        // Heuristic getter — tolerate caption phrasing drift.
        const getField = (...needles) => {
            for (const need of needles) {
                const lc = need.toLowerCase();
                for (const k of Object.keys(captionMap)) {
                    if (k.toLowerCase() === lc) return captionMap[k];
                }
            }
            for (const need of needles) {
                const lc = need.toLowerCase();
                for (const k of Object.keys(captionMap)) {
                    if (k.toLowerCase().includes(lc)) return captionMap[k];
                }
            }
            return null;
        };

        const deviceInfoAttrs = _xmlElemAttrs(xmlText, 'DeviceInfo')[0] || {};
        const extractionAttrs = _xmlElemAttrs(xmlText, 'Extraction');
        const extractions = extractionAttrs.map(a => ({
            transferType: a.TransferType || '',
            path: (a.Path || '').replace(/\\/g, '/'),
        }));
        // Surface the .ufd basename(s) for downstream resolution.
        const fileSystemPaths = extractions.map(e => e.path).filter(Boolean);

        // EvidenceCollection EvidenceID (if present).
        const evidenceColAttrs = _xmlElemAttrs(xmlText, 'EvidenceCollection')[0] || {};

        // Legacy XML-tag fallback (synthetic fixture path) — used when the
        // attribute-based Fields rows weren't found.
        const haveFields = Object.keys(captionMap).length > 0;

        const data = {
            // Legacy field shape kept for back-compat with synthetic fixture.
            caseNumber:     getField('Case Identifier', 'Case Number', 'caseNumber')
                            || (haveFields ? null : _xmlTag(xmlText, 'caseNumber')),
            examinerName:   getField('Examiner Name', 'examinerName')
                            || (haveFields ? null : _xmlTag(xmlText, 'examinerName')),
            evidenceNumber: getField('Device Name / Evidence Number', 'Evidence Number'),
            extractionDate: getField('Extraction Date', 'Date')
                            || (haveFields ? null : _xmlTag(xmlText, 'extractionDate')),
            toolName:       getField('Tool', 'Tool Name', 'Acquisition Tool')
                            || (haveFields ? null : _xmlTag(xmlText, 'toolName')),
            toolVersion:    getField('Tool Version', 'Version')
                            || (haveFields ? null : _xmlTag(xmlText, 'toolVersion')),
            // New structured fields (preferred by Phase 1.2 device pane).
            deviceInfo: deviceInfoAttrs,
            extractions,
            evidenceId: evidenceColAttrs.EvidenceID || null,
            // Legacy compat — paths to FileSystem NN/*.ufd files.
            fileSystemPaths: fileSystemPaths.length ? fileSystemPaths : _xmlTagAll(xmlText, 'fileSystemPath'),
            // Full caption map for forensic completeness.
            captionMap,
        };
        return { success: true, data, errors: [] };
    } catch (e) {
        return { success: false, data: null, errors: [e.message] };
    }
}

// ─── parseUfd ───────────────────────────────────────────────────────────
// Real Cellebrite .ufd files are INI format, NOT XML. Layout:
//
//   [DeviceInfo]
//   Chipset=GS201
//   Model=Pixel Fold
//   OS=16
//   SecurityPatchLevel=2025-09-05
//   Vendor=Google
//   [Dumps]
//   FileDump=Google_Pixel Fold.zip
//   [General]
//   AcquisitionTool=UFED 4PC
//   ExtractionType=FileSystem
//   ...
//
// We also retain back-compat with the synthetic XML fixture by sniffing
// the leading character.
function parseUfd(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, data: null, errors: ['empty text'] };
    }
    try {
        const trimmed = text.replace(/^\uFEFF/, '').trim();
        // Back-compat: synthetic fixture used XML. Fall through to legacy path.
        if (trimmed.startsWith('<')) {
            return _parseUfdLegacyXml(trimmed);
        }
        // INI parser — section + key=value pairs.
        const sections = {};
        let current = '_root';
        sections[current] = {};
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith(';') || line.startsWith('#')) continue;
            const sec = /^\[([^\]]+)\]\s*$/.exec(line);
            if (sec) {
                current = sec[1].trim();
                if (!sections[current]) sections[current] = {};
                continue;
            }
            const eq = line.indexOf('=');
            if (eq < 1) continue;
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim();
            if (k) sections[current][k] = v;
        }

        const di = sections.DeviceInfo || sections.Deviceinfo || sections.deviceInfo || {};
        const gen = sections.General || sections.general || {};
        const dumps = sections.Dumps || sections.dumps || {};

        const data = {
            // Canonical fields used by buildDeviceOverview.
            make:              di.Vendor || di.Manufacturer || gen.Vendor || null,
            model:             di.Model || gen.Model || null,
            serial:            di.SerialNumber || di.Serial || di.IMEI || null,
            imei:              _splitMaybeList(di.IMEI || di.Imei),
            iccid:             _splitMaybeList(di.ICCID || di.SIMICCID || di.Iccid),
            androidVersion:    di.OS || di.AndroidVersion || di.AndroidOSVersion || null,
            buildFingerprint:  di.Fingerprint || di.BuildFingerprint || null,
            securityPatch:     di.SecurityPatchLevel || di.SecurityPatch || null,
            chipset:           di.Chipset || null,
            extractionType:    gen.ExtractionType || gen.Type || null,
            extractionMethod:  gen.AcquisitionMethod || gen.Method || null,
            extractionDate:    gen.ExtractionStartDateTime || gen.ExtractionEndDateTime || gen.Date || gen.AcquisitionDate || null,
            acquisitionTool:   gen.AcquisitionTool || gen.Tool || null,
            // Inner zip filename (relative to the .ufd's folder).
            fileDump:          dumps.FileDump || dumps.File || dumps.Dump || null,
            zipLogicalPath:    dumps.ZIPLogicalPath || dumps.LogicalPath || null,
            // Full section dump for completeness.
            sections,
        };
        return { success: true, data, errors: [] };
    } catch (e) {
        return { success: false, data: null, errors: [e.message] };
    }
}

// Back-compat for the synthetic fixture's XML .ufd format.
function _parseUfdLegacyXml(xmlText) {
    const data = {
        make:              _xmlTag(xmlText, 'make'),
        model:             _xmlTag(xmlText, 'model'),
        serial:            _xmlTag(xmlText, 'serial'),
        imei:              _xmlTagAll(xmlText, 'imei'),
        iccid:             _xmlTagAll(xmlText, 'iccid'),
        androidVersion:    _xmlTag(xmlText, 'androidVersion'),
        buildFingerprint:  _xmlTag(xmlText, 'buildFingerprint'),
        extractionType:    _xmlTag(xmlText, 'type'),
        extractionMethod:  _xmlTag(xmlText, 'method'),
        extractionDate:    _xmlTag(xmlText, 'date'),
        securityPatch:     null,
        chipset:           null,
        acquisitionTool:   null,
        fileDump:          null,
        zipLogicalPath:    null,
        sections:          {},
    };
    return { success: true, data, errors: [] };
}

function _splitMaybeList(v) {
    if (v === null || v === undefined) return [];
    const s = String(v).trim();
    if (!s) return [];
    // Cellebrite separates dual-SIM IDs with `,` or `;`.
    return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

// ─── parseBuildProp ─────────────────────────────────────────────────────
// Lines look like:   ro.product.model=Pixel 9 Pro Fold
// Comments: '#' at line start. Whitespace-tolerant.
const _BUILD_PROP_KEYS_OF_INTEREST = [
    'ro.product.model',
    'ro.product.brand',
    'ro.product.manufacturer',
    'ro.product.name',
    'ro.product.device',
    'ro.serialno',
    'ro.boot.serialno',
    'ro.build.version.release',
    'ro.build.version.sdk',
    'ro.build.fingerprint',
    'ro.build.display.id',
    'ro.build.id',
    'ro.build.date',
    'ro.build.type',
    'ro.build.tags',
    'ro.crypto.state',          // 'encrypted' | 'unencrypted'
    'ro.crypto.type',           // 'file' | 'block'
];

function parseBuildProp(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, data: null, errors: ['empty text'] };
    }
    try {
        const all = {};
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq < 1) continue;
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim();
            if (k) all[k] = v;
        }
        const interesting = {};
        for (const k of _BUILD_PROP_KEYS_OF_INTEREST) {
            if (k in all) interesting[k] = all[k];
        }
        // FBE detection
        const fbe =
            (all['ro.crypto.state'] === 'encrypted' && all['ro.crypto.type'] === 'file') ? 'native'
            : (all['ro.crypto.state'] === 'unencrypted') ? 'unencrypted'
            : 'unknown';

        return {
            success: true,
            data: {
                keys: interesting,
                fbe,
                totalKeys: Object.keys(all).length,
            },
            errors: [],
        };
    } catch (e) {
        return { success: false, data: null, errors: [e.message] };
    }
}

// ─── parseInstalledAppsList ─────────────────────────────────────────────
// Real Cellebrite InstalledAppsList.txt is ONE package name per line,
// no header, no columns. The synthetic fixture used a pipe-delimited
// columnar format. We auto-detect and handle both.
function parseInstalledAppsList(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, data: [], errors: ['empty text'] };
    }
    try {
        const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (rawLines.length === 0) {
            return { success: true, data: [], errors: ['no rows'] };
        }
        // Detect columnar (pipe-delimited) vs one-per-line.
        // Columnar: at least one line has >=2 pipe-delimited columns AND the
        // header line includes 'package' or '|'-separated header keywords.
        const hasPipes = rawLines.some(l => l.includes('|'));
        const headerLooksLikeColumns = rawLines[0].toLowerCase().includes('package') && hasPipes;

        if (headerLooksLikeColumns) {
            // Columnar format (synthetic fixture path).
            const header = rawLines[0].split('|').map(c => c.trim().toLowerCase());
            const colIdx = {
                pkg:        header.findIndex(c => c.includes('package')),
                name:       header.findIndex(c => c === 'name' || c.includes('label')),
                version:    header.findIndex(c => c.includes('version')),
                installed:  header.findIndex(c => c.includes('install')),
                updated:    header.findIndex(c => c.includes('updat')),
            };
            const apps = [];
            for (let i = 1; i < rawLines.length; i++) {
                const cols = rawLines[i].split('|').map(c => c.trim());
                const get = (idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : '';
                const pkg = get(colIdx.pkg) || get(0);
                if (!pkg) continue;
                apps.push({
                    packageName: pkg,
                    displayName: get(colIdx.name) || get(1) || pkg,
                    version:     get(colIdx.version) || get(2) || '',
                    installedAt: get(colIdx.installed) || get(3) || '',
                    updatedAt:   get(colIdx.updated) || get(4) || '',
                    hasDataOnDisk: false,
                    dataPath: '',
                });
            }
            return { success: true, data: apps, errors: [], format: 'columnar' };
        }

        // Real-world one-package-per-line format.
        const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
        const apps = [];
        const seen = new Set();
        for (const line of rawLines) {
            const pkg = line.split(/\s+/)[0]; // tolerate any trailing whitespace cruft
            if (!pkg || seen.has(pkg)) continue;
            // Skip obvious non-package lines (blanks already filtered).
            if (!PKG_RE.test(pkg)) continue;
            seen.add(pkg);
            apps.push({
                packageName: pkg,
                displayName: pkg, // no display name available in this format
                version:     '',
                installedAt: '',
                updatedAt:   '',
                hasDataOnDisk: false,
                dataPath: '',
            });
        }
        return { success: true, data: apps, errors: [], format: 'one-per-line' };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    }
}

/**
 * Cross-reference parsed apps list against the set of /data/data/* packages
 * we saw in the inner zip's central directory. Marks `hasDataOnDisk = true`
 * and populates `dataPath`. Also returns extra packages we saw on disk that
 * weren't in the apps list (Cellebrite's summary file is sometimes stale).
 *
 *   apps:  Array returned by parseInstalledAppsList(...).data
 *   pkgs:  Array of package names (Strings) — from scanZipTargets().dataDataPackages
 */
function crossCheckAppsWithDataDir(apps, pkgs) {
    const pkgSet = new Set(pkgs || []);
    const knownPkgs = new Set();
    for (const a of apps) {
        if (pkgSet.has(a.packageName)) {
            a.hasDataOnDisk = true;
            a.dataPath = `/data/data/${a.packageName}/`;
        }
        knownPkgs.add(a.packageName);
    }
    const extras = [];
    for (const p of pkgSet) {
        if (knownPkgs.has(p)) continue;
        extras.push({
            packageName: p,
            displayName: p,
            version: '',
            installedAt: '',
            updatedAt: '',
            hasDataOnDisk: true,
            dataPath: `/data/data/${p}/`,
            __extraOnDisk: true,
        });
    }
    return { apps, extras };
}

// ─── parseContactsDb ────────────────────────────────────────────────────
// AOSP contacts2.db schema (modern Android):
//   raw_contacts: _id, display_name, account_type, account_name, starred,
//                 last_time_contacted, contact_id
//   data:         _id, raw_contact_id, mimetype_id, data1, data2, data3, ...
//   mimetypes:    _id, mimetype
//
// We pull every raw_contact and gather its phone/email/name rows by joining
// through mimetypes. Output is grouped per raw contact.
function parseContactsDb(sqlitePath) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) {
        return { success: false, data: [], errors: ['db path missing'] };
    }
    // Encrypted-DB guard: SQLite magic header.
    try {
        const fd = fs.openSync(sqlitePath, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (!isSqlite(head)) {
            return { success: false, data: [], errors: ['db is encrypted or corrupt (no SQLite magic)'], skipped: [{ path: sqlitePath, reason: 'encrypted-or-corrupt' }] };
        }
    } catch (e) {
        return { success: false, data: [], errors: ['cannot read db: ' + e.message] };
    }

    let db = null;
    try {
        const Sqlite = _sqlite();
        db = new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });

        // Verify required tables exist (graceful degradation for schema variance).
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
        const need = ['raw_contacts', 'data', 'mimetypes'];
        const missing = need.filter(t => !tables.includes(t));
        if (missing.length) {
            return { success: false, data: [], errors: ['missing tables: ' + missing.join(', ')] };
        }

        // Build mimetype map
        const mimeRows = db.prepare(`SELECT _id, mimetype FROM mimetypes`).all();
        const mimeById = new Map(mimeRows.map(r => [r._id, r.mimetype]));

        // Detect optional columns we'd like (some old schemas lack starred etc.)
        const rcCols = new Set(
            db.prepare(`PRAGMA table_info(raw_contacts)`).all().map(r => r.name)
        );
        const hasStarred = rcCols.has('starred');
        const hasLastTime = rcCols.has('last_time_contacted');
        const hasDisplayName = rcCols.has('display_name');
        const hasAccountType = rcCols.has('account_type');
        const hasAccountName = rcCols.has('account_name');

        const rcSelectCols = [
            '_id',
            hasDisplayName ? 'display_name' : `NULL as display_name`,
            hasAccountType ? 'account_type' : `NULL as account_type`,
            hasAccountName ? 'account_name' : `NULL as account_name`,
            hasStarred     ? 'starred'      : `NULL as starred`,
            hasLastTime    ? 'last_time_contacted' : `NULL as last_time_contacted`,
        ].join(', ');

        const rawContacts = db.prepare(`SELECT ${rcSelectCols} FROM raw_contacts`).all();
        const dataRows = db.prepare(`SELECT _id, raw_contact_id, mimetype_id, data1, data2, data3 FROM data`).all();

        // Group data rows by raw_contact_id
        const rowsByContact = new Map();
        for (const d of dataRows) {
            let arr = rowsByContact.get(d.raw_contact_id);
            if (!arr) { arr = []; rowsByContact.set(d.raw_contact_id, arr); }
            arr.push(d);
        }

        const out = [];
        for (const rc of rawContacts) {
            const drows = rowsByContact.get(rc._id) || [];
            const phones = [];
            const emails = [];
            let primaryName = rc.display_name || '';
            for (const d of drows) {
                const mime = mimeById.get(d.mimetype_id) || '';
                if (mime === 'vnd.android.cursor.item/phone_v2') {
                    if (d.data1) phones.push({ number: String(d.data1).trim(), type: _phoneTypeLabel(d.data2) });
                } else if (mime === 'vnd.android.cursor.item/email_v2') {
                    if (d.data1) emails.push({ address: String(d.data1).trim(), type: _emailTypeLabel(d.data2) });
                } else if (mime === 'vnd.android.cursor.item/name') {
                    if (!primaryName && d.data1) primaryName = String(d.data1).trim();
                }
            }
            if (!primaryName && phones.length === 0 && emails.length === 0) continue;
            out.push({
                id: String(rc._id),
                displayName: primaryName || '(no name)',
                phones,
                emails,
                accountType: rc.account_type || '',
                accountName: rc.account_name || '',
                starred: !!rc.starred,
                lastContacted: rc.last_time_contacted ? Number(rc.last_time_contacted) : null,
            });
        }

        // Sort by displayName, blank names last.
        out.sort((a, b) => {
            const an = (a.displayName || '').toLowerCase();
            const bn = (b.displayName || '').toLowerCase();
            const aBlank = !an || an === '(no name)';
            const bBlank = !bn || bn === '(no name)';
            if (aBlank && !bBlank) return 1;
            if (bBlank && !aBlank) return -1;
            return an.localeCompare(bn);
        });

        return { success: true, data: out, errors: [] };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    } finally {
        if (db) { try { db.close(); } catch (_) {} }
    }
}

// AOSP ContactsContract phone type constants (data2 in phone_v2 rows)
function _phoneTypeLabel(t) {
    const n = Number(t);
    switch (n) {
        case 1: return 'Home';
        case 2: return 'Mobile';
        case 3: return 'Work';
        case 4: return 'Fax (Work)';
        case 5: return 'Fax (Home)';
        case 6: return 'Pager';
        case 7: return 'Other';
        case 0: return 'Custom';
        default: return '';
    }
}
function _emailTypeLabel(t) {
    const n = Number(t);
    switch (n) {
        case 1: return 'Home';
        case 2: return 'Work';
        case 3: return 'Other';
        case 4: return 'Mobile';
        case 0: return 'Custom';
        default: return '';
    }
}

// ─── 1.3 surfaces ───────────────────────────────────────────────────────

// AOSP call-log type codes (CallLog.Calls.TYPE)
const _CALL_TYPE = {
    1: 'incoming',
    2: 'outgoing',
    3: 'missed',
    4: 'voicemail',
    5: 'rejected',
    6: 'blocked',
    7: 'external',
};
function _callTypeLabel(t) { return _CALL_TYPE[Number(t)] || ''; }

// AOSP SMS direction codes (Telephony.Sms.MESSAGE_TYPE_*)
const _SMS_TYPE = {
    1: 'inbox',
    2: 'sent',
    3: 'draft',
    4: 'outbox',
    5: 'failed',
    6: 'queued',
};
function _smsTypeLabel(t) {
    const n = Number(t);
    return _SMS_TYPE[n] || (n ? `type-${n}` : '');
}
function _smsDirection(t) {
    const n = Number(t);
    if (n === 1) return 'in';
    if (n === 2 || n === 4 || n === 5 || n === 6) return 'out';
    return 'other';
}

// MMS PduHeaders.MESSAGE_TYPE_*: 128=send-req, 130=notification-ind, 132=retrieve-conf, 133=ack, 135=delivery-ind, 136=read-ind
function _mmsDirectionFromMtype(mt) {
    const n = Number(mt);
    if (n === 128) return 'out';      // M_SEND_REQ
    if (n === 132) return 'in';       // M_RETRIEVE_CONF
    if (n === 130) return 'in';       // M_NOTIFICATION_IND
    if (n === 135) return 'in';       // M_DELIVERY_IND
    return 'other';
}
// MMS addr.type:  130 = "from", 137 = "to", 151 = "cc", 152 = "bcc"
function _mmsAddrTypeLabel(t) {
    const n = Number(t);
    if (n === 130) return 'from';
    if (n === 137) return 'to';
    if (n === 151) return 'cc';
    if (n === 152) return 'bcc';
    return '';
}

// ─── parseCallLogDb ─────────────────────────────────────────────────────
// On modern AOSP the call log lives in contacts2.db (`calls` table) — Cellebrite
// also extracts `calllog.db` on some vendor builds, so we accept either path
// from the caller. Schema variance is handled via PRAGMA detection.
function parseCallLogDb(sqlitePath) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) {
        return { success: false, data: [], errors: ['db path missing'] };
    }
    try {
        const fd = fs.openSync(sqlitePath, 'r');
        const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
        if (!isSqlite(head)) {
            return { success: false, data: [], errors: ['db is encrypted or corrupt (no SQLite magic)'], skipped: [{ path: sqlitePath, reason: 'encrypted-or-corrupt' }] };
        }
    } catch (e) {
        return { success: false, data: [], errors: ['cannot read db: ' + e.message] };
    }

    let db = null;
    try {
        const Sqlite = _sqlite();
        db = new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
        if (!tables.includes('calls')) {
            return { success: true, data: [], errors: ['no calls table in this db'] };
        }
        const cols = new Set(db.prepare(`PRAGMA table_info(calls)`).all().map(r => r.name));
        const pick = (name, fallback = `NULL as ${name}`) => cols.has(name) ? name : fallback;
        const select = [
            '_id',
            pick('number'),
            pick('date'),
            pick('duration'),
            pick('type'),
            pick('name'),
            pick('phone_account_id'),
            pick('subscription_id'),
            pick('countryiso'),
            pick('geocoded_location'),
            pick('via_number'),
            pick('is_read'),
            pick('new'),
        ].join(', ');
        const rows = db.prepare(`SELECT ${select} FROM calls ORDER BY date DESC`).all();
        const out = rows.map(r => ({
            id: String(r._id),
            number: r.number ? String(r.number).trim() : '',
            contactName: r.name ? String(r.name) : '',
            direction: (Number(r.type) === 2 ? 'out' : Number(r.type) === 1 ? 'in' : 'other'),
            type: _callTypeLabel(r.type),
            typeCode: r.type != null ? Number(r.type) : null,
            timestamp: r.date != null ? Number(r.date) : null,         // ms epoch
            duration: r.duration != null ? Number(r.duration) : 0,     // seconds
            simSlot: r.phone_account_id || (r.subscription_id != null ? `sub-${r.subscription_id}` : ''),
            country: r.countryiso || '',
            location: r.geocoded_location || '',
            viaNumber: r.via_number || '',
            isRead: r.is_read != null ? !!r.is_read : null,
            isNew: r.new != null ? !!r.new : null,
        }));
        return { success: true, data: out, errors: [] };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    } finally {
        if (db) { try { db.close(); } catch (_) {} }
    }
}

// ─── parseMmsSmsDb ──────────────────────────────────────────────────────
// AOSP Telephony provider: `mmssms.db`
//   sms:    _id, thread_id, address, date, date_sent, type (1=in,2=out,...),
//           read, seen, subject, body, status, protocol, service_center
//   pdu:    _id, thread_id, date (sec), m_type, sub (subject), ct_t, msg_box
//   part:   _id, mid (→ pdu._id), ct, name, _data, text
//   addr:   _id, msg_id (→ pdu._id), address, type (130=from, 137=to, ...)
//   threads:_id, date, message_count, snippet, recipient_ids, read
//
// Output rows are SMS + MMS unified. attachments[] for MMS parts; body for SMS
// (or concatenated MMS text parts when present).
function parseMmsSmsDb(sqlitePath) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) {
        return { success: false, data: [], errors: ['db path missing'] };
    }
    try {
        const fd = fs.openSync(sqlitePath, 'r');
        const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
        if (!isSqlite(head)) {
            return { success: false, data: [], errors: ['db is encrypted or corrupt (no SQLite magic)'], skipped: [{ path: sqlitePath, reason: 'encrypted-or-corrupt' }] };
        }
    } catch (e) {
        return { success: false, data: [], errors: ['cannot read db: ' + e.message] };
    }

    let db = null;
    try {
        const Sqlite = _sqlite();
        db = new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });

        const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
        const errors = [];
        const messages = [];

        // ── SMS ──────────────────────────────────────────────────────────
        if (tables.has('sms')) {
            const cols = new Set(db.prepare(`PRAGMA table_info(sms)`).all().map(r => r.name));
            const pick = (name) => cols.has(name) ? name : `NULL as ${name}`;
            const select = [
                '_id',
                pick('thread_id'),
                pick('address'),
                pick('date'),
                pick('date_sent'),
                pick('type'),
                pick('read'),
                pick('seen'),
                pick('subject'),
                pick('body'),
                pick('status'),
                pick('service_center'),
            ].join(', ');
            const rows = db.prepare(`SELECT ${select} FROM sms ORDER BY date DESC`).all();
            for (const r of rows) {
                messages.push({
                    id: 'sms-' + r._id,
                    kind: 'sms',
                    threadId: r.thread_id != null ? Number(r.thread_id) : null,
                    address: r.address ? String(r.address).trim() : '',
                    addresses: r.address ? [String(r.address).trim()] : [],
                    direction: _smsDirection(r.type),
                    typeCode: r.type != null ? Number(r.type) : null,
                    typeLabel: _smsTypeLabel(r.type),
                    timestamp: r.date != null ? Number(r.date) : null,            // ms
                    timestampSent: r.date_sent != null ? Number(r.date_sent) : null,
                    body: r.body == null ? '' : String(r.body),
                    subject: r.subject == null ? '' : String(r.subject),
                    read: r.read != null ? !!r.read : null,
                    seen: r.seen != null ? !!r.seen : null,
                    attachments: [],
                    serviceCenter: r.service_center || '',
                });
            }
        } else {
            errors.push('no sms table');
        }

        // ── MMS (pdu + part + addr) ──────────────────────────────────────
        if (tables.has('pdu')) {
            const pCols = new Set(db.prepare(`PRAGMA table_info(pdu)`).all().map(r => r.name));
            const pick = (name) => pCols.has(name) ? name : `NULL as ${name}`;
            const pduSelect = [
                '_id',
                pick('thread_id'),
                pick('date'),       // seconds since epoch in MMS spec
                pick('date_sent'),
                pick('m_type'),
                pick('msg_box'),
                pick('sub'),        // subject
                pick('ct_t'),
                pick('read'),
                pick('seen'),
            ].join(', ');
            const pduRows = db.prepare(`SELECT ${pduSelect} FROM pdu ORDER BY date DESC`).all();

            // Build parts index by msg_id (PRAGMA-driven — schemas vary across Android versions)
            const partsByMsg = new Map();
            if (tables.has('part')) {
                const partCols = new Set(db.prepare(`PRAGMA table_info(part)`).all().map(r => r.name));
                const ppick = (name) => partCols.has(name) ? name : `NULL as ${name}`;
                const partSelect = [
                    '_id',
                    ppick('mid'),
                    ppick('ct'),
                    ppick('name'),
                    ppick('_data'),
                    ppick('text'),
                ].join(', ');
                const partRows = db.prepare(`SELECT ${partSelect} FROM part`).all();
                for (const pr of partRows) {
                    if (pr.mid == null) continue;
                    if (!partsByMsg.has(pr.mid)) partsByMsg.set(pr.mid, []);
                    partsByMsg.get(pr.mid).push(pr);
                }
            }

            // Build addr index by msg_id (PRAGMA-driven)
            const addrByMsg = new Map();
            if (tables.has('addr')) {
                const addrCols = new Set(db.prepare(`PRAGMA table_info(addr)`).all().map(r => r.name));
                const apick = (name) => addrCols.has(name) ? name : `NULL as ${name}`;
                const addrSelect = [
                    '_id',
                    apick('msg_id'),
                    apick('address'),
                    apick('type'),
                ].join(', ');
                const addrRows = db.prepare(`SELECT ${addrSelect} FROM addr`).all();
                for (const ar of addrRows) {
                    if (ar.msg_id == null) continue;
                    if (!addrByMsg.has(ar.msg_id)) addrByMsg.set(ar.msg_id, []);
                    addrByMsg.get(ar.msg_id).push(ar);
                }
            }

            for (const r of pduRows) {
                const addrs = addrByMsg.get(r._id) || [];
                let from = '';
                const tos  = [];
                for (const a of addrs) {
                    const v = a.address == null ? '' : String(a.address).trim();
                    if (!v || v === 'insert-address-token') continue;
                    if (Number(a.type) === 130) from = from || v;
                    else if (Number(a.type) === 137) tos.push(v);
                    else tos.push(v);
                }
                const parts = partsByMsg.get(r._id) || [];
                const textParts = [];
                const attachments = [];
                for (const p of parts) {
                    const ct = p.ct ? String(p.ct).toLowerCase() : '';
                    if (ct.startsWith('text/')) {
                        if (p.text) textParts.push(String(p.text));
                    } else if (ct && ct !== 'application/smil') {
                        attachments.push({
                            id: String(p._id),
                            contentType: p.ct || '',
                            name: p.name || '',
                            dataPath: p._data || '',
                        });
                    }
                }
                // date in pdu is SECONDS; convert to ms for unified surface
                const ts = r.date != null ? Number(r.date) * 1000 : null;
                const mtype = Number(r.m_type);
                const direction = mtype === 128 ? 'out' : (mtype === 132 || mtype === 130 ? 'in' : 'other');
                messages.push({
                    id: 'mms-' + r._id,
                    kind: 'mms',
                    threadId: r.thread_id != null ? Number(r.thread_id) : null,
                    address: from || (tos[0] || ''),
                    addresses: from ? [from, ...tos] : tos,
                    fromAddress: from,
                    toAddresses: tos,
                    direction,
                    typeCode: mtype || null,
                    typeLabel: _mmsAddrTypeLabel(mtype) || (`mms-mtype-${mtype}`),
                    timestamp: ts,
                    timestampSent: r.date_sent != null ? Number(r.date_sent) * 1000 : null,
                    body: textParts.join('\n'),
                    subject: r.sub == null ? '' : String(r.sub),
                    read: r.read != null ? !!r.read : null,
                    seen: r.seen != null ? !!r.seen : null,
                    attachments,
                });
            }
        }

        // Order by timestamp DESC (newest first)
        messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // Thread aggregation: count per threadId, snippet = first message body
        const threads = new Map();
        for (const m of messages) {
            const tid = m.threadId == null ? `_${m.address || 'unknown'}` : `t-${m.threadId}`;
            let th = threads.get(tid);
            if (!th) {
                th = {
                    id: tid,
                    threadId: m.threadId,
                    address: m.address || '',
                    addresses: new Set(),
                    messageCount: 0,
                    latestTimestamp: null,
                    latestSnippet: '',
                    hasAttachments: false,
                };
                threads.set(tid, th);
            }
            th.messageCount++;
            for (const a of (m.addresses || [])) if (a) th.addresses.add(a);
            if (th.latestTimestamp == null || (m.timestamp || 0) > th.latestTimestamp) {
                th.latestTimestamp = m.timestamp || 0;
                th.latestSnippet = (m.body || m.subject || '').slice(0, 120);
            }
            if (m.attachments && m.attachments.length) th.hasAttachments = true;
        }
        const threadsArr = [...threads.values()].map(t => ({
            ...t,
            addresses: [...t.addresses],
        })).sort((a, b) => (b.latestTimestamp || 0) - (a.latestTimestamp || 0));

        return { success: true, data: messages, threads: threadsArr, errors };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    } finally {
        if (db) { try { db.close(); } catch (_) {} }
    }
}

// ─── parseBugleDb ───────────────────────────────────────────────────────
// Google Messages: `bugle_db` (com.google.android.apps.messaging).
// Holds SMS, MMS, AND RCS. Stock on every modern Pixel; ships as default
// messaging app on most Samsung / OnePlus / Motorola devices too.
//
// Bugle schema (verified against Google Messages 2024–2025 builds):
//   conversations:  _id, name, latest_message_id, latest_timestamp,
//                   conversation_origin, recipient_count, latest_message_status,
//                   sms_thread_id, snippet_text
//   messages:       _id, conversation_id, sent_timestamp, received_timestamp,
//                   message_status, message_protocol, sms_message_uri,
//                   sender_id (→ participants._id), seen, read
//   parts:          _id, message_id, text, content_type, uri, content_uri,
//                   file_name, width, height
//   participants:   _id, normalized_destination, display_destination,
//                   full_name, first_name, profile_photo_uri, sub_id
//   conversation_participants_view (optional): conversation_id, participant_id
//
// message_protocol values (Bugle):
//   0 = SMS, 1 = MMS, 2 = XMS, 3 = RCS, 4 = RCS Group
//
// message_status (lower 7 bits encode the state; we collapse to bands):
//   < 100  → outgoing  (1/2/4/8 = yet-to-send / sending / sent / delivered, etc.)
//   100+   → incoming  (100 = INCOMING_COMPLETE, 101/102 = manual download, etc.)
//
// Output: unified shape with parseMmsSmsDb so the UI surface is identical.
function parseBugleDb(sqlitePath) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) {
        return { success: false, data: [], threads: [], errors: ['db path missing'] };
    }
    try {
        const fd = fs.openSync(sqlitePath, 'r');
        const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
        if (!isSqlite(head)) {
            return { success: false, data: [], threads: [], errors: ['db is encrypted or corrupt (no SQLite magic)'], skipped: [{ path: sqlitePath, reason: 'encrypted-or-corrupt' }] };
        }
    } catch (e) {
        return { success: false, data: [], threads: [], errors: ['cannot read db: ' + e.message] };
    }

    let db = null;
    try {
        const Sqlite = _sqlite();
        db = new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });

        const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' OR type='view'`).all().map(r => r.name));
        const errors = [];

        if (!tables.has('messages') || !tables.has('participants')) {
            return { success: true, data: [], threads: [], errors: ['bugle_db missing messages/participants tables — schema not recognized'] };
        }

        // ── participants ────────────────────────────────────────────────
        const pCols = new Set(db.prepare(`PRAGMA table_info(participants)`).all().map(r => r.name));
        const ppick = (n) => pCols.has(n) ? n : `NULL as ${n}`;
        const partRows = db.prepare(`SELECT ${[
            '_id',
            ppick('normalized_destination'),
            ppick('display_destination'),
            ppick('full_name'),
            ppick('first_name'),
            ppick('sub_id'),
        ].join(', ')} FROM participants`).all();
        const participantById = new Map();
        for (const r of partRows) {
            participantById.set(r._id, {
                id: r._id,
                normalized: r.normalized_destination || '',
                display: r.display_destination || '',
                fullName: r.full_name || '',
                firstName: r.first_name || '',
                subId: r.sub_id != null ? Number(r.sub_id) : null,
            });
        }

        // ── conversation → participants mapping ─────────────────────────
        // Prefer the view, fall back to the underlying join table if present.
        const convParticipantsByConv = new Map();
        const partsTable = tables.has('conversation_participants_view') ? 'conversation_participants_view'
                        : tables.has('conversation_participants')        ? 'conversation_participants'
                        : null;
        if (partsTable) {
            try {
                const cpCols = new Set(db.prepare(`PRAGMA table_info(${partsTable})`).all().map(r => r.name));
                const convCol = cpCols.has('conversation_id') ? 'conversation_id' : (cpCols.has('_id') ? '_id' : null);
                const partCol = cpCols.has('participant_id') ? 'participant_id' : null;
                if (convCol && partCol) {
                    const rows = db.prepare(`SELECT ${convCol} as cid, ${partCol} as pid FROM ${partsTable}`).all();
                    for (const r of rows) {
                        if (r.cid == null || r.pid == null) continue;
                        if (!convParticipantsByConv.has(r.cid)) convParticipantsByConv.set(r.cid, []);
                        convParticipantsByConv.get(r.cid).push(r.pid);
                    }
                }
            } catch (_) { /* schema drift — skip */ }
        }

        // ── conversations ───────────────────────────────────────────────
        const convById = new Map();
        if (tables.has('conversations')) {
            const cCols = new Set(db.prepare(`PRAGMA table_info(conversations)`).all().map(r => r.name));
            const cpick = (n) => cCols.has(n) ? n : `NULL as ${n}`;
            const convRows = db.prepare(`SELECT ${[
                '_id',
                cpick('name'),
                cpick('latest_message_timestamp'),
                cpick('latest_message_status'),
                cpick('conversation_origin'),
                cpick('recipient_count'),
                cpick('snippet_text'),
                cpick('sms_thread_id'),
            ].join(', ')} FROM conversations`).all();
            for (const c of convRows) {
                convById.set(c._id, {
                    id: c._id,
                    name: c.name || '',
                    latestTimestamp: c.latest_message_timestamp != null ? Number(c.latest_message_timestamp) : null,
                    latestStatus: c.latest_message_status != null ? Number(c.latest_message_status) : null,
                    origin: c.conversation_origin != null ? Number(c.conversation_origin) : null,
                    recipientCount: c.recipient_count != null ? Number(c.recipient_count) : null,
                    snippet: c.snippet_text || '',
                    smsThreadId: c.sms_thread_id != null ? Number(c.sms_thread_id) : null,
                });
            }
        }

        // ── parts (attachments + text) ──────────────────────────────────
        const partsByMsg = new Map();
        if (tables.has('parts')) {
            const prtCols = new Set(db.prepare(`PRAGMA table_info(parts)`).all().map(r => r.name));
            const prtpick = (n) => prtCols.has(n) ? n : `NULL as ${n}`;
            const partRows2 = db.prepare(`SELECT ${[
                '_id',
                prtpick('message_id'),
                prtpick('text'),
                prtpick('content_type'),
                prtpick('uri'),
                prtpick('content_uri'),
                prtpick('file_name'),
                prtpick('width'),
                prtpick('height'),
            ].join(', ')} FROM parts`).all();
            for (const p of partRows2) {
                if (p.message_id == null) continue;
                if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
                partsByMsg.get(p.message_id).push(p);
            }
        }

        // ── messages ────────────────────────────────────────────────────
        const mCols = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map(r => r.name));
        const mpick = (n) => mCols.has(n) ? n : `NULL as ${n}`;
        const msgRows = db.prepare(`SELECT ${[
            '_id',
            mpick('conversation_id'),
            mpick('sent_timestamp'),
            mpick('received_timestamp'),
            mpick('message_status'),
            mpick('message_protocol'),
            mpick('sms_message_uri'),
            mpick('sender_id'),
            mpick('seen'),
            mpick('read'),
        ].join(', ')} FROM messages ORDER BY received_timestamp DESC`).all();

        const messages = [];
        for (const r of msgRows) {
            const protocol = r.message_protocol != null ? Number(r.message_protocol) : 0;
            const status = r.message_status != null ? Number(r.message_status) : null;
            const direction = _bugleDirection(status);
            const kind = _bugleKindFromProtocol(protocol);

            // Resolve sender display (incoming uses sender_id; outgoing typically self/empty).
            let senderAddress = '';
            let senderName = '';
            const sender = r.sender_id != null ? participantById.get(r.sender_id) : null;
            if (sender) {
                senderAddress = sender.normalized || sender.display || '';
                senderName = sender.fullName || sender.firstName || '';
            }

            // Conversation participants → addresses[]
            const convId = r.conversation_id;
            const convPids = convParticipantsByConv.get(convId) || [];
            const convAddrs = [];
            const convNames = [];
            for (const pid of convPids) {
                const p = participantById.get(pid);
                if (!p) continue;
                const v = p.normalized || p.display || '';
                if (v) convAddrs.push(v);
                const n = p.fullName || p.firstName || '';
                if (n) convNames.push(n);
            }
            // Strip "self" placeholder addresses ("ʼselfʼ" / empty / "+0")
            const isSelfPlaceholder = (s) => !s || s === '+0' || /^self$/i.test(s);
            const otherAddrs = convAddrs.filter(a => !isSelfPlaceholder(a));

            const parts = partsByMsg.get(r._id) || [];
            const textParts = [];
            const attachments = [];
            for (const p of parts) {
                const ct = p.content_type ? String(p.content_type).toLowerCase() : '';
                if (!ct || ct.startsWith('text/')) {
                    if (p.text) textParts.push(String(p.text));
                } else if (ct !== 'application/smil') {
                    attachments.push({
                        id: String(p._id),
                        contentType: p.content_type || '',
                        name: p.file_name || '',
                        dataPath: p.uri || p.content_uri || '',
                        width: p.width != null ? Number(p.width) : null,
                        height: p.height != null ? Number(p.height) : null,
                    });
                }
            }

            // Timestamp preference: received for incoming, sent for outgoing.
            const ts = direction === 'in'
                ? (r.received_timestamp != null ? Number(r.received_timestamp) : (r.sent_timestamp != null ? Number(r.sent_timestamp) : null))
                : (r.sent_timestamp != null ? Number(r.sent_timestamp) : (r.received_timestamp != null ? Number(r.received_timestamp) : null));

            const body = textParts.join('\n');
            const conv = convById.get(convId);
            const primaryAddress = direction === 'in'
                ? (senderAddress || otherAddrs[0] || '')
                : (otherAddrs[0] || '');

            messages.push({
                id: `${kind}-bg-${r._id}`,
                kind,                                  // 'sms' | 'mms' | 'rcs'
                protocol,                              // 0/1/2/3/4 raw
                protocolLabel: _bugleProtocolLabel(protocol),
                source: 'bugle_db',
                threadId: convId != null ? Number(convId) : null,
                threadName: conv && conv.name ? conv.name : '',
                address: primaryAddress,
                addresses: direction === 'in'
                    ? [senderAddress, ...otherAddrs.filter(a => a !== senderAddress)].filter(Boolean)
                    : otherAddrs,
                fromAddress: direction === 'in' ? senderAddress : '',
                toAddresses: direction === 'in' ? [] : otherAddrs,
                senderName,
                direction,
                typeCode: status,
                typeLabel: _bugleStatusLabel(status),
                timestamp: ts,
                timestampSent: r.sent_timestamp != null ? Number(r.sent_timestamp) : null,
                timestampReceived: r.received_timestamp != null ? Number(r.received_timestamp) : null,
                body,
                subject: '',
                read: r.read != null ? !!r.read : null,
                seen: r.seen != null ? !!r.seen : null,
                attachments,
            });
        }

        // Newest first
        messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // ── thread aggregation ──────────────────────────────────────────
        const threads = new Map();
        for (const m of messages) {
            const tid = m.threadId == null ? `_${m.address || 'unknown'}` : `t-${m.threadId}`;
            let th = threads.get(tid);
            if (!th) {
                const conv = m.threadId != null ? convById.get(m.threadId) : null;
                th = {
                    id: tid,
                    threadId: m.threadId,
                    address: m.address || '',
                    addresses: new Set(),
                    name: conv && conv.name ? conv.name : (m.threadName || ''),
                    messageCount: 0,
                    latestTimestamp: null,
                    latestSnippet: '',
                    hasAttachments: false,
                    protocols: new Set(),
                };
                threads.set(tid, th);
            }
            th.messageCount++;
            for (const a of (m.addresses || [])) if (a) th.addresses.add(a);
            if (th.latestTimestamp == null || (m.timestamp || 0) > th.latestTimestamp) {
                th.latestTimestamp = m.timestamp || 0;
                th.latestSnippet = (m.body || '').slice(0, 120);
            }
            if (m.attachments && m.attachments.length) th.hasAttachments = true;
            if (m.protocolLabel) th.protocols.add(m.protocolLabel);
        }
        const threadsArr = [...threads.values()].map(t => ({
            ...t,
            addresses: [...t.addresses],
            protocols: [...t.protocols],
        })).sort((a, b) => (b.latestTimestamp || 0) - (a.latestTimestamp || 0));

        return { success: true, data: messages, threads: threadsArr, errors };
    } catch (e) {
        return { success: false, data: [], threads: [], errors: [e.message] };
    } finally {
        if (db) { try { db.close(); } catch (_) {} }
    }
}

// Bugle message_protocol → label
function _bugleProtocolLabel(p) {
    const n = Number(p);
    if (n === 0) return 'sms';
    if (n === 1) return 'mms';
    if (n === 2) return 'xms';
    if (n === 3) return 'rcs';
    if (n === 4) return 'rcs-group';
    return n ? `proto-${n}` : 'sms';
}
function _bugleKindFromProtocol(p) {
    const n = Number(p);
    if (n === 1) return 'mms';
    if (n === 3 || n === 4) return 'rcs';
    return 'sms';
}
// Bugle message_status (heuristic band):
//   1=OUTGOING_YET_TO_SEND, 2=OUTGOING_SENDING, 4=OUTGOING_SENT,
//   8=OUTGOING_DELIVERED, 16=OUTGOING_DISPLAYED (read), 64=OUTGOING_FAILED,
//   100=INCOMING_COMPLETE, 101=INCOMING_AUTO_DOWNLOADING,
//   102=INCOMING_MANUAL_DOWNLOADING, 103=INCOMING_RETRYING_AUTO_DOWNLOAD,
//   104=INCOMING_RETRYING_MANUAL_DOWNLOAD, 106=INCOMING_DOWNLOAD_FAILED,
//   200=TOMBSTONE_PARTICIPANT_JOINED, etc.
const _BUGLE_STATUS = {
    1: 'queued', 2: 'sending', 4: 'sent', 8: 'delivered', 16: 'read-by-recipient',
    32: 'sent-by-system', 64: 'failed', 65: 'failed-emergency',
    100: 'inbox', 101: 'auto-downloading', 102: 'manual-downloading',
    103: 'retry-auto', 104: 'retry-manual', 106: 'download-failed',
    200: 'tombstone',
};
function _bugleStatusLabel(s) {
    const n = Number(s);
    if (_BUGLE_STATUS[n]) return _BUGLE_STATUS[n];
    if (n >= 200) return 'tombstone';
    if (n >= 100) return 'inbox';
    if (n > 0) return `out-${n}`;
    return '';
}
function _bugleDirection(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return 'other';
    if (n >= 200) return 'other';            // tombstones / system events
    if (n >= 100) return 'in';
    if (n > 0) return 'out';
    return 'other';
}

// ─── parseAccountsDb ────────────────────────────────────────────────────
// AOSP AccountManager DB. Schema can be `accounts` (modern) or `Accounts`
// (some older). Columns: name, type, password (often NULL on FBE-locked),
// previous_name. We surface presence-of-password as boolean only — we
// NEVER read or return the credential.
function parseAccountsDb(sqlitePath) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) {
        return { success: false, data: [], errors: ['db path missing'] };
    }
    try {
        const fd = fs.openSync(sqlitePath, 'r');
        const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
        if (!isSqlite(head)) {
            return { success: false, data: [], errors: ['db is encrypted or corrupt (no SQLite magic)'], skipped: [{ path: sqlitePath, reason: 'encrypted-or-corrupt' }] };
        }
    } catch (e) {
        return { success: false, data: [], errors: ['cannot read db: ' + e.message] };
    }
    let db = null;
    try {
        const Sqlite = _sqlite();
        db = new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
        const tableName = tables.includes('accounts') ? 'accounts'
                        : tables.includes('Accounts') ? 'Accounts'
                        : null;
        if (!tableName) {
            return { success: true, data: [], errors: ['no accounts/Accounts table'] };
        }
        const cols = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name));
        const pick = (n) => cols.has(n) ? n : `NULL as ${n}`;
        const select = [
            '_id',
            pick('name'),
            pick('type'),
            pick('password'),
            pick('previous_name'),
        ].join(', ');
        const rows = db.prepare(`SELECT ${select} FROM ${tableName}`).all();
        const out = rows.map(r => ({
            id: String(r._id),
            name: r.name == null ? '' : String(r.name),
            type: r.type == null ? '' : String(r.type),
            previousName: r.previous_name == null ? '' : String(r.previous_name),
            hasPassword: !!(r.password && String(r.password).length > 0),
        }));
        out.sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.name || '').localeCompare(b.name || ''));
        return { success: true, data: out, errors: [] };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    } finally {
        if (db) { try { db.close(); } catch (_) {} }
    }
}

// ─── parseWifiConfigStore ───────────────────────────────────────────────
// XML config store (modern Android).
//
// Android 16 format (Pixel Fold real fixture):
//   <Network>
//     <WifiConfiguration>
//       <string name="ConfigKey">&quot;SSID&quot;WPA_PSK</string>
//       <string name="SSID">&quot;SSID&quot;</string>
//       <null name="PreSharedKey" />          (or <string> on older devices)
//       <boolean name="HiddenSSID" value="false" />
//       <byte-array name="AllowedKeyMgmt" num="1">02</byte-array>
//       <SecurityParamsList>
//         <SecurityParams>
//           <int name="SecurityType" value="2" />   ← canonical
//           <boolean name="IsEnabled" value="true" />
//         </SecurityParams>
//         ...
//       </SecurityParamsList>
//     </WifiConfiguration>
//   </Network>
//
// Older Android (legacy AOSP) used a single `<string name="KeyMgmt">...</string>`.
// We accept all three and prefer SecurityType (most specific) when present.
//
// Passwords are present in `<string name="PreSharedKey">` on older Android;
// post-11 the key is in the encrypted checkpoint and we surface it as `<null .../>`
// here — so `preSharedKeyPresent` is true only when a <string name="PreSharedKey">
// node exists (NOT for <null .../>).
const _WIFI_SECURITY_TYPE = {
    0:  'NONE',
    1:  'WEP',
    2:  'WPA_PSK',
    3:  'WPA_EAP',
    4:  'SAE',                     // WPA3-Personal
    5:  'EAP_SUITE_B_192',
    6:  'OWE',                     // Enhanced Open
    7:  'WAPI_PSK',
    8:  'WAPI_CERT',
    9:  'EAP_WPA3_ENTERPRISE',
    10: 'OSEN',
    11: 'PASSPOINT_R1_R2',
    12: 'PASSPOINT_R3',
    13: 'DPP',
};
// AOSP `AllowedKeyMgmt` BitSet → security label (when SecurityParamsList absent)
const _WIFI_KEYMGMT_BIT = {
    0x01: 'NONE',
    0x02: 'WPA_PSK',
    0x04: 'WPA_EAP',
    0x08: 'IEEE8021X',
    0x10: 'WPA2_PSK',
    0x20: 'OSEN',
    0x40: 'FT_PSK',
    0x80: 'FT_EAP',
};
function _wifiSecurityFromBytesHex(hex) {
    if (!hex) return null;
    const clean = String(hex).replace(/\s+/g, '');
    let firstByte;
    try { firstByte = parseInt(clean.slice(0, 2), 16); }
    catch (e) { return null; }
    if (!Number.isFinite(firstByte) || firstByte === 0) return 'NONE';
    // Find the most specific (highest single bit) — practically a network has 1 bit set.
    const labels = [];
    for (const [bitStr, label] of Object.entries(_WIFI_KEYMGMT_BIT)) {
        const bit = Number(bitStr);
        if ((firstByte & bit) === bit) labels.push(label);
    }
    if (!labels.length) return null;
    // PSK wins over NONE if both somehow set
    if (labels.includes('WPA_PSK') || labels.includes('WPA2_PSK')) return 'WPA_PSK';
    return labels[0];
}

function parseWifiConfigStore(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') {
        return { success: false, data: [], errors: ['empty xml'] };
    }
    try {
        const networks = [];
        // Find each <WifiConfiguration> ... </WifiConfiguration> block (real
        // Android 16 wraps these in <Network>; legacy ships them top-level).
        const blockRe = /<WifiConfiguration\b[^>]*>([\s\S]*?)<\/WifiConfiguration>/g;
        let m;
        while ((m = blockRe.exec(xmlText)) !== null) {
            const block = m[1];
            const getString = (name) => {
                const re = new RegExp(`<string\\s+name="${name}"\\s*>([\\s\\S]*?)<\\/string>`, 'i');
                const mm = re.exec(block);
                return mm ? _xmlDecode(mm[1].trim()) : null;
            };
            const getBoolAttr = (name) => {
                const re = new RegExp(`<boolean\\s+name="${name}"\\s+value="(true|false)"\\s*/?>`, 'i');
                const mm = re.exec(block);
                return mm ? mm[1] === 'true' : null;
            };
            const getIntAttr = (name) => {
                const re = new RegExp(`<int\\s+name="${name}"\\s+value="(-?\\d+)"\\s*/?>`, 'i');
                const mm = re.exec(block);
                return mm ? Number(mm[1]) : null;
            };
            const getLongAttr = (name) => {
                const re = new RegExp(`<long\\s+name="${name}"\\s+value="(-?\\d+)"\\s*/?>`, 'i');
                const mm = re.exec(block);
                return mm ? Number(mm[1]) : null;
            };
            const getByteArrayHex = (name) => {
                const re = new RegExp(`<byte-array\\s+name="${name}"\\s+num="\\d+"\\s*>([0-9a-fA-F\\s]*)<\\/byte-array>`, 'i');
                const mm = re.exec(block);
                return mm ? mm[1].trim() : null;
            };

            // SSID — may be HTML-escaped: &quot;SSID&quot;
            let ssid = getString('SSID') || getString('SSIDKey') || '';
            if (ssid.startsWith('"') && ssid.endsWith('"') && ssid.length >= 2) ssid = ssid.slice(1, -1);

            const bssid = getString('BSSID') || '';

            // Security resolution priority:
            //  1. <SecurityParams><int name="SecurityType" value="N"/></SecurityParams>
            //     — Android 13+, most specific. Pick the FIRST enabled entry
            //     (Android stores the preferred at index 0).
            //  2. <byte-array name="AllowedKeyMgmt">XX</byte-array>     — Android 10–14
            //  3. <string name="KeyMgmt">WPA_PSK</string>               — legacy AOSP
            let security = null;
            const paramsListMatch = /<SecurityParamsList\b[^>]*>([\s\S]*?)<\/SecurityParamsList>/i.exec(block);
            if (paramsListMatch) {
                const paramsRe = /<SecurityParams\b[^>]*>([\s\S]*?)<\/SecurityParams>/g;
                let pm, firstEnabled = null, firstAny = null;
                while ((pm = paramsRe.exec(paramsListMatch[1])) !== null) {
                    const inner = pm[1];
                    const typeM   = /<int\s+name="SecurityType"\s+value="(-?\d+)"\s*\/?>/i.exec(inner);
                    const enabledM = /<boolean\s+name="IsEnabled"\s+value="(true|false)"\s*\/?>/i.exec(inner);
                    if (!typeM) continue;
                    const t = Number(typeM[1]);
                    const enabled = enabledM ? enabledM[1] === 'true' : true;
                    if (firstAny == null) firstAny = t;
                    if (firstEnabled == null && enabled) firstEnabled = t;
                }
                const chosen = firstEnabled != null ? firstEnabled : firstAny;
                if (chosen != null) security = _WIFI_SECURITY_TYPE[chosen] || `TYPE_${chosen}`;
            }
            if (!security) {
                const km = getByteArrayHex('AllowedKeyMgmt');
                if (km) security = _wifiSecurityFromBytesHex(km);
            }
            if (!security) {
                const legacy = getString('KeyMgmt');
                if (legacy) security = legacy;
            }

            // PSK presence — only count actual <string> nodes, NOT <null> placeholders.
            const hasPsk = /<string\s+name="PreSharedKey"\s*>/i.test(block);

            networks.push({
                ssid,
                bssid,
                bssidHistory: bssid ? [bssid] : [],
                security: security || 'UNKNOWN',
                hidden: getBoolAttr('HiddenSSID'),
                status: getIntAttr('Status'),
                autoConnect: getBoolAttr('AutoJoinEnabled'),
                creationTime: getLongAttr('CreationTime'),
                lastConnected: getLongAttr('LastConnected'),
                creatorName: getString('CreatorName') || '',
                preSharedKeyPresent: hasPsk,   // boolean only — never extracted
            });
        }
        return { success: true, data: networks, errors: [] };
    } catch (e) {
        return { success: false, data: [], errors: [e.message] };
    }
}

// ─── SQLite magic-byte sniff ────────────────────────────────────────────
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000');

function isSqlite(buffer) {
    if (!buffer || buffer.length < SQLITE_MAGIC.length) return false;
    return buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

module.exports = {
    SURFACES,
    parseUfdx,
    parseUfd,
    parseBuildProp,
    parseInstalledAppsList,
    crossCheckAppsWithDataDir,
    parseContactsDb,
    parseCallLogDb,
    parseMmsSmsDb,
    parseBugleDb,
    parseAccountsDb,
    parseWifiConfigStore,
    isSqlite,
    // internals exported for tests
    _internals: { _xmlTag, _xmlTagAll, _phoneTypeLabel, _emailTypeLabel,
        _bugleProtocolLabel, _bugleKindFromProtocol, _bugleStatusLabel, _bugleDirection },
};
