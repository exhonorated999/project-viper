# Case Status Report

## Context
One user's agency requires a monthly "30 Day Open Case Report": a flat table listing case #, assigned date, status, description, due date (assigned + 30), and days overdue, plus an empty "Overdue explanation" line per case and one optional circumstances box (sample: `Downloads\30 Day Report.docx`, Westminster PD, 46 rows). Copying it directly would only help that one agency.

Goal: an opt-in VIPER feature called **Case Status Report** that works for **any** agency. It should give better stats, case updates that VIPER drafts automatically from data it already has, and a striking PDF in the style of the DataPilot *2026 Year in Review* (`Downloads\DataPilot_2026_Year_in_Review.pdf`). That PDF was made with HTML → headless Chrome: dark navy grid background, neon accent per section, stat tiles, SVG donut and bar charts, a milestone timeline, and a "spotlight" page per item. The new report keeps that layout style in VIPER's own look.

## Scope & Non-Goals
**v1**
- A **Settings toggle**: a "Case Status Report" card directly under "ICAC Task Force Reporting (IDS)". It includes the threshold setting (30 / 45 / 60 / 90 days, default 30). When the toggle is off, nothing appears anywhere.
- A **dashboard button** ("Case Status Report") in Quick Stats, under Generate Report and the IDS buttons. It is hidden unless the feature is enabled.
- **Generate wizard**:
  1. Scope: *open cases over the threshold* or *all open cases*. Reporting period. Options.
  2. A **Review & Update** step for each case, with VIPER's draft and fields for the investigator.
  3. Generate the PDF.
- **PDF output**: Letter size, edge-to-edge dark design. There is also a **print-friendly light theme** (same layout) so supervisors don't burn toner.
- **Report history**: kept so each report knows what changed since the last one, can show a trend chart, and can carry each case's previous update forward.

**Deferred**
- Word (.docx) version.
- Supervisor Edition dashboard widget.
- Unit-wide (multi-investigator) rollup.
- Scheduling and reminders, e.g. "report due in 3 days".

## Data sources (all localStorage in the renderer; confirmed)
| Need | Source |
|---|---|
| Cases | `viperCases`: `caseNumber, dateAssigned ('YYYY-MM-DD', may be null), createdAt, lastModified, status, primaryOffense, offenseType, category, priority, caseRole, icac, dateClosed` |
| Status labels | built-in `_BUILTIN_STATUS_INFO` (`index.html:8414`) plus `viperCustomStatuses` `{id,label,color,category}`. A case counts as open when its status category is `active`. |
| Notes | `viperCaseNotes[caseNumber]`, each `{title, content/contentHtml, createdAt, editHistory}` |
| Evidence (incl. BitTorrent, Cellebrite) | `viperCaseEvidence[caseNumber]`, each `{type, title, createdAt}` |
| Warrants | `viperCaseWarrants[caseNumber]`. Use the helpers in `modules/warrant-status.js` (`isOpen/isOverdue/daysOverdue/label`). |
| Tasks | `viperTasks` (global, `caseId`, `date`, `completed`, `completedAt`, `createdAt`). Confirm whether `caseId` holds the id or the case number. |
| Suspects / arrests | `suspects_<caseId>` (`status`, `arrestDate`, `createdAt`) |
| Field work | `fieldwork_<caseId>` (`occurredAt/timestamp`) |
| Report narrative | `viperCaseReports[caseNumber].lastSaved` |
| Seizures | `money_/narcotics_/firearms_/recoveredVehicles_<id>` (`createdAt`) |
| Identity | `viper_customer_name`, `viper_agency`, `viperUserInfo.badgeNumber`, `viperAgencyProfile`; agency logo via `electronAPI.readDeptBadge()` |
| Precedent | `buildCaseActivity()` in `modules/supervisor-link/supervisor-link-ui.js` already gathers per-case activity |

Read raw strings through `VpCaseBlobs.getRaw` when it is present, the same way `ids-dashboard.js` does, so photos aren't loaded from disk.

## Metrics
**For each case**
- Assigned date. If `dateAssigned` is missing, use `createdAt` and flag it "assignment date not set".
- Due date = assigned + threshold. Days open. Days overdue / days left.
- Urgency tier: On track · Due ≤7d · Overdue (1–30) · Seriously overdue (31–90) · Critical (>90).
- Days since last activity: the latest timestamp across every source above, or `lastModified`.
- Counts for the reporting period: notes, evidence, warrants issued, warrant returns received, tasks completed, field work entries, suspects added, arrests, and whether the report narrative was updated.
- Weekly activity for the last 12 weeks, shown as a sparkline.
- Case lifecycle milestones: assigned → first warrant → return received → arrest → report written → today, with the due-date marker.
- Open, overdue and completed tasks. Warrants with their status. The latest notes (title + excerpt).

**Totals across all cases in the report**
- Open cases; cases over the threshold; due in the next 14 days.
- Average and median age; the oldest case.
- % of cases worked this period.
- Closed this period; arrests this period; warrants waiting on returns or overdue.
- Status mix; age buckets (0–30 / 31–60 / 61–90 / 91–180 / 181–365 / 365+); offense mix.
- Blocker breakdown; trend of overdue count across past reports.

## Report layout (HTML → PDF, fixed 8.5×11in pages)
1. **Cover**:
   - VIPER logo, plus the agency badge if one is set. Title **"Case Status Report"**.
   - Investigator, badge, agency. Reporting period, threshold, date run.
   - A row of 5 headline numbers.
2. **Executive Summary**:
   - 9 stat tiles.
   - Donut charts: status mix, offense mix.
   - Bar chart: age buckets.
   - Blocker breakdown.
   - "Highlights" bullets written automatically (e.g. "7 of 12 overdue cases had activity this period").
   - Overdue trend line, when report history exists.
3. **Caseload Overview**, the agency's table done better:
   - Columns: case #, offense, status chip, assigned, due, overdue heat bar, last activity, activity this period.
   - Sorted by days overdue, about 18 rows per page, split across pages automatically.
4. **One Case Spotlight page per case**:
   - Header: case #, offense, status, priority / ICAC chips.
   - 4 stat tiles: days open, overdue, last activity, actions this period.
   - Lifecycle timeline; 12-week activity sparkline.
   - Warrants table; tasks list; recent notes (optional).
   - **Investigator Update** panel: status update, next steps, blocker chips, target completion date.
5. **Investigator Statement & Sign-off**:
   - The overall circumstances statement (replaces the agency's optional box).
   - Investigator certification line.
   - **Supervisor reviewed: ____ Date ____** sign-off block.

Fixed-height pages with `overflow:hidden` and caps on how much each section shows ("+N more"), so a page never spills over. Page numbers are drawn by the report itself; each page footer reads "Case Status Report · page n of N".
Fonts already on Windows 10/11, so the app works offline with nothing to bundle: **Bahnschrift** (headings and numbers, similar to the DataPilot font), **Segoe UI** (body text), **Consolas** (case numbers). All charts are inline SVG; no chart library.

## Implementation Plan
New module `modules/case-status-report/`, built like `modules/ids-measures/` (core logic that can be tested under Node, plus a separate UI file). The global names are `CaseStatusReportBuild`, `CaseStatusReportRender` and `CaseStatusReport` (UI).
1. **`csr-build.js`** (no UI code). `build({ getItem, now, opts:{scope, thresholdDays, periodStart, periodEnd, includeAssist} })` returns `{ identity, period, totals, charts, cases:[...], history }`. Contains the day math (copied from the `warrant-status.js` approach), the status → category lookup, and the activity collector.
2. **`csr-render.js`** (no UI code). `render(model, updates, { theme:'dark'|'light', includeNotes, logoDataUrl, badgeDataUrl })` returns one HTML string with inline CSS and SVG. Includes helpers for donut, bar, sparkline, timeline and heat bar, and splits the report into pages.
3. **`csr-dashboard.js`** (UI). "Case Status Report" wizard modal:
   - Step 1: scope, period (defaults to "since last report", or the last 30 days if there is none), options (theme, include note excerpts, include assist cases).
   - Step 2: one card per case showing VIPER's draft "since last report" summary. Fields: update text (pre-filled with the previous update), next steps, blocker chips, target completion date. Step 2 also has the overall statement.
   - Step 3: calls `electronAPI.saveHtmlAsPdf({ html, defaultFileName:'Case_Status_Report_<name>_<YYYY-MM-DD>.pdf', options:{ marginType:'none', settleMs:600 } })`, then saves an entry to `viperCaseStatusReports`.
   - Blocker chips: Awaiting warrant return · Awaiting lab/forensics · Awaiting DA review · Victim/witness unavailable · Suspect outstanding · Awaiting outside agency · Workload.
4. **History store**: `viperCaseStatusReports`, an array of `{ id, generatedAt, period, scope, thresholdDays, totals, caseUpdates:{[caseNumber]:{update,nextSteps,blockers,targetDate}}, statement }`, capped at 24 entries. Because the key starts with `viper*`, the full backup already includes it.
   - In-progress drafts from Step 2 are autosaved to `viperCaseStatusReportDraft`, so closing the modal doesn't lose typed updates.
5. **`settings.html`**: a "Case Status Report" card after the IDS card (~line 2797), using `isIdsEnabled/toggleIdsEnabled/refreshIdsUI` (~line 10066) as the pattern.
   - Keys: `viperCaseStatusReportEnabled` and `viperCsrThresholdDays`.
   - Card text: "Adds a Case Status Report button to the dashboard. Builds a report of your open cases — or only those open longer than the threshold — with case stats, activity since your last report, and your status updates. If this is off, none of it appears."
6. **`index.html`**:
   - Load the 3 scripts next to the IDS ones (lines 71–72).
   - Add a `#csrDashboardPanel` button ("Case Status Report" / "Open-case stats & updates") under `#idsDashboardPanel` (~line 1204), shown or hidden by `CaseStatusReport.refresh()`.
7. **`electron-main.js` `_doSaveHtmlAsPdf`** (~line 10081): add the `options.marginType` option (default stays `'default'`) so pages can print edge to edge. Nothing else changes.
8. **Tests** in `modules/case-status-report/__tests__/`:
   - Build math: due/overdue/tiers, null `dateAssigned`, custom statuses, assist exclusion, period counts, history carry-forward.
   - Render: page count, no unescaped user text, chart output, light theme.
   - Wiring checks: scripts loaded, settings key, panel hidden when off.
   - Run with `run-all-tests.js` (Electron run as Node).

## Verification
- Run the unit tests: new and existing should all pass. The expected exception is `cdr-formats` under Electron run as Node.
- Seed a scratch profile with about 45 cases that copy the Westminster sample (assigned dates 2024 → 2026, a mix of statuses), plus notes, warrants and tasks. Generate both the "over threshold" and "all open" versions in both themes.
- Render the PDF to PNGs and check visually: no spill-over, page numbers correct, charts right, and the logo and badge show.
- Turn the toggle off: no button and no errors. Back on: the button appears without a restart once the dashboard refreshes.
- Generate twice: the second report shows the trend chart and the previous updates pre-filled.

## Open questions
- Should the report also be sent to the supervisor through Supervisor Link in v1?
- Confirm the per-case "Review & Update" step (VIPER drafts, the investigator edits) versus generating with no input.
