use crate::models::*;
use mailparse::{parse_mail, MailHeaderMap, ParsedMail};
use std::fs;
use std::path::Path;
use std::io::{BufRead, BufReader, Read, Seek};
use base64;
use cfb;

/// Parse multiple emails from an mbox file
pub fn parse_mbox(file_path: &Path) -> Result<Vec<EmailMetadata>, Box<dyn std::error::Error>> {
    let file = fs::File::open(file_path)?;
    let reader = BufReader::new(file);
    
    let mut emails = Vec::new();
    let mut current_email = Vec::new();
    let mut in_email = false;
    
    for line in reader.lines() {
        let line = line?;
        
        // Check for mbox separator (starts with "From ")
        if line.starts_with("From ") && in_email {
            // Parse the accumulated email
            if !current_email.is_empty() {
                let email_data = current_email.join("\n");
                match parse_mail(email_data.as_bytes()) {
                    Ok(parsed) => {
                        match parse_email_from_parsed(&parsed) {
                            Ok(email) => emails.push(email),
                            Err(e) => eprintln!("Failed to parse email: {}", e),
                        }
                    }
                    Err(e) => eprintln!("Failed to parse mail: {}", e),
                }
                current_email.clear();
            }
        }
        
        if line.starts_with("From ") {
            in_email = true;
            continue; // Skip the separator line
        }
        
        if in_email {
            current_email.push(line);
        }
    }
    
    // Parse the last email
    if !current_email.is_empty() {
        let email_data = current_email.join("\n");
        match parse_mail(email_data.as_bytes()) {
            Ok(parsed) => {
                match parse_email_from_parsed(&parsed) {
                    Ok(email) => emails.push(email),
                    Err(e) => eprintln!("Failed to parse email: {}", e),
                }
            }
            Err(e) => eprintln!("Failed to parse mail: {}", e),
        }
    }
    
    Ok(emails)
}

/// Parse a single email file (.eml, .emlx, or .msg)
pub fn parse_email(file_path: &Path) -> Result<EmailMetadata, Box<dyn std::error::Error>> {
    let extension = file_path.extension().and_then(|s| s.to_str());
    
    match extension {
        Some("msg") => {
            // Parse .msg file (Outlook format)
            parse_msg_file(file_path)
        }
        Some("emlx") => {
            // Parse .emlx file (Apple Mail format)
            let file_content = fs::read(file_path)?;
            let email_content = parse_emlx_content(&file_content)?;
            let parsed = parse_mail(&email_content)?;
            parse_email_from_parsed(&parsed)
        }
        _ => {
            // Parse .eml or other RFC 822 format
            let file_content = fs::read(file_path)?;
            let parsed = parse_mail(&file_content)?;
            parse_email_from_parsed(&parsed)
        }
    }
}

/// Extract RFC 822 email content from .emlx format
/// .emlx format: [byte_count]\n[email_content]\n[xml_plist]
fn parse_emlx_content(content: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let content_str = String::from_utf8_lossy(content);
    let lines: Vec<&str> = content_str.lines().collect();
    
    if lines.is_empty() {
        return Err("Empty .emlx file".into());
    }
    
    // First line should be the byte count
    let byte_count: usize = lines[0].trim().parse()
        .map_err(|_| "Invalid .emlx format: first line should be byte count")?;
    
    // Join remaining lines and take only the specified byte count
    // This excludes the XML plist at the end
    let email_content = lines[1..].join("\n");
    let email_bytes = email_content.as_bytes();
    
    // Take only the byte count specified (this removes the XML plist)
    let actual_content = if email_bytes.len() >= byte_count {
        email_bytes[..byte_count].to_vec()
    } else {
        email_bytes.to_vec()
    };
    
    Ok(actual_content)
}

/// Parse email from a ParsedMail object
fn parse_email_from_parsed(parsed: &ParsedMail) -> Result<EmailMetadata, Box<dyn std::error::Error>> {

    // Extract basic headers
    let subject = parsed
        .headers
        .get_first_value("Subject")
        .unwrap_or_else(|| "(No Subject)".to_string());

    let from = parsed
        .headers
        .get_first_value("From")
        .unwrap_or_else(|| "(Unknown)".to_string());

    let to: Vec<String> = parsed
        .headers
        .get_all_values("To")
        .into_iter()
        .flat_map(|s| s.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>())
        .collect();

    let cc = parsed.headers.get_all_values("Cc");
    let cc = if cc.is_empty() {
        None
    } else {
        Some(
            cc.into_iter()
                .flat_map(|s| s.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>())
                .collect(),
        )
    };

    let bcc = parsed.headers.get_all_values("Bcc");
    let bcc = if bcc.is_empty() {
        None
    } else {
        Some(
            bcc.into_iter()
                .flat_map(|s| s.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>())
                .collect(),
        )
    };

    // Parse date
    let date = parsed
        .headers
        .get_first_value("Date")
        .and_then(|d| chrono::DateTime::parse_from_rfc2822(&d).ok())
        .map(|d| d.with_timezone(&chrono::Utc))
        .unwrap_or_else(chrono::Utc::now);

    // Extract body (text and HTML)
    let (body_text, body_html) = extract_body(&parsed);

    // Extract all headers
    let headers: Vec<EmailHeader> = parsed
        .get_headers()
        .into_iter()
        .map(|h| EmailHeader {
            key: h.get_key().to_string(),
            value: h.get_value().to_string(),
        })
        .collect();

    // Extract originating IP from headers
    let originating_ip = extract_originating_ip(&headers);

    // Parse attachments (basic info, not saved yet)
    let attachments = extract_attachments(&parsed);

    Ok(EmailMetadata {
        id: 0, // Will be set by database
        case_id: 0, // Will be set by caller
        subject,
        from,
        to,
        cc,
        bcc,
        date,
        body_text,
        body_html,
        headers,
        attachments,
        flagged: false,
        originating_ip,
    })
}

/// Extract text and HTML body from parsed email
fn extract_body(parsed: &ParsedMail) -> (Option<String>, Option<String>) {
    let mut text_body = None;
    let mut html_body = None;

    // Check if this is a multipart message
    if parsed.subparts.is_empty() {
        // Single part message
        let content_type = parsed
            .ctype
            .mimetype
            .to_lowercase();
        
        if content_type.starts_with("text/plain") {
            text_body = parsed.get_body().ok();
        } else if content_type.starts_with("text/html") {
            html_body = parsed.get_body().ok();
        }
    } else {
        // Multipart message - extract text and HTML parts
        for part in &parsed.subparts {
            extract_body_recursive(part, &mut text_body, &mut html_body);
        }
    }

    (text_body, html_body)
}

/// Recursively extract body parts
fn extract_body_recursive(part: &ParsedMail, text_body: &mut Option<String>, html_body: &mut Option<String>) {
    let content_type = part.ctype.mimetype.to_lowercase();
    
    if content_type.starts_with("text/plain") && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type.starts_with("text/html") && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
    
    // Recurse into nested multipart sections
    for subpart in &part.subparts {
        extract_body_recursive(subpart, text_body, html_body);
    }
}

/// Extract attachment information from parsed email
fn extract_attachments(parsed: &ParsedMail) -> Vec<Attachment> {
    let mut attachments = Vec::new();
    extract_attachments_recursive(parsed, &mut attachments);
    attachments
}

/// Recursively extract attachments with their data
fn extract_attachments_recursive(part: &ParsedMail, attachments: &mut Vec<Attachment>) {
    // Check if this part is an attachment
    let content_disposition = part
        .headers
        .get_first_value("Content-Disposition")
        .unwrap_or_default()
        .to_lowercase();

    let content_type = part.ctype.mimetype.clone();
    
    // Extract Content-ID if present (used for inline/embedded images)
    let content_id = part
        .headers
        .get_first_value("Content-ID")
        .map(|cid| {
            // Remove angle brackets if present (e.g., <image001@domain.com> -> image001@domain.com)
            cid.trim_start_matches('<').trim_end_matches('>').to_string()
        });
    
    // Determine if this is an inline attachment
    // An attachment is inline if:
    // 1. Content-Disposition is "inline", or
    // 2. It has a Content-ID (typically used for embedded images), or
    // 3. It's an image without explicit "attachment" disposition and has no filename in disposition
    let is_inline_disposition = content_disposition.contains("inline");
    let has_content_id = content_id.is_some();
    let is_explicit_attachment = content_disposition.contains("attachment");
    let is_image = content_type.starts_with("image/");
    
    let is_inline = is_inline_disposition || 
                   (has_content_id && !is_explicit_attachment) ||
                   (is_image && !is_explicit_attachment && !content_disposition.contains("filename"));
    
    // Consider it an attachment if:
    // 1. Content-Disposition contains "attachment" or "inline", or
    // 2. It has a filename parameter, or
    // 3. It has a Content-ID (inline image)
    let is_attachment = content_disposition.contains("attachment") || 
                       content_disposition.contains("inline") ||
                       part.ctype.params.get("name").is_some() ||
                       has_content_id;
    
    if is_attachment {
        let filename = part
            .ctype
            .params
            .get("name")
            .cloned()
            .or_else(|| {
                // Try to extract filename from Content-Disposition
                content_disposition
                    .split(';')
                    .find(|s| s.contains("filename"))
                    .and_then(|s| s.split('=').nth(1))
                    .map(|s| s.trim().trim_matches('"').to_string())
            })
            .or_else(|| {
                // Generate filename from Content-ID if available
                content_id.as_ref().map(|cid| {
                    let ext = match content_type.as_str() {
                        "image/jpeg" | "image/jpg" => "jpg",
                        "image/png" => "png",
                        "image/gif" => "gif",
                        "image/bmp" => "bmp",
                        "image/webp" => "webp",
                        _ => "dat",
                    };
                    format!("{}.{}", cid.split('@').next().unwrap_or("image"), ext)
                })
            })
            .unwrap_or_else(|| "unknown_attachment".to_string());

        // Get the raw attachment data
        let body_data = part.get_body_raw().unwrap_or_default();
        let size = body_data.len() as i64;
        
        // Store attachment data as base64 in file_path temporarily
        // (We'll save to actual files in the command)
        let base64_data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &body_data);
        
        attachments.push(Attachment {
            id: 0, // Will be set by database
            email_id: 0, // Will be set when saving
            filename,
            mime_type: content_type,
            size,
            file_path: base64_data, // Temporarily store base64 data here
            flagged: false,
            content_id,
            is_inline,
        });
    }
    
    // Recurse into subparts
    for subpart in &part.subparts {
        extract_attachments_recursive(subpart, attachments);
    }
}

/// Extract and classify the originating IP address from email headers
fn extract_originating_ip(headers: &[EmailHeader]) -> Option<IpClassification> {
    // Look for X-Originating-IP or parse Received headers
    for header in headers {
        if header.key.eq_ignore_ascii_case("X-Originating-IP") {
            let ip = extract_ip_from_value(&header.value);
            if let Some(ip_addr) = ip {
                return Some(classify_ip(&ip_addr));
            }
        }
    }

    // Parse Received headers (most recent first, which is last in the list)
    let received_headers: Vec<_> = headers
        .iter()
        .filter(|h| h.key.eq_ignore_ascii_case("Received"))
        .collect();

    if let Some(first_received) = received_headers.last() {
        let ip = extract_ip_from_value(&first_received.value);
        if let Some(ip_addr) = ip {
            return Some(classify_ip(&ip_addr));
        }
    }

    None
}

/// Extract IP address from header value
fn extract_ip_from_value(value: &str) -> Option<String> {
    // Simple regex-like extraction of IPv4
    let parts: Vec<&str> = value.split_whitespace().collect();
    for part in parts {
        let cleaned = part.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        if is_valid_ipv4(cleaned) {
            return Some(cleaned.to_string());
        }
    }
    None
}

/// Check if string is a valid IPv4 address
fn is_valid_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| p.parse::<u8>().is_ok())
}

/// Classify an IP address as server/relay or end-user originating
fn classify_ip(ip: &str) -> IpClassification {
    // Known server/relay IP ranges (simplified examples)
    let known_servers = [
        "209.85.", // Google
        "40.92.",  // Microsoft
        "52.95.",  // Amazon SES
    ];

    for prefix in &known_servers {
        if ip.starts_with(prefix) {
            return IpClassification {
                ip_address: ip.to_string(),
                classification: IpType::ServerRelay,
                confidence: 0.95,
                details: Some("Known mail server IP range".to_string()),
            };
        }
    }

    // Default to potential end-user originating
    IpClassification {
        ip_address: ip.to_string(),
        classification: IpType::EndUserOriginating,
        confidence: 0.7,
        details: Some("Not identified as known mail server".to_string()),
    }
}

/// Parse a .msg file (Microsoft Outlook message format)
fn parse_msg_file(file_path: &Path) -> Result<EmailMetadata, Box<dyn std::error::Error>> {
    let file = fs::File::open(file_path)?;
    let mut comp = cfb::CompoundFile::open(file)?;
    
    // Helper function to read a stream as string
    let read_stream_as_string = |comp: &mut cfb::CompoundFile<fs::File>, path: &str| -> Option<String> {
        comp.open_stream(path).ok().and_then(|mut stream| {
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).ok()?;
            
            // Try UTF-16LE first (common in .msg files)
            if buf.len() % 2 == 0 && buf.len() > 0 {
                let utf16_vec: Vec<u16> = buf
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                if let Ok(s) = String::from_utf16(&utf16_vec) {
                    let trimmed = s.trim_end_matches('\0').to_string();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
            }
            
            // Fall back to UTF-8
            String::from_utf8(buf.clone()).ok()
                .map(|s| s.trim_end_matches('\0').to_string())
        })
    };
    
    // Extract email properties from .msg file
    // Property tags used in .msg files:
    // Subject: __substg1.0_0037001F or __substg1.0_0037001E
    // From: __substg1.0_0C1F001F or __substg1.0_0C1F001E
    // To: __substg1.0_0E04001F or __substg1.0_0E04001E
    // Body: __substg1.0_1000001F or __substg1.0_1000001E
    // Date: __substg1.0_00390040
    
    let subject = read_stream_as_string(&mut comp, "__substg1.0_0037001F")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_0037001E"))
        .unwrap_or_else(|| "(No Subject)".to_string());
    
    let from = read_stream_as_string(&mut comp, "__substg1.0_0C1F001F")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_0C1F001E"))
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_5D01001F"))
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_5D01001E"))
        .unwrap_or_else(|| "(Unknown)".to_string());
    
    let to_str = read_stream_as_string(&mut comp, "__substg1.0_0E04001F")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_0E04001E"))
        .unwrap_or_else(|| String::new());
    
    let to_addresses: Vec<String> = if !to_str.is_empty() {
        to_str.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    } else {
        vec![]
    };
    
    let body_text = read_stream_as_string(&mut comp, "__substg1.0_1000001F")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_1000001E"));
    
    let body_html = read_stream_as_string(&mut comp, "__substg1.0_10130102")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_1013001F"))
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_1013001E"));
    
    // Try to get date (this is more complex in .msg format, using current time as fallback)
    let date = chrono::Utc::now();
    
    // Extract headers if available
    let headers_str = read_stream_as_string(&mut comp, "__substg1.0_007D001F")
        .or_else(|| read_stream_as_string(&mut comp, "__substg1.0_007D001E"))
        .unwrap_or_default();
    
    let headers: Vec<EmailHeader> = if !headers_str.is_empty() {
        headers_str
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(2, ':').collect();
                if parts.len() == 2 {
                    Some(EmailHeader {
                        key: parts[0].trim().to_string(),
                        value: parts[1].trim().to_string(),
                    })
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![]
    };
    
    let originating_ip = extract_originating_ip(&headers);
    
    // Extract attachments from .msg file
    let attachments = extract_msg_attachments(&mut comp)?;
    
    Ok(EmailMetadata {
        id: 0,
        case_id: 0,
        subject,
        from,
        to: to_addresses,
        cc: None,
        bcc: None,
        date,
        body_text,
        body_html,
        headers,
        attachments,
        flagged: false,
        originating_ip,
    })
}

/// Extract attachments from a .msg file
fn extract_msg_attachments(comp: &mut cfb::CompoundFile<fs::File>) -> Result<Vec<Attachment>, Box<dyn std::error::Error>> {
    let mut attachments = Vec::new();
    
    // Helper function to read a stream as bytes
    let read_stream_as_bytes = |comp: &mut cfb::CompoundFile<fs::File>, path: &str| -> Option<Vec<u8>> {
        comp.open_stream(path).ok().and_then(|mut stream| {
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).ok()?;
            Some(buf)
        })
    };
    
    // Helper function to read a stream as string (UTF-16LE or UTF-8)
    let read_stream_as_string = |comp: &mut cfb::CompoundFile<fs::File>, path: &str| -> Option<String> {
        comp.open_stream(path).ok().and_then(|mut stream| {
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).ok()?;
            
            // Try UTF-16LE first
            if buf.len() % 2 == 0 && buf.len() > 0 {
                let utf16_vec: Vec<u16> = buf
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                if let Ok(s) = String::from_utf16(&utf16_vec) {
                    let trimmed = s.trim_end_matches('\0').to_string();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
            }
            
            // Fall back to UTF-8
            String::from_utf8(buf).ok()
                .map(|s| s.trim_end_matches('\0').to_string())
        })
    };
    
    // Attachments in .msg files are stored in directories like:
    // __attach_version1.0_#00000000, __attach_version1.0_#00000001, etc.
    // We need to iterate through the compound file entries to find them
    
    // Try to find attachment directories (they start with __attach_version1.0_#)
    for i in 0..100 {  // Support up to 100 attachments
        let attach_dir = format!("__attach_version1.0_#{:08X}", i);
        
        // Try to read attachment properties
        // Property 0x3701 = Attachment filename (Unicode)
        // Property 0x3707 = Attachment long filename (Unicode)  
        // Property 0x370E = Attachment MIME type
        // Property 0x3701 = Attachment data (binary)
        
        let filename_path1 = format!("{}/__substg1.0_3707001F", attach_dir);
        let filename_path2 = format!("{}/__substg1.0_3707001E", attach_dir);
        let filename_path3 = format!("{}/__substg1.0_3704001F", attach_dir);
        let filename_path4 = format!("{}/__substg1.0_3704001E", attach_dir);
        let filename_path5 = format!("{}/__substg1.0_3001001F", attach_dir);
        let filename_path6 = format!("{}/__substg1.0_3001001E", attach_dir);
        
        let filename = read_stream_as_string(comp, &filename_path1)
            .or_else(|| read_stream_as_string(comp, &filename_path2))
            .or_else(|| read_stream_as_string(comp, &filename_path3))
            .or_else(|| read_stream_as_string(comp, &filename_path4))
            .or_else(|| read_stream_as_string(comp, &filename_path5))
            .or_else(|| read_stream_as_string(comp, &filename_path6));
        
        // If we can't find a filename, this attachment slot doesn't exist
        if filename.is_none() {
            continue;
        }
        
        let filename = filename.unwrap_or_else(|| format!("attachment_{}", i));
        
        // Get MIME type
        let mime_path1 = format!("{}/__substg1.0_370E001F", attach_dir);
        let mime_path2 = format!("{}/__substg1.0_370E001E", attach_dir);
        let mime_type = read_stream_as_string(comp, &mime_path1)
            .or_else(|| read_stream_as_string(comp, &mime_path2))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        
        // Get Content-ID if present (for inline attachments)
        // Property 0x3712 = Attachment Content ID
        let cid_path1 = format!("{}/__substg1.0_3712001F", attach_dir);
        let cid_path2 = format!("{}/__substg1.0_3712001E", attach_dir);
        let content_id = read_stream_as_string(comp, &cid_path1)
            .or_else(|| read_stream_as_string(comp, &cid_path2))
            .map(|cid| cid.trim_start_matches('<').trim_end_matches('>').to_string());
        
        // Determine if inline based on Content-ID presence and MIME type
        let is_inline = content_id.is_some() && mime_type.starts_with("image/");
        
        // Get attachment data
        let data_path = format!("{}/__substg1.0_37010102", attach_dir);
        if let Some(data) = read_stream_as_bytes(comp, &data_path) {
            let size = data.len() as i64;
            
            // Store as base64
            let base64_data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
            
            attachments.push(Attachment {
                id: 0,
                email_id: 0,
                filename,
                mime_type,
                size,
                file_path: base64_data,
                flagged: false,
                content_id,
                is_inline,
            });
        }
    }
    
    Ok(attachments)
}
