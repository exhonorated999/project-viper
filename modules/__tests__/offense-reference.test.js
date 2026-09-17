/**
 * Offense Reference — schema, import/export, and page-render tests.
 *
 * The invariant this file exists to protect:
 *
 *     CASE LAW IS NOT CHARGEABLE.
 *
 * Three separate pickers in VIPER build a "Primary Offense" dropdown out of
 * localStorage['viperOffenseReference'] — Create Case, Case Overview, and the
 * warrant author. Before this feature that array only ever held offences, so
 * all three read it raw. It now also holds case law. If any of those three
 * regresses to reading the raw array, an examiner can select
 * "Riley v. California" as the charge on a case, and it will flow into the DA
 * report and onto a warrant affidavit. The wiring assertions at the bottom of
 * this file check all three call sites by source.
 *
 * Run: node modules\__tests__\offense-reference.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OR = require('../offense-reference.js');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + label); }
}
function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log('  FAIL  ' + label + '\n          got ' + a + '\n          want ' + e); }
}
function section(name) { console.log('\n' + name); }

// A localStorage stand-in. `failOn` lets a test force a quota error.
function fakeStorage(seed, failOn) {
    const map = Object.assign({}, seed || {});
    return {
        _map: map,
        getItem: k => (k in map ? map[k] : null),
        setItem: (k, v) => {
            if (failOn && failOn(k, v)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
            map[k] = String(v);
        },
        removeItem: k => { delete map[k]; }
    };
}

const stateRec   = { id: 1, kind: 'state',   code: 'PC 211', description: 'Robbery', type: 'Felony', sentencing: '2, 3, or 5 years', category: 'Robbery / Burglary / Theft', notes: 'mine' };
const fedRec     = { id: 2, kind: 'federal', code: '18 U.S.C. § 2252A', description: 'CSAM', type: 'Class B Felony', sentencing: '5-20 years', category: 'Crimes Against Children / ICAC' };
const caseRec    = { id: 3, kind: 'caselaw', caseName: 'Riley v. California', citation: '573 U.S. 373 (2014)', court: 'U.S. Supreme Court', year: '2014', holding: 'Warrant required for cell phone search incident to arrest.', category: 'Digital Evidence & Cell Phones' };

// ---------------------------------------------------------------------------
section('module surface');

['KIND_STATE', 'KIND_FEDERAL', 'KIND_CASELAW', 'KINDS', 'KIND_META', 'STATE_TYPES',
 'FEDERAL_TYPES', 'CATEGORIES', 'normalize', 'chargeable',
 'isChargeable', 'ofKind', 'dedupeKey', 'displayLabel', 'matchesSearch', 'loadAll',
 'saveAll', 'buildExport', 'parseImport', 'mergeImport', 'categoryLabel', 'typesFor'
].forEach(k => ok(OR[k] !== undefined, 'exports ' + k));

eq(OR.KINDS, ['state', 'federal', 'caselaw'], 'three kinds, state first');
eq(OR.EXPORT_VERSION, 2, 'export format is v2');
eq(OR.STORAGE_KEY, 'viperOffenseReference', 'storage key unchanged from v1 — legacy libraries must keep loading');

// The category IS the kind. There is no second taxonomy to maintain, so
// there is nothing for an officer to get wrong and nothing to fragment
// across agencies on import.
eq(OR.CATEGORIES, ['State', 'Federal', 'Case Law'], 'exactly three categories, and they are the three kinds');
eq(OR.categoryLabel('state'), 'State', 'state category label');
eq(OR.categoryLabel('federal'), 'Federal', 'federal category label');
eq(OR.categoryLabel('caselaw'), 'Case Law', 'case law category label');
eq(OR.categoryLabel('nonsense'), 'State', 'an unknown kind falls back to State, matching normalize()');
ok(OR.categoriesFor === undefined, 'the old per-kind vocabulary accessor is gone, not merely emptied');

// ---------------------------------------------------------------------------
section('normalize — backward compatibility');

// The single most important default in the feature: every record written
// before this release has no `kind` and is always a state offence.
const legacy = OR.normalize({ code: 'PC 459', description: 'Burglary', type: 'Felony' });
eq(legacy.kind, 'state', 'a record with no kind defaults to state');
eq(legacy.category, 'State', 'a v1 record with no kind is categorised State');
ok(!!legacy.createdAt, 'a record with no createdAt gets one');
eq(legacy.code, 'PC 459', 'legacy code preserved');

eq(OR.normalize({ kind: 'FEDERAL', code: 'x', description: 'y' }).kind, 'federal', 'kind is case-insensitive');
eq(OR.normalize({ kind: 'nonsense', code: 'x' }).kind, 'state', 'an unknown kind falls back to state, never to a broken value');
eq(OR.normalize(null), null, 'null in, null out');
eq(OR.normalize('string'), null, 'a non-object is rejected');
eq(OR.normalize({ code: '  PC 211  ' }).code, 'PC 211', 'fields are trimmed');

// Category is derived from kind, never taken from input. A file hand-edited
// or written by a future version cannot inject a category, so there is no
// way to end up with a record whose category contradicts its tab.
eq(OR.normalize({ kind: 'state', category: 'Something Invented' }).category, 'State',
    'an incoming category is ignored and replaced by the kind label');
eq(OR.normalize({ kind: 'caselaw', category: 'Narcotics' }).category, 'Case Law',
    'a case law record is categorised Case Law no matter what the file said');
eq(OR.normalize({ kind: 'federal', code: 'x' }).category, 'Federal',
    'federal records are categorised Federal');
eq(OR.normalize({ code: 'PC 459' }).category, 'State',
    'a v1 record with no kind and no category still gets a sensible category');

section('normalize — case law mirrors');

const cn = OR.normalize(caseRec);
eq(cn.code, '573 U.S. 373 (2014)', 'caselaw.code mirrors the citation');
eq(cn.description, 'Riley v. California', 'caselaw.description mirrors the case name');
ok(typeof cn.code === 'string', 'caselaw.code is a string, so raw consumers calling .toLowerCase() cannot throw');
ok(typeof cn.description === 'string', 'caselaw.description is a string for the same reason');
eq(cn.type, undefined, 'caselaw has no offence type');
eq(cn.sentencing, undefined, 'caselaw has no sentencing');
// A v1-shaped record labelled caselaw should recover its fields from the
// legacy column names rather than coming back blank.
const cnAlt = OR.normalize({ kind: 'caselaw', code: '384 U.S. 436', description: 'Miranda v. Arizona' });
eq(cnAlt.citation, '384 U.S. 436', 'citation falls back to code');
eq(cnAlt.caseName, 'Miranda v. Arizona', 'caseName falls back to description');

// ---------------------------------------------------------------------------
section('chargeable — THE critical invariant');

const lib = [stateRec, fedRec, caseRec].map(r => OR.normalize(r));
eq(OR.chargeable(lib).length, 2, 'chargeable() drops case law');
eq(OR.chargeable(lib).map(r => r.kind), ['state', 'federal'], 'chargeable() keeps state AND federal');
eq(OR.isChargeable(OR.normalize(caseRec)), false, 'case law is not chargeable');
eq(OR.isChargeable(OR.normalize(stateRec)), true, 'a state offence is chargeable');
eq(OR.isChargeable(OR.normalize(fedRec)), true, 'a federal statute is chargeable');
eq(OR.isChargeable(null), false, 'null is not chargeable');
eq(OR.chargeable([]).length, 0, 'empty library is fine');
eq(OR.chargeable(null).length, 0, 'null library does not throw');
// Belt and braces: even an un-normalized raw record must be excluded.
eq(OR.chargeable([{ kind: 'caselaw', caseName: 'x' }]).length, 0, 'raw caselaw records are excluded too');

eq(OR.ofKind(lib, 'state').length, 1, 'ofKind state');
eq(OR.ofKind(lib, 'federal').length, 1, 'ofKind federal');
eq(OR.ofKind(lib, 'caselaw').length, 1, 'ofKind caselaw');

// ---------------------------------------------------------------------------
section('types per kind');

eq(OR.typesFor('state'), ['Felony', 'Misdemeanor', 'Wobbler', 'Infraction', 'Non-Criminal'],
    'state types unchanged — these strings are already persisted in case records');
ok(OR.typesFor('federal').indexOf('Class B Felony') !== -1, 'federal uses 18 U.S.C. 3559 letter classes');
ok(OR.typesFor('federal').indexOf('Wobbler') === -1, 'there is no such thing as a federal wobbler');
eq(OR.typesFor('caselaw'), [], 'case law has no offence type');
// Returned arrays must be copies or a caller could mutate the shipped list.
const typesA = OR.typesFor('state'); typesA.push('MUTATED');
ok(OR.STATE_TYPES.indexOf('MUTATED') === -1, 'typesFor returns a copy, not the live array');

// ---------------------------------------------------------------------------
section('dedupeKey');

const kState = OR.dedupeKey(OR.normalize({ kind: 'state', code: '18-2-101' }));
const kFed   = OR.dedupeKey(OR.normalize({ kind: 'federal', code: '18-2-101' }));
ok(kState !== kFed, 'the same code in two jurisdictions is NOT the same record');
eq(OR.dedupeKey(OR.normalize({ kind: 'state', code: 'PC 211' })),
   OR.dedupeKey(OR.normalize({ kind: 'state', code: 'pc 211' })), 'dedupe is case-insensitive');
eq(OR.dedupeKey(OR.normalize({ kind: 'state', code: 'PC   211' })),
   OR.dedupeKey(OR.normalize({ kind: 'state', code: 'PC 211' })), 'internal whitespace is normalised');
eq(OR.dedupeKey(OR.normalize(caseRec)), 'caselaw|573 u.s. 373 (2014)', 'case law dedupes on citation');
eq(OR.dedupeKey(null), '', 'null dedupeKey does not throw');

// ---------------------------------------------------------------------------
section('display helpers');

eq(OR.displayLabel(OR.normalize(stateRec)), 'PC 211 — Robbery', 'statute label');
eq(OR.displayLabel(OR.normalize(caseRec)), 'Riley v. California, 573 U.S. 373 (2014)', 'case law label');
eq(OR.chargeValue(OR.normalize(stateRec)), 'PC 211 - Robbery',
    'chargeValue uses the exact " - " separator the case editors already persist');

ok(OR.matchesSearch(OR.normalize(stateRec), 'robbery'), 'search matches description');
ok(OR.matchesSearch(OR.normalize(stateRec), 'PC 2'), 'search matches code');
ok(OR.matchesSearch(OR.normalize(stateRec), 'felony'), 'search matches type');
ok(!OR.matchesSearch(OR.normalize(stateRec), 'zzzz'), 'search rejects a miss');
ok(OR.matchesSearch(OR.normalize(stateRec), ''), 'empty search matches everything');
ok(OR.matchesSearch(OR.normalize(caseRec), 'cell phone'), 'case law search reaches the holding');
ok(OR.matchesSearch(OR.normalize(caseRec), 'supreme'), 'case law search reaches the court');
ok(!OR.matchesSearch(OR.normalize(caseRec), 'sentencing exposure'), 'case law search does not match statute-only fields');

// ---------------------------------------------------------------------------
section('loadAll / saveAll');

const s1 = fakeStorage({ viperOffenseReference: JSON.stringify([{ code: 'PC 211', description: 'Robbery' }]) });
eq(OR.loadAll(s1).length, 1, 'loads a legacy array');
eq(OR.loadAll(s1)[0].kind, 'state', 'legacy entries normalise to state on load');
eq(OR.loadAll(fakeStorage({})).length, 0, 'absent key yields an empty library');
eq(OR.loadAll(fakeStorage({ viperOffenseReference: 'not json' })).length, 0, 'corrupt JSON yields empty, not a throw');
eq(OR.loadAll(fakeStorage({ viperOffenseReference: '{"not":"an array"}' })).length, 0, 'a non-array yields empty');
eq(OR.loadAll(null).length, 0, 'no storage yields empty');

// saveAll must never throw: the in-memory library is still valid and an
// exception here would abort the caller mid-render.
let threw = false;
try { eq(OR.saveAll(lib, fakeStorage({}, () => true)), false, 'saveAll reports failure on quota'); }
catch (_e) { threw = true; }
ok(!threw, 'saveAll swallows a quota error rather than throwing');
eq(OR.saveAll(lib, fakeStorage({})), true, 'saveAll reports success');

// ---------------------------------------------------------------------------
section('buildExport');

const exp = OR.buildExport(lib);
eq(exp.version, 2, 'export is v2');
eq(exp.type, 'viper-offense-reference', 'export type string unchanged');
eq(exp.count, 3, 'count covers all kinds');
eq(exp.counts, { state: 1, federal: 1, caselaw: 1 }, 'per-kind counts');
ok(Array.isArray(exp.offenses), 'payload key is still `offenses` so a v1 VIPER can still read the statutes');
ok(!!exp.exportedAt, 'stamped with an export time');

// ---------------------------------------------------------------------------
section('parseImport');

const v2 = OR.parseImport(JSON.stringify(exp));
ok(v2.ok, 'reads its own v2 export');
eq(v2.version, 2, 'reports v2');
eq(v2.records.length, 3, 'round-trips all three kinds');
eq(v2.records.filter(r => r.kind === 'caselaw').length, 1, 'case law survives the round trip');

const v1Payload = { type: 'viper-offense-reference', version: 1, offenses: [
    { code: 'PC 211', description: 'Robbery', type: 'Felony', sentencing: '2/3/5', notes: 'n' },
    { code: 'VC 10851', description: 'Vehicle theft', type: 'Wobbler' }
]};
const v1 = OR.parseImport(JSON.stringify(v1Payload));
ok(v1.ok, 'reads a v1 file');
eq(v1.version, 1, 'reports v1');
eq(v1.records.length, 2, 'all v1 rows imported');
eq(v1.records.every(r => r.kind === 'state'), true, 'every v1 row becomes a state offence');
eq(v1.records[0].notes, 'n', 'v1 notes preserved');

const bare = OR.parseImport(JSON.stringify([{ code: 'PC 187', description: 'Murder' }]));
ok(bare.ok, 'accepts a bare array (hand-rolled files exist in the wild)');
eq(bare.records[0].kind, 'state', 'bare array rows default to state');

eq(OR.parseImport('{oops').ok, false, 'rejects malformed JSON');
ok(OR.parseImport('{oops').error.indexOf('JSON') !== -1, 'the JSON error is explained to the user');
eq(OR.parseImport('{}').ok, false, 'rejects an object with no offence list');
eq(OR.parseImport('null').ok, false, 'rejects null');
eq(OR.parseImport(JSON.stringify({ offenses: [] })).records.length, 0, 'an empty list is ok but yields nothing');
// Blank rows in a hand-edited file must not become blank library entries.
eq(OR.parseImport(JSON.stringify({ offenses: [{ code: '', description: '' }, { code: 'PC 1' }] })).records.length, 1,
    'rows with no identity at all are dropped');
ok(OR.parseImport(exp).ok, 'accepts an already-parsed object, not just a string');

// ---------------------------------------------------------------------------
section('mergeImport');

const mine = [
    OR.normalize({ id: 10, kind: 'state', code: 'PC 211', description: 'Robbery', type: 'Felony', notes: 'MY NOTES', sentencing: 'old' })
];
const theirs = [
    { kind: 'state', code: 'PC 211', description: 'Robbery (2nd)', type: 'Felony', notes: 'THEIR NOTES', sentencing: 'new' },
    { kind: 'state', code: 'PC 459', description: 'Burglary', type: 'Felony' },
    { kind: 'caselaw', caseName: 'Riley v. California', citation: '573 U.S. 373' }
];

const mAll = OR.mergeImport(mine, theirs, 'all');
eq(mAll.added, 2, 'all: two new records added');
eq(mAll.updated, 1, 'all: the collision is updated');
eq(mAll.skipped, 0, 'all: nothing skipped');
eq(mAll.list.length, 3, 'all: final library size');
eq(mAll.list[0].notes, 'THEIR NOTES', 'all: their notes overwrite mine');
eq(mAll.list[0].id, 10, 'all: my original id survives the overwrite');

const mSkip = OR.mergeImport(mine, theirs, 'skip_dupes');
eq(mSkip.added, 2, 'skip: two added');
eq(mSkip.skipped, 1, 'skip: the collision is skipped');
eq(mSkip.updated, 0, 'skip: nothing updated');
eq(mSkip.list[0].notes, 'MY NOTES', 'skip: my record is untouched');
eq(mSkip.list[0].sentencing, 'old', 'skip: my sentencing text is untouched');

const mCore = OR.mergeImport(mine, theirs, 'core_only');
eq(mCore.updated, 1, 'core_only: the collision is updated');
eq(mCore.list[0].notes, 'MY NOTES', 'core_only: MY notes are preserved — they are my work product');
eq(mCore.list[0].description, 'Robbery (2nd)', 'core_only: their description is taken');
eq(mCore.list[0].sentencing, 'new', 'core_only: their sentencing is taken');

// Case law arriving in a shared library must not be silently converted into a
// chargeable offence by the merge.
eq(OR.chargeable(mAll.list).length, 2, 'merged library still excludes case law from charging');
eq(OR.mergeImport([], [], 'all').list.length, 0, 'empty merge is fine');
eq(OR.mergeImport(null, null, 'all').list.length, 0, 'null merge does not throw');

// Every added record must come out with a usable id, or the UI's id-addressing
// collapses and edits hit the wrong row.
ok(OR.mergeImport([], theirs, 'all').list.every(r => r.id != null), 'every merged record has an id');

// ---------------------------------------------------------------------------
section('page UI — rendering');

// Load the UI module the way a real renderer does: window === globalThis.
// A plain `{}` sandbox would let the module's bare identifiers resolve
// somewhere the module itself cannot see (the host-scoping trap).
function loadUi(records, tab) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'offense-reference-ui.js'), 'utf8');
    const store = fakeStorage({ viperOffenseReference: JSON.stringify(records || []) });
    const sandbox = {
        console,
        localStorage: store,
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
            body: { insertAdjacentHTML: () => {} },
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} } })
        },
        setTimeout, Promise, Date, JSON, String, Object, Array, Number
    };
    sandbox.window = sandbox;
    sandbox.OffenseReference = OR;
    sandbox.window.OffenseReference = OR;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'offense-reference-ui.js' });
    const ui = sandbox.window.OffenseReferenceUI;
    if (records) ui._setState(records.map(r => OR.normalize(r)), tab || 'state', '');
    return { ui, sandbox };
}

const { ui, sandbox: uiSandbox } = loadUi([stateRec, fedRec, caseRec], 'state');
ok(!!ui, 'the UI module exposes its test surface');

['showOffenseReference', 'backToOffenseList', 'closeOffenseModal', 'exportOffenseList',
 'importOffenseList', 'executeOffenseImport', 'offenseRefSwitchTab', 'offenseRefView',
 'offenseRefEdit', 'offenseRefAdd', 'offenseRefDelete', 'offenseRefSubmit',
 'offenseRefOnSearch'
].forEach(fn => ok(typeof uiSandbox.window[fn] === 'function', 'installs global ' + fn));
ok(typeof uiSandbox.window.offenseRefOnCategory === 'undefined',
    'no category-filter global — removing the filter must not leave a dangling onchange target');

eq(ui._headersFor('state'), ['Code', 'Description', 'Type', 'Sentencing', 'Actions'], 'state columns');
eq(ui._headersFor('federal'), ['Citation', 'Description', 'Class', 'Sentencing', 'Actions'], 'federal columns say Citation and Class');
eq(ui._headersFor('caselaw'), ['Case Name', 'Citation', 'Court', 'Year', 'Actions'], 'case law has entirely different columns');
// No Category column anywhere: every row on a tab would carry the same
// value, which is noise.
OR.KINDS.forEach(k => ok(ui._headersFor(k).indexOf('Category') === -1,
    'no Category column on the ' + k + ' tab — the tab is the category'));

const stateRows = ui._rowsHtml();
ok(stateRows.indexOf('PC 211') !== -1, 'state tab shows the state offence');
ok(stateRows.indexOf('2252A') === -1, 'state tab does NOT show the federal statute');
ok(stateRows.indexOf('Riley') === -1, 'state tab does NOT show case law');

ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'caselaw', '');
const caseRows = ui._rowsHtml();
ok(caseRows.indexOf('Riley v. California') !== -1, 'case law tab shows the case');
ok(caseRows.indexOf('U.S. Supreme Court') !== -1, 'case law tab shows the court');
ok(caseRows.indexOf('PC 211') === -1, 'case law tab does not show statutes');

ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'federal', '');
ok(ui._rowsHtml().indexOf('2252A') !== -1, 'federal tab shows the federal statute');

// Search is the only narrowing control left.
ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'state', 'zzzz');
ok(ui._rowsHtml().indexOf('No entries match') !== -1, 'a search miss shows the empty-result row');
ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'state', 'robbery');
ok(ui._rowsHtml().indexOf('PC 211') !== -1, 'search matches the description case-insensitively');
ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'federal', 'federal');
ok(ui._rowsHtml().indexOf('2252A') !== -1, 'the derived category keeps the word "federal" searchable');

const filterBar = ui._filterBarHtml();
ok(filterBar.indexOf('offenseSearch') !== -1, 'the filter bar still has the search box');
ok(filterBar.indexOf('<select') === -1, 'the filter bar has no category dropdown');
ok(filterBar.indexOf('All Categories') === -1, 'no leftover "All Categories" option');

// Tab bar counts
ui._setState([stateRec, fedRec, caseRec].map(r => OR.normalize(r)), 'state', '');
const bar = ui._tabBarHtml();
['Offenses', 'Federal Statutes', 'Case Law'].forEach(l => ok(bar.indexOf(l) !== -1, 'tab bar shows "' + l + '"'));

section('page UI — escaping');

// These records come from files shared between agencies. They are not trusted.
const nasty = OR.normalize({
    id: 99, kind: 'state', type: 'Felony', category: 'Narcotics',
    code: '<img src=x onerror=alert(1)>',
    description: 'Tom & Jerry\'s "quoted" <b>bold</b>',
    sentencing: '</td></tr><script>alert(2)</script>'
});
ui._setState([nasty], 'state', '');
const nastyRows = ui._rowsHtml();
ok(nastyRows.indexOf('<img src=x') === -1, 'a script-injecting code is escaped');
ok(nastyRows.indexOf('<script>') === -1, 'a script tag in sentencing text is escaped');
// The literal text "onerror=" survives as inert escaped content — that is
// correct and expected. What matters is that it is not inside a real tag,
// i.e. the angle brackets that would have opened one are encoded.
ok(nastyRows.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1,
    'the whole injected tag is rendered as escaped text, not as an element');
ok(nastyRows.indexOf('&lt;/td&gt;&lt;/tr&gt;') !== -1,
    'an attempt to close the table cell early is escaped');
ok(nastyRows.indexOf('&amp;') !== -1, 'an ampersand is encoded rather than corrupting the markup');
ok(nastyRows.indexOf('&lt;b&gt;bold&lt;/b&gt;') !== -1, 'inline markup is shown as text');
ok(nastyRows.indexOf('&#39;') !== -1, 'an apostrophe is encoded so it cannot close an attribute');

// The id is interpolated into an onclick attribute; a quote in it would break out.
const quoteId = OR.normalize({ id: "1');alert(1);('", kind: 'state', code: 'X', description: 'Y', type: 'Felony' });
ui._setState([quoteId], 'state', '');
const quoteRows = ui._rowsHtml();
ok(quoteRows.indexOf("');alert(1);('") === -1, 'a quote in an id cannot break out of the onclick attribute');

section('page UI — form bodies');

ui._setState([], 'state', '');
const fState = ui._formBody('state', null);
ok(fState.indexOf('offense_code') !== -1, 'state form has a code field');
ok(fState.indexOf('offense_sentencing') !== -1, 'state form has a sentencing field');
ok(fState.indexOf('Wobbler') !== -1, 'state form offers Wobbler');
ok(fState.indexOf('offense_caseName') === -1, 'state form has no case-name field');
// The examiner is never asked to pick a category — it is derived from the
// tab they are already on.
OR.KINDS.forEach(k => ok(ui._formBody(k, null).indexOf('offense_category') === -1,
    'the ' + k + ' form has no category picker'));

const fFed = ui._formBody('federal', null);
ok(fFed.indexOf('Class B Felony') !== -1, 'federal form offers letter classes');
ok(fFed.indexOf('Wobbler') === -1, 'federal form does not offer Wobbler');
ok(fFed.indexOf('U.S.C.') !== -1, 'federal form hints the U.S.C. citation format');

const fCase = ui._formBody('caselaw', null);
ok(fCase.indexOf('offense_caseName') !== -1, 'case law form has a case-name field');
ok(fCase.indexOf('offense_citation') !== -1, 'case law form has a citation field');
ok(fCase.indexOf('offense_court') !== -1, 'case law form has a court field');
ok(fCase.indexOf('offense_holding') !== -1, 'case law form has a holding field');
ok(fCase.indexOf('offense_sentencing') === -1, 'case law form has NO sentencing field');
ok(fCase.indexOf('offense_type') === -1, 'case law form has NO offence type field');

// Editing pre-fills, and the pre-filled values must be escaped too.
const fEdit = ui._formBody('state', OR.normalize({ code: 'PC "1"', description: 'A & B', type: 'Felony', notes: '<i>x</i>' }));
ok(fEdit.indexOf('value="PC &quot;1&quot;"') !== -1, 'a quote in a pre-filled value is escaped');
ok(fEdit.indexOf('&lt;i&gt;x&lt;/i&gt;') !== -1, 'notes are escaped inside the textarea');
ok(fEdit.indexOf('<option value="Felony" selected>') !== -1, 'the record\'s offence type is pre-selected');

// ---------------------------------------------------------------------------
section('host wiring — the three charge pickers');

const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const detail = fs.readFileSync(path.join(__dirname, '..', '..', 'case-detail-with-analytics.html'), 'utf8');
const warrant = fs.readFileSync(path.join(__dirname, '..', 'warrant-author', 'warrant-author-ui.js'), 'utf8');

ok(idx.indexOf('modules/offense-reference.js') !== -1, 'index.html loads the schema module');
ok(idx.indexOf('modules/offense-reference-ui.js') !== -1, 'index.html loads the page UI module');
ok(idx.indexOf('modules/offense-reference.js') < idx.indexOf('modules/offense-reference-ui.js'),
    'schema loads BEFORE the UI — the UI reads window.OffenseReference at load time');
ok(detail.indexOf('modules/offense-reference.js') !== -1, 'case-detail loads the schema module');
ok(detail.indexOf('modules/offense-reference.js') < detail.indexOf('warrant-author/warrant-author-ui.js'),
    'schema loads before warrant-author, which depends on it');

// Picker 1 — Create Case.
ok(idx.indexOf('OffenseReference.chargeable') !== -1, 'Create Case picker calls chargeable()');
// Picker 2 — Case Overview.
ok(detail.indexOf('_chargeableOffenseLib') !== -1, 'Case Overview defines a chargeable-only accessor');
// Three consumers, plus the definition itself. Count the call form only so
// the definition does not inflate the number.
eq((detail.match(/const offenses = _chargeableOffenseLib\(\);/g) || []).length, 3,
    'all three Case Overview call sites use it (options list, row prefill, library check)');
eq((detail.match(/_lsParse\('viperOffenseReference'/g) || []).length, 1,
    'exactly one raw read remains, and it is the fallback inside the accessor');
ok(detail.indexOf("_lsParse('viperOffenseReference'") !== -1,
    'Case Overview keeps a raw fallback so the editor degrades rather than emptying if the module fails to load');
// Picker 3 — warrant author.
ok(warrant.indexOf('OffenseReference.chargeable') !== -1, 'warrant author calls chargeable()');
ok(warrant.indexOf("o.kind !== 'caselaw'") !== -1, 'warrant author fallback path also excludes case law');

// The old inline implementation must be fully gone from index.html, or two
// copies of these globals would fight over window.
['function loadOffenses', 'function renderOffenseReferenceView', 'function addNewOffense',
 'function saveOffenseForm', 'function updateOffenseForm', 'function showOffenseImportOptions'
].forEach(fn => ok(idx.indexOf(fn) === -1, 'inline "' + fn + '" removed from index.html'));
ok(idx.indexOf('onclick="showOffenseReference()"') !== -1, 'the sidebar still calls showOffenseReference()');

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(52));
console.log(`offense-reference: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
