; Cortex's own steps in the NSIS installer electron-builder makes (package.json, build.nsis.include).

; Uninstalled, Cortex no longer starts with Windows. The "Background" setting writes a Run value under the app's id
; (com.soleluna.cortex, electron/services/tray.ts), and Windows keeps whether it is turned on beside it
; (StartupApproved); neither went with the app, and a broken "Cortex" stayed in the start-up list (desktop-shell-6).
; An update runs the old uninstaller first: then both stay, or every update would turn starting with Windows off.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.soleluna.cortex"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.soleluna.cortex"
  ${endIf}
!macroend
