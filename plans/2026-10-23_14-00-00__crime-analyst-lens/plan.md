# Crime Analyst: Series Analysis module

## Context
A user asked how VIPER helps a **crime analyst**. They suggested an OSINT tab, but that misses how analysts actually work. Two real scenarios from the user:

1. **Catalytic converter series.** 13+ thefts in one neighborhood over 3 weeks, worked under **one** case (not 13). The analyst:
   - lays out every location, date and time;
   - looks for patterns (time of day, day of week, suspect and vehicle descriptions);
   - gives patrol a likely next area and time window;
   - reviews hours of surveillance footage for suspects and vehicles.
2. **Multi-case link analysis.** The analyst is brought in when something spans several cases. They compare cases for minor connections (cause of death, location, MO, victimology), work in Case Notes and custom Connection Boards, then hand the work to the primary detective through the existing **case export (.vcase)**.

The common need: **one case that holds many incidents, and tools to analyse them together.** VIPER today models one incident per case: one scene, one set of parties.

## Approach
Add one opt-in per-case module, **Series Analysis**, offered in "+ Add Module → Investigative Tools" (the same place as FLOCK, CDR and RMS Import).
- An investigator never sees it unless they add it. That's how VIPER already keeps cases uncluttered (`currentCase.modules`), so it doesn't feel bolted on: it's one more tool in the toolbox.
- The analyst's notes, boards and export use the existing features unchanged. The module feeds them:
  - incidents → Connection Board pins (numbered, chronological);
  - footage observations → Evidence and Notes;
  - the whole module travels in `.vcase` via `CaseStores`.

### Inside the module (sub-views)
1. **Incidents.** A table of incidents in the series. Each incident has:
   - report/case #
   - offense and MO tags
   - a time window (`from`/`to`), because property crimes are often "between 22:00 and 06:00"
   - address (geocoded)
   - suspect description (structured: sex, race, height, build, clothing)
   - vehicle description (structured: type, color, make, plate, partial plate)
   - notes and linked evidence

   Ways to add incidents:
   - manual entry
   - **paste/CSV** from an RMS/CAD export, with column mapping
   - **RMS PDF**, reusing `modules/rms/generic-extractor.js` and `rms-shapes.findLocation`
   - **from another VIPER case** on this machine, which pulls that case's number, location, date, offenses, suspects and vehicles as one incident; this covers scenario 2
2. **Map.**
   - Numbered chronological markers and a heat layer.
   - Filters by date, time-of-day and MO.
   - **Likely-area overlay**: the cluster centre with a 1σ ellipse, and the hit sequence drawn in order.
   - Reuses Leaflet and the basemap from `modules/_shared/basemap.js`.
3. **Time.**
   - A day-of-week × hour heat grid. Time windows are spread across their hours, so "22:00–06:00" counts as a fraction for each hour rather than being lost.
   - A timeline of hits and the gaps between them (is the pace speeding up?).
   - A plain-language summary, for example: *"9 of 13 hits Tue–Thu, 01:00–04:00; average 2.4 days between hits."*
4. **Compare (matrix).** Incidents as rows, attributes as columns. Shared values are highlighted (same vehicle color and type, same tool marks, same cause of death, same victim profile). This is the "minor connections" view for scenario 2. The attributes are free-form, so a homicide series uses different columns than a theft series.
5. **Footage review.** A video log tied to incidents:
   - playback at variable speed (up to 16×) using the existing video-playback/ffmpeg pipeline;
   - a **DVR clock offset** per camera (camera time vs real time);
   - **bookmark** an observation, which saves a timestamp, text and a frame grab;
   - send the frame grab to Evidence, or the observation to an incident or Case Notes.
6. **Bulletin.** A one-page analyst product in PDF for patrol and detectives, with:
   - map snapshot
   - time grid
   - suspect and vehicle summary
   - likely area and window
   - incident list

   Uses the same `saveHtmlAsPdf` path as the Case Status Report.

### Mockup
Static HTML mockup with 13 sample catalytic converter incidents: `<TMP>\mock\series-mock.html?view=overview|compare|footage|bulletin`. Rendered by `<TMP>\mock-shot.js` to `<TMP>\mock\out\series__*.png`.
- Sub-nav: Incidents · Map & Time · Compare · Footage · Bulletin.
- Toolbar: + Incident · Import (CSV / RMS PDF / VIPER case) · Send to Board · Bulletin PDF.
- Map & Time: KPI strip (count, average gap, peak window, top target, next likely window), map, day×hour grid, pattern summary, incident table.

### Honest wording
"Likely area/window" is described as **based on observed hits**, not a prediction model. It's descriptive statistics only, with no ML.

## What exists to reuse (findings)
- **Module registry:** `showAddModuleModal()` in `case-detail-with-analytics.html` ~L37465. The `investigativeTools` array has `{id,label,icon,desc}`. Also the self-heal `dataChecks` map ~L1657, `moduleConfig` and `renderTabContent`.
- **Export/merge:** `modules/_shared/case-stores.js` `STORES` is the single list used by `.vcase` export/import, backup, delete and snapshot. Add `{ key:'seriesAnalysis', pattern:2, shape:'wrapped', list:'incidents', ... }` and the module travels automatically.
- **RMS parsing:** `modules/rms/generic-extractor.js` (offenses, people, vehicles) and `rms-shapes.js` `findLocation`.
- **Cross-case pull:** `modules/case-link.js` normalizers. Case data is read through the pattern-2 keys `suspects_<id>`, `recoveredVehicles_<id>` and so on.
- **Connection Board:** `window` API `addPins(specs)` / `removePinsBySourceType` (connection-board.js ~L2502). Pins are keyed by (sourceType, sourceId), so a re-push is idempotent. Use `sourceType:'series'`.
- **Video:** `modules/_shared/video-playback.js` (ffmpeg playback copies, `thumb()` frame grab) and `evidence-view.js`.
- **PDF:** `electronAPI.saveHtmlAsPdf` with the CSR render style (`modules/case-status-report/csr-render.js`).
- **Pattern:** the FLOCK module (`modules/flock/`) is a close model: a self-contained per-case tab with a map that pushes to the board.

## Scope & Non-Goals
_To be confirmed with the user._ Proposed v1: Incidents (manual, CSV and from-VIPER-case), Map, Time, Compare, Board push, .vcase travel, Bulletin PDF.
Deferred: RMS-PDF batch import (v1.1), automated motion detection in footage, ML forecasting, and any OSINT tab.

## Implementation Plan
_Draft, finalised after answers._
1. `modules/series-analysis/sa-model.js` (UMD, pure): incident schema, CSV mapping, time-window → hour-weight spreading, gap stats, centroid/ellipse, matrix shared-value detection, summary text.
2. `modules/series-analysis/sa-tab.js` + `sa.css`: tab UI with Incidents, Map, Time, Compare, Footage and Bulletin sub-views.
3. Register in `case-detail-with-analytics.html`: the `investigativeTools` entry, `moduleConfig`, `renderTabContent`, `dataChecks`, script tags.
4. `case-stores.js`: add the `seriesAnalysis` store (identity = report # + from-time + address).
5. Board push: an "Send to Connection Board" button that calls `addPins`.
6. Bulletin: `sa-bulletin.js` builds HTML and calls `saveHtmlAsPdf`.
7. Footage review: an IPC for the frame grab at time T (extends video-playback `thumb`).
8. Tests: `modules/series-analysis/__tests__/sa.test.js`.

## Verification
- Unit tests for the model math (window spreading, gaps, ellipse, matrix).
- A fixture case with 13 catalytic-converter incidents, screenshotted with the Electron harness: map, grid, matrix and bulletin PDF.
- `.vcase` export → import into a fresh profile → the module and its incidents survive.
- Existing test suite stays green.
