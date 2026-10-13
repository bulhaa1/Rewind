import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { twMerge } from 'tailwind-merge'
import clsx, { type ClassValue } from 'clsx'
import { Switch as BaseSwitch } from '@base-ui-components/react/switch'
import { Dialog as BaseDialog } from '@base-ui-components/react/dialog'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const VARIANTS = {
  primary: 'bg-accent text-canvas hover:bg-accent/90 active:bg-accent/80',
  secondary: 'bg-raised text-ink hover:bg-line border border-line',
  ghost: 'text-ink-muted hover:text-ink hover:bg-raised',
  outline: 'border border-line text-ink-muted hover:text-ink hover:border-line-strong',
  danger: 'bg-danger text-ink hover:bg-danger/90',
} as const

const SIZES = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-[13px]',
  icon: 'h-7 w-7 p-0',
  iconSm: 'h-6 w-6 p-0',
} as const

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS
  size?: keyof typeof SIZES
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export function InlineSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-8 items-center justify-center', className)}>
      <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" />
    </div>
  )
}

/** Full-area spinner, for windows that have nothing else to show yet. */
export function CenteredSpinner() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-ink-faint [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        <h2 className="text-[13px] font-semibold">{title}</h2>
      </header>
      <div className="space-y-3.5 p-3">{children}</div>
    </section>
  )
}

export function SectionHeading({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-ink-faint [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
    </div>
  )
}

export function Row({
  label,
  description,
  subline,
  loading = false,
  children,
}: {
  label: string
  description?: string
  /** Extra content under the label, e.g. a fallback warning. */
  subline?: ReactNode
  loading?: boolean
  children: ReactNode
}) {
  // The control sits top-aligned rather than centred: a two-line description is the
  // common case in the encoder rows, and centring leaves the control floating
  // between the label and its own description instead of aligned with the label.
  //
  // The control is allowed to shrink. It used to be `shrink-0`, which handed every
  // spare pixel to a select: a label like "H.264 (most compatible)" then squeezed
  // its own description into three wrapped lines to avoid the value truncating.
  return (
    <div className="flex min-h-7 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <span className="text-[13px]">{label}</span>
        {description ? <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{description}</p> : null}
        {subline}
      </div>
      <div className="flex min-w-0 max-w-[62%] shrink items-center">
        {loading ? <InlineSpinner /> : children}
      </div>
    </div>
  )
}

/**
 * Shortens a path from the middle.
 *
 * Trailing truncation keeps only the tail, which for a save folder is just the
 * parent directory — the least identifying part. Keeping both ends shows where it
 * lives and what it is called, which is what someone checking a setting needs.
 */
function abbreviatePath(p: string, max = 42): string {
  if (p.length <= max) return p
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`
}

export function PathRow({ label, path, onBrowse }: { label: string; path: string; onBrowse: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <span className="text-[13px]">{label}</span>
        <p className="truncate text-[11px] text-ink-faint" title={path}>
          {path ? abbreviatePath(path) : 'Not set'}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onBrowse}>
        Browse
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

const TONES = {
  neutral: 'bg-raised text-ink-muted',
  accent: 'bg-accent-soft text-accent',
} as const

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none',
        TONES[tone],
      )}
    >
      {children}
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  /*
   * Base UI's Switch instead of a styled button: it owns the role, the
   * Space/Enter handling and the keyboard focus behaviour, so this stays
   * presentational. The visual spec is unchanged - 32x18 track, 14px thumb,
   * accent when on.
   */
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block h-3.5 w-3.5 rounded-full bg-canvas transition-transform duration-150',
          checked ? 'translate-x-[15px]' : 'translate-x-[2px]',
        )}
      />
    </BaseSwitch.Root>
  )
}
// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  dismissible = true,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  dismissible?: boolean
}) {
  /*
   * Base UI's Dialog brings the focus trap, the inert background and the
   * focus-return the hand-rolled version only pretended to have: it closed on
   * Escape and on a backdrop click, but Tab walked straight out into the panel
   * behind it. The visual shell is unchanged.
   */
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        // Base UI reports Escape and outside presses here. `dismissible: false`
        // (a busy hotkey capture, say) ignores them: the controlled `open` prop
        // stays true, so the popup does not close.
        if (next || !dismissible) return
        onClose()
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <BaseDialog.Popup
          aria-label={title}
          className="rise fixed left-1/2 top-1/2 z-50 w-full max-w-[320px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-3 shadow-[var(--shadow-pop)] outline-none"
        >
          <div className="mb-2 flex items-center justify-between">
            <BaseDialog.Title className="text-[13px] font-semibold">{title}</BaseDialog.Title>
            {dismissible ? (
              <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
          {children}
          {footer ? <div className="mt-3 flex gap-2">{footer}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Dropdown menu.
 *
 * Rendered into a portal on `document.body`, which is the only thing that actually
 * works here. The menu lives inside virtualized rows that carry a
 * `transform: translateY(...)`, and a transformed ancestor becomes the containing
 * block for `position: fixed` — so an in-place fixed element is positioned against
 * the row and clipped by the scrolling list that contains it. Portalling puts the
 * menu under the viewport again, with no clipping, no z-index ladder and no
 * fighting the virtualizer.
 *
 * Keyboard: opening moves focus onto an item, Up/Down/Home/End move between items,
 * Escape dismisses and hands focus back to the trigger, Tab dismisses. Closing on
 * item activation belongs here rather than in each caller — every caller had to
 * remember it, the settings dropdowns did not, and a select that stays open after
 * the value has already changed reads as a broken control.
 */
const MenuContext = createContext<{ close: () => void }>({ close: () => {} })

export function Menu({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'end',
  label,
  initialFocusIndex,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  /** Names the menu; a portal is not labelled by the control that opened it. */
  label?: string
  /** Which item takes focus on open. Defaults to the first enabled one. */
  initialFocusIndex?: number
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  // Resolved after mount so the menu cannot render into a document that does not
  // exist yet, which is what happens during the editor window's first paint.
  useEffect(() => setPortalTarget(document.body), [])

  const menuRef = useRef<HTMLDivElement>(null)

  const focusTrigger = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const inner = anchor.querySelector<HTMLElement>('button, [href], input, select, textarea')
    ;(inner ?? (anchor as HTMLElement)).focus?.()
  }, [])

  const enabledItems = useCallback((): HTMLButtonElement[] => {
    const root = menuRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-menu-item]:not(:disabled)'))
  }, [])

  /** Moves focus by `delta` items, wrapping at both ends. */
  const focusItem = useCallback(
    (index: number) => {
      const items = enabledItems()
      if (!items.length) return
      const target = ((index % items.length) + items.length) % items.length
      items.forEach((el, i) => el.setAttribute('tabindex', i === target ? '0' : '-1'))
      items[target].focus()
    },
    [enabledItems],
  )

  /**
   * Positions the menu against its trigger, then clamps it into the window.
   *
   * The clamp is what makes the menu usable near the edges: the clip list scrolls
   * inside a short panel, so a trigger near the bottom used to place the menu
   * below it and off-screen, where it rendered perfectly and could not be clicked.
   * Measuring the rendered menu rather than estimating its height also means the
   * flip lands correctly whatever the menu ends up containing.
   */
  const place = useCallback(() => {
    const el = anchorRef.current
    if (!el) return

    const anchor = el.getBoundingClientRect()
    const width = menuRef.current?.offsetWidth || 176
    const height = menuRef.current?.offsetHeight || 4 * 30 + 12
    const gap = 4
    const margin = 8

    const fitsBelow = window.innerHeight - anchor.bottom - gap >= height
    const top = fitsBelow ? anchor.bottom + gap : anchor.top - height - gap

    const preferredLeft = align === 'end' ? anchor.right - width : anchor.left
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin))

    // Never let it leave the window: clamp rather than overflow.
    const clampedTop = Math.max(margin, Math.min(top, window.innerHeight - height - margin))

    setPos({ top: clampedTop, left })
  }, [align])

  useEffect(() => {
    if (!open) return
    place()
    // Re-place once the menu has been laid out, so the first measurement is of the
    // real thing rather than an estimate.
    const raf = requestAnimationFrame(place)

    const onDown = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return
      if ((e.target as HTMLElement).closest?.('[data-menu]')) return
      // No focus restore here: the click landed on something else, and yanking
      // focus back to the trigger would fight whatever the user actually pressed.
      onOpenChange(false)
    }
    const onScroll = () => place()

    window.addEventListener('resize', place)
    window.addEventListener('mousedown', onDown)
    // Capture phase, because the list scrolls inside a container rather than on
    // the window, and the menu is fixed to the viewport.
    window.addEventListener('scroll', onScroll, true)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, place, onOpenChange, focusTrigger])

  // Focus enters the menu only once it has actually rendered, or there is nothing
  // to land on.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => focusItem(initialFocusIndex ?? 0))
    return () => cancelAnimationFrame(raf)
  }, [open, focusItem, initialFocusIndex])

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems()
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusItem(current + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusItem(current - 1)
        break
      case 'Home':
        e.preventDefault()
        focusItem(0)
        break
      case 'End':
        e.preventDefault()
        focusItem(items.length - 1)
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'Tab':
        // A popup is dismissed by tabbing out of it.
        onOpenChange(false)
        break
      default:
        break
    }
  }

  /**
   * Closes the menu and hands focus back to the trigger.
   *
   * The menu lives in a portal, so closing it unmounts the element that had focus;
   * without this, picking an item dropped focus onto `<body>` and a keyboard user
   * had to tab the whole panel to get back to where they were.
   */
  const close = useCallback(() => {
    onOpenChange(false)
    focusTrigger()
  }, [onOpenChange, focusTrigger])

  // The trigger is an arbitrary node, so the popup relationship is declared on it
  // by cloning the one element it wraps instead of wrapping it in another box.
  const decoratedTrigger = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })
    : trigger

  return (
    <>
      <div
        ref={anchorRef}
        onClick={(e) => {
          // The trigger usually sits inside a clickable row; without this, opening
          // the menu also triggers the row action.
          e.stopPropagation()
          onOpenChange(!open)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          if (!open) onOpenChange(true)
        }}
      >
        {decoratedTrigger}
      </div>

      {open && portalTarget
        ? createPortal(
            <MenuContext.Provider value={{ close }}>
              <div
                ref={menuRef}
                data-menu
                role="menu"
                aria-label={label}
                style={{ top: pos.top, left: pos.left, width: 176 }}
                className="rise fixed z-[100] overflow-hidden rounded-md border border-line bg-raised p-0.5 shadow-[var(--shadow-raise)]"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={onMenuKeyDown}
              >
                {children}
              </div>
            </MenuContext.Provider>,
            portalTarget,
          )
        : null}
    </>
  )
}

export function MenuItem({
  onSelect,
  destructive,
  disabled,
  selected,
  children,
}: {
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
  /** Marks the item standing for the control's current value. */
  selected?: boolean
  children: ReactNode
}) {
  const { close } = useContext(MenuContext)

  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item
      aria-current={selected || undefined}
      tabIndex={-1}
      disabled={disabled}
      onClick={() => {
        // Closing here, not in each caller: the value has already changed, so a
        // menu left hanging open is a control that looks stuck.
        close()
        onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        selected ? 'bg-line text-ink' : destructive ? 'text-danger hover:bg-danger/10' : 'hover:bg-line',
      )}
    >
      {children}
    </button>
  )
}

