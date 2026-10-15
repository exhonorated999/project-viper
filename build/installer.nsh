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

; ── DRIVE COPIES (5.4.3) ─────────────────────────────────────────────────
;
; WHY THIS EXISTS: officers run VIPER from a folder on an external drive
; (e.g. F:\VIPER\V.I.P.E.R with userdata\ and cases\ beside the exe). Up to
; 5.4.1 the in-app updater ran this Setup.exe, which installs to C: — the
; drive copy was never updated. 5.4.2+ update drive copies themselves, but
; older drive copies still launch this installer. So this installer finds an
; outdated drive copy and hands it to the program it carries:
;
;   1. started by the in-app update of an old drive copy (--updated, parent
;      process = that copy's V.I.P.E.R.exe): update that copy, no questions;
;   2. run by hand from the website: look for drive copies one and two
;      folders deep on every drive except the Windows drive, and ASK.
;
; The update itself is NOT done here: the app is unpacked to
; %TEMP%\viper-drive-setup\app and started with --viper-drive-setup
; (modules/_shared/drive-setup.js), which copies it to <drive copy>\
; .viper-update\incoming, verifies it, and swaps it in with the same
; rename-only, roll-back-able swap the in-app drive updater uses.
;
; DESKTOP INSTALLS ARE NOT AFFECTED: a folder is only a drive copy when it
; holds the exe, resources\app.asar AND userdata\, cases\ or .portable; is
; not the folder the per-user install registers; and, on the Windows drive,
; has .portable. In-app updates of desktop copies (parent is a desktop exe)
; and silent installs (/S, IT deployments) never look for drives. Answering
; "No" continues with the normal install, unchanged.
;
; DATA SAFETY: nothing here writes to a drive copy except a probe file that is
; deleted at once; userdata\ and cases\ are never touched (policy above).
!ifndef BUILD_UNINSTALLER
!ifdef APP_64

!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"

; This file is included BEFORE electron-builder's common.nsh, so its
; APP_EXECUTABLE_FILENAME does not exist yet when these Functions are parsed
; (makensis -WX then fails the build). Same value, own name.
!define VD_EXE "${PRODUCT_FILENAME}.exe"

; The Vars and Functions below live in customHeader, NOT at file level:
; electron-builder registers its plugin folders (StdUtils for ${isUpdated},
; Nsis7z, Banner) AFTER this file is included, so a Function parsed here
; fails with "Plugin not found". installer.nsi inserts customHeader after
; the whole generated header, where every plugin is known.
!macro customHeader
Var vdTarget     ; the outdated drive copy to update ("" = none)
Var vdTargetVer  ; its version, for the question
Var vdCurrent    ; an up-to-date drive copy that was seen ("" = none)
Var vdWaitPid    ; pid of the drive copy that started us (0 = none)
Var vdParentExe  ; full path of our parent process ("" = unknown)
Var vdRegLoc     ; HKCU InstallLocation of the per-user install
Var vdSysDrv     ; the Windows drive, e.g. "C:"
Var vdUpdated    ; 1 when started by an in-app update (--updated)

; In:  $0 = folder, no trailing backslash.
; Out: $1 = "old" | "current" | "" (not a drive copy); $2 = its version.
; Clobbers $3, $4.
Function vdCheck
  StrCpy $1 ""
  StrCpy $2 ""
  StrLen $3 $0
  IntCmp $3 3 vdc_done vdc_done 0          ; a drive root is never a copy
  StrCpy $3 $0 1 1
  StrCmp $3 ":" 0 vdc_done                 ; drive-letter paths only
  StrCpy $3 $0 "" -1
  StrCmp $3 "\" vdc_done
  IfFileExists "$0\${VD_EXE}" 0 vdc_done
  IfFileExists "$0\resources\app.asar" 0 vdc_done
  StrCpy $3 ""
  StrCpy $4 ""
  IfFileExists "$0\userdata\*.*" 0 +2
    StrCpy $3 "data"
  IfFileExists "$0\cases\*.*" 0 +2
    StrCpy $3 "data"
  IfFileExists "$0\.portable" 0 +3
    StrCpy $3 "data"
    StrCpy $4 "portable"
  StrCmp $3 "" vdc_done
  StrCpy $3 $0 2
  StrCmp $3 $vdSysDrv 0 +2                 ; on the Windows drive only with .portable
    StrCmp $4 "portable" 0 vdc_done
  StrCmp $0 $vdRegLoc vdc_done             ; the per-user install's own folder
  StrCmp $0 "$LOCALAPPDATA\Programs\${APP_FILENAME}" vdc_done
  ClearErrors
  ${GetFileVersion} "$0\${VD_EXE}" $2
  IfErrors vdc_none
  StrCmp $2 "" vdc_none
  ${VersionCompare} $2 "${VERSION}" $3
  StrCpy $4 $2 "" -2                       ; "5.3.6.0" -> "5.3.6" for display
  StrCmp $4 ".0" 0 +2
    StrCpy $2 $2 -2
  StrCpy $1 "current"
  StrCmp $3 2 0 vdc_done
  StrCpy $1 "old"
  Goto vdc_done
  vdc_none:
  StrCpy $2 ""
  vdc_done:
FunctionEnd

; In: $0 = folder. Records it in $vdTarget / $vdCurrent.
Function vdConsider
  Call vdCheck
  StrCmp $1 "old" 0 +4
    StrCpy $vdTarget $0
    StrCpy $vdTargetVer $2
    Return
  StrCmp $1 "current" 0 +3
    StrCmp $vdCurrent "" 0 +2
      StrCpy $vdCurrent $0
FunctionEnd

; Out: $vdParentExe (full path or ""), $vdWaitPid (its pid or 0).
; Clobbers $0-$9.
Function vdFindParent
  StrCpy $vdParentExe ""
  StrCpy $vdWaitPid 0
  StrCpy $5 0
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) i .r1'
  IntCmp $1 -1 vdp_done
  IntCmp $1 0 vdp_done
  System::Alloc 556                        ; PROCESSENTRY32W (32-bit)
  Pop $2
  IntCmp $2 0 vdp_close
  System::Call '*$2(i 556)'
  System::Call 'kernel32::Process32FirstW(i r1, i r2) i .r3'
  vdp_loop:
    IntCmp $3 0 vdp_free
    System::Call '*$2(i, i, i .r4, i, i, i, i .r6)'
    IntCmp $4 $0 vdp_found
    System::Call 'kernel32::Process32NextW(i r1, i r2) i .r3'
    Goto vdp_loop
  vdp_found:
    StrCpy $5 $6
  vdp_free:
  System::Free $2
  vdp_close:
  System::Call 'kernel32::CloseHandle(i r1)'
  IntCmp $5 0 vdp_done
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r5) i .r7'
  IntCmp $7 0 vdp_done
  StrCpy $8 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(i r7, i 0, w .r9, *i r8 r8) i .r3'
  System::Call 'kernel32::CloseHandle(i r7)'
  IntCmp $3 0 vdp_done
  StrCpy $vdParentExe $9
  StrCpy $vdWaitPid $5
  vdp_done:
FunctionEnd

; Look one and two folders deep on every local and removable drive except
; the Windows drive; stop at the first outdated copy. Clobbers $0-$7, $R0-$R8.
Function vdScan
  System::Call 'kernel32::SetErrorMode(i 1) i .r7'   ; no "insert a disk" popups
  System::Call 'kernel32::GetLogicalDrives() i .R4'
  StrCpy $R0 "CDEFGHIJKLMNOPQRSTUVWXYZ"
  StrCpy $R1 0
  vds_drive:
    StrCmp $vdTarget "" 0 vds_end
    IntCmp $R1 24 vds_end 0 vds_end
    StrCpy $R2 $R0 1 $R1
    IntOp $R3 $R1 + 2
    IntOp $R1 $R1 + 1
    IntOp $R3 $R4 >> $R3
    IntOp $R3 $R3 & 1
    IntCmp $R3 0 vds_drive
    StrCmp "$R2:" $vdSysDrv vds_drive
    System::Call 'kernel32::GetDriveTypeW(w "$R2:\") i .R3'
    StrCmp $R3 2 +2                        ; removable
    StrCmp $R3 3 0 vds_drive               ; fixed
    StrCpy $5 0
    ClearErrors
    FindFirst $R5 $R6 "$R2:\*"
    vds_d1:
      StrCmp $R6 "" vds_d1end
      StrCmp $vdTarget "" 0 vds_d1end
      IntCmp $5 2000 vds_d1end 0 vds_d1end
      IntOp $5 $5 + 1
      StrCmp $R6 "." vds_d1next
      StrCmp $R6 ".." vds_d1next
      StrCmp $R6 "$$RECYCLE.BIN" vds_d1next
      StrCmp $R6 "System Volume Information" vds_d1next
      IfFileExists "$R2:\$R6\*.*" 0 vds_d1next
      StrCpy $0 "$R2:\$R6"
      Call vdConsider
      ClearErrors
      FindFirst $R7 $R8 "$R2:\$R6\*"
      vds_d2:
        StrCmp $R8 "" vds_d2end
        StrCmp $vdTarget "" 0 vds_d2end
        IntCmp $5 2000 vds_d2end 0 vds_d2end
        IntOp $5 $5 + 1
        StrCmp $R8 "." vds_d2next
        StrCmp $R8 ".." vds_d2next
        StrCmp $R8 ".viper-update" vds_d2next
        IfFileExists "$R2:\$R6\$R8\*.*" 0 vds_d2next
        StrCpy $0 "$R2:\$R6\$R8"
        Call vdConsider
        vds_d2next:
        FindNext $R7 $R8
        Goto vds_d2
      vds_d2end:
      FindClose $R7
      vds_d1next:
      FindNext $R5 $R6
      Goto vds_d1
    vds_d1end:
    FindClose $R5
    Goto vds_drive
  vds_end:
  System::Call 'kernel32::SetErrorMode(i r7)'
FunctionEnd

Function vdPreInit
  StrCpy $vdTarget ""
  StrCpy $vdTargetVer ""
  StrCpy $vdCurrent ""
  StrCpy $vdWaitPid 0
  StrCpy $vdParentExe ""
  StrCpy $vdSysDrv $WINDIR 2
  StrCpy $vdUpdated 0
  ${If} ${isUpdated}
    StrCpy $vdUpdated 1
  ${EndIf}
  ; A silent manual install (IT deployment) behaves exactly as before.
  ${If} $vdUpdated == 0
  ${AndIf} ${Silent}
    Return
  ${EndIf}

  ReadRegStr $vdRegLoc HKCU "Software\${APP_GUID}" InstallLocation
  StrCpy $0 $vdRegLoc "" -1
  StrCmp $0 "\" 0 +2
    StrCpy $vdRegLoc $vdRegLoc -1

  ${If} $vdUpdated == 1
    ; Who started us? Only an old DRIVE copy gets the drive update; any other
    ; in-app update (every desktop copy) continues with the normal install.
    Call vdFindParent
    ${If} $vdParentExe != ""
      ${GetFileName} $vdParentExe $0
      StrCmp $0 "${VD_EXE}" 0 vdpi_normal
      ${GetParent} $vdParentExe $0
      Call vdCheck
      StrCmp $1 "old" 0 vdpi_normal
      StrCpy $vdTarget $0
      StrCpy $vdTargetVer $2
      Goto vdpi_go
    ${EndIf}
    ; The parent already exited: fall through and ask, exactly like a run
    ; from the website.
    StrCpy $vdWaitPid 0
  ${EndIf}

  Call vdScan
  ${If} $vdTarget == ""
    ${If} $vdCurrent != ""
      MessageBox MB_YESNO|MB_ICONQUESTION "The copy of V.I.P.E.R. on your drive is already up to date:$\n$\n    $vdCurrent$\n$\nDo you want to install V.I.P.E.R. on this computer as well?" IDYES vdpi_normal
      Quit
    ${EndIf}
    Goto vdpi_normal
  ${EndIf}
  MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "V.I.P.E.R. $vdTargetVer was found on your drive:$\n$\n    $vdTarget$\n$\nUpdate that copy to ${VERSION}? Your cases and settings on the drive are kept.$\n$\nYes  -  update V.I.P.E.R. on the drive$\nNo  -  install V.I.P.E.R. on this computer instead$\nCancel  -  do nothing" IDYES vdpi_yes IDNO vdpi_normal
  Quit

  vdpi_yes:
  ; The drive must be writable without admin rights.
  ClearErrors
  FileOpen $0 "$vdTarget\viper-write-probe.tmp" w
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "V.I.P.E.R. on the drive cannot be updated because the drive cannot be written to (it may be write-protected or full):$\n$\n    $vdTarget$\n$\nNothing was changed."
    Quit
  ${EndIf}
  FileClose $0
  Delete "$vdTarget\viper-write-probe.tmp"
  ; VIPER must be closed on the drive.
  ClearErrors
  FileOpen $0 "$vdTarget\${VD_EXE}" a
  ${If} ${Errors}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "V.I.P.E.R. is open. Save your work and close it.$\n$\nClick OK to close V.I.P.E.R. and continue, or Cancel to stop." IDOK +2
    Quit
    !insertmacro KillViperAndWait "drive"
  ${Else}
    FileClose $0
  ${EndIf}

  vdpi_go:
  ; Free space: the drive gets a full second copy for a moment; %TEMP% holds
  ; the packed and the unpacked program.
  IntOp $R1 ${APP_64_UNPACKED_SIZE} / 1024
  IntOp $R2 $R1 + 300
  StrCpy $0 $vdTarget 3
  ClearErrors
  ${DriveSpace} $0 "/D=F /S=M" $R3
  ${IfNot} ${Errors}
  ${AndIf} $R3 < $R2
    MessageBox MB_OK|MB_ICONEXCLAMATION "There is not enough free space on the drive to update V.I.P.E.R. (about $R2 MB is needed on $0).$\n$\nNothing was changed."
    Quit
  ${EndIf}
  IntOp $R2 $R1 * 2
  IntOp $R2 $R2 + 100
  StrCpy $0 $TEMP 3
  ClearErrors
  ${DriveSpace} $0 "/D=F /S=M" $R3
  ${IfNot} ${Errors}
  ${AndIf} $R3 < $R2
    MessageBox MB_OK|MB_ICONEXCLAMATION "There is not enough free space on this computer to prepare the V.I.P.E.R. update (about $R2 MB is needed on $0).$\n$\nNothing was changed."
    Quit
  ${EndIf}

  ; One drive update at a time; clear a finished or abandoned one.
  IfFileExists "$TEMP\viper-drive-setup\*.*" 0 vdpi_fresh
  IfFileExists "$TEMP\viper-drive-setup\app\${VD_EXE}" 0 vdpi_clear
  ClearErrors
  FileOpen $0 "$TEMP\viper-drive-setup\app\${VD_EXE}" a
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONINFORMATION "A V.I.P.E.R. drive update is already running. Please wait for it to finish."
    Quit
  ${EndIf}
  FileClose $0
  vdpi_clear:
  RMDir /r "$TEMP\viper-drive-setup"
  vdpi_fresh:

  CreateDirectory "$TEMP\viper-drive-setup\app"
  ClearErrors
  FileOpen $0 "$TEMP\viper-drive-setup\viper-setup.json" w
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "The V.I.P.E.R. update could not be prepared (the temporary folder cannot be written).$\n$\nNothing on the drive was changed."
    Quit
  ${EndIf}
  FileWrite $0 '{"kind":"viper-drive-setup","version":"${VERSION}"}'
  FileClose $0

  Banner::show "Preparing the V.I.P.E.R. update for your drive..."
  InitPluginsDir
  !ifdef COMPRESS
    SetCompress off
  !endif
  File /oname=$PLUGINSDIR\vd-app.7z "${APP_64}"
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  SetOutPath "$TEMP\viper-drive-setup\app"
  Nsis7z::Extract "$PLUGINSDIR\vd-app.7z"
  Delete "$PLUGINSDIR\vd-app.7z"
  SetOutPath "$TEMP"
  Banner::destroy

  IfFileExists "$TEMP\viper-drive-setup\app\${VD_EXE}" 0 vdpi_broken
  IfFileExists "$TEMP\viper-drive-setup\app\resources\app.asar" 0 vdpi_broken
  Exec '"$TEMP\viper-drive-setup\app\${VD_EXE}" --viper-drive-setup "--target=$vdTarget" --wait-pid=$vdWaitPid'
  Quit

  vdpi_broken:
  RMDir /r "$TEMP\viper-drive-setup"
  MessageBox MB_OK|MB_ICONEXCLAMATION "The V.I.P.E.R. update could not be unpacked on this computer.$\n$\nNothing on the drive was changed. Please contact Intellect LE support."
  Quit

  vdpi_normal:
FunctionEnd
!macroend ; customHeader

; Inserted by electron-builder at the top of .onInit — before the "close
; VIPER" kill and before any install work.
!macro preInit
  ${IfNot} ${UAC_IsInnerInstance}
  ${AndIf} ${RunningX64}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    Call vdPreInit
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!endif ; APP_64
!endif ; BUILD_UNINSTALLER

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
