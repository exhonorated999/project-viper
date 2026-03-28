# VIPER with Network Intelligence - Quick Start Guide

## What This Is

This is VIPER with the new **Network Intelligence** module integrated, featuring:
- WiGLE API integration for WiFi/Bluetooth/Cell tower geolocation
- Interactive map visualization with clustered markers
- Timeline data (first seen / last seen dates)
- Signal strength and observation count display
- Secure credential storage

## Files Included

- `case-detail-with-analytics.html` - Main VIPER interface with analytics
- `wigleAPI.js` - WiGLE API integration module
- `settings.html` - Updated settings page (includes WiGLE API credentials)
- `index.html` - Dashboard/landing page
- `launch-viper-dev.ps1` - Recommended launcher (PowerShell)
- `start-viper-server.bat` - Alternative server-only launcher

## How to Run

### Option 1: PowerShell Launcher (Recommended)
```powershell
powershell -ExecutionPolicy Bypass -File launch-viper-dev.ps1
```

This will:
1. Start a local web server on port 8000
2. Automatically open VIPER in your browser
3. Bypass browser tracking prevention issues
4. Press any key in the terminal to stop

### Option 2: Manual Server Start
1. Double-click `start-viper-server.bat`
2. Open your browser to: `http://localhost:8000/case-detail-with-analytics.html`
3. Press Ctrl+C in the terminal to stop

### Option 3: Direct File Open (Not Recommended)
- Double-click `case-detail-with-analytics.html`
- **Note:** May encounter CDN tracking prevention issues in some browsers

## Why Use the Local Server?

Running through `http://localhost:8000` instead of opening files directly (`file://`) avoids:
- Browser tracking prevention blocking CDN resources (Leaflet, PapaParse, jsPDF, etc.)
- localStorage quota exceeded errors
- CORS restrictions on external resources
- Security warnings from modern browsers

## Setting Up WiGLE API

1. Launch VIPER using one of the methods above
2. Navigate to Settings
3. Enter your WiGLE API credentials:
   - **API Name**: Your WiGLE account username
   - **API Token**: Generated from https://wigle.net/account
4. Credentials are encrypted and stored locally

## Using Network Intelligence

1. Create or open a case
2. Enable the "Network Intelligence" module
3. Enter:
   - SSID (WiFi network name)
   - BSSID (MAC address)
   - Cell Tower ID
4. View results on the interactive map
5. Data is automatically saved with the case

## Troubleshooting

### Server won't start
- Check if port 8000 is already in use
- Make sure Python is installed and in PATH
- Try: `python -m http.server 8000` manually

### CDN resources blocked
- Always use the local server (Option 1 or 2)
- Don't open HTML files directly in browser

### LocalStorage quota exceeded
- Running through localhost provides more storage
- Old browser data can be cleared from Settings

### Build a New Desktop App

To create an updated `viper-app.exe` with these features:
```powershell
cd C:\Users\JUSTI\Workspace\viper\viper-app
cargo tauri build
```

The installer will be in: `src-tauri\target\release\bundle\nsis\`

## Technical Notes

- **Framework**: Vanilla JS + Tauri (Rust + WebView)
- **Maps**: Leaflet.js with MarkerCluster plugin
- **Storage**: Encrypted localStorage
- **APIs**: WiGLE REST API (Basic Auth)
- **Server**: Python http.server (development only)

## Next Steps

To integrate into the main Electron app:
1. Copy updated HTML/JS files to `viper-app/dist/`
2. Rebuild Tauri app: `cargo tauri build`
3. Install from `src-tauri/target/release/bundle/nsis/VIPER_*_setup.exe`

## Files Location

- **Development Source**: `C:\Users\JUSTI\Workspace\viper\viper-app\`
- **Quick Launch**: `C:\Users\JUSTI\VIPER\` (this directory)
- **Build Output**: `C:\Users\JUSTI\Workspace\viper\viper-app\src-tauri\target\release\bundle\`
