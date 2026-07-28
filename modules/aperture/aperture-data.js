/**
 * Aperture Data Management Module
 * Handles storage and retrieval of email data per case
 */

const fs = require('fs');
const path = require('path');

class ApertureData {
    constructor(basePath = './cases', securityManager = null) {
        this.basePath = basePath;
        this.security = securityManager;
    }

    /**
     * Set or update the security manager reference
     */
    setSecurityManager(sm) {
        this.security = sm;
    }

    /**
     * Write data to file — encrypts if security is enabled and unlocked
     */
    _secureWrite(filePath, data) {
        if (this.security && this.security.isEnabled() && this.security.isUnlocked()) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
            fs.writeFileSync(filePath, this.security.encryptBuffer(buf));
        } else {
            if (Buffer.isBuffer(data)) {
                fs.writeFileSync(filePath, data);
            } else {
                fs.writeFileSync(filePath, data, 'utf-8');
            }
        }
    }

    /**
     * Read data from file — decrypts if the file is encrypted
     */
    _secureRead(filePath) {
        const raw = fs.readFileSync(filePath);
        if (this.security && this.security.isUnlocked() && this.security.isEncryptedBuffer(raw)) {
            return this.security.decryptBuffer(raw);
        }
        return raw;
    }

    /**
     * Read text file — returns string (decrypted if needed)
     */
    _secureReadText(filePath) {
        const buf = this._secureRead(filePath);
        return Buffer.isBuffer(buf) ? buf.toString('utf-8') : buf;
    }

    /**
     * Get the aperture directory path for a specific case
     */
    getCaseAperturePath(caseId) {
        return path.join(this.basePath, String(caseId), 'aperture');
    }

    /**
     * Ensure aperture directory exists for a case
     */
    ensureApertureDirectory(caseId) {
        const aperturePath = this.getCaseAperturePath(caseId);
        
        if (!fs.existsSync(aperturePath)) {
            fs.mkdirSync(aperturePath, { recursive: true });
        }

        // Ensure subdirectories exist
        const attachmentsPath = path.join(aperturePath, 'attachments');
        if (!fs.existsSync(attachmentsPath)) {
            fs.mkdirSync(attachmentsPath, { recursive: true });
        }

        return aperturePath;
    }

    /**
     * Load sources for a case
     */
    loadSources(caseId) {
        const sourcesPath = path.join(this.getCaseAperturePath(caseId), 'sources.json');
        
        if (fs.existsSync(sourcesPath)) {
            try {
                const data = this._secureReadText(sourcesPath);
                return JSON.parse(data);
            } catch (error) {
                console.error('Failed to load sources:', error);
                return [];
            }
        }
        
        return [];
    }

    /**
     * Save sources for a case
     */
    saveSources(caseId, sources) {
        this.ensureApertureDirectory(caseId);
        const sourcesPath = path.join(this.getCaseAperturePath(caseId), 'sources.json');
        this._secureWrite(sourcesPath, JSON.stringify(sources, null, 2));
    }

    /**
     * Add a new email source
     */
    addSource(caseId, sourceData) {
        const sources = this.loadSources(caseId);
        const newSource = {
            id: Date.now().toString(),
            name: sourceData.name,
            fileName: sourceData.fileName,
            filePath: sourceData.filePath || null,
            fileType: sourceData.fileType,
            importedDate: new Date().toISOString(),
            emailCount: sourceData.emailCount || 0
        };
        
        sources.push(newSource);
        this.saveSources(caseId, sources);
        
        return newSource;
    }

    /**
     * Load emails for a case
     */
    loadEmails(caseId) {
        const emailsPath = path.join(this.getCaseAperturePath(caseId), 'emails.json');
        
        if (fs.existsSync(emailsPath)) {
            try {
                const data = this._secureReadText(emailsPath);
                return JSON.parse(data);
            } catch (error) {
                console.error('Failed to load emails:', error);
                return [];
            }
        }
        
        return [];
    }

    /**
     * Save emails for a case
     */
    saveEmails(caseId, emails) {
        this.ensureApertureDirectory(caseId);
        const emailsPath = path.join(this.getCaseAperturePath(caseId), 'emails.json');
        this._secureWrite(emailsPath, JSON.stringify(emails, null, 2));
    }

    /**
     * Add emails from a source
     */
    addEmails(caseId, sourceId, newEmails) {
        const emails = this.loadEmails(caseId);
        
        // Add source ID and unique ID to each email
        const processedEmails = newEmails.map((email, index) => ({
            ...email,
            id: `${sourceId}_${Date.now()}_${index}`,
            sourceId: sourceId,
            importedDate: new Date().toISOString()
        }));
        
        emails.push(...processedEmails);
        this.saveEmails(caseId, emails);
        
        return processedEmails;
    }

    /**
     * Get a specific email by ID
     */
    getEmail(caseId, emailId) {
        const emails = this.loadEmails(caseId);
        return emails.find(e => e.id === emailId);
    }

    /**
     * Update an email (for flagging, notes, etc.)
     */
    updateEmail(caseId, emailId, updates) {
        const emails = this.loadEmails(caseId);
        const index = emails.findIndex(e => e.id === emailId);
        
        if (index !== -1) {
            emails[index] = { ...emails[index], ...updates };
            this.saveEmails(caseId, emails);
            return emails[index];
        }
        
        return null;
    }

    /**
     * Save attachment to disk
     */
    saveAttachment(caseId, emailId, attachment, attachmentIndex) {
        const attachmentsPath = path.join(
            this.getCaseAperturePath(caseId),
            'attachments',
            emailId
        );
        
        if (!fs.existsSync(attachmentsPath)) {
            fs.mkdirSync(attachmentsPath, { recursive: true });
        }
        
        const attachmentPath = path.join(attachmentsPath, attachment.filename);
        
        // Decode base64 content and save
        if (attachment.content) {
            const buffer = Buffer.from(attachment.content, 'base64');
            this._secureWrite(attachmentPath, buffer);
            return attachmentPath;
        }
        
        return null;
    }

    /**
     * Get attachment file path
     */
    getAttachmentPath(caseId, emailId, filename) {
        return path.join(
            this.getCaseAperturePath(caseId),
            'attachments',
            emailId,
            filename
        );
    }

    /**
     * Load metadata (search indices, tags, etc.)
     */
    loadMetadata(caseId) {
        const metadataPath = path.join(this.getCaseAperturePath(caseId), 'metadata.json');
        
        if (fs.existsSync(metadataPath)) {
            try {
                const data = this._secureReadText(metadataPath);
                return JSON.parse(data);
            } catch (error) {
                console.error('Failed to load metadata:', error);
                return { tags: {}, notes: {} };
            }
        }
        
        return { tags: {}, notes: {} };
    }

    /**
     * Save metadata
     */
    saveMetadata(caseId, metadata) {
        this.ensureApertureDirectory(caseId);
        const metadataPath = path.join(this.getCaseAperturePath(caseId), 'metadata.json');
        this._secureWrite(metadataPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Add or update a note for an email
     */
    addNote(caseId, emailId, noteContent) {
        const metadata = this.loadMetadata(caseId);
        
        if (!metadata.notes) {
            metadata.notes = {};
        }
        
        if (!metadata.notes[emailId]) {
            metadata.notes[emailId] = [];
        }
        
        const note = {
            id: Date.now().toString(),
            content: noteContent,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        
        metadata.notes[emailId].push(note);
        this.saveMetadata(caseId, metadata);
        
        return note;
    }

    /**
     * Get notes for an email
     */
    getNotes(caseId, emailId) {
        const metadata = this.loadMetadata(caseId);
        return metadata.notes && metadata.notes[emailId] ? metadata.notes[emailId] : [];
    }

    /**
     * Search emails by query
     */
    searchEmails(caseId, query) {
        const emails = this.loadEmails(caseId);
        const lowerQuery = query.toLowerCase();
        
        return emails.filter(email => {
            return (
                (email.subject && email.subject.toLowerCase().includes(lowerQuery)) ||
                (email.from && email.from.toLowerCase().includes(lowerQuery)) ||
                (email.body_text && email.body_text.toLowerCase().includes(lowerQuery)) ||
                (email.to && email.to.some(addr => addr.toLowerCase().includes(lowerQuery)))
            );
        });
    }

    /**
     * Get emails by source
     */
    getEmailsBySource(caseId, sourceId) {
        const emails = this.loadEmails(caseId);
        return emails.filter(email => email.sourceId === sourceId);
    }

    /**
     * Get statistics for a case's aperture data
     */
    getStatistics(caseId) {
        const sources = this.loadSources(caseId);
        const emails = this.loadEmails(caseId);
        
        return {
            sourceCount: sources.length,
            totalEmails: emails.length,
            flaggedEmails: emails.filter(e => e.flagged).length,
            emailsWithAttachments: emails.filter(e => e.attachments && e.attachments.length > 0).length,
            dateRange: this.getDateRange(emails)
        };
    }

    /**
     * Delete a note
     */
    deleteNote(caseId, emailId, noteId) {
        const metadata = this.loadMetadata(caseId);
        if (metadata.notes && metadata.notes[emailId]) {
            metadata.notes[emailId] = metadata.notes[emailId].filter(n => n.id !== noteId);
            this.saveMetadata(caseId, metadata);
        }
    }

    /**
     * Scan case evidence directories for .mbox and .eml files
     * Evidence is stored via Tauri's save_evidence_file under Cases/{caseNumber}/Evidence/
     * Also checks localStorage-referenced paths stored in evidence records
     */
    scanEvidenceForEmailFiles(caseNumber) {
        const results = [];
        caseNumber = String(caseNumber);
        
        // Scan the cases directory for evidence files
        const evidencePath = path.join(this.basePath, caseNumber, 'Evidence');
        if (fs.existsSync(evidencePath)) {
            this._walkDir(evidencePath, results);
        }
        
        // Also scan a flat cases/{caseNumber} root
        const caseRoot = path.join(this.basePath, caseNumber);
        if (fs.existsSync(caseRoot)) {
            // Only scan top-level files here (subdirs handled above)
            const entries = fs.readdirSync(caseRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.mbox', '.eml', '.emlx', '.msg'].includes(ext)) {
                        results.push({
                            name: entry.name,
                            path: path.join(caseRoot, entry.name),
                            type: ext.replace('.', ''),
                            size: fs.statSync(path.join(caseRoot, entry.name)).size
                        });
                    }
                }
            }
        }
        
        return results;
    }

    /**
     * Recursively walk a directory for email files
     */
    _walkDir(dirPath, results) {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    this._walkDir(fullPath, results);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.mbox', '.eml', '.emlx', '.msg'].includes(ext)) {
                        results.push({
                            name: entry.name,
                            path: fullPath,
                            type: ext.replace('.', ''),
                            size: fs.statSync(fullPath).size
                        });
                    }
                }
            }
        } catch (e) {
            console.error('Error scanning dir:', dirPath, e);
        }
    }

    /**
     * Check which evidence email files have already been imported
     */
    getImportedFilePaths(caseId) {
        const sources = this.loadSources(caseId);
        return sources.map(s => s.filePath).filter(Boolean);
    }

    /**
     * Generate an HTML report of case emails (flagged or all)
     */
    generateReport(caseId, options = {}) {
        const emails = this.loadEmails(caseId);
        const sources = this.loadSources(caseId);
        const metadata = this.loadMetadata(caseId);
        const flaggedOnly = options.flaggedOnly !== false;
        
        const reportEmails = flaggedOnly
            ? emails.filter(e => e.flagged)
            : emails;
        
        const now = new Date().toISOString();
        const caseName = options.caseName || `Case ${caseId}`;
        
        let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Aperture Report - ${this._esc(caseName)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0e14; color: #e5e7eb; margin: 0; padding: 20px; }
.header { text-align: center; padding: 30px; border-bottom: 2px solid #00d9ff; margin-bottom: 30px; }
.header h1 { color: #00d9ff; font-size: 2em; margin: 0; }
.header .sub { color: #9ca3af; font-size: 0.9em; margin-top: 8px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 30px; }
.stat-box { background: #1a2332; padding: 16px; border-radius: 8px; text-align: center; border: 1px solid #00d9ff22; }
.stat-box .val { font-size: 1.8em; font-weight: 700; color: #00d9ff; }
.stat-box .lbl { font-size: 0.8em; color: #9ca3af; margin-top: 4px; }
.email-card { background: #1a2332; border: 1px solid #ffffff10; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
.email-card.flagged { border-left: 4px solid #ffa726; }
.email-hdr { padding: 16px; border-bottom: 1px solid #ffffff10; }
.email-hdr h3 { margin: 0 0 8px; color: #fff; }
.email-hdr .meta { font-size: 0.85em; color: #9ca3af; }
.email-hdr .meta span { margin-right: 16px; }
.email-hdr .meta .cyan { color: #00d9ff; }
.email-body { padding: 16px; font-size: 0.9em; line-height: 1.6; }
.notes { background: #0a0e14; padding: 12px 16px; border-top: 1px solid #ffffff10; }
.notes h4 { color: #ffa726; margin: 0 0 8px; font-size: 0.85em; }
.note-item { background: #1a233288; padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 0.85em; }
.note-item .ts { color: #6b7280; font-size: 0.8em; }
.hdr-analysis { padding: 12px 16px; border-top: 1px solid #ffffff10; background: #0d131c; }
.hdr-analysis h4 { color: #00d9ff; margin: 0 0 8px; font-size: 0.85em; }
.hdr-analysis .hdr-sub { color: #9ca3af; font-size: 0.78em; text-transform: uppercase; letter-spacing: .04em; margin: 10px 0 4px; }
.hdr-warn { background: #ffa72618; border: 1px solid #ffa72655; border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 0.82em; color: #ffcc80; }
.hdr-warn ul { margin: 4px 0 0; padding-left: 18px; }
.hdr-tbl { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.hdr-tbl th { text-align: left; color: #6b7280; font-weight: 500; padding: 2px 12px 2px 0; white-space: nowrap; vertical-align: top; width: 130px; }
.hdr-tbl td { color: #e5e7eb; padding: 2px 0; }
.hdr-hops { margin: 4px 0 0; padding-left: 18px; font-size: 0.82em; color: #cbd5e1; }
.hdr-hops li { margin-bottom: 4px; }
.hdr-hops .hop-when { color: #6b7280; font-size: 0.92em; }
.footer { text-align: center; padding: 20px; color: #6b7280; font-size: 0.8em; border-top: 1px solid #ffffff10; margin-top: 30px; }
@media print { body { background: #fff; color: #1a1a1a; } .email-card { border: 1px solid #ccc; } .header h1 { color: #0077b6; } .hdr-analysis { background: #f5f7fa; } .hdr-tbl td, .hdr-hops { color: #1a1a1a; } }
</style></head><body>
<div class="header">
<h1>🔍 APERTURE — Email Analysis Report</h1>
<div class="sub">${this._esc(caseName)} | Generated ${new Date(now).toLocaleString()} | ${flaggedOnly ? 'Flagged Emails Only' : 'All Emails'}</div>
</div>
<div class="stats">
<div class="stat-box"><div class="val">${reportEmails.length}</div><div class="lbl">Emails in Report</div></div>
<div class="stat-box"><div class="val">${emails.length}</div><div class="lbl">Total Emails</div></div>
<div class="stat-box"><div class="val">${emails.filter(e => e.flagged).length}</div><div class="lbl">Flagged</div></div>
<div class="stat-box"><div class="val">${sources.length}</div><div class="lbl">Sources</div></div>
</div>`;

        for (const email of reportEmails) {
            const emailNotes = (metadata.notes && metadata.notes[email.id]) || [];
            html += `<div class="email-card${email.flagged ? ' flagged' : ''}">
<div class="email-hdr">
<h3>${email.flagged ? '🚩 ' : ''}${this._esc(email.subject)}</h3>
<div class="meta">
<span>From: <span class="cyan">${this._esc(email.from)}</span></span>
<span>To: ${this._esc((email.to || []).join(', '))}</span>
<span>Date: ${new Date(email.date).toLocaleString()}</span>
${email.originating_ip ? `<span>IP: <span class="cyan">${email.originating_ip.ip_address}</span> (${email.originating_ip.classification})</span>` : ''}
</div>
</div>
${this._repHeaderAnalysis(email)}
<div class="email-body">${email.body_html || (email.body_text || '').replace(/\n/g, '<br>') || '<em>No content</em>'}</div>`;
            
            if (emailNotes.length > 0) {
                html += `<div class="notes"><h4>📝 Investigator Notes (${emailNotes.length})</h4>`;
                for (const note of emailNotes) {
                    html += `<div class="note-item">${this._esc(note.content)}<div class="ts">${new Date(note.created_at).toLocaleString()}</div></div>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }

        html += `<div class="footer">Generated by Aperture I.E.P. — Integrated in V.I.P.E.R.</div></body></html>`;
        return html;
    }

    /**
     * Escape HTML
     */
    _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Report header-analysis helpers (server-side, no DOM) ──
    _repHdr(email, name) {
        if (!email || !Array.isArray(email.headers)) return '';
        const lc = name.toLowerCase();
        const h = email.headers.find(x => (x.key || '').toLowerCase() === lc);
        return h ? String(h.value || '') : '';
    }

    _repHdrAll(email, name) {
        if (!email || !Array.isArray(email.headers)) return [];
        const lc = name.toLowerCase();
        return email.headers.filter(x => (x.key || '').toLowerCase() === lc).map(x => String(x.value || ''));
    }

    _repAuth(email) {
        const blob = [
            this._repHdr(email, 'authentication-results'),
            this._repHdr(email, 'arc-authentication-results'),
            this._repHdr(email, 'received-spf')
        ].join(' ; ').toLowerCase();
        const pick = (re) => { const m = blob.match(re); return m ? m[1] : ''; };
        return { spf: pick(/spf=(\w+)/), dkim: pick(/dkim=(\w+)/), dmarc: pick(/dmarc=(\w+)/) };
    }

    _repSplitAddr(s) {
        s = String(s || '').trim();
        const m = s.match(/^(.*?)<([^>]+)>\s*$/);
        if (m) return { name: m[1].replace(/["']/g, '').trim(), addr: m[2].trim() };
        return { name: '', addr: s };
    }

    _repReceivedChain(email) {
        const raw = this._repHdrAll(email, 'received');
        if (!raw.length) return [];
        return raw.slice().reverse().map((line) => {
            const from = (line.match(/from\s+([^\s;()]+)/i) || [])[1] || '';
            const by = (line.match(/\bby\s+([^\s;()]+)/i) || [])[1] || '';
            const ipm = line.match(/\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?/);
            const ip = ipm ? ipm[1] : '';
            const datem = line.match(/;\s*(.+)$/);
            let when = '';
            if (datem) { const d = new Date(datem[1].trim()); when = isNaN(d) ? datem[1].trim() : d.toLocaleString(); }
            return { from, by, ip, when };
        });
    }

    _repAuthRow(kind, result) {
        if (!result) return '';
        const r = result.toLowerCase();
        const color = (r === 'pass') ? '#22c55e' : (['fail', 'softfail', 'permerror', 'temperror'].includes(r) ? '#ef4444' : '#9ca3af');
        const labels = {
            spf: { pass: 'The sending server is authorized to send mail for this domain.', fail: 'WARNING: sending server is NOT authorized — possible spoofing.', softfail: 'Caution: sending server is probably not authorized.', default: 'Could not verify the sending server against the domain.' },
            dkim: { pass: 'Valid signature — content was not altered in transit.', fail: 'WARNING: invalid signature — content may be altered or forged.', default: 'No valid cryptographic signature was verified.' },
            dmarc: { pass: 'Passed the domain anti-spoofing policy.', fail: 'WARNING: failed the domain anti-spoofing policy.', default: 'Domain anti-spoofing policy was not evaluated.' }
        };
        const set = labels[kind] || {};
        const plain = set[r] || set.default || '';
        return `<tr><td style="padding:2px 8px;white-space:nowrap"><span style="color:${color};font-weight:700;text-transform:uppercase">${kind.toUpperCase()} ${this._esc(result)}</span></td><td style="padding:2px 8px;color:#cbd5e1">${this._esc(plain)}</td></tr>`;
    }

    _repHeaderAnalysis(email) {
        const from = this._repSplitAddr(email.from);
        const returnPath = this._repSplitAddr(this._repHdr(email, 'return-path'));
        const replyTo = this._repSplitAddr(this._repHdr(email, 'reply-to'));
        const mailer = this._repHdr(email, 'x-mailer') || this._repHdr(email, 'user-agent');
        const auth = this._repAuth(email);
        const hops = this._repReceivedChain(email);
        const ip = email.originating_ip;
        const geo = email.geo_info;
        const arin = email.arin_info;

        const warnings = [];
        if (replyTo.addr && from.addr && replyTo.addr.toLowerCase() !== from.addr.toLowerCase())
            warnings.push(`Replies would go to a different address (${this._esc(replyTo.addr)}) than the sender shown (${this._esc(from.addr)}). Common in phishing.`);
        if (returnPath.addr && from.addr && returnPath.addr.toLowerCase() !== from.addr.toLowerCase())
            warnings.push(`The technical return address (${this._esc(returnPath.addr)}) does not match the sender shown (${this._esc(from.addr)}).`);
        if ((auth.spf && auth.spf.toLowerCase() !== 'pass') || (auth.dkim && auth.dkim.toLowerCase() === 'fail') || (auth.dmarc && auth.dmarc.toLowerCase() === 'fail'))
            warnings.push('One or more sender-authentication checks did not pass — the sender may be forged.');

        const authRows = [this._repAuthRow('spf', auth.spf), this._repAuthRow('dkim', auth.dkim), this._repAuthRow('dmarc', auth.dmarc)].join('');

        let out = `<div class="hdr-analysis"><h4>🔎 Header Analysis</h4>`;

        if (warnings.length) {
            out += `<div class="hdr-warn"><strong>⚠️ Things to check</strong><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>`;
        }

        out += `<table class="hdr-tbl">`;
        if (from.name) out += `<tr><th>Display name</th><td>${this._esc(from.name)}</td></tr>`;
        if (from.addr) out += `<tr><th>Email address</th><td>${this._esc(from.addr)}</td></tr>`;
        if (replyTo.addr) out += `<tr><th>Replies go to</th><td>${this._esc(replyTo.addr)}</td></tr>`;
        if (returnPath.addr) out += `<tr><th>Return path</th><td>${this._esc(returnPath.addr)}</td></tr>`;
        if (mailer) out += `<tr><th>Sent using</th><td>${this._esc(mailer)}</td></tr>`;
        if (ip && ip.ip_address) out += `<tr><th>Sender IP</th><td><span class="cyan">${this._esc(ip.ip_address)}</span> (${this._esc((ip.classification || '').replace(/_/g, ' '))})</td></tr>`;
        out += `</table>`;

        if (authRows) out += `<div class="hdr-sub">Sender authentication</div><table class="hdr-tbl">${authRows}</table>`;

        if (geo && !geo.error) {
            const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
            out += `<div class="hdr-sub">Geolocation (approx.)</div><table class="hdr-tbl">`;
            if (loc) out += `<tr><th>Location</th><td>${this._esc(loc)}</td></tr>`;
            if (geo.isp) out += `<tr><th>ISP</th><td>${this._esc(geo.isp)}</td></tr>`;
            if (geo.org) out += `<tr><th>Org</th><td>${this._esc(geo.org)}</td></tr>`;
            if (geo.asn) out += `<tr><th>ASN</th><td>${this._esc(geo.asn)}</td></tr>`;
            out += `</table>`;
        }

        if (arin && !arin.error) {
            out += `<div class="hdr-sub">🏛️ IP Block Ownership (Registry)</div><table class="hdr-tbl">`;
            if (arin.orgName) out += `<tr><th>Owner / Org</th><td>${this._esc(arin.orgName)}</td></tr>`;
            if (arin.orgAddress) out += `<tr><th>Address</th><td>${this._esc(arin.orgAddress)}</td></tr>`;
            if (arin.netName) out += `<tr><th>Network name</th><td>${this._esc(arin.netName)}</td></tr>`;
            if (arin.cidr) out += `<tr><th>IP block</th><td>${this._esc(arin.cidr)}</td></tr>`;
            if (arin.abuseEmail) out += `<tr><th>Abuse contact</th><td>${this._esc(arin.abuseEmail)}</td></tr>`;
            if (arin.registered) out += `<tr><th>Registered</th><td>${this._esc(new Date(arin.registered).toLocaleDateString())}</td></tr>`;
            if (arin.registry) out += `<tr><th>Registry</th><td>${this._esc(arin.registry)}</td></tr>`;
            out += `</table>`;
        }

        if (hops.length) {
            out += `<div class="hdr-sub">Delivery path — ${hops.length} hop${hops.length === 1 ? '' : 's'} (oldest first)</div><ol class="hdr-hops">`;
            hops.forEach((h) => {
                out += `<li>${h.from ? `from ${this._esc(h.from)}` : '(origin)'}${h.ip ? ` <span class="cyan">[${this._esc(h.ip)}]</span>` : ''}${h.by ? ` → received by ${this._esc(h.by)}` : ''}${h.when ? `<div class="hop-when">${this._esc(h.when)}</div>` : ''}</li>`;
            });
            out += `</ol>`;
        }

        out += `</div>`;
        return out;
    }

    /**
     * Get date range of emails
     */
    getDateRange(emails) {
        if (emails.length === 0) {
            return { earliest: null, latest: null };
        }
        
        const dates = emails.map(e => new Date(e.date)).filter(d => !isNaN(d));
        
        if (dates.length === 0) {
            return { earliest: null, latest: null };
        }
        
        return {
            earliest: new Date(Math.min(...dates)).toISOString(),
            latest: new Date(Math.max(...dates)).toISOString()
        };
    }
}

module.exports = ApertureData;
