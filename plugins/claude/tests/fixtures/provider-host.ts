/**
 * A fake provider host for the 29567 seat-ancestry rows. It starts the plugin supervisor as its own direct child, the
 * way claude, codex and agy start their MCP servers, holds the supervisor's stdin open as a provider does, and reports
 * on stdout, one JSON line each: itself (`host`), every supervisor it started (`spawned`), each supervisor stderr line
 * (`stderr`) and each supervisor exit (`exit`).
 *
 * argv: <server.ts>. Env:
 * - FIXTURE_SUPERVISORS=2 starts a second supervisor once the first has claimed the launch: a gap-5 respawn under one
 *   provider.
 * - FIXTURE_DECLARE_PARENT=1 declares this host's own parent as the launch's harness, as `ag code` declares itself.
 * - FIXTURE_CLAIM_PATH names the claim file the second supervisor waits on.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV } from "tribe-wire/lib/session-identity-env"

const server = process.argv[2]
if (server === undefined) throw new Error("provider-host fixture: argv[2] must name the supervisor's server.ts")
const env: NodeJS.ProcessEnv = { ...process.env }
if (process.env.FIXTURE_DECLARE_PARENT === "1") env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV] = String(process.ppid)
const report = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`)

function start(): ChildProcess {
  const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "ignore", "pipe"] })
  const pid = child.pid
  report({ event: "spawned", pid })
  let pending = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) report({ event: "stderr", pid, line })
  })
  child.on("exit", (code, signal) => report({ event: "exit", pid, code, signal }))
  return child
}

report({ event: "host", pid: process.pid, ppid: process.ppid })
const first = start()
const claimPath = process.env.FIXTURE_CLAIM_PATH
if (process.env.FIXTURE_SUPERVISORS === "2") {
  if (claimPath === undefined) throw new Error("provider-host fixture: FIXTURE_SUPERVISORS=2 needs FIXTURE_CLAIM_PATH")
  const wait = setInterval(() => {
    if (!existsSync(claimPath)) return
    try {
      if ((JSON.parse(readFileSync(claimPath, "utf8")) as { pid?: unknown }).pid !== first.pid) return
    } catch {
      return // a claim mid-write is read again on the next tick
    }
    clearInterval(wait)
    start()
  }, 20)
}
// A provider outlives its MCP servers; the test kills this host's process group.
setInterval(() => {}, 1 << 30)
