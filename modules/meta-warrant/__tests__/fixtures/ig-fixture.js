/**
 * Synthetic Instagram return generator (no real data).
 *
 * Models what Scout submission #20 told us about the 2026 Instagram export,
 * on top of the same div_table markup a Facebook return uses:
 *   - same template: sidebar <a property> TOC + print <input>/<label> list,
 *     div#property-<id>.content-pane, div_table / display:table rows
 *   - NO <br> anywhere (records are told apart by wrapper divs, or by the
 *     first key coming back)
 *   - <video><source>, <audio><source>, <img>
 *   - voice notes stored as linked_media/*.txt that are really Ogg/Opus
 *   - ~75 categories, most "No responsive records located"
 *   - records.html + preservation-N.html with overlapping content, media
 *     URLs re-signed AND served from a different CDN edge on every page
 *
 * The generator also returns the GROUND TRUTH (what an importer must find),
 * computed from the data it was asked to write, never from parsing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CELL = 'font-weight: normal; display:table-cell; padding: 2px; word-break: break-word; word-wrap: break-word !important;';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One key/value row.  `inner` is raw HTML for the value. */
function row(key, inner) {
    return '<div class="div_table" style="font-weight: bold;"><div class="div_table" style="font-weight: bold; display:table;">' +
        esc(key) + '<div style="' + CELL + '"><div>' + inner + '</div></div></div></div>';
}
const txt = (s) => esc(s);
const lines = (arr) => arr.map(l => '<div>' + esc(l) + '</div>').join('');
const linked = (ref) => row('Linked Media File:', txt(ref));
const img = (ref) => '<img src="' + esc(ref) + '" />' + linked(ref);
const video = (ref) => '<video controls="1"><source src="' + esc(ref) + '" type="video/mp4" /></video>' + linked(ref);
const audio = (ref) => '<audio controls="1"><source src="' + esc(ref) + '" /></audio>' + linked(ref);

function cdn(id, pageNo) {
    const edge = ['iad3-1', 'lax3-2', 'ord5-1', 'dfw5-2', 'atl3-1'][pageNo % 5];
    return 'https://scontent-' + edge + '.cdninstagram.com/v/t51.2885-15/' + id + '_n.jpg?stp=dst-jpg&_nc_ht=scontent-' + edge +
        '&oh=00_' + (pageNo * 7919 + id.length).toString(16) + 'Ab' + pageNo + '&oe=6' + (5000000 + pageNo * 37).toString(16).toUpperCase();
}

const TARGET = '17841400000000001';
const OTHER = '17841400000000777';
const T0 = Date.UTC(2026, 3, 1, 12, 0, 0);
const ts = (i) => new Date(T0 + i * 61000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

// ── The universe of records (what Meta holds) ───────────────────────────
// Each page shows a SUBSET; the ground truth is the union.

function universe(scale) {
    const s = Math.max(1, scale | 0);
    const ips = [];
    for (let i = 0; i < 40 * s; i++) ips.push({ id: 'ip' + i, ip: (i % 7 === 0) ? '2600:1700:abcd:' + (i % 97).toString(16) + '::1' : '172.58.' + (i % 200) + '.' + ((i * 13) % 250 + 1), t: ts(i * 3) });
    const following = [];
    for (let i = 0; i < 25 * s; i++) following.push({ id: 'fo' + i, user: 'user_' + i + '_x', uid: String(5000 + i), t: ts(i * 5 + 1) });
    const likes = [];
    for (let i = 0; i < 30 * s; i++) likes.push({ id: 'lk' + i, media: String(3000000 + i), t: ts(i * 2 + 7) });
    const photos = [];
    for (let i = 0; i < 6; i++) photos.push({ id: 'ph' + i, pid: String(1800000 + i), ref: 'linked_media/photos_' + (1800000 + i) + '.jpg', t: ts(100 + i), cap: 'caption number ' + i + (i === 2 ? ' with an emoji 🙂 & <tag>' : '') });
    const videos = [];
    for (let i = 0; i < 3; i++) videos.push({ id: 'vd' + i, vid: String(1900000 + i), ref: 'linked_media/videos_' + (1900000 + i) + '.mp4', t: ts(200 + i) });
    const msgs = [];
    const scaleMsgs = 10 * s;
    for (let i = 0; i < scaleMsgs; i++) {
        const mine = i % 2 === 0;
        const m = { id: 'm' + i, author: mine ? 'target.user (Instagram: ' + TARGET + ')' : 'other.person (Instagram: ' + OTHER + ')', t: ts(300 + i), body: 'message body ' + i };
        if (i === 1) { m.media = { k: 'image', ref: 'linked_media/unified_message_4400001.jpg' }; m.body = ''; }
        if (i === 3) { m.media = { k: 'video', ref: 'linked_media/unified_message_4400003.mp4' }; }
        if (i === 4) { m.media = { k: 'audio', ref: 'linked_media/unified_message_4400004.txt' }; m.body = ''; }   // voice note: Ogg in .txt
        if (i === 5) { m.media = { k: 'audio', ref: 'linked_media/unified_message_4400005.mp3' }; }
        if (i === 6) { m.two = ['linked_media/unified_message_4400006.jpg', 'linked_media/unified_message_4400016.jpg']; }  // two media rows in ONE message
        if (i === 7) { m.media = { k: 'image', ref: 'linked_media/unified_message_MISSING.jpg' }; }   // referenced, not shipped
        msgs.push(m);
    }
    // Two genuinely identical messages (same author, second, text): both are real.
    msgs.push({ id: 'dupA', author: msgs[0].author, t: ts(300 + scaleMsgs), body: 'ok' });
    msgs.push({ id: 'dupB', author: msgs[0].author, t: ts(300 + scaleMsgs), body: 'ok' });
    const msgs2 = [];
    for (let i = 0; i < 4; i++) msgs2.push({ id: 'n' + i, author: (i % 2 ? 'third.person (Instagram: 17841400000000888)' : 'target.user (Instagram: ' + TARGET + ')'), t: ts(900 + i), body: 'second thread ' + i });
    const ai = [];
    for (let i = 0; i < 3; i++) ai.push({ id: 'ai' + i, prompt: 'prompt ' + i, resp: 'response ' + i, t: ts(950 + i) });
    return { ips, following, likes, photos, videos, msgs, msgs2, ai };
}

// What each page shows: records = the "base" slice, preservation-N = shifted
// windows that overlap the base and each other, so some records exist ONLY
// in preservations.
function pick(list, page) {
    const n = list.length;
    if (page.kind === 'records') return list.filter((_, i) => i < Math.ceil(n * 0.7));
    const k = page.no;
    const from = Math.floor(n * 0.2 * (k % 3));
    return list.filter((_, i) => i >= from && i < Math.min(n, from + Math.ceil(n * 0.7)));
}

// The same physical file listing on every page (Meta re-exports media per page,
// but the zip has ONE linked_media folder).
const EMPTY_CATS = [];
for (let i = 0; i < 62; i++) EMPTY_CATS.push('empty_category_' + String(i).padStart(2, '0'));

/** Build one page's HTML.  page = {kind:'records'} | {kind:'preservation', no} */
function buildPage(U, page, opts) {
    opts = opts || {};
    const wrap = opts.wrap || 'mixed';   // how records are delimited
    const pageNo = page.kind === 'records' ? 0 : page.no;
    const cats = [];
    const add = (id, name, defText, body) => cats.push({ id, name, html: (defText ? row(name + ' Definition', txt(defText)) : '') + body });
    const group = (rows) => '<div>' + rows.join('') + '</div>';   // plain wrapper = one record

    add('request_parameters', 'Request Parameters', 'The parameters of this request.',
        row('Service', txt('Instagram')) + row('Target', txt(TARGET)) + row('Account Identifier', txt(TARGET)) +
        row('Account Type', txt('User')) + row('Generated', txt(ts(5000 + pageNo))) +
        row('Date Range', txt('2026-01-01 00:00:00 UTC to 2026-06-30 23:59:59 UTC')));
    add('name', 'Name', 'Name on the account.', row('Name', lines(['First', 'target user'])));
    add('emails', 'Emails', 'Emails on the account.', row('Emails', lines(['target@example.com (Verified)', 'old@example.com'])));
    add('registration_ip', 'Registration Ip', 'IP used at registration.', row('Registration Ip', txt('203.0.113.9')));

    // IP addresses: NO wrapper, the first key coming back starts each record.
    add('ip_addresses', 'Ip Addresses', 'IP addresses associated with the account.',
        row('Ip Addresses', pick(U.ips, page).map(x => row('IP Address', txt(x.ip)) + row('Time', txt(x.t))).join('')));

    // Following: wrapper divs (or none, when wrap === 'none').
    add('following', 'Following', 'Accounts this account follows.',
        row('Following', pick(U.following, page).map(x => {
            const r = [row('Id', txt(x.uid)), row('Username', txt(x.user)), row('Time', txt(x.t))];
            return wrap === 'none' ? r.join('') : group(r);
        }).join('')));

    add('likes', 'Likes', 'Media the account liked.',
        row('Likes', pick(U.likes, page).map(x => row('Media Id', txt(x.media)) + row('Time', txt(x.t))).join('')));

    add('photos', 'Photos', 'Photos uploaded by the account.',
        row('Photos', pick(U.photos, page).map(x => group([
            row('Id', txt(x.pid)), row('Image', img(x.ref)), row('Url', txt(cdn(x.pid, pageNo))),
            row('Taken', txt(x.t)), row('Caption', txt(x.cap)), row('Upload Ip', txt('198.51.100.' + (parseInt(x.pid, 10) % 50)))
        ])).join('')));

    add('videos', 'Videos', 'Videos uploaded by the account.',
        row('Videos', pick(U.videos, page).map(x => group([
            row('Id', txt(x.vid)), row('Video', video(x.ref)), row('Taken', txt(x.t))
        ])).join('')));

    // Messages: per-thread rows; each message = Author, Sent, Body (+ media rows).
    const msgHtml = (m) => {
        let h = row('Author', txt(m.author)) + row('Sent', txt(m.t));
        if (m.body) h += row('Body', txt(m.body));
        if (m.media) {
            const fn = m.media.k === 'image' ? img : m.media.k === 'video' ? video : audio;
            h += row('Attachments', txt('attachment (' + m.id + ')') + row('Url', txt(cdn(m.id, pageNo))) + fn(m.media.ref));
        }
        if (m.two) h += row('Share', img(m.two[0])) + row('Share', img(m.two[1]));
        return h;
    };
    const thread = (id, participants, list) => row('Thread', txt('(' + id + ')') +
        row('Current Participants', lines(participants)) + list.map(msgHtml).join(''));
    const threadMsgs = pick(U.msgs.filter(m => !/^dup/.test(m.id)), page).concat(U.msgs.filter(m => /^dup/.test(m.id)));
    const t2 = pick(U.msgs2, page);
    add('unified_messages', 'Unified Messages', 'Private messages.',
        thread('340282366841710300949128000000000001', ['target.user (Instagram: ' + TARGET + ')', 'other.person (Instagram: ' + OTHER + ')'], threadMsgs) +
        (t2.length ? thread('340282366841710300949128000000000002', ['target.user (Instagram: ' + TARGET + ')', 'third.person (Instagram: 17841400000000888)'], t2) : ''));

    // A category the importer has never heard of, with nested records.
    add('ai_conversations', 'Ai Conversations', 'Conversations with an AI assistant.',
        row('Ai Conversations', pick(U.ai, page).map(x => group([row('Prompt', txt(x.prompt)), row('Response', txt(x.resp)), row('Time', txt(x.t))])).join('')));

    add('profile_picture', 'Profile Picture', 'Current profile picture.', row('Profile Picture', img('linked_media/profile_picture_1.jpg')));
    for (const id of EMPTY_CATS) {
        const name = id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        add(id, name, null, row(name, txt('No responsive records located')));
    }

    const toc = cats.map(c => '<li><a property="' + c.id + '" href="#property-' + c.id + '">' + esc(c.name) + '</a></li>').join('');
    const print = cats.map(c => '<input onchange="printOptionChange(this)" type="checkbox" id="' + c.id + '_print" disabled="1" /><label for="' + c.id + '">' + esc(c.name) + '</label>').join('');
    const panes = cats.map(c => '<div id="property-' + c.id + '" class="content-pane">' + c.html + '</div>').join('');
    // A disclaimer pane with unnamed text rows (must land in notes, not data).
    return '<html><head><meta charset="UTF-8" /><title>Instagram Legal Request </title><style type="text/css">.div_table{}</style></head><body>' +
        '<div id="home" class="content-pane visible-content"><div class="sticky_side_bar"><div><p>Categories</p><ul>' + toc + '</ul>' +
        '<p>Print</p>' + print + '<button>Print</button></div></div></div>' +
        '<div class="records_output">' + panes + '</div></body></html>';
}

// ── Media bytes (magic numbers only matter) ─────────────────────────────
const MAGIC = {
    jpg: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46]),
    png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42')]),
    ogg: Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('\u0013OpusHead', 'latin1')]),
    mp3: Buffer.from('ID3\u0004\u0000', 'latin1')
};
function fileBytes(kind, i) { return Buffer.concat([MAGIC[kind], Buffer.alloc(200 + (i % 50), i % 251)]); }

/**
 * Write a whole return into `dir`.  Returns { pages, files, truth }.
 *   opts.preservations (default 3), opts.scale (default 1), opts.wrap
 */
function writeReturn(dir, opts) {
    opts = opts || {};
    const U = universe(opts.scale || 1);
    const nPres = opts.preservations == null ? 3 : opts.preservations;
    fs.mkdirSync(path.join(dir, 'linked_media'), { recursive: true });
    const pages = [{ kind: 'records', name: 'records.html' }];
    for (let k = 1; k <= nPres; k++) pages.push({ kind: 'preservation', no: k, name: 'preservation-' + k + '.html' });
    for (const p of pages) fs.writeFileSync(path.join(dir, p.name), buildPage(U, p, opts));
    fs.writeFileSync(path.join(dir, 'instructions.txt'), 'Contents of this file\r\n----------------------\r\nHow to use these files\r\n');

    const files = {};
    let i = 0;
    const put = (ref, kind) => { files[ref] = kind; fs.writeFileSync(path.join(dir, ref), fileBytes(kind, i++)); };
    for (const p of U.photos) put(p.ref, 'jpg');
    for (const v of U.videos) put(v.ref, 'mp4');
    put('linked_media/unified_message_4400001.jpg', 'png');     // a PNG named .jpg (seen in the FB sample)
    put('linked_media/unified_message_4400003.mp4', 'mp4');
    put('linked_media/unified_message_4400004.txt', 'ogg');     // voice note in a .txt
    put('linked_media/unified_message_4400005.mp3', 'mp3');
    put('linked_media/unified_message_4400006.jpg', 'jpg');
    put('linked_media/unified_message_4400016.jpg', 'jpg');
    put('linked_media/profile_picture_1.jpg', 'jpg');
    put('linked_media/orphan_not_referenced.jpg', 'jpg');      // shipped, never referenced: still kept

    const t = truth(U, pages);
    t.mediaFiles = Object.keys(files).length;
    return { pages: pages.map(p => p.name), files, truth: t };
}

function union(list, pages, extraFilter) {
    const inRec = new Set(pick(list, pages[0]).map(x => x.id));
    const all = new Map();
    for (const p of pages) for (const x of pick(list, p)) all.set(x.id, x);
    const ids = Array.from(all.keys()).filter(id => !extraFilter || extraFilter(id));
    return { count: ids.length, onlyPres: ids.filter(id => !inRec.has(id)).length, ids };
}

function truth(U, pages) {
    const base = U.msgs.filter(m => !/^dup/.test(m.id));
    const t1 = union(base, pages);
    const t2 = union(U.msgs2, pages);
    const ipU = union(U.ips, pages);
    return {
        service: 'Instagram',
        target: TARGET,
        categories: 12 + EMPTY_CATS.length,
        emptyCategories: EMPTY_CATS.slice(),
        items: {
            ip_addresses: union(U.ips, pages),
            following: union(U.following, pages),
            likes: union(U.likes, pages),
            photos: union(U.photos, pages),
            videos: union(U.videos, pages),
            ai_conversations: union(U.ai, pages),
            name: { count: 1, onlyPres: 0 },
            emails: { count: 1, onlyPres: 0 },
            registration_ip: { count: 1, onlyPres: 0 },
            profile_picture: { count: 1, onlyPres: 0 }
        },
        threads: {
            '340282366841710300949128000000000001': { count: t1.count + 2, onlyPres: t1.onlyPres },
            '340282366841710300949128000000000002': { count: t2.count, onlyPres: t2.onlyPres }
        },
        // IP-keyed rows: "IP Address" (ip_addresses) + "Registration Ip" + one "Upload Ip" per photo
        ipRows: ipU.count + 1 + union(U.photos, pages).count,
        missingMedia: 1,
        sniffedRenames: { 'linked_media/unified_message_4400004.txt': '.ogg', 'linked_media/unified_message_4400001.jpg': '.png' },
        U
    };
}

module.exports = { buildPage, writeReturn, universe, pick, row, TARGET, OTHER, EMPTY_CATS, MAGIC };
