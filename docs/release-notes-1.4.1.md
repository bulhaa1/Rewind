# Rewind 1.4.1

Hotfix. In every build up to and including 1.4.0, `Rewind.exe` was never stamped with
Rewind's name and icon: Task Manager showed the app as **Electron**, and its icon was
Electron's default one in Explorer, the Start menu and on the taskbar. The installed
shortcuts kept pointing at the right file, so only the icon and the name were wrong —
nothing about capture, clips or settings was affected.

**Why.** The packaging step that applies the icon and version resource
(`scripts/stamp-exe.mjs`) runs the same tool electron-builder would, by hand, because
`signAndEditExecutable` has to stay off on this machine. It looks for
`rcedit-x64.exe` in electron-builder's cache, and that cache is only populated when
electron-builder edits executables itself — which is exactly what this repo turned off.
On a machine where that never happened the file was simply absent, the stamp aborted,
and the step before it had already written an installer, so the release looked complete.

**The fix.** The stamp now fetches `rcedit` into the cache when it is missing, so
`npm run package` finishes on a fresh machine instead of stopping quietly at that step.
The packaged `Rewind.exe` now carries Rewind's icon, product name and version, and Task
Manager shows **Rewind 1.4.1**.

Everything from 1.4.0 is in this build — folder layout with the one-time migration,
working per-app audio faders, add/duplicate profiles, the Storage breakdown, the panel
showing itself after an update, the compressor off by default, and the portable zip.

---

Existing installs will offer 1.4.1 in-app. The app still makes no network request
unless you click **Check for updates**.

**Windows x64 only.** Unsigned, so SmartScreen warns on first run and on every update.
