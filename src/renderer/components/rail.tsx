import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Menu as BaseMenu } from '@base-ui-components/react/menu'
import { Camera, Film, FolderOpen, Image as ImageIcon, MoreHorizontal, Pencil, Scissors, Trash2 } from 'lucide-react'
import { api, formatBytes, formatDuration, formatSourceName, formatTimestamp, messageOf } from '../lib/api'
import { QK, clipsQuery, hotkeysQuery, screenshotsQuery } from '../lib/queries'
import { SPRING_SNAPPY, SPRING_SOFT } from '../lib/motion'
import { useBackgroundAction } from '../lib/context'
import { Badge, Button, Dialog, InlineSpinner, cn } from './ui'
import type { ClipInfo, DeleteScope, ScreenshotInfo } from '@shared/types.js'

const OVERSCAN = 4

// A card's thumbnail is 16:9, so a row's height follows the rail's width. That
// height is computed here rather than left to `aspect-ratio` so the list can lay
// itself out for the new width in the same paint as the resize: an estimate that
// only catches up a frame later is what stacked the cards on top of each other
// while the divider was being dragged.
const THUMB_RATIO = 9 / 16
/** Everything in a row that is not the thumbnail: card padding, meta block, gap below. */
const ROW_CHROME_FALLBACK = 90
/** First paint only, before there is a row in the DOM to measure. */
const FALLBACK_ROW_WIDTH = 314

/** The thumbnail height a row of this width draws at. */
const thumbHeight = (rowWidth: number) => Math.round(rowWidth * THUMB_RATIO)

type View = 'clips' | 'screenshots'

/** Newest first, de-duplicated by path. */
function sortNewest<T extends { path: string; recordedAt?: number; capturedAt?: number }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items
    .filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)))
    .sort((a, b) => (b.recordedAt ?? b.capturedAt ?? 0) - (a.recordedAt ?? a.capturedAt ?? 0))
}

/** Unwraps an IPC envelope, throwing its error so callers can catch uniformly. */
async function expect<T>(p: Promise<{ success: boolean; data?: T; error?: string }>, fallback: string): Promise<T> {
  const res = await p
  if (!res.success) throw new Error(res.error || fallback)
  return res.data as T
}

/** Lazily loaded thumbnail; falls back to a glyph while pending or on failure. */
function Thumb({
  cacheKey,
  fetch,
  fallback,
  duration,
  overlay,
  onHoverChange,
  height,
}: {
  cacheKey: string
  fetch: () => Promise<{ success: boolean; data?: string | null }>
  fallback: React.ReactNode
  duration?: string
  overlay?: React.ReactNode
  onHoverChange?: (hovering: boolean) => void
  /** Computed from the rail's width, so a row lays out with the resize. */
  height: number
}) {
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
    <div
      className="relative flex w-full items-center justify-center overflow-hidden rounded-md bg-raised"
      style={{ height }}
      data-testid="card-thumb"
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {data ? <img src={data} alt="" draggable={false} className="h-full w-full object-cover" /> : fallback}
      {overlay}
      {duration ? (
        <span className="tabular absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[11px] leading-tight">
          {duration}
        </span>
      ) : null}
    </div>
  )
}

/** The shared context menu: same actions as the old library rows, on Base UI. */
function CardMenu({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <BaseMenu.Root open={open} onOpenChange={onOpenChange}>
      <BaseMenu.Trigger
        aria-label="Clip actions"
        title="Clip actions"
        onClick={(e) => e.stopPropagation()}
        className="flex h-6 w-6 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align="end" className="z-50">
          <BaseMenu.Popup className="min-w-[168px] rounded-lg border border-line bg-surface p-1 shadow-[var(--shadow-pop)] outline-none">
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

function Item({
  icon,
  destructive,
  onSelect,
  children,
}: {
  icon: React.ReactNode
  destructive?: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <BaseMenu.Item
      onClick={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none',
        destructive ? 'text-danger data-[highlighted]:bg-danger/10' : 'text-ink data-[highlighted]:bg-raised',
      )}
    >
      {icon}
      {children}
    </BaseMenu.Item>
  )
}

/** Clip URLs go through the same protocol the editor plays. */
function clipUrl(filePath: string): string {
  return `rewind-clip://local/${encodeURIComponent(filePath)}`
}

/**
 * Hover scrub.
 *
 * A single `<video>` per hovered card, mounted only while the pointer is over the
 * thumbnail and never while the window is hidden. The frame under the cursor is a
 * `currentTime` seek, so a scrub costs one decode per pointer move rather than one
 * playing stream per card in the list.
 *
 * If a clip cannot be decoded (AV1 on an older GPU, a file mid-remux), `failed`
 * latches and the thumbnail stays. A card must never look broken because a preview
 * could not be built.
 */
function ScrubLayer({ filePath, duration }: { filePath: string; duration: number }) {
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // A hidden window must not keep a decoder alive: closing to the tray happens
  // with the pointer still resting on a card.
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  if (failed || hidden) return null

  const seek = (event: React.PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video || !ready || document.hidden) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / Math.max(rect.width, 1), 0), 1)
    const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration
    if (length > 0) video.currentTime = ratio * length
  }

  return (
    <div className="absolute inset-0" data-testid="scrub-layer" onPointerEnter={seek} onPointerMove={seek}>
      <video
        ref={videoRef}
        src={clipUrl(filePath)}
        muted
        playsInline
        preload="metadata"
        onLoadedData={() => setReady(true)}
        onError={() => setFailed(true)}
        className={cn('h-full w-full object-cover transition-opacity', ready ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  )
}

/**
 * One clip card.
 *
 * The card is the primary action and opens the editor — the thing you do with a
 * clip far more often than watching it elsewhere. "Open file" (the old primary
 * click) lives in the menu, so nothing that was reachable before is gone.
 */
function ClipCard({
  clip,
  thumbHeight,
  isNew,
  onOpenEditor,
  onDelete,
  onRename,
}: {
  clip: ClipInfo
  thumbHeight: number
  isNew: boolean
  onOpenEditor: () => void
  onDelete: () => void
  onRename: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovering, setHovering] = useState(false)

  return (
    <motion.div
      className="pb-3"
      initial={isNew ? { opacity: 0.65, scale: 0.985 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING_SNAPPY}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="rail-card"
        data-new={isNew ? '' : undefined}
        title={`Open ${clip.filename} in the editor`}
        onClick={onOpenEditor}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onOpenEditor()
        }}
        className={cn(
          'group flex cursor-pointer flex-col rounded-lg border bg-surface p-2 transition-colors',
          menuOpen ? 'border-line-strong' : 'border-line hover:border-line-strong hover:bg-raised',
          isNew && 'border-accent/50',
        )}
      >
        <Thumb
          cacheKey={`${clip.path}|${clip.editedAt ?? ''}`}
          fetch={() => api.getClipThumbnail(clip.path)}
          fallback={<Film className="h-4 w-4 text-accent" strokeWidth={1.5} />}
          duration={clip.duration > 0 ? formatDuration(clip.duration) : undefined}
          overlay={hovering ? <ScrubLayer filePath={clip.path} duration={clip.duration} /> : null}
          onHoverChange={setHovering}
          height={thumbHeight}
        />

        {/* Fixed height, so a row is exactly thumbnail + chrome at every width. */}
        <div className="mt-2 flex h-[50px] items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12px] font-medium leading-4">{formatSourceName(clip.sourceName)}</span>
            <span className="truncate text-[11px] leading-4 text-ink-faint">{clip.filename}</span>
            <span className="tabular truncate text-[11px] leading-3.5 text-ink-faint">
              {formatTimestamp(clip.recordedAt)}
              {clip.fileSize ? ` · ${formatBytes(clip.fileSize)}` : ''}
            </span>
          </div>
          {clip.edited ? <Badge tone="accent">Edited</Badge> : null}
          <span onClick={(e) => e.stopPropagation()}>
            <CardMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <Item icon={<Scissors className="h-3.5 w-3.5" strokeWidth={1.5} />} onSelect={onOpenEditor}>
                Trim in editor
              </Item>
              <Item
                icon={<FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} />}
                onSelect={() => void api.showClipInFolder(clip.path)}
              >
                Show in folder
              </Item>
              <Item
                icon={<Film className="h-3.5 w-3.5" strokeWidth={1.5} />}
                onSelect={() => void api.openFile(clip.path)}
              >
                Open file
              </Item>
              <Item icon={<Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />} onSelect={onRename}>
                Rename
              </Item>
              <BaseMenu.Separator className="my-1 h-px bg-line" />
              <Item icon={<Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />} destructive onSelect={onDelete}>
                Delete
              </Item>
            </CardMenu>
          </span>
        </div>
      </div>
    </motion.div>
  )
}

/** One screenshot card. Same shell, fewer actions — there is nothing to trim. */
function ScreenshotCard({
  shot,
  thumbHeight,
  onDelete,
}: {
  shot: ScreenshotInfo
  thumbHeight: number
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="pb-3">
      <div
        role="button"
        tabIndex={0}
        data-testid="rail-card"
        title={`Open ${shot.name}`}
        onClick={() => void api.openScreenshot(shot.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          void api.openScreenshot(shot.path)
        }}
        className={cn(
          'group flex cursor-pointer flex-col rounded-lg border bg-surface p-2 transition-colors',
          menuOpen ? 'border-line-strong' : 'border-line hover:border-line-strong hover:bg-raised',
        )}
      >
        <Thumb
          cacheKey={shot.path}
          fetch={() => api.getScreenshotThumbnail(shot.path)}
          fallback={<ImageIcon className="h-4 w-4 text-accent" strokeWidth={1.5} />}
          height={thumbHeight}
        />

        {/* Fixed height, so a row is exactly thumbnail + chrome at every width. */}
        <div className="mt-2 flex h-[50px] items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12px] font-medium leading-4">{formatSourceName(shot.source)}</span>
            <span className="truncate text-[11px] leading-4 text-ink-faint">{shot.name}</span>
            <span className="tabular truncate text-[11px] leading-3.5 text-ink-faint">
              {formatTimestamp(shot.capturedAt)}
              {shot.size ? ` · ${formatBytes(shot.size)}` : ''}
            </span>
          </div>
          <span onClick={(e) => e.stopPropagation()}>
            <CardMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <Item
                icon={<FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} />}
                onSelect={() => void api.showScreenshotInFolder(shot.path)}
              >
                Show in folder
              </Item>
              <BaseMenu.Separator className="my-1 h-px bg-line" />
              <Item icon={<Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />} destructive onSelect={onDelete}>
                Delete
              </Item>
            </CardMenu>
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The clips rail.
 *
 * Fixed-width column on the right of the window: a segmented header, then the
 * virtualized cards. Owns the media actions (open, reveal, rename, delete) so the
 * window component stays about capture.
 */
export function Rail({
  view,
  onViewChange,
  onOpenFolder,
  lastSavedAt,
  railWidth,
}: {
  view: View
  onViewChange: (view: View) => void
  onOpenFolder: () => void
  lastSavedAt: number | null
  /** The rail's current width: a change is the signal to re-lay the list. */
  railWidth: number
}) {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
  const { data: clips = [], isPending: clipsPending } = useQuery(clipsQuery)
  const { data: shots = [], isPending: shotsPending } = useQuery(screenshotsQuery)
  const { data: hotkeys } = useQuery(hotkeysQuery)

  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null)
  const [renaming, setRenaming] = useState<ClipInfo | null>(null)

  const sortedClips = sortNewest(clips)
  const sortedShots = sortNewest(shots)
  const items: (ClipInfo | ScreenshotInfo)[] = view === 'clips' ? sortedClips : sortedShots
  const loading = view === 'clips' ? clipsPending : shotsPending

  // The newest clip wears a ring for a few seconds after a save, so the card
  // that just arrived is the confirmation rather than a toast over the top of it.
  const [newFor, setNewFor] = useState<string | undefined>(undefined)
  useEffect(() => {
    // Reacts to the save event alone. Keying on the newest path as well re-tagged
    // the same clip every time the user switched between clips and screenshots.
    if (!lastSavedAt) return
    const path = sortedClips[0]?.path
    if (!path) return
    setNewFor(path)
    const id = setTimeout(() => setNewFor(undefined), 4000)
    return () => clearTimeout(id)
    // Only a save should re-tag; the newest path is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSavedAt])

  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // A row is its thumbnail (16:9, so it follows the rail's width) plus fixed
  // chrome. Both are measured from the DOM that is on screen, so the row height is
  // right without a box-model sum to keep in sync.
  const [rowWidth, setRowWidth] = useState(FALLBACK_ROW_WIDTH)
  const [rowChrome, setRowChrome] = useState(ROW_CHROME_FALLBACK)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => thumbHeight(rowWidth) + rowChrome,
    overscan: OVERSCAN,
  })

  // Re-lay the list before the browser paints, whenever the rail changes width.
  // Letting each card's ResizeObserver correct the offsets afterwards is a frame
  // too late: that painted frame still holds the old width's heights, and the rows
  // stand on top of each other for as long as the divider is moving.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.firstElementChild
    const thumb = row?.querySelector('[data-testid="card-thumb"]')
    if (row && thumb) {
      const chrome = Math.round(row.getBoundingClientRect().height - thumb.getBoundingClientRect().height)
      if (chrome > 0 && chrome !== rowChrome) setRowChrome(chrome)
    }
    const width = list.clientWidth
    if (width > 0 && width !== rowWidth) setRowWidth(width)
    if (width > 0) {
      // Sizes measured at the previous width no longer describe these cards, and a
      // measurement outranks the estimate: drop them so the estimate is believed.
      virtualizer.measure()
    }
  }, [railWidth, rowWidth, rowChrome, items.length, virtualizer])

  const thumb = thumbHeight(rowWidth)

  const deleteClip = useCallback(
    async (path: string, scope: DeleteScope) => {
      await expect(api.deleteClip(path, scope), 'Failed to delete clip')
      await client.invalidateQueries({ queryKey: QK.clips })
    },
    [client],
  )

  const deleteScreenshot = useCallback(
    async (path: string) => {
      await expect(api.deleteScreenshot(path), 'Failed to delete screenshot')
      await client.invalidateQueries({ queryKey: QK.screenshots })
    },
    [client],
  )

  const renameClip = useCallback(
    async (path: string, name: string) => {
      await expect(api.renameClip(path, name), 'Failed to rename clip')
      await client.invalidateQueries({ queryKey: QK.clips })
    },
    [client],
  )

  const saveHotkey = hotkeys?.['save-replay']

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 px-1" data-testid="rail">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="rail-segment-clips"
            aria-pressed={view === 'clips'}
            onClick={() => onViewChange('clips')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              view === 'clips' ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            Clips
          </button>
          <button
            type="button"
            data-testid="rail-segment-screenshots"
            aria-pressed={view === 'screenshots'}
            onClick={() => onViewChange('screenshots')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              view === 'screenshots' ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            Screenshots
          </button>
          <span className="tabular ml-1 text-[11px] text-ink-faint">{items.length}</span>
        </div>
        <Button variant="ghost" size="iconSm" onClick={onOpenFolder} aria-label="Open folder" title="Open folder">
          <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <InlineSpinner />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
          {view === 'clips' ? (
            <Film className="h-5 w-5 text-line-strong" strokeWidth={1.5} />
          ) : (
            <Camera className="h-5 w-5 text-line-strong" strokeWidth={1.5} />
          )}
          <p className="text-[13px] text-ink-muted">{view === 'clips' ? 'No clips yet' : 'No screenshots yet'}</p>
          <p className="text-[11px] text-ink-faint">
            {view === 'clips'
              ? `Press Save clip${saveHotkey ? ` (${saveHotkey})` : ''} to keep the last moment.`
              : 'Screenshots you take appear here.'}
          </p>
        </div>
      ) : (
        <div ref={scrollRef} className="scroll-clean min-h-0 flex-1 overflow-y-auto pr-0.5">
          <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = items[v.index]
              const isClip = view === 'clips'
              return (
                <div
                  key={item.id}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...SPRING_SOFT, delay: Math.min(v.index, 6) * 0.03 }}
                  >
                  {isClip ? (
                    <ClipCard
                      clip={item as ClipInfo}
                      thumbHeight={thumb}
                      isNew={newFor === item.path}
                      onOpenEditor={() => void api.openClipEditor(item.path)}
                      onDelete={() => setDeleteTarget({ path: item.path, name: (item as ClipInfo).filename })}
                      onRename={() => setRenaming(item as ClipInfo)}
                    />
                  ) : (
                    <ScreenshotCard
                      shot={item as ScreenshotInfo}
                      thumbHeight={thumb}
                      onDelete={() => setDeleteTarget({ path: item.path, name: (item as ScreenshotInfo).name })}
                    />
                  )}
                  </motion.div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <Dialog
        open={!!deleteTarget}
        title="Delete"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (!target) return
                void runAction(async () => {
                  if (view === 'clips') await deleteClip(target.path, 'local')
                  else await deleteScreenshot(target.path)
                })
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">
          Delete <span className="text-ink">{deleteTarget?.name}</span>? This cannot be undone.
        </p>
      </Dialog>

      <RenameDialog
        clip={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (path, name) => {
          setRenaming(null)
          await renameClip(path, name)
        }}
      />
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
