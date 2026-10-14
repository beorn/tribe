/**
 * @failure 29271 (@cto e961c800 must 1): hab's declaration of wire's structured log drifts from the directory and
 *   name the daemon's own writer produces, and `hab log wire` then quietly answers "no file" months later. The
 *   declaration lives in a PURE config module, which may not import this contract, so nothing else binds the two.
 * @level l1 the declaration module and the activity-log contract, no filesystem: one row that goes red the day
 *   either side moves.
 * @consumer ag's declared-log reader rows (ag/packages/hab-plugin-ag/tests/hab-logs.test.ts, 29271).
 * @testonly none
 */
import { basename, dirname } from "node:path"
import { describe, expect, test } from "vitest"
import wireProjects from "../../../hab.projects.ts"
import { activityLogDir, activityLogFilename, isActivityLogFilename } from "../src/activity-log-contract.ts"

const WIRE = wireProjects.habitants.wire

describe("29271 declared log drift", () => {
  test("wire's declared log is the stream its own writer produces", () => {
    // The declaration uses the row's own `$VAR` vocabulary, expanded by hab with `expandServicePathEnvironment`.
    // wire's own test may not import that ag helper, so this pin substitutes the row's OWN single variable and
    // binds the directory to the contract's `activityLogDir` (with TRIBE_ACTIVITY_LOG unset, so the declared
    // directory is the one the daemon writes by default) and the final segment to the writer's dated name.
    const home = "/synthetic/home"
    const declared = (WIRE.log as string).replace("$HOME", home)
    expect(dirname(declared)).toBe(activityLogDir({ HOME: home, TRIBE_ACTIVITY_LOG: undefined }))
    // The declared final segment is the glob `hab log` resolves; the daemon's own writer produces only names the
    // contract recognises as activity logs, and every one of them matches that glob.
    expect(basename(declared)).toBe("activity-*.jsonl")
    const written = activityLogFilename(new Date(2026, 9, 14, 12))
    expect(isActivityLogFilename(written)).toBe(true)
    expect(written).toMatch(/^activity-.*\.jsonl$/u)
  })
})
