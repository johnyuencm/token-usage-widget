# Launch Token Usage corner widget detached (no terminal needed after start).
# Usage: pwsh -File scripts/start-widget.ps1
# Optional: -Fixture  -InstallStartup

param(
  [switch]$Fixture,
  [switch]$InstallStartup
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $Root "node_modules\electron\dist\electron.exe"

# Startup / detached launches often lack nvm's node on PATH.
$nodeCandidates = @(
  $env:npm_node_execpath,
  (Join-Path "C:\nvm4w\nodejs" "node.exe"),
  (Join-Path $env:NVM_SYMLINK "node.exe")
) | Where-Object { $_ -and (Test-Path $_) }
if ($nodeCandidates.Count -gt 0) {
  $env:NODE_BINARY = $nodeCandidates[0]
  $nodeDir = Split-Path -Parent $env:NODE_BINARY
  $env:Path = "$nodeDir;$env:Path"
}

if (-not (Test-Path $Electron)) {
  throw "Electron not found at $Electron. Run npm install in $Root first."
}

if ($Fixture) {
  $env:USAGE_FIXTURE = "1"
} else {
  Remove-Item Env:USAGE_FIXTURE -ErrorAction SilentlyContinue
}

$proc = Start-Process -FilePath $Electron -ArgumentList "`"$Root`"" -WorkingDirectory $Root -PassThru -WindowStyle Normal
Write-Host "Widget started (pid $($proc.Id)). You can close this terminal."

function Write-WidgetShortcut([string]$ShortcutPath, [int]$WindowStyle) {
  $cmd = Join-Path $Root "scripts\start-widget.cmd"
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($ShortcutPath)
  $sc.TargetPath = $cmd
  $sc.WorkingDirectory = $Root
  $sc.WindowStyle = $WindowStyle
  $sc.Description = "Token Usage always-on-top corner widget"
  $ico = Join-Path $Root "desktop\icons\icon.ico"
  if (Test-Path $ico) {
    $sc.IconLocation = "$ico,0"
  } elseif (Test-Path $Electron) {
    $sc.IconLocation = "$Electron,0"
  }
  $sc.Save()
}

# Always install a Start Menu shortcut so the widget is searchable like a normal app.
$programs = [Environment]::GetFolderPath("Programs")
$startMenuPath = Join-Path $programs "Token Usage Widget.lnk"
Write-WidgetShortcut $startMenuPath 7
Write-Host "Start Menu shortcut installed: $startMenuPath"

if ($InstallStartup) {
  $startup = [Environment]::GetFolderPath("Startup")
  $shortcutPath = Join-Path $startup "Token Usage Widget.lnk"
  Write-WidgetShortcut $shortcutPath 7
  Write-Host "Startup shortcut installed: $shortcutPath"
}
