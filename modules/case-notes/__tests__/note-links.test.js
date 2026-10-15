/**
 * Web links in Case Notes — the note side (modules/case-notes/note-links.js).
 *
 * An officer pastes a Google Drive / OneDrive link into a note and expects
 * to click it. This pins:
 *   - which strings become links (http/https only — never javascript:,
 *     file:, data:), and where a link ends in running prose;
 *   - that linking is DISPLAY-only and never corrupts the note's markup
 *     (attribute values, existing links, entities, <style>, comments);
 *   - every pasted <a> is rewritten to one safe shape;
 *   - the paste hook and the click handler;
 *   - the shipping wiring in case-detail-with-analytics.html and
 *     note-popout.html (lifted, not copied).
 *
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd
 *      modules\case-notes\__tests__\note-links.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const NL = require('../note-links.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL: ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
}
function eq(a, b, name) { ok(a === b, name, { got: a, want: b }); }

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMnOpQrStUvWxYz?usp=sharing';
const DRIVE_DOC = 'https://docs.google.com/document/d/1x2Y3z/edit?usp=drive_link';
const ONEDRIVE = 'https://onedrive.live.com/?id=ABC123%21105&cid=ABC123';
const SHAREPOINT = 'https://agency-my.sharepoint.com/:f:/g/personal/jdoe_agency_gov/EjQ9?e=Xy12';
const ONEDRIVE_SHORT = 'https://1drv.ms/f/s!AkB2cD3eF4g?e=h5I6';

try {
    // ── normalizeWebUrl ─────────────────────────────────────────────
    eq(NL.normalizeWebUrl(DRIVE_FOLDER), DRIVE_FOLDER, 'Drive folder link accepted unchanged');
    eq(NL.normalizeWebUrl(SHAREPOINT), SHAREPOINT, 'OneDrive for Business (SharePoint) link accepted');
    eq(NL.normalizeWebUrl(ONEDRIVE_SHORT), ONEDRIVE_SHORT, '1drv.ms short link accepted');
    eq(NL.normalizeWebUrl('  ' + DRIVE_DOC + '\n'), DRIVE_DOC, 'surrounding whitespace trimmed');
    eq(NL.normalizeWebUrl('www.example.com/a'), 'https://www.example.com/a', 'www. gets https://');
    eq(NL.normalizeWebUrl('HTTP://Example.COM'), 'http://example.com/', 'scheme/host case-folded');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///C:/Windows/win.ini',
        'data:text/html,<script>1</script>', 'vbscript:x', 'ftp://x.com', 'http://', 'https://',
        'mailto:a@b.c', '', '   ', null, undefined, 42, 'drive.google.com/x', ' javascript:http://x',
        // WHATWG URL would "repair" these into real http(s) links — the
        // explicit scheme-prefix check must refuse them first.
        'http:example.com', 'https:/drive.google.com/x', 'https:\\\\drive.google.com\\x']) {
        eq(NL.normalizeWebUrl(bad), null, 'refused: ' + JSON.stringify(bad));
    }
    eq(NL.normalizeWebUrl('https://x.com/' + 'a'.repeat(5000)), null, 'absurdly long address refused');

    // ── trimUrlTail / findUrls ──────────────────────────────────────
    eq(NL.trimUrlTail('https://x.com/a.'), 'https://x.com/a', 'full stop after link is the sentence\'s');
    eq(NL.trimUrlTail('https://x.com/a),'), 'https://x.com/a', 'unbalanced ) and comma dropped');
    eq(NL.trimUrlTail('https://en.wikipedia.org/wiki/A_(b)'), 'https://en.wikipedia.org/wiki/A_(b)', 'balanced ) kept');
    eq(NL.trimUrlTail('https://en.wikipedia.org/wiki/A_(b))'), 'https://en.wikipedia.org/wiki/A_(b)', 'extra ) dropped');
    let hits = NL.findUrls('Folder: ' + DRIVE_FOLDER + '. Also (' + ONEDRIVE_SHORT + ') and www.agency.gov!');
    eq(hits.length, 3, 'three links found in a sentence');
    eq(hits[0] && hits[0].href, DRIVE_FOLDER, 'first is the Drive folder, no full stop');
    eq(hits[1] && hits[1].href, ONEDRIVE_SHORT, 'second is the 1drv.ms link, no bracket');
    eq(hits[2] && hits[2].href, 'https://www.agency.gov/', 'third is www. → https, no !');
    eq(NL.findUrls('nothing here, not even awww.x').length, 0, 'awww.x is not a www link');
    eq(NL.findUrls('see http:// and https://').length, 0, 'bare schemes are not links');

    // ── linkifyHtml ─────────────────────────────────────────────────
    const A = (href, text) => NL._anchorOpen(href) + (text == null ? href : text) + '</a>';
    const esc = (s) => s.replace(/&/g, '&amp;');

    eq(NL.linkifyHtml('<p>Evidence: ' + DRIVE_FOLDER + '</p>'),
        '<p>Evidence: ' + A(DRIVE_FOLDER, esc(DRIVE_FOLDER)) + '</p>', 'bare Drive link in a note becomes a link');
    // Stored HTML escapes & in text. The href must decode it exactly once.
    const stored = '<div>' + esc(ONEDRIVE) + '</div>';
    const out1 = NL.linkifyHtml(stored);
    ok(out1.indexOf('href="' + esc(ONEDRIVE) + '"') !== -1, '&amp; in note text → & in the real href (escaped once in the attribute)', out1);
    ok(out1.indexOf('&amp;amp;') === -1, 'no double-escaping', out1);
    ok(out1.indexOf('>' + esc(ONEDRIVE) + '</a>') !== -1, 'link text shows the address as typed', out1);

    const plain = '<p>No links, just <b>bold</b> &amp; text&nbsp;here.</p>';
    eq(NL.linkifyHtml(plain), plain, 'a note with no links is returned byte-identical');
    eq(NL.linkifyHtml(''), '', 'empty note');
    eq(NL.linkifyHtml(null), '', 'null note');

    const img = '<p><img src="https://example.com/a.png" alt="https://x.com"> caption</p>';
    eq(NL.linkifyHtml(img), img, 'addresses inside attributes are never touched');
    const gtInAttr = '<p><span title="a > https://x.com">t</span></p>';
    eq(NL.linkifyHtml(gtInAttr), gtInAttr, 'a quoted > inside an attribute does not split the tag');
    const cmt = '<!-- https://x.com --><p>x</p>';
    eq(NL.linkifyHtml(cmt), cmt, 'comments untouched');
    const sty = '<style>a{background:url(https://x.com/i.png)}</style><p>x</p>';
    eq(NL.linkifyHtml(sty), sty, '<style> content untouched');
    const after = NL.linkifyHtml('<style>.a{}</style>https://x.com');
    ok(after.indexOf('href="https://x.com/"') !== -1, 'linking resumes after </style>', after);

    // Existing links (pasted from a web page / Word)
    const pasted = '<p><a href="' + DRIVE_DOC + '" target="_self" onclick="evil()" style="color:red">Interview notes</a></p>';
    eq(NL.linkifyHtml(pasted), '<p>' + A(DRIVE_DOC, 'Interview notes') + '</p>',
        'a pasted <a> is rewritten to the one safe shape (no onclick, style, target)');
    const pastedText = '<a href="https://x.com/a">see https://y.com/b</a>';
    const out2 = NL.linkifyHtml(pastedText);
    ok((out2.match(/<a /g) || []).length === 1, 'an address inside an existing link is not linked again', out2);
    const js = '<p><a href="javascript:alert(1)">click</a> after</p>';
    eq(NL.linkifyHtml(js), '<p><span class="viper-note-link-dead">click</span> after</p>', 'javascript: link → plain text');
    const jsEnt = '<a href="jav&#x61;script:alert(1)">x</a>';
    ok(NL.linkifyHtml(jsEnt).indexOf('<a ') === -1, 'entity-obfuscated javascript: → plain text');
    const fileLink = "<a href='file:///C:/cases/x.pdf'>x</a>";
    ok(NL.linkifyHtml(fileLink).indexOf('<a ') === -1, 'file: link → plain text');
    eq(NL.linkifyHtml('<a name="top">Top</a>'), '<span class="viper-note-link-dead">Top</span>', 'anchor with no href → plain text');
    eq(NL.linkifyHtml('x</a>y'), 'xy', 'stray </a> dropped');
    const unclosed = NL.linkifyHtml('<a href="https://x.com">open');
    ok(/<\/a>$/.test(unclosed), 'an unclosed link is closed', unclosed);
    const unq = NL.linkifyHtml('<a href=https://x.com/q>q</a>');
    ok(unq.indexOf('href="https://x.com/q"') !== -1, 'unquoted href read', unq);
    const quote = NL.linkifyHtml('<a href="https://x.com/?q=&quot;a&quot;">q</a>');
    ok(quote.indexOf('href="https://x.com/?q=%22a%22"') !== -1, 'a quote in an href can never break out of the attribute', quote);
    const mixed = NL.linkifyHtml('<p>Folder ' + DRIVE_FOLDER + ' and doc ' + DRIVE_DOC + '.</p>');
    eq((mixed.match(/<a /g) || []).length, 2, 'two links in one paragraph');
    ok(/<\/a>\.<\/p>$/.test(mixed), 'trailing full stop stays outside the link', mixed);
    const nb = NL.linkifyHtml('see&nbsp;https://x.com/a&nbsp;now');
    ok(nb.indexOf('href="https://x.com/a"') !== -1, '&nbsp; ends a link', nb);
    // Idempotent: rendering twice must not nest links.
    const twice = NL.linkifyHtml(NL.linkifyHtml('<p>' + DRIVE_FOLDER + '</p>'));
    eq((twice.match(/<a /g) || []).length, 1, 'linkify of linkified HTML does not nest');
    // Every produced link carries the marker + fallback target.
    ok(/data-viper-link="1"/.test(mixed) && /target="_blank"/.test(mixed) && /rel="noopener noreferrer"/.test(mixed),
        'links carry data-viper-link, target=_blank fallback, rel=noopener');

    // ── pasteAsLink ─────────────────────────────────────────────────
    function pasteEvent(text, types) {
        const ev = {
            prevented: false,
            preventDefault() { this.prevented = true; },
            clipboardData: {
                items: (types || ['text/plain']).map((t) => ({ type: t })),
                getData: (k) => (k === 'text/plain' ? text : '')
            }
        };
        return ev;
    }
    function fakeDoc() {
        return { calls: [], execCommand(cmd, ui, val) { this.calls.push([cmd, val]); return true; } };
    }
    let d = fakeDoc(); let e = pasteEvent('  ' + DRIVE_FOLDER + '\r\n');
    eq(NL.pasteAsLink(e, d), true, 'pasting a bare Drive address is handled');
    ok(e.prevented, '…and the default paste is cancelled');
    ok(d.calls.length === 1 && d.calls[0][0] === 'insertHTML' && d.calls[0][1].indexOf('href="' + esc(DRIVE_FOLDER) + '"') !== -1,
        '…and a link is inserted', d.calls);
    ok(/<\/a>&nbsp;$/.test(d.calls[0][1]), '…followed by a space so typing continues outside the link');
    for (const [txt, why] of [['Folder ' + DRIVE_FOLDER, 'text with words'], ['javascript:alert(1)', 'javascript:'],
        ['just words', 'no address'], ['', 'empty']]) {
        d = fakeDoc(); e = pasteEvent(txt);
        eq(NL.pasteAsLink(e, d), false, 'paste not handled: ' + why);
        ok(!e.prevented && d.calls.length === 0, 'default paste kept: ' + why);
    }
    d = fakeDoc(); e = pasteEvent(DRIVE_FOLDER, ['text/plain', 'image/png']);
    eq(NL.pasteAsLink(e, d), false, 'a clipboard with a picture goes to the picture path');
    eq(NL.pasteAsLink({ clipboardData: null }, fakeDoc()), false, 'no clipboard → not handled');

    // ── installClickHandler ─────────────────────────────────────────
    function el(attrs, parent) {
        return {
            nodeType: 1, attrs, parentNode: parent || null,
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            matchesSel(sel) {
                return sel.split(',').some((s) => {
                    s = s.trim();
                    if (s === 'a[href]') return this.attrs.tag === 'a' && this.attrs.href != null;
                    if (s === '.note-rendered') return (this.attrs.class || '').split(' ').includes('note-rendered');
                    if (s === '[contenteditable="true"]') return this.attrs.contenteditable === 'true';
                    if (s === '[contenteditable=""]') return this.attrs.contenteditable === '';
                    return false;
                });
            },
            closest(sel) { let n = this; while (n) { if (n.nodeType === 1 && n.matchesSel(sel)) return n; n = n.parentNode; } return null; }
        };
    }
    function clickDoc() {
        const listeners = {};
        return {
            listeners,
            addEventListener(t, fn, cap) { (listeners[t] = listeners[t] || []).push({ fn, cap }); },
            fire(t, ev) { (listeners[t] || []).forEach((l) => l.fn(ev)); }
        };
    }
    function clickEv(target, extra) {
        return Object.assign({ type: 'click', button: 0, target, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }, extra || {});
    }
    const doc = clickDoc();
    const opened = [];
    eq(NL.installClickHandler(doc, (u) => opened.push(u)), true, 'click handler installs');
    eq(NL.installClickHandler(doc, (u) => opened.push('dup:' + u)), false, 'installs only once per document');
    ok(doc.listeners.click && doc.listeners.click[0].cap === true, 'listens in the capture phase (before any card handler)');

    const noteBox = el({ class: 'note-rendered text-gray-200' });
    const link = el({ tag: 'a', href: DRIVE_FOLDER }, noteBox);
    const textNode = { nodeType: 3, parentNode: link };
    let ce = clickEv(textNode);
    doc.fire('click', ce);
    eq(opened.join('|'), DRIVE_FOLDER, 'click on a link in a saved note opens it');
    ok(ce.prevented && ce.stopped, '…and the case page itself never navigates');

    const editor = el({ contenteditable: 'true' });
    const elink = el({ tag: 'a', href: DRIVE_DOC }, editor);
    opened.length = 0; ce = clickEv(elink);
    doc.fire('click', ce);
    eq(opened.length, 0, 'plain click on a link while editing does not open it (places the caret)');
    ok(ce.prevented, '…but never navigates either');
    ce = clickEv(elink, { ctrlKey: true });
    doc.fire('click', ce);
    eq(opened.join('|'), DRIVE_DOC, 'Ctrl+click while editing opens it');

    opened.length = 0;
    doc.fire('click', clickEv(el({ tag: 'a', href: 'https://elsewhere.com' }, el({ class: 'sidebar' }))));
    eq(opened.length, 0, 'links outside notes are left alone');
    const badLink = el({ tag: 'a', href: 'javascript:alert(1)' }, noteBox);
    ce = clickEv(badLink);
    doc.fire('click', ce);
    ok(opened.length === 0 && ce.prevented, 'a non-web href in a note is blocked, not opened');
    doc.fire('auxclick', clickEv(link, { type: 'auxclick', button: 1 }));
    eq(opened.join('|'), DRIVE_FOLDER, 'middle-click opens it too');
    opened.length = 0;
    doc.fire('auxclick', clickEv(link, { type: 'auxclick', button: 2 }));
    eq(opened.length, 0, 'right-click does not');

    // ── openInViper ─────────────────────────────────────────────────
    (async () => {
        const calls = [];
        const toasts = [];
        const w = { electronAPI: { openWebLink: (u) => { calls.push(u); return Promise.resolve({ success: true }); } },
            viperToast: (m) => toasts.push(m) };
        eq(await NL.openInViper(DRIVE_FOLDER, w), true, 'openInViper → electronAPI.openWebLink');
        eq(calls[0], DRIVE_FOLDER, '…with the normalised address');
        eq(await NL.openInViper('javascript:alert(1)', w), false, 'openInViper refuses non-web');
        eq(calls.length, 1, '…without calling main');
        w.electronAPI.openWebLink = () => Promise.resolve({ success: false, error: 'boom' });
        eq(await NL.openInViper(DRIVE_FOLDER, w), false, 'a failed open reports false');
        ok(toasts.length === 1 && /boom/.test(toasts[0]), '…and tells the officer why', toasts);
        const ext = [];
        eq(await NL.openInViper(DRIVE_FOLDER, { electronAPI: { openExternalUrl: (u) => { ext.push(u); return true; } } }), true,
            'no VIPER browser bridge → system browser fallback');
        eq(ext[0], DRIVE_FOLDER, '…with the address');

        // ── Shipping wiring (lifted) ────────────────────────────────
        const PAGE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
        const POP = fs.readFileSync(path.join(ROOT, 'note-popout.html'), 'utf8').replace(/\r\n/g, '\n');
        const start = PAGE.indexOf('        function _noteResolveHtml(note) {');
        const end = PAGE.indexOf('        function _noteAttachmentList(note) {');
        ok(start > 0 && end > start, 'located _noteResolveHtml/_noteRenderHtml in the page');
        const escStart = PAGE.indexOf('        function _escapeHtml(s) {');
        const escEnd = PAGE.indexOf('        function _escapeAttr(s) {');
        const sandbox = { window: null, console };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(PAGE.slice(escStart, escEnd) + PAGE.slice(start, end) +
            ';Object.assign(globalThis,{_noteRenderHtml});', sandbox);
        // Without NoteLinks loaded the renderer must degrade to the old output.
        const before = sandbox._noteRenderHtml({ contentHtml: '<p>' + DRIVE_FOLDER + '</p>' });
        eq(before, '<p>' + DRIVE_FOLDER + '</p>', 'page renderer without NoteLinks = old behaviour (no crash)');
        sandbox.NoteLinks = NL;
        const lifted = sandbox._noteRenderHtml({ contentHtml: '<p onclick="x()">' + DRIVE_FOLDER + '</p><script>bad()</script>' });
        ok(lifted.indexOf('href="' + DRIVE_FOLDER.replace(/&/g, '&amp;') + '"') !== -1, 'page renderer links a Drive address', lifted);
        ok(lifted.indexOf('onclick') === -1 && lifted.indexOf('<script') === -1, 'page renderer still strips script and on* handlers', lifted);
        const legacy = sandbox._noteRenderHtml({ content: 'Old plain note ' + ONEDRIVE_SHORT });
        ok(legacy.indexOf('href="' + ONEDRIVE_SHORT + '"') !== -1, 'legacy plain-text notes get links too', legacy);

        const tagRe = /<script src="modules\/case-notes\/note-links\.js"><\/script>/;
        ok(tagRe.test(PAGE), 'case page loads note-links.js');
        ok(PAGE.search(tagRe) < PAGE.indexOf('function _noteRenderHtml('), '…before the page script that uses it');
        ok(tagRe.test(POP), 'note pop-out loads note-links.js');
        ok(POP.search(tagRe) < POP.indexOf("editor.addEventListener('paste'"), '…before its editor script');
        const pagePaste = PAGE.indexOf("editor.addEventListener('paste', function(e) {");
        ok(pagePaste > 0 && PAGE.slice(pagePaste, pagePaste + 400).indexOf('NoteLinks.pasteAsLink(e, document)') !== -1,
            'note editor paste goes through pasteAsLink first');
        const popPaste = POP.indexOf("editor.addEventListener('paste', (e) => {");
        ok(popPaste > 0 && POP.slice(popPaste, popPaste + 200).indexOf('NoteLinks.pasteAsLink(e, document)') !== -1,
            'pop-out paste goes through pasteAsLink first');
        ok(/\.note-rendered a,/.test(PAGE) && /#noteEditor a \*/.test(PAGE), 'links are styled in notes and the editor');

        console.log(`${pass} passed \u00b7 ${fail} failed`);
        if (fail) process.exit(1);
    })().catch((err) => { console.log('FAIL: async block threw ' + (err && err.stack || err)); process.exit(1); });
} catch (err) {
    console.log('FAIL: threw ' + (err && err.stack || err));
    process.exit(1);
}
