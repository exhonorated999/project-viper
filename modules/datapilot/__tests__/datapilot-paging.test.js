/*
 * datapilot-paging — every record in an extraction must be reachable.
 *
 * Run:
 *   set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd modules\datapilot\__tests__\datapilot-paging.test.js
 *
 * Bug report: the Artifacts view only ever showed the first 300 media items
 * ("refine filters to narrow") with no way to see the rest. The same kind of
 * hard cap sat on All Contacts (300), the Movement photo strip (40), carved
 * fragments per deleted record (40) and photo thumbnails (only the first 120
 * cards were ever filled). These tests pin paging / show-more for each.
 * Every identifier below is invented.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const section = (s) => console.log('\n[' + s + ']');

const N_MEDIA = 750;
const N_CONTACTS = 700;

function makeImport() {
    const media = [];
    for (let i = 1; i <= N_MEDIA; i++) {
        media.push({ no: i, sha256: 'sha' + String(i).padStart(5, '0'), fileName: 'IMG_' + i + '.jpg', mediaType: i % 10 === 0 ? 'video' : 'photo', fileSystemPath: 'FileSystem/IMG_' + i + '.jpg', sizeBytes: 1000 });
    }
    const contacts = [];
    for (let i = 1; i <= N_CONTACTS; i++) contacts.push({ no: i, name: 'Person ' + i, phones: ['+1720555' + String(i).padStart(4, '0')] });
    const records = [];
    for (let i = 1; i <= 100; i++) records.push({ id: i, offset: i * 10, size: 5, text: 'fragment text ' + i });
    return {
        id: 'imp-1', fileName: 'TEST-EXTRACTION', format: 'dpx', timeFixVersion: 1,
        deviceInfo: { make: 'Apple', model: 'iPhone', phoneNumber: '' },
        contacts, messages: [], calls: [], media, files: [], apps: [],
        deleted: [{ no: 1, label: 'sms.db', records, textFound: 100 }],
        photoExifByHash: {},
        flagged: { contacts: [], messages: [], calls: [], calendar: [], apps: [], media: [], files: [] },
    };
}

const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    setTimeout, clearTimeout, Promise, JSON, Date, Intl, Math, Map, Set, WeakMap,
    viperConfirm: async () => true,
    showToast: () => {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.electronAPI = {
    datapilotLoadData: async () => ({ success: true, data: JSON.stringify({ imports: [makeImport()] }) }),
    datapilotSaveData: async () => ({ success: true }),
};
vm.createContext(sandbox);
for (const f of ['datapilot-time.js', 'datapilot-analytics.js', 'datapilot-ui.js', 'datapilot-module.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const cardIds = (html) => (html.match(/data-dp-art-id="([^"]+)"/g) || []).map(s => s.slice(16, -1));
const rangeOf = (html) => { const m = /Showing <strong>([\d,]+)–([\d,]+)<\/strong> of ([\d,]+)/.exec(html); return m ? [m[1], m[2], m[3]].join('|') : ''; };
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
    const mod = new sandbox.DatapilotModule('case-1', 'CN-1', 'Test');
    await mod.loadData();
    let renders = 0;
    mod.render = () => { renders++; };
    const ui = new sandbox.DatapilotUI(mod);
    const imp = mod.getActiveImport();
    const total = N_MEDIA + 1; // + the deleted record

    section('Artifacts grid pages instead of stopping at 300');
    let html = ui._renderArtifacts(imp);
    ok('page 1 shows 300 cards', cardIds(html).length === 300, cardIds(html).length);
    ok('the old dead-end note is gone', !/Showing first|refine filters to narrow/.test(html));
    ok('a pager says 1–300 of ' + total, rangeOf(html) === '1|300|' + total, rangeOf(html));
    ok('pager has Next / Last and a page box "of 3"', /data-dp-page-go="next"/.test(html) && /data-dp-page-go="last"/.test(html) && /data-dp-page-input[^>]*max="3"/.test(html) && /of 3<\/span>/.test(html));
    ok('Prev / First are disabled on page 1', /data-dp-page-go="prev" disabled/.test(html) && /data-dp-page-go="first" disabled/.test(html));
    ok('per-page choices include All', /<option value="0"[^>]*>All<\/option>/.test(html) && /<option value="300" selected>/.test(html));

    const seen = new Set(cardIds(html));
    ui.pages.artifacts.page = 2;
    html = ui._renderArtifacts(imp);
    cardIds(html).forEach(id => seen.add(id));
    ok('page 2 shows 301–600', rangeOf(html) === '301|600|' + total, rangeOf(html));
    ui.pages.artifacts.page = 3;
    html = ui._renderArtifacts(imp);
    cardIds(html).forEach(id => seen.add(id));
    ok('page 3 shows the remaining ' + (total - 600), cardIds(html).length === total - 600 && rangeOf(html) === '601|' + total + '|' + total, rangeOf(html));
    ok('Next / Last disabled on the last page', /data-dp-page-go="next" disabled/.test(html) && /data-dp-page-go="last" disabled/.test(html));
    ok('every artifact is reachable across the pages (no duplicates)', seen.size === total, seen.size);
    ok('the last media item is reachable', seen.has('sha' + String(N_MEDIA).padStart(5, '0')));

    ui.pages.artifacts.page = 99;
    html = ui._renderArtifacts(imp);
    ok('an out-of-range page is clamped to the last page', ui.pages.artifacts.page === 3 && rangeOf(html).startsWith('601|'), ui.pages.artifacts.page);

    ui.pages.artifacts.size = 0;
    html = ui._renderArtifacts(imp);
    ok('"All" per page shows every artifact at once', cardIds(html).length === total, cardIds(html).length);
    ok('"All" shows no page buttons', !/data-dp-page-go=/.test(html) && /<option value="0" selected>All/.test(html));

    ui.pages.artifacts.size = 120; ui.pages.artifacts.page = 4;
    html = ui._renderArtifacts(imp);
    ok('120 per page, page 4 → 361–480', rangeOf(html) === '361|480|' + total, rangeOf(html));
    ui.artifactsState.type = 'video';
    html = ui._renderArtifacts(imp);
    ok('changing a filter goes back to page 1', ui.pages.artifacts.page === 1, ui.pages.artifacts.page);
    ok('75 videos fit one 120-page → no pager nav', cardIds(html).length === 75 && !/data-dp-page-go=/.test(html), cardIds(html).length);
    ui.artifactsState.type = null;
    ui.pages.artifacts.size = 300;

    section('small lists show no pager');
    ui.artifactsState.search = 'IMG_75';  // IMG_75, IMG_750
    html = ui._renderArtifacts(imp);
    ok('2 matches → no pager bar', cardIds(html).length === 2 && !/data-dp-pager=/.test(html), cardIds(html).length);
    ui.artifactsState.search = '';

    section('All Contacts pages instead of stopping at 300');
    ui.subjectState.contactSearch = '';
    html = ui._renderAllContactsCard(ui._buildContactIndex(imp));
    const rows = (h) => (h.match(/data-dp-contact="/g) || []).length;
    ok('page 1 shows 300 contacts', rows(html) === 300, rows(html));
    ok('no "(showing first 300)"', !/showing first/i.test(html));
    ok('pager says 1–300 of 700 contacts', /Showing <strong>1–300<\/strong> of 700 contacts/.test(html));
    ui.pages.contacts.page = 3;
    html = ui._renderAllContactsCard(ui._buildContactIndex(imp));
    ok('page 3 shows the last 100', rows(html) === 100, rows(html));
    ui.subjectState.contactSearch = 'person 69';
    html = ui._renderAllContactsCard(ui._buildContactIndex(imp));
    ok('a new search returns to page 1', ui.pages.contacts.page === 1 && rows(html) === 11, rows(html));

    section('Movement photo strip: Show more');
    ok('100 in range, 40 shown → "Show 40 more" + "Show all"', /data-dp-mv-more="40"/.test(ui._mvStripMore(100, 40)) && /data-dp-mv-more="all"/.test(ui._mvStripMore(100, 40)) && /60 more/.test(ui._mvStripMore(100, 40)));
    ok('15 left → "Show 15 more", no separate Show all', /Show 15 more/.test(ui._mvStripMore(55, 40)) && !/data-dp-mv-more="all"/.test(ui._mvStripMore(55, 40)));
    ok('all shown → no tile', ui._mvStripMore(40, 40) === '' && ui._mvStripMore(0, 0) === '');

    section('thumbnails: every card on the page fills in (old cap was 120)');
    let reads = 0, inFlight = 0, peak = 0;
    mod.readMedia = async (p) => { reads++; inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return 'data:image/jpeg;base64,' + p; };
    const fakeCards = (n) => Array.from({ length: n }, (_, i) => ({ dataset: { thumbnailPath: 'FileSystem/IMG_' + (i + 1) + '.jpg' }, isConnected: true, innerHTML: '' }));
    const fakeRoot = (cards) => ({ querySelectorAll: (sel) => sel === '[data-thumbnail-path]' ? cards : [] });
    let cards = fakeCards(300);
    ui._hydrateThumbnails(fakeRoot(cards), null);
    for (let i = 0; i < 400 && cards.some(c => !c.innerHTML); i++) await tick();
    ok('all 300 cards got an image', cards.every(c => /<img src="data:image\/jpeg;base64,FileSystem\/IMG_\d+\.jpg"/.test(c.innerHTML)), cards.filter(c => !c.innerHTML).length);
    ok('read each once', reads === 300, reads);
    ok('at most 4 reads at a time', peak <= 4 && peak >= 2, peak);
    const again = fakeCards(300);
    reads = 0;
    ui._hydrateThumbnails(fakeRoot(again), null);
    ok('paging back: cached thumbs apply at once with no disk reads', reads === 0 && again.every(c => c.innerHTML.includes('<img')), reads);
    ok('cards already filled are not re-read', (() => { reads = 0; ui._hydrateThumbnails(fakeRoot(again), null); return reads === 0; })());

    section('the lazy runner (no IntersectionObserver in this sandbox → loads all)');
    const loaded = [];
    const lc = Array.from({ length: 50 }, () => ({ dataset: {}, isConnected: true }));
    ui._lazyRun('t', lc, null, 2, 6, async (c) => { loaded.push(c); await tick(); });
    for (let i = 0; i < 200 && loaded.length < 50; i++) await tick();
    ok('all 50 loaded once', loaded.length === 50 && new Set(loaded).size === 50, loaded.length);
    ok('cards are marked done', lc.every(c => c.dataset.dpLazyt === 'done'));

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
