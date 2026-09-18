; NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; Registers the "Open with OMP Desktop" verb on directories, which is how
; Windows exposes an app for a folder — `Directory\shell\<verb>`, not the
; extension-keyed association that `bundle.fileAssociations` writes (a folder
; has no extension). The folder arrives as argv; see
; src-tauri/src/external_open.rs.
;
; Two keys, because Explorer treats them as different surfaces:
;   Directory\shell             — right-click *on* a folder
;   Directory\Background\shell  — right-click *inside* an open folder
; `%V` is the folder in both cases (`%1` is empty for the background verb).
;
; SHCTX follows the installer's per-user/per-machine mode, so a current-user
; install writes to HKCU and never needs elevation.

!define OMP_FOLDER_VERB "Software\Classes\Directory\shell\OpenWithOmpDesktop"
!define OMP_FOLDER_BG_VERB "Software\Classes\Directory\Background\shell\OpenWithOmpDesktop"

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${OMP_FOLDER_VERB}" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "${OMP_FOLDER_VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "${OMP_FOLDER_VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""

  WriteRegStr SHCTX "${OMP_FOLDER_BG_VERB}" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "${OMP_FOLDER_BG_VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "${OMP_FOLDER_BG_VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""

  ; Tell the shell the association table changed, so the entry appears
  ; without a restart of Explorer (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "${OMP_FOLDER_VERB}"
  DeleteRegKey SHCTX "${OMP_FOLDER_BG_VERB}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
