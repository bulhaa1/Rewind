# Issues and known limitations

The working list. `README.md` carries a short public-facing subset; this is the
full thing, including things that are believed fine but have not been tested.

Last updated: 2026-10-11, after the on-demand updater, the Data settings
section, the resolution fix, the start/stop hotkey and the startup fix.

Status values:

| Status | Meaning |
|---|---|
| **Open** | Real, reproduced, not fixed |
| **Fixed, unverified** | Change made and reviewed; end-to-end proof still owed |
| **Verified** | Fixed and demonstrated against a running app or a real file |
| **Untested** | Shipped and reachable, but never actually exercised |
| **Decide** | Waiting on a product decision, not an engineering one |

---

## Open

### Black video with live microphone when the selected window is gone

**Reproduce:** Settings → Capture Source → a window → the game is running →
close the game → record. Or restart Rewind; it restores your last source.

You get black video and real microphone audio.

**Why:** three things line up, none individually wrong.

1. `setWindow` validates only the shape of the value — `typeof`, non-empty,
   under 1000 chars. Nothing checks the window still exists.
2. OBS accepts a `window_capture` source for a missing window without throwing.
   It creates the source, then produces no frames. The failure is silent.
3. Nothing downstream treats silence as failure. `switchCaptureSource` restarts
   the buffer after installing the source with no "did a frame arrive" check.

Audio makes it worse rather than causing it. `buildWindowSourceConfig` sets
`capture_audio: false`, so the window source never carries audio. What you hear
comes from the separate `desktop-audio` / `microphone-audio` sources, which are
an independent subsystem and know nothing about the video source.

The startup restore does not save you. It has a `catch` that falls back to the
display, but it only catches **throws** — and a missing window returns a working
source that renders black, so the catch never fires and the dead source is
restored like a healthy one.

**Proposed shape** (agreed in principle, not built): treat a missing window as a
trigger — arm it, start capturing when the game appears, stop when it exits, with
confirmation in the panel and no on-screen overlay. The game detector already
polls for exactly this.

Three decisions still open:

1. **Armed vs automatic fallback** — a mode you pick explicitly, or does choosing
   a not-running window silently arm itself? Fallback is friendlier, explicit is
   less surprising.
2. **A clip in flight when the game exits** — finish it, or discard it? For a
   replay buffer, finishing seems right; the whole point is you get the moment
   back.
3. **Arming keeps the microphone live?** Recording black video with live audio
   *is* the bug, so arming almost certainly means no capture at all until the
   window exists.

### ~~Game-capture hook waits 5s on any fullscreen non-game app~~ — largely fixed

The exclusion list is a denylist, so an unknown fullscreen app is treated as a
game candidate. Auto-detect switches to `game_capture`, waits
`TIMING.GAME_HOOK_TIMEOUT` (5000ms) for a frame, then falls back to the display.

On this machine OpenChamber was caught **16 times in one day**, each one costing
the full timeout. The exclusion list has since been expanded from 85 to 105
entries — AI tools, more editors, and performance overlays — and the latest
launch logs `excluded=true candidate=false` for it.

Still true, just much rarer: the denylist cannot cover apps nobody has thought of.
An unknown fullscreen app will still be tried and will still cost 5s. Reducing
`GAME_HOOK_TIMEOUT` would bound that, at the cost of giving genuinely slow game
hooks less time to produce a first frame.

---

## Fixed, unverified

### Display resolution changes mid-capture

**Shipped:** `4075a73`.

**Root cause:** the OBS canvas was sized once, at init, from the primary display
(`configureVideo` during `initialize()`). `capture.ts` computed its own
`canvasWidth`/`canvasHeight` the same way, also once, and the scene item's scale
and offset were derived from those. The only display listener called
`invalidateDisplays`, which refreshes the settings UI list and nothing else.
Windows can change resolution while capturing, so OBS was left rendering an
old-size canvas around a new-size source, and resolves the mismatch by scaling
and cropping. That is the black half-screen at 720p, the 4K cropped to 2K, and
part of a smaller virtual display going missing.

Restarting appeared to fix it because startup re-runs the sizing.

**What was verified:** clean typecheck and build, 16/16 CDP regression checks,
and no spurious canvas sync at startup.

**What was not:** an actual resolution change while recording. That needs a
human at a keyboard — changing the primary display resolution mid-session is
disruptive, and the canvas follows the primary, so the virtual monitor does not
exercise the path.

To confirm, the log should show one pair per real change:

```
[OBS] Display changed: canvas 2560x1440 -> 3840x2160, output ...
[Capture] Capture canvas 2560x1440 -> 3840x2160
```

Missing lines mean the listener did not fire. Lines present but a wrong clip
means the problem is downstream of the canvas.

### Known gap in that fix

Only `display-metrics-changed` triggers the sync. If a monitor is plugged in
that becomes the **primary**, that fires `display-added`, not a metrics change,
so the canvas would not update. Should be handled; not yet.

---

## Untested

Shipped, reachable in the UI, never actually exercised. Any of these could be
broken.

| Item | Where |
|---|---|
| Per-app audio mixing (`appAudioLevels`) | Settings → Audio |
| Extra device channels (`deviceChannels`) | Settings → Audio |
| `separateAudioTracks` | Settings → Quality |
| `perDeviceAudioTracks` | Settings → Quality |
| 120 fps yields genuinely distinct frames | Settings → Quality |

**AMD and Intel GPUs.** Only ever run on an NVIDIA RTX 5080. The encoder is
detected at runtime and `codecsByVendor` covers NVENC, AMF and QSV with an x264
CPU fallback, and the regression suite confirms
`encoder vendors detected -> ["auto","nvenc","x264"]`. But "works on AMD and
Intel" is untested. The README's "Any GPU" column rests on the fallback being
architecturally sound, not on a machine without an NVIDIA card having run it.

---

## Known limitations

Verified behaviour, shipped this way on purpose.

- **60 fps records at 30.** OBS normalises `FPSType` back to `FPSType=0` on
  shutdown and the profile write does not survive it. 30 and 120 both produce the
  rate they claim; 60 does not. The option is still offered and is wrong.
- **Unsigned.** Windows SmartScreen warns on first run and on **every update**.
  Unsigned auto-updates are the shape Defender flags, so this is the biggest
  adoption risk in the product and needs a code-signing certificate.

---

## Decide

Product calls, not engineering ones.

- **Installer visibility.** `quitAndInstall(false, ...)` shows the NSIS wizard
  even though the user just pressed "Restart and install". Passing `true` would
  remove it, but SmartScreen prompts regardless, so leaving it visible means the
  prompt is not a surprise.
- **Code signing.** The one thing that cannot be solved in this repository.
- **Should the exclusion list be editable?** `Open Exclusion List` exports the
  compiled-in list to `exclusion-list.json` and reveals it. Nothing reads it back.
  Making it load at startup, with a fallback to defaults on malformed input,
  would let users exclude an app that keeps being mistaken for a game.

---

## Operational notes

Not bugs, but they accumulate and are easy to forget.

- **The updater cache is never pruned.**
  `%LOCALAPPDATA%\rewind-desktop-updater\pending\` held two copies of the same
  installer after one update — `installer.exe` (the renamed copy electron-updater
  executes) plus the original. 421 MB for one version, and it grows per release.
- **Differential downloads are not in use.** The `.blockmap` is built into
  `release/` but is not uploaded, so the updater 404s on it and falls back to a
  full 210 MB fetch every time. Uploading the blockmap alongside `latest.yml`
  would make updates ship only changed blocks.

---

## Verified fixed

Kept so the same thing is not investigated twice.

| Fix | Commit |
|---|---|
| Editor waveform rendered flat — bars were sized against absolute amplitude, so with typical peaks of 0.2–0.7 a 43% share sat on the 2px floor and the mean was ~2px in a 32px lane. Now normalised against the loudest bar | `5267a4e` |
| Editor opened the wrong clip — `openEditorWindow` focused an existing window without loading the requested one, so editing clip B while clip A was open silently showed A | `5267a4e` |
| Startup waited 5s on a buffer that had never run — `destroyRunningChain` awaited a stop signal that could never arrive | `e3a00f9` |
| Capture canvas never resized on a display change | `4075a73` |
| "Up to date" panel state had no button, so re-checking meant closing and reopening | `3fcfcf1` |
| Packaged icon never resolved; `--shadow-raise` / `--shadow-pop` referenced but undefined | earlier |
| Record timer kept running after a buffer stop | earlier |
| Selftests corrupted user config by redirecting output paths and never restoring | earlier |