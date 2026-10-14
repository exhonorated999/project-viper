/*
 * Word Report — Reports-tab UI tests.
 *
 * Run: node modules\reports\__tests__\word-report-ui.test.js
 *
 * Drives the real renderer module against a fake electronAPI, a fake host
 * and a tiny DOM stub (deliberately not jsdom). What it pins:
 *   - switching is never destructive and always confirmed; the VIPER report
 *     is saved BEFORE the switch to Word; a switch that could not be saved
 *     says so and does not repaint;
 *   - the "not included in Export to DA" disclaimer is on the Word tab and
 *     on the switch to Word;
 *   - one report per case: the file the officer made/chose is THE report,
 *     a "(recovered)" copy is listed beneath it, never silently promoted;
 *   - Replace hands the old name to main (which bins it only after the new
 *     one is in), and a replace that could not bin the old file says so;
 *   - the seed text is plain text, only when ticked, and never carries an
 *     image's data;
 *   - file names are escaped; events arrive on the report channel only.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const MOD = path.join(__dirname, '..', 'word-report-ui.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

// ── tiny DOM ──
const dom = { panel: null, seed: null };
global.document = {
    getElementById: (id) => (id === 'wrPanel' ? dom.panel : id === 'wrSeed' ? dom.seed : null),
};
const btn = (attrs) => ({ getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs || {}, k) ? attrs[k] : null) });

// ── fake main process ──
function fakeApi() {
    const disk = {};
    const calls = [];
    const api = {
        calls, disk, listGate: null, listener: null,
        importResult: null, saveCopyResult: null, openResult: null,
        async reportDocsList(cn) {
            calls.push(['list', cn]);
            if (api.listGate) await api.listGate;
            return { success: true, docs: (disk[cn] || []).map((d) => Object.assign({}, d)) };
        },
        async reportDocNewBlank(cn, name, seed) {
            calls.push(['blank', cn, name, seed]);
            const fileName = name + '.docx';
            (disk[cn] = disk[cn] || []).unshift({ fileName, bytes: 1, modifiedAt: new Date().toISOString(), open: false });
            return { success: true, fileName };
        },
        async reportDocImport(cn, replace) {
            calls.push(['import', cn, replace]);
            if (api.importResult) return api.importResult;
            (disk[cn] = disk[cn] || []).unshift({ fileName: 'From Desktop.docx', bytes: 1, modifiedAt: new Date().toISOString(), open: false });
            if (replace) disk[cn] = disk[cn].filter((d) => d.fileName !== replace);
            return { success: true, fileName: 'From Desktop.docx', replaceError: null };
        },
        async reportDocOpen(cn, name) { calls.push(['open', cn, name]); return api.openResult || { success: true, mode: 'direct', alreadyOpen: false }; },
        async reportDocRemove(cn, name) {
            calls.push(['remove', cn, name]);
            disk[cn] = (disk[cn] || []).filter((x) => x.fileName !== name);
            return { success: true, removed: true };
        },
        async reportDocSaveCopy(cn, name) {
            calls.push(['saveCopy', cn, name]);
            return api.saveCopyResult || { success: true, filePath: 'C:\\Users\\me\\Documents\\' + name, bytes: 10 };
        },
        onReportDocEvent(cb) { api.listener = cb; return () => { api.listener = null; }; },
        // A Working Documents subscription would be the wrong channel.
        onWorkingDocEvent() { throw new Error('subscribed to the Working Documents channel'); },
    };
    return api;
}

function fakeHost(api, over) {
    const h = {
        cn: 'C-1', fmt: 'viper', wordName: null,
        viperHtml: '<p>Suspect fled <b>north</b> on foot.</p><p>K9 &amp; air unit called.</p>',
        log: [], toasts: [], confirms: [], confirmAnswer: true, setOk: true,
        api,
        getCaseNumber: () => h.cn,
        getFormat: () => h.fmt,
        setFormat: (f) => { h.log.push(['setFormat', f]); if (!h.setOk) return false; h.fmt = f; return true; },
        getWordName: () => h.wordName,
        setWordName: (n) => { h.log.push(['setWordName', n]); h.wordName = n; return true; },
        getViperHtml: () => h.viperHtml,
        saveViperReport: () => { h.log.push(['saveViper']); },
        rerender: () => { h.log.push(['rerender']); },
        toast: (m, t) => { h.toasts.push({ m, t }); },
        confirm: (m, o) => { h.log.push(['confirm']); h.confirms.push({ m, o }); return h.confirmAnswer; },
    };
    return Object.assign(h, over || {});
}

function fresh() {
    delete require.cache[require.resolve(MOD)];
    delete globalThis.WordReportUI;
    return require(MOD);
}
function mount(UI) {
    dom.panel = { innerHTML: '' };
    dom.panel.innerHTML = UI.renderPanel();
}
const lastToast = (h) => h.toasts[h.toasts.length - 1] || { m: '', t: '' };
const DOC = (fileName, extra) => Object.assign({ fileName, bytes: 1, modifiedAt: '2026-10-01T12:00:00.000Z', open: false }, extra || {});

(async () => {
    // ─────────────────────────────────────────────────────────────────
    console.log('\n[loads under a <script> tag]');
    {
        const src = fs.readFileSync(MOD, 'utf8');
        const sb = { module: { exports: {} } };     // `module` IS defined in VIPER's renderer
        sb.window = sb; sb.globalThis = sb;
        vm.createContext(sb);
        vm.runInContext(src, sb);
        ok('window.WordReportUI is set even though `module` exists', !!(sb.WordReportUI && sb.WordReportUI.renderPanel));
        ok('…and module.exports too', !!(sb.module.exports && sb.module.exports.renderPanel));
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[seed text]');
    {
        const UI = fresh();
        const t = UI.htmlToText('<p>Line one</p><p>Line <b>two</b> &amp; more&nbsp;here</p><div>Three<br>Four</div>');
        ok('paragraphs and breaks become lines', t === 'Line one\nLine two & more here\nThree\nFour', t);
        const img = UI.htmlToText('<p>See photo:</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==">');
        ok('a pasted picture carries nothing into the seed', img === 'See photo:' && !/base64|data:/.test(img), img);
        ok('the editor placeholder is not report text', UI.htmlToText('<p style="color:#e5e7eb;">Start typing your report here...</p>') === '');
        ok('scripts and styles are dropped', UI.htmlToText('<style>p{}</style><p>A</p><script>alert(1)</script>') === 'A');
        ok('list items keep a bullet', UI.htmlToText('<ul><li>One</li><li>Two</li></ul>') === '\u2022 One\n\u2022 Two');
        ok('numeric entities decode', UI.htmlToText('&#8220;Hi&#x201D;') === '\u201cHi\u201d');
        ok('empty input is empty', UI.htmlToText(null) === '' && UI.htmlToText('') === '');
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[the switch]');
    {
        const UI = fresh();
        const api = fakeApi();
        const h = fakeHost(api);
        UI.configure(h);
        const sw = UI.renderModeSwitch();
        ok('the switch offers both', /VIPER editor/.test(sw) && /Microsoft Word/.test(sw));
        ok('VIPER is marked as the current choice', /data-wr-mode="viper" aria-pressed="true"/.test(sw) && /data-wr-mode="word" aria-pressed="false"/.test(sw));
        ok('clicking the current choice does nothing', /act\('noop'/.test(sw) && UI.act('noop') === null);

        h.confirmAnswer = false;
        await UI.act('mode-word', btn());
        ok('the VIPER report is saved BEFORE the question is asked',
            h.log[0] && h.log[0][0] === 'saveViper' && h.log[1] && h.log[1][0] === 'confirm', h.log);
        ok('the question carries the export disclaimer', h.confirms[0].m.indexOf('not included in Export to DA') !== -1);
        ok('…and says the VIPER report is kept', /Your VIPER report is kept/.test(h.confirms[0].m));
        ok('cancel changes nothing', h.fmt === 'viper' && !h.log.some((l) => l[0] === 'setFormat' || l[0] === 'rerender'));

        h.log.length = 0; h.confirmAnswer = true; h.setOk = false;
        await UI.act('mode-word', btn());
        ok('a switch that could not be saved is reported', lastToast(h).t === 'error' && /Could not save the change/.test(lastToast(h).m));
        ok('…and the tab is not repainted as if it worked', !h.log.some((l) => l[0] === 'rerender'));

        h.log.length = 0; h.setOk = true;
        const r = await UI.act('mode-word', btn());
        ok('yes → Word, then the tab repaints', r === true && h.fmt === 'word' && h.log.some((l) => l[0] === 'rerender'));
        ok('the switch now marks Word', /data-wr-mode="word" aria-pressed="true"/.test(UI.renderModeSwitch()));

        // Back to VIPER with the Word report still open.
        api.disk['C-1'] = [DOC('Case Report C-1.docx', { open: true })];
        h.wordName = 'Case Report C-1.docx';
        await UI.refresh();
        h.log.length = 0; h.confirms.length = 0;
        await UI.act('mode-viper', btn());
        const m = h.confirms[0].m;
        ok('going back says the Word report stays in the case', /Word report stays in the case and nothing is deleted/.test(m));
        ok('…warns that it is still open in Word', /still open in Word/.test(m));
        ok('…and names which report goes in the export', /VIPER report is the one included in Export to DA/.test(m));
        ok('no VIPER save is forced on the way back', !h.log.some((l) => l[0] === 'saveViper'));
        ok('→ VIPER', h.fmt === 'viper');
        ok('no file was touched by switching', !api.calls.some((c) => c[0] === 'remove' || c[0] === 'import' || c[0] === 'blank'));
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[Word tab — empty]');
    {
        const UI = fresh();
        const api = fakeApi();
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI);
        ok('loading first', /Loading/.test(dom.panel.innerHTML));
        await settle();
        const html = dom.panel.innerHTML;
        ok('the disclaimer is on the tab', html.indexOf('Not included in Export to DA') !== -1 &&
            html.indexOf('VIPER cannot convert a Word document into its report format, so it cannot be added to the overall report.') !== -1);
        ok('…and says how to send it separately', html.indexOf('Save a copy') !== -1 && /send it with the export separately/.test(html));
        ok('the empty state offers create and import', /Create a new Word report/.test(html) && /Use an existing Word document/.test(html));
        ok('there is VIPER text, so the seed option is offered', /id="wrSeed"/.test(html));
        ok('the switch is on the Word tab too', /id="wrModeSwitch"/.test(html));

        // Create without ticking the seed box.
        dom.seed = { checked: false };
        await UI.act('create', btn());
        await settle();
        const blank = api.calls.find((c) => c[0] === 'blank');
        ok('a new report is named for the case', blank && blank[2] === 'Case Report C-1', blank);
        ok('unticked → no seed text', blank && blank[3] === '');
        ok('it becomes THE report', h.wordName === 'Case Report C-1.docx');
        ok('…and opens in Word', api.calls.some((c) => c[0] === 'open' && c[2] === 'Case Report C-1.docx'));
        ok('the report card is drawn', /The case report/.test(dom.panel.innerHTML) && /Case Report C-1\.docx/.test(dom.panel.innerHTML));
    }
    {
        const UI = fresh();
        const api = fakeApi();
        const h = fakeHost(api, { fmt: 'word', cn: 'C/9' });
        UI.configure(h);
        mount(UI); await settle();
        dom.seed = { checked: true };
        await UI.act('create', btn());
        await settle();
        const blank = api.calls.find((c) => c[0] === 'blank');
        ok('ticked → the VIPER text goes in as plain lines',
            blank && blank[3] === 'Suspect fled north on foot.\nK9 & air unit called.', blank && blank[3]);
        ok('a case number with a slash makes a safe name', blank && blank[2] === 'Case Report C-9', blank && blank[2]);
    }
    {
        const UI = fresh();
        const api = fakeApi();
        const h = fakeHost(api, { fmt: 'word', viperHtml: '<p>Start typing your report here...</p>' });
        UI.configure(h);
        mount(UI); await settle();
        ok('no VIPER text → no seed option', !/id="wrSeed"/.test(dom.panel.innerHTML));
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[one report per case]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [
            DOC('Case Report (recovered).docx', { modifiedAt: '2026-10-03T12:00:00.000Z' }),
            DOC('Draft <b>x</b>.docx', { modifiedAt: '2026-10-02T12:00:00.000Z' }),
            DOC('Case Report.docx', { modifiedAt: '2026-10-01T12:00:00.000Z' }),
        ];
        const h = fakeHost(api, { fmt: 'word', wordName: 'Case Report.docx' });
        UI.configure(h);
        mount(UI); await settle();
        ok('the chosen file is the report even when older', UI._primaryDoc().fileName === 'Case Report.docx');
        const html = dom.panel.innerHTML;
        ok('the others are listed beneath it', /Other Word files kept with this report/.test(html) && /data-wr-extra="Case Report \(recovered\)\.docx"/.test(html));
        ok('file names are escaped', html.indexOf('<b>x</b>') === -1 && html.indexOf('Draft &lt;b&gt;x&lt;/b&gt;.docx') !== -1);

        h.wordName = null;
        ok('chosen file gone → the newest that is not a recovered copy', UI._primaryDoc().fileName === 'Draft <b>x</b>.docx');
        h.wordName = 'Case Report.docx';

        UI.act('use', btn({ 'data-wr-name': 'Case Report (recovered).docx' }));
        ok('"Make this the report" records the choice', h.wordName === 'Case Report (recovered).docx' && UI._primaryDoc().fileName === 'Case Report (recovered).docx');
        ok('…and repaints without a reload', /data-wr-row="Case Report \(recovered\)\.docx"/.test(dom.panel.innerHTML));
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[report actions]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report.docx')];
        const h = fakeHost(api, { fmt: 'word', wordName: 'Case Report.docx' });
        UI.configure(h);
        mount(UI); await settle();
        let html = dom.panel.innerHTML;
        ok('the card has Open, Save a copy, Replace, Remove',
            /Open in Word/.test(html) && /Save a copy/.test(html) && /Replace/.test(html) && /act\('remove'/.test(html));

        // Save a copy
        await UI.act('copy', btn({ 'data-wr-name': 'Case Report.docx' }));
        ok('Save a copy asks main for the named report', api.calls.some((c) => c[0] === 'saveCopy' && c[2] === 'Case Report.docx'));
        ok('…and says it is not in the DA package', lastToast(h).t === 'success' && /not inside the DA package/.test(lastToast(h).m));
        const n = h.toasts.length;
        api.saveCopyResult = { success: true, canceled: true };
        await UI.act('copy', btn({ 'data-wr-name': 'Case Report.docx' }));
        ok('a cancelled Save a copy is silent', h.toasts.length === n);
        api.saveCopyResult = { success: false, error: 'Field Security is locked. Unlock it to open encrypted documents.' };
        await UI.act('copy', btn({ 'data-wr-name': 'Case Report.docx' }));
        ok('a locked vault is explained', lastToast(h).t === 'error' && /Field Security is locked/.test(lastToast(h).m));

        // Replace
        h.confirms.length = 0;
        await UI.act('replace', btn({ 'data-wr-name': 'Case Report.docx' }));
        await settle();
        ok('replace is confirmed and says the old one goes to the Recycle Bin', /Recycle Bin once the new one is safely in/.test(h.confirms[0].m));
        ok('main is told which file to replace', api.calls.some((c) => c[0] === 'import' && c[2] === 'Case Report.docx'));
        ok('the new file becomes the report', h.wordName === 'From Desktop.docx' && UI._primaryDoc().fileName === 'From Desktop.docx');

        // Replace where the old one could not be binned
        api.importResult = { success: true, fileName: 'Second.docx', replaceError: 'Close "From Desktop.docx" in Word first.' };
        api.disk['C-1'].unshift(DOC('Second.docx', { modifiedAt: '2026-10-05T12:00:00.000Z' }));
        await UI.act('replace', btn({ 'data-wr-name': 'From Desktop.docx' }));
        await settle();
        ok('a replace that kept the old file says so', lastToast(h).t === 'warning' && /old one could not be removed/.test(lastToast(h).m));
        ok('…the new one is still the report', h.wordName === 'Second.docx');
        api.importResult = null;

        // Cancelled replace
        const before = api.calls.length;
        h.confirmAnswer = false;
        await UI.act('replace', btn({ 'data-wr-name': 'Second.docx' }));
        ok('a declined replace opens no file dialog', api.calls.length === before);
        h.confirmAnswer = true;

        // Open → the open report locks Replace/Remove
        api.disk['C-1'] = [DOC('Second.docx', { open: true })];
        await UI.refresh();
        html = dom.panel.innerHTML;
        ok('while open in Word, Replace and Remove are disabled',
            /act\('replace'[^>]*disabled title="Close it in Word first"/.test(html) && /act\('remove'[^>]*disabled title="Close it in Word first"/.test(html));
        const c2 = api.calls.length;
        await UI.act('remove', btn({ 'data-wr-name': 'Second.docx' }));
        ok('…and a remove that slips through is refused before main is asked', api.calls.length === c2 && lastToast(h).t === 'warning');

        // Remove the report
        api.disk['C-1'][0].open = false;
        await UI.refresh();
        h.confirms.length = 0;
        await UI.act('remove', btn({ 'data-wr-name': 'Second.docx' }));
        await settle();
        ok('removing the report says the VIPER report is not affected', /Your VIPER report is not affected/.test(h.confirms[0].m) && h.confirms[0].o.danger === true);
        ok('the report is forgotten', h.wordName === null);
        ok('…and the empty state returns', /No Word report yet/.test(dom.panel.innerHTML));
        ok('…with the disclaimer still on screen', /Not included in Export to DA/.test(dom.panel.innerHTML));

        // Open failure
        api.disk['C-1'] = [DOC('Case Report.docx')];
        await UI.refresh();
        api.openResult = { success: false, code: 'NO_APP', error: 'Windows could not find a program to open this document. Microsoft Word (or another program that opens .docx files) needs to be installed.' };
        await UI.act('open', btn({ 'data-wr-name': 'Case Report.docx' }));
        ok('no Word on the machine is explained in plain words', /Microsoft Word \(or another program/.test(lastToast(h).m));
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[events]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report.docx')];
        const h = fakeHost(api, { fmt: 'word', wordName: 'Case Report.docx' });
        UI.configure(h);
        mount(UI); await settle();
        ok('subscribed on the report channel', typeof api.listener === 'function');
        api.listener({ type: 'saved', caseNumber: 'C-1', fileName: 'Case Report.docx', savedAt: new Date().toISOString(), bytes: 99 });
        ok('a save from Word shows without a re-render', /saved into the case/.test(dom.panel.innerHTML) && !h.log.some((l) => l[0] === 'rerender'));
        api.listener({ type: 'error', caseNumber: 'C-1', fileName: 'Case Report.docx', message: 'Disk full' });
        ok('a failed save is red on the card', /text-red-400">Disk full/.test(dom.panel.innerHTML) && lastToast(h).t === 'error');
        api.listener({ type: 'error', caseNumber: 'OTHER', fileName: 'x.docx', message: 'Could not save' });
        ok('a failure in another case is still heard', /case OTHER/.test(lastToast(h).m));
        const lists = api.calls.filter((c) => c[0] === 'list').length;
        api.disk['C-1'].push(DOC('Case Report (recovered).docx'));
        api.listener({ type: 'recovered', caseNumber: 'C-1', fileName: 'Case Report (recovered).docx', action: 'recover-beside' });
        await settle();
        ok('a recovered copy re-reads the folder', api.calls.filter((c) => c[0] === 'list').length === lists + 1);
        ok('…is explained', /kept as <b>Case Report \(recovered\)\.docx<\/b>/.test(h.toasts.map((t) => t.m).join('|')));
        ok('…and does NOT replace the report', UI._primaryDoc().fileName === 'Case Report.docx');
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[case switch]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['A'] = [DOC('A report.docx')];
        api.disk['B'] = [DOC('B report.docx')];
        const h = fakeHost(api, { fmt: 'word', cn: 'A' });
        let release;
        api.listGate = new Promise((r) => { release = r; });
        UI.configure(h);
        mount(UI);
        await tick();
        h.cn = 'B';                       // the officer opens another case mid-load
        UI.configure(h);
        release(); api.listGate = null;
        await settle();
        mount(UI); await settle();
        ok("case A's report is never shown in case B", dom.panel.innerHTML.indexOf('A report.docx') === -1);
        ok("case B's report is shown instead", dom.panel.innerHTML.indexOf('B report.docx') !== -1);
        const n = api.calls.filter((c) => c[0] === 'list').length;
        UI.configure(h); mount(UI); await settle();
        ok('re-configuring the same case keeps the list', api.calls.filter((c) => c[0] === 'list').length === n);
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
