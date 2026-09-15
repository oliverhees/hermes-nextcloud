# hermes-fokus

ADHS-konformer Aufgabenplaner als Hermes-Desktop-Plugin. Er zeigt **genau eine**
nächste Aufgabe statt einer Liste, nimmt jeden Gedanken sofort über eine
Capture-Leiste auf, und mischt Aufgaben und Nextcloud-Termine auf eine
gemeinsame Tagesachse — ohne Rot, ohne Mahnton.

Nextcloud (CalDAV) ist die alleinige Wahrheit für Titel, Termin und Status. Das
Plugin legt daneben nur ADHS-Zusatzdaten ab: Fokus-Reihenfolge, Teilschritte,
Snooze-Zeitpunkte.

## Was drin ist

| Datei | Rolle |
|---|---|
| `plugin.yaml` | Agent-Hälfte (Name, Version, Autor) |
| `dashboard/manifest.json` | mountet `plugin_api.py` unter `/api/plugins/hermes-fokus/` |
| `dashboard/plugin_api.py` | FastAPI-Router, CalDAV-Client, Anreicherungs-Speicher |
| `desktop/plugin.js` | Desktop-UI: Route, Sidebar-Nav, Statusleiste, Palette |
| `deploy.sh` | kopiert alles nach `~/.hermes/plugins/hermes-fokus/` |

`dashboard/manifest.json` trägt bewusst **kein** `tab`- und kein `entry`-Feld.
Beide gehören zum Web-Dashboard-Plugin-System, das mit dem Desktop-SDK nichts zu
tun hat. Für das Unified Package ist nur `name` + `api` erforderlich; die
Desktop-Hälfte wird über `desktop/plugin.js` geladen.

## Routen

| Route | Zweck |
|---|---|
| `GET /status` | Ist Nextcloud konfiguriert und `caldav` installiert? |
| `GET /settings` | aktueller Verbindungsstand fürs Einrichtungs-Formular (nie das Passwort) |
| `POST /settings` | Zugangsdaten testen und **nur bei Erfolg** speichern |
| `POST /capture` | Brain-Dump-Text → neues VTODO |
| `GET /focus` | nächste offene Aufgabe nach Fokus-Reihenfolge |
| `POST /focus/complete` | VTODO auf COMPLETED |
| `POST /focus/defer` | ans Ende der Reihenfolge + Snooze, kein Statuswechsel |
| `POST /focus/breakdown` | Freitext-Teilschritte merken (v1: keine KI) |
| `GET /day` | Aufgaben + Termine des Tages, zeitsortiert |
| `POST /reminder/check` | vom Desktop gepollt, sagt ob erinnert werden soll |

## Installation

```bash
./deploy.sh
```

Danach Hermes Desktop **komplett** neu starten (nicht nur das Fenster neu
laden) und in **Capabilities → Plugins** den Eintrag „Fokus" einschalten. Wird
nur `desktop/plugin.js` geändert, reicht ⌘K → **Reload desktop plugins**.

## Einrichtung

### 1. `caldav` in Hermes' venv installieren

Das Backend braucht die Python-Bibliothek `caldav`; sie ist in Hermes' venv
nicht vorinstalliert. Ohne sie antwortet jede Route mit einem klaren 503 statt
zu crashen — aber es funktioniert eben auch nichts.

```bash
~/.hermes/hermes-agent/venv/bin/pip install caldav
```

### 2. Nextcloud-App-Passwort erzeugen

In Nextcloud unter **Einstellungen → Sicherheit → App-Passwort erstellen** ein
neues Passwort mit dem Namen `hermes-fokus` anlegen. Ein eigenes, nur für dieses
Plugin — nicht das aus einem anderen Tool wiederverwenden.

### 3. Im Plugin selbst verbinden

Kein Config-File von Hand editieren. Sobald „Fokus" in der Seitenleiste
geöffnet wird und noch nichts eingerichtet ist, erscheint ein
Einrichtungs-Formular: Host, Benutzername, App-Passwort eintragen, **Verbinden**
klicken. Das Backend testet die Verbindung sofort gegen Nextcloud — gespeichert
wird nur, wenn der Test klappt, sonst steht der Fehler direkt im Formular.

Die Zugangsdaten landen danach in
`$HERMES_HOME/hermes-fokus/credentials.json` (Datei-Rechte `600`, nur der
eigene Unix-User kann sie lesen) — **nicht** in `~/.hermes/config.yaml`. Das
Plugin verwaltet diese Datei selbst; von Hand muss darin nichts geändert
werden.

<details>
<summary>Alternative: manuell in config.yaml (fortgeschritten, optional)</summary>

Wer YAML von Hand pflegen möchte, kann statt des Formulars auch einen Block
unter `plugins.hermes-fokus` bzw. `plugins.entries.hermes-fokus` in
`~/.hermes/config.yaml` eintragen (Felder `host`, `username`, `app_password`,
optional `calendar_name`, `read_calendars`). Das Backend prüft zuerst
`credentials.json` und fällt nur auf diesen Block zurück, wenn die Datei
leer ist. Für die meisten reicht das Formular — dieser Weg existiert nur,
weil manche Setups (Remote-Profile, Scripting) lieber deklarativ bleiben.

</details>

### 4. Plugin-Anzeigename bestätigen

Aktuell heißt es in der Oberfläche schlicht **Fokus**, mit dem Codicon `target`
in der Seitenleiste. Beides ist in `desktop/plugin.js` in je einer Zeile
änderbar.

## Einstellungen

Das Erinnerungs-Intervall liegt in `ctx.storage` unter `reminderMinutes`
(Standard: 50 Minuten, erlaubt 5–720). Der Desktop pollt alle fünf Minuten; ob
tatsächlich erinnert wird, entscheidet das Backend anhand des zuletzt
gemeldeten Zeitpunkts — ein Fensterneustart klopft deshalb nicht sofort wieder
an.

## Datenablage

- **Nextcloud**: Aufgaben (VTODO im Kalender `Fokus-Aufgaben`), Termine (nur gelesen)
- **`$HERMES_HOME/hermes-fokus/credentials.json`** (chmod 600): Nextcloud-Host,
  Benutzername, App-Passwort — vom Einrichtungs-Formular geschrieben
- **`$HERMES_HOME/hermes-fokus/enrichment.json`**: Fokus-Reihenfolge,
  Teilschritte, Snooze — UID-verschlüsselt, ohne Kopie von Titel oder Status
- **`ctx.storage`** (`hermes.plugin.hermes-fokus.*`): zuletzt gewählter Tab,
  Erinnerungs-Intervall

Nichts davon liegt im `~/.hermes/hermes-agent`-Checkout, also überlebt alles ein
Hermes-Auto-Update.
