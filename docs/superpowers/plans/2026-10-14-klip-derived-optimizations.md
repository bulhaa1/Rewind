# Rewind 1.2.0 Implementation Plan — Klip-derived optimizations and the mic strip

**Goal:** Cut what Rewind costs a machine — install size, process count, idle work and CPU
under load — using the parts of Klip 2.0.1's design that are portable to an Electron +
obs-studio-node app, and add a microphone strip with a live test meter to the main page.

**Reference:** Klip 2.0.1 (native C++20 + ImGui, libobs 32.1.2 in-process, 8 modules, no CEF,
65 MB installed, 1 process) measured on the same machine against the installed Rewind 1.1.0.
Full measurements and the reasoning live in `docs/perf-testing.md` after T0.

**Tech stack:** unchanged. Electron 30.5.1, TypeScript 5.7, React 18, Vite 6,
`@streamlabs/obs-studio-node` 0.25.77, ffmpeg via `ffmpeg-static`. No new runtime dependencies.

## Measured baseline (2026-10-13/14, RTX 5080, 2560x1440@120)

| | Klip 2.0.1 | Rewind 1.1.0 |
|---|---|---|
| Install | 65 MB / 703 files | 627 MB / 1695 files |
| Processes / threads | 1 / 118 | 6 / 222 |
| Private working set | 643 MB (quality preset) | 507 MB = engine 296 + UI 211 |
| CPU, % of one core (10-min soak, both buffering) | 18.4 | 32.7 (obs64 29.7 + Electron 3.0) |
| Engine floor, paused, no source | — | 17.6% @120, 6.6% @60, 3.9% @30 |
| Clip bitrate | H.264 CBR 18.76 Mbps (fitted) | AV1 CQP23, 8.1–47.4 Mbps across 6 clips |
| Growth over 10 min | +4.5 MB | engine sawtooth 280–348 MB, UI −2.3 MB |

Rewind's engine floor at 120 fps is ~17.6 points of that 32.7; Klip's whole app sits at 18.4.
The gap to attack is the ~12 points of non-floor work: obs-studio-node polling, encoder
submit at AV1 bitrates, three audio tracks, and the Electron utilities.

## Not in this plan

Replay memory cap, auto-sleep timer, display-resolution-change fix, silent in-app update,
Discord/GitHub links, realtime perf readout, Record with the buffer stopped. Each is a
separate decision; none is touched here.

## Global constraints

- No new runtime dependencies. `node_modules` gains nothing.
- No network, accounts, telemetry, or cloud. The offline promise is unchanged.
- Windows x64 only.
- Verification is measured output — installer size, module list, process list, private
  working set, log lines, probe output — never a screenshot of a plausible number.
- `npm run dev` must keep working after every packaging change; the dev path reads
  `node_modules`, not the pruned packaged tree.
- Gate for every task: `npm run typecheck`, `npm run build`, `node scripts\utf8-audit.mjs`,
  `node scripts\channel-check.mjs`, `npm run test:ui`.
- Commit after every task.

## Review focus

1. **A pruned engine still captures.** After T1/T2 the packaged app must complete a
   record → save → edit → screenshot cycle, hook a game, and record a second audio device.
2. **Encoder probe executables stay.** `obs-nvenc-test.exe`, `obs-qsv-test.exe`,
   `obs-amf-test.exe` are launched by the bundled plugins to test encoders; removing them
   silently changes encoder detection.
3. **The mic meter survives a pipeline rebuild.** The microphone source object is recreated
   on every `reinitPipeline()`; a volmeter left attached to a destroyed source is the
   failure mode.
4. **Nothing new polls while the panel is hidden.** The meter, the recording-state poll and
   the thumbnail cache all stop when the window is hidden.
5. **The audio-service flag is measured, not assumed.** If Chromium ignores it, record the
   negative result instead of shipping a comment claiming a win.

---

### T0 — Record the baseline

**Files:** `docs/perf-testing.md`.

- Add the table above, each number next to the command or probe that produced it, plus the
  soak CSV path and the Klip reference settings (192 MiB budget, 18.7 Mbps fitted, H.264 CBR,
  p7/fullres, 120 fps).
- Include the known engine floor and the note that CPU is content-dependent (AV1 CQP,
  change-driven DXGI capture), so later A/B runs must hold content constant.

**Verify:** every number reproducible from the written command.

**Commit:** `docs: record the measured Klip-vs-Rewind baseline`

---

### T1 — Strip CEF and obs-browser from the package (≈ −214 MB)

**Files:** `electron-builder.yml`, new `scripts/prune-engine.mjs`, `package.json`.

**Interfaces:** `npm run package` produces a tree without the CEF set; the dev tree in
`node_modules` is untouched.

- Remove from the packaged `obs-studio-node` copy: `libcef.dll` (167.5 MB),
  `obs-plugins/64bit/locales/*.pak` (27.2 MB), `icudtl.dat` (10.0 MB), `resources.pak`
  (7.0 MB), `chrome_*.pak`, `chrome_elf.dll`, `obs-browser.dll`, `obs-browser-page.exe`,
  `snapshot_blob.bin`, `v8_context_snapshot.bin`.
- Keep `libobs-d3d11.dll`, `obs.dll`, `obs_studio_client.node`, and the modules T2 keeps.
- Verify no kept binary imports libcef (only `obs-browser.dll` does).

**Verify:** package; install to a scratch directory; run the full cycle from Review focus 1;
obs64's module list has no `libcef`/`chrome_elf`; `main.log` gains no plugin-load failure
beyond the expected obs-browser line; installer and installed size measured and recorded.
Revert if any capture or encode path fails.

**Commit:** `build: strip CEF and obs-browser from the packaged engine`

---

### T2 — Trim unused engine modules and data (≈ −33 MB)

**Files:** `scripts/prune-engine.mjs` (second list), `docs/perf-testing.md`.

- Remove: `mediasoup-connector.dll` (14.5 MB), `obs-vst.dll` + `win-streamlabs-vst.exe`
  (11.1 MB), Spout set (0.5 MB), `text-freetype2.dll` (0.6 MB), `win-dshow.dll` + virtualcam
  data, `obs-ndi.dll`, `obs-webrtc.dll`, `decklink.dll`, `vlc-video.dll`, `obs-text.dll`,
  `obs-transitions.dll`, `image-source.dll`, `coreaudio-encoder.dll`, `openvr_api.dll`,
  per-plugin locale directories other than `en-US` (5.8 MB).
- Keep: `win-capture`, `win-wasapi`, `obs-nvenc`, `obs-qsv11`, `obs-ffmpeg`, `obs-x264`,
  `obs-filters` (the mic gain filter is one), `obs-outputs`, av*/sw* DLLs, `zlib`,
  `w32-pthreads`, and the three encoder probe executables.

**Verify:** the full cycle plus game capture, a second audio device and the mic gain filter;
obs64's module list matches the intended set exactly; any `Failed to load module` line means
that entry goes back.

**Commit:** `build: drop engine modules Rewind never loads`

---

### T3 — Fold the Electron audio service into the browser process

**Files:** `src/main/index.ts`.

- `app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')` before
  `app.whenReady()`.

**Verify:** process list loses the audio utility (expected ~−64 MB private WS, −1 process);
desktop and microphone capture still record; the notification chime plays; T5's meter works.
If the flag is ignored or audio regresses, revert and record the negative result.

**Commit:** `perf: fold the audio service into the main Electron process`

---

### T4 — Renderer hygiene

**Files:** `src/renderer/components/deck.tsx`, `src/renderer/components/rail.tsx`,
`src/main/thumbnail.ts`, `src/main/index.ts`.

- Gate the deck's 2 s recording-state poll on `document.hidden` (`deck.tsx:253-265`).
- Give thumbnail queries a `gcTime` so offscreen rows are evicted instead of every thumbnail
  living for the window's life (`rail.tsx`).
- Prune cached thumbnail files whose clip or screenshot is gone, in the startup pass that
  already prunes the updater cache.

**Verify:** CDP probe shows zero gated IPC calls while hidden; renderer private WS stays flat
after scrolling the whole library; the thumbnail directory stops growing for deleted clips.

**Commit:** `perf: stop the panel working while it is hidden`

---

### T5 — Microphone strip with a live test meter on the main page

**Files:** new `src/main/volmeter.ts`, new `src/renderer/components/mic-strip.tsx`;
modify `src/main/obs-core.ts` (expose the microphone source handle),
`src/main/index.ts` (attach/detach on visibility and after every pipeline rebuild),
`src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/lib/api.ts` (one event channel),
`src/renderer/components/deck.tsx` (mount).

**Interfaces:** `mic-level` event, `{ peak: number; inputPeak: number }`, pushed only while
the panel is visible.

- Layout, per the reference screenshot: mic glyph with a small level bar beneath it,
  `microphone / input` label, device name (`Default`), a horizontal volume slider showing the
  percentage, and a mute toggle — one row at the top of the deck.
- Real meter: `VolmeterFactory.create(EFaderType.Peak).attach(micSource)` plus
  `NodeObs.RegisterVolmeterCallback`, which delivers `{ sourceName, magnitude[], peak[],
  inputPeak[] }` (`module.ts:385` exports the factory; the callback is registered on
  `NodeObs`, verified in the client source). Measured: one batch every ~50 ms, so the bar
  needs no interpolation. `attach` takes the raw OBS input, which is
  `obsCore.microphone.source`, not the wrapper.
- The callback worker is shared with `RegisterSourceCallback`; start it when the panel is
  visible or a game-hook wait is pending, remove it when neither holds (see T6).
- Detach and re-attach the volmeter after every `reinitPipeline()`; never start a second
  callback worker.
- Slider and toggle reuse `setChannelVolume` / `setChannelMuted`; the device label comes from
  `getChannelDevices`. Mic gain stays in Settings.

**Verify:** speaking or a tone moves the bar (assert changing `peak` in a CDP probe, plus a
capture); the slider matches the stored fader; the toggle silences the bar; the meter costs
< 1% of one core while visible and zero callbacks while hidden; it survives a settings change
that rebuilds the pipeline.

**Commit:** `feat: microphone strip with a live level meter on the main page`

---

### T6 — CPU attribution and the levers

**Files:** `docs/perf-testing.md`, plus whatever the A/B proves.

Run each lever in the same state, same content, one change at a time; `scripts/perf-sample.ps1`
plus the app's own state, 60 s windows, paused@120 → buffering@120 → buffering@60:

1. **Codec** — h264 vs av1 at identical resolution, fps and quality (settings only).
2. **Audio tracks** — separate tracks on/off (settings only).
3. **Display capture method** — DXGI vs WGC (settings only).
4. **Poller lifetime** — register the source callback only while a game-hook wait is pending,
   and set a signal handler only on the replay buffer (code; `capture.ts:setupScene`,
   `replay-buffer.ts:444-445`). Up to ~80 synchronous IPC round trips/second exist today.
5. **CEF present vs absent** — the T1 delta.

Land the wins; record the losers with their numbers so they are not retried. If the codec A/B
is decisive, add a "light" profile (the cheaper codec, capped bitrate) as a setting — that is
a user-visible choice, not a silent change.

**Verify:** the published table shows each lever's before/after in the same state; targets are
goals to check, not promises: ≤ 26% of one core at 120 fps, ≤ 12% at 60 fps, same content.

**Commit:** `perf: attribute the capture CPU and land the measured wins`

---

### T7 — Soak, document, release

**Files:** `docs/perf-testing.md`, `README.md`, `ISSUES.md`, `package.json`.

- 60-minute soak: buffer on, panel visible 30 min then hidden 30 min; CPU and private working
  set per process every 60 s.
- Publish before/after: installer and installed size, process count, private WS, CPU per
  state, and the mic meter's cost.
- README: replace the resource claims with the measured numbers.
- ISSUES.md: what changed, what was deliberately not done (the "Not in this plan" list), and
  the deferred decisions.

**Verify:** every published number comes from a saved command output; a fresh install on this
machine completes the full cycle.

**Commit:** `docs: publish the measured resource budget and release 1.2.0`

---

## Acceptance

| Measure | Before | Target |
|---|---|---|
| Install size | 627 MB | ≤ 420 MB |
| Processes | 6 | 5 |
| obs64 modules loaded | full set + CEF | 8 working modules, no CEF |
| CPU @120 fps, buffering | 32.7% of one core | ≤ 26% |
| CPU @60 fps, buffering | — | ≤ 12% |
| Renderer IPC while hidden | polling | 0 gated calls |
| Mic meter | absent | < 1% visible, 0 hidden |
