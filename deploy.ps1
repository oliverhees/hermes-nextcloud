# Kopiert hermes-nextcloud nach $HERMES_HOME\plugins\hermes-nextcloud\ unter Windows.
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
$Target = Join-Path $HermesHome "plugins\hermes-nextcloud"

Write-Host "Deploye hermes-nextcloud nach $Target ..."
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
Write-Host "     '- hermes-nextcloud' ergaenzen (sonst wird plugin_api.py nie importiert)."
Write-Host "  2. Hermes Desktop komplett neu starten. Die Desktop-Oberflaeche laedt zwar"
Write-Host "     automatisch neu (Hot-Reload, kein Neustart noetig), aber das Backend"
Write-Host "     braucht fuer neuen Python-Code einen echten Neustart."
Write-Host "     Danach in Capabilities -> Plugins 'Nextcloud' einschalten."
Write-Host "  3. Nextcloud im Plugin selbst verbinden: 'Nextcloud' in der Seitenleiste oeffnen."
Write-Host "     Fehlt 'caldav', zeigt der Einrichtungs-Dialog einen Installieren-Knopf -"
Write-Host "     das passiert seit dieser Version NICHT mehr automatisch. Dann Formular ausfuellen."
