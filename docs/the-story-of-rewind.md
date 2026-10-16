# Rewind and Revidi — A Public Statement

**Facts, dates, and evidence you can verify yourself.**

## TL;DR

I built **Rewind**, an open-source clipping tool inspired by Revidi, a closed-source application developed by toasterfork on Discord. He has accused me of stealing his code and threatened a DMCA takedown against this repository.

His evidence includes a folder name in my Git history: `Revidi-Clone`.

Let me be clear: **I have never had access to Revidi’s source code.** I used AI to study its externally observable behavior, then built my own implementation using the same publicly available OBS capture engine. Rewind has its own code, UI, features, architecture, and direction.

I credited Revidi as inspiration in my early README. The development history, dependencies, and source code are available for anyone to inspect.

I can't help but wonder if toasterfork is threatened by the idea of a free, open-source alternative competing with his cloud subscription model. Does he not see what's happening in the software industry? People are constantly building free, open-source alternatives to expensive commercial products, including alternatives to Adobe software. That's how competition works. No developer owns an entire category of software just because they built a product first.

Revidi still lacks 120 FPS recording to this day, puts its editor behind a paywall despite advertising free local use, and — per its own privacy policy — ships Mixpanel analytics covering device information and public IP addresses while checking an update manifest roughly every four hours. Meanwhile, Rewind aims to offer gamers a lightweight, local-first clipping tool without unnecessary subscriptions, locked features, or complicated OBS setups.

The whole point of open-source software is that users deserve alternatives, developers can innovate, and people shouldn't have to pay for every feature just because someone decided to monetize it. Instead of treating a free alternative as a threat, why not compete by improving the product? If Revidi is genuinely better, users will choose it. If Rewind offers more value for free, users should have the freedom to choose that, too.

**Inspiration is not theft. A folder name is not evidence of copied code. Accusations are not proof.**

## What actually happened

I started Rewind because I was frustrated with existing capture tools. Revidi was one of my inspirations, and I have never pretended otherwise.

Revidi is closed-source. I did not have its source code to copy. I used AI to analyze how it behaved as a user-facing application and developed my own implementation using the public OBS engine and other publicly available dependencies.

The distinction matters: Rewind is a local-first application with no server, cloud library, or sharing service. It is a different product built around a different set of priorities.

### Verifiable timeline

| Date | Repository history |
|---|---|
| Oct 10 | First commits; README initially titled Reflect, renamed to Rewind the same day (`c70b8c0`, `34bdc2f`). |
| Oct 11 | README explicitly thanked Revidi and linked to its website (`728ca57`). |
| Oct 13 | Attribution section shortened and link removed (`24fd699`). |
| Oct 15 | Revidi removed from the comparison table (`9923c11`). |
| Oct 15 | Git history rewritten to remove personal email addresses and local paths. |

## The folder name and Git history

Yes, the original working folder was named `Revidi-Clone`. I had not settled on a project name and used it as a temporary development folder while building the application.

The product itself was renamed **Reflect → Rewind** openly in the early commits. A working-directory name does not establish that source code was copied.

After this dispute began, I rewrote Git history using `git filter-branch` to remove my personal email address and local Windows paths. The obsolete folder name was removed in the same pass. Every commit now uses my GitHub noreply identity.

I should have communicated that change upfront. However, **this was a privacy cleanup, not an attempt to erase evidence**. Earlier history may still exist in forks or caches, and I will make no further history changes while this dispute remains open.

Verify it yourself:

- `git log --all -S 'Revidi-Clone'` — no remaining matches.
- `git log --format='%ae' | sort -u` — only `bulhaa1@users.noreply.github.com`.

## On the code-theft accusations

Three facts matter:

- **I never had Revidi's source code.** It is a closed-source application.
- **Both applications use the same public capture technology.** Revidi's own [privacy policy](https://revidi.app/privacy) identifies `@streamlabs/obs-studio-node`, the same OBS-based package used by Rewind.
- **Similar functionality does not establish copied source code.** Replay buffers, hotkeys, recording, and game detection are features that can be independently implemented.

Revidi's internal implementation is unknown to me. The code available for inspection is Rewind's, and it is public.

## Revidi vs. Rewind

| Feature | Revidi | Rewind |
|---|---|---|
| Replay buffer and hotkey clips | Yes | Yes |
| Automatic game detection | Yes | Yes |
| Start/stop recording and screenshots | Yes | Yes |
| Built-in clip trimming | Premium | Free |
| Audio mixing | Yes | Live faders and waveforms |
| Compression / re-encoding | Cloud editing | Local GPU or CPU encoding |
| Capture profiles | Not documented | Four, user-defined |
| Cloud sharing and library | Premium | None |
| Account | Optional; required for cloud | None |
| Analytics | Mixpanel, including IP address, per [privacy policy](https://revidi.app/privacy) | None |
| Updates | Automatic, approximately every four hours per policy | Manual checks only |
| Capture engine | OBS via `@streamlabs/obs-studio-node` | Same public package |
| Source code | Closed-source, all rights reserved | Open-source, GPL-2.0-or-later |
| Price | Free tier and $5 premium subscription | Free |

The key difference is not complicated: Revidi offers cloud features, while Rewind prioritizes local recording, privacy, and free access.

## What the source code actually shows

Rewind's publicly inspectable stack includes:

- **Application:** Electron 30, TypeScript, and Vite.
- **Interface:** React 18, Tailwind CSS 4, Base UI, and TanStack Query.
- **Capture:** `@streamlabs/obs-studio-node`, using the public OBS engine under GPL-2.0.
- **Encoding:** FFmpeg, with NVENC, AMF, QSV, and CPU fallback.
- **System integration:** `koffi`, `uiohook-napi`, `get-windows`, and `native-sound-mixer`.

The application is organized into `src/main`, `src/preload`, `src/renderer`, and `src/shared`, with 58 readable source files. Its dependencies and their licences are documented in the README.

There is exactly one occurrence of `revidi` in the source directory. Run:

`git grep -in revidi -- src`

It appears in `src/main/game-detector.ts` as part of a process-exclusion list:

```ts
'electron', 'rewind', 'revidi', 'obs64', 'obs32', 'streamlabs',
```

That list prevents Rewind from capturing itself, OBS, Streamlabs, and other capture-related processes. It is not copied application logic.

There is also no cloud implementation to clone. Run:

`git grep -nE 'axios|XMLHttpRequest|https?://' -- src`

The matches are limited to development configuration, browser links, an SVG background, and a thumbnail-reading function that works over IPC. The only outbound networking feature is `electron-updater`, triggered when the user manually checks for updates.

**A local-first clipping application without Revidi's cloud infrastructure is not a reproduction of its entire product.** The OBS integration both applications use is publicly available to begin with.

## Privacy: the documented differences

According to [Revidi's own privacy policy](https://revidi.app/privacy):

- Its desktop application sends Mixpanel analytics covering launches, clip saves, failures, OBS errors, device information, and public IP addresses.
- It checks an Amazon S3 update manifest approximately every four hours.
- Premium cloud uploads use Supabase storage, with associated clip and account metadata.

Rewind has no analytics SDK, account system, crash-reporting service, cloud storage, or background update polling. Update checks are manual.

These are differences in the products' documented designs, not allegations of wrongdoing against Revidi. Users can inspect Rewind's code and make their own assessment.

## If a DMCA notice is filed

Copyright disputes should be based on evidence of infringement, not assumptions drawn from a product's purpose, features, or a temporary folder name.

Revidi's source code was never available to me. Rewind's implementation uses public dependencies, and its development history and source code are available for inspection. Anyone making an allegation should identify the specific material they believe infringes their copyright.

If a notice is filed, I will respond through GitHub's applicable counter-notice process under 17 U.S.C. § 512(g), where appropriate. I remain open to resolving this directly, but I will not accept an accusation of code theft as established fact simply because the applications share a purpose.

## Auditable by design

Rewind includes verification commands covering its real application paths, including `npm run selftest`, `test:display`, `test:resolution`, `test:profiles`, `test:ui`, and the CI `verify:channels` check.

The source is open. The dependencies are identifiable. The implementation can be examined. **I welcome scrutiny of the actual code; I reject unsupported accusations about code nobody has shown me.**

## Judge for yourself

Download [Revidi](https://revidi.app/) and [Rewind](https://github.com/bulhaa1/Rewind/releases). Run them side by side. Inspect the repository. Check the dependencies and commits.

I have openly acknowledged what inspired Rewind. I have never claimed to have invented the concept of game clipping, and I have never had Revidi's source code.

**If there is evidence of copied code, identify it. If there isn't, stop presenting suspicion as proof.**

The capture engine is shared. The source code is not established to be shared. Judge the applications on the evidence, not on the name of a folder or the fact that one inspired the other.

---

## Update — October 2026

This statement was written while the dispute was live. The ending turned out quieter than the opening.

Rewind exists because two things I wanted did not exist in Revidi: free local editing and 120 FPS recording. I said so, as feedback, in the only channel its developer offered. Nothing moved. So I built the alternative myself, released it, and let the source speak for what it was.

The features arrived in Revidi soon after. I do not claim to know why the timeline bent that way, and it does not matter anymore. What matters is the outcome users got: both tools got better, the expensive things got cheaper, and nobody had to wait on one developer's roadmap for a feature two lines of feedback asked for. That was the argument this repository made from the start, and it settled faster than any statement could have.

Rewind 1.5.0 is its final release, and the repository stays public under GPL-2.0-or-later. Fork it, learn from it, build on it. If this story teaches anything, it is this: a competitor with a different priority list is not an attack. It is the cheapest feedback a developer will ever get — and sometimes the only kind that gets answered.

Play. Capture. Keep.
