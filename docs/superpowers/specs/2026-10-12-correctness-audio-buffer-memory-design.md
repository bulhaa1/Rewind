# Rewind 1.1.0 — correctness, simpler audio, bounded buffer memory

Date: 2026-10-12
Status: awaiting review
Supersedes nothing. Succeeds 1.0.1.

## Scope

Three changes to the shipping build, all landing as **1.1.0**.

1. Fix every user-facing defect found in a full audit of the renderer and main process.
2. Delete the two audio-track toggles and make split tracks the unconditional default.
3. Make the replay buffer's memory footprint visible and bounded.

**Explicitly out of scope:** the UI redesign. That is 1.2.0 and is designed after 1.1.0
ships, against a base whose correctness has been proven. Several redesign items were
identified during the audit and are recorded in ISSUES.md for that release rather than
being folded in here.

**Unchanged constraints.** No backend, no accounts, no telemetry, no cloud upload, no
mandatory updates. Every feature is local and offline. Clip output stays MP4 with AAC
audio. Verification is measured output — `ffprobe`, `volumedetect`, log lines, saved-file
properties — never a screenshot showing a plausible number.

## Why this release exists as its own shape

The fixes and the redesign touch the same files: `settings.tsx`, `editor.tsx`,
`capture.tsx`, `ui.tsx`. Landing both together means a regression in a new layout and a
regression in a bug fix are indistinguishable in the bug tracker. Fixing first means
1.2.0 lands on a base that has actually been exercised.

## Context: what the audit found

A full read of the renderer (20 files, ~2,795 lines) and main process (18 files), plus
verification of each headline claim by hand against code, git history, the shipped
binaries, and the data the app has actually written on this machine.

### Defects shipping in 1.0.1

| # | Defect | Location |
|---|---|---|
| 1 | `set-mic-gain` has no handler. The slider throws "No handler registered". The validator `isMicGain` exists, unused. | `ipc.ts:769-771`, validator at `:1424` |
| 2 | `getScreenshotMeta` is called on `store.js`, which does not export it. The `?.()` silently yields `{}`, so every screenshot shows "Unknown Source" despite correct data on disk. | `ipc.ts:1322` |
| 3 | Editor "Save as Copy" writes `<name>-edit.mp4`, which `shouldInclude` then excludes forever. The user saves a copy and can never see it again. | `clip-manager.ts:135` |
| 4 | Trim temporaries are named `<name>.trim-<ts>.mp4`, pass `shouldInclude` (they start with `Replay`), and appear in the library while being written. | `clip-manager.ts:133-140` |
| 5 | Rebinding "Start / Stop Recording" invokes the screenshot action. Binary ternary: only `save-replay` gets its own callback. | `ipc.ts:1132` |
| 6 | The panel's Stop button calls `setReplayBufferActive`, which never consumes `takeFinishedOnTeardown()`. A recording finished by the stop is written to disk but never registered, never pushed to the renderer, and carries no metadata. | `ipc.ts:265`, consumer only at `index.ts:436` |
| 7 | `addChannel` passes the pre-write object to `createChannel`, so `cfg.kind` throws on `undefined`. The device persists to `settings.json`; its fader is inert until next launch. | `audio.ts:652` |
| 8 | The notification `message` is put in the popup URL and never read. The subtitle is hardcoded to "Saved to your replays folder" for every non-screenshot type, so an error popup reads "Something went wrong / Saved to your replays folder". | `hooks.ts:58`, `NotificationOverlay.tsx:73` |
| 9 | Three user-visible strings are UTF-8 double-encoded (`â€”`, `â€¦` as U+00E2/U+20AC/U+201D). `utf8-audit.mjs` passes because the files *are* valid UTF-8. | `capture.tsx:139`, `Home.tsx:225,232` |

### Defects one layer down

- `getTrackPeaks` spawns **two** ffmpeg processes per audio track. The first has output
  options before `-i`, is discarded with `void child`, is never registered in
  `runningFfmpeg`, and its rejection is unhandled.
- `withStatus` broadcasts `ready` in its `finally` (`ipc.ts:138-142`) even when the
  operation threw, so the panel claims a live buffer after the engine died. The correct
  pattern already exists at `index.ts:319`.
- `shell.openPath` returns an error string that five handlers discard, so "Open folder"
  reports success even with an unset path.
- The editor window's `backgroundColor` is `#0a0a0a` while the canvas token is
  `oklch(17% 0.006 285)`, producing a visible flash on open and on resize.

### Missed from the previous session

- Task 4 (microphone input gain) shipped **broken** — defect 1 above.
- Task 5 (deferred settings behind an Apply button) was never started; `settings-draft.ts`
  does not exist.
- Task 3 (capture allowlist) was built and then reverted at the user's direction. Nothing
  to carry forward.

## Part 1 — Correctness fixes

Nine user-facing defects and four deep ones, as tabled above. Each is a small, local
change with an observable before and after.

Two of them change what the library contains, so they are worth calling out:

- Defect 3's fix has a design choice attached. "Save as Copy" currently produces a file
  the library filter hides. Either the copy stops using the `-edit` suffix, or the filter
  learns to adopt `-edit` files that Rewind itself wrote. **Adopt them**: the suffix
  predates the editor copies being a user-visible feature, and the comment at
  `clip-manager.ts:132` already says the library should "surface editor copies".
- Defect 6's fix must consume the finished recording in `setReplayBufferActive(false)`,
  performing the same `moveIntoSourceFolder` + `setClipMeta` + `clip-saved` sequence that
  `toggleReplayForUser` already does at `index.ts:436-452`. Reusing that sequence rather
  than duplicating it is the point.

## Part 2 — Audio simplification

### What is removed

`separateAudioTracks` and `perDeviceAudioTracks` are deleted outright: from
`PersistedSettings`, from `DEFAULT_SETTINGS`, from the IPC channel table, from the
preload bridge, from the renderer's API and `SETTINGS` binding table, and from the
Settings UI. The two `SettingSwitchRow`s in `AudioSection` go away.

Split tracks become unconditional. Extra audio devices all share `TRACK.DEVICE_BASE`,
which is what they already do when `perDeviceAudioTracks` is off, so that behaviour is
unchanged — only the untested code path is deleted.

`deviceTrack()` in `audio.ts:745` collapses to a constant, and `computeMixerMask` /
`buildTrackLabels` / `sourceTrackMask` lose their `separate` parameter.

### Migration

`JsonStore.get` already falls back to defaults (`store.ts:53-56`), so a stored
`separateAudioTracks: false` becomes `undefined` and resolves to the new unconditional
behaviour. No migration step is needed. The stale keys are simply ignored and will not
be rewritten unless something else saves settings.

Existing clips are unaffected. The editor reads track labels from per-clip metadata
written at save time (`clip-meta.ts`), not from live settings — that was fixed in 1.0.1
and is the reason this change is safe.

### The microphone track

`computeMixerMask` currently ORs in the desktop and microphone bits unconditionally, so
every recording carries a microphone track even with no microphone. Measured on this
machine: one clip's microphone stream carries **2,087 bps** — digital silence. That is
this build's silence floor.

**The microphone track is included only when a microphone device is configured.**

The gate is deliberately narrow, and this is a correction to an earlier reading of the
requirement. Gating on mute or volume as well would be wrong: the mixer mask is only
recomputed inside `applyAudioTracks`, and a stale mask triggers
`rebuildAndRestart` (`replay-buffer.ts:1038`), which tears down and rebuilds the chain.
Making mute recompute the mask would mean **every mute toggle empties the rolling buffer
and costs up to 8 seconds** (`START_FIRST_ATTEMPT` 3s + `START_RETRY` 5s). Mute must stay
a live-tier control. "A microphone is configured" is stable, changes rarely, and is the
condition that actually predicts whether a track is worth writing.

Result: **2 audio streams with no microphone configured, 3 with one.**

### Cost

Split tracks are not free. Measured on `Replay 2026-10-11 22-08-19.mp4` (58.0s):
258,597 bps of audio across 3 streams versus roughly 86,000 for one — about **1.2 MB
extra per 60-second clip**. That is the price of per-track editing in the editor, and it
is accepted.

### Verification harness

`scripts/audiotracktest.js` currently forces `separateAudioTracks` on. That flag is
gone, so the harness is updated to assert the *default* configuration now produces the
split, and to add the second case: with no microphone configured, exactly 2 streams.

## Part 3 — Buffer memory

### The buffer is already in RAM

This corrects a premise worth stating plainly, because it is the opposite of what it
looks like from the code.

OBS 30.2.4's replay buffer is an **in-memory ring of encoded packets**. In
`obs-ffmpeg-mux.c`, `replay_buffer_data()` does `deque_push_back(&stream->packets, ...)`
into a heap deque with no file I/O in that path. Disk is touched only at `save()`, which
spawns `obs-ffmpeg-mux.exe` and muxes **one** new file from the packets held in RAM.

Verified in this repository's own shipped binary: `obs-ffmpeg.dll` contains the strings
`Wrote replay buffer to`, `obs-ffmpeg-mux`, `max_size_mb` and `max_time_sec`, and
`obs-ffmpeg-mux.exe` ships in the package. The `IReplayBuffer` type surface
(`module.d.ts:887-896`) exposes no memory, size, or path-indirection option, because there
is none to have.

So Rewind's rolling buffer is already RAM-resident. There is no RAM-versus-disk setting
to add, and Windows ships no tmpfs or RAM disk that could be pointed at anyway.

### The real problem this uncovered

`usesStream = true` (`replay-buffer.ts:405`) makes obs-studio-node set
`max_size_mb = 0`, which **disables OBS's byte cap**. The buffer is therefore bounded by
*time only*, with no ceiling on memory. The live figure lives in a separate `obs64.exe`
process, so the UI cannot observe it.

Measured against this machine's own clips (~1,450 kbps video + ~259 kbps audio):

| Buffer length | At this machine's bitrate | At highest quality (20 Mbps) |
|---|---|---|
| 60s | 12 MB | 145 MB |
| 120s | 24 MB | 290 MB |
| 300s | 61 MB | 725 MB |

At 60 seconds the current setting is comfortable. A 5-minute buffer at highest quality
puts roughly **725 MB** of live heap in a process nothing in the UI can see, with no
warning.

### What ships

**A corrected comment.** `replay-buffer.ts:358-360` claims `usesStream` "makes the replay
buffer roll instead of writing continuously". It does not. Rolling comes from OBS's
`replay_buffer` output type; `usesStream` selects which encoder object is borrowed and
zeroes the byte cap. The comment is corrected to say what the flag actually does, because
it has been actively misleading anyone who read it.

**A Memory budget readout in Settings**, showing the estimated buffer RAM for the current
buffer duration and visual quality, updating live as either changes, computed from
`VBR_KBPS_BY_QUALITY` plus a measured audio bitrate. It is explicitly labelled an
estimate. Above a threshold — **512 MB by default** — it warns.

512 MB never fires at this machine's settings, and trips immediately at the worst case
above. The threshold is user-adjustable.

**No hard cap.** The only mechanism OBS exposes for a byte ceiling is `usesStream = false`,
which would cost the streaming encoder the capture chain depends on. An honest readout
beats a toggle that silently breaks encoding.

## Part 4 — Release

### Differential downloads

The 1.0.1 GitHub release carries `latest.yml` and `Rewind-1.0.1-setup.exe` and **no
`.blockmap`**, so the updater 404s on it and falls back to a full ~210 MB fetch on every
update. The blockmap is produced by the local build (`release/` contains a 0.2 MB
`.blockmap`) — the `--prepackaged` publish path in `npm run release` is not uploading it.

The publish path is corrected and the fix is verified by confirming the asset is present
on the published release, not by assuming the build emitted it.

### Package size

The installer ships **~223 MB (35.5%)** of Chromium Embedded Framework for the
`obs-browser` plugin, which Rewind never instantiates — no browser source is created
anywhere in `src/main`.

Verified before committing to this: `obs_studio_client.node` and `obs.dll` have **no**
`libcef.dll` in their PE import tables. Only `obs-browser.dll` links it, and OBS loads
plugins with `os_dlopen` and tolerates failure, so removing it drops the Browser source
and nothing else. The app's capture setup never references it.

CEF files are stripped from `extraResources` in `electron-builder.yml`, then the build is
packaged and the **full record → save → edit loop is run against the packaged build**. The
strip ships only if OBS starts clean, the encoder is unaffected, and no plugin-load
failure appears in `main.log`. Otherwise it is reverted and the measured size is reported
either way.

### Documentation

- The README hotkey table documents an `Alt+1` panel-toggle hotkey that **does not
  exist**, and mislabels the two that do. The real bindings are `Alt+1` save replay,
  `Alt+2` screenshot, `Alt+3` start/stop recording.
- README still lists separate audio tracks as unverified. That was proven on 2026-10-11.
- Undocumented since they shipped: microphone input gain, master clip volume, draggable
  trim selection.
- Prose errors on the comparison paragraph: "purposly" → "purposefully", "there favorite"
  → "their favorite".
- `docs/` — the previous session's spec and plan — is untracked and gets committed.

### Version

1.0.1 → **1.1.0**, with release notes written rather than the single word "bugfixes."

### Continuous integration

There is no `.github` directory at all. A minimal workflow runs `npm run typecheck` and
`npm run build` on push and on pull requests.

The specific motivation is defect 1: a handler that typechecks perfectly, passes every
existing check, and is simply never registered. That class of bug is invisible to the
current gate and is exactly what a channel-coverage check catches. **The workflow also
runs the channel-coverage assertion** from Part 1 — every `IPC.*` constant declared in
`src/shared/ipc.ts` must have a handler — so the same failure cannot recur silently.

## Testing strategy

Every task passes the standard gate:

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
```

Renderer behaviour is verified through `npm run test:ui` (16 CDP checks against a running
app on `--remote-debugging-port=9222`). There is no unit test framework in this project
and none is added; the existing seams are the `REWIND_SELFTEST*` env modes and the CDP
probe harness.

### Claims of correctness come from measured output

Each Part 1 fix has a named observable:

| Fix | Evidence |
|---|---|
| `set-mic-gain` | CDP probe: `setMicGain(1.5)` succeeds, `getMicGain` reads back 1.5, log shows the gain filter at the expected dB |
| Screenshot metadata | The 4 existing screenshots on disk show their real source names, not "Unknown Source" |
| Save as Copy | Save a copy, confirm it appears in the library |
| Trim temporaries | No `.trim-` row appears mid-trim |
| Hotkey rebind | Rebind Start/Stop, confirm it toggles recording and takes no screenshot |
| Stop registers recording | Record, stop the buffer, confirm the clip appears immediately with metadata |
| Add audio device | Add a device, confirm no throw and a live fader |
| Notification message | Trigger an error, confirm the popup shows the real message |
| Mojibake | Zero U+00E2 characters in `src/` |

Audio layout is verified with `scripts/audiotracktest.js`: default configuration produces
3 streams with a microphone configured, 2 without. Stream counts and per-stream volumes
come from `ffprobe` and `volumedetect`.

Known harness constraints, carried forward from the previous release:

- `npm run test:ui` deletes one clip and one replay per run.
- `VolumeControl` commits on `onPointerUp`; CDP mouse events do not move it. Drive these
  controls by keyboard, which commits on `onKeyUp`.
- `volumedetect` writes to **stderr**. Capturing only stdout produces a false zero. This
  has already caused one false negative in this project.

## Risks

| Risk | Response |
|---|---|
| Stripping CEF breaks OBS startup | Verified via import tables that neither `obs.dll` nor the node binding links it; the packaged build is exercised end to end before shipping. Reverted if not clean. |
| Mic gating makes mute expensive | Avoided by design — the gate reads only whether a device is configured, never mute or volume. Mute stays live tier. |
| Removing the toggles breaks an external caller | No external callers exist; the bridge is consumed only by this app's own renderer. |
| Deleting `perDeviceAudioTracks` removes something users wanted | It is listed as **Untested** in ISSUES.md — no evidence it ever worked. Its off-state behaviour (extra devices share one track) is preserved. |
| A masked defect surfaces only after release | The channel-coverage check in CI is designed to catch the whole class, not just this instance. |
| Blockmap fix does not actually publish | Verified by inspecting the published release's asset list, not by trusting the build output. |

## Not in 1.1.0

Found during the audit, recorded in ISSUES.md, deliberately deferred:

- `saveReplayBuffer` has no re-entrancy guard; overlapping saves orphan a promise, time
  out after 10s, and trigger a spurious full OBS restart.
- No ffmpeg timeout anywhere except screenshots, so a hung encode hangs the Record path
  indefinitely.
- `setWindow` does not stop the game detector, so auto-detect reclaims a manually chosen
  window within seconds.
- `captureStateQuery` rejection renders an infinite spinner in Settings with no error and
  no retry; a rejected clips query renders the empty state, indistinguishable from empty.
- `OBS_STATUS_MESSAGES.saving` is never emitted, so the renderer's "Saving clip…" branch
  is unreachable.
- `rewind://` is registered as a protocol but no deep link is ever handled.
- The UI redesign itself.

## Decisions made without asking

Two small defaults, chosen and flagged rather than escalated:

- **CI: added.** Defect 1 is precisely the failure a typecheck-plus-channel-coverage gate
  catches and the current setup misses.
- **Memory warning threshold: 512 MB.** Never fires at realistic settings; trips hard at
  the worst case the feature exists to reveal.