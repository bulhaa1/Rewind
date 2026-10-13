import { useCallback, useEffect, useRef, useState } from 'react'
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

const CARD_HEIGHT = 236
const OVERSCAN = 4

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
}: {
  cacheKey: string
  fetch: () => Promise<{ success: boolean; data?: string | null }>
  fallback: React.ReactNode
  duration?: string
  overlay?: React.ReactNode
  onHoverChange?: (hovering: boolean) => void
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
      className="relative aspect-video w-full overflow-hidden rounded-md bg-raised"
      data-testid="card-thumb"
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {data ? <img src={data} alt="" draggable={false} className="h-full w-full object-cover" /> : fallback}
      {overlay}
      {duration ? (
        <span className="tabular absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] leading-tight">
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
  const videoRef = useRef<HTMLVideoElement | null>(null)

  if (failed) return null

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
        preload="auto"
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
  isNew,
  onOpenEditor,
  onDelete,
  onRename,
}: {
  clip: ClipInfo
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
          fallback={<Film className="mx-auto mt-[38px] h-4 w-4 text-accent" strokeWidth={1.5} />}
          duration={clip.duration > 0 ? formatDuration(clip.duration) : undefined}
          overlay={hovering ? <ScrubLayer filePath={clip.path} duration={clip.duration} /> : null}
          onHoverChange={setHovering}
        />

        <div className="mt-2 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12px] font-medium">{formatSourceName(clip.sourceName)}</span>
            <span className="truncate text-[11px] text-ink-faint">{clip.filename}</span>
            <span className="tabular truncate text-[10px] text-ink-faint">
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
  onDelete,
}: {
  shot: ScreenshotInfo
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
          fallback={<ImageIcon className="mx-auto mt-[38px] h-4 w-4 text-accent" strokeWidth={1.5} />}
        />

        <div className="mt-2 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12px] font-medium">{formatSourceName(shot.source)}</span>
            <span className="truncate text-[11px] text-ink-faint">{shot.name}</span>
            <span className="tabular truncate text-[10px] text-ink-faint">
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
}: {
  view: View
  onViewChange: (view: View) => void
  onOpenFolder: () => void
  lastSavedAt: number | null
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
  const newestPath = view === 'clips' ? sortedClips[0]?.path : undefined
  const [newFor, setNewFor] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!lastSavedAt || !newestPath) return
    setNewFor(newestPath)
    const id = setTimeout(() => setNewFor(undefined), 4000)
    return () => clearTimeout(id)
  }, [lastSavedAt, newestPath])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT,
    overscan: OVERSCAN,
  })

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
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
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
                      isNew={newFor === item.path}
                      onOpenEditor={() => void api.openClipEditor(item.path)}
                      onDelete={() => setDeleteTarget({ path: item.path, name: (item as ClipInfo).filename })}
                      onRename={() => setRenaming(item as ClipInfo)}
                    />
                  ) : (
                    <ScreenshotCard
                      shot={item as ScreenshotInfo}
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
