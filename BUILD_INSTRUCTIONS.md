# Building VIPER Desktop App - Complete Guide

## Problem Identified

The Tauri build is failing because **Visual Studio Build Tools with C++ support** are not installed. This is required for Rust to compile and link Windows executables.

## Error Message
```
error: linker `link.exe` not found
note: the msvc targets depend on the msvc linker but `link.exe` was not found
note: please ensure that Visual Studio 2017 or later, or Build Tools for Visual Studio were installed with the Visual C++ option.
```

## Solution: Install Build Tools

### Option 1: Visual Studio Build Tools (Recommended - Smaller Download)

1. **Download Build Tools for Visual Studio 2022:**
   - Visit: https://visualstudio.microsoft.com/downloads/
   - Scroll to "All Downloads"
   - Under "Tools for Visual Studio", download "Build Tools for Visual Studio 2022"

2. **Run the installer**

3. **Select Workload:**
   - Check: **"Desktop development with C++"**
   - This includes:
     - MSVC v143 - VS 2022 C++ x64/x86 build tools
     - Windows 11 SDK
     - C++ CMake tools
     - C++ core features

4. **Install** (requires ~7GB disk space)

5. **Restart your terminal/computer**

### Option 2: Full Visual Studio (If you want the IDE)

1. Download Visual Studio 2022 Community (free)
2. During installation, select: **"Desktop development with C++"**
3. Complete installation
4. Restart terminal/computer

### Option 3: winget (Command Line)

```powershell
# Install Build Tools via winget
winget install Microsoft.VisualStudio.2022.BuildTools

# Then run the Visual Studio Installer to add C++ workload
```

## After Installation

### Verify Build Tools Are Available

```powershell
# Should show path to cl.exe (MSVC compiler)
Get-Command cl.exe

# Should show path to link.exe (linker)
Get-Command link.exe
```

If these don't work, you may need to run from "Developer Command Prompt for VS 2022" or add to PATH.

### Rebuild VIPER

```powershell
cd C:\Users\JUSTI\Workspace\viper\viper-app

# Clean previous build
cd src-tauri
cargo clean
cd ..

# Build the app
npm run build
```

Build will take 10-15 minutes on first run (compiling all dependencies).

### Expected Output

```
   Compiling viper-app v1.1.0
    Finished release [optimized] target(s) in 12m 34s
    Bundling VIPER_1.1.0_x64-setup.exe
     Finished 2 bundles at:
        C:\Users\JUSTI\Workspace\viper\viper-app\src-tauri\target\release\bundle\nsis\VIPER_1.1.0_x64-setup.exe
```

### Install the New Build

```powershell
# Run the installer
.\src-tauri\target\release\bundle\nsis\VIPER_1.1.0_x64-setup.exe
```

Or copy to C:\Users\JUSTI\VIPER\ for distribution.

## Why This Is Needed for Production

### Current State
- ✅ HTML/JS files work in browser via localhost
- ❌ Desktop app build fails without MSVC toolchain

### Production Requirements
- Desktop app must run standalone (no localhost server)
- Users need double-click executable
- No browser, no terminal, no Python dependencies
- All resources bundled in the .exe

### Electron vs Tauri

You're using **Tauri** (Rust + WebView), not Electron:
- **Electron**: Bundles entire Chrome browser (~150MB+)
- **Tauri**: Uses system WebView, Rust backend (~5-10MB)
- **Benefit**: Much smaller, faster, more secure
- **Requirement**: Needs Rust + MSVC Build Tools to compile

## Alternative: Switch to Electron

If you don't want to install Build Tools, we could convert to Electron:

### Pros of Switching to Electron
- ✅ No MSVC Build Tools needed
- ✅ npm-based build system
- ✅ Wider compatibility
- ✅ More documentation/community

### Cons of Switching to Electron
- ❌ Much larger file size (~150MB vs 10MB)
- ❌ Higher memory usage
- ❌ Slower startup time
- ❌ Requires rewriting the build config

### Convert to Electron Command

```powershell
cd C:\Users\JUSTI\Workspace\viper
# Create new electron-based structure
npm init
npm install electron electron-builder
# Configure package.json for electron
# Remove Tauri dependencies
```

## Recommendation

**Install Visual Studio Build Tools** - it's the proper solution:

1. Required for many Rust projects on Windows
2. Useful for other development work
3. Tauri apps are smaller and faster than Electron
4. One-time 1-2 hour setup (including download)

## Timeline Estimate

- **Download Build Tools**: 20-30 minutes (depending on internet)
- **Install**: 20-40 minutes
- **First Tauri build**: 10-15 minutes (subsequent builds: 2-3 minutes)
- **Total**: ~1-2 hours

## Current Workaround

Until Build Tools are installed, use the localhost development version:

```batch
C:\Users\JUSTI\VIPER\START_VIPER.bat
```

This gives you all features including Network Intelligence, just requires:
- Keeping terminal window open
- Running on localhost:8000
- Python installed

## Questions?

- **Q: Can I use the old viper-app.exe?**
  - A: Yes, but it doesn't have Network Intelligence features

- **Q: Will the tracking prevention errors occur in Tauri app?**
  - A: No! Desktop apps don't have browser tracking prevention

- **Q: Do users need Build Tools to run the app?**
  - A: No, only YOU need it to BUILD. Users just run the .exe

- **Q: Is there a pre-built version?**
  - A: The old builds exist (v1.0.0, v1.1.0) but lack Network Intelligence

## Next Steps

1. Decide: Install Build Tools OR use localhost version
2. If installing: Follow Option 1 above, takes ~1-2 hours
3. If using localhost: You're already set up with START_VIPER.bat
4. For production deployment: Build Tools are required

Let me know which approach you want to take!
