# sa-model.js: spec (`SeriesAnalysisModel`)

File: `modules/series-analysis/sa-model.js`. Pure, with no DOM and no localStorage, and ES5-compatible style like the rest of `modules/` (var, function).
It's a UMD module:

```js
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.SeriesAnalysisModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () { 'use strict'; ... return API; }));
```

Every date is a calendar string `'YYYY-MM-DD'`, and every time is `'HH:MM'` (24h). Do day-of-week and day-difference math in UTC (`Date.UTC(y, m-1, d)`, `getUTCDay()`) so the host timezone can't shift a day. `dow`: 0=Sun … 6=Sat.

## Store shape (persisted by the UI as `seriesAnalysis_<caseId>`)
```js
{
  version: 1,
  title: '',                 // series name, e.g. "Oak Hollow catalytic converter series"
  template: 'property',      // key into TEMPLATES
  columns: [ {key,label,group} ],   // compare columns in use (start = template columns)
  incidents: [ Incident ],
  cameras: [],               // footage sources (UI-owned; just keep them as arrays)
  observations: [],          // footage bookmarks (UI-owned)
  bulletin: {}               // bulletin options (UI-owned)
}
```
Incident:
```js
{ id, reportNo, date, timeFrom, timeTo, address, lat, lng, offense, notes,
  attrs: { [columnKey]: string },     // compare-column values
  source: { type: 'manual'|'csv'|'case', caseId?, caseNumber? },
  createdAt, updatedAt }
```
- `timeTo === ''` means an exact time (`timeFrom` only). `timeFrom === ''` means the time is unknown.
- A window whose `timeFrom > timeTo` (e.g. 23:00 → 06:00) STARTS THE PREVIOUS EVENING: `date` is the morning it was found.
- `lat`/`lng` are numbers or `null`.

## Exports
- `VERSION` = 1
- `GROUPS` = `{ vehicle:'#00d9ff', person:'#a855f7', mo:'#c084fc', target:'#22c55e', place:'#ffa726', other:'#94a3b8' }`
- `TEMPLATES`: an object with each entry shaped `{ label, columns:[{key,label,group}] }`:
  - `property` ("Property crime series"): target (Target / property, target), suspectVehicle (Suspect vehicle, vehicle), suspects (Suspects, person), method (Method / MO, mo), locationType (Location type / parking, place), footage (Footage, other)
  - `homicide` ("Death / violent crime"): causeOfDeath (Cause of death, mo), weapon (Weapon, mo), wounds (Wounds / injuries, mo), victimProfile (Victim profile, person), locationType (Location type, place), bodyDisposition (Body disposition, place), lastSeen (Last seen, other), suspects (Suspects, person), suspectVehicle (Suspect vehicle, vehicle)
  - `persons` ("Robbery / persons crime"): suspects, suspectVehicle, weapon, method, target (Victim / target, target), locationType, footage
  - `general` ("General"): suspects, suspectVehicle, method, locationType, target
- `emptyStore()` returns a new store using the property template columns.
- `normalizeStore(raw)` is tolerant of null or garbage input. It fills in every field, normalises every incident, drops non-object incidents, and defaults `columns` from `template` when the list is empty. It returns a NEW object. It PRESERVES unknown top-level fields (e.g. `geoHint`), which the UI adds freely.
- `normalizeIncident(raw)`: trims strings and coerces `date` through `parseDate` and the times through `parseTime`. lat/lng become finite numbers or null. `attrs` values are coerced to trimmed strings; ALL attr keys are kept, even ones that aren't current columns. A missing `id` gets `newId('inc')`. `source` defaults to `{type:'manual'}`. Unknown incident fields are preserved (spread raw first, then overwrite the known ones).
- `newId(prefix)` returns `prefix + '_' + Date.now().toString(36) + '_' + random5`.
- `parseDate(s)` → `'YYYY-MM-DD'` or `''`. It accepts:
  - ISO dates, including datetimes (`2026-10-03T02:10`)
  - `M/D/YYYY` and `M/D/YY` (YY → 20YY), also with `-` or `.` separators
  - `Oct 3, 2026` and `3 Oct 2026`
  - `20261003`
  - a JS `Date` object
  It rejects impossible dates such as 2/30.
- `parseTime(s)` → `'HH:MM'` or `''`. It accepts `0230`, `230`, `2:30`, `02:30:15`, `2:30 AM`, `2:30pm`, `12:05 AM` (→00:05) and `1400 hrs`. It rejects 25:00.
- `parseDateTime(s)` → `{date, time}` for strings such as `10/03/2026 02:10`, `2026-10-03T02:10:00` and `Oct 3 2026 2:10 PM`.
- `parseTimeRange(s)` → `{from, to}` for `0130-0545`, `01:30 – 05:45`, `1:30am to 5:45am` and `between 2300 and 0600`. A single time gives `{from:t, to:''}`.
- `parseCsv(text)` → `string[][]`. It handles RFC4180 quotes and escaped `""`, CRLF/LF, and a BOM. It auto-detects the delimiter (tab when the first line has more tabs than commas; `;` likewise). Fully blank rows are dropped.
- `guessMapping(headers, columns)` → `{ fieldKey: headerIndex }`. Field keys are: reportNo, date, timeFrom, timeTo, timeRange, address, lat, lng, offense, notes, plus every `columns[i].key`. Matching is case-insensitive on normalised headers, using synonyms:
  - reportNo: report, report #, report no, case, case #, case number, incident #, incident number, cr, ir, cad
  - date: date, occurred, occurred date, date occurred, from date, start date, incident date, reported
  - timeFrom: time, from time, start time, time from, occurred time
  - timeTo: to time, end time, time to
  - timeRange: time range, between, window
  - address: address, location, street, block, incident address
  - lat: lat, latitude, y
  - lng: lng, lon, long, longitude, x
  - offense: offense, offence, crime, type, nature, call type, ucr
  - notes: notes, narrative, summary, description, synopsis
  - columns: their label and key, plus these extras:
    - target: target, property, victim vehicle, vehicle targeted
    - suspectVehicle: suspect vehicle, sv, susp veh
    - suspects: suspect, suspects, suspect description
    - method: mo, method, modus operandi, m.o.
    - locationType: parking, location type, premise
    - footage: video, camera, footage, cctv
    - causeOfDeath: cause of death, cod
  - Exact match wins over contains-match. Each header index is used at most once.
- `rowsToIncidents(rows, mapping, opts)` → `{ incidents, skipped:[{row, reason}] }`.
  - `opts.hasHeader` defaults to true and skips row 0. `opts.source` defaults to `{type:'csv'}`.
  - When there is a date column but no timeFrom mapping, the time comes from `parseDateTime` of the date cell.
  - `timeRange` fills from/to when those aren't mapped.
  - A row with neither a date nor an address is skipped (reason: 'no date or address').
  - Column values go into `attrs`.
- `chrono(incidents)` returns a sorted COPY ordered by date, then by the effective start time. A cross-midnight window sorts by its previous-evening start. Undated incidents go last.
- `seqMap(incidents)` → `{ [id]: n }`, numbered 1..N in chrono order (undated last).
- `hourWeights(incidents)` returns a `7×24` array, `g[dow][hour]`. The rules are:
  - An exact time adds +1 to its hour.
  - A window spreads 1 over every hour it touches, inclusive of both end hours. A cross-midnight window starts on `dow(date)-1` and rolls into `date`.
  - A dated incident with an unknown time spreads 1 evenly over the 24 hours of that day.
  - Undated incidents are ignored.
- `dayWeights(grid)` returns `[7]` sums.
- `peakWindow(grid, width=3)` returns the best contiguous `width`-hour band, circular so 23–02 is allowed:
  - `startHour`, `endHour` (exclusive, mod 24)
  - `share`: band weight / total weight
  - `days`: the smallest set of days, in descending weight order, whose weight inside the band covers ≥70% of the band weight, sorted Mon..Sun
  - `label` like `'01–04'`
  - `daysLabel` like `'Tue–Thu'`, or `'Mon, Wed, Fri'` when the days aren't contiguous (Mon-first order)
  - It returns null when the total is 0.
- `gapStats(incidents)` returns `{ gaps:[days], avg, median, sd, trend, spanDays, first, last }`.
  - It uses dated incidents only, in chrono order, so a gap can be 0 (same day).
  - `trend` is `'tightening'` when the second-half avg is < 0.75× the first-half avg, `'widening'` when it is > 1.33×, and otherwise `'steady'`. It is null with fewer than 4 gaps.
  - It returns null with fewer than 2 dated incidents.
- `haversine(a, b)` → metres.
- `spatial(incidents)` uses incidents with lat/lng. It returns null with fewer than 2 of them. Otherwise it returns:
  - `n`, `centroid {lat,lng}`
  - `meanDist_m` (mean distance to the centroid)
  - `ellipse {center, sx_m, sy_m, angleDeg}`, the 1σ standard deviational ellipse. Project to local metres with equirectangular projection around the centroid, then take the covariance eigen-decomposition. `sx_m` is the major semi-axis (sqrt of the larger eigenvalue), and `angleDeg` is the major-axis angle counter-clockwise from east.
  - `drift`, or null. It needs ≥4 geocoded AND dated incidents; regress east-m and north-m on day number. The value is `{ metersPerWeek, milesPerWeek, bearingDeg (clockwise from north), compass: one of N NE E SE S SW W NW }`.
- `ellipsePolygon(ellipse, steps=48)` → `[[lat,lng],…]`
- `circlePolygon(center, radius_m, steps=48)` → `[[lat,lng],…]`
- `likelyNext(incidents, opts)` takes `opts.now` ('YYYY-MM-DD', optional). It is a DESCRIPTIVE projection, so it must never claim to be a prediction model.
  - It returns null with fewer than 4 dated incidents.
  - `last` is the last date. `recent` is the last ≤6 gaps; `mu` is their mean and `sd` is max(1, their sd).
  - `dowShare[d]` is the share of dated incidents on weekday d, plus 0.02 smoothing.
  - The candidate dates are the 14 days starting at max(last+1, now).
  - Each candidate scores `gauss(daysSinceLast; mu, sd) * dowShare`. If the max gauss value across the candidates is below 1e-3 (overdue), it uses dowShare alone.
  - The window is the contiguous run around the best-scoring date where score ≥ 50% of the best, capped at 4 days.
  - Hours come from `peakWindow(hourWeights(all))`.
  - The area is computed from the last ≤4 geocoded incidents in chrono order. `center` is their centroid, shifted by drift × (days from the mean date of those incidents to the window midpoint)/7, with the shift capped at 3×radius. `radius_m` is max(150, 1.5 × their mean distance to their own centroid). Area is null when there are fewer than 2 geocoded incidents.
  - The return value is `{ basis:'observed', window:{start,end,fromHour,toHour,label:'Tue 10/27 – Thu 10/29', hoursLabel:'01:00–04:00'}, area:{center,radius_m}|null, confidence:'low'|'moderate', reasons:[strings explaining what fed it] }`.
  - `confidence` is 'moderate' only when n ≥ 6 AND peak share ≥ 0.5; otherwise it is 'low'.
- `normValue(v)` lowercases, trims, collapses whitespace and strips trailing punctuation and `…`. It returns `''` for `—`, `-`, `n/a`, `na`, `unk`, `unknown`, `none` and `?`.
- `splitValues(v)` splits on `;`, `·`, `|`, ` / ` and newline (NOT comma), trims the parts and drops empties.
- `shared(incidents, columns)` → `{ [colKey]: [{ value (normalised), display (first-seen original text), count, ids:[...] }] }`. Each incident counts at most once per value. A value is included only if count ≥ 2, and the list is sorted by count desc, then display.
- `matrix(incidents, columns)` returns rows in chrono order: `[{ id, n, incident, cells: { [key]: { display, parts:[{text, shared:bool, count}] } } }]`.
- `filterByValue(incidents, colKey, normValue)` returns the incidents having that value part.
- `kpis(incidents, columns)` returns `{ count, spanDays, avgGap, trend, peak (peakWindow), top:{column,display,count}|null (the largest shared value in the first 'target'-group column, else any column), next (likelyNext) }`.
- `summary(incidents, columns, opts)` returns plain-language bullet STRINGS. HTML is not allowed, but `**bold**` markers are. Include each bullet only if its data supports it:
  - the peak days/hours share ("**11 of 13** hits fell Tue–Thu"), with the exact-time span ("every exact time is between **01:40 and 03:05**")
  - the gap/trend
  - drift ("moving ≈0.3 mi **E** per week"), only when milesPerWeek ≥ 0.05
  - the top 3 shared values across columns ("**Silver Nissan Altima** at 5 incidents (#4, #6, #7, #10, #13)")
  - how many incidents lack a location or time (data-quality note)
- `fromCase(caseObj, extras)` builds an Incident from a VIPER case (for multi-case comparison). `extras` is `{victims:[], suspects:[]}`. The mapping is:
  - reportNo ← caseNumber; date ← offenseDate; address ← locationOfOccurrence; offense ← primaryOffense
  - notes ← caseName || title || description (trimmed to 300)
  - attrs.suspects ← suspect names joined with '; ', where each name is `name || [firstName,lastName].join(' ')`
  - attrs.victimProfile ← victims as "name (age/sex)", built from the parts present
  - source `{type:'case', caseId, caseNumber}`
- `csvTemplate(columns)` returns a header line: `Report #,Date,Time From,Time To,Address,Latitude,Longitude,Offense,<column labels...>,Notes`
- Map helpers for the static bulletin map (Web Mercator, 256-px tiles):
  - `projectPx(lat, lng, zoom)` → world-pixel `{x, y}`.
  - `tileMosaic(points, width, height, opts)` takes `opts.padPx` (default 40), `opts.maxZoom` (17) and `opts.minZoom` (3). It picks the highest zoom where the points' bbox plus padding fits, centred on the bbox. It returns `{ zoom, origin:{x,y}, width, height, tiles:[{z,x,y,left,top}] }`, which cover the whole viewport; tile x wraps mod 2^z. `left`/`top` are px offsets relative to the viewport. A single point uses zoom 15. Empty points return null.
  - `toViewport(mosaic, lat, lng)` → `{x, y}` px within the viewport.
  - `metersPerPixel(lat, zoom)`

## Tests
`modules/series-analysis/__tests__/sa.test.js`: plain node (no jest), in the same style as `modules/case-status-report/__tests__/csr.test.js` (ok/eq counters, exit code 1 on failure). Fixture: `modules/series-analysis/__tests__/sa-fixture.js` exports `incidents13()`. It covers the 13 catalytic-converter incidents from 2026-10-01 to 2026-10-22, in a real-looking neighbourhood around lat 39.75, lng -105.0 that drifts east week by week, with mostly Tue–Thu hits between 01:00 and 04:00 and a few cross-midnight windows. The Silver Nissan Altima appears at 5 incidents.
