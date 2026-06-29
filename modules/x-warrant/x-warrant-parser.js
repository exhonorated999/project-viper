/**
 * X / Twitter Warrant Parser
 * Parses X Corp law-enforcement responsive-data productions (ZIP or unzipped
 * folder). Runs in the Electron main process (Node.js) — uses adm-zip + fs.
 *
 * Production layout (per koebbe14/X-Parser):
 *   README.txt                         — CONTENTS section: "/<file>.txt: <desc>"
 *   {accountId}-{stem}.txt             — one record type per file
 *   {accountId}-{stem}_<kind>_media/   — media folders (<parentId>-<token>.ext)
 *
 * Each .txt body is one of:
 *   - valid JSON (object or array)
 *   - a marker-delimited "X export" blob (window.YTD.<type>.partN = [ ... ]) —
 *     parsed by balanced-brace top-level object extraction
 *   - a PGP cleartext-signed wrapper around one of the above
 *   - an empty responsive body ([])
 *
 * Display buckets produced (consumed by x-warrant-ui.js):
 *   threads  — direct / group messages (conversation view, like Snapchat/Kik)
 *   tweets   — timeline posts
 *   records  — every other stem, flattened to titled tables (README-named,
 *              grouped by category)
 *   users    — resolved user-id ↔ handle directory
 *   mediaFiles — extracted media keyed by filename
 */

const AdmZip = require('adm-zip'); // sync detection callers
const fs = require('fs');
const path = require('path');
const { openZip } = require('../_shared/zip-reader');

const MEDIA_EXTS = new Set([
    '.jpeg', '.jpg', '.png', '.gif', '.webp', '.heic', '.heif', '.svg',
    '.mp4', '.webm', '.mov', '.m4v',
    '.aac', '.m4a', '.mp3', '.wav', '.ogg', '.opus'
]);

// Stems whose bodies are marker-delimited (window.YTD…) → object extraction.
const MARKER_STEMS = new Set([
    'direct-messages', 'deleted-direct-messages',
    'direct-messages-group', 'deleted-direct-messages-group',
    'tweets', 'deleted-tweets', 'tweet-headers', 'deleted-tweet-headers',
]);

// Stems consumed by dedicated views (not shown again as generic Records).
const THREAD_STEMS = new Set([
    'direct-messages', 'deleted-direct-messages',
    'direct-messages-group', 'deleted-direct-messages-group',
]);
const TWEET_STEMS = new Set(['tweets', 'deleted-tweets']);

// Signature stems used to recognise an X production.
const SIGNATURE_STEMS = ['direct-messages', 'direct-messages-group', 'tweets', 'account', 'tweet-headers'];

// Human-readable fallback labels (used when README has no description).
const X_RECORD_LABELS = {
    'account': 'Account',
    'account-creation-ip': 'Account Creation IP',
    'account-label': 'Account Label',
    'account-limited': 'Account (Limited)',
    'account-suspension': 'Account Suspension',
    'account-timezone': 'Account Timezone',
    'ad-engagements': 'Ad Engagements',
    'ad-impressions': 'Ad Impressions',
    'ageinfo': 'Age Information',
    'block': 'Blocked Accounts',
    'community-note': 'Community Notes',
    'connected-application': 'Connected Applications',
    'device-token': 'Device Tokens',
    'devices': 'Devices',
    'direct-messages': 'Direct Messages',
    'direct-messages-group': 'Group Direct Messages',
    'deleted-direct-messages': 'Deleted Direct Messages',
    'deleted-direct-messages-group': 'Deleted Group Direct Messages',
    'deleted-tweets': 'Deleted Tweets',
    'email-address-change': 'Email Address Changes',
    'expanded-profile': 'Expanded Profile',
    'follower': 'Followers',
    'following': 'Following',
    'ip-audit': 'IP Audit',
    'key-registry': 'Key Registry',
    'like': 'Likes',
    'lists-created': 'Lists Created',
    'lists-member': 'List Memberships',
    'lists-subscribed': 'Lists Subscribed',
    'login-ip': 'Login IPs',
    'moment': 'Moments',
    'mute': 'Muted Accounts',
    'periscope-account-information': 'Periscope Account Info',
    'phone-number': 'Phone Numbers',
    'profile': 'Profile',
    'protected-history': 'Protected History',
    'saved-search': 'Saved Searches',
    'screen-name-change': 'Screen Name Changes',
    'spaces-metadata': 'Spaces Metadata',
    'tweet-headers': 'Tweet Headers',
    'tweets': 'Tweets',
    'verified': 'Verified Status',
    'verified-organization': 'Verified Organization',
};

class XWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    static _stemFromName(entryName) {
        const base = path.basename(String(entryName)).toLowerCase();
        if (!base.endsWith('.txt')) return null;
        let stem = base.slice(0, -4);
        const m = stem.match(/^\d+-(.+)$/); // strip {accountId}- prefix
        if (m) stem = m[1];
        return stem;
    }

    static _entriesLookXish(names) {
        let hasReadme = false;
        let sigHits = 0;
        for (const name of names) {
            const lower = String(name).toLowerCase();
            if (lower.startsWith('__macosx')) continue;
            if (/(^|\/)readme\.txt$/.test(lower)) hasReadme = true;
            const stem = XWarrantParser._stemFromName(name);
            if (stem && SIGNATURE_STEMS.includes(stem)) sigHits++;
        }
        // A production needs at least one signature record file. README alone
        // is not enough (avoids false positives on unrelated zips).
        return sigHits > 0 && (hasReadme || sigHits >= 2 || sigHits === 1);
    }

    static isXWarrantZip(input, options) {
        if (typeof input === 'string') return XWarrantParser.isXWarrantZipAsync(input, options);
        try {
            const zip = new AdmZip(input);
            const names = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
            return XWarrantParser._entriesLookXish(names);
        } catch (e) { return false; }
    }

    static async isXWarrantZipAsync(filePath, options = {}) {
        let zip = null;
        try {
            zip = await openZip(filePath, { security: options.security });
            const names = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
            return XWarrantParser._entriesLookXish(names);
        } catch (e) { return false; }
        finally { try { if (zip) zip.close(); } catch (_) {} }
    }

    static isXWarrantFolder(folderPath) {
        try {
            const names = [];
            const walk = (dir, depth) => {
                if (depth > 3) return;
                let items;
                try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const it of items) {
                    const full = path.join(dir, it.name);
                    if (it.isDirectory()) walk(full, depth + 1);
                    else names.push(full);
                }
            };
            walk(folderPath, 0);
            return XWarrantParser._entriesLookXish(names);
        } catch (e) { return false; }
    }

    // ─── Parse entrypoints ──────────────────────────────────────────────

    async parseZip(input, options = {}) {
        const zip = await openZip(input, { security: options.security });
        try {
            const entries = zip.getEntries().filter(e => !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
            const fileMap = {};   // stem -> text
            let readmeText = null;
            const mediaEntries = []; // { name, read() }
            for (const entry of entries) {
                const lower = entry.entryName.toLowerCase();
                if (/(^|\/)readme\.txt$/.test(lower)) { readmeText = zip.readAsText(entry); continue; }
                const ext = path.extname(lower);
                if (ext === '.txt') {
                    const stem = XWarrantParser._stemFromName(entry.entryName);
                    if (stem && !fileMap[stem]) fileMap[stem] = zip.readAsText(entry);
                } else if (MEDIA_EXTS.has(ext)) {
                    mediaEntries.push({ name: path.basename(entry.entryName), entryName: entry.entryName, read: () => entry.getData() });
                }
            }
            return this._buildResult({ fileMap, readmeText, mediaEntries, options });
        } finally { zip.close(); }
    }

    async parseFolder(folderPath, options = {}) {
        const fileMap = {};
        let readmeText = null;
        const mediaEntries = [];
        const walk = (dir, depth) => {
            if (depth > 4) return;
            let items;
            try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const it of items) {
                const full = path.join(dir, it.name);
                if (it.isDirectory()) { walk(full, depth + 1); continue; }
                const lower = it.name.toLowerCase();
                if (lower === 'readme.txt' && readmeText == null) {
                    try { readmeText = fs.readFileSync(full, 'utf-8'); } catch (_) {}
                    continue;
                }
                const ext = path.extname(lower);
                if (ext === '.txt') {
                    const stem = XWarrantParser._stemFromName(it.name);
                    if (stem && !fileMap[stem]) {
                        try { fileMap[stem] = fs.readFileSync(full, 'utf-8'); } catch (_) {}
                    }
                } else if (MEDIA_EXTS.has(ext)) {
                    mediaEntries.push({ name: it.name, entryName: full, read: () => fs.readFileSync(full) });
                }
            }
        };
        walk(folderPath, 0);
        return this._buildResult({ fileMap, readmeText, mediaEntries, options });
    }

    // ─── Core build ─────────────────────────────────────────────────────

    _buildResult({ fileMap, readmeText, mediaEntries, options }) {
        const opts = options || {};
        const catalog = this._parseReadmeCatalog(readmeText || '');

        // Media index: (kind, parentId) -> [filenames]; mediaFiles map.
        const { mediaFiles, mediaByParent } = this._indexMedia(mediaEntries, opts);

        // Account / identity.
        const account = this._parseAccount(fileMap);

        // Threads (DMs + group DMs).
        const threads = this._parseThreads(fileMap, mediaByParent);

        // Tweets.
        const tweets = this._parseTweets(fileMap, mediaByParent);

        // Users directory.
        const users = this._buildUserDirectory(fileMap, account, threads, tweets);

        // Records (every remaining non-empty stem).
        const records = this._buildRecords(fileMap, catalog);

        const result = {
            accountUsername: account.username || null,
            accountUserId: account.userId || null,
            accountEmail: account.email || null,
            accountDisplayName: account.displayName || null,
            caseNumber: this._extractCaseNumber(readmeText, fileMap),
            readmeText: readmeText || null,
            threads,
            tweets,
            records,
            users,
            mediaFiles,
        };
        result.stats = this._computeStats(result);
        return result;
    }

    // ─── README catalog ─────────────────────────────────────────────────

    _parseReadmeCatalog(readmeText) {
        const out = {}; // stem -> description
        if (!readmeText) return out;
        const re = /^\s*\/([^:\n]+):\s*(.+?)\s*$/;
        for (const line of readmeText.split(/\r?\n/)) {
            const m = line.match(re);
            if (!m) continue;
            let fname = m[1].trim();
            const desc = m[2].trim();
            let stem = fname.toLowerCase().endsWith('.txt') ? fname.slice(0, -4) : fname;
            const am = stem.match(/^\d+-(.+)$/);
            if (am) stem = am[1];
            out[stem.toLowerCase()] = desc;
        }
        return out;
    }

    _labelForStem(stem, catalog) {
        const desc = catalog[stem.toLowerCase()];
        if (X_RECORD_LABELS[stem]) return { label: X_RECORD_LABELS[stem], description: desc || '' };
        // Humanize: "screen-name-change" -> "Screen Name Change"
        const label = stem.split(/[-_]/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
        return { label, description: desc || '' };
    }

    _categorizeStem(stem) {
        const s = String(stem).toLowerCase();
        if (/(direct-message|message-event|grok|audio-video-calls)/.test(s)) return 'Communications';
        if (/(tweet|moment|article)/.test(s)) return 'Posts & content';
        if (/(account|profile|verified|ageinfo|screen-name-change|timezone)/.test(s)) return 'Account & profile';
        if (/(follower|following|like|block|mute|lists|saved-search)/.test(s)) return 'Engagement & graph';
        if (s.startsWith('ad-') || s.includes('ads')) return 'Advertising & monetization';
        if (/(catalog|commerce|product|shop|shopify)/.test(s)) return 'Commerce & shops';
        if (s.includes('community-note')) return 'Moderation / community notes';
        if (/(spaces|periscope)/.test(s)) return 'Live & Spaces';
        if (/(ip-audit|device|security|key-registry|login-ip|phone-number|email)/.test(s)) return 'Security & devices';
        return 'Discoverability / misc';
    }

    // ─── Body parsing ───────────────────────────────────────────────────

    _stripPgp(text) {
        if (!text) return '';
        if (text.indexOf('-----BEGIN PGP SIGNED MESSAGE-----') === -1) return text;
        // Body starts after the blank line following the Hash: header block,
        // and ends before the signature block.
        const sigIdx = text.indexOf('-----BEGIN PGP SIGNATURE-----');
        let body = sigIdx >= 0 ? text.slice(0, sigIdx) : text;
        body = body.replace(/^-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?\r?\n\r?\n/, '');
        // PGP dash-escaping: lines beginning with "- " are escaped.
        body = body.replace(/^- /gm, '');
        return body;
    }

    _extractTopLevelJsonObjects(text) {
        const objs = [];
        let inStr = false, esc = false, depth = 0, start = -1;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === '{') { if (depth === 0) start = i; depth++; }
            else if (ch === '}') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && start >= 0) {
                        try { const v = JSON.parse(text.slice(start, i + 1)); if (v && typeof v === 'object') objs.push(v); } catch (_) {}
                        start = -1;
                    }
                }
            }
        }
        return objs;
    }

    _parseBody(text, stem) {
        const body = this._stripPgp(text || '').trim();
        if (!body) return null;
        if (!MARKER_STEMS.has(stem)) {
            try { return JSON.parse(body); } catch (_) { /* fall through */ }
        }
        const objs = this._extractTopLevelJsonObjects(body);
        if (objs.length) return objs;
        try { return JSON.parse(body); } catch (_) { return null; }
    }

    // ─── Date normalization ─────────────────────────────────────────────

    _normalizeXDate(value) {
        if (value == null) return '';
        const s = String(value).trim();
        if (!s) return '';
        let d = null;
        // Twitter classic: "Sun Mar 15 19:57:20 +0000 2026"
        if (/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} [+\-]\d{4} \d{4}$/.test(s)) {
            const t = Date.parse(s.replace(/^([A-Z][a-z]{2}) /, ''));
            if (!isNaN(t)) d = new Date(t);
        }
        if (!d) {
            let ss = s.replace(/Z$/, '+00:00');
            // trim nanoseconds to milliseconds
            ss = ss.replace(/\.(\d{3})\d+/, '.$1');
            const t = Date.parse(ss);
            if (!isNaN(t)) d = new Date(t);
        }
        if (!d) { const t = Date.parse(s); if (!isNaN(t)) d = new Date(t); }
        if (!d) return s;
        return d.toISOString();
    }

    // ─── Threads (DMs) ──────────────────────────────────────────────────

    _parseThreads(fileMap, mediaByParent) {
        const threads = [];
        for (const stem of THREAD_STEMS) {
            if (!fileMap[stem]) continue;
            const data = this._parseBody(fileMap[stem], stem);
            if (!Array.isArray(data)) continue;
            const isGroup = stem.includes('group');
            const deleted = stem.startsWith('deleted');
            for (const item of data) {
                const conv = item && (item.dmConversation || item.dm_conversation);
                if (!conv) continue;
                const convId = conv.conversationId || conv.conversation_id || '';
                const messages = [];
                const participants = new Set();
                for (const mwrap of (conv.messages || [])) {
                    const mc = mwrap && (mwrap.messageCreate || mwrap.message_create);
                    if (!mc) continue;
                    const sid = mc.senderId || mc.sender_id || '';
                    const rid = mc.recipientId || mc.recipient_id || '';
                    if (sid) participants.add(sid);
                    if (rid) participants.add(rid);
                    const mid = mc.id || mc.messageId || '';
                    const media = mediaByParent[mid] ? mediaByParent[mid].slice() : [];
                    const urls = Array.isArray(mc.mediaUrls) ? mc.mediaUrls : (Array.isArray(mc.media_urls) ? mc.media_urls : []);
                    messages.push({
                        message_id: mid,
                        sender_id: sid,
                        recipient_id: rid,
                        text: mc.text != null ? String(mc.text) : '',
                        created_at: this._normalizeXDate(mc.createdAt || mc.created_at),
                        created_at_raw: mc.createdAt || mc.created_at || '',
                        media,
                        media_urls: urls,
                        reactions: Array.isArray(mc.reactions) ? mc.reactions : [],
                        deleted,
                        _raw: mc,
                    });
                }
                messages.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
                threads.push({
                    conversation_id: convId,
                    is_group: isGroup,
                    deleted,
                    participants: Array.from(participants),
                    message_count: messages.length,
                    messages,
                });
            }
        }
        return threads;
    }

    // ─── Tweets ─────────────────────────────────────────────────────────

    _parseTweets(fileMap, mediaByParent) {
        const tweets = [];
        for (const stem of TWEET_STEMS) {
            if (!fileMap[stem]) continue;
            const data = this._parseBody(fileMap[stem], stem);
            if (!Array.isArray(data)) continue;
            const deleted = stem.startsWith('deleted');
            for (const item of data) {
                const t = item && (item.tweet || item.Tweet || item);
                if (!t || typeof t !== 'object') continue;
                const id = t.id_str || t.id || t.tweetId || '';
                const ent = t.entities || {};
                const mediaArr = (ent.media || []).map(m => m.media_url_https || m.media_url || '').filter(Boolean);
                const localMedia = mediaByParent[id] ? mediaByParent[id].slice() : [];
                tweets.push({
                    tweet_id: id,
                    created_at: this._normalizeXDate(t.created_at || t.createdAt),
                    created_at_raw: t.created_at || t.createdAt || '',
                    full_text: t.full_text != null ? String(t.full_text) : (t.text != null ? String(t.text) : ''),
                    lang: t.lang || '',
                    favorite_count: t.favorite_count != null ? t.favorite_count : '',
                    retweet_count: t.retweet_count != null ? t.retweet_count : '',
                    in_reply_to: t.in_reply_to_screen_name || t.in_reply_to_status_id_str || '',
                    is_retweet: !!(t.retweeted || /^RT @/.test(String(t.full_text || t.text || ''))),
                    source: this._stripHtml(t.source || ''),
                    media_urls: mediaArr,
                    media: localMedia,
                    deleted,
                    _raw: t,
                });
            }
        }
        tweets.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
        return tweets;
    }

    _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }

    // ─── Account / Users ────────────────────────────────────────────────

    _parseAccount(fileMap) {
        const out = { username: '', userId: '', email: '', displayName: '' };
        for (const stem of ['account', 'account-limited']) {
            if (!fileMap[stem]) continue;
            const data = this._parseBody(fileMap[stem], stem);
            const arr = Array.isArray(data) ? data : [data];
            for (const item of arr) {
                const a = item && (item.account || item);
                if (!a || typeof a !== 'object') continue;
                out.userId = out.userId || a.accountId || a.account_id || '';
                out.username = out.username || a.username || a.screenName || a.screen_name || '';
                out.email = out.email || a.email || '';
                out.displayName = out.displayName || a.accountDisplayName || a.account_display_name || '';
            }
            if (out.userId || out.username) break;
        }
        return out;
    }

    _buildUserDirectory(fileMap, account, threads, tweets) {
        const byId = {}; // id -> { user_id, handle, display_name, source, confidence }
        const upsert = (id, handle, display, source, conf) => {
            if (!id) return;
            if (!byId[id]) byId[id] = { user_id: id, handle: handle || '', display_name: display || '', source: source || '', confidence: conf || 0, occurrences: 0 };
            const e = byId[id];
            e.occurrences++;
            if (handle && (!e.handle || conf > e.confidence)) { e.handle = handle; e.source = source; e.confidence = conf; }
            if (display && !e.display_name) e.display_name = display;
        };

        if (account.userId) upsert(account.userId, account.username, account.displayName, 'account', 100);

        // screen-name-change → id ↔ handle history
        if (fileMap['screen-name-change']) {
            const data = this._parseBody(fileMap['screen-name-change'], 'screen-name-change');
            for (const item of (Array.isArray(data) ? data : [])) {
                const c = item && (item.screenNameChange || item.screen_name_change || item);
                const id = c && (c.accountId || c.account_id);
                const sn = c && c.screenNameChange && c.screenNameChange.changedScreenName;
                if (id) upsert(id, sn || '', '', 'screen-name-change', 90);
            }
        }

        // followers / following — ids only
        for (const stem of ['follower', 'following']) {
            if (!fileMap[stem]) continue;
            const data = this._parseBody(fileMap[stem], stem);
            for (const item of (Array.isArray(data) ? data : [])) {
                const f = item && (item.follower || item.following || item);
                const id = f && (f.accountId || f.account_id);
                if (id) upsert(id, '', '', stem, 10);
            }
        }

        // DM participants — ids only (handles unknown unless resolved elsewhere)
        for (const th of threads) for (const id of th.participants) upsert(id, '', '', 'direct-messages', 20);

        return Object.values(byId).sort((a, b) => (b.confidence - a.confidence) || (b.occurrences - a.occurrences));
    }

    _extractCaseNumber(readmeText, fileMap) {
        const hay = readmeText || '';
        const m = hay.match(/(?:case|reference|request)\s*(?:number|no\.?|#|id)?[:\s#]*([A-Z0-9][A-Z0-9\-_]{3,})/i);
        return m ? m[1] : null;
    }

    // ─── Records (generic flatten) ──────────────────────────────────────

    _flattenValue(v) {
        if (v == null) return '';
        if (typeof v === 'boolean') return v ? 'Yes' : 'No';
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        if (Array.isArray(v)) {
            if (!v.length) return '';
            if (v.every(x => x == null || typeof x !== 'object')) return v.map(x => (x == null ? '' : String(x))).join('; ');
            return `[${v.length} items]`;
        }
        if (typeof v === 'object') {
            const keys = Object.keys(v);
            if (!keys.length) return '';
            return `{${keys.length} fields}`;
        }
        return String(v);
    }

    _flattenObject(obj, prefix, out) {
        for (const k of Object.keys(obj)) {
            const key = prefix ? `${prefix}.${k}` : k;
            const v = obj[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && Object.keys(v).length <= 12) {
                this._flattenObject(v, key, out);
            } else {
                out[key] = this._flattenValue(v);
            }
        }
    }

    _datasetToRows(data) {
        const rows = [];
        const pushObj = (o) => {
            if (!o || typeof o !== 'object') { rows.push({ value: this._flattenValue(o) }); return; }
            // Unwrap single-key wrapper objects ({ "block": {...} }).
            let target = o;
            const keys = Object.keys(o);
            if (keys.length === 1 && o[keys[0]] && typeof o[keys[0]] === 'object' && !Array.isArray(o[keys[0]])) {
                target = o[keys[0]];
            }
            const flat = {};
            this._flattenObject(target, '', flat);
            rows.push(flat);
        };
        if (Array.isArray(data)) { for (const item of data) pushObj(item); }
        else if (data && typeof data === 'object') {
            // dict → flatten to a single key/value table
            const flat = {};
            this._flattenObject(data, '', flat);
            for (const k of Object.keys(flat)) rows.push({ Field: k, Value: flat[k] });
        }
        return rows;
    }

    _buildRecords(fileMap, catalog) {
        const records = [];
        for (const stem of Object.keys(fileMap)) {
            if (THREAD_STEMS.has(stem) || TWEET_STEMS.has(stem)) continue;
            const data = this._parseBody(fileMap[stem], stem);
            if (data == null) continue;
            const rows = this._datasetToRows(data);
            if (!rows.length) continue;
            // header order = union of keys by first appearance
            const headerSet = [];
            const seen = new Set();
            for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headerSet.push(k); }
            const { label, description } = this._labelForStem(stem, catalog);
            records.push({
                stem,
                label,
                description,
                category: this._categorizeStem(stem),
                headers: headerSet,
                rows,
            });
        }
        records.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
        return records;
    }

    // ─── Media ──────────────────────────────────────────────────────────

    _indexMedia(mediaEntries, opts) {
        const mediaFiles = {};
        const mediaByParent = {}; // parentId -> [filenames]
        let extractDir = null;
        if (opts.extractDir) {
            extractDir = opts.extractDir;
            try { if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true }); } catch (_) {}
        }
        for (const me of (mediaEntries || [])) {
            const fileName = me.name;
            // X media folders: <parentId>-<token>.ext
            const parentId = fileName.includes('-') ? fileName.split('-', 1)[0] : '';
            const info = { mimeType: this._mimeFromExt(path.extname(fileName)), parentId, size: 0 };
            if (extractDir) {
                try {
                    let buf = me.read();
                    info.size = buf.length;
                    if (opts.security && opts.security.isUnlocked && opts.security.isUnlocked()) buf = opts.security.encryptBuffer(buf);
                    const dest = path.join(extractDir, fileName);
                    fs.writeFileSync(dest, buf);
                    info.diskPath = dest;
                } catch (e) { /* skip */ }
            }
            mediaFiles[fileName] = info;
            if (parentId) (mediaByParent[parentId] = mediaByParent[parentId] || []).push(fileName);
        }
        return { mediaFiles, mediaByParent };
    }

    _mimeFromExt(ext) {
        const e = String(ext).toLowerCase();
        const map = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
            '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
            '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
        };
        return map[e] || 'application/octet-stream';
    }

    // ─── Stats ──────────────────────────────────────────────────────────

    _computeStats(r) {
        let messageCount = 0;
        for (const th of r.threads) messageCount += th.messages.length;
        return {
            threadCount: r.threads.length,
            messageCount,
            tweetCount: r.tweets.length,
            recordTypeCount: r.records.length,
            recordRowCount: r.records.reduce((a, x) => a + x.rows.length, 0),
            userCount: r.users.length,
            mediaCount: Object.keys(r.mediaFiles).length,
        };
    }
}

module.exports = XWarrantParser;
