; Kiopia Desk v4 — personalización del instalador (electron-builder, NSIS asistido).
;
; Instalador:   bienvenida → licencia ("Acepto") → instalación → final con
;               "Abrir Kiopia Desk" y "Crear acceso directo en el escritorio".
; Desinstalador: confirmación (con "Borrar también mi configuración") →
;               desinstalación → "Muchas gracias por usar Kiopia Desk".
; Los backups de los discos externos nunca se tocan.

!include nsDialogs.nsh
!include LogicLib.nsh

; --- Nombre del acceso directo --------------------------------------------------
!ifdef SHORTCUT_NAME
  !define KD_SHORTCUT "${SHORTCUT_NAME}"
!else
  !define KD_SHORTCUT "${PRODUCT_NAME}"
!endif

; --- Siempre "solo para mí": sin la página de a quién instalar ni permisos de
; administrador --------------------------------------------------------------------
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; --- Bienvenida -------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Te damos la bienvenida a ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Kiopia Desk hace copias de seguridad incrementales de tus carpetas en discos externos o USB, verificando cada archivo.$\r$\n$\r$\nEste asistente lo instalará en tu equipo. Pulsa Siguiente para continuar."
  !insertmacro MUI_PAGE_WELCOME

  ; La página de licencia va justo después (la inserta electron-builder): la
  ; licencia se acepta con una casilla, no con un botón que se pulsa sin leer.
  ; (customHeader llega tarde: se inserta después de las páginas.)
  !define MUI_LICENSEPAGE_CHECKBOX
  !define MUI_LICENSEPAGE_CHECKBOX_TEXT "Acepto los términos de la licencia"
  !define MUI_LICENSEPAGE_TEXT_TOP "Lee la licencia de Kiopia Desk. Para instalar, tienes que aceptarla."
!macroend

; --- Carpeta de instalación con el nombre nuevo -------------------------------------
; Al actualizar, electron-builder reutiliza la carpeta de la versión anterior
; (p. ej. «Programs\Kopia Desk v3»). Si es una carpeta de Programs con otro
; nombre, se instala en la de esta versión: el desinstalador viejo vacía la
; anterior. Con /D=<carpeta> se respeta lo que se pida.
!include FileFunc.nsh
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/D=" $R1
  ${If} ${Errors}
    ${GetFileName} "$INSTDIR" $R1
    ${GetParent} "$INSTDIR" $R2
    ${If} $R1 != "${APP_FILENAME}"
    ${AndIf} $R2 == "$LOCALAPPDATA\Programs"
      StrCpy $INSTDIR "$R2\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend

; --- Al actualizar desde la v2 o la v3 (cuando se llamaba Kopia Desk) ----------------
; Su acceso directo del escritorio («Kopia Desk v2» o «Kopia Desk v3») apunta a un
; .exe que ya no existe: se sustituye por el de esta versión. Si ya había uno de
; esta versión, se rehace (por si la carpeta cambió).
!macro customInstall
  ${If} ${FileExists} "$DESKTOP\Kopia Desk v2.lnk"
  ${OrIf} ${FileExists} "$DESKTOP\Kopia Desk v3.lnk"
  ${OrIf} ${FileExists} "$DESKTOP\${KD_SHORTCUT}.lnk"
    Delete "$DESKTOP\Kopia Desk v2.lnk"
    Delete "$DESKTOP\Kopia Desk v3.lnk"
    CreateShortCut "$DESKTOP\${KD_SHORTCUT}.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$DESKTOP\${KD_SHORTCUT}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

; --- Final: abrir la app y acceso directo en el escritorio -----------------------
!macro customFinishPage
  Function kdStartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function kdDesktopShortcut
    CreateShortCut "$DESKTOP\${KD_SHORTCUT}.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$DESKTOP\${KD_SHORTCUT}.lnk" "${APP_ID}"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} está instalado"
  !define MUI_FINISHPAGE_TEXT "La instalación terminó correctamente."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Abrir Kiopia Desk ahora"
  !define MUI_FINISHPAGE_RUN_FUNCTION "kdStartApp"
  ; Marcada por defecto: se crea salvo que se desmarque.
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Crear acceso directo en el escritorio"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "kdDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

; --- Desinstalar: confirmación con "Borrar también mi configuración" -------------
!macro customUnWelcomePage
  Var kdConfirmDialog
  Var kdDeleteConfigBox
  Var /GLOBAL kdDeleteConfig

  UninstPage custom un.kdConfirmShow un.kdConfirmLeave

  Function un.kdConfirmShow
    !insertmacro MUI_HEADER_TEXT "Desinstalar ${PRODUCT_NAME}" "Se quitará Kiopia Desk de este equipo."
    nsDialogs::Create 1018
    Pop $kdConfirmDialog
    ${If} $kdConfirmDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 60u "Vas a desinstalar ${PRODUCT_NAME}.$\r$\n$\r$\nTus backups en los discos externos NO se borran: siguen siendo carpetas normales que puedes abrir desde el Explorador o restaurar reinstalando la app.$\r$\n$\r$\nPulsa Desinstalar para continuar o Cancelar para dejarlo como está."
    Pop $0
    ${NSD_CreateCheckbox} 0 72u 100% 12u "Borrar también mi configuración (carpetas elegidas, disco recordado y ajustes)"
    Pop $kdDeleteConfigBox
    ${NSD_Uncheck} $kdDeleteConfigBox
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Desinstalar"
    nsDialogs::Show
  FunctionEnd

  Function un.kdConfirmLeave
    ${NSD_GetState} $kdDeleteConfigBox $kdDeleteConfig
  FunctionEnd
!macroend

; --- Desinstalar: al final, "Muchas gracias" ---------------------------------------
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "Muchas gracias por usar Kiopia Desk"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} se desinstaló correctamente.$\r$\n$\r$\nTus backups siguen en tus discos externos. Si algún día vuelves a instalar Kiopia Desk, podrás compararlos y restaurarlos desde la app."
!macroend

; --- Desinstalar: acceso directo del escritorio y, si se pidió, configuración -----
!macro customUnInstall
  ; En una actualización (desinstala la versión anterior en silencio) no se
  ; toca ni el acceso directo ni la configuración.
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\${KD_SHORTCUT}.lnk"
    ${If} $kdDeleteConfig == ${BST_CHECKED}
      SetShellVarContext current
      RMDir /r "$APPDATA\kopia-desk"
      !ifdef APP_FILENAME
        RMDir /r "$APPDATA\${APP_FILENAME}"
      !endif
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
      !endif
    ${EndIf}
  ${endIf}
!macroend
