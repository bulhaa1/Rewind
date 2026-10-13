import { useEffect, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { api, read } from '../../lib/api'
import { configQuery } from '../../lib/queries'
import { useObsStatus } from '../../lib/context'
import { Titlebar } from '../titlebar'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '../settings'
import { cn } from '../ui'

/**
 * The spine, in the order the capture pipeline actually runs.
 *
 * Numbered because the order is information: a clip's life goes source, mix,
 * encoder, files. Naming it that way costs nothing and says what the page is for.
 */
const SECTIONS: { id: SettingsSectionId; index: string; label: string }[] = [
  { id: 'capture', index: '01', label: 'Capture' },
  { id: 'audio', index: '02', label: 'Audio' },
  { id: 'encoder', index: '03', label: 'Encoder' },
  { id: 'replay', index: '04', label: 'Replay' },
  { id: 'hotkeys', index: '05', label: 'Hotkeys' },
  { id: 'system', index: '06', label: 'System' },
]

/** Escape and the arrows must not fight a field the user is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * Settings, as a signal path rather than a preferences page.
 *
 * One section on the spine at a time — the window configures a device instead of
 * scrolling a wall of controls — and the strip along the bottom always answers
 * "what is this machine set to do", whatever section is open.
 */
export function SettingsView({ onBack }: { onBack: () => void }) {
  const [active, setActive] = useState<SettingsSectionId>('capture')
  const { status } = useObsStatus()
  const { data: config } = useQuery(configQuery)
  const { data: codec } = useQuery({ queryKey: ['vitals', 'codec'], queryFn: () => read(api.getVideoCodec(), '') })
  const { data: quality } = useQuery({ queryKey: ['vitals', 'quality'], queryFn: () => read(api.getVisualQuality(), '') })
  const { data: resolution } = useQuery({
    queryKey: ['vitals', 'resolution'],
    queryFn: () => read(api.getOutputResolution(), 'native'),
  })
  const [vendor, setVendor] = useState<string>('')

  useEffect(() => {
    void api.getActiveEncoderVendor().then((res) => {
      if (res.success && typeof res.data === 'string') setVendor(res.data)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'Escape') {
        onBack()
        return
      }
      const index = SECTIONS.findIndex((s) => s.id === active)
      if (e.key === 'ArrowDown') setActive(SECTIONS[Math.min(index + 1, SECTIONS.length - 1)].id)
      if (e.key === 'ArrowUp') setActive(SECTIONS[Math.max(index - 1, 0)].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onBack])

  const parts = SETTINGS_SECTIONS[active] as unknown as Array<() => JSX.Element>

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-canvas">
      <Titlebar />

      <div className="flex min-h-0 flex-1">
        <nav
          data-testid="settings-spine"
          className="relative w-[196px] shrink-0 border-r border-line px-3 py-3"
        >
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 mb-3 flex items-center gap-1 rounded px-1 py-1 text-[11px] text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
            Panel
          </button>

          {/* The spine: one hairline through the numbered nodes. */}
          <div className="absolute bottom-6 left-[26px] top-[54px] w-px bg-line" aria-hidden="true" />

          <ul className="relative flex flex-col gap-0.5">
            {SECTIONS.map((section) => {
              const current = section.id === active
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    data-testid={`settings-nav-${section.id}`}
                    data-section={section.id}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => setActive(section.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                      current ? 'bg-raised' : 'hover:bg-raised/60',
                    )}
                  >
                    <span
                      className={cn(
                        'tabular relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]',
                        current ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-canvas text-ink-faint',
                      )}
                    >
                      {section.index}
                    </span>
                    <span className={cn('text-[12px]', current ? 'text-ink' : 'text-ink-muted')}>{section.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <main data-testid="settings-content" className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            {parts.map((Section, i) => (
              <Section key={i} />
            ))}
          </div>
        </main>
      </div>

      {/* Vitals: what this machine is actually set to do, whatever is open. */}
      <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line px-3.5 text-[11px] text-ink-muted">
        <span className="tabular">
          {vendor || 'encoder'}
          {codec ? ` · ${String(codec)}` : ''}
          {quality ? ` · ${String(quality)}` : ''}
        </span>
        <span className="px-0.5 text-line-strong">·</span>
        <span className="tabular">
          {config?.fps ? `${config.fps} fps` : '—'}
          {config?.fpsActual && config.fpsActual !== config.fps ? ` (running ${config.fpsActual})` : ''}
        </span>
        <span className="px-0.5 text-line-strong">·</span>
        <span className="tabular">{resolution ?? 'native'}</span>
        <span className="px-0.5 text-line-strong">·</span>
        <span className="tabular">{config?.bufferDuration ?? 60}s buffer</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              status === 'ready' ? 'bg-accent' : status === 'error' ? 'bg-danger' : 'bg-ink-faint',
            )}
          />
          {status}
        </span>
      </footer>
    </div>
  )
}
