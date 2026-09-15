/**
 * hermes-fokus - Desktop-Fassung.
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
 * Backend: ~/.hermes/plugins/hermes-fokus/dashboard/plugin_api.py
 * ctx.rest() zeigt automatisch auf /api/plugins/hermes-fokus/.
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

const ID = 'hermes-fokus'
const ROUTE = '/hermes-fokus'
const STORAGE_REMINDER_KEY = 'reminderMinutes'
const STORAGE_TAB_KEY = 'lastTab'
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
    capture: title => call('/capture', 'POST', { title }),
    focus: () => call('/focus', 'GET'),
    complete: uid => call('/focus/complete', 'POST', { uid }),
    defer: uid => call('/focus/defer', 'POST', { uid, minutes: DEFER_MINUTES }),
    breakdown: (uid, steps) => call('/focus/breakdown', 'POST', { uid, steps }),
    // Ohne Datum bleibt es der heutige Tag - die Tagesuebersicht ruft weiter
    // genau so auf wie vorher.
    day: dateStr => call(dateStr ? `/day?date=${dateStr}` : '/day', 'GET'),
    month: (year, monthNum) => call(`/month?year=${year}&month=${monthNum}`, 'GET'),
    progress: () => call('/progress', 'GET'),
    reminder: intervalMinutes =>
      call('/reminder/check', 'POST', { intervalMinutes })
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

function Tabs({ value, onChange }) {
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
      gap: '2px',
      padding: '8px 16px 0',
      borderBottom: '1px solid var(--ui-stroke-secondary)'
    },
    children: [
      tab('fokus', 'Fokus'),
      tab('tag', 'Tagesübersicht'),
      tab('fortschritt', 'Fortschritt'),
      tab('kalender', 'Kalender')
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

function MonthGrid({ year, month, days, loading, onPick }) {
  const first = new Date(year, month - 1, 1)
  // getDay() zaehlt ab Sonntag, das Raster beginnt am Montag.
  const lead = (first.getDay() + 6) % 7
  const total = new Date(year, month, 0).getDate()
  const trail = (7 - ((lead + total) % 7)) % 7

  const now = new Date()
  const todayKey = dayKeyOf(now.getFullYear(), now.getMonth() + 1, now.getDate())

  const cells = []
  for (let i = 0; i < lead; i += 1) {
    cells.push(jsx('div', { style: { minHeight: '64px' } }, `lead-${i}`))
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
        style: {
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'none',
          border: `1px solid ${
            isToday ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'
          }`,
          borderRadius: '10px',
          padding: '7px 8px',
          minHeight: '64px',
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
    cells.push(jsx('div', { style: { minHeight: '64px' } }, `trail-${i}`))
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

/**
 * Der Ueberblick, den die Fokusansicht bewusst verweigert: ein ganzer Monat auf
 * einen Blick, und pro Tag die Details erst auf Klick. Zwei Zustaende, kein
 * Router - 'month' zeigt das Raster, 'day' den angeklickten Tag.
 */
function CalendarView({ api, month, days, loading, onMonth, onRefresh, setError }) {
  const [mode, setMode] = useState('month')
  const [selected, setSelected] = useState('')
  const [dayData, setDayData] = useState({ tasks: [], events: [] })
  const [dayLoading, setDayLoading] = useState(false)
  const [busyUid, setBusyUid] = useState('')
  const { cheer, announce } = useCelebration()

  // Eigener Ladezyklus, bewusst getrennt vom Tagesuebersicht-Tab: beide duerfen
  // unterschiedliche Tage zeigen, ohne sich gegenseitig zu ueberschreiben.
  useEffect(() => {
    if (mode !== 'day' || !selected) return undefined
    let alive = true
    setDayLoading(true)
    api
      .day(selected)
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
  }, [mode, selected])

  const open = key => {
    setSelected(key)
    setDayData({ tasks: [], events: [] })
    setMode('day')
  }

  const shift = delta => {
    const next = new Date(month.year, month.month - 1 + delta, 1)
    onMonth({ year: next.getFullYear(), month: next.getMonth() + 1 })
  }

  const goToday = () => {
    const now = new Date()
    const year = now.getFullYear()
    const monthNum = now.getMonth() + 1
    if (year !== month.year || monthNum !== month.month) onMonth({ year, month: monthNum })
    open(dayKeyOf(year, monthNum, now.getDate()))
  }

  const complete = uid => {
    if (busyUid) return
    tapHaptic()
    setBusyUid(uid)
    api
      .complete(uid)
      .then(result => {
        announce(result && result.gamification)
        // Optimistisch: die Zeile geht sofort. Das Raster im Hintergrund wird
        // nachgezogen, damit die Zahlen beim Zurueckgehen stimmen.
        setDayData(current => ({
          tasks: current.tasks.filter(item => item.uid !== uid),
          events: current.events
        }))
        return onRefresh()
      })
      .catch(error => setError(describeError(error)))
      .then(() => setBusyUid(''), () => setBusyUid(''))
  }

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
        maxWidth: '620px',
        margin: '0 auto',
        width: '100%'
      },
      children: [
        jsx(CelebrationToast, { cheer }),
        jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
          children: [
            jsx(NavButton, {
              label: '← Zurück zum Monat',
              title: 'Zurück zur Monatsansicht',
              onClick: () => setMode('month')
            }),
            jsx('div', {
              style: {
                fontWeight: 700,
                fontSize: '0.95rem',
                color: 'var(--ui-text-primary)'
              },
              children: longDate(selected)
            })
          ]
        }),
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

  return jsxs('div', {
    style: {
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      maxWidth: '760px',
      margin: '0 auto',
      width: '100%'
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [
          jsx(NavButton, { label: '←', title: 'Voriger Monat', onClick: () => shift(-1) }),
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
          jsx(NavButton, { label: '→', title: 'Nächster Monat', onClick: () => shift(1) }),
          jsx(NavButton, { label: 'Heute', title: 'Zum heutigen Tag', onClick: goToday })
        ]
      }),
      jsx(MonthGrid, {
        year: month.year,
        month: month.month,
        days: days || {},
        loading,
        onPick: open
      })
    ]
  })
}

function FokusPage({ ctx }) {
  const api = makeApi(ctx)
  const [tab, setTab] = useState(() => ctx.storage.get(STORAGE_TAB_KEY, 'fokus'))
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
      jsx(Tabs, { value: tab, onChange: setTab }),
      error
        ? jsx('div', {
            style: { padding: '12px 16px' },
            children: jsx(Notice, { tone: 'quiet', children: error })
          })
        : null,
      jsx('div', {
        style: { flex: 1, minHeight: 0, overflowY: 'auto' },
        children:
          tab === 'fokus'
            ? jsx(FokusView, { api, state: focus, reload, setError })
            : tab === 'fortschritt'
              ? jsx(ProgressView, { data: progress, loading: progressLoading })
              : tab === 'kalender'
                ? jsx(CalendarView, {
                    api,
                    month: calMonth,
                    days: monthDays,
                    loading: monthLoading,
                    onMonth: setCalMonth,
                    onRefresh: () => loadMonth(calMonth.year, calMonth.month),
                    setError
                  })
                : jsx(TagView, { items: day.items || [], date: day.date, loading: dayLoading })
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
  name: 'Fokus',
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
        data: { path: ROUTE, label: 'Fokus', codicon: 'target' }
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
          id: 'hermes-fokus.open',
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
