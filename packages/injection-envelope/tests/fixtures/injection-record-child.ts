/**
 * Fixture child for `record-bound-concurrent.test.ts`: one REAL second hook process on the shared record.
 *
 * It installs the production writer on the path it is handed, says `ready`, and then acts only on stdin
 * commands, so the parent controls exactly when this process appends:
 *
 *   emit <chars>  — emit one row carrying that many characters, flush, then answer `written`
 *   exit          — leave
 *
 * It is a fixture, not a test: no assertions live here, and nothing outside the fixture directory uses it.
 * `@testonly` is claimed by the test that spawns it.
 */

import { createInterface } from "node:readline"
import { setLogLevel, setSuppressConsole } from "loggily"
import { emitInjectionDebugEvent, flushInjectionFileWriters, installInjectionFileWriter } from "../../src/debug.ts"

const path = process.argv[2]
if (path === undefined) throw new Error("usage: injection-record-child.ts <record-path>")

// A stray loggily console line would corrupt the line protocol the parent reads.
setSuppressConsole(true)
// The record's sink IS a loggily writer, so the level decides whether a row reaches it at all: an ambient
// LOG_LEVEL could otherwise leave this fixture silently inert and the schedule below unobservable.
setLogLevel("info")
installInjectionFileWriter(path)

process.stdout.write("ready\n")

const commands = createInterface({ input: process.stdin })
commands.on("line", (line) => {
  const [command, argument] = line.trim().split(" ")
  if (command === "emit") {
    const chars = Number(argument)
    if (!Number.isSafeInteger(chars) || chars < 0) throw new Error(`bad emit width: ${String(argument)}`)
    emitInjectionDebugEvent({
      source: "recall",
      action: "skip",
      reason: "child-row",
      additionalContext: "x".repeat(chars),
    })
    flushInjectionFileWriters()
    process.stdout.write("written\n")
    return
  }
  if (command === "exit") process.exit(0)
  throw new Error(`unknown fixture command: ${line}`)
})
