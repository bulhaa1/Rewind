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

<img width="603" height="986" alt="Screenshot 2026-10-11 012117" src="https://github.com/user-attachments/assets/8557028b-d783-438c-9607-09bb00915286" /> <img width="582" height="676" alt="Screenshot 2026-10-11 012149" src="https://github.com/user-attachments/assets/f884d4ab-0960-432f-8143-48b2a185992c" /> <img width="613" height="493" alt="Screenshot 2026-10-11 012221" src="https://github.com/user-attachments/assets/cd81f6db-64b1-4af2-a5a0-e0b1827fad73" /> <img width="1189" height="862" alt="Screenshot 2026-10-11 012335" src="https://github.com/user-attachments/assets/54c58e90-1aed-4f63-bd65-887439bccbce" /> 

## Install

Go to releases. Download `Rewind-<version>-setup.exe` and run it. Per-user install, no admin, no
account.

Recording, editing and clips are all local files. Rewind contains no analytics,
no telemetry and no crash reporting, and it makes no network request on its own —
the only way it ever contacts the network is if you press **Check for updates**
in the header. Nothing polls, nothing downloads unasked, and quitting the app
does not install an update you have not applied.

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
