import { type ReactNode } from 'react'
import { ChevronLeft, Settings as SettingsIcon } from 'lucide-react'
import { RewindMark } from './mark'
import { cn } from './ui'
import { UpdateButton } from './update-button'

/** Top bar shared by the panel and settings. */
export function Header({
  title,
  onBack,
  showBackButton,
  backDisabled,
  right,
}: {
  title: string
  onBack?: () => void
  /** Renders a back chevron. Use `onBack` for the handler in the main panel. */
  showBackButton?: boolean
  backDisabled?: boolean
  right?: ReactNode
}) {
  const withBack = showBackButton ?? !!onBack

  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5',
        withBack ? 'bg-surface' : 'bg-canvas',
      )}
    >
      {withBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={backDisabled}
          aria-label="Back"
          className="-ml-1 flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      ) : (
        <span className="text-accent">
          <RewindMark className="h-[18px] w-[18px]" />
        </span>
      )}

      <h1 className="text-[13px] font-semibold tracking-tight">{title}</h1>

      <div className="ml-auto flex items-center gap-1">
        {right}
        {!withBack ? (
          <>
            <UpdateButton />
            <button
              type="button"
              onClick={() => (window.location.hash = '/settings')}
              aria-label="Settings"
              className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
}