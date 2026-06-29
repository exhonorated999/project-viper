/**
 * KIK Warrant Parser
 * Parses KIK Messenger law enforcement warrant return ZIP archives.
 * Runs in Electron main process (Node.js) — uses adm-zip.
 *
 * KIK productions contain:
 *   Outer ZIP → KIK-{caseNum}-completed-documents/
 *     Inner ZIP → {username}_case{num}.zip
 *       {username}/logs/  — TAB-delimited text files (no headers)
 *         bind.txt, chat_sent.txt, chat_sent_received.txt,
 *         chat_platform_sent.txt, chat_platform_sent_received.txt,
 *         friend_added.txt, group_send_msg.txt, group_receive_msg.txt,
 *         group_send_msg_platform.txt, group_receive_msg_platform.txt,
 *         block_user.txt, CoA *.pdf, Subscriber-data-*.pdf
 *
 * All TSV files: no headers, TAB-delimited, 13-digit ms timestamps.
 */

const AdmZip = require('adm-zip'); // retained for back-compat with sync detection callers
const path = require('path');
const fs = require('fs');
const { openZip } = require('../_shared/zip-reader');

// When an inner KIK case ZIP is larger than this, extract it to a temp file
// and re-open with the streaming reader instead of loading into a Buffer.
const INNER_ZIP_BUFFER_LIMIT = 256 * 1024 * 1024; // 256 MiB

class KikWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Check if a ZIP is a KIK warrant production.
     * Looks for nested ZIP structure with logs/ directory containing
     * characteristic KIK TSV files.
     *
     * Accepts a Buffer OR a file path (path preferred for files > 2 GB —
     * returns a Promise in that case). Backward-compatible with Buffer callers.
     */
    static isKikWarrantZip(zipBufferOrPath, options) {
        if (typeof zipBufferOrPath === 'string') {
            return KikWarrantParser.isKikWarrantZipAsync(zipBufferOrPath, options);
        }
        try {
            const zip = new AdmZip(zipBufferOrPath);
            const entries = zip.getEntries();

            // Check for direct logs/ with KIK files (already-extracted inner ZIP)
            let hasKikLogs = false;
            let hasInnerZip = false;

            for (const entry of entries) {
                const name = entry.entryName.toLowerCase();
                // Direct KIK log files
                if (name.endsWith('/logs/bind.txt') || name.endsWith('/logs/chat_sent.txt') ||
                    name.endsWith('/logs/friend_added.txt')) {
                    hasKikLogs = true;
                }
                // Inner ZIP matching KIK pattern: *_case*.zip
                if (!entry.isDirectory && name.endsWith('.zip') && /_case\d+/i.test(name)) {
                    hasInnerZip = true;
                }
            }

            if (hasKikLogs) return true;
            // Older (legacy) KIK return: messages live in content/text-msg-data/*.csv
            if (KikWarrantParser._hasOlderCsvSignature(entries)) return true;
            // New records format: content/data-text.csv | content/data-media.csv
            if (KikWarrantParser._hasNewRecordsSignature(entries)) return true;

            // Try opening inner ZIP to check for KIK logs
            if (hasInnerZip) {
                for (const entry of entries) {
                    if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith('.zip')) continue;
                    if (!/_case\d+/i.test(entry.entryName)) continue;
                    try {
                        const innerBuf = entry.getData();
                        const innerZip = new AdmZip(innerBuf);
                        for (const ie of innerZip.getEntries()) {
                            const iname = ie.entryName.toLowerCase();
                            if (iname.endsWith('/logs/bind.txt') || iname.endsWith('/logs/chat_sent.txt') ||
                                iname.endsWith('/logs/friend_added.txt')) {
                                return true;
                            }
                        }
                        if (KikWarrantParser._hasOlderCsvSignature(innerZip.getEntries())) return true;
                        if (KikWarrantParser._hasNewRecordsSignature(innerZip.getEntries())) return true;
                    } catch (e) { /* not a valid zip, skip */ }
                }
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Async variant — opens the warrant ZIP via the streaming reader
     * (file-handle backed, ZIP64 capable). Required for warrant returns
     * larger than 2 GB which would overflow Node's Buffer limit.
     */
    static async isKikWarrantZipAsync(filePath, options = {}) {
        let zip = null;
        let innerZip = null;
        let innerTempPath = null;
        try {
            zip = await openZip(filePath, { security: options.security });
            const entries = zip.getEntries();

            let hasKikLogs = false;
            let innerZipEntry = null;
            for (const entry of entries) {
                const name = entry.entryName.toLowerCase();
                if (name.endsWith('/logs/bind.txt') || name.endsWith('/logs/chat_sent.txt') ||
                    name.endsWith('/logs/friend_added.txt')) {
                    hasKikLogs = true;
                }
                if (!innerZipEntry && !entry.isDirectory && name.endsWith('.zip') && /_case\d+/i.test(name)) {
                    innerZipEntry = entry;
                }
            }
            if (hasKikLogs) return true;
            // Older (legacy) KIK return: messages in content/text-msg-data/*.csv
            if (KikWarrantParser._hasOlderCsvSignature(entries)) return true;
            // New records format: content/data-text.csv | content/data-media.csv
            if (KikWarrantParser._hasNewRecordsSignature(entries)) return true;
            if (!innerZipEntry) return false;

            // Open inner case ZIP — buffer if small, temp-extract if huge.
            try {
                if ((innerZipEntry.size || 0) > INNER_ZIP_BUFFER_LIMIT) {
                    innerTempPath = await zip.extractEntryToTemp(innerZipEntry, '.zip');
                    innerZip = await openZip(innerTempPath, {});
                } else {
                    innerZip = await openZip(innerZipEntry.getData(), {});
                }
                for (const ie of innerZip.getEntries()) {
                    const iname = ie.entryName.toLowerCase();
                    if (iname.endsWith('/logs/bind.txt') || iname.endsWith('/logs/chat_sent.txt') ||
                        iname.endsWith('/logs/friend_added.txt')) {
                        return true;
                    }
                }
                if (KikWarrantParser._hasOlderCsvSignature(innerZip.getEntries())) return true;
                if (KikWarrantParser._hasNewRecordsSignature(innerZip.getEntries())) return true;
            } catch (_) { /* not a valid inner zip */ }

            return false;
        } catch (e) {
            return false;
        } finally {
            try { if (innerZip) innerZip.close(); } catch (_) {}
            try { if (innerTempPath) fs.unlinkSync(innerTempPath); } catch (_) {}
            try { if (zip) zip.close(); } catch (_) {}
        }
    }

    /**
     * Older/legacy KIK return signature: a CSV message store under a
     * `text-msg-data/` directory (e.g. content/text-msg-data/file_1.csv).
     * These pre-date the modern logs/*.txt TSV layout and carry the actual
     * message bodies rather than per-conversation counts.
     */
    static _hasOlderCsvSignature(entries) {
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = entry.entryName.toLowerCase();
            if (name.startsWith('__macosx')) continue;
            if (/(^|\/)text-msg-data\/[^/]+\.csv$/.test(name)) return true;
        }
        return false;
    }

    /**
     * NEW Kik records format signature: consolidated message stores
     * `content/data-text.csv` and/or `content/data-media.csv`. This layout
     * (introduced in recent Kik warrant returns) carries the ACTUAL message
     * text/media in two top-level CSVs plus CSV transmission logs in logs/,
     * rather than per-conversation `text-msg-data/*.csv` (older) or the
     * counts-only `logs/*.txt` TSV (modern). Detected independently so both
     * auto-scan and import route here.
     */
    static _hasNewRecordsSignature(entries) {
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = entry.entryName.toLowerCase();
            if (name.startsWith('__macosx')) continue;
            if (/(^|\/)content\/data-(text|media)\.csv$/.test(name)) return true;
        }
        return false;
    }

    // ─── Main Parse ─────────────────────────────────────────────────────

    /**
     * Parse a KIK warrant ZIP file.
     * Handles nested ZIP-of-ZIP structure.
     * @param {Buffer|string} input  Buffer OR ZIP file path (preferred for files > 2 GB)
     * @param {Object} opts — optional { extractDir, security } to extract
     *   content files to disk in the same pass (avoids re-reading ZIP)
     * @returns {Object} parsed data
     */
    async parseZip(input, opts = {}) {
        const zip = await openZip(input, { security: opts.security });
        let innerZip = null;
        let innerTempPath = null;
        try {
            return await this._parseFromZip(zip, opts, (z, t) => { innerZip = z; innerTempPath = t; });
        } finally {
            try { if (innerZip) innerZip.close(); } catch (_) {}
            try { if (innerTempPath) fs.unlinkSync(innerTempPath); } catch (_) {}
            try { zip.close(); } catch (_) {}
        }
    }

    async _parseFromZip(zip, opts, registerInner) {
        let entries = zip.getEntries();
        // The reader currently in scope when we read entries (logs / content).
        // Starts as the outer reader; swapped to innerZip if KIK nested structure detected.
        let activeZip = zip;
        let contentSourceEntries = null; // entries that contain content/ files
        let contentSourceZip = null;     // reader to use when reading content bytes

        // Check if we need to unwrap an inner ZIP
        let logsPrefix = this._findLogsPrefix(entries);

        if (!logsPrefix) {
            // Look for inner ZIP (KIK nested structure)
            const innerZipEntry = this._findInnerZip(entries);
            if (innerZipEntry) {
                const inner = await this._openInnerZip(zip, innerZipEntry);
                registerInner(inner.zip, inner.tempPath);
                activeZip = inner.zip;
                entries = activeZip.getEntries();
                contentSourceEntries = entries; // content is in inner ZIP
                contentSourceZip = activeZip;
                logsPrefix = this._findLogsPrefix(entries);
            }
        } else {
            // Logs found directly — check if content/ exists at sibling path
            const testContentPrefix = logsPrefix.replace(/logs\/$/, 'content/');
            const hasDirectContent = entries.some(e =>
                !e.isDirectory && !e.entryName.startsWith('__MACOSX') &&
                e.entryName.startsWith(testContentPrefix));

            if (hasDirectContent) {
                contentSourceEntries = entries;
                contentSourceZip = activeZip;
            } else {
                // Content only in inner ZIP — open it now (single read)
                const innerZipEntry = this._findInnerZip(zip.getEntries());
                if (innerZipEntry) {
                    try {
                        const inner = await this._openInnerZip(zip, innerZipEntry);
                        registerInner(inner.zip, inner.tempPath);
                        contentSourceEntries = inner.zip.getEntries();
                        contentSourceZip = inner.zip;
                    } catch (e) { /* ignore */ }
                }
            }
        }

        // New records format takes PRECEDENCE: its consolidated
        // content/data-text.csv + data-media.csv carry the actual message
        // bodies, whereas modern logs/*.txt (if also present) hold only
        // per-conversation counts. Route here whenever the signature is found
        // in either the primary entries or the content-source (inner) ZIP.
        if (KikWarrantParser._hasNewRecordsSignature(entries)) {
            return await this._parseNewRecordsFormat(entries, activeZip, opts);
        }
        if (contentSourceEntries && contentSourceEntries !== entries &&
            KikWarrantParser._hasNewRecordsSignature(contentSourceEntries)) {
            return await this._parseNewRecordsFormat(contentSourceEntries, contentSourceZip, opts);
        }

        if (!logsPrefix) {
            // No modern logs/*.txt layout. Fall back to the older/legacy KIK
            // format: messages in content/text-msg-data/*.csv, media in
            // content/, miscellaneous logs in logs/*.txt.
            if (KikWarrantParser._hasOlderCsvSignature(entries)) {
                return await this._parseOlderFormat(entries, activeZip, opts);
            }
            // New records format: content/data-text.csv + content/data-media.csv
            // + CSV transmission logs in logs/ + media in medias/.
            if (KikWarrantParser._hasNewRecordsSignature(entries)) {
                return await this._parseNewRecordsFormat(entries, activeZip, opts);
            }
            throw new Error('Could not find KIK logs directory in ZIP');
        }

        // Extract account username from path
        const pathParts = logsPrefix.replace(/\/$/, '').split('/');
        const logsIdx = pathParts.lastIndexOf('logs');
        const accountUsername = logsIdx > 0 ? pathParts[logsIdx - 1] : 'unknown';

        // Extract case number from ZIP entry names
        let caseNumber = null;
        for (const entry of entries) {
            const match = entry.entryName.match(/_case(\d+)/i);
            if (match) { caseNumber = match[1]; break; }
        }

        // Build file map for logs
        const fileMap = {};
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            if (entry.entryName.startsWith(logsPrefix)) {
                const fileName = entry.entryName.substring(logsPrefix.length);
                if (fileName && !fileName.includes('/')) {
                    fileMap[fileName.toLowerCase()] = entry;
                }
            }
        }

        // Find content/ directory (media files)
        // Determine the correct content prefix from the content source entries
        const contentFiles = {};
        if (contentSourceEntries) {
            const csLogsPrefix = this._findLogsPrefix(contentSourceEntries) || logsPrefix;
            const contentPrefix = csLogsPrefix.replace(/logs\/$/, 'content/');

            // Set up extraction directory if requested
            let extractDir = null;
            if (opts.extractDir) {
                extractDir = opts.extractDir;
                if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
            }

            for (const entry of contentSourceEntries) {
                if (entry.isDirectory) continue;
                if (entry.entryName.startsWith('__MACOSX')) continue;
                if (!entry.entryName.startsWith(contentPrefix)) continue;

                const fileName = entry.entryName.substring(contentPrefix.length);
                if (!fileName || fileName.includes('/')) continue;

                // Detect mime type
                let mimeType = this._detectMimeType(fileName, entry);

                const entrySize = (entry.size != null)
                    ? entry.size
                    : (entry.header && entry.header.size) || 0;
                const info = { size: entrySize, mimeType };

                // Extract to disk in the same pass if extractDir provided
                if (extractDir) {
                    try {
                        const destPath = path.join(extractDir, fileName);
                        if (opts.security && opts.security.isUnlocked()) {
                            // Encrypted output requires the full buffer in memory
                            // (security helper encrypts a Buffer in one shot).
                            const buf = entry.getData();
                            fs.writeFileSync(destPath, opts.security.encryptBuffer(buf));
                        } else if (entrySize > INNER_ZIP_BUFFER_LIMIT && contentSourceZip && contentSourceZip.extractEntryToFile) {
                            // Stream very large media direct to disk — no Buffer round-trip.
                            await contentSourceZip.extractEntryToFile(entry, destPath);
                        } else {
                            const buf = entry.getData();
                            fs.writeFileSync(destPath, buf);
                        }
                        info.diskPath = destPath;
                    } catch (e) {
                        console.error(`Failed to extract content file ${fileName}:`, e.message);
                    }
                }

                contentFiles[fileName] = info;
            }
        }

        // Parse each log file
        const readText = (name) => {
            const entry = fileMap[name];
            if (!entry) return '';
            try { return entry.getData().toString('utf-8'); } catch (e) { return ''; }
        };

        const result = {
            accountUsername,
            caseNumber,
            contentFiles,
            binds: this._parseBind(readText('bind.txt')),
            friends: this._parseFriendAdded(readText('friend_added.txt')),
            blockedUsers: this._parseBlockUser(readText('block_user.txt')),
            chatSent: this._parseChatSent(readText('chat_sent.txt')),
            chatSentReceived: this._parseChatSentReceived(readText('chat_sent_received.txt')),
            chatPlatformSent: this._parseChatPlatformSent(readText('chat_platform_sent.txt')),
            chatPlatformSentReceived: this._parseChatPlatformSentReceived(readText('chat_platform_sent_received.txt')),
            groupSendMsg: this._parseGroupSendMsg(readText('group_send_msg.txt')),
            groupReceiveMsg: this._parseGroupReceiveMsg(readText('group_receive_msg.txt')),
            groupSendMsgPlatform: this._parseGroupSendMsgPlatform(readText('group_send_msg_platform.txt')),
            groupReceiveMsgPlatform: this._parseGroupReceiveMsgPlatform(readText('group_receive_msg_platform.txt')),
        };

        result.stats = this._computeStats(result);
        return result;
    }

    // ─── Older / legacy KIK format ──────────────────────────────────────

    /**
     * Parse the older KIK return layout where conversations are stored as a
     * CSV (content/text-msg-data/*.csv) carrying actual message bodies, media
     * lives in content/, and assorted logs live in logs/*.txt.
     *
     * Produces the SAME result shape as the modern parser so the existing UI
     * works unchanged — DM rows are mapped into chatSent / chatSentReceived,
     * with an extra `text` field holding the real message body. Raw log files
     * are surfaced under result.rawLogs.
     */
    async _parseOlderFormat(entries, activeZip, opts) {
        const usable = entries.filter(e =>
            !e.isDirectory && !e.entryName.startsWith('__MACOSX'));

        // ── Locate CSV message store(s) under text-msg-data/ ──
        const csvEntries = usable.filter(e =>
            /(^|\/)text-msg-data\/[^/]+\.csv$/i.test(e.entryName));

        // ── Derive the content/ prefix (path up to and including 'content/') ──
        let contentPrefix = '';
        if (csvEntries.length) {
            const m = csvEntries[0].entryName.match(/^(.*?)text-msg-data\//i);
            if (m) contentPrefix = m[1];
        }
        if (!contentPrefix) {
            for (const e of usable) {
                const mm = e.entryName.match(/^(.*?content\/)/i);
                if (mm) { contentPrefix = mm[1]; break; }
            }
        }

        // ── Parse messages from every CSV ──
        let messages = [];
        for (const ce of csvEntries) {
            let buf = null;
            try { buf = ce.getData(); } catch (_) { buf = null; }
            if (!buf) continue;
            messages = messages.concat(this._parseOlderCsvMessages(buf.toString('utf-8')));
        }

        // ── Derive account JID (most frequent across sender + receiver) ──
        const freq = {};
        for (const m of messages) {
            if (m.senderJid)   freq[m.senderJid]   = (freq[m.senderJid]   || 0) + 1;
            if (m.receiverJid) freq[m.receiverJid] = (freq[m.receiverJid] || 0) + 1;
        }
        let accountJid = '';
        let best = -1;
        for (const [jid, n] of Object.entries(freq)) {
            if (n > best) { best = n; accountJid = jid; }
        }
        const accountUsername = this._jidLocal(accountJid) || 'unknown';

        // ── Map messages → chatSent / chatSentReceived (with real text) ──
        const chatSent = [];
        const chatSentReceived = [];
        for (const m of messages) {
            const row = {
                timestamp: m.timestamp,
                sender: this._jidLocal(m.senderJid),
                recipient: this._jidLocal(m.receiverJid),
                msgCount: 1,
                ip: m.ip || '',
                datetime: m.datetime,
                text: m.text,
                chatType: m.chatType,
                msgId: m.msgId,
            };
            if (m.senderJid && m.senderJid === accountJid) chatSent.push(row);
            else chatSentReceived.push(row);
        }

        // ── Extract media (direct children of content/) ──
        const contentFiles = {};
        let extractDir = null;
        if (opts.extractDir) {
            extractDir = opts.extractDir;
            if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        }
        if (contentPrefix) {
            for (const entry of usable) {
                if (!entry.entryName.startsWith(contentPrefix)) continue;
                const rel = entry.entryName.substring(contentPrefix.length);
                if (!rel || rel.includes('/')) continue; // only direct children of content/
                const mimeType = this._detectMimeType(rel, entry);
                const entrySize = (entry.size != null)
                    ? entry.size
                    : ((entry.header && entry.header.size) || 0);
                const info = { size: entrySize, mimeType };
                if (extractDir) {
                    try {
                        const destPath = path.join(extractDir, rel);
                        const buf = entry.getData();
                        if (opts.security && opts.security.isUnlocked()) {
                            fs.writeFileSync(destPath, opts.security.encryptBuffer(buf));
                        } else {
                            fs.writeFileSync(destPath, buf);
                        }
                        info.diskPath = destPath;
                    } catch (e) {
                        console.error(`Failed to extract KIK content file ${rel}:`, e.message);
                    }
                }
                contentFiles[rel] = info;
            }
        }

        // ── Surface logs/*.txt as raw text (skip empties) ──
        const rawLogs = [];
        for (const entry of usable) {
            if (!/(^|\/)logs\/[^/]+\.txt$/i.test(entry.entryName)) continue;
            let text = '';
            try { text = entry.getData().toString('utf-8'); } catch (_) {}
            if (!text.trim()) continue;
            rawLogs.push({ name: entry.entryName.split('/').pop(), text });
        }

        // ── Case number, if encoded in any path ──
        let caseNumber = null;
        for (const entry of usable) {
            const mm = entry.entryName.match(/_case(\d+)/i);
            if (mm) { caseNumber = mm[1]; break; }
        }

        const result = {
            accountUsername,
            caseNumber,
            legacyFormat: true,
            contentFiles,
            rawLogs,
            binds: [],
            friends: [],
            blockedUsers: [],
            chatSent,
            chatSentReceived,
            chatPlatformSent: [],
            chatPlatformSentReceived: [],
            groupSendMsg: [],
            groupReceiveMsg: [],
            groupSendMsgPlatform: [],
            groupReceiveMsgPlatform: [],
        };
        result.stats = this._computeStats(result);
        return result;
    }

    /**
     * Parse the NEW Kik records format. Layout:
     *   content/data-text.csv   — text messages (actual bodies)
     *   content/data-media.csv  — media messages (+ filename → medias/)
     *   logs/*.csv              — transmission metadata (IP/timestamp by content_id)
     *   medias/                 — media files
     *
     * Columns are normalized defensively (Kik has shipped two header variants):
     *   id|msg_id, message|msg, sender_id|sender_jid, receiver_id|receiver_jid,
     *   sent_at_ts(ms)|sent_at, content_id|cid, filename, group_jid, app_name, ip.
     *
     * Produces the SAME result shape as the modern/older parsers so the UI works
     * unchanged: text rows → chatSent/chatSentReceived (DM) or groupSendMsg/
     * groupReceiveMsg (group, when group_jid present); media rows → the
     * corresponding *Platform arrays. Direction is by account JID (most frequent
     * across sender+receiver), matching the older-format heuristic.
     */
    async _parseNewRecordsFormat(entries, activeZip, opts) {
        const usable = entries.filter(e =>
            !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
        const readEntry = (entry) => {
            if (!entry) return '';
            try { return entry.getData().toString('utf-8'); } catch (_) { return ''; }
        };

        // ── Locate the two consolidated content CSVs ──
        const textEntry  = usable.find(e => /(^|\/)content\/data-text\.csv$/i.test(e.entryName));
        const mediaEntry = usable.find(e => /(^|\/)content\/data-media\.csv$/i.test(e.entryName));

        // ── Parse message rows from each content CSV ──
        const textRecs  = this._parseNewFormatContentCsv(readEntry(textEntry), false);
        const mediaRecs = this._parseNewFormatContentCsv(readEntry(mediaEntry), true);
        const allRecs   = textRecs.concat(mediaRecs);

        // ── CSV transmission logs → content_id → {ip, ts} enrichment ──
        const logEntries = usable.filter(e => /(^|\/)logs\/[^/]+\.csv$/i.test(e.entryName));
        const logByCid = {};
        for (const le of logEntries) {
            const recs = this._parseNewFormatLogCsv(readEntry(le));
            for (const lg of recs) {
                if (lg.contentId && !logByCid[lg.contentId]) logByCid[lg.contentId] = lg;
            }
        }
        for (const m of allRecs) {
            const lg = m.contentId ? logByCid[m.contentId] : null;
            if (!lg) continue;
            if (!m.ip && lg.ip) m.ip = lg.ip;
            if (!m.groupJid && lg.groupJid) m.groupJid = lg.groupJid;
            if (!m.timestamp && lg.timestamp) {
                m.timestamp = lg.timestamp;
                m.datetime = lg.timestamp
                    ? new Date(lg.timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
                    : m.datetime;
            }
        }

        // ── Account JID = most frequent across sender + receiver ──
        const freq = {};
        for (const m of allRecs) {
            if (m.senderJid)   freq[m.senderJid]   = (freq[m.senderJid]   || 0) + 1;
            if (m.receiverJid) freq[m.receiverJid] = (freq[m.receiverJid] || 0) + 1;
        }
        let accountJid = ''; let best = -1;
        for (const [jid, n] of Object.entries(freq)) { if (n > best) { best = n; accountJid = jid; } }
        const accountUsername = this._jidLocal(accountJid) || 'unknown';

        // ── Route messages into the standard arrays ──
        const chatSent = [], chatSentReceived = [];
        const chatPlatformSent = [], chatPlatformSentReceived = [];
        const groupSendMsg = [], groupReceiveMsg = [];
        const groupSendMsgPlatform = [], groupReceiveMsgPlatform = [];
        for (const m of allRecs) {
            const isOut = m.senderJid && m.senderJid === accountJid;
            const inGroup = !!m.groupJid;
            const row = {
                timestamp: m.timestamp,
                sender: this._jidLocal(m.senderJid),
                recipient: this._jidLocal(m.receiverJid),
                ip: m.ip || '',
                datetime: m.datetime,
                text: m.text,
                msgId: m.msgId,
                contentId: m.contentId,
            };
            if (inGroup) row.groupId = this._jidLocal(m.groupJid);
            if (m.isMedia) {
                row.mediaType = m.appName || 'media';
                row.mediaUuid = m.contentId || '';
                if (inGroup) (isOut ? groupSendMsgPlatform : groupReceiveMsgPlatform).push(row);
                else (isOut ? chatPlatformSent : chatPlatformSentReceived).push(row);
            } else {
                row.msgCount = 1;
                if (inGroup) (isOut ? groupSendMsg : groupReceiveMsg).push(row);
                else (isOut ? chatSent : chatSentReceived).push(row);
            }
        }

        // ── Resolve media files from medias/ (under content or root) ──
        // Keyed by content_id (== mediaUuid the UI looks up) AND by filename.
        const contentFiles = {};
        let extractDir = null;
        if (opts.extractDir) {
            extractDir = opts.extractDir;
            if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        }
        const fileToCid = {};
        for (const m of mediaRecs) { if (m.filename && m.contentId) fileToCid[m.filename] = m.contentId; }
        for (const entry of usable) {
            const mm = entry.entryName.match(/(^|\/)medias\/(.+)$/i);
            if (!mm) continue;
            const rel = mm[2];
            if (!rel || rel.includes('/')) continue; // direct children only
            const cid = fileToCid[rel] || path.parse(rel).name;
            const mimeType = this._detectMimeType(rel, entry);
            const entrySize = (entry.size != null)
                ? entry.size
                : ((entry.header && entry.header.size) || 0);
            const info = { size: entrySize, mimeType, filename: rel };
            if (extractDir) {
                try {
                    const destPath = path.join(extractDir, rel);
                    const buf = entry.getData();
                    if (opts.security && opts.security.isUnlocked()) {
                        fs.writeFileSync(destPath, opts.security.encryptBuffer(buf));
                    } else {
                        fs.writeFileSync(destPath, buf);
                    }
                    info.diskPath = destPath;
                } catch (e) {
                    console.error(`Failed to extract KIK media ${rel}:`, e.message);
                }
            }
            if (cid) contentFiles[cid] = info;
            contentFiles[rel] = info;
        }

        // ── Surface any logs/*.txt as raw text (skip empties) ──
        const rawLogs = [];
        for (const entry of usable) {
            if (!/(^|\/)logs\/[^/]+\.txt$/i.test(entry.entryName)) continue;
            let t = '';
            try { t = entry.getData().toString('utf-8'); } catch (_) {}
            if (!t.trim()) continue;
            rawLogs.push({ name: entry.entryName.split('/').pop(), text: t });
        }

        // ── Case number, if encoded in any path ──
        let caseNumber = null;
        for (const entry of usable) {
            const mm = entry.entryName.match(/_case(\d+)/i);
            if (mm) { caseNumber = mm[1]; break; }
        }

        const result = {
            accountUsername,
            caseNumber,
            newRecordsFormat: true,
            contentFiles,
            rawLogs,
            binds: [],
            friends: [],
            blockedUsers: [],
            chatSent,
            chatSentReceived,
            chatPlatformSent,
            chatPlatformSentReceived,
            groupSendMsg,
            groupReceiveMsg,
            groupSendMsgPlatform,
            groupReceiveMsgPlatform,
        };
        result.stats = this._computeStats(result);
        return result;
    }

    /**
     * Parse one new-format content CSV (data-text.csv or data-media.csv).
     * Defensive column resolution covers both Kik header variants.
     */
    _parseNewFormatContentCsv(text, isMedia) {
        if (!text || !text.trim()) return [];
        const records = this._csvRecords(text);
        if (records.length < 2) return [];
        const header = records[0].map(h => String(h).trim().toLowerCase());
        const idx = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
        const iId   = idx(['msg_id', 'id', 'message_id']);
        const iS    = idx(['sender_jid', 'sender_id', 'sender', 'from_jid', 'from']);
        const iR    = idx(['receiver_jid', 'receiver_id', 'receiver', 'to_jid', 'to']);
        const iMsg  = idx(['msg', 'message', 'body', 'text']);
        const iCid  = idx(['content_id', 'cid']);
        const iFile = idx(['filename', 'file_name', 'file']);
        const iGrp  = idx(['group_jid', 'group_id', 'groupjid']);
        const iApp  = idx(['app_name', 'app', 'media_type', 'content_type']);
        const iIp   = idx(['ip', 'sender_ip', 'user_ip']);
        const iPort = idx(['port']);
        const iTsMs = idx(['sent_at_ts', 'timestamp_ms', 'ts_ms']);
        const iTs   = idx(['sent_at', 'ts', 'timestamp', 'datetime']);
        const get = (f, i) => (i >= 0 && f[i] != null) ? String(f[i]) : '';
        const out = [];
        for (let r = 1; r < records.length; r++) {
            const f = records[r];
            if (!f || (f.length === 1 && !String(f[0]).trim())) continue;
            let ts = 0, rawTs = '';
            if (iTsMs >= 0 && String(f[iTsMs] || '').trim()) { rawTs = String(f[iTsMs]).trim(); ts = this._normalizeTs(rawTs); }
            else if (iTs >= 0) { rawTs = String(f[iTs] || '').trim(); ts = this._normalizeTs(rawTs); }
            out.push({
                msgId:       get(f, iId).trim(),
                senderJid:   get(f, iS).trim(),
                receiverJid: get(f, iR).trim(),
                text:        get(f, iMsg),
                contentId:   get(f, iCid).trim(),
                filename:    get(f, iFile).trim(),
                groupJid:    get(f, iGrp).trim(),
                appName:     get(f, iApp).trim(),
                ip:          get(f, iIp).trim(),
                port:        get(f, iPort).trim(),
                timestamp:   ts,
                datetime:    ts ? new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : rawTs,
                isMedia:     !!isMedia,
            });
        }
        return out;
    }

    /**
     * Parse a new-format CSV transmission log (chat_platform_sent.csv,
     * chat_platform_sent_received.csv, group_send_msg_platform.csv,
     * group_receive.csv, group_receive_msg_platform.csv). Pulls the fields we
     * use to enrich content rows by content_id (IP, timestamp, parties, group).
     */
    _parseNewFormatLogCsv(text) {
        if (!text || !text.trim()) return [];
        const records = this._csvRecords(text);
        if (records.length < 2) return [];
        const header = records[0].map(h => String(h).trim().toLowerCase());
        const idx = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
        const iCid  = idx(['content_id', 'cid']);
        const iIp   = idx(['ip', 'sender_ip', 'user_ip']);
        const iTsMs = idx(['sent_at_ts', 'ts_ms']);
        const iTs   = idx(['ts', 'sent_at', 'timestamp', 'datetime']);
        const iS    = idx(['user_jid', 'sender', 'sender_jid']);
        const iR    = idx(['friend_user_jid', 'receiver', 'receiver_jid']);
        const iGrp  = idx(['group_jid', 'group_id']);
        const get = (f, i) => (i >= 0 && f[i] != null) ? String(f[i]).trim() : '';
        const out = [];
        for (let r = 1; r < records.length; r++) {
            const f = records[r];
            if (!f || (f.length === 1 && !String(f[0]).trim())) continue;
            let ts = 0, rawTs = '';
            if (iTsMs >= 0 && String(f[iTsMs] || '').trim()) { rawTs = String(f[iTsMs]).trim(); ts = this._normalizeTs(rawTs); }
            else if (iTs >= 0) { rawTs = String(f[iTs] || '').trim(); ts = this._normalizeTs(rawTs); }
            out.push({
                contentId:   get(f, iCid),
                ip:          get(f, iIp),
                timestamp:   ts,
                senderJid:   get(f, iS),
                receiverJid: get(f, iR),
                groupJid:    get(f, iGrp),
            });
        }
        return out;
    }

    /**
     * Parse a legacy KIK message CSV. Expected headers (order-independent):
     *   msg_id, sender_jid, receiver_jid, chat_type, msg, ip, port, sent_at
     * The `msg` field may contain commas, quotes, and embedded newlines, so a
     * full quote-aware record parser is required.
     */
    _parseOlderCsvMessages(text) {
        const records = this._csvRecords(text);
        if (!records.length) return [];
        const header = records[0].map(h => String(h).trim().toLowerCase());
        const col = (name) => header.indexOf(name);
        const iId   = col('msg_id');
        const iS    = col('sender_jid');
        const iR    = col('receiver_jid');
        const iType = col('chat_type');
        const iMsg  = col('msg');
        const iIp   = col('ip');
        const iPort = col('port');
        const iSent = col('sent_at');

        const out = [];
        for (let r = 1; r < records.length; r++) {
            const f = records[r];
            if (!f || (f.length === 1 && !String(f[0]).trim())) continue;
            const sentRaw = iSent >= 0 ? String(f[iSent] || '').trim() : '';
            const ts = this._normalizeTs(sentRaw);
            out.push({
                msgId:       iId   >= 0 ? String(f[iId]   || '').trim() : '',
                senderJid:   iS    >= 0 ? String(f[iS]    || '').trim() : '',
                receiverJid: iR    >= 0 ? String(f[iR]    || '').trim() : '',
                chatType:    iType >= 0 ? String(f[iType] || '').trim() : '',
                text:        iMsg  >= 0 ? String(f[iMsg]  || '') : '',
                ip:          iIp   >= 0 ? String(f[iIp]   || '').trim() : '',
                port:        iPort >= 0 ? String(f[iPort] || '').trim() : '',
                timestamp:   ts,
                datetime:    ts ? new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : sentRaw,
            });
        }
        return out;
    }

    /**
     * Quote-aware CSV record parser. Handles RFC-4180 quoting (doubled quotes)
     * and embedded newlines inside quoted fields. Returns an array of rows,
     * each row an array of string fields.
     */
    _csvRecords(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const records = [];
        let field = '';
        let row = [];
        let inQuotes = false;
        let sawAny = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else field += c;
            } else {
                if (c === '"') { inQuotes = true; sawAny = true; }
                else if (c === ',') { row.push(field); field = ''; sawAny = true; }
                else if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; sawAny = false; }
                else if (c === '\r') { /* swallow; \r\n handled by \n */ }
                else { field += c; sawAny = true; }
            }
        }
        if (sawAny || field.length || row.length) { row.push(field); records.push(row); }
        return records;
    }

    /**
     * Normalise a timestamp string to epoch milliseconds. Accepts epoch in
     * seconds / milliseconds / microseconds, or an ISO-ish date string.
     */
    _normalizeTs(v) {
        if (!v) return 0;
        const s = String(v).trim();
        if (/^\d+$/.test(s)) {
            const n = parseInt(s, 10);
            if (s.length >= 16) return Math.floor(n / 1000); // microseconds → ms
            if (s.length >= 13) return n;                    // milliseconds
            if (s.length >= 10) return n * 1000;             // seconds → ms
            return n;
        }
        const t = Date.parse(s);
        return isNaN(t) ? 0 : t;
    }

    /**
     * Reduce a KIK JID (username_xxx@talk.kik.com) to its local part for
     * display / conversation grouping. Keeps the full local part — the device
     * suffix is deterministic per username, so identical users group together.
     */
    _jidLocal(jid) {
        if (!jid) return '';
        let s = String(jid).trim();
        const at = s.indexOf('@');
        if (at >= 0) s = s.slice(0, at);
        return s;
    }

    /**
     * Detect MIME type from filename extension or magic bytes.
     */
    _detectMimeType(fileName, entry) {
        const ext = path.extname(fileName).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        if (ext === '.png') return 'image/png';
        if (ext === '.gif') return 'image/gif';
        if (ext === '.mp4') return 'video/mp4';
        // No extension — peek magic bytes
        try {
            const header = entry.getData().slice(0, 8);
            if (header[0] === 0xFF && header[1] === 0xD8) return 'image/jpeg';
            if (header[0] === 0x89 && header[1] === 0x50) return 'image/png';
            if (header.length > 7 && header[4] === 0x66 && header[5] === 0x74 &&
                header[6] === 0x79 && header[7] === 0x70) return 'video/mp4';
        } catch (e) { /* keep default */ }
        return 'application/octet-stream';
    }

    /**
     * Extract content (media) files from KIK ZIP to a destination directory.
     * DEPRECATED: Use parseZip(buf, { extractDir, security }) instead.
     * Kept for backward compatibility only.
     */
    extractContentFiles(zipBuffer, destDir, security) {
        console.warn('KikWarrantParser.extractContentFiles is deprecated — use parseZip opts.extractDir');
        return { extracted: 0, files: {} };
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /**
     * Find the logs/ directory prefix in ZIP entries.
     */
    _findLogsPrefix(entries) {
        for (const entry of entries) {
            const name = entry.entryName;
            // Match */logs/bind.txt or */logs/chat_sent.txt
            const match = name.match(/^(.+\/logs\/)(?:bind|chat_sent|friend_added)\.txt$/i);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * Find the inner KIK ZIP entry.
     */
    _findInnerZip(entries) {
        // Prefer *_case*.zip pattern
        for (const entry of entries) {
            if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.zip') &&
                /_case\d+/i.test(entry.entryName)) {
                return entry;
            }
        }
        // Fallback: any .zip that isn't the outer
        for (const entry of entries) {
            if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.zip')) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Open an inner ZIP entry — small enough → buffer; >256 MiB → temp-extract
     * and re-open as a streaming reader. Returns { zip, tempPath } where
     * tempPath is non-null only when a temp file was created (must be unlinked
     * by the caller via the registerInner cleanup hook).
     */
    async _openInnerZip(outerZip, innerEntry) {
        const innerSize = (innerEntry.size != null)
            ? innerEntry.size
            : (innerEntry.header && innerEntry.header.size) || 0;

        if (innerSize > INNER_ZIP_BUFFER_LIMIT && outerZip.extractEntryToTemp) {
            const tempPath = await outerZip.extractEntryToTemp(innerEntry, '.zip');
            const zip = await openZip(tempPath, {});
            return { zip, tempPath };
        }
        const buf = innerEntry.getData();
        const zip = await openZip(buf, {});
        return { zip, tempPath: null };
    }

    /**
     * Parse TSV lines into arrays. Skips empty lines.
     */
    _parseLines(text) {
        if (!text || !text.trim()) return [];
        return text.split('\n')
            .map(l => l.replace(/\r$/, ''))
            .filter(l => l.length > 0)
            .map(l => l.split('\t'));
    }

    // ─── File Parsers ───────────────────────────────────────────────────

    /** bind.txt: ts_ms, username, IP, port, datetime, country */
    _parseBind(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            username: f[1] || '',
            ip: f[2] || '',
            port: f[3] || '',
            datetime: f[4] || '',
            country: f[5] || ''
        }));
    }

    /** friend_added.txt: ts_ms, user, friend_username, datetime */
    _parseFriendAdded(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            user: f[1] || '',
            friend: f[2] || '',
            datetime: f[3] || ''
        }));
    }

    /** block_user.txt: may be empty or have similar fields */
    _parseBlockUser(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            user: f[1] || '',
            blocked: f[2] || '',
            datetime: f[3] || ''
        }));
    }

    /** chat_sent.txt: ts_ms, sender, recipient, msg_count, IP, datetime */
    _parseChatSent(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            recipient: f[2] || '',
            msgCount: parseInt(f[3]) || 0,
            ip: f[4] || '',
            datetime: f[5] || ''
        }));
    }

    /** chat_sent_received.txt: ts_ms, sender, recipient, msg_count, REDACTED, datetime */
    _parseChatSentReceived(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            recipient: f[2] || '',
            msgCount: parseInt(f[3]) || 0,
            ip: f[4] || '',  // REDACTED
            datetime: f[5] || ''
        }));
    }

    /** chat_platform_sent.txt: ts_ms, sender, recipient, mediaType, media_uuid, IP, datetime */
    _parseChatPlatformSent(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            recipient: f[2] || '',
            mediaType: f[3] || '',
            mediaUuid: f[4] || '',
            ip: f[5] || '',
            datetime: f[6] || ''
        }));
    }

    /** chat_platform_sent_received.txt: ts_ms, sender, recipient, mediaType, media_uuid, REDACTED, datetime */
    _parseChatPlatformSentReceived(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            recipient: f[2] || '',
            mediaType: f[3] || '',
            mediaUuid: f[4] || '',
            ip: f[5] || '',  // REDACTED
            datetime: f[6] || ''
        }));
    }

    /** group_send_msg.txt: ts_ms, sender, group_id, recipient, msg_count, IP, datetime */
    _parseGroupSendMsg(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            groupId: f[2] || '',
            recipient: f[3] || '',
            msgCount: parseInt(f[4]) || 0,
            ip: f[5] || '',
            datetime: f[6] || ''
        }));
    }

    /** group_receive_msg.txt: ts_ms, sender, group_id, recipient, msg_count, REDACTED, datetime */
    _parseGroupReceiveMsg(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            groupId: f[2] || '',
            recipient: f[3] || '',
            msgCount: parseInt(f[4]) || 0,
            ip: f[5] || '',  // REDACTED
            datetime: f[6] || ''
        }));
    }

    /** group_send_msg_platform.txt: ts_ms, sender, group_id, recipient, mediaType, media_uuid, IP, datetime */
    _parseGroupSendMsgPlatform(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            groupId: f[2] || '',
            recipient: f[3] || '',
            mediaType: f[4] || '',
            mediaUuid: f[5] || '',
            ip: f[6] || '',
            datetime: f[7] || ''
        }));
    }

    /** group_receive_msg_platform.txt: ts_ms, sender, group_id, recipient, mediaType, media_uuid, REDACTED, datetime */
    _parseGroupReceiveMsgPlatform(text) {
        return this._parseLines(text).map(f => ({
            timestamp: parseInt(f[0]) || 0,
            sender: f[1] || '',
            groupId: f[2] || '',
            recipient: f[3] || '',
            mediaType: f[4] || '',
            mediaUuid: f[5] || '',
            ip: f[6] || '',  // REDACTED
            datetime: f[7] || ''
        }));
    }

    // ─── Stats ──────────────────────────────────────────────────────────

    _computeStats(data) {
        // Unique contacts from all DM files
        const dmContacts = new Set();
        for (const r of data.chatSent) { dmContacts.add(r.recipient); }
        for (const r of data.chatSentReceived) { dmContacts.add(r.sender); }
        for (const r of data.chatPlatformSent) { dmContacts.add(r.recipient); }
        for (const r of data.chatPlatformSentReceived) { dmContacts.add(r.sender); }
        dmContacts.delete(data.accountUsername);

        // Unique groups
        const groups = new Set();
        for (const r of data.groupSendMsg) { groups.add(r.groupId); }
        for (const r of data.groupReceiveMsg) { groups.add(r.groupId); }
        for (const r of data.groupSendMsgPlatform) { groups.add(r.groupId); }
        for (const r of data.groupReceiveMsgPlatform) { groups.add(r.groupId); }

        // Unique IPs from binds
        const ips = new Set();
        for (const b of data.binds) { if (b.ip) ips.add(b.ip); }

        // Total records
        const totalRecords = data.binds.length + data.friends.length + data.blockedUsers.length +
            data.chatSent.length + data.chatSentReceived.length +
            data.chatPlatformSent.length + data.chatPlatformSentReceived.length +
            data.groupSendMsg.length + data.groupReceiveMsg.length +
            data.groupSendMsgPlatform.length + data.groupReceiveMsgPlatform.length;

        // Date range from all timestamps
        const allTimestamps = [];
        const addTs = (arr) => { for (const r of arr) { if (r.timestamp) allTimestamps.push(r.timestamp); } };
        addTs(data.binds); addTs(data.friends); addTs(data.chatSent); addTs(data.chatSentReceived);
        addTs(data.chatPlatformSent); addTs(data.chatPlatformSentReceived);
        addTs(data.groupSendMsg); addTs(data.groupReceiveMsg);
        addTs(data.groupSendMsgPlatform); addTs(data.groupReceiveMsgPlatform);

        const minTs = allTimestamps.length ? Math.min(...allTimestamps) : 0;
        const maxTs = allTimestamps.length ? Math.max(...allTimestamps) : 0;

        return {
            totalRecords,
            uniqueContacts: dmContacts.size,
            uniqueFriends: data.friends.length,
            uniqueGroups: groups.size,
            uniqueIps: ips.size,
            dateRange: {
                start: minTs ? new Date(minTs).toISOString() : null,
                end: maxTs ? new Date(maxTs).toISOString() : null
            },
            counts: {
                binds: data.binds.length,
                friends: data.friends.length,
                blocked: data.blockedUsers.length,
                contentFiles: data.contentFiles ? Object.keys(data.contentFiles).length : 0,
                dmTextSent: data.chatSent.length,
                dmTextReceived: data.chatSentReceived.length,
                dmMediaSent: data.chatPlatformSent.length,
                dmMediaReceived: data.chatPlatformSentReceived.length,
                groupTextSent: data.groupSendMsg.length,
                groupTextReceived: data.groupReceiveMsg.length,
                groupMediaSent: data.groupSendMsgPlatform.length,
                groupMediaReceived: data.groupReceiveMsgPlatform.length
            }
        };
    }
}

module.exports = KikWarrantParser;
