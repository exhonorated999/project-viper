'use strict';
// CyberTips as the ICAC Data System sends them: one ZIP holding the
// CyberTipline report PDF plus a separate ZIP of reported media.
//
//   1. modules/_shared/evidence-zip.js (main process) — list and read inside
//      a ZIP, one nested level, in memory only, encrypted ZIPs included.
//   2. The Cyber Tips import loop (case-detail) — a ZIP is opened, the report
//      inside it is parsed, the media ZIP is never read.
//   3. The Evidence viewer ZIP panel (case-detail) — nothing in a CyberTip
//      ZIP is shown until the officer clicks View, except the report.
//
// The renderer functions are LIFTED from case-detail-with-analytics.html,
// never copied. Every fixture is synthetic: the "media" are a few bytes of
// PNG header and plain text — no imagery of any kind.
//
// Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd modules\__tests__\cybertip-zip.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');

const REPO = path.resolve(__dirname, '..', '..');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const EZ = require(path.join(REPO, 'modules', '_shared', 'evidence-zip.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '  (got ' + A + ', want ' + B + ')'));
}
function liftFunction(src, header) {
    const s = src.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const open = src.indexOf('{', s + header.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
    }
    throw new Error('unbalanced: ' + header);
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-ctzip-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const REPORT_PDF = Buffer.from('%PDF-1.4\n% synthetic\nNCMEC CyberTipline Report 999000111\n%%EOF\n', 'latin1');
const OTHER_PDF = Buffer.from('%PDF-1.4\nUploaded file list\n%%EOF\n', 'latin1');
const MEDIA_PDF = Buffer.from('%PDF-1.4\nreported document\n%%EOF\n', 'latin1');

function buildMediaZip() {
    const z = new AdmZip();
    z.addFile('Media/file_0001.png', PNG);
    z.addFile('Media/file_0002.mp4', Buffer.from('not really a video'));
    z.addFile('Media/notes.txt', Buffer.from('synthetic text entry'));
    z.addFile('Media/reported.pdf', MEDIA_PDF);
    z.addFile('__MACOSX/Media/._file_0001.png', Buffer.from('junk'));
    return z.toBuffer();
}
function buildTipZip(opts) {
    const z = new AdmZip();
    if (!opts || !opts.noReport) z.addFile('CyberTip_999000111.pdf', REPORT_PDF);
    z.addFile('Uploaded Files List.pdf', OTHER_PDF);
    z.addFile('999000111_media.zip', buildMediaZip());
    z.addFile('.DS_Store', Buffer.from('junk'));
    z.addFile('Thumbs.db', Buffer.from('junk'));
    return z.toBuffer();
}
const tipZip = path.join(TMP, 'ICAC 999000111.zip');
fs.writeFileSync(tipZip, buildTipZip());
const noReportZip = path.join(TMP, 'No Report.zip');
fs.writeFileSync(noReportZip, buildTipZip({ noReport: true }));
const brokenZip = path.join(TMP, 'Broken.zip');
fs.writeFileSync(brokenZip, Buffer.from('PK this is not a zip at all'));

// Field Security stand-in: "VIPENC" + plaintext.
let unlocked = true;
const security = {
    isUnlocked: () => unlocked,
    isEncryptedBuffer: b => !!b && b.length >= 6 && b.slice(0, 6).toString('latin1') === 'VIPENC',
    decryptBuffer: b => b.slice(6),
};
const encZip = path.join(TMP, 'Encrypted Tip.zip');
fs.writeFileSync(encZip, Buffer.concat([Buffer.from('VIPENC', 'latin1'), buildTipZip()]));

const tempBefore = new Set(fs.readdirSync(os.tmpdir()).filter(n => /^viper-zip-/.test(n)));

(async () => {
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n1. evidence-zip.js — listing');
    // ═════════════════════════════════════════════════════════════════════
    const L = await EZ.listEvidenceZip(tipZip, security);
    ok(L.ok, 'a plain CyberTip ZIP lists');
    eq(L.zipName, 'ICAC 999000111.zip', 'the listing names the ZIP');
    const names = L.entries.map(e => e.name);
    ok(names.indexOf('CyberTip_999000111.pdf') !== -1, 'the report PDF is listed');
    ok(names.indexOf('999000111_media.zip') !== -1, 'the media ZIP is listed');
    ok(!names.some(n => /__MACOSX|\.DS_Store|Thumbs\.db/.test(n)), 'operating-system clutter is not listed');
    const by = n => L.entries.find(e => e.name === n);
    eq(by('CyberTip_999000111.pdf').kind, 'pdf', 'a PDF is kind pdf');
    eq(by('999000111_media.zip').kind, 'zip', 'the inner ZIP is kind zip');
    ok(!by('CyberTip_999000111.pdf').inZip, 'a top-level entry carries no inZip');
    const kids = L.entries.filter(e => e.inZip === '999000111_media.zip');
    eq(kids.map(e => e.name).sort(),
       ['Media/file_0001.png', 'Media/file_0002.mp4', 'Media/notes.txt', 'Media/reported.pdf'],
       'the files inside the media ZIP are listed under it, without its clutter');
    eq(kids.map(e => e.kind).sort(), ['image', 'pdf', 'text', 'video'], 'each nested file is classified by kind');
    eq(by('CyberTip_999000111.pdf').size, REPORT_PDF.length, 'entry sizes are reported');
    const zi = names.indexOf('999000111_media.zip');
    ok(L.entries.slice(zi + 1, zi + 1 + kids.length).every(e => e.inZip), 'nested files follow their ZIP in the listing');
    eq(L.nestedErrors, [], 'no nested errors on a good ZIP');

    eq(EZ.kindOf('a.JPG'), 'image', 'kind matching is case-insensitive');
    eq(EZ.kindOf('a.weird'), 'other', 'an unknown extension is kind other');
    eq(EZ.mimeFor('report.pdf'), 'application/pdf', 'PDF mime');
    ok(EZ.isJunk('x/__MACOSX/y') && EZ.isJunk('a/desktop.ini') && !EZ.isJunk('report.pdf'), 'isJunk');

    const bad = await EZ.listEvidenceZip(brokenZip, security);
    ok(!bad.ok && typeof bad.error === 'string' && bad.error.length > 0, 'a corrupt ZIP comes back as an error, not a throw');
    const missing = await EZ.listEvidenceZip(path.join(TMP, 'gone.zip'), security);
    ok(!missing.ok && /no longer on disk/.test(missing.error), 'a ZIP no longer on disk says so');
    const notZip = await EZ.listEvidenceZip(path.join(TMP, 'x.pdf'), security);
    ok(!notZip.ok && /not a ZIP/.test(notZip.error), 'a non-ZIP path is refused');
    const noArg = await EZ.listEvidenceZip(null, security);
    ok(!noArg.ok, 'no path is refused');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n2. evidence-zip.js — reading');
    // ═════════════════════════════════════════════════════════════════════
    const R1 = await EZ.readEvidenceZipEntry(tipZip, 'CyberTip_999000111.pdf', '', security);
    ok(Buffer.compare(R1.bytes, REPORT_PDF) === 0, 'a top-level file reads back byte-for-byte');
    eq([R1.name, R1.mime, R1.size], ['CyberTip_999000111.pdf', 'application/pdf', REPORT_PDF.length], 'with its name, mime and size');
    const R2 = await EZ.readEvidenceZipEntry(tipZip, 'Media/file_0001.png', '999000111_media.zip', security);
    ok(Buffer.compare(R2.bytes, PNG) === 0, 'a file inside the media ZIP reads back byte-for-byte');
    eq([R2.name, R2.mime], ['file_0001.png', 'image/png'], 'a nested file is named by its base name');
    let threw = null;
    try { await EZ.readEvidenceZipEntry(tipZip, 'nope.pdf', '', security); } catch (e) { threw = e; }
    ok(threw && /not in the ZIP/.test(threw.message), 'a name not in the ZIP throws a plain message');
    threw = null;
    try { await EZ.readEvidenceZipEntry(tipZip, 'Media/file_0001.png', '', security); } catch (e) { threw = e; }
    ok(!!threw, 'a nested file is not reachable as a top-level name');
    threw = null;
    try { await EZ.readEvidenceZipEntry(tipZip, '', '', security); } catch (e) { threw = e; }
    ok(!!threw, 'an empty entry name throws');

    // The size ceiling: lowered for this test only by reading through a
    // copy of LIMITS is not possible (frozen) — so prove it is frozen, and
    // prove the guard exists in the shipping read path.
    ok(Object.isFrozen(EZ.LIMITS), 'LIMITS cannot be loosened at runtime');
    ok(EZ.LIMITS.readMaxBytes === 500 * 1024 * 1024, 'the per-file read ceiling is 500 MB');
    const ezSrc = fs.readFileSync(path.join(REPO, 'modules', '_shared', 'evidence-zip.js'), 'utf8');
    ok(/size > LIMITS\.readMaxBytes[\s\S]{0,300}code = 'TOO_LARGE'/.test(ezSrc), 'an oversize entry is refused with TOO_LARGE before it is read');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n3. evidence-zip.js — Field Security');
    // ═════════════════════════════════════════════════════════════════════
    unlocked = true;
    const E = await EZ.listEvidenceZip(encZip, security);
    ok(E.ok && E.entries.length === L.entries.length, 'an encrypted ZIP lists the same as the plain one');
    const E1 = await EZ.readEvidenceZipEntry(encZip, 'Media/notes.txt', '999000111_media.zip', security);
    eq(E1.bytes.toString(), 'synthetic text entry', 'a nested file in an encrypted ZIP reads back');
    unlocked = false;
    const EL = await EZ.listEvidenceZip(encZip, security);
    ok(!EL.ok && EL.locked === true, 'once Field Security locks, the cached decrypted copy is refused (locked: true)');
    threw = null;
    try { await EZ.readEvidenceZipEntry(encZip, 'CyberTip_999000111.pdf', '', security); } catch (e) { threw = e; }
    ok(threw && threw.code === 'VIPER_LOCKED', 'and reading from it throws VIPER_LOCKED');
    const plainWhileLocked = await EZ.listEvidenceZip(tipZip, security);
    ok(plainWhileLocked.ok, 'a plain (unencrypted) ZIP still lists while Field Security is locked');
    unlocked = true;
    const again = await EZ.listEvidenceZip(encZip, security);
    ok(again.ok, 'unlocking again opens it again');

    const tempAfter = fs.readdirSync(os.tmpdir()).filter(n => /^viper-zip-/.test(n) && !tempBefore.has(n));
    eq(tempAfter, [], 'NOTHING was written to the temp folder — no plaintext CSAM on disk');
    ok(!/\{\s*security\s*\}/.test(ezSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
       'evidence-zip never hands security to zip-reader (that path decrypts to a temp file)');
    EZ.closeAll();

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n4. Wiring');
    // ═════════════════════════════════════════════════════════════════════
    ok(/ipcMain\.handle\('evidence-zip-list'/.test(MAIN) && /ipcMain\.handle\('evidence-zip-read'/.test(MAIN), 'both IPC handlers are registered');
    ok(/ipcMain\.handle\('select-cybertip-files'/.test(MAIN), 'the CyberTip picker handler is registered');
    const pick = MAIN.slice(MAIN.indexOf("ipcMain.handle('select-cybertip-files'"), MAIN.indexOf("ipcMain.handle('select-cybertip-files'") + 1500);
    ok(/extensions:\s*\[[^\]]*'zip'/.test(pick) && /extensions:\s*\[[^\]]*'pdf'/.test(pick), 'the picker offers PDF and ZIP');
    ok(/multiSelections/.test(pick) && !/openDirectory/.test(pick), 'it is multi-select, files only (never openFile+openDirectory)');
    ok(/evidenceZipList:/.test(PRELOAD) && /evidenceZipRead:/.test(PRELOAD) && /selectCybertipFiles:/.test(PRELOAD), 'preload exposes all three');
    const extractBlock = MAIN.slice(MAIN.indexOf("ipcMain.handle('extract-pdf-text'"),
                                    MAIN.indexOf('\n});', MAIN.indexOf("ipcMain.handle('extract-pdf-text'")));
    ok(/readEvidenceZipEntry\(source\.zipPath, source\.entryName/.test(extractBlock), 'extract-pdf-text reads a PDF out of a ZIP when given one');
    ok(extractBlock.indexOf('_readPdfBytesForImport(filePath)') !== -1, 'and still reads a plain path through the decrypting reader');
    const rs = MAIN.indexOf("ipcMain.handle('evidence-zip-read'");
    const readBlock = MAIN.slice(rs, MAIN.indexOf('\n});', rs));
    ok(readBlock.length > 100 && /readEvidenceZipEntry/.test(readBlock), 'the read handler was found');
    ok(!/writeFile|tmpdir/.test(readBlock), 'evidence-zip-read writes nothing to disk');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n5. Cyber Tips import — a ZIP is opened and the report inside it read');
    // ═════════════════════════════════════════════════════════════════════
    const toasts = [];
    const extracted = [];
    let saved = null;
    const ienv = {
        Map, Set, String, Array, Number, JSON, console,
        window: {
            electronAPI: {
                evidenceZipList: p => EZ.listEvidenceZip(p, security),
                extractPdfText: async src => {
                    extracted.push(src);
                    if (src && typeof src === 'object') {
                        const g = await EZ.readEvidenceZipEntry(src.zipPath, src.entryName, src.inZip, security);
                        return { text: g.bytes.toString('latin1'), fileName: g.name };
                    }
                    return { text: fs.readFileSync(src, 'latin1'), fileName: path.basename(src) };
                },
            },
        },
        viperToast: (m, kind) => toasts.push([kind, m]),
        _esc: s => String(s),
        showLoadingIndicator() {}, hideLoadingIndicator() {},
        getCyberTips: () => [],
        saveCyberTips: t => { saved = t; },
        renderTabContent() {},
        parseCyberTip: (text, fileName) => ({ reportNumber: (text.match(/Report (\d+)/) || [])[1] || '', fileName }),
    };
    vm.createContext(ienv);
    vm.runInContext([
        liftFunction(DETAIL, 'async function _importCyberTipFiles(items) {'),
        liftFunction(DETAIL, 'async function _cyberTipExpandZips(items, tally, zipFound) {'),
        ';globalThis.__imp = _importCyberTipFiles; globalThis.__exp = _cyberTipExpandZips;',
    ].join('\n'), ienv);

    const t1 = await ienv.__imp([{ path: tipZip, evidenceTag: 'NCMEC 999000111' }]);
    eq([t1.added, t1.failed], [1, 0], 'one CyberTip is imported from the ZIP');
    eq(saved && saved.length, 1, 'and saved');
    eq(saved[0].reportNumber, '999000111', 'the report inside the ZIP is the one parsed');
    eq(saved[0].sourceZip, 'ICAC 999000111.zip', 'the tip remembers the ZIP it came from');
    eq(saved[0].sourceEvidenceTag, 'NCMEC 999000111', 'and the evidence item that holds it');
    ok(extracted.every(s => typeof s === 'object' && s.zipPath === tipZip), 'every read went through the ZIP, nothing was unpacked');
    ok(!extracted.some(s => s.inZip), 'the media ZIP was never opened for reading');
    eq(extracted[0].entryName, 'CyberTip_999000111.pdf', 'the likely report is read first');
    ok(!toasts.some(t => /does not appear to be a CyberTip PDF/.test(t[1])),
       'the other PDF in the ZIP does not produce a "not a CyberTip" error');
    ok(!toasts.some(t => /No CyberTipline report was found/.test(t[1])), 'no "not found" message when a report was found');

    toasts.length = 0; extracted.length = 0; saved = null;
    const t2 = await ienv.__imp([{ path: noReportZip }]);
    eq(t2.added, 0, 'a ZIP with no report imports nothing');
    ok(toasts.some(t => t[0] === 'error' && /No CyberTipline report was found inside No Report\.zip/.test(t[1])),
       'and says, once, that no report was found inside it');
    ok(!extracted.some(s => s.inZip), 'its media ZIP is still not read — the top-level PDF is tried instead');

    toasts.length = 0; extracted.length = 0;
    const onlyMedia = path.join(TMP, 'Only Media.zip');
    const zz = new AdmZip(); zz.addFile('inner.zip', buildMediaZip()); fs.writeFileSync(onlyMedia, zz.toBuffer());
    await ienv.__imp([{ path: onlyMedia }]);
    ok(extracted.length === 1 && extracted[0].inZip === 'inner.zip',
       'a nested PDF is only tried when the ZIP holds no PDF of its own');

    toasts.length = 0; extracted.length = 0;
    const t3 = await ienv.__imp([{ path: brokenZip }]);
    eq(t3.failed, 1, 'an unreadable ZIP counts as a failure');
    ok(toasts.some(t => /Could not read Broken\.zip/.test(t[1])), 'and names the ZIP');

    toasts.length = 0;
    unlocked = false;
    EZ.closeAll();
    const t4 = await ienv.__imp([{ path: encZip }]);
    unlocked = true;
    ok(t4.failed === 1 && toasts.some(t => /Field Security is locked/.test(t[1])), 'a locked encrypted ZIP says to unlock Field Security');

    toasts.length = 0; extracted.length = 0;
    const plainPdf = path.join(TMP, 'CyberTip 123.pdf');
    fs.writeFileSync(plainPdf, Buffer.from('%PDF-1.4\nCyberTipline Report 123\n', 'latin1'));
    const t5 = await ienv.__imp([{ path: plainPdf }]);
    eq(t5.added, 1, 'a plain PDF still imports exactly as before');
    eq(extracted, [plainPdf], 'a plain PDF is still read by path');

    const saveOld = ienv.window.electronAPI.evidenceZipList;
    delete ienv.window.electronAPI.evidenceZipList;
    toasts.length = 0;
    const t6 = await ienv.__imp([{ path: tipZip }]);
    ok(t6.failed === 1 && toasts.some(t => /restart VIPER/.test(t[1])), 'an old preload without ZIP support says to restart');
    ienv.window.electronAPI.evidenceZipList = saveOld;

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n6. Find in Evidence offers ZIPs');
    // ═════════════════════════════════════════════════════════════════════
    const denv = { Set, String, Array, caseEvidence: [
        { tag: 'NCMEC 999000111', type: 'ncmecCybertip', files: [{ name: 'ICAC 999000111.zip', path: tipZip }] },
        { tag: 'Photos', type: 'document', files: [{ name: 'scene.jpg', path: 'C:/x/scene.jpg' }, { name: 'Archive.ZIP', path: 'C:/x/Archive.ZIP' }] },
    ] };
    vm.createContext(denv);
    vm.runInContext(liftFunction(DETAIL, 'function _cyberTipEvidenceCandidates() {') + '\n;globalThis.__c = _cyberTipEvidenceCandidates;', denv);
    const c = denv.__c();
    eq(c.map(x => x.name), ['ICAC 999000111.zip', 'Archive.ZIP'], 'ZIPs are offered (case-insensitive), pictures are not');
    ok(c[0].zip === true && c[0].looksLikeTip, 'an NCMEC ZIP is marked as a ZIP and pre-ticked');
    ok(c[1].zip === true && !c[1].looksLikeTip, 'an unrelated ZIP is offered but not pre-ticked');
    const findSrc = liftFunction(DETAIL, 'async function findCyberTipsInEvidence() {');
    ok(/t\.sourceZip/.test(findSrc), 'a ZIP already imported shows as "already on this tab"');
    ok(findSrc.indexOf('extractPdfText') === -1 && findSrc.indexOf('evidenceZipList') === -1, 'opening the picker reads nothing');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n7. Evidence viewer ZIP panel');
    // ═════════════════════════════════════════════════════════════════════
    const nodes = {};
    const mkNode = id => (nodes[id] = nodes[id] || { id, innerHTML: '', textContent: '', dataset: {} });
    const urls = { made: [], revoked: [] };
    const reads = [];
    const venv = {
        Object, String, Array, Number, Uint8Array, TextDecoder,
        Blob: function (parts, o) { this.parts = parts; this.type = o && o.type; },
        URL: { createObjectURL: b => { const u = 'blob:test/' + urls.made.length; urls.made.push([u, b.type]); return u; },
               revokeObjectURL: u => urls.revoked.push(u) },
        // A real innerHTML assignment creates the elements it names; the
        // stub does the same, lazily, for any id present in rendered HTML.
        document: { getElementById: id => nodes[id]
            || (Object.keys(nodes).some(k => nodes[k].innerHTML.indexOf('id="' + id + '"') !== -1) ? mkNode(id) : null) },
        window: { electronAPI: {
            evidenceZipList: p => EZ.listEvidenceZip(p, security),
            evidenceZipRead: async (p, name, inZip) => {
                reads.push(name);
                const g = await EZ.readEvidenceZipEntry(p, name, inZip, security);
                return { ok: true, name: g.name, mime: g.mime, size: g.size, bytes: new Uint8Array(g.bytes) };
            },
        } },
        formatFileSize: n => n + ' B',
        _S: 'src',
    };
    vm.createContext(venv);
    const zs = DETAIL.indexOf('        const _evZipState = {};');
    const ze = DETAIL.indexOf('        function _evZipPanelId(evidence, index) {');
    ok(zs !== -1 && ze > zs, 'the panel constants are where expected');
    vm.runInContext([
        DETAIL.slice(zs, ze),
        liftFunction(DETAIL, 'function _evEsc(s) {'),
        liftFunction(DETAIL, 'function _evZipPanelId(evidence, index) {'),
        liftFunction(DETAIL, 'function _evZipIsCsam(evidence) {'),
        liftFunction(DETAIL, 'function _evZipRevoke(pid) {'),
        liftFunction(DETAIL, 'async function _hydrateEvidenceZipPanels(evidence) {'),
        liftFunction(DETAIL, 'function _renderEvidenceZipPanel(pid) {'),
        liftFunction(DETAIL, 'async function _evZipView(pid, i) {'),
        ';Object.assign(globalThis, { _evZipState, _evZipPanelId, _hydrateEvidenceZipPanels, _renderEvidenceZipPanel, _evZipView });',
    ].join('\n'), venv);

    const ev = { id: 'ev 1/x"', type: 'ncmecCybertip', files: [{ name: 'ICAC 999000111.zip', path: tipZip }] };
    const pid = venv._evZipPanelId(ev, 0);
    ok(/^[\w-]+$/.test(pid), 'the panel id is safe to use in an onclick');
    mkNode(pid);
    await venv._hydrateEvidenceZipPanels(ev);
    // The report view is started, not awaited, by the hydrate.
    await new Promise(r => setTimeout(r, 50));
    const st = venv._evZipState[pid];
    const html = nodes[pid].innerHTML;
    ok(/Reported media/.test(html) && /may contain child sexual abuse material/.test(html), 'a CyberTip ZIP carries the reported-media warning');
    ok(/6 files inside/.test(html), 'it counts the files inside, nested included, ZIPs and clutter not');
    ok(!/<img|<video|<audio/.test(html), 'no media is put on screen by listing the ZIP');
    const reportIdx = st.entries.findIndex(e => e.name === 'CyberTip_999000111.pdf');
    eq(reads, ['CyberTip_999000111.pdf'], 'the ONLY file read automatically is the report PDF');
    ok(/<iframe src="blob:test\/0"/.test(nodes[pid + '_v' + reportIdx].innerHTML), 'and it is shown in the PDF viewer');
    eq(urls.made[0][1], 'application/pdf', 'as a PDF blob');

    const imgIdx = st.entries.findIndex(e => e.name === 'Media/file_0001.png');
    ok(/onclick="_evZipView\('evz_[\w-]+', \d+\)"/.test(html), 'each viewable file has a View button');
    ok(/padding-left:22px/.test(html), 'files inside the media ZIP are indented beneath it');
    await venv._evZipView(pid, imgIdx);
    eq(reads[reads.length - 1], 'Media/file_0001.png', 'clicking View reads that one file');
    ok(/<img src="blob:test\/1"/.test(nodes[pid + '_v' + imgIdx].innerHTML), 'and shows it');
    eq(nodes[pid + '_b' + imgIdx].textContent, 'Hide', 'the button becomes Hide');
    await venv._evZipView(pid, imgIdx);
    eq(nodes[pid + '_v' + imgIdx].innerHTML, '', 'Hide clears it from the screen');
    ok(urls.revoked.indexOf('blob:test/1') !== -1, 'and frees the in-memory copy');
    eq(nodes[pid + '_b' + imgIdx].textContent, 'View', 'the button reads View again');

    const txtIdx = st.entries.findIndex(e => e.name === 'Media/notes.txt');
    await venv._evZipView(pid, txtIdx);
    ok(/<pre[^>]*>synthetic text entry<\/pre>/.test(nodes[pid + '_v' + txtIdx].innerHTML), 'a text file is shown as escaped text, not a blob');

    // Not a CyberTip: same panel, no warning.
    const ev2 = { id: 'ev2', type: 'document', files: [{ name: 'Records.zip', path: tipZip }] };
    const pid2 = venv._evZipPanelId(ev2, 0);
    mkNode(pid2);
    await venv._hydrateEvidenceZipPanels(ev2);
    ok(!/Reported media/.test(nodes[pid2].innerHTML), 'an ordinary ZIP has no reported-media warning');
    ok(/csamSensitive/.test(liftFunction(DETAIL, 'function _evZipIsCsam(evidence) {')), 'a CSAM-flagged item of any type gets the warning');

    // Locked.
    const ev3 = { id: 'ev3', type: 'ncmecCybertip', files: [{ name: 'Encrypted Tip.zip', path: encZip }] };
    const pid3 = venv._evZipPanelId(ev3, 0);
    mkNode(pid3);
    unlocked = false; EZ.closeAll();
    await venv._hydrateEvidenceZipPanels(ev3);
    unlocked = true;
    ok(/🔒/.test(nodes[pid3].innerHTML) && /Unlock Field Security/.test(nodes[pid3].innerHTML), 'a locked encrypted ZIP says to unlock Field Security');

    // Renderer wiring.
    ok(/const isZip = fileExt === 'zip';/.test(DETAIL), 'renderEvidenceFiles recognises a ZIP');
    ok(/viewerContent\.innerHTML = renderEvidenceFiles\(evidence\);\n[^\n]*\n[^\n]*\n\s*_hydrateEvidenceZipPanels\(evidence\);/.test(DETAIL),
       'the viewer fills ZIP panels after rendering');

    const tempEnd = fs.readdirSync(os.tmpdir()).filter(n => /^viper-zip-/.test(n) && !tempBefore.has(n));
    eq(tempEnd, [], 'still nothing written to the temp folder after viewing');

    EZ.closeAll();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
