/**
 * META Warrant Parser
 * Parses META (Facebook/Instagram) law enforcement warrant return ZIP archives.
 * Runs in Electron main process (Node.js) — uses adm-zip, node-html-parser.
 *
 * META productions contain:
 *   records.html          — main production (12 data categories)
 *   preservation-*.html   — preservation snapshots (same format)
 *   instructions.txt      — usage guide (ignored)
 *   linked_media/         — photos & message attachments
 *
 * HTML uses nested div.div_table with CSS display:table for key-value pairs.
 */

const AdmZip = require('adm-zip');
const { parse: parseHTML } = require('node-html-parser');
const path = require('path');

class MetaWarrantParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * Check if a ZIP buffer is a META warrant production
     */
    static isMetaWarrantZip(zipBuffer) {
        try {
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();
            let hasRecordsHtml = false;
            let hasPreservation = false;
            let hasLinkedMedia = false;

            for (const entry of entries) {
                const name = entry.entryName.toLowerCase();
                if (name === 'records.html') hasRecordsHtml = true;
                if (/^preservation-\d+\.html$/i.test(entry.entryName)) hasPreservation = true;
                if (name.startsWith('linked_media/')) hasLinkedMedia = true;
            }

            // Primary: records.html + linked_media/ is definitive
            if (hasRecordsHtml && hasLinkedMedia) return true;
            if (hasRecordsHtml && hasPreservation) return true;

            // Fallback: check HTML title
            if (hasRecordsHtml) {
                try {
                    const html = zip.readAsText('records.html');
                    if (/Facebook Legal Request|Instagram Legal Request|Meta Legal Request/i.test(html.substring(0, 500))) {
                        return true;
                    }
                } catch (e) { /* ignore */ }
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    // ─── Main Parse ─────────────────────────────────────────────────────

    /**
     * Parse a META warrant ZIP file.
     * @param {Buffer} zipBuffer
     * @returns {Object} { records: [...], mediaFiles: {...} }
     */
    async parseZip(zipBuffer) {
        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries();

        const result = {
            records: [],     // one per HTML file (records.html, preservation-*.html)
            mediaFiles: {},  // filename → { data: base64, size: bytes, mimeType }
        };

        // Extract media files
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = entry.entryName;

            if (name.startsWith('linked_media/') && name !== 'linked_media/') {
                const fileName = path.basename(name);
                const buf = entry.getData();
                const ext = path.extname(fileName).toLowerCase();
                const mimeMap = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
                    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf'
                };
                result.mediaFiles[fileName] = {
                    data: buf.toString('base64'),
                    size: buf.length,
                    mimeType: mimeMap[ext] || 'application/octet-stream',
                    originalPath: name
                };
            }
        }

        // Parse HTML files
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = entry.entryName.toLowerCase();

            if (name === 'records.html' || /^preservation-\d+\.html$/i.test(entry.entryName)) {
                try {
                    const html = entry.getData().toString('utf-8');
                    const parsed = this._parseHtmlFile(html, entry.entryName);
                    result.records.push(parsed);
                } catch (e) {
                    console.error(`Error parsing ${entry.entryName}:`, e.message);
                }
            }
        }

        return result;
    }

    // ─── HTML File Parser ───────────────────────────────────────────────

    /**
     * Parse a single META HTML file into structured data.
     */
    _parseHtmlFile(html, fileName) {
        const root = parseHTML(html);

        // Determine source type from filename
        const isPreservation = /preservation/i.test(fileName);
        const source = isPreservation ? fileName.replace(/\.html$/i, '') : 'records';

        // Extract title for service detection
        const titleEl = root.querySelector('title');
        const title = titleEl ? titleEl.text.trim() : '';
        const service = /instagram/i.test(title) ? 'Instagram' : 'Facebook';

        const record = {
            source,
            service,
            title,
            // Request parameters
            targetId: null,
            accountId: null,
            dateRange: null,
            generated: null,
            // Data categories
            ncmecReports: [],
            registrationIp: null,
            ipAddresses: [],
            aboutMe: null,
            wallposts: [],
            statusUpdates: [],
            shares: [],
            photos: [],
            messages: { threads: [] },
            postsToOtherWalls: [],
            bio: null,
        };

        // Parse each category section
        const sectionParsers = {
            'property-request_parameters': (el) => this._parseRequestParameters(el, record),
            'property-ncmec_reports':      (el) => { record.ncmecReports = this._parseNcmecReports(el); },
            'property-registration_ip':    (el) => { record.registrationIp = this._parseRegistrationIp(el); },
            'property-ip_addresses':       (el) => { record.ipAddresses = this._parseIpAddresses(el); },
            'property-about_me':           (el) => { record.aboutMe = this._parseAboutMe(el); },
            'property-wallposts':          (el) => { record.wallposts = this._parseWallposts(el); },
            'property-status_updates':     (el) => { record.statusUpdates = this._parseStatusUpdates(el); },
            'property-shares':             (el) => { record.shares = this._parseShares(el); },
            'property-photos':             (el) => { record.photos = this._parsePhotos(el); },
            'property-unified_messages':   (el) => { record.messages = this._parseUnifiedMessages(el); },
            'property-posts_to_other_walls': (el) => { record.postsToOtherWalls = this._parsePostsToOtherWalls(el); },
            'property-bio':                (el) => { record.bio = this._parseBio(el); },
        };

        for (const [id, parser] of Object.entries(sectionParsers)) {
            const section = root.querySelector('#' + id);
            if (section) {
                try {
                    parser(section);
                } catch (e) {
                    console.error(`Error parsing section ${id}:`, e.message);
                }
            }
        }

        return record;
    }

    // ─── Generic Helpers ────────────────────────────────────────────────

    /**
     * Extract key-value pairs from a container element that uses META's
     * nested div_table pattern. Returns array of { key, value, html, images }.
     *
     * Pattern:
     *   div.div_table[bold] > div.div_table[display:table] >
     *     TEXT = key
     *     div[display:table-cell] > div > content
     */
    _extractKVPairs(containerEl) {
        const pairs = [];
        const divTables = containerEl.querySelectorAll('.div_table[style*="display:table"]');

        for (const dt of divTables) {
            let key = '';
            // First text child is the key label
            for (const child of dt.childNodes) {
                if (child.nodeType === 3) { // text node
                    const t = child.text.trim();
                    if (t) { key = t; break; }
                }
            }
            if (!key) continue;

            // Value is in the table-cell div
            const cell = dt.querySelector('[style*="display:table-cell"]');
            if (!cell) continue;
            const contentDiv = cell.querySelector('div');
            if (!contentDiv) continue;

            const value = contentDiv.text.trim();
            const images = contentDiv.querySelectorAll('img').map(img => img.getAttribute('src')).filter(Boolean);

            pairs.push({ key, value, html: contentDiv.innerHTML, images });
        }

        return pairs;
    }

    /**
     * Get data-bearing div_tables from a section, skipping the Definition sub-section.
     * META sections have two top-level div_tables: Definition + Data.
     * Returns the data div_table elements.
     */
    _getDataDivs(sectionEl) {
        const topDivs = sectionEl.querySelectorAll(':scope > .div_table');
        // Filter out definition divs
        return topDivs.filter(td => {
            const inner = td.querySelector('.div_table[style*="display:table"]');
            if (!inner) return false;
            const firstText = this._getFirstText(inner);
            return !firstText.includes('Definition');
        });
    }

    /**
     * Get first text content from element's direct children
     */
    _getFirstText(el) {
        for (const child of el.childNodes) {
            if (child.nodeType === 3) {
                const t = child.text.trim();
                if (t) return t;
            }
        }
        return '';
    }

    /**
     * Split records within a data section. Records are groups of KV pairs
     * separated by <br> elements at the container level.
     *
     * Returns array of arrays of KV pairs (one array per record).
     */
    _splitRecordsFromKV(kvPairs, recordKeys) {
        // Group KV pairs into records by detecting repeated first-key
        if (kvPairs.length === 0) return [];

        const records = [];
        let current = [];

        for (const kv of kvPairs) {
            // If this key is the start-of-record key and we already have data, flush
            if (recordKeys.includes(kv.key) && current.length > 0) {
                records.push(current);
                current = [];
            }
            current.push(kv);
        }
        if (current.length > 0) records.push(current);

        return records;
    }

    /**
     * Convert an array of KV pairs to an object. Handles duplicate keys
     * by taking the first occurrence (or concatenating for nested data).
     */
    _kvToObject(kvPairs) {
        const obj = {};
        for (const kv of kvPairs) {
            const camelKey = this._toCamelCase(kv.key);
            if (obj[camelKey] === undefined) {
                obj[camelKey] = kv.value;
                if (kv.images.length > 0) obj[camelKey + 'Images'] = kv.images;
            }
        }
        return obj;
    }

    /**
     * Convert label like "IP Address" or "Upload Ip" to camelCase "ipAddress"
     */
    _toCamelCase(str) {
        return str
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .trim()
            .split(/\s+/)
            .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }

    // ─── Category Parsers ───────────────────────────────────────────────

    _parseRequestParameters(sectionEl, record) {
        const dataDivs = this._getDataDivs(sectionEl);
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            for (const kv of kvs) {
                const k = kv.key.toLowerCase();
                if (k === 'target') record.targetId = kv.value;
                else if (k === 'account identifier') record.accountId = kv.value;
                else if (k === 'date range') record.dateRange = kv.value;
                else if (k === 'generated') record.generated = kv.value;
                else if (k === 'service') record.service = kv.value || record.service;
            }
        }
    }

    _parseNcmecReports(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const reports = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['CyberTip ID', 'Cybertip']);
            for (const rec of records) {
                reports.push(this._kvToObject(rec));
            }
        }
        return reports;
    }

    _parseRegistrationIp(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) return null;
            return kvs[0].value || null;
        }
        return null;
    }

    _parseIpAddresses(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const addresses = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['IP Address']);
            for (const rec of records) {
                const obj = this._kvToObject(rec);
                if (!obj.ipAddress) continue; // skip ghost header
                addresses.push({
                    ip: obj.ipAddress || null,
                    time: obj.time || null
                });
            }
        }
        return addresses;
    }

    _parseAboutMe(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) return null;
            const text = kvs.map(kv => kv.value).join(' ').trim();
            return text || null;
        }
        return null;
    }

    _parseWallposts(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const posts = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['To', 'Id']);
            for (const rec of records) {
                const obj = this._kvToObject(rec);
                posts.push({
                    to: obj.to || null,
                    from: obj.from || null,
                    id: obj.id || null,
                    time: obj.time || null,
                    text: obj.text || null,
                    attachments: obj.wallpostsAttachments || null
                });
            }
        }
        return posts;
    }

    _parseStatusUpdates(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const updates = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['Posted']);
            for (const rec of records) {
                const obj = this._kvToObject(rec);
                if (!obj.posted) continue; // skip ghost header
                updates.push({
                    posted: obj.posted || null,
                    status: obj.status || null,
                    mobile: obj.mobile || null,
                    id: obj.id || null,
                    author: obj.author || null,
                    displayDate: obj.displayDate || null,
                    lifeExperience: obj.lifeExperience || null
                });
            }
        }
        return updates;
    }

    _parseShares(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const shares = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['Date Created']);
            for (const rec of records) {
                const obj = this._kvToObject(rec);
                shares.push({
                    dateCreated: obj.dateCreated || null,
                    link: obj.link || null,
                    summary: obj.summary || null,
                    text: obj.text || null,
                    title: obj.title || null,
                    url: obj.url || null,
                    imageId: obj.photoId || null,
                    imageFile: (obj.imageImages || [])[0] || null
                });
            }
        }
        return shares;
    }

    _parsePhotos(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const photos = [];

        for (const dd of dataDivs) {
            // Photos section has Album groupings: "Album: Timeline photos", "Album: Profile pictures"
            const inner = dd.querySelector('.div_table[style*="display:table"]');
            if (!inner) continue;
            const sectionLabel = this._getFirstText(inner);
            if (sectionLabel.includes('No responsive records')) continue;

            // Check if this is an album grouping
            const cell = inner.querySelector('[style*="display:table-cell"]');
            if (!cell) continue;
            const contentDiv = cell.querySelector('div');
            if (!contentDiv) continue;

            // Each photo is a nested set of KV pairs inside the album
            const photoKvs = this._extractKVPairs(contentDiv);
            if (photoKvs.length === 0) continue;

            // Determine album name from section label
            const albumMatch = sectionLabel.match(/Album:\s*(.+)/i);
            const albumName = albumMatch ? albumMatch[1].trim() : sectionLabel;

            // Split into individual photo records
            const photoRecords = this._splitRecordsFromKV(photoKvs, ['Image', 'Linked Media File:']);
            for (const rec of photoRecords) {
                const obj = this._kvToObject(rec);
                const imgFile = (obj.imageImages || [])[0] || obj.linkedMediaFile || null;
                if (!imgFile && !obj.id && !obj.title) continue; // skip ghost header
                photos.push({
                    album: albumName,
                    imageFile: (obj.imageImages || [])[0] || obj.linkedMediaFile || null,
                    id: obj.id || null,
                    title: obj.title || null,
                    link: obj.link || null,
                    uploadIp: obj.uploadIp || null,
                    albumName: obj.albumName || albumName,
                    uploaded: obj.uploaded || null,
                    author: obj.author || null,
                    tags: obj.tags || null
                });
            }
        }

        return photos;
    }

    _parseUnifiedMessages(sectionEl) {
        const result = { threads: [] };
        const dataDivs = this._getDataDivs(sectionEl);

        for (const dd of dataDivs) {
            const inner = dd.querySelector('.div_table[style*="display:table"]');
            if (!inner) continue;
            const sectionLabel = this._getFirstText(inner);

            // Skip disclaimers / metadata text sections
            if (!sectionLabel.startsWith('Unified Messages') && !sectionLabel.startsWith('Thread')) continue;

            const cell = inner.querySelector('[style*="display:table-cell"]');
            if (!cell) continue;
            const contentDiv = cell.querySelector('div');
            if (!contentDiv) continue;

            if (sectionLabel.includes('No responsive records')) continue;

            // Parse thread(s) from this section
            this._parseMessageThreads(contentDiv, result);
        }

        return result;
    }

    /**
     * Parse message threads from the Unified Messages content div.
     * Structure: Thread label with ID → nested KV pairs for participants + messages
     */
    _parseMessageThreads(contentDiv, result) {
        // Look for Thread entries — they're nested div_tables inside the content
        const allKvs = this._extractKVPairs(contentDiv);
        if (allKvs.length === 0) return;

        let currentThread = null;

        for (const kv of allKvs) {
            const k = kv.key;

            if (k === 'Thread') {
                // Start new thread
                if (currentThread) result.threads.push(currentThread);
                const idMatch = kv.value.match(/\((\d+)\)/);
                currentThread = {
                    threadId: idMatch ? idMatch[1] : null,
                    participants: [],
                    messages: []
                };
            } else if (k === 'Current Participants' && currentThread) {
                // Parse participant names from value text
                const lines = kv.value.split('\n').map(l => l.trim()).filter(Boolean);
                // First line is timestamp, rest are participants
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i]) currentThread.participants.push(lines[i]);
                }
            } else if (k === 'Author' && currentThread) {
                // Start a new message in current thread
                currentThread.messages.push({
                    author: kv.value,
                    sent: null,
                    body: null,
                    attachments: []
                });
            } else if (k === 'Sent' && currentThread && currentThread.messages.length > 0) {
                currentThread.messages[currentThread.messages.length - 1].sent = kv.value;
            } else if (k === 'Body' && currentThread && currentThread.messages.length > 0) {
                currentThread.messages[currentThread.messages.length - 1].body = kv.value;
            } else if (k === 'Attachments' && currentThread && currentThread.messages.length > 0) {
                const msg = currentThread.messages[currentThread.messages.length - 1];
                msg.attachments.push({
                    description: kv.value,
                    images: kv.images || []
                });
            } else if ((k === 'Type' || k === 'Size' || k === 'URL' || k === 'Linked Media File:') &&
                       currentThread && currentThread.messages.length > 0) {
                // Attachment metadata — append to last attachment
                const msg = currentThread.messages[currentThread.messages.length - 1];
                if (msg.attachments.length > 0) {
                    const att = msg.attachments[msg.attachments.length - 1];
                    att[this._toCamelCase(k)] = kv.value;
                    if (kv.images.length > 0) att.images = [...(att.images || []), ...kv.images];
                }
            }
        }

        if (currentThread) result.threads.push(currentThread);
    }

    _parsePostsToOtherWalls(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        const posts = [];
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) continue;
            const records = this._splitRecordsFromKV(kvs, ['Id']);
            for (const rec of records) {
                const obj = this._kvToObject(rec);
                if (!obj.id) continue; // skip ghost header
                posts.push({
                    id: obj.id || null,
                    post: obj.post || null,
                    time: obj.time || null,
                    timelineOwner: obj.timelineOwner || null
                });
            }
        }
        return posts;
    }

    _parseBio(sectionEl) {
        const dataDivs = this._getDataDivs(sectionEl);
        for (const dd of dataDivs) {
            const kvs = this._extractKVPairs(dd);
            if (kvs.length === 0 || kvs[0].value.includes('No responsive records')) return null;
            const obj = this._kvToObject(kvs);
            return {
                text: obj.text || null,
                creationTime: obj.creationTime || null
            };
        }
        return null;
    }
}

module.exports = MetaWarrantParser;
