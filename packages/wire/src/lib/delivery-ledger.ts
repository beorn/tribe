/**
 * #27459 - the durable half of the per-pane delivery counter (@cto 9a077460).
 *
 * The adapter's counters live in one adapter process; two facts must outlive it:
 *  (1) the set of message ids this pane has already been handed, so a handoff
 *      after a restart still counts as a duplicateDelivery rather than a new one;
 *  (2) the 4h window's counters, so the per-seat report reads a contiguous window.
 *
 * One small JSON file per pane under habitat kpi state. BOUNDED: the id set is
 * capped (the caller's counter already evicts) and a window roll rewrites the
 * same file, so nothing grows without limit and there is no append-only JSONL.
 * No message content is stored - ids and counters only.
 *
 * NO INVENTED ZERO: a ledger that exists but cannot be read back yields coverage
 * `gap: true` with a reason, and the report must render that, never a clean 0.
 * A non-representable `windowStartMs`/window end is a SCHEMA gap: the report
 * formats those as ISO dates, and one such row must not crash every other row.
 * A missing file is a fresh window (a first run is not a gap), and the window's
 * own `windowStartMs`/`restarts` expose how far the counts reach.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { HAB_SESSION_HABITAT_ROOT_ENV } from "./hab-session-env.ts"
import type { DeliveryCounters } from "./replay-cap.ts"

/** The per-seat report window (@cto 5738438e): four hours. */
export const DELIVERY_LEDGER_WINDOW_MS = 4 * 60 * 60 * 1_000
/** Explicit ledger file path (wins over the directory). */
export const TRIBE_DELIVERY_LEDGER_ENV = "TRIBE_DELIVERY_LEDGER"
/** Ledger directory override; default is `<habitatRoot>/kpi`. */
export const TRIBE_DELIVERY_LEDGER_DIR_ENV = "TRIBE_DELIVERY_LEDGER_DIR"
export const DELIVERY_LEDGER_VERSION = 1

export type DeliveryGapReason = "none" | "unreadable" | "schema"

export type DeliveryLedgerCoverage = {
  /** Adapter processes that resumed this window's ledger (a restart count). */
  restarts: number
  /** True while this window's counts cannot be a complete total. */
  gap: boolean
  gapReason: DeliveryGapReason
}

export type DeliveryLedgerState = {
  version: typeof DELIVERY_LEDGER_VERSION
  pane: string
  windowStartMs: number
  updatedAtMs: number
  /** Bounded first-successful-handoff message ids (no content). */
  ids: string[]
  counters: DeliveryCounters
  coverage: DeliveryLedgerCoverage
}

/** The file-name fragment for a pane: `@agent/test` -> `@agent_test`. */
export function deliveryLedgerPaneKey(pane: string): string {
  const key = pane.trim().replace(/[^A-Za-z0-9._@-]+/gu, "_")
  return key === "" ? "unregistered" : key
}

/**
 * The habitat kpi directory, or null when neither an override nor a habitat root
 * is known. There is deliberately NO `$HOME` fallback: the ledger belongs to the
 * habitat, and inventing a home location would write outside it (25231).
 */
export function deliveryLedgerDir(env: NodeJS.ProcessEnv): string | null {
  const override = env[TRIBE_DELIVERY_LEDGER_DIR_ENV]?.trim()
  if (override) return override
  const habitat = env[HAB_SESSION_HABITAT_ROOT_ENV]?.trim()
  if (habitat) return join(habitat, "kpi")
  return null
}

export function deliveryLedgerPath(opts: { pane: string; env: NodeJS.ProcessEnv }): string | null {
  const explicit = opts.env[TRIBE_DELIVERY_LEDGER_ENV]?.trim()
  if (explicit) return explicit
  const dir = deliveryLedgerDir(opts.env)
  if (dir === null) return null
  return join(dir, `tribe-delivery-${deliveryLedgerPaneKey(opts.pane)}.json`)
}

function zeroCounters(): DeliveryCounters {
  return {
    presentations: 0,
    newPresentations: 0,
    duplicatePresentations: 0,
    deliveries: 0,
    newDeliveries: 0,
    duplicateDeliveries: 0,
    duplicateBytes: 0,
    suppressed: 0,
  }
}

const COUNTER_KEYS: readonly (keyof DeliveryCounters)[] = [
  "presentations",
  "newPresentations",
  "duplicatePresentations",
  "deliveries",
  "newDeliveries",
  "duplicateDeliveries",
  "duplicateBytes",
  "suppressed",
]

function isCounters(value: unknown): value is DeliveryCounters {
  if (typeof value !== "object" || value === null) return false
  return COUNTER_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === "number")
}

/**
 * A Date-representable epoch-ms value: finite, and inside the ECMAScript
 * TimeClip range (|t| <= 8.64e15) so `new Date(t).toISOString()` cannot throw.
 * JSON admits 1e400 as Infinity and huge finite numbers whose ISO formatting
 * RangeErrors; both must be a named gap, never a crash of every other row.
 */
const MAX_TIME_CLIP_MS = 8_640_000_000_000_000
function isRepresentableTime(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_CLIP_MS
}

/**
 * Read a pane's ledger. A missing file is a FRESH window (gap false); a file
 * that exists but cannot be read back is a LOST window (gap true, with reason).
 */
export function loadDeliveryLedger(path: string): {
  state: DeliveryLedgerState | null
  coverage: DeliveryLedgerCoverage
} {
  if (!existsSync(path)) {
    return { state: null, coverage: { restarts: 0, gap: false, gapReason: "none" } }
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return { state: null, coverage: { restarts: 0, gap: true, gapReason: "unreadable" } }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeliveryLedgerState>
    if (
      parsed?.version !== DELIVERY_LEDGER_VERSION ||
      typeof parsed.pane !== "string" ||
      typeof parsed.windowStartMs !== "number" ||
      !isRepresentableTime(parsed.windowStartMs) ||
      !isRepresentableTime(parsed.windowStartMs + DELIVERY_LEDGER_WINDOW_MS) ||
      (parsed.updatedAtMs !== undefined &&
        (typeof parsed.updatedAtMs !== "number" || !isRepresentableTime(parsed.updatedAtMs))) ||
      !Array.isArray(parsed.ids) ||
      parsed.ids.some((id) => typeof id !== "string") ||
      !isCounters(parsed.counters)
    ) {
      return { state: null, coverage: { restarts: 0, gap: true, gapReason: "schema" } }
    }
    const restarts = typeof parsed.coverage?.restarts === "number" ? parsed.coverage.restarts : 0
    const gap = parsed.coverage?.gap === true
    const gapReason =
      parsed.coverage?.gapReason === "unreadable" || parsed.coverage?.gapReason === "schema"
        ? parsed.coverage.gapReason
        : gap
          ? "schema"
          : "none"
    return {
      state: {
        version: DELIVERY_LEDGER_VERSION,
        pane: parsed.pane,
        windowStartMs: parsed.windowStartMs,
        updatedAtMs: typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : parsed.windowStartMs,
        ids: parsed.ids as string[],
        counters: parsed.counters as DeliveryCounters,
        coverage: { restarts, gap, gapReason },
      },
      coverage: { restarts, gap, gapReason },
    }
  } catch {
    return { state: null, coverage: { restarts: 0, gap: true, gapReason: "unreadable" } }
  }
}

/**
 * Resume the in-flight 4h window (a restart: `restarts` + 1, counters kept) or
 * roll a fresh one (counters zeroed). The id set carries across a roll so a
 * duplicateDelivery is still recognised; it is never reset to invent a total.
 */
export function openDeliveryLedgerWindow(input: {
  existing: DeliveryLedgerState | null
  coverage: DeliveryLedgerCoverage
  pane: string
  now: number
}): DeliveryLedgerState {
  const { existing, coverage, pane, now } = input
  if (existing && now - existing.windowStartMs < DELIVERY_LEDGER_WINDOW_MS) {
    return {
      ...existing,
      pane,
      coverage: { restarts: coverage.restarts + 1, gap: coverage.gap, gapReason: coverage.gapReason },
    }
  }
  if (existing) {
    // A contiguous roll: the prior window's gap does not carry into this one.
    return {
      version: DELIVERY_LEDGER_VERSION,
      pane,
      windowStartMs: now,
      updatedAtMs: now,
      ids: existing.ids,
      counters: zeroCounters(),
      coverage: { restarts: 0, gap: false, gapReason: "none" },
    }
  }
  return {
    version: DELIVERY_LEDGER_VERSION,
    pane,
    windowStartMs: now,
    updatedAtMs: now,
    ids: [],
    counters: zeroCounters(),
    coverage: { restarts: 0, gap: coverage.gap, gapReason: coverage.gapReason },
  }
}

/** Atomic single-file write (temp + rename); bounded by the caller's id cap. */
export function saveDeliveryLedger(path: string, state: DeliveryLedgerState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state), "utf8")
  renameSync(tmp, path)
}
