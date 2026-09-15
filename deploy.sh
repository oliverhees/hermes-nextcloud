#!/usr/bin/env bash
# Kopiert hermes-fokus nach ~/.hermes/plugins/hermes-fokus/ (der Live-Ort, den
# Hermes' Auto-Update NICHT anfasst — siehe README.md).
#
# Nutzung: ./deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${HERMES_HOME:-$HOME/.hermes}/plugins/hermes-fokus"

echo "Deploye hermes-fokus nach $TARGET ..."
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
echo "     '- hermes-fokus' ergaenzen (sonst wird plugin_api.py nie importiert)."
echo "  2. Hermes Desktop komplett neu starten (nicht nur Fenster neu laden),"
echo "     danach in Capabilities -> Plugins 'Fokus' einschalten."
echo "  3. Nextcloud im Plugin selbst verbinden: 'Fokus' in der Seitenleiste"
echo "     oeffnen, Einrichtungs-Formular ausfuellen. Kein config.yaml-Edit noetig."
