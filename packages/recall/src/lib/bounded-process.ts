/**
 * Internal captured-command boundary shared by Recall and the Tribe daemon.
 *
 * This file is deliberately absent from tribe-recall's public barrel and
 * package exports. Product policy stays in the adapters: Recall owns freshness
 * and warning copy; daemon health owns circuit breaking and unavailable reasons.
 */

import { readProcessStat } from "tribe-wire/lib/process-parent"

export type BoundedProcessCompletion =
  | { readonly state: "exited"; readonly evidence: "runtime" | "zombie" }
  | { readonly state: "running"; readonly evidence: "live" }
  | { readonly state: "unknown"; readonly evidence: "gone" | "recycled" | "unavailable"; readonly reason: string }

export type ReadBoundedProcessCompletion = () => BoundedProcessCompletion

export type BoundedProcessCommandResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export type BoundedProcessBounds = {
  /** Wall-clock execution deadline before process-tree settlement starts. */
  readonly timeoutMs: number
  /** Grace between process-tree SIGTERM and SIGKILL. */
  readonly killGraceMs: number
  /** Maximum wait for the direct child after SIGKILL. */
  readonly reapGraceMs: number
  /** Maximum wait for stdout/stderr EOF after direct-child exit. */
  readonly drainGraceMs: number
  /** Independent byte cap for each captured stream. */
  readonly maxOutputBytes: number
}

export type BoundedProcessInput = {
  /**
   * One payload handed to the child on stdin, then closed. Absent keeps every argv-only caller exactly as it was
   * (`stdin: "ignore"`). A caller that must pass a value the process table must never show -- an identity token --
   * writes it here, never in argv.
   */
  readonly stdin?: string
  /**
   * The child's environment. MEASURED 2026-10-14: `Bun.spawn` without this hands over the environment this process
   * STARTED with, not its current `process.env` — a variable set after start reaches the parent and not the child
   * (28921's spawned verifier read a stale habitat name because of it). Pass `{ ...process.env }` when the child must
   * see what the parent sees now.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Internal callers may observe completion, without taking ownership of the child or its streams. */
  readonly trackCompletion?: (read: ReadBoundedProcessCompletion) => void
}

export type BoundedProcessCommandFailure =
  | {
      readonly kind: "spawn-failed"
      readonly message: string
    }
  | {
      readonly kind: "timeout"
      readonly message: string
      readonly settlementFailures: readonly string[]
    }
  | {
      readonly kind: "output-too-large"
      readonly message: string
      readonly settlementFailures: readonly string[]
      readonly stream: "stderr" | "stdout"
    }
  | {
      readonly kind: "settlement-failed"
      readonly message: string
      readonly settlementFailures: readonly string[]
    }

export class BoundedProcessCommandError extends Error {
  readonly failure: BoundedProcessCommandFailure

  constructor(failure: BoundedProcessCommandFailure) {
    super(failure.message)
    this.name = "BoundedProcessCommandError"
    this.failure = failure
  }
}

type OutputFault =
  | { readonly kind: "output-too-large"; readonly stream: "stderr" | "stdout" }
  | { readonly error: unknown; readonly kind: "stream-failed"; readonly stream: "stderr" | "stdout" }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function commandLabel(argv: readonly string[]): string {
  return argv.map((arg) => JSON.stringify(arg)).join(" ")
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("bounded process " + name + " must be a positive integer")
  }
}

function validateRequest(argv: readonly string[], bounds: BoundedProcessBounds): void {
  if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    throw new TypeError("bounded process argv must contain at least one non-empty string")
  }
  positiveInteger(bounds.timeoutMs, "timeoutMs")
  positiveInteger(bounds.killGraceMs, "killGraceMs")
  positiveInteger(bounds.reapGraceMs, "reapGraceMs")
  positiveInteger(bounds.drainGraceMs, "drainGraceMs")
  positiveInteger(bounds.maxOutputBytes, "maxOutputBytes")
}

function spawnPiped(
  argv: readonly string[],
  stdin: "ignore" | "pipe",
  env: Readonly<Record<string, string | undefined>> | undefined,
) {
  try {
    return Bun.spawn([...argv], {
      detached: true,
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      ...(env === undefined ? {} : { env }),
    })
  } catch (error) {
    throw new BoundedProcessCommandError({
      kind: "spawn-failed",
      message: commandLabel(argv) + " could not start: " + describeError(error),
    })
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  streamName: "stderr" | "stdout",
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let cancelFailure: unknown
  const onAbort = () => {
    void reader.cancel().catch((error: unknown) => {
      cancelFailure = error
    })
  }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxOutputBytes) {
        await reader.cancel()
        throw new BoundedProcessCommandError({
          kind: "output-too-large",
          message: streamName + " exceeded " + maxOutputBytes + " bytes",
          settlementFailures: [],
          stream: streamName,
        })
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }

  if (cancelFailure !== undefined) {
    throw new Error(streamName + " cancellation failed: " + describeError(cancelFailure))
  }
  if (chunks.length === 0) return ""
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
}

function isPosixProcessGroupPlatform(): boolean {
  return process.platform !== "win32"
}

/**
 * Run one captured command with finite execution, termination, reap, output,
 * and post-exit drain bounds.
 */
export async function runBoundedProcessCommand(
  argv: readonly string[],
  bounds: BoundedProcessBounds,
  input: BoundedProcessInput = {},
): Promise<BoundedProcessCommandResult> {
  validateRequest(argv, bounds)
  const child = spawnPiped(argv, input.stdin === undefined ? "ignore" : "pipe", input.env)
  const label = commandLabel(argv)
  const settlementFailures: string[] = []
  let usedSigkill = false
  if (input.stdin !== undefined && child.stdin !== undefined) {
    // Closed, never awaited: a child that stops reading must be settled by the bounds below, not by this write.
    try {
      void child.stdin.write(input.stdin)
      void child.stdin.end()
    } catch (error: unknown) {
      settlementFailures.push(
        "stdin payload was not delivered (" +
          describeError(error) +
          "); the child may have read a partial request or none",
      )
    }
  }

  const signalTree = (signal: "SIGKILL" | "SIGTERM"): void => {
    let groupReached = false
    if (isPosixProcessGroupPlatform()) {
      try {
        process.kill(-child.pid, signal)
        groupReached = true
      } catch (error) {
        if (errorCode(error) !== "ESRCH") {
          settlementFailures.push(
            "process-group " +
              signal +
              " failed (" +
              (errorCode(error) ?? describeError(error)) +
              "); descendants may survive pgid " +
              child.pid,
          )
        }
      }
    } else {
      settlementFailures.push(
        "process-group settlement is unavailable on " + process.platform + "; descendants may survive pid " + child.pid,
      )
    }
    if (groupReached) return
    try {
      child.kill(signal)
    } catch (error) {
      if (errorCode(error) !== "ESRCH") {
        settlementFailures.push(
          "direct-child " +
            signal +
            " failed (" +
            (errorCode(error) ?? describeError(error)) +
            ") for pid " +
            child.pid,
        )
      }
    }
  }

  let termination: Promise<void> | undefined
  const terminate = (): Promise<void> => {
    if (termination !== undefined) return termination
    termination = (async () => {
      signalTree("SIGTERM")
      await delay(bounds.killGraceMs)
      usedSigkill = true
      signalTree("SIGKILL")
      const reaped = await Promise.race([child.exited.then(() => true), delay(bounds.reapGraceMs).then(() => false)])
      if (!reaped) {
        settlementFailures.push(
          "direct child did not exit within " +
            bounds.reapGraceMs +
            "ms after SIGKILL; pid " +
            child.pid +
            " may survive",
        )
      }
    })()
    return termination
  }

  const drainAbort = new AbortController()
  const outputFault = Promise.withResolvers<OutputFault>()
  let reportedFault: OutputFault | undefined
  const capture = async (stream: ReadableStream<Uint8Array>, streamName: "stderr" | "stdout"): Promise<string> => {
    try {
      return await readBounded(stream, streamName, bounds.maxOutputBytes, drainAbort.signal)
    } catch (error) {
      if (reportedFault === undefined) {
        if (error instanceof BoundedProcessCommandError && error.failure.kind === "output-too-large") {
          reportedFault = { kind: "output-too-large", stream: streamName }
        } else {
          reportedFault = { error, kind: "stream-failed", stream: streamName }
        }
        outputFault.resolve(reportedFault)
      }
      return ""
    }
  }
  const capturesDone = Promise.all([capture(child.stdout, "stdout"), capture(child.stderr, "stderr")])

  const timeout = Promise.withResolvers<{ readonly kind: "timeout" }>()
  const timeoutTimer = setTimeout(() => timeout.resolve({ kind: "timeout" }), bounds.timeoutMs)
  ;(timeoutTimer as { unref?: () => void }).unref?.()
  if (input.trackCompletion !== undefined) {
    const birth = readProcessStat(child.pid)
    const readCompletion: ReadBoundedProcessCompletion = () => {
      if (child.exitCode !== null || child.signalCode !== null) return { state: "exited", evidence: "runtime" }
      if (!("fields" in birth) || birth.fields.startTime === null || !/^\d+$/u.test(birth.fields.startTime)) {
        return {
          state: "unknown",
          evidence: "unavailable",
          reason:
            "cannot bind child birth: " +
            ("reason" in birth ? birth.reason : `/proc/${child.pid}/stat has no start time`),
        }
      }
      const current = readProcessStat(child.pid)
      if (!("fields" in current)) {
        return { state: "unknown", evidence: current.kind, reason: current.reason }
      }
      if (current.fields.startTime !== birth.fields.startTime) {
        return { state: "unknown", evidence: "recycled", reason: `/proc/${child.pid}/stat start time changed` }
      }
      return current.kind === "zombie"
        ? { state: "exited", evidence: "zombie" }
        : { state: "running", evidence: "live" }
    }
    try {
      input.trackCompletion(readCompletion)
    } catch (error) {
      clearTimeout(timeoutTimer)
      await terminate()
      drainAbort.abort()
      await capturesDone
      throw new BoundedProcessCommandError({
        kind: "settlement-failed",
        message: label + " completion observer setup failed: " + describeError(error),
        settlementFailures,
      })
    }
  }
  const first = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, kind: "exit" as const })),
    timeout.promise,
    outputFault.promise,
  ])
  clearTimeout(timeoutTimer)

  const drain = async (): Promise<readonly [string, string] | null> => {
    const result = await Promise.race([
      capturesDone.then((captured) => ({ captured, kind: "captured" as const })),
      delay(bounds.drainGraceMs).then(() => ({ kind: "expired" as const })),
    ])
    if (result.kind === "captured") return result.captured
    signalTree("SIGKILL")
    drainAbort.abort()
    await capturesDone
    return null
  }

  if ("exitCode" in first) {
    const captured = await drain()
    if (captured === null) {
      const message =
        label +
        " exited " +
        first.exitCode +
        ", but a descendant kept stdout/stderr open beyond " +
        bounds.drainGraceMs +
        "ms; sent SIGKILL to process group " +
        child.pid
      throw new BoundedProcessCommandError({
        kind: "settlement-failed",
        message: settlementFailures.length === 0 ? message : message + "; " + settlementFailures.join("; "),
        settlementFailures,
      })
    }
    if (reportedFault?.kind === "output-too-large") {
      throw new BoundedProcessCommandError({
        kind: "output-too-large",
        message: reportedFault.stream + " exceeded " + bounds.maxOutputBytes + " bytes for " + label + " before exit",
        settlementFailures,
        stream: reportedFault.stream,
      })
    }
    if (reportedFault?.kind === "stream-failed") {
      throw new BoundedProcessCommandError({
        kind: "settlement-failed",
        message: reportedFault.stream + " capture failed for " + label + ": " + describeError(reportedFault.error),
        settlementFailures,
      })
    }
    return { exitCode: first.exitCode, stdout: captured[0], stderr: captured[1] }
  }

  await terminate()
  const captured = await drain()
  if (captured === null) {
    settlementFailures.push("stdout/stderr did not close within " + bounds.drainGraceMs + "ms after termination")
  }

  if (first.kind === "timeout") {
    const message =
      label +
      " exceeded " +
      bounds.timeoutMs +
      "ms; sent SIGTERM" +
      (usedSigkill ? " then SIGKILL after " + bounds.killGraceMs + "ms" : "") +
      (settlementFailures.length === 0 ? "" : "; settlement uncertain: " + settlementFailures.join("; "))
    throw new BoundedProcessCommandError({
      kind: "timeout",
      message,
      settlementFailures,
    })
  }

  if (first.kind === "output-too-large") {
    const message =
      first.stream +
      " exceeded " +
      bounds.maxOutputBytes +
      " bytes for " +
      label +
      "; sent SIGTERM" +
      (usedSigkill ? " then SIGKILL after " + bounds.killGraceMs + "ms" : "") +
      (settlementFailures.length === 0 ? "" : "; settlement uncertain: " + settlementFailures.join("; "))
    throw new BoundedProcessCommandError({
      kind: "output-too-large",
      message,
      settlementFailures,
      stream: first.stream,
    })
  }

  const message =
    first.stream +
    " capture failed for " +
    label +
    ": " +
    describeError(first.error) +
    (settlementFailures.length === 0 ? "" : "; settlement uncertain: " + settlementFailures.join("; "))
  throw new BoundedProcessCommandError({
    kind: "settlement-failed",
    message,
    settlementFailures,
  })
}
