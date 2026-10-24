/* Connection Board import parsing: node modules/connection-board/__tests__/cb-import-parse.test.js */
'use strict';
const P = require('../cb-import-parse.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ' (got ' + JSON.stringify(a) + ')'); }
function near(a, b, name) { ok(a != null && Math.abs(a - b) < 1e-4, name + ' (got ' + a + ')'); }

// ── guessColumns ────────────────────────────────────────────────
let g = P.guessColumns(['ID', 'Name', 'Address', 'Latitude', 'Longitude', 'Date', 'Time', 'Notes']);
eq(g.label, 1, 'label prefers Name over ID');
eq(g.address, 2, 'address column');
eq([g.lat, g.lng], [3, 4], 'lat/lng columns');
eq([g.date, g.time, g.datetime], [5, 6, -1], 'separate date and time');
eq(g.notes, 7, 'notes column');
g = P.guessColumns(['Plate', 'Read Time', 'Camera Name', 'GPS Coordinates']);
eq(g.plate, 0, 'plate');
eq(g.datetime, 1, 'read time as datetime');
eq(g.label, 2, 'camera name as label');
eq(g.latlng, 3, 'single coordinates column');
g = P.guessColumns(['Latitude', 'Site']);
eq([g.lat, g.lng], [-1, -1], 'lat without lng is dropped');
g = P.guessColumns(['Timestamp', 'Target Number', 'Tower Address', 'Category']);
eq(g.datetime, 0, 'timestamp');
eq(g.phone, 1, 'target number as phone');
eq(g.address, 2, 'tower address');
eq(g.type, 3, 'category as type');

// ── coordinates ─────────────────────────────────────────────────
near(P.parseCoord('39.7392', 'lat'), 39.7392, 'decimal');
near(P.parseCoord('-104.9903', 'lng'), -104.9903, 'negative decimal');
near(P.parseCoord('39°44\'21.1"N', 'lat'), 39.7391944, 'DMS N');
near(P.parseCoord('104 59 03 W', 'lng'), -104.9841667, 'DMS spaces W');
near(P.parseCoord('N39 44.352', 'lat'), 39.7392, 'DDM leading hemisphere');
near(P.parseCoord('39,7392', 'lat'), 39.7392, 'comma decimal');
eq(P.parseCoord('95', 'lat'), null, 'lat out of range');
eq(P.parseCoord('104 W', 'lat'), null, 'W hemisphere rejected for lat');
eq(P.parseCoord('45 Elm St', 'lat'), null, 'street text rejected');
eq(P.parseCoord('39 61 00', 'lat'), null, 'minutes >= 60 rejected');
eq(P.parseCoord(12.5), 12.5, 'number passes through');
eq(P.parseLatLng('39.7392, -104.9903'), { lat: 39.7392, lng: -104.9903 }, 'pair with comma');
eq(P.parseLatLng('(39.7392 -104.9903)'), { lat: 39.7392, lng: -104.9903 }, 'pair in parens, space');
let dms = P.parseLatLng('39°44\'21"N 104°59\'03"W');
ok(dms && Math.abs(dms.lat - 39.73917) < 1e-4 && Math.abs(dms.lng + 104.98417) < 1e-4, 'DMS pair');
let ddm = P.parseLatLng('N39 44.352 W104 59.418');
ok(ddm && Math.abs(ddm.lat - 39.7392) < 1e-4 && Math.abs(ddm.lng + 104.9903) < 1e-4, 'DDM pair with leading hemispheres');
eq(P.parseLatLng('0, 0'), null, 'null island rejected');
eq(P.parseLatLng('123 Main St, Denver'), null, 'address is not a pair');
eq(P.parseLatLng('45 Elm St, 12 Oak'), null, 'address with small numbers is not a pair');
eq(P.parseLatLng(''), null, 'empty');

// ── delimited text ──────────────────────────────────────────────
eq(P.detectDelimiter('a,b,c\n1,2,3'), ',', 'comma');
eq(P.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t', 'tab');
eq(P.detectDelimiter('a;b;c\n1,5;2;3'), ';', 'semicolon beats decimal commas');
eq(P.detectDelimiter('a|b\n1|2'), '|', 'pipe');
let rows = P.parseDelimited('\uFEFFName,Notes\n"Smith, J","said ""hi""\nthen left"\r\n\nLee,ok\n');
eq(rows.length, 3, 'blank lines dropped, BOM stripped');
eq(rows[0][0], 'Name', 'BOM stripped from first header');
eq(rows[1], ['Smith, J', 'said "hi"\nthen left'], 'quoted comma, doubled quote, newline in quotes');
eq(rows[2], ['Lee', 'ok'], 'plain row');
eq(P.headerRowIndex([['Export from LPR', ''], ['Plate', 'Time', 'Site'], ['ABC123', '01:00', 'X']]), 1, 'title row skipped');
eq(P.headerRowIndex([['1', '2'], ['3', '4']]), 0, 'no header defaults to 0');

// ── normType ────────────────────────────────────────────────────
eq(P.normType('LPR Hit'), 'lpr', 'lpr');
eq(P.normType('Cell tower'), 'cellPing', 'cell');
eq(P.normType('suspect'), 'suspect', 'exact type');
eq(P.normType('???', 'scene'), 'scene', 'fallback');
eq(P.normType(''), 'location', 'default location');

// ── rowsToSpecs ─────────────────────────────────────────────────
rows = [
    ['Name', 'Address', 'Lat', 'Lon', 'Date', 'Time', 'Vendor', 'Plate'],
    ['Quik Mart', '100 Main St', '39.75', '-104.99', '2026-10-15', '01:50', 'Acme', ''],
    ['', '200 Elm St', '', '', '', '', '', ''],
    ['', '', '', '', '', '', 'only extra', ''],
    ['', '', '', '', '', '', '', 'ABC123'],
    ['Corner cam', '39.7401, -104.9822', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '']
];
let map = P.guessColumns(rows[0]);
let res = P.rowsToSpecs(rows, map, { batchId: 'b1', sourceName: 'vendor.csv', importedAt: '2026-10-24T10:00:00Z' });
eq(res.specs.length, 4, 'four usable rows');
eq(res.skipped.length, 1, 'row with only extras is skipped');
eq(res.skipped[0].row, 4, 'skipped row number is 1-based');
let s0 = res.specs[0];
eq([s0.sourceType, s0.sourceId], ['import:b1', 'r2'], 'source keys');
eq([s0.lat, s0.lng], [39.75, -104.99], 'coordinates');
eq(s0.data.datetime, '2026-10-15 01:50', 'date + time joined');
ok(/Vendor: Acme/.test(s0.data.notes), 'unmapped column kept in notes');
eq([s0.data.importSource, s0.data.importRow], ['vendor.csv', 2], 'provenance');
eq(res.specs[1].label, '200 Elm St', 'address used as label');
eq(res.specs[1].lat, null, 'address-only row has no coordinates');
eq(res.specs[2].label, 'ABC123', 'plate used as label');
eq(res.specs[2].data.plate, 'ABC123', 'plate kept in data');
let s4 = res.specs[3];
eq([s4.lat, s4.lng, s4.address], [39.7401, -104.9822, ''], 'coordinates in address column become the location');
eq([res.located, res.needGeocode], [2, 1], 'located / needGeocode counts');
res = P.rowsToSpecs([['Coords', 'Type'], ['39.1,-104.2', 'LPR read']], P.guessColumns(['Coords', 'Type']), { batchId: 'b2' });
eq([res.specs[0].lat, res.specs[0].lng, res.specs[0].type], [39.1, -104.2, 'lpr'], 'latlng column + type column');
res = P.rowsToSpecs([['Name', 'X'], ['A', '1']], { label: 0 }, { extraCols: false, defaultType: 'person' });
eq([res.specs[0].data.notes, res.specs[0].type], ['', 'person'], 'extraCols off, default type');

// ── KML ─────────────────────────────────────────────────────────
const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Folder>
<Placemark><name>Pawn shop &amp; loans</name><description><![CDATA[<b>Known</b> fence<br>open late]]></description>
<TimeStamp><when>2026-10-12T22:00:00Z</when></TimeStamp>
<ExtendedData><Data name="Owner"><value>R. Diaz</value></Data><SchemaData><SimpleData name="Risk">high</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>-104.99,39.74,0</coordinates></Point></Placemark>
<Placemark><name>Route</name><LineString><coordinates>-105,39 -104,40</coordinates></LineString></Placemark>
<Placemark><name>Zone</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-105,39 -104,39 -104,40 -105,40</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Track</name><gx:Track><when>2026-10-01T01:00:00Z</when><gx:coord>-104 39 0</gx:coord><gx:coord>-104 41 0</gx:coord></gx:Track></Placemark>
<Placemark><name>Nowhere</name></Placemark>
<Placemark><name>Lookup</name><address>1 Civic Center Plz</address></Placemark>
</Folder></Document></kml>`;
let k = P.parseKml(kml, { batchId: 'k1', sourceName: 'pins.kml' });
eq(k.total, 6, 'six placemarks');
eq(k.specs.length, 5, 'one skipped');
eq(k.skipped[0].item, 5, 'placemark without location skipped');
eq(k.specs[0].label, 'Pawn shop & loans', 'entity decoded');
eq([k.specs[0].lat, k.specs[0].lng], [39.74, -104.99], 'point lat/lng order');
ok(/Known fence/.test(k.specs[0].data.notes) && /open late/.test(k.specs[0].data.notes), 'CDATA html description to text');
ok(/Owner: R\. Diaz/.test(k.specs[0].data.notes) && /Risk: high/.test(k.specs[0].data.notes), 'ExtendedData Data + SimpleData');
eq(k.specs[0].data.datetime, '2026-10-12T22:00:00Z', 'timestamp');
eq([k.specs[1].lat, k.specs[1].lng], [39.5, -104.5], 'linestring centroid');
ok(/path of 2 points/.test(k.specs[1].data.notes), 'path noted');
ok(/area of 4 points/.test(k.specs[2].data.notes), 'polygon noted as area');
eq([k.specs[3].lat, k.specs[3].lng], [40, -104], 'gx:Track centroid');
eq([k.specs[4].lat, k.specs[4].address], [null, '1 Civic Center Plz'], 'address-only placemark kept for geocoding');
eq(k.specs[4].sourceId, 'k6', 'source id keeps placemark index');
eq(k.located, 4, 'located count');

// ── GeoJSON ─────────────────────────────────────────────────────
const gj = {
    type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-104.99, 39.74] }, properties: { name: 'Store', time: '2026-10-01 02:00', note: 'side door', owner: 'X', nested: { a: 1 } } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-105, 39], [-104, 39], [-104, 40], [-105, 40]]] }, properties: { title: 'Beat 3', category: 'scene' } },
        { type: 'Feature', geometry: null, properties: { name: 'Empty' } },
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-104, 39], [-106, 41]] }, properties: {} }
    ]
};
let r = P.parseGeoJson(JSON.stringify(gj), { batchId: 'g1' });
eq([r.total, r.specs.length, r.skipped.length], [4, 3, 1], 'counts');
eq([r.specs[0].label, r.specs[0].lat, r.specs[0].lng], ['Store', 39.74, -104.99], 'point');
eq(r.specs[0].data.datetime, '2026-10-01 02:00', 'time property');
ok(/side door/.test(r.specs[0].data.notes) && /owner: X/.test(r.specs[0].data.notes) && !/nested/.test(r.specs[0].data.notes), 'notes + scalar extras only');
eq([r.specs[1].label, r.specs[1].type, r.specs[1].lat, r.specs[1].lng], ['Beat 3', 'scene', 39.5, -104.5], 'polygon centroid + category type');
ok(/polygon of 4 points/.test(r.specs[1].data.notes), 'polygon noted');
eq(r.specs[2].label, 'Feature 4', 'fallback label');
ok(/multi-point/.test(r.specs[2].data.notes), 'multipoint noted');
r = P.parseGeoJson({ type: 'Point', coordinates: [-104, 39] });
eq([r.specs.length, r.specs[0].lat, r.specs[0].sourceType], [1, 39, 'import:batch'], 'bare geometry');
r = P.parseGeoJson({ type: 'Feature', geometry: { type: 'Point', coordinates: [-104, 39] }, properties: { Name: 'One' } });
eq(r.specs[0].label, 'One', 'single Feature');

// ── misc ────────────────────────────────────────────────────────
eq(['a.csv', 'b.TSV', 'c.xlsx', 'd.xls', 'e.kml', 'f.kmz', 'g.geojson', 'h.json', 'i.pdf'].map(P.fileKind),
    ['delimited', 'delimited', 'xlsx', 'xls', 'kml', 'kmz', 'geojson', 'geojson', ''], 'fileKind');
eq(P.htmlToText('<p>a &amp; b</p><p>c</p>'), 'a & b\nc', 'htmlToText');
ok(/^[a-z0-9]+$/.test(P.newBatchId(1000)) && P.newBatchId() !== P.newBatchId(), 'batch ids');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
