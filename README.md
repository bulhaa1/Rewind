# Rewind

Have you ever wanted a simple, lightweight way to clip your gameplay or take screenshots without a bulky overlay, unnecessary background processes, or an app that gets in the way?

Rewind is built for exactly that.

Modern capture tools like NVIDIA ShadowPlay and AMD Radeon ReLive offer convenient recording features, but they can introduce overhead and come with extra software and features you may not need. In competitive gaming, every frame and every millisecond matters. You shouldn't have to sacrifice performance or clutter your desktop just to save a great moment.

Rewind takes a different approach: keep it lightweight, stay out of the way, and capture what matters.

🎮 Instant Replay — Save those incredible plays, clutch rounds, and unexpected moments without recording your entire session manually.

📹 Screen and Game Recording — Start recording when you need it and stop when you're done.

📸 Quick Screenshots — Capture important moments with minimal interruption.

✂️ Local Clip Management — Browse, organize, and edit your clips without relying on a cloud service.

🔒 Privacy First — Your recordings stay on your drive. No account required, no cloud uploads, and no telemetry. Your gameplay is yours.

⚡ Designed to Stay Out of the Way — A compact, unobtrusive experience focused on doing the job without unnecessary overlays or background clutter.

Rewind is built around a simple idea: your capture software should work for you, not get in your way.

No unnecessary distractions. No cloud dependency. Just your gameplay, captured locally.

Rewind — Play. Capture. Keep.

## Preview

<img width="990" alt="The Rewind panel: the rolling buffer on the left, the clip rail on the right" src="assets/preview/panel.png" />

<img width="990" alt="The clip editor: trim range, per-track volume and a waveform per audio track" src="assets/preview/editor.png" />

<img width="990" alt="Settings are a signal path — here, the encoder section" src="assets/preview/settings.png" />

## Install

Go to releases. Download `Rewind-<version>-setup.exe` and run it. Per-user install, no admin, no
account.

Recording, editing and clips are all local files. Rewind contains no analytics,
no telemetry and no crash reporting, and it makes no network request on its own —
the only way it ever contacts the network is if you press **Check for updates**
in the header (see [Updating](#updating)). Nothing polls, nothing downloads
unasked, and quitting the app does not install an update you have not applied.

**Windows x64 only.** There is no ARM or 32-bit build and no non-Windows build YET.

## Using it

Rewind lives in the system tray, and the panel opens from the tray icon. These four
work whether the panel is open or closed:

| Key | Action |
|---|---|
| `Alt+1` | Save the whole replay buffer as a clip |
| `Ctrl+Alt+1` | Save only the last N seconds, at a length you pick on the panel |
| `Alt+2` | Take a screenshot of the captured display |
| `Alt+3` | Start / stop a continuous recording |

All four are rebindable in Settings. The buffer keeps rolling while the panel is
closed, so closing the window never costs you a clip. The strip along the bottom of
the panel shows how much is buffered at that moment.

Clips, screenshots and the editor are all reachable from the tray menu.

## Updating

Rewind is privacy-first, and the updater is built the same way: **it never checks
for updates on its own.** There is no background poll, no silent download, and
quitting the app never installs anything. You only hear about a new version when
you go looking for it.

To update:

1. Click the download-arrow icon at the top-right of the panel, next to the
   settings gear.
2. Press **Check for updates**.
3. If a version is available, press **Download**, then **Restart and install**.
   The installer runs silently — no wizard, no clicks — and the app comes back up
   on the new version. Your clips, settings and hotkeys carry over, and what the
   updater downloaded is cleared from disk shortly afterwards instead of piling up.

<img width="268" alt="The update tab: 'Rewind only contacts the network when you check', with a Check for updates button" src="assets/preview/update-tab.png" />

The same tab shows why if a check fails, and nothing is ever downloaded until you
press Download.

What your machine can encode, and what Rewind does when it cannot, is documented in
[`docs/hardware-compatibility.md`](docs/hardware-compatibility.md) — including a
checklist for a machine nobody has tried yet.

## How it compares

| Tool | Price | Replay Buffer | Any GPU | Standalone App | Extra Bloat | Data Collection | Setup Difficulty | Customizability |
|---|---|---|---|---|---|---|---|---|
| **Rewind** | **Free · Open Source** | **Yes** | **Yes** | **Yes** | **None** | **None** | **Super Easy** | **9/10** |
| Medal.tv | Free (Premium available) | Yes | Yes | Yes | Yes | Yes | Medium | 7/10 |
| Revidi | Free (Premium available) | Yes | Yes | Yes | Minimal | Yes | Easy | 8/10 |
| NVIDIA ShadowPlay | Free | Yes | No | Part of NVIDIA App | Yes | Can Opt Out | Easy | 7/10 |
| AMD ReLive | Free | Yes | No | Part of AMD Adrenalin | Yes | Can Opt Out | Easy | 6/10 |
| Outplayed | Free | Yes | Yes | Part of Overwolf | Yes | Yes | Medium | 7.5/10 |
| SteelSeries Moments | Free | Yes | Yes | Part of SteelSeries GG | Yes | Yes | Medium | 7/10 |
| OBS Studio | Free · Open Source | Yes | Yes | Yes | None | None | Very Hard | 10/10 |
| Xbox Game Bar | Free · Built into Windows | Yes | Yes | Built into Windows | Yes | Yes | done for u | 2/10 |

Rewind detects the encoder your GPU offers — NVENC, AMF or QSV — and falls back
to CPU encoding when it finds none, so it runs on any of them rather than being
tied to one vendor. It is also its own installer: no Overwolf, no Adrenalin, no
NVIDIA App running underneath it.

Rewind is the least system resource taking app out of them all. It's purposefully
built with a simple UI to make it lightweight, so anyone — even on a potato PC — can
clip their favorite moments without a major frame-rate hit.

The share-link column is the one place Rewind is behind on purpose. Everyone
else's version of that feature means your clips go through someone else's server.
Rewind has no server.

Competitor details are approximate and go stale — pricing and features change.
Check the others before relying on them.

## Development

```bash
npm install
npm run dev          # run against node_modules
npm run build        # compile main + renderer
npm start            # build then run
npm run package      # build the NSIS installer into release/
```

Verification, per area — each one runs the real path and reports what it measured:

```bash
npm run test:ui            # the panel regression suite (needs a running app on CDP 9222)
npm run test:display       # the capture canvas follows the display, buffer live or paused
npm run test:resolution    # a real display mode change, both directions (blanks the screen briefly)
npm run test:profiles      # the four presets: tiers, write-through, pause preservation
npm run test:update-cache  # the updater cache is emptied on start
npm run test:update        # 1.1.0 -> 1.2.0 end to end against a local feed
npm run selftest           # save, screenshot and library paths end to end
```

Native modules must be built against Electron's ABI first:

```bash
npm run rebuild
```

This is already done for `npm run dev` and `npm run package`; you only need it
after a fresh `npm install` or an Electron upgrade.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE).

`GPL-2.0-or-later` rather than `GPL-2.0` because `ffmpeg-static` is
GPL-3.0-or-later, and bare `GPL-2.0` in SPDX terms means *-only*, which cannot be
combined with GPL-3.0. OBS Studio and `obs-studio-node` are GPL-2.0.

Inspired by work from @toasterfork. Rewind is an entirely independent implementation designed by analyzing external software behavior and building equivalent functionality on top of the OBS engine.

Bundled third-party components keep their own licences, including OBS Studio
(GPL-2.0), ffmpeg (GPL), koffi (MIT), uiohook-napi (MIT) and Electron (MIT).
