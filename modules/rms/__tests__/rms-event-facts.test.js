// RMS Import tab — Event Information card for supplements.
// Lifts the shipping _rmsEventFacts() out of case-detail-with-analytics.html
// and runs it over the Apache Junction synthetic fixtures parsed by the real
// AjIncidentParser.
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('\n        function _rmsEventFacts(');
const end = html.indexOf('\n        }\n', start + 1);
if (start < 0 || end < 0) throw new Error('_rmsEventFacts not found');
const _rmsEventFacts = new Function(html.slice(start + 1, end + 10) + '\nreturn _rmsEventFacts;')();

const AJ = require('../aj-incident-parser.js');
const fx = n => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8');
const base = AJ.parse(fx('aj-incident-report.synthetic.txt'), 'report.pdf');
const narr = AJ.parse(fx('aj-narrative-supplement.synthetic.txt'), 'narr.pdf');
const fore = AJ.parse(fx('aj-forensic-supplement.synthetic.txt'), 'fore.pdf');

console.log('\n── fixtures');
ok('base report has a location', !!base.location, base.location);
ok('base report has from/to', !!base.fromDateTime && !!base.toDateTime, [base.fromDateTime, base.toDateTime]);
ok('narrative supplement prints no location', !narr.location);
ok('narrative supplement is a supplement', !!narr.supplementNo);
ok('narrative supplement shares the incident number', narr.reportNumber === base.reportNumber, [narr.reportNumber, base.reportNumber]);

console.log('\n── inheritance');
let e = _rmsEventFacts(narr, [base, narr]);
ok('supplement shows the report location', e.location === base.location, e);
ok('supplement shows From', e.fromDateTime === base.fromDateTime, e);
ok('supplement shows To', e.toDateTime === base.toDateTime, e);
ok('note names the source report', e.inheritedFrom === 'Incident Report', e.inheritedFrom);
e = _rmsEventFacts(narr, [narr, base]);
ok('order-independent', e.location === base.location);
const before = JSON.stringify(narr);
_rmsEventFacts(narr, [base, narr]);
ok('stored supplement is not mutated', JSON.stringify(narr) === before);

console.log('\n── no inheritance');
e = _rmsEventFacts(base, [base, narr]);
ok('base report shows its own facts, no note', e.location === base.location && !e.inheritedFrom, e);
e = _rmsEventFacts(narr, [narr]);
ok('supplement alone stays blank', !e.location && !e.fromDateTime && !e.inheritedFrom, e);
e = _rmsEventFacts(fore, [base, fore]);
ok('different incident number does not borrow', fore.reportNumber === base.reportNumber ? true : (!e.location && !e.inheritedFrom), [fore.reportNumber, e]);
const other = Object.assign({}, base, { reportNumber: '111' });
e = _rmsEventFacts(narr, [other, narr]);
ok('mismatched number does not borrow', !e.location && !e.inheritedFrom, e);
const otherSupp = Object.assign({}, base, { supplementNo: 'Narrative Supplement' });
e = _rmsEventFacts(narr, [otherSupp, narr]);
ok('never borrows from another supplement', !e.location && !e.inheritedFrom, e);
const own = Object.assign({}, narr, { location: '1 OWN ST' });
e = _rmsEventFacts(own, [base, own]);
ok('a filled field is never replaced', e.location === '1 OWN ST', e);
ok('blank fields still borrowed beside a filled one', e.fromDateTime === base.fromDateTime && e.inheritedFrom === 'Incident Report', e);
const noNum = Object.assign({}, narr, { reportNumber: '' });
e = _rmsEventFacts(noNum, [Object.assign({}, base, { reportNumber: '' }), noNum]);
ok('blank incident number never matches', !e.location, e);
const twin = Object.assign({}, base, { location: '' });
e = _rmsEventFacts(twin, [base, twin]);
ok('a base report never borrows (only supplements do)', !e.location && !e.inheritedFrom, e);
e = _rmsEventFacts(null, null);
ok('null-safe', e && e.location === '' && e.inheritedFrom === '', e);
e = _rmsEventFacts(narr, [null, undefined, base]);
ok('tolerates null rows in the list', e.location === base.location, e);

console.log('\n── wiring (renderRmsReportDetail)');
const rs = html.indexOf('\n        function renderRmsReportDetail(');
const card = html.slice(rs, html.indexOf("const offensesHtml", rs) > 0 ? html.indexOf("const offensesHtml", rs) : rs + 4000);
ok('detail calls _rmsEventFacts(rpt, rmsImports)', /_rmsEventFacts\(rpt, rmsImports\)/.test(card));
for (const k of ['location', 'beat', 'fromDateTime', 'toDateTime']) {
    ok('Event card reads ev.' + k, card.indexOf('${ev.' + k + " || '—'}") > 0);
    ok('Event card does not read rpt.' + k, card.indexOf('${rpt.' + k + " || '—'}") < 0);
}
ok('Event card shows the borrowed-from note', /ev\.inheritedFrom \?/.test(card));

console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
