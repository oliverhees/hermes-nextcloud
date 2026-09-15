"""hermes-fokus - Backend.

ADHS-konformer Aufgabenplaner. Nextcloud (CalDAV) ist die alleinige Wahrheit
fuer Titel, Faelligkeit und Status. Dieses Backend haelt daneben nur die
ADHS-Anreicherung: Fokus-Reihenfolge, Teilschritte, Snooze - UID-verschluesselt,
niemals eine Kopie von Titel oder Status (ISC-26).

Routen liegen unter /api/plugins/hermes-fokus/ und damit hinter dem Auth-Gate.

Fehlt die Nextcloud-Konfiguration oder die caldav-Bibliothek, antwortet jede
Route mit einem klaren 4xx/503 statt den ganzen Router beim Import zu sprengen -
ein Plugin, das den Gateway-Start bricht, ist schlimmer als eins, das sagt was
ihm fehlt.
"""

from __future__ import annotations

import datetime as dt
import json
import os
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

# caldav ist eine externe Abhaengigkeit und in Hermes' venv nicht vorinstalliert.
# Der Import darf den Router-Import nicht toeten, sonst startet das Gateway mit
# "Failed to load plugin hermes-fokus API routes" und Oliver sieht nur 404er,
# ohne zu erfahren woran es liegt.
try:  # pragma: no cover - Umgebungsabhaengig
    import caldav as _caldav

    _CALDAV_ERROR = ""
except Exception as exc:  # pragma: no cover - Umgebungsabhaengig
    _caldav = None
    _CALDAV_ERROR = str(exc)

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

_state_lock = threading.Lock()

SETUP_HINT = (
    "Nextcloud noch nicht konfiguriert. Trage in "
    f"{CONFIG_FILE} einen Block 'plugins.{PLUGIN_ID}' mit host, username und "
    "app_password ein - die Anleitung steht in der README des Plugins."
)


# ---------------------------------------------------------------- Konfiguration


def _read_config_block() -> dict:
    """Liest den Plugin-Block aus Hermes' config.yaml.

    Zwei akzeptierte Stellen, weil Hermes seine config.yaml beim Speichern neu
    schreibt und dabei unbekannte Top-Level-Schluessel unter 'plugins' verlieren
    kann: 'plugins.hermes-fokus' (dokumentierter Weg) und
    'plugins.entries.hermes-fokus' (die Stelle, an der Hermes selbst bereits
    plugin-eigene Einstellungen fuehrt und die ein Rewrite ueberlebt).
    """
    if _yaml is None:
        raise HTTPException(
            status_code=503,
            detail=f"PyYAML ist in dieser Hermes-Umgebung nicht verfuegbar ({_YAML_ERROR}).",
        )
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
        raise HTTPException(
            status_code=503,
            detail=(
                "Die Python-Bibliothek 'caldav' fehlt in dieser Hermes-Umgebung "
                f"({_CALDAV_ERROR}). Installiere sie in Hermes' venv, z. B.: "
                "~/.hermes/hermes-agent/venv/bin/pip install caldav"
            ),
        )
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


def _default_state() -> dict:
    return {"schemaVersion": 1, "order": [], "items": {}, "lastReminderAt": None}


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
        }
    )
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


# ---------------------------------------------------------------- Routen


@router.get("/status")
async def status() -> dict:
    """Ist alles verdrahtet? Bewusst die einzige Route, die NICHT 4xx wirft,
    wenn die Konfiguration fehlt - die Oberflaeche muss den Grund anzeigen
    koennen, statt nur einen Fehler."""
    try:
        cfg = _config()
    except HTTPException as exc:
        return {"ready": False, "reason": exc.detail, "caldav": _caldav is not None}
    return {
        "ready": _caldav is not None,
        "reason": ""
        if _caldav is not None
        else f"Die Python-Bibliothek 'caldav' fehlt ({_CALDAV_ERROR}).",
        "caldav": _caldav is not None,
        "calendar": cfg["calendar_name"],
        "host": cfg["url"],
    }


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

    def drop(state: dict) -> None:
        state["order"] = [x for x in (state.get("order") or []) if x != uid]
        state.get("items", {}).pop(uid, None)

    state = _mutate_enrichment(drop)
    return {"ok": True, "inbox": _inbox_count(calendar, state)}


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


@router.get("/day")
async def day() -> dict:
    """Aufgaben und Termine des heutigen Tages auf einer Zeitachse.

    Termine werden nur GELESEN. Der Aufgaben-Kalender wird beim Durchsuchen der
    Termin-Kalender uebersprungen, sonst stuende jede Aufgabe doppelt da.
    """
    principal, cfg = _principal()
    calendar = _task_calendar(principal, cfg)
    state = _read_enrichment()

    local_now = dt.datetime.now().astimezone()
    start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)

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
                    "calendar": name,
                }
            )

    tasks = [
        {
            "kind": "task",
            "uid": t["uid"],
            "title": t["title"],
            "start": t["due"],
            "end": None,
            "subtasks": t.get("subtasks") or [],
        }
        for t in _ordered_open(calendar, state)
    ]

    # Termine haben eine Uhrzeit, Aufgaben meistens nicht. Terminierte Punkte
    # zuerst chronologisch, alles Unterminierte danach in Fokus-Reihenfolge -
    # ein erfundener Zeitpunkt waere schlimmer als gar keiner.
    timed = sorted(
        [x for x in events + tasks if x["start"]], key=lambda x: str(x["start"])
    )
    untimed = [x for x in tasks if not x["start"]]
    return {
        "date": start.date().isoformat(),
        "items": timed + untimed,
        "inbox": len(tasks),
    }


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
