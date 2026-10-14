/*
 * Word Report — the case page's half (lifted, not copied).
 *
 * Run: node modules\reports\__tests__\word-report-host.test.js
 *
 * Slices the shipping glue out of case-detail-with-analytics.html and runs
 * it against the real word-report-ui.js. What it pins:
 *   - the choice is stored on the CASE RECORD (reportFormat), never in
 *     viperCaseReports, and a failed saveCase() rolls it back; the 5.4.0
 *     "chosen report" field (reportWordName) is no longer wired in — every
 *     Word file in the case is a report (5.4.1);
 *   - Word mode replaces the editor; VIPER mode keeps the editor and shows
 *     the switch; nothing is deleted by switching;
 *   - the export dialog and the DA PDF both say the Word reports are not
 *     included, and the PDF does NOT print the set-aside VIPER text.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const UI_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'reports', 'word-report-ui.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
function slice(startAnchor, endAnchor) {
    const a = HTML.indexOf(startAnchor);
    const b = HTML.indexOf(endAnchor, a + 1);
    if (a < 0 || b < 0) throw new Error('anchor not found: ' + (a < 0 ? startAnchor : endAnchor));
    return HTML.slice(a, b);
}

function makeEnv(over) {
    const env = {
        console, setTimeout, clearTimeout, Promise, Object, String, JSON, Date,
        currentCase: { id: 'id1', caseNumber: '24-1', modules: ['reports'] },
        caseReport: '<p>VIPER narrative text.</p>',
        reportLastSaved: null,
        currentTab: 'reports',
        log: [],
        saveOk: true,
        storage: { viperCaseReports: JSON.stringify({ '24-1': { content: '<p>VIPER narrative text.</p>' } }) },
        document: { getElementById: () => null },
    };
    env.saveCase = (o) => { env.log.push(['saveCase', o && o.silent, JSON.parse(JSON.stringify(env.currentCase))]); return env.saveOk; };
    env.saveReport = (s) => { env.log.push(['saveReport', s]); };
    env.renderTabContent = (t) => { env.log.push(['renderTabContent', t]); };
    env.localStorage = { getItem: (k) => env.storage[k] || null, setItem: (k, v) => { env.log.push(['setItem', k]); env.storage[k] = v; } };
    env.module = { exports: {} };
    env.window = env; env.globalThis = env;
    Object.assign(env, over || {});
    vm.createContext(env);
    vm.runInContext(UI_SRC, env);
    vm.runInContext(slice('        function _reportIsWord() {', '        function initializeReportEditor() {'), env);
    return env;
}

(async () => {
    console.log('\n[the tab]');
    {
        const env = makeEnv();
        const html = env.renderReportsTab();
        ok('a case with no choice opens in the VIPER editor', /id="reportEditor"/.test(html));
        ok('…with the switch under the title', /id="wrModeSwitch"/.test(html) && /data-wr-mode="viper" aria-pressed="true"/.test(html));
        ok('…and the VIPER text in the editor', html.indexOf('VIPER narrative text.') !== -1);

        env.currentCase.reportFormat = 'word';
        const w = env.renderReportsTab();
        ok('Word mode replaces the editor with the Word panel', /id="wrPanel"/.test(w) && !/id="reportEditor"/.test(w));
        ok('…carrying the export disclaimer', w.indexOf('Not included in Export to DA') !== -1);
        ok('…and never prints the set-aside VIPER text', w.indexOf('VIPER narrative text.') === -1);
        const glue = slice('        function _reportIsWord() {', '        function initializeReportEditor() {');
        ok('the page no longer hands the module a "chosen report" field', !/getWordName\s*:|setWordName\s*:/.test(glue));
    }

    console.log('\n[switching]');
    {
        const env = makeEnv();
        env.renderReportsTab();
        const UI = env.WordReportUI;
        // host.confirm is not passed by the page; viperConfirm is the channel.
        env.viperConfirm = async () => true;
        await UI.act('mode-word');
        ok('the VIPER editor is saved first (silently)', env.log[0] && env.log[0][0] === 'saveReport' && env.log[0][1] === true, env.log[0]);
        const sc = env.log.find((l) => l[0] === 'saveCase');
        ok('the choice is written to the case record, silently', sc && sc[1] === true && sc[2].reportFormat === 'word');
        ok('viperCaseReports is not touched by the switch', !env.log.some((l) => l[0] === 'setItem'));
        ok('the tab re-renders through renderTabContent', env.log.some((l) => l[0] === 'renderTabContent' && l[1] === 'reports'));
        ok('the VIPER text is still stored', JSON.parse(env.storage.viperCaseReports)['24-1'].content === '<p>VIPER narrative text.</p>');

        env.log.length = 0;
        await UI.act('mode-viper');
        ok('back to VIPER', env.currentCase.reportFormat === 'viper');
    }
    {
        const env = makeEnv({ saveOk: false });
        env.renderReportsTab();
        env.viperConfirm = async () => true;
        let toasted = '';
        env.viperToast = (m) => { toasted = m; };
        const r = await env.WordReportUI.act('mode-word');
        ok('a case save that fails rolls the choice back', r === false && !('reportFormat' in env.currentCase), env.currentCase);
        ok('…says so', /Could not save the change/.test(toasted));
        ok('…and does not re-render', !env.log.some((l) => l[0] === 'renderTabContent'));
    }
    {
        const env = makeEnv();
        env.currentCase.reportFormat = 'word';
        env.currentCase.reportWordName = 'Old.docx';
        env.saveOk = false;
        ok('a failed name write keeps the old name', env._setCaseReportField('reportWordName', 'New.docx') === false && env.currentCase.reportWordName === 'Old.docx');
        env.saveOk = true;
        ok('clearing the name removes the field', env._setCaseReportField('reportWordName', null) === true && !('reportWordName' in env.currentCase));
        env.currentTab = 'notes';
        env.log.length = 0;
        // A rerender after the officer has left the tab must not paint Reports over another tab.
        env.viperConfirm = async () => true;
        env.renderReportsTab();      // configure the module with this env
        const r = await env.WordReportUI.act('mode-viper', null, null);
        ok('the switch itself still lands', r === true && env.currentCase.reportFormat === 'viper');
        ok('a switch finishing after the officer left the tab paints nothing', !env.log.some((l) => l[0] === 'renderTabContent'));
    }

    console.log('\n[export dialog and the DA PDF]');
    {
        const modal = slice('        function openExportCaseModal(', '<div class="bg-viper-card/30 border border-viper-cyan/20 rounded-lg p-4 text-sm text-gray-300">');
        ok('the reports row is tagged "Word reports not included" in Word mode',
            /tabId === 'reports' && _reportIsWord\(\) \? '<span[^']*>Word reports not included<\/span>'/.test(modal));
        const info = slice('<li>All exports will be saved as a ZIP file for easy sharing</li>', '</ul>');
        ok('the export notes say the Word reports are not included, why, and to send each one',
            /_reportIsWord\(\)/.test(info) && /are written in Microsoft Word and are not included\./.test(info) &&
            /cannot convert a Word document into its report format/.test(info) && /on each report on the Reports tab/.test(info));

        const pdf = slice('                case \'reports\': {\n                    // A Word report', '                case \'opsplan\': {');
        ok('the DA PDF checks Word mode before reading viperCaseReports',
            pdf.indexOf('_reportIsWord()') !== -1 && pdf.indexOf('_reportIsWord()') < pdf.indexOf("viperCaseReports"));
        // Run the branch against a fake jsPDF.
        const printed = [];
        const env = {
            currentCase: { reportFormat: 'word', caseNumber: '24-1' }, caseNum: '24-1', y: 30, M: 20, CW: 170, LGRAY: [1, 1, 1],
            need: () => {}, emptyMsg: (m) => printed.push(['empty', m]),
            renderReportHtml: async (h) => printed.push(['html', h]),
            _lsParse: () => ({ '24-1': { content: '<p>VIPER narrative text.</p>' } }),
            doc: { setFontSize() {}, setFont() {}, setTextColor() {}, splitTextToSize: (t) => [t], text: (t) => printed.push(['text', [].concat(t).join(' ')]) },
        };
        env._reportIsWord = () => !!(env.currentCase && env.currentCase.reportFormat === 'word');
        vm.createContext(env);
        const body = '(async () => { switch ("reports") {\n' + pdf + '\n} })()';
        await vm.runInContext(body, env);
        ok('Word mode: the PDF says the reports were written in Word and are provided separately',
            printed.some((p) => p[0] === 'text' && /written in Microsoft Word and are provided separately/.test(p[1])), printed);
        ok('…and does not print the VIPER text', !printed.some((p) => p[0] === 'html'));
        printed.length = 0;
        env.currentCase.reportFormat = 'viper';
        await vm.runInContext(body, env);
        ok('VIPER mode: the PDF prints the VIPER report as before', printed.length === 1 && printed[0][0] === 'html' && /VIPER narrative/.test(printed[0][1]));
    }

    console.log('\n[asset tag]');
    {
        const iWd = HTML.indexOf('<script src="modules/warrants/working-docs-ui.js"></script>');
        const iWr = HTML.indexOf('<script src="modules/reports/word-report-ui.js"></script>');
        ok('the module is loaded by the case page, synchronously', iWr > 0 && iWr > iWd && !/word-report-ui\.js"\s+defer/.test(HTML));
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
