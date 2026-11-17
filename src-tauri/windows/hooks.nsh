; Explorer context menu "Open with Cirth" (classic menu; Windows 11 shows it under "Show more options").
; Per-user (installMode currentUser): everything lives under HKCU\Software\Classes, no admin needed.
; Hook macros are inserted by the Tauri NSIS template (installer.nsi) when defined.

!macro SE_WRITE_VERB KEY ARG
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Cirth" "" "Open with Cirth"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Cirth" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Cirth\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"${ARG}$\""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SE_WRITE_VERB "*" "%1"
  !insertmacro SE_WRITE_VERB "Directory" "%1"
  !insertmacro SE_WRITE_VERB "Directory\Background" "%V."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\Cirth"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Cirth"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Cirth"
!macroend
