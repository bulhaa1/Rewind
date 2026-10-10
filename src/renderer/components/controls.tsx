import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { read, unwrap } from '../lib/api'
import { useBackgroundAction } from '../lib/context'
import { Menu, MenuItem, Switch, cn } from './ui'

export interface Option<T> {
  value: T
  label: string
  /** Right-aligned secondary text, e.g. "(GPU)". */
  note?: string
  disabled?: boolean
}

/**
 * Dropdown select.
 *
 * Built on a custom menu rather than a native `<select>` so option rows can carry
 * icons and trailing notes, and so the control matches the panel's dark chrome.
 */
export function Select<T extends string | number>({
  value,
  options,
  onSelect,
  label,
  emptyLabel,
  disabled,
  align = 'end',
  icon,
  iconOnly = false,
  className,
  fallbackLabel,
}: {
  value: T | undefined
  options: Option<T>[]
  onSelect: (value: T) => void
  label?: string
  emptyLabel?: string
  disabled?: boolean
  align?: 'start' | 'end'
  icon?: React.ReactNode
  iconOnly?: boolean
  className?: string
  fallbackLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const isEmpty = options.length === 0
  const selected = value !== undefined ? options.find((o) => o.value === value) : undefined

  const display = selected?.label ?? (isEmpty && emptyLabel ? emptyLabel : (fallbackLabel ?? (value !== undefined ? String(value) : (label ?? ''))))

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      align={align}
      label={label ?? display}
      initialFocusIndex={Math.max(0, options.findIndex((o) => o.value === value))}
      trigger={
        <button
          type="button"
          disabled={disabled || isEmpty}
          title={display}
          aria-label={iconOnly ? display : undefined}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-raised/50 px-2.5 py-1.5 text-[13px]',
            'text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50',
            iconOnly && 'w-9 justify-center px-0',
            className,
          )}
        >
          {icon ? <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span> : null}
          {iconOnly ? null : (
            <>
              <span className="min-w-0 truncate">{display}</span>
              <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-60" />
            </>
          )}
        </button>
      }
    >
      {options.map((option) => (
        <MenuItem
          key={String(option.value)}
          disabled={option.disabled}
          selected={option.value === value}
          onSelect={() => onSelect(option.value)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
          {option.note ? <span className="ml-auto shrink-0 pl-2 text-ink-muted">{option.note}</span> : null}
        </MenuItem>
      ))}
    </Menu>
  )
}

/**
 * Binds a select to a persisted setting.
 *
 * Optimistically writes the new value into the cache so the control responds
 * instantly, then rolls back and refetches if the setter rejects — which it
 * commonly does, since several of these restart OBS.
 */
export function SettingSelect<T extends string | number>({
  binding,
  initial,
  options,
  label,
  onSuccess,
  className,
  align,
  icon,
  iconOnly,
  emptyLabel,
}: {
  binding: { queryKey: readonly unknown[]; get: () => Promise<any>; set: (value: T) => Promise<any> }
  initial: T
  options: Option<T>[]
  /** Accessible name for the dropdown; several selects on one row need distinct ones. */
  label?: string
  onSuccess?: () => Promise<void> | void
  className?: string
  align?: 'start' | 'end'
  icon?: React.ReactNode
  iconOnly?: boolean
  emptyLabel?: string
}) {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()

  const { data } = useQuery({
    queryKey: binding.queryKey,
    queryFn: () => read(binding.get(), initial),
    staleTime: 30_000,
  })

  const change = useCallback(
    (value: T) => {
      void runAction(async () => {
        client.setQueryData(binding.queryKey, value)
        try {
          await unwrap(binding.set(value))
        } catch (e) {
          // The engine may have partially applied the change; refetch for truth.
          await client.invalidateQueries({ queryKey: binding.queryKey })
          throw e
        }
        await onSuccess?.()
      })
    },
    [runAction, client, binding, onSuccess],
  )

  void reportError

  return (
    <Select
      value={(data as T | undefined) ?? initial}
      options={options}
      onSelect={change}
      className={className}
      align={align}
      icon={icon}
      iconOnly={iconOnly}
      emptyLabel={emptyLabel}
      label={label ?? 'Select an option'}
    />
  )
}

/** Toggle bound to a persisted boolean setting. */
export function SettingSwitch({
  binding,
  label,
  disabled,
  onSuccess,
}: {
  binding: { queryKey: readonly unknown[]; get: () => Promise<any>; set: (value: boolean) => Promise<any> }
  /** Names the control for assistive technology; the row's text is not a `<label>`. */
  label: string
  disabled?: boolean
  onSuccess?: () => Promise<void> | void
}) {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()

  const { data } = useQuery({
    queryKey: binding.queryKey,
    queryFn: () => read(binding.get(), false),
    staleTime: 30_000,
  })

  const change = useCallback(
    (value: boolean) => {
      void runAction(async () => {
        client.setQueryData(binding.queryKey, value)
        try {
          await unwrap(binding.set(value))
        } catch (e) {
          await client.invalidateQueries({ queryKey: binding.queryKey })
          throw e
        }
        await onSuccess?.()
      })
    },
    [runAction, client, binding, onSuccess],
  )

  return <Switch checked={!!data} onChange={change} label={label} disabled={disabled} />
}

/** A labelled switch row wired to a persisted setting. */
export function SettingSwitchRow({
  binding,
  label,
  description,
  disabled,
  subline,
  onSuccess,
}: {
  binding: { queryKey: readonly unknown[]; get: () => Promise<any>; set: (value: boolean) => Promise<any> }
  label: string
  description?: string
  disabled?: boolean
  subline?: React.ReactNode
  onSuccess?: () => Promise<void> | void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span className="text-[13px] font-medium">{label}</span>
        {description ? <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{description}</p> : null}
        {subline}
      </div>
      <div className="pt-0.5">
        <SettingSwitch binding={binding} label={label} disabled={disabled} onSuccess={onSuccess} />
      </div>
    </div>
  )
}
