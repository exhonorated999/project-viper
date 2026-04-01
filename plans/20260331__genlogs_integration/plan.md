# GenLogs Integration for VIPER — Cargo Theft Intelligence

## Overview
Integrate GenLogs freight intelligence API into VIPER to give cargo theft investigators real-time carrier vetting, vehicle tracking alerts, facility lookups, and proactive lead generation. This is an **opt-in feature** — toggled on/off in Settings with credentials stored locally.

## Design Principles
- **Niche feature, first-class UI** — Not everyone needs this. Hidden by default. When enabled, it should look premium and feel like a built-in intelligence platform, not a bolted-on API viewer.
- **Visually impressive responses** — GenLogs data rendered as rich cards with risk badges, sighting maps, contact panels, and animated status indicators. No raw JSON dumps.
- **Non-destructive** — GenLogs features add buttons/panels alongside existing UI. Nothing changes for users who don't enable it.
- **Offline-safe** — If GenLogs is unreachable or credentials are missing, features gracefully degrade with clear messaging.

## GenLogs API Endpoints (Relevant Subset)

| Endpoint | Method | Purpose | VIPER Use |
|---|---|---|---|
| `POST /auth/token` | Auth | Get access token from email+password+api-key | Settings → credential validation |
| `GET /carrier/profile` | Carrier | FMCSA details + equipment + sighting history by USDOT | Cargo module "Vet Carrier" |
| `GET /compliance-rules` | Vetting | Pass/fail/review assessment by USDOT | Cargo module risk badge |
| `POST /carrier/contacts` | Carrier | Dispatch, FMCSA, onboarded contacts by USDOT | Cargo module contact panel |
| `GET /carrier/recommendations` | Carrier | Carriers on a lane (origin→dest), real-time locations | Investigation context |
| `GET /facilities` | Shipper | Facility lookup by name/address | Victim Business → facility intel |
| `POST /alerts` | Alerts | Create hot/daily alerts by plate, VIN, trailer#, USDOT | Dashboard alert creation |
| `GET /alerts/run` | Alerts | Trigger alert scan | Dashboard alert panel |
| `GET /customer-compliance-rules` | Vetting | List configured vetting rules | Settings display |

**Skipped:** Onboarded Carriers CRUD, Shipper Lanes, Facility Network Map (logistics-focused, not investigation)

## Architecture

### Authentication Flow
```
Settings Page → User enters: API Key, Email, Password
            → VIPER calls POST /auth/token
            → On success: store API key + token + expiry in localStorage
            → Token auto-refreshes before expiry (re-auth with stored creds)
            → Credentials encrypted if Field Security is enabled
```

### localStorage Keys
- `genlogsEnabled` — boolean toggle
- `genlogsApiKey` — encrypted API key
- `genlogsEmail` — encrypted email  
- `genlogsPassword` — encrypted password
- `genlogsToken` — current access token
- `genlogsTokenExpiry` — ISO datetime
- `genlogsAlerts` — cached alert list

---

## Phase 1: Settings & Auth Foundation

### 1.1 Settings Page — GenLogs Section
- Add new collapsible section in `settings.html` below Media Player
- Toggle switch: "Enable GenLogs Cargo Intelligence"
- When enabled, show credential form:
  - API Key input (masked)
  - Email input
  - Password input (masked)
  - "Test Connection" button → calls `/auth/token`, shows green checkmark or red error
  - "Save Credentials" button → stores to localStorage
- Connection status indicator (Connected / Disconnected / Token Expired)
- "Clear Credentials" danger button

### 1.2 GenLogs API Service Module
- Create `modules/genlogs-api.js` — standalone service module
- Token management: auto-auth, cache token, refresh before expiry
- All API calls go through this service
- Error handling: 401 → re-auth, 403 → permission message, 500 → retry once
- Rate limiting awareness
- Functions:
  - `genlogsAuth()` → get/refresh token
  - `genlogsCarrierProfile(usdotNumber)` → profile + sightings
  - `genlogsVetCarrier(usdotNumber)` → compliance rules assessment
  - `genlogsCarrierContacts(usdotNumber)` → contacts
  - `genlogsCarrierRecommendations(origin, destination, options)` → lane carriers
  - `genlogsFacilityLookup(name, city, state)` → facilities
  - `genlogsCreateAlert(alertData)` → create hot/daily alert
  - `genlogsGetAlerts()` → list alerts (if endpoint exists, else from cache)

---

## Phase 2: Case Integration — Cargo Module

### 2.1 "Vet Carrier" Button on Cargo Items
- Cargo module already has fields: `bolNumber`, `trailerNumber`, `trailerPlate`, `mcNumber`, `carrierName`
- Add "🔍 Vet Carrier" button on each cargo item card (only visible when GenLogs enabled)
- Button appears when USDOT or MC# is populated (MC → we may need user to also enter USDOT, or display a prompt)
- Clicking opens a **slide-out intel panel** (right side drawer) with:

#### Carrier Profile Card
- Company name, DBA, entity type, carrier status (color-coded badge)
- Physical address, phone, email
- Power units count, driver count
- Cargo types carried (tag chips)
- FMCSA dates (MCS-150, add date)

#### Risk Assessment Card
- Overall status: PASS ✅ / REVIEW ⚠️ / FAIL 🔴 (large colored badge)
- Individual rule results as a checklist with pass/fail/review icons
- Rule counts summary bar (X pass, Y review, Z fail)

#### Sighting History Card  
- Timeline view of recent sightings (date, state, zip, source)
- Mini-map showing sighting locations as pins (reuse Leaflet from existing maps)
- "Last seen" prominent callout

#### Equipment Pairings Card
- Donut chart: equipment type breakdown (GenLogs vs FMCSA)
- Percentage bars

#### Contacts Card
- Dispatch contacts (validated by GenLogs — highlighted as "verified")
- FMCSA contacts
- Onboarded contacts
- Click-to-copy phone/email buttons

### 2.2 "Track Vehicle" Quick-Alert Button
- On cargo items with trailer#, plate, or VIN data
- "🚨 Create Alert" button → opens small modal:
  - Pre-fills from cargo item fields (plate, trailer#, VIN)
  - Alert type toggle: Hot (15-min) vs Daily
  - Alert name (auto-generated: "Case {caseNumber} - {plate/trailer#}")
  - Email recipient (default from settings)
  - Submit → calls `POST /alerts`
  - Shows confirmation with alert ID

### 2.3 TRACE Import Integration
- TRACE imports contain vehicle/suspect data that may include plates, VINs
- After TRACE import completes, if GenLogs is enabled:
  - Show "GenLogs Actions Available" badge on imported items that have trackable identifiers
  - Same "Vet Carrier" and "Create Alert" buttons available on TRACE imported data

### 2.4 Victim Business → Facility Lookup
- In Victim Business module, when business name + address are populated
- "🏭 Lookup Facility" button
- Calls `/facilities` with business name, city, state
- Shows facility card: name, category, operating hours, contact, lat/lon
- Option to plot on case map

---

## Phase 3: Dashboard Intelligence Module

### 3.1 Alert Bell Integration (index.html)
- Existing notification bell already shows overdue warrants
- Extend to also show GenLogs alert hits:
  - Badge count includes GenLogs alerts
  - Notification dropdown has two sections: "Warrants" and "GenLogs Alerts"
  - GenLogs alerts show: alert name, match type, timestamp
  - Click → opens alert detail or navigates to case

### 3.2 GenLogs Intel Dashboard Panel
- New collapsible section on dashboard (below stat cards, above case list)
- Only visible when `genlogsEnabled === true`
- Dark card with GenLogs branding accent (their green? or keep VIPER cyan)
- Contains:

#### Active Alerts Summary
- Count of hot vs daily alerts
- Table: alert name, type (hot/daily), target (plate/USDOT/trailer#), status (active/disabled)
- Quick-disable toggle per alert
- "+ New Alert" button → same modal as cargo module

#### Quick Carrier Lookup
- USDOT input field + "Vet" button
- Inline result: company name, status badge, pass/fail, last sighting
- "View Full Profile" → opens the slide-out panel

#### Recent Activity Feed
- Last N GenLogs queries made from this VIPER instance (stored in localStorage)
- Shows: timestamp, query type, target, result summary

---

## Phase 4: Polish & Visual Design

### 4.1 Slide-Out Intel Panel Design
- Right-side drawer (400-450px wide), slides in with animation
- Dark background with subtle gradient
- Section headers with colored left border accents
- Animated entry for data cards (stagger fade-in)
- Loading skeleton while API calls in-flight
- Close button + click-outside-to-close

### 4.2 Risk Badge System
- PASS: Green shield icon, green glow
- REVIEW: Amber/yellow warning triangle, pulsing
- FAIL: Red octagon/stop, red glow
- NOT VETTED: Gray question mark

### 4.3 Sighting Map
- Reuse Leaflet (already in case-detail for area canvas maps)
- Custom truck icon markers
- Color by recency (green = recent, fading to gray)
- Popup on click: date, zip, detection count

### 4.4 Responsive & Print-Safe
- Panel collapses properly on smaller screens
- GenLogs data excluded from case PDF export (API data, not case evidence)

---

## Implementation Order

1. **Phase 1** (Settings + API service) — foundation, no UI changes to case pages
2. **Phase 2.1** (Carrier vet panel in cargo module) — biggest visual impact
3. **Phase 2.2** (Alert creation from cargo) — quick win after panel exists
4. **Phase 3.1** (Dashboard alert bell) — ties alerts into workflow
5. **Phase 3.2** (Dashboard intel panel) — proactive investigation hub
6. **Phase 2.3** (TRACE import wiring) — extends existing buttons to TRACE data
7. **Phase 2.4** (Facility lookup) — smallest scope, nice-to-have
8. **Phase 4** (Polish pass) — animations, loading states, edge cases

## Files Modified/Created

| File | Changes |
|---|---|
| `modules/genlogs-api.js` | **NEW** — API service module |
| `settings.html` | Add GenLogs credentials section + toggle |
| `case-detail-with-analytics.html` | Cargo module buttons, slide-out panel, TRACE integration |
| `index.html` | Dashboard intel panel, alert bell extension |
| `electron-main.js` | CSP update for `api.genlogs.io` in connect-src |
| `preload.js` | No changes needed (all calls are HTTP from renderer) |

## Guidelines

- All GenLogs UI elements check `localStorage.getItem('genlogsEnabled') === 'true'` before rendering
- Token refresh happens silently; if re-auth fails, show non-blocking banner "GenLogs session expired — re-authenticate in Settings"
- Never store raw API responses long-term; cache only for current session
- Sighting map pins use same Leaflet + CartoCDN tiles already in CSP
- All new buttons use existing VIPER design language (cyan/green/orange accents, glass-morphism cards)
