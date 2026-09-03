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
const { streamCsvRows } = require('./dw-csv-stream');

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
        // A file we opened but understood nothing in is NOT consumed — it has
        // to reach the diagnostics banner, or a return we half-read looks like
        // a clean import.
        const unconsume = (rel) => {
            const orig = relMap.get(rel);
            if (orig) consumed.delete(orig);
        };

        // ── 0) Subscriber / account info ───────────────────────────────
        // Parsed FIRST: the account's own username is what lets us tell "me"
        // from "them" when naming a DM and when aligning chat bubbles.
        const subscriber = this._findSubscriber(rels, textOf, warnings) ||
            { id: null, username: null, email: null, phone: null, ip: null, sessions: [], connections: [], flags: [] };

        // session/*.txt is where a return actually states the account's
        // username — and we need that BEFORE reading messages so every row can
        // be classified as the subscriber's own or a correspondent's.
        const ipActivity = this._parseSessionAndReports(rels, textOf, subscriber, warnings, unconsume);

        const selfKeys = new Set();
        for (const v of [subscriber.id, subscriber.username, subscriber.globalName]) {
            if (v) selfKeys.add(String(v).toLowerCase());
        }
        // "name#0" and "name" should both match the subscriber.
        if (subscriber.username) selfKeys.add(String(subscriber.username).split('#')[0].toLowerCase());

        // ── 1) Servers (parsed before messages: they NAME the channels) ─
        // servers/<guildid>.json carries { id, name, owner_id,
        // channels: { "<channelid>": "<name>" }, threads: { ... } }.  That map
        // is the ONLY place a return states a channel's human-readable name —
        // without it every server channel renders as a bare snowflake.
        const servers = [];
        const channelIndex = new Map(); // channelId -> {name, guildId, guildName, isThread}
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
                const gid = String(g.id || g.ID || path.basename(rel, '.json'));
                const gname = g.name || g.Name || `Server ${path.basename(rel, '.json')}`;

                // Returns use an id→name object; the data package and older
                // vintages use an array of channel objects.  Accept both.
                const harvest = (blob, isThread) => {
                    const out = [];
                    if (Array.isArray(blob)) {
                        for (const c of blob) {
                            if (!c || typeof c !== 'object') continue;
                            out.push({ id: String(c.id ?? c.ID ?? ''), name: String(c.name ?? c.Name ?? '') });
                        }
                    } else if (blob && typeof blob === 'object') {
                        for (const k of Object.keys(blob)) out.push({ id: String(k), name: String(blob[k] ?? '') });
                    }
                    for (const c of out) {
                        if (!c.id) continue;
                        channelIndex.set(c.id, { name: c.name || null, guildId: gid, guildName: gname, isThread: !!isThread });
                    }
                    return out;
                };
                const guildChannels = harvest(g.channels, false);
                const guildThreads = harvest(g.threads, true);

                servers.push({
                    id: gid,
                    name: gname,
                    description: g.description || g.Description || null,
                    ownerId: g.owner_id || g.ownerId || g['Owner ID'] || null,
                    icon: g.icon || null,
                    region: g.region || null,
                    preferredLocale: g.preferred_locale || null,
                    channels: guildChannels,
                    threads: guildThreads,
                    channelCount: guildChannels.length,
                    threadCount: guildThreads.length,
                    auditLog: Array.isArray(g.audit_log) ? g.audit_log : []
                });
            }
        }

        // ── 2) Relationships (friends / blocks) ────────────────────────
        // Real returns ship this headerless too: <userid>,<username>,FRIEND.
        // Parsed before messages only so that message streaming can be the
        // last thing that happens — see the note on section 4.
        const relationships = [];
        for (const rel of rels.filter(r => /^relationships[^/]*\.csv$/.test(r)).sort()) {
            const txt = textOf(rel);
            if (txt == null) continue;
            const rows = parseCsv(txt);
            if (!rows.length) continue;
            const h0 = rows[0] || [];
            const headerLooksNamed =
                /^(user\s*id|id)$/i.test(String(h0[0] || '').trim()) ||
                /^(user\s*name|username|name)$/i.test(String(h0[1] || '').trim());
            const body = headerLooksNamed ? rows.slice(1) : rows;
            for (const r of body) {
                if (!r || r.every(c => String(c).trim() === '')) continue;
                relationships.push({
                    userId: String(r[0] || '').trim() || null,
                    username: String(r[1] || '').trim() || null,
                    relationship: String(r[2] || '').trim() || null
                });
            }
        }
        subscriber.relationships = relationships;

        // ── 3) Attachments ─────────────────────────────────────────────
        // Seen in the wild as BOTH attachments/<attachmentid>/<file> and
        // attachments/<channelid>/<attachmentid>/<file>.  The attachment ID is
        // always the LAST directory segment, which is also the second-to-last
        // segment of the CDN URL in the Attachments column — that is the join.
        //
        // Extracted BEFORE messages: media used to be stitched onto each row
        // in a second pass over channels[].messages, which is impossible once
        // messages are streamed straight to disk and never held in memory.
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
                        // The attachment ID is the LAST directory segment, not
                        // segs[1]: real returns nest as
                        // attachments/<channelid>/<attachmentid>/<file>.
                        attachmentId: segs.length >= 3 ? segs[segs.length - 2] : null,
                        channelId: segs.length >= 4 ? segs[1] : null,
                        fileName: segs[segs.length - 1],
                        original: rel
                    };
                } catch (_) { warnings.push(`Could not write ${rel} to disk`); }
            }
        } else if (attachRels.length) {
            warnings.push(`${attachRels.length} attachment file(s) present but no extract directory was provided`);
        }

        // `rels` are lower-cased for case-insensitive lookup while the CDN URL
        // in the CSV keeps its original case, so BOTH sides must be folded.
        const byAttachmentId = new Map();
        for (const k of Object.keys(contentFiles)) {
            const id = contentFiles[k].attachmentId;
            if (!id) continue;
            const key = String(id).toLowerCase();
            if (!byAttachmentId.has(key)) byAttachmentId.set(key, []);
            byAttachmentId.get(key).push(contentFiles[k]);
        }
        let linked = 0;
        const mediaFor = (attachmentsCell) => {
            if (!attachmentsCell || !byAttachmentId.size) return null;
            const media = [];
            for (const part of String(attachmentsCell).split(/[\r\n]+/)) {
                const p = part.trim();
                if (!p) continue;
                const segs = p.split('?')[0].split('/');
                const id = (segs.length >= 2 ? segs[segs.length - 2] : p).toLowerCase();
                for (const rec of (byAttachmentId.get(id) || [])) media.push(rec);
            }
            if (!media.length) return null;
            linked += media.length;
            return media;
        };

        // ── 4) Messages ────────────────────────────────────────────────
        // messages/<bucket>/<channelid>.csv   bucket ∈ dms|servers|unknown|archived|…
        //
        // STREAMED, one row at a time.  A second agency's return is 2.36 GB
        // with a single message CSV of 355 MB / ~2.4 M rows; buffering that
        // file (string + array-of-arrays + array of objects) is several GB of
        // live heap and killed the main process outright.  When the caller
        // supplies options.openStream + options.messageSink each row goes
        // straight into SQLite and is forgotten.
        //
        // Rows are kept in memory ONLY while the running total is under
        // INLINE_BUDGET, so a small return still travels inline over IPC on
        // exactly the code path it always did.  The moment the budget is
        // exceeded every buffered array is dropped and the import is lazy.
        const openStream = options.openStream || null;
        const sink = options.messageSink || null;
        // Without a sink there is nowhere for a dropped row to go, so the
        // budget only applies when the caller gave us somewhere to stream to.
        const INLINE_BUDGET = !sink ? Infinity
            : (Number.isFinite(options.inlineBudget) ? options.inlineBudget : 25000);
        let lazy = false;
        let inlineTotal = 0;

        const channels = [];
        const msgFiles = rels.filter(r => /^messages\/[^/]+\/[^/]+\.csv$/.test(r) &&
                                          !path.basename(r).startsWith('._'));
        let headerlessCount = 0;
        for (const rel of msgFiles.sort()) {
            const seg = rel.split('/');
            const bucket = seg[1];
            const fileChannelId = path.basename(rel, '.csv');

            // Per-channel accumulators.  Everything here is O(distinct
            // authors), never O(messages).
            let map = null;
            let source = null;
            let headerDecided = false;
            let count = 0;
            let firstMessage = null;
            let lastMessage = null;
            let channelIdSeen = null;
            let sinkOpen = false;
            const messages = [];
            const seen = new Map();
            const at = (r, k) => (map[k] === undefined ? '' : (r[map[k]] ?? ''));

            const onRow = (r) => {
                if (!headerDecided) {
                    headerDecided = true;
                    const m = DiscordReturnParser.mapMessageColumns(r);
                    map = m.map; source = m.source;
                    if (source !== 'header') headerlessCount++;

                    // Only discard row 0 when it really is a header.  Some
                    // returns ship headerless CSVs; blindly skipping would
                    // silently drop the first message of every such channel.
                    if (source === 'header') return;
                    const looksLikeData =
                        !!DiscordReturnParser.normalizeTs(at(r, 'timestamp')) ||
                        /^\d{15,}$/.test(String(at(r, 'id') || '').trim());
                    if (!looksLikeData) {
                        warnings.push(`${rel}: row 1 discarded as an unrecognized header`);
                        return;
                    }
                    // else fall through — row 0 is data
                }
                if (!r || r.every(c => String(c).trim() === '')) return;

                const id = String(at(r, 'id') || '').trim();
                const rawTs = at(r, 'timestamp');
                const ts = DiscordReturnParser.normalizeTs(rawTs) ||
                           (id ? DiscordReturnParser.snowflakeToIso(id) : null);
                const authorId = String(at(r, 'authorId') || '').trim() || null;
                const username = String(at(r, 'username') || '').trim() || null;
                const isSelf =
                    (authorId && selfKeys.has(authorId.toLowerCase())) ||
                    (username && (selfKeys.has(username.toLowerCase()) ||
                                  selfKeys.has(username.split('#')[0].toLowerCase())));
                const msg = {
                    id: id || null,
                    timestamp: ts,
                    rawTimestamp: String(rawTs || '') || null,
                    contents: String(at(r, 'contents') || ''),
                    attachments: String(at(r, 'attachments') || ''),
                    authorId,
                    username,
                    // Drives bubble alignment in the thread view.  Only a
                    // return carries an author per row; a data package does
                    // not, so this field is return-only by design.
                    direction: isSelf ? 'outgoing' : 'incoming'
                };
                const media = mediaFor(msg.attachments);
                if (media) msg.media = media;

                if (channelIdSeen === null) {
                    channelIdSeen = String(at(r, 'channelId') || '').trim() || null;
                }
                if (ts) {
                    if (!firstMessage || ts < firstMessage) firstMessage = ts;
                    if (!lastMessage || ts > lastMessage) lastMessage = ts;
                }

                // Participants, most-talkative first.  For a DM this is the
                // only way to put a name on the thread — the return never
                // states one.  Capped so a busy server channel cannot turn
                // the "bounded memory" promise into a lie.
                const key = (authorId || username || '').toLowerCase();
                if (key) {
                    let cur = seen.get(key);
                    if (!cur && seen.size < 5000) {
                        cur = { id: authorId, username, count: 0, isSubscriber: msg.direction === 'outgoing' };
                        seen.set(key, cur);
                    }
                    if (cur) {
                        if (!cur.username && username) cur.username = username;
                        if (!cur.id && authorId) cur.id = authorId;
                        cur.count++;
                    }
                }

                if (sink) {
                    if (!sinkOpen) { sink.beginChannel(channelIdSeen || fileChannelId); sinkOpen = true; }
                    sink.write(msg);
                }
                count++;

                if (!lazy) {
                    messages.push(msg);
                    if (++inlineTotal > INLINE_BUDGET) {
                        lazy = true;
                        messages.length = 0;
                        for (const prev of channels) prev.messages = [];
                    }
                }
            };

            let read = false;
            if (openStream) {
                const orig = relMap.get(rel);
                let stream = null;
                try { stream = orig ? await openStream(orig) : null; } catch (_) { stream = null; }
                if (stream) {
                    consumed.add(orig);
                    try {
                        await streamCsvRows(stream, onRow);
                        read = true;
                    } catch (err) {
                        warnings.push(`${rel}: read failed after ${count} row(s) — ${err.message}`);
                        read = true; // partial: keep what we got, report it
                    }
                }
            }
            if (!read) {
                const txt = textOf(rel);
                if (txt == null) { warnings.push(`Could not read ${rel}`); continue; }
                for (const r of parseCsv(txt)) onRow(r);
            }

            if (sinkOpen) { try { sink.endChannel(); } catch (_) {} }
            if (!count && !headerDecided) { warnings.push(`${rel} is empty`); continue; }

            const participants = Array.from(seen.values()).sort((a, b) => b.count - a.count);
            const others = participants.filter(p => !p.isSubscriber);

            const channelId = channelIdSeen || fileChannelId;
            const idx = channelIndex.get(channelId) || channelIndex.get(fileChannelId) || null;

            // Name resolution, best source first:
            //   1. servers/<guild>.json channels/threads map  → "#general"
            //   2. the other DM participants                  → "alice, bob"
            //   3. the channel snowflake                      → last resort
            let channelName = null;
            let channelType = null;
            if (idx && idx.name) {
                channelName = (idx.isThread ? '🧵 ' : '#') + idx.name;
                channelType = idx.isThread ? 'GUILD_THREAD' : 'GUILD_TEXT';
            } else if (bucket === 'dms' || bucket === 'archived' || others.length) {
                const named = (others.length ? others : participants)
                    .slice(0, 4).map(p => p.username || p.id).filter(Boolean);
                if (named.length) {
                    channelName = named.join(', ') + (others.length > 4 ? ` +${others.length - 4}` : '');
                }
                channelType = others.length > 1 ? 'GROUP DM' : 'DM';
            }
            if (!channelName) channelName = `${bucket}/${fileChannelId}`;
            if (!channelType) channelType = bucket === 'servers' ? 'GUILD_TEXT' : bucket.toUpperCase();

            channels.push({
                // The UI reads channelId/channelName/channelType — this is the
                // contract the data-package parser emits.  Do NOT rename these:
                // 5.1.6 shipped id/name/type and every thread rendered blank
                // and un-clickable because `_openChannel` got an empty string.
                channelId,
                channelName,
                channelType,
                guildId: idx ? idx.guildId : null,
                guildName: idx ? idx.guildName : null,
                indexLabel: null,
                recipients: others.length ? others.map(p => ({ id: p.id, username: p.username })) : null,
                participants,
                bucket,
                firstMessage,
                lastMessage,
                messageCount: count,
                messages: lazy ? [] : messages,
                _sourceFile: rel,
                _columnSource: source
            });
        }
        if (lazy) {
            // The budget was blown partway through; nothing may keep rows.
            for (const ch of channels) { ch.messages = []; ch._sharded = true; }
        }
        if (headerlessCount) {
            // Real returns ship headerless message CSVs.  Report it once,
            // not 101 times — one line per channel drowns the banner.
            warnings.push(`${headerlessCount} of ${msgFiles.length} message file(s) had no recognizable header row — the documented positional column layout was used.`);
        }

        // ── 5) Diagnostics ─────────────────────────────────────────────
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

            // True when the message bodies were streamed to the case store
            // instead of being carried inline.  The caller stamps _storeKey.
            _lazy: lazy,
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
            ipActivity,
            devices: [],
            contentFiles,

            stats: {
                messageCount,
                channelCount: channels.length,
                serverCount: servers.length,
                relationshipCount: relationships.length,
                sessionCount: (subscriber.sessions || []).length,
                ipCount: ipActivity.length,
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
     * Returns ship two extra artifact families the message/server readers
     * ignore, and both are pure gold for an investigator:
     *
     *   session/<something>.txt   — a plain-text subscriber sheet
     *                               ("User ID: …", "Username: …", "Email: …")
     *                               followed by a Date/IP access table.
     *   reports/<something>.csv   — message-report and login/session history.
     *                               Header names vary; one file in the
     *                               reference return is fully headerless.
     *
     * Rather than hard-code column names that change between vintages, sniff
     * each CSV for an IP-shaped column and a timestamp-shaped column and roll
     * everything up into the ipActivity table the UI already renders.
     * Anything not understood is left to the diagnostics banner.
     *
     * Mutates `subscriber` in place with any field it can fill that is still
     * blank; never overwrites a value the primary reader already found.
     */
    _parseSessionAndReports(rels, textOf, subscriber, warnings, unconsume = () => {}) {
        const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
        const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
        const isIp = (v) => {
            const s = String(v || '').trim();
            if (IPV4.test(s)) return s.split('.').every(o => Number(o) <= 255);
            return IPV6.test(s) && s.includes('::') === s.includes('::');
        };

        const agg = new Map(); // ip -> record
        const note = (ip, ts, source, extra = {}) => {
            if (!ip) return;
            let rec = agg.get(ip);
            if (!rec) {
                rec = { ip, count: 0, locations: [], isps: [], oses: [], browsers: [],
                        firstSeen: null, lastSeen: null, sources: [] };
                agg.set(ip, rec);
            }
            rec.count++;
            if (ts) {
                if (!rec.firstSeen || ts < rec.firstSeen) rec.firstSeen = ts;
                if (!rec.lastSeen || ts > rec.lastSeen) rec.lastSeen = ts;
            }
            if (source && !rec.sources.includes(source)) rec.sources.push(source);
            for (const [k, bucket] of [['os', rec.oses], ['browser', rec.browsers],
                                       ['location', rec.locations], ['isp', rec.isps]]) {
                const v = String(extra[k] || '').trim();
                if (v && !bucket.includes(v)) bucket.push(v);
            }
        };

        // ── session/*.txt — subscriber sheet + access log ───────────────
        const setIfBlank = (key, val) => {
            const v = String(val == null ? '' : val).trim();
            if (!v || /^not found$/i.test(v)) return false;
            if (subscriber[key] == null || subscriber[key] === '') { subscriber[key] = v; return true; }
            return false;
        };
        for (const rel of rels.filter(r => /\.txt$/.test(r) && !/^attachments\//.test(r)).sort()) {
            const txt = textOf(rel);
            if (txt == null) continue;
            const label = rel;
            let gained = 0;
            for (const rawLine of String(txt).split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line) continue;

                const kv = line.match(/^([A-Za-z][A-Za-z0-9 ()/._-]{1,48}?)\s*:\s*(.+)$/);
                if (kv) {
                    const k = slug(kv[1]);
                    const v = kv[2].trim();
                    if (k === 'userid') gained += setIfBlank('id', v) ? 1 : 0;
                    else if (k === 'username') gained += setIfBlank('username', v) ? 1 : 0;
                    else if (k === 'email' || k === 'emailaddress') gained += setIfBlank('email', v) ? 1 : 0;
                    else if (k === 'emailverified') gained += setIfBlank('verified', v) ? 1 : 0;
                    else if (k === 'phonenumber' || k === 'phone') gained += setIfBlank('phone', v) ? 1 : 0;
                    else if (k === 'registrationip') {
                        gained += setIfBlank('ip', v) ? 1 : 0;
                        if (isIp(v)) { note(v, null, label, {}); gained++; }
                    } else if (k === 'lastip') {
                        if (isIp(v)) { note(v, null, label, {}); gained++; }
                    } else if (/^registrationdate/.test(k)) {
                        const iso = DiscordReturnParser.normalizeTs(v);
                        if (iso && !subscriber.registrationDate) { subscriber.registrationDate = iso; gained++; }
                    }
                    continue;
                }

                // Access table rows: "<date> <time> <ip>" (optionally more).
                const row = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s+(\S+)(?:\s+(.*))?$/);
                if (row && isIp(row[2])) {
                    note(row[2], DiscordReturnParser.normalizeTs(row[1]), label,
                         { browser: (row[3] || '').trim() });
                    gained++;
                }
            }
            if (!gained) unconsume(rel);
        }

        // ── reports/*.csv + any other loose CSV — sniff IP + timestamp ──
        // Skip the file the subscriber reader already claimed: unconsuming it
        // here would wrongly report it as unrecognized.
        const subFile = String(subscriber._sourceFile || '').toLowerCase();
        const csvRels = rels.filter(r =>
            /\.csv$/.test(r) &&
            r !== subFile &&
            !/^messages\//.test(r) &&
            !/^relationships/.test(r) &&
            !/^attachments\//.test(r)
        );
        for (const rel of csvRels.sort()) {
            const txt = textOf(rel);
            if (txt == null) continue;
            const rows = parseCsv(txt).filter(r => r && r.some(c => String(c).trim() !== ''));
            if (rows.length < 2) continue;

            // Header only counts if row 0 has no IP and no parseable timestamp.
            const h = rows[0];
            const headerish = !h.some(c => isIp(c)) &&
                              !h.some(c => DiscordReturnParser.normalizeTs(c) && /[-:]/.test(String(c)));
            const header = headerish ? h.map(c => slug(c)) : [];
            const body = headerish ? rows.slice(1) : rows;
            if (!body.length) continue;

            const width = Math.max(...body.slice(0, 50).map(r => r.length));
            const colIsIp = [], colIsTs = [];
            for (let i = 0; i < width; i++) {
                const sample = body.slice(0, 50).map(r => r[i]).filter(v => String(v || '').trim() !== '');
                if (!sample.length) continue;
                if (sample.every(isIp)) colIsIp.push(i);
                else if (sample.every(v => !!DiscordReturnParser.normalizeTs(v) && /[-:]/.test(String(v)))) colIsTs.push(i);
            }
            if (!colIsIp.length) {
                warnings.push(`${rel}: read but held no IP column — ${body.length} row(s) not surfaced.`);
                unconsume(rel);
                continue;
            }
            const ipCol = colIsIp[0];
            const tsCol = colIsTs.length ? colIsTs[0] : -1;
            const findCol = (...names) => {
                for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
                return -1;
            };
            const osCol = findCol('os', 'operatingsystem');
            const brCol = findCol('browser', 'client', 'useragent');
            const locCol = findCol('location', 'city', 'country');

            for (const r of body) {
                note(String(r[ipCol] || '').trim(),
                     tsCol >= 0 ? DiscordReturnParser.normalizeTs(r[tsCol]) : null,
                     rel,
                     { os: osCol >= 0 ? r[osCol] : '', browser: brCol >= 0 ? r[brCol] : '',
                       location: locCol >= 0 ? r[locCol] : '' });
            }
        }

        return Array.from(agg.values()).sort((a, b) => b.count - a.count);
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
