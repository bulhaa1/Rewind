# Rewind 1.4.0

The library gets a real folder structure, per-app audio actually works, and there is a
portable build for people who do not want an installer.

---

## Your clips are now organised

```
<your location>\
└── Rewind\
    ├── Recordings\      continuous recordings
    ├── <Game>\          replay clips, one folder per game
    ├── Display Capture\ clips with no game
    ├── Screenshots\     every screenshot
    └── Compressed\      editor exports
```

No video file is left loose in `Rewind\` any more. Recordings used to land in the same
per-game folder as clips; they now have their own, so a game's folder holds clips and
only clips.

**Your existing library is moved for you, once, on the first launch of this version.**
Recordings move into `Recordings\`, and any clip that had been left in the root moves
into its game's folder. Only files Rewind named itself (`Replay …`, `Recording …`) are
touched — anything else in that tree is left exactly where it is. Files in use are
skipped and stay visible in the old place.

## Per-app audio works

Settings → Audio → Output lists the apps that are playing sound, each with its own
fader. Every one of those faders was greyed out in earlier versions — the panel asked
for a list that never filled in the "can this app be captured on its own" flag. Fixed;
set a level and that app is captured separately from the rest of the desktop.

## Settings → Profiles: add your own

Four profiles, and now you can actually build them: **Add profile** and a duplicate
button per row, disabled once you are at four. Editing the active profile still applies
immediately.

## Storage usage

Settings → Storage now shows what the library takes: Recordings, Clips, Screenshots,
Compressed, plus the free space left on the drive holding your clips. It measures the
folders themselves, so the number is the library, not whatever else is in the folder
you picked.

## Also

- **The panel shows itself after an update**, even with *Start minimized* on, and the
  update popover says **Updated to 1.4.0**. A silent relaunch to the tray was
  indistinguishable from an update that failed.
- **The editor's compressor starts off.** The Compress box opens collapsed; turn it on
  when you want a smaller copy. Nothing changes about how it writes: always a new file
  in `Compressed\`, the original is never overwritten.
- **Portable zip.** `Rewind-1.4.0-portable.zip` — unpack it anywhere and run
  `Rewind.exe`. Same app, no installer, no registry entry. Settings and clips still live
  in the usual per-user places, and the in-app updater is off in a portable copy,
  because updating it would install a second one. Move up a version by downloading the
  new zip.
- Removed the "kept by the quick-clip hotkey" caption under the quick-clip length
  picker. The hotkey chip next to it already says which key it is.

---

The app still makes no network request unless you click **Check for updates**. No
telemetry, no analytics, no crash reporting.

**Windows x64 only.** Unsigned, so SmartScreen warns on first run and on every update.
