// Tests for modules/_shared/evidence-folder-name.js
// Run: node modules/_shared/__tests__/evidence-folder-name.test.js
'use strict';
const path = require('path');
const F = require('../evidence-folder-name.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) { ok(a === b, label + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

const NOW = 1730000000000;

// 1. The reported case: no tag → evidence_<ts> - <description>
eq(F.folderName('', 'Black iPhone 12 from center console', { now: NOW }),
    'evidence_1730000000000 - Black iPhone 12 from center console', 'untagged gets the description');
eq(F.folderName(null, undefined, { now: NOW }), 'evidence_1730000000000', 'no tag, no description → old name');
eq(F.folderName('', '   \n  ', { now: NOW }), 'evidence_1730000000000', 'blank description → old name');

// 2. Tagged items
eq(F.folderName('EVID-001', 'Laptop (Dell)', { now: NOW }), 'EVID-001 - Laptop (Dell)', 'tag + description');
eq(F.folderName('EVID-001', '', { now: NOW }), 'EVID-001', 'tag only');
eq(F.folderName('Item 3 laptop', 'laptop', { now: NOW }), 'Item 3 laptop', 'no duplicate when the tag already holds it');
eq(F.folderName('  EVID-002  ', 'Phone', { now: NOW }), 'EVID-002 - Phone', 'tag is trimmed');

// 3. Prefix for other kinds
eq(F.folderName('', 'Suspect phone', { prefix: 'cellebrite', now: NOW }), 'cellebrite_1730000000000 - Suspect phone', 'cellebrite prefix');
eq(F.folderName('', '', { prefix: 'datapilot', now: NOW }), 'datapilot_1730000000000', 'datapilot prefix, no description');
eq(F.folderName('', 'x', { prefix: '../..', now: NOW }), 'evidence_1730000000000 - x', 'hostile prefix ignored');

// 4. Windows-unsafe characters
eq(F.folderName('', 'Phone: iPhone "12" <black>|?*', { now: NOW }), 'evidence_1730000000000 - Phone iPhone 12 black', 'reserved characters removed');
eq(F.folderName('', 'Laptop/HDD\\SSD', { now: NOW }), 'evidence_1730000000000 - Laptop-HDD-SSD', 'slashes become dashes');
eq(F.folderName('', 'Thumb drive...', { now: NOW }), 'evidence_1730000000000 - Thumb drive', 'no trailing dots');
eq(F.folderName('', 'a\tb\x00c\x1fd', { now: NOW }), 'evidence_1730000000000 - a b c d', 'control characters removed');
eq(F.folderName('EVID/001', 'Phone', { now: NOW }), 'EVID-001 - Phone', 'slash in tag cannot make a subfolder');

// 5. First line only, cut at a word boundary
eq(F.folderName('', 'Black iPhone 12\nRecovered from the vehicle on scene by officer', { now: NOW }),
    'evidence_1730000000000 - Black iPhone 12', 'first line only');
eq(F.folderName('', '\n\n  Second line wins  \nthird', { now: NOW }), 'evidence_1730000000000 - Second line wins', 'first non-blank line');
const long = 'Seized Samsung Galaxy S21 Ultra with cracked screen and a purple case found under the passenger seat';
const lf = F.folderName('', long, { now: NOW });
const ld = lf.slice('evidence_1730000000000 - '.length);
ok(ld.length <= F.MAX_DESC, 'long description capped (' + ld.length + ')');
ok(long.startsWith(ld) && long[ld.length] === ' ', 'cut at a word boundary: ' + ld);
ok(!/[\s.,;-]$/.test(lf), 'no trailing punctuation after the cut');
const nospace = 'x'.repeat(200);
eq(F.folderName('', nospace, { now: NOW }).length, 'evidence_1730000000000 - '.length + F.MAX_DESC, 'unbroken text hard-cut');

// 6. Whole name stays bounded, even with a long tag
const longTag = 'T'.repeat(118);
eq(F.folderName(longTag, 'Phone', { now: NOW }), longTag, 'no room → tag only');
ok(F.folderName('T'.repeat(300), 'Phone', { now: NOW }).length <= F.MAX_NAME, 'giant tag capped');
for (let n = 0; n < 200; n += 7) {
    const name = F.folderName('A'.repeat(n), long, { now: NOW });
    ok(name.length <= F.MAX_NAME, 'len cap at tag ' + n);
}

// 7. Never escapes the Evidence folder; never reserved
const hostile = ['..', '.', '...', '../x', '..\\..\\Windows', '/etc/passwd', 'C:\\Windows', 'CON', 'nul', 'COM1', 'lpt9.txt', ' . ', '\x00'];
for (const h of hostile) {
    for (const d of ['', '..', h]) {
        const name = F.folderName(h, d, { now: NOW });
        const base = path.resolve('C:\\cases\\1\\Evidence');
        const full = path.resolve(base, name);
        ok(path.dirname(full) === base, 'stays one level: ' + JSON.stringify([h, d]) + ' → ' + name);
        ok(!/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[ .]$/.test(name) && name !== '..' && name !== '.', 'safe name: ' + JSON.stringify(name));
        ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name), 'not reserved: ' + name);
    }
}

// 8. safeSegment — what the main process applies to every incoming folder name
eq(F.safeSegment('..'), '', '.. rejected');
eq(F.safeSegment('.'), '', '. rejected');
eq(F.safeSegment(''), '', 'empty rejected');
eq(F.safeSegment(null), '', 'null rejected');
eq(F.safeSegment('CON'), '', 'CON rejected');
eq(F.safeSegment('aux.txt'), '', 'aux.txt rejected');
eq(F.safeSegment('../../x'), '-..-x', 'traversal flattened into one segment');
eq(F.safeSegment('...hidden'), 'hidden', 'leading dots dropped');
eq(F.safeSegment('BitTorrent Reports'), 'BitTorrent Reports', 'existing tag unchanged');
eq(F.safeSegment('Datapilot Reports'), 'Datapilot Reports', 'existing tag unchanged 2');
eq(F.safeSegment('ConnectionBoard_1730000000000'), 'ConnectionBoard_1730000000000', 'existing tag unchanged 3');
eq(F.safeSegment('DMV Vehicle ABC1234 (2)'), 'DMV Vehicle ABC1234 (2)', 'existing tag unchanged 4');
eq(F.safeSegment('SA-LZ3K9'), 'SA-LZ3K9', 'existing tag unchanged 5');
eq(F.safeSegment('evidence_1730000000000'), 'evidence_1730000000000', 'old default unchanged');
eq(F.safeSegment('EVID-001 - Laptop (Dell)'), 'EVID-001 - Laptop (Dell)', 'new name is idempotent');
for (let n = 0; n < 300; n += 13) {
    const nm = F.folderName('t' + n, 'Desc: "' + 'w '.repeat(n) + '"', { now: NOW });
    eq(F.safeSegment(nm), nm, 'folderName output passes safeSegment unchanged (' + n + ')');
}

// 9. shortDescription
eq(F.shortDescription('  Phone.  '), 'Phone', 'trimmed');
eq(F.shortDescription('- - Phone'), 'Phone', 'leading dashes dropped');
eq(F.shortDescription(42), '42', 'number');

// 10. Browser global
ok(typeof globalThis.ViperEvidenceFolder === 'object' && globalThis.ViperEvidenceFolder.folderName === F.folderName, 'exposed as ViperEvidenceFolder');

// 11. Wiring
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
ok(html.includes('<script src="modules/_shared/evidence-folder-name.js"></script>'), 'page loads the helper');
ok(!/tag \|\| `evidence_\$\{Date\.now\(\)\}`/.test(html), 'no bare evidence_<ts> folder left in the page');
ok(!/tag \|\| `cellebrite_\$\{Date\.now\(\)\}`/.test(html), 'no bare cellebrite_<ts> folder left');
ok((html.match(/_evFolderName\(tag, description, '(evidence|cellebrite)'\)/g) || []).length === 3, 'three copy paths use the helper');
ok(/_evFolderName\(\(tag \|\| ''\)\.trim\(\), description, 'datapilot'\)/.test(html), 'datapilot copy uses the helper');
ok((html.match(/folder: evidenceTag,/g) || []).length === 2 && html.includes('...(files.length ? { folder: evidenceTag } : {})'), 'records keep their folder');
ok(html.includes('evidenceTag: _evFolderOf(evidence) || evidence.tag'), 'transcripts follow the item folder');
for (const h of ['copy-evidence-file', 'save-evidence-file', 'copy-cellebrite-folder']) {
    const i = main.indexOf("ipcMain.handle('" + h + "'");
    const seg = main.slice(i, i + 700);
    ok(i > 0 && seg.includes("'Evidence', _evidenceFolder(evidenceTag))"), h + ' cleans the folder name');
}
const dp = main.indexOf("ipcMain.handle('datapilot-copy-to-evidence'");
ok(main.slice(dp, dp + 900).includes('_evidenceFolderLib.safeSegment(evidenceTag)'), 'datapilot handler cleans the folder name');

console.log(`evidence-folder-name: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
