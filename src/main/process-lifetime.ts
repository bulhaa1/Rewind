import { execSync } from 'node:child_process'
import { scope } from './logger.js'

const log = scope('ProcessLifetime')

/**
 * Binds spawned children (obs64.exe) to a Win32 job object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so they terminate when Rewind exits.
 *
 * Without this a crash or force-kill leaves an orphaned obs64 holding the capture
 * device, which blocks the next launch.
 */
type KoffiLib = any

let jobBinding: {
  koffi: KoffiLib
  entrySize: number
  limitInfoType: any
  CreateToolhelp32Snapshot: (flags: number, pid: number) => any
  Process32FirstW: (snap: any, entry: any) => boolean
  Process32NextW: (snap: any, entry: any) => boolean
  CreateJobObjectW: (attrs: any, name: any) => any
  SetInformationJobObject: (job: any, cls: number, info: any, size: number) => boolean
  OpenProcess: (access: number, inherit: boolean, pid: number) => any
  AssignProcessToJobObject: (job: any, process: any) => boolean
  CloseHandle: (h: any) => boolean
} | null | undefined

const SNAP_PROCESS = 2
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
/** JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */
const KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const INVALID_HANDLE = 0xffffffffffffffffn
const MAX_PATH_CHARS = 260

function getJobBinding() {
  if (jobBinding !== undefined) return jobBinding

  if (process.platform !== 'win32') {
    jobBinding = null
    return jobBinding
  }

  try {
    const koffi = require('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    koffi.pointer('HANDLE', koffi.opaque())

    const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16', MAX_PATH_CHARS, 'String'),
    })
    const BASIC_LIMIT = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'uintptr_t',
      MaximumWorkingSetSize: 'uintptr_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    })
    const IO_COUNTERS = koffi.struct('IO_COUNTERS', {
      ReadOperationCount: 'uint64',
      WriteOperationCount: 'uint64',
      OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64',
      WriteTransferCount: 'uint64',
      OtherTransferCount: 'uint64',
    })
    const EXT_LIMIT = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
      BasicLimitInformation: BASIC_LIMIT,
      IoInfo: IO_COUNTERS,
      ProcessMemoryLimit: 'uintptr_t',
      JobMemoryLimit: 'uintptr_t',
      PeakProcessMemoryUsed: 'uintptr_t',
      PeakJobMemoryUsed: 'uintptr_t',
    })

    jobBinding = {
      koffi,
      entrySize: koffi.sizeof(PROCESSENTRY32W),
      limitInfoType: EXT_LIMIT,
      CreateToolhelp32Snapshot: kernel32.func('HANDLE CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
      Process32FirstW: kernel32.func('bool Process32FirstW(HANDLE snapshot, _Inout_ PROCESSENTRY32W *entry)'),
      Process32NextW: kernel32.func('bool Process32NextW(HANDLE snapshot, _Inout_ PROCESSENTRY32W *entry)'),
      CreateJobObjectW: kernel32.func('HANDLE CreateJobObjectW(void *attrs, const char16_t *name)'),
      SetInformationJobObject: kernel32.func(
        'bool SetInformationJobObject(HANDLE job, int infoClass, const JOBOBJECT_EXTENDED_LIMIT_INFORMATION *info, uint32 size)',
      ),
      OpenProcess: kernel32.func('HANDLE OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      AssignProcessToJobObject: kernel32.func('bool AssignProcessToJobObject(HANDLE job, HANDLE process)'),
      CloseHandle: kernel32.func('bool CloseHandle(HANDLE handle)'),
    }
  } catch (e) {
    log.warn('Win32 job objects unavailable, child processes may outlive a killed app:', e)
    jobBinding = null
  }

  return jobBinding
}

/** PIDs of direct children of this process whose executable matches `exeName`. */
export function findChildPids(job: NonNullable<typeof jobBinding>, exeName: string): number[] {
  const snap = job.CreateToolhelp32Snapshot(SNAP_PROCESS, 0)
  if (!snap || job.koffi.address(snap) === INVALID_HANDLE) return []

  const pids: number[] = []
  try {
    const entry: any = { dwSize: job.entrySize }
    for (let ok = job.Process32FirstW(snap, entry); ok; ok = job.Process32NextW(snap, entry)) {
      if (entry.th32ParentProcessID === process.pid && String(entry.szExeFile).toLowerCase() === exeName.toLowerCase()) {
        pids.push(entry.th32ProcessID)
      }
    }
  } finally {
    job.CloseHandle(snap)
  }
  return pids
}

let jobHandle: any = null

function getJob(job: NonNullable<typeof jobBinding>): any {
  if (jobHandle) return jobHandle
  const h = job.CreateJobObjectW(null, null)
  if (!h) throw new Error('CreateJobObjectW failed')
  const info = { BasicLimitInformation: { LimitFlags: KILL_ON_JOB_CLOSE } }
  if (!job.SetInformationJobObject(h, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, job.koffi.sizeof(job.limitInfoType))) {
    job.CloseHandle(h)
    throw new Error('SetInformationJobObject failed')
  }
  jobHandle = h
  return h
}

/** Assigns matching children to the kill-on-close job. Logs each binding attempt. */
export function bindChildren(exeName: string): void {
  const job = getJobBinding()
  if (!job) return
  try {
    const pids = findChildPids(job, exeName)
    if (pids.length === 0) {
      log.warn(`No ${exeName} child found to bind to the app's lifetime`)
      return
    }
    const jobH = getJob(job)
    for (const pid of pids) {
      const h = job.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid)
      if (!h) {
        log.warn(`Could not open ${exeName} (pid ${pid}) to bind its lifetime`)
        continue
      }
      try {
        if (job.AssignProcessToJobObject(jobH, h)) {
          log.info(`${exeName} (pid ${pid}) will exit with the app`)
        } else {
          log.warn(`Could not bind ${exeName} (pid ${pid}) to the app's lifetime`)
        }
      } finally {
        job.CloseHandle(h)
      }
    }
  } catch (e) {
    log.warn(`Failed to bind ${exeName} to the app's lifetime:`, e)
  }
}

/**
 * Force-kills leftover children by PID. Falls back to killing by image name when the
 * process list is unavailable, which is the recovery path after a hard crash.
 */
export function killChildren(exeName: string): void {
  if (process.platform !== 'win32') return
  const job = getJobBinding()
  const targets = job
    ? findChildPids(job, exeName).map((pid) => `/PID ${pid}`)
    : [`/IM ${exeName}`]

  if (!job) log.warn(`Process list unavailable, killing every ${exeName} by name`)

  for (const t of targets) {
    try {
      execSync(`taskkill /F /T ${t}`, { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }
}

export const OBS_EXE = 'obs64.exe'