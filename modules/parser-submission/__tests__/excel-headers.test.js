/**
 * VIPER Scout — Excel (.xlsx) column headers.
 * modules/parser-submission/sample-builder.js  inspectExcel()
 *
 * Why: an officer submitted a T-Mobile CDR return (.xlsx). Scout recorded
 * only `{ type: 'excel', metadata_only: true }`, so the column layout had to
 * be rebuilt from the carrier's PDF glossary. Scout now records each sheet's
 * header TEXT (PII-redacted), the label before a colon in title rows, the
 * row count and a value-format label per column — never a cell value.
 *
 * All data here is synthetic.
 *
 * Run: node modules\parser-submission\__tests__\excel-headers.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const sb = require('../sample-builder');
const I = sb._internal;

let passed = 0, failed = 0;
async function ok(label, fn) {
    try { await fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + (e && e.message)); failed++; }
}

// cells: string → shared string; {n} → number; {d} → date-styled number (s="1")
function buildXlsx(sheets, opts) {
    opts = opts || {};
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const shared = [], idx = new Map();
    const si = s => { if (!idx.has(s)) { idx.set(s, shared.length); shared.push(s); } return idx.get(s); };
    const col = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const z = new AdmZip();
    sheets.forEach((sh, i) => {
        const parts = [];
        const width = Math.max(1, ...sh.rows.map(r => r.length));
        parts.push('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
        parts.push('<dimension ref="A1:' + col(width - 1) + sh.rows.length + '"/><sheetData>');
        sh.rows.forEach((r, ri) => {
            parts.push('<row r="' + (ri + 1) + '">');
            r.forEach((v, ci) => {
                if (v === '' || v == null) return;
                const ref = col(ci) + (ri + 1);
                if (typeof v === 'object' && 'n' in v) parts.push('<c r="' + ref + '"><v>' + v.n + '</v></c>');
                else if (typeof v === 'object' && 'd' in v) parts.push('<c r="' + ref + '" s="1"><v>' + v.d + '</v></c>');
                else if (typeof v === 'object' && 'inline' in v) parts.push('<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v.inline) + '</t></is></c>');
                else parts.push('<c r="' + ref + '" t="s"><v>' + si(String(v)) + '</v></c>');
            });
            parts.push('</row>');
        });
        parts.push('</sheetData></worksheet>');
        z.addFile('xl/worksheets/sheet' + (i + 1) + '.xml', Buffer.from(parts.join('')));
    });
    z.addFile('xl/sharedStrings.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + shared.map(s => '<si><t xml:space="preserve">' + esc(s) + '</t></si>').join('') + '</sst>'));
    z.addFile('xl/styles.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'));
    z.addFile('xl/workbook.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"' + (s.hidden ? ' state="hidden"' : '') + '/>').join('') + '</sheets></workbook>'));
    z.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="' + (opts.absTargets ? '/xl/' : '') + 'worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>'));
    z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));
    return z.toBuffer();
}

const HEAD = ['Date', '(UTC) Time', 'Duration', 'Call Type', 'Direction', 'Calling Number', 'Dialed Digits',
    'Called Number', 'IMEI', 'IMSI', 'Switch', '1st Tower LAT', '1st Tower LONG', '1st Tower Azimuth'];
const SECRET_VALUES = ['15555550123', '15555550100', 'mSOriginating', 'mSTerminatingSMSinMSC', '39.7', '-105', '000000000000011', '310260000000011', 'SW01', '0000000', 'Jane Q Synthetic'];
const CDR_ROWS = [
    ['T-Mobile USA, Inc. — Law Enforcement Relations'],
    ['Tracking ID: 0000000', '', 'Target: 15555550100'],
    ['Prepared for: Jane Q Synthetic'],
    [],
    HEAD,
    [{ d: 45821 }, '23:30:00', { n: 83 }, 'mSOriginating', 'Outgoing', '15555550100', '15555550123', '15555550123', '000000000000011', '310260000000011', 'SW01', { n: 39.7 }, { n: -105 }, { n: 120 }],
    [{ d: 45821 }, '23:45:10', { n: 0 }, 'mSTerminatingSMSinMSC', 'Incoming', '15555550123', '15555550100', '15555550100', '000000000000011', '310260000000011', 'SW01', { n: 39.7 }, { n: -105 }, { n: 120 }],
];
const SUB_ROWS = [['Subscriber Information'], ['Name', 'Address', 'Account Number'], ['Jane Q Synthetic', '1 Example St', '0000000']];

(async () => {
    console.log('\nScout — inspectExcel');
    const buf = buildXlsx([{ name: 'Subscriber 15555550100', rows: SUB_ROWS }, { name: 'CDR', rows: CDR_ROWS }, { name: 'Notes', rows: [['x']], hidden: true }]);
    const res = I.inspectExcel(buf);
    const json = JSON.stringify(res);

    await ok('routes through inspectFormat(excel)', () => {
        const viaDispatch = I.inspectFormat('excel', buf);
        assert.strictEqual(viaDispatch.type, 'excel');
        assert.ok(!viaDispatch.metadata_only);
        assert.strictEqual(viaDispatch.sheets.length, 3);
    });
    await ok('sheet names recorded, PII redacted, hidden flagged', () => {
        assert.strictEqual(res.sheet_count, 3);
        assert.strictEqual(res.sheets[0].name, 'Subscriber <PHONE>');
        assert.strictEqual(res.sheets[1].name, 'CDR');
        assert.strictEqual(res.sheets[2].state, 'hidden');
    });
    await ok('CDR sheet: header row found under the title rows, header text recorded', () => {
        const s = res.sheets[1];
        assert.strictEqual(s.header_row, 4);
        assert.strictEqual(s.banner_rows_skipped, 4);
        assert.deepStrictEqual(s.headers, HEAD);
        assert.strictEqual(s.column_count, HEAD.length);
        assert.strictEqual(s.row_count, 7);
        assert.strictEqual(s.dimension, 'A1:N7');
    });
    await ok('banner rows give only the label before the colon', () => {
        assert.deepStrictEqual(res.sheets[1].banner_labels, ['Tracking ID', 'Target', 'Prepared for']);
    });
    await ok('column formats, not values (date style → excel_date)', () => {
        const f = res.sheets[1].column_formats;
        assert.strictEqual(f[0], 'excel_date');
        assert.strictEqual(f[1], 'time_str');
        assert.strictEqual(f[2], 'int');
        assert.strictEqual(f[3], 'string');
        assert.strictEqual(f[11], 'float');
        assert.strictEqual(res.sheets[1].rows_sampled_for_formats, 2);
    });
    await ok('NO cell value from any data or banner row is in the result', () => {
        for (const v of SECRET_VALUES) assert.ok(!json.includes(v), 'leaked: ' + v);
        assert.ok(!json.includes('Example St'));
    });
    await ok('legacy .xls (BIFF) is flagged, not parsed', () => {
        const xls = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]);
        assert.deepStrictEqual(I.inspectFormat('excel', xls), { type: 'excel', legacy_xls: true, metadata_only: true });
    });
    await ok('garbage / non-workbook zip does not throw', () => {
        assert.strictEqual(I.inspectFormat('excel', Buffer.from('hello world')).inspect_note, 'not_a_zip');
        const z = new AdmZip(); z.addFile('a.txt', Buffer.from('x'));
        assert.strictEqual(I.inspectFormat('excel', z.toBuffer()).inspect_note, 'no_workbook');
    });
    await ok('absolute rels targets (/xl/worksheets/…) resolve', () => {
        const r = I.inspectExcel(buildXlsx([{ name: 'CDR', rows: CDR_ROWS }], { absTargets: true }));
        assert.deepStrictEqual(r.sheets[0].headers, HEAD);
    });
    await ok('huge sheet: partly inflated, header still found, row count from <dimension>', () => {
        const rows = [['Tracking ID: 0000000'], ['Date', 'Session Id', 'Calling Number', 'Called Number']];
        for (let i = 0; i < 90000; i++) rows.push([{ d: 45821 }, { inline: crypto.randomBytes(16).toString('hex') }, { inline: crypto.randomBytes(8).toString('hex') }, '15555550123']);
        const big = buildXlsx([{ name: 'CDR', rows }]);
        const r = I.inspectExcel(big);
        const s = r.sheets[0];
        assert.strictEqual(s.partially_read, true, 'expected the partial path (compressed sheet > 1 MB)');
        assert.deepStrictEqual(s.headers, ['Date', 'Session Id', 'Calling Number', 'Called Number']);
        assert.strictEqual(s.row_count, 90002);
        assert.strictEqual(s.row_count_from, 'dimension');
        assert.strictEqual(s.column_formats[1], 'hex_id');
    });

    console.log('\nScout — envelope (single .xlsx from disk)');
    await ok('buildSampleEnvelope records the headers for a dropped .xlsx', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-xlsx-'));
        const file = path.join(dir, 'return.xlsx');
        // Pad the workbook past 8 MB so the old 8 MB read cap would cut off the
        // ZIP directory (it sits at the end of the file).
        const z = new AdmZip(buildXlsx([{ name: 'CDR', rows: CDR_ROWS }]));
        z.addFile('xl/media/pad.bin', crypto.randomBytes(9 * 1024 * 1024));
        fs.writeFileSync(file, z.toBuffer());
        try {
            const env = await sb.buildSampleEnvelope(file, {});
            const e = env.tree[0];
            assert.strictEqual(e.format, 'excel');
            assert.strictEqual(env.schema_version, 5, 'schema stays v5 (additive)');
            assert.deepStrictEqual(e.structure.sheets[0].headers, HEAD);
            const all = JSON.stringify(env);
            for (const v of SECRET_VALUES) assert.ok(!all.includes(v), 'leaked: ' + v);
        } finally {
            try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch (_) {}
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
