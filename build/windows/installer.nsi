; Clustrail installer (NSIS). Built by .github/workflows/release.yml:
;   makensis -DVERSION=1.2.3 -DEXE=..\..\bin\clustrail.exe -DOUT=..\..\dist\Clustrail-1.2.3-windows-amd64-setup.exe installer.nsi
; Clustrail needs the Microsoft Edge WebView2 runtime, which Windows 10 (21H2+) and 11 ship with.

Unicode true
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!include "MUI2.nsh"

Name "Clustrail"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\Clustrail"
InstallDirRegKey HKLM "Software\Clustrail" "InstallDir"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Clustrail"
VIAddVersionKey "FileDescription" "Clustrail installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Apache License 2.0"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\clustrail.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=clustrail.exe" "${EXE}"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Clustrail"
  CreateShortCut "$SMPROGRAMS\Clustrail\Clustrail.lnk" "$INSTDIR\clustrail.exe" "" "$INSTDIR\icon.ico"
  WriteRegStr HKLM "Software\Clustrail" "InstallDir" "$INSTDIR"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clustrail"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "Clustrail"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Clustrail contributors"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\clustrail.exe"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Clustrail\Clustrail.lnk"
  RMDir "$SMPROGRAMS\Clustrail"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Clustrail"
  DeleteRegKey HKLM "Software\Clustrail"
SectionEnd
