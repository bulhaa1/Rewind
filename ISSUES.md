# Issues and known limitations

The working list. `README.md` carries a short public-facing subset; this is the
full thing, including things that are believed fine but have not been tested.

Last updated: 2026-10-14, at the 1.3.1 hotfix: monitor capture moved to Windows Graphics
Capture after the installed build was found to write flat black clips — DXGI desktop
duplication delivers nothing to a process that is only system-DPI aware, which the
packaged obs64 is once obs-browser (CEF) is excluded from the installer. Also in 1.3.1:
the Record row fades out while the buffer is off, and the redundant "Auto detect launched
game" card is gone from the capture source picker.

Previous: 1.3.0, the clip editor (trim, per-track audio with waveforms and live
monitoring, replace-or-copy), compression on the GPU with a source-relative quality ladder
into `Rewind/Compressed/`, user-defined capture profiles, and the twenty findings of the
1.3.0 repository audit — two of which could leave a button stuck, one of which could hang
the library on an unreachable drive, and one of which could silently cost every clip its
desktop audio.

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

## Verified

### Black video in every clip and recording (monitor capture)

Found 2026-10-14 from the report "black screen when recording or clipping and no game is
launched, even in display mode". Every clip and recording written by the installed build
was a flat black frame — `lavfi.signalstats.YAVG` measured **16** (limited-range black) on
all five of the user's clips, against **43** on one from the morning — while the app's own
Screenshot, which goes through ffmpeg's `ddagrab` on the same monitor, was fine. The
engine side of the log looked perfect: source created, `method: DXGI`, frames drawn,
encoder started, buffer written. The composed frame simply had nothing in it.

**Cause.** OBS's DXGI desktop duplication delivers no frames to a process that is not
per-monitor DPI aware. obs64.exe has no DPI declaration in its manifest, so its awareness
is whatever is set at runtime — and in the packaged build it ends up `SYSTEM_AWARE`
(measured with `GetProcessDpiAwareness`), which is enough for everything except the
duplicator. The dev build never showed the bug because it loads `obs-browser.dll`, whose
CEF runtime sets the process to `PER_MONITOR_AWARE_V2`. That plugin is deliberately
excluded from the installer (CEF is ~214 MB), so the packaged app lost the accidental
fix. Reproduced on the dev build by moving `obs-browser.dll` (plus `libcef.dll`,
`chrome_elf.dll`, `libEGL.dll`, `libGLESv2.dll`) out of
`node_modules/@streamlabs/obs-studio-node/obs-plugins/64bit`: obs64 became `SYSTEM_AWARE`
and the clip came out at YAVG 16.

**Fix.** Monitor capture now uses Windows Graphics Capture (`method: 2`) instead of letting
OBS pick DXGI duplication — the same method the window source already used. WGC does not
depend on the process's DPI awareness at all. Guarded on Windows build 18362 (1903), the
release that introduced it; older builds keep `Automatic`. Measured after the change, with
obs-browser absent and obs64 still `SYSTEM_AWARE`: YAVG **30.0** with real desktop content
in the frame, and the OBS log's `method:` line reads `WGC`. Re-checked with obs-browser
restored: YAVG 30.0, no regression.

### Capture profiles

Four presets, each a buffer length, a frame rate and a quality tier. Switched from the
panel's numbered chips, from the Settings section, or with the Next Profile hotkey
(Alt+4 by default). `npm run test:profiles` — 13/13, and `probe-profiles` — 7/7:

- A switch writes the profile's values into the live settings **and into the engine**:
  the chain takes its length from obsCore's config, and a switch that only wrote the
  settings file rebuilt the chain at the old length (measured: "Long buffer applied:
  120s" followed by "Replay buffer configured: 60s").
- The cost is the cheapest tier that can apply it: a length change restarts the chain, a
  quality change rebuilds it, an fps change takes the engine down and back up. Rapid
  presses are coalesced — only the newest request survives, so four presses cost at most
  two switches instead of four.
- A paused buffer stays paused, including when the caller announces a busy status first,
  which is what the panel's handlers do.
- A recording in flight is finished and registered when a switch tears the chain down,
  and the popup says so.
- Editing the active profile applies it; editing an inactive one only stores it; a
  failed apply puts the stored profile back.
- The panel follows a switch it did not start (the hotkey runs in main).

### 1.1.0 → 1.2.0 updates end to end, silently

Run 2026-10-14 on this machine, `npm run test:update`: the published 1.1.0 installer into a
scratch directory, pointed at a local feed serving a locally built 1.2.0, driven through
the panel's own IPC.

- The idle app made no update activity in 30 seconds: no check, no download, nothing.
- Check offered 1.2.0, Download reached `ready`, and the app quit for the installer.
- **No wizard.** The app came back by itself, which only happens if the install ran
  silently — a wizard would have sat waiting for a click.
- The install left **0 files** that 1.2.0 does not ship (compared against a fresh 1.2.0
  tree, `resources` subtree, name and size). The NSIS update replaces the tree rather
  than extracting over it, so the ~255 MB of engine files 1.2.0 dropped are gone.
- The new version emptied the updater cache on its first start:
  `Update cache pruned: 5 file(s), 214.4 MB`.

### Display resolution changes mid-capture

**First shipped:** `4075a73` (canvas sync). **Fixed properly:** this branch.

**Root cause, measured:** OBS refuses the video-context reset while an output holds
it. With the replay buffer live, the settings section said `1280x720`, the reset was
called, and the next saved clip still came out `2560x1440` — the section and the live
canvas disagreed, and the app's own canvas numbers moved to the new size anyway.
That disagreement is the black half-screen and the zoomed-in crop. `4075a73` called
the reset with the buffer running, so it never took effect while capturing.

OBS says so itself, in its own log (`<profile>\obs-data\node-obs\logs\`), once per
refused reset — three of these in one display-test run:

```
[Error] [VIDEO_CANVAS] video is active, video reset is not possible
```

`OBS_service_resetVideoContext()` returns nothing, so a clip's dimensions are the
proof, not a return code.

**Fix:** `CaptureManager.applyDisplayChange()` stops the replay chain, resets the
video context, re-fits the source, and restarts the chain. A recording in flight is
finished and registered rather than dropped; a buffer the user paused stays paused;
a metrics event that did not change the size costs nothing, because the canvas is
compared before anything is stopped. `display-added` and `display-removed` now sync
when the primary display changes, which closes the old gap.

**Verified** — `npm run test:display` (forced canvas, isolated profile):

| clip | dimensions | meaning |
|---|---|---|
| with-buffer | 2560x1440 | the reset is refused while the output is live |
| without-buffer | 1280x720 | it applies once nothing holds the context |
| after-fix | 2560x1440 | the display-change path applies it with the buffer live |

plus: a recording in flight was finished and registered (0.5 MB); a paused buffer
stayed paused; two events through the source lock left the buffer running.

**Verified on real mode changes** — `npm run test:resolution`, and the same watcher
driven by the user's QRes scripts for 4K:

    2560x1440 -> 1920x1080 -> 2560x1440   clips 1920x1080, then 2560x1440
    2560x1440 -> 3840x2160 -> 2560x1440   clips 3840x2160, then 2560x1440

Both directions came back at the size the display had when the clip was saved.

### 1.0.1 → 1.1.0 updates end to end

Run 2026-10-13 on this machine: the installed 1.0.1 (`Z:\Apps\Rewind`) pressed
**Check for updates**, was offered 1.1.0, downloaded it (189 MB — 1.0.1's updater
auto-downloads once an update is found), pressed **Restart and install**, and came
back as 1.1.0 with the save location, screenshot location and every existing hotkey
unchanged. New bindings filled in with defaults (quick clip `Ctrl+Alt+1`, record
toggle `Alt+3`). Scripted as `scripts/probe-update-101.mjs` +
`scripts/probe-after-update.mjs` (5/5), driven over CDP against the installed build.

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

### The 1.3.0 audit (twenty findings, commit `8149895`)

Found by reading the whole repository rather than by a reproduction, so each one is a
reasoned case rather than a measured one — which is exactly why they are here and not
under Verified. What each fix was:

| # | Finding | Fix |
|---|---|---|
| 1 | Two saves at once replaced the pending flush, so the first caller timed out after 10 s, reported a clip as unsaved and triggered wedge recovery (a full OBS reinit) | `saveReplayBuffer` shares one in-flight save |
| 2 | Save / Screenshot stayed busy forever when `runAction` dropped the call, because the caller's cleanup lived inside the dropped callback | callers clear their flag when the action is refused |
| 3 | `ffmpeg -i` had no timeout: an unreachable library drive hung the scan for the session | 15 s probe timeout |
| 4 | A one-segment recording was joined with `fs.copyFileSync`, freezing the app for the copy | `fs.promises.copyFile` |
| 5 | Clip metadata was matched case-sensitively: a rename after the root was re-spelled dropped source and tracks; a delete left an orphan record | `findMetaKey` |
| 6 | Every stale clip was probed one at a time — minutes on a large library | four probes at a time |
| 7 | A packaged build honoured `REWIND_DEV_SERVER`, loading remote content with the IPC bridge | `devServerUrl()` is dev-only |
| 8 | One per-app level put the mixer in custom mode permanently; with no app session running, every clip recorded no desktop audio | loopback fallback when no app source is live |
| 9 | A wedge recovery whose reinit threw skipped its own relaunch | the reinit failure is caught |
| 10 | ffmpeg's whole stderr was kept in memory and shipped to the renderer inside the error | last 8 KB kept |
| 11 | The per-app cap counted 16 apps against 13 OBS slots, dropping apps 14–16 silently | cap is `APP_MAX - APP_BASE` |
| 12 | A second quit skipped the shutdown wait and force-killed obs64 mid-stitch | `cleanupDone` gates the second quit |
| 13 | Panel and popup were placed from the work area's size but not its origin | both use the origin |
| 14 | At zero volume the mic button said "Raise microphone volume" and muted instead | it raises the level |
| 15 | The rail re-sorted both full lists on every render | memoized |
| 16 | "Default microphone" counted as available on a machine with no input endpoint | needs an enumerated input |
| 17 | The mic gain dB conversion had no assertion anywhere | asserted in the profile selftest |
| 18 | A failed audio-source setup left the source bound to its slot, unreachable | released through `destroyAudioSource` |
| 19 | ~60 lines of dead code | deleted |
| 20 | Two duplicated doc comments, one giving the opposite of the correct ffmpeg argument order | deleted |

Still owed on each: a run against the real app. The ones worth exercising first are
1 (press the save hotkey and the quick-clip hotkey within a second), 2 (click
Screenshot while a save is running), 5 (rename a clip after changing the output
folder's spelling), 8 (set a per-app volume, close that app, record, check desktop
audio), 11 (open more than thirteen audio sessions) and 14 (drag the mic fader to
zero and click the icon).

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
`docs/hardware-compatibility.md` is the analysis, with every claim labelled
measured / vendor docs / needs a machine; the checklist in it is what a machine
without an NVIDIA card should be run through.

---

## Known limitations

Verified behaviour, shipped this way on purpose.

- **Unsigned.** Windows SmartScreen warns on first run and on **every update**.
  Unsigned auto-updates are the shape Defender flags, so this is the biggest
  adoption risk in the product and needs a code-signing certificate.

---

## Decide

Product calls, not engineering ones.

- **Installer visibility.** Settled in 1.2.0: `quitAndInstall(true, ...)` installs
  silently, so no wizard appears at all. SmartScreen may still prompt on the first
  run of an unsigned installer, which is the reason this sat open — but the wizard
  itself was a second, avoidable interruption.
- **Code signing.** The one thing that cannot be solved in this repository.
- **Should the exclusion list be editable?** `Open Exclusion List` exports the
  compiled-in list to `exclusion-list.json` and reveals it. Nothing reads it back.
  Making it load at startup, with a fallback to defaults on malformed input,
  would let users exclude an app that keeps being mistaken for a game.

---

## Operational notes

Not bugs, but they accumulate and are easy to forget.

- **obs-studio-node's IPC pipe can break under heavy chain churn.**
  `IPC write to pipe failed with code 109` (ERROR_BROKEN_PIPE) in obs64's own log, after
  roughly a dozen stop/start cycles in a minute — measured by the display test's phases
  (and it is intermittent: the same test passes on most runs and fails the save that
  follows on others, and it reproduces on the build from before this branch). When it
  happens the buffer stops answering and a save times out. The app recovers by design:
  a timed-out save force-kills and reinitialises OBS (`scheduleWedgeRecovery`), and a
  profile switch that reports `Failed to make IPC call` does the same. Nothing here
  makes the pipe more robust; it makes the failure visible and recoverable.
- **The updater cache is pruned on start** (1.2.0). It used to hold two copies of the
  same installer after one update — `installer.exe` (the renamed copy electron-updater
  executes) plus the original — measured at 379 MB after the 1.0.1 → 1.1.0 update. The app
  now deletes that whole directory a few seconds after start and logs what it freed
  (`Update cache pruned: 5 file(s), 214.4 MB`). Nothing in there can be applied across a
  restart: the update state is in memory and starts at `idle`, so a stale download is
  downloaded again rather than installed.
  - The one cost: a **second instance** sharing the directory (a portable copy, a dev
    build, another profile) loses a download in progress and fetches it again. Two
    attempts to avoid that were measured and removed — a freshness window left a
    15-second install's own leftovers in place, and a file held open for writing is not
    protected either, because Node opens with `FILE_SHARE_DELETE` and Windows deletes it
    anyway. A repeat download is the cheaper of the two failures.
- **Differential downloads start with 1.1.0.** The `.blockmap` is now uploaded
  alongside `latest.yml` (1.1.0 onward), so updates from 1.1.0 ship only changed
  blocks. The 1.0.1 → 1.1.0 jump was necessarily a full download: 1.0.1 shipped no
  blockmap to diff against.
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
