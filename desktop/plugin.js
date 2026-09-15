/**
 * hermes-nextcloud - Desktop-Fassung.
 *
 * ADHS-konformer Aufgabenplaner. Ein Bildschirm, eine Entscheidung: die
 * Fokusansicht zeigt GENAU EINE Aufgabe, nie die Liste. Die Tagesuebersicht
 * mischt Aufgaben und Nextcloud-Termine auf eine Zeitachse - ohne Rot, ohne
 * Mahnton, denn Schuld senkt bei ADHS die Adhaerenz.
 *
 * Reines ESM, wird uncompiliert geladen: keine JSX-Syntax, nur jsx()/jsxs().
 * Nur drei Importe sind aufloesbar (@hermes/plugin-sdk, react,
 * react/jsx-runtime). Farben ausschliesslich ueber var(--ui-*), sonst bricht
 * jeder Theme-Wechsel.
 *
 * Backend: ~/.hermes/plugins/hermes-nextcloud/dashboard/plugin_api.py
 * ctx.rest() zeigt automatisch auf /api/plugins/hermes-nextcloud/.
 */

import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  host,
  haptic,
  atom,
  useValue,
  Button,
  Input,
  Textarea,
  EmptyState,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA
} from '@hermes/plugin-sdk'

const ID = 'hermes-nextcloud'
const ROUTE = '/hermes-nextcloud'
const STORAGE_REMINDER_KEY = 'reminderMinutes'
const STORAGE_TAB_KEY = 'lastTab'
const STORAGE_ADHS_KEY = 'adhsMode'
const DEFAULT_REMINDER_MINUTES = 50
const REMINDER_POLL_MS = 5 * 60 * 1000
const DEFER_MINUTES = 60

// Geteilt zwischen Route und Statusleiste: die Leiste darf nicht selbst
// pollen, sonst laufen zwei Zaehler gegen dasselbe Backend.
const $inbox = atom(0)
const $ready = atom({ ready: true, reason: '' })

// ---------------------------------------------------------------- Backend

/**
 * ctx.rest mit Objekt-Body braucht den Content-Type ausdruecklich; ohne ihn
 * kommt der Body als Text an und FastAPI antwortet mit 422.
 */
function makeApi(ctx) {
  const call = (path, method, body) => {
    const options = { method }
    if (body !== undefined) {
      options.body = body
      options.headers = { 'Content-Type': 'application/json' }
    }
    return ctx.rest(path, options)
  }
  return {
    status: () => call('/status', 'GET'),
    getSettings: () => call('/settings', 'GET'),
    saveSettings: (host, username, appPassword, calendarName) =>
      call('/settings', 'POST', { host, username, appPassword, calendarName }),
    // Zweites Argument optional: { due: 'YYYY-MM-DD' } fuers '+ Aufgabe an
    // diesem Tag' aus dem Kalender. Weggelassen bleibt das Verhalten wie vorher.
    capture: (title, opts) =>
      call('/capture', 'POST', { title, due: opts && opts.due ? opts.due : undefined }),
    focus: () => call('/focus', 'GET'),
    complete: uid => call('/focus/complete', 'POST', { uid }),
    defer: uid => call('/focus/defer', 'POST', { uid, minutes: DEFER_MINUTES }),
    breakdown: (uid, steps) => call('/focus/breakdown', 'POST', { uid, steps }),
    // Ohne Datum bleibt es der heutige Tag - die Tagesuebersicht ruft weiter
    // genau so auf wie vorher.
    day: dateStr => call(dateStr ? `/day?date=${dateStr}` : '/day', 'GET'),
    month: (year, monthNum) => call(`/month?year=${year}&month=${monthNum}`, 'GET'),
    week: startDateStr => call(`/week?start=${startDateStr}`, 'GET'),
    progress: () => call('/progress', 'GET'),
    listCalendars: () => call('/calendars', 'GET'),
    createEvent: (title, calendarName, start, end, allDay) =>
      call('/events', 'POST', { title, calendarName, start, end, allDay }),
    moveEvent: (uid, calendarName, start, end, allDay) =>
      call('/events/move', 'POST', { uid, calendarName, start, end, allDay }),
    setTaskDue: (uid, due) => call('/tasks/due', 'POST', { uid, due }),
    unscheduled: () => call('/unscheduled', 'GET'),
    reminder: intervalMinutes =>
      call('/reminder/check', 'POST', { intervalMinutes }),
    notesList: () => call('/notes', 'GET'),
    noteGet: id => call(`/notes/${id}`, 'GET'),
    noteCreate: (title, content) => call('/notes', 'POST', { title, content }),
    noteUpdate: (id, patch) => call(`/notes/${id}`, 'PUT', patch),
    noteDelete: id => call(`/notes/${id}`, 'DELETE'),
    deckBoards: () => call('/deck/boards', 'GET'),
    deckBoard: id => call(`/deck/boards/${id}`, 'GET'),
    contacts: () => call('/contacts', 'GET'),
    files: path => call(`/files?path=${encodeURIComponent(path || '')}`, 'GET')
  }
}

function describeError(error) {
  const detail = error && error.detail
  if (typeof detail === 'string' && detail) return detail
  const message = error && error.message
  if (typeof message === 'string' && message) return message
  return 'Unbekannter Fehler beim Zugriff auf das Fokus-Backend.'
}

// ---------------------------------------------------------------- Formate

function clockOf(iso) {
  if (!iso) return '—'
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'
  return value.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function durationOf(item) {
  if (!item.start || !item.end) return ''
  const from = new Date(item.start).getTime()
  const to = new Date(item.end).getTime()
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return ''
  return `· ${Math.round((to - from) / 60000)} Min`
}

// ---------------------------------------------------------------- Feier
//
// Dopamin auf Knopfdruck: erledigen darf sich kurz gut anfuehlen. Alles hier
// ist reiner Code - Canvas, CSS, Emoji, keine Bild-Assets.

const CHEERS = [
  'Boom, erledigt.',
  'Nächste.',
  'Sauber.',
  'Das war’s schon?',
  'Weiter im Text.',
  'Punkt gemacht.',
  'Abgehakt.',
  'Läuft.',
  'Einen weniger.',
  'Zack.',
  'Schon durch.',
  'Weg damit.',
  'Erledigt ist erledigt.'
]

function pickCheer() {
  return CHEERS[Math.floor(Math.random() * CHEERS.length)]
}

function prefersReducedMotion() {
  try {
    return Boolean(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch (error) {
    return false
  }
}

// Canvas versteht kein var(--…), deshalb werden die Theme-Tokens einmal
// ausgelesen statt Farben hart einzutragen. Buntheit ist zweitrangig; passend
// zum aktiven Theme zu bleiben ist wichtiger.
const CONFETTI_TOKENS = [
  '--ui-accent',
  '--ui-text-primary',
  '--ui-text-secondary',
  '--ui-text-tertiary'
]

function confettiPalette() {
  try {
    const computed = getComputedStyle(document.documentElement)
    const tokens = CONFETTI_TOKENS.map(name =>
      String(computed.getPropertyValue(name) || '').trim()
    ).filter(Boolean)
    if (tokens.length) return tokens
    const fallback = String(getComputedStyle(document.body).color || '').trim()
    return fallback ? [fallback] : []
  } catch (error) {
    return []
  }
}

/**
 * Wirft kurz Partikel ueber den Bildschirm und raeumt sich selbst wieder auf.
 * Gibt eine Abbruch-Funktion zurueck, damit ein Unmount oder eine schnelle
 * zweite Feier kein Canvas zuruecklaesst.
 *
 * Bei prefers-reduced-motion passiert hier gar nichts - der Erfolgs-Hinweis
 * erscheint dann nur als statischer Text.
 */
function celebrate(count, durationMs) {
  if (typeof document === 'undefined' || !document.body) return () => {}
  if (prefersReducedMotion()) return () => {}
  const colors = confettiPalette()
  if (!colors.length) return () => {}

  const width = window.innerWidth
  const height = window.innerHeight
  if (!width || !height) return () => {}
  const ratio = window.devicePixelRatio || 1

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  canvas.style.position = 'fixed'
  canvas.style.left = '0'
  canvas.style.top = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.pointerEvents = 'none'
  canvas.style.zIndex = '2147483000'

  const paint = canvas.getContext('2d')
  if (!paint) return () => {}
  document.body.appendChild(canvas)
  paint.scale(ratio, ratio)

  const originX = width / 2
  const originY = height * 0.45
  const parts = []
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2
    const speed = 240 + Math.random() * 340
    parts.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 5,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 14,
      color: colors[i % colors.length]
    })
  }

  let frameId = 0
  let stopped = false
  const startedAt = performance.now()
  let previous = startedAt

  const cleanup = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frameId)
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
  }

  const frame = now => {
    if (stopped) return
    const elapsed = now - startedAt
    if (elapsed >= durationMs) {
      cleanup()
      return
    }
    // Gedeckelt, damit ein Tab-Wechsel (langer Frame-Abstand) die Partikel
    // nicht in einem Sprung aus dem Bild schiesst.
    const step = Math.min((now - previous) / 1000, 0.05)
    previous = now

    paint.clearRect(0, 0, width, height)
    paint.globalAlpha = Math.max(0, 1 - elapsed / durationMs)
    for (const part of parts) {
      part.vy += 900 * step
      part.x += part.vx * step
      part.y += part.vy * step
      part.rotation += part.spin * step
      paint.save()
      paint.translate(part.x, part.y)
      paint.rotate(part.rotation)
      paint.fillStyle = part.color
      paint.fillRect(-part.size / 2, -part.size / 2, part.size, part.size * 0.62)
      paint.restore()
    }
    frameId = requestAnimationFrame(frame)
  }

  frameId = requestAnimationFrame(frame)
  return cleanup
}

function tapHaptic() {
  // Feature-Detect wie bei ctx.onDispose: aeltere Hermes-Fassungen kennen den
  // Helfer noch nicht, und ein fehlendes Rueckmeldungs-Detail darf das
  // Erledigen nicht abbrechen.
  if (typeof haptic === 'function') haptic('tap')
}

/**
 * Die komplette Feier als Hook, damit jede Stelle, an der etwas erledigt
 * werden kann, dieselbe bekommt. Zwei Kopien wuerden sofort auseinanderlaufen -
 * und ein Erledigt-Knopf, der mal feiert und mal nicht, ist schlimmer als
 * einer, der nie feiert.
 *
 * Timer und Canvas haengen an einem Cleanup, sonst tickt nach einem
 * Tab-Wechsel ein Timer gegen eine verschwundene Komponente.
 */
function useCelebration() {
  const [cheer, setCheer] = useState(null)
  const confettiRef = useRef(null)

  useEffect(() => {
    if (!cheer) return undefined
    const timer = setTimeout(() => setCheer(null), 2200)
    return () => clearTimeout(timer)
  }, [cheer])

  useEffect(
    () => () => {
      if (confettiRef.current) confettiRef.current()
    },
    []
  )

  const announce = reward => {
    if (!reward || typeof reward.xpGained !== 'number') return
    const leveledUp = Boolean(reward.leveledUp)
    if (confettiRef.current) confettiRef.current()
    confettiRef.current = celebrate(leveledUp ? 70 : 32, leveledUp ? 1500 : 1150)
    setCheer({
      text: leveledUp ? `Level ${reward.level}` : pickCheer(),
      xp: reward.xpGained,
      leveledUp
    })
    const unlocked = Array.isArray(reward.unlockedAchievements)
      ? reward.unlockedAchievements
      : []
    for (const item of unlocked) {
      // In-App-Toast, nicht ctx.os.notify: die native Meldung bleibt der
      // sanften Erinnerung vorbehalten und wird nicht mit Erfolgen verwaessert.
      host.notify({
        kind: 'success',
        title: 'Erfolg freigeschaltet',
        message: item.title
      })
    }
  }

  return { cheer, announce }
}

/** Der Spruch-Toast. Der umgebende Container braucht position: relative. */
function CelebrationToast({ cheer }) {
  if (!cheer) return null
  return jsxs('div', {
    style: {
      position: 'absolute',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 2,
      display: 'flex',
      alignItems: 'baseline',
      gap: '10px',
      borderRadius: '999px',
      border: '1px solid var(--ui-accent)',
      padding: cheer.leveledUp ? '10px 20px' : '7px 16px',
      background: 'var(--ui-bg-secondary)',
      pointerEvents: 'none'
    },
    children: [
      jsx('span', {
        style: {
          fontSize: cheer.leveledUp ? '1.05rem' : '0.86rem',
          fontWeight: 800,
          color: 'var(--ui-text-primary)'
        },
        children: cheer.leveledUp ? `🎉 ${cheer.text}` : cheer.text
      }),
      jsx('span', {
        style: {
          fontSize: '0.78rem',
          fontWeight: 700,
          color: 'var(--ui-accent)'
        },
        children: `+${cheer.xp} XP`
      })
    ]
  })
}

/**
 * Sicherheitsnetz statt Bestaetigungsdialog: nach jedem Verschieben (Aufgabe
 * ODER Termin) 6 Sekunden lang "Verschoben — Rückgängig" einblenden. Bei
 * Terminen ist das PFLICHT (echte Nextcloud-Daten), bei Aufgaben dieselbe
 * Komponente aus Konsistenzgruenden. Neutraler Ton, kein Konfetti - das ist
 * keine Feier, das ist ein Ruecknahme-Fenster.
 */
function useMoveNotice() {
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const announceMove = (label, undo) => {
    setNotice({ label, undo })
  }

  const dismiss = () => setNotice(null)

  return { notice, announceMove, dismiss }
}

function MoveToast({ notice, onUndo }) {
  if (!notice) return null
  return jsxs('div', {
    style: {
      position: 'absolute',
      bottom: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 2,
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      borderRadius: '999px',
      border: '1px solid var(--ui-stroke-secondary)',
      padding: '7px 8px 7px 16px',
      background: 'var(--ui-bg-secondary)',
      fontSize: '0.8rem',
      color: 'var(--ui-text-secondary)'
    },
    children: [
      jsx('span', { children: notice.label }),
      jsx('button', {
        type: 'button',
        onClick: () => onUndo(notice),
        style: {
          font: 'inherit',
          fontWeight: 700,
          fontSize: '0.78rem',
          color: 'var(--ui-accent)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 8px'
        },
        children: 'Rückgängig'
      })
    ]
  })
}

const DND_TASK = 'application/x-hermes-task'
const DND_EVENT = 'application/x-hermes-event'

// ---------------------------------------------------------------- Bausteine

function Notice({ tone, children }) {
  // Auch der Fehlerton bleibt neutral: Rot ist im ganzen Plugin fuer nichts
  // reserviert, damit "liegen geblieben" nie wie "du hast versagt" aussieht.
  return jsx('div', {
    style: {
      borderRadius: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      padding: '10px 12px',
      fontSize: '0.82rem',
      color: tone === 'quiet' ? 'var(--ui-text-tertiary)' : 'var(--ui-text-secondary)'
    },
    children
  })
}

function CaptureBar({ onCapture, busy }) {
  const [text, setText] = useState('')
  const inputRef = useRef(null)

  // ISC-21: beim Oeffnen liegt der Fokus schon im Feld. Ein zusaetzlicher
  // Klick ist bei ADHS-Erfassung genau die Reibung, die den Gedanken kostet.
  useEffect(() => {
    const node = inputRef.current
    if (node && typeof node.focus === 'function') node.focus()
  }, [])

  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    onCapture(value)
  }

  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '12px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)'
    },
    children: [
      jsx(Input, {
        // Doppelt abgesichert: leitet das UI-Kit den ref nicht weiter, setzt
        // autoFocus den Fokus trotzdem. ISC-21 darf an einer Kit-Interna nicht
        // scheitern.
        ref: inputRef,
        autoFocus: true,
        value: text,
        placeholder: 'Was auch immer dir gerade durch den Kopf geht…',
        onChange: event => setText(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        },
        style: { flex: 1 }
      }),
      jsx(Button, {
        onClick: submit,
        disabled: busy || !text.trim(),
        children: 'Erfassen'
      })
    ]
  })
}

function SetupView({ api, onDone }) {
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hostRef = useRef(null)

  // Kein Zwang, dem Kalender hinterherzuklicken: Fokus liegt sofort im ersten
  // Feld, genau wie in der Capture-Bar (ISC-21-Prinzip auch hier).
  useEffect(() => {
    const node = hostRef.current
    if (node && typeof node.focus === 'function') node.focus()
  }, [])

  const submit = () => {
    if (busy) return
    const h = host.trim()
    const u = username.trim()
    const p = password.trim()
    if (!h || !u || !p) {
      setError('Host, Benutzername und App-Passwort werden gebraucht.')
      return
    }
    setBusy(true)
    setError('')
    api
      .saveSettings(h, u, p)
      .then(() => {
        setPassword('')
        onDone()
      })
      .catch(err => setError(describeError(err)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  const onEnter = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return jsxs('div', {
    style: {
      maxWidth: '380px',
      margin: '0 auto',
      padding: '32px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px'
    },
    children: [
      jsx('div', {
        style: { fontSize: '1.05rem', fontWeight: 700, color: 'var(--ui-text-primary)' },
        children: 'Mit Nextcloud verbinden'
      }),
      jsx('div', {
        style: { fontSize: '0.8rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 },
        children:
          'Nextcloud bleibt die alleinige Wahrheit für Aufgaben und Termine. Die Zugangsdaten landen lokal in einer eigenen Datei — niemals in Hermes’ eigener config.yaml.'
      }),
      jsx(Input, {
        ref: hostRef,
        autoFocus: true,
        value: host,
        placeholder: 'Nextcloud-Host, z. B. cloud.deine-domain.de',
        onChange: event => setHost(event.target.value),
        onKeyDown: onEnter
      }),
      jsx(Input, {
        value: username,
        placeholder: 'Nextcloud-Benutzername',
        onChange: event => setUsername(event.target.value),
        onKeyDown: onEnter
      }),
      jsx(Input, {
        type: 'password',
        value: password,
        placeholder: 'App-Passwort (nicht dein normales Passwort)',
        onChange: event => setPassword(event.target.value),
        onKeyDown: onEnter
      }),
      error ? jsx(Notice, { tone: 'quiet', children: error }) : null,
      jsx(Button, {
        onClick: submit,
        disabled: busy,
        children: busy ? 'Verbinde…' : 'Verbinden'
      }),
      jsx('div', {
        style: { fontSize: '0.72rem', color: 'var(--ui-text-quaternary)' },
        children:
          'App-Passwort erzeugen: Nextcloud → Einstellungen → Sicherheit → Neues App-Passwort. Wird sofort getestet, bevor irgendetwas gespeichert wird.'
      })
    ]
  })
}

const ADHS_TABS = [
  ['fokus', 'Fokus'],
  ['tag', 'Tagesübersicht'],
  ['fortschritt', 'Fortschritt'],
  ['kalender', 'Kalender'],
  ['notizen', 'Notizen'],
  ['deck', 'Deck'],
  ['kontakte', 'Kontakte'],
  ['dateien', 'Dateien']
]

const PLAIN_TABS = [
  ['kalender', 'Kalender'],
  ['notizen', 'Notizen'],
  ['deck', 'Deck'],
  ['kontakte', 'Kontakte'],
  ['dateien', 'Dateien']
]

function Tabs({ value, onChange, adhsMode, onToggleSettings, settingsOpen }) {
  const entries = adhsMode ? ADHS_TABS : PLAIN_TABS
  const tab = (key, label) =>
    jsx('button', {
      type: 'button',
      onClick: () => onChange(key),
      style: {
        font: 'inherit',
        fontWeight: 600,
        fontSize: '0.82rem',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 12px 10px',
        color: value === key ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
        borderBottom:
          value === key ? '2px solid var(--ui-accent)' : '2px solid transparent'
      },
      children: label
    }, key)

  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      padding: '8px 16px 0',
      borderBottom: '1px solid var(--ui-stroke-secondary)'
    },
    children: [
      ...entries.map(([key, label]) => tab(key, label)),
      jsx('div', { style: { flex: 1 } }),
      jsx('button', {
        type: 'button',
        onClick: onToggleSettings,
        title: 'Einstellungen',
        style: {
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '6px 10px',
          fontSize: '0.9rem',
          color: settingsOpen ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'
        },
        children: '⚙'
      })
    ]
  })
}

function SettingsPanel({ adhsMode, onChangeAdhsMode }) {
  return jsxs('div', {
    style: {
      padding: '12px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px'
    },
    children: [
      jsxs('label', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '0.84rem',
          color: 'var(--ui-text-primary)',
          cursor: 'pointer'
        },
        children: [
          jsx('input', {
            type: 'checkbox',
            checked: adhsMode,
            onChange: event => onChangeAdhsMode(event.target.checked)
          }),
          'ADHS-Fokus-Modus'
        ]
      }),
      jsx('div', {
        style: { fontSize: '0.74rem', color: 'var(--ui-text-tertiary)' },
        children:
          'Fügt Fokus- und Fortschritts-Tab hinzu: eine Aufgabe statt Liste, Brain-Dump-Erfassung, Gamification. Ausgeschaltet bleibt es beim reinen Nextcloud-Überblick.'
      })
    ]
  })
}

function FokusView({ api, state, reload, setError }) {
  const [breaking, setBreaking] = useState(false)
  const [steps, setSteps] = useState('')
  const [busy, setBusy] = useState(false)
  const { cheer, announce } = useCelebration()
  const task = state.task

  useEffect(() => {
    setBreaking(false)
    setSteps('')
  }, [task && task.uid])

  const act = fn => {
    if (busy) return
    setBusy(true)
    Promise.resolve()
      .then(fn)
      .then(() => reload())
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  const complete = () => {
    if (busy) return
    tapHaptic()
    setBusy(true)
    api
      .complete(task.uid)
      .then(result => {
        announce(result && result.gamification)
        return reload()
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  if (!task) {
    return jsx('div', {
      style: { padding: '48px 24px' },
      children: jsx(EmptyState, {
        title: 'Nichts Offenes — gut gemacht.',
        description: 'Der Eingang ist leer. Neue Gedanken oben einfach eintippen.'
      })
    })
  }

  return jsxs('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '18px',
      padding: '28px 24px',
      textAlign: 'center',
      minHeight: '100%',
      position: 'relative'
    },
    children: [
      jsx(CelebrationToast, { cheer }),
      jsx('div', {
        style: {
          fontSize: '0.68rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ui-text-tertiary)'
        },
        children: 'Nächster Schritt'
      }),
      jsxs('div', {
        style: {
          maxWidth: '420px',
          width: '100%',
          border: '1px solid var(--ui-accent)',
          borderRadius: '16px',
          padding: '26px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        },
        children: [
          jsx('div', {
            style: {
              fontSize: '1.28rem',
              fontWeight: 800,
              lineHeight: 1.25,
              color: 'var(--ui-text-primary)'
            },
            children: task.title
          }),
          jsx('div', {
            style: { fontSize: '0.78rem', color: 'var(--ui-text-tertiary)' },
            children: task.due ? `fällig ${clockOf(task.due)}` : 'ohne festen Termin'
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', gap: '8px', maxWidth: '420px', width: '100%' },
        children: [
          jsx(Button, {
            onClick: complete,
            disabled: busy,
            style: { flex: 1 },
            children: 'Erledigt'
          }),
          jsx(Button, {
            variant: 'ghost',
            onClick: () => setBreaking(current => !current),
            disabled: busy,
            style: { flex: 1 },
            children: 'Zerlegen'
          }),
          jsx(Button, {
            variant: 'ghost',
            onClick: () => act(() => api.defer(task.uid)),
            disabled: busy,
            style: { flex: 1 },
            children: 'Später'
          })
        ]
      }),
      breaking
        ? jsxs('div', {
            style: {
              maxWidth: '420px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              textAlign: 'left'
            },
            children: [
              jsx(Textarea, {
                value: steps,
                rows: 4,
                placeholder: 'Ein Teilschritt pro Zeile…',
                onChange: event => setSteps(event.target.value)
              }),
              jsx(Button, {
                onClick: () =>
                  act(() =>
                    api.breakdown(task.uid, steps).then(() => setBreaking(false))
                  ),
                disabled: busy || !steps.trim(),
                children: 'Teilschritte merken'
              })
            ]
          })
        : null,
      task.subtasks && task.subtasks.length
        ? jsx('div', {
            style: {
              maxWidth: '420px',
              width: '100%',
              textAlign: 'left',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: '10px',
              padding: '10px 12px',
              fontSize: '0.8rem',
              color: 'var(--ui-text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            },
            children: task.subtasks.map((step, index) =>
              jsxs('div', {
                style: { display: 'flex', gap: '8px' },
                children: [
                  jsx('span', {
                    style: { color: 'var(--ui-text-quaternary)' },
                    children: String(index + 1)
                  }),
                  jsx('span', { children: step })
                ]
              }, `${index}-${step}`)
            )
          })
        : null,
      jsx('div', {
        style: { fontSize: '0.74rem', color: 'var(--ui-text-tertiary)' },
        children:
          state.inbox > 1
            ? `noch ${state.inbox - 1} im Eingang — bleiben unsichtbar, bis du hier bist`
            : 'nichts weiter im Eingang'
      })
    ]
  })
}

function TagView({ items, date, loading }) {
  if (loading) {
    return jsx('div', {
      style: { padding: '24px', color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' },
      children: 'Tag wird geladen…'
    })
  }
  if (!items.length) {
    return jsx('div', {
      style: { padding: '48px 24px' },
      children: jsx(EmptyState, {
        title: 'Heute ist nichts eingetragen.',
        description: 'Weder Aufgaben im Eingang noch Termine im Kalender.'
      })
    })
  }

  return jsxs('div', {
    style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '2px' },
    children: [
      jsx('div', {
        style: { fontWeight: 700, fontSize: '0.95rem', marginBottom: '10px' },
        children: date
          ? new Date(date).toLocaleDateString('de-DE', {
              weekday: 'long',
              day: 'numeric',
              month: 'long'
            })
          : 'Heute'
      }),
      ...items.map(item =>
        jsxs('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '56px 1fr',
            gap: '0 12px',
            alignItems: 'baseline',
            padding: '6px 0'
          },
          children: [
            jsx('div', {
              style: {
                fontSize: '0.72rem',
                color: 'var(--ui-text-quaternary)',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums'
              },
              children: clockOf(item.start)
            }),
            jsxs('div', {
              style: {
                display: 'inline-flex',
                gap: '8px',
                alignItems: 'baseline',
                borderRadius: '9px',
                padding: '8px 11px',
                border: `1px solid ${
                  item.kind === 'task' ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'
                }`,
                fontSize: '0.82rem',
                color: 'var(--ui-text-primary)'
              },
              children: [
                jsx('span', { children: item.title }),
                jsx('span', {
                  style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)' },
                  children: [
                    item.kind === 'event' ? 'Termin' : 'Aufgabe',
                    durationOf(item),
                    item.calendar ? `· ${item.calendar}` : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                })
              ]
            })
          ]
        }, `${item.kind}-${item.uid || item.title}-${item.start || ''}`)
      )
    ]
  })
}

function Kachel({ label, value, hint }) {
  return jsxs('div', {
    style: {
      flex: 1,
      minWidth: '130px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '12px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px'
    },
    children: [
      jsx('div', {
        style: {
          fontSize: '0.68rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--ui-text-tertiary)'
        },
        children: label
      }),
      jsx('div', {
        style: { fontSize: '1.1rem', fontWeight: 800, color: 'var(--ui-text-primary)' },
        children: value
      }),
      hint
        ? jsx('div', {
            style: { fontSize: '0.72rem', color: 'var(--ui-text-quaternary)' },
            children: hint
          })
        : null
    ]
  })
}

function ProgressView({ data, loading }) {
  if (loading || !data) {
    return jsx('div', {
      style: { padding: '24px', color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' },
      children: 'Fortschritt wird geladen…'
    })
  }

  const forNext = data.xpForNextLevel > 0 ? data.xpForNextLevel : 1
  const filled = Math.max(0, Math.min(100, (data.xpIntoLevel / forNext) * 100))
  const achievements = Array.isArray(data.achievements) ? data.achievements : []

  return jsxs('div', {
    style: {
      padding: '20px 16px 28px',
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      maxWidth: '620px',
      margin: '0 auto'
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '10px' },
            children: [
              jsx('div', {
                style: {
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  lineHeight: 1.1,
                  color: 'var(--ui-text-primary)'
                },
                children: `Level ${data.level}`
              }),
              jsx('div', {
                style: { fontSize: '0.78rem', color: 'var(--ui-text-tertiary)' },
                children: `${data.xpIntoLevel} / ${data.xpForNextLevel} XP`
              })
            ]
          }),
          jsx('div', {
            style: {
              height: '10px',
              borderRadius: '999px',
              background: 'var(--ui-stroke-secondary)',
              overflow: 'hidden'
            },
            children: jsx('div', {
              style: {
                width: `${filled}%`,
                height: '100%',
                background: 'var(--ui-accent)',
                transition: 'width 320ms ease'
              }
            })
          }),
          jsx('div', {
            style: { fontSize: '0.74rem', color: 'var(--ui-text-quaternary)' },
            children: `${data.xp} XP insgesamt`
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
        children: [
          jsx(Kachel, {
            label: 'Streak',
            // Kein "verloren", kein "unterbrochen": ein ausgelassener Tag ist
            // neutral. Bei 0 steht hier eine Einladung, kein Vorwurf.
            value: data.streak > 0 ? `🔥 ${data.streak} Tage` : 'Heute noch nichts erledigt',
            hint:
              data.streak > 0
                ? `Bester Streak: ${data.bestStreak} Tage`
                : data.bestStreak > 0
                  ? `Leg los — bester Streak bisher: ${data.bestStreak} Tage`
                  : 'Leg los'
          }),
          jsx(Kachel, {
            label: 'Heute erledigt',
            value: String(data.todayCount)
          }),
          jsx(Kachel, {
            label: 'Insgesamt',
            value: String(data.completedTotal)
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        children: [
          jsx('div', {
            style: {
              fontSize: '0.68rem',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary)'
            },
            children: 'Erfolge'
          }),
          jsx('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '10px'
            },
            // Gesperrte Erfolge bleiben lesbar: wer weiss, wonach er greift,
            // kann danach greifen. Raten waere Reibung, keine Motivation.
            children: achievements.map(item =>
              jsxs('div', {
                style: {
                  border: `1px solid ${
                    item.unlocked ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'
                  }`,
                  borderRadius: '12px',
                  padding: '11px 13px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  opacity: item.unlocked ? 1 : 0.4
                },
                children: [
                  jsx('div', {
                    style: {
                      fontSize: '0.86rem',
                      fontWeight: 700,
                      color: 'var(--ui-text-primary)'
                    },
                    children: item.unlocked ? `🏆 ${item.title}` : item.title
                  }),
                  jsx('div', {
                    style: { fontSize: '0.75rem', color: 'var(--ui-text-tertiary)' },
                    children: item.description
                  })
                ]
              }, item.id)
            )
          })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------- Kalender

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const EMPTY_DAY = { tasksOpen: 0, tasksCompleted: 0, events: 0 }

function pad2(value) {
  return String(value).padStart(2, '0')
}

function dayKeyOf(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function plural(count, one, many) {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** Ganztaegiges hat keine Uhrzeit - eine zu erfinden waere schlimmer als keine. */
function whenLabel(item) {
  if (!item || !item.start) return ''
  if (item.allDay) return 'ganztägig'
  return clockOf(item.start)
}

function monthTitle(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString('de-DE', {
    month: 'long',
    year: 'numeric'
  })
}

function longDate(key) {
  const parts = String(key || '').split('-')
  if (parts.length !== 3) return ''
  return new Date(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2])
  ).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
}

function NavButton({ label, title, onClick }) {
  return jsx('button', {
    type: 'button',
    onClick,
    title,
    style: {
      font: 'inherit',
      fontSize: '0.82rem',
      background: 'none',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '8px',
      cursor: 'pointer',
      padding: '4px 10px',
      color: 'var(--ui-text-secondary)'
    },
    children: label
  })
}

function MonthGrid({ year, month, days, loading, onPick, onDropTask }) {
  const first = new Date(year, month - 1, 1)
  // getDay() zaehlt ab Sonntag, das Raster beginnt am Montag.
  const lead = (first.getDay() + 6) % 7
  const total = new Date(year, month, 0).getDate()
  const trail = (7 - ((lead + total) % 7)) % 7

  const now = new Date()
  const todayKey = dayKeyOf(now.getFullYear(), now.getMonth() + 1, now.getDate())

  const cells = []
  for (let i = 0; i < lead; i += 1) {
    cells.push(jsx('div', { style: { minHeight: '92px' } }, `lead-${i}`))
  }
  for (let day = 1; day <= total; day += 1) {
    const key = dayKeyOf(year, month, day)
    const entry = days[key] || EMPTY_DAY
    const isToday = key === todayKey
    const parts = []
    if (entry.tasksOpen > 0) parts.push(plural(entry.tasksOpen, 'Aufgabe', 'Aufgaben'))
    if (entry.events > 0) parts.push(plural(entry.events, 'Termin', 'Termine'))

    cells.push(
      jsxs('button', {
        type: 'button',
        onClick: () => onPick(key),
        onDragOver: event => event.preventDefault(),
        onDrop: event => {
          event.preventDefault()
          const taskPayload = event.dataTransfer.getData(DND_TASK)
          if (taskPayload) {
            const parsed = JSON.parse(taskPayload)
            onDropTask(parsed.uid, key, parsed.due)
          }
        },
        style: {
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'none',
          border: `1px solid ${
            isToday ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'
          }`,
          borderRadius: '10px',
          padding: '9px 10px',
          minHeight: '92px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '5px' },
            children: [
              jsx('span', {
                style: {
                  fontSize: '0.82rem',
                  fontWeight: isToday ? 800 : 600,
                  color: 'var(--ui-text-primary)',
                  fontVariantNumeric: 'tabular-nums'
                },
                children: String(day)
              }),
              // Der Gamification-Anker im Raster: ein Punkt, kein Balken. Das
              // Raster muss scanbar bleiben, sonst ist es kein Ueberblick mehr.
              entry.tasksCompleted > 0
                ? jsx('span', {
                    title: `${plural(entry.tasksCompleted, 'Aufgabe', 'Aufgaben')} erledigt`,
                    style: {
                      width: '5px',
                      height: '5px',
                      borderRadius: '999px',
                      background: 'var(--ui-accent)'
                    }
                  })
                : null
            ]
          }),
          // Ein leerer Tag zeigt nur seine Zahl. Ruhe ist hier Absicht.
          parts.length
            ? jsx('div', {
                style: {
                  fontSize: '0.68rem',
                  lineHeight: 1.3,
                  color: 'var(--ui-text-tertiary)'
                },
                children: parts.join(' · ')
              })
            : null
        ]
      }, key)
    )
  }
  for (let i = 0; i < trail; i += 1) {
    cells.push(jsx('div', { style: { minHeight: '92px' } }, `trail-${i}`))
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    children: [
      jsx('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '6px'
        },
        children: WEEKDAYS.map(name =>
          jsx('div', {
            style: {
              fontSize: '0.68rem',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary)',
              padding: '0 2px'
            },
            children: name
          }, name)
        )
      }),
      jsx('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '6px',
          opacity: loading ? 0.5 : 1,
          transition: 'opacity 160ms ease'
        },
        children: cells
      })
    ]
  })
}

function DayRow({ title, meta, action }) {
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '10px',
      padding: '9px 11px'
    },
    children: [
      jsxs('div', {
        style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
        children: [
          jsx('div', {
            style: { fontSize: '0.86rem', color: 'var(--ui-text-primary)' },
            children: title
          }),
          meta
            ? jsx('div', {
                style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)' },
                children: meta
              })
            : null
        ]
      }),
      action
    ]
  })
}

function DaySection({ label, children }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '8px' },
    children: [
      jsx('div', {
        style: {
          fontSize: '0.68rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--ui-text-tertiary)'
        },
        children: label
      }),
      ...children
    ]
  })
}

function weekStartOf(dateKey) {
  const parts = String(dateKey || '').split('-').map(Number)
  const base = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date()
  const mondayOffset = (base.getDay() + 6) % 7
  base.setDate(base.getDate() - mondayOffset)
  return dayKeyOf(base.getFullYear(), base.getMonth() + 1, base.getDate())
}

function addDaysToKey(dateKey, delta) {
  const parts = String(dateKey || '').split('-').map(Number)
  const base = new Date(parts[0], parts[1] - 1, parts[2])
  base.setDate(base.getDate() + delta)
  return dayKeyOf(base.getFullYear(), base.getMonth() + 1, base.getDate())
}

function weekRangeTitle(startKey) {
  const start = new Date(...String(startKey).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const fmt = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
  return `${fmt(start)} – ${fmt(end)}`
}

function hourOf(iso) {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return null
  return value.getHours() + value.getMinutes() / 60
}

// Stundenraster 06:00-22:00, wie im Vorbild - deckt den ueberwiegenden Teil
// eines Tages ab, ohne die Spalte auf 24 Reihen zu strecken.
const WEEK_HOUR_START = 6
const WEEK_HOUR_END = 22
const WEEK_HOUR_PX = 48

/** Zieht aus einem ISO-Zeitpunkt + Datumsschluessel ein neues ISO fuer eine
 * andere Stunde - fuers vertikale Draggen in der Wochenansicht. */
function withHour(dateKey, hourFloat) {
  const parts = String(dateKey).split('-').map(Number)
  const h = Math.floor(hourFloat)
  const m = Math.round((hourFloat - h) * 60)
  const d = new Date(parts[0], parts[1] - 1, parts[2], h, m, 0, 0)
  return d.toISOString()
}

function shiftIso(iso, deltaMs) {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return iso
  return new Date(value.getTime() + deltaMs).toISOString()
}

/**
 * "Ungeplante Aufgaben" - Aufgaben ohne Faelligkeit tauchen sonst NIRGENDS im
 * Kalender auf. Jede Zeile ist der Startpunkt eines Drags: raus aus der
 * Liste, rein auf einen Tag.
 */
function UnscheduledPanel({ tasks, loading }) {
  return jsxs('div', {
    style: {
      width: '260px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '10px'
    },
    children: [
      jsx('div', {
        style: {
          fontSize: '0.68rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--ui-text-tertiary)'
        },
        children: 'Ungeplante Aufgaben'
      }),
      loading
        ? jsx('div', {
            style: { fontSize: '0.78rem', color: 'var(--ui-text-tertiary)' },
            children: 'Wird geladen…'
          })
        : !tasks.length
          ? jsx('div', {
              style: { fontSize: '0.78rem', color: 'var(--ui-text-quaternary)' },
              children: 'Alles verplant, oder noch nichts erfasst.'
            })
          : jsx('div', {
              style: { display: 'flex', flexDirection: 'column', gap: '6px' },
              children: tasks.map(task =>
                jsx('div', {
                  draggable: true,
                  onDragStart: event => {
                    // due: null macht "Ruecknahme" bei einer aus dem Eingang
                    // gezogenen Aufgabe korrekt: zurueck auf ungeplant.
                    event.dataTransfer.setData(DND_TASK, JSON.stringify({ uid: task.uid, due: null }))
                    event.dataTransfer.effectAllowed = 'move'
                  },
                  title: 'Auf einen Tag ziehen, um eine Fälligkeit zu setzen',
                  style: {
                    border: '1px solid var(--ui-stroke-secondary)',
                    borderRadius: '9px',
                    padding: '8px 10px',
                    fontSize: '0.8rem',
                    color: 'var(--ui-text-primary)',
                    cursor: 'grab',
                    background: 'var(--ui-bg-secondary)'
                  },
                  children: task.title
                }, task.uid)
              )
            }),
      jsx('div', {
        style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.4 },
        children: 'Auf einen Tag im Kalender ziehen, um eine Fälligkeit zu setzen.'
      })
    ]
  })
}

/**
 * Inline-Formular statt geratener Dialog-Komponente. Termin ODER Aufgabe,
 * Umschalter oben. calendarNames kommt aus /calendars, leer solange das noch
 * laedt (Select bleibt dann leer, Speichern-Knopf deaktiviert).
 */
function CreateForm({ dateKey, calendarNames, onCreateTask, onCreateEvent, onClose }) {
  const [kind, setKind] = useState('task')
  const [title, setTitle] = useState('')
  const [calendarName, setCalendarName] = useState(calendarNames[0] || '')
  const [startTime, setStartTime] = useState('09:00')
  const [allDay, setAllDay] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleRef = useRef(null)

  useEffect(() => {
    const node = titleRef.current
    if (node && typeof node.focus === 'function') node.focus()
  }, [])

  useEffect(() => {
    if (!calendarName && calendarNames.length) setCalendarName(calendarNames[0])
  }, [calendarNames, calendarName])

  const submit = () => {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    let startIso = dateKey
    let endIso = dateKey
    if (!allDay) {
      // Ueber den lokalen Date()-Konstruktor, nicht per String-Verkettung -
      // sonst liest das Backend die eingetippte Uhrzeit als UTC statt als
      // Ortszeit (gleiches Prinzip wie withHour() in der Wochenansicht).
      const [hh, mm] = startTime.split(':').map(Number)
      const [y, mo, d] = dateKey.split('-').map(Number)
      const start = new Date(y, mo - 1, d, hh || 0, mm || 0, 0, 0)
      startIso = start.toISOString()
      endIso = new Date(start.getTime() + 30 * 60000).toISOString()
    }
    const task = kind === 'task'
      ? onCreateTask(text, dateKey)
      : onCreateEvent(text, calendarName, startIso, endIso, allDay)
    Promise.resolve(task)
      .then(() => onClose())
      .catch(err => setError(describeError(err)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  return jsxs('div', {
    style: {
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '12px',
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px'
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', gap: '6px' },
        children: [
          jsx(Button, {
            variant: kind === 'task' ? undefined : 'ghost',
            onClick: () => setKind('task'),
            children: 'Aufgabe'
          }),
          jsx(Button, {
            variant: kind === 'event' ? undefined : 'ghost',
            onClick: () => setKind('event'),
            children: 'Termin'
          })
        ]
      }),
      jsx(Input, {
        ref: titleRef,
        autoFocus: true,
        value: title,
        placeholder: kind === 'task' ? 'Was ist zu tun?' : 'Titel des Termins',
        onChange: event => setTitle(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }
      }),
      kind === 'event'
        ? jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '8px' },
            children: [
              jsxs('label', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.8rem',
                  color: 'var(--ui-text-secondary)'
                },
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: allDay,
                    onChange: event => setAllDay(event.target.checked)
                  }),
                  'Ganztägig'
                ]
              }),
              allDay
                ? null
                : jsx(Input, {
                    type: 'time',
                    value: startTime,
                    onChange: event => setStartTime(event.target.value)
                  }),
              jsx('select', {
                value: calendarName,
                onChange: event => setCalendarName(event.target.value),
                style: {
                  font: 'inherit',
                  fontSize: '0.82rem',
                  padding: '7px 8px',
                  borderRadius: '8px',
                  border: '1px solid var(--ui-stroke-secondary)',
                  background: 'var(--ui-bg-secondary)',
                  color: 'var(--ui-text-primary)'
                },
                children: calendarNames.map(name => jsx('option', { value: name, children: name }, name))
              })
            ]
          })
        : null,
      error ? jsx(Notice, { tone: 'quiet', children: error }) : null,
      jsxs('div', {
        style: { display: 'flex', gap: '8px' },
        children: [
          jsx(Button, {
            onClick: submit,
            disabled: busy || !title.trim() || (kind === 'event' && !calendarName),
            children: busy ? 'Speichert…' : 'Anlegen'
          }),
          jsx(Button, { variant: 'ghost', onClick: onClose, disabled: busy, children: 'Abbrechen' })
        ]
      })
    ]
  })
}

/**
 * Stundenraster einer Woche. Termine/faellige Aufgaben mit Uhrzeit sind
 * absolut positionierte Boxen; alles Ganztaegige liegt in der Kopfzeile.
 * Draggable in beide Richtungen: horizontal (Tag) und vertikal (Uhrzeit).
 */
function WeekGrid({ startKey, days, loading, onOpenDay, onDropTask, onDropEvent }) {
  const dayKeys = Array.from({ length: 7 }, (_, i) => addDaysToKey(startKey, i))
  const hours = []
  for (let h = WEEK_HOUR_START; h <= WEEK_HOUR_END; h += 1) hours.push(h)
  const gridHeight = (WEEK_HOUR_END - WEEK_HOUR_START) * WEEK_HOUR_PX

  const todayKey = dayKeyOf(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate())
  const nowInWeek = dayKeys.includes(todayKey)
  const nowTop = ((new Date().getHours() + new Date().getMinutes() / 60 - WEEK_HOUR_START) / (WEEK_HOUR_END - WEEK_HOUR_START)) * gridHeight

  const onDragOverCell = event => event.preventDefault()

  const dropOnCell = (dayKey, hourFloat) => event => {
    event.preventDefault()
    const taskPayload = event.dataTransfer.getData(DND_TASK)
    const eventPayload = event.dataTransfer.getData(DND_EVENT)
    if (taskPayload) {
      const parsed = JSON.parse(taskPayload)
      onDropTask(parsed.uid, dayKey, parsed.due)
      return
    }
    if (eventPayload) {
      onDropEvent(JSON.parse(eventPayload), dayKey, hourFloat)
    }
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '0', opacity: loading ? 0.5 : 1 },
    children: [
      jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(7, 1fr)',
          gap: '4px',
          marginBottom: '6px'
        },
        children: [
          jsx('div', {}),
          ...dayKeys.map(key => {
            const isToday = key === todayKey
            return jsx('button', {
              type: 'button',
              onClick: () => onOpenDay(key),
              style: {
                font: 'inherit',
                textAlign: 'center',
                padding: '6px 4px',
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                background: isToday ? 'var(--ui-bg-secondary)' : 'transparent',
                color: isToday ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
                fontWeight: isToday ? 800 : 600,
                fontSize: '0.78rem'
              },
              children: new Date(...key.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))
                .toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' })
            }, key)
          })
        ]
      }),
      // Ganztaegige Zeile - hat keine Stunde, deshalb ausserhalb des Rasters.
      jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(7, 1fr)',
          gap: '4px',
          marginBottom: '8px'
        },
        children: [
          jsx('div', {
            style: { fontSize: '0.62rem', color: 'var(--ui-text-quaternary)', textAlign: 'right', paddingTop: '4px' },
            children: 'ganztägig'
          }),
          ...dayKeys.map(key => {
            const entry = days[key] || { tasks: [], events: [] }
            const allDayItems = [
              ...entry.tasks.filter(t => t.dueAllDay).map(t => ({ ...t, kind: 'task' })),
              ...entry.events.filter(e => e.allDay)
            ]
            return jsx('div', {
              onDragOver: onDragOverCell,
              onDrop: dropOnCell(key, WEEK_HOUR_START),
              style: {
                minHeight: '22px',
                border: '1px dashed var(--ui-stroke-secondary)',
                borderRadius: '6px',
                padding: '2px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px'
              },
              children: allDayItems.map(item =>
                jsx('div', {
                  draggable: true,
                  onDragStart: event => {
                    if (item.kind === 'event') {
                      event.dataTransfer.setData(DND_EVENT, JSON.stringify(item))
                    } else {
                      event.dataTransfer.setData(
                        DND_TASK,
                        JSON.stringify({ uid: item.uid, due: item.dueDay || null })
                      )
                    }
                  },
                  style: {
                    fontSize: '0.66rem',
                    padding: '1px 5px',
                    borderRadius: '5px',
                    background: item.kind === 'task' ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)',
                    color: item.kind === 'task' ? 'var(--ui-bg-primary)' : 'var(--ui-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  },
                  children: item.title
                }, `${item.kind}-${item.uid}`)
              )
            }, key)
          })
        ]
      }),
      jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(7, 1fr)',
          gap: '4px',
          position: 'relative',
          height: `${gridHeight}px`
        },
        children: [
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column' },
            children: hours.map(h =>
              jsx('div', {
                style: {
                  height: `${WEEK_HOUR_PX}px`,
                  fontSize: '0.62rem',
                  color: 'var(--ui-text-quaternary)',
                  textAlign: 'right',
                  paddingRight: '4px',
                  fontVariantNumeric: 'tabular-nums'
                },
                children: `${String(h).padStart(2, '0')}:00`
              }, h)
            )
          }),
          ...dayKeys.map(key => {
            const entry = days[key] || { tasks: [], events: [] }
            const timed = [
              ...entry.tasks.filter(t => t.due && !t.dueAllDay).map(t => ({ ...t, kind: 'task' })),
              ...entry.events.filter(e => !e.allDay)
            ]
            return jsxs('div', {
              style: {
                position: 'relative',
                border: '1px solid var(--ui-stroke-secondary)',
                borderRadius: '6px',
                background: 'var(--ui-bg-secondary)'
              },
              children: [
                ...hours.map((h, idx) =>
                  jsx('div', {
                    onDragOver: onDragOverCell,
                    onDrop: dropOnCell(key, h),
                    style: {
                      position: 'absolute',
                      top: `${idx * WEEK_HOUR_PX}px`,
                      left: 0,
                      right: 0,
                      height: `${WEEK_HOUR_PX}px`,
                      borderTop: idx > 0 ? '1px solid var(--ui-stroke-secondary)' : 'none'
                    }
                  }, `slot-${h}`)
                ),
                nowInWeek && key === todayKey
                  ? jsx('div', {
                      style: {
                        position: 'absolute',
                        top: `${Math.max(0, Math.min(gridHeight, nowTop))}px`,
                        left: 0,
                        right: 0,
                        height: '2px',
                        background: 'var(--ui-accent)',
                        pointerEvents: 'none'
                      }
                    })
                  : null,
                ...timed.map(item => {
                  const startHour = hourOf(item.start)
                  if (startHour == null) return null
                  const top = Math.max(0, (startHour - WEEK_HOUR_START) * WEEK_HOUR_PX)
                  const durMin = item.end
                    ? Math.max(20, (new Date(item.end) - new Date(item.start)) / 60000)
                    : 30
                  const height = Math.max(18, (durMin / 60) * WEEK_HOUR_PX)
                  return jsx('div', {
                    draggable: true,
                    onDragStart: event => {
                      if (item.kind === 'task') {
                        // Schon terminierte Aufgabe: due traegt das BISHERIGE
                        // Datum mit, damit Ruecknahme dahin zurueckkann statt
                        // faelschlich auf "ungeplant" zu setzen.
                        event.dataTransfer.setData(
                          DND_TASK,
                          JSON.stringify({ uid: item.uid, due: item.dueDay || null })
                        )
                      } else {
                        event.dataTransfer.setData(DND_EVENT, JSON.stringify(item))
                      }
                    },
                    title: item.title,
                    style: {
                      position: 'absolute',
                      top: `${top}px`,
                      left: '2px',
                      right: '2px',
                      height: `${height}px`,
                      borderRadius: '6px',
                      padding: '2px 6px',
                      fontSize: '0.68rem',
                      lineHeight: 1.2,
                      overflow: 'hidden',
                      cursor: 'grab',
                      background: item.kind === 'task' ? 'var(--ui-accent)' : 'var(--ui-bg-primary)',
                      border: item.kind === 'task' ? 'none' : '1px solid var(--ui-accent)',
                      color: item.kind === 'task' ? 'var(--ui-bg-primary)' : 'var(--ui-text-primary)'
                    },
                    children: item.title
                  }, `${item.kind}-${item.uid}`)
                })
              ]
            }, key)
          })
        ]
      })
    ]
  })
}

/**
 * Der Ueberblick, den die Fokusansicht bewusst verweigert: ein ganzer Monat auf
 * einen Blick, und pro Tag die Details erst auf Klick. Drei Zustaende, kein
 * Router - 'month' und 'week' zeigen Raster, 'day' den angeklickten Tag.
 */
function CalendarView({
  api,
  month,
  days,
  loading,
  onMonth,
  onRefresh,
  unscheduled,
  unscheduledLoading,
  onReloadUnscheduled,
  calendarNames,
  weekStart,
  weekDays,
  weekLoading,
  onWeekStart,
  onReloadWeek,
  setError
}) {
  const [mode, setMode] = useState('month')
  // Wohin fuehrt "Zurueck" aus der Tagesansicht? Wird beim Betreten von 'day'
  // festgehalten, nicht aus vorhandenen Daten geraten - ein leeres {}-Objekt
  // waere sonst truthy und wuerde die Rueckkehr immer auf 'week' ziehen.
  const [returnMode, setReturnMode] = useState('month')
  const [selected, setSelected] = useState('')
  const [dayData, setDayData] = useState({ tasks: [], events: [] })
  const [dayLoading, setDayLoading] = useState(false)
  const [busyUid, setBusyUid] = useState('')
  const [creating, setCreating] = useState(false)
  const { cheer, announce } = useCelebration()
  const { notice, announceMove, dismiss } = useMoveNotice()

  const loadDayInto = useCallback(dateKey => {
    let alive = true
    setDayLoading(true)
    api
      .day(dateKey)
      .then(data => {
        if (!alive) return
        setDayData({
          tasks: Array.isArray(data && data.tasks) ? data.tasks : [],
          events: Array.isArray(data && data.events) ? data.events : []
        })
        setError('')
      })
      .catch(error => {
        if (alive) setError(describeError(error))
      })
      .then(
        () => {
          if (alive) setDayLoading(false)
        },
        () => {
          if (alive) setDayLoading(false)
        }
      )
    return () => {
      alive = false
    }
  }, [])

  // Eigener Ladezyklus, bewusst getrennt vom Tagesuebersicht-Tab: beide duerfen
  // unterschiedliche Tage zeigen, ohne sich gegenseitig zu ueberschreiben.
  useEffect(() => {
    if (mode !== 'day' || !selected) return undefined
    return loadDayInto(selected)
  }, [mode, selected, loadDayInto])

  const open = key => {
    if (mode === 'month' || mode === 'week') setReturnMode(mode)
    setSelected(key)
    setDayData({ tasks: [], events: [] })
    setCreating(false)
    setMode('day')
  }

  const shiftMonth = delta => {
    const next = new Date(month.year, month.month - 1 + delta, 1)
    onMonth({ year: next.getFullYear(), month: next.getMonth() + 1 })
  }

  const shiftWeek = delta => onWeekStart(addDaysToKey(weekStart, delta * 7))

  const goToday = () => {
    const now = new Date()
    const year = now.getFullYear()
    const monthNum = now.getMonth() + 1
    const todayKey = dayKeyOf(year, monthNum, now.getDate())
    if (year !== month.year || monthNum !== month.month) onMonth({ year, month: monthNum })
    onWeekStart(weekStartOf(todayKey))
    open(todayKey)
  }

  const complete = uid => {
    if (busyUid) return
    tapHaptic()
    setBusyUid(uid)
    api
      .complete(uid)
      .then(result => {
        announce(result && result.gamification)
        // Optimistisch: die Zeile geht sofort. Raster/Woche/Panel im Hintergrund
        // nachziehen, damit die Zahlen beim Zurueckgehen stimmen.
        setDayData(current => ({
          tasks: current.tasks.filter(item => item.uid !== uid),
          events: current.events
        }))
        onRefresh()
        onReloadWeek()
        onReloadUnscheduled()
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusyUid(''), () => setBusyUid(''))
  }

  // Aufgabe aus dem Seitenpanel (oder von einem anderen Tag) auf einen
  // Kalendertag ziehen - kein Bestaetigungsdialog, aber ruecknehmbar.
  const dropTaskOnDay = (uid, dateKey, previousDue) => {
    api
      .setTaskDue(uid, dateKey)
      .then(() => {
        onRefresh()
        onReloadWeek()
        onReloadUnscheduled()
        if (mode === 'day' && selected) loadDayInto(selected)
        announceMove('Fälligkeit gesetzt', {
          kind: 'task',
          uid,
          due: previousDue === undefined ? null : previousDue
        })
      })
      .catch(error => setError(describeError(error)))
  }

  // Termin von einem Tag/einer Stunde auf eine andere ziehen. item traegt die
  // bisherigen start/end/allDay/calendar-Werte fuer den Ruecknahme-Fall.
  const dropEventOnSlot = (item, dateKey, hourFloat) => {
    const allDay = Boolean(item.allDay)
    const newStart = allDay ? dateKey : withHour(dateKey, hourFloat)
    const durationMs = item.end && item.start ? new Date(item.end) - new Date(item.start) : 30 * 60000
    const newEnd = allDay ? dateKey : new Date(new Date(newStart).getTime() + durationMs).toISOString()
    const previous = { start: item.start, end: item.end, allDay: item.allDay }
    api
      .moveEvent(item.uid, item.calendar, newStart, newEnd, allDay)
      .then(() => {
        onRefresh()
        onReloadWeek()
        if (mode === 'day' && selected) loadDayInto(selected)
        announceMove('Termin verschoben', {
          kind: 'event',
          uid: item.uid,
          calendarName: item.calendar,
          ...previous
        })
      })
      .catch(error => setError(describeError(error)))
  }

  const undoMove = target => {
    dismiss()
    if (!target) return
    if (target.kind === 'task') {
      api
        .setTaskDue(target.uid, target.due)
        .then(() => {
          onRefresh()
          onReloadWeek()
          onReloadUnscheduled()
          if (mode === 'day' && selected) loadDayInto(selected)
        })
        .catch(error => setError(describeError(error)))
      return
    }
    api
      .moveEvent(target.uid, target.calendarName, target.start, target.end, target.allDay)
      .then(() => {
        onRefresh()
        onReloadWeek()
        if (mode === 'day' && selected) loadDayInto(selected)
      })
      .catch(error => setError(describeError(error)))
  }

  const createTask = (title, dateKey) => api.capture(title, { due: dateKey }).then(() => {
    onRefresh()
    onReloadWeek()
    onReloadUnscheduled()
    if (mode === 'day' && selected) loadDayInto(selected)
  })

  const createEvent = (title, calendarName, start, end, allDay) =>
    api.createEvent(title, calendarName, start, end, allDay).then(() => {
      onRefresh()
      onReloadWeek()
      if (mode === 'day' && selected) loadDayInto(selected)
    })

  const modeSwitch = jsxs('div', {
    style: { display: 'flex', gap: '4px' },
    children: [
      jsx(NavButton, {
        label: 'Monat',
        title: 'Monatsansicht',
        onClick: () => setMode('month')
      }),
      jsx(NavButton, {
        label: 'Woche',
        title: 'Wochenansicht',
        onClick: () => {
          onWeekStart(weekStartOf(selected || dayKeyOf(month.year, month.month, 1)))
          setMode('week')
        }
      })
    ]
  })

  if (mode === 'day') {
    const tasks = dayData.tasks
    const events = dayData.events
    return jsxs('div', {
      style: {
        position: 'relative',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        maxWidth: '680px',
        margin: '0 auto',
        width: '100%'
      },
      children: [
        jsx(CelebrationToast, { cheer }),
        jsx(MoveToast, { notice, onUndo: undoMove }),
        jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
          children: [
            jsx(NavButton, {
              label: '← Zurück',
              title: 'Zurück zur Kalenderübersicht',
              onClick: () => setMode(returnMode)
            }),
            jsx('div', {
              style: { fontWeight: 700, fontSize: '0.95rem', color: 'var(--ui-text-primary)' },
              children: longDate(selected)
            }),
            jsx('div', { style: { flex: 1 } }),
            jsx(NavButton, {
              label: creating ? 'Schließen' : '+ Neu',
              title: 'Aufgabe oder Termin anlegen',
              onClick: () => setCreating(current => !current)
            })
          ]
        }),
        creating
          ? jsx(CreateForm, {
              dateKey: selected,
              calendarNames,
              onCreateTask: createTask,
              onCreateEvent: createEvent,
              onClose: () => setCreating(false)
            })
          : null,
        dayLoading
          ? jsx('div', {
              style: { color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' },
              children: 'Tag wird geladen…'
            })
          : !tasks.length && !events.length
            ? jsx(EmptyState, {
                title: 'Nichts eingetragen an diesem Tag.',
                description: 'Weder fällige Aufgaben noch Termine im Kalender.'
              })
            : jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: '18px' },
                children: [
                  tasks.length
                    ? jsx(DaySection, {
                        label: 'Aufgaben',
                        children: tasks.map(item =>
                          jsx(DayRow, {
                            title: item.title,
                            meta: whenLabel(item) ? `fällig ${whenLabel(item)}` : '',
                            action: jsx(Button, {
                              onClick: () => complete(item.uid),
                              disabled: Boolean(busyUid),
                              children: 'Erledigt'
                            })
                          }, item.uid)
                        )
                      })
                    : null,
                  events.length
                    ? jsx(DaySection, {
                        label: 'Termine',
                        children: events.map(item =>
                          jsx(DayRow, {
                            title: item.title,
                            meta: [whenLabel(item), durationOf(item), item.calendar]
                              .filter(Boolean)
                              .join(' · '),
                            action: null
                          }, `${item.uid || item.title}-${item.start || ''}`)
                        )
                      })
                    : null
                ]
              })
      ]
    })
  }

  if (mode === 'week') {
    return jsxs('div', {
      style: {
        position: 'relative',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        width: '100%'
      },
      children: [
        jsx(MoveToast, { notice, onUndo: undoMove }),
        jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
          children: [
            modeSwitch,
            jsx(NavButton, { label: '←', title: 'Vorige Woche', onClick: () => shiftWeek(-1) }),
            jsx('div', {
              style: { fontWeight: 700, fontSize: '0.9rem', color: 'var(--ui-text-primary)' },
              children: weekRangeTitle(weekStart)
            }),
            jsx(NavButton, { label: '→', title: 'Nächste Woche', onClick: () => shiftWeek(1) }),
            jsx(NavButton, { label: 'Heute', title: 'Zur aktuellen Woche', onClick: goToday })
          ]
        }),
        jsx(WeekGrid, {
          startKey: weekStart,
          days: weekDays || {},
          loading: weekLoading,
          onOpenDay: open,
          onDropTask: (uid, dateKey, previousDue) => dropTaskOnDay(uid, dateKey, previousDue),
          onDropEvent: (item, dateKey, hourFloat) => dropEventOnSlot(item, dateKey, hourFloat)
        })
      ]
    })
  }

  return jsxs('div', {
    style: {
      position: 'relative',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      width: '100%'
    },
    children: [
      jsx(MoveToast, { notice, onUndo: undoMove }),
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        children: [
          modeSwitch,
          jsx(NavButton, { label: '←', title: 'Voriger Monat', onClick: () => shiftMonth(-1) }),
          jsx('div', {
            style: {
              flex: 1,
              textAlign: 'center',
              fontWeight: 700,
              fontSize: '0.95rem',
              color: 'var(--ui-text-primary)'
            },
            children: monthTitle(month.year, month.month)
          }),
          jsx(NavButton, { label: '→', title: 'Nächster Monat', onClick: () => shiftMonth(1) }),
          jsx(NavButton, { label: 'Heute', title: 'Zum heutigen Tag', onClick: goToday })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' },
        children: [
          jsx('div', {
            style: { flex: '1 1 480px', minWidth: '320px' },
            children: jsx(MonthGrid, {
              year: month.year,
              month: month.month,
              days: days || {},
              loading,
              onPick: open,
              onDropTask: (uid, dateKey, previousDue) => dropTaskOnDay(uid, dateKey, previousDue)
            })
          }),
          jsx(UnscheduledPanel, { tasks: unscheduled || [], loading: unscheduledLoading })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------- Notizen

function NotesView({ api, setError }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    return api
      .notesList()
      .then(data => {
        setNotes((data && data.notes) || [])
        setUnavailable(false)
      })
      .catch(error => {
        if (describeError(error).includes('nicht installiert oder aktiviert')) setUnavailable(true)
        else setError(describeError(error))
      })
      .then(() => setLoading(false), () => setLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openNote = id => {
    setCreating(false)
    setBusy(true)
    api
      .noteGet(id)
      .then(data => {
        setOpenId(id)
        setDraftTitle((data && data.title) || '')
        setDraftContent((data && data.content) || '')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  const startCreate = () => {
    setCreating(true)
    setOpenId(null)
    setDraftTitle('')
    setDraftContent('')
  }

  const save = () => {
    if (busy) return
    setBusy(true)
    const done = creating
      ? api.noteCreate(draftTitle || '(ohne Titel)', draftContent)
      : api.noteUpdate(openId, { title: draftTitle, content: draftContent })
    done
      .then(() => {
        setCreating(false)
        setOpenId(null)
        return load()
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  const remove = id => {
    if (busy) return
    setBusy(true)
    api
      .noteDelete(id)
      .then(() => {
        if (openId === id) setOpenId(null)
        return load()
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  if (unavailable) {
    return jsx('div', {
      style: { padding: '32px 24px' },
      children: jsx(EmptyState, {
        title: 'Notizen sind hier nicht verfügbar.',
        description: 'Die Notes-App ist auf dieser Nextcloud-Instanz nicht installiert oder aktiviert.'
      })
    })
  }

  const editing = creating || openId !== null

  return jsxs('div', {
    style: { display: 'flex', height: '100%', minHeight: 0 },
    children: [
      jsxs('div', {
        style: {
          width: '260px',
          flexShrink: 0,
          borderRight: '1px solid var(--ui-stroke-secondary)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        },
        children: [
          jsx('div', {
            style: { padding: '10px 12px', borderBottom: '1px solid var(--ui-stroke-secondary)' },
            children: jsx(Button, { onClick: startCreate, style: { width: '100%' }, children: '+ Notiz' })
          }),
          jsx('div', {
            style: { flex: 1, minHeight: 0, overflowY: 'auto' },
            children: loading
              ? jsx('div', { style: { padding: '12px', color: 'var(--ui-text-tertiary)', fontSize: '0.8rem' }, children: 'Wird geladen…' })
              : notes.length
                ? notes.map(n =>
                    jsxs('button', {
                      type: 'button',
                      onClick: () => openNote(n.id),
                      style: {
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        font: 'inherit',
                        background: openId === n.id ? 'var(--ui-bg-secondary)' : 'none',
                        border: 'none',
                        borderBottom: '1px solid var(--ui-stroke-secondary)',
                        padding: '10px 12px',
                        cursor: 'pointer'
                      },
                      children: [
                        jsx('div', { style: { fontSize: '0.84rem', color: 'var(--ui-text-primary)' }, children: n.title }),
                        n.preview
                          ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', marginTop: '2px' }, children: n.preview })
                          : null
                      ]
                    }, n.id)
                  )
                : jsx('div', { style: { padding: '16px', color: 'var(--ui-text-tertiary)', fontSize: '0.8rem' }, children: 'Keine Notizen.' })
          })
        ]
      }),
      jsx('div', {
        style: { flex: 1, minHeight: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' },
        children: editing
          ? [
              jsx(Input, {
                value: draftTitle,
                placeholder: 'Titel',
                onChange: event => setDraftTitle(event.target.value)
              }),
              jsx(Textarea, {
                value: draftContent,
                placeholder: 'Inhalt…',
                rows: 16,
                onChange: event => setDraftContent(event.target.value),
                style: { flex: 1 }
              }),
              jsxs('div', {
                style: { display: 'flex', gap: '8px' },
                children: [
                  jsx(Button, { onClick: save, disabled: busy, children: 'Speichern' }),
                  openId !== null
                    ? jsx(Button, { variant: 'ghost', onClick: () => remove(openId), disabled: busy, children: 'Löschen' })
                    : null
                ]
              })
            ]
          : jsx(EmptyState, { title: 'Keine Notiz geöffnet.', description: 'Links eine Notiz auswählen oder eine neue anlegen.' })
      })
    ]
  })
}

// ---------------------------------------------------------------- Deck (Kanban)

function DeckView({ api, setError }) {
  const [boards, setBoards] = useState([])
  const [boardId, setBoardId] = useState(null)
  const [stacks, setStacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    api
      .deckBoards()
      .then(data => {
        const list = (data && data.boards) || []
        setBoards(list)
        setUnavailable(false)
        if (list.length) setBoardId(list[0].id)
      })
      .catch(error => {
        if (describeError(error).includes('nicht installiert oder aktiviert')) setUnavailable(true)
        else setError(describeError(error))
      })
      .then(() => setLoading(false), () => setLoading(false))
  }, [])

  useEffect(() => {
    if (boardId === null) return
    api
      .deckBoard(boardId)
      .then(data => setStacks((data && data.stacks) || []))
      .catch(error => setError(describeError(error)))
  }, [boardId])

  if (unavailable) {
    return jsx('div', {
      style: { padding: '32px 24px' },
      children: jsx(EmptyState, {
        title: 'Deck ist hier nicht verfügbar.',
        description: 'Die Deck-App ist auf dieser Nextcloud-Instanz nicht installiert oder aktiviert.'
      })
    })
  }

  if (loading) {
    return jsx('div', { style: { padding: '24px', color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' }, children: 'Wird geladen…' })
  }

  if (!boards.length) {
    return jsx('div', {
      style: { padding: '32px 24px' },
      children: jsx(EmptyState, { title: 'Keine Boards gefunden.', description: 'Lege in Nextcloud Deck ein Board an.' })
    })
  }

  return jsxs('div', {
    style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 },
    children: [
      boards.length > 1
        ? jsxs('select', {
            value: boardId || '',
            onChange: event => setBoardId(Number(event.target.value)),
            style: {
              alignSelf: 'flex-start',
              font: 'inherit',
              fontSize: '0.82rem',
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid var(--ui-stroke-secondary)',
              background: 'var(--ui-bg-secondary)',
              color: 'var(--ui-text-primary)'
            },
            children: boards.map(b => jsx('option', { value: b.id, children: b.title }, b.id))
          })
        : null,
      jsx('div', {
        style: { display: 'flex', gap: '12px', overflowX: 'auto', flex: 1, minHeight: 0 },
        children: stacks.map(stack =>
          jsxs('div', {
            style: {
              minWidth: '220px',
              maxWidth: '220px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: '10px',
              padding: '10px'
            },
            children: [
              jsx('div', { style: { fontWeight: 700, fontSize: '0.82rem', color: 'var(--ui-text-primary)' }, children: stack.title }),
              ...stack.cards.map(card =>
                jsx('div', {
                  style: {
                    border: '1px solid var(--ui-stroke-secondary)',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    fontSize: '0.8rem',
                    color: 'var(--ui-text-secondary)',
                    background: 'var(--ui-bg-secondary)'
                  },
                  children: card.title
                }, card.id)
              )
            ]
          }, stack.id)
        )
      })
    ]
  })
}

// ---------------------------------------------------------------- Kontakte

function ContactsView({ api, setError }) {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api
      .contacts()
      .then(data => setContacts((data && data.contacts) || []))
      .catch(error => setError(describeError(error)))
      .then(() => setLoading(false), () => setLoading(false))
  }, [])

  const query = filter.trim().toLowerCase()
  const shown = query
    ? contacts.filter(c => c.name.toLowerCase().includes(query) || c.emails.some(e => e.toLowerCase().includes(query)))
    : contacts

  return jsxs('div', {
    style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
    children: [
      jsx(Input, { value: filter, placeholder: 'Suchen…', onChange: event => setFilter(event.target.value) }),
      loading
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' }, children: 'Wird geladen…' })
        : shown.length
          ? jsx('div', {
              style: { display: 'flex', flexDirection: 'column', gap: '2px' },
              children: shown.map((c, index) =>
                jsxs(DayRow, {
                  title: c.name || '(ohne Namen)',
                  meta: [c.emails[0], c.tels[0]].filter(Boolean).join(' · '),
                  action: null
                }, `${index}-${c.name}`)
              )
            })
          : jsx(EmptyState, { title: 'Keine Kontakte gefunden.', description: query ? 'Andere Suche versuchen.' : 'Das Adressbuch ist leer.' })
    ]
  })
}

// ---------------------------------------------------------------- Dateien

function FilesView({ api, setError }) {
  const [path, setPath] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api
      .files(path)
      .then(data => setItems((data && data.items) || []))
      .catch(error => setError(describeError(error)))
      .then(() => setLoading(false), () => setLoading(false))
  }, [path])

  const segments = path ? path.split('/').filter(Boolean) : []

  return jsxs('div', {
    style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' },
    children: [
      jsxs('div', {
        style: { display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--ui-text-tertiary)' },
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => setPath(''),
            style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ui-accent)', font: 'inherit', padding: 0 },
            children: 'Start'
          }),
          ...segments.map((seg, index) =>
            jsxs('span', {
              children: [
                ' / ',
                jsx('button', {
                  type: 'button',
                  onClick: () => setPath(segments.slice(0, index + 1).join('/')),
                  style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ui-accent)', font: 'inherit', padding: 0 },
                  children: seg
                })
              ]
            }, `${index}-${seg}`)
          )
        ]
      }),
      loading
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' }, children: 'Wird geladen…' })
        : items.length
          ? jsx('div', {
              style: { display: 'flex', flexDirection: 'column', gap: '2px' },
              children: items.map(item =>
                jsx(DayRow, {
                  title: (item.isDirectory ? '📁 ' : '') + item.name,
                  meta: item.isDirectory ? '' : item.size ? `${Math.round(item.size / 1024)} KB` : '',
                  action: item.isDirectory
                    ? jsx(Button, {
                        variant: 'ghost',
                        onClick: () => setPath(path ? `${path}/${item.name}` : item.name),
                        children: 'Öffnen'
                      })
                    : null
                }, item.name)
              )
            })
          : jsx(EmptyState, { title: 'Ordner ist leer.', description: '' })
    ]
  })
}

function FokusPage({ ctx }) {
  const api = makeApi(ctx)
  // Default AN: Oliver nutzt es gerade aktiv, niemand soll es ihm ungefragt
  // wegnehmen. Wer es ausschaltet, bekommt ein reines Nextcloud-Dashboard.
  const [adhsMode, setAdhsModeState] = useState(() => ctx.storage.get(STORAGE_ADHS_KEY, true))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState(() => ctx.storage.get(STORAGE_TAB_KEY, 'fokus'))

  const setAdhsMode = value => {
    ctx.storage.set(STORAGE_ADHS_KEY, value)
    setAdhsModeState(value)
    // Faellt ein Tab weg, der gerade offen ist, landet man auf dem Kalender -
    // der ist in beiden Modi vorhanden und der sinnvollste generische Start.
    if (!value && (tab === 'fokus' || tab === 'fortschritt')) setTab('kalender')
  }
  const [focus, setFocus] = useState({ task: null, inbox: 0 })
  const [day, setDay] = useState({ items: [], date: '' })
  const [dayLoading, setDayLoading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [progressLoading, setProgressLoading] = useState(false)
  const [calMonth, setCalMonth] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  const [monthDays, setMonthDays] = useState({})
  const [monthLoading, setMonthLoading] = useState(false)
  const [unscheduled, setUnscheduled] = useState([])
  const [unscheduledLoading, setUnscheduledLoading] = useState(false)
  const [calendarNames, setCalendarNames] = useState([])
  const [weekStart, setWeekStart] = useState(() => weekStartOf(''))
  const [weekDays, setWeekDays] = useState({})
  const [weekLoading, setWeekLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // null = wird gerade geprueft; erst danach entscheidet sich, ob das
  // Einrichtungs-Formular oder die eigentliche Ansicht erscheint.
  const [configured, setConfigured] = useState(null)

  const checkSetup = useCallback(() => {
    return api
      .getSettings()
      .then(data => setConfigured(Boolean(data && data.configured)))
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    void checkSetup()
  }, [checkSetup])

  const loadFocus = useCallback(() => {
    return api
      .focus()
      .then(data => {
        setFocus(data)
        $inbox.set(data.inbox || 0)
        $ready.set({ ready: true, reason: '' })
        setError('')
      })
      .catch(error => {
        const reason = describeError(error)
        setError(reason)
        $ready.set({ ready: false, reason })
      })
  }, [])

  const loadDay = useCallback(() => {
    setDayLoading(true)
    return api
      .day()
      .then(data => {
        setDay(data)
        setError('')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setDayLoading(false), () => setDayLoading(false))
  }, [])

  const loadProgress = useCallback(() => {
    setProgressLoading(true)
    return api
      .progress()
      .then(data => {
        setProgress(data)
        setError('')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setProgressLoading(false), () => setProgressLoading(false))
  }, [])

  const loadMonth = useCallback((year, monthNum) => {
    setMonthLoading(true)
    return api
      .month(year, monthNum)
      .then(data => {
        setMonthDays((data && data.days) || {})
        setError('')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setMonthLoading(false), () => setMonthLoading(false))
  }, [])

  const loadUnscheduled = useCallback(() => {
    setUnscheduledLoading(true)
    return api
      .unscheduled()
      .then(data => {
        setUnscheduled((data && data.tasks) || [])
        setError('')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setUnscheduledLoading(false), () => setUnscheduledLoading(false))
  }, [])

  const loadWeek = useCallback(startKey => {
    setWeekLoading(true)
    return api
      .week(startKey)
      .then(data => {
        setWeekDays((data && data.days) || {})
        setError('')
      })
      .catch(error => setError(describeError(error)))
      .then(() => setWeekLoading(false), () => setWeekLoading(false))
  }, [])

  useEffect(() => {
    if (configured) void loadFocus()
  }, [configured, loadFocus])

  useEffect(() => {
    if (!configured) return
    ctx.storage.set(STORAGE_TAB_KEY, tab)
    if (tab === 'tag') void loadDay()
    if (tab === 'fortschritt') void loadProgress()
  }, [configured, tab, loadDay, loadProgress])

  // Eigener Effekt, weil der Kalender nicht nur beim Tab-Wechsel neu laedt,
  // sondern auch bei jedem Monatssprung.
  useEffect(() => {
    if (!configured || tab !== 'kalender') return
    void loadMonth(calMonth.year, calMonth.month)
  }, [configured, tab, calMonth, loadMonth])

  useEffect(() => {
    if (!configured || tab !== 'kalender') return
    void loadUnscheduled()
    void api.listCalendars().then(
      data => setCalendarNames((data && data.calendars) || []),
      () => setCalendarNames([])
    )
  }, [configured, tab, loadUnscheduled])

  useEffect(() => {
    if (!configured || tab !== 'kalender') return
    void loadWeek(weekStart)
  }, [configured, tab, weekStart, loadWeek])

  const capture = value => {
    setBusy(true)
    api
      .capture(value)
      .then(() => loadFocus())
      .then(() => {
        if (tab === 'tag') return loadDay()
        return undefined
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusy(false), () => setBusy(false))
  }

  const reload = () => loadFocus().then(() => (tab === 'tag' ? loadDay() : undefined))

  if (configured === null) {
    return jsx('div', {
      style: { padding: '24px', color: 'var(--ui-text-tertiary)', fontSize: '0.82rem' },
      children: 'Wird geladen…'
    })
  }

  if (!configured) {
    return jsx(SetupView, {
      api,
      onDone: () => setConfigured(true)
    })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx(CaptureBar, { onCapture: capture, busy }),
      jsx(Tabs, {
        value: tab,
        onChange: setTab,
        adhsMode,
        onToggleSettings: () => setSettingsOpen(current => !current),
        settingsOpen
      }),
      settingsOpen ? jsx(SettingsPanel, { adhsMode, onChangeAdhsMode: setAdhsMode }) : null,
      error
        ? jsx('div', {
            style: { padding: '12px 16px' },
            children: jsx(Notice, { tone: 'quiet', children: error })
          })
        : null,
      jsx('div', {
        style: { flex: 1, minHeight: 0, overflowY: 'auto' },
        children:
          tab === 'fokus' && adhsMode
            ? jsx(FokusView, { api, state: focus, reload, setError })
            : tab === 'fortschritt' && adhsMode
              ? jsx(ProgressView, { data: progress, loading: progressLoading })
              : tab === 'tag' && adhsMode
                ? jsx(TagView, { items: day.items || [], date: day.date, loading: dayLoading })
                : tab === 'notizen'
                  ? jsx(NotesView, { api, setError })
                  : tab === 'deck'
                    ? jsx(DeckView, { api, setError })
                    : tab === 'kontakte'
                      ? jsx(ContactsView, { api, setError })
                      : tab === 'dateien'
                        ? jsx(FilesView, { api, setError })
                        : jsx(CalendarView, {
                            api,
                            month: calMonth,
                            days: monthDays,
                            loading: monthLoading,
                            onMonth: setCalMonth,
                            onRefresh: () => loadMonth(calMonth.year, calMonth.month),
                            unscheduled,
                            unscheduledLoading,
                            onReloadUnscheduled: loadUnscheduled,
                            calendarNames,
                            weekStart,
                            weekDays,
                            weekLoading,
                            onWeekStart: setWeekStart,
                            onReloadWeek: () => loadWeek(weekStart),
                            setError
                          })
      })
    ]
  })
}

function StatusChip() {
  const inbox = useValue($inbox)
  const health = useValue($ready)

  // Nur sichtbar wenn es etwas zu zeigen gibt, und immer im leisen Ton.
  if (!inbox && health.ready) return null

  return jsx('button', {
    type: 'button',
    onClick: () => host.navigate(ROUTE),
    title: health.ready ? 'Fokus öffnen' : health.reason,
    style: {
      padding: '0 6px',
      fontSize: '0.6875rem',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--ui-text-tertiary)'
    },
    children: health.ready ? `${inbox} im Eingang` : 'Fokus: Setup offen'
  })
}

// ---------------------------------------------------------------- Plugin

export default {
  id: ID,
  name: 'Nextcloud',
  register(ctx) {
    const api = makeApi(ctx)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(FokusPage, { ctx })
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Nextcloud', codicon: 'cloud' }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 130,
        render: () => jsx(StatusChip, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-nextcloud.open',
          label: 'Fokus öffnen',
          keywords: ['fokus', 'aufgabe', 'todo', 'adhs'],
          run: () => host.navigate(ROUTE)
        }
      }
    ])

    // Sanfte Erinnerung an die AKTUELLE Fokus-Aufgabe. Das Backend entscheidet,
    // ob der Abstand gross genug ist - so klopft ein Fensterneustart nicht
    // sofort wieder an. Poll statt ctx.socket, weil der Socket auf
    // OAuth-Remotes ein No-Op ist.
    const tick = () => {
      const stored = Number(ctx.storage.get(STORAGE_REMINDER_KEY, DEFAULT_REMINDER_MINUTES))
      const minutes =
        Number.isFinite(stored) && stored >= 5 && stored <= 720
          ? stored
          : DEFAULT_REMINDER_MINUTES
      api
        .reminder(minutes)
        .then(result => {
          $inbox.set(result.inbox || 0)
          $ready.set({ ready: true, reason: '' })
          if (result.remind && result.task) {
            void ctx.os.notify({
              title: 'Dein nächster Schritt',
              body: result.task.title,
              silent: true,
              activate: ROUTE
            })
          }
        })
        .catch(error => {
          // Ein nicht konfiguriertes Backend darf keine Fehlerflut ausloesen:
          // der Zustand wandert in die Statusleiste, nicht in einen Toast.
          $ready.set({ ready: false, reason: describeError(error) })
        })
    }

    const timer = setInterval(tick, REMINDER_POLL_MS)
    tick()

    // Ohne das laeuft der Timer nach dem Deaktivieren des Plugins weiter und
    // benachrichtigt aus einem Plugin, das der Nutzer ausgeschaltet hat.
    const stop = () => clearInterval(timer)
    if (typeof ctx.onDispose === 'function') ctx.onDispose(stop)
    return stop
  }
}
