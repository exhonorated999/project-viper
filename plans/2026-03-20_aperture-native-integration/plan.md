# Aperture Native Integration Plan

## Objective
Integrate Aperture email analysis capabilities natively into VIPER as a toggleable investigative feature. Aperture will function as a tab within VIPER cases, with data scoped to individual cases.

## Requirements
1. **Native Integration**: Aperture runs inside VIPER, not as external application
2. **Tab-Based Interface**: Opens as a new tab in VIPER cases
3. **Case-Scoped Data**: Data uploaded in Aperture tab stays with that specific case
4. **Multi-Source Support**: Support multiple .mbox file uploads per case with source differentiation
5. **Settings Toggle**: Ability to enable/disable Aperture feature in settings
6. **VIPER Aesthetics**: Adapt Aperture UI to match VIPER's visual style
7. **No Separate Case Management**: Remove Aperture's case creation, use VIPER's case context

## Source Locations
- **Aperture Source**: `D:\Workspace\aperture_iep`
- **VIPER Project**: `C:\Users\JUSTI\VIPER`

## Architecture Overview

### Current Aperture Structure
- **Technology**: React + TypeScript + Tauri
- **Pages**: Dashboard, FirstTimeSetup, CaseView, EmailView
- **Components**: AttachmentViewer
- **Backend**: Rust/Tauri for file operations and database

### VIPER Structure
- **Technology**: Vanilla JavaScript + HTML + Electron
- **Main File**: `case-detail-with-analytics.html`
- **Backend**: Node.js/Electron for local operations
- **Storage**: Local file-based storage for cases

### Integration Approach
1. **Convert React to Vanilla JS**: Port Aperture's React components to vanilla JavaScript
2. **Integrate as VIPER Module**: Add Aperture as a module in VIPER's `moduleConfig`
3. **Case Context Integration**: Link Aperture data to VIPER's case ID system
4. **File Operations**: Replace Tauri file operations with Electron IPC
5. **Database**: Implement case-specific .mbox parsing and email storage
6. **Styling**: Apply VIPER's color scheme and design patterns

## Phase Breakdown

### Phase 1: Setup and File Structure
- Create aperture module directory structure in VIPER
- Copy necessary Aperture source files
- Set up styles and assets

### Phase 2: Core Email Parsing
- Port .mbox file parsing logic
- Implement email data structure
- Create email storage per case

### Phase 3: UI Components
- Convert React components to vanilla JavaScript
- Email list view
- Email detail view
- Attachment viewer
- Multi-source management UI

### Phase 4: VIPER Integration
- Add Aperture to moduleConfig
- Create tab interface
- Implement settings toggle
- Link to case data storage

### Phase 5: Testing and Refinement
- Test with multiple .mbox files
- Verify data isolation between cases
- Polish UI and UX
- Performance optimization

## Key Files to Create/Modify

### New Files
- `aperture-module.js` - Main Aperture module logic
- `aperture-ui.js` - UI components and rendering
- `aperture-parser.js` - .mbox file parsing
- `aperture-styles.css` - VIPER-styled CSS for Aperture
- `aperture-data.js` - Data management and storage

### Modified Files
- `case-detail-with-analytics.html` - Add Aperture module to config
- `settings.html` - Add Aperture toggle
- `electron-main.js` - Add IPC handlers if needed

## Design Specifications

### VIPER Color Scheme
```
- viper-dark: #0a0e14 (background)
- viper-card: #1a2332 (cards)
- viper-cyan: #00d9ff (accent)
- viper-green: #00ff88 (success)
- viper-purple: #9d4edd (highlight)
- viper-orange: #ffa726 (warning)
```

### Module Features
1. **Upload .mbox Files**: Multiple uploads per case
2. **Source Labeling**: Ability to name/label each data source
3. **Email Timeline**: Chronological view of emails
4. **Search & Filter**: Search emails by sender, subject, content
5. **Attachments**: View and extract attachments
6. **Thread View**: Group related emails
7. **Export**: Export selected emails or analysis

## Data Storage Structure
```
cases/
└── [case-id]/
    └── aperture/
        ├── sources.json (list of .mbox sources)
        ├── emails.json (parsed email data)
        ├── attachments/
        │   └── [email-id]/
        └── metadata.json (search indices, tags)
```

## Implementation Notes
- Preserve original Aperture source code in `D:\Workspace\aperture_iep`
- All modifications happen within VIPER project
- Use progressive enhancement - start with core features, add advanced features iteratively
- Maintain compatibility with existing VIPER case structure
