/**
 * VIPER Scout — device mode.
 *
 * Full-file-system phone extractions (GrayKey `<id>_files_full.zip`,
 * Cellebrite FFS / UFDR, Magnet, plain .tar or an extracted folder) are
 * 50–500 GB with 300k–3M files.  The regular Scout walk cannot help with
 * them: adm-zip reads the whole archive into memory (fails past 2 GiB), the
 * walk stops at 50,000 files, the envelope caps at 8 MB, and SQLite / plist
 * files — where every phone artifact actually lives — were only recorded as
 * "binary, metadata only".
 *
 * Device mode answers the questions a parser author has, without shipping
 * any evidence:
 *
 *   - What layout is this?  (platform, OS version, where the file system
 *     starts inside the archive, which files sit outside it — the tool's own
 *     report / metadata files, inspected by the normal Scout inspectors)
 *   - Which known artifacts are present, and where?
 *   - What does every SQLite database look like?  Tables, columns, declared
 *     types, row counts, CoreData entity names, and the SHAPE of sampled
 *     values (cocoa_ns, unix_ms, phone, email, bplist, jpeg, …).  Never a
 *     value.  Known artifacts first, then every other database found, up to
 *     300 (configurable).
 *   - What keys do the important plists hold?  (key paths + types only)
 *   - What does the directory tree look like?  (counts, sizes, extensions —
 *     no file names; user-content areas such as DCIM / Downloads collapse
 *     user-named folders to <dir>; iOS container UUIDs are replaced by the
 *     app's bundle id read from the container's metadata plist)
 *
 * Credential material — keychains, passwords.txt, memory images, key files,
 * lock-screen and Wi-Fi credential stores — is listed by name and size and is
 * NEVER opened (`withheldReason`).
 *
 * Archives are read in place: ZIP via node-stream-zip's streaming central
 * directory (ZIP64, nothing kept in memory per entry), TAR by hopping from
 * header to header.  Databases are copied one at a time to a private temp
 * folder, opened read-only, profiled, and deleted.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB;

const DEFAULT_LIMITS = Object.freeze({
    deviceMinBytes: 2 * GiB,          // any zip/tar this large gets a device scan
    mobileMinBytes: 256 * MiB,        // … or this large when category = mobile_forensics
    maxPlainFiles: 50000,             // more files than the normal walk handles → device mode
    sqliteMaxDbs: 300,
    sqliteMaxDbBytes: 2 * GiB,
    sqliteTotalBytes: 40 * GiB,
    sqliteTimeMs: 45 * 60 * 1000,
    sqliteSampleRows: 25,             // first N and last N rows of each table
    sqliteMaxTables: 400,
    sqliteExactCountBytes: 64 * MiB,  // bigger DBs use MAX(rowid) as the row estimate
    plistMax: 200,
    plistMaxBytes: 4 * MiB,
    plistMaxPaths: 250,
    containerPlistMax: 5000,
    toolFilesMax: 150,
    toolFileMaxBytes: 16 * MiB,
    toolFileMaxDepth: 3,
    dirMaxDepth: 12,
    withheldMax: 300,
    appsMax: 800,
    knownHitsPerId: 5,
    budgetDirsBytes: 1.5 * MiB,
    budgetSqliteBytes: 4 * MiB,
    budgetPlistBytes: 0.75 * MiB,
    progressEvery: 5000,
});

function _limits(over) { return Object.assign({}, DEFAULT_LIMITS, over || {}); }
function _yield() { return new Promise(r => setImmediate(r)); }

// ─── Identifier scrubbing ──────────────────────────────────────────────────
// Applied to every name that leaves the machine (folder, table, column, key,
// bundle id).  Removes the identifier shapes that turn up inside app data
// names: account ids, phone numbers, emails, UUIDs, hashes, tokens, IPs.

const RE_S_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_S_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const RE_S_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const RE_S_PHONE = /\+?\(?\d{1,4}\)?[\s.-]\(?\d{2,4}\)?[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g;
const RE_S_HEX = /[0-9a-fA-F]{16,}/g;
const RE_S_DIGITS = /\d{6,}/g;
const RE_S_TOKEN = /[A-Za-z0-9_-]{28,}/g;

function scrubIdent(s) {
    if (s == null) return s;
    return String(s)
        .replace(RE_S_EMAIL, '<email>')
        .replace(RE_S_UUID, '<uuid>')
        .replace(RE_S_IPV4, '<ip>')
        .replace(RE_S_PHONE, m => (m.replace(/\D/g, '').length >= 7 ? '<phone>' : m))
        .replace(RE_S_HEX, m => (/[a-fA-F]/.test(m) && /\d/.test(m) ? '<hex' + m.length + '>' : m))
        .replace(RE_S_DIGITS, m => '<n' + m.length + '>')
        .replace(RE_S_TOKEN, m => (/[A-Za-z]/.test(m) && /\d/.test(m) ? '<token>' : m))
        .slice(0, 160);
}

// Words that make a "Two Capitalised Words" folder a structural name rather
// than a person's name ("Application Support", "Voice Memos", "Saved State").
const COMMON_WORDS = new Set((
    'application applications support caches cache cookies preferences saved state mobile shared group groups ' +
    'storage provider file files local temp tmp backup backups sent private media web kit crash reports report ' +
    'logs log downloads download music movies pictures picture camera roll recent recently deleted screenshots ' +
    'recordings recording voice memos memo notes note photos photo images image video videos audio documents ' +
    'document data library history app apps store system user users profile profiles accounts account settings ' +
    'messages message attachments attachment stickers gifs animated wallpapers wallpaper ringtones alarms ' +
    'notifications podcasts books keyboard dictionary spotlight offline sync cloud drive google apple microsoft ' +
    'chrome safari maps health fitness wallet news weather clock calendar contacts reminders home family sharing ' +
    'game center assets resources frameworks plugins extensions containers metadata journal journals database ' +
    'databases thumbnails previews preview snapshots launch screens splash default main legacy old new archive ' +
    'archived inbox outbox drafts trash spam junk voicemail call calls chat chats status stories story shortcuts ' +
    'widgets widget favorites favourites bookmarks reading list lists tabs search index indexes indices queue ' +
    'uploads upload pending outgoing incoming cached offline transfers transfer received shared links link ' +
    'mail mailbox mailboxes calendars address book phone phones sms imessage facetime itunes purchases purchased ' +
    'top sites visited network action predictor favicons envelope current ' +
    'and of the for in on to by with my your our their'
).split(/\s+/));

function nameShaped(comp) {
    const words = String(comp).split(/[\s_]+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return false;
    if (!words.every(w => /^[A-Z][a-z'\u2019-]+$/.test(w))) return false;
    return !words.some(w => COMMON_WORDS.has(w.toLowerCase()));
}

// Handle + long numeric id ("someuser-235112678-616234") — the warrant-root
// shape the regular Scout path sanitizer also removes.
function _handleWithId(comp) {
    const segs = String(comp).split(/[-_]/);
    return segs.length >= 3 && /[A-Za-z]/.test(segs[0]) && segs.some(s => /^\d{6,}$/.test(s));
}

// scrubIdent + username-shaped segments ("jsmith92" → <id>) and free text
// with spaces that is not made of common words ("Bob's iPhone" → <text>).
// Used for folder / file names and plist keys — not for SQLite column
// names, which are developer-defined.
function scrubName(s) {
    let t = scrubIdent(s);
    t = t.replace(/(^|[._:\/\s-])([A-Za-z]{3,}\d{2,})(?=$|[._:\/\s-])/g, (m, a, b) => (b.length >= 6 ? a + '<id>' : m));
    if (/\s/.test(t.trim())) {
        const words = t.toLowerCase().replace(/<[^>]*>/g, ' ').split(/[^a-z]+/).filter(w => w.length > 1);
        if (words.some(w => !COMMON_WORDS.has(w))) return nameShaped(t) ? '<name-shaped>' : '<text>';
    }
    return t;
}

function genericDir(comp) {
    if (!comp) return comp;
    if (_handleWithId(comp)) return '<redacted-root>';
    if (nameShaped(comp)) return '<dir:name-shaped>';
    const s = scrubName(comp);
    return s === '<text>' || s === '<name-shaped>' ? '<dir>' : s;
}

// ─── Credential material — never opened ───────────────────────────────────

const WITHHELD_RULES = [
    [/(^|\/)keychain[^/]*$/i, 'keychain'],
    [/(^|\/)private\/var\/keychains\//i, 'keychain'],
    // passwords.txt, <id>_passwords.txt, Passcode.csv — the NAME ends with the
    // word, so ordinary "password_change_activity.json" exports stay inspectable.
    [/(^|\/)([^/]*[_ .-])?pass(words?|codes?|phrases?)\.(txt|csv|json|plist|xml|html?|log)$/i, 'passwords'],
    [/(^|\/)(mem|memory)([._-][^/]*)?\.(zip|raw|bin|dmp|mem|lime|7z|gz|tar)$/i, 'memory_image'],
    [/(^|\/)[^/]*[._-](mem|memory)\.(zip|raw|bin|dmp|lime|7z|gz|tar)$/i, 'memory_image'],
    [/\.(dmp|vmem|lime)$/i, 'memory_image'],
    [/\.(key|pem|p12|pfx|keystore|jks|kdbx|keybag|mobilekeybag|kb)$/i, 'key_material'],
    [/(^|\/)locksettings\.db[^/]*$/i, 'lock_screen'],
    [/(^|\/)(gatekeeper\.[^/]*|password\.key|gesture\.key|pattern\.key|personalbackup\.key)$/i, 'lock_screen'],
    [/(^|\/)(wificonfigstore[^/]*\.xml|wpa_supplicant\.conf)$/i, 'wifi_credentials'],
    [/(^|\/)accounts_(ce|de)\.db[^/]*$/i, 'account_tokens'],
    [/(^|\/)(login data|web data|key4\.db|logins\.json|cookies)([-.][^/]*)?$/i, 'browser_credentials'],
    [/(^|\/)lockdown\/(pair_records|escrow_?records?)\//i, 'pairing_records'],
];

// Withheld files whose NAME is a well-known fixed name (safe to show).
const WITHHELD_SAFE_NAMES = new Set([
    'keychain.plist', 'keychain-2.db', 'keychain.csv', 'keychain.txt', 'passwords.txt', 'passcode.txt',
    'mem.zip', 'memory.zip', 'locksettings.db', 'gatekeeper.password.key', 'gatekeeper.pattern.key',
    'password.key', 'gesture.key', 'wificonfigstore.xml', 'wpa_supplicant.conf', 'accounts_ce.db',
    'accounts_de.db', 'login data', 'web data', 'key4.db', 'logins.json', 'cookies', 'systembag.kb',
    'cookies.binarycookies',
]);

function withheldReason(relPath) {
    const p = String(relPath || '').replace(/\\/g, '/');
    for (const [re, why] of WITHHELD_RULES) if (re.test(p)) return why;
    return null;
}

// ─── Known artifacts ───────────────────────────────────────────────────────
// [id, kind, label, pattern].  Patterns match the lower-cased path anywhere
// (`(^|/)…`) so they work whatever prefix the tool puts in front of the file
// system.  kind: sqlite | plist | file | dir.

const KNOWN = [
    // iOS
    ['ios.sms', 'sqlite', 'Messages / iMessage', /(^|\/)private\/var\/mobile\/library\/sms\/sms\.db$/],
    ['ios.sms_attachments', 'dir', 'Message attachments', /(^|\/)private\/var\/mobile\/library\/sms\/attachments\//],
    ['ios.callhistory', 'sqlite', 'Call history', /(^|\/)callhistorydb\/callhistory\.storedata$/],
    ['ios.addressbook', 'sqlite', 'Contacts', /(^|\/)addressbook\/addressbook\.sqlitedb$/],
    ['ios.addressbook_images', 'sqlite', 'Contact photos', /(^|\/)addressbook\/addressbookimages\.sqlitedb$/],
    ['ios.photos', 'sqlite', 'Photos library', /(^|\/)media\/photodata\/photos\.sqlite$/],
    ['ios.dcim', 'dir', 'Camera roll (DCIM)', /(^|\/)private\/var\/mobile\/media\/dcim\//],
    ['ios.safari_history', 'sqlite', 'Safari history', /\/library\/safari\/history\.db$/],
    ['ios.safari_bookmarks', 'sqlite', 'Safari bookmarks', /\/library\/safari\/bookmarks\.db$/],
    ['ios.knowledgec', 'sqlite', 'KnowledgeC (app usage)', /\/coreduet\/knowledge\/knowledgec\.db$/],
    ['ios.interactionc', 'sqlite', 'InteractionC', /\/coreduet\/people\/interactionc\.db$/],
    ['ios.biome', 'dir', 'Biome streams (SEGB)', /(^|\/)private\/var\/mobile\/library\/biome\//],
    ['ios.notes', 'sqlite', 'Notes', /\/notestore\.sqlite$/],
    ['ios.calendar', 'sqlite', 'Calendar', /\/calendar\/calendar\.sqlitedb$/],
    ['ios.health', 'sqlite', 'Health', /\/health\/healthdb(_secure)?\.sqlite$/],
    ['ios.routined_cache', 'sqlite', 'Significant locations (routined Cache)', /\/com\.apple\.routined\/cache\.sqlite$/],
    ['ios.routined_local', 'sqlite', 'Significant locations (routined Local)', /\/routined\/local\.sqlite$/],
    ['ios.locationd', 'sqlite', 'locationd cache', /\/locationd\/cache_encryptedb\.db$/],
    ['ios.datausage', 'sqlite', 'Network data usage', /\/datausage\.sqlite$/],
    ['ios.voicemail', 'sqlite', 'Voicemail', /\/voicemail\/voicemail\.db$/],
    ['ios.voicememos', 'sqlite', 'Voice Memos', /\/recordings\/cloudrecordings\.db$/],
    ['ios.mail', 'sqlite', 'Mail envelope index', /\/library\/mail\/envelope index$/],
    ['ios.accounts', 'sqlite', 'Accounts', /\/accounts\/accounts3\.sqlite$/],
    ['ios.screentime', 'sqlite', 'Screen Time', /rmadminstore-(local|cloud)\.sqlite$/],
    ['ios.powerlog', 'sqlite', 'PowerLog', /currentpowerlog\.plsql$/],
    ['ios.tcc', 'sqlite', 'App permissions (TCC)', /\/tcc\/tcc\.db$/],
    ['ios.applicationstate', 'sqlite', 'Application state', /\/frontboard\/applicationstate\.db$/],
    ['ios.whatsapp', 'sqlite', 'WhatsApp chats', /\/chatstorage\.sqlite$/],
    ['ios.whatsapp_contacts', 'sqlite', 'WhatsApp contacts', /\/contactsv2\.sqlite$/],
    ['ios.telegram', 'sqlite', 'Telegram postbox', /\/postbox\/db\/db_sqlite$/],
    ['ios.signal', 'sqlite', 'Signal (usually encrypted)', /\/grdb\/signal\.sqlite$/],
    ['ios.messenger', 'sqlite', 'Facebook Messenger', /\/lightspeed-[^/]*\.db$/],
    ['ios.snapchat', 'sqlite', 'Snapchat', /\/arroyo\.db$/],
    ['ios.kik', 'sqlite', 'Kik', /\/kik\.sqlite$/],
    ['ios.instagram', 'sqlite', 'Instagram direct', /directsqlitedatabase\/[^/]*\.db$/],
    ['ios.chrome_history', 'sqlite', 'Chrome history', /\/google\/chrome\/[^/]+\/history$/],
    ['ios.systemversion', 'plist', 'iOS version', /(^|\/)system\/library\/coreservices\/systemversion\.plist$/],
    ['ios.wifi', 'plist', 'Known Wi-Fi networks', /systemconfiguration\/com\.apple\.wifi(\.known-networks)?\.plist$/],
    ['ios.lockdown', 'plist', 'Lockdown device data', /\/lockdown\/data_ark\.plist$/],
    ['ios.installed_apps', 'plist', 'Launch services map (installed apps)', /\/mobileinstallation\/lastlaunchservicesmap\.plist$/],
    // Android
    ['android.mmssms', 'sqlite', 'SMS / MMS', /\/com\.android\.providers\.telephony\/databases\/mmssms\.db$/],
    ['android.telephony', 'sqlite', 'Telephony', /\/com\.android\.providers\.telephony\/databases\/telephony\.db$/],
    ['android.bugle', 'sqlite', 'Google Messages (RCS)', /\/com\.google\.android\.apps\.messaging\/databases\/bugle_db$/],
    ['android.contacts', 'sqlite', 'Contacts', /\/com\.android\.providers\.contacts\/databases\/contacts2\.db$/],
    ['android.calllog', 'sqlite', 'Call log', /\/databases\/calllog\.db$/],
    ['android.samsung_logs', 'sqlite', 'Samsung call / message log', /\/com\.sec\.android\.provider\.logsprovider\/databases\/logs\.db$/],
    ['android.whatsapp', 'sqlite', 'WhatsApp messages', /\/com\.whatsapp\/databases\/msgstore\.db$/],
    ['android.whatsapp_contacts', 'sqlite', 'WhatsApp contacts', /\/com\.whatsapp\/databases\/wa\.db$/],
    ['android.chrome_history', 'sqlite', 'Chrome history', /\/com\.android\.chrome\/app_chrome\/default\/history$/],
    ['android.messenger', 'sqlite', 'Facebook Messenger', /\/com\.facebook\.orca\/databases\/threads_db2$/],
    ['android.snapchat', 'sqlite', 'Snapchat', /\/com\.snapchat\.android\/databases\/(main|arroyo)\.db$/],
    ['android.telegram', 'sqlite', 'Telegram', /\/org\.telegram\.messenger\/files\/cache4\.db$/],
    ['android.instagram', 'sqlite', 'Instagram direct', /\/com\.instagram\.android\/databases\/direct\.db$/],
    ['android.signal', 'sqlite', 'Signal (usually encrypted)', /\/org\.thoughtcrime\.securesms\/databases\/signal\.db$/],
    ['android.gphotos', 'sqlite', 'Google Photos', /\/com\.google\.android\.apps\.photos\/databases\/gphotos\d*\.db$/],
    ['android.gmaps', 'sqlite', 'Google Maps', /\/com\.google\.android\.apps\.maps\/databases\/gmm_(storage|myplaces)\.db$/],
    ['android.usagestats', 'dir', 'Usage stats', /(^|\/)data\/system\/usagestats\//],
    ['android.recent_tasks', 'dir', 'Recent tasks', /(^|\/)data\/system_ce\/\d+\/recent_tasks\//],
    ['android.packages', 'file', 'Installed packages (packages.xml)', /(^|\/)data\/system\/packages\.xml$/],
    ['android.buildprop', 'file', 'Build properties', /(^|\/)system\/(system\/)?build\.prop$/],
    ['android.dcim', 'dir', 'Camera (DCIM)', /(^|\/)(data\/media\/\d+|storage\/emulated\/\d+|sdcard)\/dcim\//],
];
const KNOWN_BY_ID = new Map(KNOWN.map(k => [k[0], k]));

const SQLITE_EXT = new Set(['db', 'sqlite', 'sqlite3', 'sqlitedb', 'storedata', 'db3', 'sdb', 'plsql']);
const EXTLESS_SQLITE_NAMES = new Set([
    'history', 'bugle_db', 'threads_db2', 'db_sqlite', 'envelope index', 'favicons', 'top sites',
    'shortcuts', 'network action predictor', 'visited links',
]);
const RE_CONTAINER_META = /(^|\/)containers\/(data|shared|bundle)\/([a-z]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/\.com\.apple\.mobile_container_manager\.metadata\.plist$/i;
const RE_UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMP_NAME_RE = /(files?[_ -]?full|full[_ -]?files?|full[_ -]?file[_ -]?system|[_ -]ffs|^ffs|filesystem\d*)\.(zip|tar)$|\.ufdr$/i;

const IOS_FS_ROOTS = new Set(['private', 'system', 'library', 'usr', 'bin', 'sbin', 'applications', 'var',
    'cores', 'developer', 'etc', 'tmp', 'dev', 'preboot']);
const ANDROID_FS_ROOTS = new Set(['data', 'system', 'vendor', 'product', 'storage', 'sdcard', 'apex', 'mnt',
    'cache', 'metadata', 'efs', 'persist', 'odm', 'system_ext', 'data_mirror']);
const ANDROID_ANCHORS = ['data/data/', 'data/user/', 'data/user_de/', 'data/media/', 'data/system/',
    'data/system_ce/', 'system/build.prop', 'system/system/build.prop'];

// Folder names kept as-is inside user-content areas.
// Also used for paths OUTSIDE the file system (the tool's own folders),
// whose top folder is often named after the device or the case.
const ZONE_KEEP = new Set((
    'dcim photodata download downloads pictures movies music documents android data media obb recordings ' +
    'notifications ringtones alarms podcasts audiobooks screenshots camera thumbnails .thumbnails whatsapp ' +
    'sent private databases backups telegram snapchat instagram facebook messenger signal bluetooth ' +
    'itunes_control books purchases photostreamsdata cloudsharing mutations metadata cplassets deferred cpl ' +
    'journals originals renders thumbs stickers gifs videos images audio report reports logs log files ' +
    'filesystem filesystem1 filesystem2 extraction export exports summary html xml json csv attachments ' +
    'carved artifacts artefacts evidence media_files'
).split(/\s+/).filter(Boolean).concat([
    'whatsapp images', 'whatsapp video', 'whatsapp audio', 'whatsapp documents', 'whatsapp voice notes',
    'whatsapp animated gifs', 'whatsapp stickers', 'whatsapp profile photos', 'telegram images',
    'telegram video', 'telegram documents', 'telegram audio', 'voice recorder', 'screen recordings',
]));
const ZONE_START = [
    /^private\/var\/mobile\/media$/,
    /^private\/var\/mobile\/library\/mobile documents$/,
    /\/file provider storage$/,
    /^data\/media\/\d+$/,
    /^storage\/emulated\/\d+$/,
    /^(mnt\/)?sdcard$/,
];
const ZONE_EXIT = [
    /\/android\/(data|media|obb)$/,
    /^private\/var\/mobile\/media\/photodata$/,
];

function zoneKeep(comp) {
    const low = comp.toLowerCase();
    if (ZONE_KEEP.has(low)) return true;
    if (/^\d{3}[a-z_]{3,8}$/i.test(comp)) return true;            // 100APPLE, 101CANON
    if (/^\d{4}(-\d{2}){0,2}$/.test(comp)) return true;            // date buckets
    if (/^[0-9a-f]{1,4}$/i.test(comp)) return true;                // hash buckets (F00, 0A)
    if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/i.test(comp)) return true;   // reverse-DNS app id
    return false;
}

const PREFIX_KEEP = new Set(['filesystem', 'filesystem1', 'filesystem2', 'fs', 'dump', 'root', 'extraction',
    'files', 'full', 'ffs', 'fullfilesystem', 'full_file_system', 'data', 'image', 'raw']);

// ─── Small helpers ─────────────────────────────────────────────────────────

function normName(n) {
    return String(n || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}
function extOf(base) {
    const i = base.lastIndexOf('.');
    if (i <= 0 || i === base.length - 1) return '';
    const e = base.slice(i + 1).toLowerCase();
    return e.length > 12 || /[^a-z0-9_-]/.test(e) ? '' : e;
}
function _bump(obj, k, n) { obj[k] = (obj[k] || 0) + (n == null ? 1 : n); }
function _topCounts(obj, n) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([k, v]) => (k || '(none)') + ':' + v).join(',');
}
function _jsonLen(x) { try { return JSON.stringify(x).length; } catch { return 1024; } }

function sniffContainer(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const b = Buffer.alloc(512);
        const n = fs.readSync(fd, b, 0, 512, 0);
        if (n >= 4 && b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip';
        if (n >= 2 && b[0] === 0x1F && b[1] === 0x8B) return /\.(tgz|tar\.gz)$/i.test(filePath) ? 'tgz' : null;
        if (n === 512 && (b.toString('ascii', 257, 262) === 'ustar' || (/\.tar$/i.test(filePath) && _tarChecksumOk(b)))) return 'tar';
        return null;
    } catch { return null; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ─── Sources ───────────────────────────────────────────────────────────────

class ZipSource {
    constructor(p) { this.path = p; this.kind = 'zip'; this.zip = null; this.notes = []; }
    scan(onFile) {
        const StreamZip = require('node-stream-zip');
        return new Promise((resolve, reject) => {
            const zip = new StreamZip({ file: this.path, storeEntries: false, skipEntryNameValidation: true });
            this.zip = zip;
            zip.on('entry', (e) => {
                if (e.isDirectory) return;
                try { onFile(normName(e.name), e.size, e); } catch { /* keep scanning */ }
            });
            zip.on('ready', () => resolve());
            zip.on('error', (err) => reject(err));
        });
    }
    open(entry) {
        if (entry.encrypted) return Promise.reject(Object.assign(new Error('encrypted entry'), { code: 'ENCRYPTED' }));
        return new Promise((res, rej) => this.zip.stream(entry, (err, s) => (err ? rej(err) : res(s))));
    }
    close() { try { if (this.zip) this.zip.close(); } catch {} this.zip = null; }
}

function _tarChecksumOk(h) {
    const stored = parseInt(h.toString('ascii', 148, 156).replace(/[\0 ]+/g, ' ').trim(), 8);
    if (!Number.isFinite(stored)) return false;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
    return sum === stored;
}
function _tarNum(h, off, len) {
    if (h[off] & 0x80) {                                  // GNU base-256 (files ≥ 8 GiB)
        let v = h[off] & 0x7F;
        for (let i = 1; i < len; i++) v = v * 256 + h[off + i];
        return v;
    }
    const s = h.toString('ascii', off, off + len).replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) || 0 : 0;
}
function _cstr(h, off, len) {
    const end = h.indexOf(0, off);
    return h.toString('utf8', off, (end < 0 || end > off + len) ? off + len : end);
}
function _parsePax(buf) {
    const out = {};
    let i = 0;
    while (i < buf.length) {
        const sp = buf.indexOf(0x20, i);
        if (sp < 0) break;
        const len = parseInt(buf.toString('ascii', i, sp), 10);
        if (!len || len < 0) break;
        const rec = buf.toString('utf8', sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
    }
    return out;
}

class TarSource {
    constructor(p) { this.path = p; this.kind = 'tar'; this.fd = null; this.notes = []; }
    async scan(onFile) {
        const fd = this.fd = fs.openSync(this.path, 'r');
        const total = fs.fstatSync(fd).size;
        const h = Buffer.alloc(512);
        let pos = 0, zeros = 0, n = 0, longName = null, pax = null;
        const readBuf = (at, len) => {
            const b = Buffer.alloc(len);
            const got = fs.readSync(fd, b, 0, len, at);
            return b.slice(0, got);
        };
        while (pos + 512 <= total) {
            fs.readSync(fd, h, 0, 512, pos);
            if (h.every(x => x === 0)) { pos += 512; if (++zeros >= 2) break; continue; }
            zeros = 0;
            if (!_tarChecksumOk(h)) { this.notes.push('tar_header_unreadable_at_entry_' + n); break; }
            const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
            let size = _tarNum(h, 124, 12);
            const dataPos = pos + 512;
            if (type === 'L') { longName = readBuf(dataPos, Math.min(size, 64 * KiB)).toString('utf8').replace(/\0.*$/s, ''); pos = dataPos + Math.ceil(size / 512) * 512; continue; }
            if (type === 'x') { pax = _parsePax(readBuf(dataPos, Math.min(size, MiB))); pos = dataPos + Math.ceil(size / 512) * 512; continue; }
            if (type === 'K' || type === 'g') { pos = dataPos + Math.ceil(size / 512) * 512; continue; }
            let name = longName || (pax && pax.path) || null;
            if (!name) {
                name = _cstr(h, 0, 100);
                if (h.toString('ascii', 257, 262) === 'ustar') {
                    const prefix = _cstr(h, 345, 155);
                    if (prefix) name = prefix + '/' + name;
                }
            }
            if (pax && pax.size != null && /^\d+$/.test(pax.size)) size = parseInt(pax.size, 10);
            longName = null; pax = null;
            if (type === '0' || type === '7') {
                try { onFile(normName(name), size, { off: dataPos, size }); } catch { /* keep scanning */ }
            }
            pos = dataPos + Math.ceil(size / 512) * 512;
            if (++n % 2000 === 0) await _yield();
        }
    }
    open(h) {
        if (!h.size) return Promise.resolve(require('stream').Readable.from([]));
        return Promise.resolve(fs.createReadStream(this.path, { start: h.off, end: h.off + h.size - 1 }));
    }
    close() { try { if (this.fd != null) fs.closeSync(this.fd); } catch {} this.fd = null; }
}

class DirSource {
    constructor(p) { this.path = p; this.kind = 'dir'; this.notes = []; this.unreadable = 0; }
    async scan(onFile) {
        const stack = [''];
        let n = 0;
        while (stack.length) {
            const rel = stack.pop();
            const abs = rel ? path.join(this.path, rel) : this.path;
            let ents;
            try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { this.unreadable++; continue; }
            for (const d of ents) {
                const r = rel ? rel + '/' + d.name : d.name;
                if (d.isSymbolicLink()) continue;
                if (d.isDirectory()) { stack.push(r); continue; }
                if (!d.isFile()) continue;
                const fileAbs = path.join(abs, d.name);
                let st;
                try { st = fs.statSync(fileAbs); } catch { continue; }
                try { onFile(r, st.size, fileAbs); } catch { /* keep scanning */ }
                if (++n % 500 === 0) await _yield();
            }
        }
        if (this.unreadable) this.notes.push('unreadable_folders:' + this.unreadable);
    }
    open(abs) { return Promise.resolve(fs.createReadStream(abs)); }
    close() {}
}

function openSource(p, kind) {
    if (kind === 'dir') return new DirSource(p);
    if (kind === 'zip') return new ZipSource(p);
    if (kind === 'tar') return new TarSource(p);
    if (kind === 'tgz') {
        throw new Error('Compressed tar (.tar.gz / .tgz) cannot be scanned in place — extract it to a .tar or a folder first.');
    }
    throw new Error('Unsupported device-dump container: ' + path.basename(p));
}

// Stream → Buffer (bounded).  Rejects past maxBytes.
async function readHandle(src, handle, maxBytes) {
    const s = await src.open(handle);
    const chunks = [];
    let got = 0;
    for await (const c of s) {
        got += c.length;
        if (got > maxBytes) { try { s.destroy(); } catch {} throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' }); }
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

// Stream → temp file, bounded, with a magic check on the first 16 bytes so a
// 2 GB encrypted blob is not copied just to be rejected.
async function copyHandleToFile(src, handle, dest, maxBytes, magic) {
    const s = await src.open(handle);
    const fd = fs.openSync(dest, 'w');
    let got = 0, head = Buffer.alloc(0), checked = !magic;
    try {
        for await (const c of s) {
            if (!checked) {
                head = Buffer.concat([head, c]);
                if (head.length >= magic.length) {
                    checked = true;
                    if (!head.slice(0, magic.length).equals(magic)) { try { s.destroy(); } catch {} return { ok: false, reason: 'encrypted_or_not_sqlite' }; }
                }
            }
            got += c.length;
            if (got > maxBytes) { try { s.destroy(); } catch {} return { ok: false, reason: 'too_large' }; }
            fs.writeSync(fd, c);
        }
    } finally { fs.closeSync(fd); }
    if (!checked) return { ok: false, reason: 'encrypted_or_not_sqlite' };
    return { ok: true, bytes: got };
}

// ─── Value shapes (labels only — never values) ────────────────────────────

const RE_V_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const RE_V_EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const RE_V_URL = /^[a-z][a-z0-9+.-]{1,20}:\/\/\S+$/i;
const RE_V_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_V_PHONE = /^\+?[\d\s().-]{7,20}$/;
const RE_V_IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const RE_V_BUNDLE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+){2,}$/i;

function numShape(n, isInt) {
    const a = Math.abs(n);
    if (isInt && (n === 0 || n === 1)) return 'int01';
    if (a >= 9.46e8 && a < 4.1e9) return 'unix_s';
    if (a >= 9.46e11 && a < 4.1e12) return 'unix_ms';
    if (a >= 9.46e14 && a < 4.1e15) return 'unix_us';
    if (a >= 9.46e17 && a < 4.1e18) return 'unix_ns';
    if (a >= 1.0e8 && a < 9.46e8) return 'cocoa_s';
    if (a >= 1.0e17 && a < 9.46e17) return 'cocoa_ns';
    if (a >= 1.25e16 && a < 1.42e16) return 'webkit_us';
    return isInt ? 'int' : 'real';
}

function textShape(s) {
    if (s === '') return 'text_empty';
    const t = s.trim();
    if (RE_V_ISO.test(t)) return 'iso_datetime';
    if (/^\d+$/.test(t)) return t.length >= 7 && t.length <= 15 ? 'digits_7_15' : 'int_str';
    if (RE_V_URL.test(t)) return 'url';
    if (/^[^\s@]+@(s\.whatsapp\.net|g\.us|lid|broadcast)$/i.test(t)) return 'whatsapp_jid';
    if (RE_V_EMAIL.test(t)) return 'email';
    if (RE_V_UUID.test(t)) return 'uuid';
    if (RE_V_IPV4.test(t)) return 'ipv4';
    if (RE_V_PHONE.test(t) && t.replace(/\D/g, '').length >= 7) return 'phone';
    if (/^(tel|mailto|sms):/i.test(t)) return 'uri_contact';
    if (RE_V_BUNDLE.test(t)) return 'reverse_dns';
    if ((t[0] === '{' || t[0] === '[') && t.length < 200000) { try { JSON.parse(t); return 'json'; } catch {} }
    if (t[0] === '<' && /^<(\?xml|[a-z!])/i.test(t)) return 'xml';
    if (/^[0-9a-f]{16,}$/i.test(t)) return 'hex';
    if (t.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) return 'token_or_b64';
    return s.length > 200 ? 'text_long' : 'text';
}

function blobShape(b) {
    if (!b || !b.length) return 'blob_empty';
    const h = (n) => b.toString('latin1', 0, Math.min(b.length, n));
    if (h(8) === 'bplist00') return b.includes('NSKeyedArchiver') ? 'bplist_nskeyed' : 'bplist';
    if (b.length > 12 && b[0] === 0x04 && b[1] === 0x0B && h(13).slice(2) === 'streamtyped') return 'typedstream';
    if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
    if (h(4) === '\x89PNG') return 'png';
    if (h(3) === 'GIF') return 'gif';
    if (b.length > 12 && h(12).slice(4, 8) === 'ftyp') return /heic|heix|mif1/.test(h(12).slice(8, 12)) ? 'heic' : 'mp4';
    if (b[0] === 0x1F && b[1] === 0x8B) return 'gzip';
    if (b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x9C || b[1] === 0xDA)) return 'zlib';
    if (h(4) === 'PK\x03\x04') return 'zip';
    if (h(15) === 'SQLite format 3') return 'sqlite';
    if (h(4) === 'SEGB') return 'segb';
    if (b.length === 16) return 'bytes16_uuid?';
    if (b[0] === 0x7B || b[0] === 0x5B) { try { JSON.parse(b.toString('utf8')); return 'json'; } catch {} }
    if (b[0] === 0x3C) return 'xml?';
    let printable = 0;
    const n = Math.min(b.length, 256);
    for (let i = 0; i < n; i++) if ((b[i] >= 0x20 && b[i] < 0x7F) || b[i] === 9 || b[i] === 10 || b[i] === 13) printable++;
    if (printable / n > 0.9) return 'utf8_text';
    if ([0x08, 0x0A, 0x10, 0x12, 0x18, 0x1A, 0x20, 0x22].includes(b[0])) return 'protobuf?';
    return 'blob';
}

function valueShape(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return numShape(v, Number.isInteger(v));
    if (typeof v === 'bigint') return numShape(Number(v), true);
    if (typeof v === 'string') return textShape(v);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return blobShape(Buffer.from(v));
    if (typeof v === 'boolean') return 'bool';
    return 'other';
}

// ─── SQLite profiling ─────────────────────────────────────────────────────

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function profileSqliteFile(file, size, limits) {
    const L = _limits(limits);
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { return { error: 'sqlite_unavailable' }; }
    let db;
    try { db = new Database(file, { readonly: true, fileMustExist: true }); }
    catch (e) { return { error: 'open_failed', code: (e && e.code) || 'error' }; }
    try {
        const out = {};
        try { out.user_version = db.pragma('user_version', { simple: true }); } catch {}
        try { out.page_size = db.pragma('page_size', { simple: true }); } catch {}
        let master;
        try { master = db.prepare('SELECT type, name, sql FROM sqlite_master').all(); }
        catch (e) { return { error: 'not_readable', code: (e && e.code) || 'error' }; }
        const tables = master.filter(m => m.type === 'table');
        const names = new Set(tables.map(m => m.name));
        out.table_count = tables.length;
        out.views = master.filter(m => m.type === 'view').length;
        out.triggers = master.filter(m => m.type === 'trigger').length;
        out.indexes = master.filter(m => m.type === 'index').length;
        out.tables = [];
        const N = L.sqliteSampleRows;
        for (const m of tables.slice(0, L.sqliteMaxTables)) {
            const t = { name: scrubIdent(m.name) };
            const sql = m.sql || '';
            const virt = /^\s*CREATE\s+VIRTUAL\s+TABLE[\s\S]*?\bUSING\s+(\w+)/i.exec(sql);
            if (virt) t.virtual = virt[1].toLowerCase();
            if (/WITHOUT\s+ROWID/i.test(sql)) t.without_rowid = true;
            let cols = [];
            try { cols = db.prepare('PRAGMA table_xinfo(' + qi(m.name) + ')').all(); }
            catch { try { cols = db.prepare('PRAGMA table_info(' + qi(m.name) + ')').all(); } catch {} }
            cols = cols.filter(c => c.hidden !== 1);
            try {
                if (size <= L.sqliteExactCountBytes || t.without_rowid || t.virtual) {
                    t.rows = db.prepare('SELECT COUNT(*) AS c FROM ' + qi(m.name)).get().c;
                } else {
                    t.rows_est = db.prepare('SELECT MAX(rowid) AS c FROM ' + qi(m.name)).get().c || 0;
                }
            } catch { t.rows = null; }
            // Sample: first N and (if larger) last N rows — newer rows show
            // newer schema usage.  Only the shape of each value is kept.
            const shapes = new Map();
            let sampled = 0;
            const take = (sqlText) => {
                const st = db.prepare(sqlText);
                st.raw(true);
                const colNames = st.columns().map(c => c.name);
                for (const row of st.iterate()) {
                    sampled++;
                    for (let i = 0; i < row.length; i++) {
                        const k = colNames[i];
                        let mm = shapes.get(k);
                        if (!mm) { mm = {}; shapes.set(k, mm); }
                        _bump(mm, valueShape(row[i]));
                    }
                }
            };
            const rowsKnown = t.rows != null ? t.rows : (t.rows_est || 0);
            if (rowsKnown !== 0) {
                try { take('SELECT * FROM ' + qi(m.name) + ' LIMIT ' + N); } catch { t.sample_error = true; }
                if (rowsKnown > N && !t.without_rowid && !t.virtual) {
                    // Tail sample only covers rows the head didn't (no double counting).
                    const tail = Math.min(N, rowsKnown - N);
                    try { take('SELECT * FROM ' + qi(m.name) + ' ORDER BY rowid DESC LIMIT ' + tail); } catch {}
                }
            }
            t.sampled = sampled;
            const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => scrubIdent(c.name));
            if (pk.length) t.pk = pk;
            t.cols = cols.map(c => {
                const sh = shapes.get(c.name);
                return [scrubIdent(c.name), String(c.type || '').slice(0, 40), sh ? _topCounts(sh, 6) : ''];
            });
            out.tables.push(t);
        }
        if (tables.length > L.sqliteMaxTables) out.tables_omitted = tables.length - L.sqliteMaxTables;
        if (names.has('Z_PRIMARYKEY') && names.has('Z_METADATA')) {
            out.coredata = true;
            try {
                out.coredata_entities = db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY ORDER BY Z_ENT').all()
                    .slice(0, 400).map(r => [r.Z_ENT, scrubIdent(String(r.Z_NAME))]);
            } catch {}
        }
        return out;
    } finally {
        try { db.close(); } catch {}
    }
}

// SQLite header bytes 18/19 = 2 mean WAL mode.  Without its -wal file the DB
// still opens once they read 1 (rollback journal); WAL-only rows are not
// seen, which is fine for a schema survey.
function _patchWalHeader(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r+');
        const b = Buffer.alloc(20);
        fs.readSync(fd, b, 0, 20, 0);
        if (b[18] === 2 || b[19] === 2) { fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18); return true; }
        return false;
    } catch { return false; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function _fitDb(p, remaining) {
    let s = _jsonLen(p);
    if (s <= remaining) return [p, s];
    if (p.tables) {
        const p1 = Object.assign({}, p, { detail: 'columns_only',
            tables: p.tables.map(t => Object.assign({}, t, { cols: t.cols.map(c => [c[0], c[1]]) })) });
        s = _jsonLen(p1); if (s <= remaining) return [p1, s];
        const p2 = Object.assign({}, p, { detail: 'tables_only',
            tables: p.tables.map(t => ({ name: t.name, rows: t.rows, rows_est: t.rows_est, cols: t.cols.length })) });
        delete p2.coredata_entities;
        s = _jsonLen(p2); if (s <= remaining) return [p2, s];
    }
    const p3 = { path: p.path, size: p.size, artifact: p.artifact, table_count: p.table_count,
        skipped: p.skipped, error: p.error, detail: 'summary_only' };
    return [p3, _jsonLen(p3)];
}

// ─── Plist parsing (binary + XML) ──────────────────────────────────────────

function _uintBE(buf, off, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[off + i];
    return v;
}

function parseBplist(buf, maxObjects) {
    if (!buf || buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary plist');
    const t = buf.length - 32;
    const offSize = buf[t + 6], refSize = buf[t + 7];
    const numObjects = _uintBE(buf, t + 8, 8), top = _uintBE(buf, t + 16, 8), offTable = _uintBE(buf, t + 24, 8);
    if (!offSize || !refSize || numObjects > (maxObjects || 500000) || offTable + numObjects * offSize > t || top >= numObjects) {
        throw new Error('bad bplist trailer');
    }
    let visits = 0;
    const offset = (i) => {
        if (i >= numObjects) throw new Error('bad ref');
        const o = _uintBE(buf, offTable + i * offSize, offSize);
        if (o >= t) throw new Error('bad offset');
        return o;
    };
    const lenAt = (pos, lo) => {
        if (lo !== 0xF) return [lo, pos + 1];
        const m = buf[pos + 1];
        const n = 1 << (m & 0xF);
        return [_uintBE(buf, pos + 2, n), pos + 2 + n];
    };
    function obj(i, depth) {
        if (depth > 64 || ++visits > 400000) throw new Error('bplist too deep');
        const pos = offset(i);
        const marker = buf[pos], hi = marker >> 4, lo = marker & 0xF;
        switch (hi) {
            case 0x0: return lo === 8 ? false : lo === 9 ? true : null;
            case 0x1: {
                const n = 1 << lo;
                if (n === 8) return Number(buf.readBigInt64BE(pos + 1));
                if (n === 16) return Number(buf.readBigInt64BE(pos + 9));
                return _uintBE(buf, pos + 1, n);
            }
            case 0x2: return lo === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
            case 0x3: return { __date: buf.readDoubleBE(pos + 1) };
            case 0x4: { const [len, s] = lenAt(pos, lo); return buf.slice(s, s + len); }
            case 0x5: { const [len, s] = lenAt(pos, lo); return buf.toString('latin1', s, s + len); }
            case 0x6: {
                const [len, s] = lenAt(pos, lo);
                const b = Buffer.from(buf.slice(s, s + len * 2));
                b.swap16();
                return b.toString('utf16le');
            }
            case 0x7: { const [len, s] = lenAt(pos, lo); return buf.toString('utf8', s, s + len); }
            case 0x8: return { __uid: _uintBE(buf, pos + 1, lo + 1) };
            case 0xA: case 0xC: {
                const [len, s] = lenAt(pos, lo);
                const arr = [];
                for (let k = 0; k < len; k++) arr.push(obj(_uintBE(buf, s + k * refSize, refSize), depth + 1));
                return arr;
            }
            case 0xD: {
                const [len, s] = lenAt(pos, lo);
                const d = Object.create(null);
                for (let k = 0; k < len; k++) {
                    const key = obj(_uintBE(buf, s + k * refSize, refSize), depth + 1);
                    d[String(key)] = obj(_uintBE(buf, s + (len + k) * refSize, refSize), depth + 1);
                }
                return d;
            }
            default: return null;
        }
    }
    return obj(top, 0);
}

function _xmlUnescape(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
        const l = e.toLowerCase();
        if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&';
        if (l === 'quot') return '"'; if (l === 'apos') return "'";
        const code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
        try { return String.fromCodePoint(code); } catch { return ''; }
    });
}

function parseXmlPlist(text) {
    const src = String(text).replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
    const re = /<(\/)?([A-Za-z]+)[^>]*?(\/)?>|([^<]+)/g;
    const stack = [{ tag: 'root', kids: [], text: '' }];
    const LEAF = new Set(['string', 'key', 'integer', 'real', 'date', 'data']);
    const build = (node) => {
        switch (node.tag) {
            case 'dict': {
                const d = Object.create(null);
                for (let i = 0; i + 1 < node.kids.length; i += 2) {
                    const k = node.kids[i];
                    d[k && k.__key != null ? k.__key : String(i)] = node.kids[i + 1];
                }
                return d;
            }
            case 'array': return node.kids;
            case 'key': return { __key: _xmlUnescape(node.text) };
            case 'string': return _xmlUnescape(node.text);
            case 'integer': return parseInt(node.text, 10) || 0;
            case 'real': return parseFloat(node.text) || 0;
            case 'date': return { __date: node.text.trim() };
            case 'data': return Buffer.from(node.text.replace(/\s+/g, ''), 'base64');
            case 'true': return true;
            case 'false': return false;
            case 'plist': return node.kids[0];
            default: return null;
        }
    };
    let m, steps = 0;
    while ((m = re.exec(src))) {
        if (++steps > 2000000) throw new Error('plist too large');
        const top = stack[stack.length - 1];
        if (m[4] != null) { if (LEAF.has(top.tag)) top.text += m[4]; continue; }
        const tag = m[2].toLowerCase();
        if (m[3]) { top.kids.push(build({ tag, kids: [], text: '' })); continue; }
        if (!m[1]) { stack.push({ tag, kids: [], text: '' }); if (stack.length > 200) throw new Error('plist too deep'); continue; }
        if (stack.length > 1) {
            const node = stack.pop();
            stack[stack.length - 1].kids.push(build(node));
        }
    }
    const root = stack[0].kids;
    return root.length ? root[root.length - 1] : null;
}

function parsePlist(buf) {
    if (buf.length >= 8 && buf.toString('latin1', 0, 8) === 'bplist00') return { format: 'binary', value: parseBplist(buf) };
    const text = buf.toString('utf8');
    if (/<plist[\s>]/.test(text.slice(0, 4096))) return { format: 'xml', value: parseXmlPlist(text) };
    throw new Error('not a plist');
}

function _isDict(x) { return x && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x) && x.__date === undefined && x.__uid === undefined; }

function plistTypeOf(x) {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'boolean') return 'bool';
    if (typeof x === 'number') return Number.isInteger(x) ? 'int:' + numShape(x, true) : 'real:' + numShape(x, false);
    if (typeof x === 'string') return 'string:' + textShape(x);
    if (Buffer.isBuffer(x)) return 'data:' + blobShape(x);
    if (Array.isArray(x)) return 'array';
    if (x.__date !== undefined) return 'date';
    if (x.__uid !== undefined) return 'uid';
    return 'dict';
}

function _safeKey(k) {
    const s = String(k);
    if (nameShaped(s)) return '<key:name-shaped>';
    const t = scrubName(s).replace(/\//g, '\u2215');
    return t === '<text>' || t === '<name-shaped>' ? '<key:' + t.slice(1, -1) + '>' : t;
}

// Keys that name a network / account / person rather than a field
// ("wifi.network.ssid.HomeNet", "account_jdoe") — everything after the stem
// is replaced with <*>.
const RE_KEY_STEM = /^(.*?(?:b?ssid|network|account|user(?:name)?|email|phone|contact|device[_ .-]?name|hostname)s?[.:_\/-])./i;
const RE_KEY_SEP = /[.:_\/-]/;
const KEY_GROUP_MIN = 8;

/**
 * Group a dict's keys for display.  Returns [[displayKey, [origKeys]]].
 * Keys sharing a separator-terminated prefix with ≥ KEY_GROUP_MIN siblings
 * (a map keyed by data, not a struct) collapse to `prefix<*>`; keys with a
 * network / account stem always collapse.
 */
function _groupKeys(keys) {
    const out = new Map();
    const push = (d, k) => { let a = out.get(d); if (!a) { a = []; out.set(d, a); } a.push(k); };
    const cnt = new Map();
    for (const k of keys) {
        for (let i = 0; i < k.length - 1 && i < 120; i++) {
            if (RE_KEY_SEP.test(k[i])) { const p = k.slice(0, i + 1); cnt.set(p, (cnt.get(p) || 0) + 1); }
        }
    }
    for (const k of keys) {
        const f = RE_KEY_STEM.exec(k);
        if (f) { push(_safeKey(f[1]) + '<*>', k); continue; }
        let best = null;
        for (let i = Math.min(k.length - 2, 119); i >= 0; i--) {
            if (RE_KEY_SEP.test(k[i])) { const p = k.slice(0, i + 1); if (cnt.get(p) >= KEY_GROUP_MIN) { best = p; break; } }
        }
        push(best ? _safeKey(best) + '<*>' : _safeKey(k), k);
    }
    return [...out.entries()];
}

function plistShape(value, limits) {
    const L = _limits(limits);
    const paths = new Map();
    let nodes = 0, truncated = false;
    const add = (p, t) => {
        let s = paths.get(p);
        if (!s) { if (paths.size >= L.plistMaxPaths) { truncated = true; return false; } s = new Set(); paths.set(p, s); }
        s.add(t);
        return true;
    };
    const walk = (x, p, depth) => {
        if (++nodes > 60000 || depth > 24) { truncated = true; return; }
        if (!add(p || '/', plistTypeOf(x))) return;
        if (Array.isArray(x)) { for (const el of x.slice(0, 200)) walk(el, p + '[]', depth + 1); return; }
        if (_isDict(x)) {
            const keys = Object.keys(x);
            if (keys.length > 64) {
                add(p || '/', 'map:' + keys.length + '_keys');
                for (const k of keys.slice(0, 40)) walk(x[k], p + '/<key>', depth + 1);
                return;
            }
            for (const [disp, ks] of _groupKeys(keys)) {
                for (const k of ks.slice(0, 20)) walk(x[k], p + '/' + disp, depth + 1);
            }
        }
    };
    const out = {};
    if (_isDict(value) && value.$archiver === 'NSKeyedArchiver' && Array.isArray(value.$objects)) {
        out.nskeyedarchiver = true;
        const classes = new Set();
        for (const o of value.$objects) if (_isDict(o) && typeof o.$classname === 'string') classes.add(scrubIdent(o.$classname));
        out.classes = [...classes].slice(0, 80);
        if (_isDict(value.$top)) out.top_keys = _groupKeys(Object.keys(value.$top).slice(0, 40)).map(g => g[0]);
        walk(value.$objects.slice(0, 300), '$objects', 0);
    } else {
        walk(value, '', 0);
    }
    out.keys = [...paths.entries()].map(([p, s]) => [p, [...s].join('|')]);
    if (truncated) out.truncated = true;
    return out;
}

// ─── Path display (privacy policy) ─────────────────────────────────────────

// startZone: true for paths outside the device file system (the tool's own
// folders are often named after the device, case or examiner).
function displayDirParts(parts, ctx, L, startZone) {
    const out = [];
    const low = parts.map(p => p.toLowerCase());
    let zone = !!startZone;
    for (let i = 0; i < parts.length; i++) {
        if (out.length >= L.dirMaxDepth) { out.push('\u2026'); break; }
        const comp = parts[i];
        const prev2 = low.slice(Math.max(0, i - 2), i).join('/');
        let shown;
        if (RE_UUID_ONLY.test(comp) && /^(data|shared|bundle)\/[a-z]+$/.test(prev2) && low[i - 3] === 'containers') {
            const kind = prev2 === 'data/application' ? 'app' : prev2 === 'shared/appgroup' ? 'group'
                : prev2 === 'bundle/application' ? 'bundle' : 'plugin';
            const id = ctx.uuidMap && ctx.uuidMap.get(low[i]);
            shown = '<' + kind + ':' + (id ? scrubIdent(id) : '?') + '>';
            out.push(shown);
            if (kind === 'bundle') { if (i < parts.length - 1) out.push('\u2026'); break; }
        } else {
            shown = zone ? (zoneKeep(comp) ? comp : '<dir>') : genericDir(comp);
            out.push(shown);
        }
        const sofar = low.slice(0, i + 1).join('/');
        if (!zone && ZONE_START.some(re => re.test(sofar))) zone = true;
        else if (zone && ZONE_EXIT.some(re => re.test(sofar))) zone = false;
    }
    return { parts: out, zone };
}

function displayFileName(base, zone) {
    const ext = extOf(base.toLowerCase());
    const dotExt = ext ? '.' + ext : '';
    if (zone) return '<file>' + dotExt;
    if (nameShaped(ext ? base.slice(0, -dotExt.length) : base)) return '<file:name-shaped>' + dotExt;
    const s = scrubName(base);
    return s === '<text>' || s === '<name-shaped>' ? '<file>' + dotExt : s;
}

// ─── Plan: which inputs get a device scan ──────────────────────────────────

function looksLikeFsRoot(dir) {
    const ex = (...p) => { try { return fs.existsSync(path.join(dir, ...p)); } catch { return false; } };
    return ex('private', 'var') || ex('data', 'data') || ex('system', 'build.prop') ||
        (ex('data', 'media') && ex('system')) || ex('data', 'user', '0');
}

function planSources(rootPath, stat, opts) {
    const o = opts || {};
    const L = _limits(o.limits);
    const mobile = o.formatCategory === 'mobile_forensics';
    const forced = !!o.deviceMode;
    const qualifies = (p, size, kind) => kind === 'tar' || kind === 'tgz' || forced || DUMP_NAME_RE.test(path.basename(p)) ||
        size >= L.deviceMinBytes || (mobile && size >= L.mobileMinBytes);
    if (stat.isFile()) {
        if (withheldReason(path.basename(rootPath))) return { sources: [] };
        const kind = sniffContainer(rootPath);
        if (!kind || !qualifies(rootPath, stat.size, kind)) return { sources: [] };
        return { sources: [{ path: rootPath, kind, size: stat.size,
            fallbackAllowed: kind === 'zip' && !forced }] };
    }
    if (!stat.isDirectory()) return { sources: [] };
    if (looksLikeFsRoot(rootPath)) return { rootIsDevice: true, sources: [{ path: rootPath, kind: 'dir', size: 0 }] };
    const sources = [];
    const visit = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of ents.slice(0, 2000)) {
            const abs = path.join(dir, d.name);
            if (d.isDirectory()) {
                if (looksLikeFsRoot(abs)) sources.push({ path: abs, kind: 'dir', size: 0 });
                else if (depth < 2) visit(abs, depth + 1);
                continue;
            }
            if (!d.isFile() || withheldReason(d.name)) continue;
            let st; try { st = fs.statSync(abs); } catch { continue; }
            const kind = sniffContainer(abs);
            if (kind && qualifies(abs, st.size, kind)) sources.push({ path: abs, kind, size: st.size });
        }
    };
    visit(rootPath, 1);
    return { sources };
}

// ─── The scan ──────────────────────────────────────────────────────────────

/**
 * Survey one device dump.  Returns `{ isDevice:false, files }` when
 * `opts.fallbackAllowed` and the archive turns out to be an ordinary
 * (non-device, ≤ maxPlainFiles) zip — the caller then runs the normal walk.
 *
 * opts: { kind, limits, onProgress, fallbackAllowed, label,
 *         addLoose(rel, size, buf) — normal Scout inspection of tool files,
 *         tmpDir }
 */
async function scanDevice(srcPath, opts) {
    const o = opts || {};
    const L = _limits(o.limits);
    const t0 = Date.now();
    const progress = (p) => { if (typeof o.onProgress === 'function') { try { o.onProgress(p); } catch {} } };
    const src = openSource(srcPath, o.kind || (fs.statSync(srcPath).isDirectory() ? 'dir' : sniffContainer(srcPath)));

    const st = {
        files: 0, bytes: 0, maxDepth: 0, ext: {}, dirs: new Map(),
        votes: { ios: 0, android: 0 }, prefixes: new Map(),
        withheld: [], withheldCount: 0,
        sqlite: [], walSizes: new Map(), plists: [], containerMeta: [], buildProps: [],
        known: new Map(), knownDirs: new Map(), loose: [], plistTotal: 0, sqliteTotal: 0,
    };
    const vote = (platform, prefix) => {
        st.votes[platform]++;
        if (st.prefixes.size < 64 || st.prefixes.has(prefix)) {
            const k = platform + '\u0000' + prefix;
            st.prefixes.set(k, (st.prefixes.get(k) || 0) + 1);
        }
    };

    const onFile = (rel, size, handle) => {
        if (!rel) return;
        st.files++; st.bytes += size;
        const low = rel.toLowerCase();
        const slash = rel.lastIndexOf('/');
        const dir = slash >= 0 ? rel.slice(0, slash) : '';
        const base = slash >= 0 ? rel.slice(slash + 1) : rel;
        const lowBase = base.toLowerCase();
        const ext = extOf(lowBase);
        _bump(st.ext, ext);
        let depth = 1;
        for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) depth++;
        if (depth > st.maxDepth) st.maxDepth = depth;
        let d = st.dirs.get(dir);
        if (!d) { d = { f: 0, b: 0, x: {} }; st.dirs.set(dir, d); }
        d.f++; d.b += size;
        if (d.x[ext] !== undefined || Object.keys(d.x).length < 12) _bump(d.x, ext); else _bump(d.x, '*');

        // Platform anchors
        const iv = low.indexOf('private/var/');
        if (iv === 0 || (iv > 0 && low[iv - 1] === '/')) vote('ios', rel.slice(0, iv));
        else {
            for (const a of ANDROID_ANCHORS) {
                const ia = low.indexOf(a);
                if (ia === 0 || (ia > 0 && low[ia - 1] === '/')) { vote('android', rel.slice(0, ia)); break; }
            }
        }

        if (st.files % L.progressEvery === 0) progress({ phase: 'device-list', files: st.files, bytes: st.bytes });

        const why = withheldReason(low);
        if (why) {
            st.withheldCount++;
            if (st.withheld.length < L.withheldMax) st.withheld.push({ rel, size, reason: why });
            return;
        }

        // Known artifacts
        let knownId = null;
        for (const k of KNOWN) {
            if (!k[3].test(low)) continue;
            if (k[1] === 'dir') {
                let kd = st.knownDirs.get(k[0]);
                if (!kd) { kd = { files: 0, bytes: 0, x: {} }; st.knownDirs.set(k[0], kd); }
                kd.files++; kd.bytes += size; _bump(kd.x, ext);
                continue;
            }
            let arr = st.known.get(k[0]);
            if (!arr) { arr = { count: 0, hits: [] }; st.known.set(k[0], arr); }
            arr.count++;
            if (arr.hits.length < L.knownHitsPerId) arr.hits.push({ rel, size, handle });
            knownId = k[0];
            break;
        }

        if (low.endsWith('-wal')) { st.walSizes.set(low.slice(0, -4), size); return; }
        if (/-(journal|shm)$/.test(low)) return;

        const parentLow = dir.toLowerCase();
        const isSqlite = (knownId && KNOWN_BY_ID.get(knownId)[1] === 'sqlite') || SQLITE_EXT.has(ext) ||
            (!ext && (EXTLESS_SQLITE_NAMES.has(lowBase) || /(^|\/)databases$/.test(parentLow)));
        if (isSqlite) { st.sqliteTotal++; st.sqlite.push({ rel, size, handle, known: knownId }); }

        if (ext === 'plist') {
            st.plistTotal++;
            if (RE_CONTAINER_META.test(rel)) {
                if (st.containerMeta.length < L.containerPlistMax) st.containerMeta.push({ rel, size, handle });
            } else if (knownId || /\/library\/preferences\/[^/]+\.plist$/.test(low)) {
                st.plists.push({ rel, size, handle, known: knownId });
            }
        }
        if (lowBase === 'build.prop' && st.buildProps.length < 4) st.buildProps.push({ rel, size, handle });
        if (depth <= L.toolFileMaxDepth && size <= L.toolFileMaxBytes && st.loose.length < 3000) {
            // Skip what is obviously device file system (top or second folder
            // is an FS root) so tool files are not crowded out.
            const segs = low.split('/', 3);
            const fsish = (s) => IOS_FS_ROOTS.has(s) || ANDROID_FS_ROOTS.has(s);
            if (!(segs.length > 1 && (fsish(segs[0]) || (segs.length > 2 && fsish(segs[1]))))) {
                st.loose.push({ rel, size, handle });
            }
        }
    };

    const result = { scanner: 'scout-device/1', container: src.kind };
    let tmpDir = null;
    try {
        progress({ phase: 'device-list', files: 0, bytes: 0 });
        await src.scan(onFile);
        progress({ phase: 'device-list', files: st.files, bytes: st.bytes, done: true });

        // ── Platform + file-system prefix ────────────────────────────────
        let platform = 'unknown';
        if (st.votes.ios >= 3 && st.votes.ios >= st.votes.android) platform = 'ios';
        else if (st.votes.android >= 3) platform = 'android';
        let prefix = '';
        if (platform !== 'unknown') {
            let best = -1;
            for (const [k, c] of st.prefixes) {
                const [pl, pf] = k.split('\u0000');
                if (pl === platform && c > best) { best = c; prefix = pf; }
            }
        }
        if (o.fallbackAllowed && platform === 'unknown' && st.files <= L.maxPlainFiles) {
            return { isDevice: false, files: st.files };
        }
        const fsRoots = platform === 'ios' ? IOS_FS_ROOTS : platform === 'android' ? ANDROID_FS_ROOTS : null;
        const canon = (rel) => {
            if (!fsRoots) return null;
            if (prefix && !rel.startsWith(prefix)) return null;
            const c = rel.slice(prefix.length);
            const top = c.split('/')[0].toLowerCase();
            return fsRoots.has(top) ? c : null;
        };

        Object.assign(result, {
            isDevice: platform !== 'unknown',
            platform,
            source_name: DUMP_NAME_RE.test(path.basename(srcPath))
                ? '<id>' + path.basename(srcPath).replace(/^.*?([_ -]?(files?[_ -]?full|full[_ -]?files?|full[_ -]?file[_ -]?system|ffs|filesystem\d*)\.(zip|tar)|\.ufdr)$/i, '$1')
                : (src.kind === 'dir' ? '<folder>' : '<file>.' + (extOf(path.basename(srcPath).toLowerCase()) || src.kind)),
            source_bytes: src.kind === 'dir' ? st.bytes : (() => { try { return fs.statSync(srcPath).size; } catch { return 0; } })(),
            files: st.files,
            bytes: st.bytes,
            dirs: st.dirs.size,
            max_depth: st.maxDepth,
            layout: {
                fs_prefix: prefix ? prefix.split('/').filter(Boolean).map(c => (PREFIX_KEEP.has(c.toLowerCase()) ? c : '<dir>')) : [],
                anchor_votes: st.votes,
            },
        });

        // ── iOS container UUID → bundle id ───────────────────────────────
        const ctx = { uuidMap: new Map() };
        if (st.containerMeta.length) {
            let done = 0;
            for (const c of st.containerMeta) {
                const m = RE_CONTAINER_META.exec(c.rel);
                try {
                    const buf = await readHandle(src, c.handle, MiB);
                    const v = parsePlist(buf).value;
                    const id = _isDict(v) && typeof v.MCMMetadataIdentifier === 'string' ? v.MCMMetadataIdentifier : null;
                    if (m && id) ctx.uuidMap.set(m[4].toLowerCase(), /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : scrubIdent(id));
                } catch { /* unreadable metadata — container stays <app:?> */ }
                if (++done % 100 === 0) { progress({ phase: 'device-apps', done, total: st.containerMeta.length }); await _yield(); }
            }
        }

        const dispFile = (rel) => {
            const c = canon(rel);
            const parts = (c != null ? c : rel).split('/');
            const base = parts.pop();
            const dd = displayDirParts(parts, ctx, L, c == null);
            const head = c != null ? '<fs>' : '<outside>';
            return [head].concat(dd.parts, [displayFileName(base, dd.zone)]).join('/');
        };

        // ── Device info (version only) ───────────────────────────────────
        const device = {};
        const svHit = st.known.get('ios.systemversion');
        if (svHit && svHit.hits[0]) {
            try {
                const v = parsePlist(await readHandle(src, svHit.hits[0].handle, MiB)).value;
                const ok = (s) => (typeof s === 'string' && /^[\w .()-]{1,40}$/.test(s) ? s : undefined);
                if (_isDict(v)) Object.assign(device, { os: ok(v.ProductName) || 'iOS', os_version: ok(v.ProductVersion), os_build: ok(v.ProductBuildVersion) });
            } catch {}
        }
        for (const bp of st.buildProps) {
            try {
                const txt = (await readHandle(src, bp.handle, 2 * MiB)).toString('utf8');
                const keep = { 'ro.build.version.release': 'os_version', 'ro.build.version.sdk': 'sdk',
                    'ro.build.version.security_patch': 'security_patch', 'ro.product.manufacturer': 'manufacturer',
                    'ro.product.model': 'model', 'ro.product.system.manufacturer': 'manufacturer',
                    'ro.product.system.model': 'model' };
                for (const line of txt.split(/\r?\n/)) {
                    const mm = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
                    if (mm && keep[mm[1]] && /^[\w .()-]{1,40}$/.test(mm[2]) && !device[keep[mm[1]]]) device[keep[mm[1]]] = mm[2];
                }
                if (Object.keys(device).length) { device.os = device.os || 'Android'; break; }
            } catch {}
        }
        result.device = device;

        // ── Known artifacts ──────────────────────────────────────────────
        const knownOut = [];
        for (const k of KNOWN) {
            if (k[1] === 'dir') {
                const kd = st.knownDirs.get(k[0]);
                if (kd) knownOut.push({ id: k[0], label: k[2], kind: 'dir', files: kd.files, bytes: kd.bytes, exts: _topCounts(kd.x, 6) });
                continue;
            }
            const h = st.known.get(k[0]);
            if (h) knownOut.push({ id: k[0], label: k[2], kind: k[1], count: h.count, paths: h.hits.map(x => [dispFile(x.rel), x.size]) });
        }
        result.known_artifacts = knownOut;
        if (platform !== 'unknown') {
            result.known_missing = KNOWN.filter(k => k[0].startsWith(platform + '.') && !st.known.has(k[0]) && !st.knownDirs.has(k[0])).map(k => k[0]);
        }

        // ── SQLite ───────────────────────────────────────────────────────
        const knownOrder = new Map(KNOWN.map((k, i) => [k[0], i]));
        const seen = new Set();
        const queue = st.sqlite.filter(x => x.known).sort((a, b) => knownOrder.get(a.known) - knownOrder.get(b.known))
            .concat(st.sqlite.filter(x => !x.known && x.size > 0).sort((a, b) => b.size - a.size))
            .filter(x => (seen.has(x.rel) ? false : (seen.add(x.rel), true)));
        const sel = queue.slice(0, L.sqliteMaxDbs);
        const sq = { candidates: st.sqliteTotal, selected: sel.length, profiled: 0, skipped: {}, dbs: [] };
        if (queue.length > sel.length) sq.skipped.over_db_cap = queue.length - sel.length;
        let sqBytes = 0, extracted = 0;
        const tSq = Date.now();
        if (sel.length) tmpDir = fs.mkdtempSync(path.join(o.tmpDir || os.tmpdir(), 'viper-scout-'));
        for (let i = 0; i < sel.length; i++) {
            const c = sel[i];
            const p = { path: dispFile(c.rel), size: c.size };
            if (c.known) p.artifact = c.known;
            const wal = st.walSizes.get(c.rel.toLowerCase());
            if (wal) p.wal_bytes = wal;
            const skip = (why) => { p.skipped = why; _bump(sq.skipped, why); };
            if (Date.now() - tSq > L.sqliteTimeMs) skip('time_budget');
            else if (c.size > L.sqliteMaxDbBytes) skip('too_large');
            else if (extracted + c.size > L.sqliteTotalBytes) skip('byte_budget');
            else {
                let free = Infinity;
                try { if (fs.statfsSync) { const sf = fs.statfsSync(tmpDir); free = sf.bavail * sf.bsize; } } catch {}
                if (free < c.size + 512 * MiB) skip('temp_space');
            }
            if (!p.skipped) {
                const tmp = path.join(tmpDir, 'db_' + i + '.sqlite');
                try {
                    const r = await copyHandleToFile(src, c.handle, tmp, L.sqliteMaxDbBytes, SQLITE_MAGIC);
                    extracted += c.size;
                    if (!r.ok) skip(r.reason);
                    else {
                        if (_patchWalHeader(tmp)) p.journal = 'wal';
                        const prof = profileSqliteFile(tmp, c.size, L);
                        if (prof.error) { p.error = prof.error; if (prof.code) p.code = prof.code; _bump(sq.skipped, prof.error); }
                        else { Object.assign(p, prof); sq.profiled++; }
                    }
                } catch (e) {
                    skip(e && e.code === 'ENCRYPTED' ? 'encrypted_entry' : 'read_failed');
                } finally {
                    try { fs.unlinkSync(tmp); } catch {}
                    for (const sfx of ['-journal', '-wal', '-shm']) { try { fs.unlinkSync(tmp + sfx); } catch {} }
                }
            }
            const [fitted, len] = _fitDb(p, L.budgetSqliteBytes - sqBytes);
            if (len > L.budgetSqliteBytes - sqBytes) { sq.omitted_for_size = (sq.omitted_for_size || 0) + 1; }
            else { sq.dbs.push(fitted); sqBytes += len; }
            progress({ phase: 'device-sqlite', done: i + 1, total: sel.length });
            await _yield();
        }
        if (tmpDir) { try { fs.rmdirSync(tmpDir); } catch {} tmpDir = tmpDir && fs.existsSync(tmpDir) ? tmpDir : null; }
        sq.elapsed_ms = Date.now() - tSq;
        result.sqlite = sq;

        // ── Plists ───────────────────────────────────────────────────────
        const pq = st.plists.filter(x => x.known).concat(st.plists.filter(x => !x.known && x.size > 0).sort((a, b) => b.size - a.size));
        const pSel = pq.slice(0, L.plistMax);
        const pl = { candidates: st.plistTotal, selected: pSel.length, profiled: 0, skipped: {}, items: [] };
        let plBytes = 0;
        for (let i = 0; i < pSel.length; i++) {
            const c = pSel[i];
            const item = { path: dispFile(c.rel), size: c.size };
            if (c.known) item.artifact = c.known;
            if (c.size > L.plistMaxBytes) { item.skipped = 'too_large'; _bump(pl.skipped, 'too_large'); }
            else {
                try {
                    const parsed = parsePlist(await readHandle(src, c.handle, L.plistMaxBytes));
                    item.format = parsed.format;
                    Object.assign(item, plistShape(parsed.value, L));
                    pl.profiled++;
                } catch { item.skipped = 'unparsed'; _bump(pl.skipped, 'unparsed'); }
            }
            let len = _jsonLen(item);
            if (len > L.budgetPlistBytes - plBytes) {
                const slim = { path: item.path, size: item.size, artifact: item.artifact, format: item.format, key_count: (item.keys || []).length, detail: 'summary_only' };
                len = _jsonLen(slim);
                if (len <= L.budgetPlistBytes - plBytes) { pl.items.push(slim); plBytes += len; }
                else pl.omitted_for_size = (pl.omitted_for_size || 0) + 1;
            } else { pl.items.push(item); plBytes += len; }
            if ((i + 1) % 20 === 0) { progress({ phase: 'device-plist', done: i + 1, total: pSel.length }); await _yield(); }
        }
        result.plists = pl;

        // ── Tool files outside the file system ───────────────────────────
        // Paths reach the regular Scout inspector as
        // device-dump-N/<display-mapped dirs>/<name>; its PathSanitizer then
        // replaces the file name with file_N.ext.
        const outside = st.loose.filter(x => canon(x.rel) == null);
        const tools = outside.slice(0, L.toolFilesMax);
        result.outside_files = outside.length;
        if (typeof o.addLoose === 'function') {
            const head = 'device-dump-' + (o.label || 1);
            for (const tf of tools) {
                const parts = tf.rel.split('/');
                const base = parts.pop();
                const dd = displayDirParts(parts, ctx, L, true);
                let buf = Buffer.alloc(0);
                try { buf = await readHandle(src, tf.handle, L.toolFileMaxBytes); } catch {}
                try { o.addLoose([head].concat(dd.parts, [base]).join('/'), tf.size, buf); } catch {}
            }
        }

        // ── Directories (display-mapped, merged) ─────────────────────────
        const rows = new Map();
        const apps = new Map();
        for (const [dir, d] of st.dirs) {
            const c = canon((dir ? dir + '/' : '') + 'x');
            const cdir = c == null ? null : c.slice(0, -1).replace(/\/$/, '');
            const parts = (cdir != null ? cdir : dir).split('/').filter(Boolean);
            const dd = displayDirParts(parts, ctx, L, cdir == null);
            const key = [cdir != null ? '<fs>' : '<outside>'].concat(dd.parts).join('/');
            let r = rows.get(key);
            if (!r) { r = { f: 0, b: 0, x: {} }; rows.set(key, r); }
            r.f += d.f; r.b += d.b;
            for (const k in d.x) _bump(r.x, k, d.x[k]);
            // Apps
            if (cdir != null) {
                const lowc = cdir.toLowerCase();
                let am = /(?:^|\/)containers\/(data\/application|shared\/appgroup|data\/pluginkitplugin)\/([0-9a-f-]{36})(\/|$)/.exec(lowc);
                let appKey = null, kind = null;
                if (am) { kind = am[1] === 'data/application' ? 'app' : am[1] === 'shared/appgroup' ? 'group' : 'plugin'; appKey = kind + ':' + (ctx.uuidMap.get(am[2]) || '?'); }
                else if ((am = /^data\/(?:data|user\/\d+|user_de\/\d+)\/([^/]+)/.exec(lowc))) { kind = 'app'; appKey = 'app:' + am[1]; }
                else if ((am = /\/android\/(?:data|media|obb)\/([^/]+)/.exec(lowc))) { kind = 'external'; appKey = 'external:' + am[1]; }
                if (appKey) {
                    let a = apps.get(appKey);
                    if (!a) { a = { kind, files: 0, bytes: 0 }; apps.set(appKey, a); }
                    a.files += d.f; a.bytes += d.b;
                }
            }
        }
        // Subtree totals
        const tree = new Map();
        for (const [key, r] of rows) {
            const segs = key.split('/');
            for (let i = 1; i <= segs.length; i++) {
                const k = segs.slice(0, i).join('/');
                let tt = tree.get(k);
                if (!tt) { tt = { tf: 0, tb: 0 }; tree.set(k, tt); }
                tt.tf += r.f; tt.tb += r.b;
            }
        }
        const allKeys = [...tree.keys()].sort((a, b) => {
            const da = a.split('/').length, db = b.split('/').length;
            return da - db || tree.get(b).tb - tree.get(a).tb || (a < b ? -1 : 1);
        });
        const dirRows = [];
        let dBytes = 0, dOmitted = 0;
        for (const k of allKeys) {
            const r = rows.get(k) || { f: 0, b: 0, x: {} };
            const tt = tree.get(k);
            const row = [k, r.f, tt.tf, tt.tb, _topCounts(r.x, 5)];
            const len = _jsonLen(row) + 1;
            if (dBytes + len > L.budgetDirsBytes) { dOmitted++; continue; }
            dirRows.push(row); dBytes += len;
        }
        result.directories = { columns: ['path', 'files_here', 'files_total', 'bytes_total', 'exts_here'], rows: dirRows };
        if (dOmitted) result.directories.omitted = dOmitted;

        result.apps = [...apps.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, L.appsMax)
            .map(([k, a]) => ({ id: scrubIdent(k.slice(k.indexOf(':') + 1)) || '?', kind: a.kind, files: a.files, bytes: a.bytes }));
        if (apps.size > L.appsMax) result.apps_omitted = apps.size - L.appsMax;

        result.ext_counts = Object.fromEntries(Object.entries(st.ext).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, v]) => [k || '(none)', v]));

        result.withheld = st.withheld.map(w => {
            const c = canon(w.rel);
            const parts = (c != null ? c : w.rel).split('/');
            const base = parts.pop();
            const dd = displayDirParts(parts, ctx, L, c == null);
            const ext = extOf(base.toLowerCase());
            const name = WITHHELD_SAFE_NAMES.has(base.toLowerCase()) ? base : '<withheld>' + (ext ? '.' + ext : '');
            return { path: [c != null ? '<fs>' : '<outside>'].concat(dd.parts, [name]).join('/'), size: w.size, reason: w.reason };
        });
        if (st.withheldCount > st.withheld.length) result.withheld_omitted = st.withheldCount - st.withheld.length;
        result.notes = src.notes.slice(0, 20);
        result.limits = { sqlite_max_dbs: L.sqliteMaxDbs, sqlite_max_db_bytes: L.sqliteMaxDbBytes, plist_max: L.plistMax };
        result.elapsed_ms = Date.now() - t0;
        progress({ phase: 'device-done', files: st.files });
        return result;
    } finally {
        src.close();
        if (tmpDir) {
            try { for (const f of fs.readdirSync(tmpDir)) { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} } } catch {}
            try { fs.rmdirSync(tmpDir); } catch {}
        }
    }
}

module.exports = {
    planSources,
    scanDevice,
    withheldReason,
    sniffContainer,
    DEFAULT_LIMITS,
    _internal: {
        scrubIdent, scrubName, nameShaped, genericDir, zoneKeep, displayDirParts, displayFileName, _groupKeys,
        parseBplist, parseXmlPlist, parsePlist, plistShape, profileSqliteFile, valueShape,
        numShape, textShape, blobShape, looksLikeFsRoot, KNOWN, DUMP_NAME_RE, _tarNum, _parsePax,
    },
};
