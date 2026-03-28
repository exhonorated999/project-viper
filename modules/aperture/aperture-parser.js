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

        // Look for Received headers
        const receivedHeaders = [];
        for (const [key, value] of headers) {
            if (key.toLowerCase() === 'received') {
                receivedHeaders.push(value);
            }
        }

        if (receivedHeaders.length === 0) return null;

        // Get the first (oldest) Received header - usually the originating server
        const firstReceived = Array.isArray(receivedHeaders[0]) 
            ? receivedHeaders[0][0] 
            : receivedHeaders[0];

        // Extract IP address using regex
        // Matches IPv4 addresses in brackets or after 'from'
        const ipv4Regex = /\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?/;
        const match = String(firstReceived).match(ipv4Regex);

        if (match && match[1]) {
            // Basic validation - check it's not a private IP
            const ip = match[1];
            const parts = ip.split('.').map(Number);
            
            // Skip localhost and private IPs for external lookups
            const isPrivate = (
                parts[0] === 10 ||
                parts[0] === 127 ||
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168)
            );

            return {
                ip_address: ip,
                classification: isPrivate ? 'private' : 'public',
                confidence: isPrivate ? 1.0 : 0.7
            };
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
