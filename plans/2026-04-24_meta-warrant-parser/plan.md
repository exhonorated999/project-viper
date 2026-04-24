# META Warrant Parser Module — Implementation Plan

## Overview
Parse META (Facebook/Instagram) law enforcement warrant return ZIP archives within VIPER case detail. Follows the exact same architecture as the Google Warrant module.

## ZIP Structure (from sample analysis)
```
META_production.zip
├── records.html          (main production — all 12 categories)
├── preservation-1.html   (preservation snapshot — same format)
├── instructions.txt      (usage guide — ignored by parser)
└── linked_media/         (photos, message attachments)
    ├── photos_*.jpg
    └── unified_message_*.jpg
```

## HTML Data Pattern
All data uses nested `div.div_table` with CSS `display:table`. Key-value extraction:
```
div.div_table[font-weight:bold] → div.div_table[display:table] →
  TEXT NODE = key (e.g., "IP Address")
  div[display:table-cell] → div → value content
```
Records separated by `<br>`. Some categories nest further (Photos → Albums, Messages → Threads).
Categories identified by `<div id="property-{name}">` sections.
Empty categories contain "No responsive records located".

## Detection
`MetaWarrantParser.isMetaWarrantZip(zipBuffer)`:
- Has `records.html` or `preservation-*.html` entry
- HTML title contains "Facebook Legal Request" or "Instagram Legal Request"
- Has `linked_media/` directory

---

## Phase 1: Parser (main process)

### File: `modules/meta-warrant/meta-warrant-parser.js`

**Class: MetaWarrantParser**

Core methods:
- `static isMetaWarrantZip(zipBuffer)` — detection
- `async parseZip(zipBuffer)` — main entry, returns structured data
- `_parseHtmlFile(html)` — parses one HTML file, returns all categories
- `_extractKVPairs(sectionEl)` — generic key-value extractor from div_table pattern
- `_splitRecords(containerEl)` — split records by `<br>` separators
- `_extractMediaFiles(zip)` — returns map of `{ filename: base64data }`

Category parsers (all receive section DOM element):
- `_parseRequestParameters(el)` → `{ service, targetId, accountId, dateRange, generated }`
- `_parseNcmecReports(el)` → `[{ cybertipId, time }]`
- `_parseRegistrationIP(el)` → `{ ip }`
- `_parseIPAddresses(el)` → `[{ ip, time }]`
- `_parseAboutMe(el)` → `{ text }`
- `_parseWallposts(el)` → `[{ to, from, id, time, text, attachments }]`
- `_parseStatusUpdates(el)` → `[{ posted, status, mobile, id, author, displayDate }]`
- `_parseShares(el)` → `[{ dateCreated, link, summary, text, title, url, imageId }]`
- `_parsePhotos(el)` → `[{ album, imageFile, id, title, link, uploadIp, uploaded, author, tags }]`
- `_parseUnifiedMessages(el)` → `{ threads: [{ threadId, participants, messages: [{ author, sent, body, attachments }] }] }`
- `_parsePostsToOtherWalls(el)` → `[{ id, post, time, timelineOwner }]`
- `_parseBio(el)` → `{ text, creationTime }`

Return structure:
```js
{
  source: 'records' | 'preservation-1',
  service: 'Facebook' | 'Instagram',
  targetId: '59767010122078',
  accountId: '59767010122078',
  dateRange: { start, end },
  generated: '2024-01-09 23:39:40 UTC',
  ncmecReports: [],
  registrationIp: null,
  ipAddresses: [{ ip, time }],
  aboutMe: null,
  wallposts: [],
  statusUpdates: [{ posted, status, mobile, id, author }],
  shares: [],
  photos: [{ album, imageFile, id, title, link, uploadIp, uploaded, author, tags }],
  messages: { threads: [{ threadId, participants, messages: [...] }] },
  postsToOtherWalls: [{ id, post, time, timelineOwner }],
  bio: { text, creationTime },
  mediaFiles: { 'filename.jpg': 'base64...' }  // only small files; large saved to disk
}
```

### Media Strategy
- Files < 2MB: include as base64 in data (for inline rendering like Google module)
- Files > 2MB: save to `cases/{caseNumber}/Evidence/MetaWarrant/{importId}/linked_media/` and store path reference
- IPC handler `meta-warrant-read-media` reads file from disk on demand

---

## Phase 2: IPC Handlers (electron-main.js)

Add after Google Warrant handlers (~line 3490):

### `meta-warrant-scan` 
Scans `cases/{caseNumber}/Evidence/` and `cases/{caseNumber}/Warrants/Production/` for META warrant ZIPs. Uses `MetaWarrantParser.isMetaWarrantZip()` detection. Returns list of found files with name/path/size/alreadyImported status. **Same pattern as `google-warrant-scan`.**

### `meta-warrant-import`
Reads ZIP, runs `metaParser.parseZip(buf)`, saves large media files to disk, returns structured data. Supports Field Security encryption/decryption.

### `meta-warrant-pick-file`
File open dialog with ZIP filter. Title: "Select META Warrant Return ZIP".

### `meta-warrant-read-media`
Reads a media file from disk (for large files not stored as base64). Returns base64 data. Supports encryption.

### Preload bindings (preload.js):
```js
metaWarrantScan: (data) => ipcRenderer.invoke('meta-warrant-scan', data),
metaWarrantImport: (data) => ipcRenderer.invoke('meta-warrant-import', data),
metaWarrantPickFile: () => ipcRenderer.invoke('meta-warrant-pick-file'),
metaWarrantReadMedia: (data) => ipcRenderer.invoke('meta-warrant-read-media', data),
```

---

## Phase 3: Renderer Module

### File: `modules/meta-warrant/meta-warrant-module.js`

**Class: MetaWarrantModule** (mirrors GoogleWarrantModule)

- `constructor(caseId, caseNumber, caseName)`
- `async init(containerId)` — loads data, creates UI, triggers auto-scan
- `loadData()` — from `metaWarrant_${caseId}` localStorage
- `saveData()` — to `metaWarrant_${caseId}` localStorage
- `async scanForWarrants()` — calls `metaWarrantScan` IPC, updates evidence bar
- `async importWarrant(filePath, fileName)` — calls `metaWarrantImport` IPC, builds import record, saves
- `async importFromPicker()` — file dialog → importWarrant
- `deleteImport(importId)`
- `getItemCount()` — returns imports count

Storage key: `metaWarrant_${caseId}` (Pattern 2)

---

## Phase 4: UI

### File: `modules/meta-warrant/meta-warrant-ui.js`

**Class: MetaWarrantUI** (mirrors GoogleWarrantUI)

Layout: sidebar nav + content area (same as Google module `.gwp-layout` pattern)

**Sections/Nav:**
1. **Account Overview** — service, target ID, date range, registration IP, bio, NCMEC reports
2. **IP Activity** — table of IP addresses + timestamps (sortable)
3. **Posts & Status** — status updates, wallposts, posts to other walls, shares (combined social activity view)
4. **Photos** — grouped by album, thumbnail grid with lightbox, upload IP shown
5. **Messages** — thread list → expandable messages with attachments (images inline)
6. **Timeline** — unified chronological view across all categories

**Evidence bar** (auto-scan): Same pattern as Google module — shows detected META ZIPs in Evidence/Warrants folders with import/re-import buttons.

**Empty state**: Import instructions with file picker button + drag indication.

### File: `modules/meta-warrant/meta-warrant-styles.css`

Prefix all classes with `.mwp-` (meta warrant parser). Mirror structure from `.gwp-` styles in google-warrant-styles.css. Dark theme consistent with VIPER.

---

## Phase 5: Integration Points (8 locations)

### 1. case-detail-with-analytics.html — moduleConfig (~line 1551)
```js
metaWarrant: { label: 'META Warrant', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' }
```

### 2. case-detail-with-analytics.html — openManageTabsModal (~line 1717)
```js
allModules.metaWarrant = { label: 'META Warrant', icon: '📋' };
```

### 3. case-detail-with-analytics.html — showAddModuleModal (~line 20995)
```js
{ id: 'metaWarrant', label: 'META Warrant Parser', icon: '...', desc: 'Parse META (Facebook/Instagram) warrant returns — account, messages, photos, IP activity' }
```

### 4. case-detail-with-analytics.html — removeModuleFromCase moduleConfig (~line 1792)
```js
metaWarrant:'META Warrant'
```

### 5. case-detail-with-analytics.html — openExportCaseModal (~line 1852)
```js
metaWarrant: { label: 'META Warrant', icon: '📋', type: 'data' }
```

### 6. case-detail-with-analytics.html — getTabItemCount (~line 2051)
```js
case 'metaWarrant': {
    const mwData = JSON.parse(localStorage.getItem(`metaWarrant_${currentCase.id}`) || '{"imports":[]}');
    return (mwData.imports || []).length;
}
```

### 7. case-detail-with-analytics.html — renderTabContent (~line 3291)
```js
} else if (tabId === 'metaWarrant') {
    contentDiv.innerHTML = renderMetaWarrantTab();
    initializeMetaWarrant();
}
```
Plus `renderMetaWarrantTab()` and `initializeMetaWarrant()` functions (same pattern as Google).

### 8. case-detail-with-analytics.html — script includes (~line 706)
```html
<script src="modules/meta-warrant/meta-warrant-module.js"></script>
<script src="modules/meta-warrant/meta-warrant-ui.js"></script>
<link rel="stylesheet" href="modules/meta-warrant/meta-warrant-styles.css">
```

### 9. index.html — case creation modal (~line 1276)
Add META Warrant checkbox alongside Google Warrant.

### 10. index.html — Pattern 2 keys for import/backup (~line 1919 + 4802)
Add `'metaWarrant'` to pattern2Keys arrays.

### 11. settings.html — Pattern 2 backup prefixes (~line 2030)
Add `'metaWarrant_'` to pattern2Prefixes array.

### 12. electron-main.js — require + instantiate parser (~line 3366)
```js
const MetaWarrantParser = require('./modules/meta-warrant/meta-warrant-parser');
const mwParser = new MetaWarrantParser();
```

---

## Implementation Order

1. **Parser** — `meta-warrant-parser.js` with `isMetaWarrantZip` + `parseZip` + all category parsers. Test against sample ZIP.
2. **IPC handlers** — scan, import, pick-file, read-media in electron-main.js + preload.js bindings
3. **Module** — `meta-warrant-module.js` with data management, auto-scan, import flow
4. **UI** — `meta-warrant-ui.js` + `meta-warrant-styles.css` — all 6 sections
5. **Integration** — all 12 registration points
6. **Test** — import sample ZIP, verify all categories render, evidence auto-scan works

## Dependencies
- `adm-zip` — already installed
- `node-html-parser` — already installed  
- No new npm packages needed
