# V.I.P.E.R. — Information Security & Compliance Policy Guide
### Aligned to the NIST Cybersecurity Framework (CSF v1.1)

**Product:** V.I.P.E.R. (Versatile Investigative Platform for Enforcement Records)
**Vendor:** Intellect LE, LLC
**Document Version:** 1.0
**Aligned to:** NIST CSF v1.1 / MS-ISAC Policy Template Guide (2020)
**Status:** Template — agencies should customize sections marked **[AGENCY-SPECIFIC]**

---

## How to Use This Document

This guide mirrors the **MS-ISAC NIST CSF Policy Template Guide (2020)**. It documents how VIPER, when deployed and operated as recommended, satisfies each applicable NIST CSF subcategory. Agencies adopting VIPER may use this guide as the basis for their own information-security policy package.

The guide is organized by the five NIST CSF Functions:

| Function | Purpose |
|---|---|
| **Identify (ID)** | Develop organizational understanding of cybersecurity risk to systems, people, assets, data, and capabilities. |
| **Protect (PR)** | Implement safeguards to ensure delivery of critical services. |
| **Detect (DE)** | Implement activities to identify the occurrence of a cybersecurity event. |
| **Respond (RS)** | Take action regarding a detected cybersecurity incident. |
| **Recover (RC)** | Maintain plans for resilience and restoration of capabilities or services impaired by an incident. |

Each subcategory (e.g. `PR.AC-1`) lists:
- **Requirement** — the NIST CSF control text
- **VIPER Control** — how VIPER satisfies the requirement (technical evidence)
- **Policy Statement** — adoptable policy language
- **References** — corresponding SANS/MS-ISAC template names from the source guide

---

## Scope

This policy applies to:
- All deployments of VIPER (per-user, per-machine MSI, and portable USB)
- All officers, detectives, supervisors, and IT personnel using VIPER
- All case data, evidence files, warrant returns, and derivative work product produced or stored within VIPER
- All systems on which VIPER is installed or executed

---

# NIST FUNCTION: Identify (ID)

## ID.AM — Asset Management

### ID.AM-1 — Physical devices and systems are inventoried.

**VIPER Control:**
- VIPER's **Settings → Licensing** page records the host machine fingerprint and license activation against the Intellect Dashboard at activation time.
- The Intellect Dashboard maintains an authoritative inventory of every active VIPER installation: customer organization, license type, product version, last-seen timestamp, and registration IP.
- The dashboard's `/admin/customers` view exports the full active-installation roster.

**Policy Statement:** The agency shall maintain a current inventory of every workstation, laptop, and removable device on which VIPER is installed. The Intellect Dashboard customer roster is the system of record for this inventory.

**References (MS-ISAC):** Acceptable Use of Information Technology Resource Policy · Identification and Authentication Policy · Information Security Policy · Security Assessment and Authorization Policy

---

### ID.AM-2 — Software platforms and applications are inventoried.

**VIPER Control:**
- VIPER reports its installed version and product slug to the Intellect Dashboard via `/api/license/validate` on every launch (when network is available).
- The dashboard tracks `current_version` per product (`project-viper`, `icac-pulse`, `project-oversight`) and surfaces drift to administrators.
- Auto-updater (electron-updater) reads `latest.yml` from GitHub Releases — every deployed version is therefore traceable to a signed, published release.

**Policy Statement:** Only versions of VIPER published to the official GitHub Releases channel for `exhonorated999/project-viper`, signed by the Intellect LE Authenticode certificate, may be installed on agency systems.

**References:** Information Security Policy · Security Assessment and Authorization Policy

---

### ID.AM-4 — External information systems are catalogued.

**VIPER Control:** VIPER's documented external dependencies are limited to:
- Intellect Dashboard API (`https://<dashboard-host>/api/`) — license validation, update check, canvas form hosting
- GitHub Releases (`https://github.com/exhonorated999/project-viper`) — installer + `latest.yml`
- ARIN WHOIS (`https://whois.arin.net/`) — IP enrichment for warrant returns
- OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org`) — geocoding for case maps
- Optional: VIN decoder, ALPR provider, agency RMS endpoints — disabled by default

The Content-Security-Policy meta tag in every page restricts outbound fetches to this whitelist.

**Policy Statement:** VIPER's outbound network access is restricted to the dependency list above. Agencies may further restrict via firewall to exclude any of the optional endpoints not in use.

**References:** System and Communications Protection Policy

---

### ID.AM-5 — Resources are prioritized based on classification, criticality, and business value.

**VIPER Control:**
- VIPER cases carry an **Operations Plan** module supporting case-criticality ratings.
- Custom Metrics (per-case tagging) lets agencies define classification labels (e.g. "DA Accepted", "Active Surveillance", "Cold").
- Case status taxonomy supports `Open / Suspended / Closed / Closed w/ Arrest / Inactive` — surfaced in dashboard rollups.

**Policy Statement:** All cases shall be classified using the agency's information-classification scheme. Custom Metrics shall be configured to mirror that scheme.

**References:** Acquisition Assessment Policy · Information Classification Standard · Information Security Policy

---

### ID.AM-6 — Cybersecurity roles and responsibilities are established.

**Policy Statement [AGENCY-SPECIFIC]:**
- **System Owner** — Agency IT Director: approves installations, manages MSI deployment.
- **Application Administrator** — Designated officer or sworn supervisor: manages license keys, custom metrics, settings rollouts, and Field Security policy.
- **End Users** — Officers/detectives: case data entry, evidence intake, warrant parsing.
- **Vendor** — Intellect LE, LLC: support, updates, incident response coordination.
- **Third-Party Stakeholders** — DA's Office (case exports), partner agencies (canvas forms, sealed-case sharing).

**References:** Acceptable Use Policy · Information Security Policy · Security Awareness and Training Policy

---

## ID.RM — Risk Management Strategy

### ID.RM-1 — Risk management processes are established.

**Policy Statement [AGENCY-SPECIFIC]:** The agency shall conduct an annual risk assessment of its VIPER deployment covering:
- Field Security activation rate (% of installations with encryption enabled)
- License compliance (active vs. expired)
- Auto-updater effectiveness (% of installations on current version)
- Audit log retention compliance
- Incident response drills

**References:** Information Security Risk Management Standard · Risk Assessment Policy

---

## ID.SC — Supply Chain Risk Management

### ID.SC-2 — Suppliers and third-party partners are identified and assessed.

**VIPER Control:** Vendor due-diligence package available from Intellect LE on request, covering:
- Build pipeline integrity (signed releases, reproducible builds from public source)
- Dependency provenance (`package-lock.json`, `npm audit` reports per release)
- Code-signing chain of custody (Authenticode cert held by Intellect LE)

**Policy Statement:** Before initial deployment and at each major version upgrade, the agency shall review the Intellect LE due-diligence package. This guide and the corresponding release notes constitute that package.

**References:** Acquisition Assessment Policy · Systems and Services Acquisition Policy

---

### ID.SC-4 — Suppliers and third-party partners are routinely assessed.

**Policy Statement [AGENCY-SPECIFIC]:** Annually, the agency shall confirm:
- Intellect LE Authenticode certificate is current
- VIPER GitHub repository remains under `exhonorated999/project-viper` (no transfer of ownership)
- Dashboard endpoint TLS certificate is valid and chains to a trusted CA

---

### ID.SC-5 — Response and recovery planning is conducted with suppliers.

**VIPER Control:** Intellect LE incident-response contact is published in vendor due-diligence package and in the VIPER `Settings → About` panel.

**Policy Statement:** In the event of a suspected supply-chain compromise (e.g. unauthorized release, certificate revocation, dashboard compromise), the agency shall:
1. Halt auto-updates by setting `VIPER_DISABLE_AUTOUPDATE=1` in machine env or via GPO
2. Notify Intellect LE incident response within 4 hours
3. Capture audit logs from all installations for forensic review

---

# NIST FUNCTION: Protect (PR)

## PR.AC — Identity Management and Access Control

### PR.AC-1 — Identities and credentials are issued, managed, verified, revoked, and audited.

**VIPER Control:**
- Each VIPER installation requires an **API Key** (`INT-XXXX-XXXX-XXXX-XXXX`) and **License Key** (`INT-VIPER-XXXX-XXXX-XXXX`) issued by the Intellect Dashboard.
- License keys are SHA-256 hashed before storage on the dashboard — raw keys are never persisted server-side after issuance.
- Field Security identifier (case-cipher key) is derived from a user-supplied passphrase; never transmitted off-device.
- Revocation: dashboard administrators may set license `status=revoked` — VIPER refuses to start on next launch when validation fails.

**Policy Statement:** License keys shall be issued only to named individual officers or named workstations. Shared license keys are prohibited. Departed personnel's license keys shall be revoked within 24 hours of separation.

**References:** Access Control Policy · Account Management/Access Control Standard · Authentication Tokens Standard · Identification and Authentication Policy

---

### PR.AC-3 — Remote access is managed.

**VIPER Control:**
- VIPER does not expose any inbound network listener — there is no remote-access surface to the application.
- The only remote-accessible endpoints are the Intellect Dashboard (TLS-only, JWT for admin, X-API-Key for desktop apps) and GitHub Releases (HTTPS).
- Canvas Forms (officer-facing form pages) are public by URL but expire after 48 hours and are deleted from the server on download.

**Policy Statement:** Remote access to VIPER hosts shall follow agency remote-access policy. VIPER's own functionality requires no inbound remote access.

**References:** Remote Access Policy · Remote Access Standard

---

### PR.AC-4 — Access permissions follow least privilege and separation of duties.

**VIPER Control:**
- Default install (NSIS, per-user) writes only to the user's `%LOCALAPPDATA%\Programs\V.I.P.E.R\` and `%APPDATA%\V.I.P.E.R\` — no admin rights required, no machine-wide write access.
- MSI deployment (per-machine) is an IT-managed action; officers do not gain elevation from the application.
- Auto-updater requests UAC elevation **only** at the moment of update install (NSIS `Start-Process -Verb RunAs`); the running app does not retain elevation.
- Field Security separates case-data ciphertext from access — even a system administrator cannot read ciphertext without the user's passphrase.

**Policy Statement:** Officer accounts on VIPER hosts shall be standard (non-admin) accounts. Admin accounts shall be used only for installation, MSI deployment, or troubleshooting under change control.

**References:** Access Control Policy · Account Management/Access Control Standard · Secure Configuration Standard

---

### PR.AC-5 — Network integrity is protected (segregation/segmentation).

**Policy Statement [AGENCY-SPECIFIC]:** Hosts running VIPER shall reside on the agency's law-enforcement VLAN with egress filtered to the published external dependency list (see ID.AM-4).

**References:** Lab Security Policy · Mobile Device Security · System and Information Integrity Policy

---

## PR.AT — Awareness and Training

### PR.AT-1 — All users are informed and trained.

**VIPER Control:**
- Built-in onboarding tutorial on first launch.
- In-app **Resource Hub** with documentation for each module.
- Settings page contextual help for Field Security activation.
- Update warning banner: "Back up your data before updating."

**Policy Statement [AGENCY-SPECIFIC]:** Before being issued a VIPER license key, every officer shall complete:
1. The agency's information-security awareness training.
2. The Intellect LE VIPER training video series.
3. A documented review of this policy guide.

**References:** Acceptable Use Policy · Information Security Policy · Personnel Security Policy · Security Awareness and Training Policy

---

## PR.DS — Data Security

### PR.DS-1 — Data-at-rest is protected.

**VIPER Control:**
- **Field Security** (when enabled) encrypts every case-data file written to disk with **AES-256-GCM**.
- VIPENC magic header (6 bytes: `V`,`I`,`P`,`E`,`N`,`C`) plus version byte and 12-byte IV identify each encrypted blob.
- Encryption is applied transparently at the IPC boundary in the Electron main process — case modules never see plaintext on disk.
- Cases folder is hidden via `attrib +H` while Field Security is active (Windows).
- Master passphrase is processed via PBKDF2 / scrypt and never stored in plaintext.

**Policy Statement:** Field Security shall be enabled on every VIPER installation handling case data of any sensitivity above public-record. Master passphrases shall meet the agency's password-construction guideline.

**References:** Encryption Standard · Information Security Policy · Media Protection Policy · Mobile Device Security

---

### PR.DS-2 — Data-in-transit is protected.

**VIPER Control:**
- All outbound traffic is TLS-only (HTTPS) — Intellect Dashboard, GitHub, ARIN, Nominatim.
- Content Security Policy meta tag denies any non-HTTPS external resource.
- Canvas Form submissions are TLS-protected end-to-end (officer phone → dashboard → detective workstation).
- License validation includes timestamp + nonce to prevent replay.

**Policy Statement:** VIPER shall not be configured to use any non-TLS transport. Agencies operating self-hosted dashboards shall maintain a valid CA-issued TLS certificate.

**References:** Encryption Standard · Information Security Policy · System and Communications Protection Policy

---

### PR.DS-3 — Assets are formally managed throughout removal, transfers, and disposition.

**VIPER Control:**
- Case **Export** (`.vcase`) packages all module data into a single signed JSON file for transfer.
- Case **Import** validates structure, prompts on duplicate case numbers, never silently overwrites.
- **Backup** (`.vbak`) packages the entire user database for migration.
- License revocation on the dashboard immediately disables the source installation; case data on the originating device must be wiped per agency disposal policy.

**Policy Statement:** When a workstation is decommissioned, IT shall:
1. Export all cases the user owns (`.vcase` per case or `.vbak` whole-system backup) and verify import integrity on the receiving system.
2. Revoke the source workstation's license on the Intellect Dashboard.
3. Securely wipe the workstation per agency media-protection policy.

**References:** Acquisition Assessment Policy · Technology Equipment Disposal Policy · Sanitization Secure Disposal Standard

---

### PR.DS-7 — Development and testing environments are separate from production.

**VIPER Control:** Intellect LE maintains separate dashboards for development (`localhost:3000`), staging, and production. Released VIPER builds point exclusively at production.

**Policy Statement [AGENCY-SPECIFIC]:** Agencies shall not deploy unsigned/development VIPER builds to production endpoints handling real case data.

---

### PR.DS-8 — Integrity-checking mechanisms verify hardware/software integrity.

**VIPER Control:**
- VIPER installer + `latest.yml` are SHA-512 hashed; electron-updater verifies hash before applying any update.
- `verifyUpdateCodeSignature: true` rejects any installer not signed by the running app's publisher (Intellect LE).
- ASAR archive integrity is enforced at app launch (Electron 28+).
- Per-case auto-snapshot to disk every N minutes; recovery requires user-initiated action (not automatic on launch).

**Policy Statement:** Auto-update integrity verification shall remain enabled. Any installer not signed by Intellect LE shall not be installed.

**References:** Acquisition Assessment Policy · System and Information Integrity Policy

---

## PR.IP — Information Protection Processes and Procedures

### PR.IP-1 — Baseline configuration is created and maintained.

**VIPER Control:**
- VIPER ships with a documented secure default: Field Security off (must be explicitly enabled), auto-update on, telemetry off, media-player off, all optional integrations off.
- `electron-builder.yml` documents the build-time configuration baseline (file allow-list, asarUnpack rules, signing flags, data-preservation policy).
- `installer.nsh` documents the install-time baseline (per-user install path, data preservation across upgrade/uninstall, process-kill on install).

**Policy Statement:** The agency baseline shall override the secure default by enabling Field Security on first launch. All other settings shall remain at default unless explicitly approved.

**References:** Configuration Management Policy · Secure Configuration Standard · Secure System Development Life Cycle Standard

---

### PR.IP-4 — Backups of information are conducted, maintained, and tested.

**VIPER Control:**
- **Per-case auto-snapshots** to disk every interval (configurable in Settings).
- **Manual backup** via Settings → Backup (`.vbak` includes all Pattern 1 and Pattern 2 keys: cases, evidence index, KIK/Google/Discord/Snapchat warrant data, custom metrics, oversight imports, etc.).
- **Per-case export** via `.vcase` for granular handoff.
- Snapshot recovery is **user-initiated only** (Settings button) — never automatic on launch — to prevent accidental rollback.

**Policy Statement:** Officers shall create a manual `.vbak` backup at minimum weekly. Backups shall be stored on agency-approved media (encrypted external drive or NAS). Backups shall be test-restored quarterly.

**References:** Disaster Recovery Plan Policy · Information Security Policy

---

### PR.IP-6 — Data is destroyed according to policy.

**VIPER Control:**
- Case deletion in VIPER cascades through both Pattern 1 (shared `viperCase*` keys) and Pattern 2 (`<module>_<caseId>` keys), removing all associated localStorage entries.
- Evidence files on disk under `cases/<caseNumber>/` are deleted with the case folder.
- Canvas form submissions are **deleted on download** from the dashboard.
- Expired canvas forms are auto-deleted by the dashboard's hourly cleanup task.

**Policy Statement:** Cases retained beyond the agency's retention period shall be deleted using VIPER's case-delete function followed by the agency's media-sanitization procedure for the underlying disk space.

**References:** Technology Equipment Disposal Policy · Media Protection Policy · Sanitization Secure Disposal Standard

---

### PR.IP-9 — Response/recovery plans are in place and managed.

**Policy Statement [AGENCY-SPECIFIC]:** The agency shall maintain a written incident-response plan covering:
- Lost or stolen device with VIPER installed (license revocation, remote attestation if MDM-managed)
- Suspected unauthorized access to a case
- Compromise of an officer's master passphrase
- Compromise of the Intellect Dashboard
- Loss of case data (recovery from `.vbak` backup)

**References:** Data Breach Response Policy · Disaster Recovery Plan Policy · Security Response Plan Policy · Incident Response Policy

---

### PR.IP-10 — Response and recovery plans are tested.

**Policy Statement [AGENCY-SPECIFIC]:** The agency shall conduct an annual tabletop exercise covering at minimum one of the PR.IP-9 scenarios, with documented after-action review.

---

## PR.MA — Maintenance

### PR.MA-2 — Remote maintenance is approved, logged, and performed in a manner that prevents unauthorized access.

**VIPER Control:**
- VIPER does not include any remote-maintenance backdoor.
- Auto-update is the only remote-maintenance channel; updates require valid Intellect LE Authenticode signature and matching SHA-512 hash.
- Each update install is logged in the VIPER **Audit Log** (`modules/audit-log.js`) with version transition and timestamp.

**Policy Statement:** No remote-maintenance tool other than VIPER's signed auto-updater shall be permitted to modify the VIPER installation.

**References:** Remote Access Policy · Maintenance Policy · Security Logging Standard

---

## PR.PT — Protective Technology

### PR.PT-1 — Audit/log records are determined, documented, implemented, and reviewed.

**VIPER Control:**
- **Audit Log module** (`modules/audit-log.js`) records: module access, evidence intake, evidence export, case export, case import, license events, security events, settings changes.
- Logs are stored locally per-installation; agencies may export to SIEM via the agency's standard endpoint-log pipeline.
- The Intellect Dashboard's `AuditLog` table records admin actions on the dashboard side (license issuance, customer changes, release uploads).

**Policy Statement:** Audit logs shall be retained for the period required by agency retention policy (minimum 1 year recommended). Logs shall be reviewed at least monthly by a designated supervisor.

**References:** Information Logging Standard · Auditing and Accountability Standard · Security Logging Standard

---

### PR.PT-2 — Removable media is protected and use restricted.

**VIPER Control:**
- VIPER **Portable Mode** runs entirely from removable media (USB drive). Detection is automatic for non-system drives; explicit override via `.portable` marker file.
- Portable installs preserve `userdata/` and `cases/` on the USB drive — no data leaks to the host.
- Field Security applies identically to portable mode (passphrase required to open cases regardless of drive).

**Policy Statement:** When VIPER is run from removable media, the media shall be hardware-encrypted (FIPS 140-2 Level 2 or higher). Field Security shall be enabled. The media shall be tracked under the agency's removable-media inventory.

**References:** Acceptable Use Policy · Media Protection Policy · Mobile Device Security

---

### PR.PT-4 — Communications and control networks are protected.

**VIPER Control:** All outbound communication is TLS (see PR.DS-2). VIPER does not implement any control-network protocol.

**References:** Encryption Standard · System and Communications Protection Policy

---

### PR.PT-5 — Resilience mechanisms are implemented.

**VIPER Control:**
- Per-case auto-snapshots provide point-in-time recovery.
- License validation falls back to a cached "last-known-valid" timestamp for up to 7 days to prevent network-outage lockout.
- Auto-updater fallback chain: PowerShell elevated install → cached installer launch → `quitAndInstall` graceful retry.
- Installer preserves user data across upgrade and reinstall (`deleteAppDataOnUninstall: false`, NSIS data backup/restore via `CopyFiles /SILENT`).

**References:** Disaster Recovery Plan Policy · Security Response Plan Policy

---

# NIST FUNCTION: Detect (DE)

## DE.AE — Anomalies and Events

### DE.AE-3 — Event data is collected and correlated from multiple sources.

**VIPER Control:**
- Audit Log captures application events.
- Warrant parser modules (Discord, KIK, Google, Snapchat, Meta) ingest external event streams (sessions, IPs, devices) into a unified case timeline.
- Case **Timeline Events** module correlates manually-entered events with parsed warrant events.
- ARIN WHOIS lookup enriches IPs across all warrant parser modules with consistent provider/network/range data.

**Policy Statement:** Officers shall correlate warrant-return event data within VIPER's Timeline Events module rather than maintaining parallel external spreadsheets.

**References:** Information Logging Standard · Auditing and Accountability Standard · Vulnerability Scanning Standard

---

## DE.CM — Security Continuous Monitoring

### DE.CM-1 — The network is monitored for cybersecurity events.

**Policy Statement [AGENCY-SPECIFIC]:** Hosts running VIPER shall be monitored by the agency's EDR/AV solution. VIPER does not provide its own network monitoring.

**References:** Information Security Policy · Vulnerability Scanning Standard

---

### DE.CM-4 — Malicious code is detected.

**VIPER Control:**
- VIPER asserts ASAR integrity at launch (Electron 28+).
- Auto-updater rejects any installer with a hash mismatch or invalid Authenticode signature.
- The application does not execute downloaded scripts; all warrant-parser code is bundled and signed.

**Policy Statement:** Agency EDR shall be permitted to scan VIPER's installation directory and runtime processes. VIPER's exclusions list shall be limited to known false-positive paths (e.g. ASAR archive scans on launch).

**References:** Auditing and Accountability Standard · Secure Coding Standard · System and Information Integrity Policy

---

### DE.CM-7 — Monitoring for unauthorized personnel, connections, devices, and software.

**VIPER Control:** License validation events on the dashboard reveal unauthorized installation attempts (failed validation by IP, agent, fingerprint). Dashboard administrators see these in the `AuditLog` table.

**Policy Statement:** Dashboard administrators shall review failed license-validation events weekly and investigate any pattern indicating credential compromise.

---

## DE.DP — Detection Processes

### DE.DP-1 — Roles and responsibilities for detection are defined.

**Policy Statement [AGENCY-SPECIFIC]:**
- **Officer** — reports anomalous VIPER behavior to supervisor.
- **Supervisor** — escalates to agency IT.
- **IT** — investigates, coordinates with Intellect LE incident response if vendor involvement is required.

**References:** Incident Response Policy · Information Security Policy

---

### DE.DP-4 — Event detection information is communicated.

**Policy Statement [AGENCY-SPECIFIC]:** Confirmed VIPER security events shall be communicated to:
- Affected officers (within 24 hours)
- Agency CISO/IT director (immediately)
- Intellect LE incident response (if vendor coordination required)
- DA's office (if affected cases include active prosecution)

---

# NIST FUNCTION: Respond (RS)

## RS.RP — Response Planning

### RS.RP-1 — Response plan is executed.

**Policy Statement [AGENCY-SPECIFIC]:** Upon detection of a VIPER-related cybersecurity incident, the on-call IT analyst shall execute the agency's incident-response plan, treating VIPER as in-scope per PR.IP-9.

**References:** Security Response Plan Policy · Incident Response Policy · Planning Policy

---

## RS.CO — Communications

### RS.CO-1 — Personnel know their roles and order of operations.

**Policy Statement:** Per DE.DP-1 above. Roles shall be exercised annually per PR.IP-10.

---

### RS.CO-2 — Incidents are reported consistent with established criteria.

**Policy Statement [AGENCY-SPECIFIC]:** Reportable VIPER incidents include (non-exhaustive):
- Lost/stolen device with VIPER installed
- Suspected unauthorized case access
- Suspected master-passphrase compromise
- Auto-updater installing an unsigned/unexpected version
- Persistent license-validation failure indicating dashboard or network compromise

**References:** Data Breach Response Policy · Security Response Plan Policy · Incident Response Policy

---

### RS.CO-3 — Information is shared consistent with response plans.
### RS.CO-4 — Coordination with stakeholders occurs.
### RS.CO-5 — Voluntary information sharing occurs with external stakeholders.

**Policy Statement:** Information sharing with Intellect LE, MS-ISAC, and partner agencies shall follow agency information-sharing policy. The Intellect LE incident-response contact is published in the vendor due-diligence package.

---

## RS.AN — Analysis

### RS.AN-4 — Incidents are categorized consistent with response plans.

**Policy Statement [AGENCY-SPECIFIC]:** VIPER incidents shall be categorized using the agency's standard incident taxonomy with a mandatory "VIPER" tag for trend analysis.

---

## RS.IM — Improvements

### RS.IM-1 — Response plans incorporate lessons learned.
### RS.IM-2 — Response strategies are updated.

**Policy Statement:** After-action reviews from PR.IP-10 exercises and from real incidents shall feed updates to this policy guide. Updates shall be tracked in the document version history at the top of this file.

---

# NIST FUNCTION: Recover (RC)

## RC.RP — Recovery Planning

### RC.RP-1 — Recovery plan is executed during or after a cybersecurity incident.

**VIPER Control:**
- Restore from `.vbak` backup (Settings → Restore).
- Restore individual cases from `.vcase` exports.
- Restore from per-case auto-snapshot via Settings → Snapshot Recovery (user-initiated).
- Reinstall from signed installer; user data is preserved (`deleteAppDataOnUninstall: false`).

**Policy Statement:** Recovery from a compromised installation shall follow this order:
1. Quarantine the affected workstation.
2. Confirm latest `.vbak` backup is intact and pre-compromise.
3. Wipe and reimage the workstation per agency media-sanitization policy.
4. Reinstall VIPER from the signed installer.
5. Restore from the verified `.vbak` backup.
6. Re-issue a new license key (revoking the old one) before bringing back online.

**References:** Disaster Recovery Plan Policy · Contingency Planning Policy · Incident Response Policy

---

## RC.IM — Improvements

### RC.IM-1 — Recovery plans incorporate lessons learned.
### RC.IM-2 — Recovery strategies are updated.

**Policy Statement:** Annual review of this policy and the agency's recovery procedures shall incorporate lessons from any executed recoveries during the prior year.

---

## RC.CO — Communications

### RC.CO-1 — Public relations are managed.
### RC.CO-2 — Reputation is repaired after an incident.
### RC.CO-3 — Recovery activities are communicated to internal and external stakeholders.

**Policy Statement [AGENCY-SPECIFIC]:** Public communications regarding any VIPER-related incident shall be coordinated through the agency's public-information officer in consultation with Intellect LE.

---

# Appendix A — Mapping Summary (NIST CSF Subcategory → VIPER Control)

| NIST | Subcategory | Primary VIPER Control |
|---|---|---|
| ID.AM-1 | Device inventory | Dashboard customer roster |
| ID.AM-2 | Software inventory | Version-validation API + GitHub Releases |
| ID.AM-4 | External systems catalogued | CSP whitelist + documented dependencies |
| ID.AM-5 | Resource prioritization | Custom Metrics + case status taxonomy |
| ID.AM-6 | Roles and responsibilities | Agency-specific policy section |
| ID.RM-1 | Risk management process | Annual review checklist |
| ID.SC-2 | Supplier assessment | Vendor due-diligence package |
| ID.SC-4 | Supplier reassessment | Annual cert/repo/TLS review |
| ID.SC-5 | Supplier IR coordination | Intellect LE IR contact |
| PR.AC-1 | Identity management | API key + License key + dashboard revocation |
| PR.AC-3 | Remote access | No inbound surface |
| PR.AC-4 | Least privilege | Per-user install, no app elevation |
| PR.AC-5 | Network segregation | Agency VLAN |
| PR.AT-1 | Awareness/training | Onboarding tutorial + agency training |
| PR.DS-1 | Data-at-rest | Field Security AES-256-GCM |
| PR.DS-2 | Data-in-transit | TLS-only + CSP enforcement |
| PR.DS-3 | Asset disposition | `.vcase` / `.vbak` + license revocation |
| PR.DS-7 | Dev/test/prod separation | Separate dashboards |
| PR.DS-8 | Integrity checks | Authenticode + SHA-512 + ASAR |
| PR.IP-1 | Baseline configuration | Documented secure default |
| PR.IP-4 | Backups | `.vbak` + auto-snapshots |
| PR.IP-6 | Data destruction | Cascade delete + canvas TTL |
| PR.IP-9 | Response/recovery plans | Agency policy + this guide |
| PR.IP-10 | Plan testing | Annual tabletop |
| PR.MA-2 | Remote maintenance | Signed auto-updater only |
| PR.PT-1 | Audit logs | `modules/audit-log.js` |
| PR.PT-2 | Removable media | Portable mode + hardware-encrypted USB |
| PR.PT-4 | Comms protection | TLS-only |
| PR.PT-5 | Resilience | Snapshots + cached license + installer fallback |
| DE.AE-3 | Event correlation | Timeline + warrant parsers + ARIN |
| DE.CM-1 | Network monitoring | Agency EDR (out of scope for VIPER) |
| DE.CM-4 | Malicious code detection | ASAR integrity + signed-update enforcement |
| DE.CM-7 | Unauthorized monitoring | Dashboard validation logs |
| DE.DP-1 | Detection roles | Agency-specific policy section |
| DE.DP-4 | Detection comms | Agency notification chain |
| RS.RP-1 | Response execution | Agency IR plan |
| RS.CO-1..5 | Response comms | Agency comms plan |
| RS.AN-4 | Incident categorization | Agency taxonomy + "VIPER" tag |
| RS.IM-1/2 | Response improvement | Document version history |
| RC.RP-1 | Recovery execution | `.vbak` restore + reissue license |
| RC.IM-1/2 | Recovery improvement | Annual review |
| RC.CO-1..3 | Recovery comms | Agency PIO coordination |

---

# Appendix B — Adoption Checklist

Before placing VIPER into operational use, the agency shall confirm:

- [ ] License keys issued only to named officers/workstations
- [ ] Field Security enabled on all installations
- [ ] Master passphrases meet agency password-construction guideline
- [ ] Auto-update integrity verification enabled (default)
- [ ] CSP whitelist not relaxed
- [ ] Outbound firewall rules align with documented dependency list (ID.AM-4)
- [ ] Backup schedule established (PR.IP-4)
- [ ] Audit log retention configured (PR.PT-1)
- [ ] Incident response plan documents VIPER scenarios (PR.IP-9)
- [ ] Vendor due-diligence package on file (ID.SC-2)
- [ ] Section markers tagged **[AGENCY-SPECIFIC]** have been customized
- [ ] Document approved by agency CISO / Information Security Officer

---

# Appendix C — Document History

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-05-06 | Initial release. Aligned to MS-ISAC NIST CSF Policy Template Guide (2020-07-20). Covers VIPER v3.1.0. |

---

*This guide is provided by Intellect LE, LLC for use by agencies adopting VIPER. It is a template; adopting agencies are responsible for tailoring it to their own legal, regulatory, and operational requirements. The NIST Cybersecurity Framework is a publication of the U.S. National Institute of Standards and Technology. The policy template references in this document map to the SANS Institute / MS-ISAC policy templates; agencies seeking the underlying templates should consult cisecurity.org/ms-isac/.*
