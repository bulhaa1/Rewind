# Reflect

A lightweight replay buffer for Windows. It keeps the last few seconds on a
rolling buffer so you can pull out a moment *after* it happened — hotkey-driven,
tray-resident, and offline.

Built on OBS Studio's engine (`obs-studio-node`). None of OBS's concepts appear on
the surface: you press a key, you get a clip.

![The panel](assets/icon/_contact-sheet.png)

## Install

Download `Reflect-<version>-setup.exe` and run it. Per-user install, no admin, no
account, no network access at any point.

**Windows x64 only.** There is no ARM or 32-bit build and no non-Windows build.

## Using it

Reflect lives in the system tray. The panel opens from the tray, or with the
global hotkeys:

| Key | Action |
|---|---|
| `Alt+1` | Open / close the panel |
| `Alt+2` | Save the buffer as a clip |

The buffer keeps rolling while the panel is closed. Recording state is shown by the
ring filling — there is no red dot to misread.

Clips, screenshots and the editor are all reachable from the tray menu.

## Development

```bash
npm install
npm run dev          # run against node_modules
npm run build        # compile main + renderer
npm start            # build then run
npm run package      # build the NSIS installer into release/
```

Native modules must be built against Electron's ABI first:

```bash
npm run rebuild
```

This is already done for `npm run dev` and `npm run package`; you only need it
after a fresh `npm install` or an Electron upgrade.

### Verification

There are no unit tests. Verification is done by driving a real, running app:

```bash
npm run typecheck
npm run test:ui                      # 16 CDP checks against the live panel
npm run selftest                     # main-process self test
node scripts\recordtest.js 60 30     # record 30s at 60fps, then probe the file
node scripts\audiotest.js            # play a tone, measure the captured loudness
```

`scripts/probe-*.mjs` and `scripts/shot-*.mjs` are the harness. They connect to a
running app over the Chrome DevTools Protocol (`--remote-debugging-port=9222`).

Two rules learned the hard way, worth keeping:

- **`ffprobe` reading a file is not the same as it decoding.** Always run
  `ffmpeg -v error -i file -f null NUL` and check the exit code.
- **ffmpeg's `volumedetect` writes to stderr.** `execFileSync` returns stdout only,
  which will report a false PASS.

### Icons and palette

The brand artwork is generated into `assets/`:

```bash
npm run icons      # extract -> sizes -> .ico -> contact sheet
npm run palette    # sample the artwork -> oklch -> palette sheet
```

`DESIGN.md` explains the mark's geometry, why there are two sizes of it, and how
the accent hue was chosen.

## Known limitations

Stated plainly rather than discovered later:

- **60 fps records at 30.** OBS normalises `FPSType` back to `FPSType=0` on
  shutdown and the profile write does not survive it. 30 and 120 both produce the
  rate they claim; 60 does not. The option is still offered and is wrong.
- **The editor's audio waveform renders flat.** Audio capture and playback are
  verified working — a tone measures −29.3 dB in a saved clip — so the fault is in
  waveform generation, not in capture.
- **Per-app audio mixing, extra device channels and `separateAudioTracks` are
  exposed in Settings but unverified.** They may work; they have not been tested.
- **`Reflect.exe` keeps Electron's default icon.** `signAndEditExecutable` is off
  because electron-builder's signing tool cannot be extracted on Windows without
  Developer Mode. The app's own icons — panel, editor window, tray — are correct;
  only the executable's own icon and version metadata are not stamped.
- **Unsigned.** Windows SmartScreen will warn on first run.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE).

`GPL-2.0-or-later` rather than `GPL-2.0` because `ffmpeg-static` is
GPL-3.0-or-later, and bare `GPL-2.0` in SPDX terms means *-only*, which cannot be
combined with GPL-3.0. OBS Studio and `obs-studio-node` are GPL-2.0.

## Relationship to other software

Reflect is an independent reimplementation. It was written by observing the
behaviour of another product and rebuilding the functionality from the OBS engine
upwards; no third-party application code was copied into this repository.

Bundled third-party components keep their own licences, including OBS Studio
(GPL-2.0), ffmpeg (GPL), koffi (MIT), uiohook-napi (MIT) and Electron (MIT).
