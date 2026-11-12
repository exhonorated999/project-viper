/*
 * Report pictures in the case folder (modules/reports/report-store.js).
 *
 * Run: node modules\reports\__tests__\report-store.test.js
 *
 * A fake case-attachment IPC (in-memory files) and a minimal fake DOM stand
 * in for Electron; the HTML string half runs on the real case-storage.js.
 * Also pins the host wiring in case-detail-with-analytics.html,
 * report-popout.html and electron-main.js.
 */
const fs = require('fs');
const path = require('path');
const RS = require('../report-store.js');
const CS = require('../../_shared/case-storage.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

function fakeApi() {
    const files = new Map();
    const log = [];
    let n = 0;
    return {
        files, log,
        failSave: false, failRead: false, delay: 0,
        async caseAttachmentSave(p) {
            log.push(['save', p.caseNumber, p.kind, p.fileName]);
            if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
            if (this.failSave) return { success: false, error: 'Field Security is locked' };
            const name = p.fileName.replace(/(\.\w+)$/, '-' + (++n) + '$1');
            files.set(p.caseNumber + '/' + p.kind + '/' + name, p.dataBase64);
            return { success: true, fileName: name };
        },
        async caseAttachmentRead(p) {
            log.push(['read', p.caseNumber, p.kind, p.fileName]);
            if (this.failRead) return { success: false, error: 'locked' };
            const b = files.get(p.caseNumber + '/' + p.kind + '/' + p.fileName);
            return b ? { success: true, dataBase64: b } : { success: false, error: 'File not found' };
        },
    };
}

// Minimal element: attributes only, which is all the store touches.
function img(attrs) {
    const a = Object.assign({}, attrs);
    return {
        tagName: 'IMG', a,
        getAttribute: (k) => (Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null),
        setAttribute: (k, v) => { a[k] = String(v); },
        removeAttribute: (k) => { delete a[k]; },
    };
}
function rootOf(imgs) {
    return {
        querySelectorAll: (sel) => (sel === 'img' ? imgs : imgs.filter((i) => i.getAttribute('data-vp-img') != null)),
    };
}

(async () => {
    console.log('\n[basics]');
    ok('kind is the allow-listed "reports" folder', RS.KIND === 'reports');
    ok('blank pixel is the one case-storage uses', RS.BLANK === CS.BLANK_PIXEL);
    ok('valid names', RS.validName('report-image-abc-1.jpg') && RS.validName('report-image (1).png'));
    ok('no paths / odd names', !RS.validName('../x.png') && !RS.validName('a\\b.png') && !RS.validName('x.exe') && !RS.validName('') && !RS.validName(null));
    const sp = RS.splitDataUrl(JPG);
    ok('splitDataUrl', sp && sp.mime === 'image/jpeg' && sp.base64.indexOf('/9j/') === 0);

    console.log('\n[persistDom: new pictures go to the case folder]');
    const api = fakeApi();
    const st = RS.create({ api, caseNumber: () => '24-1', cs: CS });
    ok('available with the IPC and a case', st.available());
    const a = img({ src: PNG, style: 'width:50%' });
    const b = img({ src: JPG });
    const blank = img({ src: RS.BLANK });
    const ext = img({ src: 'https://example.invalid/x.png' });
    let r = await st.persistDom(rootOf([a, b, blank, ext]));
    ok('two saved', r.moved === 2 && r.failed === 0, r);
    ok('saved under kind reports, this case', api.log.filter((l) => l[0] === 'save').every((l) => l[1] === '24-1' && l[2] === 'reports'));
    ok('png keeps .png, jpeg gets .jpg', /\.png$/.test(a.a['data-vp-img']) && /\.jpg$/.test(b.a['data-vp-img']));
    ok('elements keep their picture on screen', a.a.src === PNG && b.a.src === JPG);
    ok('…and gain the reference + kind', a.a['data-vp-img-kind'] === 'reports' && b.a['data-vp-img-kind'] === 'reports');
    ok('style untouched', a.a.style === 'width:50%');
    ok('the blank and non-data pictures are left alone', !blank.a['data-vp-img'] && !ext.a['data-vp-img']);
    ok('bytes stored are the base64 body', api.files.get('24-1/reports/' + a.a['data-vp-img']) === PNG.split(',')[1]);
    const before = api.log.length;
    r = await st.persistDom(rootOf([a, b]));
    ok('a second save writes nothing again', r.moved === 0 && api.log.length === before);

    console.log('\n[persistDom: concurrent saves write one file per picture]');
    {
        const api2 = fakeApi(); api2.delay = 20;
        const st2 = RS.create({ api: api2, caseNumber: '24-1', cs: CS });
        const c = img({ src: PNG });
        const [r1, r2] = await Promise.all([st2.persistDom(rootOf([c])), st2.persistDom(rootOf([c]))]);
        ok('one IPC save', api2.log.filter((l) => l[0] === 'save').length === 1);
        ok('reference set', !!c.a['data-vp-img'] && r1.moved + r2.moved === 1);
        // Picture replaced while being written: not tagged with the old file.
        const d = img({ src: PNG });
        const p = st2.persistDom(rootOf([d]));
        d.a.src = JPG;
        await p;
        ok('a picture swapped mid-save is not given the old file', !d.a['data-vp-img']);
        await st2.persistDom(rootOf([d]));
        ok('…and gets its own file on the next save', /\.jpg$/.test(d.a['data-vp-img'] || ''));
    }

    console.log('\n[persistDom: failures]');
    {
        const api3 = fakeApi(); api3.failSave = true;
        const warns = [];
        const st3 = RS.create({ api: api3, caseNumber: '24-1', cs: CS, warn: (m) => warns.push(m) });
        const e = img({ src: PNG });
        const r3 = await st3.persistDom(rootOf([e]));
        ok('a failed write is counted', r3.failed === 1 && r3.moved === 0);
        ok('…the picture stays inline, untagged', e.a.src === PNG && !e.a['data-vp-img']);
        ok('…with the reason passed to warn', /locked/.test(warns.join(' ')));
        const noApi = RS.create({ api: null, caseNumber: '24-1', cs: CS });
        ok('no IPC → not available, nothing happens', !noApi.available() && (await noApi.persistDom(rootOf([img({ src: PNG })]))).moved === 0);
        const noCase = RS.create({ api: fakeApi(), caseNumber: () => '', cs: CS });
        ok('no case → not available', !noCase.available());
        const bad = img({ src: PNG, 'data-vp-img': '../../evil.png', 'data-vp-img-kind': 'reports' });
        const notes = img({ src: PNG, 'data-vp-img': 'note-image-1.png', 'data-vp-img-kind': 'notes' });
        const r4 = await st.persistDom(rootOf([bad, notes]));
        ok('a bad or foreign reference is dropped and the picture saved as a report picture', r4.moved === 2
            && RS.validName(bad.a['data-vp-img']) && bad.a['data-vp-img'] !== '../../evil.png'
            && notes.a['data-vp-img-kind'] === 'reports', [bad.a, notes.a]);
    }

    console.log('\n[lean: the stored copy]');
    const html = '<p>Hi</p><img data-vp-img="' + a.a['data-vp-img'] + '" data-vp-img-kind="reports" src="' + PNG + '" style="width:50%"><img src="' + JPG + '">';
    const lean = st.lean(html);
    ok('referenced pictures lose their bytes', lean.indexOf(PNG) < 0 && lean.indexOf(RS.BLANK) > 0);
    ok('…keep their reference and style', lean.indexOf('data-vp-img="' + a.a['data-vp-img'] + '"') > 0 && lean.indexOf('width:50%') > 0);
    ok('an unsaved picture is kept inline (never lost)', lean.indexOf(JPG) > 0);

    console.log('\n[hydrate]');
    {
        const api4 = fakeApi();
        const w = RS.create({ api: api4, caseNumber: '24-1', cs: CS });
        const x = img({ src: PNG }); await w.persistDom(rootOf([x]));
        const name = x.a['data-vp-img'];
        const fresh = RS.create({ api: api4, caseNumber: '24-1', cs: CS });   // empty cache = a new session
        const y = img({ src: RS.BLANK, 'data-vp-img': name, 'data-vp-img-kind': 'reports' });
        const gone = img({ src: RS.BLANK, 'data-vp-img': 'report-image-missing.png', 'data-vp-img-kind': 'reports' });
        const missing = await fresh.hydrateDom(rootOf([y, gone]));
        ok('hydrateDom loads the picture (mime from the name)', y.a.src === PNG, y.a.src.slice(0, 40));
        ok('…counts what could not be read, keeping its reference', missing === 1 && gone.a['data-vp-img'] === 'report-image-missing.png' && gone.a.src === RS.BLANK);
        const reads = api4.log.filter((l) => l[0] === 'read').length;
        const z = img({ src: RS.BLANK, 'data-vp-img': name, 'data-vp-img-kind': 'reports' });
        await fresh.hydrateDom(rootOf([z]));
        ok('second load comes from the cache', z.a.src === PNG && api4.log.filter((l) => l[0] === 'read').length === reads);
        const loaded = img({ src: JPG, 'data-vp-img': name, 'data-vp-img-kind': 'reports' });
        await fresh.hydrateDom(rootOf([loaded]));
        ok('an already loaded picture is not replaced', loaded.a.src === JPG);
        const s = await fresh.hydrateHtml(st.lean('<p>x</p><img data-vp-img="' + name + '" data-vp-img-kind="reports" src="' + RS.BLANK + '">'));
        ok('hydrateHtml (Export to DA)', s.indexOf(PNG) > 0 && s.indexOf('<p>x</p>') === 0);
        const n2 = await fresh.hydrateHtml('<img data-vp-img="' + name + '" data-vp-img-kind="notes" src="' + RS.BLANK + '">');
        ok('hydrateHtml ignores other kinds', n2.indexOf(PNG) < 0);
        ok('hydrateHtml of plain text is a no-op', (await fresh.hydrateHtml('<p>a</p>')) === '<p>a</p>');
        const other = RS.create({ api: api4, caseNumber: '24-2', cs: CS });
        const q = img({ src: RS.BLANK, 'data-vp-img': name, 'data-vp-img-kind': 'reports' });
        await other.hydrateDom(rootOf([q]));
        ok('another case cannot read this case\'s picture', q.a.src === RS.BLANK);
        api4.failRead = true;
        const locked = RS.create({ api: api4, caseNumber: '24-1', cs: CS });
        const l2 = img({ src: RS.BLANK, 'data-vp-img': name, 'data-vp-img-kind': 'reports' });
        ok('locked vault: picture stays a reference', (await locked.hydrateDom(rootOf([l2]))) === 1 && l2.a.src === RS.BLANK);
    }

    console.log('\n[dehydrateHtml: migrating reports saved before 5.6.1]');
    {
        const api5 = fakeApi();
        const m = RS.create({ api: api5, caseNumber: '24-1', cs: CS });
        const old = '<p>Report</p><img src="' + PNG + '" style="width:40%"><p>more</p><img src="' + JPG + '">';
        ok('hasInlinePictures', m.hasInlinePictures(old) && !m.hasInlinePictures('<p>x</p>'));
        const res = await m.dehydrateHtml(old);
        ok('both pictures moved', res.moved === 2 && res.failed === 0, res);
        ok('stored copy is lean', res.html.indexOf(PNG) < 0 && res.html.indexOf(JPG) < 0 && !m.hasInlinePictures(res.html));
        ok('text and style survive', res.html.indexOf('<p>Report</p>') === 0 && res.html.indexOf('width:40%') > 0);
        ok('references are report pictures', (res.html.match(/data-vp-img-kind="reports"/g) || []).length === 2);
        const back = await RS.create({ api: api5, caseNumber: '24-1', cs: CS }).hydrateHtml(res.html);
        ok('…and load back to the same pictures', back.indexOf(PNG) > 0 && back.indexOf(JPG) > 0);
        api5.failSave = true;
        const res2 = await RS.create({ api: api5, caseNumber: '24-1', cs: CS }).dehydrateHtml(old);
        ok('a failed migration leaves the report untouched', res2.moved === 0 && res2.html === old);
    }

    console.log('\n[host wiring]');
    {
        const H = read('case-detail-with-analytics.html');
        const P = read('report-popout.html');
        const M = read('electron-main.js');
        ok('main process allows the Reports folder', /reports:\s*'Reports'/.test(M));
        ok('report-save relay hands the report to the case page', M.indexOf('window._applyPoppedOutReport(d)') > 0);
        ok('case page loads report-store.js', H.indexOf('<script src="modules/reports/report-store.js"></script>') > 0);
        const save = H.slice(H.indexOf('async function saveReport('), H.indexOf('// Export PDF (Reports tab)'));
        ok('saveReport persists pictures before writing', save.indexOf('persistDom(editor)') > 0 && save.indexOf('persistDom(editor)') < save.indexOf("localStorage.setItem('viperCaseReports'"));
        ok('saveReport stores the lean copy', /content:\s*st \? st\.lean\(caseReport\)/.test(save));
        ok('editor loads pictures', /editor\.innerHTML = caseReport[^\n]*\n[^\n]*\n\s*\{ const st = _reportStore\(\); if \(st\) st\.hydrateDom\(editor\)/.test(H));
        ok('migration runs on case load', H.indexOf('_reportStorageMaintenance(); }, 0);') > 0);
        const da = H.slice(H.indexOf("case 'reports': {"), H.indexOf("case 'opsplan': {"));
        ok('Export to DA loads the pictures', da.indexOf('_reportImagesFromDisk(rpt.content)') > 0);
        const pdf = H.slice(H.indexOf('async function exportReportToPDF('), H.indexOf('function _exportReportToPDFLegacy('));
        ok('Export PDF waits for the save and loads pictures', pdf.indexOf('await saveReport(true)') > 0 && pdf.indexOf('hydrateDom(editor)') > 0);
        ok('pop-out loads case-storage + report-store', P.indexOf('modules/_shared/case-storage.js') > 0 && P.indexOf('modules/reports/report-store.js') > 0);
        ok('pop-out persists, then sends the lean copy', P.indexOf('store.persistDom(editor)') > 0 && P.indexOf('store.lean(html)') > P.indexOf('store.persistDom(editor)'));
        ok('pop-out loads pictures', P.indexOf('store.hydrateDom(editor)') > 0);
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
