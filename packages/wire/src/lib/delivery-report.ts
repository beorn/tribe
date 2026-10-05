/**
 * #27459 - the 4-hour per-seat delivery report over the per-pane ledger
 * (@cto 9a077460, @chief af807bc0 item 2).
 *
 * The adapter's counter measures; the ledger persists; this module is the
 * READING a briefing consumes. One row per seat:
 *   - duplicateDelivery is the ONLY unit the >20% / >=100 alert may fire on
 *     (duplicatePresentation is a diagnostic, never called attention cost);
 *   - duplicateBytes counts handoffs only, and suppressed is reported apart;
 *   - a gap window reads as incomplete, never as a clean total (NO INVENTED
 *     ZERO); a ledger that cannot be read back is listed as a gap, not skipped;
 *   - an incomplete denominator cannot prove the >20% rule, so a gap row marks
 *     its rate/alert inconclusive and never fires the alert (counters still shown);
 *   - the page-edge half is owned by @chief/hab and is left null here for the
 *     4h report owner to join, per @cto ("not this wire package").
 */
import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import {
  DELIVERY_LEDGER_WINDOW_MS,
  loadDeliveryLedger,
  type DeliveryGapReason,
  type DeliveryLedgerCoverage,
  type DeliveryLedgerState,
} from "./delivery-ledger.ts"
import type { DeliveryClassStat } from "./replay-cap.ts"

/** @cto 9a077460 - strictly above this duplicateDelivery rate, with enough volume. */
export const DELIVERY_DUPLICATE_ALERT_RATE = 0.2
/** @cto 9a077460 - the minimum successful deliveries before the rate is actionable. */
export const DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES = 100
/**
 * #27488 phase 0 - @chief's measured harness wrapper from the 2026-10-04
 * composition window: every queued delivery carried ~460 chars of identical
 * harness text. An ESTIMATE (the harness is not ours to measure), named here so
 * the report can state it and no reader takes it for a measurement.
 */
export const HARNESS_WRAPPER_CHARS_PER_DELIVERY = 460
/** The composition report's token rule: chars / 4. */
export const CHARS_PER_TOKEN = 4

const LEDGER_FILE = /^tribe-delivery-(.+)\.json$/

export type SeatDeliveryReport = {
  pane: string
  windowStartMs: number
  windowEndMs: number
  observedThroughMs: number
  /** Age of the last ledger write against the report time; a stale row is still shown. */
  staleMs: number
  deliveries: number
  newDeliveries: number
  duplicateDeliveries: number
  duplicateBytes: number
  /** duplicateDeliveries / deliveries; null when there were no deliveries (no invented zero). */
  duplicateRate: number | null
  presentations: number
  duplicatePresentations: number
  suppressed: number
  coverage: DeliveryLedgerCoverage
  /** False while this window cannot be read as a complete total (a declared gap). */
  complete: boolean
  alert: boolean
  /** True when a coverage gap makes the rate/alert undecidable (the counters stay visible). */
  alertInconclusive: boolean
  /** The page-edge half (@chief/hab); null in wire, joined by the 4h report owner. */
  pageEdges: null
  /**
   * #27488 phase 0 - the cost half. null when the ledger predates cost counting
   * (a v1 file), never a silent zero.
   */
  cost: SeatDeliveryCost | null
}

/** One class row of the cost block, heaviest first. */
export type SeatDeliveryClassRow = { class: string } & DeliveryClassStat

export type SeatDeliveryCost = {
  /** Content bytes the pane was handed, as tokens (chars/4). */
  envelopeTokens: number
  /** deliveries x HARNESS_WRAPPER_CHARS_PER_DELIVERY, as tokens. */
  wrapperTokens: number
  /** Content bytes model-requested reads returned, as tokens. */
  readPullTokens: number
  totalTokens: number
  /** When the cost measurement began (== windowStartMs unless a v1 ledger was upgraded mid-window). */
  costStartMs: number
  /** Over the COST span; a younger measurement is never extrapolated to the window. */
  observedMs: number
  tokensPerHour: number
  /** noActionBytes / deliveredBytes; null when nothing was delivered (no invented zero). */
  noActionShare: number | null
  /** Bodies a model read returned twice in one response (#27488 must-hold A). */
  readRepeatBodies: number
  readRepeatBytes: number
  readPulls: number
  byClass: SeatDeliveryClassRow[]
}

/**
 * The cost half of one seat row. A ledger with no cost block (v1) yields null:
 * the report names it unmeasured rather than reading it as zero. Components the
 * adapter cannot see (hook injections, CLI `tribe inbox` reads) are not counted
 * here and the format function says so.
 */
function buildSeatCost(
  counters: DeliveryLedgerState["counters"],
  costStartMs: number,
  observedThroughMs: number,
): SeatDeliveryCost | null {
  const cost = counters.cost
  if (cost === undefined) return null
  const envelopeTokens = cost.deliveredBytes / CHARS_PER_TOKEN
  const wrapperTokens = (counters.deliveries * HARNESS_WRAPPER_CHARS_PER_DELIVERY) / CHARS_PER_TOKEN
  const readPullTokens = cost.readPullBytes / CHARS_PER_TOKEN
  const totalTokens = envelopeTokens + wrapperTokens + readPullTokens
  const byClass = Object.entries(cost.byClass)
    .map(([key, stat]) => ({ class: key, ...stat }))
    .sort((left, right) => right.bytes - left.bytes)
  const noActionBytes = byClass.reduce((sum, row) => sum + row.noActionBytes, 0)
  const span = Math.max(1, observedThroughMs - costStartMs)
  return {
    envelopeTokens,
    wrapperTokens,
    readPullTokens,
    totalTokens,
    costStartMs,
    observedMs: span,
    tokensPerHour: totalTokens / (span / 3_600_000),
    noActionShare: cost.deliveredBytes > 0 ? noActionBytes / cost.deliveredBytes : null,
    readRepeatBodies: cost.readRepeatBodies,
    readRepeatBytes: cost.readRepeatBytes,
    readPulls: cost.readPulls,
    byClass,
  }
}

export type DeliveryReportGap = {
  /** Ledger file name (or path base) that could not be read back. */
  file: string
  /** Best-effort pane key derived from the file name (the pane itself is unreadable). */
  paneKey: string
  gapReason: DeliveryGapReason
}

export type DeliveryLedgerRead = {
  /** False when nothing exists at the resolved path yet - reported, never a silent empty. */
  dirExists: boolean
  states: DeliveryLedgerState[]
  gaps: DeliveryReportGap[]
}

export type FleetDeliveryReport = {
  windowMs: number
  generatedAtMs: number
  source: string | null
  seats: SeatDeliveryReport[]
  gaps: DeliveryReportGap[]
  /** Panes whose duplicateDelivery crossed the alert line (one row each). */
  alerts: string[]
}

/** Build the per-seat row from one persisted ledger. Pure. */
export function buildSeatDeliveryReport(state: DeliveryLedgerState, now: number): SeatDeliveryReport {
  const { counters, coverage } = state
  const duplicateRate = counters.deliveries > 0 ? counters.duplicateDeliveries / counters.deliveries : null
  return {
    pane: state.pane,
    windowStartMs: state.windowStartMs,
    windowEndMs: state.windowStartMs + DELIVERY_LEDGER_WINDOW_MS,
    observedThroughMs: state.updatedAtMs,
    staleMs: Math.max(0, now - state.updatedAtMs),
    deliveries: counters.deliveries,
    newDeliveries: counters.newDeliveries,
    duplicateDeliveries: counters.duplicateDeliveries,
    duplicateBytes: counters.duplicateBytes,
    duplicateRate,
    presentations: counters.presentations,
    duplicatePresentations: counters.duplicatePresentations,
    suppressed: counters.suppressed,
    coverage,
    complete: !coverage.gap,
    alert:
      !coverage.gap &&
      duplicateRate !== null &&
      duplicateRate > DELIVERY_DUPLICATE_ALERT_RATE &&
      counters.deliveries >= DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES,
    alertInconclusive: coverage.gap,
    pageEdges: null,
    cost: buildSeatCost(counters, state.costSinceMs ?? state.windowStartMs, state.updatedAtMs),
  }
}

/**
 * A stat/readdir failure: ENOENT means nothing is there YET (a fresh location,
 * not a gap); any other errno means a location that exists but cannot be read,
 * which must be NAMED as a gap rather than collapsed into "no ledgers".
 */
function locationReadError(path: string, error: unknown): DeliveryLedgerRead {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { dirExists: false, states: [], gaps: [] }
  }
  const file = basename(path)
  return { dirExists: true, states: [], gaps: [{ file, paneKey: file, gapReason: "unreadable" }] }
}

/** Read every `tribe-delivery-*.json` under a directory (or one file). Pure I/O. */
export function readDeliveryLedgers(path: string): DeliveryLedgerRead {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch (error) {
    return locationReadError(path, error)
  }
  const file = basename(path)
  if (stat.isFile()) {
    const loaded = loadDeliveryLedger(path)
    if (loaded.state) return { dirExists: true, states: [loaded.state], gaps: [] }
    return {
      dirExists: true,
      states: [],
      gaps: [{ file, paneKey: file, gapReason: loaded.coverage.gap ? loaded.coverage.gapReason : "unreadable" }],
    }
  }
  if (!stat.isDirectory()) {
    return { dirExists: true, states: [], gaps: [{ file, paneKey: file, gapReason: "unreadable" }] }
  }

  const states: DeliveryLedgerState[] = []
  const gaps: DeliveryReportGap[] = []
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch (error) {
    return locationReadError(path, error)
  }
  for (const name of entries.filter((entry) => LEDGER_FILE.test(entry)).sort()) {
    const loaded = loadDeliveryLedger(join(path, name))
    if (loaded.state) {
      states.push(loaded.state)
      continue
    }
    // A file we just listed but could not parse is a LOST window: name it, never skip it.
    gaps.push({
      file: name,
      paneKey: LEDGER_FILE.exec(name)?.[1] ?? name,
      gapReason: loaded.coverage.gap ? loaded.coverage.gapReason : "unreadable",
    })
  }
  return { dirExists: true, states, gaps }
}

/** Build the fleet report from the read ledgers. Pure. */
export function buildFleetDeliveryReport(input: {
  states: readonly DeliveryLedgerState[]
  gaps?: readonly DeliveryReportGap[]
  now: number
  source?: string | null
}): FleetDeliveryReport {
  const seats = input.states
    .map((state) => buildSeatDeliveryReport(state, input.now))
    .sort((left, right) => left.pane.localeCompare(right.pane))
  return {
    windowMs: DELIVERY_LEDGER_WINDOW_MS,
    generatedAtMs: input.now,
    source: input.source ?? null,
    seats,
    gaps: [...(input.gaps ?? [])],
    alerts: seats.filter((seat) => seat.alert).map((seat) => seat.pane),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function formatPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`
}

function formatSpan(ms: number): string {
  const minutes = ms / 60_000
  if (minutes < 1) return "<1m"
  if (minutes < 120) return `${Math.round(minutes)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

/** #27488 phase 0 - one cost line per seat, or an explicit "unmeasured". */
function formatSeatCost(cost: SeatDeliveryCost | null, windowStartMs: number): string {
  if (cost === null) return "cost: unmeasured (ledger predates cost counting)"
  const classes = cost.byClass
    .slice(0, 4)
    .map((row) => `${row.class} ${row.deliveries}/${formatBytes(row.bytes)}`)
    .join(", ")
  const lateStart = cost.costStartMs > windowStartMs ? ` (cost from ${new Date(cost.costStartMs).toISOString()})` : ""
  return (
    `cost: ~${Math.round(cost.totalTokens)} tokens over ${formatSpan(cost.observedMs)}${lateStart}` +
    ` (envelope ~${Math.round(cost.envelopeTokens)}, wrapper ~${Math.round(cost.wrapperTokens)} est @${HARNESS_WRAPPER_CHARS_PER_DELIVERY} chars/delivery, reads ~${Math.round(cost.readPullTokens)} over ${cost.readPulls} pull(s))` +
    ` - no-action ${formatPercent(cost.noActionShare)} - read repeats ${cost.readRepeatBodies} bodies/${formatBytes(cost.readRepeatBytes)}` +
    ` - classes: ${classes === "" ? "none" : classes}`
  )
}

/** One briefing-ready block. Says WHERE it looked, and never prints a bare zero. */
export function formatFleetDeliveryReport(report: FleetDeliveryReport): string {
  const hours = (report.windowMs / 3_600_000).toFixed(0)
  const source = report.source ?? "(unset)"
  const lines = [
    `Tribe delivery report - ${hours}h per-pane window (each starts at its pane restart/roll), generated ${new Date(report.generatedAtMs).toISOString()}, source ${source}`,
  ]
  if (report.seats.length === 0) {
    lines.push(
      report.gaps.length > 0
        ? `  no readable ledgers at ${source} (${report.gaps.length} unreadable)`
        : `  no ledgers found at ${source}`,
    )
  } else {
    for (const seat of report.seats) {
      const flags = [seat.complete ? "" : `GAP:${seat.coverage.gapReason}`, seat.alert ? "ALERT" : ""].filter(Boolean)
      const rate = `${formatPercent(seat.duplicateRate)}${seat.alertInconclusive ? " (inconclusive)" : ""}`
      const window = `${new Date(seat.windowStartMs).toISOString()}..${new Date(seat.windowEndMs).toISOString()}`
      lines.push(
        `  ${seat.pane}  ${seat.deliveries} delivered (${seat.newDeliveries} new, ${seat.duplicateDeliveries} duplicate, ${rate}) - ${formatBytes(seat.duplicateBytes)} duplicate bytes - ${seat.suppressed} suppressed - restarts ${seat.coverage.restarts} - window ${window}${flags.length > 0 ? `  [${flags.join(" ")}]` : ""}`,
      )
      lines.push(`      ${formatSeatCost(seat.cost, seat.windowStartMs)}`)
    }
    if (report.seats.some((seat) => seat.cost !== null)) {
      lines.push(
        "  cost components measured: envelope + harness wrapper (estimate) + model reads; NOT visible to the adapter: hook injections, CLI reads (name them; never read them as zero).",
      )
    }
  }
  if (report.gaps.length > 0) {
    lines.push(
      `  ${report.gaps.length} unreadable ledger(s): ${report.gaps.map((gap) => `${gap.file} (${gap.gapReason})`).join(", ")}`,
    )
  }
  if (report.alerts.length > 0) {
    lines.push(
      `  ALERT panes (>${(DELIVERY_DUPLICATE_ALERT_RATE * 100).toFixed(0)}% duplicates, >=${DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES} deliveries): ${report.alerts.join(", ")}`,
    )
  }
  return lines.join("\n")
}
