# WiGLE Network Intelligence Integration for VIPER

## Spec Provenance

**Project:** VIPER Case Management System - WiGLE Integration
**Date:** 2026-February-27
**Context:** Law enforcement digital forensics tool needs geolocation intelligence for WiFi/Bluetooth/Cell network data
**Stakeholders:** Law enforcement investigators, security teams
**Research Sources:**
- WiGLE.net platform analysis (https://wigle.net)
- WiGLE API documentation (https://api.wigle.net/swagger)
- Existing VIPER codebase inspection (C:\Users\JUSTI\Workspace\viper)
- WiGLE capabilities: 1.8B+ WiFi networks, 5B+ Bluetooth devices, 29M+ cell towers with geolocation

## Spec Header

### Name
**Network Intelligence Tab** - WiGLE geolocation integration for tracking devices via MAC addresses, SSIDs, and cell towers

### Smallest Acceptable Scope
A new modular tab in VIPER case management that enables investigators to:
1. Query WiGLE database by SSID (network name), BSSID (MAC address), or Cell Tower ID
2. View results on an interactive map with clustered markers
3. See timeline data (first seen / last seen dates) for each observation
4. Store API credentials securely in settings page
5. Save query results with case data

**Success Criteria:**
- Investigator enters MAC address → sees map of where device appeared
- Timeline shows first/last observation dates
- Credentials persist across sessions (encrypted in localStorage)
- Results display signal strength and observation count
- Tab integrates seamlessly with existing VIPER modules

### Non-Goals (Future Enhancements)
- ❌ Bulk import of MAC addresses from device dumps
- ❌ Automatic cross-referencing with suspects' known addresses
- ❌ PDF export of WiGLE data in case reports
- ❌ Batch processing or multiple simultaneous queries
- ❌ Historical data caching or offline mode
- ❌ Custom WiGLE data uploads from department wardrive operations
- ❌ Integration with Evidence tab for MAC address extraction

## Paths to Supplementary Guidelines

**Design:**
- Dark Modern Professional: https://raw.githubusercontent.com/memextech/templates/refs/heads/main/design/dark-modern-professional.md
  - Rationale: VIPER already uses dark theme (#0a0e14) with cyan accents (#00d9ff), glassmorphism cards, and high contrast for long investigation sessions

**Tech Stack:**
- N/A (existing stack sufficient)
  - Rationale: Vanilla JS/HTML + Tauri desktop app already in place; Leaflet maps integrated; WiGLE REST API via fetch; no new frameworks needed

## Decision Snapshot

### API Integration Approach
**Decision:** Direct REST API calls from frontend via fetch() with Basic Authentication
**Rationale:** 
- Simple implementation (no backend proxy needed)
- Tauri's security model allows CORS for desktop apps
- WiGLE API uses standard Basic Auth (API Name + Token as username:password)
**Trade-offs:** API tokens visible in localStorage (mitigated with encryption); rate limits apply per user account

### Credential Storage
**Decision:** Encrypted storage in localStorage via settings.html
**Rationale:**
- Consistent with VIPER's existing data persistence pattern
- Settings page already exists (settings.html)
- Simple base64 + XOR encryption sufficient for desktop app (not exposed to web)
**Trade-offs:** Not military-grade encryption, but adequate for local-only desktop application

### Map Visualization
**Decision:** Reuse existing Leaflet integration with MarkerCluster plugin
**Rationale:**
- Leaflet already loaded in case-detail.html for other features
- MarkerCluster handles thousands of observations gracefully
- Zero additional dependencies
**Trade-offs:** Limited to 2D maps (no 3D terrain), but sufficient for geolocation intelligence

### Query Types Priority
**Decision:** Phase 1 = WiFi BSSID/SSID only; Phase 2 = Bluetooth + Cell towers
**Rationale:**
- WiFi is most common investigative need (phone connection logs, seized device histories)
- WiGLE WiFi API endpoints most mature
- Bluetooth/Cell can share same UI patterns (add later with minimal rework)
**Trade-offs:** Delays full capability, but ships faster and validates UX

### Tab Module Pattern
**Decision:** Follow existing VIPER module structure with `networkIntelligence` module ID
**Rationale:**
- Consistent with suspects, victims, witnesses, evidence tab architecture
- Plugs into existing tab rendering, ordering, and drag-drop system
- Case-specific data storage in `viperCaseNetworkIntelligence` localStorage key
**Trade-offs:** None - perfect fit for existing architecture

## Architecture at a Glance

```
VIPER Desktop App (Tauri)
│
├── settings.html (NEW: WiGLE API credentials form)
│   ├── API Name input field
│   ├── API Token input field (password type)
│   └── Encryption helper functions
│       ├── encryptCredentials()
│       └── decryptCredentials()
│
├── case-detail.html (MODIFIED: Add Network Intelligence tab)
│   │
│   ├── Tab Navigation
│   │   └── [Overview] [Evidence] [Suspects] [🆕 Network Intel] [etc...]
│   │
│   └── Network Intelligence Tab Content
│       │
│       ├── Query Form Panel
│       │   ├── Search Type selector (SSID | BSSID | Cell Tower)
│       │   ├── Input field (MAC address / network name / tower ID)
│       │   ├── Optional: Lat/Lon + radius filters
│       │   └── [Search WiGLE] button
│       │
│       ├── Results Map Panel (Leaflet)
│       │   ├── Marker clusters for observations
│       │   ├── Popup with observation details
│       │   │   ├── SSID / BSSID
│       │   │   ├── First seen / Last seen
│       │   │   ├── Observation count
│       │   │   └── Signal quality (QoS)
│       │   └── Legend (color-coded by recency)
│       │
│       ├── Timeline Panel
│       │   ├── Horizontal timeline visualization
│       │   ├── Date markers (first/last seen)
│       │   └── Observation frequency graph
│       │
│       └── Query History
│           ├── Saved queries list
│           ├── Re-run button
│           └── Delete query button
│
└── WiGLE API Client (wigleAPI.js - NEW file)
    ├── searchWiFiByBSSID(mac)
    ├── searchWiFiBySSID(name, options)
    ├── searchCell(cellId, options)
    ├── searchBluetooth(mac) [Phase 2]
    └── Helper: buildBasicAuthHeader()
```

**Data Flow:**
1. User enters MAC address in query form → clicks Search
2. Fetch WiGLE credentials from localStorage (decrypt)
3. Call WiGLE API via fetch() with Basic Auth header
4. Parse JSON response (array of observations with lat/lon/timestamp)
5. Render markers on Leaflet map with clustering
6. Extract first/last seen dates → render timeline component
7. Save query + results to `viperCaseNetworkIntelligence[caseId]` in localStorage

**localStorage Schema:**
```javascript
// Settings
viperSettings = {
  // ... existing settings ...
  wigleApiName: "encrypted_base64_string",
  wigleApiToken: "encrypted_base64_string"
}

// Per-case network intelligence data
viperCaseNetworkIntelligence = {
  [caseId]: {
    queries: [
      {
        id: "query_uuid",
        timestamp: "2026-02-27T10:30:00Z",
        type: "bssid", // or "ssid" or "cell"
        query: "00:11:22:33:44:55",
        results: [
          {
            ssid: "CoffeeShop_WiFi",
            bssid: "00:11:22:33:44:55",
            lat: 34.0522,
            lon: -118.2437,
            firstSeen: "2025-03-15",
            lastSeen: "2026-02-20",
            observations: 142,
            qos: 7
          },
          // ... more observations
        ]
      }
    ]
  }
}
```

## Implementation Plan

### Phase 1: Settings & Credential Management (30 min)

**File:** `settings.html`

**Tasks:**
1. Add WiGLE API section to settings form
   ```html
   <div class="glass-card p-6 rounded-xl">
     <h3 class="text-xl font-bold text-viper-cyan mb-4">WiGLE Network Intelligence</h3>
     <p class="text-gray-400 text-sm mb-4">
       Get API credentials from <a href="https://wigle.net/account" target="_blank" class="text-viper-cyan">wigle.net/account</a>
     </p>
     <div class="space-y-4">
       <div>
         <label class="block text-gray-300 mb-2">API Name</label>
         <input type="text" id="wigleApiName" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-4 py-2" />
       </div>
       <div>
         <label class="block text-gray-300 mb-2">API Token</label>
         <input type="password" id="wigleApiToken" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-4 py-2" />
       </div>
       <button onclick="testWiGLEConnection()" class="px-4 py-2 bg-viper-cyan/20 text-viper-cyan rounded">
         Test Connection
       </button>
     </div>
   </div>
   ```

2. Add encryption helper functions (simple XOR + base64 for desktop-only app)
   ```javascript
   function encryptString(str) {
     const key = "VIPER_SECURE_KEY_" + navigator.userAgent; // Device-specific
     let encrypted = "";
     for (let i = 0; i < str.length; i++) {
       encrypted += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
     }
     return btoa(encrypted);
   }

   function decryptString(encrypted) {
     const key = "VIPER_SECURE_KEY_" + navigator.userAgent;
     const decrypted = atob(encrypted);
     let original = "";
     for (let i = 0; i < decrypted.length; i++) {
       original += String.fromCharCode(decrypted.charCodeAt(i) ^ key.charCodeAt(i % key.length));
     }
     return original;
   }
   ```

3. Save/load credentials in settings
   ```javascript
   function saveWiGLECredentials() {
     const settings = JSON.parse(localStorage.getItem('viperSettings')) || {};
     settings.wigleApiName = encryptString(document.getElementById('wigleApiName').value);
     settings.wigleApiToken = encryptString(document.getElementById('wigleApiToken').value);
     localStorage.setItem('viperSettings', JSON.stringify(settings));
     showNotification('WiGLE credentials saved', 'success');
   }

   function loadWiGLECredentials() {
     const settings = JSON.parse(localStorage.getItem('viperSettings')) || {};
     if (settings.wigleApiName) {
       document.getElementById('wigleApiName').value = decryptString(settings.wigleApiName);
     }
     if (settings.wigleApiToken) {
       document.getElementById('wigleApiToken').value = decryptString(settings.wigleApiToken);
     }
   }
   ```

4. Add test connection function
   ```javascript
   async function testWiGLEConnection() {
     const apiName = document.getElementById('wigleApiName').value;
     const apiToken = document.getElementById('wigleApiToken').value;
     
     if (!apiName || !apiToken) {
       showNotification('Please enter both API Name and Token', 'error');
       return;
     }

     const authHeader = 'Basic ' + btoa(apiName + ':' + apiToken);
     try {
       const response = await fetch('https://api.wigle.net/api/v2/profile/user', {
         headers: { 'Authorization': authHeader }
       });
       
       if (response.ok) {
         const data = await response.json();
         showNotification(`Connected! User: ${data.user}`, 'success');
       } else {
         showNotification('Authentication failed - check credentials', 'error');
       }
     } catch (error) {
       showNotification('Connection error: ' + error.message, 'error');
     }
   }
   ```

**Verification:** Open settings → enter test credentials → click Test Connection → see success message

---

### Phase 2: WiGLE API Client (45 min)

**New File:** Create `viper-app/wigleAPI.js`

**Tasks:**
1. Create API client class
   ```javascript
   class WiGLEClient {
     constructor() {
       this.baseURL = 'https://api.wigle.net/api/v2';
     }

     getCredentials() {
       const settings = JSON.parse(localStorage.getItem('viperSettings')) || {};
       if (!settings.wigleApiName || !settings.wigleApiToken) {
         throw new Error('WiGLE credentials not configured. Visit Settings.');
       }
       return {
         name: decryptString(settings.wigleApiName),
         token: decryptString(settings.wigleApiToken)
       };
     }

     getAuthHeader() {
       const creds = this.getCredentials();
       return 'Basic ' + btoa(creds.name + ':' + creds.token);
     }

     async searchWiFiByBSSID(bssid) {
       const url = `${this.baseURL}/network/search?netid=${bssid}`;
       const response = await fetch(url, {
         headers: { 'Authorization': this.getAuthHeader() }
       });
       
       if (!response.ok) {
         throw new Error(`WiGLE API error: ${response.status} ${response.statusText}`);
       }
       
       return await response.json();
     }

     async searchWiFiBySSID(ssid, options = {}) {
       let url = `${this.baseURL}/network/search?ssid=${encodeURIComponent(ssid)}`;
       
       // Optional filters
       if (options.latRange) {
         url += `&latrange1=${options.latRange[0]}&latrange2=${options.latRange[1]}`;
       }
       if (options.lonRange) {
         url += `&longrange1=${options.lonRange[0]}&longrange2=${options.lonRange[1]}`;
       }
       
       const response = await fetch(url, {
         headers: { 'Authorization': this.getAuthHeader() }
       });
       
       if (!response.ok) {
         throw new Error(`WiGLE API error: ${response.status}`);
       }
       
       return await response.json();
     }

     async searchCell(cellId, options = {}) {
       // Cell tower search endpoint
       let url = `${this.baseURL}/cell/search?cellid=${cellId}`;
       
       const response = await fetch(url, {
         headers: { 'Authorization': this.getAuthHeader() }
       });
       
       if (!response.ok) {
         throw new Error(`WiGLE API error: ${response.status}`);
       }
       
       return await response.json();
     }

     // Transform WiGLE response to VIPER format
     parseWiFiResults(wigleResponse) {
       if (!wigleResponse.results || wigleResponse.results.length === 0) {
         return [];
       }

       return wigleResponse.results.map(result => ({
         ssid: result.ssid,
         bssid: result.netid,
         lat: result.trilat,
         lon: result.trilong,
         firstSeen: result.firsttime,
         lastSeen: result.lasttime,
         observations: result.locationData?.length || 1,
         qos: result.qos || 0,
         encryption: result.encryption,
         channel: result.channel
       }));
     }
   }

   // Global instance
   const wigleClient = new WiGLEClient();
   ```

**Verification:** Open browser console → run `wigleClient.searchWiFiByBSSID('00:11:22:33:44:55')` → see JSON response

---

### Phase 3: Network Intelligence Tab UI (60 min)

**File:** `case-detail.html`

**Tasks:**
1. Add Network Intelligence to module config (around line 1078)
   ```javascript
   const moduleConfig = {
     // ... existing modules ...
     networkIntelligence: { 
       label: 'Network Intel', 
       icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z' 
     }
   };
   ```

2. Add renderNetworkIntelligenceTab function (in renderTabContent switch/if-else)
   ```javascript
   function renderNetworkIntelligenceTab() {
     const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
     const networkData = loadNetworkIntelligenceData(caseId);

     return `
       <div class="space-y-6">
         <!-- Header -->
         <div class="glass-card p-6 rounded-xl">
           <div class="flex items-center justify-between mb-4">
             <div class="flex items-center space-x-3">
               <svg class="w-8 h-8 text-viper-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
               </svg>
               <div>
                 <h2 class="text-2xl font-bold text-white">Network Intelligence</h2>
                 <p class="text-gray-400 text-sm">WiGLE Geolocation Database</p>
               </div>
             </div>
           </div>

           <!-- Query Form -->
           <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
             <div class="md:col-span-1">
               <label class="block text-gray-300 mb-2 text-sm">Search Type</label>
               <select id="wigleSearchType" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-3 py-2 text-white">
                 <option value="bssid">MAC Address (BSSID)</option>
                 <option value="ssid">Network Name (SSID)</option>
                 <option value="cell">Cell Tower ID</option>
               </select>
             </div>
             <div class="md:col-span-2">
               <label class="block text-gray-300 mb-2 text-sm">Query</label>
               <input 
                 type="text" 
                 id="wigleQuery" 
                 placeholder="e.g., 00:11:22:33:44:55 or NetworkName"
                 class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-3 py-2 text-white"
               />
             </div>
             <div class="md:col-span-1 flex items-end">
               <button 
                 onclick="executeWiGLESearch()" 
                 class="w-full px-4 py-2 bg-viper-cyan text-viper-dark font-bold rounded hover:bg-viper-cyan/80 transition-colors"
               >
                 Search WiGLE
               </button>
             </div>
           </div>

           <!-- Advanced Filters (collapsible) -->
           <div class="mt-4 border-t border-viper-cyan/20 pt-4">
             <button onclick="toggleAdvancedFilters()" class="text-viper-cyan text-sm flex items-center space-x-2">
               <span>Advanced Filters</span>
               <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
               </svg>
             </button>
             <div id="advancedFilters" class="hidden mt-4 grid grid-cols-2 gap-4">
               <div>
                 <label class="block text-gray-400 text-sm mb-1">Latitude Range</label>
                 <div class="flex space-x-2">
                   <input type="number" id="latMin" placeholder="Min" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-2 py-1 text-white text-sm" step="0.0001"/>
                   <input type="number" id="latMax" placeholder="Max" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-2 py-1 text-white text-sm" step="0.0001"/>
                 </div>
               </div>
               <div>
                 <label class="block text-gray-400 text-sm mb-1">Longitude Range</label>
                 <div class="flex space-x-2">
                   <input type="number" id="lonMin" placeholder="Min" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-2 py-1 text-white text-sm" step="0.0001"/>
                   <input type="number" id="lonMax" placeholder="Max" class="w-full bg-viper-dark border border-viper-cyan/30 rounded px-2 py-1 text-white text-sm" step="0.0001"/>
                 </div>
               </div>
             </div>
           </div>
         </div>

         <!-- Results Section -->
         <div id="wigleResults" class="hidden">
           <!-- Map Panel -->
           <div class="glass-card p-6 rounded-xl">
             <h3 class="text-xl font-bold text-white mb-4">Observation Map</h3>
             <div id="wigleMap" style="height: 500px; border-radius: 8px;" class="bg-viper-dark"></div>
             <div class="mt-4 flex items-center justify-between text-sm">
               <div class="text-gray-400">
                 <span id="observationCount">0</span> observations found
               </div>
               <div class="flex space-x-4">
                 <div class="flex items-center space-x-2">
                   <div class="w-3 h-3 rounded-full bg-red-500"></div>
                   <span class="text-gray-400">Recent (30d)</span>
                 </div>
                 <div class="flex items-center space-x-2">
                   <div class="w-3 h-3 rounded-full bg-yellow-500"></div>
                   <span class="text-gray-400">Medium (30d-1y)</span>
                 </div>
                 <div class="flex items-center space-x-2">
                   <div class="w-3 h-3 rounded-full bg-blue-500"></div>
                   <span class="text-gray-400">Old (1y+)</span>
                 </div>
               </div>
             </div>
           </div>

           <!-- Timeline Panel -->
           <div class="glass-card p-6 rounded-xl">
             <h3 class="text-xl font-bold text-white mb-4">Timeline</h3>
             <div id="wigleTimeline" class="bg-viper-dark rounded p-4">
               <!-- Timeline will be rendered here -->
             </div>
           </div>

           <!-- Details Table -->
           <div class="glass-card p-6 rounded-xl">
             <h3 class="text-xl font-bold text-white mb-4">Observation Details</h3>
             <div class="overflow-x-auto">
               <table id="wigleDetailsTable" class="w-full text-left text-sm">
                 <thead class="border-b border-viper-cyan/30">
                   <tr class="text-gray-400">
                     <th class="pb-3">SSID</th>
                     <th class="pb-3">BSSID</th>
                     <th class="pb-3">Location</th>
                     <th class="pb-3">First Seen</th>
                     <th class="pb-3">Last Seen</th>
                     <th class="pb-3">Observations</th>
                     <th class="pb-3">Encryption</th>
                   </tr>
                 </thead>
                 <tbody id="wigleDetailsBody" class="text-gray-300">
                   <!-- Rows populated by JS -->
                 </tbody>
               </table>
             </div>
           </div>
         </div>

         <!-- Query History -->
         <div class="glass-card p-6 rounded-xl">
           <div class="flex items-center justify-between mb-4">
             <h3 class="text-xl font-bold text-white">Query History</h3>
             <button onclick="clearQueryHistory()" class="text-red-400 text-sm hover:text-red-300">
               Clear All
             </button>
           </div>
           <div id="queryHistoryList" class="space-y-2">
             <!-- Query history items -->
           </div>
         </div>
       </div>
     `;
   }
   ```

3. Add data loading/saving functions
   ```javascript
   function loadNetworkIntelligenceData(caseId) {
     const allData = JSON.parse(localStorage.getItem('viperCaseNetworkIntelligence')) || {};
     return allData[caseId] || { queries: [] };
   }

   function saveNetworkIntelligenceData(caseId, data) {
     const allData = JSON.parse(localStorage.getItem('viperCaseNetworkIntelligence')) || {};
     allData[caseId] = data;
     localStorage.setItem('viperCaseNetworkIntelligence', JSON.stringify(allData));
   }

   function toggleAdvancedFilters() {
     const filters = document.getElementById('advancedFilters');
     filters.classList.toggle('hidden');
   }
   ```

**Verification:** Open case → see Network Intelligence tab → form renders correctly

---

### Phase 4: Map & Timeline Visualization (60 min)

**File:** `case-detail.html` (continued)

**Tasks:**
1. Execute search and render map
   ```javascript
   let wigleMap = null;
   let wigleMarkerLayer = null;

   async function executeWiGLESearch() {
     const queryType = document.getElementById('wigleSearchType').value;
     const query = document.getElementById('wigleQuery').value.trim();

     if (!query) {
       alert('Please enter a search query');
       return;
     }

     // Show loading state
     const resultsDiv = document.getElementById('wigleResults');
     resultsDiv.classList.remove('hidden');
     resultsDiv.innerHTML = '<div class="text-center text-gray-400 py-8">Searching WiGLE database...</div>';

     try {
       let results;
       const options = getAdvancedFilterOptions();

       // Call appropriate API method
       if (queryType === 'bssid') {
         const response = await wigleClient.searchWiFiByBSSID(query);
         results = wigleClient.parseWiFiResults(response);
       } else if (queryType === 'ssid') {
         const response = await wigleClient.searchWiFiBySSID(query, options);
         results = wigleClient.parseWiFiResults(response);
       } else if (queryType === 'cell') {
         const response = await wigleClient.searchCell(query, options);
         results = wigleClient.parseWiFiResults(response); // Similar format
       }

       if (results.length === 0) {
         resultsDiv.innerHTML = '<div class="text-center text-yellow-400 py-8">No results found</div>';
         return;
       }

       // Save query to history
       const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
       const networkData = loadNetworkIntelligenceData(caseId);
       networkData.queries.unshift({
         id: 'query_' + Date.now(),
         timestamp: new Date().toISOString(),
         type: queryType,
         query: query,
         results: results,
         resultCount: results.length
       });
       saveNetworkIntelligenceData(caseId, networkData);

       // Render results
       renderWiGLEResults(results);
       renderQueryHistory();

     } catch (error) {
       resultsDiv.innerHTML = `<div class="text-center text-red-400 py-8">Error: ${error.message}</div>`;
       console.error('WiGLE search error:', error);
     }
   }

   function getAdvancedFilterOptions() {
     const latMin = document.getElementById('latMin')?.value;
     const latMax = document.getElementById('latMax')?.value;
     const lonMin = document.getElementById('lonMin')?.value;
     const lonMax = document.getElementById('lonMax')?.value;

     const options = {};
     if (latMin && latMax) options.latRange = [parseFloat(latMin), parseFloat(latMax)];
     if (lonMin && lonMax) options.lonRange = [parseFloat(lonMin), parseFloat(lonMax)];
     return options;
   }

   function renderWiGLEResults(results) {
     // Re-render the results section
     const query = document.getElementById('wigleQuery').value;
     document.getElementById('wigleResults').innerHTML = renderNetworkIntelligenceTab().match(/<div id="wigleResults".*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/s)[0];
     document.getElementById('wigleResults').classList.remove('hidden');

     // Update observation count
     document.getElementById('observationCount').textContent = results.length;

     // Initialize or reset map
     if (wigleMap) {
       wigleMap.remove();
     }
     wigleMap = L.map('wigleMap').setView([results[0].lat, results[0].lon], 10);
     L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
       attribution: '© OpenStreetMap contributors'
     }).addTo(wigleMap);

     // Add marker cluster layer
     wigleMarkerLayer = L.markerClusterGroup();

     results.forEach(obs => {
       const markerColor = getMarkerColorByAge(obs.lastSeen);
       const marker = L.circleMarker([obs.lat, obs.lon], {
         radius: 8,
         fillColor: markerColor,
         color: '#fff',
         weight: 1,
         opacity: 1,
         fillOpacity: 0.8
       });

       marker.bindPopup(`
         <div style="min-width: 200px;">
           <strong style="color: #00d9ff;">${obs.ssid || 'Hidden Network'}</strong><br>
           <span style="color: #999;">BSSID:</span> ${obs.bssid}<br>
           <span style="color: #999;">First Seen:</span> ${obs.firstSeen}<br>
           <span style="color: #999;">Last Seen:</span> ${obs.lastSeen}<br>
           <span style="color: #999;">Observations:</span> ${obs.observations}<br>
           <span style="color: #999;">Encryption:</span> ${obs.encryption || 'Unknown'}<br>
           <span style="color: #999;">Channel:</span> ${obs.channel || 'N/A'}
         </div>
       `);

       wigleMarkerLayer.addLayer(marker);
     });

     wigleMap.addLayer(wigleMarkerLayer);
     wigleMap.fitBounds(wigleMarkerLayer.getBounds());

     // Render timeline
     renderTimeline(results);

     // Render details table
     renderDetailsTable(results);
   }

   function getMarkerColorByAge(lastSeenStr) {
     const lastSeen = new Date(lastSeenStr);
     const now = new Date();
     const daysDiff = (now - lastSeen) / (1000 * 60 * 60 * 24);

     if (daysDiff <= 30) return '#ef4444'; // red - recent
     if (daysDiff <= 365) return '#eab308'; // yellow - medium
     return '#3b82f6'; // blue - old
   }

   function renderTimeline(results) {
     // Extract unique dates
     const dates = results.map(r => new Date(r.lastSeen)).sort((a, b) => a - b);
     const firstDate = dates[0];
     const lastDate = dates[dates.length - 1];

     const timelineHTML = `
       <div class="flex items-center space-x-4">
         <div class="text-gray-400 text-sm">
           First: <span class="text-white">${firstDate.toLocaleDateString()}</span>
         </div>
         <div class="flex-1 h-2 bg-gradient-to-r from-blue-500 via-yellow-500 to-red-500 rounded"></div>
         <div class="text-gray-400 text-sm">
           Last: <span class="text-white">${lastDate.toLocaleDateString()}</span>
         </div>
       </div>
       <div class="mt-4 text-center text-gray-400 text-sm">
         Span: ${Math.ceil((lastDate - firstDate) / (1000 * 60 * 60 * 24))} days
       </div>
     `;

     document.getElementById('wigleTimeline').innerHTML = timelineHTML;
   }

   function renderDetailsTable(results) {
     const tbody = document.getElementById('wigleDetailsBody');
     tbody.innerHTML = results.map(obs => `
       <tr class="border-b border-viper-cyan/10 hover:bg-viper-cyan/5">
         <td class="py-3">${obs.ssid || '<em>Hidden</em>'}</td>
         <td class="py-3 font-mono text-xs">${obs.bssid}</td>
         <td class="py-3">${obs.lat.toFixed(4)}, ${obs.lon.toFixed(4)}</td>
         <td class="py-3">${obs.firstSeen}</td>
         <td class="py-3">${obs.lastSeen}</td>
         <td class="py-3">${obs.observations}</td>
         <td class="py-3">${obs.encryption || 'N/A'}</td>
       </tr>
     `).join('');
   }
   ```

2. Render query history
   ```javascript
   function renderQueryHistory() {
     const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
     const networkData = loadNetworkIntelligenceData(caseId);

     const historyHTML = networkData.queries.length === 0 
       ? '<p class="text-gray-400 text-sm">No queries yet</p>'
       : networkData.queries.map(query => `
           <div class="flex items-center justify-between p-3 bg-viper-dark rounded hover:bg-viper-cyan/5">
             <div class="flex items-center space-x-3">
               <svg class="w-5 h-5 text-viper-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
               </svg>
               <div>
                 <div class="text-white font-medium">${query.query}</div>
                 <div class="text-gray-400 text-xs">
                   ${query.type.toUpperCase()} • ${new Date(query.timestamp).toLocaleString()} • ${query.resultCount} results
                 </div>
               </div>
             </div>
             <div class="flex space-x-2">
               <button 
                 onclick="rerunQuery('${query.id}')" 
                 class="px-3 py-1 text-viper-cyan text-sm border border-viper-cyan/30 rounded hover:bg-viper-cyan/10"
               >
                 View
               </button>
               <button 
                 onclick="deleteQuery('${query.id}')" 
                 class="px-3 py-1 text-red-400 text-sm border border-red-400/30 rounded hover:bg-red-400/10"
               >
                 Delete
               </button>
             </div>
           </div>
         `).join('');

     document.getElementById('queryHistoryList').innerHTML = historyHTML;
   }

   function rerunQuery(queryId) {
     const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
     const networkData = loadNetworkIntelligenceData(caseId);
     const query = networkData.queries.find(q => q.id === queryId);

     if (query) {
       document.getElementById('wigleSearchType').value = query.type;
       document.getElementById('wigleQuery').value = query.query;
       renderWiGLEResults(query.results);
     }
   }

   function deleteQuery(queryId) {
     if (!confirm('Delete this query from history?')) return;

     const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
     const networkData = loadNetworkIntelligenceData(caseId);
     networkData.queries = networkData.queries.filter(q => q.id !== queryId);
     saveNetworkIntelligenceData(caseId, networkData);
     renderQueryHistory();
   }

   function clearQueryHistory() {
     if (!confirm('Clear all query history for this case?')) return;

     const caseId = JSON.parse(localStorage.getItem('currentCaseId'));
     saveNetworkIntelligenceData(caseId, { queries: [] });
     renderQueryHistory();
   }
   ```

**Verification:** Execute search → see map with markers → click marker → see popup with details

---

### Phase 5: Integration & Polish (30 min)

**Tasks:**
1. Add wigleAPI.js script tag to case-detail.html
   ```html
   <script src="wigleAPI.js"></script>
   ```

2. Add Network Intelligence to module list in case creation (index.html)
   ```javascript
   // In case creation modal, add checkbox:
   <label class="flex items-center space-x-2">
     <input type="checkbox" value="networkIntelligence" class="rounded bg-viper-dark border-viper-cyan/30">
     <span>Network Intelligence (WiGLE)</span>
   </label>
   ```

3. Add helpful tooltips
   - BSSID input: "MAC address format: 00:11:22:33:44:55"
   - SSID input: "Network name, e.g., Starbucks_WiFi"
   - Cell Tower: "Cell ID from phone records"

4. Error handling improvements
   - Check for credentials before allowing search
   - Show friendly error if WiGLE API rate limit hit
   - Validate MAC address format (XX:XX:XX:XX:XX:XX)

5. Add loading spinner during API calls
   ```javascript
   function showLoadingSpinner() {
     // Add animated spinner SVG to results div
   }
   ```

**Verification:** Full workflow test from settings → search → view results → save query

---

## Verification & Demo Script

### Pre-requisites
1. ✅ WiGLE account created at https://wigle.net
2. ✅ API credentials obtained from https://wigle.net/account
3. ✅ VIPER app running locally (Tauri dev mode or production build)

### Demo Flow

**Step 1: Configure Credentials (2 min)**
```
1. Launch VIPER app
2. Click Settings in sidebar
3. Scroll to "WiGLE Network Intelligence" section
4. Enter API Name: [your_api_name]
5. Enter API Token: [your_api_token]
6. Click "Test Connection"
   ✅ EXPECT: Green notification "Connected! User: [username]"
7. Click "Save Settings"
```

**Step 2: Create Test Case (1 min)**
```
1. Return to Dashboard
2. Click "New Case"
3. Enter case name: "WiGLE Integration Demo"
4. Check "Network Intelligence (WiGLE)" module
5. Click Create Case
   ✅ EXPECT: Case opens with Network Intel tab visible
```

**Step 3: Test MAC Address Search (3 min)**
```
1. Click "Network Intel" tab
2. Set Search Type: "MAC Address (BSSID)"
3. Enter known MAC: "00:25:00:FF:94:73" (example Starbucks router)
4. Click "Search WiGLE"
   ✅ EXPECT: Loading message appears
   ✅ EXPECT: Map loads with markers showing observations
   ✅ EXPECT: Timeline shows first/last seen dates
   ✅ EXPECT: Details table shows observation rows
5. Click a map marker
   ✅ EXPECT: Popup shows SSID, location, dates
```

**Step 4: Test SSID Search (2 min)**
```
1. Change Search Type to "Network Name (SSID)"
2. Enter: "Starbucks WiFi"
3. Click "Search WiGLE"
   ✅ EXPECT: Multiple locations appear (many Starbucks stores)
   ✅ EXPECT: Map clusters markers in dense areas
   ✅ EXPECT: Observation count shows hundreds/thousands
4. Zoom into map
   ✅ EXPECT: Clusters expand into individual markers
```

**Step 5: Test Advanced Filters (2 min)**
```
1. Click "Advanced Filters"
2. Set Latitude Range: 34.0 to 34.1
3. Set Longitude Range: -118.3 to -118.2 (Los Angeles area)
4. Enter SSID: "attwifi"
5. Click "Search WiGLE"
   ✅ EXPECT: Results limited to geographic bounding box
   ✅ EXPECT: Fewer markers than unfiltered search
```

**Step 6: Test Query History (2 min)**
```
1. Scroll to "Query History" section
   ✅ EXPECT: See 3 previous queries listed
2. Click "View" on first query
   ✅ EXPECT: Results reload from saved data (no API call)
   ✅ EXPECT: Map renders identical to original search
3. Click "Delete" on second query
   ✅ EXPECT: Query removed from history
4. Click "Clear All"
   ✅ EXPECT: Confirmation dialog appears
   ✅ EXPECT: All queries removed after confirmation
```

**Step 7: Test Error Handling (2 min)**
```
1. Enter invalid MAC: "not-a-mac-address"
2. Click Search
   ✅ EXPECT: No results or validation error
3. Go to Settings, delete API Token
4. Return to Network Intel tab
5. Try to search
   ✅ EXPECT: Error message "WiGLE credentials not configured. Visit Settings."
```

### Acceptance Criteria
- ✅ Credentials save and persist across app restarts
- ✅ Test connection validates credentials successfully
- ✅ MAC address search returns geolocation results
- ✅ SSID search finds multiple network instances
- ✅ Map displays clustered markers with color coding
- ✅ Timeline shows first/last observation dates
- ✅ Marker popups display full observation details
- ✅ Advanced filters narrow results by lat/lon
- ✅ Query history saves and can be re-loaded
- ✅ Error messages clear and actionable
- ✅ Rate limiting doesn't crash app (graceful error)
- ✅ Data persists with case (reload case → queries still there)

## Deploy

### Development Testing
```bash
cd C:\Users\JUSTI\Workspace\viper\viper-app
npm run dev
# or
.\start-tauri.ps1
```

### Production Build (Windows .exe)
```bash
cd C:\Users\JUSTI\Workspace\viper\viper-app
npm run build
# Creates: src-tauri/target/release/viper-app.exe
```

### Deployment Checklist
- [ ] Test with real WiGLE API credentials
- [ ] Verify encryption/decryption across browser restarts
- [ ] Test with 0 results (no data found)
- [ ] Test with 1000+ results (performance)
- [ ] Test rate limiting (intentionally trigger limit)
- [ ] Test offline behavior (no internet)
- [ ] Test with malformed API responses
- [ ] Verify localStorage doesn't exceed limits (5-10MB typical)
- [ ] Test on different screen resolutions (1920x1080, 1366x768)
- [ ] Create user documentation (how to get WiGLE API key)

### Documentation to Create
1. **README_NETWORK_INTELLIGENCE.md**
   - How to obtain WiGLE API credentials
   - Query syntax examples (MAC formats, wildcards)
   - Understanding WiGLE data (QoS, encryption types)
   - Rate limit guidelines (free vs. commercial)
   - Legal considerations (EULA compliance)

2. **NETWORK_INTEL_QUICKSTART.md**
   - 5-minute setup guide
   - Example searches for common scenarios
   - Screenshot walkthrough

3. **Update existing docs:**
   - Add Network Intelligence to V1.1.0_RELEASE_SUMMARY.md
   - Update README_ALL_TABS.txt with new module

### Distribution
- Copy `viper-app.exe` to installer package
- Include WiGLE setup guide in installation documentation
- Notify users of WiGLE EULA requirements
- Provide sample test case with pre-saved queries (optional)

### Future Enhancements (Post-V1.0)
- Export query results to PDF reports
- Bluetooth MAC address search (Phase 2)
- Cell tower ID search with carrier info
- Bulk import from CSV (device dump analysis)
- Integration with Evidence tab (extract MACs from files)
- Cross-reference with suspects' known addresses
- Heatmap view for device movement patterns
- Time-based filtering (only show observations in date range)
- Export map as PNG image for reports

---

**END OF PLAN**

Ready to implement! 🚔 This plan maintains VIPER's modular architecture, follows existing patterns, and delivers actionable network intelligence for investigators.
