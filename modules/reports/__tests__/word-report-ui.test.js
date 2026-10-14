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
 *   - SEVERAL reports per case (5.4.1): every Word file in the folder is a
 *     report card of its own, listed by name (numbers in order); a new one
 *     is added BESIDE the others under a name the officer chooses and never
 *     touches them; several documents can be brought in at once; rename;
 *     a "(recovered)" copy is flagged but listed like the rest;
 *   - the module never writes the 5.4.0 "chosen report" field any more;
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
            return { success: true, fileName: 'From Desktop.docx', added: ['From Desktop.docx'], failed: [], replaceError: null };
        },
        async reportDocRename(cn, name, newName) {
            calls.push(['rename', cn, name, newName]);
            if (api.renameResult) return api.renameResult;
            const d = (disk[cn] || []).find((x) => x.fileName === name);
            if (d) d.fileName = newName + '.docx';
            return { success: true, fileName: newName + '.docx' };
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
        cn: 'C-1', fmt: 'viper',
        viperHtml: '<p>Suspect fled <b>north</b> on foot.</p><p>K9 &amp; air unit called.</p>',
        log: [], toasts: [], confirms: [], confirmAnswer: true, setOk: true,
        asks: [], askAnswer: null,
        api,
        getCaseNumber: () => h.cn,
        getFormat: () => h.fmt,
        setFormat: (f) => { h.log.push(['setFormat', f]); if (!h.setOk) return false; h.fmt = f; return true; },
        // 5.4.0's "chosen report" pair. The host no longer passes these; they
        // are here only so a test can prove the module never calls them.
        getWordName: () => { h.log.push(['getWordName']); return 'Legacy Chosen.docx'; },
        setWordName: (n) => { h.log.push(['setWordName', n]); return true; },
        ask: (spec) => { h.asks.push(spec); return h.askAnswer; },
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
        api.disk['C-1'] = [DOC('Case Report C-1.docx', { open: true }), DOC('Supplemental Report C-1.docx')];
        await UI.refresh();
        h.log.length = 0; h.confirms.length = 0;
        await UI.act('mode-viper', btn());
        const m = h.confirms[0].m;
        ok('going back says the Word reports stay in the case', /Word reports stay in the case and nothing is deleted/.test(m));
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
            html.indexOf('VIPER cannot convert a Word document into its report format, so they cannot be added to the overall report.') !== -1);
        ok('…and says how to send them separately', /Save a copy\u2026\u201d on each report/.test(html) && /send it with the export separately/.test(html));
        ok('the empty state offers create and import', /Create a new Word report/.test(html) && /Use existing Word documents/.test(html));
        ok('…and says a case can hold several', /as many reports here as the case needs/.test(html));
        ok('there is VIPER text, so the seed option is offered', /id="wrSeed"/.test(html));
        ok('the switch is on the Word tab too', /id="wrModeSwitch"/.test(html));

        // Create without ticking the seed box.
        dom.seed = { checked: false };
        await UI.act('create', btn());
        await settle();
        const blank = api.calls.find((c) => c[0] === 'blank');
        ok('a new report is named for the case', blank && blank[2] === 'Case Report C-1', blank);
        ok('unticked → no seed text', blank && blank[3] === '');
        ok('the first report needs no name dialog', h.asks.length === 0);
        ok('…and opens in Word', api.calls.some((c) => c[0] === 'open' && c[2] === 'Case Report C-1.docx'));
        ok('the report card is drawn', /data-wr-row="Case Report C-1\.docx"/.test(dom.panel.innerHTML));
        ok('…with the toolbar to add more', /data-wr-toolbar/.test(dom.panel.innerHTML) && /1 Word report in this case/.test(dom.panel.innerHTML));
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
    console.log('\n[several reports per case]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [
            DOC('Supplement 10.docx', { modifiedAt: '2026-10-04T12:00:00.000Z' }),
            DOC('Case Report (recovered).docx', { modifiedAt: '2026-10-03T12:00:00.000Z' }),
            DOC('Draft <b>x</b>.docx', { modifiedAt: '2026-10-02T12:00:00.000Z' }),
            DOC('Supplement 2.docx', { modifiedAt: '2026-10-05T12:00:00.000Z' }),
            DOC('Case Report.docx', { modifiedAt: '2026-10-01T12:00:00.000Z' }),
        ];
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI); await settle();
        const html = dom.panel.innerHTML;
        const rows = (html.match(/data-wr-row="[^"]*"/g) || []).map((s) => s.slice(13, -1));
        ok('every Word file is a report card of its own', rows.length === 5, rows);
        ok('listed by name, numbers in order (2 before 10), a recovered copy right beneath its report',
            JSON.stringify(rows) === JSON.stringify(['Case Report.docx', 'Case Report (recovered).docx', 'Draft &lt;b&gt;x&lt;/b&gt;.docx', 'Supplement 2.docx', 'Supplement 10.docx']), rows);
        ok('the toolbar counts them', /5 Word reports in this case/.test(html));
        ok('the toolbar offers another report and more documents', /act\('create-another'/.test(html) && /\+ New Word report/.test(html) && /Add existing documents/.test(html));
        ok('every card has its own Open, Save a copy, Rename, Replace and Remove',
            (html.match(/act\('open'/g) || []).length === 5 && (html.match(/act\('copy'/g) || []).length === 5 &&
            (html.match(/act\('rename'/g) || []).length === 5 && (html.match(/act\('replace'/g) || []).length === 5 &&
            (html.match(/act\('remove'/g) || []).length === 5);
        ok('there is no "main" report any more', !/act\('use'/.test(html) && !/The case report/.test(html) && !/Other Word files/.test(html));
        ok('a recovered copy is flagged, once', (html.match(/data-wr-recovered/g) || []).length === 1 &&
            /data-wr-row="Case Report \(recovered\)\.docx"[\s\S]*?data-wr-recovered/.test(html));
        ok('file names are escaped', html.indexOf('<b>x</b>') === -1 && html.indexOf('Draft &lt;b&gt;x&lt;/b&gt;') !== -1);
        ok('the chosen-report field is never read or written', !h.log.some((l) => l[0] === 'getWordName' || l[0] === 'setWordName'));
        ok('the suggested next name skips the recovered copy', UI._nextName() === 'Supplemental Report 4 C-1', UI._nextName());
    }
    {
        // + New Word report: asks for a name, adds beside the others, touches nothing else.
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report C-1.docx')];
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI); await settle();
        ok('with one report the suggestion is the first supplement', UI._nextName() === 'Supplemental Report C-1', UI._nextName());

        h.askAnswer = null;
        await UI.act('create-another', btn());
        await settle();
        ok('the name dialog is shown with the suggestion', h.asks.length === 1 && h.asks[0].name === 'Supplemental Report C-1' && h.asks[0].okText === 'Create and open');
        ok('…and offers the VIPER text because there is some', h.asks[0].seed === true);
        ok('…and says nothing else changes', /Nothing else changes/.test(h.asks[0].text));
        ok('cancel creates nothing', !api.calls.some((c) => c[0] === 'blank'));

        h.askAnswer = { name: '   ', seed: false };
        await UI.act('create-another', btn());
        await settle();
        ok('a blank name creates nothing', !api.calls.some((c) => c[0] === 'blank'));

        h.askAnswer = { name: 'Supplement - Search Warrant', seed: false };
        await UI.act('create-another', btn());
        await settle();
        let blank = api.calls.filter((c) => c[0] === 'blank');
        ok('the officer\u2019s name is used', blank.length === 1 && blank[0][2] === 'Supplement - Search Warrant', blank);
        ok('…unticked → no seed text', blank[0] && blank[0][3] === '');
        ok('…it opens in Word', api.calls.some((c) => c[0] === 'open' && c[2] === 'Supplement - Search Warrant.docx'));
        ok('…and the first report is untouched', !api.calls.some((c) => c[0] === 'remove' || c[0] === 'import' || c[0] === 'rename') &&
            api.disk['C-1'].some((d) => d.fileName === 'Case Report C-1.docx'));
        ok('both are listed', /data-wr-row="Case Report C-1\.docx"/.test(dom.panel.innerHTML) && /data-wr-row="Supplement - Search Warrant\.docx"/.test(dom.panel.innerHTML));
        ok('the chosen-report field is still never written', !h.log.some((l) => l[0] === 'setWordName' || l[0] === 'getWordName'));

        h.askAnswer = { name: 'Supplement 3', seed: true };
        await UI.act('create-another', btn());
        await settle();
        blank = api.calls.filter((c) => c[0] === 'blank');
        ok('ticked in the dialog → the VIPER text as plain lines', blank[1] && blank[1][3] === 'Suspect fled north on foot.\nK9 & air unit called.', blank[1]);
    }
    {
        // No VIPER text → the dialog does not offer it, and a stray tick carries nothing.
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report C-1.docx')];
        const h = fakeHost(api, { fmt: 'word', viperHtml: '' });
        UI.configure(h);
        mount(UI); await settle();
        h.askAnswer = { name: 'Supp', seed: true };
        await UI.act('create-another', btn());
        await settle();
        const blank = api.calls.find((c) => c[0] === 'blank');
        ok('no VIPER text → no seed offered', h.asks[0].seed === false);
        ok('…and none sent', blank && blank[3] === '', blank);
    }
    {
        // Bringing several documents in at once.
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report C-1.docx')];
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI); await settle();
        api.importResult = { success: true, fileName: 'Supp A.docx', added: ['Supp A.docx', 'Supp <B>.docx'],
            failed: [{ fileName: 'notes.txt', error: 'Only Word documents can be added.' }], replaceError: null };
        api.disk['C-1'].push(DOC('Supp A.docx'), DOC('Supp <B>.docx'));
        await UI.act('import', btn());
        await settle();
        const imp = api.calls.find((c) => c[0] === 'import');
        ok('adding is not a replace', imp && imp[2] === null, imp);
        const msgs = h.toasts.map((t) => t.t + ':' + t.m);
        ok('every document that went in is named', msgs.some((m) => /^success:Added to the case: <b>Supp A\.docx<\/b>, <b>Supp &lt;B&gt;\.docx<\/b>/.test(m)), msgs);
        ok('the one that did not is named with the reason', msgs.some((m) => /^error:Not added \u2014 notes\.txt: Only Word documents can be added\./.test(m)), msgs);
        ok('all three reports are listed', (dom.panel.innerHTML.match(/data-wr-row=/g) || []).length === 3);

        api.importResult = { success: true, canceled: true };
        const n = h.toasts.length;
        await UI.act('import', btn());
        ok('a cancelled pick is silent', h.toasts.length === n);
        api.importResult = { success: true, fileName: 'Old.docx' };     // an older main process (no `added`)
        await UI.act('import', btn());
        await settle();
        ok('an older main process is still understood', /Added to the case: <b>Old\.docx<\/b>/.test(lastToast(h).m));
    }
    {
        // Rename.
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report C-1.docx'), DOC('Supplemental Report C-1.docx', { open: true })];
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI); await settle();
        let html = dom.panel.innerHTML;
        ok('Rename is locked on the report open in Word', /act\('rename'[^>]*data-wr-name="Supplemental Report C-1\.docx"[^>]*disabled title="Close it in Word first"/.test(html));
        ok('…and free on the one that is not', /act\('rename'[^>]*data-wr-name="Case Report C-1\.docx"(?! disabled)/.test(html));
        await UI.act('rename', btn({ 'data-wr-name': 'Supplemental Report C-1.docx' }));
        ok('a rename that slips through while open is refused before anything is asked',
            h.asks.length === 0 && !api.calls.some((c) => c[0] === 'rename') && lastToast(h).t === 'warning');

        h.askAnswer = null;
        await UI.act('rename', btn({ 'data-wr-name': 'Case Report C-1.docx' }));
        ok('the dialog offers the current name without .docx', h.asks[0] && h.asks[0].name === 'Case Report C-1' && h.asks[0].okText === 'Rename');
        ok('…and no VIPER-text box (it is not a new document)', !h.asks[0].seed);
        ok('cancel renames nothing', !api.calls.some((c) => c[0] === 'rename'));

        h.askAnswer = { name: 'Original Report' };
        await UI.act('rename', btn({ 'data-wr-name': 'Case Report C-1.docx' }));
        await settle();
        const rn = api.calls.find((c) => c[0] === 'rename');
        ok('main is asked to rename that one report', rn && rn[2] === 'Case Report C-1.docx' && rn[3] === 'Original Report', rn);
        ok('…and the list shows the new name', /data-wr-row="Original Report\.docx"/.test(dom.panel.innerHTML) && !/data-wr-row="Case Report C-1\.docx"/.test(dom.panel.innerHTML));

        api.renameResult = { success: false, code: 'EXISTS', error: 'There is already a report called "Supplemental Report C-1.docx".' };
        h.askAnswer = { name: 'Supplemental Report C-1' };
        await UI.act('rename', btn({ 'data-wr-name': 'Original Report.docx' }));
        await settle();
        ok('a refused rename says why', lastToast(h).t === 'error' && /Could not rename: There is already a report called/.test(lastToast(h).m), lastToast(h));
        ok('…and nothing moved', /data-wr-row="Original Report\.docx"/.test(dom.panel.innerHTML));
        api.renameResult = null;

        delete api.reportDocRename;
        h.asks.length = 0;
        await UI.act('rename', btn({ 'data-wr-name': 'Original Report.docx' }));
        ok('without the restarted main process it says to restart, and asks nothing', /restarted/.test(lastToast(h).m) && h.asks.length === 0);
    }

    // ─────────────────────────────────────────────────────────────────
    console.log('\n[report actions]');
    {
        const UI = fresh();
        const api = fakeApi();
        api.disk['C-1'] = [DOC('Case Report.docx')];
        const h = fakeHost(api, { fmt: 'word' });
        UI.configure(h);
        mount(UI); await settle();
        let html = dom.panel.innerHTML;
        ok('the card has Open, Save a copy, Rename, Replace, Remove',
            /Open in Word/.test(html) && /Save a copy/.test(html) && /act\('rename'/.test(html) && /Replace/.test(html) && /act\('remove'/.test(html));

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
        ok('…and that the other reports are not affected', /Your other reports are not affected/.test(h.confirms[0].m));
        ok('main is told which file to replace', api.calls.some((c) => c[0] === 'import' && c[2] === 'Case Report.docx'));
        ok('the new file takes its place', /data-wr-row="From Desktop\.docx"/.test(dom.panel.innerHTML) && !/data-wr-row="Case Report\.docx"/.test(dom.panel.innerHTML));
        ok('…and the toast says replaced', lastToast(h).t === 'success' && /Report replaced: <b>From Desktop\.docx<\/b>/.test(lastToast(h).m));

        // Replace where the old one could not be binned
        api.importResult = { success: true, fileName: 'Second.docx', replaceError: 'Close "From Desktop.docx" in Word first.' };
        api.disk['C-1'].unshift(DOC('Second.docx', { modifiedAt: '2026-10-05T12:00:00.000Z' }));
        await UI.act('replace', btn({ 'data-wr-name': 'From Desktop.docx' }));
        await settle();
        ok('a replace that kept the old file says so', lastToast(h).t === 'warning' && /old one could not be removed/.test(lastToast(h).m));
        ok('…and both are listed', /data-wr-row="Second\.docx"/.test(dom.panel.innerHTML) && /data-wr-row="From Desktop\.docx"/.test(dom.panel.innerHTML));
        api.importResult = null;
        api.disk['C-1'] = [DOC('Second.docx')];
        await UI.refresh();

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
        ok('removing a report says the others and the VIPER report are not affected', /Your other reports and your VIPER report are not affected/.test(h.confirms[0].m) && h.confirms[0].o.danger === true);
        ok('the report is gone from the list', !/data-wr-row="Second\.docx"/.test(dom.panel.innerHTML));
        ok('…and the empty state returns', /No Word reports yet/.test(dom.panel.innerHTML));
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
        const h = fakeHost(api, { fmt: 'word' });
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
        ok('…and is listed beside the report, which stays', /data-wr-row="Case Report\.docx"/.test(dom.panel.innerHTML) &&
            /data-wr-row="Case Report \(recovered\)\.docx"/.test(dom.panel.innerHTML) && /data-wr-recovered/.test(dom.panel.innerHTML));
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
