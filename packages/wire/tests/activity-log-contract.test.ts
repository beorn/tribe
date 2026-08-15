import { describe, expect, test } from "vitest"
import { activityLogDir, activityLogFilename } from "../src/activity-log-contract.ts"

describe("activity log contract", () => {
  test("resolves the shared XDG-style directory from the supplied environment", () => {
    expect(activityLogDir({ HOME: "/tmp/tribe-user" })).toBe("/tmp/tribe-user/.local/share/tribe")
  })

  test("uses one local-date filename shape for writer rotation and reader follow mode", () => {
    expect(activityLogFilename(new Date(2026, 6, 9))).toBe("activity-2026-07-09.jsonl")
  })
})
