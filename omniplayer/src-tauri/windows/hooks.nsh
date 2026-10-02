; NSIS hooks for the Tauri per-user installer.
; Included from Tauri's generated script (MUI + StrFunc are already loaded).
; Do not delete %USERPROFILE%\OmniTrace\OmniDatabase.

!include "LogicLib.nsh"
${StrRep}

!macro NSIS_HOOK_PREINSTALL
  ; Tauri's default folder is %LOCALAPPDATA%\${PRODUCTNAME} (留痕).
  ; Stable installs stay in %LOCALAPPDATA%\OmniTrace. Only the untouched
  ; default is redirected; a restored install path or a chosen folder stays.
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\OmniTrace"
    SetOutPath "$INSTDIR"
  ${EndIf}

  ; A running recorder locks omnitrace_input.exe. Rename it aside so the
  ; new file can be written. Do not taskkill: the live process keeps the
  ; renamed image, and the next start uses the new exe. Desired-on flag
  ; in OmniDatabase is not touched.
  ${If} ${FileExists} "$INSTDIR\omnitrace_input.exe"
    Delete "$INSTDIR\omnitrace_input.exe.old"
    ClearErrors
    Rename "$INSTDIR\omnitrace_input.exe" "$INSTDIR\omnitrace_input.exe.old"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Default data pointer. Never overwrite one the user already changed.
  ; Creating the folder does not modify an existing library.
  ${IfNot} ${FileExists} "$INSTDIR\data_root.json"
    CreateDirectory "$PROFILE\OmniTrace\OmniDatabase"
    StrCpy $R8 "$PROFILE\OmniTrace\OmniDatabase"
    ${StrRep} $R8 $R8 "\" "\\"
    FileOpen $R9 "$INSTDIR\data_root.json" w
    FileWrite $R9 '{"path":"'
    FileWrite $R9 $R8
    FileWrite $R9 '"}'
    FileClose $R9
  ${EndIf}

  ; Retire the pre-updater uninstall key so Add/Remove shows one 留痕 entry.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$INSTDIR\data_root.json"
    Delete "$INSTDIR\omnitrace_input.exe"
    Delete "$INSTDIR\omnitrace_input.exe.old"
    Delete "$INSTDIR\OmniTrace.ico"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; OmniDatabase under %USERPROFILE%\OmniTrace must survive uninstall.
!macroend
