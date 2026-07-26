# V.I.P.E.R. — Data-Flow & Third-Party Integration Disclosure

**Product:** V.I.P.E.R. (Versatile Investigative Platform for Enforcement Records)
**Vendor:** Intellect LE, LLC
**Document Version:** 1.0
**Applies to:** VIPER v4.0.8
**Companion to:** `VIPER_NIST_CSF_Policy_Guide.md` (ID.AM-4) · `VIPER_Architecture_and_Security.md`
**Audience:** Agency IT / CJIS Systems Officer (CSO) / Local Agency Security Officer (LASO) / risk & audit reviewers

---

## Purpose

This document is a complete, source-verified inventory of **every network connection VIPER can make**, exactly what data each connection transmits, and whether that data is Criminal Justice Information (CJI). It exists to answer one question precisely:

> *"VIPER interfaces with third-party services — does that mean our CJI leaves our control, and should this be treated as cloud/SaaS software?"*

**Short answer:** No. VIPER is a locally-installed desktop application. **No agency case content, subject identity, evidence, warrant return, or narrative text is ever transmitted to Intellect LE (the vendor).** The third-party services officers recognize (Flock, TLOxp, Accurint, etc.) are **not data integrations** — they are the vendor's own websites displayed inside VIPER, accessed with the **agency's own existing accounts**, with traffic flowing **directly between the officer's authenticated session and that provider**, exactly as it would in a web browser.

---

## The critical distinction: *embedded panel* vs. *data integration*

Most vendor-security questionnaires assume a **data integration**: your data is pushed from the vendor's servers to a third-party SaaS API, creating a chain of custody the vendor must attest to. **VIPER does not do this.** The recognizable third-party tools are **embedded browser panels**.

| | Data integration (what the questionnaire assumes) | Embedded browser panel (what VIPER actually does) |
|---|---|---|
| Where auth happens | Vendor holds/relays credentials or API keys | Officer signs in with the **agency's own account**, on the provider's real login page |
| Traffic path | Your data → vendor servers → third-party API | Officer's session ↔ provider, **directly** |
| Does VIPER see the data? | Yes, it passes through vendor systems | **No** — VIPER renders the provider's site; it does not proxy, store, or parse the traffic |
| Session isolation | Shared vendor context | **Dedicated, isolated session partition per service** (separate cookies/storage) |
| Equivalent to | A cloud middleware/ETL connector | Opening the site in Edge/Chrome |
| Who owns the CJIS relationship | Ambiguous / vendor-entangled | **The agency ↔ the provider** (unchanged by VIPER) |

**Consequence:** The security and CJIS relationship for Flock, Accurint, TLOxp, Vigilant, etc. is the one the **agency already has** with those providers. VIPER neither expands nor alters it. There is no VIPER-controlled server anywhere in that data path.

---

## Complete external-connection inventory (source-verified)

Grouped into four bounded categories. Hostnames, transmitted data, and classification are taken directly from the VIPER source (`electron-main.js`, page `Content-Security-Policy` headers, and the integration modules).

### Category A — Vendor infrastructure (licensing & software distribution)

| Endpoint | Purpose | What is transmitted | CJI? | Opt-out |
|---|---|---|---|---|
| `intellect-unified-dashboard-production.up.railway.app` | License validation / registration, version check | Organization name, license-key **hash**, product version, machine fingerprint, request IP | **No** | Required for licensing; contains no case data |
| `github.com/exhonorated999/project-viper` | Signed installer, `latest.yml`, on-demand Whisper engine download | Inbound download only (no case data sent) | **No** | Disable auto-update via firewall |

### Category B — Vendor-hosted privacy-preserving broker (opt-in)

| Endpoint | Purpose | What is transmitted | CJI? | Opt-out |
|---|---|---|---|---|
| `trace-broker-production.up.railway.app` | Optional cross-agency deconfliction ("TRACE Network") | **One-way SHA-256 token hashes only** (e.g. hash of a plate/name), plus token type/tier/case-type. Never the plaintext value. | **No plaintext CJI** — irreversible hashes only | **Off by default**; requires explicit enable + registration |

> **Design note:** The broker cannot recover the original search term from the hash. Deconfliction works by matching hashes, not by sharing data. This is a privacy-preserving design, not a data feed.

### Category C — Agency-authenticated embedded browser panels

VIPER renders each provider's **own website** inside an isolated `BrowserView` session partition. The officer authenticates with the **agency's existing account**. Traffic flows **directly between that session and the provider** — VIPER does not proxy, relay, store, or parse it.

| Service | Hostname | Isolated partition | Notes |
|---|---|---|---|
| Flock Safety LPR | `search-2.flocksafety.com` | `persist:flock` | Agency's Flock account |
| TLOxp | `tloxp.tlo.com` | `persist:tlo` | Agency's TLOxp account |
| Accurint (LexisNexis) | `secure.accurint.com` | `persist:accurint` | Agency's Accurint account |
| Whooster | `app.whooster.com` | `persist:whooster` | Agency's Whooster account |
| Vigilant / Motorola VehicleManager | `vm.motorolasolutions.com` | `persist:vigilant` | Agency's Vigilant account |
| ICAC Data System | `icacdatasystem.com` | `persist:icacDataSystem` | ICAC task-force credentials |
| ICAC COPS | `icaccops.com` | dedicated partition | ICAC task-force credentials |
| GridCop | `gridcop.com` | dedicated partition | Agency account |
| Callyo | `callyo.com` | dedicated partition | Agency account |

> Each panel can be hidden/disabled in **Settings**. The agency's existing CJIS agreements with these providers are the controlling authority for anything exchanged with them.

### Category D — Officer-initiated OSINT / enrichment lookups

Triggered explicitly by the officer; transmit only the query term, using the agency's own API credentials where applicable.

| Endpoint | Purpose | What is transmitted | CJI? |
|---|---|---|---|
| `api.wigle.net` | Wi-Fi / BT / cell geolocation | BSSID / SSID | Investigative query term |
| `api.genlogs.io` | Commercial-vehicle sightings / FMCSA data | USDOT / MC / plate | Investigative query term |
| `whois.arin.net` | IP ownership lookup | An IP address | Public registry query |
| `safer.fmcsa.dot.gov` | Motor-carrier lookup | Carrier name / number | Public registry query |
| `ip-api.com` | IP geolocation | An IP address | Public query |
| `nominatim.openstreetmap.org` | Address geocoding | An address string | Location query |
| `*.tile.openstreetmap.org`, `*.basemaps.cartocdn.com` | Map tiles | Tile coordinates only | **No** |
| `router.project-osrm.org` | Route calculation | Coordinates only | **No** |

---

## What is *never* transmitted anywhere off-device

Regardless of category, the following **never** leave the agency workstation via any VIPER connection:

- Case files, case numbers, case narrative, or report text
- Evidence files or their contents
- Warrant returns (KIK, Google, Discord, Snapchat, Meta, etc.) or anything parsed from them
- Victim / suspect / witness / missing-person identities as stored in a case
- Officer notes, operations plans, custom-metric values
- Master passphrases or encryption keys (Field Security keys are derived on-device and never leave it)
- Audit-log contents

CJI created and stored in VIPER lives in `%APPDATA%\viper-electron` on the agency's own device, inside the agency's existing CJIS perimeter, and is optionally encrypted at rest with AES-256-GCM (Field Security).

---

## Enforcement mechanisms (how the above is guaranteed, not just asserted)

- **Content-Security-Policy:** Every application page ships a CSP meta tag whose `connect-src` directive whitelists only the Category A/B/D endpoints. Renderer `fetch()`/XHR to any other origin is blocked by the Chromium engine.
- **Session isolation:** Each Category C service loads in a dedicated `persist:<service>` partition — cookies, storage, and auth state are isolated per service and from the main application.
- **No inbound listeners:** VIPER runs a loopback-only server on `localhost:8000` for internal page loading; it does not listen on external interfaces.
- **Opt-in by default:** Categories B, C, and D are user-initiated or explicitly enabled. A firewall/proxy allowlist can restrict VIPER to Category A only if the agency chooses.

---

## Recommended agency controls (drop-in for an audit file)

1. **Firewall/proxy allowlist** — permit only the endpoints in the categories the agency actually uses; block the rest.
2. **Provider agreements** — confirm existing CJIS/contractual coverage for each Category C service in use (these predate VIPER).
3. **Full-disk encryption** — BitLocker on every VIPER workstation (baseline at-rest control for the local case store).
4. **Field Security** — enable VIPER's AES-256-GCM field encryption on all installations.
5. **Audit-log retention** — export/retain VIPER's tamper-evident audit log per the agency's CJIS retention schedule.
6. **TRACE Network** — leave disabled unless the agency has adopted the deconfliction program; even when enabled, only irreversible hashes are shared.

---

## Verification

Every hostname and behavior in this document is verifiable in the published, signed source:

- Embedded-panel hostnames & partitions: `electron-main.js` (`BrowserView` definitions and `loadURL(...)` calls)
- CSP `connect-src` whitelists: `index.html`, `settings.html`, `case-detail-with-analytics.html` (`<meta http-equiv="Content-Security-Policy">`)
- TRACE broker (hash-only transmission): `modules/trace-search-api.js`, `modules/resource-hub.js`
- OSINT modules: `modules/genlogs-api.js`, WiGLE integration, `whois.arin.net`/`safer.fmcsa.dot.gov` handlers in `electron-main.js`

Intellect LE will demonstrate any of these live and provide packet/payload captures on request.
