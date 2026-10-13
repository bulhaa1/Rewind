# Rewind 1.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 1.1.0 with every verified user-facing defect fixed, both audio-track toggles removed in favour of an unconditional split, and the replay buffer's memory footprint made visible.

**Architecture:** Thirteen independent tasks. Tasks 2–10 are single-defect repairs, each touching a different file so a reviewer can reject one while approving its neighbour. Task 1 lands a channel-coverage check first, because the most serious defect in this release is precisely the class it catches. Task 11 is the audio simplification and must run after Task 2, since both edit `src/main/ipc.ts`. Task 12 is display-only and independent. Task 13 is release work with its own verification loop.

**Tech Stack:** Electron 30.5.1, TypeScript 5.7, React 18, Vite 6, Tailwind v4, `@streamlabs/obs-studio-node` 0.25.77, ffmpeg/ffprobe via `ffmpeg-static`/`ffprobe-static`, electron-updater 6.8.9. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-correctness-audio-buffer-memory-design.md`

## Global Constraints

- No new runtime dependencies. `node_modules` gains nothing in this plan.
- No backend, accounts, telemetry, cloud upload, or mandatory updates. Every feature stays local and offline.
- Clip output remains MP4 with AAC audio. Do not change container or codec.
- Verification is measured output — `ffprobe`, `volumedetect`, log lines, saved-file properties — never a screenshot showing a plausible number.
- `volumedetect` writes to **stderr**. Capturing only stdout produces a false zero. This has already caused one false negative in this project.
- Existing settings must keep working. `JsonStore.get` (`src/main/store.ts:53-56`) falls back to defaults, so a removed key resolves to its default rather than `undefined`.
- Preserve existing behaviour when a feature is off. Every fix must be a no-op for a user who never triggered the bug.
- Copy style matches surrounding code: comments state *why*, not *what*.
- Commit after every task. Push at the end of the plan.
- Windows x64 only. Paths, `NUL`, and shell assumptions are all Windows-specific and correct as they stand.

## Test Infrastructure

This project has **no unit test framework** — no vitest, no jest, no `*.test.ts`. Do not add one. Use the two seams that exist.

**Main-process logic** — the `REWIND_SELFTEST*` env seam in `src/main/index.ts` dispatches to `runSelfTest`, `runRecordSelfTest`, `runSettingsSelfTest`, and `runAudioTrackSelfTest`. Each launches the real pipeline, does the real thing, writes evidence to `REWIND_SELFTEST_OUT`, and calls `app.exit(code)`. Drivers: `scripts/selftest.js`, `scripts/audiotest.js`, `scripts/recordtest.js`, `scripts/audiotracktest.js`.

**Renderer logic** — `scripts/cdp.mjs` runs a probe module against a running app on `--remote-debugging-port=9222`. `npm run test:ui` runs `scripts/probe-regression.mjs`. Probe modules export `async function ({ evaluate, send, drainErrors })` and print `PASS`/`FAIL` lines.

**Static checks** — `scripts/utf8-audit.mjs` validates UTF-8; it does **not** catch mojibake, because double-encoded files are still valid UTF-8. Task 1 adds the check that does.

Standard gate for every task:

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
```

## Review Focus

Five conditions a reasonable person would expect to work, which no task's happy path covers. Each names the input and the expected behaviour.

1. **A clip recorded with 3 audio streams, then the microphone unplugged, then a new clip recorded.** The new clip must carry 2 streams, not 3. The gate reads device presence at build time — see Task 11.
2. **An existing user upgrading from 1.0.1 with `separateAudioTracks: false` in their `settings.json`.** They must get split tracks immediately, with no stale `false` overriding the new default. → Task 11
3. **Editor "Save as Copy" on a clip in a source subfolder.** The copy must appear in the library *and* survive the next rescan. Adopting `-edit` files must not make trim temporaries visible. → Task 4
4. **Muting the microphone while the buffer is rolling.** Must be instant and must **not** empty the rolling buffer. This is why the mask gate ignores mute. → Task 11
5. **Pressing Stop on the buffer while a continuous recording is running.** The finished clip must appear in the library immediately, with metadata, without waiting for a rescan. → Task 6

---

### Task 1: Channel-coverage check and CI

The most serious defect in this release — a handler that typechecks perfectly and is never registered — is invisible to every check this project currently has. This task adds the check that catches it, then puts it in CI.

**Files:**
- Create: `scripts/channel-check.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (add a `verify:channels` script)

**Interfaces:**
- Consumes: `src/shared/ipc.ts` (the `IPC` constant), `src/main/*.ts` (handler registrations).
- Produces: `npm run verify:channels`, which exits non-zero and prints the offending channel when any `IPC.*` constant is declared but never handled.

- [ ] **Step 1: Write the coverage script**

`scripts/channel-check.mjs` must recognise handlers registered three ways, because the codebase uses all three:

- `handle(IPC.<name>, …)` — the `handle()` envelope, used by almost every channel
- `ipcMain.handle(IPC.<name>, …)` — used by `startHotkeyCapture` (`src/main/ipc.ts:1139`)
- `toggle(IPC.get<Name>, IPC.set<Name>, …)` — the helper at `src/main/ipc.ts:1091` that registers a **pair** of channels from one call. It is used by `notificationsEnabled`, `notificationSoundEnabled`, and `launchOnStartup`.

Build the declared set by matching `/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g` against `src/shared/ipc.ts`. Build the handled set with the three patterns above over every `src/main/*.ts`. Print each declared-but-unhandled constant as `IPC.<name> -> '<channel>'` and exit 1 if the list is non-empty.

**The `toggle()` pattern is not optional.** An earlier draft of this check omitted it and reported six false positives — `getNotificationsEnabled`, `setNotificationsEnabled`, `getNotificationSoundEnabled`, `setNotificationSoundEnabled`, `getLaunchOnStartup`, `setLaunchOnStartup` — all of which are correctly registered through the helper. A coverage check that cries wolf gets deleted, so verify the baseline is clean before trusting it.

- [ ] **Step 2: Run it and confirm it finds exactly one real gap**

Run: `node scripts\channel-check.mjs`
Expected: exactly one line — `IPC.setMicGain -> 'set-mic-gain'`. Any other output means a pattern is wrong; fix the script before continuing, because Task 2 removes this gap and a check that still fails afterwards is broken.

- [ ] **Step 3: Add the npm script**

Add to `package.json` scripts: `"verify:channels": "node scripts/channel-check.mjs"`.

- [ ] **Step 4: Add the CI workflow**

`.github/workflows/ci.yml` runs on `push` to `main` and on `pull_request`. One job, `ubuntu-latest`, `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 20` and `npm ci`, then:

```yaml
- run: npm run typecheck
- run: npm run verify:channels
- run: npm run build
```

Native modules (`@streamlabs/obs-studio-node`, `koffi`, `uiohook-napi`) are Windows binaries. `npm ci` installs but does not rebuild, and **none of these three commands load them** — `typecheck` reads `.d.ts`, `verify:channels` parses source as text, and `build:renderer` is pure TypeScript. `npm run build` does include `build:main`, which is esbuild over TypeScript and also does not execute the modules. If the workflow fails on native modules, the fix is `npm install --ignore-scripts` in the workflow, not removing a step.

**The channel check must run before `build`** in the workflow, so a missing handler fails in seconds rather than after a full build.

- [ ] **Step 5: Verify the workflow is well-formed**

Run: `node -e "const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!s.includes('verify:channels'))throw new Error('missing channel check'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add scripts/channel-check.mjs .github/workflows/ci.yml package.json
git commit -m "Add a channel-coverage check and run it in CI"
```

---

### Task 2: Write the missing `set-mic-gain` handler

Microphone input gain shipped in 1.0.1 as a working-looking slider that throws "No handler registered for 'set-mic-gain'" on every drag. The channel is declared, bridged, typed, and called; only the handler is missing. The validator was written and never used.

**Files:**
- Modify: `src/main/ipc.ts:769` (insert the handler after `getMicGain`)
- Modify: `ISSUES.md` (move mic gain from any unverified listing to Verified)

**Interfaces:**
- Consumes: `isMicGain` (`src/main/ipc.ts:1424`), `MIC_GAIN` (`src/shared/constants.ts:154`), `obsCore().applyChannelLevel('microphone')`.
- Produces: IPC channel `set-mic-gain` accepting a number in `[MIC_GAIN.MIN, MIC_GAIN.MAX]` and returning `{ success: true }` or `{ success: false, error }`.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-mic-gain.mjs` exporting `async function ({ evaluate })`. Assert three things in order:

- `window.electronAPI.setMicGain(1.5)` resolves with `success === true`
- `window.electronAPI.getMicGain()` then resolves with `data === 1.5`
- `window.electronAPI.setMicGain(99)` resolves with `success === false` (out of range must be rejected, not clamped)

Print `PASS`/`FAIL` per assertion.

- [ ] **Step 2: Run it and watch it fail**

Start the app on the debug port and run:
```bash
node scripts\cdp.mjs scripts\probe-mic-gain.mjs
```
Expected: all three FAIL, the first with `No handler registered for 'set-mic-gain'`.

- [ ] **Step 3: Write the handler**

Insert directly after the `getMicGain` handler at `src/main/ipc.ts:769`. Model it on `setChannelVolume` (`ipc.ts:738-750`): validate with the existing `isMicGain`, persist with `setSetting('micGain', value)`, apply live via `obsCore().applyChannelLevel('microphone')`, return `ok()`. Catch and return `fail(messageOf(e))`.

Live tier — no pipeline restart. `applyChannelLevel` already calls `applyInputGain` (`obs-core.ts:386`), which is the entire reason gain can be applied without touching the audio graph.

The orphaned validator at `ipc.ts:1424` and the `MIC_GAIN` import added for it now have a caller; that is the whole defect.

- [ ] **Step 4: Verify the handler is registered**

Run: `node scripts\channel-check.mjs`
Expected: no output, exit 0. This is the check from Task 1 paying for itself — before this handler existed it named exactly this channel.

- [ ] **Step 5: Run the probe again**

```bash
node scripts\cdp.mjs scripts\probe-mic-gain.mjs
```
Expected: 3/3 PASS.

- [ ] **Step 6: Confirm the gain reaches OBS**

Read `main.log` and confirm a gain line appears showing the filter applied and read back at 1.5 (about +3.5 dB). A `setMicGain` that persists but never reaches OBS is the same defect wearing a different hat.

- [ ] **Step 7: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
node scripts\verify:channels
git add src/main/ipc.ts scripts/probe-mic-gain.mjs ISSUES.md
git commit -m "Write the missing set-mic-gain handler"
```

---

### Task 3: Read screenshot metadata from the right module

`scanScreenshots` (`src/main/ipc.ts:1322`) calls `getScreenshotMeta` on `./store.js`, which does not export it — it lives in `./clip-meta.js`. The optional-call `?.()` swallows the `TypeError` and yields `{}`, so every screenshot renders as "Unknown Source" with an mtime-derived timestamp, while correct data sits unread in `screenshot-meta.json`.

**Files:**
- Modify: `src/main/ipc.ts:1322`

**Interfaces:**
- Consumes: `screenshotMeta` (`src/main/store.ts:101`), shape `{ screenshots: Record<absolutePath, { capturedAt: number; source?: string }> }`.
- Produces: unchanged `ScreenshotInfo[]`, now with real `capturedAt` and `source`.

- [ ] **Step 1: Fix the lookup**

Replace line 1322 with a read of the store's screenshot map, keyed by absolute path. `scanScreenshots` already computes `full` at `:1329`, so index with that.

Note the shape difference that caused this bug: `store.ts` exposes the **map** (`screenshotMeta.screenshots`), while `clip-meta.ts` exposes a **getter** (`getScreenshotMeta(file)`) that does the lookup. Either works; pick the store map so this file stops reaching into another module for one field. Do not add a new export.

- [ ] **Step 2: Verify against real data**

The screenshots on disk already have correct metadata. Launch the app, open Settings, and confirm each screenshot row shows its real source name (e.g. "Auto Game Capture") instead of "Unknown Source".

Do not settle for "no error". The original code also produced no error. The observable is the *source name changing from "Unknown Source" to a real value*.

- [ ] **Step 3: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/main/ipc.ts
git commit -m "Read screenshot metadata from the store that holds it"
```

---

### Task 4: Make editor copies visible and trim temporaries invisible

Two library-filter bugs with the same root: `shouldInclude` (`src/main/clip-manager.ts:133-140`) rejects every `-edit` file, which is exactly what "Save as Copy" produces, and accepts every `Replay*` file, which includes the `.trim-<timestamp>.mp4` temporary the editor writes into the library folder mid-trim.

**Files:**
- Modify: `src/main/clip-manager.ts:19-25` (`isEditorCopy`) and `:133-140` (`shouldInclude`)
- Modify: `src/main/editor.ts:381` (trim temporary naming, if renamed below)

**Interfaces:**
- Consumes: `isEditorCopy(fileName: string): boolean` (exported, used by `shouldInclude`).
- Produces: library contains editor copies; library excludes `.trim-` temporaries at every point in the trim lifecycle.

- [ ] **Step 1: Exclude trim temporaries**

`shouldInclude` runs on every library scan. A `.trim-` file exists only between `editor.ts:381` writing it and the rename at `editor.ts:425` replacing the original. Add a check for a `.trim-` infix in the stem, mirroring how `isEditorCopy` tests the `-edit` suffix at `:19`.

- [ ] **Step 2: Adopt editor copies**

Flip the `isEditorCopy` early-return in `shouldInclude` so editor copies are included rather than dropped. The function's own comment at `:132` already says the library should "surface editor copies, not temporaries" — the code below it does the opposite.

Check every other caller of `isEditorCopy` before flipping the shared function. If another caller uses it to mean "a file Rewind should not adopt", narrow the change to `shouldInclude` rather than changing shared behaviour blindly. Grep first: `grep -rn "isEditorCopy" src/`.

- [ ] **Step 3: Prove a save-as-copy survives a rescan**

Open a clip, trim it, choose **Save as Copy**, then confirm the copy appears in the library. Restart the app, wait for the library to rescan, and confirm it is **still** there.

The rescan check is Review Focus #3 and is the one that matters. An editor copy that appears once and vanishes on the next scan is the original bug wearing a different mask.

- [ ] **Step 4: Prove a trim temporary never appears**

Start a trim and, while ffmpeg is writing, query the library from the CDP probe:

```js
window.electronAPI.getSavedClips().then(r => r.data.filter(c => c.filename.includes('.trim-')))
```
Expected: empty array. Repeat three times at different points in the save.

- [ ] **Step 5: Standard gate, full regression, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
npm run test:ui
git add src/main/clip-manager.ts src/main/editor.ts
git commit -m "Show editor copies in the library and hide trim temporaries"
```

---

### Task 5: Fix the hotkey rebind callback

`src/main/ipc.ts:1132` picks a callback with a binary ternary: `action === 'save-replay' ? s.saveClipHotkey : () => void s.takeScreenshotHotkey()`. Only `save-replay` gets its own callback. Both `screenshot` and `toggle-replay` receive the screenshot callback, so rebinding "Start / Stop Recording" takes a screenshot instead.

**Files:**
- Modify: `src/main/ipc.ts:1132`

**Interfaces:**
- Consumes: `HOTKEYS` (`src/main/hotkey.ts:13-17`), which already carries a per-action `label`; `services` (`s.saveClipHotkey`, `s.takeScreenshotHotkey`).
- Produces: every action's rebind registers that action's own callback.

- [ ] **Step 1: Replace the ternary with an explicit lookup**

Build a `Record<HotkeyAction, () => void>` mapping each action to its callback and index it with `action`. Three actions exist: `save-replay`, `screenshot`, `toggle-replay`.

The `toggle-replay` callback is `services.toggleReplayForUser` reached through the `services` object — confirm the exact property name on `services` rather than assuming it mirrors the hotkey action name. Grep `src/main/index.ts` for `toggleReplayForUser` and use whatever `services` exposes.

**Exhaustiveness matters here.** Type the map as `Record<HotkeyAction, () => void>`, not an indexed object, so adding a fourth hotkey later becomes a compile error rather than a fourth silent bug of exactly this kind.

- [ ] **Step 2: Verify each action dispatches its own callback**

For each of the three actions: open Settings → Hotkeys, rebind to a spare combination, confirm `setHotkey` succeeds, then trigger the hotkey and confirm the right action fires — replay saved, screenshot taken, or recording toggled.

The third is the one that was broken. Confirm a screenshot is **not** taken when the start/stop hotkey fires.

- [ ] **Step 3: Confirm a conflict is still rejected**

Rebinding one action to a combination already used by another must fail with "Already used by …". The lookup must not bypass `conflictingAction` at `ipc.ts:1130`.

- [ ] **Step 4: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/main/ipc.ts
git commit -m "Give each hotkey action its own rebind callback"
```

---

### Task 6: Register the recording finished by a buffer stop

The panel's Stop button calls `setReplayBufferActive(false)`. That path pauses the buffer, which runs `destroyRunningChain`, which finishes any continuous recording and parks the path in `finishedOnTeardown` (`src/main/replay-buffer.ts:621`). But only `toggleReplayForUser` (`src/main/index.ts:436-452`) ever calls `takeFinishedOnTeardown()` — and the panel never calls that channel, it is dead UI-wise.

So the finished clip is written to disk, never moved into its source folder, never given `recordedAt`/`source`/`audioTracks` metadata, and never pushed to the renderer. It surfaces only on a later full rescan, with its timestamp reverse-derived from the filename.

**Files:**
- Modify: `src/main/ipc.ts:251-275` (the `setReplayBufferActive` handler)

**Interfaces:**
- Consumes: `buffer.takeFinishedOnTeardown()` (`src/main/replay-buffer.ts:600`, returns `string | null`), `moveIntoSourceFolder` (`src/main/clip-manager.ts`), `setClipMeta`, `obsCore().audioTrackLabels()`.
- Produces: the same registration `index.ts:436-452` performs, now reachable from the panel.

- [ ] **Step 1: Extract the registration sequence**

The block at `src/main/index.ts:436-452` is the correct sequence and is already written: take the finished path, `moveIntoSourceFolder` it under `capture.getCurrentSourceName()`, `setClipMeta` with `recordedAt`, `source` and `audioTracks`, push `clip-saved` to the main window, and log.

`index.ts` reaches `moveIntoSourceFolder` through a local `require` at `:440`. `ipc.ts` should not duplicate that block. Extract it into one exported function that both call sites use — put it in `src/main/clip-manager.ts`, which already owns `moveIntoSourceFolder` and the metadata conventions.

- [ ] **Step 2: Call it from the panel's stop path**

In the `setReplayBufferActive` handler's `else` branch (where `want` is false), after `await replay().pauseReplayBuffer()` resolves, call the extracted function and send `clip-saved` with the registered path.

Ordering matters: `takeFinishedOnTeardown()` is only populated after the pause settles, so it must be read after the await, not before.

- [ ] **Step 3: Verify the clip appears immediately**

Start a continuous recording, let it run ~10 seconds, press the panel's Stop. Confirm within one refresh that the clip appears in the library **with its correct timestamp and source**, not after a rescan.

This is Review Focus #5. "Eventually appears" is the bug: the old path only ever surfaced the clip on a later rescan, with its timestamp reverse-derived from the filename.

Then confirm the recording actually stopped rather than being discarded: the file must be playable and roughly the length recorded.

- [ ] **Step 4: Verify the no-recording case is unchanged**

Stop the buffer with no continuous recording running. `takeFinishedOnTeardown()` returns `null` and nothing is registered. Confirm no spurious library entry appears.

- [ ] **Step 5: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/main/ipc.ts src/main/index.ts src/main/clip-manager.ts
git commit -m "Register the recording a buffer stop finishes"
```

---

### Task 7: Fix `addAudioDeviceChannel`

`addChannel` (`src/main/audio.ts:637-653`) writes the new device to `settings.json`, then calls `this.createChannel(id, stored[id])` — reading the **pre-write** object it snapshotted at line 638. `stored[id]` is `undefined`, so `createChannel` dereferences `cfg.kind` at `:683` and throws.

The channel is already persisted, so the device appears in Settings with an inert volume slider until the next launch. `removeChannel` (`:655-664`) gets the same shape right: it reads `cfg` from `stored` *before* deleting.

**Files:**
- Modify: `src/main/audio.ts:637-653`

**Interfaces:**
- Consumes: `DEFAULT_SOUND`, `listDevices`, `createChannel(id: string, cfg: { label: string; kind: DeviceKind })`.
- Produces: `addChannel` returns normally; the channel is live in the same session it was added.

- [ ] **Step 1: Capture the config before writing**

Build the config object once, use it for both the persisted write and `createChannel`. `removeChannel`'s ordering is the model to follow.

- [ ] **Step 2: Verify the device is live immediately**

Settings → Audio → Output source → add an extra device. Confirm no error toast, and confirm the new lane's volume fader actually changes level (move it and hear/observe the change).

The original bug's signature is *the control appears and then does nothing* — a device that shows up with a dead fader. Verifying that the fader is live, not merely that no error appeared, is what distinguishes the fix.

- [ ] **Step 3: Verify removal still works**

Remove the device. Confirm the lane disappears, the entry leaves `settings.json`, and no error appears. The extraction must not disturb the working path.

- [ ] **Step 4: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/main/audio.ts
git commit -m "Pass the written config when adding an audio device channel"
```

---

### Task 8: Deliver the notification message and fix the error subtitle

Two defects in one popup. Main builds `?notification=<type>&message=<encoded>` (`src/main/notification.ts:132`) and passes real diagnostics — "Recording not ready", "Recording stopped responding", "Failed to save clip". The renderer reads only `notification` (`src/renderer/lib/hooks.ts:58`), discarding `message`. Separately, `NotificationOverlay.tsx:73` hardcodes "Saved to your replays folder" for every type except `screenshot`, so an error popup reads **"Something went wrong / Saved to your replays folder."**

**Files:**
- Modify: `src/renderer/lib/hooks.ts:53-65` (`usePopupWindow`)
- Modify: `src/renderer/pages/NotificationOverlay.tsx:10-17` (CONTENT table) and `:70-75` (subtitle)
- Modify: `src/renderer/components/home` callers if the type signature changes — check `App.tsx:30`

**Interfaces:**
- Consumes: the `message` query parameter already produced by `src/main/notification.ts:132`.
- Produces: `usePopupWindow(): { type: string; message: string | null; onClick: () => void } | null`, and a `NotificationOverlay` that renders the message when present and a type-appropriate subtitle when not.

- [ ] **Step 1: Read the message through**

Extend the returned state in `usePopupWindow` with `message: string | null` from `params.get('message')`. Note that `usePopupWindow` resolves in a `useEffect`, unlike `useEditorClipPath` which uses `useMemoOnce` — see Step 4.

- [ ] **Step 2: Render it**

In `NotificationOverlay`, prefer `message` for the subtitle when present. When absent, give each `BufferStatus` kind its own fallback in the `CONTENT` table rather than branching on `type === 'screenshot'` at the call site. The `error` kind must not say anything about saving.

- [ ] **Step 3: Verify an error popup**

Trigger a real failure — stop the buffer with OBS not initialised, or save a clip with the output path unset. Confirm the popup shows the actual diagnostic text and does not mention the replays folder.

Also confirm a normal save still reads correctly, since that path has no `message` and relies on the fallback.

- [ ] **Step 4: Confirm the popup does not flash the main panel**

`App.tsx:23-24` states the popup must resolve before the panel mounts, and `useEditorClipPath` satisfies that with `useMemoOnce`. `usePopupWindow` uses `useState` + `useEffect`, so `Surface` returns `RoutedPanel` on the first render and `HomePage` mounts — firing six queries — for one frame in a 280×110 transparent window.

Fix with the same `useMemoOnce` pattern the editor hook already uses at `hooks.ts:68-73`.

Verify by triggering several popups in a row and watching for any flash of clip-list content.

- [ ] **Step 5: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/renderer/lib/hooks.ts src/renderer/pages/NotificationOverlay.tsx
git commit -m "Show the real notification message and stop mislabelling errors"
```

---

### Task 9: Repair the mojibake and make the audit catch it

Three user-visible strings are UTF-8 double-encoded. `{sourceName || 'â€”'}` renders as `â€”`; `'Starting engineâ€¦'` and `Saving clipâ€¦` do the same. The bytes are U+00E2 U+20AC U+201D — a real em-dash and ellipsis encoded as Windows-1252 and then read as UTF-8.

`scripts/utf8-audit.mjs` reports zero invalid files, correctly: these files *are* valid UTF-8. The corruption was baked in at write time. The audit's job is to catch this class too.

**Files:**
- Modify: `src/renderer/components/capture.tsx:139`
- Modify: `src/renderer/pages/Home.tsx:225,232`
- Modify: `scripts/utf8-audit.mjs`

**Interfaces:**
- Produces: `npm run` audit step that fails on mojibake, not only on invalid UTF-8.

- [ ] **Step 1: Make the audit catch mojibake**

Extend `scripts/utf8-audit.mjs` to also flag the specific sequences this corruption produces: U+00E2 followed by U+20AC or U+0080, and U+00C3 followed by U+0080–U+00BF (the Latin-1/UTF-8 double-encode family). Report the same way it reports invalid UTF-8 — file, line number, and what it actually found.

The script's own detection regex at line 20 contains mojibake literals. That is correct and must stay: a detector for this class has to contain the bytes it detects. Exclude `scripts/utf8-audit.mjs` from its own scan, or the audit fails on itself permanently.

- [ ] **Step 2: Confirm it fails before the fix**

Run: `node scripts\utf8-audit.mjs`
Expected: at least 6 findings across `capture.tsx` and `Home.tsx`.

- [ ] **Step 3: Fix the strings**

Replace with real `—` (U+2014) and `…` (U+2026). Check for the same corruption in comments at `capture.tsx:20,150` and `Home.tsx:27` and fix those too — they are the same bytes and will otherwise seed the next regression.

- [ ] **Step 4: Confirm it passes**

Run: `node scripts\utf8-audit.mjs`
Expected: `0 file(s)` for invalid UTF-8 and zero mojibake findings.

- [ ] **Step 5: Verify in the running app**

Open Settings and check the source-name placeholder and the status strip read as real punctuation. The em-dash placeholder appears whenever no source name is resolved, so it is reachable in normal use.

- [ ] **Step 6: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/renderer/components/capture.tsx src/renderer/pages/Home.tsx scripts/utf8-audit.mjs
git commit -m "Repair double-encoded strings and teach the audit to catch them"
```

---

### Task 10: Four deep fixes

Four defects that are one layer below the user-visible surface. Each is small, local, and independently verifiable.

**Files:**
- Modify: `src/main/editor.ts:213-246` (double ffmpeg spawn)
- Modify: `src/main/ipc.ts:131-143` (`withStatus`)
- Modify: `src/main/ipc.ts` (five `shell.openPath` call sites — grep for them)
- Modify: `src/main/editor.ts:508` (window background colour)

**Interfaces:**
- Produces: one ffmpeg process per audio track peak; `withStatus` that reports the real outcome; `openPath` failures surfaced; editor window matching the canvas token.

- [ ] **Step 1: Delete the duplicate ffmpeg spawn**

`getTrackPeaks` (`src/main/editor.ts:213-246`) calls `runFfmpeg([...])` at `:222` and discards it with `void child` at `:245`. That process has output options before `-i`, is never added to `runningFfmpeg`, is never killed by `killRunningFfmpeg()`, and its rejection is unhandled.

Keep the `spawn` at `:227`. Delete the `runFfmpeg` call and the `void child` line, and drop the import if it becomes unused.

Verify: open a clip with 3 audio tracks and confirm exactly 3 ffmpeg processes exist while it loads, not 6.

- [ ] **Step 2: Make `withStatus` honest**

Its `finally` (`ipc.ts:138-142`) unconditionally broadcasts `OBS_STATUS_MESSAGES.ready`, even when the wrapped function threw — so the panel reports a live buffer after the engine died. Only set and broadcast `ready` when the function resolved. On failure, leave the status to the caller's error path.

`src/main/index.ts:319` already does this correctly; match it rather than inventing a third pattern.

Verify: force a settings change to fail (set the output path to an unwritable folder) and confirm the panel does not claim success.

- [ ] **Step 3: Check `shell.openPath` return values**

`shell.openPath` resolves with an error **string** on failure. Five handlers discard it, so "Open folder", "Open clip", "Open screenshot" and friends report success when nothing opened. Compare `openAppFolder` at `ipc.ts:487`, which already checks.

Grep for every call site and handle the string. Verify by clearing `outputPath` and pressing Open folder — it must report a failure rather than silently doing nothing.

- [ ] **Step 4: Match the editor window background**

`src/main/editor.ts:508` hardcodes `backgroundColor: '#0a0a0a'`. The canvas token is `oklch(17% 0.006 285)` (`src/renderer/index.css:24`), which is roughly `#191a1d`. The mismatch flashes on open and on resize.

Compute the hex from the token rather than hardcoding a second value. Verify by opening and resizing the editor and watching for a colour jump.

- [ ] **Step 5: Standard gate, full regression, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
node scripts\verify:channels
npm run test:ui
git add src/main/editor.ts src/main/ipc.ts
git commit -m "Fix the duplicate ffmpeg spawn and three silent-failure paths"
```

---

### Task 11: Remove both audio toggles and gate the microphone track

Split tracks become unconditional; `perDeviceAudioTracks` is deleted outright along with the untested code path behind it. The microphone track is included only when a microphone is actually capturable.

**Files:**
- Modify: `src/shared/types.ts:48-49` (remove both keys from `PersistedSettings`)
- Modify: `src/shared/constants.ts:33-34` (remove from `DEFAULT_SETTINGS`)
- Modify: `src/shared/ipc.ts:88-91` (remove four channels)
- Modify: `src/preload/index.ts` (remove four bridge entries)
- Modify: `src/renderer/lib/api.ts:140-143` (remove four declarations)
- Modify: `src/renderer/lib/queries.ts:74-83` (remove two `SETTINGS` bindings)
- Modify: `src/renderer/components/settings.tsx:308-342` (remove the two `SettingSwitchRow`s and the `separate` query)
- Modify: `src/main/obs-core.ts:408-434, 715-722, 782-811` (`applyAudioTracks`, `audioTrackMask`, `audioTrackLabels`, `setSourceTrack`, `computeMixerMask`, `buildTrackLabels`, `sourceTrackMask`)
- Modify: `src/main/audio.ts:583, 745-749` (`separate` read, `deviceTrack`)
- Modify: `src/main/ipc.ts:855-950` (remove the four handlers and the `applyTrackFlags` helper)
- Modify: `scripts/audiotracktest.js` (stop forcing a flag that no longer exists)

**Interfaces:**
- Consumes: `deviceAvailable(obs, id, kind)` (`src/main/audio.ts:155`), `getSetting('micDeviceId')`.
- Produces: `computeMixerMask(hasMicrophone: boolean, deviceTracks: number[]): number` — no `separate` parameter. `audioTrackMask()` returns mix + desktop + optional mic + device tracks.

- [ ] **Step 1: Change the mask signature**

In `src/main/obs-core.ts:788`, replace `computeMixerMask(separate: boolean, deviceTracks: number[])` with `computeMixerMask(hasMicrophone: boolean, deviceTracks: number[])`:

- always OR in bit 0 (mix) and bit 1 (desktop)
- OR in bit 2 (mic) **only when `hasMicrophone` is true**
- always OR in the device tracks

Drop the `separate` parameter from `buildTrackLabels` (`:796`) and `sourceTrackMask` (`:782`) on the same basis. `buildTrackLabels` must emit a `Microphone` label only when the mic track is present, or the editor will show a lane label for a track that does not exist.

- [ ] **Step 2: Compute `hasMicrophone`**

In `audioTrackMask()` (`obs-core.ts:426`), derive it from `deviceAvailable(this.obs, getSetting('micDeviceId'), 'microphone')`.

**The condition is device presence, not configuration.** "Is a microphone configured" is always true — `setupAudioSources` always creates the source (`:357`) and the picker offers only "Windows Default" plus real devices with no "None" entry (`settings.tsx:398-401`). Device presence via `deviceAvailable` is a condition that can actually be false.

**Do not include mute or volume in this condition.** The mask is only recomputed in `applyAudioTracks`, and a stale mask triggers `rebuildAndRestart` (`replay-buffer.ts:1038`). Gating on mute would empty the rolling buffer on every mute toggle, costing up to 8 seconds. This is Review Focus #4.

- [ ] **Step 3: Remove the settings and channels**

Delete both keys from the schema and defaults; delete the four IPC channels, their preload entries, their API declarations and `SETTINGS` bindings; delete the two `SettingSwitchRow`s and the `separate` query in `AudioSection`.

Delete `applyTrackFlags` and the four handlers at `ipc.ts:932-950` — they exist only to serve the toggles.

- [ ] **Step 4: Collapse `deviceTrack`**

`audio.ts:745-749` becomes `TRACK.DEVICE_BASE` unconditionally, and the `perDeviceAudioTracks` read at `:746` goes. Extra devices sharing one track is exactly the old off-state, so behaviour is preserved while the untested path is deleted.

- [ ] **Step 5: Verify migration for existing users**

Write `separateAudioTracks: false` into a `settings.json`, launch, and confirm the recording still has 3 streams. `JsonStore.get` falls back to defaults, so the removed key resolves rather than being read as a live `false`.

This is Review Focus #2 and is the single most likely way this task breaks someone's setup.

- [ ] **Step 6: Verify the gate in both directions**

With `scripts/audiotracktest.js` updated to stop forcing the removed flag:

- microphone present → expect **3** audio streams
- microphone bound to a non-existent device id → expect **2**

The second case is the only way to prove the gate is not dead code. Confirm it by pointing `micDeviceId` at an id that does not resolve, then check the stream count with `ffprobe`.

**Review Focus #1** is the same condition reached from the user's side: record a clip with the microphone working, confirm 3 streams; then make that microphone unavailable and record again, confirming the **new** clip has 2. The first clip keeps its 3 — clips are immutable, and the editor reads their labels from metadata.

Update the harness's own save/restore logic (`index.ts:786-799, 893-896`) which currently reads and writes `separateAudioTracks` — those lines will not compile otherwise.

- [ ] **Step 7: Confirm mute stays live**

Mute the microphone while the buffer is rolling. The fader must respond immediately and the buffer must **not** restart. This is Review Focus #4 and it is the reason the gate is narrow.

- [ ] **Step 8: Verify existing clips still open**

Open a clip recorded before this change. Its lanes must be unchanged, because the editor reads labels from per-clip metadata (`clip-meta.ts`) rather than live settings.

- [ ] **Step 9: Standard gate, full regression, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
node scripts\verify:channels
npm run test:ui
git add src/shared/types.ts src/shared/constants.ts src/shared/ipc.ts src/preload/index.ts src/renderer/lib/api.ts src/renderer/lib/queries.ts src/renderer/components/settings.tsx src/main/obs-core.ts src/main/audio.ts src/main/ipc.ts src/main/index.ts scripts/audiotracktest.js
git commit -m "Always record split audio tracks and drop both track toggles"
```

---

### Task 12: Show the buffer's memory cost

Because `usesStream = true` zeroes OBS's `max_size_mb`, the replay buffer has no byte ceiling — it is bounded by time only. A 5-minute buffer at highest quality is roughly 725 MB of live heap in a separate `obs64.exe` process that the UI cannot observe.

The buffer is **already** RAM-resident; OBS holds encoded packets in a heap deque and touches disk only at `save()`. This task makes that footprint visible.

**Files:**
- Modify: `src/main/replay-buffer.ts:358-360` (correct the wrong comment)
- Modify: `src/shared/constants.ts` (add `AUDIO_BITRATE_ESTIMATE_KBPS`)
- Modify: `src/shared/types.ts` (add `memoryWarnMb: number`)
- Create: `src/shared/buffer-memory.ts`
- Modify: `src/renderer/components/settings.tsx` (readout inside `QualitySection`)

**Interfaces:**
- Consumes: `VBR_KBPS_BY_QUALITY` (`src/shared/constants.ts:99`), `visualQuality`, `bufferDuration`, `fps`, `outputResolution`.
- Produces: `estimateBufferMemoryMb(opts: { videoKbps: number; durationSeconds: number }): number` from `src/shared/buffer-memory.ts`, and a persisted `memoryWarnMb: number` defaulting to **512**.

- [ ] **Step 1: Correct the comment**

`replay-buffer.ts:358-360` claims `usesStream` "makes the replay buffer roll instead of writing continuously". It does not. Rolling comes from OBS's `replay_buffer` output type. `usesStream` selects which encoder object is borrowed and zeroes `max_size_mb`.

State both facts in the comment, including that zeroing the byte cap is why the buffer is time-bounded only. Anyone reading this file next needs to know that.

- [ ] **Step 2: Write the estimator**

`src/shared/buffer-memory.ts` exports `estimateBufferMemoryMb({ videoKbps, durationSeconds }): number`, returning `(videoKbps + audioKbps) * 1000 / 8 / 1024 / 1024 * durationSeconds`.

Audio is fixed at `AUDIO_BITRATE_ESTIMATE_KBPS = 259` in constants, which is the measured three-track total from this machine's clips. Video comes from `VBR_KBPS_BY_QUALITY[visualQuality]`.

Keep this pure and in `shared/` so it is computable without OBS — that is what makes it testable at all.

- [ ] **Step 3: Check the estimate against measurements**

Against real clips at ~1,450 kbps video, the estimator must return **12 MB** at 60 s and **61 MB** at 300 s. At highest quality (20,000 kbps) it must return 145 MB and 725 MB respectively.

If it does not reproduce those figures, the bitrate source is wrong — check whether hardware encoders actually honour `VBR_KBPS_BY_QUALITY`, because that table was derived for the x264 path.

- [ ] **Step 4: Add the setting and the UI**

Add `memoryWarnMb: number` to `PersistedSettings` and `DEFAULT_SETTINGS`, default **512**.

In `QualitySection`, add a readout showing the estimated buffer RAM for the current duration and quality, labelled as an estimate, updating live as either changes. When it exceeds `memoryWarnMb`, show the warning. Let the user edit the threshold.

The readout must say it is an estimate. Presenting a derived number as a measurement is the same class of error as a screenshot showing a plausible number.

- [ ] **Step 5: Verify the warning actually fires**

Set the buffer to 5 minutes and quality to highest. The estimate must exceed 512 MB and the warning must appear. Then confirm 60 s at default quality does **not** warn.

Both directions matter: a warning that never fires is as useless as one that always does.

- [ ] **Step 6: Standard gate, then commit**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
git add src/shared/buffer-memory.ts src/shared/constants.ts src/shared/types.ts src/main/replay-buffer.ts src/renderer/components/settings.tsx
git commit -m "Show the replay buffer's memory cost and correct the usesStream comment"
```

---

### Task 13: Release 1.1.0

Packaging, documentation and version. Three sub-items, each with its own verification.

**Files:**
- Modify: `electron-builder.yml` (extraResources filter — CEF strip)
- Modify: `package.json` (version 1.1.0)
- Modify: `README.md`
- Modify: `ISSUES.md`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces: a published 1.1.0 with a `.blockmap`, a smaller installer if the CEF strip proves safe, and documentation matching the app.

- [ ] **Step 1: Fix the blockmap**

The 1.0.1 release carries `latest.yml` and the setup `.exe` but no `.blockmap`, so every update is a full ~210 MB fetch. The blockmap **is** produced by the local build — `release/Rewind-1.0.1-setup.exe.blockmap` exists.

The `--prepackaged` invocation in `npm run release` does not upload it. Find out why by reading electron-builder's publish behaviour for `--prepackaged`, then correct the script.

**Do not trust the build output as evidence.** The check is the published release's asset list:

```powershell
(Invoke-RestMethod https://api.github.com/repos/bulhaa1/Rewind/releases/tags/1.1.0).assets | Select-Object name
```
Expected: `latest.yml`, `Rewind-1.1.0-setup.exe`, **and** `Rewind-1.1.0-setup.exe.blockmap`.

- [ ] **Step 2: Strip CEF, then prove it**

Add a filter to `extraResources` in `electron-builder.yml` excluding the CEF set: `libcef.dll`, `icudtl.dat`, `resources.pak`, `chrome_elf.dll`, `v8_context_snapshot.bin`, `snapshot_blob.bin`, `libEGL.dll`, `libGLESv2.dll`, `chrome_*.pak`, `obs-browser.dll`, `obs-browser-page.exe`. Roughly **223 MB, 35.5%** of the package.

Before shipping, verify against the **packaged** build, not the dev build:

```bash
npm run package
```
then run the packaged exe and complete a full **record → save → edit** cycle. Then read `main.log` and confirm no plugin-load failure for `obs-browser`.

**Revert the strip if any of that fails.** `obs-browser` failing to load is expected and harmless; OBS logs it and continues. What is *not* acceptable is any failure to start, an encoder that falls back to x264, or a capture source that stops working. Report the measured installer size either way.

Verified safe to attempt: `obs_studio_client.node` and `obs.dll` have no `libcef.dll` in their PE import tables. Only `obs-browser.dll` links it.

- [ ] **Step 3: Fix the documentation**

README corrections, each verified against the code:

- The hotkey table documents an `Alt+1` panel-toggle hotkey that **does not exist**. Real bindings: `Alt+1` save replay, `Alt+2` screenshot, `Alt+3` start/stop recording (from `DEFAULT_SETTINGS`, `constants.ts:35-37`).
- Separate audio tracks are listed as unverified. They were verified on 2026-10-11.
- Document microphone input gain, master clip volume, and draggable trim selection — all shipped undocumented.
- Fix "purposly" → "purposefully" and "there favorite" → "their favorite".
- Note that the replay buffer is RAM-resident, and that its memory scales with buffer duration and quality.

- [ ] **Step 4: Update ISSUES.md**

Move the fixed items out of **Open**, **Fixed, unverified**, and **Untested** into the verified table with their commits. Record what this release deliberately did **not** fix, so it is not re-investigated: `saveReplayBuffer` re-entrancy, missing ffmpeg timeouts, `setWindow` not stopping the game detector, the infinite spinner on a rejected `captureStateQuery`, the unreachable `saving` status, and the unhandled `rewind://` protocol.

- [ ] **Step 5: Bump the version and tag**

`package.json` version → `1.1.0`.

- [ ] **Step 6: Full gate before publishing**

```bash
npm run typecheck
npm run build
node scripts\utf8-audit.mjs
node scripts\verify:channels
npm run test:ui
npm run selftest
```

Every one must pass. `verify:channels` exiting non-zero means a handler is missing — that check exists because this release was built around one.

- [ ] **Step 7: Publish and verify**

```bash
npm run release
```

Then confirm on the published release: the `.blockmap` is present (Step 1), and the release notes describe the change rather than saying "bugfixes."

- [ ] **Step 8: Verify the update path end to end**

From the **1.0.1** install, press **Check for updates**, confirm 1.1.0 is offered, download, install, and confirm the app comes back up with settings intact — in particular `separateAudioTracks` absent and audio tracks still split.

That last check is the whole of Task 11 seen from a user's side.

- [ ] **Step 9: Commit and push**

```bash
git add -A
git commit -m "Release 1.1.0"
git push origin main
git tag 1.1.0
git push origin 1.1.0
```

---

## After All Tasks

- [ ] Confirm `npm run verify:channels` is wired into CI and green.
- [ ] Confirm the README's Preview screenshots still match the UI (Task 11 removes two Settings rows; Task 12 adds one).
- [ ] Push the branch and open a PR if the branch is `main`.