import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Crop, X } from 'lucide-react'
import { api, unwrap } from '../lib/api'
import { QK } from '../lib/queries'
import { Button } from './ui'
import type { ScreenshotInfo } from '@shared/types.js'

type Rect = { x0: number; y0: number; x1: number; y1: number }

/**
 * The screenshot editor: crop plus brightness/contrast/saturation, nothing more.
 *
 * The working bitmap lives on an offscreen canvas; adjustments preview through a
 * CSS filter and are baked in once, at save, through the same filter on the draw.
 * Saving overwrites the original PNG in place after a confirm — the thumbnail
 * cache is dropped main-side, and the rail's query cache is invalidated here.
 */
export function ScreenshotEditor({ shot, onClose }: { shot: ScreenshotInfo; onClose: () => void }) {
  const client = useQueryClient()
  const displayRef = useRef<HTMLCanvasElement | null>(null)
  const originalRef = useRef<HTMLCanvasElement | null>(null)
  const [working, setWorking] = useState<HTMLCanvasElement | null>(null)
  const [cropped, setCropped] = useState(false)
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [saturation, setSaturation] = useState(100)
  const [cropMode, setCropMode] = useState(false)
  const [sel, setSel] = useState<Rect | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dragRef = useRef(false)

  const { data: dataUrl } = useQuery({
    queryKey: ['screenshot-data', shot.path],
    queryFn: () => unwrap(api.getScreenshotData(shot.path)),
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    if (!dataUrl) return
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')?.drawImage(img, 0, 0)
      originalRef.current = c
      setWorking(c)
      setCropped(false)
    }
    img.src = dataUrl
  }, [dataUrl])

  // Copy the working bitmap into the visible canvas whenever it is replaced.
  useEffect(() => {
    const shown = displayRef.current
    if (!shown || !working) return
    shown.width = working.width
    shown.height = working.height
    shown.getContext('2d')?.drawImage(working, 0, 0)
  }, [working])

  const filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`

  const applyCrop = useCallback(() => {
    const shown = displayRef.current
    if (!working || !shown || !sel) return
    const displayed = shown.getBoundingClientRect()
    if (displayed.width === 0) return
    const scale = working.width / displayed.width
    const x = Math.max(0, Math.floor(Math.min(sel.x0, sel.x1) * scale))
    const y = Math.max(0, Math.floor(Math.min(sel.y0, sel.y1) * scale))
    const w = Math.min(working.width - x, Math.floor(Math.abs(sel.x1 - sel.x0) * scale))
    const h = Math.min(working.height - y, Math.floor(Math.abs(sel.y1 - sel.y0) * scale))
    if (w < 1 || h < 1) {
      setSel(null)
      return
    }
    const next = document.createElement('canvas')
    next.width = w
    next.height = h
    next.getContext('2d')?.drawImage(working, x, y, w, h, 0, 0, w, h)
    setWorking(next)
    setSel(null)
    setCropMode(false)
    setCropped(true)
  }, [sel, working])

  /** Restores the untouched screenshot; adjustments are live sliders and survive. */
  const revertCrop = useCallback(() => {
    if (!originalRef.current) return
    setWorking(originalRef.current)
    setSel(null)
    setCropMode(false)
    setCropped(false)
  }, [])

  const save = useCallback(async () => {
    if (!working || saving) return
    if (!window.confirm('Overwrite the original screenshot? This cannot be undone.')) return
    setSaving(true)
    setError(null)
    try {
      const out = document.createElement('canvas')
      out.width = working.width
      out.height = working.height
      const ctx = out.getContext('2d')!
      ctx.filter = filter
      ctx.drawImage(working, 0, 0)
      const res = await api.overwriteScreenshot(shot.path, out.toDataURL('image/png'))
      if (!res.success) throw new Error(res.error || 'Failed to save')
      await Promise.all([
        client.invalidateQueries({ queryKey: ['thumb', shot.path] }),
        client.invalidateQueries({ queryKey: QK.screenshots }),
      ])
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [client, filter, onClose, saving, shot.path, working])

  // Pointer handlers for the crop rectangle, in displayed pixels.
  const stageHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect()
      dragRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      setSel({ x0: x, y0: y, x1: x, y1: y })
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      const r = e.currentTarget.getBoundingClientRect()
      setSel((s) => (s ? { ...s, x1: e.clientX - r.left, y1: e.clientY - r.top } : s))
    },
    onPointerUp: () => {
      dragRef.current = false
      // A click without a drag clears the selection rather than leaving a sliver.
      setSel((s) => (s && Math.abs(s.x1 - s.x0) < 8 && Math.abs(s.y1 - s.y0) < 8 ? null : s))
    },
  }

  const box = sel
    ? {
        left: Math.min(sel.x0, sel.x1),
        top: Math.min(sel.y0, sel.y1),
        width: Math.abs(sel.x1 - sel.x0),
        height: Math.abs(sel.y1 - sel.y0),
      }
    : null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[820px] w-full max-w-[1100px] flex-col rounded-lg border border-line bg-surface shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
          <p className="truncate text-[13px] font-semibold">Edit screenshot — {shot.name}</p>
          <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
          <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
            {working ? (
              <canvas
                ref={displayRef}
                style={{ filter }}
                className="block max-h-[70vh] max-w-full"
              />
            ) : null}
            {cropMode && working ? (
              <div {...stageHandlers} className="absolute inset-0 cursor-crosshair">
                {box ? (
                  <div
                    className="pointer-events-none absolute border border-accent bg-accent/10"
                    style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              size="sm"
              variant={cropMode ? 'primary' : 'outline'}
              onClick={() => {
                setCropMode((v) => !v)
                setSel(null)
              }}
            >
              <Crop className="h-3.5 w-3.5" />
              {cropMode ? 'Cancel crop' : 'Crop'}
            </Button>
            {cropMode ? (
              <Button size="sm" onClick={applyCrop} disabled={!sel}>
                Apply crop
              </Button>
            ) : null}
            {cropped ? (
              <Button size="sm" variant="outline" onClick={revertCrop}>
                Revert crop
              </Button>
            ) : null}
            <Slider label="Brightness" value={brightness} onChange={setBrightness} />
            <Slider label="Contrast" value={contrast} onChange={setContrast} />
            <Slider label="Saturation" value={saturation} onChange={setSaturation} />
          </div>
          <div className="flex items-center justify-end gap-2">
            {error ? <p className="mr-auto text-[11px] text-warn">{error}</p> : null}
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-muted">
      {label}
      <input
        type="range"
        min={0}
        max={200}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 accent-[var(--color-accent)]"
      />
      <span className="tabular w-9 text-right text-ink-faint">{value}%</span>
    </label>
  )
}
