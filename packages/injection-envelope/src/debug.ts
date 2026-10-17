/**
 * Observability for envelope emission, routed through loggily.
 *
 * Every hook decision (emit / skip / empty / error) flows into the
 * `injection:*` namespace tree:
 * - `injection:wrap`  — successful framed-envelope emission (action="emit")
 * - `injection:skip`  — caller decided not to inject (action="skip" / "empty" / "error")
 *
 * Output discipline — file only, never stderr:
 *
 *   The loggers are constructed with an empty config array (`[]`), which
 *   strips the default `console` sink. This is load-bearing: when a
 *   UserPromptSubmit hook writes anything to stderr, Claude Code captures
 *   that text and surfaces it to the model in the next turn as
 *
 *       <system-reminder>UserPromptSubmit hook success: <stderr></system-reminder>
 *
 *   A transcript-shaped stderr line (loggily's default `HH:MM:SS LEVEL ns
 *   ...` format qualifies) inside that envelope has triggered the
 *   autocatalytic role-prefix hallucination — the model emits
 *   `Human: <system-reminder>...` as a transcript continuation. See
 *   - upstream issue: https://github.com/anthropics/claude-code/issues/50972
 *   - km feedback memory: feedback-autocatalytic-hallucination.md
 *   - 85 violations recorded in 9h on 2026-05-09 motivating this fix.
 *
 *   Therefore: this module never writes to `process.stderr` or
 *   `process.stdout`, even on the error path. All emissions go to a JSONL
 *   file. If the file-writer install fails, we try a /tmp fallback; if
 *   that fails too we drop silently — the cure (echoing into the prompt)
 *   is worse than the disease (a missed debug line).
 *
 * Default output location: `~/.local/share/bearly/injection.jsonl`. Override
 * via `INJECTION_DEBUG_LOG=/path` or the unified `LOGGILY_FILE`. Browse via
 * `tail -f` or the (planned) `bearly inject status` CLI.
 *
 * Bound and fields (29681, @cto ruling centralized-logging-fates-2026-10-16):
 *
 *   This file is a RECORD, not a log: `packages/daemon/src/lib/hook-latency-reader.ts`
 *   reads it back, and its parser takes only `recall:hook:prompt` rows, using
 *   `ts`, `pid`, `msg` and the props it needs. So the writer keeps the live
 *   file plus one previous segment, at most 64 MiB together — it rotates at
 *   32 MiB into `<path>.1`, which the next rotation replaces — and writes only
 *   the fields a reader uses. `producer` (one constant, and the file's own path
 *   already names the writer) and `level` (which nothing reads) are gone: they
 *   were about an eighth of every row when the bound landed.
 *
 *   The reader is the other half of that contract and reads BOTH segments, the
 *   previous one first, so a rotation landing inside its hour cannot hide the
 *   side of the window it moved.
 *
 *   Every writer of this record is a separate hook process. Until 29681 two of
 *   them could each approve a row that fit alone while neither saw the other's:
 *   the occupancy check and the append were separate operations. The writers now
 *   exclude each other with a kernel flock on `<path>.lock`, held across
 *   measure, append and flush — so the file's size IS the occupancy and the
 *   64 MiB pair bound holds instead of approximating. A writer that cannot take
 *   the lock says so loudly and still records its row.
 */

import { mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { acquireFlockBlocking, type FlockHandle } from "@bearly/flock"
import { addWriter, createFileWriter, createLogger, type Event } from "loggily"

/**
 * Bytes of live record before it rotates into the previous segment. Two segments is the ruling's ceiling of 64 MiB,
 * and at the record's measured growth (~4 KiB/min) one segment spans days, so a cut is rare and the previous segment
 * is history a reader only needs at the seam. The reader reads both segments anyway: `hook-latency-reader.ts` reads
 * the previous one alongside the live one, so a rotation never hides a window that straddles it.
 */
const RECORD_SEGMENT_MAX_BYTES = 32 * 1024 * 1024

/**
 * The record's exclusion, as one spelling: a sibling lock file no reader opens, taken by a writer for the whole
 * measure-then-append window. Exported so a writer, a probe and a test agree on one path instead of retyping it.
 */
export function injectionRecordLockPath(path: string): string {
  return `${path}.lock`
}

/**
 * The one previous segment. The next rotation replaces it, so there is never a `.2`.
 *
 * Exported because the seam has exactly one spelling and the READER is the other half of it: the daemon's
 * `packages/daemon/src/lib/hook-latency-reader.ts` reads the previous segment with the live one, so it imports this
 * suffix rather than spelling ".1" a second time. Two packages, one rotation contract.
 */
export const RECORD_PREVIOUS_SEGMENT_SUFFIX = ".1"

/**
 * Bytes already in the live segment at `path`. Only a genuinely absent file is the empty-file case: an occupancy this
 * process cannot read is named on stderr and reported as the full segment, so the next append rotates rather than
 * growing a record nobody can measure. Reading a failed stat as 0 would reset the accounting against a file that is
 * already past the ceiling, which is how the record grew to 252 MB in the first place.
 */
function recordBytesOnDisk(path: string): number {
  try {
    return statSync(path).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      // A record that does not exist yet holds zero bytes — the writer creates it on its first write.
      // silent-fallback-allow: absent file, not a masked failure (any other stat error is raised loudly below)
      return 0
    }
    console.error(
      `injection-envelope: could not measure the debug log ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return RECORD_SEGMENT_MAX_BYTES
  }
}

export interface InjectionDebugEvent {
  /** Upstream emitter identity — which logical source produced this (recall, tribe, telegram, …). */
  source: string
  /** Claude Code session id, if available. */
  sessionId?: string
  /** What decision did the emitter make. */
  action: "emit" | "skip" | "empty" | "error"
  /**
   * Which Claude Code hook event triggered this emission, if known
   * (UserPromptSubmit / PreToolUse / SessionStart / …). Helps attribute
   * a record to the hook that fired it without inferring from context.
   */
  hookEvent?: string
  /** First ~200 chars of the triggering user prompt, for correlation. */
  prompt?: string
  /** Why skipped / why empty / what failed — free-form string. */
  reason?: string
  /** Number of items (snippets/pointers) in the envelope. */
  itemCount?: number
  /** Total chars of the emitted additionalContext. */
  chars?: number
  /** The full emitted additionalContext — so users can see exactly what the model gets. */
  additionalContext?: string
  /** Error details when `action="error"` (e.g. file write failure summary). Never echoed to stderr. */
  errorMessage?: string
}

// NOTE on muzzling: these loggers are constructed without an explicit
// config array so that legacy `addWriter({ ns: "injection:*" }, fn)`
// subscribers still receive events through loggily's env-pipeline.
//
// Suppressing the console output (the load-bearing change for the
// stderr-echo bug) happens at the *hook entry point* via
// `setSuppressConsole(true)` — see `vendor/bearly/tools/lib/tribe/hook-dispatch.ts`.
// Doing it there muzzles all loggily output for the lifetime of the hook
// process while keeping `addWriter` subscribers wired up.
const wrapLog = createLogger("injection:wrap")
const skipLog = createLogger("injection:skip")

const _installedPaths = new Set<string>()
const _installedWriters = new Map<{ flush(): void }, string>()

/**
 * Flush all active injection file writers synchronously to disk. A writer that cannot flush is named on stderr and the
 * rest still flush: the caller flushes so a record survives a kill (25304), and a lost record must not be silent.
 */
export function flushInjectionFileWriters(): void {
  for (const [writer, path] of _installedWriters) {
    try {
      writer.flush()
    } catch (error) {
      console.error(
        `injection-envelope: could not flush the debug log ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Pipe `injection:*`, `recall:*`, and `tribe:*` events to a JSONL file
 * at `path`. Idempotent per path (calling twice is a no-op). Returns the
 * unsubscribe handle from loggily so callers can detach the writer if
 * needed.
 *
 * Why these three namespaces: every loggily logger in the bearly hook
 * code path lives under one of them. Capturing all three at the hook's
 * file writer install gives a single tail-able trail without each
 * subsystem having to know about the file location. The records carry
 * their own `namespace` field so attribution stays per-subsystem.
 *
 * The directory is created on demand (`mkdir -p`) so the default user
 * path (`~/.local/share/bearly/`) doesn't need to exist beforehand.
 */
export function installInjectionFileWriter(path: string): () => void {
  if (_installedPaths.has(path)) return () => {}
  _installedPaths.add(path)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // mkdir failure is recoverable if the dir already exists with the
    // right perms; let createFileWriter surface the real error.
  }
  let writer = createFileWriter(path)
  _installedWriters.set(writer, path)

  /**
   * Rename the live record aside as its one previous segment, and open a fresh one. Loud on failure: a record
   * that did not rotate is unbounded, and that must never be silent. The row being appended is unaffected —
   * it lands in the fresh segment.
   */
  const rotate = (): void => {
    const replaced = writer
    try {
      replaced.close()
      // Renaming over an existing previous segment keeps exactly one of them.
      renameSync(path, path + RECORD_PREVIOUS_SEGMENT_SUFFIX)
      writer = createFileWriter(path)
      _installedWriters.delete(replaced)
      _installedWriters.set(writer, path)
    } catch (error) {
      console.error(
        `injection-envelope: could not rotate the debug log ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        writer = createFileWriter(path)
        _installedWriters.delete(replaced)
        _installedWriters.set(writer, path)
      } catch (reopenError) {
        console.error(
          `injection-envelope: could not reopen the debug log ${path}: ${reopenError instanceof Error ? reopenError.message : String(reopenError)}`,
        )
      }
    }
  }

  /**
   * Append one row with the record lock held, so the whole measure-then-append window is exclusive.
   *
   * The lock is the contract, not a nicety. Two hook processes appending at once each measured the same live
   * length before either had written, so both approved a row that fit alone and the pair landed past the
   * ruling's ceiling (@dev/review2's r3 counterexample: M=32 MiB, previous=M−R, live=M−R−L, both approve their
   * L-byte row, pair = 64 MiB + 896 KiB). No margin below the ceiling can bound that — the window it must
   * cover is another writer's whole row. Holding the flock across measure, append and flush makes the file's
   * size the entire occupancy: every writer's rows are on disk before it releases, so a peer's row cannot land
   * between this writer's measurement and its append.
   */
  const appendRow = (line: string, lineBytes: number): void => {
    let lock: FlockHandle | undefined
    try {
      lock = acquireFlockBlocking(injectionRecordLockPath(path))
    } catch (error) {
      // Loud, and the row is still recorded: a filesystem without flock must not become a missing record.
      // The bound rests on this lock, so a writer that could not take it says so rather than writing silently.
      console.error(
        `injection-envelope: could not take the record lock ${injectionRecordLockPath(path)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      let occupancyKnown = true
      try {
        // Normally nothing of ours is pending — every row is flushed before its lock is released. This repair
        // matters after a failed flush: bytes this process wrote but cannot see must not read as an empty segment.
        writer.flush()
      } catch (error) {
        occupancyKnown = false
        console.error(
          `injection-envelope: could not flush before measuring the debug log ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const segmentBytes = occupancyKnown ? recordBytesOnDisk(path) : RECORD_SEGMENT_MAX_BYTES
      if (segmentBytes + lineBytes > RECORD_SEGMENT_MAX_BYTES) rotate()
      writer.write(line)
      try {
        // On disk before the lock is released, so the next writer's measurement includes this row.
        writer.flush()
      } catch (error) {
        console.error(
          `injection-envelope: could not flush the debug log ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      lock?.release()
    }
  }

  const sink = (_formatted: string, _level: string, _ns: string, event: Event): void => {
    // Span events flow past too — we only persist log records.
    if (event.kind !== "log") return
    const line = JSON.stringify({
      ts: new Date(event.time).toISOString(),
      pid: process.pid,
      namespace: event.namespace,
      msg: event.message,
      ...event.props,
    })
    // Bytes, not characters: loggily writes the row as UTF-8 plus its own newline, so `line.length` (UTF-16 units)
    // under-counts a non-ASCII row by up to half and would let the two segments pass their byte ceiling while
    // claiming to be under it.
    appendRow(line, Buffer.byteLength(line, "utf8") + 1)
  }
  // Three independent subscriptions — addWriter's ns filter is OR-only,
  // so we register once per top-level namespace tree. The unsubscribe
  // handles are merged into one for the caller's convenience.
  const unsubs = [
    addWriter({ ns: "injection:*" }, sink),
    addWriter({ ns: "recall:*" }, sink),
    addWriter({ ns: "tribe:*" }, sink),
  ]
  return () => {
    _installedWriters.delete(writer)
    for (const u of unsubs) u()
  }
}

let _envChecked = false
function ensureFileWriter(): void {
  if (_envChecked) return
  _envChecked = true
  // Priority: explicit env var > LOGGILY_FILE > per-user default.
  // The default path keeps observability on without requiring opt-in env
  // vars, while staying off stderr (which Claude Code captures into the
  // prompt as a system-reminder).
  const primaryPath =
    process.env.INJECTION_DEBUG_LOG ??
    process.env.LOGGILY_FILE ??
    join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  try {
    installInjectionFileWriter(primaryPath)
    return
  } catch {
    // Fall through to /tmp fallback below.
  }
  try {
    installInjectionFileWriter(join("/tmp", `bearly-injection-${process.pid}.jsonl`))
  } catch {
    // Both writers failed — drop silently. Never write to stderr; the
    // upstream stderr-echo bug makes that worse than missed observability.
  }
}

export function emitInjectionDebugEvent(event: InjectionDebugEvent): void {
  ensureFileWriter()
  const log = event.action === "emit" ? wrapLog : skipLog
  log.info?.(event.action, { ...event })
}
