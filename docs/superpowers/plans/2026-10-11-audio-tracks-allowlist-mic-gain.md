# Audio Tracks, Capture Allowlist, Mic Gain, Deferred Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-track audio correct in the editor, add a capture allowlist, add microphone input gain, and stop expensive settings from applying until asked.

**Architecture:** Four independent changes sharing one theme — describe clips by what they actually are rather than by current settings. Phase 0 verifies the existing separate-track machinery and gates everything after it. The editor reads per-clip track labels from clip metadata that is already being written, instead of from live settings. The allowlist supersedes the exclusion denylist. Mic gain is a fader multiplier. Deferred settings hold restart-tier changes in a renderer draft behind an Apply button.

**Tech Stack:** Electron, TypeScript, React 18, Vite, `@streamlabs/obs-studio-node` 0.25.77, ffmpeg/ffprobe via `ffmpeg-static`/`ffprobe-static`, electron-updater 6.8.9. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-audio-tracks-allowlist-mic-gain-design.md`

## Global Constraints

- No new runtime dependencies. `node_modules` gains nothing in this plan.
- No backend, accounts, telemetry, cloud upload, or mandatory updates. Every feature is local and offline.
- Preserve existing behaviour when a feature is off. An empty allowlist and a gain of 1.0 must be indistinguishable from today's build.
- Verification is measured output — `ffprobe`, `ffmpeg volumedetect`, log lines, file properties — never a screenshot showing a plausible number.
- `volumedetect` reports on **stderr**. Capturing only stdout produces a false zero. This has already caused one false negative in this project.
- Clip output is MP4, audio AAC. Keep it that way.
- Copy style matches surrounding code: explanatory comments state *why*, not *what*.
- Commit after every task. Push at the end of the plan.

## Test Infrastructure

This project has **no unit test framework** — no vitest, no jest, no `*.test.ts`. `node --experimental-strip-types` cannot import main-process modules: they import `electron` and use `./logger.js` extension-for-`.ts` conventions Node will not remap. Do not add a test framework; use the two seams that exist.

**Main-process logic** — the `REWIND_SELFTEST*` env seam in `src/main/index.ts:624-626` dispatches to `runSelfTest`, `runRecordSelfTest`, and `runSettingsSelfTest`. Each launches the real pipeline, does the real thing, writes evidence to `REWIND_SELFTEST_OUT`, and calls `app.exit(code)`. Drivers live in `scripts/selftest.js`, `scripts/audiotest.js`, `scripts/recordtest.js`. **Task 1 adds a fourth mode following this exact pattern.**

**Renderer logic** — `scripts/cdp.mjs` runs a probe module against the app on `--remote-debugging-port=9222`. `npm run test:ui` runs `scripts/probe-regression.mjs` (16 checks). Probe modules export `async function ({ evaluate, drainErrors })` and print `PASS`/`FAIL` lines.

Standard gate for every task:

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
```

## Review Focus

Five conditions a reasonable person would expect to work, which no task's happy path covers. Each line names the input and the expected behaviour, and each is pinned to a task below.

1. **A clip recorded with separate tracks, then `separateAudioTracks` turned off, then reopened.** Lanes must be identical. This is the exact bug — `editor.ts:154` compares stream count against *current* settings. → Task 2
2. **A clip with two audio streams whose labels are absent or the wrong length.** Must render one lane per stream with generic names, not collapse to a single "Audio" lane. A mislabelled multi-lane view beats a false single-lane one. → Task 2
3. **An allowlist entry typed as `Valorant.exe`, `VALORANT`, or ` valorant `. All three must match the same process, and a duplicate add must be a no-op rather than an error. → Task 3
4. **Mic gain left at 1.0.** Recording must be bit-identical in loudness to today. A gain control that alters audio at its default is a bug users cannot see. → Task 4
5. **Deferred settings pending when the app quits.** Changes must be discarded, never half-applied — a partial flush leaves OBS in a state no setting describes. → Task 5

---

### Task 1: Verify separate audio tracks

The spec gates everything else on this. `separateAudioTracks` is fully wired (`obs-core.ts:351-372` creates desktop and mic as independent sources, `obs-core.ts:688-717` assigns tracks) but has never been exercised — ISSUES.md lists it under **Untested**: "shipped, reachable in the UI, never actually exercised. Any of these could be broken."

All five existing clips have exactly one audio stream tagged `SoundHandler`, so nothing on disk answers the question. This task produces evidence, not features.

**Files:**
- Create: `scripts/audiotracktest.js`
- Modify: `src/main/index.ts:624-626` (dispatch), new `runAudioTrackSelfTest()` beside `runRecordSelfTest`
- Modify: `ISSUES.md`

**Interfaces:**
- Consumes: `setSetting` (`src/main/store.ts`), `obsCore.applyAudioTracks()`, `replay.saveReplayBuffer(mode)`, `probe(file)` from `src/main/ffmpeg.ts`.
- Produces: env mode `REWIND_SELFTEST_AUDIOTRACKS=1`, reading `REWIND_SELFTEST_OUT`. Writes `audiotracks-report.json` into that directory with shape `{ separate: boolean; streamCount: number; streamLabels: (string|null)[]; meanVolumes: number[] }`. Exit code 0 when `streamCount >= 2`, 1 when fewer, 2 on harness error.

- [ ] **Step 1: Write the harness driver `scripts/audiotracktest.js`**

Model on `scripts/recordtest.js`. Spawns:

```js
const electron = require('electron')
const child = spawn(electron, ['.'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env, REWIND_SELFTEST_AUDIOTRACKS: '1', REWIND_SELFTEST_OUT: OUT },
})
```

Poll `OUT/audiotracks-report.json` for up to 120s, print it, exit with the child's code. Reset `OUT` first, as `selftest.js` does.

- [ ] **Step 2: Add the dispatch line**

Beside the existing three in `src/main/index.ts:624-626`:

```ts
if (process.env.REWIND_SELFTEST_AUDIOTRACKS === '1') void runAudioTrackSelfTest()
```

- [ ] **Step 3: Write `runAudioTrackSelfTest()` — this is the failing test**

Save and restore `separateAudioTracks` around the run, exactly as `runRecordSelfTest` saves and restores `outputPath`. Then:

```ts
setSetting('separateAudioTracks', true)
setSetting('captureMode', 'display')
detector?.stop()
await services.reinitPipeline()
await sleep(30_000)
const file = await replay.saveReplayBuffer('display')
```

Probe the result and write the report. `probe()` returns `ProbeResult` whose `streams` entries are `ProbeStream` — these do **not** currently carry a `tags` field (`src/main/ffmpeg.ts:126-133`), so read tags by adding `tags?: Record<string, string>` to `ProbeStream`. Capture `volumedetect` stderr for each stream via `ffmpeg -map 0:a:<n> -af volumedetect -f null NUL`.

- [ ] **Step 4: Run it and read the evidence**

```bash
npm run build
node scripts\audiotracktest.js
```

Expected: `streamCount` of 2 or more, and `meanVolumes` differing between streams. Two streams with near-identical volumes means the split is cosmetic and Task 2 is blocked — stop and report rather than continuing.

If `separateAudioTracks` produces one stream, the machinery is broken at the OBS level. Stop, report, and do not build Task 2 on it.

- [ ] **Step 5: Record the finding in ISSUES.md**

Move `separateAudioTracks`, `perDeviceAudioTracks`, per-app audio mixing, and extra device channels out of **Untested** into **Verified** or **Open**, with the measured numbers attached. Correct their location while there — both track toggles are in Settings → Audio (`settings.tsx:322-337`), not Quality as ISSUES.md claims.

- [ ] **Step 6: Commit**

```bash
git add scripts/audiotracktest.js src/main/index.ts src/main/ffmpeg.ts ISSUES.md
git commit -m "Verify separate audio tracks end to end"
```

---

### Task 2: Per-clip track labels

The bug: `getClipInfo(file, trackLabels)` decides whether to split with `streamCount > 1 && trackLabels.length === streamCount` (`src/main/editor.ts:154`). Those labels come from `s.obsCore.audioTrackLabels()` at the call site (`src/main/ipc.ts:1248`) — **current settings, not what the clip was recorded with.**

The fix is smaller than the spec assumed. Clip metadata already stores the recorded layout: `setClipMeta(moved, { audioTracks: s.obsCore.audioTrackLabels() })` runs at save time in **two** places — `src/main/ipc.ts:214` and `src/main/index.ts:444` — into `clipMeta` (`src/main/store.ts:88-92`). The correct data is already on disk; the editor just never reads it.

**Known trade-off, accepted deliberately.** The spec asked for labels that survive the clip being moved. This approach does not: `clipMeta` is a `path → record` map, so a clip moved out of the watched folder loses its entry and falls back to `['Mix']`. It degrades to the same generic-lane behaviour as Review Focus #2 rather than to a false single lane, which is why it is acceptable. Container tags would have survived a move, but Task 1 establishes the recorded clips carry only a generic `SoundHandler`, so there is nothing reliable to read and a sidecar index would have to be invented. Correct labels on the overwhelming majority of clips beats an index that has to be kept in sync with every save, trim, rename and move.

A moved clip is rescanned and re-stamped with fresh metadata by `clip-manager.ts` on the next save.

**Files:**
- Modify: `src/main/editor.ts:100-105` (`analyzeAudio`), `:131-184` (`getClipInfo`)
- Modify: `src/main/ipc.ts:1160` (the `editorGetClipInfo` handler — the call site that reads labels)
- Modify: `src/main/index.ts` (`getAudioTrackLabels` in the `services.saveEditorClip` closure)
- Modify: `src/shared/types.ts:133-137` if the fallback shape needs widening

**Interfaces:**
- Consumes: `getClipMeta(file): ClipMeta | null` from `src/main/clip-meta.ts`, whose `ClipMeta.audioTracks?: string[]` (`src/main/store.ts:92`).
- Produces:
  - `analyzeAudio(info: ProbeAudioInfo): { split: boolean; streams: number[]; labels: string[] }` — now returns the labels it will actually use, so `getClipInfo` stops indexing `trackLabels` separately.
  - `getClipInfo(file: string, recordedLabels: string[]): Promise<ClipInfoResult>` — parameter renamed from `trackLabels` to `recordedLabels` to make the change visible at every call site.

- [ ] **Step 1: Change the call site to pass recorded labels**

`src/main/ipc.ts:1160`, inside the `editorGetClipInfo` handler. The current line is:

```ts
return ok(await require('./editor.js').getClipInfo(resolved.path, obsCore().audioTrackLabels()))
```

Replace `obsCore().audioTrackLabels()` with the clip's own metadata:

```ts
const recorded = require('./clip-meta.js').getClipMeta(resolved.path)?.audioTracks ?? ['Mix']
```

Note on imports: `getClipMeta` is **not** imported at the top of `ipc.ts` — line 8 imports only `setScreenshotMeta` and `deleteScreenshotMeta`. Other handlers reach the module through a local `const meta = require('./clip-meta.js')` (lines 208 and 1225), but neither of those is in scope in this handler. Either use the inline `require` above, matching how `editor.ts` and `index.ts` already pull this module in, or add `getClipMeta` to the line 8 import — your call, but do not assume it is already there.

**Do not touch `ipc.ts:1245-1249`** — that is the `setClipMeta` call which *writes* `audioTracks` onto the clip at save time. It is already correct and is the reason this fix is small.

- [ ] **Step 2: Update the second call site**

`src/main/index.ts`, in the `services.saveEditorClip` closure, `getAudioTrackLabels: () => obsCore?.audioTrackLabels() ?? ['Mix']` must instead read the clip being edited. `currentEditorClip()` is already imported there and has signature `(): { clipPath: string } | null` (`src/main/editor.ts:515`), so:

```ts
getAudioTrackLabels: () => getClipMeta(currentEditorClip()?.clipPath ?? '')?.audioTracks ?? ['Mix'],
```

Same reasoning: it is asking what the clip has, not what the app currently has.

- [ ] **Step 3: Change the split rule**

`src/main/editor.ts:154` currently requires label count to equal stream count. Replace with: split whenever `streamCount > 1`. A clip with two streams and no usable labels gets two lanes named `Track 1` and `Track 2` — Review Focus #2.

```ts
const analysis = analyzeAudio({ streamCount, split: streamCount > 1, labels: recordedLabels })
```

- [ ] **Step 4: Make `analyzeAudio` return the labels it chose**

Extend its return type to carry `labels`, so `getClipInfo:161-165` stops reaching back into `trackLabels`. When `split` is false the label stays `'Audio'`; when true, prefer `recordedLabels[stream]`, else `` `Track ${stream}` ``.

- [ ] **Step 5: Verify the regression sequence from Review Focus #1**

Record a clip with `separateAudioTracks: true`. Open it in the editor and screenshot the lanes. Turn `separateAudioTracks` off. **Reopen the same clip** — the lanes must be unchanged. This exact sequence is the test; a plan step is not a substitute for running it.

- [ ] **Step 6: Standard gate, then commit**

```bash
npm run typecheck && npm run build && node scripts\utf8-audit.mjs
git add src/main/editor.ts src/main/ipc.ts src/main/index.ts
git commit -m "Read per-clip track labels from clip metadata, not current settings"
```

---

### Task 3: Capture allowlist

The detector is a denylist; `game-detector.ts:8-25` says so outright. An allowlist supersedes it: when non-empty, only listed executables are capture candidates.

Entry format is lowercase, `.exe` stripped — the same normalisation `game-detector.ts:217` already applies before `isExcluded`. Both paths route through **one shared helper**, so the two lists cannot drift on what `Valorant.exe` means.

**Files:**
- Create: `src/shared/process-name.ts`
- Modify: `src/shared/types.ts` (`PersistedSettings`), `src/shared/constants.ts` (`DEFAULT_SETTINGS`)
- Modify: `src/main/game-detector.ts:26-75`, `:217`, `:292-295`, `:485-499`
- Modify: `src/main/capture.ts` (freeze-frame on exit)
- Modify: `src/main/ipc.ts` (new get/set channels plus the running-process candidate list)
- Modify: `src/preload/index.ts` (expose the new channels) and `src/renderer/lib/queries.ts:51-83` (`SETTINGS` bindings)
- Modify: `src/renderer/components/settings.tsx` (Display section)

**Interfaces:**
- Produces:
  - `src/shared/process-name.ts` → `normaliseProcessName(raw: string): string` — lowercases, strips a trailing `.exe`, trims whitespace. Used by `isExcluded`, by allowlist matching, and by allowlist entry normalisation, so all three agree by construction.
  - `isCaptureAllowed(exe: string, allowlist: string[]): boolean` in `game-detector.ts` — `true` when `allowlist` is empty (denylist path unchanged); otherwise `allowlist.includes(normaliseProcessName(exe))`.
  - `PersistedSettings.captureAllowlist: string[]`, default `[]`.
- Consumes: the running-window scan at `game-detector.ts:223-239` for the picker.

- [ ] **Step 1: Extract `normaliseProcessName`**

Create `src/shared/process-name.ts` exporting `normaliseProcessName(raw: string): string`. Rewrite `game-detector.ts:217` and the `isExcluded` comparison at `:292-295` to call it. Behaviour must not change for the existing denylist — the 105 entries are already lowercase and `.exe`-free.

- [ ] **Step 2: Add `captureAllowlist` to the settings schema**

`captureAllowlist: string[]` in `PersistedSettings` (`src/shared/types.ts`), default `[]` in `DEFAULT_SETTINGS` (`src/shared/constants.ts`). No migration needed — `JsonStore.get()` fills missing keys from defaults (`store.ts:53-56`).

- [ ] **Step 3: Gate candidate selection on the allowlist**

In `game-detector.ts`, replace the direct `isExcluded` call in the candidate path with `isCaptureAllowed(exe, getSetting('captureAllowlist'))`. When the allowlist is non-empty, a non-listed process must never reach `validateAndSwitch` — including the fullscreen test at `:279-290`.

- [ ] **Step 4: Replace the display fallback on exit**

`game-detector.ts:485-499` currently calls `switchBackToDisplay()` when the game exits, which puts the desktop into the buffer. Under a non-empty allowlist, do not switch: leave the video source in place so OBS holds its last frame.

**Verify this assumption rather than trusting it.** After implementing, record a clip, kill the app it was capturing, confirm from `main.log` that no display switch occurred, and confirm the saved clip's frames after the kill are the frozen image and not the desktop. If OBS shows black instead of holding the frame, do **not** silently accept it — implement the snapshot fallback using the existing `captureScreenshot` path (`ffmpeg.ts:216-260`): grab the last good frame and swap a static image source into the scene. State clearly in the commit which path shipped.

- [ ] **Step 5: Keep manual window selection authoritative**

Explicit selection through the existing window picker always applies, regardless of the allowlist. The user naming a window is deliberate and should not be overridden by a filter.

- [ ] **Step 6: Build the UI**

In `settings.tsx`'s Display section: a live list of running processes from the existing scan, each tickable; a text field adding an executable by hand; remove and clear-all; a count of running apps allowed versus excluded. Manual entry normalises on the way in and a duplicate is a no-op, not an error — Review Focus #3. A typo that silently never matches reads as a broken allowlist.

- [ ] **Step 7: Verify with three processes**

Allowlist two of three apps. Confirm from `main.log` that only the two trigger a capture switch, and that the desktop never enters the buffer after an allowlisted app exits. Log evidence and clip inspection, not UI appearance.

- [ ] **Step 8: Standard gate, then commit**

```bash
npm run typecheck && npm run build && node scripts\utf8-audit.mjs
git add src/shared/process-name.ts src/shared/types.ts src/shared/constants.ts src/main/game-detector.ts src/main/capture.ts src/main/ipc.ts src/renderer/components/settings.tsx src/renderer/lib/queries.ts
git commit -m "Capture allowlist: capture only named applications"
```

---

### Task 4: Microphone input gain

OBS clamps faders at `OBS_MAX_AUDIO_FADER = 2.0`, so +6 dB is the ceiling. This is a real limit and the UI must say so rather than leaving someone hunting for a 4× that will never appear.

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/constants.ts`
- Modify: `src/main/obs-core.ts:665-671` (fader application), `:351-372` (`setupAudioSources`)
- Modify: `src/main/ipc.ts` (get/set)
- Modify: `src/renderer/components/settings.tsx` (Audio section)

**Interfaces:**
- Produces: `PersistedSettings.micGain: number`, default `1`, range `0`–`2`, step `0.05`.
- Consumes: the existing `micVolume` setting and the `VolumeControl` component (`src/renderer/components/audio-controls.tsx:13`).

- [ ] **Step 1: Add `micGain` to the schema**

Default `1` in `DEFAULT_SETTINGS`, typed `number` in `PersistedSettings`.

- [ ] **Step 2: Compose gain into the fader**

At `obs-core.ts:665-671`, `fader.mul = micGain * micVolume`. Order matters: mic volume must keep its full range so dragging it to zero still silences the mic completely.

- [ ] **Step 3: Add the settings control**

An `Input gain` row beside the existing mic volume, using the shared `VolumeControl`. Live tier — no pipeline restart. Tooltip states the 2× / +6 dB ceiling and that greater gain needs a Windows device-level boost this app cannot control.

- [ ] **Step 4: Verify gain 1.0 changes nothing — Review Focus #4**

Record at gain 1.0, then at 2.0, measure both with `volumedetect` (stderr). Expect the second to be roughly +6 dB. At gain 1.0 the measurement must match the pre-change build; a gain control that alters audio at its default is invisible to users and unacceptable.

- [ ] **Step 5: Standard gate, then commit**

```bash
npm run typecheck && npm run build && node scripts\utf8-audit.mjs
git add src/shared/types.ts src/shared/constants.ts src/main/obs-core.ts src/main/ipc.ts src/renderer/components/settings.tsx
git commit -m "Microphone input gain, capped at OBS's 2x fader limit"
```

---

### Task 5: Deferred settings

Only restart-tier and chain-tier settings defer. Volumes, mutes, hotkeys and notification toggles stay immediate — batching a volume slider behind a button is a regression, not a feature.

`runAction` (`src/renderer/lib/context.tsx:84-116`) drops overlapping mutations rather than queueing them. Deferral reduces that pressure to one flush instead of several racing, but the flush itself must sequence.

**Files:**
- Create: `src/renderer/lib/settings-draft.ts`
- Modify: `src/renderer/components/settings.tsx`
- Modify: `src/renderer/components/controls.tsx:105-208` (the optimistic select/switch pair)
- Modify: `src/renderer/lib/queries.ts:51-83`

**Interfaces:**
- Consumes: the existing `SETTINGS` binding table (`queries.ts:51-83`) and `runAction`.
- Produces:
  - `src/renderer/lib/settings-draft.ts` → `isDeferredKey(key: keyof PersistedSettings): boolean` and a `SettingsDraftProvider` exposing `{ draft, setDeferred, discard, pendingCount, applyAll }`.
  - `DEFERRED_KEYS: readonly (keyof PersistedSettings)[]` — `fps`, `outputResolution`, `visualQuality`, `videoCodec`, `videoEncoder`, `nvencPreset`, `nvencMultipass`, `bufferDuration`, `outputPath`, `screenshotPath`, `captureMode`, `displayIndex`, `windowId`, `desktopDeviceId`, `micDeviceId`, `separateAudioTracks`, `perDeviceAudioTracks`.

- [ ] **Step 1: Write `DEFERRED_KEYS` and `isDeferredKey`**

Create `src/renderer/lib/settings-draft.ts`. The list is derived from the tiers `applyEncoderSetting` already uses (`ipc.ts:976-1011`) — chain tier, full tier, plus settings that rebuild the replay buffer. Do not include `desktopVolume`, `micVolume`, `desktopMuted`, `micMuted`, or any hotkey.

- [ ] **Step 2: Add the draft provider**

Holds pending overrides in memory alongside the applied settings from React Query. Controls for deferred keys write to the draft; live controls write straight through. Discarded on apply, on discard, and on renderer reload.

- [ ] **Step 3: Route deferred controls to the draft**

`controls.tsx:105-170` (optimistic select) and `:194-208` (optimistic switch) gain a check: if the bound key is deferred, write to the draft and skip the IPC call. Keep the existing rollback behaviour for live controls untouched.

- [ ] **Step 4: Build the footer bar**

Visible only when the draft is non-empty. Shows the pending count, **Discard**, and **Apply**. Apply flushes sequentially behind the existing restart overlay (`restart-overlay.tsx:29`) when any pending change is full-tier. Preserve the `outputResolution` short-circuit that skips reinit when resolved dimensions are unchanged (`ipc.ts:1070-1074`).

- [ ] **Step 5: Confirm nothing applies before Apply**

Change a deferred setting and watch `main.log`: no rebuild, no reinit. Then Apply and confirm exactly one rebuild occurs. Use a CDP probe following `scripts/probe-regression.mjs`'s export shape.

- [ ] **Step 6: Handle quit with pending changes — Review Focus #5**

Closing Settings with pending changes discards them behind a confirmation. A partial flush must be impossible: if Apply fails midway, either every change applies or the draft is discarded and the user is told which. OBS must never be left in a state no combination of settings describes.

- [ ] **Step 7: Standard gate, full regression, then commit**

```bash
npm run typecheck && npm run build && node scripts\utf8-audit.mjs
npm run test:ui
git add src/renderer/lib/settings-draft.ts src/renderer/components/settings.tsx src/renderer/components/controls.tsx src/renderer/lib/queries.ts
git commit -m "Defer restart-tier settings behind an explicit Apply"
```

---

## After All Tasks

- [ ] Update README: allowlist, mic gain, and the separate-track editor behaviour are user-facing and currently undocumented.
- [ ] Note the six-audio-stream ceiling in README and in the editor UI. OBS supports six tracks; the app enforces the same cap at `ipc.ts:1433`.
- [ ] `git push origin main`.
