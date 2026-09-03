/* Streaming CSV reader test for dw-csv-stream.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { parseCsv } = require('../discord-return-parser');
const { CsvRowScanner, streamCsvRows, streamCsvRowsFromFile } = require('../dw-csv-stream');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

// ── Helpers ────────────────────────────────────────────────────────────

function randomString(minLen, maxLen) {
    const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
    const codePoints = [
        // ASCII printable
        32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
        48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
        64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
        80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90,
        91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105,
        106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
        120, 121, 122, 123, 124, 125, 126,
        // Extended Latin / symbols
        0xA1, 0xA9, 0xAE, 0xB0, 0xB7, 0xC0, 0xD0, 0xE0, 0xF0,
        // CJK
        0x4E00, 0x4E2D, 0x6587, 0x8A00, 0x8A9E,
        // Emoji (valid astral code points)
        0x1F389, 0x1F680, 0x1F525, 0x1F4AF, 0x1F44D,
        0x1F431, 0x1F355, 0x1F30D, 0x2728, 0x1F3B5,
        // Control chars we want to exercise
        0x0D, 0x0A, 0x09,
    ];
    let s = '';
    for (let i = 0; i < len; i++) {
        const cp = codePoints[Math.floor(Math.random() * codePoints.length)];
        s += String.fromCodePoint(cp);
    }
    return s;
}

function generateRandomCsv() {
    const rows = [];
    const numRows = Math.floor(Math.random() * 20);
    for (let r = 0; r < numRows; r++) {
        const cols = [];
        const numCols = Math.floor(Math.random() * 5) + 1;
        for (let c = 0; c < numCols; c++) {
            let val = '';
            const type = Math.random();
            if (type < 0.2) {
                val = '';
            } else if (type < 0.4) {
                val = randomString(1, 20);
            } else if (type < 0.6) {
                val = randomString(1, 10) + ',' + randomString(1, 10);
            } else if (type < 0.8) {
                val = randomString(1, 5) + '\n' + randomString(1, 5);
            } else {
                val = randomString(1, 5) + '"' + randomString(1, 5);
            }
            if (Math.random() < 0.3 || val.includes(',') || val.includes('\n') || val.includes('"')) {
                val = '"' + val.replace(/"/g, '""') + '"';
            }
            cols.push(val);
        }
        rows.push(cols.join(','));
    }
    let doc = rows.join('\n');
    if (Math.random() < 0.1) {
        doc = '\uFEFF' + doc;
    }
    const trailing = Math.floor(Math.random() * 4);
    doc += '\n'.repeat(trailing);
    if (Math.random() < 0.05) {
        doc = '';
    }
    return doc;
}

function createChunkedReadable(str, chunkSizeFn) {
    const buf = Buffer.from(str, 'utf8');
    let offset = 0;
    return new Readable({
        read() {
            if (offset >= buf.length) {
                this.push(null);
                return;
            }
            const size = chunkSizeFn(buf.length - offset);
            const chunk = buf.slice(offset, offset + size);
            offset += size;
            this.push(chunk);
        }
    });
}

async function streamString(str, chunkSizeFn) {
    const rows = [];
    const readable = createChunkedReadable(str, chunkSizeFn);
    await streamCsvRows(readable, (row) => { rows.push(row); return true; });
    return rows;
}

// ── 1. Fuzz ────────────────────────────────────────────────────────────

(async () => {
    console.log('\n=== 1. Fuzz (300 docs) ===');
    for (let i = 0; i < 300; i++) {
        const doc = generateRandomCsv();
        let chunkSizeFn;
        if (i < 50) {
            chunkSizeFn = () => 1;
        } else if (i < 100) {
            chunkSizeFn = (remaining) => Math.min(remaining, Math.floor(Math.random() * 4) + 1);
        } else {
            chunkSizeFn = (remaining) => Math.max(1, Math.min(remaining, Math.floor(Math.random() * remaining * 0.3) + 1));
        }
        const streamed = await streamString(doc, chunkSizeFn);
        const parsed = parseCsv(doc);
        eq(`fuzz ${i}`, streamed, parsed);
    }

    // ── 2. Regression: BOM only at position 0 ──────────────────────────
    console.log('\n=== 2. Regression: BOM position ===');
    eq('BOM at 0 stripped', await streamString('\uFEFFa,b\n1,2', () => 3), [['a', 'b'], ['1', '2']]);
    eq('BOM mid-field kept', await streamString('a\uFEFFb,c\n1,2', () => 3), [['a\uFEFFb', 'c'], ['1', '2']]);

    // ── 3. Regression: "" escape split across chunk boundary ─────────
    console.log('\n=== 3. Regression: quote-escape split ===');
    const escDoc = 'a\n"he said ""hi"""';
    eq('escape split 1-byte', await streamString(escDoc, () => 1), [['a'], ['he said "hi"']]);
    eq('escape split at boundary', await streamString(escDoc, (rem) => rem > 12 ? 12 : 1), [['a'], ['he said "hi"']]);

    // ── 4. Regression: \r\n split across chunk boundary ──────────────
    console.log('\n=== 4. Regression: CRLF split ===');
    const crlfDoc = 'a,b\r\n1,2\r\n';
    eq('CRLF split 1-byte', await streamString(crlfDoc, () => 1), [['a', 'b'], ['1', '2']]);
    eq('CRLF split at boundary', await streamString(crlfDoc, (rem) => rem > 3 ? 3 : 1), [['a', 'b'], ['1', '2']]);

    // ── 5. Regression: quoted newline split across boundary ──────────
    console.log('\n=== 5. Regression: quoted newline split ===');
    const qnlDoc = 'a,b\n"line1\nline2",2';
    eq('quoted newline split 1-byte', await streamString(qnlDoc, () => 1), [['a', 'b'], ['line1\nline2', '2']]);
    eq('quoted newline split at boundary', await streamString(qnlDoc, (rem) => rem > 7 ? 7 : 1), [['a', 'b'], ['line1\nline2', '2']]);

    // ── 6. Regression: unterminated quote at EOF ─────────────────────
    console.log('\n=== 6. Regression: unterminated quote ===');
    const untermDoc = 'a\n"no close';
    eq('unterminated quote matches parseCsv', await streamString(untermDoc, () => 2), parseCsv(untermDoc));

    // ── 7. Regression: bare \r outside quotes dropped ─────────────────
    console.log('\n=== 7. Regression: bare CR dropped ===');
    const crDoc = 'a\rb\nc\r\nd';
    eq('bare CR dropped', await streamString(crDoc, () => 1), [['ab'], ['c'], ['d']]);
    const crInQuote = 'a\n"line1\rline2",2';
    eq('CR inside quotes kept', await streamString(crInQuote, () => 1), [['a'], ['line1\rline2', '2']]);

    // ── 8. Regression: empty documents ──────────────────────────────
    console.log('\n=== 8. Regression: empty documents ===');
    eq('empty string', await streamString('', () => 1), []);
    eq('only newlines', await streamString('\n\n\n', () => 1), []);
    eq('only commas', await streamString(',\n,\n', () => 1), []);

    // ── 9. Regression: early termination ─────────────────────────────
    console.log('\n=== 9. Regression: early termination ===');
    const termDoc = 'a\n1\n2\n3\n4\n5';
    let termCount = 0;
    const termReadable = createChunkedReadable(termDoc, () => 2);
    const termResult = await streamCsvRows(termReadable, (row, idx) => {
        termCount++;
        return idx < 2; // stop after 3 rows (0, 1, 2)
    });
    eq('early termination count', termResult, 3);

    // ── 10. Bounded memory ───────────────────────────────────────────
    console.log('\n=== 10. Bounded memory (300+ MB file) ===');
    const tmpFile = path.join(os.tmpdir(), `dw-csv-stream-mem-${Date.now()}.csv`);
    const targetRows = 2200000;
    const batchSize = 5000;
    let written = 0;
    const fd = fs.openSync(tmpFile, 'w');

    for (let batchStart = 0; batchStart < targetRows; batchStart += batchSize) {
        const lines = [];
        const end = Math.min(batchStart + batchSize, targetRows);
        for (let i = batchStart; i < end; i++) {
            const channelId = (1000000000000000000n + BigInt(i % 100)).toString();
            const msgId = (9000000000000000000n + BigInt(i)).toString();
            const authorId = '7001';
            const ts = '2024-01-05T13:32:11.000Z';
            const username = 'user#0';
            let contents;
            if (i % 200 === 0) {
                contents = '"line1\nline2\nline3 with ""quotes"" and , comma"';
            } else if (i % 20 === 0) {
                contents = '"text with, comma and \r\n CRLF"';
            } else {
                contents = `normal text ${i}`;
            }
            let attachments = '';
            if (i % 50 === 0) {
                attachments = '"https://cdn.discordapp.com/attachments/1/2/img.jpg\nhttps://cdn.discordapp.com/attachments/1/3/img2.jpg"';
            }
            lines.push(`${channelId},${msgId},${authorId},${ts},${username},${contents},${attachments},`);
        }
        fs.writeSync(fd, lines.join('\n') + '\n');
        written += (end - batchStart);
    }
    fs.closeSync(fd);

    const fileSizeMB = (fs.statSync(tmpFile).size / 1048576).toFixed(1);
    console.log(`  File size: ${fileSizeMB} MB, target rows: ${targetRows}, written: ${written}`);

    const heapSamples = [];
    const rssSamples = [];
    let rowCount = 0;
    await streamCsvRowsFromFile(tmpFile, (row) => {
        rowCount++;
        if (rowCount % 50000 === 0) {
            const mem = process.memoryUsage();
            heapSamples.push(mem.heapUsed);
            rssSamples.push(mem.rss);
        }
        return true;
    });

    const peakHeapMB = Math.max(...heapSamples) / 1048576;
    const peakRssMB = Math.max(...rssSamples) / 1048576;
    console.log(`  Peak heapUsed: ${peakHeapMB.toFixed(1)} MB, peak rss: ${peakRssMB.toFixed(1)} MB`);
    ok('peak heap under 200 MB', peakHeapMB < 200, `peak was ${peakHeapMB.toFixed(1)} MB`);
    eq('row count exact', rowCount, written);

    fs.unlinkSync(tmpFile);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e.stack || e); process.exit(1); });
