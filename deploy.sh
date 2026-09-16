#!/usr/bin/env bash
# Kopiert hermes-nextcloud nach ~/.hermes/plugins/hermes-nextcloud/ (der Live-Ort, den
# Hermes' Auto-Update NICHT anfasst — siehe README.md).
#
# Nutzung: ./deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${HERMES_HOME:-$HOME/.hermes}/plugins/hermes-nextcloud"

echo "Deploye hermes-nextcloud nach $TARGET ..."
mkdir -p "$TARGET/dashboard" "$TARGET/desktop"

cp "$REPO_DIR/plugin.yaml"             "$TARGET/plugin.yaml"
cp "$REPO_DIR/dashboard/manifest.json" "$TARGET/dashboard/manifest.json"
cp "$REPO_DIR/dashboard/plugin_api.py" "$TARGET/dashboard/plugin_api.py"

# Der Desktop-Einstieg zuletzt: der Watcher darf nie eine neue UI gegen ein
# altes Backend laden.
cp "$REPO_DIR/desktop/plugin.js"       "$TARGET/desktop/plugin.js"

# Alte .pyc-Caches raus, damit Python garantiert den frischen Source laedt.
rm -rf "$TARGET/dashboard/__pycache__"

echo ""
echo "Fertig. Noch zu tun:"
echo "  1. In ~/.hermes/config.yaml unter 'plugins.enabled' den Eintrag"
echo "     '- hermes-nextcloud' ergaenzen (sonst wird plugin_api.py nie importiert)."
echo "  2. Hermes Desktop komplett neu starten. Die Desktop-Oberflaeche (desktop/plugin.js)"
echo "     laedt zwar automatisch neu (Unified-Package-Hot-Reload, kein Neustart noetig),"
echo "     aber das Backend (dashboard/plugin_api.py) braucht fuer neuen Python-Code einen"
echo "     echten Neustart - Python-Module laden sich nicht von selbst neu."
echo "     Danach in Capabilities -> Plugins 'Nextcloud' einschalten."
echo "  3. Nextcloud im Plugin selbst verbinden: 'Nextcloud' in der Seitenleiste"
echo "     oeffnen. Fehlt die Python-Bibliothek 'caldav', zeigt der Einrichtungs-Dialog"
echo "     einen Knopf zum Installieren - das passiert seit dieser Version NICHT mehr"
echo "     automatisch beim Laden. Danach Einrichtungs-Formular ausfuellen."
