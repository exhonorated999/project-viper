/**
 * Aperture Email Parser Module
 * Parses .mbox and individual email files (.eml, .msg)
 */

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');

class ApertureParser {
    /**
     * Parse an .mbox file containing multiple emails
     * @param {string} filePath - Path to the .mbox file
     * @returns {Promise<Array>} Array of parsed email objects
     */
    static async parseMbox(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const emails = [];
        
        // Split mbox file by "From " separator
        const emailBlocks = content.split(/^From /m).filter(block => block.trim());
        
        for (const block of emailBlocks) {
            try {
                // Skip the first line (mbox separator metadata) and parse the rest
                const lines = block.split('\n');
                const emailContent = lines.slice(1).join('\n');
                
                if (emailContent.trim()) {
                    const parsed = await simpleParser(emailContent);
                    const email = this.convertToEmailObject(parsed);
                    emails.push(email);
                }
            } catch (error) {
                console.error('Failed to parse email from mbox:', error);
                // Continue with other emails
            }
        }
        
        return emails;
    }

    /**
     * Parse a single email file (.eml format)
     * @param {string} filePath - Path to the email file
     * @returns {Promise<Object>} Parsed email object
     */
    static async parseEml(filePath) {
        const content = fs.readFileSync(filePath);
        const parsed = await simpleParser(content);
        return this.convertToEmailObject(parsed);
    }

    /**
     * Convert mailparser output to standardized email object
     * @param {Object} parsed - Parsed email from mailparser
     * @returns {Object} Standardized email object
     */
    static convertToEmailObject(parsed) {
        const email = {
            subject: parsed.subject || '(No Subject)',
            from: this.formatAddress(parsed.from),
            to: this.formatAddressList(parsed.to),
            cc: this.formatAddressList(parsed.cc),
            bcc: this.formatAddressList(parsed.bcc),
            date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            messageId: parsed.messageId || null,
            inReplyTo: parsed.inReplyTo || null,
            references: parsed.references || [],
            body_text: parsed.text || '',
            body_html: parsed.html || parsed.textAsHtml || '',
            headers: this.formatHeaders(parsed.headers),
            attachments: this.formatAttachments(parsed.attachments),
            flagged: false,
            originating_ip: this.extractOriginatingIp(parsed.headers)
        };

        return email;
    }

    /**
     * Format email address object
     */
    static formatAddress(addressObj) {
        if (!addressObj) return '';
        if (addressObj.value && addressObj.value.length > 0) {
            const addr = addressObj.value[0];
            return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
        }
        if (typeof addressObj === 'string') return addressObj;
        return '';
    }

    /**
     * Format list of email addresses
     */
    static formatAddressList(addressObj) {
        if (!addressObj) return [];
        if (addressObj.value && Array.isArray(addressObj.value)) {
            return addressObj.value.map(addr => 
                addr.name ? `${addr.name} <${addr.address}>` : addr.address
            );
        }
        if (typeof addressObj === 'string') return [addressObj];
        return [];
    }

    /**
     * Format email headers
     */
    static formatHeaders(headers) {
        const formattedHeaders = [];
        if (headers) {
            for (const [key, value] of headers) {
                formattedHeaders.push({
                    key: key,
                    value: Array.isArray(value) ? value.join(', ') : String(value)
                });
            }
        }
        return formattedHeaders;
    }

    /**
     * Format attachments
     */
    static formatAttachments(attachments) {
        if (!attachments || !Array.isArray(attachments)) return [];
        
        return attachments.map((att, index) => ({
            filename: att.filename || `attachment_${index}`,
            mime_type: att.contentType || 'application/octet-stream',
            size: att.size || 0,
            content_id: att.contentId || att.cid || null,
            is_inline: att.contentDisposition === 'inline' || !!att.cid,
            content: att.content ? att.content.toString('base64') : null,
            flagged: false
        }));
    }

    /**
     * Extract originating IP address from email headers
     */
    static extractOriginatingIp(headers) {
        if (!headers) return null;

        // Collect Received headers (stored newest-first as they appear top-to-bottom)
        const receivedHeaders = [];
        for (const [key, value] of headers) {
            if (key.toLowerCase() === 'received') {
                if (Array.isArray(value)) value.forEach(v => receivedHeaders.push(String(v)));
                else receivedHeaders.push(String(value));
            }
        }

        if (receivedHeaders.length === 0) return null;

        const isPrivateIp = (ip) => {
            const p = ip.split('.').map(Number);
            return (
                p[0] === 10 ||
                p[0] === 127 ||
                p[0] === 0 ||
                p[0] === 169 && p[1] === 254 ||
                (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
                (p[0] === 192 && p[1] === 168) ||
                (p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT
            );
        };
        const ipv4Global = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;

        // Walk from the OLDEST hop (bottom of the chain) upward — the
        // originating server is at the end of the Received chain. Return the
        // first PUBLIC IPv4 we encounter; remember any private one as a fallback.
        let privateFallback = null;
        for (let i = receivedHeaders.length - 1; i >= 0; i--) {
            const line = receivedHeaders[i];
            const matches = line.match(ipv4Global) || [];
            for (const ip of matches) {
                const parts = ip.split('.').map(Number);
                if (parts.some(n => n > 255)) continue; // invalid octet
                if (isPrivateIp(ip)) {
                    if (!privateFallback) privateFallback = ip;
                } else {
                    return { ip_address: ip, classification: 'public', confidence: 0.8 };
                }
            }
        }

        if (privateFallback) {
            return { ip_address: privateFallback, classification: 'private', confidence: 1.0 };
        }
        return null;
    }

    /**
     * Process HTML body to handle embedded images (cid: references)
     * @param {string} html - HTML content
     * @param {Array} attachments - Array of attachment objects
     * @returns {string} Processed HTML with embedded images as data URLs
     */
    static processHtmlBody(html, attachments) {
        if (!html) return '';
        
        let processedHtml = html;
        
        attachments.forEach(attachment => {
            if (attachment.content_id && attachment.content) {
                const dataUrl = `data:${attachment.mime_type};base64,${attachment.content}`;
                
                // Replace various CID reference formats
                const cidFormats = [
                    `cid:${attachment.content_id}`,
                    `cid:${attachment.content_id.replace(/[<>]/g, '')}`,
                ];
                
                cidFormats.forEach(cid => {
                    const regex = new RegExp(cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    processedHtml = processedHtml.replace(regex, dataUrl);
                });
            }
        });
        
        return processedHtml;
    }
}

module.exports = ApertureParser;
