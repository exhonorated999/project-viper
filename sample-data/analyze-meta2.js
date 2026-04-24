const fs = require('fs');
const { parse } = require('node-html-parser');

function analyzeSection(root, sectionId) {
    const section = root.querySelector('#' + sectionId);
    if (!section) return null;
    
    const result = { id: sectionId, subsections: [] };
    
    // Each section has definition divs and data divs
    // Pattern: div.div_table > div.div_table[display:table] > Label + div[display:table-cell] > div > content
    const topDivs = section.querySelectorAll(':scope > .div_table');
    
    topDivs.forEach(td => {
        const innerTable = td.querySelector('.div_table[style*="display:table"]');
        if (!innerTable) return;
        
        // First text child is the label
        let label = '';
        for (const child of innerTable.childNodes) {
            if (child.nodeType === 3) { // text node
                const t = child.text.trim();
                if (t) { label = t; break; }
            }
            if (child.nodeType === 1 && !child.getAttribute('style')) {
                label = child.text.trim();
                break;
            }
        }
        if (!label) {
            // fallback: first text content
            label = innerTable.childNodes[0]?.text?.trim() || '(unknown)';
        }
        
        // Get the content cell
        const cell = innerTable.querySelector('[style*="display:table-cell"]');
        if (!cell) return;
        
        const contentDiv = cell.querySelector('div');
        if (!contentDiv) return;
        
        const text = contentDiv.text.trim().substring(0, 300);
        const imgs = contentDiv.querySelectorAll('img');
        const nestedDivTables = contentDiv.querySelectorAll('.div_table');
        const noRecords = text.includes('No responsive records located');
        
        result.subsections.push({
            label: label.substring(0, 80),
            hasData: !noRecords && text.length > 5,
            textPreview: text.substring(0, 200),
            images: imgs.length,
            nestedTables: nestedDivTables.length,
            htmlSize: contentDiv.innerHTML.length
        });
    });
    
    return result;
}

// Analyze records.html
console.log('==========================================');
console.log('  META RECORDS.HTML - DETAILED ANALYSIS');
console.log('==========================================\n');

const html = fs.readFileSync('sample-data/meta-sample/records.html', 'utf-8');
const root = parse(html);

const categories = [
    'property-request_parameters',
    'property-ncmec_reports', 
    'property-registration_ip',
    'property-ip_addresses',
    'property-about_me',
    'property-wallposts',
    'property-status_updates',
    'property-shares',
    'property-photos',
    'property-unified_messages',
    'property-posts_to_other_walls',
    'property-bio'
];

categories.forEach(catId => {
    const analysis = analyzeSection(root, catId);
    if (!analysis) return;
    
    console.log(`\n== ${catId.replace('property-', '').toUpperCase()} ==`);
    analysis.subsections.forEach(sub => {
        const status = sub.hasData ? '✓ DATA' : '✗ empty';
        console.log(`  [${status}] ${sub.label} (${sub.htmlSize} chars, ${sub.images} imgs, ${sub.nestedTables} nested)`);
        if (sub.hasData && sub.textPreview) {
            console.log(`    Preview: ${sub.textPreview.replace(/\n/g, ' ').substring(0, 150)}`);
        }
    });
});

// Analyze preservation HTML
console.log('\n\n==========================================');
console.log('  META PRESERVATION-1.HTML - DETAILED ANALYSIS');
console.log('==========================================\n');

const presHtml = fs.readFileSync('sample-data/meta-sample/preservation-1.html', 'utf-8');
const presRoot = parse(presHtml);

const presSidebar = presRoot.querySelectorAll('.sticky_side_bar a');
console.log('Categories:');
presSidebar.forEach(a => {
    const prop = a.getAttribute('property');
    if (prop) console.log('  -', prop, ':', a.text);
});

const presSections = presRoot.querySelectorAll('[id^="property-"]');
presSections.forEach(s => {
    const id = s.getAttribute('id');
    const noRecords = s.innerHTML.includes('No responsive records located');
    const hasData = !noRecords || s.innerHTML.length > 500;
    console.log(`  [${id}] ${hasData ? 'HAS DATA' : 'empty'} (${s.innerHTML.length} chars)`);
});
