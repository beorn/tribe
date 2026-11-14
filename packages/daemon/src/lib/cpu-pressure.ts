/**
 * CPU pressure (PSI) for the health monitor (#34311).
 *
 * The daemon pages on CPU load today and reads no pressure at all, so a busy fleet that no process
 * is waiting on looks exactly like a starved one. The ruling (4ce58635) names the quantity: CPU PSI
 * `some` avg60. `full` is not usable here because at the root of a cgroup hierarchy it is zero by
 * definition, which is the mistake that made earlier readings look like "nobody is starved".
 *
 * Three outcomes, never a fabricated zero:
 * - `measured`   — the percentage the kernel reported.
 * - `absent`     — this host has no /proc/pressure/cpu (macOS, standalone-os). A platform limit, not
 *                  an outage: the caller keeps its own rule and says which rule it used.
 * - `unreadable` — the file exists and could not be read or parsed. Loud and typed, in the
 *                  `source-protocol-invalid` shape #30382 established for a malformed source.
 */
import { readFileSync } from "node:fs"

/** Where Linux publishes per-resource pressure stall information. */
export const CPU_PRESSURE_PATH = "/proc/pressure/cpu"

export type CpuPressureReading =
  | { readonly kind: "measured"; readonly someAvg60Percent: number }
  | { readonly kind: "absent"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string }

const SOME_AVG60 = /(?:^|\s)avg60=(\d+(?:\.\d+)?)(?=\s|$)/u

/**
 * Parse one `/proc/pressure/cpu` body. The kernel writes two lines — `some` and `full` — and only
 * `some` answers "is anything waiting on a CPU". A body without it is malformed, not zero.
 */
export function parseCpuPressure(text: string, path: string = CPU_PRESSURE_PATH): CpuPressureReading {
  const lines = text.split("\n")
  const someLine = lines.find((line) => line.startsWith("some "))
  if (someLine === undefined) {
    const first = lines.find((line) => line.trim() !== "")
    return { kind: "unreadable", detail: `${path}: no "some" line in the reading (${first ?? "empty"})` }
  }
  const match = SOME_AVG60.exec(someLine)
  if (match === null) {
    return { kind: "unreadable", detail: `${path}: no avg60 field on the some line (${someLine.trim()})` }
  }
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { kind: "unreadable", detail: `${path}: avg60 ${match[1]} is not a percentage` }
  }
  return { kind: "measured", someAvg60Percent: value }
}

/**
 * Read and parse the host's CPU pressure. `path` is injectable so a test can prove each of the three
 * outcomes without a host that has to be broken on purpose.
 */
export function readCpuPressure(path: string = CPU_PRESSURE_PATH): CpuPressureReading {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { kind: "absent", detail: `${path} does not exist on this host; no pressure reading is available` }
    }
    const reason = code ?? (error instanceof Error ? error.message : String(error))
    return { kind: "unreadable", detail: `${path}: ${reason}` }
  }
  return parseCpuPressure(text, path)
}
