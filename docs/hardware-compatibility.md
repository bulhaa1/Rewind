# Hardware compatibility

What Rewind needs from a machine, what it does when it cannot have it, and how to tell
which case a machine is in. Written against 1.2.0.

Every claim is labelled:

- **measured** — observed on the development machine (RTX 5080, Windows 11, 2560x1440
  and 3840x2160 displays), with the command or log line that produced it.
- **vendor docs** — from NVIDIA, AMD, Intel or Microsoft documentation. Not observed
  here; treat as the expected behaviour, not as a guarantee.
- **needs a machine** — nobody has checked. The first person with that hardware should
  run the checklist at the end.

The point of this document is that a machine which cannot do the fast thing still
records something. Every path below has a fallback, and the app's own log names which
one it took.

---

## 1. Capture paths

One source is live at a time (`src/main/capture.ts`). Which one depends on what is
being captured.

### DXGI desktop duplication — `monitor_capture`, method `automatic` (0)

The default for display capture. Windows hands over frames of the whole monitor.

| Requirement | Detail | Evidence |
|---|---|---|
| OS | Windows 8+ | vendor docs |
| GPU | the adapter driving the captured monitor | vendor docs |
| Result | frames at the monitor's refresh rate | measured: 2560x1440 @ 165 Hz captured at 120 fps with the buffer at 120 |

Known failure classes:

- **HDR.** With Windows HDR (or Auto HDR) on, duplication hands over an HDR surface
  that OBS's SDR path can misread: black or washed-out captures. OBS's own guidance is
  to use WGC or turn HDR off. **needs a machine** — this machine's displays are SDR.
- **Protected content.** DRM-protected playback is black by design. Not a bug.
- **Hybrid graphics.** If the app runs on one GPU and the monitor is driven by another,
  duplication can fail or produce black frames on some laptops. **needs a machine.**
- **Exclusive fullscreen** switches can drop duplication briefly; the buffer restarts
  and continues (measured: resolution changes do exactly this, see ISSUES.md) — but
  exclusive-fullscreen mode switches themselves are **needs a machine**.
  **Locked session / disconnected RDP.** No frames. The buffer keeps running on the
  last frames it had.

### Windows Graphics Capture — `window_capture`, method `WGC` (2)

Used for window capture when the game hook is not available. Microsoft's newer capture
API: no injection, works with more windows, handles HDR better than duplication.

| Requirement | Detail | Evidence |
|---|---|---|
| OS | Windows 10 1803+ | vendor docs |
| Result | the window's client area, cursor included | measured on this machine |

### Game hook — `game_capture`

Injection-based, the anti-cheat-friendly path on Windows 11.

| Requirement | Detail | Evidence |
|---|---|---|
| OS | Windows 11 22H2 (build 20344+) | `hasGameHook()` in `src/main/capture.ts` checks `os.release()`; below that the app uses WGC |
| Game | must allow the hook | vendor docs |

When the hook produces no frame within 5 s (`TIMING.GAME_HOOK_TIMEOUT`), the app falls
back to display capture of the monitor the game is on and stops re-detecting that
process — measured on this machine, logged as
`Game capture hook produced no frame in 5000ms, falling back to Display N`.

Anti-cheat software may block injection entirely. The fallback above is what the user
gets, and it is a working capture, not an error.

---

## 2. Encoder matrix

The app does not assume an encoder exists. At startup it asks OBS's own registry
(`VideoEncoderFactory.types()`), builds a per-vendor codec list, and picks the first
vendor that has anything (`VENDOR_PREFERENCE = nvenc, amf, qsv, x264` in
`src/shared/constants.ts`). The user can override the vendor; an unavailable choice is
refused with `Encoder not supported on this system` rather than failing at start.

| Vendor | H.264 | HEVC | AV1 | Notes |
|---|---|---|---|---|
| NVIDIA NVENC | Kepler (GTX 600/700) and later — vendor docs | Maxwell 2nd gen (GTX 950/960, 10-series) and later — vendor docs | Ada (RTX 40-series) and later — vendor docs | OBS plugin ids `obs_nvenc_h264_tex`, `obs_nvenc_hevc_tex`, `obs_nvenc_av1_tex`. AV1 also needs a recent driver — **needs a machine** to pin the floor |
| AMD AMF | GCN (RX 200/HD 7000) and later — vendor docs | GCN and later — vendor docs | RDNA 3 (RX 7000) and later — vendor docs | ids `h264_texture_amf`, `h265_texture_amf`, `av1_texture_amf` |
| Intel QSV | Sandy Bridge (2nd gen) and later — vendor docs | Skylake (6th gen) and later — vendor docs | Arc / 14th gen and later — vendor docs | The app prefers `obs_qsv11_v2` and falls back to the legacy `obs_qsv11` when the plugin only ships the old id (measured: the fallback exists because both ids are in the wild) |
| x264 | always | — | — | Software. The floor that makes every machine work. |

Behaviour when the chosen pair is missing:

1. **Codec not on the vendor** — the app encodes that profile with H.264 instead
   (`desiredHardwareEncoder` falls back to `h264`), and picking a vendor normalises the
   stored codec so the next start cannot fail (`setVideoEncoder` in `src/main/ipc.ts`).
2. **No hardware encoder at all** — `auto` resolves to x264, which is always present.
3. **Hardware encoder fails at runtime** — after repeated failures the app switches to
   `obs_x264` and logs `Falling back to software encoder (obs_x264)`. Recording
   continues; CPU cost goes up. Measured on this machine by forcing failures.

---

## 3. Quality: what the app actually asks for

One quality tier per profile (`low`, `standard`, `high`, `highest`). The numbers sent to
each vendor family differ because their rate-control vocabularies differ
(`encoderSettings` in `src/main/replay-buffer.ts`):

| Vendor | Rate control | low | standard | high | highest |
|---|---|---|---|---|---|
| NVENC / AMF | CQP | 28 | 23 | 20 | 16 |
| QSV | ICQ | 28 | 23 | 20 | 16 |
| x264 | VBR (kbps) | 4000 | 8000 | 12000 | 20000 |

Extras per family: NVENC gets `preset` p3/p4/p5 (default p4), `multipass`
disabled/qres, `tune hq`; AMF gets `QualityPreset: quality`; QSV gets a target-usage
hint. Keyframe interval is 2 s everywhere, which is what makes a replay buffer's saved
clips seekable.

What "high" means in practice, **measured here**: 2560x1440 at 120 fps, AV1 CQP 20 cost
7.71% of one core in `obs64`; H.264 CQP 20 on the same content cost 10.94%. AV1 is the
cheaper and better-looking choice on Ada. On older hardware the same CQP values buy
less quality per byte, which is expected — the tier names describe the setting, not the
result.

---

## 4. Failure modes by machine class

| Machine | What happens | Confidence |
|---|---|---|
| Intel-only laptop, Haswell or newer | QSV H.264 or HEVC; the iGPU also drives the display, so duplication works | vendor docs |
| Intel-only, pre-Sandy Bridge | no QSV; x264 | vendor docs |
| AMD APU (Vega/RDNA integrated) | AMF or x264 | vendor docs |
| NVIDIA Optimus laptop | NVENC if the app runs on the dGPU, otherwise the iGPU's QSV — which one Windows picks depends on the graphics preference for `Rewind.exe`. **needs a machine** | needs a machine |
| Desktop dGPU | NVENC or AMF, whichever is present | measured on this machine (NVENC) |
| Intel Arc | AV1 via QSV; needs a recent driver | needs a machine |
| Virtual machine / virtual display | duplication works on virtual adapters that support it; game hook never applies. The app sizes its canvas to the primary display, so a virtual display works like any other | the app runs alongside a virtual display here (measured); whether duplication works on any given virtual adapter is vendor docs |
| 4K120 | encodable, but 120 fps costs CPU in proportion to the frame rate even when idle (measured: ~17.6% of one core at 120 fps with no source) — 60 fps is the sane default for 4K | measured |
| 8K | not supported by the encoders at usable frame rates | vendor docs |
| HDR display | see the DXGI HDR note above; the safest setting is WGC window capture or HDR off | needs a machine |
| Multi-GPU desktop | capture follows the adapter driving the monitor; if encoding lands on the other GPU, frames cross the bus | needs a machine |

---

## 5. Checklist for a new machine

Run this on the target, in order. Each step has a result that means something.

1. **Install and start the app.** Then read the log
   (`%APPDATA%\Rewind\logs\main.log` — the dev build uses `%APPDATA%\rewind-desktop`).
2. Find `OBS video encoder types:` — that is OBS's list for this machine.
3. Find `codecs nvenc=[...] amf=[...] qsv=[...]` — that is what the app decided each
   vendor supports. An empty list for a vendor you expected means the driver or the
   plugin is not offering it.
4. Find `Created replay encoder: <id> settings={...}` — the id names the vendor, the
   codec and whether it is a texture path (`_tex`). If it says `obs_x264`, no hardware
   encoder was chosen: check step 3 before calling it a bug.
5. **Start the buffer, play something for 20 seconds, save a clip.**
6. Probe the clip: `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate <file>`
   — the codec should match step 4, and the dimensions should match the display.
7. Watch one minute of the app idle: `scripts/perf-sample.ps1` prints CPU per process.
   A hardware encoder should leave `obs64` under ~20% of one core at 60 fps.
8. **Change the display resolution** and save another clip. It should come out at the
   new size with the source filling the frame (this is the fix verified in ISSUES.md;
   on a machine where it does not, the log pair to look for is
   `Display changed: canvas A -> B` followed by `Capture canvas synced to the display`).
9. **Record with the game hook** if a game is available; the log says either
   `Game capture hooked` or the 5-second fallback line.

Report anything that fails with the log lines from the step that failed.

---

## 6. What this app deliberately does not do

| Not done | What a user sees |
|---|---|
| No HDR tone mapping | HDR displays may capture washed out under DXGI; use WGC or turn HDR off |
| No per-encoder preset beyond NVENC | AMF and QSV run at the app's fixed quality preset; there is no knob for them |
| No capture-method override | DXGI vs WGC is chosen per source type, not by the user |
| No WGC fallback when DXGI is blocked | a display that cannot be duplicated produces black frames, not a WGC retry |
| No 8K, no 120 fps guarantee | the frame rate is a request; the engine drops frames it cannot keep up with |
| No per-game profiles | profiles are global presets, switched by hand or by hotkey |

Each of these is a candidate for the next round; none of them breaks recording on a
machine that supports the basics above.
