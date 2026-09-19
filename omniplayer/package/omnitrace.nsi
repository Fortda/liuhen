; OmniTrace per-user installer.
; Compiles against a staged Dist folder (ASCII path). Do not pack OmniDatabase.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.3"
!endif
!ifndef OUTFILE
  !error "Pass /DOUTFILE=...setup.exe"
!endif
!ifndef LICENSE_FILE
  !error "Pass /DLICENSE_FILE=...LICENSE"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "OmniTrace.ico"
!endif

!define PRODUCT_NAME "OmniTrace"
!define PRODUCT_PUBLISHER "Fortda"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniTrace"
!define APP_KEY "Software\OmniTrace"

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\OmniTrace"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION}"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\OmniPlayer.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch OmniTrace"

!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "OmniTrace setup (player + recorder)"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT (c) 2026 Fortda"
VIAddVersionKey /LANG=1033 "CompanyName" "${PRODUCT_PUBLISHER}"

Function .onInit
  SetShellVarContext current
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"

  File "OmniPlayer.exe"
  File "omnitrace_input.exe"
  File /nonfatal "OmniTrace.ico"
  File /nonfatal "Readme.txt"
  File /nonfatal "VERSION.txt"
  File "write-data-root.ps1"

  CreateDirectory "$INSTDIR\incoming"
  CreateDirectory "$PROFILE\OmniTrace\OmniDatabase"

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\write-data-root.ps1" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Could not write data_root.json (exit $0). The app will still install; data defaults to your user folder."
  ${EndIf}
  Delete "$INSTDIR\write-data-root.ps1"

  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\OmniTrace"
  CreateShortCut "$SMPROGRAMS\OmniTrace\OmniTrace.lnk" "$INSTDIR\OmniPlayer.exe" "" "$INSTDIR\OmniTrace.ico" 0
  CreateShortCut "$DESKTOP\OmniTrace.lnk" "$INSTDIR\OmniPlayer.exe" "" "$INSTDIR\OmniTrace.ico" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\OmniPlayer.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/Fortda/omnitrace"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  ; Never delete %USERPROFILE%\OmniTrace\OmniDatabase (or any user library).
  Delete "$DESKTOP\OmniTrace.lnk"
  RMDir /r "$SMPROGRAMS\OmniTrace"

  Delete "$INSTDIR\OmniPlayer.exe"
  Delete "$INSTDIR\omnitrace_input.exe"
  Delete "$INSTDIR\OmniTrace.ico"
  Delete "$INSTDIR\Readme.txt"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\VERSION.txt"
  Delete "$INSTDIR\data_root.json"
  Delete "$INSTDIR\write-data-root.ps1"
  Delete "$INSTDIR\启动 OmniPlayer.bat"
  Delete "$INSTDIR\安装到本机.bat"
  Delete "$INSTDIR\install-user.ps1"
  Delete "$INSTDIR\uninstall.ps1"
  RMDir /r "$INSTDIR\incoming"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
SectionEnd
