/**
 * CPU pressure (PSI) for the health monitor (#34311).
 *
 * The daemon pages on CPU load today and reads no pressure at all, so a busy fleet that no process
 * is waiting on looks exactly like a starved one. The ruling (4ce58635) names the quantity: CPU PSI
 * `some` avg60. `full` is not usable here because at the root of a cgroup hierarchy it is zero by
 * definition, which is the mistake that made earlier readings look like "nobody is starved".
 *
 * NO /proc/pressure READER LIVES HERE. The canonical `host:scalars` fact already carries
 * `pressure.cpuSomeAvg60Percent` — read live on 2026-11-14 as 2.55 percent, measured with
 * `hab sysmon snapshot --kind scalars --json` — and longproc-reading is its other consumer (34310).
 * A parser in the daemon would be the second implementation that row forbids, and it would also
 * throw away the producer's typed reasons for having no reading. So this module reads nothing: it
 * interprets the one fact the daemon already asks its canonical source for, beside `runnable`.
 *
 * Three outcomes, never a fabricated zero:
 * - `measured`   — the percentage the host:scalars fact reported.
 * - `absent`     — this host publishes no CPU pressure (Linux without /proc/pressure/cpu, macOS,
 *                  standalone-os, or a producer that omitted the metric). A platform limit, not an
 *                  outage: the caller keeps its own rule and says which rule it used.
 * - `unreadable` — the fact carries the metric and it could not be read or parsed. Loud and typed,
 *                  in the `source-protocol-invalid` shape #30382 established for a malformed source.
 */

export type CpuPressureReading =
  | { readonly kind: "measured"; readonly someAvg60Percent: number }
  | { readonly kind: "absent"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string }

/**
 * The part of the canonical `pressure` scalar this module interprets. The real fact carries the
 * memory averages and their totals beside the CPU one; only the CPU number is consumed here, and a
 * structural subset keeps this module independent of the producer's full shape.
 */
export type CpuPressureFact =
  | { readonly kind: "supported"; readonly value: { readonly cpuSomeAvg60Percent: number } }
  | {
      readonly kind: "unavailable"
      readonly metric: string
      readonly reason: string
      readonly detail?: string
    }
  | undefined

/** Reasons that mean "this host cannot report CPU pressure", as against "the reading failed". */
const ABSENT_REASONS = new Set(["not-reported", "unsupported-on-platform"])

function describe(detail: string | undefined, reason: string): string {
  return detail === undefined || detail === "" ? reason : `${reason}: ${detail}`
}

/**
 * Interpret the canonical pressure scalar. An undefined or unavailable metric is disclosed with the
 * producer's own reason; a number outside 0..100 is a malformed fact, never clamped to a value the
 * kernel did not report.
 */
export function cpuPressureReading(pressure: CpuPressureFact): CpuPressureReading {
  if (pressure === undefined) {
    return {
      kind: "absent",
      detail: "the host:scalars fact carries no pressure metric (a producer that predates the field, or one that declined it)",
    }
  }
  if (pressure.kind === "unavailable") {
    if (ABSENT_REASONS.has(pressure.reason)) {
      return { kind: "absent", detail: describe(pressure.detail, pressure.reason) }
    }
    return { kind: "unreadable", detail: `host:scalars pressure is unavailable (${describe(pressure.detail, pressure.reason)})` }
  }
  const value = pressure.value.cpuSomeAvg60Percent
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return {
      kind: "unreadable",
      detail: `host:scalars pressure.cpuSomeAvg60Percent is not a percentage (${String(value)})`,
    }
  }
  return { kind: "measured", someAvg60Percent: value }
}
