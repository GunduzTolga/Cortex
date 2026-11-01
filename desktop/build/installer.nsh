; Cortex's own steps in the NSIS installer electron-builder makes (package.json, build.nsis.include).

; Uninstalled, Cortex no longer starts with Windows. The "Background" setting writes a Run value under the app's id
; (com.soleluna.cortex, electron/services/tray.ts), and Windows keeps whether it is turned on beside it
; (StartupApproved); neither went with the app, and a broken "Cortex" stayed in the start-up list (desktop-shell-6).
; An update runs the old uninstaller first: then both stay, or every update would turn starting with Windows off.
;
; Uninstalled by the person, they are asked whether everything else Cortex kept goes too (1 November: "silip
; yüklüyorum ama hâlâ bazı şeyleri hatırlıyor"): the settings, chats, keys and Telegram pairing in %APPDATA%\Cortex,
; and in %LOCALAPPDATA%\beyin-v3 every vault's memory index and install record, the voice environment and models
; (a few GB), and the listener's files; the key's Startup, Start-menu and Send To shortcuts too. The vault - the
; person's notes, wherever it is - is never touched. Not asked in an update, nor in a silent uninstall (no).
; The listener (pythonw, beyin_v3_yakala.py) and the voice helper (the venv under beyin-v3) outlive the app and hold
; files there: they are stopped first, this uninstaller's own PowerShell spared from the match on its own command.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.soleluna.cortex"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.soleluna.cortex"
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Cortex'in bu bilgisayarda tuttuğu her şey de silinsin mi?$\r$\n$\r$\nAyarlar, sohbet geçmişi, API anahtarları, Telegram eşleşmesi, ses modelleri ve hafıza dizinleri silinir; Cortex bir sonraki kurulumda ilk kez kurulmuş gibi açılır.$\r$\n$\r$\nNotların (kasa klasörün) silinmez." /SD IDNO IDYES`
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$PID -and ($$_.CommandLine -like '*beyin_v3_yakala*' -or $$_.CommandLine -like '*beyin-v3*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $0
      Sleep 1000
      Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Pyn Yakala.lnk"
      Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Beyne At.lnk"
      Delete "$APPDATA\Microsoft\Windows\SendTo\Beyne At.lnk"
      RMDir /r "$APPDATA\Cortex"
      RMDir /r "$LOCALAPPDATA\beyin-v3"
    ${EndIf}
  ${endIf}
!macroend
