# Involved Persons Module + Move Person Between Tabs

## Feature 1: New "Involved Persons" Module

### Schema (generic person + role field)
```js
{
  name: '', dob: '', dlNumber: '', sex: '',
  height: '', weight: '', hairColor: '', eyeColor: '',
  scarsMarksTattoos: '',
  address: '', addressCityStateZip: '',
  phone: '', email: '',
  photo: '', residencePhoto: '',
  role: '',           // "Otherwise Involved", "Social Worker", "Parent", "Reporting Party", etc.
  relationship: '',   // relationship to case (e.g. "Parent of suspect John Doe")
  notes: '',          // free-text notes about this person
  rmsSource: '',      // populated by RMS import
  rmsRole: ''         // original RMS involvement type
}
```

### Registration Points (8 locations)
1. **moduleConfig** (line ~1423) — add `involvedPersons` entry
2. **openManageTabsModal** (line ~1549) — add to allModules
3. **showAddModuleModal** (line ~19454) — add to caseManagement array
4. **openExportCaseModal** (line ~1682) — add to allTabs
5. **removeModuleFromCase** (line ~1648) — add to moduleConfig labels
6. **getTabItemCount** (line ~1859) — add case for involvedPersons
7. **renderTabContent** (line ~3042) — add else-if for involvedPersons
8. **index.html case creation modal** (line ~1025 area) — add checkbox

### Storage & Export/Import
- Storage key: `involvedPersons_${caseId}` (Pattern 2)
- **exportCasePackage** (line ~1793): add 'involvedPersons' to moduleKeys array
- **index.html delete** (line ~4157): add 'involvedPersons_' to p2Prefixes

### RMS Routing Changes
- **processPendingRmsImport** (line ~1072): 
  - Keep SUSPECT/ARRESTED/DEFENDANT → suspects
  - Keep VICTIM → victims  
  - Change WITNESS only (not REPORTING PARTY) → witnesses
  - Route REPORTING PARTY + all unmatched → involvedPersons (not suspects)
  - Auto-add 'involvedPersons' module if persons routed there

### index.html Light Parser
- **moduleMap** (line ~2008): add `involvedPersons: 'involvedPersons'`
- Auto-detect: if "Other Person(s)" or "Otherwise Involved" detected → check involvedPersons

## Feature 2: Move Person Between Tabs

### Common Fields (transfer directly)
name, dob, dlNumber, sex, height, weight, hairColor, eyeColor, address, addressCityStateZip, photo, residencePhoto

### Module-Specific Fields
- **Suspects only**: scarsMarksTattoos, employerName, occupation, employerAddress, employerPhone, firearms[], vehicles[], identifiers[], criminalHistory[], rapSheet, firearmsDoc, arrested
- **Victims only**: phone, email, injuryDescription, injuryPhotos[], propertyDescription, propertyPhotos[], vehicles[], restingOrder, advocate
- **Witnesses only**: phone, email, relationship, statement, credibilityNotes
- **Involved Persons only**: phone, email, role, relationship, notes

### Strategy
- Transfer all common fields
- Preserve any module-specific fields that exist in destination schema
- Initialize new destination-specific fields with defaults
- Remove from source array, add to destination array
- Auto-add destination module if not in case

### UI
- Button in person detail view: "Move to..." dropdown with Suspects/Victims/Witnesses/Involved Persons
- Confirmation: "Move [Name] from Suspects to Involved Persons?"
- After move, switch to destination tab and show the person
