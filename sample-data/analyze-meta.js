const fs = require('fs');
const { parse } = require('node-html-parser');

// Analyze records.html
console.log('========== RECORDS.HTML ==========\n');
const html = fs.readFileSync('sample-data/meta-sample/records.html', 'utf-8');
const root = parse(html);

// Get all categories from sidebar
const sidebar = root.querySelectorAll('.sticky_side_bar a');
console.log('CATEGORIES (sidebar menu):');
sidebar.forEach(a => console.log('  -', a.getAttribute('property'), ':', a.text));

console.log('\nCONTENT SECTIONS:');
const sections = root.querySelectorAll('[id^="property-"]');
sections.forEach(s => {
    const id = s.getAttribute('id');
    // Get direct text content of bold div_tables (section headers)
    const topDivs = s.querySelectorAll(':scope > .div_table, :scope > br + .div_table');
    const subLabels = [];
    topDivs.forEach(d => {
        // The first child text node is the label
        const innerBold = d.querySelector('.div_table[style*="display:table"]');
        if (innerBold) {
            const label = innerBold.childNodes[0]?.text?.trim();
            if (label && label.length < 100) subLabels.push(label);
        }
    });
    
    // Check for "No responsive records"
    const noRecords = s.innerHTML.includes('No responsive records located');
    const hasData = !noRecords || s.innerHTML.length > 500;
    
    console.log(`\n  [${id}] ${hasData ? '*** HAS DATA ***' : '(empty)'}`);
    console.log(`    HTML size: ${s.innerHTML.length} chars`);
    if (subLabels.length > 0) console.log(`    Sub-sections: ${subLabels.join(' | ')}`);
    
    // Look for images
    const imgs = s.querySelectorAll('img');
    if (imgs.length > 0) console.log(`    Images: ${imgs.length}`);
    
    // Look for tables
    const tables = s.querySelectorAll('table');
    if (tables.length > 0) console.log(`    Tables: ${tables.length}`);
});

// Now analyze preservation HTML
console.log('\n\n========== PRESERVATION-1.HTML ==========\n');
const presHtml = fs.readFileSync('sample-data/meta-sample/preservation-1.html', 'utf-8');
const presRoot = parse(presHtml);

const presSidebar = presRoot.querySelectorAll('.sticky_side_bar a');
console.log('CATEGORIES (sidebar menu):');
presSidebar.forEach(a => console.log('  -', a.getAttribute('property'), ':', a.text));

const presSections = presRoot.querySelectorAll('[id^="property-"]');
console.log('\nCONTENT SECTIONS:');
presSections.forEach(s => {
    const id = s.getAttribute('id');
    const noRecords = s.innerHTML.includes('No responsive records located');
    const hasData = !noRecords || s.innerHTML.length > 500;
    console.log(`  [${id}] ${hasData ? '*** HAS DATA ***' : '(empty)'} (${s.innerHTML.length} chars)`);
});
