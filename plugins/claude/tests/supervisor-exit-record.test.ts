/**
 * @failure Ending rows lose their launch generation, borrow a later credential, or disappear when identity cannot be read.
 * @level l1
 * @consumer plugins/claude/server.ts#superviseAdapter
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatInstanceId } from "../../../packages/wire/src/lib/persona-launch-identity.ts"
import { launchToken } from "../../../packages/wire/tests/launch-token.ts"
import { recordAdapterExit, resolveAdapterExitRecord, type AdapterExit } from "../supervisor-exit-record.ts"

const PRIVATE = "fixture-private-identity-value"
const badClaims = (gen?: unknown) =>
  `e30.${Buffer.from(JSON.stringify({ sid: PRIVATE, act: { sub: "fixture-seat" }, gen })).toString("base64url")}.c2ln`

describe("launch-stamped adapter ending record (29701)", () => {
  let home: string
  let stderr: MockInstance<typeof process.stderr.write>
  const rows = () =>
    readFileSync(join(home, "tribe-adapter-exits.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "adapter-exit-identity-"))
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })
  afterEach(() => {
    stderr.mockRestore()
    rmSync(home, { recursive: true, force: true })
  })

  test("all six ending paths inherit one file-first token instance captured before later credential changes", () => {
    const file = join(home, "identity-token")
    const firstToken = launchToken("captured-session", "fixture-seat")
    writeFileSync(file, firstToken, { mode: 0o600 })
    const target = resolveAdapterExitRecord({
      AG_HOST_SESSION_STATE_DIR: home,
      HAB_ID_TOKEN_FILE: file,
      HAB_ID_TOKEN: launchToken("legacy-foreign-session", "fixture-seat"),
      AG_HOST_LAUNCH_ID: "ambient-foreign-session",
      AG_HOST_LAUNCH_GENERATION: "9000",
    })
    writeFileSync(file, launchToken("later-session", "fixture-seat"))
    const endings: AdapterExit[] = [
      { adapterPid: undefined, code: null, signal: null, decision: "nested-host-refused", reason: "nested refusal" },
      { adapterPid: undefined, code: null, signal: null, decision: "stop", reason: "cold-start refusal" },
      { adapterPid: 4242, code: null, signal: "SIGTERM", decision: "host-stop" },
      { adapterPid: 4242, code: 0, signal: null, decision: "clean-exit" },
      { adapterPid: 4242, code: 78, signal: null, decision: "stop", reason: "persona refusal" },
      { adapterPid: 4242, code: 1, signal: null, decision: "retry", attempt: 1, retryDelayMs: 10 },
    ]
    for (const ending of endings) recordAdapterExit(target, ending)
    expect(rows()).toEqual(
      endings.map((ending) =>
        expect.objectContaining({
          instance_id: formatInstanceId("captured-session", 1),
          adapter_pid: ending.adapterPid ?? null,
          code: ending.code,
          signal: ending.signal,
          decision: ending.decision,
        }),
      ),
    )
    expect(stderr).not.toHaveBeenCalled()
    expect(readFileSync(join(home, "tribe-adapter-exits.jsonl"), "utf8")).not.toContain(firstToken)
  })

  test.each([
    { label: "absent token", env: () => ({}) },
    { label: "malformed token", env: () => ({ HAB_ID_TOKEN: PRIVATE }) },
    { label: "missing generation", env: () => ({ HAB_ID_TOKEN: badClaims() }) },
    { label: "invalid generation", env: () => ({ HAB_ID_TOKEN: badClaims(PRIVATE) }) },
    {
      label: "unreadable preferred token file",
      env: () => ({
        HAB_ID_TOKEN_FILE: join(home, "missing-token"),
        HAB_ID_TOKEN: launchToken("fallback-must-not-be-used"),
      }),
    },
  ])("$label still records its ending with null and one redacted diagnostic", ({ env }) => {
    const target = resolveAdapterExitRecord({ AG_HOST_SESSION_STATE_DIR: home, ...env() })
    for (const code of [17, 18]) recordAdapterExit(target, { adapterPid: 4242, code, signal: null, decision: "stop" })
    expect(rows()).toEqual(
      [17, 18].map((code) => expect.objectContaining({ instance_id: null, code, decision: "stop" })),
    )
    expect(stderr).toHaveBeenCalledTimes(1)
    const warning = stderr.mock.calls.map(([text]) => String(text)).join("")
    expect(warning).toContain("instance_id")
    expect(warning).toContain("null")
    expect(warning).not.toContain(PRIVATE)
    expect(warning).not.toContain(badClaims(PRIVATE))
    expect(JSON.stringify(rows())).not.toContain(PRIVATE)
  })
})
