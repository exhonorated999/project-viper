/*
 * VIPER Scout — device mode (full-file-system phone extractions) — tests.
 *
 * Run: node modules\parser-submission\__tests__\device-dump.test.js
 *      (re-launches itself under Electron's Node when the plain-Node build of
 *      better-sqlite3 cannot load).
 *
 * Everything here is synthetic.  Every "personal" value is a SENTINEL that
 * must never appear anywhere in an envelope: names, emails, phone numbers,
 * message bodies, Wi-Fi names, passwords, keychain and memory contents.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── better-sqlite3 needs Electron's ABI on dev machines ────────────────────
let Database;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (e) {
    const exe = path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron');
    if (!process.env.__DD_TEST_RELAUNCHED && fs.existsSync(exe)) {
        const r = spawnSync(exe, [__filename], { stdio: 'inherit',
            env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', __DD_TEST_RELAUNCHED: '1' }) });
        process.exit(r.status == null ? 1 : r.status);
    }
    console.log('better-sqlite3 unavailable: ' + (e && e.code));
    process.exit(1);
}

const AdmZip = require('adm-zip');
const dd = require('../device-dump');
const { buildSampleEnvelope } = require('../sample-builder');
const I = dd._internal;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
}
function section(t) { console.log('\n== ' + t); }

// ── Sentinels ───────────────────────────────────────────────────────────────
const NAME = 'Zebulon Quixote';
const EMAIL = 'zq.sentinel@example.org';
const PHONE = '+15558675309';
const BODY = 'SENTINEL message body 7731';
const SSID = 'SentinelHomeWifi';
const PW = 'hunter2-SENTINEL-PW';
const LEAK_TERMS = ['zebulon', 'quixote', 'zq.sentinel', '8675309', 'sentinel', 'hunter2'];
function leaks(obj) {
    const s = JSON.stringify(obj).toLowerCase();
    return LEAK_TERMS.filter(t => s.includes(t));
}

// ── Builders ────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-'));
const SCRATCH = path.join(ROOT, 'scratch'); fs.mkdirSync(SCRATCH);
const TMPDIR = path.join(ROOT, 'tmp'); fs.mkdirSync(TMPDIR);

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function xp(v) {
    if (typeof v === 'string') return '<string>' + esc(v) + '</string>';
    if (typeof v === 'number') return Number.isInteger(v) ? '<integer>' + v + '</integer>' : '<real>' + v + '</real>';
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (Buffer.isBuffer(v)) return '<data>' + v.toString('base64') + '</data>';
    if (v instanceof Date) return '<date>' + v.toISOString().replace(/\.\d+Z$/, 'Z') + '</date>';
    if (Array.isArray(v)) return '<array>' + v.map(xp).join('') + '</array>';
    return '<dict>' + Object.entries(v).map(([k, x]) => '<key>' + esc(k) + '</key>' + xp(x)).join('') + '</dict>';
}
function xmlPlist(v) {
    return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + xp(v) + '</plist>\n');
}
// bplist00 { "a": 1 } built by hand.
function tinyBplist() {
    const objs = Buffer.from([0xD1, 0x01, 0x02, 0x51, 0x61, 0x10, 0x01]);
    const offs = Buffer.from([8, 11, 13]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1; trailer[7] = 1;
    trailer.writeBigUInt64BE(3n, 8); trailer.writeBigUInt64BE(0n, 16); trailer.writeBigUInt64BE(15n, 24);
    return Buffer.concat([Buffer.from('bplist00', 'latin1'), objs, offs, trailer]);
}
let dbN = 0;
function makeDb(setup, wal) {
    const f = path.join(SCRATCH, 'db' + (++dbN) + '.sqlite');
    const db = new Database(f);
    if (wal) db.pragma('journal_mode = WAL');
    setup(db);
    db.close();
    return fs.readFileSync(f);
}
const TYPEDSTREAM = Buffer.concat([Buffer.from([0x04, 0x0B]), Buffer.from('streamtyped', 'latin1'), Buffer.alloc(20, 0x81)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64)]);

const UUID_GROUP = 'AAAAAAAA-1111-2222-3333-444444444444';
const UUID_APP = 'BBBBBBBB-5555-6666-7777-888888888888';

function iosFiles() {
    const smsDb = makeDb(db => {
        db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, handle_id INTEGER,
                   date INTEGER, is_from_me INTEGER, attributedBody BLOB);
                 CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
                 CREATE INDEX message_idx_date ON message(date);`);
        const ins = db.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, attributedBody) VALUES (?,?,?,?,?,?)');
        for (let i = 0; i < 40; i++) ins.run('3C1D0E2F-0000-4000-8000-0000000000' + String(i).padStart(2, '0'), BODY + ' ' + i, 1, 700000000000000000n + BigInt(i) * 1000000000n, i % 2, TYPEDSTREAM);
        db.prepare('INSERT INTO handle VALUES (1, ?, ?)').run(PHONE, 'iMessage');
        db.prepare('INSERT INTO handle VALUES (2, ?, ?)').run(EMAIL, 'iMessage');
    }, true);
    const chatDb = makeDb(db => {
        db.exec(`CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
                 CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
                 CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT VARCHAR, ZMESSAGEDATE TIMESTAMP, ZFROMJID VARCHAR);`);
        db.prepare('INSERT INTO Z_PRIMARYKEY VALUES (1, ?, 0, 5)').run('WAChatSession');
        db.prepare('INSERT INTO Z_PRIMARYKEY VALUES (2, ?, 0, 9)').run('WAMessage');
        db.prepare('INSERT INTO ZWAMESSAGE VALUES (1, ?, ?, ?)').run(BODY, 700000000.5, '15558675309@s.whatsapp.net');
    });
    const P = 'filesystem1/';
    return [
        [P + 'private/var/mobile/Library/SMS/sms.db', smsDb],
        [P + 'private/var/mobile/Library/SMS/sms.db-wal', Buffer.alloc(4096, 7)],
        [P + 'private/var/mobile/Library/SMS/sms.db-shm', Buffer.alloc(1024, 7)],
        [P + 'private/var/mobile/Library/SMS/Attachments/0a/00/IMG_0001.jpeg', JPEG],
        [P + 'private/var/mobile/Containers/Shared/AppGroup/' + UUID_GROUP + '/.com.apple.mobile_container_manager.metadata.plist',
            xmlPlist({ MCMMetadataIdentifier: 'group.com.example.chat', MCMMetadataContentClass: 3 })],
        [P + 'private/var/mobile/Containers/Shared/AppGroup/' + UUID_GROUP + '/ChatStorage.sqlite', chatDb],
        [P + 'private/var/mobile/Containers/Data/Application/' + UUID_APP + '/.com.apple.mobile_container_manager.metadata.plist',
            xmlPlist({ MCMMetadataIdentifier: 'com.example.chat', MCMMetadataContentClass: 2 })],
        [P + 'private/var/mobile/Containers/Data/Application/' + UUID_APP + '/Library/Preferences/com.example.chat.plist',
            xmlPlist({ LastSyncDate: new Date(Date.UTC(2026, 1, 1)), [NAME]: true, "Zebulon's iPhone": 'x', AccountEmail: EMAIL, Count: 3 })],
        [P + 'private/var/mobile/Library/Preferences/com.example.binary.plist', tinyBplist()],
        [P + 'private/var/preferences/SystemConfiguration/com.apple.wifi.known-networks.plist',
            xmlPlist({ ['wifi.network.ssid.' + SSID]: { SSID: Buffer.from(SSID), AddedAt: new Date(Date.UTC(2025, 5, 1)), JoinedBySystemAt: new Date() } })],
        [P + 'private/var/mobile/Media/DCIM/100APPLE/IMG_0001.JPG', JPEG],
        [P + 'private/var/mobile/Media/DCIM/100APPLE/IMG_0002.HEIC', JPEG],
        [P + 'private/var/mobile/Media/' + NAME + '/holiday.jpg', JPEG],
        [P + 'private/var/mobile/Library/' + NAME + '/notes.txt', Buffer.from('x')],
        [P + 'private/var/mobile/Library/' + EMAIL + '/cache.bin', Buffer.from('x')],
        [P + 'private/var/mobile/Library/5558675309/state.bin', Buffer.from('x')],
        [P + 'private/var/Keychains/keychain-2.db', Buffer.from('KEYCHAIN SENTINEL')],
        [P + 'System/Library/CoreServices/SystemVersion.plist',
            xmlPlist({ ProductName: 'iPhone OS', ProductVersion: '17.4', ProductBuildVersion: '21E219' })],
        ['report/extraction_info.json', Buffer.from(JSON.stringify({ device_name: "Zebulon's iPhone", examiner: NAME, imei: '356938035643809', model: 'iPhone15,2' }))],
    ];
}
function writeZip(file, entries) {
    const z = new AdmZip();
    for (const [n, b] of entries) z.addFile(n, b);
    z.writeZip(file);
}

// ── tar writer (ustar + PAX path + GNU long name) ──────────────────────────
function tarHeader(name, size, type) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(0x20, 148, 156);
    h.write(type || '0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
}
function pad(b) { const r = b.length % 512; return r ? Buffer.concat([b, Buffer.alloc(512 - r)]) : b; }
function paxRec(k, v) {
    const body = ' ' + k + '=' + v + '\n';
    const base = Buffer.byteLength(body);
    let len = base + String(base).length;
    if (String(len).length > String(base).length) len = base + String(len).length;
    return len + body;
}
function writeTar(file, entries) {
    const parts = [];
    let useGnu = false;
    for (const [name, buf] of entries) {
        if (name.length > 99) {
            useGnu = !useGnu;
            if (useGnu) {
                const nb = Buffer.from(name + '\0');
                parts.push(tarHeader('././@LongLink', nb.length, 'L'), pad(nb));
            } else {
                const pb = Buffer.from(paxRec('path', name));
                parts.push(tarHeader('PaxHeader/x', pb.length, 'x'), pad(pb));
            }
        }
        parts.push(tarHeader(name, buf.length, '0'), pad(buf));
    }
    parts.push(Buffer.alloc(1024));
    fs.writeFileSync(file, Buffer.concat(parts));
}

function androidFiles() {
    const mmssms = makeDb(db => {
        db.exec('CREATE TABLE sms (_id INTEGER PRIMARY KEY, thread_id INTEGER, address TEXT, date INTEGER, body TEXT, type INTEGER, read INTEGER)');
        const ins = db.prepare('INSERT INTO sms (thread_id, address, date, body, type, read) VALUES (?,?,?,?,?,?)');
        for (let i = 0; i < 30; i++) ins.run(1, PHONE, 1700000000000 + i * 60000, BODY, 1 + (i % 2), 1);
    });
    const bugle = makeDb(db => {
        db.exec('CREATE TABLE messages (_id INTEGER PRIMARY KEY, conversation_id INTEGER, received_timestamp INTEGER, sender_id TEXT)');
        db.prepare('INSERT INTO messages VALUES (1, 1, 1700000000000, ?)').run(EMAIL);
    });
    const longDir = 'data/data/com.example.verylongpackagename.withmanysegments/files/' + 'segment'.repeat(10);
    return [
        ['data/data/com.android.providers.telephony/databases/mmssms.db', mmssms],
        ['data/data/com.google.android.apps.messaging/databases/bugle_db', bugle],
        [longDir + '/deep.db', makeDb(db => db.exec('CREATE TABLE t (a INTEGER)'))],
        ['data/data/com.example.app/shared_prefs/prefs.xml', Buffer.from('<map><string name="user">' + NAME + '</string></map>')],
        ['data/system/packages.xml', Buffer.from('<packages/>')],
        ['data/system_ce/0/accounts_ce.db', Buffer.from('ACCOUNT TOKEN SENTINEL')],
        ['system/build.prop', Buffer.from('ro.build.version.release=14\nro.build.version.sdk=34\nro.product.model=Pixel 8\n' +
            'ro.product.manufacturer=Google\nro.build.host=zebulon-sentinel-host\nro.serialno=SENTINEL123\n')],
        ['data/media/0/DCIM/Camera/IMG_' + 'x'.repeat(90) + '.jpg', JPEG],
        ['data/media/0/DCIM/Camera/IMG_2.jpg', JPEG],
        ['data/media/0/Download/invoice.pdf', Buffer.from('%PDF-1.4\n')],
        ['data/media/0/' + NAME + '/doc.txt', Buffer.from('x')],
        ['data/media/0/Android/data/com.example.app/files/cache.bin', Buffer.from('x')],
    ];
}
function writeTree(dir, entries) {
    for (const [n, b] of entries) {
        const f = path.join(dir, ...n.split('/'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, b);
    }
}

function findDb(dump, artifact) { return ((dump.sqlite || {}).dbs || []).find(d => d.artifact === artifact); }
function colShape(db, table, col) {
    const t = (db.tables || []).find(x => x.name === table);
    const c = t && t.cols.find(x => x[0] === col);
    return c ? c[2] : null;
}

(async () => {
    // ── Unit: scrubbing / naming ───────────────────────────────────────────
    section('privacy helpers');
    ok('genericDir name-shaped', I.genericDir(NAME) === '<dir:name-shaped>', I.genericDir(NAME));
    ok("genericDir possessive device name", I.genericDir("Zebulon's iPhone") === '<dir>', I.genericDir("Zebulon's iPhone"));
    ok('genericDir structural kept', I.genericDir('Application Support') === 'Application Support');
    ok('genericDir reverse-dns kept', I.genericDir('com.apple.Preferences') === 'com.apple.Preferences');
    ok('genericDir email', I.genericDir(EMAIL) === '<email>', I.genericDir(EMAIL));
    ok('genericDir digits', I.genericDir('5558675309') === '<n10>', I.genericDir('5558675309'));
    ok('scrubName username-shaped', I.scrubName('jsmith92') === '<id>', I.scrubName('jsmith92'));
    ok('scrubName keeps IMG_0001', I.scrubName('IMG_0001') === 'IMG_0001', I.scrubName('IMG_0001'));
    ok('displayFileName zone', I.displayFileName('IMG_0001.JPG', true) === '<file>.jpg');
    ok('displayFileName name-shaped', I.displayFileName(NAME + '.pdf', false) === '<file:name-shaped>.pdf', I.displayFileName(NAME + '.pdf', false));
    ok('displayFileName Envelope Index kept', I.displayFileName('Envelope Index', false) === 'Envelope Index');
    ok('displayDirParts outside zone', I.displayDirParts(['Case 12 ' + NAME, 'report'], { uuidMap: new Map() }, dd.DEFAULT_LIMITS, true).parts.join('/') === '<dir>/report');

    section('withheld rules');
    ok('keychain.plist', dd.withheldReason('keychain.plist') === 'keychain');
    ok('passwords.txt', dd.withheldReason('out/passwords.txt') === 'passwords');
    ok('<id>_passwords.txt', dd.withheldReason('ABC123_passwords.txt') === 'passwords');
    ok('password_change_activity.json NOT withheld', dd.withheldReason('security/password_change_activity.json') === null);
    ok('mem.zip', dd.withheldReason('mem.zip') === 'memory_image');
    ok('memories.zip NOT withheld', dd.withheldReason('memories.zip') === null);
    ok('iOS keychain dir', dd.withheldReason('fs/private/var/Keychains/keychain-2.db') === 'keychain');
    ok('Android accounts_ce', dd.withheldReason('data/system_ce/0/accounts_ce.db') === 'account_tokens');
    ok('Android locksettings', dd.withheldReason('data/system/locksettings.db-wal') === 'lock_screen');

    section('value shapes');
    ok('cocoa_ns', I.numShape(7e17, true) === 'cocoa_ns');
    ok('cocoa_s', I.numShape(700000000.5, false) === 'cocoa_s');
    ok('unix_ms', I.numShape(1700000000000, true) === 'unix_ms');
    ok('phone', I.textShape(PHONE) === 'phone');
    ok('email', I.textShape(EMAIL) === 'email');
    ok('whatsapp jid', I.textShape('15558675309@s.whatsapp.net') === 'whatsapp_jid', I.textShape('15558675309@s.whatsapp.net'));
    ok('typedstream', I.blobShape(TYPEDSTREAM) === 'typedstream');
    ok('jpeg', I.blobShape(JPEG) === 'jpeg');

    section('plists');
    const bp = I.parsePlist(tinyBplist());
    ok('bplist parsed', bp.format === 'binary' && bp.value && bp.value.a === 1, bp);
    const groups = I._groupKeys(['wifi.network.ssid.' + SSID, 'wifi.network.ssid.Other', 'Version']);
    ok('ssid keys collapse', groups.length === 2 && groups[0][0] === 'wifi.network.<*>' && groups[0][1].length === 2, groups);
    const many = {}; for (let i = 0; i < 10; i++) many['acct_' + ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'fox', 'golf', 'hotel', 'india', 'juliet'][i]] = i;
    const shp = I.plistShape(many);
    ok('map-like keys collapse (>= 8 siblings)', shp.keys.some(k => k[0] === '/acct_<*>'), shp.keys);
    const shp2 = I.plistShape({ [NAME]: 1, "Zebulon's iPhone": 'x', Count: 2 });
    ok('name-shaped plist key', shp2.keys.some(k => k[0] === '/<key:name-shaped>'), shp2.keys);
    ok('free-text plist key', shp2.keys.some(k => k[0] === '/<key:text>'), shp2.keys);
    ok('plain key kept', shp2.keys.some(k => k[0] === '/Count'));

    // ── GrayKey-style output folder ────────────────────────────────────────
    section('GrayKey output folder (zip + keychain + passwords + mem)');
    const GK = path.join(ROOT, 'graykey_out');
    fs.mkdirSync(GK);
    writeZip(path.join(GK, '0000A1B2C3_files_full.zip'), iosFiles());
    fs.writeFileSync(path.join(GK, 'keychain.plist'), xmlPlist({ item: 'KEYCHAIN SENTINEL' }));
    fs.writeFileSync(path.join(GK, 'passwords.txt'), PW + '\n');
    writeZip(path.join(GK, 'mem.zip'), [['mem.raw', Buffer.from('MEMORY SENTINEL')]]);
    const phases = new Set();
    const env = await buildSampleEnvelope(GK, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR, onProgress: p => phases.add(p.phase) });
    const rs = env.root_summary;
    ok('mode = device', rs.mode === 'device', rs.mode);
    ok('one device dump', (rs.device_dumps || []).length === 1);
    const D = rs.device_dumps[0];
    ok('platform ios', D.platform === 'ios', D.platform);
    ok('fs prefix', JSON.stringify(D.layout.fs_prefix) === '["filesystem1"]', D.layout);
    ok('source name generic', D.source_name === '<id>_files_full.zip', D.source_name);
    ok('os version', D.device.os_version === '17.4' && D.device.os_build === '21E219', D.device);
    const kIds = D.known_artifacts.map(k => k.id);
    for (const id of ['ios.sms', 'ios.sms_attachments', 'ios.whatsapp', 'ios.dcim', 'ios.systemversion', 'ios.wifi']) ok('known ' + id, kIds.includes(id), kIds);
    ok('known_missing lists ios.callhistory', (D.known_missing || []).includes('ios.callhistory'));
    const sms = findDb(D, 'ios.sms');
    ok('sms.db profiled', sms && sms.tables && sms.tables.length === 3 && sms.tables.some(t => t.name === 'sqlite_sequence'), sms);
    ok('sms.db WAL header patched', sms && sms.journal === 'wal');
    ok('sms.db wal size reported', sms && sms.wal_bytes === 4096);
    ok('sms path display', sms && sms.path === '<fs>/private/var/mobile/Library/SMS/sms.db', sms && sms.path);
    ok('message.date cocoa_ns', /cocoa_ns:\d+/.test(colShape(sms, 'message', 'date') || ''), colShape(sms, 'message', 'date'));
    ok('message.text text', /^text:/.test(colShape(sms, 'message', 'text') || ''), colShape(sms, 'message', 'text'));
    ok('attributedBody typedstream', /typedstream/.test(colShape(sms, 'message', 'attributedBody') || ''));
    ok('handle.id phone + email', /phone/.test(colShape(sms, 'handle', 'id') || '') && /email/.test(colShape(sms, 'handle', 'id') || ''), colShape(sms, 'handle', 'id'));
    ok('row counts', sms.tables.find(t => t.name === 'message').rows === 40);
    ok('sampled first+last, no overlap', sms.tables.find(t => t.name === 'message').sampled === 40);
    const chat = findDb(D, 'ios.whatsapp');
    ok('container uuid → bundle id', chat && chat.path === '<fs>/private/var/mobile/Containers/Shared/AppGroup/<group:group.com.example.chat>/ChatStorage.sqlite', chat && chat.path);
    ok('coredata entities', chat && chat.coredata && JSON.stringify(chat.coredata_entities) === '[[1,"WAChatSession"],[2,"WAMessage"]]', chat);
    ok('ZMESSAGEDATE cocoa_s', /cocoa_s/.test(colShape(chat, 'ZWAMESSAGE', 'ZMESSAGEDATE') || ''));
    ok('ZFROMJID whatsapp_jid', /whatsapp_jid/.test(colShape(chat, 'ZWAMESSAGE', 'ZFROMJID') || ''));
    ok('apps mapped', D.apps.some(a => a.id === 'com.example.chat' && a.kind === 'app') && D.apps.some(a => a.id === 'group.com.example.chat' && a.kind === 'group'), D.apps);
    ok('keychain withheld in dump', D.withheld.some(w => w.path === '<fs>/private/var/Keychains/keychain-2.db' && w.reason === 'keychain'), D.withheld);
    ok('keychain never profiled', !D.sqlite.dbs.some(d => /keychain/i.test(d.path)));
    const wifi = D.plists.items.find(p => p.artifact === 'ios.wifi');
    ok('wifi plist keys collapsed', wifi && wifi.keys.some(k => k[0] === '/wifi.network.<*>/AddedAt' && /date/.test(k[1])), wifi);
    const prefs = D.plists.items.find(p => /com\.example\.chat\.plist$/.test(p.path));
    ok('prefs plist path under app', prefs && prefs.path === '<fs>/private/var/mobile/Containers/Data/Application/<app:com.example.chat>/Library/Preferences/com.example.chat.plist', prefs && prefs.path);
    ok('prefs plist name key redacted', prefs && prefs.keys.some(k => k[0] === '/<key:name-shaped>'), prefs && prefs.keys);
    ok('prefs plist email value → shape', prefs && prefs.keys.some(k => k[0] === '/AccountEmail' && k[1] === 'string:email'), prefs && prefs.keys);
    const binp = D.plists.items.find(p => /com\.example\.binary\.plist$/.test(p.path));
    ok('binary plist profiled', binp && binp.format === 'binary' && binp.keys.some(k => k[0] === '/a'), binp);
    const rows = D.directories.rows.map(r => r[0]);
    ok('DCIM kept in zone', rows.includes('<fs>/private/var/mobile/Media/DCIM/100APPLE'), rows);
    ok('user folder in Media → <dir>', rows.includes('<fs>/private/var/mobile/Media/<dir>'));
    ok('name-shaped Library folder', rows.includes('<fs>/private/var/mobile/Library/<dir:name-shaped>'));
    ok('email folder', rows.includes('<fs>/private/var/mobile/Library/<email>'));
    ok('phone folder', rows.includes('<fs>/private/var/mobile/Library/<n10>'));
    ok('outside folder (report) kept', rows.includes('<outside>/report'), rows);
    ok('file count', D.files === iosFiles().length, D.files);
    // Tree: tool report file + the withheld files next to the zip.
    const tree = env.tree;
    const tool = tree.find(e => /^device-dump-1\/report\/file_\d+\.json$/.test(e.path));
    ok('tool report inspected via normal Scout', tool && tool.format === 'json', tree.map(e => e.path));
    const wh = (re) => tree.find(e => e.structure && e.structure.withheld && re.test(e.ext + ':' + e.structure.withheld));
    ok('keychain.plist withheld', !!wh(/^plist:keychain$/), tree);
    ok('passwords.txt withheld', !!wh(/^txt:passwords$/));
    ok('mem.zip withheld (not recursed)', !!wh(/^zip:memory_image$/) && !tree.some(e => /mem\.raw|file_\d+\.raw/.test(e.path)));
    ok('the dump zip is not walked file-by-file', !tree.some(e => /private|filesystem1/i.test(e.path)), tree.map(e => e.path));
    ok('total files counts dump + folder', rs.total_files === D.files + 3, rs.total_files);
    ok('format counts from dump', (rs.format_counts.image || 0) >= 4, rs.format_counts);
    ok('progress phases', ['start', 'device-list', 'device-sqlite', 'device-done', 'done'].every(p => phases.has(p)), [...phases]);
    ok('NO SENTINEL LEAKS (GrayKey folder)', leaks(env).length === 0, leaks(env));
    ok('temp folder cleaned', fs.readdirSync(TMPDIR).length === 0, fs.readdirSync(TMPDIR));

    section('limits');
    const envL = await buildSampleEnvelope(path.join(GK, '0000A1B2C3_files_full.zip'), { formatCategory: 'mobile_forensics', tmpDir: TMPDIR, deviceLimits: { sqliteMaxDbs: 1 } });
    const DL = envL.root_summary.device_dumps[0];
    ok('single zip picked → device mode', envL.root_summary.mode === 'device');
    ok('db cap', DL.sqlite.selected === 1 && DL.sqlite.skipped.over_db_cap >= 1 && DL.sqlite.dbs[0].artifact === 'ios.sms', DL.sqlite);
    ok('limits reported', DL.limits.sqlite_max_dbs === 1);

    // ── Android tar ────────────────────────────────────────────────────────
    section('Android .tar (PAX + GNU long names)');
    const AF = androidFiles();
    const TAR = path.join(ROOT, 'android_ffs.tar');
    writeTar(TAR, AF);
    ok('sniff tar', dd.sniffContainer(TAR) === 'tar');
    const envT = await buildSampleEnvelope(TAR, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR });
    const T = envT.root_summary.device_dumps && envT.root_summary.device_dumps[0];
    ok('tar → device', T && T.platform === 'android' && T.container === 'tar', T && T.platform);
    ok('tar file count', T.files === AF.length, T.files);
    ok('android device info', T.device.os_version === '14' && T.device.model === 'Pixel 8' && T.device.sdk === '34' && !('host' in T.device), T.device);
    const mm = findDb(T, 'android.mmssms');
    ok('mmssms profiled', mm && /unix_ms/.test(colShape(mm, 'sms', 'date') || '') && /phone/.test(colShape(mm, 'sms', 'address') || ''), mm);
    const bg = findDb(T, 'android.bugle');
    ok('extensionless bugle_db profiled', bg && bg.tables && bg.tables[0].name === 'messages', bg);
    ok('PAX long path db profiled', T.sqlite.dbs.some(d => /deep\.db$/.test(d.path) && d.tables), T.sqlite.dbs.map(d => d.path));
    ok('accounts_ce withheld', T.withheld.some(w => w.reason === 'account_tokens'));
    const trows = T.directories.rows.map(r => r[0]);
    ok('Android zone: DCIM/Camera kept', trows.includes('<fs>/data/media/0/DCIM/Camera'), trows);
    ok('Android zone: user folder → <dir>', trows.includes('<fs>/data/media/0/<dir>'));
    ok('Android/data exits zone', trows.includes('<fs>/data/media/0/Android/data/com.example.app/files'), trows);
    ok('android apps', T.apps.some(a => a.id === 'com.android.providers.telephony') && T.apps.some(a => a.kind === 'external' && a.id === 'com.example.app'), T.apps);
    ok('NO SENTINEL LEAKS (tar)', leaks(envT).length === 0, leaks(envT));

    section('Android extracted folder');
    const AD = path.join(ROOT, 'android_folder');
    writeTree(AD, AF);
    const envA = await buildSampleEnvelope(AD, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR });
    const A = envA.root_summary.device_dumps && envA.root_summary.device_dumps[0];
    ok('folder → device', A && A.platform === 'android' && A.container === 'dir' && A.source_name === '<folder>', A && A.platform);
    ok('folder: same db count as tar', A.sqlite.profiled === T.sqlite.profiled, [A.sqlite.profiled, T.sqlite.profiled]);
    ok('folder: tree empty (FS root picked)', envA.tree.length === 0, envA.tree.length);
    ok('NO SENTINEL LEAKS (folder)', leaks(envA).length === 0, leaks(envA));

    // ── Ordinary zips keep the normal walk ─────────────────────────────────
    section('ordinary zips');
    const PLAIN = path.join(ROOT, 'export.zip');
    writeZip(PLAIN, [['messages/inbox.json', Buffer.from('{"messages":[{"from":"a","ts":1}]}')], ['profile.json', Buffer.from('{"a":1}')]]);
    const envP = await buildSampleEnvelope(PLAIN, { formatCategory: 'warrant_return' });
    ok('warrant zip: normal walk', !envP.root_summary.mode && envP.tree.length === 2 && envP.root_summary.total_files === 2, envP.root_summary);
    const envF = await buildSampleEnvelope(PLAIN, { formatCategory: 'mobile_forensics', deviceLimits: { mobileMinBytes: 0 } });
    ok('qualifying zip that is not a phone dump falls back', envF.root_summary.device_fallback === 'not_a_device_dump' && envF.tree.length === 2, envF.root_summary);

    section('tgz');
    const TGZ = path.join(ROOT, 'dump.tgz');
    fs.writeFileSync(TGZ, Buffer.concat([Buffer.from([0x1F, 0x8B, 0x08, 0]), Buffer.alloc(60)]));
    let tgzErr = null;
    try { await buildSampleEnvelope(TGZ, { formatCategory: 'mobile_forensics' }); } catch (e) { tgzErr = e; }
    ok('tgz rejected with guidance', tgzErr && /extract it to a \.tar or a folder/.test(tgzErr.message), tgzErr && tgzErr.message);

    // ── Envelope size: the dashboard rejects bodies over 16 MiB ────────────
    const SB = require('../sample-builder')._internal;
    const bodyBytes = (env, notes) => Buffer.byteLength(JSON.stringify({
        envelope: env,
        submitter: { format_category: 'mobile_forensics', provider_hint: 'GrayKey', submitter_email: 'a@example.org',
            submitter_notes: notes, agency_name: 'x', reporter_name: 'x', product_slug: 'project-viper', app_version: '0', platform: 'desktop' },
    }), 'utf8');
    const NOTES = 'n'.repeat(20000);   // a long note — it is sent twice (envelope + submitter)
    const MiB = 1024 * 1024;

    section('size fit (unit)');
    {
        const big = (n, s) => Array.from({ length: n }, (_, i) => s(i));
        const env = {
            root_summary: {
                truncated_files: 0,
                device_dumps: [{
                    directories: { rows: big(20000, i => ['<fs>/data/' + 'd'.repeat(60) + i, 1, 1, 1, 'x:1']) },
                    plists: { items: big(100, i => ({ path: 'p' + i, keys: 'k'.repeat(4000) })).concat([{ path: 'known-plist', artifact: 'ios.wifi', keys: 'k'.repeat(4000) }]) },
                    sqlite: { dbs: big(100, i => ({ path: 'd' + i, tables: 't'.repeat(8000) })).concat([{ path: 'known-db', artifact: 'ios.sms', tables: 't'.repeat(8000) }]) },
                }],
            },
            tree: big(30000, i => ({ path: 'file_' + i, structure: 's'.repeat(600) })),
        };
        const before = SB._jsonBytes(env);
        const cap = 2 * MiB;
        const after = SB._fitEnvelope(env, cap);
        const D0 = env.root_summary.device_dumps[0], st = env.root_summary.size_trimmed;
        ok('fixture is over the cap', before > 18 * MiB, before);
        ok('fits the cap', after <= cap && SB._jsonBytes(env) <= cap, after);
        ok('size_trimmed recorded', st && st.cap_bytes === cap && st.before_bytes === before && st.after_bytes <= cap, st);
        ok('known plist kept', D0.plists.items.some(p => p.artifact === 'ios.wifi'));
        ok('known db kept', D0.sqlite.dbs.some(d => d.artifact === 'ios.sms'));
        ok('first directory rows kept', D0.directories.rows.length >= 50 && /0$/.test(D0.directories.rows[0][0]), D0.directories.rows.length);
        ok('omitted counters', D0.directories.omitted === st.device_dir_rows && (D0.plists.omitted_for_size || 0) === (st.device_plists || 0)
            && env.root_summary.truncated_files === (st.tree_entries || 0), [st, D0.directories.omitted, env.root_summary.truncated_files]);
        const small = { root_summary: {}, tree: [{ a: 1 }] };
        ok('small envelope untouched', SB._fitEnvelope(small, cap) && !small.root_summary.size_trimmed);
    }

    section('size fit (GrayKey folder, tiny cap)');
    {
        const full = await buildSampleEnvelope(GK, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR });
        const fullBytes = SB._jsonBytes(full);
        const cap = Math.floor(fullBytes * 0.85);
        const envC = await buildSampleEnvelope(GK, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR, envelopeHardCapBytes: cap });
        const DC = envC.root_summary.device_dumps[0];
        ok('trimmed under cap', SB._jsonBytes(envC) <= cap, [SB._jsonBytes(envC), cap]);
        ok('size_trimmed set', !!envC.root_summary.size_trimmed, envC.root_summary.size_trimmed);
        ok('sms.db still profiled', !!findDb(DC, 'ios.sms'));
        ok('full build not trimmed', !full.root_summary.size_trimmed);
        ok('NO SENTINEL LEAKS (trimmed)', leaks(envC).length === 0, leaks(envC));
    }

    // Worst case: one dump that saturates every budget (40k directory rows,
    // 300 wide databases, 200 deep plists), then five of them in one folder.
    section('size: budget-saturating dump');
    const STRESS = path.join(ROOT, 'stress');
    fs.mkdirSync(STRESS);
    {
        const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
            'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
            'yankee', 'zulu', 'amber', 'basil', 'cedar', 'dune', 'ember', 'fern', 'grove', 'heath', 'iris', 'jade', 'kelp', 'larch', 'moss', 'nettle'];
        const letters = (n) => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0); return s; };
        const wide = makeDb(db => {
            for (let t = 0; t < 15; t++) {
                const cols = W.slice(0, 30).map(w => w + '_' + W[t] + ' TEXT').join(', ');
                db.exec('CREATE TABLE ' + W[t] + '_records (' + cols + ')');
                db.prepare('INSERT INTO ' + W[t] + '_records VALUES (' + W.slice(0, 30).map(() => '?').join(',') + ')').run(...W.slice(0, 30).map(() => 'value'));
            }
        });
        const deep = {}; for (const a of W) { deep[a] = {}; for (const b of W) deep[a][b] = 1; }
        const deepPlist = xmlPlist(deep);
        const files = [['system/build.prop', Buffer.from('ro.build.version.release=14\nro.build.version.sdk=34\n')]];
        for (let i = 0; i < 20000; i++) files.push(['data/data/com.example.' + letters(i + 1000) + '/files/f.bin', Buffer.from('x')]);
        for (let i = 0; i < 300; i++) files.push(['data/data/com.example.store' + letters(i) + '/databases/store.db', wide]);
        for (let i = 0; i < 200; i++) files.push(['data/data/com.example.conf' + letters(i) + '/files/settings.plist', deepPlist]);
        writeTar(path.join(STRESS, 'dump1.tar'), files);
    }
    const t0 = Date.now();
    const envS = await buildSampleEnvelope(path.join(STRESS, 'dump1.tar'), { formatCategory: 'mobile_forensics', tmpDir: TMPDIR, submitterNotes: NOTES });
    const S = envS.root_summary.device_dumps && envS.root_summary.device_dumps[0];
    const sBytes = SB._jsonBytes(envS), sBody = bodyBytes(envS, NOTES);
    console.log('       one saturated dump: envelope ' + (sBytes / MiB).toFixed(2) + ' MiB, body ' + (sBody / MiB).toFixed(2) + ' MiB, '
        + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    ok('stress dump scanned', S && S.platform === 'android' && S.files === 20501, S && [S.platform, S.files]);
    ok('directory budget saturated', S.directories.omitted > 0, S.directories.omitted);
    ok('300 databases profiled', S.sqlite.profiled === 300, S.sqlite.profiled);
    ok('sqlite budget saturated', (S.sqlite.omitted_for_size || 0) > 0 || S.sqlite.dbs.some(d => d.tables_trimmed || d.detail), [S.sqlite.omitted_for_size, S.sqlite.dbs.length]);
    ok('one dump stays ≤ 7 MiB', SB._jsonBytes(S) <= 7 * MiB, SB._jsonBytes(S));
    ok('envelope ≤ hard cap (budgets alone)', sBytes <= SB.ENVELOPE_HARD_CAP_BYTES && !envS.root_summary.size_trimmed, sBytes);
    ok('body ≤ server limit', sBody <= SB.SERVER_BODY_LIMIT_BYTES, sBody);

    section('size: five saturated dumps in one folder');
    const MULTI = path.join(ROOT, 'multi');
    fs.mkdirSync(MULTI);
    for (let i = 1; i <= 5; i++) {
        const dst = path.join(MULTI, 'dump' + i + '.tar');
        try { fs.linkSync(path.join(STRESS, 'dump1.tar'), dst); } catch { fs.copyFileSync(path.join(STRESS, 'dump1.tar'), dst); }
    }
    const t1 = Date.now();
    const envM = await buildSampleEnvelope(MULTI, { formatCategory: 'mobile_forensics', tmpDir: TMPDIR, submitterNotes: NOTES, deviceLimits: { mobileMinBytes: 0 } });
    const mBytes = SB._jsonBytes(envM), mBody = bodyBytes(envM, NOTES);
    console.log('       five saturated dumps: envelope ' + (mBytes / MiB).toFixed(2) + ' MiB, body ' + (mBody / MiB).toFixed(2) + ' MiB, '
        + ((Date.now() - t1) / 1000).toFixed(1) + ' s');
    ok('five dumps', (envM.root_summary.device_dumps || []).length === 5, (envM.root_summary.device_dumps || []).length);
    ok('envelope ≤ hard cap', mBytes <= SB.ENVELOPE_HARD_CAP_BYTES, mBytes);
    ok('body ≤ server limit', mBody <= SB.SERVER_BODY_LIMIT_BYTES, mBody);
    if (process.env.DD_DUMP_ENVELOPES) {
        fs.writeFileSync(path.join(process.env.DD_DUMP_ENVELOPES, 'env-one.json'), JSON.stringify(envS));
        fs.writeFileSync(path.join(process.env.DD_DUMP_ENVELOPES, 'env-five.json'), JSON.stringify(envM));
    }
    ok('temp folder cleaned (stress)', fs.readdirSync(TMPDIR).length === 0, fs.readdirSync(TMPDIR));

    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} process.exit(1); });
