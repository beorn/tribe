/**
 * Vault semantic embedding store: generation identity and vector encoding (@ag/recall/three-dark-search-paths).
 *
 * A generation records the embedding contract and the GGUF digest that produced its vectors. Only one generation
 * is published at a time. A published generation whose contract or digest differs from the running one is refused
 * loudly: vectors from another model or contract are never compared with this one's.
 */
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

export interface VaultEmbedContract {
  readonly model: string
  readonly dimensions: number
  readonly pooling: "mean"
  readonly contextTokens: number
  readonly queryPrefix: string
  readonly documentPrefix: string
  readonly chunkTokens: number
  readonly overlapTokens: number
  readonly windowTokens: number
  /** qmd package version and the SHA-256 of the patched dist/store.js and dist/llm.js that compute the input. */
  readonly qmdVersion: string
  readonly qmdStoreSha256: string
  readonly qmdLlmSha256: string
}

export interface PublishedVaultEmbedGeneration {
  readonly id: number
  readonly contractJson: string
  readonly ggufSha256: string
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** Canonical contract identity: JSON with sorted keys, so key order never changes it. */
export function contractIdentity(contract: VaultEmbedContract): string {
  const entries = Object.entries(contract).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(Object.fromEntries(entries))
}

/** The reuse key of one chunk: sha256 of the contract identity and the exact truncated, formatted input. */
export function vaultInputKey(contractJson: string, formattedInput: string): string {
  return createHash("sha256").update(contractJson).update("\0").update(formattedInput).digest("hex")
}

export function beginVaultEmbedGeneration(
  db: Database,
  options: { contract: VaultEmbedContract; ggufSha256: string; now: number },
): number {
  if (!SHA256_HEX.test(options.ggufSha256)) {
    throw new Error(`GGUF sha256 must be 64 lowercase hex characters, got ${JSON.stringify(options.ggufSha256)}`)
  }
  const row = db
    .prepare(
      "INSERT INTO vault_embed_generation (contract_json, gguf_sha256, created_at, state) VALUES (?, ?, ?, 'building') RETURNING id",
    )
    .get(contractIdentity(options.contract), options.ggufSha256, options.now) as { id: number }
  return row.id
}

/** Publish a building generation and retire the previously published one, in one transaction. */
export function publishVaultEmbedGeneration(db: Database, id: number): void {
  db.transaction(() => {
    const target = db.prepare("SELECT state FROM vault_embed_generation WHERE id = ?").get(id) as {
      state: string
    } | null
    if (!target) throw new Error(`vault embedding generation ${id} does not exist`)
    if (target.state !== "building") {
      throw new Error(
        `vault embedding generation ${id} is ${target.state}; only a building generation can be published`,
      )
    }
    db.prepare("UPDATE vault_embed_generation SET state = 'retired' WHERE state = 'published'").run()
    db.prepare("UPDATE vault_embed_generation SET state = 'published' WHERE id = ?").run(id)
  })()
}

export function readPublishedVaultEmbedGeneration(db: Database): PublishedVaultEmbedGeneration | null {
  const rows = db
    .prepare("SELECT id, contract_json, gguf_sha256 FROM vault_embed_generation WHERE state = 'published'")
    .all() as { id: number; contract_json: string; gguf_sha256: string }[]
  if (rows.length > 1) {
    throw new Error(
      `vault embedding store has ${rows.length} published generations (${rows.map((r) => r.id).join(", ")}); exactly one is allowed`,
    )
  }
  const row = rows[0]
  return row ? { id: row.id, contractJson: row.contract_json, ggufSha256: row.gguf_sha256 } : null
}

/**
 * The published generation, if it was made by this contract and model; null when none is published.
 * A published generation from a different contract or GGUF digest throws: its vectors are not comparable.
 */
export function requireMatchingVaultEmbedGeneration(
  db: Database,
  contract: VaultEmbedContract,
  ggufSha256: string,
): PublishedVaultEmbedGeneration | null {
  const published = readPublishedVaultEmbedGeneration(db)
  if (!published) return null
  if (published.ggufSha256 !== ggufSha256) {
    throw new Error(
      `vault embedding generation ${published.id} was made by GGUF sha256 ${published.ggufSha256}, but the running model is ${ggufSha256}; its vectors are not comparable`,
    )
  }
  const running = contractIdentity(contract)
  if (published.contractJson !== running) {
    throw new Error(
      `vault embedding generation ${published.id} was made under contract ${published.contractJson}, but the running contract is ${running}; its vectors are not comparable`,
    )
  }
  return published
}

/** Raw Float32 bytes, exactly `dimensions` values. */
export function encodeVaultVector(vec: Float32Array, dimensions: number): Uint8Array {
  if (vec.length !== dimensions) {
    throw new Error(`vault vector has ${vec.length} values; the contract dimension is ${dimensions}`)
  }
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

export function decodeVaultVector(blob: Uint8Array, dimensions: number): Float32Array {
  if (blob.byteLength !== dimensions * 4) {
    throw new Error(
      `vault vector blob is ${blob.byteLength} bytes; the contract dimension ${dimensions} needs ${dimensions * 4}`,
    )
  }
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}
