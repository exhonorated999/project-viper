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
;   - customRemoveFiles: resilient removal (kill + retry) replacing the stock
;                        atomic-rename that hard-aborts on a single locked file
;
;  Cross-drive support: CopyFiles (NOT Rename) so USB → C:\Temp works.
; ─────────────────────────────────────────────────────────────────────────

!include "LogicLib.nsh"

; ── Robust process termination ───────────────────────────────────────────
;
; Kill EVERY running V.I.P.E.R / Electron process and then WAIT until they
; are actually gone before proceeding.
;
; WHY THIS EXISTS (root cause of "Failed to uninstall old application files"):
;   During an auto-update the NEW installer must first run the OLD version's
;   uninstaller. That uninstaller performs an ATOMIC RENAME of every file in
;   $INSTDIR (un.atomicRMDir). If ANY file is still locked at that instant —
;   e.g. an invisible V.I.P.E.R.exe child process (Electron reuses the main
;   exe name for its GPU / renderer / utility / crashpad children) or an AV
;   engine still holding a handle on a freshly-touched DLL — the rename fails
;   with "file is busy", the uninstaller aborts with a non-zero exit code,
;   and electron-builder shows "Failed to uninstall old application files /
;   please try running again". The user sees this even with no visible VIPER
;   window open, because the offending processes are background children.
;
; A single taskkill + fixed `Sleep 1000` is NOT reliable on agency machines
; where endpoint-protection scanning delays handle release. So we loop:
; kill -> check -> sleep, until taskkill reports "no such process" (exit
; code 128) or we hit a sane cap, then add a final settle so Windows/AV
; fully release handles before any rename/RMDir of $INSTDIR.
; NOTE: a UNIQ suffix is required because ${__LINE__} inside a macro body
; resolves to the same definition line on every insertion, which would
; produce duplicate NSIS labels (compile error). Each call site passes a
; distinct UNIQ string.
!macro KillViperAndWait UNIQ
  StrCpy $R9 0
  viperKill_${UNIQ}:
    nsExec::ExecToLog 'taskkill /F /IM "V.I.P.E.R.exe" /T'
    Pop $R8
    nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
    Pop $R7
    ; taskkill exit code 128 == "no matching process" -> nothing left to kill.
    ${If} $R8 == 128
      Goto viperGone_${UNIQ}
    ${EndIf}
    IntOp $R9 $R9 + 1
    ${If} $R9 >= 12
      Goto viperGone_${UNIQ}
    ${EndIf}
    Sleep 500
    Goto viperKill_${UNIQ}
  viperGone_${UNIQ}:
    ; Final settle so Windows/AV fully release file handles before the
    ; old-version uninstaller renames $INSTDIR.
    Sleep 2000
!macroend

; ── App-running check override ───────────────────────────────────────────
;
; Replaces electron-builder's DEFAULT "is the app running?" check. The stock
; check sends a polite WM_CLOSE and, if the process does not exit, pops the
; blocking dialog:
;
;     "V.I.P.E.R. cannot be closed. Please close it manually and click
;      Retry to continue."
;
; That default check runs BEFORE customInit, so the KillViperAndWait force-
; terminate in customInit never got a chance to run — the installer was stuck
; at the Retry dialog first. On most machines the polite close succeeds; but
; Electron spawns several V.I.P.E.R.exe children (GPU / renderer / utility /
; crashpad) and if ANY one is wedged (bad GPU driver, hung renderer) or an
; endpoint-protection engine is still holding a file handle, WM_CLOSE is
; ignored and the user is trapped at the dialog even though no VIPER window
; is visible — exactly the isolated "hidden process blocks the installer"
; report. Force-killing the whole process tree here makes the assisted and
; silent (auto-update) installs proceed reliably.
;
; DATA SAFETY: this only terminates processes. It never touches userdata /
; cases / %APPDATA% — see the policy at the top of this file.
!macro customCheckAppRunning
  !insertmacro KillViperAndWait "checkrun"
!macroend

; ── INSTALL FLOW ─────────────────────────────────────────────────────────

!macro customInit
  ; Terminate any running V.I.P.E.R / Electron processes AND wait until the
  ; OS confirms they are gone, so file locks are released before the
  ; old-version uninstaller's atomic rename runs (see KillViperAndWait).
  !insertmacro KillViperAndWait "init"

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

  ; Kill running instances AND wait until they are confirmed gone, so the
  ; subsequent atomic rename / RMDir of $INSTDIR can't fail on a busy file
  ; (see KillViperAndWait for the full rationale).
  !insertmacro KillViperAndWait "uninit"

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

; ── Resilient file removal override ──────────────────────────────────────
;
; Replaces electron-builder's DEFAULT file-removal path in the uninstall
; section. The stock path, during an update, calls un.atomicRMDir: it RENAMES
; every file in $INSTDIR in one shot and HARD-ABORTS ("Can't rename $INSTDIR")
; if even a SINGLE file is still locked at that instant. The old uninstaller
; then exits with code 2, and the new installer surfaces it as:
;
;     "Failed to uninstall old application files. Please try running the
;      installer again.: 2"
;
; On machines with aggressive endpoint protection, AV can hold a handle on a
; freshly-touched EXE/DLL just long enough to trip that all-or-nothing abort,
; blocking the whole update even though VIPER itself is closed — the isolated
; "hidden process blocks the installer" report.
;
; Instead we force-kill any stragglers, then RMDir /r inside a retry loop.
; RMDir /r SKIPS locked files rather than aborting, and retrying lets a
; transient AV lock clear. If a stray file somehow survives all retries, the
; fresh install simply overwrites it — no hard failure, no error dialog.
;
; DATA SAFETY: customUnInit has ALREADY moved userdata/cases up to
; VIPER-Data-Preserved BEFORE this section runs, and standard-install data
; lives in %APPDATA%\viper-electron (outside $INSTDIR). Nothing here can
; reach user data — see the policy at the top of this file.
!macro customRemoveFiles
  !insertmacro KillViperAndWait "removefiles"

  ; Move out of $INSTDIR so it can be deleted, then delete with retries.
  SetOutPath "$TEMP"

  StrCpy $R4 0
  viperRemove_loop:
    RMDir /r "$INSTDIR"
    ; If nothing remains, we're done.
    IfFileExists "$INSTDIR\*.*" 0 viperRemove_done
    IntOp $R4 $R4 + 1
    ${If} $R4 >= 10
      ; Give up gracefully — do NOT abort. Any stray leftover file is
      ; harmless; the fresh install overwrites it.
      Goto viperRemove_done
    ${EndIf}
    Sleep 1000
    Goto viperRemove_loop
  viperRemove_done:
!macroend
