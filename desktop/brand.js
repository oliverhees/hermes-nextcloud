/**
 * AIIANER-Designtoken, Kopiervorlage fuer alle AIIANER-Hermes-Plugins.
 *
 * WICHTIG: diese Datei wird von plugin.js NICHT importiert. Hermes laedt
 * jedes plugin.js als EINE Datei ueber eine Blob-URL (kein Mehrdatei-
 * Bundling) - ein relativer Import wuerde zur Laufzeit fehlschlagen. Diese
 * Datei ist nur eine Referenz/Kopiervorlage; das tatsaechlich genutzte
 * BRAND-Objekt steht inline am Kopf von plugin.js. Beide synchron halten,
 * falls sich Marke/URL aendert.
 *
 * Branding-Stufe T2 (Oliver-Entscheidung 17.09.2026): dezenter Footer +
 * Akzentfarbe in den eigenen Dashboard-Tabs, NICHT in Hermes-nativen
 * Chrome-Bereichen (Statusbar/Popover) - dort bleibt ausschliesslich
 * Hermes' eigenes Theme sichtbar. Rollout auf andere AIIANER-Plugins folgt
 * erst nach diesem Pilot.
 *
 * Nur ein Textmarkenzeichen, kein Bild-Asset - kein Netzwerk-Request, kein
 * Bundling-Aufwand, funktioniert unveraendert in jedem Hermes-Theme.
 */

export const BRAND = {
  url: 'https://aiianer.de',
  name: 'AIIANER',
  tagline: 'KI zum Anwenden, nicht zum Hypen.'
}
