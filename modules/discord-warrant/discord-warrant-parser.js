/**
 * Discord Warrant Parser
 * Parses Discord law-enforcement warrant return ZIP archives or unzipped folders.
 * Discord serves warrant returns as Discord Data Packages — same format as
 * a user's "Request All My Data" export.  Parser handles both.
 *
 * Runs in Electron main process (Node.js) — uses adm-zip + fs.
 *
 * Discord Data Package layout:
 *   README.txt
 *   Account/
 *     user.json                 — subscriber info (id, email, phone, ip, sessions, ...)
 *     avatar.jpeg               — current avatar
 *     recent_avatars/*.jpeg     — historical avatars
 *     user_data_exports/
 *       discord_billing/{billing_profile,payment_sources,payments,entitlements}.json
 *       discord_harvests/data_subject_access_requests.json
 *       discord_promotions/*.json
 *       discord_store/*.json
 *       discord_virtual_currency/*.json
 *   Messages/
 *     index.json                — { channelId: "name in Server" }
 *     c{channelId}/
 *       channel.json            — { id, type, name, guild: { id, name } }
 *       messages.json           — [ { ID, Timestamp, Contents, Attachments } ]
 *   Servers/
 *     index.json                — { guildId: "ServerName" }
 *     {guildId}/
 *       guild.json              — { id, name }
 *       audit-log.json          — array (often empty)
 *   Activity/
 *     analytics/events-*.json   — JSONL telemetry events
 *     tns/events-*.json         — JSONL Trust&Safety events  (CONTAINS IPs)
 *     reporting/events-*.json   — JSONL reporting events
 *     modeling/events-*.json    — JSONL modeling events
 *
 * Sections wrapped as { section, generated_at, record_count, metadata, records }.
 * Activity files are JSON Lines (one event per line).
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

// IP-bearing event types we surface in IP Activity table.
const IP_EVENT_TYPES = new Set([
    'session_start_success',
    'session_end',
    'app_opened',
    'login_attempted',
    'login_succeeded',
    'login_failed',
    'register',
    'register_succeeded',
    'logout'
]);

class DiscordWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Detect a Discord Data Package ZIP.
     * Heuristic: README.txt mentions "Discord Data Package", OR
     *           Account/user.json + Messages/index.json both present.
     */
    static isDiscordWarrantZip(zipBufferOrPath) {
        try {
            const zip = new AdmZip(zipBufferOrPath);
            const entries = zip.getEntries();
            const names = new Set();
            let readme = null;
            for (const e of entries) {
                names.add(e.entryName.replace(/^\/+/, ''));
                if (!readme && /(^|\/)README\.txt$/i.test(e.entryName)) {
                    try { readme = zip.readAsText(e).slice(0, 800); } catch (_) {}
                }
            }
            if (readme && /Discord Data Package/i.test(readme)) return true;
            if (names.has('Account/user.json') && names.has('Messages/index.json')) return true;
            // Some productions strip README — accept user.json + Activity dir as fallback.
            if (names.has('Account/user.json')) {
                for (const n of names) {
                    if (n.startsWith('Activity/')) return true;
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Detect a Discord Data Package unzipped folder.
     */
    static isDiscordWarrantFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;
            const readmePath = path.join(folderPath, 'README.txt');
            if (fs.existsSync(readmePath)) {
                const head = fs.readFileSync(readmePath, 'utf8').slice(0, 800);
                if (/Discord Data Package/i.test(head)) return true;
            }
            const userJson = path.join(folderPath, 'Account', 'user.json');
            const messagesIndex = path.join(folderPath, 'Messages', 'index.json');
            if (fs.existsSync(userJson) && fs.existsSync(messagesIndex)) return true;
            // Fallback: user.json + Activity dir
            if (fs.existsSync(userJson) && fs.existsSync(path.join(folderPath, 'Activity'))) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    // ─── Public Parse Entry Points ──────────────────────────────────────

    /**
     * Parse a Discord warrant ZIP buffer or path.
     * @param {Buffer|string} zipBufferOrPath
     * @param {Object} options { extractDir, security }
     */
    async parseZip(zipBufferOrPath, options = {}) {
        const zip = new AdmZip(zipBufferOrPath);
        const entries = zip.getEntries();

        // Build a lookup of entry name → adm-zip entry for fast access
        const entryMap = new Map();
        for (const e of entries) entryMap.set(e.entryName.replace(/\\/g, '/'), e);

        return this._parseSources({
            entryNames: Array.from(entryMap.keys()),
            readText: (name) => {
                const e = entryMap.get(name);
                return e ? zip.readAsText(e) : null;
            },
            readBinary: (name) => {
                const e = entryMap.get(name);
                return e ? e.getData() : null;
            },
            options
        });
    }

    /**
     * Parse an unzipped Discord warrant folder on disk.
     */
    async parseFolder(folderPath, options = {}) {
        const allFiles = [];
        const walk = (dir, rel) => {
            let items;
            try { items = fs.readdirSync(dir, { withFileTypes: true }); }
            catch (_) { return; }
            for (const it of items) {
                const full = path.join(dir, it.name);
                const r = rel ? rel + '/' + it.name : it.name;
                if (it.isFile()) allFiles.push(r);
                else if (it.isDirectory()) walk(full, r);
            }
        };
        walk(folderPath, '');

        return this._parseSources({
            entryNames: allFiles,
            readText: (name) => {
                const fp = path.join(folderPath, name);
                if (!fs.existsSync(fp)) return null;
                return fs.readFileSync(fp, 'utf8');
            },
            readBinary: (name) => {
                const fp = path.join(folderPath, name);
                if (!fs.existsSync(fp)) return null;
                return fs.readFileSync(fp);
            },
            options
        });
    }

    // ─── Core parsing ───────────────────────────────────────────────────

    async _parseSources({ entryNames, readText, readBinary, options }) {
        const { extractDir, security } = options || {};

        // 1) Subscriber (Account/user.json)
        const subscriber = this._parseUser(readText('Account/user.json'));

        // 2) Avatars (extract to disk if extractDir provided)
        const contentFiles = {};
        let avatarFile = null;
        const recentAvatarFiles = [];
        if (extractDir) {
            try { fs.mkdirSync(extractDir, { recursive: true }); } catch (_) {}

            const writeContent = (name, buf, kind) => {
                if (!buf) return null;
                const safeName = name.replace(/[\\/]/g, '_');
                const outPath = path.join(extractDir, safeName);
                let toWrite = buf;
                if (security && security.isUnlocked()) {
                    try { toWrite = security.encryptBuffer(buf); } catch (_) {}
                }
                try {
                    fs.writeFileSync(outPath, toWrite);
                    const ext = path.extname(name).toLowerCase();
                    const mimeType = this._mimeFromExt(ext);
                    contentFiles[safeName] = {
                        diskPath: outPath,
                        size: buf.length,
                        mimeType,
                        kind: kind || 'avatar',
                        original: name
                    };
                    return { diskPath: outPath, mimeType, original: name };
                } catch (_) { return null; }
            };

            for (const n of entryNames) {
                const norm = n.replace(/\\/g, '/');
                if (norm === 'Account/avatar.jpeg' || norm === 'Account/avatar.png') {
                    const buf = readBinary(n);
                    const rec = writeContent(path.basename(norm), buf, 'avatar');
                    if (rec) avatarFile = rec;
                } else if (norm.startsWith('Account/recent_avatars/')) {
                    const buf = readBinary(n);
                    const rec = writeContent('recent_' + path.basename(norm), buf, 'avatar');
                    if (rec) recentAvatarFiles.push(rec);
                }
            }
        }

        // 3) Messages
        const messagesIndex = this._parseJson(readText('Messages/index.json')) || {};
        const channels = [];
        // Discover channel folders under Messages/
        const channelIds = new Set();
        for (const n of entryNames) {
            const norm = n.replace(/\\/g, '/');
            const m = norm.match(/^Messages\/c(\d+)\/(channel|messages)\.json$/);
            if (m) channelIds.add(m[1]);
        }
        for (const cid of channelIds) {
            const channelMeta = this._parseJson(readText(`Messages/c${cid}/channel.json`)) || {};
            const msgs = this._parseJson(readText(`Messages/c${cid}/messages.json`)) || [];
            channels.push({
                channelId: channelMeta.id || cid,
                channelName: channelMeta.name || messagesIndex[cid] || `c${cid}`,
                channelType: channelMeta.type || null,
                guildId: channelMeta.guild?.id || null,
                guildName: channelMeta.guild?.name || null,
                indexLabel: messagesIndex[cid] || null,
                recipients: channelMeta.recipients || null,
                messageCount: Array.isArray(msgs) ? msgs.length : 0,
                messages: Array.isArray(msgs) ? msgs.map(m => ({
                    id: m.ID || m.id,
                    timestamp: m.Timestamp || m.timestamp,
                    contents: m.Contents || m.contents || '',
                    attachments: m.Attachments || m.attachments || ''
                })) : []
            });
        }

        // 4) Servers
        const serversIndex = this._parseJson(readText('Servers/index.json')) || {};
        const guildIds = new Set();
        for (const n of entryNames) {
            const norm = n.replace(/\\/g, '/');
            const m = norm.match(/^Servers\/(\d+)\/(guild|audit-log)\.json$/);
            if (m) guildIds.add(m[1]);
        }
        const servers = [];
        for (const gid of guildIds) {
            const guildMeta = this._parseJson(readText(`Servers/${gid}/guild.json`)) || {};
            const auditLog = this._parseJson(readText(`Servers/${gid}/audit-log.json`)) || [];
            servers.push({
                id: guildMeta.id || gid,
                name: guildMeta.name || serversIndex[gid] || `Server ${gid}`,
                auditLog: Array.isArray(auditLog) ? auditLog : []
            });
        }

        // 5) Billing / DSAR / Promotions / Store / VirtualCurrency
        const billing = {
            billingProfile: this._readSectionRecords(readText, 'Account/user_data_exports/discord_billing/billing_profile.json'),
            paymentSources: this._readSectionRecords(readText, 'Account/user_data_exports/discord_billing/payment_sources.json'),
            payments: this._readSectionRecords(readText, 'Account/user_data_exports/discord_billing/payments.json'),
            entitlements: this._readSectionRecords(readText, 'Account/user_data_exports/discord_billing/entitlements.json')
        };
        const dsar = this._readSectionRecords(readText, 'Account/user_data_exports/discord_harvests/data_subject_access_requests.json');
        const promotions = {
            quests: this._readSectionRecords(readText, 'Account/user_data_exports/discord_promotions/quests_reward_codes.json'),
            drops: this._readSectionRecords(readText, 'Account/user_data_exports/discord_promotions/drops_reward_codes.json')
        };
        const store = {
            wishlist: this._readSectionRecords(readText, 'Account/user_data_exports/discord_store/wishlist_items.json')
        };
        const virtualCurrency = {
            accounts: this._readSectionRecords(readText, 'Account/user_data_exports/discord_virtual_currency/coin_accounts.json'),
            transactions: this._readSectionRecords(readText, 'Account/user_data_exports/discord_virtual_currency/coin_transactions.json')
        };

        // 6) Activity (JSONL streamed across all four folders)
        const activity = this._parseActivity({ entryNames, readText });

        // 7) Aggregate IP / device tables from sessions + activity
        const { ipActivity, devices } = this._aggregateIpAndDevices({ subscriber, activity });

        const stats = {
            messageCount: channels.reduce((s, c) => s + c.messageCount, 0),
            channelCount: channels.length,
            serverCount: servers.length,
            sessionCount: subscriber?.sessions?.length || 0,
            ipCount: ipActivity.length,
            deviceCount: devices.length,
            eventCount: activity.totalEventCount,
            mediaCount: Object.keys(contentFiles).length
        };

        return {
            subscriber,
            avatarFile,
            recentAvatarFiles,
            channels,
            servers,
            billing,
            dsar,
            promotions,
            store,
            virtualCurrency,
            activity,
            ipActivity,
            devices,
            contentFiles,
            stats
        };
    }

    // ─── Section parsers ────────────────────────────────────────────────

    /**
     * Discord exports many JSON files wrapped as
     *   { section, generated_at, record_count, metadata, records: [...] }
     * Return the records array, or [] on missing/parse error.
     */
    _readSectionRecords(readText, name) {
        const txt = readText(name);
        if (!txt) return [];
        try {
            const obj = JSON.parse(txt);
            if (Array.isArray(obj)) return obj;
            if (obj && Array.isArray(obj.records)) return obj.records;
            return [];
        } catch (_) { return []; }
    }

    _parseJson(txt) {
        if (!txt) return null;
        try { return JSON.parse(txt); } catch (_) { return null; }
    }

    /**
     * Parse Account/user.json — return a normalized subscriber object.
     */
    _parseUser(txt) {
        const u = this._parseJson(txt);
        if (!u) return null;

        // Strip raw bytes that JSON serializer chokes on (id_hash, cfduid_hash)
        const sessions = (u.user_sessions || []).map(s => {
            const ud = s.user_data || s;
            return {
                ip: ud.client_info?.ip || null,
                os: ud.client_info?.os || null,
                platform: ud.client_info?.platform || null,
                creation_time: ud.creation_time || null,
                expiration_time: ud.expiration_time || null,
                last_used: ud.approx_last_used_time || null,
                is_mfa: !!ud.is_mfa,
                is_bot: !!ud.is_bot,
                binding_token: ud.extra_tokens?.binding_token?.binding_token || null,
                is_soft_deleted: !!s.is_soft_deleted
            };
        });

        return {
            id: u.id || null,
            username: u.username || null,
            discriminator: u.discriminator,
            global_name: u.global_name || null,
            email: u.email || null,
            phone: u.phone || null,
            ip: u.ip || null,
            verified: !!u.verified,
            has_mobile: !!u.has_mobile,
            premium_until: u.premium_until || null,
            avatar_hash: u.avatar_hash || null,
            flags: u.flags || [],
            connections: u.connections || [],
            relationships: u.relationships || [],
            external_friends_lists: u.external_friends_lists || [],
            sessions,
            user_profile_metadata: u.user_profile_metadata || null,
            current_orbs_balance: u.current_orbs_balance || 0
        };
    }

    /**
     * Read JSONL activity files across analytics/tns/reporting/modeling.
     * Track high-value IP-bearing events; aggregate other event_types into counts.
     */
    _parseActivity({ entryNames, readText }) {
        const sessionStarts = [];
        const sessionEnds = [];
        const appOpens = [];
        const logins = [];
        const registers = [];
        const otherImportant = []; // logout, etc.
        const eventCounts = {}; // category/event_type → count
        let totalEventCount = 0;

        const categories = ['analytics', 'tns', 'reporting', 'modeling'];
        const norm = (ts) => {
            if (!ts) return null;
            // Discord wraps timestamps as quoted JSON strings: "\"2026-05-03T19:07:39Z\""
            const s = String(ts).replace(/^"+|"+$/g, '');
            return s === 'null' ? null : s;
        };

        for (const cat of categories) {
            // Find the events file(s) in this category folder
            for (const n of entryNames) {
                const en = n.replace(/\\/g, '/');
                if (!en.startsWith(`Activity/${cat}/`)) continue;
                if (!en.endsWith('.json')) continue;
                const txt = readText(n);
                if (!txt) continue;
                const lines = txt.split(/\r?\n/);
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let ev;
                    try { ev = JSON.parse(line); } catch (_) { continue; }
                    totalEventCount++;
                    const t = ev.event_type || 'unknown';
                    const k = `${cat}/${t}`;
                    eventCounts[k] = (eventCounts[k] || 0) + 1;

                    if (!IP_EVENT_TYPES.has(t)) continue;

                    const row = {
                        category: cat,
                        event_type: t,
                        timestamp: norm(ev.timestamp),
                        client_send_timestamp: norm(ev.client_send_timestamp),
                        ip: ev.ip || null,
                        city: ev.city || null,
                        region_code: ev.region_code || null,
                        country_code: ev.country_code || null,
                        time_zone: ev.time_zone || null,
                        isp: ev.isp || null,
                        browser: ev.browser || null,
                        browser_user_agent: ev.browser_user_agent || null,
                        device: ev.device || null,
                        device_vendor_id: ev.device_vendor_id || null,
                        os: ev.os || null,
                        os_version: ev.os_version || null,
                        client_version: ev.client_version || null,
                        session: ev.session || null,
                        session_type: ev.session_type || null,
                        opened_from: ev.opened_from || null,
                        load_id: ev.load_id || null,
                        user_id: ev.user_id || null,
                        event_id: ev.event_id || null
                    };

                    if (t === 'session_start_success') sessionStarts.push(row);
                    else if (t === 'session_end') sessionEnds.push(row);
                    else if (t === 'app_opened') appOpens.push(row);
                    else if (t.startsWith('login')) logins.push(row);
                    else if (t.startsWith('register')) registers.push(row);
                    else otherImportant.push(row);
                }
            }
        }

        // Sort by timestamp descending (most recent first)
        const sortDesc = (a, b) => {
            const ta = Date.parse(a.timestamp || '') || 0;
            const tb = Date.parse(b.timestamp || '') || 0;
            return tb - ta;
        };
        sessionStarts.sort(sortDesc);
        sessionEnds.sort(sortDesc);
        appOpens.sort(sortDesc);
        logins.sort(sortDesc);
        registers.sort(sortDesc);
        otherImportant.sort(sortDesc);

        return {
            sessionStarts,
            sessionEnds,
            appOpens,
            logins,
            registers,
            otherImportant,
            eventCounts,
            totalEventCount
        };
    }

    /**
     * Roll up IP activity & devices from subscriber.sessions + activity events.
     */
    _aggregateIpAndDevices({ subscriber, activity }) {
        const ipMap = new Map();    // ip → { count, firstSeen, lastSeen, locations:Set, isp, browsers:Set, oses:Set, devices:Set, sources:Set }
        const devMap = new Map();   // device_vendor_id (or device key) → { count, firstSeen, lastSeen, ips:Set, ... }

        const trackIp = (ip, ts, fields, source) => {
            if (!ip) return;
            const t = Date.parse(ts || '') || 0;
            let row = ipMap.get(ip);
            if (!row) {
                row = {
                    ip,
                    count: 0,
                    firstSeen: null, firstSeenT: Number.POSITIVE_INFINITY,
                    lastSeen: null, lastSeenT: 0,
                    locations: new Set(), browsers: new Set(), oses: new Set(),
                    devices: new Set(), isps: new Set(), sources: new Set()
                };
                ipMap.set(ip, row);
            }
            row.count++;
            if (t && t < row.firstSeenT) { row.firstSeenT = t; row.firstSeen = ts; }
            if (t && t > row.lastSeenT) { row.lastSeenT = t; row.lastSeen = ts; }
            if (fields.city || fields.region_code || fields.country_code) {
                row.locations.add([fields.city, fields.region_code, fields.country_code].filter(Boolean).join(', '));
            }
            if (fields.browser) row.browsers.add(fields.browser);
            if (fields.os) row.oses.add(fields.os + (fields.os_version ? ` ${fields.os_version}` : ''));
            if (fields.device) row.devices.add(fields.device);
            if (fields.isp) row.isps.add(fields.isp);
            if (source) row.sources.add(source);
        };

        const trackDevice = (key, ts, fields) => {
            if (!key) return;
            const t = Date.parse(ts || '') || 0;
            let row = devMap.get(key);
            if (!row) {
                row = {
                    key,
                    device_vendor_id: fields.device_vendor_id || null,
                    device: fields.device || null,
                    os: fields.os || null,
                    os_version: fields.os_version || null,
                    browser: fields.browser || null,
                    browser_user_agent: fields.browser_user_agent || null,
                    client_version: fields.client_version || null,
                    count: 0,
                    firstSeen: null, firstSeenT: Number.POSITIVE_INFINITY,
                    lastSeen: null, lastSeenT: 0,
                    ips: new Set()
                };
                devMap.set(key, row);
            }
            row.count++;
            if (t && t < row.firstSeenT) { row.firstSeenT = t; row.firstSeen = ts; }
            if (t && t > row.lastSeenT) { row.lastSeenT = t; row.lastSeen = ts; }
            if (fields.ip) row.ips.add(fields.ip);
            // Promote richer fields if currently null
            for (const f of ['device_vendor_id','device','os','os_version','browser','browser_user_agent','client_version']) {
                if (!row[f] && fields[f]) row[f] = fields[f];
            }
        };

        // From subscriber sessions
        const subSessions = subscriber?.sessions || [];
        for (const s of subSessions) {
            trackIp(s.ip, s.last_used || s.creation_time, { os: s.os, browser: s.platform }, 'user_sessions');
            trackDevice(`${s.os || '?'}|${s.platform || '?'}`, s.last_used || s.creation_time,
                { ip: s.ip, os: s.os, browser: s.platform });
        }
        // From subscriber.ip itself (last known)
        if (subscriber?.ip) {
            trackIp(subscriber.ip, null, {}, 'account');
        }

        // From activity events
        const allEvents = [
            ...(activity?.sessionStarts || []),
            ...(activity?.sessionEnds || []),
            ...(activity?.appOpens || []),
            ...(activity?.logins || []),
            ...(activity?.registers || []),
            ...(activity?.otherImportant || [])
        ];
        for (const ev of allEvents) {
            trackIp(ev.ip, ev.timestamp, ev, ev.event_type);
            const devKey = ev.device_vendor_id || (ev.device ? `${ev.device}|${ev.os}` : (ev.browser ? `${ev.browser}|${ev.os}` : null));
            if (devKey) trackDevice(devKey, ev.timestamp, ev);
        }

        // Materialize sets into arrays + sort
        const finalize = (m) => Array.from(m.values()).map(r => {
            const out = { ...r };
            for (const k of Object.keys(out)) {
                if (out[k] instanceof Set) out[k] = Array.from(out[k]);
            }
            delete out.firstSeenT;
            delete out.lastSeenT;
            return out;
        });

        const ipActivity = finalize(ipMap).sort((a, b) => b.count - a.count);
        const devices = finalize(devMap).sort((a, b) => b.count - a.count);
        return { ipActivity, devices };
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    _mimeFromExt(ext) {
        const map = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
        };
        return map[(ext || '').toLowerCase()] || 'application/octet-stream';
    }
}

module.exports = DiscordWarrantParser;
