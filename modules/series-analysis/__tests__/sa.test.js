/*
 * Series Analysis: model math, parsing, compare, likely-next, map tiles, wiring.
 *   node modules/series-analysis/__tests__/sa.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../sa-model.js');
const { incidents13 } = require('./sa-fixture');

let pass = 0, fail = 0;
function ok(label, cond) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    const good = JSON.stringify(actual) === JSON.stringify(expected);
    if (!good) console.log('  FAIL: ' + label + '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual));
    good ? pass++ : fail++;
}
function near(a, b, tol, label) { ok(label + ' (' + a + ' ≈ ' + b + ')', typeof a === 'number' && Math.abs(a - b) <= tol); }

const COLS = M.TEMPLATES.property.columns;
const store = M.normalizeStore({ incidents: incidents13(), geoHint: 'Denver, CO' });
const INC = store.incidents;

// ── parsing ─────────────────────────────────────────────────────────
eq(M.parseDate('2026-10-03'), '2026-10-03', 'parseDate ISO');
eq(M.parseDate('2026-10-03T02:10'), '2026-10-03', 'parseDate ISO datetime');
eq(M.parseDate('10/3/2026'), '2026-10-03', 'parseDate M/D/YYYY');
eq(M.parseDate('10-03-26'), '2026-10-03', 'parseDate M-D-YY');
eq(M.parseDate('10.3.2026'), '2026-10-03', 'parseDate dots');
eq(M.parseDate('Oct 3, 2026'), '2026-10-03', 'parseDate Mon D, YYYY');
eq(M.parseDate('3 October 2026'), '2026-10-03', 'parseDate D Month YYYY');
eq(M.parseDate('20261003'), '2026-10-03', 'parseDate compact');
eq(M.parseDate(new Date(2026, 9, 3, 12)), '2026-10-03', 'parseDate Date');
eq(M.parseDate('2/30/2026'), '', 'parseDate rejects 2/30');
eq(M.parseDate('garbage'), '', 'parseDate garbage');

eq(M.parseTime('0230'), '02:30', 'parseTime 0230');
eq(M.parseTime('230'), '02:30', 'parseTime 230');
eq(M.parseTime('2:30'), '02:30', 'parseTime 2:30');
eq(M.parseTime('02:30:15'), '02:30', 'parseTime seconds');
eq(M.parseTime('2:30 AM'), '02:30', 'parseTime AM');
eq(M.parseTime('2:30pm'), '14:30', 'parseTime pm');
eq(M.parseTime('12:05 AM'), '00:05', 'parseTime 12:05 AM');
eq(M.parseTime('12:05 PM'), '12:05', 'parseTime 12:05 PM');
eq(M.parseTime('1400 hrs'), '14:00', 'parseTime hrs');
eq(M.parseTime('25:00'), '', 'parseTime rejects 25:00');

eq(M.parseDateTime('10/03/2026 02:10'), { date: '2026-10-03', time: '02:10' }, 'parseDateTime US');
eq(M.parseDateTime('2026-10-03T02:10:00'), { date: '2026-10-03', time: '02:10' }, 'parseDateTime ISO');
eq(M.parseDateTime('Oct 3 2026 2:10 PM'), { date: '2026-10-03', time: '14:10' }, 'parseDateTime words');
eq(M.parseDateTime('10/03/2026'), { date: '2026-10-03', time: '' }, 'parseDateTime date only');

eq(M.parseTimeRange('0130-0545'), { from: '01:30', to: '05:45' }, 'range dash');
eq(M.parseTimeRange('01:30 – 05:45'), { from: '01:30', to: '05:45' }, 'range en dash');
eq(M.parseTimeRange('1:30am to 5:45am'), { from: '01:30', to: '05:45' }, 'range to');
eq(M.parseTimeRange('between 2300 and 0600'), { from: '23:00', to: '06:00' }, 'range between');
eq(M.parseTimeRange('1:30-5:45pm'), { from: '13:30', to: '17:45' }, 'range carries pm');
eq(M.parseTimeRange('11:30-1:45pm'), { from: '11:30', to: '13:45' }, 'range does not carry pm past end');
eq(M.parseTimeRange('0215'), { from: '02:15', to: '' }, 'range single');

// ── store ───────────────────────────────────────────────────────────
const empty = M.normalizeStore(null);
eq(empty.template, 'property', 'empty template');
eq(empty.columns.length, 6, 'empty columns from template');
ok('empty arrays', Array.isArray(empty.incidents) && Array.isArray(empty.cameras) && Array.isArray(empty.observations));
eq(store.geoHint, 'Denver, CO', 'unknown top-level field preserved');
const ni = M.normalizeIncident({ date: '10/3/26', timeFrom: '2:10 am', lat: '39.7', lng: 'x', attrs: { extra: ' v ' }, custom: 7 });
ok('normalizeIncident id', /^inc_/.test(ni.id));
eq([ni.date, ni.timeFrom, ni.lat, ni.lng, ni.attrs.extra, ni.custom, ni.source.type], ['2026-10-03', '02:10', null, null, 'v', 7, 'manual'], 'normalizeIncident coerce');
eq(M.normalizeStore({ incidents: [1, null, 'x', {}] }).incidents.length, 1, 'non-object incidents dropped');
eq(M.normalizeStore({ template: 'homicide' }).columns[0].key, 'causeOfDeath', 'columns default from template');

// ── CSV ─────────────────────────────────────────────────────────────
const csv = '\ufeffReport #,Occurred Date,Time Range,Location,Suspect Vehicle,MO,Notes\r\n' +
    '26-1,10/06/2026,0140-0300,"2205 W 41st Ave, Denver",Silver Nissan Altima,"Battery saw, ""fast""",x\r\n' +
    ',,,,,,\r\n' +
    '26-2,10/07/2026 01:30,,,Dark SUV,Jack,\n' +
    '26-3,,,,,,only notes\n';
const rows = M.parseCsv(csv);
eq(rows.length, 4, 'parseCsv drops blank rows');
eq(rows[1][3], '2205 W 41st Ave, Denver', 'parseCsv quoted comma');
eq(rows[1][5], 'Battery saw, "fast"', 'parseCsv escaped quotes');
eq(M.parseCsv('a\tb\tc\n1\t2\t3').length, 2, 'parseCsv tab');
eq(M.parseCsv('a\tb\tc\n1\t2\t3')[1][2], '3', 'parseCsv tab cells');
eq(M.parseCsv('a;b;c\n1;2;3')[0], ['a', 'b', 'c'], 'parseCsv semicolon');
const mp = M.guessMapping(rows[0], COLS);
eq([mp.reportNo, mp.date, mp.timeRange, mp.address, mp.suspectVehicle, mp.method, mp.notes], [0, 1, 2, 3, 4, 5, 6], 'guessMapping');
const conv = M.rowsToIncidents(rows, mp, {});
eq(conv.incidents.length, 2, 'rowsToIncidents count');
eq(conv.skipped.length, 1, 'rowsToIncidents skipped');
eq(conv.skipped[0].reason, 'no date or address', 'skip reason');
eq([conv.incidents[0].timeFrom, conv.incidents[0].timeTo], ['01:40', '03:00'], 'time range mapped');
eq([conv.incidents[1].date, conv.incidents[1].timeFrom], ['2026-10-07', '01:30'], 'datetime in date cell');
eq(conv.incidents[0].attrs.suspectVehicle, 'Silver Nissan Altima', 'attrs filled');
eq(conv.incidents[0].source.type, 'csv', 'csv source');
const tpl = M.csvTemplate(COLS);
ok('csvTemplate header', tpl.indexOf('Report #,Date,Time From,Time To,Address,Latitude,Longitude,Offense,Target / property') === 0 && /,Notes$/.test(tpl));
const tplMap = M.guessMapping(M.parseCsv(tpl)[0], COLS);
eq(Object.keys(tplMap).length, 9 + COLS.length, 'template headers round-trip through guessMapping');

// ── ordering & time ─────────────────────────────────────────────────
eq(M.dowOf('2026-10-01'), 4, 'Oct 1 2026 is a Thursday');
const ch = M.chrono(INC);
eq(ch[0].id, 'inc_1', 'chrono first');
eq(ch[ch.length - 1].id, 'inc_13', 'chrono last');
const sq = M.seqMap(INC);
eq([sq.inc_1, sq.inc_13], [1, 13], 'seqMap');
const crossA = M.normalizeIncident({ id: 'a', date: '2026-10-05', timeFrom: '23:00', timeTo: '06:00' });
const earlyB = M.normalizeIncident({ id: 'b', date: '2026-10-05', timeFrom: '01:00' });
eq(M.chrono([earlyB, crossA]).map(x => x.id), ['a', 'b'], 'cross-midnight sorts by previous evening');
eq(M.chrono([M.normalizeIncident({ id: 'u' }), earlyB]).map(x => x.id), ['b', 'u'], 'undated last');

const g = M.hourWeights(INC);
const total = g.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
near(total, 13, 1e-9, 'hourWeights total = incidents');
const gx = M.hourWeights([crossA]);
near(gx[0][23], 1 / 7, 1e-9, 'cross window starts Sun 23:00');      // 10/05 is Mon → starts Sun
near(gx[1][5], 1 / 7, 1e-9, 'cross window ends Mon 05:00');
eq(gx[1][6], 0, 'window ending on the hour excludes that hour');
const gu = M.hourWeights([M.normalizeIncident({ date: '2026-10-05' })]);
near(gu[1][12], 1 / 24, 1e-9, 'unknown time spread over day');
const pk = M.peakWindow(g);
ok('peak window in early morning (' + (pk && pk.label) + ')', pk && pk.startHour >= 0 && pk.startHour <= 2);
ok('peak days include Tue–Thu (' + (pk && pk.daysLabel) + ')', pk && [2, 3, 4].every(d => pk.days.indexOf(d) >= 0));
ok('peak share > 0.4', pk && pk.share > 0.4);
eq(M.peakWindow(M.hourWeights([])), null, 'peak null when empty');
const wrap = M.peakWindow(M.hourWeights([M.normalizeIncident({ date: '2026-10-05', timeFrom: '23:30' }), M.normalizeIncident({ date: '2026-10-05', timeFrom: '00:30' }), M.normalizeIncident({ date: '2026-10-05', timeFrom: '01:10' })]));
eq(wrap.label, '23–02', 'peak window wraps midnight');
eq(M.dayWeights(g).length, 7, 'dayWeights');

const gs = M.gapStats(INC);
eq(gs.spanDays, 21, 'span days');
eq(gs.gaps.length, 12, 'gap count');
near(gs.avg, 21 / 12, 1e-9, 'avg gap');
ok('trend set', ['tightening', 'steady', 'widening'].indexOf(gs.trend) >= 0);
eq(M.gapStats(INC.slice(0, 1)), null, 'gapStats null with 1');

// ── spatial ─────────────────────────────────────────────────────────
near(M.haversine({ lat: 39.75, lng: -105 }, { lat: 39.76, lng: -105 }), 1112, 3, 'haversine 0.01° lat');
const sp = M.spatial(INC);
eq(sp.n, 12, 'spatial uses located only');
ok('ellipse major ≥ minor', sp.ellipse.sx_m >= sp.ellipse.sy_m);
ok('drift computed', !!sp.drift);
ok('drift heads east (' + (sp.drift && sp.drift.compass) + ')', sp.drift && ['E', 'NE', 'SE'].indexOf(sp.drift.compass) >= 0);
ok('drift ≈ 0.3–0.6 mi/week (' + (sp.drift && sp.drift.milesPerWeek.toFixed(2)) + ')', sp.drift && sp.drift.milesPerWeek > 0.2 && sp.drift.milesPerWeek < 0.8);
const ep = M.ellipsePolygon(sp.ellipse, 24);
eq(ep.length, 24, 'ellipsePolygon steps');
const cp = M.circlePolygon({ lat: 39.75, lng: -105 }, 500, 12);
near(M.haversine({ lat: 39.75, lng: -105 }, { lat: cp[3][0], lng: cp[3][1] }), 500, 2, 'circlePolygon radius');
eq(M.spatial(INC.slice(0, 1)), null, 'spatial null with 1');

// ── likely next ─────────────────────────────────────────────────────
const nx = M.likelyNext(INC, { now: '2026-10-23' });
eq(nx.basis, 'observed', 'basis observed');
ok('window starts on/after now', nx.window.start >= '2026-10-23');
ok('window ≤ 4 days', M.dayNum(nx.window.end) - M.dayNum(nx.window.start) <= 3);
ok('window label', /^[A-Z][a-z]{2} \d+\/\d+/.test(nx.window.label));
ok('hours label', /^\d\d:00–\d\d:00$/.test(nx.window.hoursLabel));
ok('area', nx.area && nx.area.radius_m >= 150);
ok('area east of first hits', nx.area && nx.area.center.lng > -105.0);
eq(nx.confidence, 'moderate', 'confidence moderate (13 hits, strong peak)');
ok('reasons say not a prediction model', nx.reasons.some(r => /not a prediction model/.test(r)));
ok('no "predict" claims elsewhere', nx.reasons.filter(r => /predict/i.test(r)).every(r => /not a prediction model/.test(r)));
eq(M.likelyNext(INC.slice(0, 3)), null, 'likelyNext null with 3');
const overdue = M.likelyNext(INC, { now: '2027-03-01' });
ok('overdue still returns a window', overdue && overdue.window.start >= '2027-03-01');
ok('overdue reason', overdue.reasons.some(r => /past its usual spacing/.test(r)));
const small = M.likelyNext(INC.slice(0, 4));
eq(small.confidence, 'low', 'low confidence with 4');

// ── compare ─────────────────────────────────────────────────────────
eq(M.normValue('  Silver  Nissan Altima. '), 'silver nissan altima', 'normValue');
eq(['—', 'N/A', 'unk', 'Unknown', '?', ''].map(M.normValue), ['', '', '', '', '', ''], 'normValue unknowns');
eq(M.splitValues('2 M, dark hoodies; one w/ headlamp'), ['2 M, dark hoodies', 'one w/ headlamp'], 'splitValues ; not comma');
eq(M.splitValues('a · b | c / d\ne'), ['a', 'b', 'c', 'd', 'e'], 'splitValues separators');
const sh = M.shared(INC, COLS);
eq(sh.suspectVehicle[0].display, 'Silver Nissan Altima', 'top vehicle');
eq(sh.suspectVehicle[0].count, 5, 'Altima at 5');
eq(sh.suspectVehicle[1].count, 2, 'Dark SUV at 2');
ok('shared only ≥2', Object.keys(sh).every(k => sh[k].every(x => x.count >= 2)));
eq(sh.target.filter(x => x.value === '2011 honda element').length, 1, 'target exact repeats');
const mx = M.matrix(INC, COLS);
eq(mx.length, 13, 'matrix rows');
eq(mx[0].n, 1, 'matrix numbered');
ok('Altima part flagged shared', mx[0].cells.suspectVehicle.parts[0].shared && mx[0].cells.suspectVehicle.parts[0].count === 5);
const susp3 = mx[2].cells.suspects.parts;
eq(susp3.length, 2, 'multi-value cell split');
eq(M.filterByValue(INC, 'suspectVehicle', 'silver nissan altima').length, 5, 'filterByValue');

// ── kpis & summary ──────────────────────────────────────────────────
const k = M.kpis(INC, COLS, { now: '2026-10-23' });
eq(k.count, 13, 'kpi count');
eq(k.spanDays, 21, 'kpi span');
ok('kpi top is target col or a shared value', k.top && k.top.count >= 2);
ok('kpi next', k.next && k.next.window);
const sum = M.summary(INC, COLS, { now: '2026-10-23' });
ok('summary has lines (' + sum.length + ')', sum.length >= 4);
ok('summary no HTML', sum.every(x => !/[<>]/.test(x)));
ok('summary mentions Altima', sum.some(x => /Silver Nissan Altima/.test(x) && /#1, #3, #5, #7, #11/.test(x)));
ok('summary drift', sum.some(x => /mi E|mi NE|mi SE/.test(x)));
ok('summary data gaps', sum.some(x => /Data gaps/.test(x)));
ok('summary exact span', sum.some(x => /Every exact time is between \*\*01:40 and 03:05\*\*/.test(x)));
eq(M.summary([], COLS), [], 'summary empty');

// ── fromCase ────────────────────────────────────────────────────────
const fc = M.fromCase({ id: 'c9', caseNumber: '25-777', offenseDate: '2025-06-01', locationOfOccurrence: '1 Main St', primaryOffense: 'Homicide', caseName: 'River body' },
    { suspects: [{ firstName: 'John', lastName: 'Doe' }, { name: 'Ann Roe' }], victims: [{ name: 'Jane', age: 34, sex: 'F' }] });
eq([fc.reportNo, fc.date, fc.address, fc.offense, fc.notes], ['25-777', '2025-06-01', '1 Main St', 'Homicide', 'River body'], 'fromCase fields');
eq(fc.attrs.suspects, 'John Doe; Ann Roe', 'fromCase suspects');
eq(fc.attrs.victimProfile, 'Jane (34/F)', 'fromCase victims');
eq(fc.source, { type: 'case', caseId: 'c9', caseNumber: '25-777' }, 'fromCase source');

// ── static map tiles ────────────────────────────────────────────────
const p0 = M.projectPx(0, 0, 0);
eq([p0.x, p0.y], [128, 128], 'projectPx origin');
const pts = INC.filter(M.hasGeo).map(i => [i.lat, i.lng]);
const mos = M.tileMosaic(pts, 700, 360, { padPx: 30 });
ok('mosaic zoom 13–17 (' + mos.zoom + ')', mos.zoom >= 13 && mos.zoom <= 17);
ok('all points inside viewport', pts.every(p => { const v = M.toViewport(mos, p[0], p[1]); return v.x >= 0 && v.x <= 700 && v.y >= 0 && v.y <= 360; }));
ok('tiles cover viewport', mos.tiles.some(t => t.left <= 0 && t.top <= 0) && mos.tiles.some(t => t.left + 256 >= 700 && t.top + 256 >= 360));
eq(M.tileMosaic([[39.75, -105]], 400, 300).zoom, 15, 'single point zoom 15');
eq(M.tileMosaic([], 400, 300), null, 'empty mosaic null');
near(M.metersPerPixel(0, 0), 156543.03, 0.1, 'metersPerPixel');

// ── footage clock maths (sa-footage.js) ─────────────────────────────
const F = require('../sa-footage.js');
eq(F.fmtStamp(F.parseStamp('2026-10-14 02:30:00')), '2026-10-14 02:30:00', 'parseStamp ISO');
eq(F.fmtStamp(F.parseStamp('2026-10-14T02:30')), '2026-10-14 02:30:00', 'parseStamp T, no seconds');
eq(F.fmtStamp(F.parseStamp('10/14/2026 2:30:05 PM')), '2026-10-14 14:30:05', 'parseStamp US pm');
eq(F.fmtStamp(F.parseStamp('10/14/26 12:05 am')), '2026-10-14 00:05:00', 'parseStamp 12 am');
eq(F.parseStamp('2026-02-30 01:00'), null, 'parseStamp rejects Feb 30');
eq(F.parseStamp('nonsense'), null, 'parseStamp junk');
eq(F.stampFromFileName('CH02_20261014_023000.mp4'), '2026-10-14 02:30:00', 'file name stamp compact');
eq(F.stampFromFileName('Front Lot 2026-10-14 02-31-15.avi'), '2026-10-14 02:31:15', 'file name stamp dashed');
eq(F.stampFromFileName('NVR_ch3_main_20261014023000_20261014030000.dav'), '2026-10-14 02:30:00', 'file name stamp first of a range');
eq(F.stampFromFileName('IMG_1234.mov'), '', 'no stamp in file name');
eq(F.parseOffset('+3:00'), 180, 'offset +m:ss');
eq(F.parseOffset('-1:02:03'), -3723, 'offset -h:mm:ss');
eq(F.parseOffset('\u22122:34'), -154, 'offset unicode minus');
eq(F.parseOffset('90'), 90, 'offset bare seconds');
eq(F.parseOffset('2m 34s'), 154, 'offset 2m 34s');
eq(F.parseOffset(''), 0, 'offset empty is 0');
eq(F.parseOffset('soon'), null, 'offset junk');
eq(F.fmtOffset(154), '+2:34', 'fmtOffset +');
eq(F.fmtOffset(-3723), '-1:02:03', 'fmtOffset h');
eq(F.fmtOffset(0), '0:00', 'fmtOffset 0');
eq(F.fmtDur(3725.9), '1:02:05', 'fmtDur h');
eq(F.fmtDur(65), '01:05', 'fmtDur m');
const cam = { startDvr: '2026-10-14 02:30:00', offsetSec: 154 };
const ck = F.clockAt(cam, 90);
eq(F.fmtStamp(ck.dvr), '2026-10-14 02:31:30', 'clockAt DVR');
eq(F.fmtStamp(ck.real), '2026-10-14 02:34:04', 'clockAt real = DVR + correction');
eq(F.clockAt({ startDvr: '' }, 10), null, 'clockAt without a clock');
near(F.videoSecAt(cam, F.parseStamp('2026-10-14 02:34:04')), 90, 0.001, 'videoSecAt inverts clockAt');
const w1 = F.windowFor(cam, { date: '2026-10-14', timeFrom: '02:40', timeTo: '03:10' });
near(w1.from, 600 - 154, 0.001, 'window from (secs into video)');
near(w1.to, 2400 - 154, 0.001, 'window to');
ok('window not exact', w1.exact === false);
const w2 = F.windowFor({ startDvr: '2026-10-13 23:00:00', offsetSec: 0 }, { date: '2026-10-13', timeFrom: '23:30', timeTo: '01:00' });
near(w2.to - w2.from, 5400, 0.001, 'window across midnight is 90 min');
const w3 = F.windowFor(cam, { date: '2026-10-14', timeFrom: '02:40' });
ok('exact time padded ±10 min', w3.exact && Math.abs((w3.to - w3.from) - 1200) < 0.001);
eq(F.windowFor(cam, { date: '2026-10-14' }), null, 'no time, no window');
eq(F.offsetFromSync({ startDvr: '2026-10-14 02:30:00', offsetSec: 0 }, 60, '02:34:00'), 180, 'sync: 3 min slow → +3:00');
eq(F.offsetFromSync({ startDvr: '2026-10-14 23:59:00', offsetSec: 0 }, 0, '00:01:00'), 120, 'sync across midnight');
eq(F.offsetFromSync({ startDvr: '2026-10-14 02:30:00' }, 0, '2:25 am'), -300, 'sync fast recorder, am');
eq(F.offsetFromSync({ startDvr: '' }, 0, '02:00:00'), null, 'sync needs a DVR start');
const evs = F.evidenceVideos([
    { id: 1, tag: 'E1', description: 'Rear lot DVR', files: [{ name: 'ch2.mp4', path: 'C:\\e\\ch2.mp4' }, { name: 'notes.pdf', path: 'C:\\e\\n.pdf' }] },
    { id: 2, files: [{ name: 'export', path: 'C:\\e\\x', type: 'video/x-msvideo' }, { name: 'nopath.avi' }] },
    null
]);
eq(evs.map(v => v.fileName), ['ch2.mp4', 'export'], 'evidenceVideos picks videos with a path');
eq(evs[0].evidenceId, 1, 'evidenceVideos keeps the record id');
const ob = F.stampObservation({ atSec: 90 }, cam);
eq([ob.real, ob.dvr, ob.realIso, ob.video], ['10/14 02:34:04', '2026-10-14 02:31:30', '2026-10-14T02:34:04', '01:30'], 'stampObservation');
eq(F.stampObservation({ atSec: 5 }, { startDvr: '' }).real, 'video 00:05', 'stampObservation without a clock');
const sorted = F.sortObservations([{ id: 'b', realIso: '2026-10-14T03:00:00' }, { id: 'c', realIso: '' }, { id: 'a', realIso: '2026-10-14T02:00:00' }]);
eq(sorted.map(o => o.id), ['a', 'b', 'c'], 'observations sort by real time, unknown last');
const log = F.makeLog({ title: 'Oak Hollow', cameras: [{ id: 'c1', name: 'Cam 2', fileName: 'ch2.mp4', startDvr: cam.startDvr, offsetSec: 154, incidentId: 'inc_3' }],
    observations: [Object.assign({ id: 'o1', cameraId: 'c1', cameraName: 'Cam 2', incidentId: 'inc_3', text: 'Silver sedan enters lot', tag: 'vehicle' }, ob)] },
    { caseNumber: '26-001' }, 'now', { inc_3: 3 });
ok('log names the case', /Case: 26-001/.test(log));
ok('log states the correction direction', /\+2:34 \(recorder behind real time\)/.test(log));
ok('log has the observation in real time', /2026-10-14 02:34:04 real \| Cam 2 \| DVR 2026-10-14 02:31:30 \| video 01:30 \| incident #3 \| vehicle/.test(log));
ok('log has the text', /Silver sedan enters lot/.test(log));

// ── connection board specs (boardSpecs) ─────────────────────────────
const bsInc = INC.map(i => i.id);
const bs = M.boardSpecs({ incidents: incidents13(), geoHint: 'Denver, CO',
    cameras: [{ id: 'c1', name: 'Cam 2', fileName: 'ch2.mp4', filePath: 'C:\\e\\ch2.mp4', evidenceId: 1, startDvr: cam.startDvr, offsetSec: 154, incidentId: bsInc[2] },
              { id: 'c2', name: 'Loose cam', fileName: 'x.mp4' }],
    observations: [{ id: 'o1', cameraId: 'c1', cameraName: 'Cam 2', incidentId: bsInc[2], text: 'Silver sedan enters lot', tag: 'vehicle', realIso: '2026-10-14T02:34:04', frame: 'data:image/jpeg;base64,AAA' },
                   { id: 'o2', cameraId: 'c1', incidentId: bsInc[4], text: '' },
                   { id: 'o3', cameraId: 'gone', text: 'orphan' }] }, { now: '2026-10-23' });
const bsBy = id => bs.specs.find(s => s.sourceId === id);
eq(bs.specs.filter(s => s.data.seriesKind === 'incident').length, INC.length, 'boardSpecs one pin per incident');
ok('boardSpecs all series sourceType', bs.specs.every(s => s.sourceType === 'series'));
ok('boardSpecs incident is a scene with seq label', bsBy(String(bsInc[0])).type === 'scene' && /^#\d+ /.test(bsBy(String(bsInc[0])).label));
ok('boardSpecs keys cover every spec', bs.specs.every(s => bs.keys[s.sourceId]));
const bsLikely = bsBy('likely-next');
ok('boardSpecs likely-next present with coords', !!bsLikely && typeof bsLikely.lat === 'number');
ok('boardSpecs likely-next is descriptive', /Descriptive projection/.test(bsLikely.data.notes) && !/\bwill (occur|happen|strike)\b|\bpredicts?\b/i.test(bsLikely.data.notes.replace(/not a prediction/gi, '')));
ok('boardSpecs camera pin carries the video', bsBy('cam:c1').type === 'video' && bsBy('cam:c1').data.video.path === 'C:\\e\\ch2.mp4');
ok('boardSpecs camera without file has no video', bsBy('cam:c2').data.video === null);
ok('boardSpecs camera→incident link', bs.links.some(l => l.from === 'cam:c1' && l.to === String(bsInc[2]) && l.label === 'covers'));
ok('boardSpecs unlinked camera has no link', !bs.links.some(l => l.from === 'cam:c2'));
eq(bsBy('obs:o1').photoRef, { kind: 'seriesFrame', obsId: 'o1' }, 'boardSpecs observation photoRef');
ok('boardSpecs observation without frame has no photoRef', bsBy('obs:o2').photoRef === null && bsBy('obs:o2').label === 'Footage observation');
ok('boardSpecs observation recorded-on link', bs.links.some(l => l.from === 'obs:o1' && l.to === 'cam:c1' && l.label === 'recorded on'));
ok('boardSpecs same-incident observation has no seen-at', !bs.links.some(l => l.from === 'obs:o1' && l.label === 'seen at'));
ok('boardSpecs cross-incident observation gets seen-at', bs.links.some(l => l.from === 'obs:o2' && l.to === String(bsInc[4]) && l.label === 'seen at'));
ok('boardSpecs orphan observation has no links', !bs.links.some(l => l.from === 'obs:o3'));
ok('boardSpecs observation real time', /2026-10-14 02:34:04 \(real time\)/.test(bsBy('obs:o1').data.datetime));
ok('boardSpecs no frame data copied', JSON.stringify(bs).indexOf('base64') < 0);
eq(M.boardSpecs({}).specs.length, 0, 'boardSpecs empty store');

// ── bulletin builder (sa-bulletin.js) ───────────────────────────────
const B = require('../sa-bulletin.js');
eq(B.blockOf('1420 Oak Hollow Dr'), '1400 block of Oak Hollow Dr', 'blockOf');
eq(B.blockOf('Oak Hollow Dr'), 'Oak Hollow Dr', 'blockOf no number');
const bopts = Object.assign(B.defaults(), { title: 'Cat converter thefts', agency: 'Test PD', contact: 'Det. Smith' });
const les = B.buildHtml({ model: M, incidents: INC, columns: COLS, options: bopts, caseObj: { caseNumber: '26-001' }, now: '2026-10-23', seriesTitle: 'Oak Hollow', tileUrl: null });
ok('bulletin is a full page', /<html/i.test(les) && /<\/html>/i.test(les));
ok('bulletin LES banner', /LAW ENFORCEMENT SENSITIVE/.test(les));
ok('bulletin title + agency', les.indexOf('Cat converter thefts') >= 0 && les.indexOf('Test PD') >= 0);
ok('bulletin likely-next says not a prediction', /not a prediction/i.test(les));
ok('bulletin block-level addresses by default', !/\b1420 Oak/.test(les));
ok('bulletin no script', !/<script/i.test(les));
const pub = B.buildHtml({ model: M, incidents: INC, columns: COLS, options: Object.assign(B.defaults(), { audience: 'public', include: Object.assign(B.defaults().include, { next: false }) }), caseObj: {}, now: '2026-10-23', seriesTitle: 'x', tileUrl: null });
ok('community banner', /COMMUNITY CRIME ALERT/.test(pub) && !/LAW ENFORCEMENT SENSITIVE/.test(pub));
ok('community has no likely-next box', !/not a prediction/i.test(pub));
const evil = B.buildHtml({ model: M, incidents: [Object.assign({}, INC[0], { address: '<img src=x onerror=alert(1)>' })], columns: COLS, options: Object.assign(B.defaults(), { title: '<script>x</script>' }), caseObj: {}, now: '2026-10-23', seriesTitle: '', tileUrl: null });
ok('bulletin escapes user text', !/<script>x/.test(evil) && !/<img src=x/.test(evil));

// ── wiring ──────────────────────────────────────────────────────────
const root = path.join(__dirname, '..', '..', '..');
const host = fs.readFileSync(path.join(root, 'case-detail-with-analytics.html'), 'utf8');
['sa-model.js', 'sa-bulletin.js', 'sa-footage.js', 'sa-tab.js', 'sa.css'].forEach(f => {
    ok('host loads ' + f, host.indexOf('modules/series-analysis/' + f) >= 0);
    ok(f + ' exists', fs.existsSync(path.join(__dirname, '..', f)));
});
ok('host dispatches seriesAnalysis', /tabId === 'seriesAnalysis'/.test(host));
ok('host tears down', /teardownSeriesAnalysis/.test(host));
const cs = require('../../_shared/case-stores.js');
const stores = cs.STORES || (cs.CaseStores && cs.CaseStores.STORES) || [];
ok('case-stores entry', stores.some(s => s.key === 'seriesAnalysis' && s.list === 'incidents'));
const MAIN = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
ok('main handles video-frame', /ipcMain\.handle\('video-frame'/.test(MAIN));
ok('preload exposes videoFrame', /videoFrame: \(args\) => ipcRenderer\.invoke\('video-frame', args\)/.test(PRELOAD));
const VP = require('../../_shared/video-playback.js');
const fa = VP.frameArgs('C:\\v.mp4', 12.5, 960);
ok('frameArgs seeks before input, one jpeg frame', fa.indexOf('-ss') < fa.indexOf('-i') && fa[fa.indexOf('-ss') + 1] === '12.5' && fa.indexOf('mjpeg') > 0 && fa.indexOf('1') > 0);

console.log('\nSeries Analysis tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
