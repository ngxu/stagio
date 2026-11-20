; Stagio installer for Windows: per-user, no administrator rights. One script for the three
; editions (Lite, Standard, Extra); each gets its own folder, shortcuts and "Apps" entry, so they
; can be installed side by side. They share one data folder (%APPDATA%\OneDesk: Stagio was
; called OneDesk until 2026-11, and the folder keeps that name so nothing is lost).
; Build it with `npm run dist:win` (build/make-installer.js passes the /D values below).
;
; Why not electron-builder's own NSIS target: it makes the uninstaller at build time by
; running a freshly compiled, unsigned program. Some antivirus software removes that program's output,
; so the build fails. Here makensis only compiles; the uninstaller is written on the
; user's PC when Stagio is installed.
;
; Each edition keeps the "Apps" entry (GUID) and taskbar ID it had as OneDesk, so Stagio installs
; over OneDesk as an ordinary update (into the same folder), removes OneDesk.exe and renames the
; shortcuts. Standard also takes over OneDesk 0.x the same way.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID /FINAL lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!macro Need NAME
  !ifndef ${NAME}
    !error "Missing /D${NAME}. Build with: npm run dist:win"
  !endif
!macroend
!insertmacro Need VERSION   ; 1.0.0-beta
!insertmacro Need NUMVER    ; 1.0.0.0
!insertmacro Need VLABEL    ; Beta 1.0
!insertmacro Need EDITION   ; lite | standard | extra
!insertmacro Need EDNAME    ; Stagio Lite
!insertmacro Need OLDNAME   ; OneDesk Lite (the shortcut name before the rename)
!insertmacro Need GUID      ; the edition's "Apps" entry
!insertmacro Need APPID     ; the edition's taskbar ID
!insertmacro Need SRC       ; dist\win-unpacked
!insertmacro Need OUTFILE   ; dist\Stagio-Lite-Setup-1.0.0-beta.exe
!insertmacro Need FILELIST  ; generated list of what the uninstaller removes
!insertmacro Need ICON      ; build\icon.ico

!define APP_NAME   "${EDNAME}"
!define APP_EXE    "Stagio.exe"
!define APP_ID     "${APPID}"
!define UNINST_EXE "Uninstall Stagio.exe"
!define OLD_EXE    "OneDesk.exe"            ; before the rename
!define OLD_UNINST "Uninstall OneDesk.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${GUID}"
!define APP_KEY    "Software\${GUID}"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${APP_KEY}" "InstallLocation"
BrandingText "${APP_NAME} ${VLABEL}"
ShowInstDetails hide
ShowUninstDetails hide

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifdef PLUGINDIR
  !addplugindir /x86-unicode "${PLUGINDIR}"
  ; Start menu / desktop shortcuts carry the app's ID, so Windows groups the
  ; running window with a pinned shortcut.
  !define HAVE_WINSHELL
!endif

Var Upgrade   ; previous version, "" on a new install

; ---- pages -------------------------------------------------------------------

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!ifdef SIDEBMP
  ; Stagio's own picture on the last page instead of NSIS's stock one (build/make-installer-art.ps1)
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBMP}"
!endif

!define MUI_DIRECTORYPAGE_TEXT_TOP "${APP_NAME} is installed for your Windows account only, so no administrator rights are needed. If it is already installed, this updates it. Settings, cues and backups are kept (also those from OneDesk, Stagio's earlier name), and shared with the other Stagio editions on this PC."
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP_NAME} now"
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "${APP_NAME} will be removed from the folder below. Your presentations are not touched, and Stagio's settings and backup copies are kept (the other editions use them too)."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${NUMVER}"
VIFileVersion "${NUMVER}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "Stagio"  ; the project name (code signing rules)
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "Stagio"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "${APP_NAME}"

; ---- helpers -----------------------------------------------------------------

; Files of a running Stagio cannot be replaced. A running exe cannot be opened for writing,
; which is how this tells. Both names: an update may find OneDesk.exe still open.
!macro TRY_OPEN EXE
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    FileOpen $R0 "$INSTDIR\${EXE}" a
    ${IfNot} ${Errors}
      FileClose $R0
    ${EndIf}
  ${EndIf}
!macroend
!macro DEFINE_WAIT_FOR_APP UN
Function ${UN}WaitForAppClosed
  StrCpy $R1 0
  retry:
    ClearErrors
    !insertmacro TRY_OPEN "${APP_EXE}"
    !insertmacro TRY_OPEN "${OLD_EXE}"
    ${IfNot} ${Errors}
      Return
    ${EndIf}
    ${If} ${Silent}
      IntOp $R1 $R1 + 1
      ${If} $R1 < 20
        Sleep 1000
        Goto retry
      ${EndIf}
      SetErrorLevel 2
      Abort "${APP_NAME} is still open. Nothing was changed."
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP_NAME} is still open.$\r$\n$\r$\nClose the ${APP_NAME} window, then click Retry. A running slide show is not affected." IDRETRY retry
    Abort "${APP_NAME} is still open. Nothing was changed."
FunctionEnd
!macroend
!insertmacro DEFINE_WAIT_FOR_APP ""
!insertmacro DEFINE_WAIT_FOR_APP "un."

!macro Shortcut LNK
  CreateShortCut "${LNK}" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL "" "${APP_NAME}"
  !ifdef HAVE_WINSHELL
    WinShell::SetLnkAUMI "${LNK}" "${APP_ID}"
  !endif
!macroend

; Shortcuts named OLD become this edition's: a desktop one only if the user had it. A taskbar pin
; keeps its file (Windows knows the pin by it) and now opens Stagio.exe.
!define PINNED "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
!macro RenameShortcuts OLD
  ${If} ${FileExists} "$DESKTOP\${OLD}.lnk"
    !insertmacro Shortcut "$DESKTOP\${APP_NAME}.lnk"
  ${EndIf}
  !ifdef HAVE_WINSHELL
    WinShell::UninstShortcut "$SMPROGRAMS\${OLD}.lnk"
    WinShell::UninstShortcut "$DESKTOP\${OLD}.lnk"
  !endif
  Delete "$SMPROGRAMS\${OLD}.lnk"
  Delete "$DESKTOP\${OLD}.lnk"
  ${If} ${FileExists} "${PINNED}\${OLD}.lnk"
    !insertmacro Shortcut "${PINNED}\${OLD}.lnk"
  ${EndIf}
!macroend

Function .onInit
  ; one Setup at a time
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "StagioSetup") p .r0 ?e'
  Pop $1
  ${If} $1 == 183
    MessageBox MB_OK|MB_ICONINFORMATION "Stagio Setup is already open." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext current
  ReadRegStr $Upgrade HKCU "${UNINST_KEY}" "DisplayVersion"
FunctionEnd

; ---- install -----------------------------------------------------------------

Section "${APP_NAME}" SecMain
  SectionIn RO
  SetShellVarContext current
  Call WaitForAppClosed

  SetOutPath "$INSTDIR"
  ; the previous version's app files go first, so nothing stale is left behind
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*"
  ; which edition this is (read by lib/edition.js)
  FileOpen $0 "$INSTDIR\resources\edition.json" w
  FileWrite $0 '{"edition":"${EDITION}","version":"${VERSION}"}'
  FileClose $0
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"

  ; Stagio was called OneDesk: the old program file goes, and its shortcuts become Stagio ones
  Delete "$INSTDIR\${OLD_EXE}"
  Delete "$INSTDIR\${OLD_UNINST}"
  !insertmacro RenameShortcuts "${OLDNAME}"
  !if "${EDITION}" == "standard"
    !insertmacro RenameShortcuts "OneDesk"  ; 0.x
  !endif

  ; Start menu always; desktop on a new install, or on an update when the user kept it
  !insertmacro Shortcut "$SMPROGRAMS\${APP_NAME}.lnk"
  ${If} $Upgrade == ""
  ${OrIf} ${FileExists} "$DESKTOP\${APP_NAME}.lnk"
    !insertmacro Shortcut "$DESKTOP\${APP_NAME}.lnk"
  ${EndIf}

  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "ShortcutName" "${APP_NAME}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME} ${VLABEL}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Stagio"
  WriteRegStr HKCU "${UNINST_KEY}" "Comments" "One-person control desk for PowerPoint, Spotify and audio/projector output"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

; ---- uninstall ---------------------------------------------------------------

Section "Uninstall"
  SetShellVarContext current
  Call un.WaitForAppClosed

  !ifdef HAVE_WINSHELL
    WinShell::UninstShortcut "$SMPROGRAMS\${APP_NAME}.lnk"
    WinShell::UninstShortcut "$DESKTOP\${APP_NAME}.lnk"
    WinShell::UninstAppUserModelId "${APP_ID}"
  !endif
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  ; only what Setup put there; the folder goes when it ends up empty
  !include "${FILELIST}"
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
