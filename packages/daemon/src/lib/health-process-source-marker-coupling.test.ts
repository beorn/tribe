import { describe, expect, test } from "vitest"
import { sanitizeStandaloneDaemonEnvironment } from "../../../wire/src/daemon-environment.ts"
import { HAB_SESSION_MARKERS } from "./health-process-source.ts"

/**
 * @failure `HAB_SESSION_MARKERS` in this file and
 *          `sanitizeStandaloneDaemonEnvironment` in @tribe/wire are ONE fact
 *          spelled in two packages. The markers list claims to be "exactly the
 *          evidence that hab is present when the management markers are gone";
 *          that claim is only true while the sanitizer keeps stripping the
 *          management markers and keeps leaving these three. Nothing enforced
 *          the agreement, and the two live on opposite sides of a package
 *          boundary, so either could be edited alone.
 *
 *          The damage from a silent divergence is asymmetric and quiet:
 *          - the sanitizer starts stripping one of these three, and the
 *            contradictory-environment branch at `createHealthProcessSource`
 *            becomes UNREACHABLE. Every hab-launched daemon with no
 *            HAB_SESSION_DIR then returns `standalone-os` again, which is the
 *            exact 24233 defect, silently restored.
 *          - the sanitizer stops stripping HAB_SESSION_DIR, and the whole
 *            diagnosis premise dies: the gate's variable is no longer absent,
 *            so the contradiction this file exists to detect cannot arise.
 *          Neither shows up as a failing test anywhere else, because every
 *          other test supplies its own environment.
 *
 * @level   l1 — the real sanitizer, no fixture of the function under test
 * @consumer `createHealthProcessSource`, whose contradictory-environment branch
 *           reads this exact marker list, and through it the disk-blindness alert
 *           that stayed silent while a 61G tmpfs filled on 2026-09-07
 * @bead    @i/4-supervision/24233-tmpfs-has-no-reaper (@cto's carried-forward term)
 */
describe("the markers list and the standalone sanitizer agree on one vocabulary", () => {
  // The population is spelled out rather than derived from either side. Deriving
  // it from HAB_SESSION_MARKERS would ask the sanitizer only about the names the
  // markers list already knows, which is the half of the contract that cannot
  // fail; the interesting half is a name hab sets that this file has not
  // classified. HAB_SESSION_DIR is here because it is the one the gate reads.
  //
  // MEASURED 2026-09-07 against the writer, not the readers: `ag` sets exactly
  // these four HAB_SESSION_* environment variables — supervisor.ts:884 and
  // pty-session.ts:667 (DIR), hab-agent-session-lifecycle.ts:1000 (LAUNCH_ID),
  // and hab-unit-run-contract.ts:41/:53 (HABITAT_ROOT, INSTRUCTION_ANCHOR).
  // Confirmed on two LIVE tribe daemons by reading /proc/<pid>/environ: three
  // HAB_SESSION_* variables each, the three markers, and no HAB_SESSION_DIR.
  //
  // STALENESS TEST, so the next reader can check this rather than trust it:
  //   grep -rhno 'HAB_SESSION_[A-Z_]*' <ag>/packages --include=*.ts | sort -u
  // If that turns up a fifth name that is really an environment variable, add
  // it below and classify it — a new name is exactly what this test cannot
  // discover on its own.
  const EVERY_HAB_SESSION_VARIABLE = [
    "HAB_SESSION_DIR",
    "HAB_SESSION_HABITAT_ROOT",
    "HAB_SESSION_INSTRUCTION_ANCHOR",
    "HAB_SESSION_LAUNCH_ID",
  ] as const

  const habLaunchedEnvironment = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(EVERY_HAB_SESSION_VARIABLE.map((name) => [name, `value-of-${name}`])),
    HAB_SERVICE_KIND: "agent",
    HAB_SERVICE_NAME: "tribe-daemon",
    PATH: "/usr/bin",
  })

  const survivingHabSessionNames = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
      .filter((name) => name.startsWith("HAB_SESSION_"))
      .sort()

  test("what the sanitizer leaves is exactly what this file calls a marker", () => {
    const survivors = survivingHabSessionNames(sanitizeStandaloneDaemonEnvironment(habLaunchedEnvironment()))

    expect(
      survivors,
      "the markers list and the sanitizer have diverged; see this file's @failure note before changing either",
    ).toEqual([...HAB_SESSION_MARKERS].sort())
  })

  test("HAB_SESSION_DIR — the variable the gate reads — is the one that does NOT survive", () => {
    const survivors = survivingHabSessionNames(sanitizeStandaloneDaemonEnvironment(habLaunchedEnvironment()))

    // Stated separately from the equality above on purpose. The equality would
    // still hold if HAB_SESSION_DIR were added to HAB_SESSION_MARKERS and the
    // sanitizer stopped stripping it — both sides moving together, and the
    // contradiction the source detects would quietly become impossible.
    expect(
      survivors,
      "the gate's own variable survived, so a contradictory environment can no longer arise",
    ).not.toContain("HAB_SESSION_DIR")
    expect(HAB_SESSION_MARKERS as readonly string[]).not.toContain("HAB_SESSION_DIR")
  })

  test("every name the sanitizer leaves is classified, and every marker is really left", () => {
    const env = habLaunchedEnvironment()
    const survivors = survivingHabSessionNames(sanitizeStandaloneDaemonEnvironment(env))

    // Both directions, because they fail differently. An unclassified survivor
    // means the source's `present` filter under-reports the evidence and a
    // contradictory environment reads as a clean standalone. A marker that does
    // not survive means the source waits for evidence the sanitizer has already
    // destroyed.
    for (const name of survivors) {
      expect(
        [...HAB_SESSION_MARKERS] as string[],
        `${name} survives sanitizing but is not classified as a marker`,
      ).toContain(name)
    }
    for (const marker of HAB_SESSION_MARKERS) {
      expect(survivors, `${marker} is called a marker but the sanitizer strips it`).toContain(marker)
    }
  })
})
