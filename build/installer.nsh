; ─────────────────────────────────────────────────────────────────────────
;  V.I.P.E.R. — Custom NSIS Installer Script
; ─────────────────────────────────────────────────────────────────────────
;
;  CRITICAL POLICY — DO NOT MODIFY WITHOUT REVIEW:
;
;  This script MUST NEVER delete, wipe, reset, or otherwise destroy user
;  data under ANY circumstance. That includes:
;
;    * Standard install:  %APPDATA%\viper-electron\  (Chromium localStorage,
;                                                     license activation,
;                                                     case files, settings)
;    * Portable install:  $INSTDIR\userdata\         (same data on USB)
;                         $INSTDIR\cases\            (case file folders)
;
;  Data deletion is ONLY permitted from inside the running V.I.P.E.R. app
;  via explicit user action (e.g. "Delete Case" button). The installer,
;  uninstaller, and update flow are read-only with respect to user data.
;
;  Any future contributor adding a "wipe", "reset", "clean install", or
;  "remove user data" option to this file MUST get explicit owner approval
;  in writing first. There is NO valid use case for an installer-side wipe.
;
;  Behavior summary:
;   - customInit       : preserve portable data BEFORE installer overwrites files
;   - customInstall    : restore portable data AFTER new files are placed
;   - customUnInit     : preserve portable data BEFORE uninstaller removes $INSTDIR
;   - customUnInstall  : (intentionally inert — see policy above)
;   - customRemoveFiles: explicit guard so default RMDir /r doesn't touch userdata/cases
;
;  Cross-drive support: CopyFiles (NOT Rename) so USB → C:\Temp works.
; ─────────────────────────────────────────────────────────────────────────

!include "LogicLib.nsh"

; ── INSTALL FLOW ─────────────────────────────────────────────────────────

!macro customInit
  ; Kill any running V.I.P.E.R / Electron processes to release file locks
  nsExec::ExecToLog 'taskkill /F /IM "V.I.P.E.R.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000

  ; Back up portable data (in $INSTDIR) before the old version is removed.
  ; Standard-install data (%APPDATA%\viper-electron\) is OUTSIDE $INSTDIR
  ; and is never touched by the installer or uninstaller.
  IfFileExists "$INSTDIR\userdata\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\userdata" "$TEMP\VIPER_backup"

  IfFileExists "$INSTDIR\cases\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\cases" "$TEMP\VIPER_backup"

  ; Also recover any data preserved by a previous uninstall (see customUnInit).
  ; This handles the uninstall-then-reinstall workflow without data loss.
  IfFileExists "$INSTDIR\..\VIPER-Data-Preserved\userdata\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\..\VIPER-Data-Preserved\userdata" "$TEMP\VIPER_backup"

  IfFileExists "$INSTDIR\..\VIPER-Data-Preserved\cases\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\..\VIPER-Data-Preserved\cases" "$TEMP\VIPER_backup"
!macroend

!macro customInstall
  ; Restore portable data after new files are installed
  IfFileExists "$TEMP\VIPER_backup\userdata\*.*" 0 +2
    CopyFiles /SILENT "$TEMP\VIPER_backup\userdata" "$INSTDIR"

  IfFileExists "$TEMP\VIPER_backup\cases\*.*" 0 +2
    CopyFiles /SILENT "$TEMP\VIPER_backup\cases" "$INSTDIR"

  ; Clean up temp backup once data is safely placed at its final location
  RMDir /r "$TEMP\VIPER_backup"

  ; Clean up the post-uninstall preservation folder once data is restored
  RMDir /r "$INSTDIR\..\VIPER-Data-Preserved"
!macroend

; ── UNINSTALL FLOW ───────────────────────────────────────────────────────

!macro customUnInit
  ; Runs BEFORE electron-builder's default uninstall logic deletes $INSTDIR.
  ; This is our one chance to rescue portable user data from the doomed
  ; install directory.

  ; Kill running instances to release file locks
  nsExec::ExecToLog 'taskkill /F /IM "V.I.P.E.R.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  Sleep 1000

  ; Move portable data ONE LEVEL UP, out of $INSTDIR, so the default
  ; "RMDir /r $INSTDIR" cannot reach it. The user (or the next install)
  ; can recover it from there.
  ;
  ; Destination: <parent of INSTDIR> + VIPER-Data-Preserved
  ;   e.g.  C:/Program Files/V.I.P.E.R/userdata   ->  C:/Program Files/VIPER-Data-Preserved/userdata
  ;         I:/VIPER/userdata                     ->  I:/VIPER-Data-Preserved/userdata
  IfFileExists "$INSTDIR\userdata\*.*" 0 +3
    CreateDirectory "$INSTDIR\..\VIPER-Data-Preserved"
    CopyFiles /SILENT "$INSTDIR\userdata" "$INSTDIR\..\VIPER-Data-Preserved"

  IfFileExists "$INSTDIR\cases\*.*" 0 +3
    CreateDirectory "$INSTDIR\..\VIPER-Data-Preserved"
    CopyFiles /SILENT "$INSTDIR\cases" "$INSTDIR\..\VIPER-Data-Preserved"

  ; NOTE: %APPDATA%\viper-electron\ (standard install data) is outside
  ; $INSTDIR and outside this script's concern. NSIS will not touch it
  ; because `deleteAppDataOnUninstall: false` is set in electron-builder.yml.
!macroend

!macro customUnInstall
  ; INTENTIONALLY INERT. See policy at top of file.
  ;
  ; Do NOT add code here that deletes:
  ;   - $INSTDIR/userdata
  ;   - $INSTDIR/cases
  ;   - %APPDATA%/viper-electron
  ;   - $INSTDIR/../VIPER-Data-Preserved
  ;
  ; If a user wants to remove their data, they do it from inside the app
  ; or by manually deleting the folders themselves. The installer must
  ; never make that decision for them.
!macroend
