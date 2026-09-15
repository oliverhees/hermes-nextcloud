# Kopiert hermes-fokus nach $HERMES_HOME\plugins\hermes-fokus\ unter Windows.
# Windows-Pendant zu deploy.sh - selbe Kopierlogik, weil PowerShell hier die
# einzige Shell ist, die man ohne WSL/Git-Bash voraussetzen darf.
#
# Nutzung: .\deploy.ps1
$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Gleiche Reihenfolge wie hermes_home() in dashboard/plugin_api.py:
# 1. HERMES_HOME, wenn gesetzt (gilt auch fuer Profile/Remote-Setups)
# 2. sonst %LOCALAPPDATA%\hermes (Hermes' eigener Windows-Default)
if ($env:HERMES_HOME) {
    $HermesHome = $env:HERMES_HOME
} else {
    $HermesHome = Join-Path $env:LOCALAPPDATA "hermes"
}
$Target = Join-Path $HermesHome "plugins\hermes-fokus"

Write-Host "Deploye hermes-fokus nach $Target ..."
New-Item -ItemType Directory -Force -Path (Join-Path $Target "dashboard") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Target "desktop") | Out-Null

Copy-Item (Join-Path $RepoDir "plugin.yaml") (Join-Path $Target "plugin.yaml") -Force
Copy-Item (Join-Path $RepoDir "dashboard\manifest.json") (Join-Path $Target "dashboard\manifest.json") -Force
Copy-Item (Join-Path $RepoDir "dashboard\plugin_api.py") (Join-Path $Target "dashboard\plugin_api.py") -Force

# Der Desktop-Einstieg zuletzt: der Watcher darf nie eine neue UI gegen ein
# altes Backend laden (siehe deploy.sh - selbe Begruendung).
Copy-Item (Join-Path $RepoDir "desktop\plugin.js") (Join-Path $Target "desktop\plugin.js") -Force

$PycacheDir = Join-Path $Target "dashboard\__pycache__"
if (Test-Path $PycacheDir) { Remove-Item -Recurse -Force $PycacheDir }

Write-Host ""
Write-Host "Fertig. Noch zu tun:"
Write-Host "  1. In $HermesHome\config.yaml unter 'plugins.enabled' den Eintrag"
Write-Host "     '- hermes-fokus' ergaenzen (sonst wird plugin_api.py nie importiert)."
Write-Host "  2. Hermes Desktop komplett neu starten, danach in Capabilities -> Plugins 'Fokus' einschalten."
Write-Host "  3. Nextcloud im Plugin selbst verbinden: 'Fokus' in der Seitenleiste oeffnen, Formular ausfuellen."
Write-Host "     'caldav' installiert sich beim ersten Laden automatisch, falls es fehlt - kein manueller pip-Befehl noetig."
