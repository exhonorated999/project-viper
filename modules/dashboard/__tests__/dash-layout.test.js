/* Customizable dashboard: layout model (dash-layout.js). Plain node. */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'dash-layout.js'));

let pass = 0, fail = 0;
function ok(label, cond) {
    if (cond) { pass++; console.log('PASS ' + label); }
    else { fail++; console.log('FAIL ' + label); }
}
function seqRng(seed) { let s = seed || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
function overlaps(ws) {
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i], b = ws[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return a.type + '/' + b.type;
    }
    return null;
}

// ── catalog ──
L.TYPE_ORDER.forEach(t => {
    const s = L.TYPES[t];
    ok('type ' + t + ' has sane sizes', s.min.w <= s.def.w && s.def.w <= s.max.w && s.min.h <= s.def.h && s.def.h <= s.max.h && s.max.w <= 12);
    ok('type ' + t + ' is multi xor panel', !!s.multi !== !!s.panel);
    const d = L.defaultCfg(t);
    ok('type ' + t + ' default cfg survives sanitize', JSON.stringify(L.sanitizeCfg(t, d)) === JSON.stringify(d));
});

// ── presets ──
L.PRESET_ORDER.forEach(p => {
    const ws = L.presetWidgets(p, null, seqRng(3));
    ok('preset ' + p + ' non-empty', ws.length >= 8);
    ok('preset ' + p + ' no overlaps (' + overlaps(ws) + ')', !overlaps(ws));
    ok('preset ' + p + ' inside 12 cols', ws.every(w => w.x >= 0 && w.x + w.w <= 12));
    ok('preset ' + p + ' all uids valid + unique', ws.every(w => L.UID_RE.test(w.uid)) && new Set(ws.map(w => w.uid)).size === ws.length);
    ok('preset ' + p + ' re-sanitizes unchanged', JSON.stringify(L.sanitizeWidgets(ws)) === JSON.stringify(ws));
    ok('preset ' + p + ' has 4 stats', ws.filter(w => w.type === 'stat').length === 4);
    ok('preset ' + p + ' has investigations', ws.some(w => w.type === 'investigations'));
});
const cf = L.presetWidgets('casesFirst');
ok('casesFirst puts investigations at the top', cf.find(w => w.type === 'investigations').y === 0);
const an = L.presetWidgets('analyst');
ok('analyst gauge-free charts coerced sanely', an.filter(w => w.type === 'chart').every(w => w.cfg.groupBy === 'month' || L.DIST_TYPES.includes(w.cfg.type)));
ok('analyst donut by status', an.some(w => w.type === 'chart' && w.cfg.type === 'donut' && w.cfg.groupBy === 'status'));
ok('compact stats are big style', L.presetWidgets('compact').filter(w => w.type === 'stat').every(w => w.cfg.style === 'big'));

// ── migration from cardPreferences ──
const prefs = { cardPreferences: { 1: 'cases_closed', 2: 'custom_abc', '3': 'search_warrants', 4: '<img onerror=x>' } };
const mig = L.ensureStore(null, prefs, seqRng(5));
ok('first run migrates', mig.migrated === true);
const ml = mig.store.layouts[mig.store.active];
ok('migrated layout id default', ml.id === 'default' && ml.name === 'My dashboard' && ml.preset === 'classic');
const sm = L.statsInOrder(ml.widgets).map(w => w.cfg.metric);
ok('migrated stats keep card metrics', sm[0] === 'cases_closed' && sm[1] === 'custom_abc' && sm[2] === 'search_warrants');
ok('migrated bad metric falls back', sm[3] === 'rescued_individuals');
const again = L.ensureStore(JSON.stringify(mig.store), prefs);
ok('saved store round-trips', again.migrated === false && JSON.stringify(again.store) === JSON.stringify(mig.store));
ok('corrupt JSON store re-migrates', L.ensureStore('{nope', prefs).migrated === true);
ok('store with no layouts re-migrates', L.ensureStore({ v: 1, layouts: {} }, prefs).migrated === true);
ok('bad active falls back to first', L.sanitizeStore({ active: 'zzz', layouts: { a: { name: 'A', widgets: [] } } }).active === 'a');
ok('bad layout ids dropped', !L.sanitizeStore({ layouts: { 'A B': {}, ok: {} } }).layouts['A B']);
const many = { layouts: {} };
for (let i = 0; i < 30; i++) many.layouts['l' + i] = { name: 'L' + i, widgets: [] };
ok('layout count capped', Object.keys(L.sanitizeStore(many).layouts).length === L.MAX_LAYOUTS);

// ── sanitize ──
const dirty = [
    { type: 'nope', x: 0, y: 0, w: 3, h: 3 },
    null, 'x', [1],
    { type: '__proto__', x: 0, y: 0 },
    { type: 'constructor' },
    { type: 'tasks', uid: 'w_aaaaaaaa', x: 0, y: 0, w: 4, h: 25 },
    { type: 'tasks', uid: 'w_bbbbbbbb', x: 4, y: 0, w: 4, h: 25 },
    { type: 'stat', uid: 'w_aaaaaaaa', x: 20, y: -5, w: 99, h: 1, cfg: { metric: 'arrests', style: 'weird' } },
    { type: 'stat', uid: 'BAD', x: 'abc', y: 1e9, w: '4', h: '6', cfg: { metric: '"><script>' } },
    { type: 'notes', x: 0, y: 0, w: 4, h: 10, cfg: { title: '<b onclick=1>\u0000hi</b>' + 'x'.repeat(200), tint: 'pink' } },
];
const sw = L.sanitizeWidgets(dirty, { rng: seqRng(9) });
ok('unknown / junk types dropped', sw.every(w => L.TYPES[w.type] && Object.prototype.hasOwnProperty.call(L.TYPES, w.type)) && sw.length === 4);
ok('duplicate panel dropped', sw.filter(w => w.type === 'tasks').length === 1 && sw[0].uid === 'w_aaaaaaaa');
ok('duplicate uid re-issued', new Set(sw.map(w => w.uid)).size === sw.length && sw[1].uid !== 'w_aaaaaaaa');
ok('bad uid re-issued', sw.every(w => L.UID_RE.test(w.uid)));
ok('oversize clamped', sw[1].w === 12 && sw[1].x === 0 && sw[1].y === 0 && sw[1].h === L.TYPES.stat.min.h);
ok('bad enum -> default', sw[1].cfg.style === 'split');
ok('string sizes coerced', sw[2].w === 4 && sw[2].h === 6 && sw[2].x === 0 && sw[2].y === 1000);
ok('bad metric -> default', sw[2].cfg.metric === 'arrests');
ok('XSS text kept as text, clipped, no control chars', sw[3].cfg.title.startsWith('<b onclick=1> hi</b>') && sw[3].cfg.title.length === 40);
ok('bad tint -> default', sw[3].cfg.tint === 'yellow');
const lots = []; for (let i = 0; i < 100; i++) lots.push({ type: 'notes', x: 0, y: i });
ok('widget count capped', L.sanitizeWidgets(lots).length === L.MAX_WIDGETS);
ok('non-array -> []', Array.isArray(L.sanitizeWidgets({})) && L.sanitizeWidgets('x').length === 0);
ok('freshUids replaces uids', L.sanitizeWidgets([{ type: 'notes', uid: 'w_aaaaaaaa' }], { freshUids: true })[0].uid !== 'w_aaaaaaaa');

// ── cfg coercion ──
ok('agenda days "14" -> 14', L.sanitizeCfg('agenda', { days: '14' }).days === 14);
ok('agenda days 9 -> 7', L.sanitizeCfg('agenda', { days: 9 }).days === 7);
ok('agenda bool strings rejected', L.sanitizeCfg('agenda', { tasks: 'false' }).tasks === true && L.sanitizeCfg('agenda', { court: false }).court === false);
ok('recent count clamped', L.sanitizeCfg('recentCases', { count: 500 }).count === 20 && L.sanitizeCfg('recentCases', { count: 'x' }).count === 8);
ok('chart gauge forces month', L.sanitizeCfg('chart', { type: 'gauge', groupBy: 'status' }).groupBy === 'month');
ok('chart line+status -> bar', L.sanitizeCfg('chart', { type: 'line', groupBy: 'status' }).type === 'bar');
ok('chart donut+offense kept', (c => c.type === 'donut' && c.groupBy === 'offense')(L.sanitizeCfg('chart', { type: 'donut', groupBy: 'offense' })));
const mc = L.sanitizeCfg('chart', { metrics: ['arrests', 'arrests', 'BAD', 'narcotics_seized.kg', 'a', 'b', 'c'] });
ok('chart metrics dedup/filter/cap', JSON.stringify(mc.metrics) === JSON.stringify(['arrests', 'narcotics_seized.kg', 'a', 'b']));
ok('chart empty metrics -> default', L.sanitizeCfg('chart', { metrics: [] }).metrics.length === 2);
ok('default cfg arrays are copies', L.defaultCfg('chart').metrics !== L.TYPES.chart.cfg.metrics.d);
ok('unknown cfg keys dropped', !('evil' in L.sanitizeCfg('stat', { evil: 1 })));
ok('metric regex unit only kg/lbs/pills', L.isMetricKey('narcotics_seized.pills') && !L.isMetricKey('narcotics_seized.oz') && !L.isMetricKey('Arrests'));

// ── export / import ──
const exp = L.exportLayout(ml);
ok('export format', exp.format === L.FILE_FORMAT && exp.version === 1 && exp.widgets.length === ml.widgets.length);
ok('export carries no uids', exp.widgets.every(w => !('uid' in w)));
const imp = L.importLayout(JSON.stringify(exp), { rng: seqRng(11) });
ok('import round-trips boxes', imp.widgets.map(w => [w.type, w.x, w.y, w.w, w.h].join()).join('|') === ml.widgets.map(w => [w.type, w.x, w.y, w.w, w.h].join()).join('|'));
ok('import gives fresh uids', imp.widgets.every(w => L.UID_RE.test(w.uid)) && !imp.widgets.some(w => ml.widgets.find(m => m.uid === w.uid)));
ok('import id null (caller assigns)', imp.id === null);
function throws(fn, re) { try { fn(); return false; } catch (e) { return re.test(e.message); } }
ok('import bad JSON', throws(() => L.importLayout('{x'), /not valid JSON/));
ok('import wrong format', throws(() => L.importLayout({ format: 'other', version: 1, widgets: [] }), /not a VIPER dashboard layout/));
ok('import newer version', throws(() => L.importLayout({ format: L.FILE_FORMAT, version: 2, widgets: [] }), /newer VIPER/));
ok('import no usable widgets', throws(() => L.importLayout({ format: L.FILE_FORMAT, version: 1, widgets: [{ type: 'zzz' }] }), /no widgets/));
ok('import too large', throws(() => L.importLayout('x'.repeat(600 * 1024)), /too large/));
ok('import array rejected', throws(() => L.importLayout([]), /not a VIPER/));

// ── ids / cardPreferences mirror ──
const st = { layouts: { analyst: {}, 'analyst-2': {} } };
ok('newLayoutId avoids clashes', L.newLayoutId(st, 'Analyst') === 'analyst-3');
ok('newLayoutId slugs names', L.newLayoutId(null, '  My <Cool> Layout!! ') === 'my-cool-layout');
ok('newLayoutId empty -> layout', L.newLayoutId(null, '!!!') === 'layout');
const lay = { widgets: [
    { type: 'stat', x: 3, y: 0, cfg: { metric: 'b' } }, { type: 'stat', x: 0, y: 0, cfg: { metric: 'a' } },
    { type: 'stat', x: 0, y: 9, cfg: { metric: 'narcotics_seized.kg' } }, { type: 'chart', x: 0, y: 1, cfg: {} },
] };
const cp = L.cardPrefsFromLayout(lay, { 1: 'x', 2: 'y', 3: 'z', 4: 'keep' });
ok('cardPrefs reading order + base key + keep rest', cp[1] === 'a' && cp[2] === 'b' && cp[3] === 'narcotics_seized' && cp[4] === 'keep');
ok('newUid format', L.UID_RE.test(L.newUid()));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
