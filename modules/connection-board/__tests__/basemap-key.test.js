/* ============================================================================
 *  CARTO basemap key — regression tests
 * ----------------------------------------------------------------------------
 *  CARTO started stamping a large "API KEY REQUIRED / carto.com/basemaps/apikey"
 *  watermark diagonally across every keyless raster tile, which defaced every
 *  map in VIPER (CDR map, AMP playback, Connection Board, Google warrant
 *  location map, Missing-Persons sightings). The fix is a `key=` query param,
 *  centralised in modules/_shared/basemap.js.
 *
 *  These tests exist because the failure mode is PURELY VISUAL — the tiles
 *  still return HTTP 200, Leaflet reports no error, and nothing throws. Only a
 *  human looking at the map can tell. So the URL has to be asserted in code.
 *
 *  Run:  node modules\connection-board\__tests__\basemap-key.test.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KEY = 'cb1_3oqf_1_911980cf4189da1dfd1186b2';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; }
    else { failed++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
}
function section(s) { console.log('\n[' + s + ']'); }

// ---------------------------------------------------------------------------
// Load the shared basemap config the same way the renderer does.
// ---------------------------------------------------------------------------
function loadBasemap() {
    const sandbox = { module: undefined, console };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'modules', '_shared', 'basemap.js'), 'utf8'),
        sandbox,
        { filename: 'basemap.js' }
    );
    return sandbox;
}

section('modules/_shared/basemap.js');
const bm = loadBasemap();
const BASEMAP = bm.VIPER_BASEMAP;

ok('exposes window.VIPER_BASEMAP', !!BASEMAP);
ok('dark URL carries the key',
    typeof BASEMAP.dark === 'string' && BASEMAP.dark.indexOf('key=' + KEY) !== -1, BASEMAP.dark);
ok('dark URL keeps the dark_all path (verified byte-identical to rastertiles/dark_all)',
    /^https:\/\/\{s\}\.basemaps\.cartocdn\.com\/dark_all\/\{z\}\/\{x\}\/\{y\}\{r\}\.png\?key=/.test(BASEMAP.dark));
ok('dark URL keeps the {s} subdomain token (Leaflet round-robins a/b/c/d)',
    BASEMAP.dark.indexOf('{s}.') !== -1);
ok('dark URL keeps the {r} retina token', BASEMAP.dark.indexOf('{y}{r}.png') !== -1);
ok('light variant is keyed too', BASEMAP.light.indexOf('key=' + KEY) !== -1);
ok('voyager variant is keyed too', BASEMAP.voyager.indexOf('key=' + KEY) !== -1);
ok('exposes the raw key for callers that build their own URL', BASEMAP.key === KEY);
ok('attribution is present (CARTO ToS requires it)',
    /CARTO/.test(BASEMAP.attribution) && /OpenStreetMap/.test(BASEMAP.attribution));
// The keyless URL is the documented degraded fallback. It must stay keyless —
// if someone "helpfully" adds the key here the fallback stops being a fallback.
ok('darkNoKey fallback is genuinely keyless', BASEMAP.darkNoKey.indexOf('key=') === -1);
ok('only one query param on the dark URL', (BASEMAP.dark.match(/\?/g) || []).length === 1);

// ---------------------------------------------------------------------------
// Every live tile layer in the app must resolve to a keyed URL.
//
// We assert on source rather than at runtime for the HTML page because the
// call sites live inside a 41,000-line inline <script>; the runtime check for
// that page is modules/_shared/basemap.js + the offscreen-Chromium probe.
// ---------------------------------------------------------------------------
section('no keyless CARTO tile layer survives');

const CALL_SITES = [
    'case-detail-with-analytics.html',
    path.join('modules', 'connection-board', 'connection-board.js'),
    path.join('modules', 'google-warrant', 'google-warrant-ui.js')
];

// A literal CARTO URL passed straight into L.tileLayer( is the bug we are
// guarding against. Fallback strings assigned to a variable are fine.
const RE_BAD = /L\.tileLayer\(\s*['"]https:\/\/\{s\}\.basemaps\.cartocdn\.com/;

for (const rel of CALL_SITES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    ok(rel + ': no hard-coded CARTO url inside L.tileLayer(', !RE_BAD.test(src));
}

// The page must actually load the shared config, and load it synchronously
// (no defer) so it is present before any deferred map module evaluates.
const pageSrc = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8');
const tagMatch = pageSrc.match(/<script src="modules\/_shared\/basemap\.js"[^>]*>/);
ok('case-detail loads modules/_shared/basemap.js', !!tagMatch);
ok('…and loads it synchronously (no defer/async)',
    !!tagMatch && !/\b(defer|async)\b/.test(tagMatch[0]), tagMatch && tagMatch[0]);
ok('…before connection-board.js',
    pageSrc.indexOf('modules/_shared/basemap.js') < pageSrc.indexOf('modules/connection-board/connection-board.js'));
ok('…before google-warrant-ui.js',
    pageSrc.indexOf('modules/_shared/basemap.js') < pageSrc.indexOf('modules/google-warrant/google-warrant-ui.js'));

// CSP: tiles are <img> loads, so img-src governs them, not connect-src.
const csp = (pageSrc.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
const imgSrc = (csp.split(';').find(d => d.trim().indexOf('img-src') === 0) || '');
ok('CSP img-src permits https: (tile loads)', /\bhttps:/.test(imgSrc), imgSrc.trim());

// ---------------------------------------------------------------------------
// Connection Board — the exported standalone HTML also has to be keyed.
//
// This one is the easiest to forget: the map inside the export is built by a
// string-concatenated script, so it is invisible to a grep for L.tileLayer in
// normal code shape. An examiner may hand this file to a DA, and a watermarked
// map in a court packet looks like a broken product.
// ---------------------------------------------------------------------------
section('connection board export');

function loadConnectionBoard(withBasemap) {
    let src = fs.readFileSync(
        path.join(ROOT, 'modules', 'connection-board', 'connection-board.js'), 'utf8');

    // Test-only hook: reach the module's private export builder.
    const anchor = 'window.ConnectionBoard = {';
    if (src.indexOf(anchor) === -1) throw new Error('module shape changed: public API anchor not found');
    src = src.replace(anchor,
        'window.__cbTest = { buildExportHtml: buildExportHtml, EXPORT_JS: EXPORT_JS, darkTileUrl: _darkTileUrl };\n  ' + anchor);

    const listeners = {};
    const stubEl = new Proxy({}, {
        get(t, k) {
            if (k === 'style' || k === 'classList' || k === 'dataset') return new Proxy({}, { get: () => () => {} });
            if (k === 'appendChild' || k === 'addEventListener' || k === 'removeEventListener'
                || k === 'querySelector' || k === 'querySelectorAll' || k === 'setAttribute') return () => {};
            return undefined;
        },
        set() { return true; }
    });

    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        L: { map: () => ({ on: () => {}, setView: () => {} }), tileLayer: () => ({ addTo: () => {} }) },
        document: {
            addEventListener: (ev, fn) => { listeners[ev] = fn; },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => stubEl,
            body: stubEl,
            documentElement: stubEl
        },
        localStorage: {
            _d: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
            setItem(k, v) { this._d[k] = String(v); },
            removeItem(k) { delete this._d[k]; }
        },
        navigator: { userAgent: 'node' },
        location: { href: 'file:///x/case-detail-with-analytics.html' }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    if (withBasemap) sandbox.VIPER_BASEMAP = BASEMAP;

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'connection-board.js' });
    return sandbox;
}

const cb = loadConnectionBoard(true);
const cbt = cb.__cbTest;

ok('module evaluated and test hook is reachable', !!cbt);
ok('_darkTileUrl() returns the keyed url', cbt.darkTileUrl() === BASEMAP.dark, cbt.darkTileUrl());
ok('EXPORT_JS template holds the placeholder, not a baked url',
    cbt.EXPORT_JS.indexOf('__VIPER_TILE_URL__') !== -1);
ok('EXPORT_JS template has no hard-coded cartocdn url',
    cbt.EXPORT_JS.indexOf('basemaps.cartocdn.com') === -1);

const SAMPLE = {
    caseInfo: { number: '26-0000001' },
    generated: '2026-09-17 10:00',
    defaultView: 'map',
    typeMeta: { custom: { color: '#9ca3af', glyph: 'P', label: 'Pin' } },
    pins: [{ id: 'p1', type: 'custom', label: 'A', lat: 35.1, lng: -92.4 }],
    strings: []
};

const html = cbt.buildExportHtml(SAMPLE);
ok('export html is produced', typeof html === 'string' && html.length > 500);
ok('export html bakes the keyed tile url', html.indexOf('key=' + KEY) !== -1);
ok('export html has no unsubstituted placeholder left',
    html.indexOf('__VIPER_TILE_URL__') === -1);
ok('export html contains exactly one tile url', (html.match(/basemaps\.cartocdn\.com/g) || []).length === 1);
ok('export html tile url is not the keyless one',
    !/cartocdn\.com\/dark_all\/\{z\}\/\{x\}\/\{y\}\{r\}\.png"/.test(html));
ok('export still carries the board payload', html.indexOf('window.__BOARD__=') !== -1);

// Substitution must be repeatable — buildExportHtml is called once per export
// and must not mutate the shared EXPORT_JS template.
const html2 = cbt.buildExportHtml(SAMPLE);
ok('EXPORT_JS template was not mutated by the first export',
    cbt.EXPORT_JS.indexOf('__VIPER_TILE_URL__') !== -1);
ok('second export is byte-identical', html2 === html);

// ---------------------------------------------------------------------------
// Degraded path: if basemap.js fails to load the map must still work, just
// watermarked. A thrown TypeError mid-case is strictly worse than a watermark.
// ---------------------------------------------------------------------------
section('degraded fallback (basemap.js absent)');

const cbNo = loadConnectionBoard(false);
ok('module still evaluates without VIPER_BASEMAP', !!cbNo.__cbTest);
let fellBack = null;
try { fellBack = cbNo.__cbTest.darkTileUrl(); } catch (e) { fellBack = 'THREW: ' + e.message; }
ok('_darkTileUrl() falls back instead of throwing',
    fellBack === 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', fellBack);
let htmlNo = null;
try { htmlNo = cbNo.__cbTest.buildExportHtml(SAMPLE); } catch (e) { htmlNo = 'THREW: ' + e.message; }
ok('export still builds without VIPER_BASEMAP',
    typeof htmlNo === 'string' && htmlNo.indexOf('__VIPER_TILE_URL__') === -1);

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
