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

## Klip 2.0.1 vs Rewind 1.1.0 — measured baseline (2026-10-13/14)

Both apps running, both buffering 60 s, 2560x1440 @120 fps, RTX 5080, same machine, same
minute. Rewind: AV1 NVENC CQP23 p3, 3 audio tracks, 6 processes. Klip: H.264 NVENC CBR at a
fitted 18 682 kbps (p7/fullres), 1 audio track, 1 process, 192 MiB replay budget
(`%LOCALAPPDATA%\Klip\settings.ini`: `rolling_buffer_bytes=201326592`,
`rolling_buffer_seconds=75`, `obs_duration_priority=true`).

| Measure | Klip 2.0.1 | Rewind 1.1.0 |
|---|---|---|
| Install | 65 MB / 703 files | 627 MB / 1695 files |
| obs-studio-node tree | n/a (in-process engine) | 317 MB / 1551 files |
| Processes / threads / handles | 1 / 118 / 1437 | 6 / 222 / ~4300 |
| Private working set | 643 MB (quality preset) | 507 MB = engine 296 + UI 211 |
| Working set | 698 MB | 698 MB (obs64 341 + Electron ~357) |
| CPU, % of one core, 10-min soak | 18.4 | 32.7 (obs64 29.7 + Electron 3.0) |
| 3D engine util | 3.70% | 3.75% (obs64) + 0.19% (Electron GPU) |
| Video-encode engine util | 62.2% | 33.2% |
| Clip bitrate, 6 samples | 18.76 Mbps (fitted) | 8.1 / 23.9 / 32.6 / 38.8 / 45.2 / 47.4 Mbps |
| 60 s buffer payload | ~141 MB | 58–339 MB (typical 230–340) |
| 300 s buffer payload | capped at 192 MiB | 0.3–1.7 GB |
| Growth over 10 min | +4.5 MB | obs64 sawtooth 280–348 MB, UI −2.3 MB |
| Minimized, 60 s | 20.3% (was 22.2) | obs64 31.3% (was 31.6), Electron 2.7% |

Commands, in the order the numbers appear:

```powershell
# install size and file counts
Get-ChildItem 'Z:\Apps\Klip' -Recurse -File | Measure-Object Length -Sum
Get-ChildItem 'Z:\Apps\Rewind' -Recurse -File | Measure-Object Length -Sum

# processes, threads, handles, working set
Get-Process | Where-Object { $_.ProcessName -match 'klip|rewind|obs64' } |
  Select-Object Id, ProcessName, @{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB,1)}},
                @{n='Priv_MB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}},
                @{n='Threads';e={$_.Threads.Count}}, Handles

# private working set (resident private), the fair resident metric
Get-Counter '\Process(*)\Working Set - Private' -MaxSamples 1

# CPU and GPU over a window, per PID
powershell -NoProfile -File scripts/perf-sample.ps1 -Seconds 45 -Pids "<pids>" -Label "both-buffering-60s"

# clip bitrates
node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe -v error -show_entries format=duration,size,bit_rate -of json <clip>

# the 10-minute soak (CSV: one row per 30 s per process)
# output: %TEMP%\rewind-vs-klip-soak.csv
```

Klip's own log states the fitting rule: `Replay duration-first: 18682 kbps video; memory
budget=201326592 bytes (shared by recording)`. Rewind's replay buffer has no byte bound —
obs-studio-node hardcodes `max_size_mb = usesStream ? 0 : 512` in
`obs-studio-server/source/osn-advanced-replay-buffer.cpp` (`IAdvancedReplayBuffer::Start`).

Two caveats that matter for any comparison run:

1. **CPU is content-dependent.** Rewind encodes AV1 CQP, whose bitrate and encoder work track
   the content; DXGI display capture only delivers changed frames. Klip's CBR is near-constant
   work. Two windows in this session gave opposite verdicts (45 s: Klip 26.3% vs Rewind 25.1%;
   10 min: Klip 18.4% vs Rewind 32.7%). Every A/B must hold content and state constant.
2. **RAM depends on each app's current settings.** Klip measured 371 MB private before its
   quality preset and 643 MB after. The settings-independent gaps are install size, process
   count, the module set, and the shape of the cost (flat vs spiky).

Engine floor, for reference (from the section above): ~17.6% of one core @120 fps, 6.6% @60,
3.9% @30, paused with the source removed. Klip's entire app measured 18.4% — i.e. Rewind's
floor plus about one point. The ~12 points of non-floor work are the attack surface:
obs-studio-node polling, AV1 submit at these bitrates, three audio tracks, Electron utilities.
