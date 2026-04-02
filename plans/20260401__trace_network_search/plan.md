# TRACE Network Search Integration — Plan

## Overview
Allow VIPER law enforcement users (lifetime license holders) to search the TRACE broker network for matches against their investigation data. Toggle on/off in settings. Includes slide-out search panel, TRACE import module scan button, and cargo module data scanning. Full audit log for security.

## Architecture

### Two-Sided Work

**TRACE Broker (trace-broker)** — new endpoints for LE registration + search
**VIPER (Electron app)** — new module, settings, UI panels, audit log

---

## TRACE Broker Changes

### 1. New Store Type: `law_enforcement`
- `Store.company_type` already supports values — add `"law_enforcement"` as valid type
- LE stores can **query** (`/api/tokens/match`) but do **NOT submit** tokens
- LE stores get an API key just like retail/cargo stores

### 2. New Endpoint: `POST /api/le/register`
- **Public** (no auth required — called from VIPER on first TRACE enable)
- Request body:
  ```json
  {
    "name": "Officer Name",
    "email": "officer@agency.gov", 
    "agency": "Agency Name",
    "viper_license_key": "INT-PROJECT-VIPER-XXXX-XXXX-XXXX",
    "viper_api_key": "INT-XXXX-XXXX-XXXX-XXXX"
  }
  ```
- Broker validates VIPER license by calling Intellect Dashboard:
  `POST https://intellect-unified-dashboard-production.up.railway.app/api/license/validate`
  with the VIPER license key + product_slug `project-viper`
- If valid + non-demo → auto-approve:
  - Create Store (company_type=`law_enforcement`, plan=`le_verified`)
  - Generate API key, return to VIPER
- If demo or invalid → reject with 403

### 3. Enhanced Search Audit Log
- Extend `SearchLog` model with optional LE fields:
  - `search_reason: str | None` — why the search was conducted
  - `search_type: str | None` — manual | trace_scan | cargo_scan
  - `searcher_name: str | None` — officer name (from Store.contact_name)
- These fields are nullable so existing TRACE store searches are unaffected

### 4. Guard Token Submission for LE
- `/api/tokens/submit` — reject if `store.company_type == "law_enforcement"` (403)
- `/api/tokens/match` — allow for LE (already works, just needs license check)

---

## VIPER Changes

### 1. API Service: `modules/trace-search-api.js`
- IIFE pattern (same as genlogs-api.js, flock-api.js)
- `BROKER_URL = 'https://trace-broker-production.up.railway.app'`
- Token lifecycle: store API key in localStorage
- SHA-256 hashing client-side (same algorithm as TRACE desktop networkSync.js):
  - `sha256(value)` for Tier 1 exact tokens
  - `sha256('prefix:' + value)` for Tier 2 descriptors
  - Placeholder guard (same regex as TRACE: unknown, N/A, none, etc.)
- Methods:
  - `register(name, email, agency, viperLicenseKey, viperApiKey)` → calls `/api/le/register`
  - `search(tokens, caseRef, reason, searchType)` → calls `/api/tokens/match`
  - `checkStatus()` → calls `/api/license/status`
  - `isEnabled()` / `isRegistered()`
  - `extractSearchTokens(dataObj)` — tokenize arbitrary data (plate, name, BOL, MC#, etc.)
  - `extractCargoTokens(cargoItems)` — tokenize cargo module data
  - `extractTraceImportTokens(traceImportData)` — tokenize from TRACE import data
- Activity log: `traceSearchActivityLog` localStorage key
- Audit log: `traceSearchAuditLog` localStorage key — every search logged with:
  - `timestamp` (ISO-8601)
  - `userName` (from VIPER registration)
  - `searchType` (manual | trace_scan | cargo_scan)
  - `reason` (user-provided or auto-generated)
  - `tokenCount` (how many tokens searched)
  - `matchCount` (results)
  - `matchSummary` (confidence levels, store names — no raw PII)

### 2. Settings Panel (settings.html)
- "TRACE Network Search" section (between Flock Safety and Backup & Restore)
- Toggle on/off
- Registration flow (shown when enabled but not registered):
  - Auto-fills name/email/agency from VIPER registration data
  - "Connect to TRACE Network" button
  - Validates VIPER license is lifetime before attempting
  - Shows status: Registered / Not Registered / Registration Failed
- Connection status indicator
- "View Audit Log" button → modal showing search history
- "Disconnect" danger button (clears TRACE API key)

### 3. Slide-Out Search Panel (case-detail-with-analytics.html)
- Triggered from a new button in the case header area (when TRACE is enabled)
- Search form fields:
  - License Plate + State
  - Name (first + last)
  - BOL Number
  - MC Number  
  - CDL Number
  - Trailer Number / Plate
  - VIN
  - Reason for search (required — audit compliance)
- Each field hashed client-side before sending to broker
- Token type mapping (same as TRACE desktop):
  - plate → `vehicle_plate` (Tier 1)
  - VIN → `vehicle_plate` (Tier 1)
  - name → `suspect_exact` (Tier 1)
  - BOL → `cargo_trailer` (Tier 1)
  - MC# → `cargo_mc` (Tier 1)
  - CDL → `cargo_dl` (Tier 1)
  - trailer# → `cargo_trailer` (Tier 1)
- Results displayed as alert cards matching TRACE style:
  - **RED** (exact match) — store name, contact info, case ref, distance
  - **GREEN** (partial) — 3+ overlapping descriptors
  - **ORANGE** (soft) — 1-2 overlaps within tight radius
- Each result card: contact name, phone, email, agency, distance, confidence badge

### 4. TRACE Import Module — "Scan Network" Button
- New button at top of TRACE imports tab (near existing import button)
- Extracts ALL tokenizable data from all imported TRACE cases:
  - Vehicles (plates, VINs, make/model/color)
  - Suspects (names, DOB, descriptions)
  - Merchandise (serial numbers)
  - Cargo (MC#, CDL, trailer#, BOL)
- Bulk search: all tokens sent to `/api/tokens/match` in one call
- Progress indicator during scan
- Results displayed inline or in slide-out panel
- Audit logged as `search_type: "trace_scan"`

### 5. Cargo Module — "Scan Network" Button  
- Button in cargo detail section (alongside GenLogs buttons)
- Extracts tokens from current cargo item:
  - MC#, trailer plate, trailer#, BOL, CDL
  - Associated suspect plates/vehicles
- Single search call
- Results in slide-out panel
- Audit logged as `search_type: "cargo_scan"`

### 6. Audit Log
- Stored in `traceSearchAuditLog` localStorage
- Fields: timestamp, userName, searchType, reason, tokenCount, matchCount, matchSummary
- Viewable from Settings → "View Audit Log" button
- Exportable as CSV/JSON from settings
- Max 500 entries (FIFO rotation)
- Also sent to broker via enhanced SearchLog for server-side audit

### CSP Updates
- Add `https://trace-broker-production.up.railway.app` to connect-src on:
  - settings.html
  - case-detail-with-analytics.html
  - index.html (if dashboard panel added later)

---

## Implementation Order

### Phase 1: Broker Endpoints (trace-broker)
1. Add `SearchLog` columns (search_reason, search_type, searcher_name)
2. Add `POST /api/le/register` endpoint with Intellect Dashboard license validation
3. Guard `/api/tokens/submit` against LE stores
4. Test registration + match flow

### Phase 2: VIPER Foundation
5. Create `modules/trace-search-api.js`
6. Settings panel with toggle + registration flow
7. CSP updates + script tags

### Phase 3: VIPER Search UI
8. Slide-out search panel on case-detail page
9. TRACE import module "Scan Network" button
10. Cargo module "Scan Network" button
11. Audit log viewer in settings

### Phase 4: Polish
12. Visual design — match TRACE alert card style (RED/GREEN/ORANGE)
13. Test end-to-end with real broker
14. Commit + version bump

---

## Visual Design
- TRACE brand: use orange/amber accent to match TRACE identity
- Alert cards: colored left border (red/green/orange) + confidence badge
- Same slide-out panel architecture as GenLogs
- Skeleton loading during searches
- Audit log table: sortable, filterable, exportable
