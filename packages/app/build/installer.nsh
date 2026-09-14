; electron-builder picks this file up automatically (build/installer.nsh).
;
; The router keeps running as ClaudeRipple.exe under Task Scheduler after the tray app is closed,
; so the stock "app is running" check failed every reinstall with nothing the user could act on
; (2026-09-14). Before that check we stop the supervisor, ask the router to drain, and end what is
; left — see build/stop-clauderipple.ps1. A real uninstall additionally undoes `clauderipple install`
; and `picker on` while the bundled runtime still exists.
;
; customCheckAppRunning replaces the body of CHECK_APP_RUNNING (installer and uninstaller alike);
; the stock _CHECK_APP_RUNNING still runs afterwards and reports anything that survived. Defining
; the custom macro makes electron-builder skip its own include of getProcessInfo.nsh and the `pid`
; variable (allowOnlyOneInstallerInstance.nsh:5-8), which _CHECK_APP_RUNNING needs, so both are here.

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${if} $IsPowerShellAvailable == 0
    InitPluginsDir
    File /oname=$PLUGINSDIR\stop-clauderipple.ps1 "${BUILD_RESOURCES_DIR}\stop-clauderipple.ps1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "CLAUDERIPPLE_INSTDIR", t "$INSTDIR")i'
    StrCpy $1 "stop"
    !ifdef BUILD_UNINSTALLER
      ; An update runs the previous uninstaller with --updated (installUtil.nsh). That is not an
      ; uninstall: only stop the router. Undoing the setup there wiped the scheduled task and
      ; settings.json on every reinstall (measured 2026-09-14).
      ${ifNot} ${isUpdated}
        StrCpy $1 "uninstall"
      ${endIf}
    !endif
    ; Not -NonInteractive: `picker off` shows the OS certificate-removal dialog (see cli/src/picker.ts).
    nsExec::ExecToLog '"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-clauderipple.ps1" -Mode $1'
    Pop $0
  ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
