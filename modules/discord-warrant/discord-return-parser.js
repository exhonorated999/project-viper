/**
 * Discord LAW-ENFORCEMENT RETURN parser.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * `discord-warrant-parser.js` parses a **Discord Data Package** — the ZIP a
 * *user* downloads from Settings → Privacy → "Request all of my data".
 * Its layout is TitleCase + JSON:
 *      Account/user.json, Messages/index.json, Servers/, Activity/
 *
 * That is NOT what Discord's legal-compliance team sends back on a search
 * warrant / subpoena / court order.  A law-enforcement return is lowercase
 * and CSV-based:
 *      messages/dms/<channelid>.csv
 *      messages/servers/<channelid>.csv
 *      messages/unknown/<channelid>.csv
 *      messages/archived/<channelid>.csv
 *      servers/<guildid>.json
 *      relationships_<userid>.csv
 *      attachments/<attachmentid>/<filename>
 *      (+ a subscriber/account CSV or JSON at the root, name varies)
 *
 * The two formats share no filenames, so the Data Package detector rejects a
 * real return outright — the user sees "not a Discord package" or an import
 * that yields nothing.  This parser handles the return format and emits the
 * SAME output shape as `_parseSources`, so the existing UI renders it
 * unchanged.
 *
 * Column layouts cross-checked against RLEAPP (MIT, © Alexis Brignoni et al.)
 * scripts/artifacts/discordReturns*.py — https://github.com/abrignoni/RLEAPP
 *
 * Runs in the Electron MAIN process (Node).
 */

const fs = require('fs');
const path = require('path');

// Discord epoch — snowflake IDs encode their own creation time.
const DISCORD_EPOCH = 1420070400000;

// ── Small RFC4180 CSV reader ────────────────────────────────────────────
// Must support quoted fields containing commas AND newlines: the Contents
// column routinely holds multi-line chat text, and the Attachments column is
// a newline-separated list of CDN URLs inside a single quoted field.
function parseCsv(text) {
    if (typeof text !== 'string' || !text) return [];
    let s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip BOM
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let started = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inQuotes) {
            if (ch === '"') {
                if (s[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { inQuotes = true; started = true; continue; }
        if (ch === ',') { row.push(field); field = ''; started = true; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; continue; }
        field += ch;
        started = true;
    }
    if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
    // Drop trailing all-empty row produced by a final newline
    while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
    return rows;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

class DiscordReturnParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Decide whether a set of entry names looks like a Discord LE return, and
     * find the root prefix (returns are frequently re-zipped inside a wrapper
     * folder named after the case or the Discord request ID).
     *
     * @param {string[]} entryNames
     * @returns {{ match:boolean, root:string, reasons:string[] }}
     */
    static detect(entryNames) {
        const names = (entryNames || []).map(n => String(n).replace(/\\/g, '/').replace(/^\/+/, ''));
        const reasons = [];

        // Candidate roots: '' plus every distinct first-path-segment, plus
        // every two-segment prefix.  Covers pkg.zip → <case>/ → <requestid>/.
        const roots = new Set(['']);
        for (const n of names) {
            const parts = n.split('/');
            if (parts.length > 1) roots.add(parts[0] + '/');
            if (parts.length > 2) roots.add(parts[0] + '/' + parts[1] + '/');
        }

        let best = null;
        for (const root of roots) {
            const rel = names
                .filter(n => n.toLowerCase().startsWith(root.toLowerCase()))
                .map(n => n.slice(root.length));
            const lower = rel.map(r => r.toLowerCase());

            const hasMsgDir = lower.some(r => /^messages\/(dms|servers|unknown|archived)\/.+\.csv$/.test(r));
            const hasAnyMsgCsv = lower.some(r => /^messages\/[^/]+\/[^/]+\.csv$/.test(r));
            const hasServersJson = lower.some(r => /^servers\/[^/]+\.json$/.test(r));
            const hasRelationships = lower.some(r => /^relationships[^/]*\.csv$/.test(r));
            const hasAttachments = lower.some(r => /^attachments\//.test(r));

            const score =
                (hasMsgDir ? 3 : 0) + (hasAnyMsgCsv ? 1 : 0) + (hasServersJson ? 2 : 0) +
                (hasRelationships ? 2 : 0) + (hasAttachments ? 1 : 0);

            if (score >= 3 && (!best || score > best.score)) {
                const why = [];
                if (hasMsgDir) why.push('messages/{dms,servers,unknown,archived}/*.csv');
                else if (hasAnyMsgCsv) why.push('messages/*/*.csv');
                if (hasServersJson) why.push('servers/*.json');
                if (hasRelationships) why.push('relationships_*.csv');
                if (hasAttachments) why.push('attachments/');
                best = { score, root, reasons: why };
            }
        }

        if (!best) return { match: false, root: '', reasons: [] };
        reasons.push(...best.reasons);
        if (best.root) reasons.push(`nested under "${best.root}"`);
        return { match: true, root: best.root, reasons };
    }

    static isReturnZipEntries(entryNames) { return DiscordReturnParser.detect(entryNames).match; }

    static isReturnFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;
            const all = [];
            const walk = (dir, rel, depth) => {
                if (depth > 4) return;
                let items;
                try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const it of items) {
                    const r = rel ? rel + '/' + it.name : it.name;
                    if (it.isFile()) all.push(r);
                    else if (it.isDirectory()) walk(path.join(dir, it.name), r, depth + 1);
                }
            };
            walk(folderPath, '', 0);
            return DiscordReturnParser.detect(all).match;
        } catch (_) { return false; }
    }

    // ─── Timestamps ─────────────────────────────────────────────────────

    /**
     * Normalize whatever the return puts in a timestamp column to ISO-8601 UTC.
     * Seen in the wild: Unix seconds, Unix milliseconds, ISO-8601 with 'Z',
     * ISO-8601 with an offset, and naive "YYYY-MM-DD HH:MM:SS" (treated UTC —
     * Discord returns are UTC; the header says so).
     */
    static normalizeTs(value) {
        const v = String(value == null ? '' : value).trim();
        if (!v) return null;

        if (/^\d+$/.test(v)) {
            const n = Number(v);
            // 10 digits ≈ seconds, 13 ≈ ms.  Anything longer is a snowflake.
            if (v.length >= 17) return DiscordReturnParser.snowflakeToIso(v);
            const ms = v.length <= 11 ? n * 1000 : n;
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d.toISOString();
        }

        let t = v.replace(/\s+UTC$/i, '');
        // "2024-01-05 13:22:11" → ISO, assumed UTC
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(t)) {
            t = t.replace(' ', 'T') + 'Z';
        }
        const d = new Date(t);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    /** Discord snowflake → ISO timestamp (BigInt: IDs exceed 2^53). */
    static snowflakeToIso(id) {
        try {
            const ms = Number((BigInt(String(id).trim()) >> 22n)) + DISCORD_EPOCH;
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d.toISOString();
        } catch (_) { return null; }
    }

    // ─── Column mapping ─────────────────────────────────────────────────

    /**
     * Map a CSV header row to field indexes by NAME, falling back to the
     * documented positional layout when the header is absent or unrecognized.
     *
     * Canonical 7-column message layout (RLEAPP discordReturnsdms.py):
     *   0 Channel ID | 1 Message ID | 2 Author ID | 3 Timestamp |
     *   4 Username   | 5 Contents   | 6 Attachments
     * Compact 4-column variant (discordReturnsOnlineDMs.py):
     *   0 Timestamp | 1 Message ID | 2 Contents | 3 Attachments
     */
    static mapMessageColumns(headerRow) {
        const SYN = {
            channelId: ['channelid', 'channel'],
            id: ['messageid', 'id', 'msgid'],
            authorId: ['authorid', 'userid', 'author', 'senderid'],
            timestamp: ['timestamp', 'time', 'date', 'senttime', 'createdat', 'datetime'],
            username: ['username', 'user', 'name', 'authorname', 'sender'],
            contents: ['contents', 'content', 'message', 'messagecontents', 'text', 'body'],
            attachments: ['attachments', 'attachment', 'media', 'files', 'attachmenturls']
        };
        const map = {};
        let named = 0;
        if (Array.isArray(headerRow)) {
            headerRow.forEach((cell, i) => {
                const c = slug(cell);
                if (!c) return;
                for (const key of Object.keys(SYN)) {
                    if (map[key] !== undefined) continue;
                    if (SYN[key].includes(c)) { map[key] = i; named++; return; }
                }
            });
        }
        // A header row is only trustworthy if it actually named a timestamp or
        // contents column — otherwise it is probably a data row.
        if (named >= 3 && (map.timestamp !== undefined || map.contents !== undefined)) {
            return { map, source: 'header' };
        }

        const width = Array.isArray(headerRow) ? headerRow.length : 7;
        if (width <= 5) {
            return { map: { timestamp: 0, id: 1, contents: 2, attachments: 3 }, source: 'positional-compact' };
        }
        return {
            map: { channelId: 0, id: 1, authorId: 2, timestamp: 3, username: 4, contents: 5, attachments: 6 },
            source: 'positional-7col'
        };
    }

    // ─── Parse ──────────────────────────────────────────────────────────

    /**
     * @param {Object} src
     * @param {string[]} src.entryNames
     * @param {function(string):(string|null)} src.readText   keyed by ORIGINAL entry name
     * @param {function(string):(Buffer|null)} src.readBinary
     * @param {Object} src.options { extractDir, security }
     */
    async parse({ entryNames, readText, readBinary, options = {} }) {
        const { extractDir, security } = options;
        const warnings = [];
        const consumed = new Set();

        const originals = (entryNames || []).map(String);
        const det = DiscordReturnParser.detect(originals);
        const root = det.root || '';

        // rel(lowercased) -> original entry name, for case-insensitive lookup
        const relMap = new Map();
        for (const orig of originals) {
            const norm = orig.replace(/\\/g, '/').replace(/^\/+/, '');
            if (root && !norm.toLowerCase().startsWith(root.toLowerCase())) continue;
            relMap.set(norm.slice(root.length).toLowerCase(), orig);
        }
        const rels = Array.from(relMap.keys());

        const textOf = (rel) => {
            const orig = relMap.get(rel);
            if (!orig) return null;
            consumed.add(orig);
            try { return readText(orig); } catch (_) { return null; }
        };

        // ── 1) Messages ────────────────────────────────────────────────
        // messages/<bucket>/<channelid>.csv   bucket ∈ dms|servers|unknown|archived|…
        const channels = [];
        const msgFiles = rels.filter(r => /^messages\/[^/]+\/[^/]+\.csv$/.test(r) &&
                                          !path.basename(r).startsWith('._'));
        for (const rel of msgFiles.sort()) {
            const txt = textOf(rel);
            if (txt == null) { warnings.push(`Could not read ${rel}`); continue; }
            const rows = parseCsv(txt);
            if (!rows.length) { warnings.push(`${rel} is empty`); continue; }

            const seg = rel.split('/');
            const bucket = seg[1];
            const fileChannelId = path.basename(rel, '.csv');

            const { map, source } = DiscordReturnParser.mapMessageColumns(rows[0]);
            const at = (r, k) => (map[k] === undefined ? '' : (r[map[k]] ?? ''));

            // Only discard row 0 when it really is a header.  Some returns ship
            // headerless CSVs; blindly slicing would silently drop the first
            // message of every such channel.  When the column layout came from
            // the positional fallback, decide by inspecting row 0 itself: a
            // parseable timestamp or a snowflake-shaped ID means it is data.
            let body;
            if (source === 'header') {
                body = rows.slice(1);
            } else {
                const first = rows[0] || [];
                const looksLikeData =
                    !!DiscordReturnParser.normalizeTs(at(first, 'timestamp')) ||
                    /^\d{15,}$/.test(String(at(first, 'id') || '').trim());
                body = looksLikeData ? rows : rows.slice(1);
                if (!looksLikeData) {
                    warnings.push(`${rel}: row 1 discarded as an unrecognized header`);
                }
            }

            const messages = [];
            for (const r of body) {
                if (!r || r.every(c => String(c).trim() === '')) continue;
                const id = String(at(r, 'id') || '').trim();
                const rawTs = at(r, 'timestamp');
                const ts = DiscordReturnParser.normalizeTs(rawTs) ||
                           (id ? DiscordReturnParser.snowflakeToIso(id) : null);
                messages.push({
                    id: id || null,
                    timestamp: ts,
                    rawTimestamp: String(rawTs || '') || null,
                    contents: String(at(r, 'contents') || ''),
                    attachments: String(at(r, 'attachments') || ''),
                    authorId: String(at(r, 'authorId') || '') || null,
                    username: String(at(r, 'username') || '') || null
                });
            }

            const channelId = String(at(body[0] || [], 'channelId') || '').trim() || fileChannelId;
            channels.push({
                id: channelId,
                name: `${bucket}/${fileChannelId}`,
                type: bucket === 'dms' ? 'DM' : bucket === 'servers' ? 'Server' : bucket,
                guildId: null,
                guildName: null,
                indexLabel: null,
                recipients: null,
                messageCount: messages.length,
                messages,
                _sourceFile: rel,
                _columnSource: source
            });
            if (source !== 'header') {
                warnings.push(`${rel}: header row not recognized — used ${source} column layout`);
            }
        }

        // ── 2) Servers ─────────────────────────────────────────────────
        const servers = [];
        for (const rel of rels.filter(r => /^servers\/[^/]+\.json$/.test(r)).sort()) {
            const txt = textOf(rel);
            if (txt == null) continue;
            let obj = null;
            try { obj = JSON.parse(txt); } catch (_) {
                warnings.push(`${rel}: not valid JSON`); continue;
            }
            const list = Array.isArray(obj) ? obj : [obj];
            for (const g of list) {
                if (!g || typeof g !== 'object') continue;
                servers.push({
                    id: String(g.id || g.ID || path.basename(rel, '.json')),
                    name: g.name || g.Name || `Server ${path.basename(rel, '.json')}`,
                    description: g.description || g.Description || null,
                    ownerId: g.owner_id || g.ownerId || g['Owner ID'] || null,
                    channels: Array.isArray(g.channels) ? g.channels : [],
                    auditLog: Array.isArray(g.audit_log) ? g.audit_log : []
                });
            }
        }

        // ── 3) Relationships (friends / blocks) ────────────────────────
        const relationships = [];
        for (const rel of rels.filter(r => /^relationships[^/]*\.csv$/.test(r)).sort()) {
            const txt = textOf(rel);
            if (txt == null) continue;
            const rows = parseCsv(txt);
            for (const r of rows.slice(1)) {
                if (!r || r.every(c => String(c).trim() === '')) continue;
                relationships.push({
                    userId: String(r[0] || '').trim() || null,
                    username: String(r[1] || '').trim() || null,
                    relationship: String(r[2] || '').trim() || null
                });
            }
        }

        // ── 4) Subscriber / account info ───────────────────────────────
        const subscriber = this._findSubscriber(rels, textOf, warnings) ||
            { id: null, username: null, email: null, phone: null, ip: null, sessions: [], connections: [], flags: [] };
        subscriber.relationships = relationships;

        // ── 5) Attachments ─────────────────────────────────────────────
        // Layout: attachments/<attachmentid>/<filename>  (id also appears as
        // the second-to-last segment of the CDN URL in the Attachments column).
        const contentFiles = {};
        const attachRels = rels.filter(r => /^attachments\//.test(r));
        if (extractDir && attachRels.length) {
            try { fs.mkdirSync(extractDir, { recursive: true }); } catch (_) {}
            for (const rel of attachRels) {
                const orig = relMap.get(rel);
                if (!orig) continue;
                let buf = null;
                try { buf = readBinary(orig); } catch (_) {}
                if (!buf) { warnings.push(`Could not extract ${rel}`); continue; }
                consumed.add(orig);
                const safeName = rel.replace(/[\\/]/g, '_');
                const outPath = path.join(extractDir, safeName);
                let toWrite = buf;
                if (security && security.isUnlocked && security.isUnlocked()) {
                    try { toWrite = security.encryptBuffer(buf); } catch (_) {}
                }
                try {
                    fs.writeFileSync(outPath, toWrite);
                    const segs = rel.split('/');
                    contentFiles[safeName] = {
                        diskPath: outPath,
                        size: buf.length,
                        mimeType: this._mime(path.extname(rel).toLowerCase()),
                        kind: 'attachment',
                        attachmentId: segs.length >= 3 ? segs[1] : null,
                        original: rel
                    };
                } catch (_) { warnings.push(`Could not write ${rel} to disk`); }
            }
        } else if (attachRels.length) {
            warnings.push(`${attachRels.length} attachment file(s) present but no extract directory was provided`);
        }

        // Link extracted media back onto each message via the attachment ID
        const byAttachmentId = new Map();
        for (const k of Object.keys(contentFiles)) {
            const id = contentFiles[k].attachmentId;
            if (!id) continue;
            if (!byAttachmentId.has(id)) byAttachmentId.set(id, []);
            byAttachmentId.get(id).push(contentFiles[k]);
        }
        let linked = 0;
        for (const ch of channels) {
            for (const m of ch.messages) {
                if (!m.attachments) continue;
                const media = [];
                for (const part of String(m.attachments).split(/[\r\n]+/)) {
                    const p = part.trim();
                    if (!p) continue;
                    const segs = p.split('/');
                    const id = segs.length >= 2 ? segs[segs.length - 2] : p;
                    for (const rec of (byAttachmentId.get(id) || [])) media.push(rec);
                }
                if (media.length) { m.media = media; linked += media.length; }
            }
        }

        // ── 6) Diagnostics ─────────────────────────────────────────────
        const unmatched = originals.filter(o => !consumed.has(o) && !/\/$/.test(o));
        const messageCount = channels.reduce((s, c) => s + c.messageCount, 0);
        if (!messageCount && !servers.length && !relationships.length) {
            warnings.push('No messages, servers, or relationships were recovered from this return.');
        }

        return {
            format: 'le-return',
            formatLabel: 'Discord Law-Enforcement Return',
            detectedRoot: root || '(archive root)',
            detectReasons: det.reasons,

            subscriber,
            avatarFile: null,
            recentAvatarFiles: [],
            channels,
            servers,
            relationships,
            billing: { billingProfile: [], paymentSources: [], payments: [], entitlements: [] },
            dsar: [],
            promotions: { quests: [], drops: [] },
            store: { wishlist: [] },
            virtualCurrency: { accounts: [], transactions: [] },
            activity: { sessionStarts: [], sessionEnds: [], appOpens: [], logins: [], registers: [], otherImportant: [], eventCounts: {}, totalEventCount: 0 },
            ipActivity: [],
            devices: [],
            contentFiles,

            stats: {
                messageCount,
                channelCount: channels.length,
                serverCount: servers.length,
                relationshipCount: relationships.length,
                sessionCount: (subscriber.sessions || []).length,
                ipCount: 0,
                deviceCount: 0,
                eventCount: 0,
                mediaCount: Object.keys(contentFiles).length,
                mediaLinked: linked
            },

            diagnostics: {
                filesSeen: originals.length,
                filesConsumed: consumed.size,
                unmatchedFiles: unmatched.slice(0, 200),
                unmatchedCount: unmatched.length,
                warnings
            }
        };
    }

    /**
     * Returns put subscriber/account info in a root-level file whose name has
     * varied across vintages.  Try the known names, then any root CSV/JSON
     * that is not one of the structured artifacts we already consumed.
     */
    _findSubscriber(rels, textOf, warnings) {
        const candidates = rels.filter(r =>
            !r.includes('/') && /\.(csv|json)$/.test(r) &&
            !/^relationships/.test(r)
        );
        const preferred = candidates.filter(r =>
            /(subscriber|account|user|basic|profile|info)/i.test(r)
        );
        for (const rel of preferred.concat(candidates)) {
            const txt = textOf(rel);
            if (!txt) continue;

            if (rel.endsWith('.json')) {
                try {
                    const o = JSON.parse(txt);
                    const u = Array.isArray(o) ? o[0] : (o && o.records ? o.records[0] : o);
                    if (u && typeof u === 'object') return this._normalizeSubscriber(u, rel);
                } catch (_) { warnings.push(`${rel}: not valid JSON`); }
                continue;
            }

            const rows = parseCsv(txt);
            if (rows.length < 2) continue;
            // Two shapes occur: key/value pairs down the rows, or a header row
            // plus one data row.
            const looksKeyValue = rows.every(r => r.length <= 2);
            const obj = {};
            if (looksKeyValue) {
                for (const r of rows) if (r[0]) obj[slug(r[0])] = r[1];
            } else {
                rows[0].forEach((h, i) => { if (h) obj[slug(h)] = rows[1][i]; });
            }
            if (Object.keys(obj).length) return this._normalizeSubscriber(obj, rel);
        }
        return null;
    }

    _normalizeSubscriber(u, sourceFile) {
        const pick = (...keys) => {
            for (const k of keys) {
                if (u[k] != null && u[k] !== '') return u[k];
                const sk = slug(k);
                for (const uk of Object.keys(u)) {
                    if (slug(uk) === sk && u[uk] != null && u[uk] !== '') return u[uk];
                }
            }
            return null;
        };
        const regTs = pick('registration_date', 'registrationdate', 'created_at', 'registered');
        const globalName = pick('global_name', 'display_name', 'displayname');
        return {
            id: pick('id', 'user_id', 'userid', 'account_id') != null ? String(pick('id', 'user_id', 'userid', 'account_id')) : null,
            username: pick('username', 'user_name', 'handle'),
            globalName,
            global_name: globalName,       // alias: the existing UI reads snake_case
            discriminator: pick('discriminator', 'tag'),
            email: pick('email', 'email_address', 'emailaddress'),
            phone: pick('phone', 'phone_number', 'phonenumber'),
            ip: pick('ip', 'registration_ip', 'registrationip', 'last_ip', 'lastip'),
            registrationDate: regTs ? (DiscordReturnParser.normalizeTs(regTs) || String(regTs)) : null,
            verified: pick('verified'),
            sessions: [],
            connections: [],
            flags: [],
            _sourceFile: sourceFile,
            _raw: u
        };
    }

    _mime(ext) {
        const m = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
            '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
            '.pdf': 'application/pdf', '.txt': 'text/plain'
        };
        return m[ext] || 'application/octet-stream';
    }
}

module.exports = { DiscordReturnParser, parseCsv };
