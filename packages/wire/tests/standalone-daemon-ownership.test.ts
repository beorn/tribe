/**
 * @failure A short-lived client or reloading standalone daemon leaves the
 *          resident Tribe daemon reparented to init instead of one stable
 *          lifecycle owner.
 * @level   l4
 * @consumer @ag/tribe/22322-daemon-restart-drops-bridges-with-no-repair-verb
 *
 * Production safety: the helper, daemon generations, socket, database, and
 * logs are all isolated under one fresh temp directory. Cleanup only signals
 * PIDs observed through that socket and their non-init parent.
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon, type DaemonClient } from "../src/client.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = resolve(HERE, "../src/client.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function parentPid(pid: number): number {
  return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim())
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function terminate(pid: number): Promise<void> {
  if (pid <= 1 || !pidExists(pid)) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  try {
    await waitFor(() => !pidExists(pid), `process ${pid} exit`, 2_000)
    return
  } catch {
    if (!pidExists(pid)) return
  }
  process.kill(pid, "SIGKILL")
  await waitFor(() => !pidExists(pid), `process ${pid} forced exit`, 2_000)
}

async function connectToGeneration(
  socketPath: string,
  predicate: (pid: number) => boolean = () => true,
): Promise<{ client: DaemonClient; pid: number }> {
  let lastError: unknown
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    let client: DaemonClient | undefined
    try {
      client = await connectToDaemon(socketPath, { callTimeoutMs: 1_000 })
      const status = (await client.call("cli_daemon")) as { pid: number }
      if (predicate(status.pid)) return { client, pid: status.pid }
      client.close()
    } catch (error) {
      lastError = error
      client?.close()
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
  throw new Error(`timed out connecting to expected daemon generation: ${String(lastError)}`)
}

describe("standalone daemon lifecycle ownership", () => {
  let tmpDir: string
  let socketPath: string
  const daemonPids = new Set<number>()
  const ownerPids = new Set<number>()

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-standalone-owner-"))
    socketPath = join(tmpDir, "tribe.sock")
  })

  afterEach(async () => {
    if (existsSync(socketPath)) {
      try {
        const current = await connectToDaemon(socketPath, { callTimeoutMs: 500 })
        const status = (await current.call("cli_daemon")) as { pid?: number }
        if (typeof status.pid === "number") {
          daemonPids.add(status.pid)
          const ppid = parentPid(status.pid)
          if (ppid > 1) ownerPids.add(ppid)
        }
        current.close()
      } catch {
        /* no reachable daemon remains */
      }
    }
    for (const pid of daemonPids) await terminate(pid)
    for (const pid of ownerPids) await terminate(pid)
    daemonPids.clear()
    ownerPids.clear()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps initial startup and manual reload under one stable owner after the client exits", async () => {
    const dbPath = join(tmpDir, "tribe.db")
    const daemonLog = join(tmpDir, "daemon.log")
    const daemonEnvLog = join(tmpDir, "daemon-env.jsonl")
    const daemonWrapper = join(tmpDir, "daemon-wrapper.ts")
    const pidPath = join(tmpDir, "initial-daemon.json")
    const starter = join(tmpDir, "starter.ts")
    writeFileSync(
      daemonWrapper,
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(daemonEnvLog)}, JSON.stringify({
  account: process.env.TRIBE_ACCOUNT ?? null,
  launchId: process.env.TRIBE_LAUNCH_ID ?? null,
  name: process.env.TRIBE_NAME ?? null,
  providerParentPid: process.env.TRIBE_PLUGIN_PROVIDER_PARENT_PID ?? null,
  reloadExitCode: process.env.TRIBE_DAEMON_RELOAD_EXIT_CODE ?? null,
  supervisorPid: process.env.TRIBE_DAEMON_SUPERVISOR_PID ?? null,
}) + "\\n")
await import(${JSON.stringify(pathToFileURL(DAEMON).href)})
`,
    )
    writeFileSync(
      starter,
      `import { writeFileSync } from "node:fs"
import { connectOrStart } from ${JSON.stringify(pathToFileURL(CLIENT).href)}
const client = await connectOrStart(${JSON.stringify(socketPath)}, {
  daemonScript: ${JSON.stringify(daemonWrapper)},
  daemonArgs: ["--db", ${JSON.stringify(dbPath)}, "--foreground", "--no-lore"],
  maxStartupAttempts: 20,
})
const status = await client.call("cli_daemon")
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify(status))
client.close()
`,
    )

    const env = { ...process.env }
    for (const key of [
      "HAB_SERVICE_KIND",
      "TRIBE_ACCOUNT",
      "TRIBE_DAEMON_SCRIPT",
      "TRIBE_DOMAINS",
      "TRIBE_LAUNCH_ID",
      "TRIBE_NAME",
      "TRIBE_OPERATOR_CAPABILITY",
      "TRIBE_OPERATOR_CAPABILITY_FD",
      "TRIBE_PLUGIN_ADAPTER_CHILD",
      "TRIBE_PLUGIN_PROVIDER_PARENT_PID",
      "TRIBE_PLUGIN_REEXEC_EXIT_CODE",
      "TRIBE_PROVIDER",
      "TRIBE_ROLE",
      "TRIBE_SLA_ROLE",
      "TRIBE_TAKEOVER",
    ]) {
      delete env[key]
    }
    Object.assign(env, {
      DEBUG_LOG: daemonLog,
      TRIBE_ACCOUNT: "must-not-leak@example.test",
      TRIBE_LAUNCH_ID: "must-not-leak-launch",
      TRIBE_NAME: "@seat/must-not-leak",
      LOG_FILE: daemonLog,
      TRIBE_NO_AUTORELOAD: "1",
      TRIBE_NO_PLUGINS: "1",
      TRIBE_PLUGIN_PROVIDER_PARENT_PID: "424242",
    })

    const helper = spawn(BUN_BIN, [starter], {
      cwd: tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let helperStdout = ""
    let helperStderr = ""
    helper.stdout.on("data", (chunk: Buffer | string) => {
      helperStdout += chunk.toString()
    })
    helper.stderr.on("data", (chunk: Buffer | string) => {
      helperStderr += chunk.toString()
    })
    const helperExit = await new Promise<number | null>((resolveExit) => helper.once("exit", resolveExit))
    expect(helperExit, `${helperStdout}\n${helperStderr}`).toBe(0)

    const initialStatus = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number }
    const firstPid = initialStatus.pid
    daemonPids.add(firstPid)
    const ownerPid = parentPid(firstPid)
    if (ownerPid > 1) ownerPids.add(ownerPid)

    expect.soft(ownerPid, "client exit must not orphan the daemon under init").not.toBe(1)
    expect.soft(ownerPid, "the short-lived starter must not remain the daemon owner").not.toBe(helper.pid)
    const initialEnv = JSON.parse(readFileSync(daemonEnvLog, "utf8").trim().split("\n")[0]!) as Record<
      string,
      string | null
    >
    expect.soft(initialEnv).toMatchObject({
      account: null,
      launchId: null,
      name: null,
      providerParentPid: null,
      supervisorPid: String(ownerPid),
    })

    const first = await connectToGeneration(socketPath, (pid) => pid === firstPid)
    await first.client.call("tribe.reload", { reason: "22322 lifecycle-owner acceptance" })
    first.client.close()

    const successor = await connectToGeneration(socketPath, (pid) => pid !== firstPid)
    daemonPids.add(successor.pid)
    await waitFor(() => !pidExists(firstPid), "predecessor daemon exit")
    const successorOwnerPid = parentPid(successor.pid)
    if (successorOwnerPid > 1) ownerPids.add(successorOwnerPid)

    expect.soft(successorOwnerPid, "manual reload must not orphan the successor under init").not.toBe(1)
    expect(successorOwnerPid, "manual reload must preserve the original lifecycle owner").toBe(ownerPid)
    const successorEnv = JSON.parse(readFileSync(daemonEnvLog, "utf8").trim().split("\n")[1]!) as Record<
      string,
      string | null
    >
    expect(successorEnv).toMatchObject({
      account: null,
      launchId: null,
      name: null,
      providerParentPid: null,
      reloadExitCode: expect.stringMatching(/^\d+$/u),
      supervisorPid: String(ownerPid),
    })
    successor.client.close()

    await terminate(successor.pid)
    daemonPids.delete(successor.pid)
    await waitFor(() => !pidExists(ownerPid), "standalone owner exit after clean daemon shutdown")
    ownerPids.delete(ownerPid)
  }, 30_000)

  it("adopts a directly launched daemon before replacing it", async () => {
    const dbPath = join(tmpDir, "direct.db")
    const daemonEnvLog = join(tmpDir, "direct-env.jsonl")
    const daemonWrapper = join(tmpDir, "direct-daemon-wrapper.ts")
    writeFileSync(
      daemonWrapper,
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(daemonEnvLog)}, JSON.stringify({
  reloadExitCode: process.env.TRIBE_DAEMON_RELOAD_EXIT_CODE ?? null,
  supervisorPid: process.env.TRIBE_DAEMON_SUPERVISOR_PID ?? null,
}) + "\\n")
await import(${JSON.stringify(pathToFileURL(DAEMON).href)})
`,
    )
    const env = { ...process.env }
    delete env.HAB_SERVICE_KIND
    delete env.TRIBE_DAEMON_RELOAD_EXIT_CODE
    delete env.TRIBE_DAEMON_SUPERVISOR_PID
    delete env.TRIBE_OPERATOR_CAPABILITY
    delete env.TRIBE_OPERATOR_CAPABILITY_FD
    Object.assign(env, {
      TRIBE_NO_AUTORELOAD: "1",
      TRIBE_NO_PLUGINS: "1",
    })

    const direct = spawn(
      BUN_BIN,
      [daemonWrapper, "--socket", socketPath, "--db", dbPath, "--foreground", "--no-lore"],
      {
        cwd: tmpDir,
        env,
        stdio: "ignore",
      },
    )
    expect(direct.pid).toBeTypeOf("number")
    daemonPids.add(direct.pid!)
    await waitFor(() => existsSync(socketPath), "direct daemon socket")
    const first = await connectToGeneration(socketPath, (pid) => pid === direct.pid)

    await first.client.call("tribe.reload", { reason: "22322 direct-owner adoption acceptance" })
    first.client.close()
    await waitFor(() => !pidExists(first.pid), "direct predecessor exit")

    const successor = await connectToGeneration(socketPath, (pid) => pid !== first.pid)
    daemonPids.add(successor.pid)
    const ownerPid = parentPid(successor.pid)
    if (ownerPid > 1) ownerPids.add(ownerPid)
    expect(ownerPid, "direct reload successor must have a durable non-init owner").toBeGreaterThan(1)
    expect(ownerPid, "the dying predecessor cannot own its successor").not.toBe(first.pid)

    const generations = readFileSync(daemonEnvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string | null>)
    expect(generations).toHaveLength(2)
    expect(generations[0]).toMatchObject({ reloadExitCode: null, supervisorPid: null })
    expect(generations[1]).toMatchObject({
      reloadExitCode: expect.stringMatching(/^\d+$/u),
      supervisorPid: String(ownerPid),
    })
    successor.client.close()
  }, 30_000)
})
