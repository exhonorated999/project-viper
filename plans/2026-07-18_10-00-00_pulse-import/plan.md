# VIPER — PULSE (.pulse) Case Import (full fidelity)

## Goal
Let the ~5 remaining ICAC PULSE users import their cases into VIPER as PULSE is sunset.
Full fidelity: map every PULSE table so imported cases look native. Import button lives in
**Settings only** (small user base). PULSE's tamper-evident audit log is **kept** as read-only
history on the imported case.

## .pulse container format (from PULSE src: caseExporter.ts / caseImporter.ts) — VERIFIED
- Envelope: `[salt:32][iv:16][AES-256-CBC ciphertext]`; key = `PBKDF2(password, salt, 100000, 32, 'sha256')`.
- Plaintext = a ZIP (adm-zip) with `manifest.json` + `files/` tree.
- `manifest = { export_metadata:{pulse_version,manifest_schema,export_date,exporting_officer,case_number}, data:<gatherCaseData>, file_inventory:[{path,size,checksum(sha256)}] }`.
- **Decrypted all 5 sample exports with `Love0724!`; adm-zip present in VIPER node_modules.**

## PULSE source schema (manifest.data = gatherCaseData; keys omitted when a table has no row)
case, caseTypeData(cybertip|p2p|chat|other), notes, warrants, evidence, suspect(+weapons,suspectPhotos),
prosecution, opsPlan(+opsEntryTeam,opsOtherResidents), report, probableCause, todos, timelineEvents,
cdrRecords, apertureEmails, apertureNotes, warrantReturnImports, warrantReturnFlags, chatHighlights,
auditLog, exportedBy. Files live under `files/<subdir>/...` (e.g. suspect/, evidence/<tag>/, cybertip/, reports/, warrants/).

## VIPER target model (localStorage + on-disk snapshot; ingested by case-snapshot.js recover())
- Cases list: `viperCases` (flat array). case.id = Date.now() numeric (Pattern-2 suffix); case.caseNumber = string (Pattern-1 key).
- Pattern 1 (single key → { caseNumber: value }): viperCaseNotes, viperCaseEvidence, viperCaseWarrants,
  viperCaseProsecution, viperCaseCanvas(legacy), viperCaseNarcotics/Firearms/Money (mirror), viperTraceImports.
- Pattern 2 (`<key>_<case.id>`): suspects_, victims_, witnesses_, involvedPersons_, recoveredVehicles_,
  firearms_, narcotics_, money_, missingpersons_, timelineEvents_, opsplan_, prosecution_, consentSearches_,
  areacanvas_, canvasForms_, cyberTips_, caseMetrics_, rmsImports_, oversightImport_, googleWarrant_,
  metaWarrant_, kikWarrant_, discordWarrant_, snapchatWarrant_, xWarrant_, apertureFlags_.
- viperTasks: flat array; task.caseId = **caseNumber string**.
- Aperture on disk: `cases/<caseNumber>/aperture/{sources.json,emails.json,metadata.json}` (VERIFY id vs number at build).
- Photos in VIPER are inline base64 data URLs (photo/residencePhoto/vehicle.photo), NOT paths.

## Import strategy
1. Decrypt+unzip in Electron main (crypto + adm-zip). Read manifest.
2. Allocate NEW numeric case.id = Date.now() (collision-checked). Keep caseNumber from PULSE.
3. Translate manifest.data → VIPER snapshot `{caseMetadata, moduleData(Pattern2), sharedData(Pattern1), tasks}`
   (pure function in pulse-import-core.js, reusable by a Node test harness).
4. Write `cases/<caseNumber>/.case-snapshot.json` via existing save-case-snapshot IPC (handles encryption).
5. Extract `files/*` into `cases/<caseNumber>/` (map PULSE subdirs → VIPER subdirs; verify sha256).
6. Inline suspect photos (suspect_/residence_/vehicle_*.png) as base64 into the suspect object.
7. case-snapshot.js recover() ingests the snapshot into localStorage on next load.
8. Preserve auditLog as read-only history on the case; add one "Imported from PULSE" timeline event.

## Field mapping (PULSE → VIPER) — build reference
- case → viperCases entry (id=new, caseNumber, name='Case <n>', caseType←map, status←map, createdAt/lastModified←normalized). Map caseType/status to VIPER enums (grep at build).
- caseTypeData(cybertip) → cyberTips_<id> (cybertip_number, reporting_company, priority_level, ncmec_folder_path, identifiers, files).
- caseTypeData(p2p) → case fields + a "P2P Investigation Details" note (download_date, platform, suspect_ip, ip_provider).
- caseTypeData(chat) → case fields + identifiers → note / involved persons; platform + initial_contact_date.
- notes → viperCaseNotes[caseNumber] ({text←content, createdAt←created_at, id}).
- suspect(+weapons+suspectPhotos) → suspects_<id> (name←first+last, dob, address, physical, phone/carrier, vehicle, firearms_info, criminal_history, scars_marks_tattoos; photos inlined base64). weapons → firearms_<id> + mirror.
- evidence → viperCaseEvidence[caseNumber] (description, type, category, tag, files_json→files, uploaded_at). Provider-warrant bundle rows (type meta_warrant etc.) also surface here.
- warrants → viperCaseWarrants[caseNumber].
- warrantReturnImports + warrantReturnFlags → provider warrant modules (<provider>Warrant_<id>) with imp.flagged[section]=flag_key. (Complex — later increment.)
- prosecution → prosecution_<id> + viperCaseProsecution[caseNumber].
- opsPlan+opsEntryTeam+opsOtherResidents → opsplan_<id>.
- report → RMS_Reports file / rmsImports_<id>. probableCause → note/warrant field.
- todos → viperTasks (caseId=caseNumber).
- timelineEvents → timelineEvents_<id> (timestamp,title,description,lane,category,significance,source_type).
- cdrRecords → (later) trace/warrant-return; apertureEmails/apertureNotes → aperture disk files + apertureFlags_.
- chatHighlights → warrant-flags flagged structure (usually empty in samples).
- auditLog → case.pulseImportAudit (read-only) + one import timeline event.

## Build order (tasks)
P1-1 pulse-import-core.js (decrypt/unzip/translate core tables + file map) [self]
P1-2 Node test harness: translate all 5 exports, assert snapshot shape/no-throw [self]
P1-3 Electron main IPC (pulse-validate, pulse-import): snapshot write + file extract + checksum [self]
P1-4 preload.js expose pulseValidate/pulseImport + progress [self]
P1-5 settings.html "Import PULSE Case" panel (picker, password, progress, result) [self]
P1-6 End-to-end: import a .pulse in-app, verify case appears populated [self]
P2  Full-fidelity extensions: provider warrant-return reconstruction, cdr, report/probableCause polish.

## Non-goals / notes
- One-way import (PULSE→VIPER) only. No re-export to .pulse.
- 5 sample exports cover cybertip/p2p/chat, statuses open/arrest.
- Test artifacts + decrypted manifests in test_fixtures/_pm_*.json (gitignored).
