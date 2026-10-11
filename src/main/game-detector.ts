import { screen } from 'electron'
import { scope } from './logger.js'
import { GAME_DETECTOR } from '@shared/constants.js'
import { stripWindowTitle } from './capture.js'

const log = scope('GameDetector')

/**
 * Processes that are never games even when fullscreen.
 *
 * A denylist, not an allowlist, which means an unknown fullscreen app is treated
 * as a game candidate. That is the wrong default often enough to be worth
 * listing aggressively.
 *
 * Names are the window owner process name with `.exe` stripped and lowercased,
 * which is how `isExcluded` compares them. Verified names are called out below;
 * where a name is the product's conventional executable rather than something
 * confirmed on disk, that is said, because a wrong entry here silently does
 * nothing.
 *
 * AI and developer tooling kept getting caught: a terminal-sized window that
 * happens to fill the screen is indistinguishable from a game by geometry
 * alone. OpenChamber was detected on this machine on every single launch, which
 * cost a five-second game-hook timeout each time.
 */
export const EXCLUDED_PROCESSES = new Set([
  // Browsers and web apps
  'chrome', 'firefox', 'msedge', 'brave', 'opera', 'vivaldi', 'arc', 'chromium', 'opera_gx',
  'waterfox', 'librewolf', 'thorium',

  // Editors and IDEs
  'code', 'devenv', 'idea64', 'rider64', 'webstorm64', 'pycharm64', 'clion64',
  'sublime_text', 'notepad++', 'atom', 'cursor', 'zed', 'positrond', 'vscodium',

  // AI assistants and agents. `claude` covers Claude Desktop on both install
  // paths -- the standalone %LOCALAPPDATA%\AnthropicClaude\app-*\claude.exe and
  // the MSIX build under WindowsApps -- which are both just claude.exe.
  'claude', 'codex', 'opencode', 'openchamber', 'windsurf', 'kiro', 'trae',
  'chatgpt', 'mscopilot', 'copilotapp', 'perplexity', 'lmstudio', 'ollama',

  // Terminals and shells
  'windowsterminal', 'powershell', 'pwsh', 'cmd', 'conhost',

  // Communication
  'discord', 'goofcord', 'spotify', 'slack', 'teams', 'zoom', 'telegram', 'signal',
  'whatsapp', 'skype',

  // Media players
  'vlc', 'mpc-hc', 'mpc-hc64', 'mpv', 'wmplayer', 'potplayer', 'potplayermini64', 'foobar2000',

  /*
   * Performance overlays. These are the strongest case for exclusion: RTSS and
   * Afterburner draw on top of whatever is running, so they are frequently the
   * frontmost fullscreen window during a game and would otherwise win the
   * detection outright.
   */
  'rtss', 'msiafterburner',

  // Rewind and the capture stack it competes with
  'electron', 'rewind', 'revidi', 'obs64', 'obs32', 'streamlabs',

  // Shell and system
  'explorer', 'dwm', 'shellexperiencehost', 'searchhost',
  'systemsettings', 'applicationframehost', 'textinputhost', 'lockapp',
  'startmenuexperiencehost', 'searchui', 'cortana', 'taskmgr', 'snippingtool', 'widgets',
  'lightshot',

  // Office and documents
  'powerpnt', 'excel', 'winword', 'acrobat', 'acrord32', 'mstsc', 'onenote', 'outlook', 'notepad',

  // Game launchers, which sit fullscreen while a game is running
  'steam', 'steamwebhelper', 'epicgameslauncher', 'battle.net',
  'galaxyclient', 'riotclientservices', 'eadesktop', 'origin', 'gogalaxy', 'ubisoftconnect',
  'bethesda.net_launcher',
])

/** OBS synthesizes this window for some sources; never a real capture target. */
const SYNTHETIC_WINDOWS = new Set(['d3dproxywindow'])

type WindowLike = {
  platform: string
  title: string
  owner: { path: string; processId: number }
  contentBounds: { width: number; height: number }
  bounds: Electron.Rectangle
}

/** The two entry points Rewind uses from the `get-windows` package. */
interface WindowsApi {
  activeWindow(): Promise<WindowLike>
  openWindows(): Promise<WindowLike[]>
}

type DetectorState = 'stopped' | 'scanning' | 'capturing'

interface Candidate {
  processName: string
  title: string
  width: number
  height: number
  pid: number
  bounds: Electron.Rectangle
}

/**
 * Watches the foreground window and switches capture when a game takes over the
 * screen. Requires two consecutive qualifying polls so a brief alt-tab doesn't
 * trigger a source switch.
 */
export class GameDetector {
  private state: DetectorState = 'stopped'
  private pollTimer: NodeJS.Timeout | null = null
  private livenessTimer: NodeJS.Timeout | null = null
  private candidateCount = 0
  private candidateProcessName = ''
  private candidatePid = 0
  private switching = false
  private pollErrorLogged = false
  private lastLoggedSignature = ''

  private activeGamePid = 0
  private activeGameName = ''
  private activeWindowId = ''
  private lastForegroundPid = 0
  private hookRetriedPid = 0
  private sessionExclusions = new Set<string>()

  /**
   * Bumped whenever the detector starts or stops.
   *
   * Switching is asynchronous and spans several awaits, so work that was already
   * in flight when `stop()` ran would otherwise complete afterwards and tear down a
   * capture source the user had already moved off. Each async path captures this
   * value and bails if it changed.
   */
  private generation = 0

  private capture: any = null
  private getMainWindow: () => any = () => null
  private fallbackDisplayIndex = 0

  /** Memoized `get-windows` module namespace, loaded lazily on first use. */
  private windowsModule: WindowsApi | null = null

  private async loadWindows(): Promise<WindowsApi> {
    if (this.windowsModule) return this.windowsModule
    const mod = (await import('get-windows')) as unknown as WindowsApi
    this.windowsModule = mod
    return mod
  }

  setCapture(c: any): void {
    this.capture = c
  }

  /**
   * Permanently (for this session) ignores a process as a game candidate.
   *
   * Called when the OBS game hook fails to attach. Without this the detector keeps
   * re-detecting the same window, and each retry rebuilds the replay chain — wiping
   * the rolling buffer, so the user ends up with nothing to save.
   */
  excludeProcess(name: string): void {
    const key = name.trim().toLowerCase()
    if (!key || this.sessionExclusions.has(key)) return
    this.sessionExclusions.add(key)
    log.info(`Excluding "${key}" for this session (game hook did not attach)`)
  }
  setGetMainWindow(f: () => any): void {
    this.getMainWindow = f
  }
  setFallbackDisplayIndex(i: number): void {
    this.fallbackDisplayIndex = i
  }

  isRunning(): boolean {
    return this.state !== 'stopped'
  }
  isCapturingGame(): boolean {
    return this.state === 'capturing'
  }
  getActiveGameName(): string {
    return this.activeGameName
  }

  start(): void {
    if (this.state !== 'stopped') {
      void this.scanOpenWindows()
      return
    }
    this.generation++
    this.state = 'scanning'
    this.candidateCount = 0
    this.sessionExclusions.clear()
    this.pollTimer = setInterval(() => void this.poll(), GAME_DETECTOR.POLL_INTERVAL)
    void this.scanOpenWindows()
    log.info('Game detector started')
  }

  stop(): void {
    if (this.state === 'stopped') return
    // Invalidate any switch already in flight before tearing down.
    this.generation++
    this.stopPollTimer()
    this.stopLivenessTimer()
    this.state = 'stopped'
    this.candidateCount = 0
    this.clearActiveGame()
    this.lastForegroundPid = 0
    this.lastLoggedSignature = ''
    log.info('Game detector stopped')
  }

  private stopPollTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /**
   * On startup the game is usually already running and never becomes "foreground"
   * through normal tabbing, so we sweep every open window once before polling.
   */
  private async scanOpenWindows(): Promise<void> {
    try {
      const { openWindows } = await this.loadWindows()
      const windows = await openWindows()
      if (this.state !== 'scanning') return

      for (const w of windows) {
        const c = this.toCandidate(w)
        if (!c || c.pid <= 0 || this.isExcluded(c.processName) || !this.isFullscreen(c)) continue
        log.info(`Open-window scan found running fullscreen candidate: "${c.processName}" (${c.title})`)
        await this.validateAndSwitch(c)
        return
      }
    } catch (e) {
      log.warn('Open-window scan failed:', e)
    }
  }

  private async poll(): Promise<void> {
    if (this.state === 'stopped') return
    let candidate: Candidate | null = null
    try {
      const { activeWindow } = await this.loadWindows()
      candidate = this.toCandidate(await activeWindow())
      this.pollErrorLogged = false
    } catch (e) {
      if (!this.pollErrorLogged) {
        log.warn('Foreground window poll failed:', e)
        this.pollErrorLogged = true
      }
      this.candidateCount = 0
      return
    }
    this.handlePollResult(candidate)
  }

  private toCandidate(w: WindowLike | null | undefined): Candidate | null {
    if (!w || w.platform !== 'windows') return null
    const base = w.owner?.path ? w.owner.path.split(/[\\/]/).pop() ?? '' : ''
    const processName = base.replace(/\.exe$/i, '')
    if (!processName) return null
    return {
      processName,
      title: w.title,
      width: w.contentBounds.width,
      height: w.contentBounds.height,
      pid: w.owner.processId,
      bounds: w.bounds,
    }
  }

  /**
   * Fullscreen means the window's content area fills the monitor it sits on.
   * Comparing against the containing display (not the global bounds) handles
   * multi-monitor setups and taskbar-inset windows.
   */
  private isFullscreen(c: Candidate): boolean {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(c.bounds.x + c.bounds.width / 2),
      y: Math.round(c.bounds.y + c.bounds.height / 2),
    })
    const { width, height } = display.bounds
    if (width === 0 || height === 0) return false

    const ratioX = c.width / width
    const ratioY = c.height / height
    return ratioX >= GAME_DETECTOR.FULLSCREEN_RATIO && ratioY >= GAME_DETECTOR.FULLSCREEN_RATIO
  }

  private isExcluded(processName: string): boolean {
    const p = processName.toLowerCase()
    return EXCLUDED_PROCESSES.has(p) || this.sessionExclusions.has(p)
  }

  private handlePollResult(c: Candidate | null): void {
    if (this.state === 'stopped') return

    const prevPid = this.lastForegroundPid
    this.lastForegroundPid = c?.pid ?? 0

    if (!c) {
      this.candidateCount = 0
      return
    }

    const fullscreen = this.isFullscreen(c)
    const excluded = this.isExcluded(c.processName)
    const isCandidate = fullscreen && !excluded && c.pid > 0

    // Log only on state change: polling is 3s and most polls are uninteresting.
    const signature = `${c.processName}|${c.width}x${c.height}|${fullscreen}|${excluded}|${isCandidate}`
    if (signature !== this.lastLoggedSignature) {
      log.info(
        `Poll: "${c.processName}" ${c.width}x${c.height} pid=${c.pid} ` +
        `fullscreen=${fullscreen} excluded=${excluded} candidate=${isCandidate}`,
      )
      this.lastLoggedSignature = signature
    }

    if (this.state === 'capturing') {
      if (!isCandidate || c.pid === this.activeGamePid) {
        this.candidateCount = 0
        // Focus returning to the game after we fell back is a good moment to retry the hook.
        if (c.pid === this.activeGamePid && prevPid !== c.pid) this.retryFailedHook(c)
        return
      }
    } else if (!isCandidate) {
      this.candidateCount = 0
      return
    }

    if (c.processName === this.candidateProcessName && c.pid === this.candidatePid) {
      this.candidateCount++
    } else {
      this.candidateProcessName = c.processName
      this.candidatePid = c.pid
      this.candidateCount = 1
    }

    if (this.candidateCount >= GAME_DETECTOR.CANDIDATE_THRESHOLD) {
      void this.validateAndSwitch(c)
    }
  }

  /**
   * Scores each OBS window against the foreground process. Exact title matches win
   * over substring matches; synthetic windows are heavily penalized.
   */
  private pickBestWindowMatch(windows: { value: string; name: string }[], c: Candidate) {
    const proc = c.processName.toLowerCase()
    const title = c.title.toLowerCase()

    let best: { value: string; name: string } | null = null
    let bestScore = 0

    for (const w of windows) {
      const value = w.value.toLowerCase()
      const name = w.name.toLowerCase()
      const first = value.split(':')[0] ?? ''

      let score = 0
      if (value.includes(proc) || name.includes(proc)) score += 2
      if (title && name.includes(title)) score += 4
      if (title && first === title) score += 8
      if (SYNTHETIC_WINDOWS.has(first)) score -= 100

      if (score > bestScore) {
        bestScore = score
        best = w
      }
    }

    return bestScore > 0 ? best : null
  }

  private async validateAndSwitch(c: Candidate): Promise<void> {
    if (!this.capture || this.switching || this.state === 'stopped') return
    const generation = this.generation
    this.switching = true

    const wasCapturing = this.state === 'capturing'
    const prevPid = this.activeGamePid
    const prevName = this.activeGameName
    const prevWindow = this.activeWindowId

    try {
      const windows = this.capture.refreshWindowList()
      const match = this.pickBestWindowMatch(windows, c)

      if (!match) {
        // Not hookable as a window: remember it so we stop re-testing every poll.
        log.info(`Candidate ${c.processName} is not OBS-hookable, excluding for session`)
        this.sessionExclusions.add(c.processName.toLowerCase())
        this.candidateCount = 0
        if (!wasCapturing) this.state = 'scanning'
        return
      }

      log.info(`Game detected: ${c.processName} (${c.title}), switching to game capture`)
      this.activeGamePid = c.pid
      this.activeGameName = stripWindowTitle(match.name) || c.processName
      this.activeWindowId = match.value

      await this.capture.autoDetectSwitchToWindow(match.value, c.bounds, c.processName)

      // The detector may have been stopped while the source switch was in flight.
      if (generation !== this.generation) {
        log.info('Game detector stopped mid-switch; discarding result')
        this.switching = false
        return
      }

      this.state = 'capturing'
      this.candidateCount = 0
      this.startLivenessTimer()
      this.notifyRenderer()
      log.info(`Now capturing: ${this.activeGameName}`)
    } catch (e) {
      log.error('Failed to switch to game capture:', e)
      this.candidateCount = 0
      if (wasCapturing) {
        this.activeGamePid = prevPid
        this.activeGameName = prevName
        this.activeWindowId = prevWindow
      } else {
        this.state = 'scanning'
      }
    } finally {
      this.switching = false
    }
  }

  /** One retry per PID: the hook often only attaches once the window is refocused. */
  private async retryFailedHook(c: Candidate): Promise<void> {
    // Respect the session exclusion recorded when the hook failed the first time;
    // otherwise every focus change re-triggers the same futile switch.
    if (this.isExcluded(c.processName)) return
    if (this.state === 'stopped' || !this.capture?.isOnHookFallback?.()) return
    if (this.switching || this.hookRetriedPid === this.activeGamePid) return

    const generation = this.generation
    this.hookRetriedPid = this.activeGamePid
    this.switching = true
    try {
      log.info(`Retrying game capture hook for ${this.activeGameName} (focus regained)`)
      await this.capture.autoDetectSwitchToWindow(this.activeWindowId, c.bounds, c.processName)
      if (generation !== this.generation) log.info('Game detector stopped mid-retry; discarding')
    } catch (e) {
      log.error('Game capture hook retry failed:', e)
    } finally {
      this.switching = false
    }
  }

  private startLivenessTimer(): void {
    this.stopLivenessTimer()
    this.livenessTimer = setInterval(() => this.checkGameAlive(), GAME_DETECTOR.LIVENESS_INTERVAL)
  }

  private stopLivenessTimer(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  /** `process.kill(pid, 0)` is the cross-platform liveness probe; no handle needed. */
  private checkGameAlive(): void {
    if (this.activeGamePid === 0) return
    try {
      process.kill(this.activeGamePid, 0)
    } catch {
      log.info(`Game process exited (PID ${this.activeGamePid}), switching back to display`)
      void this.switchBackToDisplay()
    }
  }

  private clearActiveGame(): void {
    this.activeGamePid = 0
    this.activeGameName = ''
    this.activeWindowId = ''
    this.hookRetriedPid = 0
  }

  private async switchBackToDisplay(): Promise<void> {
    this.stopLivenessTimer()
    this.clearActiveGame()
    if (!this.capture) {
      this.state = 'scanning'
      return
    }
    try {
      await this.capture.autoDetectSwitchToDisplay(this.fallbackDisplayIndex)
    } catch (e) {
      log.error('Failed to switch back to display:', e)
    }
    this.state = 'scanning'
    this.notifyRenderer()
  }

  private notifyRenderer(): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('auto-detect-switched')
  }
}