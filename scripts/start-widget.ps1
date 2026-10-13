# Launch Token Usage corner widget detached (no terminal needed after start).
# Usage: pwsh -File scripts/start-widget.ps1
# Optional: -Fixture
# Shortcuts (Start Menu, Startup) are written by the widget itself; see `tuw startup install`.

param(
  [switch]$Fixture
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $Root "node_modules\electron\dist\electron.exe"

# Startup / detached launches often lack nvm's node on PATH.
$nodeCandidates = @(
  $env:npm_node_execpath,
  (Join-Path "C:\nvm4w\nodejs" "node.exe"),
  $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK "node.exe" })
) | Where-Object { $_ -and (Test-Path $_) }
if ($nodeCandidates.Count -gt 0) {
  $env:NODE_BINARY = $nodeCandidates[0]
  $nodeDir = Split-Path -Parent $env:NODE_BINARY
  $env:Path = "$nodeDir;$env:Path"
}

if (-not (Test-Path $Electron)) {
  throw "Electron not found at $Electron. Run npm install in $Root first."
}

# main.cjs keeps USAGE_FIXTURE only when argv has --fixture.
$electronArgs = @("`"$Root`"")
if ($Fixture) {
  $env:USAGE_FIXTURE = "1"
  $electronArgs += "--fixture"
} else {
  Remove-Item Env:USAGE_FIXTURE -ErrorAction SilentlyContinue
}

$proc = Start-Process -FilePath $Electron -ArgumentList $electronArgs -WorkingDirectory $Root -PassThru -WindowStyle Normal
Write-Host "Widget started (pid $($proc.Id)). You can close this terminal."
