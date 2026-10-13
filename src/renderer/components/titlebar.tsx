import { Settings as SettingsIcon } from 'lucide-react'
import { RewindMark } from './mark'
import { UpdateButton } from './update-button'

/**
 * The window's own bar.
 *
 * The window is frameless with a native `titleBarOverlay`, so Windows draws the
 * real caption buttons at the top-right and keeps snap layouts, the window menu
 * and double-click-to-maximize working. This bar supplies what the overlay cannot:
 * the identity on the left and the two app actions beside the caption buttons.
 *
 * The bar is the drag region. Anything clickable inside it opts out with
 * `no-drag`, or the window swallows the click. The right padding reserves the
 * strip the native caption buttons occupy.
 */
export function Titlebar() {
  return (
    <header
      data-testid="titlebar"
      className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-line bg-canvas pl-3.5 pr-[150px]"
    >
      <span className="text-accent">
        <RewindMark className="h-[18px] w-[18px]" />
      </span>
      <h1 className="text-[13px] font-semibold tracking-tight">Rewind</h1>

      <div className="no-drag ml-auto flex items-center gap-1">
        <UpdateButton />
        <button
          type="button"
          data-testid="titlebar-settings"
          onClick={() => (window.location.hash = '/settings')}
          aria-label="Settings"
          className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <SettingsIcon className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
    </header>
  )
}
