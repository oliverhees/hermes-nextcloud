# hermes-fokus

ADHS-konformer Aufgabenplaner als Hermes-Desktop-Plugin. Er zeigt **genau eine**
nächste Aufgabe statt einer Liste, nimmt jeden Gedanken sofort über eine
Capture-Leiste auf, und mischt Aufgaben und Nextcloud-Termine auf eine
gemeinsame Tagesachse — ohne Rot, ohne Mahnton.

Nextcloud (CalDAV) ist die alleinige Wahrheit für Titel, Termin und Status. Das
Plugin legt daneben nur ADHS-Zusatzdaten ab: Fokus-Reihenfolge, Teilschritte,
Snooze-Zeitpunkte, Fortschritt (XP, Level, Streak, Erfolge).

Erledigen wird belohnt, nie bestraft: es gibt XP, Konfetti und einen
Fortschritts-Tab, aber keinen XP-Verlust, keinen Malus und kein „Streak
verloren". Ein ausgelassener Tag setzt den Streak still zurück.

## Was drin ist

| Datei | Rolle |
|---|---|
| `plugin.yaml` | Agent-Hälfte (Name, Version, Autor) |
| `dashboard/manifest.json` | mountet `plugin_api.py` unter `/api/plugins/hermes-fokus/` |
| `dashboard/plugin_api.py` | FastAPI-Router, CalDAV-Client, Anreicherungs-Speicher, XP-/Erfolgs-Logik |
| `desktop/plugin.js` | Desktop-UI: Route, Sidebar-Nav, Statusleiste, Palette, drei Tabs (Fokus, Tagesübersicht, Fortschritt), Konfetti-Feier |
| `deploy.sh` | kopiert alles nach `~/.hermes/plugins/hermes-fokus/` (Linux/macOS) |
| `deploy.ps1` | dasselbe für Windows (`%LOCALAPPDATA%\hermes\plugins\hermes-fokus\`) |

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
| `POST /focus/complete` | VTODO auf COMPLETED, verbucht XP/Streak und liefert frische Erfolge zurück |
| `POST /focus/defer` | ans Ende der Reihenfolge + Snooze, kein Statuswechsel |
| `POST /focus/breakdown` | Freitext-Teilschritte merken (v1: keine KI) |
| `GET /day` | Aufgaben + Termine des Tages, zeitsortiert |
| `GET /progress` | Level, XP, Streak und alle zehn Erfolge für den Fortschritts-Tab (braucht kein Nextcloud) |
| `POST /reminder/check` | vom Desktop gepollt, sagt ob erinnert werden soll |

## Installation

**Linux/macOS:**

```bash
./deploy.sh
```

**Windows (PowerShell):**

```powershell
.\deploy.ps1
```

Beide Skripte kopieren identisch nach `$HERMES_HOME/plugins/hermes-fokus/`
(Windows-Default: `%LOCALAPPDATA%\hermes`, sonst `~/.hermes`). Danach Hermes
Desktop **komplett** neu starten (nicht nur das Fenster neu laden) und in
**Capabilities → Plugins** den Eintrag „Fokus" einschalten. Wird nur
`desktop/plugin.js` geändert, reicht ⌘K → **Reload desktop plugins**.

Die Python-Bibliothek `caldav` ist in Hermes' venv nicht vorinstalliert — das
Backend installiert sie beim ersten Laden **selbst nach**, über den bereits
laufenden Python-Interpreter (`sys.executable -m pip`). Das funktioniert
identisch unter Linux, macOS und Windows, ohne Shell-Kommando und ohne
manuellen Schritt. Nur wenn das scheitert (kein Internet, schreibgeschütztes
venv), meldet `/status` den genauen Grund inklusive Fallback-Befehl.

## Einrichtung

### 1. Nextcloud-App-Passwort erzeugen

In Nextcloud unter **Einstellungen → Sicherheit → App-Passwort erstellen** ein
neues Passwort mit dem Namen `hermes-fokus` anlegen. Ein eigenes, nur für dieses
Plugin — nicht das aus einem anderen Tool wiederverwenden.

### 2. Im Plugin selbst verbinden

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

### 3. Plugin-Anzeigename bestätigen

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
  Teilschritte, Snooze — UID-verschlüsselt, ohne Kopie von Titel oder Status —
  plus der Fortschritt unter `gamification` (XP, Streak, freigeschaltete
  Erfolge). Ältere Dateien ohne diesen Block werden beim Lesen ergänzt, es geht
  nichts verloren.
- **`ctx.storage`** (`hermes.plugin.hermes-fokus.*`): zuletzt gewählter Tab,
  Erinnerungs-Intervall

Nichts davon liegt im `~/.hermes/hermes-agent`-Checkout, also überlebt alles ein
Hermes-Auto-Update.
