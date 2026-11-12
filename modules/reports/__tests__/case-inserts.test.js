/*
 * "From case" tables and exhibit photos (modules/reports/case-inserts.js).
 *
 * Run: node modules\reports\__tests__\case-inserts.test.js
 *
 * Synthetic records only. Also pins the host wiring in
 * case-detail-with-analytics.html (menu items, photo picker, CSAM guard).
 */
const fs = require('fs');
const path = require('path');
const CI = require('../case-inserts.js');
const RE = require('../rich-editor.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const count = (s, re) => (String(s).match(re) || []).length;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

console.log('\n== styles match the editor ==');
{
    const t = RE.tableHtml(1, 1, true);
    ok('cell style = rich-editor cell style', t.indexOf(CI.CELL_STYLE) > 0);
    ok('table style = rich-editor table style', t.indexOf(CI.TABLE_STYLE) > 0);
}

console.log('\n== table() ==');
{
    ok('no rows → empty string', CI.table([{ label: 'A', get: (r) => r.a }], []) === '');
    ok('non-array → empty string', CI.table([{ label: 'A', get: (r) => r.a }], null) === '');
    const h = CI.table([
        { label: 'Name', always: true, get: (r) => r.n },
        { label: 'Empty', get: (r) => r.e },
        { label: 'Note', get: (r) => r.x },
    ], [{ n: 'A', x: 'line1\nline2' }, { n: '', x: '' }, null]);
    ok('header row of th', count(h, /<th /g) === 2);
    ok('empty-everywhere column dropped', h.indexOf('Empty') < 0);
    ok('always column kept even if blank row', count(h, /<tr>/g) === 3);
    ok('newline → <br>', h.indexOf('line1<br>line2') > 0);
    ok('blank cell gets <br>', h.indexOf('"><br></td>') > 0);
    ok('trailing empty paragraph', /<\/table><p><br><\/p>$/.test(h));
    ok('null rows skipped', count(h, /<tr>/g) === 3);
    const x = CI.table([{ label: '<b>', always: true, get: (r) => r.v }], [{ v: '<img src=x onerror=alert(1)>"\'&' }]);
    ok('values escaped', x.indexOf('<img') < 0 && x.indexOf('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;') > 0);
    ok('labels escaped', x.indexOf('&lt;b&gt;') > 0);
    const thr = CI.table([{ label: 'A', always: true, get: () => { throw new Error('x'); } }], [{}]);
    ok('getter that throws → blank cell', thr.indexOf('<td') > 0);
}

console.log('\n== dates ==');
{
    ok('ymd no TZ shift', CI.fmtDate('2026-01-02') === '01/02/2026');
    ok('blank date', CI.fmtDate('') === '' && CI.fmtDate(null) === '');
    ok('unparseable kept', CI.fmtDate('sometime in May') === 'sometime in May');
    const iso = new Date(2026, 4, 6, 14, 5).toISOString();
    ok('datetime local', CI.fmtDateTime(iso) === '05/06/2026 14:05', CI.fmtDateTime(iso));
    ok('datetime date-only has no time', CI.fmtDateTime('2026-05-06') === '05/06/2026');
}

console.log('\n== people ==');
{
    const s = [
        { name: 'Pat Example', dob: '1990-03-04', sex: 'M', race: 'W', height: '510', weight: '180', hairColor: 'BRO', eyeColor: 'BLU',
          address: '1 Test St', addressCityStateZip: 'Springfield, ZZ 00000', phone: '555-0100', dlNumber: 'D1234', dlState: 'ZZ', arrested: true, arrestDate: '2026-02-03' },
        { firstName: 'Lee', lastName: 'Sample' },
    ];
    const h = CI.people(s, 'suspects');
    ok('names', h.indexOf('Pat Example') > 0 && h.indexOf('Lee Sample') > 0);
    ok('DOB formatted', h.indexOf('03/04/1990') > 0);
    ok('height 510 → 5\'10"', h.indexOf('5&#39;10&quot; / 180 lbs') > 0);
    ok('sex / race', h.indexOf('M / W') > 0);
    ok('address two lines', h.indexOf('1 Test St<br>Springfield, ZZ 00000') > 0);
    ok('DL with state', h.indexOf('D1234 (ZZ)') > 0);
    ok('arrested column for suspects', h.indexOf('>Arrested<') > 0 && h.indexOf('Yes \u2014 02/03/2026') > 0);
    ok('no email column when none', h.indexOf('>Email<') < 0);
    ok('no role column for suspects', h.indexOf('>Role<') < 0);
    const v = CI.people([{ name: 'Vic Tim', email: 'v@example.test' }], 'victims');
    ok('victims: no arrested column', v.indexOf('Arrested') < 0 && v.indexOf('v@example.test') > 0);
    const ip = CI.people([{ name: 'Ina P', role: 'Reporting party', relationship: 'Neighbor' }], 'involvedPersons');
    ok('involved: role + relationship', ip.indexOf('>Role<') > 0 && ip.indexOf('Reporting party<br>Neighbor') > 0);
    ok('unknown name', CI.people([{ sex: 'F' }], 'witnesses').indexOf('Unknown') > 0);
    ok('empty list', CI.people([], 'witnesses') === '');
    const custom = CI.people([{ name: 'A', dob: '2000-01-01', dlNumber: 'X' }], 'witnesses', { formatDate: () => 'FMT', dlDisplay: (p, f) => 'DL:' + p.dlNumber + f });
    ok('formatDate + dlDisplay overrides', custom.indexOf('FMT') > 0 && custom.indexOf('DL:X') > 0);
}

console.log('\n== vehicles ==');
{
    const h = CI.vehicles([
        { year: '2019', makeModel: 'Honda Accord', color: 'Blue', licensePlate: 'ABC123', plateState: 'ZZ', vin: '1HGCV1F30KA000000', recoveryDate: '2026-04-01', recoveryLocation: 'Lot 4', status: ['Recovered', 'Processed'] },
        { year: '2001', make: 'Ford', model: 'F-150', plateNumber: 'XYZ', state: 'YY', locationRecovered: 'Field' },
    ]);
    ok('title', h.indexOf('2019 Honda Accord') > 0 && h.indexOf('2001 Ford F-150') > 0);
    ok('plate + state', h.indexOf('ABC123 ZZ') > 0 && h.indexOf('XYZ YY') > 0);
    ok('recovered date + place', h.indexOf('04/01/2026<br>Lot 4') > 0 && h.indexOf('>Field<') > 0);
    ok('status array joined', h.indexOf('Recovered, Processed') > 0);
}

console.log('\n== evidence (text only) ==');
{
    const h = CI.evidence([
        { tag: 'E-1', type: 'photo', description: 'rear door, pry marks', location: 'Back porch', collectionDate: '2026-03-03', fileCount: 4, files: [{ path: 'x.jpg' }] },
        { tag: 'E-2', type: 'warrantReturn', discoverable: false, createdAt: '2026-03-04T12:00:00Z', files: [{}, {}] },
    ], { typeLabels: { photo: 'Photograph' } });
    ok('label from map', h.indexOf('Photograph') > 0);
    ok('camelCase type humanized', h.indexOf('Warrant Return') > 0);
    ok('not discoverable flagged', h.indexOf('(investigative only)') > 0);
    ok('file count', h.indexOf('>4<') > 0 && h.indexOf('>2<') > 0);
    ok('no media in evidence table', h.indexOf('<img') < 0 && h.indexOf('x.jpg') < 0);
}

console.log('\n== timeline ==');
{
    const h = CI.timeline([
        { timestamp: '2026-05-02T10:00:00', title: 'Second', description: 'b' },
        { timestamp: '2026-05-01T09:00:00', title: 'First', endTimestamp: '2026-05-01T11:30:00' },
        { timestamp: 'bad', title: 'Undated' },
        { timestamp: '2026-05-03' },
    ]);
    ok('sorted oldest first, undated last', h.indexOf('First') < h.indexOf('Second') && h.indexOf('Second') < h.indexOf('Undated'));
    ok('end time', h.indexOf('05/01/2026 09:00<br>to 05/01/2026 11:30') > 0);
    ok('events with no title/description skipped', count(h, /<tr>/g) === 4);
    ok('empty', CI.timeline([]) === '');
}

console.log('\n== exhibits ==');
{
    ok('first exhibit', CI.nextExhibitNumber('<p>No exhibits</p>') === 1);
    ok('after highest', CI.nextExhibitNumber('<p><i>Exhibit 3 \u2014 a</i></p><p>exhibit 12</p><p>Exhibit 2</p>') === 13);
    ok('split by tags still counted', CI.nextExhibitNumber('<p>Exhibit&nbsp;<b>4</b></p>') === 5);
    ok('label', CI.exhibitLabel(3, 'rear door, pry marks') === 'Exhibit 3 \u2014 rear door, pry marks');
    ok('label no caption', CI.exhibitLabel(2, '  ') === 'Exhibit 2');
    ok('label no number', CI.exhibitLabel(0, 'Just a caption') === 'Just a caption');
    const b = CI.photoBlock({ src: JPG, n: 3, caption: 'rear <door>' });
    ok('centered 60% picture', b.indexOf('data-wrap="center"') > 0 && b.indexOf('width:60%') > 0 && b.indexOf(RE.imgStyle('center', 60)) > 0);
    ok('italic centered caption, escaped', b.indexOf('<p style="text-align:center"><i>Exhibit 3 \u2014 rear &lt;door&gt;</i></p>') > 0);
    ok('alt escaped', b.indexOf('alt="Exhibit 3 \u2014 rear &lt;door&gt;"') > 0);
    ok('non data-URL refused', CI.photoBlock({ src: 'https://example.test/x.jpg', n: 1 }) === '' && CI.photoBlock({ src: 'data:image/svg+xml;base64,AAAA' }) === '');
    ok('width option', CI.photoBlock({ src: PNG, widthPct: 100 }).indexOf('width:100%') > 0);
    ok('no caption, no number → no caption line', CI.photoBlock({ src: PNG }).indexOf('<p') < 0);
    // The editor's sanitizer keeps what photoBlock makes (print path).
    ok('photoBlock style survives cleanStyle', RE.cleanStyle(RE.imgStyle('center', 60), 'IMG') === RE.imgStyle('center', 60));
}

console.log('\n== photoSources: CSAM / CyberTip never offered ==');
{
    const src = {
        suspects: [{ name: 'Pat Example', photo: JPG, residencePhoto: PNG, address: '1 Test St',
            vehicles: [{ makeModel: 'Honda Accord', color: 'Blue', plateNumber: 'ABC', photo: JPG }, { makeModel: 'NoPic' }] }],
        victims: [{ name: 'Vic Tim', photo: 'https://example.test/remote.jpg',
            injuryPhotos: [{ url: JPG, description: 'bruise, left arm\nmore' }, { url: 'http://x/y.jpg' }], propertyPhotos: [{ url: PNG }] }],
        witnesses: [{ name: 'Wit Ness' }],
        involvedPersons: [{ firstName: 'Ina', lastName: 'P', photo: PNG }],
        vehicles: [{ year: '2019', makeModel: 'Ford F-150', licensePlate: 'XYZ', photo: JPG }, { makeModel: 'NoPhoto' }],
        evidence: [
            { id: 1, tag: 'E-1', description: 'rear door, pry marks', files: [{ name: 'IMG_1.jpg', path: 'C:/c/E-1/IMG_1.jpg' }, { name: 'notes.pdf', path: 'C:/c/E-1/notes.pdf' }] },
            { id: 2, tag: 'E-2', files: [{ name: 'a.png', path: 'C:/c/E-2/a.png' }, { name: 'b.HEIC', path: 'C:/c/E-2/b.HEIC' }] },
            { id: 3, tag: 'CT-1', type: 'ncmecCybertip', csamSensitive: true, files: [{ name: 'm.jpg', path: 'C:/c/CT/m.jpg' }] },
            { id: 4, tag: 'X-4', csamSensitive: true, type: 'photo', files: [{ name: 'n.jpg', path: 'C:/c/X/n.jpg' }] },
            { id: 5, tag: 'X-5', type: 'photo', ncmec: { uploadMode: 'files' }, files: [{ name: 'o.jpg', path: 'C:/c/X/o.jpg' }] },
            { id: 6, tag: 'Media from CyberTip 12345', type: 'photo', files: [{ name: 'p.jpg', path: 'C:/c/X/p.jpg' }] },
            { id: 7, tag: 'X-7', type: 'photo', description: 'NCMEC reported images', files: [{ name: 'q.jpg', path: 'C:/c/X/q.jpg' }] },
            { id: 8, tag: 'X-8', type: 'photo', released: { at: '2026-01-01' }, files: [{ name: 'r.jpg', path: 'C:/c/X/r.jpg' }] },
            { id: 9, tag: 'X-9', type: 'photo', folder: 'Cyber-Tip uploads', files: [{ name: 's.jpg', path: 'C:/c/X/s.jpg' }] },
            { id: 10, tag: 'X-10', type: 'photo', files: [{ name: 'nopath.jpg' }] },
        ],
    };
    const p = CI.photoSources(src);
    const paths = p.filter((x) => x.filePath).map((x) => x.fileName);
    ok('suspect photo, residence, vehicle', p.filter((x) => x.group === 'Suspects').length === 3);
    ok('residence caption has address', p.some((x) => x.caption === 'Residence of Pat Example, 1 Test St'));
    ok('vehicle caption', p.some((x) => x.caption === 'Vehicle of Pat Example: Honda Accord, Blue, ABC'));
    ok('remote URLs never offered', !p.some((x) => /^https?:/.test(x.src || '')));
    ok('injury caption = first line of description', p.some((x) => x.caption === 'bruise, left arm'));
    ok('property photo default caption', p.some((x) => x.caption === 'Property of Vic Tim'));
    ok('involved person photo', p.some((x) => x.group === 'Involved persons' && x.caption === 'Involved person Ina P'));
    ok('recovered vehicle', p.some((x) => x.group === 'Recovered vehicles' && /2019 Ford F-150, XYZ/.test(x.caption)));
    ok('evidence images only (no pdf)', paths.indexOf('notes.pdf') < 0 && paths.indexOf('IMG_1.jpg') >= 0);
    ok('single-image evidence caption = description', p.some((x) => x.fileName === 'IMG_1.jpg' && x.caption === 'rear door, pry marks'));
    ok('multi-image evidence caption names the file', p.some((x) => x.fileName === 'a.png' && x.caption === 'E-2 (a.png)'));
    ok('HEIC offered (main converts or reports)', paths.indexOf('b.HEIC') >= 0);
    ok('NCMEC CyberTip type excluded', paths.indexOf('m.jpg') < 0);
    ok('csamSensitive excluded', paths.indexOf('n.jpg') < 0);
    ok('ncmec metadata excluded', paths.indexOf('o.jpg') < 0);
    ok('CyberTip in tag excluded', paths.indexOf('p.jpg') < 0);
    ok('NCMEC in description excluded', paths.indexOf('q.jpg') < 0);
    ok('released files excluded', paths.indexOf('r.jpg') < 0);
    ok('Cyber-Tip folder excluded', paths.indexOf('s.jpg') < 0);
    ok('file with no path excluded', paths.indexOf('nopath.jpg') < 0);
    ok('exact evidence list', JSON.stringify(paths) === JSON.stringify(['IMG_1.jpg', 'a.png', 'b.HEIC']), paths);
    ok('unique ids', new Set(p.map((x) => x.id)).size === p.length);
    ok('empty input', CI.photoSources(null).length === 0 && CI.photoSources({ evidence: [null, 5] }).length === 0);
    ok('isRestrictedEvidence(null) is true', CI.isRestrictedEvidence(null) === true);
    ok('plain evidence not restricted', CI.isRestrictedEvidence({ type: 'photo', tag: 'E-1' }) === false);
}

console.log('\n== host wiring (case-detail-with-analytics.html) ==');
{
    const h = read('case-detail-with-analytics.html');
    ok('script tag', h.indexOf('<script src="modules/reports/case-inserts.js"></script>') > 0);
    ok('editor gets inserts', /ViperRichEditor\.attach\(\{[\s\S]{0,400}inserts:\s*_reportCaseInserts\(\)/.test(h));
    const at = h.indexOf('function _reportCaseInserts(');
    ok('_reportCaseInserts defined', at > 0);
    const body = at > 0 ? h.slice(at, h.indexOf('\n        }\n', at)) : '';
    ['suspects', 'victims', 'witnesses', 'involvedPersons', 'vehicles', 'evidence', 'timeline', 'photos'].forEach((id) => {
        ok('menu item ' + id, new RegExp("id:\\s*'" + id + "'").test(body));
    });
    ok('photo picker uses photoSources', /\b(?:ViperCaseInserts|CI)\.photoSources\(/.test(h));
    ok('picker numbers from the report', /\b(?:ViperCaseInserts|CI)\.nextExhibitNumber\(/.test(h));
    ok('restricted evidence filtered before the picker reads files', /function _reportPhotoSrc[\s\S]{0,1500}isRestrictedEvidence\(ev\)[\s\S]{0,600}evidenceMediaUrl/.test(h));
    ok('evidence read via evidenceMediaUrl bytes', /evidenceMediaUrl\(\{\s*filePath:[^}]*bytes:\s*true\s*\}\)/.test(h));
    ok('picker re-checks CSAM before reading a file', /isRestrictedEvidence\(ev\)/.test(h));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
