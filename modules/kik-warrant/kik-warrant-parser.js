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

const AdmZip = require('adm-zip');
const path = require('path');

class KikWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Check if a ZIP buffer is a KIK warrant production.
     * Looks for nested ZIP structure with logs/ directory containing
     * characteristic KIK TSV files.
     */
    static isKikWarrantZip(zipBuffer) {
        try {
            const zip = new AdmZip(zipBuffer);
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
                    } catch (e) { /* not a valid zip, skip */ }
                }
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    // ─── Main Parse ─────────────────────────────────────────────────────

    /**
     * Parse a KIK warrant ZIP file.
     * Handles nested ZIP-of-ZIP structure.
     * @param {Buffer} zipBuffer
     * @param {Object} opts — optional { extractDir, security } to extract
     *   content files to disk in the same pass (avoids re-reading ZIP)
     * @returns {Object} parsed data
     */
    async parseZip(zipBuffer, opts = {}) {
        const fs = require('fs');
        const zip = new AdmZip(zipBuffer);
        let entries = zip.getEntries();
        let contentSourceEntries = null; // entries that contain content/ files

        // Check if we need to unwrap an inner ZIP
        let logsPrefix = this._findLogsPrefix(entries);

        if (!logsPrefix) {
            // Look for inner ZIP (KIK nested structure)
            const innerZipEntry = this._findInnerZip(entries);
            if (innerZipEntry) {
                const innerBuf = innerZipEntry.getData();
                const innerZip = new AdmZip(innerBuf);
                entries = innerZip.getEntries();
                contentSourceEntries = entries; // content is in inner ZIP
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
            } else {
                // Content only in inner ZIP — open it now (single read)
                const innerZipEntry = this._findInnerZip(zip.getEntries());
                if (innerZipEntry) {
                    try {
                        const innerBuf = innerZipEntry.getData();
                        const innerZip = new AdmZip(innerBuf);
                        contentSourceEntries = innerZip.getEntries();
                    } catch (e) { /* ignore */ }
                }
            }
        }

        if (!logsPrefix) {
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

                const info = { size: entry.header.size, mimeType };

                // Extract to disk in the same pass if extractDir provided
                if (extractDir) {
                    try {
                        let buf = entry.getData();
                        const destPath = path.join(extractDir, fileName);
                        if (opts.security && opts.security.isUnlocked()) {
                            fs.writeFileSync(destPath, opts.security.encryptBuffer(buf));
                        } else {
                            fs.writeFileSync(destPath, buf);
                        }
                        info.diskPath = destPath;
                        buf = null; // help GC
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
