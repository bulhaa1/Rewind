# Rewind 1.3.0

The clip editor became a real editor, compression moved onto the GPU, and a
full-repository audit fixed twenty defects — including two that could leave a button
stuck and one that could hang the library on an unreachable drive.

Everything below since the last public release, **1.1.0**. The 1.2.0 line was
developed and folded into this one.

---

## The editor

- **Trim, properly.** Draggable in/out handles on the trim bar, and the mouse wheel
  over the bar scrubs the playhead. The first wheel notch lands immediately and the
  rest coalesce per frame, so scrubbing is responsive without flooding the player.
- **A waveform for every audio lane**, plus a combined clip-volume lane, drawn from
  real peaks decoded in the main process — not a fake bar graph.
- **Per-track volume with live monitoring.** Each lane's fader is heard as you move
  it, through the renderer's own gain graph, so you mix by ear instead of guessing.
- **A fader at zero is the mute.** The separate clip-mute control is gone; the mic
  icon in the panel reports effective silence honestly, including at zero volume.
- **Save a copy / Replace original.** The two footer buttons now say what they do
  (they were "Save as Copy" / "Overwrite"), and each carries a tooltip naming the
  target file.
- **The clip's own size is in the editor header**, next to the file name.
- **Copy clip** from the rail's card menu puts the file on the Windows clipboard, so
  it can be pasted directly into a chat.

## Compress (was "Export")

- **One box, one button.** GIF export is gone entirely. There is one **Compress**
  box with an **On/Off** toggle, **Low / Medium / High** quality, and a single
  **Compress to new file** button.
- **Quality is a fraction of the clip's own bitrate** — 40% / 65% / 90% — so a
  compressed copy can never come out larger than the source. That was a real bug
  before: the old fixed bits-per-pixel model let "High" exceed the original on an
  efficiently-encoded recording.
- **Encoded on the GPU.** At the first compress Rewind probes the bundled ffmpeg for
  a usable hardware encoder — NVENC, then AMF, then QSV — and uses it in a single
  VBR pass; libx264 with a two-pass ABR remains as the CPU fallback. Measured on an
  RTX 5080: a 58-second 1440p120 clip compresses in ~28 seconds, where the CPU
  two-pass path took minutes.
- **Settings → Encoder → Compression Threads** (Auto / 2–12) caps the CPU fallback,
  decoder included, for machines that need the cores for the game.
- **Output always keeps the source resolution**, and copies land in
  `Rewind/Compressed/` — shown in the library as its own source, so a compressed copy
  is never confused with the original.
- **The readout is the truth**: `≈ X MB · Y% smaller`, computed from the same
  arithmetic the encoder is given, against the original file's size.
- **Nothing partial survives.** A failed or cancelled compress deletes its output.

## Profiles

- **Profiles are user-defined**: add, duplicate, remove, and save the current live
  settings into the active profile. Up to four, with column headers.
- The profile-cycle hotkey is **removed**. Profiles switch from the panel's numbered
  buttons or from Settings → Profiles.
- **Switching a profile writes into the live engine**, not just the settings file,
  and costs only the cheapest rebuild the change needs: a length change restarts the
  chain, a quality change rebuilds it, a frame-rate change takes the engine down and
  back up. A paused buffer stays paused, and a recording in flight is finished and
  registered rather than dropped.
- A failed switch puts the stored profile back.

## The panel

- **The clip rail scrolls** with a visible thin scrollbar, and its lists are
  memoized so a big library does not re-sort on every interaction.
- **Storage** is the new name for the old Replay settings section, and it owns the
  Data doors (open the clip folder, the log folder, the exclusion list).
- **Discord and GitHub buttons** in the titlebar.
- The unreliable hover-scrub preview on the rail is gone.

## Capture and engine

- **A display resolution change no longer needs a restart.** Rewind stops the replay
  chain, resets the video context, re-fits the source and restarts — verified in both
  directions at 1080p and 4K, with the buffer live. (OBS refuses a video reset while
  an output holds the context; the old code asked anyway and silently kept the old
  canvas, which is what produced black or half-screen clips.)
- **Startup is quicker.** Stopping a buffer that had never run no longer waits out the
  stop-signal timeout before capture can start.
- **Smaller and quieter**: the audio service was folded into the main process, the
  panel stops working while hidden, and the packaged engine no longer ships modules
  Rewind never loads (the browser engine, unused plugins, debug symbols). The
  installer is **107 MB**, down from 189 MB in 1.1.0.

## Updating

- **Silent installs**: the installer no longer shows a wizard. Press **Restart and
  install** and the app comes back on the new version by itself.
- **The updater cache is pruned on start**, so a completed update does not leave a
  ~379 MB copy of the installer behind.
- Still privacy-first: no background check, no unasked download, and quitting never
  installs anything. The only network request Rewind makes is the one you press
  **Check for updates** to start.

## Fixes from the 1.3.0 audit

Twenty findings from a full-repository audit, all fixed:

1. Two saves at once (the save hotkey plus a quick clip, or a double press) made the
   first one time out and report a clip as unsaved — and triggered a needless OBS
   restart, because a save timeout is also the "wedged encoder" signature. Saves now
   coalesce.
2. Save and Screenshot could stay stuck busy forever if another action was in flight
   when they were pressed.
3. `ffmpeg -i` had no timeout, so a library on a disconnected network or external
   drive hung the scan for the life of the session. Now 15 seconds.
4. Joining a single-segment recording used a synchronous file copy, freezing the app
   for the length of a multi-hundred-megabyte copy. Now async.
5. Clip metadata was matched case-sensitively, so renaming a clip after the library
   root was re-spelled silently dropped its source and audio tracks; deleting left an
   orphan record that grew forever.
6. A library with no cached durations probed every clip one at a time — minutes of
   nothing after moving machines. Probes now run four at a time.
7. A packaged build honoured the dev-server environment variable, so a launch with it
   set would load remote content with the app's IPC bridge attached. Now dev-only.
8. One per-app volume tweak switched the audio mixer into custom mode permanently, and
   with no app session running that meant **no desktop audio at all** in every clip.
   The whole-desktop loopback is now a fallback whenever no app source is live.
9. A wedge recovery whose OBS reinit also failed skipped its own relaunch, leaving the
   app open with a dead buffer.
10. ffmpeg's entire output was kept in memory and shipped to the UI inside the error
    string — a damaged clip could produce hundreds of kilobytes of it.
11. The per-app audio cap counted 16 apps while OBS has 13 slots, so apps 14–16 were
    dropped with no log and no error.
12. A second quit (a repeated Ctrl+C, an installer handing over) skipped the shutdown
    wait and force-killed obs64 mid-stitch, losing the recording the first quit was
    protecting.
13. The panel was positioned from the work area's size but not its origin, so with the
    taskbar on the left or top it sat partly underneath it.
14. At zero volume the mic button said "Raise microphone volume" and then muted the
    microphone.
15. The rail re-sorted both full clip and screenshot lists on every render.
16. "Default microphone" counted as available on a machine with no input device.
17. The mic gain dB conversion had no assertion anywhere — probes checked the stored
    value and the multiplier, never the decibels. Now asserted.
18. A failed OBS audio-source setup left the source bound to its slot with no handle
    to release it.
19. Roughly 60 lines of dead code (unused helpers, a duplicate destroy function, an
    always-empty parameter, an uncalled method, dead re-exports).
20. Two duplicated doc comments, one of which gave the opposite of the correct ffmpeg
    argument order.

## Known limitations

- **Unsigned.** SmartScreen warns on first run and on every update; a code-signing
  certificate is the fix and cannot be solved in this repository.
- **NVIDIA is the only vendor actually tested.** AMF and QSV are detected and wired,
  but no AMD or Intel machine has run this build.
- **Share links do not exist**, by design — that feature means someone else's server.
- Open items, with evidence, are listed in
  [ISSUES.md](https://github.com/bulhaa1/Rewind/blob/main/ISSUES.md).

---

**Windows x64.** Per-user install, no admin, no account. GPL-2.0-or-later.
