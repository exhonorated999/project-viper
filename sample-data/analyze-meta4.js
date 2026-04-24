const fs = require('fs');
const { parse } = require('node-html-parser');

const html = fs.readFileSync('sample-data/meta-sample/records.html', 'utf-8');
const root = parse(html);

// Generic key-value extractor for Meta's div_table pattern
function extractKVPairs(containerEl) {
    const pairs = [];
    const divTables = containerEl.querySelectorAll('.div_table[style*="display:table"]');
    divTables.forEach(dt => {
        // First text child = key
        let key = '';
        for (const child of dt.childNodes) {
            if (child.nodeType === 3) {
                const t = child.text.trim();
                if (t) { key = t; break; }
            }
        }
        // Table cell = value
        const cell = dt.querySelector('[style*="display:table-cell"]');
        if (cell) {
            const val = cell.text.trim().substring(0, 200);
            const imgs = cell.querySelectorAll('img');
            const imgSrcs = imgs.map(i => i.getAttribute('src')).filter(Boolean);
            if (key) {
                const entry = { key, value: val };
                if (imgSrcs.length > 0) entry.images = imgSrcs;
                pairs.push(entry);
            }
        }
    });
    return pairs;
}

// Extract records grouped by section
function extractSection(sectionId) {
    const section = root.querySelector('#' + sectionId);
    if (!section) return null;
    
    const topDivs = section.querySelectorAll(':scope > .div_table');
    const results = [];
    
    topDivs.forEach(td => {
        const inner = td.querySelector('.div_table[style*="display:table"]');
        if (!inner) return;
        
        let sectionName = '';
        for (const child of inner.childNodes) {
            if (child.nodeType === 3) {
                const t = child.text.trim();
                if (t) { sectionName = t; break; }
            }
        }
        
        if (sectionName.includes('Definition')) return; // skip definitions
        
        const cell = inner.querySelector('[style*="display:table-cell"]');
        if (!cell) return;
        
        const noRecords = cell.text.includes('No responsive records located');
        if (noRecords) return;
        
        const kvs = extractKVPairs(cell);
        results.push({ section: sectionName, fields: kvs });
    });
    
    return results;
}

// Extract and display each section
['property-request_parameters', 'property-ip_addresses', 'property-status_updates', 
 'property-photos', 'property-unified_messages', 'property-posts_to_other_walls', 'property-bio'].forEach(id => {
    console.log(`\n========== ${id.replace('property-', '').toUpperCase()} ==========`);
    const data = extractSection(id);
    if (!data || data.length === 0) {
        console.log('  (no data)');
        return;
    }
    data.forEach(d => {
        console.log(`\n  Section: "${d.section}"`);
        d.fields.forEach(f => {
            let line = `    ${f.key}: ${f.value.substring(0, 120)}`;
            if (f.images) line += ` [IMG: ${f.images.join(', ')}]`;
            console.log(line);
        });
    });
});

// Special: count message threads and messages
console.log('\n\n========== MESSAGE THREAD ANALYSIS ==========');
const msgSection = root.querySelector('#property-unified_messages');
if (msgSection) {
    const threads = msgSection.innerHTML.match(/Thread/g);
    console.log('Thread mentions:', threads ? threads.length : 0);
    
    const authors = msgSection.innerHTML.match(/Author/g);
    console.log('Author mentions (≈ individual messages):', authors ? authors.length : 0);
    
    // Extract thread IDs
    const threadMatches = msgSection.innerHTML.match(/Thread.*?\((\d+)\)/g);
    if (threadMatches) {
        console.log('Threads found:');
        threadMatches.forEach(t => console.log('  ', t.substring(0, 80)));
    }
}
