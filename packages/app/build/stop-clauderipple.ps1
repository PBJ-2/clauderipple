# Run by the NSIS installer and uninstaller (build/installer.nsh) before they touch files.
#
# Why: the router runs as ClaudeRipple.exe (Electron as Node) under a Task Scheduler job, and it
# keeps running after the tray app is closed. A reinstall then failed with "ClaudeRipple could not
# be closed" and no hint about what to close (2026-09-14). The supervisor loop must be stopped
# first, or it restarts the router the moment we stop it; the router itself is asked to shut down
# gracefully so in-flight model calls finish (a plain taskkill cuts them off).
#
# Mode "stop" (installer): stop the supervisor, ask the router to drain, then end what is left.
# Mode "uninstall" (uninstaller): the same, then `clauderipple picker off` (if picker mode is on,
# Claude Desktop would otherwise keep pointing at a proxy that no longer exists) and
# `clauderipple uninstall` (scheduled task, settings.json proxy keys) while the runtime still exists.
#
# Environment: CLAUDERIPPLE_INSTDIR (set by the installer). Always exits 0: the stock
# "app is running" check follows and reports anything that survived.

param([ValidateSet("stop", "uninstall")][string]$Mode = "stop")

$ErrorActionPreference = "SilentlyContinue"
$instDir = $env:CLAUDERIPPLE_INSTDIR
$home_ = $env:CLAUDERIPPLE_HOME
if (-not $home_) { $home_ = Join-Path $HOME ".clauderipple" }
$exe = if ($instDir) { Join-Path $instDir "ClaudeRipple.exe" } else { $null }
$cli = if ($instDir) { Join-Path $instDir "resources\clauderipple\packages\cli\src\index.ts" } else { $null }

function OurProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='ClaudeRipple.exe'" | Where-Object {
    -not $instDir -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($instDir, [System.StringComparison]::OrdinalIgnoreCase))
  })
}

# The router is the ClaudeRipple.exe whose argument is the router entry point. Only it drains;
# waiting for the tray app too just burns the whole timeout (measured: 100 s per install).
function RouterProcesses {
  @(OurProcesses | Where-Object { $_.CommandLine -and $_.CommandLine -like '*packages\router\src\index.ts*' })
}

function AdminPort {
  try {
    $c = Get-Content (Join-Path $home_ "config.json") -Raw | ConvertFrom-Json
    if ($c.admin -and $c.admin.port) { return [int]$c.admin.port }
    if ($c.listen -and $c.listen.port) { return [int]$c.listen.port + 1 }
  } catch {}
  return 8791
}

# 1. Stop the supervisor first, or it restarts the router as soon as it exits.
schtasks.exe /End /TN ClaudeRippleRouter 2>$null | Out-Null

# 2. Graceful shutdown: the router answers 202 and drains (up to 90 s for open model calls).
# `@(...)` at the call site: a single CimInstance coming out of a function has no .Count
# (measured: `(RouterProcesses).Count` was null with the router running, so nothing drained).
if (@(RouterProcesses).Count -gt 0) {
  try { Invoke-WebRequest -UseBasicParsing -Method POST -TimeoutSec 5 -Uri ("http://127.0.0.1:{0}/api/shutdown" -f (AdminPort)) | Out-Null } catch {}
  $deadline = (Get-Date).AddSeconds(100)
  while (@(RouterProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
}

# 3. Whatever is left (the tray app, a router that ignored us) goes now.
foreach ($p in OurProcesses) { Stop-Process -Id $p.ProcessId -Force }
Start-Sleep -Milliseconds 500

# 4. Uninstall: undo what `clauderipple install` / `picker on` did, while the runtime is still here.
if ($Mode -eq "uninstall" -and $exe -and (Test-Path $exe) -and (Test-Path $cli)) {
  $env:ELECTRON_RUN_AS_NODE = "1"
  $pickerOn = $false
  try { $pickerOn = [bool]((Get-Content (Join-Path $home_ "config.json") -Raw | ConvertFrom-Json).picker.enabled) } catch {}
  if ($pickerOn) { & $exe $cli picker off 2>&1 | Out-Null }
  & $exe $cli uninstall 2>&1 | Out-Null
}

exit 0
