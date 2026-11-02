; Rook's additions to electron-builder's NSIS scripts (included from buildResources by default).

; The installer copies itself to %LOCALAPPDATA%\<updater cache>\installer.exe for differential
; updates, and the updater downloads there too. A full uninstall removes that folder; an upgrade
; (which runs the old uninstaller with --updated) keeps it.
!ifdef APP_INSTALLER_STORE_FILE
  !searchreplace ROOK_UPDATER_DIR "${APP_INSTALLER_STORE_FILE}" "\installer.exe" ""
  !if "${ROOK_UPDATER_DIR}" != ""
    !macro customUnInstall
      ${ifNot} ${isUpdated}
        RMDir /r "$LOCALAPPDATA\${ROOK_UPDATER_DIR}"
      ${endIf}
    !macroend
  !endif
!endif
