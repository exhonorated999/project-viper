/**
 * Discord HTML EXPORT parser (Discrub browser-extension export).
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * Besides the two formats Discord itself produces (the user's Data Package
 * and the law-enforcement CSV return), investigators receive conversations
 * exported with Discrub (https://github.com/prathercc/discrub, MIT) — a
 * browser extension that pages through a signed-in account and writes one
 * folder of paginated HTML per conversation:
 *
 *      README.html                       bulk exports: what is in the ZIP
 *      shell.html                        "Discord layout": sidebar + iframe;
 *                                        its script lists {id, name, filename}
 *                                        of every exported channel
 *      <name>/<name>-page-<n>.html       one page per N messages
 *      <name>/threads/<slug>_<id>.html   threads started in that channel
 *      <name>/media/attachments/<file>   downloaded attachments (renamed)
 *      <name>/media/embed-thumbnails/…   embed images / videos / thumbnails
 *      <name>/avatars/<userId>/<hash>.png
 *
 * Each message is a `div.message` (or `div.message.message-grouped` for a
 * follow-up from the same author, which carries NO author markup) with
 * `data-message-id` = the Discord snowflake.  The snowflake is the time
 * source: the visible timestamp text follows the exporter's date/time
 * preferences and locale and cannot be parsed reliably.
 *
 * Markup cross-checked against Discrub's src/services/exportService.ts
 * (generateHTMLPageParts) and exportDiscordShell.ts.
 *
 * This export is NOT authenticated by Discord: it is produced client-side
 * from the account holder's session.  The import says so in its diagnostics.
 *
 * Emits the SAME result shape as DiscordReturnParser.parse so the existing
 * UI, message store and flagging work unchanged.
 *
 * Runs in the Electron MAIN process (Node).
 */

const fs = require('fs');
const path = require('path');
const { parse: parseHTML } = require('node-html-parser');

const DISCORD_EPOCH = 1420070400000;

// <dir>/<base>-page-<n>.html   (current) — also accept "_page_" (older builds)
const PAGE_RE = /^(.*\/)?([^/]+)\/([^/]+?)[-_]page[-_](\d+)\.html?$/i;
const THREAD_RE = /^(.*\/)?([^/]+)\/threads\/([^/]+)\.html?$/i;
const ASSET_DIRS = /^(media|stickers|avatars|emojis|roles)\//i;
const EXTRACT_DIRS = /^(media|stickers)\//i;

const BLOCK_TAGS = new Set(['div', 'p', 'pre', 'blockquote', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr']);

function norm(n) { return String(n).replace(/\\/g, '/').replace(/^\/+/, ''); }

function snowflakeToIso(id) {
    try {
        const s = String(id || '').trim();
        if (!/^\d{15,22}$/.test(s)) return null;
        const d = new Date(Number(BigInt(s) >> 22n) + DISCORD_EPOCH);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch (_) { return null; }
}

function cmpSnowflake(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (x.length !== y.length) return x.length - y.length;
    return x < y ? -1 : x > y ? 1 : 0;
}

function hasClass(el, c) {
    const cls = el && el.getAttribute ? (el.getAttribute('class') || '') : '';
    return (' ' + cls + ' ').indexOf(' ' + c + ' ') !== -1;
}

/** Readable text of an element: <br> → newline, block boundaries → newline, emoji <img> → alt. */
function textOf(el, skip) {
    let out = '';
    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) { out += node.text; return; }
        if (node.nodeType !== 1) return;
        const tag = String(node.rawTagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'svg') return;
        if (skip && skip(node)) return;
        if (tag === 'br') { out += '\n'; return; }
        if (tag === 'img') { out += node.getAttribute('alt') || ''; return; }
        const block = BLOCK_TAGS.has(tag);
        if (block && out && !out.endsWith('\n')) out += '\n';
        for (const c of node.childNodes) walk(c);
        if (block && out && !out.endsWith('\n')) out += '\n';
    };
    walk(el);
    return out.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function oneLine(s, max) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return max && t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Folder-relative href → archive-relative path, or null for external links. */
function resolveHref(pageRel, href) {
    let h = String(href || '').trim();
    if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('#')) return null;
    h = h.split('#')[0].split('?')[0];
    try { h = decodeURIComponent(h); } catch (_) {}
    const dir = path.posix.dirname(pageRel);
    const joined = path.posix.normalize(dir === '.' ? h : dir + '/' + h);
    return joined.startsWith('../') ? null : joined;
}

class DiscordHtmlExportParser {

    // ─── Detection ──────────────────────────────────────────────────────

    /**
     * @param {string[]} entryNames
     * @returns {{ match:boolean, root:string, reasons:string[], channels:Array }}
     *   channels: [{ folder, pages:[{rel,n}], threads:[rel] }]   (paths normalised, original case)
     */
    static detect(entryNames) {
        const names = (entryNames || []).map(norm);
        const lowerSet = new Set(names.map(n => n.toLowerCase()));
        const folders = new Map(); // folder (with trailing /) → { folder, pages, threads }

        // A folder whose name differs from its page prefix still counts when it
        // carries Discrub's asset layout next to the pages.
        const hasAssets = (folder) => {
            const f = folder.toLowerCase();
            for (const n of lowerSet) {
                if (n.startsWith(f) && ASSET_DIRS.test(n.slice(f.length))) return true;
            }
            return false;
        };

        for (const n of names) {
            const m = PAGE_RE.exec(n);
            if (!m) continue;
            const folder = (m[1] || '') + m[2] + '/';
            if (/\/threads\/$/i.test(folder)) continue;
            const sameName = m[2].toLowerCase() === m[3].toLowerCase();
            if (!sameName && !folders.has(folder) && !hasAssets(folder)) continue;
            if (!folders.has(folder)) folders.set(folder, { folder, pages: [], threads: [] });
            folders.get(folder).pages.push({ rel: n, n: parseInt(m[4], 10) || 0 });
        }
        if (!folders.size) return { match: false, root: '', reasons: [], channels: [] };

        for (const n of names) {
            const m = THREAD_RE.exec(n);
            if (!m) continue;
            const folder = (m[1] || '') + m[2] + '/';
            if (folders.has(folder)) folders.get(folder).threads.push(n);
        }

        const channels = Array.from(folders.values());
        for (const c of channels) { c.pages.sort((a, b) => a.n - b.n); c.threads.sort(); }
        channels.sort((a, b) => a.folder.localeCompare(b.folder));

        // Root = deepest common parent of the channel folders.
        const parents = channels.map(c => c.folder.replace(/[^/]+\/$/, ''));
        let root = parents[0];
        for (const p of parents) {
            while (root && !p.toLowerCase().startsWith(root.toLowerCase())) {
                root = root.replace(/[^/]+\/$/, '');
            }
        }

        const reasons = [`${channels.length} conversation folder(s) of <name>-page-<n>.html`];
        if (lowerSet.has((root + 'readme.html').toLowerCase())) reasons.push('README.html');
        if (lowerSet.has((root + 'shell.html').toLowerCase())) reasons.push('shell.html (Discord layout)');
        if (channels.some(c => c.threads.length)) reasons.push('threads/');
        if (root) reasons.push(`nested under "${root}"`);
        return { match: true, root, reasons, channels };
    }

    static isHtmlExportEntries(entryNames) { return DiscordHtmlExportParser.detect(entryNames).match; }

    /**
     * Folder check used by the Discord scan.  Looks only one level down (the
     * export root) or at the folder itself (a single conversation folder), so
     * a parent such as Downloads that merely CONTAINS an export does not match.
     */
    static isHtmlExportFolder(folderPath) {
        try {
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;
            const own = path.basename(folderPath).toLowerCase();
            const top = fs.readdirSync(folderPath, { withFileTypes: true });
            const isPage = (name, base) => {
                const m = /^(.+?)[-_]page[-_]\d+\.html?$/i.exec(name);
                return !!m && m[1].toLowerCase() === base.toLowerCase();
            };
            if (top.some(it => it.isFile() && isPage(it.name, own))) return true;
            for (const it of top) {
                if (!it.isDirectory()) continue;
                let kids;
                try { kids = fs.readdirSync(path.join(folderPath, it.name)); } catch (_) { continue; }
                if (kids.some(k => isPage(k, it.name))) return true;
            }
            return false;
        } catch (_) { return false; }
    }

    // ─── Page reading ───────────────────────────────────────────────────

    /** Cheap pre-pass: author ids + usernames on a page, without building a DOM. */
    static scanAuthors(html) {
        const ids = new Map(); // id → count
        const re = /class="author"[^>]*?data-user-id="(\d+)"/g;
        let m;
        while ((m = re.exec(html))) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
        return ids;
    }

    /** `<script type="application/json" id="export-data">` → users map (id → {username, displayName}). */
    static readExportData(html) {
        const m = /<script[^>]*id="export-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
        if (!m) return null;
        try { return JSON.parse(m[1]); } catch (_) { return null; }
    }

    /** shell.html / single-channel shell → [{id, name, filename}], server name, guild id, isDM. */
    static readShell(html) {
        const out = { channels: [], serverName: null, guildId: null, isDM: false };
        const m = /var channels = (\[[\s\S]*?\]);/.exec(html || '');
        if (!m) return null;
        try { out.channels = JSON.parse(m[1]) || []; } catch (_) { return null; }
        const t = /<title>([^<]*)<\/title>/i.exec(html);
        if (t) {
            const title = t[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
            out.serverName = title.split(' · ')[0].trim() || null;
        }
        out.isDM = /class="channel-item[^"]*\bdm-item\b/.test(html) || out.serverName === 'Direct Messages';
        const g = /cdn\.discordapp\.com\/icons\/(\d{15,22})\//.exec(html);
        if (g) out.guildId = g[1];
        return out;
    }

    /**
     * Parse one page into message records (DOM order).  Author of a grouped
     * follow-up is inherited from the previous non-system message — Discrub
     * only groups consecutive messages by the same author.
     */
    _parsePage(html, pageRel, ctx) {
        const root = parseHTML(html, { blockTextElements: { script: true, style: true } });
        const title = root.querySelector('div.header h1') || root.querySelector('h1');
        const main = root.querySelector('main') || root;
        const rows = main === root
            ? root.querySelectorAll('div.message, div.system-message')
            : main.childNodes.filter(n => n.nodeType === 1);

        const out = [];
        for (const el of rows) {
            if (String(el.rawTagName || '').toLowerCase() !== 'div') continue;
            const isSystem = hasClass(el, 'system-message');
            if (!isSystem && !hasClass(el, 'message')) continue;
            const id = String(el.getAttribute('data-message-id') || '').trim() || null;

            if (isSystem) {
                const stamp = el.querySelector('.system-message-timestamp');
                const textEl = el.querySelector('.system-message-text');
                const text = textOf(textEl || el, n => hasClass(n, 'system-message-timestamp'));
                out.push({
                    id, authorId: null, username: 'System', system: true,
                    rawTimestamp: stamp ? oneLine(stamp.text) : '',
                    contents: `[System] ${text}`, attachments: '', media: [], kind: el.getAttribute('data-system-kind') || ''
                });
                continue;
            }

            if (hasClass(el, 'message-render-error')) {
                out.push({
                    id: /^\d+$/.test(id || '') ? id : null, authorId: ctx.last.authorId, username: ctx.last.username,
                    rawTimestamp: '', contents: '[Discrub could not render this message in the export]',
                    attachments: '', media: []
                });
                continue;
            }

            let authorId = null, username = null;
            const authorEl = el.querySelector('.message-header .author') || el.querySelector('.author');
            if (authorEl && !hasClass(el, 'message-grouped')) {
                authorId = String(authorEl.getAttribute('data-user-id') || '').trim() || null;
                username = oneLine(textOf(authorEl)) || null;
                ctx.last = { authorId, username };
            } else {
                authorId = ctx.last.authorId;
                username = ctx.last.username;
            }
            if (authorId && ctx.users && ctx.users[authorId] && ctx.users[authorId].username) {
                username = ctx.users[authorId].username;
            }

            const stampEl = el.querySelector('.message-header .timestamp') || el.querySelector('.grouped-timestamp');
            const lines = [];

            // Reply bar
            const reply = el.querySelector('.reply-bar');
            if (reply) {
                if (hasClass(reply, 'reply-bar-deleted')) lines.push('↪ Reply to a deleted message');
                else {
                    const ra = reply.querySelector('.reply-author');
                    const rc = reply.querySelector('.reply-content');
                    const target = reply.getAttribute('data-target-id');
                    lines.push(`↪ Reply to ${oneLine(ra ? ra.text : '') || 'unknown'}: "${oneLine(rc ? textOf(rc) : '', 160)}"` +
                        (target ? ` (message ${target})` : ''));
                }
            }

            // Body text
            const textEl = el.querySelector('.message-text');
            let edited = false;
            let body = '';
            if (textEl) {
                body = textOf(textEl, n => {
                    if (hasClass(n, 'edited-indicator')) { edited = true; return true; }
                    return false;
                });
                if (body === '(no content)') body = '';
            }
            if (body) lines.push(body + (edited ? ' (edited)' : ''));
            else if (edited) lines.push('(edited)');

            // Forwarded message
            const fwd = el.querySelector('.forward-block');
            if (fwd) {
                const fc = fwd.querySelector('.forward-content');
                lines.push('[Forwarded message]' + (fc && textOf(fc) ? '\n' + textOf(fc) : ''));
            }

            // Media references (attachments, forwarded attachments, embeds, stickers)
            const media = [];
            const external = [];
            const seenRef = new Set();
            const addRef = (href, label, kind) => {
                if (!href) return;
                const rel = resolveHref(pageRel, href);
                const key = (rel || href).toLowerCase();
                if (seenRef.has(key)) return;
                seenRef.add(key);
                if (!rel) { if (/^https?:/i.test(href)) external.push(href); return; }
                media.push({ rel, label: label || '', kind });
            };
            for (const card of el.querySelectorAll('.attachment-card')) {
                const a = card.querySelector('a.attachment-name') || card.querySelector('a[href]');
                const img = card.querySelector('img.attachment-preview, video.attachment-preview');
                const href = (a && a.getAttribute('href')) || (img && img.getAttribute('src'));
                addRef(href, a ? oneLine(a.text) : '', 'attachment');
            }
            for (const a of el.querySelectorAll('a.forward-attachment')) addRef(a.getAttribute('href'), oneLine(a.text), 'attachment');
            const embeds = el.querySelectorAll('.embeds');
            for (const emb of embeds) {
                for (const m of emb.querySelectorAll('img, video, source')) addRef(m.getAttribute('src'), '', 'embed');
            }
            for (const s of el.querySelectorAll('img.sticker-img')) addRef(s.getAttribute('src'), s.getAttribute('alt') || 'sticker', 'sticker');

            // Embeds as text (link previews etc.) — skip the forwarded copy already counted.
            for (const emb of embeds) {
                if (fwd && emb.closest && emb.closest('.forward-block')) continue;
                const t = oneLine(textOf(emb), 500);
                if (t) lines.push(`[Embed] ${t}`);
            }
            const stickers = el.querySelectorAll('.stickers img, .sticker-placeholder');
            if (stickers.length) {
                lines.push('[Sticker] ' + stickers.map(s => s.getAttribute('title') || s.getAttribute('alt') || oneLine(s.text)).filter(Boolean).join(', '));
            }
            const poll = el.querySelector('.poll');
            if (poll) {
                const q = poll.querySelector('.poll-question');
                const answers = poll.querySelectorAll('.poll-answer').map(a => oneLine(textOf(a)));
                lines.push(`[Poll] ${oneLine(q ? q.text : '')}` + (answers.length ? ' — ' + answers.join(' | ') : ''));
            }
            const reactions = el.querySelectorAll('.reaction');
            if (reactions.length) {
                lines.push('[Reactions] ' + reactions.map(r => {
                    const cnt = r.querySelector('.reaction-count');
                    const emo = textOf(r, n => hasClass(n, 'reaction-count')) || '?';
                    return `${oneLine(emo)} ${cnt ? oneLine(cnt.text) : ''}`.trim();
                }).join(', '));
            }
            const thread = el.querySelector('.thread-banner-text');
            if (thread) lines.push(`[Thread started] ${oneLine(thread.text)}`);

            out.push({
                id,
                authorId, username,
                rawTimestamp: stampEl ? oneLine(stampEl.text) : '',
                contents: lines.join('\n'),
                attachments: external.join('\n'),
                media
            });
        }
        return { title: title ? oneLine(title.text).replace(/^#/, '') : null, messages: out };
    }

    // ─── Parse ──────────────────────────────────────────────────────────

    /**
     * @param {Object} src  same contract as DiscordReturnParser.parse
     *   options: { extractDir, security, messageSink, inlineBudget }
     */
    async parse({ entryNames, readText, readBinary, options = {} }) {
        const { extractDir, security } = options;
        const warnings = [];
        const consumed = new Set();
        const originals = (entryNames || []).map(String);
        const byNorm = new Map(); // lower-case normalised → original
        for (const o of originals) byNorm.set(norm(o).toLowerCase(), o);
        const orig = (rel) => byNorm.get(String(rel).toLowerCase()) || null;
        const read = (rel) => {
            const o = orig(rel);
            if (!o) return null;
            try { const t = readText(o); if (t != null) consumed.add(o); return t; } catch (_) { return null; }
        };

        const det = DiscordHtmlExportParser.detect(originals);
        const root = det.root || '';
        warnings.push('Discrub HTML export: produced by a browser extension from the account holder\'s own session, not by Discord. ' +
            'Treat it as user-provided content; message times come from the Discord message IDs.');

        // ── 0) Shell(s): channel ids / names / server ──────────────────
        const folderInfo = new Map(); // folder lower → {id, name}
        let shell = null;
        for (const n of originals.map(norm)) {
            if (!/\.html?$/i.test(n) || PAGE_RE.test(n) || THREAD_RE.test(n)) continue;
            const base = path.posix.basename(n).toLowerCase();
            const isReadme = /^readme\.html?$/.test(base);
            const html = read(n);
            if (html == null) continue;
            if (isReadme) continue;
            const sh = DiscordHtmlExportParser.readShell(html);
            if (!sh) { consumed.delete(orig(n)); continue; }
            if (!shell) shell = sh;
            const dir = path.posix.dirname(n);
            for (const c of sh.channels) {
                if (!c || !c.filename) continue;
                const f = path.posix.normalize((dir === '.' ? '' : dir + '/') + String(c.filename));
                const folder = path.posix.dirname(f).toLowerCase() + '/';
                folderInfo.set(folder, { id: c.id != null ? String(c.id) : null, name: c.name || null });
            }
        }
        const isDM = shell ? shell.isDM : null;
        const guildName = shell && !shell.isDM ? shell.serverName : null;
        const guildId = shell && !shell.isDM ? (shell.guildId || null) : null;

        // ── 1) Pre-pass: who wrote where (decides the account holder) ──
        const units = [];
        for (const c of det.channels) {
            units.push({ folder: c.folder, pages: c.pages.map(p => p.rel), thread: false });
            for (const t of c.threads) units.push({ folder: c.folder, pages: [t], thread: true, parentFolder: c.folder });
        }
        const users = {}; // id → {username, displayName}
        const authorSets = units.map(() => new Map());
        units.forEach((u, i) => {
            for (const rel of u.pages) {
                const o = orig(rel);
                let html = null;
                try { html = o ? readText(o) : null; } catch (_) {}
                if (html == null) continue;
                for (const [id, n] of DiscordHtmlExportParser.scanAuthors(html)) {
                    authorSets[i].set(id, (authorSets[i].get(id) || 0) + n);
                }
                const data = DiscordHtmlExportParser.readExportData(html);
                if (data && data.users && typeof data.users === 'object') {
                    for (const id of Object.keys(data.users)) {
                        const v = data.users[id] || {};
                        if (!users[id]) users[id] = { username: v.username || null, displayName: v.displayName || null };
                    }
                }
            }
        });

        const subscriber = { id: null, username: null, globalName: null, email: null, phone: null, ip: null,
            sessions: [], connections: [], flags: [], relationships: [], inferred: false };
        {
            const mainUnits = units.map((u, i) => ({ u, set: authorSets[i] })).filter(x => !x.u.thread && x.set.size);
            const freq = new Map();
            for (const x of mainUnits) for (const id of x.set.keys()) freq.set(id, (freq.get(id) || 0) + 1);
            const ranked = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
            let pick = null, why = '';
            if (mainUnits.length >= 2 && ranked.length && ranked[0][1] >= 2 &&
                (ranked.length < 2 || ranked[0][1] > ranked[1][1]) && ranked[0][1] >= Math.ceil(mainUnits.length / 2)) {
                pick = ranked[0][0];
                why = `author in ${ranked[0][1]} of ${mainUnits.length} exported conversations`;
            }
            if (!pick) {
                // A DM folder is named after the OTHER person.
                for (const x of mainUnits) {
                    if (x.set.size !== 2) continue;
                    const fname = x.u.folder.replace(/\/$/, '').split('/').pop().toLowerCase();
                    const ids = Array.from(x.set.keys());
                    const named = ids.filter(id => users[id] && String(users[id].username || '').toLowerCase() === fname);
                    if (named.length === 1) { pick = ids.find(id => id !== named[0]); why = 'the other participant of a DM folder named after its recipient'; break; }
                }
            }
            if (pick) {
                subscriber.id = pick;
                subscriber.username = (users[pick] && users[pick].username) || null;
                subscriber.globalName = (users[pick] && users[pick].displayName) || null;
                subscriber.inferred = true;
                subscriber.inferredFrom = why;
                warnings.push(`Account holder inferred as ${subscriber.username || pick} (${pick}) — ${why}. The export does not state it.`);
            } else {
                warnings.push('The account holder could not be determined from this export; every message is shown as incoming.');
            }
        }

        // ── 2) Media: extract media/ and stickers/ under each channel folder ─
        const contentFiles = {};
        const mediaByRel = new Map();
        const folderLowers = det.channels.map(c => c.folder.toLowerCase());
        const assetRels = [];
        for (const n of originals.map(norm)) {
            const lower = n.toLowerCase();
            const f = folderLowers.find(fl => lower.startsWith(fl));
            if (!f || /\/$/.test(n)) continue;
            const inner = n.slice(f.length);
            if (!ASSET_DIRS.test(inner)) continue;
            if (EXTRACT_DIRS.test(inner)) assetRels.push(n);
            else consumed.add(orig(n)); // avatars / emojis / role icons: known, not evidence-bearing
        }
        if (extractDir && assetRels.length) {
            try { fs.mkdirSync(extractDir, { recursive: true }); } catch (_) {}
            for (const rel of assetRels) {
                const o = orig(rel);
                let buf = null;
                try { buf = readBinary(o); } catch (_) {}
                if (!buf) { warnings.push(`Could not extract ${rel}`); continue; }
                consumed.add(o);
                const safeName = rel.slice(root.length).replace(/[\\/]/g, '_');
                const outPath = path.join(extractDir, safeName);
                let toWrite = buf;
                if (security && security.isUnlocked && security.isUnlocked()) {
                    try { toWrite = security.encryptBuffer(buf); } catch (_) {}
                }
                try {
                    fs.writeFileSync(outPath, toWrite);
                    const rec = {
                        diskPath: outPath,
                        size: buf.length,
                        mimeType: this._mime(path.extname(rel).toLowerCase()),
                        kind: /\/media\/attachments\//i.test('/' + rel) ? 'attachment' : 'embed',
                        fileName: path.posix.basename(rel),
                        original: rel.slice(root.length)
                    };
                    contentFiles[safeName] = rec;
                    mediaByRel.set(rel.toLowerCase(), rec);
                } catch (_) { warnings.push(`Could not write ${rel} to disk`); }
            }
        } else if (assetRels.length) {
            warnings.push(`${assetRels.length} media file(s) present but no extract directory was provided`);
        }

        // ── 3) Messages, one conversation at a time ────────────────────
        const sink = options.messageSink || null;
        const INLINE_BUDGET = !sink ? Infinity
            : (Number.isFinite(options.inlineBudget) ? options.inlineBudget : 25000);
        let lazy = false;
        let inlineTotal = 0;
        let linked = 0;
        let missingMedia = 0;
        const channels = [];
        const usedIds = new Set();
        const subId = subscriber.id;
        const subName = subscriber.username ? subscriber.username.toLowerCase() : null;

        for (const u of units) {
            const ctx = { users, last: { authorId: null, username: null } };
            let title = null;
            const msgs = [];
            for (const rel of u.pages) {
                const html = read(rel);
                if (html == null) { warnings.push(`Could not read ${rel}`); continue; }
                let page;
                try { page = this._parsePage(html, rel, ctx); } catch (err) {
                    warnings.push(`${rel}: could not be parsed — ${err.message}`);
                    continue;
                }
                if (!title && page.title) title = page.title;
                if (!page.messages.length) warnings.push(`${rel.slice(root.length)}: no messages found on this page`);
                for (const m of page.messages) msgs.push(m);
            }

            // Order by snowflake (exports may be newest-first); drop page-overlap duplicates.
            const seenIds = new Set();
            const ordered = [];
            for (const m of msgs) {
                if (m.id && /^\d+$/.test(m.id)) { if (seenIds.has(m.id)) continue; seenIds.add(m.id); }
                ordered.push(m);
            }
            ordered.sort((a, b) => {
                const ai = a.id && /^\d+$/.test(a.id), bi = b.id && /^\d+$/.test(b.id);
                if (ai && bi) return cmpSnowflake(a.id, b.id);
                return 0;
            });

            const folderKey = u.folder.toLowerCase();
            const info = folderInfo.get(folderKey) || {};
            const folderName = u.folder.replace(/\/$/, '').split('/').pop();
            let channelId;
            if (u.thread) {
                const tm = /_(\d{15,22})\.html?$/i.exec(u.pages[0]);
                channelId = tm ? tm[1] : `discrub-thread:${u.pages[0].slice(root.length)}`;
            } else {
                channelId = info.id && /^\d+$/.test(info.id) ? info.id : `discrub:${folderName}`;
            }
            while (usedIds.has(channelId)) channelId += '+';
            usedIds.add(channelId);

            const seen = new Map();
            let first = null, last = null, count = 0, sinkOpen = false;
            const kept = [];
            for (const m of ordered) {
                const ts = snowflakeToIso(m.id);
                const isSelf = !m.system && ((subId && m.authorId === subId) ||
                    (!m.authorId && subName && String(m.username || '').toLowerCase() === subName));
                const msg = {
                    id: m.id || null,
                    timestamp: ts,
                    rawTimestamp: m.rawTimestamp || null,
                    contents: m.contents || '',
                    attachments: m.attachments || '',
                    authorId: m.authorId || null,
                    username: m.username || null,
                    direction: isSelf ? 'outgoing' : 'incoming'
                };
                const media = [];
                for (const ref of m.media) {
                    const rec = mediaByRel.get(ref.rel.toLowerCase());
                    if (rec) {
                        media.push(ref.label && ref.label !== rec.fileName ? Object.assign({}, rec, { fileName: ref.label, storedName: rec.fileName }) : rec);
                    } else if (extractDir) missingMedia++;
                }
                if (media.length) { msg.media = media; linked += media.length; }
                if (ts) { if (!first || ts < first) first = ts; if (!last || ts > last) last = ts; }

                if (!m.system) {
                    const key = (msg.authorId || msg.username || '').toLowerCase();
                    if (key) {
                        let cur = seen.get(key);
                        if (!cur && seen.size < 5000) {
                            cur = { id: msg.authorId, username: msg.username, count: 0, isSubscriber: msg.direction === 'outgoing' };
                            seen.set(key, cur);
                        }
                        if (cur) cur.count++;
                    }
                }
                if (sink) {
                    if (!sinkOpen) { sink.beginChannel(channelId); sinkOpen = true; }
                    sink.write(msg);
                }
                count++;
                if (!lazy) {
                    kept.push(msg);
                    if (++inlineTotal > INLINE_BUDGET) {
                        lazy = true;
                        kept.length = 0;
                        for (const prev of channels) prev.messages = [];
                    }
                }
            }
            if (sinkOpen) { try { sink.endChannel(); } catch (_) {} }

            const participants = Array.from(seen.values()).sort((a, b) => b.count - a.count);
            const others = participants.filter(p => !p.isSubscriber);
            const baseName = info.name || title || folderName;
            let channelType, channelName;
            if (u.thread) {
                channelType = 'GUILD_THREAD';
                channelName = '🧵 ' + (title || folderName);
            } else if (isDM === true || (isDM === null && participants.length <= 2)) {
                channelType = others.length > 1 ? 'GROUP DM' : 'DM';
                channelName = baseName;
            } else {
                channelType = 'GUILD_TEXT';
                channelName = '#' + String(baseName).replace(/^#/, '');
            }

            channels.push({
                channelId,
                channelName,
                channelType,
                guildId: channelType === 'GUILD_TEXT' || channelType === 'GUILD_THREAD' ? guildId : null,
                guildName: channelType === 'GUILD_TEXT' || channelType === 'GUILD_THREAD' ? guildName : null,
                indexLabel: null,
                recipients: others.length ? others.map(p => ({ id: p.id, username: p.username })) : null,
                participants,
                bucket: u.thread ? 'threads' : 'html',
                firstMessage: first,
                lastMessage: last,
                messageCount: count,
                messages: lazy ? [] : kept,
                _sourceFile: u.pages[0] ? u.pages[0].slice(root.length) : null,
                _pageCount: u.pages.length
            });
        }
        if (lazy) for (const ch of channels) { ch.messages = []; ch._sharded = true; }
        if (missingMedia) warnings.push(`${missingMedia} media reference(s) point at files that are not in this export`);

        // README(s) are informational only.
        for (const n of originals.map(norm)) {
            if (/(^|\/)readme\.(html?|txt)$/i.test(n)) consumed.add(orig(n));
        }

        const servers = guildName ? [{
            id: guildId, name: guildName, description: null, ownerId: null, icon: null, region: null,
            preferredLocale: null,
            channels: channels.filter(c => c.channelType === 'GUILD_TEXT').map(c => ({ id: c.channelId, name: c.channelName.replace(/^#/, '') })),
            threads: channels.filter(c => c.channelType === 'GUILD_THREAD').map(c => ({ id: c.channelId, name: c.channelName.replace(/^🧵 /, '') })),
            channelCount: channels.filter(c => c.channelType === 'GUILD_TEXT').length,
            threadCount: channels.filter(c => c.channelType === 'GUILD_THREAD').length,
            auditLog: []
        }] : [];

        const unmatched = originals.filter(o => !consumed.has(o) && !/\/$/.test(o));
        const messageCount = channels.reduce((s, c) => s + c.messageCount, 0);
        if (!messageCount) warnings.push('No messages were recovered from this export.');

        return {
            format: 'html-export',
            formatLabel: 'Discord HTML Export (Discrub)',
            detectedRoot: root || '(archive root)',
            detectReasons: det.reasons,
            _lazy: lazy,
            subscriber,
            avatarFile: null,
            recentAvatarFiles: [],
            channels,
            servers,
            relationships: [],
            billing: { billingProfile: [], paymentSources: [], payments: [], entitlements: [] },
            dsar: [],
            promotions: { quests: [], drops: [] },
            store: { wishlist: [] },
            virtualCurrency: { accounts: [], transactions: [] },
            activity: { sessionStarts: [], sessionEnds: [], appOpens: [], logins: [], registers: [], otherImportant: [], eventCounts: {}, totalEventCount: 0 },
            ipActivity: [],
            devices: [],
            contentFiles,
            stats: {
                messageCount,
                channelCount: channels.length,
                serverCount: servers.length,
                relationshipCount: 0,
                sessionCount: 0,
                ipCount: 0,
                deviceCount: 0,
                eventCount: 0,
                mediaCount: Object.keys(contentFiles).length,
                mediaLinked: linked
            },
            diagnostics: {
                filesSeen: originals.length,
                filesConsumed: consumed.size,
                unmatchedFiles: unmatched.slice(0, 200),
                unmatchedCount: unmatched.length,
                warnings
            }
        };
    }

    _mime(ext) {
        const m = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
            '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
            '.pdf': 'application/pdf', '.txt': 'text/plain'
        };
        return m[ext] || 'application/octet-stream';
    }
}

module.exports = { DiscordHtmlExportParser, snowflakeToIso };
