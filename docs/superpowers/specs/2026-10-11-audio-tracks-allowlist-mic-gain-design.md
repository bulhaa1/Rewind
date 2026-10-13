# Audio tracks, capture allowlist, mic gain, deferred settings

Date: 2026-10-11
Status: awaiting review

## Scope

Four features on top of the existing OBS-based pipeline.

**In scope**

1. Verify the existing separate-audio-track machinery, then fix the multi-track editor.
2. Capture allowlist — capture only named applications.
3. Microphone input gain.
4. Deferred settings with an explicit Apply button.

**Out of scope, dropped during design**

- Advanced settings tab and bitrate / rate-control exposure. Dropped by the user
  before build. The reasoning that informed it is preserved below in
  "Dropped: advanced tab" because it constrains the encoder settings that already ship.

**Unchanged constraints.** No backend, no accounts, no telemetry, no mandatory
updates. Preserve existing behaviour. Every feature is verified against real
output rather than UI appearance. Honest reporting of anything that does not work.

## What already exists

Two of the four items are repair work, not new construction, and this shapes the plan.

- `separateAudioTracks` and `perDeviceAudioTracks` are fully wired:
  `obs-core.ts:351-372` creates desktop audio and mic as independent OBS sources,
  `obs-core.ts:688-717` assigns tracks and builds labels, `replay-buffer.ts:437-459`
  pre-creates all six AAC tracks. They are listed under **Untested** in ISSUES.md:
  "shipped, reachable in the UI, never actually exercised."
- The editor already renders a lane per audio track with its own waveform and
  volume control (`editor.tsx:415-431`), and saving applies per-track volumes
  through an ffmpeg `amix` filter chain (`editor.ts:296-334`).

So items 1 and 3 of the original request reduce to: prove it works, then fix what
is broken. Building new machinery on top of unverified ground is the expensive
order, so verification goes first.

## Phase 0 — verify separate audio tracks

No production code. Establish ground truth before building.

### Procedure

1. Back up `settings.json`; set `separateAudioTracks: true`, `perDeviceAudioTracks: false`.
2. Launch, record a clip with both a microphone and desktop audio present.
3. `ffprobe -print_format json -show_streams` on the result:
   - count audio streams;
   - dump each stream's `tags` — specifically whether OBS wrote a per-track name.
4. Extract each audio stream and measure it independently with
   `ffmpeg -af volumedetect`. The two streams must differ, and must contain the
   right audio — speech in the mic stream, game audio in the gameplay stream.
   A stream count of two is not sufficient evidence; identical streams are a failure.
5. Open the clip in the editor and confirm both lanes render with correct labels
   and distinct waveforms.
6. Restore `settings.json`.

`volumedetect` reports on stderr. Capturing only stdout yields a false zero — this
has already produced one false negative in this project.

### Decision points

| Observation | Consequence |
|---|---|
| Track names present in ffprobe `tags` | Phase 1 reads labels from the file. No sidecar index needed. |
| Track names absent | Phase 1 falls back to a sidecar `.rewind.json` written beside each clip at save time. Flag this to the user before building it. |
| Streams exist but carry identical audio | The track split is cosmetic only. Stop and report; the editor work is blocked on a different fix. |
| Fewer than two streams at all | `separateAudioTracks` is broken at the OBS level. Stop and report. |

### Outcome

A written finding in ISSUES.md moving each of the four Untested audio items to
Verified or Open, with the measured evidence attached.

## Phase 1 — per-clip track metadata

### The bug

`editor.ts:154` decides whether to split a clip into lanes with:

```
split = streamCount > 1 && trackLabels.length === streamCount
```

`trackLabels` comes from `obsCore().audioTrackLabels()` (`ipc.ts:1160`), which
reflects **current settings**, not what the clip was recorded with. Turn
`separateAudioTracks` off after recording a multi-track clip and every such clip
silently degrades to a single undifferentiated mix. The same clip also renders
differently depending on which machine opens it.

### Fix

Make the clip describe itself. `getClipInfo` reads per-stream labels from the
container via ffprobe and no longer consults `audioTrackLabels()` when deciding
whether to split. Generic labels (`Track 2`, `Track 3`) when the container carries
no name.

**Degrade, never collapse.** If streams cannot be named, render one lane per stream
with a generic label instead of falling back to a single mix lane. The current
"all or nothing" split is the actual damage — a mislabelled multi-lane view is more
useful than a false single-lane one.

### Limits to state, not hide

Six audio streams is the ceiling (`ipc.ts:1433`, `ipc.ts:1170`), matching OBS's own
six-track limit. This is documented in the UI and README rather than silently
truncating.

### Testing

Record a multi-track clip. Toggle `separateAudioTracks` off. Reopen the clip: the
lanes must be identical. That exact sequence is the regression test.

## Phase 2 — capture allowlist

### Motivation

The detector is a denylist. `game-detector.ts:8-25` states it plainly: "an unknown
fullscreen app is treated as a game candidate." The exclusion list is 105 hardcoded
entries and cannot cover apps nobody anticipated. The user does not want full-screen
capture at all, and specifically does not want the desktop captured after a game exits.

### Model

New setting `captureAllowlist: string[]` (default `[]`).

- Empty — current behaviour, denylist applies. Nothing regresses.
- Non-empty — **allowlist supersedes the denylist**. Only listed executables qualify
  as capture candidates. An allowlist that did not supersede would leave the
  denylist doing work it no longer needs to do.

### Entry format

Entries are lowercase executable stems with `.exe` stripped — the same
normalisation `game-detector.ts:217` already applies before `isExcluded` compares
against `EXCLUDED_PROCESSES`. Both paths route through one shared helper rather
than duplicating the rule, so the two lists cannot drift into disagreeing about what
`Valorant.exe` means.

Manual entry is normalised on the way in and an already-present duplicate is a
no-op rather than an error. This matters because a typo that silently never matches
looks like a broken allowlist, not a typo.

Explicit manual selection via the existing window picker is always honoured regardless
of the allowlist. The user naming a window is a deliberate act that should not be
second-guessed by a filter.

### Exit behaviour

Today, when the detected game exits, `game-detector.ts:485-499` switches the source
back to display capture, so the rolling buffer keeps filling with desktop content.
Under an allowlist this is replaced by **holding the last frame** — the desktop is
never captured.

Implementation is to leave the video source in place rather than switching to the
monitor. Whether OBS composites the last frame from a now-windowless
`window_capture` source, or shows black, is **not yet confirmed** and is checked
during implementation. If it shows black, the fallback is to snapshot the last good
frame with the existing `captureScreenshot` path (`ffmpeg.ts:216-260`) and swap a
static image source into the scene. That path is heavier and slower to recover; it is
a fallback, not the plan.

### UI

In the existing Display section, alongside the window list:

- a live list of running processes and windows to tick, reusing the scan
  `game-detector.ts:223-239` already performs;
- a text field to add an executable by hand, for a game not currently running;
- remove and clear-all controls;
- a count of currently running apps that are allowed, versus excluded.

The manual field matters: a persistent allowlist is only useful if it can be populated
before launching the game.

### Testing

Three processes, two allowlisted. Confirm only allowlisted apps trigger a capture
switch; confirm the desktop never enters the buffer after an allowlisted app exits.
Both confirmed from `main.log` and by measuring the recorded clip, not by appearance.

## Phase 3 — microphone input gain

### Model

New setting `micGain: number`, default `1`, range `0`–`2`, step `0.05`.

Applied at `obs-core.ts:665-671` as the mic fader multiplier:

```
fader.mul = micGain * micVolume
```

Composed in that order so the existing mic volume slider keeps its full range and
behaviour — moving it to zero still silences the microphone completely.

### Known limit, stated in the UI

OBS clamps faders at `OBS_MAX_AUDIO_FADER = 2.0`, so input gain tops out at 2×,
about +6 dB. Downward adjustment is unlimited to silence. A microphone needing more
than +6 dB requires a Windows device-level boost, which this app cannot control.
The tooltip says so rather than letting someone hunt for a missing 4× that will
never appear.

Noise suppression and noise gating are deliberately excluded.

### UI

An `Input gain` row in the Audio section beside the existing mic volume, using the
shared `VolumeControl` so it behaves like every other volume in the app. Live tier —
no pipeline restart.

### Testing

Record at gain 1.0, then at 2.0, and measure the difference with `volumedetect`.
Expect approximately +6 dB. Same technique used to verify the master clip volume in
`868c177`.

## Phase 4 — deferred settings

### Why only some settings defer

`applyEncoderSetting` (`ipc.ts:976-1011`) already classifies settings into three
tiers. Only the expensive two get deferred:

| Tier | Examples | Behaviour |
|---|---|---|
| live | volumes, mutes, hotkeys, notification toggles | apply immediately, never deferred |
| chain | encoder settings, NVENC preset/multipass | deferred to Apply |
| full | fps, output resolution | deferred to Apply, restart overlay |

Batching a volume slider behind a button would be a regression. Dragging a fader
must stay immediate.

Note `outputResolution` already short-circuits when the resolved dimensions are
unchanged (`ipc.ts:1070-1074`); deferral preserves that.

Also deferred, since each rebuilds the replay buffer: buffer duration, output paths,
capture source, audio device selection, separate-track flags.

### Draft state

The renderer holds an in-memory draft of pending overrides alongside the applied
settings held by React Query. Controls carrying deferred keys write to the draft;
live controls write straight through. There is one source of truth per setting —
the draft shadows it only while dirty, and is discarded on apply, on discard, and on
renderer reload.

`runAction` (`context.tsx:84-116`) drops overlapping mutations rather than queueing
them, on the reasoning that a queued full restart behind three more changes is
indistinguishable from a hang. Deferred settings reduce the problem rather than
adding to it: one flush instead of several racing ones. The flush itself must
sequence, not race.

### UI

A footer bar, shown only when the draft is non-empty:

- count of pending changes;
- **Discard**, reverting the draft;
- **Apply**, flushing every pending change in sequence behind the existing restart
  overlay when any change is full-tier.

Closing Settings with pending changes discards them, with a confirmation so the
loss is never silent.

## Dropped: advanced tab

Withdrawn at the user's direction. Recorded because it constrains what already ships:

Hardware encoders do not expose a bitrate. NVENC, AMF and QSV all use constant
quality — CQP or ICQ — where the user picks a quality number and the encoder spends
whatever bitrate it needs. The only bitrate in the codebase is the x264 VBR mapping
`VBR_KBPS_BY_QUALITY` (`constants.ts:97-102`), derived from the existing Visual
Quality dropdown. Exposing a bitrate therefore requires exposing a rate-control mode
first, because the bitrate is a property of that mode and is meaningless without it.

The NVENC multipass and preset rows in the Quality section remain as they are.

## Testing strategy

Every phase runs: `tsc --noEmit`, `npm run build`, `node scripts\utf8-audit.mjs`,
and `npm run test:ui` against the app on `--remote-debugging-port=9222`.

Claims of correctness come from measured output — `ffprobe`, `volumedetect`, log
lines, saved-file properties — never from a screenshot showing the right number.

Known harness constraints:

- `npm run test:ui` deletes one clip and one replay per run.
- Clips live in per-source subfolders; stale filenames fail with "Source clip not found".
- `VolumeControl` commits on `onPointerUp`; CDP mouse events do not move it. Drive
  these controls by keyboard, which commits on `onKeyUp`.
- The editor window closes between probe runs; each test re-opens it.

## Risks

| Risk | Response |
|---|---|
| Phase 0 finds `separateAudioTracks` broken at the OBS level | Stop, report, do not build the editor work on a broken foundation |
| OBS does not hold the last frame on a vanished window capture | Snapshot-and-swap fallback, implemented only if confirmed necessary |
| The 6-stream ceiling is hit | Documented in UI and README, not silently truncated |
| Allowlist interacts with the open black-screen bug (ISSUES.md:23-64) | Both concern what happens when a captured window disappears. Re-read that entry before starting Phase 2; the allowlist may remove the most common trigger for it |
| Interaction with the unverified 60 fps bug | Unrelated code paths; no mitigation needed |

## Out of scope

The black-screen bug (ISSUES.md:23-64) and its three open product questions remain
open and unanswered. The resolution-change fix (ISSUES.md:86-124) still awaits
real-world testing. Neither is touched by this work.
