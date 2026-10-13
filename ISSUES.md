# Issues and known limitations

The working list. `README.md` carries a short public-facing subset; this is the
full thing, including things that are believed fine but have not been tested.

Last updated: 2026-10-13, after the UI redesign landed on branch `feat/ui-redesign`
(landscape deck + media rail, signal-path settings, Base UI primitives, motion), on
top of making pause stop capture, fixing the NVENC preset mapping and the frame-rate
profile write, and measuring the capture and idle cost (`docs/perf-testing.md`).

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

### A screenshot records the wrong source, and names the file after it

Found 2026-10-12 while verifying the screenshot-metadata fix. One screenshot
on disk carries `source: "exclusion-list.json"` in its metadata — the source
name recorded at capture time was a filename, not an application. The PNG
itself is named `Screenshot 2026-10-11 19-08-02.png`, so the filename is
correct and only the recorded source is wrong.

**Why this is worth chasing:** `getCurrentSourceName()` is the same call the
panel's "Capturing" field uses. If it can return a filename, it can return a
stale or wrong value in the panel too, and the only reason this surfaced is
that a stray `exclusion-list.json` happened to be sitting in the output root
at the moment of capture. Not yet reproduced deliberately.

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

### The engine costs CPU in proportion to the frame rate, even idle

Found 2026-10-13 while measuring the "5-10 fps just running" report. With the
buffer paused and the capture source removed — nothing recording, nothing
captured — obs64 still burns **~3.9% of one core at 30 fps, ~6.6% at 60 and
~17.6% at 120** (RTX 5080, 2560x1440; numbers and method in
`docs/perf-testing.md`). That is OBS's frame loop, not the encoder: the engine
ticks at the video rate for as long as it is up. Pausing no longer adds capture
cost on top of it (it used to — see the fixed table), but it does not remove
this either, because pausing keeps the engine alive for instant resume.

**Why it matters:** a 120 fps user pays a busy core alongside a CPU-bound game
even when the buffer is off, and nothing in the UI shows it.

**Possible fix, needs a product call:** auto-sleep that shuts the engine down
after N minutes paused and rebuilds on resume (~10 s), trading resume latency
for the idle cost. Not started; not obviously right for a replay tool.

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

## Verified

### `separateAudioTracks` produces genuinely separate tracks

Measured end to end on 2026-10-11 with `node scripts/audiotracktest.js`, which
forces the setting on, plays a 1 kHz tone through the default output device during
the recording window, and probes the saved clip.

**Works.** One 30 s replay recorded with the setting on produced **3** audio streams;
the same recording with it off produced **1**. The mixer mask is built before the
chain (`audio tracks=0b111` on, `0b1` off), so the setting is what changes the count
rather than anything incidental to the machine.

The tracks are separately addressable and are *not* cosmetic copies. Decoded to PCM
and hashed:

| Stream | Track label | mean | max | Distinct PCM |
|---|---|---|---|---|
| 0 | Mix | -26.8 dB | -21 dB | — |
| 1 | Desktop | -26.8 dB | -21 dB | identical to Mix |
| 2 | Microphone | -91.0 dB | -91.0 dB | **differs from Mix** |

A bandpass at the tone frequency (900–1100 Hz) keeps -31.3 dB on streams 0 and 1 and
leaves stream 2 at -91.0 dB, so the desktop signal is routed to its own track and the
microphone track carries something else.

Mix and Desktop are byte-identical here, which is correct rather than suspicious: the
mix is desktop + microphone, and the microphone contributed nothing, so the sum equals
the one non-silent input. It is not evidence of a duplicated stream.

**Caveat on how far this goes.** The microphone track was verified to be *routable and
distinguishable*, not to carry live speech: this machine has no microphone carrying
signal — all three input endpoints (`Audio Array AM-C47`, `Virtual Desktop Audio`,
`Steam Streaming Microphone`) read exactly -91.0 dB, which is also what ffmpeg reports
for a generated `anullsrc`, i.e. digital silence. `-91.0 dB` is this build's silence
floor, not a measurement failure. So: the track split, the mixer mask and the routing
are proven; **that a live microphone lands on track 3 is not.** That still needs a run on
a machine with a working mic input.

Both track toggles are in **Settings → Audio** (`settings.tsx` `AudioSection`), not
Settings → Quality where this file previously listed them.

**Scope: `separateAudioTracks` only.** The three audio items still listed under
Untested were *not* exercised by this run and no evidence is claimed for them. A
pass here says the core track split works; it says nothing about per-app mixing,
extra device channels or `perDeviceAudioTracks`, each of which needs its own
recording with the relevant devices configured.

---

## Fixed, unverified

### Microphone input gain shipped with no handler

**Root cause:** `set-mic-gain` was declared in `shared/ipc.ts`, exposed on the
preload bridge, typed in the renderer API and called from Settings — with no
`ipcMain` handler registered. The `isMicGain` validator was written and never
called. The slider threw "No handler registered" on every drag, so the control
was inert in every 1.0.1 install. It typechecked, built, and passed every
existing check, because nothing compared the declared channel set against the
handled set.

**Fixed:** the handler, live tier, reusing the existing validator.
`npm run verify:channels` now fails on any declared-but-unhandled channel and
runs in CI, so this class of defect cannot ship silently again.

**Verified:** probe 6/6 — set 1.5, read back 1.5, out-of-range 99 rejected with
a clean failure rather than a throw, and the rejected write left the stored
value alone. `main.log` confirms the gain reaches OBS rather than only the
store: `microphone input gain: 1.5x = 3.5dB (filter reports 3.52dB)`.

**Still not proven:** that a live microphone lands louder in a recorded clip.
This machine's inputs all read -91.0 dB, which is digital silence, so the
audible effect cannot be measured here. What is proven is that the control is
wired to the OBS gain filter and reads back what OBS reports.

---

## Untested

Shipped, reachable in the UI, never actually exercised. Any of these could be
broken.

| Item | Where |
|---|---|
| Per-app audio mixing (`appAudioLevels`) | Settings → Audio |
| Extra device channels (`deviceChannels`) | Settings → Audio |
| 120 fps yields genuinely distinct frames | Settings → Quality |

`perDeviceAudioTracks` is removed in 1.1.0 rather than verified: it was never
exercised, and its off-state (extra devices sharing one track) is what ships.

The three audio rows share a track-splitting foundation with
`separateAudioTracks`, which is now verified — the mixer mask and multi-track muxing
are known to work. That is not a pass for them: each needs its own recording, with
per-app levels set or devices actually attached, and none has been run.

Extra device channels now share a single track unconditionally, which is the
behaviour `perDeviceAudioTracks: false` produced. No code path depends on it any
more.

**AMD and Intel GPUs.** Only ever run on an NVIDIA RTX 5080. The encoder is
detected at runtime and `codecsByVendor` covers NVENC, AMF and QSV with an x264
CPU fallback, and the regression suite confirms
`encoder vendors detected -> ["auto","nvenc","x264"]`. But "works on AMD and
Intel" is untested. The README's "Any GPU" column rests on the fallback being
architecturally sound, not on a machine without an NVIDIA card having run it.

---

## Known limitations

Verified behaviour, shipped this way on purpose.

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
- **obs-studio-node's stats getters are garbage.** `Global.cpuPercentage`,
  `currentFrameRate`, `averageFrameRenderTime` and `laggedFrames` — and the
  `Video` info object — returned `"337769986 fps"` and `"3989852819 ms"` in
  0.25.77. That is unchecked memory, not stats. Anything that wants to know
  obs64's cost samples the process externally (`scripts/perf-sample.ps1`);
  do not trust these bindings until a version returns sane numbers.

---

## Verified fixed

Kept so the same thing is not investigated twice.

| Fix | Commit |
|---|---|
| Pause stopped only the encoder — the capture source and game hook stayed live, copying at up to 2× the video rate, and settings changes while paused silently resumed recording | `48cf9d5` |
| NVENC preset never reached the encoder — `"hq"` was unparseable, so every choice (p3/p4/p5) encoded at P5 | `48cf9d5` |
| A frame-rate request could silently never apply — the profile writer only rewrote existing keys and logged success anyway, so 60 recorded as 30 | `48cf9d5` |
| Game capture copied at twice the video frame rate — `limit_framerate` was never set | `48cf9d5` |
| Editor waveform rendered flat — bars were sized against absolute amplitude, so with typical peaks of 0.2–0.7 a 43% share sat on the 2px floor and the mean was ~2px in a 32px lane. Now normalised against the loudest bar | `5267a4e` |
| Editor opened the wrong clip — `openEditorWindow` focused an existing window without loading the requested one, so editing clip B while clip A was open silently showed A | `5267a4e` |
| Startup waited 5s on a buffer that had never run — `destroyRunningChain` awaited a stop signal that could never arrive | `e3a00f9` |
| Capture canvas never resized on a display change | `4075a73` |
| "Up to date" panel state had no button, so re-checking meant closing and reopening | `3fcfcf1` |
| Packaged icon never resolved; `--shadow-raise` / `--shadow-pop` referenced but undefined | earlier |
| Record timer kept running after a buffer stop | earlier |
| Selftests corrupted user config by redirecting output paths and never restoring | earlier |
