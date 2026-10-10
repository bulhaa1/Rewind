import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Camera, FolderOpen, Film, Image as ImageIcon, MoreHorizontal, Pencil, Scissors, Trash2 } from 'lucide-react'
import { api, formatBytes, formatDuration, formatSourceName, formatTimestamp, messageOf } from '../lib/api'
import { Badge, Button, Dialog, InlineSpinner, Menu, MenuItem, MenuSeparator, cn } from './ui'
import type { ClipInfo, ScreenshotInfo } from '@shared/types.js'

const ROW_HEIGHT = 58
const OVERSCAN = 6

/** Newest first, de-duplicated by path. */
function sortNewest<T extends { path: string; recordedAt?: number; capturedAt?: number }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items
    .filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)))
    .sort((a, b) => (b.recordedAt ?? b.capturedAt ?? 0) - (a.recordedAt ?? a.capturedAt ?? 0))
}

/** Lazily loaded thumbnail; falls back to a glyph while pending or on failure. */
function Thumb({ cacheKey, fetch, fallback, duration }: { cacheKey: string; fetch: () => Promise<any>; fallback: React.ReactNode; duration?: string }) {
  const { data } = useQuery({
    queryKey: ['thumb', cacheKey],
    queryFn: async () => {
      const res = await fetch()
      return res?.success ? (res.data ?? null) : null
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

  return (
    <div className="relative h-[38px] w-[62px] shrink-0 overflow-hidden rounded bg-raised">
      {data ? <img src={data} alt="" draggable={false} className="h-full w-full object-cover" /> : fallback}
      {duration ? (
        <span className="tabular absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 text-[9px] leading-tight">
          {duration}
        </span>
      ) : null}
    </div>
  )
}

/** Virtualized rows with the open-menu row lifted above its siblings. */
function VirtualList({
  items,
  renderRow,
}: {
  items: unknown[]
  renderRow: (item: any) => React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT + 6,
    overscan: OVERSCAN,
  })

  return (
    <div ref={scrollRef} className="scroll-clean min-h-0 flex-1 overflow-y-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index] as any
          return (
            <div
              key={item.id}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
              }}
            >
              {renderRow(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ListHeader({
  view,
  onViewChange,
  onOpenFolder,
}: {
  view: 'clips' | 'screenshots'
  onViewChange: (v: 'clips' | 'screenshots') => void
  onOpenFolder: () => void
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between px-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="iconSm"
          onClick={() => onViewChange(view === 'clips' ? 'screenshots' : 'clips')}
          aria-label={view === 'clips' ? 'Show screenshots' : 'Show clips'}
          title={view === 'clips' ? 'Show screenshots' : 'Show clips'}
        >
          {view === 'clips' ? <Film className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
        </Button>
        <span className="label">{view === 'clips' ? 'Recent clips' : 'Recent screenshots'}</span>
      </div>
      <Button variant="ghost" size="iconSm" onClick={onOpenFolder} aria-label="Open folder" title="Open folder">
        <FolderOpen className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export function EmptyState({ kind }: { kind: 'clips' | 'screenshots' }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
      {kind === 'clips' ? (
        <Film className="h-6 w-6 text-line-strong" />
      ) : (
        <Camera className="h-6 w-6 text-line-strong" />
      )}
      <p className="text-[13px] text-ink-muted">{kind === 'clips' ? 'No clips yet' : 'No screenshots yet'}</p>
      <p className="text-[11px] text-ink-faint">
        {kind === 'clips' ? 'Press Save Clip to keep the last moment.' : 'Screenshots you take appear here.'}
      </p>
    </div>
  )
}

/**
 * A library row.
 *
 * The row is the primary action — open the file — so it is a real button rather
 * than a div with a click handler, which gave the list no keyboard path at all and
 * left the menu button nested inside an unreachable control. The menu keeps its
 * own trigger, so its activation is stopped here.
 */
function MediaRow({
  title,
  subtitle,
  meta,
  badge,
  thumb,
  actions,
  onOpen,
  onContextMenu,
}: {
  title: string
  subtitle: string
  meta: string
  badge?: React.ReactNode
  thumb: React.ReactNode
  actions: React.ReactNode
  onOpen: () => void
  onContextMenu: () => void
}) {
  return (
    <div className="px-0.5 pb-1.5">
      <div
        role="button"
        tabIndex={0}
        title={`Open ${title}`}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onOpen()
        }}
        className={cn(
          'group flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent bg-surface p-1.5 transition-colors',
          'hover:border-line hover:bg-raised',
        )}
      >
        {thumb}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[12px] font-medium">{title}</span>
          <span className="truncate text-[11px] text-ink-faint">{subtitle}</span>
          <span className="truncate text-[10px] text-ink-faint">{meta}</span>
        </div>

        {badge}

        <span onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
    </div>
  )
}

export function ClipList({
  clips,
  loading,
  view,
  onViewChange,
  onDelete,
  onRename,
  onOpenFolder,
}: {
  clips: ClipInfo[]
  loading: boolean
  view: 'clips' | 'screenshots'
  onViewChange: (v: 'clips' | 'screenshots') => void
  onDelete: (path: string) => void
  onRename: (path: string, name: string) => Promise<void>
  onOpenFolder: () => void
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<ClipInfo | null>(null)
  const sorted = sortNewest(clips)

  const reveal = useCallback(
    async (clip: ClipInfo) => {
      const res = await api.showClipInFolder(clip.path)
      if (!res.success) window.dispatchEvent(new CustomEvent('rewind:refresh-clips'))
    },
    [],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader view={view} onViewChange={onViewChange} onOpenFolder={onOpenFolder} />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <InlineSpinner />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState kind="clips" />
      ) : (
        <VirtualList
          items={sorted}
          renderRow={(clip: ClipInfo) => (
            <MediaRow
              title={formatSourceName(clip.sourceName)}
              subtitle={clip.filename}
              meta={`${formatTimestamp(clip.recordedAt)}${clip.fileSize ? ` · ${formatBytes(clip.fileSize)}` : ''}`}
              badge={clip.edited ? <Badge tone="accent">Edited</Badge> : null}
              onOpen={() => void api.openFile(clip.path)}
              onContextMenu={() => setMenuFor(clip.id)}
              thumb={
                <Thumb
                  cacheKey={`${clip.path}|${clip.editedAt ?? ''}`}
                  fetch={() => api.getClipThumbnail(clip.path)}
                  fallback={<Film className="mx-auto h-3.5 w-3.5 text-accent" />}
                  duration={clip.duration > 0 ? formatDuration(clip.duration) : undefined}
                />
              }
              actions={
                <Menu
                  open={menuFor === clip.id}
                  onOpenChange={(o) => setMenuFor(o ? clip.id : null)}
                  trigger={
                    <Button variant="ghost" size="iconSm" aria-label="Clip actions" title="Clip actions">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  }
                >
                  <MenuItem onSelect={() => void reveal(clip)}>
                    <FolderOpen className="h-3.5 w-3.5" /> Show in folder
                  </MenuItem>
                  <MenuItem onSelect={() => setRenaming(clip)}>
                    <Pencil className="h-3.5 w-3.5" /> Rename
                  </MenuItem>
                  <MenuItem onSelect={() => void api.openClipEditor(clip.path)}>
                    <Scissors className="h-3.5 w-3.5" /> Trim
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => onDelete(clip.path)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </MenuItem>
                </Menu>
              }
            />
          )}
        />
      )}

      <RenameDialog
        clip={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (path, name) => {
          setRenaming(null)
          await onRename(path, name)
        }}
      />
    </div>
  )
}

export function ScreenshotList({
  screenshots,
  loading,
  view,
  onViewChange,
  onDelete,
  onOpenFolder,
}: {
  screenshots: ScreenshotInfo[]
  loading: boolean
  view: 'clips' | 'screenshots'
  onViewChange: (v: 'clips' | 'screenshots') => void
  onDelete: (path: string) => void
  onOpenFolder: () => void
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const sorted = sortNewest(screenshots)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader view={view} onViewChange={onViewChange} onOpenFolder={onOpenFolder} />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <InlineSpinner />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState kind="screenshots" />
      ) : (
        <VirtualList
          items={sorted}
          renderRow={(shot: ScreenshotInfo) => (
            <MediaRow
              title={formatSourceName(shot.source)}
              subtitle={shot.name}
              meta={`${formatTimestamp(shot.capturedAt)}${shot.size ? ` · ${formatBytes(shot.size)}` : ''}`}
              onOpen={() => void api.openScreenshot(shot.path)}
              onContextMenu={() => setMenuFor(shot.id)}
              thumb={
                <Thumb
                  cacheKey={shot.path}
                  fetch={() => api.getScreenshotThumbnail(shot.path)}
                  fallback={<ImageIcon className="mx-auto h-3.5 w-3.5 text-accent" />}
                />
              }
              actions={
                <Menu
                  open={menuFor === shot.id}
                  onOpenChange={(o) => setMenuFor(o ? shot.id : null)}
                  trigger={
                    <Button variant="ghost" size="iconSm" aria-label="Screenshot actions" title="Screenshot actions">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  }
                >
                  <MenuItem onSelect={() => void api.showScreenshotInFolder(shot.path)}>
                    <FolderOpen className="h-3.5 w-3.5" /> Show in folder
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => onDelete(shot.path)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </MenuItem>
                </Menu>
              }
            />
          )}
        />
      )}
    </div>
  )
}

/** Rename with the same validation the main process enforces. */
function RenameDialog({
  clip,
  onClose,
  onSave,
}: {
  clip: ClipInfo | null
  onClose: () => void
  onSave: (path: string, name: string) => Promise<void>
}) {
  const initial = clip ? clip.filename.replace(/\.[^.]+$/, '') : ''
  const ext = clip ? (clip.filename.match(/\.[^.]+$/)?.[0] ?? '') : ''
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(initial)
    setError(null)
  }, [initial])

  const submit = async () => {
    if (!clip || busy) return
    const name = value.trim()
    if (!name) return setError('Name cannot be empty')
    if (name === initial) return onClose()

    setBusy(true)
    try {
      await onSave(clip.path, name)
    } catch (e) {
      setError(messageOf(e, 'Could not rename'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!clip}
      title="Rename clip"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" size="sm" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="flex-1" onClick={() => void submit()} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : 'Rename'}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          disabled={busy}
          aria-label="Clip name"
          autoFocus
          className="h-7 min-w-0 flex-1 rounded border border-line bg-raised px-2 text-[12px] outline-none focus:border-accent"
        />
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">{ext}</span>
      </div>
      {error ? <p className="mt-1.5 text-[11px] text-danger">{error}</p> : null}
    </Dialog>
  )
}