/**
 * @failure the Git ticker observes commits but never publishes the source frontier and facts together through Wire's API.
 * @level l2
 * @consumer the daemon's existing Git plugin registration and future Km feeder.
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase } from "./database.ts"
import { gitPlugin, runGitPoll } from "./git-plugin.ts"
import { publishConnectorBatch } from "./messaging.ts"
import { describeGitConnector } from "tribe-wire/lib/git-connector-schema"
import type { TribeClientApi } from "./plugin-api.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

describe("Git plugin connector boundary", () => {
  it("commits a baseline and a later typed fact through the one publisher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-plugin-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    git(repo, "commit", "--allow-empty", "-m", "baseline")
    const configPath = join(dir, "wire-connectors.json")
    const settings = {
      version: 1,
      sources: [
        {
          logicalSourceId: "code",
          contractVersion: "git.commit.v1",
          bindings: [{ id: "main", checkout: repo }],
          selectedRefs: ["refs/heads/*"],
          start: { kind: "baseline-now" },
          decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
        },
      ],
    } as const
    const described = describeGitConnector(settings)
    const generation = "fixture-generation"
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: "wire-connectors/1",
        generation,
        connectors: { code: { kind: "git", settings } },
      }),
    )
    writeFileSync(
      join(dir, "connector-schemas.json"),
      JSON.stringify({
        schema: "connector-schemas/1",
        generation,
        sources: {
          code: {
            connectorId: "code",
            kind: "git.commit",
            contractVersion: "git.commit.v1",
            digest: described.sources.code!.digest,
            schema: described.sources.code!.schema,
          },
        },
      }),
    )
    const db = openDatabase(join(dir, "wire.db"))
    try {
      const ctx = createTribeContext({
        db,
        stmts: createStatements(db),
        sessionId: "git-plugin-test",
        sessionRole: "daemon",
        initialName: "daemon",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      const api = {
        getConnectorFrontier: (sourceId: string) =>
          (
            db
              .query("SELECT value FROM coordination WHERE project_id=? AND key='frontier.v1'")
              .get(`connector:${sourceId}`) as { value: string } | null
          )?.value ?? null,
        publishConnectorBatch: (batch: Parameters<typeof publishConnectorBatch>[1]) =>
          publishConnectorBatch(ctx, batch),
      } as unknown as TribeClientApi
      await runGitPoll(configPath, api)
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE kind='event'").get()).toMatchObject({ count: 0 })
      expect(api.getConnectorFrontier?.("code")).not.toBeNull()

      git(repo, "commit", "--allow-empty", "-m", "Follow-up\n\nRefs: #25045")
      await runGitPoll(configPath, api)
      const rows = db.query("SELECT id, content FROM messages WHERE kind='event'").all() as Array<{
        id: string
        content: string
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toMatch(/^git:v1:/)
      expect(JSON.parse(rows[0]!.content)).toMatchObject({
        sourceId: "code",
        kind: "git.commit",
        subjects: { refs: ["#25045"] },
      })
      writeFileSync(
        join(dir, "connector-schemas.json"),
        JSON.stringify({
          schema: "connector-schemas/1",
          generation: "other-generation",
          sources: {},
        }),
      )
      await expect(runGitPoll(configPath, api)).rejects.toThrow(
        /connector generation mismatch.*retry after Hab publication/u,
      )
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE kind='event'").get()).toMatchObject({ count: 1 })
      const prior = process.env.TRIBE_GIT_CONNECTOR_CONFIG
      try {
        process.env.TRIBE_GIT_CONNECTOR_CONFIG = configPath
        expect(gitPlugin.available()).toBe(true) // The ticker remains installed and retries the pair on its next tick.
      } finally {
        if (prior === undefined) delete process.env.TRIBE_GIT_CONNECTOR_CONFIG
        else process.env.TRIBE_GIT_CONNECTOR_CONFIG = prior
      }
    } finally {
      db.close()
    }
  })
})
