# Performance testing

How to measure what Rewind costs, and what has been measured so far.

The goal is to attribute cost to a *state* — app closed, buffer paused, buffer
running — instead of guessing. Two tools do the measurement:

- `scripts/perf-sample.ps1` — samples per-process GPU engine utilization (Windows
  "GPU Engine" counters), process CPU, and `nvidia-smi` GPU/encoder numbers over a
  window. Usage:
  `powershell -File scripts/perf-sample.ps1 -Seconds 30 -Pids "123,456" -Label "buffer-on"`
- `scripts/cdp.mjs` + the `probe-*.mjs` drivers — drives the app over DevTools to
  pause/resume the buffer, change settings, and read its own state. The app must be
  running on `--remote-debugging-port=9222`.

## Measured on this machine (2026-10-13, RTX 5080)

2560×1440@120 AV1, NVENC, buffer 60 s. CPU figures are percent of one core.

| State | obs64 CPU | encoder util | notes |
|---|---|---|---|
| Buffer running, display capture | 15.6% | 28.1% | plus the captured app's own hook cost |
| Buffer paused, capture stopped (fixed) | 17.6% @120 fps / 6.6% @60 / **3.9% @30** | 0% | the remainder scales with the video frame rate |
| Game capture, buffer paused (before the fix) | 22.5% | 0% | source and hook stayed live |

Findings that matter:

1. **Pausing did not stop capture.** Only the output chain was destroyed; the
   capture source and game hook stayed live and kept copying frames. Verified from
   the app's own state (`inactive: false`) and by CPU. Fixed: pause now stops the
   detector and removes the source; resume re-installs it.
2. **The video pipeline costs CPU in proportion to the configured frame rate even
   when nothing consumes it.** Measured with the buffer paused and the source
   removed: ~3.9% of one core at 30 fps, ~6.6% at 60, ~17.6% at 120. This is OBS's
   frame loop, not the encoder, and it applies whenever the engine runs.
3. **The NVENC preset control was a no-op.** The app sent the legacy `"hq"` name,
   which the bundled plugin cannot parse, so every selection encoded at P5. Fixed:
   `preset`/`preset2` now carry `p3`/`p4`/`p5`; verified in the OBS-side log.
4. **The frame-rate setting did not reliably apply.** The profile writer only
   rewrote keys that already existed and still logged success; a profile without
   `FPSInt` silently ran at 30. Fixed: the writer ensures every key, and the
   effective rate is read back live. Verified by 120↔30 reinits and by ffprobe on a
   saved clip (`r_frame_rate=120/1`, AV1, 2560×1440).

## Encoder preset impact (measured)

Same setup, encoder utilization averaged over 30 s windows while the buffer ran
(animated content on screen), NVENC AV1 CQP 20 at 2560×1440@120. Two rounds; p3
was measured twice and returned the same number both times:

| preset | encoder util (avg) |
|---|---|
| p3 | 24.9% (repeat: 24.9%) |
| p4 | 27.0% |
| p5 | 27.9% |

So the preset now genuinely changes encoder load — p3 is ~2 points (~8%) cheaper
than p4 and ~3 points cheaper than p5; p4 and p5 differ only marginally. *In-game*
fps impact needs a game run — the encoder is only part of the story and this
machine's GPU has headroom at these settings.

## In-game fps runbook (repeatable)

To measure the fps cost inside a real game, on a machine where the game actually
gets GPU-bound:

1. Launch the game and let Rewind hook it (panel shows the game name, log shows
   `Game capture hooked`).
2. Put an fps/frametime overlay on (RTSS + MSI Afterburner's logging is the
   least-effort option: enable "Log history to file" for the `framerate` and
   `frametime` entries).
3. Fix the game scene — a benchmark mode, a replay, a fixed route; anything that
   takes the same ~60 s twice in a row.
4. Collect baselines in this order, ~60 s each, same spot:
   - Rewind closed
   - Rewind running, buffer paused
   - Rewind running, buffer running — presets p4, p3, p5 (change with
     `PRESET=p3 node scripts/cdp.mjs scripts/probe-encoder-presets.mjs`; each
     change rebuilds the capture chain in a few seconds)
5. Report average fps and 1% lows per step. The deltas between the runs are the
   number to act on; the deltas between presets answer whether p3/p4 matter in
   practice.

Note: changing the preset rebuilds the replay chain and wipes the rolling buffer;
do it between runs, not during one.
