# hermes-nextcloud

Nextcloud-Dashboard als Hermes-Desktop-Plugin — Kalender, Aufgaben und weitere
Nextcloud-Bereiche direkt im Hermes-Fenster, mit vollem Lese-/Schreibzugriff
(Termine anlegen/verschieben per Drag-and-Drop, Aufgaben abschließen).

Bringt einen eingebauten **ADHS-Fokus-Modus** mit — ein Feature, kein
Zwang: genau **eine** nächste Aufgabe statt einer Liste, sofortige
Brain-Dump-Erfassung, Aufgaben+Termine auf einer ruhigen Tagesachse ohne Rot
und ohne Mahnton, dazu Gamification (XP, Level, Streaks, Erfolge). Wer den
großen Überblick will, öffnet den Kalender-Tab: Monatsraster, Wochenansicht
mit Stundenraster, „Ungeplante Aufgaben"-Seitenpanel.

**ADHS-Modus ist per `⚙`-Schalter in der Tab-Leiste abschaltbar** (Standard: an).
Ausgeschaltet verschwinden die Tabs "Fokus" und "Fortschritt", Startansicht
wird "Kalender" — die Capture-Leiste (Brain-Dump) bleibt in jedem Modus da,
das ist generisch nützliche Schnellerfassung, kein ADHS-exklusives Feature.

Dazu sieben weitere Bereiche als eigene Tabs: **Notizen**, **Deck** (Kanban,
Karten lassen sich zwischen Stacks verschieben), **Kontakte**, **Dateien**
(umbenennen/verschieben möglich), **Formulare** (Nextcloud Forms
beantworten), **Talk** (Räume lesen/schreiben, **Beta**), **Workspace-Sync**
(lokale Dateien der aktuellen Hermes-Sitzung zu Nextcloud hochladen). Dazu,
nur in den Einstellungen sichtbar: eine Liste verbundener **Mail-Konten**
(read-only, **Beta**). Auf Olivers Instanz sind aktuell nur Kontakte und
Dateien tatsächlich installiert; jeder Bereich zeigt einen ruhigen "App
nicht verfügbar"-Hinweis statt eines Fehlers, sobald die jeweilige
Nextcloud-App fehlt.

**Schreibaktionen außerhalb des Kalenders laufen hinter einem
Bestätigungsdialog** (Hermes' `ConfirmDialog`-Bauteil): anders als
Termine/Aufgaben im Kalender-Tab (dort reicht der 6-Sekunden-Rückgängig-
Hinweis, ein Dialog wäre dort reine Reibung) sind Deck-Karten-Verschiebungen,
Datei-Umbenennungen, Formular-Abgaben und Workspace-Uploads absichtlich
einen Klick langsamer — bewusste Reibung gegen Fehlklicks bei selteneren,
schwerer rückgängig zu machenden Aktionen.

Nextcloud (CalDAV) ist die alleinige Wahrheit für Titel, Termin und Status. Das
Plugin legt daneben nur ADHS-Zusatzdaten ab: Fokus-Reihenfolge, Teilschritte,
Snooze-Zeitpunkte, Fortschritt (XP, Level, Streak, Erfolge).

**Verhaltenswechsel seit v1.2:** Das Backend hat jetzt **Schreibzugriff auf
reguläre Nextcloud-Kalender** (nicht nur auf den eigenen Fokus-Aufgaben-
Kalender) — Termine lassen sich im Kalender-Tab anlegen und per Drag-and-Drop
verschieben. Jedes Verschieben zeigt danach 6 Sekunden lang einen
„Rückgängig"-Hinweis; ohne den wird `/events/move` bewusst nicht ans Frontend
angebunden.

Erledigen wird belohnt, nie bestraft: es gibt XP, Konfetti und einen
Fortschritts-Tab, aber keinen XP-Verlust, keinen Malus und kein „Streak
verloren". Ein ausgelassener Tag setzt den Streak still zurück.

## Was drin ist

| Datei | Rolle |
|---|---|
| `plugin.yaml` | Agent-Hälfte (Name, Version, Autor) |
| `dashboard/manifest.json` | mountet `plugin_api.py` unter `/api/plugins/hermes-nextcloud/` |
| `dashboard/plugin_api.py` | FastAPI-Router, CalDAV-Client, Anreicherungs-Speicher, XP-/Erfolgs-Logik |
| `desktop/plugin.js` | Desktop-UI: Route, Sidebar-Nav, Statusleiste, Palette, elf Tabs (Fokus, Tagesübersicht, Fortschritt, Kalender, Notizen, Deck, Kontakte, Dateien, Formulare, Talk, Workspace-Sync), Konfetti-Feier, Drag-and-Drop, Inline-Formulare, Bestätigungsdialoge, AIIANER-Footer/Über-Block |
| `desktop/brand.js` | reine Kopiervorlage für die AIIANER-Designtoken (Farbe/URL) — wird von `plugin.js` NICHT importiert, siehe Kommentar in der Datei |
| `deploy.sh` | nur für lokale Entwicklung: kopiert alles nach `~/.hermes/plugins/hermes-nextcloud/` (Linux/macOS), kein Git-Checkout, kein Update-Knopf |
| `deploy.ps1` | dasselbe für Windows (`%LOCALAPPDATA%\hermes\plugins\hermes-nextcloud\`) |

`dashboard/manifest.json` trägt bewusst **kein** `tab`- und kein `entry`-Feld.
Beide gehören zum Web-Dashboard-Plugin-System, das mit dem Desktop-SDK nichts zu
tun hat. Für das Unified Package ist nur `name` + `api` erforderlich; die
Desktop-Hälfte wird über `desktop/plugin.js` geladen.

## Routen

| Route | Zweck |
|---|---|
| `GET /status` | Ist Nextcloud konfiguriert und `caldav` installiert? |
| `POST /setup/install-caldav` | installiert `caldav` jetzt aktiv (Klick im Einrichtungs-Dialog, kein Auto-Install mehr) |
| `GET /settings` | aktueller Verbindungsstand fürs Einrichtungs-Formular (nie das Passwort) |
| `POST /settings` | Zugangsdaten testen und **nur bei Erfolg** speichern |
| `POST /capture` | Brain-Dump-Text → neues VTODO |
| `GET /focus` | nächste offene Aufgabe nach Fokus-Reihenfolge |
| `POST /focus/complete` | VTODO auf COMPLETED, verbucht XP/Streak und liefert frische Erfolge zurück |
| `POST /focus/defer` | ans Ende der Reihenfolge + Snooze, kein Statuswechsel |
| `POST /focus/breakdown` | Freitext-Teilschritte merken (v1: keine KI) |
| `GET /day` | Aufgaben + Termine eines Tages, zeitsortiert — optional `?date=YYYY-MM-DD`, ohne den Parameter wie bisher heute |
| `GET /month` | `?year=…&month=1–12`: pro Tag nur Zahlen (`tasksOpen`, `tasksCompleted`, `events`) fürs Monatsraster |
| `GET /week` | `?start=YYYY-MM-DD` (Montag): sieben Tage mit vollen Aufgaben-/Termin-Listen fürs Stundenraster |
| `GET /progress` | Level, XP, Streak und alle zehn Erfolge für den Fortschritts-Tab (braucht kein Nextcloud) |
| `GET /calendars` | Kalendernamen außer dem Fokus-Aufgaben-Kalender, fürs Termin-Anlegen |
| `POST /events` | legt einen echten Termin in einem regulären Kalender an (nicht im Fokus-Aufgaben-Kalender) |
| `POST /events/move` | verschiebt einen bestehenden Termin — Drag-and-Drop, schreibt echte Nextcloud-Daten |
| `POST /tasks/due` | setzt oder löscht (`due: null`) die Fälligkeit einer Aufgabe — Drag-and-Drop im eigenen Kalender |
| `GET /unscheduled` | offene Aufgaben ohne Fälligkeit, älteste zuerst — Inhalt des Seitenpanels |
| `POST /reminder/check` | vom Desktop gepollt, sagt ob erinnert werden soll |

## Kalender

Der vierte Tab hat zwei Raster-Ansichten (Umschalter oben) plus die
Tagesansicht:

- **Monat** — ein ganzer Monat als Raster (Montag zuerst). Jede Tageszelle
  trägt die Zahl und, falls dort etwas liegt, eine knappe Zeile wie „2
  Aufgaben · 1 Termin"; ein kleiner Punkt in der Akzentfarbe steht für an
  diesem Tag erledigte Aufgaben. Leere Tage bleiben leer — keine Nullen, keine
  Balken. Daneben steht das Seitenpanel **„Ungeplante Aufgaben"** (Aufgaben
  ohne Fälligkeit) — von dort auf einen Tag ziehen setzt die Fälligkeit.
- **Woche** — Stundenraster 06:00–22:00 plus Ganztags-Zeile, sieben
  Tagesspalten. Termine und terminierte Aufgaben stehen als Kacheln an ihrer
  Uhrzeit und lassen sich sowohl auf einen anderen Tag als auch auf eine
  andere Stunde ziehen. Eine „Jetzt"-Linie in der Akzentfarbe markiert die
  laufende Woche (nie Rot).
- **Tag** — Klick auf eine Zelle oder einen Wochentag-Kopf öffnet den Tag im
  Detail: Aufgaben und Termine in zwei getrennten Abschnitten, Aufgaben direkt
  mit „Erledigt"-Knopf inklusive derselben XP-Feier wie im Fokus-Tab. Der
  „+ Neu"-Knopf öffnet ein Inline-Formular für eine neue Aufgabe (mit
  Fälligkeit an diesem Tag) oder einen neuen Termin (mit Kalenderauswahl,
  ganztägig oder mit Uhrzeit).

Jedes Verschieben per Drag-and-Drop — Aufgabe wie Termin — zeigt danach einen
„Rückgängig"-Hinweis für ~6 Sekunden. Kein Bestätigungsdialog vorher (das wäre
bei einer Aufgabe reine Reibung), aber ein Fehlklick auf einen echten Termin
ist nie spurlos.

Der Überblick zeigt bewusst mehr als die Fokusansicht: auch Aufgaben, die
gerade auf „Später" stehen, erscheinen im Raster und in der Tagesansicht.
Snooze heißt „jetzt nicht vor die Nase", nicht „aus dem Kalender streichen".

**Einschränkung:** Aufgaben **ohne Fälligkeitsdatum** tauchen im Monats-/
Wochenraster nicht auf — sie haben keinen Tag, an den sie gehören, und leben
im Fokus-Eingang bzw. im „Ungeplante Aufgaben"-Panel. Erst das Ziehen auf
einen Tag gibt ihnen eine Fälligkeit.

## Weitere Nextcloud-Bereiche

| Route | Zweck |
|---|---|
| `GET /notes` | Notizenliste (Titel, Vorschau, Änderungsdatum) |
| `GET /notes/{id}` | eine Notiz mit vollem Inhalt |
| `POST /notes` | neue Notiz anlegen |
| `PUT /notes/{id}` | Titel/Inhalt ändern |
| `DELETE /notes/{id}` | Notiz löschen |
| `GET /deck/boards` | Deck-Boards auflisten |
| `GET /deck/boards/{id}` | Stacks + Karten eines Boards |
| `PUT /deck/boards/{boardId}/stacks/{stackId}/cards/{cardId}` | Titel und/oder Fälligkeit einer Karte ändern |
| `POST /deck/boards/{boardId}/stacks/{stackId}/cards/{cardId}/move` | Karte in einen anderen Stack verschieben (Frontend fragt vorher per Bestätigungsdialog) |
| `GET /contacts` | Kontakte aus dem CardDAV-Adressbuch `contacts` (read-only) |
| `GET /files?path=` | WebDAV-Verzeichnisinhalt (read-only, kein Download in v1) |
| `POST /files/move` | Datei umbenennen/verschieben (WebDAV MOVE, `Overwrite: F`) |
| `GET /forms` | eigene Formulare auflisten |
| `GET /forms/{id}` | ein Formular mit Fragen (Datei-Upload-Fragen werden markiert, aber nicht unterstützt) |
| `POST /forms/{id}/submissions` | Antworten absenden |
| `GET /talk/rooms` | Talk-Räume auflisten — **Beta, Auth nicht live verifiziert** |
| `GET /talk/rooms/{token}/messages` | Nachrichten eines Raums (letzte 50, keine Systemmeldungen) — **Beta** |
| `POST /talk/rooms/{token}/messages` | Nachricht senden — **Beta** |
| `GET /mail/accounts` | verbundene Mail-Konten auflisten, nur lesen — **Beta, nur ein Endpunkt, kein Nachrichten-Zugriff** |
| `GET /workspace/files?path=` | lokale Dateien im übergebenen Ordner auflisten |
| `POST /workspace/sync` | ausgewählte lokale Dateien zu einem Nextcloud-Zielordner hochladen |
| `GET /update/status` | prüft per `git fetch`, ob eine neuere Version am Remote liegt (nur bei Git-Installation) |
| `POST /update/run` | ruft `hermes plugins update hermes-nextcloud` auf (Frontend fragt vorher per Bestätigungsdialog) |

Notizen und Deck brauchen die jeweilige Nextcloud-App; ist sie nicht
installiert, zeigt der Tab einen ruhigen Hinweis statt eines Fehlers. Kontakte
und Dateien brauchen nur CardDAV/WebDAV, die auf jeder Standard-Nextcloud-
Instanz mitlaufen. Deck- und Forms-Schreibzugriff nutzen Nextclouds
offizielle, gut dokumentierte APIs (`docs/API.md` in den jeweiligen
Nextcloud-Repos) mit demselben App-Passwort wie alles andere hier — kein
zusätzlicher Login. Der Notizen-Tab hat ein Suchfeld über der Liste
(Titel + Vorschau, rein clientseitig über die bereits geladene Liste,
keine neue Route).

**Talk und Mail sind als Beta markiert und ungetestet gegen eine echte
Instanz.** Nextclouds eigene API-Dokumentation bestätigt für Talk das
Auth-Modell nicht explizit (folgt vermutlich, aber unbestätigt, demselben
App-Passwort-Muster wie der Rest), und die Mail-App-API ist insgesamt
dünner dokumentiert als Deck/Forms/Talk (uneinheitliche URL-Präfixe
zwischen den eigenen Controllern der App). Deshalb bei Mail bewusst nur
der am klarsten dokumentierte Endpunkt gebaut (Konten auflisten,
read-only) statt geratener Nachrichten-Routen. Vor dem ersten echten
Beta-Test bitte gezielt genau diese beiden Bereiche ausprobieren und
Rückmeldung geben, falls ein Endpunkt 404 statt der erwarteten Daten
liefert — dann ist wahrscheinlich der URL-Präfix falsch geraten.

**Workspace-Sync** liest den Ordner der aktuell aktiven Hermes-Sitzung
(`host.state.cwd`) und lädt eine vom Nutzer ausgewählte Teilmenge der
Dateien darin zu einem konfigurierbaren Nextcloud-Ordner hoch (Standard:
`HermesSync`, änderbar im Workspace-Sync-Tab). Nur lokal → Nextcloud, kein
Rücksync, kein automatischer Hintergrundlauf — jeder Upload braucht einen
bewussten Klick plus Bestätigungsdialog. Dateien über 50 MB werden
übersprungen (mit Fehlermeldung in der Ergebnisliste), kein stillschweigender
Abbruch.

## Installation

**Empfohlener Weg: über Hermes selbst, per Git.**

1. Öffne in Hermes **Settings → Plugins → Install from Git**.
2. Trage dieses Repository ein:

   ```text
   https://github.com/oliverhees/hermes-nextcloud
   ```

3. Prüfe die angezeigten Plugin-Inhalte und installiere das Plugin.
4. Hermes Desktop **komplett** neu starten (nicht nur das Fenster neu
   laden) und in **Capabilities → Plugins** den Eintrag „Fokus" einschalten.

Dieser Weg installiert das Plugin als echten Git-Checkout — nur dann
funktioniert der **Aktualisieren**-Knopf in den Plugin-Einstellungen (siehe
„Update" unten). Ohne `--ref`/gepinnte Revision bleibt der Checkout auf dem
`main`-Branch, Hermes' eigener `hermes plugins update`-Befehl (den unser
Aktualisieren-Knopf im Hintergrund aufruft) funktioniert dann direkt.

<details>
<summary>Alternative für lokale Entwicklung: deploy.sh/deploy.ps1 (kein Update-Knopf)</summary>

```bash
./deploy.sh       # Linux/macOS
```

```powershell
.\deploy.ps1      # Windows
```

Beide Skripte **kopieren** Dateien nach `$HERMES_HOME/plugins/hermes-nextcloud/`
(Windows-Default: `%LOCALAPPDATA%\hermes`, sonst `~/.hermes`) — kein
`.git`-Ordner entsteht dabei, der Aktualisieren-Knopf bleibt deshalb
unsichtbar (siehe `/update/status`). Gedacht für schnelle lokale
Iteration bei der Plugin-Entwicklung selbst, nicht als Endnutzer-Weg.

</details>

Nach jeder Installation/jedem Update gilt: Wird nur `desktop/plugin.js`
geändert, reicht ⌘K → **Reload desktop plugins**. Ändert sich
`dashboard/plugin_api.py`, braucht es einen echten Neustart — Python-Module
laden sich nicht von selbst neu.

Die Python-Bibliothek `caldav` ist in Hermes' venv nicht vorinstalliert. Das
Backend installiert sie **nicht mehr automatisch** beim Laden (früherer
Stand: stiller `pip install` bei jedem Modul-Import, ohne dass Nutzer das je
zu sehen bekamen) — stattdessen zeigt der Einrichtungs-Dialog einen
„Bibliothek installieren"-Knopf, sobald `/status` `caldav: false` meldet.
Erst ein Klick löst `sys.executable -m pip install caldav` aus, über den
bereits laufenden Python-Interpreter, identisch unter Linux, macOS und
Windows. Schlägt das fehl (kein Internet, schreibgeschütztes venv), zeigt
`/status` den genauen Grund inklusive Fallback-Befehl für die Kommandozeile.

## Update

Nur sichtbar, wenn per „Install from Git" installiert (siehe oben) **und**
eine neuere Version am Remote liegt: ein Hinweis mit Commit-Abstand plus
ein **Aktualisieren**-Knopf erscheint in den Plugin-Einstellungen
(⚙-Schalter in der Tab-Leiste). Der Klick ruft im Hintergrund
`hermes plugins update hermes-nextcloud` auf — Hermes' eigenen, offiziellen
Mechanismus (Git-Pull, Bytecode-Aufräumen, erneuter Sicherheits-Scan,
Nachfrage bei neuen Capabilities), kein Eigenbau. Hinter einem
Bestätigungsdialog, weil es Dateien auf der Platte ersetzt. Genau wie bei
jeder Backend-Änderung: die Desktop-Oberfläche lädt automatisch neu
(Hot-Reload), das Backend braucht danach einen echten Neustart.

Der Check selbst (`GET /update/status`) läuft `git fetch` gegen das
Plugin-Verzeichnis und vergleicht den lokalen Stand mit dem Remote — kein
Hintergrund-Timer, die Prüfung passiert, wenn die Einstellungen geöffnet
werden.

## Einrichtung

### 1. Nextcloud-App-Passwort erzeugen

In Nextcloud unter **Einstellungen → Sicherheit → App-Passwort erstellen** ein
neues Passwort mit dem Namen `hermes-nextcloud` anlegen. Ein eigenes, nur für dieses
Plugin — nicht das aus einem anderen Tool wiederverwenden.

### 2. Im Plugin selbst verbinden

Kein Config-File von Hand editieren. Sobald „Fokus" in der Seitenleiste
geöffnet wird und noch nichts eingerichtet ist, erscheint ein
Einrichtungs-Formular: Host, Benutzername, App-Passwort eintragen, **Verbinden**
klicken. Das Backend testet die Verbindung sofort gegen Nextcloud — gespeichert
wird nur, wenn der Test klappt, sonst steht der Fehler direkt im Formular.

Die Zugangsdaten landen danach in
`$HERMES_HOME/hermes-nextcloud/credentials.json` (Datei-Rechte `600`, nur der
eigene Unix-User kann sie lesen) — **nicht** in `~/.hermes/config.yaml`. Das
Plugin verwaltet diese Datei selbst; von Hand muss darin nichts geändert
werden.

<details>
<summary>Alternative: manuell in config.yaml (fortgeschritten, optional)</summary>

Wer YAML von Hand pflegen möchte, kann statt des Formulars auch einen Block
unter `plugins.hermes-nextcloud` bzw. `plugins.entries.hermes-nextcloud` in
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

- **Nextcloud**: Aufgaben (VTODO im Kalender `Fokus-Aufgaben`, lesen+schreiben),
  Termine in regulären Kalendern (lesen, plus anlegen/verschieben aus dem
  Kalender-Tab heraus — seit v1.2, siehe Verhaltenswechsel oben)
- **`$HERMES_HOME/hermes-nextcloud/credentials.json`** (chmod 600): Nextcloud-Host,
  Benutzername, App-Passwort — vom Einrichtungs-Formular geschrieben
- **`$HERMES_HOME/hermes-nextcloud/enrichment.json`**: Fokus-Reihenfolge,
  Teilschritte, Snooze — UID-verschlüsselt, ohne Kopie von Titel oder Status —
  plus der Fortschritt unter `gamification` (XP, Streak, freigeschaltete
  Erfolge). Ältere Dateien ohne diesen Block werden beim Lesen ergänzt, es geht
  nichts verloren.
- **`ctx.storage`** (`hermes.plugin.hermes-nextcloud.*`): zuletzt gewählter Tab,
  Erinnerungs-Intervall, Workspace-Sync-Zielordner

Nichts davon liegt im `~/.hermes/hermes-agent`-Checkout, also überlebt alles ein
Hermes-Auto-Update.

## Sicherheit

Ehrlich benannt, statt unerwähnt zu lassen — nach dem Vorbild anderer
Hermes-Plugins mit eigenem "Security notes"-Abschnitt:

- **Netzwerkzugriffe:** ausschließlich zur selbst konfigurierten
  Nextcloud-Instanz (CalDAV, CardDAV, WebDAV, OCS-REST für Notizen/Deck/
  Forms/Talk/Mail). Keine Telemetrie, kein Aufruf irgendeines anderen
  Servers.
- **Auth:** ein einziges Nextcloud-App-Passwort (siehe „Einrichtung"), HTTP
  Basic Auth, für ALLE Bereiche einschließlich Talk/Mail. Kein OAuth-Flow,
  kein zusätzlicher Zugangsdaten-Speicher pro Funktionsbereich.
- **Lokale Prozessaufrufe:** ausschließlich feste Argument-Listen, nie
  `shell=True`, nie mit Nutzereingabe zusammengesetzt: `pip install caldav`
  (nur nach Klick im Einrichtungs-Dialog), `git fetch`/`git rev-list`/
  `git rev-parse` gegen das eigene Plugin-Verzeichnis (Update-Check, ohne
  Nutzer-Interaktion beim Öffnen der Einstellungen, verändert nichts),
  `hermes plugins update hermes-nextcloud` (nur nach Klick + Bestätigungs-
  dialog — ruft Hermes' eigenen, offiziellen Update-Mechanismus auf, kein
  Eigenbau, siehe „Update" oben).
- **Lokaler Dateizugriff (neu, Workspace-Sync):** das Backend liest Dateien
  ausschließlich aus dem Ordner, den Hermes selbst als aktive Sitzung
  meldet (`host.state.cwd`), nie aus einem frei eingegebenen Pfad. Kein
  automatischer Lauf — jede Leseoperation kommt von einem Klick im
  Workspace-Sync-Tab, jeder Upload zusätzlich hinter einem
  Bestätigungsdialog. Dateien über 50 MB werden übersprungen.
- **Schreibzugriffe:** auf Aufgaben/Termine (Kalender-Tab, mit
  Rückgängig-Hinweis), Deck-Karten, Datei-Umbenennungen, Formular-Abgaben,
  Talk-Nachrichten und Workspace-Sync-Uploads — alle außer dem Kalender
  hinter einem Bestätigungsdialog. Notizen haben volles CRUD. Kontakte und
  Mail-Konten sind read-only.
- **`plugin.yaml`** deklariert bewusst kein `permissions`/`capabilities`-Feld
  — entspricht der Konvention der offiziellen Hermes-Kataloger-Plugins,
  keine Rechte über das Nötige hinaus anzumelden.
- **Talk und Mail sind Beta-Status**, siehe „Weitere Nextcloud-Bereiche"
  oben — Auth-Modell bzw. URL-Struktur sind dokumentationsbasiert gebaut,
  noch nicht gegen eine echte Instanz verifiziert.
