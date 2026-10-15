/** Static describe() for the first typed external source. No daemon or Hab imports. */
import { createHash } from "node:crypto"
import { z } from "zod"

const nonempty = z.string().trim().min(1)

export const GitSourceSchema = z
  .object({
    logicalSourceId: nonempty,
    contractVersion: z.literal("git.commit.v1"),
    bindings: z.array(z.object({ id: nonempty, checkout: z.string().startsWith("/") }).strict()).min(1),
    selectedRefs: z
      .array(
        z
          .string()
          .startsWith("refs/")
          .refine(
            (pattern) =>
              !/[?\[\]]/u.test(pattern) &&
              (pattern.match(/\*/gu)?.length ?? 0) <= 1 &&
              (!pattern.includes("*") || pattern.endsWith("*")) &&
              pattern !== "refs/" &&
              !/\s/u.test(pattern),
            "selected ref must be an exact refs/ name or one trailing-prefix * pattern",
          ),
      )
      .min(1),
    start: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("baseline-now") }).strict(),
      z.object({ kind: z.literal("after"), revision: nonempty }).strict(),
    ]),
    decoder: z
      .object({
        version: nonempty,
        trailers: z
          .object({
            binds: z.array(nonempty),
            refs: z.array(nonempty),
            closes: z.array(nonempty),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const ids = new Set<string>()
    for (const [index, binding] of source.bindings.entries()) {
      if (ids.has(binding.id)) {
        ctx.addIssue({ code: "custom", path: ["bindings", index, "id"], message: `duplicate binding id ${binding.id}` })
      }
      ids.add(binding.id)
    }
  })
export type GitSource = z.infer<typeof GitSourceSchema>

export const GitConnectorSettingsSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(GitSourceSchema).min(1),
  })
  .strict()
export type GitConnectorSettings = z.infer<typeof GitConnectorSettingsSchema>

/** Two Hab-published files share this generation; readers refuse a mixed pair. */
export const WireConnectorConfigSchema = z
  .object({
    schema: z.literal("wire-connectors/1"),
    generation: nonempty,
    connectors: z.record(
      z.string(),
      z.object({ kind: nonempty, settings: z.record(z.string(), z.unknown()) }).strict(),
    ),
  })
  .strict()

export const ConnectorSchemaBundleSchema = z
  .object({
    schema: z.literal("connector-schemas/1"),
    generation: nonempty,
    sources: z.record(
      z.string(),
      z
        .object({
          connectorId: nonempty,
          kind: nonempty,
          contractVersion: nonempty,
          digest: nonempty,
          schema: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
  })
  .strict()

/** Immutable commit facts only; branch reachability stays in the frontier. */
export const GitCommitFactSchema = z
  .object({
    sourceId: nonempty,
    kind: z.literal("git.commit"),
    contractVersion: z.literal("git.commit.v1"),
    schemaDigest: nonempty,
    decoderDigest: nonempty,
    oid: nonempty,
    objectFormat: z.enum(["sha1", "sha256"]),
    parents: z.array(nonempty),
    author: z.object({ name: z.string(), email: z.string(), at: z.string() }).strict(),
    committer: z.object({ name: z.string(), email: z.string(), at: z.string() }).strict(),
    subject: z.string(),
    body: z.string(),
    subjects: z.object({ binds: z.array(nonempty), refs: z.array(nonempty), closes: z.array(nonempty) }).strict(),
    evidence: z.object({ trailers: z.array(z.object({ name: nonempty, value: z.string() }).strict()) }).strict(),
    sourcePosition: z.object({ commitOid: nonempty }).strict(),
  })
  .strict()
export type GitCommitFact = z.infer<typeof GitCommitFactSchema>

export const GitFrontierSchema = z
  .object({
    version: z.literal(1),
    sourceId: nonempty,
    contractVersion: z.literal("git.commit.v1"),
    declarationDigest: nonempty,
    decoderDigest: nonempty,
    schemaDigest: nonempty,
    snapshotStamp: nonempty,
    bindings: z.record(
      z.string(),
      z
        .object({
          commonDir: nonempty,
          objectFormat: z.enum(["sha1", "sha256"]),
          tips: z.record(z.string(), nonempty),
          reflogs: z.record(z.string(), z.object({ count: z.number().int().nonnegative(), head: nonempty }).strict()),
        })
        .strict(),
    ),
  })
  .strict()
export type GitFrontier = z.infer<typeof GitFrontierSchema>

/** Hab copies this exact JSON Schema/digest; Km never imports a connector. */
export function describeGitConnector(input: unknown) {
  const settings = GitConnectorSettingsSchema.parse(input)
  const ids = new Set<string>()
  const schema = z.toJSONSchema(GitCommitFactSchema)
  const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex")
  const sources: Record<string, { schema: typeof schema; digest: string }> = {}
  for (const source of settings.sources) {
    if (ids.has(source.logicalSourceId)) {
      throw new Error(`Git connector: duplicate logical source ${source.logicalSourceId}`)
    }
    ids.add(source.logicalSourceId)
    sources[source.logicalSourceId] = { schema, digest }
  }
  return { kind: "git" as const, settings, sources }
}
