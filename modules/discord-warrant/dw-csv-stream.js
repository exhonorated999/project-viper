/**
 * Discord return CSV — streaming row scanner.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * `discord-return-parser.js` used to read each messages/<bucket>/<id>.csv
 * fully into a JS string and run a synchronous parseCsv() over it.  That
 * held up to the 384 MB / 541,831-message return we measured in 5.1.7, but
 * a second agency's return is 2.36 GB with a SINGLE message CSV of 355 MB
 * (~2.4 million rows).  Buffering that file costs a 355 MB string, a
 * ~1.2 GB array-of-arrays and then a ~1.5 GB array of message objects, all
 * live at once — the main process is dead long before sharding can help.
 *
 * This scanner emits one row at a time with peak memory bounded by the
 * largest single row, so the parser can hand each message straight to the
 * SQLite writer and forget it.
 *
 * ── Contract ────────────────────────────────────────────────────────────
 * Output MUST be identical to parseCsv() in discord-return-parser.js, whose
 * quirks are load-bearing on real evidence and therefore deliberate:
 *   • BOM is stripped only at offset 0.
 *   • A bare '\r' OUTSIDE quotes is dropped wherever it appears; a '\r'
 *     INSIDE quotes is kept.  There is no CRLF pairing state.
 *   • '""' inside a quoted field is a literal quote.
 *   • A '"' encountered mid-field outside quotes turns quoting ON — real
 *     returns contain unescaped quotes and this is how the shipped parser
 *     has always read them.
 *   • Every trailing all-empty row is discarded.
 *
 * parseCsv looks ahead exactly ONE character (the '""' escape test), so
 * that single pending-quote decision is the only state that has to survive
 * a chunk boundary.  Everything else is character-local.
 *
 * Main-process only in practice, but it imports nothing from Electron so it
 * runs under plain `node` for tests.
 */

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

// Consecutive all-empty rows are held back so they can be dropped if they
// turn out to be trailing.  Real message CSVs never have runs anywhere near
// this long; the cap just stops a pathological file from growing the queue.
const MAX_PENDING_EMPTY = 4096;

class CsvRowScanner {
    constructor() {
        this.field = '';
        this.row = [];
        this.inQuotes = false;
        this.started = false;
        this.atStart = true;        // BOM is only stripped at offset 0
        this.quotePending = false;  // inside quotes, saw '"', next char decides
        this.pendingEmpty = [];
        this.stopped = false;
    }

    /** Emit a completed row, deferring runs of all-empty rows. */
    _emit(onRow) {
        this.row.push(this.field);
        const row = this.row;
        this.row = [];
        this.field = '';
        this.started = false;

        if (row.every(c => c === '')) {
            this.pendingEmpty.push(row);
            if (this.pendingEmpty.length > MAX_PENDING_EMPTY) {
                this._deliver(this.pendingEmpty.shift(), onRow);
            }
            return;
        }
        if (this.pendingEmpty.length) {
            const held = this.pendingEmpty;
            this.pendingEmpty = [];
            for (const r of held) {
                this._deliver(r, onRow);
                if (this.stopped) return;
            }
        }
        this._deliver(row, onRow);
    }

    _deliver(row, onRow) {
        if (this.stopped) return;
        if (onRow(row) === false) this.stopped = true;
    }

    /**
     * Feed an arbitrary string chunk.  May split anywhere — mid-quoted-field,
     * between the two characters of a '""' escape, between '\r' and '\n'.
     * @returns {boolean} false once a consumer has asked to stop.
     */
    feed(text, onRow) {
        if (this.stopped || !text) return !this.stopped;
        let i = 0;

        if (this.atStart) {
            this.atStart = false;
            if (text.charCodeAt(0) === 0xFEFF) i = 1;
        }

        // Resolve a '"' that ended the previous chunk while inside quotes.
        if (this.quotePending && i < text.length) {
            this.quotePending = false;
            if (text[i] === '"') { this.field += '"'; i++; }
            else this.inQuotes = false;
        }

        for (; i < text.length; i++) {
            const ch = text[i];

            if (this.inQuotes) {
                if (ch === '"') {
                    if (i + 1 < text.length) {
                        if (text[i + 1] === '"') { this.field += '"'; i++; }
                        else this.inQuotes = false;
                    } else {
                        // Decision needs the next chunk's first character.
                        this.quotePending = true;
                    }
                } else {
                    this.field += ch;
                }
                continue;
            }

            if (ch === '"') { this.inQuotes = true; this.started = true; continue; }
            if (ch === ',') { this.row.push(this.field); this.field = ''; this.started = true; continue; }
            if (ch === '\r') continue;
            if (ch === '\n') {
                this._emit(onRow);
                if (this.stopped) return false;
                continue;
            }
            this.field += ch;
            this.started = true;
        }
        return !this.stopped;
    }

    /** Flush the final partial row. Trailing all-empty rows are discarded. */
    end(onRow) {
        if (this.stopped) return;
        if (this.quotePending) {
            // EOF right after a quote: parseCsv's s[i+1] is undefined, which
            // is not '"', so quoting simply closes.
            this.quotePending = false;
            this.inQuotes = false;
        }
        if (this.started || this.field !== '' || this.row.length) {
            this._emit(onRow);
        }
        this.pendingEmpty = [];
    }
}

/**
 * Consume a Readable of Buffers and call onRow(row, index) per CSV row.
 * `for await` gives us backpressure for free, which matters because onRow
 * does a synchronous SQLite insert.  Returning the literal `false` from
 * onRow stops early and destroys the stream.
 *
 * @returns {Promise<number>} rows emitted
 */
async function streamCsvRows(readable, onRow) {
    const scanner = new CsvRowScanner();
    const decoder = new StringDecoder('utf8');
    let count = 0;
    let stopped = false;

    const sink = (row) => {
        const r = onRow(row, count);
        count++;
        if (r === false) { stopped = true; return false; }
        return true;
    };

    try {
        for await (const chunk of readable) {
            scanner.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk), sink);
            if (stopped) break;
        }
        if (!stopped) {
            const tail = decoder.end();
            if (tail) scanner.feed(tail, sink);
        }
        if (!stopped) scanner.end(sink);
    } finally {
        if (stopped) { try { readable.destroy(); } catch (_) { /* already gone */ } }
    }
    return count;
}

async function streamCsvRowsFromFile(filePath, onRow) {
    return streamCsvRows(fs.createReadStream(filePath, { highWaterMark: 1 << 18 }), onRow);
}

module.exports = { CsvRowScanner, streamCsvRows, streamCsvRowsFromFile, MAX_PENDING_EMPTY };
