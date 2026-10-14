import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { MotionConfig } from 'motion/react'
import { queryClient } from './lib/queries'
import { BackgroundActionProvider, ObsStatusProvider, useLibraryInvalidation } from './lib/context'
import { useNotificationSound, usePopupWindow, useEditorClipPath } from './lib/hooks'
import { MainView } from './pages/MainView'
import { SettingsView } from './components/settings/SettingsView'
import { EditorPage } from './components/editor'
import { NotificationOverlay } from './pages/NotificationOverlay'
import { RestartOverlay } from './components/restart-overlay'

/**
 * Chooses which surface to render.
 *
 * All three Rewind windows load this same entry point; they are distinguished by
 * query string rather than by route:
 *
 *   (none)                    the main panel, hash-routed
 *   ?editor=1&clipPath=...    the clip editor
 *   ?notification=<type>      the transient popup
 *
 * The editor and popup must resolve before the main panel mounts, otherwise the
 * panel would briefly flash in a window that should show something else.
 */
function Surface() {
  const popup = usePopupWindow()
  const editorClip = useEditorClipPath()

  if (popup) return <NotificationOverlay type={popup.type} message={popup.message} title={popup.title} onClick={popup.onClick} />
  if (editorClip) return <EditorPage clipPath={editorClip} />
  return <RoutedPanel />
}

/**
 * Hash routing for the main panel.
 *
 * `file://` documents can't use the History API, so `#/settings` is the only
 * navigation scheme that works in a packaged build.
 */
function RoutedPanel() {
  // Electron restores the window URL across restarts, which left the app reopening
  // on Settings instead of the panel. This is a tray utility: launching it should
  // land on the capture controls, not somewhere the user left off.
  const [route, setRoute] = useState(() => {
    const initial = window.location.hash.slice(1) || '/'
    if (initial !== '/') window.location.hash = '/'
    return initial === '/settings' ? '/' : initial
  })

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const goHome = useCallback(() => {
    // Assigning the same hash fires no event, so the route is set directly as well.
    // Otherwise pressing back on an already-current route silently does nothing.
    window.location.hash = '/'
    setRoute('/')
  }, [])

  // Escape leaves settings from anywhere in the page, not just the chevron.
  useEffect(() => {
    if (!route.startsWith('/settings')) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTypingTarget(e.target)) goHome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [route, goHome])

  return (
    <div className="h-full">
      {route.startsWith('/settings') ? (
        <SettingsView onBack={goHome} initialSection={route.split('/')[2]} />
      ) : (
        <MainView />
      )}
      {/*
        Mounted outside the routed surface so it survives navigation and covers
        whichever page is showing — a restart triggered from Settings must not
        leave the panel behind it interactive.
      */}
      <RestartOverlay />
    </div>
  )
}

/** Escape inside a text field should cancel the field, not leave the page. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ObsStatusProvider>
          <BackgroundActionProvider>
            <AppEffects />
            <div className="h-full">
              <Surface />
            </div>
            {/*
              Styled from the same tokens as everything else. These previously named
              `--color-card` / `--color-border` / `--color-foreground`, which no longer
              exist: an unresolvable var invalidates the whole declaration, so error
              toasts — the one thing a user needs when a setting fails — rendered with
              no background, no border and no text colour.
            */}
            <Toaster
              position="bottom-center"
              theme="dark"
              toastOptions={{
                style: {
                  background: 'var(--color-raised)',
                  border: '1px solid var(--color-line-strong)',
                  color: 'var(--color-ink)',
                },
              }}
            />
          </BackgroundActionProvider>
        </ObsStatusProvider>
      </QueryClientProvider>
    </MotionConfig>
  )
}

/** Cross-cutting subscriptions that every window needs. */
function AppEffects() {
  useNotificationSound()
  useLibraryInvalidation()
  return null
}
