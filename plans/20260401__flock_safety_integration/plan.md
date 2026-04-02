# Flock Safety LPR Integration — Plan

## Overview
Integrate Flock Safety's LPR (License Plate Reader) API into VIPER for cargo theft investigations. Same toggle-on/off pattern as GenLogs. Direct API calls from Electron app (no webhook server needed for Phase 1).

## API Surface (Phase 1 — Option B)

### Auth
- `POST https://api.flocksafety.com/oauth/token`
- Body: `grant_type=client_credentials`, `client_id`, `client_secret`, `audience=com.flocksafety.integrations`
- Returns: `access_token` (Bearer, 24hr TTL)

### Endpoints

**1. Plate Lookup**
- `POST /api/v3/reads/lookup`
- Search a plate across all Flock cameras by date range
- Params: `plate` (required), `startDate`, `endDate` (ISO8601), `reason` (required, audit), `caseNumber`, `limit` (1-50), `state`, `radius`, `area`, `sort`
- Returns: sightings with lat/lng, camera name, confidence, signed image URL (expires)
- Use case: Suspect plate from cargo/vehicles module → where has it been seen?

**2. Custom Hotlist Management**
- `GET /api/v3/hotlists` — list org hotlists
- `POST /api/v3/hotlists` — create/add plates to hotlist
- Limit: 5,000 active plates per org across all hotlists
- Use case: Push suspect plates from VIPER cases → Flock cameras auto-alert on them

### Constraints
- Every lookup requires `reason` string (Flock audit compliance)
- Image URLs are signed S3 with expiration — display immediately or cache locally
- Custom hotlist: 5,000 plate cap across org
- Machine-level auth (client credentials) sufficient for both endpoints

## Architecture

### Module: `modules/flock-api.js`
- IIFE pattern (same as genlogs-api.js)
- Token lifecycle: auto-refresh before 24hr expiry
- Methods: `authenticate()`, `plateLookup(plate, options)`, `getHotlists()`, `addToHotlist(hotlistId, plates)`, `removeFromHotlist()`, `createHotlist(name)`
- Activity logging to localStorage
- `isEnabled()` check

### Settings (settings.html)
- Flock Safety section (between GenLogs and Backup & Restore)
- Toggle on/off
- Client ID + Client Secret fields
- Test Connection button
- Connection status indicator

### Case Integration (case-detail-with-analytics.html)

**Cargo Module — "Search Flock LPR" button**
- Appears when trailer plate or suspect vehicle plate exists on a cargo item
- Opens slide-out panel (reuse GenLogs panel pattern or new panel)
- Requires `reason` input (pre-filled: "Cargo theft investigation — Case #{caseNumber}")
- Shows sighting timeline: date, camera name, location, confidence, thumbnail image
- Map with sighting markers (Leaflet, already available)

**Recovered Vehicles Module — "Search Flock LPR" button**
- Same pattern, search recovered vehicle plates

**Suspects Module — "Search Flock LPR" button**  
- If suspect has associated vehicle/plate info

**"Add to Flock Hotlist" button**
- Available on cargo items, recovered vehicles, suspects with plates
- Prompts for reason, selects hotlist (or creates "VIPER Cases" hotlist)
- Confirms plate added, shows count against 5,000 limit

### Dashboard (index.html)
- Flock Safety panel (similar to GenLogs panel, conditional on toggle)
- Active hotlist summary (plate count, hotlist names)
- Recent lookup activity feed
- Quick plate lookup input

### CSP Updates
- Add `https://api.flocksafety.com` to connect-src on all 3 pages
- Add Flock S3 image domain to img-src (signed URLs from `*.s3.amazonaws.com`)

## Phases

### Phase 1: Foundation
- `modules/flock-api.js` — API service
- Settings panel — toggle, credentials, test connection
- CSP updates + script tags on all pages

### Phase 2: Case Integration
- Plate Lookup in cargo module (slide-out results panel)
- Plate Lookup in recovered vehicles
- "Add to Flock Hotlist" from cargo/vehicles
- Reason input with case auto-fill

### Phase 3: Dashboard
- Flock intel panel on dashboard
- Quick plate lookup
- Hotlist status display
- Activity feed
- Alert bell extension (Flock hotlist count)

## Visual Design
- Flock brand color: use blue accent (#3B82F6) to differentiate from GenLogs emerald
- Same slide-out panel architecture, card animations, skeleton loading
- Sighting cards: thumbnail image, map pin, confidence badge, timestamp
- Timeline view for multi-sighting results
