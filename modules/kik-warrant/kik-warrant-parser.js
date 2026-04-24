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
     * @returns {Object} parsed data
     */
    async parseZip(zipBuffer) {
        const zip = new AdmZip(zipBuffer);
        let entries = zip.getEntries();
        let innerZipEntries = null; // for fallback content search

        // Check if we need to unwrap an inner ZIP
        let logsPrefix = this._findLogsPrefix(entries);

        if (!logsPrefix) {
            // Look for inner ZIP (KIK nested structure)
            const innerZipEntry = this._findInnerZip(entries);
            if (innerZipEntry) {
                const innerBuf = innerZipEntry.getData();
                const innerZip = new AdmZip(innerBuf);
                entries = innerZip.getEntries();
                logsPrefix = this._findLogsPrefix(entries);
            }
        } else {
            // Logs found directly — but content/ may only be in inner ZIP
            // Save inner ZIP entries for fallback content search
            const innerZipEntry = this._findInnerZip(zip.getEntries());
            if (innerZipEntry) {
                try {
                    const innerBuf = innerZipEntry.getData();
                    const innerZip = new AdmZip(innerBuf);
                    innerZipEntries = innerZip.getEntries();
                } catch (e) { /* ignore */ }
            }
        }

        if (!logsPrefix) {
            throw new Error('Could not find KIK logs directory in ZIP');
        }

        // Extract account username from path
        // Pattern: {username}/logs/ or {something}/{username}/logs/
        const pathParts = logsPrefix.replace(/\/$/, '').split('/');
        const logsIdx = pathParts.lastIndexOf('logs');
        const accountUsername = logsIdx > 0 ? pathParts[logsIdx - 1] : 'unknown';

        // Extract case number from ZIP entry names or username pattern
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

        // Find content/ directory (media files) — sibling to logs/
        // Path: {something}/{username}/content/
        const contentPrefix = logsPrefix.replace(/logs\/$/, 'content/');
        const contentFiles = {};
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            if (entry.entryName.startsWith('__MACOSX')) continue;
            if (entry.entryName.startsWith(contentPrefix)) {
                const fileName = entry.entryName.substring(contentPrefix.length);
                if (fileName && !fileName.includes('/')) {
                    // Detect mime type from extension first, then magic bytes
                    let mimeType = 'application/octet-stream';
                    const ext = path.extname(fileName).toLowerCase();
                    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                    else if (ext === '.png') mimeType = 'image/png';
                    else if (ext === '.gif') mimeType = 'image/gif';
                    else if (ext === '.mp4') mimeType = 'video/mp4';
                    else {
                        // No extension — peek magic bytes
                        try {
                            const header = entry.getData().slice(0, 8);
                            if (header[0] === 0xFF && header[1] === 0xD8) mimeType = 'image/jpeg';
                            else if (header[0] === 0x89 && header[1] === 0x50) mimeType = 'image/png';
                            else if (header.length > 7 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) mimeType = 'video/mp4';
                        } catch (e) { /* keep default */ }
                    }

                    contentFiles[fileName] = {
                        size: entry.header.size,
                        mimeType
                    };
                }
            }
        }

        // Fallback: if no content found and inner ZIP exists, search there
        if (Object.keys(contentFiles).length === 0 && innerZipEntries) {
            const innerLogsPrefix = this._findLogsPrefix(innerZipEntries);
            if (innerLogsPrefix) {
                const innerContentPrefix = innerLogsPrefix.replace(/logs\/$/, 'content/');
                for (const entry of innerZipEntries) {
                    if (entry.isDirectory) continue;
                    if (entry.entryName.startsWith('__MACOSX')) continue;
                    if (entry.entryName.startsWith(innerContentPrefix)) {
                        const fileName = entry.entryName.substring(innerContentPrefix.length);
                        if (fileName && !fileName.includes('/')) {
                            let mimeType = 'application/octet-stream';
                            const ext = path.extname(fileName).toLowerCase();
                            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                            else if (ext === '.png') mimeType = 'image/png';
                            else if (ext === '.gif') mimeType = 'image/gif';
                            else if (ext === '.mp4') mimeType = 'video/mp4';
                            else {
                                try {
                                    const header = entry.getData().slice(0, 8);
                                    if (header[0] === 0xFF && header[1] === 0xD8) mimeType = 'image/jpeg';
                                    else if (header[0] === 0x89 && header[1] === 0x50) mimeType = 'image/png';
                                    else if (header.length > 7 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) mimeType = 'video/mp4';
                                } catch (e) { /* keep default */ }
                            }
                            contentFiles[fileName] = {
                                size: entry.header.size,
                                mimeType,
                                _fromInnerZip: true
                            };
                        }
                    }
                }
            }
        }

        // Parse each file
        const readText = (name) => {
            const entry = fileMap[name];
            if (!entry) return '';
            try { return entry.getData().toString('utf-8'); } catch (e) { return ''; }
        };

        const result = {
            accountUsername,
            caseNumber,
            contentFiles,  // { filename: { entryName, size, mimeType } }
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

        // Compute summary stats
        result.stats = this._computeStats(result);

        return result;
    }

    /**
     * Extract content (media) files from KIK ZIP to a destination directory.
     * Call after parseZip() to save media to disk.
     * @param {Buffer} zipBuffer
     * @param {string} destDir — directory to save files into
     * @param {Object} security — optional security module for encryption
     * @returns {Object} { extracted: number, files: { filename: diskPath } }
     */
    extractContentFiles(zipBuffer, destDir, security) {
        const zip = new AdmZip(zipBuffer);
        let entries = zip.getEntries();

        let logsPrefix = this._findLogsPrefix(entries);
        let contentEntries = entries;

        if (!logsPrefix) {
            const innerZipEntry = this._findInnerZip(entries);
            if (innerZipEntry) {
                const innerBuf = innerZipEntry.getData();
                const innerZip = new AdmZip(innerBuf);
                contentEntries = innerZip.getEntries();
                logsPrefix = this._findLogsPrefix(contentEntries);
            }
        } else {
            // Logs found directly — check if content/ exists at sibling path
            const contentPrefix = logsPrefix.replace(/logs\/$/, 'content/');
            const hasContent = entries.some(e => !e.isDirectory && !e.entryName.startsWith('__MACOSX') && e.entryName.startsWith(contentPrefix));
            if (!hasContent) {
                // Content only in inner ZIP
                const innerZipEntry = this._findInnerZip(zip.getEntries());
                if (innerZipEntry) {
                    try {
                        const innerBuf = innerZipEntry.getData();
                        const innerZip = new AdmZip(innerBuf);
                        contentEntries = innerZip.getEntries();
                        logsPrefix = this._findLogsPrefix(contentEntries) || logsPrefix;
                    } catch (e) { /* fallback to original entries */ }
                }
            }
        }

        if (!logsPrefix) return { extracted: 0, files: {} };

        const contentPrefix = logsPrefix.replace(/logs\/$/, 'content/');
        const fs = require('fs');
        const pathMod = require('path');

        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const fileMap = {};
        let extracted = 0;

        for (const entry of contentEntries) {
            if (entry.isDirectory) continue;
            if (entry.entryName.startsWith('__MACOSX')) continue;
            if (!entry.entryName.startsWith(contentPrefix)) continue;

            const fileName = entry.entryName.substring(contentPrefix.length);
            if (!fileName || fileName.includes('/')) continue;

            try {
                let buf = entry.getData();
                const destPath = pathMod.join(destDir, fileName);

                if (security && security.isUnlocked()) {
                    fs.writeFileSync(destPath, security.encryptBuffer(buf));
                } else {
                    fs.writeFileSync(destPath, buf);
                }

                fileMap[fileName] = destPath;
                extracted++;
            } catch (e) {
                console.error(`Failed to extract ${fileName}:`, e.message);
            }
        }

        return { extracted, files: fileMap };
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
