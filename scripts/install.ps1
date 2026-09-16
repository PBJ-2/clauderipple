# ClaudeRipple installer for Windows.
#
#   irm https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.ps1 | iex
#
# Installing from npm needs npm, which needs Node, which is the one thing a first-time user is not
# guaranteed to have. So this script brings its own: it uses a Node 24+ already on PATH when there
# is one, and otherwise downloads the official build into ClaudeRipple's own directory. Nothing
# here needs administrator rights, and nothing is written outside the prefix and the user's PATH.
#
# Options (environment):
#   CLAUDERIPPLE_PREFIX    where to install            (default: $HOME\.clauderipple)
#   CLAUDERIPPLE_PACKAGE   what to install             (default: clauderipple, from npm)
#   CLAUDERIPPLE_NO_SETUP  1 = install only, no setup  (default: run `clauderipple install`)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Prefix = if ($env:CLAUDERIPPLE_PREFIX) { $env:CLAUDERIPPLE_PREFIX } else { Join-Path $HOME '.clauderipple' }
$Package = if ($env:CLAUDERIPPLE_PACKAGE) { $env:CLAUDERIPPLE_PACKAGE } else { 'clauderipple' }
$NodeMajor = 24
# Resolved from nodejs.org at install time so this script does not carry a version that goes stale;
# the pin is only what to use when the release index cannot be reached.
$NodeFallback = 'v24.21.0'
$Runtime = Join-Path $Prefix 'runtime'

function Get-NodeMajor([string]$exe) {
  # `node -v` and a regex, not `node -e`: PowerShell 5.1 mangles the quotes inside an -e script, and
  # the resulting SyntaxError on stderr becomes a terminating error under ErrorActionPreference Stop.
  # Measured 2026-09-16 in a Windows 11 arm64 VM: a perfectly good Node 24 was reported as absent and
  # the installer downloaded a second copy.
  try {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = (& $exe -v 2>$null | Out-String).Trim()
    $ErrorActionPreference = $old
    if ($out -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
  } catch { return 0 }
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Get-NodeMajor $cmd.Source) -ge $NodeMajor) { return $cmd.Source }
  $own = Join-Path $Runtime 'node.exe'
  if ((Test-Path $own) -and (Get-NodeMajor $own) -ge $NodeMajor) { return $own }
  return $null
}

function Install-Node {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "unsupported processor: $($env:PROCESSOR_ARCHITECTURE). Install Node $NodeMajor+ yourself, then: npm install -g clauderipple" }
  }
  $version = $NodeFallback
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $newest = $index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1
    if ($newest) { $version = $newest.version }
  } catch { }

  $name = "node-$version-win-$arch"
  $base = "https://nodejs.org/dist/$version"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  Write-Host "Downloading Node $version (win-$arch)..."
  $zip = Join-Path $tmp "$name.zip"
  Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
  # The download is verified against the release's own checksum file before anything is unpacked.
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape("$name.zip") } | Select-Object -First 1)
  if (-not $line) { throw "no checksum published for $name.zip" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw 'the Node download does not match its published checksum' }

  if (Test-Path $Runtime) { Remove-Item -Recurse -Force $Runtime }
  # The prefix may not exist yet, and Move-Item will not create a missing parent (measured: it fails
  # with "part of the path could not be found" after the download has already succeeded).
  New-Item -ItemType Directory -Path (Split-Path $Runtime -Parent) -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Move-Item -Path (Join-Path $tmp $name) -Destination $Runtime
  Remove-Item -Recurse -Force $tmp
}

$node = Find-Node
if ($node) {
  Write-Host "Using Node $(& $node -v) at $node"
} else {
  Install-Node
  $node = Join-Path $Runtime 'node.exe'
  if (-not (Test-Path $node)) { throw "unpacked Node but found no executable at $node" }
  Write-Host "Installed Node $(& $node -v) in $Runtime"
}

$npmCli = Join-Path (Split-Path $node -Parent) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) {
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCmd) { $npmCli = Join-Path (Split-Path $npmCmd.Source -Parent) 'node_modules\npm\bin\npm-cli.js' }
}
if (-not (Test-Path $npmCli)) { throw "found Node at $node but no npm next to it" }

# Installed under our own prefix rather than the Node installation's: nothing to elevate, and
# uninstalling is removing one directory.
Write-Host "Installing $Package..."
& $node $npmCli install --global --prefix $Prefix --loglevel error $Package
if ($LASTEXITCODE -ne 0) { throw "npm could not install $Package" }

# npm's global prefix on Windows puts the commands at the prefix root, not in a bin subdirectory.
$bin = $Prefix
$cmd = Join-Path $bin 'clauderipple.cmd'
if (-not (Test-Path $cmd)) { throw "npm installed $Package but left no command in $bin" }

# npm's own command shims invoke a bare `node`, which resolves to nothing when the Node we just
# downloaded is the only one on this machine: the install succeeds and the command cannot start.
# Measured 2026-09-16 in a Windows 11 arm64 VM. Replaced with shims that name the interpreter.
if ($node.StartsWith($Runtime, [StringComparison]::OrdinalIgnoreCase)) {
  $entry = Join-Path $Prefix 'node_modules\clauderipple\bin\clauderipple.js'
  if (-not (Test-Path $entry)) { throw "the installed package has no entry point at $entry" }
  Set-Content -Path $cmd -Value "@`"$node`" `"$entry`" %*" -Encoding ASCII
  Set-Content -Path (Join-Path $bin 'clauderipple.ps1') -Value "& `"$node`" `"$entry`" @args" -Encoding UTF8
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
  Write-Host "Added $bin to your PATH. Open a new terminal to pick it up."
}
$env:Path = "$bin;$env:Path"

if ($env:CLAUDERIPPLE_NO_SETUP -eq '1') {
  Write-Host ''
  Write-Host 'Installed. Finish with: clauderipple install'
  exit 0
}

Write-Host ''
& $cmd install
Write-Host ''
Write-Host 'Open the dashboard with: clauderipple ui'
