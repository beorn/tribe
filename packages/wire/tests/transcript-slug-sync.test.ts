/**
 * @failure The transcript /rename slug sync swallows the daemon's refusal silently (a verified seat's slug rename is
 *          refused under wire-rename-refuse), and marks the session auto-renamed before the rename succeeded.
 * @level l1
 * @consumer stdio-adapter transcript slug sync (wire-rename-refuse, @cto 5d2291ef item c)
 * @testonly none
 *
 * The adapter cannot know whether its session is verified (the register answer carries no verdict), so it keeps the
 * call. A refusal is logged at warn once per slug with the daemon's text, and the session counts as renamed only when
 * the daemon answered with the new name.
 */
import { describe, expect, it } from "vitest"
import { createTranscriptSlugSync } from "../src/lib/transcript-slug-sync.ts"

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("transcript slug sync (wire-rename-refuse)", () => {
  it("logs the daemon's refusal once per slug and never reports the rename as applied", async () => {
    const warnings: string[] = []
    const renamed: string[] = []
    let calls = 0
    const tick = createTranscriptSlugSync({
      readSlug: () => "cozy-slug",
      currentName: () => "@dev/luna5",
      rename: async () => {
        calls += 1
        throw new Error('tribe.rename refused: requested "cozy-slug", verified "@dev/luna5"')
      },
      onRenamed: (name) => renamed.push(name),
      warn: (message) => warnings.push(message),
    })
    tick()
    await settle()
    tick()
    await settle()
    expect(calls).toBe(1)
    expect(renamed).toEqual([])
    expect(warnings).toEqual([expect.stringContaining('requested "cozy-slug", verified "@dev/luna5"')])
    expect(warnings[0]).toContain('"cozy-slug"')
  })

  it("logs a handler-level error answer the same way and does not report it as applied", async () => {
    const warnings: string[] = []
    const renamed: string[] = []
    const tick = createTranscriptSlugSync({
      readSlug: () => "taken-slug",
      currentName: () => "member-1",
      rename: async () => ({ error: 'Name "taken-slug" is already taken' }),
      onRenamed: (name) => renamed.push(name),
      warn: (message) => warnings.push(message),
    })
    tick()
    await settle()
    expect(renamed).toEqual([])
    expect(warnings).toEqual([expect.stringContaining('Name "taken-slug" is already taken')])
  })

  it("reports the daemon's name only on success", async () => {
    const warnings: string[] = []
    const renamed: string[] = []
    const tick = createTranscriptSlugSync({
      readSlug: () => "fresh-slug",
      currentName: () => "member-1",
      rename: async (slug) => ({ name: slug }),
      onRenamed: (name) => renamed.push(name),
      warn: (message) => warnings.push(message),
    })
    tick()
    await settle()
    expect(renamed).toEqual(["fresh-slug"])
    expect(warnings).toEqual([])
  })

  it("makes no call when there is no slug or the slug is already the session name", async () => {
    let calls = 0
    const rename = async () => {
      calls += 1
      return { name: "x" }
    }
    for (const slug of [null, "@dev/luna5"]) {
      createTranscriptSlugSync({
        readSlug: () => slug,
        currentName: () => "@dev/luna5",
        rename,
        onRenamed: () => {},
        warn: () => {},
      })()
    }
    await settle()
    expect(calls).toBe(0)
  })
})
