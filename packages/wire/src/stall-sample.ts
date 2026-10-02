/**
 * One bounded stall-time sample of the Wire daemon (#27089, @cto 666b47e8).
 * Reads /proc and the SQLite WAL; does not change daemon scheduling.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Socket } from "node:net"

export type StallSample = {
  sampledAtMs: number
  pid?: number
  unavailable?: string
  wchan?: string | null
  state?: string | null
  vmRssKb?: number | null
  vmSwapKb?: number | null
  ioReadBytes?: number | null
  ioReadBytesDelta?: number | null
  walBytes?: number | null
  dbPath?: string
  errors?: string[]
}

export type CollectStallSampleInput = {
  pid: number
  procRoot?: string
  dbPath?: string
  ioReadBytesAtStart?: number
  nowMs?: number
}

export type PeerPidResult = { ok: true; pid: number } | { ok: false; reason: string }

const SOL_SOCKET = 1
const SO_PEERCRED = 17
const SOL_LOCAL = 0
const LOCAL_PEERPID = 2

type GetsockoptSymbols = {
  getsockopt: (fd: number, level: number, name: number, value: unknown, length: unknown) => number
}

type FfiModule = {
  dlopen: (path: string, symbols: Record<string, unknown>) => { symbols: GetsockoptSymbols }
  FFIType: Record<string, unknown>
  ptr: (view: unknown) => unknown
}

let libc: { symbols: GetsockoptSymbols; ffi: FfiModule } | null | undefined

async function loadLibc(): Promise<{ symbols: GetsockoptSymbols; ffi: FfiModule } | null> {
  if (libc !== undefined) return libc
  if ((globalThis as { Bun?: unknown }).Bun === undefined) {
    libc = null
    return libc
  }
  try {
    const ffi = (await import("bun:ffi")) as unknown as FfiModule
    const library = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6"
    const { symbols } = ffi.dlopen(library, {
      getsockopt: {
        args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
    })
    libc = { symbols, ffi }
  } catch {
    libc = null
  }
  return libc
}

function socketFd(socket: Socket): number | null {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle
  const fd = handle?.fd
  if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0) return null
  return fd
}

/** Kernel peer pid of a connected unix socket. Refusal is loud; never invent a pid. */
export async function readPeerPid(socket: Socket): Promise<PeerPidResult> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return { ok: false, reason: `platform ${process.platform} has no unix-socket peer credential` }
  }
  const fd = socketFd(socket)
  if (fd === null) return { ok: false, reason: "socket exposes no file descriptor for SO_PEERCRED" }
  const loaded = await loadLibc()
  if (loaded === null) return { ok: false, reason: "libc getsockopt is unavailable in this runtime" }
  const darwin = process.platform === "darwin"
  const value = new Int32Array(darwin ? 1 : 3)
  const length = new Int32Array([value.byteLength])
  const rc = loaded.symbols.getsockopt(
    fd,
    darwin ? SOL_LOCAL : SOL_SOCKET,
    darwin ? LOCAL_PEERPID : SO_PEERCRED,
    loaded.ffi.ptr(value),
    loaded.ffi.ptr(length),
  )
  if (rc !== 0) return { ok: false, reason: `getsockopt for the peer pid failed on fd ${fd}` }
  const pid = value[0] ?? 0
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: `kernel reported an unusable peer pid (${pid})` }
  }
  return { ok: true, pid }
}

/** Read-only tribe.db path. Does not create directories or migrate. */
export function resolveDbPathReadonly(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRIBE_DB) return env.TRIBE_DB
  const xdgData = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local/share")
  return join(xdgData, "tribe", "tribe.db")
}

function readProcFile(
  procRoot: string,
  pid: number,
  name: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const path = join(procRoot, String(pid), name)
  try {
    return { ok: true, text: readFileSync(path, "utf8") }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "read-failed"
    return { ok: false, reason: `${name}: ${code}` }
  }
}

function parseKb(line: string | undefined): number | null {
  if (!line) return null
  const match = /(\d+)\s*kB/i.exec(line)
  if (!match) return null
  return Number(match[1])
}

function parseStatus(text: string): { state: string | null; vmRssKb: number | null; vmSwapKb: number | null } {
  let state: string | null = null
  let vmRssKb: number | null = null
  let vmSwapKb: number | null = null
  for (const raw of text.split("\n")) {
    if (raw.startsWith("State:")) {
      const rest = raw.slice("State:".length).trim()
      state = rest.charAt(0) || null
    } else if (raw.startsWith("VmRSS:")) {
      vmRssKb = parseKb(raw)
    } else if (raw.startsWith("VmSwap:")) {
      vmSwapKb = parseKb(raw)
    }
  }
  return { state, vmRssKb, vmSwapKb }
}

function parseReadBytes(text: string): number | null {
  for (const raw of text.split("\n")) {
    if (raw.startsWith("read_bytes:")) {
      const n = Number(raw.slice("read_bytes:".length).trim())
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

export function readIoReadBytes(pid: number, procRoot = "/proc"): number | null {
  const file = readProcFile(procRoot, pid, "io")
  if (!file.ok) return null
  return parseReadBytes(file.text)
}

export function collectStallSample(input: CollectStallSampleInput): StallSample {
  const procRoot = input.procRoot ?? "/proc"
  const dbPath = input.dbPath ?? resolveDbPathReadonly()
  const errors: string[] = []
  const wchanFile = readProcFile(procRoot, input.pid, "wchan")
  const statusFile = readProcFile(procRoot, input.pid, "status")
  const ioFile = readProcFile(procRoot, input.pid, "io")
  if (!wchanFile.ok) errors.push(wchanFile.reason)
  if (!statusFile.ok) errors.push(statusFile.reason)
  if (!ioFile.ok) errors.push(ioFile.reason)

  const status = statusFile.ok ? parseStatus(statusFile.text) : { state: null, vmRssKb: null, vmSwapKb: null }
  const ioReadBytes = ioFile.ok ? parseReadBytes(ioFile.text) : null
  let ioReadBytesDelta: number | null = null
  if (ioReadBytes !== null && input.ioReadBytesAtStart !== undefined) {
    ioReadBytesDelta = ioReadBytes - input.ioReadBytesAtStart
  }

  let walBytes: number | null = null
  if (!existsSync(dbPath)) {
    errors.push(`db missing: ${dbPath}`)
  } else if (!existsSync(`${dbPath}-wal`)) {
    walBytes = 0
  } else {
    try {
      walBytes = statSync(`${dbPath}-wal`).size
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "stat-failed"
      errors.push(`wal: ${code}`)
    }
  }

  return {
    sampledAtMs: input.nowMs ?? Date.now(),
    pid: input.pid,
    wchan: wchanFile.ok ? wchanFile.text.trim() || null : null,
    state: status.state,
    vmRssKb: status.vmRssKb,
    vmSwapKb: status.vmSwapKb,
    ioReadBytes,
    ioReadBytesDelta,
    walBytes,
    dbPath,
    ...(errors.length > 0 ? { errors } : {}),
  }
}

export async function sampleConnectedDaemon(
  socket: Socket,
  ioReadBytesAtStart?: number | null,
  procRoot = "/proc",
): Promise<StallSample> {
  const peer = await readPeerPid(socket)
  if (!peer.ok) {
    return { sampledAtMs: Date.now(), unavailable: peer.reason, errors: [peer.reason] }
  }
  return collectStallSample({
    pid: peer.pid,
    procRoot,
    ioReadBytesAtStart: ioReadBytesAtStart ?? undefined,
  })
}
