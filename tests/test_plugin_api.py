"""Tests fuer dashboard/plugin_api.py.

Deckt bewusst die Teile ab, die OHNE eine echte Nextcloud-Instanz pruefbar
sind und den groessten Nutzerschaden anrichten wuerden, wenn sie falsch
waeren: Credential-Speicherung (Klartext-Passwort, Dateirechte), die
Gamification-Mathematik (XP/Level/Erfolge - direkt nutzersichtbar bei jedem
erledigten Task) und den seit dieser Version expliziten caldav-Consent-Weg.

Bewusst NICHT abgedeckt: alle Routen, die echten HTTP-Traffic gegen eine
Nextcloud-Instanz brauchen (CalDAV-Schreibpfade /events, /events/move,
/focus/complete; Deck /deck/.../cards/{id} + .../move; Forms /forms/...;
Talk /talk/...; Mail /mail/accounts; Files /files/move). Alle brauchen
entweder eine echte Nextcloud-Instanz oder ein sorgfaeltig gebautes Mock
der jeweiligen Bibliothek/HTTP-Antwort, das hier bewusst nicht blind
nachgebaut wird, um keine falsche Sicherheit vorzutaeuschen. Deck/Forms
sind gegen die jeweils offizielle, gut dokumentierte API gebaut; Talk
zusaetzlich mit unbestaetigtem Auth-Modell; Mail nur mit einem einzigen,
besonders vorsichtig ausgewaehlten Endpunkt, weil die App-API insgesamt
duenn dokumentiert ist. Nichts davon ist live verifiziert - siehe
README-Abschnitt "Sicherheit". Naechster Schritt fuer eine spaetere Runde
mit Zugriff auf eine echte Instanz, nicht Teil dieses Batches.

Sehr wohl abgedeckt: die reine Python-Logik der neuen Workspace-Sync- und
Datei-Pfad-Validierung (_workspace_dir, _clean_dav_segment) - die braucht
kein Netzwerk und haette bei einem Fehler (z.B. Pfad-Traversal) echten
Schaden angerichtet.
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
API_PATH = REPO_ROOT / "dashboard" / "plugin_api.py"


def load_api_module():
    """Frisches Modul pro Test, damit sich Monkeypatches an HERMES_HOME/
    STATE_DIR nicht zwischen Tests verschleppen."""
    spec = importlib.util.spec_from_file_location("hermes_nextcloud_api_test", API_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def heim(api, wurzel: Path) -> Path:
    """Verdrahtet das Modul auf ein Test-Hermes um, analog zum Muster in
    aiianer-hermes-extensions/tests/."""
    home = wurzel / "hermes-home"
    home.mkdir(parents=True, exist_ok=True)
    api.HERMES_HOME = home
    api.CONFIG_FILE = home / "config.yaml"
    api.STATE_DIR = home / api.PLUGIN_ID
    api.CREDENTIALS_FILE = api.STATE_DIR / "credentials.json"
    return home


@mock.patch.dict(os.environ, {}, clear=False)
class CredentialsTest(unittest.TestCase):
    def test_roundtrip_und_dateirechte(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            heim(api, Path(tmp))
            daten = {"host": "cloud.example.com", "username": "olli", "app_password": "geheim"}
            api._write_credentials_file(daten)

            gelesen = api._read_credentials_file()
            self.assertEqual(gelesen, daten)

            # 0600: nur der Besitzer darf lesen/schreiben, niemand sonst.
            modus = stat.S_IMODE(api.CREDENTIALS_FILE.stat().st_mode)
            self.assertEqual(modus, 0o600)

    def test_fehlende_datei_liefert_leeres_dict_statt_fehler(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            heim(api, Path(tmp))
            self.assertEqual(api._read_credentials_file(), {})

    def test_kaputtes_json_liefert_leeres_dict_statt_absturz(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            heim(api, Path(tmp))
            api.STATE_DIR.mkdir(parents=True, exist_ok=True)
            api.CREDENTIALS_FILE.write_text("{kaputt", encoding="utf-8")
            self.assertEqual(api._read_credentials_file(), {})

    def test_schreiben_ist_atomar_kein_temp_file_liegen_geblieben(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            heim(api, Path(tmp))
            api._write_credentials_file({"host": "x", "username": "y", "app_password": "z"})
            uebrig = list(api.STATE_DIR.glob(".credentials.*"))
            self.assertEqual(uebrig, [], "Temporaere Schreibdatei serientechnisch nicht aufgeraeumt")


class GamificationMathTest(unittest.TestCase):
    """XP_LEVEL_UNIT = 20, level = 1 + floor(sqrt(xp / 20)). Direkt
    nachgerechnet statt nur die eigene Formel gegen sich selbst zu testen."""

    def test_level_1_bei_null_xp(self):
        api = load_api_module()
        self.assertEqual(api._level_from_xp(0), 1)

    def test_level_grenzen_stimmen_mit_der_dokumentierten_formel_ueberein(self):
        api = load_api_module()
        # _xp_for_level(2) = 20 * (2-1)^2 = 20 -> bei xp=19 noch Level 1, bei 20 Level 2
        self.assertEqual(api._xp_for_level(2), 20)
        self.assertEqual(api._level_from_xp(19), 1)
        self.assertEqual(api._level_from_xp(20), 2)
        # _xp_for_level(3) = 20 * 2^2 = 80
        self.assertEqual(api._xp_for_level(3), 80)
        self.assertEqual(api._level_from_xp(79), 2)
        self.assertEqual(api._level_from_xp(80), 3)

    def test_level_waechst_monoton_ueber_einen_grossen_bereich(self):
        api = load_api_module()
        letztes_level = 1
        for xp in range(0, 5000, 7):
            level = api._level_from_xp(xp)
            self.assertGreaterEqual(level, letztes_level, f"Level sank bei xp={xp}")
            letztes_level = level

    def test_negative_xp_faellt_nicht_unter_level_1(self):
        api = load_api_module()
        self.assertEqual(api._level_from_xp(-50), 1)

    def test_level_view_konsistent_mit_xp_for_level(self):
        api = load_api_module()
        ansicht = api._level_view(45)
        self.assertEqual(ansicht["level"], api._level_from_xp(45))
        self.assertEqual(ansicht["xpIntoLevel"], 45 - api._xp_for_level(ansicht["level"]))
        self.assertGreaterEqual(ansicht["xpIntoLevel"], 0)
        self.assertLess(ansicht["xpIntoLevel"], ansicht["xpForNextLevel"])


class AchievementConditionsTest(unittest.TestCase):
    def _by_id(self, api, achievement_id):
        treffer = [a for a in api.ACHIEVEMENTS if a["id"] == achievement_id]
        self.assertEqual(len(treffer), 1, f"Erfolg {achievement_id} nicht gefunden oder mehrfach")
        return treffer[0]

    def test_first_task_greift_erst_ab_einer_erledigten_aufgabe(self):
        api = load_api_module()
        bedingung = self._by_id(api, "first_task")["condition"]
        self.assertFalse(bedingung({"completedTotal": 0}, {}))
        self.assertTrue(bedingung({"completedTotal": 1}, {}))

    def test_streak_schwellen_sind_grenzwertig_korrekt(self):
        api = load_api_module()
        bedingung = self._by_id(api, "streak_7")["condition"]
        self.assertFalse(bedingung({"streak": 6}, {}))
        self.assertTrue(bedingung({"streak": 7}, {}))

    def test_alle_ids_sind_eindeutig(self):
        api = load_api_module()
        ids = [a["id"] for a in api.ACHIEVEMENTS]
        self.assertEqual(len(ids), len(set(ids)), "Doppelte Erfolgs-IDs")


class CaldavConsentTest(unittest.TestCase):
    """Der eigentliche Fix dieser Runde: keine stille Installation mehr beim
    Modul-Laden, nur noch auf ausdrueckliche Aufforderung."""

    def test_detect_caldav_installiert_nichts(self):
        api = load_api_module()
        with mock.patch("subprocess.run") as run:
            api._detect_caldav()
            run.assert_not_called()

    def test_modul_import_ruft_pip_nicht_auf_selbst_wenn_caldav_fehlt(self):
        """Regressionstest fuer den eigentlichen Fund: frueher lief pip
        install bei JEDEM Modul-Import, sobald 'caldav' fehlte. caldav ist in
        DIESER Testumgebung zufaellig schon installiert - das wuerde die
        eigentliche Pruefung unbemerkt umgehen (der pip-Zweig liefe nie, egal
        ob der Fix da ist), deshalb 'caldav' hier erzwungen als fehlend
        simuliert (sys.modules-Trick: None macht den naechsten Import
        garantiert fehlschlagen, unabhaengig vom echten venv-Zustand)."""
        aufrufe = []

        def beobachtet(*args, **kwargs):
            aufrufe.append(args)
            return mock.MagicMock(returncode=0)

        with mock.patch.dict(sys.modules, {"caldav": None}),                 mock.patch("subprocess.run", side_effect=beobachtet):
            load_api_module()

        pip_aufrufe = [a for a in aufrufe if a and "pip" in " ".join(str(x) for x in a[0])]
        self.assertEqual(pip_aufrufe, [], "Modul-Import hat pip aufgerufen - genau der behobene Fehler")

    def test_install_caldav_aktualisiert_modulzustand_bei_erfolg(self):
        api = load_api_module()
        api._caldav = None
        api._CALDAV_ERROR = "nicht installiert"

        fake_modul = mock.MagicMock()
        with mock.patch("subprocess.run") as run, \
                mock.patch.object(api, "importlib") as fake_importlib, \
                mock.patch.dict(sys.modules, {"caldav": fake_modul}):
            run.return_value = mock.MagicMock(returncode=0)
            ok, fehler = api.install_caldav()

        self.assertTrue(ok, fehler)
        self.assertEqual(fehler, "")
        self.assertIs(api._caldav, fake_modul)
        self.assertEqual(api._CALDAV_ERROR, "")

    def test_install_caldav_meldet_pip_fehler_sauber(self):
        api = load_api_module()
        api._caldav = None

        with mock.patch("subprocess.run", side_effect=api.subprocess.CalledProcessError(1, ["pip"])):
            ok, fehler = api.install_caldav()

        self.assertFalse(ok)
        self.assertIn("fehlgeschlagen", fehler)


class WorkspacePathValidationTest(unittest.TestCase):
    """Reine Pfad-Logik, kein Netzwerk noetig - ein Fehler hier waere ein
    echtes Sicherheitsproblem (Pfad-Traversal, beliebiger Datei-Upload)."""

    def test_workspace_dir_lehnt_relativen_pfad_ab(self):
        api = load_api_module()
        with self.assertRaises(api.HTTPException) as ctx:
            api._workspace_dir("relativer/pfad")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_workspace_dir_lehnt_nicht_existierenden_pfad_ab(self):
        api = load_api_module()
        with self.assertRaises(api.HTTPException) as ctx:
            api._workspace_dir("/pfad/der/garantiert/nicht/existiert/xyz123")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_workspace_dir_akzeptiert_echten_ordner(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            result = api._workspace_dir(tmp)
        self.assertEqual(str(result), str(Path(tmp).resolve()))

    def test_workspace_dir_lehnt_datei_statt_ordner_ab(self):
        api = load_api_module()
        with tempfile.TemporaryDirectory() as tmp:
            datei = Path(tmp) / "datei.txt"
            datei.write_text("x")
            with self.assertRaises(api.HTTPException) as ctx:
                api._workspace_dir(str(datei))
        self.assertEqual(ctx.exception.status_code, 422)

    def test_clean_dav_segment_lehnt_pfad_traversal_ab(self):
        api = load_api_module()
        for bad in ("../geheim", "a/../b", "..", ""):
            with self.assertRaises(api.HTTPException, msg=bad) as ctx:
                api._clean_dav_segment(bad, field="test")
            self.assertEqual(ctx.exception.status_code, 422)

    def test_clean_dav_segment_akzeptiert_normalen_pfad(self):
        api = load_api_module()
        self.assertEqual(api._clean_dav_segment("Ordner/Datei.txt", field="test"), "Ordner/Datei.txt")
        self.assertEqual(api._clean_dav_segment("/Ordner/", field="test"), "Ordner")


if __name__ == "__main__":
    unittest.main()
