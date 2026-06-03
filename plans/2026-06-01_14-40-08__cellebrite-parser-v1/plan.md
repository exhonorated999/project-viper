# Cellebrite Raw-Extraction Parser — v1 Blueprint

**Status:** Draft — awaiting review
**Created:** 2026-06-01
**Owner:** VIPER
**Target VIPER version:** v3.6.0 (minor bump — new module surface)

---

## 1. Scope (locked from intake)

### IN scope for v1
- Input format: **raw UFED filesystem extraction** (the `.ufdx` + `FileSystem 01/*.zip` bundle the user already provided as fixture).
- Surfaces extracted:
  1. **Device Overview** — from `EvidenceCollection.ufdx`, `*.ufd`, `SummaryReport.pdf`, plus `build.prop` / `system_id` inside the zip.
  2. **Installed Apps** — from `InstalledAppsList.txt` (cheap) + cross-checked against `/data/data/*` directory list inside the zip (authoritative).
  3. **Contacts** — `/data/data/com.android.providers.contacts/databases/contacts2.db`.
  4. **Call Log** — `calls` table inside `contacts2.db` (the Android call log lives in the same DB on modern AOSP).
  5. **SMS / MMS** — `/data/data/com.android.providers.telephony/databases/mmssms.db`.
  6. **Accounts** — `/data/system_ce/0/accounts_ce.db` (preferred) + `/data/system/users/0/accounts.db` (fallback).
  7. **Wi-Fi networks** — `/data/misc/wifi/WifiConfigStore.xml` + `WifiConfigStore.xml.encrypted-checkpoint` detection.

### OUT of scope for v1 (explicit non-goals — will park items for v2)
- Chat apps (WhatsApp, Telegram, Signal, Snapchat, Messenger, Instagram).
- Media (DCIM, Pictures, app caches, thumbnails, OCR).
- Web history (Chrome, Firefox).
- Geolocation history (Google Maps, Location History, app-level location).
- Bluetooth pairings, USB log, charger history.
- Decryption of any encrypted blob (Signal DB, encrypted Messenger, FBE-encrypted user_de/user_ce on locked profiles).
- Generating a UFED-style PDF report (we already have evidence-bundle export).

### Encrypted-data policy (v1)
- Detect FBE marker `/data/system/users/0/keystore` and surface `Field Security: device-encrypted (locked extraction)` in the Device Overview if all DB extractions fail.
- Skip any DB whose magic bytes are not `SQLite format 3\0` (16 bytes) — log + tag in result as `{path, kind: 'encrypted-or-corrupt'}`.
- NEVER attempt key derivation, brute force, or third-party decryption libs.

---

## 2. Source layout (locked from intake)

Datapilot-style dual flow:

**Mode A — Import into Evidence:**
- User picks `EvidenceCollection.ufdx` via dialog.
- VIPER copies the bundle (the `.ufdx` + sibling `FileSystem NN/` folders) into `cases/{caseNumber}/Evidence/Cellebrite/{importId}/source/`.
- All subsequent reads come from that path.
- Field Security: NOT applied to the source bundle itself (immutable forensic data) — only to derived VIPER artifacts.

**Mode B — Point at existing path:**
- User picks `EvidenceCollection.ufdx` via dialog.
- VIPER stores the ABSOLUTE path of the `.ufdx` in the import record.
- All reads stream directly from that path. If it goes offline, the module shows "Source unavailable — last seen at: ...".

**Mode toggle:** at import time, modal asks "Import into case (recommended for chain of custody) / Reference in place". Persisted per-import as `sourceMode: 'imported' | 'referenced'`.

**Derived artifacts** (always inside case folder, regardless of mode):
```
cases/{caseNumber}/Cellebrite/{importId}/
  manifest.json              — { importId, sourceMode, ufdxPath, evidenceTag, createdAt, sizes }
  extracted/                 — selectively-extracted SQLite + XML files (~100 MB ceiling)
    contacts2.db
    mmssms.db
    accounts_ce.db
    WifiConfigStore.xml
    build.prop
    InstalledAppsList.txt    — copy
    ...
  parsed/                    — JSON outputs of each surface parser
    device.json
    apps.json
    contacts.json
    calls.json
    sms.json
    accounts.json
    wifi.json
  log.txt                    — per-step parse log (success/skip/error)
```

The `parsed/*.json` files are the durable data; localStorage is **index only** (counts, timestamps, summaries). See §5.

---

## 3. File layout (new code)

```
modules/cellebrite/
  cellebrite-main.js         — Node/Electron-main: IPC handlers, file picking, zip streaming, sqlite reads
  cellebrite-parser.js       — pure parsing logic: ufdx XML, build.prop, sqlite queries, wifi XML
  cellebrite-extractor.js    — selective ZIP entry extraction (uses _shared/zip-reader.js)
  cellebrite-module.js       — renderer: data layer, localStorage adapter, WarrantFlags integration
  cellebrite-ui.js           — renderer: tab + sub-tab rendering, search, badges
  cellebrite-styles.css      — orange/cyan accent (matches existing 📱 emoji + 'Cellebrite Report' theming)
```

Reused shared infra:
- `modules/_shared/zip-reader.js` — already supports ZIP64 + streaming + selective `extractEntryToFile()` (perfect for the 48GB zip).
- `modules/_shared/warrant-flags.js` — flag-to-evidence pipeline.
- `better-sqlite3` (already in deps) — read-only SQLite access in the main process.
- `node-stream-zip` (already in deps, via `_shared/zip-reader.js`) — central-directory parsing.
- `pdf-parse` (already in deps) — for `SummaryReport.pdf` device-overview augmentation.

Decision: **better-sqlite3** over sql.js. Native = 50–100× faster on a multi-MB `mmssms.db`. Already in deps. The rebuild-per-electron headache is already solved (it's working in the current build).

---

## 4. IPC surface

All on `window.electronAPI`, registered in preload.js:

| IPC | Direction | Purpose |
|-----|-----------|---------|
| `cellebrite-pick-bundle` | invoke | File dialog → `.ufdx` selection. Returns `{success, ufdxPath, parentDir, bundleSize}`. |
| `cellebrite-scan-bundle` | invoke | TOC-scan the bundle (parse `.ufdx`, walk `FileSystem NN/*.zip` central directories). Returns `{success, manifest: {device, zips:[{path, entryCount, hasContacts2, hasMmssms, ...}]}, debug}`. NO extraction yet. |
| `cellebrite-import` | invoke | Performs the import: (a) copies bundle if `sourceMode='imported'`, (b) extracts the ~50 target files into `extracted/`, (c) runs parsers, (d) writes `parsed/*.json` + `manifest.json`. Streams progress via `cellebrite-import-progress` IPC event. Returns `{success, importId, counts, errors}`. |
| `cellebrite-import-progress` | on | `{importId, stage, current, total, label}` — for the progress modal. Stages: `copying`, `scanning`, `extracting`, `parsing-{surface}`, `done`. |
| `cellebrite-read-parsed` | invoke | Lazy-load `parsed/{surface}.json` for a given importId + surface. Renderer caches; main reads file fresh. |
| `cellebrite-export-flags-bundle` | invoke | Build a `.zip` or `.json` evidence bundle from flagged rows across all surfaces (CW-001, CW-002, ... per existing WarrantFlags convention). |
| `cellebrite-delete-import` | invoke | Remove `cases/{caseNumber}/Cellebrite/{importId}/` + delete localStorage entry. |

### Why two-stage (scan then import)?
The user must SEE what's in the bundle before triggering the long import (which on a 48GB zip is 30s–2min minimum). The scan tells them "found contacts2.db (3.2 MB), mmssms.db (180 MB), accounts_ce.db (40 KB), WifiConfigStore.xml (12 KB) — proceed?". Mirrors Datapilot's scan-then-import UX.

---

## 5. Storage schema

### localStorage — index only (small)
```js
// Key: `cellebriteImport_${caseId}`
{
  imports: [
    {
      id: "cb_2026-06-01T14-40-08_xxxx",
      evidenceTag: "EVID-CELL-001",
      deviceLabel: "Google Pixel Fold",
      sourceMode: "imported" | "referenced",
      ufdxPath: "C:\\...\\EvidenceCollection.ufdx",  // absolute if referenced, relative if imported
      bundleSize: 48097132127,
      createdAt: "2026-06-01T14:40:08Z",
      counts: {
        apps: 312,
        contacts: 87,
        calls: 1240,
        sms: 4801,
        accounts: 6,
        wifi: 23
      },
      flagged: {
        contacts: ["contact_id_1", "contact_id_2"],
        calls: ["call_id_1"],
        sms: ["sms_id_1"],
        // ... (matches WarrantFlags shape)
      },
      // NO actual rows in localStorage — too big.
    }
  ]
}
```

### Disk — parsed JSONs (per-surface, big)
Each `parsed/{surface}.json` is the durable, full row set. Renderer loads on demand via `cellebrite-read-parsed`.

**Rationale:** mmssms.db can have 50k+ rows on a heavy user. localStorage caps around 5–10 MB. We CANNOT put rows in localStorage.

### Pattern fit
This breaks the existing "Pattern 2 = `{module}_${caseId}` holds all data" convention used by other warrant modules — but those modules deal with KB–MB of data, not hundreds of MB. The Datapilot module sets the precedent for per-case-folder JSON storage (`dptData.db` references). We extend the precedent.

---

## 6. Parsing details — per surface

### 6.1 Device Overview
Sources, in order of authority:
1. `EvidenceCollection.ufdx` → `<evidence>` root has `<projectInfo>` with examiner, case#, extraction-date.
2. `FileSystem 01/*.ufd` → `<extractionInfo>` has device-make/model/serial, IMEI, ICCID, Android version.
3. `SummaryReport.pdf` → parse first page for confirmation of model + extraction type.
4. From zip: `system/build.prop` → `ro.build.fingerprint`, `ro.build.version.release`, `ro.product.model`, `ro.serialno`.

Output shape:
```js
{
  device: { make, model, serial, imei: [], iccid: [], androidVersion, buildFingerprint, fbeStatus: 'aware' | 'native' | 'unencrypted' },
  extraction: { tool, version, date, examiner, caseNumber, type: 'FileSystem' | 'Physical' | 'Logical' },
  source: { ufdxPath, totalSize, fileSystemZipPath, fileSystemZipSize }
}
```

### 6.2 Installed Apps
- `InstalledAppsList.txt` is line-formatted by Cellebrite as `Package | Name | Version | InstalledAt | UpdatedAt`.
- Cross-check: walk `/data/data/*` entries in the central directory → any package present on disk but not in the txt = "installed but not in summary" badge.
- Schema: `[{packageName, displayName, version, installedAt, updatedAt, hasDataOnDisk: bool, dataPath}]`.
- Sort: default by `updatedAt desc`. Searchable.

### 6.3 Contacts (contacts2.db)
- Tables: `raw_contacts`, `data`, `mimetypes` joined.
- Query: get all rows where `mimetype = vnd.android.cursor.item/phone_v2` for phones, `email_v2` for emails, `name` for display names.
- Group by `raw_contact_id` → one VIPER contact record.
- Schema: `[{id, displayName, phones:[{number, type}], emails:[{address, type}], accountType, starred, lastContacted, sourceAccount}]`.

### 6.4 Call Log
- Same DB on AOSP modern (Android 9+): table `calls`.
- Columns: `number`, `date`, `duration`, `type` (1=incoming, 2=outgoing, 3=missed, 4=voicemail, 5=rejected, 6=blocked).
- Schema: `[{id, number, contactName, direction, timestamp, duration, type, simSlot}]`.

### 6.5 SMS / MMS (mmssms.db)
- SMS table: `sms` — columns `address`, `body`, `date`, `type` (1=in, 2=out), `read`, `seen`, `thread_id`.
- MMS tables: `pdu` + `part` + `addr` — multi-row reconstruction.
- v1 simplification: SMS only + MMS metadata (sender, date, subject, attachment-count) — actual MMS attachment binaries deferred to v2 (those live in the zip's `/data/data/com.android.providers.telephony/app_parts/`).
- Schema: `[{id, threadId, address, contactName, direction, timestamp, body, read, type: 'sms' | 'mms', attachmentCount}]`.

### 6.6 Accounts
- `accounts_ce.db`: table `accounts` — `name`, `type`, `password` (usually null on FBE-locked).
- Cross-reference: extract `type` set to find which apps have configured accounts (Google, WhatsApp, Facebook, etc.) — useful pivot.
- Schema: `[{id, name, type, lastAuth, password: bool}]` (password field reports presence/absence only).

### 6.7 Wi-Fi
- `WifiConfigStore.xml` is plaintext XML on most builds.
- Parse `<WifiConfiguration>` blocks → SSID, BSSID list, key management (WPA2/WPA3/Open), creation time.
- Pre-saved passwords removed on Android 11+ (now encrypted in `WifiConfigStore.xml.encrypted-checkpoint`) — surface "Password: not extractable (Android 11+)" badge.
- Schema: `[{ssid, bssidHistory:[], security, hidden, autoConnect, configuredAt, configuredByPackage}]`.

---

## 7. UI integration

### 7.1 Tab
- New module tab `cellebrite` registered in **all 6 module-registration locations** per project conventions:
  1. `moduleConfig` (line ~1817) — icon = `M9 17a4 4 0 01-2-7.5...` (phone-style)
  2. `openManageTabsModal` — under "Digital Forensics" group alongside Datapilot
  3. `showAddModuleModal` — visible in add-module list
  4. `openExportCaseModal` — checkbox to include Cellebrite data in PDF/zip export
  5. `removeModuleFromCase` label config
  6. `getTabItemCount` — returns `imports.length`
  7. `renderTabContent` switch — calls `Cellebrite.render(root, currentCase)`
  8. `index.html` case-creation modal — module checkbox

### 7.2 Sub-tabs (within Cellebrite tab)
Top row of pills inside the tab:
- **Device** (icon: 📱) — overview card, badges
- **Apps** (icon: 📦) — list + search
- **Contacts** (icon: 👤) — list + search + per-row "Import to Suspects/Victims/Witnesses"
- **Calls** (icon: 📞) — virtualized list (1k+ rows), timeline view toggle
- **Messages** (icon: 💬) — thread-grouped, search, flagging
- **Accounts** (icon: 🔑) — small list
- **Wi-Fi** (icon: 📶) — small list, "View on Map" if BSSID + Wigle integration (v2 nice-to-have)

Each sub-tab has a search bar + flag column + count chip showing flagged/total.

### 7.3 Evidence dropdown wiring
Current: `<option value="cellebrite">Cellebrite Report</option>` points at the legacy folder-picker (CellebriteReader.exe launcher).

Decision: **Keep BOTH options**. Add a second option:
```html
<option value="cellebrite">Cellebrite Report (Reader.exe)</option>      <!-- existing -->
<option value="cellebriteExtraction">Cellebrite Extraction (.ufdx)</option>  <!-- new -->
```
The new option opens the `cellebrite-pick-bundle` dialog and the import flow. The old option remains for users who have CellebriteReader.exe-bearing folders from a prior workflow.

### 7.4 Case Link integration
- Contacts → eligible for live amber-badge matching against case persons (per existing case-link.js convention).
- Calls/SMS → phone-number-based match → "this number matches Suspect X in this case" inline badge.
- Wire `addPersonsForSearch()` style hook in `cellebrite-module.js`.

### 7.5 Field Security
- Encrypts derived `parsed/*.json` files on read/write when Field Security is unlocked, same as other warrant modules.
- Source bundle (`extracted/`, `source/`) is forensic evidence — left untouched.
- Detection: re-use existing security.js hooks.

---

## 8. Performance targets

| Stage | Target (SSD, 48GB bundle) | Hard cap |
|-------|---------------------------|----------|
| `cellebrite-pick-bundle` | <1 s | 3 s |
| `cellebrite-scan-bundle` (central dir scan only) | <10 s | 30 s |
| `cellebrite-import` — selective extract (~100 MB of target files from 48GB zip) | 30–90 s | 3 min |
| `cellebrite-import` — parsers (all 7 surfaces, 50k SMS realistic) | <30 s | 2 min |
| `cellebrite-read-parsed` (load sms.json, ~10 MB) | <500 ms | 2 s |
| Sub-tab render (5k contacts virtualized) | <100 ms | 500 ms |

Backstop: a `cellebrite-cancel-import` IPC for the user-abort case.

---

## 9. Testing strategy

### 9.1 Fixtures
- **Real fixture** (NOT committed): `C:\Users\JUSTI\Downloads\UFED Smart Phones PDAs Generic Android 2025_10_21 (002)\...` — 48 GB. Used for full end-to-end smoke tests only. Path captured in `test_fixtures/.gitignored_cellebrite_paths.txt`.
- **Synthetic mini-fixture** (committed): `test_fixtures/cellebrite_mini/` — hand-built 5 MB zip with:
  - Minimal `EvidenceCollection.ufdx` + `Google_Synthetic.ufd`
  - Minimal `FileSystem 01/synthetic.zip` containing:
    - `system/build.prop` (10 lines)
    - `data/data/com.android.providers.contacts/databases/contacts2.db` (5 contacts, hand-built with `better-sqlite3`)
    - `data/data/com.android.providers.telephony/databases/mmssms.db` (10 messages)
    - `data/system_ce/0/accounts_ce.db` (2 accounts)
    - `data/misc/wifi/WifiConfigStore.xml` (2 networks)
  - `InstalledAppsList.txt` (10 apps)
- Synthetic fixture generator script: `test_fixtures/build_cellebrite_mini.js` — committed, regenerable.

### 9.2 Test harness
- `_test_cellebrite.js` — runs parsers against mini-fixture, asserts row counts + key field presence.
- Pattern follows the RMS parser test we built earlier this session (brace-walking out of HTML if needed).
- Tests cover: ufdx XML parse, build.prop parse, each SQLite surface, Wi-Fi XML parse, FBE-locked simulation (replace contacts2.db with random bytes → assert "encrypted-or-corrupt" tag, NO crash).

### 9.3 Real-bundle smoke test (manual, gated)
Before each release ship that touches `modules/cellebrite/`:
1. Run import against the real 48GB fixture.
2. Assert: ≥X contacts, ≥X SMS, ≥X apps (thresholds determined on first successful run).
3. Hand-verify a sampled contact + SMS row matches what's visible in `InstalledAppsList.txt` cross-reference.

---

## 10. Resolved decisions (locked 2026-06-01)

1. **Module display name:** **"Cellebrite (Mobile Forensics)"** — full string used in `moduleConfig.cellebrite.label`, the add-module modal, the Manage Tabs modal, and the export-case modal. Disambiguates cleanly from the legacy "Cellebrite Report (Reader.exe)" evidence-dropdown option.
2. **MMS attachments:** **Extract during import.** Walk `pdu` + `part` tables in `mmssms.db`, follow `_data` paths into the zip (`/data/data/com.android.providers.telephony/app_parts/`), extract each part to `extracted/mms_parts/{partId}.{ext}` during the import pass. Surface in the SMS sub-tab as inline thumbnails (images) or attachment chips (other). Sizes range ~10 KB–10 MB per part; total derived-size increase typically 10–500 MB but bounded by what actually exists in the source.
3. **Source-bundle copy cap (sourceMode='imported'):** **No fixed cap.** Bound only by available disk space. Pre-import flow MUST:
   - Stat the bundle (sum of `.ufdx` + all `FileSystem NN/*.zip` + sibling files).
   - Check free space on the drive hosting the case folder (`fs.statfsSync` or `diskusage` shim).
   - If `bundleSize > freeSpace`: **hard-block** with modal "Not enough disk space — bundle is X GB, only Y GB available on {drive}. Switch to 'Reference in place' or free up space and retry."
   - If `bundleSize > 0.8 * freeSpace`: **soft-warn** "Bundle will use X GB (Y% of free space). Continue?" with Confirm / Cancel / Switch to Reference.
   - Otherwise: proceed silently.
4. **Cancel mid-import = resume-friendly.** On cancel:
   - Leave `extracted/`, `source/` (partial copy), `parsed/{surface}.json` files where they are.
   - Write `manifest.json` with `status: 'cancelled'` + `lastCompletedStage: 'extracting' | 'parsing-contacts' | ...` + `progress: {stage, current, total}`.
   - On next open of that import in the case, show "Import cancelled at {stage} — Resume / Discard" banner.
   - Resume picks up by re-checking which target files already exist in `extracted/` (skip if size matches manifest's expected size) and re-running only the parsers whose `parsed/{surface}.json` is missing.
   - Discard wipes the importId folder + localStorage entry.
5. **`getTabItemCount('cellebrite')` = `imports.length`** — matches the convention used by every other warrant module (Datapilot, Google, Discord, KIK, Snapchat, Meta) at lines 2335–2365 of case-detail-with-analytics.html. Keeps the tab badge consistent across the digital-forensics group. Per-surface counts surface inside the tab via sub-tab chips.

---

## 11. Phased delivery (post-blueprint)

- **Phase 1.1 (week 1):** Module scaffold + IPC stubs + bundle picker + scan (no parsing yet). Tab renders "0 surfaces parsed". Synthetic fixture committed. **Ship: dev build only, not released.**
- **Phase 1.2 (week 1):** Device + Apps + Contacts parsers. Selective extraction working. Real-bundle smoke test passes. **Ship: dev build only.**
- **Phase 1.3 (week 2):** Calls + SMS + Accounts + Wi-Fi parsers. WarrantFlags wired. Case Link wired. **Ship: v3.6.0-rc1 internal.**
- **Phase 1.4 (week 2):** UI polish, search, virtualized lists, evidence-bundle export. Field Security pass. **Ship: v3.6.0 public release.**

Each phase = its own tasks file under `plans/2026-06-01_14-40-08__cellebrite-parser-v1/tasks/`.

---

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 48GB zip has wildly different internal layout per device (Samsung vs Pixel vs OnePlus) | High | High | Synthetic fixture covers AOSP base; real-fixture smoke test gates ship; parser logs all "expected path missing" cases |
| `mmssms.db` schema variance across Android versions (8 vs 14) | Med | Med | Query with `SELECT name FROM sqlite_master` first, gracefully degrade |
| Field Security encryption of 10MB `sms.json` causes 5s+ load delay | Med | Low | Benchmark; lazy-load per-tab if needed |
| User imports same bundle twice → duplicate evidence | Med | Low | Hash `.ufdx` + bundle size → warn if duplicate import detected |
| Path with non-ASCII chars (the fixture path itself has spaces and parens) breaks ZIP extraction | Low | Med | Already handled by `_shared/zip-reader.js` — verified Discord/Snapchat paths |
| `better-sqlite3` rebuild fails on next Electron upgrade | Low | High | Already in deps + working; add to release smoke checklist |

---

## 13. Guidelines docs to fetch before building

(None external — all conventions are already documented in the in-project context.)

In-project references to study before writing code (Phase 1.1):
- `modules/datapilot/datapilot-main.js` (or whichever wires IPC) — IPC pattern + scan/import split
- `modules/datapilot/datapilot-parser.js` — SQLite read pattern with `better-sqlite3`
- `modules/_shared/zip-reader.js` — selective extraction API
- `modules/_shared/warrant-flags.js` — flag-to-evidence mixin contract
- `modules/discord-warrant/parser.js` — Buffer-typed field strip pattern (defense against JSON serialization failures)
- Existing `cellebrite-*` IPC in `electron-main.js` lines 3970–4500 — DO NOT BREAK; new module IPC must use distinct names (`cellebrite-pick-bundle` not `select-cellebrite-folder`)

---

## 14. Definition of Done (v3.6.0 ship gate)

- [ ] All 7 surfaces parse on real fixture without crash
- [ ] Synthetic fixture in repo + test passes in CI
- [ ] WarrantFlags integration: flag → "Export Flags" → evidence bundle appears as `CW-001` in Evidence tab
- [ ] Case Link: phone number from SMS appears as amber badge on matching Suspect
- [ ] Field Security: encrypt/decrypt cycle on parsed/*.json round-trips losslessly
- [ ] `.vcase` export: includes `cellebriteImport_${caseId}` localStorage + manifest, EXCLUDES `cases/.../Cellebrite/{importId}/source/` binary (too big — same precedent as Evidence/ exclusion)
- [ ] Audit log entries written on: import, surface-view, flag, evidence-export, delete
- [ ] No regression in legacy "Cellebrite Report" (Reader.exe) folder picker
- [ ] Documented in project_context.md (this is the ONLY .md we create — appended to existing context, not a new doc)
