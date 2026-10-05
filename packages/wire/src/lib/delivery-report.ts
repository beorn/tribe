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
 *   - the page-edge half is owned by @chief/hab and is left null here for the
 *     4h report owner to join, per @cto ("not this wire package").
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import {
  DELIVERY_LEDGER_WINDOW_MS,
  loadDeliveryLedger,
  type DeliveryGapReason,
  type DeliveryLedgerCoverage,
  type DeliveryLedgerState,
} from "./delivery-ledger.ts"

/** @cto 9a077460 - strictly above this duplicateDelivery rate, with enough volume. */
export const DELIVERY_DUPLICATE_ALERT_RATE = 0.2
/** @cto 9a077460 - the minimum successful deliveries before the rate is actionable. */
export const DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES = 100

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
  /** The page-edge half (@chief/hab); null in wire, joined by the 4h report owner. */
  pageEdges: null
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
      duplicateRate !== null &&
      duplicateRate > DELIVERY_DUPLICATE_ALERT_RATE &&
      counters.deliveries >= DELIVERY_DUPLICATE_ALERT_MIN_DELIVERIES,
    pageEdges: null,
  }
}

/** Read every `tribe-delivery-*.json` under a directory (or one file). Pure I/O. */
export function readDeliveryLedgers(path: string): DeliveryLedgerRead {
  if (!existsSync(path)) return { dirExists: false, states: [], gaps: [] }
  let isFile = false
  let isDir = false
  try {
    const st = statSync(path)
    isFile = st.isFile()
    isDir = st.isDirectory()
  } catch {
    return { dirExists: false, states: [], gaps: [] }
  }
  if (isFile) {
    const loaded = loadDeliveryLedger(path)
    const file = basename(path)
    if (loaded.state) return { dirExists: true, states: [loaded.state], gaps: [] }
    return {
      dirExists: true,
      states: [],
      gaps: [{ file, paneKey: file, gapReason: loaded.coverage.gap ? loaded.coverage.gapReason : "unreadable" }],
    }
  }
  if (!isDir) return { dirExists: false, states: [], gaps: [] }

  const states: DeliveryLedgerState[] = []
  const gaps: DeliveryReportGap[] = []
  for (const file of readdirSync(path)
    .filter((name) => LEDGER_FILE.test(name))
    .sort()) {
    const loaded = loadDeliveryLedger(join(path, file))
    if (loaded.state) {
      states.push(loaded.state)
      continue
    }
    // A file we just listed but could not parse is a LOST window: name it, never skip it.
    gaps.push({
      file,
      paneKey: LEDGER_FILE.exec(file)?.[1] ?? file,
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

/** One briefing-ready block. Says WHERE it looked, and never prints a bare zero. */
export function formatFleetDeliveryReport(report: FleetDeliveryReport): string {
  const hours = (report.windowMs / 3_600_000).toFixed(0)
  const source = report.source ?? "(unset)"
  const lines = [
    `Tribe delivery report - ${hours}h window, generated ${new Date(report.generatedAtMs).toISOString()}, source ${source}`,
  ]
  if (report.seats.length === 0) {
    lines.push(`  no ledgers found at ${source}`)
  } else {
    for (const seat of report.seats) {
      const flags = [seat.complete ? "" : `GAP:${seat.coverage.gapReason}`, seat.alert ? "ALERT" : ""].filter(Boolean)
      lines.push(
        `  ${seat.pane}  ${seat.deliveries} delivered (${seat.newDeliveries} new, ${seat.duplicateDeliveries} duplicate, ${formatPercent(seat.duplicateRate)}) - ${formatBytes(seat.duplicateBytes)} duplicate bytes - ${seat.suppressed} suppressed - restarts ${seat.coverage.restarts}${flags.length > 0 ? `  [${flags.join(" ")}]` : ""}`,
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
