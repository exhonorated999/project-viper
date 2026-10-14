/*
 * Phone carrier on phone identifiers — module + the case page's glue.
 *
 * Run: node modules\_shared\__tests__\phone-carrier.test.js
 *
 * The host half is LIFTED out of case-detail-with-analytics.html, not copied.
 * What it pins:
 *   - the carrier lives in `ident.carrier`; `ident.provider` stays the ARIN
 *     ISP and is never labelled "Carrier", and a phone's legacy `provider`
 *     (the old CargoNet import) is shown as the carrier, never as "ISP";
 *   - both Add Identifier modals store the carrier for a phone only;
 *   - the carrier can be changed or removed afterwards, and a failed save
 *     rolls the record back and says so;
 *   - editing a suspect no longer strips platform / ISP / OSINT / carrier
 *     off identifiers the officer did not touch;
 *   - the DA PDF, suspect report and case summary print the right label.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MOD_SRC = fs.readFileSync(path.join(ROOT, 'modules', '_shared', 'phone-carrier.js'), 'utf8');
const PC = require(path.join(ROOT, 'modules', '_shared', 'phone-carrier.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const count = (hay, needle) => hay.split(needle).length - 1;
function slice(startAnchor, endAnchor) {
    const a = HTML.indexOf(startAnchor);
    const b = HTML.indexOf(endAnchor, a + 1);
    if (a < 0 || b < 0) throw new Error('anchor not found: ' + (a < 0 ? startAnchor : endAnchor));
    return HTML.slice(a, b);
}

// ---------------------------------------------------------------- module
console.log('[module]');
ok('suggestions lead with the big three', PC.SUGGESTIONS.slice(0, 3).join('|') === 'AT&T|Verizon|T-Mobile', PC.SUGGESTIONS.slice(0, 3));
ok('suggestions are frozen', Object.isFrozen(PC.SUGGESTIONS));
ok('normalize collapses + trims', PC.normalize('  T-Mobile \n  US ') === 'T-Mobile US');
ok('normalize caps length', PC.normalize('x'.repeat(200)).length === PC.MAX_LEN);
ok('normalize null -> empty', PC.normalize(null) === '' && PC.normalize(undefined) === '');

ok('carrierOf reads carrier on a phone', PC.carrierOf({ type: 'phone', value: '1', carrier: 'Verizon' }) === 'Verizon');
ok('carrierOf reads legacy provider on a phone', PC.carrierOf({ type: 'phone', value: '1', provider: 'AT&T' }) === 'AT&T');
ok('carrier beats legacy provider', PC.carrierOf({ type: 'phone', carrier: 'Visible', provider: 'AT&T' }) === 'Visible');
ok('carrierOf is empty for an IP', PC.carrierOf({ type: 'ip', carrier: 'X', provider: 'Comcast' }) === '');
ok('carrierOf tolerates junk', PC.carrierOf(null) === '' && PC.carrierOf({}) === '');
ok('type match is case-insensitive', PC.carrierOf({ type: 'PHONE', carrier: 'Verizon' }) === 'Verizon');
ok('ispOf reads provider on an IP', PC.ispOf({ type: 'ip', provider: 'Comcast Cable' }) === 'Comcast Cable');
ok('ispOf never labels a phone', PC.ispOf({ type: 'phone', provider: 'Verizon' }) === '');

let id = { type: 'phone', value: '555', provider: 'AT&T' };
PC.setCarrier(id, '  Verizon ');
ok('setCarrier writes carrier and moves legacy provider off', id.carrier === 'Verizon' && id.provider === '', id);
PC.setCarrier(id, '');
ok('setCarrier("") removes the carrier entirely', !('carrier' in id) && PC.carrierOf(id) === '', id);
id = { type: 'phone', value: '555', provider: 'AT&T' };
PC.setCarrier(id, null);
ok('clearing a legacy carrier does not let it reappear', PC.carrierOf(id) === '', id);
const ipId = { type: 'ip', value: '1.2.3.4', provider: 'Comcast' };
PC.setCarrier(ipId, '');
ok('setCarrier never touches an IP\'s ISP', ipId.provider === 'Comcast');
ok('setCarrier(null ident) is safe', PC.setCarrier(null, 'x') === null);

ok('describe phone', PC.describe({ type: 'phone', carrier: 'T-Mobile' }) === 'Carrier: T-Mobile');
ok('describe legacy phone', PC.describe({ type: 'phone', provider: 'Verizon' }) === 'Carrier: Verizon');
ok('describe ip', PC.describe({ type: 'ip', provider: 'Comcast' }) === 'ISP: Comcast');
ok('describe nothing', PC.describe({ type: 'email', value: 'a@b' }) === '');

let b = PC.badgeHtml({ type: 'phone', carrier: 'AT&T <b>' }, { onclick: "editIdentCarrier('victim', 0, 2)" });
ok('badge escapes the carrier', b.includes('AT&amp;T &lt;b&gt;') && !b.includes('<b>'), b);
ok('badge is a button carrying the host onclick', /^<button/.test(b) && b.includes('onclick="editIdentCarrier(&#39;victim&#39;, 0, 2)"'), b);
b = PC.badgeHtml({ type: 'phone', value: '1' }, { onclick: 'x()' });
ok('no carrier + editable -> "+ Carrier" button', b.includes('+ Carrier') && b.includes('pc-add'), b);
ok('no carrier + read-only -> nothing', PC.badgeHtml({ type: 'phone', value: '1' }, {}) === '');
ok('read-only badge is a span', /^<span/.test(PC.badgeHtml({ type: 'phone', carrier: 'Verizon' })));
ok('non-phone -> no badge', PC.badgeHtml({ type: 'ip', provider: 'Comcast' }, { onclick: 'x()' }) === '');
ok('small badge uses the small size', PC.badgeHtml({ type: 'phone', carrier: 'V' }, { small: true }).includes('text-[10px]'));

const dl = PC.datalistHtml();
ok('datalist has every suggestion', count(dl, '<option ') === PC.SUGGESTIONS.length && dl.includes('id="viperPhoneCarriers"'));
ok('datalist escapes AT&T', dl.includes('value="AT&amp;T"'));

let built = PC.buildIdentifier('phone', '555', { carrier: 'Verizon', platform: 'Snap' });
ok('buildIdentifier phone: carrier, no platform', built.carrier === 'Verizon' && !('platform' in built) && built.provider === '', built);
built = PC.buildIdentifier('username', 'bob', { carrier: 'Verizon', platform: 'Snapchat' });
ok('buildIdentifier username: platform, no carrier', built.platform === 'Snapchat' && !('carrier' in built), built);
built = PC.buildIdentifier('phone', '555', {});
ok('buildIdentifier phone without carrier stays clean', !('carrier' in built), built);

// ensureDatalist on a fake document
function fakeDoc() {
    const byId = {};
    const body = { children: [], appendChild(n) { this.children.push(n); if (n.id) byId[n.id] = n; } };
    return {
        body, byId,
        getElementById: (k) => byId[k] || null,
        createElement: () => {
            const w = { _html: '', firstChild: null };
            Object.defineProperty(w, 'innerHTML', { set(v) { w._html = v; const m = /id="([^"]+)"/.exec(v); w.firstChild = { id: m && m[1], html: v }; }, get() { return w._html; } });
            return w;
        },
    };
}
const d = fakeDoc();
ok('ensureDatalist appends once', PC.ensureDatalist(d) === true && d.body.children.length === 1);
PC.ensureDatalist(d);
ok('ensureDatalist is idempotent', d.body.children.length === 1);
ok('ensureDatalist without a document is a no-op', PC.ensureDatalist({}) === false);

// syncTypeRows / syncRow
function el(display) { return { style: { display } }; }
const plat = el('none'), carr = el('none');
const form = { querySelector: (q) => q === '[data-ident-platform-row]' ? plat : q === '[data-ident-carrier-row]' ? carr : null };
PC.syncTypeRows({ value: 'phone', form });
ok('phone shows carrier, hides platform', carr.style.display === '' && plat.style.display === 'none');
PC.syncTypeRows({ value: 'username', form });
ok('username shows platform, hides carrier', plat.style.display === '' && carr.style.display === 'none');
PC.syncTypeRows({ value: 'email', form });
ok('email hides both', plat.style.display === 'none' && carr.style.display === 'none');
const rowCarr = el('none');
const row = { querySelector: (q) => q === '.ident-carrier' ? rowCarr : null };
PC.syncRow({ value: 'phone', closest: () => row });
ok('edit-form row shows its carrier input for phone', rowCarr.style.display === '');
PC.syncRow({ value: 'ip', closest: () => row });
ok('edit-form row hides it otherwise', rowCarr.style.display === 'none');

// mergeEditedIdentifiers
const originals = [
    { type: 'username', value: 'bob', provider: '', platform: 'Snapchat', osint: { results: [1] }, source: 'CyberTip' },
    { type: 'ip', value: '1.2.3.4', provider: 'Comcast' },
    { type: 'phone', value: '555-1212', provider: '', carrier: 'Verizon' },
    { type: 'email', value: 'a@b.c', provider: '', emailResult: { valid: true, status: 'ok' } },
    { type: 'phone', value: '555-9999', provider: 'AT&T' },
];
let merged = PC.mergeEditedIdentifiers(originals, [
    { orig: '0', type: 'username', value: 'bob' },
    { orig: '1', type: 'ip', value: '1.2.3.4' },
    { orig: '2', type: 'phone', value: '555-1212', carrier: 'Verizon' },
    { orig: '3', type: 'email', value: 'a@b.c ' },
    { orig: null, type: 'phone', value: '777', carrier: 'T-Mobile' },
    { orig: null, type: 'email', value: '   ' },
]);
ok('untouched username keeps platform, OSINT and source', merged[0].platform === 'Snapchat' && merged[0].osint && merged[0].source === 'CyberTip', merged[0]);
ok('untouched IP keeps its ISP', merged[1].provider === 'Comcast', merged[1]);
ok('untouched phone keeps its carrier', merged[2].carrier === 'Verizon', merged[2]);
ok('untouched email keeps its check (value trimmed)', merged[3].emailResult && merged[3].emailResult.status === 'ok', merged[3]);
ok('new phone row gets its carrier', merged[4].carrier === 'T-Mobile' && merged[4].provider === '', merged[4]);
ok('blank rows are dropped', merged.length === 5, merged.length);
ok('merge does not mutate the originals', originals[0].osint && !('carrier' in originals[1]));
merged[0].osint.results.push(2);
ok('merged copies are deep', originals[0].osint.results.length === 1);

merged = PC.mergeEditedIdentifiers(originals, [
    { orig: 0, type: 'username', value: 'bob2' },
    { orig: 1, type: 'ip', value: '5.6.7.8' },
    { orig: 2, type: 'phone', value: '555-1212', carrier: '' },
    { orig: 3, type: 'phone', value: 'a@b.c', carrier: 'Visible' },
    { orig: 4, type: 'phone', value: '555-9999' },
]);
ok('changed username keeps platform, drops OSINT', merged[0].platform === 'Snapchat' && !merged[0].osint, merged[0]);
ok('changed IP drops the stale ISP', merged[1].provider === '', merged[1]);
ok('blanked carrier is removed', !('carrier' in merged[2]), merged[2]);
ok('type changed email->phone drops the email check, takes carrier', !merged[3].emailResult && merged[3].carrier === 'Visible', merged[3]);
ok('legacy phone with no carrier input migrates provider -> carrier', merged[4].carrier === 'AT&T' && merged[4].provider === '', merged[4]);
merged = PC.mergeEditedIdentifiers(originals, [{ orig: 2, type: 'email', value: 'x@y.z' }]);
ok('phone changed to email loses its carrier', !('carrier' in merged[0]), merged[0]);
ok('bad orig index treated as new', PC.mergeEditedIdentifiers(originals, [{ orig: 99, type: 'phone', value: '1', carrier: 'V' }])[0].carrier === 'V');
ok('null inputs are safe', Array.isArray(PC.mergeEditedIdentifiers(null, null)));

// UMD: must land on BOTH module.exports and the global (THE UMD TRAP)
{
    const env = { module: { exports: {} } };
    env.globalThis = env; env.window = env;
    vm.createContext(env);
    vm.runInContext(MOD_SRC, env);
    ok('UMD assigns the global even when module exists', !!env.PhoneCarrier && !!env.module.exports.carrierOf);
}

// ---------------------------------------------------------------- host wiring
console.log('[host wiring]');
const tagAt = HTML.indexOf('<script src="modules/_shared/phone-carrier.js"></script>');
ok('script tag present, synchronous', tagAt > 0 && count(HTML, 'modules/_shared/phone-carrier.js"') === 1);
ok('script tag loads before the page script', tagAt < HTML.indexOf('function renderPeopleIdentifiersSection('));
ok('both add modals toggle via syncTypeRows', count(HTML, 'onchange="PhoneCarrier.syncTypeRows(this)"') === 2);
ok('both add modals have a carrier row', count(HTML, '<div data-ident-carrier-row style="display:none;">') === 2);
ok('both add modals store the carrier for a phone', count(HTML, "if (type === 'phone' && window.PhoneCarrier) PhoneCarrier.setCarrier(ident, fd.get('carrier'));") === 2);
ok('edit-form rows toggle the carrier input', count(HTML, 'onchange="PhoneCarrier.syncRow(this)"') === 2);
ok('edit-form existing rows carry their original index', HTML.includes('data-ident-row="${i}" data-ident-orig="${i}"'));
ok('suspect save passes the originals', HTML.includes('identifiers: collectSuspectIdentifiers(isEdit ? suspect.identifiers : null),'));
ok('no view labels provider as ISP directly any more', !/ident\.provider \? `<span[^`]*ISP:/.test(HTML));
ok('DA PDF identifiers table uses the label helper', HTML.includes("_identProviderLabel(r) || (r.status || '')"));
ok('suspect report uses the label helper', HTML.includes('${escHtmlSafe(_identProviderLabel(id))}${id.emailResult'));
ok('case summary uses the label helper', HTML.includes("if (provLbl) extra += ' — ' + escHtmlSafe(provLbl);"));
ok('CargoNet import writes carrier, not provider', INDEX.includes("Object.assign({ type: 'phone', value: d.phone, provider: '' }, d.phoneCarrier ? { carrier:") && !INDEX.includes("provider: d.phoneCarrier"));

// ---------------------------------------------------------------- lifted host functions
function makeEnv(over) {
    const env = {
        console, Object, String, JSON, Number, Array,
        currentCase: { id: 'c1', caseNumber: '24-1' },
        log: [], toasts: [],
        storage: {},
        saveThrows: false,
        victims: [], witnesses: [], involvedPersons: [],
        suspects: [],
    };
    env.localStorage = {
        getItem: (k) => (k in env.storage ? env.storage[k] : null),
        setItem: (k, v) => { if (env.saveThrows) throw new Error('QuotaExceededError'); env.storage[k] = v; env.log.push(['setItem', k]); },
    };
    env._lsParse = (k, def) => { try { const v = env.localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (_) { return def; } };
    env.saveSuspects = () => { env.localStorage.setItem('suspects_c1', JSON.stringify(env.suspects)); };
    env.renderTabContent = (t) => env.log.push(['render', t]);
    env.showToast = (m, k) => env.toasts.push([k, m]);
    env._osintHeaderBtn = () => '';
    env._osintIdentBadgeHtml = () => '';
    env._p2pScanBtn = () => '';
    env.module = { exports: {} };
    env.window = env; env.globalThis = env;
    Object.assign(env, over || {});
    vm.createContext(env);
    vm.runInContext(MOD_SRC, env);
    vm.runInContext(slice('        function escHtmlSafe(s) {', '        async function renderDatapilotEvidenceViewer('), env);
    vm.runInContext(slice('        function renderPeopleIdentifiersSection(record, kind, index) {', '        // ============================================================\n        // P2P Activity Check'), env);
    vm.runInContext(slice('        function _ppGetList(kind) {', '        function removePersonIdentifier('), env);
    vm.runInContext(slice('        function addPersonIdentifierInline(kind, index) {', '        // ============================================================\n        // OSINT username search'), env);
    vm.runInContext(slice('        function _osintPersonCtx(kind, index) {', '        // Identifiers eligible for a username hunt'), env);
    vm.runInContext(slice('        function _identIspBadge(ident, small) {', '        function addSuspectIdentifierRow() {'), env);
    vm.runInContext(slice('        function collectSuspectIdentifiers(originals) {', '        async function arinLookupSuspectIdent('), env);
    return env;
}

// A tiny DOM: enough for the modals (createElement / getElementById / body).
function installDom(env) {
    const nodes = {};
    const mkInput = (v) => ({ value: v, focus() {}, select() {} });
    env.document = {
        body: { appendChild(n) { env._modal = n; } },
        getElementById: (k) => nodes[k] || null,
        createElement: () => {
            const n = { id: '', className: '', removed: false, remove() { this.removed = true; if (n.id) delete nodes[n.id]; } };
            let html = '';
            Object.defineProperty(n, 'innerHTML', {
                get: () => html,
                set: (v) => {
                    html = v;
                    const fm = /<form id="([^"]+)"/.exec(v);
                    if (fm) nodes[fm[1]] = n.form = { id: fm[1], onsubmit: null };
                    const cv = /name="carrier"[^>]*value="([^"]*)"/.exec(v);
                    n.carrierInput = mkInput(cv ? cv[1] : '');
                },
            });
            n.querySelector = (q) => (q === 'input[name="carrier"]' ? n.carrierInput : null);
            const origSetId = (v) => { n._id = v; nodes[v] = n; };
            Object.defineProperty(n, 'id', { get: () => n._id || '', set: origSetId });
            return n;
        },
        querySelectorAll: () => env._rows || [],
    };
    env.FormData = function (target) { this.get = (k) => (target.values[k] === undefined ? null : target.values[k]); };
    env.PhoneCarrier.ensureDatalist = () => true; // datalist itself is covered above
}

console.log('[render]');
{
    const env = makeEnv();
    const rec = { name: 'V', identifiers: [
        { type: 'phone', value: '555-1212', provider: '', carrier: 'Verizon' },
        { type: 'phone', value: '555-0000', provider: 'AT&T' },
        { type: 'phone', value: '555-3333', provider: '' },
        { type: 'ip', value: '1.2.3.4', provider: 'Comcast' },
    ] };
    const html = env.renderPeopleIdentifiersSection(rec, 'victim', 4);
    ok('phone row shows the carrier badge', html.includes('📶 Verizon'));
    ok('carrier badge opens the editor for THIS row', html.includes('editIdentCarrier(&#39;victim&#39;, 4, 0)'), html.match(/editIdentCarrier[^"]*/g));
    ok('legacy phone provider shows as carrier, NOT as ISP', html.includes('📶 AT&amp;T') && !html.includes('ISP: AT&amp;T'));
    ok('phone without a carrier offers "+ Carrier"', html.includes('editIdentCarrier(&#39;victim&#39;, 4, 2)') && html.includes('+ Carrier'));
    ok('IP keeps its ISP badge', html.includes('ISP: Comcast'));
    ok('IP gets no carrier control', !html.includes('editIdentCarrier(&#39;victim&#39;, 4, 3)'));
    const dangerous = env._identCarrierBadge("x');alert(1);//", 0, 0, { type: 'phone', carrier: 'V' }, true);
    ok('kind is sanitised into the onclick', !dangerous.includes('alert(1)') && dangerous.includes('editIdentCarrier(&#39;xalert&#39;, 0, 0)'), dangerous);
}

console.log('[add modal]');
{
    const env = makeEnv();
    env.storage['witnesses_c1'] = JSON.stringify([{ name: 'W', identifiers: [] }]);
    installDom(env);
    env.addPersonIdentifierInline('witness', 0);
    const f = env.document.getElementById('addPersonIdentForm');
    ok('modal form mounted', !!(f && f.onsubmit));
    f.onsubmit({ preventDefault() {}, target: { values: { type: 'phone', value: ' 555-1212 ', carrier: ' T-Mobile ', platform: 'Snap' } } });
    let saved = JSON.parse(env.storage['witnesses_c1'])[0].identifiers;
    ok('phone saved with carrier', saved.length === 1 && saved[0].carrier === 'T-Mobile' && saved[0].value === '555-1212', saved);
    ok('phone saved without a platform', !('platform' in saved[0]));
    env.addPersonIdentifierInline('witness', 0);
    env.document.getElementById('addPersonIdentForm').onsubmit({ preventDefault() {}, target: { values: { type: 'email', value: 'a@b.c', carrier: 'Verizon' } } });
    saved = JSON.parse(env.storage['witnesses_c1'])[0].identifiers;
    ok('a carrier typed then type switched away is NOT stored on an email', saved[1].type === 'email' && !('carrier' in saved[1]), saved[1]);
    env.addPersonIdentifierInline('witness', 0);
    env.document.getElementById('addPersonIdentForm').onsubmit({ preventDefault() {}, target: { values: { type: 'phone', value: '777', carrier: '' } } });
    saved = JSON.parse(env.storage['witnesses_c1'])[0].identifiers;
    ok('carrier is optional', saved[2].value === '777' && !('carrier' in saved[2]), saved[2]);
}

console.log('[edit carrier]');
{
    const env = makeEnv();
    env.suspects = [{ name: 'S', identifiers: [{ type: 'phone', value: '555', provider: 'AT&T' }, { type: 'ip', value: '1.2.3.4', provider: 'Comcast' }] }];
    installDom(env);
    env.editIdentCarrier('suspect', 0, 0);
    let m = env._modal;
    ok('editor pre-fills the current (legacy) carrier', m && m.carrierInput.value === 'AT&amp;T', m && m.carrierInput.value);
    m.carrierInput.value = 'Verizon';
    env.document.getElementById('identCarrierForm').onsubmit({ preventDefault() {} });
    let s = JSON.parse(env.storage['suspects_c1'])[0].identifiers[0];
    ok('changed carrier is saved', s.carrier === 'Verizon' && s.provider === '', s);
    ok('suspects tab re-rendered', env.log.some((l) => l[0] === 'render' && l[1] === 'suspects'));
    ok('success toast names the carrier', env.toasts.some((t) => t[0] === 'success' && t[1] === 'Carrier set: Verizon'), env.toasts);
    ok('modal closed', m.removed === true);

    env.editIdentCarrier('suspect', 0, 0);
    m = env._modal;
    m.carrierInput.value = '';
    env.document.getElementById('identCarrierForm').onsubmit({ preventDefault() {} });
    s = JSON.parse(env.storage['suspects_c1'])[0].identifiers[0];
    ok('blank removes the carrier', !('carrier' in s), s);
    ok('removal toast', env.toasts.some((t) => t[1] === 'Carrier removed'));

    // Failed save: record rolled back, error shown, modal stays open.
    env.suspects[0].identifiers[0].carrier = 'Visible';
    env.saveThrows = true;
    env.toasts.length = 0;
    env.editIdentCarrier('suspect', 0, 0);
    m = env._modal;
    m.carrierInput.value = 'Cricket Wireless';
    env.document.getElementById('identCarrierForm').onsubmit({ preventDefault() {} });
    ok('failed save rolls the in-memory record back', env.suspects[0].identifiers[0].carrier === 'Visible', env.suspects[0].identifiers[0]);
    ok('failed save says so', env.toasts.some((t) => t[0] === 'error' && /NOT saved/.test(t[1])), env.toasts);
    ok('failed save leaves the editor open', m.removed === false);
    ok('failed save reports no success', !env.toasts.some((t) => t[0] === 'success'));
    env.saveThrows = false;

    const before = env._modal;
    env.editIdentCarrier('suspect', 0, 1);
    ok('no editor for an IP identifier', env._modal === before);
    env.editIdentCarrier('suspect', 9, 0);
    ok('no editor for a missing record', env._modal === before);

    // Victim path goes through the shared people store.
    env.storage['victims_c1'] = JSON.stringify([{ name: 'V', identifiers: [{ type: 'phone', value: '1', provider: '' }] }]);
    env.editIdentCarrier('victim', 0, 0);
    env._modal.carrierInput.value = 'Google Voice';
    env.document.getElementById('identCarrierForm').onsubmit({ preventDefault() {} });
    ok('victim carrier saved to victims_<caseId>', JSON.parse(env.storage['victims_c1'])[0].identifiers[0].carrier === 'Google Voice');
    ok('victims tab re-rendered', env.log.some((l) => l[0] === 'render' && l[1] === 'victims'));
}

console.log('[suspect edit form]');
{
    const env = makeEnv();
    installDom(env);
    const mkRow = (orig, type, value, carrier) => ({
        hasAttribute: (a) => a === 'data-ident-orig' && orig != null,
        getAttribute: (a) => (a === 'data-ident-orig' ? String(orig) : null),
        querySelector: (q) => q === '.ident-type' ? { value: type } : q === '.ident-value' ? { value } : q === '.ident-carrier' ? (carrier === undefined ? null : { value: carrier }) : null,
    });
    const originals = [
        { type: 'username', value: 'bob', provider: '', platform: 'Snapchat', osint: { results: [{ site: 'x' }] } },
        { type: 'phone', value: '555', provider: '', carrier: 'Verizon' },
    ];
    env._rows = [mkRow(0, 'username', 'bob', ''), mkRow(1, 'phone', '555', 'Verizon'), mkRow(null, 'phone', '999', 'AT&T')];
    const out = env.collectSuspectIdentifiers(originals);
    ok('edit keeps the platform and OSINT the form never shows', out[0].platform === 'Snapchat' && out[0].osint && out[0].osint.results.length === 1, out[0]);
    ok('edit keeps the carrier', out[1].carrier === 'Verizon');
    ok('new row in the edit form gets its carrier', out[2].carrier === 'AT&T' && out[2].value === '999');
    ok('new suspect (no originals) works', env.collectSuspectIdentifiers(null).length === 3);
}

console.log('[exports]');
{
    const env = makeEnv();
    ok('label: phone', env._identProviderLabel({ type: 'phone', carrier: 'Verizon' }) === 'Carrier: Verizon');
    ok('label: ip', env._identProviderLabel({ type: 'ip', provider: 'Comcast' }) === 'ISP: Comcast');
    ok('label: none', env._identProviderLabel({ type: 'email' }) === '');
    // Pull the DA PDF row mapper's 4th column out of identifiersTable.
    const tbl = slice('            function identifiersTable(rows) {', "                    theme: 'grid',");
    ok('DA PDF column 4 prints the carrier for a phone', tbl.includes("_identProviderLabel(r) || (r.status || '')"));
    ok('DA PDF header unchanged', tbl.includes("'Provider / Status'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
