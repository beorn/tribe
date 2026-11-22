/**
 * #30968 (@cto fe467bec item 2): an adapter holding a participant's token file but no launch name refuses to start by
 * name, instead of running unverified as unknown-<rand>. Other launches are untouched.
 *
 * @failure  The Mac's adapter, started with its participant token file but no --name, never presents the token and
 *           runs unverified as unknown-<rand>, able to broadcast (#30968 live proof run 2).
 * @level    l1
 * @consumer #30968 / stdio-adapter startup
 * @testonly none
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { participantLaunchNameRefusal } from "../src/lib/participant-launch-name.ts"

function tokenFileFor(actor: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const token = `${b64({ alg: "EdDSA" })}.${b64({ sid: "s-1", act: { sub: actor } })}.sig`
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "participant-launch-name-"))
  const file = join(dir, "token")
  writeFileSync(file, token, { mode: 0o600 })
  return file
}

describe("participantLaunchNameRefusal (#30968)", () => {
  it("refuses a participant's token file with no --name, naming the flag to add", () => {
    const refusal = participantLaunchNameRefusal({ HAB_ID_TOKEN_FILE: tokenFileFor("@ext/beorn-mac") }, undefined)
    expect(refusal).toContain("refused to start")
    expect(refusal).toContain("--name @ext/beorn-mac")
  })

  it("starts when the participant's --name is given", () => {
    expect(participantLaunchNameRefusal({ HAB_ID_TOKEN_FILE: tokenFileFor("@ext/beorn-mac") }, "@ext/beorn-mac")).toBe(
      null,
    )
  })

  it("leaves a seat's token file, and a launch with no token file, as they are", () => {
    expect(participantLaunchNameRefusal({ HAB_ID_TOKEN_FILE: tokenFileFor("@dev/7") }, undefined)).toBe(null)
    expect(participantLaunchNameRefusal({}, undefined)).toBe(null)
  })
})
