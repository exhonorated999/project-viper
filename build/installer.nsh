; Custom NSIS script for V.I.P.E.R.
; Preserves portable user data (userdata/, cases/) during updates.
; Uses CopyFiles instead of Rename to support cross-drive (USB → C:\Temp).

!macro customInit
  ; Kill any running V.I.P.E.R / Electron processes to release file locks
  nsExec::ExecToLog 'taskkill /F /IM "V.I.P.E.R.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "electron.exe" /T'
  ; Brief pause to let OS release handles
  Sleep 1000

  ; Back up portable data before the old version is removed
  IfFileExists "$INSTDIR\userdata\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\userdata" "$TEMP\VIPER_backup"

  IfFileExists "$INSTDIR\cases\*.*" 0 +3
    CreateDirectory "$TEMP\VIPER_backup"
    CopyFiles /SILENT "$INSTDIR\cases" "$TEMP\VIPER_backup"
!macroend

!macro customInstall
  ; Restore portable data after new files are installed
  IfFileExists "$TEMP\VIPER_backup\userdata\*.*" 0 +2
    CopyFiles /SILENT "$TEMP\VIPER_backup\userdata" "$INSTDIR"

  IfFileExists "$TEMP\VIPER_backup\cases\*.*" 0 +2
    CopyFiles /SILENT "$TEMP\VIPER_backup\cases" "$INSTDIR"

  ; Clean up temp backup
  RMDir /r "$TEMP\VIPER_backup"
!macroend

!macro customUnInstall
  ; On uninstall, leave portable data alone
!macroend
