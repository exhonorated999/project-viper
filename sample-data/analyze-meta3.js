const fs = require('fs');
const { parse } = require('node-html-parser');

const html = fs.readFileSync('sample-data/meta-sample/records.html', 'utf-8');
const root = parse(html);

// Helper: pretty-print a section's HTML structure (indented)
function dumpStructure(el, depth = 0, maxDepth = 6) {
    if (depth > maxDepth) return;
    const indent = '  '.repeat(depth);
    const tag = el.tagName?.toLowerCase() || '#text';
    const cls = el.getAttribute?.('class') || '';
    const style = el.getAttribute?.('style') || '';
    
    if (tag === '#text' || el.nodeType === 3) {
        const t = el.text?.trim();
        if (t) console.log(`${indent}TEXT: "${t.substring(0, 80)}${t.length > 80 ? '...' : ''}"`);
        return;
    }
    
    let desc = tag;
    if (cls) desc += `.${cls.replace(/\s+/g, '.')}`;
    if (style) desc += ` [${style.substring(0, 60)}]`;
    
    // Special elements
    const src = el.getAttribute?.('src');
    if (src) desc += ` src="${src.substring(0, 50)}"`;
    
    console.log(`${indent}<${desc}>`);
    
    if (el.childNodes) {
        el.childNodes.forEach(c => dumpStructure(c, depth + 1, maxDepth));
    }
}

// Show IP Addresses data structure (has nested div_tables)
console.log('=== IP_ADDRESSES DATA STRUCTURE ===\n');
const ipSection = root.querySelector('#property-ip_addresses');
const ipDataDivs = ipSection.querySelectorAll(':scope > .div_table');
// Skip definition, get data div
if (ipDataDivs.length >= 2) {
    dumpStructure(ipDataDivs[1], 0, 5);
}

// Show first status update
console.log('\n\n=== STATUS_UPDATES DATA STRUCTURE (first entry) ===\n');
const statusSection = root.querySelector('#property-status_updates');
const statusDataDivs = statusSection.querySelectorAll(':scope > .div_table');
if (statusDataDivs.length >= 2) {
    // Just first 3 children of data div
    const dataDiv = statusDataDivs[1];
    const inner = dataDiv.querySelector('.div_table[style*="display:table"]');
    if (inner) {
        dumpStructure(inner, 0, 6);
    }
}

// Show messages structure
console.log('\n\n=== UNIFIED_MESSAGES DATA STRUCTURE ===\n');
const msgSection = root.querySelector('#property-unified_messages');
const msgDataDivs = msgSection.querySelectorAll(':scope > .div_table');
if (msgDataDivs.length >= 2) {
    const dataDiv = msgDataDivs[1];
    const inner = dataDiv.querySelector('.div_table[style*="display:table"]');
    if (inner) {
        dumpStructure(inner, 0, 8);
    }
}

// Show photos structure
console.log('\n\n=== PHOTOS DATA STRUCTURE ===\n');
const photoSection = root.querySelector('#property-photos');
const photoDataDivs = photoSection.querySelectorAll(':scope > .div_table');
if (photoDataDivs.length >= 2) {
    const dataDiv = photoDataDivs[1];
    const inner = dataDiv.querySelector('.div_table[style*="display:table"]');
    if (inner) {
        dumpStructure(inner, 0, 8);
    }
}
