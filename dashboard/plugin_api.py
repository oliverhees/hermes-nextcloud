"""hermes-fokus - Backend.

ADHS-konformer Aufgabenplaner. Nextcloud (CalDAV) ist die alleinige Wahrheit
fuer Titel, Faelligkeit und Status. Dieses Backend haelt daneben nur die
ADHS-Anreicherung: Fokus-Reihenfolge, Teilschritte, Snooze - UID-verschluesselt,
niemals eine Kopie von Titel oder Status (ISC-26).

Routen liegen unter /api/plugins/hermes-fokus/ und damit hinter dem Auth-Gate.

Fehlt die Nextcloud-Konfiguration, antwortet jede Route mit einem klaren 4xx
statt den ganzen Router beim Import zu sprengen - ein Plugin, das den
Gateway-Start bricht, ist schlimmer als eins, das sagt was ihm fehlt. Fehlt die
caldav-Bibliothek, installiert dieses Modul sie beim ersten Laden selbst nach
(ueber sys.executable, also plattformunabhaengig - siehe _ensure_caldav()).
"""

from __future__ import annotations

import datetime as dt
import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

PLUGIN_ID = "hermes-fokus"
DEFAULT_CALENDAR = "Fokus-Aufgaben"
DEFAULT_SNOOZE_MINUTES = 60
MAX_TITLE_LEN = 500
MAX_SUBTASKS = 20


def _ensure_caldav():
    """caldav ist in Hermes' venv nicht vorinstalliert. Statt Oliver (oder wer
    auch immer das Plugin installiert) auf einen manuellen pip-Befehl zu
    verweisen, installiert dieses Modul die Bibliothek beim ersten Laden selbst
    nach - ueber `sys.executable -m pip`, also denselben Interpreter, in dem
    Hermes gerade laeuft. Das funktioniert identisch unter Linux, macOS und
    Windows, weil es kein Shell-Kommando ist, sondern ein Python-Unterprozess
    des bereits laufenden Interpreters.

    Schlaegt die Installation fehl (kein Internet, schreibgeschuetztes venv,
    kein pip), gibt die Funktion sauber (None, Fehlertext) zurueck statt den
    Modul-Import zu sprengen - jede Route meldet das dann als 503 mit Grund.
    """
    try:
        import caldav as caldav_module

        return caldav_module, ""
    except Exception:
        pass  # nicht vorhanden - unten selbst nachinstallieren

    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "caldav"],
            check=True,
            timeout=180,
            capture_output=True,
        )
    except Exception as exc:  # pragma: no cover - netzwerk-/umgebungsabhaengig
        detail = getattr(exc, "stderr", None)
        detail_text = detail.decode("utf-8", "replace")[-400:] if detail else str(exc)
        return None, f"automatische Installation fehlgeschlagen: {detail_text}"

    try:
        importlib.invalidate_caches()
        import caldav as caldav_module

        return caldav_module, ""
    except Exception as exc:  # pragma: no cover - umgebungsabhaengig
        return None, f"nach Installation weiterhin nicht importierbar: {exc}"


_caldav, _CALDAV_ERROR = _ensure_caldav()


def _caldav_missing_detail() -> str:
    return (
        "Die Python-Bibliothek 'caldav' fehlt und die automatische Installation "
        f"beim Laden ist gescheitert ({_CALDAV_ERROR}). Manuell nachholen: "
        f"{sys.executable} -m pip install caldav - dann Hermes neu starten."
    )

try:  # pragma: no cover - Umgebungsabhaengig
    import yaml as _yaml

    _YAML_ERROR = ""
except Exception as exc:  # pragma: no cover - Umgebungsabhaengig
    _yaml = None
    _YAML_ERROR = str(exc)


# ---------------------------------------------------------------- Pfade


def hermes_home() -> Path:
    """Wo Hermes seine Daten haelt, plattformuebergreifend.

    Reihenfolge wie in Hermes' eigenem scripts/install.ps1:
      1. HERMES_HOME, wenn gesetzt (gilt ueberall, auch fuer Profile)
      2. natives Windows: %LOCALAPPDATA%\\hermes
      3. sonst (Linux, macOS, WSL): ~/.hermes
    """
    env = os.environ.get("HERMES_HOME", "").strip()
    if env:
        return Path(env)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        if local:
            return Path(local) / "hermes"
        return Path.home() / "AppData" / "Local" / "hermes"
    return Path.home() / ".hermes"


HERMES_HOME = hermes_home()
CONFIG_FILE = HERMES_HOME / "config.yaml"
STATE_DIR = HERMES_HOME / PLUGIN_ID
ENRICHMENT_FILE = STATE_DIR / "enrichment.json"
CREDENTIALS_FILE = STATE_DIR / "credentials.json"

_state_lock = threading.Lock()

SETUP_HINT = (
    "Nextcloud noch nicht verbunden. Oeffne den Fokus-Tab in Hermes Desktop - "
    "dort fragt ein Einrichtungs-Formular Host, Benutzername und App-Passwort ab "
    "(Anleitung in der README des Plugins)."
)


# ---------------------------------------------------------------- Konfiguration
#
# Zwei Quellen, in dieser Reihenfolge:
#   1. credentials.json (dieser Ordner) - vom Einrichtungs-Formular im Plugin
#      selbst geschrieben, chmod 600, ausserhalb von Hermes' eigener config.yaml.
#      Das ist der dokumentierte Weg: niemand soll von Hand YAML editieren.
#   2. plugins.hermes-fokus / plugins.entries.hermes-fokus in config.yaml - ein
#      Fallback fuer Leute, die das lieber deklarativ pflegen. Beide Stellen,
#      weil Hermes seine config.yaml beim Speichern neu schreibt und dabei
#      unbekannte Schluessel unter 'plugins' verlieren kann.


def _read_credentials_file() -> dict:
    try:
        raw = json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write_credentials_file(data: dict) -> None:
    """Wie _write_enrichment: erst daneben schreiben, dann umbenennen - und
    zusaetzlich auf 0600, weil hier ein Klartext-App-Passwort drinsteht."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".credentials.", dir=str(STATE_DIR))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, CREDENTIALS_FILE)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _read_config_yaml_block() -> dict:
    """Fallback-Pfad: manuell in config.yaml gepflegt. Wird nur noch
    angefasst, wenn credentials.json leer ist."""
    if _yaml is None:
        raise HTTPException(status_code=400, detail=SETUP_HINT)
    try:
        raw = _yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail=SETUP_HINT)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"config.yaml ist nicht lesbar: {exc}"
        ) from exc

    plugins = raw.get("plugins") if isinstance(raw, dict) else None
    if not isinstance(plugins, dict):
        raise HTTPException(status_code=400, detail=SETUP_HINT)

    block = plugins.get(PLUGIN_ID)
    if not isinstance(block, dict):
        entries = plugins.get("entries")
        block = entries.get(PLUGIN_ID) if isinstance(entries, dict) else None
    if not isinstance(block, dict):
        raise HTTPException(status_code=400, detail=SETUP_HINT)
    return block


def _read_config_block() -> dict:
    creds = _read_credentials_file()
    if creds.get("host") and creds.get("username") and (
        creds.get("app_password") or creds.get("password")
    ):
        return creds
    return _read_config_yaml_block()


def _is_configured() -> bool:
    try:
        _read_config_block()
    except HTTPException:
        return False
    return True


def _dav_url(host: str) -> str:
    """Macht aus 'cloud.example.org' eine vollstaendige CalDAV-Wurzel."""
    value = host.strip().rstrip("/")
    if not value:
        raise HTTPException(status_code=400, detail=SETUP_HINT)
    if "://" not in value:
        value = f"https://{value}"
    if "/remote.php/dav" not in value:
        value = f"{value}/remote.php/dav/"
    if not value.endswith("/"):
        value = f"{value}/"
    return value


def _config() -> dict:
    block = _read_config_block()
    host = str(block.get("host") or block.get("url") or "").strip()
    username = str(block.get("username") or block.get("user") or "").strip()
    password = str(block.get("app_password") or block.get("password") or "").strip()
    missing = [
        name
        for name, value in (("host", host), ("username", username), ("app_password", password))
        if not value
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"{SETUP_HINT} Es fehlt noch: {', '.join(missing)}.",
        )

    read_raw = block.get("read_calendars")
    read_calendars = (
        [str(x).strip() for x in read_raw if str(x).strip()]
        if isinstance(read_raw, list)
        else None
    )
    return {
        "url": _dav_url(host),
        "username": username,
        "password": password,
        "calendar_name": str(block.get("calendar_name") or DEFAULT_CALENDAR).strip()
        or DEFAULT_CALENDAR,
        "read_calendars": read_calendars,
    }


# ---------------------------------------------------------------- CalDAV


def _principal():
    if _caldav is None:
        raise HTTPException(status_code=503, detail=_caldav_missing_detail())
    cfg = _config()
    try:
        client = _caldav.DAVClient(
            url=cfg["url"], username=cfg["username"], password=cfg["password"]
        )
        return client.principal(), cfg
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "Nextcloud ist nicht erreichbar oder die Zugangsdaten stimmen "
                f"nicht: {exc}"
            ),
        ) from exc


def _task_calendar(principal, cfg: dict):
    """Findet den Aufgaben-Kalender oder legt ihn an.

    Ein fehlender Kalender ist der Normalfall beim allerersten Start; er wird
    angelegt statt in bestehende Termin-Kalender hineinzuschreiben.
    """
    name = cfg["calendar_name"]
    try:
        calendars = principal.calendars()
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Kalenderliste nicht abrufbar: {exc}"
        ) from exc

    for cal in calendars:
        if _calendar_name(cal) == name:
            return cal

    try:
        return principal.make_calendar(
            name=name, supported_calendar_component_set=["VTODO"]
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Aufgaben-Kalender '{name}' konnte nicht angelegt werden: {exc}",
        ) from exc


def _calendar_name(cal) -> str:
    try:
        value = cal.get_display_name()
    except Exception:
        value = None
    return str(value or getattr(cal, "name", "") or "").strip()


def _component(obj):
    """Die icalendar-Komponente eines caldav-Objekts, versionsrobust."""
    comp = getattr(obj, "icalendar_component", None)
    if comp is not None:
        return comp
    instance = getattr(obj, "icalendar_instance", None)
    if instance is not None:
        for sub in instance.subcomponents:
            if sub.name in ("VTODO", "VEVENT"):
                return sub
    return None


def _ical_text(comp, key: str) -> str:
    value = comp.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _ical_dt(comp, key: str) -> dt.datetime | None:
    value = comp.get(key)
    if value is None:
        return None
    inner = getattr(value, "dt", None)
    if inner is None:
        return None
    if isinstance(inner, dt.datetime):
        return inner if inner.tzinfo else inner.replace(tzinfo=dt.timezone.utc)
    if isinstance(inner, dt.date):
        return dt.datetime(inner.year, inner.month, inner.day, tzinfo=dt.timezone.utc)
    return None


def _local_day_key(comp, key: str) -> str | None:
    """Auf welchen KALENDERTAG faellt dieses Feld, lokal gesehen?

    Bewusst nicht ueber _ical_dt: ein ganztaegiger Termin steht im iCal als
    reines DATE ohne Zeitzone. Wuerde man den erst auf UTC-Mitternacht heben und
    dann in die lokale Zone rechnen, rutschte er westlich von Greenwich um einen
    Tag nach hinten. Ein DATE ist bereits der Tag - es gibt nichts umzurechnen.
    """
    value = comp.get(key)
    inner = getattr(value, "dt", None) if value is not None else None
    if inner is None:
        return None
    if isinstance(inner, dt.datetime):
        moment = inner if inner.tzinfo else inner.replace(tzinfo=dt.timezone.utc)
        return moment.astimezone().date().isoformat()
    if isinstance(inner, dt.date):
        return inner.isoformat()
    return None


def _is_all_day(comp, key: str) -> bool:
    """Stand da ein reines DATE statt eines Zeitpunkts?

    Ohne diese Unterscheidung zeigte die Oberflaeche fuer einen ganztaegigen
    Eintrag eine Uhrzeit an, die niemand eingetragen hat - die UTC-Mitternacht,
    in Ortszeit umgerechnet.
    """
    value = comp.get(key)
    inner = getattr(value, "dt", None) if value is not None else None
    return isinstance(inner, dt.date) and not isinstance(inner, dt.datetime)


def _local_day_start(day: dt.date) -> dt.datetime:
    """Mitternacht dieses Tages in der lokalen Zeitzone.

    Ueber eine naive datetime plus .astimezone(), weil das den fuer DIESEN Tag
    gueltigen Zeitzonen-Versatz nimmt. Den Offset von heute auf ein anderes
    Datum zu kleben waere ueber einer Sommerzeit-Grenze um eine Stunde falsch.
    """
    return dt.datetime(day.year, day.month, day.day).astimezone()


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value else None


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _todo_view(todo) -> dict | None:
    comp = _component(todo)
    if comp is None:
        return None
    uid = _ical_text(comp, "UID")
    if not uid:
        return None
    return {
        "uid": uid,
        "title": _ical_text(comp, "SUMMARY") or "(ohne Titel)",
        "status": (_ical_text(comp, "STATUS") or "NEEDS-ACTION").upper(),
        "due": _iso(_ical_dt(comp, "DUE")),
        # Nur der Tagesteil, lokal gerechnet - danach gruppiert die
        # Kalenderansicht. Getrennt von 'due', weil das ein Zeitpunkt ist und
        # dieser hier ein Kalendertag.
        "dueDay": _local_day_key(comp, "DUE"),
        "dueAllDay": _is_all_day(comp, "DUE"),
        "created": _iso(_ical_dt(comp, "CREATED") or _ical_dt(comp, "DTSTAMP")),
    }


def _open_todos(calendar) -> list[dict]:
    try:
        todos = calendar.todos(include_completed=False)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Aufgaben nicht abrufbar: {exc}"
        ) from exc
    result = []
    for todo in todos:
        view = _todo_view(todo)
        if view and view["status"] not in ("COMPLETED", "CANCELLED"):
            result.append(view)
    return result


def _find_todo(calendar, uid: str):
    try:
        return calendar.todo_by_uid(uid)
    except Exception:
        pass
    # Nicht jede Server-/Bibliotheksfassung beantwortet todo_by_uid; der lineare
    # Weg ist langsamer, aber er findet die Aufgabe auch dann.
    try:
        candidates = calendar.todos(include_completed=True)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Aufgabe nicht abrufbar: {exc}"
        ) from exc
    for todo in candidates:
        view = _todo_view(todo)
        if view and view["uid"] == uid:
            return todo
    raise HTTPException(status_code=404, detail=f"Aufgabe {uid} existiert nicht (mehr).")


# ---------------------------------------------------------------- Anreicherung


def _default_gamification() -> dict:
    return {
        "xp": 0,
        "completedTotal": 0,
        "completedByDate": {},
        "streak": 0,
        "bestStreak": 0,
        "lastCompletionDate": None,
        "unlocked": {},
    }


def _default_state() -> dict:
    return {
        "schemaVersion": 1,
        "order": [],
        "items": {},
        "lastReminderAt": None,
        "gamification": _default_gamification(),
    }


def _read_enrichment() -> dict:
    try:
        value = json.loads(ENRICHMENT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _default_state()
    if not isinstance(value, dict):
        return _default_state()
    base = _default_state()
    base.update(
        {
            "order": value.get("order") if isinstance(value.get("order"), list) else [],
            "items": value.get("items") if isinstance(value.get("items"), dict) else {},
            "lastReminderAt": value.get("lastReminderAt"),
            "gamification": _merged_gamification(value.get("gamification")),
        }
    )
    return base


def _merged_gamification(raw: Any) -> dict:
    """Alte enrichment.json ohne 'gamification' laedt weiter: fehlende Felder
    werden mit den Defaults aufgefuellt, vorhandene auf ihren Typ geprueft.
    Ein kaputter Teilwert darf nie den ganzen Fortschritt verwerfen."""
    base = _default_gamification()
    if not isinstance(raw, dict):
        return base
    for key in ("xp", "completedTotal", "streak", "bestStreak"):
        try:
            base[key] = max(0, int(raw.get(key) or 0))
        except (TypeError, ValueError):
            pass
    by_date = raw.get("completedByDate")
    if isinstance(by_date, dict):
        for day, count in by_date.items():
            try:
                base["completedByDate"][str(day)] = max(0, int(count))
            except (TypeError, ValueError):
                continue
    unlocked = raw.get("unlocked")
    if isinstance(unlocked, dict):
        base["unlocked"] = {str(k): str(v) for k, v in unlocked.items()}
    last = raw.get("lastCompletionDate")
    base["lastCompletionDate"] = str(last) if last else None
    return base


def _write_enrichment(state: dict) -> None:
    """Erst daneben schreiben, dann umbenennen - ein Abbruch mittendrin darf
    keine halbe JSON-Datei hinterlassen."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".enrichment.", dir=str(STATE_DIR))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, ENRICHMENT_FILE)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _mutate_enrichment(fn) -> dict:
    with _state_lock:
        state = _read_enrichment()
        fn(state)
        _write_enrichment(state)
        return state


def _item(state: dict, uid: str) -> dict:
    """Schreibzugriff: legt den Eintrag an, wenn er fehlt."""
    items = state.setdefault("items", {})
    entry = items.get(uid)
    if not isinstance(entry, dict):
        entry = {}
        items[uid] = entry
    return entry


def _peek(state: dict, uid: str) -> dict:
    """Lesezugriff, ohne den Zustand anzufassen."""
    entry = (state.get("items") or {}).get(uid)
    return entry if isinstance(entry, dict) else {}


def _snoozed_until(state: dict, uid: str) -> dt.datetime | None:
    raw = _peek(state, uid).get("snoozeUntil")
    if not raw:
        return None
    try:
        value = dt.datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)


def _sort_key(state: dict, task: dict):
    """Fokus-Reihenfolge zuerst, danach Erfassungszeit (aelteste zuerst).

    Aufgaben ohne Platz in der Reihenfolge landen hinter den einsortierten,
    nicht davor - sonst wuerde jede frisch erfasste Aufgabe die bewusst
    gesetzte Reihenfolge ueberspringen.
    """
    order = state.get("order") or []
    try:
        rank = order.index(task["uid"])
    except ValueError:
        rank = len(order)
    return (rank, task.get("created") or "", task["title"])


def _ordered_open(calendar, state: dict) -> list[dict]:
    now = _now()
    ready = []
    for task in _open_todos(calendar):
        snooze = _snoozed_until(state, task["uid"])
        if snooze and snooze > now:
            continue
        task["subtasks"] = _peek(state, task["uid"]).get("subtasks") or []
        ready.append(task)
    ready.sort(key=lambda t: _sort_key(state, t))
    return ready


def _inbox_count(calendar, state: dict) -> int:
    return len(_ordered_open(calendar, state))


def _body_str(body: Any, key: str, *, required: bool = True) -> str:
    value = (body or {}).get(key) if isinstance(body, dict) else None
    text = str(value or "").strip()
    if required and not text:
        raise HTTPException(status_code=422, detail=f"Feld '{key}' fehlt.")
    return text


# ---------------------------------------------------------------- Fortschritt
#
# Reine Belohnung, nie Bestrafung: es gibt keinen XP-Verlust, keinen Malus und
# keinen "Streak verloren"-Zustand. Ein ausgelassener Tag setzt den Streak still
# auf 1 zurueck - ohne Meldung, ohne Text, ohne Farbe. Schuld senkt bei ADHS die
# Adhaerenz, deshalb kennt dieses Modul das Konzept gar nicht erst.


XP_PER_TASK = 10
XP_SUBTASK_BONUS = 5
XP_LEVEL_UNIT = 20


def _xp_for_level(level: int) -> int:
    """Umkehrung von _level_from_xp: ab wie viel XP beginnt dieses Level."""
    return XP_LEVEL_UNIT * (max(1, int(level)) - 1) ** 2


def _level_from_xp(xp: int) -> int:
    """level = 1 + floor(sqrt(xp / 20)) - monoton wachsend, ohne Tabellendatei.

    Ganzzahlig gerechnet statt ueber math.sqrt, damit kein Float-Rundungsfehler
    einen Level-Up genau an der Schwelle verschluckt.
    """
    value = max(0, int(xp))
    steps = 0
    while _xp_for_level(steps + 2) <= value:
        steps += 1
    return 1 + steps


def _level_view(xp: int) -> dict:
    level = _level_from_xp(xp)
    floor_xp = _xp_for_level(level)
    return {
        "level": level,
        "xpIntoLevel": int(xp) - floor_xp,
        "xpForNextLevel": _xp_for_level(level + 1) - floor_xp,
    }


ACHIEVEMENTS: list[dict] = [
    {
        "id": "first_task",
        "title": "Erster Schritt",
        "description": "Die erste Aufgabe erledigt.",
        "condition": lambda g, ctx: g["completedTotal"] >= 1,
    },
    {
        "id": "first_breakdown",
        "title": "Klein gedacht",
        "description": "Eine zerlegte Aufgabe erledigt.",
        "condition": lambda g, ctx: bool(ctx.get("hadSubtasks")),
    },
    {
        "id": "five_in_a_day",
        "title": "Fünferpack",
        "description": "5 Aufgaben an einem Tag.",
        "condition": lambda g, ctx: ctx.get("todayCount", 0) >= 5,
    },
    {
        "id": "ten_in_a_day",
        "title": "Zehnerpack",
        "description": "10 Aufgaben an einem Tag.",
        "condition": lambda g, ctx: ctx.get("todayCount", 0) >= 10,
    },
    {
        "id": "total_10",
        "title": "Zehn erledigt",
        "description": "Insgesamt 10 Aufgaben geschafft.",
        "condition": lambda g, ctx: g["completedTotal"] >= 10,
    },
    {
        "id": "total_50",
        "title": "Fünfzig erledigt",
        "description": "Insgesamt 50 Aufgaben geschafft.",
        "condition": lambda g, ctx: g["completedTotal"] >= 50,
    },
    {
        "id": "total_100",
        "title": "Hundert erledigt",
        "description": "Insgesamt 100 Aufgaben geschafft.",
        "condition": lambda g, ctx: g["completedTotal"] >= 100,
    },
    {
        "id": "streak_3",
        "title": "3 Tage am Stück",
        "description": "An drei Tagen hintereinander etwas geschafft.",
        "condition": lambda g, ctx: g["streak"] >= 3,
    },
    {
        "id": "streak_7",
        "title": "Eine Woche am Stück",
        "description": "An sieben Tagen hintereinander etwas geschafft.",
        "condition": lambda g, ctx: g["streak"] >= 7,
    },
    {
        "id": "streak_30",
        "title": "Ein Monat am Stück",
        "description": "An dreißig Tagen hintereinander etwas geschafft.",
        "condition": lambda g, ctx: g["streak"] >= 30,
    },
]


def _local_today() -> dt.date:
    """Lokale Zeitzone, nicht UTC: ein Streak orientiert sich am gefuehlten Tag,
    nicht am Kalender in Greenwich."""
    return dt.datetime.now().astimezone().date()


def _check_achievements(gamification: dict, ctx: dict) -> list[dict]:
    """Prueft alle noch gesperrten Erfolge gegen den neuen Zustand und schaltet
    passende frei. Gibt nur die frisch freigeschalteten zurueck."""
    unlocked = gamification.setdefault("unlocked", {})
    stamp = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    fresh = []
    for definition in ACHIEVEMENTS:
        if definition["id"] in unlocked:
            continue
        if definition["condition"](gamification, ctx):
            unlocked[definition["id"]] = stamp
            fresh.append(
                {
                    "id": definition["id"],
                    "title": definition["title"],
                    "description": definition["description"],
                }
            )
    return fresh


def _apply_completion_gamification(state: dict, had_subtasks: bool) -> dict:
    """Verbucht genau eine erledigte Aufgabe im Fortschritt und liefert die
    Antwort fuer die Oberflaeche. Aendert 'state' in-place, laeuft deshalb
    innerhalb von _mutate_enrichment (also unter dem Lock)."""
    gamification = state.setdefault("gamification", _default_gamification())
    level_before = _level_from_xp(gamification["xp"])

    gained = XP_PER_TASK + (XP_SUBTASK_BONUS if had_subtasks else 0)
    gamification["xp"] += gained
    gamification["completedTotal"] += 1

    today = _local_today()
    today_key = today.isoformat()
    by_date = gamification.setdefault("completedByDate", {})
    by_date[today_key] = int(by_date.get(today_key) or 0) + 1

    last = gamification.get("lastCompletionDate")
    if last == today_key:
        pass  # heute schon gezaehlt - der Streak steht bereits
    elif last == (today - dt.timedelta(days=1)).isoformat():
        gamification["streak"] += 1
    else:
        gamification["streak"] = 1  # stiller Neustart, kein Verlust-Ereignis
    gamification["lastCompletionDate"] = today_key
    gamification["bestStreak"] = max(gamification["bestStreak"], gamification["streak"])

    fresh = _check_achievements(
        gamification,
        {"todayCount": by_date[today_key], "hadSubtasks": had_subtasks},
    )

    view = _level_view(gamification["xp"])
    return {
        "xpGained": gained,
        "xp": gamification["xp"],
        "level": view["level"],
        "leveledUp": view["level"] > level_before,
        "xpIntoLevel": view["xpIntoLevel"],
        "xpForNextLevel": view["xpForNextLevel"],
        "streak": gamification["streak"],
        "unlockedAchievements": fresh,
    }


def _progress_view(gamification: dict) -> dict:
    view = _level_view(gamification["xp"])
    unlocked = gamification.get("unlocked") or {}
    today_key = _local_today().isoformat()
    return {
        "xp": gamification["xp"],
        "level": view["level"],
        "xpIntoLevel": view["xpIntoLevel"],
        "xpForNextLevel": view["xpForNextLevel"],
        "streak": gamification["streak"],
        "bestStreak": gamification["bestStreak"],
        "completedTotal": gamification["completedTotal"],
        "todayCount": int((gamification.get("completedByDate") or {}).get(today_key) or 0),
        "achievements": [
            {
                "id": definition["id"],
                "title": definition["title"],
                "description": definition["description"],
                "unlocked": definition["id"] in unlocked,
                "unlockedAt": unlocked.get(definition["id"]),
            }
            for definition in ACHIEVEMENTS
        ],
    }


# ---------------------------------------------------------------- Kalender
#
# Der Ueberblick ist bewusst eine andere Sicht als der Fokus: er zeigt ALLES,
# was an einem Tag haengt, auch Gesnooztes. Snooze heisst "jetzt nicht vor die
# Nase", nicht "aus dem Kalender streichen" - ein Ueberblick, der etwas
# verschweigt, ist keiner. Aufgaben ohne Faelligkeit tauchen hier gar nicht auf;
# sie leben im Fokus-Eingang und haetten im Raster keinen Platz, an den sie
# gehoeren.


def _calendar_day_tasks(calendar, state: dict, target: dt.date) -> list[dict]:
    """Offene Aufgaben, die an diesem Kalendertag faellig sind."""
    key = target.isoformat()
    found = []
    for task in _open_todos(calendar):
        if task.get("dueDay") != key:
            continue
        task["subtasks"] = _peek(state, task["uid"]).get("subtasks") or []
        found.append(task)
    found.sort(key=lambda t: _sort_key(state, t))
    return found


def _month_events(principal, cfg: dict, start: dt.datetime, end: dt.datetime) -> dict:
    """Termine des ganzen Monats, gezaehlt pro Tag.

    EIN search() pro Kalender ueber den kompletten Monat - nicht dreissig
    Einzelabfragen. Ein Raster, das beim Blaettern eine Sekunde steht, waere
    genau die Reibung, die diesen Tab unbenutzt liesse.
    """
    counts: dict[str, int] = {}
    allowed = cfg["read_calendars"]
    try:
        calendars = principal.calendars()
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Kalenderliste nicht abrufbar: {exc}"
        ) from exc

    for cal in calendars:
        name = _calendar_name(cal)
        if name == cfg["calendar_name"]:
            continue
        if allowed is not None and name not in allowed:
            continue
        try:
            found = cal.search(start=start, end=end, event=True, expand=True)
        except Exception:
            # Wie in /day: ein stummer Kalender darf den Monat nicht leeren.
            continue
        for item in found:
            comp = _component(item)
            if comp is None:
                continue
            key = _local_day_key(comp, "DTSTART")
            if key is None:
                continue
            counts[key] = counts.get(key, 0) + 1
    return counts


def _month_view(principal, cfg: dict, calendar, gamification: dict, year: int, month: int) -> dict:
    """Pro Tag drei Zahlen, mehr braucht ein Raster nicht.

    Tage ohne jeden Wert fehlen in 'days' ganz - die Oberflaeche liest ein
    fehlendes Datum als lauter Nullen. Weniger JSON, und im Raster bleibt der
    leere Tag wirklich leer statt "0 · 0" zu tragen.
    """
    start = _local_day_start(dt.date(year, month, 1))
    end = _local_day_start(
        dt.date(year + 1, 1, 1) if month == 12 else dt.date(year, month + 1, 1)
    )
    prefix = f"{year:04d}-{month:02d}-"
    days: dict[str, dict] = {}

    def bucket(key: str) -> dict:
        entry = days.get(key)
        if entry is None:
            entry = {"tasksOpen": 0, "tasksCompleted": 0, "events": 0}
            days[key] = entry
        return entry

    for key, count in _month_events(principal, cfg, start, end).items():
        if key.startswith(prefix) and count > 0:
            bucket(key)["events"] += count

    for task in _open_todos(calendar):
        key = task.get("dueDay")
        if key and key.startswith(prefix):
            bucket(key)["tasksOpen"] += 1

    # Erledigtes steht bereits im Fortschritt - kein zweiter CalDAV-Weg noetig.
    for raw_day, raw_count in (gamification.get("completedByDate") or {}).items():
        key = str(raw_day)
        if not key.startswith(prefix):
            continue
        try:
            count = int(raw_count or 0)
        except (TypeError, ValueError):
            continue
        if count > 0:
            bucket(key)["tasksCompleted"] += count

    return {"year": year, "month": month, "days": days}


# ---------------------------------------------------------------- Routen


@router.get("/status")
async def status() -> dict:
    """Ist alles verdrahtet? Bewusst die einzige Route, die NICHT 4xx wirft,
    wenn die Konfiguration fehlt - die Oberflaeche muss den Grund anzeigen
    koennen, statt nur einen Fehler."""
    try:
        cfg = _config()
    except HTTPException as exc:
        return {
            "ready": False,
            "configured": _is_configured(),
            "reason": exc.detail,
            "caldav": _caldav is not None,
        }
    return {
        "ready": _caldav is not None,
        "configured": True,
        "reason": "" if _caldav is not None else _caldav_missing_detail(),
        "caldav": _caldav is not None,
        "calendar": cfg["calendar_name"],
        "host": cfg["url"],
    }


@router.get("/settings")
async def get_settings() -> dict:
    """Liefert den aktuellen Verbindungsstand fuers Einrichtungs-Formular -
    NIE das Passwort, auch nicht an das eigene Plugin-UI."""
    creds = _read_credentials_file()
    if creds.get("host") and creds.get("username"):
        return {
            "configured": True,
            "source": "form",
            "host": creds.get("host", ""),
            "username": creds.get("username", ""),
            "calendarName": creds.get("calendar_name") or DEFAULT_CALENDAR,
        }
    try:
        block = _read_config_yaml_block()
    except HTTPException:
        return {"configured": False, "source": None, "host": "", "username": "", "calendarName": DEFAULT_CALENDAR}
    host_value = str(block.get("host") or block.get("url") or "")
    return {
        "configured": bool(host_value),
        "source": "config.yaml" if host_value else None,
        "host": host_value,
        "username": str(block.get("username") or block.get("user") or ""),
        "calendarName": str(block.get("calendar_name") or DEFAULT_CALENDAR),
    }


@router.post("/settings")
async def save_settings(body: dict) -> dict:
    """Speichert Nextcloud-Zugangsdaten NUR nach einem erfolgreichen
    Verbindungstest - ein gespeichertes, aber falsches Passwort waere
    schlimmer als gar keine Config, weil der Fehler dann erst beim naechsten
    Fokus-Abruf auftaucht statt sofort im Formular."""
    host_value = _body_str(body, "host")
    username = _body_str(body, "username")
    password = _body_str(body, "appPassword")
    calendar_name = (
        str((body or {}).get("calendarName") or DEFAULT_CALENDAR).strip()
        or DEFAULT_CALENDAR
    )
    url = _dav_url(host_value)

    if _caldav is None:
        raise HTTPException(status_code=503, detail=_caldav_missing_detail())
    try:
        client = _caldav.DAVClient(url=url, username=username, password=password)
        client.principal()
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Verbindung fehlgeschlagen - Host, Benutzername oder App-Passwort pruefen: {exc}",
        ) from exc

    _write_credentials_file(
        {
            "host": host_value,
            "username": username,
            "app_password": password,
            "calendar_name": calendar_name,
        }
    )
    return {"ok": True}


@router.post("/capture")
async def capture(body: dict) -> dict:
    """Brain-Dump: Text rein, VTODO raus. Kein Zwischenspeicher, der bei einem
    Absturz verloren gehen koennte."""
    title = _body_str(body, "title")[:MAX_TITLE_LEN]
    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    try:
        todo = calendar.save_todo(summary=title, status="NEEDS-ACTION")
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Aufgabe konnte nicht gespeichert werden: {exc}"
        ) from exc

    view = _todo_view(todo) or {"uid": "", "title": title}
    uid = view.get("uid")
    if uid:
        _mutate_enrichment(
            lambda s: _item(s, uid).__setitem__("capturedAt", _now().isoformat())
        )
    state = _read_enrichment()
    return {"task": view, "inbox": _inbox_count(calendar, state)}


@router.get("/focus")
async def focus() -> dict:
    """Genau eine naechste Aufgabe. Nie die Liste (ISC-7/ISC-22)."""
    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _read_enrichment()
    ready = _ordered_open(calendar, state)
    return {
        "task": ready[0] if ready else None,
        "inbox": len(ready),
    }


@router.post("/focus/complete")
async def focus_complete(body: dict) -> dict:
    """Erledigt in Nextcloud. Die Fokus-Reihenfolge rueckt nach, indem die UID
    aus ihr verschwindet."""
    uid = _body_str(body, "uid")
    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    todo = _find_todo(calendar, uid)
    try:
        todo.complete()
    except Exception:
        comp = _component(todo)
        if comp is None:
            raise HTTPException(
                status_code=502, detail="Aufgabe hat keine lesbare VTODO-Komponente."
            )
        comp["STATUS"] = "COMPLETED"
        comp["COMPLETED"] = _now().strftime("%Y%m%dT%H%M%SZ")
        try:
            todo.save()
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"Abschluss nicht speicherbar: {exc}"
            ) from exc

    reward: dict = {}

    def drop(state: dict) -> None:
        # Zuerst verbuchen, dann loeschen: nach dem pop() weiss niemand mehr,
        # ob die Aufgabe Teilschritte hatte - und genau das gibt den Bonus.
        had_subtasks = bool(_peek(state, uid).get("subtasks"))
        reward.update(_apply_completion_gamification(state, had_subtasks))
        state["order"] = [x for x in (state.get("order") or []) if x != uid]
        state.get("items", {}).pop(uid, None)

    state = _mutate_enrichment(drop)
    return {
        "ok": True,
        "inbox": _inbox_count(calendar, state),
        "gamification": reward,
    }


@router.post("/focus/defer")
async def focus_defer(body: dict) -> dict:
    """Spaeter: ans Ende der Fokus-Reihenfolge und fuer eine Weile aus dem Weg.
    Kein Statuswechsel in Nextcloud - verschoben ist nicht erledigt."""
    uid = _body_str(body, "uid")
    raw_minutes = (body or {}).get("minutes", DEFAULT_SNOOZE_MINUTES)
    try:
        minutes = int(raw_minutes)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="'minutes' muss eine Zahl sein.")
    if not 0 <= minutes <= 60 * 24 * 14:
        raise HTTPException(
            status_code=422, detail="'minutes' liegt ausserhalb von 0 bis 20160."
        )
    until = (_now() + dt.timedelta(minutes=minutes)).isoformat()

    def move(state: dict) -> None:
        order = [x for x in (state.get("order") or []) if x != uid]
        order.append(uid)
        state["order"] = order
        _item(state, uid)["snoozeUntil"] = until

    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _mutate_enrichment(move)
    return {"ok": True, "snoozeUntil": until, "inbox": _inbox_count(calendar, state)}


@router.post("/focus/breakdown")
async def focus_breakdown(body: dict) -> dict:
    """Teilschritte als reiner Freitext (v1: keine KI). Liegen ausschliesslich
    hier, nicht in Nextcloud - es sind ADHS-Hilfsdaten, keine Aufgaben."""
    uid = _body_str(body, "uid")
    raw = (body or {}).get("steps")
    if isinstance(raw, str):
        candidates = raw.splitlines()
    elif isinstance(raw, list):
        candidates = [str(x) for x in raw]
    else:
        raise HTTPException(
            status_code=422, detail="'steps' muss Text oder eine Liste sein."
        )
    steps = [s.strip()[:MAX_TITLE_LEN] for s in candidates if s.strip()][:MAX_SUBTASKS]

    def put(state: dict) -> None:
        _item(state, uid)["subtasks"] = steps

    _mutate_enrichment(put)
    return {"ok": True, "uid": uid, "subtasks": steps}


@router.get("/progress")
async def progress() -> dict:
    """Level, XP, Streak und Erfolge fuer den Fortschritts-Tab.

    Braucht bewusst kein Nextcloud: der Fortschritt liegt vollstaendig in
    enrichment.json, also bleibt dieser Tab auch dann lesbar, wenn die
    Verbindung gerade haengt.
    """
    return _progress_view(_read_enrichment()["gamification"])


@router.get("/day")
async def day(date: str | None = None) -> dict:
    """Aufgaben und Termine eines Tages auf einer Zeitachse.

    Ohne 'date' ist das wie bisher der heutige Tag in lokaler Zeitzone und die
    Antwort verhaelt sich unveraendert - die Tagesuebersicht haengt daran.

    Mit 'date' (YYYY-MM-DD) beantwortet dieselbe Route einen beliebigen Tag fuer
    die Kalenderansicht. Dann werden die Aufgaben auf die mit Faelligkeit AN
    DIESEM TAG eingegrenzt und der Snooze-Filter entfaellt - sonst zeigte eine
    angeklickte Zelle andere Aufgaben, als im Monatsraster darauf standen.

    Termine werden nur GELESEN. Der Aufgaben-Kalender wird beim Durchsuchen der
    Termin-Kalender uebersprungen, sonst stuende jede Aufgabe doppelt da.
    """
    if date is None:
        target = _local_today()
    else:
        try:
            target = dt.date.fromisoformat(date.strip())
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail="'date' muss ein Datum im Format YYYY-MM-DD sein.",
            )
        # Der letzte darstellbare Tag hat kein Morgen, und ohne Morgen gibt es
        # kein Suchfenster.
        if target >= dt.date(dt.MAXYEAR, 12, 31):
            raise HTTPException(
                status_code=422, detail="'date' liegt ausserhalb des darstellbaren Bereichs."
            )

    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _read_enrichment()

    start = _local_day_start(target)
    end = _local_day_start(target + dt.timedelta(days=1))

    events: list[dict] = []
    allowed = cfg["read_calendars"]
    try:
        calendars = principal.calendars()
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Kalenderliste nicht abrufbar: {exc}"
        ) from exc

    for cal in calendars:
        name = _calendar_name(cal)
        if name == cfg["calendar_name"]:
            continue
        if allowed is not None and name not in allowed:
            continue
        try:
            found = cal.search(start=start, end=end, event=True, expand=True)
        except Exception:
            # Ein Kalender, der keine Termin-Suche beantwortet, darf den ganzen
            # Tag nicht leer machen.
            continue
        for item in found:
            comp = _component(item)
            if comp is None:
                continue
            begins = _ical_dt(comp, "DTSTART")
            events.append(
                {
                    "kind": "event",
                    "uid": _ical_text(comp, "UID"),
                    "title": _ical_text(comp, "SUMMARY") or "(ohne Titel)",
                    "start": _iso(begins),
                    "end": _iso(_ical_dt(comp, "DTEND")),
                    "allDay": _is_all_day(comp, "DTSTART"),
                    "calendar": name,
                }
            )

    if date is None:
        source = _ordered_open(calendar, state)
    else:
        source = _calendar_day_tasks(calendar, state, target)

    tasks = [
        {
            "kind": "task",
            "uid": t["uid"],
            "title": t["title"],
            "start": t["due"],
            "end": None,
            "allDay": bool(t.get("dueAllDay")),
            "subtasks": t.get("subtasks") or [],
        }
        for t in source
    ]

    # Termine haben eine Uhrzeit, Aufgaben meistens nicht. Terminierte Punkte
    # zuerst chronologisch, alles Unterminierte danach in Fokus-Reihenfolge -
    # ein erfundener Zeitpunkt waere schlimmer als gar keiner.
    timed = sorted(
        [x for x in events + tasks if x["start"]], key=lambda x: str(x["start"])
    )
    untimed = [x for x in tasks if not x["start"]]
    return {
        "date": target.isoformat(),
        "items": timed + untimed,
        # Dieselben Objekte wie in 'items', nur getrennt: die Kalenderansicht
        # zeigt Aufgaben und Termine in zwei Abschnitten, weil nur das eine
        # erledigt werden kann und das andere aus fremden Kalendern kommt.
        "tasks": [x for x in timed if x["kind"] == "task"] + untimed,
        "events": [x for x in timed if x["kind"] == "event"],
        "inbox": len(tasks),
    }


@router.get("/month")
async def month_overview(year: int, month: int) -> dict:
    """Ein Monat als Zahlen pro Tag - die Datengrundlage des Kalender-Rasters.

    Bewusst ohne Titel und ohne Listen: das Raster zeigt nur, WO etwas liegt.
    Was genau, holt die Tagesansicht ueber /day?date=... nach.
    """
    if not 1 <= month <= 12:
        raise HTTPException(status_code=422, detail="'month' muss zwischen 1 und 12 liegen.")
    # Obergrenze ein Jahr unter MAXYEAR: _month_view braucht fuer den Dezember
    # den 1. Januar des Folgejahres als Monatsende, und den gibt es fuer 9999
    # nicht mehr.
    if not dt.MINYEAR <= year <= dt.MAXYEAR - 1:
        raise HTTPException(
            status_code=422,
            detail=f"'year' muss zwischen {dt.MINYEAR} und {dt.MAXYEAR - 1} liegen.",
        )

    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _read_enrichment()
    return _month_view(principal, cfg, calendar, state["gamification"], year, month)


@router.post("/reminder/check")
async def reminder_check(body: dict) -> dict:
    """Vom Desktop-Timer gepollt. Sagt, OB erinnert werden soll - das Anzeigen
    macht der Desktop mit ctx.os.notify.

    Der Zeitpunkt der letzten Erinnerung liegt hier und nicht im Desktop, damit
    ein Fensterneustart nicht sofort wieder anklopft.
    """
    raw = (body or {}).get("intervalMinutes", 50)
    try:
        interval = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="'intervalMinutes' muss eine Zahl sein.")
    if not 5 <= interval <= 60 * 12:
        raise HTTPException(
            status_code=422, detail="'intervalMinutes' liegt ausserhalb von 5 bis 720."
        )

    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _read_enrichment()
    ready = _ordered_open(calendar, state)
    if not ready:
        return {"remind": False, "task": None, "inbox": 0}

    now = _now()
    last_raw = state.get("lastReminderAt")
    last = None
    if last_raw:
        try:
            last = dt.datetime.fromisoformat(str(last_raw))
            last = last if last.tzinfo else last.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            last = None

    due = last is None or (now - last) >= dt.timedelta(minutes=interval)
    if due:
        _mutate_enrichment(lambda s: s.__setitem__("lastReminderAt", now.isoformat()))

    return {"remind": bool(due), "task": ready[0], "inbox": len(ready)}
