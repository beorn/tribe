/** One declared Git source: graph discovery, typed decoding and a finite frontier. */
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  describeGitConnector,
  GitCommitFactSchema,
  GitFrontierSchema,
  GitSourceSchema,
  type GitCommitFact,
  type GitFrontier,
  type GitSource,
} from "tribe-wire/lib/git-connector-schema"
import type { ConnectorJournalEvent } from "./messaging.ts"

export type GitObservation =
  | Readonly<{
      kind: "observed"
      sourceId: string
      schemaDigest: string
      events: readonly ConnectorJournalEvent[]
      frontier: string
    }>
  | Readonly<{ kind: "source-gap"; sourceId: string; detail: string; previousFrontier: string | null }>

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (input !== undefined) {
    if (proc.stdin === undefined || typeof proc.stdin === "number") {
      throw new Error(`git ${args[0]}: stdin pipe unavailable`)
    }
    await proc.stdin.write(input)
    await proc.stdin.end()
  }
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${code}: ${err.trim() || "no stderr"}`)
  return out.trimEnd()
}

function selectedRef(ref: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.endsWith("*")) return pattern === ref
    return ref.startsWith(pattern.slice(0, -1))
  })
}

/** Cheap content-change witness for the declared refs and reflogs, never a source position by itself. */
async function snapshotSource(source: GitSource) {
  const entries = [] as Array<Record<string, unknown>>
  const locations = new Map<string, string>()
  for (const binding of [...source.bindings].sort((a, b) => a.id.localeCompare(b.id))) {
    const cwd = await realpath(binding.checkout)
    const commonDir = await realpath(resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"])))
    const objectFormat = await git(cwd, ["rev-parse", "--show-object-format"])
    locations.set(commonDir, cwd)
    const refs = await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...source.selectedRefs])
    const listed = await git(cwd, ["reflog", "list"])
    const names = [
      ...new Set([...listed.split("\n").filter((ref) => selectedRef(ref, source.selectedRefs)), "HEAD"]),
    ].sort()
    const paths = (
      await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        ...names.flatMap((name) => ["--git-path", `logs/${name}`]),
      ])
    ).split("\n")
    if (paths.length !== names.length) {
      throw new Error(`Git source ${source.logicalSourceId}: reflog path count changed during snapshot`)
    }
    const logs = await Promise.all(
      names.map(async (name, index) => {
        const path = paths[index]
        if (path === undefined) {
          throw new Error(`Git source ${source.logicalSourceId}: reflog path ${name} disappeared during snapshot`)
        }
        const info = await stat(path, { bigint: true })
        return {
          name,
          size: info.size.toString(),
          ino: info.ino.toString(),
          mtimeNs: info.mtimeNs.toString(),
          ctimeNs: info.ctimeNs.toString(),
        }
      }),
    )
    entries.push({ bindingId: binding.id, commonDir, objectFormat, refs, logs })
  }
  return { stamp: hash(JSON.stringify(entries)), locations }
}

type GitCapture = {
  commonDir: string
  objectFormat: "sha1" | "sha256"
  tips: Record<string, string>
  reflogs: Record<string, Array<{ oid: string; marker: string }>>
}

async function capture(cwd: string, patterns: readonly string[]): Promise<GitCapture> {
  const format = await git(cwd, ["rev-parse", "--show-object-format"])
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`Git source ${cwd}: unsupported object format ${format}`)
  }
  const commonDir = await realpath(resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"])))
  const tips: Record<string, string> = {}
  const reflogs: Record<string, Array<{ oid: string; marker: string }>> = {}
  const refs = await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...patterns])
  for (const line of refs.split("\n").filter(Boolean)) {
    const [ref, oid] = line.split("\0")
    if (!ref || !oid || !selectedRef(ref, patterns)) {
      throw new Error(`Git source ${cwd}: invalid selected-ref row ${JSON.stringify(line)}`)
    }
    tips[ref] = oid
  }
  // Git enumerates retained reflogs once per physical store. The frontier stores
  // only their count and head marker, never tens of thousands of historical OIDs.
  const allReflogs = await git(cwd, ["reflog", "show", "--all", "--format=%gD%x00%H%x00%gs"])
  for (const line of allReflogs.split("\n").filter(Boolean)) {
    const [selector, oid, message] = line.split("\0")
    const match = selector?.match(/^(.*)@\{\d+\}$/u)
    const ref = match?.[1]
    if (!ref || !oid || message === undefined) {
      throw new Error(`Git source ${cwd}: invalid reflog row ${JSON.stringify(line)}`)
    }
    if (!selectedRef(ref, patterns)) continue
    ;(reflogs[ref] ??= []).push({ oid, marker: hash(`${oid}\0${message}`) })
  }
  // A declared linked worktree has its own HEAD log, even though branch refs
  // and their logs live in the shared common-dir.
  tips["head:bound"] = await git(cwd, ["rev-parse", "HEAD"])
  const headReflog = await git(cwd, ["reflog", "show", "--format=%H%x00%gs", "HEAD"])
  reflogs["head:bound"] = headReflog
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid, message] = line.split("\0")
      if (!oid || message === undefined) {
        throw new Error(`Git source ${cwd}: invalid HEAD reflog row ${JSON.stringify(line)}`)
      }
      return { oid, marker: hash(`${oid}\0${message}`) }
    })
  return { commonDir, objectFormat: format, tips, reflogs }
}

async function decodeCommit(
  cwd: string,
  source: GitSource,
  oid: string,
  objectFormat: "sha1" | "sha256",
  schemaDigest: string,
  decoderDigest: string,
): Promise<ConnectorJournalEvent> {
  const out = await git(cwd, ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", oid])
  const parts = out.split("\0")
  if (parts.length < 7) throw new Error(`Git source ${source.logicalSourceId}: commit ${oid} lacks attribution fields`)
  const [authorName, authorEmail, authorAt, committerName, committerEmail, committerAt, ...bodyParts] = parts
  const body = bodyParts.join("\0")
  const parentLine = await git(cwd, ["rev-list", "--parents", "-n", "1", oid])
  const parents = parentLine.split(" ").slice(1)
  const trailerLines = await git(cwd, ["interpret-trailers", "--parse"], body)
  const trailers = trailerLines
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":")
      if (separator <= 0) {
        throw new Error(`Git source ${source.logicalSourceId}: invalid trailer ${JSON.stringify(line)}`)
      }
      return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
    })
  const values = (names: readonly string[]) =>
    trailers
      .filter((trailer) => names.some((name) => name.toLowerCase() === trailer.name.toLowerCase()))
      .map((trailer) => trailer.value)
  const fact = GitCommitFactSchema.parse({
    sourceId: source.logicalSourceId,
    kind: "git.commit",
    contractVersion: source.contractVersion,
    schemaDigest,
    decoderDigest,
    oid,
    objectFormat,
    parents,
    author: { name: authorName, email: authorEmail, at: authorAt },
    committer: { name: committerName, email: committerEmail, at: committerAt },
    subject: body.split("\n")[0] ?? "",
    body,
    subjects: {
      binds: values(source.decoder.trailers.binds),
      refs: values(source.decoder.trailers.refs),
      closes: values(source.decoder.trailers.closes),
    },
    evidence: { trailers },
    sourcePosition: { commitOid: oid },
  })
  return {
    id: `git:v1:${hash(JSON.stringify([source.logicalSourceId, oid, objectFormat, "git.commit", source.contractVersion]))}`,
    kind: "git.commit",
    content: JSON.stringify(fact),
    topic: "git:commit",
    summary: `git ${oid.slice(0, 12)}: ${fact.subject}`,
  }
}

/** Freeze selected refs and retained reflogs, then enumerate their graph delta. */
export async function observeGitSource(sourceInput: unknown, previousFrontier: string | null): Promise<GitObservation> {
  const source = GitSourceSchema.parse(sourceInput)
  const sourceId = source.logicalSourceId
  const declarationDigest = hash(JSON.stringify(source))
  const decoderDigest = hash(JSON.stringify(source.decoder))
  const described = describeGitConnector({ version: 1, sources: [source] }).sources[sourceId]
  if (described === undefined) throw new Error(`Git source ${sourceId}: describe returned no schema`)
  const schemaDigest = described.digest
  let previous: GitFrontier | null = null
  if (previousFrontier !== null) {
    try {
      previous = GitFrontierSchema.parse(JSON.parse(previousFrontier))
    } catch (error) {
      return { kind: "source-gap", sourceId, detail: `unreadable prior frontier: ${String(error)}`, previousFrontier }
    }
    if (
      previous.sourceId !== sourceId ||
      previous.contractVersion !== source.contractVersion ||
      previous.declarationDigest !== declarationDigest ||
      previous.decoderDigest !== decoderDigest ||
      previous.schemaDigest !== schemaDigest
    ) {
      return {
        kind: "source-gap",
        sourceId,
        detail:
          "source declaration, identity, contract or decoder changed without a contract-version advance and explicit replay policy",
        previousFrontier,
      }
    }
  }
  const before = await snapshotSource(source)
  if (previous !== null && before.stamp === previous.snapshotStamp) {
    for (const [id, binding] of Object.entries(previous.bindings)) {
      const cwd = before.locations.get(binding.commonDir)
      if (cwd === undefined) {
        return { kind: "source-gap", sourceId, detail: `previous physical binding ${id} disappeared`, previousFrontier }
      }
      for (const oid of new Set(Object.values(binding.tips))) {
        try {
          await git(cwd, ["cat-file", "-e", `${oid}^{commit}`])
        } catch {
          return {
            kind: "source-gap",
            sourceId,
            detail: `previously recorded object ${oid} in binding ${id} is missing`,
            previousFrontier,
          }
        }
      }
    }
    if (previousFrontier === null) throw new Error(`Git source ${sourceId}: parsed frontier lost its original bytes`)
    return { kind: "observed", sourceId, schemaDigest, events: [], frontier: previousFrontier }
  }
  const byPhysical = new Map<string, { id: string; cwd: string; capture: Awaited<ReturnType<typeof capture>> }>()
  const bindingIds = new Set<string>()
  for (const binding of source.bindings) {
    if (bindingIds.has(binding.id)) throw new Error(`Git source ${sourceId}: duplicate binding id ${binding.id}`)
    bindingIds.add(binding.id)
    const checkout = await realpath(binding.checkout)
    const observed = await capture(checkout, source.selectedRefs)
    const bindingTips: Record<string, string> = {}
    for (const [key, oid] of Object.entries(observed.tips)) {
      const boundKey = key === "head:bound" ? `head:${binding.id}` : key
      bindingTips[boundKey] = oid
    }
    const bindingReflogs = { ...observed.reflogs }
    bindingReflogs[`head:${binding.id}`] = bindingReflogs["head:bound"] ?? []
    delete bindingReflogs["head:bound"]
    const held = byPhysical.get(observed.commonDir)
    if (held === undefined) {
      byPhysical.set(observed.commonDir, {
        id: binding.id,
        cwd: checkout,
        capture: { ...observed, tips: bindingTips, reflogs: bindingReflogs },
      })
    } else {
      if (held.capture.objectFormat !== observed.objectFormat) {
        throw new Error(`Git source ${sourceId}: shared store ${observed.commonDir} reports conflicting object formats`)
      }
      for (const [key, oid] of Object.entries(bindingTips)) {
        if (held.capture.tips[key] !== undefined && held.capture.tips[key] !== oid) {
          throw new Error(`Git source ${sourceId}: shared store ${observed.commonDir} reports conflicting ref ${key}`)
        }
        held.capture.tips[key] = oid
      }
      for (const [key, rows] of Object.entries(bindingReflogs)) {
        const priorRows = held.capture.reflogs[key]
        if (priorRows !== undefined && JSON.stringify(priorRows) !== JSON.stringify(rows)) {
          throw new Error(
            `Git source ${sourceId}: shared store ${observed.commonDir} changed reflog ${key} during capture`,
          )
        }
        held.capture.reflogs[key] = rows
      }
      if (binding.id < held.id) {
        held.id = binding.id
        held.cwd = checkout
      }
    }
  }
  const physical = [...byPhysical.values()].sort((a, b) => a.id.localeCompare(b.id))
  const next: GitFrontier = {
    version: 1,
    sourceId,
    contractVersion: source.contractVersion,
    declarationDigest,
    decoderDigest,
    schemaDigest,
    snapshotStamp: before.stamp,
    bindings: {},
  }
  const candidate = new Map<string, { cwd: string; format: "sha1" | "sha256" }>()
  for (const entry of physical) {
    const { id, cwd, capture: observed } = entry
    const prior = previous?.bindings[id]
    if (previous !== null && prior === undefined) {
      return {
        kind: "source-gap",
        sourceId,
        detail: `new physical binding ${id} needs an explicit start revision`,
        previousFrontier,
      }
    }
    if (
      prior !== undefined &&
      (prior.commonDir !== observed.commonDir || prior.objectFormat !== observed.objectFormat)
    ) {
      return {
        kind: "source-gap",
        sourceId,
        detail: `physical binding ${id} changed Git store or object format`,
        previousFrontier,
      }
    }
    const previousTips = prior === undefined ? [] : [...new Set(Object.values(prior.tips))]
    for (const oid of previousTips) {
      try {
        await git(cwd, ["cat-file", "-e", `${oid}^{commit}`])
      } catch {
        return {
          kind: "source-gap",
          sourceId,
          detail: `previously recorded object ${oid} in binding ${id} is missing`,
          previousFrontier,
        }
      }
    }
    const currentReflogs: Record<string, { count: number; head: string }> = {}
    const newReflogTips: string[] = []
    for (const [ref, rows] of Object.entries(observed.reflogs)) {
      if (rows.length === 0) continue
      const earlier = prior?.reflogs[ref]
      if (earlier !== undefined) {
        const delta = rows.length - earlier.count
        if (delta < 0 || rows[delta]?.marker !== earlier.head) {
          return {
            kind: "source-gap",
            sourceId,
            detail: `retained reflog ${ref} in binding ${id} was rewritten or expired before observation`,
            previousFrontier,
          }
        }
        newReflogTips.push(...rows.slice(0, delta).map((row) => row.oid))
      } else if (previous !== null || source.start.kind === "after") {
        newReflogTips.push(...rows.map((row) => row.oid))
      }
      const head = rows[0]
      if (head === undefined) throw new Error(`Git source ${sourceId}: non-empty reflog ${ref} lost its head`)
      currentReflogs[ref] = { count: rows.length, head: head.marker }
    }
    if (prior !== undefined) {
      for (const ref of Object.keys(prior.reflogs)) {
        if (currentReflogs[ref] !== undefined) continue
        // Deleting a branch deletes its reflog; an unseen created-and-deleted
        // branch cannot be reconstructed. A declared worktree's HEAD log must
        // remain readable, as must the log of a still-selected ref.
        if (ref.startsWith("head:") || observed.tips[ref] !== undefined) {
          return {
            kind: "source-gap",
            sourceId,
            detail: `retained reflog ${ref} in binding ${id} disappeared`,
            previousFrontier,
          }
        }
      }
    }
    next.bindings[id] = {
      commonDir: observed.commonDir,
      objectFormat: observed.objectFormat,
      tips: observed.tips,
      reflogs: currentReflogs,
    }
    if (previous === null && source.start.kind === "baseline-now") continue
    const tips = [...new Set([...Object.values(observed.tips), ...newReflogTips])]
    if (tips.length === 0) continue
    const exclusions = previous === null && source.start.kind === "after" ? [source.start.revision] : previousTips
    const revs = await git(cwd, [
      "rev-list",
      "--topo-order",
      "--reverse",
      ...tips,
      ...(exclusions.length ? ["--not", ...exclusions] : []),
    ])
    for (const oid of revs.split("\n").filter(Boolean)) {
      if (!candidate.has(oid)) candidate.set(oid, { cwd, format: observed.objectFormat })
    }
  }
  if (previous !== null) {
    const removed = Object.keys(previous.bindings).find((id) => next.bindings[id] === undefined)
    if (removed) {
      return {
        kind: "source-gap",
        sourceId,
        detail: `previous physical binding ${removed} is no longer declared`,
        previousFrontier,
      }
    }
  }
  // A burst may contain hundreds of commits; keep the Git child count bounded.
  const facts: Array<{ oid: string; event: ConnectorJournalEvent }> = []
  for (const [oid, location] of candidate) {
    facts.push({
      oid,
      event: await decodeCommit(location.cwd, source, oid, location.format, schemaDigest, decoderDigest),
    })
  }
  // Stable topo order across explicitly shared logical clones. A child can be
  // discovered in a different physical binding from its parent.
  const byOid = new Map(facts.map((item) => [item.oid, item]))
  const ordered: ConnectorJournalEvent[] = []
  const visited = new Set<string>()
  const visit = (oid: string) => {
    if (visited.has(oid)) return
    visited.add(oid)
    const item = byOid.get(oid)
    if (!item) return
    const parents = (JSON.parse(item.event.content) as GitCommitFact).parents
    for (const parent of parents) visit(parent)
    ordered.push(item.event)
  }
  for (const oid of [...byOid.keys()].sort()) visit(oid)
  const after = await snapshotSource(source)
  if (after.stamp !== before.stamp) {
    throw new Error(`Git source ${sourceId}: refs or reflogs changed during capture; retry without advancing frontier`)
  }
  return { kind: "observed", sourceId, schemaDigest, events: ordered, frontier: JSON.stringify(next) }
}
