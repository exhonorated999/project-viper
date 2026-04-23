/**
 * Google Warrant Parser
 * Parses Google warrant return ZIP-of-ZIPs archives
 * Runs in Electron main process (Node.js) — uses adm-zip, node-html-parser, mailparser
 */

const AdmZip = require('adm-zip');
const { parse: parseHTML } = require('node-html-parser');
const { simpleParser } = require('mailparser');
const path = require('path');

class GoogleWarrantParser {

    /**
     * Parse the outer Google warrant ZIP file
     * @param {Buffer} zipBuffer - the ZIP file contents
     * @returns {Object} parsed warrant data
     */
    async parseOuterZip(zipBuffer) {
        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries();

        const result = {
            accountEmail: null,
            accountId: null,
            dateRange: { start: null, end: null },
            coverLetter: null,
            categories: [],
            subscriber: null,
            changeHistory: [],
            emails: [],
            emailMetadata: [],
            locationRecords: [],
            semanticLocations: [],
            devices: [],
            installs: [],
            library: [],
            userActivity: [],
            chatMessages: [],
            chatUserInfo: null,
            chatGroupInfo: [],
            hangoutsInfo: null,
            googlePay: { instruments: [], transactions: [], addresses: [] },
            driveFiles: [],
            accessLogActivity: [],
            ipActivity: [],
            playStorePreferences: [],
            noRecordCategories: []
        };

        // Categorize entries
        const innerZips = [];
        const looseFolders = [];
        const otherFiles = [];

        for (const entry of entries) {
            const name = entry.entryName;
            if (entry.isDirectory) {
                looseFolders.push(name);
            } else if (name.toLowerCase().endsWith('.zip')) {
                innerZips.push(entry);
            } else if (name.toLowerCase().endsWith('.pdf')) {
                result.coverLetter = { name: path.basename(name), size: entry.header.size };
            } else if (name.toLowerCase().endsWith('.mbox')) {
                // Loose mbox (extracted from inner zip that was too large)
                otherFiles.push(entry);
            }
        }

        // Process inner ZIPs — skip the master bundle (matches pattern XXXXXXX-YYYYMMDD-N.zip)
        for (const zipEntry of innerZips) {
            const fileName = path.basename(zipEntry.entryName);

            // Skip master bundle ZIP (numeric-date-seq pattern)
            if (/^\d+-\d{8}-\d+\.zip$/i.test(fileName)) continue;

            // Parse service.resource from filename
            const svcMatch = fileName.match(/\.(\w+)\.(\w+)_\d+\.zip$/i);
            if (!svcMatch) continue;

            const service = svcMatch[1];
            const resource = svcMatch[2];
            const category = `${service}.${resource}`;

            // Extract email and account ID from filename
            if (!result.accountEmail) {
                const idMatch = fileName.match(/^(.+?)\.(\d+)\./);
                if (idMatch) {
                    result.accountEmail = idMatch[1];
                    result.accountId = idMatch[2];
                }
            }

            try {
                const innerBuf = zipEntry.getData();
                const innerZip = new AdmZip(innerBuf);
                const innerEntries = innerZip.getEntries();

                // Check for NoRecords
                const hasNoRecords = innerEntries.some(e => e.entryName.toLowerCase().includes('norecords'));
                if (hasNoRecords) {
                    result.noRecordCategories.push(category);
                    // Still parse ExportSummary
                    const summary = innerEntries.find(e => e.entryName.includes('ExportSummary'));
                    if (summary) {
                        const meta = this.parseExportSummary(summary.getData().toString('utf-8'));
                        if (meta.dateRange) result.dateRange = meta.dateRange;
                    }
                    continue;
                }

                result.categories.push(category);

                // Parse ExportSummary for metadata
                const summary = innerEntries.find(e => e.entryName.includes('ExportSummary'));
                if (summary) {
                    const meta = this.parseExportSummary(summary.getData().toString('utf-8'));
                    if (meta.dateRange && meta.dateRange.end) result.dateRange = meta.dateRange;
                }

                // Route to appropriate parser based on service.resource
                await this._parseCategory(service, resource, innerEntries, result);

            } catch (err) {
                console.error(`Error parsing ${category}:`, err.message);
            }
        }

        // Handle loose MBOX files (not inside an inner ZIP)
        for (const entry of otherFiles) {
            if (entry.entryName.toLowerCase().endsWith('.mbox')) {
                try {
                    const mboxBuf = entry.getData();
                    const emails = await this.parseMbox(mboxBuf);
                    result.emails.push(...emails);
                } catch (err) {
                    console.error('Error parsing loose mbox:', err.message);
                }
            }
        }

        return result;
    }

    /**
     * Route parsing to the correct handler based on service/resource
     */
    async _parseCategory(service, resource, innerEntries, result) {
        const key = `${service}.${resource}`;

        switch (key) {
            case 'GoogleAccount.SubscriberInfo':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        const parsed = this.parseSubscriberInfo(e.getData().toString('utf-8'));
                        result.subscriber = parsed;
                        result.ipActivity = parsed.ipActivity || [];
                    }
                }
                break;

            case 'GoogleAccount.ChangeHistory':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        result.changeHistory = this.parseChangeHistory(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'Mail.MessageContent':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.mbox')) {
                        const emails = await this.parseMbox(e.getData());
                        result.emails.push(...emails);
                    }
                }
                break;

            case 'Mail.MessageInformation':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json')) {
                        try {
                            const meta = this.parseMailMetadata(e.getData().toString('utf-8'));
                            result.emailMetadata.push(meta);
                        } catch (err) { /* skip bad JSON */ }
                    }
                }
                break;

            case 'LocationHistory.Records':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        const locs = this.parseLocationRecords(e.getData().toString('utf-8'));
                        result.locationRecords.push(...locs);
                    }
                }
                break;

            case 'LocationHistory.SemanticLocationHistory':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        const sem = this.parseSemanticLocation(e.getData().toString('utf-8'));
                        result.semanticLocations.push(...sem);
                    }
                }
                break;

            case 'GooglePlayStore.Devices':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.devices = this.parseDevicesCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.Installs':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.installs = this.parseInstallsCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.Library':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.library = this.parseLibraryCsv(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.UserActivity':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        result.userActivity = this.parseUserActivityHtml(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GooglePlayStore.UserPreferences':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.playStorePreferences = this.csvToObjects(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'GoogleChat.Messages':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try {
                            result.chatMessages.push(JSON.parse(e.getData().toString('utf-8')));
                        } catch (err) { /* skip */ }
                    } else if (e.entryName.endsWith('.html')) {
                        result.chatMessages.push({ type: 'html', content: e.getData().toString('utf-8') });
                    }
                }
                break;

            case 'GoogleChat.UserInfo':
                for (const e of innerEntries) {
                    if (!e.entryName.includes('ExportSummary') && !e.entryName.includes('NoRecords')) {
                        result.chatUserInfo = e.getData().toString('utf-8');
                    }
                }
                break;

            case 'GoogleChat.GroupInfo':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.chatGroupInfo.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    }
                }
                break;

            case 'Hangouts.ContentAndMetadata':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.txt') && !e.entryName.includes('ExportSummary')) {
                        result.hangoutsInfo = this.parseHangoutsUserInfo(e.getData().toString('utf-8'));
                    }
                }
                break;

            case 'AccessLogActivity.Activity':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.html')) {
                        result.accessLogActivity = this.parseAccessLogHtml(e.getData().toString('utf-8'));
                    }
                }
                break;

            // Google Pay categories
            case 'GooglePay.Transactions':
            case 'GooglePay.PaymentMethods':
            case 'GooglePay.PaymentInstruments':
            case 'Google Pay.Transactions':
                for (const e of innerEntries) {
                    if (e.entryName.toLowerCase().endsWith('.csv')) {
                        const rows = this.csvToObjects(e.getData().toString('utf-8'));
                        if (resource.toLowerCase().includes('transaction')) {
                            result.googlePay.transactions.push(...rows);
                        } else {
                            result.googlePay.instruments.push(...rows);
                        }
                    } else if (e.entryName.endsWith('.html') && !e.entryName.includes('ExportSummary')) {
                        const parsed = this.parseGooglePayHtml(e.getData().toString('utf-8'));
                        if (parsed.transactions) result.googlePay.transactions.push(...parsed.transactions);
                        if (parsed.instruments) result.googlePay.instruments.push(...parsed.instruments);
                        if (parsed.addresses) result.googlePay.addresses.push(...parsed.addresses);
                    }
                }
                break;

            // Drive
            case 'Drive.Files':
            case 'Drive.DriveMetadata':
                for (const e of innerEntries) {
                    if (e.entryName.endsWith('.json') && !e.entryName.includes('ExportSummary')) {
                        try { result.driveFiles.push(JSON.parse(e.getData().toString('utf-8'))); }
                        catch (err) { /* skip */ }
                    } else if (e.entryName.toLowerCase().endsWith('.csv')) {
                        result.driveFiles.push(...this.csvToObjects(e.getData().toString('utf-8')));
                    }
                }
                break;

            default:
                // Unknown category — try to extract any HTML/CSV/JSON as generic data
                console.log(`Unknown Google warrant category: ${key}`);
                break;
        }
    }

    // ─── Export Summary Parser ──────────────────────────────────────────

    parseExportSummary(text) {
        const result = { email: null, accountId: null, service: null, resource: null, dateRange: { start: null, end: null } };
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Originating Identifier:')) {
                const m = trimmed.match(/:\s*(.+?)\s*\[/);
                if (m) result.email = m[1];
            }
            if (trimmed.startsWith('Resolved Identifier:')) {
                const m = trimmed.match(/:\s*(\d+)/);
                if (m) result.accountId = m[1];
            }
            if (trimmed.startsWith('Service:')) {
                result.service = trimmed.replace('Service:', '').trim();
            }
            if (trimmed.startsWith('Resource:')) {
                result.resource = trimmed.replace('Resource:', '').trim();
            }
            if (trimmed.startsWith('Start of date range:')) {
                const val = trimmed.replace('Start of date range:', '').trim();
                if (val !== 'Not Specified.') result.dateRange.start = val;
            }
            if (trimmed.startsWith('End of date range:')) {
                const val = trimmed.replace('End of date range:', '').trim();
                if (val !== 'Not Specified.') result.dateRange.end = val;
            }
        }
        return result;
    }

    // ─── Subscriber Info Parser ─────────────────────────────────────────

    parseSubscriberInfo(html) {
        const root = parseHTML(html);
        const result = {
            name: null, givenName: null, familyName: null,
            email: null, alternateEmails: null,
            accountId: null, createdOn: null, tosIp: null,
            tosLanguage: null, birthday: null,
            services: null, status: null, lastUpdated: null,
            lastLogins: [], deletionDate: null,
            recovery: { contactEmail: null, recoveryEmail: null, recoverySms: null },
            phoneNumbers: { user: null, twoStep: null },
            devices: null,
            ipActivity: []
        };

        // Parse <li> elements
        const items = root.querySelectorAll('li');
        for (const li of items) {
            const text = li.text.trim();
            this._matchField(text, 'Google Account ID:', v => result.accountId = v);
            this._matchField(text, 'Name:', v => result.name = v);
            this._matchField(text, 'Given Name:', v => result.givenName = v);
            this._matchField(text, 'Family Name:', v => result.familyName = v);
            this._matchField(text, 'e-Mail:', v => result.email = v);
            this._matchField(text, 'Alternate e-Mails:', v => result.alternateEmails = v || null);
            this._matchField(text, 'Created on:', v => result.createdOn = v);
            this._matchField(text, 'Terms of Service IP:', v => result.tosIp = v);
            this._matchField(text, 'Terms of Service Language:', v => result.tosLanguage = v);
            this._matchField(text, 'Birthday (Month Day, Year):', v => result.birthday = v);
            this._matchField(text, 'Services:', v => result.services = v);
            this._matchField(text, 'Status:', v => result.status = v);
            this._matchField(text, 'Last Updated Date:', v => result.lastUpdated = v);
            this._matchField(text, 'Last Logins:', v => result.lastLogins = v.split(',').map(s => s.trim()).filter(Boolean));
            this._matchField(text, 'Deletion Date:', v => result.deletionDate = v || null);
            this._matchField(text, 'Contact e-Mail:', v => result.recovery.contactEmail = v);
            this._matchField(text, 'Recovery e-Mail:', v => result.recovery.recoveryEmail = v || null);
            this._matchField(text, 'Recovery SMS:', v => result.recovery.recoverySms = v || null);
            this._matchField(text, 'User Phone Numbers:', v => result.phoneNumbers.user = v || null);
            this._matchField(text, '2-Step Verification Phone Numbers:', v => result.phoneNumbers.twoStep = v || null);
        }

        // Parse IP Activity table
        const rows = root.querySelectorAll('table tr');
        for (let i = 1; i < rows.length; i++) { // skip header
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 3) {
                result.ipActivity.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    ip: cells[1]?.text?.trim() || '',
                    activityType: cells[2]?.text?.trim() || '',
                    androidId: cells[3]?.text?.trim() || '',
                    appleIdfv: cells[4]?.text?.trim() || '',
                    userAgent: cells[5]?.text?.trim() || ''
                });
            }
        }

        return result;
    }

    _matchField(text, label, setter) {
        if (text.startsWith(label)) {
            setter(text.substring(label.length).trim());
        }
    }

    // ─── Change History Parser ──────────────────────────────────────────

    parseChangeHistory(html) {
        const root = parseHTML(html);
        const rows = root.querySelectorAll('table tr');
        const changes = [];
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 5) {
                changes.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    ip: cells[1]?.text?.trim() || '',
                    changeType: cells[2]?.text?.trim() || '',
                    oldValue: cells[3]?.text?.trim() || '',
                    newValue: cells[4]?.text?.trim() || ''
                });
            }
        }
        return changes;
    }

    // ─── MBOX Parser ────────────────────────────────────────────────────

    async parseMbox(buffer) {
        const text = buffer.toString('utf-8');
        const emails = [];

        // Split on "From " at start of line (MBOX format)
        const parts = text.split(/^From \S+/m);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part || part.length < 20) continue;

            try {
                const parsed = await simpleParser(Buffer.from(part, 'utf-8'));
                emails.push({
                    id: parsed.messageId || `msg-${i}`,
                    from: parsed.from?.text || '',
                    to: parsed.to?.text || '',
                    cc: parsed.cc?.text || '',
                    subject: parsed.subject || '(no subject)',
                    date: parsed.date?.toISOString() || '',
                    labels: parsed.headers?.get('x-gmail-labels') || '',
                    threadId: parsed.headers?.get('x-gm-thrid') || '',
                    textBody: parsed.text || '',
                    htmlBody: parsed.html || '',
                    attachments: (parsed.attachments || []).map(a => ({
                        filename: a.filename,
                        contentType: a.contentType,
                        size: a.size
                    }))
                });
            } catch (err) {
                console.warn('Failed to parse email part:', err.message);
            }
        }

        return emails;
    }

    // ─── Mail Metadata Parser ───────────────────────────────────────────

    parseMailMetadata(jsonStr) {
        const data = JSON.parse(jsonStr);
        const item = data.item || data;
        return {
            messageId: item.item_key?.server_id?.toString() || null,
            threadId: item.thread_key?.server_id?.toString() || null,
            creationTime: item.creation_time_microseconds
                ? new Date(item.creation_time_microseconds / 1000).toISOString()
                : null,
            lastModified: item.last_modification_time_us
                ? new Date(item.last_modification_time_us / 1000).toISOString()
                : null,
            readTime: item.read_ts
                ? new Date(item.read_ts / 1000).toISOString()
                : null
        };
    }

    // ─── Location History Parsers ───────────────────────────────────────

    parseLocationRecords(jsonStr) {
        const data = JSON.parse(jsonStr);
        const locations = data.locations || [];
        return locations.map(loc => ({
            timestamp: loc.timestamp || (loc.timestampMs ? new Date(parseInt(loc.timestampMs)).toISOString() : null),
            lat: loc.latitudeE7 ? loc.latitudeE7 / 1e7 : null,
            lng: loc.longitudeE7 ? loc.longitudeE7 / 1e7 : null,
            accuracy: loc.accuracy || null,
            altitude: loc.altitude || null,
            velocity: loc.velocity || null,
            heading: loc.heading || null,
            source: loc.source || null,
            deviceTag: loc.deviceTag || null,
            activity: loc.activity || null
        }));
    }

    parseSemanticLocation(jsonStr) {
        const data = JSON.parse(jsonStr);
        const items = data.timelineObjects || [];
        return items.map(obj => {
            if (obj.placeVisit) {
                const pv = obj.placeVisit;
                return {
                    type: 'placeVisit',
                    name: pv.location?.name || null,
                    address: pv.location?.address || null,
                    placeId: pv.location?.placeId || null,
                    lat: pv.location?.latitudeE7 ? pv.location.latitudeE7 / 1e7 : null,
                    lng: pv.location?.longitudeE7 ? pv.location.longitudeE7 / 1e7 : null,
                    startTime: pv.duration?.startTimestamp || null,
                    endTime: pv.duration?.endTimestamp || null,
                    confidence: pv.location?.locationConfidence || null
                };
            } else if (obj.activitySegment) {
                const as = obj.activitySegment;
                return {
                    type: 'activitySegment',
                    activityType: as.activityType || null,
                    confidence: as.confidence || null,
                    distance: as.distance || null,
                    startLat: as.startLocation?.latitudeE7 ? as.startLocation.latitudeE7 / 1e7 : null,
                    startLng: as.startLocation?.longitudeE7 ? as.startLocation.longitudeE7 / 1e7 : null,
                    endLat: as.endLocation?.latitudeE7 ? as.endLocation.latitudeE7 / 1e7 : null,
                    endLng: as.endLocation?.longitudeE7 ? as.endLocation.longitudeE7 / 1e7 : null,
                    startTime: as.duration?.startTimestamp || null,
                    endTime: as.duration?.endTimestamp || null
                };
            }
            return null;
        }).filter(Boolean);
    }

    // ─── Google Play Store Parsers ──────────────────────────────────────

    parseDevicesCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => {
            // Extract device info from nested "Most Recent Data" field
            const recentData = row['Most Recent Data'] || row['Data At Time Of User Play Activity'] || '';
            const extract = (key) => {
                const m = recentData.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
                return m ? m[1].trim() : null;
            };

            return {
                androidId: row['Android Id'] || null,
                registrationTime: row['Device Registration Time'] || null,
                lastActive: row['Last Time Device Active'] || null,
                manufacturer: extract('manufacturer'),
                model: extract('model_name'),
                deviceName: extract('device_name'),
                brand: extract('retail_brand'),
                carrier: extract('carrier_name'),
                country: extract('device_ip_country'),
                locale: extract('user_locale'),
                sdkVersion: extract('android_sdk_version'),
                buildFingerprint: extract('build_fingerprint'),
                totalMemory: extract('total_memory_bytes'),
                platform: extract('native_platform')
            };
        });
    }

    parseInstallsCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => ({
            packageName: row['Doc Package Name'] || row['Package Name'] || null,
            title: row['Doc Title'] || null,
            installTime: row['First Installation Time'] || null,
            lastUpdate: row['Last Update Time'] || null,
            state: row['State'] || null,
            installSource: row['Install Source'] || null,
            isSystemApp: row['Is System App'] === 'true',
            deviceModel: row['Device Attribute Model'] || null,
            deviceManufacturer: row['Device Attribute Manufacturer'] || null
        }));
    }

    parseLibraryCsv(csvStr) {
        const rows = this.csvToObjects(csvStr);
        return rows.map(row => ({
            packageName: row['Doc Backend Docid'] || null,
            title: row['Doc Title'] || null,
            type: row['Doc Document Type'] || null,
            url: row['Doc Url'] || null,
            acquisitionTime: row['Acquisition Time'] || null,
            hidden: row['Hidden'] === 'true'
        }));
    }

    parseUserActivityHtml(html) {
        const root = parseHTML(html);
        const activities = [];

        // Google uses Material Design Lite cards — each activity is in .outer-cell
        const cards = root.querySelectorAll('.outer-cell');
        for (const card of cards) {
            const bodyEl = card.querySelector('.content-cell.mdl-typography--body-1');
            if (!bodyEl) continue;

            const bodyHtml = bodyEl.innerHTML;
            const bodyText = bodyEl.text.trim();

            // Split on <br> to get action and timestamp
            const parts = bodyHtml.split(/<br\s*\/?>/i);
            const action = parts[0] ? parts[0].replace(/<[^>]+>/g, '').trim() : bodyText;
            const timestamp = parts[1] ? parts[1].replace(/<[^>]+>/g, '').trim() : '';

            // Extract link if present
            const linkEl = bodyEl.querySelector('a');
            const link = linkEl ? linkEl.getAttribute('href') : null;

            activities.push({ action, timestamp, link });
        }

        return activities;
    }

    // ─── Hangouts Parser ────────────────────────────────────────────────

    parseHangoutsUserInfo(text) {
        const result = {};
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed.includes(':')) continue;
            const colonIdx = trimmed.indexOf(':');
            const key = trimmed.substring(0, colonIdx).trim();
            const val = trimmed.substring(colonIdx + 1).trim();
            if (key && val) result[key] = val;
        }
        return result;
    }

    // ─── Access Log Parser ──────────────────────────────────────────────

    parseAccessLogHtml(html) {
        const root = parseHTML(html);
        const rows = root.querySelectorAll('table tr');
        const activities = [];
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 2) {
                activities.push({
                    timestamp: cells[0]?.text?.trim() || '',
                    activity: cells[1]?.text?.trim() || '',
                    ip: cells[2]?.text?.trim() || '',
                    details: cells[3]?.text?.trim() || ''
                });
            }
        }
        return activities;
    }

    // ─── Google Pay Parser ──────────────────────────────────────────────

    parseGooglePayHtml(html) {
        const root = parseHTML(html);
        const result = { transactions: [], instruments: [], addresses: [] };

        // Google Pay HTML varies — try to extract tables
        const tables = root.querySelectorAll('table');
        for (const table of tables) {
            const headers = table.querySelectorAll('th');
            const headerTexts = Array.from(headers).map(h => h.text.trim().toLowerCase());

            const rows = table.querySelectorAll('tr');
            for (let i = 1; i < rows.length; i++) {
                const cells = rows[i].querySelectorAll('td');
                const obj = {};
                cells.forEach((cell, idx) => {
                    const key = headerTexts[idx] || `col${idx}`;
                    obj[key] = cell.text.trim();
                });

                if (headerTexts.some(h => h.includes('transaction') || h.includes('amount'))) {
                    result.transactions.push(obj);
                } else if (headerTexts.some(h => h.includes('card') || h.includes('instrument') || h.includes('payment'))) {
                    result.instruments.push(obj);
                } else if (headerTexts.some(h => h.includes('address') || h.includes('billing') || h.includes('shipping'))) {
                    result.addresses.push(obj);
                }
            }
        }

        // Also try list items for payment methods
        const sections = root.querySelectorAll('.section, div');
        for (const section of sections) {
            const bold = section.querySelector('b');
            if (bold) {
                const title = bold.text.toLowerCase();
                if (title.includes('payment') || title.includes('card') || title.includes('billing')) {
                    const items = section.querySelectorAll('li');
                    const obj = {};
                    items.forEach(li => {
                        const text = li.text.trim();
                        const colonIdx = text.indexOf(':');
                        if (colonIdx > 0) {
                            obj[text.substring(0, colonIdx).trim()] = text.substring(colonIdx + 1).trim();
                        }
                    });
                    if (Object.keys(obj).length > 0) {
                        result.instruments.push(obj);
                    }
                }
            }
        }

        return result;
    }

    // ─── CSV Parser ─────────────────────────────────────────────────────

    csvToObjects(csvStr) {
        const records = this._parseCsvFull(csvStr);
        if (records.length < 2) return [];

        const headers = records[0];
        const objects = [];

        for (let i = 1; i < records.length; i++) {
            const values = records[i];
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h.trim()] = (values[idx] || '').trim();
            });
            objects.push(obj);
        }

        return objects;
    }

    /**
     * Full CSV parser that handles multi-line quoted fields
     */
    _parseCsvFull(csvStr) {
        const records = [];
        let current = [];
        let field = '';
        let inQuotes = false;
        let i = 0;

        while (i < csvStr.length) {
            const ch = csvStr[i];

            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < csvStr.length && csvStr[i + 1] === '"') {
                        field += '"';
                        i += 2;
                    } else {
                        inQuotes = false;
                        i++;
                    }
                } else {
                    field += ch;
                    i++;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                    i++;
                } else if (ch === ',') {
                    current.push(field);
                    field = '';
                    i++;
                } else if (ch === '\n' || (ch === '\r' && i + 1 < csvStr.length && csvStr[i + 1] === '\n')) {
                    current.push(field);
                    field = '';
                    if (current.some(f => f.trim())) records.push(current);
                    current = [];
                    i += (ch === '\r') ? 2 : 1;
                } else if (ch === '\r') {
                    current.push(field);
                    field = '';
                    if (current.some(f => f.trim())) records.push(current);
                    current = [];
                    i++;
                } else {
                    field += ch;
                    i++;
                }
            }
        }

        // Last field/record
        if (field || current.length > 0) {
            current.push(field);
            if (current.some(f => f.trim())) records.push(current);
        }

        return records;
    }

    // ─── Detection Heuristic ────────────────────────────────────────────

    /**
     * Check if a ZIP file is a Google warrant return
     * @param {Buffer} zipBuffer
     * @returns {boolean}
     */
    static isGoogleWarrantZip(zipBuffer) {
        try {
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();
            for (const entry of entries) {
                const name = entry.entryName;
                // Check for ExportSummary pattern
                if (name.includes('ExportSummary.txt')) return true;
                // Check for Google service naming pattern
                if (/\.\d+\.(GoogleAccount|GooglePlayStore|Mail|LocationHistory|GoogleChat|Hangouts|GooglePay|Drive)\./i.test(name)) return true;
            }
        } catch (e) { /* not a valid zip */ }
        return false;
    }
}

module.exports = GoogleWarrantParser;
