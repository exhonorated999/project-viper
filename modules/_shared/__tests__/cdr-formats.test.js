/**
 * CDR tab — T-Mobile (and legacy Sprint) format support.
 * modules/_shared/cdr-formats.js plus the CDR tab code LIFTED from
 * case-detail-with-analytics.html (parseCDRFile → mapping modal →
 * processCDRData → calculateCDRStatistics).
 *
 * Why: an officer's T-Mobile return came as .xlsx with title rows above the
 * column header. The CDR tab only took CSV/TXT, looked for the header in the
 * first 5 lines, read 06/13/2025 day-first (month 13 → January 2026), read
 * UTC times as local, turned an unreadable date into "now", and did not know
 * T-Mobile call codes (mSOriginating, …SMSinMSC, vONR_, RCS…).
 *
 * All data here is synthetic (555-01xx numbers, made-up IMEI/IMSI/towers).
 *
 * Run: node modules\_shared\__tests__\cdr-formats.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..', '..');
const CF = require('../cdr-formats');
const CD = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
async function ok(label, fn) {
    try { await fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + (e && e.message)); failed++; }
}

// ── synthetic T-Mobile sheet ──────────────────────────────────────
const TM_HEAD = ['Date', '(UTC) Time', 'Duration', 'Call Type', 'Direction', 'Calling Number', 'Dialed Digits',
    'Called Number', 'Destination Number', 'IMEI', 'IMSI', 'Completion Code', 'SS Codes', 'Switch',
    '1st Tower LAT', '1st Tower LONG', '1st Tower Azimuth', 'Last Tower LAT', 'Last Tower LONG'];
const SERIAL_0614 = String(Date.UTC(2025, 5, 14) / 86400000 + 25569);       // Excel serial for 2025-06-14
function tmRow(date, time, dur, type, dir, a, b, lat, lon, az) {
    return [date, time, dur, type, dir, a, b, b, '', '000000000000011', '310260000000011', '0', '', 'SW01',
        lat, lon, az, lat, lon];
}
const TM_ROWS = [
    ['T-Mobile USA, Inc. — Law Enforcement Relations'],
    ['Tracking ID: 0000000', '', 'Target: 15555550100'],
    ['Report Date Range: 06/01/2025 - 06/30/2025'],
    [],
    TM_HEAD,
    tmRow('06/13/2025', '23:30:00', '83', 'mSOriginating', 'Outgoing', '15555550100', '15555550123', '39.700000', '-105.000000', '120'),
    tmRow('06/13/2025', '23:45:10', '0', 'mSTerminatingSMSinMSC', '', '1.5555550123E+10', '15555550100', '39.700000', '-105.000000', '120'),
    tmRow(SERIAL_0614, '01:02:03', '00:01:05', 'vONR_Terminating', '', '15555550124', '15555550100', '39.710000', '-105.010000', '240'),
    tmRow('06/14/2025', '02:00:00', '0', 'RCS-Chat', 'Incoming', '15555550125', '15555550100', '', '', ''),
    tmRow('06/14/2025', '03:00:00', '12', 'callForwarding', '', '15555550100', '15555550126', '', '', ''),
    tmRow('not a date', '04:00:00', '5', 'mtc', '', '15555550127', '15555550100', '', '', ''),
    [],
];

// ── lift the CDR tab functions out of case-detail ─────────────────
function lift(name) {
    const re = new RegExp('\\n\\s*(async\\s+)?function ' + name + '\\s*\\(');
    const m = re.exec(CD);
    if (!m) throw new Error('lift: ' + name + ' not found');
    const start = m.index + 1;
    let i = CD.indexOf('{', start), depth = 0;
    for (; i < CD.length; i++) {
        const c = CD[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    return CD.slice(start, i + 1);
}
const LIFTED = ['_cdrEsc', 'autoDetectCdrColumns', 'showColumnMappingModal', 'renderColumnMappingField',
    'closeColumnMappingModal', 'submitColumnMapping', 'processCDRData', 'parseTimestamp', 'normalizeCallType',
    'calculateCDRStatistics', 'groupRecordsByHour', 'parseCDRFile'];

function makeTab() {
    const sb = {
        console, Date, Math, JSON, Promise, setTimeout, Set, Map, Object, Array, String, Number, isFinite, isNaN, parseFloat,
        CdrFormats: CF,
        toasts: [], saved: null, html: '', loading: 0,
        showToast(m, t) { sb.toasts.push({ m, t }); },
        showLoadingIndicator() { sb.loading++; }, hideLoadingIndicator() { sb.loading--; },
        getCDRDumpsForCase() { return []; },
        async saveCDRDumps(d) { sb.saved = d; return true; },
        renderTabContent() {},
        audit() {},
        Papa: { parse(text, o) { return { data: text.split('\n').filter(l => !o.skipEmptyLines || l.trim()).map(l => l.split(',')) }; } },
        FormData: function (form) { this._f = form; },
        document: {
            body: { insertAdjacentHTML(_, h) { sb.html += h; } },
            getElementById() { return null; },
        },
    };
    sb.FormData.prototype.entries = function () { return Object.entries(this._f.values); };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(LIFTED.map(lift).join('\n\n'), sb);
    return sb;
}

// old CDR-tab parseTimestamp (unchanged in the file, still used only when
// CdrFormats is missing) — kept to prove the regression it caused.
function oldParseTimestamp() { return makeTab().parseTimestamp.apply(null, arguments); }

(async () => {
    console.log('\ncdr-formats — header / sheet / carrier');

    await ok('header row found under T-Mobile title rows', () => {
        assert.strictEqual(CF.findHeaderRow(TM_ROWS), 4);
    });
    await ok('banner rows and data rows score 0', () => {
        assert.strictEqual(CF.headerScore(TM_ROWS[0]), 0);
        assert.strictEqual(CF.headerScore(TM_ROWS[5]), 0);
        assert.strictEqual(CF.headerScore([]), 0);
    });
    await ok('pickSheet picks the CDR sheet over a subscriber sheet', () => {
        const sub = [['Subscriber Information'], ['Name', 'Address', 'Account Number', 'Start Date', 'End Date'], ['REDACTED', 'REDACTED', '0000', '01/01/2020', '']];
        const p = CF.pickSheet([{ name: 'Subscriber', rows: sub }, { name: 'CDR', rows: TM_ROWS }]);
        assert.strictEqual(p.name, 'CDR');
        assert.strictEqual(p.headerRow, 4);
        assert.strictEqual(CF.pickSheet([{ name: 'x', rows: [['hello']] }]), null);
    });
    await ok('uniqueHeaders names blanks and de-duplicates', () => {
        assert.deepStrictEqual(CF.uniqueHeaders(['Date', '', 'Date', ' Time ']), ['Date', 'Column 2', 'Date (2)', 'Time']);
    });
    await ok('rowsToRecords skips blank rows', () => {
        const r = CF.rowsToRecords(TM_ROWS, 4);
        assert.strictEqual(r.records.length, 6);
        assert.strictEqual(r.records[0]['Call Type'], 'mSOriginating');
    });
    await ok('detectCarrier: banner, T-Mobile headers, legacy Sprint, AT&T', () => {
        assert.strictEqual(CF.detectCarrier(TM_ROWS, 4, 'return.xlsx'), 'T-Mobile');
        assert.strictEqual(CF.detectCarrier([TM_HEAD], 0, 'x.xlsx'), 'T-Mobile');
        assert.strictEqual(CF.detectCarrier([['Calling number', 'Called number', 'Mobile Role', 'Start Date', 'NEID', 'First Cell']], 0, ''), 'T-Mobile');
        assert.strictEqual(CF.detectCarrier([['LAT: 33.1, LON: -117.2'], ['Source', 'Conn Date', 'Conn Time', 'Originating Number']], 1, ''), 'AT&T');
        assert.strictEqual(CF.detectCarrier([['Verizon Wireless'], ['Date', 'Time', 'Number', 'Type']], 1, ''), 'Verizon');
        assert.strictEqual(CF.detectCarrier([['Date', 'Time', 'Number', 'Type']], 0, ''), '');
    });

    console.log('\ncdr-formats — T-Mobile mapping');
    await ok('tmobileMapping maps the T-Mobile network report columns', () => {
        const m = CF.tmobileMapping(TM_HEAD);
        assert.strictEqual(m.phoneA, 'Calling Number');
        assert.strictEqual(m.phoneB, 'Called Number');
        assert.strictEqual(m.date, 'Date');
        assert.strictEqual(m.time, '(UTC) Time');
        assert.strictEqual(m.callType, 'Call Type');
        assert.strictEqual(m.direction, 'Direction');
        assert.strictEqual(m.duration, 'Duration');
        assert.strictEqual(m.towerLat, '1st Tower LAT');
        assert.strictEqual(m.towerLon, '1st Tower LONG');
        assert.strictEqual(m.azimuth, '1st Tower Azimuth');
        assert.ok(!Object.values(m).includes('Switch'), 'Switch is not a location');
    });
    await ok('tmobileMapping maps legacy Sprint columns (Start Date carries date+time)', () => {
        const m = CF.tmobileMapping(['Calling number', 'Called number', 'Dialed digits', 'Mobile Role', 'Start Date', 'End Date', 'Duration (s)', 'Call Type', 'NEID', 'First Cell', 'Last Cell']);
        assert.strictEqual(m.datetime, 'Start Date');
        assert.ok(!m.date && !m.time);
        assert.strictEqual(m.direction, 'Mobile Role');
        assert.strictEqual(m.towerA, 'First Cell');
        assert.strictEqual(m.towerB, 'Last Cell');
        assert.strictEqual(m.duration, 'Duration (s)');
    });

    console.log('\ncdr-formats — dates');
    await ok('06/13/2025 is June 13 (month first); UTC kept as UTC', () => {
        assert.strictEqual(CF.parseDateTime('06/13/2025', '23:30:00', { utc: true }), '2025-06-13T23:30:00.000Z');
    });
    await ok('REGRESSION: the old CDR-tab parser read 06/13/2025 as month 13', () => {
        const old = oldParseTimestamp('06/13/2025', '23:30:00');
        assert.ok(!/^2025-06-1[34]/.test(old), 'old parser got it right?? ' + old);
        assert.ok(/^2026-01/.test(old), 'expected a January 2026 rollover, got ' + old);
    });
    await ok('REGRESSION: the old parser turned an unreadable date into "now"', () => {
        const old = oldParseTimestamp('not a date', '');
        assert.ok(Math.abs(Date.parse(old) - Date.now()) < 60000, 'expected "now", got ' + old);
        assert.strictEqual(CF.parseDateTime('not a date', ''), null);
    });
    await ok('local (non-UTC) times stay local wall-clock', () => {
        assert.strictEqual(CF.parseDateTime('2025-06-13', '14:03:22'), new Date(2025, 5, 13, 14, 3, 22).toISOString());
    });
    await ok('13/06/2025 can only be day-first', () => {
        assert.strictEqual(CF.parseDateTime('13/06/2025', '00:00:00', { utc: true }), '2025-06-13T00:00:00.000Z');
    });
    await ok('combined, AM/PM, 2-digit year, YYYYMMDD, month names, ISO with zone', () => {
        assert.strictEqual(CF.parseDateTime('1/2/2024 3:04:05 PM', '', { utc: true }), '2024-01-02T15:04:05.000Z');
        assert.strictEqual(CF.parseDateTime('06/13/25', '12:00 AM', { utc: true }), '2025-06-13T00:00:00.000Z');
        assert.strictEqual(CF.parseDateTime('20250613', '140322', { utc: true }), '2025-06-13T14:03:22.000Z');
        assert.strictEqual(CF.parseDateTime('13-Jun-2025', '', { utc: true }), '2025-06-13T00:00:00.000Z');
        assert.strictEqual(CF.parseDateTime('June 13, 2025', '', { utc: true }), '2025-06-13T00:00:00.000Z');
        assert.strictEqual(CF.parseDateTime('2025-06-13T14:03:22-06:00', ''), '2025-06-13T20:03:22.000Z');
        assert.strictEqual(CF.parseDateTime('2025-06-13 14:03:22 UTC', '', { utc: true }), '2025-06-13T14:03:22.000Z');
    });
    await ok('Excel serial date and serial date+time', () => {
        assert.strictEqual(CF.parseDateTime(SERIAL_0614, '01:02:03', { utc: true }), '2025-06-14T01:02:03.000Z');
        assert.strictEqual(CF.parseDateTime(String(+SERIAL_0614 + 0.5), '', { utc: true }), '2025-06-14T12:00:00.000Z');
        assert.strictEqual(CF.parseDateTime('2025-06-14', '0.25', { utc: true }), '2025-06-14T06:00:00.000Z');
    });
    await ok('rejects 02/31, month 13 both ways, bad times, years out of range, time-only', () => {
        assert.strictEqual(CF.parseDateTime('02/31/2025', '', { utc: true }), null);
        assert.strictEqual(CF.parseDateTime('02/31/2025', ''), null);
        assert.strictEqual(CF.parseDateTime('13/13/2025', ''), null);
        assert.strictEqual(CF.parseDateTime('06/13/2025', '25:00:00'), null);
        assert.strictEqual(CF.parseDateTime('06/13/1900', ''), null);
        assert.strictEqual(CF.parseDateTime('', '14:00:00'), null);
        assert.strictEqual(CF.parseDateTime('', ''), null);
    });

    console.log('\ncdr-formats — call types, durations, numbers');
    await ok('T-Mobile call codes', () => {
        const t = (a, d) => CF.callType(a, d);
        assert.strictEqual(t('mSOriginating'), 'voice-outgoing');
        assert.strictEqual(t('mSTerminating'), 'voice-incoming');
        assert.strictEqual(t('mSOriginatingSMSinMSC'), 'sms-outgoing');
        assert.strictEqual(t('mSTerminatingSMSinMSC'), 'sms-incoming');
        assert.strictEqual(t('moc'), 'voice-outgoing');
        assert.strictEqual(t('mtc'), 'voice-incoming');
        assert.strictEqual(t('iMS_Originating'), 'voice-outgoing');
        assert.strictEqual(t('iMS_Terminating'), 'voice-incoming');
        assert.strictEqual(t('iMS_Forwarded'), 'voice-forwarded');
        assert.strictEqual(t('vONR_Originating'), 'voice-outgoing');
        assert.strictEqual(t('vONR_Terminating'), 'voice-incoming');
        assert.strictEqual(t('mO_Epsfb'), 'voice-outgoing');
        assert.strictEqual(t('mT_Epsfb'), 'voice-incoming');
        assert.strictEqual(t('callForwarding'), 'voice-forwarded');
        assert.strictEqual(t('SMSc', 'Incoming'), 'sms-incoming');
        assert.strictEqual(t('RCS-Chat', 'Outgoing'), 'sms-outgoing');
        assert.strictEqual(t('VoLTE', 'Originating'), 'voice-outgoing');
        assert.strictEqual(t('VoWiFi', 'Terminating'), 'voice-incoming');
        assert.strictEqual(t('MO'), '', 'AT&T MO is left to the CDR tab table');
        assert.strictEqual(t('', 'Outgoing'), 'voice-outgoing');
        assert.strictEqual(t('', ''), '');
    });
    await ok('durations: seconds, minutes, hh:mm:ss, mm:ss, blanks', () => {
        assert.strictEqual(CF.durationSeconds('83'), 83);
        assert.strictEqual(CF.durationSeconds('1.5', true), 90);
        assert.strictEqual(CF.durationSeconds('00:01:23'), 83);
        assert.strictEqual(CF.durationSeconds('1:05'), 65);
        assert.strictEqual(CF.durationSeconds(''), 0);
        assert.strictEqual(CF.durationSeconds('n/a'), 0);
    });
    await ok('cleanNumber undoes Excel E+ notation and trailing .0', () => {
        assert.strictEqual(CF.cleanNumber('1.5555550123E+10'), '15555550123');
        assert.strictEqual(CF.cleanNumber('15555550123.0'), '15555550123');
        assert.strictEqual(CF.cleanNumber(' 5555550100 '), '5555550100');
        assert.strictEqual(CF.cleanNumber(null), '');
    });
    await ok('carrierTimesUtc', () => {
        assert.strictEqual(CF.carrierTimesUtc('T-Mobile', []), true);
        assert.strictEqual(CF.carrierTimesUtc('', ['Date', 'Time (GMT)']), true);
        assert.strictEqual(CF.carrierTimesUtc('AT&T', ['Conn Date', 'Conn Time']), false);
    });

    console.log('\nCDR tab — wiring (case-detail)');
    await ok('cdr-formats.js loads in case-detail', () => {
        assert.ok(/<script src="modules\/_shared\/cdr-formats\.js" defer><\/script>/.test(CD));
        assert.ok(/<script src="modules\/flock\/flock-xlsx\.js" defer><\/script>/.test(CD));
    });
    await ok('upload accepts Excel; legacy .xls gets a Save As message', () => {
        assert.ok(/input\.accept = '\.csv,\.txt,\.xlsx,\.xlsm,\.xls';/.test(lift('uploadCDRFile')));
        assert.ok(/Save As/.test(lift('parseCDRFile')));
        assert.ok(/FlockXlsx\.readWorkbook/.test(lift('parseCDRFile')));
    });
    await ok('no tab or module was added (T-Mobile is a format inside the CDR tab)', () => {
        const all = (CD.match(/'TMOBILE'/g) || []).length;
        const inCdr = LIFTED.map(lift).join('\n').match(/'TMOBILE'/g) || [];
        assert.ok(all > 0 && all === inCdr.length, 'TMOBILE used outside the CDR tab functions');
    });

    console.log('\nCDR tab — end to end (lifted)');
    async function openAndSubmit(tab, rows, fileName, formOverrides) {
        // Feed parseCDRFile a CSV built from rows (Papa stub splits on commas).
        const text = rows.map(r => r.join(',')).join('\n');
        await tab.parseCDRFile({ name: fileName, text: async () => text });
        const html = tab.html;
        // Collect the modal's pre-selected values the way the form would.
        const values = {};
        const selRe = /<select name="(\w+)"[\s\S]*?<\/select>/g;
        let m;
        while ((m = selRe.exec(html))) {
            const sel = /<option value="([^"]*)" selected>/.exec(m[0]);
            values[m[1]] = sel ? sel[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'") : '';
        }
        if (/name="tzUtc" value="1" class="mt-1" checked/.test(html)) values.tzUtc = '1';
        Object.assign(values, formOverrides || {});
        const fmt = /submitColumnMapping\(event, null, '(\w+)'\)/.exec(html)[1];
        await tab.submitColumnMapping({ preventDefault() {}, target: { values } }, null, fmt);
        return { html, values, fmt, dump: tab.saved && tab.saved[0] };
    }

    await ok('T-Mobile return: banner skipped, pre-mapped, UTC pre-checked, codes read', async () => {
        const tab = makeTab();
        const { html, values, fmt, dump } = await openAndSubmit(tab, TM_ROWS, 'tmobile-return.csv');
        assert.strictEqual(fmt, 'TMOBILE');
        assert.ok(/T-Mobile Format Detected/.test(html));
        assert.strictEqual(values.tzUtc, '1');
        assert.strictEqual(values.direction, 'Direction');
        assert.strictEqual(values.time, '(UTC) Time');
        assert.ok(dump, 'dump saved');
        assert.strictEqual(dump.carrier, 'T-Mobile');
        assert.strictEqual(dump.timesUtc, true);
        assert.strictEqual(dump.records.length, 6);
        const r = dump.records;
        assert.strictEqual(r[0].timestamp, '2025-06-13T23:30:00.000Z');
        assert.strictEqual(r[0].callType, 'voice-outgoing');
        assert.strictEqual(r[0].duration, 83);
        assert.strictEqual(r[1].callType, 'sms-incoming');
        assert.strictEqual(r[1].phoneA, '15555550123', 'E+ number restored');
        assert.strictEqual(r[2].timestamp, '2025-06-14T01:02:03.000Z', 'Excel serial date');
        assert.strictEqual(r[2].duration, 65);
        assert.strictEqual(r[2].callType, 'voice-incoming');
        assert.strictEqual(r[3].callType, 'sms-incoming');
        assert.strictEqual(r[4].callType, 'voice-forwarded');
        assert.strictEqual(r[5].timestamp, '');
        assert.strictEqual(r[5].timeUnknown, true);
        assert.strictEqual(dump.unreadableDates, 1);
        assert.strictEqual(dump.stats.dateRange.start, '2025-06-13T23:30:00.000Z');
        assert.strictEqual(dump.stats.dateRange.end, '2025-06-14T03:00:00.000Z');
        assert.strictEqual(dump.stats.callTypes['voice-outgoing'], 1);
        assert.strictEqual(dump.stats.callTypes['sms-incoming'], 2);
        assert.ok(dump.hasGeo);
        assert.strictEqual(dump.points.length, 2, 'two tower sectors');
        assert.ok(/could not read/.test(tab.toasts.map(t => t.m).join(' ')), 'officer told about the unreadable date');
        assert.strictEqual(tab.loading, 0, 'loading indicator closed');
    });
    await ok('UTC unchecked → local wall-clock', async () => {
        const tab = makeTab();
        const text = TM_ROWS.map(r => r.join(',')).join('\n');
        await tab.parseCDRFile({ name: 't.csv', text: async () => text });
        const values = Object.assign({}, CF.tmobileMapping(TM_HEAD));
        await tab.submitColumnMapping({ preventDefault() {}, target: { values } }, null, 'TMOBILE');
        assert.strictEqual(tab.saved[0].records[0].timestamp, new Date(2025, 5, 13, 23, 30, 0).toISOString());
        assert.strictEqual(tab.saved[0].timesUtc, false);
    });
    await ok('legacy Sprint return (Mobile Role + VoLTE, Start Date with time)', async () => {
        const tab = makeTab();
        const rows = [
            ['Calling number', 'Called number', 'Dialed digits', 'Mobile Role', 'Start Date', 'End Date', 'Duration (s)', 'Call Type', 'NEID', 'First Cell', 'Last Cell'],
            ['5555550100', '5555550123', '5555550123', 'Originating', '1/2/2024 3:04:05 PM', '1/2/2024 3:05:05 PM', '60', 'VoLTE', '100', '0000-0001', '0000-0002'],
            ['5555550123', '5555550100', '', 'Terminating', '1/2/2024 4:00:00 PM', '', '30', 'VoWiFi', '100', '0000-0003', ''],
        ];
        const { fmt, dump, values } = await openAndSubmit(tab, rows, 'sprint.csv');
        assert.strictEqual(fmt, 'TMOBILE');
        assert.strictEqual(values.datetime, 'Start Date');
        assert.strictEqual(dump.records[0].callType, 'voice-outgoing');
        assert.strictEqual(dump.records[1].callType, 'voice-incoming');
        assert.strictEqual(dump.records[0].timestamp, '2024-01-02T15:04:05.000Z');
        assert.strictEqual(dump.records[0].towerA, '0000-0001');
        assert.strictEqual(dump.records[0].towerB, '0000-0002');
    });
    await ok('AT&T still works: banner LAT/LON, Source + MO/MT, minutes; now month-first', async () => {
        const tab = makeTab();
        const rows = [
            ['LAT: 33.100000', ' LON: -117.200000'],
            ['Source', 'Conn Date', 'Conn Time', 'Originating Number', 'Terminating Number', 'Call Type', 'Minutes', 'IMEI', 'Cell Tower'],
            ['Voice', '06/13/2025', '14:03:22', '5555550100', '5555550123', 'MO', '1.5', '000000000000011', '1234'],
            ['SMS', '06/13/2025', '14:10:00', '5555550123', '5555550100', 'MT', '0', '000000000000011', '1234'],
        ];
        const { fmt, dump } = await openAndSubmit(tab, rows, 'att.csv');
        assert.strictEqual(fmt, 'ATT');
        assert.strictEqual(dump.carrier, 'AT&T');
        assert.strictEqual(dump.timesUtc, false);
        assert.strictEqual(dump.refLat, 33.1);
        assert.strictEqual(dump.refLon, -117.2);
        assert.strictEqual(dump.records[0].callType, 'voice-outgoing');
        assert.strictEqual(dump.records[1].callType, 'sms-incoming');
        assert.strictEqual(dump.records[0].duration, 90);
        assert.strictEqual(dump.records[0].timestamp, new Date(2025, 5, 13, 14, 3, 22).toISOString());
    });
    await ok('generic CSV with header on line 1 unchanged', async () => {
        const tab = makeTab();
        const rows = [
            ['Date', 'Time', 'From', 'To', 'Type', 'Duration'],
            ['2025-06-13', '14:03:22', '5555550100', '5555550123', 'MOC', '42'],
        ];
        const { fmt, dump } = await openAndSubmit(tab, rows, 'generic.csv');
        assert.strictEqual(fmt, 'STANDARD');
        assert.strictEqual(dump.records[0].phoneA, '5555550100');
        assert.strictEqual(dump.records[0].callType, 'voice-outgoing');
        assert.strictEqual(dump.records[0].duration, 42);
        assert.strictEqual(dump.records[0].timestamp, new Date(2025, 5, 13, 14, 3, 22).toISOString());
    });
    await ok('headers are escaped in the mapping modal', async () => {
        const tab = makeTab();
        const text = ['Date,Time,Calling Number,Called Number,<img src=x onerror=alert(1)>', '06/13/2025,01:00:00,5555550100,5555550123,x'].join('\n');
        await tab.parseCDRFile({ name: '<b>x</b>.csv', text: async () => text });
        assert.ok(!/<img src=x/.test(tab.html));
        assert.ok(/&lt;img src=x/.test(tab.html));
        assert.ok(!/<b>x<\/b>/.test(tab.html));
    });
    await ok('legacy .xls refused with a Save As message', async () => {
        const tab = makeTab();
        await tab.parseCDRFile({ name: 'return.xls', text: async () => '' });
        assert.strictEqual(tab.html, '');
        assert.ok(/Save As/.test(tab.toasts[0].m));
    });
    await ok('stats + hour groups survive records with no readable date', () => {
        const tab = makeTab();
        const s = tab.calculateCDRStatistics([{ phoneA: 'a', phoneB: 'b', callType: 'voice', duration: 1, timestamp: '' }]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(s.dateRange)), { start: '', end: '', days: 0 });
        assert.strictEqual(tab.groupRecordsByHour([{ timestamp: '' }, { timestamp: 'junk' }]).size, 0);
        const s2 = tab.calculateCDRStatistics([{ timestamp: 1749772800000, duration: 0 }]);
        assert.strictEqual(s2.dateRange.start, '2025-06-13T00:00:00.000Z', 'numeric (AMP) timestamps still count');
    });

    console.log('\nCDR tab — real .xlsx through FlockXlsx');
    await ok('T-Mobile .xlsx (title rows + subscriber sheet) → CDR sheet', async () => {
        let DOMParser;
        try { DOMParser = require('@xmldom/xmldom').DOMParser; } catch (_) { DOMParser = null; }
        if (!DOMParser || typeof DecompressionStream === 'undefined') { console.log('        (skipped: no DOMParser shim)'); return; }
        global.DOMParser = DOMParser;
        const XL = require('../../flock/flock-xlsx');
        const AdmZip = require('adm-zip');
        const buf = buildXlsx(AdmZip, [
            { name: 'Subscriber', rows: [['Subscriber Information'], ['Name', 'Address', 'Account Number', 'Start Date', 'End Date'], ['REDACTED', 'REDACTED', '0000', '01/01/2020', '']] },
            { name: 'CDR', rows: TM_ROWS },
        ]);
        const wb = await XL.readWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const p = CF.pickSheet(wb.sheets);
        assert.strictEqual(p.name, 'CDR');
        assert.strictEqual(p.headerRow, 4);
        const conv = CF.rowsToRecords(p.rows, p.headerRow);
        assert.strictEqual(conv.records.length, 6);
        assert.strictEqual(CF.detectCarrier(p.rows, p.headerRow, 'r.xlsx'), 'T-Mobile');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();

// Minimal .xlsx: shared strings for text, numbers as numbers.
function buildXlsx(AdmZip, sheets) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const shared = [], idx = new Map();
    const si = s => { if (!idx.has(s)) { idx.set(s, shared.length); shared.push(s); } return idx.get(s); };
    const col = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const z = new AdmZip();
    sheets.forEach((sh, i) => {
        const rowsXml = sh.rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
            if (v === '' || v == null) return '';
            const ref = col(ci) + (ri + 1);
            return /^-?\d+(\.\d+)?$/.test(String(v)) && String(v).length < 15
                ? '<c r="' + ref + '"><v>' + v + '</v></c>'
                : '<c r="' + ref + '" t="s"><v>' + si(String(v)) + '</v></c>';
        }).join('') + '</row>').join('');
        z.addFile('xl/worksheets/sheet' + (i + 1) + '.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rowsXml + '</sheetData></worksheet>'));
    });
    z.addFile('xl/sharedStrings.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + shared.map(s => '<si><t>' + esc(s) + '</t></si>').join('') + '</sst>'));
    z.addFile('xl/workbook.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'));
    z.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>'));
    z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));
    return z.toBuffer();
}
