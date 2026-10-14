# Rewind 1.3.1

Hotfix. In the 1.3.0 installer, every clip and recording came out **black** — a flat
black frame with working audio. It affected both replay clips and continuous
recordings, in Game Capture and Display mode alike, and it is fixed here.

---

## Black clips, fixed

**What happened.** Monitor capture was using DXGI desktop duplication, which hands
back no frames at all when the capture process is not per-monitor DPI aware. The
packaged engine process ended up only *system* DPI aware, so the scene it rendered
had nothing in it: the engine log looked healthy (source created, frames drawn,
encoder started, file written) and the file itself was a uniform black frame.

Worth knowing if you hit it: the app's own **Screenshot** was still correct
throughout, because it captures through ffmpeg rather than the engine. A black clip
next to a correct screenshot was the tell.

**The fix.** Monitor capture now uses **Windows Graphics Capture** — the same method
the window source already used — which does not depend on DPI awareness at all. It is
the recommended capture path on Windows 11, and it also handles HDR and
multi-plane-overlay content better than duplication did. Nothing else about capture
changed: same resolution, same cursor, same profiles.

Anyone on 1.3.0 should update; clips recorded with 1.3.0 cannot be recovered.

## Also in this build

- **The Record row fades out while the buffer is off.** Continuous recording runs on
  the buffer's replay chain, so with the buffer stopped there is nothing to record —
  the row is now visibly unavailable instead of failing when clicked.
- **The "Auto detect launched game" card is gone** from Settings → Capture Source.
  Picking **Game Capture** already means auto-detect, so the card only duplicated the
  mode button. Pinning a specific window is unchanged.

---

No other behaviour changed. The app still makes no network request unless you click
**Check for updates**, and this release is unsigned, so Windows SmartScreen warns on
first run.
