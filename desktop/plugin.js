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
    capture: title => call('/capture', 'POST', { title }),
    focus: () => call('/focus', 'GET'),
    complete: uid => call('/focus/complete', 'POST', { uid }),
    defer: uid => call('/focus/defer', 'POST', { uid, minutes: DEFER_MINUTES }),
    breakdown: (uid, steps) => call('/focus/breakdown', 'POST', { uid, steps }),
    day: () => call('/day', 'GET'),
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
    children: [tab('fokus', 'Fokus'), tab('tag', 'Tagesübersicht')]
  })
}

function FokusView({ api, state, reload, setError }) {
  const [breaking, setBreaking] = useState(false)
  const [steps, setSteps] = useState('')
  const [busy, setBusy] = useState(false)
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
      minHeight: '100%'
    },
    children: [
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
            onClick: () => act(() => api.complete(task.uid)),
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

function FokusPage({ ctx }) {
  const api = makeApi(ctx)
  const [tab, setTab] = useState(() => ctx.storage.get(STORAGE_TAB_KEY, 'fokus'))
  const [focus, setFocus] = useState({ task: null, inbox: 0 })
  const [day, setDay] = useState({ items: [], date: '' })
  const [dayLoading, setDayLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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

  useEffect(() => {
    void loadFocus()
  }, [loadFocus])

  useEffect(() => {
    ctx.storage.set(STORAGE_TAB_KEY, tab)
    if (tab === 'tag') void loadDay()
  }, [tab, loadDay])

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
