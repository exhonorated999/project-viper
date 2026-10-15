/*
 * datapilot-time — DataPilot device-local times + device identity.
 *
 * Run (needs better-sqlite3 built for Electron):
 *   set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd modules\datapilot\__tests__\datapilot-time.test.js
 *
 * The field report this pins: a message the phone sent at 20:30 Mountain
 * (DataPilot's Messages.DateTime = "2026-10-14 20:30:00") showed as 2:30 PM in
 * the thread, and the Subject card's Phone Number held the IMEI.
 *
 * The examiner's zone is pinned to America/Denver so the UI assertions are
 * the officer's exact situation. Every identifier below is invented.
 */
process.env.TZ = 'America/Denver';

const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'datapilot-time.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const section = (s) => console.log('\n[' + s + ']');

const DENVER = { tz: 'America/Denver' };
const LA = { tz: 'America/Los_Angeles' };

// Invented identifiers. 490154203237518 is the textbook Luhn-valid IMEI example.
const IMEI = '490154203237518';
const ICCID = '89014103211118510720';
const IMSI = '310150123456789';
const MDN = '+17205550147';

// ───────────────────────────────────────────────────────────────────────
section('the reported message');
{
    const iso = T.deviceLocalToIso('2026-10-14 20:30:00', DENVER);
    ok('20:30 Mountain (summer time) is 02:30 UTC the next day', iso === '2026-10-15T02:30:00.000Z', iso);
    const d = new Date(iso);
    ok('shown back in Mountain time it is 20:30 on the 14th',
        d.getHours() === 20 && d.getMinutes() === 30 && d.getDate() === 14, d.toString());
}

section('daylight saving');
{
    ok('winter (MST, UTC-7): 20:30 → 03:30Z', T.deviceLocalToIso('2026-01-10 20:30:00', DENVER) === '2026-01-11T03:30:00.000Z',
        T.deviceLocalToIso('2026-01-10 20:30:00', DENVER));
    ok('one second before spring-forward is still MST',
        T.deviceLocalToIso('2026-03-08 01:59:59', DENVER) === '2026-03-08T08:59:59.000Z', T.deviceLocalToIso('2026-03-08 01:59:59', DENVER));
    ok('noon on spring-forward day is MDT',
        T.deviceLocalToIso('2026-03-08 12:00:00', DENVER) === '2026-03-08T18:00:00.000Z', T.deviceLocalToIso('2026-03-08 12:00:00', DENVER));
    const amb = T.deviceLocalToIso('2026-11-01 01:30:00', DENVER);
    ok('the repeated 01:30 on fall-back day resolves to one of its two real instants',
        amb === '2026-11-01T07:30:00.000Z' || amb === '2026-11-01T08:30:00.000Z', amb);
    ok('the day after fall-back is MST', T.deviceLocalToIso('2026-11-02 09:00:00', DENVER) === '2026-11-02T16:00:00.000Z',
        T.deviceLocalToIso('2026-11-02 09:00:00', DENVER));
    ok('tzOffsetMinutes: Denver summer -360, winter -420',
        T.tzOffsetMinutes(Date.UTC(2026, 6, 1), 'America/Denver') === -360 && T.tzOffsetMinutes(Date.UTC(2026, 0, 1), 'America/Denver') === -420);
}

section('value shapes');
{
    // Real DataPilot shape: 7-digit fractional seconds. Measured pair from a
    // real extraction: LastModifiedLocal 16:22:41.8093311 ↔ LastModifiedUtc 23:22:41.8093311.
    ok('7-digit fractional seconds (LA device) land on the measured UTC column',
        T.deviceLocalToIso('2026-05-17 16:22:41.8093311', LA) === '2026-05-17T23:22:41.809Z', T.deviceLocalToIso('2026-05-17 16:22:41.8093311', LA));
    ok('"T" separator accepted', T.deviceLocalToIso('2026-10-14T20:30:00', DENVER) === '2026-10-15T02:30:00.000Z');
    ok('a value that already says Z is honoured as written',
        T.deviceLocalToIso('2026-10-14T20:30:00Z', DENVER) === '2026-10-14T20:30:00.000Z');
    ok('a value with an explicit offset is honoured as written',
        T.deviceLocalToIso('2026-10-14T20:30:00-06:00', LA) === '2026-10-15T02:30:00.000Z');
    ok('DataPilot "no value" sentinel 0001-01-01 → empty', T.deviceLocalToIso('0001-01-01 00:00:00', DENVER) === '');
    ok('empty / null → empty', T.deviceLocalToIso('', DENVER) === '' && T.deviceLocalToIso(null, DENVER) === '');
    ok('garbage → empty', T.deviceLocalToIso('not a date', DENVER) === '');
}

section('fallbacks when the device zone is unknown');
{
    ok('fixed offset -360', T.deviceLocalToIso('2026-10-14 20:30:00', { offsetMin: -360 }) === '2026-10-15T02:30:00.000Z');
    ok('fixed offset +330 (India)', T.deviceLocalToIso('2026-10-14 20:30:00', { offsetMin: 330 }) === '2026-10-14T15:00:00.000Z');
    const exp = new Date(2026, 9, 14, 20, 30, 0).toISOString();
    ok('no zone at all → the examiner\'s own zone', T.deviceLocalToIso('2026-10-14 20:30:00', null) === exp, T.deviceLocalToIso('2026-10-14 20:30:00', null));
    ok('an invalid tz name falls through to the examiner zone', T.deviceLocalToIso('2026-10-14 20:30:00', { tz: 'Mars/Olympus' }) === exp);
    const fl = T.deviceLocalToIso('2026-06-27 00:00:00', LA, { floating: true });
    const fd = new Date(fl);
    ok('all-day (floating) dates stay on the same calendar day for the examiner',
        fd.getFullYear() === 2026 && fd.getMonth() === 5 && fd.getDate() === 27 && fd.getHours() === 0, fl);
}

section('zoneFromDevice');
{
    // The real DeviceInfo JSON shape, values invented.
    const raw = { TimeZone: 'America/Denver', ClockUTCDateTime: '2026-10-15T02:31:05.4Z', ClockLocalDateTime: '2026-10-14T20:31:05.4Z' };
    const z1 = T.zoneFromDevice(raw);
    ok('raw DataPilot JSON: IANA TimeZone wins', z1 && z1.tz === 'America/Denver' && z1.source === 'timezone', z1);
    const z2 = T.zoneFromDevice({ timeZone: 'America/Los_Angeles' });
    ok('VIPER\'s projected deviceInfo shape works too', z2 && z2.tz === 'America/Los_Angeles', z2);
    const z3 = T.zoneFromDevice({ timeZone: 'Mountain Standard Time' });
    ok('Windows zone name maps to IANA', z3 && z3.tz === 'America/Denver', z3);
    const z4 = T.zoneFromDevice({ timeZone: 'UTC-06:00' });
    ok('"UTC-06:00" → fixed -360', z4 && z4.tz === null && z4.offsetMin === -360, z4);
    const z5 = T.zoneFromDevice({ ClockUTCDateTime: '2026-05-17T22:30:05.415Z', ClockLocalDateTime: '2026-05-17T15:30:05.415Z' });
    ok('no TimeZone: offset from the two device clocks (fake-Z local clock) → -420', z5 && z5.offsetMin === -420 && z5.source === 'device-clock', z5);
    const z6 = T.zoneFromDevice({ timeZone: 'Nowhere/Special', clockUtc: '2026-05-17T22:30:05Z', clockLocal: '2026-05-17T16:30:05Z' });
    ok('unusable TimeZone falls back to the clocks', z6 && z6.offsetMin === -360, z6);
    ok('nothing usable → null', T.zoneFromDevice({}) === null && T.zoneFromDevice(null) === null);
}

section('device identity');
{
    ok('IMEI example is Luhn-valid (fixture sanity)', T.looksLikeImei(IMEI));
    ok('a 15-digit number that fails Luhn is not IMEI-shaped', !T.looksLikeImei('490154203237519'));
    ok('"+" prefix is never IMEI-shaped', !T.looksLikeImei('+' + IMEI));

    // The measured DataPilot shape: PhoneNumber === IMEI, real number in MDN.
    const a = T.cleanIdentity({ PhoneNumber: IMEI, IMEI, MDN, ICCID, IMSI, SerialNumber: 'QX7TESTSERIAL', SoftwareVersion: '26.4.2', FirmwareVersion: 'mBoot-1' });
    ok('PhoneNumber == IMEI → phone comes from MDN', a.phoneNumber === MDN, a);
    ok('IMEI lands in the IMEI field', a.imei === IMEI, a);
    ok('OS version is SoftwareVersion, not bootloader firmware', a.osVersion === '26.4.2', a);

    const b = T.cleanIdentity({ PhoneNumber: IMEI, IMEI, MDN: null });
    ok('PhoneNumber == IMEI and no MDN → Phone Number left blank, never the IMEI', b.phoneNumber === '' && b.imei === IMEI, b);

    const c = T.cleanIdentity({ PhoneNumber: IMEI });
    ok('IMEI-shaped PhoneNumber with no IMEI field is kept as the IMEI', c.phoneNumber === '' && c.imei === IMEI, c);

    const d = T.cleanIdentity({ PhoneNumber: '(720) 555-0147', IMEI });
    ok('a genuine number in PhoneNumber is kept', d.phoneNumber === '(720) 555-0147', d);

    const e = T.cleanIdentity({ PhoneNumber: ICCID, MDN: '7205550147', ICCID });
    ok('an ICCID in PhoneNumber is skipped', e.phoneNumber === '7205550147', e);

    const f = T.cleanIdentity({ PhoneNumber: IMSI, IMSI });
    ok('an IMSI in PhoneNumber is skipped', f.phoneNumber === '', f);

    ok('E.164 international number accepted', T.isPlausiblePhone('+447700900123', [IMEI]));
    ok('too short to be a phone number', !T.isPlausiblePhone('911', []));
    ok('CSV "Phone Number" key is read', T.cleanIdentity({ 'Phone Number': '303-555-0110' }).phoneNumber === '303-555-0110');
}

// ───────────────────────────────────────────────────────────────────────
// An import as stored by VIPER ≤ 5.4.1: naive device time with "Z" glued on.
function oldImport() {
    return {
        id: 'dp_old', format: 'dpx',
        deviceInfo: { make: 'Apple', model: 'iPhone', phoneNumber: IMEI, serial: 'QX7TESTSERIAL', timeZone: 'America/Denver', clockUtc: '' },
        messages: [
            { uid: 'M-1', timestamp: '2026-10-14 20:30:00', timestampIso: '2026-10-14T20:30:00.000Z', text: 'the reported one' },
            { uid: 'wa_E-1', timestamp: '2026-10-14 20:30:00', timestampIso: '2026-10-14T20:30:00.000Z', text: 'WhatsApp — genuinely UTC' },
            { uid: 'wam_E-2', timestamp: '', timestampIso: '2026-10-14T21:00:00.000Z', text: 'WhatsApp media' },
            { uid: 'M-2', timestamp: '', timestampIso: '', text: 'no time' },
        ],
        calls: [
            { uid: 'C-1', timestamp: '2026-01-10 08:00:00', timestampIso: '2026-01-10T08:00:00.000Z' },
            { uid: 'wacall_E-3', timestamp: '815000000', timestampIso: '2026-10-29T19:33:20.000Z' },
        ],
        chats: [{ chatUuid: 'X', lastMessageAt: '2026-10-14T20:30:00.000Z' }],
        calendar: [
            { uid: 'K-1', allDay: true, start: '2026-06-27T00:00:00.000Z', end: '2026-06-28T00:00:00.000Z' },
            { uid: 'K-2', allDay: false, start: '2026-06-27T09:00:00.000Z', end: '' },
        ],
        media: [{ fileName: 'a.jpg', lastModified: '2026-05-17T16:22:41.809Z', dateTaken: '' }],
        files: [{ fileName: 'b.txt', lastModified: '2026-05-17T16:22:41.809Z' }],
        photoExifByHash: { abc: { dateTaken: '2026-05-17T10:00:00.000Z' } },
    };
}

section('repairing an import stored by an older build');
{
    const imp = oldImport();
    const changed = T.repairImport(imp);
    ok('reports a change', changed === true);
    ok('stamped with the fix version', imp.timeFixVersion === T.TIME_FIX_VERSION);
    ok('the reported message → 02:30Z on the 15th', imp.messages[0].timestampIso === '2026-10-15T02:30:00.000Z', imp.messages[0].timestampIso);
    ok('raw DataPilot value untouched (the 🔍 source search needs it verbatim)', imp.messages[0].timestamp === '2026-10-14 20:30:00');
    ok('WhatsApp text message NOT shifted', imp.messages[1].timestampIso === '2026-10-14T20:30:00.000Z');
    ok('WhatsApp media message NOT shifted', imp.messages[2].timestampIso === '2026-10-14T21:00:00.000Z');
    ok('a message with no time stays empty', imp.messages[3].timestampIso === '');
    ok('phone call in winter → +7h', imp.calls[0].timestampIso === '2026-01-10T15:00:00.000Z', imp.calls[0].timestampIso);
    ok('WhatsApp call NOT shifted', imp.calls[1].timestampIso === '2026-10-29T19:33:20.000Z');
    ok('chat last-message time shifted', imp.chats[0].lastMessageAt === '2026-10-15T02:30:00.000Z');
    const k1 = new Date(imp.calendar[0].start);
    ok('all-day calendar entry keeps its calendar day', k1.getDate() === 27 && k1.getMonth() === 5 && k1.getHours() === 0, imp.calendar[0].start);
    ok('timed calendar entry shifted', imp.calendar[1].start === '2026-06-27T15:00:00.000Z', imp.calendar[1].start);
    ok('media last-modified shifted (summer Denver)', imp.media[0].lastModified === '2026-05-17T22:22:41.809Z', imp.media[0].lastModified);
    ok('file last-modified shifted', imp.files[0].lastModified === '2026-05-17T22:22:41.809Z');
    ok('photo EXIF date-taken shifted', imp.photoExifByHash.abc.dateTaken === '2026-05-17T16:00:00.000Z');
    ok('IMEI moved out of Phone Number', imp.deviceInfo.phoneNumber === '' && imp.deviceInfo.imei === IMEI, imp.deviceInfo);

    const snap = JSON.stringify(imp);
    const again = T.repairImport(imp);
    ok('second run reports no change', again === false);
    ok('second run changes nothing (no double shift)', JSON.stringify(imp) === snap);
}

section('imports that must NOT be shifted');
{
    const fresh = oldImport();
    fresh.timeFixVersion = T.TIME_FIX_VERSION;           // written by the fixed parser
    fresh.messages[0].timestampIso = '2026-10-15T02:30:00.000Z';
    fresh.deviceInfo.phoneNumber = MDN; fresh.deviceInfo.imei = IMEI;
    const snap = JSON.stringify(fresh);
    ok('a freshly parsed import reports no change', T.repairImport(fresh) === false);
    ok('…and is left byte-identical', JSON.stringify(fresh) === snap);

    const csv = oldImport();
    csv.format = 'csv';
    T.repairImport(csv);
    ok('CSV imports (always read as local time) keep their times', csv.messages[0].timestampIso === '2026-10-14T20:30:00.000Z');
    ok('…but still get the Phone Number fix', csv.deviceInfo.phoneNumber === '' && csv.deviceInfo.imei === IMEI);

    const noZone = oldImport();
    noZone.deviceInfo.timeZone = '';
    T.repairImport(noZone);
    ok('no device zone: re-read in the examiner zone (Denver here) — same answer',
        noZone.messages[0].timestampIso === '2026-10-15T02:30:00.000Z', noZone.messages[0].timestampIso);
    ok('garbage input does not throw', T.repairImport(null) === false && T.repairImport({}) === true);
}

// ───────────────────────────────────────────────────────────────────────
section('the parser, end to end, on a synthetic dptData.db');
{
    const Parser = require(path.join(ROOT, 'datapilot-parser.js'));
    const Database = require('better-sqlite3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-dp-'));
    const dbPath = path.join(dir, 'dptData.db');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE DeviceInfoSummary (DeviceInfo TEXT, ExternalDeviceInfo TEXT);
        CREATE TABLE Chats (ChatUUID TEXT, ChatStyle TEXT, ServiceName TEXT, ChatOwner TEXT, Title TEXT, MessageDateTime TEXT,
            Participants TEXT, LastMessage TEXT, MessageCount INT, IsArchived INT, IsHidden INT, IsRemoved INT);
        CREATE TABLE Messages (MessageUUID TEXT, ChatUUID TEXT, MessageType TEXT, MessageBox TEXT, DateTime TEXT, DateTimeSpan INT,
            DateRead TEXT, DateDelivered TEXT, DateEdited TEXT, DateDeleted TEXT, MessageFrom TEXT, MessageTo TEXT, MessageCc TEXT,
            MessageBcc TEXT, Name TEXT, Subject TEXT, Body TEXT, Status TEXT, Read INT, Deleted INT, Delivered INT, Forward INT,
            AudioMessage INT, Played INT, Seen INT, MailAttachments TEXT, GUID TEXT, ReplyToThreadGUID TEXT);
        CREATE TABLE CallHistory (CallHistoryUUID TEXT, DateTime TEXT, DateTimeSpan INT, Type TEXT, Name TEXT, Number TEXT, Label TEXT,
            Duration TEXT, Provider TEXT, CountryCode TEXT, Location TEXT, VoicemailLink TEXT, Deleted INT);
        CREATE TABLE Files (FileUUID TEXT, ReportUUID TEXT, Path TEXT, SrcPath TEXT, ThumbnailPath TEXT, Name TEXT, FileType TEXT,
            DateTimeTaken TEXT, LastModifiedUtc TEXT, LastModifiedLocal TEXT, SHA3 TEXT, SHA256 TEXT, MD5 TEXT, Size INT, Dimension TEXT,
            GpsCoordinates TEXT, Model TEXT, IsImage INT, Deleted INT);
        CREATE TABLE _pad (b BLOB);
    `);
    db.prepare('INSERT INTO _pad VALUES (zeroblob(65536))').run();   // the format sniffer wants > 32 KB
    db.prepare('INSERT INTO DeviceInfoSummary VALUES (?, NULL)').run(JSON.stringify({
        Make: 'Apple', Model: 'iPhone 15', PhoneNumber: IMEI, IMEI, MDN, ICCID, IMSI, SerialNumber: 'QX7TESTSERIAL',
        SoftwareVersion: '26.4.2', FirmwareVersion: 'mBoot-18000', TimeZone: 'America/Denver',
        ClockUTCDateTime: '2026-10-15T03:00:00.0Z', ClockLocalDateTime: '2026-10-14T21:00:00.0Z',
    }));
    db.prepare(`INSERT INTO Chats (ChatUUID, ChatStyle, ServiceName, Title, MessageDateTime, Participants) VALUES ('CH1','Single','SMS','','2026-10-14 20:30:00','[]')`).run();
    db.prepare(`INSERT INTO Messages (MessageUUID, ChatUUID, MessageType, MessageBox, DateTime, MessageFrom, Body) VALUES ('M1','CH1','SMS','Inbox','2026-10-14 20:30:00','+13035550199','meet at 9')`).run();
    db.prepare(`INSERT INTO CallHistory (CallHistoryUUID, DateTime, Type, Number, Duration) VALUES ('C1','2026-01-10 08:00:00','INCOMING','+13035550199','PT0H1M5S')`).run();
    db.prepare(`INSERT INTO Files (FileUUID, Name, FileType, LastModifiedUtc, LastModifiedLocal, DateTimeTaken) VALUES ('F1','p.jpg','Camera','2026-05-17 22:22:41.8093311','2026-05-17 16:22:41.8093311','2026-05-17 16:00:00')`).run();
    db.close();

    let r = null, err = null;
    (async () => {
        try { r = await new Parser().parseFolder(dir); } catch (e) { err = e; }
        ok('parses without throwing', !err, err && err.message);
        if (r) {
            ok('format is dpx', r.format === 'dpx');
            ok('result stamped with the fix version (so the renderer never re-shifts it)', r.timeFixVersion === T.TIME_FIX_VERSION);
            const m = r.messages.find(x => x.uid === 'M1');
            ok('message read as Mountain time → 02:30Z', m && m.timestampIso === '2026-10-15T02:30:00.000Z', m && m.timestampIso);
            ok('raw value kept verbatim', m && m.timestamp === '2026-10-14 20:30:00');
            const c = r.calls.find(x => x.uid === 'C1');
            ok('winter call → 15:00Z', c && c.timestampIso === '2026-01-10T15:00:00.000Z', c && c.timestampIso);
            ok('chat last-message time in device zone', r.chats[0] && r.chats[0].lastMessageAt === '2026-10-15T02:30:00.000Z');
            const p = r.media.find(x => x.fileName === 'p.jpg');
            ok('file time comes from the true-UTC column', p && p.lastModified === '2026-05-17T22:22:41.809Z', p && p.lastModified);
            ok('photo date-taken read in device zone', p && p.dateTaken === '2026-05-17T22:00:00.000Z', p && p.dateTaken);
            const dev = r.deviceInfo;
            ok('Phone Number is the MDN, not the IMEI', dev.phoneNumber === MDN, dev);
            ok('IMEI field populated', dev.imei === IMEI);
            ok('OS populated', dev.osVersion === '26.4.2');
            ok('device clock captured (was silently empty before)', dev.clockUtc === '2026-10-15T03:00:00.0Z' && dev.clockLocal === '2026-10-14T21:00:00.0Z', dev);
            ok('time zone captured', dev.timeZone === 'America/Denver');
            ok('zone state does not leak past the parse', new Parser()._dpxZone === undefined);
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        rendererSection();
    })();
}

// ───────────────────────────────────────────────────────────────────────
// The renderer: the stored-import repair on load, and the thread's display.
function rendererSection() {
    section('renderer: an old import is corrected on load and saved');
    const stored = JSON.stringify({ imports: [oldImport()] });
    const saved = [];
    const ls = {};
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
        setTimeout, clearTimeout, Promise, JSON, Date, Intl, Math,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.electronAPI = {
        datapilotLoadData: async () => ({ success: true, data: stored }),
        datapilotSaveData: async ({ json }) => { saved.push(json); return { success: true }; },
    };
    vm.createContext(sandbox);
    // Same order as case-detail-with-analytics.html.
    for (const f of ['datapilot-time.js', 'datapilot-analytics.js', 'datapilot-ui.js', 'datapilot-module.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
    }
    ok('DatapilotTime registers on window under a <script> tag (UMD both-branches)', typeof sandbox.DatapilotTime === 'object' && typeof sandbox.DatapilotTime.repairImport === 'function');

    const mod = new sandbox.DatapilotModule('case-1', 'CN-1', 'Test');
    mod.loadData().then(async () => {
        await new Promise(r => setTimeout(r, 20));
        const imp = mod.data.imports[0];
        ok('message corrected in memory', imp.messages[0].timestampIso === '2026-10-15T02:30:00.000Z', imp.messages[0].timestampIso);
        ok('the correction was saved to disk', saved.length === 1 && JSON.parse(saved[0]).imports[0].messages[0].timestampIso === '2026-10-15T02:30:00.000Z');
        ok('the slim index carries the fixed Phone Number', ls['datapilot_case-1'] && JSON.parse(ls['datapilot_case-1']).imports[0].deviceInfo.phoneNumber === '');

        const mod2 = new sandbox.DatapilotModule('case-1', 'CN-1', 'Test');
        sandbox.electronAPI.datapilotLoadData = async () => ({ success: true, data: saved[0] });
        await mod2.loadData();
        await new Promise(r => setTimeout(r, 20));
        ok('the next load does not shift or save again', saved.length === 1 && mod2.data.imports[0].messages[0].timestampIso === '2026-10-15T02:30:00.000Z');

        section('renderer: what the thread shows');
        const ui = new sandbox.DatapilotUI(mod);
        const t = ui._timeOnly(imp.messages[0].timestampIso);
        ok('the bubble shows 08:30 PM — the time in the 🔍 detail', /^0?8:30\s?PM$/i.test(t), t);
        ok('…and is filed under the 14th, not the UTC 15th', ui._dayKey(imp.messages[0].timestampIso) === '2026-10-14', ui._dayKey(imp.messages[0].timestampIso));
        const fd = ui._friendlyDate('2026-10-14');
        ok('the day separator for 2026-10-14 reads Oct 14 (was Oct 13 west of Greenwich)', /Oct 14/.test(fd) && /Wed/.test(fd), fd);
        const html = ui._renderCommsThread(imp, { name: 'x', displayNumber: '', msgs: [imp.messages[0]], calls: [] }, {}, 'all', null, '2026-10-14');
        ok('the date filter for the 14th keeps the 20:30 message', html.indexOf('the reported one') >= 0);

        const coach = new sandbox.DatapilotCoach(mod);
        ok('analytics detail list shows 20:30 local, not 02:30 UTC', coach._localHM(imp.messages[0].timestampIso) === '20:30', coach._localHM(imp.messages[0].timestampIso));
        ok('analytics day key is the local day', coach._dayKey(imp.messages[0].timestampIso) === '2026-10-14');

        console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
        process.exit(fail ? 1 : 0);
    }).catch(e => { console.log('  FAIL  renderer section threw -> ' + (e && e.stack)); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed\n'); process.exit(1); });
}
