/**
 * tribe-injection-envelope — the single chokepoint for all
 * UserPromptSubmit `hookSpecificOutput.additionalContext` emission.
 *
 * Every bearly / accountly / tribe / telegram / github / beads /
 * system-reminder emitter MUST route through this package. Raw
 * `additionalContext` emission outside this library is caught by
 * `tools/lint-injection-emitters.ts` in CI.
 *
 * See README.md for the full rationale and phase-0/1/2/3/5 plan.
 */

export { wrapInjectedContext, emitHookJson, CONTEXT_PROTOCOL_FOOTER } from "./emit.ts"
export type { WrapOptions, InjectedItem, EmitMode } from "./emit.ts"

export { rewriteImperativeAsReported, sanitize } from "./sanitize.ts"
export { defangModelInput } from "./defang.ts"

export {
  INJECTION_ENVELOPE_TAG,
  INJECTION_ITEM_TAG,
  CONTEXT_PROTOCOL_TAG,
  USER_PROMPT_TAG,
  CHANNEL_TAG,
  SYSTEM_REMINDER_TAG,
  LEGACY_INJECTION_TAGS,
  INJECTION_TAG_NAMES,
  injectionTagAlternation,
} from "./tags.ts"

export { parseInjectedContext, hasInjectedContextFrom } from "./parse.ts"
export type { ParsedInjectedContext, ParsedInjectedItem } from "./parse.ts"

export type { RegisteredSource } from "./registry.ts"

export {
  extractEntities,
  extractShingles,
  looksLikeExplicitWriteAuth,
  readTurnManifest,
  writeTurnManifest,
  turnManifestPathForSession,
  sessionsDir,
} from "./manifest.ts"
export type { TurnManifest, InjectedSpan, TurnManifestReadResult } from "./manifest.ts"

export { evaluateGate } from "./gate.ts"
export type { GateInput, GateDecision, Permission } from "./gate.ts"

export { retrieveMemory, registerRetrieveSource, qmdFetcher, retrieveFetcherCount } from "./retrieve.ts"
export type { RetrievedMemory, RetrieveFetcher } from "./retrieve.ts"

export { emitInjectionDebugEvent, installInjectionFileWriter, flushInjectionFileWriters } from "./debug.ts"
export type { InjectionDebugEvent } from "./debug.ts"
