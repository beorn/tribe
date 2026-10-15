/** The existing Git plugin's sole ticker, now backed by declared typed sources. */
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { createLogger } from "loggily"
import {
  ConnectorSchemaBundleSchema,
  describeGitConnector,
  WireConnectorConfigSchema,
} from "tribe-wire/lib/git-connector-schema"
import { observeGitSource } from "./git-connector.ts"
import { createTimers } from "./timers.ts"
import { startSingleFlightTicker } from "./single-flight-ticker.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:git")

function configuredPath(): string | null {
  const path = process.env.TRIBE_GIT_CONNECTOR_CONFIG
  if (path === undefined) return null
  if (!isAbsolute(path)) {
    throw new Error(`TRIBE_GIT_CONNECTOR_CONFIG must be an absolute path, received ${JSON.stringify(path)}`)
  }
  return path
}

function readDocument(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`declared connector file ${path} is unreadable: ${String(error)}`, { cause: error })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`declared connector file ${path} is invalid JSON: ${String(error)}`, { cause: error })
  }
}

function readSources(path: string) {
  const config = WireConnectorConfigSchema.parse(readDocument(path))
  const schemasPath = join(dirname(path), "connector-schemas.json")
  const schemas = ConnectorSchemaBundleSchema.parse(readDocument(schemasPath))
  if (schemas.generation !== config.generation) {
    throw new Error(
      `connector generation mismatch: ${path} has ${config.generation}, ${schemasPath} has ${schemas.generation}; retry after Hab publication`,
    )
  }
  const sources = [] as ReturnType<typeof describeGitConnector>["settings"]["sources"]
  const ids = new Set<string>()
  for (const [connectorId, declaration] of Object.entries(config.connectors)) {
    if (declaration.kind !== "git") continue
    const described = describeGitConnector(declaration.settings)
    for (const source of described.settings.sources) {
      if (ids.has(source.logicalSourceId)) {
        throw new Error(`Git connector config ${path}: duplicate logical source ${source.logicalSourceId}`)
      }
      ids.add(source.logicalSourceId)
      const published = schemas.sources[source.logicalSourceId]
      if (
        published === undefined ||
        published.connectorId !== connectorId ||
        published.kind !== "git.commit" ||
        published.contractVersion !== source.contractVersion ||
        published.digest !== described.sources[source.logicalSourceId]?.digest
      ) {
        throw new Error(
          `Git connector source ${source.logicalSourceId}: schema bundle at ${schemasPath} disagrees with ${path}`,
        )
      }
      sources.push(source)
    }
  }
  return sources
}

/** Called by the ticker; persisted Wire frontiers, never process memory, decide each delta. */
export async function runGitPoll(configPath: string, api: TribeClientApi): Promise<void> {
  if (api.getConnectorFrontier === undefined || api.publishConnectorBatch === undefined) {
    throw new Error("Git connector requires Wire's getConnectorFrontier and publishConnectorBatch capabilities")
  }
  const getFrontier = api.getConnectorFrontier
  const publishBatch = api.publishConnectorBatch
  const errors: string[] = []
  for (const source of readSources(configPath)) {
    try {
      const prior = getFrontier(source.logicalSourceId)
      const observation = await observeGitSource(source, prior)
      if (observation.kind === "source-gap") {
        throw new Error(`source-gap: ${observation.detail}`)
      }
      const receipt = publishBatch({
        sourceId: observation.sourceId,
        expectedFrontier: prior,
        nextFrontier: observation.frontier,
        schemaDigest: observation.schemaDigest,
        events: observation.events,
      })
      if (receipt.kind !== "committed" && receipt.kind !== "already-held") {
        throw new Error(`${receipt.kind}: ${JSON.stringify(receipt)}`)
      }
      if (receipt.inserted > 0) {
        log.info?.(
          `source ${source.logicalSourceId}: committed ${receipt.inserted} typed Git event(s), frontier=${receipt.committedFrontierHash}`,
        )
      }
    } catch (error) {
      errors.push(`${source.logicalSourceId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (errors.length > 0) throw new Error(`Git connector poll failed: ${errors.join("; ")}`)
}

export const gitPlugin: TribePluginApi = {
  name: "git",
  available() {
    // Keep the existing ticker alive across Hab's pair of atomic file writes.
    // A mixed generation is named by runGitPoll and retried on the next tick.
    return configuredPath() !== null
  },
  start(api: TribeClientApi) {
    const configPath = configuredPath()
    if (configPath === null) throw new Error("Git connector start lost TRIBE_GIT_CONNECTOR_CONFIG after availability")
    const ac = new AbortController()
    const timers = createTimers(ac.signal)
    startSingleFlightTicker({
      name: "git-poll",
      intervalMs: 30_000,
      timers,
      log: { warn: (message) => log.warn?.(message), error: (message) => log.error?.(message) },
      run: () => runGitPoll(configPath, api),
    })
    return () => ac.abort()
  },
}
