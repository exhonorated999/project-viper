# VIPER Warrant Author — v1 Plan

**Bundle:** `plans/2026-06-05_21-49-56__warrant-author-v1/`
**Created:** 2026-06-05
**Status:** P0 in progress
**Module name (code):** `warrant-author`
**Primary warrant type:** `multi-business-esp`
**UI label:** *Warrant Author*

---

## 1 · Purpose

Build a CA-first (generic-US fallback) authoring tool inside VIPER for
**Electronic Service Provider (ESP) search warrants**, with first-class
support for the user's signature **Multi-Business Warrant pattern** —
one shared affidavit + N per-business addendums, signed by a single
judge, served independently.

The module closes a loop VIPER uniquely owns:
**Author the warrant in VIPER → serve via provider portal → ingest the
return through the existing Aperture/Google/Meta/Snapchat/Discord/Kik
warrant parsers → auto-link the return to the originating addendum.**

---

## 2 · v1 Scope (locked)

### In scope
- ESP warrants only (search warrants directed at electronic service providers / ECSPs).
- Multi-Business pattern is first-class; single-business is a degenerate case (addendums array of length 1).
- California PC 1524 / CalECPA §1546.1 framing as primary template.
- Generic-US (federal SCA §2703) fallback template.
- Template + boilerplate library only. **Zero AI prose generation.**
- PDF + DOCX output (parallel composers, shared section model).
- Per-addendum lifecycle: draft → finalized → served → returned.
- Auto-linkage to ingested returns from the 6 existing warrant parsers.
- Curated 13-provider directory pre-populated from the user's existing templates.
- Boilerplate library pre-populated with verbatim CalECPA + NDO clauses extracted from user's exemplar set.
- Single Agency Profile in Settings (single source of truth for affiant identity).
- Hard validator + soft-warning panel before generation.
- Audit log integration for warrant lifecycle events.

### Out of scope (v2 candidates)
- Premises/physical search warrants
- Arrest warrants
- Ping / GPS tracker / pen register / geofence / Title III intercepts
- Multi-state beyond CA + generic-US
- AI-assisted prose drafting
- Multi-officer review / supervisor approval workflow
- E-filing integration (CA eWarrants, eSubmittal)
- E-signature integration
- Judge / court / magistrate directory
- Per-officer profiles on shared workstations
- Carrier CALEA-specific output formatting (T-Mobile, Verizon)

---

## 3 · Architectural Overview

### 3.1 Module layout

```
modules/warrant-author/
├── warrant-author-main.js          IPC, file I/O, SecurityManager-wired
├── warrant-author-ui.js            renderer-side helpers (tab + editor)
├── warrant-author-styles.css
├── template-engine.js              section graph + slot resolver
├── pdf-composer.js                 jsPDF render
├── docx-composer.js                docx pkg render
├── validator.js                    cross-addendum consistency checks
├── providers/                      curated registry (JSON)
│   ├── snapchat.json
│   ├── tiktok.json
│   ├── twitter-x.json
│   ├── whatsapp.json
│   ├── yahoo.json
│   ├── text-now.json
│   ├── venmo-paypal.json
│   ├── zscaler.json
│   ├── ultimate-internet.json
│   ├── sprint-tmobile.json
│   ├── microsoft.json
│   ├── charter-spectrum.json
│   ├── google.json
│   └── _agency_custom.json         agency-added providers
├── templates/
│   ├── ca-multi-business-esp.json   CA template with CalECPA blocks
│   └── generic-us-multi-business-esp.json   federal SCA only
├── boilerplate/                    curated library, agency-editable
│   ├── stock-clauses/              calecpa-1546-1-d2, calecpa-1546-1-d3, nondisclosure-1524, nondisclosure-info-support, delay-1546-2a
│   ├── training-experience/        icac, narcotics, robbery, homicide, fraud, missing-person, child-exploitation
│   ├── evidence-rationale/         content, metadata, location, photos, ip-logs, payment, multimedia
│   └── provider-specific/          google-geofence, apple-icloud, snapchat-ephemeral
└── test_fixtures/
    ├── _template_engine_test.js
    ├── _validator_test.js
    └── sample_case.json
```

### 3.2 Touched files

- `case-detail-with-analytics.html` — NEW **top-level "Warrant Author" tab** added to case detail navigation (sibling of, NOT child of, existing "Warrants" tab). Internal layout is a 3-subtab pill row: **Drafts / Outstanding / Returned**.
  - The legacy `renderWarrantsTab()` (received-return tracking) is **untouched**.
  - Tab registration follows the standard 6-location module pattern: `moduleConfig`, `openManageTabsModal`, `showAddModuleModal`, `openExportCaseModal`, `removeModuleFromCase` label config, `getTabItemCount` (= count of in-flight drafts + addendums), plus `renderTabContent` switch and `index.html` case-creation-modal entry.
  - Tab key: `warrant-author`. Display label: `Warrant Author`. Icon: ✍️ (or scroll/pen lucide icon).
  - Gated by `viperWarrantAuthorEnabled` localStorage flag — when disabled, tab is hidden everywhere.
- `electron-main.js` — register `WarrantAuthor.registerIpc(ipcMain)` + `setSecurityManager(security)` + `setMainWindow(mainWindow)`.
- `preload.js` — ~15 new bindings.
- `settings.html` — Agency Profile card (top of Settings page), Warrant Author enable toggle, Provider Directory editor, "Reset boilerplate to defaults" action.
- 6 parser modules — each gains `_tryLinkWarrantDraft(returnData, caseId)` after import:
  - `modules/aperture/aperture-main.js`
  - `modules/google-warrant/google-warrant-main.js`
  - `modules/meta-warrant/meta-warrant-main.js`
  - `modules/snapchat-warrant/snapchat-warrant-main.js`
  - `modules/discord-warrant/discord-warrant-main.js`
  - `modules/kik-warrant/kik-warrant-main.js`
- `modules/_shared/warrant-link.js` — NEW shared helper used by all 6 parsers.

### 3.3 New dependencies

- `docx` (Microsoft's official, MIT) — installed via `npm install docx`.

---

## 4 · Data Model

### 4.1 Per-case storage (Pattern 2)

```js
warrantAuthor_${caseId} = {
  drafts: [{
    id: 'wa_xxxx',
    type: 'multi-business-esp',
    template: 'ca-multi-business-esp' | 'generic-us-multi-business-esp',
    jurisdiction: 'CA' | 'US',
    status: 'draft' | 'finalized' | 'served' | 'partial-return' | 'fully-returned' | 'quashed',

    // SHARED across all addendums — single source of truth
    swNumber: 'string',
    caseRef: 'string',
    courtName: 'string',
    county: 'string',
    judgeName: 'string',
    affiantSnapshot: { /* deep copy of Agency Profile at draft creation */ },
    pc1524Grounds: {
      stolen: bool, felonyMeans: bool, possessedWithIntent: bool,
      evidenceOfFelony: bool, sexualExploitation: bool,
      arrestWarrant: bool, ecspMisdemeanor: bool, laborCode: bool
    },
    hobbsSealing: 'requested' | 'not-requested',
    nightSearch: 'requested' | 'not-requested',
    probableCauseNarrative: 'string (rich text)',
    tenDayExtensionRequested: bool,

    // ONE entry per business — the Multi-Business core
    addendums: [{
      id: 'ad_xxxx',
      pageLabel: 'A',                            // auto-managed
      providerKey: 'snapchat',                    // → providers/snapchat.json
      providerNameOverride: null,
      businessNameSnapshot: 'string',             // resolved at draft time
      custodianAttention: 'string',
      onlineService: 'string',
      serviceAddress: 'string',
      phone: 'string',
      email: 'string',
      notes: 'string',
      targetAccounts: [{
        type: 'esp-user-id' | 'email' | 'phone' | 'username' | 'ip' | 'screen-name',
        value: 'string',
        timestamp: 'ISO (optional, for IP-bridge)'
      }],
      dateRangeFrom: 'YYYY-MM-DD',
      dateRangeTo: 'YYYY-MM-DD',
      itemsToProduce: ['subscriber-info', 'ip-history', ...],
      itemsCustomText: 'string (override/append)',
      includeCalecpaSealing: true,                // §1546.1(d)(2)
      includeCalecpaAuthenticity: true,           // §1546.1(d)(3)
      includeNonDisclosure: true,                 // §1524 90-day
      includeNonDisclosureInfoSupport: true,      // CSAM-specific extension
      includeDelay1546_2a: true,                  // §1546.2(a) delay
      nonDisclosureDays: 90,
      orderToSendOverride: null,                  // null = use affiant snapshot

      // Lifecycle — PER-ADDENDUM
      servedAt: 'ISO',
      returnedAt: 'ISO',
      linkedReturnIds: []                         // populated by parser hooks
    }],

    pdfPath: 'cases/{caseNumber}/Warrants/Drafts/{warrantId}/warrant.pdf',
    docxPath: 'cases/{caseNumber}/Warrants/Drafts/{warrantId}/warrant.docx',
    manifestPath: 'cases/{caseNumber}/Warrants/Drafts/{warrantId}/manifest.json',
    createdAt: 'ISO',
    updatedAt: 'ISO'
  }]
}
```

### 4.2 Global storage (NOT per-case)

```js
// localStorage
viperAgencyProfile = {
  agencyName: 'Fontana Police Department',
  agencyAddress: '17005 Upland Ave, Fontana, California 92335',
  agencyShortName: 'FPD',
  unit: 'Internet Crimes Against Children Unit',
  unitShort: 'ICAC',
  county: 'San Bernardino',
  state: 'CA',
  affiantName: 'Justin Moyer',
  affiantRank: 'Detective',
  affiantBadge: 'string',
  affiantEmail: 'jmoyer@fontana.org',
  affiantPhone: '(909) 356-7168',
  trainingExperienceBoilerplate: 'long-form bio, optional shipped default',
  defaultCourtName: 'Superior Court of California, County of San Bernardino',
  defaultJudgeName: 'optional',
  hobbsSealingDefault: 'requested',
  nightSearchDefault: 'not-requested'
};

viperWarrantAuthorBoilerplate = {
  stockClauses: { /* shipped curated + agency edits */ },
  trainingExperience: { /* shipped curated + agency edits */ },
  evidenceRationale: { /* shipped curated + agency edits */ },
  providerSpecific: { /* shipped curated + agency edits */ }
};

viperWarrantAuthorCustomProviders = [ /* agency-added providers */ ];

viperWarrantAuthorEnabled = 'true' | 'false';
```

### 4.3 Disk files (NOT in `.vcase` export — Evidence convention)

```
cases/{caseNumber}/Warrants/Drafts/{warrantId}/
├── manifest.json   (VIPENC-encrypted when SecurityManager unlocked)
├── warrant.pdf     (VIPENC-encrypted when SecurityManager unlocked)
└── warrant.docx    (VIPENC-encrypted when SecurityManager unlocked)
```

On `.vcase` import without the disk files, the draft is rewritten with
`status: 'orphaned-files'` and a `_transferredFrom`/`_transferredAt`
marker so the UI shows a "Files not transferred — re-generate the
document" amber banner. This mirrors the Cellebrite/Evidence pattern.

---

## 5 · Document Structure (extracted from user's templates)

Every addendum is **18 structural blocks**, in the same order. Slots
are filled from the addendum + agency profile; the rest is library
text VERBATIM from user's exemplar set.

```
1.  Page label                            {{addendum.pageLabel}} → "Page A"
2.  "You are Therefore COMMANDED to SEARCH:"  (constant)
3.  Business identification block         5–7 slots from provider directory
4.  "For the FOLLOWING PROPERTY or PERSON(s):"  (constant)
5.  Target account block                  typed identifiers
6.  Date range
7.  Items to seize                        Pattern A / B / C from taxonomy
8.  CalECPA §1546.1(d)(2)                 VERBATIM IDENTICAL
9.  CalECPA §1546.1(d)(3)                 VERBATIM IDENTICAL
10. "IT IS FURTHER ORDERED [Provider] verify"  ← provider slot
11. "90 Day Non- Disclosure Order:"       (header)
12. NDO base clause                       VERBATIM, provider slot
13. INFO SUPPORTING NDO                   optional (CSAM-context extension)
14. "IT APPEARING that there is reason..."  VERBATIM IDENTICAL
15. "IT IS ORDERED [Provider] shall delay..."  ← provider slot
16. §1546.2(a) 90-day delay               VERBATIM IDENTICAL
17. "Order to Send Information:"          (header)
18. Affiant contact block                 from Agency Profile
```

---

## 6 · v1 Provider Directory (13 entries)

| Key | Legal Entity | Address | Email / Portal | Items pattern |
|---|---|---|---|---|
| `snapchat` | Snap Inc. | 2772 Donald Douglas Loop N, Santa Monica CA 90405 | lawenforcement@snapchat.com | A + snaps + memories |
| `tiktok` | TikTok Inc. | 5800 Bristol Pkwy #100, Culver City CA 90230 | portal | A |
| `twitter-x` | Twitter Inc. c/o Trust & Safety | 1355 Market St #900, San Francisco CA 94103 | portal | A |
| `whatsapp` | WhatsApp LLC (Law Enforcement Response Team) | 1601 Willow Rd, Menlo Park CA 92405 | portal | A |
| `yahoo` | Yahoo Inc. (Custodian of Records) | 1199 Coleman Ave, San Jose CA 95110 | portal | mail + Yahoo Cloud + GPS |
| `text-now` | Text Now Inc. | 2710 Gateway Oaks Dr #150N | lawenforcement@textnow.com | B + telephony |
| `venmo-paypal` | PayPal Inc. / Venmo (Global Investigations) | 2211 N First St, San Jose CA 95131 | 402-935-7733 | C + transactions |
| `zscaler` | Zscaler Inc. (Legal Compliance) | 110 Rose Orchard Way, San Jose CA 95134 | support@zscaler.com | B |
| `ultimate-internet` | Ultimate Internet Access Inc. | 3633 Inland Empire Blvd, Ontario CA 91764 | 909-605-2000 | B |
| `sprint-tmobile` | T-Mobile (formerly Sprint) | 6480 Sprint Pkwy, Overland Park KS 66251 | — | B + CDR + cell-site |
| `microsoft` | Microsoft Corp (Online Services) | 1 Microsoft Way, Redmond WA 98052 | 425-722-1299 | mail + OneDrive + IP |
| `charter-spectrum` | Charter Communications | 12405 Powerscourt Dr, St. Louis MO 63131 | — | B |
| `google` | Google LLC | Mountain View CA | LERS portal | mail + Drive + photos + location |

---

## 7 · Items-to-Seize Taxonomy

**Canonical categories** (universal):
```
subscriber-info · account-credentials · payment-billing · ip-history
messages-content · media · location-data · internet-artifacts
device-identification · multimedia-metadata
```

**Provider extras**:
```
cdr · cell-site · snaps · drive · icloud-backup · keychain
transactions · sensorvault · youtube-history · yahoo-cloud · onedrive
```

**Default-bundle patterns**:
- **Pattern A — Social Media (8 items)**: subscriber + messages-media + comms-content + location + multimedia + internet-artifacts + financial + device-id. Used by Snapchat, TikTok, Twitter, WhatsApp.
- **Pattern B — ISP/Carrier (single paragraph)**: subscriber + IP-bridge. Used by Charter, Ultimate Internet, Zscaler, Sprint, Text Now.
- **Pattern C — Custom**: Microsoft, Yahoo, Venmo/PayPal.

---

## 8 · Validator Behavior (Hard + Soft)

### Hard errors (block "Generate"):
- Agency Profile not configured
- Draft has zero addendums
- Any addendum missing `providerKey` or business name
- Any addendum missing target account(s)
- Any addendum missing date range
- `probableCauseNarrative` empty
- Dangling `{{slot}}` placeholders in any composed section

### Soft warnings (panel-only, allow proceed):
- Provider name appears in NDO clause that doesn't match `providerKey`
- Affiant info appears outside the affiant snapshot block
- Date range > 1 year (common rejection cause)
- Date range > today (typo)
- Items-to-seize list empty
- "ESP User ID" target value looks like a hash/UUID for providers that use names/emails
- Email-typo heuristics (basic Levenshtein against agency domain)
- PC 1524 grounds checklist all unchecked
- HOBBS sealing requested but no boilerplate justification in PC narrative

---

## 9 · Return-Linkage Hooks

Shared helper `modules/_shared/warrant-link.js`:

```js
WarrantLink.tryLinkReturn({
  caseId,
  providerKey,       // 'google' | 'snapchat' | ...
  identifiers,       // [{type, value}] — emails, usernames, phones, IPs
  returnId,          // module-specific
  returnMeta         // { kind, importedAt, sourceFile, ... }
}) → { matched: bool, draftId, addendumId, warrantId }
```

Each parser calls this after import. Matcher logic:
1. Filter `warrantAuthor_${caseId}.drafts[].addendums[]` by `providerKey === incoming.providerKey`.
2. Match by identifier overlap (case-insensitive, normalized).
3. If match: `addendum.linkedReturnIds.push(returnId)`, set `addendum.returnedAt = now()`, recompute draft `status`.
4. Surface in renderer: "Linked to Page X of Draft #Y" badge on returned import; "Returned 3d ago" badge on addendum.

---

## 10 · Phased Delivery

| Phase | Scope | Est. effort | Ship-impact |
|---|---|---|---|
| **P0** | Foundation: module skeleton; `docx` install; SecurityManager wiring; IPC scaffolding; storage shape; standalone **Warrant Author tab** registered (6-location module pattern) with 3-subtab empty states; plan persisted | 1–2 days | infra only |
| **P1** | Agency Profile in Settings + initial validation | 1 day | reusable foundation |
| **P2** | Provider Directory (13 curated) + agency-extensible CRUD in Settings | 2 days | foundation |
| **P3** | Items-to-Seize Taxonomy + Pattern A/B/C bundles | 1 day | foundation |
| **P4** | Template Engine + slot resolver + CA & generic-US templates | 2 days | foundation |
| **P5** | Boilerplate Library (verbatim CalECPA clauses + 50–100 paragraphs) | 3 days | content |
| **P6** | Authoring UI: Warrant Author tab → Drafts/Outstanding/Returned subtabs; 2-pane editor; auto-fill from suspects/Cellebrite/Aperture identifiers | 3 days | first usable UI |
| **P7** | Hard + Soft Validator with panel UI | 1 day | quality gate |
| **P8** | PDF Composer (jsPDF) — matches OPS Plan look | 2 days | first generated output |
| **P9** | DOCX Composer (docx pkg) | 2 days | ship-early checkpoint |
| **P10** | Per-addendum lifecycle: served/returned actions; Outstanding subtab list | 1 day | lifecycle |
| **P11** | Return auto-linkage: `_shared/warrant-link.js` + hooks into 6 parsers | 2 days | killer feature |
| **P12** | Polish + Audit Log + Compliance disclaimers (DA-review modal, doc footer) | 2 days | polish |
| **P13** | `.vcase` export integration + orphaned-files pattern | 1 day | wrap-up |

**Ship-early checkpoint:** End of **P9** = officer can fully author + generate PDF + DOCX. P10–P13 layer in lifecycle, linkage, polish.

**Total: ~3 weeks focused work.**

---

## 11 · Compliance & Disclaimers

- First-run modal on enable: *"VIPER Warrant Author is a drafting aid only. The shipped boilerplate has not been reviewed by your jurisdiction's prosecutor. Review with your DA before serving any warrant."*
- Per-document PDF/DOCX footer: *"Drafted with VIPER Warrant Author v1. Not a substitute for legal review."* (toggleable per-draft).
- Audit log events:
  - `warrant_drafted` — draft created
  - `warrant_addendum_added` — new addendum on draft
  - `warrant_finalized` — generation produced PDF/DOCX
  - `warrant_served` — addendum marked served
  - `warrant_returned` — addendum auto- or manually-linked to return
  - `warrant_quashed` — draft retracted
  - `settings_changed` — Agency Profile edited
  - `boilerplate_reset_to_defaults`
- Audit log respects existing Field Security pattern.

---

## 12 · Tasks Index

Per-phase tasks live in `tasks/` next to this `plan.md`:

```
plans/2026-06-05_21-49-56__warrant-author-v1/
├── plan.md                        (this file)
└── tasks/
    ├── 01_p0_foundation.json
    ├── 02_p1_agency_profile.json
    ├── 03_p2_provider_directory.json
    ├── 04_p3_items_taxonomy.json
    ├── 05_p4_template_engine.json
    ├── 06_p5_boilerplate_library.json
    ├── 07_p6_authoring_ui.json
    ├── 08_p7_validator.json
    ├── 09_p8_pdf_composer.json
    ├── 10_p9_docx_composer.json
    ├── 11_p10_lifecycle.json
    ├── 12_p11_return_linkage.json
    ├── 13_p12_polish_audit.json
    └── 14_p13_vcase_export.json
```

P0 tasks file is created alongside this plan. Subsequent phase task
files will be created as we open each phase, so we don't pollute the
state with tasks that may shift after P0–P1 inform the design.
