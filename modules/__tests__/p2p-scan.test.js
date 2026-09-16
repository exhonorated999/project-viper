/**
 * Tests for modules/p2p-scan/p2p-scan.js and the buttonHtml() half of
 * modules/p2p-scan/p2p-scan-ui.js.
 * Run: node modules/__tests__/p2p-scan.test.js
 *
 * Why this file is paranoid about ranges:
 *
 * Every value that survives isRoutableIpv4() becomes a live HTTPS request
 * from the officer's workstation to a third-party site, with an IP address
 * out of a criminal case file in the query string. A false positive here
 * is not a cosmetic bug — it either leaks an internal address, or sends
 * the examiner off to look up an address that is by definition
 * unattributable (RFC1918, CGNAT). So the range table gets edge-tested on
 * both sides of every boundary.
 *
 * The second half drives the real UI class the way the Discord
 * thread-render test does, because buttonHtml() is the only thing standing
 * between a disabled feature and a button appearing in every case file.
 * Asserting the core alone would not have caught a gate that reads the
 * wrong localStorage key.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const Core = require('../p2p-scan/p2p-scan.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(a, b, name) {
  ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ── constants / surface ─────────────────────────────────────────────
console.log('\n-- module surface --');
['scanUrl', 'isRoutableIpv4', 'isScannable', 'unscannableReason', 'scanFileName', 'isEnabled']
  .forEach(fn => eq(typeof Core[fn], 'function', `exports ${fn}()`));
eq(Core.P2P_SOURCE, 'torrentanalytics', 'source slug');
eq(Core.P2P_LABEL, 'TorrentAnalytics', 'display label');
eq(Core.P2P_EVIDENCE_TAG, 'P2P-Scans', 'evidence tag');
eq(Core.ENABLED_KEY, 'p2pScanEnabled', 'settings key');
eq(typeof Core.CAVEAT, 'string', 'CAVEAT is a string');

// The caveat is a legal/forensic guardrail, not decoration. If someone
// trims it down these assertions should make them think twice.
console.log('\n-- caveat content --');
ok(/not evidence/i.test(Core.CAVEAT), 'caveat says not evidence');
ok(/spoof/i.test(Core.CAVEAT), 'caveat warns about spoofing');
ok(/change over time|dynamic/i.test(Core.CAVEAT), 'caveat warns IPs change');
ok(/Tor/.test(Core.CAVEAT), 'caveat states Tor is not covered');
ok(/Usenet/i.test(Core.CAVEAT), 'caveat states Usenet is not covered');
ok(Core.CAVEAT.length > 120, 'caveat is substantive, not a stub');

// ── scanUrl ─────────────────────────────────────────────────────────
// The whole design rests on the query living in the URL: GET
// search_ip?ip=<ip> returns a populated page with no login and no POST.
// We never scrape their markup, so the only contract to protect is this
// one string.
console.log('\n-- scanUrl --');
eq(Core.scanUrl('76.32.67.113'),
  'https://torrentanalytics.net/search_ip?ip=76.32.67.113',
  'builds the verified GET url');
eq(Core.scanUrl('  8.8.8.8  '),
  'https://torrentanalytics.net/search_ip?ip=8.8.8.8',
  'trims surrounding whitespace');
ok(Core.scanUrl('a b&c=d').indexOf('a%20b%26c%3Dd') !== -1, 'encodes the param');
ok(Core.scanUrl('').indexOf('https://torrentanalytics.net/') === 0, 'empty still yields https origin');
ok(Core.scanUrl(null).indexOf('?ip=') !== -1, 'null does not throw');

// ── routable addresses ──────────────────────────────────────────────
console.log('\n-- routable (should scan) --');
[
  '76.32.67.113',   // the reference address from the Oversight screenshots
  '8.8.8.8',
  '1.1.1.1',
  '9.255.255.255',  // just below 10/8
  '11.0.0.0',       // just above 10/8
  '100.63.255.255', // just below CGNAT
  '100.128.0.0',    // just above CGNAT
  '126.255.255.255',// just below loopback
  '128.0.0.1',      // just above loopback
  '169.253.255.255',
  '169.255.0.0',
  '172.15.255.255', // just below the RFC1918 /12
  '172.32.0.0',     // just above the RFC1918 /12
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '198.50.0.1',
  '198.52.0.1',
  '202.255.255.255',
  '203.1.0.1',
  '223.255.255.255',// last routable before multicast
].forEach(ip => eq(Core.isRoutableIpv4(ip), true, `routable ${ip}`));

console.log('\n-- non-routable (must not scan) --');
[
  ['0.0.0.0', 'this-network'],
  ['0.1.2.3', 'this-network'],
  ['10.0.0.1', 'RFC1918 /8'],
  ['10.255.255.255', 'RFC1918 /8 top'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback top'],
  ['169.254.1.1', 'link-local'],
  ['172.16.0.1', 'RFC1918 /12 bottom'],
  ['172.31.255.255', 'RFC1918 /12 top'],
  ['172.20.5.5', 'RFC1918 /12 middle'],
  ['192.168.1.1', 'RFC1918 /16'],
  ['192.168.255.255', 'RFC1918 /16 top'],
  ['100.64.0.1', 'CGNAT bottom'],
  ['100.127.255.255', 'CGNAT top'],
  ['100.100.50.1', 'CGNAT middle'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.2.55', 'TEST-NET-1'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking top'],
  ['198.51.100.7', 'TEST-NET-2'],
  ['203.0.113.7', 'TEST-NET-3'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast top'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
].forEach(([ip, why]) => eq(Core.isRoutableIpv4(ip), false, `blocked ${ip} (${why})`));

// ── malformed input ─────────────────────────────────────────────────
// Identifier values are free-text fields an officer typed, so garbage is
// the normal case, not the exceptional one.
console.log('\n-- malformed input --');
[
  '', '   ', 'not an ip', '1.2.3', '1.2.3.4.5', '1.2.3.', '.1.2.3',
  '256.1.1.1', '1.256.1.1', '1.1.1.256', '999.999.999.999',
  '-1.2.3.4', '1.2.3.-4', '1.2.3.4a', 'a.b.c.d', '1.2.3.0x4',
  '1.2.3.4/24', '76.32.67.113:8080', '1,2,3,4',
  '2001:db8::1', '::1', 'fe80::1',
].forEach(v => eq(Core.isRoutableIpv4(v), false, `rejects ${JSON.stringify(v)}`));
eq(Core.isRoutableIpv4(null), false, 'rejects null');
eq(Core.isRoutableIpv4(undefined), false, 'rejects undefined');
eq(Core.isRoutableIpv4(12345), false, 'rejects a number');
eq(Core.isRoutableIpv4({}), false, 'rejects an object');
eq(Core.isRoutableIpv4([]), false, 'rejects an array');

// Leading zeros are refused rather than guessed at: "076" is octal to some
// resolvers and decimal to others, so "076.32.67.113" is genuinely
// ambiguous and must not silently become a different host.
console.log('\n-- octal ambiguity --');
eq(Core.isRoutableIpv4('076.32.67.113'), false, 'rejects leading-zero first octet');
eq(Core.isRoutableIpv4('8.8.8.08'), false, 'rejects leading-zero last octet');
eq(Core.isRoutableIpv4('010.0.0.1'), false, 'rejects 010 (would be 8.0.0.1 as octal)');
eq(Core.isRoutableIpv4('0.0.0.0'), false, 'bare zeros blocked by this-network rule');
eq(Core.isRoutableIpv4('8.8.8.8'), true, 'single-digit octets are fine');

// Surrounding whitespace is normal for pasted values.
eq(Core.isRoutableIpv4(' 76.32.67.113 '), true, 'tolerates surrounding whitespace');
eq(Core.isRoutableIpv4('76.32.67 .113'), false, 'inner whitespace is still invalid');

// ── isScannable (type gate) ─────────────────────────────────────────
// VIPER's identifier token is 'ip'. Oversight's was 'ip_address'; if
// someone ports more code across and brings the old token, this catches it.
console.log('\n-- isScannable type gate --');
eq(Core.isScannable('ip', '76.32.67.113'), true, "type 'ip' scans");
eq(Core.isScannable('IP', '76.32.67.113'), true, 'type is case-insensitive');
eq(Core.isScannable('ip_address', '76.32.67.113'), false, "Oversight's token is not VIPER's");
eq(Core.isScannable('email', '76.32.67.113'), false, 'email type never scans');
eq(Core.isScannable('phone', '76.32.67.113'), false, 'phone type never scans');
eq(Core.isScannable('username', '76.32.67.113'), false, 'username type never scans');
eq(Core.isScannable('', '76.32.67.113'), false, 'empty type never scans');
eq(Core.isScannable(null, '76.32.67.113'), false, 'null type never scans');
eq(Core.isScannable('ip', '192.168.1.1'), false, 'right type, private address still blocked');

// ── unscannableReason ───────────────────────────────────────────────
// This string goes in a tooltip an officer reads, so it has to name the
// actual problem rather than say "invalid".
console.log('\n-- unscannableReason --');
eq(Core.unscannableReason('ip', '76.32.67.113'), null, 'null when scannable');
eq(Core.unscannableReason('ip', '8.8.8.8'), null, 'null for a public resolver');
ok(/only ip/i.test(Core.unscannableReason('email', 'x')), 'wrong type explained');
ok(/IPv6/.test(Core.unscannableReason('ip', '2001:db8::1')), 'IPv6 named explicitly');
ok(/IPv6/.test(Core.unscannableReason('ip', '::1')), 'short IPv6 named explicitly');
ok(/private/i.test(Core.unscannableReason('ip', '192.168.1.1')), '192.168 called private');
ok(/private/i.test(Core.unscannableReason('ip', '10.1.2.3')), '10/8 called private');
ok(/private/i.test(Core.unscannableReason('ip', '172.20.0.1')), '172.16/12 called private');
ok(/NAT/i.test(Core.unscannableReason('ip', '100.100.0.1')), 'CGNAT named');
ok(/attributable/i.test(Core.unscannableReason('ip', '100.100.0.1')),
  'CGNAT reason says why it matters, not just what it is');
ok(/loopback/i.test(Core.unscannableReason('ip', '127.0.0.1')), 'loopback named');
ok(/link-local/i.test(Core.unscannableReason('ip', '169.254.9.9')), 'link-local named');
ok(/valid/i.test(Core.unscannableReason('ip', 'garbage')), 'garbage called invalid');
ok(/reserved/i.test(Core.unscannableReason('ip', '240.0.0.1')), 'reserved range named');
ok(/reserved/i.test(Core.unscannableReason('ip', '224.0.0.1')), 'multicast reported as reserved');

// Every blocked address must produce a reason string — a dimmed button
// with an empty tooltip is the worst of both worlds.
console.log('\n-- reason coverage --');
let missingReason = 0;
['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.0.1', '172.16.0.1', '192.168.0.1',
 '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
 '224.0.0.1', '255.255.255.255', 'junk', '', '2001:db8::1'].forEach(ip => {
  const r = Core.unscannableReason('ip', ip);
  if (!r || typeof r !== 'string' || !r.length) missingReason++;
});
eq(missingReason, 0, 'every blocked address has a non-empty reason');

// And the inverse: anything routable must report no reason at all, or the
// button would be dimmed for a perfectly good address.
let spuriousReason = 0;
['76.32.67.113', '8.8.8.8', '1.1.1.1', '223.255.255.255', '11.0.0.1', '172.32.0.1']
  .forEach(ip => { if (Core.unscannableReason('ip', ip) !== null) spuriousReason++; });
eq(spuriousReason, 0, 'no routable address reports a reason');

// ── scanFileName ────────────────────────────────────────────────────
// Filename lands in Evidence, so it has to be stable, sortable and
// unambiguous about which IP and when.
console.log('\n-- scanFileName --');
const when = new Date(2026, 8, 16, 14, 30, 22); // local time, Sept 16 2026
eq(Core.scanFileName('76.32.67.113', when),
  'torrentanalytics_76.32.67.113_2026-09-16_143022.pdf',
  'exact filename shape');
ok(/^torrentanalytics_/.test(Core.scanFileName('8.8.8.8', when)), 'prefixed with source');
ok(/\.pdf$/.test(Core.scanFileName('8.8.8.8', when)), 'ends in .pdf');
eq(Core.scanFileName('8.8.8.8', new Date(2026, 0, 1, 0, 0, 0)),
  'torrentanalytics_8.8.8.8_2026-01-01_000000.pdf',
  'zero-pads month, day and time');
eq(Core.scanFileName('8.8.8.8', new Date(2026, 11, 31, 23, 59, 59)),
  'torrentanalytics_8.8.8.8_2026-12-31_235959.pdf',
  'handles the end of the year');
eq(Core.scanFileName(' 8.8.8.8 ', when).indexOf(' '), -1, 'no spaces in the filename');
ok(typeof Core.scanFileName('8.8.8.8') === 'string', 'defaults to now when no date given');

// ── isEnabled ───────────────────────────────────────────────────────
// Off by default. This feature reaches out to a third-party site from a
// police workstation, so "absent key" must never mean "on".
console.log('\n-- isEnabled --');
eq(Core.isEnabled(), false, 'false when localStorage is absent entirely');

const store = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
eq(Core.isEnabled(), false, 'false when the key is unset');
store.p2pScanEnabled = 'true';
eq(Core.isEnabled(), true, "true only for the exact string 'true'");
store.p2pScanEnabled = 'false';
eq(Core.isEnabled(), false, "'false' is off");
store.p2pScanEnabled = '1';
eq(Core.isEnabled(), false, "'1' is not 'true' — no truthy coercion");
store.p2pScanEnabled = 'TRUE';
eq(Core.isEnabled(), false, "'TRUE' is not 'true' — no case coercion");
store.p2pScanEnabled = 'yes';
eq(Core.isEnabled(), false, "'yes' is off");
delete global.localStorage;

// ── UI half: buttonHtml() ───────────────────────────────────────────
// Loaded through vm the way the renderer sees it. window must BE the
// sandbox global, or the IIFE's `window.P2PScanCore` lookup and its
// `window.P2PScan = ...` export land in different places (the host-scoping
// trap, VIPER context notes).
console.log('\n-- ui buttonHtml --');

function loadUi(enabled) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'p2p-scan', 'p2p-scan-ui.js'), 'utf8');
  const ls = { p2pScanEnabled: enabled ? 'true' : 'false' };
  const sandbox = {
    console,
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: () => {} },
    // Only the members buttonHtml()'s module-level code touches.
    document: { getElementById: () => null, addEventListener: () => {} },
    requestAnimationFrame: cb => cb(),
    setTimeout,
  };
  sandbox.window = sandbox;
  sandbox.window.P2PScanCore = Core;
  sandbox.window.addEventListener = () => {};
  const ctx = vm.createContext(sandbox);
  // The core reads its own localStorage; point it at the sandbox's.
  const prevLs = global.localStorage;
  global.localStorage = sandbox.localStorage;
  try {
    vm.runInContext(src, ctx, { filename: 'p2p-scan-ui.js' });
  } finally {
    if (prevLs === undefined) delete global.localStorage; else global.localStorage = prevLs;
  }
  return sandbox.window.P2PScan;
}

// With the feature ON.
global.localStorage = { getItem: () => 'true', setItem: () => {} };
const UI = loadUi(true);
ok(UI && typeof UI.buttonHtml === 'function', 'exposes window.P2PScan.buttonHtml');
['scan', 'close', 'reposition'].forEach(fn =>
  eq(typeof UI[fn], 'function', `exposes ${fn}()`));

const live = UI.buttonHtml('76.32.67.113');
ok(live.indexOf('<button') === 0, 'renders a button element');
ok(live.indexOf('window.P2PScan.scan(') !== -1, 'wires the click to the gate, not the scan');
ok(live.indexOf('76.32.67.113') !== -1, 'carries the address');
ok(live.indexOf('disabled') === -1, 'routable button is not disabled');
ok(live.indexOf('P2P') !== -1, 'labelled P2P');
// The suspect identifier row already owns the satellite emoji for "Ping".
ok(live.indexOf('\u{1F4E1}') === -1, 'does not reuse the Ping satellite emoji');

const dimmed = UI.buttonHtml('192.168.1.1');
ok(dimmed.indexOf('disabled') !== -1, 'private address renders disabled');
ok(/title="[^"]*[Pp]rivate/.test(dimmed), 'disabled button explains itself in the title');
ok(dimmed.indexOf('onclick') === -1, 'disabled button has no click handler');

const cgnat = UI.buttonHtml('100.100.1.1');
ok(cgnat.indexOf('disabled') !== -1, 'CGNAT renders disabled');

eq(UI.buttonHtml(''), '', 'empty value renders nothing');
eq(UI.buttonHtml('   '), '', 'whitespace-only value renders nothing');
eq(UI.buttonHtml(null), '', 'null renders nothing');
eq(UI.buttonHtml(undefined), '', 'undefined renders nothing');

// Identifier values are officer-typed free text and go straight into a
// template literal on an onclick attribute, so quote handling matters.
const nasty = UI.buttonHtml(`x' onmouseover='alert(1)`);
ok(nasty.indexOf("onmouseover='alert(1)") === -1, 'escapes a quote-breakout attempt');
const angle = UI.buttonHtml('<img src=x onerror=alert(1)>');
ok(angle.indexOf('<img') === -1, 'escapes raw angle brackets');
delete global.localStorage;

// With the feature OFF — a department that never enabled it must not see
// the affordance at all, not even a dimmed one.
console.log('\n-- ui gated off --');
global.localStorage = { getItem: () => 'false', setItem: () => {} };
const UIoff = loadUi(false);
eq(UIoff.buttonHtml('76.32.67.113'), '', 'disabled feature renders no button for a good ip');
eq(UIoff.buttonHtml('192.168.1.1'), '', 'disabled feature renders no button for a bad ip');
delete global.localStorage;

// ── wiring: the module is actually loaded and called ────────────────
// A perfect module nobody references ships as a no-op, which is exactly
// what would happen if one of these edits got lost in a merge.
console.log('\n-- host wiring --');
const caseDetail = fs.readFileSync(
  path.join(__dirname, '..', '..', 'case-detail-with-analytics.html'), 'utf8');
ok(caseDetail.indexOf('modules/p2p-scan/p2p-scan.js') !== -1, 'case-detail loads the core');
ok(caseDetail.indexOf('modules/p2p-scan/p2p-scan-ui.js') !== -1, 'case-detail loads the ui');
ok(caseDetail.indexOf('modules/p2p-scan/p2p-scan.css') !== -1, 'case-detail loads the css');
ok(caseDetail.indexOf('modules/p2p-scan/p2p-scan.js') <
   caseDetail.indexOf('modules/p2p-scan/p2p-scan-ui.js'), 'core tag precedes ui tag');
ok(caseDetail.indexOf('function _p2pScanBtn') !== -1, 'defines the _p2pScanBtn helper');
// Two call sites: the suspect detail view and the shared
// victim/witness/other renderer. Losing either leaves half the person
// types without the button.
eq((caseDetail.match(/_p2pScanBtn\(ident\.value\)/g) || []).length, 2,
  'called from both identifier renderers (suspect + shared people)');

const preload = fs.readFileSync(
  path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
['p2pScanOpen', 'p2pScanSetBounds', 'p2pScanClose', 'p2pScanReload', 'p2pScanCapturePdf']
  .forEach(k => ok(preload.indexOf(k + ':') !== -1, `preload bridges ${k}`));

const main = fs.readFileSync(
  path.join(__dirname, '..', '..', 'electron-main.js'), 'utf8');
['p2p-scan-open', 'p2p-scan-close', 'p2p-scan-set-bounds', 'p2p-scan-reload', 'p2p-scan-capture-pdf']
  .forEach(ch => ok(main.indexOf("'" + ch + "'") !== -1, `main handles ${ch}`));
// Main must validate independently of the renderer — same defence-in-depth
// rule the custom-tools URL allow-list follows.
ok(main.indexOf('p2pIsRoutableIpv4') !== -1, 'main re-validates routability itself');
// Capture has to ride the already-proven evidence router rather than
// inventing a second write path.
ok(main.indexOf("'rh-download-ready'") !== -1, 'capture reuses the rh-download-ready router');
ok(main.indexOf("persist:p2pscan") !== -1, 'dedicated session partition registered');
ok(main.indexOf('p2pScanViewVisible') !== -1, 'view visibility tracked for nav teardown');

const settings = fs.readFileSync(
  path.join(__dirname, '..', '..', 'settings.html'), 'utf8');
ok(settings.indexOf('p2pScanEnabledToggle') !== -1, 'settings has the toggle input');
ok(settings.indexOf('function setP2pScanEnabled') !== -1, 'settings defines the setter');
ok(settings.indexOf('initP2pScanCard()') !== -1, 'settings initialises the toggle on load');
ok(settings.indexOf("'p2pScanEnabled'") !== -1, 'settings writes the same key the core reads');

// The scan window is a native BrowserView, which paints above all DOM.
// Without honouring the suspend broadcast the evidence destination picker
// opens *behind* the scan window and cannot be reached.
const uiSrc = fs.readFileSync(
  path.join(__dirname, '..', 'p2p-scan', 'p2p-scan-ui.js'), 'utf8');
ok(uiSrc.indexOf('pulse:bv-suspend') !== -1, 'ui honours pulse:bv-suspend');
ok(uiSrc.indexOf('pulse:bv-resume') !== -1, 'ui honours pulse:bv-resume');
// Bounds must be corrected for the body zoom viper-prefs applies, or the
// view lands in the wrong place for anyone not at 100%.
ok(/getComputedStyle\(document\.body\)\.zoom/.test(uiSrc), 'ui corrects bounds for body zoom');

// Colour must come from skin tokens so the module follows Classic /
// Supervisor / Obsidian / Ember instead of fighting them. Neutral text
// greys are exempt — the skin registry only defines 8 accent/surface
// tokens, and the rest of the app writes literal greys too. What must
// never be hardcoded is anything the skin is supposed to control.
const css = fs.readFileSync(
  path.join(__dirname, '..', 'p2p-scan', 'p2p-scan.css'), 'utf8');
ok(css.indexOf('--vp-') !== -1, 'css uses skin tokens');
const NEUTRAL_HEX = new Set([
  '#fff', '#ffffff', '#000', '#000000',
  '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937',
]);
const nonNeutral = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
  .filter(h => !NEUTRAL_HEX.has(h.toLowerCase()));
eq(nonNeutral.length, 0,
  `no hardcoded accent hex — skins must drive colour (found ${nonNeutral.join(', ')})`);
// The accents themselves must be present as tokens, or the module would
// simply be colourless rather than skin-aware.
['--vp-purple', '--vp-card', '--vp-dark'].forEach(t =>
  ok(css.indexOf(t) !== -1, `css references ${t}`));

console.log(`\np2p-scan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
