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

Rewind lives in the system tray. The panel opens from the tray, or with the
global hotkeys:

| Key | Action |
|---|---|
| `Alt+1` | Open / close the panel |
| `Alt+2` | Save the buffer as a clip |

The buffer keeps rolling while the panel is closed. Recording state is shown by the
ring filling — there is no red dot to misread.

Clips, screenshots and the editor are all reachable from the tray menu.

## How it compares

| Tool | Price | Replay buffer | Any GPU | Standalone app | Instant share link |
|---|---|---|---|---|---|
| **Rewind** | **Free · open source** | **Yes** | **Yes** | **Yes** | No — deliberately: no cloud, no account, no telemetry |
| Medal.tv | Free (Premium available) | Yes | Yes | Yes | Yes |
| Revidi | Free (Premium $4.99/mo) | Yes | Yes | Yes | Yes |
| NVIDIA ShadowPlay | Free | Yes (Instant Replay) | No | Part of the NVIDIA App | No |
| AMD ReLive | Free | Yes | No | Part of AMD Adrenalin | No |
| Outplayed | Free | Yes | Yes | Runs on the Overwolf platform | Yes |
| SteelSeries Moments | Free | Yes | Yes | Part of SteelSeries GG | Yes (in-app) |
| OBS Studio | Free (open source) | Yes | Yes | Yes | No |
| Xbox Game Bar | Free (built into Windows) | Yes (background recording) | Yes | Built into Windows | No |

Rewind detects the encoder your GPU offers — NVENC, AMF or QSV — and falls back
to CPU encoding when it finds none, so it runs on any of them rather than being
tied to one vendor. It is also its own installer: no Overwolf, no Adrenalin, no
NVIDIA App running underneath it.

Rewind is the least system resource taking app out of them all. Its purposly built with simple ui to make it lightweight so anyone even on a potato PC can clip there favorite moments without major fps hit.

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

## Relationship to other software

Huge thanks to [Revidi](https://revidi.app/) and its solo developer, @toasterfork, for inspiring this project. Rewind is an independent reimplementation built by observing Revidi’s behaviour and recreating its functionality from the OBS engine upwards. No third-party application code was copied into this repository.

Bundled third-party components keep their own licences, including OBS Studio
(GPL-2.0), ffmpeg (GPL), koffi (MIT), uiohook-napi (MIT) and Electron (MIT).
