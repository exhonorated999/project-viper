# Plan — Port "UC Chat Operations" from ICAC PULSE into Project VIPER

**Scope:** `C:\Users\JUSTI\Workspace\VIPER` ONLY. The `viper_supervisor_edition`
project is explicitly OUT OF SCOPE and must not be touched.

**Source of truth:** `C:\Users\JUSTI\Workspace\icac_case_manager` (ICAC PULSE).
Goal is exact-same workflow, UI and integration — re-implemented natively for
VIPER's stack.

---

## 1. The core challenge: architecture mismatch

| Concern            | ICAC PULSE (source)                    | VIPER (target)                                  |
|--------------------|----------------------------------------|-------------------------------------------------|
| Language           | TypeScript                             | Plain JavaScript                                |
| UI framework       | React (7 `.tsx` components)            | Vanilla DOM, self-injecting IIFE modules        |
| Bundler            | electron-vite                          | None — `<script src>` tags, MPA over localhost  |
| Main process       | `src/main/uc/*.ts` (7 modules)         | Single `electron-main.js` (~7000 lines)         |
| Preload API        | `window.api.ucChat*`                   | `window.electronAPI.*`                          |
| DB                 | `sql.js` app DB w/ migrations          | **No app DB** (better-sqlite3 only reads evidence) |
| Types              | `global.d.ts`                          | None (pure JS)                                  |
| Styling            | Tailwind + purple accent (#a78bfa)     | Tailwind (runtime), `viper-cyan`, `glass-card`  |

**Decision:** Everything gets re-implemented in vanilla JS. React components are
rewritten as DOM builders inside a new self-injecting module; main-process TS is
translated to CommonJS added to `electron-main.js` (or a required helper file).

## 2. Confirmed decisions (from user)

1. **Storage:** Introduce a real **better-sqlite3** application DB (faithful to
   ICAC's relational schema). better-sqlite3 is already a dependency +
   electron-rebuild postinstall exists.
2. **FAB placement:** UC chat FAB sits in the bottom-right cluster, immediately
   LEFT of the Resource Hub magnifying-glass FAB. Resource Hub FAB is at
   `bottom:24px; right:24px` (48px wide) → UC FAB at `bottom:24px; right:84px`.
   Present across the app (index.html + case-detail-with-analytics.html).
3. **Delivery:** Full parity now, including HTML/PDF chat capture.

---

## 3. New / edited files in VIPER

### New files
- `modules/uc-chat/uc-chat-db.js` — better-sqlite3 DB bootstrap: opens
  `<userData>/viper-uc.db`, runs `CREATE TABLE IF NOT EXISTS` schema (see §5),
  exports a singleton `db` + prepared-statement helpers.
- `modules/uc-chat/uc-chat-main.js` — CommonJS translation of ICAC's
  `src/main/uc/*` (personas, chats, chatBrowserViews, photos, alertBus,
  evidenceLog). Exports `registerUcIpc({ getMainWindow })`.
- `modules/uc-chat/uc-notif-preload.js` — preload injected into every UC chat
  BrowserView partition. Hijacks `window.Notification` → `uc-notif-raw` IPC;
  polls `document.title` for unread badges → `uc-title-signal`.
- `modules/uc-chat/uc-chat-ops.js` — renderer IIFE module (the big one).
  Rewrites ChatTray + AddChatModal + LinkCaseModal + PersonaEditor +
  PersonaPhotos + ChatPhotoPanel + UcAlertHost as vanilla DOM. Injects FAB +
  full-screen workspace + modals + toast host. Auto-runs on DOMContentLoaded,
  gated by `localStorage.ucChatEnabled !== 'false'`.
- `modules/uc-chat/uc-chat-styles.css` — scoped styles / keyframes
  (`ucToastIn`), purple accent to match ICAC look.

### Edited files
- `electron-main.js`
  - `require('./modules/uc-chat/uc-chat-main.js')` and call
    `registerUcIpc({ getMainWindow: () => mainWindow })` after app ready.
  - Register `uc-photo://` file protocol → `<userData>/uc_photos/<pid>/<file>`
    (with path-traversal sandbox), matching ICAC `main/index.ts:487`.
  - UC-tag detection in existing capture handlers (see §7). If VIPER has no
    `resource-capture-pdf/html`, add `uc-chat-capture-pdf/html` handlers using
    `webContents.printToPDF` + a SingleFile/HTML dump.
- `preload.js` — add all `ucPersona*`, `ucChat*`, `ucChatBv*`, `ucPhoto*`,
  `ucOnAlert`, `ucDiscreetMode*`, `ucEvidenceLog*` methods to `electronAPI`
  (invoke for request/response, send for BV bounds/visibility).
- `index.html` — `<script src="modules/uc-chat/uc-chat-ops.js"></script>` +
  `<link>` for styles (after resource-hub.js).
- `case-detail-with-analytics.html` — same script/style include.
- `settings.html` — add "UC Chat Operations" toggle card in the Investigative
  Tools section: `toggleUcChat()` / `updateUcChatToggleUI()` / `initUcChatSettings()`
  writing `localStorage.ucChatEnabled`, dispatching `ucChatToggle` event.

---

## 4. IPC channel inventory (recreate in electron-main.js + preload.js)

Personas (invoke): `uc-persona-list/get/create/update/archive/unarchive`
Chats (invoke): `uc-chat-list/get/create/update/archive/unarchive/mark-read/
link-case/unlink-case/case-links/events`
BrowserViews: `uc-chat-bv-create` (invoke); `uc-chat-bv-set-bounds/set-visible/
load-url/reload/back/destroy/hide-all` (send, fire-and-forget)
Alerts: `uc-notif-raw` (on, from preload), `uc-title-signal` (on), `uc-alert`
(main→renderer broadcast; preload exposes `ucOnAlert(cb)`)
Discreet: `uc-discreet-mode-get/set`
Evidence: `uc-evidence-log-list/verify`
Photos: `uc-photo-list/add/update/archive/unarchive/uses/copy-to-clipboard/
pick-and-add/pick-files`
Capture (reuse or add): `uc-chat-capture-pdf`, `uc-chat-capture-html`

Persona session isolation: each persona → partition `persist:uc_<personaId>`,
so the same platform can hold different logins per persona. BrowserViews use the
persona partition + the notif preload.

---

## 5. Database schema (better-sqlite3, `<userData>/viper-uc.db`)

Verbatim port of ICAC schema (sql.js → better-sqlite3; SQL is compatible).
`cases(id)` FKs from ICAC are DROPPED (VIPER has no cases table); replace with a
nullable `case_id`/`primary_case_id` INTEGER referencing VIPER's case-number
convention (stored as-is, no FK). Enable `PRAGMA foreign_keys = ON` for the
intra-UC FKs only.

Tables: `uc_personas`, `uc_chats`, `uc_chat_case_links`, `uc_chat_events`,
`evidence_log`, `uc_persona_photos`, `uc_photo_uses` + all indexes.
(Full DDL captured in the exploration report; copy verbatim, minus `cases` FKs.)

On-disk dirs: `<userData>/uc_avatars/`, `<userData>/uc_photos/<persona_id>/`.
Photos are EXIF-stripped via Electron `nativeImage` re-encode, SHA-256 hashed.

---

## 6. Renderer UI parity (rewrite React → vanilla DOM)

Root workspace (ChatTray equivalent): full-screen overlay matching the
screenshot — top bar (title, persona picker, +Persona, Edit, Discreet, Expand,
Close), left ACTIVE CHATS list (+Chat), center case banner + embedded BrowserView
pane, right PERSONA CHEAT SHEET (name/age/gender/hometown/bio/backstory/officer
notes) + PERSONA PHOTOS strip (with SENT badges).
Modals: AddChat (persona + platform + URL/handle), PersonaEditor (+embedded
PersonaPhotos), LinkCase (link/unlink cases). Toast host (UcAlertHost) bottom-right
`z-[9999]`, click → open chat.
FAB: purple chat-bubble, `bottom:24px; right:84px`, unread badge; mutex with
Resource Hub drawer via a shared open/close event.
Platforms + default URLs: discord, telegram, instagram, whatsapp, snapchat,
messenger, meetme, sniffies, custom (URLs from ICAC `PLATFORM_URLS`).

BrowserView positioning: rAF loop syncs BV bounds to the DOM mount's
`getBoundingClientRect()`, suspended while modals are open (copy Flock pattern).

---

## 7. Capture (HTML/PDF) — full parity

- PDF: `chatView.webContents.printToPDF(opts)` → write to
  `cases/<caseNo>/uc/` (or userData if unlinked) → `recordEvidenceLog('create',...)`
  with SHA-256 → append `uc_chat_events` kind `capture`.
- HTML: if `single-file-cli` present in VIPER, reuse it; else fall back to
  `webContents.savePage(..., 'HTMLComplete')` or executeJavaScript DOM dump.
- Auto-route to the chat's `primary_case_id` when set (append `route` event).

VERIFY during Phase 1: does VIPER already have `resource-capture-pdf/html`
handlers (resource-hub uses capture)? If yes, extend them to detect a
`uc_chat_<id>` tag; if no, add dedicated `uc-chat-capture-*` handlers.

---

## 8. Build phases (bottom-up, each testable)

- **P1 — DB + main process:** uc-chat-db.js, uc-chat-main.js (personas/chats/
  links/events CRUD), registerUcIpc wired in electron-main.js. Test via a temp
  IPC smoke script / devtools `window.electronAPI.ucPersonaCreate(...)`.
- **P2 — BrowserViews + preload + notif preload:** BV create/bounds/visible/
  load/destroy, persona partitions, uc-notif preload, alert bus, uc-photo://.
- **P3 — Photos:** import (nativeImage EXIF strip), list/caption/archive,
  copy-to-clipboard w/ use logging + evidence log.
- **P4 — Renderer UI:** uc-chat-ops.js full workspace + modals + toasts + FAB,
  styles, script includes in the two HTML pages. Match screenshot fidelity.
- **P5 — Capture + evidence log verify UI.**
- **P6 — Settings toggle + FAB gating + polish + end-to-end test.**

## 9. Risks / watch-items
- better-sqlite3 native module must be rebuilt for Electron (postinstall exists;
  verify `.node` loads in packaged build).
- No `cases` table in VIPER — case linking uses VIPER's case-number strings, not
  integer FKs; adapt LinkCase modal to VIPER's case source (`getAllCases`?).
- Multiple BrowserViews per open workspace — memory; destroy on close.
- Persona partition logins persist on disk (OPSEC) — document, keep under userData.
- Capture handler reuse vs. new — resolve in P1.
